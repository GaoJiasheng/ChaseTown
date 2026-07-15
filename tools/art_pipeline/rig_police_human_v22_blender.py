"""Rig the v22 human-anatomy police remodel with the shared humanoid skeleton."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import rig_precision_remodel_v21_blender as pipeline  # noqa: E402


ASSET_DIR = (
    ROOT
    / "art-source/Characters/Police/ReferenceStandard"
    / "HumanAnatomyRemodel_2026_07_14_v22"
)


def role_paths(role: str) -> tuple[Path, Path, Path, Path]:
    if role != "Police":
        raise ValueError(f"Unsupported role for v22 human-anatomy rig: {role}")
    rigged_dir = ASSET_DIR / "Rigged"
    stem = "Police_HumanAnatomyRemodel_v22_Rigged"
    return (
        ASSET_DIR / "Police_HumanAnatomyRemodel_v22.blend",
        rigged_dir,
        rigged_dir / f"{stem}.blend",
        rigged_dir / f"{stem}.fbx",
    )


pipeline.ROLES = ("Police",)
pipeline.role_paths = role_paths


if __name__ == "__main__":
    pipeline.main()
