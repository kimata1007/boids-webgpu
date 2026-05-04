// Minimal hand-rolled GLB (glTF 2.0 binary) loader.
//
// This is *not* a general-purpose glTF parser. We only support the subset of
// the spec that our own pigeon.glb actually uses: a single mesh with a single
// primitive (POSITION, NORMAL, JOINTS_0, WEIGHTS_0, indices) and at most one
// skin. Unsupported fields are ignored or trigger an explicit error.
//
// Why hand-rolled: keeps the dependency surface to zero and forces us to
// understand the binary layout. PR4+ will reuse the skin data; PR3 only
// touches positions, normals, and indices on the GPU.

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

// glTF componentType values
const COMPONENT_BYTE = 5120;
const COMPONENT_UNSIGNED_BYTE = 5121;
const COMPONENT_SHORT = 5122;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;
const COMPONENT_FLOAT = 5126;

const TYPE_NUM_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export type GltfMesh = {
  positions: Float32Array<ArrayBuffer>; // vec3 x N
  normals: Float32Array<ArrayBuffer>; // vec3 x N
  joints: Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer>; // vec4 x N (stored, not yet uploaded)
  weights: Float32Array<ArrayBuffer>; // vec4 x N (stored, not yet uploaded)
  indices: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
  vertexCount: number;
  triangleCount: number;
};

export type Joint = {
  name: string;
  parentIdx: number; // -1 for root
  translation: [number, number, number];
  rotation: [number, number, number, number]; // quaternion xyzw
  scale: [number, number, number];
};

export type GltfSkeleton = {
  joints: Joint[];
  inverseBindMatrices: Float32Array<ArrayBuffer>; // 16 x jointCount, column-major
};

export type AnimationInterpolation = "LINEAR" | "STEP" | "CUBICSPLINE";

export type AnimationPath = "translation" | "rotation" | "scale";

export type AnimationChannel = {
  jointIndex: number; // index into the skeleton's (topo-sorted) joints array
  path: AnimationPath;
  times: Float32Array; // sample times in seconds, monotonic
  values: Float32Array; // flat: [x,y,z, ...] for T/S, [x,y,z,w, ...] for R
  interpolation: AnimationInterpolation;
};

export type Animation = {
  name: string;
  duration: number; // seconds; max(times) across all channels
  channels: AnimationChannel[];
};

export type GltfDocument = {
  mesh: GltfMesh;
  skeleton: GltfSkeleton | null;
  animations: Animation[];
};

