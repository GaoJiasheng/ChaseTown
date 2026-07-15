"""Generate Task G sample maze assembly from reworked E/F art assets.

Run with:
  blender --background --python tools/art_pipeline/generate_sample_maze_rework.py
"""

from __future__ import annotations

from pathlib import Path
import importlib.util
import json
import math
import subprocess
import tempfile

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "art-source" / "Environment" / "SampleMaze"
METRICS = ROOT / "docs" / "art_production" / "ENVIRONMENT_TEXTURE_QUALITY_SUMMARY.json"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


PROPS_HELPER = load_module("envprops", ROOT / "tools" / "art_pipeline" / "generate_environment_props_rework.py")
H = PROPS_HELPER.H


MODULE_MATERIALS = {
    "Wall": ["PaintedWall", "WoodTrim", "WornMetal", "Paper"],
    "Floor_Hallway_Tile": ["HallwayTile", "WornMetal", "PlaygroundRubber"],
    "Floor_Classroom_Wood": ["ClassroomWood", "WornMetal"],
    "Floor_Playground_Rubber": ["PlaygroundRubber", "WornMetal", "RedPaintedMetal"],
    "Floor_Grass": ["Grass", "WoodTrim"],
    "Door": ["BluePaintedMetal", "WoodTrim", "WornMetal", "GlassBlue", "Paper"],
    "Light": ["WornMetal", "RubberBlack"],
}


def module_materials(name: str) -> list[str]:
    if name.startswith("Wall_"):
        return MODULE_MATERIALS["Wall"]
    if name.startswith("Door_"):
        return MODULE_MATERIALS["Door"]
    if name.startswith("Light_"):
        return MODULE_MATERIALS["Light"]
    return MODULE_MATERIALS[name]


def transform_objects(objects: list, loc=(0, 0, 0), rot_z=0.0, scale=1.0) -> None:
    transform = Matrix.Translation(Vector(loc)) @ Matrix.Rotation(rot_z, 4, "Z") @ Matrix.Scale(scale, 4)
    for obj in objects:
        obj.matrix_world = transform @ obj.matrix_world


