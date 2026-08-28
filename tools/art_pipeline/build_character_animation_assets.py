#!/usr/bin/env python3
"""Build and embed the shared A1 animation clips in all runtime characters.

Normal entry point::

    python3 tools/art_pipeline/build_character_animation_assets.py

The command performs three deterministic stages:

1. Blender imports the canonical shared rig, then imports each of the nine
   authored FBX files into a clean scene.  Every frame is sampled from that
   FBX's own evaluated pose and converted to a canonical-rest-relative local
   rotation delta.  Actions are never transplanted between FBX armatures.
2. ``embed_character_animations.mjs`` composes those canonical deltas onto
   each role-specific runtime skeleton. Only quaternion tracks are embedded,
   preserving target translations/scale.
3. The animation encoder removes constant tracks and reduces quaternion keys
   while preserving the existing Meshopt-compressed geometry payload byte for
   byte; the whole character is deliberately not recompressed.

``art-source`` is never rewritten.  The three existing character files are
replaced only after every staged output passes the clip, skeleton, compression,
file-count, and total-size gates.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ANIMATION_ROOT = ROOT / "art-source" / "_Shared" / "Animations"
CANONICAL_RIG = ANIMATION_ROOT / "Rig_Humanoid_Shared.fbx"
CHARACTER_ROOT = ROOT / "public" / "models" / "characters"
MODELS_ROOT = ROOT / "public" / "models"
EMBED_SCRIPT = Path(__file__).with_name("embed_character_animations.mjs")
VALIDATOR_SCRIPT = Path(__file__).with_name("run_gltf_validator.mjs")
DEFAULT_REPORT = ANIMATION_ROOT / "Reports" / "A1_runtime_animation_report.json"

EXPECTED_BONES = [
    "Hips",
    "Spine",
    "Chest",
    "Neck",
    "Head",
    "LeftShoulder",
    "LeftUpperArm",
    "LeftLowerArm",
    "LeftHand",
    "RightShoulder",
    "RightUpperArm",
    "RightLowerArm",
    "RightHand",
    "LeftUpperLeg",
    "LeftLowerLeg",
    "LeftFoot",
    "LeftToes",
    "RightUpperLeg",
    "RightLowerLeg",
    "RightFoot",
    "RightToes",
]

CLIP_SPECS = [
    ("Idle", "Anim_Idle.fbx", True),
    ("Run", "Anim_Run.fbx", True),
    ("Walk", "Anim_Walk.fbx", True),
    ("TurnLeft", "Anim_TurnLeft.fbx", False),
    ("TurnRight", "Anim_TurnRight.fbx", False),
    ("LookAround", "Anim_LookAround.fbx", True),
    ("ScaredCaught", "Anim_ScaredCaught.fbx", False),
    ("Celebrate", "Anim_Celebrate.fbx", False),
    ("PointAlert", "Anim_PointAlert.fbx", False),
]
CHARACTERS = ["kid", "villain", "police"]
MAX_PUBLIC_MODELS_BYTES = 12_000_000
MAX_FIRST_SCREEN_BYTES = 6_000_000
INDEPENDENT_FIRST_SCREEN_BASELINE_BYTES = 4_944_886
EXPECTED_RUNTIME_GLB_COUNT = 29
VALIDATOR_PACKAGE = "gltf-validator@2.0.0-dev.3.10"
VALIDATOR_INTEGRITY = "sha512-odJ4k0tRkGXiDGn78yDBg+fBbAIvBnXxh3RwAta0emSxGtyagFE8B4xELB1oYe3S5RD8Ci3uZAsZaascH2LAEQ=="
BLOCKING_GLBS = [
    "characters/kid.glb",
    "characters/villain.glb",
    "environment/wall.glb",
    "environment/wall-corner.glb",
    "environment/wall-end.glb",
    "environment/floor.glb",
    "environment/exit.glb",
    "environment/front-gate.glb",
    "environment/classroom-floor.glb",
    "environment/playground-floor.glb",
    "environment/grass-floor.glb",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=ROOT,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
    )
    if result.returncode != 0:
        detail = f"\n{result.stdout}" if capture and result.stdout else ""
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}{detail}")
    return result


def glb_document(path: Path) -> dict[str, Any]:
    payload = path.read_bytes()
    if payload[:4] != b"glTF" or struct.unpack_from("<I", payload, 4)[0] != 2:
        raise ValueError(f"{path} is not a glTF 2.0 GLB")
    if struct.unpack_from("<I", payload, 8)[0] != len(payload):
        raise ValueError(f"{path} has an invalid declared length")
    offset = 12
    while offset + 8 <= len(payload):
        length, chunk_type = struct.unpack_from("<II", payload, offset)
        start = offset + 8
        end = start + length
        if end > len(payload):
            raise ValueError(f"{path} contains a truncated chunk")
        if chunk_type == 0x4E4F534A:
            return json.loads(payload[start:end].decode("utf-8").rstrip("\x00 "))
        offset = end
    raise ValueError(f"{path} has no JSON chunk")


def glb_binary(path: Path) -> bytes:
    payload = path.read_bytes()
    offset = 12
    while offset + 8 <= len(payload):
        length, chunk_type = struct.unpack_from("<II", payload, offset)
        start = offset + 8
        end = start + length
        if chunk_type == 0x004E4942:
            return payload[start:end]
        offset = end
    return b""


def canonical_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def static_document(document: dict[str, Any]) -> dict[str, Any]:
    snapshot = json.loads(json.dumps(document))
    marker = snapshot.get("asset", {}).get("extras", {}).get("chasingA1Animation")
    if marker:
        snapshot["accessors"] = snapshot.get("accessors", [])[: int(marker["baseAccessorCount"])]
        snapshot["bufferViews"] = snapshot.get("bufferViews", [])[: int(marker["baseBufferViewCount"])]
        snapshot["buffers"][0]["byteLength"] = int(marker["baseBufferByteLength"])
        del snapshot["asset"]["extras"]["chasingA1Animation"]
        if not snapshot["asset"]["extras"]:
            del snapshot["asset"]["extras"]
    snapshot.pop("animations", None)
    return snapshot


def triangle_count(document: dict[str, Any]) -> int:
    total = 0
    accessors = document.get("accessors", [])
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if primitive.get("mode", 4) != 4:
                raise ValueError("A1 character assets must use TRIANGLES primitives")
            accessor_index = primitive.get("indices", primitive.get("attributes", {}).get("POSITION"))
            if accessor_index is None:
                raise ValueError("A1 character primitive has no indices or positions")
            total += int(accessors[accessor_index]["count"]) // 3
    return total


def static_asset_report(path: Path) -> dict[str, Any]:
    document = glb_document(path)
    static = static_document(document)
    base_length = int(static.get("buffers", [{}])[0].get("byteLength", 0))
    binary = glb_binary(path)[:base_length]
    return {
        "structureSha256": canonical_hash(static),
        "binaryPrefixSha256": hashlib.sha256(binary).hexdigest(),
        "binaryPrefixBytes": len(binary),
        "meshes": len(static.get("meshes", [])),
        "primitives": sum(len(mesh.get("primitives", [])) for mesh in static.get("meshes", [])),
        "triangles": triangle_count(static),
        "materials": len(static.get("materials", [])),
        "textures": len(static.get("textures", [])),
        "images": len(static.get("images", [])),
        "skins": len(static.get("skins", [])),
        "nodes": len(static.get("nodes", [])),
        "accessors": len(static.get("accessors", [])),
        "bufferViews": len(static.get("bufferViews", [])),
    }


def first_screen_report(models_root: Path) -> dict[str, Any]:
    glb_files = [models_root / relative for relative in BLOCKING_GLBS]
    missing = [path for path in glb_files if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing blocking GLBs: {missing}")
    webps: set[Path] = set()
    for glb in glb_files:
        document = glb_document(glb)
        for image in document.get("images", []):
            uri = image.get("uri")
            if not uri or uri.startswith("data:"):
                continue
            relative = Path(uri.split("?", 1)[0])
            runtime_image = (glb.parent / relative).resolve().with_suffix(".webp")
            if not runtime_image.is_relative_to(models_root.resolve()):
                raise ValueError(f"Blocking texture escapes public/models: {uri}")
            if not runtime_image.is_file():
                raise FileNotFoundError(runtime_image)
            webps.add(runtime_image)
    glb_entries = [
        {"path": path.relative_to(models_root).as_posix(), "bytes": path.stat().st_size}
        for path in glb_files
    ]
    webp_entries = [
        {"path": path.relative_to(models_root).as_posix(), "bytes": path.stat().st_size}
        for path in sorted(webps)
    ]
    glb_bytes = sum(item["bytes"] for item in glb_entries)
    webp_bytes = sum(item["bytes"] for item in webp_entries)
    return {
        "glbs": glb_entries,
        "uniqueWebps": webp_entries,
        "glbCount": len(glb_entries),
        "uniqueWebpCount": len(webp_entries),
        "glbBytes": glb_bytes,
        "webpBytes": webp_bytes,
        "totalBytes": glb_bytes + webp_bytes,
        "limitBytes": MAX_FIRST_SCREEN_BYTES,
    }


def runtime_glb_count(root: Path) -> int:
    return sum(1 for _ in root.rglob("*.glb"))


def directory_bytes(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def prepare_official_validator(stage: Path) -> tuple[Path, dict[str, Any]]:
    package_dir = stage / "validator-package"
    package_dir.mkdir(parents=True, exist_ok=True)
    packed = run(
        ["npm", "pack", VALIDATOR_PACKAGE, "--pack-destination", str(package_dir), "--json"],
        capture=True,
    )
    metadata = json.loads(packed.stdout)[0]
    archive = package_dir / metadata["filename"]
    actual_integrity = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode("ascii")
    if actual_integrity != VALIDATOR_INTEGRITY:
        raise RuntimeError(f"Validator integrity mismatch: {actual_integrity}")
    extract_root = stage / "validator"
    extract_root.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as package:
        package.extractall(extract_root)
    module = extract_root / "package" / "module.mjs"
    if not module.is_file():
        raise FileNotFoundError(module)
    return module, {
        "package": VALIDATOR_PACKAGE,
        "integrity": actual_integrity,
        "npmShasum": metadata.get("shasum"),
    }


def validate_official(path: Path, validator_module: Path) -> dict[str, Any]:
    result = run(
        [
            "node",
            str(VALIDATOR_SCRIPT),
            "--validator-module",
            str(validator_module),
            "--file",
            str(path),
            "--resource-root",
            str(CHARACTER_ROOT),
            "--allowed-root",
            str(MODELS_ROOT),
        ],
        capture=True,
    )
    report = json.loads(result.stdout)
    issues = report.get("issues", {})
    messages = issues.get("messages", [])
    warning_groups: dict[tuple[str, str], list[str]] = {}
    for message in messages:
        if int(message.get("severity", -1)) != 1:
            continue
        key = (str(message.get("code")), str(message.get("message")))
        warning_groups.setdefault(key, []).append(str(message.get("pointer", "")))
    explanations = {
        "NODE_SKINNED_MESH_NON_ROOT": (
            "Inherited character topology: each authored skinned part remains under its original static wrapper. "
            "A1 static structure and binary-prefix hashes are exact before/after, and P4 batching relies on these wrappers."
        ),
        "NODE_SKINNED_MESH_LOCAL_TRANSFORMS": (
            "Inherited per-part bind transforms. A1 does not modify mesh nodes, bind matrices, geometry, or skin data; "
            "the exact static hash and P4 real-asset regression guard this baseline."
        ),
    }
    warnings = [
        {
            "code": code,
            "count": len(pointers),
            "message": message,
            "representativePointers": pointers[:3],
            "explanation": explanations.get(code, "Inherited warning; see exact static before/after hash evidence."),
        }
        for (code, message), pointers in sorted(warning_groups.items())
    ]
    errors = [message for message in messages if int(message.get("severity", -1)) == 0]
    if int(issues.get("numErrors", 0)) != 0 or errors:
        raise RuntimeError(f"glTF Validator rejected {path}: {errors}")
    return {
        "validatorVersion": report.get("validatorVersion"),
        "errors": int(issues.get("numErrors", 0)),
        "warningCount": int(issues.get("numWarnings", 0)),
        "warnings": warnings,
        "infos": int(issues.get("numInfos", 0)),
        "hints": int(issues.get("numHints", 0)),
    }


def git_blob(ref: str, relative: Path) -> bytes:
    result = subprocess.run(
        ["git", "show", f"{ref}:{relative.as_posix()}"],
        cwd=ROOT,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
    return result.stdout


def animation_report(document: dict[str, Any]) -> list[dict[str, Any]]:
    nodes = document.get("nodes", [])
    accessors = document.get("accessors", [])
    result: list[dict[str, Any]] = []
    for animation in document.get("animations", []):
        targets = []
        duration = 0.0
        paths = set()
        for channel in animation.get("channels", []):
            target = channel["target"]
            target_name = nodes[target["node"]].get("name", "")
            targets.append(target_name)
            paths.add(target["path"])
            sampler = animation["samplers"][channel["sampler"]]
            time_accessor = accessors[sampler["input"]]
            if time_accessor.get("max"):
                duration = max(duration, float(time_accessor["max"][0]))
        result.append(
            {
                "name": animation.get("name"),
                "durationSeconds": round(duration, 6),
                "channels": len(animation.get("channels", [])),
                "samplers": len(animation.get("samplers", [])),
                "targetBones": sorted(set(targets)),
                "paths": sorted(paths),
                "extras": animation.get("extras", {}),
            }
        )
    return result


def validate_character(path: Path) -> dict[str, Any]:
    document = glb_document(path)
    marker = document.get("asset", {}).get("extras", {}).get("chasingA1Animation")
    if not marker:
        raise ValueError(f"{path} is missing the reproducible A1 animation marker")
    skins = document.get("skins", [])
    if len(skins) != 1:
        raise ValueError(f"{path} must contain exactly one skin, got {len(skins)}")
    joint_names = [document["nodes"][index].get("name") for index in skins[0].get("joints", [])]
    if joint_names != EXPECTED_BONES:
        raise ValueError(f"{path} joint order changed: {joint_names}")
    clips = animation_report(document)
    clip_names = [clip["name"] for clip in clips]
    expected_names = [clip[0] for clip in CLIP_SPECS]
    if clip_names != expected_names:
        raise ValueError(f"{path} clips are {clip_names}, expected {expected_names}")
    for clip in clips:
        if clip["paths"] != ["rotation"]:
            raise ValueError(f"{path}/{clip['name']} contains non-rotation tracks: {clip['paths']}")
        if not clip["channels"]:
            raise ValueError(f"{path}/{clip['name']} has no animation channels")
        unknown = sorted(set(clip["targetBones"]) - set(EXPECTED_BONES))
        if unknown:
            raise ValueError(f"{path}/{clip['name']} targets unknown nodes: {unknown}")
    required = set(document.get("extensionsRequired", []))
    if "EXT_meshopt_compression" not in required:
        raise ValueError(f"{path} is missing required Meshopt compression")
    return {
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "skins": len(skins),
        "joints": len(joint_names),
        "meshes": len(document.get("meshes", [])),
        "animations": clips,
        "animationEncoding": marker,
        "animationBufferBytes": int(document["buffers"][0]["byteLength"]) - int(marker["baseBufferByteLength"]),
        "static": static_asset_report(path),
        "meshoptRequired": True,
    }


def blender_sample_animations(output: Path, report_path: Path) -> None:
    """Sample every FBX on its own armature against the canonical rig rest.

    FBX stores pose channels relative to the bind rest embedded in that file.
    The nine authored exports do not all carry the same bind matrices, despite
    sharing joint names. Moving their Actions onto one imported armature loses
    the authored first pose (for example Run becomes 0/68/0 degrees). Sampling
    each evaluated armature first preserves the absolute authored pose.
    """

    import bpy  # type: ignore[import-not-found]
    import math
    from mathutils import Matrix, Quaternion  # type: ignore[import-not-found]

    def reset_scene() -> None:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.context.scene.unit_settings.system = "METRIC"
        bpy.context.scene.unit_settings.scale_length = 1.0
        bpy.context.scene.render.fps = 30
        bpy.context.scene.render.fps_base = 1.0

    def import_armature(source: Path, *, use_anim: bool):
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.fbx(
            filepath=str(source),
            use_anim=use_anim,
            ignore_leaf_bones=False,
            automatic_bone_orientation=False,
        )
        imported = [item for item in bpy.context.scene.objects if item not in before]
        armatures = [item for item in imported if item.type == "ARMATURE"]
        if len(armatures) != 1:
            raise RuntimeError(f"{source} imported {len(armatures)} armatures, expected one")
        armature = armatures[0]
        names = [bone.name for bone in armature.data.bones]
        if names != EXPECTED_BONES:
            raise RuntimeError(f"{source} bone order changed: {names}")
        armature.data.pose_position = "POSE"
        return armature

    def rest_local_matrix(armature, bone) -> Matrix:
        if bone.parent is None:
            # The FBX axis conversion lives on the Armature object. Child-local
            # matrices cancel it through their parent, but the root must include
            # it or every non-turn clip inherits a spurious 90-degree Hips turn.
            return armature.matrix_world @ bone.matrix_local
        return bone.parent.matrix_local.inverted_safe() @ bone.matrix_local

    def pose_local_matrix(armature, pose_bone) -> Matrix:
        if pose_bone.parent is None:
            return armature.matrix_world @ pose_bone.matrix
        return pose_bone.parent.matrix.inverted_safe() @ pose_bone.matrix

    def xyzw(quaternion: Quaternion) -> list[float]:
        normalized = quaternion.normalized()
        return [float(normalized.x), float(normalized.y), float(normalized.z), float(normalized.w)]

    def angle_degrees(quaternion: Quaternion) -> float:
        normalized = quaternion.normalized()
        # q and -q represent the same rotation; abs(w) keeps the shortest arc.
        return math.degrees(2.0 * math.acos(max(-1.0, min(1.0, abs(float(normalized.w))))))

    def signed_euler_degrees(quaternion: Quaternion, axis: int) -> float:
        return math.degrees(float(quaternion.normalized().to_euler("XYZ")[axis]))

    def assert_near(label: str, actual: float, expected: float, tolerance: float) -> dict[str, float | str]:
        if abs(actual - expected) > tolerance:
            raise RuntimeError(
                f"Semantic animation gate failed for {label}: "
                f"actual={actual:.6f} degrees, expected={expected:.6f} +/- {tolerance:.6f}"
            )
        return {
            "label": label,
            "actualDegrees": round(actual, 6),
            "expectedDegrees": expected,
            "toleranceDegrees": tolerance,
        }

    if not CANONICAL_RIG.is_file():
        raise FileNotFoundError(CANONICAL_RIG)
    reset_scene()
    canonical_armature = import_armature(CANONICAL_RIG, use_anim=False)
    canonical_rest = {
        name: rest_local_matrix(canonical_armature, canonical_armature.data.bones[name])
        for name in EXPECTED_BONES
    }
    canonical_serialized = {
        name: [round(float(value), 9) for row in matrix for value in row]
        for name, matrix in canonical_rest.items()
    }
    canonical_hash = hashlib.sha256(
        json.dumps(canonical_serialized, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    sampled_clips: list[dict[str, Any]] = []
    source_reports: list[dict[str, Any]] = []
    sampled_by_name: dict[str, dict[str, Any]] = {}
    for clip_name, filename, loop in CLIP_SPECS:
        source = ANIMATION_ROOT / filename
        if not source.is_file():
            raise FileNotFoundError(source)
        # A factory reset is deliberate: each FBX must be evaluated against its
        # own armature/bind state, never against a previously imported Action.
        reset_scene()
        armature = import_armature(source, use_anim=True)
        action = armature.animation_data.action if armature.animation_data else None
        if action is None:
            raise RuntimeError(f"{source} imported without an animation action")
        start_float, end_float = [float(value) for value in action.frame_range]
        start = int(round(start_float))
        end = int(round(end_float))
        frames = list(range(start, end + 1))
        if not frames:
            raise RuntimeError(f"{source} has an empty frame range")
        tracks = {name: [] for name in EXPECTED_BONES}
        source_bind_delta_degrees: dict[str, float] = {}
        for name in EXPECTED_BONES:
            bind_delta = canonical_rest[name].inverted_safe() @ rest_local_matrix(
                armature, armature.data.bones[name]
            )
            source_bind_delta_degrees[name] = angle_degrees(bind_delta.to_quaternion())
        for frame in frames:
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            for name in EXPECTED_BONES:
                pose_local = pose_local_matrix(armature, armature.pose.bones[name])
                delta_matrix = canonical_rest[name].inverted_safe() @ pose_local
                tracks[name].append(xyzw(delta_matrix.to_quaternion()))

        if clip_name in {"TurnLeft", "TurnRight"}:
            first = Quaternion((tracks["Hips"][0][3], *tracks["Hips"][0][:3])).normalized()
            first_inverse = first.inverted()
            rebased = []
            for value in tracks["Hips"]:
                current = Quaternion((value[3], *value[:3])).normalized()
                rebased.append(xyzw(first_inverse @ current))
            tracks["Hips"] = rebased
        else:
            # The authored contract is root-motion off. Rig_Humanoid_Shared.fbx
            # was exported after authoring TurnRight and retains an incidental
            # root bind rotation, so its Hips rest is unsuitable as locomotion
            # motion. Non-turn clips therefore keep Hips at target rest; turn
            # clips above retain their authored relative yaw.
            tracks["Hips"] = [[0.0, 0.0, 0.0, 1.0] for _ in frames]

        # Stabilize quaternion signs before JSON serialization. This removes
        # q/-q discontinuities without changing any sampled orientation.
        for name, values in tracks.items():
            previous = None
            for index, value in enumerate(values):
                current = Quaternion((value[3], *value[:3])).normalized()
                if previous is not None and previous.dot(current) < 0.0:
                    current = -current
                    values[index] = xyzw(current)
                previous = current.copy()

        clip = {
            "name": clip_name,
            "source": source.relative_to(ROOT).as_posix(),
            "loop": loop,
            "fps": 30,
            "frames": frames,
            "times": [(frame - start) / 30.0 for frame in frames],
            "tracks": tracks,
        }
        sampled_clips.append(clip)
        sampled_by_name[clip_name] = clip
        source_reports.append(
            {
                "clip": clip_name,
                "source": source.relative_to(ROOT).as_posix(),
                "bytes": source.stat().st_size,
                "importedAction": action.name,
                "importedFrameRange": [start_float, end_float],
                "sampleCount": len(frames),
                "fps": 30,
                "loop": loop,
                "rootMotion": False,
                "bones": len(EXPECTED_BONES),
                "sourceBindVsCanonicalMaxDegrees": round(max(source_bind_delta_degrees.values()), 6),
                "sourceBindVsCanonicalByBoneDegrees": {
                    name: round(value, 6)
                    for name, value in source_bind_delta_degrees.items()
                    if value > 0.001
                },
                "sampling": (
                    "poseLocal = inverse(parentPose) * pose "
                    "(root: armatureWorld * pose); delta = inverse(canonicalRestLocal) * poseLocal"
                ),
                "rootPolicy": (
                    "Turn Hips is rebased to its first sample; all other Hips deltas are identity "
                    "because the authored clips are root-motion off"
                ),
            }
        )

    def sampled_quaternion(clip_name: str, bone_name: str, index: int) -> Quaternion:
        value = sampled_by_name[clip_name]["tracks"][bone_name][index]
        return Quaternion((value[3], *value[:3])).normalized()

    semantic_checks: list[dict[str, float | str]] = []
    for clip_name, expected in (
        ("Run", (-34.0, 34.0, -34.0)),
        ("Walk", (-15.3, 15.3, -15.3)),
    ):
        indices = (0, 9, 19) if clip_name == "Run" else (0, 19, 39)
        for label, index, degrees in zip(("first", "middle", "last"), indices, expected):
            actual = signed_euler_degrees(sampled_quaternion(clip_name, "LeftUpperLeg", index), 0)
            semantic_checks.append(assert_near(f"{clip_name}.LeftUpperLeg.{label}.x", actual, degrees, 0.35))
    for label, index, degrees in zip(("first", "middle", "last"), (0, 44, 89), (-28.0, 28.0, -28.0)):
        actual = signed_euler_degrees(sampled_quaternion("LookAround", "Head", index), 2)
        semantic_checks.append(assert_near(f"LookAround.Head.{label}.z", actual, degrees, 0.35))
    for clip_name, bone_name, indices, expected in (
        ("ScaredCaught", "LeftUpperArm", (0, 17, 35), (0.0, 74.4, 89.3)),
        ("Celebrate", "LeftUpperArm", (0, 19, 39), (40.0, 125.8, 110.4)),
        ("PointAlert", "RightUpperArm", (0, 17, 41), (4.0, 2.83, 2.83)),
    ):
        for label, index, degrees in zip(("first", "middle", "last"), indices, expected):
            actual = angle_degrees(sampled_quaternion(clip_name, bone_name, index))
            semantic_checks.append(assert_near(f"{clip_name}.{bone_name}.{label}.magnitude", actual, degrees, 0.75))
    for clip_name, expected in (("TurnLeft", (0.0, -45.0, -90.0)), ("TurnRight", (0.0, 45.0, 90.0))):
        for label, index, degrees in zip(("first", "middle", "last"), (0, 11, 23), expected):
            actual = signed_euler_degrees(sampled_quaternion(clip_name, "Hips", index), 2)
            semantic_checks.append(assert_near(f"{clip_name}.Hips.{label}.z", actual, degrees, 0.35))

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "schema": "chasing-canonical-rest-animation-deltas-v1",
                "canonicalRig": CANONICAL_RIG.relative_to(ROOT).as_posix(),
                "canonicalRestSha256": canonical_hash,
                "bones": EXPECTED_BONES,
                "clips": sampled_clips,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(
            {
                "canonicalRig": {
                    "source": CANONICAL_RIG.relative_to(ROOT).as_posix(),
                    "bytes": CANONICAL_RIG.stat().st_size,
                    "bones": len(EXPECTED_BONES),
                    "restLocalSha256": canonical_hash,
                },
                "sources": source_reports,
                "semanticChecks": semantic_checks,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def blender_mode(argv: list[str]) -> bool:
    if "--blender-sample" not in argv:
        return False
    parser = argparse.ArgumentParser()
    parser.add_argument("--blender-sample", type=Path, required=True)
    parser.add_argument("--blender-report", type=Path, required=True)
    options = parser.parse_args(argv)
    blender_sample_animations(options.blender_sample, options.blender_report)
    return True


def build(report_path: Path, base_ref: str | None = None) -> dict[str, Any]:
    blender = shutil.which("blender")
    node = shutil.which("node")
    if not blender:
        raise FileNotFoundError("Blender is required to import the authored FBX files")
    if not node:
        raise FileNotFoundError("Node.js is required for Three.js skeleton retargeting")
    if not EMBED_SCRIPT.is_file():
        raise FileNotFoundError(EMBED_SCRIPT)
    if runtime_glb_count(MODELS_ROOT) != EXPECTED_RUNTIME_GLB_COUNT:
        raise RuntimeError(
            f"Expected {EXPECTED_RUNTIME_GLB_COUNT} runtime GLBs before A1, "
            f"got {runtime_glb_count(MODELS_ROOT)}"
        )
    character_paths = [CHARACTER_ROOT / f"{name}.glb" for name in CHARACTERS]
    missing = [path for path in character_paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Missing runtime characters: {missing}")

    input_before = {
        path.stem: {"bytes": path.stat().st_size, "sha256": sha256(path)}
        for path in character_paths
    }
    input_has_a1 = all(
        bool(
            glb_document(path)
            .get("asset", {})
            .get("extras", {})
            .get("chasingA1Animation")
        )
        for path in character_paths
    )
    public_input = directory_bytes(MODELS_ROOT)
    previous_report = None
    if report_path.is_file():
        candidate = json.loads(report_path.read_text(encoding="utf-8"))
        if candidate.get("asset") == "A1_true_animation_runtime":
            previous_report = candidate
    before = {
        name: (
            previous_report["characters"][name]["before"]
            if previous_report
            else input_before[name]
        )
        for name in CHARACTERS
    }
    public_before = (
        int(previous_report["budget"]["publicModelsBeforeBytes"])
        if previous_report
        else public_input
    )
    static_baseline_ref = base_ref or (
        previous_report.get("pipeline", {}).get("staticBaselineRef")
        or previous_report.get("pipeline", {}).get("baseRef")
        if previous_report
        else None
    )

    with tempfile.TemporaryDirectory(prefix="chasing-a1-animation-") as temporary:
        stage = Path(temporary)
        source_character_paths = character_paths
        if base_ref:
            base_dir = stage / "base-characters"
            base_dir.mkdir(parents=True, exist_ok=True)
            source_character_paths = []
            for character_path in character_paths:
                relative = character_path.relative_to(ROOT)
                base_path = base_dir / character_path.name
                base_path.write_bytes(git_blob(base_ref, relative))
                source_character_paths.append(base_path)
            before = {
                path.stem: {"bytes": path.stat().st_size, "sha256": sha256(path)}
                for path in source_character_paths
            }
            public_before = public_input - sum(item["bytes"] for item in input_before.values()) + sum(
                item["bytes"] for item in before.values()
            )
        sampled_deltas = stage / "canonical-animation-deltas.json"
        blender_report = stage / "fbx-import-report.json"
        run(
            [
                blender,
                "--background",
                "--factory-startup",
                "--python",
                str(Path(__file__).resolve()),
                "--",
                "--blender-sample",
                str(sampled_deltas),
                "--blender-report",
                str(blender_report),
            ],
            capture=True,
        )
        sampled_document = json.loads(sampled_deltas.read_text(encoding="utf-8"))
        source_clip_names = [clip.get("name") for clip in sampled_document.get("clips", [])]
        expected_source_names = [clip[0] for clip in CLIP_SPECS]
        if source_clip_names != expected_source_names:
            raise RuntimeError(f"Sampled clip mismatch: {source_clip_names}")

        embedded_dir = stage / "embedded"
        embed_result = run(
            [
                node,
                str(EMBED_SCRIPT),
                "--samples",
                str(sampled_deltas),
                "--output-dir",
                str(embedded_dir),
                "--characters",
                ",".join(str(path) for path in source_character_paths),
            ],
            capture=True,
        )
        retarget_report = json.loads(embed_result.stdout)

        validator_module, validator_package = prepare_official_validator(stage)
        staged_outputs = [embedded_dir / f"{name}.glb" for name in CHARACTERS]
        staged_validation = {}
        static_invariance = {}
        official_validation = {}
        baseline_validation = {}
        for name, source_path, destination in zip(CHARACTERS, source_character_paths, staged_outputs):
            staged_validation[name] = validate_character(destination)
            before_static = static_asset_report(source_path)
            after_static = staged_validation[name]["static"]
            if before_static != after_static:
                raise RuntimeError(
                    f"A1 changed static geometry/material/image data for {name}: "
                    f"before={before_static}, after={after_static}"
                )
            static_invariance[name] = {"before": before_static, "after": after_static, "exact": True}
            official_validation[name] = validate_official(destination, validator_module)
            prior_baseline = (
                previous_report.get("characters", {}).get(name, {}).get("baselineGltfValidator")
                if previous_report and not base_ref
                else None
            )
            baseline_validation[name] = prior_baseline or validate_official(source_path, validator_module)
            before_warning_signature = [
                (warning["code"], warning["count"])
                for warning in baseline_validation[name]["warnings"]
            ]
            after_warning_signature = [
                (warning["code"], warning["count"])
                for warning in official_validation[name]["warnings"]
            ]
            if before_warning_signature != after_warning_signature:
                raise RuntimeError(
                    f"A1 introduced validator warnings for {name}: "
                    f"before={before_warning_signature}, after={after_warning_signature}"
                )

        projected_total = public_input - sum(item["bytes"] for item in input_before.values()) + sum(
            path.stat().st_size for path in staged_outputs
        )
        if projected_total > MAX_PUBLIC_MODELS_BYTES:
            raise RuntimeError(
                f"A1 would grow public/models to {projected_total} bytes, over the "
                f"{MAX_PUBLIC_MODELS_BYTES}-byte budget"
            )
        if runtime_glb_count(MODELS_ROOT) != EXPECTED_RUNTIME_GLB_COUNT:
            raise RuntimeError("Runtime GLB count changed while staging A1")

        idempotent_rerun = all(
            input_before[name]["sha256"] == staged_validation[name]["sha256"]
            for name in CHARACTERS
        )
        if input_has_a1 and not base_ref and not idempotent_rerun:
            raise RuntimeError(
                "A1 pipeline is not idempotent: rebuilding an existing A1 asset changed its hash"
            )

        first_screen_input = first_screen_report(MODELS_ROOT)
        staged_blocking_character_bytes = sum(
            staged_validation[name]["bytes"] for name in ("kid", "villain")
        )
        current_blocking_character_bytes = sum(
            input_before[name]["bytes"] for name in ("kid", "villain")
        )
        blocking_character_delta = staged_blocking_character_bytes - sum(
            before[name]["bytes"] for name in ("kid", "villain")
        )
        projected_first_screen_bytes = (
            first_screen_input["totalBytes"]
            - current_blocking_character_bytes
            + staged_blocking_character_bytes
        )
        projected_from_independent_baseline = (
            INDEPENDENT_FIRST_SCREEN_BASELINE_BYTES + blocking_character_delta
        )
        if max(projected_first_screen_bytes, projected_from_independent_baseline) > MAX_FIRST_SCREEN_BYTES:
            raise RuntimeError(
                f"A1 would grow the first screen to {projected_first_screen_bytes} bytes "
                f"(independent-baseline projection {projected_from_independent_baseline}), over the "
                f"{MAX_FIRST_SCREEN_BYTES}-byte budget"
            )

        for staged in staged_outputs:
            shutil.copyfile(staged, CHARACTER_ROOT / staged.name)

        public_after = directory_bytes(MODELS_ROOT)
        if public_after != projected_total:
            raise RuntimeError(f"Projected {projected_total} bytes but wrote {public_after}")
        if runtime_glb_count(MODELS_ROOT) != EXPECTED_RUNTIME_GLB_COUNT:
            raise RuntimeError("A1 changed the runtime GLB file count")
        first_screen = first_screen_report(MODELS_ROOT)
        if first_screen["totalBytes"] != projected_first_screen_bytes:
            raise RuntimeError(
                f"Projected first screen {projected_first_screen_bytes} bytes but wrote "
                f"{first_screen['totalBytes']}"
            )
        first_screen["independentBaselineBytes"] = INDEPENDENT_FIRST_SCREEN_BASELINE_BYTES
        first_screen["projectedFromIndependentBaselineBytes"] = projected_from_independent_baseline

        fbx_import = json.loads(blender_report.read_text(encoding="utf-8"))
        after = {name: validate_character(CHARACTER_ROOT / f"{name}.glb") for name in CHARACTERS}
        report = {
            "asset": "A1_true_animation_runtime",
            "pipeline": {
                "blender": run([blender, "--version"], capture=True).stdout.splitlines()[0],
                "retarget": (
                    "Blender independently samples each FBX: inverse(canonicalRestLocal) * poseLocal; "
                    "encoder writes targetRest * delta"
                ),
                "compression": (
                    "preserve original Meshopt geometry payload; rotation-only tracks; "
                    "constant-track removal; 0.001-radian quaternion RDP key reduction"
                ),
                "fps": 30,
                "rootMotion": False,
                "retargetedProperties": ["rotation"],
                "baseRef": base_ref,
                "staticBaselineRef": static_baseline_ref,
                "idempotentRerun": idempotent_rerun,
                "validator": validator_package,
            },
            "canonicalRig": fbx_import["canonicalRig"],
            "sources": fbx_import["sources"],
            "sourceSemanticChecks": fbx_import["semanticChecks"],
            "temporarySamples": {
                "bytes": sampled_deltas.stat().st_size,
                "clips": expected_source_names,
                "bones": len(sampled_document.get("bones", [])),
                "schema": sampled_document.get("schema"),
                "canonicalRestSha256": sampled_document.get("canonicalRestSha256"),
            },
            "retarget": retarget_report,
            "characters": {
                name: {
                    "before": before[name],
                    "pipelineInput": input_before[name],
                    "after": after[name],
                    "staticInvariance": static_invariance[name],
                    "baselineGltfValidator": baseline_validation[name],
                    "gltfValidator": official_validation[name],
                    "noNewValidatorWarnings": True,
                    "idempotentInputMatchesOutput": input_before[name]["sha256"] == after[name]["sha256"],
                    "deltaBytes": after[name]["bytes"] - before[name]["bytes"],
                }
                for name in CHARACTERS
            },
            "budget": {
                "runtimeGlbCount": runtime_glb_count(MODELS_ROOT),
                "publicModelsBeforeBytes": public_before,
                "publicModelsPipelineInputBytes": public_input,
                "publicModelsAfterBytes": public_after,
                "publicModelsLimitBytes": MAX_PUBLIC_MODELS_BYTES,
                "publicModelsHeadroomBytes": MAX_PUBLIC_MODELS_BYTES - public_after,
                "blockingCharacterBytes": after["kid"]["bytes"] + after["villain"]["bytes"],
                "blockingCharacterDeltaBytes": (
                    blocking_character_delta
                ),
                "firstScreen": first_screen,
            },
        }

    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--base-ref",
        help="Read animation-free character GLBs from this git ref (migration/recovery only).",
    )
    return parser.parse_args()


def main() -> None:
    passthrough = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    if blender_mode(passthrough):
        return
    options = parse_args()
    report = build(options.report.resolve(), options.base_ref)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
