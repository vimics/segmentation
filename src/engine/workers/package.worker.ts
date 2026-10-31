import { Zip, ZipDeflate } from 'fflate';
import { deidentify } from '../dicom/deidentify';
import { parseDataset } from '../dicom/header';
import { readSource, type Source } from '../io/sources';

export interface PackageRequest { sources: Source[]; salt: string; }
export type PackageReply =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; zip: Blob; files: number }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: PackageReply) => scope.postMessage(m);

/** Moving finished chunks into a Blob lets the browser keep them on disk, not in memory. */
const SPILL_BYTES = 32 * 1024 * 1024;

scope.onmessage = async (e: MessageEvent<PackageRequest>) => {
  const { sources, salt } = e.data;
  try {
    const blobs: Blob[] = [];
    let chunks: BlobPart[] = [], held = 0;
    const spill = () => { if (chunks.length) { blobs.push(new Blob(chunks)); chunks = []; held = 0; } };

    let finished = false;
    let failure: unknown = null;
    const zip = new Zip((err, data, final) => {
      if (err) { failure = err; return; }
      chunks.push(data.slice() as Uint8Array<ArrayBuffer>);
      held += data.length;
      if (held >= SPILL_BYTES) spill();
      if (final) finished = true;
    });

    let written = 0;
    for (let i = 0; i < sources.length; i++) {
      const ds = parseDataset(await readSource(sources[i]));
      if (!ds) continue;
      const clean = await deidentify(ds, salt);
      const entry = new ZipDeflate(`slice-${String(i + 1).padStart(5, '0')}.dcm`, { level: 6 });
      zip.add(entry);
      entry.push(clean, true);
      written++;
      if (failure) throw failure;
      post({ type: 'progress', done: i + 1, total: sources.length });
    }
    zip.end();
    if (failure) throw failure;
    if (!finished) throw new Error('The archive did not finish');
    spill();
    post({ type: 'done', zip: new Blob(blobs, { type: 'application/zip' }), files: written });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
