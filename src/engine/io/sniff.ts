export type FileKind =
  | 'dicom' | 'zip' | 'rar' | '7z' | 'gzip' | 'iso'
  | 'program' | 'bmp' | 'jpeg' | 'png' | 'gif' | 'tiff' | 'pdf' | 'text' | 'other';

/** How many bytes of a file are needed to name its kind and, usually, to read its DICOM header. */
export const HEAD_BYTES = 128 * 1024;

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** Names a file by its content, because file names and extensions from clinics can't be trusted. */
export function sniffKind(b: Uint8Array): FileKind {
  if (b.length > 132 && ascii(b, 128, 4) === 'DICM') return 'dicom';
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5)) return 'zip';
  if (ascii(b, 0, 4) === 'Rar!') return 'rar';
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return '7z';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b.length > 32774 && ascii(b, 32769, 5) === 'CD001') return 'iso';
  if (ascii(b, 0, 2) === 'MZ' || ascii(b, 0, 4) === '\xCF\xFA\xED\xFE' || ascii(b, 0, 4) === '\xCA\xFE\xBA\xBE') return 'program';
  if (ascii(b, 0, 2) === 'BM') return 'bmp';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (ascii(b, 1, 3) === 'PNG') return 'png';
  if (ascii(b, 0, 3) === 'GIF') return 'gif';
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return 'tiff';
  if (ascii(b, 0, 4) === '%PDF') return 'pdf';
  // Files with no preamble start with a low group number and a zero high byte in the element.
  if ((b[0] === 0x08 || b[0] === 0x02) && b[1] === 0 && b[3] === 0) return 'dicom';
  const start = b.subarray(0, 512);
  if (start.length && start.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc0)) return 'text';
  return 'other';
}
