import type { DataSet, Element } from 'dicom-parser';
import * as dicomParser from 'dicom-parser';
import { HU_MAX, HU_MIN } from '../hu';
import type { SliceHeader } from '../types';
import { decodeJ2K, decodeJpegLossless, decodeJpegLs } from './codecs';
import { TS } from './header';

/** Unpacks DICOM RLE: one PackBits stream per byte plane, most significant plane first. */
export function decodeRle(frame: Uint8Array, rows: number, cols: number, bytesPerPixel: number): Uint8Array {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const segments = view.getUint32(0, true);
  if (segments !== bytesPerPixel) throw new Error(`RLE segment count ${segments} does not match ${bytesPerPixel} bytes per pixel`);
  const pixels = rows * cols;
  const out = new Uint8Array(pixels * bytesPerPixel);
  for (let s = 0; s < segments; s++) {
    const start = view.getUint32(4 + s * 4, true);
    const end = s + 1 < segments ? view.getUint32(8 + s * 4, true) : frame.length;
    const plane = bytesPerPixel - 1 - s; // little endian output
    let p = start, o = 0;
    while (p < end && o < pixels) {
      const n = (frame[p++] << 24) >> 24;
      if (n >= 0) {
        for (let c = 0; c <= n && o < pixels; c++) out[o++ * bytesPerPixel + plane] = frame[p++];
      } else if (n !== -128) {
        const v = frame[p++];
        for (let c = 0; c <= -n && o < pixels; c++) out[o++ * bytesPerPixel + plane] = v;
      }
    }
  }
  return out;
}

function encapsulated(ds: DataSet, el: Element): Uint8Array {
  const fragments = el.fragments ?? [];
  if (!fragments.length) throw new Error('Compressed pixel data has no fragments');
  return dicomParser.readEncapsulatedPixelDataFromFragments(ds, el, 0, fragments.length);
}

function asPixelArray(bytes: Uint8Array, h: SliceHeader, littleEndian: boolean): Int32Array {
  const n = h.rows * h.cols;
  const out = new Int32Array(n);
  const signed = h.pixelRepresentation === 1;
  if (h.bitsAllocated === 8) {
    if (bytes.length < n) throw new Error('Pixel data is shorter than the image size');
    for (let i = 0; i < n; i++) out[i] = signed ? (bytes[i] << 24) >> 24 : bytes[i];
    return out;
  }
  if (h.bitsAllocated !== 16) throw new Error(`Unsupported ${h.bitsAllocated}-bit pixels`);
  if (bytes.length < n * 2) throw new Error('Pixel data is shorter than the image size');
  const shift = 32 - h.bitsStored, mask = (1 << h.bitsStored) - 1;
  for (let i = 0; i < n; i++) {
    const v = littleEndian ? bytes[i * 2] | (bytes[i * 2 + 1] << 8) : (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    // Bits above BitsStored can hold overlay data, so they are masked off.
    out[i] = signed ? ((v & mask) << shift) >> shift : v & mask;
  }
  return out;
}

export async function decodeStoredPixels(ds: DataSet, h: SliceHeader): Promise<Int32Array> {
  const el = ds.elements.x7fe00010;
  if (!el) throw new Error('File has no pixel data');
  const bytesPerPixel = h.bitsAllocated >> 3;
  const whole = () => new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + el.dataOffset, el.length);

  switch (h.transferSyntax) {
    case TS.IMPLICIT_LE:
    case TS.EXPLICIT_LE:
    case TS.DEFLATED_LE:
      return asPixelArray(whole(), h, true);
    case TS.EXPLICIT_BE:
      return asPixelArray(whole(), h, false);
    case TS.RLE:
      return asPixelArray(decodeRle(encapsulated(ds, el), h.rows, h.cols, bytesPerPixel), h, true);
    case TS.JPEG_LOSSLESS_P14:
    case TS.JPEG_LOSSLESS_SV1:
      return asPixelArray(decodeJpegLossless(encapsulated(ds, el), bytesPerPixel), h, true);
    case TS.JPEG_LS_LOSSLESS:
    case TS.JPEG_LS_NEAR:
      return asPixelArray(await decodeJpegLs(encapsulated(ds, el)), h, true);
    case TS.J2K_LOSSLESS:
    case TS.J2K:
      return asPixelArray(await decodeJ2K(encapsulated(ds, el)), h, true);
    default:
      throw new Error(`Unsupported transfer syntax ${h.transferSyntax}`);
  }
}

/** Decoded slice in Hounsfield units, capped to the shared range and optionally thinned by an in-plane step. */
export async function decodeHounsfield(ds: DataSet, h: SliceHeader, step = 1): Promise<Int16Array> {
  const stored = await decodeStoredPixels(ds, h);
  const m = h.rescaleSlope, b = h.rescaleIntercept;
  const nx = Math.ceil(h.cols / step), ny = Math.ceil(h.rows / step);
  const out = new Int16Array(nx * ny);
  for (let j = 0, n = 0; j < ny; j++) {
    const row = j * step * h.cols;
    for (let i = 0; i < nx; i++, n++) {
      const v = Math.round(stored[row + i * step] * m + b);
      out[n] = v > HU_MAX ? HU_MAX : v < HU_MIN ? HU_MIN : v;
    }
  }
  return out;
}
