#!/usr/bin/env python3
"""Prepare environment PBR texture sets from downloaded CC0 Poly Haven maps."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "art-source" / "_Source" / "PBR" / "PolyHaven"
OUT = ROOT / "art-source" / "Environment" / "SharedTextures"

THRESHOLDS = {"basecolor": 8.0, "normal": 4.0, "ao": 3.0}

MATERIALS = {
    "PaintedWall": {"source": "painted_plaster_wall", "tint": (178, 190, 184), "metallic": 0, "smoothness_boost": 0},
    "HallwayTile": {"source": "blue_floor_tiles_01", "tint": None, "metallic": 0, "smoothness_boost": 22},
    "ClassroomWood": {"source": "wood_floor_worn", "tint": (150, 104, 62), "metallic": 0, "smoothness_boost": 0},
    "PlaygroundRubber": {"source": "rubberized_track", "tint": (96, 53, 48), "metallic": 0, "smoothness_boost": 10},
    "Grass": {"source": "leafy_grass", "tint": (82, 115, 62), "metallic": 0, "smoothness_boost": -12},
    "BluePaintedMetal": {"source": "blue_metal_plate", "tint": (38, 74, 116), "metallic": 80, "smoothness_boost": 34},
    "RedPaintedMetal": {"source": "blue_metal_plate", "tint": (156, 32, 28), "metallic": 70, "smoothness_boost": 28},
    "WoodTrim": {"source": "brown_planks_07", "tint": (130, 82, 45), "metallic": 0, "smoothness_boost": 6},
    "WornMetal": {"source": "metal_plate", "tint": (118, 116, 108), "metallic": 170, "smoothness_boost": 20},
    "Blackboard": {"source": "painted_plaster_wall", "tint": (28, 58, 50), "metallic": 0, "smoothness_boost": -8},
    "Paper": {"source": "painted_plaster_wall", "tint": (220, 207, 176), "metallic": 0, "smoothness_boost": -20},
    "RubberBlack": {"source": "rubberized_track", "tint": (48, 49, 51), "metallic": 0, "smoothness_boost": 8},
    "GlassBlue": {"source": "blue_floor_tiles_01", "tint": (84, 126, 158), "metallic": 0, "smoothness_boost": 76},
}


def find_source(asset_id: str, map_name: str) -> Path:
    matches = sorted((SOURCE_ROOT / asset_id / "2k").glob(f"{asset_id}_{map_name}_2k.*"))
    if not matches:
        raise FileNotFoundError(f"Missing {asset_id} {map_name} 2k source")
    return matches[0]


def open_rgb(path: Path) -> np.ndarray:
    img = Image.open(path).convert("RGB")
    if img.size != (2048, 2048):
        img = img.resize((2048, 2048), Image.Resampling.LANCZOS)
    return np.asarray(img, dtype=np.float32)


def save_rgb(arr: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB").save(path, optimize=True)


def tint(diffuse: np.ndarray, tint_color: tuple[int, int, int] | None) -> np.ndarray:
    if tint_color is None:
        return diffuse
    lum = diffuse.mean(axis=2)
    lum = (lum - lum.min()) / max(float(lum.max() - lum.min()), 1.0)
    tint_arr = np.array(tint_color, dtype=np.float32)[None, None, :]
    chroma = diffuse - diffuse.mean(axis=2, keepdims=True)
    return np.clip(tint_arr * (0.62 + lum[:, :, None] * 0.72) + chroma * 0.18, 0, 255)


def add_module_marks(arr: np.ndarray, name: str) -> np.ndarray:
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    draw = ImageDraw.Draw(img, "RGBA")
    w, h = img.size
    if name == "PaintedWall":
        for y in range(0, h, h // 8):
            draw.line([(0, y), (w, y + h // 20)], fill=(230, 230, 230, 28), width=3)
    elif name == "BluePaintedMetal":
        for x in range(w // 12, w, w // 6):
            draw.line([(x, 0), (x + w // 18, h)], fill=(15, 25, 40, 56), width=4)
    elif name == "WornMetal":
        for x in range(0, w, w // 14):
            draw.line([(x, 0), (x + w // 9, h)], fill=(240, 240, 220, 35), width=2)
    elif name == "RubberBlack":
        pixels = np.asarray(img, dtype=np.float32)
        yy, xx = np.indices((h, w), dtype=np.float32)
        tread_a = ((xx + yy * 0.72) % 220) < 26
        tread_b = ((xx - yy * 0.55 + 80) % 260) < 18
        fine_scuff = np.sin(xx * 0.021) + np.sin(yy * 0.037) + np.sin((xx + yy) * 0.011)
        pixels += tread_a[:, :, None] * -18.0
        pixels += tread_b[:, :, None] * 12.0
        pixels += fine_scuff[:, :, None] * 4.0
        img = Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8), "RGB")
        draw = ImageDraw.Draw(img, "RGBA")
        for y in range(96, h, 190):
            draw.line([(0, y), (w, y + h // 8)], fill=(118, 118, 118, 30), width=5)
        for x in range(64, w, 180):
            draw.line([(x, 0), (x + w // 10, h)], fill=(5, 5, 5, 42), width=7)
    return np.asarray(img, dtype=np.float32)


def check(path: Path, kind: str) -> dict:
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    value = float(img.std())
    return {
        "file": str(path.relative_to(ROOT)),
        "kind": kind,
        "stddev": round(value, 2),
        "threshold": THRESHOLDS[kind],
        "passed": value >= THRESHOLDS[kind],
    }


def generate(name: str, config: dict) -> dict:
    source = config["source"]
    diffuse = open_rgb(find_source(source, "BaseColor"))
    normal = open_rgb(find_source(source, "Normal"))
    ao = open_rgb(find_source(source, "AO"))
    rough = open_rgb(find_source(source, "Roughness"))

    base = add_module_marks(tint(diffuse, config["tint"]), name)
    smoothness = np.clip(255.0 - rough.mean(axis=2) + config["smoothness_boost"], 0, 255)
    metallic = np.full_like(smoothness, config["metallic"])
    metallic_smoothness = np.stack((metallic, smoothness, smoothness), axis=2)

    paths = {
        "BaseColor": OUT / f"Env_{name}_BaseColor_2K.png",
        "Normal": OUT / f"Env_{name}_Normal_2K.png",
        "AO": OUT / f"Env_{name}_AO_2K.png",
        "MetallicSmoothness": OUT / f"Env_{name}_MetallicSmoothness_2K.png",
    }
    save_rgb(base, paths["BaseColor"])
    save_rgb(normal, paths["Normal"])
    save_rgb(ao, paths["AO"])
    save_rgb(metallic_smoothness, paths["MetallicSmoothness"])
    checks = [check(paths["BaseColor"], "basecolor"), check(paths["Normal"], "normal"), check(paths["AO"], "ao")]
    return {
        "material": name,
        "source_asset": source,
        "source_url": f"https://polyhaven.com/a/{source}",
        "texture_paths": {k: str(v.relative_to(ROOT)) for k, v in paths.items()},
        "checks": checks,
        "passed": all(item["passed"] for item in checks),
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    materials = [generate(name, config) for name, config in MATERIALS.items()]
    summary = {
        "material_count": len(materials),
        "all_textures_passed": all(item["passed"] for item in materials),
        "materials": materials,
    }
    path = ROOT / "docs" / "art_production" / "ENVIRONMENT_TEXTURE_QUALITY_SUMMARY.json"
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["all_textures_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
