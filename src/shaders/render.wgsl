struct ViewUniform {
  mvp: mat4x4<f32>,
  model: mat4x4<f32>,
  maxSpeed: f32,
  time: f32,
  _pad0: vec2<f32>,
}

@group(0) @binding(0) var<uniform> view: ViewUniform;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
}

// PR3: render a single static glTF mesh. The vertex stream comes from a
// vertex buffer (position + normal interleaved). The compute pass still
// runs the boid simulation in the background, but we draw a single
// instance of this mesh while we wire skinning up in PR4+.
@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
) -> VSOut {
  let world4 = view.model * vec4<f32>(position, 1.0);
  // Treat model as a rigid + uniform-scale transform; passing w=0 is enough
  // to drop translation. PR3 only uses identity-scale-translation so we do
  // not need a proper inverse-transpose normal matrix yet.
  let normalWorld = (view.model * vec4<f32>(normal, 0.0)).xyz;

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
