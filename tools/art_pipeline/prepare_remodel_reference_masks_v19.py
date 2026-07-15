#!/usr/bin/env python3
"""Remove studio backgrounds from the approved v17 turnaround crops."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
from rembg import new_session, remove


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/art_production/fourview_remodel_v17/references/crops"
OUT = ROOT / "docs/art_production/fourview_remodel_v19_native_projected/masked_references"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    session = new_session("u2netp")
    manifest: dict[str, dict[str, object]] = {}
    for role in ("Kid", "Villain", "Police"):
        for view in ("front", "right", "back", "top"):
            source = SOURCE / f"{role}_{view}.png"
            output = OUT / source.name
            image = Image.open(source).convert("RGB")
            cutout = remove(
                image,
                session=session,
                alpha_matting=False,
                post_process_mask=True,
            ).convert("RGBA")
            cutout.save(output, optimize=True)
            bbox = cutout.getchannel("A").getbbox()
            manifest[f"{role}_{view}"] = {
                "source": str(source.relative_to(ROOT)),
                "output": str(output.relative_to(ROOT)),
                "size": list(cutout.size),
                "alpha_bbox": list(bbox) if bbox else None,
            }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(OUT / "manifest.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
