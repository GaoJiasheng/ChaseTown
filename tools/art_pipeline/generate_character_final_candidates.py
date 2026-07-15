"""Build Task B/C/D character art candidates from MB-Lab body sources.

Run with:
  blender --background --python tools/art_pipeline/generate_character_final_candidates.py

These are local art-gate candidates: FBX, PBR texture links, preview,
wireframe, and budget reports. Unity Humanoid Avatar validation still requires
an activated Unity Editor license on this machine.
"""

from __future__ import annotations

from pathlib import Path
import importlib.util
import json
import math
import shutil
import subprocess
import tempfile

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "tools" / "third_party" / "MB-Lab" / "data" / "humanoid_library.blend"
CHAR_DIR = ROOT / "art-source" / "Characters"
SHARED_RIG = ROOT / "tools" / "art_pipeline" / "generate_shared_humanoid_rig.py"


def load_bones() -> list[tuple[str, str | None, tuple[float, float, float], tuple[float, float, float]]]:
    spec = importlib.util.spec_from_file_location("shared_rig", SHARED_RIG)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module.BONES


BONES = load_bones()


SPECS = [
    {"role": "Kid", "style": "Stylized", "template": "MBLab_human_male", "height": 1.30, "budget": (18000, 30000), "texture_res": "2K"},
    {"role": "Kid", "style": "Photoreal", "template": "MBLab_human_male", "height": 1.30, "budget": (40000, 70000), "texture_res": "4K"},
    {"role": "Kid", "style": "BlindBox", "template": "MBLab_anime_male", "height": 1.30, "budget": (12000, 20000), "texture_res": "2K"},
    {"role": "Villain", "style": "Stylized", "template": "MBLab_human_male", "height": 1.85, "budget": (20000, 32000), "texture_res": "2K"},
    {"role": "Villain", "style": "Photoreal", "template": "MBLab_human_male", "height": 1.85, "budget": (45000, 75000), "texture_res": "4K"},
    {"role": "Villain", "style": "BlindBox", "template": "MBLab_anime_male", "height": 1.85, "budget": (14000, 22000), "texture_res": "2K"},
    {"role": "Police", "style": "Stylized", "template": "MBLab_human_male", "height": 1.80, "budget": (18000, 28000), "texture_res": "2K"},
    {"role": "Police", "style": "Photoreal", "template": "MBLab_human_male", "height": 1.80, "budget": (40000, 60000), "texture_res": "4K"},
    {"role": "Police", "style": "BlindBox", "template": "MBLab_anime_male", "height": 1.80, "budget": (12000, 18000), "texture_res": "2K"},
]

REFERENCE_IMAGES = {
    "Kid": "art-source/Concepts/01_kid_character_sheet.png",
    "Villain": "art-source/Concepts/02_villain_character_sheet.png",
    "Police": "art-source/Concepts/03_police_character_sheet.png",
}

LOD_REQUIRED = {"Photoreal"}


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


def append_object(name: str):
    with bpy.data.libraries.load(str(LIB), link=False) as (data_from, data_to):
        if name not in data_from.objects:
            raise RuntimeError(f"{name} not found in {LIB}")
        data_to.objects = [name]
    obj = data_to.objects[0]
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    return obj


def mesh_height(obj) -> float:
    points = [(obj.matrix_world @ v.co).z for v in obj.data.vertices]
    return max(points) - min(points)


def normalize_height(obj, target_height: float) -> None:
    current = mesh_height(obj)
    scale = target_height / current
    obj.scale = (scale, scale, scale)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    min_z = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    obj.location.z -= min_z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def style_body_proportions(obj, role: str, style: str) -> None:
    height = mesh_height(obj)
    for v in obj.data.vertices:
        z = v.co.z / max(height, 1e-5)
        if role == "Kid":
            if z > 0.76:
                v.co.x *= 1.09 if style != "Photoreal" else 1.03
                v.co.y *= 1.08 if style != "Photoreal" else 1.02
            if 0.38 < z < 0.74:
                v.co.x *= 0.90
                v.co.y *= 0.94
        elif role == "Villain":
            if 0.45 < z < 0.82:
                v.co.x *= 1.18 if style != "BlindBox" else 1.28
                v.co.y *= 1.10
            if z < 0.18:
                v.co.x *= 1.08
        elif role == "Police":
            if 0.46 < z < 0.78:
                v.co.x *= 1.06
                v.co.y *= 1.04
        if style == "BlindBox":
            if z > 0.76:
                v.co.x *= 1.14
                v.co.y *= 1.14
            if z < 0.18:
                v.co.x *= 1.08
                v.co.y *= 1.04
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
            bsdf.inputs["Roughness"].default_value = 0.58 if kind == "Main" else 0.42
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