// Minimal subset of the glTF JSON manifest we actually read.
type GltfJson = {
  meshes?: Array<{
    name?: string;
    primitives: Array<{
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
    }>;
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  buffers?: Array<{ byteLength: number; uri?: string }>;
  skins?: Array<{
    inverseBindMatrices?: number;
    joints: number[];
    skeleton?: number;
    name?: string;
  }>;
  nodes?: Array<{
    name?: string;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    mesh?: number;
    skin?: number;
  }>;
  animations?: Array<{
    name?: string;
    channels: Array<{
      sampler: number;
      target: { node?: number; path: string };
    }>;
    samplers: Array<{
      input: number;
      output: number;
      interpolation?: string;
    }>;
  }>;
};

export async function loadGLB(url: string): Promise<GltfDocument> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `loadGLB: failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const buffer = await response.arrayBuffer();
  const { json, bin } = parseGlbContainer(buffer);
  const mesh = extractMesh(json, bin);
  const skinResult = extractSkeleton(json, bin);
  const skeleton = skinResult ? skinResult.skeleton : null;
  const animations = skinResult
    ? extractAnimations(json, bin, skinResult.nodeToJointIdx)
    : [];
  return { mesh, skeleton, animations };
}

function parseGlbContainer(buffer: ArrayBuffer): {
  json: GltfJson;
  bin: Uint8Array;
} {
  if (buffer.byteLength < 12) {
    throw new Error("GLB: file shorter than the 12-byte header");
  }
  const header = new DataView(buffer, 0, 12);
  const magic = header.getUint32(0, true);
  const version = header.getUint32(4, true);
  const totalLength = header.getUint32(8, true);
  if (magic !== GLB_MAGIC) {
    throw new Error(
      `GLB: bad magic 0x${magic.toString(16)} (expected 0x46546c67)`,
    );
  }
  if (version !== 2) {
    throw new Error(`GLB: unsupported version ${version} (expected 2)`);
  }
  if (totalLength > buffer.byteLength) {
    throw new Error(
      `GLB: header says ${totalLength} bytes but only ${buffer.byteLength} were fetched`,
    );
  }

  // First chunk must be JSON.
  const firstChunkHeader = new DataView(buffer, 12, 8);
  const jsonChunkLength = firstChunkHeader.getUint32(0, true);
  const jsonChunkType = firstChunkHeader.getUint32(4, true);
  if (jsonChunkType !== CHUNK_TYPE_JSON) {
    throw new Error(
      `GLB: first chunk type 0x${jsonChunkType.toString(16)} is not JSON`,
    );
  }
  const jsonStart = 20;
  const jsonEnd = jsonStart + jsonChunkLength;
  if (jsonEnd > buffer.byteLength) {
    throw new Error("GLB: JSON chunk exceeds file length");
  }
  const jsonBytes = new Uint8Array(buffer, jsonStart, jsonChunkLength);
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(jsonBytes)) as GltfJson;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GLB: failed to parse JSON chunk: ${message}`);
  }

  // Second chunk (optional in spec, required for our pigeon) is BIN.
  let bin = new Uint8Array(0);
  if (jsonEnd + 8 <= buffer.byteLength) {
    const binChunkHeader = new DataView(buffer, jsonEnd, 8);
    const binChunkLength = binChunkHeader.getUint32(0, true);
    const binChunkType = binChunkHeader.getUint32(4, true);
    if (binChunkType === CHUNK_TYPE_BIN) {
      const binStart = jsonEnd + 8;
      const binEnd = binStart + binChunkLength;
      if (binEnd > buffer.byteLength) {
        throw new Error("GLB: BIN chunk exceeds file length");
      }
      bin = new Uint8Array(buffer, binStart, binChunkLength);
    }
  }
  return { json, bin };
}

// Slice a typed array out of the BIN chunk for the given accessor.
// Returns a *copy* aligned to its component size so the caller can safely
// build a new typed array view without worrying about source alignment.
function readAccessor(
  json: GltfJson,
  bin: Uint8Array,
  accessorIdx: number,
  fieldPath: string,
): {
  componentType: number;
  count: number;
  numComponents: number;
  buffer: ArrayBuffer;
} {
  const accessors = json.accessors ?? [];
  const bufferViews = json.bufferViews ?? [];
  const accessor = accessors[accessorIdx];
  if (!accessor) {
    throw new Error(`glTF: missing accessor ${accessorIdx} (at ${fieldPath})`);
  }
  if (accessor.bufferView === undefined) {
    throw new Error(
      `glTF: accessor ${accessorIdx} has no bufferView (at ${fieldPath}); sparse accessors not supported`,
    );
  }
  const bufferView = bufferViews[accessor.bufferView];
  if (!bufferView) {
    throw new Error(
      `glTF: missing bufferView ${accessor.bufferView} for accessor ${accessorIdx} (at ${fieldPath})`,
    );
  }
  const numComponents = TYPE_NUM_COMPONENTS[accessor.type];
  if (numComponents === undefined) {
    throw new Error(
      `glTF: unsupported accessor type ${accessor.type} (at ${fieldPath})`,
    );
  }
  const componentByteSize = componentByteSizeOf(accessor.componentType);
  if (componentByteSize === 0) {
    throw new Error(
      `glTF: unsupported componentType ${accessor.componentType} (at ${fieldPath})`,
    );
  }
  const elementByteSize = componentByteSize * numComponents;
  const totalBytes = elementByteSize * accessor.count;
  const bvByteOffset = bufferView.byteOffset ?? 0;
  const accByteOffset = accessor.byteOffset ?? 0;
  const start = bvByteOffset + accByteOffset;
  if (start + totalBytes > bin.byteLength) {
    throw new Error(
      `glTF: accessor ${accessorIdx} reads past end of BIN chunk (at ${fieldPath})`,
    );
  }
  // Copy into a fresh ArrayBuffer so the resulting typed array can assume
  // alignment from offset 0 (Float32Array etc. require 4-byte alignment),
  // and so the typed array keeps the concrete `ArrayBuffer` type expected
  // by WebGPU's `writeBuffer` typings.
  const ab = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(ab);
  bytes.set(bin.subarray(start, start + totalBytes));
  return {
    componentType: accessor.componentType,
    count: accessor.count,
    numComponents,
    buffer: ab,
  };
}

