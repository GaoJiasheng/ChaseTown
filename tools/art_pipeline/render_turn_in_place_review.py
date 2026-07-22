#!/usr/bin/env python3
"""Render runtime-composited 90/180-degree kid turn evidence.

The GLB clips deliberately contain no overall root yaw: the web runtime owns
the actor heading.  This reviewer applies the same external heading curve to
the armature object while the baked full-body TurnLeft/TurnRight clip plays,
then records fixed-camera stills and world-space foot positions.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import render_character_animation_review as review  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--resolution", type=int, default=640)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def smootherstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0)


def set_action_sample(
    armature: bpy.types.Object,
    action: bpy.types.Action,
    normalized: float,
    heading_radians: float,
) -> None:
    review.activate_action(armature, action)
    review.set_frame(review.frame_for(action, normalized))
    armature.rotation_mode = "XYZ"
    armature.rotation_euler = (0.0, 0.0, heading_radians)
    bpy.context.view_layer.update()


def sequence_samples(total_degrees: int) -> list[tuple[float, float]]:
    cycles = total_degrees // 90
    result: list[tuple[float, float]] = []
    for cycle in range(cycles):
        for quarter in range(4):
            result.append((cycle + quarter / 4.0, quarter / 4.0))
    result.append((float(cycles), 1.0))
    return result


def composite_turn_units(total_cycle: float, local_normalized: float, cycles: int) -> float:
    cycle_index = min(int(math.floor(total_cycle)), cycles - 1)
    return cycle_index + smootherstep(local_normalized)


def sampled_union_bounds(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
    actions: dict[str, bpy.types.Action],
) -> tuple[Vector, Vector]:
    minima: list[Vector] = []
    maxima: list[Vector] = []
    for clip_name, direction in (("TurnLeft", 1.0), ("TurnRight", -1.0)):
        action = actions[clip_name]
        for total_cycle, local_normalized in sequence_samples(180):
            heading = direction * math.radians(
                90.0 * composite_turn_units(total_cycle, local_normalized, 2)
            )
            set_action_sample(armature, action, local_normalized, heading)
            minimum, maximum = review.evaluated_bounds(meshes)
            minima.append(minimum)
            maxima.append(maximum)
    return (
        Vector((min(v.x for v in minima), min(v.y for v in minima), min(v.z for v in minima))),
        Vector((max(v.x for v in maxima), max(v.y for v in maxima), max(v.z for v in maxima))),
    )


def configure_camera(bounds_min: Vector, bounds_max: Vector, resolution: int) -> None:
    review.configure_studio(bounds_min, bounds_max, resolution, "front-three-quarter")
    camera = bpy.context.scene.camera
    assert camera is not None
    center = (bounds_min + bounds_max) * 0.5
    height = bounds_max.z - bounds_min.z
    camera.location = center + Vector((height * 1.75, -height * 2.75, height * 1.18))
    camera.data.lens = 58
    review.point_at(camera, Vector((center.x, center.y, bounds_min.z + height * 0.46)))


def world_bone(armature: bpy.types.Object, name: str) -> list[float]:
    value = armature.matrix_world @ armature.pose.bones[name].head
    return [round(float(component), 6) for component in value]


def render_sequence(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
    action: bpy.types.Action,
    direction: float,
    degrees: int,
    output: Path,
) -> list[dict[str, object]]:
    scene = bpy.context.scene
    evidence: list[dict[str, object]] = []
    clip_name = action.name
    cycles = degrees // 90
    for index, (total_cycle, local_normalized) in enumerate(sequence_samples(degrees)):
        completed = min(int(math.floor(total_cycle)), cycles - 1)
        heading_degrees = direction * 90.0 * composite_turn_units(
            total_cycle,
            local_normalized,
            cycles,
        )
        set_action_sample(armature, action, local_normalized, math.radians(heading_degrees))
        image = output / f"kid_{clip_name}_{degrees}_{index:02d}_{heading_degrees:+06.1f}deg.png"
        scene.render.filepath = str(image)
        bpy.ops.render.render(write_still=True)
        minimum, maximum = review.evaluated_bounds(meshes)
        evidence.append(
            {
                "clip": clip_name,
                "compositeTurnDegrees": degrees,
                "sequenceIndex": index,
                "clipCycle": completed + 1,
                "clipNormalized": round(local_normalized, 4),
                "runtimeHeadingDegrees": round(heading_degrees, 4),
                "leftFootWorld": world_bone(armature, "LeftFoot"),
                "rightFootWorld": world_bone(armature, "RightFoot"),
                "boundsMin": [round(float(value), 6) for value in minimum],
                "boundsMax": [round(float(value), 6) for value in maximum],
                "image": str(image),
            }
        )
        print(f"Rendered {image}")
    return evidence


def main() -> None:
    args = parse_args()
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    review.clear_scene()
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1.0
    armature, meshes = review.imported_character(args.input)
    actions = review.actions_by_name(["TurnLeft", "TurnRight"])
    union_min, union_max = sampled_union_bounds(armature, meshes, actions)
    configure_camera(union_min, union_max, args.resolution)

    frames: list[dict[str, object]] = []
    for clip_name, direction in (("TurnLeft", 1.0), ("TurnRight", -1.0)):
        for degrees in (90, 180):
            frames.extend(
                render_sequence(
                    armature,
                    meshes,
                    actions[clip_name],
                    direction,
                    degrees,
                    output,
                )
            )
    report = {
        "input": str(args.input.expanduser().resolve()),
        "contract": {
            "runtimeOwnsHeading": True,
            "rootYawRemovedFromClip": True,
            "singleClipDegrees": 90,
            "singleClipDurationSeconds": round(
                (actions["TurnLeft"].frame_range[1] - actions["TurnLeft"].frame_range[0]) / 30.0,
                4,
            ),
            "oneRepeatFor180Degrees": True,
        },
        "camera": "fixed elevated front-three-quarter",
        "frames": frames,
    }
    report_path = output / "kid_turn_in_place_review.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {report_path}")


if __name__ == "__main__":
    main()
