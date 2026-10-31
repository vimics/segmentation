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

const isUpper = (c: number) => c >= 0x41 && c <= 0x5a;

/** Older exports leave out the preamble. They start with the file meta group or directly with the dataset. */
function bareForm(bytes: Uint8Array): 'meta' | 'explicit' | 'implicit' | null {
  if (bytes.length < 16 || bytes[1] !== 0 || bytes[3] !== 0) return null;
  if (bytes[0] === 0x02) return 'meta';
  if (bytes[0] !== 0x08) return null;
  return isUpper(bytes[4]) && isUpper(bytes[5]) ? 'explicit' : 'implicit';
}

function withPreamble(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(132 + bytes.length);
  out.set([0x44, 0x49, 0x43, 0x4d], 128);
  out.set(bytes, 132);
  return out;
}

export const looksLikeDicom = (bytes: Uint8Array) => hasPreamble(bytes) || bareForm(bytes) !== null;

export type ParseOptions = { headerOnly?: boolean };

/** Returns null when the bytes are not DICOM, so stray files in a folder are simply skipped. */
export function parseDataset(bytes: Uint8Array, opts: ParseOptions = {}): dicomParser.DataSet | null {
  const options: dicomParser.ParseDicomOptions & { inflater?: unknown } = { inflater };
  if (opts.headerOnly) options.untilTag = 'x7fe00010';
  let input = bytes;
  if (!hasPreamble(bytes)) {
    const form = bareForm(bytes);
    if (!form) return null;
    if (form === 'meta') input = withPreamble(bytes);
    else (options as { TransferSyntaxUID?: string }).TransferSyntaxUID = form === 'explicit' ? TS.EXPLICIT_LE : TS.IMPLICIT_LE;
  }
  try {
    return dicomParser.parseDicom(input, options as dicomParser.ParseDicomOptions);
  } catch {
    return null;
  }
}

/** A short hash, enough to tell two patients apart without keeping their names in memory. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
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
    studyUid: (ds.string('x0020000d') ?? '').trim(),
    patientKey: fingerprint(`${ds.string('x00100010') ?? ''}|${ds.string('x00100020') ?? ''}`),
    acquisition: (ds.string('x00200012') ?? '').trim(),
    temporal: (ds.string('x00200100') ?? '').trim(),
    contrast: !!(ds.string('x00180010') ?? '').trim(),
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
