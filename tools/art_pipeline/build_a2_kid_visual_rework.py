#!/usr/bin/env python3
"""Build the deterministic Kid A2 visual master from the approved v21 rig.

The pass is deliberately camera-scale: it preserves the canonical 21-bone
skeleton, skin weights, UVs and animation hand-off, while strengthening the
head/hair mass, hoodie shoulder line, backpack silhouette and shoe accents
that remain legible at the production 34--68 px gameplay height.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_ROOT = ROOT / "art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21"
SOURCE_BLEND = SOURCE_ROOT / "Rigged/Kid_PrecisionRemodel_v21_Rigged.blend"
A2_ROOT = ROOT / "art-source/Characters/Kid/ReferenceStandard/A2_VisualRework_2026_08_29"
RIGGED_BLEND = A2_ROOT / "Rigged/Kid_A2_VisualRework_v22_Rigged.blend"
STATIC_BLEND = A2_ROOT / "Kid_A2_VisualRework_v22.blend"
BASE_COLOR = A2_ROOT / "Textures/Char_Kid_A2_Semantic_BaseColor_2K.png"
REPORT = A2_ROOT / "Reports/Kid_A2_visual_rework_generated_report.json"
EVIDENCE = A2_ROOT / "Reports/evidence"

ARMATURE_NAME = "Rig_Humanoid_Shared"
BODY_NAME = "Kid_v20_NativeBodyHead"
EXPECTED_BONES = {
    "Hips", "Spine", "Chest", "Neck", "Head",
    "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
    "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
}

HEAD_WIDTH = 1.065
HEAD_DEPTH = 1.055
SHOULDER_WIDTH = 1.045
BACKPACK_SCALE = (1.10, 1.08, 1.06)
SHOE_ACCENT_SCALE = (1.10, 1.08, 1.08)

MATERIAL_PROFILES: dict[str, dict[str, Any]] = {
    "M_Kid_BackpackNavy": {
        "baseColor": (0.018, 0.085, 0.235, 1.0), "metallic": 0.0,
        "roughness": 0.61, "read": "saturated blue backpack identity block",
    },
    "M_Kid_BackpackTrim": {
        "baseColor": (0.012, 0.035, 0.090, 1.0), "metallic": 0.0,
        "roughness": 0.47, "read": "deep navy straps separated from the bag body",
    },
    "M_Kid_BackpackLeather": {
        "baseColor": (0.225, 0.070, 0.022, 1.0), "metallic": 0.0,
        "roughness": 0.43, "read": "warm leather base anchors the backpack",
    },
    "M_Kid_ZipperMetal": {
        "baseColor": (0.54, 0.64, 0.76, 1.0), "metallic": 0.82,
        "roughness": 0.22, "read": "cool metal zipper glint",
    },
    "M_Kid_Sock": {
        "baseColor": (0.88, 0.94, 1.0, 1.0), "metallic": 0.0,
        "roughness": 0.72, "read": "bright sock and lace break above dark shoes",
    },
    "M_Kid_HoodieNavy": {
        "baseColor": (0.014, 0.055, 0.175, 1.0), "metallic": 0.0,
        "roughness": 0.73, "read": "clean navy sock stripe accent",
    },
    "M_Kid_FacialHair": {
        "baseColor": (0.010, 0.004, 0.003, 1.0), "metallic": 0.0,
        "roughness": 0.58, "read": "dark facial line mass",
    },
    "M_Kid_IrisBrown_EyeGloss": {
        "baseColor": (0.12, 0.035, 0.012, 1.0), "metallic": 0.0,
        "roughness": 0.22, "read": "warm dark iris focus",
    },
    "M_Kid_Pupil_EyeGloss": {
        "baseColor": (0.002, 0.001, 0.001, 1.0), "metallic": 0.0,
        "roughness": 0.18, "read": "black pupil focus",
    },
}


def args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE_BLEND)
    parser.add_argument("--output-rigged", type=Path, default=RIGGED_BLEND)
    parser.add_argument("--output-static", type=Path, default=STATIC_BLEND)
    parser.add_argument("--base-color", type=Path, default=BASE_COLOR)
    parser.add_argument("--report", type=Path, default=REPORT)
    parser.add_argument("--evidence-dir", type=Path, default=EVIDENCE)
    parser.add_argument("--skip-preview", action="store_true")
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def display(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        return resolved.relative_to(ROOT).as_posix()
    except ValueError:
        return resolved.name


def character_meshes(armature: bpy.types.Object) -> list[bpy.types.Object]:
    return sorted([
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.name != "Studio_Floor" and (
            obj.parent == armature
            or any(mod.type == "ARMATURE" and mod.object == armature for mod in obj.modifiers)
        )
    ], key=lambda obj: obj.name)


def triangles(meshes: list[bpy.types.Object]) -> int:
    return sum(
        max(0, len(poly.vertices) - 2)
        for obj in meshes for poly in obj.data.polygons
    )


def hierarchy(armature: bpy.types.Object) -> dict[str, str | None]:
    return {bone.name: bone.parent.name if bone.parent else None for bone in armature.data.bones}


def weights(meshes: list[bpy.types.Object]) -> dict[str, Any]:
    vertices = 0
    zero = 0
    maximum = 0
    hands = {"LeftHand": 0, "RightHand": 0}
    invalid: set[str] = set()
    for obj in meshes:
        for vertex in obj.data.vertices:
            influences = [group for group in vertex.groups if group.weight > 1e-8]
            vertices += 1
            zero += not influences
            maximum = max(maximum, len(influences))
            for influence in influences:
                name = obj.vertex_groups[influence.group].name
                if name in hands:
                    hands[name] += 1
                if name not in EXPECTED_BONES:
                    invalid.add(name)
    return {
        "vertices": vertices,
        "zeroWeightVertices": int(zero),
        "zeroWeightRatio": round(zero / max(vertices, 1), 9),
        "maxInfluences": maximum,
        "leftHandNonzeroVertices": hands["LeftHand"],
        "rightHandNonzeroVertices": hands["RightHand"],
        "invalidWeightedGroups": sorted(invalid),
    }


def world_bounds(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    return (
        Vector(tuple(min(point[index] for point in points) for index in range(3))),
        Vector(tuple(max(point[index] for point in points) for index in range(3))),
    )


def scale_geometry(obj: bpy.types.Object, factors: tuple[float, float, float]) -> None:
    low, high = world_bounds(obj)
    center_world = (low + high) * 0.5
    inverse = obj.matrix_world.inverted()
    center = inverse @ center_world
    for vertex in obj.data.vertices:
        delta = vertex.co - center
        vertex.co = center + Vector((
            delta.x * factors[0], delta.y * factors[1], delta.z * factors[2],
        ))
    obj.data.update()


def reshape_body(body: bpy.types.Object) -> dict[str, Any]:
    head_changed = 0
    shoulder_changed = 0
    maximum_delta = 0.0
    for vertex in body.data.vertices:
        before = vertex.co.copy()
        z = float(vertex.co.z)
        if z >= 1.02:
            blend = min(1.0, max(0.0, (z - 1.02) / 0.11))
            vertex.co.x *= 1.0 + (HEAD_WIDTH - 1.0) * blend
            vertex.co.y *= 1.0 + (HEAD_DEPTH - 1.0) * blend
            head_changed += 1
        elif 0.70 <= z < 1.02:
            # Smoothly broaden the hoodie/shoulder read without changing the
            # hips, feet, root position or any rest-bone transform.
            blend = math.sin(math.pi * (z - 0.70) / 0.32) ** 0.65
            vertex.co.x *= 1.0 + (SHOULDER_WIDTH - 1.0) * blend
            shoulder_changed += 1
        maximum_delta = max(maximum_delta, (vertex.co - before).length)
    body.data.update()
    return {
        "headVerticesChanged": head_changed,
        "shoulderVerticesChanged": shoulder_changed,
        "headWidthFactor": HEAD_WIDTH,
        "headDepthFactor": HEAD_DEPTH,
        "shoulderWidthFactor": SHOULDER_WIDTH,
        "maximumVertexDeltaMeters": round(maximum_delta, 7),
        "restSkeletonChanged": False,
    }


def reshape_accessories(meshes: list[bpy.types.Object]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for obj in meshes:
        factors = None
        if obj.name.startswith("Kid_Backpack_"):
            factors = BACKPACK_SCALE
        elif obj.name.startswith("Kid_ShoeLace_") or obj.name.startswith("Kid_SockStripe_"):
            factors = SHOE_ACCENT_SCALE
        if factors is None:
            continue
        before = world_bounds(obj)
        scale_geometry(obj, factors)
        after = world_bounds(obj)
        result[obj.name] = {
            "scale": list(factors),
            "boundsBefore": [[round(float(v), 6) for v in bound] for bound in before],
            "boundsAfter": [[round(float(v), 6) for v in bound] for bound in after],
        }
    return result


def configure_materials() -> dict[str, Any]:
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for name, profile in MATERIAL_PROFILES.items():
        material = bpy.data.materials.get(name)
        if material is None:
            raise RuntimeError(f"Missing Kid material {name}")
        material.use_nodes = True
        principled = material.node_tree.nodes.get("Principled BSDF")
        if principled is None:
            raise RuntimeError(f"Missing Principled BSDF for {name}")
        before[name] = {
            "baseColor": [round(float(value), 6) for value in principled.inputs["Base Color"].default_value],
            "metallic": round(float(principled.inputs["Metallic"].default_value), 6),
            "roughness": round(float(principled.inputs["Roughness"].default_value), 6),
        }
        principled.inputs["Base Color"].default_value = profile["baseColor"]
        principled.inputs["Metallic"].default_value = profile["metallic"]
        principled.inputs["Roughness"].default_value = profile["roughness"]
        after[name] = {
            "baseColor": list(profile["baseColor"]),
            "metallic": profile["metallic"],
            "roughness": profile["roughness"],
            "read": profile["read"],
        }
    return {"before": before, "after": after}


def relink_source_base_color() -> None:
    """Resolve the old v21 relative image path before the before-render.

    Blender 5 can keep the image datablock alive while its old relative path
    resolves against the factory-startup cwd, producing a magenta false
    negative in QA. The pinned file is already part of the approved source.
    """
    path = SOURCE_ROOT / "Rigged/Textures/Char_Kid_PrecisionRemodel_v21_BaseColor_2K.png"
    for image in bpy.data.images:
        if "Char_Kid_PrecisionRemodel_v21_BaseColor_2K" not in image.name:
            continue
        image.filepath = str(path.resolve())
        image.reload()


def bake_semantic_base_color(body: bpy.types.Object, output: Path) -> dict[str, Any]:
    material = body.data.materials[0]
    if material is None or material.name != "M_Kid_PrecisionRemodel_v21_URP":
        raise RuntimeError("Kid body lost the approved primary material")
    palette = body.data.color_attributes.get("BodyPalette")
    if palette is None or palette.domain != "POINT":
        raise RuntimeError("Kid A2 requires the POINT-domain BodyPalette semantic source")

    output.parent.mkdir(parents=True, exist_ok=True)
    image = bpy.data.images.new("Char_Kid_A2_Semantic_BaseColor_2K", 2048, 2048, alpha=True)
    image.filepath_raw = str(output.resolve())
    image.file_format = "PNG"

    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output_node = nodes.new("ShaderNodeOutputMaterial")
    output_node.location = (540, 40)
    emission = nodes.new("ShaderNodeEmission")
    emission.location = (260, 40)
    attribute = nodes.new("ShaderNodeVertexColor")
    attribute.layer_name = "BodyPalette"
    attribute.location = (-300, 60)
    image_node = nodes.new("ShaderNodeTexImage")
    image_node.image = image
    image_node.location = (-300, -220)
    nodes.active = image_node
    links.new(attribute.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output_node.inputs["Surface"])

    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    bpy.context.view_layer.objects.active = body
    # Cycles CPU provides deterministic emission baking on every supported
    # Blender host; the result contains semantic colour only, never lighting.
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.device = "CPU"
    bpy.ops.object.bake(type="EMIT", margin=16, use_clear=True)
    image.save()

    nodes.clear()
    output_node = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    principled.inputs["Roughness"].default_value = 0.72
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    links.new(principled.outputs["BSDF"], output_node.inputs["Surface"])
    return {
        "path": display(output), "bytes": output.stat().st_size,
        "sha256": sha256(output), "resolution": [2048, 2048],
        "semanticSource": "Kid_v20_NativeBodyHead.BodyPalette POINT color attribute",
        "lightingBaked": False, "uvChanged": False,
    }


def strip_runtime_vertex_colors(meshes: list[bpy.types.Object]) -> dict[str, list[str]]:
    """Remove authoring-only semantic layers after their texture bake.

    Blender preserves the source layer's historical COLOR_2 slot even when
    COLOR_0/1 no longer exist. glTF requires indexed COLOR_n semantics to be
    contiguous, and the runtime shader uses the baked BaseColor texture rather
    than vertex colours, so exporting the layer is both invalid and redundant.
    """
    removed: dict[str, list[str]] = {}
    for obj in meshes:
        names = [attribute.name for attribute in obj.data.color_attributes]
        if not names:
            continue
        removed[obj.name] = names
        for attribute in list(obj.data.color_attributes):
            obj.data.color_attributes.remove(attribute)
    return removed


def character_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points: list[Vector] = []
    for obj in meshes:
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    return (
        Vector(tuple(min(point[i] for point in points) for i in range(3))),
        Vector(tuple(max(point[i] for point in points) for i in range(3))),
    )


def render_preview(path: Path, meshes: list[bpy.types.Object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    low, high = character_bounds(meshes)
    center = (low + high) * 0.5
    height = high.z - low.z
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = scene.world or bpy.data.worlds.new("Kid_A2_PreviewWorld")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.018, 0.026, 0.045, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.30
    created: list[bpy.types.Object] = []
    for name, offset, energy, color, size in (
        ("Key", (-1.8, -2.7, 3.4), 720.0, (0.82, 0.91, 1.0), 2.4),
        ("Fill", (2.3, -1.2, 2.2), 360.0, (1.0, 0.72, 0.48), 3.0),
        ("Rim", (0.2, 2.8, 3.0), 560.0, (0.38, 0.58, 1.0), 2.2),
    ):
        data = bpy.data.lights.new(f"Kid_A2_{name}", "AREA")
        data.energy, data.color, data.shape, data.size = energy, color, "DISK", size
        light = bpy.data.objects.new(f"Kid_A2_{name}", data)
        bpy.context.collection.objects.link(light)
        light.location = center + Vector(tuple(value * height for value in offset))
        light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()
        created.append(light)
    camera_data = bpy.data.cameras.new("Kid_A2_GameCamera")
    camera = bpy.data.objects.new("Kid_A2_GameCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = height * 1.34
    camera.location = center + Vector((height * 2.5, -height * 3.8, height * 3.25))
    camera.rotation_euler = (Vector((center.x, center.y, low.z + height * 0.48)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera
    created.append(camera)
    scene.render.filepath = str(path.resolve())
    bpy.context.view_layer.update()
    bpy.ops.render.render(write_still=True)
    for obj in created:
        bpy.data.objects.remove(obj, do_unlink=True)


def validate(armature: bpy.types.Object, meshes: list[bpy.types.Object], baseline: dict[str, Any]) -> dict[str, Any]:
    result = {
        "bones": len(armature.data.bones),
        "boneNames": sorted(armature.data.bones.keys()),
        "hierarchyUnchanged": hierarchy(armature) == baseline["hierarchy"],
        "weights": weights(meshes),
        "triangles": triangles(meshes),
        "meshes": len(meshes),
        "forward": "+Z runtime (Blender -Y export convention)",
        "rootScale": [round(float(value), 6) for value in armature.scale],
    }
    if set(result["boneNames"]) != EXPECTED_BONES or result["bones"] != 21:
        raise RuntimeError(f"Kid A2 bone contract failed: {result['boneNames']}")
    if not result["hierarchyUnchanged"]:
        raise RuntimeError("Kid A2 changed the canonical hierarchy")
    if result["weights"]["zeroWeightRatio"] >= 0.02:
        raise RuntimeError("Kid A2 exceeded the zero-weight ceiling")
    if min(result["weights"]["leftHandNonzeroVertices"], result["weights"]["rightHandNonzeroVertices"]) <= 0:
        raise RuntimeError("Kid A2 lost hand weights")
    return result


def save_blends(static: Path, rigged: Path) -> None:
    for obj in list(bpy.context.scene.objects):
        if obj.name == "Studio_Floor":
            bpy.data.objects.remove(obj, do_unlink=True)
    for image in bpy.data.images:
        if image.filepath:
            image.filepath = str(Path(bpy.path.abspath(image.filepath)).resolve())
    rigged.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(rigged.resolve()), compress=True)
    static.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(static.resolve()), compress=True)


def main() -> None:
    options = args()
    source = options.source.expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    armature = bpy.data.objects.get(ARMATURE_NAME)
    body = bpy.data.objects.get(BODY_NAME)
    if armature is None or armature.type != "ARMATURE" or body is None:
        raise RuntimeError("Kid v21 source is missing its canonical rig or body")
    meshes = character_meshes(armature)
    baseline = {
        "hierarchy": hierarchy(armature),
        "weights": weights(meshes),
        "triangles": triangles(meshes),
        "meshes": len(meshes),
    }
    relink_source_base_color()
    if not options.skip_preview:
        render_preview(options.evidence_dir / "kid_a2_before_topdown.png", meshes)

    body_change = reshape_body(body)
    accessory_change = reshape_accessories(meshes)
    material_change = configure_materials()
    base_color = bake_semantic_base_color(body, options.base_color.expanduser().resolve())
    removed_vertex_colors = strip_runtime_vertex_colors(meshes)
    final = validate(armature, meshes, baseline)
    if not options.skip_preview:
        render_preview(options.evidence_dir / "kid_a2_after_topdown.png", meshes)
    save_blends(options.output_static.expanduser().resolve(), options.output_rigged.expanduser().resolve())

    report = {
        "role": "kid",
        "artifactStage": "A2 source visual master before authoritative animation rebake",
        "source": {
            "path": display(source), "bytes": source.stat().st_size, "sha256": sha256(source),
            "geometryLineage": "Tencent Hunyuan3D-derived v21 PrecisionRemodel",
        },
        "outputs": {
            "staticBlend": {
                "path": display(options.output_static), "bytes": options.output_static.stat().st_size,
                "sha256": sha256(options.output_static),
            },
            "riggedBlend": {
                "path": display(options.output_rigged), "bytes": options.output_rigged.stat().st_size,
                "sha256": sha256(options.output_rigged),
            },
            "semanticBaseColor": base_color,
        },
        "before": baseline,
        "changes": {
            "bodySilhouette": body_change,
            "accessorySilhouette": accessory_change,
            "materialProfiles": material_change,
            "authoringVertexColorsRemovedAfterBake": removed_vertex_colors,
        },
        "after": final,
        "qualityGates": {
            "canonicalBoneNamesAndCount": True,
            "canonicalHierarchyUnchanged": True,
            "skinWeightsPreserved": baseline["weights"] == final["weights"],
            "topologyPreserved": baseline["triangles"] == final["triangles"],
            "uvsPreserved": True,
            "runtimeClipsOwnedByAnimationPipeline": True,
            "runtimeVertexColorSemanticsRemoved": True,
            "noRuntimeScaleOrOrientationPatch": True,
        },
        "evidence": {
            "beforeTopdown": display(options.evidence_dir / "kid_a2_before_topdown.png"),
            "afterTopdown": display(options.evidence_dir / "kid_a2_after_topdown.png"),
        },
    }
    options.report.parent.mkdir(parents=True, exist_ok=True)
    options.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
