import type { FilterFamily, Plane, SeriesInfo, SliceHeader, Vec3 } from '../types';
import { SUPPORTED_SYNTAXES } from './header';

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };

/** Filter names by family. The number sets sharpness on Siemens scanners, and Bl and Il are lung filters there. */
const FILTERS: Array<[FilterFamily, RegExp]> = [
  ['lung', /^(?:bl|il|jl|lung)/i],
  ['bone', /^(?:b|br|i|ir|j|h|hr|u|ur|q|qr)[5-9]\d/i],
  ['soft', /^(?:b|br|i|ir|j|h|hr|q|qr)[1-4]\d/i],
  ['bone', /^(?:bone|edge|fc3\d|fc8\d|ya|yb)\b|^boneplus/i],
  ['soft', /^(?:soft|standard|stnd|detail|fc1\d)\b/i],
];

/** Used when the filter name means nothing on its own, as with the plain numbers Hitachi scanners use. */
const DESCRIPTIONS: Array<[FilterFamily, RegExp]> = [
  ['bone', /\b(?:bone|osteo|kemik)\b/i],
  ['lung', /\b(?:lung|akciger|akciğer)\b/i],
  ['soft', /\b(?:soft|yumusak|yumuşak|brain|standard)\b/i],
];

export function filterFamily(kernel: string, description: string): FilterFamily {
  const name = kernel.trim();
  for (const [family, pattern] of FILTERS) if (pattern.test(name)) return family;
  for (const [family, pattern] of DESCRIPTIONS) if (pattern.test(description)) return family;
  return 'unknown';
}

/** Comes from the slice orientation. Descriptions can't be trusted: "SAG" also means right in Turkish, and Siemens marks every reformat AXIAL. */
function planeOf(normal: number[]): Plane {
  const [x, y, z] = normal.map(Math.abs);
  if (z >= 0.95) return 'axial';
  if (x >= 0.95) return 'sagittal';
  if (y >= 0.95) return 'coronal';
  return 'oblique';
}

/** DERIVED alone says nothing: on many scanners the main series is marked DERIVED too. */
function isReformat(h: SliceHeader): boolean {
  return h.imageType.some((t) => /\b(?:MPR|MIP|MINIP|VRT|MAXIP)\b|REFORMAT/.test(t)) || /\b(?:mpr|mip|vrt)\b/i.test(h.seriesDescription);
}

/** Files of one series can still differ in matrix, plane or pixel size, and those can't share a volume. */
function groupKey(h: SliceHeader): string {
  const o = h.orientation ? h.orientation.map((v) => v.toFixed(2)).join(',') : 'none';
  const px = h.pixelSpacing ? h.pixelSpacing.map((v) => v.toFixed(3)).join('x') : 'none';
  return `${h.seriesUid}|${h.rows}x${h.cols}|${o}|${px}`;
}

const isLocalizer = (h: SliceHeader) => h.imageType.includes('LOCALIZER') || h.imageType.includes('SCOUT');

const along = (h: SliceHeader) => {
  const o = h.orientation as number[];
  return dot(h.position as Vec3, cross(o.slice(0, 3), o.slice(3, 6)));
};
const hasGeometry = (h: SliceHeader) => !!h.position && !!h.orientation;

/** Repeated positions under one UID mean several passes over the same anatomy, and each needs its own volume. */
function splitPasses(slices: SliceHeader[]): SliceHeader[][] {
  const placed = slices.filter(hasGeometry);
  const seen = new Set(placed.map((h) => along(h).toFixed(2)));
  if (seen.size === placed.length) return [slices];
  for (const field of ['temporal', 'acquisition'] as const) {
    const values = new Set(slices.map((h) => h[field]));
    if (values.size < 2) continue;
    return [...values].map((v) => slices.filter((h) => h[field] === v));
  }
  return [slices];
}

/** A large jump means separate regions under one UID, such as head and pelvis. Surfaces must not bridge it. */
function splitRegions(slices: SliceHeader[]): SliceHeader[][] {
  if (!slices.every(hasGeometry)) return [slices];
  const sorted = [...slices].sort((a, b) => along(a) - along(b));
  const gaps = sorted.slice(1).map((h, i) => along(h) - along(sorted[i]));
  const spacing = median(gaps);
  const parts: SliceHeader[][] = [[]];
  sorted.forEach((h, i) => {
    if (i && gaps[i - 1] > Math.max(spacing * 10, 10)) parts.push([]);
    parts[parts.length - 1].push(h);
  });
  return parts;
}

