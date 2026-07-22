#!/usr/bin/env python3
"""Bake a production role clip set onto an isolated rigged candidate.

This wrapper reuses the production retarget implementation and clip contract
without changing the approved role declaration or overwriting
``public/models/characters/police.glb``.  It is suitable for comparing v21,
v22 skinning repairs, or future source-level bind candidates.

Run with Blender::

    blender --background --factory-startup \
      --python tools/art_pipeline/build_police_animation_candidate.py -- \
      --source-blend /tmp/police-rig-repaired.blend \
      --output /tmp/police-rig-repaired-animated.glb
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import build_web_character_animation_sets as animation_builder  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=tuple(animation_builder.ROLE_SPECS), default="police")
    parser.add_argument("--source-blend", type=Path, required=True)
    parser.add_argument("--source-generation", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--source-glb", type=Path)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    source_blend = args.source_blend.expanduser().resolve()
    output = args.output.expanduser().resolve()
    report = (
        args.report.expanduser().resolve()
        if args.report
        else output.with_suffix(".animation-report.json")
    )
    if not source_blend.is_file():
        raise FileNotFoundError(source_blend)
    if output == (ROOT / f"public/models/characters/{args.role}.glb").resolve():
        raise RuntimeError(f"Candidate wrapper refuses to overwrite the official {args.role} GLB")

    source_motion = animation_builder.ensure_motion_source(args.source_glb)
    production = animation_builder.ROLE_SPECS[args.role]
    candidate = animation_builder.RoleSpec(
        key=args.role,
        source_blend=source_blend,
        output_glb=output,
        clips=production.clips,
    )

    # build_role writes a fixed police_web_animation_set.json.  Redirect that
    # side effect to the candidate directory, then preserve the requested
    # report name for deterministic QA tooling.
    animation_builder.REPORT_DIR = report.parent
    # The production report normally stores a repository-relative output.  A
    # candidate intentionally lives outside the repository, so give the report
    # formatter a common absolute ancestor without changing any resolved input
    # or output path in the RoleSpec above.
    animation_builder.ROOT = Path("/")
    result = animation_builder.build_role(candidate, source_motion, make_preview=False)
    generated_report = report.parent / f"{args.role}_web_animation_set.json"
    if generated_report != report:
        generated_report.replace(report)
    result["candidateOnly"] = True
    result["sourceBlend"] = str(source_blend)
    result["sourceGeneration"] = args.source_generation
    result["officialRuntimeOverwritten"] = False
    report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Candidate animation report: {report}")


if __name__ == "__main__":
    main()
