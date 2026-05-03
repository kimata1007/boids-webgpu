// Minimal column-major 4x4 matrix helpers for WebGPU.
// All matrices are stored as Float32Array(16) in column-major order, matching
// the layout WGSL expects for `mat4x4<f32>`.

export type Mat4 = Float32Array;
export type Vec3 = readonly [number, number, number];

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

// Right-handed perspective projection mapping z to [0, 1] for WebGPU clip space.
// fovY is in radians.
export function perspective(
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = far * nf;
  m[11] = -1;
  m[14] = far * near * nf;
  return m;
}

// Right-handed lookAt view matrix.
export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const zx = eye[0] - target[0];
  const zy = eye[1] - target[1];
  const zz = eye[2] - target[2];
  let zl = Math.hypot(zx, zy, zz);
  if (zl === 0) {
    zl = 1;
  }
  const fz0 = zx / zl;
  const fz1 = zy / zl;
  const fz2 = zz / zl;

  // x = normalize(cross(up, z))
  let xx = up[1] * fz2 - up[2] * fz1;
  let xy = up[2] * fz0 - up[0] * fz2;
  let xz = up[0] * fz1 - up[1] * fz0;
  let xl = Math.hypot(xx, xy, xz);
  if (xl === 0) {
    xx = 0;
    xy = 0;
    xz = 0;
  } else {
    xx /= xl;
    xy /= xl;
    xz /= xl;
  }

  // y = cross(z, x)
  const yx = fz1 * xz - fz2 * xy;
  const yy = fz2 * xx - fz0 * xz;
  const yz = fz0 * xy - fz1 * xx;

  const m = new Float32Array(16);
  m[0] = xx;
  m[1] = yx;
  m[2] = fz0;
  m[3] = 0;
  m[4] = xy;
  m[5] = yy;
  m[6] = fz1;
  m[7] = 0;
  m[8] = xz;
  m[9] = yz;
  m[10] = fz2;
  m[11] = 0;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(fz0 * eye[0] + fz1 * eye[1] + fz2 * eye[2]);
  m[15] = 1;
  return m;
}

// out = a * b, both column-major.
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

// In-place variant of multiply for hot loops where we want to avoid the
// per-call Float32Array allocation. Writes a*b into `out`. The output buffer
// must NOT alias either input, otherwise the result is undefined.
export function multiplyInto(out: Float32Array, a: Mat4, b: Mat4): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
}

// Build a 4x4 rotation matrix from a quaternion (xyzw). Standard expansion
// matching glTF's convention. Result is column-major.
export function fromQuat(q: readonly [number, number, number, number]): Mat4 {
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  const m = new Float32Array(16);
  // Column 0
  m[0] = 1 - 2 * (yy + zz);
  m[1] = 2 * (xy + wz);
  m[2] = 2 * (xz - wy);
  m[3] = 0;
  // Column 1
  m[4] = 2 * (xy - wz);
  m[5] = 1 - 2 * (xx + zz);
  m[6] = 2 * (yz + wx);
  m[7] = 0;
  // Column 2
  m[8] = 2 * (xz + wy);
  m[9] = 2 * (yz - wx);
  m[10] = 1 - 2 * (xx + yy);
  m[11] = 0;
  // Column 3
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return m;
}

// Compose a TRS (translation, rotation-quaternion-xyzw, scale) into a 4x4.
// Equivalent to T * R * S applied to a column vector.
export function composeTRS(
  t: readonly [number, number, number],
  r: readonly [number, number, number, number],
  s: readonly [number, number, number],
): Mat4 {
  const x = r[0];
  const y = r[1];
  const z = r[2];
  const w = r[3];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  const sx = s[0];
  const sy = s[1];
  const sz = s[2];

  const m = new Float32Array(16);
  // Each rotation column is multiplied by the matching scale factor (because
  // T * R * S, applied to a column vector, scales axes first then rotates).
  m[0] = (1 - 2 * (yy + zz)) * sx;
  m[1] = 2 * (xy + wz) * sx;
  m[2] = 2 * (xz - wy) * sx;
  m[3] = 0;

  m[4] = 2 * (xy - wz) * sy;
  m[5] = (1 - 2 * (xx + zz)) * sy;
  m[6] = 2 * (yz + wx) * sy;
  m[7] = 0;

  m[8] = 2 * (xz + wy) * sz;
  m[9] = 2 * (yz - wx) * sz;
  m[10] = (1 - 2 * (xx + yy)) * sz;
  m[11] = 0;

  m[12] = t[0];
  m[13] = t[1];
  m[14] = t[2];
  m[15] = 1;
  return m;
}

// Rotation about the X axis by `angleRadians`. Column-major.
export function rotationX(angleRadians: number): Mat4 {
  const c = Math.cos(angleRadians);
  const s = Math.sin(angleRadians);
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  m[15] = 1;
  return m;
}
