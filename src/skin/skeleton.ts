// Compute per-joint skinning matrices for a glTF skeleton.
//
// The skinning matrix uploaded to the GPU is `world * inverseBind`, where
// `world` is the joint's world-space transform after parent propagation and
// any per-joint overrides (currently just the wing bones). When the override
// is zero this collapses to the bind pose: `world` equals the joint's bind-
// time world transform, and `world * inverseBind` is identity, so the mesh
// stays exactly where the static PR3 path drew it.
//
// The joint array is assumed to be topologically sorted (parent before child)
// — the glTF loader takes care of that — so a single forward pass is enough.

import type { GltfSkeleton } from "../gltf/loader";
import { composeTRS, multiplyInto, rotationX } from "../lib/mat4";

export type WingOverride = {
  wingAngleRadians: number;
};

const WING_LEFT_NAME = "Wing_L";
const WING_RIGHT_NAME = "Wing_R";

// Reused per call to avoid allocating one Float32Array per joint per frame.
// Sized lazily on first use because the joint count is known only at runtime.
const scratch = {
  worldMatrices: null as Float32Array | null,
  local: new Float32Array(16),
  rotated: new Float32Array(16),
};

function ensureWorldBuffer(jointCount: number): Float32Array {
  const needed = jointCount * 16;
  if (scratch.worldMatrices === null || scratch.worldMatrices.length < needed) {
    scratch.worldMatrices = new Float32Array(needed);
  }
  return scratch.worldMatrices;
}

export function computeSkinningMatrices(
  skeleton: GltfSkeleton,
  override: WingOverride,
  out: Float32Array,
): void {
  const joints = skeleton.joints;
  const jointCount = joints.length;
  const worlds = ensureWorldBuffer(jointCount);
  const ibm = skeleton.inverseBindMatrices;

  for (let i = 0; i < jointCount; i++) {
    const joint = joints[i];
    let local = composeTRS(joint.translation, joint.rotation, joint.scale);

    // Wing override is applied in the joint's local frame (post-multiply),
    // so it composes with whatever rotation the bind pose already encodes.
    if (joint.name === WING_LEFT_NAME && override.wingAngleRadians !== 0) {
      const rx = rotationX(override.wingAngleRadians);
      const rotated = new Float32Array(16);
      multiplyInto(rotated, local, rx);
      local = rotated;
    } else if (
      joint.name === WING_RIGHT_NAME &&
      override.wingAngleRadians !== 0
    ) {
      const rx = rotationX(-override.wingAngleRadians);
      const rotated = new Float32Array(16);
      multiplyInto(rotated, local, rx);
      local = rotated;
    }

    // worldMatrix[i] = parent.world * local. Roots inherit identity so we
    // just copy local in.
    const worldOffset = i * 16;
    if (joint.parentIdx === -1) {
      worlds.set(local, worldOffset);
    } else {
      const parentOffset = joint.parentIdx * 16;
      const parent = worlds.subarray(parentOffset, parentOffset + 16);
      const world = worlds.subarray(worldOffset, worldOffset + 16);
      multiplyInto(world, parent, local);
    }

    // skinning[i] = world[i] * inverseBind[i]. Write directly into `out` to
    // avoid an extra copy.
    const world = worlds.subarray(worldOffset, worldOffset + 16);
    const ibmStart = i * 16;
    const ibmView = ibm.subarray(ibmStart, ibmStart + 16);
    const skinView = out.subarray(worldOffset, worldOffset + 16);
    multiplyInto(skinView, world, ibmView);
  }
}
