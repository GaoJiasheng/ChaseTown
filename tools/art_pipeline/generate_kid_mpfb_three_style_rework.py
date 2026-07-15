#!/usr/bin/env python3
"""Generate Kid three-style candidates from MPFB/MakeHuman real assets.

This is a cleaner fallback after the MB-Lab offset-clothing route failed visual
self-review. It uses MPFB's MakeHuman basemesh, hair, eyebrows, eyelashes,
clothing, and shoes as the visible source meshes, then applies style-specific
materials and preview/export packaging.
"""

from __future__ import annotations

import importlib
import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MPFB_SRC = ROOT / "tools" / "third_party" / "mpfb2" / "src"
ASSET_ROOT = ROOT / "tools" / "third_party" / "makehuman-assets" / "base"
VERSION_DIR = "MPFBHumanRework_2026_07_12_v5"
CONTACT_SHEET = ROOT / "docs" / "art_production" / "KID_MPFB_THREE_STYLE_CONTACT_SHEET_V5.png"

SPECS = [
    {
        "style": "Photoreal",
        "asset": "Kid_Photoreal_MPFBHuman_v5",
        "height": 1.34,
        "age": 0.16,
        "muscle": 0.18,
        "weight": 0.35,
        "clothes": "male_casualsuit01.mhclo",
        "shoe": "shoes04.mhclo",
        "hair": "short02.mhclo",
        "budget": (40000, 70000),
        "colors": {
            "skin": (0.80, 0.57, 0.45, 1.0),
            "hair": (0.038, 0.030, 0.024, 1.0),
            "cloth": (0.055, 0.110, 0.165, 1.0),
            "pants": (0.045, 0.060, 0.075, 1.0),
            "shoe": (0.56, 0.075, 0.055, 1.0),
            "eye": (0.020, 0.023, 0.027, 1.0),
            "mouth": (0.34, 0.13, 0.12, 1.0),
        },
    },
    {
        "style": "Stylized",
        "asset": "Kid_Cartoon_MPFBHuman_v5",
        "height": 1.31,
        "age": 0.15,
        "muscle": 0.12,
        "weight": 0.32,
        "clothes": "male_casualsuit01.mhclo",
        "shoe": "shoes04.mhclo",
        "hair": "short02.mhclo",
        "budget": (18000, 30000),
        "colors": {
            "skin": (0.86, 0.64, 0.50, 1.0),
            "hair": (0.045, 0.034, 0.026, 1.0),
            "cloth": (0.040, 0.290, 0.450, 1.0),
            "pants": (0.035, 0.120, 0.200, 1.0),
            "shoe": (0.82, 0.11, 0.065, 1.0),
            "eye": (0.02, 0.025, 0.030, 1.0),
            "mouth": (0.30, 0.085, 0.080, 1.0),
        },
    },
    {
        "style": "BlindBox",
        "asset": "Kid_BlindBox_MPFBHuman_v5",
        "height": 1.18,
        "age": 0.12,
        "muscle": 0.08,
        "weight": 0.30,
        "clothes": "male_casualsuit01.mhclo",
        "shoe": "shoes04.mhclo",
        "hair": "short02.mhclo",
        "budget": (12000, 20000),
        "colors": {
            "skin": (0.93, 0.72, 0.58, 1.0),
            "hair": (0.055, 0.040, 0.032, 1.0),
            "cloth": (0.070, 0.440, 0.680, 1.0),
            "pants": (0.040, 0.220, 0.360, 1.0),
            "shoe": (0.90, 0.14, 0.080, 1.0),
            "eye": (0.01, 0.012, 0.016, 1.0),
            "mouth": (0.44, 0.16, 0.15, 1.0),
        },
    },
]


