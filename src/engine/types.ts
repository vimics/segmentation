import type { HuRange } from './hu';

export type Vec3 = [number, number, number];

/** Everything the viewer needs from one DICOM file, without its pixels. */
export interface SliceHeader {
  fileIndex: number;
  seriesUid: string;
  studyUid: string;
  /** Hash of the patient fields, only for telling two patients apart */
  patientKey: string;
  acquisition: string;
  temporal: string;
  contrast: boolean;
  modality: string;
  imageType: string[];
  seriesDescription: string;
  kernel: string;
  rows: number;
  cols: number;
  /** [spacing between rows, spacing between columns], in mm */
  pixelSpacing: [number, number] | null;
  orientation: number[] | null;
  position: Vec3 | null;
  thickness: number | null;
  instanceNumber: number;
  bitsAllocated: number;
  bitsStored: number;
  pixelRepresentation: number;
  samplesPerPixel: number;
  rescaleSlope: number;
  rescaleIntercept: number;
  transferSyntax: string;
  frames: number;
  species: string;
  breed: string;
  studyDate: string;
  manufacturer: string;
  model: string;
  burnedIn: boolean;
}

export type Plane = 'axial' | 'sagittal' | 'coronal' | 'oblique';
export type FilterFamily = 'bone' | 'soft' | 'lung' | 'unknown';

export interface SeriesInfo {
  id: string;
  description: string;
  kernel: string;
  modality: string;
  /** Sorted along the slice normal once the series is usable. */
  slices: SliceHeader[];
  usable: boolean;
  /** Why the series can't be used, in plain words. */
  reason?: string;
  warnings: string[];
  rows: number;
  cols: number;
  /** Median distance between slices, in mm */
  sliceSpacing: number;
  /** Length of the stack along the slice normal, in mm */
  coverageMm: number;
  plane: Plane;
  /** Rebuilt from another series, rather than reconstructed from the raw scan data */
  reformat: boolean;
  filter: FilterFamily;
  thickness: number | null;
  pixelSpacing: [number, number] | null;
  rowDir: Vec3;
  colDir: Vec3;
  burnedIn: boolean;
}

/** A CT volume in Hounsfield units, addressed as data[i + j*nx + k*nx*ny]. */
export interface Volume {
  nx: number;
  ny: number;
  nz: number;
  data: Int16Array;
  /** Patient-space position of voxel (0,0,k), three numbers per slice */
  positions: Float64Array;
  rowDir: Vec3;
  colDir: Vec3;
  /** mm between columns (along rowDir) */
  dx: number;
  /** mm between rows (along colDir) */
  dy: number;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface StructureMesh extends MeshData {
  volumeMm3: number;
  autoHidden: boolean;
  /** Which filter covers it, if any */
  hiddenAs: 'table' | 'fragment' | 'shell' | null;
  /** Has its own mesh, so it can be listed and hidden on its own */
  listed: boolean;
  bboxMin: Vec3;
  bboxMax: Vec3;
}

export interface SurfaceResult {
  structures: StructureMesh[];
  triangles: number;
  /** Pieces under 8 mm³, counted whether or not their geometry was kept */
  shellCount: number;
  /** Thin fragments, the table included */
  fragmentCount: number;
  boneCount: number;
  resolutionMm: number;
  range: HuRange;
  quality: 'preview' | 'full';
}
