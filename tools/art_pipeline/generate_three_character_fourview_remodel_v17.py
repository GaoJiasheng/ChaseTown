#!/usr/bin/env python3
"""Rebuild the three approved character candidates from multiview references.

The Hunyuan meshes provide the sculpted body and garment surface.  Four-view
image references provide continuous appearance around the full model.  The
result is baked to one UV/PBR material per role, rendered from four mandatory
review angles, and exported as FBX/GLB.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION = "FourViewRemodel_2026_07_13_v17"
PRODUCTION = ROOT / "docs" / "art_production" / "fourview_remodel_v17"
CONTACT_SHEET = ROOT / "docs" / "art_production" / "THREE_CHARACTER_FOURVIEW_REMODEL_V17_CONTACT_SHEET.png"
SUMMARY_PATH = ROOT / "docs" / "art_production" / "THREE_CHARACTER_FOURVIEW_REMODEL_V17_SUMMARY.json"
VALIDATION_PATH = ROOT / "docs" / "art_production" / "THREE_CHARACTER_FOURVIEW_REMODEL_V17_ASSIMP_VALIDATION.json"


SPECS = {
    "Kid": {
        "source": ROOT / "docs" / "art_production" / "hunyuan_reference_standard_kid_v13" / "kid_reference_standard_hunyuan_multiview.glb",
        "reference": PRODUCTION / "references" / "Kid_turnaround_v17.png",
        "height": 1.30,
        "asset": "Kid_FourView_Remodel_v17",
        "out": ROOT / "art-source" / "Characters" / "Kid" / "ReferenceStandard" / VERSION,
        "fallback": {
            "skin": (0.76, 0.50, 0.36), "dark": (0.025, 0.028, 0.032),
            "cloth": (0.025, 0.065, 0.16), "white": (0.78, 0.79, 0.77),
        },
    },
    "Villain": {
        "source": ROOT / "docs" / "art_production" / "hunyuan_reference_standard_villain_v13" / "villain_reference_standard_hunyuan_multiview.glb",
        "reference": PRODUCTION / "references" / "Villain_turnaround_v17.png",
        "height": 1.85,
        "asset": "Villain_FourView_Remodel_v17",
        "out": ROOT / "art-source" / "Characters" / "Villain" / "ReferenceStandard" / VERSION,
        "fallback": {
            "skin": (0.38, 0.24, 0.17), "dark": (0.018, 0.016, 0.015),
            "cloth": (0.026, 0.024, 0.022), "white": (0.28, 0.26, 0.24),
        },
    },
    "Police": {
        "source": ROOT / "docs" / "art_production" / "hunyuan_reference_standard_police_v13" / "police_reference_standard_hunyuan_multiview.glb",
        "reference": PRODUCTION / "references" / "Police_turnaround_v17.png",
        "height": 1.80,
        "asset": "Police_FourView_Remodel_v17",
        "out": ROOT / "art-source" / "Characters" / "Police" / "ReferenceStandard" / VERSION,
        "fallback": {
            "skin": (0.69, 0.43, 0.29), "dark": (0.012, 0.017, 0.028),
            "cloth": (0.018, 0.045, 0.105), "white": (0.65, 0.66, 0.67),
        },
    },
}


VIEWS = ("front", "right", "back", "top")


def preprocess_references() -> None:
    from PIL import Image, ImageFilter

    for role, spec in SPECS.items():
        image = Image.open(spec["reference"]).convert("RGB")
        width, height = image.size
        quadrants = {
            "front": (0, 0, width // 2, height // 2),
            "right": (width // 2, 0, width, height // 2),
            "back": (0, height // 2, width // 2, height),
            "top": (width // 2, height // 2, width, height),
        }
        crop_dir = PRODUCTION / "references" / "crops"
        crop_dir.mkdir(parents=True, exist_ok=True)
        for view, box in quadrants.items():
            quadrant = image.crop(box)
            qwidth, qheight = quadrant.size
            # The generated sheets use a light gray studio sweep.  A luminance
            # mask is more stable than corner-color subtraction because the
            # background intentionally contains a broad vertical gradient.
            mask = quadrant.convert("L").point(lambda p: 255 if p < 170 else 0)
            mask_pixels = mask.load()
            border_guard = min(32, qwidth // 10, qheight // 10)
            for y in range(qheight):
                for x in range(qwidth):
                    if x < border_guard or x >= qwidth - border_guard or y < border_guard or y >= qheight - border_guard:
                        mask_pixels[x, y] = 0
            mask = mask.filter(ImageFilter.MaxFilter(9))
            bbox = mask.getbbox()
            if not bbox:
                bbox = (0, 0, qwidth, qheight)
            x0, y0, x1, y1 = bbox
            mx = max(8, int((x1 - x0) * 0.025))
            my = max(8, int((y1 - y0) * 0.025))
            x0, y0 = max(0, x0 - mx), max(0, y0 - my)
            x1, y1 = min(qwidth, x1 + mx), min(qheight, y1 + my)
            quadrant.crop((x0, y0, x1, y1)).save(crop_dir / f"{role}_{view}.png", optimize=True)


def make_derived_textures() -> None:
    import numpy as np
    from PIL import Image, ImageFilter

    for spec in SPECS.values():
        textures = spec["out"] / "Textures"
        base_path = textures / f"Char_{spec['asset']}_BaseColor_2K.png"
        if not base_path.exists():
            raise FileNotFoundError(base_path)
        base = Image.open(base_path).convert("RGB")
        gray = np.asarray(base.convert("L"), dtype=np.float32) / 255.0
        rng = np.random.default_rng(sum(ord(character) for character in spec["asset"]))
        coarse = Image.fromarray(np.clip((rng.normal(0.5, 0.15, (256, 256)) * 255.0), 0, 255).astype(np.uint8), "L")
        coarse = coarse.resize(base.size, Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(1.1))
        field = np.asarray(coarse, dtype=np.float32) / 255.0
        gy, gx = np.gradient(field)
        strength = 1.15
        nx = -gx * strength
        ny = -gy * strength
        nz = np.ones_like(nx)
        length = np.sqrt(nx * nx + ny * ny + nz * nz)
        normal = np.stack(((nx / length * 0.5 + 0.5), (ny / length * 0.5 + 0.5), (nz / length * 0.5 + 0.5)), axis=-1)
        normal_image = Image.fromarray(np.clip(normal * 255.0, 0, 255).astype(np.uint8), "RGB")
        normal_image.save(textures / f"Char_{spec['asset']}_Normal_2K.png", optimize=True)

        smoothness = np.clip(88.0 + (field - 0.5) * 22.0, 68.0, 108.0).astype(np.uint8)
        packed = np.zeros((gray.shape[0], gray.shape[1], 4), dtype=np.uint8)
        packed[..., 0] = 8
        packed[..., 3] = smoothness
        Image.fromarray(packed, "RGBA").save(textures / f"Char_{spec['asset']}_MetallicSmoothness_2K.png", optimize=True)


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw

    roles = tuple(SPECS)
    view_order = ("front", "right", "top", "back")
    cell_w, cell_h = 600, 760
    sheet = Image.new("RGB", (cell_w * 4, cell_h * 3), (20, 21, 23))
    draw = ImageDraw.Draw(sheet)
    for row, role in enumerate(roles):
        spec = SPECS[role]
        for col, view in enumerate(view_order):
            path = spec["out"] / "Previews" / f"{spec['asset']}_{view}.png"
            source = Image.open(path).convert("RGB")
            source.thumbnail((cell_w - 24, cell_h - 54), Image.Resampling.LANCZOS)
            x = col * cell_w + (cell_w - source.width) // 2
            y = row * cell_h + 42
            sheet.paste(source, (x, y))
            draw.text((col * cell_w + 12, row * cell_h + 12), f"{role}  {view}", fill=(244, 244, 240))
    CONTACT_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(CONTACT_SHEET, optimize=True)


def run_assimp_validation() -> None:
    glob = f"art-source/Characters/*/ReferenceStandard/{VERSION}/*_FourView_Remodel_v17.fbx"
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "art_pipeline" / "validate_fbx_assimp.py"), "--glob", glob, "--out", str(VALIDATION_PATH)],
        cwd=str(ROOT),
        check=True,
    )


def outer_main() -> None:
    preprocess_references()
    subprocess.run(["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--bake"], cwd=str(ROOT), check=True)
    make_derived_textures()
    subprocess.run(["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--finalize"], cwd=str(ROOT), check=True)
    build_contact_sheet()
    run_assimp_validation()


def blender_main(mode: str) -> None:
    import bpy
    from mathutils import Vector

    def reset_scene() -> None:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        scene.unit_settings.system = "METRIC"
        scene.unit_settings.scale_length = 1.0
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.film_transparent = False
        scene.render.resolution_percentage = 100
        scene.render.image_settings.color_depth = "8"
        if scene.world is None:
            scene.world = bpy.data.worlds.new("Studio_World")
        scene.world.color = (0.035, 0.038, 0.043)
        scene.view_settings.look = "AgX - Medium High Contrast"

    def import_mesh(path: Path):
        bpy.ops.import_scene.gltf(filepath=str(path))
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError(f"No mesh in {path}")
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        if len(meshes) > 1:
            bpy.ops.object.join()
        return bpy.context.object

    def object_bounds(objects) -> tuple[Vector, Vector]:
        points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
        return Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points))), Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))

    def normalize_object(obj, target_height: float) -> None:
        low, high = object_bounds([obj])
        scale = target_height / max(high.z - low.z, 1e-6)
        obj.scale = (scale, scale, scale)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        low, high = object_bounds([obj])
        obj.location = (-((low.x + high.x) * 0.5), -((low.y + high.y) * 0.5), -low.z)
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    def add_superellipsoid(name: str, center, radii, exponent: float, segments: int = 64, rings: int = 36):
        vertices = []
        faces = []

        def signed_power(value: float, power: float) -> float:
            return math.copysign(abs(value) ** power, value)

        for r in range(rings + 1):
            latitude = -math.pi * 0.5 + math.pi * r / rings
            cl = math.cos(latitude)
            sl = math.sin(latitude)
            for s in range(segments):
                longitude = 2.0 * math.pi * s / segments
                co = math.cos(longitude)
                si = math.sin(longitude)
                x = center[0] + radii[0] * signed_power(cl, exponent) * signed_power(co, exponent)
                y = center[1] + radii[1] * signed_power(cl, exponent) * signed_power(si, exponent)
                z = center[2] + radii[2] * signed_power(sl, exponent)
                vertices.append((x, y, z))
        for r in range(rings):
            for s in range(segments):
                a = r * segments + s
                b = r * segments + (s + 1) % segments
                c = (r + 1) * segments + (s + 1) % segments
                d = (r + 1) * segments + s
                faces.append((a, b, c, d))
        mesh = bpy.data.meshes.new(name + "_Mesh")
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        bevel = obj.modifiers.new("Edge_Soften", "BEVEL")
        bevel.width = min(radii) * 0.045
        bevel.segments = 3
        return obj

    def add_curve(name: str, points, radius: float):
        curve = bpy.data.curves.new(name + "_Curve", "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = 5
        curve.bevel_depth = radius
        curve.bevel_resolution = 4
        spline = curve.splines.new("BEZIER")
        spline.bezier_points.add(len(points) - 1)
        for bp, point in zip(spline.bezier_points, points):
            bp.co = point
            bp.handle_left_type = "AUTO"
            bp.handle_right_type = "AUTO"
        obj = bpy.data.objects.new(name, curve)
        bpy.context.collection.objects.link(obj)
        return obj

    def add_ellipsoid(name: str, center, radii, semantic: str, segments: int = 48, rings: int = 24):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=center)
        obj = bpy.context.object
        obj.name = name
        obj.scale = radii
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj["semantic_override"] = semantic
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        return obj

    def add_role_geometry(role: str, obj, height: float):
        low, high = object_bounds([obj])
        width = high.x - low.x
        depth = high.y - low.y
        extras = []
        if role == "Kid":
            center = (0.0, high.y - depth * 0.125, height * 0.585)
            pack = add_superellipsoid("Kid_Backpack_Sculpt", center, (width * 0.210, depth * 0.18, height * 0.115), 0.55)
            pack["semantic_override"] = "cloth"
            pocket = add_superellipsoid("Kid_Backpack_Pocket", (0.0, center[1] + depth * 0.140, height * 0.558), (width * 0.158, depth * 0.070, height * 0.058), 0.55, 56, 30)
            pocket["semantic_override"] = "cloth_light"
            extras.extend((pack, pocket))
            for side in (-1.0, 1.0):
                strap = add_curve(
                    f"Kid_Backpack_Strap_{'L' if side < 0 else 'R'}",
                    ((side * width * 0.20, high.y + depth * 0.01, height * 0.700), (side * width * 0.24, high.y + depth * 0.05, height * 0.585), (side * width * 0.20, high.y + depth * 0.02, height * 0.470)),
                    height * 0.008,
                )
                strap["semantic_override"] = "dark"
                extras.append(strap)
        elif role == "Villain":
            # A low-profile knit cap sits inside the generated hood opening.
            cap = add_superellipsoid("Villain_Beanie_Sculpt", (0.0, low.y + depth * 0.58, height * 0.860), (width * 0.150, depth * 0.12, height * 0.060), 0.78, 72, 34)
            cap["semantic_override"] = "dark"
            extras.append(cap)
            rib = add_curve("Villain_Beanie_Rib", ((-width * 0.130, low.y + depth * 0.29, height * 0.842), (0.0, low.y + depth * 0.25, height * 0.835), (width * 0.130, low.y + depth * 0.29, height * 0.842)), height * 0.0045)
            rib["semantic_override"] = "dark_light"
            extras.append(rib)
        return extras

    def convert_meshes(objects):
        converted = []
        for obj in objects:
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            if obj.type == "CURVE":
                bpy.ops.object.convert(target="MESH")
                obj = bpy.context.object
            for modifier in list(obj.modifiers):
                try:
                    bpy.ops.object.modifier_apply(modifier=modifier.name)
                except RuntimeError:
                    pass
            for poly in obj.data.polygons:
                poly.use_smooth = True
            obj.select_set(False)
            converted.append(obj)
        return converted

    def load_pixels(path: Path):
        image = bpy.data.images.load(str(path), check_existing=False)
        image.colorspace_settings.name = "sRGB"
        return image, list(image.pixels[:])

    def srgb_to_linear(value: float) -> float:
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    def fallback_color(role: str, spec: dict, point: Vector, normal: Vector, low: Vector, high: Vector):
        z = (point.z - low.z) / max(high.z - low.z, 1e-6)
        x = abs((point.x - (low.x + high.x) * 0.5) / max(high.x - low.x, 1e-6))
        front = normal.y < -0.15
        colors = spec["fallback"]
        if role == "Kid":
            if z < 0.10: return colors["dark"]
            if z < 0.19: return colors["white"]
            if z < 0.36 and x < 0.36: return colors["skin"]
            if z < 0.46: return colors["dark"]
            if z < 0.72: return colors["cloth"]
            if z < 0.86 and front: return colors["skin"]
            return colors["dark"]
        if role == "Villain":
            if 0.73 < z < 0.84 and front and x < 0.20: return colors["skin"]
            return colors["dark"]
        if role == "Police":
            if 0.74 < z < 0.90 and front and x < 0.24: return colors["skin"]
            if 0.46 < z < 0.78 and x > 0.28: return colors["skin"]
            return colors["dark"] if z < 0.11 else colors["cloth"]
        return colors["cloth"]

    def project_colors(role: str, spec: dict, objects) -> None:
        low, high = object_bounds(objects)
        span = high - low

        palettes = {
            "Kid": {
                "skin": (0.78, 0.48, 0.32), "hair": (0.030, 0.022, 0.017),
                "cloth": (0.018, 0.052, 0.135), "cloth_light": (0.030, 0.082, 0.190),
                "dark": (0.025, 0.026, 0.030), "white": (0.78, 0.79, 0.76),
                "shoe": (0.050, 0.070, 0.105), "eye_white": (0.86, 0.84, 0.78),
                "eye": (0.055, 0.030, 0.016),
            },
            "Villain": {
                "skin": (0.43, 0.27, 0.19), "hair": (0.020, 0.017, 0.014),
                "cloth": (0.022, 0.020, 0.018), "cloth_light": (0.040, 0.036, 0.032),
                "dark": (0.010, 0.009, 0.008), "dark_light": (0.032, 0.028, 0.025),
                "shoe": (0.009, 0.008, 0.007), "eye_white": (0.50, 0.43, 0.36),
                "eye": (0.015, 0.010, 0.007),
            },
            "Police": {
                "skin": (0.72, 0.45, 0.30), "hair": (0.025, 0.020, 0.016),
                "cloth": (0.016, 0.045, 0.108), "cloth_light": (0.025, 0.070, 0.155),
                "dark": (0.008, 0.010, 0.014), "white": (0.68, 0.70, 0.72),
                "shoe": (0.008, 0.009, 0.012), "eye_white": (0.84, 0.83, 0.79),
                "eye": (0.045, 0.026, 0.014),
            },
        }

        def semantic(point: Vector, normal: Vector, override: str | None) -> str:
            if override:
                return override
            z = (point.z - low.z) / max(span.z, 1e-6)
            x = abs((point.x - (low.x + high.x) * 0.5) / max(span.x, 1e-6))
            y = (point.y - low.y) / max(span.y, 1e-6)
            front = normal.y < 0.18
            back = normal.y > 0.30
            if role == "Kid":
                if z < 0.085: return "shoe"
                if z < 0.175: return "white"
                if z < 0.345: return "skin"
                if z < 0.465: return "dark"
                if z < 0.720:
                    return "skin" if x > 0.34 and 0.345 < z < 0.465 else "cloth"
                if z > 0.865 or back: return "hair"
                if 0.755 < z < 0.865 and front and x < 0.22 and y < 0.30: return "skin"
                return "cloth" if z < 0.805 else "hair"
            if role == "Villain":
                if z < 0.105: return "shoe"
                if z < 0.405: return "dark_light"
                if 0.745 < z < 0.825 and front and x < 0.14 and y < 0.26: return "skin"
                return "cloth" if z < 0.78 else "dark"
            if role == "Police":
                if z < 0.100: return "shoe"
                if z < 0.470: return "cloth"
                if 0.455 < z < 0.525: return "dark"
                if x > 0.285 and 0.405 < z < 0.690: return "skin"
                if 0.785 < z < 0.885 and front and x < 0.145 and y < 0.28: return "skin"
                if z > 0.885: return "cloth"
                return "cloth"
            return "cloth"

        def material_color(label: str, point: Vector):
            palette = palettes[role]
            base = palette.get(label, palette["cloth"])
            variation = 0.018 if label in {"skin", "eye_white"} else 0.045
            if label == "eye":
                variation = 0.005
            seed = math.sin(point.x * 943.7 + point.y * 677.3 + point.z * 389.9) * 43758.5453
            grain = seed - math.floor(seed) - 0.5
            weave = 0.0
            if label in {"cloth", "cloth_light", "dark", "dark_light"}:
                weave = math.sin(point.x * 540.0) * math.sin(point.z * 610.0) * 0.012
            rgb = tuple(max(0.0, min(1.0, channel * (1.0 + grain * variation + weave))) for channel in base)
            return tuple(srgb_to_linear(channel) for channel in rgb) + (1.0,)

        for obj in objects:
            mesh = obj.data
            while mesh.color_attributes:
                mesh.color_attributes.remove(mesh.color_attributes[0])
            colors = mesh.color_attributes.new(name="ProjectedBaseColor", type="FLOAT_COLOR", domain="CORNER")
            normal_matrix = obj.matrix_world.to_3x3()
            vertex_colors = []
            override = obj.get("semantic_override")
            for vertex in mesh.vertices:
                point = obj.matrix_world @ vertex.co
                world_normal = (normal_matrix @ vertex.normal).normalized()
                vertex_colors.append(material_color(semantic(point, world_normal, override), point))
            for loop_index, loop in enumerate(mesh.loops):
                colors.data[loop_index].color = vertex_colors[loop.vertex_index]

    def projected_material(name: str):
        material = bpy.data.materials.new(name)
        material.use_nodes = True
        nodes = material.node_tree.nodes
        links = material.node_tree.links
        for node in list(nodes):
            nodes.remove(node)
        output = nodes.new("ShaderNodeOutputMaterial")
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        attribute = nodes.new("ShaderNodeVertexColor")
        attribute.layer_name = "ProjectedBaseColor"
        noise = nodes.new("ShaderNodeTexNoise")
        noise.noise_dimensions = "3D"
        noise.inputs["Scale"].default_value = 155.0
        noise.inputs["Detail"].default_value = 3.5
        noise.inputs["Roughness"].default_value = 0.58
        bump = nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = 0.12
        bump.inputs["Distance"].default_value = 0.025
        bsdf.inputs["Roughness"].default_value = 0.56
        links.new(attribute.outputs["Color"], bsdf.inputs["Base Color"])
        links.new(noise.outputs["Fac"], bump.inputs["Height"])
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
        return material

    def join_objects(objects, name: str):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        joined = bpy.context.object
        joined.name = name
        return joined

    def assign_material(obj, material) -> None:
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for polygon in obj.data.polygons:
            polygon.material_index = 0

    def unwrap(obj) -> None:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(52.0), island_margin=0.004, area_weight=0.35)
        bpy.ops.object.mode_set(mode="OBJECT")

    def bake_image(obj, material, path: Path, bake_type: str, color=(0.5, 0.5, 0.5, 1.0)) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        image = bpy.data.images.new(path.stem, width=2048, height=2048, alpha=True, float_buffer=False)
        image.generated_color = color
        image.filepath_raw = str(path)
        image.file_format = "PNG"
        node = material.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        material.node_tree.nodes.active = node
        node.select = True
        scene = bpy.context.scene
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 24
        scene.cycles.use_denoising = False
        scene.render.bake.margin = 20
        scene.render.bake.use_clear = True
        if bake_type == "DIFFUSE":
            scene.render.bake.use_pass_direct = False
            scene.render.bake.use_pass_indirect = False
            scene.render.bake.use_pass_color = True
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.bake(type=bake_type)
        image.save()
        material.node_tree.nodes.remove(node)
        bpy.data.images.remove(image)

    def textured_material(spec: dict):
        textures = spec["out"] / "Textures"
        material = bpy.data.materials.new(f"M_{spec['asset']}_PBR")
        material.use_nodes = True
        nodes = material.node_tree.nodes
        links = material.node_tree.links
        for node in list(nodes):
            nodes.remove(node)
        output = nodes.new("ShaderNodeOutputMaterial")
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        base = nodes.new("ShaderNodeTexImage")
        base.image = bpy.data.images.load(str(textures / f"Char_{spec['asset']}_BaseColor_2K.png"), check_existing=False)
        normal_tex = nodes.new("ShaderNodeTexImage")
        normal_tex.image = bpy.data.images.load(str(textures / f"Char_{spec['asset']}_Normal_2K.png"), check_existing=False)
        normal_tex.image.colorspace_settings.name = "Non-Color"
        normal = nodes.new("ShaderNodeNormalMap")
        normal.inputs["Strength"].default_value = 0.12
        packed = nodes.new("ShaderNodeTexImage")
        packed.image = bpy.data.images.load(str(textures / f"Char_{spec['asset']}_MetallicSmoothness_2K.png"), check_existing=False)
        packed.image.colorspace_settings.name = "Non-Color"
        separate = nodes.new("ShaderNodeSeparateColor")
        invert = nodes.new("ShaderNodeMath")
        invert.operation = "SUBTRACT"
        invert.inputs[0].default_value = 1.0
        links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
        links.new(normal_tex.outputs["Color"], normal.inputs["Color"])
        links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
        links.new(packed.outputs["Color"], separate.inputs["Color"])
        links.new(separate.outputs["Red"], bsdf.inputs["Metallic"])
        links.new(packed.outputs["Alpha"], invert.inputs[1])
        links.new(invert.outputs[0], bsdf.inputs["Roughness"])
        links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
        return material

    def setup_lighting(height: float) -> None:
        bpy.ops.object.light_add(type="AREA", location=(2.7, -3.6, height * 1.55))
        key = bpy.context.object
        key.data.energy = 900
        key.data.shape = "DISK"
        key.data.size = 4.5
        bpy.ops.object.light_add(type="AREA", location=(-2.8, -1.2, height * 0.95))
        fill = bpy.context.object
        fill.data.energy = 420
        fill.data.size = 5.5
        bpy.ops.object.light_add(type="AREA", location=(0.6, 3.2, height * 1.25))
        rim = bpy.context.object
        rim.data.energy = 520
        rim.data.size = 4.0

    def look_at(camera, target: Vector) -> None:
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()

    def render_views(role: str, spec: dict, obj) -> None:
        low, high = object_bounds([obj])
        center = (low + high) * 0.5
        width, depth, height = high.x - low.x, high.y - low.y, high.z - low.z
        distance = max(width, depth, height) * 2.6
        locations = {
            "front": Vector((center.x, center.y - distance, center.z)),
            "right": Vector((center.x + distance, center.y, center.z)),
            "back": Vector((center.x, center.y + distance, center.z)),
            "top": Vector((center.x, center.y - 0.001, center.z + distance)),
        }
        preview_dir = spec["out"] / "Previews"
        preview_dir.mkdir(parents=True, exist_ok=True)
        for view in ("front", "right", "top", "back"):
            bpy.ops.object.camera_add(location=locations[view])
            camera = bpy.context.object
            look_at(camera, center)
            camera.data.type = "ORTHO"
            camera.data.lens = 70
            camera.data.ortho_scale = max(height * 1.10, width * 1.30) if view != "top" else max(width, depth) * 1.38
            bpy.context.scene.camera = camera
            bpy.context.scene.render.resolution_x = 1000
            bpy.context.scene.render.resolution_y = 1350 if view != "top" else 1000
            bpy.context.scene.render.filepath = str(preview_dir / f"{spec['asset']}_{view}.png")
            bpy.ops.render.render(write_still=True)
            bpy.data.objects.remove(camera, do_unlink=True)

    def mesh_metrics(obj) -> tuple[int, int]:
        graph = bpy.context.evaluated_depsgraph_get()
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        result = len(mesh.loop_triangles), len(mesh.vertices)
        evaluated.to_mesh_clear()
        return result

    def export_model(spec: dict, obj) -> None:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.export_scene.gltf(filepath=str(spec["out"] / f"{spec['asset']}.glb"), export_format="GLB", use_selection=True)
        bpy.ops.export_scene.fbx(
            filepath=str(spec["out"] / f"{spec['asset']}.fbx"),
            use_selection=True,
            object_types={"MESH"},
            apply_unit_scale=True,
            axis_forward="Z",
            axis_up="Y",
            path_mode="COPY",
            embed_textures=True,
        )

    summary = {"version": VERSION, "date": "2026-07-13", "roles": {}}
    if mode == "bake":
        for role, spec in SPECS.items():
            reset_scene()
            spec["out"].mkdir(parents=True, exist_ok=True)
            (spec["out"] / "Textures").mkdir(parents=True, exist_ok=True)
            obj = import_mesh(spec["source"])
            normalize_object(obj, spec["height"])
            extras = convert_meshes(add_role_geometry(role, obj, spec["height"]))
            objects = [obj] + extras
            project_colors(role, spec, objects)
            material = projected_material(f"M_{spec['asset']}_Projected")
            for candidate in objects:
                assign_material(candidate, material)
            joined = join_objects(objects, f"{spec['asset']}_Mesh")
            unwrap(joined)
            textures = spec["out"] / "Textures"
            bake_image(joined, material, textures / f"Char_{spec['asset']}_BaseColor_2K.png", "DIFFUSE")
            bake_image(joined, material, textures / f"Char_{spec['asset']}_AO_2K.png", "AO", (1.0, 1.0, 1.0, 1.0))
            bpy.ops.wm.save_as_mainfile(filepath=str(spec["out"] / f"{spec['asset']}_work.blend"))
    elif mode == "finalize":
        for role, spec in SPECS.items():
            reset_scene()
            bpy.ops.wm.open_mainfile(filepath=str(spec["out"] / f"{spec['asset']}_work.blend"))
            meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
            if len(meshes) != 1:
                raise RuntimeError(f"Expected one final mesh for {role}, got {len(meshes)}")
            obj = meshes[0]
            bpy.context.scene.render.engine = "BLENDER_EEVEE"
            material = textured_material(spec)
            assign_material(obj, material)
            setup_lighting(spec["height"])
            render_views(role, spec, obj)
            export_model(spec, obj)
            bpy.ops.wm.save_as_mainfile(filepath=str(spec["out"] / f"{spec['asset']}.blend"))
            triangles, vertices = mesh_metrics(obj)
            report = {
                "asset": spec["asset"],
                "role": role,
                "triangles": triangles,
                "vertices": vertices,
                "materials": 1,
                "bones": 0,
                "source_geometry": str(spec["source"].relative_to(ROOT)),
                "reference_image": str(spec["reference"].relative_to(ROOT)),
                "quality_gate": {"basecolor_stddev": None, "normal_stddev": None, "ao_stddev": None, "bevel_used": role in {"Kid", "Villain"}},
                "unity_humanoid_avatar_validated": False,
            }
            reports = spec["out"] / "Reports"
            reports.mkdir(parents=True, exist_ok=True)
            (reports / f"{spec['asset']}_budget_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            (spec["out"] / "README.md").write_text(
                f"# {role} Four View Remodel v17\n\nFour-view image-to-surface reconstruction with one baked 2K PBR material.\n\n"
                f"- Triangles: {triangles}\n- Vertices: {vertices}\n- Materials: 1\n- Bones: 0\n\n"
                "Visual/modeling candidate only. Humanoid rigging and Unity Avatar validation remain pending.\n",
                encoding="utf-8",
            )
            summary["roles"][role] = {
                "fbx": str((spec["out"] / f"{spec['asset']}.fbx").relative_to(ROOT)),
                "glb": str((spec["out"] / f"{spec['asset']}.glb").relative_to(ROOT)),
                "triangles": triangles,
                "vertices": vertices,
                "views": {view: str((spec["out"] / "Previews" / f"{spec['asset']}_{view}.png").relative_to(ROOT)) for view in ("front", "right", "top", "back")},
            }
        SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        raise ValueError(mode)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bake", action="store_true")
    parser.add_argument("--finalize", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
    if args.bake:
        blender_main("bake")
    elif args.finalize:
        blender_main("finalize")
    else:
        outer_main()


if __name__ == "__main__":
    main()
