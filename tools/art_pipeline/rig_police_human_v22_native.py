"""Bind the polished police mesh to the project's 21-bone humanoid rig."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import bpy


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import remodel_police_human_v22 as model  # noqa: E402


ASSET_DIR = (
    ROOT
    / "art-source/Characters/Police/ReferenceStandard"
    / "HumanAnatomyRemodel_2026_07_14_v22"
)
STATIC_BLEND = ASSET_DIR / "Police_HumanAnatomyRemodel_v22.blend"
RIGGED_DIR = ASSET_DIR / "Rigged"
OUTPUT_STEM = "Police_HumanAnatomyRemodel_v22_Rigged"
SOURCE_PREFIX = model.SOURCE_PREFIX
SOURCE_OBJECTS = {
    "armature": f"{SOURCE_PREFIX}.rig_export",
    "body": f"{SOURCE_PREFIX}_export",
    "uniform": f"{SOURCE_PREFIX}.male_casualsuit03_export",
    "shoes": f"{SOURCE_PREFIX}.shoes02_export",
    "hair": f"{SOURCE_PREFIX}.short01_export",
}
TARGET_OBJECTS = {
    "body": "Police_v22_Body",
    "uniform": "Police_v22_Uniform",
    "shoes": "Police_v22_Shoes",
    "hair": "Police_v22_Hair",
}
UNITY_BONE_NAMES = {
    "pelvis": "Hips",
    "spine_01": "Spine",
    "spine_02": "Chest",
    "spine_03": "UpperChest",
    "neck_01": "Neck",
    "head": "Head",
    "clavicle_l": "LeftShoulder",
    "upperarm_l": "LeftUpperArm",
    "lowerarm_l": "LeftLowerArm",
    "hand_l": "LeftHand",
    "clavicle_r": "RightShoulder",
    "upperarm_r": "RightUpperArm",
    "lowerarm_r": "RightLowerArm",
    "hand_r": "RightHand",
    "thigh_l": "LeftUpperLeg",
    "calf_l": "LeftLowerLeg",
    "foot_l": "LeftFoot",
    "ball_l": "LeftToes",
    "thigh_r": "RightUpperLeg",
    "calf_r": "RightLowerLeg",
    "foot_r": "RightFoot",
    "ball_r": "RightToes",
}
for side, label in (("l", "Left"), ("r", "Right")):
    for source, target in (
        ("thumb", "Thumb"),
        ("index", "Index"),
        ("middle", "Middle"),
        ("ring", "Ring"),
        ("pinky", "Little"),
    ):
        UNITY_BONE_NAMES[f"{source}_01_{side}"] = f"{label}{target}Proximal"
        UNITY_BONE_NAMES[f"{source}_02_{side}"] = f"{label}{target}Intermediate"
        UNITY_BONE_NAMES[f"{source}_03_{side}"] = f"{label}{target}Distal"

UNITY_BONE_COLLAPSE = {"UpperChest": "Chest"}
for label in ("Left", "Right"):
    for finger in ("Thumb", "Index", "Middle", "Ring", "Little"):
        for segment in ("Proximal", "Intermediate", "Distal"):
            UNITY_BONE_COLLAPSE[f"{label}{finger}{segment}"] = f"{label}Hand"


def append_native_rig() -> dict[str, bpy.types.Object]:
    requested = list(SOURCE_OBJECTS.values())
    with bpy.data.libraries.load(str(model.SOURCE_BLEND), link=False) as (available, loaded):
        missing = [name for name in requested if name not in available.objects]
        if missing:
            raise RuntimeError(f"Missing native rig source objects: {missing}")
        loaded.objects = requested
    appended = {obj.name: obj for obj in loaded.objects if obj is not None}
    for obj in appended.values():
        bpy.context.collection.objects.link(obj)
        obj.hide_render = True
        obj.hide_set(False)
    return {key: appended[name] for key, name in SOURCE_OBJECTS.items()}


def apply_relaxed_pose_as_rest(armature: bpy.types.Object) -> None:
    model.apply_relaxed_human_pose(armature)
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.mode_set(mode="EDIT")
    root = armature.data.edit_bones.get("Root")
    pelvis = armature.data.edit_bones.get("pelvis")
    if root is None or pelvis is None:
        raise RuntimeError("Native MPFB rig is missing Root or pelvis")
    if pelvis.parent != root:
        raise RuntimeError("Native MPFB pelvis is not parented to Root")
    pelvis.parent = None
    armature.data.edit_bones.remove(root)
    bpy.ops.object.mode_set(mode="OBJECT")
    # Keep the project's stable rig container so Unity can rebuild the existing
    # Humanoid avatar while the internal skeleton remains the native 53-bone rig.
    armature.name = "Rig_Humanoid_Shared"
    armature.data.name = "Rig_Humanoid_Shared_Armature"
    armature.hide_render = True
    armature.show_in_front = True


def add_armature_modifier(obj: bpy.types.Object, armature: bpy.types.Object) -> None:
    for modifier in list(obj.modifiers):
        if modifier.type == "ARMATURE":
            obj.modifiers.remove(modifier)
    modifier = obj.modifiers.new("Rig_Humanoid_Shared_Deform", "ARMATURE")
    modifier.object = armature
    modifier.use_vertex_groups = True
    modifier.use_deform_preserve_volume = True
    world = obj.matrix_world.copy()
    obj.parent = armature
    obj.matrix_parent_inverse = armature.matrix_world.inverted()
    obj.matrix_world = world


def copy_top4_native_weights(
    source: bpy.types.Object,
    target: bpy.types.Object,
    armature: bpy.types.Object,
) -> dict[str, object]:
    if len(source.data.vertices) != len(target.data.vertices):
        raise RuntimeError(
            f"Vertex order mismatch for {target.name}: "
            f"source={len(source.data.vertices)} target={len(target.data.vertices)}"
        )
    bone_names = {bone.name for bone in armature.data.bones if bone.use_deform}
    target.vertex_groups.clear()
    groups = {name: target.vertex_groups.new(name=name) for name in bone_names}
    zero_weight_vertices = 0
    maximum_influences = 0
    used_bones: set[str] = set()
    for vertex in source.data.vertices:
        weights = []
        for membership in vertex.groups:
            group_name = source.vertex_groups[membership.group].name
            if group_name in bone_names and membership.weight > 1e-8:
                weights.append((group_name, membership.weight))
        weights.sort(key=lambda item: item[1], reverse=True)
        weights = weights[:4]
        total = sum(value for _, value in weights)
        if total <= 1e-8:
            zero_weight_vertices += 1
            continue
        maximum_influences = max(maximum_influences, len(weights))
        for name, value in weights:
            groups[name].add([vertex.index], value / total, "REPLACE")
            used_bones.add(name)
    if zero_weight_vertices:
        raise RuntimeError(f"{target.name} has {zero_weight_vertices} unweighted vertices")
    add_armature_modifier(target, armature)
    return {
        "object": target.name,
        "mode": "native_mpfb_weights_top4",
        "vertices": len(target.data.vertices),
        "zero_weight_vertices": zero_weight_vertices,
        "maximum_influences_per_vertex": maximum_influences,
        "used_bones": sorted(used_bones),
    }


def rigid_bone_for(obj: bpy.types.Object) -> str:
    name = obj.name.lower()
    if any(token in name for token in ("eye", "pupil", "brow", "lash", "hair", "cap")):
        return "head"
    if any(token in name for token in ("belt", "buckle", "pouch")):
        return "pelvis"
    if any(token in name for token in ("shoulderepaulet_-1", "epauletbutton_-1")):
        return "clavicle_l"
    if any(token in name for token in ("shoulderepaulet_+1", "epauletbutton_+1")):
        return "clavicle_r"
    if any(token in name for token in ("sleevepatch_-1", "sleevepatchinset_-1")):
        return "upperarm_l"
    if any(token in name for token in ("sleevepatch_+1", "sleevepatchinset_+1")):
        return "upperarm_r"
    if "shoulderradio" in name:
        return "clavicle_l"
    return "spine_03"


def rigid_bind(obj: bpy.types.Object, armature: bpy.types.Object) -> dict[str, object]:
    bone_name = rigid_bone_for(obj)
    if armature.data.bones.get(bone_name) is None:
        raise RuntimeError(f"Missing native bone {bone_name} for {obj.name}")
    obj.vertex_groups.clear()
    group = obj.vertex_groups.new(name=bone_name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    add_armature_modifier(obj, armature)
    return {
        "object": obj.name,
        "mode": "native_rigid_single_bone",
        "vertices": len(obj.data.vertices),
        "zero_weight_vertices": 0,
        "maximum_influences_per_vertex": 1,
        "used_bones": [bone_name],
    }


def standardize_unity_bone_names(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
    reports: list[dict[str, object]],
) -> None:
    """Rename native MPFB bones without changing hierarchy or skin weights."""
    for old_name, new_name in UNITY_BONE_NAMES.items():
        bone = armature.data.bones.get(old_name)
        if bone is None:
            raise RuntimeError(f"Missing native bone required for Unity mapping: {old_name}")
        bone.name = new_name
    for obj in meshes:
        for old_name, new_name in UNITY_BONE_NAMES.items():
            group = obj.vertex_groups.get(old_name)
            if group is not None:
                group.name = new_name
    for report in reports:
        report["used_bones"] = [UNITY_BONE_NAMES.get(name, name) for name in report["used_bones"]]


def collapse_to_project_humanoid_rig(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
    reports: list[dict[str, object]],
) -> None:
    """Merge native detail weights into the project's compatible 21-bone rig."""
    for obj in meshes:
        for source_name, target_name in UNITY_BONE_COLLAPSE.items():
            source_group = obj.vertex_groups.get(source_name)
            if source_group is None:
                continue
            target_group = obj.vertex_groups.get(target_name)
            if target_group is None:
                target_group = obj.vertex_groups.new(name=target_name)
            source_index = source_group.index
            target_index = target_group.index
            merged_weights: list[tuple[int, float]] = []
            for vertex in obj.data.vertices:
                source_weight = 0.0
                target_weight = 0.0
                for membership in vertex.groups:
                    if membership.group == source_index:
                        source_weight = membership.weight
                    elif membership.group == target_index:
                        target_weight = membership.weight
                if source_weight > 0.0:
                    merged_weights.append((vertex.index, min(1.0, source_weight + target_weight)))
            for vertex_index, weight in merged_weights:
                target_group.add([vertex_index], weight, "REPLACE")
            obj.vertex_groups.remove(source_group)

    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    upper_chest = armature.data.edit_bones.get("UpperChest")
    chest = armature.data.edit_bones.get("Chest")
    if upper_chest is None or chest is None:
        raise RuntimeError("Unity rig collapse requires Chest and UpperChest")
    for child in list(upper_chest.children):
        child.parent = chest
    armature.data.edit_bones.remove(upper_chest)
    removable_fingers = [
        bone
        for bone in armature.data.edit_bones
        if bone.name in UNITY_BONE_COLLAPSE and bone.name != "UpperChest"
    ]
    removable_fingers.sort(key=lambda bone: bone.name.endswith("Distal"), reverse=True)
    for bone in removable_fingers:
        armature.data.edit_bones.remove(bone)
    bpy.ops.object.mode_set(mode="OBJECT")

    for report in reports:
        report["used_bones"] = sorted(
            {UNITY_BONE_COLLAPSE.get(name, name) for name in report["used_bones"]}
        )


