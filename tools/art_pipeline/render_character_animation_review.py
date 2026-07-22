#!/usr/bin/env python3
"""Render fixed-camera review stills for a shipped animated character GLB.

This is an art QA tool, not part of the game runtime.  It deliberately keeps
the floor and camera fixed across every clip so foot sliding, ground
penetration, scale pops, unexpected root motion, and T-pose frames cannot be
hidden by automatic per-frame reframing.

Example:

    blender --background --factory-startup \
      --python tools/art_pipeline/render_character_animation_review.py -- \
      --input public/models/characters/kid.glb \
      --output /tmp/chasing-character-animation-review \
      --clips Idle Run HideEnter HideIdle HidePeek Caught
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


DEFAULT_CLIPS = ("Idle", "Run", "HideEnter", "HideIdle", "HidePeek", "Caught")
LOOP_CLIPS = {"Idle", "Run", "HideIdle", "HidePeek"}
REVIEW_SAMPLES = {
    True: (0.0, 0.25, 0.5, 0.75),
    False: (0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--clips", nargs="+", default=list(DEFAULT_CLIPS))
    parser.add_argument("--resolution", type=int, default=640)
    parser.add_argument("--view", choices=("front-three-quarter", "rear-three-quarter", "side"), default="front-three-quarter")
    parser.add_argument("--samples", nargs="+", type=float, help="optional normalized times shared by every requested clip")
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.armatures,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.materials,
    ):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def imported_character(path: Path) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"Expected one armature, found {[obj.name for obj in armatures]}")
    armature = armatures[0]
    meshes = [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "MESH"
        and (
            obj.parent == armature
            or any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in obj.modifiers)
        )
    ]
    if not meshes:
        raise RuntimeError("Character GLB contains no meshes")
    if armature.animation_data:
        for track in armature.animation_data.nla_tracks:
            track.mute = True
    return armature, meshes


def actions_by_name(clips: list[str]) -> dict[str, bpy.types.Action]:
    actions = {action.name: action for action in bpy.data.actions}
    missing = [name for name in clips if name not in actions]
    if missing:
        raise RuntimeError(f"Missing review clips: {missing}; available={sorted(actions)}")
    return {name: actions[name] for name in clips}


def activate_action(armature: bpy.types.Object, action: bpy.types.Action) -> None:
    armature.animation_data_create()
    armature.animation_data.action = action
    if action.slots:
        try:
            armature.animation_data.action_slot = action.slots[0]
        except (AttributeError, RuntimeError, TypeError):
            # Blender can infer the only OBJECT slot; older versions have no
            # explicit action_slot property.
            pass


def evaluated_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points: list[Vector] = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        points.extend(evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box)
    return (
        Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points))),
        Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points))),
    )


def frame_for(action: bpy.types.Action, normalized: float) -> float:
    start, end = map(float, action.frame_range)
    return start + (end - start) * normalized


def set_frame(frame: float) -> None:
    whole = math.floor(frame)
    bpy.context.scene.frame_set(whole, subframe=frame - whole)
    bpy.context.view_layer.update()


def sample_union_bounds(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
    actions: dict[str, bpy.types.Action],
    sample_override: tuple[float, ...] | None = None,
) -> tuple[Vector, Vector]:
    minima: list[Vector] = []
    maxima: list[Vector] = []
    for name, action in actions.items():
        activate_action(armature, action)
        for normalized in sample_override or REVIEW_SAMPLES[name in LOOP_CLIPS]:
            set_frame(frame_for(action, normalized))
            minimum, maximum = evaluated_bounds(meshes)
            minima.append(minimum)
            maxima.append(maximum)
    return (
        Vector((min(v.x for v in minima), min(v.y for v in minima), min(v.z for v in minima))),
        Vector((max(v.x for v in maxima), max(v.y for v in maxima), max(v.z for v in maxima))),
    )


def material(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Roughness"].default_value = roughness
    return mat


def add_review_floor(floor_z: float, center: Vector, span: float) -> None:
    bpy.ops.mesh.primitive_plane_add(size=max(8.0, span * 4.0), location=(center.x, center.y, floor_z))
    floor = bpy.context.object
    floor.name = "QA_FixedGroundReference"
    floor.data.materials.append(material("QA_Floor", (0.105, 0.12, 0.145, 1.0), 0.72))

    # Thin contrasting crosshairs make root drift and foot sliding readable.
    line_mat = material("QA_Axis", (0.24, 0.29, 0.34, 1.0), 0.58)
    for axis, scale in (((span * 2.0, 0.012, 0.006), (center.x, center.y, floor_z + 0.003)),
                        ((0.012, span * 2.0, 0.006), (center.x, center.y, floor_z + 0.003))):
        bpy.ops.mesh.primitive_cube_add(location=scale)
        marker = bpy.context.object
        marker.name = "QA_GroundAxis"
        marker.scale = axis
        marker.data.materials.append(line_mat)


def point_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def configure_studio(
    bounds_min: Vector,
    bounds_max: Vector,
    resolution: int,
    view: str,
) -> bpy.types.Object:
    scene = bpy.context.scene
    # Blender 5.x exposes Eevee as BLENDER_EEVEE; 4.x used the NEXT suffix.
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = resolution
    scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.render.fps = 24
    scene.render.fps_base = 1.0
    scene.render.use_file_extension = True
    scene.render.resolution_percentage = 100

    world = scene.world or bpy.data.worlds.new("QA_World")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.025, 0.034, 0.052, 1.0)
    background.inputs["Strength"].default_value = 0.30

    center = (bounds_min + bounds_max) * 0.5
    height = max(0.1, bounds_max.z - bounds_min.z)
    width = max(bounds_max.x - bounds_min.x, bounds_max.y - bounds_min.y)
    span = max(height, width)
    add_review_floor(bounds_min.z, center, span)

    camera_data = bpy.data.cameras.new("QA_ReviewCamera")
    camera = bpy.data.objects.new("QA_ReviewCamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.data.lens = 58
    camera.data.sensor_width = 36
    # The character faces -Y.  Additional views are used for checking the
    # backpack, shoulder roll, and silhouette overlap without altering framing.
    camera_offsets = {
        "front-three-quarter": Vector((height * 1.12, -height * 2.45, height * 0.31)),
        "rear-three-quarter": Vector((-height * 1.12, height * 2.45, height * 0.31)),
        "side": Vector((height * 2.65, 0.0, height * 0.31)),
    }
    camera.location = center + camera_offsets[view]
    point_at(camera, Vector((center.x, center.y, bounds_min.z + height * 0.52)))
    scene.camera = camera

    key_data = bpy.data.lights.new("QA_Key", "AREA")
    key_data.energy = 850
    key_data.shape = "DISK"
    key_data.size = height * 2.2
    key = bpy.data.objects.new("QA_Key", key_data)
    bpy.context.scene.collection.objects.link(key)
    key.location = center + Vector((-height * 1.7, -height * 2.0, height * 2.1))
    point_at(key, Vector((center.x, center.y, bounds_min.z + height * 0.55)))

    fill_data = bpy.data.lights.new("QA_Fill", "AREA")
    fill_data.energy = 520
    fill_data.size = height * 1.8
    fill = bpy.data.objects.new("QA_Fill", fill_data)
    bpy.context.scene.collection.objects.link(fill)
    fill.location = center + Vector((height * 1.9, -height * 0.8, height * 1.35))
    point_at(fill, Vector((center.x, center.y, bounds_min.z + height * 0.5)))

    rim_data = bpy.data.lights.new("QA_Rim", "AREA")
    rim_data.energy = 980
    rim_data.size = height * 1.4
    rim = bpy.data.objects.new("QA_Rim", rim_data)
    bpy.context.scene.collection.objects.link(rim)
    rim.location = center + Vector((-height * 0.5, height * 1.8, height * 1.65))
    point_at(rim, Vector((center.x, center.y, bounds_min.z + height * 0.58)))
    return camera


def vector_list(value: Vector) -> list[float]:
    return [round(float(component), 5) for component in value]


def bone_world_position(armature: bpy.types.Object, name: str) -> list[float] | None:
    bone = armature.pose.bones.get(name)
    if bone is None:
        return None
    return vector_list(armature.matrix_world @ bone.head)


def render_review(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
    actions: dict[str, bpy.types.Action],
    output: Path,
    floor_z: float,
    sample_override: tuple[float, ...] | None = None,
) -> list[dict[str, object]]:
    scene = bpy.context.scene
    evidence: list[dict[str, object]] = []
    output.mkdir(parents=True, exist_ok=True)
    for clip_name, action in actions.items():
        activate_action(armature, action)
        samples = sample_override or REVIEW_SAMPLES[clip_name in LOOP_CLIPS]
        for index, normalized in enumerate(samples):
            frame = frame_for(action, normalized)
            set_frame(frame)
            minimum, maximum = evaluated_bounds(meshes)
            path = output / f"kid_{clip_name}_{index + 1:02d}_t{normalized:0.2f}.png"
            scene.render.filepath = str(path)
            bpy.ops.render.render(write_still=True)
            evidence.append(
                {
                    "clip": clip_name,
                    "sampleIndex": index + 1,
                    "normalizedTime": round(normalized, 4),
                    "sourceFrame": round(frame, 4),
                    "image": str(path),
                    "boundsMin": vector_list(minimum),
                    "boundsMax": vector_list(maximum),
                    "height": round(maximum.z - minimum.z, 5),
                    "groundDelta": round(minimum.z - floor_z, 5),
                    "hips": bone_world_position(armature, "Hips"),
                    "leftFoot": bone_world_position(armature, "LeftFoot"),
                    "rightFoot": bone_world_position(armature, "RightFoot"),
                }
            )
            print(f"Rendered {path}")
    return evidence


def main() -> None:
    args = parse_args()
    clear_scene()
    armature, meshes = imported_character(args.input)
    actions = actions_by_name(args.clips)
    sample_override = tuple(args.samples) if args.samples else None
    if sample_override and any(value < 0.0 or value > 1.0 for value in sample_override):
        raise ValueError("--samples values must stay in the normalized 0..1 range")
    union_min, union_max = sample_union_bounds(armature, meshes, actions, sample_override)

    # Idle frame zero defines the authored ground plane.  It remains fixed even
    # if another animation later sinks or floats, making the defect visible.
    activate_action(armature, actions[args.clips[0]])
    set_frame(frame_for(actions[args.clips[0]], 0.0))
    baseline_min, _ = evaluated_bounds(meshes)
    configure_studio(union_min, union_max, args.resolution, args.view)
    evidence = render_review(armature, meshes, actions, args.output, baseline_min.z, sample_override)

    report = {
        "input": str(args.input.resolve()),
        "clips": args.clips,
        "camera": f"fixed {args.view}",
        "groundReferenceZ": round(baseline_min.z, 5),
        "sampledUnionBoundsMin": vector_list(union_min),
        "sampledUnionBoundsMax": vector_list(union_max),
        "frames": evidence,
    }
    report_path = args.output / "kid_animation_review.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {report_path}")


if __name__ == "__main__":
    main()
