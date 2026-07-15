#!/usr/bin/env python3
"""Render an 8-view turntable contact sheet for a mesh."""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--tmp-dir", default="docs/art_production/turntable_tmp")
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    return parser.parse_args(argv)


def import_mesh(path: Path) -> list[bpy.types.Object]:
    if path.suffix.lower() == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    elif path.suffix.lower() == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def bounds_for(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    pts = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    return (
        Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))),
        Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))),
    )


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def main() -> None:
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    meshes = import_mesh(Path(args.mesh))
    min_v, max_v = bounds_for(meshes)
    center = (min_v + max_v) * 0.5
    span = max((max_v - min_v).length, 1e-6)
    scale = 1.7 / span
    mat = bpy.data.materials.new("Preview_Matte")
    mat.diffuse_color = (0.56, 0.56, 0.56, 1.0)
    for obj in meshes:
        obj.location -= center
        obj.scale = (scale, scale, scale)
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
        obj.select_set(False)

    bpy.ops.object.light_add(type="AREA", location=(2.4, -4.0, 3.0))
    light = bpy.context.object
    light.data.energy = 680
    light.data.size = 4.0
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 1.9
    bpy.context.scene.camera = camera
    bpy.context.scene.render.resolution_x = 420
    bpy.context.scene.render.resolution_y = 520
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass

    tmp = Path(args.tmp_dir)
    tmp.mkdir(parents=True, exist_ok=True)
    frames = []
    for idx in range(8):
        angle = idx * math.tau / 8.0
        camera.location = (math.sin(angle) * 3.0, -math.cos(angle) * 3.0, 0.8)
        look_at(camera, Vector((0, 0, 0.05)))
        frame = tmp / f"view_{idx:02d}.png"
        bpy.context.scene.render.filepath = str(frame)
        bpy.ops.render.render(write_still=True)
        frames.append(frame)

    from PIL import Image, ImageDraw

    sheet = Image.new("RGB", (420 * 4, 560 * 2), (226, 226, 220))
    for idx, frame in enumerate(frames):
        im = Image.open(frame).convert("RGB")
        x = (idx % 4) * 420
        y = (idx // 4) * 560
        sheet.paste(im, (x, y + 40))
        ImageDraw.Draw(sheet).text((x + 12, y + 12), f"view {idx}", fill=(20, 20, 20))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out)


if __name__ == "__main__":
    main()
