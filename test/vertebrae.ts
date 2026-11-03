import type { Vec3, Volume } from '../src/engine/types';
import type { SliceSpec } from './phantom';

/**
 * Generated test anatomy: three canine-style lumbar vertebrae and a scanner table, stored as a
 * CT-like Hounsfield volume. It is not anatomy from any patient.
 */
const H = 0.6, X0 = -40, Y0 = -22, Z0 = -46, NX = 134, NY = 106, NZ = 154;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smin = (a: number, b: number, k: number) => { const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1); return b + (a - b) * h - k * h * (1 - h); };
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);
const ell = (x: number, y: number, rx: number, ry: number) => (Math.sqrt((x / rx) ** 2 + (y / ry) ** 2) - 1) * Math.min(rx, ry);
const noise = (x: number, y: number, z: number) => Math.sin(0.9 * x + 1.3 * Math.sin(0.7 * y)) * Math.sin(1.1 * y + 1.7 * Math.sin(0.5 * z)) * Math.sin(0.8 * z + 1.2 * Math.sin(0.9 * x));

function capsule(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ra: number, rb: number) {
  const bax = bx - ax, bay = by - ay, baz = bz - az, pax = px - ax, pay = py - ay, paz = pz - az;
  const t = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  return Math.hypot(pax - bax * t, pay - bay * t, paz - baz * t) - (ra + (rb - ra) * t);
}
function box(px: number, py: number, pz: number, hx: number, hy: number, hz: number, r: number) {
  const qx = Math.abs(px) - hx + r, qy = Math.abs(py) - hy + r, qz = Math.abs(pz) - hz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

function vertebra(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const waist = 1 - 0.12 * (1 - (z / 11) ** 2);
  let body = smax(ell(x, y, 10.5 * waist, 7.2 * waist), Math.abs(z) - 11, 1.2);
  body = smax(body, y - 6.8, 1);

  let arch = smax(ell(x, y - 12.5, 10.5, 9.5), Math.abs(z + 0.5) - 8.5, 1);
  const spZ = z + (y - 24) * 0.28;
  arch = smin(arch, box(x, y - 27, spZ, 1.5, 8.2, 7 - (y - 20) * 0.1, 1), 2);
  arch = smin(arch, capsule(ax, y, z, 6.5, 17, -6, 7, 22, -9, 2.6, 2.1), 1.6);
  arch = smin(arch, Math.hypot(ax - 7, y - 22.4, z + 9.5) - 2.6, 1);
  arch = smin(arch, capsule(ax, y, z, 3.5, 19, 6, 3.8, 18.4, 10, 2.1, 1.8), 1.4);
  arch = smin(arch, capsule(ax, y, z, 10, 10, 6, 13, 8, 10, 1.3, 0.9), 1);
  arch = smax(arch, -ell(x, y - 13, 6.8, 5.8), 0.8);

  const transverse = capsule(ax, y * 2.3, z, 8, -2.3, 1, 31, -18.4, 8, 5.4, 3.2) * 0.62;
  let d = smin(smin(body, arch, 1.6), transverse, 2.2);
  d = smax(d, 5 - Math.hypot(ax - 11.5, y - 8, Math.abs(z) - 12.5), 0.8);
  const foramen = Math.max(Math.hypot(ax - 3, z - 1) - 0.75, -(y + 3));
  d = smax(d, -foramen, 0.25);
  return d + 0.2 * noise(x * 0.42, y * 0.42, z * 0.42) + 0.03 * noise(x * 1.6, y * 1.6, z * 1.6);
}

const VERTEBRAE = [
  { z: 26.4, scale: 1.03 },
  { z: 0, scale: 1 },
  { z: -26, scale: 0.97 },
];

export function buildVertebraeVolume(): Volume {
  const data = new Int16Array(NX * NY * NZ);
  const positions = new Float64Array(NZ * 3);
  // Stored with rows running from the top of the scanner down, the way real CT images are.
  const rowDir: Vec3 = [1, 0, 0], colDir: Vec3 = [0, -1, 0];
  const yTop = Y0 + (NY - 1) * H;

  for (let k = 0, n = 0; k < NZ; k++) {
    const z = Z0 + k * H;
    positions.set([X0, yTop, z], k * 3);
    for (let j = 0; j < NY; j++) {
      const y = yTop - j * H;
      for (let i = 0; i < NX; i++, n++) {
        const x = X0 + i * H;
        let d = Infinity;
        for (const v of VERTEBRAE) {
          const lz = (z - v.z) / v.scale;
          if (Math.abs(lz) > 20) continue;
          d = Math.min(d, vertebra(x / v.scale, y / v.scale, lz) * v.scale);
        }
        const vol = clamp(0.5 - d / 0.9, 0, 1);
        const cortex = clamp((d + 2.1) / 0.8, 0, 1);
        const cortical = 1160 + 130 * noise(x * 0.8, y * 0.8, z * 0.8);
        const cancellous = 470 + 150 * noise(x * 2.1, y * 2.1, z * 2.1);
        let hu = 40 + (cancellous + (cortical - cancellous) * cortex - 40) * vol;

        // The curved carbon table under the patient: thin, full length, and just bone-dense.
        const tableRadius = 110, tableY = -19 + tableRadius;
        const tableD = Math.abs(Math.hypot(x, y - tableY) - tableRadius) - 0.9;
        if (Math.abs(x) < 34) hu = Math.max(hu, 40 + 360 * clamp(0.5 - tableD / 0.8, 0, 1));
        data[n] = Math.round(hu);
      }
    }
  }
  return { nx: NX, ny: NY, nz: NZ, data, positions, rowDir, colDir, dx: H, dy: H };
}

/** The same vertebrae as a DICOM series, for loading through the page like a vet's own files. */
export function vertebraeSlices(): SliceSpec[] {
  const v = buildVertebraeVolume();
  return Array.from({ length: v.nz }, (_, k) => ({
    rows: v.ny,
    cols: v.nx,
    position: [...v.positions.subarray(k * 3, k * 3 + 3)],
    orientation: [...v.rowDir, ...v.colDir],
    pixelSpacing: [v.dy, v.dx] as [number, number],
    instance: k + 1,
    hu: (i: number, j: number) => v.data[(k * v.ny + j) * v.nx + i],
  }));
}
