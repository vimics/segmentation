import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { faceOn, poseOf, rolledUp, squaredUp, upFacing } from '../src/engine/viewer/orientation';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const FACES = [v(1, 0, 0), v(-1, 0, 0), v(0, 1, 0), v(0, -1, 0), v(0, 0, 1), v(0, 0, -1)];
const tilted = (deg: number) => {
  const a = THREE.MathUtils.degToRad(deg);
  return v(Math.sin(a), 0, Math.cos(a));
};

describe('looking straight at a face', () => {
  it('counts within 2° and not beyond', () => {
    expect(faceOn(v(0, 0, 1))?.toArray()).toEqual([0, 0, 1]);
    expect(faceOn(tilted(1.9))?.toArray()).toEqual([0, 0, 1]);
    expect(faceOn(tilted(2.1))).toBeNull();
    expect(faceOn(v(1, 1, 1))).toBeNull();
  });

  it.each(FACES.map((f) => [f.toArray().join(','), f] as const))('finds face %s', (_, face) => {
    expect(faceOn(face)?.toArray()).toEqual(face.toArray());
  });
});

describe('squaring up', () => {
  it.each(FACES.map((f) => [f.toArray().join(','), f] as const))('gives an axis square to face %s', (_, face) => {
    for (const up of [v(0.2, 0.9, 0.3), v(-0.7, 0.1, 0.7), v(0.4, -0.8, -0.4)]) {
      const u = squaredUp(face, up);
      expect(u.length()).toBeCloseTo(1);
      expect(Math.abs(u.dot(face))).toBeLessThan(1e-9);
      expect(Math.max(Math.abs(u.x), Math.abs(u.y), Math.abs(u.z))).toBeCloseTo(1);
    }
  });

  it('picks the axis nearest the current up', () => {
    expect(squaredUp(v(0, 0, 1), v(0.1, 0.9, 0)).toArray()).toEqual([0, 1, 0]);
    expect(squaredUp(v(0, 0, 1), v(-0.9, 0.2, 0)).toArray()).toEqual([-1, 0, 0]);
  });
});

describe('rolling', () => {
  it('turns exactly 90° each step and stays square to the view', () => {
    for (const face of FACES) for (const sign of [1, -1] as const) {
      const up = squaredUp(face, v(0.3, 0.5, 0.2));
      const next = rolledUp(face, up, sign);
      expect(next.length()).toBeCloseTo(1);
      expect(next.dot(up)).toBeCloseTo(0);
      expect(next.dot(face)).toBeCloseTo(0);
    }
  });

  it('comes back after four steps, and one step each way cancels out', () => {
    const face = v(0, 0, 1), start = v(0, 1, 0);
    let up = start.clone();
    for (let n = 0; n < 4; n++) up = rolledUp(face, up, 1);
    expect(up.distanceTo(start)).toBeCloseTo(0);
    expect(rolledUp(face, rolledUp(face, start, 1), -1).distanceTo(start)).toBeCloseTo(0);
  });

  it('turns what is on screen clockwise for a positive step', () => {
    // Looking down from +Z with +Y up, a point at the top of the screen should end on the right.
    const face = v(0, 0, 1), top = v(0, 1, 0);
    const up = rolledUp(face, top, 1);
    const right = new THREE.Vector3().crossVectors(up, face);
    expect(top.dot(right)).toBeCloseTo(1);
    expect(top.dot(up)).toBeCloseTo(0);
  });
});

describe('camera poses', () => {
  it('recovers the view direction and up from a pose', () => {
    const dir = v(0.6, 0.5, 0.8).normalize(), up = upFacing(dir, v(0, 1, 0));
    const q = poseOf(dir, up);
    expect(v(0, 0, 1).applyQuaternion(q).distanceTo(dir)).toBeCloseTo(0);
    expect(v(0, 1, 0).applyQuaternion(q).distanceTo(up)).toBeCloseTo(0);
  });

  it('removes any lean from up', () => {
    const dir = v(0, 0, 1);
    const up = upFacing(dir, v(0, 1, 1));
    expect(up.dot(dir)).toBeCloseTo(0);
    expect(up.length()).toBeCloseTo(1);
  });
});
