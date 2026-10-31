import { edgeTable, triTable } from 'three/addons/objects/MarchingCubes.js';
import type { MeshData } from '../types';
import type { Level } from './level';

class Grow {
  a: Float32Array;
  n = 0;
  constructor(capacity: number) { this.a = new Float32Array(capacity); }
  reserve(extra: number) {
    if (this.n + extra <= this.a.length) return;
    const next = new Float32Array(Math.max(this.a.length * 2, this.n + extra));
    next.set(this.a.subarray(0, this.n));
    this.a = next;
  }
}

class GrowIndex {
  a: Uint32Array;
  n = 0;
  constructor(capacity: number) { this.a = new Uint32Array(capacity); }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) {
      const next = new Uint32Array(this.a.length * 2);
      next.set(this.a);
      this.a = next;
    }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
}

const AO_STEPS: Array<[number, number]> = [[2, 0.3], [4, 0.26], [7, 0.2], [11, 0.14], [16, 0.1]];

/**
 * Marching cubes on the CT grid. Bone is the side at or above `iso`.
 *
 * Vertices are placed using each slice's own recorded position, so uneven spacing and gantry
 * tilt come out right in millimetres without resampling the scan. Normals come from the CT
 * gradient, which shades smoothly without moving any geometry. Vertex colours hold an
 * occlusion term sampled from `aoLevel`, which gives crevices depth without post-processing.
 */
