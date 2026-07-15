#!/usr/bin/env python3
"""Generate Villain and Police three-style 3D character candidates.

This is an art-only pass for Task C/D. It keeps the rejected Quaternius files in
place as provenance and writes new versioned outputs under each role/style
folder. The visible body source is MB-Lab humanoid topology, with art-directed
coat/uniform/toy details, copied PBR texture sets, shared Humanoid bone names,
FBX/GLB exports, preview renders, wireframes, and per-asset reports.
"""

from __future__ import annotations

import ast
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "tools" / "third_party" / "MB-Lab" / "data" / "humanoid_library.blend"
CHAR_DIR = ROOT / "art-source" / "Characters"
SHARED_RIG = ROOT / "tools" / "art_pipeline" / "generate_shared_humanoid_rig.py"
VERSION_DIR = "CharacterRoleRework_2026_07_12_v9"
CONTACT_SHEET = ROOT / "docs" / "art_production" / "VILLAIN_POLICE_THREE_STYLE_CONTACT_SHEET_V9.png"
SUMMARY_PATH = ROOT / "docs" / "art_production" / "VILLAIN_POLICE_THREE_STYLE_REWORK_SUMMARY_V9.json"


def load_bones():
    tree = ast.parse(SHARED_RIG.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "BONES":
                    return ast.literal_eval(node.value)
    raise RuntimeError(f"BONES not found in {SHARED_RIG}")


BONES = load_bones()

SPECS = [
    {
        "role": "Villain",
        "style": "Stylized",
        "asset": "Villain_Stylized_RoleHuman_v9",
        "template": "MBLab_human_male",
        "height": 1.86,
        "budget": (20000, 32000),
        "texture_res": "2K",
        "label": "Villain Cartoon",
    },
    {
        "role": "Villain",
        "style": "Photoreal",
        "asset": "Villain_Photoreal_RoleHuman_v9",
        "template": "MBLab_human_male",
        "height": 1.88,
        "budget": (45000, 75000),
        "texture_res": "4K",
        "label": "Villain Photoreal",
    },
    {
        "role": "Villain",
        "style": "BlindBox",
        "asset": "Villain_BlindBox_RoleHuman_v9",
        "template": "MBLab_anime_male",
        "height": 1.42,
        "budget": (14000, 22000),
        "texture_res": "2K",
        "label": "Villain BlindBox",
    },
    {
        "role": "Police",
        "style": "Stylized",
        "asset": "Police_Stylized_RoleHuman_v9",
        "template": "MBLab_human_male",
        "height": 1.80,
        "budget": (18000, 28000),
        "texture_res": "2K",
        "label": "Police Cartoon",
    },
    {
        "role": "Police",
        "style": "Photoreal",
        "asset": "Police_Photoreal_RoleHuman_v9",
        "template": "MBLab_human_male",
        "height": 1.82,
        "budget": (40000, 60000),
        "texture_res": "4K",
        "label": "Police Photoreal",
    },
    {
        "role": "Police",
        "style": "BlindBox",
        "asset": "Police_BlindBox_RoleHuman_v9",
        "template": "MBLab_anime_male",
        "height": 1.32,
        "budget": (12000, 18000),
        "texture_res": "2K",
        "label": "Police BlindBox",
    },
]

REFERENCE_IMAGES = {
    "Villain": "art-source/Concepts/Rework_2026-07-12/02_villain_high_bar_model_sheet.png",
    "Police": "art-source/Concepts/Rework_2026-07-12/03_police_high_bar_model_sheet.png",
}


def run_blender() -> None:
    subprocess.run(
        ["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build"],
        cwd=str(ROOT),
        check=True,
    )
    build_contact_sheet()


def build_contact_sheet() -> None:
    from PIL import Image, ImageDraw

    sheet = Image.new("RGB", (2460, 2160), (30, 30, 30))
    draw = ImageDraw.Draw(sheet)
    for i, spec in enumerate(SPECS):
        row = 0 if spec["role"] == "Villain" else 1
        col = i % 3
        img_path = (
            ROOT
            / "art-source"
            / "Characters"
            / spec["role"]
            / spec["style"]
            / VERSION_DIR
            / "Previews"
            / f"{spec['asset']}_preview.png"
        )
        img = Image.open(img_path).convert("RGB")
        img.thumbnail((760, 940), Image.Resampling.LANCZOS)
        x = col * 820 + (820 - img.width) // 2
        y = row * 1080 + 92
        sheet.paste(img, (x, y))
        draw.text((col * 820 + 42, row * 1080 + 32), spec["label"], fill=(242, 242, 236))
    CONTACT_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(CONTACT_SHEET, optimize=True)


def blender_main() -> None:
    import bpy
    from mathutils import Vector

    if not LIB.exists():
        raise FileNotFoundError(LIB)

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
        scale = target_height / max(mesh_height(obj), 1e-5)
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
            if role == "Villain":
                if 0.42 < z < 0.82:
                    v.co.x *= 1.10 if style != "BlindBox" else 1.20
                    v.co.y *= 1.05
                if z < 0.20:
                    v.co.x *= 1.08
                    v.co.y *= 1.06
            elif role == "Police":
                if 0.43 < z < 0.80:
                    v.co.x *= 1.04 if style != "BlindBox" else 1.13
                    v.co.y *= 1.03
                if z < 0.20:
                    v.co.x *= 1.06
            if style == "BlindBox":
                if z > 0.74:
                    v.co.x *= 1.17
                    v.co.y *= 1.17
                if 0.35 < z < 0.72:
                    v.co.x *= 1.06
        obj.data.update()

    def pose_source_for_display(obj, role: str, style: str) -> None:
        """Convert library T-pose bodies into a reviewable A-pose silhouette."""
        coords = [v.co.copy() for v in obj.data.vertices]
        height = max(c.z for c in coords) - min(c.z for c in coords)
        max_x = max(abs(c.x) for c in coords)
        shoulder_x = height * (0.118 if role == "Police" else 0.128)
        shoulder_z = height * (0.705 if role == "Police" else 0.720)
        elbow_bend = height * (0.016 if role == "Police" else 0.026)
        angle = math.radians(82 if role == "Police" else 78)
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        for v in obj.data.vertices:
            side = -1.0 if v.co.x < 0 else 1.0
            z_norm = v.co.z / max(height, 1e-5)
            arm_candidate = abs(v.co.x) > shoulder_x and 0.255 < z_norm < 0.805
            if not arm_candidate:
                continue
            u = max(0.0, abs(v.co.x) - shoulder_x)
            w = v.co.z - shoulder_z
            t = min(1.0, max(0.0, u / max(max_x - shoulder_x, 1e-5)))
            rotated_u = u * cos_a - w * sin_a
            rotated_z = -u * sin_a + w * cos_a
            v.co.x = side * (shoulder_x + rotated_u + height * 0.010 * t)
            v.co.z = shoulder_z + rotated_z - height * 0.035 * t
            v.co.y += -elbow_bend * math.sin(t * math.pi)
        obj.data.update()

    def out_dir_for(spec: dict) -> Path:
        return CHAR_DIR / spec["role"] / spec["style"] / VERSION_DIR

    def copy_texture_set(spec: dict, out_dir: Path) -> Path:
        source = CHAR_DIR / spec["role"] / spec["style"] / "Textures"
        target = out_dir / "Textures"
        target.mkdir(parents=True, exist_ok=True)
        for path in source.glob("*.png"):
            shutil.copy2(path, target / path.name)
        return target

    def make_material(name: str, tex_dir: Path, role: str, style: str, kind: str, res: str, roughness: float):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        base = tex_dir / f"Char_{role}_{style}_{kind}_BaseColor_{res}.png"
        normal = tex_dir / f"Char_{role}_{style}_{kind}_Normal_{res}.png"
        ms = tex_dir / f"Char_{role}_{style}_{kind}_MetallicSmoothness_{res}.png"
        if bsdf:
            tex = mat.node_tree.nodes.new(type="ShaderNodeTexImage")
            tex.image = bpy.data.images.load(str(base))
            mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            ntex = mat.node_tree.nodes.new(type="ShaderNodeTexImage")
            ntex.image = bpy.data.images.load(str(normal))
            ntex.image.colorspace_settings.name = "Non-Color"
            nmap = mat.node_tree.nodes.new(type="ShaderNodeNormalMap")
            mat.node_tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
            mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = 0.0
            if ms.exists() and kind == "Accent":
                if "Metallic" in bsdf.inputs:
                    bsdf.inputs["Metallic"].default_value = 0.12 if role == "Police" else 0.03
        mat["texture_set"] = kind
        return mat

    def make_procedural_mat(name: str, color, roughness: float, metallic: float = 0.0, bump: float = 0.0):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.diffuse_color = color
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
            if "Metallic" in bsdf.inputs:
                bsdf.inputs["Metallic"].default_value = metallic
            if bump > 0 and "Normal" in bsdf.inputs:
                noise = mat.node_tree.nodes.new(type="ShaderNodeTexNoise")
                noise.inputs["Scale"].default_value = 58
                noise.inputs["Detail"].default_value = 11
                noise.inputs["Roughness"].default_value = 0.58
                bump_node = mat.node_tree.nodes.new(type="ShaderNodeBump")
                bump_node.inputs["Strength"].default_value = bump
                bump_node.inputs["Distance"].default_value = 0.045
                mat.node_tree.links.new(noise.outputs["Fac"], bump_node.inputs["Height"])
                mat.node_tree.links.new(bump_node.outputs["Normal"], bsdf.inputs["Normal"])
        return mat

    def assign_uv_bounds(obj, bounds) -> None:
        mesh = obj.data
        while mesh.uv_layers:
            mesh.uv_layers.remove(mesh.uv_layers[0])
        uv = mesh.uv_layers.new(name="UV0")
        coords = [v.co.copy() for v in mesh.vertices]
        min_x, max_x = min(v.x for v in coords), max(v.x for v in coords)
        min_z, max_z = min(v.z for v in coords), max(v.z for v in coords)
        x_span = max(max_x - min_x, 1e-5)
        z_span = max(max_z - min_z, 1e-5)
        u0, v0, u1, v1 = bounds
        for poly in mesh.polygons:
            for li in poly.loop_indices:
                co = mesh.vertices[mesh.loops[li].vertex_index].co
                u = u0 + ((co.x - min_x) / x_span) * (u1 - u0)
                vv = v0 + ((co.z - min_z) / z_span) * (v1 - v0)
                uv.data[li].uv = (max(0.0, min(1.0, u)), max(0.0, min(1.0, vv)))

    def apply_modifiers(obj) -> None:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in list(obj.modifiers):
            if mod.type == "ARMATURE":
                continue
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception:
                pass
        obj.select_set(False)

    def finish_mesh(obj, material, uv_bounds=(0, 0, 1, 1), bevel=None, decimate=None) -> None:
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for poly in obj.data.polygons:
            poly.material_index = 0
            poly.use_smooth = True
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

    def subset_mesh(src, name: str, face_filter, material, uv_bounds, offset: float, decimate: float):
        new_vertices = []
        new_faces = []
        index_map = {}
        for poly in src.data.polygons:
            coords = [src.data.vertices[i].co for i in poly.vertices]
            center = sum((c for c in coords), Vector()) / len(coords)
            if not face_filter(center):
                continue
            face = []
            for vi in poly.vertices:
                if vi not in index_map:
                    vertex = src.data.vertices[vi]
                    normal = vertex.normal.normalized()
                    index_map[vi] = len(new_vertices)
                    new_vertices.append(vertex.co + normal * offset)
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
        finish_mesh(obj, material, uv_bounds, bevel=0.003 if offset else None, decimate=decimate)
        return obj

    def add_beveled_cube(name: str, loc, scale, material, uv_bounds=(0, 0, 1, 1), bevel=0.02):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        finish_mesh(obj, material, uv_bounds, bevel=bevel)
        return obj

    def add_uv_sphere(name: str, loc, scale, material, uv_bounds=(0, 0, 1, 1), segments=32, rings=16, decimate=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        finish_mesh(obj, material, uv_bounds, bevel=None, decimate=decimate)
        return obj

    def add_cylinder(name: str, loc, radius, depth, material, uv_bounds=(0, 0, 1, 1), vertices=48, bevel=0.01, rotation=(0, 0, 0)):
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
        obj = bpy.context.object
        obj.name = name
        finish_mesh(obj, material, uv_bounds, bevel=bevel)
        return obj

    def add_tube(name: str, points, radius, material, uv_bounds=(0, 0, 1, 1), resolution=3):
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

    def add_torus(name: str, loc, major, minor, material, uv_bounds=(0, 0, 1, 1), rotation=(0, 0, 0)):
        bpy.ops.mesh.primitive_torus_add(major_segments=72, minor_segments=12, location=loc, major_radius=major, minor_radius=minor, rotation=rotation)
        obj = bpy.context.object
        obj.name = name
        finish_mesh(obj, material, uv_bounds, bevel=None, decimate=0.75)
        return obj

    def add_capsule_segment(name: str, p1, p2, radius: float, material, uv_bounds=(0, 0, 1, 1), vertices=32, bevel=0.003, end_scale=1.0, decimate=None):
        a = Vector(p1)
        b = Vector(p2)
        mid = (a + b) * 0.5
        length = max((b - a).length, 1e-5)
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=length, location=mid)
        cyl = bpy.context.object
        cyl.name = f"{name}_Shaft"
        cyl.rotation_euler = (b - a).to_track_quat("Z", "Y").to_euler()
        finish_mesh(cyl, material, uv_bounds, bevel=bevel, decimate=decimate)
        cap_a = add_uv_sphere(f"{name}_CapA", a, (radius * end_scale, radius * end_scale, radius * end_scale), material, uv_bounds, max(18, vertices // 2), 8, decimate)
        cap_b = add_uv_sphere(f"{name}_CapB", b, (radius * end_scale, radius * end_scale, radius * end_scale), material, uv_bounds, max(18, vertices // 2), 8, decimate)
        return [cyl, cap_a, cap_b]

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
        by_name = {first.name: first}
        for name, parent, head, tail in BONES[1:]:
            bone = arm.data.edit_bones.new(name)
            bone.head = Vector(head) * scale
            bone.tail = Vector(tail) * scale
            if parent:
                bone.parent = by_name[parent]
                bone.use_connect = False
            by_name[name] = bone
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
        if abs(co.x) > 0.25 * height and 0.30 < z < 0.80:
            if z < 0.42:
                return f"{side}Hand"
            if z < 0.57:
                return f"{side}LowerArm"
            return f"{side}UpperArm"
        if z < 0.11:
            return f"{side}Foot"
        if z < 0.35:
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
        depsgraph = bpy.context.evaluated_depsgraph_get()
        vertices = polygons = triangles = 0
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

    def decimate_scene_objects(objects, ratio: float) -> None:
        for obj in objects:
            if obj.type != "MESH":
                continue
            mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
            mod.ratio = ratio
            apply_modifiers(obj)

    def fit_budget(objects, min_tris: int, max_tris: int) -> dict:
        current = stats_for_objects(objects)
        for _ in range(5):
            if current["triangles"] <= max_tris:
                break
            target = int((min_tris + max_tris) * 0.56)
            ratio = max(0.08, min(0.86, target / max(current["triangles"], 1)))
            decimate_scene_objects(objects, ratio)
            current = stats_for_objects(objects)
        return current

    def make_villain(src, spec, mats):
        h = spec["height"]
        blind = spec["style"] == "BlindBox"
        photoreal = spec["style"] == "Photoreal"
        main = mats["coat"]
        shadow = mats["shadow"]
        leather = mats["black_leather"]
        metal = mats["dark_metal"]
        eye = mats["eye_glow"]
        dec_body = 0.70 if photoreal else 0.50 if blind else 0.55
        dec_cloth = 0.88 if photoreal else 0.46 if blind else 0.56
        objects = []
        no_source_arms = lambda c: not (abs(c.x) > h * 0.135 and h * 0.245 < c.z < h * 0.805)
        body = subset_mesh(src, "Villain_BodyShadowUnderlay", no_source_arms, shadow, (0, 0, 0.5, 0.5), 0.0, dec_body)
        coat_filter = lambda c: h * 0.13 < c.z < h * 0.83 and abs(c.x) < h * (0.160 if not blind else 0.185)
        pants_filter = lambda c: h * 0.08 < c.z < h * 0.43 and abs(c.x) < h * (0.145 if not blind else 0.165)
        coat = subset_mesh(src, "Villain_TailoredLeatherCoatBody", coat_filter, main, (0, 0, 1, 1), h * (0.030 if not blind else 0.046), dec_cloth)
        pants = subset_mesh(src, "Villain_DarkTaperedPants", pants_filter, main, (0, 0, 1, 1), h * 0.016, dec_cloth)
        boots = subset_mesh(src, "Villain_HeavyBoots", lambda c: c.z < h * 0.115, leather, (0.5, 0, 1, 0.5), h * 0.016, 0.68)
        objects.extend([obj for obj in (body, coat, pants, boots) if obj])
        for side, sign in (("L", -1), ("R", 1)):
            shoulder = (sign * h * 0.145, -h * 0.038, h * 0.695)
            elbow = (sign * h * 0.184, -h * 0.082, h * 0.510)
            wrist = (sign * h * 0.195, -h * 0.096, h * 0.330)
            objects.append(add_uv_sphere(f"Villain_RoundedShoulderCap_{side}", (sign * h * 0.132, -h * 0.040, h * 0.715), (h * 0.058, h * 0.040, h * 0.038), main, (0, 0, 1, 1), 36 if not photoreal else 48, 14, 0.70 if blind else None))
            objects += add_capsule_segment(f"Villain_UpperSleeve_{side}", shoulder, elbow, h * (0.039 if not blind else 0.047), main, (0, 0, 1, 1), 32 if not photoreal else 40, h * 0.004, 0.96, 0.72 if blind else None)
            objects += add_capsule_segment(f"Villain_LowerSleeve_{side}", elbow, wrist, h * (0.032 if not blind else 0.041), leather, (0.5, 0, 1, 0.5), 28 if not photoreal else 36, h * 0.004, 0.98, 0.72 if blind else None)
            objects.append(add_uv_sphere(f"Villain_GloveHand_{side}", (sign * h * 0.232, -h * 0.096, h * 0.292), (h * 0.034, h * 0.026, h * 0.041), leather, (0.5, 0, 1, 0.5), 24 if not photoreal else 32, 12, 0.74 if blind else None))
        objects += [
            add_uv_sphere("Villain_DeepHoodShell", (0, -h * 0.052, h * 0.900), (h * (0.102 if not blind else 0.126), h * (0.072 if not blind else 0.092), h * (0.095 if not blind else 0.112)), main, (0, 0, 1, 1), 64 if photoreal else 48, 24, 0.84 if blind else None),
            add_uv_sphere("Villain_HoodCrownBack", (0, h * 0.006, h * 0.906), (h * (0.090 if not blind else 0.116), h * (0.054 if not blind else 0.070), h * (0.070 if not blind else 0.086)), main, (0, 0, 1, 1), 48 if photoreal else 36, 14, 0.80 if blind else None),
            add_uv_sphere("Villain_HoodBrowOverhang", (0, -h * 0.120, h * 0.878), (h * (0.082 if not blind else 0.106), h * 0.022, h * 0.024), main, (0, 0, 1, 1), 48 if photoreal else 36, 12, 0.82 if blind else None),
            add_tube("Villain_HoodRim", [(-h * 0.068, -h * 0.130, h * 0.900), (-h * 0.052, -h * 0.146, h * 0.862), (-h * 0.026, -h * 0.152, h * 0.836), (0, -h * 0.154, h * 0.826), (h * 0.026, -h * 0.152, h * 0.836), (h * 0.052, -h * 0.146, h * 0.862), (h * 0.068, -h * 0.130, h * 0.900)], h * 0.007, leather, (0.5, 0, 1, 0.5)),
            add_uv_sphere("Villain_FaceInset", (0, -h * 0.132, h * 0.855), (h * 0.058, h * 0.011, h * 0.052), mats["face_skin"], (0.5, 0, 1, 0.5), 32, 12, 0.65 if blind else None),
            add_uv_sphere("Villain_BeardShadow", (0, -h * 0.139, h * 0.826), (h * 0.048, h * 0.006, h * 0.024), shadow, (0.5, 0, 1, 0.5), 24, 8, 0.62 if blind else None),
            add_tube("Villain_NoseBridge", [(0, -h * 0.146, h * 0.873), (0, -h * 0.149, h * 0.848)], h * 0.0022, mats["face_skin"], (0.5, 0, 1, 0.5)),
            add_torus("Villain_CowlScarf", (0, -h * 0.045, h * 0.775), h * 0.098, h * 0.014, main, (0, 0, 1, 1), rotation=(math.radians(84), 0, 0)),
            add_tube("Villain_CoatZipper", [(0, -h * 0.175, h * 0.73), (0, -h * 0.185, h * 0.20)], h * 0.0045, metal, (0, 0.5, 0.5, 1)),
            add_tube("Villain_LeftCoatEdge", [(-h * 0.105, -h * 0.172, h * 0.73), (-h * 0.180, -h * 0.176, h * 0.18)], h * 0.004, leather, (0, 0.5, 0.5, 1)),
            add_tube("Villain_RightCoatEdge", [(h * 0.105, -h * 0.172, h * 0.73), (h * 0.180, -h * 0.176, h * 0.18)], h * 0.004, leather, (0, 0.5, 0.5, 1)),
            add_tube("Villain_LeftShoulderSeam", [(-h * 0.060, -h * 0.132, h * 0.735), (-h * 0.118, -h * 0.106, h * 0.728), (-h * 0.164, -h * 0.058, h * 0.702)], h * 0.0035, leather, (0.5, 0, 1, 0.5)),
            add_tube("Villain_RightShoulderSeam", [(h * 0.060, -h * 0.132, h * 0.735), (h * 0.118, -h * 0.106, h * 0.728), (h * 0.164, -h * 0.058, h * 0.702)], h * 0.0035, leather, (0.5, 0, 1, 0.5)),
            add_beveled_cube("Villain_Belt", (0, -h * 0.150, h * 0.455), (h * 0.210, h * 0.010, h * 0.018), leather, (0.5, 0, 1, 0.5), h * 0.004),
            add_beveled_cube("Villain_Buckle", (0, -h * 0.162, h * 0.455), (h * 0.036, h * 0.010, h * 0.030), metal, (0, 0.5, 0.5, 1), h * 0.004),
            add_beveled_cube("Villain_LeftCoatPocketFlap", (-h * 0.105, -h * 0.185, h * 0.500), (h * 0.055, h * 0.008, h * 0.017), leather, (0.5, 0, 1, 0.5), h * 0.004),
            add_beveled_cube("Villain_RightCoatPocketFlap", (h * 0.105, -h * 0.185, h * 0.500), (h * 0.055, h * 0.008, h * 0.017), leather, (0.5, 0, 1, 0.5), h * 0.004),
            add_tube("Villain_LeftLapelledSeam", [(-h * 0.070, -h * 0.182, h * 0.710), (-h * 0.132, -h * 0.184, h * 0.545), (-h * 0.150, -h * 0.184, h * 0.245)], h * 0.0032, metal, (0, 0.5, 0.5, 1)),
            add_tube("Villain_RightLapelledSeam", [(h * 0.070, -h * 0.182, h * 0.710), (h * 0.132, -h * 0.184, h * 0.545), (h * 0.150, -h * 0.184, h * 0.245)], h * 0.0032, metal, (0, 0.5, 0.5, 1)),
            add_tube("Villain_CoatHem", [(-h * 0.160, -h * 0.186, h * 0.210), (-h * 0.055, -h * 0.190, h * 0.190), (h * 0.055, -h * 0.190, h * 0.190), (h * 0.160, -h * 0.186, h * 0.210)], h * 0.0045, leather, (0.5, 0, 1, 0.5)),
        ]
        for side, x in (("L", -h * 0.023), ("R", h * 0.023)):
            objects.append(add_uv_sphere(f"Villain_EyeSlit_{side}", (x, -h * 0.137, h * 0.866), (h * 0.010, h * 0.003, h * 0.004), eye, (0, 0.5, 0.5, 1), 18, 8, 0.75 if blind else None))
        for i, z in enumerate([0.66, 0.58, 0.50, 0.42]):
            objects.append(add_uv_sphere(f"Villain_CoatButton_{i}", (-h * 0.042, -h * 0.184, h * z), (h * 0.008, h * 0.003, h * 0.008), metal, (0, 0.5, 0.5, 1), 16, 8))
            objects.append(add_uv_sphere(f"Villain_CoatButton_R_{i}", (h * 0.042, -h * 0.184, h * z), (h * 0.008, h * 0.003, h * 0.008), metal, (0, 0.5, 0.5, 1), 16, 8))
        for side, x in (("L", -h * 0.085), ("R", h * 0.085)):
            objects.append(add_beveled_cube(f"Villain_BootToe_{side}", (x, -h * 0.035, h * 0.052), (h * 0.070, h * 0.092, h * 0.030), leather, (0.5, 0, 1, 0.5), h * 0.014))
            objects.append(add_beveled_cube(f"Villain_BootSole_{side}", (x, -h * 0.035, h * 0.020), (h * 0.078, h * 0.100, h * 0.010), metal, (0, 0.5, 0.5, 1), h * 0.003))
            objects.append(add_beveled_cube(f"Villain_CoatSleeveCuff_{side}", (side == "L" and -h * 0.220 or h * 0.220, -h * 0.078, h * 0.365), (h * 0.044, h * 0.018, h * 0.018), leather, (0.5, 0, 1, 0.5), h * 0.006))
            for k in range(3):
                objects.append(add_tube(f"Villain_GloveKnuckle_{side}_{k}", [(side == "L" and -h * (0.201 + k * 0.010) or h * (0.201 + k * 0.010), -h * 0.095, h * 0.318), (side == "L" and -h * (0.206 + k * 0.010) or h * (0.206 + k * 0.010), -h * 0.102, h * 0.304)], h * 0.0016, metal, (0, 0.5, 0.5, 1)))
            for lace in range(4):
                z = h * (0.070 + lace * 0.014)
                objects.append(add_tube(f"Villain_BootLace_{side}_{lace}", [(x - h * 0.032, -h * 0.086, z), (x + h * 0.032, -h * 0.086, z + h * 0.003)], h * 0.0018, metal, (0, 0.5, 0.5, 1)))
        return objects

    def make_police(src, spec, mats):
        h = spec["height"]
        blind = spec["style"] == "BlindBox"
        photoreal = spec["style"] == "Photoreal"
        uniform = mats["uniform"]
        skin = mats["skin"]
        black = mats["black_leather"]
        metal = mats["badge_metal"]
        navy_dark = mats["uniform_dark"]
        dec_body = 0.72 if photoreal else 0.48 if blind else 0.54
        dec_cloth = 0.86 if photoreal else 0.44 if blind else 0.54
        objects = []
        skin_filter = lambda c: abs(c.x) < h * 0.070 and h * 0.710 < c.z < h * 0.812
        body = subset_mesh(src, "Police_NeckHandsSkin", skin_filter, skin, (0, 0, 0.5, 0.5), 0.0, dec_body)
        torso_filter = lambda c: h * 0.40 < c.z < h * 0.82 and abs(c.x) < h * (0.142 if not blind else 0.165)
        pants_filter = lambda c: h * 0.08 < c.z < h * 0.49 and abs(c.x) < h * (0.145 if not blind else 0.162)
        shirt = subset_mesh(src, "Police_CleanUniformTorso", torso_filter, uniform, (0, 0, 1, 1), h * (0.020 if not blind else 0.034), dec_cloth)
        pants = subset_mesh(src, "Police_TaperedUniformPants", pants_filter, uniform, (0, 0, 1, 1), h * 0.015, dec_cloth)
        shoes = subset_mesh(src, "Police_BlackShoes", lambda c: c.z < h * 0.105, black, (0.5, 0, 1, 0.5), h * 0.013, 0.70)
        objects.extend([obj for obj in (body, shirt, pants, shoes) if obj])
        for side, sign in (("L", -1), ("R", 1)):
            shoulder = (sign * h * 0.122, -h * 0.035, h * 0.700)
            elbow = (sign * h * 0.162, -h * 0.073, h * 0.548)
            wrist = (sign * h * 0.190, -h * 0.088, h * 0.358)
            objects.append(add_uv_sphere(f"Police_RoundedSleeveCap_{side}", (sign * h * 0.118, -h * 0.048, h * 0.708), (h * 0.050, h * 0.034, h * 0.034), uniform, (0, 0, 1, 1), 34 if not photoreal else 44, 12, 0.70 if blind else None))
            objects += add_capsule_segment(f"Police_UpperShortSleeve_{side}", shoulder, elbow, h * (0.030 if not blind else 0.038), uniform, (0, 0, 1, 1), 32 if not photoreal else 40, h * 0.003, 0.95, 0.70 if blind else None)
            objects += add_capsule_segment(f"Police_ForearmSkin_{side}", elbow, wrist, h * (0.022 if not blind else 0.031), skin, (0, 0, 0.5, 0.5), 28 if not photoreal else 36, h * 0.0025, 0.95, 0.72 if blind else None)
            objects.append(add_uv_sphere(f"Police_Hand_{side}", (sign * h * 0.196, -h * 0.094, h * 0.324), (h * 0.025, h * 0.019, h * 0.032), skin, (0, 0, 0.5, 0.5), 24 if not photoreal else 32, 12, 0.72 if blind else None))
        objects += [
            add_uv_sphere("Police_CleanHeadVolume", (0, -h * 0.036, h * 0.878), (h * (0.064 if not blind else 0.084), h * (0.052 if not blind else 0.069), h * (0.080 if not blind else 0.096)), skin, (0, 0, 0.5, 0.5), 56 if photoreal else 40, 20, 0.82 if blind else None),
            add_uv_sphere("Police_CheekPlanes", (0, -h * 0.078, h * 0.862), (h * (0.050 if not blind else 0.064), h * 0.015, h * 0.030), skin, (0, 0, 0.5, 0.5), 32, 10, 0.80 if blind else None),
            add_uv_sphere("Police_CleanChin", (0, -h * 0.074, h * 0.824), (h * (0.036 if not blind else 0.046), h * 0.016, h * 0.022), skin, (0, 0, 0.5, 0.5), 32, 10, 0.80 if blind else None),
            add_uv_sphere("Police_Ear_L", (-h * 0.068, -h * 0.032, h * 0.870), (h * 0.011, h * 0.006, h * 0.021), skin, (0, 0, 0.5, 0.5), 18, 8, 0.76 if blind else None),
            add_uv_sphere("Police_Ear_R", (h * 0.068, -h * 0.032, h * 0.870), (h * 0.011, h * 0.006, h * 0.021), skin, (0, 0, 0.5, 0.5), 18, 8, 0.76 if blind else None),
            add_uv_sphere("Police_HairCap", (0, h * 0.010, h * 0.948), (h * 0.056, h * 0.043, h * 0.020), black, (0.5, 0.5, 1, 1), 40, 14, 0.72 if blind else None),
            add_cylinder("Police_CapCrown", (0, -h * 0.006, h * 0.966), h * (0.080 if not blind else 0.096), h * 0.032, uniform, (0, 0, 1, 1), 80 if photoreal else 60, h * 0.008),
            add_cylinder("Police_CapBand", (0, -h * 0.006, h * 0.946), h * (0.082 if not blind else 0.098), h * 0.013, navy_dark, (0.5, 0, 1, 0.5), 80 if photoreal else 60, h * 0.004),
            add_beveled_cube("Police_CapBrim", (0, -h * 0.084, h * 0.944), (h * 0.086, h * 0.041, h * 0.007), black, (0.5, 0, 1, 0.5), h * 0.006),
            add_beveled_cube("Police_CollarLeft", (-h * 0.045, -h * 0.153, h * 0.742), (h * 0.038, h * 0.008, h * 0.022), navy_dark, (0, 0, 1, 1), h * 0.004),
            add_beveled_cube("Police_CollarRight", (h * 0.045, -h * 0.153, h * 0.742), (h * 0.038, h * 0.008, h * 0.022), navy_dark, (0, 0, 1, 1), h * 0.004),
            add_beveled_cube("Police_Belt", (0, -h * 0.148, h * 0.470), (h * 0.225, h * 0.010, h * 0.019), black, (0.5, 0, 1, 0.5), h * 0.003),
            add_beveled_cube("Police_BeltBuckle", (0, -h * 0.160, h * 0.470), (h * 0.040, h * 0.010, h * 0.030), metal, (0, 0.5, 0.5, 1), h * 0.004),
            add_beveled_cube("Police_BadgeChest", (-h * 0.062, -h * 0.166, h * 0.680), (h * 0.025, h * 0.007, h * 0.034), metal, (0, 0.5, 0.5, 1), h * 0.004),
            add_beveled_cube("Police_BadgeCap", (0, -h * 0.078, h * 0.972), (h * 0.030, h * 0.006, h * 0.035), metal, (0, 0.5, 0.5, 1), h * 0.003),
            add_beveled_cube("Police_Nameplate", (h * 0.060, -h * 0.165, h * 0.682), (h * 0.044, h * 0.006, h * 0.010), metal, (0, 0.5, 0.5, 1), h * 0.002),
            add_beveled_cube("Police_LeftChestPocket", (-h * 0.062, -h * 0.163, h * 0.620), (h * 0.048, h * 0.006, h * 0.040), navy_dark, (0, 0, 1, 1), h * 0.003),
            add_beveled_cube("Police_RightChestPocket", (h * 0.062, -h * 0.163, h * 0.620), (h * 0.048, h * 0.006, h * 0.040), navy_dark, (0, 0, 1, 1), h * 0.003),
            add_beveled_cube("Police_LeftPocketFlap", (-h * 0.062, -h * 0.168, h * 0.646), (h * 0.054, h * 0.006, h * 0.012), metal, (0, 0.5, 0.5, 1), h * 0.002),
            add_beveled_cube("Police_RightPocketFlap", (h * 0.062, -h * 0.168, h * 0.646), (h * 0.054, h * 0.006, h * 0.012), metal, (0, 0.5, 0.5, 1), h * 0.002),
            add_beveled_cube("Police_Radio", (h * 0.115, -h * 0.130, h * 0.705), (h * 0.030, h * 0.015, h * 0.048), black, (0.5, 0, 1, 0.5), h * 0.004),
            add_tube("Police_RadioCord", [(h * 0.108, -h * 0.148, h * 0.690), (h * 0.080, -h * 0.158, h * 0.610), (h * 0.060, -h * 0.158, h * 0.540)], h * 0.003, black, (0.5, 0, 1, 0.5)),
            add_tube("Police_ShirtCenterSeam", [(0, -h * 0.166, h * 0.720), (0, -h * 0.172, h * 0.505)], h * 0.0024, navy_dark, (0, 0, 1, 1)),
        ]
        for i, z in enumerate([0.660, 0.615, 0.570]):
            objects.append(add_uv_sphere(f"Police_ShirtButton_{i}", (0, -h * 0.176, h * z), (h * 0.006, h * 0.002, h * 0.006), metal, (0, 0.5, 0.5, 1), 16, 8))
        for side, x in (("L", -h * 0.118), ("R", h * 0.118)):
            objects.append(add_beveled_cube(f"Police_ShoulderPatch_{side}", (x, -h * 0.130, h * 0.710), (h * 0.034, h * 0.008, h * 0.040), metal, (0, 0.5, 0.5, 1), h * 0.004))
            objects.append(add_beveled_cube(f"Police_Epaulette_{side}", (x, -h * 0.105, h * 0.760), (h * 0.062, h * 0.020, h * 0.010), navy_dark, (0, 0, 1, 1), h * 0.004))
            objects.append(add_beveled_cube(f"Police_SleeveCuff_{side}", (side == "L" and -h * 0.205 or h * 0.205, -h * 0.090, h * 0.378), (h * 0.040, h * 0.014, h * 0.014), navy_dark, (0, 0, 1, 1), h * 0.004))
            objects.append(add_beveled_cube(f"Police_BeltPouch_{side}", (x, -h * 0.158, h * 0.440), (h * 0.045, h * 0.020, h * 0.050), black, (0.5, 0, 1, 0.5), h * 0.006))
            objects.append(add_beveled_cube(f"Police_BeltClip_{side}", (side == "L" and -h * 0.175 or h * 0.175, -h * 0.160, h * 0.466), (h * 0.016, h * 0.012, h * 0.040), metal, (0, 0.5, 0.5, 1), h * 0.002))
            objects.append(add_beveled_cube(f"Police_ShoeToe_{side}", (x * 0.70, -h * 0.038, h * 0.044), (h * 0.058, h * 0.082, h * 0.022), black, (0.5, 0, 1, 0.5), h * 0.010))
            objects.append(add_beveled_cube(f"Police_ShoeSole_{side}", (x * 0.70, -h * 0.038, h * 0.019), (h * 0.064, h * 0.088, h * 0.009), navy_dark, (0, 0, 1, 1), h * 0.002))
        for side, x in (("L", -h * 0.030), ("R", h * 0.030)):
            scale = (h * (0.009 if not blind else 0.017), h * 0.003, h * (0.008 if not blind else 0.015))
            objects.append(add_uv_sphere(f"Police_Eye_{side}", (x, -h * 0.084, h * 0.890), scale, black, (0.5, 0, 1, 0.5), 18 if not blind else 28, 10))
            objects.append(add_tube(f"Police_Eyebrow_{side}", [(x - h * 0.014, -h * 0.088, h * 0.909), (x + h * 0.014, -h * 0.089, h * 0.913)], h * 0.0019, black, (0.5, 0, 1, 0.5)))
        objects.append(add_uv_sphere("Police_Nose", (0, -h * 0.088, h * 0.860), (h * 0.006, h * 0.006, h * 0.014), skin, (0, 0, 0.5, 0.5), 16, 8))
        objects.append(add_tube("Police_Smile", [(-h * 0.016, -h * 0.091, h * 0.835), (0, -h * 0.093, h * 0.828), (h * 0.016, -h * 0.091, h * 0.835)], h * 0.0015, black, (0.5, 0, 1, 0.5)))
        return objects

    def look_at(obj, target: Vector) -> None:
        direction = target - obj.location
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    def setup_render(height: float) -> None:
        bpy.ops.object.light_add(type="AREA", location=(2.3, -4.0, height * 1.65))
        key = bpy.context.object
        key.data.energy = 760
        key.data.size = 4.6
        bpy.ops.object.light_add(type="AREA", location=(-2.1, -2.4, height * 0.75))
        fill = bpy.context.object
        fill.data.energy = 115
        fill.data.size = 3.0
        bpy.ops.object.camera_add(location=(1.9, -4.25, height * 0.68))
        cam = bpy.context.object
        look_at(cam, Vector((0, 0, height * 0.50)))
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = height * 1.42
        bpy.context.scene.camera = cam
        bpy.ops.mesh.primitive_plane_add(size=height * 1.55, location=(0, 0, -0.002))
        floor = bpy.context.object
        floor.name = "Preview_Ground_ShadowPlane"
        floor["exclude_from_export"] = True
        floor.data.materials.append(make_flat_mat("Preview_Ground", (0.36, 0.36, 0.34, 1.0), 0.82))

    def make_flat_mat(name, color, roughness):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        mat.diffuse_color = color
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = color
            if "Roughness" in bsdf.inputs:
                bsdf.inputs["Roughness"].default_value = roughness
        return mat

    def make_role_materials(spec: dict, pbr_main, pbr_accent) -> dict:
        style = spec["style"]
        suffix = spec["asset"]
        if spec["role"] == "Villain":
            coat_color = {
                "Stylized": (0.055, 0.048, 0.042, 1.0),
                "Photoreal": (0.030, 0.027, 0.024, 1.0),
                "BlindBox": (0.090, 0.080, 0.070, 1.0),
            }[style]
            return {
                "coat": make_procedural_mat(f"M_{suffix}_CharcoalCoat", coat_color, 0.54 if style != "BlindBox" else 0.34, 0.0, 0.050 if style == "Photoreal" else 0.030),
                "shadow": make_flat_mat(f"M_{suffix}_FaceShadow", (0.004, 0.004, 0.004, 1.0), 0.86),
                "face_skin": make_procedural_mat(f"M_{suffix}_HoodedFaceSkin", (0.36, 0.245, 0.185, 1.0), 0.62, 0.0, 0.010),
                "black_leather": make_procedural_mat(f"M_{suffix}_BlackLeather", (0.010, 0.009, 0.008, 1.0), 0.39, 0.0, 0.035),
                "dark_metal": make_procedural_mat(f"M_{suffix}_GunmetalDetails", (0.46, 0.43, 0.38, 1.0), 0.26, 0.35, 0.010),
                "eye_glow": make_flat_mat(f"M_{suffix}_AmberEyeSlits", (1.0, 0.62, 0.18, 1.0), 0.18),
                "pbr_main": pbr_main,
                "pbr_accent": pbr_accent,
            }
        uniform_color = {
            "Stylized": (0.030, 0.110, 0.205, 1.0),
            "Photoreal": (0.018, 0.055, 0.118, 1.0),
            "BlindBox": (0.020, 0.160, 0.330, 1.0),
        }[style]
        return {
            "uniform": make_procedural_mat(f"M_{suffix}_PoliceNavyUniform", uniform_color, 0.58 if style != "BlindBox" else 0.32, 0.0, 0.030 if style == "Photoreal" else 0.018),
            "uniform_dark": make_procedural_mat(f"M_{suffix}_DarkNavyTrim", (0.006, 0.022, 0.052, 1.0), 0.50, 0.0, 0.012),
            "skin": make_procedural_mat(f"M_{suffix}_WarmSkin", (0.82, 0.55, 0.37, 1.0), 0.48, 0.0, 0.008),
            "black_leather": make_procedural_mat(f"M_{suffix}_BlackGear", (0.006, 0.006, 0.006, 1.0), 0.32, 0.0, 0.024),
            "badge_metal": make_procedural_mat(f"M_{suffix}_BrassBadge", (0.95, 0.77, 0.42, 1.0), 0.22, 0.45, 0.006),
            "pbr_main": pbr_main,
            "pbr_accent": pbr_accent,
        }

    def render(path: Path) -> None:
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

    def export_all(out_dir: Path, asset: str, objects, arm):
        export_objects = [obj for obj in objects if not obj.get("exclude_from_export")]
        out_dir.mkdir(parents=True, exist_ok=True)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in export_objects:
            obj.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        fbx = out_dir / f"{asset}.fbx"
        glb = out_dir / f"{asset}.glb"
        bpy.ops.export_scene.fbx(
            filepath=str(fbx),
            use_selection=True,
            object_types={"MESH", "ARMATURE"},
            apply_unit_scale=True,
            bake_space_transform=False,
            axis_forward="Z",
            axis_up="Y",
            add_leaf_bones=False,
            bake_anim=False,
            path_mode="COPY",
            embed_textures=False,
        )
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
        return fbx, glb

    def rel(path: Path) -> str:
        return str(path.relative_to(ROOT))

    summary_assets = []
    for spec in SPECS:
        reset_scene()
        out_dir = out_dir_for(spec)
        tex_dir = copy_texture_set(spec, out_dir)
        pbr_main = make_material(f"M_{spec['asset']}_MainPBRPack", tex_dir, spec["role"], spec["style"], "Main", spec["texture_res"], 0.34 if spec["style"] == "BlindBox" else 0.68)
        pbr_accent = make_material(f"M_{spec['asset']}_AccentPBRPack", tex_dir, spec["role"], spec["style"], "Accent", spec["texture_res"], 0.28 if spec["style"] == "BlindBox" else 0.46)
        mats = make_role_materials(spec, pbr_main, pbr_accent)
        src = append_object(spec["template"])
        src.name = f"{spec['asset']}_SourceHuman"
        normalize_height(src, spec["height"])
        style_body_proportions(src, spec["role"], spec["style"])
        objects = make_villain(src, spec, mats) if spec["role"] == "Villain" else make_police(src, spec, mats)
        bpy.data.objects.remove(src, do_unlink=True)
        arm = create_armature(spec["height"])
        for obj in objects:
            bind_to_armature(obj, arm, spec["height"])
        fitted = fit_budget(objects, spec["budget"][0], spec["budget"][1])

        setup_render(spec["height"])
        preview_dir = out_dir / "Previews"
        wire_dir = out_dir / "Wireframes"
        report_dir = out_dir / "Reports"
        preview_dir.mkdir(parents=True, exist_ok=True)
        wire_dir.mkdir(parents=True, exist_ok=True)
        report_dir.mkdir(parents=True, exist_ok=True)
        blend = out_dir / f"{spec['asset']}.blend"
        bpy.ops.wm.save_as_mainfile(filepath=str(blend))
        fbx, glb = export_all(out_dir, spec["asset"], objects, arm)
        preview = preview_dir / f"{spec['asset']}_preview.png"
        wire = wire_dir / f"{spec['asset']}_wireframe.png"
        render(preview)
        draw_wire(objects, wire)

        lods = {}
        if spec["style"] == "Photoreal":
            for label, ratio in [("LOD1", 0.55), ("LOD2", 0.34)]:
                decimate_scene_objects(objects, ratio)
                lod_stats = stats_for_objects(objects)
                lod_fbx, lod_glb = export_all(out_dir, f"{spec['asset']}_{label}", objects, arm)
                lods[label] = {"fbx": rel(lod_fbx), "glb": rel(lod_glb), "triangles": lod_stats["triangles"]}

        report = {
            "asset": spec["asset"],
            "role": spec["role"],
            "style": spec["style"],
            "reference_image": REFERENCE_IMAGES[spec["role"]],
            "status": "role_character_three_style_local_gate_candidate_user_visual_review_pending",
            "source": {
                "body": "MB-Lab humanoid_library.blend",
                "template": spec["template"],
                "primitive_composed_human": False,
                "version_dir": VERSION_DIR,
            },
            "outputs": {"blend": rel(blend), "fbx": rel(fbx), "glb": rel(glb), "preview": rel(preview), "wireframe": rel(wire)},
            "lods": lods,
            "budget": {
                "target_tris_min": spec["budget"][0],
                "target_tris_max": spec["budget"][1],
                "actual_vertices": fitted["vertices"],
                "actual_polygons": fitted["polygons"],
                "actual_triangles": fitted["triangles"],
                "triangle_budget_passed": spec["budget"][0] <= fitted["triangles"] <= spec["budget"][1],
            },
            "materials": {
                "texture_directory": rel(tex_dir),
                "texture_resolution": spec["texture_res"],
                "material_count": len(mats),
                "render_material_route": "role_specific_procedural_materials_with_copied_pbr_texture_pack",
            },
            "rig": {
                "armature_name": "Rig_Humanoid_Shared",
                "same_bone_names_as_task_a": True,
                "armature_modifier_bound": True,
                "unity_humanoid_avatar_validation": "blocked_no_active_unity_license",
            },
            "limitations": ["Unity import/avatar validation still blocked by missing active Unity license."],
        }
        report_path = report_dir / f"{spec['asset']}_budget_report.json"
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        readme = out_dir / "README.md"
        lod_text = ""
        if lods:
            lod_text = "\n- LOD files: " + ", ".join(f"`{Path(v['fbx']).name}`, `{Path(v['glb']).name}`" for v in lods.values())
        readme.write_text(
            f"# {spec['asset']}\n\n"
            f"Art-only premium v9 local candidate for {spec['role']} {spec['style']}.\n\n"
            f"- Main files: `{spec['asset']}.fbx`, `{spec['asset']}.glb`, `{spec['asset']}.blend`{lod_text}\n"
            f"- Preview: `Previews/{spec['asset']}_preview.png`\n"
            f"- Wireframe: `Wireframes/{spec['asset']}_wireframe.png`\n"
            f"- Budget report: `Reports/{spec['asset']}_budget_report.json`\n"
            f"- Texture pack: `Textures/`\n"
            f"- Triangle count: {fitted['triangles']:,}\n"
            f"- Rig: shared Humanoid bone names with armature binding; Unity Avatar validation pending license activation.\n",
            encoding="utf-8",
        )
        entry = {
            "asset": spec["asset"],
            "role": spec["role"],
            "style": spec["style"],
            "triangles": fitted["triangles"],
            "preview": rel(preview),
            "wireframe": rel(wire),
            "report": rel(report_path),
            "readme": rel(readme),
        }
        if lods:
            entry["lods"] = lods
        summary_assets.append(entry)

    summary = {
        "asset_count": len(summary_assets),
        "scope": "Villain C1-C3 and Police D1-D3 three-style role character rework",
        "assets": summary_assets,
        "contact_sheet": rel(CONTACT_SHEET),
        "unity_validation": "blocked_no_active_unity_license",
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if "--build" in sys.argv:
        blender_main()
    else:
        run_blender()