def build_scene() -> tuple[list, set[str], list[dict]]:
    mats = H.materials()
    objects = []
    material_names: set[str] = set()
    placements = []

    def add_module(name: str, loc, rot_z=0.0, scale=1.0, label: str | None = None):
        built = H.build_asset(name, mats)
        transform_objects(built, loc, rot_z, scale)
        objects.extend(built)
        material_names.update(module_materials(name))
        placements.append({"type": "Task E module", "asset": name, "label": label or name})

    def add_prop(name: str, loc, rot_z=0.0, scale=1.0, label: str | None = None):
        built, used, _lod = PROPS_HELPER.build(name, mats)
        transform_objects(built, loc, rot_z, scale)
        objects.extend(built)
        material_names.update(used)
        placements.append({"type": "Task F prop", "asset": name, "label": label or name})

    step = 2.0
    for ix in range(-4, 5):
        for iy in range(-4, 5):
            if ix >= 2 and iy >= 1:
                floor = "Floor_Classroom_Wood"
            elif -1 <= ix <= 1 and -1 <= iy <= 1:
                floor = "Floor_Playground_Rubber"
            elif ix <= -3 and iy >= 1:
                floor = "Floor_Grass"
            else:
                floor = "Floor_Hallway_Tile"
            add_module(floor, (ix * step, iy * step, 0), scale=1.0, label="maze floor tile")

    boundary_positions = [i * step for i in range(-4, 5)]
    for x in boundary_positions:
        add_module("Wall_Straight_2m", (x, 9.0, 0), scale=1.0, label="north boundary")
        add_module("Wall_Straight_2m", (x, -9.0, 0), scale=1.0, label="south boundary")
    for y in boundary_positions:
        add_module("Wall_Straight_2m", (-9.0, y, 0), rot_z=math.radians(90), scale=1.0, label="west boundary")
        add_module("Wall_Straight_2m", (9.0, y, 0), rot_z=math.radians(90), scale=1.0, label="east boundary")

    for x in (-6.0, -4.0, -2.0, 2.0):
        add_module("Wall_Straight_2m", (x, -6.0, 0), scale=1.0, label="lower chase corridor")
    for y in (-4.0, -2.0, 0.0, 2.0):
        add_module("Wall_Straight_2m", (0.0, y, 0), rot_z=math.radians(90), scale=1.0, label="central turn spine")
    for x in (-6.0, -4.0, -2.0, 0.0, 4.0, 6.0):
        add_module("Wall_Straight_2m", (x, 2.0, 0), scale=1.0, label="mid maze wall")
    for y in (4.0, 6.0, 8.0):
        add_module("Wall_Straight_2m", (-6.0, y, 0), rot_z=math.radians(90), scale=1.0, label="left dead-end stack")
        add_module("Wall_Straight_2m", (6.0, y, 0), rot_z=math.radians(90), scale=1.0, label="classroom divider")

    add_module("Door_FrontGate", (-6.0, -9.4, 0), scale=1.0, label="cold entry gate")
    add_module("Door_Classroom", (6.0, 1.4, 0), rot_z=math.radians(90), scale=0.95, label="classroom door")
    add_module("Door_RearExit", (8.0, 9.4, 0), scale=0.95, label="rear exit door")

    for x, y in [(-4.0, -7.2), (-1.0, -3.6), (3.0, -0.3), (7.0, 7.0)]:
        add_module("Light_Ceiling_Emissive", (x, y, 2.65), rot_z=math.radians(20), scale=1.0, label="readability light")

    add_prop("Prop_Locker_Set", (-7.4, -4.8, 0), rot_z=math.radians(90), scale=0.95)
    add_prop("Prop_BulletinBoard", (-2.8, 1.6, 0), scale=0.90)
    add_prop("Prop_FireExtinguisher", (-8.2, 0.8, 0), scale=0.95)
    add_prop("Prop_TrashBin", (-5.0, -7.6, 0), scale=0.90)
    add_prop("Prop_DeskChair_Set", (5.2, 5.4, 0), rot_z=math.radians(-12), scale=0.90)
    add_prop("Prop_Blackboard", (7.6, 4.8, 0), rot_z=math.radians(90), scale=0.90)
    add_prop("Prop_TeacherPodium", (4.0, 7.1, 0), rot_z=math.radians(8), scale=0.90)
    add_prop("Prop_ScatteredBooks", (-2.4, -0.8, 0.02), rot_z=math.radians(-8), scale=1.0)
    add_prop("Prop_DroppedBackpack", (1.8, -1.4, 0), rot_z=math.radians(18), scale=0.90)
    add_prop("Prop_Bench", (-6.6, 6.2, 0), rot_z=math.radians(90), scale=0.90)
    add_prop("Prop_Tree_Set", (-7.2, 4.4, 0), scale=0.95)
    add_prop("Prop_Shrub_Set", (-7.6, 7.2, 0), scale=0.90)
    add_prop("Prop_BasketballHoop", (0.6, 1.2, 0), rot_z=math.radians(180), scale=0.90)
    add_prop("Prop_PoliceCar", (6.7, 6.8, 0), rot_z=math.radians(-20), scale=0.90)
    add_prop("Prop_PoliceStationFacade", (7.0, 8.25, 0), scale=0.90)

    return objects, material_names, placements


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_scene_render() -> None:
    bpy.context.scene.render.resolution_x = 1800
    bpy.context.scene.render.resolution_y = 1400
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass
    bpy.ops.object.light_add(type="AREA", location=(0, -5.5, 9.0))
    key = bpy.context.object
    key.data.energy = 1150
    key.data.size = 11.0
    bpy.ops.object.light_add(type="POINT", location=(5.7, 6.2, 2.6))
    warm = bpy.context.object
    warm.data.energy = 180
    warm.data.color = (1.0, 0.62, 0.28)
    bpy.ops.object.camera_add(location=(9.2, -10.5, 8.3))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, 0.85)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 22.5
    bpy.context.scene.camera = cam


