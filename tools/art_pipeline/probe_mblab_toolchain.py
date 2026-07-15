"""Probe MB-Lab humanoid base meshes for the docs/04 character rework route.

This does not create final game characters. It verifies that the local sandbox
has a real humanoid base mesh source, avoiding primitive-composed humans.
"""

from __future__ import annotations

from pathlib import Path
import json
import subprocess
import tempfile

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "tools" / "third_party" / "MB-Lab" / "data" / "humanoid_library.blend"
OUT = ROOT / "docs" / "art_production" / "character_toolchain_probe"


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


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


def look_at(obj, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_render(obj) -> None:
    bpy.ops.object.light_add(type="AREA", location=(2.2, -4.0, 3.2))
    light = bpy.context.object
    light.data.energy = 500
    light.data.size = 4
    bpy.ops.object.camera_add(location=(2.2, -4.5, 1.6))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, 1.0)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2.3
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


def write_wireframe(obj, path: Path) -> None:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    eval_obj = obj.evaluated_get(depsgraph)
    mesh = eval_obj.to_mesh()
    coords = []
    for vertex in mesh.vertices:
        p = obj.matrix_world @ vertex.co
        coords.append((p.x, p.z))
    min_x = min(p[0] for p in coords)
    max_x = max(p[0] for p in coords)
    min_y = min(p[1] for p in coords)
    max_y = max(p[1] for p in coords)
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

    for edge in mesh.edges:
        line(pts[edge.vertices[0]], pts[edge.vertices[1]])
    eval_obj.to_mesh_clear()
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


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    summary = []
    for name in ("MBLab_human_male", "MBLab_human_female"):
        reset_scene()
        obj = append_object(name)
        obj.location = (0, 0, 0)
        stats = mesh_stats(obj)
        setup_render(obj)
        render(OUT / f"{name}_preview.png")
        write_wireframe(obj, OUT / f"{name}_wireframe.png")
        export_fbx(obj, OUT / f"{name}_probe.fbx")
        summary.append({"object": name, **stats})
    (OUT / "probe_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
