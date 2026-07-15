#!/usr/bin/env python3
"""Generate role/style character PBR texture sets.

Main clothing maps are derived from downloaded CC0 Poly Haven sources. Accent
maps are deterministic atlases for skin, hair, metal/badge, and rubber/plastic
details so each character can stay within a two-material budget.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "art-source" / "_Source" / "PBR" / "PolyHaven"
CHAR_DIR = ROOT / "art-source" / "Characters"

THRESHOLDS = {
    "basecolor": 8.0,
    "normal": 4.0,
    "ao": 3.0,
}

STYLE_RESOLUTION = {
    "Stylized": ("2K", 2048, "2k"),
    "Photoreal": ("4K", 4096, "4k"),
    "BlindBox": ("2K", 2048, "2k"),
}

ROLE_SOURCE = {
    "Kid": "denim_fabric",
    "Villain": "fabric_leather_01",
    "Police": "denim_fabric_03",
}

MAIN_TINTS = {
    ("Kid", "Stylized"): (33, 49, 78),
    ("Kid", "Photoreal"): (28, 42, 67),
    ("Kid", "BlindBox"): (27, 48, 94),
    ("Villain", "Stylized"): (34, 34, 32),
    ("Villain", "Photoreal"): (31, 30, 28),
    ("Villain", "BlindBox"): (30, 35, 40),
    ("Police", "Stylized"): (17, 35, 62),
    ("Police", "Photoreal"): (14, 28, 52),
    ("Police", "BlindBox"): (19, 43, 82),
}

ACCENT_TONES = {
    "Kid": {
        "skin": (214, 157, 119),
        "hair": (44, 32, 25),
        "metal": (210, 198, 178),
        "rubber": (31, 34, 39),
    },
    "Villain": {
        "skin": (142, 96, 74),
        "hair": (18, 16, 15),
        "metal": (76, 74, 70),
        "rubber": (12, 13, 13),
    },
    "Police": {
        "skin": (197, 137, 101),
        "hair": (35, 27, 23),
        "metal": (218, 193, 129),
        "rubber": (18, 19, 22),
    },
}


def find_source(asset_id: str, resolution: str, map_name: str) -> Path:
    folder = SOURCE_ROOT / asset_id / resolution
    matches = sorted(folder.glob(f"{asset_id}_{map_name}_{resolution}.*"))
    if not matches:
        raise FileNotFoundError(f"Missing source map {asset_id} {resolution} {map_name}")
    return matches[0]


def open_rgb(path: Path, size: int) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if img.size != (size, size):
        img = img.resize((size, size), Image.Resampling.LANCZOS)
    return np.asarray(img, dtype=np.float32)


def save_rgb(arr: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(arr, 0, 255).astype(np.uint8)
    Image.fromarray(clipped, "RGB").save(path, optimize=True)


def stddev(path: Path, kind: str) -> dict:
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    value = float(img.std())
    threshold = THRESHOLDS[kind]
    return {
        "file": str(path.relative_to(ROOT)),
        "kind": kind,
        "stddev": round(value, 2),
        "threshold": threshold,
        "passed": value >= threshold,
    }


def tint_source(diffuse: np.ndarray, tint: tuple[int, int, int], style: str) -> np.ndarray:
    lum = diffuse.mean(axis=2)
    lum = (lum - lum.min()) / max(float(lum.max() - lum.min()), 1.0)
    weave = (lum - 0.5)[:, :, None]
    tint_arr = np.array(tint, dtype=np.float32)[None, None, :]
    source_chroma = diffuse - diffuse.mean(axis=2, keepdims=True)
    contrast = 95.0 if style == "Photoreal" else 78.0
    if style == "BlindBox":
        contrast = 54.0
    if max(tint) < 48:
        base = tint_arr * (0.66 + lum[:, :, None] * 1.18) + weave * (contrast * 0.35) + source_chroma * 0.34
    else:
        base = tint_arr + weave * contrast + source_chroma * 0.22
    return np.clip(base, 0, 255)


def add_tailored_marks(base: np.ndarray, role: str, style: str) -> np.ndarray:
    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    w, h = img.size
    rng = np.random.default_rng(abs(hash((role, style, "marks"))) % (2**32))

    # Fine stitch lines and wear marks. These are not geometry substitutes; they
    # help the PBR map read as fabric/leather instead of a uniform tint.
    for i in range(0, w, max(w // 32, 32)):
        alpha = 34 if role != "Villain" else 44
        draw.line([(i, 0), (i + w // 12, h)], fill=(220, 220, 220, alpha), width=max(1, w // 512))
    scratch_count = 140 if role == "Villain" and style == "Photoreal" else 90 if style == "Photoreal" else 72 if role == "Villain" else 42
    for _ in range(scratch_count):
        x = int(rng.integers(0, w))
        y = int(rng.integers(0, h))
        length = int(rng.integers(w // 80, w // 16))
        max_alpha = 58 if role == "Villain" else 38
        color = (255, 255, 255, int(rng.integers(12, max_alpha)))
        draw.line([(x, y), (min(w, x + length), min(h, y + int(length * 0.18)))], fill=color, width=1)

    if role == "Police":
        stripe = (65, 116, 174, 92) if style != "BlindBox" else (80, 138, 208, 120)
        draw.rectangle([w * 0.08, 0, w * 0.12, h], fill=stripe)
        draw.rectangle([w * 0.88, 0, w * 0.92, h], fill=stripe)
    elif role == "Villain":
        draw.rectangle([w * 0.46, 0, w * 0.54, h], fill=(0, 0, 0, 72))
    elif role == "Kid":
        draw.rectangle([w * 0.44, 0, w * 0.56, h], fill=(18, 27, 46, 48))
    return np.asarray(img, dtype=np.float32)


def normal_from_height(height: np.ndarray, strength: float) -> np.ndarray:
    h = height.astype(np.float32)
    gy, gx = np.gradient(h)
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(h)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack((nx / length, ny / length, nz / length), axis=2)
    return (normal * 0.5 + 0.5) * 255.0


def generate_main_maps(role: str, style: str, size: int, source_res: str, out: Path) -> dict:
    asset_id = ROLE_SOURCE[role]
    diffuse = open_rgb(find_source(asset_id, source_res, "BaseColor"), size)
    normal = open_rgb(find_source(asset_id, source_res, "Normal"), size)
    ao = open_rgb(find_source(asset_id, source_res, "AO"), size)
    rough = open_rgb(find_source(asset_id, source_res, "Roughness"), size)

    base = tint_source(diffuse, MAIN_TINTS[(role, style)], style)
    base = add_tailored_marks(base, role, style)
    if style == "BlindBox":
        # Toy finish keeps real pattern underneath but shifts toward lacquered
        # plastic with fewer stains and stronger broad gradients.
        smooth = np.asarray(Image.fromarray(base.astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(radius=1.3)), dtype=np.float32)
        base = base * 0.35 + smooth * 0.65
        normal = normal * 0.58 + np.array([128, 128, 255], dtype=np.float32)
        ao = ao * 0.45 + 140

    smoothness = 255.0 - rough.mean(axis=2)
    if style == "BlindBox":
        smoothness = np.clip(smoothness + 92, 0, 255)
    metallic = np.zeros_like(smoothness)
    metallic_smoothness = np.stack((metallic, smoothness, smoothness), axis=2)

    label, _, _ = STYLE_RESOLUTION[style]
    paths = {
        "BaseColor": out / f"Char_{role}_{style}_Main_BaseColor_{label}.png",
        "Normal": out / f"Char_{role}_{style}_Main_Normal_{label}.png",
        "AO": out / f"Char_{role}_{style}_Main_AO_{label}.png",
        "MetallicSmoothness": out / f"Char_{role}_{style}_Main_MetallicSmoothness_{label}.png",
    }
    save_rgb(base, paths["BaseColor"])
    save_rgb(normal, paths["Normal"])
    save_rgb(ao, paths["AO"])
    save_rgb(metallic_smoothness, paths["MetallicSmoothness"])
    return {
        "material": "Main",
        "source_asset": asset_id,
        "source_url": f"https://polyhaven.com/a/{asset_id}",
        "texture_paths": {k: str(v.relative_to(ROOT)) for k, v in paths.items()},
        "checks": [
            stddev(paths["BaseColor"], "basecolor"),
            stddev(paths["Normal"], "normal"),
            stddev(paths["AO"], "ao"),
        ],
    }


def noise(size: int, seed: int, blur: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    arr = rng.normal(0, 1, (size, size)).astype(np.float32)
    arr = (arr - arr.min()) / max(float(arr.max() - arr.min()), 1e-5)
    img = Image.fromarray((arr * 255).astype(np.uint8), "L")
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(radius=blur))
    return np.asarray(img, dtype=np.float32) / 255.0


def quadrant_base(size: int, color: tuple[int, int, int], seed: int, material: str) -> np.ndarray:
    if material == "skin":
        n1 = noise(size, seed, blur=3.5)
        n2 = noise(size, seed + 101, blur=12.0)
    else:
        n1 = noise(size, seed, blur=0.5)
        n2 = noise(size, seed + 101, blur=4.0)
    color_arr = np.array(color, dtype=np.float32)[None, None, :]
    if material == "skin":
        arr = color_arr + (n1[:, :, None] - 0.5) * 8 + (n2[:, :, None] - 0.5) * 14
    else:
        arr = color_arr + (n1[:, :, None] - 0.5) * 26 + (n2[:, :, None] - 0.5) * 36
    yy, xx = np.mgrid[0:size, 0:size]
    if material == "hair":
        stripes = (np.sin(xx / max(size / 26, 1) + n2 * 2.5) + 1) * 0.5
        arr -= stripes[:, :, None] * 34
    elif material == "metal":
        glint = np.clip(1.0 - np.abs((xx - yy) / max(size * 0.42, 1)), 0, 1)
        arr += glint[:, :, None] * 62
    elif material == "rubber":
        tread = ((xx // max(size // 18, 1)) % 2) * 18
        arr -= tread[:, :, None]
    elif material == "skin":
        freckles = noise(size, seed + 303, blur=0.0)
        sparse = freckles > 0.985
        arr[:, :, 0] += sparse * 18
        arr[:, :, 1] -= sparse * 5
    return np.clip(arr, 0, 255)


def generate_accent_atlas(role: str, style: str, size: int, out: Path) -> dict:
    tones = ACCENT_TONES[role]
    half = size // 2
    seed_base = abs(hash((role, style, "accent"))) % (2**31)
    base = np.zeros((size, size, 3), dtype=np.float32)
    heights = np.zeros((size, size), dtype=np.float32)
    smoothness = np.zeros((size, size), dtype=np.float32)
    metallic = np.zeros((size, size), dtype=np.float32)

    quads = {
        "skin": (0, half, tones["skin"], 0),
        "hair": (half, half, tones["hair"], 1),
        "metal": (0, 0, tones["metal"], 2),
        "rubber": (half, 0, tones["rubber"], 3),
    }
    smooth_by_material = {"skin": 72, "hair": 58, "metal": 210, "rubber": 118}
    metal_by_material = {"skin": 0, "hair": 0, "metal": 230, "rubber": 0}
    if style == "BlindBox":
        smooth_by_material.update({"skin": 185, "hair": 202, "rubber": 190})

    for material, (x0, y0, color, idx) in quads.items():
        quad = quadrant_base(half, color, seed_base + idx * 1009, material)
        if material == "skin":
            h = 0.48 + noise(half, seed_base + idx * 1709, blur=8.0) * 0.12
        else:
            h = noise(half, seed_base + idx * 1709, blur=0.45)
        base[y0:y0 + half, x0:x0 + half, :] = quad
        heights[y0:y0 + half, x0:x0 + half] = h
        smoothness[y0:y0 + half, x0:x0 + half] = smooth_by_material[material] + (h - 0.5) * 38
        metallic[y0:y0 + half, x0:x0 + half] = metal_by_material[material]

    normal = normal_from_height(heights, strength=8.0 if style != "BlindBox" else 5.0)
    ao = np.clip(178 + (heights - 0.5) * 145, 0, 255)
    ao = np.stack((ao, ao, ao), axis=2)
    metallic_smoothness = np.stack((metallic, smoothness, smoothness), axis=2)

    label, _, _ = STYLE_RESOLUTION[style]
    paths = {
        "BaseColor": out / f"Char_{role}_{style}_Accent_BaseColor_{label}.png",
        "Normal": out / f"Char_{role}_{style}_Accent_Normal_{label}.png",
        "AO": out / f"Char_{role}_{style}_Accent_AO_{label}.png",
        "MetallicSmoothness": out / f"Char_{role}_{style}_Accent_MetallicSmoothness_{label}.png",
    }
    save_rgb(base, paths["BaseColor"])
    save_rgb(normal, paths["Normal"])
    save_rgb(ao, paths["AO"])
    save_rgb(metallic_smoothness, paths["MetallicSmoothness"])
    return {
        "material": "AccentAtlas",
        "source_asset": "procedural_atlas_derived_from_role_material_brief",
        "source_url": None,
        "atlas_quadrants": {
            "skin": [0.0, 0.5, 0.5, 1.0],
            "hair": [0.5, 0.5, 1.0, 1.0],
            "metal": [0.0, 0.0, 0.5, 0.5],
            "rubber": [0.5, 0.0, 1.0, 0.5],
        },
        "texture_paths": {k: str(v.relative_to(ROOT)) for k, v in paths.items()},
        "checks": [
            stddev(paths["BaseColor"], "basecolor"),
            stddev(paths["Normal"], "normal"),
            stddev(paths["AO"], "ao"),
        ],
    }


def generate(role: str, style: str) -> dict:
    label, size, source_res = STYLE_RESOLUTION[style]
    out = CHAR_DIR / role / style / "Textures"
    main = generate_main_maps(role, style, size, source_res, out)
    accent = generate_accent_atlas(role, style, size, out)
    checks = main["checks"] + accent["checks"]
    report = {
        "asset": f"{role}_{style}",
        "texture_resolution": label,
        "materials": [main, accent],
        "quality_gate": {
            "texture_checks": checks,
            "all_textures_passed": all(item["passed"] for item in checks),
            "min_basecolor_stddev": min(item["stddev"] for item in checks if item["kind"] == "basecolor"),
            "min_normal_stddev": min(item["stddev"] for item in checks if item["kind"] == "normal"),
            "min_ao_stddev": min(item["stddev"] for item in checks if item["kind"] == "ao"),
        },
    }
    report_path = CHAR_DIR / role / style / "Reports" / f"{role}_{style}_texture_metrics.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> int:
    outputs = []
    for role in ("Kid", "Villain", "Police"):
        for style in ("Stylized", "Photoreal", "BlindBox"):
            outputs.append(generate(role, style))
    summary = {
        "asset_count": len(outputs),
        "all_textures_passed": all(o["quality_gate"]["all_textures_passed"] for o in outputs),
        "assets": [
            {
                "asset": o["asset"],
                "texture_resolution": o["texture_resolution"],
                "min_basecolor_stddev": o["quality_gate"]["min_basecolor_stddev"],
                "min_normal_stddev": o["quality_gate"]["min_normal_stddev"],
                "min_ao_stddev": o["quality_gate"]["min_ao_stddev"],
                "passed": o["quality_gate"]["all_textures_passed"],
            }
            for o in outputs
        ],
    }
    summary_path = ROOT / "docs" / "art_production" / "CHARACTER_TEXTURE_QUALITY_SUMMARY.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["all_textures_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
