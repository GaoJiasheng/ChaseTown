"""Rig the three v21 precision characters directly in their Blender sources.

Run with:
  blender --background --python tools/art_pipeline/rig_precision_remodel_v21_blender.py -- --only Kid
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import rig_approved_character_candidates as weight_rules  # noqa: E402


ROLES = ("Kid", "Villain", "Police")
VERSION_DIR = "PrecisionRemodel_2026_07_13_v21"
EXCLUDED_PREFIXES = ("Studio_", "Camera", "Key_", "Fill_", "Rim_")


def parse_arguments() -> argparse.Namespace:
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Comma-separated roles; defaults to all three")
    return parser.parse_args(raw)


def selected_roles(value: str | None) -> list[str]:
    if not value:
        return list(ROLES)
    requested = {part.strip().lower() for part in value.split(",") if part.strip()}
    selected = [role for role in ROLES if role.lower() in requested]
    if not selected:
        raise ValueError(f"No v21 role matched --only {value!r}")
    return selected


def role_paths(role: str) -> tuple[Path, Path, Path, Path]:
    asset_dir = ROOT / "art-source" / "Characters" / role / "ReferenceStandard" / VERSION_DIR
    source = asset_dir / f"{role}_PrecisionRemodel_v21.blend"
    rigged_dir = asset_dir / "Rigged"
    output_blend = rigged_dir / f"{role}_PrecisionRemodel_v21_Rigged.blend"
    output_fbx = rigged_dir / f"{role}_PrecisionRemodel_v21_Rigged.fbx"
    return source, rigged_dir, output_blend, output_fbx


def character_meshes() -> list[bpy.types.Object]:
    meshes = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        if obj.name.startswith(EXCLUDED_PREFIXES):
            continue
        meshes.append(obj)
    if not meshes:
        raise RuntimeError("No character meshes found in source blend")
    return meshes


def world_bounds(meshes: list[bpy.types.Object]) -> dict[str, float]:
    minimum = Vector((float("inf"), float("inf"), float("inf")))
    maximum = Vector((float("-inf"), float("-inf"), float("-inf")))
    vertex_count = 0
    polygon_count = 0
    triangle_count = 0
    for obj in meshes:
        matrix = obj.matrix_world
        for vertex in obj.data.vertices:
            point = matrix @ vertex.co
            minimum.x = min(minimum.x, point.x)
            minimum.y = min(minimum.y, point.y)
            minimum.z = min(minimum.z, point.z)
            maximum.x = max(maximum.x, point.x)
            maximum.y = max(maximum.y, point.y)
            maximum.z = max(maximum.z, point.z)
            vertex_count += 1
        polygon_count += len(obj.data.polygons)
        triangle_count += sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)
    return {
        "min_x": minimum.x,
        "max_x": maximum.x,
        "min_y": minimum.y,
        "max_y": maximum.y,
        "min_z": minimum.z,
        "max_z": maximum.z,
        "width": maximum.x - minimum.x,
        "depth": maximum.y - minimum.y,
        "height": maximum.z - minimum.z,
        "vertex_count": vertex_count,
        "polygon_count": polygon_count,
        "triangle_count": triangle_count,
    }


def place_feet_at_origin(meshes: list[bpy.types.Object]) -> float:
    """Move the complete character so the lowest visible point is at Z=0."""
    floor_z = world_bounds(meshes)["min_z"]
    if abs(floor_z) <= 1e-8:
        return 0.0
    for obj in meshes:
        obj.location.z -= floor_z
    bpy.context.view_layer.update()
    return floor_z


def create_scaled_armature(bounds: dict[str, float]) -> tuple[bpy.types.Object, float]:
    for obj in list(bpy.data.objects):
        if obj.type == "ARMATURE":
            bpy.data.objects.remove(obj, do_unlink=True)

    center_x = (bounds["min_x"] + bounds["max_x"]) * 0.5
    center_y = 0.0
    floor_z = bounds["min_z"]
    height = bounds["height"]
    width = bounds["width"]
    depth = bounds["depth"]

    def point(x_ratio: float, y_ratio: float, z_ratio: float) -> tuple[float, float, float]:
        return (
            center_x + width * x_ratio,
            center_y + depth * y_ratio,
            floor_z + height * z_ratio,
        )

    relaxed_bones = [
        ("Hips", None, point(0.0, 0.0, 0.48), point(0.0, 0.0, 0.56)),
        ("Spine", "Hips", point(0.0, 0.0, 0.56), point(0.0, 0.0, 0.68)),
        ("Chest", "Spine", point(0.0, 0.0, 0.68), point(0.0, 0.0, 0.76)),
        ("Neck", "Chest", point(0.0, 0.0, 0.76), point(0.0, 0.0, 0.82)),
        ("Head", "Neck", point(0.0, 0.0, 0.82), point(0.0, 0.0, 0.98)),
        ("LeftShoulder", "Chest", point(0.0, 0.0, 0.73), point(-0.28, 0.0, 0.72)),
        ("LeftUpperArm", "LeftShoulder", point(-0.28, 0.0, 0.72), point(-0.39, 0.0, 0.53)),
        ("LeftLowerArm", "LeftUpperArm", point(-0.39, 0.0, 0.53), point(-0.43, 0.0, 0.36)),
        ("LeftHand", "LeftLowerArm", point(-0.43, 0.0, 0.36), point(-0.43, -0.01, 0.30)),
        ("RightShoulder", "Chest", point(0.0, 0.0, 0.73), point(0.28, 0.0, 0.72)),
        ("RightUpperArm", "RightShoulder", point(0.28, 0.0, 0.72), point(0.39, 0.0, 0.53)),
        ("RightLowerArm", "RightUpperArm", point(0.39, 0.0, 0.53), point(0.43, 0.0, 0.36)),
        ("RightHand", "RightLowerArm", point(0.43, 0.0, 0.36), point(0.43, -0.01, 0.30)),
        ("LeftUpperLeg", "Hips", point(-0.12, 0.0, 0.48), point(-0.14, 0.0, 0.27)),
        ("LeftLowerLeg", "LeftUpperLeg", point(-0.14, 0.0, 0.27), point(-0.14, 0.0, 0.08)),
        ("LeftFoot", "LeftLowerLeg", point(-0.14, 0.0, 0.08), point(-0.14, -0.24, 0.025)),
        ("LeftToes", "LeftFoot", point(-0.14, -0.24, 0.025), point(-0.14, -0.42, 0.025)),
        ("RightUpperLeg", "Hips", point(0.12, 0.0, 0.48), point(0.14, 0.0, 0.27)),
        ("RightLowerLeg", "RightUpperLeg", point(0.14, 0.0, 0.27), point(0.14, 0.0, 0.08)),
        ("RightFoot", "RightLowerLeg", point(0.14, 0.0, 0.08), point(0.14, -0.24, 0.025)),
        ("RightToes", "RightFoot", point(0.14, -0.24, 0.025), point(0.14, -0.42, 0.025)),
    ]

    bpy.ops.object.armature_add(enter_editmode=True, location=(0.0, 0.0, 0.0))
    armature = bpy.context.object
    armature.name = "Rig_Humanoid_Shared"
    armature.data.name = "Rig_Humanoid_Shared_Armature"
    armature.data.display_type = "STICK"
    armature.show_in_front = True

    first_spec = relaxed_bones[0]
    first = armature.data.edit_bones[0]
    first.name = first_spec[0]
    first.head = first_spec[2]
    first.tail = first_spec[3]
    first.use_deform = True
    by_name = {first.name: first}
    for name, parent_name, head, tail in relaxed_bones[1:]:
        bone = armature.data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        bone.use_deform = True
        bone.use_connect = False
        if parent_name:
            bone.parent = by_name[parent_name]
        by_name[name] = bone
    bpy.ops.object.mode_set(mode="OBJECT")
    return armature, height / 1.82


def object_center_world(obj: bpy.types.Object) -> tuple[float, float, float]:
    if not obj.data.vertices:
        return (0.0, 0.0, 0.0)
    matrix = obj.matrix_world
    total = Vector((0.0, 0.0, 0.0))
    for vertex in obj.data.vertices:
        total += matrix @ vertex.co
    center = total / len(obj.data.vertices)
    return (center.x, center.y, center.z)


def clear_old_rig_data(obj: bpy.types.Object) -> None:
    for modifier in list(obj.modifiers):
        if modifier.type == "ARMATURE":
            obj.modifiers.remove(modifier)
    obj.vertex_groups.clear()


def parent_preserving_world(obj: bpy.types.Object, armature: bpy.types.Object) -> None:
    world_matrix = obj.matrix_world.copy()
    obj.parent = armature
    obj.matrix_parent_inverse = armature.matrix_world.inverted()
    obj.matrix_world = world_matrix


def validate_and_limit_weights(obj: bpy.types.Object, mode: str) -> dict[str, object]:
    bone_names = set(weight_rules.BONE_NAMES)
    zero_weight_vertices = 0
    maximum_sum_error = 0.0
    nonzero_bones: set[str] = set()
    maximum_influences = 0
    for vertex in obj.data.vertices:
        influences = []
        for membership in vertex.groups:
            group = obj.vertex_groups[membership.group]
            if group.name in bone_names and membership.weight > 1e-8:
                influences.append((group, membership.weight))
        influences.sort(key=lambda item: item[1], reverse=True)
        for group, _ in influences[4:]:
            group.remove([vertex.index])
        kept = influences[:4]
        total = sum(weight for _, weight in kept)
        if total <= 1e-8:
            zero_weight_vertices += 1
            continue
        maximum_influences = max(maximum_influences, len(kept))
        for group, value in kept:
            group.add([vertex.index], value / total, "REPLACE")
            nonzero_bones.add(group.name)
        maximum_sum_error = max(maximum_sum_error, abs(sum(value / total for _, value in kept) - 1.0))
    return {
        "object": obj.name,
        "vertices": len(obj.data.vertices),
        "mode": mode,
        "rigid_bone": None,
        "nonzero_bones": sorted(nonzero_bones),
        "zero_weight_vertices": zero_weight_vertices,
        "maximum_weight_sum_error": maximum_sum_error,
        "maximum_influences_per_vertex": maximum_influences,
    }


def automatic_parent(obj: bpy.types.Object, armature: bpy.types.Object) -> None:
    clear_old_rig_data(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type="ARMATURE_AUTO", xmirror=False, keep_transform=True)
    modifiers = [modifier for modifier in obj.modifiers if modifier.type == "ARMATURE"]
    if not modifiers:
        raise RuntimeError(f"Bone Heat did not add an Armature modifier to {obj.name}")
    modifiers[-1].use_deform_preserve_volume = True


def bind_primary_with_voxel_heat(
    obj: bpy.types.Object,
    armature: bpy.types.Object,
    bounds: dict[str, float],
) -> dict[str, object]:
    clear_old_rig_data(obj)
    proxy = obj.copy()
    proxy.data = obj.data.copy()
    proxy.name = obj.name + "_VoxelWeightProxy"
    proxy.data.name = proxy.name + "_Mesh"
    bpy.context.collection.objects.link(proxy)
    proxy.hide_render = True

    bpy.ops.object.select_all(action="DESELECT")
    proxy.select_set(True)
    bpy.context.view_layer.objects.active = proxy
    proxy.data.remesh_voxel_size = max(bounds["height"] * 0.014, 0.008)
    proxy.data.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.voxel_remesh()
    if len(proxy.data.vertices) < 500:
        raise RuntimeError(f"Voxel weight proxy is unexpectedly small: {len(proxy.data.vertices)} vertices")

    automatic_parent(proxy, armature)
    proxy_report = validate_and_limit_weights(proxy, "voxel_proxy_bone_heat_top4")
    if int(proxy_report["zero_weight_vertices"]) > 0:
        raise RuntimeError(
            f"Voxel Bone Heat left {proxy_report['zero_weight_vertices']} unweighted proxy vertices"
        )

    clear_old_rig_data(obj)
    for name in weight_rules.BONE_NAMES:
        obj.vertex_groups.new(name=name)
    transfer = obj.modifiers.new(name="VoxelProxyWeightTransfer", type="DATA_TRANSFER")
    transfer.object = proxy
    transfer.use_vert_data = True
    transfer.data_types_verts = {"VGROUP_WEIGHTS"}
    transfer.vert_mapping = "POLYINTERP_NEAREST"
    transfer.layers_vgroup_select_src = "ALL"
    transfer.layers_vgroup_select_dst = "NAME"
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=transfer.name)

    modifier = obj.modifiers.new(name="Rig_Humanoid_Shared_Deform", type="ARMATURE")
    modifier.object = armature
    modifier.use_vertex_groups = True
    modifier.use_deform_preserve_volume = True
    parent_preserving_world(obj, armature)
    report = validate_and_limit_weights(obj, "voxel_proxy_surface_transfer_top4")
    report["proxy_vertex_count"] = len(proxy.data.vertices)
    if int(report["zero_weight_vertices"]) > 0:
        raise RuntimeError(
            f"Voxel weight transfer left {report['zero_weight_vertices']} unweighted vertices on {obj.name}"
        )

    bpy.data.objects.remove(proxy, do_unlink=True)
    return report


def bind_mesh(
    obj: bpy.types.Object,
    armature: bpy.types.Object,
    bounds: dict[str, float],
) -> dict[str, object]:
    clear_old_rig_data(obj)
    groups = {name: obj.vertex_groups.new(name=name) for name in weight_rules.BONE_NAMES}
    material_names = " ".join(material.name for material in obj.data.materials if material is not None)
    center = object_center_world(obj)
    center_z_ratio = (center[2] - bounds["min_z"]) / max(bounds["height"], 1e-6)
    is_backpack = "backpack" in obj.name.lower()
    rigid = is_backpack or weight_rules.should_rigid_bind(
        obj.name,
        obj.data.name,
        material_names,
        len(obj.data.vertices),
    )
    rigid_bone = None
    if is_backpack:
        # The backpack is assembled from many spatially separated objects.
        # A position-based choice can attach its handle or base to a limb, so
        # keep the complete prop rigidly aligned with the upper torso.
        rigid_bone = "Chest"
    elif rigid:
        rigid_bone = weight_rules.rigid_bone_for(
            f"{obj.name} {obj.data.name}",
            center,
            center_z_ratio,
        )

    nonzero_bones: set[str] = set()
    zero_weight_vertices = 0
    maximum_sum_error = 0.0
    matrix = obj.matrix_world
    for vertex in obj.data.vertices:
        point = matrix @ vertex.co
        if rigid_bone:
            weights = [(rigid_bone, 1.0)]
        else:
            weights = weight_rules.auto_weights_for_position(
                (point.x, point.y, point.z),
                min_x=bounds["min_x"],
                max_x=bounds["max_x"],
                min_z=bounds["min_z"],
                height=bounds["height"],
            )
        normalized = weight_rules.normalize_weights(weights)
        total = sum(weight for _, weight in normalized)
        maximum_sum_error = max(maximum_sum_error, abs(total - 1.0))
        if total <= 1e-8:
            zero_weight_vertices += 1
            continue
        for bone_name, value in normalized:
            if value <= 1e-8:
                continue
            groups[bone_name].add([vertex.index], value, "REPLACE")
            nonzero_bones.add(bone_name)

    if not rigid_bone and len(obj.data.vertices) > 10_000:
        # Keep the generated continuous surface smooth at limb transitions,
        # but limit diffusion so weights do not travel into nearby garments.
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
        bpy.ops.object.vertex_group_smooth(
            group_select_mode="ALL",
            factor=0.55,
            repeat=4,
            expand=0.0,
        )
        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.vertex_group_normalize_all(lock_active=False)

    modifier = obj.modifiers.new(name="Rig_Humanoid_Shared_Deform", type="ARMATURE")
    modifier.object = armature
    modifier.use_vertex_groups = True
    modifier.use_deform_preserve_volume = True
    parent_preserving_world(obj, armature)
    if not rigid_bone and len(obj.data.vertices) > 10_000:
        return validate_and_limit_weights(obj, "semantic_seed_topology_smooth_top4")
    return {
        "object": obj.name,
        "vertices": len(obj.data.vertices),
        "mode": "rigid_single_bone" if rigid_bone else "humanoid_blended",
        "rigid_bone": rigid_bone,
        "nonzero_bones": sorted(nonzero_bones),
        "zero_weight_vertices": zero_weight_vertices,
        "maximum_weight_sum_error": maximum_sum_error,
    }


def bake_vertex_palette_basecolor(
    obj: bpy.types.Object,
    role: str,
    output_dir: Path,
) -> dict[str, object] | None:
    if obj.data.color_attributes.get("BodyPalette") is None or not obj.data.materials:
        return None

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UV0")
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(
            angle_limit=1.151917,
            island_margin=0.008,
            area_weight=0.25,
            correct_aspect=True,
            scale_to_bounds=False,
        )
        bpy.ops.object.mode_set(mode="OBJECT")

    material = obj.data.materials[0]
    material.name = f"M_{role}_PrecisionRemodel_v21_URP"
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    bsdf = next(node for node in nodes if node.bl_idname == "ShaderNodeBsdfPrincipled")
    texture_node = nodes.get("Baked_BaseColor_2K")
    if texture_node is None:
        texture_node = nodes.new("ShaderNodeTexImage")
        texture_node.name = "Baked_BaseColor_2K"
        texture_node.label = "Unity BaseColor 2K"
    image_name = f"Char_{role}_PrecisionRemodel_v21_BaseColor_2K"
    old_image = bpy.data.images.get(image_name)
    if old_image is not None:
        bpy.data.images.remove(old_image)
    image = bpy.data.images.new(image_name, width=2048, height=2048, alpha=False, float_buffer=False)
    image.colorspace_settings.name = "sRGB"
    texture_node.image = image
    for node in nodes:
        node.select = False
    texture_node.select = True
    nodes.active = texture_node

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    scene.render.bake.margin = 16
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"}, use_clear=True, margin=16)

    output_dir.mkdir(parents=True, exist_ok=True)
    texture_path = output_dir / f"{image_name}.png"
    image.filepath_raw = str(texture_path)
    image.file_format = "PNG"
    image.save()
    links.new(texture_node.outputs["Color"], bsdf.inputs["Base Color"])
    material.diffuse_color = (1.0, 1.0, 1.0, 1.0)
    return {
        "basecolor": str(texture_path.relative_to(ROOT)),
        "resolution": [2048, 2048],
        "uv_layer": obj.data.uv_layers.active.name,
        "material": material.name,
    }


def export_assets(
    meshes: list[bpy.types.Object],
    armature: bpy.types.Object,
    output_blend: Path,
    output_fbx: Path,
) -> Path:
    output_blend.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1.0
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
        use_armature_deform_only=False,
        mesh_smooth_type="FACE",
        use_custom_props=True,
        path_mode="COPY",
        embed_textures=True,
    )
    output_glb = output_fbx.with_suffix(".glb")
    bpy.ops.export_scene.gltf(
        filepath=str(output_glb),
        export_format="GLB",
        use_selection=True,
        export_skins=True,
        export_animations=False,
        export_yup=True,
    )
    return output_glb


def process_role(role: str) -> dict[str, object]:
    source, rigged_dir, output_blend, output_fbx = role_paths(role)
    if not source.is_file():
        raise FileNotFoundError(source)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    meshes = character_meshes()
    source_floor_z = place_feet_at_origin(meshes)
    bounds = world_bounds(meshes)
    armature, skeleton_scale = create_scaled_armature(bounds)
    primary_mesh = max(meshes, key=lambda item: len(item.data.vertices))
    mesh_reports = [bind_mesh(primary_mesh, armature, bounds)]
    mesh_reports.extend(bind_mesh(obj, armature, bounds) for obj in meshes if obj != primary_mesh)
    texture_report = bake_vertex_palette_basecolor(primary_mesh, role, rigged_dir / "Textures")
    material_names = sorted(
        {
            slot.material.name
            for obj in meshes
            for slot in obj.material_slots
            if slot.material is not None
        }
    )
    zero_weight_vertices = sum(int(item["zero_weight_vertices"]) for item in mesh_reports)
    maximum_weight_sum_error = max(float(item["maximum_weight_sum_error"]) for item in mesh_reports)
    if zero_weight_vertices:
        raise RuntimeError(f"{role} has {zero_weight_vertices} zero-weight vertices")
    if maximum_weight_sum_error > 1e-5:
        raise RuntimeError(f"{role} maximum weight normalization error is {maximum_weight_sum_error}")
    output_glb = export_assets(meshes, armature, output_blend, output_fbx)

    for stale in (output_fbx.with_suffix(".gltf"), output_fbx.with_suffix(".bin")):
        stale.unlink(missing_ok=True)
    report = {
        "asset": output_fbx.stem,
        "role": role,
        "pipeline": "blender_native_shared_humanoid_bind",
        "source_blend": str(source.relative_to(ROOT)),
        "output_blend": str(output_blend.relative_to(ROOT)),
        "output_fbx": str(output_fbx.relative_to(ROOT)),
        "output_glb": str(output_glb.relative_to(ROOT)),
        "bounds_meters": bounds,
        "origin_normalization": {
            "source_floor_z": source_floor_z,
            "output_floor_z": bounds["min_z"],
            "pivot_policy": "feet_on_z0_character_centered_in_source_xy",
        },
        "rig": {
            "armature": armature.name,
            "bone_count": len(armature.data.bones),
            "bone_names": [bone.name for bone in armature.data.bones],
            "shared_rest_pose_source": "relaxed_gameplay_bind_pose_scaled_from_character_bounds",
            "scale_from_1_82m_master": skeleton_scale,
        },
        "weighting": {
            "mesh_count": len(meshes),
            "vertex_count": bounds["vertex_count"],
            "zero_weight_vertices": zero_weight_vertices,
            "maximum_weight_sum_error": maximum_weight_sum_error,
            "mesh_reports": mesh_reports,
        },
        "unity_material": texture_report,
        "materials": {
            "unique_material_count": len(material_names),
            "unique_material_names": material_names,
        },
        "validation_summary": {
            "fbx_written": output_fbx.is_file() and output_fbx.stat().st_size > 1024,
            "glb_written": output_glb.is_file() and output_glb.stat().st_size > 1024,
            "blend_written": output_blend.is_file() and output_blend.stat().st_size > 1024,
            "all_vertices_weighted": zero_weight_vertices == 0,
            "weights_normalized": maximum_weight_sum_error <= 1e-5,
            "unity_humanoid_avatar": "pending Unity batch validation",
        },
    }
    reports_dir = rigged_dir / "Reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    report_path = reports_dir / f"{output_fbx.stem}_report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main() -> None:
    args = parse_arguments()
    reports = [process_role(role) for role in selected_roles(args.only)]
    print(json.dumps({"processed": [report["output_fbx"] for report in reports]}, indent=2))


if __name__ == "__main__":
    main()
