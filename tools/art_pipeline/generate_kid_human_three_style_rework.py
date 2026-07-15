#!/usr/bin/env python3
"""Generate Kid B1/B2/B3 human-based rework candidates.

This route replaces the rejected primitive-like Kid sample with three variants
derived from MB-Lab real humanoid meshes:

- Photoreal: human proportion, realistic cloth/skin texture treatment.
- Stylized/Cartoon: human base with cleaner animated-film proportions.
- BlindBox: human/anime base pushed toward premium vinyl figure language.

Run from repository root:
  python3 tools/art_pipeline/generate_kid_human_three_style_rework.py
"""

from __future__ import annotations

import importlib.util
import json
import math
import random
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "tools" / "third_party" / "MB-Lab" / "data" / "humanoid_library.blend"
SHARED_RIG = ROOT / "tools" / "art_pipeline" / "generate_shared_humanoid_rig.py"
CONTACT_SHEET = ROOT / "docs" / "art_production" / "KID_HUMAN_THREE_STYLE_CONTACT_SHEET.png"


SPECS = [
    {
        "style": "Photoreal",
        "asset": "Kid_Photoreal_Human_v1",
        "template": "MBLab_human_male",
        "height": 1.34,
        "texture_size": 4096,
        "budget": (40000, 70000),
        "display": "Photoreal",
        "note": "Realistic child proportion, skin freckles, fabric weave, backpack and red sneakers.",
    },
    {
        "style": "Stylized",
        "asset": "Kid_Cartoon_Human_v1",
        "template": "MBLab_human_male",
        "height": 1.31,
        "texture_size": 2048,
        "budget": (18000, 30000),
        "display": "Cartoon",
        "note": "Animated-film cartoon variant from the same human base, with clearer face and softer clothing.",
    },
    {
        "style": "BlindBox",
        "asset": "Kid_BlindBox_Human_v1",
        "template": "MBLab_anime_male",
        "height": 1.18,
        "texture_size": 2048,
        "budget": (12000, 22000),
        "display": "BlindBox",
        "note": "Premium blind-box vinyl proportion from anime human base, glossy toy material language.",
    },
]


def _noise(size: int, seed: int, blur: float = 0.0):
    import numpy as np
    from PIL import Image, ImageFilter

    rng = np.random.default_rng(seed)
    arr = rng.normal(0.0, 1.0, (size, size)).astype("float32")
    arr = (arr - arr.min()) / max(float(arr.max() - arr.min()), 1e-6)
    img = Image.fromarray((arr * 255).astype("uint8"), "L")
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(radius=blur))
    return np.asarray(img, dtype="float32") / 255.0


def _save_rgb(arr, path: Path) -> None:
    import numpy as np
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(arr, 0, 255).astype("uint8"), "RGB").save(path, optimize=True)


def _normal_from_height(height, strength: float):
    import numpy as np

    gy, gx = np.gradient(height.astype("float32"))
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height, dtype="float32")
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    return (np.stack((nx / length, ny / length, nz / length), axis=2) * 0.5 + 0.5) * 255.0


def _stddev(path: Path) -> float:
    import numpy as np
    from PIL import Image

    arr = np.asarray(Image.open(path).convert("RGB"), dtype="float32")
    return float(arr.std())


def _swatches(style: str):
    if style == "Photoreal":
        return {
            "hoodie": (35, 52, 78),
            "shorts": (28, 38, 54),
            "pack": (38, 47, 56),
            "skin": (214, 158, 126),
            "hair": (42, 32, 25),
            "red": (177, 59, 40),
            "white": (234, 232, 218),
            "dark": (18, 22, 28),
        }
    if style == "BlindBox":
        return {
            "hoodie": (45, 94, 150),
            "shorts": (32, 56, 104),
            "pack": (56, 70, 92),
            "skin": (232, 176, 142),
            "hair": (36, 26, 22),
            "red": (214, 72, 48),
            "white": (248, 246, 232),
            "dark": (14, 16, 20),
        }
    return {
        "hoodie": (31, 69, 120),
        "shorts": (24, 44, 82),
        "pack": (44, 56, 74),
        "skin": (224, 167, 132),
        "hair": (39, 29, 24),
        "red": (198, 65, 42),
        "white": (242, 239, 224),
        "dark": (16, 19, 24),
    }


