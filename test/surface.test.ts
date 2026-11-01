import { describe, expect, it } from 'vitest';
import { buildSampleVolume } from '../src/engine/sample/bone';
import { BONE_RANGE, HU_MAX } from '../src/engine/hu';
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

/** Everything at or above a density, up to the top of the scale. */
const above = (min: number) => ({ min, max: HU_MAX });

const size = (s: StructureMesh) => s.bboxMax.map((v, i) => v - s.bboxMin[i]);
const center = (s: StructureMesh) => s.bboxMax.map((v, i) => (v + s.bboxMin[i]) / 2);

describe('surface geometry in true millimetres', () => {
  // 250 HU is exactly halfway up this edge, so the surface should land on the radius.
  it('finds a sphere with the right size, volume and position', () => {
    const engine = new SurfaceEngine(volumeFrom({ hu: sphere([20, 20, 20], 12) }));
    const { structures } = engine.full(above(250));
    expect(structures.length).toBe(1);
    const [s] = structures;
    for (const d of size(s)) expect(d).toBeCloseTo(24, 0);
    for (const c of center(s)) expect(c).toBeCloseTo(20, 0);
    expect(s.volumeMm3 / ((4 / 3) * Math.PI * 12 ** 3)).toBeGreaterThan(0.97);
    expect(s.volumeMm3 / ((4 / 3) * Math.PI * 12 ** 3)).toBeLessThan(1.03);
  });

  it('stays correct with unequal voxel sizes', () => {
    const engine = new SurfaceEngine(volumeFrom({ nx: 100, ny: 50, nz: 30, dx: 0.4, dy: 0.8, zAt: (k) => k * 1.5, hu: sphere([20, 20, 22], 12, 0.9) }));
    const [s] = engine.full(above(250)).structures;
    for (const d of size(s)) expect(Math.abs(d - 24)).toBeLessThan(1.2);
    expect(s.volumeMm3 / ((4 / 3) * Math.PI * 12 ** 3)).toBeGreaterThan(0.95);
  });

  it('stays correct with uneven slice spacing', () => {
    const z = (k: number) => k * 0.5 + (k > 40 ? (k - 40) * 0.5 : 0);
    const [s] = new SurfaceEngine(volumeFrom({ nz: 70, zAt: z, hu: sphere([20, 20, 22], 12, 0.9) })).full(above(250)).structures;
    for (const d of size(s)) expect(Math.abs(d - 24)).toBeLessThan(1.2);
  });

  it('undoes gantry tilt: a sphere stays round', () => {
    const [s] = new SurfaceEngine(volumeFrom({ yShiftAt: (k) => k * 0.2, hu: sphere([20, 26, 20], 12) })).full(above(250)).structures;
    for (const d of size(s)) expect(d).toBeCloseTo(24, 0);
    expect(center(s)[1]).toBeCloseTo(26, 0);
  });

  it('keeps left and right: an offset marker stays on its own side', () => {
    // A marker at +X in patient space must come out at +X, even when image rows run the other way.
    const hu = (x: number, y: number, z: number) => Math.max(sphere([20, 20, 20], 8)(x, y, z), sphere([32, 20, 20], 2)(x, y, z));
    const flipped = volumeFrom({ colDir: [0, -1, 0], yShiftAt: () => 39.5, hu });
    const { structures } = new SurfaceEngine(flipped).full(above(250));
    const big = structures.find((s) => s.volumeMm3 > 1000)!, marker = structures.find((s) => s.volumeMm3 < 100)!;
    expect(center(marker)[0]).toBeGreaterThan(center(big)[0] + 8);
    expect(center(marker)[0]).toBeCloseTo(32, 0);
  });

  it('winds outward with outward normals', () => {
    const [s] = new SurfaceEngine(volumeFrom({ hu: sphere([20, 20, 20], 12) })).full(above(250)).structures;
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
    const { structures, specksRemoved } = new SurfaceEngine(volumeFrom({ hu: spheres([[12, 20, 20, 8], [30, 20, 20, 5], [34, 34, 34, 0.9]]) })).full(above(250));
    expect(structures.length).toBe(2);
    expect(structures[0].volumeMm3).toBeGreaterThan(structures[1].volumeMm3);
    expect(specksRemoved).toBe(1);
  });

  it('counts a cavity as part of its bone and not as a structure', () => {
    const shell = (x: number, y: number, z: number) => Math.min(sphere([20, 20, 20], 14)(x, y, z), 1100 - sphere([20, 20, 20], 8)(x, y, z) - 300);
    const [s, ...rest] = new SurfaceEngine(volumeFrom({ hu: shell })).full(above(250)).structures;
    expect(rest.length).toBe(0);
    const expected = (4 / 3) * Math.PI * (14 ** 3 - 8 ** 3);
    expect(s.volumeMm3 / expected).toBeGreaterThan(0.95);
    expect(s.volumeMm3 / expected).toBeLessThan(1.05);
  });

  it('auto-hides the table in the sample and keeps the vertebrae', () => {
    const engine = new SurfaceEngine(buildSampleVolume());
    engine.preview(above(250));
    const { structures } = engine.full(above(250));
    const shown = structures.filter((s) => !s.autoHidden), hidden = structures.filter((s) => s.autoHidden);
    expect(shown.length).toBe(3);
    expect(hidden.length).toBe(1);
  });
});

