#!/usr/bin/env python3
"""Rebuild Kid, Villain, and Police as four-view-safe art candidates.

This route uses Hunyuan multi-view meshes only as geometry. It does not project
a front render over the whole character, because that fails side/back review.
Materials are reassigned by body/clothing regions and role-specific accessories
are modeled as real geometry.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION = "FourViewRebuild_2026_07_13_v16"
SUMMARY_PATH = ROOT / "docs" / "art_production" / "THREE_CHARACTER_FOURVIEW_REBUILD_V16_SUMMARY.json"
CONTACT_SHEET = ROOT / "docs" / "art_production" / "THREE_CHARACTER_FOURVIEW_REBUILD_V16_CONTACT_SHEET.png"


SPECS = {
    "Kid": {
        "source": ROOT / "docs" / "art_production" / "hunyuan_reference_standard_kid_v13" / "kid_reference_standard_hunyuan_multiview.glb",
        "height": 1.30,
        "asset": "Kid_FourView_Rebuild_v16",
        "role_dir": ROOT / "art-source" / "Characters" / "Kid" / "ReferenceStandard" / VERSION,
        "materials": {
            "skin": (0.72, 0.50, 0.38, 1.0),
            "hair": (0.030, 0.025, 0.021, 1.0),
            "hoodie": (0.018, 0.050, 0.135, 1.0),
            "shorts": (0.025, 0.026, 0.029, 1.0),
            "sock": (0.72, 0.72, 0.68, 1.0),
            "shoe": (0.64, 0.095, 0.055, 1.0),
            "backpack": (0.015, 0.016, 0.018, 1.0),
            "detail": (0.62, 0.62, 0.58, 1.0),
            "eye": (0.035, 0.026, 0.018, 1.0),
        },
    },
    "Villain": {
        "source": ROOT / "docs" / "art_production" / "hunyuan_reference_standard_villain_v13" / "villain_reference_standard_hunyuan_multiview.glb",
        "height": 1.85,
        "asset": "Villain_FourView_Rebuild_v16",
        "role_dir": ROOT / "art-source" / "Characters" / "Villain" / "ReferenceStandard" / VERSION,
        "materials": {
            "skin": (0.48, 0.34, 0.26, 1.0),
            "shadow_skin": (0.075, 0.055, 0.048, 1.0),
            "coat": (0.025, 0.023, 0.021, 1.0),
            "hood": (0.018, 0.017, 0.016, 1.0),
            "pants": (0.022, 0.021, 0.020, 1.0),
            "shoe": (0.010, 0.010, 0.010, 1.0),
            "metal": (0.24, 0.22, 0.20, 1.0),
            "detail": (0.070, 0.062, 0.055, 1.0),
            "eye": (0.015, 0.012, 0.010, 1.0),
        },
    },
    "Police": {
        "source": ROOT / "docs" / "art_production" / "hunyuan_reference_standard_police_v13" / "police_reference_standard_hunyuan_multiview.glb",
        "height": 1.80,
        "asset": "Police_FourView_Rebuild_v16",
        "role_dir": ROOT / "art-source" / "Characters" / "Police" / "ReferenceStandard" / VERSION,
        "materials": {
            "skin": (0.64, 0.44, 0.32, 1.0),
            "hair": (0.026, 0.022, 0.018, 1.0),
            "uniform": (0.018, 0.056, 0.120, 1.0),
            "pants": (0.012, 0.036, 0.080, 1.0),
            "cap": (0.012, 0.030, 0.070, 1.0),
            "shoe": (0.010, 0.010, 0.012, 1.0),
            "belt": (0.010, 0.010, 0.010, 1.0),
            "metal": (0.70, 0.56, 0.29, 1.0),
            "patch": (0.070, 0.165, 0.310, 1.0),
            "eye": (0.025, 0.020, 0.016, 1.0),
        },
    },
}


def run_blender() -> None:
    subprocess.run(["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build"], cwd=str(ROOT), check=True)
    build_contact_sheet()
    run_assimp_validation()


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw

    views = ["front", "right", "top", "back"]
    roles = ["Kid", "Villain", "Police"]
    cell_w, cell_h = 440, 600
    sheet = Image.new("RGB", (cell_w * len(views), cell_h * len(roles)), (28, 28, 28))
    draw = ImageDraw.Draw(sheet)
    for row, role in enumerate(roles):
        spec = SPECS[role]
        for col, view in enumerate(views):
            path = spec["role_dir"] / "Previews" / f"{spec['asset']}_{view}.png"
            img = Image.open(path).convert("RGB")
            img.thumbnail((cell_w - 32, cell_h - 58), Image.Resampling.LANCZOS)
            x = col * cell_w + (cell_w - img.width) // 2
            y = row * cell_h + 42
            sheet.paste(img, (x, y))
            draw.text((col * cell_w + 14, row * cell_h + 14), f"{role} {view}", fill=(245, 245, 240))
    CONTACT_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(CONTACT_SHEET, optimize=True)


def run_assimp_validation() -> None:
    glob = f"art-source/Characters/*/ReferenceStandard/{VERSION}/*_FourView_Rebuild_v16.fbx"
    out = ROOT / "docs" / "art_production" / "THREE_CHARACTER_FOURVIEW_REBUILD_V16_ASSIMP_VALIDATION.json"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools" / "art_pipeline" / "validate_fbx_assimp.py"),
            "--glob",
            glob,
            "--out",
            str(out),
        ],
        cwd=str(ROOT),
        check=True,
    )


def blender_main() -> None:
    import bpy
    from mathutils import Vector

    def reset_scene() -> None:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete()
        bpy.context.scene.unit_settings.system = "METRIC"
        bpy.context.scene.unit_settings.scale_length = 1.0
        bpy.context.scene.render.resolution_x = 1200
        bpy.context.scene.render.resolution_y = 1600
        try:
            bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
            bpy.context.scene.eevee.taa_render_samples = 64
        except Exception:
            pass
        bpy.context.scene.view_settings.view_transform = "Filmic"
        bpy.context.scene.view_settings.look = "Medium High Contrast"

    def import_mesh(path: Path) -> bpy.types.Object:
        bpy.ops.import_scene.gltf(filepath=str(path))
        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        if not meshes:
            raise RuntimeError(f"No meshes imported from {path}")
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        return obj

    def normalize_object(obj: bpy.types.Object, target_height: float) -> None:
        coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
        min_x, max_x = min(v.x for v in coords), max(v.x for v in coords)
        min_y, max_y = min(v.y for v in coords), max(v.y for v in coords)
        min_z, max_z = min(v.z for v in coords), max(v.z for v in coords)
        center_x = (min_x + max_x) * 0.5
        center_y = (min_y + max_y) * 0.5
        height = max(max_z - min_z, 1e-5)
        scale = target_height / height
        obj.location.x -= center_x
        obj.location.y -= center_y
        obj.location.z -= min_z
        obj.scale = (scale, scale, scale)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
        obj.select_set(False)

    def bounds(obj: bpy.types.Object) -> dict[str, float]:
        coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
        return {
            "min_x": min(v.x for v in coords),
            "max_x": max(v.x for v in coords),
            "min_y": min(v.y for v in coords),
            "max_y": max(v.y for v in coords),
            "min_z": min(v.z for v in coords),
            "max_z": max(v.z for v in coords),
        }

    def make_mat(name: str, color, roughness: float = 0.62, metallic: float = 0.0, noise: bool = True) -> bpy.types.Material:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.diffuse_color = color
        nodes = mat.node_tree.nodes
        bsdf = nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            bsdf.inputs["Roughness"].default_value = roughness
            bsdf.inputs["Metallic"].default_value = metallic
            if noise:
                noise_node = nodes.new(type="ShaderNodeTexNoise")
                noise_node.inputs["Scale"].default_value = 28
                noise_node.inputs["Detail"].default_value = 8
                noise_node.inputs["Roughness"].default_value = 0.54
                ramp = nodes.new(type="ShaderNodeValToRGB")
                c0 = tuple(max(0.0, channel * 0.72) for channel in color[:3]) + (1.0,)
                c1 = tuple(min(1.0, channel * 1.16 + 0.04) for channel in color[:3]) + (1.0,)
                ramp.color_ramp.elements[0].position = 0.26
                ramp.color_ramp.elements[0].color = c0
                ramp.color_ramp.elements[1].position = 1.0
                ramp.color_ramp.elements[1].color = c1
                mat.node_tree.links.new(noise_node.outputs["Fac"], ramp.inputs["Fac"])
                mat.node_tree.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
        return mat

    def material_set(spec: dict) -> dict[str, bpy.types.Material]:
        mats = {}
        for key, color in spec["materials"].items():
            metallic = 0.6 if key == "metal" else 0.0
            roughness = 0.34 if key in {"shoe", "belt", "cap", "metal"} else 0.66
            mats[key] = make_mat(f"{spec['asset']}_{key}", color, roughness, metallic, noise=key not in {"eye", "metal"})
        return mats

    def assign_regions(obj: bpy.types.Object, role: str, spec: dict, mats: dict[str, bpy.types.Material]) -> None:
        b = bounds(obj)
        sx = max(b["max_x"] - b["min_x"], 1e-5)
        sy = max(b["max_y"] - b["min_y"], 1e-5)
        sz = max(b["max_z"] - b["min_z"], 1e-5)
        cx = (b["min_x"] + b["max_x"]) * 0.5
        obj.data.materials.clear()
        order = list(mats.keys())
        for key in order:
            obj.data.materials.append(mats[key])
        index = {key: i for i, key in enumerate(order)}

        def choose(center: Vector) -> str:
            z = (center.z - b["min_z"]) / sz
            x = abs((center.x - cx) / sx)
            y = (center.y - b["min_y"]) / sy
            front = y < 0.46
            side = x > 0.24
            if role == "Kid":
                if z < 0.10:
                    return "shoe"
                if z < 0.19:
                    return "sock"
                if 0.31 <= z < 0.47 and x < 0.36:
                    return "shorts"
                if 0.19 <= z < 0.36:
                    return "skin"
                if z >= 0.83:
                    return "hair"
                if 0.69 <= z < 0.84 and front and x < 0.25:
                    return "skin"
                if 0.47 <= z < 0.72:
                    if x > 0.34 and z < 0.50:
                        return "skin"
                    return "hoodie"
                return "skin"
            if role == "Villain":
                if z < 0.10:
                    return "shoe"
                if z < 0.44:
                    return "pants"
                if 0.28 <= z < 0.43 and x > 0.34:
                    return "skin"
                if 0.71 <= z < 0.76 and front and x < 0.055:
                    return "shadow_skin"
                if z >= 0.74:
                    return "hood"
                if z >= 0.42:
                    return "coat"
                return "pants"
            if role == "Police":
                if z < 0.10:
                    return "shoe"
                if z < 0.45:
                    return "pants"
                if 0.44 <= z < 0.51:
                    return "belt"
                if 0.26 <= z < 0.54 and x > 0.30:
                    return "skin"
                if 0.50 <= z < 0.85:
                    return "uniform"
                if z >= 0.85:
                    return "cap"
                return "uniform"
            return order[0]

        mesh = obj.data
        for poly in mesh.polygons:
            center = sum((mesh.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
            poly.material_index = index[choose(center)]
            poly.use_smooth = True
        try:
            mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
            mod.keep_sharp = True
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.modifier_apply(modifier=mod.name)
            obj.select_set(False)
        except Exception:
            pass

    def add_beveled_cube(name: str, loc, scale, mat: bpy.types.Material, bevel: float = 0.015) -> bpy.types.Object:
        bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.dimensions = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        if bevel > 0:
            mod = obj.modifiers.new("Soft_Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 5
            bpy.ops.object.modifier_apply(modifier=mod.name)
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.use_smooth = True
        return obj

    def add_uv_sphere(name: str, loc, scale, mat: bpy.types.Material, segments: int = 32) -> bpy.types.Object:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=16, radius=1.0, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.data.materials.append(mat)
        return obj

    def add_cylinder(name: str, loc, radius: float, depth: float, mat: bpy.types.Material, vertices: int = 48, rotation=(0, 0, 0)) -> bpy.types.Object:
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
        obj = bpy.context.object
        obj.name = name
        obj.data.materials.append(mat)
        for poly in obj.data.polygons:
            poly.use_smooth = True
        return obj

    def add_face_kit(
        role: str,
        base_obj: bpy.types.Object,
        b: dict[str, float],
        mats: dict[str, bpy.types.Material],
        *,
        z: float,
        eye_gap: float,
        eye_size: float,
        nose_size: tuple[float, float, float],
        mouth_w: float,
        mouth_radius: float,
        mouth_mat: bpy.types.Material | None = None,
        include_ears: bool = True,
        skin_patch: bool = False,
        patch_w: float = 0.070,
        patch_h: float = 0.044,
        patch_d: float = 0.012,
    ) -> list[bpy.types.Object]:
        height = b["max_z"] - b["min_z"]
        width = b["max_x"] - b["min_x"]
        depth = b["max_y"] - b["min_y"]
        face_center_z = b["min_z"] + height * z
        created: list[bpy.types.Object] = []

        world_verts = [base_obj.matrix_world @ v.co for v in base_obj.data.vertices]

        def local_front_y(x_pos: float, z_pos: float, x_radius: float, z_radius: float) -> float:
            selected = [
                v.y
                for v in world_verts
                if abs(v.x - x_pos) <= x_radius and abs(v.z - z_pos) <= z_radius
            ]
            if not selected:
                selected = [
                    v.y
                    for v in world_verts
                    if abs(v.x - x_pos) <= x_radius * 1.8 and abs(v.z - z_pos) <= z_radius * 1.8
                ]
            return (min(selected) if selected else b["min_y"]) - depth * 0.010

        feature_y_override = None
        if skin_patch and "skin" in mats:
            patch_y = local_front_y(0.0, face_center_z, width * 0.075, height * 0.045)
            created.append(
                add_uv_sphere(
                    f"{role}_Face_AttachedSkin",
                    (0.0, patch_y, face_center_z),
                    (width * patch_w, depth * patch_d, height * patch_h),
                    mats["skin"],
                    40,
                )
            )
            feature_y_override = patch_y - depth * 0.012

        eye_z = face_center_z + height * 0.020
        for side in (-1, 1):
            eye_x = side * width * eye_gap
            created.append(
                add_uv_sphere(
                    f"{role}_Eye_{'L' if side < 0 else 'R'}",
                    (
                        eye_x,
                        feature_y_override
                        if feature_y_override is not None
                        else local_front_y(eye_x, eye_z, width * 0.045, height * 0.035),
                        eye_z,
                    ),
                    (width * eye_size, depth * 0.010, height * eye_size * 1.18),
                    mats["eye"],
                    24,
                )
            )
        nose_z = face_center_z - height * 0.012
        nose = add_uv_sphere(
            f"{role}_Nose",
            (
                0.0,
                (feature_y_override - depth * 0.010)
                if feature_y_override is not None
                else local_front_y(0.0, nose_z, width * 0.050, height * 0.040),
                nose_z,
            ),
            (width * nose_size[0], depth * nose_size[1], height * nose_size[2]),
            mats["skin"] if "skin" in mats else mats["shadow_skin"],
            24,
        )
        created.append(nose)
        mouth_z = face_center_z - height * 0.050
        created.append(
            add_cylinder(
                f"{role}_Mouth_Line",
                (
                    0.0,
                    (feature_y_override - depth * 0.014)
                    if feature_y_override is not None
                    else local_front_y(0.0, mouth_z, width * 0.060, height * 0.025),
                    mouth_z,
                ),
                height * mouth_radius,
                width * mouth_w,
                mouth_mat or mats["eye"],
                24,
                rotation=(0, math.pi / 2, 0),
            )
        )
        return created

    def add_accessories(role: str, obj: bpy.types.Object, spec: dict, mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
        b = bounds(obj)
        height = b["max_z"] - b["min_z"]
        width = b["max_x"] - b["min_x"]
        depth = b["max_y"] - b["min_y"]
        min_y, max_y = b["min_y"], b["max_y"]
        created: list[bpy.types.Object] = []
        if role == "Kid":
            created.extend(
                add_face_kit(
                    role,
                    obj,
                    b,
                    mats,
                    z=0.785,
                    eye_gap=0.042,
                    eye_size=0.010,
                    nose_size=(0.014, 0.020, 0.014),
                    mouth_w=0.045,
                    mouth_radius=0.0026,
                    include_ears=False,
                )
            )
        elif role == "Villain":
            # The hooded source mesh carries the character silhouette. Avoid
            # front patches here because they visibly float in side/top review.
            pass
        elif role == "Police":
            created.extend(
                add_face_kit(
                    role,
                    obj,
                    b,
                    mats,
                    z=0.875,
                    eye_gap=0.024,
                    eye_size=0.0120,
                    nose_size=(0.010, 0.018, 0.012),
                    mouth_w=0.042,
                    mouth_radius=0.0028,
                    include_ears=True,
                    skin_patch=True,
                    patch_w=0.052,
                    patch_h=0.030,
                    patch_d=0.008,
                )
            )
            created.append(
                add_uv_sphere(
                    "Police_Badge",
                    (width * 0.070, min_y - depth * 0.030, height * 0.620),
                    (width * 0.014, depth * 0.006, height * 0.018),
                    mats["metal"],
                    24,
                )
            )
        return created

    def look_at(camera: bpy.types.Object, target: Vector) -> None:
        direction = target - camera.location
        camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    def setup_lighting(height: float) -> None:
        bpy.ops.object.light_add(type="AREA", location=(2.4, -3.4, height * 1.55))
        key = bpy.context.object
        key.name = "Key_Light"
        key.data.energy = 760
        key.data.size = 4.8
        bpy.ops.object.light_add(type="AREA", location=(-2.2, 2.8, height * 1.20))
        fill = bpy.context.object
        fill.name = "Fill_Light"
        fill.data.energy = 230
        fill.data.size = 5.5
        bpy.context.scene.world.color = (0.17, 0.17, 0.17)

    def view_camera_location(view: str, distance: float, target: Vector) -> Vector:
        if view == "front":
            return Vector((target.x, target.y - distance, target.z))
        if view == "right":
            return Vector((target.x + distance, target.y, target.z))
        if view == "back":
            return Vector((target.x, target.y + distance, target.z))
        if view == "top":
            return Vector((target.x, target.y - 0.001, target.z + distance))
        raise ValueError(view)

    def render_view(role: str, spec: dict, view: str, all_meshes: list[bpy.types.Object]) -> None:
        pts = [obj.matrix_world @ Vector(corner) for obj in all_meshes for corner in obj.bound_box]
        min_v = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        max_v = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        target = (min_v + max_v) * 0.5
        height = max_v.z - min_v.z
        width = max_v.x - min_v.x
        depth = max_v.y - min_v.y
        bpy.ops.object.camera_add(location=view_camera_location(view, max(width, depth, height) * 2.4, target))
        cam = bpy.context.object
        cam.name = f"{role}_{view}_Camera"
        look_at(cam, target)
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = max(height * 1.12, width * 1.35, depth * 1.35) if view != "top" else max(width, depth) * 1.42
        bpy.context.scene.camera = cam
        bpy.context.scene.render.resolution_x = 1200
        bpy.context.scene.render.resolution_y = 1600 if view != "top" else 1200
        out = spec["role_dir"] / "Previews" / f"{spec['asset']}_{view}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.scene.render.filepath = str(out)
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(cam, do_unlink=True)

    def export_model(spec: dict, meshes: list[bpy.types.Object]) -> tuple[int, int]:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        glb = spec["role_dir"] / f"{spec['asset']}.glb"
        fbx = spec["role_dir"] / f"{spec['asset']}.fbx"
        glb.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
        bpy.ops.export_scene.fbx(
            filepath=str(fbx),
            use_selection=True,
            object_types={"MESH"},
            apply_unit_scale=True,
            bake_space_transform=False,
            axis_forward="Z",
            axis_up="Y",
            path_mode="COPY",
            embed_textures=True,
        )
        tris = 0
        verts = 0
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for obj in meshes:
            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            mesh.calc_loop_triangles()
            tris += len(mesh.loop_triangles)
            verts += len(mesh.vertices)
            eval_obj.to_mesh_clear()
        return tris, verts

    def write_readme(spec: dict, role: str, tris: int, verts: int) -> None:
        text = f"""# {role} Four View Rebuild v16

