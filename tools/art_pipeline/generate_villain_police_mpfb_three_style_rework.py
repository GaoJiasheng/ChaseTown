#!/usr/bin/env python3
"""Generate Villain and Police candidates from MPFB/MakeHuman real assets.

This is the heavier fallback after the MB-Lab offset-clothing route still looked
too much like a constructed proxy. It uses MPFB's MakeHuman basemesh, hair,
face assets, clothing, and shoes as the visible source, then adds role-specific
hard-surface and cloth details for reviewable art-only FBX/GLB candidates.
"""

from __future__ import annotations

import importlib
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MPFB_SRC = ROOT / "tools" / "third_party" / "mpfb2" / "src"
ASSET_ROOT = ROOT / "tools" / "third_party" / "makehuman-assets" / "base"
VERSION_DIR = "MPFBRoleRework_2026_07_12_v29"
CONTACT_SHEET = ROOT / "docs" / "art_production" / "VILLAIN_POLICE_MPFB_THREE_STYLE_CONTACT_SHEET_V29.png"
SUMMARY_PATH = ROOT / "docs" / "art_production" / "VILLAIN_POLICE_MPFB_THREE_STYLE_REWORK_SUMMARY_V29.json"

SPECS = [
    {
        "role": "Villain",
        "style": "Photoreal",
        "label": "Villain Photoreal",
        "asset": "Villain_Photoreal_MPFBHuman_v29",
        "height": 1.88,
        "age": 0.48,
        "muscle": 0.58,
        "weight": 0.62,
        "clothes": "male_casualsuit05.mhclo",
        "shoe": "shoes04.mhclo",
        "hair": "short02.mhclo",
        "budget": (45000, 85000),
        "colors": {
            "skin": (0.56, 0.39, 0.30, 1.0),
            "hair": (0.025, 0.021, 0.018, 1.0),
            "cloth": (0.028, 0.026, 0.025, 1.0),
            "pants": (0.018, 0.017, 0.016, 1.0),
            "shoe": (0.010, 0.010, 0.010, 1.0),
            "eye": (0.015, 0.012, 0.010, 1.0),
            "mouth": (0.18, 0.08, 0.065, 1.0),
            "metal": (0.34, 0.30, 0.25, 1.0),
            "accent": (0.052, 0.042, 0.038, 1.0),
        },
    },
    {
        "role": "Villain",
        "style": "Stylized",
        "label": "Villain Cartoon",
        "asset": "Villain_Stylized_MPFBHuman_v29",
        "height": 1.82,
        "age": 0.42,
        "muscle": 0.48,
        "weight": 0.56,
        "clothes": "male_casualsuit05.mhclo",
        "shoe": "shoes04.mhclo",
        "hair": "short02.mhclo",
        "budget": (22000, 42000),
        "colors": {
            "skin": (0.62, 0.44, 0.33, 1.0),
            "hair": (0.032, 0.026, 0.022, 1.0),
            "cloth": (0.042, 0.038, 0.035, 1.0),
            "pants": (0.023, 0.021, 0.020, 1.0),
            "shoe": (0.012, 0.012, 0.012, 1.0),
            "eye": (0.018, 0.014, 0.010, 1.0),
            "mouth": (0.20, 0.08, 0.07, 1.0),
            "metal": (0.40, 0.34, 0.27, 1.0),
            "accent": (0.062, 0.048, 0.042, 1.0),
        },
    },
    {
        "role": "Villain",
        "style": "BlindBox",
        "label": "Villain BlindBox",
        "asset": "Villain_BlindBox_MPFBHuman_v29",
        "height": 1.28,
        "age": 0.24,
        "muscle": 0.20,
        "weight": 0.48,
        "clothes": "male_casualsuit05.mhclo",
        "shoe": "shoes04.mhclo",
        "hair": "short02.mhclo",
        "budget": (12000, 24000),
        "colors": {
            "skin": (0.78, 0.60, 0.47, 1.0),
            "hair": (0.035, 0.028, 0.023, 1.0),
            "cloth": (0.070, 0.060, 0.052, 1.0),
            "pants": (0.032, 0.029, 0.027, 1.0),
            "shoe": (0.014, 0.014, 0.014, 1.0),
            "eye": (0.010, 0.010, 0.010, 1.0),
            "mouth": (0.24, 0.10, 0.085, 1.0),
            "metal": (0.52, 0.47, 0.39, 1.0),
            "accent": (0.074, 0.052, 0.046, 1.0),
        },
    },
    {
        "role": "Police",
        "style": "Photoreal",
        "label": "Police Photoreal",
        "asset": "Police_Photoreal_MPFBHuman_v29",
        "height": 1.82,
        "age": 0.35,
        "muscle": 0.55,
        "weight": 0.48,
        "clothes": "male_casualsuit03.mhclo",
        "shoe": "shoes02.mhclo",
        "hair": "short01.mhclo",
        "budget": (42000, 76000),
        "colors": {
            "skin": (0.78, 0.56, 0.40, 1.0),
            "hair": (0.025, 0.021, 0.018, 1.0),
            "cloth": (0.016, 0.050, 0.106, 1.0),
            "pants": (0.012, 0.038, 0.086, 1.0),
            "shoe": (0.010, 0.010, 0.012, 1.0),
            "eye": (0.018, 0.022, 0.026, 1.0),
            "mouth": (0.34, 0.12, 0.10, 1.0),
            "metal": (0.58, 0.47, 0.26, 1.0),
            "accent": (0.006, 0.018, 0.045, 1.0),
        },
    },
    {
        "role": "Police",
        "style": "Stylized",
        "label": "Police Cartoon",
        "asset": "Police_Stylized_MPFBHuman_v29",
        "height": 1.76,
        "age": 0.30,
        "muscle": 0.42,
        "weight": 0.42,
        "clothes": "male_casualsuit03.mhclo",
        "shoe": "shoes02.mhclo",
        "hair": "short01.mhclo",
        "budget": (20000, 38000),
        "colors": {
            "skin": (0.84, 0.62, 0.44, 1.0),
            "hair": (0.026, 0.022, 0.018, 1.0),
            "cloth": (0.022, 0.092, 0.188, 1.0),
            "pants": (0.016, 0.074, 0.155, 1.0),
            "shoe": (0.010, 0.010, 0.012, 1.0),
            "eye": (0.016, 0.020, 0.025, 1.0),
            "mouth": (0.38, 0.13, 0.11, 1.0),
            "metal": (0.62, 0.50, 0.28, 1.0),
            "accent": (0.010, 0.034, 0.075, 1.0),
        },
    },
    {
        "role": "Police",
        "style": "BlindBox",
        "label": "Police BlindBox",
        "asset": "Police_BlindBox_MPFBHuman_v29",
        "height": 1.24,
        "age": 0.22,
        "muscle": 0.18,
        "weight": 0.38,
        "clothes": "male_casualsuit03.mhclo",
        "shoe": "shoes02.mhclo",
        "hair": "short01.mhclo",
        "budget": (12000, 24000),
        "colors": {
            "skin": (0.92, 0.70, 0.52, 1.0),
            "hair": (0.030, 0.024, 0.020, 1.0),
            "cloth": (0.026, 0.118, 0.240, 1.0),
            "pants": (0.018, 0.096, 0.205, 1.0),
            "shoe": (0.012, 0.012, 0.014, 1.0),
            "eye": (0.008, 0.010, 0.012, 1.0),
            "mouth": (0.45, 0.15, 0.12, 1.0),
            "metal": (0.66, 0.54, 0.31, 1.0),
            "accent": (0.010, 0.045, 0.100, 1.0),
        },
    },
]


