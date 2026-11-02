import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import service, { validateCase, isAllowedUploadUrl, type Env } from '../worker/src/index';

const ORIGIN = 'https://vimics.vet';
const env: Env = { TENANT_ID: 't', CLIENT_ID: 'c', CLIENT_SECRET: 'SECRET', DRIVE_ID: 'drive1', ALLOWED_ORIGINS: ORIGIN, MAX_CASES_PER_HOUR: '1000' };

const validCase = () => ({
  schema: 1,
  appVersion: '0.1.0',
  consent: { version: 'v1', text: 'I agree', acceptedAt: '2026-10-31T10:00:00.000Z' },
  patient: { name: 'Max', species: 'Dog', breed: null, ageMonths: 38, weightKg: 12.4 },
  clinician: null,
  study: { date: null, manufacturer: 'A', model: 'B', kernel: 'C', slices: 10, rows: 512, cols: 512, pixelSpacingMm: [0.5, 0.5], sliceSpacingMm: 0.6, dicomSpecies: '', dicomBreed: '' },
  viewer: { thresholdMinHu: 300, thresholdMaxHu: 1900 },
  files: 10,
  zipBytes: 1000,
});

const post = (body: unknown, headers: Record<string, string> = {}) => new Request('https://svc.test/v1/cases', {
  method: 'POST',
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', ...headers },
  body: JSON.stringify(body),
});

/** A simulated Microsoft login and Graph API. */
function fakeMicrosoft() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('login.microsoftonline.com')) return Response.json({ access_token: 'GRAPH_TOKEN', expires_in: 3600 });
    if (url.endsWith(':/content')) return Response.json({ id: '1' }, { status: 201 });
    if (url.endsWith(':/createUploadSession')) return Response.json({ uploadUrl: 'https://vimics.sharepoint.com/up/xyz' });
    if (url.startsWith('https://vimics.sharepoint.com/up/')) return Response.json({ nextExpectedRanges: ['100-'] }, { status: 202 });
    return new Response('unexpected', { status: 500 });
  }));
  return calls;
}

describe('upload service', () => {
  let calls: ReturnType<typeof fakeMicrosoft>;
  beforeEach(() => { calls = fakeMicrosoft(); });
  afterEach(() => vi.unstubAllGlobals());

  it('stores only the expected fields, whatever else is sent', () => {
    const body = { case: { ...validCase(), junk: 'x'.repeat(100), patient: { ...validCase().patient, note: 'extra' }, study: { ...validCase().study, owner: 'extra' } } };
    const stored = JSON.stringify(validateCase(body, 1e9));
    expect(stored).not.toContain('junk');
    expect(stored).not.toContain('extra');
    expect(stored).toContain('"name":"Max"');
    expect(stored).toContain('"thresholdMinHu":300');
  });

  it('rejects a study date or spacing of the wrong shape', () => {
    for (const study of [{ date: 'x'.repeat(21) }, { date: 5 }, { sliceSpacingMm: 'a' }, { pixelSpacingMm: [1] }, { pixelSpacingMm: 'a' }]) {
      expect(() => validateCase({ case: { ...validCase(), study: { ...validCase().study, ...study } } }, 1e9)).toThrow(/Invalid case/);
    }
  });

  it('stores case.json and returns a one-time link, without leaking credentials', async () => {
    const r = await service.fetch(post({ case: validCase() }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const text = await r.text();
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('GRAPH_TOKEN');
    const { caseId, uploadUrl } = JSON.parse(text);
    expect(caseId).toMatch(/^VS-\d{8}-[0-9A-F]{10}$/);
    expect(uploadUrl).toBe('https://vimics.sharepoint.com/up/xyz');

    const stored = calls.find((c) => c.url.endsWith(':/content'))!;
    expect(stored.url).toMatch(new RegExp(`/drives/drive1/root:/V-Seg/\\d{4}/\\d{2}/${caseId}/case.json:/content$`));
    const json = JSON.parse(String(stored.init.body));
    expect(json.caseId).toBe(caseId);
    expect(json.patient.name).toBe('Max');
    expect(json.consent.version).toBe('v1');
    expect(calls.find((c) => c.url.endsWith(':/createUploadSession'))!.url).toContain(`${caseId}/series.zip`);
  });

  it.each([
    ['no patient name', (c: any) => { c.patient.name = '  '; }],
    ['unknown species', (c: any) => { c.patient.species = 'Horse'; }],
    ['no consent', (c: any) => { delete c.consent; }],
    ['bad consent date', (c: any) => { c.consent.acceptedAt = 'soon'; }],
    ['impossible weight', (c: any) => { c.patient.weightKg = -1; }],
    ['wrong schema', (c: any) => { c.schema = 2; }],
    ['oversized text', (c: any) => { c.patient.name = 'x'.repeat(500); }],
  ])('rejects a case with %s and stores nothing', async (_name, change) => {
    const c = validCase();
    change(c);
    const r = await service.fetch(post({ case: c }), env);
    expect(r.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  it('rejects a scan over the size limit', async () => {
    const c = validCase();
    c.zipBytes = 4 * 1024 ** 3;
    expect((await service.fetch(post({ case: c }), env)).status).toBe(413);
  });

  it('refuses other websites', async () => {
    const r = await service.fetch(post({ case: validCase() }, { Origin: 'https://evil.example' }), env);
    expect(r.status).toBe(403);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('requires the access code when one is set', async () => {
    const coded = { ...env, ACCESS_CODE: 'letmein' };
    expect((await service.fetch(post({ case: validCase() }), coded)).status).toBe(403);
    expect((await service.fetch(post({ case: validCase() }, { 'X-Access-Code': 'letmein' }), coded)).status).toBe(200);
  });

  it('limits cases per address', async () => {
    const limited = { ...env, MAX_CASES_PER_HOUR: '2' };
    const ip = { 'CF-Connecting-IP': '9.9.9.9' };
    expect((await service.fetch(post({ case: validCase() }, ip), limited)).status).toBe(200);
    expect((await service.fetch(post({ case: validCase() }, ip), limited)).status).toBe(200);
    expect((await service.fetch(post({ case: validCase() }, ip), limited)).status).toBe(429);
  });

  it('answers the browser\'s preflight check', async () => {
    const ok = await service.fetch(new Request('https://svc.test/v1/cases', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
    expect(ok.status).toBe(204);
    const no = await service.fetch(new Request('https://svc.test/v1/cases', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
    expect(no.status).toBe(403);
  });

  it('relays a chunk to SharePoint and nowhere else', async () => {
    const relay = (url: string) => new Request('https://svc.test/v1/relay', {
      method: 'PUT',
      headers: { Origin: ORIGIN, 'X-Upload-Url': url, 'X-Content-Range': 'bytes 0-3/8' },
      body: new Uint8Array(4),
    });
    expect((await service.fetch(relay('https://vimics.sharepoint.com/up/xyz'), env)).status).toBe(202);
    expect((await service.fetch(relay('https://evil.example/steal'), env)).status).toBe(400);
    expect(calls.filter((c) => c.url.includes('evil')).length).toBe(0);
  });

  it('accepts only Microsoft upload hosts', () => {
    expect(isAllowedUploadUrl('https://x.sharepoint.com/a')).toBe(true);
    for (const bad of ['http://x.sharepoint.com/a', 'https://sharepoint.com.evil.example/a', 'https://evil.example/x.sharepoint.com', 'nonsense', null]) {
      expect(isAllowedUploadUrl(bad)).toBe(false);
    }
  });
});
