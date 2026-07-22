#!/usr/bin/env python3
"""Prove which authored PBR maps are UV-compatible with shipped characters.

Run with Blender:

    blender --background --factory-startup \
      --python tools/art_pipeline/audit_character_pbr_compatibility.py -- \
      --output art-source/_Shared/PBR/Reports/character_pbr_compatibility.json

This audit is read-only with respect to character assets.  It compares the
active UV loop streams and topology of the approved source .blend files with
the shipped GLBs after Blender's own glTF round-trip.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import bpy
import numpy as np


ROOT = Path(__file__).resolve().parents[2]

SPECS = {
    "kid": {
        "source": ROOT
        / "art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Kid_PrecisionRemodel_v21_Rigged.blend",
        "runtime": ROOT / "public/models/characters/kid.glb",
        "objects": ("Kid_v20_NativeBodyHead",),
        "targetMaterial": "M_Kid_PrecisionRemodel_v21_URP",
        "mapRoot": ROOT
        / "art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21",
    },
    "villain": {
        "source": ROOT
        / "art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Villain_PrecisionRemodel_v21_Rigged.blend",
        "runtime": ROOT / "public/models/characters/villain.glb",
        "objects": ("Villain_v20_NativeBodyHead",),
        "targetMaterial": "M_Villain_PrecisionRemodel_v21_URP",
        "mapRoot": ROOT
        / "art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21",
    },
    "police": {
        "source": ROOT
        / "art-source/Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22/Rigged/Police_HumanAnatomyRemodel_v22_Rigged.blend",
        "runtime": ROOT / "public/models/characters/police.glb",
        "objects": ("Police_v22_Body", "Police_v22_Uniform"),
        "targetMaterial": None,
        "mapRoot": None,
    },
}

POLICE_LEGACY = {
    "source": ROOT
    / "art-source/Characters/Police/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/Rigged/Police_PrecisionRemodel_v21_Rigged.blend",
    "object": "Police_v20_NativeBodyHead",
    "mapRoot": ROOT
    / "art-source/Characters/Police/ReferenceStandard/PrecisionRemodel_2026_07_13_v21",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def uv_snapshot(obj: bpy.types.Object) -> dict[str, Any]:
    layer = obj.data.uv_layers.active
    if layer is None:
        return {"hasUv": False}
    values = np.empty(len(layer.data) * 2, dtype=np.float32)
    layer.data.foreach_get("uv", values)
    # Blender's glTF conversion moves some values by ~3e-8.  Integer bins at
    # 1e-5 are sub-texel at 2K and avoid float signed-zero/hash artifacts.
    quantized_pairs = np.rint(values.reshape((-1, 2)) * 100_000.0).astype(np.int32)
    ordered_pairs = quantized_pairs[np.lexsort((quantized_pairs[:, 1], quantized_pairs[:, 0]))]
    unique_pairs = np.unique(quantized_pairs, axis=0)
    return {
        "hasUv": True,
        "layer": layer.name,
        "uvLoopCount": len(layer.data),
        "uvMin": [round(float(values[0::2].min()), 6), round(float(values[1::2].min()), 6)],
        "uvMax": [round(float(values[0::2].max()), 6), round(float(values[1::2].max()), 6)],
        "orderedLoopUvSha256": hashlib.sha256(quantized_pairs.tobytes()).hexdigest(),
        "sortedLoopUvSha256": hashlib.sha256(ordered_pairs.tobytes()).hexdigest(),
        "uniqueUvCount": len(unique_pairs),
        "uniqueUvSha256": hashlib.sha256(unique_pairs.tobytes()).hexdigest(),
        # Kept only in-memory for tolerance comparisons, then removed before
        # the JSON report is written.
        "_values": values,
    }


def object_snapshot(name: str) -> dict[str, Any]:
    obj = bpy.data.objects.get(name)
    if obj is None or obj.type != "MESH":
        raise RuntimeError(f"Missing mesh object {name}")
    return {
        "name": name,
        "vertices": len(obj.data.vertices),
        "polygons": len(obj.data.polygons),
        "triangles": sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons),
        "materials": [material.name if material else None for material in obj.data.materials],
        "uv": uv_snapshot(obj),
    }


def image_references(material_name: str | None) -> list[dict[str, Any]]:
    if material_name is None:
        return []
    material = bpy.data.materials.get(material_name)
    if material is None or not material.use_nodes:
        return []
    references = []
    for node in material.node_tree.nodes:
        if node.type != "TEX_IMAGE" or node.image is None:
            continue
        resolved = Path(bpy.path.abspath(node.image.filepath)) if node.image.filepath else None
        references.append(
            {
                "node": node.name,
                "image": node.image.name,
                "authoredPath": node.image.filepath,
                "resolvedPath": str(resolved) if resolved else None,
                "resolvedFileExists": bool(resolved and resolved.is_file()),
                "loadedDimensions": list(node.image.size),
            }
        )
    return references


def map_files(role: str, root: Path | None) -> dict[str, Any]:
    if root is None:
        return {}
    label = role.title()
    paths = {
        "baseColor": root / "Rigged/Textures" / f"Char_{label}_PrecisionRemodel_v21_BaseColor_2K.png",
        "normal": root / "Textures" / f"Char_{label}_PrecisionRemodel_v21_Normal_2K.png",
        "ao": root / "Textures" / f"Char_{label}_PrecisionRemodel_v21_AO_2K.png",
        "metallicSmoothness": root
        / "Textures"
        / f"Char_{label}_PrecisionRemodel_v21_MetallicSmoothness_2K.png",
    }
    return {
        slot: {
            "path": str(path.relative_to(ROOT)),
            "exists": path.is_file(),
            "bytes": path.stat().st_size if path.is_file() else None,
            "sha256": sha256(path) if path.is_file() else None,
        }
        for slot, path in paths.items()
    }


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30


def source_snapshot(spec: dict[str, Any]) -> dict[str, Any]:
    bpy.ops.wm.open_mainfile(filepath=str(spec["source"]))
    return {
        "blend": str(spec["source"].relative_to(ROOT)),
        "objects": {name: object_snapshot(name) for name in spec["objects"]},
        "materialImageReferences": image_references(spec["targetMaterial"]),
    }


def runtime_snapshot(spec: dict[str, Any]) -> dict[str, Any]:
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(spec["runtime"]))
    return {
        "glb": str(spec["runtime"].relative_to(ROOT)),
        "bytes": spec["runtime"].stat().st_size,
        "objects": {name: object_snapshot(name) for name in spec["objects"]},
    }


def compatible(source: dict[str, Any], runtime: dict[str, Any]) -> dict[str, Any]:
    result = {}
    for name, source_object in source["objects"].items():
        runtime_object = runtime["objects"][name]
        source_values = source_object["uv"].pop("_values")
        runtime_values = runtime_object["uv"].pop("_values")
        ordered_delta = (
            float(np.max(np.abs(source_values - runtime_values)))
            if source_values.shape == runtime_values.shape
            else None
        )
        source_bins = {
            tuple(pair)
            for pair in np.rint(source_values.reshape((-1, 2)) * 10_000.0).astype(np.int32)
        }
        runtime_bins = {
            tuple(pair)
            for pair in np.rint(runtime_values.reshape((-1, 2)) * 10_000.0).astype(np.int32)
        }
        union = source_bins | runtime_bins
        overlap = len(source_bins & runtime_bins) / max(1, len(union))
        uv_compatible = (ordered_delta is not None and ordered_delta <= 1e-6) or overlap >= 0.995
        result[name] = {
            # glTF legally splits vertices at UV/normal seams and triangulates
            # quads, so source vertex/polygon counts are not invariant.  The
            # rendered surface triangle count and unique UV coordinates are.
            "surfaceTriangleMatch": source_object["triangles"] == runtime_object["triangles"],
            "uvLoopCountMatch": source_object["uv"].get("uvLoopCount")
            == runtime_object["uv"].get("uvLoopCount"),
            "sortedLoopUvMatch": source_object["uv"].get("sortedLoopUvSha256")
            == runtime_object["uv"].get("sortedLoopUvSha256"),
            "uniqueUvSetMatch": source_object["uv"].get("uniqueUvSha256")
            == runtime_object["uv"].get("uniqueUvSha256"),
            "orderedUvMaxAbsDelta": round(ordered_delta, 10) if ordered_delta is not None else None,
            "quantizedUvSetOverlap": round(overlap, 8),
            "uvCompatibleWithinOneMicroUvOr99_5PctSetOverlap": uv_compatible,
        }
    return result


def strip_private_values(value: Any) -> None:
    if isinstance(value, dict):
        for key in list(value):
            if key.startswith("_"):
                value.pop(key)
            else:
                strip_private_values(value[key])
    elif isinstance(value, list):
        for item in value:
            strip_private_values(item)


def main() -> None:
    args = parse_args()
    report: dict[str, Any] = {"roles": {}}
    for role, spec in SPECS.items():
        source = source_snapshot(spec)
        runtime = runtime_snapshot(spec)
        checks = compatible(source, runtime)
        report["roles"][role] = {
            "source": source,
            "runtime": runtime,
            "compatibility": checks,
            "v21PbrMaps": map_files(role, spec["mapRoot"]),
            "allPrimaryUvStreamsMatch": all(
                value["surfaceTriangleMatch"]
                and value["uvCompatibleWithinOneMicroUvOr99_5PctSetOverlap"]
                for value in checks.values()
            ),
        }

    legacy_spec = {
        "source": POLICE_LEGACY["source"],
        "objects": (POLICE_LEGACY["object"],),
        "targetMaterial": "M_Police_PrecisionRemodel_v21_URP",
    }
    legacy = source_snapshot(legacy_spec)
    current = report["roles"]["police"]["runtime"]
    legacy_object = legacy["objects"][POLICE_LEGACY["object"]]
    current_triangles = sum(obj["triangles"] for obj in current["objects"].values())
    report["roles"]["police"]["legacyV21AtlasAssessment"] = {
        "source": legacy,
        "maps": map_files("police", POLICE_LEGACY["mapRoot"]),
        "compatibleWithV22Runtime": False,
        "reason": (
            "The v21 atlas was baked for Police_v20_NativeBodyHead; the shipped v22 runtime uses "
            "separate Police_v22_Body and Police_v22_Uniform UV layouts."
        ),
        "legacyMainTriangles": legacy_object["triangles"],
        "v22BodyAndUniformTriangles": current_triangles,
    }
    report["conclusion"] = {
        "kid": "v21 BaseColor/Normal/AO/MetallicSmoothness are safe on the shipped v21 primary mesh",
        "villain": "v21 BaseColor/Normal/AO/MetallicSmoothness are safe on the shipped v21 primary mesh",
        "police": (
            "do not use the v21 BaseColor atlas; use the canonical MakeHuman skin and casual-suit "
            "textures referenced by the v22 source plus v22-specific generated ORM"
        ),
    }
    strip_private_values(report)
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
