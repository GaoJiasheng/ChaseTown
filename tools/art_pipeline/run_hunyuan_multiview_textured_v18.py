#!/usr/bin/env python3
"""Generate a textured Hunyuan3D model from the approved four-view references."""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from gradio_client import Client, handle_file
from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
PRODUCTION = ROOT / "docs" / "art_production" / "hunyuan_multiview_textured_v18"
SOURCE_CROPS = ROOT / "docs" / "art_production" / "fourview_remodel_v17" / "references" / "crops"


def resolve_result_path(value) -> Path:
    if isinstance(value, str):
        return Path(value)
    if isinstance(value, dict) and value.get("path"):
        return Path(value["path"])
    path = getattr(value, "path", None)
    if path:
        return Path(path)
    raise TypeError(f"Unsupported Gradio file result: {value!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("role", choices=("Kid", "Villain", "Police"))
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20260713)
    parser.add_argument("--octree", type=int, default=256)
    args = parser.parse_args()

    out = PRODUCTION / args.role
    inputs = out / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)

    source = {view: SOURCE_CROPS / f"{args.role}_{view}.png" for view in ("front", "right", "back")}
    front = inputs / "front.png"
    back = inputs / "back.png"
    left = inputs / "left.png"
    right = inputs / "right.png"
    shutil.copy2(source["front"], front)
    shutil.copy2(source["back"], back)
    shutil.copy2(source["right"], left)
    with Image.open(source["right"]).convert("RGB") as profile:
        profile.transpose(Image.Transpose.FLIP_LEFT_RIGHT).save(right, optimize=True)

    client = Client("tencent/Hunyuan3D-2")
    result = client.predict(
        caption=None,
        image=handle_file(str(front)),
        mv_image_front=handle_file(str(front)),
        mv_image_back=handle_file(str(back)),
        mv_image_left=handle_file(str(left)),
        mv_image_right=handle_file(str(right)),
        steps=args.steps,
        guidance_scale=5.0,
        seed=args.seed,
        octree_resolution=args.octree,
        check_box_rembg=True,
        num_chunks=8000,
        randomize_seed=False,
        api_name="/generation_all",
    )

    shape_path = resolve_result_path(result[0])
    textured_path = resolve_result_path(result[1])
    shape_out = out / f"{args.role}_HunyuanMV_v18_shape{shape_path.suffix or '.glb'}"
    textured_out = out / f"{args.role}_HunyuanMV_v18_textured{textured_path.suffix or '.glb'}"
    shutil.copy2(shape_path, shape_out)
    shutil.copy2(textured_path, textured_out)
    metadata = {
        "role": args.role,
        "space": "tencent/Hunyuan3D-2",
        "api": "/generation_all",
        "steps": args.steps,
        "guidance_scale": 5.0,
        "seed_requested": args.seed,
        "seed_returned": result[4],
        "octree_resolution": args.octree,
        "mesh_stats": result[3],
        "shape": str(shape_out.relative_to(ROOT)),
        "textured": str(textured_out.relative_to(ROOT)),
        "inputs": {name: str(path.relative_to(ROOT)) for name, path in {"front": front, "back": back, "left": left, "right": right}.items()},
    }
    (out / "generation.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(textured_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
