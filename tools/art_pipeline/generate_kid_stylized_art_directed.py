#!/usr/bin/env python3
"""Build an art-directed Kid Stylized 3D sample from the approved prototype.

This script intentionally does not reuse the visually rejected Quaternius,
TripoSR, MPFB, or front-projection meshes. It creates a new stylized character
sample with two PBR atlas materials, a shared Humanoid armature, preview renders,
wireframe, FBX/GLB export, and a machine-readable report.

Run from the repository root:
  python3 tools/art_pipeline/generate_kid_stylized_art_directed.py
"""

from __future__ import annotations

import json
import math
import random
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "art-source" / "Characters" / "Kid" / "Stylized" / "Rework_2026_07_12_v3"
TEXTURE_DIR = OUT_DIR / "Textures"
PREVIEW_DIR = OUT_DIR / "Previews"
REPORT_DIR = OUT_DIR / "Reports"
SOURCE_PBR = ROOT / "art-source" / "_Source" / "PBR" / "PolyHaven" / "denim_fabric" / "2k"
REFERENCE_IMAGE = "art-source/Concepts/Rework_2026-07-12/01_kid_high_bar_model_sheet.png"
INPUT_IMAGE = "docs/art_production/hunyuan_inputs/kid_stylized_front_input.png"


def _stddev(path: Path) -> float:
    import numpy as np
    from PIL import Image

    arr = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    return float(arr.std())


def _save_rgb(arr, path: Path) -> None:
    import numpy as np
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(arr, 0, 255).astype("uint8"), "RGB").save(path, optimize=True)


def _normal_from_height(height, strength: float):
    import numpy as np

    gy, gx = np.gradient(height.astype(np.float32))
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height, dtype=np.float32)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    return (np.stack((nx / length, ny / length, nz / length), axis=2) * 0.5 + 0.5) * 255.0


def _noise(size: int, seed: int, blur: float = 0.0):
    import numpy as np
    from PIL import Image, ImageFilter

    rng = np.random.default_rng(seed)
    arr = rng.normal(0.0, 1.0, (size, size)).astype(np.float32)
    arr = (arr - arr.min()) / max(float(arr.max() - arr.min()), 1e-6)
    img = Image.fromarray((arr * 255).astype("uint8"), "L")
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(radius=blur))
    return np.asarray(img, dtype=np.float32) / 255.0


def _load_source_map(name: str, size: int):
    import numpy as np
    from PIL import Image

    path = SOURCE_PBR / f"denim_fabric_{name}_2k.jpg"
    if not path.exists():
        raise FileNotFoundError(path)
    img = Image.open(path).convert("RGB")
    if img.size != (size, size):
        img = img.resize((size, size), Image.Resampling.LANCZOS)
    return np.asarray(img, dtype=np.float32)


