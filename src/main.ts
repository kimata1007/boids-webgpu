import computeWGSL from "./shaders/compute.wgsl?raw";
import renderWGSL from "./shaders/render.wgsl?raw";

const NUM_BOIDS = 8000;

const SIM = {
  cohesionRadius: 0.05,
  separationRadius: 0.018,
  alignmentRadius: 0.04,
  maxSpeed: 0.45,
  cohesion: 1.4,
  separation: 0.6,
  alignment: 2.5,
  mouseStrength: 1.6,
};

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
  const resize = (): void => {
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  resize();
  window.addEventListener("resize", resize);

  // Each boid: pos.xy + vel.xy = 4 floats = 16 bytes
  const boidByteStride = 16;
  const boidByteSize = NUM_BOIDS * boidByteStride;

  const initial = new Float32Array(NUM_BOIDS * 4);
  for (let i = 0; i < NUM_BOIDS; i++) {
    initial[i * 4 + 0] = (Math.random() * 2 - 1) * 0.9;
    initial[i * 4 + 1] = (Math.random() * 2 - 1) * 0.9;
    const a = Math.random() * Math.PI * 2;
    const s = 0.05 + Math.random() * 0.08;
    initial[i * 4 + 2] = Math.cos(a) * s;
    initial[i * 4 + 3] = Math.sin(a) * s;
  }

  const boidBuffers: GPUBuffer[] = [0, 1].map(() =>
    device.createBuffer({
      size: boidByteSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
  );
  device.queue.writeBuffer(boidBuffers[0], 0, initial);
  device.queue.writeBuffer(boidBuffers[1], 0, initial);

  // Params uniform: 16 floats = 64 bytes (matches WGSL struct layout)
  const paramsBuffer = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // View uniform: 4 floats = 16 bytes
  const viewBuffer = device.createBuffer({
    size: 16,
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
    vertex: { module: renderModule, entryPoint: "vs_main" },
    fragment: {
      module: renderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  const renderBindGroups: GPUBindGroup[] = [0, 1].map((i) =>
    device.createBindGroup({
      layout: renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: boidBuffers[i] } },
        { binding: 1, resource: { buffer: viewBuffer } },
      ],
    }),
  );

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

  const countEl = document.getElementById("count");
  if (countEl) countEl.textContent = String(NUM_BOIDS);
  const fpsEl = document.getElementById("fps");

  let frame = 0;
  let lastT = performance.now();
  let smoothedFps = 60;
  let fpsUpdateTimer = 0;

  const params = new Float32Array(16);
  const view = new Float32Array(4);

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
    // Sim space: x ∈ [-aspect, aspect], y ∈ [-1, 1]. Map pointer NDC.x to sim space.
    const mouseSimX = pointer.x * aspect;
    const mouseSimY = pointer.y;

    params[0] = dt;
    params[1] = pointer.mode;
    params[2] = mouseSimX;
    params[3] = mouseSimY;
    params[4] = aspect;
    params[5] = 1.0;
    params[6] = SIM.cohesionRadius;
    params[7] = SIM.separationRadius;
    params[8] = SIM.alignmentRadius;
    params[9] = SIM.maxSpeed;
    params[10] = SIM.cohesion;
    params[11] = SIM.separation;
    params[12] = SIM.alignment;
    params[13] = SIM.mouseStrength;
    device.queue.writeBuffer(paramsBuffer, 0, params);

    view[0] = aspect;
    view[1] = SIM.maxSpeed;
    device.queue.writeBuffer(viewBuffer, 0, view);

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
      });
      pass.setPipeline(renderPipeline);
      pass.setBindGroup(0, renderBindGroups[(frame + 1) % 2]);
      pass.draw(3, NUM_BOIDS);
      pass.end();
    }

    device.queue.submit([enc.finish()]);

    frame++;
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  showMessage(`Error: ${message}`);
  console.error(err);
});