function componentByteSizeOf(componentType: number): number {
  switch (componentType) {
    case COMPONENT_BYTE:
    case COMPONENT_UNSIGNED_BYTE:
      return 1;
    case COMPONENT_SHORT:
    case COMPONENT_UNSIGNED_SHORT:
      return 2;
    case COMPONENT_UNSIGNED_INT:
    case COMPONENT_FLOAT:
      return 4;
    default:
      return 0;
  }
}

function readFloat32(
  json: GltfJson,
  bin: Uint8Array,
  accessorIdx: number,
  fieldPath: string,
  expectedComponents: number,
): Float32Array<ArrayBuffer> {
  const a = readAccessor(json, bin, accessorIdx, fieldPath);
  if (a.componentType !== COMPONENT_FLOAT) {
    throw new Error(
      `glTF: expected FLOAT componentType at ${fieldPath}, got ${a.componentType}`,
    );
  }
  if (a.numComponents !== expectedComponents) {
    throw new Error(
      `glTF: expected ${expectedComponents} components per element at ${fieldPath}, got ${a.numComponents}`,
    );
  }
  return new Float32Array(a.buffer, 0, a.count * a.numComponents);
}

function readJoints(
  json: GltfJson,
  bin: Uint8Array,
  accessorIdx: number,
  fieldPath: string,
): Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> {
  const a = readAccessor(json, bin, accessorIdx, fieldPath);
  if (a.numComponents !== 4) {
    throw new Error(
      `glTF: JOINTS_0 must be VEC4 (at ${fieldPath}), got ${a.numComponents} components`,
    );
  }
  if (a.componentType === COMPONENT_UNSIGNED_BYTE) {
    return new Uint8Array(a.buffer, 0, a.count * 4);
  }
  if (a.componentType === COMPONENT_UNSIGNED_SHORT) {
    return new Uint16Array(a.buffer, 0, a.count * 4);
  }
  throw new Error(
    `glTF: JOINTS_0 componentType ${a.componentType} not supported (at ${fieldPath})`,
  );
}

function readIndices(
  json: GltfJson,
  bin: Uint8Array,
  accessorIdx: number,
  fieldPath: string,
): Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer> {
  const a = readAccessor(json, bin, accessorIdx, fieldPath);
  if (a.numComponents !== 1) {
    throw new Error(
      `glTF: indices must be SCALAR (at ${fieldPath}), got ${a.numComponents} components`,
    );
  }
  if (a.componentType === COMPONENT_UNSIGNED_SHORT) {
    return new Uint16Array(a.buffer, 0, a.count);
  }
  if (a.componentType === COMPONENT_UNSIGNED_INT) {
    return new Uint32Array(a.buffer, 0, a.count);
  }
  if (a.componentType === COMPONENT_UNSIGNED_BYTE) {
    // Spec allows ubyte indices; widen to uint16 for WebGPU compatibility.
    const src = new Uint8Array(a.buffer, 0, a.count);
    const widened = new Uint16Array(a.count);
    for (let i = 0; i < a.count; i++) {
      widened[i] = src[i];
    }
    return widened;
  }
  throw new Error(
    `glTF: indices componentType ${a.componentType} not supported (at ${fieldPath})`,
  );
}

