/**
 * Reports what a case folder contains and what the pipeline makes of it, leaving out everything that identifies
 * a patient, owner or clinic. Paths are never printed, and free text is shown only if it shares no word with the
 * case's own name fields or folder names.
 *
 * Run: npx vitest run --config tools/vitest.config.ts tools/inspect-case.run.ts
 * Options: CASES=cat1,dog2 picks cases, OUT=path writes the JSON report there.
 */
import { createHash } from 'node:crypto';
import { openAsBlob, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { it } from 'vitest';
import { decodeHounsfield } from '../src/engine/dicom/decode';
import { parseDataset, readHeader } from '../src/engine/dicom/header';
import { scanSource } from '../src/engine/dicom/scan';
import { groupSeries, pickBestSeries } from '../src/engine/dicom/series';
import { readSource, toSources } from '../src/engine/io/sources';
import type { SeriesInfo, SliceHeader } from '../src/engine/types';

const ROOT = resolve(import.meta.dirname, '..', 'test-data');
const NAME_TAGS = ['x00100010', 'x00101001', 'x00100020', 'x00102297', 'x00080080', 'x00080081', 'x00080090', 'x00081050', 'x00081070', 'x00081010', 'x00081040', 'x00321032', 'x00080050', 'x00200010'];

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ıİ]/g, 'i').toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const percentile = (sorted: Int16Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const distinct = <T,>(v: T[]) => [...new Set(v)];

async function inspect(label: string) {
  const dir = join(ROOT, label);
  const paths = walk(dir).filter((p) => basename(p) !== '.DS_Store');
  const nameWords = new Set<string>();
  for (const p of paths) for (const part of relative(dir, p).split(sep)) for (const w of words(part)) nameWords.add(w);

  const depths: Record<string, number> = {}, extensions: Record<string, number> = {};
  for (const p of paths) {
    const d = relative(dir, p).split(sep).length - 1;
    depths[d] = (depths[d] ?? 0) + 1;
    const raw = extname(p).slice(1).toLowerCase();
    const ext = !raw ? '(none)' : /^[a-z0-9]{1,5}$/.test(raw) && !/^\d+$/.test(raw) ? raw : '(other)';
    extensions[ext] = (extensions[ext] ?? 0) + 1;
  }

  const files = await Promise.all(paths.map(async (p) => new File([await openAsBlob(p)], basename(p))));
  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  // Containers as the pipeline sees them today. A failure here is itself a finding.
  const started = performance.now();
  const { sources, problems } = await toSources(files);

  const kinds: Record<string, { files: number; bytes: number }> = {};
  const count = (kind: string, bytes: number) => { const k = (kinds[kind] ??= { files: 0, bytes: 0 }); k.files++; k.bytes += bytes; };
  const extras = new Map<number, Record<string, string | undefined>>();
  const noImage: Record<string, number> = {};
  let unreadable = 0, parseFailed = 0;

  const headers = await mapLimit(sources, 8, async (source, fileIndex): Promise<SliceHeader | null> => {
    const scan = await scanSource(source).catch(() => null);
    if (!scan) { unreadable++; return null; }
    const { kind, ds } = scan;
    count(kind, source.zip?.size ?? source.file.size);
    if (!ds) { if (kind === 'dicom') parseFailed++; return null; }
    for (const tag of NAME_TAGS) for (const w of words(ds.string(tag) ?? '')) nameWords.add(w);
    let h: SliceHeader | null = null;
    try { h = readHeader(ds, fileIndex); } catch { /* counted below */ }
    const sop = ds.string('x00020002') ?? ds.string('x00080016') ?? 'unknown';
    if (!h) { noImage[sop] = (noImage[sop] ?? 0) + 1; return null; }
    extras.set(fileIndex, {
      study: ds.string('x0020000d'),
      patient: createHash('sha256').update(`${ds.string('x00100010') ?? ''}|${ds.string('x00100020') ?? ''}`).digest('hex'),
      acquisition: ds.string('x00200012'),
      temporal: ds.string('x00200100'),
      contrast: ds.string('x00180010'),
      tilt: ds.string('x00181120'),
      patientPosition: ds.string('x00185100'),
      kvp: ds.string('x00180060'),
      seriesNumber: ds.string('x00200011'),
      photometric: ds.string('x00280004'),
      sop,
    });
    return h;
  });
  const scanSeconds = (performance.now() - started) / 1000;

  const safe = (text: string) => {
    if (!text) return '';
    return words(text).some((w) => nameWords.has(w)) ? '[hidden: shares a word with a name field]' : text.slice(0, 80);
  };

  const found = headers.filter((h): h is SliceHeader => !!h);
  const series = groupSeries(found);
  const best = pickBestSeries(series);
  const studies = distinct(found.map((h) => extras.get(h.fileIndex)?.study));
  const patients = distinct(found.map((h) => extras.get(h.fileIndex)?.patient));

  const describe = async (s: SeriesInfo) => {
    const ex = s.slices.map((h) => extras.get(h.fileIndex) ?? {});
    const set = (k: string) => distinct(ex.map((e) => e[k]?.trim()).filter(Boolean));
    let density: Record<string, number | string> | null = null;
    if (s.usable) {
      try {
        const h = s.slices[s.slices.length >> 1];
        const ds = parseDataset(await readSource(sources[h.fileIndex]));
        const hu = Int16Array.from(await decodeHounsfield(ds!, h)).sort();
        density = { min: hu[0], p1: percentile(hu, 0.01), median: percentile(hu, 0.5), p99: percentile(hu, 0.99), max: hu[hu.length - 1] };
      } catch (err) { density = { error: err instanceof Error ? err.message : String(err) }; }
    }
    const positions = s.usable ? s.slices.map((h) => h.position as number[]) : [];
    const n = positions.length;
    return {
      chosen: s === best,
      usable: s.usable,
      reason: s.reason,
      warnings: s.warnings,
      slices: s.slices.length,
      filesInGroup: ex.length,
      study: studies.indexOf(ex[0]?.study) + 1,
      seriesNumber: set('seriesNumber'),
      description: safe(s.description),
      kernel: safe(s.kernel),
      modality: s.modality,
      imageType: distinct(s.slices.map((h) => h.imageType.join('\\'))),
      sop: set('sop'),
      matrix: `${s.rows}x${s.cols}`,
      pixelSpacing: s.pixelSpacing,
      sliceSpacing: +s.sliceSpacing.toFixed(3),
      thickness: s.thickness,
      coverageMm: n > 1 ? +(Math.hypot(positions[n - 1][0] - positions[0][0], positions[n - 1][1] - positions[0][1], positions[n - 1][2] - positions[0][2]) + s.sliceSpacing).toFixed(1) : 0,
      orientation: s.slices[0].orientation?.map((v) => +v.toFixed(2)),
      syntax: distinct(s.slices.map((h) => h.transferSyntax)),
      bits: distinct(s.slices.map((h) => `${h.bitsAllocated}/${h.bitsStored}/${h.pixelRepresentation}`)),
      samples: distinct(s.slices.map((h) => h.samplesPerPixel)),
      frames: distinct(s.slices.map((h) => h.frames)),
      rescale: distinct(s.slices.map((h) => `${h.rescaleSlope}/${h.rescaleIntercept}`)).slice(0, 4),
      burnedInFlag: s.burnedIn,
      acquisitions: set('acquisition').length,
      temporal: set('temporal').length,
      contrast: set('contrast').length > 0,
      tilt: set('tilt'),
      patientPosition: set('patientPosition'),
      kvp: set('kvp'),
      photometric: set('photometric'),
      device: safe(`${s.slices[0].manufacturer} ${s.slices[0].model}`.trim()),
      density,
    };
  };

  return {
    label,
    files: paths.length,
    totalMB: Math.round(totalBytes / 1e6),
    folderDepths: depths,
    extensions,
    problems,
    sources: sources.length,
    contentKinds: kinds,
    unreadable,
    dicomParseFailed: parseFailed,
    objectsWithoutImage: noImage,
    dicomImages: found.length,
    studies: studies.length,
    patients: patients.length,
    scanSeconds: +scanSeconds.toFixed(1),
    series: await mapLimit(series, 2, describe),
  };
}

it('inspects the real cases', async () => {
  const chosen = process.env.CASES?.split(',') ?? readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory());
  const reports = [];
  for (const label of chosen) reports.push(await inspect(label));
  const json = JSON.stringify(reports, null, 1);
  if (process.env.OUT) writeFileSync(process.env.OUT, json);
  else console.log(json);
});
