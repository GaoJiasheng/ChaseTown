#!/usr/bin/env python3
"""Bind the three PrecisionRemodel v21 characters to the shared Humanoid rig."""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

import rig_approved_character_candidates as rig


SPECS = [
    {
        "role": role,
        "style": "ReferenceStandard",
        "source": f"art-source/Characters/{role}/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/{role}_PrecisionRemodel_v21.fbx",
        "output_name": f"{role}_PrecisionRemodel_v21_Rigged",
    }
    for role in ("Kid", "Villain", "Police")
]


def quality_note(summaries: list[rig.PrimitiveWeightSummary]) -> str:
    rigid = sum(1 for item in summaries if item.mode == "rigid_single_bone")
    blended = sum(1 for item in summaries if item.mode == "heuristic_humanoid_blend")
    return (
        f"{blended} mesh primitives use position-based Humanoid blended weights; "
        f"{rigid} small accessory primitives are rigid-bound to one anatomical bone. "
        "The deterministic Assimp/glTF path preserves one shared 21-joint skeleton and "
        "is verified again after FBX export."
    )


def select_specs(only: str | None) -> list[dict[str, str]]:
    if not only:
        return SPECS
    requested = {item.strip().lower() for item in only.split(",") if item.strip()}
    selected = [spec for spec in SPECS if spec["role"].lower() in requested]
    if not selected:
        raise ValueError(f"No v21 roles matched --only {only!r}")
    return selected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Comma-separated role names")
    parser.add_argument("--keep-intermediate", action="store_true")
    args = parser.parse_args()
    if not shutil.which("assimp"):
        raise RuntimeError("assimp command is required")

    rig.RIG_OUTPUT_DIR = "PrecisionRemodel_2026_07_13_v21/Rigged"
    rig.report_note = quality_note
    with tempfile.TemporaryDirectory(prefix="rig_precision_v21_") as tmp_name:
        rig_gltf = rig.load_rig_gltf(Path(tmp_name))
        reports = [
            rig.process_spec(spec, rig_gltf, only_validate=args.keep_intermediate)
            for spec in select_specs(args.only)
        ]
    print(json.dumps({"processed": [report["output_fbx"] for report in reports]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
