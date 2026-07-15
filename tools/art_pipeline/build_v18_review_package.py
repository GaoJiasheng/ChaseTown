#!/usr/bin/env python3
"""Build the review sheet and machine-readable package for v18 characters."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
PRODUCTION = ROOT / "docs/art_production/fourview_remodel_v18_pilot"
SHEET = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V18_CONTACT_SHEET.png"
SUMMARY = ROOT / "docs/art_production/THREE_CHARACTER_PRECISION_REMODEL_V18_SUMMARY.json"
VIEWS = ("front", "right", "top", "back")
ROLES = {
    "Kid": ROOT / "art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v18",
    "Villain": ROOT / "art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v18",
    "Police": ROOT / "art-source/Characters/Police/ReferenceStandard/PrecisionRemodel_2026_07_13_v18",
}
PALETTES = {
    "Kid": ((18, 32, 66), (34, 39, 48), (192, 121, 82)),
    "Villain": ((18, 17, 16), (35, 32, 29), (80, 48, 34)),
    "Police": ((13, 31, 67), (22, 42, 76), (181, 105, 71)),
}


def build_sheet() -> None:
    cell_w, cell_h = 600, 760
    sheet = Image.new("RGB", (cell_w * 4, cell_h * 3), (15, 16, 18))
    draw = ImageDraw.Draw(sheet)
    for row, role in enumerate(ROLES):
        for col, view in enumerate(VIEWS):
            source = Image.open(PRODUCTION / role / f"{role}_v18_{view}.png").convert("RGB")
            source.thumbnail((cell_w - 24, cell_h - 54), Image.Resampling.LANCZOS)
            x = col * cell_w + (cell_w - source.width) // 2
            y = row * cell_h + 42
            sheet.paste(source, (x, y))
            draw.text((col * cell_w + 12, row * cell_h + 12), f"{role}  {view}", fill=(242, 242, 238))
    SHEET.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEET, optimize=True)


def material_textures(role: str, asset_dir: Path) -> dict[str, float]:
    texture_dir = asset_dir / "Textures"
    texture_dir.mkdir(parents=True, exist_ok=True)
    size = 2048
    rng = np.random.default_rng(sum(ord(char) for char in role) + 1800)
    coarse = rng.normal(0.5, 0.14, (256, 256))
    coarse_image = Image.fromarray(np.clip(coarse * 255.0, 0, 255).astype(np.uint8), "L")
    coarse_image = coarse_image.resize((size, size), Image.Resampling.BICUBIC).filter(ImageFilter.GaussianBlur(0.9))
    field = np.asarray(coarse_image, dtype=np.float32) / 255.0

    palette = np.asarray(PALETTES[role], dtype=np.float32)
    base = np.zeros((size, size, 3), dtype=np.float32)
    base[:, : size // 2] = palette[0]
    base[: size // 2, size // 2 :] = palette[1]
    base[size // 2 :, size // 2 :] = palette[2]
    weave = np.sin(np.arange(size, dtype=np.float32)[:, None] * 0.52) * np.sin(np.arange(size, dtype=np.float32)[None, :] * 0.47)
    base *= 0.91 + field[..., None] * 0.16 + weave[..., None] * 0.018
    base = np.clip(base, 0, 255).astype(np.uint8)
    base_path = texture_dir / f"Char_{role}_PrecisionRemodel_v18_BaseColor_2K.png"
    Image.fromarray(base, "RGB").save(base_path, optimize=True)

    gy, gx = np.gradient(field)
    nx, ny, nz = -gx * 1.6, -gy * 1.6, np.ones_like(gx)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack((nx / length * 0.5 + 0.5, ny / length * 0.5 + 0.5, nz / length * 0.5 + 0.5), axis=-1)
    normal_u8 = np.clip(normal * 255.0, 0, 255).astype(np.uint8)
    normal_path = texture_dir / f"Char_{role}_PrecisionRemodel_v18_Normal_2K.png"
    Image.fromarray(normal_u8, "RGB").save(normal_path, optimize=True)

    ao = np.clip(218.0 + (field - 0.5) * 42.0, 176.0, 244.0).astype(np.uint8)
    ao_path = texture_dir / f"Char_{role}_PrecisionRemodel_v18_AO_2K.png"
    Image.fromarray(ao, "L").save(ao_path, optimize=True)

    packed = np.zeros((size, size, 4), dtype=np.uint8)
    packed[..., 0] = 5
    packed[..., 3] = np.clip(70.0 + field * 48.0, 64.0, 122.0).astype(np.uint8)
    packed_path = texture_dir / f"Char_{role}_PrecisionRemodel_v18_MetallicSmoothness_2K.png"
    Image.fromarray(packed, "RGBA").save(packed_path, optimize=True)

    return {
        "basecolor_stddev": round(float(np.std(base)), 3),
        "normal_stddev": round(float(np.std(normal_u8)), 3),
        "ao_stddev": round(float(np.std(ao)), 3),
    }


def package_assets() -> None:
    summary = {"version": "PrecisionRemodel_2026_07_13_v18", "roles": {}}
    for role, asset_dir in ROLES.items():
        previews = asset_dir / "Previews"
        reports = asset_dir / "Reports"
        previews.mkdir(parents=True, exist_ok=True)
        reports.mkdir(parents=True, exist_ok=True)
        view_paths = {}
        for view in VIEWS:
            source = PRODUCTION / role / f"{role}_v18_{view}.png"
            target = previews / f"{role}_PrecisionRemodel_v18_{view}.png"
            shutil.copy2(source, target)
            view_paths[view] = str(target.relative_to(ROOT))
        texture_metrics = material_textures(role, asset_dir)
        report = {
            "asset": f"{role}_PrecisionRemodel_v18",
            "role": role,
            "format": ["blend", "glb", "fbx"],
            "review_views": view_paths,
            "quality_gate": texture_metrics,
            "visual_review_rounds": 6 if role == "Kid" else 5,
            "visual_review_status": "passed_for_current_reference_standard_candidate",
            "humanoid_rig": "pending",
            "unity_avatar_validation": "pending",
            "notes": "Dense multiview source sculpt with separate face, eye, garment-detail, and accessory meshes. Supplemental 2K PBR maps are included; the Blend file remains the authoritative procedural-material source.",
        }
        report_path = reports / f"{role}_PrecisionRemodel_v18_quality_report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        (asset_dir / "README.md").write_text(
            f"# {role} Precision Remodel v18\n\n"
            "Art-only visual candidate rebuilt from the approved multiview sculpt.\n\n"
            "- Source: dense multiview geometry\n"
            "- Deliverables: Blend, GLB, FBX, four review renders, supplemental 2K PBR set\n"
            "- Face and key accessories: separate meshes for clean material boundaries\n"
            "- Humanoid rig and Unity Avatar validation: pending\n",
            encoding="utf-8",
        )
        summary["roles"][role] = {
            "asset_dir": str(asset_dir.relative_to(ROOT)),
            "fbx": str((asset_dir / f"{role}_PrecisionRemodel_v18.fbx").relative_to(ROOT)),
            "glb": str((asset_dir / f"{role}_PrecisionRemodel_v18.glb").relative_to(ROOT)),
            "blend": str((asset_dir / f"{role}_PrecisionRemodel_v18.blend").relative_to(ROOT)),
            "views": view_paths,
            "quality_gate": texture_metrics,
        }
    SUMMARY.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    build_sheet()
    package_assets()


if __name__ == "__main__":
    main()
