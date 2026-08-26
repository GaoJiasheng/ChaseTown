#!/usr/bin/env python3
"""Build compact Web runtime assets without touching art-source masters.

The runtime GLBs keep their existing external ``.png`` image URIs so the
legacy integrity test and non-WebP tooling retain a real fallback.  The game
runtime redirects those requests to the sibling full-resolution WebP files.
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image


SCRIPT_ROOT = Path(__file__).resolve().parent
DEFAULT_MODELS_ROOT = SCRIPT_ROOT.parents[1] / "public" / "models"
GLTFPACK_CLI = SCRIPT_ROOT / "vendor" / "gltfpack" / "cli.js"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def file_size(path: Path) -> int:
    return path.stat().st_size


def glb_json(path: Path) -> dict:
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


def rewrite_glb_json(path: Path, document: dict) -> None:
    payload = path.read_bytes()
    chunks: list[tuple[int, bytes]] = []
    offset = 12
    while offset + 8 <= len(payload):
        length, chunk_type = struct.unpack_from("<II", payload, offset)
        start = offset + 8
        chunks.append((chunk_type, payload[start:start + length]))
        offset = start + length
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    chunks = [(chunk_type, encoded if chunk_type == 0x4E4F534A else data) for chunk_type, data in chunks]
    length = 12 + sum(8 + len(data) for _, data in chunks)
    rebuilt = bytearray(b"glTF" + struct.pack("<II", 2, length))
    for chunk_type, data in chunks:
        rebuilt.extend(struct.pack("<II", len(data), chunk_type))
        rebuilt.extend(data)
    path.write_bytes(rebuilt)


def normalize_emissive_strength(path: Path) -> int:
    """Move out-of-range emissive factors into the standard strength extension."""
    document = glb_json(path)
    changed = 0
    for material in document.get("materials", []):
        factor = material.get("emissiveFactor")
        if not factor:
            continue
        peak = max(float(value) for value in factor)
        if peak <= 1:
            continue
        material["emissiveFactor"] = [float(value) / peak for value in factor]
        extensions = material.setdefault("extensions", {})
        strength = extensions.setdefault("KHR_materials_emissive_strength", {})
        strength["emissiveStrength"] = float(strength.get("emissiveStrength", 1)) * peak
        changed += 1
    if changed:
        used = document.setdefault("extensionsUsed", [])
        if "KHR_materials_emissive_strength" not in used:
            used.append("KHR_materials_emissive_strength")
        rewrite_glb_json(path, document)
    return changed


def run_checked(command: list[str]) -> None:
    subprocess.run(command, check=True)


def compress_glb(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    run_checked([
        "node",
        str(GLTFPACK_CLI),
        "-i",
        str(source),
        "-o",
        str(destination),
        "-c",
        "-kn",
        "-km",
        "-ke",
        "-kv",
        "-tr",
    ])
    normalize_emissive_strength(destination)
    document = glb_json(destination)
    required = set(document.get("extensionsRequired", []))
    if "EXT_meshopt_compression" not in required:
        raise ValueError(f"{destination} is missing required Meshopt compression")
    if "characters" in destination.parts and not document.get("skins"):
        raise ValueError(f"{destination} lost its character rig")


def compress_texture(source: Path, webp: Path, fallback_png: Path, cwebp: str) -> None:
    webp.parent.mkdir(parents=True, exist_ok=True)
    quality = "90" if "_Normal_" in source.name else "85"
    run_checked([
        cwebp,
        "-quiet",
        "-q",
        quality,
        "-m",
        "6",
        "-sharp_yuv",
        str(source),
        "-o",
        str(webp),
    ])
    with Image.open(source) as image:
        fallback = image.convert("RGBA" if image.mode == "RGBA" else "RGB")
        fallback.thumbnail((256, 256), Image.Resampling.LANCZOS)
        fallback.save(fallback_png, format="PNG", optimize=True, compress_level=9)
    if webp.read_bytes()[:4] != b"RIFF" or webp.read_bytes()[8:12] != b"WEBP":
        raise ValueError(f"{webp} is not a deployable WebP")
    if fallback_png.read_bytes()[:8] != PNG_SIGNATURE:
        raise ValueError(f"{fallback_png} is not a deployable PNG")


def build(source_root: Path, output_root: Path) -> dict:
    if not GLTFPACK_CLI.is_file():
        raise FileNotFoundError(f"vendored gltfpack CLI missing: {GLTFPACK_CLI}")
    cwebp = shutil.which("cwebp")
    if not cwebp:
        raise FileNotFoundError("cwebp is required to build runtime WebP textures")

    glbs = sorted(source_root.rglob("*.glb"))
    pngs = sorted((source_root / "SharedTextures").glob("*.png"))
    if len(glbs) != 29 or len(pngs) != 26:
        raise ValueError(f"expected 29 GLBs and 26 shared PNGs, got {len(glbs)} and {len(pngs)}")

    report: dict[str, object] = {"files": [], "beforeBytes": 0, "afterBytes": 0}
    with tempfile.TemporaryDirectory(prefix="chasing-runtime-assets-") as temporary:
        stage = Path(temporary)
        for source in glbs:
            relative = source.relative_to(source_root)
            destination = stage / relative
            compress_glb(source, destination)
            report["files"].append({
                "path": relative.as_posix(),
                "before": file_size(source),
                "after": file_size(destination),
                "kind": "meshopt-glb",
            })
        for source in pngs:
            relative = source.relative_to(source_root)
            fallback_png = stage / relative
            webp = fallback_png.with_suffix(".webp")
            compress_texture(source, webp, fallback_png, cwebp)
            report["files"].extend([
                {
                    "path": relative.as_posix(),
                    "before": file_size(source),
                    "after": file_size(fallback_png),
                    "kind": "compatibility-png",
                },
                {
                    "path": webp.relative_to(stage).as_posix(),
                    "before": file_size(source),
                    "after": file_size(webp),
                    "kind": "runtime-webp",
                },
            ])

        for staged in sorted(path for path in stage.rglob("*") if path.is_file()):
            destination = output_root / staged.relative_to(stage)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(staged, destination)

    report["beforeBytes"] = sum(
        int(item["before"])
        for item in report["files"]
        if item["kind"] != "runtime-webp"
    )
    report["afterBytes"] = sum(
        file_size(path)
        for path in output_root.rglob("*")
        if path.is_file()
    )
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_MODELS_ROOT)
    parser.add_argument("--output", type=Path, default=DEFAULT_MODELS_ROOT)
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    report = build(source, output)
    serialized = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(serialized + "\n", encoding="utf-8")
    print(serialized)


if __name__ == "__main__":
    main()
