/**
 * Proves de-identification on the real cases. For every slice of the chosen series, the cleaned file must hold no
 * word from that case's own name fields and no private tags. Also counts text-like marks in the image corners.
 * Prints counts and tag numbers only, never a value.
 * Run: npx vitest run --config tools/vitest.config.ts tools/verify-private.run.ts --disable-console-intercept
 */
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { decodeHounsfield } from '../src/engine/dicom/decode';
import { deidentify } from '../src/engine/dicom/deidentify';
import { parseDataset, readHeader } from '../src/engine/dicom/header';
import { scanSource } from '../src/engine/dicom/scan';
import { groupSeries, pickBestSeries } from '../src/engine/dicom/series';
import { readSource, toSources } from '../src/engine/io/sources';

const ROOT = resolve(import.meta.dirname, '..', 'test-data');
const NAME_TAGS = ['x00100010', 'x00101001', 'x00100020', 'x00102297', 'x00080080', 'x00080081', 'x00080090', 'x00081050', 'x00081070', 'x00081010', 'x00081040', 'x00321032', 'x00080050', 'x00200010', 'x0020000d', 'x0020000e', 'x00080018'];
const NUMERIC_TAGS = new Set(['x00080018', 'x00020003', 'x0020000d', 'x0020000e', 'x00200032', 'x00200037', 'x00200013', 'x00200011', 'x00200012', 'x00201041', 'x00280030', 'x00180050', 'x00180060', 'x00180088', 'x00181100', 'x00181150', 'x00181151', 'x00181152', 'x00281050', 'x00281051', 'x00281052', 'x00281053']);
const walk = (d: string, o: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else o.push(p); } return o; };
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ıİ]/g, 'i').toLowerCase();

/** Small bright islands in the corners, which is what burned-in text looks like. Anatomy is large or absent there. */
function cornerMarks(hu: Int16Array, cols: number, rows: number): number {
  const w = Math.floor(cols * 0.22), h = Math.floor(rows * 0.12);
  let marks = 0;
  for (const [x0, y0] of [[0, 0], [cols - w, 0], [0, rows - h], [cols - w, rows - h]]) {
    const seen = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (seen[y * w + x] || hu[(y0 + y) * cols + x0 + x] < 1500) continue;
      const stack = [y * w + x];
      seen[y * w + x] = 1;
      let size = 0;
      while (stack.length) {
        const q = stack.pop()!;
        size++;
        const qx = q % w, qy = (q / w) | 0;
        for (const [nx, ny] of [[qx + 1, qy], [qx - 1, qy], [qx, qy + 1], [qx, qy - 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx] || hu[(y0 + ny) * cols + x0 + nx] < 1500) continue;
          seen[ny * w + nx] = 1;
          stack.push(ny * w + nx);
        }
      }
      if (size >= 3 && size <= 300) marks++;
    }
  }
  return marks;
}

it('keeps identifiers out of cleaned files', async () => {
  const leaks: string[] = [];
  for (const label of readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory())) {
    const dir = join(ROOT, label);
    const paths = walk(dir).filter((p) => basename(p) !== '.DS_Store');
    const files = await Promise.all(paths.map(async (p) => new File([await openAsBlob(p)], basename(p))));
    const { sources } = await toSources(files);
    const headers = (await Promise.all(sources.map(async (s, i) => { const { ds } = await scanSource(s); return ds ? readHeader(ds, i) : null; }))).filter((h) => !!h);
    const best = pickBestSeries(groupSeries(headers))!;

    let cleaned = 0, privateTags = 0, sameUid = 0, withMarks = 0, totalMarks = 0;
    const leakTags = new Map<string, number>();
    const pathWords = new Set(paths.flatMap((p) => relative(dir, p).split(sep)).flatMap((part) => fold(part).split(/[^a-z0-9]+/)).filter((w) => w.length >= 4));
    for (const h of best.slices) {
      const original = parseDataset(await readSource(sources[h.fileIndex]))!;
      const words = new Set<string>(pathWords), uids = [original.string('x0020000d'), original.string('x0020000e'), original.string('x00080018')];
      for (const tag of NAME_TAGS) for (const w of fold(original.string(tag) ?? '').split(/[^a-z0-9.]+/)) if (w.length >= 3) words.add(w);
      const out = parseDataset(await deidentify(original, 'check'))!;
      cleaned++;
      for (const [tag, el] of Object.entries(out.elements)) {
        if (tag === 'x7fe00010' || !el.length) continue;
        if (parseInt(tag.slice(1, 5), 16) % 2 === 1) privateTags++;
        const value = fold(new TextDecoder('latin1').decode(out.byteArray.subarray(el.dataOffset, el.dataOffset + Math.min(el.length, 4096))));
        // Numeric fields hold digits by nature, so only a word with letters in it can be evidence there.
        const numeric = NUMERIC_TAGS.has(tag);
        for (const w of words) if ((!numeric || /[a-z]/.test(w)) && value.includes(w)) leakTags.set(tag, (leakTags.get(tag) ?? 0) + 1);
      }
      if (uids.some((u) => u && (out.string('x0020000d') === u || out.string('x0020000e') === u || out.string('x00080018') === u))) sameUid++;
      if (h.instanceNumber % 8 === 0) {
        const marks = cornerMarks(await decodeHounsfield(original, h), h.cols, h.rows);
        if (marks) { withMarks++; totalMarks += marks; }
      }
    }
    console.log(`${label}: cleaned ${cleaned} | private tags ${privateTags} | original UIDs kept ${sameUid} | tags matching a name word ${JSON.stringify([...leakTags])} | sampled slices with corner marks ${withMarks} (${totalMarks} marks)`);
    if (privateTags || sameUid || leakTags.size) leaks.push(label);
  }
  expect(leaks).toEqual([]);
});