This candidate is rebuilt from the Hunyuan multi-view geometry source with
region-based materials and modeled role accessories. It avoids whole-body front
projection so the side and back views remain inspectable.

## Files

- `{spec['asset']}.glb`
- `{spec['asset']}.fbx`
- `Previews/{spec['asset']}_front.png`
- `Previews/{spec['asset']}_right.png`
- `Previews/{spec['asset']}_top.png`
- `Previews/{spec['asset']}_back.png`

## Metrics

- Triangles: {tris}
- Vertices: {verts}
- Bones: 0

## Status

This is an art/modeling candidate for four-view review. It is not yet a final
Unity Humanoid-rigged character and has not passed Avatar validation.
"""
        (spec["role_dir"] / "README.md").write_text(text, encoding="utf-8")

    summary = {"version": VERSION, "date": "2026-07-13", "roles": {}}
    for role, spec in SPECS.items():
        reset_scene()
        obj = import_mesh(spec["source"])
        obj.name = f"{spec['asset']}_Body"
        normalize_object(obj, spec["height"])
        mats = material_set(spec)
        assign_regions(obj, role, spec, mats)
        extras = add_accessories(role, obj, spec, mats)
        all_meshes = [obj] + extras
        setup_lighting(spec["height"])
        for view in ("front", "right", "top", "back"):
            render_view(role, spec, view, all_meshes)
        tris, verts = export_model(spec, all_meshes)
        write_readme(spec, role, tris, verts)
        summary["roles"][role] = {
            "source": str(spec["source"].relative_to(ROOT)),
            "glb": str((spec["role_dir"] / f"{spec['asset']}.glb").relative_to(ROOT)),
            "fbx": str((spec["role_dir"] / f"{spec['asset']}.fbx").relative_to(ROOT)),
            "previews": {
                view: str((spec["role_dir"] / "Previews" / f"{spec['asset']}_{view}.png").relative_to(ROOT))
                for view in ("front", "right", "top", "back")
            },
            "triangles": tris,
            "vertices": verts,
            "bones": 0,
            "selected_for_four_view_review": True,
            "unity_humanoid_avatar_validated": False,
        }
    SUMMARY_PATH.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])
    if args.build:
        blender_main()
    else:
        run_blender()


if __name__ == "__main__":
    main()
