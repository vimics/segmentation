/** Every scan is capped to this range when decoded, so all cases share one scale and one slider. */
export const HU_MIN = -1024;
export const HU_MAX = 4000;

export interface HuRange { min: number; max: number; }

/** Where the threshold starts on every scan. Nothing is adjusted per scan: the vet moves the selector. */
export const BONE_RANGE: HuRange = { min: 226, max: 1988 };