describe('levels', () => {
  it('preview agrees with full resolution on size and position', () => {
    const engine = new SurfaceEngine(volumeFrom({ nx: 160, ny: 160, nz: 160, dx: 0.25, dy: 0.25, zAt: (k) => k * 0.25, hu: sphere([20, 20, 20], 12) }));
    const preview = engine.preview(above(250)), full = engine.full(above(250));
    expect(preview.resolutionMm).toBeGreaterThan(full.resolutionMm);
    expect(preview.triangles).toBeLessThan(full.triangles);
    const a = preview.structures[0], b = full.structures[0];
    for (let d = 0; d < 3; d++) expect(Math.abs(center(a)[d] - center(b)[d])).toBeLessThan(0.3);
    expect(a.volumeMm3 / b.volumeMm3).toBeGreaterThan(0.97);
    expect(a.volumeMm3 / b.volumeMm3).toBeLessThan(1.03);
  });

  it('returns no structures above the densest value', () => {
    const { structures, triangles } = new SurfaceEngine(volumeFrom({ hu: sphere([20, 20, 20], 12) })).full(above(2000));
    expect(structures.length).toBe(0);
    expect(triangles).toBe(0);
  });

  it('never exceeds the triangle budget on noisy scans, where the estimate falls short', () => {
    let seed = 1;
    const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const volume = volumeFrom({ nx: 160, ny: 160, nz: 100, hu: () => (noise() > 0.5 ? 1000 : -1000) });
    // Roomy enough for the estimate of four times the preview, but not for what noise really produces.
    const budget = new SurfaceEngine(volume).preview(above(250)).triangles * 5;
    const engine = new SurfaceEngine(volume, budget);
    engine.preview(above(250));
    const full = engine.full(above(250));
    expect(full.triangles).toBeLessThanOrEqual(budget);
    expect(full.resolutionMm).toBeGreaterThan(0.5);
  }, 120_000);
});

