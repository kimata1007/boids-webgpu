"""Bake the Sketchfab "Flying Bird" model into the project's VAT pipeline.

Source: https://sketchfab.com/3d-models/flying-bird-eb843194e06d429ebef7dd4aa7e265c1
Author: sandeep.s
License: CC-BY 4.0

The source asset has 3 separate meshes (Body, Left Wing, Right Wing) animated
purely by per-object node transforms (no armature). Strategy:

1. Sample world-space vertex positions of each mesh at NUM_FRAMES evenly
   spaced frames, concatenated in deterministic order, into a float16
   rgba texture (Vertex Animation Texture).

2. Build a static, joined mesh whose vertex positions are bit-identical to
   VAT[0] (the bind pose row) by reading the same world-space coords. We
   write the GLB ourselves using struct/json -- Blender's glTF exporter
   silently rescales/axis-flips coordinates, which broke alignment with
   VAT in earlier attempts.

The runtime samples positions from VAT exclusively; the static GLB is used
for index buffer and per-vertex normals only.

Run with:
    /Applications/Blender.app/Contents/MacOS/Blender --background \\
        --python tools/bake_flying_bird.py
"""

import json
import os
import struct
import sys

import bmesh
import bpy

try:
    import numpy as np
except ImportError:
    print("ERROR: numpy is not available in this Blender's Python.", file=sys.stderr)
    sys.exit(1)


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INPUT_GLB = os.path.normpath(
    os.path.join(SCRIPT_DIR, "..", "public", "sketchfab", "flying_bird.glb")
)
OUT_STATIC_GLB = os.path.normpath(
    os.path.join(SCRIPT_DIR, "..", "public", "flying_bird_static.glb")
)
OUT_VAT_BIN = os.path.normpath(
    os.path.join(SCRIPT_DIR, "..", "public", "flying_bird_vat.bin")
)
OUT_VAT_JSON = os.path.normpath(
    os.path.join(SCRIPT_DIR, "..", "public", "flying_bird_vat.json")
)

NUM_FRAMES = 32

GLB_MAGIC = 0x46546C67  # "glTF"
JSON_CHUNK_TYPE = 0x4E4F534A  # "JSON"
BIN_CHUNK_TYPE = 0x004E4942  # "BIN\0"


