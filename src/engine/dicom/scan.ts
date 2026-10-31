import type { DataSet } from 'dicom-parser';
import { readHead, readSource, type Source } from '../io/sources';
import { HEAD_BYTES, sniffKind, type FileKind } from '../io/sniff';
import { looksLikeDicom, parseDataset } from './header';

/**
 * Names a file and reads its DICOM header from the first bytes where possible. The header counts as complete only
 * if parsing reached the pixel data, because a long private block can cross the end of those bytes unnoticed.
 */
export async function scanSource(source: Source): Promise<{ kind: FileKind; ds: DataSet | null }> {
  const head = await readHead(source, HEAD_BYTES);
  const kind = sniffKind(head);
  if (!looksLikeDicom(head)) return { kind, ds: null };
  const quick = parseDataset(head, { headerOnly: true });
  if (quick?.elements.x7fe00010) return { kind, ds: quick };
  return { kind, ds: parseDataset(await readSource(source), { headerOnly: true }) };
}