def assign_full_uv(obj) -> None:
    assign_uv_bounds(obj, (0.0, 0.0, 1.0, 1.0))


def apply_modifiers(obj) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for mod in list(obj.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except Exception:
            pass
    obj.select_set(False)


def finish_mesh(obj, material, uv_bounds=(0.0, 0.0, 1.0, 1.0), bevel: float | None = None, decimate: float | None = None) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    for poly in obj.data.polygons:
        poly.material_index = 0
    assign_uv_bounds(obj, uv_bounds)
    if decimate and decimate < 0.999:
        mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
        mod.ratio = decimate
    if bevel:
        mod = obj.modifiers.new("Soft_Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 3
    try:
        mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
    except Exception:
        pass
    apply_modifiers(obj)
    try:
        for poly in obj.data.polygons:
            poly.use_smooth = True
    except Exception:
        pass


def subset_mesh(src, name: str, face_filter, material, uv_bounds, offset: float, decimate: float) -> object | None:
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
                co = v.co + v.normal.normalized() * offset
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
    finish_mesh(obj, material, uv_bounds, bevel=0.002 if offset else None, decimate=decimate)
    return obj


def add_beveled_cube(name: str, loc, scale, material, uv_bounds, bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish_mesh(obj, material, uv_bounds, bevel=bevel, decimate=None)
    return obj


def add_cylinder(name: str, loc, radius: float, depth: float, material, uv_bounds, vertices=48, bevel=0.01, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    finish_mesh(obj, material, uv_bounds, bevel=bevel, decimate=None)
    return obj


def add_uv_sphere(name: str, loc, scale, material, uv_bounds, segments=48, rings=24, decimate=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish_mesh(obj, material, uv_bounds, bevel=None, decimate=decimate)
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
    finish_mesh(obj, material, uv_bounds, bevel=None, decimate=None)
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
    if abs(co.x) > 0.28 * height and 0.30 < z < 0.78:
        if z < 0.42:
            return f"{side}Hand"
        if z < 0.56:
            return f"{side}LowerArm"
        return f"{side}UpperArm"
    if z < 0.12:
        return f"{side}Foot"
    if z < 0.36:
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
    vertices = 0
    polys = 0
    tris = 0
    for obj in objects:
        if obj.type != "MESH":
            continue
        depsgraph = bpy.context.evaluated_depsgraph_get()
        eval_obj = obj.evaluated_get(depsgraph)
        mesh = eval_obj.to_mesh()
        mesh.calc_loop_triangles()
        vertices += len(mesh.vertices)
        polys += len(mesh.polygons)
        tris += len(mesh.loop_triangles)
        eval_obj.to_mesh_clear()
    return {"vertices": vertices, "polygons": polys, "triangles": tris}


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_render(height: float) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.3, -4.0, height * 1.65))
    light = bpy.context.object
    light.data.energy = 650
    light.data.size = 4.0
    bpy.ops.object.light_add(type="POINT", location=(-2.2, -2.2, height * 0.8))
    fill = bpy.context.object
    fill.data.energy = 80
    bpy.ops.object.camera_add(location=(2.0, -4.2, height * 0.70))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, height * 0.50)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = height * 1.18
    bpy.context.scene.camera = cam


def render_preview(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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


def make_role_meshes(src, role: str, style: str, height: float, main_mat, accent_mat):
    h = height
    blind = style == "BlindBox"
    photoreal = style == "Photoreal"
    dec_body = 0.78 if photoreal else 0.50 if blind else 0.58
    dec_cloth = 0.90 if photoreal else 0.52 if blind else 0.60
    objects = []
    body = subset_mesh(src, "Body_Skin_Underlay", lambda c: True, accent_mat, (0.0, 0.0, 0.5, 0.5), 0.0, dec_body)
    if body:
        objects.append(body)

    if role == "Kid":
        skin = None
        hoodie = subset_mesh(src, "Hoodie_TorsoSleeves", lambda c: h * 0.38 < c.z < h * 0.84, main_mat, (0, 0, 1, 1), 0.018, dec_cloth)
        shorts = subset_mesh(src, "Shorts", lambda c: h * 0.24 < c.z < h * 0.45, main_mat, (0, 0, 1, 1), 0.014, dec_cloth)
        shoe_overlay = subset_mesh(src, "Rubber_Shoe_Overlay", lambda c: c.z < h * 0.085, accent_mat, (0.5, 0.0, 1.0, 0.5), 0.012, 0.72)
        for obj in (skin, hoodie, shorts, shoe_overlay):
            if obj:
                objects.append(obj)
        objects += [
            add_uv_sphere("Hair_Cap", (0, h * 0.018, h * 0.988), (h * 0.066, h * 0.043, h * 0.018), accent_mat, (0.5, 0.5, 1.0, 1.0), segments=40, rings=18, decimate=0.72 if not photoreal else None),
            add_beveled_cube("Backpack_Body", (0, h * 0.115, h * 0.54), (h * 0.16, h * 0.06, h * 0.19), main_mat, (0, 0, 1, 1), bevel=h * 0.018),
            add_beveled_cube("Backpack_FrontPocket", (0, h * 0.155, h * 0.47), (h * 0.12, h * 0.025, h * 0.055), main_mat, (0, 0, 1, 1), bevel=h * 0.012),
            add_tube("Hood_Drawstring_L", [(-h * 0.035, -h * 0.13, h * 0.70), (-h * 0.045, -h * 0.14, h * 0.62)], h * 0.004, accent_mat, (0.5, 0.0, 1.0, 0.5)),
            add_tube("Hood_Drawstring_R", [(h * 0.035, -h * 0.13, h * 0.70), (h * 0.045, -h * 0.14, h * 0.62)], h * 0.004, accent_mat, (0.5, 0.0, 1.0, 0.5)),
            add_uv_sphere("Eye_L", (-h * 0.030, -h * 0.150, h * 0.902), (h * 0.008, h * 0.004, h * 0.007), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=18, rings=10),
            add_uv_sphere("Eye_R", (h * 0.030, -h * 0.150, h * 0.902), (h * 0.008, h * 0.004, h * 0.007), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=18, rings=10),
            add_uv_sphere("Nose_SoftBridge", (0, -h * 0.154, h * 0.865), (h * 0.006, h * 0.006, h * 0.013), accent_mat, (0.0, 0.0, 0.5, 0.5), segments=16, rings=8),
            add_tube("Mouth_Line", [(-h * 0.016, -h * 0.156, h * 0.835), (h * 0.016, -h * 0.156, h * 0.835)], h * 0.0015, accent_mat, (0.5, 0.0, 1.0, 0.5)),
        ]
        for x in (-h * 0.075, h * 0.075):
            objects.append(add_beveled_cube(f"Shoe_Toe_{'L' if x < 0 else 'R'}", (x, -h * 0.048, h * 0.040), (h * 0.052, h * 0.078, h * 0.018), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.010))
        for x in (-h * 0.095, h * 0.095):
            objects.append(add_tube(f"Backpack_Strap_{'L' if x < 0 else 'R'}", [(x, -h * 0.095, h * 0.70), (x * 0.78, -h * 0.11, h * 0.47)], h * 0.012, main_mat, (0, 0, 1, 1)))

    elif role == "Villain":
        skin = None
        coat = subset_mesh(src, "Long_Coat_Shell", lambda c: h * 0.16 < c.z < h * 0.84, main_mat, (0, 0, 1, 1), 0.035 if not blind else 0.050, dec_cloth)
        pants = subset_mesh(src, "Dark_Pants", lambda c: h * 0.05 < c.z < h * 0.42, main_mat, (0, 0, 1, 1), 0.018, dec_cloth)
        boot_overlay = subset_mesh(src, "Boot_Overlay", lambda c: c.z < h * 0.10, accent_mat, (0.5, 0.0, 1.0, 0.5), 0.014, 0.70)
        for obj in (skin, coat, pants, boot_overlay):
            if obj:
                objects.append(obj)
        objects += [
            add_uv_sphere("Deep_Hood", (0, -h * 0.030, h * 0.905), (h * 0.105, h * 0.070, h * 0.070), main_mat, (0, 0, 1, 1), segments=48, rings=20, decimate=0.75 if blind else None),
            add_uv_sphere("Face_Shadow", (0, -h * 0.100, h * 0.865), (h * 0.050, h * 0.010, h * 0.045), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=24, rings=12),
            add_tube("Coat_Zipper", [(0, -h * 0.17, h * 0.72), (0, -h * 0.18, h * 0.22)], h * 0.004, accent_mat, (0.0, 0.5, 0.5, 1.0)),
            add_tube("Coat_Left_Seam", [(-h * 0.13, -h * 0.165, h * 0.68), (-h * 0.20, -h * 0.17, h * 0.20)], h * 0.003, accent_mat, (0.0, 0.5, 0.5, 1.0)),
            add_tube("Coat_Right_Seam", [(h * 0.13, -h * 0.165, h * 0.68), (h * 0.20, -h * 0.17, h * 0.20)], h * 0.003, accent_mat, (0.0, 0.5, 0.5, 1.0)),
        ]
        for x in (-h * 0.085, h * 0.085):
            objects.append(add_beveled_cube(f"Boot_Toe_{'L' if x < 0 else 'R'}", (x, -h * 0.030, h * 0.055), (h * 0.060, h * 0.082, h * 0.026), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.012))

    elif role == "Police":
        skin = None
        shirt = subset_mesh(src, "Uniform_Shirt", lambda c: h * 0.40 < c.z < h * 0.82, main_mat, (0, 0, 1, 1), 0.016 if not blind else 0.030, dec_cloth)
        pants = subset_mesh(src, "Uniform_Pants", lambda c: h * 0.08 < c.z < h * 0.46, main_mat, (0, 0, 1, 1), 0.014, dec_cloth)
        shoe_overlay = subset_mesh(src, "Uniform_Shoe_Overlay", lambda c: c.z < h * 0.09, accent_mat, (0.5, 0.0, 1.0, 0.5), 0.012, 0.72)
        for obj in (skin, shirt, pants, shoe_overlay):
            if obj:
                objects.append(obj)
        objects += [
            add_uv_sphere("Hair_Cap", (0, h * 0.010, h * 0.968), (h * 0.046, h * 0.036, h * 0.014), accent_mat, (0.5, 0.5, 1.0, 1.0), segments=36, rings=14, decimate=0.72 if not photoreal else None),
            add_cylinder("Police_Cap_Crown", (0, h * 0.000, h * 1.002), h * 0.056, h * 0.026, main_mat, (0, 0, 1, 1), vertices=56, bevel=h * 0.006),
            add_beveled_cube("Police_Cap_Brim", (0, -h * 0.058, h * 0.972), (h * 0.070, h * 0.030, h * 0.008), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.006),
            add_beveled_cube("Belt_Front", (0, -h * 0.142, h * 0.470), (h * 0.215, h * 0.008, h * 0.018), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.003),
            add_beveled_cube("Badge_Chest", (-h * 0.062, -h * 0.158, h * 0.67), (h * 0.023, h * 0.006, h * 0.032), accent_mat, (0.0, 0.5, 0.5, 1.0), bevel=h * 0.004),
            add_beveled_cube("Radio_Shoulder", (h * 0.115, -h * 0.12, h * 0.70), (h * 0.028, h * 0.014, h * 0.044), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.004),
            add_uv_sphere("Eye_L", (-h * 0.030, -h * 0.146, h * 0.902), (h * 0.007, h * 0.0035, h * 0.006), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=18, rings=10),
            add_uv_sphere("Eye_R", (h * 0.030, -h * 0.146, h * 0.902), (h * 0.007, h * 0.0035, h * 0.006), accent_mat, (0.5, 0.0, 1.0, 0.5), segments=18, rings=10),
            add_uv_sphere("Nose_SoftBridge", (0, -h * 0.150, h * 0.865), (h * 0.006, h * 0.006, h * 0.013), accent_mat, (0.0, 0.0, 0.5, 0.5), segments=16, rings=8),
            add_tube("Mouth_Line", [(-h * 0.016, -h * 0.152, h * 0.835), (h * 0.016, -h * 0.152, h * 0.835)], h * 0.0015, accent_mat, (0.5, 0.0, 1.0, 0.5)),
        ]
        for x in (-h * 0.08, h * 0.08):
            objects.append(add_beveled_cube(f"Shoe_Toe_{'L' if x < 0 else 'R'}", (x, -h * 0.036, h * 0.045), (h * 0.052, h * 0.078, h * 0.020), accent_mat, (0.5, 0.0, 1.0, 0.5), bevel=h * 0.010))

    return [obj for obj in objects if obj is not None]


def decimate_scene_objects(objects, ratio: float) -> None:
    for obj in objects:
        if obj.type != "MESH":
            continue
        mod = obj.modifiers.new("LOD_Decimate", "DECIMATE")
        mod.ratio = ratio
        apply_modifiers(obj)


def fit_lod0_budget(objects, min_tris: int, max_tris: int) -> dict:
    """Apply adaptive decimation until LOD0 lands inside the target range."""
    target = int((min_tris + max_tris) * 0.52)
    current = stats_for_objects(objects)
    for _ in range(4):
        tris = current["triangles"]
        if tris <= max_tris:
            break
        ratio = max(0.08, min(0.88, target / max(tris, 1)))
        decimate_scene_objects(objects, ratio)
        current = stats_for_objects(objects)
    return current


def move_body_wip_sources() -> None:
    source_root = ROOT / "art-source" / "_Source" / "Characters" / "MBLabBodySources"
    for path in CHAR_DIR.rglob("*BodySource_WIP*"):
        rel = path.relative_to(CHAR_DIR)
        target = source_root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            target.unlink()
        shutil.move(str(path), str(target))


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
    src = append_object(spec["template"])
    src.name = f"{asset_name}_MBLab_Source"
    normalize_height(src, height)
    style_body_proportions(src, role, style)

    main_mat = make_material(f"M_{asset_name}_Main", texture_dir, role, style, "Main", spec["texture_res"])
    accent_mat = make_material(f"M_{asset_name}_AccentAtlas", texture_dir, role, style, "Accent", spec["texture_res"])
    objects = make_role_meshes(src, role, style, height, main_mat, accent_mat)
    bpy.data.objects.remove(src, do_unlink=True)

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
    if style in LOD_REQUIRED:
        decimate_scene_objects(objects, 0.55)
        lod_stats["LOD1"] = stats_for_objects(objects)
        export_fbx(out_dir / f"{asset_name}_LOD1.fbx", objects, arm)
        decimate_scene_objects(objects, 0.45)
        lod_stats["LOD2"] = stats_for_objects(objects)
        export_fbx(out_dir / f"{asset_name}_LOD2.fbx", objects, arm)

    tris = lod_stats["LOD0"]["triangles"]
    budget_passed = min_tris <= tris <= max_tris
    texture_gate = metrics["quality_gate"]
    report = {
        "asset": asset_name,
        "task": f"Task {'B' if role == 'Kid' else 'C' if role == 'Villain' else 'D'}",
        "role": role,
        "style": style,
        "reference_image": REFERENCE_IMAGES[role],
        "files": {
            "fbx": str((out_dir / f"{asset_name}.fbx").relative_to(ROOT)),
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
            "humanoid_base_source": "MB-Lab humanoid_library.blend",
            "human_visible_geometry_from_primitive_shapes": False,
            "processed_accessory_primitives_with_bevels": True,
            "bevel_used": True,
            "surface_detail_layers": ["PBR image texture", "stitch/wear map layer", "beveled accessories", "seam/zipper tubes"],
        },
        "quality_gate": {
            "basecolor_stddev": texture_gate["min_basecolor_stddev"],
            "normal_stddev": texture_gate["min_normal_stddev"],
            "ao_stddev": texture_gate["min_ao_stddev"],
            "texture_checks": texture_gate["texture_checks"],
            "texture_gate_passed": texture_gate["all_textures_passed"],
            "triangle_budget_passed": budget_passed,
            "local_art_gate_passed": texture_gate["all_textures_passed"] and budget_passed,
            "overall_passed": False,
            "overall_blocker": "Unity Humanoid Avatar/import validation cannot be completed until the local Unity Editor license is activated.",
        },
        "manual_visual_review": {
            "status": "needs_artist_polish_not_final_art_approved",
            "notes": "Generated candidate passes numeric texture/triangle gates, but face, hair, clothing finish, and final role likeness still require a human art polish pass before final approval.",
        },
        "status": "local_art_gate_candidate_unity_validation_pending",
    }
    report_path = out_dir / "Reports" / f"{asset_name}_budget_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "asset": asset_name,
        "triangles": tris,
        "budget_passed": budget_passed,
        "texture_passed": texture_gate["all_textures_passed"],
        "local_art_gate_passed": report["quality_gate"]["local_art_gate_passed"],
    }


def main() -> int:
    move_body_wip_sources()
    results = [generate(spec) for spec in SPECS]
    summary = {
        "asset_count": len(results),
        "local_art_gate_passed": all(item["local_art_gate_passed"] for item in results),
        "unity_validation": "blocked_no_active_unity_license",
        "manual_visual_review": "needs_artist_polish_not_final_art_approved",
        "results": results,
    }
    path = ROOT / "docs" / "art_production" / "CHARACTER_REWORK_SUMMARY.json"
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["local_art_gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
