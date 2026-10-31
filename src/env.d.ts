/// <reference types="vite/client" />

declare module '@cornerstonejs/codec-charls/decodewasmjs';
declare module '@cornerstonejs/codec-charls/wasmjs';
declare module '@cornerstonejs/codec-charls/decodewasm?url' {
  const url: string;
  export default url;
}
declare module '@cornerstonejs/codec-openjpeg/decodewasmjs';
declare module '@cornerstonejs/codec-openjpeg/wasmjs';
declare module '@cornerstonejs/codec-openjpeg/decodewasm?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  readonly VITE_UPLOAD_URL?: string;
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

declare const __APP_VERSION__: string;

declare module 'jpeg-lossless-decoder-js' {
  export class Decoder {
    decode(buffer: ArrayBuffer, offset: number, length: number, numBytes: number): { buffer: ArrayBuffer };
  }
}
