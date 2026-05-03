struct Boid {
  pos: vec2<f32>,
  vel: vec2<f32>,
}

struct ViewUniform {
  aspect: f32,
  maxSpeed: f32,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var<storage, read> boids: array<Boid>;
@group(0) @binding(1) var<uniform> view: ViewUniform;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) speed: f32,
  @location(1) flap: f32,
}

// Bird silhouette in local space (forward = +x), drawn as 2 triangles, 6 vertices:
//   T1: head -> left-wing-tip -> tail-notch
//   T2: head -> tail-notch    -> right-wing-tip
// Wing tips animate to fake a top-down flap.
@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> VSOut {
  let b = boids[ii];
  let speed = length(b.vel);
  var dir = vec2<f32>(0.0, 1.0);
  if (speed > 0.0001) {
    dir = b.vel / speed;
  }
  let perp = vec2<f32>(-dir.y, dir.x);

  // Decorrelate flap phase per bird so the flock isn't synchronized.
  let flapRate = 7.0 + speed * 16.0;
  let phase = view.time * flapRate + f32(ii) * 0.137;
  let s = sin(phase);
  // Wing-tip lateral span pulses; small forward sweep on the down-stroke.
  let span = 0.40 + 0.55 * (0.5 + 0.5 * s);
  let sweep = -0.12 * cos(phase);

  let size = 0.016;
  var local = vec2<f32>(0.0);
  if (vi == 0u || vi == 3u) {
    local = vec2<f32>(1.00, 0.0);                 // head
  } else if (vi == 1u) {
    local = vec2<f32>(-0.55 + sweep,  span);      // left wing tip
  } else if (vi == 2u || vi == 4u) {
    local = vec2<f32>(-0.50, 0.0);                // tail notch
  } else {
    local = vec2<f32>(-0.55 + sweep, -span);      // right wing tip
  }
  local = local * size;

  let world = b.pos + dir * local.x + perp * local.y;
  // Sim space: x in [-aspect, aspect], y in [-1, 1]. Map to NDC.
  let ndc = vec2<f32>(world.x / view.aspect, world.y);

  var out: VSOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
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
