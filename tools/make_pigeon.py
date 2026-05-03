"""Generate a rigged pigeon GLB asset using Blender's Python API.

Run with:
    /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/make_pigeon.py

Produces public/pigeon.glb with a single joined mesh (body + head + 2 wings),
an armature with Root/Body/Head/Wing_L/Wing_R bones, and a "Flap" animation
that rotates the wings around their local X axis sinusoidally over 24 frames.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

# Resolve output path relative to this script, not cwd.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "public", "pigeon.glb"))

# Animation constants.
FLAP_ACTION_NAME = "Flap"
FRAME_START = 1
FRAME_END = 24
WING_ANGLE_DOWN = math.radians(-25)
WING_ANGLE_UP = math.radians(35)


def clear_scene() -> None:
    """Reset to an empty scene so the script is idempotent."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def create_body() -> bpy.types.Object:
    """Create the ellipsoidal body mesh."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.5)
    body = bpy.context.object
    body.name = "Body"
    body.scale = (1.5, 0.6, 0.7)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return body


def create_head() -> bpy.types.Object:
    """Create the head mesh, positioned ahead of the body."""
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=12, ring_count=6, radius=0.3, location=(1.4, 0.0, 0.2)
    )
    head = bpy.context.object
    head.name = "Head"
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return head


def create_wing(name: str, y_offset: float) -> bpy.types.Object:
    """Create one wing as a flattened plane at the body's side.

    y_offset is positive for left wing, negative for right wing.
    """
    bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0.0, y_offset, 0.0))
    wing = bpy.context.object
    wing.name = name
    # Flatten on Z, stretch along Y so the wing extends sideways from the body.
    wing.scale = (0.8, 1.4, 0.05)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return wing


def join_meshes(names: list[str], joined_name: str) -> bpy.types.Object:
    """Join multiple meshes into a single mesh object."""
    bpy.ops.object.select_all(action="DESELECT")
    for n in names:
        bpy.data.objects[n].select_set(True)
    # The active object becomes the receiving object after the join.
    bpy.context.view_layer.objects.active = bpy.data.objects[names[0]]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = joined_name
    joined.data.name = joined_name
    # Recompute normals and validate the joined geometry; otherwise the glTF
    # exporter may warn that the mesh is not valid.
    joined.data.validate()
    joined.data.update()
    return joined


def create_armature() -> bpy.types.Object:
    """Build the pigeon armature with Root/Body/Head/Wing_L/Wing_R bones."""
    bpy.ops.object.armature_add(location=(0.0, 0.0, 0.0))
    arm = bpy.context.object
    arm.name = "Pigeon_Armature"
    arm.data.name = "Pigeon_Armature_Data"

    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = arm.data.edit_bones

    # Remove the default bone created by armature_add.
    for b in list(edit_bones):
        edit_bones.remove(b)

    # Root bone: vertical, anchors the rig.
    root = edit_bones.new("Root")
    root.head = Vector((0.0, 0.0, 0.0))
    root.tail = Vector((0.0, 0.0, 0.4))

    # Body bone: along the body's long axis (X).
    body_bone = edit_bones.new("Body")
    body_bone.head = Vector((-0.7, 0.0, 0.0))
    body_bone.tail = Vector((0.8, 0.0, 0.0))
    body_bone.parent = root

    # Head bone: continues forward and slightly upward from the body.
    head_bone = edit_bones.new("Head")
    head_bone.head = Vector((0.9, 0.0, 0.1))
    head_bone.tail = Vector((1.5, 0.0, 0.3))
    head_bone.parent = body_bone

    # Wing_L bone: shoulder at the body's left side, tail at the wing tip.
    wing_l = edit_bones.new("Wing_L")
    wing_l.head = Vector((0.0, 0.2, 0.1))
    wing_l.tail = Vector((0.0, 1.2, 0.1))
    wing_l.parent = body_bone

    # Wing_R bone: mirror of Wing_L on -Y.
    wing_r = edit_bones.new("Wing_R")
    wing_r.head = Vector((0.0, -0.2, 0.1))
    wing_r.tail = Vector((0.0, -1.2, 0.1))
    wing_r.parent = body_bone

    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def parent_mesh_to_armature(mesh: bpy.types.Object, arm: bpy.types.Object) -> None:
    """Bind the mesh to the armature using automatic vertex weights."""
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def build_flap_action(arm: bpy.types.Object) -> None:
    """Insert wing flap keyframes on the armature's pose bones."""
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")

    if arm.animation_data is None:
        arm.animation_data_create()
    action = bpy.data.actions.new(name=FLAP_ACTION_NAME)
    arm.animation_data.action = action

    pose_l = arm.pose.bones["Wing_L"]
    pose_r = arm.pose.bones["Wing_R"]

    # XYZ Euler avoids quaternion ambiguity when scripting.
    pose_l.rotation_mode = "XYZ"
    pose_r.rotation_mode = "XYZ"

    # 5 keyframes across 24 frames produce 2 full flap cycles.
    keyframes = [
        (1, WING_ANGLE_DOWN),
        (7, WING_ANGLE_UP),
        (13, WING_ANGLE_DOWN),
        (19, WING_ANGLE_UP),
        (24, WING_ANGLE_DOWN),
    ]

    for frame, angle in keyframes:
        # Wing_L rotates one way; Wing_R mirrors with sign flipped.
        pose_l.rotation_euler[0] = angle
        pose_r.rotation_euler[0] = -angle
        pose_l.keyframe_insert(data_path="rotation_euler", index=0, frame=frame)
        pose_r.keyframe_insert(data_path="rotation_euler", index=0, frame=frame)

    bpy.ops.object.mode_set(mode="OBJECT")

    bpy.context.scene.frame_start = FRAME_START
    bpy.context.scene.frame_end = FRAME_END


def export_glb(path: str) -> None:
    """Export the scene as binary glTF with animations and skins."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_apply=True,
    )


def main() -> None:
    clear_scene()

    create_body()
    create_head()
    create_wing("Wing_L", y_offset=0.7)
    create_wing("Wing_R", y_offset=-0.7)

    mesh = join_meshes(["Body", "Head", "Wing_L", "Wing_R"], "Pigeon_Mesh")

    arm = create_armature()
    parent_mesh_to_armature(mesh, arm)
    build_flap_action(arm)

    export_glb(OUT)
    print(f"[make_pigeon] wrote {OUT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — surface any failure to the CLI
        print(f"[make_pigeon] ERROR: {exc}", file=sys.stderr)
        raise
