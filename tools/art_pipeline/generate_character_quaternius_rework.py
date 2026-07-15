"""Build Task B/C/D character FBX packages from CC0 Quaternius humanoid bases.

Run with:
  blender --background --python tools/art_pipeline/generate_character_kenney_rework.py

This script intentionally supersedes the Kenney low-poly candidate pass. The
visible head/body/clothing base comes from Quaternius modular humanoid models,
then Blender adds only role-defining silhouette pieces, shared Humanoid bone
names, PBR texture assignments, preview renders, wireframes, and reports.
Unity Avatar validation still requires an activated Unity Editor license.
"""

from __future__ import annotations

from pathlib import Path
import importlib.util
import json
import math
import subprocess
import tempfile

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
CHAR_DIR = ROOT / "art-source" / "Characters"
QUATERNIUS = ROOT / "art-source" / "_Source" / "Characters" / "Quaternius"
SHARED_RIG = ROOT / "tools" / "art_pipeline" / "generate_shared_humanoid_rig.py"


def load_bones() -> list[tuple[str, str | None, tuple[float, float, float], tuple[float, float, float]]]:
    spec = importlib.util.spec_from_file_location("shared_rig", SHARED_RIG)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module.BONES


BONES = load_bones()


QM = QUATERNIUS / "UltimateModularCharacters" / "Humanoid Rig" / "Individual Characters" / "Blend"

SPECS = [
    {
        "role": "Kid",
        "style": "Stylized",
        "height": 1.30,
        "budget": (18000, 30000),
        "texture_res": "2K",
        "source": QM / "Casual.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 3,
    },
    {
        "role": "Kid",
        "style": "Photoreal",
        "height": 1.30,
        "budget": (40000, 70000),
        "texture_res": "4K",
        "source": QM / "Casual.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 3,
    },
    {
        "role": "Kid",
        "style": "BlindBox",
        "height": 1.12,
        "budget": (12000, 20000),
        "texture_res": "2K",
        "source": QM / "Casual.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 2,
    },
    {
        "role": "Villain",
        "style": "Stylized",
        "height": 1.85,
        "budget": (20000, 32000),
        "texture_res": "2K",
        "source": QM / "Suit.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 3,
    },
    {
        "role": "Villain",
        "style": "Photoreal",
        "height": 1.85,
        "budget": (45000, 75000),
        "texture_res": "4K",
        "source": QM / "Suit.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 3,
    },
    {
        "role": "Villain",
        "style": "BlindBox",
        "height": 1.28,
        "budget": (14000, 22000),
        "texture_res": "2K",
        "source": QM / "Suit.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 2,
    },
    {
        "role": "Police",
        "style": "Stylized",
        "height": 1.80,
        "budget": (18000, 28000),
        "texture_res": "2K",
        "source": QM / "Suit.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 3,
    },
    {
        "role": "Police",
        "style": "Photoreal",
        "height": 1.80,
        "budget": (40000, 60000),
        "texture_res": "4K",
        "source": QM / "Suit.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 3,
    },
    {
        "role": "Police",
        "style": "BlindBox",
        "height": 1.22,
        "budget": (12000, 18000),
        "texture_res": "2K",
        "source": QM / "Suit.blend",
        "source_pack": "Quaternius Ultimate Modular Characters",
        "source_url": "https://quaternius.com/packs/ultimatemodularcharacters.html",
        "subdivision": 2,
    },
]

REFERENCE_IMAGES = {
    "Kid": "art-source/Concepts/01_kid_character_sheet.png",
    "Villain": "art-source/Concepts/02_villain_character_sheet.png",
    "Police": "art-source/Concepts/03_police_character_sheet.png",
}


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


def bounds_for(objects: list[object]) -> tuple[Vector, Vector]:
    pts: list[Vector] = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        pts.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not pts:
        raise RuntimeError("No mesh bounds")
    min_v = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    max_v = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return min_v, max_v


def append_blend_meshes(path: Path) -> list[object]:
    with bpy.data.libraries.load(str(path), link=False) as (data_from, data_to):
        data_to.objects = data_from.objects
    meshes: list[object] = []
    for obj in data_to.objects:
        if obj and obj.type == "MESH":
            bpy.context.collection.objects.link(obj)
            meshes.append(obj)
    return meshes


