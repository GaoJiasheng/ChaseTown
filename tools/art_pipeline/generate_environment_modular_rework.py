"""Generate Task E modular environment candidates with PBR textures.

Run with:
  blender --background --python tools/art_pipeline/generate_environment_modular_rework.py
"""

from __future__ import annotations

from pathlib import Path
import json
import math
import subprocess
import tempfile

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
ENV = ROOT / "art-source" / "Environment"
MODULAR = ENV / "ModularKit"
TEXTURES = ENV / "SharedTextures"
METRICS = ROOT / "docs" / "art_production" / "ENVIRONMENT_TEXTURE_QUALITY_SUMMARY.json"


ASSETS = [
    "Wall_Straight_2m",
    "Wall_Corner_2m",
    "Wall_End_2m",
    "Floor_Hallway_Tile",
    "Floor_Classroom_Wood",
    "Floor_Playground_Rubber",
    "Floor_Grass",
    "Door_FrontGate",
    "Door_Classroom",
    "Door_RearExit",
    "Light_Ceiling_Emissive",
]


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.context.scene.render.resolution_x = 1400
    bpy.context.scene.render.resolution_y = 1200
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass


def make_material(name: str, roughness=0.58, metallic=0.0, emission=None):
    mat = bpy.data.materials.new("M_Env_" + name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    base_path = TEXTURES / f"Env_{name}_BaseColor_2K.png"
    normal_path = TEXTURES / f"Env_{name}_Normal_2K.png"
    if bsdf and base_path.exists():
        tex = nodes.new(type="ShaderNodeTexImage")
        tex.image = bpy.data.images.load(str(base_path))
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        ntex = nodes.new(type="ShaderNodeTexImage")
        ntex.image = bpy.data.images.load(str(normal_path))
        ntex.image.colorspace_settings.name = "Non-Color"
        nmap = nodes.new(type="ShaderNodeNormalMap")
        mat.node_tree.links.new(ntex.outputs["Color"], nmap.inputs["Color"])
        mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if emission and "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = emission[0]
            bsdf.inputs["Emission Strength"].default_value = emission[1]
    return mat


def assign_uv(obj) -> None:
    mesh = obj.data
    while mesh.uv_layers:
        mesh.uv_layers.remove(mesh.uv_layers[0])
    uv = mesh.uv_layers.new(name="UV0")
    verts = [v.co.copy() for v in mesh.vertices]
    min_x, max_x = min(v.x for v in verts), max(v.x for v in verts)
    min_y, max_y = min(v.y for v in verts), max(v.y for v in verts)
    min_z, max_z = min(v.z for v in verts), max(v.z for v in verts)
    span_x = max(max_x - min_x, 1e-5)
    span_y = max(max_y - min_y, 1e-5)
    span_z = max(max_z - min_z, 1e-5)
    for poly in mesh.polygons:
        n = poly.normal
        for loop_index in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            if abs(n.z) > 0.65:
                u = (co.x - min_x) / span_x
                v = (co.y - min_y) / span_y
            else:
                u = (co.x - min_x) / span_x if span_x >= span_y else (co.y - min_y) / span_y
                v = (co.z - min_z) / span_z
            uv.data[loop_index].uv = (u, v)


def finish(obj, material, bevel=0.015) -> object:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    assign_uv(obj)
    if bevel:
        mod = obj.modifiers.new("Built_Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 1
    try:
        mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
    except Exception:
        pass
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for mod in list(obj.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except Exception:
            pass
    obj.select_set(False)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def cube(name: str, loc, scale, material, bevel=0.015):
    bpy.ops.mesh.primitive_cube_add(size=2, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, material, bevel)


def cyl(name: str, loc, radius, depth, material, vertices=48, bevel=0.006, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    return finish(obj, material, bevel)


def tube(name: str, points, radius, material):
    curve = bpy.data.curves.new(name + "_Curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 3
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
    return finish(bpy.context.object, material, bevel=None)


def face_bolt(name: str, loc, material, radius=0.014, depth=0.010):
    return cyl(name, loc, radius, depth, material, vertices=20, bevel=0.002, rotation=(math.radians(90), 0, 0))


def materials():
    return {
        "wall": make_material("PaintedWall", 0.62),
        "tile": make_material("HallwayTile", 0.38),
        "wood": make_material("ClassroomWood", 0.48),
        "rubber": make_material("PlaygroundRubber", 0.42),
        "grass": make_material("Grass", 0.82),
        "blue_metal": make_material("BluePaintedMetal", 0.34, 0.12),
        "red_metal": make_material("RedPaintedMetal", 0.38, 0.10),
        "wood_trim": make_material("WoodTrim", 0.50),
        "metal": make_material("WornMetal", 0.37, 0.65),
        "blackboard": make_material("Blackboard", 0.72),
        "paper": make_material("Paper", 0.86),
        "rubber_black": make_material("RubberBlack", 0.48),
        "glass": make_material("GlassBlue", 0.18),
        "emissive": make_material("WornMetal", 0.20, 0.0, emission=((1.0, 0.86, 0.55, 1.0), 2.4)),
    }


def add_wall_details(objects, mats, length=2.0, corner=False, end=False):
    objects.append(cube("wall_body", (0, 0, 1.15), (length / 2, 0.08, 1.15), mats["wall"], 0.025))
    objects.append(cube("wall_base_trim", (0, -0.086, 0.12), (length / 2 + 0.02, 0.025, 0.08), mats["wood_trim"], 0.012))
    objects.append(cube("wall_kick_plate", (0, -0.112, 0.33), (length / 2 + 0.01, 0.014, 0.055), mats["metal"], 0.004))
    objects.append(cube("wall_top_trim", (0, -0.086, 2.18), (length / 2 + 0.02, 0.025, 0.05), mats["wood_trim"], 0.010))
    for x in (-0.65, 0.0, 0.65):
        objects.append(cube("wall_panel_seam", (x, -0.092, 1.05), (0.012, 0.014, 0.78), mats["metal"], 0.004))
    for z in (0.82, 1.52):
        objects.append(cube("wall_horizontal_reveal", (0, -0.104, z), (length / 2 - 0.06, 0.010, 0.010), mats["metal"], 0.002))
    for x, z in [(-0.82, 1.64), (-0.82, 1.55), (0.82, 0.66), (0.82, 0.57)]:
        objects.append(face_bolt("wall_trim_screw", (x, -0.121, z), mats["metal"], radius=0.010, depth=0.006))
    objects.append(cube("wall_notice_card", (-0.43, -0.118, 1.22), (0.16, 0.006, 0.11), mats["paper"], 0.002))
    objects.append(cube("wall_notice_tape", (-0.43, -0.123, 1.34), (0.18, 0.004, 0.010), mats["metal"], 0.001))
    if end:
        objects.append(cube("wall_end_cap", (length / 2 + 0.04, 0, 1.15), (0.04, 0.10, 1.16), mats["wood_trim"], 0.012))


def build_asset(name: str, mats) -> list:
    objects = []
    if name == "Wall_Straight_2m":
        add_wall_details(objects, mats)
    elif name == "Wall_Corner_2m":
        add_wall_details(objects, mats)
        for obj in list(objects):
            dup = obj.copy()
            dup.data = obj.data.copy()
            dup.rotation_euler[2] = math.radians(90)
            bpy.context.collection.objects.link(dup)
            objects.append(dup)
    elif name == "Wall_End_2m":
        add_wall_details(objects, mats, end=True)
    elif name.startswith("Floor_"):
        mat_key = {
            "Floor_Hallway_Tile": "tile",
            "Floor_Classroom_Wood": "wood",
            "Floor_Playground_Rubber": "rubber",
            "Floor_Grass": "grass",
        }[name]
        objects.append(cube("floor_slab", (0, 0, -0.025), (1.0, 1.0, 0.025), mats[mat_key], 0.006))
        if name == "Floor_Hallway_Tile":
            for i in range(-1, 2):
                objects.append(cube("tile_grout_x", (i * 0.5, 0, 0.003), (0.006, 1.0, 0.004), mats["metal"], 0.001))
                objects.append(cube("tile_grout_y", (0, i * 0.5, 0.004), (1.0, 0.006, 0.004), mats["metal"], 0.001))
            for x, y in [(-0.42, -0.42), (0.38, -0.18), (-0.12, 0.36), (0.46, 0.48)]:
                objects.append(cube("tile_scuff_inlay", (x, y, 0.010), (0.085, 0.012, 0.003), mats["rubber"], 0.001))
        elif name == "Floor_Classroom_Wood":
            for x in (-0.75, -0.50, -0.25, 0.0, 0.25, 0.50, 0.75):
                objects.append(cube("wood_plank_gap", (x, 0, 0.006), (0.004, 1.0, 0.004), mats["metal"], 0.001))
            for y in (-0.48, 0.08, 0.62):
                objects.append(cube("wood_stagger_joint", (-0.37, y, 0.007), (0.12, 0.004, 0.004), mats["metal"], 0.001))
        elif name == "Floor_Playground_Rubber":
            for x in (-0.35, 0.0, 0.35):
                objects.append(cube("rubber_lane_line", (x, 0, 0.006), (0.012, 1.0, 0.004), mats["metal"], 0.002))
            for y in (-0.60, 0.0, 0.60):
                objects.append(cube("rubber_cross_mark", (0, y, 0.009), (1.0, 0.008, 0.004), mats["red_metal"], 0.001))
        elif name == "Floor_Grass":
            for x, y, s in [(-0.42, -0.36, 0.10), (-0.05, 0.30, 0.07), (0.38, -0.02, 0.08), (0.55, 0.48, 0.06)]:
                objects.append(cube("grass_patch_variation", (x, y, 0.008), (s, s * 0.55, 0.004), mats["wood_trim"], 0.001))
    elif name.startswith("Door_"):
        is_front = name == "Door_FrontGate"
        is_exit = name == "Door_RearExit"
        width = 1.6 if is_front else 1.05
        objects.append(cube("door_panel", (0, 0, 1.05), (width / 2, 0.055, 1.05), mats["blue_metal"] if is_front or is_exit else mats["wood_trim"], 0.025))
        objects.append(cube("door_frame_top", (0, -0.075, 2.15), (width / 2 + 0.08, 0.045, 0.055), mats["metal"], 0.010))
        objects.append(cube("door_threshold", (0, -0.088, 0.035), (width / 2 + 0.10, 0.070, 0.035), mats["metal"], 0.006))
        for x in (-width / 2 - 0.045, width / 2 + 0.045):
            objects.append(cube("door_frame_side", (x, -0.075, 1.05), (0.045, 0.045, 1.10), mats["metal"], 0.010))
            for z in (0.48, 1.05, 1.62):
                objects.append(cube("door_hinge_plate", (x * 0.94, -0.124, z), (0.018, 0.010, 0.055), mats["metal"], 0.002))
        if is_front:
            objects.append(cube("double_door_split", (0, -0.095, 1.05), (0.010, 0.012, 0.92), mats["metal"], 0.004))
            objects.append(cube("school_sign_plate", (0, -0.110, 1.86), (0.46, 0.016, 0.09), mats["paper"], 0.004))
            for x in (-0.36, 0.36):
                objects.append(cube("front_gate_glass", (x, -0.107, 1.36), (0.20, 0.012, 0.30), mats["glass"], 0.004))
                objects.append(cube("front_gate_push_bar", (x, -0.126, 0.92), (0.23, 0.012, 0.018), mats["metal"], 0.002))
        else:
            objects.append(cube("upper_window_panel", (0, -0.103, 1.58), (width * 0.28, 0.014, 0.20), mats["glass"], 0.005))
            objects.append(cube("door_kick_plate", (0, -0.116, 0.42), (width * 0.35, 0.012, 0.08), mats["metal"], 0.003))
            objects.append(cube("room_number_plate", (-width * 0.24, -0.118, 1.86), (0.10, 0.008, 0.045), mats["paper"], 0.002))
        objects.append(cyl("door_handle", (width * 0.22, -0.13, 1.05), 0.025, 0.06, mats["metal"], vertices=24, rotation=(math.radians(90), 0, 0)))
        objects.append(tube("door_closer_arm", [(-width * 0.18, -0.12, 2.02), (0.02, -0.16, 1.95), (width * 0.18, -0.12, 2.02)], 0.006, mats["metal"]))
    elif name == "Light_Ceiling_Emissive":
        objects.append(cube("light_metal_housing", (0, 0, 0.04), (0.62, 0.18, 0.04), mats["metal"], 0.018))
        objects.append(cube("light_diffuser", (0, 0, -0.005), (0.54, 0.13, 0.012), mats["emissive"], 0.010))
        for x in (-0.64, 0.64):
            objects.append(cube("light_end_cap", (x, 0, 0.045), (0.026, 0.18, 0.042), mats["metal"], 0.006))
        for x in (-0.38, 0.38):
            objects.append(face_bolt("light_screw", (x, -0.093, 0.060), mats["metal"], radius=0.010, depth=0.006))
        for x in (-0.48, 0.48):
            objects.append(tube("light_hanger", [(x, 0, 0.05), (x, 0, 0.42)], 0.006, mats["metal"]))
        objects.append(tube("light_power_cable", [(-0.58, 0.04, 0.08), (-0.72, 0.06, 0.28), (-0.72, 0.02, 0.42)], 0.004, mats["rubber_black"]))
    return objects


def stats(objects) -> dict:
    vertices = polygons = triangles = 0
    for obj in objects:
        mesh = obj.data
        mesh.calc_loop_triangles()
        vertices += len(mesh.vertices)
        polygons += len(mesh.polygons)
        triangles += len(mesh.loop_triangles)
    return {"vertices": vertices, "polygons": polygons, "triangles": triangles}


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_render(name: str) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.5, -3.8, 3.0))
    light = bpy.context.object
    light.data.energy = 650
    light.data.size = 4.0
    bpy.ops.object.camera_add(location=(2.8, -3.8, 2.1))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, 0.9)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.8 if not name.startswith("Floor_") else 2.4
    bpy.context.scene.camera = cam


def render_preview(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def draw_wire(objects, path: Path) -> None:
    pts = []
    edges = []
    for obj in objects:
        start = len(pts)
        pts.extend([obj.matrix_world @ v.co for v in obj.data.vertices])
        edges.extend([(start + e.vertices[0], start + e.vertices[1]) for e in obj.data.edges])
    coords = [(p.x, p.z) for p in pts]
    min_x, max_x = min(x for x, _ in coords), max(x for x, _ in coords)
    min_z, max_z = min(z for _, z in coords), max(z for _, z in coords)
    w, h, pad = 1000, 900, 70
    scale = min((w - 2 * pad) / max(max_x - min_x, 1e-5), (h - 2 * pad) / max(max_z - min_z, 1e-5))
    buf = bytearray([238, 238, 232] * w * h)

    def screen(i):
        x, z = coords[i]
        return int((x - min_x) * scale + pad), int(h - ((z - min_z) * scale + pad))

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


def export_fbx(path: Path, objects) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.fbx(
        filepath=str(path),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="Z",
        axis_up="Y",
        path_mode="RELATIVE",
    )


def texture_checks_for(material_names: list[str], metrics: dict) -> list[dict]:
    by_name = {m["material"]: m for m in metrics["materials"]}
    checks = []
    for name in material_names:
        if name in by_name:
            checks.extend(by_name[name]["checks"])
    return checks


def generate_one(name: str, metrics: dict) -> dict:
    reset_scene()
    mats = materials()
    objects = build_asset(name, mats)
    setup_render(name)
    render_preview(MODULAR / "Previews" / f"{name}_preview.png")
    draw_wire(objects, MODULAR / "Wireframes" / f"{name}_wireframe.png")
    export_fbx(MODULAR / f"{name}.fbx", objects)
    s = stats(objects)
    used = {
        "Wall": ["PaintedWall", "WoodTrim", "WornMetal", "Paper"],
        "Floor_Hallway_Tile": ["HallwayTile", "WornMetal", "PlaygroundRubber"],
        "Floor_Classroom_Wood": ["ClassroomWood", "WornMetal"],
        "Floor_Playground_Rubber": ["PlaygroundRubber", "WornMetal", "RedPaintedMetal"],
        "Floor_Grass": ["Grass", "WoodTrim"],
        "Door": ["BluePaintedMetal", "WoodTrim", "WornMetal", "GlassBlue", "Paper"],
        "Light": ["WornMetal", "RubberBlack"],
    }
    if name.startswith("Wall_"):
        material_names = used["Wall"]
    elif name.startswith("Door_"):
        material_names = used["Door"]
    elif name.startswith("Light_"):
        material_names = used["Light"]
    else:
        material_names = used[name]
    checks = texture_checks_for(material_names, metrics)
    report = {
        "asset": name,
        "task": "Task E",
        "reference_image": "art-source/Concepts/04_school_environment_sheet.png",
        "files": {
            "fbx": str((MODULAR / f"{name}.fbx").relative_to(ROOT)),
            "preview": str((MODULAR / "Previews" / f"{name}_preview.png").relative_to(ROOT)),
            "wireframe": str((MODULAR / "Wireframes" / f"{name}_wireframe.png").relative_to(ROOT)),
        },
        "mesh_stats": s,
        "scale": {"unit": "meter", "grid": "2m", "scale_factor": 1},
        "quality_gate": {
            "texture_checks": checks,
            "texture_gate_passed": all(c["passed"] for c in checks),
            "bevel_used": True,
            "surface_detail_layers": ["PBR texture", "beveled edges", "trim/seam/panel geometry", "hardware/bolts/kick plates/glass inserts"],
            "visual_rework_pass": "2026-07-12_deep_review",
            "local_art_gate_passed": all(c["passed"] for c in checks),
            "unity_validation": "blocked_no_active_unity_license",
        },
        "status": "local_gate_candidate_unity_validation_pending",
    }
    report_path = MODULAR / "Reports" / f"{name}_budget_report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"asset": name, **s, "texture_gate_passed": report["quality_gate"]["texture_gate_passed"]}


def main() -> int:
    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    results = [generate_one(name, metrics) for name in ASSETS]
    summary = {
        "asset_count": len(results),
        "local_art_gate_passed": all(r["texture_gate_passed"] for r in results),
        "unity_validation": "blocked_no_active_unity_license",
        "results": results,
    }
    path = ROOT / "docs" / "art_production" / "ENVIRONMENT_MODULAR_REWORK_SUMMARY.json"
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["local_art_gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
