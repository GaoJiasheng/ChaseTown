#!/usr/bin/env python3
"""Generate procedural PBR texture sets for the Chasing environment assets.

The output is not a substitute for scanned/Substance production textures, but it
creates real texture files with the channel layout expected by docs/02 so FBX
packages can be imported and reviewed in Unity.
"""

from __future__ import annotations

from pathlib import Path
import math
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "art-source" / "Environment" / "SharedTextures"
SIZE = 2048


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def save_rgb(path: Path, arr: np.ndarray) -> None:
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    Image.fromarray(arr, "RGB").save(path)


def save_rgba(path: Path, arr: np.ndarray) -> None:
    arr = np.clip(arr, 0, 255).astype(np.uint8)
    Image.fromarray(arr, "RGBA").save(path)


def noise(size: int, seed: int, strength: float = 1.0, blur: float = 0.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    arr = rng.normal(0.0, 1.0, (size, size)).astype(np.float32)
    arr = (arr - arr.min()) / max(arr.max() - arr.min(), 1e-5)
    if blur > 0:
        img = Image.fromarray(np.uint8(arr * 255), "L").filter(ImageFilter.GaussianBlur(blur))
        arr = np.asarray(img).astype(np.float32) / 255.0
    return arr * strength


def normal_from_height(height: np.ndarray, strength: float = 4.0) -> np.ndarray:
    dy, dx = np.gradient(height.astype(np.float32))
    nx = -dx * strength
    ny = -dy * strength
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack((nx / length, ny / length, nz / length), axis=-1)
    return ((normal * 0.5 + 0.5) * 255).astype(np.uint8)


def ms_map(size: int, metallic: int, smoothness: int) -> np.ndarray:
    arr = np.zeros((size, size, 4), dtype=np.uint8)
    arr[..., 0] = metallic
    arr[..., 3] = smoothness
    return arr


def ao_from_height(height: np.ndarray, amount: float = 0.35) -> np.ndarray:
    local = Image.fromarray(np.uint8(height * 255), "L").filter(ImageFilter.GaussianBlur(8))
    local_arr = np.asarray(local).astype(np.float32) / 255.0
    ao = 1.0 - np.clip((local_arr.max() - local_arr) * amount, 0, 0.45)
    return np.repeat(np.uint8(ao[..., None] * 255), 3, axis=2)


def add_grout(draw: ImageDraw.ImageDraw, step: int, line: int, color: tuple[int, int, int]) -> None:
    for x in range(0, SIZE + step, step):
        draw.rectangle((x - line, 0, x + line, SIZE), fill=color)
    for y in range(0, SIZE + step, step):
        draw.rectangle((0, y - line, SIZE, y + line), fill=color)


def tex_painted_brick() -> tuple[np.ndarray, np.ndarray]:
    base = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    base[:] = np.array([170, 160, 138], dtype=np.float32)
    base += noise(SIZE, 10, 40, blur=2)[..., None]
    img = Image.fromarray(np.uint8(np.clip(base, 0, 255)), "RGB")
    d = ImageDraw.Draw(img)
    brick_h = SIZE // 12
    brick_w = SIZE // 5
    for row, y in enumerate(range(0, SIZE, brick_h)):
        offset = (brick_w // 2) if row % 2 else 0
        d.rectangle((0, y, SIZE, y + 6), fill=(78, 80, 76))
        for x in range(-offset, SIZE, brick_w):
            d.rectangle((x, y, x + 6, y + brick_h), fill=(78, 80, 76))
    d.rectangle((0, int(SIZE * 0.72), SIZE, SIZE), fill=(42, 67, 83))
    base = np.asarray(img).astype(np.float32)
    height = noise(SIZE, 11, 0.22, blur=1)
    grout = np.zeros((SIZE, SIZE), dtype=np.float32)
    for row, y in enumerate(range(0, SIZE, brick_h)):
        grout[max(0, y - 4): min(SIZE, y + 5), :] = 0.65
        offset = (brick_w // 2) if row % 2 else 0
        for x in range(-offset, SIZE, brick_w):
            grout[:, max(0, x - 4): min(SIZE, x + 5)] = 0.65
    height = np.clip(height - grout * 0.25, 0, 1)
    return base.astype(np.uint8), height


def tex_tiles() -> tuple[np.ndarray, np.ndarray]:
    base = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    base[:] = np.array([125, 122, 112], dtype=np.float32)
    base += noise(SIZE, 20, 32, blur=1)[..., None]
    img = Image.fromarray(np.uint8(np.clip(base, 0, 255)), "RGB")
    d = ImageDraw.Draw(img)
    add_grout(d, SIZE // 8, 5, (48, 48, 45))
    base = np.asarray(img)
    height = noise(SIZE, 21, 0.25, blur=1)
    for pos in range(0, SIZE, SIZE // 8):
        height[max(0, pos - 5):pos + 5, :] *= 0.2
        height[:, max(0, pos - 5):pos + 5] *= 0.2
    return base, height


def tex_wood() -> tuple[np.ndarray, np.ndarray]:
    x = np.linspace(0, 1, SIZE)
    grain = np.sin((x * 70 + noise(SIZE, 30, 0.05, blur=3).mean(axis=0)) * math.pi)
    grain = np.tile(grain, (SIZE, 1))
    base = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    base[:] = np.array([125, 82, 45], dtype=np.float32)
    base += grain[..., None] * 32
    base += noise(SIZE, 31, 28, blur=2)[..., None]
    img = Image.fromarray(np.uint8(np.clip(base, 0, 255)), "RGB")
    d = ImageDraw.Draw(img)
    plank = SIZE // 6
    for x0 in range(0, SIZE, plank):
        d.rectangle((x0, 0, x0 + 5, SIZE), fill=(64, 42, 27))
    base = np.asarray(img)
    height = np.clip((grain + 1) * 0.25 + noise(SIZE, 32, 0.18, blur=1), 0, 1)
    for x0 in range(0, SIZE, plank):
        height[:, max(0, x0 - 4):x0 + 5] *= 0.25
    return base, height


def tex_rubber_track() -> tuple[np.ndarray, np.ndarray]:
    base = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    base[:] = np.array([125, 42, 34], dtype=np.float32)
    base += noise(SIZE, 40, 35, blur=0.5)[..., None]
    img = Image.fromarray(np.uint8(np.clip(base, 0, 255)), "RGB")
    d = ImageDraw.Draw(img)
    for x in (SIZE // 3, SIZE * 2 // 3):
        d.rectangle((x - 5, 0, x + 5, SIZE), fill=(225, 216, 190))
    base = np.asarray(img)
    height = noise(SIZE, 41, 0.45, blur=0.5)
    return base, height


def tex_grass() -> tuple[np.ndarray, np.ndarray]:
    base = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    base[:] = np.array([50, 96, 45], dtype=np.float32)
    base += noise(SIZE, 50, 70, blur=1)[..., None] * np.array([0.5, 1.0, 0.35])
    height = noise(SIZE, 51, 0.65, blur=1)
    return np.clip(base, 0, 255).astype(np.uint8), height


def tex_solid_worn(name: str, color: tuple[int, int, int], seed: int) -> tuple[np.ndarray, np.ndarray]:
    base = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    base[:] = np.array(color, dtype=np.float32)
    n = noise(SIZE, seed, 45, blur=1)
    scratches = noise(SIZE, seed + 1, 65, blur=0)
    base += n[..., None]
    base -= (scratches > 62)[..., None] * 22
    height = np.clip(noise(SIZE, seed + 2, 0.35, blur=1), 0, 1)
    return np.clip(base, 0, 255).astype(np.uint8), height


def write_set(name: str, base: np.ndarray, height: np.ndarray, metallic: int, smoothness: int) -> None:
    save_rgb(OUT / f"{name}_BaseColor_2K.png", base)
    save_rgb(OUT / f"{name}_Normal_2K.png", normal_from_height(height))
    save_rgba(OUT / f"{name}_MetallicSmoothness_2K.png", ms_map(SIZE, metallic, smoothness))
    save_rgb(OUT / f"{name}_AO_2K.png", ao_from_height(height))


def main() -> None:
    ensure_dir(OUT)

    generators = {
        "Mat_PaintedBrick": (*tex_painted_brick(), 0, 90),
        "Mat_HallwayTile": (*tex_tiles(), 0, 120),
        "Mat_ClassroomWood": (*tex_wood(), 0, 145),
        "Mat_RubberTrack": (*tex_rubber_track(), 0, 95),
        "Mat_Grass": (*tex_grass(), 0, 65),
        "Mat_BluePaintedMetal": (*tex_solid_worn("blue", (32, 58, 78), 60), 70, 130),
        "Mat_DarkLeather": (*tex_solid_worn("leather", (28, 25, 22), 70), 0, 95),
        "Mat_WoodFurniture": (*tex_solid_worn("wood", (132, 86, 45), 80), 0, 135),
        "Mat_Blackboard": (*tex_solid_worn("board", (34, 68, 52), 90), 0, 60),
        "Mat_Paper": (*tex_solid_worn("paper", (205, 190, 155), 100), 0, 80),
        "Mat_RubberBlack": (*tex_solid_worn("rubber", (18, 18, 17), 110), 0, 65),
        "Mat_CarPaint": (*tex_solid_worn("carpaint", (18, 22, 25), 120), 120, 175),
        "Mat_BadgeMetal": (*tex_solid_worn("metal", (185, 150, 70), 130), 180, 160),
        "Mat_Glass": (*tex_solid_worn("glass", (55, 75, 90), 140), 0, 190),
        "Mat_PlasticBlue": (*tex_solid_worn("plastic", (35, 62, 116), 150), 0, 170),
    }

    for name, (base, height, metallic, smoothness) in generators.items():
        write_set(name, base, height, metallic, smoothness)

    # Simple emission swatches.
    for name, color in {
        "Mat_EmissionWarm": (255, 174, 72),
        "Mat_EmissionRed": (255, 35, 30),
        "Mat_EmissionBlue": (42, 114, 255),
        "Mat_EmissionWhite": (240, 245, 230),
    }.items():
        arr = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)
        arr[:] = color
        save_rgb(OUT / f"{name}_BaseColor_2K.png", arr)
        save_rgb(OUT / f"{name}_Emission_2K.png", arr)
        height = np.ones((SIZE, SIZE), dtype=np.float32) * 0.5
        save_rgb(OUT / f"{name}_Normal_2K.png", normal_from_height(height))
        save_rgba(OUT / f"{name}_MetallicSmoothness_2K.png", ms_map(SIZE, 0, 210))
        save_rgb(OUT / f"{name}_AO_2K.png", np.full((SIZE, SIZE, 3), 255, dtype=np.uint8))

    print(f"Generated texture sets in {OUT}")


if __name__ == "__main__":
    random.seed(7)
    main()
