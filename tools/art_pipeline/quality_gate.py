#!/usr/bin/env python3
"""Machine quality gates for Chasing art textures.

Usage:
  python3 tools/art_pipeline/quality_gate.py <texture.png> <basecolor|normal|ao>

This implements the hard red lines in docs/04_Codex返工规格与验收标准.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


THRESHOLDS = {
    "basecolor": 8.0,
    "normal": 4.0,
    "ao": 3.0,
}


def check(path: str | Path, kind: str) -> dict:
    kind = kind.lower()
    if kind not in THRESHOLDS:
        raise ValueError(f"kind must be one of {sorted(THRESHOLDS)}")

    path = Path(path)
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    stddev = float(img.std())
    threshold = THRESHOLDS[kind]
    return {
        "file": str(path),
        "kind": kind,
        "stddev": round(stddev, 2),
        "threshold": threshold,
        "passed": stddev >= threshold,
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: quality_gate.py <texture.png> <basecolor|normal|ao>", file=sys.stderr)
        return 2

    try:
        result = check(sys.argv[1], sys.argv[2])
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