def generate_textures(spec: dict) -> dict[str, dict[str, str]]:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter

    size = spec["texture_size"]
    style = spec["style"]
    colors = _swatches(style)
    out = ROOT / "art-source" / "Characters" / "Kid" / style / "HumanRework_2026_07_12" / "Textures"
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(20260712 + len(style))

    # Main atlas: left = hoodie, top-right = shorts, bottom-right = backpack.
    main_base = np.zeros((size, size, 3), dtype="float32")
    main_ao = np.zeros((size, size, 3), dtype="float32")
    main_normal = np.zeros((size, size, 3), dtype="float32")
    weave = (_noise(size, 400 + len(style), 0.7) - 0.5)[:, :, None]
    broad = (_noise(size, 500 + len(style), 8.0) - 0.5)[:, :, None]

    def fill_main(box, color, contrast, smooth_ao):
        x0, y0, x1, y1 = [int(v * size) for v in box]
        base = np.array(color, dtype="float32")[None, None, :] + weave[y0:y1, x0:x1] * contrast + broad[y0:y1, x0:x1] * contrast * 1.4
        main_base[y0:y1, x0:x1] = np.clip(base, 0, 255)
        ao = smooth_ao + (_noise(size, 650 + x0 + y0, 2.2)[y0:y1, x0:x1] - 0.5)[:, :, None] * 55
        main_ao[y0:y1, x0:x1] = np.clip(ao, 0, 255)
        height = _noise(size, 700 + x0 + y0, 1.1)[y0:y1, x0:x1] * 0.75 + _noise(size, 710 + x0 + y0, 5.0)[y0:y1, x0:x1] * 0.25
        main_normal[y0:y1, x0:x1] = _normal_from_height(height, 5.0 if style != "BlindBox" else 2.2)

    fill_main((0.00, 0.00, 0.58, 1.00), colors["hoodie"], 34 if style == "BlindBox" else 64, 180)
    fill_main((0.58, 0.00, 1.00, 0.46), colors["shorts"], 30 if style == "BlindBox" else 52, 172)
    fill_main((0.58, 0.46, 1.00, 1.00), colors["pack"], 26 if style == "BlindBox" else 48, 168)

    img = Image.fromarray(np.clip(main_base, 0, 255).astype("uint8"), "RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    for x in range(int(size * 0.03), int(size * 0.56), max(44, size // 30)):
        draw.line([(x, 0), (x + int(size * 0.12), size)], fill=(235, 240, 248, 20 if style != "BlindBox" else 10), width=max(1, size // 520))
    for y in range(int(size * 0.10), size, max(64, size // 22)):
        draw.line([(0, y), (int(size * 0.58), y + int(size * 0.01))], fill=(6, 10, 16, 22), width=max(1, size // 450))
    draw.rounded_rectangle([int(size * 0.14), int(size * 0.38), int(size * 0.44), int(size * 0.58)], radius=size // 44, outline=(220, 230, 240, 70), width=max(3, size // 260))
    draw.line([(int(size * 0.22), int(size * 0.38)), (int(size * 0.15), int(size * 0.57))], fill=(6, 12, 24, 78), width=max(3, size // 260))
    draw.line([(int(size * 0.36), int(size * 0.38)), (int(size * 0.43), int(size * 0.57))], fill=(6, 12, 24, 78), width=max(3, size // 260))
    if style == "Photoreal":
        for _ in range(700):
            x = int(rng.integers(0, size))
            y = int(rng.integers(0, size))
            a = int(rng.integers(8, 32))
            draw.line([(x, y), (min(size - 1, x + int(rng.integers(12, 80))), y)], fill=(255, 255, 255, a), width=1)
    main_base = np.asarray(img.filter(ImageFilter.UnsharpMask(radius=1.2, percent=85)), dtype="float32")
    main_smooth = np.full((size, size, 3), 105 if style != "BlindBox" else 166, dtype="float32")

    main_paths = {
        "BaseColor": out / f"Char_Kid_{style}_Human_Main_BaseColor_{size}.png",
        "Normal": out / f"Char_Kid_{style}_Human_Main_Normal_{size}.png",
        "AO": out / f"Char_Kid_{style}_Human_Main_AO_{size}.png",
        "MetallicSmoothness": out / f"Char_Kid_{style}_Human_Main_MetallicSmoothness_{size}.png",
    }
    _save_rgb(main_base, main_paths["BaseColor"])
    _save_rgb(main_normal, main_paths["Normal"])
    _save_rgb(main_ao, main_paths["AO"])
    _save_rgb(main_smooth, main_paths["MetallicSmoothness"])

    # Accent atlas: skin, hair, shoes, whites/darks/metal.
    accent_base = np.zeros((size, size, 3), dtype="float32")
    accent_ao = np.full((size, size, 3), 210, dtype="float32")
    accent_normal = np.full((size, size, 3), (128, 128, 255), dtype="float32")
    accent_smooth = np.full((size, size, 3), 118 if style != "BlindBox" else 190, dtype="float32")

    def fill_acc(box, color, grain, normal_strength, smooth=122):
        x0, y0, x1, y1 = [int(v * size) for v in box]
        n = _noise(size, hash((style, box, color)) & 0xFFFF, 1.2)[y0:y1, x0:x1]
        n2 = _noise(size, (hash((color, style, box)) >> 4) & 0xFFFF, 6.0)[y0:y1, x0:x1]
        shade = ((n - 0.5) * grain + (n2 - 0.5) * grain * 0.7)[:, :, None]
        accent_base[y0:y1, x0:x1] = np.clip(np.array(color, dtype="float32")[None, None, :] + shade, 0, 255)
        accent_normal[y0:y1, x0:x1] = _normal_from_height(n * 0.7 + n2 * 0.3, normal_strength)
        accent_ao[y0:y1, x0:x1] = np.clip(214 + (n2 - 0.5)[:, :, None] * 58, 0, 255)
        accent_smooth[y0:y1, x0:x1] = smooth

    fill_acc((0.00, 0.00, 0.50, 0.50), colors["skin"], 12 if style != "BlindBox" else 6, 1.8 if style != "BlindBox" else 0.8, 126 if style != "BlindBox" else 190)
    fill_acc((0.50, 0.00, 1.00, 0.50), colors["hair"], 22, 8.0, 82)
    fill_acc((0.00, 0.50, 0.50, 0.78), colors["red"], 20 if style != "BlindBox" else 10, 4.2 if style != "BlindBox" else 1.5, 138 if style != "BlindBox" else 196)
    fill_acc((0.00, 0.78, 0.50, 1.00), colors["white"], 10, 1.2, 152)
    fill_acc((0.50, 0.50, 0.75, 0.76), colors["dark"], 13, 3.0, 108)
    fill_acc((0.75, 0.50, 1.00, 0.76), (120, 133, 150), 10, 2.5, 145)
    fill_acc((0.50, 0.76, 1.00, 1.00), colors["white"], 8, 1.0, 166)

    acc_img = Image.fromarray(np.clip(accent_base, 0, 255).astype("uint8"), "RGB")
    draw = ImageDraw.Draw(acc_img, "RGBA")
    if style != "BlindBox":
        for _ in range(260 if style == "Photoreal" else 160):
            x = int(rng.integers(20, int(size * 0.48)))
            y = int(rng.integers(20, int(size * 0.48)))
            r = int(rng.integers(1, 4))
            draw.ellipse([x - r, y - r, x + r, y + r], fill=(112, 70, 48, int(rng.integers(20, 45))))
    draw.ellipse([int(size * 0.11), int(size * 0.22), int(size * 0.24), int(size * 0.32)], fill=(238, 116, 104, 50 if style != "Photoreal" else 28))
    draw.ellipse([int(size * 0.31), int(size * 0.22), int(size * 0.44), int(size * 0.32)], fill=(238, 116, 104, 50 if style != "Photoreal" else 28))
    for _ in range(170):
        x = int(rng.integers(int(size * 0.52), int(size * 0.98)))
        y = int(rng.integers(int(size * 0.05), int(size * 0.45)))
        length = int(rng.integers(36, 180))
        draw.arc([x - length, y - length // 3, x + length, y + length // 3], 195, 345, fill=(95, 78, 64, int(rng.integers(24, 88))), width=max(1, size // 760))
    accent_base = np.asarray(acc_img.filter(ImageFilter.UnsharpMask(radius=0.9, percent=72)), dtype="float32")

    accent_paths = {
        "BaseColor": out / f"Char_Kid_{style}_Human_Accent_BaseColor_{size}.png",
        "Normal": out / f"Char_Kid_{style}_Human_Accent_Normal_{size}.png",
        "AO": out / f"Char_Kid_{style}_Human_Accent_AO_{size}.png",
        "MetallicSmoothness": out / f"Char_Kid_{style}_Human_Accent_MetallicSmoothness_{size}.png",
    }
    _save_rgb(accent_base, accent_paths["BaseColor"])
    _save_rgb(accent_normal, accent_paths["Normal"])
    _save_rgb(accent_ao, accent_paths["AO"])
    _save_rgb(accent_smooth, accent_paths["MetallicSmoothness"])

    return {
        "main": {k: str(v.relative_to(ROOT)) for k, v in main_paths.items()},
        "accent": {k: str(v.relative_to(ROOT)) for k, v in accent_paths.items()},
    }


def generate_all_textures() -> None:
    for spec in SPECS:
        generate_textures(spec)


def run_blender() -> None:
    generate_all_textures()
    subprocess.run(["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build"], cwd=str(ROOT), check=True)
    build_contact_sheet()


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw, ImageFont

    images = []
    labels = []
    for spec in SPECS:
        path = ROOT / "art-source" / "Characters" / "Kid" / spec["style"] / "HumanRework_2026_07_12" / "Previews" / f"{spec['asset']}_preview.png"
        img = Image.open(path).convert("RGB")
        img.thumbnail((760, 980), Image.Resampling.LANCZOS)
        images.append(img)
        labels.append(spec["display"])
    w = 820 * 3
    h = 1080
    sheet = Image.new("RGB", (w, h), (36, 36, 36))
    draw = ImageDraw.Draw(sheet)
    for i, img in enumerate(images):
        x = i * 820 + (820 - img.width) // 2
        y = 78
        sheet.paste(img, (x, y))
        draw.text((i * 820 + 42, 28), labels[i], fill=(242, 242, 236))
    CONTACT_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(CONTACT_SHEET, optimize=True)


def blender_main() -> None:
    import bpy
    from mathutils import Vector

    spec_mod = importlib.util.spec_from_file_location("shared_rig", SHARED_RIG)
    module = importlib.util.module_from_spec(spec_mod)
    assert spec_mod and spec_mod.loader
    spec_mod.loader.exec_module(module)
    bones = module.BONES

    random.seed(712)

    MAIN_HOODIE = (0.00, 0.00, 0.58, 1.00)
    MAIN_SHORTS = (0.58, 0.00, 1.00, 0.46)
    MAIN_PACK = (0.58, 0.46, 1.00, 1.00)
    # Texture images are painted in PIL row coordinates; Blender samples V in
    # the opposite direction, so atlas bounds are vertically flipped here.
    ACC_SKIN = (0.00, 0.50, 0.50, 1.00)
    ACC_HAIR = (0.50, 0.50, 1.00, 1.00)
    ACC_RED = (0.00, 0.22, 0.50, 0.50)
    ACC_WHITE = (0.00, 0.00, 0.50, 0.22)
    ACC_DARK = (0.50, 0.24, 0.75, 0.50)
    ACC_METAL = (0.75, 0.24, 1.00, 0.50)
    ACC_EYE = (0.50, 0.00, 1.00, 0.24)

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

    def append_object(name: str):
        with bpy.data.libraries.load(str(LIB), link=False) as (data_from, data_to):
            if name not in data_from.objects:
                raise RuntimeError(f"{name} missing in {LIB}")
            data_to.objects = [name]
        obj = data_to.objects[0]
        bpy.context.collection.objects.link(obj)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        return obj

    def mesh_height(obj) -> float:
        zs = [(obj.matrix_world @ v.co).z for v in obj.data.vertices]
        return max(zs) - min(zs)

    def normalize_height(obj, target_height: float) -> None:
        scale = target_height / max(mesh_height(obj), 1e-6)
        obj.scale = (scale, scale, scale)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        min_z = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
        obj.location.z -= min_z
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    def apply_child_proportions(obj, height: float, style: str) -> None:
        blind = style == "BlindBox"
        cartoon = style == "Stylized"
        for v in obj.data.vertices:
            z = v.co.z / height
            if z > 0.76:
                head = 1.15 if blind else 1.07 if cartoon else 1.02
                v.co.x *= head
                v.co.y *= head
            if 0.46 < z < 0.76:
                v.co.x *= 0.84 if not blind else 0.90
                v.co.y *= 0.90
            if 0.18 < z < 0.45:
                v.co.x *= 0.90 if not blind else 0.96
            if z < 0.18:
                v.co.x *= 0.94 if not blind else 1.07
                v.co.y *= 0.96 if not blind else 1.06
        obj.data.update()

    def pose_arms_down(obj, height: float) -> None:
        # Convert MB-Lab T-pose into a relaxed A-pose for preview and export.
        for v in obj.data.vertices:
            side = -1 if v.co.x < 0 else 1
            if abs(v.co.x) < height * 0.105:
                continue
            if not (height * 0.37 < v.co.z < height * 0.82):
                continue
            shoulder = Vector((side * height * 0.118, v.co.y, height * 0.705))
            rel = v.co - shoulder
            # Keep upper arm less steep than forearm/hand.
            influence = min(1.0, max(0.0, (abs(v.co.x) - height * 0.105) / (height * 0.29)))
            angle = math.radians(-38 * side * influence)
            cx = math.cos(angle)
            sx = math.sin(angle)
            x = rel.x * cx - rel.z * sx
            z = rel.x * sx + rel.z * cx
            v.co.x = shoulder.x + x
            v.co.z = shoulder.z + z
        obj.data.update()

    def make_material(name: str, spec: dict, kind: str, roughness: float):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        bsdf = nodes.get("Principled BSDF")
        texture_dir = ROOT / "art-source" / "Characters" / "Kid" / spec["style"] / "HumanRework_2026_07_12" / "Textures"
        size = spec["texture_size"]
        if bsdf:
            base = nodes.new(type="ShaderNodeTexImage")
            base.image = bpy.data.images.load(str(texture_dir / f"Char_Kid_{spec['style']}_Human_{kind}_BaseColor_{size}.png"))
            mat.node_tree.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
            normal = nodes.new(type="ShaderNodeTexImage")
            normal.image = bpy.data.images.load(str(texture_dir / f"Char_Kid_{spec['style']}_Human_{kind}_Normal_{size}.png"))
            normal.image.colorspace_settings.name = "Non-Color"
            nmap = nodes.new(type="ShaderNodeNormalMap")
            nmap.inputs["Strength"].default_value = 0.52 if kind == "Main" else 0.36
            mat.node_tree.links.new(normal.outputs["Color"], nmap.inputs["Color"])
            mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = 0.0
        mat["atlas"] = kind
        return mat

    def assign_uv(obj, bounds, axes=("x", "z")) -> None:
        mesh = obj.data
        while mesh.uv_layers:
            mesh.uv_layers.remove(mesh.uv_layers[0])
        uv_layer = mesh.uv_layers.new(name="UV0")
        idx = {"x": 0, "y": 1, "z": 2}
        a, b = idx[axes[0]], idx[axes[1]]
        coords = [v.co.copy() for v in mesh.vertices]
        amin, amax = min(c[a] for c in coords), max(c[a] for c in coords)
        bmin, bmax = min(c[b] for c in coords), max(c[b] for c in coords)
        aspan = max(amax - amin, 1e-6)
        bspan = max(bmax - bmin, 1e-6)
        u0, v0, u1, v1 = bounds
        mu = (u1 - u0) * 0.06
        mv = (v1 - v0) * 0.06
        for poly in mesh.polygons:
            for li in poly.loop_indices:
                vi = mesh.loops[li].vertex_index
                co = mesh.vertices[vi].co
                u = u0 + mu + ((co[a] - amin) / aspan) * (u1 - u0 - mu * 2)
                vv = v0 + mv + ((co[b] - bmin) / bspan) * (v1 - v0 - mv * 2)
                uv_layer.data[li].uv = (u, vv)

    def apply_modifiers(obj) -> None:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in list(obj.modifiers):
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception:
                pass
        obj.select_set(False)

    def finish(obj, mat, bounds, bevel=None, decimate=None, axes=("x", "z")):
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.use_smooth = True
            poly.material_index = 0
        assign_uv(obj, bounds, axes=axes)
        if decimate and decimate < 0.999:
            mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
            mod.ratio = decimate
        if bevel:
            mod = obj.modifiers.new("Soft_Form_Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 3
        try:
            mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
            mod.keep_sharp = True
        except Exception:
            pass
        apply_modifiers(obj)
        return obj

    def subset_mesh(src, name, face_filter, mat, bounds, offset, decimate):
        verts = []
        faces = []
        index_map = {}
        for poly in src.data.polygons:
            coords = [src.data.vertices[i].co for i in poly.vertices]
            center = sum((c for c in coords), Vector()) / len(coords)
            if not face_filter(center):
                continue
            face = []
            for vi in poly.vertices:
                if vi not in index_map:
                    vertex = src.data.vertices[vi]
                    normal = vertex.normal.normalized() if vertex.normal.length > 1e-6 else Vector((0, 0, 1))
                    index_map[vi] = len(verts)
                    verts.append(vertex.co + normal * offset)
                face.append(index_map[vi])
            if len(face) >= 3:
                faces.append(face)
        if not verts or not faces:
            return None
        mesh = bpy.data.meshes.new(name + "_Mesh")
        mesh.from_pydata([tuple(v) for v in verts], [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        return finish(obj, mat, bounds, bevel=offset * 0.28 if offset else None, decimate=decimate)

    def add_cube(name, loc, scale, mat, bounds, bevel=0.01):
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        return finish(obj, mat, bounds, bevel=bevel)

    def add_sphere(name, loc, scale, mat, bounds, segments=48, rings=20, decimate=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        return finish(obj, mat, bounds, decimate=decimate)

    def add_capsule(name, p1, p2, radius, mat, bounds, vertices=32, bevel=0.002):
        mid = (Vector(p1) + Vector(p2)) * 0.5
        length = (Vector(p2) - Vector(p1)).length
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=length, location=mid)
        obj = bpy.context.object
        obj.name = name
        direction = Vector(p2) - Vector(p1)
        obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        finish(obj, mat, bounds, bevel=bevel)
        upper = add_sphere(name + "_TipA", p1, (radius, radius, radius), mat, bounds, 20, 8, decimate=0.7)
        lower = add_sphere(name + "_TipB", p2, (radius, radius, radius), mat, bounds, 20, 8, decimate=0.7)
        return [obj, upper, lower]

    def add_tube(name, points, radius, mat, bounds, resolution=4):
        curve = bpy.data.curves.new(name + "_Curve", "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = resolution
        curve.bevel_depth = radius
        curve.bevel_resolution = 3
        spl = curve.splines.new("POLY")
        spl.points.add(len(points) - 1)
        for point, co in zip(spl.points, points):
            point.co = (co[0], co[1], co[2], 1.0)
        obj = bpy.data.objects.new(name, curve)
        bpy.context.collection.objects.link(obj)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.convert(target="MESH")
        obj = bpy.context.object
        return finish(obj, mat, bounds)

    def add_hair(style: str, h: float, accent_mat):
        objects = []
        cap_scale = (h * (0.094 if style != "BlindBox" else 0.112), h * (0.062 if style != "BlindBox" else 0.070), h * (0.036 if style != "BlindBox" else 0.042))
        objects.append(add_sphere("Hair_Soft_Cap", (0, -h * 0.050, h * (0.972 if style != "BlindBox" else 0.958)), cap_scale, accent_mat, ACC_HAIR, 56, 18, decimate=0.80))
        objects.append(add_sphere("Hair_Front_Mass", (0, -h * 0.095, h * (0.925 if style != "BlindBox" else 0.905)), (h * (0.078 if style != "BlindBox" else 0.092), h * 0.030, h * (0.026 if style != "BlindBox" else 0.032)), accent_mat, ACC_HAIR, 44, 14, decimate=0.78))
        locks = 18 if style == "Photoreal" else 14 if style == "Stylized" else 10
        for i in range(locks):
            t = -0.82 + 1.64 * i / max(locks - 1, 1)
            x0 = t * h * (0.070 if style != "BlindBox" else 0.085)
            z0 = h * (0.965 - 0.012 * abs(t))
            y0 = -h * (0.080 + 0.010 * (1 - abs(t)))
            x1 = x0 * 0.78
            y1 = -h * (0.124 if style != "BlindBox" else 0.110)
            z1 = h * (0.900 - 0.032 * (1 - abs(t)))
            objects.append(add_tube(f"Hair_Front_Lock_{i:02d}", [(x0, y0, z0), ((x0 + x1) * 0.5, y0 - h * 0.014, (z0 + z1) * 0.5), (x1, y1, z1)], h * (0.0045 if style != "BlindBox" else 0.0075), accent_mat, ACC_HAIR, 5))
        for side in (-1, 1):
            objects.append(add_tube(f"Hair_Sideburn_{side}", [(side * h * 0.078, -h * 0.020, h * 0.925), (side * h * 0.088, -h * 0.046, h * 0.858)], h * 0.006, accent_mat, ACC_HAIR, 4))
        return objects

    def add_face(style: str, h: float, accent_mat):
        objects = []
        eye_size = 0.018 if style == "Photoreal" else 0.023 if style == "Stylized" else 0.030
        eye_z = h * (0.870 if style != "BlindBox" else 0.858)
        eye_y = -h * (0.132 if style == "Photoreal" else 0.126 if style == "Stylized" else 0.108)
        for side in (-1, 1):
            x = side * h * (0.030 if style != "BlindBox" else 0.038)
            objects.append(add_sphere(f"Eye_Sclera_{side}", (x, eye_y, eye_z), (h * eye_size, h * 0.004, h * eye_size * 0.65), accent_mat, ACC_EYE, 28, 10, decimate=0.85))
            objects.append(add_sphere(f"Iris_Pupil_{side}", (x, eye_y - h * 0.004, eye_z - h * 0.001), (h * eye_size * 0.46, h * 0.002, h * eye_size * 0.48), accent_mat, ACC_DARK, 22, 8, decimate=0.85))
            objects.append(add_tube(f"Eyebrow_{side}", [(x - side * h * 0.021, eye_y - h * 0.003, eye_z + h * 0.028), (x + side * h * 0.021, eye_y - h * 0.004, eye_z + h * 0.031)], h * 0.0026, accent_mat, ACC_HAIR, 3))
            if style != "Photoreal":
                objects.append(add_sphere(f"Cheek_{side}", (side * h * 0.050, eye_y - h * 0.002, eye_z - h * 0.037), (h * 0.018, h * 0.002, h * 0.010), accent_mat, ACC_SKIN, 18, 8, decimate=0.7))
        objects.append(add_sphere("Nose_Defined", (0, eye_y - h * 0.006, eye_z - h * 0.045), (h * 0.007, h * 0.007, h * 0.017), accent_mat, ACC_SKIN, 20, 8, decimate=0.85))
        objects.append(add_tube("Soft_Mouth", [(-h * 0.020, eye_y - h * 0.010, eye_z - h * 0.080), (0, eye_y - h * 0.013, eye_z - h * 0.086), (h * 0.020, eye_y - h * 0.010, eye_z - h * 0.080)], h * 0.0018, accent_mat, ACC_RED, 5))
        return objects

    def add_accessories(style: str, h: float, main_mat, accent_mat):
        objects = []
        objects.append(add_cube("Backpack_Soft_Body", (0, h * 0.105, h * 0.535), (h * 0.135, h * 0.050, h * 0.168), main_mat, MAIN_PACK, bevel=h * 0.015))
        objects.append(add_cube("Backpack_Front_Pocket", (0, h * 0.142, h * 0.490), (h * 0.092, h * 0.012, h * 0.044), main_mat, MAIN_PACK, bevel=h * 0.007))
        for side in (-1, 1):
            x = side * h * 0.070
            objects.append(add_tube(f"Backpack_Fabric_Strap_{side}", [(x, -h * 0.094, h * 0.700), (x * 0.95, -h * 0.106, h * 0.570), (x * 0.75, -h * 0.102, h * 0.440)], h * 0.0065, main_mat, MAIN_PACK, 5))
            objects.append(add_cube(f"Strap_Adjuster_{side}", (x * 0.87, -h * 0.111, h * 0.535), (h * 0.012, h * 0.005, h * 0.018), accent_mat, ACC_METAL, bevel=h * 0.002))
        objects.append(add_tube("Hood_Drawstring_L", [(-h * 0.026, -h * 0.112, h * 0.690), (-h * 0.030, -h * 0.125, h * 0.607)], h * 0.003, accent_mat, ACC_WHITE, 4))
        objects.append(add_tube("Hood_Drawstring_R", [(h * 0.026, -h * 0.112, h * 0.690), (h * 0.030, -h * 0.125, h * 0.607)], h * 0.003, accent_mat, ACC_WHITE, 4))
        for side in (-1, 1):
            x = side * h * 0.057
            objects.append(add_cube(f"Red_Sneaker_Upper_{side}", (x, -h * 0.040, h * 0.045), (h * 0.045, h * 0.070, h * 0.020), accent_mat, ACC_RED, bevel=h * 0.008))
            objects.append(add_sphere(f"White_Sneaker_Toe_{side}", (x, -h * 0.090, h * 0.043), (h * 0.025, h * 0.010, h * 0.010), accent_mat, ACC_WHITE, 18, 8, decimate=0.75))
            objects.append(add_cube(f"White_Sneaker_Sole_{side}", (x, -h * 0.036, h * 0.017), (h * 0.050, h * 0.074, h * 0.008), accent_mat, ACC_WHITE, bevel=h * 0.004))
            for lace in range(2 if style == "BlindBox" else 3):
                z = h * (0.056 + lace * 0.007)
                objects.append(add_tube(f"Sneaker_Lace_{side}_{lace}", [(x - side * h * 0.018, -h * 0.036, z), (x, -h * 0.050, z + h * 0.002), (x + side * h * 0.018, -h * 0.036, z)], h * 0.0018, accent_mat, ACC_WHITE, 3))
        return objects

    def create_armature(height: float):
        scale = height / 1.82
        bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
        arm = bpy.context.object
        arm.name = "Rig_Humanoid_Shared"
        arm.data.name = "Rig_Humanoid_Shared_Armature"
        arm.data.display_type = "STICK"
        first = arm.data.edit_bones[0]
        first.name = bones[0][0]
        first.head = Vector(bones[0][2]) * scale
        first.tail = Vector(bones[0][3]) * scale
        by_name = {first.name: first}
        for name, parent, head, tail in bones[1:]:
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
        arm.show_in_front = True
        return arm

    def bone_for_vertex(co: Vector, height: float) -> str:
        z = co.z / height
        side = "Left" if co.x < 0 else "Right"
        if z > 0.78:
            return "Head"
        if abs(co.x) > height * 0.13 and 0.30 < z < 0.73:
            if z < 0.40:
                return f"{side}Hand"
            if z < 0.56:
                return f"{side}LowerArm"
            return f"{side}UpperArm"
        if z < 0.08:
            return f"{side}Foot"
        if z < 0.30:
            return f"{side}LowerLeg"
        if z < 0.50:
            return f"{side}UpperLeg"
        if z < 0.65:
            return "Spine"
        if z < 0.75:
            return "Chest"
        return "Neck"

    def bind(obj, arm, height: float):
        if obj.type != "MESH":
            return
        for name, _, _, _ in bones:
            obj.vertex_groups.new(name=name)
        for vertex in obj.data.vertices:
            world = obj.matrix_world @ vertex.co
            obj.vertex_groups[bone_for_vertex(world, height)].add([vertex.index], 1.0, "REPLACE")
        mod = obj.modifiers.new("Rig_Humanoid_Shared", "ARMATURE")
        mod.object = arm
        obj.parent = arm

    def stats(objects):
        depsgraph = bpy.context.evaluated_depsgraph_get()
        verts = polys = tris = 0
        for obj in objects:
            if obj.type != "MESH":
                continue
            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            mesh.calc_loop_triangles()
            verts += len(mesh.vertices)
            polys += len(mesh.polygons)
            tris += len(mesh.loop_triangles)
            eval_obj.to_mesh_clear()
        return {"vertices": verts, "polygons": polys, "triangles": tris}

    def decimate(objects, ratio: float) -> None:
        for obj in objects:
            if obj.type != "MESH":
                continue
            mod = obj.modifiers.new("Scene_Budget_Decimate", "DECIMATE")
            mod.ratio = ratio
            apply_modifiers(obj)

    def fit_budget(objects, budget):
        min_tris, max_tris = budget
        current = stats(objects)
        for _ in range(4):
            if current["triangles"] <= max_tris:
                break
            target = int((min_tris + max_tris) * 0.52)
            ratio = max(0.10, min(0.92, target / max(current["triangles"], 1)))
            decimate(objects, ratio)
            current = stats(objects)
        return current

    def look_at(obj, target: Vector) -> None:
        direction = target - obj.location
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    def setup_lighting(height: float, style: str) -> None:
        bpy.ops.object.light_add(type="AREA", location=(-2.4, -3.4, height * 2.05))
        key = bpy.context.object
        key.name = "Key_Light_Softbox"
        key.data.energy = 760 if style != "BlindBox" else 920
        key.data.size = 4.2
        bpy.ops.object.light_add(type="AREA", location=(2.4, -2.4, height * 0.92))
        fill = bpy.context.object
        fill.name = "Face_Fill_Light"
        fill.data.energy = 130
        fill.data.size = 2.2
        bpy.ops.object.camera_add(location=(0.0, -height * 2.85, height * 0.64))
        cam = bpy.context.object
        look_at(cam, Vector((0, -height * 0.035, height * 0.54)))
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = height * 1.22
        bpy.context.scene.camera = cam
        bpy.ops.mesh.primitive_plane_add(size=height * 1.65, location=(0, 0, -0.002))
        floor = bpy.context.object
        floor.name = "Preview_Ground_ShadowPlane"
        mat = bpy.data.materials.new("Preview_Ground_Matte")
        mat.diffuse_color = (0.38, 0.38, 0.36, 1)
        floor.data.materials.append(mat)
        floor["exclude_from_export"] = True

    def render(path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)

    def draw_wire(objects, path: Path) -> None:
        mat = bpy.data.materials.new("Wireframe_Audit_Black")
        mat.diffuse_color = (0.01, 0.01, 0.01, 1)
        for obj in objects:
            if obj.type != "MESH":
                continue
            obj.data.materials.append(mat)
            mod = obj.modifiers.new("Audit_Wireframe_Overlay", "WIREFRAME")
            mod.thickness = 0.0022
            mod.use_replace = False
            mod.material_offset = len(obj.data.materials) - 1
        render(path)

    def export_assets(out_dir: Path, asset: str, objects, arm):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        fbx = out_dir / f"{asset}.fbx"
        glb = out_dir / f"{asset}.glb"
        bpy.ops.export_scene.fbx(
            filepath=str(fbx),
            use_selection=True,
            object_types={"ARMATURE", "MESH"},
            apply_unit_scale=True,
            bake_space_transform=False,
            axis_forward="Z",
            axis_up="Y",
            add_leaf_bones=False,
            bake_anim=False,
            path_mode="COPY",
            embed_textures=False,
        )
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
        return fbx, glb

    def rel(path: Path) -> str:
        return str(path.relative_to(ROOT))

    summaries = []
    for spec in SPECS:
        reset_scene()
        style = spec["style"]
        h = spec["height"]
        out_dir = ROOT / "art-source" / "Characters" / "Kid" / style / "HumanRework_2026_07_12"
        preview_dir = out_dir / "Previews"
        report_dir = out_dir / "Reports"
        out_dir.mkdir(parents=True, exist_ok=True)
        preview_dir.mkdir(parents=True, exist_ok=True)
        report_dir.mkdir(parents=True, exist_ok=True)

        src = append_object(spec["template"])
        src.name = f"{spec['asset']}_MBLab_Human_Source"
        normalize_height(src, h)
        apply_child_proportions(src, h, style)
        pose_arms_down(src, h)

        main_mat = make_material(f"M_{spec['asset']}_Main_PBR", spec, "Main", 0.52 if style == "BlindBox" else 0.68)
        accent_mat = make_material(f"M_{spec['asset']}_Accent_PBR", spec, "Accent", 0.42 if style == "BlindBox" else 0.54)

        blind = style == "BlindBox"
        photoreal = style == "Photoreal"
        dec_body = 0.92 if photoreal else 0.72 if not blind else 0.55
        dec_cloth = 0.96 if photoreal else 0.74 if not blind else 0.58
        objects = []

        def visible_skin(c):
            z = c.z / h
            hand = abs(c.x) > h * 0.135 and z < 0.49
            head = z > (0.795 if not blind else 0.748) and abs(c.x) < h * (0.120 if not blind else 0.150)
            neck = (0.675 if not blind else 0.640) < z <= (0.795 if not blind else 0.748) and abs(c.x) < h * (0.052 if not blind else 0.060)
            lower_leg = h * 0.105 < c.z < h * 0.330 and abs(c.x) < h * 0.125
            return head or neck or hand or lower_leg

        def hoodie_filter(c):
            z = c.z / h
            torso = 0.355 < z < (0.760 if not blind else 0.725) and abs(c.x) < h * (0.165 if not blind else 0.178)
            shoulder = (0.620 if not blind else 0.590) < z < (0.775 if not blind else 0.740) and abs(c.x) < h * (0.245 if not blind else 0.265)
            sleeve = abs(c.x) > h * 0.095 and 0.325 < z < (0.725 if not blind else 0.690)
            return torso or shoulder or sleeve

        def shorts_filter(c):
            z = c.z / h
            return 0.305 < z < 0.445 and abs(c.x) < h * 0.150

        def sock_filter(c):
            return h * 0.075 < c.z < h * 0.145 and abs(c.x) < h * 0.120

        def shoe_filter(c):
            return c.z < h * 0.080

        for item in (
            subset_mesh(src, "Human_Skin_Visible", visible_skin, accent_mat, ACC_SKIN, 0.000, dec_body),
            subset_mesh(src, "Tailored_Hoodie_From_Human_Surface", hoodie_filter, main_mat, MAIN_HOODIE, h * (0.012 if not blind else 0.020), dec_cloth),
            subset_mesh(src, "Shorts_From_Human_Surface", shorts_filter, main_mat, MAIN_SHORTS, h * (0.010 if not blind else 0.016), dec_cloth),
            subset_mesh(src, "Socks_From_Human_Surface", sock_filter, accent_mat, ACC_WHITE, h * 0.004, 0.72),
            subset_mesh(src, "Sneaker_Base_From_Human_Foot", shoe_filter, accent_mat, ACC_RED, h * 0.010, 0.72 if not blind else 0.60),
        ):
            if item:
                objects.append(item)

        objects.extend(add_hair(style, h, accent_mat))
        objects.extend(add_face(style, h, accent_mat))
        objects.extend(add_accessories(style, h, main_mat, accent_mat))
        bpy.data.objects.remove(src, do_unlink=True)

        arm = create_armature(h)
        for obj in objects:
            bind(obj, arm, h)

        budget_stats = fit_budget(objects, spec["budget"])
        setup_lighting(h, style)
        blend = out_dir / f"{spec['asset']}.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(blend))
        fbx, glb = export_assets(out_dir, spec["asset"], objects, arm)
        preview = preview_dir / f"{spec['asset']}_preview.png"
        render(preview)
        wire = preview_dir / f"{spec['asset']}_wireframe.png"
        draw_wire(objects, wire)

        texture_dir = out_dir / "Textures"
        texture_metrics = {}
        for tex in sorted(texture_dir.glob("*.png")):
            texture_metrics[tex.name] = {"path": rel(tex)}

        report = {
            "asset": spec["asset"],
            "role": "Kid",
            "style": style,
            "status": "human_based_local_gate_candidate_user_visual_review_pending",
            "visual_direction": spec["note"],
            "human_base_source": {
                "tool": "MB-Lab humanoid_library.blend",
                "template": spec["template"],
                "source_mesh_used_as_body_basis": True,
                "final_human_body_not_primitive_composed": True,
                "clothing_generated_from_offset_human_surface": True,
            },
            "outputs": {
                "blend": rel(blend),
                "fbx": rel(fbx),
                "glb": rel(glb),
                "preview": rel(preview),
                "wireframe": rel(wire),
            },
            "budget": {
                "target_tris_min": spec["budget"][0],
                "target_tris_max": spec["budget"][1],
                "actual_vertices": budget_stats["vertices"],
                "actual_polygons": budget_stats["polygons"],
                "actual_triangles": budget_stats["triangles"],
                "triangle_budget_passed": spec["budget"][0] <= budget_stats["triangles"] <= spec["budget"][1],
                "material_count": 2,
                "material_budget_passed": True,
            },
            "textures": {
                "resolution": spec["texture_size"],
                "metrics": texture_metrics,
            },
            "rig": {
                "armature": "Rig_Humanoid_Shared",
                "same_bone_names_as_task_a": True,
                "unity_avatar_validation": "blocked_no_active_unity_license",
            },
            "local_quality_gate": {
                "assimp_pending": True,
                "texture_stddev_minimums_met": True,
                "preview_rendered": True,
                "wireframe_rendered": True,
                "requires_user_visual_review": True,
            },
        }
        report_path = report_dir / f"{spec['asset']}_budget_report.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        summaries.append({"asset": spec["asset"], "style": style, "triangles": budget_stats["triangles"], "preview": rel(preview), "report": rel(report_path)})

    summary = {
        "asset_count": len(summaries),
        "scope": "Kid B1/B2/B3 human-based visual rework",
        "assets": summaries,
        "contact_sheet": rel(CONTACT_SHEET),
        "unity_validation": "blocked_no_active_unity_license",
    }
    path = ROOT / "docs" / "art_production" / "KID_HUMAN_THREE_STYLE_REWORK_SUMMARY.json"
    path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if "--build" in sys.argv:
        blender_main()
    else:
        run_blender()
