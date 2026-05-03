import computeWGSL from "./shaders/compute.wgsl?raw";
import renderWGSL from "./shaders/render.wgsl?raw";
import { identity, lookAt, multiply, perspective } from "./lib/mat4";
import { loadGLB } from "./gltf/loader";
import { computeSkinningMatrices } from "./skin/skeleton";
import { applyAnimation } from "./animation/sampler";

const NUM_BOIDS = 8000;

// Half-extents of the simulation volume.
// x: lateral (scaled by aspect each frame), y: altitude, z: depth.
const SIM_BASE_BOUNDS = {
  x: 1.0,
  y: 0.4,
  z: 1.0,
};

const SIM = {
  cohesionRadius: 0.08,
  separationRadius: 0.025,
  alignmentRadius: 0.06,
  maxSpeed: 0.55,
  cohesion: 1.4,
  separation: 0.8,
  alignment: 2.5,
  mouseStrength: 1.8,
};

// Camera: tilted, slightly elevated, looking at the origin.
const CAMERA = {
  eye: [0, 0.55, 1.6] as [number, number, number],
  target: [0, 0, 0] as [number, number, number],
  up: [0, 1, 0] as [number, number, number],
  fovY: Math.PI / 3,
  near: 0.05,
  far: 50,
};

// PR3 model placement: the bind-pose pigeon is roughly 1.6m tall in glTF
// units, which is way too big for the existing camera framing. Scale it
// down so the body sits comfortably inside the view.
const PIGEON_MODEL_SCALE = 0.5;

function showMessage(text: string): void {
  const msg = document.getElementById("msg");
  if (msg) {
    msg.textContent = text;
    msg.classList.add("show");
  }
}

