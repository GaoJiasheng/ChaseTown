#!/usr/bin/env python3
"""Create the v18 kid visual pilot from the approved multiview sculpt.

The source mesh supplies the dense silhouette and garment folds.  This pass
keeps those surfaces intact and rebuilds presentation-critical parts as
separate meshes and physically distinct materials before four-view review.
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/art_production/hunyuan_reference_standard_kid_v13/kid_reference_standard_hunyuan_multiview.glb"
REFERENCE_DIR = ROOT / "docs/art_production/fourview_remodel_v17/references/crops"
OUT = ROOT / "docs/art_production/fourview_remodel_v18_pilot/Kid"
ASSET_OUT = ROOT / "art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v18"
HEIGHT = 1.30


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1200
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world = bpy.data.worlds.new("Kid_v18_Studio")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.022, 0.025, 0.030, 1.0)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.24


def bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return low, high


def import_and_normalize() -> bpy.types.Object:
    bpy.ops.import_scene.gltf(filepath=str(SOURCE))
    objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not objects:
        raise RuntimeError("No source mesh")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    obj = bpy.context.object
    low, high = bounds([obj])
    scale = HEIGHT / (high.z - low.z)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    low, high = bounds([obj])
    obj.location = (-0.5 * (low.x + high.x), -0.5 * (low.y + high.y), -low.z)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    obj.name = "Kid_v18_HighRes_BodyGarments"
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def material(
    name: str,
    base: tuple[float, float, float, float],
    roughness: float,
    *,
    metallic: float = 0.0,
    noise_scale: float = 0.0,
    noise_strength: float = 0.0,
    subsurface: float = 0.0,
    sheen: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if "Specular IOR Level" in bsdf.inputs and metallic < 0.5:
        bsdf.inputs["Specular IOR Level"].default_value = 0.30
    if "Subsurface Weight" in bsdf.inputs:
        bsdf.inputs["Subsurface Weight"].default_value = subsurface
    if "Coat Weight" in bsdf.inputs and name.endswith("EyeGloss"):
        bsdf.inputs["Coat Weight"].default_value = 0.34
        bsdf.inputs["Coat Roughness"].default_value = 0.10
    if "Sheen Weight" in bsdf.inputs:
        bsdf.inputs["Sheen Weight"].default_value = sheen
    if noise_scale > 0.0 and noise_strength > 0.0:
        noise = nodes.new("ShaderNodeTexNoise")
        noise.noise_dimensions = "3D"
        noise.inputs["Scale"].default_value = noise_scale
        noise.inputs["Detail"].default_value = 4.0
        noise.inputs["Roughness"].default_value = 0.62
        bump = nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = noise_strength
        bump.inputs["Distance"].default_value = 0.012
        links.new(noise.outputs["Fac"], bump.inputs["Height"])
        links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return mat


def build_materials() -> dict[str, bpy.types.Material]:
    return {
        "skin": material("M_Kid_Skin", (0.46, 0.170, 0.075, 1), 0.56, noise_scale=92, noise_strength=0.020, subsurface=0.085),
        "skin_blush": material("M_Kid_SkinBlush", (0.67, 0.13, 0.075, 1), 0.54, subsurface=0.07),
        "hair": material("M_Kid_Hair", (0.0035, 0.0018, 0.0010, 1), 0.64, noise_scale=190, noise_strength=0.040, sheen=0.015),
        "hoodie": material("M_Kid_HoodieNavy", (0.004, 0.010, 0.030, 1), 0.76, noise_scale=235, noise_strength=0.11, sheen=0.035),
        "shorts": material("M_Kid_Shorts", (0.007, 0.0075, 0.009, 1), 0.72, noise_scale=185, noise_strength=0.07),
        "sock": material("M_Kid_Sock", (0.57, 0.58, 0.55, 1), 0.84, noise_scale=220, noise_strength=0.10),
        "shoe": material("M_Kid_ShoeCanvas", (0.006, 0.014, 0.034, 1), 0.66, noise_scale=145, noise_strength=0.07),
        "rubber": material("M_Kid_ShoeRubber", (0.44, 0.40, 0.33, 1), 0.74, noise_scale=86, noise_strength=0.04),
        "pack": material("M_Kid_BackpackNavy", (0.005, 0.015, 0.042, 1), 0.76, noise_scale=190, noise_strength=0.10, sheen=0.025),
        "pack_trim": material("M_Kid_BackpackTrim", (0.007, 0.006, 0.005, 1), 0.60, noise_scale=120, noise_strength=0.05),
        "leather": material("M_Kid_BackpackLeather", (0.095, 0.025, 0.008, 1), 0.56, noise_scale=72, noise_strength=0.05),
        "metal": material("M_Kid_ZipperMetal", (0.23, 0.25, 0.28, 1), 0.30, metallic=0.78, noise_scale=70, noise_strength=0.02),
        "eye_white": material("M_Kid_EyeWhite_EyeGloss", (0.78, 0.70, 0.58, 1), 0.20, subsurface=0.02),
        "iris": material("M_Kid_IrisBrown_EyeGloss", (0.12, 0.026, 0.0045, 1), 0.18),
        "pupil": material("M_Kid_Pupil_EyeGloss", (0.003, 0.002, 0.001, 1), 0.10),
        "highlight": material("M_Kid_EyeHighlight", (1.0, 0.96, 0.88, 1), 0.08),
        "line": material("M_Kid_FacialHair", (0.018, 0.008, 0.004, 1), 0.44),
        "mouth": material("M_Kid_MouthLine", (0.20, 0.035, 0.025, 1), 0.52, subsurface=0.03),
    }


def assign_body_materials(obj: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    order = ("skin", "hair", "hoodie", "shorts", "sock", "shoe", "rubber")
    for name in order:
        obj.data.materials.append(mats[name])
    slots = {name: index for index, name in enumerate(order)}

    for poly in obj.data.polygons:
        center = sum((obj.data.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
        x, y, z = center
        ax = abs(x)
        label = "hoodie"
        if z < 0.070:
            label = "rubber"
        elif z < 0.135:
            label = "shoe"
        elif z < 0.245 and ax < 0.155:
            label = "sock"
        elif 0.400 < z < 0.590 and ax > 0.180:
            label = "skin"
        elif z < 0.380 and ax < 0.155:
            label = "skin"
        elif z < 0.585:
            label = "shorts"
        elif z > 0.935:
            label = "hair"
        poly.material_index = slots[label]


def add_uv_sphere(name: str, center, radii, mat: bpy.types.Material, segments=64, rings=32) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.scale = radii
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_curve(name: str, points, bevel: float, mat: bpy.types.Material, cyclic=False) -> bpy.types.Object:
    curve = bpy.data.curves.new(name + "_Curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 8
    curve.bevel_depth = bevel
    curve.bevel_resolution = 5
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    spline.use_cyclic_u = cyclic
    for bp, point in zip(spline.bezier_points, points):
        bp.co = point
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def add_superellipsoid(name: str, center, radii, exponent: float, mat: bpy.types.Material, segments=72, rings=40) -> bpy.types.Object:
    vertices = []
    faces = []

    def sp(value: float, power: float) -> float:
        return math.copysign(abs(value) ** power, value)

    for ring in range(rings + 1):
        latitude = -math.pi * 0.5 + math.pi * ring / rings
        for segment in range(segments):
            longitude = 2.0 * math.pi * segment / segments
            cl, sl = math.cos(latitude), math.sin(latitude)
            co, si = math.cos(longitude), math.sin(longitude)
            vertices.append((
                center[0] + radii[0] * sp(cl, exponent) * sp(co, exponent),
                center[1] + radii[1] * sp(cl, exponent) * sp(si, exponent),
                center[2] + radii[2] * sp(sl, exponent),
            ))
    for ring in range(rings):
        for segment in range(segments):
            a = ring * segments + segment
            b = ring * segments + (segment + 1) % segments
            c = (ring + 1) * segments + (segment + 1) % segments
            d = (ring + 1) * segments + segment
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new("SoftTailoredEdges", "BEVEL")
    bevel.width = min(radii) * 0.065
    bevel.segments = 4
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return obj


def add_face(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    face = add_superellipsoid("Kid_CleanFace", (0.0, -0.102, 1.044), (0.106, 0.054, 0.121), 0.96, mats["skin"], 96, 56)
    left_ear = add_uv_sphere("Kid_Ear_L", (-0.109, -0.059, 1.046), (0.016, 0.013, 0.028), mats["skin"], 48, 24)
    right_ear = add_uv_sphere("Kid_Ear_R", (0.109, -0.059, 1.046), (0.016, 0.013, 0.028), mats["skin"], 48, 24)
    nose = add_uv_sphere("Kid_Nose", (0.0, -0.160, 1.035), (0.0095, 0.0080, 0.0140), mats["skin"], 48, 24)
    objects = [face, left_ear, right_ear, nose]
    for side in (-1.0, 1.0):
        x = side * 0.0435
        y = -0.154
        eye = add_uv_sphere(f"Kid_Eye_{side:+.0f}", (x, y, 1.074), (0.0205, 0.0080, 0.0240), mats["eye_white"])
        iris = add_uv_sphere(f"Kid_Iris_{side:+.0f}", (x, y - 0.0073, 1.073), (0.0105, 0.0025, 0.0132), mats["iris"], 48, 24)
        pupil = add_uv_sphere(f"Kid_Pupil_{side:+.0f}", (x, y - 0.0095, 1.073), (0.0048, 0.0014, 0.0065), mats["pupil"], 40, 20)
        glint = add_uv_sphere(f"Kid_EyeGlint_{side:+.0f}", (x - 0.0032, y - 0.0120, 1.080), (0.0022, 0.0008, 0.0030), mats["highlight"], 24, 12)
        brow = add_curve(
            f"Kid_Brow_{side:+.0f}",
            ((x - 0.020, y - 0.0065, 1.108), (x, y - 0.0076, 1.115), (x + 0.020, y - 0.0065, 1.109)),
            0.0024,
            mats["line"],
        )
        lid = add_curve(
            f"Kid_UpperLid_{side:+.0f}",
            ((x - 0.020, y - 0.0060, 1.078), (x, y - 0.0072, 1.091), (x + 0.020, y - 0.0060, 1.078)),
            0.0012,
            mats["line"],
        )
        objects.extend((eye, iris, pupil, glint, brow, lid))
    mouth = add_curve(
        "Kid_Mouth",
        ((-0.022, -0.1640, 0.997), (0.0, -0.1670, 0.992), (0.022, -0.1640, 0.997)),
        0.0014,
        mats["mouth"],
    )
    objects.append(mouth)
    return objects


def add_backpack(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    objects: list[bpy.types.Object] = []
    body = add_superellipsoid("Kid_Backpack_Main", (0.0, 0.188, 0.700), (0.132, 0.064, 0.188), 0.60, mats["pack"])
    pocket = add_superellipsoid("Kid_Backpack_Pocket", (0.0, 0.245, 0.645), (0.101, 0.031, 0.082), 0.60, mats["pack"])
    bottom = add_superellipsoid("Kid_Backpack_LeatherBase", (0.0, 0.238, 0.520), (0.116, 0.032, 0.033), 0.65, mats["leather"], 64, 32)
    handle = add_curve("Kid_Backpack_Handle", ((-0.040, 0.207, 0.875), (0.0, 0.245, 0.904), (0.040, 0.207, 0.875)), 0.0058, mats["pack_trim"])
    zipper = add_curve("Kid_Backpack_Zipper", ((-0.099, 0.265, 0.715), (0.0, 0.275, 0.747), (0.099, 0.265, 0.715)), 0.0019, mats["metal"])
    pocket_zip = add_curve("Kid_Backpack_PocketZipper", ((-0.076, 0.276, 0.675), (0.0, 0.282, 0.685), (0.076, 0.276, 0.675)), 0.0017, mats["metal"])
    objects.extend((body, pocket, bottom, handle, zipper, pocket_zip))
    for side in (-1.0, 1.0):
        strap = add_curve(
            f"Kid_Backpack_Strap_{side:+.0f}",
            ((side * 0.105, -0.100, 0.920), (side * 0.145, -0.145, 0.760), (side * 0.135, -0.130, 0.585)),
            0.0105,
            mats["pack_trim"],
        )
        adjuster = add_superellipsoid(
            f"Kid_Backpack_Adjuster_{side:+.0f}",
            (side * 0.141, -0.151, 0.695),
            (0.017, 0.007, 0.026),
            0.45,
            mats["metal"],
            36,
            20,
        )
        objects.extend((strap, adjuster))
    return objects


def add_sock_stripes(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    objects = []
    for side in (-1.0, 1.0):
        for index, z in enumerate((0.204, 0.220)):
            bpy.ops.mesh.primitive_torus_add(major_radius=0.032, minor_radius=0.0034, major_segments=48, minor_segments=12, location=(side * 0.083, 0.0, z))
            ring = bpy.context.object
            ring.name = f"Kid_SockStripe_{side:+.0f}_{index}"
            ring.data.materials.append(mats["hoodie"])
            objects.append(ring)
    return objects


def add_shoe_laces(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    objects = []
    for side in (-1.0, 1.0):
        foot_x = side * 0.083
        for index, (y, z) in enumerate(((-0.050, 0.074), (-0.060, 0.066), (-0.070, 0.058), (-0.080, 0.050))):
            lace = add_curve(
                f"Kid_ShoeLace_{side:+.0f}_{index}",
                ((foot_x - 0.025, y, z), (foot_x, y - 0.004, z + 0.002), (foot_x + 0.025, y, z)),
                0.0018,
                mats["sock"],
            )
            objects.append(lace)
    return objects


def convert_curves(objects: list[bpy.types.Object]) -> list[bpy.types.Object]:
    converted = []
    for obj in objects:
        if obj.type == "CURVE":
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.convert(target="MESH")
            obj = bpy.context.object
            obj.select_set(False)
        for modifier in list(obj.modifiers):
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            try:
                bpy.ops.object.modifier_apply(modifier=modifier.name)
            except RuntimeError:
                pass
            obj.select_set(False)
        converted.append(obj)
    return converted


def setup_studio() -> None:
    def area(name, location, energy, size, color):
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        return light

    area("Key_Softbox", (-2.4, -3.0, 2.45), 720, 3.7, (1.0, 0.86, 0.73))
    area("Fill_Softbox", (2.3, -1.7, 1.55), 430, 3.3, (0.72, 0.84, 1.0))
    area("Rim_Softbox", (1.2, 2.7, 2.15), 620, 3.0, (0.88, 0.93, 1.0))
    area("Top_Softbox", (-0.5, 0.0, 3.2), 350, 2.4, (1.0, 0.97, 0.90))
    bpy.ops.mesh.primitive_plane_add(size=12, location=(0.0, 0.0, -0.006))
    floor = bpy.context.object
    floor.name = "Studio_Floor"
    floor.data.materials.append(material("M_StudioFloor", (0.075, 0.080, 0.090, 1), 0.82, noise_scale=34, noise_strength=0.025))


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def render_views(character_objects: list[bpy.types.Object]) -> None:
    low, high = bounds(character_objects)
    center = (low + high) * 0.5
    width, depth, height = high.x - low.x, high.y - low.y, high.z - low.z
    distance = height * 3.0
    views = {
        "front": Vector((center.x, center.y - distance, center.z + 0.015)),
        "right": Vector((center.x + distance, center.y, center.z + 0.015)),
        "back": Vector((center.x, center.y + distance, center.z + 0.015)),
        "top": Vector((center.x, center.y - 0.001, center.z + distance)),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ("front", "right", "top", "back"):
        bpy.ops.object.camera_add(location=views[name])
        camera = bpy.context.object
        camera.name = f"Camera_{name}"
        look_at(camera, center)
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = max(height * 1.10, width * 1.35) if name != "top" else max(width, depth) * 1.34
        camera.data.lens = 70
        bpy.context.scene.camera = camera
        bpy.context.scene.render.resolution_x = 900
        bpy.context.scene.render.resolution_y = 1200 if name != "top" else 900
        bpy.context.scene.render.filepath = str(OUT / f"Kid_v18_{name}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(camera, do_unlink=True)


def save_and_export(character_objects: list[bpy.types.Object]) -> None:
    ASSET_OUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(ASSET_OUT / "Kid_PrecisionRemodel_v18.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in character_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = character_objects[0]
    bpy.ops.export_scene.gltf(filepath=str(ASSET_OUT / "Kid_PrecisionRemodel_v18.glb"), export_format="GLB", use_selection=True)
    bpy.ops.export_scene.fbx(
        filepath=str(ASSET_OUT / "Kid_PrecisionRemodel_v18.fbx"),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        axis_forward="Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
    )


def main() -> None:
    reset_scene()
    body = import_and_normalize()
    mats = build_materials()
    assign_body_materials(body, mats)
    detail_objects = add_face(mats) + add_backpack(mats) + add_sock_stripes(mats) + add_shoe_laces(mats)
    detail_objects = convert_curves(detail_objects)
    character_objects = [body] + detail_objects
    setup_studio()
    render_views(character_objects)
    save_and_export(character_objects)


if __name__ == "__main__":
    main()
