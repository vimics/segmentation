import { Decoder as LosslessDecoder } from 'jpeg-lossless-decoder-js';

/** WASM decoders load only when a file needs them, so uncompressed scans stay fast. */
type WasmDecoder = {
  getEncodedBuffer(length: number): Uint8Array;
  getDecodedBuffer(): Uint8Array;
  decode(): void;
  delete?(): void;
};
type Factory = (opts: { locateFile: (path: string) => string }) => Promise<Record<string, new () => WasmDecoder>>;

const inNode = typeof process !== 'undefined' && !!process.versions?.node;
/** Vite gives a web path; under test in Node the same path sits below the project root. */
const wasmPath = (url: string) => (inNode ? process.cwd() + url.replace(/^\/@fs/, '').replace(process.cwd(), '') : url);

let charls: Promise<WasmDecoder> | null = null;
let openjpeg: Promise<WasmDecoder> | null = null;

function loadCharls(): Promise<WasmDecoder> {
  charls ??= (async () => {
    const [{ default: factory }, { default: url }] = await Promise.all([
      import('@cornerstonejs/codec-charls/decodewasmjs') as unknown as Promise<{ default: Factory }>,
      import('@cornerstonejs/codec-charls/decodewasm?url'),
    ]);
    const module = await factory({ locateFile: () => wasmPath(url) });
    return new module.JpegLSDecoder();
  })();
  return charls;
}

function loadOpenJpeg(): Promise<WasmDecoder> {
  openjpeg ??= (async () => {
    const [{ default: factory }, { default: url }] = await Promise.all([
      import('@cornerstonejs/codec-openjpeg/decodewasmjs') as unknown as Promise<{ default: Factory }>,
      import('@cornerstonejs/codec-openjpeg/decodewasm?url'),
    ]);
    const module = await factory({ locateFile: () => wasmPath(url) });
    return new module.J2KDecoder();
  })();
  return openjpeg;
}

function runWasm(decoder: WasmDecoder, frame: Uint8Array): Uint8Array {
  decoder.getEncodedBuffer(frame.length).set(frame);
  decoder.decode();
  // The decoded buffer is a view into WASM memory and is overwritten by the next call.
  return decoder.getDecodedBuffer().slice();
}

export async function decodeJpegLs(frame: Uint8Array): Promise<Uint8Array> {
  return runWasm(await loadCharls(), frame);
}

export async function decodeJ2K(frame: Uint8Array): Promise<Uint8Array> {
  return runWasm(await loadOpenJpeg(), frame);
}

export function decodeJpegLossless(frame: Uint8Array, bytesPerPixel: number): Uint8Array {
  const decoder = new LosslessDecoder();
  const buffer = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
  return new Uint8Array(decoder.decode(buffer, 0, frame.length, bytesPerPixel).buffer);
}
