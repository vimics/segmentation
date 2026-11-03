import type { HuRange } from '../hu';
import { SurfaceEngine } from '../surface/pipeline';
import type { SurfaceResult, Volume } from '../types';

export type MeshRequest =
  | { type: 'load'; volume: Volume }
  | { type: 'extract'; seq: number; range: HuRange; keepShells: boolean; quality: 'preview' | 'full' };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let engine: SurfaceEngine | null = null;
/** Only the newest request matters while the slider is moving. */
let pending: Extract<MeshRequest, { type: 'extract' }> | null = null;
let scheduled = false;

function pump() {
  scheduled = false;
  const job = pending;
  pending = null;
  if (!job || !engine) return;
  try {
    const started = performance.now();
    const result = job.quality === 'preview' ? engine.preview(job.range, job.keepShells) : engine.full(job.range, job.keepShells);
    postResult(job.seq, result, performance.now() - started);
  } catch (err) {
    scope.postMessage({ type: 'error', seq: job.seq, message: err instanceof Error ? err.message : String(err) });
  }
}

function postResult(seq: number, result: SurfaceResult, ms: number) {
  const transfer: ArrayBuffer[] = [];
  for (const s of result.structures) {
    transfer.push(s.positions.buffer as ArrayBuffer, s.normals.buffer as ArrayBuffer, s.colors.buffer as ArrayBuffer, s.indices.buffer as ArrayBuffer);
  }
  scope.postMessage({ type: 'surface', seq, result, ms }, transfer);
}

scope.onmessage = (e: MessageEvent<MeshRequest>) => {
  const msg = e.data;
  if (msg.type === 'extract') {
    pending = msg;
    if (!scheduled) { scheduled = true; setTimeout(pump, 0); }
    return;
  }
  try {
    engine = new SurfaceEngine(msg.volume);
    scope.postMessage({ type: 'loaded' });
  } catch (err) {
    scope.postMessage({ type: 'error', seq: -1, message: err instanceof Error ? err.message : String(err) });
  }
};
