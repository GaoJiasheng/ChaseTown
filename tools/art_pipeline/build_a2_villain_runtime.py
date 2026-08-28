#!/usr/bin/env python3
"""Rebuild and optionally install the complete A2 villain asset.

The checked-in high-source Blender master is never overwritten. The command
builds a cleaned high-resolution rigged master, simplifies it with
meshoptimizer while preserving floating-point positions (root scale remains
one), compresses geometry, regenerates the nine A1 animation samples, embeds
the clips, verifies budgets, then atomically installs the runtime GLB and the
cleaned Rigged/ authoring master.

Typical release command::

    python3 tools/art_pipeline/build_a2_villain_runtime.py --install
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PIPELINE_ROOT = Path(__file__).resolve().parent
ASSET_ROOT = ROOT / "art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21"
RUNTIME_GLB = ROOT / "public/models/characters/villain.glb"
RIGGED_MASTER = ASSET_ROOT / "Rigged/Villain_PrecisionRemodel_v21_Rigged.blend"
BUILD_REPORT = ASSET_ROOT / "Reports/Villain_A2_visual_rework_build_report.json"
EVIDENCE_DIR = ASSET_ROOT / "Reports/A2_Villain_2026_08_28/evidence"
GLTFPACK = PIPELINE_ROOT / "vendor/gltfpack/cli.js"
BUILD_SCRIPT = PIPELINE_ROOT / "build_a2_villain_visual_rework.py"
ANIMATION_SCRIPT = PIPELINE_ROOT / "build_character_animation_assets.py"
EMBED_SCRIPT = PIPELINE_ROOT / "embed_character_animations.mjs"
VALIDATOR_SCRIPT = PIPELINE_ROOT / "run_gltf_validator.mjs"

SIMPLIFY_RATIO = 0.215
MAX_CHARACTER_BYTES = 2_500_000
MAX_PUBLIC_MODELS_BYTES = 12_000_000
MIN_RUNTIME_TRIANGLES = 20_000
MAX_RUNTIME_TRIANGLES = 32_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="Atomically replace the checked-in rigged master and runtime GLB")
    parser.add_argument("--blender", default=shutil.which("blender") or "blender")
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--preview-dir", type=Path, default=EVIDENCE_DIR)
    parser.add_argument("--report", type=Path, default=BUILD_REPORT)
    return parser.parse_args()


def run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def public_models_bytes(replacement: Path) -> int:
    current = sum(path.stat().st_size for path in (ROOT / "public/models").rglob("*") if path.is_file())
    return current - RUNTIME_GLB.stat().st_size + replacement.stat().st_size


def atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    staged = destination.with_suffix(destination.suffix + ".a2-staged")
    shutil.copy2(source, staged)
    staged.replace(destination)


def main() -> None:
    options = parse_args()
    preview_dir = options.preview_dir if options.preview_dir.is_absolute() else ROOT / options.preview_dir
    report_path = options.report if options.report.is_absolute() else ROOT / options.report

    with tempfile.TemporaryDirectory(prefix="chasing-a2-villain-") as temporary:
        stage = Path(temporary)
        high_blend = stage / "Villain_A2_high.blend"
        high_static = stage / "villain-high-static.glb"
        high_report = stage / "high-build-report.json"
        simplified = stage / "villain-simplified.glb"
        simplify_report = stage / "simplify-report.json"
        packed = stage / "villain-packed.glb"
        pack_report = stage / "pack-report.json"
        samples = stage / "animation-samples.json"
        sample_report = stage / "animation-sample-report.json"
        embedded_dir = stage / "embedded"

        run([
            options.blender,
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(BUILD_SCRIPT),
            "--",
            "--output-blend",
            str(high_blend),
            "--output-glb",
            str(high_static),
            "--report",
            str(high_report),
            "--preview-dir",
            str(preview_dir),
        ])

        shared_gltfpack = ["-kn", "-km", "-ke", "-kv", "-gt", "-vpf", "-vt", "12", "-vn", "10"]
        run([
            options.node,
            str(GLTFPACK),
            "-i",
            str(high_static),
            "-o",
            str(simplified),
            *shared_gltfpack,
            "-si",
            str(SIMPLIFY_RATIO),
            "-r",
            str(simplify_report),
        ])
        run([
            options.node,
            str(GLTFPACK),
            "-i",
            str(simplified),
            "-o",
            str(packed),
            "-c",
            *shared_gltfpack,
            "-r",
            str(pack_report),
        ])

        run([
            options.blender,
            "--background",
            "--python-exit-code",
            "1",
            "--python",
            str(ANIMATION_SCRIPT),
            "--",
            "--blender-sample",
            str(samples),
            "--blender-report",
            str(sample_report),
        ])
        run([
            options.node,
            str(EMBED_SCRIPT),
            "--samples",
            str(samples),
            "--output-dir",
            str(embedded_dir),
            "--characters",
            str(packed),
        ])
        final_glb = embedded_dir / packed.name
        if not final_glb.is_file():
            raise RuntimeError(f"Animation embed did not create {final_glb}")

        # Reuse the A1 pipeline's pinned, integrity-checked official Validator
        # package so the evidence always belongs to this exact final GLB.
        from build_character_animation_assets import prepare_official_validator

        validator_module, validator_package = prepare_official_validator(stage)
        validator_process = subprocess.run(
            [
                options.node,
                str(VALIDATOR_SCRIPT),
                "--validator-module",
                str(validator_module),
                "--file",
                str(final_glb),
                "--resource-root",
                str(final_glb.parent),
                "--allowed-root",
                str(final_glb.parent),
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if validator_process.returncode not in {0, 1} or not validator_process.stdout.strip():
            raise RuntimeError(
                f"Official glTF Validator failed to run: {validator_process.stderr.strip()}"
            )
        validator_report = json.loads(validator_process.stdout)
        validator_issues = validator_report.get("issues", {})
        if int(validator_issues.get("numErrors", 0)) != 0:
            raise RuntimeError(f"Official glTF Validator rejected villain: {validator_issues}")

        simplify = json.loads(simplify_report.read_text(encoding="utf-8"))
        triangles = int(simplify["render"]["triangleCount"])
        final_bytes = final_glb.stat().st_size
        models_bytes = public_models_bytes(final_glb)
        if not MIN_RUNTIME_TRIANGLES <= triangles <= MAX_RUNTIME_TRIANGLES:
            raise RuntimeError(f"Runtime triangle budget failed: {triangles}")
        if final_bytes > MAX_CHARACTER_BYTES:
            raise RuntimeError(f"Villain byte budget failed: {final_bytes}")
        if models_bytes > MAX_PUBLIC_MODELS_BYTES:
            raise RuntimeError(f"public/models byte budget failed: {models_bytes}")

        combined = json.loads(high_report.read_text(encoding="utf-8"))
        combined["runtimePipeline"] = {
            "simplifier": "gltfpack meshoptimizer",
            "simplifyRatio": SIMPLIFY_RATIO,
            "positionEncoding": "float (-vpf); no mesh-node quantization scale patch",
            "tangents": "regenerated (-gt)",
            "meshoptCompression": True,
            "simplifyReport": simplify,
            "packReport": json.loads(pack_report.read_text(encoding="utf-8")),
            "animationSampleReport": json.loads(sample_report.read_text(encoding="utf-8")),
        }
        combined["validator"] = {
            **validator_package,
            "version": validator_report.get("validatorVersion"),
            "errors": int(validator_issues.get("numErrors", 0)),
            "warnings": int(validator_issues.get("numWarnings", 0)),
            "infos": int(validator_issues.get("numInfos", 0)),
            "hints": int(validator_issues.get("numHints", 0)),
            "messages": validator_issues.get("messages", []),
            "warningExplanation": "NODE_SKINNED_MESH_NON_ROOT is the single visible skinned mesh parented below the transform-free canonical Rig_Humanoid_Shared node; GLTFLoader, all nine clips, batching, and the articulated shadow-proxy tests validate this hierarchy.",
            "infoExplanation": "The pinned Validator does not decode EXT_meshopt_compression; the project MeshoptDecoder asset test and browser smoke test cover that extension.",
        }
        combined["outputs"] = {
            "authoringMaster": RIGGED_MASTER.relative_to(ROOT).as_posix(),
            "sourceMaster": ASSET_ROOT.joinpath("Villain_PrecisionRemodel_v21.blend").relative_to(ROOT).as_posix(),
            "stagingStaticGlbBytes": high_static.stat().st_size,
            "runtimeGlb": RUNTIME_GLB.relative_to(ROOT).as_posix(),
            "runtimeGlbBytes": final_bytes,
            "runtimeGlbSha256": sha256(final_glb),
            "runtimeTriangles": triangles,
            "publicModelsBytesAfterInstall": models_bytes,
            "installed": bool(options.install),
        }

        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(combined, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        validator_evidence = {
            "asset": RUNTIME_GLB.relative_to(ROOT).as_posix(),
            "assetBytes": final_bytes,
            "assetSha256": sha256(final_glb),
            "runtimeTriangles": triangles,
            "package": validator_package,
            "report": validator_report,
        }
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        (EVIDENCE_DIR / "gltf_validator_runtime.json").write_text(
            json.dumps(validator_evidence, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        if options.install:
            atomic_copy(high_blend, RIGGED_MASTER)
            atomic_copy(final_glb, RUNTIME_GLB)

        print(json.dumps({
            "installed": bool(options.install),
            "runtimeGlb": str(RUNTIME_GLB if options.install else final_glb),
            "runtimeGlbBytes": final_bytes,
            "runtimeTriangles": triangles,
            "publicModelsBytes": models_bytes,
            "sha256": sha256(RUNTIME_GLB if options.install else final_glb),
            "report": str(report_path),
        }, indent=2))


if __name__ == "__main__":
    main()
