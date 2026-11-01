import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, uploadCase, UploadError, type CaseRecord } from '../src/app/upload';

const record = { schema: 1 } as unknown as CaseRecord;
const SERVICE = 'https://service.test', SHAREPOINT = 'https://vimics.sharepoint.com/upload/abc';

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function harness(handler: Handler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${SERVICE}/v1/cases`) return json({ caseId: 'VS-1', uploadUrl: SHAREPOINT });
    return handler(url, init);
  }) as typeof fetch;
  return { calls, config: { serviceUrl: SERVICE, fetchFn, sleep: async () => {} } };
}

const puts = (calls: Array<{ url: string; init?: RequestInit }>) => calls.filter((c) => c.init?.method === 'PUT');
const zipOf = (size: number) => new Blob([new Uint8Array(size)]);

describe('uploading a case', () => {
  it('sends in-order chunks on the 320 KiB grid and reports progress', async () => {
    const { calls, config } = harness(() => json({ nextExpectedRanges: [] }, 202));
    const size = CHUNK_BYTES * 2 + 1000;
    const progress: number[] = [];
    const { caseId } = await uploadCase(config, record, zipOf(size), (sent) => progress.push(sent));
    expect(caseId).toBe('VS-1');
    expect(CHUNK_BYTES % (320 * 1024)).toBe(0);
    const ranges = puts(calls).map((c) => (c.init?.headers as Record<string, string>)['Content-Range']);
    expect(ranges).toEqual([
      `bytes 0-${CHUNK_BYTES - 1}/${size}`,
      `bytes ${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}/${size}`,
      `bytes ${CHUNK_BYTES * 2}-${size - 1}/${size}`,
    ]);
    expect(progress.at(-1)).toBe(size);
  });

  it('never sends an Authorization header to SharePoint', async () => {
    const { calls, config } = harness(() => json({}, 202));
    await uploadCase(config, record, zipOf(1000), () => {});
    for (const c of puts(calls)) expect(c.init?.headers).not.toHaveProperty('Authorization');
  });

  it('resumes from what SharePoint already has after a server error', async () => {
    let failed = false;
    const { calls, config } = harness((url, init) => {
      if (!init?.method) return json({ nextExpectedRanges: [`${CHUNK_BYTES}-`] });
      const range = (init.headers as Record<string, string>)['Content-Range'];
      if (!failed && range.startsWith(`bytes ${CHUNK_BYTES}-`)) { failed = true; return new Response('', { status: 503 }); }
      return json({}, 202);
    });
    const size = CHUNK_BYTES * 3;
    await uploadCase(config, record, zipOf(size), () => {});
    const ranges = puts(calls).map((c) => (c.init?.headers as Record<string, string>)['Content-Range'].split(/[ -]/)[1]);
    expect(ranges).toEqual(['0', String(CHUNK_BYTES), String(CHUNK_BYTES), String(CHUNK_BYTES * 2)]);
  });

  it('falls back to the relay when the browser blocks direct upload', async () => {
    const { calls, config } = harness((url) => {
      if (url === SHAREPOINT) throw new TypeError('Failed to fetch');
      return json({}, 202);
    });
    await uploadCase(config, record, zipOf(CHUNK_BYTES + 5), () => {});
    const relayed = puts(calls).filter((c) => c.url === `${SERVICE}/v1/relay`);
    expect(relayed.length).toBe(2);
    expect((relayed[0].init?.headers as Record<string, string>)['X-Upload-Url']).toBe(SHAREPOINT);
    expect((relayed[1].init?.headers as Record<string, string>)['X-Content-Range']).toMatch(/^bytes /);
  });

  it('gives up after repeated failures with a retryable error', async () => {
    const { config } = harness(() => new Response('', { status: 500 }));
    await expect(uploadCase(config, record, zipOf(1000), () => {})).rejects.toMatchObject({ retryable: true });
  });

  it('does not retry a refusal', async () => {
    const { calls, config } = harness(() => new Response('', { status: 403 }));
    const err = await uploadCase(config, record, zipOf(1000), () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.retryable).toBe(false);
    expect(puts(calls).length).toBe(1);
  });

  it('surfaces the service\'s reason when it refuses a case', async () => {
    const fetchFn = (async () => json({ error: 'Too many uploads.' }, 429)) as unknown as typeof fetch;
    await expect(uploadCase({ serviceUrl: SERVICE, fetchFn }, record, zipOf(10), () => {})).rejects.toThrow('Too many uploads.');
  });
});
