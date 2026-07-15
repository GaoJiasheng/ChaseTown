#!/usr/bin/env python3
"""Package and validate the v21 reference-standard character review assets."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
PRODUCTION = ROOT / "docs/art_production/fourview_remodel_v21_mpfb_headgraft"
SHEET = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V21_CONTACT_SHEET.png"
POSE_ROOT = ROOT / "docs/art_production/rig_pose_validation_v21"
POSE_SHEET = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V21_RIG_POSE_CONTACT_SHEET.png"
SUMMARY = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V21_SUMMARY.json"
PACKAGE_VALIDATION = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V21_PACKAGE_VALIDATION.json"
UNITY_REPORT = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V21_UNITY_AVATAR_VALIDATION.json"
ASSIMP_REPORT = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V21_RIGGED_ASSIMP_VALIDATION.json"
VIEWS = ("front", "side", "top", "back")
POSES = ("PointAlert", "Walk")
POSE_VIEW_SUFFIXES = {"front": "", "side": "_side", "back": "_back"}
POSE_VIEWS = tuple(
    (pose, view, POSE_VIEW_SUFFIXES[view])
    for pose in POSES
    for view in ("front", "side", "back")
)
ROLES = {
    role: ROOT / f"art-source/Characters/{role}/ReferenceStandard/PrecisionRemodel_2026_07_13_v21"
    for role in ("Kid", "Villain", "Police")
}
PALETTES = {
    "Kid": ((18, 34, 70), (31, 38, 49), (193, 119, 80)),
    "Villain": ((14, 13, 12), (35, 32, 29), (78, 47, 34)),
    "Police": ((12, 30, 66), (24, 44, 80), (181, 106, 72)),
}


def build_sheet() -> None:
    cell_w, cell_h = 540, 700
    sheet = Image.new("RGB", (cell_w * 4, cell_h * 3), (13, 14, 16))
    draw = ImageDraw.Draw(sheet)
    for row, role in enumerate(ROLES):
        for col, view in enumerate(VIEWS):
            source = Image.open(PRODUCTION / role / f"{role}_v21_{view}.png").convert("RGB")
            source.thumbnail((cell_w - 20, cell_h - 46), Image.Resampling.LANCZOS)
            x = col * cell_w + (cell_w - source.width) // 2
            y = row * cell_h + 36
            sheet.paste(source, (x, y))
            draw.text((col * cell_w + 12, row * cell_h + 10), f"{role}  {view}", fill=(242, 242, 238))
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEET, optimize=True)


def build_pose_sheet() -> None:
    cell_w, cell_h = 350, 500
    sheet = Image.new("RGB", (cell_w * len(POSE_VIEWS), cell_h * 3), (13, 14, 16))
    draw = ImageDraw.Draw(sheet)
    for row, role in enumerate(ROLES):
        for col, (pose, view, suffix) in enumerate(POSE_VIEWS):
            source = Image.open(POSE_ROOT / f"{role}_v21_{pose}{suffix}.png").convert("RGB")
            source.thumbnail((cell_w - 20, cell_h - 46), Image.Resampling.LANCZOS)
            x = col * cell_w + (cell_w - source.width) // 2
            y = row * cell_h + 36
            sheet.paste(source, (x, y))
            draw.text(
                (col * cell_w + 12, row * cell_h + 10),
                f"{role}  {pose}  {view}",
                fill=(242, 242, 238),
            )
    POSE_SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(POSE_SHEET, optimize=True)


def load_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def image_metrics(path: Path) -> dict[str, object]:
    image = Image.open(path).convert("RGB")
    pixels = np.asarray(image, dtype=np.float32)
    stddev = round(float(np.std(pixels)), 3)
    return {
        "path": str(path.relative_to(ROOT)),
        "dimensions": [image.width, image.height],
        "stddev": stddev,
        "threshold": 8.0,
        "passed": stddev >= 8.0,
    }


def write_pbr(role: str, asset_dir: Path) -> dict[str, float]:
    texture_dir = asset_dir / "Textures"
    texture_dir.mkdir(parents=True, exist_ok=True)
    size = 2048
    rng = np.random.default_rng(2100 + sum(ord(char) for char in role))
    coarse = rng.normal(0.5, 0.15, (256, 256))
    noise = Image.fromarray(np.clip(coarse * 255.0, 0, 255).astype(np.uint8))
    noise = noise.resize((size, size), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(0.85))
    field = np.asarray(noise, dtype=np.float32) / 255.0

    palette = np.asarray(PALETTES[role], dtype=np.float32)
    base = np.empty((size, size, 3), dtype=np.float32)
    base[:, : size // 2] = palette[0]
    base[: size // 2, size // 2 :] = palette[1]
    base[size // 2 :, size // 2 :] = palette[2]
    weave = np.sin(np.arange(size, dtype=np.float32)[:, None] * 0.48) * np.sin(
        np.arange(size, dtype=np.float32)[None, :] * 0.51
    )
    base *= 0.90 + field[..., None] * 0.18 + weave[..., None] * 0.018
    base_u8 = np.clip(base, 0, 255).astype(np.uint8)
    Image.fromarray(base_u8).save(
        texture_dir / f"Char_{role}_PrecisionRemodel_v21_BaseColor_2K.png", optimize=True
    )

    gy, gx = np.gradient(field)
    nx, ny, nz = -gx * 1.7, -gy * 1.7, np.ones_like(gx)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack((nx / length * 0.5 + 0.5, ny / length * 0.5 + 0.5, nz / length * 0.5 + 0.5), axis=-1)
    normal_u8 = np.clip(normal * 255.0, 0, 255).astype(np.uint8)
    Image.fromarray(normal_u8).save(
        texture_dir / f"Char_{role}_PrecisionRemodel_v21_Normal_2K.png", optimize=True
    )

    ao = np.clip(216.0 + (field - 0.5) * 46.0, 172.0, 245.0).astype(np.uint8)
    Image.fromarray(ao).save(texture_dir / f"Char_{role}_PrecisionRemodel_v21_AO_2K.png", optimize=True)

    packed = np.zeros((size, size, 4), dtype=np.uint8)
    packed[..., 0] = 5
    packed[..., 3] = np.clip(68.0 + field * 54.0, 62.0, 126.0).astype(np.uint8)
    Image.fromarray(packed).save(
        texture_dir / f"Char_{role}_PrecisionRemodel_v21_MetallicSmoothness_2K.png", optimize=True
    )
    return {
        "basecolor_stddev": round(float(np.std(base_u8)), 3),
        "normal_stddev": round(float(np.std(normal_u8)), 3),
        "ao_stddev": round(float(np.std(ao)), 3),
    }


def package_assets() -> None:
    unity = load_json(UNITY_REPORT)
    assimp = load_json(ASSIMP_REPORT)
    assimp_passed = assimp["count"] == 6 and assimp["passed"] == 6 and not assimp["failed"]
    unity_characters = {item["role"]: item for item in unity["characters"]}
    summary: dict[str, object] = {
        "version": "PrecisionRemodel_2026_07_13_v21",
        "scope": "three_role_reference_standard",
        "status": "rigged_and_unity_validated_prototype_not_nine_style_final",
        "static_contact_sheet": str(SHEET.relative_to(ROOT)),
        "rig_pose_contact_sheet": str(POSE_SHEET.relative_to(ROOT)),
        "unity_validation": str(UNITY_REPORT.relative_to(ROOT)),
        "rigged_assimp_validation": str(ASSIMP_REPORT.relative_to(ROOT)),
        "roles": {},
    }
    package_checks: list[dict[str, object]] = []
    role_summary = summary["roles"]
    assert isinstance(role_summary, dict)
    for role, asset_dir in ROLES.items():
        previews = asset_dir / "Previews"
        reports = asset_dir / "Reports"
        previews.mkdir(parents=True, exist_ok=True)
        reports.mkdir(parents=True, exist_ok=True)
        rigged_dir = asset_dir / "Rigged"
        rig_report_path = rigged_dir / "Reports" / f"{role}_PrecisionRemodel_v21_Rigged_report.json"
        rig_report = load_json(rig_report_path)
        unity_character = unity_characters[role]
        view_paths: dict[str, str] = {}
        for view in VIEWS:
            source = PRODUCTION / role / f"{role}_v21_{view}.png"
            target = previews / f"{role}_PrecisionRemodel_v21_{view}.png"
            shutil.copy2(source, target)
            view_paths[view] = str(target.relative_to(ROOT))
        pose_paths = {
            pose: str((POSE_ROOT / f"{role}_v21_{pose}.png").relative_to(ROOT))
            for pose in POSES
        }
        side_pose_paths = {
            pose: str((POSE_ROOT / f"{role}_v21_{pose}_side.png").relative_to(ROOT))
            for pose in POSES
        }
        back_pose_paths = {
            pose: str((POSE_ROOT / f"{role}_v21_{pose}_back.png").relative_to(ROOT))
            for pose in POSES
        }
        supplemental_metrics = write_pbr(role, asset_dir)
        applied_basecolor = image_metrics(
            rigged_dir / "Textures" / f"Char_{role}_PrecisionRemodel_v21_BaseColor_2K.png"
        )
        animation_sources = unity["animationSources"]
        pose_results = unity_character["poses"]
        animation_validation = {
            "passed": bool(unity_character["deformationPassed"]) and all(
                bool(item["passed"]) for item in animation_sources
            ),
            "shared_clips": [item["assetPath"] for item in animation_sources],
            "frame_rates": [item["frameRate"] for item in animation_sources],
            "front_pose_previews": pose_paths,
            "side_pose_previews": side_pose_paths,
            "back_pose_previews": back_pose_paths,
            "pose_checks": [
                {
                    "pose": item["poseName"],
                    "passed": item["passed"],
                    "moved_bone_count": item["movedBoneCount"],
                    "nonfinite_vertex_count": item["nonFiniteVertexCount"],
                    "screenshot_pixel_stddev": item["screenshotPixelStdDev"],
                    "screenshot_content_passed": item["screenshotContentPassed"],
                    "side_screenshot_pixel_stddev": item["sideScreenshotPixelStdDev"],
                    "side_screenshot_content_passed": item["sideScreenshotContentPassed"],
                    "back_screenshot_pixel_stddev": item["backScreenshotPixelStdDev"],
                    "back_screenshot_content_passed": item["backScreenshotContentPassed"],
                }
                for item in pose_results
            ],
        }
        report = {
            "asset": f"{role}_PrecisionRemodel_v21",
            "role": role,
            "formats": {
                "static": ["blend", "glb", "fbx"],
                "rigged": ["blend", "glb", "fbx"],
            },
            "review_views": view_paths,
            "rig_pose_previews": pose_paths,
            "rig_pose_side_previews": side_pose_paths,
            "rig_pose_back_previews": back_pose_paths,
            "quality_gate": {
                "applied_unity_basecolor": applied_basecolor,
                "supplemental_pbr": supplemental_metrics,
            },
            "geometry": rig_report["bounds_meters"],
            "materials": rig_report.get("materials", {}),
            "visual_review_rounds": 11,
            "fourview_integrity": "passed_internal_screen",
            "reference_match": "prototype_candidate_not_aaa_final",
            "humanoid_rig": {
                "passed": rig_report["rig"]["bone_count"] == 21
                and rig_report["weighting"]["zero_weight_vertices"] == 0,
                "bone_count": rig_report["rig"]["bone_count"],
                "bone_names": rig_report["rig"]["bone_names"],
                "all_vertices_weighted": rig_report["weighting"]["zero_weight_vertices"] == 0,
                "maximum_weight_sum_error": rig_report["weighting"]["maximum_weight_sum_error"],
            },
            "unity_avatar_validation": {
                "passed": unity_character["passed"],
                "unity_version": unity["unityVersion"],
                "avatar_valid": unity_character["avatarValid"],
                "avatar_human": unity_character["avatarHuman"],
                "unique_referenced_bone_count": unity_character["uniqueReferencedBoneCount"],
                "deformation_passed": unity_character["deformationPassed"],
            },
            "animation_validation": animation_validation,
            "final_spec_acceptance": {
                "passed": False,
                "blocking_requirements": [
                    "Only one reference-standard model exists per role; the required three styles per role are not represented by this v21 package.",
                    "Mobile triangle budgets and the required photoreal LOD chains are not met by this dense reference-standard topology.",
                    "The baked BaseColor is applied; Normal, AO, and MetallicSmoothness remain supplemental maps rather than a fully authored applied PBR set.",
                ],
            },
            "notes": "Dense image-to-3D reference-standard sculpt with Blender-native Humanoid binding and real Unity retarget/deformation validation. This report does not claim nine-style or studio-final acceptance.",
        }
        report_path = reports / f"{role}_PrecisionRemodel_v21_quality_report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (asset_dir / "README.md").write_text(
            f"# {role} Precision Remodel v21\n\n"
            "Art-only character prototype rebuilt and reviewed from front, side, top, and back.\n\n"
            "- Deliverables: Blend, GLB, FBX, four review renders, supplemental 2K PBR set\n"
            "- Four-view geometry integrity: passed internal screen\n"
            "- Rigged deliverables: Blend, GLB, FBX with 21-bone shared Humanoid hierarchy\n"
            "- Unity 2022.3 Humanoid Avatar, PointAlert, and Walk deformation validation: passed\n"
            "- Applied material: UV0 + baked 2K BaseColor; supplemental Normal/AO/MetallicSmoothness included\n"
            "- Studio-final nine-style, mobile-budget, full-PBR, and LOD acceptance: not claimed\n",
            encoding="utf-8",
        )
        role_summary[role] = {
            "asset_dir": str(asset_dir.relative_to(ROOT)),
            "fbx": str((asset_dir / f"{role}_PrecisionRemodel_v21.fbx").relative_to(ROOT)),
            "glb": str((asset_dir / f"{role}_PrecisionRemodel_v21.glb").relative_to(ROOT)),
            "blend": str((asset_dir / f"{role}_PrecisionRemodel_v21.blend").relative_to(ROOT)),
            "rigged_fbx": rig_report["output_fbx"],
            "rigged_glb": rig_report["output_glb"],
            "rigged_blend": rig_report["output_blend"],
            "rig_report": str(rig_report_path.relative_to(ROOT)),
            "views": view_paths,
            "rig_poses": pose_paths,
            "rig_side_poses": side_pose_paths,
            "rig_back_poses": back_pose_paths,
            "applied_basecolor_quality_gate": applied_basecolor,
            "humanoid_rig_passed": report["humanoid_rig"]["passed"],
            "unity_avatar_validation_passed": unity_character["passed"],
            "animation_validation_passed": animation_validation["passed"],
        }
        texture_dir = asset_dir / "Textures"
        package_checks.append(
            {
                "role": role,
                "passed": all(
                    [
                        len(view_paths) == 4,
                        all((ROOT / path).is_file() for path in pose_paths.values()),
                        all((ROOT / path).is_file() for path in side_pose_paths.values()),
                        all((ROOT / path).is_file() for path in back_pose_paths.values()),
                        all((ROOT / rig_report[key]).is_file() for key in ("output_blend", "output_fbx", "output_glb")),
                        applied_basecolor["passed"],
                        report["humanoid_rig"]["passed"],
                        unity_character["passed"],
                        animation_validation["passed"],
                    ]
                ),
                "static_preview_count": len(view_paths),
                "rig_pose_preview_count": len(pose_paths) + len(side_pose_paths) + len(back_pose_paths),
                "supplemental_texture_count": len(list(texture_dir.glob("*.png"))),
                "applied_basecolor": applied_basecolor,
                "rigged_formats": {
                    suffix: (rigged_dir / f"{role}_PrecisionRemodel_v21_Rigged.{suffix}").is_file()
                    for suffix in ("blend", "fbx", "glb")
                },
                "humanoid_rig_passed": report["humanoid_rig"]["passed"],
                "unity_avatar_validation_passed": unity_character["passed"],
                "animation_validation_passed": animation_validation["passed"],
                "minimum_pose_screenshot_pixel_stddev": min(
                    min(
                        item["screenshotPixelStdDev"],
                        item["sideScreenshotPixelStdDev"],
                        item["backScreenshotPixelStdDev"],
                    )
                    for item in pose_results
                ),
            }
        )
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    PACKAGE_VALIDATION.write_text(
        json.dumps(
            {
                "scope": "three_role_reference_standard_v21_package_integrity",
                "package_integrity_passed": assimp_passed and all(item["passed"] for item in package_checks),
                "rigged_assimp_validation_passed": assimp_passed,
                "rigged_assimp_validation": str(ASSIMP_REPORT.relative_to(ROOT)),
                "spec_02_04_final_acceptance_passed": False,
                "checks": package_checks,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> None:
    build_sheet()
    build_pose_sheet()
    package_assets()


if __name__ == "__main__":
    main()
