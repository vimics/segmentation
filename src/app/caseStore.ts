import type { HuRange } from '../engine/hu';
import type { Source } from '../engine/io/sources';
import type { SeriesInfo } from '../engine/types';
import type { PackageReply } from '../engine/workers/package.worker';
import type { CaseDetails } from './details';
import { uploadCase, UploadError, type CaseRecord, type UploadConfig } from './upload';

export const CONSENT_VERSION = 'v1-2026-10';

export type StoreState =
  | { kind: 'off'; message: string }
  | { kind: 'preparing'; done: number; total: number }
  | { kind: 'uploading'; sent: number; total: number }
  | { kind: 'stored'; caseId: string }
  | { kind: 'failed'; message: string; canRetry: boolean };

const serviceUrl = (import.meta.env.VITE_UPLOAD_URL ?? '').replace(/\/$/, '');
const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '';

/** A link like ?code=abc grants upload access during testing, and is kept for this tab. */
function accessCode(): string | undefined {
  const fromUrl = new URLSearchParams(location.search).get('code');
  if (fromUrl) sessionStorage.setItem('bv-code', fromUrl);
  return sessionStorage.getItem('bv-code') ?? undefined;
}

let turnstile: Promise<{ render: (el: HTMLElement, o: Record<string, unknown>) => void }> | null = null;
function botToken(): Promise<string | undefined> {
  if (!siteKey) return Promise.resolve(undefined);
  turnstile ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = () => resolve((window as unknown as { turnstile: never }).turnstile);
    s.onerror = () => reject(new Error('The bot check could not load.'));
    document.head.append(s);
  });
  return turnstile.then((api) => new Promise((resolve, reject) => {
    const box = document.createElement('div');
    box.style.cssText = 'position: fixed; right: 16px; bottom: 44px; z-index: 20;';
    document.body.append(box);
    api.render(box, {
      sitekey: siteKey,
      size: 'flexible',
      appearance: 'interaction-only',
      callback: (token: string) => { box.remove(); resolve(token); },
      'error-callback': () => { box.remove(); reject(new Error('The bot check failed.')); },
    });
  }));
}

function packageSeries(sources: Source[], salt: string, onProgress: (done: number, total: number) => void): Promise<{ zip: Blob; files: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../engine/workers/package.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PackageReply>) => {
      const m = e.data;
      if (m.type === 'progress') { onProgress(m.done, m.total); return; }
      worker.terminate();
      if (m.type === 'done') resolve({ zip: m.zip, files: m.files });
      else reject(new Error(m.message));
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Preparing the scan failed.')); };
    worker.postMessage({ sources, salt });
  });
}

export interface StoreRequest {
  details: CaseDetails;
  acceptedAt: string;
  consentText: string;
  series: SeriesInfo;
  sources: Source[];
  threshold: HuRange;
}

/** Stores one series at a time, in the background, reporting plain status to the sidebar. */
export class CaseStore {
  private active = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private done = new Set<string>();

  constructor(private onChange: (s: StoreState) => void) {}

  get busy() { return this.active > 0; }

  store(req: StoreRequest) {
    if (!serviceUrl) { this.onChange({ kind: 'off', message: 'Storage is not connected in this test build, so nothing is being sent.' }); return; }
    if (req.series.burnedIn) { this.onChange({ kind: 'off', message: 'Not stored: this series is marked as having text burned into the images.' }); return; }
    if (this.done.has(req.series.id)) return;
    this.done.add(req.series.id);
    this.active++;
    this.queue = this.queue.then(() => this.run(req)).finally(() => { this.active--; });
  }

  retry(req: StoreRequest) {
    this.done.delete(req.series.id);
    this.store(req);
  }

  private async run(req: StoreRequest) {
    const { series, details } = req;
    try {
      this.onChange({ kind: 'preparing', done: 0, total: series.slices.length });
      const salt = crypto.randomUUID();
      const sources = series.slices.map((h) => req.sources[h.fileIndex]);
      const { zip, files } = await packageSeries(sources, salt, (done, total) => this.onChange({ kind: 'preparing', done, total }));

      const first = series.slices[0];
      const record: CaseRecord = {
        schema: 1,
        appVersion: __APP_VERSION__,
        consent: { version: CONSENT_VERSION, text: req.consentText, acceptedAt: req.acceptedAt },
        patient: { name: details.name, species: details.species, breed: details.breed, ageMonths: details.ageMonths, weightKg: details.weightKg },
        clinician: details.clinician,
        study: {
          date: first.studyDate || null,
          manufacturer: first.manufacturer.slice(0, 200),
          model: first.model.slice(0, 200),
          kernel: series.kernel.slice(0, 200),
          slices: series.slices.length,
          rows: series.rows,
          cols: series.cols,
          pixelSpacingMm: series.pixelSpacing,
          sliceSpacingMm: series.sliceSpacing,
          dicomSpecies: first.species.slice(0, 200),
          dicomBreed: first.breed.slice(0, 200),
        },
        viewer: { thresholdMinHu: req.threshold.min, thresholdMaxHu: req.threshold.max },
        files,
        zipBytes: zip.size,
      };

      const config: UploadConfig = { serviceUrl, accessCode: accessCode(), getBotToken: botToken };
      const { caseId } = await uploadCase(config, record, zip, (sent, total) => this.onChange({ kind: 'uploading', sent, total }));
      this.onChange({ kind: 'stored', caseId });
    } catch (err) {
      this.done.delete(series.id);
      const canRetry = !(err instanceof UploadError) || err.retryable;
      this.onChange({ kind: 'failed', message: err instanceof Error ? err.message : 'Storing this case failed.', canRetry });
    }
  }
}
