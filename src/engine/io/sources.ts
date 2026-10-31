import { inflateSync } from 'fflate';

/**
 * One candidate file. A ZIP member stays a reference into the ZIP until it is read, so a large
 * archive is never unpacked into memory. Plain objects with File inside can cross to workers.
 */
export interface Source {
  file: File;
  name: string;
  zip?: { offset: number; compressedSize: number; method: number };
}

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOCATOR64 = 0x07064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

const uint64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

export async function isZip(file: File): Promise<boolean> {
  if (file.size < 22) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5);
}

const skipEntry = (name: string) => name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.[^/]*$/.test(name) || /\.ds_store$/i.test(name);

/** Reads the ZIP directory from the end of the file, including ZIP64 archives. */
export async function listZip(file: File): Promise<Source[]> {
  const tailSize = Math.min(file.size, 66_000);
  const tailStart = file.size - tailSize;
  const tail = await file.slice(tailStart).arrayBuffer();
  const view = new DataView(tail);
  let at = -1;
  for (let i = tailSize - 22; i >= 0; i--) if (view.getUint32(i, true) === EOCD) { at = i; break; }
  if (at < 0) throw new Error('This ZIP file is damaged or incomplete.');

  let count = view.getUint16(at + 10, true);
  let size = view.getUint32(at + 12, true);
  let start = view.getUint32(at + 16, true);

  const locator = at - 20;
  if (locator >= 0 && view.getUint32(locator, true) === LOCATOR64) {
    const recordAt = uint64(view, locator + 8);
    const record = new DataView(await file.slice(recordAt, recordAt + 56).arrayBuffer());
    if (record.getUint32(0, true) !== EOCD64) throw new Error('This ZIP file is damaged or incomplete.');
    count = uint64(record, 32);
    size = uint64(record, 40);
    start = uint64(record, 48);
  }

  const dir = new DataView(await file.slice(start, start + size).arrayBuffer());
  const decoder = new TextDecoder();
  const out: Source[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new Error('This ZIP file is damaged or incomplete.');
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    let compressedSize = dir.getUint32(p + 20, true);
    const uncompressedSize = dir.getUint32(p + 24, true);
    const nameLen = dir.getUint16(p + 28, true), extraLen = dir.getUint16(p + 30, true), commentLen = dir.getUint16(p + 32, true);
    let offset = dir.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));

    // ZIP64 sizes live in an extra field, present only for the values that overflowed.
    if (compressedSize === 0xffffffff || offset === 0xffffffff || uncompressedSize === 0xffffffff) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = dir.getUint16(e, true), len = dir.getUint16(e + 2, true);
        if (id === 1) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) q += 8;
          if (compressedSize === 0xffffffff) { compressedSize = uint64(dir, q); q += 8; }
          if (offset === 0xffffffff) offset = uint64(dir, q);
          break;
        }
        e += 4 + len;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;

    if (skipEntry(name)) continue;
    if (flags & 1) throw new Error('This ZIP file is password protected. Remove the password and try again.');
    if (method !== 0 && method !== 8) continue;
    out.push({ file, name, zip: { offset, compressedSize, method } });
  }
  return out;
}

export async function readSource(source: Source): Promise<Uint8Array> {
  if (!source.zip) return new Uint8Array(await source.file.arrayBuffer());
  const { offset, compressedSize, method } = source.zip;
  const head = new DataView(await source.file.slice(offset, offset + 30).arrayBuffer());
  if (head.getUint32(0, true) !== LOCAL) throw new Error(`ZIP entry ${source.name} is damaged`);
  const dataAt = offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const bytes = new Uint8Array(await source.file.slice(dataAt, dataAt + compressedSize).arrayBuffer());
  return method === 0 ? bytes : inflateSync(bytes);
}

/** Expands any ZIPs among the chosen files into individual sources. */
export async function toSources(files: File[]): Promise<Source[]> {
  const out: Source[] = [];
  for (const file of files) {
    if (await isZip(file)) out.push(...await listZip(file));
    else if (!skipEntry(file.name)) out.push({ file, name: file.webkitRelativePath || file.name });
  }
  return out;
}
