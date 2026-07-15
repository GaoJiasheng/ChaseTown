#!/usr/bin/env python3
"""Render a textured orthographic preview for a mesh from a named view."""

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
    parser.add_argument("--view", choices=("front", "back", "left", "right", "top"), default="front")
    parser.add_argument("--ortho-scale", type=float, default=2.05)
    parser.add_argument("--resolution-x", type=int, default=1100)
    parser.add_argument("--resolution-y", type=int, default=1500)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    return parser.parse_args(argv)


def import_mesh(path: Path) -> list[bpy.types.Object]:
    suffix = path.suffix.lower()
    if suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    elif suffix == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    elif suffix in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path))
    else:
        raise ValueError(f"Unsupported mesh: {path}")
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


def camera_location(view: str, distance: float, height: float) -> Vector:
    if view == "front":
        return Vector((0.0, -distance, height))
    if view == "back":
        return Vector((0.0, distance, height))
    if view == "left":
        return Vector((-distance, 0.0, height))
    if view == "top":
        return Vector((0.0, -0.001, distance))
    return Vector((distance, 0.0, height))


def main() -> None:
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    meshes = import_mesh(Path(args.mesh))
    if not meshes:
        raise RuntimeError("No mesh imported")

    min_v, max_v = bounds_for(meshes)
    center = (min_v + max_v) * 0.5
    for obj in meshes:
        obj.location -= center
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
        obj.select_set(False)

    bpy.ops.object.light_add(type="AREA", location=(2.6, -3.2, 3.2))
    key = bpy.context.object
    key.data.energy = 620
    key.data.size = 4.2
    bpy.ops.object.light_add(type="AREA", location=(-2.4, 2.6, 2.5))
    fill = bpy.context.object
    fill.data.energy = 170
    fill.data.size = 5.0

    distance = 4.0
    camera_height = 0.0
    target = Vector((0.0, 0.0, 0.0))
    bpy.ops.object.camera_add(location=camera_location(args.view, distance, camera_height))
    camera = bpy.context.object
    look_at(camera, target)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = args.ortho_scale
    bpy.context.scene.camera = camera

    bpy.context.scene.render.resolution_x = args.resolution_x
    bpy.context.scene.render.resolution_y = args.resolution_y
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE"
    except Exception:
        pass
    bpy.context.scene.world.color = (0.18, 0.18, 0.18)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = args.out
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
