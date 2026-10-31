/**
 * Prints the density profile of the series each real case opens with: no names, only numbers.
 * Run: npx vitest run --config tools/vitest.config.ts tools/density.run.ts
 */
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { it } from 'vitest';
import { decodeHounsfield } from '../src/engine/dicom/decode';
import { parseDataset, readHeader } from '../src/engine/dicom/header';
import { scanSource } from '../src/engine/dicom/scan';
import { groupSeries, pickBestSeries } from '../src/engine/dicom/series';
import { readSource, toSources } from '../src/engine/io/sources';

const ROOT = resolve(import.meta.dirname, '..', 'test-data');
const walk = (d: string, o: string[] = []): string[] => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else o.push(p); } return o; };

it('profiles density', async () => {
  for (const label of readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isDirectory())) {
    const files = await Promise.all(walk(join(ROOT, label)).map(async (p) => new File([await openAsBlob(p)], basename(p))));
    const { sources } = await toSources(files);
    const headers = (await Promise.all(sources.map(async (s, i) => { const { ds } = await scanSource(s); return ds ? readHeader(ds, i) : null; }))).filter((h) => !!h);
    const best = pickBestSeries(groupSeries(headers))!;
    const hist = new Map<number, number>();
    let total = 0;
    for (let k = 0; k < best.slices.length; k += Math.max(1, best.slices.length >> 5)) {
      const h = best.slices[k];
      const hu = await decodeHounsfield(parseDataset(await readSource(sources[h.fileIndex]))!, h);
      for (let i = 0; i < hu.length; i += 3) { const b = Math.floor(hu[i] / 50) * 50; hist.set(b, (hist.get(b) ?? 0) + 1); total++; }
    }
    const share = (a: number, b: number) => [...hist].filter(([k]) => k >= a && k < b).reduce((n, [, v]) => n + v, 0) / total * 100;
    const rows = [...hist].filter(([k]) => k >= -300 && k < 1500).sort((a, b) => a[0] - b[0]);
    const peak = rows.reduce((m, r) => (r[1] > m[1] ? r : m), [0, 0]);
    console.log(`${label} softPeak=${peak[0]} air%=${share(-3000, -300).toFixed(1)} tissue(-300..250)%=${share(-300, 250).toFixed(1)} 250-500%=${share(250, 500).toFixed(2)} 500-1000%=${share(500, 1000).toFixed(2)} 1000-2000%=${share(1000, 2000).toFixed(2)} 2000+%=${share(2000, 40000).toFixed(2)}`);
    console.log(`  bins ${rows.filter(([k]) => k % 100 === 0).map(([k, v]) => `${k}:${(v / total * 100).toFixed(1)}`).join(' ')}`);
  }
});