def run_blender() -> None:
    subprocess.run(["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build"], cwd=str(ROOT), check=True)
    build_contact_sheet()


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw

    sheet = Image.new("RGB", (2460, 1080), (34, 34, 34))
    draw = ImageDraw.Draw(sheet)
    labels = {"Photoreal": "Photoreal", "Stylized": "Cartoon", "BlindBox": "BlindBox"}
    for i, spec in enumerate(SPECS):
        img_path = ROOT / "art-source" / "Characters" / "Kid" / spec["style"] / VERSION_DIR / "Previews" / f"{spec['asset']}_preview.png"
        img = Image.open(img_path).convert("RGB")
        img.thumbnail((760, 980), Image.Resampling.LANCZOS)
        x = i * 820 + (820 - img.width) // 2
        y = 78
        sheet.paste(img, (x, y))
        draw.text((i * 820 + 42, 28), labels[spec["style"]], fill=(242, 242, 236))
    CONTACT_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(CONTACT_SHEET, optimize=True)


def blender_main() -> None:
    import bpy
    from mathutils import Vector

    sys.path.insert(0, str(MPFB_SRC))
    user_home = ROOT / "docs" / "art_production" / "mpfb_three_style_runtime"
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

    def dyn(module: str, key: str):
        return getattr(importlib.import_module(module), key)

    HumanService = dyn("mpfb.services.humanservice", "HumanService")
    AssetService = dyn("mpfb.services.assetservice", "AssetService")
    ObjectService = dyn("mpfb.services.objectservice", "ObjectService")
    ExportService = dyn("mpfb.services.exportservice", "ExportService")
    TargetService = dyn("mpfb.services.targetservice", "TargetService")
    HumanObjectProperties = dyn("mpfb.entities.objectproperties", "HumanObjectProperties")

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
        if hasattr(bpy.context.scene, "eevee"):
            bpy.context.scene.eevee.taa_render_samples = 64
        bpy.context.scene.view_settings.view_transform = "Filmic"
        bpy.context.scene.view_settings.look = "Medium High Contrast"

    def find_asset(filename: str, subdir: str) -> str:
        path = AssetService.find_asset_absolute_path(filename, asset_subdir=subdir)
        if path is None:
            raise RuntimeError(f"Missing MakeHuman asset {subdir}/{filename}")
        return path

    def make_mat(name: str, color, roughness=0.58, metallic=0.0):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.diffuse_color = color
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = metallic
        return mat

    def assign_materials(objects, spec: dict) -> None:
        c = spec["colors"]
        blind = spec["style"] == "BlindBox"
        preserve_source_texture = False
        mats = {
            "skin": make_mat(f"{spec['asset']}_Skin", c["skin"], 0.44 if not blind else 0.28),
            "hair": make_mat(f"{spec['asset']}_Hair", c["hair"], 0.36 if not blind else 0.25),
            "cloth": make_mat(f"{spec['asset']}_Cloth", c["cloth"], 0.70 if not blind else 0.40),
            "pants": make_mat(f"{spec['asset']}_Pants", c["pants"], 0.72 if not blind else 0.42),
            "shoe": make_mat(f"{spec['asset']}_ShoeRed", c["shoe"], 0.45 if not blind else 0.30),
            "white": make_mat(f"{spec['asset']}_EyeWhite", (0.94, 0.92, 0.86, 1.0), 0.36),
            "eye": make_mat(f"{spec['asset']}_EyeDark", c["eye"], 0.24),
            "cheek": make_mat(f"{spec['asset']}_CheekWarmth", (0.94, 0.38, 0.32, 1.0), 0.50),
            "detail": make_mat(f"{spec['asset']}_GarmentDetail", (0.018, 0.024, 0.030, 1.0), 0.58),
            "mouth": make_mat(f"{spec['asset']}_Mouth", c["mouth"], 0.45 if not blind else 0.30),
            "highlight": make_mat(f"{spec['asset']}_EyeHighlight", (1.0, 0.96, 0.86, 1.0), 0.20),
        }
        scene_bounds = evaluated_bounds(objects)
        height = scene_bounds["max_z"] - scene_bounds["min_z"]
        for obj in objects:
            if obj.type != "MESH":
                continue
            lname = obj.name.lower()
            if preserve_source_texture and not any(key in lname for key in ("eye_", "cheek_", "soft_mouth")):
                if not obj.data.materials:
                    obj.data.materials.append(mats["skin"])
                for mat in obj.data.materials:
                    if mat:
                        mat.use_nodes = True
                        bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
                        if bsdf and "Roughness" in bsdf.inputs:
                            bsdf.inputs["Roughness"].default_value = 0.50
                for poly in obj.data.polygons:
                    poly.use_smooth = True
                continue
            if any(key in lname for key in ("hair", "short", "bob", "long", "afro", "eyebrow", "eyelash")):
                mat = mats["hair"]
            elif "shoe" in lname:
                mat = mats["shoe"]
            elif "teeth" in lname or "tongue" in lname:
                mat = mats["white"]
            elif "suit" in lname or "cloth" in lname or "clothes" in lname:
                obj.data.materials.clear()
                obj.data.materials.append(mats["cloth"])
                obj.data.materials.append(mats["pants"])
                for poly in obj.data.polygons:
                    center = sum((obj.data.vertices[i].co for i in poly.vertices), obj.data.vertices[poly.vertices[0]].co * 0.0) / len(poly.vertices)
                    world = obj.matrix_world @ center
                    rel_z = (world.z - scene_bounds["min_z"]) / max(height, 1e-6)
                    if rel_z < 0.42:
                        poly.material_index = 1
                    else:
                        poly.material_index = 0
                    poly.use_smooth = True
                continue
            else:
                mat = mats["skin"]
            obj.data.materials.clear()
            obj.data.materials.append(mat)
            for poly in obj.data.polygons:
                poly.material_index = 0
                poly.use_smooth = True
        return mats

    def evaluated_points(objects):
        depsgraph = bpy.context.evaluated_depsgraph_get()
        points = []
        for obj in objects:
            if obj.type != "MESH" or obj.get("exclude_from_export"):
                continue
            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            points.extend(eval_obj.matrix_world @ v.co for v in mesh.vertices)
            eval_obj.to_mesh_clear()
        return points

    def evaluated_bounds(objects):
        points = evaluated_points(objects)
        if not points:
            raise RuntimeError("No mesh points available for bounds")
        return {
            "min_x": min(p.x for p in points),
            "max_x": max(p.x for p in points),
            "min_y": min(p.y for p in points),
            "max_y": max(p.y for p in points),
            "min_z": min(p.z for p in points),
            "max_z": max(p.z for p in points),
        }

    def normalize(objects, target_height: float) -> None:
        bounds = evaluated_bounds(objects)
        current_height = max(bounds["max_z"] - bounds["min_z"], 1e-6)
        scale = target_height / current_height
        roots = [obj for obj in objects if obj.parent is None]
        for obj in roots:
            obj.scale = tuple(scale * v for v in obj.scale)
        bpy.context.view_layer.update()

        bounds = evaluated_bounds(objects)
        for obj in roots:
            obj.location.z -= bounds["min_z"]
        bpy.context.view_layer.update()

    def scale_head_region(objects, height: float, ratio: float) -> None:
        if ratio == 1.0:
            return
        pivot = Vector((0, 0, height * 0.82))
        for obj in objects:
            if obj.type != "MESH":
                continue
            lname = obj.name.lower()
            if any(key in lname for key in ("hair", "eyebrow", "eyelash")):
                full = True
            else:
                full = False
            for v in obj.data.vertices:
                world = obj.matrix_world @ v.co
                if full or world.z > height * 0.72:
                    local_pivot = obj.matrix_world.inverted() @ pivot
                    v.co = local_pivot + (v.co - local_pivot) * ratio
            obj.data.update()

    def look_at(obj, target: Vector) -> None:
        direction = target - obj.location
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    def setup_camera(height: float) -> None:
        bpy.ops.object.light_add(type="AREA", location=(-2.0, -3.4, height * 2.2))
        key = bpy.context.object
        key.name = "Key_Light_Softbox"
        key.data.energy = 720
        key.data.size = 4.4
        bpy.ops.object.light_add(type="AREA", location=(2.0, -2.2, height * 0.9))
        fill = bpy.context.object
        fill.name = "Face_Fill_Light"
        fill.data.energy = 145
        fill.data.size = 2.0
        bpy.ops.object.camera_add(location=(height * 0.18, -height * 3.1, height * 0.62))
        cam = bpy.context.object
        look_at(cam, Vector((0, 0, height * 0.54)))
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = height * 1.20
        bpy.context.scene.camera = cam
        bpy.ops.mesh.primitive_plane_add(size=height * 1.7, location=(0, 0, -0.002))
        floor = bpy.context.object
        floor.name = "Preview_Ground_ShadowPlane"
        floor["exclude_from_export"] = True
        mat = make_mat("Preview_Ground_Matte", (0.38, 0.38, 0.36, 1), 0.8)
        floor.data.materials.append(mat)

    def add_eye_overlays(objects, spec: dict, mats: dict):
        style = spec["style"]
        bounds = evaluated_bounds(objects)
        height = bounds["max_z"] - bounds["min_z"]
        face_refs = [
            obj
            for obj in objects
            if obj.type == "MESH" and any(key in obj.name.lower() for key in ("eyebrow", "eyelash"))
        ]
        if face_refs:
            face_bounds = evaluated_bounds(face_refs)
            y = face_bounds["min_y"] - height * 0.006
            z_drop = 0.014 if style == "Photoreal" else 0.016 if style == "Stylized" else 0.014
            z = (face_bounds["min_z"] + face_bounds["max_z"]) * 0.5 - height * z_drop
            x_span = max(abs(face_bounds["min_x"]), abs(face_bounds["max_x"]))
            offset_mul = 0.48 if style == "Photoreal" else 0.53 if style == "Stylized" else 0.62
            x_offset = max(height * 0.024, x_span * offset_mul)
        else:
            y = bounds["min_y"] - height * 0.006
            z = bounds["min_z"] + height * 0.84
            x_offset = height * 0.032
        if style == "Photoreal":
            eye_x, eye_z, iris_scale, brow = 0.0042, 0.0028, 1.0, False
            x_offset *= 0.92
        elif style == "Stylized":
            eye_x, eye_z, iris_scale, brow = 0.0090, 0.0070, 1.0, False
        else:
            eye_x, eye_z, iris_scale, brow = 0.0145, 0.0125, 1.0, False
            x_offset *= 1.04
        made = []

        def add_flat(name: str, loc, scale, mat, segments=32, rings=12):
            bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
            obj = bpy.context.object
            obj.name = name
            obj.scale = scale
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            obj.data.materials.append(mat)
            made.append(obj)
            return obj

        for side in (-1, 1):
            x = side * x_offset
            if style == "Photoreal":
                add_flat(
                    f"Eye_Depth_Pin_{side}",
                    (x, y - height * 0.0045, z),
                    (height * eye_x, height * 0.0012, height * eye_z),
                    mats["eye"],
                    18,
                    8,
                )
            elif style == "BlindBox":
                add_flat(
                    f"Eye_Glossy_Button_{side}",
                    (x, y - height * 0.003, z),
                    (height * eye_x, height * 0.0038, height * eye_z),
                    mats["eye"],
                    36,
                    14,
                )
                add_flat(
                    f"Eye_Button_Highlight_{side}",
                    (x - side * height * eye_x * 0.35, y - height * 0.006, z + height * eye_z * 0.36),
                    (height * eye_x * 0.20, height * 0.0012, height * eye_z * 0.16),
                    mats["highlight"],
                    16,
                    8,
                )
            else:
                add_flat(
                    f"Eye_Cartoon_Dark_{side}",
                    (x, y - height * 0.002, z),
                    (height * eye_x, height * 0.0030, height * eye_z),
                    mats["eye"],
                    32,
                    12,
                )
                add_flat(
                    f"Eye_Highlight_{side}",
                    (x - side * height * eye_x * 0.30, y - height * 0.0065, z + height * eye_z * 0.30),
                    (height * eye_x * 0.18, height * 0.0010, height * eye_z * 0.16),
                    mats["highlight"],
                    12,
                    6,
                )
                if brow:
                    brow_obj = add_flat(
                        f"Soft_Brow_{side}",
                        (x - side * height * eye_x * 0.08, y - height * 0.0025, z + height * eye_z * 1.25),
                        (height * eye_x * 0.92, height * 0.0014, height * eye_z * 0.20),
                        mats["hair"],
                        18,
                        6,
                    )
                    brow_obj.rotation_euler[1] = side * 0.10
        if style != "Photoreal":
            for side in (-1, 1):
                x = side * x_offset * 1.18
                cheek_scale = (height * eye_x * 0.44, height * 0.0013, height * eye_z * 0.22)
                add_flat(f"Cheek_Tint_{side}", (x, y + height * 0.001, z - height * 0.045), cheek_scale, mats["cheek"], 20, 8)
        if style == "Stylized":
            add_flat(
                "Soft_Mouth",
                (0, y - height * 0.0045, z - height * 0.062),
                (height * 0.018, height * 0.0012, height * 0.0018),
                mats["mouth"],
                20,
                5,
            )
        return made

    def add_photoreal_garment_detail(objects, spec: dict, mats: dict):
        if spec["style"] != "Photoreal":
            return []
        cloth_objects = [
            obj
            for obj in objects
            if obj.type == "MESH" and any(key in obj.name.lower() for key in ("suit", "cloth", "clothes"))
        ]
        if not cloth_objects:
            return []
        bounds = evaluated_bounds(cloth_objects)
        full_bounds = evaluated_bounds(objects)
        height = full_bounds["max_z"] - full_bounds["min_z"]
        y = bounds["min_y"] - height * 0.004
        made = []
        for i in range(8):
            z = full_bounds["min_z"] + height * (0.42 + i * 0.032)
            bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(0.0, y, z))
            button = bpy.context.object
            button.name = f"Photoreal_Zipper_Button_{i:02d}"
            button.scale = (height * 0.006, height * 0.0016, height * 0.006)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            button.data.materials.append(mats["detail"])
            made.append(button)
        return made

    def remove_realistic_face_proxies(objects, style: str) -> None:
        for obj in objects:
            if obj.type == "MESH" and any(key in obj.name.lower() for key in ("eyebrow", "eyelash")):
                obj.hide_set(True)
                obj.hide_render = True
                obj["exclude_from_export"] = True

    def polish_surface(objects, style: str) -> None:
        cloth_factor = 0.18 if style == "Photoreal" else 0.30 if style == "Stylized" else 0.38
        cloth_iterations = 3 if style == "Photoreal" else 4 if style == "Stylized" else 5
        for obj in objects:
            if obj.type != "MESH" or obj.get("exclude_from_export"):
                continue
            lname = obj.name.lower()
            if any(key in lname for key in ("suit", "cloth", "clothes", "casual", "worksuit")):
                smooth = obj.modifiers.new(f"{style}_Cloth_Surface_Polish", "SMOOTH")
                smooth.factor = cloth_factor
                smooth.iterations = cloth_iterations
                smooth.show_render = True
            if any(key in lname for key in ("suit", "cloth", "clothes", "casual", "worksuit", "hair", "short", "bob", "long", "afro")):
                weighted = obj.modifiers.new(f"{style}_Weighted_Normals", "WEIGHTED_NORMAL")
                weighted.keep_sharp = True
                weighted.show_render = True

    def decimate_for_style_budget(objects, style: str) -> None:
        ratio = 0.62 if style == "Stylized" else 0.38 if style == "BlindBox" else 1.0
        if ratio >= 1.0:
            return
        for obj in objects:
            if obj.type != "MESH" or obj.get("exclude_from_export"):
                continue
            if any(key in obj.name.lower() for key in ("eye_", "cheek_", "pupil", "sclera")):
                continue
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            mod = obj.modifiers.new(f"{style}_Budget_Decimate", "DECIMATE")
            mod.ratio = ratio
            mod.show_render = True

    def render(path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)

    def draw_wire(objects, path: Path) -> None:
        wire = make_mat("Wireframe_Audit_Black", (0.01, 0.01, 0.01, 1), 0.5)
        for obj in objects:
            if obj.type != "MESH":
                continue
            obj.data.materials.append(wire)
            mod = obj.modifiers.new("Audit_Wireframe_Overlay", "WIREFRAME")
            mod.thickness = 0.002
            mod.use_replace = False
            mod.material_offset = len(obj.data.materials) - 1
        render(path)

    def stats(objects):
        depsgraph = bpy.context.evaluated_depsgraph_get()
        vertices = polygons = triangles = 0
        for obj in objects:
            if obj.type != "MESH" or obj.get("exclude_from_export"):
                continue
            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            mesh.calc_loop_triangles()
            vertices += len(mesh.vertices)
            polygons += len(mesh.polygons)
            triangles += len(mesh.loop_triangles)
            eval_obj.to_mesh_clear()
        return {"vertices": vertices, "polygons": polygons, "triangles": triangles}

    def export(out_dir: Path, asset: str, objects):
        export_objects = [obj for obj in objects if not obj.get("exclude_from_export")]
        bpy.ops.object.select_all(action="DESELECT")
        for obj in export_objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = export_objects[0]
        fbx = out_dir / f"{asset}.fbx"
        glb = out_dir / f"{asset}.glb"
        bpy.ops.export_scene.fbx(
            filepath=str(fbx),
            use_selection=True,
            add_leaf_bones=False,
            bake_anim=False,
            object_types={"MESH", "ARMATURE"},
            path_mode="COPY",
            embed_textures=False,
            axis_forward="Z",
            axis_up="Y",
            apply_unit_scale=True,
        )
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
        return fbx, glb

    def export_photoreal_lods(out_dir: Path, asset: str, objects):
        lods = {}
        for label, ratio in [("LOD1", 0.55), ("LOD2", 0.28)]:
            mods = []
            for obj in objects:
                if obj.type != "MESH" or obj.get("exclude_from_export"):
                    continue
                mod = obj.modifiers.new(f"{label}_Decimate", "DECIMATE")
                mod.ratio = ratio
                mod.show_render = True
                mods.append((obj, mod))
            bpy.context.view_layer.update()
            lod_stats = stats(objects)
            fbx, glb = export(out_dir, f"{asset}_{label}", objects)
            lods[label] = {"fbx": rel(fbx), "glb": rel(glb), "triangles": lod_stats["triangles"]}
            for obj, mod in mods:
                obj.modifiers.remove(mod)
            bpy.context.view_layer.update()
        return lods

    def rel(path: Path) -> str:
        return str(path.relative_to(ROOT))

    summary_assets = []
    for spec in SPECS:
        reset_scene()
        basemesh = HumanService.create_human()
        basemesh.name = f"{spec['asset']}_SourceHuman"
        HumanObjectProperties.set_value("gender", 0.0, entity_reference=basemesh)
        HumanObjectProperties.set_value("age", spec["age"], entity_reference=basemesh)
        HumanObjectProperties.set_value("muscle", spec["muscle"], entity_reference=basemesh)
        HumanObjectProperties.set_value("weight", spec["weight"], entity_reference=basemesh)
        HumanObjectProperties.set_value("caucasian", 0.88, entity_reference=basemesh)
        TargetService.reapply_macro_details(basemesh)
        skin = find_asset("young_caucasian_male.mhmat", "skins")
        HumanService.set_character_skin(skin, basemesh, skin_type="GAMEENGINE")
        HumanService.add_builtin_rig(basemesh, "game_engine")

        asset_requests = [
            ("hair", spec["hair"], "Hair"),
            ("eyebrows", "eyebrow001.mhclo", "Eyebrows"),
            ("eyelashes", "eyelashes01.mhclo", "Eyelashes"),
            ("clothes", spec["clothes"], "Clothes"),
            ("clothes", spec["shoe"], "Clothes"),
        ]
        if spec["style"] == "Photoreal":
            asset_requests.extend([
                ("teeth", "teeth_base.mhclo", "Teeth"),
                ("tongue", "tongue01.mhclo", "Tongue"),
            ])
        for subdir, filename, kind in asset_requests:
            HumanService.add_mhclo_asset(find_asset(filename, subdir), basemesh, asset_type=kind, material_type="GAMEENGINE")

        export_root = ExportService.create_character_copy(basemesh, name_suffix="_export")
        export_basemesh = ObjectService.find_object_of_type_amongst_nearest_relatives(export_root, "Basemesh")
        ExportService.bake_modifiers_remove_helpers(export_basemesh, bake_masks=True, bake_subdiv=True, remove_helpers=True, also_proxy=True)

        source_prefix = basemesh.name
        for obj in bpy.context.scene.objects:
            if obj.name.startswith(source_prefix) and "_export" not in obj.name:
                obj.hide_set(True)
                obj.hide_render = True

        objects = [export_root] + ObjectService.get_list_of_children(export_root)
        normalize(objects, spec["height"])
        if spec["style"] == "Stylized":
            scale_head_region(objects, spec["height"], 1.08)
        elif spec["style"] == "BlindBox":
            scale_head_region(objects, spec["height"], 1.24)
        mats = assign_materials(objects, spec)
        eye_overlays = add_eye_overlays(objects, spec, mats)
        objects.extend(eye_overlays)
        garment_details = add_photoreal_garment_detail(objects, spec, mats)
        objects.extend(garment_details)
        remove_realistic_face_proxies(objects, spec["style"])
        polish_surface(objects, spec["style"])
        decimate_for_style_budget(objects, spec["style"])
        setup_camera(spec["height"])

        out_dir = ROOT / "art-source" / "Characters" / "Kid" / spec["style"] / VERSION_DIR
        preview_dir = out_dir / "Previews"
        report_dir = out_dir / "Reports"
        out_dir.mkdir(parents=True, exist_ok=True)
        preview_dir.mkdir(parents=True, exist_ok=True)
        report_dir.mkdir(parents=True, exist_ok=True)
        blend = out_dir / f"{spec['asset']}.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(blend))
        fbx, glb = export(out_dir, spec["asset"], objects)
        lods = export_photoreal_lods(out_dir, spec["asset"], objects) if spec["style"] == "Photoreal" else {}
        preview = preview_dir / f"{spec['asset']}_preview.png"
        wire = preview_dir / f"{spec['asset']}_wireframe.png"
        render(preview)
        st = stats(objects)
        draw_wire([obj for obj in objects if not obj.get("exclude_from_export")], wire)
        report = {
            "asset": spec["asset"],
            "role": "Kid",
            "style": spec["style"],
            "status": "mpfb_human_based_local_gate_candidate_user_visual_review_pending",
            "source": {
                "body": "MPFB/MakeHuman basemesh",
                "hair": spec["hair"],
                "clothes": spec["clothes"],
                "shoes": spec["shoe"],
                "primitive_composed_human": False,
            },
            "outputs": {"blend": rel(blend), "fbx": rel(fbx), "glb": rel(glb), "preview": rel(preview), "wireframe": rel(wire)},
            "lods": lods,
            "budget": {
                "target_tris_min": spec["budget"][0],
                "target_tris_max": spec["budget"][1],
                "actual_vertices": st["vertices"],
                "actual_polygons": st["polygons"],
                "actual_triangles": st["triangles"],
                "triangle_budget_passed": spec["budget"][0] <= st["triangles"] <= spec["budget"][1],
            },
            "limitations": ["Unity Humanoid Avatar validation still blocked by missing active Unity license."],
        }
        report_path = report_dir / f"{spec['asset']}_budget_report.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        summary_entry = {"asset": spec["asset"], "style": spec["style"], "triangles": st["triangles"], "preview": rel(preview), "report": rel(report_path)}
        if lods:
            summary_entry["lods"] = lods
        summary_assets.append(summary_entry)

    summary = {
        "asset_count": 3,
        "scope": "Kid B1/B2/B3 MPFB human-based visual rework v5",
        "assets": summary_assets,
        "contact_sheet": rel(CONTACT_SHEET),
        "unity_validation": "blocked_no_active_unity_license",
    }
    out = ROOT / "docs" / "art_production" / "KID_MPFB_THREE_STYLE_REWORK_SUMMARY_V5.json"
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if "--build" in sys.argv:
        blender_main()
    else:
        run_blender()