function extractMesh(json: GltfJson, bin: Uint8Array): GltfMesh {
  const meshes = json.meshes ?? [];
  if (meshes.length === 0) {
    throw new Error("glTF: meshes[0] not present");
  }
  const primitives = meshes[0].primitives;
  if (!primitives || primitives.length === 0) {
    throw new Error("glTF: meshes[0].primitives is empty");
  }
  const prim = primitives[0];
  const attrs = prim.attributes ?? {};
  const posIdx = attrs.POSITION;
  const nrmIdx = attrs.NORMAL;
  const jntIdx = attrs.JOINTS_0;
  const wgtIdx = attrs.WEIGHTS_0;
  if (posIdx === undefined) {
    throw new Error(
      "glTF: meshes[0].primitives[0].attributes.POSITION missing",
    );
  }
  if (nrmIdx === undefined) {
    throw new Error("glTF: meshes[0].primitives[0].attributes.NORMAL missing");
  }
  // JOINTS_0 / WEIGHTS_0 are only required for skinned meshes. Models exported
  // without an armature (e.g. the Sketchfab "Flying Bird" whose animation is
  // node-based and gets baked entirely into VAT) legitimately omit them.
  // We accept the absence, fall back to zero-filled arrays so downstream
  // typing stays the same, and let the runtime decide whether to consume them.
  if (prim.indices === undefined) {
    throw new Error("glTF: meshes[0].primitives[0].indices missing");
  }

  const positions = readFloat32(
    json,
    bin,
    posIdx,
    "meshes[0].primitives[0].attributes.POSITION",
    3,
  );
  const normals = readFloat32(
    json,
    bin,
    nrmIdx,
    "meshes[0].primitives[0].attributes.NORMAL",
    3,
  );
  const vertexCount = positions.length / 3;

  const joints: Uint8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> =
    jntIdx !== undefined
      ? readJoints(
          json,
          bin,
          jntIdx,
          "meshes[0].primitives[0].attributes.JOINTS_0",
        )
      : new Uint8Array(new ArrayBuffer(vertexCount * 4));
  const weights: Float32Array<ArrayBuffer> =
    wgtIdx !== undefined
      ? readFloat32(
          json,
          bin,
          wgtIdx,
          "meshes[0].primitives[0].attributes.WEIGHTS_0",
          4,
        )
      : new Float32Array(new ArrayBuffer(vertexCount * 4 * 4));
  const indices = readIndices(
    json,
    bin,
    prim.indices,
    "meshes[0].primitives[0].indices",
  );

  if (
    normals.length / 3 !== vertexCount ||
    joints.length / 4 !== vertexCount ||
    weights.length / 4 !== vertexCount
  ) {
    throw new Error(
      `glTF: vertex attribute counts disagree (positions=${vertexCount}, normals=${normals.length / 3}, joints=${joints.length / 4}, weights=${weights.length / 4})`,
    );
  }
  if (indices.length % 3 !== 0) {
    throw new Error(
      `glTF: index count ${indices.length} is not a multiple of 3 (triangle list expected)`,
    );
  }

  return {
    positions,
    normals,
    joints,
    weights,
    indices,
    vertexCount,
    triangleCount: indices.length / 3,
  };
}

