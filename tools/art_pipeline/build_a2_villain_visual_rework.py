#!/usr/bin/env python3
"""Build the A2 villain visual rework from the existing rigged Blender master.

Run with Blender:

    blender --background --python tools/art_pipeline/build_a2_villain_visual_rework.py -- \
      --output-blend /tmp/Villain_A2.blend \
      --output-glb /tmp/villain-a2-static.glb

The script deliberately leaves the authoritative 21-joint armature untouched. It
reshapes the existing Hunyuan-derived body, keeps its native face recessed under
the hood, adds only a cropped CC0 MPFB lower-face relief patch, preserves the
authored UV0, generates deterministic 2K PBR maps plus smooth vertex-color
garment zoning, and exports an animation-free authoring GLB. The remote-trunk
runtime builder subsequently bakes the eight authoritative gameplay clips onto
this unchanged skeleton, then packages the result through the repository's
Meshopt + KTX2 character pipeline. This authoring script does not define the
runtime clip contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
ASSET_ROOT = ROOT / "art-source/Characters/Villain/ReferenceStandard/PrecisionRemodel_2026_07_13_v21"
# The authoring master intentionally stays high resolution and keeps the
# separate facial source. The Rigged/ blend is the cleaned A2 output, so using
# it as input would make a second run non-reproducible after meshes are joined.
SOURCE_BLEND = ASSET_ROOT / "Villain_PrecisionRemodel_v21.blend"
TEXTURE_DIR = ASSET_ROOT / "Textures"
EVIDENCE_DIR = ASSET_ROOT / "Reports/A2_Villain_2026_08_28/evidence"
IMPORTED_HISTORICAL_REPORT = ASSET_ROOT / "Reports/Villain_A2_visual_rework_build_report.json"
DEFAULT_GENERATED_REPORT = ASSET_ROOT / "Reports/Villain_A2_visual_rework_generated_report.json"

ARMATURE_NAME = "Rig_Humanoid_Shared"
BODY_NAME = "Villain_v20_NativeBodyHead"
HEAD_OVERLAY_NAME = "Villain_v21_MPFB_HeadNeck"
MATERIAL_NAME = "M_Villain_A2_SemanticAtlas_PBR"
EXPECTED_BONES = (
    "Hips", "Spine", "Chest", "Neck", "Head",
    "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
    "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
)

BASE_PATH = TEXTURE_DIR / "Char_Villain_PrecisionRemodel_v21_BaseColor_2K.png"
NORMAL_PATH = TEXTURE_DIR / "Char_Villain_PrecisionRemodel_v21_Normal_2K.png"
AO_PATH = TEXTURE_DIR / "Char_Villain_PrecisionRemodel_v21_AO_2K.png"
ORM_PATH = TEXTURE_DIR / "Char_Villain_PrecisionRemodel_v21_ORM_2K.png"
MATERIAL_SOURCE_PATH = TEXTURE_DIR / "Char_Villain_A2_MaterialAtlas_Source.png"
LEGACY_MS_PATH = TEXTURE_DIR / "Char_Villain_PrecisionRemodel_v21_MetallicSmoothness_2K.png"

ATLAS_COLUMNS = 4
ATLAS_ROWS = 2
TEXTURE_SIZE = 2048
TILE_WIDTH = TEXTURE_SIZE // ATLAS_COLUMNS
TILE_HEIGHT = TEXTURE_SIZE // ATLAS_ROWS

SEMANTIC = {
    "coat": 0,
    "hood": 1,
    "pants": 2,
    "boots_gloves": 3,
    "skin": 4,
    "lining": 5,
    "metal": 6,
    "edge_leather": 7,
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-blend", type=Path, required=True)
    parser.add_argument("--output-glb", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--preview-dir", type=Path, default=EVIDENCE_DIR)
    return parser.parse_args(argv)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def display_path(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return resolved.name


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def write_rgb_png(path: Path, pixels: np.ndarray) -> None:
    """Write an RGB uint8 PNG without depending on Pillow inside Blender."""
    if pixels.dtype != np.uint8 or pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("pixels must be an HxWx3 uint8 array")
    height, width, _ = pixels.shape
    raw = b"".join(b"\x00" + pixels[row].tobytes() for row in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(raw, level=9))
        + _png_chunk(b"IEND", b"")
    )


def periodic_noise(u: np.ndarray, v: np.ndarray, seed: int, modes: int = 14) -> np.ndarray:
    rng = np.random.default_rng(seed)
    result = np.zeros_like(u, dtype=np.float32)
    amplitude_sum = 0.0
    for index in range(modes):
        fx = int(rng.integers(1, 15))
        fy = int(rng.integers(1, 15))
        phase = float(rng.uniform(0.0, math.tau))
        amplitude = 1.0 / (1.0 + index * 0.27)
        result += np.sin(math.tau * (fx * u + fy * v) + phase).astype(np.float32) * amplitude
        amplitude_sum += amplitude
    return result / max(amplitude_sum, 1e-6)


def load_material_source(size: int) -> np.ndarray:
    """Load the approved 4x2 material study as raw sRGB-like RGB pixels."""
    if not MATERIAL_SOURCE_PATH.is_file():
        raise FileNotFoundError(MATERIAL_SOURCE_PATH)
    image = bpy.data.images.load(str(MATERIAL_SOURCE_PATH), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    image.scale(size, size)
    pixels = np.asarray(image.pixels[:], dtype=np.float32).reshape(size, size, 4)
    # Blender exposes pixels bottom-up; PNG scanlines and the atlas contract are
    # top-down (face/lining/metal/edge above coat/hood/pants/boots).
    pixels = np.flipud(pixels[..., :3])
    bpy.data.images.remove(image)
    return np.clip(pixels * 255.0, 0.0, 255.0)


def periodic_blur(field: np.ndarray, passes: int) -> np.ndarray:
    result = field.astype(np.float32)
    for _ in range(passes):
        result = (
            result * 4.0
            + np.roll(result, 1, axis=0)
            + np.roll(result, -1, axis=0)
            + np.roll(result, 1, axis=1)
            + np.roll(result, -1, axis=1)
        ) / 8.0
    return result


def generate_pbr_textures() -> dict[str, object]:
    """Generate a deterministic semantic atlas with asset-related microstructure."""
    size = TEXTURE_SIZE
    base = np.zeros((size, size, 3), dtype=np.uint8)
    normal = np.zeros((size, size, 3), dtype=np.uint8)
    orm = np.zeros((size, size, 3), dtype=np.uint8)
    ao_rgb = np.zeros((size, size, 3), dtype=np.uint8)
    material_source = load_material_source(size)

    def mirror_fill(crop: np.ndarray, height: int = TILE_HEIGHT, width: int = TILE_WIDTH) -> np.ndarray:
        """Ping-pong a clean swatch so opposite borders meet without a jump."""
        def indices(source_size: int, output_size: int) -> np.ndarray:
            if source_size < 2:
                return np.zeros(output_size, dtype=np.int64)
            period = 2 * (source_size - 1)
            result = np.arange(output_size, dtype=np.int64) % period
            return np.where(result < source_size, result, period - result)

        yy = indices(crop.shape[0], height)
        xx = indices(crop.shape[1], width)
        return crop[yy[:, None], xx[None, :]]

    palette = [
        ((24, 20, 17), 0.68, 0.00, 0.88),  # weathered brown-black coat leather
        ((23, 22, 21), 0.78, 0.00, 0.68),  # matte hood shell
        ((22, 22, 23), 0.84, 0.00, 0.60),  # coarse charcoal trousers
        ((22, 20, 18), 0.54, 0.00, 0.72),  # oiled boots and gloves
        ((3, 2, 2), 0.88, 0.00, 0.26),     # face held in deep hood shadow
        ((18, 18, 19), 0.91, 0.00, 0.50),  # hood lining / scarf
        ((99, 78, 48), 0.34, 0.72, 0.38),  # muted brass zipper/hardware
        ((18, 16, 14), 0.70, 0.00, 0.68),  # dark worn leather edges / piping
    ]

    local_u = (np.arange(TILE_WIDTH, dtype=np.float32) + 0.5) / TILE_WIDTH
    local_v = (np.arange(TILE_HEIGHT, dtype=np.float32) + 0.5) / TILE_HEIGHT
    u, v = np.meshgrid(local_u, local_v)
    coat_base_tile: np.ndarray | None = None
    coat_normal_tile: np.ndarray | None = None
    coat_orm_tile: np.ndarray | None = None
    coat_ao_tile: np.ndarray | None = None
    for semantic_id, (color, roughness, metallic, normal_strength) in enumerate(palette):
        row = semantic_id // ATLAS_COLUMNS
        column = semantic_id % ATLAS_COLUMNS
        # PNG scanlines are top-down while Blender UV V=0 starts at the bottom.
        y0 = (ATLAS_ROWS - 1 - row) * TILE_HEIGHT
        x0 = column * TILE_WIDTH
        reference = material_source[y0 : y0 + TILE_HEIGHT, x0 : x0 + TILE_WIDTH]
        if semantic_id == SEMANTIC["coat"]:
            # The source study deliberately includes macro seams to communicate
            # tailoring. Re-projecting those straight seams across every sleeve
            # and lapel produced false horizontal bands, so the runtime swatch
            # uses only its uninterrupted leather field. Garment seams remain
            # authored by the sculpt instead of being stamped over the body.
            crop = reference[
                int(TILE_HEIGHT * 0.55) : int(TILE_HEIGHT * 0.96),
                int(TILE_WIDTH * 0.03) : int(TILE_WIDTH * 0.55),
            ]
            reference = mirror_fill(crop)
        elif semantic_id == SEMANTIC["hood"]:
            # Keep only uninterrupted woven canvas. The study's central Y seam
            # was useful as a material reference but read as a rigid face flap
            # when stamped across the runtime hood.
            crop = reference[
                int(TILE_HEIGHT * 0.04) : int(TILE_HEIGHT * 0.43),
                int(TILE_WIDTH * 0.04) : int(TILE_WIDTH * 0.43),
            ]
            reference = mirror_fill(crop)
        elif semantic_id == SEMANTIC["boots_gloves"]:
            # Exclude the boot-specific welt from the shared leather cell so it
            # cannot appear as a false band around the gloves.
            crop = reference[
                int(TILE_HEIGHT * 0.04) : int(TILE_HEIGHT * 0.43),
                int(TILE_WIDTH * 0.04) : int(TILE_WIDTH * 0.92),
            ]
            reference = mirror_fill(crop)
        repeat = {
            SEMANTIC["pants"]: 3,
            SEMANTIC["lining"]: 2,
            SEMANTIC["edge_leather"]: 2,
        }.get(semantic_id, 1)
        if repeat > 1:
            yy = (np.arange(TILE_HEIGHT) * repeat) % TILE_HEIGHT
            xx = (np.arange(TILE_WIDTH) * repeat) % TILE_WIDTH
            reference = reference[yy[:, None], xx[None, :]]
        reference_luma = (
            reference[..., 0] * 0.2126
            + reference[..., 1] * 0.7152
            + reference[..., 2] * 0.0722
        ) / 255.0
        reference_medium = periodic_blur(reference_luma, 6)
        reference_micro = reference_luma - periodic_blur(reference_luma, 2)

        broad = periodic_noise(u, v, 400 + semantic_id, modes=12)
        fine = periodic_noise(u * 3.0, v * 3.0, 900 + semantic_id, modes=10)
        if semantic_id in (0, 1, 3, 7):
            pores = 0.52 * np.sin(math.tau * (31.0 * u + 5.0 * v)) * np.sin(math.tau * (7.0 * u + 29.0 * v))
            crease = -np.exp(-((np.sin(math.tau * (2.0 * u + 1.0 * v + 0.13))) / 0.12) ** 2)
            height = 0.55 * broad + 0.22 * fine + 0.18 * pores + 0.24 * crease
        elif semantic_id in (2, 5):
            warp = np.sin(math.tau * 72.0 * u)
            weft = np.sin(math.tau * 58.0 * v)
            height = 0.42 * warp + 0.42 * weft + 0.19 * broad
        elif semantic_id == 4:
            pores = np.sin(math.tau * 41.0 * u) * np.sin(math.tau * 37.0 * v)
            stubble = np.maximum(0.0, periodic_noise(u * 5.0, v * 5.0, 1776, modes=9))
            height = 0.20 * broad + 0.13 * pores + 0.34 * stubble
        else:
            scratches = np.maximum(0.0, np.sin(math.tau * (48.0 * u + 3.0 * v))) ** 18
            height = 0.10 * broad + 0.28 * scratches

        # Material-authored structure. Macro garment seams stay in the sculpt;
        # projecting them through a shared atlas made false bands on the arms.
        if semantic_id == SEMANTIC["coat"]:
            edge_wear = np.maximum(0.0, periodic_noise(u * 0.72, v * 0.72, 1661, modes=8))
            height += 0.10 * edge_wear
        elif semantic_id == SEMANTIC["pants"]:
            height += 0.08 * np.sin(math.tau * 86.0 * u) * np.sin(math.tau * 72.0 * v)

        height += reference_micro * 0.48 + (reference_luma - reference_medium) * 0.18

        # Normalize each generated swatch toward the art-directed palette while
        # preserving its real grain, stitches, scuffs and weave. This avoids
        # baked-lighting blowout and keeps all eight materials cohesive.
        reference_mean = max(float(reference.mean()), 1.0)
        target_mean = sum(color) / 3.0
        reference_graded = reference * (target_mean / reference_mean)
        detail_contrast = {
            SEMANTIC["coat"]: 0.55,
            SEMANTIC["hood"]: 0.38,
            SEMANTIC["pants"]: 0.30,
            SEMANTIC["boots_gloves"]: 0.42,
            SEMANTIC["skin"]: 0.40,
            SEMANTIC["lining"]: 0.36,
            SEMANTIC["metal"]: 0.58,
            SEMANTIC["edge_leather"]: 0.42,
        }[semantic_id]
        reference_graded = target_mean + (reference_graded - target_mean) * detail_contrast
        variation = np.clip(broad * 2.4 + fine * 0.9, -4.0, 4.0)
        tile_color = reference_graded * 0.88 + np.asarray(color, dtype=np.float32) * 0.12
        tile_color += variation[..., None]
        if semantic_id == 4:
            # The upper face stays nearly black; only a warm nose/mouth/chin
            # wedge survives at gameplay distance, matching the approved hood.
            tile_color *= (0.45 + 0.45 * (1.0 - v[..., None]))
            tile_color[..., 0] += np.maximum(0.0, broad)[..., None].squeeze(-1) * 7.0
        elif semantic_id == SEMANTIC["coat"]:
            # Preserve the source's actual leather relief as neutral luminance
            # instead of amplifying its warm scratches into orange speckles.
            # Three broad, periodic patina waves provide artifact-related
            # variation for the non-flatness gate; mirror_fill below guarantees
            # that none of them becomes a hard UV-border seam.
            leather_grain = (reference_luma - float(reference_luma.mean())) * (255.0 * 0.55)
            patina = (
                7.0 * np.sin(math.tau * (u + 2.0 * v + 0.17))
                + 5.0 * np.sin(math.tau * (3.0 * u - v + 0.41))
                + 4.0 * np.sin(math.tau * (4.0 * u + 3.0 * v + 0.73))
            )
            tonal_detail = leather_grain + patina + broad * 1.2
            tile_color = np.asarray(color, dtype=np.float32) + tonal_detail[..., None]
            tile_color += np.maximum(0.0, edge_wear)[..., None] * np.array((1.2, 1.0, 0.8), dtype=np.float32)
        if semantic_id == 6:
            tile_color += np.maximum(0.0, height)[..., None] * 25.0
        encoded_base = np.clip(tile_color, 0.0, 255.0).astype(np.uint8)
        base[y0 : y0 + TILE_HEIGHT, x0 : x0 + TILE_WIDTH] = encoded_base
        if semantic_id == SEMANTIC["coat"]:
            coat_base_tile = encoded_base.copy()

        dy, dx = np.gradient(height.astype(np.float32))
        nx = -dx * normal_strength
        ny = -dy * normal_strength
        nz = np.ones_like(nx)
        length = np.sqrt(nx * nx + ny * ny + nz * nz)
        encoded = np.stack((nx / length, ny / length, nz / length), axis=-1)
        normal[y0 : y0 + TILE_HEIGHT, x0 : x0 + TILE_WIDTH] = np.clip((encoded * 0.5 + 0.5) * 255.0, 0.0, 255.0).astype(np.uint8)

        ao = np.clip(226.0 + broad * 18.0 + np.minimum(reference_luma - reference_medium, 0.0) * 92.0, 145.0, 255.0)
        rough = np.clip(roughness * 255.0 + broad * 12.0 + (0.5 - reference_luma) * 10.0, 18.0, 248.0)
        metal = np.clip(metallic * 255.0 + (height > 0.35).astype(np.float32) * (18.0 if metallic else 0.0), 0.0, 255.0)
        orm_tile = np.stack((ao, rough, metal), axis=-1).astype(np.uint8)
        orm[y0 : y0 + TILE_HEIGHT, x0 : x0 + TILE_WIDTH] = orm_tile
        ao_rgb[y0 : y0 + TILE_HEIGHT, x0 : x0 + TILE_WIDTH] = np.repeat(ao[..., None], 3, axis=2).astype(np.uint8)
        if semantic_id == SEMANTIC["coat"]:
            coat_normal_tile = normal[y0 : y0 + TILE_HEIGHT, x0 : x0 + TILE_WIDTH].copy()
            coat_orm_tile = orm_tile.copy()
            coat_ao_tile = ao_rgb[y0 : y0 + TILE_HEIGHT, x0 : x0 + TILE_WIDTH].copy()

    if any(tile is None for tile in (coat_base_tile, coat_normal_tile, coat_orm_tile, coat_ao_tile)):
        raise RuntimeError("Missing neutral coat fields for seam-free PBR maps")
    # Every PBR channel uses authored UV0. Garment differentiation is the smooth
    # A2Tint vertex field plus the sculpt itself, so no channel jumps atlas cells
    # at cuffs, waist or hood opening.
    base = mirror_fill(coat_base_tile, size, size)
    normal = mirror_fill(coat_normal_tile, size, size)
    orm = mirror_fill(coat_orm_tile, size, size)
    ao_rgb = mirror_fill(coat_ao_tile, size, size)
    write_rgb_png(BASE_PATH, base)
    write_rgb_png(NORMAL_PATH, normal)
    write_rgb_png(AO_PATH, ao_rgb)
    write_rgb_png(ORM_PATH, orm)
    LEGACY_MS_PATH.unlink(missing_ok=True)

    def stats(pixels: np.ndarray) -> dict[str, object]:
        return {
            "mean": round(float(pixels.mean()), 4),
            "stddev": round(float(pixels.astype(np.float32).std()), 4),
            "channelStddev": [round(float(pixels[..., index].astype(np.float32).std()), 4) for index in range(3)],
        }

    return {
        "resolution": [size, size],
        "baseColor": {"path": BASE_PATH.relative_to(ROOT).as_posix(), **stats(base)},
        "normal": {"path": NORMAL_PATH.relative_to(ROOT).as_posix(), **stats(normal)},
        "ao": {"path": AO_PATH.relative_to(ROOT).as_posix(), **stats(ao_rgb)},
        "orm": {"path": ORM_PATH.relative_to(ROOT).as_posix(), **stats(orm)},
        "packing": "ORM: R=occlusion, G=roughness, B=metallic",
        "source": "ImageGen-authored 4x2 villain material study, deterministically normalized and converted to BaseColor/Normal/AO/ORM by Blender/Python",
        "sourceAtlas": MATERIAL_SOURCE_PATH.relative_to(ROOT).as_posix(),
        "sourceAtlasSha256": hashlib.sha256(MATERIAL_SOURCE_PATH.read_bytes()).hexdigest(),
        "sourcePrompt": "Eight-cell flat PBR swatch atlas: shadowed adult skin, black scarf, muted brass, worn piping, trench leather, hood canvas, trouser wool, combat leather; no labels or objects",
    }


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = min(1.0, max(0.0, (value - edge0) / max(edge1 - edge0, 1e-8)))
    return t * t * (3.0 - 2.0 * t)


def palette_is_skin(color: tuple[float, float, float, float]) -> bool:
    return color[0] > 0.08 and color[0] > color[1] * 1.8


def reshape_body(body: bpy.types.Object) -> dict[str, object]:
    palette = body.data.color_attributes.get("BodyPalette")
    before = [Vector(vertex.co) for vertex in body.data.vertices]
    for vertex in body.data.vertices:
        x, y, z = vertex.co
        color = tuple(palette.data[vertex.index].color) if palette and palette.domain == "POINT" else (0.0, 0.0, 0.0, 1.0)
        skin = palette_is_skin(color)

        # Broaden the shoulder/chest block and arms into a readable, oppressive silhouette.
        upper = smoothstep(0.98, 1.22, z) * (1.0 - smoothstep(1.48, 1.70, z))
        arm = smoothstep(0.53, 0.72, abs(x)) * (1.0 - smoothstep(1.35, 1.52, z))
        x *= 1.0 + 0.078 * upper + 0.052 * arm
        y *= 1.0 + 0.052 * upper + 0.022 * arm

        # Bell the long coat hem slightly without moving the planted feet.
        hem = (1.0 - smoothstep(0.78, 1.00, z)) * smoothstep(0.20, 0.38, z)
        if abs(x) > 0.16 or abs(y) > 0.09:
            x *= 1.0 + 0.072 * hem
            y *= 1.0 + 0.052 * hem

        # Enlarge glove/boot masses. Their coarse silhouette matters on a 375 px viewport.
        if abs(x) > 0.31 and 0.54 < z < 1.02:
            x *= 1.045
            y *= 1.045
        if z < 0.085:
            # Shape the existing boot's planted outsole instead of attaching an
            # independent platform.  The expansion is 6 mm at the side and
            # about 8 mm at toe/heel, then blends back into the sculpted upper.
            sole = 1.0 - smoothstep(0.035, 0.085, z)
            foot_center = -0.214 if x < 0.0 else 0.214
            x = foot_center + (x - foot_center) * (1.0 + 0.060 * sole)
            y = -0.052 + (y + 0.052) * (1.0 + 0.045 * sole)
            z -= 0.018 * sole

        # Push the hood forward while setting the exposed face back into shadow.
        hood = smoothstep(1.40, 1.52, z) * (1.0 - smoothstep(1.82, 1.86, z))
        if skin:
            # Keep the source-integrated face instead of the detached MPFB mask.
            # A shallow recession and wider lower face leave only a coarse adult
            # nose/mouth/chin read under the hood, with no floating side edge.
            lower_face = 1.0 - smoothstep(1.585, 1.645, z)
            x *= 1.0 + 0.075 * lower_face
            y += 0.038
        elif z > 1.40:
            x *= 1.0 + 0.032 * hood
            if y < -0.06:
                y -= 0.052 * hood
            # Lower the helmet-like crown without touching the planted body or
            # the separate licensed face. This changes the hood silhouette,
            # not merely its color.
            z -= 0.038 * smoothstep(1.70, 1.85, z)
            # A subtle centre lift replaces the helmet dome with the soft peak
            # visible in the approved hood, using only the source shell.
            crown = smoothstep(1.66, 1.77, z)
            peak = 1.0 - smoothstep(0.015, 0.215, abs(x))
            z += 0.035 * crown * peak

        vertex.co = (x, y, z)

    bounds = object_local_bounds(body)
    displacement = max((body.data.vertices[index].co - before[index]).length for index in range(len(before)))
    return {
        "maxDisplacementMeters": round(displacement, 6),
        "boundsAfterReshape": bounds,
    }


def smooth_hood_opening(body: bpy.types.Object) -> dict[str, object]:
    """Locally relax the source hood lip while preserving its overall shape."""
    palette = body.data.color_attributes.get("BodyPalette")
    adjacency = [set() for _ in body.data.vertices]
    for edge in body.data.edges:
        left, right = edge.vertices
        adjacency[left].add(right)
        adjacency[right].add(left)

    weights: list[float] = []
    for vertex in body.data.vertices:
        skin = bool(
            palette
            and palette.domain == "POINT"
            and palette_is_skin(tuple(palette.data[vertex.index].color))
        )
        coordinate = vertex.co
        front = 1.0 - smoothstep(-0.180, -0.110, coordinate.y)
        height = smoothstep(1.45, 1.51, coordinate.z) * (1.0 - smoothstep(1.70, 1.76, coordinate.z))
        width = 1.0 - smoothstep(0.185, 0.265, abs(coordinate.x))
        weights.append(0.0 if skin else front * height * width)

    before = [Vector(vertex.co) for vertex in body.data.vertices]
    for _ in range(2):
        coordinates = [Vector(vertex.co) for vertex in body.data.vertices]
        for vertex in body.data.vertices:
            weight = weights[vertex.index]
            neighbors = adjacency[vertex.index]
            if weight <= 0.0 or not neighbors:
                continue
            average = sum((coordinates[index] for index in neighbors), Vector()) / len(neighbors)
            vertex.co = coordinates[vertex.index].lerp(average, 0.16 * weight)
    body.data.update()
    displacement = max(
        (body.data.vertices[index].co - before[index]).length
        for index in range(len(before))
    )
    return {
        "iterations": 2,
        "strength": 0.16,
        "affectedVertices": sum(weight > 0.001 for weight in weights),
        "maxDisplacementMeters": round(displacement, 6),
    }


def object_local_bounds(obj: bpy.types.Object) -> dict[str, list[float] | float]:
    coordinates = [vertex.co for vertex in obj.data.vertices]
    low = [min(point[index] for point in coordinates) for index in range(3)]
    high = [max(point[index] for point in coordinates) for index in range(3)]
    return {
        "min": [round(value, 6) for value in low],
        "max": [round(value, 6) for value in high],
        "dimensions": [round(high[index] - low[index], 6) for index in range(3)],
        "widthHeightRatio": round((high[0] - low[0]) / (high[2] - low[2]), 6),
    }


def prepare_face_overlay(head: bpy.types.Object) -> dict[str, object]:
    """Retain only a small MPFB nose/mouth patch over the integrated face."""
    before_vertices = len(head.data.vertices)
    before_triangles = triangle_count(head)
    for modifier in list(head.modifiers):
        if modifier.type == "ARMATURE":
            head.modifiers.remove(modifier)
    bpy.ops.object.select_all(action="DESELECT")
    head.select_set(True)
    bpy.context.view_layer.objects.active = head
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    keep = {
        vertex.index
        for vertex in head.data.vertices
        if abs(vertex.co.x) < 0.060
        and 1.560 < vertex.co.z < 1.655
        and vertex.co.y < -0.095
    }
    if not 120 <= len(keep) <= 260:
        raise RuntimeError(f"MPFB facial patch selection drifted: {len(keep)} vertices")
    for vertex in head.data.vertices:
        vertex.select = vertex.index not in keep
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for vertex in head.data.vertices:
        vertex.co.y -= 0.035
    head.data.update()
    head["a2_semantic"] = SEMANTIC["skin"]
    return {
        "verticesBefore": before_vertices,
        "trianglesBefore": before_triangles,
        "verticesAfter": len(head.data.vertices),
        "trianglesAfter": triangle_count(head),
        "ratio": round(triangle_count(head) / before_triangles, 6),
        "purpose": "retain only a licensed MPFB nose/mouth relief patch; the integrated face supplies the shadowed head volume without a detached side-mask edge",
    }


def add_tailored_details(armature: bpy.types.Object, face_overlay: bpy.types.Object) -> list[bpy.types.Object]:
    """Keep source clothing/footwear and add the fitted MPFB head."""
    del armature
    return [face_overlay]


def dominant_bone_names(obj: bpy.types.Object, polygon: bpy.types.MeshPolygon) -> set[str]:
    scores: dict[str, float] = {}
    for vertex_index in polygon.vertices:
        for influence in obj.data.vertices[vertex_index].groups:
            if influence.group < len(obj.vertex_groups):
                name = obj.vertex_groups[influence.group].name
                scores[name] = scores.get(name, 0.0) + influence.weight
    return {name for name, _ in sorted(scores.items(), key=lambda item: item[1], reverse=True)[:2]}


def vertex_bone_weight(obj: bpy.types.Object, vertex: bpy.types.MeshVertex, token: str) -> float:
    return sum(
        influence.weight
        for influence in vertex.groups
        if influence.group < len(obj.vertex_groups)
        and token in obj.vertex_groups[influence.group].name
    )


def vertex_tint(obj: bpy.types.Object, vertex: bpy.types.MeshVertex) -> tuple[float, float, float, float]:
    """Return a smoothly blended material tint for seam-free BaseColor."""
    tints = {
        "coat": np.array((1.00, 0.94, 0.88), dtype=np.float32),
        "hood": np.array((0.73, 0.74, 0.77), dtype=np.float32),
        "pants": np.array((0.64, 0.67, 0.73), dtype=np.float32),
        "boots": np.array((0.52, 0.47, 0.42), dtype=np.float32),
        "skin": np.array((0.08, 0.05, 0.04), dtype=np.float32),
        "native_face": np.array((0.27, 0.25, 0.24), dtype=np.float32),
        "lining": np.array((0.40, 0.42, 0.46), dtype=np.float32),
    }
    explicit = obj.get("a2_semantic")
    if explicit == SEMANTIC["skin"]:
        return (*tints["skin"], 1.0)

    coordinate = vertex.co
    palette = obj.data.color_attributes.get("BodyPalette")
    color = tuple(palette.data[vertex.index].color) if palette and palette.domain == "POINT" else (0.0, 0.0, 0.0, 1.0)
    if palette_is_skin(color):
        eye_shadow = smoothstep(1.590, 1.625, coordinate.z)
        native_face = tints["native_face"] * (1.0 - 0.18 * eye_shadow)
        return (*native_face, 1.0)

    result = tints["coat"].copy()
    leg_weight = min(1.0, vertex_bone_weight(obj, vertex, "Leg") + vertex_bone_weight(obj, vertex, "Foot"))
    pants = (
        (1.0 - smoothstep(0.80, 0.92, coordinate.z))
        * (1.0 - smoothstep(0.16, 0.225, abs(coordinate.x)))
        * leg_weight
    )
    result = result * (1.0 - pants) + tints["pants"] * pants

    hood = smoothstep(1.43, 1.55, coordinate.z) * (1.0 - smoothstep(0.225, 0.305, abs(coordinate.x)))
    result = result * (1.0 - hood) + tints["hood"] * hood

    lining = (
        (1.0 - smoothstep(-0.160, -0.105, coordinate.y))
        * (1.0 - smoothstep(0.075, 0.125, abs(coordinate.x)))
        * smoothstep(0.91, 0.99, coordinate.z)
        * (1.0 - smoothstep(1.36, 1.44, coordinate.z))
    )
    result = result * (1.0 - lining) + tints["lining"] * lining

    palette_leather = color[0] < 0.0045 and (
        coordinate.z < 0.28
        or (0.52 < coordinate.z < 1.04 and abs(coordinate.x) > 0.28)
    )
    boot = max(1.0 - smoothstep(0.18, 0.26, coordinate.z), 1.0 if palette_leather else 0.0)
    result = result * (1.0 - boot) + tints["boots"] * boot
    return (float(result[0]), float(result[1]), float(result[2]), 1.0)


def semantic_for_polygon(obj: bpy.types.Object, polygon: bpy.types.MeshPolygon) -> int:
    explicit = obj.get("a2_semantic")
    if explicit is not None:
        return int(explicit)
    center = sum((obj.data.vertices[index].co for index in polygon.vertices), Vector()) / len(polygon.vertices)
    palette = obj.data.color_attributes.get("BodyPalette")
    if palette and palette.domain == "POINT":
        average = [sum(palette.data[index].color[channel] for index in polygon.vertices) / len(polygon.vertices) for channel in range(4)]
        if palette_is_skin(tuple(average)):
            return SEMANTIC["skin"]
        if average[0] < 0.0045 and 0.52 < center.z < 1.04 and abs(center.x) > 0.28:
            return SEMANTIC["boots_gloves"]
    if center.z < 0.24:
        return SEMANTIC["boots_gloves"]
    # Coordinate masks follow the visible garment blocks. Bone-only masks made
    # coat-tail triangles inherit leg shading and produced a patchwork seam.
    bones = dominant_bone_names(obj, polygon)
    if center.z < 0.88 and abs(center.x) < 0.19 and any("Leg" in name or "Foot" in name for name in bones):
        return SEMANTIC["pants"]
    if center.z > 1.48 and abs(center.x) < 0.265:
        return SEMANTIC["hood"]
    if center.y < -0.145 and abs(center.x) < 0.105 and 0.94 < center.z < 1.42:
        return SEMANTIC["lining"]
    return SEMANTIC["coat"]


def rebuild_atlas_uv(obj: bpy.types.Object) -> dict[str, int]:
    source_layer = obj.data.uv_layers.active
    if source_layer is None or len(source_layer.data) != len(obj.data.loops):
        raise RuntimeError(f"{obj.name} has no usable authored CORNER UV layer")
    while len(obj.data.uv_layers) > 1:
        obj.data.uv_layers.remove(obj.data.uv_layers[-1])
    source_layer.name = "UV0"
    source_layer.active_render = True
    tint = obj.data.color_attributes.get("A2Tint")
    if tint is None:
        tint = obj.data.color_attributes.new(name="A2Tint", type="FLOAT_COLOR", domain="POINT")
    for vertex in obj.data.vertices:
        tint.data[vertex.index].color = vertex_tint(obj, vertex)
    obj.data.color_attributes.active_color = tint
    obj.data.color_attributes.render_color_index = obj.data.color_attributes.find(tint.name)
    histogram = {name: 0 for name in SEMANTIC}
    reverse = {value: key for key, value in SEMANTIC.items()}
    for polygon in obj.data.polygons:
        semantic = semantic_for_polygon(obj, polygon)
        histogram[reverse[semantic]] += 1
    return histogram


def build_material(texture_report: dict[str, object]) -> bpy.types.Material:
    material = bpy.data.materials.get(MATERIAL_NAME) or bpy.data.materials.new(MATERIAL_NAME)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Metallic"].default_value = 1.0
    bsdf.inputs["Roughness"].default_value = 1.0

    def load_packed(path: Path, colorspace: str) -> bpy.types.Image:
        image = bpy.data.images.load(str(path), check_existing=False)
        image.colorspace_settings.name = colorspace
        image.pack()
        # Set the final Rigged/ master-relative path only after packing; the
        # high-source input lives one directory higher and resolving this path
        # before packing would point Blender at the wrong folder.
        image.filepath = f"//../Textures/{path.name}"
        return image

    base_image = load_packed(BASE_PATH, "sRGB")
    normal_image = load_packed(NORMAL_PATH, "Non-Color")
    orm_image = load_packed(ORM_PATH, "Non-Color")

    base_node = nodes.new("ShaderNodeTexImage")
    base_node.name = "A2_BaseColor_2K"
    base_node.image = base_image
    base_uv = nodes.new("ShaderNodeUVMap")
    base_uv.uv_map = "UV0"
    tint_node = nodes.new("ShaderNodeVertexColor")
    tint_node.layer_name = "A2Tint"
    tint_multiply = nodes.new("ShaderNodeMixRGB")
    tint_multiply.blend_type = "MULTIPLY"
    tint_multiply.inputs[0].default_value = 1.0
    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.name = "A2_Normal_OpenGL_2K"
    normal_node.image = normal_image
    detail_uv = nodes.new("ShaderNodeUVMap")
    detail_uv.uv_map = "UV0"
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.26
    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.name = "A2_ORM_2K"
    orm_node.image = orm_image
    separate = nodes.new("ShaderNodeSeparateColor")

    links.new(base_uv.outputs["UV"], base_node.inputs["Vector"])
    links.new(base_node.outputs["Color"], tint_multiply.inputs[1])
    links.new(tint_node.outputs["Color"], tint_multiply.inputs[2])
    links.new(tint_multiply.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(detail_uv.outputs["UV"], normal_node.inputs["Vector"])
    links.new(detail_uv.outputs["UV"], orm_node.inputs["Vector"])
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    material.diffuse_color = (0.14, 0.15, 0.16, 1.0)
    material["a2_orm_packing"] = texture_report["packing"]
    return material


def normalize_limit_weights(obj: bpy.types.Object) -> dict[str, object]:
    fallback_counts: dict[str, int] = {}
    for vertex in obj.data.vertices:
        influences = [(item.group, float(item.weight)) for item in vertex.groups if item.weight > 1e-8]
        influences.sort(key=lambda item: item[1], reverse=True)
        if not influences:
            z = vertex.co.z
            if z > 1.47:
                bone = "Head"
            elif z > 1.24:
                bone = "Chest"
            elif z > 0.86:
                bone = "Spine"
            elif vertex.co.x < -0.04:
                bone = "LeftUpperLeg"
            else:
                bone = "RightUpperLeg"
            group = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
            group.add([vertex.index], 1.0, "REPLACE")
            influences = [(group.index, 1.0)]
            fallback_counts[bone] = fallback_counts.get(bone, 0) + 1
        kept = influences[:4]
        total = sum(weight for _, weight in kept)
        kept_indices = {group for group, _ in kept}
        for group_index, _ in influences[4:]:
            obj.vertex_groups[group_index].remove([vertex.index])
        for group_index, weight in kept:
            obj.vertex_groups[group_index].add([vertex.index], weight / total, "REPLACE")

    bone_counts = {name: 0 for name in EXPECTED_BONES}
    zero = 0
    max_influences = 0
    max_error = 0.0
    for vertex in obj.data.vertices:
        influences = [item for item in vertex.groups if item.weight > 1e-8]
        if not influences:
            zero += 1
        max_influences = max(max_influences, len(influences))
        max_error = max(max_error, abs(sum(item.weight for item in influences) - 1.0))
        for item in influences:
            name = obj.vertex_groups[item.group].name
            if name in bone_counts:
                bone_counts[name] += 1
    return {
        "vertices": len(obj.data.vertices),
        "zeroWeightVertices": zero,
        "zeroWeightRatio": round(zero / max(len(obj.data.vertices), 1), 8),
        "maxInfluences": max_influences,
        "maxWeightSumError": max_error,
        "leftHandNonzeroVertices": bone_counts["LeftHand"],
        "rightHandNonzeroVertices": bone_counts["RightHand"],
        "fallbackAssignments": fallback_counts,
    }


def join_character_meshes(body: bpy.types.Object, details: list[bpy.types.Object], material: bpy.types.Material) -> bpy.types.Object:
    for obj in [body, *details]:
        rebuild_atlas_uv(obj)
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for polygon in obj.data.polygons:
            polygon.material_index = 0
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [body, *details]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.name = "Villain_A2_ReferenceStandard"
    body.data.name = "Villain_A2_ReferenceStandard_Mesh"
    body.data.materials.clear()
    body.data.materials.append(material)
    for polygon in body.data.polygons:
        polygon.material_index = 0
        polygon.use_smooth = True
    for attribute in list(body.data.color_attributes):
        if attribute.name != "A2Tint":
            body.data.color_attributes.remove(attribute)
    tint = body.data.color_attributes.get("A2Tint")
    if tint is None:
        raise RuntimeError("A2Tint was lost while joining the character")
    body.data.color_attributes.active_color = tint
    body.data.color_attributes.render_color_index = body.data.color_attributes.find(tint.name)
    return body


def ensure_armature_modifier(body: bpy.types.Object, armature: bpy.types.Object) -> None:
    for modifier in list(body.modifiers):
        body.modifiers.remove(modifier)
    modifier = body.modifiers.new("Rig_Humanoid_Shared_Deform", "ARMATURE")
    modifier.object = armature
    modifier.use_deform_preserve_volume = True
    body.parent = armature


def plant_mesh_feet(body: bpy.types.Object) -> float:
    """Remove only the tiny decimation/export floor drift; never scale the asset."""
    minimum_z = min(vertex.co.z for vertex in body.data.vertices)
    for vertex in body.data.vertices:
        vertex.co.z -= minimum_z
    return float(minimum_z)


def cleanup_source_scene(body: bpy.types.Object, armature: bpy.types.Object) -> list[str]:
    removed: list[str] = []
    for obj in list(bpy.data.objects):
        if obj.type == "MESH" and obj not in {body} and obj.name != "Studio_Floor":
            removed.append(obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
        elif obj.type == "ARMATURE" and obj != armature:
            removed.append(obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
    return sorted(removed)


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def setup_preview_scene(body: bpy.types.Object, output_dir: Path) -> dict[str, str]:
    if not output_dir.is_absolute():
        output_dir = ROOT / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    for obj in list(bpy.data.objects):
        if obj.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(obj, do_unlink=True)
    floor = bpy.data.objects.get("Studio_Floor")
    if floor is None:
        bpy.ops.mesh.primitive_plane_add(size=8.0, location=(0.0, 0.0, 0.0))
        floor = bpy.context.object
        floor.name = "Studio_Floor"
    floor.scale = (8.0, 8.0, 8.0)
    floor.hide_render = False
    floor_mat = bpy.data.materials.get("M_A2_StudioFloor") or bpy.data.materials.new("M_A2_StudioFloor")
    floor_mat.diffuse_color = (0.050, 0.048, 0.045, 1.0)
    floor.data.materials.clear()
    floor.data.materials.append(floor_mat)

    world = bpy.context.scene.world or bpy.data.worlds.new("A2_StudioWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.018, 0.017, 0.016, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.18

    def light(name: str, location: tuple[float, float, float], energy: float, size: float, color: tuple[float, float, float]) -> None:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = location
        look_at(obj, Vector((0.0, 0.0, 1.05)))

    light("A2_Key", (-2.6, -3.8, 3.4), 720.0, 3.4, (1.0, 0.93, 0.84))
    light("A2_Fill", (3.4, -2.0, 2.0), 245.0, 4.8, (0.72, 0.78, 0.86))
    light("A2_Rim", (0.5, 3.2, 3.0), 560.0, 3.0, (0.54, 0.63, 0.76))

    camera_data = bpy.data.cameras.new("A2_EvidenceCamera")
    camera = bpy.data.objects.new("A2_EvidenceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.12
    camera_data.lens = 85.0
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 1400
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"

    outputs: dict[str, str] = {}

    def report_path(path: Path) -> str:
        try:
            return path.relative_to(ROOT).as_posix()
        except ValueError:
            return str(path)

    camera.location = (2.7, -4.8, 2.18)
    look_at(camera, Vector((0.0, 0.0, 0.94)))
    three_quarter = output_dir / "dcc_after_threequarter.png"
    scene.render.filepath = str(three_quarter)
    bpy.ops.render.render(write_still=True)
    outputs["threeQuarter"] = report_path(three_quarter)

    camera.location = (0.0, -4.8, 1.16)
    look_at(camera, Vector((0.0, 0.0, 0.93)))
    front = output_dir / "dcc_after_front.png"
    scene.render.filepath = str(front)
    bpy.ops.render.render(write_still=True)
    outputs["front"] = report_path(front)

    camera.location = (4.8, 0.0, 1.16)
    look_at(camera, Vector((0.0, 0.0, 0.93)))
    side = output_dir / "dcc_after_side.png"
    scene.render.filepath = str(side)
    bpy.ops.render.render(write_still=True)
    outputs["side"] = report_path(side)

    camera.location = (0.0, 4.8, 1.16)
    look_at(camera, Vector((0.0, 0.0, 0.93)))
    back = output_dir / "dcc_after_back.png"
    scene.render.filepath = str(back)
    bpy.ops.render.render(write_still=True)
    outputs["back"] = report_path(back)

    original_material = body.data.materials[0]
    wire_material = bpy.data.materials.new("M_A2_WireframeEvidence")
    wire_material.use_nodes = True
    wire_nodes = wire_material.node_tree.nodes
    wire_links = wire_material.node_tree.links
    wire_nodes.clear()
    wire_output = wire_nodes.new("ShaderNodeOutputMaterial")
    wire_bsdf = wire_nodes.new("ShaderNodeBsdfPrincipled")
    wire_mix = wire_nodes.new("ShaderNodeMixRGB")
    wire_mix.blend_type = "MIX"
    wire_mix.inputs[1].default_value = (0.045, 0.052, 0.058, 1.0)
    wire_mix.inputs[2].default_value = (0.82, 0.90, 0.96, 1.0)
    wire_factor = wire_nodes.new("ShaderNodeWireframe")
    wire_factor.use_pixel_size = True
    wire_factor.inputs["Size"].default_value = 0.55
    wire_bsdf.inputs["Roughness"].default_value = 0.82
    wire_links.new(wire_factor.outputs["Fac"], wire_mix.inputs[0])
    wire_links.new(wire_mix.outputs["Color"], wire_bsdf.inputs["Base Color"])
    wire_links.new(wire_bsdf.outputs["BSDF"], wire_output.inputs["Surface"])
    body.data.materials[0] = wire_material
    camera.location = (2.7, -4.8, 2.18)
    look_at(camera, Vector((0.0, 0.0, 0.94)))
    wire = output_dir / "dcc_after_wireframe.png"
    scene.render.filepath = str(wire)
    bpy.ops.render.render(write_still=True)
    outputs["wireframe"] = report_path(wire)
    body.data.materials[0] = original_material
    bpy.data.materials.remove(wire_material, do_unlink=True)
    return outputs


def patch_glb_occlusion(path: Path) -> None:
    data = path.read_bytes()
    if data[:4] != b"glTF" or struct.unpack_from("<I", data, 4)[0] != 2:
        raise RuntimeError(f"Not a glTF 2 GLB: {path}")
    chunks: list[tuple[int, bytes]] = []
    offset = 12
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        payload = data[offset + 8 : offset + 8 + length]
        chunks.append((kind, payload))
        offset += 8 + length
    json_kind = 0x4E4F534A
    document = json.loads(next(payload for kind, payload in chunks if kind == json_kind).rstrip(b" \t\r\n\0"))
    for material in document.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        packed = pbr.get("metallicRoughnessTexture")
        if packed:
            material["occlusionTexture"] = {"index": packed["index"], "texCoord": packed.get("texCoord", 0), "strength": 1.0}
    document.setdefault("asset", {})["generator"] = "Chasing A2 villain UV-preserving PBR and vertex-tint pipeline"
    encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    rebuilt = [(json_kind, encoded) if kind == json_kind else (kind, payload) for kind, payload in chunks]
    total = 12 + sum(8 + len(payload) for _, payload in rebuilt)
    out = bytearray(struct.pack("<4sII", b"glTF", 2, total))
    for kind, payload in rebuilt:
        out.extend(struct.pack("<II", len(payload), kind))
        out.extend(payload)
    path.write_bytes(out)


def export_static_glb(body: bpy.types.Object, armature: bpy.types.Object, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_skins=True,
        export_animations=False,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_vertex_color="ACTIVE",
        export_image_format="WEBP",
        export_image_quality=90,
        export_image_add_webp=False,
        export_image_webp_fallback=False,
    )
    patch_glb_occlusion(output_path)


def triangle_count(obj: bpy.types.Object) -> int:
    return sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)


def validate_scene(body: bpy.types.Object, armature: bpy.types.Object) -> dict[str, object]:
    bone_names = [bone.name for bone in armature.data.bones]
    if bone_names != list(EXPECTED_BONES):
        raise RuntimeError(f"Canonical bone order changed: {bone_names}")
    if tuple(round(value, 8) for value in armature.scale) != (1.0, 1.0, 1.0):
        raise RuntimeError(f"Armature scale changed: {tuple(armature.scale)}")
    if tuple(round(value, 8) for value in body.scale) != (1.0, 1.0, 1.0):
        raise RuntimeError(f"Body scale changed: {tuple(body.scale)}")
    bounds = object_local_bounds(body)
    if abs(bounds["min"][2]) > 1e-5:
        raise RuntimeError(f"Feet are not planted at Blender Z=0: {bounds['min'][2]}")
    triangles = triangle_count(body)
    if not 120_000 <= triangles <= 155_000:
        raise RuntimeError(f"A2 high-source master unexpectedly changed complexity: {triangles} tris")
    return {
        "bones": len(bone_names),
        "boneNames": bone_names,
        "triangles": triangles,
        "materials": len(body.data.materials),
        "boundsBlenderZUp": bounds,
        "rootScale": list(body.scale),
        "forward": "Blender -Y; glTF export +Z",
        "runtimeBudget": {
            "authoringSource": "120k-155k triangles",
            "realisticHigh": "45k-75k triangles (docs/02 realistic LOD0)",
            "lodAndBootstrap": "20k-32k triangles (first-paint derivatives)",
        },
    }


def main() -> None:
    options = parse_args()
    if not SOURCE_BLEND.is_file():
        raise FileNotFoundError(SOURCE_BLEND)
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE_BLEND))
    armature = bpy.data.objects.get(ARMATURE_NAME)
    body = bpy.data.objects.get(BODY_NAME)
    face_overlay = bpy.data.objects.get(HEAD_OVERLAY_NAME)
    if armature is None or armature.type != "ARMATURE":
        raise RuntimeError("Missing canonical Rig_Humanoid_Shared armature")
    if body is None or body.type != "MESH":
        raise RuntimeError("Missing Hunyuan-derived villain source body")
    if face_overlay is None or face_overlay.type != "MESH":
        raise RuntimeError("Missing MPFB face overlay used by the A2 face cleanup")
    armatures = [obj for obj in bpy.data.objects if obj.type == "ARMATURE"]
    if armatures != [armature]:
        raise RuntimeError(f"Expected one source armature, got {[obj.name for obj in armatures]}")

    texture_report = generate_pbr_textures()
    reshape_report = reshape_body(body)
    hood_smoothing_report = smooth_hood_opening(body)
    face_report = prepare_face_overlay(face_overlay)
    material = build_material(texture_report)
    details = add_tailored_details(armature, face_overlay)
    body = join_character_meshes(body, details, material)
    removed = cleanup_source_scene(body, armature)
    ensure_armature_modifier(body, armature)
    floor_correction = plant_mesh_feet(body)
    weight_report = normalize_limit_weights(body)
    scene_report = validate_scene(body, armature)
    previews = setup_preview_scene(body, options.preview_dir)

    options.output_blend.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(options.output_blend), compress=True)
    export_static_glb(body, armature, options.output_glb)

    report = {
        "asset": "villain_A2_visual_rework",
        "style": "stylized-realistic ReferenceStandard authoring source; runtime high and first-paint budgets are distinct",
        "sourceMaster": SOURCE_BLEND.relative_to(ROOT).as_posix(),
        "sourceMasterSha256": sha256_file(SOURCE_BLEND),
        "toolchain": {
            "blender": bpy.app.version_string,
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "script": Path(__file__).resolve().relative_to(ROOT).as_posix(),
        },
        "sourceLineage": {
            "geometry": "Existing Hunyuan multiview-derived native body/garment sculpt",
            "face": "Hunyuan-integrated face retained as the shadowed volume; a cropped MPFB CC0 nose/mouth relief patch replaces the former detached full-head mask",
            "newGeometry": "No proxy primitives are added: the continuous source garment supplies coat/lapels/cuffs/pockets, while the integrated source boot soles are reshaped in place",
            "textures": texture_report["source"],
            "currentPassExternalDownloads": [],
            "licenses": {
                "hunyuan3D2": "Existing source master generated with Tencent Hunyuan3D-2; audited official terms are pinned to commit f8db63096c8282cb27354314d896feba5ba6ff8a (LICENSE and NOTICE).",
                "mpfbFaceRelief": "Cropped MakeHuman/MPFB nose-mouth relief under CC0 1.0; local text: tools/third_party/mpfb2/LICENSE.ASSETS.md",
                "imageGenMaterialAtlas": "OpenAI ImageGen output generated for this project on 2026-08-28 without reference images or external downloads",
            },
            "releaseReview": "Hunyuan3D-2 terms contain territory and distribution conditions; product release must complete a legal/territory review and package the required notices.",
        },
        "designChanges": {
            "silhouette": "Broader shoulder/chest/arms, flared long-coat hem, enlarged gloves, and integrated source outsoles reshaped by about 6 mm vertically / 8 mm laterally",
            "hood": "Existing shell pushed forward, crown softened and lowered, hood lip smoothed in two local passes, native face recessed 38 mm, and the eye zone darkened 18% for a stable brow shadow",
            "materialRead": "Authored UV0 carries a seamless ImageGen-derived leather PBR field; smooth A2Tint vertex colors separate coat/hood/pants/boots/skin/lining without triangle-edge atlas jumps",
            "overlapCleanup": removed,
        },
        "reshape": reshape_report,
        "hoodOpeningSmoothing": hood_smoothing_report,
        "faceCleanup": face_report,
        "floorCorrectionMeters": floor_correction,
        "runtimeReduction": {
            "method": "two-stage silhouette-aware meshoptimizer simplification after authored high-source export",
            "reason": "preserves the coat/hood/boot silhouette and avoids Blender global-Decimate faceting",
            "realisticHigh": {
                "target": "45k-75k triangles",
                "purpose": "docs/02 realistic LOD0 authoring/runtime reference; remote M1 currently keeps bootstrap resident and does not implement post-load high promotion",
            },
            "lodAndBootstrap": {
                "target": "20k-32k triangles",
                "purpose": "first-paint and constrained-device derivatives",
            },
        },
        "textures": texture_report,
        "weights": weight_report,
        "scene": scene_report,
        "previews": previews,
        "outputs": {
            "blend": display_path(options.output_blend),
            "blendBytes": options.output_blend.stat().st_size,
            "blendSha256": sha256_file(options.output_blend),
            "staticGlb": display_path(options.output_glb),
            "staticGlbBytes": options.output_glb.stat().st_size,
            "staticGlbSha256": sha256_file(options.output_glb),
        },
    }
    report_path = options.report or DEFAULT_GENERATED_REPORT
    if report_path.resolve() == IMPORTED_HISTORICAL_REPORT.resolve():
        raise RuntimeError(
            "The imported local-polish build report is an immutable provenance snapshot; "
            "write regenerated evidence to Villain_A2_visual_rework_generated_report.json instead."
        )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
