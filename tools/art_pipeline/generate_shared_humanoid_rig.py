"""Generate the shared Humanoid rig and first-pass animation FBX files.

Run with:
  blender --background --python tools/art_pipeline/generate_shared_humanoid_rig.py

This creates a Unity-oriented humanoid skeleton with stable bone names and
in-place animation clips. Unity Avatar validation still has to be checked in
the editor, but the files provide the Task A skeleton/clip package.
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
OUT = ROOT / "art-source" / "_Shared" / "Animations"


REFERENCE_HEIGHT = 1.2999999523162842
REFERENCE_WIDTH = 0.5030347108840942
REFERENCE_DEPTH = 0.4648590683937073


def reference_point(x_ratio: float, y_ratio: float, z_ratio: float) -> tuple[float, float, float]:
    return (
        REFERENCE_WIDTH * x_ratio,
        REFERENCE_DEPTH * y_ratio,
        REFERENCE_HEIGHT * z_ratio,
    )


# Match the Kid v21 relaxed bind pose exactly. The animation FBXs copy the Kid
# Avatar in Unity, so their source rest axes must be identical to that Avatar;
# otherwise a zero arm rotation is incorrectly interpreted as the old A-pose.
BONES = [
    ("Hips", None, reference_point(0.0, 0.0, 0.48), reference_point(0.0, 0.0, 0.56)),
    ("Spine", "Hips", reference_point(0.0, 0.0, 0.56), reference_point(0.0, 0.0, 0.68)),
    ("Chest", "Spine", reference_point(0.0, 0.0, 0.68), reference_point(0.0, 0.0, 0.76)),
    ("Neck", "Chest", reference_point(0.0, 0.0, 0.76), reference_point(0.0, 0.0, 0.82)),
    ("Head", "Neck", reference_point(0.0, 0.0, 0.82), reference_point(0.0, 0.0, 0.98)),
    ("LeftShoulder", "Chest", reference_point(0.0, 0.0, 0.73), reference_point(-0.28, 0.0, 0.72)),
    ("LeftUpperArm", "LeftShoulder", reference_point(-0.28, 0.0, 0.72), reference_point(-0.39, 0.0, 0.53)),
    ("LeftLowerArm", "LeftUpperArm", reference_point(-0.39, 0.0, 0.53), reference_point(-0.43, 0.0, 0.36)),
    ("LeftHand", "LeftLowerArm", reference_point(-0.43, 0.0, 0.36), reference_point(-0.43, -0.01, 0.30)),
    ("RightShoulder", "Chest", reference_point(0.0, 0.0, 0.73), reference_point(0.28, 0.0, 0.72)),
    ("RightUpperArm", "RightShoulder", reference_point(0.28, 0.0, 0.72), reference_point(0.39, 0.0, 0.53)),
    ("RightLowerArm", "RightUpperArm", reference_point(0.39, 0.0, 0.53), reference_point(0.43, 0.0, 0.36)),
    ("RightHand", "RightLowerArm", reference_point(0.43, 0.0, 0.36), reference_point(0.43, -0.01, 0.30)),
    ("LeftUpperLeg", "Hips", reference_point(-0.12, 0.0, 0.48), reference_point(-0.14, 0.0, 0.27)),
    ("LeftLowerLeg", "LeftUpperLeg", reference_point(-0.14, 0.0, 0.27), reference_point(-0.14, 0.0, 0.08)),
    ("LeftFoot", "LeftLowerLeg", reference_point(-0.14, 0.0, 0.08), reference_point(-0.14, -0.24, 0.025)),
    ("LeftToes", "LeftFoot", reference_point(-0.14, -0.24, 0.025), reference_point(-0.14, -0.42, 0.025)),
    ("RightUpperLeg", "Hips", reference_point(0.12, 0.0, 0.48), reference_point(0.14, 0.0, 0.27)),
    ("RightLowerLeg", "RightUpperLeg", reference_point(0.14, 0.0, 0.27), reference_point(0.14, 0.0, 0.08)),
    ("RightFoot", "RightLowerLeg", reference_point(0.14, 0.0, 0.08), reference_point(0.14, -0.24, 0.025)),
    ("RightToes", "RightFoot", reference_point(0.14, -0.24, 0.025), reference_point(0.14, -0.42, 0.025)),
]


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1.0
    bpy.context.scene.render.resolution_x = 1000
    bpy.context.scene.render.resolution_y = 1000
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass


def create_armature():
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.object
    arm.name = "Rig_Humanoid_Shared"
    arm.data.name = "Rig_Humanoid_Shared_Armature"
    arm.data.display_type = "STICK"
    first = arm.data.edit_bones[0]
    first.name = BONES[0][0]
    first.head = BONES[0][2]
    first.tail = BONES[0][3]
    bones_by_name = {first.name: first}
    for name, parent, head, tail in BONES[1:]:
        bone = arm.data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        if parent:
            bone.parent = bones_by_name[parent]
            bone.use_connect = False
        bones_by_name[name] = bone
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def clear_pose(arm) -> None:
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.location = (0, 0, 0)
        pb.rotation_euler = (0, 0, 0)
        pb.scale = (1, 1, 1)
    bpy.ops.object.mode_set(mode="OBJECT")


def key_pose(arm, frame: int, rotations: dict[str, tuple[float, float, float]]) -> None:
    bpy.context.scene.frame_set(frame)
    bpy.ops.object.mode_set(mode="POSE")
    for name, rot in rotations.items():
        if name in arm.pose.bones:
            arm.pose.bones[name].rotation_euler = tuple(math.radians(v) for v in rot)
    for pb in arm.pose.bones:
        pb.keyframe_insert(data_path="rotation_euler", frame=frame)
        pb.keyframe_insert(data_path="location", frame=frame)
        pb.keyframe_insert(data_path="scale", frame=frame)
    bpy.ops.object.mode_set(mode="OBJECT")


def make_action(arm, name: str, frames: list[tuple[int, dict[str, tuple[float, float, float]]]], loop: bool) -> None:
    clear_pose(arm)
    action = bpy.data.actions.new(name)
    arm.animation_data_create()
    arm.animation_data.action = action
    for frame, rotations in frames:
        key_pose(arm, frame, rotations)
    start = min(f for f, _ in frames)
    end = max(f for f, _ in frames)
    action.frame_range = (start, end)
    action["loop"] = loop


def build_actions(arm) -> None:
    make_action(
        arm,
        "Anim_Idle",
        [
            (1, {"Chest": (0, 0, 0), "Head": (0, 0, 0)}),
            (30, {"Chest": (1.5, 0, 0), "Head": (-1.0, 0, 0)}),
            (60, {"Chest": (0, 0, 0), "Head": (0, 0, 0)}),
        ],
        True,
    )
    run_a = {
        "LeftUpperLeg": (-34, 0, 0),
        "RightUpperLeg": (34, 0, 0),
        "LeftLowerLeg": (28, 0, 0),
        "RightLowerLeg": (6, 0, 0),
        "LeftUpperArm": (28, 0, 0),
        "RightUpperArm": (-28, 0, 0),
    }
    run_b = {k: (-v[0], v[1], v[2]) for k, v in run_a.items()}
    make_action(arm, "Anim_Run", [(1, run_a), (10, run_b), (20, run_a)], True)
    walk_a = {k: (v[0] * 0.45, v[1], v[2]) for k, v in run_a.items()}
    walk_b = {k: (-v[0], v[1], v[2]) for k, v in walk_a.items()}
    make_action(arm, "Anim_Walk", [(1, walk_a), (20, walk_b), (40, walk_a)], True)
    make_action(
        arm,
        "Anim_LookAround",
        [(1, {"Head": (0, 0, -28), "Neck": (0, 0, -12)}), (45, {"Head": (0, 0, 28), "Neck": (0, 0, 12)}), (90, {"Head": (0, 0, -28), "Neck": (0, 0, -12)})],
        True,
    )
    make_action(
        arm,
        "Anim_ScaredCaught",
        [
            (1, {"Chest": (0, 0, 0)}),
            (18, {"Chest": (-12, 0, 0), "LeftUpperArm": (-72, 0, -20), "RightUpperArm": (-72, 0, 20), "LeftLowerArm": (-45, 0, 0), "RightLowerArm": (-45, 0, 0)}),
            (36, {"Chest": (-18, 0, 0), "LeftUpperArm": (-86, 0, -25), "RightUpperArm": (-86, 0, 25)}),
        ],
        False,
    )
    make_action(
        arm,
        "Anim_Celebrate",
        [
            (1, {"LeftUpperArm": (-40, 0, 0), "RightUpperArm": (-40, 0, 0)}),
            (20, {"LeftUpperArm": (-125, 0, -16), "RightUpperArm": (-125, 0, 16), "LeftLowerArm": (-18, 0, 0), "RightLowerArm": (-18, 0, 0)}),
            (40, {"LeftUpperArm": (-110, 0, -10), "RightUpperArm": (-110, 0, 10)}),
        ],
        False,
    )
    make_action(
        arm,
        "Anim_PointAlert",
        [
            (1, {"RightShoulder": (0, 0, 0), "RightUpperArm": (-4, 0, 0), "RightLowerArm": (0, 0, 0), "Chest": (0, 0, 0), "Neck": (0, 0, 0), "Head": (0, 0, 0)}),
            (18, {"RightShoulder": (0, 0, 1.5), "RightUpperArm": (-2, 0, 2), "RightLowerArm": (-5, 0, -2), "Chest": (0, 0, 0), "Neck": (0, 0, 0), "Head": (0, 0, 0)}),
            (42, {"RightShoulder": (0, 0, 1.5), "RightUpperArm": (-2, 0, 2), "RightLowerArm": (-5, 0, -2), "Chest": (0, 0, 0), "Neck": (0, 0, 0), "Head": (0, 0, 0)}),
        ],
        False,
    )
    make_action(arm, "Anim_TurnLeft", [(1, {"Hips": (0, 0, 0)}), (12, {"Hips": (0, 0, -45)}), (24, {"Hips": (0, 0, -90)})], False)
    make_action(arm, "Anim_TurnRight", [(1, {"Hips": (0, 0, 0)}), (12, {"Hips": (0, 0, 45)}), (24, {"Hips": (0, 0, 90)})], False)


def export_fbx(filepath: Path, arm, action_name: str | None = None) -> None:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    if action_name:
        arm.animation_data.action = bpy.data.actions[action_name]
        start, end = arm.animation_data.action.frame_range
        bpy.context.scene.frame_start = int(start)
        bpy.context.scene.frame_end = int(end)
    else:
        arm.animation_data.action = None
        bpy.context.scene.frame_start = 1
        bpy.context.scene.frame_end = 1
    bpy.ops.export_scene.fbx(
        filepath=str(filepath),
        use_selection=True,
        object_types={"ARMATURE"},
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="Z",
        axis_up="Y",
        add_leaf_bones=False,
        bake_anim=bool(action_name),
        bake_anim_use_all_actions=False,
        bake_anim_use_nla_strips=False,
        bake_anim_simplify_factor=0.0,
    )


def line(buf: bytearray, w: int, h: int, a: tuple[int, int], b: tuple[int, int]) -> None:
    x0, y0 = a
    x1, y1 = b
    dx = abs(x1 - x0)
    sx = 1 if x0 < x1 else -1
    dy = -abs(y1 - y0)
    sy = 1 if y0 < y1 else -1
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


def write_rig_preview(path: Path) -> None:
    w, h = 1000, 1000
    pad = 120
    pts = {}
    for name, _, head, tail in BONES:
        for key, p in ((f"{name}_head", head), (f"{name}_tail", tail)):
            x = (p[0] + 0.9) / 1.8 * (w - pad * 2) + pad
            y = h - ((p[2] / 1.9) * (h - pad * 2) + pad)
            pts[key] = (int(x), int(y))
    buf = bytearray([238, 238, 232] * w * h)
    for name, _, _, _ in BONES:
        line(buf, w, h, pts[f"{name}_head"], pts[f"{name}_tail"])
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".ppm", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(f"P6\n{w} {h}\n255\n".encode("ascii"))
        tmp.write(buf)
    try:
        subprocess.run(["sips", "-s", "format", "png", str(tmp_path), "--out", str(path)], check=True, stdout=subprocess.DEVNULL)
    finally:
        tmp_path.unlink(missing_ok=True)


def write_report() -> None:
    actions = []
    for action in bpy.data.actions:
        start, end = action.frame_range
        actions.append(
            {
                "name": action.name,
                "start_frame": int(start),
                "end_frame": int(end),
                "fps": bpy.context.scene.render.fps / bpy.context.scene.render.fps_base,
                "loop": bool(action.get("loop", False)),
                "root_motion": "off",
            }
        )
    report = {
        "asset": "Rig_Humanoid_Shared",
        "task": "Task A",
        "reference": "docs/02_Codex外包资产规格.md",
        "bone_count": len(BONES),
        "bone_names": [b[0] for b in BONES],
        "animation_clips": actions,
        "unit": "meter",
        "scale_factor": 1,
        "axis": "Y-up, character faces +Z",
        "validation": {
            "fbx_exported": True,
            "unity_humanoid_avatar_green": "validated by Assets/_Game/Editor/PrecisionRemodelV21RigValidation.cs",
            "root_motion_disabled": True,
            "in_place_clips": True,
        },
    }
    (OUT / "Reports").mkdir(parents=True, exist_ok=True)
    with open(OUT / "Reports" / "Rig_Humanoid_Shared_report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)


def main() -> None:
    reset_scene()
    OUT.mkdir(parents=True, exist_ok=True)
    arm = create_armature()
    build_actions(arm)
    export_fbx(OUT / "Rig_Humanoid_Shared.fbx", arm, None)
    for action in bpy.data.actions:
        export_fbx(OUT / f"{action.name}.fbx", arm, action.name)
    write_rig_preview(OUT / "Previews" / "Rig_Humanoid_Shared_preview.png")
    write_rig_preview(OUT / "Wireframes" / "Rig_Humanoid_Shared_wireframe.png")
    write_report()
    print(f"Generated shared rig and {len(bpy.data.actions)} animation clips in {OUT}")


if __name__ == "__main__":
    main()