function extractSkeleton(
  json: GltfJson,
  bin: Uint8Array,
): { skeleton: GltfSkeleton; nodeToJointIdx: Map<number, number> } | null {
  const skins = json.skins ?? [];
  if (skins.length === 0) {
    return null;
  }
  const skin = skins[0];
  const nodes = json.nodes ?? [];
  const jointNodeIndices = skin.joints;

  // Build child -> parent map across the skin's joint set. A joint's parent
  // is whichever joint-node lists it as a child. Joints whose parent is not
  // itself a joint are treated as roots (parentIdx = -1).
  const nodeToJointIdx = new Map<number, number>();
  for (let i = 0; i < jointNodeIndices.length; i++) {
    nodeToJointIdx.set(jointNodeIndices[i], i);
  }
  const parentByJointIdx: number[] = new Array(jointNodeIndices.length).fill(
    -1,
  );
  for (let parentJointIdx = 0; parentJointIdx < jointNodeIndices.length; parentJointIdx++) {
    const parentNode = nodes[jointNodeIndices[parentJointIdx]];
    if (!parentNode || !parentNode.children) continue;
    for (const childNodeIdx of parentNode.children) {
      const childJointIdx = nodeToJointIdx.get(childNodeIdx);
      if (childJointIdx !== undefined) {
        parentByJointIdx[childJointIdx] = parentJointIdx;
      }
    }
  }

  // Build joints in original order first, then topologically sort so parents
  // precede children. The animation/skinning code in PR4+ relies on that
  // ordering for a single forward sweep when computing world matrices.
  const rawJoints: Joint[] = jointNodeIndices.map((nodeIdx, i) => {
    const node = nodes[nodeIdx];
    if (!node) {
      throw new Error(
        `glTF: skins[0].joints[${i}] references missing node ${nodeIdx}`,
      );
    }
    const t = node.translation;
    const r = node.rotation;
    const s = node.scale;
    return {
      name: node.name ?? `joint_${i}`,
      parentIdx: parentByJointIdx[i],
      translation:
        t && t.length === 3 ? [t[0], t[1], t[2]] : [0, 0, 0],
      rotation:
        r && r.length === 4 ? [r[0], r[1], r[2], r[3]] : [0, 0, 0, 1],
      scale: s && s.length === 3 ? [s[0], s[1], s[2]] : [1, 1, 1],
    };
  });

  const sortedJoints = topoSortJoints(rawJoints);

  let inverseBindMatrices: Float32Array<ArrayBuffer>;
  if (skin.inverseBindMatrices !== undefined) {
    const ibmRaw = readFloat32(
      json,
      bin,
      skin.inverseBindMatrices,
      "skins[0].inverseBindMatrices",
      16,
    );
    if (ibmRaw.length !== rawJoints.length * 16) {
      throw new Error(
        `glTF: inverseBindMatrices length ${ibmRaw.length} does not match jointCount*16 (${rawJoints.length * 16})`,
      );
    }
    // The IBM array is indexed by the *original* joint order. After
    // topological sort we permute it to match the new ordering.
    inverseBindMatrices = new Float32Array(rawJoints.length * 16);
    for (let newIdx = 0; newIdx < sortedJoints.length; newIdx++) {
      const oldIdx = sortedJoints[newIdx].originalIdx;
      inverseBindMatrices.set(
        ibmRaw.subarray(oldIdx * 16, oldIdx * 16 + 16),
        newIdx * 16,
      );
    }
  } else {
    // Spec default: identity matrices when inverseBindMatrices is omitted.
    inverseBindMatrices = new Float32Array(rawJoints.length * 16);
    for (let i = 0; i < rawJoints.length; i++) {
      inverseBindMatrices[i * 16 + 0] = 1;
      inverseBindMatrices[i * 16 + 5] = 1;
      inverseBindMatrices[i * 16 + 10] = 1;
      inverseBindMatrices[i * 16 + 15] = 1;
    }
  }

  // Map glTF node index -> the *new* joint index in the topologically sorted
  // joint array. Used by extractAnimations to resolve channel targets, and
  // useful in general for linking animation/skin data back to nodes.
  const nodeToSortedJointIdx = new Map<number, number>();
  for (let newIdx = 0; newIdx < sortedJoints.length; newIdx++) {
    const oldIdx = sortedJoints[newIdx].originalIdx;
    nodeToSortedJointIdx.set(jointNodeIndices[oldIdx], newIdx);
  }

  return {
    skeleton: {
      joints: sortedJoints.map((j) => j.joint),
      inverseBindMatrices,
    },
    nodeToJointIdx: nodeToSortedJointIdx,
  };
}

