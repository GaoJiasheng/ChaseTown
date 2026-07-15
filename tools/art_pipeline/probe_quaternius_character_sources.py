"""Render a quick source contact sheet for downloaded Quaternius characters.

Run with:
  blender --background --python tools/art_pipeline/probe_quaternius_character_sources.py

This is an art-direction probe only. It does not write final Unity assets.
"""

from __future__ import annotations

from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "art_production" / "quaternius_source_probe"

CANDIDATES = [
    ("Kid_Casual", ROOT / "art-source/_Source/Characters/Quaternius/UltimateModularCharacters/Humanoid Rig/Individual Characters/Blend/Casual.blend"),
    ("Kid_Casual2", ROOT / "art-source/_Source/Characters/Quaternius/UltimateModularCharacters/Humanoid Rig/Individual Characters/Blend/Casual2.blend"),
    ("Kid_Adventurer", ROOT / "art-source/_Source/Characters/Quaternius/UltimateModularCharacters/Humanoid Rig/Individual Characters/Blend/Adventurer.blend"),
    ("Villain_Punk", ROOT / "art-source/_Source/Characters/Quaternius/UltimateModularCharacters/Humanoid Rig/Individual Characters/Blend/Punk.blend"),
    ("Villain_Suit", ROOT / "art-source/_Source/Characters/Quaternius/UltimateModularCharacters/Humanoid Rig/Individual Characters/Blend/Suit.blend"),
    ("Police_Swat", ROOT / "art-source/_Source/Characters/Quaternius/UltimateModularCharacters/Humanoid Rig/Individual Characters/Blend/Swat.blend"),
]


def bounds_for(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    pts = []
    for obj in meshes:
        pts.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    min_v = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    max_v = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return min_v, max_v


def look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def normalize_scene() -> float:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    min_v, max_v = bounds_for(meshes)
    height = max(max_v.z - min_v.z, 0.01)
    center_x = (min_v.x + max_v.x) * 0.5
    center_y = (min_v.y + max_v.y) * 0.5
    for obj in meshes:
        obj.location.x -= center_x
        obj.location.y -= center_y
        obj.location.z -= min_v.z
    return height


def setup_render(label: str, height: float) -> None:
    bpy.context.scene.render.resolution_x = 1000
    bpy.context.scene.render.resolution_y = 1300
    try:
        bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass
    bpy.context.scene.view_settings.view_transform = "Filmic"
    bpy.context.scene.world = bpy.data.worlds.new("Probe_World") if not bpy.context.scene.world else bpy.context.scene.world
    bpy.context.scene.world.color = (0.035, 0.035, 0.038)

    for obj in list(bpy.context.scene.objects):
        if obj.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(obj, do_unlink=True)

    bpy.ops.object.light_add(type="AREA", location=(2.3, -3.8, height * 1.75))
    key = bpy.context.object
    key.name = "Probe_Key"
    key.data.energy = 720
    key.data.size = 4.2
    bpy.ops.object.light_add(type="POINT", location=(-2.4, -2.2, height * 0.85))
    fill = bpy.context.object
    fill.name = "Probe_Fill"
    fill.data.energy = 105

    bpy.ops.object.camera_add(location=(1.35, -4.2, height * 0.72))
    cam = bpy.context.object
    look_at(cam, Vector((0, 0, height * 0.52)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = height * 1.52
    bpy.context.scene.camera = cam

    # Name the collection so generated renders are easy to map to a source file.
    bpy.context.scene.name = label


def render_candidate(label: str, path: Path) -> None:
    bpy.ops.wm.open_mainfile(filepath=str(path))
    height = normalize_scene()
    setup_render(label, height)
    OUT.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(OUT / f"{label}.png")
    bpy.ops.render.render(write_still=True)


def main() -> None:
    for label, path in CANDIDATES:
        if path.exists():
            render_candidate(label, path)
        else:
            print(f"Missing source: {path}")


if __name__ == "__main__":
    main()
