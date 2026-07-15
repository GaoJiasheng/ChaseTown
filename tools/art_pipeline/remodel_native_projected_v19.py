#!/usr/bin/env python3
"""Build v19 review characters from the native multiview sculpts.

The v18 pass covered the generated face with primitive geometry.  This pass
keeps the source head and facial planes intact and applies the approved
turnaround art with view-dependent projection.  Exact orthographic reviews
therefore show the intended face, hair, clothing, and accessory design without
floating replacement surfaces.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
REFERENCE_DIR = ROOT / "docs/art_production/fourview_remodel_v17/references/crops"
REVIEW_ROOT = ROOT / "docs/art_production/fourview_remodel_v19_native_projected"
MASKED_REFERENCE_DIR = REVIEW_ROOT / "masked_references"

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


def reset_scene(role: str) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world = bpy.data.worlds.new(f"{role}_v19_Studio")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.055, 0.060, 0.068, 1.0)
    background.inputs["Strength"].default_value = 0.38


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return low, high


def import_native(role: str) -> bpy.types.Object:
    spec = SPECS[role]
    bpy.ops.import_scene.gltf(filepath=str(spec["source"]))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No source mesh for {role}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.object
    low, high = world_bounds([obj])
    scale = spec["height"] / max(high.z - low.z, 1e-6)
    obj.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    low, high = world_bounds([obj])
    obj.location = (-0.5 * (low.x + high.x), -0.5 * (low.y + high.y), -low.z)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    obj.name = f"{role}_v19_NativeMultiviewSculpt"
    for polygon in obj.data.polygons:
        polygon.use_smooth = True

    # A conservative corrective smooth removes marching-cubes banding while
    # preserving the generated eyes, nose, lips, hat edge, and garment folds.
    smooth = obj.modifiers.new("NativeSurfacePolish", "CORRECTIVE_SMOOTH")
    smooth.factor = 0.18
    smooth.iterations = 2
    smooth.scale = 1.0
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    return obj


def projected_material(role: str, view: str) -> bpy.types.Material:
    image_path = REFERENCE_DIR / f"{role}_{view}.png"
    image = bpy.data.images.load(str(image_path), check_existing=True)
    image.colorspace_settings.name = "sRGB"
    mat = bpy.data.materials.new(f"M_{role}_v19_{view.title()}Projection")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Linear"
    texture.extension = "EXTEND"
    bsdf.inputs["Roughness"].default_value = 0.52 if role == "Kid" else 0.56
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.30
    links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return mat


def projection_window(role: str, view: str) -> tuple[float, float, float, float]:
    # The reference crops retain a thin studio-background border.  Mapping the
    # generated mesh into this inset aligns the source silhouette to the art.
    horizontal = 0.030
    vertical_bottom = 0.028
    vertical_top = 0.978
    if view == "right":
        horizontal = 0.055 if role == "Kid" else 0.035
    if role == "Police" and view in {"front", "back"}:
        horizontal = 0.035
    if role == "Villain":
        vertical_bottom = 0.020
        vertical_top = 0.982
    return horizontal, 1.0 - horizontal, vertical_bottom, vertical_top


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def assign_multiview_projection(obj: bpy.types.Object, role: str) -> None:
    mesh = obj.data
    mesh.materials.clear()
    views = ("front", "right", "back", "top")
    for view in views:
        mesh.materials.append(projected_material(role, view))
    view_index = {name: index for index, name in enumerate(views)}
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    uv_layer = mesh.uv_layers.new(name="MultiviewProjectionUV")

    coords = [vertex.co for vertex in mesh.vertices]
    min_x, max_x = min(co.x for co in coords), max(co.x for co in coords)
    min_y, max_y = min(co.y for co in coords), max(co.y for co in coords)
    min_z, max_z = min(co.z for co in coords), max(co.z for co in coords)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    span_z = max(max_z - min_z, 1e-6)

    for polygon in mesh.polygons:
        normal = polygon.normal.normalized()
        if normal.z > 0.60:
            view = "top"
        elif abs(normal.x) > abs(normal.y) * 0.92:
            view = "right"
        elif normal.y < 0.0:
            view = "front"
        else:
            view = "back"
        polygon.material_index = view_index[view]
        u0, u1, v0, v1 = projection_window(role, view)

        for loop_index in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            xn = clamp((co.x - min_x) / span_x, 0.0, 1.0)
            yn = clamp((co.y - min_y) / span_y, 0.0, 1.0)
            zn = clamp((co.z - min_z) / span_z, 0.0, 1.0)
            if view == "front":
                u, v = xn, zn
            elif view == "back":
                u, v = 1.0 - xn, zn
            elif view == "right":
                # Both sides use the approved right profile.  Mirroring the
                # hidden side avoids reversed face and uniform details.
                u = 1.0 - yn if normal.x < 0.0 else yn
                v = zn
            else:
                u = xn
                v = 1.0 - yn
            uv_layer.data[loop_index].uv = (u0 + u * (u1 - u0), v0 + v * (v1 - v0))


def vertex_color_material(role: str) -> bpy.types.Material:
    mat = bpy.data.materials.new(f"M_{role}_v19_ContinuousMultiviewColor")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    colors = nodes.new("ShaderNodeVertexColor")
    colors.layer_name = "RemodelColor"
    emission.inputs["Strength"].default_value = 0.88
    links.new(colors.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return mat


def load_masked_view(role: str, view: str) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    image = bpy.data.images.load(str(MASKED_REFERENCE_DIR / f"{role}_{view}.png"), check_existing=True)
    width, height = image.size
    pixels = np.asarray(image.pixels[:], dtype=np.float32).reshape(height, width, 4)
    ys, xs = np.where(pixels[:, :, 3] > 0.08)
    if len(xs) == 0:
        raise RuntimeError(f"Empty alpha mask for {role} {view}")
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    return pixels, bbox


def bilinear_sample(image: np.ndarray, u: float, v: float) -> np.ndarray:
    height, width = image.shape[:2]
    x = clamp(u, 0.0, 1.0) * (width - 1)
    y = clamp(v, 0.0, 1.0) * (height - 1)
    x0, y0 = int(math.floor(x)), int(math.floor(y))
    x1, y1 = min(x0 + 1, width - 1), min(y0 + 1, height - 1)
    tx, ty = x - x0, y - y0
    top = image[y0, x0] * (1.0 - tx) + image[y0, x1] * tx
    bottom = image[y1, x0] * (1.0 - tx) + image[y1, x1] * tx
    return top * (1.0 - ty) + bottom * ty


def masked_uv(
    bbox: tuple[int, int, int, int],
    shape: tuple[int, ...],
    horizontal: float,
    vertical: float,
) -> tuple[float, float]:
    height, width = shape[:2]
    x0, y0, x1, y1 = bbox
    inset_x = max(1.0, (x1 - x0) * 0.006)
    inset_y = max(1.0, (y1 - y0) * 0.004)
    u = (x0 + inset_x + horizontal * max(1.0, x1 - x0 - 2.0 * inset_x)) / max(width - 1, 1)
    v = (y0 + inset_y + vertical * max(1.0, y1 - y0 - 2.0 * inset_y)) / max(height - 1, 1)
    return u, v


def fallback_color(role: str, x: float, y: float, z: float) -> np.ndarray:
    if role == "Kid":
        if z > 0.80:
            return np.array((0.055, 0.030, 0.018, 1.0), dtype=np.float32)
        if z < 0.12:
            return np.array((0.055, 0.070, 0.105, 1.0), dtype=np.float32)
        if z < 0.46:
            return np.array((0.035, 0.038, 0.043, 1.0), dtype=np.float32)
        return np.array((0.030, 0.055, 0.115, 1.0), dtype=np.float32)
    if role == "Police":
        return np.array((0.028, 0.055, 0.105, 1.0), dtype=np.float32)
    return np.array((0.025, 0.022, 0.020, 1.0), dtype=np.float32)


def assign_continuous_vertex_projection(obj: bpy.types.Object, role: str) -> None:
    mesh = obj.data
    mesh.materials.clear()
    mesh.materials.append(vertex_color_material(role))
    while mesh.color_attributes:
        mesh.color_attributes.remove(mesh.color_attributes[0])
    colors = mesh.color_attributes.new(name="RemodelColor", type="FLOAT_COLOR", domain="POINT")
    views = {view: load_masked_view(role, view) for view in ("front", "right", "back", "top")}

    coords = [vertex.co for vertex in mesh.vertices]
    min_x, max_x = min(co.x for co in coords), max(co.x for co in coords)
    min_y, max_y = min(co.y for co in coords), max(co.y for co in coords)
    min_z, max_z = min(co.z for co in coords), max(co.z for co in coords)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    span_z = max(max_z - min_z, 1e-6)

    for polygon in mesh.polygons:
        polygon.material_index = 0
    for vertex in mesh.vertices:
        co = vertex.co
        normal = vertex.normal.normalized()
        xn = clamp((co.x - min_x) / span_x, 0.0, 1.0)
        yn = clamp((co.y - min_y) / span_y, 0.0, 1.0)
        zn = clamp((co.z - min_z) / span_z, 0.0, 1.0)
        projections = {
            "front": (xn, zn, max(-normal.y, 0.0) ** 8),
            "back": (1.0 - xn, zn, max(normal.y, 0.0) ** 8),
            "right": ((1.0 - yn) if normal.x < 0.0 else yn, zn, abs(normal.x) ** 8),
            "top": (xn, 1.0 - yn, max(normal.z, 0.0) ** 8),
        }
        accumulated = np.zeros(4, dtype=np.float32)
        total_weight = 0.0
        for view, (horizontal, vertical, normal_weight) in projections.items():
            if normal_weight <= 1e-7:
                continue
            image, bbox = views[view]
            u, v = masked_uv(bbox, image.shape, horizontal, vertical)
            sample = bilinear_sample(image, u, v)
            alpha_weight = float(sample[3]) ** 3
            weight = normal_weight * alpha_weight
            if weight <= 1e-7:
                continue
            accumulated += sample * weight
            total_weight += weight
        if total_weight > 1e-6:
            color = accumulated / total_weight
            color[3] = 1.0
        else:
            color = fallback_color(role, xn, yn, zn)
        colors.data[vertex.index].color = tuple(float(channel) for channel in color)


def add_studio(height: float) -> list[bpy.types.Object]:
    lights: list[bpy.types.Object] = []
    for name, location, energy, size, color in (
        ("Key", (-2.4, -3.4, height * 1.35), 920.0, 4.0, (1.0, 0.90, 0.82)),
        ("Fill", (2.8, -2.0, height * 0.92), 560.0, 3.4, (0.72, 0.84, 1.0)),
        ("Rim", (1.5, 2.4, height * 1.55), 760.0, 3.0, (0.78, 0.86, 1.0)),
    ):
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = f"v19_{name}"
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        lights.append(light)
    bpy.ops.mesh.primitive_plane_add(size=12.0, location=(0.0, 0.0, -0.008))
    floor = bpy.context.object
    floor.name = "v19_ReviewFloor"
    floor_mat = bpy.data.materials.new("M_v19_ReviewFloor")
    floor_mat.use_nodes = True
    bsdf = floor_mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.105, 0.115, 0.128, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.82
    floor.data.materials.append(floor_mat)
    return lights + [floor]


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def render_views(role: str, character: list[bpy.types.Object]) -> None:
    out = REVIEW_ROOT / role
    out.mkdir(parents=True, exist_ok=True)
    low, high = world_bounds(character)
    center = 0.5 * (low + high)
    height = high.z - low.z
    width = high.x - low.x
    depth = high.y - low.y
    distance = height * 3.0
    positions = {
        "front": Vector((center.x, center.y - distance, center.z + 0.015)),
        "side": Vector((center.x - distance, center.y, center.z + 0.015)),
        "top": Vector((center.x, center.y, center.z + distance)),
        "back": Vector((center.x, center.y + distance, center.z + 0.015)),
    }
    for view in ("front", "side", "top", "back"):
        bpy.ops.object.camera_add(location=positions[view])
        camera = bpy.context.object
        camera.name = f"v19_{role}_{view}_Camera"
        look_at(camera, center)
        camera.data.type = "ORTHO"
        camera.data.lens = 72
        camera.data.ortho_scale = max(height * 1.10, width * 1.34) if view != "top" else max(width, depth) * 1.34
        bpy.context.scene.camera = camera
        bpy.context.scene.render.resolution_x = 960
        bpy.context.scene.render.resolution_y = 1280 if view != "top" else 960
        bpy.context.scene.render.resolution_percentage = 100
        bpy.context.scene.render.filepath = str(out / f"{role}_v19_{view}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(camera, do_unlink=True)


def export_character(role: str, character: list[bpy.types.Object]) -> None:
    asset_dir = ROOT / f"art-source/Characters/{role}/ReferenceStandard/PrecisionRemodel_2026_07_13_v19"
    asset_dir.mkdir(parents=True, exist_ok=True)
    blend_path = asset_dir / f"{role}_PrecisionRemodel_v19.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in character:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = character[0]
    bpy.ops.export_scene.gltf(
        filepath=str(asset_dir / f"{role}_PrecisionRemodel_v19.glb"),
        export_format="GLB",
        use_selection=True,
        export_image_format="AUTO",
    )
    bpy.ops.export_scene.fbx(
        filepath=str(asset_dir / f"{role}_PrecisionRemodel_v19.fbx"),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        axis_forward="Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
    )


def build(role: str) -> None:
    reset_scene(role)
    mesh = import_native(role)
    assign_continuous_vertex_projection(mesh, role)
    add_studio(SPECS[role]["height"])
    character = [mesh]
    render_views(role, character)
    export_character(role, character)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("roles", nargs="*", choices=tuple(SPECS), default=list(SPECS))
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    roles = args.roles or list(SPECS)
    for role in roles:
        build(role)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
