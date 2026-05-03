// Time-based evaluator for parsed glTF animations.
//
// `applyAnimation` is the only entry point the render loop calls each frame:
// it walks every channel of the animation, interpolates the value at the
// requested time, and writes it back into the corresponding joint's TRS. The
// skeleton's joint array is mutated in place because PR4's skinning pass
// reads `joint.translation/rotation/scale` directly when composing the local
// matrix.
//
// Only LINEAR and STEP samplers are supported; the loader rejects CUBICSPLINE
// up front so we never see one here.

import type {
  Animation,
  AnimationChannel,
  GltfSkeleton,
} from "../gltf/loader";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

// Returns the largest `i` such that `times[i] <= t`, clamped so `i + 1` is
// still in range. Caller is responsible for clamping `t` to the channel's
// time range first if it cares about boundary behaviour.
//
// Linear search is fine here: our pigeon has at most 24 keyframes per
// channel, and the search cost is dwarfed by the matrix work that follows.
export function findInterval(times: Float32Array, t: number): number {
  const n = times.length;
  if (n <= 1) return 0;
  if (t <= times[0]) return 0;
  if (t >= times[n - 1]) return n - 2;
  for (let i = 0; i < n - 1; i++) {
    if (t >= times[i] && t < times[i + 1]) return i;
  }
  return n - 2;
}

export function vec3Lerp(a: Vec3, b: Vec3, u: number): Vec3 {
  const inv = 1 - u;
  return [a[0] * inv + b[0] * u, a[1] * inv + b[1] * u, a[2] * inv + b[2] * u];
}

// Spherical linear interpolation with shortest-path correction. Falls back to
// a normalized lerp when the angle between the two quaternions is tiny (where
// slerp is numerically unstable but lerp is indistinguishable from it).
export function quatSlerp(a: Quat, b: Quat, u: number): Quat {
  let bx = b[0];
  let by = b[1];
  let bz = b[2];
  let bw = b[3];
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  // Pick the shorter arc by flipping `b` when the angle exceeds 90 degrees.
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  // Quaternions are nearly identical -> normalized lerp keeps things stable
  // and matches the slerp result to several decimal places.
  if (dot > 0.9995) {
    const x = a[0] + (bx - a[0]) * u;
    const y = a[1] + (by - a[1]) * u;
    const z = a[2] + (bz - a[2]) * u;
    const w = a[3] + (bw - a[3]) * u;
    return normalizeQuat(x, y, z, w);
  }
  const theta0 = Math.acos(Math.min(Math.max(dot, -1), 1));
  const sin0 = Math.sin(theta0);
  const theta = theta0 * u;
  const sin = Math.sin(theta);
  const s0 = Math.cos(theta) - (dot * sin) / sin0;
  const s1 = sin / sin0;
  const x = s0 * a[0] + s1 * bx;
  const y = s0 * a[1] + s1 * by;
  const z = s0 * a[2] + s1 * bz;
  const w = s0 * a[3] + s1 * bw;
  // Defend against drift; the math is theoretically unit-length but float
  // rounding can leak a few ulps over many frames.
  return normalizeQuat(x, y, z, w);
}

function normalizeQuat(x: number, y: number, z: number, w: number): Quat {
  const len = Math.hypot(x, y, z, w);
  if (len === 0) return [0, 0, 0, 1];
  const inv = 1 / len;
  return [x * inv, y * inv, z * inv, w * inv];
}

// Evaluate a single channel at time `t`. Returns 3 floats for translation /
// scale, 4 floats for rotation. The time is *not* wrapped here; the caller
// (`applyAnimation`) wraps it once at the animation level.
export function sampleChannel(
  channel: AnimationChannel,
  t: number,
): number[] {
  const stride = channel.path === "rotation" ? 4 : 3;
  const times = channel.times;
  const values = channel.values;
  const n = times.length;
  if (n === 0) {
    // No keyframes means we have nothing useful to write back. Return a sane
    // identity so the caller does not have to special-case it.
    return channel.path === "rotation" ? [0, 0, 0, 1] : [0, 0, 0];
  }
  if (n === 1 || t <= times[0]) {
    return readKeyframe(values, 0, stride);
  }
  if (t >= times[n - 1]) {
    return readKeyframe(values, n - 1, stride);
  }
  const i = findInterval(times, t);
  const t0 = times[i];
  const t1 = times[i + 1];
  const span = t1 - t0;
  // span should always be > 0 because times are monotonic, but guard anyway.
  const u = span > 0 ? (t - t0) / span : 0;

  if (channel.interpolation === "STEP") {
    return readKeyframe(values, i, stride);
  }
  // LINEAR
  if (channel.path === "rotation") {
    const a: Quat = [
      values[i * 4 + 0],
      values[i * 4 + 1],
      values[i * 4 + 2],
      values[i * 4 + 3],
    ];
    const b: Quat = [
      values[(i + 1) * 4 + 0],
      values[(i + 1) * 4 + 1],
      values[(i + 1) * 4 + 2],
      values[(i + 1) * 4 + 3],
    ];
    return quatSlerp(a, b, u);
  }
  const a: Vec3 = [
    values[i * 3 + 0],
    values[i * 3 + 1],
    values[i * 3 + 2],
  ];
  const b: Vec3 = [
    values[(i + 1) * 3 + 0],
    values[(i + 1) * 3 + 1],
    values[(i + 1) * 3 + 2],
  ];
  return vec3Lerp(a, b, u);
}

function readKeyframe(
  values: Float32Array,
  index: number,
  stride: number,
): number[] {
  const start = index * stride;
  const out = new Array<number>(stride);
  for (let k = 0; k < stride; k++) {
    out[k] = values[start + k];
  }
  return out;
}

// Mutate every channel's target joint TRS at time `tSeconds`, modulo the
// animation's duration so playback loops cleanly. Joints whose channels did
// not appear in the animation keep whatever TRS they currently hold (which
// for our pigeon is the bind pose values loaded from the glTF).
export function applyAnimation(
  skeleton: GltfSkeleton,
  animation: Animation,
  tSeconds: number,
): void {
  const duration = animation.duration;
  // Avoid divide-by-zero: a zero-length animation collapses to "always show
  // the first keyframe".
  const t = duration > 0 ? wrap(tSeconds, duration) : 0;

  const joints = skeleton.joints;
  for (const channel of animation.channels) {
    if (channel.jointIndex < 0 || channel.jointIndex >= joints.length) {
      continue;
    }
    const joint = joints[channel.jointIndex];
    const sample = sampleChannel(channel, t);
    if (channel.path === "rotation") {
      joint.rotation = [sample[0], sample[1], sample[2], sample[3]];
    } else if (channel.path === "translation") {
      joint.translation = [sample[0], sample[1], sample[2]];
    } else {
      // scale
      joint.scale = [sample[0], sample[1], sample[2]];
    }
  }
}

// `n % d` in JS keeps the sign of `n`, so for negative times (clock skew on
// startup, paused offsets, etc.) we want a always-positive remainder. This
// keeps animation indexing consistent regardless of clock weirdness.
function wrap(n: number, d: number): number {
  const r = n % d;
  return r < 0 ? r + d : r;
}
