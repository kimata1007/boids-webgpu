"""Bake the pigeon Flap action into a Vertex Animation Texture.

Run with:
    /Applications/Blender.app/Contents/MacOS/Blender --background \
        --python tools/bake_vat.py

Re-imports public/pigeon.glb, samples NUM_FRAMES evenly across the Flap
action, and writes the deformed vertex positions out as a flat float16
binary at public/pigeon_vat.bin. A small JSON sidecar at
public/pigeon_vat.json carries the metadata the runtime needs (vertex
count, frame count, format, animation duration in seconds).

The runtime samples this texture using @builtin(vertex_index). For that
to line up correctly, the vertex order in this script must match the
vertex order the WebGPU loader reads from pigeon.glb's POSITION
accessor. Both this script and the loader feed off the same glTF asset,
so the order is preserved as long as the Blender glTF importer does not
shuffle vertices on read. If a future Blender release changes that, the
shape will visibly explode at runtime — that is the canary.
"""

import json
import math
import os
import struct
import sys

import bpy

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:  # pragma: no cover - bundled Python normally has numpy
    HAS_NUMPY = False


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GLB_PATH = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "public", "pigeon.glb"))
OUT_BIN = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "public", "pigeon_vat.bin"))
OUT_JSON = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "public", "pigeon_vat.json"))

# VAT sampling parameters. 32 frames is enough to capture two flap cycles
# from the source action without tearing under linear interpolation.
NUM_FRAMES = 32
ACTION_NAME = "Flap"
# The source action lives on integer Blender frames at 24 fps, so a single
# flap cycle is 24 frames = 1.0s. Keep the runtime "duration" in the JSON
# sidecar so the shader does not have to hardcode it.
SCENE_FPS_FALLBACK = 24


def find_skinned_mesh() -> bpy.types.Object:
    """Return the mesh object that is parented to an armature."""
    for obj in bpy.data.objects:
        if (
            obj.type == "MESH"
            and obj.parent is not None
            and obj.parent.type == "ARMATURE"
        ):
            return obj
    raise RuntimeError("no skinned mesh found in imported scene")


def find_armature() -> bpy.types.Object:
    for obj in bpy.data.objects:
        if obj.type == "ARMATURE":
            return obj
    raise RuntimeError("no armature found in imported scene")


def find_action(name: str) -> bpy.types.Action:
    action = bpy.data.actions.get(name)
    if action is None:
        raise RuntimeError(
            f"action {name!r} not found; available: {[a.name for a in bpy.data.actions]}"
        )
    return action


def action_frame_range(action: bpy.types.Action) -> tuple[int, int]:
    """Return integer (start, end) covering the action's keyframes."""
    fr = action.frame_range  # (start, end) as floats
    return int(round(fr[0])), int(round(fr[1]))


def assign_action(arm: bpy.types.Object, action: bpy.types.Action) -> None:
    """Attach `action` to the armature using whichever Blender API is current."""
    if arm.animation_data is None:
        arm.animation_data_create()
    # Blender 4.4+ uses slotted actions; the legacy assignment still works
    # for our single-action case.
    arm.animation_data.action = action


def float_to_float16_bytes(value: float) -> bytes:
    """Pack a Python float as IEEE-754 binary16 little-endian."""
    # struct in Python 3.6+ supports 'e' for binary16.
    return struct.pack("<e", value)


def main() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=GLB_PATH)

    mesh_obj = find_skinned_mesh()
    arm_obj = find_armature()
    action = find_action(ACTION_NAME)
    assign_action(arm_obj, action)

    start_frame, end_frame = action_frame_range(action)
    span = max(end_frame - start_frame, 1)
    fps = bpy.context.scene.render.fps or SCENE_FPS_FALLBACK
    duration_seconds = span / float(fps)

    deps = bpy.context.evaluated_depsgraph_get()
    vertex_count = len(mesh_obj.evaluated_get(deps).data.vertices)
    if vertex_count == 0:
        raise RuntimeError("evaluated mesh has zero vertices")

    if HAS_NUMPY:
        data = np.zeros((NUM_FRAMES, vertex_count, 4), dtype=np.float16)
    else:
        data = None
        chunks: list[bytes] = []

    # Sample evenly across the action. The last sample is one short of the
    # end so the loop closes cleanly when the runtime wraps phase to 0.
    for f_idx in range(NUM_FRAMES):
        scene_frame = start_frame + int(round(f_idx * span / NUM_FRAMES))
        if scene_frame > end_frame:
            scene_frame = end_frame
        bpy.context.scene.frame_set(scene_frame)
        deps = bpy.context.evaluated_depsgraph_get()
        eval_data = mesh_obj.evaluated_get(deps).data
        if len(eval_data.vertices) != vertex_count:
            raise RuntimeError(
                "evaluated vertex count changed mid-bake; mesh is non-stable"
            )
        if HAS_NUMPY:
            for v_idx, v in enumerate(eval_data.vertices):
                co = v.co
                data[f_idx, v_idx, 0] = co.x
                data[f_idx, v_idx, 1] = co.y
                data[f_idx, v_idx, 2] = co.z
                data[f_idx, v_idx, 3] = 0.0
        else:
            row = bytearray()
            for v in eval_data.vertices:
                co = v.co
                row += float_to_float16_bytes(co.x)
                row += float_to_float16_bytes(co.y)
                row += float_to_float16_bytes(co.z)
                row += float_to_float16_bytes(0.0)
            chunks.append(bytes(row))

    os.makedirs(os.path.dirname(OUT_BIN), exist_ok=True)
    if HAS_NUMPY:
        payload = data.tobytes()
    else:
        payload = b"".join(chunks)

    expected_bytes = NUM_FRAMES * vertex_count * 8
    if len(payload) != expected_bytes:
        raise RuntimeError(
            f"baked size {len(payload)} != expected {expected_bytes}"
        )

    with open(OUT_BIN, "wb") as f:
        f.write(payload)

    metadata = {
        "numFrames": NUM_FRAMES,
        "vertexCount": vertex_count,
        "format": "rgba16f",
        "duration": round(duration_seconds, 6),
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2)
        f.write("\n")

    print(
        f"[bake_vat] wrote {OUT_BIN} ({len(payload)} bytes) "
        f"and {OUT_JSON} (frames={NUM_FRAMES}, verts={vertex_count}, "
        f"duration={duration_seconds:.4f}s)"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - surface failures to the CLI
        print(f"[bake_vat] ERROR: {exc}", file=sys.stderr)
        raise
