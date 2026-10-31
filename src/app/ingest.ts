import type { FileKind } from '../engine/io/sniff';
import type { IngestProblems } from '../engine/io/sources';

/** Collects files from a drag and drop, walking any dropped folders. */

async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  // readEntries returns batches, usually 100 at a time, until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walk(child, out);
  }
}

export async function filesFromDrop(data: DataTransfer): Promise<File[]> {
  const entries = [...data.items].map((i) => i.webkitGetAsEntry()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...data.files];
  const out: File[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

const EXPORT_DICOM = 'Export the CT as DICOM from your scanner or PACS, then choose that folder or ZIP.';

/** Says what was found instead of DICOM images, and what to do next. */
export function explainNoDicom(kinds: Partial<Record<FileKind, number>>, problems: IngestProblems): string {
  if (problems.passwordEntries) return 'This ZIP is password protected. Remove the password and try again.';
  if (problems.unsupportedEntries) return 'This ZIP uses a compression method browsers cannot read, which Windows often picks for large files. Unzip it and choose the folder instead.';
  if (problems.damagedZips) return 'This ZIP is damaged or incomplete. Download or copy it again and retry.';

  const archive = kinds.rar ? 'RAR archive' : kinds['7z'] ? '7z archive' : kinds.iso ? 'disc image (ISO)' : kinds.gzip ? 'compressed archive' : '';
  if (archive) return `We found a ${archive}. Unpack it first, then choose the folder.`;
  if (kinds.dicom) return `We found DICOM files, but none of them contain images. ${EXPORT_DICOM}`;

  const pictures = (kinds.bmp ?? 0) + (kinds.jpeg ?? 0) + (kinds.png ?? 0) + (kinds.gif ?? 0) + (kinds.tiff ?? 0);
  if (pictures) {
    const programs = kinds.program ? ` and ${count(kinds.program, 'program')}` : '';
    return `We found ${count(pictures, 'picture')}${programs}. Pictures have no density data, so a 3D model can't be built from them. ${EXPORT_DICOM}`;
  }
  return EXPORT_DICOM;
}

/** Problems worth mentioning when a model could still be built. */
export function ingestWarnings(problems: IngestProblems): string[] {
  const out: string[] = [];
  const damaged = problems.damagedZips + problems.skippedNested;
  if (damaged) out.push(`${count(damaged, 'ZIP file')} inside this upload could not be read and ${damaged === 1 ? 'was' : 'were'} skipped.`);
  const locked = problems.passwordEntries + problems.unsupportedEntries;
  if (locked) out.push(`${count(locked, 'file')} in a ZIP could not be unpacked and ${locked === 1 ? 'was' : 'were'} skipped.`);
  return out;
}