export function groupSeries(headers: SliceHeader[]): SeriesInfo[] {
  const groups = new Map<string, SliceHeader[]>();
  for (const h of headers) {
    const k = groupKey(h);
    const g = groups.get(k);
    if (g) g.push(h); else groups.set(k, [h]);
  }
  const out: SeriesInfo[] = [];
  for (const [id, slices] of groups) {
    const passes = splitPasses(slices);
    passes.forEach((pass, p) => {
      const regions = splitRegions(pass);
      regions.forEach((region, r) => out.push(analyse(`${id}|${p}|${r}`, region)));
    });
  }
  return out;
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
    coverageMm: 0,
    plane: 'axial',
    reformat: isReformat(first),
    filter: filterFamily(first.kernel, first.seriesDescription),
    thickness: first.thickness,
    pixelSpacing: first.pixelSpacing,
    rowDir: [1, 0, 0],
    colDir: [0, 1, 0],
    burnedIn: input.some((h) => h.burnedIn),
  };
  const reject = (reason: string) => { info.reason = reason; return info; };

  // One odd file must not lose a whole series. Only reject when every file has the problem.
  const rules: Array<[(h: SliceHeader) => boolean, string]> = [
    [(h) => !h.modality || h.modality === 'CT', `This series is ${first.modality}, not CT.`],
    [(h) => !isLocalizer(h), 'This is a scout image, not a CT series.'],
    [(h) => h.frames <= 1, 'This series uses the enhanced multi-frame format, which is not supported yet.'],
    [(h) => h.samplesPerPixel === 1, 'This series is a colour image, not CT density data.'],
    [(h) => SUPPORTED_SYNTAXES.has(h.transferSyntax), 'This series uses lossy or unsupported image compression. Export it uncompressed or lossless.'],
    [(h) => !!h.pixelSpacing, 'This series has no pixel spacing, so true sizes cannot be calculated.'],
    [hasGeometry, 'This series has no slice position data, so the 3D shape cannot be calculated.'],
  ];
  let kept = input;
  for (const [ok, reason] of rules) {
    const passing = kept.filter(ok);
    if (!passing.length) return reject(reason);
    kept = passing;
  }
  if (kept.length < input.length) {
    const skipped = input.length - kept.length;
    info.warnings.push(`${skipped} ${skipped === 1 ? 'file' : 'files'} in this series could not be used and ${skipped === 1 ? 'was' : 'were'} skipped.`);
  }

  // A skipped file may have been the first one, so the series is named from a file that stayed.
  info.description = kept[0].seriesDescription;
  info.kernel = kept[0].kernel;
  info.reformat = isReformat(kept[0]);
  info.filter = filterFamily(kept[0].kernel, kept[0].seriesDescription);
  info.thickness = kept[0].thickness;

  const o = kept[0].orientation as number[];
  const rowDir = o.slice(0, 3) as Vec3, colDir = o.slice(3, 6) as Vec3;
  const normal = cross(rowDir, colDir);
  info.rowDir = rowDir;
  info.colDir = colDir;
  info.plane = planeOf(normal);

  const sorted = kept
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
  info.coverageMm = unique[unique.length - 1].d - unique[0].d + spacing;

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

/** Share of the longest usable series a series must cover to count as the full scan. */
const FULL_SCAN = 0.9;

const longestCoverage = (series: SeriesInfo[]) => Math.max(0, ...series.filter((s) => s.usable && s.plane === 'axial').map((s) => s.coverageMm));

/**
 * The series with the most files is normally the full scan. Among series covering the full scan, reconstructions
 * beat reformats and bone filters beat the rest, so a partial bone series never hides the rest of the scan.
 */
export function pickBestSeries(series: SeriesInfo[]): SeriesInfo | null {
  const usable = series.filter((s) => s.usable);
  if (!usable.length) return null;
  const longest = Math.max(...usable.map((s) => s.coverageMm));
  const isFull = (s: SeriesInfo) => s.coverageMm >= longest * FULL_SCAN;
  let pool = usable;
  if (usable.some((s) => !s.reformat && isFull(s))) pool = pool.filter((s) => !s.reformat);
  const bone = pool.filter((s) => s.filter === 'bone' && isFull(s));
  if (bone.length) pool = bone;
  const rank = (s: SeriesInfo) => s.slices.length - (s.slices[0].contrast ? 0.5 : 0);
  return pool.reduce((best, s) => (rank(s) > rank(best) ? s : best));
}

const FILTER_NAMES: Record<Exclude<FilterFamily, 'unknown'>, string> = { bone: 'Bone filter', soft: 'Soft tissue filter', lung: 'Lung filter' };
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

function filterLabel(s: SeriesInfo): string {
  const kernel = s.kernel.trim();
  if (s.filter === 'unknown') return kernel ? `Filter ${kernel}` : 'CT series';
  return kernel ? `${FILTER_NAMES[s.filter]} (${kernel})` : FILTER_NAMES[s.filter];
}

/** One row of the series list, for example "Bone filter (I80s) · Full scan · 0.6 mm · 766 slices". */
export function describeSeries(s: SeriesInfo, all: SeriesInfo[]): string {
  if (!s.usable) return `${filterLabel(s)} · not usable`;
  const parts = [filterLabel(s)];
  if (s.reformat) parts.push(`${capital(s.plane)} reformat`);
  else if (s.plane !== 'axial') parts.push(capital(s.plane));
  if (s.plane === 'axial') parts.push(s.coverageMm >= longestCoverage(all) * FULL_SCAN ? 'Full scan' : 'Partial scan');
  parts.push(`${s.sliceSpacing.toFixed(1)} mm`, `${s.slices.length} slices`);
  return parts.join(' · ');
}

/** Why nothing can be shown, taken from the largest group so a stray dose report isn't blamed. */
export function mainReason(series: SeriesInfo[]): string {
  const largest = [...series].sort((a, b) => b.slices.length - a.slices.length)[0];
  return largest?.reason ?? 'None of these series can be used.';
}

/** The form describes one patient, so a mixed upload has to be pointed out. */
export function mixedUploadWarning(series: SeriesInfo[]): string | null {
  const slices = series.flatMap((s) => s.slices);
  const patients = new Set(slices.map((h) => h.patientKey)).size;
  const studies = new Set(slices.map((h) => h.studyUid).filter(Boolean)).size;
  if (patients > 1) return `These files contain scans of ${patients} different patients. Check that the model shows the patient you entered.`;
  if (studies > 1) return `These files contain ${studies} separate studies. Check that the model shows the one you want.`;
  return null;
}