export function extractSurface(l: Level, iso: number, aoLevel: Level): MeshData {
  const { nx, ny, nz, data, rowMax } = l;
  const sxy = nx * ny;
  const pos = new Grow(1 << 18), grad = new Grow(1 << 18);
  const tris = new GrowIndex(1 << 18);

  let xe0 = new Int32Array(sxy).fill(-1), xe1 = new Int32Array(sxy).fill(-1);
  let ye0 = new Int32Array(sxy).fill(-1), ye1 = new Int32Array(sxy).fill(-1);
  const ze = new Int32Array(sxy);
  const edgeV = new Int32Array(12);

  const value = (i: number, j: number, k: number) => {
    const ci = i < 0 ? 0 : i >= nx ? nx - 1 : i;
    const cj = j < 0 ? 0 : j >= ny ? ny - 1 : j;
    const ck = k < 0 ? 0 : k >= nz ? nz - 1 : k;
    return data[ci + cj * nx + ck * sxy];
  };

  /** Adds a vertex between two grid points, returning its index. Position is in grid units for now. */
  const vertex = (ai: number, aj: number, ak: number, bi: number, bj: number, bk: number, va: number, vb: number): number => {
    const t = (iso - va) / (vb - va);
    pos.reserve(3);
    grad.reserve(3);
    const p = pos.a, g = grad.a, n = pos.n;
    p[n] = ai + (bi - ai) * t;
    p[n + 1] = aj + (bj - aj) * t;
    p[n + 2] = ak + (bk - ak) * t;
    // Gradient at both grid points, interpolated along the edge
    const gax = value(ai + 1, aj, ak) - value(ai - 1, aj, ak), gbx = value(bi + 1, bj, bk) - value(bi - 1, bj, bk);
    const gay = value(ai, aj + 1, ak) - value(ai, aj - 1, ak), gby = value(bi, bj + 1, bk) - value(bi, bj - 1, bk);
    const gaz = value(ai, aj, ak + 1) - value(ai, aj, ak - 1), gbz = value(bi, bj, bk + 1) - value(bi, bj, bk - 1);
    g[n] = gax + (gbx - gax) * t;
    g[n + 1] = gay + (gby - gay) * t;
    g[n + 2] = gaz + (gbz - gaz) * t;
    pos.n += 3;
    grad.n += 3;
    return n / 3;
  };

  for (let k = 0; k < nz - 1; k++) {
    ze.fill(-1);
    const z0 = k * sxy, z1 = (k + 1) * sxy;
    for (let j = 0; j < ny - 1; j++) {
      // A row with no bone in any of its four neighbouring lines can't produce triangles.
      const r = j + k * ny;
      if (rowMax[r] < iso && rowMax[r + 1] < iso && rowMax[r + ny] < iso && rowMax[r + ny + 1] < iso) continue;
      const row = j * nx;
      for (let i = 0; i < nx - 1; i++) {
        const a = row + i, b = a + nx;
        const v0 = data[z0 + a], v1 = data[z0 + a + 1], v2 = data[z0 + b + 1], v3 = data[z0 + b];
        const v4 = data[z1 + a], v5 = data[z1 + a + 1], v6 = data[z1 + b + 1], v7 = data[z1 + b];
        let c = 0;
        if (v0 < iso) c |= 1;
        if (v1 < iso) c |= 2;
        if (v2 < iso) c |= 4;
        if (v3 < iso) c |= 8;
        if (v4 < iso) c |= 16;
        if (v5 < iso) c |= 32;
        if (v6 < iso) c |= 64;
        if (v7 < iso) c |= 128;
        if (c === 0 || c === 255) continue;
        const mask = edgeTable[c];

        if (mask & 1) { const e = a; edgeV[0] = xe0[e] >= 0 ? xe0[e] : (xe0[e] = vertex(i, j, k, i + 1, j, k, v0, v1)); }
        if (mask & 2) { const e = a + 1; edgeV[1] = ye0[e] >= 0 ? ye0[e] : (ye0[e] = vertex(i + 1, j, k, i + 1, j + 1, k, v1, v2)); }
        if (mask & 4) { const e = b; edgeV[2] = xe0[e] >= 0 ? xe0[e] : (xe0[e] = vertex(i, j + 1, k, i + 1, j + 1, k, v3, v2)); }
        if (mask & 8) { const e = a; edgeV[3] = ye0[e] >= 0 ? ye0[e] : (ye0[e] = vertex(i, j, k, i, j + 1, k, v0, v3)); }
        if (mask & 16) { const e = a; edgeV[4] = xe1[e] >= 0 ? xe1[e] : (xe1[e] = vertex(i, j, k + 1, i + 1, j, k + 1, v4, v5)); }
        if (mask & 32) { const e = a + 1; edgeV[5] = ye1[e] >= 0 ? ye1[e] : (ye1[e] = vertex(i + 1, j, k + 1, i + 1, j + 1, k + 1, v5, v6)); }
        if (mask & 64) { const e = b; edgeV[6] = xe1[e] >= 0 ? xe1[e] : (xe1[e] = vertex(i, j + 1, k + 1, i + 1, j + 1, k + 1, v7, v6)); }
        if (mask & 128) { const e = a; edgeV[7] = ye1[e] >= 0 ? ye1[e] : (ye1[e] = vertex(i, j, k + 1, i, j + 1, k + 1, v4, v7)); }
        if (mask & 256) { const e = a; edgeV[8] = ze[e] >= 0 ? ze[e] : (ze[e] = vertex(i, j, k, i, j, k + 1, v0, v4)); }
        if (mask & 512) { const e = a + 1; edgeV[9] = ze[e] >= 0 ? ze[e] : (ze[e] = vertex(i + 1, j, k, i + 1, j, k + 1, v1, v5)); }
        if (mask & 1024) { const e = b + 1; edgeV[10] = ze[e] >= 0 ? ze[e] : (ze[e] = vertex(i + 1, j + 1, k, i + 1, j + 1, k + 1, v2, v6)); }
        if (mask & 2048) { const e = b; edgeV[11] = ze[e] >= 0 ? ze[e] : (ze[e] = vertex(i, j + 1, k, i, j + 1, k + 1, v3, v7)); }

        const t0 = c << 4;
        for (let t = 0; triTable[t0 + t] !== -1; t += 3) {
          tris.push3(edgeV[triTable[t0 + t]], edgeV[triTable[t0 + t + 1]], edgeV[triTable[t0 + t + 2]]);
        }
      }
    }
    // The top of this layer becomes the bottom of the next.
    [xe0, xe1] = [xe1, xe0];
    [ye0, ye1] = [ye1, ye0];
    xe1.fill(-1);
    ye1.fill(-1);
  }

  return finish(l, pos, grad, tris, iso, aoLevel);
}

