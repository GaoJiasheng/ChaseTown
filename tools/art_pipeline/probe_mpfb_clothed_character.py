"""Probe MPFB2 + MakeHuman assets as a higher-quality clothed character route.

This is a route probe, not a production character generator. It creates one
clothed Kid smoke model with real MakeHuman topology/assets, renders a preview,
and exports FBX for local inspection.
"""

from __future__ import annotations

from pathlib import Path
import importlib
import os
import sys

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
MPFB_SRC = ROOT / "tools" / "third_party" / "mpfb2" / "src"
ASSET_ROOT = ROOT / "tools" / "third_party" / "makehuman-assets" / "base"
OUT = ROOT / "docs" / "art_production" / "mpfb_smoke"


def bootstrap_mpfb():
    sys.path.insert(0, str(MPFB_SRC))
    user_home = OUT / "user_home"
    user_home.mkdir(parents=True, exist_ok=True)

    bpy.utils.extension_path_user = lambda package, path="": str(user_home / path)

    import mpfb  # type: ignore

    def get_pref(name: str):
        if name == "mpfb_second_root":
            return str(ASSET_ROOT)
        if name in {"mh_auto_user_data", "mpfb_codechecks"}:
            return False
        return ""

    mpfb.get_preference = get_pref
    mpfb.register()
    return mpfb


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.context.scene.render.resolution_x = 1400
    bpy.context.scene.render.resolution_y = 1800
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass


def dynamic_import(module: str, key: str):
    return getattr(importlib.import_module(module), key)


def find_asset(asset_service, filename: str, subdir: str) -> str:
    path = asset_service.find_asset_absolute_path(filename, asset_subdir=subdir)
    if path is None:
        raise RuntimeError(f"Missing MPFB asset {subdir}/{filename}")
    return path


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def normalize_scene_height(objects, target_height: float) -> None:
    meshes = [obj for obj in objects if obj.type == "MESH"]
    zs = []
    for obj in meshes:
        zs.extend([(obj.matrix_world @ v.co).z for v in obj.data.vertices])
    min_z, max_z = min(zs), max(zs)
    scale = target_height / max(max_z - min_z, 1e-5)
    for obj in objects:
        obj.scale = tuple(scale * v for v in obj.scale)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    zs = []
    for obj in meshes:
        zs.extend([(obj.matrix_world @ v.co).z for v in obj.data.vertices])
    min_z = min(zs)
    for obj in objects:
        obj.location.z -= min_z
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def setup_lighting(height: float) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.2, -4.0, height * 1.65))
    key = bpy.context.object
    key.name = "Preview_Key_Light"
    key.data.energy = 680
    key.data.size = 4.2
    bpy.ops.object.light_add(type="POINT", location=(-2.4, -2.2, height * 0.85))
    fill = bpy.context.object
    fill.name = "Preview_Fill_Light"
    fill.data.energy = 110
    bpy.ops.object.camera_add(location=(2.0, -4.25, height * 0.72))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, height * 0.52)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = height * 1.42
    bpy.context.scene.camera = cam


