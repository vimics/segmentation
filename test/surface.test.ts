import { describe, expect, it } from 'vitest';
import { buildSampleVolume } from '../src/engine/sample/bone';
import { SurfaceEngine } from '../src/engine/surface/pipeline';
import type { StructureMesh, Vec3, Volume } from '../src/engine/types';

function volumeFrom(opts: {
  nx?: number; ny?: number; nz?: number;
  dx?: number; dy?: number;
  zAt?: (k: number) => number;
  yShiftAt?: (k: number) => number;
  rowDir?: Vec3; colDir?: Vec3;
  hu: (x: number, y: number, z: number) => number;
}): Volume {
  const nx = opts.nx ?? 80, ny = opts.ny ?? 80, nz = opts.nz ?? 80;
  const dx = opts.dx ?? 0.5, dy = opts.dy ?? 0.5;
  const zAt = opts.zAt ?? ((k) => k * 0.5), shift = opts.yShiftAt ?? (() => 0);
  const rowDir = opts.rowDir ?? [1, 0, 0], colDir = opts.colDir ?? [0, 1, 0];
  const data = new Int16Array(nx * ny * nz), positions = new Float64Array(nz * 3);
  for (let k = 0, n = 0; k < nz; k++) {
    const origin = [0, shift(k), zAt(k)];
    positions.set(origin, k * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, n++) {
      const x = origin[0] + rowDir[0] * i * dx + colDir[0] * j * dy;
      const y = origin[1] + rowDir[1] * i * dx + colDir[1] * j * dy;
      const z = origin[2] + rowDir[2] * i * dx + colDir[2] * j * dy;
      data[n] = Math.round(opts.hu(x, y, z));
    }
  }
  return { nx, ny, nz, data, positions, rowDir, colDir, dx, dy };
}

/** Smooth-edged sphere so the 250 HU surface sits on the true radius. */
const sphere = (c: number[], r: number, soft = 0.5) => (x: number, y: number, z: number) => {
  const d = Math.hypot(x - c[0], y - c[1], z - c[2]);
  return -300 + 1100 * Math.max(0, Math.min(1, 0.5 + (r - d) / (2 * soft)));
};

const size = (s: StructureMesh) => s.bboxMax.map((v, i) => v - s.bboxMin[i]);
const center = (s: StructureMesh) => s.bboxMax.map((v, i) => (v + s.bboxMin[i]) / 2);

describe('surface geometry in true millimetres', () => {
  // 250 HU is exactly halfway up this edge, so the surface should land on the radius.
  it('finds a sphere with the right size, volume and position', () => {
    const engine = new SurfaceEngine(volumeFrom({ hu: sphere([20, 20, 20], 12) }));
    const { structures } = engine.full(250);
    expect(structures.length).toBe(1);
    const [s] = structures;
    for (const d of size(s)) expect(d).toBeCloseTo(24, 0);
    for (const c of center(s)) expect(c).toBeCloseTo(20, 0);
    expect(s.volumeMm3 / ((4 / 3) * Math.PI * 12 ** 3)).toBeGreaterThan(0.97);
    expect(s.volumeMm3 / ((4 / 3) * Math.PI * 12 ** 3)).toBeLessThan(1.03);
  });

  it('stays correct with unequal voxel sizes', () => {
    const engine = new SurfaceEngine(volumeFrom({ nx: 100, ny: 50, nz: 30, dx: 0.4, dy: 0.8, zAt: (k) => k * 1.5, hu: sphere([20, 20, 22], 12, 0.9) }));
    const [s] = engine.full(250).structures;
    for (const d of size(s)) expect(Math.abs(d - 24)).toBeLessThan(1.2);
    expect(s.volumeMm3 / ((4 / 3) * Math.PI * 12 ** 3)).toBeGreaterThan(0.95);
  });

  it('stays correct with uneven slice spacing', () => {
    const z = (k: number) => k * 0.5 + (k > 40 ? (k - 40) * 0.5 : 0);
    const [s] = new SurfaceEngine(volumeFrom({ nz: 70, zAt: z, hu: sphere([20, 20, 22], 12, 0.9) })).full(250).structures;
    for (const d of size(s)) expect(Math.abs(d - 24)).toBeLessThan(1.2);
  });

  it('undoes gantry tilt: a sphere stays round', () => {
    const [s] = new SurfaceEngine(volumeFrom({ yShiftAt: (k) => k * 0.2, hu: sphere([20, 26, 20], 12) })).full(250).structures;
    for (const d of size(s)) expect(d).toBeCloseTo(24, 0);
    expect(center(s)[1]).toBeCloseTo(26, 0);
  });

  it('keeps left and right: an offset marker stays on its own side', () => {
    // A marker at +X in patient space must come out at +X, even when image rows run the other way.
    const hu = (x: number, y: number, z: number) => Math.max(sphere([20, 20, 20], 8)(x, y, z), sphere([32, 20, 20], 2)(x, y, z));
    const flipped = volumeFrom({ colDir: [0, -1, 0], yShiftAt: () => 39.5, hu });
    const { structures } = new SurfaceEngine(flipped).full(250);
    const big = structures.find((s) => s.volumeMm3 > 1000)!, marker = structures.find((s) => s.volumeMm3 < 100)!;
    expect(center(marker)[0]).toBeGreaterThan(center(big)[0] + 8);
    expect(center(marker)[0]).toBeCloseTo(32, 0);
  });

  it('winds outward with outward normals', () => {
    const [s] = new SurfaceEngine(volumeFrom({ hu: sphere([20, 20, 20], 12) })).full(250).structures;
    let outward = 0;
    const count = s.positions.length / 3;
    for (let i = 0; i < count; i++) {
      const dot = s.normals[i * 3] * (s.positions[i * 3] - 20) + s.normals[i * 3 + 1] * (s.positions[i * 3 + 1] - 20) + s.normals[i * 3 + 2] * (s.positions[i * 3 + 2] - 20);
      if (dot > 0) outward++;
    }
    expect(outward / count).toBeGreaterThan(0.99);
    expect(s.volumeMm3).toBeGreaterThan(0);
  });
});

