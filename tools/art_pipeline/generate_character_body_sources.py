"""Generate MB-Lab-derived WIP body source meshes for Task B/C/D.

These are not final character deliveries. They exist to replace the empty
character folders with a compliant non-primitive humanoid source route, while
keeping reports explicit that clothing, PBR maps, style polish, and Task A rig
binding are still pending.
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
LIB = ROOT / "tools" / "third_party" / "MB-Lab" / "data" / "humanoid_library.blend"
CHAR_DIR = ROOT / "art-source" / "Characters"


SPECS = [
    ("Kid", "Stylized", "MBLab_human_male", 1.30, "Slightly enlarged head and softened child proportions pending outfit pass."),
    ("Kid", "Photoreal", "MBLab_human_male", 1.30, "Photoreal child body source pending clothing, hair, PBR and legal review."),
    ("Kid", "BlindBox", "MBLab_anime_male", 1.30, "Rounded/anime-derived body source for toy variant pending toy-surface retopology."),
    ("Villain", "Stylized", "MBLab_human_male", 1.85, "Broad adult male body source pending coat/hood silhouette pass."),
    ("Villain", "Photoreal", "MBLab_human_male", 1.85, "Photoreal adult male body source pending coat, LOD and PBR pass."),
    ("Villain", "BlindBox", "MBLab_anime_male", 1.85, "Toy villain body source pending rounded coat/hood retopology."),
    ("Police", "Stylized", "MBLab_human_male", 1.80, "Friendly adult male body source pending uniform pass."),
    ("Police", "Photoreal", "MBLab_human_male", 1.80, "Photoreal adult male body source pending uniform, LOD and PBR pass."),
    ("Police", "BlindBox", "MBLab_anime_male", 1.80, "Toy police body source pending rounded uniform retopology."),
]


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


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
    if current <= 0:
        return
    scale = target_height / current
    obj.scale = (scale, scale, scale)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    min_z = min((obj.matrix_world @ v.co).z for v in obj.data.vertices)
    obj.location.z -= min_z


def style_body_proportions(obj, role: str, style: str) -> None:
    # Conservative deformation of a real humanoid mesh. This is intentionally
    # small because final silhouette should be solved by clothing/outfit meshes.
    height = mesh_height(obj)
    for v in obj.data.vertices:
        z = v.co.z / max(height, 1e-5)
        if role == "Kid":
            if z > 0.78:
                v.co.x *= 1.08 if style != "Photoreal" else 1.02
                v.co.y *= 1.08 if style != "Photoreal" else 1.02
            if 0.42 < z < 0.72:
                v.co.x *= 0.92
                v.co.y *= 0.95
        elif role == "Villain":
            if 0.48 < z < 0.82:
                v.co.x *= 1.16 if style != "BlindBox" else 1.24
                v.co.y *= 1.08
            if z < 0.2:
                v.co.x *= 1.08
        elif role == "Police":
            if 0.48 < z < 0.78:
                v.co.x *= 1.05
                v.co.y *= 1.03
        if style == "BlindBox":
            # Softer, less anatomical extremities for toy-source pass.
            if z > 0.75:
                v.co.x *= 1.12
                v.co.y *= 1.12
            if z < 0.18:
                v.co.x *= 1.1
                v.co.y *= 1.04
    obj.data.update()


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_render(target_height: float) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.2, -4.0, 3.2))
    light = bpy.context.object
    light.data.energy = 500
    light.data.size = 4
    bpy.ops.object.camera_add(location=(2.4, -4.6, target_height * 0.62))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, target_height * 0.52)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = target_height * 1.18
    bpy.context.scene.camera = cam
    bpy.context.scene.render.resolution_x = 1200
    bpy.context.scene.render.resolution_y = 1600
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass


def render(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def mesh_stats(obj) -> dict:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    mesh.calc_loop_triangles()
    stats = {
        "vertices": len(mesh.vertices),
        "polygons": len(mesh.polygons),
        "triangles": len(mesh.loop_triangles),
        "materials": [slot.material.name for slot in obj.material_slots if slot.material],
    }
    eval_obj.to_mesh_clear()
    return stats


def draw_wire(obj, path: Path) -> None:
    coords = [(v.co.x, v.co.z) for v in obj.data.vertices]
    min_x, max_x = min(x for x, _ in coords), max(x for x, _ in coords)
    min_y, max_y = min(y for _, y in coords), max(y for _, y in coords)
    w, h, pad = 900, 1400, 70
    scale = min((w - 2 * pad) / max(max_x - min_x, 1e-5), (h - 2 * pad) / max(max_y - min_y, 1e-5))

    def screen(p):
        return int((p[0] - min_x) * scale + pad), int(h - ((p[1] - min_y) * scale + pad))

    pts = [screen(p) for p in coords]
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
                buf[idx:idx + 3] = bytes((20, 20, 20))
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    for edge in obj.data.edges:
        line(pts[edge.vertices[0]], pts[edge.vertices[1]])
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(f"P6\n{w} {h}\n255\n".encode("ascii"))
        tmp.write(buf)
    try:
        subprocess.run(["sips", "-s", "format", "png", str(tmp_path), "--out", str(path)], check=True, stdout=subprocess.DEVNULL)
    finally:
        tmp_path.unlink(missing_ok=True)


def export_fbx(obj, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
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


def generate(role: str, style: str, template: str, height: float, note: str) -> dict:
    reset_scene()
    obj = append_object(template)
    obj.name = f"{role}_{style}_BodySource_WIP"
    normalize_height(obj, height)
    style_body_proportions(obj, role, style)
    out_dir = CHAR_DIR / role / style
    asset_name = f"{role}_{style}_BodySource_WIP"
    setup_render(height)
    render(out_dir / "Previews" / f"{asset_name}_preview.png")
    draw_wire(obj, out_dir / "Wireframes" / f"{asset_name}_wireframe.png")
    export_fbx(obj, out_dir / f"{asset_name}.fbx")
    stats = mesh_stats(obj)
    report = {
        "asset": asset_name,
        "task": f"Task {'B' if role == 'Kid' else 'C' if role == 'Villain' else 'D'}",
        "role": role,
        "style": style,
        "reference": f"art-source/Concepts/{'01_kid_character_sheet.png' if role == 'Kid' else '02_villain_character_sheet.png' if role == 'Villain' else '03_police_character_sheet.png'}",
        "source": {
            "tool": "MB-Lab",
            "template": template,
            "source_repo": "tools/third_party/MB-Lab",
            "primitive_composition": False,
        },
        "target_height_m": height,
        **stats,
        "unit": "meter",
        "scale_factor": 1,
        "axis": "Y-up, body source oriented for later +Z character setup",
        "quality_gate": {
            "overall_passed": False,
            "status": "wip_body_source_not_final_delivery",
            "texture_gate_passed": False,
            "geometry_base_source_passed": True,
            "shared_task_a_rig_bound": False,
            "reason": "This is a non-primitive humanoid body source only. Final clothing, PBR texture maps, LODs, and Task A rig binding are still required before B/C/D can be marked delivered.",
        },
        "notes": note,
    }
    reports = out_dir / "Reports"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / f"{asset_name}_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    reports = [generate(*spec) for spec in SPECS]
    print(json.dumps({"generated": len(reports), "assets": [r["asset"] for r in reports]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