def run_blender() -> None:
    subprocess.run([sys.executable, str(ROOT / "tools" / "art_pipeline" / "generate_character_pbr_textures.py")], cwd=str(ROOT), check=True)
    subprocess.run(["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build"], cwd=str(ROOT), check=True)
    build_contact_sheet()


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw

    sheet = Image.new("RGB", (2460, 2160), (34, 34, 34))
    draw = ImageDraw.Draw(sheet)
    for i, spec in enumerate(SPECS):
        row = 0 if spec["role"] == "Villain" else 1
        col = {"Photoreal": 0, "Stylized": 1, "BlindBox": 2}[spec["style"]]
        img_path = (
            ROOT
            / "art-source"
            / "Characters"
            / spec["role"]
            / spec["style"]
            / VERSION_DIR
            / "Previews"
            / f"{spec['asset']}_preview.png"
        )
        img = Image.open(img_path).convert("RGB")
        img.thumbnail((760, 980), Image.Resampling.LANCZOS)
        x = col * 820 + (820 - img.width) // 2
        y = row * 1080 + 78
        sheet.paste(img, (x, y))
        draw.text((col * 820 + 42, row * 1080 + 28), spec["label"], fill=(242, 242, 236))
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
        for obj in list(bpy.context.scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        try:
            bpy.ops.outliner.orphans_purge(do_recursive=True)
        except Exception:
            pass
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
            if hasattr(bpy.context.scene.eevee, "use_gtao"):
                bpy.context.scene.eevee.use_gtao = True
                bpy.context.scene.eevee.gtao_distance = 3
                bpy.context.scene.eevee.gtao_factor = 1.2
        bpy.context.scene.view_settings.view_transform = "Filmic"
        bpy.context.scene.view_settings.look = "Medium High Contrast"

    def find_asset(filename: str, subdir: str) -> str:
        path = AssetService.find_asset_absolute_path(filename, asset_subdir=subdir)
        if path is None:
            raise RuntimeError(f"Missing MakeHuman asset {subdir}/{filename}")
        return path

    def texture_label(style: str) -> str:
        return "4K" if style == "Photoreal" else "2K"

    def texture_set_for(spec: dict, material: str) -> dict[str, Path]:
        label = texture_label(spec["style"])
        root = ROOT / "art-source" / "Characters" / spec["role"] / spec["style"] / "Textures"
        prefix = f"Char_{spec['role']}_{spec['style']}_{material}_"
        return {
            "base": root / f"{prefix}BaseColor_{label}.png",
            "normal": root / f"{prefix}Normal_{label}.png",
            "ao": root / f"{prefix}AO_{label}.png",
            "metallic_smoothness": root / f"{prefix}MetallicSmoothness_{label}.png",
        }

    def copy_texture_set(spec: dict, out_dir: Path) -> list[str]:
        copied = []
        source = ROOT / "art-source" / "Characters" / spec["role"] / spec["style"] / "Textures"
        target = out_dir / "Textures"
        target.mkdir(parents=True, exist_ok=True)
        for path in sorted(source.glob(f"Char_{spec['role']}_{spec['style']}_*.png")):
            dst = target / path.name
            shutil.copy2(path, dst)
            copied.append(rel(dst))
        return copied

    def link_image(mat, bsdf, path: Path, target: str, *, colorspace: str = "sRGB", strength: float = 0.32) -> bool:
        if not path.exists() or not bsdf:
            return False
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        tex = nodes.new("ShaderNodeTexImage")
        tex.name = f"{target}_{path.stem}"
        tex.image = bpy.data.images.load(str(path), check_existing=True)
        try:
            tex.image.colorspace_settings.name = colorspace
        except Exception:
            pass
        if target == "base" and "Base Color" in bsdf.inputs:
            links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            return True
        if target == "normal" and "Normal" in bsdf.inputs:
            normal = nodes.new("ShaderNodeNormalMap")
            normal.inputs["Strength"].default_value = strength
            links.new(tex.outputs["Color"], normal.inputs["Color"])
            links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
            return True
        return False

    def make_mat(
        name: str,
        color,
        roughness=0.58,
        metallic=0.0,
        *,
        texture_set: dict[str, Path] | None = None,
        link_base_texture: bool = True,
        noise_scale: float = 0.0,
        bump_strength: float = 0.0,
        bump_distance: float = 0.018,
        normal_strength: float = 0.32,
    ):
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
            if "Specular IOR Level" in bsdf.inputs:
                bsdf.inputs["Specular IOR Level"].default_value = 0.46
            elif "Specular" in bsdf.inputs:
                bsdf.inputs["Specular"].default_value = 0.36
            if texture_set:
                if link_base_texture:
                    link_image(mat, bsdf, texture_set["base"], "base", colorspace="sRGB")
                link_image(mat, bsdf, texture_set["normal"], "normal", colorspace="Non-Color", strength=normal_strength)
            if not texture_set and noise_scale > 0.0 and bump_strength > 0.0 and "Normal" in bsdf.inputs:
                nodes = mat.node_tree.nodes
                links = mat.node_tree.links
                noise = nodes.new("ShaderNodeTexNoise")
                noise.inputs["Scale"].default_value = noise_scale
                noise.inputs["Detail"].default_value = 10.0
                noise.inputs["Roughness"].default_value = 0.62
                bump = nodes.new("ShaderNodeBump")
                bump.inputs["Strength"].default_value = bump_strength
                bump.inputs["Distance"].default_value = bump_distance
                links.new(noise.outputs["Fac"], bump.inputs["Height"])
                links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        return mat

    def assign_materials(objects, spec: dict) -> None:
        c = spec["colors"]
        blind = spec["style"] == "BlindBox"
        preserve_source_texture = False
        main_textures = texture_set_for(spec, "Main") if spec["role"] == "Police" else None
        link_main_base = False if spec["role"] == "Police" else True
        skin_shadow = (
            max(0.0, c["skin"][0] * 0.68 + c["mouth"][0] * 0.04),
            max(0.0, c["skin"][1] * 0.68 + c["mouth"][1] * 0.04),
            max(0.0, c["skin"][2] * 0.68 + c["mouth"][2] * 0.04),
            1.0,
        )
        skin_warm = (
            min(1.0, c["skin"][0] * 0.86 + c["mouth"][0] * 0.14),
            min(1.0, c["skin"][1] * 0.86 + c["mouth"][1] * 0.14),
            min(1.0, c["skin"][2] * 0.86 + c["mouth"][2] * 0.14),
            1.0,
        )
        cheek_warm = (
            min(1.0, c["skin"][0] * 0.76 + c["mouth"][0] * 0.24),
            min(1.0, c["skin"][1] * 0.76 + c["mouth"][1] * 0.24),
            min(1.0, c["skin"][2] * 0.76 + c["mouth"][2] * 0.24),
            1.0,
        )
        mats = {
            "skin": make_mat(f"{spec['asset']}_Skin", c["skin"], 0.46 if not blind else 0.30, noise_scale=72, bump_strength=0.014 if not blind else 0.006, bump_distance=0.010),
            "hair": make_mat(f"{spec['asset']}_Hair", c["hair"], 0.38 if not blind else 0.24, noise_scale=95, bump_strength=0.030 if not blind else 0.014, bump_distance=0.014),
            "cloth": make_mat(f"{spec['asset']}_Cloth", c["cloth"], 0.80 if not blind else 0.42, texture_set=main_textures, link_base_texture=link_main_base, noise_scale=42, bump_strength=0.052 if not blind else 0.020, bump_distance=0.028, normal_strength=0.24 if spec["role"] == "Police" else 0.42 if not blind else 0.22),
            "pants": make_mat(f"{spec['asset']}_Pants", c["pants"], 0.82 if not blind else 0.44, texture_set=main_textures, link_base_texture=link_main_base, noise_scale=58, bump_strength=0.045 if not blind else 0.018, bump_distance=0.026, normal_strength=0.22 if spec["role"] == "Police" else 0.36 if not blind else 0.20),
            "shoe": make_mat(f"{spec['asset']}_ShoeRed", c["shoe"], 0.46 if not blind else 0.30, noise_scale=74, bump_strength=0.026 if not blind else 0.010, bump_distance=0.018),
            "white": make_mat(f"{spec['asset']}_EyeWhite", (0.78, 0.73, 0.64, 1.0) if spec["role"] == "Villain" else (0.86, 0.82, 0.74, 1.0), 0.42),
            "eye": make_mat(f"{spec['asset']}_EyeDark", c["eye"], 0.24),
            "cheek": make_mat(f"{spec['asset']}_CheekWarmth", cheek_warm, 0.50),
            "skin_shadow": make_mat(f"{spec['asset']}_SkinSoftShadow", skin_shadow, 0.58),
            "skin_lid": make_mat(f"{spec['asset']}_SkinLid", c["skin"], 0.50),
            "skin_warm": make_mat(f"{spec['asset']}_SkinWarmPlane", skin_warm, 0.54),
            "detail": make_mat(f"{spec['asset']}_GarmentDetail", (0.018, 0.024, 0.030, 1.0), 0.62, noise_scale=88, bump_strength=0.020, bump_distance=0.012),
            "mouth": make_mat(f"{spec['asset']}_Mouth", c["mouth"], 0.45 if not blind else 0.30),
            "highlight": make_mat(f"{spec['asset']}_EyeHighlight", (1.0, 0.96, 0.86, 1.0), 0.20),
            "metal": make_mat(f"{spec['asset']}_Metal", c["metal"], 0.28 if not blind else 0.20, 0.45),
            "accent": make_mat(f"{spec['asset']}_Accent", c["accent"], 0.42 if not blind else 0.28),
            "burgundy": make_mat(f"{spec['asset']}_BurgundyInnerLayer", (0.062, 0.014, 0.018, 1.0), 0.56, noise_scale=54, bump_strength=0.014, bump_distance=0.008),
            "police_trim": make_mat(f"{spec['asset']}_PoliceSoftGold", (0.55, 0.43, 0.23, 1.0), 0.34, 0.25),
            "black": make_mat(f"{spec['asset']}_BlackLeather", (0.006, 0.006, 0.007, 1.0), 0.34 if not blind else 0.24, noise_scale=66, bump_strength=0.022 if not blind else 0.010, bump_distance=0.012),
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
        bpy.ops.object.light_add(type="AREA", location=(-height * 1.10, -height * 2.10, height * 2.05))
        key = bpy.context.object
        key.name = "Key_Light_Softbox"
        key.data.energy = 820
        key.data.size = height * 2.25
        bpy.ops.object.light_add(type="AREA", location=(height * 1.25, -height * 1.30, height * 0.92))
        fill = bpy.context.object
        fill.name = "Face_Fill_Light"
        fill.data.energy = 155
        fill.data.size = height * 1.15
        bpy.ops.object.light_add(type="AREA", location=(height * 0.85, height * 0.40, height * 1.42))
        rim = bpy.context.object
        rim.name = "Shoulder_Rim_Light"
        rim.data.energy = 185
        rim.data.size = height * 0.90
        bpy.ops.object.camera_add(location=(height * 0.38, -height * 2.95, height * 0.64))
        cam = bpy.context.object
        look_at(cam, Vector((0, 0, height * 0.55)))
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = height * 1.10
        bpy.context.scene.camera = cam
        bpy.ops.mesh.primitive_plane_add(size=height * 1.8, location=(0, 0, -0.002))
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
            z_drop = 0.001 if style == "Photoreal" else 0.003 if style == "Stylized" else 0.005
            z = (face_bounds["min_z"] + face_bounds["max_z"]) * 0.5 - height * z_drop
            x_span = max(abs(face_bounds["min_x"]), abs(face_bounds["max_x"]))
            offset_mul = 0.38 if style == "Photoreal" else 0.41 if style == "Stylized" else 0.49
            x_offset = max(height * 0.024, x_span * offset_mul)
        else:
            y = bounds["min_y"] - height * 0.006
            z = bounds["min_z"] + height * 0.84
            x_offset = height * 0.032
        if style == "Photoreal":
            eye_x, eye_z, iris_scale, brow = 0.0048, 0.0028, 1.0, True
            x_offset *= 0.86
        elif style == "Stylized":
            eye_x, eye_z, iris_scale, brow = 0.0068, 0.0049, 1.0, True
        else:
            eye_x, eye_z, iris_scale, brow = 0.0112, 0.0092, 1.0, True
            x_offset *= 0.96
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

        def add_curve(name: str, points, radius, mat):
            curve = bpy.data.curves.new(name + "_Curve", "CURVE")
            curve.dimensions = "3D"
            curve.resolution_u = 8
            curve.bevel_depth = radius
            curve.bevel_resolution = 2
            spl = curve.splines.new("POLY")
            spl.points.add(len(points) - 1)
            for point, co in zip(spl.points, points):
                point.co = (co[0], co[1], co[2], 1)
            obj = bpy.data.objects.new(name, curve)
            bpy.context.collection.objects.link(obj)
            bpy.ops.object.select_all(action="DESELECT")
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.convert(target="MESH")
            obj = bpy.context.object
            obj.data.materials.append(mat)
            made.append(obj)
            return obj

        for side in (-1, 1):
            x = side * x_offset
            if style == "Photoreal":
                add_flat(
                    f"Eye_Sclera_Soft_{side}",
                    (x, y - height * 0.0040, z),
                    (height * eye_x * 1.30, height * 0.0008, height * eye_z * 0.82),
                    mats["white"],
                    24,
                    8,
                )
                add_flat(
                    f"Eye_Iris_Depth_{side}",
                    (x, y - height * 0.0055, z - height * eye_z * 0.03),
                    (height * eye_x * 0.72, height * 0.0012, height * eye_z * 0.78),
                    mats["eye"],
                    22,
                    8,
                )
                add_flat(
                    f"Eye_Catchlight_{side}",
                    (x - side * height * eye_x * 0.30, y - height * 0.0068, z + height * eye_z * 0.42),
                    (height * eye_x * 0.12, height * 0.0007, height * eye_z * 0.10),
                    mats["highlight"],
                    10,
                    5,
                )
                lid = add_flat(
                    f"Upper_Eyelid_Shadow_{side}",
                    (x, y - height * 0.0030, z + height * eye_z * 0.94),
                    (height * eye_x * 1.16, height * 0.0008, height * eye_z * 0.12),
                    mats["skin_lid"],
                    18,
                    5,
                )
                lid.rotation_euler[1] = -side * (0.12 if spec["role"] == "Villain" else 0.04)
            elif style == "BlindBox":
                add_flat(
                    f"Eye_Glossy_Button_{side}",
                    (x, y - height * 0.003, z),
                    (height * eye_x * 0.84, height * 0.0030, height * eye_z * 0.84),
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
                    (height * eye_x * 0.84, height * 0.0025, height * eye_z * 0.84),
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
                        (x - side * height * eye_x * 0.08, y - height * 0.0025, z + height * eye_z * 1.12),
                        (height * eye_x * 0.50, height * 0.0010, height * eye_z * 0.09),
                        mats["hair"],
                        18,
                        6,
                    )
                    brow_obj.rotation_euler[1] = -side * (0.18 if spec["role"] == "Villain" else 0.06)
        if brow:
            for side in (-1, 1):
                x = side * x_offset
                if style == "Photoreal":
                    brow_obj = add_flat(
                        f"Expression_Brow_{side}",
                        (x - side * height * eye_x * 0.10, y - height * 0.0022, z + height * eye_z * 1.76),
                        (height * eye_x * 0.70, height * 0.0008, height * eye_z * 0.08),
                        mats["hair"],
                        18,
                        5,
                    )
                    brow_obj.rotation_euler[1] = -side * (0.20 if spec["role"] == "Villain" else 0.04)
                elif style == "BlindBox":
                    brow_obj = add_flat(
                        f"Toy_Brow_{side}",
                        (x - side * height * eye_x * 0.06, y - height * 0.0024, z + height * eye_z * 1.08),
                        (height * eye_x * 0.40, height * 0.0009, height * eye_z * 0.07),
                        mats["hair"],
                        18,
                        5,
                    )
                    brow_obj.rotation_euler[1] = -side * (0.16 if spec["role"] == "Villain" else 0.02)
        if style in {"Photoreal", "Stylized"}:
            mouth_z = z - height * (0.073 if style == "Photoreal" else 0.074)
            mouth_w = height * (0.013 if style == "Photoreal" else 0.016)
            if spec["role"] == "Villain":
                mouth_points = [(-mouth_w, y - height * 0.0060, mouth_z - height * 0.0008), (0, y - height * 0.0065, mouth_z + height * 0.0010), (mouth_w, y - height * 0.0060, mouth_z - height * 0.0008)]
            else:
                mouth_points = [(-mouth_w, y - height * 0.0060, mouth_z + height * 0.0010), (0, y - height * 0.0065, mouth_z - height * 0.0012), (mouth_w, y - height * 0.0060, mouth_z + height * 0.0010)]
            add_curve(
                "Soft_Mouth_Line",
                mouth_points,
                height * (0.00065 if style == "Photoreal" else 0.0009),
                mats["mouth"],
            )
            add_flat(
                "Nose_Bridge_Form",
                (0, y - height * 0.0046, z - height * 0.030),
                (height * (0.0014 if style == "Photoreal" else 0.0020), height * 0.0007, height * (0.0068 if style == "Photoreal" else 0.0080)),
                mats["skin_lid"],
                12,
                5,
            )
            add_flat(
                "Nose_Tip_Warmth",
                (0, y - height * 0.0052, z - height * 0.044),
                (height * (0.0025 if style == "Photoreal" else 0.0032), height * 0.0008, height * (0.0018 if style == "Photoreal" else 0.0023)),
                mats["skin_warm"],
                14,
                5,
            )
        elif style == "BlindBox":
            mouth_z = z - height * 0.067
            mouth_w = height * 0.011
            if spec["role"] == "Villain":
                mouth_points = [(-mouth_w, y - height * 0.0058, mouth_z - height * 0.0005), (0, y - height * 0.0063, mouth_z + height * 0.0009), (mouth_w, y - height * 0.0058, mouth_z - height * 0.0005)]
            else:
                mouth_points = [(-mouth_w, y - height * 0.0058, mouth_z + height * 0.0006), (0, y - height * 0.0063, mouth_z - height * 0.0016), (mouth_w, y - height * 0.0058, mouth_z + height * 0.0006)]
            add_curve(
                "Toy_Soft_Mouth_Line",
                mouth_points,
                height * 0.0012,
                mats["mouth"],
            )
            add_flat(
                "Toy_Nose_Button",
                (0, y - height * 0.0048, z - height * 0.042),
                (height * 0.0026, height * 0.0007, height * 0.0018),
                mats["skin_warm"],
                10,
                4,
            )
        return made

    def add_photoreal_garment_detail(objects, spec: dict, mats: dict):
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

        def finish(obj, mat):
            obj.data.materials.clear()
            obj.data.materials.append(mat)
            for poly in obj.data.polygons:
                poly.use_smooth = True
            try:
                weighted = obj.modifiers.new("GarmentDetail_Weighted_Normals", "WEIGHTED_NORMAL")
                weighted.keep_sharp = True
            except Exception:
                pass
            made.append(obj)
            return obj

        def tube(name, points, radius, mat):
            curve = bpy.data.curves.new(name + "_Curve", "CURVE")
            curve.dimensions = "3D"
            curve.resolution_u = 4
            curve.bevel_depth = radius
            curve.bevel_resolution = 2
            spl = curve.splines.new("POLY")
            spl.points.add(len(points) - 1)
            for point, co in zip(spl.points, points):
                point.co = (co[0], co[1], co[2], 1)
            obj = bpy.data.objects.new(name, curve)
            bpy.context.collection.objects.link(obj)
            bpy.ops.object.select_all(action="DESELECT")
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.convert(target="MESH")
            return finish(bpy.context.object, mat)

        button_count = 8 if spec["style"] == "Photoreal" else 6 if spec["style"] == "Stylized" else 5
        button_radius = height * (0.0055 if spec["style"] != "BlindBox" else 0.0075)
        for i in range(button_count):
            z = full_bounds["min_z"] + height * (0.425 + i * (0.030 if spec["style"] == "Photoreal" else 0.034))
            bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(0.0, y, z))
            button = bpy.context.object
            button.name = f"Photoreal_Zipper_Button_{i:02d}"
            button.scale = (button_radius, height * 0.0016, button_radius)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            finish(button, mats["detail"])

        seam_mat = mats["accent"]
        z0 = full_bounds["min_z"]
        left_x = -height * (0.046 if spec["style"] != "BlindBox" else 0.058)
        right_x = height * (0.046 if spec["style"] != "BlindBox" else 0.058)
        radius = height * (0.0018 if spec["style"] == "Photoreal" else 0.0028 if spec["style"] == "Stylized" else 0.0038)
        if spec["role"] == "Police":
            tube("Garment_Left_Placket_Stitch", [(left_x, y - height * 0.004, z0 + height * 0.705), (left_x * 0.72, y - height * 0.006, z0 + height * 0.560), (left_x * 0.62, y - height * 0.006, z0 + height * 0.405)], radius, seam_mat)
            tube("Garment_Right_Placket_Stitch", [(right_x, y - height * 0.004, z0 + height * 0.705), (right_x * 0.72, y - height * 0.006, z0 + height * 0.560), (right_x * 0.62, y - height * 0.006, z0 + height * 0.405)], radius, seam_mat)
            tube("Police_Shirt_Center_Seam", [(0, y - height * 0.006, z0 + height * 0.710), (0, y - height * 0.007, z0 + height * 0.470)], radius * 0.85, mats["accent"])
        else:
            tube("Villain_Left_Lapel_Stitch", [(-height * 0.045, y - height * 0.006, z0 + height * 0.705), (-height * 0.020, y - height * 0.007, z0 + height * 0.620), (-height * 0.010, y - height * 0.007, z0 + height * 0.545)], radius * 0.75, seam_mat)
            tube("Villain_Right_Lapel_Stitch", [(height * 0.045, y - height * 0.006, z0 + height * 0.705), (height * 0.020, y - height * 0.007, z0 + height * 0.620), (height * 0.010, y - height * 0.007, z0 + height * 0.545)], radius * 0.75, seam_mat)
        return made

    def add_role_details(objects, spec: dict, mats: dict):
        bounds = evaluated_bounds(objects)
        height = bounds["max_z"] - bounds["min_z"]
        y_front = bounds["min_y"] - height * 0.010
        z0 = bounds["min_z"]
        made = []

        def finish(obj, mat):
            obj.data.materials.clear()
            obj.data.materials.append(mat)
            for poly in obj.data.polygons:
                poly.use_smooth = True
            try:
                weighted = obj.modifiers.new("RoleDetail_Weighted_Normals", "WEIGHTED_NORMAL")
                weighted.keep_sharp = True
            except Exception:
                pass
            made.append(obj)
            return obj

        def cube(name, loc, scale, mat, bevel=0.0):
            bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
            obj = bpy.context.object
            obj.name = name
            obj.scale = scale
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            if bevel:
                mod = obj.modifiers.new("SoftBevel", "BEVEL")
                mod.width = bevel
                mod.segments = 3
            return finish(obj, mat)

        def sphere(name, loc, scale, mat, segments=40, rings=16):
            bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
            obj = bpy.context.object
            obj.name = name
            obj.scale = scale
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            return finish(obj, mat)

        def cylinder(name, loc, radius, depth, mat, vertices=64, bevel=0.0, rotation=(0, 0, 0)):
            bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
            obj = bpy.context.object
            obj.name = name
            if bevel:
                mod = obj.modifiers.new("SoftBevel", "BEVEL")
                mod.width = bevel
                mod.segments = 3
            return finish(obj, mat)

        def dome(name, loc, rx, ry, rz, mat, segments=64, rings=9):
            verts = [(loc[0], loc[1], loc[2] + rz)]
            for i in range(1, rings + 1):
                phi = (i / rings) * (math.pi / 2)
                r = math.sin(phi)
                z = loc[2] + rz * math.cos(phi)
                for j in range(segments):
                    theta = (j / segments) * math.tau
                    verts.append((loc[0] + rx * r * math.cos(theta), loc[1] + ry * r * math.sin(theta), z))
            faces = []
            first = 1
            for j in range(segments):
                faces.append((0, first + (j + 1) % segments, first + j))
            for i in range(1, rings):
                start_a = 1 + (i - 1) * segments
                start_b = 1 + i * segments
                for j in range(segments):
                    faces.append((start_a + j, start_a + (j + 1) % segments, start_b + (j + 1) % segments, start_b + j))
            mesh = bpy.data.meshes.new(name + "_Mesh")
            mesh.from_pydata(verts, [], faces)
            mesh.update()
            obj = bpy.data.objects.new(name, mesh)
            bpy.context.collection.objects.link(obj)
            return finish(obj, mat)

        def tube(name, points, radius, mat):
            curve = bpy.data.curves.new(name + "_Curve", "CURVE")
            curve.dimensions = "3D"
            curve.resolution_u = 3
            curve.bevel_depth = radius
            curve.bevel_resolution = 3
            spl = curve.splines.new("POLY")
            spl.points.add(len(points) - 1)
            for point, co in zip(spl.points, points):
                point.co = (co[0], co[1], co[2], 1)
            obj = bpy.data.objects.new(name, curve)
            bpy.context.collection.objects.link(obj)
            bpy.ops.object.select_all(action="DESELECT")
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.convert(target="MESH")
            return finish(bpy.context.object, mat)

        style = spec["style"]
        blind = style == "BlindBox"
        if spec["role"] == "Police":
            cap_lower_z = z0 + height * (0.948 if not blind else 0.935)
            cap_panel_z = z0 + height * (0.966 if not blind else 0.952)
            cap_crown_z = z0 + height * (0.978 if not blind else 0.966)
            crown_rx = height * (0.071 if not blind else 0.084)
            crown_ry = height * (0.049 if not blind else 0.061)
            dome("Police_ServiceCap_TopCrown", (0, y_front + height * 0.006, cap_crown_z), crown_rx, crown_ry, height * (0.037 if not blind else 0.045), mats["cloth"], 88, 11)
            sphere("Police_ServiceCap_FrontCrownPanel", (0, y_front - height * 0.004, cap_panel_z), (height * (0.066 if not blind else 0.080), height * 0.0062, height * (0.016 if not blind else 0.020)), mats["cloth"], 72, 12)
            cube("Police_ServiceCap_LowerHeadband", (0, y_front - height * 0.007, cap_lower_z), (height * (0.065 if not blind else 0.078), height * 0.0026, height * (0.0040 if not blind else 0.0052)), mats["accent"], height * 0.0008)
            for side in (-1, 1):
                sphere(f"Police_ServiceCap_SideWrap_{side}", (side * height * (0.058 if not blind else 0.070), y_front + height * 0.002, cap_panel_z - height * 0.003), (height * (0.012 if not blind else 0.015), height * 0.014, height * (0.017 if not blind else 0.022)), mats["cloth"], 32, 10)
            sphere("Police_ServiceCap_SculptedBrim", (0, y_front - height * 0.024, cap_lower_z - height * 0.004), (height * (0.046 if not blind else 0.056), height * (0.013 if not blind else 0.016), height * 0.0018), mats["black"], 72, 8)
            cube("Police_ServiceCap_BrimUnderShadow", (0, y_front - height * 0.017, cap_lower_z - height * 0.0045), (height * (0.043 if not blind else 0.052), height * 0.0014, height * 0.0014), mats["black"], height * 0.00035)
            cylinder("Police_Cap_Badge_Disc", (0, y_front - height * 0.010, cap_panel_z - height * 0.003), height * (0.0042 if not blind else 0.0052), height * 0.0012, mats["police_trim"], 32, height * 0.0002, rotation=(math.pi / 2, 0, 0))
            belt_z = z0 + height * 0.455
            cube("Police_DutyBelt", (0, y_front - height * 0.003, belt_z), (height * 0.116, height * 0.0060, height * 0.008), mats["black"], height * 0.0015)
            cube("Police_BeltBuckle", (0, y_front - height * 0.009, belt_z), (height * 0.013, height * 0.0030, height * 0.010), mats["police_trim"], height * 0.0010)
            cube("Police_JacketHem_ClearBreak", (0, y_front - height * 0.010, z0 + height * 0.442), (height * 0.092, height * 0.0024, height * 0.0034), mats["accent"], height * 0.0006)
            cube("Police_NeckOpening_Shadow", (0, y_front - height * 0.012, z0 + height * 0.713), (height * 0.027, height * 0.0018, height * 0.017), mats["accent"], height * 0.0005)
            cube("Police_ShirtPanel_ClearPlane", (0, y_front - height * 0.013, z0 + height * 0.610), (height * 0.024, height * 0.0015, height * 0.095), mats["accent"], height * 0.0005)
            cube("Police_WaistSeam_ClearBreak", (0, y_front - height * 0.012, z0 + height * 0.506), (height * 0.084, height * 0.0018, height * 0.0035), mats["police_trim"], height * 0.0005)
            for side in (-1, 1):
                cube(f"Police_BeltPouch_{side}", (side * height * 0.052, y_front - height * 0.009, belt_z - height * 0.004), (height * 0.010, height * 0.006, height * 0.016), mats["black"], height * 0.0014)
                cube(f"Police_HipPouch_{side}", (side * height * 0.088, y_front + height * 0.000, belt_z - height * 0.002), (height * 0.009, height * 0.007, height * 0.019), mats["black"], height * 0.0014)
                cube(f"Police_SleevePatch_{side}", (side * height * 0.100, y_front - height * 0.002, z0 + height * 0.665), (height * 0.013, height * 0.0030, height * 0.018), mats["accent"], height * 0.0008)
                cube(f"Police_ShoulderEpaulet_{side}", (side * height * 0.062, y_front + height * 0.002, z0 + height * 0.737), (height * 0.030, height * 0.0040, height * 0.0060), mats["accent"], height * 0.0010)
                cube(f"Police_ChestPocketBody_{side}", (side * height * 0.041, y_front - height * 0.009, z0 + height * 0.590), (height * 0.022, height * 0.0020, height * 0.020), mats["cloth"], height * 0.0006)
                cube(f"Police_ChestPocketFlap_{side}", (side * height * 0.041, y_front - height * 0.011, z0 + height * 0.612), (height * 0.023, height * 0.0026, height * 0.0050), mats["accent"], height * 0.0007)
                cube(f"Police_Cuff_Break_{side}", (side * height * 0.162, y_front + height * 0.006, z0 + height * 0.438), (height * 0.020, height * 0.004, height * 0.0065), mats["accent"], height * 0.0008)
                tube(f"Police_Trouser_Crease_{side}", [(side * height * 0.043, y_front - height * 0.004, z0 + height * 0.410), (side * height * 0.050, y_front - height * 0.006, z0 + height * 0.160)], height * 0.00125, mats["accent"])
            cylinder("Police_ChestBadge", (-height * 0.041, y_front - height * 0.011, z0 + height * 0.660), height * 0.0072, height * 0.0018, mats["police_trim"], 28, height * 0.0005, rotation=(math.pi / 2, 0, 0))
            cube("Police_Nameplate", (height * 0.040, y_front - height * 0.010, z0 + height * 0.661), (height * 0.015, height * 0.0022, height * 0.0036), mats["police_trim"], height * 0.0006)
            cube("Police_Radio", (height * 0.077, y_front - height * 0.001, z0 + height * 0.690), (height * 0.010, height * 0.0065, height * 0.020), mats["black"], height * 0.0012)
            tube("Police_RadioCord", [(height * 0.076, y_front - height * 0.010, z0 + height * 0.680), (height * 0.052, y_front - height * 0.011, z0 + height * 0.620), (height * 0.034, y_front - height * 0.011, z0 + height * 0.555)], height * 0.0011, mats["black"])
        else:
            hat_lower_z = z0 + height * (0.945 if not blind else 0.932)
            hat_panel_z = z0 + height * (0.962 if not blind else 0.949)
            hat_crown_z = z0 + height * (0.976 if not blind else 0.963)
            dome("Villain_Beanie_RoundedCrown", (0, y_front + height * 0.007, hat_crown_z), height * (0.069 if not blind else 0.082), height * (0.049 if not blind else 0.060), height * (0.039 if not blind else 0.047), mats["detail"], 88, 11)
            sphere("Villain_Beanie_FrontKnitWrap", (0, y_front - height * 0.004, hat_panel_z), (height * (0.064 if not blind else 0.077), height * 0.0058, height * (0.016 if not blind else 0.020)), mats["detail"], 72, 12)
            sphere("Villain_Beanie_RolledCuff", (0, y_front - height * 0.009, hat_lower_z), (height * (0.061 if not blind else 0.074), height * 0.0048, height * (0.0058 if not blind else 0.0074)), mats["black"], 72, 8)
            for side in (-1, 1):
                sphere(f"Villain_Beanie_SideWrap_{side}", (side * height * (0.056 if not blind else 0.068), y_front + height * 0.000, hat_panel_z - height * 0.004), (height * (0.012 if not blind else 0.015), height * 0.013, height * (0.017 if not blind else 0.022)), mats["detail"], 32, 10)
            for i, x in enumerate([-0.040, -0.026, -0.012, 0.012, 0.026, 0.040]):
                tube(f"Villain_Beanie_SoftRib_{i}", [(height * x, y_front - height * 0.011, hat_lower_z + height * 0.001), (height * x * 0.78, y_front - height * 0.003, hat_crown_z + height * 0.020)], height * 0.00060, mats["accent"])
            tube("Villain_CollarFold", [(-height * 0.074, y_front - height * 0.015, z0 + height * 0.735), (-height * 0.035, y_front - height * 0.024, z0 + height * 0.716), (0, y_front - height * 0.028, z0 + height * 0.710), (height * 0.035, y_front - height * 0.024, z0 + height * 0.716), (height * 0.074, y_front - height * 0.015, z0 + height * 0.735)], height * (0.0034 if not blind else 0.0052), mats["detail"])
            tube("Villain_Burgundy_InnerCollar", [(-height * 0.035, y_front - height * 0.028, z0 + height * 0.688), (-height * 0.014, y_front - height * 0.032, z0 + height * 0.640), (0, y_front - height * 0.033, z0 + height * 0.598), (height * 0.014, y_front - height * 0.032, z0 + height * 0.640), (height * 0.035, y_front - height * 0.028, z0 + height * 0.688)], height * (0.0017 if not blind else 0.0030), mats["burgundy"])
            tube("Villain_LeftShortLapel", [(-height * 0.060, y_front - height * 0.015, z0 + height * 0.705), (-height * 0.034, y_front - height * 0.020, z0 + height * 0.635), (-height * 0.016, y_front - height * 0.020, z0 + height * 0.565)], height * (0.0030 if not blind else 0.0045), mats["accent"])
            tube("Villain_RightShortLapel", [(height * 0.060, y_front - height * 0.015, z0 + height * 0.705), (height * 0.034, y_front - height * 0.020, z0 + height * 0.635), (height * 0.016, y_front - height * 0.020, z0 + height * 0.565)], height * (0.0030 if not blind else 0.0045), mats["accent"])
            cube("Villain_Burgundy_InnerPanel", (0, y_front - height * 0.023, z0 + height * 0.585), (height * 0.024, height * 0.0018, height * 0.072), mats["burgundy"], height * 0.0006)
            cube("Villain_CoatLeftFrontPlane", (-height * 0.043, y_front - height * 0.018, z0 + height * 0.585), (height * 0.022, height * 0.0014, height * 0.076), mats["detail"], height * 0.0005)
            cube("Villain_CoatRightFrontPlane", (height * 0.043, y_front - height * 0.018, z0 + height * 0.585), (height * 0.022, height * 0.0014, height * 0.076), mats["detail"], height * 0.0005)
            cube("Villain_JacketHem_ClearBreak", (0, y_front - height * 0.014, z0 + height * 0.438), (height * 0.105, height * 0.0025, height * 0.004), mats["accent"], height * 0.0007)
            cube("Villain_Belt", (0, y_front - height * 0.012, z0 + height * 0.455), (height * 0.120, height * 0.0075, height * 0.012), mats["black"], height * 0.0018)
            cube("Villain_Buckle", (0, y_front - height * 0.018, z0 + height * 0.455), (height * 0.020, height * 0.0045, height * 0.017), mats["metal"], height * 0.0013)
            for side in (-1, 1):
                cube(f"Villain_Cuff_Break_{side}", (side * height * 0.160, y_front + height * 0.005, z0 + height * 0.438), (height * 0.020, height * 0.004, height * 0.0065), mats["accent"], height * 0.0008)
                cube(f"Villain_CoatPocketFlap_{side}", (side * height * 0.045, y_front - height * 0.017, z0 + height * 0.563), (height * 0.028, height * 0.0024, height * 0.005), mats["accent"], height * 0.0007)
                tube(f"Villain_Trouser_Crease_{side}", [(side * height * 0.044, y_front - height * 0.006, z0 + height * 0.410), (side * height * 0.050, y_front - height * 0.008, z0 + height * 0.160)], height * 0.00125, mats["accent"])
            for i, z in enumerate([0.650, 0.600, 0.550, 0.500]):
                sphere(f"Villain_CoatButton_{i}", (-height * 0.022, y_front - height * 0.018, z0 + height * z), (height * 0.0048, height * 0.0016, height * 0.0048), mats["metal"], 16, 8)
                sphere(f"Villain_CoatButton_R_{i}", (height * 0.022, y_front - height * 0.018, z0 + height * z), (height * 0.0048, height * 0.0016, height * 0.0048), mats["metal"], 16, 8)
        return made

    def remove_realistic_face_proxies(objects, style: str) -> None:
        for obj in objects:
            if obj.type != "MESH":
                continue
            lname = obj.name.lower()
            if style == "Photoreal":
                hide = "eyelash" in lname
            elif style == "Stylized":
                hide = "eyelash" in lname
            else:
                hide = any(key in lname for key in ("eyebrow", "eyelash"))
            if hide:
                obj.hide_set(True)
                obj.hide_render = True
                obj["exclude_from_export"] = True

    def hide_hat_interfering_hair(objects, spec: dict) -> bool:
        if spec["role"] not in {"Police", "Villain"}:
            return False
        changed = False
        for obj in objects:
            if obj.type != "MESH":
                continue
            lname = obj.name.lower()
            if any(key in lname for key in ("short01", "short02", "hair")) and not any(key in lname for key in ("eyebrow", "eyelash")):
                obj.hide_set(True)
                obj.hide_render = True
                obj["exclude_from_export"] = True
                changed = True
        return changed

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

    def apply_preview_pose(objects, spec: dict) -> bool:
        armatures = [obj for obj in objects if obj.type == "ARMATURE" and not obj.get("exclude_from_export")]
        if not armatures:
            return False
        arm = armatures[0]
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = arm
        arm.select_set(True)
        try:
            bpy.ops.object.mode_set(mode="POSE")
        except Exception:
            return False

        def set_euler(name: str, xyz) -> None:
            pb = arm.pose.bones.get(name)
            if pb is None:
                return
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = tuple(math.radians(v) for v in xyz)

        # Render-only relaxed stance. The export stays in rest pose; this only
        # improves the review preview without changing the game-ready files.
        role_bias = -2.2 if spec["role"] == "Villain" else 1.6
        set_euler("pelvis", (0, role_bias * 0.16, 0))
        set_euler("spine_01", (0, role_bias * 0.18, 0))
        set_euler("spine_02", (0, role_bias * 0.36, 0))
        set_euler("spine_03", (1.1, role_bias * 0.30, 0))
        set_euler("clavicle_l", (0, 0, -3.4))
        set_euler("clavicle_r", (0, 0, 3.1))
        set_euler("upperarm_l", (0.8, 0, -17))
        set_euler("upperarm_r", (-0.8, 0, 15))
        set_euler("lowerarm_l", (0, 1.7, -8.5))
        set_euler("lowerarm_r", (0, -1.5, 7.5))
        set_euler("hand_l", (1.4, 0, -5.2))
        set_euler("hand_r", (-1.4, 0, 4.8))
        set_euler("neck_01", (0.8, -role_bias * 0.24, 0))
        set_euler("head", (0, -role_bias * 0.14, 0))
        set_euler("thigh_l", (0, 0, 0.6))
        set_euler("thigh_r", (0, 0, -0.5))
        set_euler("calf_l", (0, 0, -0.35))
        set_euler("calf_r", (0, 0, 0.32))
        bpy.context.view_layer.update()
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass
        return True

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
            scale_head_region(objects, spec["height"], 1.30)
        mats = assign_materials(objects, spec)
        hat_hair_conflict_removed = hide_hat_interfering_hair(objects, spec)
        eye_overlays = add_eye_overlays(objects, spec, mats)
        objects.extend(eye_overlays)
        garment_details = add_photoreal_garment_detail(objects, spec, mats)
        objects.extend(garment_details)
        role_details = add_role_details(objects, spec, mats)
        objects.extend(role_details)
        remove_realistic_face_proxies(objects, spec["style"])
        polish_surface(objects, spec["style"])
        decimate_for_style_budget(objects, spec["style"])
        setup_camera(spec["height"])

        out_dir = ROOT / "art-source" / "Characters" / spec["role"] / spec["style"] / VERSION_DIR
        preview_dir = out_dir / "Previews"
        report_dir = out_dir / "Reports"
        out_dir.mkdir(parents=True, exist_ok=True)
        preview_dir.mkdir(parents=True, exist_ok=True)
        report_dir.mkdir(parents=True, exist_ok=True)
        texture_files = copy_texture_set(spec, out_dir)
        blend = out_dir / f"{spec['asset']}.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(blend))
        fbx, glb = export(out_dir, spec["asset"], objects)
        lods = export_photoreal_lods(out_dir, spec["asset"], objects) if spec["style"] == "Photoreal" else {}
        preview_pose_applied = apply_preview_pose(objects, spec)
        preview = preview_dir / f"{spec['asset']}_preview.png"
        wire = preview_dir / f"{spec['asset']}_wireframe.png"
        render(preview)
        st = stats(objects)
        draw_wire([obj for obj in objects if not obj.get("exclude_from_export")], wire)
        report = {
            "asset": spec["asset"],
            "role": spec["role"],
            "style": spec["style"],
            "status": "mpfb_human_based_local_gate_candidate_user_visual_review_pending",
            "source": {
                "body": "MPFB/MakeHuman basemesh",
                "hair": spec["hair"],
                "clothes": spec["clothes"],
                "shoes": spec["shoe"],
                "pbr_texture_source": f"art-source/Characters/{spec['role']}/{spec['style']}/Textures generated from character PBR pipeline",
                "primitive_composed_human": False,
                "role_detail_meshes": len(role_details),
                "preview_pose_applied_after_export": preview_pose_applied,
                "hat_hair_conflict_removed": hat_hair_conflict_removed,
            },
            "outputs": {"blend": rel(blend), "fbx": rel(fbx), "glb": rel(glb), "preview": rel(preview), "wireframe": rel(wire)},
            "textures": texture_files,
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
        summary_entry = {"asset": spec["asset"], "role": spec["role"], "style": spec["style"], "triangles": st["triangles"], "preview": rel(preview), "report": rel(report_path)}
        if lods:
            summary_entry["lods"] = lods
        summary_assets.append(summary_entry)

    summary = {
        "asset_count": 6,
        "scope": "Villain and Police C/D MPFB human-based visual rework v29",
        "assets": summary_assets,
        "contact_sheet": rel(CONTACT_SHEET),
        "unity_validation": "blocked_no_active_unity_license",
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if "--build" in sys.argv:
        blender_main()
    else:
        run_blender()
