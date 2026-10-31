import { decodeHounsfield } from '../dicom/decode';
import { parseDataset, readHeader } from '../dicom/header';
import { readSource, type Source } from '../io/sources';
import type { SliceHeader } from '../types';

export type SliceRequest =
  | { type: 'header'; id: number; source: Source; fileIndex: number }
  | { type: 'decode'; id: number; source: Source; header: SliceHeader; step: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<SliceRequest>) => {
  const msg = e.data;
  try {
    const bytes = await readSource(msg.source);
    if (msg.type === 'header') {
      const ds = parseDataset(bytes, { headerOnly: true });
      scope.postMessage({ id: msg.id, header: ds ? readHeader(ds, msg.fileIndex) : null });
      return;
    }
    const ds = parseDataset(bytes);
    if (!ds) throw new Error('File could not be read as DICOM');
    const hu = await decodeHounsfield(ds, msg.header, msg.step);
    scope.postMessage({ id: msg.id, hu }, [hu.buffer]);
  } catch (err) {
    scope.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
