import type { MeshData, StructureMesh, Vec3 } from '../types';

export const MAX_STRUCTURES = 60;
const MIN_STRUCTURE_MM3 = 8;

function signedTetra(p: Float32Array, a: number, b: number, c: number): number {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
  const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
  return (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
}

interface Group {
  root: number;
  triangles: number;
  signedVolume: number;
  area: number;
  min: Vec3;
  max: Vec3;
  /** Cavities inside this structure */
  children: Group[];
}

/**
 * Splits a surface into connected pieces. Connectivity follows the mesh, so memory grows with
 * the surface and not with the scan. Cavities (inward-facing shells) stay with the piece that
 * contains them, so clipping still shows hollow bone correctly.
 */
export function splitStructures(mesh: MeshData, extent: { lengthMm: number }): { structures: StructureMesh[]; specksRemoved: number } {
  const { positions: p, indices: t } = mesh;
  const vertexCount = p.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let n = 0; n < t.length; n += 3) {
    const a = find(t[n]), b = find(t[n + 1]), c = find(t[n + 2]);
    if (a !== b) parent[b] = a;
    const r = find(a);
    if (r !== c) parent[c] = r;
  }

  const groups = new Map<number, Group>();
  for (let n = 0; n < t.length; n += 3) {
    const a = t[n], b = t[n + 1], c = t[n + 2], root = find(a);
    let g = groups.get(root);
    if (!g) {
      g = { root, triangles: 0, signedVolume: 0, area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], children: [] };
      groups.set(root, g);
    }
    g.triangles++;
    g.signedVolume += signedTetra(p, a, b, c);
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    g.area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    for (const v of [a, b, c]) for (let d = 0; d < 3; d++) {
      const value = p[v * 3 + d];
      if (value < g.min[d]) g.min[d] = value;
      if (value > g.max[d]) g.max[d] = value;
    }
  }

  const all = [...groups.values()];
  const solids = all.filter((g) => g.signedVolume > 0).sort((a, b) => b.signedVolume - a.signedVolume);
  const cavities = all.filter((g) => g.signedVolume <= 0);

  const kept = solids.filter((g) => g.signedVolume >= MIN_STRUCTURE_MM3).slice(0, MAX_STRUCTURES);
  const specksRemoved = solids.length - kept.length;

  for (const cavity of cavities) {
    const home = kept.find((g) => g.min.every((m, d) => m <= cavity.min[d]) && g.max.every((m, d) => m >= cavity.max[d]));
    if (home) home.children.push(cavity);
  }

  const owner = new Map<number, Group>();
  for (const g of kept) {
    owner.set(g.root, g);
    for (const c of g.children) owner.set(c.root, g);
  }

  const triLists = new Map<Group, number[]>();
  const remap = new Map<Group, Int32Array>();
  const vertexLists = new Map<Group, number[]>();
  for (const g of kept) { triLists.set(g, []); vertexLists.set(g, []); remap.set(g, new Int32Array(0)); }

  const localIndex = new Int32Array(vertexCount).fill(-1);
  for (let n = 0; n < t.length; n += 3) {
    const g = owner.get(find(t[n]));
    if (!g) continue;
    const list = triLists.get(g) as number[], verts = vertexLists.get(g) as number[];
    for (let c = 0; c < 3; c++) {
      const v = t[n + c];
      if (localIndex[v] < 0) { localIndex[v] = verts.length; verts.push(v); }
      list.push(localIndex[v]);
    }
  }

  const structures = kept.map((g): StructureMesh => {
    const verts = vertexLists.get(g) as number[];
    const positions = new Float32Array(verts.length * 3);
    const normals = new Float32Array(verts.length * 3);
    const colors = new Float32Array(verts.length * 3);
    verts.forEach((v, i) => {
      for (let d = 0; d < 3; d++) {
        positions[i * 3 + d] = p[v * 3 + d];
        normals[i * 3 + d] = mesh.normals[v * 3 + d];
        colors[i * 3 + d] = mesh.colors[v * 3 + d];
      }
    });
    const volumeMm3 = g.children.reduce((sum, c) => sum + c.signedVolume, g.signedVolume);
    const hiddenAs = looksLikeTable(g, volumeMm3, extent.lengthMm) ? 'table' as const : looksLikeFragment(g, volumeMm3) ? 'fragment' as const : null;
    return {
      positions, normals, colors,
      indices: Uint32Array.from(triLists.get(g) as number[]),
      volumeMm3,
      autoHidden: hiddenAs !== null,
      hiddenAs,
      bboxMin: g.min,
      bboxMax: g.max,
    };
  });

  // If everything looks like a table, the guess is wrong; show what there is.
  if (structures.length && structures.every((s) => s.autoHidden)) for (const s of structures) { s.autoHidden = false; s.hiddenAs = null; }
  // Hidden guesses go last, so the list starts with the bones.
  structures.sort((x, y) => Number(x.autoHidden) - Number(y.autoHidden));
  return { structures, specksRemoved };
}

/**
 * Mean thickness below which a piece is a skin of noise, not bone. On real scans table pieces, tubing and noise
 * measured 0.1 to 0.5 mm, and the smallest real bones 0.8 mm or more.
 */
const FRAGMENT_THICKNESS_MM = 0.5;

function looksLikeFragment(g: Group, volumeMm3: number): boolean {
  const area = g.children.reduce((sum, c) => sum + c.area, g.area);
  return area > 0 && (2 * volumeMm3) / area < FRAGMENT_THICKNESS_MM;
}

/** A CT table is a thin shell running the full length of the scan. Bones are thicker or shorter. */
function looksLikeTable(g: Group, volumeMm3: number, lengthMm: number): boolean {
  const sizes = [g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]].sort((a, b) => b - a);
  const meanThickness = g.area > 0 ? (2 * volumeMm3) / g.area : 0;
  return sizes[0] >= lengthMm * 0.8 && sizes[1] > 0 && meanThickness < 3.2 && sizes[2] < sizes[1] * 0.75;
}
