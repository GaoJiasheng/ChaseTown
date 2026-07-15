#!/usr/bin/env python3
"""Build v20 characters with native heads and embedded facial features.

This is the production fallback for the unavailable multiview texture service.
It preserves the generated head, nose, jaw, hair/hood/cap, and body sculpt.
Only eyes, brows, lip line, and authored accessories are added as separate
meshes, so there is no full-face shell capable of producing a patch seam.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import remodel_kid_v18_pilot as kit
import remodel_villain_police_v18 as adults


SPECS = {
    "Kid": {
        "height": 1.30,
        "source": ROOT / "docs/art_production/hunyuan_reference_standard_kid_v13/kid_reference_standard_hunyuan_multiview.glb",
    },
    "Villain": {
        "height": 1.85,
        "source": ROOT / "docs/art_production/hunyuan_reference_standard_villain_v13/villain_reference_standard_hunyuan_multiview.glb",
    },
    "Police": {
        "height": 1.80,
        "source": ROOT / "docs/art_production/hunyuan_reference_standard_police_v13/police_reference_standard_hunyuan_multiview.glb",
    },
}

REVIEW_ROOT = ROOT / "docs/art_production/fourview_remodel_v20_native_hybrid"


def import_role(role: str) -> bpy.types.Object:
    spec = SPECS[role]
    bpy.ops.import_scene.gltf(filepath=str(spec["source"]))
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not objects:
        raise RuntimeError(f"No source mesh for {role}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = bpy.context.object
    low, high = kit.bounds([obj])
    scale = spec["height"] / max(high.z - low.z, 1e-6)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    low, high = kit.bounds([obj])
    obj.location = (-0.5 * (low.x + high.x), -0.5 * (low.y + high.y), -low.z)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    obj.name = f"{role}_v20_NativeBodyHead"
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def deform_adult_head(obj: bpy.types.Object, role: str) -> None:
    if role == "Police":
        center = Vector((0.0, -0.080, 1.515))
        scale_x, scale_y, scale_z = 1.30, 1.12, 1.18
        z_low, z_full, z_fade, z_high = 1.350, 1.430, 1.610, 1.655
        x_full, x_high, y_high = 0.105, 0.165, 0.110
    else:
        center = Vector((0.0, -0.140, 1.535))
        scale_x, scale_y, scale_z = 1.28, 1.10, 1.16
        z_low, z_full, z_fade, z_high = 1.385, 1.440, 1.625, 1.675
        x_full, x_high, y_high = 0.095, 0.145, 0.020
    for vertex in obj.data.vertices:
        co = vertex.co
        rise = smoothstep(z_low, z_full, co.z)
        fall = 1.0 - smoothstep(z_fade, z_high, co.z)
        side = 1.0 - smoothstep(x_full, x_high, abs(co.x))
        back = 1.0 - smoothstep(y_high, y_high + 0.090, co.y)
        weight = rise * fall * side * back
        if weight <= 1e-5:
            continue
        offset = co - center
        co.x = center.x + offset.x * (1.0 + (scale_x - 1.0) * weight)
        co.y = center.y + offset.y * (1.0 + (scale_y - 1.0) * weight)
        co.z = center.z + offset.z * (1.0 + (scale_z - 1.0) * weight)
    obj.data.update()


def polygon_center(obj: bpy.types.Object, polygon: bpy.types.MeshPolygon) -> Vector:
    return sum((obj.data.vertices[index].co for index in polygon.vertices), Vector()) / len(polygon.vertices)


def body_vertex_material(role: str) -> bpy.types.Material:
    mat = kit.material(
        f"M_{role}_v20_VertexPalette",
        (1.0, 1.0, 1.0, 1.0),
        0.64 if role != "Kid" else 0.61,
        noise_scale=145 if role != "Villain" else 105,
        noise_strength=0.032 if role != "Kid" else 0.026,
    )
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = next(node for node in nodes if node.bl_idname == "ShaderNodeBsdfPrincipled")
    colors = nodes.new("ShaderNodeVertexColor")
    colors.layer_name = "BodyPalette"
    links.new(colors.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def mix_color(a: tuple[float, float, float, float], b: tuple[float, float, float, float], amount: float) -> tuple[float, float, float, float]:
    amount = max(0.0, min(1.0, amount))
    return tuple(a[index] * (1.0 - amount) + b[index] * amount for index in range(4))


def smoothstep(low: float, high: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - low) / max(high - low, 1e-6)))
    return t * t * (3.0 - 2.0 * t)


def kid_vertex_color(co: Vector) -> tuple[float, float, float, float]:
    x, y, z = co
    ax = abs(x)
    skin = (0.46, 0.170, 0.075, 1.0)
    hair = (0.0035, 0.0018, 0.0010, 1.0)
    hoodie = (0.004, 0.010, 0.030, 1.0)
    shorts = (0.007, 0.0075, 0.009, 1.0)
    sock = (0.57, 0.58, 0.55, 1.0)
    shoe = (0.006, 0.014, 0.034, 1.0)
    rubber = (0.44, 0.40, 0.33, 1.0)
    if z < 0.070:
        return rubber
    if z < 0.135:
        return shoe
    if z < 0.245 and ax < 0.155:
        return sock
    if 0.395 < z < 0.600 and ax > 0.175:
        return skin
    if z < 0.355 and ax < 0.165:
        return skin
    if z < 0.595:
        return shorts
    if z <= 0.935:
        return hoodie
    face = 0.985 < z < 1.145 and ax < 0.113 and y < -0.100
    ears = 1.000 < z < 1.095 and 0.098 < ax < 0.140 and y < -0.018
    if face:
        hairline = 1.078 + 0.020 * min(ax / 0.113, 1.0)
        return mix_color(skin, hair, smoothstep(hairline - 0.006, hairline + 0.010, z))
    if ears:
        return skin
    return hair


def villain_vertex_color(co: Vector) -> tuple[float, float, float, float]:
    x, y, z = co
    ax = abs(x)
    coat = (0.006, 0.005, 0.004, 1.0)
    boot = (0.004, 0.0035, 0.003, 1.0)
    glove = (0.003, 0.0025, 0.0022, 1.0)
    skin = (0.17, 0.070, 0.035, 1.0)
    if z < 0.18:
        return boot
    if 0.64 < z < 0.94 and ax > 0.300:
        return glove
    face_ellipse = (ax / 0.106) ** 2 + ((z - 1.535) / 0.120) ** 2
    if y < -0.145 and face_ellipse < 0.82:
        return skin
    return coat


def police_vertex_color(co: Vector) -> tuple[float, float, float, float]:
    x, y, z = co
    ax = abs(x)
    uniform = (0.004, 0.012, 0.035, 1.0)
    pants = (0.0035, 0.009, 0.027, 1.0)
    shoe = (0.003, 0.003, 0.004, 1.0)
    skin = (0.32, 0.140, 0.070, 1.0)
    hair = (0.0035, 0.0020, 0.0012, 1.0)
    if z < 0.12:
        return shoe
    if z < 0.72:
        return pants
    if 0.54 < z < 1.22 and ax > 0.235:
        return skin
    if z >= 1.640:
        return uniform
    face_ellipse = (ax / 0.108) ** 2 + ((z - 1.515) / 0.120) ** 2
    if y < -0.080 and face_ellipse < 0.84:
        return skin
    if 1.475 < z < 1.640 and ax < 0.145:
        return hair
    return uniform


def assign_vertex_palette(obj: bpy.types.Object, role: str) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(body_vertex_material(role))
    while obj.data.color_attributes:
        obj.data.color_attributes.remove(obj.data.color_attributes[0])
    colors = obj.data.color_attributes.new(name="BodyPalette", type="FLOAT_COLOR", domain="POINT")
    resolver = {"Kid": kid_vertex_color, "Villain": villain_vertex_color, "Police": police_vertex_color}[role]
    for vertex in obj.data.vertices:
        colors.data[vertex.index].color = resolver(vertex.co)
    for polygon in obj.data.polygons:
        polygon.material_index = 0


def assign_kid_native(obj: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    order = ("skin", "hair", "hoodie", "shorts", "sock", "shoe", "rubber")
    for name in order:
        obj.data.materials.append(mats[name])
    slots = {name: index for index, name in enumerate(order)}
    for polygon in obj.data.polygons:
        x, y, z = polygon_center(obj, polygon)
        ax = abs(x)
        label = "hoodie"
        if z < 0.070:
            label = "rubber"
        elif z < 0.135:
            label = "shoe"
        elif z < 0.245 and ax < 0.155:
            label = "sock"
        elif 0.400 < z < 0.595 and ax > 0.175:
            label = "skin"
        elif z < 0.385 and ax < 0.160:
            label = "skin"
        elif z < 0.590:
            label = "shorts"
        elif z > 0.935:
            face = 0.945 < z < 1.145 and ax < 0.112 and y < -0.030
            ears = 0.995 < z < 1.095 and ax < 0.138 and y < -0.005
            label = "skin" if face or ears else "hair"
        polygon.material_index = slots[label]


def assign_villain_native(obj: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    order = ("coat", "inner", "pants", "boot", "glove", "hair", "skin")
    for name in order:
        obj.data.materials.append(mats[name])
    slots = {name: index for index, name in enumerate(order)}
    for polygon in obj.data.polygons:
        x, y, z = polygon_center(obj, polygon)
        ax = abs(x)
        label = "coat"
        if z < 0.18:
            label = "boot"
        elif 0.64 < z < 0.94 and ax > 0.300:
            label = "glove"
        elif 1.430 < z < 1.650 and ax < 0.100 and y < -0.095:
            label = "skin"
        polygon.material_index = slots[label]


def assign_police_native(obj: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    order = ("uniform", "pants", "shoe", "belt", "skin", "hair")
    for name in order:
        obj.data.materials.append(mats[name])
    slots = {name: index for index, name in enumerate(order)}
    for polygon in obj.data.polygons:
        x, y, z = polygon_center(obj, polygon)
        ax = abs(x)
        label = "uniform"
        if 0.54 < z < 1.22 and ax > 0.235:
            label = "skin"
        elif z < 0.12:
            label = "shoe"
        elif z < 0.72:
            label = "pants"
        elif 1.420 < z < 1.640 and ax < 0.112 and y < -0.010:
            label = "skin"
        elif 1.475 < z < 1.640 and ax < 0.145:
            label = "hair"
        elif z >= 1.640:
            label = "uniform"
        polygon.material_index = slots[label]


def add_kid_features(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    objects: list[bpy.types.Object] = []
    for side in (-1.0, 1.0):
        x = side * 0.0435
        y = -0.1470
        eye = kit.add_uv_sphere(f"Kid_v20_Eye_{side:+.0f}", (x, y, 1.074), (0.0165, 0.0046, 0.0195), mats["eye_white"], 64, 32)
        iris = kit.add_uv_sphere(f"Kid_v20_Iris_{side:+.0f}", (x, y - 0.0042, 1.073), (0.0086, 0.0016, 0.0108), mats["iris"], 48, 24)
        pupil = kit.add_uv_sphere(f"Kid_v20_Pupil_{side:+.0f}", (x, y - 0.0057, 1.073), (0.0039, 0.0009, 0.0054), mats["pupil"], 40, 20)
        glint = kit.add_uv_sphere(f"Kid_v20_Glint_{side:+.0f}", (x - 0.0028, y - 0.0072, 1.079), (0.0019, 0.0005, 0.0025), mats["highlight"], 24, 12)
        brow = kit.add_curve(
            f"Kid_v20_Brow_{side:+.0f}",
            ((x - 0.020, y - 0.0045, 1.108), (x, y - 0.0060, 1.114), (x + 0.020, y - 0.0045, 1.109)),
            0.0022,
            mats["line"],
        )
        lid = kit.add_curve(
            f"Kid_v20_Lid_{side:+.0f}",
            ((x - 0.018, y - 0.0042, 1.078), (x, y - 0.0060, 1.089), (x + 0.018, y - 0.0042, 1.078)),
            0.0010,
            mats["line"],
        )
        objects.extend((eye, iris, pupil, glint, brow, lid))
    mouth = kit.add_curve(
        "Kid_v20_Mouth",
        ((-0.021, -0.151, 0.998), (0.0, -0.153, 0.994), (0.021, -0.151, 0.998)),
        0.0012,
        mats["mouth"],
    )
    objects.append(mouth)
    return objects


def add_adult_features(role: str, mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    if role == "Villain":
        face_center = (0.0, -0.145, 1.535)
        face_radii = (0.105, 0.063, 0.135)
        eye_x, eye_z, eye_y = 0.040, 1.568, -0.205
        eye_size = (0.0150, 0.0046, 0.0100)
        mouth_y, mouth_z = -0.210, 1.472
        ear_y = -0.112
        nose_bridge = (0.0, -0.202, 1.542)
        nose_tip = (0.0, -0.211, 1.516)
    else:
        face_center = (0.0, -0.095, 1.515)
        face_radii = (0.103, 0.069, 0.132)
        eye_x, eye_z, eye_y = 0.039, 1.548, -0.158
        eye_size = (0.0150, 0.0048, 0.0105)
        mouth_y, mouth_z = -0.164, 1.454
        ear_y = -0.060
        nose_bridge = (0.0, -0.155, 1.522)
        nose_tip = (0.0, -0.166, 1.497)
    objects: list[bpy.types.Object] = []
    for side in (-1.0, 1.0):
        x = side * eye_x
        eye = kit.add_uv_sphere(f"{role}_v20_Eye_{side:+.0f}", (x, eye_y, eye_z), eye_size, mats["eye_white"], 56, 28)
        iris = kit.add_uv_sphere(
            f"{role}_v20_Iris_{side:+.0f}",
            (x, eye_y - eye_size[1] * 0.88, eye_z),
            (eye_size[0] * 0.44, 0.0014, eye_size[2] * 0.60),
            mats["iris"],
            40,
            20,
        )
        pupil = kit.add_uv_sphere(
            f"{role}_v20_Pupil_{side:+.0f}",
            (x, eye_y - eye_size[1] * 1.08, eye_z),
            (eye_size[0] * 0.20, 0.0008, eye_size[2] * 0.29),
            mats["pupil"],
            32,
            16,
        )
        glint = kit.add_uv_sphere(
            f"{role}_v20_Glint_{side:+.0f}",
            (x - 0.0025, eye_y - eye_size[1] * 1.27, eye_z + 0.0027),
            (0.0016, 0.0005, 0.0019),
            mats.get("highlight", mats["eye_white"]),
            24,
            12,
        )
        brow = kit.add_curve(
            f"{role}_v20_Brow_{side:+.0f}",
            (
                (x - 0.017, eye_y - 0.0045, eye_z + 0.024),
                (x, eye_y - 0.0060, eye_z + (0.027 if role == "Police" else 0.024)),
                (x + 0.017, eye_y - 0.0045, eye_z + (0.022 if role == "Villain" else 0.024)),
            ),
            0.0020,
            mats["line"],
        )
        lid = kit.add_curve(
            f"{role}_v20_Lid_{side:+.0f}",
            ((x - 0.014, eye_y - 0.0035, eye_z + 0.001), (x, eye_y - 0.0050, eye_z + 0.008), (x + 0.014, eye_y - 0.0035, eye_z + 0.001)),
            0.0010,
            mats["line"],
        )
        objects.extend((eye, iris, pupil, glint, brow, lid))
    mouth = kit.add_curve(
        f"{role}_v20_Mouth",
        ((-0.022, mouth_y, mouth_z), (0.0, mouth_y - 0.002, mouth_z - 0.002), (0.022, mouth_y, mouth_z)),
        0.0013,
        mats["mouth"],
    )
    objects.append(mouth)
    return objects


def add_villain_accessories(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    goatee = kit.add_superellipsoid("Villain_v20_Goatee", (0.0, -0.207, 1.423), (0.016, 0.0025, 0.022), 0.80, mats["stubble"], 44, 22)
    moustache = kit.add_curve(
        "Villain_v20_Moustache",
        ((-0.022, -0.212, 1.498), (0.0, -0.215, 1.494), (0.022, -0.212, 1.498)),
        0.0014,
        mats["stubble"],
    )
    return [goatee, moustache]


def add_police_accessories(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    objects = [
        kit.add_superellipsoid("Police_v20_CapBadge", (0.0, -0.168, 1.715), (0.022, 0.0035, 0.030), 0.62, mats["metal"], 48, 28),
        kit.add_superellipsoid("Police_v20_ChestBadge", (0.105, -0.125, 1.238), (0.027, 0.0035, 0.038), 0.60, mats["metal"], 48, 28),
        kit.add_superellipsoid("Police_v20_Nameplate", (-0.092, -0.130, 1.252), (0.041, 0.0030, 0.008), 0.42, mats["metal"], 48, 20),
        kit.add_superellipsoid("Police_v20_BeltBuckle", (0.0, -0.138, 0.875), (0.036, 0.0045, 0.025), 0.46, mats["metal"], 48, 24),
    ]
    for index, z in enumerate((1.160, 1.100, 1.040)):
        objects.append(kit.add_uv_sphere(f"Police_v20_ShirtButton_{index}", (0.0, -0.128, z), (0.0055, 0.0022, 0.0055), mats["metal"], 28, 14))
    return objects


def render_views(role: str, character: list[bpy.types.Object]) -> None:
    out = REVIEW_ROOT / role
    out.mkdir(parents=True, exist_ok=True)
    low, high = kit.bounds(character)
    center = 0.5 * (low + high)
    width, depth, height = high.x - low.x, high.y - low.y, high.z - low.z
    distance = height * 3.0
    positions = {
        "front": Vector((center.x, center.y - distance, center.z + 0.015)),
        "side": Vector((center.x + distance, center.y, center.z + 0.015)),
        "top": Vector((center.x, center.y, center.z + distance)),
        "back": Vector((center.x, center.y + distance, center.z + 0.015)),
    }
    for view in ("front", "side", "top", "back"):
        bpy.ops.object.camera_add(location=positions[view])
        camera = bpy.context.object
        kit.look_at(camera, center)
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = max(height * 1.10, width * 1.35) if view != "top" else max(width, depth) * 1.34
        camera.data.lens = 70
        bpy.context.scene.camera = camera
        bpy.context.scene.render.resolution_x = 900
        bpy.context.scene.render.resolution_y = 1200 if view != "top" else 900
        bpy.context.scene.render.resolution_percentage = 100
        bpy.context.scene.render.filepath = str(out / f"{role}_v20_{view}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(camera, do_unlink=True)


def export(role: str, character: list[bpy.types.Object]) -> None:
    asset = ROOT / f"art-source/Characters/{role}/ReferenceStandard/PrecisionRemodel_2026_07_13_v20"
    asset.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(asset / f"{role}_PrecisionRemodel_v20.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in character:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = character[0]
    bpy.ops.export_scene.gltf(filepath=str(asset / f"{role}_PrecisionRemodel_v20.glb"), export_format="GLB", use_selection=True)
    bpy.ops.export_scene.fbx(
        filepath=str(asset / f"{role}_PrecisionRemodel_v20.fbx"),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        axis_forward="Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
    )


def build(role: str) -> None:
    kit.reset_scene()
    body = import_role(role)
    if role == "Kid":
        mats = kit.build_materials()
        assign_vertex_palette(body, role)
        details = add_kid_features(mats) + kit.add_backpack(mats) + kit.add_sock_stripes(mats) + kit.add_shoe_laces(mats)
    elif role == "Villain":
        mats = adults.villain_materials()
        mats["eye_white"] = kit.material("M_Villain_v20_EyeWhite_EyeGloss", (0.62, 0.52, 0.40, 1.0), 0.20, subsurface=0.012)
        mats["highlight"] = kit.material("M_Villain_v20_EyeHighlight", (1.0, 0.92, 0.78, 1.0), 0.08)
        deform_adult_head(body, role)
        assign_vertex_palette(body, role)
        details = add_adult_features(role, mats) + add_villain_accessories(mats)
    else:
        mats = adults.police_materials()
        mats["eye_white"] = kit.material("M_Police_v20_EyeWhite_EyeGloss", (0.78, 0.70, 0.58, 1.0), 0.18, subsurface=0.016)
        mats["highlight"] = kit.material("M_Police_v20_EyeHighlight", (1.0, 0.96, 0.88, 1.0), 0.07)
        deform_adult_head(body, role)
        assign_vertex_palette(body, role)
        details = add_adult_features(role, mats) + add_police_accessories(mats)
    details = kit.convert_curves(details)
    character = [body] + details
    kit.setup_studio()
    render_views(role, character)
    export(role, character)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("roles", nargs="*", choices=tuple(SPECS))
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    for role in args.roles or tuple(SPECS):
        build(role)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
