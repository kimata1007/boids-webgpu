// PR6: Vertex Animation Texture (VAT) skinning replacement.
//
// Each pigeon's per-frame deformed positions live in a 2D texture
// (`vatTexture`) sized [vertexCount, numFrames]. The vertex shader looks
// up the local-space position by `vertex_index`, blends the two adjacent
// time frames, and then transforms the result into the per-instance
// world frame derived from the boid's velocity. The vertex buffer no
// longer carries positions, joints, or weights — only the bind-pose
// normal, which is approximated as constant across the flap cycle.

struct Boid {
  pos: vec4<f32>,
  vel: vec4<f32>,
}

struct ViewUniform {
  mvp: mat4x4<f32>,
  maxSpeed: f32,
  time: f32,
  numFrames: f32,
  duration: f32,
}

@group(0) @binding(0) var<uniform> view: ViewUniform;
@group(0) @binding(1) var<storage, read> boids: array<Boid>;
@group(0) @binding(2) var vatTexture: texture_2d<f32>;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) speed: f32,
}

// Pigeon model is authored in glTF units (~1.6m tall). The boid sim
// volume has half-extents of order ~1, so we shrink the model so 8000
// pigeons fit comfortably inside the view.
const PIGEON_SCALE: f32 = 0.04;

@vertex
fn vs_main(
  @location(0) bindNormal: vec3<f32>,
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) iid: u32,
) -> VSOut {
  // Per-instance phase offset desynchronises the flock so the wings do
  // not all flap in lockstep. 0.137 is an arbitrary irrational-ish
  // multiplier — small enough to avoid aliasing across nearby ids.
  let phaseOffset = f32(iid) * 0.137;
  let phase = fract(view.time / view.duration + phaseOffset);
  let frameF = phase * view.numFrames;
  let f0 = u32(floor(frameF)) % u32(view.numFrames);
  let f1 = (f0 + 1u) % u32(view.numFrames);
  let alpha = fract(frameF);

  let pos0 = textureLoad(vatTexture, vec2<u32>(vid, f0), 0).xyz;
  let pos1 = textureLoad(vatTexture, vec2<u32>(vid, f1), 0).xyz;
  let localPos = mix(pos0, pos1, alpha);

  // Build a per-instance orthonormal frame from the boid's velocity.
  // Forward = velocity direction, world up = (0,1,0).
  let b = boids[iid];
  let velXyz = b.vel.xyz;
  let speed = length(velXyz);
  var forward = vec3<f32>(0.0, 0.0, 1.0);
  if (speed > 0.0001) {
    forward = velXyz / speed;
  }
  let worldUp = vec3<f32>(0.0, 1.0, 0.0);
  var right = cross(worldUp, forward);
  let rl = length(right);
  if (rl < 0.0001) {
    // Velocity is parallel to world up; fall back to a stable axis.
    right = vec3<f32>(1.0, 0.0, 0.0);
  } else {
    right = right / rl;
  }
  let realUp = cross(forward, right);

  // Pigeon body axes in glTF space:
  //   +X = forward (head), +Y = lateral (wing tips), +Z = up.
  // Our world frame uses (right, realUp, forward), so we swap accordingly.
  let world =
    b.pos.xyz +
    forward * (localPos.x * PIGEON_SCALE) +
    right   * (localPos.y * PIGEON_SCALE) +
    realUp  * (localPos.z * PIGEON_SCALE);

  // Rotate the bind-pose normal into the same per-instance frame.
  let nWorld =
    forward * bindNormal.x +
    right   * bindNormal.y +
    realUp  * bindNormal.z;

  var out: VSOut;
  out.clip = view.mvp * vec4<f32>(world, 1.0);
  out.normal = normalize(nWorld);
  out.speed = speed;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let lightDir = normalize(vec3<f32>(0.3, 1.0, 0.5));
  let n = normalize(in.normal);
  let diffuse = max(dot(n, lightDir), 0.0);
  let baseGray = vec3<f32>(0.78, 0.79, 0.82);
  let warmTint = vec3<f32>(0.95, 0.78, 0.62);
  let t = clamp(in.speed / max(view.maxSpeed, 0.0001), 0.0, 1.0);
  let body = mix(baseGray, warmTint, t * 0.3);
  let lit = body * (0.30 + 0.70 * diffuse);
  return vec4<f32>(lit, 1.0);
}
