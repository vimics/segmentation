import type { SeriesInfo, SliceHeader, Vec3 } from '../types';
import { SUPPORTED_SYNTAXES } from './header';

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

/** Files of one series can still differ in matrix or plane, and those can't share a volume. */
function groupKey(h: SliceHeader): string {
  const o = h.orientation ? h.orientation.map((v) => v.toFixed(2)).join(',') : 'none';
  return `${h.seriesUid}|${h.rows}x${h.cols}|${o}`;
}

const isLocalizer = (h: SliceHeader) => h.imageType.includes('LOCALIZER') || h.imageType.includes('SCOUT');

export function groupSeries(headers: SliceHeader[]): SeriesInfo[] {
  const groups = new Map<string, SliceHeader[]>();
  for (const h of headers) {
    const k = groupKey(h);
    const g = groups.get(k);
    if (g) g.push(h); else groups.set(k, [h]);
  }
  return [...groups.entries()].map(([id, slices]) => analyse(id, slices));
}

function analyse(id: string, input: SliceHeader[]): SeriesInfo {
  const first = input[0];
  const info: SeriesInfo = {
    id,
    description: first.seriesDescription,
    kernel: first.kernel,
    modality: first.modality,
    slices: input,
    usable: false,
    warnings: [],
    rows: first.rows,
    cols: first.cols,
    sliceSpacing: 0,
    thickness: first.thickness,
    pixelSpacing: first.pixelSpacing,
    rowDir: [1, 0, 0],
    colDir: [0, 1, 0],
    burnedIn: input.some((h) => h.burnedIn),
  };
  const reject = (reason: string) => { info.reason = reason; return info; };

  if (first.modality && first.modality !== 'CT') return reject(`This series is ${first.modality}, not CT.`);
  if (input.some(isLocalizer)) return reject('This is a scout image, not a CT series.');
  if (input.some((h) => h.frames > 1)) return reject('This series uses the enhanced multi-frame format, which is not supported yet.');
  if (input.some((h) => h.samplesPerPixel !== 1)) return reject('This series is a colour image, not CT density data.');
  const syntax = input.find((h) => !SUPPORTED_SYNTAXES.has(h.transferSyntax));
  if (syntax) return reject('This series uses lossy or unsupported image compression. Export it uncompressed or lossless.');
  if (!first.pixelSpacing) return reject('This series has no pixel spacing, so true sizes cannot be calculated.');
  if (input.some((h) => !h.position || !h.orientation)) return reject('This series has no slice position data, so the 3D shape cannot be calculated.');

  const o = first.orientation as number[];
  const rowDir = o.slice(0, 3) as Vec3, colDir = o.slice(3, 6) as Vec3;
  const normal = cross(rowDir, colDir);
  info.rowDir = rowDir;
  info.colDir = colDir;

  const sorted = input
    .map((h) => ({ h, d: dot(h.position as Vec3, normal) }))
    .sort((a, b) => a.d - b.d);

  // Re-exports can repeat a slice; a repeated position would fold the surface back on itself.
  const unique: typeof sorted = [];
  for (const s of sorted) if (!unique.length || s.d - unique[unique.length - 1].d > 1e-3) unique.push(s);
  if (unique.length < sorted.length) info.warnings.push(`${sorted.length - unique.length} duplicate slices were ignored.`);

  if (unique.length < 3) return reject('This series has too few slices to build a 3D model.');
  info.slices = unique.map((s) => s.h);

  const gaps = unique.slice(1).map((s, i) => s.d - unique[i].d);
  const spacing = median(gaps);
  info.sliceSpacing = spacing;

  const missing = gaps.reduce((n, g) => (g > spacing * 1.5 ? n + Math.round(g / spacing) - 1 : n), 0);
  if (missing > 0) {
    const at = gaps.findIndex((g) => g > spacing * 1.5);
    info.warnings.push(`${missing} ${missing === 1 ? 'slice is' : 'slices are'} missing near slice ${at + 1}. Geometry across the gap is approximate.`);
  } else if (Math.max(...gaps) - Math.min(...gaps) > spacing * 0.1) {
    info.warnings.push('Slice spacing varies in this series. Each slice is placed at its recorded position.');
  }
  if (spacing > 2) info.warnings.push(`Slices are ${spacing.toFixed(1)} mm apart, so fine bone detail will be lost.`);

  info.usable = true;
  return info;
}

/** Prefers the most slices at the thinnest spacing, with a nudge towards bone reconstructions. */
export function pickBestSeries(series: SeriesInfo[]): SeriesInfo | null {
  const usable = series.filter((s) => s.usable);
  if (!usable.length) return null;
  const score = (s: SeriesInfo) => {
    const text = `${s.description} ${s.kernel}`.toLowerCase();
    const boneBonus = /bone|osteo|sharp|hd.?bone|\bb[6-9]\d|\bh[6-9]\d|\bfc3\d|\bya\b/.test(text) ? 1.3 : 1;
    const softPenalty = /soft|brain|lung/.test(text) ? 0.85 : 1;
    return s.slices.length * boneBonus * softPenalty;
  };
  return usable.reduce((best, s) => (score(s) > score(best) ? s : best));
}

export function describeSeries(s: SeriesInfo): string {
  const name = s.description || s.kernel || 'CT series';
  return s.usable ? `${name} · ${s.sliceSpacing.toFixed(1)} mm · ${s.slices.length} slices` : `${name} · not usable`;
}
