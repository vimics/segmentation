/** Writes CT DICOM series with known geometry, so tests can check the viewer against exact answers. */

export const PLANTED = {
  owner: 'OWNER^PLANTED',
  clinic: 'PLANTED CLINIC',
  address: 'PLANTED STREET 42',
  referring: 'DR^PLANTED',
  note: 'PLANTED NOTE',
  uid: '1.2.3.4.5.999.1',
  privateTag: 'PLANTED PRIVATE',
};

export type Syntax = 'explicit' | 'implicit' | 'bigendian' | 'rle' | 'jpeglossless';

const SYNTAX_UID: Record<Syntax, string> = {
  explicit: '1.2.840.10008.1.2.1',
  implicit: '1.2.840.10008.1.2',
  bigendian: '1.2.840.10008.1.2.2',
  rle: '1.2.840.10008.1.2.5',
  jpeglossless: '1.2.840.10008.1.2.4.70',
};

const LONG = new Set(['OB', 'OW', 'SQ', 'UN', 'UT']);
type Attr = [number, number, string, string | Uint8Array];

class Out {
  parts: Uint8Array[] = [];
  size = 0;
  constructor(private le: boolean, private explicit: boolean) {}
  raw(b: Uint8Array) { this.parts.push(b); this.size += b.length; }
  attr(group: number, element: number, vr: string, value: string | Uint8Array, undefinedLength = false) {
    let bytes: Uint8Array;
    if (typeof value === 'string') {
      const padded = value.length % 2 ? value + (vr === 'UI' ? '\0' : ' ') : value;
      bytes = new TextEncoder().encode(padded);
    } else bytes = value;
    const long = LONG.has(vr);
    const head = new Uint8Array(!this.explicit ? 8 : long ? 12 : 8), v = new DataView(head.buffer);
    v.setUint16(0, group, this.le);
    v.setUint16(2, element, this.le);
    const len = undefinedLength ? 0xffffffff : bytes.length;
    if (!this.explicit) v.setUint32(4, len, this.le);
    else {
      head[4] = vr.charCodeAt(0);
      head[5] = vr.charCodeAt(1);
      if (long) v.setUint32(8, len, this.le); else v.setUint16(6, len, this.le);
    }
    this.raw(head);
    this.raw(bytes);
  }
  bytes(): Uint8Array {
    const o = new Uint8Array(this.size);
    let p = 0;
    for (const part of this.parts) { o.set(part, p); p += part.length; }
    return o;
  }
}

const u16 = (v: number, le: boolean) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, le); return b; };

export function encodeRle(pixels: Uint16Array): Uint8Array {
  const planes = [new Uint8Array(pixels.length), new Uint8Array(pixels.length)];
  pixels.forEach((p, i) => { planes[0][i] = p >> 8; planes[1][i] = p & 255; });
  const encode = (plane: Uint8Array) => {
    const out: number[] = [];
    for (let i = 0; i < plane.length;) {
      let run = 1;
      while (i + run < plane.length && plane[i + run] === plane[i] && run < 128) run++;
      if (run >= 2) { out.push((1 - run) & 255, plane[i]); i += run; continue; }
      const start = i;
      while (i < plane.length && i - start < 128 && !(i + 1 < plane.length && plane[i + 1] === plane[i])) i++;
      if (i === start) i++;
      out.push(i - start - 1, ...plane.subarray(start, i));
    }
    if (out.length % 2) out.push(0x80);
    return Uint8Array.from(out);
  };
  const a = encode(planes[0]), b = encode(planes[1]);
  const out = new Uint8Array(64 + a.length + b.length), v = new DataView(out.buffer);
  v.setUint32(0, 2, true);
  v.setUint32(4, 64, true);
  v.setUint32(8, 64 + a.length, true);
  out.set(a, 64);
  out.set(b, 64 + a.length);
  return out;
}

/** Minimal lossless JPEG (SOF3, predictor 1, 16 bit) with a flat Huffman table. */
export function encodeJpegLossless(pixels: Uint16Array, rows: number, cols: number): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const lengths = new Array(16).fill(0);
  lengths[4] = 17; // seventeen 5-bit codes, one per difference category
  out.push(0xff, 0xc4, 0, 2 + 1 + 16 + 17, 0x00, ...lengths);
  for (let s = 0; s <= 16; s++) out.push(s);
  out.push(0xff, 0xc3, 0, 11, 16, rows >> 8, rows & 255, cols >> 8, cols & 255, 1, 1, 0x11, 0);
  out.push(0xff, 0xda, 0, 8, 1, 1, 0x00, 1, 0, 0);
  let acc = 0, bits = 0;
  const emit = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++bits === 8) { out.push(acc); if (acc === 0xff) out.push(0); acc = 0; bits = 0; }
    }
  };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const n = j * cols + i;
    const pred = n === 0 ? 1 << 15 : i === 0 ? pixels[n - cols] : pixels[n - 1];
    let diff = pixels[n] - pred;
    if (diff > 32767) diff -= 65536; else if (diff < -32768) diff += 65536;
    const mag = Math.abs(diff);
    const cat = mag === 0 ? 0 : 32 - Math.clz32(mag);
    emit(cat, 5);
    if (cat > 0 && cat < 16) emit(diff > 0 ? diff : diff + (1 << cat) - 1, cat);
  }
  while (bits) emit(1, 1);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

