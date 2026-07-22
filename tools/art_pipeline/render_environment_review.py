"""Render a production environment GLB for visual QA without UI dependencies.

Usage:
  blender --background --python tools/art_pipeline/render_environment_review.py -- \
    --mesh public/models/environment/books.glb --out /tmp/books-review.png
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--azimuth", type=float, default=-32.0)
    parser.add_argument("--elevation", type=float, default=28.0)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def world_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    bpy.context.view_layer.update()
    points = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    return (
        Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points))),
        Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points))),
    )


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def material(name, color, roughness, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


def main() -> None:
    options = args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(Path(options.mesh).resolve()))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("Review asset contains no mesh")
    min_v, max_v = world_bounds(meshes)
    center = (min_v + max_v) * 0.5
    size = max_v - min_v
    horizontal = max(size.x, size.y, 0.1)
    vertical = max(size.z, 0.1)
    span = max(horizontal, vertical)

    # A neutral studio floor makes contact, floating and scale defects obvious.
    floor_mat = material("QA_Floor", (0.105, 0.115, 0.125), 0.72)
    bpy.ops.mesh.primitive_plane_add(size=max(span * 6.0, 6.0), location=(center.x, center.y, min_v.z - 0.008))
    floor = bpy.context.object
    floor.data.materials.append(floor_mat)

    azimuth = math.radians(options.azimuth)
    elevation = math.radians(options.elevation)
    distance = span * 4.5
    direction = Vector((math.sin(azimuth) * math.cos(elevation), -math.cos(azimuth) * math.cos(elevation), math.sin(elevation)))
    bpy.ops.object.camera_add(location=center + direction * distance)
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(horizontal * 1.35, vertical * 1.55, 0.65)
    camera.data.lens = 58
    look_at(camera, center + Vector((0.0, 0.0, size.z * 0.02)))
    bpy.context.scene.camera = camera

    key_pos = center + Vector((-span * 1.5, -span * 2.0, span * 2.5))
    bpy.ops.object.light_add(type="AREA", location=key_pos)
    key = bpy.context.object
    key.data.energy = 3200.0 * max(span, 0.5)
    key.data.shape = "DISK"
    key.data.size = span * 2.4
    look_at(key, center)
    bpy.ops.object.light_add(type="AREA", location=center + Vector((span * 1.8, span * 0.8, span * 1.2)))
    fill = bpy.context.object
    fill.data.energy = 1800.0 * max(span, 0.5)
    fill.data.size = span * 2.0
    look_at(fill, center)
    bpy.ops.object.light_add(type="AREA", location=center + Vector((0.0, span * 1.6, span * 2.2)))
    rim = bpy.context.object
    rim.data.energy = 2400.0 * max(span, 0.5)
    rim.data.size = span * 1.3
    look_at(rim, center)

    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.filepath = str(Path(options.out).resolve())
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.045, 0.060, 0.080, 1.0)
    background.inputs["Strength"].default_value = 0.42
    scene.view_settings.look = "AgX - Medium High Contrast"
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
