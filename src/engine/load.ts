import { groupSeries } from './dicom/series';
import type { Source } from './io/sources';
import type { SeriesInfo, SliceHeader, Volume } from './types';
import type { SliceRequest } from './workers/slice.worker';

type SliceJob = SliceRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** A small pool of slice workers. Each worker handles one file at a time. */
class SlicePool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ msg: Record<string, unknown>; handlers: Pending }> = [];
  private inFlight = new Map<number, Pending & { worker: Worker }>();
  private nextId = 1;

  constructor() {
    const count = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./workers/slice.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this.finish(w, e.data);
      w.onerror = (e) => this.fail(w, e.message || 'A background worker failed to start.');
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  private fail(w: Worker, message: string) {
    for (const [id, job] of this.inFlight) if (job.worker === w) { this.inFlight.delete(id); job.reject(new Error(message)); }
    this.idle.push(w);
    this.pump();
  }

  private finish(w: Worker, data: { id: number; error?: string }) {
    const job = this.inFlight.get(data.id);
    this.inFlight.delete(data.id);
    this.idle.push(w);
    if (job) {
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
      this.inFlight.set(id, { ...job.handlers, worker: w });
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

export async function scanSeries(sources: Source[], onProgress: (done: number, total: number) => void): Promise<{ series: SeriesInfo[]; dicomFiles: number }> {
  const pool = new SlicePool();
  try {
    let done = 0;
    const replies = await Promise.all(sources.map(async (source, fileIndex) => {
      const reply = await pool.run<{ header: SliceHeader | null }>({ type: 'header', source, fileIndex }).catch(() => ({ header: null }));
      onProgress(++done, sources.length);
      return reply.header;
    }));
    const headers = replies.filter((h): h is SliceHeader => !!h);
    return { series: groupSeries(headers), dicomFiles: headers.length };
  } finally {
    pool.dispose();
  }
}

/** Above this the tab risks running out of memory, so the scan is thinned with a visible notice. */
export const MAX_VOXELS = 420_000_000;

export interface LoadedVolume { volume: Volume; step: number; }

export async function assembleVolume(series: SeriesInfo, sources: Source[], onProgress: (done: number, total: number) => void): Promise<LoadedVolume> {
  const { slices, cols, rows, pixelSpacing, rowDir, colDir } = series;
  const step = cols * rows * slices.length > MAX_VOXELS ? 2 : 1;
  const nx = Math.ceil(cols / step), ny = Math.ceil(rows / step), nz = slices.length;
  let data: Int16Array;
  try {
    data = new Int16Array(nx * ny * nz);
  } catch {
    throw new Error('This scan is too large for the memory available in this browser. Close other tabs and try again.');
  }
  const positions = new Float64Array(nz * 3);
  slices.forEach((h, k) => positions.set(h.position as number[], k * 3));

  const pool = new SlicePool();
  try {
    let done = 0;
    await Promise.all(slices.map(async (header, k) => {
      const { hu } = await pool.run<{ hu: Int16Array }>({ type: 'decode', source: sources[header.fileIndex], header, step });
      data.set(hu, k * nx * ny);
      onProgress(++done, nz);
    }));
  } finally {
    pool.dispose();
  }
  const spacing = pixelSpacing as [number, number];
  return { volume: { nx, ny, nz, data, positions, rowDir, colDir, dx: spacing[1] * step, dy: spacing[0] * step }, step };
}