def render_preview(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def export_fbx(path: Path, objects: list[bpy.types.Object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.fbx(
        filepath=str(path),
        use_selection=True,
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="COPY",
        embed_textures=True,
        axis_forward="Z",
        axis_up="Y",
        apply_unit_scale=True,
    )


def make_preview_material(name: str, color: tuple[float, float, float, float], roughness: float = 0.62) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = color
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def assign_preview_materials(objects: list[bpy.types.Object]) -> None:
    mats = {
        "skin": make_preview_material("Preview_Skin_Warm", (0.86, 0.58, 0.43, 1.0), 0.56),
        "hair": make_preview_material("Preview_Hair_DarkBrown", (0.045, 0.035, 0.028, 1.0), 0.48),
        "cloth": make_preview_material("Preview_Cloth_Navy", (0.025, 0.065, 0.145, 1.0), 0.72),
        "shoe": make_preview_material("Preview_Shoe_Red", (0.62, 0.075, 0.045, 1.0), 0.54),
        "white": make_preview_material("Preview_White", (0.92, 0.88, 0.80, 1.0), 0.50),
    }
    for obj in objects:
        if obj.type != "MESH":
            continue
        lname = obj.name.lower()
        if "hair" in lname or "short" in lname or "eyebrow" in lname or "eyelash" in lname:
            mat = mats["hair"]
        elif "shoe" in lname:
            mat = mats["shoe"]
        elif "teeth" in lname:
            mat = mats["white"]
        elif "suit" in lname or "cloth" in lname:
            mat = mats["cloth"]
        else:
            mat = mats["skin"]
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.material_index = 0


def isolate_export_objects(export_objects: list[bpy.types.Object]) -> None:
    visible = set(export_objects)
    for obj in bpy.context.scene.objects:
        if obj not in visible and obj.type in {"MESH", "ARMATURE"}:
            obj.hide_render = True
            obj.hide_viewport = True


def main() -> int:
    reset_scene()
    bootstrap_mpfb()

    HumanService = dynamic_import("mpfb.services.humanservice", "HumanService")
    AssetService = dynamic_import("mpfb.services.assetservice", "AssetService")
    ObjectService = dynamic_import("mpfb.services.objectservice", "ObjectService")
    ExportService = dynamic_import("mpfb.services.exportservice", "ExportService")
    TargetService = dynamic_import("mpfb.services.targetservice", "TargetService")
    HumanObjectProperties = dynamic_import("mpfb.entities.objectproperties", "HumanObjectProperties")

    basemesh = HumanService.create_human()
    basemesh.name = "MPFB_Kid_Stylized_Source"

    HumanObjectProperties.set_value("gender", 0.0, entity_reference=basemesh)
    HumanObjectProperties.set_value("age", 0.18, entity_reference=basemesh)
    HumanObjectProperties.set_value("muscle", 0.25, entity_reference=basemesh)
    HumanObjectProperties.set_value("weight", 0.35, entity_reference=basemesh)
    HumanObjectProperties.set_value("caucasian", 0.85, entity_reference=basemesh)
    TargetService.reapply_macro_details(basemesh)

    skin = find_asset(AssetService, "young_caucasian_male.mhmat", "skins")
    HumanService.set_character_skin(skin, basemesh, skin_type="GAMEENGINE")
    HumanService.add_builtin_rig(basemesh, "game_engine")

    for subdir, filename, asset_type in [
        ("hair", "short02.mhclo", "Hair"),
        ("eyebrows", "eyebrow001.mhclo", "Eyebrows"),
        ("eyelashes", "eyelashes01.mhclo", "Eyelashes"),
        ("teeth", "teeth_base.mhclo", "Teeth"),
        ("tongue", "tongue01.mhclo", "Tongue"),
        ("clothes", "male_casualsuit05.mhclo", "Clothes"),
        ("clothes", "shoes04.mhclo", "Clothes"),
    ]:
        path = find_asset(AssetService, filename, subdir)
        HumanService.add_mhclo_asset(path, basemesh, asset_type=asset_type, material_type="GAMEENGINE")

    export_root = ExportService.create_character_copy(basemesh, name_suffix="_export")
    export_basemesh = ObjectService.find_object_of_type_amongst_nearest_relatives(export_root, "Basemesh")
    ExportService.bake_modifiers_remove_helpers(
        export_basemesh,
        bake_masks=True,
        bake_subdiv=True,
        remove_helpers=True,
        also_proxy=True,
    )

    export_objects = [export_root] + ObjectService.get_list_of_children(export_root)
    isolate_export_objects(export_objects)
    assign_preview_materials(export_objects)
    normalize_scene_height(export_objects, 1.30)
    setup_lighting(1.30)
    render_preview(OUT / "mpfb_kid_stylized_smoke_preview.png")
    export_fbx(OUT / "mpfb_kid_stylized_smoke.fbx", export_objects)

    print(f"Wrote {OUT / 'mpfb_kid_stylized_smoke_preview.png'}")
    print(f"Wrote {OUT / 'mpfb_kid_stylized_smoke.fbx'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