describe('hiding what is not bone', () => {
  it('hides a thin curved shell, the way table pieces and tubing look on real scans', () => {
    // A hollow sphere with a 0.4 mm wall: solid enough to survive, far too thin to be a bone this size.
    const scene = (x: number, y: number, z: number) => {
      const d = Math.hypot(x - 14, y - 14, z - 14);
      return Math.max(d > 10 && d < 10.4 ? 1000 : -1000, sphere([32, 32, 32], 6)(x, y, z));
    };
    const { structures } = new SurfaceEngine(volumeFrom({ nx: 160, ny: 160, nz: 160, dx: 0.25, dy: 0.25, zAt: (k) => k * 0.25, hu: scene })).full(above(250));
    const hidden = structures.filter((s) => s.autoHidden);
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((s) => s.hiddenAs === 'fragment')).toBe(true);
    expect(structures.filter((s) => !s.autoHidden).length).toBe(1);
  });

  it('keeps a small solid bone', () => {
    const volume = volumeFrom({ hu: (x, y, z) => {
      const big = sphere([12, 12, 12], 8)(x, y, z), small = sphere([30, 30, 30], 2)(x, y, z);
      return Math.max(big, small);
    } });
    const { structures } = new SurfaceEngine(volume).full(above(250));
    expect(structures.length).toBe(2);
    expect(structures.every((s) => !s.autoHidden)).toBe(true);
  });
});

describe('a two-ended density range', () => {
  // A sphere of 500 HU around a core of 1500 HU, in 300 HU tissue.
  const cored = (x: number, y: number, z: number) => {
    const d = Math.hypot(x - 20, y - 20, z - 20);
    const blend = (edge: number) => Math.max(0, Math.min(1, 0.5 + (edge - d) / 1));
    return -300 + 800 * blend(14) + 1000 * blend(8);
  };
  const shellVolume = (4 / 3) * Math.PI * (14 ** 3 - 8 ** 3);

  it('leaves out what is denser than the top of the range, as a cavity with the right volume', () => {
    const { structures } = new SurfaceEngine(volumeFrom({ hu: cored })).full({ min: 226, max: 1000 });
    expect(structures.length).toBe(1);
    expect(structures[0].volumeMm3 / shellVolume).toBeGreaterThan(0.95);
    expect(structures[0].volumeMm3 / shellVolume).toBeLessThan(1.05);
  });

  it('matches a one-sided threshold when nothing is above the top', () => {
    const volume = () => volumeFrom({ hu: cored });
    const open = new SurfaceEngine(volume()).full(above(226));
    const band = new SurfaceEngine(volume()).full({ min: 226, max: 3000 });
    expect(band.triangles).toBe(open.triangles);
    expect(band.structures[0].volumeMm3).toBeCloseTo(open.structures[0].volumeMm3);
  });

  it('points normals out of the bone on both surfaces', () => {
    const { structures } = new SurfaceEngine(volumeFrom({ hu: cored })).full({ min: 226, max: 1000 });
    const { positions: p, normals: n } = structures[0];
    let outer = 0, inner = 0, outerOut = 0, innerIn = 0;
    for (let v = 0; v < p.length / 3; v++) {
      const rel = [p[v * 3] - 20, p[v * 3 + 1] - 20, p[v * 3 + 2] - 20];
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      const facing = rel[0] * n[v * 3] + rel[1] * n[v * 3 + 1] + rel[2] * n[v * 3 + 2];
      if (d > 11) { outer++; if (facing > 0) outerOut++; } else { inner++; if (facing < 0) innerIn++; }
    }
    expect(inner).toBeGreaterThan(100);
    expect(outerOut / outer).toBeGreaterThan(0.99);
    expect(innerIn / inner).toBeGreaterThan(0.99);
  });

  it('builds nothing when no voxel falls inside the range', () => {
    const { structures, triangles } = new SurfaceEngine(volumeFrom({ hu: () => 1000 })).full({ min: 2000, max: 3000 });
    expect(structures.length).toBe(0);
    expect(triangles).toBe(0);
  });

  it('starts every scan at the same range, on the sample too', () => {
    expect(BONE_RANGE).toEqual({ min: 226, max: 1988 });
    const { structures } = new SurfaceEngine(buildSampleVolume()).full(BONE_RANGE);
    expect(structures.filter((s) => !s.autoHidden).length).toBeGreaterThan(0);
  });
});