async function main(): Promise<void> {
  if (!("gpu" in navigator)) {
    showMessage(
      "WebGPU is not available. Please use Chrome 113+, Edge 113+, or Safari 26+.",
    );
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    showMessage("No suitable GPU adapter found.");
    return;
  }
  const device = await adapter.requestDevice();

  const canvas = document.getElementById("gpu") as HTMLCanvasElement;
  const ctx = canvas.getContext("webgpu");
  if (!ctx) {
    showMessage("Failed to acquire WebGPU canvas context.");
    return;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  // Depth texture is recreated whenever the canvas size changes.
  let depthTexture: GPUTexture | null = null;
  const ensureDepthTexture = (): GPUTexture => {
    if (
      depthTexture &&
      depthTexture.width === canvas.width &&
      depthTexture.height === canvas.height
    ) {
      return depthTexture;
    }
    if (depthTexture) {
      depthTexture.destroy();
    }
    depthTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return depthTexture;
  };

  const resize = (): void => {
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  resize();
  window.addEventListener("resize", resize);

  // Load the static glTF mesh up front so we can size GPU buffers correctly.
  let gltf;
  try {
    gltf = await loadGLB("/pigeon.glb");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`Failed to load pigeon.glb: ${message}`);
    console.error(error);
    return;
  }
  const mesh = gltf.mesh;
  const skeleton = gltf.skeleton;
  if (!skeleton) {
    showMessage("pigeon.glb is missing a skin; PR4 needs joints.");
    return;
  }
  // PR5 requires at least one baked animation. Without it the pigeon would
  // freeze in the bind pose; surface that as an explicit user-facing error
  // rather than silently shipping a static render.
  if (gltf.animations.length === 0) {
    showMessage("pigeon.glb has no animations; PR5 needs at least one.");
    return;
  }
  const anim = gltf.animations[0];

  // PR4 packs joints as uint8x4 in the vertex buffer. The loader can also
  // return Uint16Array for files that index >255 joints, but that path is not
  // wired through this pipeline yet. Fail loudly so the next maintainer
  // notices instead of silently dropping the high byte.
  // TODO: PR future — support uint16 joint indices end-to-end.
  if (!(mesh.joints instanceof Uint8Array)) {
    showMessage(
      "pigeon.glb uses uint16 joint indices; PR4 only handles uint8x4.",
    );
    return;
  }

  // Defensive normalization. Most exporters produce weights that sum to 1,
  // but auto-weight rigs occasionally leave tiny rounding error or zeros on
  // every channel. A zero sum collapses the vertex to the origin during
  // blending, so when that happens we fall back to "fully bound to joint 0".
  const normalizedWeights = new Float32Array(mesh.weights.length);
  for (let v = 0; v < mesh.vertexCount; v++) {
    const base = v * 4;
    const sum =
      mesh.weights[base + 0] +
      mesh.weights[base + 1] +
      mesh.weights[base + 2] +
      mesh.weights[base + 3];
    if (sum > 1e-6) {
      const inv = 1 / sum;
      normalizedWeights[base + 0] = mesh.weights[base + 0] * inv;
      normalizedWeights[base + 1] = mesh.weights[base + 1] * inv;
      normalizedWeights[base + 2] = mesh.weights[base + 2] * inv;
      normalizedWeights[base + 3] = mesh.weights[base + 3] * inv;
    } else {
      normalizedWeights[base + 0] = 1;
    }
  }

  // Each boid: vec4 pos + vec4 vel = 8 floats = 32 bytes.
  const FLOATS_PER_BOID = 8;
  const boidByteStride = FLOATS_PER_BOID * 4;
  const boidByteSize = NUM_BOIDS * boidByteStride;

  const aspectInit = canvas.width / Math.max(canvas.height, 1);
  const initial = new Float32Array(NUM_BOIDS * FLOATS_PER_BOID);
  for (let i = 0; i < NUM_BOIDS; i++) {
    const base = i * FLOATS_PER_BOID;
    initial[base + 0] = (Math.random() * 2 - 1) * aspectInit * 0.9;
    initial[base + 1] = (Math.random() * 2 - 1) * SIM_BASE_BOUNDS.y * 0.9;
    initial[base + 2] = (Math.random() * 2 - 1) * SIM_BASE_BOUNDS.z * 0.9;
    initial[base + 3] = 0;
    // Random direction on the unit sphere, then scale to a small initial speed.
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    const s = 0.05 + Math.random() * 0.08;
    initial[base + 4] = r * Math.cos(theta) * s;
    initial[base + 5] = u * s * 0.4; // dampen vertical so flock doesn't escape altitude band
    initial[base + 6] = r * Math.sin(theta) * s;
    initial[base + 7] = 0;
  }

  const boidBuffers: GPUBuffer[] = [0, 1].map(() =>
    device.createBuffer({
      size: boidByteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
  );
  device.queue.writeBuffer(boidBuffers[0], 0, initial);
  device.queue.writeBuffer(boidBuffers[1], 0, initial);

  // Vertex buffer layout (PR4): 48 bytes / vertex, interleaved.
  //   position vec3<f32> @ 0   (12 bytes)
  //   normal   vec3<f32> @ 12  (12 bytes)
  //   joints   u8x4      @ 24  (4 bytes)
  //   _pad0              @ 28  (4 bytes — keep weights aligned to 16)
  //   weights  vec4<f32> @ 32  (16 bytes)
  //
  // We build the buffer through one ArrayBuffer with two views (Float32 for
  // floats, Uint8 for joint indices) so the typed-byte layout is exact.
  const VERTEX_STRIDE_BYTES = 48;
  const vertexByteSize = mesh.vertexCount * VERTEX_STRIDE_BYTES;
  const interleavedBuffer = new ArrayBuffer(vertexByteSize);
  const interleavedF32 = new Float32Array(interleavedBuffer);
  const interleavedU8 = new Uint8Array(interleavedBuffer);
  const FLOATS_PER_STRIDE = VERTEX_STRIDE_BYTES / 4;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const fdst = i * FLOATS_PER_STRIDE;
    const u8dst = i * VERTEX_STRIDE_BYTES;
    // position
    interleavedF32[fdst + 0] = mesh.positions[i * 3 + 0];
    interleavedF32[fdst + 1] = mesh.positions[i * 3 + 1];
    interleavedF32[fdst + 2] = mesh.positions[i * 3 + 2];
    // normal
    interleavedF32[fdst + 3] = mesh.normals[i * 3 + 0];
    interleavedF32[fdst + 4] = mesh.normals[i * 3 + 1];
    interleavedF32[fdst + 5] = mesh.normals[i * 3 + 2];
    // joints (uint8x4) at byte offset 24
    interleavedU8[u8dst + 24] = mesh.joints[i * 4 + 0];
    interleavedU8[u8dst + 25] = mesh.joints[i * 4 + 1];
    interleavedU8[u8dst + 26] = mesh.joints[i * 4 + 2];
    interleavedU8[u8dst + 27] = mesh.joints[i * 4 + 3];
    // weights at float offset 8 (= byte offset 32)
    interleavedF32[fdst + 8] = normalizedWeights[i * 4 + 0];
    interleavedF32[fdst + 9] = normalizedWeights[i * 4 + 1];
    interleavedF32[fdst + 10] = normalizedWeights[i * 4 + 2];
    interleavedF32[fdst + 11] = normalizedWeights[i * 4 + 3];
  }
  const vertexBuffer = device.createBuffer({
    size: vertexByteSize,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, interleavedBuffer);

  // Index buffer: pad to 4 bytes for uint16 because writeBuffer requires it
  // when the source array's byte length is odd-aligned for the target stride.
  const indicesIsUint16 = mesh.indices instanceof Uint16Array;
  const indexFormat: GPUIndexFormat = indicesIsUint16 ? "uint16" : "uint32";
  const indexByteLength = roundUpToMultipleOf(mesh.indices.byteLength, 4);
  const indexBuffer = device.createBuffer({
    size: indexByteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, mesh.indices);

  // Params uniform layout (matches compute.wgsl `Params`):
  //   dt           f32  @0
  //   mouseMode    f32  @4
  //   _pad0        vec2 @8
  //   mouse        vec4 @16
  //   bounds       vec4 @32
  //   cohesionR..  f32  @48
  //   separationR  f32  @52
  //   alignmentR   f32  @56
  //   maxSpeed     f32  @60
  //   cohesion     f32  @64
  //   separation   f32  @68
  //   alignment    f32  @72
  //   mouseStr     f32  @76
  // Total: 80 bytes (multiple of 16).
  const PARAMS_FLOATS = 20;
  const paramsBuffer = device.createBuffer({
    size: PARAMS_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // View uniform layout (matches render.wgsl `ViewUniform`):
  //   mvp          mat4 @0    (64 bytes)
  //   model        mat4 @64   (64 bytes)
  //   maxSpeed     f32  @128
  //   time         f32  @132
  //   _pad0        vec2 @136  (8 bytes)
  // Total: 144 bytes (16-byte aligned).
  const VIEW_FLOATS = 36;
  const viewBuffer = device.createBuffer({
    size: VIEW_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const computeModule = device.createShaderModule({ code: computeWGSL });
  const computePipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: computeModule, entryPoint: "cs_main" },
  });

  const computeBindGroups: GPUBindGroup[] = [0, 1].map((i) =>
    device.createBindGroup({
      layout: computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: boidBuffers[i] } },
        { binding: 1, resource: { buffer: boidBuffers[1 - i] } },
        { binding: 2, resource: { buffer: paramsBuffer } },
      ],
    }),
  );

  // Joint matrix Storage Buffer: one mat4x4<f32> per joint (64 bytes each).
  // Updated every frame from the CPU once we know the slider angle.
  const jointCount = skeleton.joints.length;
  const jointBuffer = device.createBuffer({
    size: jointCount * 64,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const skinningScratch = new Float32Array(jointCount * 16);

  const renderModule = device.createShaderModule({ code: renderWGSL });
  const renderPipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: renderModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: VERTEX_STRIDE_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "uint8x4" },
            { shaderLocation: 3, offset: 32, format: "float32x4" },
          ],
        },
      ],
    },
    fragment: {
      module: renderModule,
      entryPoint: "fs_main",
      targets: [{ format }],
    },
    primitive: {
      topology: "triangle-list",
      cullMode: "back",
      frontFace: "ccw",
    },
    depthStencil: {
      format: "depth24plus",
      depthCompare: "less",
      depthWriteEnabled: true,
    },
  });

  const renderBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: viewBuffer } },
      { binding: 1, resource: { buffer: jointBuffer } },
    ],
  });

  // Mouse / pointer state, in canvas-space NDC ([-1, 1])
  const pointer = { x: 0, y: 0, mode: 0 as -1 | 0 | 1 };

  const updatePointer = (clientX: number, clientY: number): void => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
  };

  canvas.addEventListener("pointermove", (e) => updatePointer(e.clientX, e.clientY));
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    updatePointer(e.clientX, e.clientY);
    if (e.button === 0) pointer.mode = 1;
    else if (e.button === 2) pointer.mode = -1;
  });
  canvas.addEventListener("pointerup", () => { pointer.mode = 0; });
  canvas.addEventListener("pointercancel", () => { pointer.mode = 0; });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  // PR5: pause/play toggle. The animation is driven by `animElapsed`, which
  // accumulates only while `paused === false`. We never freeze the boid sim
  // or the framerate counter — only the pigeon's flap clock.
  let paused = false;
  const pauseButton = document.getElementById("pause") as HTMLButtonElement | null;
  const PAUSE_LABEL_PLAYING = "⏸ Pause";
  const PAUSE_LABEL_PAUSED = "▶ Play";
  if (pauseButton) {
    pauseButton.textContent = PAUSE_LABEL_PLAYING;
    pauseButton.addEventListener("click", () => {
      paused = !paused;
      pauseButton.textContent = paused
        ? PAUSE_LABEL_PAUSED
        : PAUSE_LABEL_PLAYING;
    });
  }

  const countEl = document.getElementById("count");
  // The HUD count was tied to the procedural boid render. PR3 draws one
  // pigeon, so override the figure to make the HUD honest.
  if (countEl) countEl.textContent = "1";
  const fpsEl = document.getElementById("fps");

  let frame = 0;
  const startT = performance.now();
  let lastT = startT;
  let smoothedFps = 60;
  let fpsUpdateTimer = 0;
  // PR5: animation playback clock. Advances by `dt` each frame *unless* the
  // user has paused; that way the flap loop freezes mid-cycle instead of
  // snapping back to the start when paused.
  let animElapsed = 0;

  const params = new Float32Array(PARAMS_FLOATS);
  const view = new Float32Array(VIEW_FLOATS);
  const modelMat = makeUniformScaleMatrix(PIGEON_MODEL_SCALE);
  const indexCount = mesh.indices.length;

  const tick = (): void => {
    const now = performance.now();
    let dt = (now - lastT) / 1000;
    lastT = now;
    // Clamp to avoid blow-up on tab switch
    if (dt > 0.05) dt = 0.05;

    smoothedFps = smoothedFps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
    fpsUpdateTimer += dt;
    if (fpsUpdateTimer >= 0.25 && fpsEl) {
      fpsEl.textContent = smoothedFps.toFixed(0);
      fpsUpdateTimer = 0;
    }

    const aspect = canvas.width / canvas.height;
    const boundsX = SIM_BASE_BOUNDS.x * aspect;
    const boundsY = SIM_BASE_BOUNDS.y;
    const boundsZ = SIM_BASE_BOUNDS.z;

    // Map pointer NDC to a 3D point on the y=0 plane. Pragmatic mapping:
    // x scales with the lateral extent, the y component of NDC drives depth (z),
    // and the y in sim space stays at 0 (the ground plane the boids float around).
    const mouseSimX = pointer.x * boundsX;
    const mouseSimY = 0;
    const mouseSimZ = -pointer.y * boundsZ;

    let p = 0;
    params[p++] = dt;
    params[p++] = pointer.mode;
    params[p++] = 0;            // _pad0.x
    params[p++] = 0;            // _pad0.y
    params[p++] = mouseSimX;    // mouse.x
    params[p++] = mouseSimY;    // mouse.y
    params[p++] = mouseSimZ;    // mouse.z
    params[p++] = 0;            // mouse.w
    params[p++] = boundsX;      // bounds.x
    params[p++] = boundsY;      // bounds.y
    params[p++] = boundsZ;      // bounds.z
    params[p++] = 0;            // bounds.w
    params[p++] = SIM.cohesionRadius;
    params[p++] = SIM.separationRadius;
    params[p++] = SIM.alignmentRadius;
    params[p++] = SIM.maxSpeed;
    params[p++] = SIM.cohesion;
    params[p++] = SIM.separation;
    params[p++] = SIM.alignment;
    params[p++] = SIM.mouseStrength;
    device.queue.writeBuffer(paramsBuffer, 0, params);

    // Build perspective + lookAt and write the MVP into the view uniform.
    const proj = perspective(CAMERA.fovY, aspect, CAMERA.near, CAMERA.far);
    const viewMat = lookAt(CAMERA.eye, CAMERA.target, CAMERA.up);
    const mvp = multiply(proj, viewMat);
    view.set(mvp, 0);
    view.set(modelMat, 16);
    view[32] = SIM.maxSpeed;
    view[33] = (now - startT) / 1000;
    view[34] = 0;
    view[35] = 0;
    device.queue.writeBuffer(viewBuffer, 0, view);

    // PR5: drive the flap from the baked glTF animation. `applyAnimation`
    // mutates the joints' TRS in place; `computeSkinningMatrices` then reads
    // those values when composing each joint's local matrix, so the GPU sees
    // a fresh set of skinning matrices every frame.
    if (!paused) {
      animElapsed += dt;
    }
    applyAnimation(skeleton, anim, animElapsed);
    computeSkinningMatrices(skeleton, skinningScratch);
    device.queue.writeBuffer(jointBuffer, 0, skinningScratch);

    const depth = ensureDepthTexture();

    const enc = device.createCommandEncoder();

    {
      const pass = enc.beginComputePass();
      pass.setPipeline(computePipeline);
      pass.setBindGroup(0, computeBindGroups[frame % 2]);
      pass.dispatchWorkgroups(Math.ceil(NUM_BOIDS / 64));
      pass.end();
    }

    {
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            clearValue: { r: 0.02, g: 0.03, b: 0.06, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.setPipeline(renderPipeline);
      pass.setBindGroup(0, renderBindGroup);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setIndexBuffer(indexBuffer, indexFormat);
      // PR3: a single static pigeon. PR6 will reintroduce instancing.
      pass.drawIndexed(indexCount, 1, 0, 0, 0);
      pass.end();
    }

    device.queue.submit([enc.finish()]);

    frame++;
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

// Build a column-major 4x4 with uniform scale on the diagonal.
function makeUniformScaleMatrix(s: number): Float32Array {
  const m = identity();
  m[0] = s;
  m[5] = s;
  m[10] = s;
  return m;
}

function roundUpToMultipleOf(value: number, multiple: number): number {
  const remainder = value % multiple;
  return remainder === 0 ? value : value + (multiple - remainder);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  showMessage(`Error: ${message}`);
  console.error(err);
});
