/** Sends a case: details to the upload service, then the ZIP to SharePoint in resumable chunks. */

/** Microsoft requires chunk sizes in multiples of 320 KiB. */
export const CHUNK_BYTES = 16 * 320 * 1024;
const MAX_ATTEMPTS = 6;

export interface CaseRecord {
  schema: 1;
  appVersion: string;
  consent: { version: string; text: string; acceptedAt: string };
  patient: { name: string; species: 'Dog' | 'Cat'; breed: string | null; ageYears: number; weightKg: number };
  clinician: string | null;
  study: {
    date: string | null;
    manufacturer: string;
    model: string;
    kernel: string;
    slices: number;
    rows: number;
    cols: number;
    pixelSpacingMm: [number, number] | null;
    sliceSpacingMm: number;
    dicomSpecies: string;
    dicomBreed: string;
  };
  viewer: { thresholdMinHu: number; thresholdMaxHu: number };
  files: number;
  zipBytes: number;
}

export interface UploadConfig {
  serviceUrl: string;
  accessCode?: string;
  getBotToken?: () => Promise<string | undefined>;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class UploadError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

const serviceHeaders = (config: UploadConfig): Record<string, string> => (config.accessCode ? { 'X-Access-Code': config.accessCode } : {});

export async function uploadCase(
  config: UploadConfig,
  record: CaseRecord,
  zip: Blob,
  onProgress: (sent: number, total: number) => void,
): Promise<{ caseId: string }> {
  const fetchFn = config.fetchFn ?? ((...a) => fetch(...a));
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const start = await fetchFn(`${config.serviceUrl}/v1/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders(config) },
    body: JSON.stringify({ case: record, botToken: await config.getBotToken?.() }),
  }).catch(() => { throw new UploadError('Could not reach the storage service.'); });

  if (!start.ok) {
    const detail = await start.json().catch(() => ({})) as { error?: string };
    throw new UploadError(detail.error ?? `The storage service answered ${start.status}.`, start.status >= 500 || start.status === 429);
  }
  const { caseId, uploadUrl } = await start.json() as { caseId: string; uploadUrl: string };

  let relay = false;
  let offset = 0;
  let attempts = 0;
  const total = zip.size;
  onProgress(0, total);

  /** Sends one chunk straight to SharePoint or, if browsers are refused, through the service. */
  const send = (body: Blob, range: string): Promise<Response> => {
    if (relay) {
      return fetchFn(`${config.serviceUrl}/v1/relay`, {
        method: 'PUT',
        headers: { 'X-Upload-Url': uploadUrl, 'X-Content-Range': range, ...serviceHeaders(config) },
        body,
      });
    }
    return fetchFn(uploadUrl, { method: 'PUT', headers: { 'Content-Range': range }, body });
  };

  /** After a failure, asks SharePoint which bytes it already has. */
  const resumePoint = async (): Promise<number | null> => {
    if (relay) return null;
    try {
      const r = await fetchFn(uploadUrl);
      if (!r.ok) return null;
      const { nextExpectedRanges } = await r.json() as { nextExpectedRanges?: string[] };
      const first = nextExpectedRanges?.[0];
      return first ? parseInt(first, 10) : null;
    } catch {
      return null;
    }
  };

  while (offset < total) {
    const end = Math.min(offset + CHUNK_BYTES, total);
    const range = `bytes ${offset}-${end - 1}/${total}`;
    let response: Response | null = null;
    try {
      response = await send(zip.slice(offset, end), range);
    } catch {
      // A network error on the very first direct chunk usually means the browser blocked it.
      if (!relay && offset === 0) { relay = true; continue; }
    }

    if (response && (response.ok || response.status === 202)) {
      offset = end;
      attempts = 0;
      onProgress(offset, total);
      continue;
    }

    if (response && response.status === 404) throw new UploadError('The upload session expired. Please retry.');
    if (response && response.status >= 400 && response.status < 500 && response.status !== 416 && response.status !== 429) {
      throw new UploadError(`SharePoint refused the upload (${response.status}).`, false);
    }

    if (++attempts >= MAX_ATTEMPTS) throw new UploadError('The connection kept failing. Please retry.');
    const wait = Math.min(30_000, 1000 * 2 ** (attempts - 1));
    await sleep(wait);
    const resume = await resumePoint();
    if (resume !== null && resume >= 0 && resume < total) {
      // Chunks must stay on a 320 KiB grid, which a resume point from SharePoint always is.
      offset = resume;
      onProgress(offset, total);
    }
  }
  return { caseId };
}
