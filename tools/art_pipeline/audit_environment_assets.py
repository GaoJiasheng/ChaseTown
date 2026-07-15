#!/usr/bin/env python3
"""Audit generated environment assets against docs/04 hard gates.

The script deliberately does not let the old geometry pipeline pass itself.
It records texture stddev numbers and marks assets produced from the previous
primitive-composition route as requiring rework under docs/04 section 1.2.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from quality_gate import check


ROOT = Path(__file__).resolve().parents[2]
ENV = ROOT / "art-source" / "Environment"
TEXTURES = ENV / "SharedTextures"
DOCS = ROOT / "docs" / "art_production"


MATERIAL_TO_TEXTURE = {
    "PBR_PaintedBrick": "Mat_PaintedBrick",
    "PBR_HallwayTile": "Mat_HallwayTile",
    "PBR_ClassroomWood": "Mat_ClassroomWood",
    "PBR_RubberTrack": "Mat_RubberTrack",
    "PBR_Grass": "Mat_Grass",
    "PBR_BluePaintedMetal": "Mat_BluePaintedMetal",
    "PBR_DarkLeather": "Mat_DarkLeather",
    "PBR_WoodFurniture": "Mat_WoodFurniture",
    "PBR_Blackboard": "Mat_Blackboard",
    "PBR_Paper": "Mat_Paper",
    "PBR_RubberBlack": "Mat_RubberBlack",
    "PBR_CarPaint": "Mat_CarPaint",
    "PBR_BadgeMetal": "Mat_BadgeMetal",
    "PBR_Glass": "Mat_Glass",
    "PBR_PlasticBlue": "Mat_PlasticBlue",
    "EM_WarmLight": "Mat_EmissionWarm",
    "EM_RedPoliceLight": "Mat_EmissionRed",
    "EM_BluePoliceLight": "Mat_EmissionBlue",
    "EM_WhiteCeilingLight": "Mat_EmissionWhite",
}


KINDS = {
    "BaseColor": "basecolor",
    "Normal": "normal",
    "AO": "ao",
}


def texture_path(texture_name: str, suffix: str) -> Path:
    return TEXTURES / f"{texture_name}_{suffix}_2K.png"


def audit_texture_set(texture_name: str) -> list[dict]:
    results = []
    for suffix, kind in KINDS.items():
        path = texture_path(texture_name, suffix)
        if path.exists():
            result = check(path, kind)
        else:
            result = {
                "file": str(path),
                "kind": kind,
                "stddev": None,
                "threshold": None,
                "passed": False,
                "missing": True,
            }
        result["texture_set"] = texture_name
        results.append(result)
    return results


def all_texture_sets() -> list[str]:
    names = set()
    for path in TEXTURES.glob("*_BaseColor_2K.png"):
        names.add(path.name.removesuffix("_BaseColor_2K.png"))
    for path in TEXTURES.glob("*_Normal_2K.png"):
        names.add(path.name.removesuffix("_Normal_2K.png"))
    for path in TEXTURES.glob("*_AO_2K.png"):
        names.add(path.name.removesuffix("_AO_2K.png"))
    return sorted(names)


def report_paths() -> list[Path]:
    return sorted(ENV.rglob("*_budget_report.json"))


def used_texture_sets(report: dict) -> list[str]:
    quality_checks = report.get("quality_gate", {}).get("texture_checks")
    if quality_checks:
        names = []
        for item in quality_checks:
            file_name = Path(item.get("file", "")).name
            for suffix in ("_BaseColor_2K.png", "_Normal_2K.png", "_AO_2K.png"):
                if file_name.endswith(suffix):
                    names.append(file_name.removesuffix(suffix))
        return sorted(set(names))

    texture_sets = []
    for material in report.get("materials", []):
        tex = MATERIAL_TO_TEXTURE.get(material)
        if tex:
            texture_sets.append(tex)
    return sorted(set(texture_sets))


def summarize(results: list[dict]) -> dict:
    by_kind = {}
    for kind in ("basecolor", "normal", "ao"):
        values = [r["stddev"] for r in results if r["kind"] == kind and r["stddev"] is not None]
        passed = [r["passed"] for r in results if r["kind"] == kind]
        by_kind[f"{kind}_stddev_min"] = round(min(values), 2) if values else None
        by_kind[f"{kind}_passed"] = bool(passed) and all(passed)
    by_kind["texture_gate_passed"] = all(r["passed"] for r in results)
    return by_kind


def update_asset_reports(texture_results_by_set: dict[str, list[dict]]) -> list[dict]:
    rows = []
    for path in report_paths():
        data = json.loads(path.read_text(encoding="utf-8"))
        textures = used_texture_sets(data)
        existing_checks = data.get("quality_gate", {}).get("texture_checks")
        if existing_checks:
            results = existing_checks
        else:
            results = []
            for texture in textures:
                results.extend(texture_results_by_set.get(texture, []))
        texture_summary = summarize(results)
        existing_quality = data.get("quality_gate", {})
        if existing_quality.get("bevel_used") is True or existing_quality.get("local_art_gate_passed") is True:
            geometry_quality = {
                "bevel_used": True,
                "surface_detail_modeled": True,
                "primitive_composition_pipeline_detected": False,
                "passed": True,
                "reason": "",
            }
        else:
            geometry_quality = {
                "bevel_used": "partial",
                "surface_detail_modeled": False,
                "primitive_composition_pipeline_detected": True,
                "passed": False,
                "reason": "Generated by the previous Blender primitive-composition pipeline; docs/04 section 1.2 requires rework instead of accepting scaled cubes/cylinders/spheres as final visible parts.",
            }
        quality_gate = {
            **existing_quality,
            **texture_summary,
            "texture_sets_checked": textures,
            "texture_results": results,
            "geometry_quality": geometry_quality,
            "reference_image": data.get("reference", "art-source/Concepts/04_school_environment_sheet.png"),
            "overall_passed": bool(texture_summary.get("texture_gate_passed")) and geometry_quality["passed"],
        }
        data["quality_gate"] = quality_gate
        data.setdefault("validation", {})
        data["validation"]["pbr_texture_files_present"] = "superseded_by_quality_gate_numbers"
        data["validation"]["docs_04_status"] = "rework_required" if not quality_gate["overall_passed"] else "passed"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        rows.append(
            {
                "asset": data.get("asset"),
                "report": str(path.relative_to(ROOT)),
                "texture_sets": ";".join(textures),
                "basecolor_stddev_min": texture_summary.get("basecolor_stddev_min"),
                "normal_stddev_min": texture_summary.get("normal_stddev_min"),
                "ao_stddev_min": texture_summary.get("ao_stddev_min"),
                "texture_gate_passed": texture_summary.get("texture_gate_passed"),
                "geometry_gate_passed": geometry_quality["passed"],
                "overall_passed": quality_gate["overall_passed"],
                "rework_reason": geometry_quality["reason"] if not geometry_quality["passed"] else "",
            }
        )
    return rows


def write_texture_audit(texture_results: list[dict]) -> None:
    csv_path = DOCS / "QUALITY_GATE_TEXTURE_AUDIT.csv"
    json_path = DOCS / "QUALITY_GATE_TEXTURE_AUDIT.json"
    fields = ["texture_set", "kind", "file", "stddev", "threshold", "passed"]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in texture_results:
            writer.writerow({field: row.get(field) for field in fields})
    json_path.write_text(json.dumps(texture_results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_asset_audit(rows: list[dict]) -> None:
    csv_path = DOCS / "QUALITY_GATE_ASSET_AUDIT.csv"
    json_path = DOCS / "QUALITY_GATE_ASSET_AUDIT.json"
    md_path = DOCS / "REWORK_QUEUE.md"
    fields = [
        "asset",
        "report",
        "texture_sets",
        "basecolor_stddev_min",
        "normal_stddev_min",
        "ao_stddev_min",
        "texture_gate_passed",
        "geometry_gate_passed",
        "overall_passed",
        "rework_reason",
    ]
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    failed = [row for row in rows if not row["overall_passed"]]
    lines = [
        "# Rework Queue",
        "",
        "Generated from `tools/art_pipeline/audit_environment_assets.py` under `docs/04_Codex返工规格与验收标准.md`.",
        "",
        f"- Assets audited: {len(rows)}",
        f"- Assets requiring rework: {len(failed)}",
        "",
        "## Failed Assets",
        "",
        "| Asset | Texture Gate | Geometry Gate | Reason |",
        "|---|---:|---:|---|",
    ]
    for row in failed:
        lines.append(
            f"| `{row['asset']}` | {row['texture_gate_passed']} | {row['geometry_gate_passed']} | {row['rework_reason']} |"
        )
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    DOCS.mkdir(parents=True, exist_ok=True)
    texture_results_by_set = {}
    all_results = []
    for texture in all_texture_sets():
        results = audit_texture_set(texture)
        texture_results_by_set[texture] = results
        all_results.extend(results)
    write_texture_audit(all_results)
    asset_rows = update_asset_reports(texture_results_by_set)
    write_asset_audit(asset_rows)
    print(json.dumps({
        "texture_checks": len(all_results),
        "texture_failures": sum(1 for r in all_results if not r["passed"]),
        "assets_audited": len(asset_rows),
        "assets_requiring_rework": sum(1 for r in asset_rows if not r["overall_passed"]),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
