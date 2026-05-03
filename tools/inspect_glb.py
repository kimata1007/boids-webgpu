"""Inspect a GLB file and report mesh, armature, and animation stats.

Run with:
    /Applications/Blender.app/Contents/MacOS/Blender --background \
        --python tools/inspect_glb.py -- <path-to-glb>

Reads the GLB JSON manifest directly for authoritative counts (meshes,
animations, skins) so importer quirks do not skew the numbers, then
re-imports through Blender for vertex/bone/keyframe details.
"""

import json
import os
import struct
import sys

import bpy

GLB_MAGIC = 0x46546C67  # b'glTF'


def parse_glb_path(argv: list[str]) -> str:
    """Pull the GLB path from argv after Blender's '--' separator."""
    if "--" in argv:
        idx = argv.index("--")
        rest = argv[idx + 1 :]
    else:
        rest = []
    if not rest:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.normpath(os.path.join(script_dir, "..", "public", "pigeon.glb"))
    return os.path.abspath(rest[0])


def read_glb_json(glb_path: str) -> dict:
    """Read the JSON chunk out of a GLB container."""
    with open(glb_path, "rb") as f:
        magic, version, _total = struct.unpack("<III", f.read(12))
        if magic != GLB_MAGIC:
            raise ValueError(f"not a GLB file: {glb_path}")
        if version != 2:
            raise ValueError(f"unsupported GLB version: {version}")
        size, ctype = struct.unpack("<II", f.read(8))
        ctype_s = struct.pack("<I", ctype).decode("ascii", errors="replace")
        if ctype_s != "JSON":
            raise ValueError(f"first chunk is not JSON: {ctype_s}")
        return json.loads(f.read(size))


def _iter_action_fcurves(action: "bpy.types.Action"):
    """Iterate fcurves on an action across legacy and slotted (4.4+) layouts."""
    legacy = getattr(action, "fcurves", None)
    if legacy is not None:
        for fc in legacy:
            yield fc
        return
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            for cb in getattr(strip, "channelbags", []):
                for fc in getattr(cb, "fcurves", []):
                    yield fc


def count_keyframes() -> int:
    """Sum keyframes across every fcurve of every action in the file."""
    total = 0
    for action in bpy.data.actions:
        for fcurve in _iter_action_fcurves(action):
            total += len(fcurve.keyframe_points)
    return total


def main() -> None:
    glb_path = parse_glb_path(sys.argv)
    if not os.path.exists(glb_path):
        print(f"[inspect_glb] missing file: {glb_path}", file=sys.stderr)
        sys.exit(1)

    file_size = os.path.getsize(glb_path)
    manifest = read_glb_json(glb_path)
    mesh_count_glb = len(manifest.get("meshes", []))
    skin_count_glb = len(manifest.get("skins", []))
    animation_count_glb = len(manifest.get("animations", []))
    node_count_glb = len(manifest.get("nodes", []))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_path)

    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    # Only meshes that are actually skinned to an armature count as our pigeon
    # geometry; the Blender 5.1 importer can create a placeholder Icosphere for
    # bone display, which we ignore here.
    skinned_meshes = [
        o
        for o in bpy.data.objects
        if o.type == "MESH" and o.parent is not None and o.parent.type == "ARMATURE"
    ]
    mesh_vertex_count = sum(len(m.data.vertices) for m in skinned_meshes)
    bone_count = sum(len(a.data.bones) for a in armatures)
    keyframe_count = count_keyframes()

    print(f"path             : {glb_path}")
    print(f"size_bytes       : {file_size}")
    print(f"glb_meshes       : {mesh_count_glb}")
    print(f"glb_skins        : {skin_count_glb}")
    print(f"glb_animations   : {animation_count_glb}")
    print(f"glb_nodes        : {node_count_glb}")
    print(f"armature_count   : {len(armatures)}")
    print(f"skinned_mesh_count: {len(skinned_meshes)}")
    print(f"mesh_vertex_count: {mesh_vertex_count}")
    print(f"bone_count       : {bone_count}")
    print(f"keyframe_count   : {keyframe_count}")
    for m in skinned_meshes:
        print(f"mesh             : name={m.name!r} vertices={len(m.data.vertices)}")
    for a in armatures:
        bone_names = [b.name for b in a.data.bones]
        print(f"armature         : name={a.name!r} bones={bone_names}")
    for action in bpy.data.actions:
        fcurves = list(_iter_action_fcurves(action))
        print(f"action           : name={action.name!r} fcurves={len(fcurves)}")


if __name__ == "__main__":
    main()