function finish(l: Level, pos: Grow, grad: Grow, tris: GrowIndex, iso: number, ao: Level): MeshData {
  const count = pos.n / 3;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const { rowDir: rd, colDir: cd, sliceDir: sd, dx, dy, dz, positions: slicePos } = l;
  const p = pos.a, g = grad.a;

  const aoSx = ao.nx, aoSxy = ao.nx * ao.ny;
  const scaleXY = dx / ao.dx, scaleXYy = dy / ao.dy, scaleZ = (ao.nz - 1) / Math.max(1, l.nz - 1);
  const stepMm = Math.max(ao.dx, ao.dy, ao.dz);

  for (let v = 0; v < count; v++) {
    const n3 = v * 3;
    const fi = p[n3], fj = p[n3 + 1], fk = p[n3 + 2];
    const k0 = Math.min(Math.floor(fk), l.nz - 2), t = fk - k0;
    const px = slicePos[k0 * 3] + (slicePos[(k0 + 1) * 3] - slicePos[k0 * 3]) * t;
    const py = slicePos[k0 * 3 + 1] + (slicePos[(k0 + 1) * 3 + 1] - slicePos[k0 * 3 + 1]) * t;
    const pz = slicePos[k0 * 3 + 2] + (slicePos[(k0 + 1) * 3 + 2] - slicePos[k0 * 3 + 2]) * t;
    const ox = fi * dx, oy = fj * dy;
    positions[n3] = px + rd[0] * ox + cd[0] * oy;
    positions[n3 + 1] = py + rd[1] * ox + cd[1] * oy;
    positions[n3 + 2] = pz + rd[2] * ox + cd[2] * oy;

    // Bone is denser inside, so the outward normal points down the gradient.
    const gx = -g[n3] / dx, gy = -g[n3 + 1] / dy, gz = -g[n3 + 2] / dz;
    let nx = gx * rd[0] + gy * cd[0] + gz * sd[0];
    let ny = gx * rd[1] + gy * cd[1] + gz * sd[1];
    let nz = gx * rd[2] + gy * cd[2] + gz * sd[2];
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    normals[n3] = nx; normals[n3 + 1] = ny; normals[n3 + 2] = nz;

    // Occlusion: how much bone lies along the normal, read from a coarser copy of the scan.
    const gl = Math.hypot(gx, gy, gz) || 1;
    const ax = gx / gl, ay = gy / gl, az = gz / gl;
    const ai = fi * scaleXY, aj = fj * scaleXYy, ak = fk * scaleZ;
    let occ = 0;
    for (const [dist, weight] of AO_STEPS) {
      const mm = dist * stepMm * 0.75;
      const si = Math.round(ai + (ax * mm) / ao.dx), sj = Math.round(aj + (ay * mm) / ao.dy), sk = Math.round(ak + (az * mm) / ao.dz);
      if (si < 0 || sj < 0 || sk < 0 || si >= ao.nx || sj >= ao.ny || sk >= ao.nz) continue;
      const d = ao.data[si + sj * aoSx + sk * aoSxy];
      const soft = (d - iso + 150) / 300;
      occ += weight * (soft < 0 ? 0 : soft > 1 ? 1 : soft);
    }
    const shade = Math.max(0.3, 1 - 1.15 * occ);
    colors[n3] = shade;
    colors[n3 + 1] = shade * (0.965 + 0.035 * shade);
    colors[n3 + 2] = shade * (0.91 + 0.09 * shade);
  }
  const indices = tris.a.slice(0, tris.n);
  // A grid that is mirrored relative to patient space would otherwise turn every surface inside out.
  const det = rd[0] * (cd[1] * sd[2] - cd[2] * sd[1]) - rd[1] * (cd[0] * sd[2] - cd[2] * sd[0]) + rd[2] * (cd[0] * sd[1] - cd[1] * sd[0]);
  if (det < 0) {
    for (let n = 0; n < indices.length; n += 3) {
      const b = indices[n + 1];
      indices[n + 1] = indices[n + 2];
      indices[n + 2] = b;
    }
  }
  return { positions, normals, colors, indices };
}
