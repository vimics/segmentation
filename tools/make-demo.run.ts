/**
 * Builds the public demo cases from test-data/. Only voxels and geometry are written, cropped to what the viewer
 * shows at the default range, with values below -300 HU rounded to shrink the file. Set STEP=dog1:2 to halve a case in plane if it comes out too big.
 * Run: npx vitest run --config tools/vitest.config.ts tools/make-demo.run.ts --disable-console-intercept
 */
import { mkdirSync, openAsBlob, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { it } from 'vitest';
import { decodeHounsfield } from '../src/engine/dicom/decode';
import { parseDataset, readHeader } from '../src/engine/dicom/header';
import { scanSource } from '../src/engine/dicom/scan';
import { groupSeries, pickBestSeries } from '../src/engine/dicom/series';
import { packDemo, unpackDemo, type DemoHeader } from '../src/engine/demo';
import { readSource, toSources } from '../src/engine/io/sources';
import { BONE_RANGE } from '../src/engine/hu';
import { SurfaceEngine } from '../src/engine/surface/pipeline';
import type { Volume } from '../src/engine/types';

const ROOT = resolve(import.meta.dirname, '..', 'test-data');
const OUT = resolve(import.meta.dirname, '..', 'public', 'demo');
const walk = (d: string, o: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else o.push(p); } return o; };
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const MARGIN = 4, AIR_BELOW = -300, AIR_STEP = 32;

it('builds demo cases', async () => {
  mkdirSync(OUT, { recursive: true });
  const steps = new Map((process.env.STEP ?? '').split(',').filter(Boolean).map((e) => { const [k, v] = e.split(':'); return [k, +v] as const; }));
  const only = process.env.CASES?.split(',');
  for (const label of readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory() && (!only || only.includes(n)))) {
    const files = await Promise.all(walk(join(ROOT, label)).map(async (p) => new File([await openAsBlob(p)], basename(p))));
    const { sources } = await toSources(files);
    const headers = (await Promise.all(sources.map(async (s, i) => { const { ds } = await scanSource(s); return ds ? readHeader(ds, i) : null; }))).filter((h) => !!h);
    const best = pickBestSeries(groupSeries(headers))!;
    const step = steps.get(label) ?? 1;
    const nx = Math.ceil(best.cols / step), ny = Math.ceil(best.rows / step), nz = best.slices.length;
    const dx = best.pixelSpacing![1] * step, dy = best.pixelSpacing![0] * step;
    const data = new Int16Array(nx * ny * nz), positions = new Float64Array(nz * 3);
    for (let k = 0; k < nz; k++) {
      const h = best.slices[k];
      data.set(await decodeHounsfield(parseDataset(await readSource(sources[h.fileIndex]))!, h, step), k * nx * ny);
      positions.set(h.position!, k * 3);
    }
    const volume: Volume = { nx, ny, nz, data, positions, rowDir: best.rowDir, colDir: best.colDir, dx, dy };

    // Crops to what the viewer shows. The corners of an image, where burned-in text sits, go with it.
    const engine = new SurfaceEngine({ ...volume, data: data.slice() });
    const shown = engine.full(BONE_RANGE).structures.filter((s) => !s.autoHidden);
    const normal = cross(best.rowDir, best.colDir);
    const along = Array.from({ length: nz }, (_, k) => dot([positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]], normal));
    const increasing = along[nz - 1] >= along[0];
    let i0 = nx, i1 = 0, j0 = ny, j1 = 0, k0 = nz, k1 = 0;
    for (const s of shown) for (const cx of [s.bboxMin[0], s.bboxMax[0]]) for (const cy of [s.bboxMin[1], s.bboxMax[1]]) for (const cz of [s.bboxMin[2], s.bboxMax[2]]) {
      const c = [cx, cy, cz], d = dot(c, normal);
      let k = 0;
      while (k < nz - 1 && (increasing ? along[k] < d : along[k] > d)) k++;
      k0 = Math.min(k0, k); k1 = Math.max(k1, k);
      for (const slice of [0, nz - 1]) {
        const o = [positions[slice * 3], positions[slice * 3 + 1], positions[slice * 3 + 2]];
        const rel = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
        const i = dot(rel, best.rowDir) / dx, j = dot(rel, best.colDir) / dy;
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
    }
    i0 = Math.max(0, Math.floor(i0) - MARGIN); i1 = Math.min(nx - 1, Math.ceil(i1) + MARGIN);
    j0 = Math.max(0, Math.floor(j0) - MARGIN); j1 = Math.min(ny - 1, Math.ceil(j1) + MARGIN);
    k0 = Math.max(0, k0 - MARGIN); k1 = Math.min(nz - 1, k1 + MARGIN);
    const cx = i1 - i0 + 1, cy = j1 - j0 + 1, cz = k1 - k0 + 1;
    const cropped = new Int16Array(cx * cy * cz), newPositions: number[] = [];
    for (let k = 0; k < cz; k++) {
      for (let j = 0; j < cy; j++) {
        const from = (k + k0) * nx * ny + (j + j0) * nx + i0;
        const to = k * cx * cy + j * cx;
        // Noise in the air is most of the file size and carries nothing, so only those values are rounded.
        for (let i = 0; i < cx; i++) { const v = data[from + i]; cropped[to + i] = v < AIR_BELOW ? Math.round(v / AIR_STEP) * AIR_STEP : v; }
      }
      for (let d = 0; d < 3; d++) newPositions.push(positions[(k + k0) * 3 + d] + best.rowDir[d] * dx * i0 + best.colDir[d] * dy * j0);
    }

    const header: DemoHeader = {
      species: label.startsWith('cat') ? 'Cat' : 'Dog',
      nx: cx, ny: cy, nz: cz, dx, dy, positions: newPositions, rowDir: best.rowDir, colDir: best.colDir,
      spacingMm: best.sliceSpacing, sourceMatrix: [best.cols, best.rows], filter: best.filter,
    };
    // Burned-in text stays on the same pixels through a series. Anatomy moves from slice to slice.
    const persistence = new Uint16Array(cx * cy);
    for (let k = 0; k < cz; k++) for (let n = 0; n < persistence.length; n++) if (cropped[k * cx * cy + n] >= 3000) persistence[n]++;
    const fixedPixels = persistence.reduce((sum, c) => sum + (c >= cz * 0.9 ? 1 : 0), 0);

    const packed = packDemo(header, cropped);
    const gz = gzipSync(packed, { level: 9 });
    writeFileSync(join(OUT, `${label}.vseg`), gz);

    // The file must keep what it promises to: the same bones, and only the expected fields.
    const back = unpackDemo(packed);
    const check = new SurfaceEngine(back.volume).full(BONE_RANGE);
    const shownBack = check.structures.filter((s) => !s.autoHidden).reduce((n, s) => n + s.volumeMm3, 0);
    const shownOrig = shown.reduce((n, s) => n + s.volumeMm3, 0);
    console.log(`${label}: ${best.cols}x${best.rows}x${nz} -> ${cx}x${cy}x${cz} step ${step} | ${(cx * cy * cz / 1e6).toFixed(0)}M voxels | file ${(gz.length / 1e6).toFixed(1)} MB | bone kept ${(shownBack / shownOrig * 100).toFixed(1)}% | pixels bright on 90%+ of slices ${fixedPixels} | fields ${Object.keys(header).length}`);
  }
});
