import type { DataSet, Element } from 'dicom-parser';
import { TS } from './header';

/**
 * De-identification by allow-list. Only the attributes below survive, so owner names, clinic
 * details, free-text notes, private vendor tags and every nested sequence are dropped by
 * default, including ones nobody thought to list. Keep this list free of free-text fields.
 */
const KEEP = new Set([
  'x00080008', // Image Type
  'x00080016', // SOP Class
  'x00080060', // Modality
  'x00080070', // Manufacturer
  'x00081090', // Model
  'x00181020', // Software Versions
  'x00102201', // Patient Species
  'x00102292', // Patient Breed
  'x00100040', // Patient Sex
  'x00102203', // Neutered
  'x00101010', // Age
  'x00101030', // Weight
  'x00180015', // Body Part
  'x00180050', // Slice Thickness
  'x00180060', // kVp
  'x00180088', // Spacing Between Slices
  'x00181100', // Reconstruction Diameter
  'x00181120', // Gantry Tilt
  'x00181150', // Exposure Time
  'x00181151', // Tube Current
  'x00181152', // Exposure
  'x00181160', // Filter
  'x00181210', // Kernel
  'x00185100', // Patient Position
  'x00200011', // Series Number
  'x00200012', // Acquisition Number
  'x00200013', // Instance Number
  'x00200032', // Image Position
  'x00200037', // Image Orientation
  'x00201041', // Slice Location
  'x00280002', // Samples Per Pixel
  'x00280004', // Photometric
  'x00280010', // Rows
  'x00280011', // Columns
  'x00280030', // Pixel Spacing
  'x00280100', // Bits Allocated
  'x00280101', // Bits Stored
  'x00280102', // High Bit
  'x00280103', // Pixel Representation
  'x00280120', // Pixel Padding
  'x00280301', // Burned In Annotation
  'x00281050', // Window Center
  'x00281051', // Window Width
  'x00281052', // Rescale Intercept
  'x00281053', // Rescale Slope
  'x00281054', // Rescale Type
  'x00282110', // Lossy Compression
  'x7fe00010', // Pixel Data
]);

const HASHED_UIDS = new Set(['x00080018', 'x0020000d', 'x0020000e', 'x00200052']);

const LONG_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UC', 'UR', 'UT', 'UN', 'SV', 'UV']);
const DEID_METHOD = 'VIMICS ALLOW-LIST V1';

