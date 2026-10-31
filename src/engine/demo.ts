import type { Volume } from './types';

/**
 * A demo case holds voxels and slice geometry and nothing else: no DICOM tags, names, dates or file names.
 * Layout, gzipped: 4-byte header length, JSON header, padding to an even offset, then little-endian Int16 voxels.
 */
export interface DemoHeader {
  species: 'Cat' | 'Dog';
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  dy: number;
  positions: number[];
  rowDir: Volume['rowDir'];
  colDir: Volume['colDir'];
  /** Distance between slices, in mm, for the summary line */
  spacingMm: number;
  /** Columns and rows of the original scan, before cropping and any reduction */
  sourceMatrix: [number, number];
  filter: 'bone' | 'soft' | 'lung' | 'unknown';
}

export function packDemo(header: DemoHeader, data: Int16Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataAt = (4 + json.length + 1) & ~1;
  const out = new Uint8Array(dataAt + data.byteLength);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), dataAt);
  return out;
}

export function unpackDemo(bytes: Uint8Array): { header: DemoHeader; volume: Volume } {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as DemoHeader;
  const dataAt = (4 + length + 1) & ~1;
  const { nx, ny, nz, dx, dy, rowDir, colDir } = header;
  const data = new Int16Array(nx * ny * nz);
  new Uint8Array(data.buffer).set(bytes.subarray(dataAt, dataAt + data.byteLength));
  return { header, volume: { nx, ny, nz, data, dx, dy, rowDir, colDir, positions: Float64Array.from(header.positions) } };
}

/** Downloads and unpacks a demo case in the browser, reporting progress as a share of the download. */
export async function fetchDemo(url: string, onProgress: (share: number) => void): Promise<{ header: DemoHeader; volume: Volume }> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error('This demo case could not be downloaded.');
  const total = Number(response.headers.get('content-length')) || 0;
  let seen = 0;
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length;
      if (total) onProgress(Math.min(1, seen / total));
      controller.enqueue(chunk);
    },
  }));
  const plain = counted.pipeThrough(new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
  return unpackDemo(new Uint8Array(await new Response(plain).arrayBuffer()));
}
