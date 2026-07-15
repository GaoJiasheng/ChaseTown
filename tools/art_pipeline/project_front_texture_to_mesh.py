"""Project a front-view character image onto a Hunyuan mesh.

This creates a visually useful prototype from a good image-to-3D shape when the
public texture-generation endpoint is unavailable. It is not a hand-authored UV
unwrap, but it gives a much stronger front-view review asset than flat region
materials.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import bpy
from mathutils import Vector


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


def collect_and_join(object_name: str) -> bpy.types.Object:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh imported")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = object_name
    return obj


def normalize_height(obj: bpy.types.Object, target_height: float) -> None:
    zs = [(obj.matrix_world @ v.co).z for v in obj.data.vertices]
    scale = target_height / max(max(zs) - min(zs), 1e-5)
    obj.scale = (scale, scale, scale)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    min_z = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    obj.location.z -= min_z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def triangle_count(obj: bpy.types.Object) -> int:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    mesh.calc_loop_triangles()
    count = len(mesh.loop_triangles)
    eval_obj.to_mesh_clear()
    return count


def decimate(obj: bpy.types.Object, target_tris: int) -> int:
    current = triangle_count(obj)
    if current <= target_tris:
        return current
    mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
    mod.ratio = max(0.08, min(0.95, target_tris / current))
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return triangle_count(obj)


def assign_projected_uv(
    obj: bpy.types.Object,
    image_path: Path,
    material_name: str = "M_Kid_Stylized_FrontProjected",
    force_front_material: bool = False,
    use_image_alpha: bool = False,
    uv_left: float = 0.18,
    uv_width: float = 0.64,
    uv_bottom: float = 0.04,
    uv_height: float = 0.92,
) -> None:
    mesh = obj.data
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    uv = mesh.uv_layers.new(name="FrontProjectionUV")

    coords = [v.co for v in mesh.vertices]
    min_x, max_x = min(v.x for v in coords), max(v.x for v in coords)
    min_z, max_z = min(v.z for v in coords), max(v.z for v in coords)
    x_span = max(max_x - min_x, 1e-5)
    z_span = max(max_z - min_z, 1e-5)

    # The generated reference image has generous horizontal padding and little
    # vertical padding. Keep that framing to line up face, hoodie, shorts, shoes.
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            u = uv_left + ((co.x - min_x) / x_span) * uv_width
            v = uv_bottom + ((co.z - min_z) / z_span) * uv_height
            uv.data[li].uv = (max(0.0, min(1.0, u)), max(0.0, min(1.0, v)))

    front_mat = bpy.data.materials.new(material_name)
    front_mat.use_nodes = True
    if use_image_alpha:
        front_mat.diffuse_color = (1, 1, 1, 1)
        try:
            front_mat.blend_method = "BLEND"
            front_mat.use_screen_refraction = True
            front_mat.show_transparent_back = False
        except Exception:
            pass
    nodes = front_mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        tex = nodes.new(type="ShaderNodeTexImage")
        tex.image = bpy.data.images.load(str(image_path))
        tex.extension = "EXTEND"
        front_mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if use_image_alpha and "Alpha" in bsdf.inputs:
            front_mat.node_tree.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        bsdf.inputs["Roughness"].default_value = 0.62

    def fallback_mat(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.diffuse_color = color
        node = mat.node_tree.nodes.get("Principled BSDF")
        if node:
            node.inputs["Base Color"].default_value = color
            node.inputs["Roughness"].default_value = roughness
        return mat

    fallback = [
        front_mat,
        fallback_mat("M_Back_Skin_Warm", (0.86, 0.56, 0.42, 1), 0.58),
        fallback_mat("M_Back_Hair_Dark", (0.035, 0.028, 0.023, 1), 0.46),
        fallback_mat("M_Back_Hoodie_Navy", (0.018, 0.045, 0.115, 1), 0.76),
        fallback_mat("M_Back_Shorts_Black", (0.018, 0.017, 0.016, 1), 0.72),
        fallback_mat("M_Back_Socks_White", (0.88, 0.86, 0.78, 1), 0.62),
        fallback_mat("M_Back_Sneaker_Red", (0.58, 0.075, 0.045, 1), 0.50),
        fallback_mat("M_Back_Backpack_Black", (0.012, 0.012, 0.013, 1), 0.66),
    ]
    mesh.materials.clear()
    for mat in fallback:
        mesh.materials.append(mat)

    def region_index(center: Vector) -> int:
        z = (center.z - min_z) / max(z_span, 1e-5)
        x = abs((center.x - (min_x + max_x) * 0.5) / x_span)
        if z < 0.095:
            return 6
        if z < 0.22:
            return 5
        if 0.22 <= z < 0.43 and x < 0.22:
            return 4
        if z > 0.87:
            return 2
        if 0.42 <= z < 0.77:
            if x > 0.31 and z < 0.50:
                return 1
            if 0.15 < x < 0.31:
                return 7
            return 3
        if 0.72 <= z < 0.86:
            return 1
        return 1

    for poly in mesh.polygons:
        center = sum((mesh.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
        poly.material_index = 0 if force_front_material or poly.normal.y < -0.68 else region_index(center)
        poly.use_smooth = True
    try:
        mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception:
        pass


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_render(height: float) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.2, -4.0, height * 1.55))
    key = bpy.context.object
    key.data.energy = 680
    key.data.size = 4.5
    bpy.ops.object.camera_add(location=(0.0, -4.0, height * 0.56))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, height * 0.52)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = height * 1.16
    bpy.context.scene.camera = cam


def render(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def export(obj: bpy.types.Object, glb: Path, fbx: Path) -> None:
    glb.parent.mkdir(parents=True, exist_ok=True)
    fbx.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--out-glb", required=True)
    parser.add_argument("--out-fbx", required=True)
    parser.add_argument("--preview", required=True)
    parser.add_argument("--target-tris", type=int, default=60000)
    parser.add_argument("--target-height", type=float, default=1.30)
    parser.add_argument("--force-front-material", action="store_true")
    parser.add_argument("--use-image-alpha", action="store_true")
    parser.add_argument("--uv-left", type=float, default=0.18)
    parser.add_argument("--uv-width", type=float, default=0.64)
    parser.add_argument("--uv-bottom", type=float, default=0.04)
    parser.add_argument("--uv-height", type=float, default=0.92)
    parser.add_argument("--object-name", default="Kid_Stylized_Hunyuan_ProjectTex")
    parser.add_argument("--material-name", default="M_Kid_Stylized_FrontProjected")
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    args = parser.parse_args(argv)

    reset_scene()
    bpy.ops.import_scene.gltf(filepath=args.mesh)
    obj = collect_and_join(args.object_name)
    normalize_height(obj, args.target_height)
    tris = decimate(obj, args.target_tris)
    assign_projected_uv(
        obj,
        Path(args.image),
        args.material_name,
        args.force_front_material,
        args.use_image_alpha,
        args.uv_left,
        args.uv_width,
        args.uv_bottom,
        args.uv_height,
    )
    setup_render(args.target_height)
    render(Path(args.preview))
    export(obj, Path(args.out_glb), Path(args.out_fbx))
    print(f"triangles={tris}")
    print(f"preview={args.preview}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
