struct Boid {
  pos: vec4<f32>,
  vel: vec4<f32>,
}

struct ViewUniform {
  mvp: mat4x4<f32>,
  maxSpeed: f32,
  time: f32,
  _pad0: vec2<f32>,
}

@group(0) @binding(0) var<storage, read> boids: array<Boid>;
@group(0) @binding(1) var<uniform> view: ViewUniform;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) speed: f32,
  @location(1) flap: f32,
}

// Bird silhouette in local space (forward = +z, up = +y), drawn as 2 triangles,
// 6 vertices:
//   T1: head -> left-wing-tip -> tail-notch
//   T2: head -> tail-notch    -> right-wing-tip
// Wing tips animate to fake a flap.
@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> VSOut {
  let b = boids[ii];
  let velXyz = b.vel.xyz;
  let speed = length(velXyz);

  // Build a world-frame from velocity direction (forward), world up, and cross
  // products for the perpendicular axes. Fall back to +z if velocity is zero.
  var forward = vec3<f32>(0.0, 0.0, 1.0);
  if (speed > 0.0001) {
    forward = velXyz / speed;
  }
  let worldUp = vec3<f32>(0.0, 1.0, 0.0);
  var right = cross(worldUp, forward);
  let rl = length(right);
  if (rl < 0.0001) {
    // forward is parallel to worldUp; pick an arbitrary right.
    right = vec3<f32>(1.0, 0.0, 0.0);
  } else {
    right = right / rl;
  }
  let realUp = cross(forward, right);

  // Decorrelate flap phase per bird so the flock isn't synchronized.
  let flapRate = 7.0 + speed * 16.0;
  let phase = view.time * flapRate + f32(ii) * 0.137;
  let s = sin(phase);
  // Wing-tip lateral span pulses; small forward sweep on the down-stroke.
  let span = 0.40 + 0.55 * (0.5 + 0.5 * s);
  let sweep = -0.12 * cos(phase);

  let size = 0.022;
  // Local axes: x = right, y = up, z = forward.
  var local = vec3<f32>(0.0);
  if (vi == 0u || vi == 3u) {
    local = vec3<f32>(0.0, 0.0, 1.00);                  // head
  } else if (vi == 1u) {
    local = vec3<f32>(-span, 0.0, -0.55 + sweep);       // left wing tip
  } else if (vi == 2u || vi == 4u) {
    local = vec3<f32>(0.0, 0.0, -0.50);                 // tail notch
  } else {
    local = vec3<f32>(span, 0.0, -0.55 + sweep);        // right wing tip
  }
  local = local * size;

  let world = b.pos.xyz + right * local.x + realUp * local.y + forward * local.z;

  var out: VSOut;
  out.clip = view.mvp * vec4<f32>(world, 1.0);
  out.speed = speed;
  out.flap = s;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let t = clamp(in.speed / max(view.maxSpeed, 0.0001), 0.0, 1.0);
  // Pigeon-ish palette: cool slate to warm dove gray on speed; subtle flap shading.
  let slate = vec3<f32>(0.55, 0.62, 0.72);
  let dove  = vec3<f32>(0.92, 0.90, 0.88);
  var color = mix(slate, dove, t);
  // Down-stroke darkens slightly to emphasize the flap.
  color = color * (0.85 + 0.15 * (0.5 + 0.5 * in.flap));
  return vec4<f32>(color, 0.95);
}
