import type { Vec3, Volume } from '../types';

/** One resolution of a volume, ready for surface extraction. */
export interface Level {
  nx: number;
  ny: number;
  nz: number;
  data: Int16Array;
  /** Highest value in each X row, indexed by j + k*ny. Lets extraction skip empty rows. */
  rowMax: Int16Array;
  positions: Float64Array;
  rowDir: Vec3;
  colDir: Vec3;
  dx: number;
  dy: number;
  /** Median distance between slices, in mm */
  dz: number;
  sliceDir: Vec3;
}

const OUTSIDE = -2048;

function computeRowMax(data: Int16Array, nx: number, ny: number, nz: number): Int16Array {
  const out = new Int16Array(ny * nz);
  for (let k = 0, r = 0, n = 0; k < nz; k++) for (let j = 0; j < ny; j++, r++) {
    let m = -32768;
    for (let i = 0; i < nx; i++, n++) if (data[n] > m) m = data[n];
    out[r] = m;
  }
  return out;
}

/**
 * Sets the outer shell of voxels to air. Bone that runs off the edge of the scan then gets a
 * flat end instead of an open hole, which keeps every surface closed for volume and clipping.
 */
export function sealVolumeEdges(v: Volume): void {
  const { nx, ny, nz, data } = v;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const row = j * nx + k * nx * ny;
    if (k === 0 || k === nz - 1 || j === 0 || j === ny - 1) data.fill(OUTSIDE, row, row + nx);
    else { data[row] = OUTSIDE; data[row + nx - 1] = OUTSIDE; }
  }
}

export function levelFromVolume(v: Volume): Level {
  const n = v.nz - 1;
  const sliceDir: Vec3 = [
    v.positions[n * 3] - v.positions[0],
    v.positions[n * 3 + 1] - v.positions[1],
    v.positions[n * 3 + 2] - v.positions[2],
  ];
  const len = Math.hypot(...sliceDir) || 1;
  const gaps: number[] = [];
  for (let k = 1; k <= n; k++) {
    gaps.push(Math.hypot(
      v.positions[k * 3] - v.positions[(k - 1) * 3],
      v.positions[k * 3 + 1] - v.positions[(k - 1) * 3 + 1],
      v.positions[k * 3 + 2] - v.positions[(k - 1) * 3 + 2],
    ));
  }
  gaps.sort((a, b) => a - b);
  return {
    nx: v.nx, ny: v.ny, nz: v.nz,
    data: v.data,
    rowMax: computeRowMax(v.data, v.nx, v.ny, v.nz),
    positions: v.positions,
    rowDir: v.rowDir, colDir: v.colDir,
    dx: v.dx, dy: v.dy,
    dz: gaps[gaps.length >> 1],
    sliceDir: [sliceDir[0] / len, sliceDir[1] / len, sliceDir[2] / len],
  };
}

/**
 * Averages down by two. Averaging keeps thin bone visible where simply skipping voxels would
 * break it up. Slices are only merged when they are finer than the new in-plane spacing.
 */
export function downsample(l: Level): Level {
  const mergeZ = l.dz < l.dx * 1.5;
  const fz = mergeZ ? 2 : 1;
  const nx = l.nx >> 1, ny = l.ny >> 1, nz = mergeZ ? l.nz >> 1 : l.nz;
  const data = new Int16Array(nx * ny * nz);
  const sx = l.nx, sxy = l.nx * l.ny;
  for (let k = 0, n = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, n++) {
    const a = i * 2 + j * 2 * sx + k * fz * sxy;
    let s = l.data[a] + l.data[a + 1] + l.data[a + sx] + l.data[a + sx + 1];
    if (mergeZ) {
      const b = a + sxy;
      s += l.data[b] + l.data[b + 1] + l.data[b + sx] + l.data[b + sx + 1];
      data[n] = s >> 3;
    } else data[n] = s >> 2;
  }
  const positions = new Float64Array(nz * 3);
  // The merged voxel sits half a step in from the first original voxel.
  const shift = [
    (l.rowDir[0] * l.dx + l.colDir[0] * l.dy) / 2,
    (l.rowDir[1] * l.dx + l.colDir[1] * l.dy) / 2,
    (l.rowDir[2] * l.dx + l.colDir[2] * l.dy) / 2,
  ];
  for (let k = 0; k < nz; k++) for (let c = 0; c < 3; c++) {
    const a = l.positions[k * fz * 3 + c];
    const b = mergeZ ? l.positions[(k * fz + 1) * 3 + c] : a;
    positions[k * 3 + c] = (a + b) / 2 + shift[c];
  }
  return {
    nx, ny, nz, data,
    rowMax: computeRowMax(data, nx, ny, nz),
    positions,
    rowDir: l.rowDir, colDir: l.colDir,
    dx: l.dx * 2, dy: l.dy * 2,
    dz: l.dz * fz,
    sliceDir: l.sliceDir,
  };
}
