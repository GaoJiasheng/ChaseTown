#!/usr/bin/env python3
"""Render a simple orthographic preview for a mesh file in Blender."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ortho-scale", type=float, default=1.9)
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


def main() -> None:
    args = parse_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    meshes = import_mesh(Path(args.mesh))
    if not meshes:
        raise RuntimeError("No mesh imported")

    min_v, max_v = bounds_for(meshes)
    center = (min_v + max_v) * 0.5
    span = max((max_v - min_v).length, 1e-6)
    scale = 1.7 / span
    material = bpy.data.materials.new("Preview_Matte")
    material.diffuse_color = (0.56, 0.56, 0.56, 1.0)
    for obj in meshes:
        obj.location -= center
        obj.scale = (scale, scale, scale)
        obj.data.materials.clear()
        obj.data.materials.append(material)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
        obj.select_set(False)

    bpy.ops.object.light_add(type="AREA", location=(2.4, -4.0, 3.0))
    light = bpy.context.object
    light.data.energy = 680
    light.data.size = 4.0
    bpy.ops.object.camera_add(location=(0.0, -3.0, 0.8))
    camera = bpy.context.object
    look_at(camera, Vector((0, 0, 0.05)))
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = args.ortho_scale
    bpy.context.scene.camera = camera
    bpy.context.scene.render.resolution_x = 900
    bpy.context.scene.render.resolution_y = 1100
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = args.out
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