export function encapsulate(frame: Uint8Array): Uint8Array {
  const padded = frame.length % 2 ? new Uint8Array(frame.length + 1) : frame;
  if (padded !== frame) padded.set(frame);
  const out = new Uint8Array(8 + 8 + padded.length + 8), v = new DataView(out.buffer);
  const item = (at: number, len: number) => { v.setUint16(at, 0xfffe, true); v.setUint16(at + 2, 0xe000, true); v.setUint32(at + 4, len, true); };
  item(0, 0);
  item(8, padded.length);
  out.set(padded, 16);
  v.setUint16(16 + padded.length, 0xfffe, true);
  v.setUint16(18 + padded.length, 0xe0dd, true);
  return out;
}

export interface SliceSpec {
  rows: number;
  cols: number;
  position: number[];
  orientation?: number[];
  pixelSpacing?: [number, number];
  instance: number;
  /** Hounsfield value at (column, row) */
  hu: (i: number, j: number) => number;
  syntax?: Syntax;
  encoded?: { uid: string; frame: Uint8Array };
  seriesUid?: string;
  modality?: string;
  imageType?: string;
  burnedIn?: boolean;
  noPreamble?: boolean;
  /** Starts with the file meta group, with no 128-byte preamble */
  metaNoPreamble?: boolean;
  kernel?: string;
  description?: string;
  studyUid?: string;
  patientName?: string;
  acquisition?: string;
  temporal?: string;
  contrast?: string;
  samples?: number;
  /** Rescale intercept, for writing values far below zero */
  intercept?: number;
  /** Size of a private block before the pixel data, to push them far into the file */
  privateBytes?: number;
}