describe('structures', () => {
  const spheres = (a: number[][]) => (x: number, y: number, z: number) => Math.max(...a.map(([cx, cy, cz, r]) => sphere([cx, cy, cz], r)(x, y, z)));

  it('separates bones, sorted by size, and drops specks', () => {
    const { structures, specksRemoved } = new SurfaceEngine(volumeFrom({ hu: spheres([[12, 20, 20, 8], [30, 20, 20, 5], [34, 34, 34, 0.9]]) })).full(250);
    expect(structures.length).toBe(2);
    expect(structures[0].volumeMm3).toBeGreaterThan(structures[1].volumeMm3);
    expect(specksRemoved).toBe(1);
  });

  it('counts a cavity as part of its bone and not as a structure', () => {
    const shell = (x: number, y: number, z: number) => Math.min(sphere([20, 20, 20], 14)(x, y, z), 1100 - sphere([20, 20, 20], 8)(x, y, z) - 300);
    const [s, ...rest] = new SurfaceEngine(volumeFrom({ hu: shell })).full(250).structures;
    expect(rest.length).toBe(0);
    const expected = (4 / 3) * Math.PI * (14 ** 3 - 8 ** 3);
    expect(s.volumeMm3 / expected).toBeGreaterThan(0.95);
    expect(s.volumeMm3 / expected).toBeLessThan(1.05);
  });

  it('auto-hides the table in the sample and keeps the vertebrae', () => {
    const engine = new SurfaceEngine(buildSampleVolume());
    engine.preview(250);
    const { structures } = engine.full(250);
    const shown = structures.filter((s) => !s.autoHidden), hidden = structures.filter((s) => s.autoHidden);
    expect(shown.length).toBe(3);
    expect(hidden.length).toBe(1);
  });
});

describe('levels', () => {
  it('preview agrees with full resolution on size and position', () => {
    const engine = new SurfaceEngine(volumeFrom({ nx: 160, ny: 160, nz: 160, dx: 0.25, dy: 0.25, zAt: (k) => k * 0.25, hu: sphere([20, 20, 20], 12) }));
    const preview = engine.preview(250), full = engine.full(250);
    expect(preview.resolutionMm).toBeGreaterThan(full.resolutionMm);
    expect(preview.triangles).toBeLessThan(full.triangles);
    const a = preview.structures[0], b = full.structures[0];
    for (let d = 0; d < 3; d++) expect(Math.abs(center(a)[d] - center(b)[d])).toBeLessThan(0.3);
    expect(a.volumeMm3 / b.volumeMm3).toBeGreaterThan(0.97);
    expect(a.volumeMm3 / b.volumeMm3).toBeLessThan(1.03);
  });

  it('returns no structures above the densest value', () => {
    const { structures, triangles } = new SurfaceEngine(volumeFrom({ hu: sphere([20, 20, 20], 12) })).full(2000);
    expect(structures.length).toBe(0);
    expect(triangles).toBe(0);
  });
});
