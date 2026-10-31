/**
 * Searches every file about to be committed for words from the real cases' name fields. Prints file names and
 * counts only. Demo files are checked separately, because they are compressed: their header must hold only the
 * expected fields, and a voxel block has no text.
 * Run: npx vitest run --config tools/vitest.config.ts tools/check-commit.run.ts --disable-console-intercept
 */
import { execFileSync } from 'node:child_process';
import { openAsBlob, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { scanSource } from '../src/engine/dicom/scan';
import { unpackDemo } from '../src/engine/demo';
import { toSources } from '../src/engine/io/sources';

const REPO = resolve(import.meta.dirname, '..');
const ROOT = join(REPO, 'test-data');
const NAME_TAGS = ['x00100010', 'x00101001', 'x00100020', 'x00102297', 'x00080080', 'x00080081', 'x00080090', 'x00081050', 'x00081070', 'x00081010', 'x00081040', 'x00321032', 'x00080050'];
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ıİ]/g, 'i').toLowerCase();
const walk = (d: string, o: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else o.push(p); } return o; };

it('finds no name in what will be committed', async () => {
  const words = new Set<string>();
  for (const label of readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory())) {
    const files = await Promise.all(walk(join(ROOT, label)).map(async (p) => new File([await openAsBlob(p)], basename(p))));
    const { sources } = await toSources(files);
    for (const s of sources) {
      const { ds } = await scanSource(s);
      if (!ds) continue;
      for (const tag of NAME_TAGS) for (const w of fold(ds.string(tag) ?? '').split(/[^a-z0-9]+/)) if (w.length >= 4 && /[a-z]/.test(w)) words.add(w);
    }
  }
  // Anything already in the commit before real cases arrived can't have come from them: "clinic", "name" and so on.
  const baseline = fold(execFileSync('git', ['grep', '-h', '-I', '-e', '', process.env.BASELINE ?? '91dc8a6'], { cwd: REPO, maxBuffer: 1 << 28 }).toString());
  const generic = [...words].filter((w) => new RegExp(`\\b${w}\\b`).test(baseline));
  for (const w of generic) words.delete(w);
  console.log(`${generic.length} common words set aside, ${words.size} left to search for`);
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO }).toString().split('\n').filter(Boolean);
  const hits: Record<string, number> = {};
  for (const f of tracked) {
    if (/\.(vseg|woff2?|png|dcm|lock)$|package-lock\.json|test\/fixtures\//.test(f)) continue;
    const text = fold(readFileSync(join(REPO, f), 'latin1'));
    const n = [...words].filter((w) => new RegExp(`\\b${w}\\b`).test(text)).length;
    if (n) hits[f] = n;
  }
  console.log(`checked ${tracked.length} files against ${words.size} words | files with a match: ${JSON.stringify(hits)}`);
  for (const f of tracked.filter((t) => t.endsWith('.vseg'))) {
    const { header } = unpackDemo(gunzipSync(readFileSync(join(REPO, f))));
    console.log(`${basename(f)} fields: ${Object.keys(header).join(',')}`);
    expect(Object.keys(header).sort()).toEqual(['colDir', 'dx', 'dy', 'filter', 'nx', 'ny', 'nz', 'positions', 'rowDir', 'sourceMatrix', 'spacingMm', 'species'].sort());
  }
  expect(tracked.some((t) => t.startsWith('test-data/'))).toBe(false);
  expect(hits).toEqual({});
});
