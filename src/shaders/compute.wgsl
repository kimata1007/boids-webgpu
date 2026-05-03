struct Boid {
  pos: vec2<f32>,
  vel: vec2<f32>,
}

struct Params {
  dt: f32,
  mouseMode: f32,
  mouse: vec2<f32>,
  bounds: vec2<f32>,
  cohesionRadius: f32,
  separationRadius: f32,
  alignmentRadius: f32,
  maxSpeed: f32,
  cohesion: f32,
  separation: f32,
  alignment: f32,
  mouseStrength: f32,
}

@group(0) @binding(0) var<storage, read> inBoids: array<Boid>;
@group(0) @binding(1) var<storage, read_write> outBoids: array<Boid>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let n = arrayLength(&inBoids);
  if (i >= n) {
    return;
  }

  let me = inBoids[i];
  var center = vec2<f32>(0.0);
  var avgVel = vec2<f32>(0.0);
  var avoid = vec2<f32>(0.0);
  var cCount: u32 = 0u;
  var aCount: u32 = 0u;

  // Naive O(N^2) neighbor search. Fast enough for ~10k on a modern GPU.
  for (var j: u32 = 0u; j < n; j = j + 1u) {
    if (j == i) {
      continue;
    }
    let other = inBoids[j];
    let diff = other.pos - me.pos;
    let d = length(diff);

    if (d < params.cohesionRadius) {
      center = center + other.pos;
      cCount = cCount + 1u;
    }
    if (d < params.alignmentRadius) {
      avgVel = avgVel + other.vel;
      aCount = aCount + 1u;
    }
    if (d < params.separationRadius && d > 0.0001) {
      avoid = avoid - diff / max(d * d, 0.0001);
    }
  }

  var vel = me.vel;

  if (cCount > 0u) {
    center = center / f32(cCount);
    vel = vel + (center - me.pos) * params.cohesion * params.dt;
  }
  if (aCount > 0u) {
    avgVel = avgVel / f32(aCount);
    vel = vel + (avgVel - me.vel) * params.alignment * params.dt;
  }
  vel = vel + avoid * params.separation * params.dt;

  // Mouse force (left = attract, right = repel)
  if (abs(params.mouseMode) > 0.5) {
    let toMouse = params.mouse - me.pos;
    let dm = length(toMouse);
    if (dm > 0.001) {
      let dir = toMouse / dm;
      let falloff = 1.0 / (1.0 + dm * 4.0);
      vel = vel + dir * params.mouseStrength * params.mouseMode * falloff;
    }
  }

  // Clamp speed
  let speed = length(vel);
  if (speed > params.maxSpeed) {
    vel = (vel / speed) * params.maxSpeed;
  }

  // Integrate position with toroidal wrap
  var pos = me.pos + vel * params.dt;
  let bx = params.bounds.x;
  let by = params.bounds.y;
  if (pos.x >  bx) { pos.x = pos.x - 2.0 * bx; }
  if (pos.x < -bx) { pos.x = pos.x + 2.0 * bx; }
  if (pos.y >  by) { pos.y = pos.y - 2.0 * by; }
  if (pos.y < -by) { pos.y = pos.y + 2.0 * by; }

  outBoids[i].pos = pos;
  outBoids[i].vel = vel;
}
