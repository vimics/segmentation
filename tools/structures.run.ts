/**
 * Lists the structures of each real case at chosen thresholds, as numbers only, to tune what gets auto-hidden.
 * Run: THRESHOLDS=cat1:250,500 npx vitest run --config tools/vitest.config.ts tools/structures.run.ts --disable-console-intercept
 */
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { it } from 'vitest';
import { decodeHounsfield } from '../src/engine/dicom/decode';
import { parseDataset, readHeader } from '../src/engine/dicom/header';
import { scanSource } from '../src/engine/dicom/scan';
import { groupSeries, pickBestSeries } from '../src/engine/dicom/series';
import { HU_MAX } from '../src/engine/hu';
import { readSource, toSources } from '../src/engine/io/sources';
import { SurfaceEngine } from '../src/engine/surface/pipeline';
import type { StructureMesh, Volume } from '../src/engine/types';

const ROOT = resolve(import.meta.dirname, '..', 'test-data');
const walk = (d: string, o: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else o.push(p); } return o; };

function surfaceArea(s: StructureMesh): number {
  let area = 0;
  const p = s.positions, t = s.indices;
  for (let n = 0; n < t.length; n += 3) {
    const a = t[n] * 3, b = t[n + 1] * 3, c = t[n + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return area;
}

it('lists structures', async () => {
  for (const entry of (process.env.THRESHOLDS ?? '').split(';')) {
    const [label, list] = entry.split(':');
    const files = await Promise.all(walk(join(ROOT, label)).map(async (p) => new File([await openAsBlob(p)], basename(p))));
    const { sources } = await toSources(files);
    const headers = (await Promise.all(sources.map(async (s, i) => { const { ds } = await scanSource(s); return ds ? readHeader(ds, i) : null; }))).filter((h) => !!h);
    const all = groupSeries(headers), best = pickBestSeries(all)!;
    // COMPARE=1 builds every full-length axial series at the same thresholds, to show what the filter changes.
    const chosen = process.env.COMPARE ? all.filter((s) => s.usable && s.plane === 'axial' && s.coverageMm >= best.coverageMm * 0.9) : [best];
    for (const series of chosen) {
    const nx = series.cols, ny = series.rows, nz = series.slices.length;
    const data = new Int16Array(nx * ny * nz), positions = new Float64Array(nz * 3);
    for (let k = 0; k < nz; k++) {
      const h = series.slices[k];
      data.set(await decodeHounsfield(parseDataset(await readSource(sources[h.fileIndex]))!, h), k * nx * ny);
      positions.set(h.position!, k * 3);
    }
    const volume: Volume = { nx, ny, nz, data, positions, rowDir: series.rowDir, colDir: series.colDir, dx: series.pixelSpacing![1], dy: series.pixelSpacing![0] };
    const engine = new SurfaceEngine(volume);
    for (const iso of list.split(',').map(Number)) {
      const r = engine.full({ min: iso, max: HU_MAX });
      const shown = r.structures.filter((s) => !s.autoHidden);
      console.log(`${label} [${series.filter} ${series.kernel}${series.reformat ? ' reformat' : ''} ${series.pixelSpacing![0].toFixed(2)}mm] @${iso}: ${shown.length} shown, ${r.structures.length} total, ${r.triangles} triangles, ${r.shellCount} shells, shown bone ${(shown.reduce((n, s) => n + s.volumeMm3, 0) / 1000).toFixed(1)} cm3`);
      if (process.env.COMPARE) continue;
      for (const s of r.structures.slice(0, 26)) {
        const size = [0, 1, 2].map((d) => s.bboxMax[d] - s.bboxMin[d]).sort((a, b) => b - a);
        const area = surfaceArea(s);
        console.log(`  ${s.autoHidden ? 'HID' : '   '} vol=${(s.volumeMm3 / 1000).toFixed(2).padStart(7)}cm3 thick=${(2 * s.volumeMm3 / area).toFixed(2).padStart(5)} size=${size.map((v) => v.toFixed(0)).join('x')}`);
      }
    }
    }
  }
});
