#!/usr/bin/env python3
"""Build three Kid style variants from the strongest local Hunyuan3D shape.

The Hunyuan texture projection test produced broken texture islands, but the
shape mesh is much stronger than the MPFB fallback. This script keeps the good
geometry, applies art-directed materials, exports reviewable FBX/GLB files, and
generates previews/reports for the three requested styles.
"""

from __future__ import annotations

import ast
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CHAR_DIR = ROOT / "art-source" / "Characters"
SHARED_RIG = ROOT / "tools" / "art_pipeline" / "generate_shared_humanoid_rig.py"
SOURCE_MESH = (
    ROOT
    / "docs"
    / "art_production"
    / "hunyuan_smoke_high"
    / "567357c57da461aa0ac56cb5f65c1040db810c49097a17f005a18ca302703ad7"
    / "white_mesh.glb"
)
VERSION_DIR = "HunyuanHumanRework_2026_07_12_v10"
CONTACT_SHEET = ROOT / "docs" / "art_production" / "KID_HUNYUAN_THREE_STYLE_CONTACT_SHEET_V10.png"
SUMMARY_PATH = ROOT / "docs" / "art_production" / "KID_HUNYUAN_THREE_STYLE_REWORK_SUMMARY_V10.json"


def load_bones():
    tree = ast.parse(SHARED_RIG.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "BONES":
                    return ast.literal_eval(node.value)
    raise RuntimeError(f"BONES not found in {SHARED_RIG}")


BONES = load_bones()

SPECS = [
    {
        "style": "Photoreal",
        "label": "Photoreal",
        "asset": "Kid_Photoreal_HunyuanHuman_v10",
        "height": 1.30,
        "target_tris": 57500,
        "budget": (40000, 70000),
        "eye_style": "small",
        "colors": {
            "skin": (0.86, 0.58, 0.43, 1.0),
            "hair": (0.032, 0.026, 0.022, 1.0),
            "hoodie": (0.018, 0.040, 0.090, 1.0),
            "shorts": (0.018, 0.017, 0.016, 1.0),
            "socks": (0.88, 0.86, 0.78, 1.0),
            "shoes": (0.58, 0.075, 0.045, 1.0),
            "straps": (0.012, 0.012, 0.013, 1.0),
            "eyes": (0.012, 0.014, 0.016, 1.0),
            "cheek": (0.82, 0.30, 0.24, 1.0),
            "eye_white": (0.88, 0.85, 0.76, 1.0),
            "mouth": (0.30, 0.095, 0.085, 1.0),
            "trim": (0.84, 0.82, 0.73, 1.0),
            "lace": (0.92, 0.88, 0.76, 1.0),
        },
    },
    {
        "style": "Stylized",
        "label": "Cartoon",
        "asset": "Kid_Cartoon_HunyuanHuman_v10",
        "height": 1.28,
        "target_tris": 24200,
        "budget": (18000, 30000),
        "eye_style": "cartoon",
        "colors": {
            "skin": (0.91, 0.66, 0.50, 1.0),
            "hair": (0.055, 0.040, 0.030, 1.0),
            "hoodie": (0.030, 0.225, 0.355, 1.0),
            "shorts": (0.020, 0.070, 0.115, 1.0),
            "socks": (0.94, 0.91, 0.82, 1.0),
            "shoes": (0.82, 0.105, 0.055, 1.0),
            "straps": (0.014, 0.020, 0.028, 1.0),
            "eyes": (0.010, 0.012, 0.015, 1.0),
            "cheek": (0.94, 0.34, 0.28, 1.0),
            "eye_white": (0.95, 0.92, 0.84, 1.0),
            "mouth": (0.35, 0.095, 0.085, 1.0),
            "trim": (0.90, 0.87, 0.72, 1.0),
            "lace": (0.96, 0.92, 0.78, 1.0),
        },
    },
    {
        "style": "BlindBox",
        "label": "BlindBox",
        "asset": "Kid_BlindBox_HunyuanHuman_v10",
        "height": 1.18,
        "target_tris": 14800,
        "budget": (12000, 20000),
        "eye_style": "button",
        "colors": {
            "skin": (0.96, 0.75, 0.60, 1.0),
            "hair": (0.070, 0.050, 0.040, 1.0),
            "hoodie": (0.050, 0.400, 0.620, 1.0),
            "shorts": (0.035, 0.170, 0.270, 1.0),
            "socks": (0.96, 0.92, 0.82, 1.0),
            "shoes": (0.90, 0.130, 0.065, 1.0),
            "straps": (0.025, 0.030, 0.040, 1.0),
            "eyes": (0.006, 0.008, 0.012, 1.0),
            "cheek": (0.96, 0.37, 0.31, 1.0),
            "eye_white": (1.0, 0.96, 0.86, 1.0),
            "mouth": (0.46, 0.15, 0.13, 1.0),
            "trim": (0.94, 0.90, 0.70, 1.0),
            "lace": (1.0, 0.92, 0.76, 1.0),
        },
    },
]


def run_blender() -> None:
    subprocess.run(
        ["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build"],
        cwd=str(ROOT),
        check=True,
    )
    build_contact_sheet()


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw

    sheet = Image.new("RGB", (2460, 1080), (32, 32, 32))
    draw = ImageDraw.Draw(sheet)
    for i, spec in enumerate(SPECS):
        img_path = (
            ROOT
            / "art-source"
            / "Characters"
            / "Kid"
            / spec["style"]
            / VERSION_DIR
            / "Previews"
            / f"{spec['asset']}_preview.png"
        )
        img = Image.open(img_path).convert("RGB")
        img.thumbnail((760, 980), Image.Resampling.LANCZOS)
        x = i * 820 + (820 - img.width) // 2
        y = 78
        sheet.paste(img, (x, y))
        draw.text((i * 820 + 42, 28), spec["label"], fill=(242, 242, 236))
    CONTACT_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(CONTACT_SHEET, optimize=True)


def blender_main() -> None:
    import bpy
    from mathutils import Vector

    if not SOURCE_MESH.exists():
        raise FileNotFoundError(SOURCE_MESH)

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

    def make_mat(name: str, color, roughness: float):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.diffuse_color = color
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = 0.0
        return mat

    def copy_texture_set(spec: dict, out_dir: Path) -> Path:
        source = CHAR_DIR / "Kid" / spec["style"] / "Textures"
        target = out_dir / "Textures"
        target.mkdir(parents=True, exist_ok=True)
        for path in source.glob("*.png"):
            shutil.copy2(path, target / path.name)
        return target

    def collect_and_join(asset: str):
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError("No mesh imported")
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = asset
        return obj

    def normalize_height(obj, target_height: float) -> None:
        zs = [(obj.matrix_world @ v.co).z for v in obj.data.vertices]
        min_z, max_z = min(zs), max(zs)
        scale = target_height / max(max_z - min_z, 1e-5)
        obj.scale = (scale, scale, scale)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        min_z = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
        obj.location.z -= min_z
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    def triangle_count(objects) -> int:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        count = 0
        for obj in objects:
            if obj.type != "MESH":
                continue
            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            mesh.calc_loop_triangles()
            count += len(mesh.loop_triangles)
            eval_obj.to_mesh_clear()
        return count

    def create_armature(height: float):
        scale = height / 1.82
        bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
        arm = bpy.context.object
        arm.name = "Rig_Humanoid_Shared"
        arm.data.name = "Rig_Humanoid_Shared_Armature"
        arm.data.display_type = "STICK"
        first = arm.data.edit_bones[0]
        first.name = BONES[0][0]
        first.head = Vector(BONES[0][2]) * scale
        first.tail = Vector(BONES[0][3]) * scale
        by_name = {first.name: first}
        for name, parent, head, tail in BONES[1:]:
            bone = arm.data.edit_bones.new(name)
            bone.head = Vector(head) * scale
            bone.tail = Vector(tail) * scale
            if parent:
                bone.parent = by_name[parent]
                bone.use_connect = False
            by_name[name] = bone
        bpy.ops.object.mode_set(mode="POSE")
        for pb in arm.pose.bones:
            pb.rotation_mode = "XYZ"
        bpy.ops.object.mode_set(mode="OBJECT")
        arm.hide_render = True
        return arm

    def bone_for_vertex(co: Vector, height: float) -> str:
        z = co.z / max(height, 1e-5)
        side = "Left" if co.x < 0 else "Right"
        if z > 0.83:
            return "Head"
        if abs(co.x) > 0.23 * height and 0.25 < z < 0.82:
            if z < 0.43:
                return f"{side}Hand"
            if z < 0.58:
                return f"{side}LowerArm"
            return f"{side}UpperArm"
        if z < 0.10:
            return f"{side}Foot"
        if z < 0.36:
            return f"{side}LowerLeg"
        if z < 0.54:
            return f"{side}UpperLeg"
        if z < 0.70:
            return "Spine"
        if z < 0.80:
            return "Chest"
        return "Neck"

    def bind_to_armature(obj, arm, height: float) -> None:
        if obj.type != "MESH":
            return
        for name, _, _, _ in BONES:
            obj.vertex_groups.new(name=name)
        for vertex in obj.data.vertices:
            bone = bone_for_vertex(vertex.co, height)
            obj.vertex_groups[bone].add([vertex.index], 1.0, "REPLACE")
        mod = obj.modifiers.new("Rig_Humanoid_Shared", "ARMATURE")
        mod.object = arm
        obj.parent = arm

    def apply_modifiers(obj) -> None:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in list(obj.modifiers):
            if mod.type == "ARMATURE":
                continue
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception:
                pass
        obj.select_set(False)

    def finish_detail(obj, mat, bevel=None, decimate=None) -> None:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.material_index = 0
            poly.use_smooth = True
        if decimate and decimate < 0.999:
            mod = obj.modifiers.new("Detail_Decimate", "DECIMATE")
            mod.ratio = decimate
        if bevel:
            mod = obj.modifiers.new("Soft_Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 3
        try:
            mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
            mod.keep_sharp = True
        except Exception:
            pass
        apply_modifiers(obj)

    def add_uv_sphere(name: str, loc, scale, mat, segments=32, rings=14, decimate=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        finish_detail(obj, mat, decimate=decimate)
        return obj

    def add_beveled_cube(name: str, loc, scale, mat, bevel):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        finish_detail(obj, mat, bevel=bevel)
        return obj

    def add_tube(name: str, points, radius, mat, resolution=3):
        curve = bpy.data.curves.new(name + "_Curve", "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = resolution
        curve.bevel_depth = radius
        curve.bevel_resolution = 3
        spl = curve.splines.new("POLY")
        spl.points.add(len(points) - 1)
        for p, co in zip(spl.points, points):
            p.co = (co[0], co[1], co[2], 1)
        obj = bpy.data.objects.new(name, curve)
        bpy.context.collection.objects.link(obj)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.convert(target="MESH")
        obj = bpy.context.object
        finish_detail(obj, mat)
        return obj

    def decimate_to_budget(obj, target_tris: int) -> int:
        current = triangle_count([obj])
        if current <= target_tris:
            return current
        mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
        mod.ratio = max(0.05, min(0.96, target_tris / current))
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=mod.name)
        return triangle_count([obj])

    def assign_regions(obj, spec: dict) -> None:
        c = spec["colors"]
        toy = spec["style"] == "BlindBox"
        mats = {
            "skin": make_mat(f"{spec['asset']}_Skin", c["skin"], 0.42 if toy else 0.56),
            "hair": make_mat(f"{spec['asset']}_Hair", c["hair"], 0.30 if toy else 0.45),
            "hoodie": make_mat(f"{spec['asset']}_Hoodie", c["hoodie"], 0.36 if toy else 0.72),
            "shorts": make_mat(f"{spec['asset']}_Shorts", c["shorts"], 0.34 if toy else 0.68),
            "socks": make_mat(f"{spec['asset']}_Socks", c["socks"], 0.40 if toy else 0.62),
            "shoes": make_mat(f"{spec['asset']}_Shoes", c["shoes"], 0.30 if toy else 0.50),
            "straps": make_mat(f"{spec['asset']}_Straps", c["straps"], 0.38 if toy else 0.66),
        }
        order = ["skin", "hair", "hoodie", "shorts", "socks", "shoes", "straps"]
        obj.data.materials.clear()
        for key in order:
            obj.data.materials.append(mats[key])

        coords = [v.co.copy() for v in obj.data.vertices]
        min_z, max_z = min(c.z for c in coords), max(c.z for c in coords)
        min_x, max_x = min(c.x for c in coords), max(c.x for c in coords)
        min_y, max_y = min(c.y for c in coords), max(c.y for c in coords)
        height = max(max_z - min_z, 1e-5)
        width = max(max_x - min_x, 1e-5)
        depth = max(max_y - min_y, 1e-5)

        material_index = {key: i for i, key in enumerate(order)}
        for poly in obj.data.polygons:
            center = sum((obj.data.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
            z = (center.z - min_z) / height
            x = abs((center.x - (min_x + max_x) * 0.5) / width)
            y = (center.y - min_y) / depth

            key = "skin"
            if z < 0.095:
                key = "shoes"
            elif z < 0.22:
                key = "socks"
            elif 0.22 <= z < 0.43 and x < 0.25:
                key = "shorts"
            elif z > 0.875 or (z > 0.862 and y < 0.30 and x < 0.31) or (z > 0.80 and y > 0.47):
                key = "hair"
            elif 0.42 <= z < 0.77:
                if x > 0.32 and z < 0.52:
                    key = "skin"
                elif 0.14 < x < 0.31 and y < 0.40:
                    key = "straps"
                else:
                    key = "hoodie"
            elif 0.72 <= z < 0.86:
                key = "skin"
            elif 0.22 <= z < 0.42 and x > 0.31:
                key = "skin"

            poly.material_index = material_index[key]
            poly.use_smooth = True

        weighted = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
        weighted.keep_sharp = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=weighted.name)

    def bounds(obj):
        coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
        return {
            "min_x": min(c.x for c in coords),
            "max_x": max(c.x for c in coords),
            "min_y": min(c.y for c in coords),
            "max_y": max(c.y for c in coords),
            "min_z": min(c.z for c in coords),
            "max_z": max(c.z for c in coords),
        }

    def add_eye_overlays(obj, spec: dict):
        b = bounds(obj)
        height = b["max_z"] - b["min_z"]
        y = b["min_y"] - height * 0.005
        z = b["min_z"] + height * (0.835 if spec["style"] != "BlindBox" else 0.825)
        eye_mat = make_mat(f"{spec['asset']}_EyeDark", spec["colors"]["eyes"], 0.20)
        cheek_mat = make_mat(f"{spec['asset']}_Cheek", spec["colors"]["cheek"], 0.42)
        highlight_mat = make_mat(f"{spec['asset']}_EyeHighlight", (1.0, 0.96, 0.86, 1.0), 0.18)
        made = []

        if spec["eye_style"] == "small":
            eye_x, eye_z, x_offset = 0.005, 0.0034, 0.026
        elif spec["eye_style"] == "cartoon":
            eye_x, eye_z, x_offset = 0.010, 0.0082, 0.032
        else:
            eye_x, eye_z, x_offset = 0.017, 0.0140, 0.040

        def add_flat(name: str, loc, scale, mat, segments=24, rings=10):
            bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
            eye = bpy.context.object
            eye.name = name
            eye.scale = scale
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            eye.data.materials.append(mat)
            made.append(eye)
            return eye

        for side in (-1, 1):
            x = side * height * x_offset
            add_flat(
                f"{spec['asset']}_Eye_{side}",
                (x, y, z),
                (height * eye_x, height * 0.0020, height * eye_z),
                eye_mat,
                32 if spec["eye_style"] == "button" else 24,
                12,
            )
            if spec["style"] != "Photoreal":
                add_flat(
                    f"{spec['asset']}_Eye_Highlight_{side}",
                    (x - side * height * eye_x * 0.35, y - height * 0.002, z + height * eye_z * 0.35),
                    (height * eye_x * 0.18, height * 0.0008, height * eye_z * 0.14),
                    highlight_mat,
                    12,
                    6,
                )
                add_flat(
                    f"{spec['asset']}_Cheek_{side}",
                    (side * height * x_offset * 1.28, y + height * 0.001, z - height * 0.040),
                    (height * eye_x * 0.40, height * 0.0009, height * eye_z * 0.18),
                    cheek_mat,
                    16,
                    6,
                )
        return made

    def add_kid_polish_details(obj, spec: dict):
        b = bounds(obj)
        height = b["max_z"] - b["min_z"]
        c = spec["colors"]
        toy = spec["style"] == "BlindBox"
        mat_trim = make_mat(f"{spec['asset']}_PremiumTrim", c["trim"], 0.34 if toy else 0.58)
        mat_lace = make_mat(f"{spec['asset']}_Lace", c["lace"], 0.30 if toy else 0.52)
        mat_hair = make_mat(f"{spec['asset']}_HairTuft", c["hair"], 0.28 if toy else 0.42)
        mat_shadow = make_mat(f"{spec['asset']}_HairlineSoftShadow", (0.018, 0.014, 0.012, 1.0), 0.52 if not toy else 0.34)
        mat_scalp_gap = make_mat(
            f"{spec['asset']}_HairlineSkinBreak",
            (
                min(1.0, c["skin"][0] * 0.78 + c["hair"][0] * 0.08),
                min(1.0, c["skin"][1] * 0.78 + c["hair"][1] * 0.08),
                min(1.0, c["skin"][2] * 0.78 + c["hair"][2] * 0.08),
                1.0,
            ),
            0.56 if not toy else 0.36,
        )
        mat_shoe = make_mat(f"{spec['asset']}_ShoeDetail", c["shoes"], 0.28 if toy else 0.46)
        mat_strap = make_mat(f"{spec['asset']}_BackpackDetail", c["straps"], 0.34 if toy else 0.58)
        y_front = b["min_y"] - height * 0.008
        made = []

        # Hoodie and backpack details placed on top of the Hunyuan sculpt.
        made.append(add_tube(f"{spec['asset']}_Hoodie_Zipper", [(0, y_front, height * 0.735), (0, y_front - height * 0.004, height * 0.455)], height * 0.0028, mat_trim))
        made.append(add_beveled_cube(f"{spec['asset']}_Hoodie_Waist_Rib", (0, y_front - height * 0.002, height * 0.438), (height * 0.124, height * 0.006, height * 0.012), mat_trim, height * 0.0025))
        made.append(add_beveled_cube(f"{spec['asset']}_Kangaroo_Pocket_L", (-height * 0.039, y_front - height * 0.004, height * 0.545), (height * 0.030, height * 0.004, height * 0.030), mat_strap, height * 0.003))
        made.append(add_beveled_cube(f"{spec['asset']}_Kangaroo_Pocket_R", (height * 0.039, y_front - height * 0.004, height * 0.545), (height * 0.030, height * 0.004, height * 0.030), mat_strap, height * 0.003))
        made.append(add_beveled_cube(f"{spec['asset']}_Shorts_Waistband", (0, y_front - height * 0.002, height * 0.405), (height * 0.116, height * 0.005, height * 0.010), mat_trim, height * 0.002))
        made.append(add_tube(f"{spec['asset']}_Shorts_Center_Seam", [(0, y_front - height * 0.004, height * 0.398), (0, y_front - height * 0.006, height * 0.285)], height * 0.0018, mat_trim))
        for side in (-1, 1):
            sx = side * height * 0.035
            made.append(add_tube(f"{spec['asset']}_Hoodie_Drawcord_{side}", [(sx, y_front, height * 0.718), (sx + side * height * 0.010, y_front - height * 0.010, height * 0.575)], height * 0.0023, mat_lace))
            made.append(add_uv_sphere(f"{spec['asset']}_CordTip_{side}", (sx + side * height * 0.010, y_front - height * 0.010, height * 0.565), (height * 0.004, height * 0.002, height * 0.006), mat_trim, 14, 6))
            made.append(add_tube(f"{spec['asset']}_BackpackStrap_{side}", [(side * height * 0.083, y_front + height * 0.003, height * 0.720), (side * height * 0.115, y_front - height * 0.004, height * 0.500)], height * 0.0050, mat_strap))
            made.append(add_tube(f"{spec['asset']}_Shoulder_Seam_{side}", [(side * height * 0.060, y_front + height * 0.002, height * 0.705), (side * height * 0.150, y_front + height * 0.004, height * 0.642)], height * 0.0017, mat_trim))
            made.append(add_beveled_cube(f"{spec['asset']}_SleeveCuff_{side}", (side * height * 0.310, y_front + height * 0.015, height * 0.455), (height * 0.038, height * 0.011, height * 0.018), mat_trim, height * 0.004))
            made.append(add_beveled_cube(f"{spec['asset']}_ShoeToe_{side}", (side * height * 0.052, b["min_y"] - height * 0.010, height * 0.050), (height * 0.045, height * 0.060, height * 0.018), mat_shoe, height * 0.006))
            made.append(add_beveled_cube(f"{spec['asset']}_ShoeSole_{side}", (side * height * 0.052, b["min_y"] - height * 0.018, height * 0.030), (height * 0.050, height * 0.055, height * 0.008), mat_strap, height * 0.002))
            made.append(add_beveled_cube(f"{spec['asset']}_SockTopBand_{side}", (side * height * 0.060, y_front - height * 0.000, height * 0.222), (height * 0.038, height * 0.006, height * 0.008), mat_trim, height * 0.002))
            made.append(add_tube(f"{spec['asset']}_Short_Side_Seam_{side}", [(side * height * 0.084, y_front - height * 0.002, height * 0.395), (side * height * 0.086, y_front - height * 0.005, height * 0.282)], height * 0.0018, mat_trim))
            for lace in range(3):
                z = height * (0.062 + lace * 0.011)
                made.append(add_tube(f"{spec['asset']}_ShoeLace_{side}_{lace}", [(side * height * 0.028, b["min_y"] - height * 0.044, z), (side * height * 0.078, b["min_y"] - height * 0.044, z + height * 0.003)], height * 0.0014, mat_lace))

        for side, x in (("L", -height * 0.080), ("R", height * 0.080)):
            made.append(add_beveled_cube(f"{spec['asset']}_ShortHem_{side}", (x, y_front + height * 0.012, height * 0.285), (height * 0.052, height * 0.010, height * 0.012), mat_trim, height * 0.003))

        # Separate hair from scalp with individual locks, not a continuous band.
        lock_radius = height * (0.0020 if not toy else 0.0028)
        front_locks = [
            (-0.070, -0.060, 0.890, 0.865),
            (-0.047, -0.037, 0.895, 0.858),
            (-0.022, -0.010, 0.900, 0.868),
            (0.008, 0.000, 0.902, 0.862),
            (0.035, 0.046, 0.895, 0.865),
            (0.062, 0.076, 0.888, 0.872),
        ]
        for i, (sx, ex, sz, ez) in enumerate(front_locks):
            mx = (sx + ex) * 0.5
            made.append(add_tube(
                f"{spec['asset']}_Broken_Hairline_Lock_{i}",
                [
                    (height * sx, y_front - height * 0.001, height * sz),
                    (height * mx, y_front - height * 0.007, height * ((sz + ez) * 0.5)),
                    (height * ex, y_front - height * 0.003, height * ez),
                ],
                lock_radius,
                mat_hair,
                resolution=5,
            ))
        for side in (-1, 1):
            made.append(add_tube(
                f"{spec['asset']}_Temple_Hair_Separation_{side}",
                [
                    (side * height * 0.083, y_front + height * 0.001, height * 0.875),
                    (side * height * 0.091, y_front - height * 0.004, height * 0.840),
                    (side * height * 0.079, y_front - height * 0.002, height * 0.815),
                ],
                lock_radius * 0.9,
                mat_hair,
                resolution=5,
            ))
            made.append(add_uv_sphere(
                f"{spec['asset']}_Side_Hair_Volume_{side}",
                (side * height * 0.078, y_front + height * 0.010, height * 0.890),
                (height * 0.018, height * 0.010, height * 0.026),
                mat_hair,
                22,
                10,
                decimate=0.72,
            ))
        for i, x in enumerate([-0.056, -0.026, 0.018, 0.055]):
            made.append(add_uv_sphere(
                f"{spec['asset']}_Hairline_SkinBreak_{i}",
                (height * x, y_front - height * 0.011, height * (0.861 + (0.004 if i in (0, 3) else 0.0))),
                (height * 0.0048, height * 0.0014, height * 0.0026),
                mat_scalp_gap,
                18,
                6,
                decimate=0.60,
            ))
        shadow_segments = [
            (-0.070, -0.060, 0.862, 0.859),
            (-0.014, -0.002, 0.854, 0.853),
            (0.040, 0.054, 0.860, 0.858),
        ]
        for i, (sx, ex, sz, ez) in enumerate(shadow_segments):
            made.append(add_tube(
                f"{spec['asset']}_Broken_Hairline_Shadow_{i}",
                [
                    (height * sx, y_front - height * 0.0015, height * sz),
                    (height * ex, y_front - height * 0.0025, height * ez),
                ],
                height * 0.00045,
                mat_shadow,
                resolution=2,
            ))

        return made

    def look_at(obj, target: Vector) -> None:
        direction = target - obj.location
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    def setup_render(height: float) -> None:
        bpy.ops.object.light_add(type="AREA", location=(2.2, -4.0, height * 1.55))
        key = bpy.context.object
        key.data.energy = 760
        key.data.size = 4.8
        bpy.ops.object.light_add(type="AREA", location=(-2.0, -2.4, height * 0.75))
        fill = bpy.context.object
        fill.data.energy = 105
        fill.data.size = 3.0
        bpy.ops.object.camera_add(location=(0.0, -4.0, height * 0.56))
        cam = bpy.context.object
        look_at(cam, Vector((0, 0, height * 0.52)))
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = height * 1.16
        bpy.context.scene.camera = cam
        bpy.ops.mesh.primitive_plane_add(size=height * 1.45, location=(0, 0, -0.002))
        floor = bpy.context.object
        floor.name = "Preview_Ground_ShadowPlane"
        floor["exclude_from_export"] = True
        floor.data.materials.append(make_mat("Preview_Ground", (0.36, 0.36, 0.34, 1.0), 0.82))

    def render(path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)

    def draw_wire(objects, path: Path) -> None:
        edges = []
        points = []
        for obj in objects:
            if obj.type != "MESH":
                continue
            start = len(points)
            points.extend([(obj.matrix_world @ v.co) for v in obj.data.vertices])
            edges.extend([(start + e.vertices[0], start + e.vertices[1]) for e in obj.data.edges])
        if not points:
            return
        coords = [(p.x, p.z) for p in points]
        min_x, max_x = min(x for x, _ in coords), max(x for x, _ in coords)
        min_y, max_y = min(y for _, y in coords), max(y for _, y in coords)
        w, h, pad = 1100, 1500, 72
        scale = min((w - 2 * pad) / max(max_x - min_x, 1e-5), (h - 2 * pad) / max(max_y - min_y, 1e-5))

        def screen(index):
            x, y = coords[index]
            return int((x - min_x) * scale + pad), int(h - ((y - min_y) * scale + pad))

        buf = bytearray([238, 238, 232] * w * h)

        def line(a, b):
            x0, y0 = a
            x1, y1 = b
            dx, sx = abs(x1 - x0), 1 if x0 < x1 else -1
            dy, sy = -abs(y1 - y0), 1 if y0 < y1 else -1
            err = dx + dy
            while True:
                if 0 <= x0 < w and 0 <= y0 < h:
                    idx = (y0 * w + x0) * 3
                    buf[idx:idx + 3] = bytes((18, 18, 18))
                if x0 == x1 and y0 == y1:
                    break
                e2 = 2 * err
                if e2 >= dy:
                    err += dy
                    x0 += sx
                if e2 <= dx:
                    err += dx
                    y0 += sy

        for a, b in edges:
            line(screen(a), screen(b))
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(f"P6\n{w} {h}\n255\n".encode("ascii"))
            tmp.write(buf)
        try:
            subprocess.run(["sips", "-s", "format", "png", str(tmp_path), "--out", str(path)], check=True, stdout=subprocess.DEVNULL)
        finally:
            tmp_path.unlink(missing_ok=True)

    def export(out_dir: Path, asset: str, objects, arm):
        export_objects = [obj for obj in objects if not obj.get("exclude_from_export")]
        out_dir.mkdir(parents=True, exist_ok=True)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in export_objects:
            obj.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        glb = out_dir / f"{asset}.glb"
        fbx = out_dir / f"{asset}.fbx"
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
        bpy.ops.export_scene.fbx(
            filepath=str(fbx),
            use_selection=True,
            object_types={"MESH", "ARMATURE"},
            apply_unit_scale=True,
            bake_space_transform=False,
            axis_forward="Z",
            axis_up="Y",
            add_leaf_bones=False,
            bake_anim=False,
            path_mode="COPY",
            embed_textures=False,
        )
        return fbx, glb

    def rel(path: Path) -> str:
        return str(path.relative_to(ROOT))

    summary_assets = []
    for spec in SPECS:
        reset_scene()
        bpy.ops.import_scene.gltf(filepath=str(SOURCE_MESH))
        body = collect_and_join(spec["asset"])
        normalize_height(body, spec["height"])
        decimated = decimate_to_budget(body, spec["target_tris"])
        assign_regions(body, spec)
        eye_objects = add_eye_overlays(body, spec)
        detail_objects = add_kid_polish_details(body, spec)
        objects = [body] + eye_objects + detail_objects
        arm = create_armature(spec["height"])
        for obj in objects:
            bind_to_armature(obj, arm, spec["height"])

        out_dir = ROOT / "art-source" / "Characters" / "Kid" / spec["style"] / VERSION_DIR
        tex_dir = copy_texture_set(spec, out_dir)
        preview_dir = out_dir / "Previews"
        wire_dir = out_dir / "Wireframes"
        report_dir = out_dir / "Reports"
        out_dir.mkdir(parents=True, exist_ok=True)
        preview_dir.mkdir(parents=True, exist_ok=True)
        wire_dir.mkdir(parents=True, exist_ok=True)
        report_dir.mkdir(parents=True, exist_ok=True)
        blend = out_dir / f"{spec['asset']}.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(blend))
        fbx, glb = export(out_dir, spec["asset"], objects, arm)
        setup_render(spec["height"])
        preview = preview_dir / f"{spec['asset']}_preview.png"
        wire = wire_dir / f"{spec['asset']}_wireframe.png"
        render(preview)
        draw_wire(objects, wire)
        actual_tris = triangle_count(objects)
        lods = {}
        if spec["style"] == "Photoreal":
            for label, ratio in [("LOD1", 0.58), ("LOD2", 0.36)]:
                for obj in objects:
                    if obj.type != "MESH":
                        continue
                    mod = obj.modifiers.new(f"{label}_Decimate", "DECIMATE")
                    mod.ratio = ratio
                    apply_modifiers(obj)
                lod_tris = triangle_count(objects)
                lod_fbx, lod_glb = export(out_dir, f"{spec['asset']}_{label}", objects, arm)
                lods[label] = {"fbx": rel(lod_fbx), "glb": rel(lod_glb), "triangles": lod_tris}
        report = {
            "asset": spec["asset"],
            "role": "Kid",
            "style": spec["style"],
            "status": "premium_hunyuan_shape_based_local_gate_candidate_user_visual_review_pending",
            "source": {
                "mesh": rel(SOURCE_MESH),
                "geometry": "Hunyuan3D generated white mesh",
                "texture_projection_used": False,
                "primitive_composed_human": False,
            },
            "outputs": {"blend": rel(blend), "fbx": rel(fbx), "glb": rel(glb), "preview": rel(preview), "wireframe": rel(wire)},
            "lods": lods,
            "budget": {
                "target_tris_min": spec["budget"][0],
                "target_tris_max": spec["budget"][1],
                "body_triangles_after_decimate": decimated,
                "actual_triangles": actual_tris,
                "triangle_budget_passed": spec["budget"][0] <= actual_tris <= spec["budget"][1],
            },
            "materials": {
                "texture_directory": rel(tex_dir),
                "copied_pbr_texture_pack": True,
                "render_material_route": "region materials plus premium detail overlays",
            },
            "rig": {
                "armature_name": "Rig_Humanoid_Shared",
                "same_bone_names_as_task_a": True,
                "armature_modifier_bound": True,
                "unity_humanoid_avatar_validation": "blocked_no_active_unity_license",
            },
            "limitations": [
                "Unity import/avatar validation still blocked by missing active Unity license.",
            ],
        }
        report_path = report_dir / f"{spec['asset']}_budget_report.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        readme = out_dir / "README.md"
        lod_text = ""
        if lods:
            lod_text = "\n- LOD files: " + ", ".join(f"`{Path(v['fbx']).name}`, `{Path(v['glb']).name}`" for v in lods.values())
        readme.write_text(
            f"# {spec['asset']}\n\n"
            f"Art-only premium v10 local candidate for Kid {spec['style']}.\n\n"
            f"- Main files: `{spec['asset']}.fbx`, `{spec['asset']}.glb`, `{spec['asset']}.blend`{lod_text}\n"
            f"- Preview: `Previews/{spec['asset']}_preview.png`\n"
            f"- Wireframe: `Wireframes/{spec['asset']}_wireframe.png`\n"
            f"- Budget report: `Reports/{spec['asset']}_budget_report.json`\n"
            f"- Texture pack: `Textures/`\n"
            f"- Triangle count: {actual_tris:,}\n"
            f"- Rig: shared Humanoid bone names with armature binding; Unity Avatar validation pending license activation.\n",
            encoding="utf-8",
        )
        summary_assets.append(
            {
                "asset": spec["asset"],
                "style": spec["style"],
                "triangles": actual_tris,
                "preview": rel(preview),
                "wireframe": rel(wire),
                "report": rel(report_path),
                "readme": rel(readme),
                **({"lods": lods} if lods else {}),
            }
        )

    summary = {
        "asset_count": 3,
        "scope": "Kid B1/B2/B3 Hunyuan shape-based three-style visual rework v10",
        "assets": summary_assets,
        "contact_sheet": rel(CONTACT_SHEET),
        "source_mesh": rel(SOURCE_MESH),
        "unity_validation": "blocked_no_active_unity_license",
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if "--build" in sys.argv:
        blender_main()
    else:
        run_blender()
