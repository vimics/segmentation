import { Inflate, inflateSync } from 'fflate';

/**
 * One candidate file. A ZIP member stays a reference into the ZIP until it is read, so a large
 * archive is never unpacked into memory. Plain objects with File inside can cross to workers.
 */
export interface Source {
  file: File;
  name: string;
  zip?: { offset: number; compressedSize: number; size: number; method: number };
}

/** What went wrong among the chosen files. None of it stops the rest from loading. */
export interface IngestProblems {
  damagedZips: number;
  passwordEntries: number;
  unsupportedEntries: number;
  skippedNested: number;
}

export interface Gathered { sources: Source[]; problems: IngestProblems; }

export const noProblems = (): IngestProblems => ({ damagedZips: 0, passwordEntries: 0, unsupportedEntries: 0, skippedNested: 0 });

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, LOCATOR64 = 0x07064b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

const uint64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true));

export async function isZip(file: File): Promise<boolean> {
  if (file.size < 22) return false;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5);
}

const skipEntry = (name: string) => name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.[^/]*$/.test(name) || /\.ds_store$/i.test(name);

/** Reads the ZIP directory from the end of the file, including ZIP64 archives. */
export async function listZip(file: File, problems: IngestProblems = noProblems()): Promise<Source[]> {
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

  // In a self-extracting archive the ZIP sits after a program, and its recorded offsets may ignore that.
  const shift = locator >= 0 && view.getUint32(locator, true) === LOCATOR64 ? 0 : tailStart + at - start - size;
  start += shift;

  const dir = new DataView(await file.slice(start, start + size).arrayBuffer());
  const decoder = new TextDecoder();
  const out: Source[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(p, true) !== CENTRAL) throw new Error('This ZIP file is damaged or incomplete.');
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    let compressedSize = dir.getUint32(p + 20, true);
    let uncompressedSize = dir.getUint32(p + 24, true);
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
          if (uncompressedSize === 0xffffffff) { uncompressedSize = uint64(dir, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = uint64(dir, q); q += 8; }
          if (offset === 0xffffffff) offset = uint64(dir, q);
          break;
        }
        e += 4 + len;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;

    if (skipEntry(name)) continue;
    if (flags & 1) { problems.passwordEntries++; continue; }
    // Windows uses Deflate64 for large ZIPs, which needs its own decoder.
    if (method !== 0 && method !== 8) { problems.unsupportedEntries++; continue; }
    out.push({ file, name, zip: { offset: offset + shift, compressedSize, size: uncompressedSize, method } });
  }
  return out;
}

async function memberDataAt(source: Source): Promise<number> {
  const { offset } = source.zip!;
  const head = new DataView(await source.file.slice(offset, offset + 30).arrayBuffer());
  if (head.getUint32(0, true) !== LOCAL) throw new Error(`ZIP entry ${source.name} is damaged`);
  return offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
}

export async function readSource(source: Source): Promise<Uint8Array> {
  if (!source.zip) return new Uint8Array(await source.file.arrayBuffer());
  const { compressedSize, method } = source.zip;
  const dataAt = await memberDataAt(source);
  const bytes = new Uint8Array(await source.file.slice(dataAt, dataAt + compressedSize).arrayBuffer());
  return method === 0 ? bytes : inflateSync(bytes);
}

/** The start of a file, without reading or unpacking the rest. Programs and videos stay cheap this way. */
export async function readHead(source: Source, bytes: number): Promise<Uint8Array> {
  if (!source.zip) return new Uint8Array(await source.file.slice(0, bytes).arrayBuffer());
  const { compressedSize, method } = source.zip;
  const dataAt = await memberDataAt(source);
  if (method === 0) return new Uint8Array(await source.file.slice(dataAt, dataAt + Math.min(bytes, compressedSize)).arrayBuffer());

  const chunks: Uint8Array[] = [];
  let got = 0;
  const inflate = new Inflate((chunk) => { chunks.push(chunk); got += chunk.length; });
  const STEP = 64 * 1024;
  for (let at = 0; at < compressedSize && got < bytes; at += STEP) {
    const end = Math.min(at + STEP, compressedSize);
    inflate.push(new Uint8Array(await source.file.slice(dataAt + at, dataAt + end).arrayBuffer()), end === compressedSize);
  }
  const out = new Uint8Array(Math.min(got, bytes));
  let p = 0;
  for (const chunk of chunks) {
    if (p >= out.length) break;
    out.set(chunk.subarray(0, out.length - p), p);
    p += chunk.length;
  }
  return out;
}

const MAX_NESTING = 3;
const MAX_NESTED_BYTES = 2 * 1024 ** 3;

/** A ZIP inside a ZIP becomes a File of its own. Unpacked sizes are capped against ZIP bombs. */
async function memberAsFile(member: Source, budget: { left: number }): Promise<File | null> {
  const { size, compressedSize, method } = member.zip!;
  if (size > budget.left) return null;
  budget.left -= size;
  const dataAt = await memberDataAt(member);
  const stored = member.file.slice(dataAt, dataAt + compressedSize);
  if (method === 0) return new File([stored], member.name);
  const out = inflateSync(new Uint8Array(await stored.arrayBuffer()), { out: new Uint8Array(size) });
  return new File([out as Uint8Array<ArrayBuffer>], member.name);
}

async function addZip(file: File, depth: number, g: Gathered, budget: { left: number }): Promise<void> {
  for (const member of await listZip(file, g.problems)) {
    if (!/\.zip$/i.test(member.name)) { g.sources.push(member); continue; }
    if (depth >= MAX_NESTING) { g.problems.skippedNested++; continue; }
    try {
      const inner = await memberAsFile(member, budget);
      if (inner) await addZip(inner, depth + 1, g, budget);
      else g.problems.skippedNested++;
    } catch {
      g.problems.damagedZips++;
    }
  }
}

const isProgram = async (file: File) => {
  if (file.size < 22) return false;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x4d && head[1] === 0x5a;
};

/** Expands any ZIPs among the chosen files into individual sources. A bad one is noted and the rest still load. */
export async function toSources(files: File[]): Promise<Gathered> {
  const g: Gathered = { sources: [], problems: noProblems() };
  const budget = { left: MAX_NESTED_BYTES };
  for (const file of files) {
    if (skipEntry(file.webkitRelativePath || file.name)) continue;
    if (await isZip(file)) {
      try {
        await addZip(file, 0, g, budget);
      } catch {
        // Office files and Java programs are ZIPs too, and nobody expects those to be scans.
        if (/\.zip$/i.test(file.name)) g.problems.damagedZips++;
      }
    } else if (await isProgram(file)) {
      // Some PACS export a self-extracting archive, a program with a ZIP at its end. Most programs have none.
      const inside = await listZip(file).catch(() => [] as Source[]);
      g.sources.push(...inside, { file, name: file.webkitRelativePath || file.name });
    } else {
      g.sources.push({ file, name: file.webkitRelativePath || file.name });
    }
  }
  return g;
}
