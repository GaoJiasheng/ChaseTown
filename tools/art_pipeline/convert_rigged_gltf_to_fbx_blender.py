"""Convert one prepared skinned glTF into a Unity-oriented FBX with Blender.

The Assimp FBX exporter rewrites joint local axes during a glTF round trip.
Blender is used for the final conversion so the character FBX uses the same
axis convention as the shared animation FBX files.
"""

from __future__ import annotations

from pathlib import Path
import sys

import bpy


def arguments() -> tuple[Path, Path]:
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(raw) != 2:
        raise SystemExit("Usage: blender --background --python SCRIPT -- input.gltf output.fbx")
    return Path(raw[0]).resolve(), Path(raw[1]).resolve()


def main() -> None:
    source, target = arguments()
    if not source.is_file():
        raise FileNotFoundError(source)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 30
    scene.render.fps_base = 1.0
    bpy.ops.import_scene.gltf(filepath=str(source), import_shading="NORMALS")

    armatures = [obj for obj in scene.objects if obj.type == "ARMATURE"]
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    if len(armatures) != 1:
        raise RuntimeError(f"Expected exactly one armature, found {len(armatures)}")
    if not meshes:
        raise RuntimeError("No skinned meshes were imported")

    armature = armatures[0]
    armature.name = "Rig_Humanoid_Shared"
    armature.data.name = "Rig_Humanoid_Shared_Armature"
    required = {
        "Hips",
        "Spine",
        "Chest",
        "Neck",
        "Head",
        "LeftUpperArm",
        "LeftLowerArm",
        "LeftHand",
        "RightUpperArm",
        "RightLowerArm",
        "RightHand",
        "LeftUpperLeg",
        "LeftLowerLeg",
        "LeftFoot",
        "RightUpperLeg",
        "RightLowerLeg",
        "RightFoot",
    }
    missing = sorted(required.difference(armature.data.bones.keys()))
    if missing:
        raise RuntimeError("Imported armature is missing required bones: " + ", ".join(missing))

    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature
    target.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=str(target),
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="Z",
        axis_up="Y",
        add_leaf_bones=False,
        bake_anim=False,
        use_armature_deform_only=False,
        mesh_smooth_type="FACE",
        use_custom_props=True,
    )
    if not target.is_file() or target.stat().st_size < 1024:
        raise RuntimeError(f"FBX export did not produce a valid file: {target}")
    print(f"Exported {len(meshes)} skinned meshes through {armature.name}: {target}")


if __name__ == "__main__":
    main()
