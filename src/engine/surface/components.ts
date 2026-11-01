import type { MeshData, StructureMesh, Vec3 } from '../types';

/** Pieces of each kind that keep their own mesh, so they can be listed and hidden one by one. */
export const MAX_LISTED = 50;
const MIN_STRUCTURE_MM3 = 8;
const MAX_CAVITY_HOMES = 500;

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

/** Pieces that end up in one mesh: a single listed piece, or everything beyond the list. */
interface Bucket {
  groups: Group[];
  hiddenAs: StructureMesh['hiddenAs'];
  listed: boolean;
}

export interface SplitResult {
  structures: StructureMesh[];
  shellCount: number;
  fragmentCount: number;
  boneCount: number;
}

/**
 * Splits a surface into connected pieces. Connectivity follows the mesh, so memory grows with
 * the surface and not with the scan. Cavities (inward-facing shells) stay with the piece that
 * contains them, so clipping still shows hollow bone correctly. Shells are discarded unless asked for,
 * and then share one mesh, so even tens of thousands of them cost one draw call.
 */
export function splitStructures(mesh: MeshData, extent: { lengthMm: number }, opts: { keepShells?: boolean } = {}): SplitResult {
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

  const pieces = solids.filter((g) => g.signedVolume >= MIN_STRUCTURE_MM3);
  const shells = solids.filter((g) => g.signedVolume < MIN_STRUCTURE_MM3);

  // Noisy scans can hold huge numbers of pieces, and only the largest are likely to contain cavities.
  const homes = pieces.slice(0, MAX_CAVITY_HOMES);
  const orphans: Group[] = [];
  for (const cavity of cavities) {
    const home = homes.find((g) => g.min.every((m, d) => m <= cavity.min[d]) && g.max.every((m, d) => m >= cavity.max[d]));
    if (home) home.children.push(cavity); else orphans.push(cavity);
  }

  const withCavities = (g: Group) => g.children.reduce((sum, c) => sum + c.signedVolume, g.signedVolume);
  const hiddenAsOf = (g: Group): StructureMesh['hiddenAs'] => {
    const volumeMm3 = withCavities(g);
    return looksLikeTable(g, volumeMm3, extent.lengthMm) ? 'table' : looksLikeFragment(g, volumeMm3) ? 'fragment' : null;
  };
  const kinds = new Map(pieces.map((g) => [g, hiddenAsOf(g)]));
  const bones = pieces.filter((g) => kinds.get(g) === null);
  const fragments = pieces.filter((g) => kinds.get(g) !== null);

  // The largest pieces of each kind stay separate. The rest share one mesh, so nothing is lost to a cap.
  const buckets: Bucket[] = [];
  const addLayer = (list: Group[], hiddenAs: (g: Group) => StructureMesh['hiddenAs'], merged: StructureMesh['hiddenAs']) => {
    for (const g of list.slice(0, MAX_LISTED)) buckets.push({ groups: [g], hiddenAs: hiddenAs(g), listed: true });
    if (list.length > MAX_LISTED) buckets.push({ groups: list.slice(MAX_LISTED), hiddenAs: merged, listed: false });
  };
  addLayer(bones, () => null, null);
  addLayer(fragments, (g) => kinds.get(g) ?? 'fragment', 'fragment');
  if (opts.keepShells && (shells.length || orphans.length)) buckets.push({ groups: [...shells, ...orphans], hiddenAs: 'shell', listed: false });

  const owner = new Map<number, number>();
  buckets.forEach((bucket, b) => {
    for (const g of bucket.groups) {
      owner.set(g.root, b);
      for (const c of g.children) owner.set(c.root, b);
    }
  });

  const triLists: number[][] = buckets.map(() => []);
  const vertexLists: number[][] = buckets.map(() => []);
  const localIndex = new Int32Array(vertexCount).fill(-1);
  for (let n = 0; n < t.length; n += 3) {
    const b = owner.get(find(t[n]));
    if (b === undefined) continue;
    const list = triLists[b], verts = vertexLists[b];
    for (let c = 0; c < 3; c++) {
      const v = t[n + c];
      if (localIndex[v] < 0) { localIndex[v] = verts.length; verts.push(v); }
      list.push(localIndex[v]);
    }
  }

  const structures = buckets.map((bucket, b): StructureMesh => {
    const verts = vertexLists[b];
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
    const bboxMin: Vec3 = [Infinity, Infinity, Infinity], bboxMax: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const g of bucket.groups) for (let d = 0; d < 3; d++) {
      if (g.min[d] < bboxMin[d]) bboxMin[d] = g.min[d];
      if (g.max[d] > bboxMax[d]) bboxMax[d] = g.max[d];
    }
    return {
      positions, normals, colors,
      indices: Uint32Array.from(triLists[b]),
      volumeMm3: bucket.groups.reduce((sum, g) => sum + withCavities(g), 0),
      autoHidden: bucket.hiddenAs !== null,
      hiddenAs: bucket.hiddenAs,
      listed: bucket.listed,
      bboxMin,
      bboxMax,
    };
  });

  return { structures, shellCount: shells.length, fragmentCount: fragments.length, boneCount: bones.length };
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
