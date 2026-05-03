// Compute per-joint skinning matrices for a glTF skeleton.
//
// The skinning matrix uploaded to the GPU is `world * inverseBind`, where
// `world` is the joint's world-space transform after parent propagation. The
// joint's local TRS is read straight off the joint struct, so any external
// system (PR5's animation sampler, future IK passes, etc.) can drive motion
// just by mutating `joint.translation/rotation/scale` before calling this.
//
// When the TRS values still match the bind pose, `world` equals the joint's
// bind-time world transform, so `world * inverseBind` collapses to identity
// and the mesh draws exactly where the static PR3 path placed it.
//
// The joint array is assumed to be topologically sorted (parent before
// child) — the glTF loader takes care of that — so a single forward pass is
// enough to propagate transforms.

import type { GltfSkeleton } from "../gltf/loader";
import { composeTRS, multiplyInto } from "../lib/mat4";

// Reused per call to avoid allocating one Float32Array per joint per frame.
// Sized lazily on first use because the joint count is known only at runtime.
const scratch = {
  worldMatrices: null as Float32Array | null,
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
  out: Float32Array,
): void {
  const joints = skeleton.joints;
  const jointCount = joints.length;
  const worlds = ensureWorldBuffer(jointCount);
  const ibm = skeleton.inverseBindMatrices;

  for (let i = 0; i < jointCount; i++) {
    const joint = joints[i];
    const local = composeTRS(joint.translation, joint.rotation, joint.scale);

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