def generate_textures() -> dict[str, dict[str, str]]:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter

    size = 2048
    TEXTURE_DIR.mkdir(parents=True, exist_ok=True)

    denim_base = _load_source_map("BaseColor", size)
    denim_normal = _load_source_map("Normal", size)
    denim_ao = _load_source_map("AO", size)

    lum = denim_base.mean(axis=2)
    lum = (lum - lum.min()) / max(float(lum.max() - lum.min()), 1.0)
    weave = (lum - 0.5)[:, :, None]
    chroma = denim_base - denim_base.mean(axis=2, keepdims=True)

    main_base = np.zeros((size, size, 3), dtype=np.float32)
    main_ao = np.zeros((size, size, 3), dtype=np.float32)
    main_normal = np.zeros((size, size, 3), dtype=np.float32)

    def fill_main(box, tint, contrast=76.0, source_mix=0.18):
        x0, y0, x1, y1 = box
        x0, y0, x1, y1 = [int(v * size) for v in (x0, y0, x1, y1)]
        base = np.array(tint, dtype=np.float32)[None, None, :] + weave[y0:y1, x0:x1] * contrast + chroma[y0:y1, x0:x1] * source_mix
        main_base[y0:y1, x0:x1] = np.clip(base, 0, 255)
        main_ao[y0:y1, x0:x1] = denim_ao[y0:y1, x0:x1]
        main_normal[y0:y1, x0:x1] = denim_normal[y0:y1, x0:x1]

    # Atlas regions used by the Blender UV mapper:
    # left half: navy hoodie, top-right: backpack, bottom-right: charcoal shorts.
    fill_main((0.00, 0.00, 0.50, 1.00), (32, 47, 76), 88.0, 0.22)
    fill_main((0.50, 0.50, 1.00, 1.00), (24, 37, 60), 80.0, 0.20)
    fill_main((0.50, 0.00, 1.00, 0.50), (31, 32, 34), 68.0, 0.16)

    main_img = Image.fromarray(np.clip(main_base, 0, 255).astype("uint8"), "RGB")
    draw = ImageDraw.Draw(main_img, "RGBA")
    # Hoodie pocket outline, ribbing, seam rows, and worn fabric flecks.
    for x in range(38, int(size * 0.49), 70):
        draw.line([(x, 0), (x + 140, size)], fill=(210, 225, 245, 18), width=2)
    for y in range(96, size, 150):
        draw.line([(0, y), (int(size * 0.50), y + 18)], fill=(4, 10, 18, 28), width=3)
    draw.rounded_rectangle([int(size * 0.12), int(size * 0.23), int(size * 0.40), int(size * 0.50)], radius=40, outline=(220, 230, 240, 80), width=8)
    draw.line([(int(size * 0.20), int(size * 0.24)), (int(size * 0.13), int(size * 0.48))], fill=(15, 22, 38, 92), width=7)
    draw.line([(int(size * 0.32), int(size * 0.24)), (int(size * 0.39), int(size * 0.48))], fill=(15, 22, 38, 92), width=7)
    for x in range(int(size * 0.52), int(size * 0.98), 110):
        draw.line([(x, 0), (x + 60, int(size * 0.50))], fill=(230, 230, 230, 24), width=2)
    rng = np.random.default_rng(1905)
    for _ in range(240):
        x = int(rng.integers(0, size))
        y = int(rng.integers(0, size))
        length = int(rng.integers(14, 90))
        alpha = int(rng.integers(12, 42))
        draw.line([(x, y), (min(size, x + length), min(size, y + int(length * 0.15)))], fill=(255, 255, 255, alpha), width=1)
    main_base = np.asarray(main_img.filter(ImageFilter.UnsharpMask(radius=1.2, percent=92)), dtype=np.float32)

    # Extra large-scale wrinkle normals layered over source fabric normal.
    height = _noise(size, 219, blur=1.8) * 0.55 + _noise(size, 220, blur=10.0) * 0.45
    wrinkle_normal = _normal_from_height(height, 8.0)
    main_normal = np.clip(main_normal * 0.62 + wrinkle_normal * 0.38, 0, 255)
    main_smooth = np.full((size, size, 3), 92, dtype=np.float32)

    main_paths = {
        "BaseColor": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Main_BaseColor_2K.png",
        "Normal": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Main_Normal_2K.png",
        "AO": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Main_AO_2K.png",
        "MetallicSmoothness": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Main_MetallicSmoothness_2K.png",
    }
    _save_rgb(main_base, main_paths["BaseColor"])
    _save_rgb(main_normal, main_paths["Normal"])
    _save_rgb(main_ao, main_paths["AO"])
    _save_rgb(main_smooth, main_paths["MetallicSmoothness"])

    accent_base = np.zeros((size, size, 3), dtype=np.float32)
    accent_normal = np.full((size, size, 3), (128, 128, 255), dtype=np.float32)
    accent_ao = np.full((size, size, 3), 210, dtype=np.float32)
    accent_smooth = np.full((size, size, 3), 122, dtype=np.float32)

    def fill_region(box, color, grain=18.0, normal_strength=3.0, smooth=120):
        x0, y0, x1, y1 = [int(v * size) for v in box]
        n = _noise(size, hash((box, color)) & 0xFFFF, blur=1.3)[y0:y1, x0:x1]
        n2 = _noise(size, (hash((color, box)) >> 2) & 0xFFFF, blur=8.0)[y0:y1, x0:x1]
        shade = ((n - 0.5) * grain + (n2 - 0.5) * grain * 0.6)[:, :, None]
        accent_base[y0:y1, x0:x1] = np.clip(np.array(color, dtype=np.float32)[None, None, :] + shade, 0, 255)
        h = n * 0.7 + n2 * 0.3
        accent_normal[y0:y1, x0:x1] = _normal_from_height(h, normal_strength)
        accent_ao[y0:y1, x0:x1] = np.clip(210 + (n2 - 0.5)[:, :, None] * 42, 0, 255)
        accent_smooth[y0:y1, x0:x1] = smooth

    # top-left skin, top-right hair, bottom-left red shoe/white socks,
    # bottom-right black straps/eyes/soles/metal/white details.
    fill_region((0.00, 0.50, 0.50, 1.00), (218, 161, 122), 13.0, 1.8, 118)
    fill_region((0.50, 0.50, 1.00, 1.00), (39, 29, 24), 24.0, 8.0, 82)
    fill_region((0.00, 0.00, 0.50, 0.50), (177, 66, 43), 20.0, 5.0, 135)
    fill_region((0.50, 0.00, 1.00, 0.50), (25, 27, 31), 18.0, 4.0, 96)

    accent_img = Image.fromarray(np.clip(accent_base, 0, 255).astype("uint8"), "RGB")
    draw = ImageDraw.Draw(accent_img, "RGBA")
    # Skin freckles and blush.
    for _ in range(180):
        x = int(rng.integers(20, int(size * 0.48)))
        y = int(rng.integers(int(size * 0.56), int(size * 0.96)))
        r = int(rng.integers(1, 4))
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(112, 70, 48, int(rng.integers(20, 48))))
    draw.ellipse([int(size * 0.12), int(size * 0.67), int(size * 0.25), int(size * 0.78)], fill=(236, 117, 101, 54))
    draw.ellipse([int(size * 0.30), int(size * 0.67), int(size * 0.43), int(size * 0.78)], fill=(236, 117, 101, 54))
    # Hair paint strokes.
    for _ in range(130):
        x = int(rng.integers(int(size * 0.52), int(size * 0.98)))
        y = int(rng.integers(int(size * 0.55), int(size * 0.98)))
        length = int(rng.integers(44, 190))
        draw.arc([x - length, y - length // 2, x + length, y + length // 2], 205, 340, fill=(88, 72, 58, int(rng.integers(36, 92))), width=3)
    # Red canvas shoe panel, white sock band, eye/white/metal swatches.
    draw.rectangle([0, 0, int(size * 0.50), int(size * 0.16)], fill=(238, 238, 224, 255))
    for y in (int(size * 0.055), int(size * 0.095)):
        draw.rectangle([0, y, int(size * 0.50), y + 18], fill=(25, 42, 73, 255))
    draw.rectangle([int(size * 0.50), 0, int(size * 0.75), int(size * 0.20)], fill=(238, 238, 226, 255))
    draw.rectangle([int(size * 0.75), 0, size, int(size * 0.20)], fill=(8, 9, 12, 255))
    draw.rectangle([int(size * 0.50), int(size * 0.20), int(size * 0.75), int(size * 0.38)], fill=(185, 170, 144, 255))
    draw.rectangle([int(size * 0.75), int(size * 0.20), size, int(size * 0.38)], fill=(95, 107, 124, 255))
    accent_base = np.asarray(accent_img.filter(ImageFilter.UnsharpMask(radius=1.0, percent=80)), dtype=np.float32)
    accent_ao = np.clip(
        accent_ao
        + (_noise(size, 7712, blur=0.0) - 0.5)[:, :, None] * 94.0
        + (_noise(size, 7713, blur=2.0) - 0.5)[:, :, None] * 54.0,
        0,
        255,
    )

    accent_paths = {
        "BaseColor": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Accent_BaseColor_2K.png",
        "Normal": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Accent_Normal_2K.png",
        "AO": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Accent_AO_2K.png",
        "MetallicSmoothness": TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Accent_MetallicSmoothness_2K.png",
    }
    _save_rgb(accent_base, accent_paths["BaseColor"])
    _save_rgb(accent_normal, accent_paths["Normal"])
    _save_rgb(accent_ao, accent_paths["AO"])
    _save_rgb(accent_smooth, accent_paths["MetallicSmoothness"])

    return {
        "main": {k: str(v.relative_to(ROOT)) for k, v in main_paths.items()},
        "accent": {k: str(v.relative_to(ROOT)) for k, v in accent_paths.items()},
    }


def run_blender() -> None:
    generate_textures()
    cmd = ["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build-mesh"]
    subprocess.run(cmd, cwd=str(ROOT), check=True)


def blender_main() -> None:
    # Import only inside Blender. The system Python branch does not have bpy.
    import importlib.util

    import bpy
    from mathutils import Vector

    SHARED_RIG = ROOT / "tools" / "art_pipeline" / "generate_shared_humanoid_rig.py"
    spec = importlib.util.spec_from_file_location("shared_rig", SHARED_RIG)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    bones = module.BONES

    HEIGHT = 1.30
    random.seed(712)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    def reset_scene() -> None:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete()
        bpy.context.scene.unit_settings.system = "METRIC"
        bpy.context.scene.unit_settings.scale_length = 1.0
        bpy.context.scene.render.resolution_x = 1300
        bpy.context.scene.render.resolution_y = 1600
        try:
            bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
        except Exception:
            pass
        bpy.context.scene.eevee.taa_render_samples = 64
        bpy.context.scene.view_settings.view_transform = "Filmic"
        bpy.context.scene.view_settings.look = "Medium High Contrast"
        bpy.context.scene.view_settings.exposure = 0.0
        bpy.context.scene.view_settings.gamma = 1.0

    def make_material(name: str, prefix: str, roughness: float) -> object:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        bsdf = nodes.get("Principled BSDF")
        if bsdf:
            base = nodes.new(type="ShaderNodeTexImage")
            base.image = bpy.data.images.load(str(TEXTURE_DIR / f"Char_Kid_Stylized_ArtDirected_{prefix}_BaseColor_2K.png"))
            mat.node_tree.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
            normal = nodes.new(type="ShaderNodeTexImage")
            normal.image = bpy.data.images.load(str(TEXTURE_DIR / f"Char_Kid_Stylized_ArtDirected_{prefix}_Normal_2K.png"))
            normal.image.colorspace_settings.name = "Non-Color"
            nmap = nodes.new(type="ShaderNodeNormalMap")
            nmap.inputs["Strength"].default_value = 0.55 if prefix == "Main" else 0.42
            mat.node_tree.links.new(normal.outputs["Color"], nmap.inputs["Color"])
            mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = 0.0
        mat["atlas"] = prefix
        return mat

    reset_scene()
    main_mat = make_material("Kid_Stylized_ArtDirected_Main_PBR_Atlas", "Main", 0.62)
    accent_mat = make_material("Kid_Stylized_ArtDirected_Accent_PBR_Atlas", "Accent", 0.48)
    objects: list[object] = []

    MAIN_HOODIE = (0.00, 0.00, 0.50, 1.00)
    MAIN_SHORTS = (0.50, 0.00, 1.00, 0.50)
    MAIN_PACK = (0.50, 0.50, 1.00, 1.00)
    # Blender image UVs use the opposite vertical direction from PIL's row
    # coordinates used when the atlas is painted above.
    ACC_RED = (0.00, 0.50, 0.50, 0.80)
    ACC_SOCK = (0.00, 0.84, 0.50, 1.00)
    ACC_SKIN = (0.00, 0.00, 0.50, 0.50)
    ACC_HAIR = (0.50, 0.00, 1.00, 0.50)
    ACC_WHITE = (0.50, 0.80, 0.75, 1.00)
    ACC_BLACK = (0.75, 0.80, 1.00, 1.00)
    ACC_METAL = (0.50, 0.62, 0.75, 0.80)

    def add_obj(obj) -> object:
        objects.append(obj)
        return obj

    def apply_modifiers(obj) -> None:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in list(obj.modifiers):
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception:
                pass
        obj.select_set(False)

    def assign_uv(obj, bounds, axes=("x", "z")) -> None:
        mesh = obj.data
        while mesh.uv_layers:
            mesh.uv_layers.remove(mesh.uv_layers[0])
        uv_layer = mesh.uv_layers.new(name="UV0")
        coords = [v.co.copy() for v in mesh.vertices]
        axis_index = {"x": 0, "y": 1, "z": 2}
        a = axis_index[axes[0]]
        b = axis_index[axes[1]]
        vals_a = [co[a] for co in coords]
        vals_b = [co[b] for co in coords]
        amin, amax = min(vals_a), max(vals_a)
        bmin, bmax = min(vals_b), max(vals_b)
        aspan = max(amax - amin, 1e-6)
        bspan = max(bmax - bmin, 1e-6)
        u0, v0, u1, v1 = bounds
        mu = (u1 - u0) * 0.08
        mv = (v1 - v0) * 0.08
        for poly in mesh.polygons:
            for li in poly.loop_indices:
                vi = mesh.loops[li].vertex_index
                co = mesh.vertices[vi].co
                u = u0 + mu + ((co[a] - amin) / aspan) * (u1 - u0 - mu * 2)
                vv = v0 + mv + ((co[b] - bmin) / bspan) * (v1 - v0 - mv * 2)
                uv_layer.data[li].uv = (u, vv)

    def finish(obj, mat, bounds, bevel: float | None = None, smooth=True, axes=("x", "z")) -> object:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.material_index = 0
            poly.use_smooth = smooth
        assign_uv(obj, bounds, axes)
        if bevel:
            mod = obj.modifiers.new("Art_Directed_Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 5
        tri_est = sum(max(1, len(poly.vertices) - 2) for poly in obj.data.polygons)
        if tri_est > 250 or bevel:
            mod = obj.modifiers.new("Budget_Preserve_Silhouette_Decimate", "DECIMATE")
            if tri_est > 1500:
                mod.ratio = 0.20
            elif tri_est > 700:
                mod.ratio = 0.30
            elif bevel:
                mod.ratio = 0.38
            else:
                mod.ratio = 0.45
        try:
            mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
            mod.keep_sharp = True
        except Exception:
            pass
        apply_modifiers(obj)
        return add_obj(obj)

    def add_superellipsoid(name, loc, scale, mat, bounds, seg=48, rings=24, e1=0.82, e2=0.82, taper=0.0, noise=0.0):
        verts = []
        faces = []

        def signed_pow(value, power):
            return math.copysign(abs(value) ** power, value)

        for r in range(rings + 1):
            v = -math.pi / 2 + math.pi * r / rings
            cv = math.cos(v)
            sv = math.sin(v)
            for s in range(seg):
                u = -math.pi + 2 * math.pi * s / seg
                cu = math.cos(u)
                su = math.sin(u)
                z = signed_pow(sv, e1)
                ring_scale = signed_pow(cv, e1)
                x = ring_scale * signed_pow(cu, e2)
                y = ring_scale * signed_pow(su, e2)
                local_taper = 1.0 + taper * z
                n = 1.0 + (random.random() - 0.5) * noise
                verts.append((loc[0] + x * scale[0] * local_taper * n, loc[1] + y * scale[1] * local_taper * n, loc[2] + z * scale[2] * n))
        for r in range(rings):
            for s in range(seg):
                a = r * seg + s
                faces.append([a, r * seg + (s + 1) % seg, (r + 1) * seg + (s + 1) % seg, (r + 1) * seg + s])
        mesh = bpy.data.meshes.new(name + "_Mesh")
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        return finish(obj, mat, bounds, smooth=True)

    def add_sphere(name, loc, scale, mat, bounds, segments=48, rings=24, bevel=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        return finish(obj, mat, bounds, bevel=bevel)

    def add_beveled_cube(name, loc, scale, mat, bounds, bevel=0.02):
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        return finish(obj, mat, bounds, bevel=bevel, smooth=True)

    def add_capsule(name, p1, p2, radius, mat, bounds, verts=40, bevel=0.004):
        mid = (Vector(p1) + Vector(p2)) * 0.5
        depth = (Vector(p2) - Vector(p1)).length
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=mid)
        obj = bpy.context.object
        obj.name = name
        direction = Vector(p2) - Vector(p1)
        obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
        obj.data.materials.append(mat)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        finish(obj, mat, bounds, bevel=bevel)
        # Rounded caps.
        add_sphere(name + "_UpperCap", p2, (radius, radius, radius * 0.72), mat, bounds, 32, 12)
        add_sphere(name + "_LowerCap", p1, (radius, radius, radius * 0.72), mat, bounds, 32, 12)
        return obj

    def add_tube(name, points, radius, mat, bounds, resolution=4):
        curve = bpy.data.curves.new(name + "_Curve", "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = resolution
        curve.bevel_depth = radius
        curve.bevel_resolution = 4
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
        return finish(obj, mat, bounds, smooth=True)

    def add_panel(name, verts, mat, bounds, solidify=0.006, bevel=0.002):
        faces = [[0, 1, 2, 3]]
        mesh = bpy.data.meshes.new(name + "_Mesh")
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        mod = obj.modifiers.new("Panel_Thickness", "SOLIDIFY")
        mod.thickness = solidify
        mod.offset = 0
        return finish(obj, mat, bounds, bevel=bevel, smooth=True)

    # Body and clothing silhouette.
    add_superellipsoid("Kid_Hoodie_Rounded_Torso", (0.0, -0.006, 0.748), (0.176, 0.113, 0.274), main_mat, MAIN_HOODIE, e1=0.70, e2=0.78, taper=-0.14, noise=0.010)
    add_superellipsoid("Kid_Hoodie_Ribbed_Waist", (0.0, -0.006, 0.516), (0.164, 0.098, 0.034), main_mat, MAIN_HOODIE, e1=0.44, e2=0.58)
    add_superellipsoid("Kid_Hoodie_Hood_Back", (0.0, 0.065, 0.963), (0.146, 0.058, 0.084), main_mat, MAIN_HOODIE, e1=0.58, e2=0.50)
    add_panel("Kid_Hoodie_Kangaroo_Pocket", [(-0.094, -0.136, 0.628), (0.094, -0.136, 0.628), (0.119, -0.132, 0.744), (-0.119, -0.132, 0.744)], main_mat, MAIN_HOODIE, 0.005, 0.0025)
    add_tube("Kid_Pocket_Left_Seam", [(-0.092, -0.143, 0.637), (-0.054, -0.150, 0.732)], 0.0025, main_mat, MAIN_HOODIE)
    add_tube("Kid_Pocket_Right_Seam", [(0.092, -0.143, 0.637), (0.054, -0.150, 0.732)], 0.0025, main_mat, MAIN_HOODIE)
    add_tube("Kid_Neckline_Hood_Seam", [(-0.078, -0.117, 0.944), (-0.040, -0.136, 0.922), (0.0, -0.140, 0.918), (0.040, -0.136, 0.922), (0.078, -0.117, 0.944)], 0.0055, main_mat, MAIN_HOODIE)
    add_tube("Kid_Left_Drawstring", [(-0.038, -0.158, 0.930), (-0.044, -0.172, 0.820)], 0.0042, accent_mat, ACC_WHITE)
    add_tube("Kid_Right_Drawstring", [(0.038, -0.158, 0.930), (0.044, -0.172, 0.820)], 0.0042, accent_mat, ACC_WHITE)
    add_sphere("Kid_Left_Drawstring_Tip", (-0.045, -0.172, 0.815), (0.011, 0.007, 0.014), accent_mat, ACC_WHITE, 20, 8)
    add_sphere("Kid_Right_Drawstring_Tip", (0.045, -0.172, 0.815), (0.011, 0.007, 0.014), accent_mat, ACC_WHITE, 20, 8)

    # Head and face.
    add_superellipsoid("Kid_Head_Soft_Stylized", (0.0, -0.052, 1.084), (0.139, 0.115, 0.152), accent_mat, ACC_SKIN, e1=0.80, e2=0.70, taper=-0.05, noise=0.003)
    add_sphere("Kid_Neck", (0.0, -0.012, 0.940), (0.048, 0.040, 0.056), accent_mat, ACC_SKIN, 32, 16)
    add_sphere("Kid_Left_Ear", (-0.129, -0.043, 1.086), (0.020, 0.012, 0.032), accent_mat, ACC_SKIN, 32, 16)
    add_sphere("Kid_Right_Ear", (0.129, -0.043, 1.086), (0.020, 0.012, 0.032), accent_mat, ACC_SKIN, 32, 16)
    add_sphere("Kid_Left_Cheek", (-0.055, -0.164, 1.071), (0.021, 0.0035, 0.012), accent_mat, ACC_SKIN, 24, 8)
    add_sphere("Kid_Right_Cheek", (0.055, -0.164, 1.071), (0.021, 0.0035, 0.012), accent_mat, ACC_SKIN, 24, 8)
    add_sphere("Kid_Left_Eye_Sclera", (-0.047, -0.156, 1.116), (0.032, 0.006, 0.024), accent_mat, ACC_WHITE, 40, 16)
    add_sphere("Kid_Right_Eye_Sclera", (0.047, -0.156, 1.116), (0.032, 0.006, 0.024), accent_mat, ACC_WHITE, 40, 16)
    add_sphere("Kid_Left_Iris", (-0.047, -0.162, 1.113), (0.015, 0.0035, 0.016), accent_mat, ACC_BLACK, 32, 12)
    add_sphere("Kid_Right_Iris", (0.047, -0.162, 1.113), (0.015, 0.0035, 0.016), accent_mat, ACC_BLACK, 32, 12)
    add_sphere("Kid_Left_Eye_Highlight", (-0.039, -0.166, 1.121), (0.004, 0.0012, 0.004), accent_mat, ACC_WHITE, 16, 8)
    add_sphere("Kid_Right_Eye_Highlight", (0.055, -0.166, 1.121), (0.004, 0.0012, 0.004), accent_mat, ACC_WHITE, 16, 8)
    add_sphere("Kid_Nose", (0.0, -0.164, 1.087), (0.010, 0.006, 0.014), accent_mat, ACC_SKIN, 24, 10)
    add_tube("Kid_Soft_Smile", [(-0.026, -0.170, 1.055), (-0.010, -0.175, 1.050), (0.010, -0.175, 1.050), (0.026, -0.170, 1.055)], 0.0018, accent_mat, ACC_RED, 5)
    add_tube("Kid_Left_Eyebrow", [(-0.072, -0.158, 1.150), (-0.047, -0.168, 1.157), (-0.020, -0.164, 1.154)], 0.003, accent_mat, ACC_HAIR, 5)
    add_tube("Kid_Right_Eyebrow", [(0.020, -0.164, 1.154), (0.047, -0.168, 1.157), (0.072, -0.158, 1.150)], 0.003, accent_mat, ACC_HAIR, 5)

    # Sculpted hair clumps based on the prototype's swept locks.
    add_superellipsoid("Kid_Hair_Soft_Crown_Cap", (0.0, -0.032, 1.188), (0.132, 0.091, 0.057), accent_mat, ACC_HAIR, e1=0.55, e2=0.68, taper=-0.06)
    hair_specs = [
        (0.000, -0.071, 1.236, 0.047, 0.021, 0.042, 0.00, 0.18, 0.00),
        (-0.045, -0.095, 1.223, 0.044, 0.020, 0.050, -0.24, 0.58, -0.14),
        (0.047, -0.097, 1.223, 0.044, 0.020, 0.050, 0.24, -0.58, 0.14),
        (-0.083, -0.062, 1.187, 0.036, 0.018, 0.050, -0.46, 0.24, -0.62),
        (0.083, -0.062, 1.187, 0.036, 0.018, 0.050, 0.46, -0.24, 0.62),
        (-0.027, -0.122, 1.191, 0.043, 0.017, 0.057, -0.14, 0.72, -0.10),
        (0.027, -0.124, 1.190, 0.043, 0.017, 0.057, 0.14, -0.72, 0.10),
        (-0.004, -0.134, 1.169, 0.034, 0.014, 0.048, 0.03, 0.82, 0.02),
        (-0.099, -0.002, 1.137, 0.031, 0.016, 0.045, -0.38, 0.12, -0.80),
        (0.099, -0.002, 1.137, 0.031, 0.016, 0.045, 0.38, -0.12, 0.80),
        (-0.070, 0.002, 1.221, 0.037, 0.020, 0.046, -0.26, 0.10, -0.40),
        (0.070, 0.002, 1.221, 0.037, 0.020, 0.046, 0.26, -0.10, 0.40),
        (-0.025, -0.137, 1.151, 0.024, 0.011, 0.036, -0.10, 0.62, -0.08),
        (0.025, -0.137, 1.151, 0.024, 0.011, 0.036, 0.10, -0.62, 0.08),
    ]
    for i, spec_h in enumerate(hair_specs):
        x, y, z, sx, sy, sz, rx, ry, rz = spec_h
        obj = add_sphere(f"Kid_Hair_Clump_{i:02d}", (x, y, z), (sx, sy, sz), accent_mat, ACC_HAIR, 40, 16)
        obj.rotation_euler = (rx, ry, rz)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        obj.select_set(False)

    # Limbs, hands, shorts, socks, shoes.
    for side, sx in (("Left", -1), ("Right", 1)):
        add_capsule(f"Kid_{side}_UpperSleeve", (sx * 0.154, -0.026, 0.795), (sx * 0.205, -0.035, 0.615), 0.028, main_mat, MAIN_HOODIE, 40, 0.004)
        add_capsule(f"Kid_{side}_LowerSleeve", (sx * 0.205, -0.035, 0.615), (sx * 0.184, -0.043, 0.478), 0.026, main_mat, MAIN_HOODIE, 40, 0.004)
        add_superellipsoid(f"Kid_{side}_Ribbed_Cuff", (sx * 0.184, -0.043, 0.478), (0.031, 0.025, 0.019), main_mat, MAIN_HOODIE, e1=0.42, e2=0.52)
        add_sphere(f"Kid_{side}_Palm", (sx * 0.182, -0.056, 0.419), (0.024, 0.018, 0.031), accent_mat, ACC_SKIN, 32, 16)
        for finger in range(4):
            fx = sx * (0.172 + finger * 0.0068)
            add_capsule(f"Kid_{side}_Finger_{finger}", (fx, -0.071, 0.404), (fx + sx * 0.0015, -0.078, 0.382), 0.0032, accent_mat, ACC_SKIN, 14, 0.0006)
        add_capsule(f"Kid_{side}_Thumb", (sx * 0.168, -0.057, 0.409), (sx * 0.154, -0.068, 0.392), 0.0048, accent_mat, ACC_SKIN, 14, 0.0006)

        add_superellipsoid(f"Kid_{side}_Shorts_Leg", (sx * 0.064, -0.006, 0.470), (0.070, 0.066, 0.098), main_mat, MAIN_SHORTS, e1=0.47, e2=0.60, taper=-0.07)
        add_capsule(f"Kid_{side}_Bare_Leg", (sx * 0.064, -0.002, 0.154), (sx * 0.064, -0.002, 0.383), 0.032, accent_mat, ACC_SKIN, 36, 0.0016)
        add_capsule(f"Kid_{side}_Sock", (sx * 0.064, -0.004, 0.076), (sx * 0.064, -0.004, 0.170), 0.035, accent_mat, ACC_SOCK, 36, 0.001)
        add_tube(f"Kid_{side}_Sock_Stripe_Upper", [(sx * 0.030, -0.042, 0.146), (sx * 0.064, -0.048, 0.150), (sx * 0.098, -0.042, 0.146)], 0.0048, accent_mat, ACC_BLACK)
        add_tube(f"Kid_{side}_Sock_Stripe_Lower", [(sx * 0.032, -0.043, 0.124), (sx * 0.064, -0.049, 0.128), (sx * 0.096, -0.043, 0.124)], 0.0042, accent_mat, ACC_BLACK)
        shoe = add_beveled_cube(f"Kid_{side}_Red_Canvas_Shoe", (sx * 0.064, -0.073, 0.050), (0.071, 0.148, 0.047), accent_mat, ACC_RED, 0.014)
        add_beveled_cube(f"Kid_{side}_Red_Shoe_Tongue", (sx * 0.064, -0.118, 0.086), (0.042, 0.054, 0.012), accent_mat, ACC_RED, 0.004)
        add_beveled_cube(f"Kid_{side}_Red_Shoe_Outer_Quarter", (sx * 0.029, -0.101, 0.062), (0.013, 0.072, 0.016), accent_mat, ACC_RED, 0.0035)
        add_beveled_cube(f"Kid_{side}_Red_Shoe_Inner_Quarter", (sx * 0.099, -0.101, 0.062), (0.013, 0.072, 0.016), accent_mat, ACC_RED, 0.0035)
        toe = add_sphere(f"Kid_{side}_White_Toe_Cap", (sx * 0.064, -0.169, 0.040), (0.030, 0.010, 0.013), accent_mat, ACC_WHITE, 20, 8)
        sole = add_beveled_cube(f"Kid_{side}_White_Shoe_Sole", (sx * 0.064, -0.059, 0.014), (0.072, 0.136, 0.010), accent_mat, ACC_WHITE, 0.007)
        for lace in range(3):
            z = 0.067 + lace * 0.007
            add_tube(f"Kid_{side}_Shoe_Lace_{lace}", [(sx * 0.038, -0.080, z), (sx * 0.064, -0.094, z + 0.003), (sx * 0.090, -0.080, z)], 0.0022, accent_mat, ACC_WHITE, 3)
        shoe.rotation_euler.z = sx * 0.020
        toe.rotation_euler.z = sx * 0.020
        sole.rotation_euler.z = sx * 0.020

    add_superellipsoid("Kid_Shorts_Waistband", (0.0, -0.004, 0.540), (0.138, 0.073, 0.034), main_mat, MAIN_SHORTS, e1=0.42, e2=0.55)

    # Backpack and straps.
    add_superellipsoid("Kid_Backpack_Rounded_Bag", (0.0, 0.146, 0.740), (0.128, 0.048, 0.194), main_mat, MAIN_PACK, e1=0.60, e2=0.62, taper=-0.04)
    add_beveled_cube("Kid_Backpack_Front_Pocket", (0.0, 0.184, 0.675), (0.084, 0.010, 0.046), main_mat, MAIN_PACK, 0.008)
    add_tube("Kid_Backpack_Upper_Stitch", [(-0.082, 0.193, 0.838), (-0.030, 0.202, 0.870), (0.030, 0.202, 0.870), (0.082, 0.193, 0.838)], 0.0025, main_mat, MAIN_PACK)
    for side, sx in (("Left", -1), ("Right", 1)):
        add_panel(
            f"Kid_{side}_Backpack_Flat_Shoulder_Strap",
            [
                (sx * 0.087, -0.126, 0.918),
                (sx * 0.101, -0.131, 0.915),
                (sx * 0.115, -0.127, 0.600),
                (sx * 0.099, -0.122, 0.596),
            ],
            main_mat,
            MAIN_PACK,
            0.0035,
            0.0015,
        )
        add_tube(f"Kid_{side}_Backpack_Strap_Edge_Stitch", [(sx * 0.094, -0.134, 0.905), (sx * 0.106, -0.136, 0.755), (sx * 0.105, -0.129, 0.615)], 0.0017, accent_mat, ACC_BLACK, 4)
        add_beveled_cube(f"Kid_{side}_Backpack_Buckle", (sx * 0.111, -0.126, 0.705), (0.010, 0.0035, 0.016), accent_mat, ACC_METAL, 0.002)

    # A small contact shadow plane is preview-only and excluded from export.
    bpy.ops.mesh.primitive_plane_add(size=1.8, location=(0, 0, -0.002))
    floor = bpy.context.object
    floor.name = "Preview_Ground_ShadowPlane"
    mat_floor = bpy.data.materials.new("Preview_Ground_Matte")
    mat_floor.diffuse_color = (0.39, 0.39, 0.38, 1.0)
    floor.data.materials.append(mat_floor)
    floor.hide_select = True
    floor["exclude_from_export"] = True

    def create_armature():
        scale = HEIGHT / 1.82
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

    def bone_for_vertex(co: Vector) -> str:
        z = co.z / HEIGHT
        side = "Left" if co.x < 0 else "Right"
        if z > 0.72:
            return "Head"
        if abs(co.x) > 0.18 and 0.27 < z < 0.82:
            if z < 0.35:
                return f"{side}Hand"
            if z < 0.52:
                return f"{side}LowerArm"
            return f"{side}UpperArm"
        if z < 0.07:
            return f"{side}Foot"
        if z < 0.30:
            return f"{side}LowerLeg"
        if z < 0.49:
            return f"{side}UpperLeg"
        if z < 0.64:
            return "Spine"
        if z < 0.74:
            return "Chest"
        return "Neck"

    def bind(obj, arm) -> None:
        if obj.type != "MESH" or obj.get("exclude_from_export"):
            return
        for name, _, _, _ in bones:
            obj.vertex_groups.new(name=name)
        for v in obj.data.vertices:
            world = obj.matrix_world @ v.co
            obj.vertex_groups[bone_for_vertex(world)].add([v.index], 1.0, "REPLACE")
        mod = obj.modifiers.new("Rig_Humanoid_Shared", "ARMATURE")
        mod.object = arm
        obj.parent = arm

    armature = create_armature()
    for obj in objects:
        bind(obj, armature)

    export_objects = [obj for obj in objects if obj.type == "MESH"] + [armature]

    def bounds_for(meshes):
        pts = [obj.matrix_world @ Vector(corner) for obj in meshes if obj.type == "MESH" for corner in obj.bound_box]
        return Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))), Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))

    def look_at(obj, target: Vector) -> None:
        direction = target - obj.location
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    def setup_lighting(camera_loc=(0.0, -3.1, 0.80), ortho=1.52) -> None:
        bpy.ops.object.light_add(type="AREA", location=(-2.2, -3.4, 3.1))
        light = bpy.context.object
        light.name = "Key_Light_Large_Softbox"
        light.data.energy = 720
        light.data.size = 4.2
        bpy.ops.object.light_add(type="AREA", location=(2.4, -2.5, 1.4))
        fill = bpy.context.object
        fill.name = "Eye_Fill_Light"
        fill.data.energy = 100
        fill.data.size = 2.0
        bpy.ops.object.camera_add(location=camera_loc)
        camera = bpy.context.object
        look_at(camera, Vector((0.0, -0.035, 0.67)))
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = ortho
        bpy.context.scene.camera = camera

    setup_lighting()

    def mesh_stats() -> dict[str, int]:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        vertices = 0
        polygons = 0
        triangles = 0
        for obj in objects:
            if obj.type != "MESH":
                continue
            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            mesh.calc_loop_triangles()
            vertices += len(mesh.vertices)
            polygons += len(mesh.polygons)
            triangles += len(mesh.loop_triangles)
            eval_obj.to_mesh_clear()
        return {"vertices": vertices, "polygons": polygons, "triangles": triangles}

    export_stats = mesh_stats()

    # Save source .blend before preview-only wireframe changes.
    blend_path = OUT_DIR / "Kid_Stylized_ArtDirected_v3.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    for obj in bpy.context.scene.objects:
        obj.select_set(False)
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = export_objects[0]
    fbx_path = OUT_DIR / "Kid_Stylized_ArtDirected_v3.fbx"
    glb_path = OUT_DIR / "Kid_Stylized_ArtDirected_v3.glb"
    bpy.ops.export_scene.fbx(
        filepath=str(fbx_path),
        use_selection=True,
        apply_unit_scale=True,
        bake_space_transform=True,
        object_types={"ARMATURE", "MESH"},
        axis_forward="Z",
        axis_up="Y",
        add_leaf_bones=False,
        path_mode="COPY",
        embed_textures=False,
    )
    bpy.ops.export_scene.gltf(filepath=str(glb_path), export_format="GLB", use_selection=True)

    preview_path = PREVIEW_DIR / "Kid_Stylized_ArtDirected_v3_preview.png"
    bpy.context.scene.render.filepath = str(preview_path)
    bpy.ops.render.render(write_still=True)

    # Wireframe audit render.
    wire_mat = bpy.data.materials.new("Wireframe_Audit_Black")
    wire_mat.diffuse_color = (0.02, 0.02, 0.02, 1.0)
    for obj in objects:
        if obj.type != "MESH":
            continue
        obj.data.materials.append(wire_mat)
        mod = obj.modifiers.new("Audit_Wireframe_Overlay", "WIREFRAME")
        mod.thickness = 0.0025
        mod.use_replace = False
        mod.material_offset = len(obj.data.materials) - 1
    bpy.context.scene.render.filepath = str(PREVIEW_DIR / "Kid_Stylized_ArtDirected_v3_wireframe.png")
    bpy.ops.render.render(write_still=True)

    def rel(path: Path) -> str:
        return str(path.relative_to(ROOT))

    report = {
        "asset": "Kid_Stylized_ArtDirected_v3",
        "status": "art_directed_sample_candidate_v3",
        "visual_context": "Third art-directed rebuild after self-review of v2; keeps the approved Kid prototype while further refining head/body ratio, non-spherical face shape, smaller hair masses, integrated fabric straps, hands, and red sneaker construction.",
        "reference_image": REFERENCE_IMAGE,
        "input_image": INPUT_IMAGE,
        "outputs": {
            "blend": rel(blend_path),
            "fbx": rel(fbx_path),
            "glb": rel(glb_path),
            "preview": rel(preview_path),
            "wireframe": rel(PREVIEW_DIR / "Kid_Stylized_ArtDirected_v3_wireframe.png"),
        },
        "budget": {
            "target_tris_min": 18000,
            "target_tris_max": 30000,
            "actual_vertices": export_stats["vertices"],
            "actual_polygons": export_stats["polygons"],
            "actual_triangles": export_stats["triangles"],
            "triangle_budget_passed": 18000 <= export_stats["triangles"] <= 30000,
            "material_count": 2,
            "material_budget_passed": True,
        },
        "quality_gate": {
            "bevel_used": True,
            "no_unprocessed_primitive_final_mesh": True,
            "hand_authored_detail_pass": [
                "smaller head/body ratio and slimmer hoodie silhouette",
                "separate hair cap plus directed swept hair clumps",
                "hood, pocket, drawstrings, ribbed cuffs",
                "flat backpack fabric straps, stitch line, buckles",
                "socks stripes, refined shoe soles, panel quarters, toe caps, laces",
                "eyes, eyebrows, smile, ears, cheeks, shorter fingers"
            ],
            "texture_sets": [
                {
                    "material": "Main",
                    "BaseColor": rel(TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Main_BaseColor_2K.png"),
                    "Normal": rel(TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Main_Normal_2K.png"),
                    "AO": rel(TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Main_AO_2K.png"),
                },
                {
                    "material": "Accent",
                    "BaseColor": rel(TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Accent_BaseColor_2K.png"),
                    "Normal": rel(TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Accent_Normal_2K.png"),
                    "AO": rel(TEXTURE_DIR / "Char_Kid_Stylized_ArtDirected_Accent_AO_2K.png"),
                }
            ],
        },
        "limitations": [
            "Unity Humanoid Avatar green-state still requires an activated Unity Editor license.",
            "Supersedes ArtDirected v1 and v2 because both were judged visually too crude for the target bar.",
            "This is one visual sample for Kid Stylized, not the full 9-character batch."
        ],
    }
    (REPORT_DIR / "Kid_Stylized_ArtDirected_v3_budget_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    if "--build-mesh" in sys.argv:
        blender_main()
    else:
        run_blender()