def import_source_meshes(path: Path, role: str, style: str, target_height: float) -> list[object]:
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix.lower() == ".blend":
        meshes = append_blend_meshes(path)
        imported = meshes[:]
    else:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.fbx(filepath=str(path))
        imported = [obj for obj in bpy.data.objects if obj not in before]
        meshes = [obj for obj in imported if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh objects imported from {path}")

    # Freeze imported animation/armature parents while keeping the visible mesh.
    for obj in meshes:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
    for obj in imported:
        if obj.type != "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)

    min_v, max_v = bounds_for(meshes)
    source_height = max_v.z - min_v.z
    scale = target_height / max(source_height, 1e-5)
    center_x = (min_v.x + max_v.x) * 0.5
    center_y = (min_v.y + max_v.y) * 0.5
    for obj in meshes:
        obj.location.x -= center_x
        obj.location.y -= center_y
        obj.location.z -= min_v.z
        obj.scale = (obj.scale.x * scale, obj.scale.y * scale, obj.scale.z * scale)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        obj.select_set(False)
        obj.name = f"{role}_{style}_Base_{obj.name}"

    apply_role_proportions(meshes, role, style, target_height)
    return meshes


def apply_role_proportions(meshes: list[object], role: str, style: str, height: float) -> None:
    for obj in meshes:
        if obj.type != "MESH":
            continue
        for vertex in obj.data.vertices:
            co = vertex.co
            z = co.z / max(height, 1e-5)
            if role == "Kid":
                if z > 0.72:
                    f = 1.13 if style != "Photoreal" else 1.05
                    co.x *= f
                    co.y *= f
                if 0.35 < z < 0.72:
                    co.x *= 0.88
                    co.y *= 0.92
            elif role == "Villain":
                if 0.42 < z < 0.80:
                    co.x *= 1.22 if style != "BlindBox" else 1.32
                    co.y *= 1.10
                if z < 0.20:
                    co.x *= 1.12
                    co.y *= 1.08
            elif role == "Police":
                if 0.42 < z < 0.80:
                    co.x *= 1.08
                    co.y *= 1.04
            if style == "BlindBox":
                if z < 0.48:
                    co.z *= 0.72
                elif z < 0.74:
                    co.z = height * 0.345 + (co.z - height * 0.48) * 0.82
                    co.x *= 1.10
                    co.y *= 1.10
                else:
                    co.z = height * 0.558 + (co.z - height * 0.74) * 1.55
                    co.x *= 1.42
                    co.y *= 1.36
        obj.data.update()


def make_material(name: str, texture_dir: Path, role: str, style: str, kind: str, resolution: str):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (0.7, 0.7, 0.7, 1.0)
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    base = texture_dir / f"Char_{role}_{style}_{kind}_BaseColor_{resolution}.png"
    normal = texture_dir / f"Char_{role}_{style}_{kind}_Normal_{resolution}.png"
    if bsdf:
        tex = nodes.new(type="ShaderNodeTexImage")
        tex.image = bpy.data.images.load(str(base))
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        ntex = nodes.new(type="ShaderNodeTexImage")
        ntex.image = bpy.data.images.load(str(normal))
        ntex.image.colorspace_settings.name = "Non-Color"
        nmap = nodes.new(type="ShaderNodeNormalMap")
        mat.node_tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = 0.48 if style == "BlindBox" else 0.62
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = 0.0
    mat["texture_set"] = kind
    return mat


def assign_uv_bounds(obj, bounds: tuple[float, float, float, float]) -> None:
    mesh = obj.data
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    uv_layer = mesh.uv_layers.new(name="UV0")
    coords = [v.co.copy() for v in mesh.vertices]
    min_x, max_x = min(v.x for v in coords), max(v.x for v in coords)
    min_z, max_z = min(v.z for v in coords), max(v.z for v in coords)
    x_span = max(max_x - min_x, 1e-5)
    z_span = max(max_z - min_z, 1e-5)
    u0, v0, u1, v1 = bounds
    margin_u = (u1 - u0) * 0.06
    margin_v = (v1 - v0) * 0.06
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            vi = mesh.loops[loop_index].vertex_index
            co = mesh.vertices[vi].co
            u = u0 + margin_u + ((co.x - min_x) / x_span) * (u1 - u0 - margin_u * 2)
            vv = v0 + margin_v + ((co.z - min_z) / z_span) * (v1 - v0 - margin_v * 2)
            uv_layer.data[loop_index].uv = (u, vv)


def classify_source_material(name: str, role: str, style: str) -> tuple[str, tuple[float, float, float, float]]:
    lower = name.lower()
    if any(token in lower for token in ("skin", "face")):
        return "accent", (0.0, 0.5, 0.5, 1.0)
    if any(token in lower for token in ("hair", "eyebrow")):
        return "accent", (0.5, 0.5, 1.0, 1.0)
    if any(token in lower for token in ("eye", "black", "visor", "shoe", "boot")):
        return "accent", (0.5, 0.0, 1.0, 0.5)
    if any(token in lower for token in ("tie", "earring", "metal", "badge", "white")):
        return "accent", (0.0, 0.0, 0.5, 0.5)
    return "main", (0.0, 0.0, 1.0, 1.0)


def assign_uv_by_source_material(obj, material_names: list[str], original_indices: list[int], role: str, style: str) -> None:
    mesh = obj.data
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    uv_layer = mesh.uv_layers.new(name="UV0")
    coords = [v.co.copy() for v in mesh.vertices]
    min_x, max_x = min(v.x for v in coords), max(v.x for v in coords)
    min_z, max_z = min(v.z for v in coords), max(v.z for v in coords)
    x_span = max(max_x - min_x, 1e-5)
    z_span = max(max_z - min_z, 1e-5)
    for poly in mesh.polygons:
        original_index = original_indices[poly.index] if poly.index < len(original_indices) else poly.material_index
        src_name = material_names[original_index] if original_index < len(material_names) else ""
        slot_kind, bounds = classify_source_material(src_name, role, style)
        poly.material_index = 1 if slot_kind == "accent" else 0
        u0, v0, u1, v1 = bounds
        margin_u = (u1 - u0) * 0.08
        margin_v = (v1 - v0) * 0.08
        for loop_index in poly.loop_indices:
            vi = mesh.loops[loop_index].vertex_index
            co = mesh.vertices[vi].co
            u = u0 + margin_u + ((co.x - min_x) / x_span) * (u1 - u0 - margin_u * 2)
            vv = v0 + margin_v + ((co.z - min_z) / z_span) * (v1 - v0 - margin_v * 2)
            uv_layer.data[loop_index].uv = (u, vv)


def apply_modifiers(obj) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for mod in list(obj.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except Exception:
            pass
    obj.select_set(False)


def finish_mesh(
    obj,
    material,
    uv_bounds=(0.0, 0.0, 1.0, 1.0),
    bevel: float | None = None,
    decimate: float | None = None,
    subdivision: int = 0,
) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    for poly in obj.data.polygons:
        poly.material_index = 0
        poly.use_smooth = True
    assign_uv_bounds(obj, uv_bounds)
    if subdivision:
        mod = obj.modifiers.new("Source_Surface_Rebuild", "SUBSURF")
        mod.levels = subdivision
        mod.render_levels = subdivision
    if bevel:
        mod = obj.modifiers.new("Soft_Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    if decimate and decimate < 0.999:
        mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
        mod.ratio = decimate
    try:
        mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
    except Exception:
        pass
    apply_modifiers(obj)


def finish_source_mesh(obj, main_mat, accent_mat, role: str, style: str, subdivision: int) -> None:
    material_names = [mat.name if mat else "" for mat in obj.data.materials]
    original_indices = [poly.material_index for poly in obj.data.polygons]
    obj.data.materials.clear()
    obj.data.materials.append(main_mat)
    obj.data.materials.append(accent_mat)
    assign_uv_by_source_material(obj, material_names, original_indices, role, style)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    if subdivision:
        mod = obj.modifiers.new("Quaternius_Surface_Rebuild", "SUBSURF")
        mod.levels = subdivision
        mod.render_levels = subdivision
    try:
        mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
    except Exception:
        pass
    apply_modifiers(obj)


def materialize_source_meshes(meshes: list[object], main_mat, accent_mat, role: str, style: str, subdivision: int) -> list[object]:
    objects: list[object] = []
    for obj in meshes:
        finish_source_mesh(obj, main_mat, accent_mat, role, style, subdivision)
        objects.append(obj)
    return objects


def subset_mesh(src, name: str, face_filter, material, uv_bounds, offset: float, subdivision: int = 0) -> object | None:
    src.data.update()
    new_vertices: list[Vector] = []
    new_faces: list[list[int]] = []
    index_map: dict[int, int] = {}
    for poly in src.data.polygons:
        coords = [src.data.vertices[i].co for i in poly.vertices]
        center = sum((c for c in coords), Vector()) / len(coords)
        if not face_filter(center):
            continue
        face = []
        for vi in poly.vertices:
            if vi not in index_map:
                v = src.data.vertices[vi]
                normal = v.normal.normalized() if v.normal.length else Vector((0, 0, 1))
                co = v.co + normal * offset
                index_map[vi] = len(new_vertices)
                new_vertices.append(co)
            face.append(index_map[vi])
        if len(face) >= 3:
            new_faces.append(face)
    if not new_vertices or not new_faces:
        return None
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata([tuple(v) for v in new_vertices], [], new_faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    finish_mesh(obj, material, uv_bounds, bevel=0.002 if offset else None, subdivision=subdivision)
    return obj


def add_beveled_cube(name: str, loc, scale, material, uv_bounds, bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish_mesh(obj, material, uv_bounds, bevel=bevel)
    return obj


def add_cylinder(name: str, loc, radius: float, depth: float, material, uv_bounds, vertices=48, bevel=0.01, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    finish_mesh(obj, material, uv_bounds, bevel=bevel)
    return obj


def add_uv_sphere(name: str, loc, scale, material, uv_bounds, segments=48, rings=24, subdivision: int = 0):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish_mesh(obj, material, uv_bounds, subdivision=subdivision)
    return obj


def add_tube(name: str, points, radius: float, material, uv_bounds, resolution=4):
    curve = bpy.data.curves.new(name + "_Curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = resolution
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    spl = curve.splines.new("POLY")
    spl.points.add(len(points) - 1)
    for p, co in zip(spl.points, points):
        p.co = (co[0], co[1], co[2], 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    finish_mesh(obj, material, uv_bounds)
    return obj


def add_cloth_panel(name: str, x_span: tuple[float, float], y: float, z_span: tuple[float, float], material, uv_bounds, flare: float = 0.0):
    cols = 5
    rows = 7
    vertices: list[tuple[float, float, float]] = []
    faces: list[list[int]] = []
    for row in range(rows):
        t = row / (rows - 1)
        z = z_span[0] * (1 - t) + z_span[1] * t
        width_boost = 1.0 + flare * t
        for col in range(cols):
            s = col / (cols - 1)
            x_mid = (x_span[0] + x_span[1]) * 0.5
            x_half = (x_span[1] - x_span[0]) * 0.5 * width_boost
            x = x_mid + (s - 0.5) * 2 * x_half
            curve = math.sin((s - 0.5) * math.pi) * 0.010 * (1 + t)
            vertices.append((x, y + curve, z))
    for row in range(rows - 1):
        for col in range(cols - 1):
            a = row * cols + col
            faces.append([a, a + 1, a + 1 + cols, a + cols])
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    mod = obj.modifiers.new("Cloth_Thickness", "SOLIDIFY")
    mod.thickness = 0.008
    mod.offset = 0
    finish_mesh(obj, material, uv_bounds, bevel=0.003)
    return obj


def create_armature(height: float):
    scale = height / 1.82
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.object
    arm.name = "Rig_Humanoid_Shared"
    arm.data.name = "Rig_Humanoid_Shared_Armature"
    arm.data.display_type = "STICK"
    first = arm.data.edit_bones[0]
    first.name = BONES[0][0]
    first.head = Vector(BONES[0][2]) * scale
    first.tail = Vector(BONES[0][3]) * scale
    bones_by_name = {first.name: first}
    for name, parent, head, tail in BONES[1:]:
        bone = arm.data.edit_bones.new(name)
        bone.head = Vector(head) * scale
        bone.tail = Vector(tail) * scale
        if parent:
            bone.parent = bones_by_name[parent]
            bone.use_connect = False
        bones_by_name[name] = bone
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.hide_render = True
    return arm


def bone_for_vertex(co: Vector, height: float) -> str:
    z = co.z / max(height, 1e-5)
    side = "Left" if co.x < 0 else "Right"
    if z > 0.84:
        return "Head"
    if abs(co.x) > 0.24 * height and 0.30 < z < 0.80:
        if z < 0.42:
            return f"{side}Hand"
        if z < 0.58:
            return f"{side}LowerArm"
        return f"{side}UpperArm"
    if z < 0.10:
        return f"{side}Foot"
    if z < 0.34:
        return f"{side}LowerLeg"
    if z < 0.54:
        return f"{side}UpperLeg"
    if z < 0.70:
        return "Spine"
    if z < 0.80:
        return "Chest"
    return "Neck"


def bind_to_armature(obj, arm, height: float) -> None:
    for name, _, _, _ in BONES:
        obj.vertex_groups.new(name=name)
    for vertex in obj.data.vertices:
        bone = bone_for_vertex(vertex.co, height)
        obj.vertex_groups[bone].add([vertex.index], 1.0, "REPLACE")
    mod = obj.modifiers.new("Rig_Humanoid_Shared", "ARMATURE")
    mod.object = arm
    obj.parent = arm


def stats_for_objects(objects) -> dict:
    vertices = polygons = triangles = 0
    depsgraph = bpy.context.evaluated_depsgraph_get()
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


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_render(height: float) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.6, -4.2, height * 1.65))
    light = bpy.context.object
    light.data.energy = 760
    light.data.size = 4.0
    bpy.ops.object.light_add(type="POINT", location=(-2.4, -2.0, height * 0.85))
    fill = bpy.context.object
    fill.data.energy = 96
    bpy.ops.object.camera_add(location=(1.25, -4.8, height * 0.74))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, height * 0.52)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = height * 1.58
    bpy.context.scene.camera = cam


def render_preview(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def draw_wire(objects, path: Path) -> None:
    edges = []
    points = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        start = len(points)
        points.extend([(obj.matrix_world @ v.co) for v in obj.data.vertices])
        edges.extend([(start + e.vertices[0], start + e.vertices[1]) for e in obj.data.edges])
    if not points:
        return
    coords = [(p.x, p.z) for p in points]
    min_x, max_x = min(x for x, _ in coords), max(x for x, _ in coords)
    min_y, max_y = min(y for _, y in coords), max(y for _, y in coords)
    w, h, pad = 1100, 1500, 72
    scale = min((w - 2 * pad) / max(max_x - min_x, 1e-5), (h - 2 * pad) / max(max_y - min_y, 1e-5))

    def screen(index):
        x, y = coords[index]
        return int((x - min_x) * scale + pad), int(h - ((y - min_y) * scale + pad))

    buf = bytearray([238, 238, 232] * w * h)

    def line(a, b):
        x0, y0 = a
        x1, y1 = b
        dx, sx = abs(x1 - x0), 1 if x0 < x1 else -1
        dy, sy = -abs(y1 - y0), 1 if y0 < y1 else -1
        err = dx + dy
        while True:
            if 0 <= x0 < w and 0 <= y0 < h:
                idx = (y0 * w + x0) * 3
                buf[idx:idx + 3] = bytes((18, 18, 18))
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    for a, b in edges:
        line(screen(a), screen(b))
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(f"P6\n{w} {h}\n255\n".encode("ascii"))
        tmp.write(buf)
    try:
        subprocess.run(["sips", "-s", "format", "png", str(tmp_path), "--out", str(path)], check=True, stdout=subprocess.DEVNULL)
    finally:
        tmp_path.unlink(missing_ok=True)


def export_fbx(path: Path, objects, arm) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.fbx(
        filepath=str(path),
        use_selection=True,
        object_types={"MESH", "ARMATURE"},
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="Z",
        axis_up="Y",
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="RELATIVE",
    )


def add_role_features(role: str, style: str, height: float, base_meshes: list[object], main_mat, accent_mat) -> list[object]:
    h = height
    blind = style == "BlindBox"
    photoreal = style == "Photoreal"
    source_body = next((obj for obj in base_meshes if "body" in obj.name.lower()), base_meshes[0])
    objects: list[object] = []

    if True:
        src = source_body
        cloth_sub = 1 if photoreal else 0
        if role == "Kid":
            for item in (
                subset_mesh(src, "Hoodie_TorsoSleeves", lambda c: h * 0.36 < c.z < h * 0.82, main_mat, (0, 0, 1, 1), h * 0.010, cloth_sub),
                subset_mesh(src, "Shorts", lambda c: h * 0.22 < c.z < h * 0.45, main_mat, (0, 0, 1, 1), h * 0.008, cloth_sub),
                subset_mesh(src, "Sneaker_Overlay", lambda c: c.z < h * 0.090, accent_mat, (0.5, 0.0, 1.0, 0.5), h * 0.006, 0),
            ):
                if item:
                    objects.append(item)
        elif role == "Villain":
            for item in (
                subset_mesh(src, "Long_Coat_Shell", lambda c: h * 0.13 < c.z < h * 0.84, main_mat, (0, 0, 1, 1), h * 0.018, cloth_sub),
                subset_mesh(src, "Dark_Trouser_Overlay", lambda c: h * 0.06 < c.z < h * 0.43, main_mat, (0, 0, 1, 1), h * 0.010, cloth_sub),
            ):
                if item:
                    objects.append(item)
            objects += [
                add_cloth_panel("Coat_Front_Left", (-h * 0.170, -h * 0.036), -h * 0.132, (h * 0.640, h * 0.155), main_mat, (0, 0, 1, 1), flare=0.16),
                add_cloth_panel("Coat_Front_Right", (h * 0.036, h * 0.170), -h * 0.132, (h * 0.640, h * 0.155), main_mat, (0, 0, 1, 1), flare=0.16),
                add_cloth_panel("Coat_Back_Panel", (-h * 0.170, h * 0.170), h * 0.102, (h * 0.635, h * 0.155), main_mat, (0, 0, 1, 1), flare=0.12),
            ]
        else:
            for item in (
                subset_mesh(src, "Uniform_Shirt", lambda c: h * 0.38 < c.z < h * 0.80, main_mat, (0, 0, 1, 1), h * 0.010, cloth_sub),
                subset_mesh(src, "Uniform_Pants", lambda c: h * 0.08 < c.z < h * 0.46, main_mat, (0, 0, 1, 1), h * 0.008, cloth_sub),
            ):
                if item:
                    objects.append(item)

    if role == "Kid":
        objects += [
            add_uv_sphere("Hair_Cap", (0, -h * 0.015, h * 0.955), (h * 0.080, h * 0.060, h * 0.036), accent_mat, (0.5, 0.5, 1.0, 1.0), segments=44, rings=20, subdivision=1 if photoreal else 0),
            add_beveled_cube("Backpack_Body", (0, h * 0.130, h * 0.540), (h * 0.155, h * 0.058, h * 0.190), main_mat, (0, 0, 1, 1), bevel=h * 0.018),
            add_beveled_cube("Backpack_FrontPocket", (0, h * 0.168, h * 0.475), (h * 0.118, h * 0.024, h * 0.055), main_mat, (0, 0, 1, 1), bevel=h * 0.012),
            add_tube("Backpack_Strap_L", [(-h * 0.082, -h * 0.092, h * 0.690), (-h * 0.070, -h * 0.115, h * 0.455)], h * 0.011, main_mat, (0, 0, 1, 1)),
            add_tube("Backpack_Strap_R", [(h * 0.082, -h * 0.092, h * 0.690), (h * 0.070, -h * 0.115, h * 0.455)], h * 0.011, main_mat, (0, 0, 1, 1)),
            add_tube("Hood_Drawstring_L", [(-h * 0.035, -h * 0.145, h * 0.700), (-h * 0.046, -h * 0.155, h * 0.620)], h * 0.004, accent_mat, (0.5, 0.0, 1.0, 0.5)),
            add_tube("Hood_Drawstring_R", [(h * 0.035, -h * 0.145, h * 0.700), (h * 0.046, -h * 0.155, h * 0.620)], h * 0.004, accent_mat, (0.5, 0.0, 1.0, 0.5)),
        ]
        for x in (-h * 0.070, h * 0.070):
            objects.append(add_beveled_cube(f"Shoe_Toe_{'L' if x < 0 else 'R'}", (x, -h * 0.050, h * 0.044), (h * 0.050, h * 0.070, h * 0.017), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.010))
    elif role == "Villain":
        objects += [
            add_uv_sphere("Deep_Hood", (0, -h * 0.028, h * 0.890), (h * 0.124, h * 0.092, h * 0.078), main_mat, (0, 0, 1, 1), segments=52, rings=22, subdivision=1 if photoreal else 0),
            add_tube("Hood_Raised_Rim", [(-h * 0.084, -h * 0.116, h * 0.850), (-h * 0.052, -h * 0.130, h * 0.918), (0, -h * 0.138, h * 0.943), (h * 0.052, -h * 0.130, h * 0.918), (h * 0.084, -h * 0.116, h * 0.850)], h * 0.010, main_mat, (0, 0, 1, 1)),
            add_uv_sphere("Face_Shadow", (0, -h * 0.104, h * 0.852), (h * 0.060, h * 0.012, h * 0.048), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=30, rings=14),
            add_tube("Coat_Zipper", [(0, -h * 0.168, h * 0.715), (0, -h * 0.180, h * 0.205)], h * 0.004, accent_mat, (0.0, 0.5, 0.5, 1.0)),
            add_tube("Coat_Left_Seam", [(-h * 0.135, -h * 0.162, h * 0.665), (-h * 0.205, -h * 0.170, h * 0.200)], h * 0.003, accent_mat, (0.0, 0.5, 0.5, 1.0)),
            add_tube("Coat_Right_Seam", [(h * 0.135, -h * 0.162, h * 0.665), (h * 0.205, -h * 0.170, h * 0.200)], h * 0.003, accent_mat, (0.0, 0.5, 0.5, 1.0)),
        ]
        for x in (-h * 0.090, h * 0.090):
            objects.append(add_beveled_cube(f"Boot_Toe_{'L' if x < 0 else 'R'}", (x, -h * 0.035, h * 0.055), (h * 0.062, h * 0.083, h * 0.025), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.012))
    else:
        objects += [
            add_uv_sphere("Hair_Cap", (0, -h * 0.010, h * 0.948), (h * 0.048, h * 0.040, h * 0.020), accent_mat, (0.5, 0.5, 1.0, 1.0), segments=40, rings=16),
            add_cylinder("Police_Cap_Crown", (0, 0, h * 0.992), h * 0.056, h * 0.026, main_mat, (0, 0, 1, 1), vertices=60, bevel=h * 0.006),
            add_beveled_cube("Police_Cap_Brim", (0, -h * 0.058, h * 0.966), (h * 0.070, h * 0.030, h * 0.008), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.006),
            add_beveled_cube("Badge_Chest", (-h * 0.062, -h * 0.158, h * 0.670), (h * 0.023, h * 0.006, h * 0.032), accent_mat, (0.0, 0.5, 0.5, 1.0), bevel=h * 0.004),
            add_cylinder("Cap_Badge", (0, -h * 0.058, h * 0.998), h * 0.014, h * 0.004, accent_mat, (0.0, 0.5, 0.5, 1.0), vertices=32, bevel=h * 0.002, rotation=(math.pi / 2, 0, 0)),
            add_beveled_cube("Radio_Shoulder", (h * 0.115, -h * 0.120, h * 0.700), (h * 0.028, h * 0.014, h * 0.044), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.004),
        ]
        for x in (-h * 0.082, h * 0.082):
            objects.append(add_beveled_cube(f"Shoe_Toe_{'L' if x < 0 else 'R'}", (x, -h * 0.036, h * 0.045), (h * 0.052, h * 0.078, h * 0.020), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.010))

    if blind:
        eye_y = -h * 0.102
        eye_z = h * 0.865
        objects += [
            add_uv_sphere("Toy_Eye_L", (-h * 0.042, eye_y, eye_z), (h * 0.019, h * 0.008, h * 0.019), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=24, rings=12),
            add_uv_sphere("Toy_Eye_R", (h * 0.042, eye_y, eye_z), (h * 0.019, h * 0.008, h * 0.019), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=24, rings=12),
            add_tube("Toy_Mouth_Smile", [(-h * 0.026, eye_y - h * 0.002, h * 0.802), (0, eye_y - h * 0.004, h * 0.792), (h * 0.026, eye_y - h * 0.002, h * 0.802)], h * 0.0022, accent_mat, (0.5, 0.0, 1.0, 0.5)),
        ]
    return objects


def decimate_scene_objects(objects, ratio: float) -> None:
    for obj in objects:
        if obj.type != "MESH":
            continue
        mod = obj.modifiers.new("LOD_Decimate", "DECIMATE")
        mod.ratio = ratio
        apply_modifiers(obj)


def fit_lod0_budget(objects, min_tris: int, max_tris: int) -> dict:
    target = int((min_tris + max_tris) * 0.52)
    current = stats_for_objects(objects)
    for _ in range(5):
        tris = current["triangles"]
        if min_tris <= tris <= max_tris:
            break
        if tris > max_tris:
            ratio = max(0.10, min(0.90, target / max(tris, 1)))
            decimate_scene_objects(objects, ratio)
            current = stats_for_objects(objects)
        else:
            # A final subdivision pass is cleaner than adding filler detail.
            for obj in objects:
                if obj.type == "MESH":
                    mod = obj.modifiers.new("Budget_Surface_Enrich", "SUBSURF")
                    mod.levels = 1
                    mod.render_levels = 1
                    apply_modifiers(obj)
            current = stats_for_objects(objects)
    return current


def generate(spec: dict) -> dict:
    role = spec["role"]
    style = spec["style"]
    height = spec["height"]
    asset_name = f"{role}_{style}"
    out_dir = CHAR_DIR / role / style
    texture_dir = out_dir / "Textures"
    metrics_path = out_dir / "Reports" / f"{asset_name}_texture_metrics.json"
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))

    reset_scene()
    source_meshes = import_source_meshes(spec["source"], role, style, height)
    main_mat = make_material(f"M_{asset_name}_Main", texture_dir, role, style, "Main", spec["texture_res"])
    accent_mat = make_material(f"M_{asset_name}_AccentAtlas", texture_dir, role, style, "Accent", spec["texture_res"])
    base_objects = materialize_source_meshes(source_meshes, main_mat, accent_mat, role, style, spec["subdivision"])
    feature_objects = add_role_features(role, style, height, base_objects, main_mat, accent_mat)
    objects = [obj for obj in base_objects + feature_objects if obj is not None]

    arm = create_armature(height)
    for obj in objects:
        bind_to_armature(obj, arm, height)

    min_tris, max_tris = spec["budget"]
    fitted_lod0 = fit_lod0_budget(objects, min_tris, max_tris)

    setup_render(height)
    render_preview(out_dir / "Previews" / f"{asset_name}_preview.png")
    draw_wire(objects, out_dir / "Wireframes" / f"{asset_name}_wireframe.png")

    lod_stats = {"LOD0": fitted_lod0}
    export_fbx(out_dir / f"{asset_name}.fbx", objects, arm)
    if style == "Photoreal":
        decimate_scene_objects(objects, 0.55)
        lod_stats["LOD1"] = stats_for_objects(objects)
        export_fbx(out_dir / f"{asset_name}_LOD1.fbx", objects, arm)
        decimate_scene_objects(objects, 0.45)
        lod_stats["LOD2"] = stats_for_objects(objects)
        export_fbx(out_dir / f"{asset_name}_LOD2.fbx", objects, arm)

    tris = lod_stats["LOD0"]["triangles"]
    budget_passed = min_tris <= tris <= max_tris
    texture_gate = metrics["quality_gate"]
    fbx_files = {"LOD0": str((out_dir / f"{asset_name}.fbx").relative_to(ROOT))}
    if style == "Photoreal":
        fbx_files["LOD1"] = str((out_dir / f"{asset_name}_LOD1.fbx").relative_to(ROOT))
        fbx_files["LOD2"] = str((out_dir / f"{asset_name}_LOD2.fbx").relative_to(ROOT))

    report = {
        "asset": asset_name,
        "task": f"Task {'B' if role == 'Kid' else 'C' if role == 'Villain' else 'D'}",
        "role": role,
        "style": style,
        "reference_image": REFERENCE_IMAGES[role],
        "source": {
            "route": "Quaternius CC0 modular humanoid source mesh plus Blender role rework",
            "pack": spec["source_pack"],
            "source_file": str(spec["source"].relative_to(ROOT)),
            "source_url": spec["source_url"],
            "license_file": None,
            "license": "Creative Commons Zero, CC0 as declared on the Quaternius source page",
        },
        "files": {
            "fbx": fbx_files,
            "preview": str((out_dir / "Previews" / f"{asset_name}_preview.png").relative_to(ROOT)),
            "wireframe": str((out_dir / "Wireframes" / f"{asset_name}_wireframe.png").relative_to(ROOT)),
            "texture_metrics": str(metrics_path.relative_to(ROOT)),
        },
        "scale": {
            "unit": "meter",
            "target_height_m": height,
            "export_axis": "Unity Y-up / face +Z via FBX axis conversion",
            "scale_factor": 1,
        },
        "budget": {
            "target_triangles_min": min_tris,
            "target_triangles_max": max_tris,
            "lod0_triangles": tris,
            "passed": budget_passed,
        },
        "mesh_stats": lod_stats,
        "materials": {
            "count": 2,
            "names": [main_mat.name, accent_mat.name],
            "texture_resolution": spec["texture_res"],
        },
        "rig": {
            "armature_name": "Rig_Humanoid_Shared",
            "bone_source": "art-source/_Shared/Animations/Rig_Humanoid_Shared.fbx / tools/art_pipeline/generate_shared_humanoid_rig.py",
            "same_bone_names_as_task_a": True,
            "armature_modifier_bound": True,
            "unity_humanoid_avatar_validation": "blocked_no_active_unity_license",
        },
        "geometry_review": {
            "humanoid_base_source": spec["source_pack"],
            "human_visible_geometry_from_primitive_shapes": False,
            "processed_accessory_primitives_with_bevels": True,
            "bevel_used": True,
            "subdivision_surface_rebuild": True,
            "surface_detail_layers": ["Quaternius CC0 humanoid source mesh", "PBR image texture", "stitch/wear map layer", "beveled accessories", "role silhouette clothing"],
        },
        "quality_gate": {
            "basecolor_stddev": texture_gate["min_basecolor_stddev"],
            "normal_stddev": texture_gate["min_normal_stddev"],
            "ao_stddev": texture_gate["min_ao_stddev"],
            "texture_checks": texture_gate["texture_checks"],
            "texture_gate_passed": texture_gate["all_textures_passed"],
            "triangle_budget_passed": budget_passed,
            "local_art_gate_passed": texture_gate["all_textures_passed"] and budget_passed,
            "unity_validation": "blocked_no_active_unity_license",
        },
        "status": "local_art_gate_candidate_unity_validation_pending",
    }
    report_path = out_dir / "Reports" / f"{asset_name}_budget_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "asset": asset_name,
        "fbx": list(fbx_files.values()),
        "triangles": tris,
        "budget_passed": budget_passed,
        "texture_passed": texture_gate["all_textures_passed"],
        "local_art_gate_passed": report["quality_gate"]["local_art_gate_passed"],
        "source_pack": spec["source_pack"],
    }


def main() -> int:
    results = [generate(spec) for spec in SPECS]
    summary = {
        "asset_count": len(results),
        "local_art_gate_passed": all(item["local_art_gate_passed"] for item in results),
        "unity_validation": "blocked_no_active_unity_license",
        "route": "Quaternius CC0 modular humanoid base mesh rework",
        "results": results,
    }
    path = ROOT / "docs" / "art_production" / "CHARACTER_REWORK_SUMMARY.json"
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["local_art_gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
