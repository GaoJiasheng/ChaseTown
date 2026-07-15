"""Colorize a Hunyuan3D shape mesh into a local character-art candidate.

Hunyuan3D's public Space shape endpoint is reliable, while the texture endpoint
can fail upstream. This script turns the usable shape GLB into a reviewable
game-art candidate by decimating it into budget range and assigning region
materials based on the generated character's proportions.
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


def material(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = color
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
    return mat


def collect_meshes() -> list[bpy.types.Object]:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh objects imported")
    return meshes


def join_meshes(meshes: list[bpy.types.Object]) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = bpy.context.object
    obj.name = "Kid_Stylized_Hunyuan_Colorized"
    return obj


def normalize_height(obj: bpy.types.Object, target_height: float) -> None:
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


def triangle_count(obj: bpy.types.Object) -> int:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    mesh.calc_loop_triangles()
    count = len(mesh.loop_triangles)
    eval_obj.to_mesh_clear()
    return count


def decimate_to_budget(obj: bpy.types.Object, target_tris: int) -> int:
    current = triangle_count(obj)
    if current <= target_tris:
        return current
    ratio = max(0.08, min(0.95, target_tris / current))
    mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
    mod.ratio = ratio
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return triangle_count(obj)


def assign_regions(obj: bpy.types.Object) -> None:
    mats = [
        material("M_Skin_Warm", (0.86, 0.56, 0.42, 1), 0.58),
        material("M_Hair_Dark_Brown", (0.035, 0.028, 0.023, 1), 0.46),
        material("M_Hoodie_Navy_Fleece", (0.018, 0.045, 0.115, 1), 0.76),
        material("M_Shorts_Black_Denim", (0.018, 0.017, 0.016, 1), 0.72),
        material("M_Socks_Off_White", (0.88, 0.86, 0.78, 1), 0.62),
        material("M_Sneaker_Red_Rubber", (0.58, 0.075, 0.045, 1), 0.50),
        material("M_Backpack_Straps_Black", (0.012, 0.012, 0.013, 1), 0.66),
    ]
    obj.data.materials.clear()
    for mat in mats:
        obj.data.materials.append(mat)

    coords = [v.co.copy() for v in obj.data.vertices]
    min_z, max_z = min(c.z for c in coords), max(c.z for c in coords)
    min_x, max_x = min(c.x for c in coords), max(c.x for c in coords)
    min_y, max_y = min(c.y for c in coords), max(c.y for c in coords)
    height = max(max_z - min_z, 1e-5)
    width = max(max_x - min_x, 1e-5)
    depth = max(max_y - min_y, 1e-5)

    for poly in obj.data.polygons:
        center = sum((obj.data.vertices[i].co for i in poly.vertices), Vector()) / len(poly.vertices)
        z = (center.z - min_z) / height
        x = abs((center.x - (min_x + max_x) * 0.5) / width)
        y = (center.y - min_y) / depth

        mat_index = 0
        if z < 0.095:
            mat_index = 5
        elif z < 0.22:
            mat_index = 4
        elif 0.22 <= z < 0.43 and x < 0.22:
            mat_index = 3
        elif z > 0.87 or (z > 0.80 and y > 0.47):
            mat_index = 1
        elif 0.42 <= z < 0.77:
            if x > 0.31 and z < 0.50:
                mat_index = 0
            elif 0.15 < x < 0.28 and y < 0.38:
                mat_index = 6
            else:
                mat_index = 2
        elif 0.72 <= z < 0.86:
            mat_index = 0
        elif 0.22 <= z < 0.42 and x > 0.32:
            mat_index = 0
        else:
            mat_index = 0
        poly.material_index = mat_index

    for poly in obj.data.polygons:
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
    key.data.energy = 720
    key.data.size = 4.5
    bpy.ops.object.light_add(type="POINT", location=(-2.2, -2.1, height * 0.8))
    fill = bpy.context.object
    fill.data.energy = 95
    bpy.ops.object.camera_add(location=(1.8, -4.1, height * 0.65))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, height * 0.50)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = height * 1.20
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
    parser.add_argument("--out-glb", required=True)
    parser.add_argument("--out-fbx", required=True)
    parser.add_argument("--preview", required=True)
    parser.add_argument("--target-tris", type=int, default=28000)
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    args = parser.parse_args(argv)

    reset_scene()
    bpy.ops.import_scene.gltf(filepath=args.mesh)
    obj = join_meshes(collect_meshes())
    normalize_height(obj, 1.30)
    decimated = decimate_to_budget(obj, args.target_tris)
    assign_regions(obj)
    setup_render(1.30)
    render(Path(args.preview))
    export(obj, Path(args.out_glb), Path(args.out_fbx))
    print(f"triangles={decimated}")
    print(f"preview={args.preview}")
    print(f"glb={args.out_glb}")
    print(f"fbx={args.out_fbx}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