/** Case-specific salt means the original UIDs can't be recovered or linked across cases. */
export async function hashUid(uid: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${uid}`));
  let n = 0n;
  for (const b of new Uint8Array(digest).subarray(0, 16)) n = (n << 8n) | BigInt(b);
  return `2.25.${n}`;
}

class Writer {
  private parts: Uint8Array[] = [];
  size = 0;
  constructor(private readonly littleEndian: boolean, private readonly explicit: boolean) {}

  bytes(b: Uint8Array) { this.parts.push(b); this.size += b.length; }

  private header(group: number, element: number, vr: string, length: number) {
    const long = LONG_VRS.has(vr);
    const size = !this.explicit ? 8 : long ? 12 : 8;
    const buf = new Uint8Array(size), v = new DataView(buf.buffer), le = this.littleEndian;
    v.setUint16(0, group, le);
    v.setUint16(2, element, le);
    if (!this.explicit) {
      v.setUint32(4, length, le);
    } else {
      buf[4] = vr.charCodeAt(0);
      buf[5] = vr.charCodeAt(1);
      if (long) v.setUint32(8, length, le); else v.setUint16(6, length, le);
    }
    this.bytes(buf);
  }

  element(group: number, element: number, vr: string, value: Uint8Array) {
    this.header(group, element, vr, value.length);
    this.bytes(value);
  }

  undefinedLength(group: number, element: number, vr: string, value: Uint8Array) {
    this.header(group, element, vr, 0xffffffff);
    this.bytes(value);
  }

  text(group: number, element: number, vr: string, value: string) {
    const padded = value.length % 2 ? value + (vr === 'UI' ? '\0' : ' ') : value;
    this.element(group, element, vr, new TextEncoder().encode(padded));
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let p = 0;
    for (const part of this.parts) { out.set(part, p); p += part.length; }
    return out;
  }
}

const parseTag = (tag: string) => [parseInt(tag.slice(1, 5), 16), parseInt(tag.slice(5, 9), 16)] as const;

/**
 * VRs for attributes written from implicit datasets are unknown to the parser, so kept
 * attributes that came implicit stay implicit. Only explicit output needs a fallback.
 */
const elementVr = (el: Element) => el.vr ?? 'UN';

export interface DeidentifiedFile { bytes: Uint8Array; }

export async function deidentify(ds: DataSet, salt: string): Promise<Uint8Array> {
  const source = (ds.string('x00020010') ?? TS.IMPLICIT_LE).trim();
  // A deflated dataset has already been inflated by the parser, so it is written out plain.
  const syntax = source === TS.DEFLATED_LE ? TS.EXPLICIT_LE : source;
  const explicit = syntax !== TS.IMPLICIT_LE;
  const littleEndian = syntax !== TS.EXPLICIT_BE;
  const hadExplicitSource = explicit;

  const sopClass = ds.string('x00080016') ?? ds.string('x00020002') ?? '';
  const sopInstance = await hashUid(ds.string('x00080018') ?? ds.string('x00020003') ?? crypto.randomUUID(), salt);

  // File meta is always explicit little endian, whatever the dataset uses.
  const metaBody = new Writer(true, true);
  metaBody.element(0x0002, 0x0001, 'OB', new Uint8Array([0, 1]));
  metaBody.text(0x0002, 0x0002, 'UI', sopClass);
  metaBody.text(0x0002, 0x0003, 'UI', sopInstance);
  metaBody.text(0x0002, 0x0010, 'UI', syntax);
  metaBody.text(0x0002, 0x0012, 'UI', '2.25.230459871234987123498712');
  metaBody.text(0x0002, 0x0013, 'SH', 'VIMICS_BV_1');
  const metaBytes = metaBody.toBytes();

  const file = new Writer(true, true);
  const preamble = new Uint8Array(132);
  preamble.set([0x44, 0x49, 0x43, 0x4d], 128);
  file.bytes(preamble);
  const groupLength = new Uint8Array(4);
  new DataView(groupLength.buffer).setUint32(0, metaBytes.length, true);
  file.element(0x0002, 0x0000, 'UL', groupLength);
  file.bytes(metaBytes);

  const body = new Writer(littleEndian, explicit);
  const entries: Array<{ tag: string; write: () => void }> = [];
  const add = (tag: string, write: () => void) => entries.push({ tag, write });

  for (const tag of Object.keys(ds.elements)) {
    if (KEEP.has(tag)) {
      const el = ds.elements[tag];
      const [g, e] = parseTag(tag);
      if (el.items) continue; // nested sequences never pass, even under a kept tag
      const encapsulated = !!el.fragments || el.encapsulatedPixelData;
      add(tag, () => {
        const raw = new Uint8Array(ds.byteArray.buffer, ds.byteArray.byteOffset + el.dataOffset, el.length);
        if (encapsulated) body.undefinedLength(g, e, 'OB', withDelimiter(raw, littleEndian));
        else body.element(g, e, hadExplicitSource ? elementVr(el) : 'UN', raw);
      });
    } else if (HASHED_UIDS.has(tag)) {
      const [g, e] = parseTag(tag);
      const value = tag === 'x00080018' ? sopInstance : await hashUid(ds.string(tag) ?? '', salt);
      add(tag, () => body.text(g, e, 'UI', value));
    }
  }
  if (!ds.elements.x00080018) add('x00080018', () => body.text(0x0008, 0x0018, 'UI', sopInstance));

  // Blank type 2 attributes keep the files valid for other DICOM software.
  add('x00080020', () => body.element(0x0008, 0x0020, 'DA', new Uint8Array()));
  add('x00080030', () => body.element(0x0008, 0x0030, 'TM', new Uint8Array()));
  add('x00080050', () => body.element(0x0008, 0x0050, 'SH', new Uint8Array()));
  add('x00080090', () => body.element(0x0008, 0x0090, 'PN', new Uint8Array()));
  add('x00100010', () => body.element(0x0010, 0x0010, 'PN', new Uint8Array()));
  add('x00100020', () => body.element(0x0010, 0x0020, 'LO', new Uint8Array()));
  add('x00120062', () => body.text(0x0012, 0x0062, 'CS', 'YES'));
  add('x00120063', () => body.text(0x0012, 0x0063, 'LO', DEID_METHOD));

  entries.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  for (const entry of entries) entry.write();
  file.bytes(body.toBytes());
  return file.toBytes();
}

/** Encapsulated pixel data must end in a sequence delimiter; the parser's length may or may not include it. */
function withDelimiter(raw: Uint8Array, littleEndian: boolean): Uint8Array {
  const n = raw.length;
  const isDelim = n >= 8 && (littleEndian
    ? raw[n - 8] === 0xfe && raw[n - 7] === 0xff && raw[n - 6] === 0xdd && raw[n - 5] === 0xe0
    : raw[n - 8] === 0xff && raw[n - 7] === 0xfe && raw[n - 6] === 0xe0 && raw[n - 5] === 0xdd);
  if (isDelim) return raw;
  const out = new Uint8Array(n + 8);
  out.set(raw);
  new DataView(out.buffer).setUint16(n, 0xfffe, littleEndian);
  new DataView(out.buffer).setUint16(n + 2, 0xe0dd, littleEndian);
  return out;
}
