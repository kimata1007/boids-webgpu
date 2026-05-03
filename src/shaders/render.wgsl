struct ViewUniform {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  maxSpeed: f32,
  time: f32,
  _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> view: ViewUniform;
@group(0) @binding(1) var<storage, read> jointMatrices: array<mat4x4<f32>>;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
}

// PR4: linear-blend skinning. Each vertex carries up to four joint indices
// (uint8x4, widened to vec4<u32> by the WebGPU vertex stage) and matching
// floating-point weights. The blended skinning matrix `m` deforms the vertex
// in the model's bone space; `view.model` then places the whole pigeon in
// world space. When the per-joint TRS still matches the bind pose, `m`
// collapses to identity for every vertex, so the bind pose matches the
// static PR3 render exactly. PR5 drives the TRS from a baked animation.
@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) joints: vec4<u32>,
  @location(3) weights: vec4<f32>,
) -> VSOut {
  let p = vec4<f32>(position, 1.0);
  let n = vec4<f32>(normal, 0.0);

  let m =
    jointMatrices[joints.x] * weights.x +
    jointMatrices[joints.y] * weights.y +
    jointMatrices[joints.z] * weights.z +
    jointMatrices[joints.w] * weights.w;

  let skinnedPos = m * p;
  let skinnedNorm = m * n;

  let world4 = view.model * skinnedPos;
  // Treat model as a rigid + uniform-scale transform; passing w=0 drops the
  // translation column. PR4 still uses identity-scale-translation for the
  // model placement, so we do not need a proper inverse-transpose normal
  // matrix yet.
  let normalWorld = (view.model * vec4<f32>(skinnedNorm.xyz, 0.0)).xyz;

  var out: VSOut;
  out.clip = view.mvp * world4;
  out.normal = normalize(normalWorld);
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.3, 1.0, 0.5));
  let n = normalize(in.normal);
  let diffuse = max(dot(n, lightDir), 0.0);
  let pigeonGray = vec3<f32>(0.78, 0.79, 0.82);
  let color = pigeonGray * (0.25 + 0.75 * diffuse);
  return vec4<f32>(color, 1.0);
}
