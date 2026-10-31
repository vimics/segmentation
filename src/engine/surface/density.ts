import type { FilterFamily, Volume } from '../types';

/** Starts above -200, the value demo files flatten air to, so flattened air never counts as tissue. */
const BIN = 50, LOW = -150, HIGH = 2000;
const SAMPLE_VOXELS = 2_000_000;

export const STANDARD_THRESHOLD = 250;
/** Sharp filters overshoot at tissue edges, which turns skin and fat into thin shells at 250. */
const SHARP_FILTER_THRESHOLD = 500;
/** Soft tissue sits near 50 HU on a calibrated scanner. Well above this, the scale itself is off. */
const OFFSET_SCALE_PEAK = 400;
/** Bone above the soft tissue peak, measured on a cone-beam scan. */
const BONE_ABOVE_TISSUE = 900;
const MAX_THRESHOLD = 3000;

export interface DensityProfile {
  /** Most common density between air and dense bone, normally soft tissue */
  tissuePeak: number;
  /** The scan's values are not on the usual Hounsfield scale, as often happens on cone-beam scanners */
  offsetScale: boolean;
}

export function profileDensity(volume: Volume): DensityProfile {
  const counts = new Uint32Array(Math.ceil((HIGH - LOW) / BIN));
  const { data } = volume;
  // An odd stride, so sampling doesn't line up with the rows of the image.
  const stride = Math.max(1, Math.floor(data.length / SAMPLE_VOXELS)) | 1;
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (v >= LOW && v < HIGH) counts[(v - LOW) / BIN | 0]++;
  }
  let peak = 0;
  for (let b = 1; b < counts.length; b++) if (counts[b] > counts[peak]) peak = b;
  const tissuePeak = LOW + peak * BIN;

  const share = (from: number, to: number) => {
    let n = 0;
    for (let b = Math.max(0, (from - LOW) / BIN | 0); b < counts.length && LOW + b * BIN < to; b++) n += counts[b];
    return n;
  };
  // A crop that is mostly bone also peaks high, but it still has plenty of normal tissue around 0 HU.
  const offsetScale = tissuePeak > OFFSET_SCALE_PEAK && share(tissuePeak - 150, tissuePeak + 150) > 2 * share(-150, 150);
  return { tissuePeak, offsetScale };
}

/** Where the threshold starts. It stays a starting point: the slider is always there. */
export function startingThreshold(profile: DensityProfile, filter: FilterFamily): number {
  if (profile.offsetScale) return Math.min(MAX_THRESHOLD, profile.tissuePeak + BONE_ABOVE_TISSUE);
  return filter === 'bone' ? SHARP_FILTER_THRESHOLD : STANDARD_THRESHOLD;
}

export function thresholdPresets(start: number, profile: DensityProfile): [number, number, number] {
  if (!profile.offsetScale) return [start, 700, 1100];
  return [start, Math.min(MAX_THRESHOLD, start + 400), Math.min(MAX_THRESHOLD, start + 800)];
}
