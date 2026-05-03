struct Boid {
  pos: vec2<f32>,
  vel: vec2<f32>,
}

struct ViewUniform {
  aspect: f32,
  maxSpeed: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var<storage, read> boids: array<Boid>;
@group(0) @binding(1) var<uniform> view: ViewUniform;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) speed: f32,
}

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

  let size = 0.012;
  var local = vec2<f32>(0.0);
  if (vi == 0u) {
    local = vec2<f32>(size * 1.7, 0.0);
  } else if (vi == 1u) {
    local = vec2<f32>(-size * 0.7, size * 0.75);
  } else {
    local = vec2<f32>(-size * 0.7, -size * 0.75);
  }

  let world = b.pos + dir * local.x + perp * local.y;
  // Sim space: x in [-aspect, aspect], y in [-1, 1]. Map to NDC.
  let ndc = vec2<f32>(world.x / view.aspect, world.y);

  var out: VSOut;
  out.clip = vec4<f32>(ndc, 0.0, 1.0);
  out.speed = speed;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let t = clamp(in.speed / max(view.maxSpeed, 0.0001), 0.0, 1.0);
  let cool = vec3<f32>(0.30, 0.55, 1.00);
  let warm = vec3<f32>(1.00, 0.55, 0.20);
  let color = mix(cool, warm, t);
  return vec4<f32>(color, 0.92);
}
