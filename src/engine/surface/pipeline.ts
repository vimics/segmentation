import type { HuRange } from '../hu';
import type { SurfaceResult, Volume } from '../types';
import { splitStructures } from './components';
import { downsample, levelFromVolume, sealVolumeEdges, type Level } from './level';
import { extractSurface } from './marching';

/** Above this the mesh would strain integrated graphics, so a coarser level is used and stated. */
export const TRIANGLE_BUDGET = 6_000_000;
/**
 * Extra room when the vet asks to see small shells. Without it, a scan near the budget would coarsen as a whole and
 * blur the very specks they asked for. Real scans needed about 1M of it.
 */
export const SHELL_ALLOWANCE = 2_000_000;
const PREVIEW_MAX_VOXELS = 24_000_000;
const AO_MAX_VOXELS = 6_000_000;

const voxels = (l: Level) => l.nx * l.ny * l.nz;

export class SurfaceEngine {
  /** Finest first */
  private levels: Level[] = [];
  private previewIndex = 0;
  private lengthMm = 0;
  private aoLevel!: Level;
  private lastPreviewTriangles = new Map<string, number>();

  constructor(volume: Volume, private budget = TRIANGLE_BUDGET) {
    sealVolumeEdges(volume);
    let level = levelFromVolume(volume);
    this.levels.push(level);
    while (voxels(level) > AO_MAX_VOXELS && Math.min(level.nx, level.ny) > 32) {
      level = downsample(level);
      this.levels.push(level);
    }
    this.aoLevel = level;
    this.previewIndex = Math.max(0, this.levels.findIndex((l) => voxels(l) <= PREVIEW_MAX_VOXELS));
    // A scan's own first level is usually fine for a tiny scan, but still halve it once if we can.
    if (this.previewIndex === 0 && voxels(this.levels[0]) > 2_000_000) {
      if (this.levels.length < 2) { this.levels.push(downsample(this.levels[0])); this.aoLevel = this.levels[1]; }
      this.previewIndex = 1;
    }
    const f = this.levels[0];
    this.lengthMm = Math.max((f.nx - 1) * f.dx, (f.ny - 1) * f.dy, (f.nz - 1) * f.dz);
  }

  private run(levelIndex: number, range: HuRange, quality: 'preview' | 'full', keepShells: boolean): SurfaceResult {
    const level = this.levels[levelIndex];
    const mesh = extractSurface(level, range, this.aoLevel);
    const triangles = mesh.indices.length / 3;
    const { structures, shellCount, fragmentCount, boneCount } = splitStructures(mesh, { lengthMm: this.lengthMm }, { keepShells });
    if (quality === 'preview') {
      if (this.lastPreviewTriangles.size > 64) this.lastPreviewTriangles.clear();
      this.lastPreviewTriangles.set(`${range.min}:${range.max}`, triangles);
    }
    return {
      structures,
      triangles: structures.reduce((n, s) => n + s.indices.length / 3, 0),
      shellCount,
      fragmentCount,
      boneCount,
      resolutionMm: level.dx,
      range,
      quality,
    };
  }

  preview(range: HuRange, keepShells = false): SurfaceResult {
    return this.run(this.previewIndex, range, 'preview', keepShells);
  }

  full(range: HuRange, keepShells = false): SurfaceResult {
    // Each halving step multiplies triangles by about four, so the preview predicts the cost.
    const known = this.lastPreviewTriangles.get(`${range.min}:${range.max}`)
      ?? extractSurface(this.levels[this.previewIndex], range, this.aoLevel).indices.length / 3;
    let index = 0;
    const limit = this.budget + (keepShells ? SHELL_ALLOWANCE : 0);
    while (index < this.previewIndex && known * 4 ** (this.previewIndex - index) > limit) index++;
    let result = this.run(index, range, 'full', keepShells);
    // Noise grows faster than the estimate, because the coarser level smooths it away.
    while (result.triangles > limit && index < this.previewIndex) result = this.run(++index, range, 'full', keepShells);
    return result;
  }
}