def main() -> int:
    if not os.path.isfile(INPUT_GLB):
        print(f"ERROR: input not found: {INPUT_GLB}", file=sys.stderr)
        return 1

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=INPUT_GLB)

    mesh_objs = sorted(
        [obj for obj in bpy.data.objects if obj.type == "MESH"],
        key=lambda o: o.name,
    )
    if not mesh_objs:
        print("ERROR: no mesh objects after import", file=sys.stderr)
        return 1

    print(f"Found {len(mesh_objs)} mesh objects (deterministic order):")
    for obj in mesh_objs:
        print(f"  - {obj.name}: {len(obj.data.vertices)} vertices")

    scene = bpy.context.scene
    start = scene.frame_start
    end = scene.frame_end
    fps = scene.render.fps / scene.render.fps_base
    span_frames = max(end - start, 1)
    duration_seconds = span_frames / fps
    print(
        f"Animation: frames [{start}..{end}], fps={fps:.3f}, "
        f"duration={duration_seconds:.3f}s"
    )

    total_verts = sum(len(obj.data.vertices) for obj in mesh_objs)
    print(f"Total vertices across all meshes: {total_verts}")

    # ---- VAT bake ----
    data = np.zeros((NUM_FRAMES, total_verts, 4), dtype=np.float16)
    frame_samples = [
        start + round(i * span_frames / NUM_FRAMES) for i in range(NUM_FRAMES)
    ]
    print(f"Sampling frames: {frame_samples[:6]}...{frame_samples[-2:]}")

    for f_idx, frame_num in enumerate(frame_samples):
        scene.frame_set(frame_num)
        deps = bpy.context.evaluated_depsgraph_get()
        v_offset = 0
        for obj in mesh_objs:
            eval_obj = obj.evaluated_get(deps)
            me = eval_obj.data
            wm = eval_obj.matrix_world
            for i, v in enumerate(me.vertices):
                world_co = wm @ v.co
                data[f_idx, v_offset + i, 0] = world_co.x
                data[f_idx, v_offset + i, 1] = world_co.y
                data[f_idx, v_offset + i, 2] = world_co.z
                data[f_idx, v_offset + i, 3] = 0.0
            v_offset += len(me.vertices)

    with open(OUT_VAT_BIN, "wb") as f:
        f.write(data.tobytes())
    actual_size = os.path.getsize(OUT_VAT_BIN)
    expected_size = NUM_FRAMES * total_verts * 8
    if actual_size != expected_size:
        print(
            f"WARN: VAT size {actual_size} != expected {expected_size}",
            file=sys.stderr,
        )
    print(f"VAT bin: {OUT_VAT_BIN} ({actual_size} bytes)")

    # ---- Build static joined mesh aligned bit-for-bit with VAT[0] ----
    scene.frame_set(start)
    deps = bpy.context.evaluated_depsgraph_get()

    bm = bmesh.new()
    bm_verts = []
    v_offset_per_obj = []
    cumulative = 0

    for obj in mesh_objs:
        v_offset_per_obj.append(cumulative)
        eval_obj = obj.evaluated_get(deps)
        me = eval_obj.data
        for i in range(len(me.vertices)):
            x = float(data[0, cumulative + i, 0])
            y = float(data[0, cumulative + i, 1])
            z = float(data[0, cumulative + i, 2])
            bm_verts.append(bm.verts.new((x, y, z)))
        cumulative += len(me.vertices)
    bm.verts.ensure_lookup_table()

    skipped_faces = 0
    for obj_idx, obj in enumerate(mesh_objs):
        eval_obj = obj.evaluated_get(deps)
        me = eval_obj.data
        offset = v_offset_per_obj[obj_idx]
        for poly in me.polygons:
            face_verts = [bm_verts[offset + i] for i in poly.vertices]
            try:
                bm.faces.new(face_verts)
            except ValueError:
                skipped_faces += 1
    if skipped_faces:
        print(f"NOTE: skipped {skipped_faces} duplicate/degenerate faces")

    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    joined_mesh = bpy.data.meshes.new("Bird_Joined")
    bm.to_mesh(joined_mesh)
    bm.free()
    joined_mesh.update()

    positions = np.array(
        [(v.co.x, v.co.y, v.co.z) for v in joined_mesh.vertices], dtype=np.float32
    )
    normals = np.array(
        [(v.normal.x, v.normal.y, v.normal.z) for v in joined_mesh.vertices],
        dtype=np.float32,
    )
    indices_list = []
    for p in joined_mesh.polygons:
        if len(p.vertices) != 3:
            print(
                f"WARN: non-triangle polygon with {len(p.vertices)} verts after triangulate",
                file=sys.stderr,
            )
            continue
        indices_list.extend(p.vertices)
    indices = np.array(indices_list, dtype=np.uint16)

    if len(positions) != total_verts:
        print(
            f"ERROR: joined mesh vertex count {len(positions)} != VAT total {total_verts};"
            " vertex_index<->VAT alignment will break.",
            file=sys.stderr,
        )
        return 2

    print(f"Static mesh: {len(positions)} vertices, {len(indices) // 3} triangles")
    pos_min = positions.min(axis=0)
    pos_max = positions.max(axis=0)
    print(
        f"Position range: x=[{pos_min[0]:.3f}..{pos_max[0]:.3f}] "
        f"y=[{pos_min[1]:.3f}..{pos_max[1]:.3f}] "
        f"z=[{pos_min[2]:.3f}..{pos_max[2]:.3f}]"
    )

    glb_bytes = build_glb_minimal(positions, normals, indices)
    with open(OUT_STATIC_GLB, "wb") as f:
        f.write(glb_bytes)
    print(f"Static GLB: {OUT_STATIC_GLB} ({len(glb_bytes)} bytes)")

    # ---- VAT metadata sidecar ----
    with open(OUT_VAT_JSON, "w") as f:
        json.dump(
            {
                "numFrames": NUM_FRAMES,
                "vertexCount": int(total_verts),
                "format": "rgba16f",
                "duration": round(duration_seconds, 6),
                "modelExtent": {
                    "min": pos_min.tolist(),
                    "max": pos_max.tolist(),
                },
                "source": {
                    "name": "Flying Bird",
                    "author": "sandeep.s",
                    "license": "CC-BY 4.0",
                    "url": (
                        "https://sketchfab.com/3d-models/"
                        "flying-bird-eb843194e06d429ebef7dd4aa7e265c1"
                    ),
                },
            },
            f,
            indent=2,
        )
    print(f"VAT json: {OUT_VAT_JSON}")

    return 0


