#!/usr/bin/env python3
"""Run TripoSR without xatlas/rembg imports.

This runner is only for local feasibility checks and mesh extraction. It expects
input images to already be square RGB images with a neutral gray background and
a single centered subject.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch
import numpy as np
import rembg
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
TRIPOSR = ROOT / "tools" / "third_party" / "TripoSR"
sys.path.insert(0, str(TRIPOSR))

from tsr.system import TSR  # noqa: E402
from tsr.utils import remove_background, resize_foreground  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model", default="stabilityai/TripoSR")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--chunk-size", type=int, default=2048)
    parser.add_argument("--mc-resolution", type=int, default=128)
    parser.add_argument("--format", choices=["obj", "glb"], default="obj")
    parser.add_argument("--remove-bg", action="store_true")
    parser.add_argument("--foreground-ratio", type=float, default=0.85)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    device = args.device
    if device == "mps" and not torch.backends.mps.is_available():
        device = "cpu"
    if device.startswith("cuda") and not torch.cuda.is_available():
        device = "cpu"

    model = TSR.from_pretrained(args.model, config_name="config.yaml", weight_name="model.ckpt")
    model.renderer.set_chunk_size(args.chunk_size)
    model.to(device)
    model.eval()

    rembg_session = rembg.new_session() if args.remove_bg else None
    for index, image_path in enumerate(args.images):
        image = Image.open(image_path).convert("RGB")
        if args.remove_bg:
            rgba = remove_background(image, rembg_session)
            rgba = resize_foreground(rgba, args.foreground_ratio)
            arr = np.array(rgba).astype(np.float32) / 255.0
            rgb = arr[:, :, :3] * arr[:, :, 3:4] + (1.0 - arr[:, :, 3:4]) * 0.5
            image = Image.fromarray((rgb * 255.0).astype(np.uint8))
        item_dir = out_dir / str(index)
        item_dir.mkdir(parents=True, exist_ok=True)
        image.save(item_dir / "input.png")
        with torch.no_grad():
            scene_codes = model([image], device=device)
            meshes = model.extract_mesh(scene_codes, True, resolution=args.mc_resolution)
        mesh_path = item_dir / f"mesh.{args.format}"
        meshes[0].export(mesh_path)
        print(mesh_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
