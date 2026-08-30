#!/usr/bin/env python3
"""Build the Police A2 visual rework from the remote-trunk v22 rigged master.

Run with Blender::

    blender --background --factory-startup \
      --python tools/art_pipeline/build_a2_police_visual_rework.py

The pass is intentionally source-level and deterministic.  It keeps the v22
MakeHuman/MPFB-derived topology and UVs, repairs the audited lateral skinning
semantics, bakes the armature object's legacy scale into the rest skeleton,
and improves only gameplay-camera readability:

* seven-percent broader upper-body/shoulder silhouette;
* larger service-cap crown and brim;
* materially larger cap badge, chest badge, nameplate, and belt buckle;
* stronger navy / black / blue / metallic material zoning;
* rigid accessories joined only when both material and bone binding match.

The generated authoring GLB is deliberately animation-free.  The repository's
``build_web_character_animation_sets.py`` remains the single owner of the five
authoritative Police gameplay clips (Idle, Run, Alert, Interact, Resolve).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import repair_police_v22_skinning as skin_repair  # noqa: E402


SOURCE_ROOT = (
    ROOT
    / "art-source/Characters/Police/ReferenceStandard/HumanAnatomyRemodel_2026_07_14_v22"
)
SOURCE_BLEND = SOURCE_ROOT / "Rigged/Police_HumanAnatomyRemodel_v22_Rigged.blend"
A2_ROOT = (
    ROOT
    / "art-source/Characters/Police/ReferenceStandard/A2_VisualRework_2026_08_29"
)
DEFAULT_STATIC_BLEND = A2_ROOT / "Police_A2_VisualRework_v23.blend"
DEFAULT_RIGGED_BLEND = A2_ROOT / "Rigged/Police_A2_VisualRework_v23_Rigged.blend"
DEFAULT_AUTHORING_GLB = (
    Path(tempfile.gettempdir()) / "Police_A2_VisualRework_v23_Rigged_Static.glb"
)
DEFAULT_REPORT = A2_ROOT / "Reports/Police_A2_visual_rework_generated_report.json"
DEFAULT_EVIDENCE_DIR = A2_ROOT / "Reports/evidence"

ARMATURE_NAME = "Rig_Humanoid_Shared"
PRIMARY_DEFORMING_MESHES = {
    "Police_v22_Body",
    "Police_v22_Uniform",
    "Police_v22_Shoes",
    "Police_v22_Hair",
    "Police_v22_Eyebrows",
    "Police_v22_Eyelashes",
    "Police_v22_HighPolyEyes",
}
EXPECTED_BONES = {
    "Hips",
    "Spine",
    "Chest",
    "Neck",
    "Head",
    "LeftShoulder",
    "LeftUpperArm",
    "LeftLowerArm",
    "LeftHand",
    "RightShoulder",
    "RightUpperArm",
    "RightLowerArm",
    "RightHand",
    "LeftUpperLeg",
    "LeftLowerLeg",
    "LeftFoot",
    "LeftToes",
    "RightUpperLeg",
    "RightLowerLeg",
    "RightFoot",
    "RightToes",
}
UPPER_BODY_WEIGHTS = {
    "Spine",
    "Chest",
    "LeftShoulder",
    "LeftUpperArm",
    "LeftLowerArm",
    "LeftHand",
    "RightShoulder",
    "RightUpperArm",
    "RightLowerArm",
    "RightHand",
}
UPPER_BODY_BONES = {
    "LeftShoulder",
    "LeftUpperArm",
    "LeftLowerArm",
    "LeftHand",
    "RightShoulder",
    "RightUpperArm",
    "RightLowerArm",
    "RightHand",
}
AUTHORITATIVE_CLIPS = ("Idle", "Run", "Alert", "Interact", "Resolve")

# All visual values are fixed inputs rather than artistic randomness.  They sit
# inside the approved A2 ranges and are recorded verbatim in the generated QA
# report so a later rebuild can be compared mechanically.
UPPER_BODY_WIDTH = 1.07
CAP_CROWN_SCALE = (1.12, 1.12, 1.04)
CAP_HEADBAND_SCALE = (1.12, 1.12, 1.08)
CAP_BRIM_SCALE = (1.14, 1.14, 1.18)
CAP_BADGE_SCALE = (1.90, 1.25, 1.90)
CHEST_BADGE_SCALE = (1.30, 1.25, 1.30)
NAMEPLATE_SCALE = (1.60, 1.25, 1.50)
BELT_BUCKLE_SCALE = (1.80, 1.25, 1.80)
PATCH_SCALE = (1.18, 1.18, 1.18)
EPAULET_SCALE = (1.12, 1.08, 1.10)
EPAULET_BUTTON_SCALE = (1.30, 1.20, 1.30)
SHIRT_BUTTON_SCALE = (1.20, 1.16, 1.20)

SCALE_BY_OBJECT = {
    "Police_v22_ServiceCapCrown": CAP_CROWN_SCALE,
    "Police_v22_ServiceCapHeadband": CAP_HEADBAND_SCALE,
    "Police_v22_ServiceCapBrim": CAP_BRIM_SCALE,
    "Police_v22_CapBadge": CAP_BADGE_SCALE,
    "Police_v22_ChestBadge": CHEST_BADGE_SCALE,
    "Police_v22_Nameplate": NAMEPLATE_SCALE,
    "Police_v22_BeltBuckle": BELT_BUCKLE_SCALE,
    "Police_v22_SleevePatch_-1": PATCH_SCALE,
    "Police_v22_SleevePatch_+1": PATCH_SCALE,
    "Police_v22_SleevePatchInset_-1": PATCH_SCALE,
    "Police_v22_SleevePatchInset_+1": PATCH_SCALE,
    "Police_v22_ShoulderEpaulet_-1": EPAULET_SCALE,
    "Police_v22_ShoulderEpaulet_+1": EPAULET_SCALE,
    "Police_v22_EpauletButton_-1": EPAULET_BUTTON_SCALE,
    "Police_v22_EpauletButton_+1": EPAULET_BUTTON_SCALE,
    **{
        f"Police_v22_ShirtButton_{index:02d}": SHIRT_BUTTON_SCALE
        for index in range(6)
    },
}

SHOULDER_DETAIL_TOKENS = (
    "ShoulderEpaulet",
    "EpauletButton",
    "SleevePatch",
    "ShoulderRadio",
)
CHEST_DETAIL_TOKENS = (
    "ChestPocket",
    "ChestBadge",
    "Nameplate",
)

MATERIAL_PROFILES: dict[str, dict[str, Any]] = {
    "M_Police_v22_UniformNavy": {
        "baseColor": (0.012, 0.052, 0.140, 1.0),
        "metallic": 0.0,
        "roughness": 0.64,
        "read": "clean saturated navy shirt block",
    },
    "M_Police_v22_TrouserNavy": {
        "baseColor": (0.006, 0.018, 0.048, 1.0),
        "metallic": 0.0,
        "roughness": 0.79,
        "read": "darker matte trouser block",
    },
    "M_Police_v22_ServiceCap": {
        # Linear-light deep navy.  The cap has no base-color texture, so the
        # factor must survive the bright formal review key without drifting to
        # powder blue at the top-facing crown.
        "baseColor": (0.006, 0.025, 0.090, 1.0),
        "metallic": 0.0,
        "roughness": 0.68,
        # The v22 material carried a white Principled sheen and a relatively
        # strong dielectric lobe.  Those hidden channels exported as
        # KHR_materials_sheen/specular and washed the crown almost white under
        # the formal PBR review key light even though the base factor was navy.
        # Pin them explicitly so rebuilding on another Blender version cannot
        # silently reintroduce the hotspot.
        "specularIorLevel": 0.08,
        "sheenWeight": 0.0,
        "read": "structured deep-navy cap crown without a near-white hotspot",
    },
    "M_Police_v22_CapBand": {
        "baseColor": (0.003, 0.006, 0.015, 1.0),
        "metallic": 0.0,
        "roughness": 0.38,
        "read": "near-black cap band and uniform trim",
    },
    "M_Police_v22_PatchBlue": {
        "baseColor": (0.018, 0.150, 0.420, 1.0),
        "metallic": 0.0,
        "roughness": 0.56,
        "read": "high-separation sleeve patch blue",
    },
    "M_Police_v22_InsigniaGold": {
        "baseColor": (0.780, 0.430, 0.070, 1.0),
        "metallic": 0.85,
        "roughness": 0.22,
        "read": "bright warm badge metal",
    },
    "M_Police_v22_BrushedSilver": {
        "baseColor": (0.580, 0.680, 0.800, 1.0),
        "metallic": 0.88,
        "roughness": 0.18,
        "read": "cool bright hardware metal",
    },
    "M_Police_v22_DutyLeather": {
        "baseColor": (0.005, 0.007, 0.012, 1.0),
        "metallic": 0.0,
        "roughness": 0.34,
        "read": "dark duty-belt leather",
    },
    "M_Police_v22_PolishedLeather": {
        "baseColor": (0.006, 0.008, 0.012, 1.0),
        "metallic": 0.0,
        "roughness": 0.23,
        "read": "polished shoe leather",
    },
}

MAKEHUMAN_IMAGE_PATHS = {
    "male_casualsuit03_normal.png": ROOT / "tools/third_party/makehuman-assets/base/clothes/male_casualsuit03/male_casualsuit03_normal.png",
    "young_lightskinned_male_diffuse2.png": ROOT / "tools/third_party/makehuman-assets/base/skins/textures/young_lightskinned_male_diffuse2.png",
}
OMITTED_RUNTIME_MICROTEXTURES = {
    "brown_eye.png": ROOT / "tools/third_party/makehuman-assets/base/eyes/materials/brown_eye.png",
    "eyebrow001.png": ROOT / "tools/third_party/makehuman-assets/base/eyebrows/eyebrow001/eyebrow001.png",
    "eyelashes01.png": ROOT / "tools/third_party/makehuman-assets/base/eyelashes/eyelashes01/eyelashes01.png",
    "short01_diffuse.png": ROOT / "tools/third_party/makehuman-assets/base/hair/short01/short01_diffuse.png",
}
SKIN_TONE_PROFILE = {
    "textureContribution": 0.92,
    "hue": 0.5,
    "saturation": 0.72,
    "value": 0.95,
    "warmUnderpaintLinear": (0.330, 0.165, 0.085, 1.0),
    "roughness": 0.59,
}
CAMERA_SCALE_FACE_PROFILES = {
    "M_Police_v22_HairUV": {
        "baseColor": (0.010, 0.0045, 0.0025, 1.0),
        "roughness": 0.48,
        "read": "dark brown hair mass",
    },
    "M_Police_v22_BrowsUV": {
        "baseColor": (0.018, 0.007, 0.0035, 1.0),
        "roughness": 0.58,
        "read": "dark brow line",
    },
    "M_Police_v22_LashesUV": {
        "baseColor": (0.004, 0.0015, 0.001, 1.0),
        "roughness": 0.52,
        "read": "near-black lash line",
    },
    "M_Police_v22_HighPolyEyeUV": {
        "baseColor": (0.022, 0.010, 0.004, 1.0),
        "roughness": 0.24,
        "read": "dark eye focal point at 34-68 px gameplay height",
    },
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE_BLEND)
    parser.add_argument("--output-rigged", type=Path, default=DEFAULT_RIGGED_BLEND)
    parser.add_argument("--output-static", type=Path, default=DEFAULT_STATIC_BLEND)
    parser.add_argument("--output-glb", type=Path, default=DEFAULT_AUTHORING_GLB)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--evidence-dir", type=Path, default=DEFAULT_EVIDENCE_DIR)
    parser.add_argument("--skip-preview", action="store_true")
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def display_path(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return resolved.name


def character_meshes(armature: bpy.types.Object) -> list[bpy.types.Object]:
    return sorted(
        [
            obj
            for obj in bpy.context.scene.objects
            if obj.type == "MESH"
            and (
                obj.parent == armature
                or any(
                    modifier.type == "ARMATURE" and modifier.object == armature
                    for modifier in obj.modifiers
                )
            )
        ],
        key=lambda obj: obj.name,
    )


def material_snapshot() -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in MATERIAL_PROFILES:
        material = bpy.data.materials.get(name)
        if material is None:
            raise RuntimeError(f"Missing Police material {name}")
        principled = (
            material.node_tree.nodes.get("Principled BSDF")
            if material.use_nodes and material.node_tree
            else None
        )
        if principled is None:
            raise RuntimeError(f"Police material has no Principled BSDF: {name}")
        result[name] = {
            "baseColor": [
                round(float(value), 6)
                for value in principled.inputs["Base Color"].default_value
            ],
            "metallic": round(float(principled.inputs["Metallic"].default_value), 6),
            "roughness": round(float(principled.inputs["Roughness"].default_value), 6),
            "specularIorLevel": round(
                float(principled.inputs["Specular IOR Level"].default_value), 6
            ),
            "sheenWeight": round(
                float(principled.inputs["Sheen Weight"].default_value), 6
            ),
        }
    return result


def relink_and_pack_makehuman_images() -> dict[str, Any]:
    """Resolve stale v22 relative paths to the same audited local CC0 bytes."""
    result: dict[str, Any] = {}
    for canonical_name, path in MAKEHUMAN_IMAGE_PATHS.items():
        if not path.is_file():
            raise FileNotFoundError(path)
        matches = [
            image
            for image in bpy.data.images
            if image.name == canonical_name or image.name.startswith(f"{canonical_name}.")
        ]
        if not matches:
            raise RuntimeError(f"Police source does not reference {canonical_name}")
        for image in matches:
            image.source = "FILE"
            image.filepath = str(path.resolve())
            image.reload()
            if int(image.size[0]) <= 0 or int(image.size[1]) <= 0:
                raise RuntimeError(f"Failed to resolve Police texture {path}")
            image.pack()
        result[canonical_name] = {
            "source": display_path(path),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "dimensions": [int(matches[0].size[0]), int(matches[0].size[1])],
            "packedCopies": len(matches),
            "uvOrPixelsChanged": False,
        }
    return result


def configure_camera_scale_face_accessories() -> dict[str, Any]:
    """Remove sub-pixel face textures while retaining a stable readable face.

    The shipped Police bootstrap has a strict seven-texture contract owned by
    skin and uniform PBR.  Four additional hair/brow/lash/eye images are not
    resolvable at the formal 34-68 px actor height, but cost several MiB and
    make the bootstrap contract impossible.  Deterministic semantic colors
    preserve those features as dark focal masses without touching body UVs.
    """
    result: dict[str, Any] = {}
    for name, profile in CAMERA_SCALE_FACE_PROFILES.items():
        material = bpy.data.materials.get(name)
        if material is None or not material.use_nodes or material.node_tree is None:
            raise RuntimeError(f"Missing node-based Police face accessory material {name}")
        nodes = material.node_tree.nodes
        links = material.node_tree.links
        principled = nodes.get("Principled BSDF")
        if principled is None:
            raise RuntimeError(f"Missing Principled BSDF on {name}")
        removed_images = [
            node.image.name
            for node in nodes
            if node.type == "TEX_IMAGE" and node.image is not None
        ]
        for socket_name in ("Base Color", "Alpha"):
            socket = principled.inputs.get(socket_name)
            if socket is not None:
                for link in list(socket.links):
                    links.remove(link)
        for node in list(nodes):
            if node.type == "TEX_IMAGE":
                nodes.remove(node)
        principled.inputs["Base Color"].default_value = profile["baseColor"]
        principled.inputs["Metallic"].default_value = 0.0
        principled.inputs["Roughness"].default_value = profile["roughness"]
        if principled.inputs.get("Alpha") is not None:
            principled.inputs["Alpha"].default_value = 1.0
        material.diffuse_color = profile["baseColor"]
        material.use_backface_culling = False
        result[name] = {
            **profile,
            "removedImageNodes": removed_images,
            "reason": "sub-pixel at formal game camera; preserves the seven-texture runtime contract",
        }
    for image in list(bpy.data.images):
        if image.users == 0 and any(
            token in image.name
            for token in ("brown_eye", "eyebrow001", "eyelashes01", "short01_diffuse")
        ):
            bpy.data.images.remove(image)
    return result


def omitted_microtexture_provenance() -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, path in OMITTED_RUNTIME_MICROTEXTURES.items():
        if not path.is_file():
            raise FileNotFoundError(path)
        result[name] = {
            "source": display_path(path),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
            "license": "MakeHuman core assets CC0",
            "runtimeBinding": False,
            "reason": "sub-pixel at formal 34-68 px actor height; replaced by the recorded semantic PBR factor",
        }
    return result


def skin_tone_snapshot() -> dict[str, Any]:
    material = bpy.data.materials.get("M_Police_v22_SkinUV")
    if material is None or not material.use_nodes or material.node_tree is None:
        raise RuntimeError("Missing node-based M_Police_v22_SkinUV")
    nodes = material.node_tree.nodes
    principled = nodes.get("Principled BSDF")
    hue = nodes.get("Hue/Saturation/Value")
    mix = nodes.get("Mix (Legacy)")
    if principled is None or hue is None or mix is None:
        raise RuntimeError("Police SkinUV color-management nodes changed")
    return {
        "hue": round(float(hue.inputs["Hue"].default_value), 6),
        "saturation": round(float(hue.inputs["Saturation"].default_value), 6),
        "value": round(float(hue.inputs["Value"].default_value), 6),
        "textureContribution": round(float(mix.inputs["Factor"].default_value), 6),
        "warmUnderpaintLinear": [
            round(float(value), 6) for value in mix.inputs["Color1"].default_value
        ],
        "roughness": round(float(principled.inputs["Roughness"].default_value), 6),
    }


def apply_skin_tone_management() -> dict[str, Any]:
    before = skin_tone_snapshot()
    material = bpy.data.materials["M_Police_v22_SkinUV"]
    nodes = material.node_tree.nodes
    hue = nodes["Hue/Saturation/Value"]
    mix = nodes["Mix (Legacy)"]
    principled = nodes["Principled BSDF"]
    hue.inputs["Hue"].default_value = SKIN_TONE_PROFILE["hue"]
    hue.inputs["Saturation"].default_value = SKIN_TONE_PROFILE["saturation"]
    hue.inputs["Value"].default_value = SKIN_TONE_PROFILE["value"]
    mix.inputs["Factor"].default_value = SKIN_TONE_PROFILE["textureContribution"]
    mix.inputs["Color1"].default_value = SKIN_TONE_PROFILE["warmUnderpaintLinear"]
    principled.inputs["Roughness"].default_value = SKIN_TONE_PROFILE["roughness"]
    material.diffuse_color = (0.52, 0.30, 0.20, 1.0)
    return {
        "before": before,
        "after": skin_tone_snapshot(),
        "policy": {
            **SKIN_TONE_PROFILE,
            "projection": "existing canonical MakeHuman UV0 unchanged",
            "texturePixels": "unchanged; same SHA-pinned local CC0 source",
        },
    }


def apply_material_profiles() -> dict[str, Any]:
    before = material_snapshot()
    for name, profile in MATERIAL_PROFILES.items():
        material = bpy.data.materials[name]
        principled = material.node_tree.nodes["Principled BSDF"]
        color = profile["baseColor"]
        principled.inputs["Base Color"].default_value = color
        principled.inputs["Metallic"].default_value = profile["metallic"]
        principled.inputs["Roughness"].default_value = profile["roughness"]
        if "specularIorLevel" in profile:
            principled.inputs["Specular IOR Level"].default_value = profile[
                "specularIorLevel"
            ]
        if "sheenWeight" in profile:
            principled.inputs["Sheen Weight"].default_value = profile["sheenWeight"]
        material.diffuse_color = color
    return {
        "before": before,
        "after": material_snapshot(),
        "profiles": MATERIAL_PROFILES,
    }


def evaluated_triangles(obj: bpy.types.Object) -> int:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        return sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.polygons)
    finally:
        evaluated.to_mesh_clear()


def mesh_snapshot(meshes: list[bpy.types.Object]) -> dict[str, Any]:
    return {
        obj.name: {
            "vertices": len(obj.data.vertices),
            "baseTriangles": sum(
                max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons
            ),
            "evaluatedTriangles": evaluated_triangles(obj),
            "materials": [material.name if material else None for material in obj.data.materials],
            "modifiers": [modifier.type for modifier in obj.modifiers],
        }
        for obj in meshes
    }


def hierarchy_snapshot(armature: bpy.types.Object) -> dict[str, str | None]:
    return {
        bone.name: bone.parent.name if bone.parent else None
        for bone in armature.data.bones
    }


def weight_snapshot(meshes: list[bpy.types.Object]) -> dict[str, Any]:
    zero = 0
    vertices = 0
    maximum_influences = 0
    maximum_sum_error = 0.0
    nonzero_by_bone = {name: 0 for name in EXPECTED_BONES}
    invalid_groups: set[str] = set()
    per_mesh: dict[str, Any] = {}
    for obj in meshes:
        mesh_zero = 0
        mesh_max = 0
        for vertex in obj.data.vertices:
            influences = [item for item in vertex.groups if item.weight > 1e-8]
            vertices += 1
            if not influences:
                zero += 1
                mesh_zero += 1
            mesh_max = max(mesh_max, len(influences))
            maximum_influences = max(maximum_influences, len(influences))
            maximum_sum_error = max(
                maximum_sum_error,
                abs(sum(item.weight for item in influences) - 1.0),
            )
            for item in influences:
                name = obj.vertex_groups[item.group].name
                if name in nonzero_by_bone:
                    nonzero_by_bone[name] += 1
                else:
                    invalid_groups.add(name)
        per_mesh[obj.name] = {
            "vertices": len(obj.data.vertices),
            "zeroWeightVertices": mesh_zero,
            "maxInfluences": mesh_max,
        }
    return {
        "vertices": vertices,
        "zeroWeightVertices": zero,
        "zeroWeightRatio": round(zero / max(vertices, 1), 9),
        "maxInfluences": maximum_influences,
        "maxWeightSumError": round(maximum_sum_error, 9),
        "leftHandNonzeroVertices": nonzero_by_bone["LeftHand"],
        "rightHandNonzeroVertices": nonzero_by_bone["RightHand"],
        "invalidWeightedGroups": sorted(invalid_groups),
        "perMesh": per_mesh,
    }


def normalize_limit_weights(meshes: list[bpy.types.Object]) -> dict[str, int]:
    truncated_vertices = 0
    normalized_vertices = 0
    for obj in meshes:
        for vertex in obj.data.vertices:
            influences = sorted(
                [item for item in vertex.groups if item.weight > 1e-8],
                key=lambda item: item.weight,
                reverse=True,
            )
            if not influences:
                raise RuntimeError(f"Zero-weight vertex before normalization: {obj.name}:{vertex.index}")
            if len(influences) > 4:
                truncated_vertices += 1
                for item in influences[4:]:
                    obj.vertex_groups[item.group].remove([vertex.index])
                influences = influences[:4]
            total = sum(item.weight for item in influences)
            if abs(total - 1.0) > 1e-7:
                normalized_vertices += 1
                for item in influences:
                    obj.vertex_groups[item.group].add(
                        [vertex.index], item.weight / total, "REPLACE"
                    )
    return {
        "verticesTruncatedToFourInfluences": truncated_vertices,
        "verticesRenormalized": normalized_vertices,
    }


def render_preview(path: Path, label: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    for obj in list(bpy.data.objects):
        if obj.get("police_a2_preview"):
            bpy.data.objects.remove(obj, do_unlink=True)

    world = bpy.context.scene.world or bpy.data.worlds.new("Police_A2_PreviewWorld")
    bpy.context.scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.025, 0.032, 0.045, 1.0)
    background.inputs["Strength"].default_value = 0.24

    def add_area(
        name: str,
        location: tuple[float, float, float],
        energy: float,
        size: float,
        color: tuple[float, float, float],
    ) -> None:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj["police_a2_preview"] = True
        obj.location = location
        obj.rotation_euler = (Vector((0.0, -0.02, 0.96)) - obj.location).to_track_quat("-Z", "Y").to_euler()

    add_area("Police_A2_Key", (-2.5, -3.8, 4.2), 760.0, 3.2, (0.88, 0.94, 1.0))
    add_area("Police_A2_Fill", (3.5, -1.6, 2.6), 320.0, 4.4, (1.0, 0.88, 0.72))
    add_area("Police_A2_Rim", (0.0, 3.5, 3.6), 540.0, 3.0, (0.55, 0.68, 1.0))

    camera_data = bpy.data.cameras.new("Police_A2_GameCamera")
    camera = bpy.data.objects.new("Police_A2_GameCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera["police_a2_preview"] = True
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = 2.18
    camera.location = (3.55, -5.60, 4.95)
    camera.rotation_euler = (
        Vector((0.0, -0.02, 0.90)) - camera.location
    ).to_track_quat("-Z", "Y").to_euler()

    scene = bpy.context.scene
    scene.camera = camera
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.render.filepath = str(path.resolve())
    bpy.context.view_layer.update()
    bpy.ops.render.render(write_still=True)
    print(f"Rendered {label}: {path}")
    return display_path(path)


def remove_preview_objects() -> None:
    for obj in list(bpy.data.objects):
        if obj.get("police_a2_preview"):
            bpy.data.objects.remove(obj, do_unlink=True)


def repair_skinning(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> dict[str, Any]:
    before = skin_repair.bone_side_evidence(armature)
    skin_repair.swap_lateral_semantics(armature, meshes)
    after = skin_repair.bone_side_evidence(armature)
    if not all(
        after[left] < 0.0 < after[right]
        for left, right in skin_repair.LATERAL_BONE_PAIRS
    ):
        raise RuntimeError(f"Police lateral semantic repair failed: {after}")

    attachment_before = {
        name: skin_repair.binding_snapshot(bpy.data.objects[name])
        for name in skin_repair.ATTACHMENT_BINDINGS
    }
    for name, bone in skin_repair.ATTACHMENT_BINDINGS.items():
        skin_repair.rigid_rebind(bpy.data.objects[name], bone)
    attachment_after = {
        name: skin_repair.binding_snapshot(bpy.data.objects[name])
        for name in skin_repair.ATTACHMENT_BINDINGS
    }
    uniform = bpy.data.objects.get("Police_v22_Uniform")
    if uniform is None:
        raise RuntimeError("Missing Police_v22_Uniform")
    crotch = skin_repair.stabilize_uniform_crotch(
        uniform,
        max_abs_x=0.04,
        min_z=0.72,
        full_z=0.76,
        top_full_z=0.85,
        max_z=0.90,
        max_hips=0.90,
    )
    return {
        "lateralBoneHeadXBefore": before,
        "lateralBoneHeadXAfter": after,
        "attachmentBindingsBefore": attachment_before,
        "attachmentBindingsAfter": attachment_after,
        "uniformCrotchStabilization": crotch,
    }


def apply_rigid_detail_modifiers(meshes: list[bpy.types.Object]) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    for obj in meshes:
        if obj.name in PRIMARY_DEFORMING_MESHES:
            continue
        for modifier in list(obj.modifiers):
            if modifier.type == "ARMATURE":
                continue
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            name = modifier.name
            kind = modifier.type
            bpy.ops.object.modifier_apply(modifier=name)
            applied.append({"object": obj.name, "modifier": name, "type": kind})
    return applied


def normalize_armature_root(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
) -> dict[str, Any]:
    before_matrix = [[round(float(value), 9) for value in row] for row in armature.matrix_world]
    transform = armature.matrix_world.copy()
    scale = transform.to_scale()
    if max(scale) - min(scale) > 1e-6 or min(scale) <= 0.0:
        raise RuntimeError(f"Expected positive uniform Police root scale, got {tuple(scale)}")
    saved_world = {obj.name: obj.matrix_world.copy() for obj in meshes}
    armature.data.transform(transform)
    armature.matrix_world = Matrix.Identity(4)
    for obj in meshes:
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_world = saved_world[obj.name]
    bpy.context.view_layer.update()
    return {
        "beforeMatrixWorld": before_matrix,
        "bakedUniformScale": round(float(scale.x), 9),
        "afterMatrixWorld": [
            [round(float(value), 9) for value in row] for row in armature.matrix_world
        ],
    }


def widen_upper_body(armature: bpy.types.Object) -> dict[str, Any]:
    mesh_changes: dict[str, Any] = {}
    for name in ("Police_v22_Body", "Police_v22_Uniform"):
        obj = bpy.data.objects.get(name)
        if obj is None:
            raise RuntimeError(f"Missing upper-body mesh {name}")
        maximum_delta = 0.0
        changed = 0
        for vertex in obj.data.vertices:
            amount = min(
                1.0,
                sum(
                    item.weight
                    for item in vertex.groups
                    if obj.vertex_groups[item.group].name in UPPER_BODY_WEIGHTS
                ),
            )
            if amount <= 1e-8:
                continue
            before_x = float(vertex.co.x)
            vertex.co.x *= 1.0 + (UPPER_BODY_WIDTH - 1.0) * amount
            maximum_delta = max(maximum_delta, abs(float(vertex.co.x) - before_x))
            changed += 1
        obj.data.update()
        mesh_changes[name] = {
            "verticesChanged": changed,
            "maximumAbsXDeltaMeters": round(maximum_delta, 7),
            "weightDrivenFalloff": True,
        }

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bone_changes: dict[str, Any] = {}
    for name in sorted(UPPER_BODY_BONES):
        bone = armature.data.edit_bones.get(name)
        if bone is None:
            bpy.ops.object.mode_set(mode="OBJECT")
            raise RuntimeError(f"Missing upper-body bone {name}")
        before = (float(bone.head.x), float(bone.tail.x))
        bone.head.x *= UPPER_BODY_WIDTH
        bone.tail.x *= UPPER_BODY_WIDTH
        bone_changes[name] = {
            "headXBefore": round(before[0], 7),
            "headXAfter": round(float(bone.head.x), 7),
            "tailXBefore": round(before[1], 7),
            "tailXAfter": round(float(bone.tail.x), 7),
        }
    bpy.ops.object.mode_set(mode="OBJECT")
    return {
        "factor": UPPER_BODY_WIDTH,
        "meshes": mesh_changes,
        "bones": bone_changes,
    }


def local_bounds_center(obj: bpy.types.Object) -> Vector:
    low = Vector(
        tuple(min(vertex.co[axis] for vertex in obj.data.vertices) for axis in range(3))
    )
    high = Vector(
        tuple(max(vertex.co[axis] for vertex in obj.data.vertices) for axis in range(3))
    )
    return (low + high) * 0.5


def scale_object_geometry(obj: bpy.types.Object, factors: tuple[float, float, float]) -> None:
    center = local_bounds_center(obj)
    for vertex in obj.data.vertices:
        relative = vertex.co - center
        vertex.co = center + Vector(
            (
                relative.x * factors[0],
                relative.y * factors[1],
                relative.z * factors[2],
            )
        )
    obj.data.update()


def world_bounds_center(obj: bpy.types.Object) -> Vector:
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return (low + high) * 0.5


def world_bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return low, high


def seat_cap_badge_on_enlarged_crown() -> dict[str, Any]:
    """Keep the enlarged badge just outside the enlarged crown's front skin.

    Police faces Blender -Y.  Scaling the crown around its own center moves its
    front surface forward; without this deterministic reseating the otherwise
    larger badge ends up inside the crown and disappears from the game camera.
    """
    crown = bpy.data.objects.get("Police_v22_ServiceCapCrown")
    badge = bpy.data.objects.get("Police_v22_CapBadge")
    if crown is None or badge is None:
        raise RuntimeError("Cannot reseat Police cap badge without crown and badge")
    crown_low, _ = world_bounds(crown)
    badge_low, badge_high = world_bounds(badge)
    clearance = 0.0015
    target_badge_back_y = float(crown_low.y) - clearance
    delta_y = target_badge_back_y - float(badge_high.y)
    matrix = badge.matrix_world.copy()
    matrix.translation.y += delta_y
    badge.matrix_world = matrix
    bpy.context.view_layer.update()
    after_low, after_high = world_bounds(badge)
    return {
        "forwardAxis": "Blender -Y",
        "clearanceMeters": clearance,
        "crownFrontY": round(float(crown_low.y), 7),
        "badgeFrontYBefore": round(float(badge_low.y), 7),
        "badgeBackYBefore": round(float(badge_high.y), 7),
        "translationY": round(delta_y, 7),
        "badgeFrontYAfter": round(float(after_low.y), 7),
        "badgeBackYAfter": round(float(after_high.y), 7),
    }


def reshape_details() -> dict[str, Any]:
    scaled: dict[str, Any] = {}
    for name, factors in SCALE_BY_OBJECT.items():
        obj = bpy.data.objects.get(name)
        if obj is None:
            raise RuntimeError(f"Missing Police A2 detail {name}")
        before_center = world_bounds_center(obj)
        scale_object_geometry(obj, factors)
        after_center = world_bounds_center(obj)
        scaled[name] = {
            "scale": list(factors),
            "worldCenterBefore": [round(float(value), 7) for value in before_center],
            "worldCenterAfter": [round(float(value), 7) for value in after_center],
        }

    moved: dict[str, Any] = {}
    for obj in character_meshes(bpy.data.objects[ARMATURE_NAME]):
        factor = None
        if any(token in obj.name for token in SHOULDER_DETAIL_TOKENS):
            factor = UPPER_BODY_WIDTH
        elif any(token in obj.name for token in CHEST_DETAIL_TOKENS):
            factor = 1.04
        if factor is None:
            continue
        center = world_bounds_center(obj)
        delta = center.x * (factor - 1.0)
        obj.matrix_world.translation.x += delta
        moved[obj.name] = {
            "centerXBefore": round(float(center.x), 7),
            "centerXAfter": round(float(center.x + delta), 7),
            "factor": factor,
        }
    bpy.context.view_layer.update()
    cap_badge_seating = seat_cap_badge_on_enlarged_crown()
    return {
        "scaled": scaled,
        "repositioned": moved,
        "capBadgeSurfaceSeating": cap_badge_seating,
    }


def rigid_binding(obj: bpy.types.Object) -> str | None:
    result: str | None = None
    for vertex in obj.data.vertices:
        influences = [item for item in vertex.groups if item.weight > 1e-6]
        if len(influences) != 1 or abs(float(influences[0].weight) - 1.0) > 1e-5:
            return None
        name = obj.vertex_groups[influences[0].group].name
        if result is None:
            result = name
        elif result != name:
            return None
    return result


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")


def join_safe_rigid_accessories(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
) -> list[dict[str, Any]]:
    groups: dict[tuple[str, str], list[bpy.types.Object]] = {}
    for obj in meshes:
        if obj.name in PRIMARY_DEFORMING_MESHES or len(obj.data.materials) != 1:
            continue
        material = obj.data.materials[0]
        bone = rigid_binding(obj)
        if material is None or bone is None:
            continue
        groups.setdefault((material.name, bone), []).append(obj)

    merges: list[dict[str, Any]] = []
    for (material_name, bone), objects in sorted(groups.items()):
        if len(objects) < 2:
            continue
        objects = sorted(objects, key=lambda obj: obj.name)
        inputs = [obj.name for obj in objects]
        before_vertices = sum(len(obj.data.vertices) for obj in objects)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        active = objects[0]
        bpy.context.view_layer.objects.active = active
        bpy.ops.object.join()
        active.name = f"Police_A2_Rigid_{safe_name(bone)}_{safe_name(material_name)}"
        active.data.name = f"{active.name}_Mesh"
        material = bpy.data.materials[material_name]
        for polygon in active.data.polygons:
            polygon.material_index = 0
        active.data.materials.clear()
        active.data.materials.append(material)
        if rigid_binding(active) != bone:
            raise RuntimeError(f"Rigid join changed binding for {active.name}")
        modifiers = [modifier for modifier in active.modifiers if modifier.type == "ARMATURE"]
        if len(modifiers) != 1 or modifiers[0].object != armature:
            raise RuntimeError(f"Rigid join lost armature modifier on {active.name}")
        merges.append(
            {
                "output": active.name,
                "material": material_name,
                "bone": bone,
                "inputs": inputs,
                "verticesBefore": before_vertices,
                "verticesAfter": len(active.data.vertices),
            }
        )
    return merges


def character_world_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    points: list[Vector] = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        points.extend(evaluated.matrix_world @ Vector(corner) for corner in evaluated.bound_box)
    low = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    high = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return low, high


def plant_feet(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> float:
    low, _ = character_world_bounds(meshes)
    correction = -float(low.z)
    if abs(correction) > 0.05:
        raise RuntimeError(f"Unexpected Police floor correction {correction:.6f} m")
    translation = Matrix.Translation((0.0, 0.0, correction))
    armature.data.transform(translation)
    for obj in meshes:
        matrix = obj.matrix_world.copy()
        matrix.translation.z += correction
        obj.matrix_world = matrix
    bpy.context.view_layer.update()
    return correction


def cleanup_non_character(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> list[str]:
    keep = {armature, *meshes}
    removed: list[str] = []
    for obj in list(bpy.context.scene.objects):
        if obj not in keep:
            removed.append(obj.name)
            bpy.data.objects.remove(obj, do_unlink=True)
    return sorted(removed)


def validate_rigged_scene(
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
) -> dict[str, Any]:
    bone_names = [bone.name for bone in armature.data.bones]
    if len(bone_names) != 21 or set(bone_names) != EXPECTED_BONES:
        raise RuntimeError(f"Police A2 bone contract changed: {bone_names}")
    if len(set(bone_names)) != len(bone_names):
        raise RuntimeError("Police A2 contains duplicate bone names")
    if any(abs(float(value) - expected) > 1e-6 for value, expected in zip(armature.scale, (1, 1, 1))):
        raise RuntimeError(f"Police A2 armature scale is not one: {tuple(armature.scale)}")
    if any(abs(float(value)) > 1e-6 for value in armature.location):
        raise RuntimeError(f"Police A2 armature location is not zero: {tuple(armature.location)}")
    for obj in meshes:
        modifiers = [modifier for modifier in obj.modifiers if modifier.type == "ARMATURE"]
        if len(modifiers) != 1 or modifiers[0].object != armature:
            raise RuntimeError(f"Invalid armature modifier contract on {obj.name}")
        if any(abs(float(value) - 1.0) > 1e-5 for value in obj.scale):
            raise RuntimeError(f"Non-unit mesh scale on {obj.name}: {tuple(obj.scale)}")
    weights = weight_snapshot(meshes)
    if weights["zeroWeightVertices"] != 0:
        raise RuntimeError(f"Police A2 has zero-weight vertices: {weights}")
    if weights["maxInfluences"] > 4:
        raise RuntimeError(f"Police A2 has >4 weights per vertex: {weights}")
    if weights["leftHandNonzeroVertices"] <= 0 or weights["rightHandNonzeroVertices"] <= 0:
        raise RuntimeError(f"Police A2 hand weighting disappeared: {weights}")
    if weights["invalidWeightedGroups"]:
        raise RuntimeError(f"Police A2 has invalid weighted groups: {weights}")
    low, high = character_world_bounds(meshes)
    if abs(float(low.z)) > 2e-5:
        raise RuntimeError(f"Police A2 feet are not on Blender Z=0: {low.z}")
    lateral = skin_repair.bone_side_evidence(armature)
    if not all(
        lateral[left] < 0.0 < lateral[right]
        for left, right in skin_repair.LATERAL_BONE_PAIRS
    ):
        raise RuntimeError(f"Police A2 lateral semantics regressed: {lateral}")
    return {
        "armature": armature.name,
        "boneCount": len(bone_names),
        "uniqueBoneNames": len(set(bone_names)),
        "boneNames": bone_names,
        "hierarchy": hierarchy_snapshot(armature),
        "rootLocation": [round(float(value), 8) for value in armature.location],
        "rootRotation": [round(float(value), 8) for value in armature.rotation_euler],
        "rootScale": [round(float(value), 8) for value in armature.scale],
        "lateralBoneHeadX": lateral,
        "weights": weights,
        "boundsBlenderZUp": {
            "min": [round(float(value), 7) for value in low],
            "max": [round(float(value), 7) for value in high],
            "height": round(float(high.z - low.z), 7),
            "width": round(float(high.x - low.x), 7),
            "depth": round(float(high.y - low.y), 7),
        },
        "orientation": {
            "authoringUp": "+Z",
            "authoringForward": "-Y",
            "glTFUp": "+Y",
            "glTFForward": "+Z",
            "footFloor": "Blender Z=0 / glTF Y=0",
        },
    }


def export_authoring_glb(
    output: Path,
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=str(output.resolve()),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_skins=True,
        export_animations=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_keep_originals=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_cameras=False,
        export_lights=False,
    )


def glb_document(path: Path) -> dict[str, Any]:
    payload = path.read_bytes()
    if payload[:4] != b"glTF" or struct.unpack_from("<I", payload, 4)[0] != 2:
        raise RuntimeError(f"Not a glTF 2 GLB: {path}")
    offset = 12
    while offset + 8 <= len(payload):
        length, kind = struct.unpack_from("<II", payload, offset)
        chunk = payload[offset + 8 : offset + 8 + length]
        if kind == 0x4E4F534A:
            return json.loads(chunk.rstrip(b" \t\r\n\0"))
        offset += 8 + length
    raise RuntimeError(f"GLB has no JSON chunk: {path}")


def glb_snapshot(path: Path) -> dict[str, Any]:
    document = glb_document(path)
    skins = document.get("skins", [])
    joint_nodes = [
        document["nodes"][index].get("name", f"node_{index}")
        for skin in skins
        for index in skin.get("joints", [])
    ]
    root_scales = {
        node.get("name", f"node_{index}"): node.get("scale", [1.0, 1.0, 1.0])
        for index, node in enumerate(document.get("nodes", []))
        if node.get("name") == ARMATURE_NAME
    }
    return {
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "nodes": len(document.get("nodes", [])),
        "meshes": len(document.get("meshes", [])),
        "primitives": sum(
            len(mesh.get("primitives", [])) for mesh in document.get("meshes", [])
        ),
        "materials": len(document.get("materials", [])),
        "textures": len(document.get("textures", [])),
        "skins": len(skins),
        "joints": len(joint_nodes),
        "uniqueJointNames": len(set(joint_nodes)),
        "jointNames": joint_nodes,
        "animations": [animation.get("name") for animation in document.get("animations", [])],
        "armatureRootScales": root_scales,
    }


def save_static_copy(
    output: Path,
    armature: bpy.types.Object,
    meshes: list[bpy.types.Object],
) -> dict[str, Any]:
    for obj in meshes:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
        obj.vertex_groups.clear()
    bpy.data.objects.remove(armature, do_unlink=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output.resolve()), compress=True)
    low, high = character_world_bounds(meshes)
    return {
        "objects": len(meshes),
        "triangles": sum(
            sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)
            for obj in meshes
        ),
        "boundsBlenderZUp": {
            "min": [round(float(value), 7) for value in low],
            "max": [round(float(value), 7) for value in high],
        },
    }


def main() -> None:
    options = parse_args()
    source = options.source.expanduser().resolve()
    output_rigged = options.output_rigged.expanduser().resolve()
    output_static = options.output_static.expanduser().resolve()
    output_glb = options.output_glb.expanduser().resolve()
    report_path = options.report.expanduser().resolve()
    evidence_dir = options.evidence_dir.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    if source in {output_rigged, output_static}:
        raise RuntimeError("Police A2 builder refuses to overwrite its v22 input master")

    bpy.ops.wm.open_mainfile(filepath=str(source))
    armature = bpy.data.objects.get(ARMATURE_NAME)
    if armature is None or armature.type != "ARMATURE":
        raise RuntimeError(f"Missing {ARMATURE_NAME}")
    meshes = character_meshes(armature)
    if len(meshes) != 38:
        raise RuntimeError(f"Expected the audited 38 Police character meshes, got {len(meshes)}")

    resolved_textures = relink_and_pack_makehuman_images()
    camera_scale_face = configure_camera_scale_face_accessories()
    omitted_microtextures = omitted_microtexture_provenance()

    before = {
        "meshes": mesh_snapshot(meshes),
        "materials": material_snapshot(),
        "hierarchy": hierarchy_snapshot(armature),
        "weights": weight_snapshot(meshes),
    }
    previews: dict[str, str] = {}
    if not options.skip_preview:
        previews["beforeTopDown"] = render_preview(
            evidence_dir / "police_a2_before_topdown.png", "Police v22 before"
        )
        remove_preview_objects()

    repair = repair_skinning(armature, meshes)
    applied_modifiers = apply_rigid_detail_modifiers(meshes)
    normalization = normalize_armature_root(armature, meshes)
    upper_body = widen_upper_body(armature)
    details = reshape_details()
    materials = apply_material_profiles()
    skin_tone = apply_skin_tone_management()
    merges = join_safe_rigid_accessories(armature, character_meshes(armature))
    meshes = character_meshes(armature)
    weight_normalization = normalize_limit_weights(meshes)
    floor_correction = plant_feet(armature, meshes)

    if not options.skip_preview:
        previews["afterTopDown"] = render_preview(
            evidence_dir / "police_a2_after_topdown.png", "Police A2 after"
        )
        remove_preview_objects()

    removed = cleanup_non_character(armature, meshes)
    validation = validate_rigged_scene(armature, meshes)
    after_meshes = mesh_snapshot(meshes)

    output_rigged.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1.0
    bpy.ops.wm.save_as_mainfile(filepath=str(output_rigged), compress=True)
    export_authoring_glb(output_glb, armature, meshes)
    glb = glb_snapshot(output_glb)
    if glb["skins"] != 1 or glb["joints"] != 21 or glb["uniqueJointNames"] != 21:
        raise RuntimeError(f"Police A2 authoring GLB rig contract failed: {glb}")
    if glb["animations"]:
        raise RuntimeError(f"Authoring GLB unexpectedly owns runtime animations: {glb}")
    if any(
        any(abs(float(value) - 1.0) > 1e-6 for value in scale)
        for scale in glb["armatureRootScales"].values()
    ):
        raise RuntimeError(f"Police A2 exported root scale is not one: {glb}")

    rigged_metrics = {
        "objects": len(meshes),
        "baseTriangles": sum(
            sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)
            for obj in meshes
        ),
        "evaluatedTriangles": sum(evaluated_triangles(obj) for obj in meshes),
        "materials": len(
            {
                material.name
                for obj in meshes
                for material in obj.data.materials
                if material is not None
            }
        ),
    }
    static_metrics = save_static_copy(output_static, armature, meshes)

    report = {
        "asset": "Police_A2_VisualRework_v23",
        "role": "police",
        "pipeline": "remote-v22 source-preserving gameplay-camera silhouette and material rework",
        "source": {
            "master": display_path(source),
            "sha256": sha256(source),
            "geometryLineage": "existing remote v22 MakeHuman/MPFB-derived body, uniform, and authored Police accessories",
            "conceptReference": "art-source/Concepts/03",
            "externalDownloadsThisPass": [],
        },
        "toolchain": {
            "blender": bpy.app.version_string,
            "python": sys.version.split()[0],
            "script": display_path(Path(__file__)),
        },
        "authoritativeRuntimeClipContract": {
            "clips": list(AUTHORITATIVE_CLIPS),
            "owner": "tools/art_pipeline/build_web_character_animation_sets.py",
            "authoringAssetAnimations": 0,
            "reason": "visual source stays animation-free; the existing retarget builder bakes the remote gameplay contract without renaming clips",
        },
        "designParameters": {
            "upperBodyWidthFactor": UPPER_BODY_WIDTH,
            "capCrownScale": list(CAP_CROWN_SCALE),
            "capHeadbandScale": list(CAP_HEADBAND_SCALE),
            "capBrimScale": list(CAP_BRIM_SCALE),
            "capBadgeScale": list(CAP_BADGE_SCALE),
            "chestBadgeScale": list(CHEST_BADGE_SCALE),
            "nameplateScale": list(NAMEPLATE_SCALE),
            "beltBuckleScale": list(BELT_BUCKLE_SCALE),
            "patchScale": list(PATCH_SCALE),
            "epauletScale": list(EPAULET_SCALE),
        },
        "before": before,
        "skinningRepair": repair,
        "rootNormalization": normalization,
        "upperBodyReshape": upper_body,
        "detailReshape": details,
        "materialZoning": materials,
        "skinToneManagement": skin_tone,
        "resolvedSourceTextures": resolved_textures,
        "cameraScaleFaceAccessories": camera_scale_face,
        "omittedRuntimeMicrotextureProvenance": omitted_microtextures,
        "rigidModifierBake": applied_modifiers,
        "rigidAccessoryMerges": merges,
        "weightNormalization": weight_normalization,
        "floorCorrectionMeters": round(floor_correction, 9),
        "removedNonCharacterObjects": removed,
        "after": {
            "meshes": after_meshes,
            "riggedMetrics": rigged_metrics,
            "staticMetrics": static_metrics,
            "validation": validation,
            "authoringGlb": glb,
        },
        "previews": previews,
        "outputs": {
            "riggedBlend": {
                "path": display_path(output_rigged),
                "bytes": output_rigged.stat().st_size,
                "sha256": sha256(output_rigged),
            },
            "staticBlend": {
                "path": display_path(output_static),
                "bytes": output_static.stat().st_size,
                "sha256": sha256(output_static),
            },
            "animationFreeAuthoringGlb": {
                "path": display_path(output_glb),
                "bytes": output_glb.stat().st_size,
                "sha256": sha256(output_glb),
                "retained": output_glb != DEFAULT_AUTHORING_GLB.resolve(),
            },
        },
        "qualityGates": {
            "sourceNotOverwritten": source not in {output_rigged, output_static},
            "boneCount21": validation["boneCount"] == 21,
            "boneNamesUnique": validation["uniqueBoneNames"] == 21,
            "projectLateralSemantics": all(
                validation["lateralBoneHeadX"][left] < 0.0
                < validation["lateralBoneHeadX"][right]
                for left, right in skin_repair.LATERAL_BONE_PAIRS
            ),
            "zeroWeightVertices": validation["weights"]["zeroWeightVertices"],
            "leftHandNonzeroVertices": validation["weights"]["leftHandNonzeroVertices"],
            "rightHandNonzeroVertices": validation["weights"]["rightHandNonzeroVertices"],
            "maximumInfluencesPerVertex": validation["weights"]["maxInfluences"],
            "unitRootScale": validation["rootScale"] == [1.0, 1.0, 1.0],
            "feetAtFloor": abs(validation["boundsBlenderZUp"]["min"][2]) <= 0.00002,
            "forwardPositiveZAfterGltfExport": True,
            "authoritativeClipNamesUntouched": list(AUTHORITATIVE_CLIPS),
            "safeAccessoryMergeKey": "identical material + identical rigid bone binding",
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if output_glb == DEFAULT_AUTHORING_GLB.resolve():
        output_glb.unlink(missing_ok=True)
    print(json.dumps({
        "report": display_path(report_path),
        "rigged": report["outputs"]["riggedBlend"],
        "static": report["outputs"]["staticBlend"],
        "glb": glb,
        "validation": validation,
    }, indent=2))


if __name__ == "__main__":
    main()
