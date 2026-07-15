#!/usr/bin/env python3
"""Download a narrow CC0 PBR source set from Poly Haven.

The rework spec requires real texture sources instead of flat color maps. This
script keeps the source set intentionally small and writes provenance metadata
beside the downloaded files.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "art-source" / "_Source" / "PBR" / "PolyHaven"
USER_AGENT = "ChasingArtPipeline/1.0 local-rework"


SOURCE_ASSETS = {
    "denim_fabric": {
        "usage": "Kid hoodie, shorts, backpack, and shoe fabric base",
        "resolutions": ["2k", "4k"],
    },
    "fabric_leather_01": {
        "usage": "Villain coat/hood/glove dark leather-fabric base",
        "resolutions": ["2k", "4k"],
    },
    "denim_fabric_03": {
        "usage": "Police navy uniform fabric base",
        "resolutions": ["2k", "4k"],
    },
    "painted_plaster_wall": {
        "usage": "School painted wall modules",
        "resolutions": ["2k"],
    },
    "blue_floor_tiles_01": {
        "usage": "School hallway tile floor",
        "resolutions": ["2k"],
    },
    "wood_floor_worn": {
        "usage": "Classroom worn wooden floor",
        "resolutions": ["2k"],
    },
    "rubberized_track": {
        "usage": "Playground rubber floor",
        "resolutions": ["2k"],
    },
    "leafy_grass": {
        "usage": "Outdoor school grass patches",
        "resolutions": ["2k"],
    },
    "blue_metal_plate": {
        "usage": "Painted metal doors, lockers, police props",
        "resolutions": ["2k"],
    },
    "brown_planks_07": {
        "usage": "Classroom doors, benches, trim",
        "resolutions": ["2k"],
    },
    "metal_plate": {
        "usage": "Generic worn metal details",
        "resolutions": ["2k"],
    },
}

MAPS = {
    "Diffuse": "BaseColor",
    "nor_gl": "Normal",
    "AO": "AO",
    "Rough": "Roughness",
}


def fetch_json(url: str) -> dict:
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=180) as response:
                return json.load(response)
        except Exception as exc:  # network flakes are common on large metadata.
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_error}")


def download(url: str, dest: Path, expected_md5: str | None) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        tmp = dest.with_suffix(dest.suffix + ".part")
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=300) as response:
                    tmp.write_bytes(response.read())
                tmp.replace(dest)
                break
            except Exception as exc:
                last_error = exc
                tmp.unlink(missing_ok=True)
                time.sleep(2.0 * (attempt + 1))
        if not dest.exists():
            raise RuntimeError(f"Failed to download {url}: {last_error}")

    digest = hashlib.md5(dest.read_bytes()).hexdigest()
    return {
        "path": str(dest.relative_to(ROOT)),
        "bytes": dest.stat().st_size,
        "md5": digest,
        "expected_md5": expected_md5,
        "md5_matched": bool(expected_md5 and digest == expected_md5),
        "url": url,
    }


def pick_entry(files: dict, map_name: str, resolution: str) -> tuple[str, dict]:
    formats = files[map_name][resolution]
    for fmt in ("jpg", "png"):
        if fmt in formats:
            return fmt, formats[fmt]
    raise RuntimeError(f"No jpg/png entry for {map_name} {resolution}")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "license": "CC0",
        "source": "https://polyhaven.com/textures",
        "downloaded_assets": {},
    }

    for asset_id, config in SOURCE_ASSETS.items():
        files = fetch_json(f"https://api.polyhaven.com/files/{asset_id}")
        asset_record = {
            "usage": config["usage"],
            "source_url": f"https://polyhaven.com/a/{asset_id}",
            "license": "CC0",
            "maps": {},
        }
        for resolution in config["resolutions"]:
            for poly_map, local_map in MAPS.items():
                fmt, entry = pick_entry(files, poly_map, resolution)
                stem = f"{asset_id}_{local_map}_{resolution}.{fmt}"
                dest = OUT / asset_id / resolution / stem
                result = download(entry["url"], dest, entry.get("md5"))
                asset_record["maps"].setdefault(resolution, {})[local_map] = result
        manifest["downloaded_assets"][asset_id] = asset_record

    manifest_path = OUT / "polyhaven_pbr_manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(manifest_path.relative_to(ROOT)), "asset_count": len(SOURCE_ASSETS)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