def draw_topdown_wire(objects, path: Path) -> None:
    pts = []
    edges = []
    for obj in objects:
        start = len(pts)
        pts.extend([obj.matrix_world @ v.co for v in obj.data.vertices])
        edges.extend([(start + e.vertices[0], start + e.vertices[1]) for e in obj.data.edges])
    coords = [(p.x, p.y) for p in pts]
    min_x, max_x = min(x for x, _ in coords), max(x for x, _ in coords)
    min_y, max_y = min(y for _, y in coords), max(y for _, y in coords)
    w, h, pad = 1400, 1400, 90
    scale = min((w - 2 * pad) / max(max_x - min_x, 1e-5), (h - 2 * pad) / max(max_y - min_y, 1e-5))
    buf = bytearray([236, 235, 229] * w * h)

    def screen(i: int) -> tuple[int, int]:
        x, y = coords[i]
        return int((x - min_x) * scale + pad), int(h - ((y - min_y) * scale + pad))

    def line(a: tuple[int, int], b: tuple[int, int]) -> None:
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


def unique_checks(material_names: set[str], metrics: dict) -> list[dict]:
    checks = H.texture_checks_for(sorted(material_names), metrics)
    by_key = {}
    for item in checks:
        by_key[(item["file"], item["kind"])] = item
    return [by_key[key] for key in sorted(by_key)]


def main() -> int:
    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    H.reset_scene()
    objects, material_names, placements = build_scene()
    setup_scene_render()

    preview = SAMPLE / "Previews" / "SampleMaze_ArtLayout_preview.png"
    wireframe = SAMPLE / "Wireframes" / "SampleMaze_ArtLayout_wireframe.png"
    fbx = SAMPLE / "SampleMaze_ArtLayout.fbx"
    report_path = SAMPLE / "Reports" / "SampleMaze_ArtLayout_budget_report.json"

    H.render_preview(preview)
    draw_topdown_wire(objects, wireframe)
    H.export_fbx(fbx, objects)

    checks = unique_checks(material_names, metrics)
    stats = H.stats(objects)
    report = {
        "asset": "SampleMaze_ArtLayout",
        "task": "Task G",
        "reference_image": "art-source/Concepts/04_school_environment_sheet.png",
        "files": {
            "fbx": str(fbx.relative_to(ROOT)),
            "preview": str(preview.relative_to(ROOT)),
            "wireframe": str(wireframe.relative_to(ROOT)),
        },
        "mesh_stats": stats,
        "assembly": {
            "source_tasks": ["Task E modular kit", "Task F props"],
            "placement_count": len(placements),
            "placements": placements,
        },
        "quality_gate": {
            "texture_checks": checks,
            "texture_gate_passed": all(c["passed"] for c in checks),
            "bevel_used": True,
            "surface_detail_layers": ["reworked modular kit", "reworked props", "PBR texture sets", "beveled/seamed secondary geometry"],
            "primitive_placeholder_pipeline": False,
            "local_art_gate_passed": all(c["passed"] for c in checks),
            "unity_validation": "blocked_no_active_unity_license",
        },
        "status": "local_gate_candidate_unity_validation_pending",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    summary = {
        "asset_count": 1,
        "local_art_gate_passed": report["quality_gate"]["local_art_gate_passed"],
        "unity_validation": "blocked_no_active_unity_license",
        "result": {
            "asset": "SampleMaze_ArtLayout",
            **stats,
            "texture_gate_passed": report["quality_gate"]["texture_gate_passed"],
            "placement_count": len(placements),
        },
    }
    summary_path = ROOT / "docs" / "art_production" / "SAMPLE_MAZE_REWORK_SUMMARY.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["local_art_gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
