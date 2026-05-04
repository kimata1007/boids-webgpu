import computeWGSL from "./shaders/compute.wgsl?raw";
import renderWGSL from "./shaders/render.wgsl?raw";
import { lookAt, multiply, perspective } from "./lib/mat4";
import { loadGLB } from "./gltf/loader";

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

interface VatMeta {
  numFrames: number;
  vertexCount: number;
  format: string;
  duration: number;
}

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
  // PR6 only needs the mesh's normals + indices; the per-frame deformed
  // positions live in the VAT texture, and joints/weights are no longer
  // sampled at runtime.
  let gltf;
  try {
    gltf = await loadGLB("/flying_bird_static.glb");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`Failed to load flying_bird_static.glb: ${message}`);
    console.error(error);
    return;
  }
  const mesh = gltf.mesh;

  // Load the baked Vertex Animation Texture. The .json sidecar carries
  // numFrames / vertexCount / duration so the runtime never has to
  // hardcode values that the bake script chose.
  let vatMeta: VatMeta;
  let vatBuffer: ArrayBuffer;
  try {
    const metaResp = await fetch("/flying_bird_vat.json");
    if (!metaResp.ok) {
      throw new Error(`HTTP ${metaResp.status} ${metaResp.statusText}`);
    }
    vatMeta = (await metaResp.json()) as VatMeta;
    const binResp = await fetch("/flying_bird_vat.bin");
    if (!binResp.ok) {
      throw new Error(`HTTP ${binResp.status} ${binResp.statusText}`);
    }
    vatBuffer = await binResp.arrayBuffer();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    showMessage(`Failed to load VAT: ${message}`);
    console.error(error);
    return;
  }

  if (vatMeta.vertexCount !== mesh.vertexCount) {
    showMessage(
      `VAT vertexCount ${vatMeta.vertexCount} disagrees with glTF mesh ` +
        `vertexCount ${mesh.vertexCount}; rebake with tools/bake_vat.py`,
    );
    return;
  }
  const expectedVatBytes = vatMeta.numFrames * vatMeta.vertexCount * 8;
  if (vatBuffer.byteLength !== expectedVatBytes) {
    showMessage(
      `VAT bin is ${vatBuffer.byteLength} bytes; expected ${expectedVatBytes}`,
    );
    return;
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

  // Boid storage uses STORAGE | COPY_DST for the compute pass plus the
  // render pass binding. Two ping-pong buffers swap each frame so the
  // compute shader can read from one while writing to the other.
  const boidBuffers: GPUBuffer[] = [0, 1].map(() =>
    device.createBuffer({
      size: boidByteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
  );
  device.queue.writeBuffer(boidBuffers[0], 0, initial);
  device.queue.writeBuffer(boidBuffers[1], 0, initial);

  // Vertex buffer (PR6): normal-only, 12 bytes / vertex. The bind-pose
  // normal is approximated as constant across the flap; positions are
  // supplied by the VAT lookup at vertex_index.
  const VERTEX_STRIDE_BYTES = 12;
  const vertexByteSize = mesh.vertexCount * VERTEX_STRIDE_BYTES;
  const interleavedBuffer = new ArrayBuffer(vertexByteSize);
  const interleavedF32 = new Float32Array(interleavedBuffer);
  for (let i = 0; i < mesh.vertexCount; i++) {
    interleavedF32[i * 3 + 0] = mesh.normals[i * 3 + 0];
    interleavedF32[i * 3 + 1] = mesh.normals[i * 3 + 1];
    interleavedF32[i * 3 + 2] = mesh.normals[i * 3 + 2];
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

  // VAT texture: rgba16float, [vertexCount, numFrames].
  const vatTexture = device.createTexture({
    size: [vatMeta.vertexCount, vatMeta.numFrames, 1],
    format: "rgba16float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: vatTexture },
    new Uint8Array(vatBuffer),
    { bytesPerRow: vatMeta.vertexCount * 8 },
    {
      width: vatMeta.vertexCount,
      height: vatMeta.numFrames,
      depthOrArrayLayers: 1,
    },
  );

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
  //   maxSpeed     f32  @64
  //   time         f32  @68
  //   numFrames    f32  @72
  //   duration     f32  @76
  // Total: 80 bytes (16-byte aligned).
  const VIEW_FLOATS = 20;
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

  // Render bind group is rebuilt each frame because the boid storage
  // buffer ping-pongs between the two ping-pong slots; the just-written
  // buffer (the compute pass's output) is the one we want to read this
  // frame.
  const makeRenderBindGroup = (boidBuf: GPUBuffer): GPUBindGroup =>
    device.createBindGroup({
      layout: renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: viewBuffer } },
        { binding: 1, resource: { buffer: boidBuf } },
        { binding: 2, resource: vatTexture.createView() },
      ],
    });
  const renderBindGroups: GPUBindGroup[] = [
    makeRenderBindGroup(boidBuffers[0]),
    makeRenderBindGroup(boidBuffers[1]),
  ];

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

  // Pause toggle: freezes both the boid sim (by zeroing dt) and the VAT
  // animation phase clock so the flock holds its current pose.
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
  if (countEl) countEl.textContent = String(NUM_BOIDS);
  const fpsEl = document.getElementById("fps");

  let frame = 0;
  const startT = performance.now();
  let lastT = startT;
  let smoothedFps = 60;
  let fpsUpdateTimer = 0;
  // Time fed to the VAT lookup. Advances by `dt` each unpaused frame so
  // the flap loop continues smoothly across pauses.
  let animElapsed = 0;

  const params = new Float32Array(PARAMS_FLOATS);
  const view = new Float32Array(VIEW_FLOATS);
  const indexCount = mesh.indices.length;

  const tick = (): void => {
    const now = performance.now();
    let dtRaw = (now - lastT) / 1000;
    lastT = now;
    // Clamp to avoid blow-up on tab switch
    if (dtRaw > 0.05) dtRaw = 0.05;
    const dt = paused ? 0 : dtRaw;

    smoothedFps = smoothedFps * 0.92 + (1 / Math.max(dtRaw, 1e-4)) * 0.08;
    fpsUpdateTimer += dtRaw;
    if (fpsUpdateTimer >= 0.25 && fpsEl) {
      fpsEl.textContent = smoothedFps.toFixed(0);
      fpsUpdateTimer = 0;
    }

    if (!paused) {
      animElapsed += dtRaw;
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
    view[16] = SIM.maxSpeed;
    view[17] = animElapsed;
    view[18] = vatMeta.numFrames;
    view[19] = vatMeta.duration;
    device.queue.writeBuffer(viewBuffer, 0, view);

    const depth = ensureDepthTexture();

    const enc = device.createCommandEncoder();

    // Compute pass writes into boidBuffers[1 - (frame % 2)].
    const computeReadIdx = frame % 2;
    const computeWriteIdx = 1 - computeReadIdx;

    {
      const pass = enc.beginComputePass();
      pass.setPipeline(computePipeline);
      pass.setBindGroup(0, computeBindGroups[computeReadIdx]);
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
      // Render reads the buffer the compute pass just wrote.
      pass.setBindGroup(0, renderBindGroups[computeWriteIdx]);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setIndexBuffer(indexBuffer, indexFormat);
      pass.drawIndexed(indexCount, NUM_BOIDS, 0, 0, 0);
      pass.end();
    }

    device.queue.submit([enc.finish()]);

    frame++;
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
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
