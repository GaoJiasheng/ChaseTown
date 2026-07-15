#!/usr/bin/env python3
"""Precision v18 rebuild for the villain and police reference characters."""

from __future__ import annotations

import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import remodel_kid_v18_pilot as kit


SPECS = {
    "Villain": {
        "height": 1.85,
        "source": ROOT / "docs/art_production/hunyuan_reference_standard_villain_v13/villain_reference_standard_hunyuan_multiview.glb",
        "out": ROOT / "docs/art_production/fourview_remodel_v18_pilot/Villain",
        "asset": ROOT / "art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v18",
    },
    "Police": {
        "height": 1.80,
        "source": ROOT / "docs/art_production/hunyuan_reference_standard_police_v13/police_reference_standard_hunyuan_multiview.glb",
        "out": ROOT / "docs/art_production/fourview_remodel_v18_pilot/Police",
        "asset": ROOT / "art-source/Characters/Police/ReferenceStandard/PrecisionRemodel_2026_07_13_v18",
    },
}


def import_normalized(spec: dict, role: str) -> bpy.types.Object:
    bpy.ops.import_scene.gltf(filepath=str(spec["source"]))
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not objects:
        raise RuntimeError(f"No mesh for {role}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = bpy.context.object
    low, high = kit.bounds([obj])
    scale = spec["height"] / (high.z - low.z)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    low, high = kit.bounds([obj])
    obj.location = (-0.5 * (low.x + high.x), -0.5 * (low.y + high.y), -low.z)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    obj.name = f"{role}_v18_HighRes_BodyGarments"
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def villain_materials() -> dict[str, bpy.types.Material]:
    return {
        "skin": kit.material("M_Villain_Skin", (0.17, 0.070, 0.035, 1), 0.62, noise_scale=98, noise_strength=0.016, subsurface=0.040),
        "hair": kit.material("M_Villain_HairBeard", (0.0025, 0.0015, 0.0010, 1), 0.66, noise_scale=175, noise_strength=0.045),
        "coat": kit.material("M_Villain_DistressedCoat", (0.006, 0.005, 0.004, 1), 0.64, noise_scale=105, noise_strength=0.055, sheen=0.010),
        "inner": kit.material("M_Villain_InnerKnit", (0.012, 0.011, 0.010, 1), 0.80, noise_scale=230, noise_strength=0.13),
        "pants": kit.material("M_Villain_Pants", (0.0065, 0.0055, 0.0045, 1), 0.68, noise_scale=150, noise_strength=0.055),
        "boot": kit.material("M_Villain_BootLeather", (0.004, 0.0035, 0.003, 1), 0.45, noise_scale=74, noise_strength=0.08),
        "glove": kit.material("M_Villain_GloveLeather", (0.003, 0.0025, 0.0022, 1), 0.48, noise_scale=110, noise_strength=0.07),
        "metal": kit.material("M_Villain_Gunmetal", (0.035, 0.040, 0.046, 1), 0.38, metallic=0.72, noise_scale=70, noise_strength=0.015),
        "eye_white": kit.material("M_Villain_EyeWhite_EyeGloss", (0.32, 0.25, 0.18, 1), 0.27, subsurface=0.012),
        "iris": kit.material("M_Villain_Iris_EyeGloss", (0.025, 0.010, 0.004, 1), 0.16),
        "pupil": kit.material("M_Villain_Pupil_EyeGloss", (0.001, 0.001, 0.001, 1), 0.10),
        "line": kit.material("M_Villain_FaceLine", (0.006, 0.003, 0.002, 1), 0.62),
        "mouth": kit.material("M_Villain_Mouth", (0.115, 0.020, 0.012, 1), 0.58),
        "stubble": kit.material("M_Villain_Stubble", (0.032, 0.012, 0.006, 1), 0.78, noise_scale=145, noise_strength=0.025),
    }


def police_materials() -> dict[str, bpy.types.Material]:
    return {
        "skin": kit.material("M_Police_Skin", (0.32, 0.140, 0.070, 1), 0.60, noise_scale=96, noise_strength=0.018, subsurface=0.065),
        "hair": kit.material("M_Police_Hair", (0.0035, 0.0020, 0.0012, 1), 0.64, noise_scale=180, noise_strength=0.040),
        "uniform": kit.material("M_Police_UniformNavy", (0.004, 0.012, 0.035, 1), 0.73, noise_scale=215, noise_strength=0.105, sheen=0.025),
        "pants": kit.material("M_Police_TrouserNavy", (0.0035, 0.009, 0.027, 1), 0.70, noise_scale=180, noise_strength=0.080),
        "shoe": kit.material("M_Police_ShoeLeather", (0.003, 0.003, 0.004, 1), 0.40, noise_scale=78, noise_strength=0.055),
        "belt": kit.material("M_Police_DutyBelt", (0.002, 0.002, 0.0025, 1), 0.48, noise_scale=112, noise_strength=0.055),
        "metal": kit.material("M_Police_BrushedMetal", (0.42, 0.44, 0.46, 1), 0.25, metallic=0.82, noise_scale=74, noise_strength=0.020),
        "gold": kit.material("M_Police_BadgeGold", (0.48, 0.25, 0.045, 1), 0.25, metallic=0.76, noise_scale=68, noise_strength=0.016),
        "patch_blue": kit.material("M_Police_PatchBlue", (0.006, 0.035, 0.12, 1), 0.67, noise_scale=190, noise_strength=0.075),
        "eye_white": kit.material("M_Police_EyeWhite_EyeGloss", (0.50, 0.43, 0.34, 1), 0.24, subsurface=0.018),
        "iris": kit.material("M_Police_IrisBrown_EyeGloss", (0.075, 0.020, 0.004, 1), 0.16),
        "pupil": kit.material("M_Police_Pupil_EyeGloss", (0.001, 0.001, 0.001, 1), 0.10),
        "line": kit.material("M_Police_FaceLine", (0.008, 0.004, 0.002, 1), 0.58),
        "mouth": kit.material("M_Police_Mouth", (0.14, 0.026, 0.016, 1), 0.56),
    }


def assign_villain(obj: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    order = ("coat", "inner", "pants", "boot", "glove", "hair", "skin")
    for name in order:
        obj.data.materials.append(mats[name])
    slots = {name: index for index, name in enumerate(order)}
    for poly in obj.data.polygons:
        center = sum((obj.data.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
        ax, z = abs(center.x), center.z
        label = "coat"
        if z < 0.18:
            label = "boot"
        elif 0.64 < z < 0.94 and ax > 0.300:
            label = "glove"
        poly.material_index = slots[label]


def assign_police(obj: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    order = ("uniform", "pants", "shoe", "belt", "skin", "hair")
    for name in order:
        obj.data.materials.append(mats[name])
    slots = {name: index for index, name in enumerate(order)}
    for poly in obj.data.polygons:
        center = sum((obj.data.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
        ax, z = abs(center.x), center.z
        label = "uniform"
        if 0.54 < z < 1.22 and ax > 0.235:
            label = "skin"
        elif z < 0.12:
            label = "shoe"
        elif z < 0.72:
            label = "pants"
        elif 1.490 < z < 1.64 and ax < 0.145:
            label = "hair"
        elif z >= 1.64:
            label = "uniform"
        poly.material_index = slots[label]


def add_tapered_face(role: str, center, radii, mat: bpy.types.Material) -> bpy.types.Object:
    import math

    segments, rings = 96, 56
    vertices = []
    faces = []
    for ring in range(rings + 1):
        latitude = -math.pi * 0.5 + math.pi * ring / rings
        sl, cl = math.sin(latitude), math.cos(latitude)
        height_ratio = (sl + 1.0) * 0.5
        jaw_taper = 0.80 + height_ratio * 0.20
        for segment in range(segments):
            longitude = 2.0 * math.pi * segment / segments
            vertices.append((
                center[0] + radii[0] * jaw_taper * cl * math.cos(longitude),
                center[1] + radii[1] * cl * math.sin(longitude),
                center[2] + radii[2] * sl,
            ))
    for ring in range(rings):
        for segment in range(segments):
            a = ring * segments + segment
            b = ring * segments + (segment + 1) % segments
            c = (ring + 1) * segments + (segment + 1) % segments
            d = (ring + 1) * segments + segment
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(f"{role}_TaperedFace_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(f"{role}_TaperedFace", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return obj


def add_adult_face(role: str, mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    if role == "Villain":
        center = (0.0, -0.155, 1.545)
        radii = (0.086, 0.055, 0.105)
        eye_x, eye_z, eye_y = 0.032, 1.570, -0.207
        eye_size = (0.0125, 0.0050, 0.0075)
        nose_center, nose_size = (0.0, -0.214, 1.540), (0.009, 0.009, 0.017)
        ear_x, ear_z = 0.087, 1.545
    else:
        center = (0.0, -0.100, 1.535)
        radii = (0.082, 0.063, 0.105)
        eye_x, eye_z, eye_y = 0.031, 1.560, -0.160
        eye_size = (0.0125, 0.0050, 0.0085)
        nose_center, nose_size = (0.0, -0.168, 1.530), (0.009, 0.008, 0.017)
        ear_x, ear_z = 0.083, 1.535
    face = add_tapered_face(role, center, radii, mats["skin"])
    left_ear = kit.add_uv_sphere(f"{role}_Ear_L", (-ear_x, center[1] + 0.028, ear_z), (0.011, 0.010, 0.021), mats["skin"], 48, 24)
    right_ear = kit.add_uv_sphere(f"{role}_Ear_R", (ear_x, center[1] + 0.028, ear_z), (0.011, 0.010, 0.021), mats["skin"], 48, 24)
    nose = kit.add_uv_sphere(f"{role}_Nose", nose_center, nose_size, mats["skin"], 48, 24)
    objects = [face, left_ear, right_ear, nose]
    for side in (-1.0, 1.0):
        x = side * eye_x
        eye = kit.add_uv_sphere(f"{role}_Eye_{side:+.0f}", (x, eye_y, eye_z), eye_size, mats["eye_white"])
        iris = kit.add_uv_sphere(f"{role}_Iris_{side:+.0f}", (x, eye_y - eye_size[1] * 0.91, eye_z), (eye_size[0] * 0.46, 0.0016, eye_size[2] * 0.62), mats["iris"], 44, 22)
        pupil = kit.add_uv_sphere(f"{role}_Pupil_{side:+.0f}", (x, eye_y - eye_size[1] * 1.13, eye_z), (eye_size[0] * 0.21, 0.0009, eye_size[2] * 0.30), mats["pupil"], 36, 18)
        brow_z = eye_z + 0.024
        brow = kit.add_curve(
            f"{role}_Brow_{side:+.0f}",
            ((x - 0.017, eye_y - 0.006, brow_z), (x, eye_y - 0.007, brow_z + (0.004 if role == "Police" else 0.001)), (x + 0.017, eye_y - 0.006, brow_z - (0.002 if role == "Villain" else 0.0))),
            0.0022,
            mats["line"],
        )
        objects.extend((eye, iris, pupil, brow))
    mouth_y = nose_center[1] - 0.001
    mouth_z = center[2] - 0.048
    mouth = kit.add_curve(
        f"{role}_Mouth",
        ((-0.023, mouth_y, mouth_z), (0.0, mouth_y - 0.002, mouth_z - (0.003 if role == "Villain" else 0.001)), (0.023, mouth_y, mouth_z)),
        0.0015,
        mats["mouth"],
    )
    objects.append(mouth)
    return objects


def add_villain_details(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    objects = add_adult_face("Villain", mats)
    goatee = kit.add_superellipsoid("Villain_Goatee", (0.0, -0.212, 1.482), (0.016, 0.003, 0.021), 0.80, mats["stubble"], 48, 24)
    moustache = kit.add_curve("Villain_Moustache", ((-0.022, -0.218, 1.535), (0.0, -0.221, 1.531), (0.022, -0.218, 1.535)), 0.0016, mats["stubble"])
    objects.extend((goatee, moustache))
    return objects


def add_police_details(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    objects = add_adult_face("Police", mats)
    cap_badge = kit.add_superellipsoid("Police_CapBadge", (0.0, -0.168, 1.715), (0.024, 0.004, 0.032), 0.62, mats["metal"], 48, 28)
    chest_badge = kit.add_superellipsoid("Police_ChestBadge", (0.105, -0.125, 1.238), (0.029, 0.004, 0.040), 0.60, mats["metal"], 48, 28)
    nameplate = kit.add_superellipsoid("Police_Nameplate", (-0.092, -0.130, 1.252), (0.043, 0.0035, 0.009), 0.42, mats["metal"], 48, 20)
    buckle = kit.add_superellipsoid("Police_BeltBuckle", (0.0, -0.138, 0.875), (0.038, 0.005, 0.027), 0.46, mats["metal"], 48, 24)
    shoulder_l = kit.add_superellipsoid("Police_ShoulderPatch_L", (-0.305, -0.022, 1.210), (0.008, 0.035, 0.050), 0.54, mats["patch_blue"], 40, 24)
    shoulder_r = kit.add_superellipsoid("Police_ShoulderPatch_R", (0.305, -0.022, 1.210), (0.008, 0.035, 0.050), 0.54, mats["patch_blue"], 40, 24)
    for patch in (shoulder_l, shoulder_r):
        patch.rotation_euler.z = 0.0
    objects.extend((cap_badge, chest_badge, nameplate, buckle, shoulder_l, shoulder_r))
    for index, z in enumerate((1.160, 1.100, 1.040)):
        button = kit.add_uv_sphere(f"Police_ShirtButton_{index}", (0.0, -0.128, z), (0.006, 0.0025, 0.006), mats["metal"], 28, 14)
        objects.append(button)
    return objects


def render_views(role: str, spec: dict, objects: list[bpy.types.Object]) -> None:
    low, high = kit.bounds(objects)
    center = (low + high) * 0.5
    width, depth, height = high.x - low.x, high.y - low.y, high.z - low.z
    distance = height * 3.0
    positions = {
        "front": Vector((center.x, center.y - distance, center.z + 0.015)),
        "right": Vector((center.x + distance, center.y, center.z + 0.015)),
        "back": Vector((center.x, center.y + distance, center.z + 0.015)),
        "top": Vector((center.x, center.y - 0.001, center.z + distance)),
    }
    spec["out"].mkdir(parents=True, exist_ok=True)
    for view in ("front", "right", "top", "back"):
        bpy.ops.object.camera_add(location=positions[view])
        camera = bpy.context.object
        kit.look_at(camera, center)
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = max(height * 1.10, width * 1.35) if view != "top" else max(width, depth) * 1.34
        camera.data.lens = 70
        bpy.context.scene.camera = camera
        bpy.context.scene.render.resolution_x = 900
        bpy.context.scene.render.resolution_y = 1200 if view != "top" else 900
        bpy.context.scene.render.filepath = str(spec["out"] / f"{role}_v18_{view}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(camera, do_unlink=True)


def export(role: str, spec: dict, objects: list[bpy.types.Object]) -> None:
    spec["asset"].mkdir(parents=True, exist_ok=True)
    blend = spec["asset"] / f"{role}_PrecisionRemodel_v18.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=str(spec["asset"] / f"{role}_PrecisionRemodel_v18.glb"), export_format="GLB", use_selection=True)
    bpy.ops.export_scene.fbx(
        filepath=str(spec["asset"] / f"{role}_PrecisionRemodel_v18.fbx"),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        axis_forward="Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
    )


def build(role: str) -> None:
    spec = SPECS[role]
    kit.reset_scene()
    body = import_normalized(spec, role)
    if role == "Villain":
        mats = villain_materials()
        assign_villain(body, mats)
        details = add_villain_details(mats)
    else:
        mats = police_materials()
        assign_police(body, mats)
        details = add_police_details(mats)
    details = kit.convert_curves(details)
    character = [body] + details
    kit.setup_studio()
    render_views(role, spec, character)
    export(role, spec, character)


def main() -> None:
    for role in ("Villain", "Police"):
        build(role)


if __name__ == "__main__":
    main()
