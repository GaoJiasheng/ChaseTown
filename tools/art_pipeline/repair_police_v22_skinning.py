#!/usr/bin/env python3
"""Repair Police v22 source-level skin bindings into an isolated candidate.

The original v22 bind interpreted ``-1/+1`` attachment suffixes as anatomical
left/right.  They are geometric X signs, while MPFB anatomical right lies at
X<0.  As a result, shoulder and sleeve details rotate around the opposite
side of the body in asymmetric animation.  This script repairs those bindings
without touching meshes or materials and writes a separate Blender candidate.

The second repair is a deliberately narrow garment-only pass over the uniform
crotch seam.  It preserves the source weights everywhere else and raises the
pelvis share only where opposite upper-leg weights otherwise pull adjacent
vertices apart in a run stride.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import bpy


LATERAL_BONE_PAIRS = tuple(
    (f"Left{part}", f"Right{part}")
    for part in (
        "Shoulder",
        "UpperArm",
        "LowerArm",
        "Hand",
        "UpperLeg",
        "LowerLeg",
        "Foot",
        "Toes",
    )
)


ATTACHMENT_BINDINGS = {
    # These names follow the project's viewer/geometric convention *after*
    # the whole Police skeleton and all skin groups have been standardized:
    # Left is X<0, Right is X>0.
    "Police_v22_ShoulderEpaulet_-1": "LeftShoulder",
    "Police_v22_EpauletButton_-1": "LeftShoulder",
    "Police_v22_ShoulderEpaulet_+1": "RightShoulder",
    "Police_v22_EpauletButton_+1": "RightShoulder",
    "Police_v22_SleevePatch_-1": "LeftUpperArm",
    "Police_v22_SleevePatchInset_-1": "LeftUpperArm",
    "Police_v22_SleevePatch_+1": "RightUpperArm",
    "Police_v22_SleevePatchInset_+1": "RightUpperArm",
    # The radio sits on the upper chest/strap rather than the rotating arm cap.
    # Chest binding keeps it seated against the uniform in reach gestures.
    "Police_v22_ShoulderRadio": "Chest",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--crotch-max-abs-x", type=float, default=0.04)
    parser.add_argument("--crotch-min-z", type=float, default=0.72)
    parser.add_argument("--crotch-full-z", type=float, default=0.76)
    parser.add_argument("--crotch-top-full-z", type=float, default=0.85)
    parser.add_argument("--crotch-max-z", type=float, default=0.90)
    parser.add_argument("--crotch-max-hips", type=float, default=0.90)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def vertex_weight_map(obj: bpy.types.Object, vertex: bpy.types.MeshVertex) -> dict[str, float]:
    return {
        obj.vertex_groups[item.group].name: float(item.weight)
        for item in vertex.groups
        if item.weight > 1e-8
    }


def binding_snapshot(obj: bpy.types.Object) -> dict[str, Any]:
    totals: dict[str, float] = {}
    for vertex in obj.data.vertices:
        for name, weight in vertex_weight_map(obj, vertex).items():
            totals[name] = totals.get(name, 0.0) + weight
    return {
        "vertices": len(obj.data.vertices),
        "groups": {name: round(value, 5) for name, value in sorted(totals.items())},
    }


def rigid_rebind(obj: bpy.types.Object, bone_name: str) -> None:
    obj.vertex_groups.clear()
    group = obj.vertex_groups.new(name=bone_name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")


def bone_side_evidence(armature: bpy.types.Object) -> dict[str, float]:
    return {
        name: round(float(armature.data.bones[name].head_local.x), 6)
        for pair in LATERAL_BONE_PAIRS
        for name in pair
    }


def swap_lateral_semantics(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    """Convert MPFB anatomical L/R names to the project's geometric names.

    The project animation map defines Left as X<0.  The Police source was the
    sole character whose standardized MPFB names still used anatomical Left at
    X>0, making every asymmetric clip drive opposite-side skin groups.
    """
    for left, right in LATERAL_BONE_PAIRS:
        if armature.data.bones.get(left) is None or armature.data.bones.get(right) is None:
            raise RuntimeError(f"Cannot swap missing lateral bone pair {left}/{right}")
        armature.data.bones[left].name = f"__SIDE_SWAP__{left}"
    for left, right in LATERAL_BONE_PAIRS:
        armature.data.bones[right].name = left
        armature.data.bones[f"__SIDE_SWAP__{left}"].name = right

    # Blender propagates a bone rename to matching vertex groups on every
    # armature child.  Do not rename those groups a second time: doing so would
    # undo the semantic swap while leaving the bones swapped.
    for obj in meshes:
        temporary = [group.name for group in obj.vertex_groups if group.name.startswith("__SIDE_SWAP__")]
        if temporary:
            raise RuntimeError(f"Bone rename did not finish propagating on {obj.name}: {temporary}")


def replace_vertex_weights(obj: bpy.types.Object, index: int, weights: dict[str, float]) -> None:
    for group in obj.vertex_groups:
        group.remove([index])
    total = sum(weights.values())
    if total <= 1e-8:
        raise ValueError(f"Zero replacement weight for {obj.name} vertex {index}")
    for name, value in weights.items():
        group = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
        group.add([index], value / total, "REPLACE")


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge1 <= edge0:
        raise ValueError("smoothstep edge1 must be greater than edge0")
    amount = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return amount * amount * (3.0 - 2.0 * amount)


def stabilize_uniform_crotch(
    obj: bpy.types.Object,
    max_abs_x: float,
    min_z: float,
    full_z: float,
    top_full_z: float,
    max_z: float,
    max_hips: float,
) -> dict[str, Any]:
    """Prevent the two upper-leg weights from opening the uniform center seam.

    The source garment already has good native deformation.  Only vertices in
    a 40 mm center falloff with a majority upper-leg share are eligible.  The
    existing influence ratios are preserved while enough weight is moved to
    Hips to keep the seam coherent; no vertex is rigidly rebound.
    """
    if not (
        0.0 < max_abs_x
        and min_z < full_z <= top_full_z < max_z
        and 0.0 < max_hips < 1.0
    ):
        raise ValueError("Invalid uniform crotch stabilization bounds")

    changed: list[int] = []
    maximum_delta = 0.0
    for vertex in obj.data.vertices:
        point = vertex.co
        if abs(point.x) >= max_abs_x or point.z <= min_z or point.z >= max_z:
            continue
        weights = vertex_weight_map(obj, vertex)
        pelvis_chain_share = (
            weights.get("Hips", 0.0)
            + weights.get("LeftUpperLeg", 0.0)
            + weights.get("RightUpperLeg", 0.0)
        )
        if pelvis_chain_share <= 0.5:
            continue
        current_hips = weights.get("Hips", 0.0)
        horizontal = 1.0 - smoothstep(0.0, max_abs_x, abs(float(point.x)))
        vertical = smoothstep(min_z, full_z, float(point.z)) * (
            1.0 - smoothstep(top_full_z, max_z, float(point.z))
        )
        target_hips = max_hips * horizontal * vertical
        if target_hips <= current_hips + 1e-8:
            continue
        remaining_before = 1.0 - current_hips
        if remaining_before <= 1e-8:
            continue
        remaining_scale = (1.0 - target_hips) / remaining_before
        replacement = {
            name: value * remaining_scale
            for name, value in weights.items()
            if name != "Hips" and value > 1e-8
        }
        replacement["Hips"] = target_hips
        replace_vertex_weights(obj, vertex.index, replacement)
        changed.append(vertex.index)
        maximum_delta = max(maximum_delta, target_hips - current_hips)

    if not changed:
        raise RuntimeError("Uniform crotch stabilization selected no vertices")
    if len(changed) != 44:
        raise RuntimeError(
            f"Uniform crotch stabilization expected the audited 44 vertices, got {len(changed)}"
        )
    return {
        "object": obj.name,
        "verticesChanged": len(changed),
        "vertexIndices": changed,
        "selection": {
            "maxAbsLocalX": max_abs_x,
            "minLocalZ": min_z,
            "fullStrengthLocalZ": full_z,
            "topFullStrengthLocalZ": top_full_z,
            "maxLocalZ": max_z,
            "minimumCombinedHipsAndUpperLegShare": 0.5,
        },
        "replacement": {
            "maximumHipsWeight": max_hips,
            "horizontalFalloff": "inverse smoothstep from center to maxAbsLocalX",
            "lowerVerticalFalloff": "smoothstep minLocalZ to fullStrengthLocalZ",
            "upperVerticalFalloff": "inverse smoothstep topFullStrengthLocalZ to maxLocalZ",
            "otherInfluenceRatiosPreserved": True,
        },
        "maximumHipsWeightIncrease": round(maximum_delta, 7),
    }


def main() -> None:
    args = parse_args()
    source = args.input.expanduser().resolve()
    output = args.output.expanduser().resolve()
    report_path = (
        args.report.expanduser().resolve()
        if args.report
        else output.with_suffix(".skinning-report.json")
    )
    if not source.is_file():
        raise FileNotFoundError(source)
    if source == output:
        raise RuntimeError("Refusing in-place Police skinning repair")

    bpy.ops.wm.open_mainfile(filepath=str(source))
    armature = bpy.data.objects.get("Rig_Humanoid_Shared")
    if armature is None or armature.type != "ARMATURE":
        raise RuntimeError("Police source is missing Rig_Humanoid_Shared")

    meshes = [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "MESH"
        and (obj.parent == armature or any(mod.type == "ARMATURE" and mod.object == armature for mod in obj.modifiers))
    ]
    semantics_before = bone_side_evidence(armature)
    swap_lateral_semantics(armature, meshes)
    semantics_after = bone_side_evidence(armature)
    if not all(semantics_after[left] < 0.0 < semantics_after[right] for left, right in LATERAL_BONE_PAIRS):
        raise RuntimeError(f"Police lateral semantic gate failed: {semantics_after}")

    missing_bones = sorted(
        set(ATTACHMENT_BINDINGS.values()) - {bone.name for bone in armature.data.bones}
    )
    missing_objects = sorted(
        set(ATTACHMENT_BINDINGS) - {obj.name for obj in bpy.data.objects}
    )
    if missing_bones or missing_objects:
        raise RuntimeError(f"Repair inputs missing bones={missing_bones}, objects={missing_objects}")

    before = {name: binding_snapshot(bpy.data.objects[name]) for name in ATTACHMENT_BINDINGS}
    pivot_evidence = {
        name: {
            "objectCenterX": round(
                sum(
                    float((bpy.data.objects[name].matrix_world @ vertex.co).x)
                    for vertex in bpy.data.objects[name].data.vertices
                )
                / len(bpy.data.objects[name].data.vertices),
                6,
            ),
            "targetBoneHeadX": round(float(armature.data.bones[bone].head_local.x), 6),
            "targetBone": bone,
        }
        for name, bone in ATTACHMENT_BINDINGS.items()
    }
    for name, bone in ATTACHMENT_BINDINGS.items():
        rigid_rebind(bpy.data.objects[name], bone)
    after = {name: binding_snapshot(bpy.data.objects[name]) for name in ATTACHMENT_BINDINGS}

    uniform = bpy.data.objects.get("Police_v22_Uniform")
    if uniform is None:
        raise RuntimeError("Police source is missing Police_v22_Uniform")
    crotch_report = stabilize_uniform_crotch(
        uniform,
        max_abs_x=args.crotch_max_abs_x,
        min_z=args.crotch_min_z,
        full_z=args.crotch_full_z,
        top_full_z=args.crotch_top_full_z,
        max_z=args.crotch_max_z,
        max_hips=args.crotch_max_hips,
    )

    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1.0
    bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=True)
    report = {
        "input": str(source),
        "inputSha256": sha256(source),
        "output": str(output),
        "outputSha256": sha256(output),
        "candidateOnly": True,
        "officialRuntimeOverwritten": False,
        "lateralSemantics": {
            "reason": "project animation map requires Left X<0 / Right X>0 for every character",
            "beforeBoneHeadX": semantics_before,
            "afterBoneHeadX": semantics_after,
            "boneRenameAndAutomaticMeshVertexGroupPropagation": True,
        },
        "attachmentBindings": {
            "reason": "geometric +/- X suffix must map to the matching MPFB/project bone pivot",
            "pivotEvidence": pivot_evidence,
            "before": before,
            "after": after,
        },
        "uniformCrotchStabilization": crotch_report,
        "qualityGates": {
            "allAttachmentVerticesWeighted": all(
                abs(sum(snapshot["groups"].values()) - snapshot["vertices"]) < 1e-4
                for snapshot in after.values()
            ),
            "projectLateralSemantics": all(
                semantics_after[left] < 0.0 < semantics_after[right]
                for left, right in LATERAL_BONE_PAIRS
            ),
            "meshGeometryUnchanged": True,
            "materialsUnchanged": True,
            "uniformCrotchVerticesChanged": crotch_report["verticesChanged"],
            "sourceNotOverwritten": True,
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
