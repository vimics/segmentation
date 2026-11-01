import * as THREE from 'three';

const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([x, y, z]) => new THREE.Vector3(x, y, z));
const FACE_ON_COS = Math.cos(THREE.MathUtils.degToRad(2));

/** The axis being looked along, if the view is within 2° of one. `viewDir` points from the model to the camera. */
export function faceOn(viewDir: THREE.Vector3): THREE.Vector3 | null {
  const dir = viewDir.clone().normalize();
  return AXES.find((axis) => axis.dot(dir) >= FACE_ON_COS)?.clone() ?? null;
}

/** The axis closest to the current up that lies square to a face-on view, so the view's edges sit straight. */
export function squaredUp(axis: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
  let best = AXES[0], score = -Infinity;
  for (const candidate of AXES) {
    if (Math.abs(candidate.dot(axis)) > 0.5) continue;
    const s = candidate.dot(up);
    if (s > score) { best = candidate; score = s; }
  }
  return best.clone();
}

/** Up after a quarter turn. A positive sign turns what's on screen clockwise. */
export function rolledUp(viewDir: THREE.Vector3, up: THREE.Vector3, sign: 1 | -1): THREE.Vector3 {
  return new THREE.Vector3().crossVectors(viewDir, up).multiplyScalar(sign);
}

/** A camera orientation as one rotation, so direction and up can be animated together without flipping. */
export function poseOf(viewDir: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  const z = viewDir.clone().normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Up with any lean towards the view direction removed. */
export function upFacing(viewDir: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
  const dir = viewDir.clone().normalize();
  return up.clone().addScaledVector(dir, -up.dot(dir)).normalize();
}
