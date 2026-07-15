#!/usr/bin/env python3
"""Validate FBX readability with assimp and write a compact JSON report."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--glob", action="append", required=True, help="Workspace-relative glob for FBX files.")
    parser.add_argument("--out", required=True, help="Workspace-relative JSON report path.")
    parser.add_argument(
        "--require-node",
        action="append",
        default=[],
        help="Exact node name required in the Assimp node hierarchy; repeat as needed.",
    )
    return parser.parse_args()


def parse_metric(output: str, label: str) -> int | None:
    match = re.search(rf"(?m)^{re.escape(label)}:\s+(\d+)$", output)
    return int(match.group(1)) if match else None


def parse_hierarchy_nodes(output: str) -> list[str]:
    marker = "Node hierarchy:"
    if marker not in output:
        return []
    hierarchy = output.split(marker, 1)[1]
    nodes = []
    for raw_line in hierarchy.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        name = line.rsplit("╴", 1)[-1].split(" (mesh", 1)[0].strip()
        if name:
            nodes.append(name)
    return nodes


def main() -> int:
    args = parse_args()
    files: list[Path] = []
    for pattern in args.glob:
        files.extend(ROOT.glob(pattern))
    files = sorted({path for path in files if path.is_file()})

    results = []
    for path in files:
        proc = subprocess.run(["assimp", "info", str(path)], text=True, capture_output=True)
        hierarchy_nodes = parse_hierarchy_nodes(proc.stdout)
        missing_nodes = [name for name in args.require_node if name not in hierarchy_nodes]
        results.append(
            {
                "file": str(path.relative_to(ROOT)),
                "passed": proc.returncode == 0 and not missing_nodes,
                "metrics": {
                    "nodes": parse_metric(proc.stdout, "Nodes"),
                    "meshes": parse_metric(proc.stdout, "Meshes"),
                    "embedded_textures": parse_metric(proc.stdout, "Textures (embed.)"),
                    "materials": parse_metric(proc.stdout, "Materials"),
                    "vertices": parse_metric(proc.stdout, "Vertices"),
                    "faces": parse_metric(proc.stdout, "Faces"),
                    "mesh_bone_reference_count": parse_metric(proc.stdout, "Bones"),
                },
                "required_nodes": args.require_node,
                "missing_required_nodes": missing_nodes,
                "stderr": proc.stderr.strip(),
            }
        )

    summary = {
        "count": len(results),
        "passed": sum(1 for item in results if item["passed"]),
        "failed": [item["file"] for item in results if not item["passed"]],
        "results": results,
    }
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["passed"] == summary["count"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
