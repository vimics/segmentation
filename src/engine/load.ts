import { groupSeries } from './dicom/series';
import type { FileKind } from './io/sniff';
import type { Source } from './io/sources';
import type { SeriesInfo, SliceHeader, Volume } from './types';
import type { SliceRequest } from './workers/slice.worker';

type SliceJob = SliceRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** A worker silent for this long has most likely run out of memory on one file, and browsers don't report that. */
const JOB_TIMEOUT_MS = 120_000;

/** A small pool of slice workers. Each worker handles one file at a time. */
class SlicePool {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private queue: Array<{ msg: Record<string, unknown>; handlers: Pending }> = [];
  private inFlight = new Map<number, Pending & { worker: Worker; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;

  constructor() {
    const count = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) this.idle.push(this.startWorker());
  }

  private startWorker(): Worker {
    const w = new Worker(new URL('./workers/slice.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => this.finish(w, e.data);
    w.onerror = (e) => this.fail(w, e.message || 'A background worker failed to start.');
    this.workers.add(w);
    return w;
  }

  private fail(w: Worker, message: string) {
    for (const [id, job] of this.inFlight) if (job.worker === w) { clearTimeout(job.timer); this.inFlight.delete(id); job.reject(new Error(message)); }
    this.idle.push(w);
    this.pump();
  }

  private timedOut(id: number) {
    const job = this.inFlight.get(id);
    if (!job) return;
    this.inFlight.delete(id);
    job.worker.terminate();
    this.workers.delete(job.worker);
    this.idle.push(this.startWorker());
    job.reject(new Error('A file took too long to read.'));
    this.pump();
  }

  private finish(w: Worker, data: { id: number; error?: string }) {
    const job = this.inFlight.get(data.id);
    this.inFlight.delete(data.id);
    this.idle.push(w);
    if (job) {
      clearTimeout(job.timer);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data);
    }
    this.pump();
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const job = this.queue.shift();
      const w = this.idle.pop();
      if (!job || !w) return;
      const id = this.nextId++;
      this.inFlight.set(id, { ...job.handlers, worker: w, timer: setTimeout(() => this.timedOut(id), JOB_TIMEOUT_MS) });
      w.postMessage({ ...job.msg, id });
    }
  }

  run<T>(msg: SliceJob): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ msg: msg as Record<string, unknown>, handlers: { resolve: resolve as (v: unknown) => void, reject } });
      this.pump();
    });
  }

  dispose() { for (const w of this.workers) w.terminate(); }
}

export interface ScanResult {
  series: SeriesInfo[];
  dicomFiles: number;
  /** How many of the chosen files are of each kind, whatever they are named */
  kinds: Partial<Record<FileKind, number>>;
}

export async function scanSeries(sources: Source[], onProgress: (done: number, total: number) => void): Promise<ScanResult> {
  const pool = new SlicePool();
  try {
    let done = 0;
    const kinds: ScanResult['kinds'] = {};
    const replies = await Promise.all(sources.map(async (source, fileIndex) => {
      const reply = await pool.run<{ header: SliceHeader | null; kind?: FileKind }>({ type: 'header', source, fileIndex }).catch(() => ({ header: null, kind: 'other' as FileKind }));
      const kind = reply.kind ?? 'other';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      onProgress(++done, sources.length);
      return reply.header;
    }));
    const headers = replies.filter((h): h is SliceHeader => !!h);
    return { series: groupSeries(headers), dicomFiles: headers.length, kinds };
  } finally {
    pool.dispose();
  }
}

/** Above this the tab risks running out of memory, so the scan is thinned with a visible notice. */
export const MAX_VOXELS = 420_000_000;

export interface LoadedVolume {
  volume: Volume;
  step: number;
  failedSlices: number;
  /** The slices that could be read, which are also the ones worth storing */
  readable: SliceHeader[];
}

/** A few unreadable slices become a warning. Beyond this share the model would mislead, so loading stops. */
const MAX_FAILED_SHARE = 0.05;

export async function assembleVolume(series: SeriesInfo, sources: Source[], onProgress: (done: number, total: number) => void): Promise<LoadedVolume> {
  const { slices, cols, rows, pixelSpacing, rowDir, colDir } = series;
  const step = cols * rows * slices.length > MAX_VOXELS ? 2 : 1;
  const nx = Math.ceil(cols / step), ny = Math.ceil(rows / step), total = slices.length;
  let data: Int16Array;
  try {
    data = new Int16Array(nx * ny * total);
  } catch {
    throw new Error('This scan is too large for the memory available in this browser. Close other tabs and try again.');
  }
  const failed = new Set<number>();

  const pool = new SlicePool();
  try {
    let done = 0;
    await Promise.all(slices.map(async (header, k) => {
      try {
        const { hu } = await pool.run<{ hu: Int16Array }>({ type: 'decode', source: sources[header.fileIndex], header, step });
        data.set(hu, k * nx * ny);
      } catch {
        failed.add(k);
      }
      onProgress(++done, total);
    }));
  } finally {
    pool.dispose();
  }
  if (failed.size > total * MAX_FAILED_SHARE) {
    throw new Error(`${failed.size} of ${total} slices could not be read, so the files may be damaged. Export the series again and retry.`);
  }

  // Slices place by their recorded positions, so closing up after a bad one leaves the rest where they belong.
  const kept = slices.filter((_, k) => !failed.has(k));
  if (kept.length < 3) throw new Error('Too few slices in this series could be read to build a 3D model.');
  if (failed.size) {
    let to = 0;
    for (let k = 0; k < total; k++) {
      if (failed.has(k)) continue;
      if (to !== k) data.copyWithin(to * nx * ny, k * nx * ny, (k + 1) * nx * ny);
      to++;
    }
    data = data.slice(0, kept.length * nx * ny);
  }
  const positions = new Float64Array(kept.length * 3);
  kept.forEach((h, k) => positions.set(h.position as number[], k * 3));

  const spacing = pixelSpacing as [number, number];
  return { volume: { nx, ny, nz: kept.length, data, positions, rowDir, colDir, dx: spacing[1] * step, dy: spacing[0] * step }, step, failedSlices: failed.size, readable: kept };
}