function extractAnimations(
  json: GltfJson,
  bin: Uint8Array,
  nodeToJointIdx: Map<number, number>,
): Animation[] {
  const animations = json.animations ?? [];
  if (animations.length === 0) {
    return [];
  }
  const result: Animation[] = [];
  for (let ai = 0; ai < animations.length; ai++) {
    const anim = animations[ai];
    const samplers = anim.samplers ?? [];
    const fieldRoot = `animations[${ai}]`;
    const channels: AnimationChannel[] = [];
    for (let ci = 0; ci < anim.channels.length; ci++) {
      const ch = anim.channels[ci];
      const fieldPath = `${fieldRoot}.channels[${ci}]`;
      const targetNode = ch.target?.node;
      const path = ch.target?.path;
      if (targetNode === undefined || path === undefined) {
        // Channels without a target node are no-ops; skip silently.
        continue;
      }
      if (path === "weights") {
        // Morph-target weight animation is out of scope for our pigeon.
        // Skip with a warning so the next maintainer notices if it appears.
        console.warn(
          `glTF: ${fieldPath} targets morph weights; skipping (not supported)`,
        );
        continue;
      }
      if (path !== "translation" && path !== "rotation" && path !== "scale") {
        console.warn(
          `glTF: ${fieldPath} has unknown path ${path}; skipping`,
        );
        continue;
      }
      const jointIndex = nodeToJointIdx.get(targetNode);
      if (jointIndex === undefined) {
        // Channel targets a node that is not part of the skin's joint set.
        // We have no way to apply it through the joint matrices, so drop it.
        console.warn(
          `glTF: ${fieldPath} targets node ${targetNode} which is not a skin joint; skipping`,
        );
        continue;
      }
      const sampler = samplers[ch.sampler];
      if (!sampler) {
        throw new Error(
          `glTF: ${fieldPath} references missing sampler ${ch.sampler}`,
        );
      }
      const interpolationRaw = sampler.interpolation ?? "LINEAR";
      if (
        interpolationRaw !== "LINEAR" &&
        interpolationRaw !== "STEP" &&
        interpolationRaw !== "CUBICSPLINE"
      ) {
        throw new Error(
          `glTF: ${fieldPath} sampler has unknown interpolation ${interpolationRaw}`,
        );
      }
      // TODO: support CUBICSPLINE. Its output stride is 3x (in-tangent, value,
      // out-tangent per keyframe) and the evaluator differs. The PR2 asset is
      // LINEAR / STEP only, so we throw loudly if any future asset uses it.
      if (interpolationRaw === "CUBICSPLINE") {
        throw new Error(
          `glTF: ${fieldPath} uses CUBICSPLINE interpolation; not yet supported`,
        );
      }
      const times = readFloat32(
        json,
        bin,
        sampler.input,
        `${fieldPath}.sampler.input`,
        1,
      );
      const expectedComponents = path === "rotation" ? 4 : 3;
      const values = readFloat32(
        json,
        bin,
        sampler.output,
        `${fieldPath}.sampler.output`,
        expectedComponents,
      );
      if (values.length !== times.length * expectedComponents) {
        throw new Error(
          `glTF: ${fieldPath} sampler output length ${values.length} mismatches times*${expectedComponents} (=${times.length * expectedComponents})`,
        );
      }
      channels.push({
        jointIndex,
        path,
        times,
        values,
        interpolation: interpolationRaw,
      });
    }
    let duration = 0;
    for (const ch of channels) {
      if (ch.times.length === 0) continue;
      const last = ch.times[ch.times.length - 1];
      if (last > duration) duration = last;
    }
    result.push({
      name: anim.name ?? `animation_${ai}`,
      duration,
      channels,
    });
  }
  return result;
}

// Topological sort by parentIdx. Returns the new order plus a back-reference
// to each joint's original index so we can permute associated arrays
// (inverse-bind matrices, animation channels later).
function topoSortJoints(
  joints: readonly Joint[],
): Array<{ joint: Joint; originalIdx: number }> {
  const visited = new Uint8Array(joints.length);
  const result: Array<{ joint: Joint; originalIdx: number }> = [];
  const oldToNew = new Map<number, number>();

  const visit = (i: number, depth: number): void => {
    if (visited[i]) return;
    if (depth > joints.length) {
      throw new Error(
        "glTF: joint hierarchy contains a cycle or exceeds depth limit",
      );
    }
    const parent = joints[i].parentIdx;
    if (parent !== -1) {
      visit(parent, depth + 1);
    }
    visited[i] = 1;
    oldToNew.set(i, result.length);
    result.push({ joint: joints[i], originalIdx: i });
  };

  for (let i = 0; i < joints.length; i++) {
    visit(i, 0);
  }

  // Rewrite parentIdx so it points into the new (sorted) array.
  return result.map((entry) => ({
    originalIdx: entry.originalIdx,
    joint: {
      ...entry.joint,
      parentIdx:
        entry.joint.parentIdx === -1
          ? -1
          : (oldToNew.get(entry.joint.parentIdx) ?? -1),
    },
  }));
}