def build_glb_minimal(
    positions: "np.ndarray", normals: "np.ndarray", indices: "np.ndarray"
) -> bytes:
    """Hand-write a glTF 2.0 GLB with one mesh primitive.

    Layout: POSITION (vec3 f32), NORMAL (vec3 f32), INDICES (uint16),
    TRIANGLES topology, no materials, no textures, no animations.
    """
    pos_bytes = positions.astype(np.float32, copy=False).tobytes()
    nrm_bytes = normals.astype(np.float32, copy=False).tobytes()
    idx_bytes = indices.astype(np.uint16, copy=False).tobytes()
    idx_pad = (4 - len(idx_bytes) % 4) % 4
    idx_bytes_padded = idx_bytes + b"\x00" * idx_pad

    pos_offset = 0
    nrm_offset = pos_offset + len(pos_bytes)
    idx_offset = nrm_offset + len(nrm_bytes)
    bin_total = idx_offset + len(idx_bytes_padded)

    pos_min = positions.min(axis=0).astype(float).tolist()
    pos_max = positions.max(axis=0).astype(float).tolist()

    gltf_json = {
        "asset": {"version": "2.0", "generator": "bake_flying_bird.py"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [
            {
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1},
                        "indices": 2,
                        "mode": 4,  # TRIANGLES
                    }
                ]
            }
        ],
        "buffers": [{"byteLength": bin_total}],
        "bufferViews": [
            {
                "buffer": 0,
                "byteOffset": pos_offset,
                "byteLength": len(pos_bytes),
                "target": 34962,  # ARRAY_BUFFER
            },
            {
                "buffer": 0,
                "byteOffset": nrm_offset,
                "byteLength": len(nrm_bytes),
                "target": 34962,
            },
            {
                "buffer": 0,
                "byteOffset": idx_offset,
                "byteLength": len(idx_bytes),
                "target": 34963,  # ELEMENT_ARRAY_BUFFER
            },
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,  # FLOAT
                "count": int(len(positions)),
                "type": "VEC3",
                "min": pos_min,
                "max": pos_max,
            },
            {
                "bufferView": 1,
                "componentType": 5126,
                "count": int(len(normals)),
                "type": "VEC3",
            },
            {
                "bufferView": 2,
                "componentType": 5123,  # UNSIGNED_SHORT
                "count": int(len(indices)),
                "type": "SCALAR",
            },
        ],
    }

    json_bytes = json.dumps(gltf_json, separators=(",", ":")).encode("utf-8")
    json_pad = (4 - len(json_bytes) % 4) % 4
    json_bytes_padded = json_bytes + b" " * json_pad

    bin_data = pos_bytes + nrm_bytes + idx_bytes_padded
    json_chunk_len = len(json_bytes_padded)
    bin_chunk_len = len(bin_data)
    total_len = 12 + 8 + json_chunk_len + 8 + bin_chunk_len

    out = bytearray()
    out += struct.pack("<III", GLB_MAGIC, 2, total_len)
    out += struct.pack("<II", json_chunk_len, JSON_CHUNK_TYPE)
    out += json_bytes_padded
    out += struct.pack("<II", bin_chunk_len, BIN_CHUNK_TYPE)
    out += bin_data
    return bytes(out)


if __name__ == "__main__":
    sys.exit(main())
