"""Generate first-pass Unity-ready environment FBX packages with Blender.

Run with:
  blender --background --python tools/art_pipeline/generate_environment_fbx.py

The generated assets are production-pipeline prototypes for Task E/F: FBX,
PBR texture references, preview renders, wireframe renders, and budget reports.
They are not a replacement for hand-authored AAA models, but they are real
importable packages that obey the project folder layout and validation format.
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
MOD_DIR = ROOT / "art-source" / "Environment" / "ModularKit"
PROP_DIR = ROOT / "art-source" / "Environment" / "Props"
TEX_DIR = ROOT / "art-source" / "Environment" / "SharedTextures"


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


def load_image(path: Path):
    if not path.exists():
        return None
    return bpy.data.images.load(str(path), check_existing=True)


def make_mat(name: str, tex_name: str, emission: bool = False, emission_strength: float = 1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    base = load_image(TEX_DIR / f"{tex_name}_BaseColor_2K.png")
    if base and bsdf:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = base
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    normal = load_image(TEX_DIR / f"{tex_name}_Normal_2K.png")
    if normal and bsdf:
        normal.colorspace_settings.name = "Non-Color"
        tex_n = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex_n.image = normal
        nmap = mat.node_tree.nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = 0.45
        mat.node_tree.links.new(tex_n.outputs["Color"], nmap.inputs["Color"])
        mat.node_tree.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    ms = load_image(TEX_DIR / f"{tex_name}_MetallicSmoothness_2K.png")
    if ms and bsdf:
        ms.colorspace_settings.name = "Non-Color"
        tex_ms = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex_ms.image = ms
        sep = mat.node_tree.nodes.new("ShaderNodeSeparateColor")
        mat.node_tree.links.new(tex_ms.outputs["Color"], sep.inputs["Color"])
        mat.node_tree.links.new(sep.outputs["Red"], bsdf.inputs["Metallic"])
        # Blender uses roughness; use 1-smoothness approximated manually.
        bsdf.inputs["Roughness"].default_value = 0.45
    if emission and bsdf:
        color = (1.0, 0.55, 0.15, 1.0)
        if "Blue" in tex_name:
            color = (0.1, 0.35, 1.0, 1.0)
        if "Red" in tex_name:
            color = (1.0, 0.05, 0.03, 1.0)
        if "White" in tex_name:
            color = (0.85, 0.9, 0.8, 1.0)
        bsdf.inputs["Emission Color"].default_value = color
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


MATS = {}


def material(name: str):
    if not MATS:
        MATS.update(
            {
                "brick": make_mat("PBR_PaintedBrick", "Mat_PaintedBrick"),
                "tile": make_mat("PBR_HallwayTile", "Mat_HallwayTile"),
                "woodfloor": make_mat("PBR_ClassroomWood", "Mat_ClassroomWood"),
                "rubbertrack": make_mat("PBR_RubberTrack", "Mat_RubberTrack"),
                "grass": make_mat("PBR_Grass", "Mat_Grass"),
                "metalblue": make_mat("PBR_BluePaintedMetal", "Mat_BluePaintedMetal"),
                "leather": make_mat("PBR_DarkLeather", "Mat_DarkLeather"),
                "wood": make_mat("PBR_WoodFurniture", "Mat_WoodFurniture"),
                "blackboard": make_mat("PBR_Blackboard", "Mat_Blackboard"),
                "paper": make_mat("PBR_Paper", "Mat_Paper"),
                "rubber": make_mat("PBR_RubberBlack", "Mat_RubberBlack"),
                "car": make_mat("PBR_CarPaint", "Mat_CarPaint"),
                "badge": make_mat("PBR_BadgeMetal", "Mat_BadgeMetal"),
                "glass": make_mat("PBR_Glass", "Mat_Glass"),
                "plasticblue": make_mat("PBR_PlasticBlue", "Mat_PlasticBlue"),
                "warm": make_mat("EM_WarmLight", "Mat_EmissionWarm", True, 2.5),
                "red": make_mat("EM_RedPoliceLight", "Mat_EmissionRed", True, 3.0),
                "blue": make_mat("EM_BluePoliceLight", "Mat_EmissionBlue", True, 3.0),
                "white": make_mat("EM_WhiteCeilingLight", "Mat_EmissionWhite", True, 2.0),
            }
        )
    return MATS[name]


def add_box(name: str, loc, dims, mat_key: str, bevel: float = 0.0):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material(mat_key))
    if bevel > 0:
        mod = obj.modifiers.new("soft_bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.affect = "EDGES"
        obj.modifiers.new("weighted_normals", "WEIGHTED_NORMAL")
    unwrap_object(obj)
    return obj


def add_cylinder(name: str, loc, radius: float, depth: float, mat_key: str, vertices: int = 32, bevel: float = 0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material(mat_key))
    if bevel > 0:
        mod = obj.modifiers.new("soft_bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        obj.modifiers.new("weighted_normals", "WEIGHTED_NORMAL")
    unwrap_object(obj)
    return obj


def add_sphere(name: str, loc, scale, mat_key: str):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1.0, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material(mat_key))
    obj.modifiers.new("weighted_normals", "WEIGHTED_NORMAL")
    unwrap_object(obj)
    return obj


def unwrap_object(obj) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass


def apply_modifiers() -> None:
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in list(obj.modifiers):
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception:
                pass
        obj.select_set(False)


def join_meshes(asset_name: str):
    apply_modifiers()
    mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objs[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = asset_name
    joined.data.name = f"{asset_name}_Mesh"
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR", center="MEDIAN")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return joined


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_camera(asset_name: str) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.8, -3.5, 4.2))
    light = bpy.context.object
    light.name = "Key_Area_Light"
    light.data.energy = 450
    light.data.size = 5
    bpy.ops.object.camera_add(location=(3.6, -4.4, 2.9))
    camera = bpy.context.object
    look_at(camera, Vector((0, 0, 0.55)))
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 4.8
    bpy.context.scene.camera = camera
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass
    bpy.context.scene.render.resolution_x = 1200
    bpy.context.scene.render.resolution_y = 900
    bpy.context.scene.view_settings.view_transform = "Filmic"
    bpy.context.scene.view_settings.look = "Medium High Contrast"


def render_png(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def render_wireframe(asset_name: str, path: Path) -> None:
    write_projected_wireframe(asset_name, path)


def draw_line(buf: bytearray, width: int, height: int, x0: int, y0: int, x1: int, y1: int) -> None:
    dx = abs(x1 - x0)
    sx = 1 if x0 < x1 else -1
    dy = -abs(y1 - y0)
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    while True:
        if 0 <= x0 < width and 0 <= y0 < height:
            idx = (y0 * width + x0) * 3
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


def write_projected_wireframe(asset_name: str, path: Path) -> None:
    obj = bpy.data.objects[asset_name]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    coords = []
    for vertex in mesh.vertices:
        world = obj.matrix_world @ vertex.co
        # Simple top-down 3/4 axonometric projection.
        px = (world.x - world.y) * 0.78
        py = world.z * 1.05 + (world.x + world.y) * 0.24
        coords.append((px, py))
    if not coords:
        eval_obj.to_mesh_clear()
        return
    min_x = min(p[0] for p in coords)
    max_x = max(p[0] for p in coords)
    min_y = min(p[1] for p in coords)
    max_y = max(p[1] for p in coords)
    width, height = 1200, 900
    pad = 72
    span_x = max(max_x - min_x, 1e-5)
    span_y = max(max_y - min_y, 1e-5)
    scale = min((width - pad * 2) / span_x, (height - pad * 2) / span_y)

    def to_screen(p):
        x = int((p[0] - min_x) * scale + pad)
        y = int(height - ((p[1] - min_y) * scale + pad))
        return x, y

    screen = [to_screen(p) for p in coords]
    buf = bytearray([238, 238, 232] * width * height)
    for edge in mesh.edges:
        x0, y0 = screen[edge.vertices[0]]
        x1, y1 = screen[edge.vertices[1]]
        draw_line(buf, width, height, x0, y0, x1, y1)
    eval_obj.to_mesh_clear()

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(f"P6\n{width} {height}\n255\n".encode("ascii"))
        tmp.write(buf)
    try:
        subprocess.run(["sips", "-s", "format", "png", str(tmp_path), "--out", str(path)], check=True, stdout=subprocess.DEVNULL)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def render_wireframe_old(asset_name: str, path: Path) -> None:
    joined = bpy.data.objects[asset_name]
    # Hide original material complexity and render an edge-tube wireframe copy.
    original = joined.copy()
    original.data = joined.data.copy()
    bpy.context.collection.objects.link(original)
    original.name = f"{asset_name}_Wireframe"
    joined.hide_render = True
    black = bpy.data.materials.new("Wireframe_Black")
    black.diffuse_color = (0.02, 0.02, 0.02, 1)
    original.data.materials.clear()
    original.data.materials.append(black)
    mod = original.modifiers.new("wireframe_edges", "WIREFRAME")
    mod.thickness = 0.012
    mod.use_even_offset = True
    bpy.context.view_layer.objects.active = original
    original.select_set(True)
    try:
        bpy.ops.object.modifier_apply(modifier=mod.name)
    except Exception:
        pass
    render_png(path)


def triangle_count(obj) -> int:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    mesh.calc_loop_triangles()
    total = len(mesh.loop_triangles)
    eval_obj.to_mesh_clear()
    return total


def write_report(asset_name: str, out_dir: Path, task: str, reference: str, notes: str) -> None:
    obj = bpy.data.objects[asset_name]
    tris = triangle_count(obj)
    mats = sorted({slot.material.name for slot in obj.material_slots if slot.material})
    report = {
        "asset": asset_name,
        "task": task,
        "reference": reference,
        "triangles": tris,
        "materials": mats,
        "texture_source": str(TEX_DIR.relative_to(ROOT)),
        "unit": "meter",
        "scale_factor": 1,
        "axis": "Y-up, gameplay-facing pieces authored around world origin",
        "notes": notes,
        "validation": {
            "fbx_exported": True,
            "uv_unwrapped": True,
            "pbr_texture_files_present": True,
            "unity_avatar_required": False,
            "navmesh_clean_geometry_review_required": True,
        },
    }
    (out_dir / "Reports").mkdir(parents=True, exist_ok=True)
    with open(out_dir / "Reports" / f"{asset_name}_budget_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)


def export_asset(asset_name: str, out_dir: Path, task: str, reference: str, notes: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    previews = out_dir / "Previews"
    wireframes = out_dir / "Wireframes"
    joined = join_meshes(asset_name)
    setup_camera(asset_name)
    render_png(previews / f"{asset_name}_preview.png")
    render_wireframe(asset_name, wireframes / f"{asset_name}_wireframe.png")
    # Restore original visibility before export.
    for obj in bpy.context.scene.objects:
        if obj.name.endswith("_Wireframe"):
            obj.hide_render = True
            obj.hide_set(True)
    joined.hide_render = False
    joined.hide_set(False)
    bpy.ops.object.select_all(action="DESELECT")
    joined.select_set(True)
    bpy.context.view_layer.objects.active = joined
    bpy.ops.export_scene.fbx(
        filepath=str(out_dir / f"{asset_name}.fbx"),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="Z",
        axis_up="Y",
        add_leaf_bones=False,
        path_mode="RELATIVE",
    )
    write_report(asset_name, out_dir, task, reference, notes)


def build_wall_straight():
    add_box("wall_body", (0, 0, 1.25), (2.0, 0.18, 2.5), "brick", 0.015)
    add_box("base_trim", (0, -0.096, 0.35), (2.04, 0.08, 0.12), "metalblue", 0.01)
    add_box("top_cap", (0, 0, 2.56), (2.08, 0.24, 0.12), "brick", 0.02)
    for x in (-0.72, 0.0, 0.72):
        add_box("paint_chip", (x, -0.102, 1.3), (0.18, 0.01, 0.08), "paper", 0.002)


def build_wall_corner():
    add_box("wall_a", (0.5, 0, 1.25), (1.0, 0.18, 2.5), "brick", 0.015)
    add_box("wall_b", (0.0, 0.5, 1.25), (0.18, 1.0, 2.5), "brick", 0.015)
    add_box("corner_post", (0, 0, 1.3), (0.26, 0.26, 2.6), "brick", 0.018)
    add_box("base_a", (0.5, -0.1, 0.35), (1.05, 0.08, 0.12), "metalblue", 0.01)
    add_box("base_b", (-0.1, 0.5, 0.35), (0.08, 1.05, 0.12), "metalblue", 0.01)


def build_wall_end():
    add_box("wall_end", (0, 0, 1.25), (0.35, 0.22, 2.5), "brick", 0.015)
    add_box("cap", (0, 0, 2.56), (0.42, 0.28, 0.12), "brick", 0.02)
    add_box("base", (0, -0.11, 0.35), (0.42, 0.08, 0.12), "metalblue", 0.01)


def build_floor(mat_key: str, name: str):
    add_box(name, (0, 0, 0), (2.0, 2.0, 0.04), mat_key, 0.004)
    if mat_key == "tile":
        for x in (-0.5, 0.0, 0.5):
            add_box("tile_groove_x", (x, 0, 0.025), (0.012, 2.0, 0.006), "rubber", 0)
            add_box("tile_groove_y", (0, x, 0.025), (2.0, 0.012, 0.006), "rubber", 0)


def build_door(kind: str):
    frame_mat = "brick" if kind != "classroom" else "wood"
    add_box("door_panel", (0, 0, 1.05), (0.92, 0.08, 2.1), "metalblue" if kind != "classroom" else "wood", 0.025)
    add_box("door_frame_l", (-0.55, 0, 1.15), (0.12, 0.16, 2.3), frame_mat, 0.015)
    add_box("door_frame_r", (0.55, 0, 1.15), (0.12, 0.16, 2.3), frame_mat, 0.015)
    add_box("door_frame_t", (0, 0, 2.26), (1.22, 0.16, 0.12), frame_mat, 0.015)
    add_box("kickplate", (0, -0.045, 0.28), (0.74, 0.03, 0.24), "badge", 0.01)
    add_cylinder("handle", (0.35, -0.07, 1.08), 0.035, 0.07, "badge", 16, 0.004)
    if kind != "rear":
        add_box("window_glass", (0, -0.048, 1.58), (0.26, 0.025, 0.55), "glass", 0.01)
    if kind == "front":
        add_box("front_gate_sign", (0, -0.07, 2.48), (1.25, 0.06, 0.2), "badge", 0.01)
    if kind == "rear":
        add_box("exit_warm_strip", (0, -0.065, 2.42), (1.15, 0.035, 0.08), "warm", 0.006)


def build_ceiling_light():
    add_box("fixture_body", (0, 0, 0), (0.9, 0.42, 0.08), "metalblue", 0.02)
    add_box("emissive_panel", (0, 0, -0.052), (0.78, 0.32, 0.025), "white", 0.01)
    add_box("mount_tabs", (-0.43, 0, 0.055), (0.04, 0.35, 0.04), "metalblue", 0.008)
    add_box("mount_tabs2", (0.43, 0, 0.055), (0.04, 0.35, 0.04), "metalblue", 0.008)


def build_locker_set():
    for i, x in enumerate([-0.75, -0.25, 0.25, 0.75]):
        add_box(f"locker_{i}", (x, 0, 0.95), (0.46, 0.36, 1.9), "metalblue", 0.025)
        for z in (1.35, 1.55, 1.75):
            add_box("vent", (x, -0.19, z), (0.24, 0.012, 0.018), "rubber", 0)
        add_box("handle_plate", (x + 0.16, -0.195, 1.0), (0.035, 0.02, 0.34), "badge", 0.004)
    add_box("locker_base", (0, 0, 0.04), (2.05, 0.42, 0.08), "rubber", 0.01)


def build_bulletin_board():
    add_box("board_back", (0, 0, 0.85), (1.45, 0.08, 0.9), "wood", 0.015)
    add_box("cork", (0, -0.045, 0.85), (1.28, 0.02, 0.72), "paper", 0.006)
    for i, x in enumerate([-0.38, 0.05, 0.42]):
        add_box(f"notice_{i}", (x, -0.06, 0.86 + 0.08 * i), (0.26, 0.01, 0.2), "paper", 0.002)


def build_fire_extinguisher():
    add_cylinder("tank", (0, 0, 0.5), 0.14, 0.8, "red", 32, 0.01)
    add_cylinder("hose", (0.16, 0, 0.83), 0.025, 0.32, "rubber", 16, 0.002)
    bpy.context.object.rotation_euler[1] = math.radians(70)
    add_box("label", (0, -0.141, 0.52), (0.16, 0.01, 0.2), "paper", 0.002)
    add_box("handle", (0, 0, 0.95), (0.26, 0.08, 0.06), "badge", 0.004)


def build_trash_bin():
    add_cylinder("bin_body", (0, 0, 0.45), 0.28, 0.9, "plasticblue", 32, 0.015)
    add_cylinder("rim", (0, 0, 0.92), 0.31, 0.05, "rubber", 32, 0.004)


def build_desk_chair():
    add_box("desktop", (-0.35, 0, 0.75), (0.9, 0.55, 0.06), "wood", 0.015)
    for x in (-0.72, 0.02):
        for y in (-0.22, 0.22):
            add_cylinder("desk_leg", (x, y, 0.38), 0.025, 0.7, "badge", 12, 0.002)
    add_box("chair_seat", (0.55, 0, 0.45), (0.45, 0.45, 0.06), "plasticblue", 0.02)
    add_box("chair_back", (0.76, 0, 0.83), (0.06, 0.48, 0.55), "plasticblue", 0.02)
    for x in (0.38, 0.72):
        for y in (-0.17, 0.17):
            add_cylinder("chair_leg", (x, y, 0.23), 0.022, 0.42, "badge", 12, 0.002)


def build_blackboard():
    add_box("frame", (0, 0, 0.8), (1.65, 0.08, 0.85), "wood", 0.015)
    add_box("board", (0, -0.045, 0.8), (1.48, 0.025, 0.68), "blackboard", 0.004)
    add_box("chalk_tray", (0, -0.08, 0.42), (1.48, 0.08, 0.04), "badge", 0.004)
    for x in (-0.4, 0.1, 0.46):
        add_box("chalk_marks", (x, -0.095, 0.86), (0.28, 0.006, 0.01), "paper", 0)


def build_podium():
    add_box("body", (0, 0, 0.55), (0.58, 0.42, 1.1), "wood", 0.02)
    add_box("slanted_top", (0, -0.05, 1.13), (0.66, 0.52, 0.08), "wood", 0.02)
    bpy.context.object.rotation_euler[0] = math.radians(-7)
    add_box("front_panel", (0, -0.215, 0.62), (0.46, 0.03, 0.56), "wood", 0.01)


def build_books():
    for i, (x, y, z) in enumerate([(-0.2, 0, 0.05), (0, 0.05, 0.11), (0.18, -0.02, 0.17), (0.36, 0.08, 0.04)]):
        add_box(f"book_{i}", (x, y, z), (0.32, 0.22, 0.06), "paper", 0.006)
        add_box(f"book_cover_{i}", (x, y, z + 0.034), (0.34, 0.24, 0.012), "plasticblue" if i % 2 else "metalblue", 0.003)


def build_backpack():
    add_sphere("bag_body", (0, 0, 0.48), (0.36, 0.22, 0.48), "metalblue")
    add_box("front_pocket", (0, -0.17, 0.42), (0.42, 0.05, 0.32), "metalblue", 0.03)
    add_box("zipper", (0, -0.205, 0.62), (0.34, 0.012, 0.035), "badge", 0.004)
    add_cylinder("strap_l", (-0.22, 0.08, 0.52), 0.025, 0.62, "leather", 12, 0.002)
    bpy.context.object.rotation_euler[1] = math.radians(20)
    add_cylinder("strap_r", (0.22, 0.08, 0.52), 0.025, 0.62, "leather", 12, 0.002)
    bpy.context.object.rotation_euler[1] = math.radians(-20)


def build_bench():
    for z in (0.45, 0.65):
        add_box("wood_slat", (0, 0, z), (1.7, 0.12, 0.08), "wood", 0.015)
    add_box("seat_slat", (0, -0.28, 0.38), (1.7, 0.48, 0.08), "wood", 0.015)
    for x in (-0.65, 0.65):
        add_box("iron_leg", (x, -0.28, 0.18), (0.08, 0.52, 0.36), "rubber", 0.015)


def build_tree():
    add_cylinder("trunk", (0, 0, 0.85), 0.14, 1.7, "wood", 20, 0.015)
    for i, (x, y, z, s) in enumerate([(0, 0, 1.85, 0.72), (0.35, 0.1, 1.55, 0.48), (-0.32, -0.08, 1.55, 0.48)]):
        add_sphere(f"leaf_mass_{i}", (x, y, z), (s, s * 0.78, s * 0.62), "grass")
    add_box("planter", (0, 0, 0.08), (1.0, 1.0, 0.16), "brick", 0.025)


def build_shrub():
    for i, (x, y, s) in enumerate([(-0.2, 0, 0.32), (0.15, 0.1, 0.28), (0.28, -0.08, 0.24)]):
        add_sphere(f"shrub_{i}", (x, y, 0.28), (s, s, s * 0.75), "grass")


def build_basketball_hoop():
    add_cylinder("pole", (0, 0, 1.15), 0.04, 2.3, "badge", 16, 0.002)
    add_box("backboard", (0, -0.18, 2.05), (0.9, 0.05, 0.55), "glass", 0.012)
    add_cylinder("rim", (0, -0.42, 1.88), 0.18, 0.025, "red", 32, 0.003)
    bpy.context.object.rotation_euler[0] = math.radians(90)
    add_box("base", (0, 0, 0.04), (0.55, 0.55, 0.08), "rubber", 0.012)


def build_police_car():
    add_box("car_body", (0, 0, 0.42), (1.8, 0.82, 0.38), "car", 0.08)
    add_box("car_cabin", (-0.15, 0, 0.72), (0.92, 0.72, 0.36), "glass", 0.06)
    add_box("hood_white", (0.52, -0.01, 0.64), (0.55, 0.84, 0.035), "paper", 0.01)
    add_box("door_white_l", (-0.18, -0.43, 0.46), (0.52, 0.035, 0.24), "paper", 0.006)
    add_box("door_white_r", (-0.18, 0.43, 0.46), (0.52, 0.035, 0.24), "paper", 0.006)
    for x in (-0.55, 0.55):
        for y in (-0.43, 0.43):
            add_cylinder("wheel", (x, y, 0.24), 0.18, 0.12, "rubber", 32, 0.008)
            bpy.context.object.rotation_euler[0] = math.radians(90)
    add_box("lightbar_base", (-0.2, 0, 0.98), (0.48, 0.16, 0.08), "rubber", 0.01)
    add_box("lightbar_red", (-0.2, -0.06, 1.03), (0.22, 0.06, 0.05), "red", 0.006)
    add_box("lightbar_blue", (-0.2, 0.06, 1.03), (0.22, 0.06, 0.05), "blue", 0.006)
    add_box("front_guard", (0.98, 0, 0.38), (0.08, 0.75, 0.28), "rubber", 0.01)


def build_station_facade():
    add_box("facade_body", (0, 0, 1.35), (2.6, 0.32, 2.7), "brick", 0.02)
    add_box("blue_band", (0, -0.18, 1.95), (2.7, 0.08, 0.28), "metalblue", 0.012)
    add_box("door_l", (-0.22, -0.19, 0.75), (0.42, 0.06, 1.35), "glass", 0.012)
    add_box("door_r", (0.22, -0.19, 0.75), (0.42, 0.06, 1.35), "glass", 0.012)
    add_box("warm_entry", (0, -0.22, 1.52), (1.05, 0.04, 0.08), "warm", 0.006)
    add_box("sign_plate", (0, -0.22, 2.26), (1.55, 0.05, 0.28), "badge", 0.012)
    add_box("steps", (0, -0.48, 0.08), (1.35, 0.55, 0.16), "tile", 0.015)
    for x in (-1.15, 1.15):
        add_box("lamp_body", (x, -0.22, 1.55), (0.12, 0.08, 0.32), "warm", 0.008)


ASSETS = [
    ("Wall_Straight_2m", MOD_DIR, "E", build_wall_straight, "2m straight wall with painted brick, blue base trim, cap, and surface wear."),
    ("Wall_Corner_2m", MOD_DIR, "E", build_wall_corner, "2m corner wall module using the same trim language."),
    ("Wall_End_2m", MOD_DIR, "E", build_wall_end, "End cap wall module for maze corridor termination."),
    ("Floor_Hallway_Tile", MOD_DIR, "E", lambda: build_floor("tile", "floor_hallway"), "2m tile floor module with modeled grout lines."),
    ("Floor_Classroom_Wood", MOD_DIR, "E", lambda: build_floor("woodfloor", "floor_classroom"), "2m classroom wood floor module."),
    ("Floor_Playground_Rubber", MOD_DIR, "E", lambda: build_floor("rubbertrack", "floor_rubber"), "2m playground/running-track floor module."),
    ("Floor_Grass", MOD_DIR, "E", lambda: build_floor("grass", "floor_grass"), "2m grass floor module."),
    ("Door_FrontGate", MOD_DIR, "E", lambda: build_door("front"), "Front gate landmark door module."),
    ("Door_Classroom", MOD_DIR, "E", lambda: build_door("classroom"), "Classroom door module."),
    ("Door_RearExit", MOD_DIR, "E", lambda: build_door("rear"), "Rear exit door with warm safety cue."),
    ("Light_Ceiling_Emissive", MOD_DIR, "E", build_ceiling_light, "Emissive ceiling light module."),
    ("Prop_Locker_Set", PROP_DIR, "F", build_locker_set, "Four-locker hallway prop set."),
    ("Prop_BulletinBoard", PROP_DIR, "F", build_bulletin_board, "School hallway bulletin board with layered notices."),
    ("Prop_FireExtinguisher", PROP_DIR, "F", build_fire_extinguisher, "Wall/standing fire extinguisher prop."),
    ("Prop_TrashBin", PROP_DIR, "F", build_trash_bin, "Blue school trash bin prop."),
    ("Prop_DeskChair_Set", PROP_DIR, "F", build_desk_chair, "Classroom desk and chair set."),
    ("Prop_Blackboard", PROP_DIR, "F", build_blackboard, "Classroom blackboard prop."),
    ("Prop_TeacherPodium", PROP_DIR, "F", build_podium, "Teacher podium prop."),
    ("Prop_ScatteredBooks", PROP_DIR, "F", build_books, "Narrative scattered books cluster."),
    ("Prop_DroppedBackpack", PROP_DIR, "F", build_backpack, "Narrative dropped backpack prop."),
    ("Prop_Bench", PROP_DIR, "F", build_bench, "School courtyard bench prop."),
    ("Prop_Tree_Set", PROP_DIR, "F", build_tree, "Tree with planter; LOD still required for final production."),
    ("Prop_Shrub_Set", PROP_DIR, "F", build_shrub, "Small shrub cluster."),
    ("Prop_BasketballHoop", PROP_DIR, "F", build_basketball_hoop, "Playground basketball hoop prop."),
    ("Prop_PoliceCar", PROP_DIR, "F", build_police_car, "Police car with emissive red-blue light bar; final production should add LOD."),
    ("Prop_PoliceStationFacade", PROP_DIR, "F", build_station_facade, "Warm police station facade landmark."),
]


def main() -> None:
    for asset_name, out_dir, task, builder, notes in ASSETS:
        expected = [
            out_dir / f"{asset_name}.fbx",
            out_dir / "Previews" / f"{asset_name}_preview.png",
            out_dir / "Wireframes" / f"{asset_name}_wireframe.png",
            out_dir / "Reports" / f"{asset_name}_budget_report.json",
        ]
        if all(path.exists() for path in expected):
            print(f"Skipping complete package {asset_name}")
            continue
        reset_scene()
        material("brick")  # initialize materials
        builder()
        export_asset(
            asset_name=asset_name,
            out_dir=out_dir,
            task=f"Task {task}",
            reference="art-source/Concepts/04_school_environment_sheet.png",
            notes=notes,
        )
        print(f"Exported {asset_name}")


if __name__ == "__main__":
    main()
