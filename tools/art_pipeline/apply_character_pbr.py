#!/usr/bin/env python3
"""Apply export-safe PBR materials to an already animated character GLB.

This is intentionally a post-process step.  Animation retargeting owns the
character GLBs first; this script imports that finished result, changes only a
small allow-list of primary-body materials, and exports a new GLB.  Accessory
materials, meshes, skinning, and animation clips are left alone.

Examples (run with Blender):

    blender --background --factory-startup \
      --python tools/art_pipeline/apply_character_pbr.py -- \
      --role kid \
      --input public/models/characters/kid.glb \
      --output /tmp/chasing-character-pbr/kid.glb \
      --review-dir /tmp/chasing-character-pbr/kid-review

The police v22 body uses the canonical MakeHuman UV layout.  Its exact CC0
skin diffuse and casual-suit normal are downloaded to the OS temp cache and
verified against their Git-LFS SHA-256 objects.  They are embedded into the
output GLB and are not added to the repository as loose duplicate files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import ssl
import struct
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import bpy
import numpy as np
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CACHE = Path(tempfile.gettempdir()) / "chasing-character-pbr-cache"
WEB_DETAIL_RESOLUTION = 768


@dataclass(frozen=True)
class RemoteTexture:
    filename: str
    url: str
    sha256: str
    size: int


MAKEHUMAN_SKIN = RemoteTexture(
    "young_lightskinned_male_diffuse2.png",
    "https://free.downloads.tuxfamily.net/makehuman/assets/1.1/base/skins/textures/young_lightskinned_male_diffuse2.png",
    "03efe1f6b0ae52429649dcefc9dcaef6058032f874a251169cc3e2ed473c3874",
    3_595_270,
)
MAKEHUMAN_SUIT_NORMAL = RemoteTexture(
    "male_casualsuit03_normal.png",
    "https://free.downloads.tuxfamily.net/makehuman/assets/1.1/base/clothes/male_casualsuit03/male_casualsuit03_normal.png",
    "412c4610d3b2ea1cb04aa3c0715e747a7c9f61d865133b7d69f70eaa738cf99b",
    9_610_278,
)


ROLE_MAIN_MATERIALS = {
    "kid": ("M_Kid_PrecisionRemodel_v21_URP",),
    "villain": ("M_Villain_PrecisionRemodel_v21_URP",),
    "police": (
        "M_Police_v22_SkinUV",
        "M_Police_v22_UniformNavy",
        "M_Police_v22_TrouserNavy",
    ),
}


ROLE_MAIN_OBJECTS = {
    "kid": ("Kid_v20_NativeBodyHead",),
    "villain": ("Villain_v20_NativeBodyHead",),
    "police": ("Police_v22_Body", "Police_v22_Uniform"),
}


V21_ROOTS = {
    role: ROOT
    / f"art-source/Characters/{role.title()}/ReferenceStandard/PrecisionRemodel_2026_07_13_v21"
    for role in ("kid", "villain", "police")
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=tuple(ROLE_MAIN_MATERIALS), required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--review-dir", type=Path)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--no-download", action="store_true")
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified(path: Path, expected_sha256: str, expected_size: int | None = None) -> bool:
    return (
        path.is_file()
        and (expected_size is None or path.stat().st_size == expected_size)
        and sha256(path) == expected_sha256
    )


def fetch_verified(texture: RemoteTexture, cache_dir: Path, no_download: bool) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / texture.filename
    if verified(target, texture.sha256, texture.size):
        return target
    if no_download:
        raise FileNotFoundError(
            f"Missing verified MakeHuman cache file {target}; expected sha256={texture.sha256}"
        )

    # TuxFamily currently serves this official historical mirror with a host
    # name mismatch.  Integrity does not rely on transport here: every byte is
    # checked against the canonical MakeHuman Git-LFS object id above.
    context = ssl._create_unverified_context()
    partial = target.with_suffix(target.suffix + ".partial")
    request = urllib.request.Request(texture.url, headers={"User-Agent": "Chasing-PBR-Builder/1"})
    print(f"Downloading pinned CC0 texture: {texture.url}")
    with urllib.request.urlopen(request, context=context, timeout=180) as response:
        payload = response.read()
    partial.write_bytes(payload)
    if not verified(partial, texture.sha256, texture.size):
        actual = sha256(partial) if partial.is_file() else "missing"
        raise RuntimeError(
            f"Downloaded texture failed integrity check: {partial}; sha256={actual}, bytes={partial.stat().st_size}"
        )
    partial.replace(target)
    return target


def clear_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # glTF animation time is converted through the scene rate at import and
    # export.  The authored contract is 30 fps; leaving Blender's 24 fps
    # factory default silently shortens clips and drops six samples/second.
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1.0


def import_character(path: Path) -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    if not path.is_file():
        raise FileNotFoundError(path)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"Expected one armature, found {[obj.name for obj in armatures]}")
    armature = armatures[0]
    meshes = [
        obj
        for obj in bpy.context.scene.objects
        if obj.type == "MESH"
        and (
            obj.parent == armature
            or any(mod.type == "ARMATURE" and mod.object == armature for mod in obj.modifiers)
        )
    ]
    if not meshes:
        raise RuntimeError("No skinned character meshes found")
    if armature.animation_data:
        for track in armature.animation_data.nla_tracks:
            track.mute = True
    return armature, meshes


def activate_idle_review_pose(armature: bpy.types.Object) -> None:
    idle = bpy.data.actions.get("Idle")
    if idle is None:
        return
    armature.animation_data_create()
    armature.animation_data.action = idle
    if idle.slots:
        try:
            armature.animation_data.action_slot = idle.slots[0]
        except (AttributeError, RuntimeError, TypeError):
            pass
    start, end = map(float, idle.frame_range)
    frame = start + (end - start) * 0.24
    whole = math.floor(frame)
    bpy.context.scene.frame_set(whole, subframe=frame - whole)
    bpy.context.view_layer.update()


def material_snapshot(material: bpy.types.Material) -> dict[str, Any]:
    principled = material.node_tree.nodes.get("Principled BSDF") if material.use_nodes else None
    if principled is None:
        return {
            "name": material.name,
            "diffuse": [round(float(v), 6) for v in material.diffuse_color],
            "useNodes": bool(material.use_nodes),
        }
    return {
        "name": material.name,
        "baseColor": [round(float(v), 6) for v in principled.inputs["Base Color"].default_value],
        "metallic": round(float(principled.inputs["Metallic"].default_value), 6),
        "roughness": round(float(principled.inputs["Roughness"].default_value), 6),
        "alpha": round(float(principled.inputs["Alpha"].default_value), 6),
        "blendMethod": getattr(material, "surface_render_method", "DITHERED"),
        "doubleSided": not bool(material.use_backface_culling),
    }


def mesh_snapshot(meshes: list[bpy.types.Object]) -> dict[str, Any]:
    return {
        obj.name: {
            "vertices": len(obj.data.vertices),
            "polygons": len(obj.data.polygons),
            "triangles": sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons),
            "uvLayers": [layer.name for layer in obj.data.uv_layers],
            "materials": [material.name if material else None for material in obj.data.materials],
        }
        for obj in meshes
    }


def animation_snapshot() -> dict[str, Any]:
    return {
        action.name: {
            "frameRange": [round(float(action.frame_range[0]), 4), round(float(action.frame_range[1]), 4)],
            "slots": len(action.slots),
        }
        for action in bpy.data.actions
        if not action.name.startswith("__")
    }


def target_uv_evidence(role: str, meshes: list[bpy.types.Object]) -> dict[str, Any]:
    evidence: dict[str, Any] = {}
    for object_name in ROLE_MAIN_OBJECTS[role]:
        obj = next((candidate for candidate in meshes if candidate.name == object_name), None)
        if obj is None:
            raise RuntimeError(f"Missing expected primary mesh {object_name}")
        if not obj.data.uv_layers.active:
            raise RuntimeError(f"Primary mesh {object_name} has no active UV set")
        layer = obj.data.uv_layers.active
        values = np.empty(len(layer.data) * 2, dtype=np.float32)
        layer.data.foreach_get("uv", values)
        evidence[object_name] = {
            "uvLayer": layer.name,
            "uvLoopCount": len(layer.data),
            "uvMin": [round(float(values[0::2].min()), 6), round(float(values[1::2].min()), 6)],
            "uvMax": [round(float(values[0::2].max()), 6), round(float(values[1::2].max()), 6)],
            "quantizedUvSha256": hashlib.sha256(np.round(values, 6).tobytes()).hexdigest(),
        }
    return evidence


def load_image(path: Path, colorspace: str, name: str | None = None) -> bpy.types.Image:
    if not path.is_file():
        raise FileNotFoundError(path)
    image = bpy.data.images.load(str(path.resolve()), check_existing=False)
    if name:
        image.name = name
    image.colorspace_settings.name = colorspace
    return image


def image_pixels(image: bpy.types.Image) -> np.ndarray:
    width, height = map(int, image.size)
    values = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(values)
    return values.reshape((height, width, 4))


def save_generated_image(
    name: str,
    values: np.ndarray,
    path: Path,
    colorspace: str,
) -> bpy.types.Image:
    if values.ndim != 3 or values.shape[2] != 4:
        raise ValueError(f"Expected HxWx4 image, got {values.shape}")
    height, width, _ = values.shape
    path.parent.mkdir(parents=True, exist_ok=True)
    image = bpy.data.images.new(name, width=width, height=height, alpha=True)
    image.colorspace_settings.name = colorspace
    image.pixels.foreach_set(np.ascontiguousarray(values, dtype=np.float32).reshape(-1))
    image.filepath_raw = str(path.resolve())
    image.file_format = "PNG"
    image.save()
    return image


def build_v21_orm(role: str, output_dir: Path) -> bpy.types.Image:
    label = role.title()
    textures = V21_ROOTS[role] / "Textures"
    ao_path = textures / f"Char_{label}_PrecisionRemodel_v21_AO_2K.png"
    ms_path = textures / f"Char_{label}_PrecisionRemodel_v21_MetallicSmoothness_2K.png"
    ao = load_image(ao_path, "Non-Color", f"{label}_PBR_Source_AO")
    metallic_smoothness = load_image(ms_path, "Non-Color", f"{label}_PBR_Source_MetallicSmoothness")
    # 768px is ample for high-frequency material response at the shipped camera
    # distance, while the identity-bearing painted BaseColor remains 2K.
    ao.scale(WEB_DETAIL_RESOLUTION, WEB_DETAIL_RESOLUTION)
    metallic_smoothness.scale(WEB_DETAIL_RESOLUTION, WEB_DETAIL_RESOLUTION)
    ao_values = image_pixels(ao)
    ms_values = image_pixels(metallic_smoothness)
    if ao_values.shape != ms_values.shape:
        raise RuntimeError(f"AO/MS dimensions differ: {ao_values.shape} vs {ms_values.shape}")
    orm = np.ones_like(ms_values)
    orm[:, :, 0] = ao_values[:, :, 0]
    orm[:, :, 1] = np.clip(1.0 - ms_values[:, :, 3], 0.04, 1.0)
    orm[:, :, 2] = ms_values[:, :, 0]
    return save_generated_image(
        f"Char_{label}_PrecisionRemodel_v21_ORM_{WEB_DETAIL_RESOLUTION}",
        orm,
        output_dir / f"Char_{label}_PrecisionRemodel_v21_ORM_{WEB_DETAIL_RESOLUTION}.png",
        "Non-Color",
    )


def resized_image(
    source_path: Path,
    colorspace: str,
    name: str,
    output_dir: Path,
    size: int,
) -> bpy.types.Image:
    image = load_image(source_path, colorspace, name)
    image.scale(size, size)
    output = output_dir / f"{name}.png"
    output.parent.mkdir(parents=True, exist_ok=True)
    image.filepath_raw = str(output.resolve())
    image.file_format = "PNG"
    image.save()
    return image


def periodic_noise(size: int, seed: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    axis = np.arange(size, dtype=np.float32) / float(size)
    u, v = np.meshgrid(axis, axis)
    grain = (
        np.sin((u * 79.0 + v * 3.0 + seed) * math.tau)
        + np.sin((v * 83.0 - u * 2.0 + seed * 1.7) * math.tau)
        + 0.5 * np.sin((u * 151.0 + v * 137.0 + seed * 2.3) * math.tau)
    ) / 2.5
    du = np.roll(grain, -1, axis=1) - np.roll(grain, 1, axis=1)
    dv = np.roll(grain, -1, axis=0) - np.roll(grain, 1, axis=0)
    return grain, du, dv


def generated_micro_normal(name: str, output_dir: Path, size: int, seed: float, strength: float) -> bpy.types.Image:
    _, du, dv = periodic_noise(size, seed)
    x = -du * strength
    y = -dv * strength
    z = np.ones_like(x)
    length = np.sqrt(x * x + y * y + z * z)
    values = np.ones((size, size, 4), dtype=np.float32)
    values[:, :, 0] = x / length * 0.5 + 0.5
    values[:, :, 1] = y / length * 0.5 + 0.5
    values[:, :, 2] = z / length * 0.5 + 0.5
    return save_generated_image(name, values, output_dir / f"{name}.png", "Non-Color")


def generated_orm(
    name: str,
    output_dir: Path,
    size: int,
    seed: float,
    ao: float,
    roughness: float,
    metallic: float,
) -> bpy.types.Image:
    grain, _, _ = periodic_noise(size, seed)
    values = np.ones((size, size, 4), dtype=np.float32)
    values[:, :, 0] = np.clip(ao + grain * 0.018, 0.0, 1.0)
    values[:, :, 1] = np.clip(roughness + grain * 0.055, 0.04, 1.0)
    values[:, :, 2] = metallic
    return save_generated_image(name, values, output_dir / f"{name}.png", "Non-Color")


def generated_fabric_base(
    name: str,
    output_dir: Path,
    linear_color: tuple[float, float, float],
    size: int,
    seed: float,
) -> bpy.types.Image:
    grain, _, _ = periodic_noise(size, seed)
    # Values written through Blender's image API are scene-linear.  Saving as
    # sRGB and decoding in the shader returns the same material-space color.
    values = np.ones((size, size, 4), dtype=np.float32)
    modulation = np.clip(1.0 + grain * 0.11, 0.82, 1.18)
    for channel, color in enumerate(linear_color):
        values[:, :, channel] = np.clip(color * modulation, 0.0, 1.0)
    return save_generated_image(name, values, output_dir / f"{name}.png", "sRGB")


def ensure_gltf_occlusion_group() -> bpy.types.NodeTree:
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    if "Occlusion" not in group.interface.items_tree:
        group.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketColor")
    return group


def configure_export_safe_pbr(
    material: bpy.types.Material,
    base: bpy.types.Image,
    normal: bpy.types.Image,
    orm: bpy.types.Image,
    normal_strength: float,
) -> None:
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    links = material.node_tree.links

    output = nodes.new("ShaderNodeOutputMaterial")
    output.name = "Material Output"
    output.location = (720, 80)
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.name = "Principled BSDF"
    principled.location = (430, 80)
    principled.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    principled.inputs["Metallic"].default_value = 1.0
    principled.inputs["Roughness"].default_value = 1.0
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])

    base_node = nodes.new("ShaderNodeTexImage")
    base_node.name = "PBR BaseColor"
    base_node.label = "PBR BaseColor (embedded)"
    base_node.image = base
    base_node.location = (-520, 300)
    links.new(base_node.outputs["Color"], principled.inputs["Base Color"])

    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.name = "PBR Normal"
    normal_node.label = "PBR Tangent Normal (embedded)"
    normal_node.image = normal
    normal_node.location = (-520, 40)
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = normal_strength
    normal_map.location = (120, -80)
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])

    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.name = "PBR ORM"
    orm_node.label = "Occlusion / Roughness / Metallic (RGB)"
    orm_node.image = orm
    orm_node.location = (-520, -250)
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.mode = "RGB"
    separate.location = (-80, -230)
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    links.new(separate.outputs["Green"], principled.inputs["Roughness"])
    links.new(separate.outputs["Blue"], principled.inputs["Metallic"])

    gltf_group = nodes.new("ShaderNodeGroup")
    gltf_group.name = "glTF Material Output"
    gltf_group.node_tree = ensure_gltf_occlusion_group()
    gltf_group.location = (180, -400)
    links.new(orm_node.outputs["Color"], gltf_group.inputs["Occlusion"])


def role_v21_images(role: str, generated_dir: Path) -> tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    label = role.title()
    root = V21_ROOTS[role]
    base = load_image(
        root / "Rigged/Textures" / f"Char_{label}_PrecisionRemodel_v21_BaseColor_2K.png",
        "sRGB",
        f"Char_{label}_PrecisionRemodel_v21_BaseColor_2K",
    )
    normal = resized_image(
        root / "Textures" / f"Char_{label}_PrecisionRemodel_v21_Normal_2K.png",
        "Non-Color",
        f"Char_{label}_PrecisionRemodel_v21_Normal_{WEB_DETAIL_RESOLUTION}",
        generated_dir,
        WEB_DETAIL_RESOLUTION,
    )
    orm = build_v21_orm(role, generated_dir)
    return base, normal, orm


def apply_role_materials(
    role: str,
    cache_dir: Path,
    generated_dir: Path,
    no_download: bool,
) -> dict[str, Any]:
    missing = [name for name in ROLE_MAIN_MATERIALS[role] if bpy.data.materials.get(name) is None]
    if missing:
        raise RuntimeError(f"Missing approved primary materials: {missing}")

    if role in ("kid", "villain"):
        base, normal, orm = role_v21_images(role, generated_dir)
        material = bpy.data.materials[ROLE_MAIN_MATERIALS[role][0]]
        configure_export_safe_pbr(material, base, normal, orm, normal_strength=0.48)
        return {
            material.name: {
                "baseColor": base.name,
                "normal": normal.name,
                "orm": orm.name,
                "uvCompatibility": "exact v21 rigged main-body UV; runtime mesh is the same approved v21 mesh",
            }
        }

    skin_path = fetch_verified(MAKEHUMAN_SKIN, cache_dir, no_download)
    suit_normal_path = fetch_verified(MAKEHUMAN_SUIT_NORMAL, cache_dir, no_download)
    skin_base = load_image(skin_path, "sRGB", "Police_v22_MakeHuman_Skin_BaseColor_2K")
    skin_normal = generated_micro_normal(
        f"Police_v22_Skin_MicroNormal_{WEB_DETAIL_RESOLUTION}",
        generated_dir,
        WEB_DETAIL_RESOLUTION,
        0.17,
        0.24,
    )
    skin_orm = generated_orm(
        f"Police_v22_Skin_ORM_{WEB_DETAIL_RESOLUTION}",
        generated_dir,
        WEB_DETAIL_RESOLUTION,
        0.17,
        0.965,
        0.62,
        0.0,
    )
    configure_export_safe_pbr(
        bpy.data.materials["M_Police_v22_SkinUV"],
        skin_base,
        skin_normal,
        skin_orm,
        normal_strength=0.32,
    )

    suit_normal = resized_image(
        suit_normal_path,
        "Non-Color",
        "Police_v22_CasualSuit_Normal_1K",
        generated_dir,
        1024,
    )
    uniform_orm = generated_orm(
        f"Police_v22_Uniform_ORM_{WEB_DETAIL_RESOLUTION}",
        generated_dir,
        WEB_DETAIL_RESOLUTION,
        0.41,
        0.945,
        0.67,
        0.0,
    )
    mapping: dict[str, Any] = {
        "M_Police_v22_SkinUV": {
            "baseColor": skin_base.name,
            "normal": skin_normal.name,
            "orm": skin_orm.name,
            "uvCompatibility": "exact canonical MakeHuman body UV used by Police_v22_Body",
        }
    }
    for index, name in enumerate(("M_Police_v22_UniformNavy", "M_Police_v22_TrouserNavy")):
        material = bpy.data.materials[name]
        principled = material.node_tree.nodes.get("Principled BSDF")
        source_color = tuple(float(v) for v in principled.inputs["Base Color"].default_value[:3])
        base = generated_fabric_base(
            f"Police_v22_{'Uniform' if index == 0 else 'Trouser'}_BaseColor_{WEB_DETAIL_RESOLUTION}",
            generated_dir,
            source_color,
            WEB_DETAIL_RESOLUTION,
            0.41 + index * 0.11,
        )
        configure_export_safe_pbr(material, base, suit_normal, uniform_orm, normal_strength=0.58)
        mapping[name] = {
            "baseColor": base.name,
            "normal": suit_normal.name,
            "orm": uniform_orm.name,
            "uvCompatibility": "exact MakeHuman male_casualsuit03 normal UV retained by Police_v22_Uniform",
        }
    return mapping


def character_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points: list[Vector] = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        points.extend(evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box)
    return (
        Vector(tuple(min(point[i] for point in points) for i in range(3))),
        Vector(tuple(max(point[i] for point in points) for i in range(3))),
    )


def point_at(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def review_material(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Roughness"].default_value = roughness
    return material


def setup_review_studio(meshes: list[bpy.types.Object], role: str) -> list[bpy.types.Object]:
    minimum, maximum = character_bounds(meshes)
    center = (minimum + maximum) * 0.5
    height = maximum.z - minimum.z
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"

    world = scene.world or bpy.data.worlds.new("PBR_QA_World")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.014, 0.022, 0.042, 1.0)
    background.inputs["Strength"].default_value = 0.24

    created: list[bpy.types.Object] = []
    bpy.ops.mesh.primitive_plane_add(size=height * 4.5, location=(center.x, center.y, minimum.z - 0.006))
    floor = bpy.context.object
    floor.name = "PBR_QA_Floor"
    floor.data.materials.append(review_material("PBR_QA_FloorMat", (0.045, 0.055, 0.075, 1.0), 0.7))
    created.append(floor)

    camera_data = bpy.data.cameras.new("PBR_QA_Camera")
    camera = bpy.data.objects.new("PBR_QA_Camera", camera_data)
    scene.collection.objects.link(camera)
    camera.data.lens = 62
    camera.location = center + Vector((height * 0.92, -height * 2.8, height * 0.25))
    point_at(camera, Vector((center.x, center.y, minimum.z + height * 0.52)))
    scene.camera = camera
    created.append(camera)

    lights = (
        ("Key", (-1.45, -1.8, 2.1), 1050.0, (0.82, 0.91, 1.0), 1.8),
        ("Fill", (1.7, -0.55, 1.15), 520.0, (1.0, 0.62, 0.34), 1.45),
        ("Rim", (-0.45, 1.55, 1.72), 1350.0, (0.28, 0.48, 1.0), 1.25),
    )
    for label, offset, energy, color, size in lights:
        data = bpy.data.lights.new(f"PBR_QA_{label}", "AREA")
        data.energy = energy
        data.color = color
        data.shape = "DISK"
        data.size = height * size
        light = bpy.data.objects.new(f"PBR_QA_{label}", data)
        scene.collection.objects.link(light)
        light.location = center + Vector(tuple(component * height for component in offset))
        point_at(light, Vector((center.x, center.y, minimum.z + height * 0.55)))
        created.append(light)
    return created


def render_review(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path.resolve())
    bpy.ops.render.render(write_still=True)
    print(f"Rendered {path}")


def remove_review_objects(objects: list[bpy.types.Object]) -> None:
    for obj in objects:
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def select_character(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    armature.hide_set(False)
    armature.select_set(True)
    for mesh in meshes:
        mesh.hide_set(False)
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature


def export_character(path: Path, armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    select_character(armature, meshes)
    bpy.ops.export_scene.gltf(
        filepath=str(path.resolve()),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_skins=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_merge_animation="ACTION",
        export_force_sampling=True,
        export_frame_step=1,
        export_optimize_animation_size=False,
        export_materials="EXPORT",
        # Re-encode from the live Blender image buffers.  keep_originals=True
        # turns packed/generated images into 1x1 placeholders in Blender 5.1.
        export_image_format="AUTO",
        export_keep_originals=False,
        export_texcoords=True,
        export_normals=True,
        # Blender can emit zero-length tangents at UV-degenerate seam vertices
        # during a GLB round-trip (Khronos Validator: ACCESSOR_VECTOR3_NON_UNIT).
        # Three.js derives the tangent frame from derivatives when this
        # optional attribute is absent, so omitting it keeps tangent-space
        # normal maps valid and avoids shipping malformed data.
        export_tangents=False,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
    )


def read_glb(path: Path) -> tuple[dict[str, Any], bytes, int]:
    payload = path.read_bytes()
    if payload[:4] != b"glTF":
        raise RuntimeError(f"Not a binary glTF: {path}")
    json_length, json_type = struct.unpack_from("<II", payload, 12)
    if json_type != 0x4E4F534A:
        raise RuntimeError(f"First GLB chunk is not JSON: {path}")
    document = json.loads(payload[20 : 20 + json_length].decode("utf-8").rstrip("\0 \t\r\n"))
    binary_header = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<II", payload, binary_header)
    if binary_type != 0x004E4942:
        raise RuntimeError(f"Second GLB chunk is not BIN: {path}")
    binary_start = binary_header + 8
    if binary_start + binary_length > len(payload):
        raise RuntimeError(f"Truncated GLB BIN chunk: {path}")
    return document, payload, binary_start


def embedded_image_evidence(
    document: dict[str, Any], payload: bytes, binary_start: int, texture_index: int
) -> dict[str, Any]:
    texture = document["textures"][texture_index]
    image = document["images"][texture["source"]]
    view = document["bufferViews"][image["bufferView"]]
    start = binary_start + int(view.get("byteOffset", 0))
    length = int(view["byteLength"])
    data = payload[start : start + length]
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise RuntimeError(f"Expected embedded PNG for texture {texture_index}, got {image.get('mimeType')}")
    width, height = struct.unpack_from(">II", data, 16)
    if width < 512 or height < 512 or length < 10_000:
        raise RuntimeError(
            f"Embedded texture {texture_index} is a placeholder: {width}x{height}, {length} bytes"
        )
    return {
        "name": image.get("name"),
        "mimeType": image.get("mimeType"),
        "width": width,
        "height": height,
        "bytes": length,
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def glb_validation(path: Path, role: str, expected_animations: dict[str, Any]) -> dict[str, Any]:
    document, payload, binary_start = read_glb(path)
    materials = {material.get("name", ""): material for material in document.get("materials", [])}
    material_checks: dict[str, Any] = {}
    for name in ROLE_MAIN_MATERIALS[role]:
        material = materials.get(name)
        if material is None:
            raise RuntimeError(f"Exported GLB is missing target material {name}")
        pbr = material.get("pbrMetallicRoughness", {})
        slots = {
            "baseColorTexture": pbr.get("baseColorTexture", {}).get("index"),
            "normalTexture": material.get("normalTexture", {}).get("index"),
            "occlusionTexture": material.get("occlusionTexture", {}).get("index"),
            "metallicRoughnessTexture": pbr.get("metallicRoughnessTexture", {}).get("index"),
        }
        if any(index is None for index in slots.values()):
            raise RuntimeError(f"Incomplete exported PBR bindings for {name}: {slots}")
        material_checks[name] = {
            slot: embedded_image_evidence(document, payload, binary_start, int(index))
            for slot, index in slots.items()
        }
    exported_animations = sorted(animation.get("name", "") for animation in document.get("animations", []))
    if exported_animations != sorted(expected_animations):
        raise RuntimeError(
            f"Animation names changed during PBR post-process: before={sorted(expected_animations)} after={exported_animations}"
        )
    return {
        "bytes": path.stat().st_size,
        "meshes": len(document.get("meshes", [])),
        "materials": len(document.get("materials", [])),
        "textures": len(document.get("textures", [])),
        "images": len(document.get("images", [])),
        "animations": exported_animations,
        "targetMaterialPbrBindings": material_checks,
    }


def main() -> None:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    output_path = args.output.expanduser().resolve()
    if input_path == output_path:
        raise RuntimeError("Refusing in-place overwrite; validate a separate candidate output first")
    report_path = (args.report or output_path.with_suffix(".pbr-report.json")).expanduser().resolve()
    generated_dir = output_path.parent / f"{output_path.stem}-pbr-source"

    clear_scene()
    armature, meshes = import_character(input_path)
    activate_idle_review_pose(armature)
    before_materials = {material.name: material_snapshot(material) for material in bpy.data.materials}
    before_meshes = mesh_snapshot(meshes)
    before_animations = animation_snapshot()
    uv_evidence = target_uv_evidence(args.role, meshes)
    accessory_before = {
        name: snapshot
        for name, snapshot in before_materials.items()
        if name not in ROLE_MAIN_MATERIALS[args.role]
    }

    if args.review_dir:
        review_dir = args.review_dir.expanduser().resolve()
        studio = setup_review_studio(meshes, args.role)
        render_review(review_dir / f"{args.role}_before_factor_only.png")
        remove_review_objects(studio)

    applied = apply_role_materials(
        args.role,
        args.cache_dir.expanduser().resolve(),
        generated_dir,
        args.no_download,
    )

    if args.review_dir:
        studio = setup_review_studio(meshes, args.role)
        render_review(review_dir / f"{args.role}_after_pbr.png")
        remove_review_objects(studio)

    accessory_after = {
        material.name: material_snapshot(material)
        for material in bpy.data.materials
        if material.name not in ROLE_MAIN_MATERIALS[args.role]
        and not material.name.startswith("PBR_QA_")
    }
    if accessory_after != accessory_before:
        raise RuntimeError("Non-target accessory material parameters changed during PBR authoring")

    export_character(output_path, armature, meshes)
    exported = glb_validation(output_path, args.role, before_animations)
    after_meshes = mesh_snapshot(meshes)
    if after_meshes != before_meshes:
        raise RuntimeError("Mesh topology or material assignments changed during PBR post-process")

    report = {
        "role": args.role,
        "input": str(input_path),
        "inputBytes": input_path.stat().st_size,
        "output": str(output_path),
        "sourceUvEvidence": uv_evidence,
        "appliedMaterials": applied,
        "unchangedAccessoryMaterialCount": len(accessory_before),
        "meshTopologyUnchanged": True,
        "animationSetUnchanged": True,
        "exportedGlb": exported,
        "qualityGates": {
            "everyPrimaryMaterialHasBaseColorNormalOrm": True,
            "accessoryMaterialsUntouched": True,
            "primaryMeshesHaveUVs": True,
            "noGeometryGenerated": True,
            "inputNotOverwritten": True,
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