export function writeSlice(s: SliceSpec): Uint8Array {
  const syntax = s.syntax ?? 'explicit';
  const uid = s.encoded?.uid ?? SYNTAX_UID[syntax];
  const le = syntax !== 'bigendian';
  const explicit = syntax !== 'implicit';
  const intercept = s.intercept ?? -1024;

  const stored = new Uint16Array(s.rows * s.cols);
  for (let j = 0, n = 0; j < s.rows; j++) for (let i = 0; i < s.cols; i++, n++) {
    stored[n] = Math.max(0, Math.round(s.hu(i, j) - intercept));
  }

  const body = new Out(le, explicit);
  const spacing = s.pixelSpacing ?? [0.5, 0.5];
  const attrs: Attr[] = [
    [0x0008, 0x0008, 'CS', s.imageType ?? 'ORIGINAL\\PRIMARY\\AXIAL'],
    [0x0008, 0x0016, 'UI', '1.2.840.10008.5.1.4.1.1.2'],
    [0x0008, 0x0018, 'UI', `${PLANTED.uid}.${s.instance}`],
    [0x0008, 0x0020, 'DA', '20261012'],
    [0x0008, 0x0050, 'SH', 'PLANTEDACC'],
    [0x0008, 0x0060, 'CS', s.modality ?? 'CT'],
    [0x0008, 0x0070, 'LO', 'TestVendor'],
    [0x0008, 0x0080, 'LO', PLANTED.clinic],
    [0x0008, 0x0081, 'ST', PLANTED.address],
    [0x0008, 0x0090, 'PN', PLANTED.referring],
    [0x0008, 0x103e, 'LO', s.description ?? `Bone ${PLANTED.note}`],
    [0x0008, 0x1090, 'LO', 'TestModel'],
    [0x0009, 0x0010, 'LO', 'PRIVATECREATOR'],
    [0x0009, 0x1001, 'LO', PLANTED.privateTag],
    [0x0010, 0x0010, 'PN', s.patientName ?? PLANTED.owner],
    [0x0010, 0x0020, 'LO', 'PLANTEDID'],
    [0x0010, 0x2201, 'LO', 'Canine'],
    [0x0010, 0x2292, 'LO', 'Beagle'],
    [0x0010, 0x2297, 'PN', PLANTED.owner],
    [0x0010, 0x4000, 'LT', PLANTED.note],
    [0x0018, 0x0050, 'DS', '0.5'],
    [0x0018, 0x1210, 'SH', s.kernel ?? 'BONE'],
    [0x0020, 0x000d, 'UI', s.studyUid ?? `${PLANTED.uid}.100`],
    [0x0020, 0x000e, 'UI', s.seriesUid ?? `${PLANTED.uid}.200`],
    [0x0020, 0x0013, 'IS', String(s.instance)],
    [0x0020, 0x0032, 'DS', s.position.join('\\')],
    [0x0020, 0x0037, 'DS', (s.orientation ?? [1, 0, 0, 0, 1, 0]).join('\\')],
    [0x0028, 0x0002, 'US', u16(s.samples ?? 1, le)],
    [0x0028, 0x0004, 'CS', 'MONOCHROME2'],
    [0x0028, 0x0010, 'US', u16(s.rows, le)],
    [0x0028, 0x0011, 'US', u16(s.cols, le)],
    [0x0028, 0x0030, 'DS', `${spacing[0]}\\${spacing[1]}`],
    [0x0028, 0x0100, 'US', u16(16, le)],
    [0x0028, 0x0101, 'US', u16(16, le)],
    [0x0028, 0x0102, 'US', u16(15, le)],
    [0x0028, 0x0103, 'US', u16(0, le)],
    [0x0028, 0x1052, 'DS', String(intercept)],
    [0x0028, 0x1053, 'DS', '1'],
  ];
  if (s.burnedIn) attrs.push([0x0028, 0x0301, 'CS', 'YES']);
  if (s.acquisition) attrs.push([0x0020, 0x0012, 'IS', s.acquisition]);
  if (s.temporal) attrs.push([0x0020, 0x0100, 'IS', s.temporal]);
  if (s.contrast) attrs.push([0x0018, 0x0010, 'LO', s.contrast]);
  if (s.privateBytes) attrs.push([0x0029, 0x0010, 'LO', 'PRIVATECREATOR'], [0x0029, 0x1010, 'OB', new Uint8Array(s.privateBytes)]);
  attrs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [g, e, vr, v] of attrs) body.attr(g, e, vr, v);

  if (s.encoded) body.attr(0x7fe0, 0x0010, 'OB', encapsulate(s.encoded.frame), true);
  else if (syntax === 'rle') body.attr(0x7fe0, 0x0010, 'OB', encapsulate(encodeRle(stored)), true);
  else if (syntax === 'jpeglossless') body.attr(0x7fe0, 0x0010, 'OB', encapsulate(encodeJpegLossless(stored, s.rows, s.cols)), true);
  else {
    const px = new Uint8Array(stored.length * 2), v = new DataView(px.buffer);
    stored.forEach((p, i) => v.setUint16(i * 2, p, le));
    body.attr(0x7fe0, 0x0010, 'OW', px);
  }

  if (s.noPreamble) return body.bytes();

  const meta = new Out(true, true);
  meta.attr(0x0002, 0x0001, 'OB', new Uint8Array([0, 1]));
  meta.attr(0x0002, 0x0002, 'UI', '1.2.840.10008.5.1.4.1.1.2');
  meta.attr(0x0002, 0x0003, 'UI', `${PLANTED.uid}.${s.instance}`);
  meta.attr(0x0002, 0x0010, 'UI', uid);
  const metaBytes = meta.bytes();
  const file = new Out(true, true);
  const pre = new Uint8Array(132);
  pre.set([0x44, 0x49, 0x43, 0x4d], 128);
  if (!s.metaNoPreamble) file.raw(pre);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, metaBytes.length, true);
  file.attr(0x0002, 0x0000, 'UL', len);
  file.raw(metaBytes);
  file.raw(body.bytes());
  return file.bytes();
}

export interface SpherePhantom {
  slices: SliceSpec[];
  radiusMm: number;
}

/** A bone-density sphere, solid unless told otherwise, on a chosen voxel grid. */
export function spherePhantom(opts: {
  radiusMm?: number;
  dx?: number;
  dy?: number;
  dz?: number;
  size?: number;
  count?: number;
  tiltMm?: number;
  center?: number[];
  syntax?: Syntax;
} = {}): SpherePhantom {
  const radiusMm = opts.radiusMm ?? 12;
  const dx = opts.dx ?? 0.5, dy = opts.dy ?? 0.5, dz = opts.dz ?? 0.5;
  const size = opts.size ?? 64, count = opts.count ?? 64, tilt = opts.tiltMm ?? 0;
  const center = opts.center ?? [(size * dx) / 2, (size * dy) / 2, (count * dz) / 2];
  const slices: SliceSpec[] = [];
  for (let k = 0; k < count; k++) {
    const z = k * dz;
    const yShift = k * tilt; // gantry tilt slides each slice along Y
    slices.push({
      rows: size,
      cols: size,
      instance: k + 1,
      position: [0, yShift, z],
      pixelSpacing: [dy, dx],
      syntax: opts.syntax,
      hu: (i, j) => {
        const d = Math.hypot(i * dx - center[0], j * dy + yShift - center[1], z - center[2]);
        const edge = Math.max(0, Math.min(1, 0.5 + (radiusMm - d) / Math.min(dx, dy, dz)));
        return -100 + edge * 1100;
      },
    });
  }
  return { slices, radiusMm };
}
