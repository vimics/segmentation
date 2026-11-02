/**
 * Upload service. Holds the SharePoint credentials so the public page never sees them.
 * It validates a case, stores case.json, and hands the browser a one-time upload link.
 */

export interface Env {
  TENANT_ID: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  DRIVE_ID: string;
  ALLOWED_ORIGINS: string;
  ROOT_FOLDER?: string;
  MAX_ZIP_BYTES?: string;
  MAX_CASES_PER_HOUR?: string;
  ACCESS_CODE?: string;
  TURNSTILE_SECRET?: string;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DEFAULT_MAX_ZIP = 3 * 1024 ** 3;
const LIMITS = { name: 80, breed: 80, clinician: 120, text: 200, record: 16 * 1024 };

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

let cachedToken: { value: string; expires: number } | null = null;

async function graphToken(env: Env): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.value;
  const r = await fetch(`https://login.microsoftonline.com/${env.TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!r.ok) throw new HttpError(502, 'Storage sign-in failed.');
  const data = await r.json() as { access_token: string; expires_in: number };
  cachedToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

/** Best effort per-instance limit. Add a Cloudflare rate limiting rule for a hard limit. */
const recent = new Map<string, number[]>();
function allowRate(ip: string, perHour: number): boolean {
  const now = Date.now(), hourAgo = now - 3_600_000;
  const list = (recent.get(ip) ?? []).filter((t) => t > hourAgo);
  if (list.length >= perHour) { recent.set(ip, list); return false; }
  list.push(now);
  recent.set(ip, list);
  if (recent.size > 5000) recent.clear();
  return true;
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isOptionalText = (v: unknown, max: number) => v === null || isText(v, max);
const isNumber = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Checks the expected shape and rebuilds the record from those fields alone, so nothing else can be stored. */
export function validateCase(body: unknown, maxZip: number): Record<string, unknown> {
  const c = (body as { case?: Record<string, never> } | null)?.case as Record<string, Record<string, unknown> & unknown> | undefined;
  const bad = (what: string) => new HttpError(400, `Invalid case: ${what}.`);
  if (!c || typeof c !== 'object') throw bad('missing case');
  if (c.schema as unknown !== 1) throw bad('schema');
  const consent = c.consent, patient = c.patient, study = c.study, viewer = c.viewer;
  if (!consent || !isText(consent.version, LIMITS.text) || !isText(consent.text, 2000) || !isText(consent.acceptedAt, 40)) throw bad('consent');
  if (Number.isNaN(Date.parse(consent.acceptedAt as string))) throw bad('consent date');
  if (!patient || !isText(patient.name, LIMITS.name) || !(patient.name as string).trim()) throw bad('patient name');
  if (patient.species !== 'Dog' && patient.species !== 'Cat') throw bad('species');
  if (!isOptionalText(patient.breed, LIMITS.breed)) throw bad('breed');
  if (!isNumber(patient.ageYears, 0.01, 40)) throw bad('age');
  if (!isNumber(patient.weightKg, 0.05, 200)) throw bad('weight');
  if (!isOptionalText(c.clinician, LIMITS.clinician)) throw bad('clinician');
  if (!study || typeof study !== 'object') throw bad('study');
  if (!isNumber(study.slices, 1, 100_000) || !isNumber(study.rows, 1, 16_384) || !isNumber(study.cols, 1, 16_384)) throw bad('study size');
  for (const key of ['manufacturer', 'model', 'kernel', 'dicomSpecies', 'dicomBreed']) if (!isText(study[key], LIMITS.text)) throw bad(key);
  if (!isOptionalText(study.date, 20)) throw bad('study date');
  if (!isNumber(study.sliceSpacingMm, 0, 1000)) throw bad('slice spacing');
  const spacing = study.pixelSpacingMm as unknown;
  if (spacing !== null && !(Array.isArray(spacing) && spacing.length === 2 && spacing.every((v) => isNumber(v, 0, 100)))) throw bad('pixel spacing');
  if (!isText(c.appVersion as unknown, 40)) throw bad('app version');
  if (!viewer || !isNumber(viewer.thresholdMinHu, -1024, 4000) || !isNumber(viewer.thresholdMaxHu, -1024, 4000)) throw bad('viewer');
  if (!isNumber(c.files as unknown, 1, 100_000)) throw bad('files');
  if (!isNumber(c.zipBytes as unknown, 1, maxZip)) throw new HttpError(413, 'This scan is larger than the storage limit.');
  return {
    schema: 1,
    appVersion: c.appVersion,
    consent: { version: consent.version, text: consent.text, acceptedAt: consent.acceptedAt },
    patient: { name: patient.name, species: patient.species, breed: patient.breed, ageYears: patient.ageYears, weightKg: patient.weightKg },
    clinician: c.clinician,
    study: {
      date: study.date,
      manufacturer: study.manufacturer,
      model: study.model,
      kernel: study.kernel,
      slices: study.slices,
      rows: study.rows,
      cols: study.cols,
      pixelSpacingMm: spacing,
      sliceSpacingMm: study.sliceSpacingMm,
      dicomSpecies: study.dicomSpecies,
      dicomBreed: study.dicomBreed,
    },
    viewer: { thresholdMinHu: viewer.thresholdMinHu, thresholdMaxHu: viewer.thresholdMaxHu },
    files: c.files,
    zipBytes: c.zipBytes,
  };
}

function newCaseId(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
  const random = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `VS-${stamp}-${random}`;
}

async function verifyBot(env: Env, token: unknown, ip: string) {
  if (!env.TURNSTILE_SECRET) return;
  if (typeof token !== 'string') throw new HttpError(403, 'Bot check missing.');
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const data = await r.json() as { success?: boolean };
  if (!data.success) throw new HttpError(403, 'Bot check failed.');
}

async function createCase(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!allowRate(ip, Number(env.MAX_CASES_PER_HOUR ?? 30))) throw new HttpError(429, 'Too many uploads from this address. Please try again later.');

  const raw = await request.text();
  if (raw.length > LIMITS.record) throw new HttpError(413, 'Case details are too large.');
  let body: { botToken?: unknown };
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid case: not JSON.'); }

  const record = validateCase(body, Number(env.MAX_ZIP_BYTES ?? DEFAULT_MAX_ZIP));
  await verifyBot(env, body.botToken, ip);

  const now = new Date();
  const caseId = newCaseId(now);
  const root = env.ROOT_FOLDER ?? 'V-Seg';
  const folder = `${root}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${caseId}`;
  const token = await graphToken(env);
  const auth = { Authorization: `Bearer ${token}` };

  const stored = await fetch(`${GRAPH}/drives/${env.DRIVE_ID}/root:/${folder}/case.json:/content`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ caseId, receivedAt: now.toISOString(), ...record }, null, 2),
  });
  if (!stored.ok) throw new HttpError(502, 'Could not store the case details.');

  const session = await fetch(`${GRAPH}/drives/${env.DRIVE_ID}/root:/${folder}/series.zip:/createUploadSession`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'fail' } }),
  });
  if (!session.ok) throw new HttpError(502, 'Could not open the upload.');
  const { uploadUrl } = await session.json() as { uploadUrl: string };
  return Response.json({ caseId, uploadUrl });
}

/** Only ever forwards to Microsoft upload hosts, so this can't be used as an open proxy. */
export function isAllowedUploadUrl(raw: string | null): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname.endsWith('.sharepoint.com') || u.hostname.endsWith('.1drv.com'));
  } catch {
    return false;
  }
}

async function relay(request: Request): Promise<Response> {
  const url = request.headers.get('X-Upload-Url');
  const range = request.headers.get('X-Content-Range');
  if (!isAllowedUploadUrl(url)) throw new HttpError(400, 'Invalid upload link.');
  if (!range || !/^bytes \d+-\d+\/\d+$/.test(range)) throw new HttpError(400, 'Invalid range.');
  const upstream = await fetch(url, { method: 'PUT', headers: { 'Content-Range': range }, body: request.body });
  return new Response(upstream.body, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code, X-Upload-Url, X-Content-Range',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    const withCors = (r: Response) => {
      const out = new Response(r.body, r);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      return out;
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });

    try {
      if (!cors['Access-Control-Allow-Origin']) throw new HttpError(403, 'This site may not store cases.');
      if (env.ACCESS_CODE && request.headers.get('X-Access-Code') !== env.ACCESS_CODE) throw new HttpError(403, 'Uploads are limited during testing.');
      const { pathname } = new URL(request.url);
      if (request.method === 'POST' && pathname === '/v1/cases') return withCors(await createCase(request, env));
      if (request.method === 'PUT' && pathname === '/v1/relay') return withCors(await relay(request));
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Storage service error.';
      return withCors(Response.json({ error: message }, { status }));
    }
  },
};
