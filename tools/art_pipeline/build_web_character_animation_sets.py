#!/usr/bin/env python3
"""Bake production animation clips onto the three approved game characters.

Run with Blender, for example:

    blender --background --python tools/art_pipeline/build_web_character_animation_sets.py -- --all

The motion source is Quaternius' CC0 Universal Animation Library (Standard).
It is downloaded to an OS temp cache rather than vendored, keeping the web
repository and the shipped game small.  The resulting GLBs contain only the
approved character meshes, their 21-bone game rig, and the role-specific clips
used by the runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_URL = "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip"
SOURCE_CACHE = Path(tempfile.gettempdir()) / "chasing-quaternius-animation-library-standard.glb"
SOURCE_BYTES = 6_671_104
SOURCE_SHA256 = "1b7bf67866360665426bb99e4c71bd619f19b408453c24e30f0c3071601eee5c"
SOURCE_ARCHIVE_BYTES = 14_541_205
SOURCE_ARCHIVE_SHA256 = "18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2"
REPORT_DIR = ROOT / "art-source" / "_Shared" / "Animations" / "Reports"
PREVIEW_DIR = Path(tempfile.gettempdir()) / "chasing-character-animation-previews"


@dataclass(frozen=True)
class ClipSpec:
    name: str
    source: str
    loop: bool
    speed: float = 1.0
    note: str = ""


@dataclass(frozen=True)
class RoleSpec:
    key: str
    source_blend: Path
    output_glb: Path
    clips: tuple[ClipSpec, ...]


COMMON_LOCOMOTION = (
    ClipSpec("Idle", "Idle_Loop", True, note="three-second breathing and weight-shift cycle"),
    ClipSpec("Walk", "Walk_Loop", True, note="grounded in-place walk"),
    ClipSpec("Run", "Sprint_Loop", True, note="urgent in-place sprint"),
)

ROLE_SPECS: dict[str, RoleSpec] = {
    "kid": RoleSpec(
        "kid",
        ROOT
        / "art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Kid_PrecisionRemodel_v21_Rigged.blend",
        ROOT / "public/models/characters/kid.glb",
        COMMON_LOCOMOTION
        + (
            ClipSpec(
                "TurnLeft",
                "Punch_Cross",
                False,
                note="grounded 90-degree pivot with mirrored weight transfer and planted-foot lock",
            ),
            ClipSpec(
                "TurnRight",
                "Punch_Cross",
                False,
                note="grounded 90-degree pivot with authored weight transfer and planted-foot lock",
            ),
            ClipSpec("HideEnter", "Sitting_Enter", False, note="lowering profile and stepping into cover"),
            ClipSpec("HideIdle", "Sitting_Idle_Loop", True, note="contained breathing on the shared locker-low pose"),
            ClipSpec("HidePeek", "Sitting_Idle_Loop", True, note="authored low side-peek with locked hips and knees"),
            ClipSpec("HideExit", "Sitting_Exit", False, note="committed exit from cover"),
            ClipSpec("Caught", "Hit_Chest", False, note="authored one-second idle-to-recoil hold without recovery"),
            ClipSpec("EscapeCelebrate", "Dance_Loop", True, 0.82, "relief beat used after reaching safety"),
            ClipSpec("Interact", "Interact", False, note="hand-led environmental interaction"),
        ),
    ),
    "villain": RoleSpec(
        "villain",
        ROOT
        / "art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Villain_PrecisionRemodel_v21_Rigged.blend",
        ROOT / "public/models/characters/villain.glb",
        (
            ClipSpec("Idle", "Idle_Loop", True),
            ClipSpec("PatrolWalk", "Walk_Formal_Loop", True, 0.90, "deliberate patrol silhouette"),
            ClipSpec("Run", "Jog_Fwd_Loop", True, 1.08, "controlled chase rather than comic sprint"),
            ClipSpec("Alert", "Hit_Head", False, 0.72, "quick recognition/readability beat"),
            ClipSpec("LostSight", "Idle_Torch_Loop", True, 0.72, "slower head and shoulder scan"),
            ClipSpec("Search", "Idle_Torch_Loop", True, 0.88, "active search loop"),
            ClipSpec("CheckHide", "Interact", False, 0.88, "reaches for an interactive hiding-place door"),
            ClipSpec("Catch", "Punch_Enter", False, 0.72, "short reach-in anticipation; no strike follow-through"),
        ),
    ),
    "police": RoleSpec(
        "police",
        ROOT
        / "art-source/Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/Rigged/Police_HumanAnatomyRemodel_v22_Rigged.blend",
        ROOT / "public/models/characters/police.glb",
        (
            ClipSpec("Idle", "Idle_Loop", True),
            ClipSpec("Run", "Jog_Fwd_Loop", True),
            ClipSpec("Alert", "Idle_Torch_Loop", True, 0.90),
            ClipSpec("Interact", "Interact", False),
            ClipSpec("Resolve", "Punch_Enter", False, 0.70, "controlled intervention anticipation"),
        ),
    ),
}


BONE_MAP = {
    "Hips": "DEF-hips",
    "Spine": "DEF-spine.001",
    "Chest": "DEF-spine.003",
    "Neck": "DEF-neck",
    "Head": "DEF-head",
    # The approved game rig uses viewer-side naming (Left is x < 0), whereas
    # Quaternius uses the character's anatomical side (.L is x > 0).  Map by
    # geometric side so asymmetric strides and gestures do not cross the body.
    "LeftShoulder": "DEF-shoulder.R",
    "LeftUpperArm": "DEF-upper_arm.R",
    "LeftLowerArm": "DEF-forearm.R",
    "LeftHand": "DEF-hand.R",
    "RightShoulder": "DEF-shoulder.L",
    "RightUpperArm": "DEF-upper_arm.L",
    "RightLowerArm": "DEF-forearm.L",
    "RightHand": "DEF-hand.L",
    "LeftUpperLeg": "DEF-thigh.R",
    "LeftLowerLeg": "DEF-shin.R",
    "LeftFoot": "DEF-foot.R",
    "LeftToes": "DEF-toe.R",
    "RightUpperLeg": "DEF-thigh.L",
    "RightLowerLeg": "DEF-shin.L",
    "RightFoot": "DEF-foot.L",
    "RightToes": "DEF-toe.L",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--role", choices=tuple(ROLE_SPECS))
    parser.add_argument("--source-glb", type=Path)
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args(__import__("sys").argv[__import__("sys").argv.index("--") + 1 :] if "--" in __import__("sys").argv else [])
    if not args.all and not args.role:
        parser.error("pass --all or --role")
    return args


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified_motion_source(path: Path) -> bool:
    return (
        path.is_file()
        and path.stat().st_size == SOURCE_BYTES
        and sha256_file(path) == SOURCE_SHA256
    )


def ensure_motion_source(explicit: Path | None) -> Path:
    if explicit:
        source = explicit.expanduser().resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        return source
    if verified_motion_source(SOURCE_CACHE):
        return SOURCE_CACHE

    zip_path = Path(tempfile.gettempdir()) / "chasing-quaternius-animation-library-standard.zip"
    print(f"Downloading CC0 motion source: {SOURCE_URL}")
    urllib.request.urlretrieve(SOURCE_URL, zip_path)
    if (
        zip_path.stat().st_size != SOURCE_ARCHIVE_BYTES
        or sha256_file(zip_path) != SOURCE_ARCHIVE_SHA256
    ):
        raise RuntimeError("Downloaded Quaternius archive failed the pinned SHA-256/size gate")
    import zipfile

    member = "Animation Library[Standard]/Godot/AnimationLibrary_Godot_Standard.glb"
    with zipfile.ZipFile(zip_path) as archive:
        payload = archive.read(member)
    if len(payload) != SOURCE_BYTES or hashlib.sha256(payload).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Extracted Quaternius GLB failed the pinned SHA-256/size gate")
    SOURCE_CACHE.write_bytes(payload)
    return SOURCE_CACHE


def target_armature() -> bpy.types.Object:
    arms = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE" and obj.name == "Rig_Humanoid_Shared"]
    if len(arms) != 1:
        raise RuntimeError(f"Expected one approved 21-bone game rig; found {[obj.name for obj in arms]}")
    arm = arms[0]
    missing = sorted(set(BONE_MAP) - set(arm.pose.bones.keys()))
    if missing:
        raise RuntimeError(f"Target skeleton is missing bones: {missing}")
    return arm


def character_meshes(armature: bpy.types.Object) -> list[bpy.types.Object]:
    meshes: list[bpy.types.Object] = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or obj.name == "Studio_Floor":
            continue
        has_armature = any(mod.type == "ARMATURE" and mod.object == armature for mod in obj.modifiers)
        if obj.parent == armature or has_armature:
            meshes.append(obj)
    if not meshes:
        raise RuntimeError("No skinned character meshes found")
    return meshes


def import_motion_source(path: Path) -> tuple[bpy.types.Object, dict[str, bpy.types.Action]]:
    before_objects = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(path))
    imported_objects = [obj for obj in bpy.data.objects if obj not in before_objects]
    arms = [obj for obj in imported_objects if obj.type == "ARMATURE"]
    if len(arms) != 1:
        raise RuntimeError(f"Expected one source armature; found {[obj.name for obj in arms]}")
    source_arm = arms[0]
    actions = {action.name: action for action in bpy.data.actions if action not in before_actions}
    required = {clip.source for role in ROLE_SPECS.values() for clip in role.clips}
    missing = sorted(required - set(actions))
    if missing:
        raise RuntimeError(f"Motion library is missing required clips: {missing}")
    # Keep canonical runtime names available (notably "Interact") and ensure
    # Blender's ACTIONS exporter cannot confuse source and baked target clips.
    for original_name, action in actions.items():
        action.name = f"__UAL_SOURCE__{original_name}"
    source_arm.hide_render = True
    for obj in imported_objects:
        obj.hide_render = True
    return source_arm, actions


def reset_pose(armature: bpy.types.Object) -> None:
    for pb in armature.pose.bones:
        pb.rotation_mode = "QUATERNION"
        pb.location = (0.0, 0.0, 0.0)
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)


def source_height(source_arm: bpy.types.Object) -> float:
    head = source_arm.data.bones["DEF-head"]
    root = source_arm.data.bones["DEF-hips"]
    return max(0.1, head.tail_local.z - root.head_local.z)


def target_height(target_arm: bpy.types.Object) -> float:
    head = target_arm.data.bones["Head"]
    hips = target_arm.data.bones["Hips"]
    return max(0.1, head.tail_local.z - hips.head_local.z)


def desired_basis(
    target_bone: bpy.types.PoseBone,
    desired_rotation,
    root_offset: Vector | None,
) -> Matrix:
    rest = target_bone.bone.matrix_local
    if target_bone.parent:
        parent_pose = target_bone.parent.matrix.copy()
        parent_rest = target_bone.parent.bone.matrix_local
        rest_relative = parent_rest.inverted_safe() @ rest
        natural = parent_pose @ rest_relative
        desired = Matrix.Translation(natural.translation) @ desired_rotation.to_matrix().to_4x4()
        basis = rest_relative.inverted_safe() @ parent_pose.inverted_safe() @ desired
        return Matrix.LocRotScale(Vector((0.0, 0.0, 0.0)), basis.to_quaternion(), Vector((1.0, 1.0, 1.0)))
    desired_location = rest.translation + (root_offset or Vector())
    desired = Matrix.Translation(desired_location) @ desired_rotation.to_matrix().to_4x4()
    basis = rest.inverted_safe() @ desired
    return Matrix.LocRotScale(basis.translation, basis.to_quaternion(), Vector((1.0, 1.0, 1.0)))


def configure_action_metadata(action: bpy.types.Action, role: str, spec: ClipSpec, duration: float) -> None:
    action.use_fake_user = True
    action["role"] = role
    action["source"] = f"Quaternius UAL Standard/{spec.source}"
    action["license"] = "CC0-1.0"
    action["loop"] = spec.loop
    action["durationSeconds"] = round(duration, 4)
    action["quality"] = "full-body sampled retarget at 30fps"
    if spec.note:
        action["motionIntent"] = spec.note


@dataclass
class RetargetPose:
    rotations: dict[str, Quaternion]
    root_offset: Vector


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def smootherstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0)


def set_fractional_frame(frame: float) -> None:
    whole = int(math.floor(frame))
    bpy.context.scene.frame_set(whole, subframe=frame - whole)
    bpy.context.view_layer.update()


def sample_source_pose(
    source: bpy.types.Object,
    source_action: bpy.types.Action,
    source_frame: float,
    scale: float,
) -> RetargetPose:
    source.animation_data_create()
    source.animation_data.action = source_action
    set_fractional_frame(source_frame)
    rotations: dict[str, Quaternion] = {}
    root_offset = Vector((0.0, 0.0, 0.0))
    source_hips_rest = source.data.bones["DEF-hips"].matrix_local
    for target_name, source_name in BONE_MAP.items():
        source_pb = source.pose.bones[source_name]
        # Both rigs share Blender's armature axes and Y-along-bone convention,
        # but their rest poses differ.  The sampled armature-space orientation
        # avoids double-applying the T-pose-to-relaxed-shoulder rotation.
        rotations[target_name] = source_pb.matrix.to_quaternion().normalized()
        if target_name == "Hips":
            raw = (source_pb.matrix.translation - source_hips_rest.translation) * scale
            root_offset = Vector(
                (
                    max(-0.22, min(0.22, raw.x)),
                    max(-0.30, min(0.30, raw.y)),
                    max(-0.28, min(0.28, raw.z)),
                )
            )
    return RetargetPose(rotations, root_offset)


def blend_retarget_pose(
    first: RetargetPose,
    second: RetargetPose,
    factor: float,
    bone_factors: dict[str, float] | None = None,
    root_factor: float | None = None,
) -> RetargetPose:
    factor = max(0.0, min(1.0, factor))
    rotations = {
        name: first.rotations[name].slerp(
            second.rotations[name],
            max(0.0, min(1.0, factor * (bone_factors or {}).get(name, 1.0))),
        )
        for name in BONE_MAP
    }
    root_mix = factor if root_factor is None else factor * root_factor
    return RetargetPose(rotations, first.root_offset.lerp(second.root_offset, max(0.0, min(1.0, root_mix))))


def apply_retarget_pose(target: bpy.types.Object, pose: RetargetPose) -> None:
    for target_name in BONE_MAP:
        target_pb = target.pose.bones[target_name]
        root_offset = pose.root_offset if target_name == "Hips" else None
        target_pb.matrix_basis = desired_basis(target_pb, pose.rotations[target_name], root_offset)
        bpy.context.view_layer.update()


def key_target_pose(target: bpy.types.Object, target_frame: int) -> None:
    for target_name in BONE_MAP:
        target.pose.bones[target_name].keyframe_insert(
            data_path="rotation_quaternion",
            frame=target_frame,
            group=target_name,
        )
    target.pose.bones["Hips"].keyframe_insert(data_path="location", frame=target_frame, group="Hips")


def begin_target_action(target: bpy.types.Object, name: str) -> bpy.types.Action:
    target.animation_data_create()
    action = bpy.data.actions.new(name)
    target.animation_data.action = action
    # Blender 5 can drop the very first pose-bone key when an empty action has
    # no explicit slot yet (the root frame-zero key was the visible symptom).
    # Bind the sole OBJECT slot before writing any channels.
    slot = action.slots.new(id_type="OBJECT", name=target.name)
    target.animation_data.action_slot = slot
    reset_pose(target)
    return action


def finish_target_action(
    target: bpy.types.Object,
    action: bpy.types.Action,
    role: str,
    spec: ClipSpec,
    duration: float,
) -> bpy.types.Action:
    configure_action_metadata(action, role, spec, duration)
    for layer in action.layers:
        for strip in layer.strips:
            for slot in action.slots:
                channelbag = strip.channelbag(slot, ensure=False)
                if channelbag is None:
                    continue
                for fcurve in channelbag.fcurves:
                    for key in fcurve.keyframe_points:
                        key.interpolation = "LINEAR"

    track = target.animation_data.nla_tracks.new()
    track.name = spec.name
    strip = track.strips.new(spec.name, 0, action)
    strip.name = spec.name
    if strip.action_slot is None and action.slots:
        strip.action_slot = action.slots[0]
    strip.mute = True
    return action


def bake_clip(
    target: bpy.types.Object,
    source: bpy.types.Object,
    source_action: bpy.types.Action,
    clip: ClipSpec,
    role: str,
) -> bpy.types.Action:
    scene = bpy.context.scene
    source_fps = scene.render.fps / scene.render.fps_base
    start, end = map(float, source_action.frame_range)
    source_duration = max(1.0 / source_fps, (end - start) / source_fps)
    duration = source_duration / clip.speed
    target_end = max(2, int(round(duration * 30.0)))

    action = begin_target_action(target, clip.name)
    scale = target_height(target) / source_height(source)

    for target_frame in range(0, target_end + 1):
        normal = target_frame / target_end
        # Loop endpoints are forced to the same authored source sample.  Some
        # GLB source clips carry a few millimetres of endpoint drift despite
        # being labelled loops; preserving that drift creates a visible hitch.
        source_frame = start if clip.loop and target_frame == target_end else start + (end - start) * normal
        pose = sample_source_pose(source, source_action, source_frame, scale)
        apply_retarget_pose(target, pose)
        # Keep the scene on the sampled source frame.  Jumping the scene to the
        # target frame here re-evaluates the still-being-built target action and
        # overwrites the retargeted pose before it is keyed (most visibly after
        # the first baked clip).  keyframe_insert already accepts an explicit
        # destination frame, so no second scene evaluation is needed.
        key_target_pose(target, target_frame)

    return finish_target_action(target, action, role, clip, duration)


def bake_kid_hide_enter(
    target: bpy.types.Object,
    source: bpy.types.Object,
    source_actions: dict[str, bpy.types.Action],
    clip: ClipSpec,
) -> bpy.types.Action:
    """Bake a sit-down that lands exactly on the concealed idle seam."""
    source_action = source_actions[clip.source]
    idle_action = source_actions["Sitting_Idle_Loop"]
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    start, end = map(float, source_action.frame_range)
    duration = max(1.0 / fps, (end - start) / fps)
    target_end = max(2, int(round(duration * 30.0)))
    blend_frames = min(10, target_end // 2)
    scale = target_height(target) / source_height(source)
    idle_pose = sample_source_pose(source, idle_action, float(idle_action.frame_range[0]), scale)
    action = begin_target_action(target, clip.name)

    for target_frame in range(target_end + 1):
        normal = target_frame / target_end
        source_frame = start + (end - start) * normal
        pose = sample_source_pose(source, source_action, source_frame, scale)
        if target_frame >= target_end - blend_frames:
            blend = smootherstep((target_frame - (target_end - blend_frames)) / blend_frames)
            pose = blend_retarget_pose(pose, idle_pose, blend)
        apply_retarget_pose(target, pose)
        key_target_pose(target, target_frame)

    result = finish_target_action(target, action, "kid", clip, duration)
    result["source"] = "Quaternius UAL Standard/Sitting_Enter -> Sitting_Idle_Loop seam"
    result["seamBlendFrames"] = blend_frames
    result["transitionTarget"] = "HideIdle@frame0"
    return result


def turn_activity(normalized: float) -> float:
    """Ease the grounded step in and out while preserving exact Idle seams."""
    if normalized < 0.18:
        return smootherstep(normalized / 0.18)
    if normalized > 0.82:
        return smootherstep((1.0 - normalized) / 0.18)
    return 1.0


def rotate_vector_z(vector: Vector, radians: float) -> Vector:
    return Matrix.Rotation(radians, 4, "Z") @ vector


def mirror_rotation_x(rotation: Quaternion) -> Quaternion:
    """Reflect a global rotation across X without guessing quaternion signs."""
    reflection = Matrix(((-1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)))
    return (reflection @ rotation.to_matrix() @ reflection).to_quaternion().normalized()


def opposite_lateral_bone(name: str) -> str:
    if name.startswith("Left"):
        return "Right" + name[4:]
    if name.startswith("Right"):
        return "Left" + name[5:]
    return name


def add_leg_ankle_lift(
    target: bpy.types.Object,
    pose: RetargetPose,
    side: str,
    lift_meters: float,
) -> RetargetPose:
    """Lift one ankle with a connected two-bone solve, never bone translation."""
    if lift_meters <= 1e-6:
        return pose
    upper_name = f"{side}UpperLeg"
    lower_name = f"{side}LowerLeg"
    foot_name = f"{side}Foot"
    apply_retarget_pose(target, pose)
    hip = target.pose.bones[upper_name].head.copy()
    knee = target.pose.bones[lower_name].head.copy()
    ankle = target.pose.bones[foot_name].head.copy()
    desired_ankle = ankle + Vector((0.0, 0.0, lift_meters))
    upper_length = (knee - hip).length
    lower_length = (ankle - knee).length
    hip_to_ankle = desired_ankle - hip
    distance = max(
        abs(upper_length - lower_length) + 1e-5,
        min(upper_length + lower_length - 1e-5, hip_to_ankle.length),
    )
    direction = hip_to_ankle.normalized()
    along = (upper_length**2 - lower_length**2 + distance**2) / (2.0 * distance)
    perpendicular_length = math.sqrt(max(0.0, upper_length**2 - along**2))
    current_plane_offset = (knee - hip) - direction * (knee - hip).dot(direction)
    if current_plane_offset.length < 1e-6:
        current_plane_offset = direction.cross(Vector((1.0, 0.0, 0.0)))
        if current_plane_offset.length < 1e-6:
            current_plane_offset = direction.cross(Vector((0.0, 1.0, 0.0)))
    desired_knee = (
        hip
        + direction * along
        + current_plane_offset.normalized() * perpendicular_length
    )

    rotations = {name: rotation.copy() for name, rotation in pose.rotations.items()}
    bone_axis = Vector((0.0, 1.0, 0.0))
    current_upper_direction = rotations[upper_name] @ bone_axis
    desired_upper_direction = (desired_knee - hip).normalized()
    rotations[upper_name] = (
        current_upper_direction.rotation_difference(desired_upper_direction)
        @ rotations[upper_name]
    ).normalized()
    current_lower_direction = rotations[lower_name] @ bone_axis
    desired_lower_direction = (desired_ankle - desired_knee).normalized()
    rotations[lower_name] = (
        current_lower_direction.rotation_difference(desired_lower_direction)
        @ rotations[lower_name]
    ).normalized()
    return RetargetPose(rotations, pose.root_offset.copy())


def add_turn_upper_body_lead(
    pose: RetargetPose,
    normalized: float,
    direction: float,
) -> RetargetPose:
    """Let the gaze and chest lead the externally driven actor heading."""
    lead = math.sin(math.pi * normalized) * turn_activity(normalized)
    rotations = {name: rotation.copy() for name, rotation in pose.rotations.items()}
    for name, degrees in (
        ("Spine", 2.5),
        ("Chest", 6.5),
        ("Neck", 9.0),
        ("Head", 12.0),
    ):
        rotations[name] = (
            Quaternion((0.0, 0.0, 1.0), math.radians(degrees) * direction * lead)
            @ rotations[name]
        ).normalized()
    # A restrained counter-swing prevents the upper body from reading as a
    # rigid mannequin while keeping the backpack and hands clear of the torso.
    counter = -direction * lead
    for name, degrees in (
        ("LeftShoulder", 1.5),
        ("LeftUpperArm", 3.5),
        ("LeftLowerArm", 2.0),
        ("RightShoulder", 1.5),
        ("RightUpperArm", 3.5),
        ("RightLowerArm", 2.0),
    ):
        rotations[name] = (
            Quaternion((0.0, 0.0, 1.0), math.radians(degrees) * counter)
            @ rotations[name]
        ).normalized()
    return RetargetPose(rotations, pose.root_offset.copy())


def bake_kid_turn_in_place(
    target: bpy.types.Object,
    source: bpy.types.Object,
    source_actions: dict[str, bpy.types.Action],
    clip: ClipSpec,
) -> bpy.types.Action:
    """Bake a polished 90-degree turn for a heading-rotated runtime actor.

    The actor root owns the actual heading change.  This clip supplies the
    body mechanics from a restrained lower-body weight transfer plus a
    two-support foot-lock compensation, so the planted shoe remains fixed
    while the runtime rotates the actor.  Its exact Idle seams allow a second
    play to cover a 180-degree turn without a pose pop.
    """
    direction = 1.0 if clip.name == "TurnLeft" else -1.0
    source_action = source_actions[clip.source]
    idle_action = source_actions["Idle_Loop"]
    source_start, source_end = map(float, source_action.frame_range)
    duration = 18.0 / 30.0
    target_end = int(round(duration * 30.0))
    scale = target_height(target) / source_height(source)
    idle_pose = sample_source_pose(source, idle_action, float(idle_action.frame_range[0]), scale)
    action = begin_target_action(target, clip.name)

    # Punch_Cross contains a compact, grounded right-foot support and a small
    # opposite heel/toe pivot.  Only its lower-body delta is used; TurnLeft is
    # the mathematically reflected counterpart so the pair is truly mirrored.
    # The source's large upper-body punch is intentionally discarded.
    first_support = "LeftFoot" if direction > 0.0 else "RightFoot"
    second_support = "RightFoot" if direction > 0.0 else "LeftFoot"
    final_heading = direction * math.radians(90.0)
    source_base = sample_source_pose(source, source_action, source_start, scale)
    lower_weights = {
        "Hips": 0.65,
        "LeftUpperLeg": 0.80,
        "LeftLowerLeg": 0.90,
        "LeftFoot": 1.0,
        "LeftToes": 1.0,
        "RightUpperLeg": 0.80,
        "RightLowerLeg": 0.90,
        "RightFoot": 1.0,
        "RightToes": 1.0,
    }

    apply_retarget_pose(target, idle_pose)
    idle_feet = {
        name: target.pose.bones[name].head.copy()
        for name in ("LeftFoot", "RightFoot")
    }
    first_world_anchor = idle_feet[first_support].copy()
    second_world_anchor = rotate_vector_z(idle_feet[second_support], final_heading)

    for target_frame in range(target_end + 1):
        normalized = target_frame / target_end
        if target_frame in (0, target_end):
            # Hard-author both seams from the same captured Idle pose.  This
            # also keeps repeated 90-degree clips perfectly clean at 180.
            set_fractional_frame(float(target_frame))
            apply_retarget_pose(target, idle_pose)
            key_target_pose(target, target_frame)
            continue
        if normalized <= 0.08:
            source_phase = 0.0
        elif normalized >= 0.88:
            source_phase = 1.0
        else:
            source_phase = smootherstep((normalized - 0.08) / 0.80)
        source_frame = source_start + (source_end - source_start) * source_phase
        sampled = sample_source_pose(source, source_action, source_frame, scale)
        canonical_deltas = {
            name: (sampled.rotations[name] @ source_base.rotations[name].inverted()).normalized()
            for name in BONE_MAP
        }
        rotations = {name: value.copy() for name, value in idle_pose.rotations.items()}
        for target_name, weight in lower_weights.items():
            canonical_name = target_name if direction < 0.0 else opposite_lateral_bone(target_name)
            delta = canonical_deltas[canonical_name]
            if direction > 0.0:
                delta = mirror_rotation_x(delta)
            weighted = Quaternion((1.0, 0.0, 0.0, 0.0)).slerp(delta, weight)
            rotations[target_name] = (weighted @ idle_pose.rotations[target_name]).normalized()

        source_root_delta = (sampled.root_offset - source_base.root_offset) * 0.65
        if direction > 0.0:
            source_root_delta.x *= -1.0
        pose = RetargetPose(rotations, idle_pose.root_offset + source_root_delta)
        pose = add_turn_upper_body_lead(pose, normalized, direction)

        # The compact source pivot intentionally has little travel.  Add a
        # subtle 20 mm connected-leg lift to the moving shoe so the heel/toe
        # transfer remains readable at gameplay camera distance.  This is a
        # two-bone rotation solve; it never stretches or translates a limb.
        set_fractional_frame(float(target_frame))
        lift_phase = max(0.0, min(1.0, (normalized - 0.16) / 0.52))
        moving_lift = math.sin(math.pi * lift_phase) ** 2 * 0.020
        pose = add_leg_ankle_lift(
            target,
            pose,
            second_support.removesuffix("Foot"),
            moving_lift,
        )

        # Evaluate once without compensation to measure the authored foot
        # positions, then move only the Hips root so all joint rotations and
        # the source's full-body weight transfer remain intact.
        # Prime the destination frame first; Blender 5 otherwise re-evaluates
        # the partially built action at the source sample frame and can drop
        # the exact frame-zero/end Hips location even when rotations survive.
        set_fractional_frame(float(target_frame))
        heading = final_heading * smootherstep(normalized)
        heading_inverse = Quaternion((0.0, 0.0, 1.0), -heading)
        second_heading_delta = Quaternion((0.0, 0.0, 1.0), final_heading - heading)
        handoff = smootherstep((normalized - 0.42) / 0.26)
        # Lock both the ankle and toe orientation during each full-sole support
        # window.  Root translation below then fixes the ankle position, which
        # also fixes the toe joint instead of allowing the shoe to ice-skate.
        for suffix in ("Foot", "Toes"):
            first_name = first_support.replace("Foot", suffix)
            second_name = second_support.replace("Foot", suffix)
            first_rotation = (
                heading_inverse @ idle_pose.rotations[first_name]
            ).normalized()
            second_rotation = (
                second_heading_delta @ idle_pose.rotations[second_name]
            ).normalized()
            pose.rotations[first_name] = pose.rotations[first_name].slerp(
                first_rotation,
                1.0 - handoff,
            )
            pose.rotations[second_name] = pose.rotations[second_name].slerp(
                second_rotation,
                handoff,
            )
        first_desired_local = rotate_vector_z(first_world_anchor, -heading)
        second_desired_local = rotate_vector_z(second_world_anchor, -heading)
        # Hips basis translation is expressed in the root bone's rest basis,
        # not directly in armature axes.  Iterate the measured armature-space
        # correction so the evaluated support shoe, not an assumed transform,
        # is what satisfies the lock.
        for _ in range(6):
            apply_retarget_pose(target, pose)
            first_delta = first_desired_local - target.pose.bones[first_support].head
            second_delta = second_desired_local - target.pose.bones[second_support].head
            pose.root_offset += first_delta.lerp(second_delta, handoff)
        apply_retarget_pose(target, pose)
        key_target_pose(target, target_frame)

    result = finish_target_action(target, action, "kid", clip, duration)
    result["source"] = "Quaternius UAL Standard/Punch_Cross lower-body grounded pivot refinement"
    result["authoredHeadingDegrees"] = 90
    result["runtimeOwnsHeading"] = True
    result["rootYawRemoved"] = True
    result["supportSequence"] = f"{first_support} -> {second_support}"
    result["supportHandoffNormalized"] = [0.42, 0.68]
    result["sourceUpperBodyDiscarded"] = True
    result["mirroredPair"] = True
    result["repeatableFor180Degrees"] = True
    return result


def bake_kid_hide_exit(
    target: bpy.types.Object,
    source: bpy.types.Object,
    source_actions: dict[str, bpy.types.Action],
    clip: ClipSpec,
) -> bpy.types.Action:
    """Start the stand-up on the exact concealed idle pose."""
    source_action = source_actions[clip.source]
    idle_action = source_actions["Sitting_Idle_Loop"]
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    start, end = map(float, source_action.frame_range)
    duration = max(1.0 / fps, (end - start) / fps)
    target_end = max(2, int(round(duration * 30.0)))
    blend_frames = min(8, target_end // 3)
    scale = target_height(target) / source_height(source)
    idle_pose = sample_source_pose(source, idle_action, float(idle_action.frame_range[0]), scale)
    action = begin_target_action(target, clip.name)

    for target_frame in range(target_end + 1):
        normal = target_frame / target_end
        source_frame = start + (end - start) * normal
        source_pose = sample_source_pose(source, source_action, source_frame, scale)
        if target_frame <= blend_frames:
            pose = blend_retarget_pose(idle_pose, source_pose, smootherstep(target_frame / blend_frames))
        else:
            pose = source_pose
        apply_retarget_pose(target, pose)
        key_target_pose(target, target_frame)

    result = finish_target_action(target, action, "kid", clip, duration)
    result["source"] = "Quaternius UAL Standard/Sitting_Idle_Loop seam -> Sitting_Exit"
    result["seamBlendFrames"] = blend_frames
    result["transitionSource"] = "HideIdle@frame0"
    return result


def apply_global_peek_pose(base: RetargetPose, normalized: float) -> RetargetPose:
    """Author a low locker peek while leaving hips and lower body untouched."""
    edge = min(normalized / 0.28, (1.0 - normalized) / 0.28, 1.0)
    weight = smootherstep(edge)
    # A restrained hold keeps the silhouette readable without turning the
    # backpack into the head.  The character faces -Y and peeks toward +X.
    micro_look = math.sin(normalized * math.tau * 2.0) * math.radians(1.5) * weight

    authored: dict[str, tuple[float, float, float]] = {
        # (pitch around X, side lean around Y, yaw around Z)
        # Positive X pitch folds the already-seated torso forward, preventing
        # the peek from reading as a stand-up.  Y lean and Z yaw then carry the
        # head clearly toward the door side while hips/knees remain untouched.
        "Spine": (math.radians(4.0), math.radians(9.0), math.radians(6.0)),
        "Chest": (math.radians(7.0), math.radians(16.0), math.radians(13.0)),
        "Neck": (math.radians(5.0), math.radians(19.0), math.radians(25.0)),
        "Head": (math.radians(3.0), math.radians(23.0), math.radians(38.0) + micro_look),
        "LeftShoulder": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
        "LeftUpperArm": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
        "LeftLowerArm": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
        "LeftHand": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
        "RightShoulder": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
        "RightUpperArm": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
        "RightLowerArm": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
        "RightHand": (math.radians(5.0), math.radians(12.0), math.radians(10.0)),
    }
    rotations = {name: rotation.copy() for name, rotation in base.rotations.items()}
    for name, (pitch, lean, yaw) in authored.items():
        global_offset = (
            Quaternion((0.0, 0.0, 1.0), yaw * weight)
            @ Quaternion((0.0, 1.0, 0.0), lean * weight)
            @ Quaternion((1.0, 0.0, 0.0), pitch * weight)
        )
        rotations[name] = (global_offset @ rotations[name]).normalized()
    return RetargetPose(rotations, base.root_offset.copy())


def bake_kid_hide_peek(
    target: bpy.types.Object,
    source: bpy.types.Object,
    source_actions: dict[str, bpy.types.Action],
    clip: ClipSpec,
) -> bpy.types.Action:
    """Create a 1.6s low side-peek with exact HideIdle seams."""
    idle_action = source_actions["Sitting_Idle_Loop"]
    idle_start, idle_end = map(float, idle_action.frame_range)
    duration = 1.6
    target_end = int(round(duration * 30.0))
    scale = target_height(target) / source_height(source)
    action = begin_target_action(target, clip.name)

    for target_frame in range(target_end + 1):
        normal = target_frame / target_end
        # Explicitly sample frame zero at both seams, independent of tiny
        # source-loop endpoint drift.
        if target_frame in (0, target_end):
            source_frame = idle_start
        else:
            source_frame = idle_start + (idle_end - idle_start) * normal
        base = sample_source_pose(source, idle_action, source_frame, scale)
        pose = apply_global_peek_pose(base, normal)
        apply_retarget_pose(target, pose)
        key_target_pose(target, target_frame)

    result = finish_target_action(target, action, "kid", clip, duration)
    result["source"] = "Authored from Quaternius Sitting_Idle_Loop low-pose base"
    result["seamTarget"] = "HideIdle@frame0"
    result["lowerBodyLocked"] = True
    return result


def bake_kid_caught(
    target: bpy.types.Object,
    source: bpy.types.Object,
    source_actions: dict[str, bpy.types.Action],
    clip: ClipSpec,
) -> bpy.types.Action:
    """Create a readable idle-to-startle hold instead of a recovery clip."""
    scale = target_height(target) / source_height(source)
    idle_action = source_actions["Idle_Loop"]
    hit_action = source_actions["Hit_Chest"]
    idle_pose = sample_source_pose(source, idle_action, float(idle_action.frame_range[0]), scale)
    hit_pose = sample_source_pose(source, hit_action, float(hit_action.frame_range[0]), scale)
    duration = 1.0
    target_end = int(round(duration * 30.0))
    anticipation_end = 5
    recoil_end = 18
    action = begin_target_action(target, clip.name)

    central = {"Hips": 0.72, "Spine": 0.96, "Chest": 0.94, "Neck": 0.98, "Head": 1.0}
    arms = {
        name: 0.88
        for name in (
            "LeftShoulder",
            "LeftUpperArm",
            "LeftLowerArm",
            "LeftHand",
            "RightShoulder",
            "RightUpperArm",
            "RightLowerArm",
            "RightHand",
        )
    }
    legs = {
        name: 0.28
        for name in (
            "LeftUpperLeg",
            "LeftLowerLeg",
            "LeftFoot",
            "LeftToes",
            "RightUpperLeg",
            "RightLowerLeg",
            "RightFoot",
            "RightToes",
        )
    }
    bone_factors = {**central, **arms, **legs}

    for target_frame in range(target_end + 1):
        if target_frame <= anticipation_end:
            reaction = 0.0
        elif target_frame < recoil_end:
            reaction = smootherstep((target_frame - anticipation_end) / (recoil_end - anticipation_end))
        else:
            reaction = 1.0
        pose = blend_retarget_pose(
            idle_pose,
            hit_pose,
            reaction,
            bone_factors=bone_factors,
            root_factor=0.72,
        )
        if reaction > 0.0:
            # Clear caught silhouette: a short backward root shift, cumulative
            # chest/head recoil, and asymmetric arm flare.  These offsets are
            # sampled into the GLB (never generated procedurally at runtime).
            pose.root_offset += Vector((0.0, 0.052 * reaction, 0.0))
            recoil_offsets: dict[str, tuple[Vector, float]] = {
                "Spine": (Vector((1.0, 0.0, 0.0)), math.radians(-7.0)),
                "Chest": (Vector((1.0, 0.0, 0.0)), math.radians(-12.0)),
                "Neck": (Vector((1.0, 0.0, 0.0)), math.radians(-14.0)),
                "Head": (Vector((1.0, 0.0, 0.0)), math.radians(-18.0)),
                "LeftUpperArm": (Vector((0.0, 1.0, 0.0)), math.radians(18.0)),
                "LeftLowerArm": (Vector((0.0, 1.0, 0.0)), math.radians(12.0)),
                "LeftHand": (Vector((0.0, 1.0, 0.0)), math.radians(10.0)),
                "RightUpperArm": (Vector((0.0, 1.0, 0.0)), math.radians(-18.0)),
                "RightLowerArm": (Vector((0.0, 1.0, 0.0)), math.radians(-12.0)),
                "RightHand": (Vector((0.0, 1.0, 0.0)), math.radians(-10.0)),
            }
            for name, (axis, angle) in recoil_offsets.items():
                pose.rotations[name] = (
                    Quaternion(axis, angle * reaction) @ pose.rotations[name]
                ).normalized()
        # Prime Blender's dependency graph on the destination frame before
        # applying the offline-authored pose.  Without this evaluation Blender
        # 5 resets the root to the empty action's rest value on the first view-
        # layer update, dropping the Caught frame-zero seam.
        set_fractional_frame(float(target_frame))
        apply_retarget_pose(target, pose)
        key_target_pose(target, target_frame)

    result = finish_target_action(target, action, "kid", clip, duration)
    result["source"] = "Authored Idle_Loop -> restrained Hit_Chest hold"
    result["anticipationFrames"] = anticipation_end
    result["recoilCompleteFrame"] = recoil_end
    result["recoversToIdle"] = False
    return result


def capture_target_pose(target: bpy.types.Object, action: bpy.types.Action, frame: float) -> dict[str, tuple[Quaternion, Vector]]:
    target.animation_data.action = action
    if action.slots:
        target.animation_data.action_slot = action.slots[0]
    set_fractional_frame(frame)
    return {
        bone.name: (bone.matrix.to_quaternion().copy(), bone.matrix.translation.copy())
        for bone in target.pose.bones
    }


def target_pose_delta(
    first: dict[str, tuple[Quaternion, Vector]],
    second: dict[str, tuple[Quaternion, Vector]],
) -> tuple[float, float]:
    rotation = max(first[name][0].rotation_difference(second[name][0]).angle for name in first)
    position = max((first[name][1] - second[name][1]).length for name in first)
    return rotation, position


def validate_kid_action_seams(target: bpy.types.Object, actions: list[bpy.types.Action]) -> dict[str, dict[str, float]]:
    by_name = {action.name: action for action in actions}
    hide_idle = capture_target_pose(target, by_name["HideIdle"], float(by_name["HideIdle"].frame_range[0]))
    idle = capture_target_pose(target, by_name["Idle"], float(by_name["Idle"].frame_range[0]))
    checks = {
        "HideEnter->HideIdle": target_pose_delta(
            capture_target_pose(target, by_name["HideEnter"], float(by_name["HideEnter"].frame_range[1])),
            hide_idle,
        ),
        "HideIdle->HidePeek": target_pose_delta(
            capture_target_pose(target, by_name["HidePeek"], float(by_name["HidePeek"].frame_range[0])),
            hide_idle,
        ),
        "HidePeek->HideIdle": target_pose_delta(
            capture_target_pose(target, by_name["HidePeek"], float(by_name["HidePeek"].frame_range[1])),
            hide_idle,
        ),
        "HideIdle->HideExit": target_pose_delta(
            hide_idle,
            capture_target_pose(target, by_name["HideExit"], float(by_name["HideExit"].frame_range[0])),
        ),
        "Idle->Caught": target_pose_delta(
            capture_target_pose(target, by_name["Caught"], float(by_name["Caught"].frame_range[0])),
            idle,
        ),
        "Idle->TurnLeft": target_pose_delta(
            idle,
            capture_target_pose(target, by_name["TurnLeft"], float(by_name["TurnLeft"].frame_range[0])),
        ),
        "TurnLeft->Idle": target_pose_delta(
            capture_target_pose(target, by_name["TurnLeft"], float(by_name["TurnLeft"].frame_range[1])),
            idle,
        ),
        "Idle->TurnRight": target_pose_delta(
            idle,
            capture_target_pose(target, by_name["TurnRight"], float(by_name["TurnRight"].frame_range[0])),
        ),
        "TurnRight->Idle": target_pose_delta(
            capture_target_pose(target, by_name["TurnRight"], float(by_name["TurnRight"].frame_range[1])),
            idle,
        ),
        "IdleLoop": target_pose_delta(
            idle,
            capture_target_pose(target, by_name["Idle"], float(by_name["Idle"].frame_range[1])),
        ),
        "RunLoop": target_pose_delta(
            capture_target_pose(target, by_name["Run"], float(by_name["Run"].frame_range[0])),
            capture_target_pose(target, by_name["Run"], float(by_name["Run"].frame_range[1])),
        ),
    }
    report = {
        name: {"maxRadians": round(delta[0], 8), "maxMeters": round(delta[1], 8)}
        for name, delta in checks.items()
    }
    print("Kid action seam gates:", json.dumps(report, indent=2))
    failures = {name: values for name, values in checks.items() if values[0] > 1e-4 or values[1] > 1e-4}
    if failures:
        raise RuntimeError(f"Kid action seam gate failed: {failures}")
    return report


def validate_kid_turn_foot_lock(
    target: bpy.types.Object,
    actions: list[bpy.types.Action],
) -> dict[str, dict[str, object]]:
    """Measure planted-foot drift while simulating the runtime heading turn."""
    by_name = {action.name: action for action in actions}
    report: dict[str, dict[str, object]] = {}
    for clip_name, direction, first_support, second_support in (
        ("TurnLeft", 1.0, "LeftFoot", "RightFoot"),
        ("TurnRight", -1.0, "RightFoot", "LeftFoot"),
    ):
        action = by_name[clip_name]
        target.animation_data.action = action
        if action.slots:
            target.animation_data.action_slot = action.slots[0]
        start, end = map(float, action.frame_range)
        samples = max(1, int(round((end - start) * 4.0)))
        first_positions: dict[str, list[tuple[float, Vector]]] = {"Foot": [], "Toes": []}
        second_positions: dict[str, list[tuple[float, Vector]]] = {"Foot": [], "Toes": []}
        first_rotations: dict[str, list[tuple[float, Quaternion]]] = {"Foot": [], "Toes": []}
        second_rotations: dict[str, list[tuple[float, Quaternion]]] = {"Foot": [], "Toes": []}
        moving_heights: list[float] = []
        all_frames: list[tuple[float, dict[str, Vector], dict[str, Quaternion]]] = []
        hips_rotations: list[Quaternion] = []
        for index in range(samples + 1):
            normalized = index / samples
            set_fractional_frame(start + (end - start) * normalized)
            heading = direction * math.radians(90.0) * smootherstep(normalized)
            heading_rotation = Quaternion((0.0, 0.0, 1.0), heading)
            positions = {
                name: rotate_vector_z(target.pose.bones[name].head.copy(), heading)
                for name in ("LeftFoot", "LeftToes", "RightFoot", "RightToes")
            }
            rotations = {
                name: (heading_rotation @ target.pose.bones[name].matrix.to_quaternion()).normalized()
                for name in ("LeftFoot", "LeftToes", "RightFoot", "RightToes")
            }
            all_frames.append((normalized, positions, rotations))
            hips_rotations.append(target.pose.bones["Hips"].matrix.to_quaternion().copy())
        start_pose = all_frames[0]
        end_pose = all_frames[-1]
        first_toes = first_support.replace("Foot", "Toes")
        second_toes = second_support.replace("Foot", "Toes")
        for normalized, positions, rotations in all_frames:
            if normalized <= 0.42:
                for label, bone in (("Foot", first_support), ("Toes", first_toes)):
                    first_positions[label].append((normalized, positions[bone]))
                    first_rotations[label].append((normalized, rotations[bone]))
            if normalized >= 0.68:
                for label, bone in (("Foot", second_support), ("Toes", second_toes)):
                    second_positions[label].append((normalized, positions[bone]))
                    second_rotations[label].append((normalized, rotations[bone]))
            # The moving shoe reaches peak height during the handoff, so audit
            # the complete swing interval rather than only the full-sole lock
            # windows on either side of it.
            if normalized <= 0.68:
                moving_heights.append(
                    positions[second_support].z
                    - min(start_pose[1][second_support].z, end_pose[1][second_support].z)
                )
            if normalized >= 0.42:
                moving_heights.append(
                    positions[first_support].z
                    - min(start_pose[1][first_support].z, end_pose[1][first_support].z)
                )

        drift_measurements: list[tuple[float, float]] = []
        vertical_measurements: list[float] = []
        orientation_measurements: list[float] = []
        for label, bone in (("Foot", first_support), ("Toes", first_toes)):
            anchor_position = start_pose[1][bone]
            anchor_rotation = start_pose[2][bone]
            drift_measurements.extend(
                ((point - anchor_position).length, normalized)
                for normalized, point in first_positions[label]
            )
            vertical_measurements.extend(
                abs(point.z - anchor_position.z) for _, point in first_positions[label]
            )
            orientation_measurements.extend(
                min(
                    anchor_rotation.rotation_difference(rotation).angle,
                    math.tau - anchor_rotation.rotation_difference(rotation).angle,
                )
                for _, rotation in first_rotations[label]
            )
        for label, bone in (("Foot", second_support), ("Toes", second_toes)):
            anchor_position = end_pose[1][bone]
            anchor_rotation = end_pose[2][bone]
            drift_measurements.extend(
                ((point - anchor_position).length, normalized)
                for normalized, point in second_positions[label]
            )
            vertical_measurements.extend(
                abs(point.z - anchor_position.z) for _, point in second_positions[label]
            )
            orientation_measurements.extend(
                min(
                    anchor_rotation.rotation_difference(rotation).angle,
                    math.tau - anchor_rotation.rotation_difference(rotation).angle,
                )
                for _, rotation in second_rotations[label]
            )
        maximum_drift, worst_normalized = max(drift_measurements)
        maximum_vertical = max(vertical_measurements)
        maximum_orientation = max(orientation_measurements)
        moving_clearance = max(moving_heights)
        maximum_hips_rotation_delta = max(
            hips_rotations[0].rotation_difference(rotation).angle
            for rotation in hips_rotations
        )
        endpoint_hips_rotation_delta = hips_rotations[0].rotation_difference(hips_rotations[-1]).angle
        report[clip_name] = {
            "authoredDegrees": 90,
            "durationSeconds": round((end - start) / 30.0, 4),
            "runtimeHeadingSimulated": True,
            "rootYawRemoved": True,
            "maximumTransientBakedHipsRotationDeltaDegrees": round(
                math.degrees(maximum_hips_rotation_delta),
                6,
            ),
            "endpointBakedHipsRotationDeltaDegrees": round(
                math.degrees(endpoint_hips_rotation_delta),
                6,
            ),
            "supportSequence": [first_support, second_support],
            "supportWindows": [[0.0, 0.42], [0.68, 1.0]],
            "supportBonesAudited": ["Foot", "Toes"],
            "maximumSupportDriftMeters": round(maximum_drift, 6),
            "worstSupportDriftNormalized": round(worst_normalized, 4),
            "maximumSupportVerticalDriftMeters": round(maximum_vertical, 6),
            "maximumSupportOrientationDriftDegrees": round(math.degrees(maximum_orientation), 6),
            "movingFootClearanceMeters": round(moving_clearance, 6),
            "exactIdleSeamAllowsTwoPlaysFor180": True,
        }
        if maximum_drift > 0.010:
            raise RuntimeError(f"{clip_name} planted-foot drift is too high: {report[clip_name]}")
        if maximum_vertical > 0.006:
            raise RuntimeError(f"{clip_name} planted-foot vertical drift is too high: {report[clip_name]}")
        if math.degrees(maximum_orientation) > 3.0:
            raise RuntimeError(f"{clip_name} planted-foot orientation drift is too high: {report[clip_name]}")
        if moving_clearance < 0.025 or moving_clearance > 0.10:
            raise RuntimeError(f"{clip_name} moving foot never clears the floor: {report[clip_name]}")
        if math.degrees(maximum_hips_rotation_delta) > 18.0:
            raise RuntimeError(f"{clip_name} pelvis twist is too large: {report[clip_name]}")
        if math.degrees(endpoint_hips_rotation_delta) > 0.05:
            raise RuntimeError(f"{clip_name} must not bake cumulative runtime-owned root yaw: {report[clip_name]}")
    print("Kid turn-in-place gates:", json.dumps(report, indent=2))
    return report


def remove_source_objects(source: bpy.types.Object) -> None:
    roots = [source]
    objects: list[bpy.types.Object] = []
    while roots:
        obj = roots.pop()
        objects.append(obj)
        roots.extend(list(obj.children))
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)


def remove_source_actions(actions: dict[str, bpy.types.Action]) -> None:
    for action in actions.values():
        if action.name in bpy.data.actions:
            bpy.data.actions.remove(action, do_unlink=True)


def remove_non_character_objects(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    """Prevent hidden helpers from the motion library leaking into the GLB.

    Blender's select-all operator cannot reliably deselect hidden imported
    objects.  Removing everything outside the approved armature and skinned
    mesh list is deterministic and keeps collision/helper geometry out of the
    runtime asset.
    """
    approved = {armature, *meshes}
    for obj in list(bpy.context.scene.objects):
        if obj not in approved:
            bpy.data.objects.remove(obj, do_unlink=True)


def select_export_objects(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature


def export_character(spec: RoleSpec, armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    spec.output_glb.parent.mkdir(parents=True, exist_ok=True)
    select_export_objects(armature, meshes)
    armature.animation_data.action = None
    reset_pose(armature)
    bpy.context.scene.frame_set(0)
    bpy.ops.export_scene.gltf(
        filepath=str(spec.output_glb),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_skins=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_merge_animation="ACTION",
        export_force_sampling=True,
        export_frame_step=1,
        export_optimize_animation_size=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_keep_originals=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
    )


def build_role(spec: RoleSpec, source_path: Path, make_preview: bool) -> dict[str, object]:
    print(f"\n=== Building {spec.key} animation set ===")
    if not spec.source_blend.is_file():
        raise FileNotFoundError(spec.source_blend)
    bpy.ops.wm.open_mainfile(filepath=str(spec.source_blend))
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.render.fps_base = 1.0
    target = target_armature()
    meshes = character_meshes(target)

    if target.animation_data:
        target.animation_data.action = None
        for track in list(target.animation_data.nla_tracks):
            target.animation_data.nla_tracks.remove(track)
    source, source_actions = import_motion_source(source_path)
    baked: list[bpy.types.Action] = []
    for clip in spec.clips:
        if spec.key == "kid" and clip.name in ("TurnLeft", "TurnRight"):
            action = bake_kid_turn_in_place(target, source, source_actions, clip)
        elif spec.key == "kid" and clip.name == "HideEnter":
            action = bake_kid_hide_enter(target, source, source_actions, clip)
        elif spec.key == "kid" and clip.name == "HideExit":
            action = bake_kid_hide_exit(target, source, source_actions, clip)
        elif spec.key == "kid" and clip.name == "HidePeek":
            action = bake_kid_hide_peek(target, source, source_actions, clip)
        elif spec.key == "kid" and clip.name == "Caught":
            action = bake_kid_caught(target, source, source_actions, clip)
        else:
            action = bake_clip(target, source, source_actions[clip.source], clip, spec.key)
        baked.append(action)
    seam_report = validate_kid_action_seams(target, baked) if spec.key == "kid" else None
    turn_report = validate_kid_turn_foot_lock(target, baked) if spec.key == "kid" else None
    source.animation_data.action = None
    remove_source_objects(source)
    remove_source_actions(source_actions)
    remove_non_character_objects(target, meshes)
    export_character(spec, target, meshes)

    report = {
        "role": spec.key,
        "output": str(spec.output_glb.relative_to(ROOT)),
        "outputBytes": spec.output_glb.stat().st_size,
        "rig": target.name,
        "bones": len(target.data.bones),
        "meshes": len(meshes),
        "clips": [
            {
                "name": action.name,
                "frames": [round(float(action.frame_range[0]), 3), round(float(action.frame_range[1]), 3)],
                "durationSeconds": action["durationSeconds"],
                "source": action["source"],
                "loop": action["loop"],
            }
            for action in baked
        ],
        "qualityGates": {
            "hasRuntimeProceduralPose": False,
            "fullBodySampleRateFps": 30,
            "requiredBoneMapComplete": len(BONE_MAP) == 21,
            "sourceLicense": "CC0-1.0",
            "motionSource": {
                "bytes": source_path.stat().st_size,
                "sha256": sha256_file(source_path),
                "matchesPinnedQuaterniusStandard": verified_motion_source(source_path),
            },
            **({"seams": seam_report} if seam_report is not None else {}),
            **({"turnInPlace": turn_report} if turn_report is not None else {}),
        },
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = REPORT_DIR / f"{spec.key}_web_animation_set.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    if make_preview:
        print(f"Preview rendering is handled by render_animation_review.py; assets ready in {PREVIEW_DIR}")
    return report


def main() -> None:
    args = parse_args()
    source = ensure_motion_source(args.source_glb)
    roles = tuple(ROLE_SPECS) if args.all else (args.role,)
    reports = [build_role(ROLE_SPECS[role], source, args.preview) for role in roles]
    print(f"Built {len(reports)} role animation set(s).")


if __name__ == "__main__":
    main()
