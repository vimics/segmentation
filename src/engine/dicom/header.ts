import * as dicomParser from 'dicom-parser';
import { inflateSync } from 'fflate';
import type { SliceHeader, Vec3 } from '../types';

export const TS = {
  IMPLICIT_LE: '1.2.840.10008.1.2',
  EXPLICIT_LE: '1.2.840.10008.1.2.1',
  DEFLATED_LE: '1.2.840.10008.1.2.1.99',
  EXPLICIT_BE: '1.2.840.10008.1.2.2',
  JPEG_LOSSLESS_P14: '1.2.840.10008.1.2.4.57',
  JPEG_LOSSLESS_SV1: '1.2.840.10008.1.2.4.70',
  JPEG_LS_LOSSLESS: '1.2.840.10008.1.2.4.80',
  JPEG_LS_NEAR: '1.2.840.10008.1.2.4.81',
  J2K_LOSSLESS: '1.2.840.10008.1.2.4.90',
  J2K: '1.2.840.10008.1.2.4.91',
  RLE: '1.2.840.10008.1.2.5',
} as const;

export const SUPPORTED_SYNTAXES = new Set<string>(Object.values(TS));

/** Deflated files store the dataset compressed after the file meta group. */
function inflater(bytes: Uint8Array, position: number): Uint8Array {
  const inflated = inflateSync(bytes.subarray(position));
  const out = new Uint8Array(position + inflated.length);
  out.set(bytes.subarray(0, position));
  out.set(inflated, position);
  return out;
}

function hasPreamble(bytes: Uint8Array): boolean {
  return bytes.length > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d;
}

/** Older exports leave out the preamble; they start directly with a low group number. */
function looksLikeBareDataset(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const group = bytes[0] | (bytes[1] << 8);
  return group === 0x0008 && bytes[3] === 0;
}

export type ParseOptions = { headerOnly?: boolean };

/** Returns null when the bytes are not DICOM, so stray files in a folder are simply skipped. */
export function parseDataset(bytes: Uint8Array, opts: ParseOptions = {}): dicomParser.DataSet | null {
  const options: dicomParser.ParseDicomOptions & { inflater?: unknown } = { inflater };
  if (opts.headerOnly) options.untilTag = 'x7fe00010';
  if (!hasPreamble(bytes)) {
    if (!looksLikeBareDataset(bytes)) return null;
    (options as { TransferSyntaxUID?: string }).TransferSyntaxUID = TS.IMPLICIT_LE;
  }
  try {
    return dicomParser.parseDicom(bytes, options as dicomParser.ParseDicomOptions);
  } catch {
    return null;
  }
}

const numbers = (s: string | undefined): number[] =>
  (s ?? '').split('\\').map((v) => parseFloat(v)).filter((v) => Number.isFinite(v));

export function readHeader(ds: dicomParser.DataSet, fileIndex: number): SliceHeader | null {
  const seriesUid = ds.string('x0020000e');
  const rows = ds.uint16('x00280010') ?? 0;
  const cols = ds.uint16('x00280011') ?? 0;
  if (!rows || !cols) return null; // reports, DICOMDIR and other non-image objects

  const spacing = numbers(ds.string('x00280030'));
  const orientation = numbers(ds.string('x00200037'));
  const position = numbers(ds.string('x00200032'));
  const thickness = parseFloat(ds.string('x00180050') ?? '');
  const slope = parseFloat(ds.string('x00281053') ?? '');
  const intercept = parseFloat(ds.string('x00281052') ?? '');

  return {
    fileIndex,
    seriesUid: seriesUid ?? 'unknown',
    modality: (ds.string('x00080060') ?? '').trim().toUpperCase(),
    imageType: (ds.string('x00080008') ?? '').split('\\').map((v) => v.trim().toUpperCase()),
    seriesDescription: (ds.string('x0008103e') ?? '').trim(),
    kernel: (ds.string('x00181210') ?? '').trim(),
    rows,
    cols,
    pixelSpacing: spacing.length === 2 && spacing[0] > 0 && spacing[1] > 0 ? [spacing[0], spacing[1]] : null,
    orientation: orientation.length === 6 ? orientation : null,
    position: position.length === 3 ? (position as Vec3) : null,
    thickness: Number.isFinite(thickness) && thickness > 0 ? thickness : null,
    instanceNumber: parseInt(ds.string('x00200013') ?? '0', 10) || 0,
    bitsAllocated: ds.uint16('x00280100') ?? 16,
    bitsStored: ds.uint16('x00280101') ?? 16,
    pixelRepresentation: ds.uint16('x00280103') ?? 0,
    samplesPerPixel: ds.uint16('x00280002') ?? 1,
    rescaleSlope: Number.isFinite(slope) && slope !== 0 ? slope : 1,
    rescaleIntercept: Number.isFinite(intercept) ? intercept : 0,
    transferSyntax: (ds.string('x00020010') ?? TS.IMPLICIT_LE).trim(),
    frames: parseInt(ds.string('x00280008') ?? '1', 10) || 1,
    species: (ds.string('x00102201') ?? '').trim(),
    breed: (ds.string('x00102292') ?? '').trim(),
    studyDate: (ds.string('x00080020') ?? '').trim(),
    manufacturer: (ds.string('x00080070') ?? '').trim(),
    model: (ds.string('x00081090') ?? '').trim(),
    burnedIn: (ds.string('x00280301') ?? '').trim().toUpperCase() === 'YES',
  };
}