def character_meshes() -> list[bpy.types.Object]:
    excluded = ("Studio_", "Camera", "Key_", "Fill_", "Rim_")
    return [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "MESH" and not obj.name.startswith(excluded) and not obj.name.startswith(SOURCE_PREFIX)
    ]


def export(meshes: list[bpy.types.Object], armature: bpy.types.Object) -> tuple[Path, Path, Path]:
    RIGGED_DIR.mkdir(parents=True, exist_ok=True)
    output_blend = RIGGED_DIR / f"{OUTPUT_STEM}.blend"
    output_fbx = RIGGED_DIR / f"{OUTPUT_STEM}.fbx"
    output_glb = RIGGED_DIR / f"{OUTPUT_STEM}.glb"
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.ops.wm.save_as_mainfile(filepath=str(output_blend), compress=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.fbx(
        filepath=str(output_fbx),
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="Z",
        axis_up="Y",
        add_leaf_bones=False,
        bake_anim=False,
        use_armature_deform_only=True,
        mesh_smooth_type="FACE",
        use_custom_props=True,
        path_mode="COPY",
        embed_textures=True,
    )
    bpy.ops.export_scene.gltf(
        filepath=str(output_glb),
        export_format="GLB",
        use_selection=True,
        export_skins=True,
        export_animations=False,
        export_yup=True,
    )
    return output_blend, output_fbx, output_glb


def main() -> None:
    if not STATIC_BLEND.is_file():
        raise FileNotFoundError(STATIC_BLEND)
    bpy.ops.wm.open_mainfile(filepath=str(STATIC_BLEND))
    source = append_native_rig()
    armature = source["armature"]
    apply_relaxed_pose_as_rest(armature)

    reports: list[dict[str, object]] = []
    transferred_targets: set[bpy.types.Object] = set()
    for key, target_name in TARGET_OBJECTS.items():
        target = bpy.data.objects[target_name]
        reports.append(copy_top4_native_weights(source[key], target, armature))
        transferred_targets.add(target)

    meshes = character_meshes()
    for obj in meshes:
        if obj not in transferred_targets:
            reports.append(rigid_bind(obj, armature))

    for key, obj in source.items():
        if key != "armature":
            bpy.data.objects.remove(obj, do_unlink=True)
    standardize_unity_bone_names(armature, meshes, reports)
    collapse_to_project_humanoid_rig(armature, meshes, reports)
    bpy.context.view_layer.update()

    model.REVIEW_OUT = ROOT / "docs/art_production/police_human_v22_native_rig_bind"
    model.render_views(meshes)
    output_blend, output_fbx, output_glb = export(meshes, armature)

    low, high = model.scene_bounds(meshes)
    report = {
        "asset": OUTPUT_STEM,
        "pipeline": "native_mpfb_weights_parent_merged_to_project_humanoid21",
        "static_source": str(STATIC_BLEND.relative_to(ROOT)),
        "native_rig_source": str(model.SOURCE_BLEND.relative_to(ROOT)),
        "outputs": [str(path.relative_to(ROOT)) for path in (output_blend, output_fbx, output_glb)],
        "bounds_meters": {
            "min": [float(value) for value in low],
            "max": [float(value) for value in high],
            "height": float(high.z - low.z),
        },
        "rig": {
            "armature": armature.name,
            "bone_count": len(armature.data.bones),
            "deform_bone_count": sum(1 for bone in armature.data.bones if bone.use_deform),
            "bone_names": [bone.name for bone in armature.data.bones],
            "rest_pose": "relaxed neutral source pose applied as rest",
            "unity_standardized_bone_names": True,
            "project_humanoid_21_bone_compatible": True,
        },
        "weighting": {
            "mesh_count": len(meshes),
            "zero_weight_vertices": sum(int(item["zero_weight_vertices"]) for item in reports),
            "maximum_influences_per_vertex": max(int(item["maximum_influences_per_vertex"]) for item in reports),
            "mesh_reports": reports,
        },
        "validation_summary": {
            "native_source_weights_parent_merged": True,
            "all_vertices_weighted": all(int(item["zero_weight_vertices"]) == 0 for item in reports),
            "maximum_four_influences": all(int(item["maximum_influences_per_vertex"]) <= 4 for item in reports),
            "unity_humanoid_avatar": "pending Unity batch validation",
        },
    }
    reports_dir = RIGGED_DIR / "Reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    (reports_dir / f"{OUTPUT_STEM}_report.json").write_text(
        json.dumps(report, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"output_fbx": str(output_fbx.relative_to(ROOT))}, indent=2))


if __name__ == "__main__":
    main()
