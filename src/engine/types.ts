export type Vec3 = [number, number, number];

/** Everything the viewer needs from one DICOM file, without its pixels. */
export interface SliceHeader {
  fileIndex: number;
  seriesUid: string;
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
  bboxMin: Vec3;
  bboxMax: Vec3;
}

export interface SurfaceResult {
  structures: StructureMesh[];
  triangles: number;
  specksRemoved: number;
  resolutionMm: number;
  iso: number;
  quality: 'preview' | 'full';
}
