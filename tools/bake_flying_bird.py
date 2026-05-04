"""Bake the Sketchfab "Flying Bird" model into the project's VAT pipeline.

Source: https://sketchfab.com/3d-models/flying-bird-eb843194e06d429ebef7dd4aa7e265c1
Author: sandeep.s
License: CC-BY 4.0

The source asset has 3 separate meshes (body, left wing, right wing) animated by
node-level transforms (no armature/skinning). This script:

1. Imports the .glb
2. For each VAT frame, evaluates every mesh object with the current pose, applies
   the world matrix, and concatenates vertices in a deterministic order
3. Writes the per-frame positions to public/flying_bird_vat.bin (rgba16f)
4. Writes public/flying_bird_vat.json with metadata
5. At frame 1, applies world transforms, strips materials, joins the 3 meshes,
   and exports public/flying_bird_static.glb as the runtime base topology

The vertex ordering used by the VAT MUST match the order in the static GLB so
that vertex_index in the shader picks the correct VAT row.

Run with:
    /Applications/Blender.app/Contents/MacOS/Blender --background \\
        --python tools/bake_flying_bird.py
"""

import json
import os
import sys

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


def main() -> int:
    if not os.path.isfile(INPUT_GLB):
        print(f"ERROR: input not found: {INPUT_GLB}", file=sys.stderr)
        return 1

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=INPUT_GLB)

    # Collect mesh objects in deterministic order (sorted by name).
    mesh_objs = sorted(
        [obj for obj in bpy.data.objects if obj.type == "MESH"],
        key=lambda o: o.name,
    )
    if not mesh_objs:
        print("ERROR: no mesh objects found after import", file=sys.stderr)
        return 1

    print(f"Found {len(mesh_objs)} mesh objects:")
    for obj in mesh_objs:
        print(f"  - {obj.name}: {len(obj.data.vertices)} vertices")

    scene = bpy.context.scene
    start = scene.frame_start
    end = scene.frame_end
    fps = scene.render.fps / scene.render.fps_base
    span_frames = max(end - start, 1)
    duration_seconds = span_frames / fps
    print(f"Animation: frames [{start}..{end}], fps={fps:.3f}, duration={duration_seconds:.3f}s")

    total_verts = sum(len(obj.data.vertices) for obj in mesh_objs)
    print(f"Total vertices across all meshes: {total_verts}")

    # Allocate VAT: [frame][vertex][rgba16f]
    data = np.zeros((NUM_FRAMES, total_verts, 4), dtype=np.float16)

    # Sample frames evenly across the action so the loop tiles cleanly.
    frame_samples = [
        start + round(i * span_frames / NUM_FRAMES) for i in range(NUM_FRAMES)
    ]
    print(f"Sampling frames: {frame_samples[:8]}...{frame_samples[-2:]}")

    # Step 1: bake VAT (must happen BEFORE we mutate the scene with apply/join)
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
    expected_size = NUM_FRAMES * total_verts * 8
    actual_size = os.path.getsize(OUT_VAT_BIN)
    if actual_size != expected_size:
        print(
            f"WARN: VAT size mismatch: expected {expected_size}, got {actual_size}",
            file=sys.stderr,
        )

    with open(OUT_VAT_JSON, "w") as f:
        json.dump(
            {
                "numFrames": NUM_FRAMES,
                "vertexCount": total_verts,
                "format": "rgba16f",
                "duration": round(duration_seconds, 6),
                "source": {
                    "name": "Flying Bird",
                    "author": "sandeep.s",
                    "license": "CC-BY 4.0",
                    "url": "https://sketchfab.com/3d-models/flying-bird-eb843194e06d429ebef7dd4aa7e265c1",
                },
            },
            f,
            indent=2,
        )

    print(f"VAT bin: {OUT_VAT_BIN} ({actual_size} bytes)")
    print(f"VAT json: {OUT_VAT_JSON}")

    # Step 2: build the static joined GLB at frame 1 for runtime base topology.
    scene.frame_set(start)

    # Strip materials so post-join becomes a single primitive (simpler loader).
    for obj in mesh_objs:
        obj.data.materials.clear()

    # Apply world transforms so vertex positions in the GLB == frame-1 VAT row.
    for obj in mesh_objs:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Join all meshes (active object becomes the merged result).
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objs[0]
    bpy.ops.object.join()
    joined = bpy.context.active_object
    joined.name = "Bird_Joined"
    joined.data.name = "Bird_Joined_Mesh"

    # Verify joined vertex count matches what we baked.
    joined_count = len(joined.data.vertices)
    if joined_count != total_verts:
        print(
            f"WARN: joined vertex count {joined_count} != baked {total_verts}; "
            "vertex_index<->VAT alignment may break.",
            file=sys.stderr,
        )

    # Export only the joined mesh, no animation/skin.
    bpy.ops.object.select_all(action="DESELECT")
    joined.select_set(True)
    bpy.context.view_layer.objects.active = joined
    # Capture frame-1 positions of the joined mesh's 501 source vertices
    # BEFORE export. These are the canonical positions that VAT[0] holds.
    src_positions = np.array(
        [(v.co.x, v.co.y, v.co.z) for v in joined.data.vertices], dtype=np.float32
    )

    bpy.ops.export_scene.gltf(
        filepath=OUT_STATIC_GLB,
        export_format="GLB",
        use_selection=True,
        export_animations=False,
        export_skins=False,
        export_apply=False,
    )
    print(f"Static GLB: {OUT_STATIC_GLB} ({os.path.getsize(OUT_STATIC_GLB)} bytes)")

    # Re-parse the GLB and figure out the exported vertex count. The Blender
    # glTF exporter splits vertices on UV/normal seams, so the count is often
    # larger than len(joined.data.vertices). To keep vertex_index aligned with
    # VAT rows, we expand the per-source-vertex VAT into a per-exported-vertex
    # VAT by matching positions at frame 1.
    import struct as _struct
    with open(OUT_STATIC_GLB, "rb") as f:
        glb_bytes = f.read()
    json_len = _struct.unpack_from("<I", glb_bytes, 12)[0]
    gltf = json.loads(glb_bytes[20 : 20 + json_len].decode("utf-8").rstrip())
    bin_chunk_offset = 20 + json_len + 8  # skip JSON chunk and BIN chunk header
    prim = gltf["meshes"][0]["primitives"][0]
    pos_acc = gltf["accessors"][prim["attributes"]["POSITION"]]
    pos_view = gltf["bufferViews"][pos_acc["bufferView"]]
    pos_offset = bin_chunk_offset + pos_view.get("byteOffset", 0)
    exported_count = pos_acc["count"]
    exported_positions = np.frombuffer(
        glb_bytes[pos_offset : pos_offset + exported_count * 12], dtype=np.float32
    ).reshape(-1, 3)

    print(
        f"GLB exported vertex count: {exported_count} "
        f"(joined had {total_verts}; {exported_count - total_verts} attribute splits)"
    )

    if exported_count == total_verts:
        # No splitting happened; nothing to do.
        print("OK: vertex counts already aligned, no expansion needed.")
        json.load_done = True  # placeholder
    else:
        # Build a position-to-source-index map. Using rounded coordinates as
        # the dict key (not exact float compare) is robust to small precision
        # differences between Blender's internal storage and the exported
        # buffer view.
        EPS_DECIMALS = 5

        def key(pos):
            return (
                round(float(pos[0]), EPS_DECIMALS),
                round(float(pos[1]), EPS_DECIMALS),
                round(float(pos[2]), EPS_DECIMALS),
            )

        pos_to_src = {key(src_positions[i]): i for i in range(total_verts)}
        mapping = np.zeros(exported_count, dtype=np.int32)
        miss = 0
        for i in range(exported_count):
            k = key(exported_positions[i])
            j = pos_to_src.get(k, -1)
            if j < 0:
                miss += 1
                # Fall back to nearest neighbour.
                diffs = src_positions - exported_positions[i]
                dist2 = (diffs * diffs).sum(axis=1)
                j = int(np.argmin(dist2))
            mapping[i] = j
        if miss:
            print(f"WARN: {miss} exported vertices had no exact position match; used nearest neighbour.")

        # Expand the VAT to the exported topology.
        expanded = np.zeros((NUM_FRAMES, exported_count, 4), dtype=np.float16)
        expanded[:, :, :] = data[:, mapping, :]
        with open(OUT_VAT_BIN, "wb") as f:
            f.write(expanded.tobytes())
        new_size = os.path.getsize(OUT_VAT_BIN)
        print(
            f"Expanded VAT: {OUT_VAT_BIN} ({new_size} bytes, "
            f"{NUM_FRAMES} frames x {exported_count} verts x 8 byte)"
        )

        # Update metadata.
        with open(OUT_VAT_JSON, "r") as f:
            meta = json.load(f)
        meta["vertexCount"] = int(exported_count)
        meta["sourceVertexCount"] = int(total_verts)
        with open(OUT_VAT_JSON, "w") as f:
            json.dump(meta, f, indent=2)
        print(f"Updated metadata vertexCount = {exported_count}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
