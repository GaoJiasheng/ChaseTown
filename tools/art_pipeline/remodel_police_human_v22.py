#!/usr/bin/env python3
"""Rebuild the police character around a complete MPFB human body.

This pass replaces the distorted image-to-3D torso used by v21.  The visible
body, head, hands, clothing, hair, and shoes come from one matched MPFB human.
The source rig is posed into a relaxed anatomical stance before the meshes are
baked, then the uniform and service cap are rebuilt around that body.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import remodel_kid_v18_pilot as kit


VERSION = "v22"
ASSET_NAME = "Police_HumanAnatomyRemodel_v22"
SOURCE_PREFIX = "Police_Photoreal_MPFBHuman_v29_SourceHuman"
SOURCE_BLEND = (
    ROOT
    / "art-source/Characters/Police/Photoreal/MPFBRoleRework_2026_07_12_v29"
    / "Police_Photoreal_MPFBHuman_v29.blend"
)
ASSET_OUT = (
    ROOT
    / "art-source/Characters/Police/ReferenceStandard"
    / "HumanAnatomyRemodel_2026_07_14_v22"
)
REVIEW_OUT = ROOT / "docs/art_production/police_human_anatomy_remodel_v22"
SKIN_TEXTURE = (
    ROOT
    / "tools/third_party/makehuman-assets/base/skins/textures"
    / "young_lightskinned_male_diffuse2.png"
)
HAIR_TEXTURE = (
    ROOT
    / "tools/third_party/makehuman-assets/base/hair/short01/short01_diffuse.png"
)
UNIFORM_NORMAL = (
    ROOT
    / "tools/third_party/makehuman-assets/base/clothes/male_casualsuit03"
    / "male_casualsuit03_normal.png"
)
BROW_TEXTURE = (
    ROOT
    / "tools/third_party/makehuman-assets/base/eyebrows/eyebrow001"
    / "eyebrow001.png"
)
LASH_TEXTURE = (
    ROOT
    / "tools/third_party/makehuman-assets/base/eyelashes/eyelashes01"
    / "eyelashes01.png"
)
EYE_PROXY = (
    ROOT
    / "tools/third_party/makehuman-assets/base/eyes/high-poly"
    / "high-poly.obj"
)
EYE_TEXTURE = (
    ROOT
    / "tools/third_party/makehuman-assets/base/eyes/materials"
    / "brown_eye.png"
)


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    if edge0 == edge1:
        return 0.0
    t = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def pulse(start: float, peak_start: float, peak_end: float, end: float, value: float) -> float:
    return smoothstep(start, peak_start, value) * (1.0 - smoothstep(peak_end, end, value))


def reset_scene() -> None:
    kit.reset_scene()
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.look = "AgX - Medium Low Contrast"


def set_pose_euler(armature: bpy.types.Object, name: str, degrees: tuple[float, float, float]) -> None:
    bone = armature.pose.bones.get(name)
    if bone is None:
        return
    bone.rotation_mode = "XYZ"
    bone.rotation_euler = tuple(math.radians(value) for value in degrees)


def apply_relaxed_human_pose(armature: bpy.types.Object) -> None:
    """Move the source A-pose into a balanced, neutral standing pose."""
    set_pose_euler(armature, "pelvis", (0.0, 0.0, 0.0))
    set_pose_euler(armature, "spine_01", (0.0, 0.0, 0.0))
    set_pose_euler(armature, "spine_02", (0.0, 0.0, 0.0))
    set_pose_euler(armature, "spine_03", (0.8, 0.0, 0.0))
    set_pose_euler(armature, "clavicle_l", (0.0, 0.0, -2.2))
    set_pose_euler(armature, "clavicle_r", (0.0, 0.0, 2.2))
    set_pose_euler(armature, "upperarm_l", (0.7, 0.0, -25.0))
    set_pose_euler(armature, "upperarm_r", (-0.7, 0.0, 23.0))
    set_pose_euler(armature, "lowerarm_l", (0.0, 2.0, -8.0))
    set_pose_euler(armature, "lowerarm_r", (0.0, -2.0, 7.0))
    set_pose_euler(armature, "hand_l", (1.0, 0.0, -4.0))
    set_pose_euler(armature, "hand_r", (-1.0, 0.0, 4.0))
    set_pose_euler(armature, "neck_01", (0.0, 0.0, 0.0))
    set_pose_euler(armature, "head", (0.0, 0.0, 0.0))

    finger_curl = {
        "index": (13.0, 19.0, 12.0),
        "middle": (15.0, 22.0, 14.0),
        "ring": (18.0, 24.0, 16.0),
        "pinky": (21.0, 26.0, 18.0),
    }
    for side in ("l", "r"):
        for finger, angles in finger_curl.items():
            for segment, angle in enumerate(angles, start=1):
                set_pose_euler(armature, f"{finger}_0{segment}_{side}", (angle, 0.0, 0.0))
        set_pose_euler(armature, f"thumb_01_{side}", (7.0, 0.0, -10.0))
        set_pose_euler(armature, f"thumb_02_{side}", (12.0, 0.0, 0.0))
        set_pose_euler(armature, f"thumb_03_{side}", (10.0, 0.0, 0.0))
    bpy.context.view_layer.update()


def append_source_character() -> dict[str, bpy.types.Object]:
    names = {
        "armature": f"{SOURCE_PREFIX}.rig_export",
        "body": f"{SOURCE_PREFIX}_export",
        "uniform": f"{SOURCE_PREFIX}.male_casualsuit03_export",
        "shoes": f"{SOURCE_PREFIX}.shoes02_export",
        "hair": f"{SOURCE_PREFIX}.short01_export",
        "eyebrows": f"{SOURCE_PREFIX}.eyebrow001_export",
        "eyelashes": f"{SOURCE_PREFIX}.eyelashes01_export",
    }
    requested = list(names.values())
    with bpy.data.libraries.load(str(SOURCE_BLEND), link=False) as (available, loaded):
        missing = [name for name in requested if name not in available.objects]
        if missing:
            raise RuntimeError(f"Missing MPFB source objects: {missing}")
        loaded.objects = requested
    appended = {obj.name: obj for obj in loaded.objects if obj is not None}
    for obj in appended.values():
        bpy.context.collection.objects.link(obj)
        obj.hide_render = False
        obj.hide_set(False)
    bpy.context.view_layer.update()

    armature = appended[names["armature"]]
    apply_relaxed_human_pose(armature)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    result: dict[str, bpy.types.Object] = {}
    for key in ("body", "uniform", "shoes", "hair", "eyebrows", "eyelashes"):
        source = appended[names[key]]
        evaluated = source.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(
            evaluated,
            preserve_all_data_layers=True,
            depsgraph=depsgraph,
        )
        mesh.transform(evaluated.matrix_world)
        baked = bpy.data.objects.new(f"Police_v22_{key.title()}", mesh)
        bpy.context.collection.objects.link(baked)
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        result[key] = baked

    for obj in appended.values():
        bpy.data.objects.remove(obj, do_unlink=True)
    return result


def apply_anatomy_polish(obj: bpy.types.Object, category: str) -> None:
    """Tune the generic body toward a balanced adult male police silhouette."""
    for vertex in obj.data.vertices:
        co = vertex.co
        z = co.z
        chest = pulse(1.00, 1.15, 1.38, 1.50, z)
        shoulder = pulse(1.27, 1.36, 1.48, 1.56, z)
        waist = pulse(0.84, 0.94, 1.08, 1.18, z)
        hip = pulse(0.62, 0.72, 0.94, 1.04, z)
        upper_leg = pulse(0.35, 0.47, 0.68, 0.82, z)

        if category in {"body", "uniform"}:
            # Keep the source's adult male frame instead of forcing a comic
            # inverted triangle.  The former pass widened the shoulder girdle
            # while shrinking the pelvis, which made the arms look attached to
            # a costume shell rather than a human ribcage.
            x_factor = 1.0 + 0.038 * chest + 0.018 * shoulder
            x_factor -= 0.025 * waist + 0.055 * hip + 0.012 * upper_leg
            co.x *= x_factor

            depth_center = -0.015
            depth_factor = 1.0 + 0.042 * chest - 0.060 * hip
            co.y = depth_center + (co.y - depth_center) * depth_factor

            # Reduce the source model's exaggerated lumbar/hip projection.
            back_weight = smoothstep(0.015, 0.12, co.y) * hip
            co.y -= 0.026 * back_weight
            abdomen = smoothstep(-0.04, -0.14, -co.y) * waist
            co.y += 0.008 * abdomen

        if category == "body" and z > 1.730:
            # The cap hides this area; compress the scalp slightly so the crown
            # can sit at a realistic height without intersecting the head.
            co.z -= 0.060 * smoothstep(1.720, 1.810, z)

        if category == "body":
            # Give the head a credible adult-male support column.  This area is
            # deliberately restricted to the central neck so the jaw and
            # trapezius retain their source anatomy.
            neck = pulse(1.495, 1.525, 1.595, 1.625, z)
            if neck > 0.0 and abs(co.x) < 0.078 and -0.105 < co.y < 0.075:
                co.x *= 1.0 + 0.105 * neck
                neck_center_y = -0.018
                co.y = neck_center_y + (co.y - neck_center_y) * (1.0 + 0.045 * neck)

            # The source ear pinnae project too far laterally at close range.
            # Compress only the outer ear zone, leaving cheeks and temples
            # untouched so the facial proportions remain stable.
            ear = pulse(1.607, 1.625, 1.702, 1.722, z)
            if ear > 0.0 and abs(co.x) > 0.067 and co.y > -0.140:
                sign = -1.0 if co.x < 0.0 else 1.0
                outer = max(0.0, abs(co.x) - 0.067)
                co.x = sign * (0.067 + outer * (1.0 - 0.10 * ear))

            # Bring the sockets toward a normal adult interpupillary distance.
            # This localized move preserves the temples and nose width.
            eye_center_x = 0.0372
            eye_center_z = 1.6813
            eye_dx_source = abs(abs(co.x) - eye_center_x)
            eye_dz_source = abs(co.z - eye_center_z)
            if eye_dx_source < 0.030 and eye_dz_source < 0.030 and co.y < -0.125:
                eye_weight_x = 1.0 - smoothstep(0.012, 0.030, eye_dx_source)
                eye_weight_z = 1.0 - smoothstep(0.014, 0.030, eye_dz_source)
                front_weight = smoothstep(0.125, 0.168, -co.y)
                shift = 0.0040 * eye_weight_x * eye_weight_z * front_weight
                co.x -= math.copysign(shift, co.x)

            # Narrow the source's stylized eye opening around each existing
            # eye center, preserving both the nasal bridge and pupil spacing.
            eye_side_center = math.copysign(0.0332, co.x)
            eye_local_x = abs(co.x - eye_side_center)
            eye_local_z = abs(co.z - eye_center_z)
            if eye_local_x < 0.034 and eye_local_z < 0.026 and co.y < -0.130:
                horizontal_weight = 1.0 - smoothstep(0.014, 0.034, eye_local_x)
                vertical_weight = 1.0 - smoothstep(0.014, 0.026, eye_local_z)
                front_weight = smoothstep(0.130, 0.168, -co.y)
                compression = 1.0 - 0.12 * horizontal_weight * vertical_weight * front_weight
                co.x = eye_side_center + (co.x - eye_side_center) * compression

            # The source neutral expression is unusually wide-eyed.  Converge
            # only the immediate lid region toward the eye center, preserving
            # the brow, nose bridge, cheek volume, and horizontal eye spacing.
            eye_dx = abs(abs(co.x) - 0.0332)
            eye_dz = abs(co.z - eye_center_z)
            if eye_dx < 0.027 and eye_dz < 0.018 and co.y < -0.145:
                eye_weight_x = 1.0 - smoothstep(0.010, 0.027, eye_dx)
                eye_weight_z = 1.0 - smoothstep(0.008, 0.018, eye_dz)
                eye_weight = eye_weight_x * eye_weight_z
                co.z = eye_center_z + (co.z - eye_center_z) * (1.0 - 0.320 * eye_weight)

        if category in {"eyebrows", "eyelashes"}:
            eye_dx = abs(abs(co.x) - 0.0372)
            eye_dz = abs(co.z - 1.6813)
            if eye_dx < 0.035 and eye_dz < 0.070:
                weight_x = 1.0 - smoothstep(0.018, 0.035, eye_dx)
                weight_z = 1.0 - smoothstep(0.045, 0.070, eye_dz)
                co.x -= math.copysign(0.0040 * weight_x * weight_z, co.x)

        if category == "uniform":
            # Keep the jacket body crisp instead of following a narrow waist.
            jacket = pulse(0.82, 0.90, 1.30, 1.43, z)
            center_to_side = smoothstep(0.07, 0.22, abs(co.x))
            co.x *= 1.0 + 0.016 * jacket * center_to_side

            # Lower the rear collar enough to expose the nape in back and side
            # views.  Front lapels retain their height and shape.
            rear_collar = smoothstep(0.005, 0.055, co.y) * smoothstep(1.485, 1.565, z)
            co.z -= 0.035 * rear_collar

            # Consolidate the trouser hem into a clean break over the shoe.
            if co.z < 0.240:
                co.z = 0.222 + (co.z - 0.222) * 0.40
        elif category == "hair":
            if z > 1.705:
                # Seat the crown hair beneath the cap while preserving the
                # temple and nape silhouette.
                top = smoothstep(1.705, 1.785, z)
                co.x *= 1.0 - 0.13 * top
                center_y = -0.030
                co.y = center_y + (co.y - center_y) * (1.0 - 0.16 * top)
                if co.y < -0.060:
                    co.y = -0.060 + (co.y + 0.060) * (1.0 - 0.94 * top)
                if co.y > 0.055:
                    co.y = 0.055 + (co.y - 0.055) * (1.0 - 0.92 * top)
                crown_top = smoothstep(1.735, 1.810, z)
                co.z -= 0.070 * crown_top

            # Raise only the low rear hairline.  The clean separation between
            # hair and collar makes the actual neck readable from behind.
            if z < 1.625 and co.y > -0.005:
                nape = smoothstep(-0.005, 0.035, co.y) * (1.0 - smoothstep(1.600, 1.625, z))
                co.z += 0.022 * nape

    if category == "uniform":
        # Maintain a small physical clearance from the skin after silhouette
        # sculpting so shoulders and collar do not show white poke-through.
        for vertex in obj.data.vertices:
            vertex.co += vertex.normal * 0.0022

    if category == "eyelashes":
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        lower_faces = [face for face in mesh.faces if face.calc_center_median().z < 1.6811]
        bmesh.ops.delete(mesh, geom=lower_faces, context="FACES")
        mesh.to_mesh(obj.data)
        mesh.free()

    obj.data.update()


def image_material(
    name: str,
    image_path: Path,
    *,
    roughness: float,
    subsurface: float = 0.0,
    alpha: bool = False,
    saturation: float = 1.0,
    base_tint: tuple[float, float, float, float] | None = None,
    texture_strength: float = 1.0,
) -> bpy.types.Material:
    if not image_path.exists():
        raise RuntimeError(f"Missing texture: {image_path}")
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(str(image_path), check_existing=True)
    texture.interpolation = "Linear"
    color_output = texture.outputs["Color"]
    if saturation != 1.0:
        hue_sat = nodes.new("ShaderNodeHueSaturation")
        hue_sat.inputs["Saturation"].default_value = saturation
        links.new(color_output, hue_sat.inputs["Color"])
        color_output = hue_sat.outputs["Color"]
    if base_tint is not None and texture_strength < 1.0:
        mix = nodes.new("ShaderNodeMixRGB")
        mix.blend_type = "MIX"
        mix.inputs[0].default_value = texture_strength
        mix.inputs[1].default_value = base_tint
        links.new(color_output, mix.inputs[2])
        color_output = mix.outputs[0]
    links.new(color_output, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = roughness
    if "Subsurface Weight" in bsdf.inputs:
        bsdf.inputs["Subsurface Weight"].default_value = subsurface
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.32
    noise = nodes.new("ShaderNodeTexNoise")
    noise.noise_dimensions = "3D"
    noise.inputs["Scale"].default_value = 145.0 if subsurface else 100.0
    noise.inputs["Detail"].default_value = 5.0
    noise.inputs["Roughness"].default_value = 0.62
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.026 if subsurface else 0.060
    bump.inputs["Distance"].default_value = 0.0012 if subsurface else 0.003
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    if alpha and "Alpha" in texture.outputs and "Alpha" in bsdf.inputs:
        links.new(texture.outputs["Alpha"], bsdf.inputs["Alpha"])
        try:
            mat.surface_render_method = "DITHERED"
        except (AttributeError, TypeError):
            pass
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return mat


def uniform_material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    normal_strength: float,
) -> bpy.types.Material:
    mat = kit.material(name, color, 0.72, noise_scale=225, noise_strength=0.018, sheen=0.025)
    if UNIFORM_NORMAL.exists():
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            texture = nodes.new("ShaderNodeTexImage")
            texture.image = bpy.data.images.load(str(UNIFORM_NORMAL), check_existing=True)
            texture.image.colorspace_settings.name = "Non-Color"
            normal = nodes.new("ShaderNodeNormalMap")
            normal.inputs["Strength"].default_value = normal_strength
            links.new(texture.outputs["Color"], normal.inputs["Color"])
            links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def eye_texture_material(name: str, image_path: Path) -> bpy.types.Material:
    if not image_path.exists():
        raise RuntimeError(f"Missing eye texture: {image_path}")
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(str(image_path), check_existing=True)
    texture.interpolation = "Linear"
    eye_tone = nodes.new("ShaderNodeHueSaturation")
    eye_tone.inputs["Saturation"].default_value = 0.62
    eye_tone.inputs["Value"].default_value = 0.82
    links.new(texture.outputs["Color"], eye_tone.inputs["Color"])
    links.new(eye_tone.outputs["Color"], bsdf.inputs["Base Color"])
    if "Alpha" in texture.outputs and "Alpha" in bsdf.inputs:
        links.new(texture.outputs["Alpha"], bsdf.inputs["Alpha"])
        try:
            mat.surface_render_method = "DITHERED"
        except (AttributeError, TypeError):
            pass
    bsdf.inputs["Roughness"].default_value = 0.24
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.46
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.28
        bsdf.inputs["Coat Roughness"].default_value = 0.08
    if "Subsurface Weight" in bsdf.inputs:
        bsdf.inputs["Subsurface Weight"].default_value = 0.012
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return mat


def build_materials() -> dict[str, bpy.types.Material]:
    return {
        "skin": image_material(
            "M_Police_v22_SkinUV",
            SKIN_TEXTURE,
            roughness=0.57,
            subsurface=0.075,
            saturation=0.84,
            base_tint=(0.43, 0.255, 0.175, 1.0),
            texture_strength=0.86,
        ),
        "hair": image_material("M_Police_v22_HairUV", HAIR_TEXTURE, roughness=0.46, alpha=True),
        "brows": image_material("M_Police_v22_BrowsUV", BROW_TEXTURE, roughness=0.52, alpha=True),
        "lashes": image_material("M_Police_v22_LashesUV", LASH_TEXTURE, roughness=0.48, alpha=True),
        "eye_proxy": eye_texture_material("M_Police_v22_HighPolyEyeUV", EYE_TEXTURE),
        "uniform": uniform_material(
            "M_Police_v22_UniformNavy",
            (0.012, 0.040, 0.095, 1.0),
            normal_strength=0.035,
        ),
        "pants": uniform_material(
            "M_Police_v22_TrouserNavy",
            (0.010, 0.034, 0.084, 1.0),
            normal_strength=0.0,
        ),
        "shoe": kit.material("M_Police_v22_PolishedLeather", (0.006, 0.007, 0.010, 1.0), 0.31, noise_scale=92, noise_strength=0.025),
        "belt": kit.material("M_Police_v22_DutyLeather", (0.004, 0.005, 0.007, 1.0), 0.39, noise_scale=110, noise_strength=0.032),
        "metal": kit.material("M_Police_v22_BrushedSilver", (0.34, 0.38, 0.43, 1.0), 0.24, metallic=0.82, noise_scale=78, noise_strength=0.015),
        "gold": kit.material("M_Police_v22_InsigniaGold", (0.52, 0.29, 0.055, 1.0), 0.26, metallic=0.76, noise_scale=70, noise_strength=0.012),
        "cap": kit.material("M_Police_v22_ServiceCap", (0.010, 0.032, 0.078, 1.0), 0.58, noise_scale=205, noise_strength=0.050, sheen=0.025),
        "cap_band": kit.material("M_Police_v22_CapBand", (0.003, 0.008, 0.020, 1.0), 0.44, noise_scale=150, noise_strength=0.026),
        "eye_white": kit.material("M_Police_v22_EyeSclera", (0.64, 0.60, 0.53, 1.0), 0.28, subsurface=0.018),
        "iris": kit.material("M_Police_v22_IrisBrown", (0.085, 0.026, 0.006, 1.0), 0.22, noise_scale=82, noise_strength=0.022),
        "pupil": kit.material("M_Police_v22_Pupil", (0.001, 0.001, 0.001, 1.0), 0.10),
        "white": kit.material("M_Police_v22_EyeCatchlight", (1.0, 0.98, 0.92, 1.0), 0.08),
        "line": kit.material("M_Police_v22_Eyelash", (0.012, 0.006, 0.003, 1.0), 0.48),
        "patch": kit.material("M_Police_v22_PatchBlue", (0.015, 0.090, 0.24, 1.0), 0.66, noise_scale=170, noise_strength=0.045),
    }


def assign_materials(source: dict[str, bpy.types.Object], mats: dict[str, bpy.types.Material]) -> None:
    body = source["body"]
    body.data.materials.clear()
    body.data.materials.append(mats["skin"])

    hair = source["hair"]
    hair.data.materials.clear()
    hair.data.materials.append(mats["hair"])

    eyebrows = source["eyebrows"]
    eyebrows.data.materials.clear()
    eyebrows.data.materials.append(mats["brows"])

    eyelashes = source["eyelashes"]
    eyelashes.data.materials.clear()
    eyelashes.data.materials.append(mats["lashes"])

    shoes = source["shoes"]
    shoes.data.materials.clear()
    shoes.data.materials.append(mats["shoe"])

    uniform = source["uniform"]
    uniform.data.materials.clear()
    uniform.data.materials.append(mats["uniform"])
    uniform.data.materials.append(mats["pants"])
    for polygon in uniform.data.polygons:
        center = sum((uniform.data.vertices[index].co for index in polygon.vertices), Vector()) / len(polygon.vertices)
        # The trousers continue underneath the duty belt.  Splitting at the
        # former 0.88 m threshold left alternating shirt/trouser polygons over
        # the hip and read as gray skin patches after subdivision.
        polygon.material_index = 1 if center.z < 0.975 else 0

    # Improve ears, nose, lips, eyelids, and fingers in closeups without
    # changing the native control-cage vertex order used by the skin rig.
    subdivision = body.modifiers.new("HumanSurfaceSubdivision", "SUBSURF")
    subdivision.subdivision_type = "CATMULL_CLARK"
    subdivision.levels = 1
    subdivision.render_levels = 1
    subdivision.show_only_control_edges = True

    uniform_subdivision = uniform.modifiers.new("UniformSurfaceSubdivision", "SUBSURF")
    uniform_subdivision.subdivision_type = "CATMULL_CLARK"
    uniform_subdivision.levels = 2
    uniform_subdivision.render_levels = 2
    uniform_subdivision.show_only_control_edges = True


def finish_mesh(obj: bpy.types.Object, material: bpy.types.Material, *, bevel: float = 0.0) -> bpy.types.Object:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    if bevel > 0.0:
        modifier = obj.modifiers.new("PrecisionEdgeBevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
    return obj


def add_rounded_box(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    bevel: float,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish_mesh(obj, material, bevel=bevel)


def add_shield_badge(
    name: str,
    center: tuple[float, float, float],
    size: tuple[float, float],
    depth: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    width, height = size
    outline = (
        (0.00, 1.00),
        (0.72, 0.68),
        (0.64, -0.28),
        (0.00, -1.00),
        (-0.64, -0.28),
        (-0.72, 0.68),
    )
    vertices: list[tuple[float, float, float]] = []
    for y_offset in (-depth * 0.5, depth * 0.5):
        vertices.extend(
            (center[0] + x * width, center[1] + y_offset, center[2] + z * height)
            for x, z in outline
        )
    count = len(outline)
    faces: list[tuple[int, ...]] = [
        tuple(range(count - 1, -1, -1)),
        tuple(range(count, count * 2)),
    ]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    badge = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(badge)
    return finish_mesh(badge, material, bevel=min(width, height) * 0.10)


def add_elliptical_band(
    name: str,
    center: tuple[float, float, float],
    radii: tuple[float, float],
    height: float,
    thickness: float,
    material: bpy.types.Material,
    segments: int = 128,
) -> bpy.types.Object:
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int, int]] = []
    rx, ry = radii
    loops = (
        (-height * 0.5, 0.0),
        (height * 0.5, 0.0),
        (height * 0.5, -thickness),
        (-height * 0.5, -thickness),
    )
    for z_offset, radial_offset in loops:
        for segment in range(segments):
            angle = math.tau * segment / segments
            vertices.append(
                (
                    center[0] + (rx + radial_offset) * math.cos(angle),
                    center[1] + (ry + radial_offset) * math.sin(angle),
                    center[2] + z_offset,
                )
            )
    ring_size = segments
    for layer in range(4):
        next_layer = (layer + 1) % 4
        for segment in range(segments):
            next_segment = (segment + 1) % segments
            a = layer * ring_size + segment
            b = layer * ring_size + next_segment
            c = next_layer * ring_size + next_segment
            d = next_layer * ring_size + segment
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish_mesh(obj, material, bevel=0.0015)


def add_cap_crown(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    segments = 128
    rings = (
        # z, x radius, front radius, back radius, center y
        (1.712, 0.092, 0.148, 0.116, -0.025),
        (1.720, 0.095, 0.148, 0.115, -0.024),
        (1.729, 0.100, 0.147, 0.113, -0.023),
        (1.738, 0.105, 0.146, 0.111, -0.022),
        (1.747, 0.109, 0.145, 0.108, -0.021),
        (1.756, 0.111, 0.146, 0.105, -0.020),
        (1.764, 0.109, 0.149, 0.102, -0.019),
    )
    crown_vertices: list[tuple[float, float, float]] = []
    for ring_index, (z, rx, front_ry, back_ry, center_y) in enumerate(rings):
        profile_weight = ring_index / (len(rings) - 1)
        for segment in range(segments):
            angle = math.tau * segment / segments
            sine = math.sin(angle)
            ry = front_ry if sine < 0.0 else back_ry
            front_lift = max(0.0, -sine) * 0.0035 * profile_weight
            rear_drop = max(0.0, sine) * 0.0025 * profile_weight
            crown_vertices.append((rx * math.cos(angle), center_y + ry * sine, z + front_lift - rear_drop))
    crown_faces: list[tuple[int, ...]] = []
    for ring_index in range(len(rings) - 1):
        for segment in range(segments):
            nxt = (segment + 1) % segments
            a = ring_index * segments + segment
            b = ring_index * segments + nxt
            c = (ring_index + 1) * segments + nxt
            d = (ring_index + 1) * segments + segment
            crown_faces.append((a, b, c, d))
    top_start = (len(rings) - 1) * segments
    crown_faces.append(tuple(top_start + segment for segment in range(segments)))
    crown_mesh = bpy.data.meshes.new("Police_v22_ServiceCapCrown_Mesh")
    crown_mesh.from_pydata(crown_vertices, [], crown_faces)
    crown_mesh.update()
    crown = bpy.data.objects.new("Police_v22_ServiceCapCrown", crown_mesh)
    bpy.context.collection.objects.link(crown)
    finish_mesh(crown, mats["cap"], bevel=0.0022)
    crown.data.polygons[-1].use_smooth = False

    band = add_elliptical_band(
        "Police_v22_ServiceCapHeadband",
        (0.0, -0.025, 1.703),
        (0.094, 0.143),
        0.024,
        0.007,
        mats["cap_band"],
    )
    brim_outline = (
        (-0.096, -0.145),
        (-0.094, -0.158),
        (-0.077, -0.181),
        (-0.043, -0.198),
        (0.000, -0.203),
        (0.043, -0.198),
        (0.077, -0.181),
        (0.094, -0.158),
        (0.096, -0.145),
        (0.000, -0.151),
    )
    brim_vertices = [(x, y + 0.006, z) for z in (1.696, 1.704) for x, y in brim_outline]
    brim_faces: list[tuple[int, ...]] = []
    count = len(brim_outline)
    brim_faces.append(tuple(range(count - 1, -1, -1)))
    brim_faces.append(tuple(range(count, count * 2)))
    for index in range(count):
        nxt = (index + 1) % count
        brim_faces.append((index, nxt, count + nxt, count + index))
    brim_mesh = bpy.data.meshes.new("Police_v22_ServiceCapBrim_Mesh")
    brim_mesh.from_pydata(brim_vertices, [], brim_faces)
    brim_mesh.update()
    brim = bpy.data.objects.new("Police_v22_ServiceCapBrim", brim_mesh)
    bpy.context.collection.objects.link(brim)
    finish_mesh(brim, mats["cap_band"], bevel=0.0025)

    badge = add_shield_badge(
        "Police_v22_CapBadge",
        (0.0, -0.173, 1.733),
        (0.012, 0.016),
        0.0040,
        mats["gold"],
    )
    return [crown, band, brim, badge]


def add_high_poly_eye_proxy(mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    """Fit the official MakeHuman high-poly double-eye proxy to this head."""
    if not EYE_PROXY.exists():
        raise RuntimeError(f"Missing high-poly eye proxy: {EYE_PROXY}")
    bpy.ops.wm.obj_import(filepath=str(EYE_PROXY))
    obj = bpy.context.object
    obj.name = "Police_v22_HighPolyEyes"
    # Blender's OBJ importer adds an X-axis conversion on the object.  The
    # coordinates below already perform the MakeHuman-to-Blender axis mapping.
    obj.rotation_euler = (0.0, 0.0, 0.0)
    source_eye_center_x = 0.2911126
    source_eye_center_y = 15.7506
    source_eye_center_z = 1.3420
    for vertex in obj.data.vertices:
        source = vertex.co.copy()
        side = -1.0 if source.x < 0.0 else 1.0
        vertex.co = (
            side * 0.0332 + (source.x - side * source_eye_center_x) * 0.0740,
            -0.1372 - (source.z - source_eye_center_z) * 0.1000,
            1.6813 + (source.y - source_eye_center_y) * 0.0840,
        )
    obj.data.materials.clear()
    obj.data.materials.append(mats["eye_proxy"])
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.data.update()
    return [obj]


def front_surface_y(
    uniform: bpy.types.Object,
    x: float,
    z: float,
    radius_x: float = 0.055,
    radius_z: float = 0.060,
) -> float:
    candidates = [
        vertex.co.y
        for vertex in uniform.data.vertices
        if abs(vertex.co.x - x) < radius_x and abs(vertex.co.z - z) < radius_z
    ]
    if not candidates:
        raise RuntimeError(f"No uniform surface sample near x={x}, z={z}")
    return min(candidates)


def add_uniform_details(
    mats: dict[str, bpy.types.Material],
    uniform: bpy.types.Object,
) -> list[bpy.types.Object]:
    objects: list[bpy.types.Object] = []
    for side in (-1.0, 1.0):
        epaulet = add_rounded_box(
            f"Police_v22_ShoulderEpaulet_{side:+.0f}",
            (side * 0.150, -0.006, 1.452),
            (0.061, 0.029, 0.006),
            mats["uniform"],
            0.004,
        )
        epaulet.rotation_euler[1] = math.radians(side * 8.0)
        objects.append(epaulet)
        epaulet_button = kit.add_uv_sphere(
            f"Police_v22_EpauletButton_{side:+.0f}",
            (side * 0.107, -0.017, 1.458),
            (0.0050, 0.0030, 0.0050),
            mats["gold"],
            24,
            12,
        )
        objects.append(epaulet_button)

        patch = add_shield_badge(
            f"Police_v22_SleevePatch_{side:+.0f}",
            (0.0, 0.0, 0.0),
            (0.021, 0.029),
            0.005,
            mats["patch"],
        )
        patch.location = (side * 0.286, -0.010, 1.315)
        patch.rotation_euler[2] = math.radians(-side * 90.0)
        objects.append(patch)
        patch_inset = add_shield_badge(
            f"Police_v22_SleevePatchInset_{side:+.0f}",
            (0.0, 0.0, 0.0),
            (0.012, 0.017),
            0.002,
            mats["gold"],
        )
        patch_inset.location = (side * 0.290, -0.010, 1.315)
        patch_inset.rotation_euler[2] = math.radians(-side * 90.0)
        objects.append(patch_inset)

    belt = add_elliptical_band(
        "Police_v22_DutyBeltWrap",
        (0.0, -0.047, 0.942),
        (0.195, 0.126),
        0.032,
        0.012,
        mats["belt"],
        144,
    )
    objects.append(belt)
    objects.append(add_rounded_box("Police_v22_BeltBuckle", (0.0, -0.181, 0.942), (0.031, 0.008, 0.022), mats["metal"], 0.003))
    for side in (-1.0, 1.0):
        objects.append(add_rounded_box(f"Police_v22_BeltPouch_{side:+.0f}", (side * 0.086, -0.183, 0.937), (0.030, 0.018, 0.040), mats["belt"], 0.006))
        pocket_y = front_surface_y(uniform, side * 0.078, 1.205)
        flap_y = front_surface_y(uniform, side * 0.078, 1.258)
        objects.append(add_rounded_box(f"Police_v22_ChestPocket_{side:+.0f}", (side * 0.078, pocket_y - 0.006, 1.205), (0.055, 0.004, 0.057), mats["uniform"], 0.004))
        objects.append(add_rounded_box(f"Police_v22_ChestPocketFlap_{side:+.0f}", (side * 0.078, flap_y - 0.009, 1.258), (0.059, 0.006, 0.012), mats["cap_band"], 0.003))
    nameplate_y = front_surface_y(uniform, -0.078, 1.292, 0.040, 0.035)
    badge_y = front_surface_y(uniform, 0.078, 1.304, 0.040, 0.040)
    objects.append(add_rounded_box("Police_v22_Nameplate", (-0.078, nameplate_y - 0.010, 1.292), (0.036, 0.004, 0.008), mats["metal"], 0.002))
    badge = add_shield_badge(
        "Police_v22_ChestBadge",
        (0.078, badge_y - 0.011, 1.304),
        (0.022, 0.031),
        0.006,
        mats["gold"],
    )
    objects.append(badge)
    placket_points = tuple(
        (0.0, front_surface_y(uniform, 0.0, z, 0.035, 0.035) - 0.007, z)
        for z in (1.355, 1.150, 0.930)
    )
    placket = kit.add_curve(
        "Police_v22_ShirtPlacket",
        placket_points,
        0.0022,
        mats["cap_band"],
    )
    objects.append(placket)
    for index, z in enumerate((1.315, 1.245, 1.175, 1.105, 1.035, 0.965)):
        button_y = front_surface_y(uniform, 0.0, z, 0.035, 0.030)
        button = kit.add_uv_sphere(
            f"Police_v22_ShirtButton_{index:02d}",
            (0.0, button_y - 0.009, z),
            (0.0048, 0.0021, 0.0048),
            mats["metal"],
            28,
            14,
        )
        objects.append(button)
    radio_surface = front_surface_y(uniform, -0.155, 1.315, 0.045, 0.060)
    radio = add_rounded_box("Police_v22_ShoulderRadio", (-0.155, radio_surface - 0.016, 1.315), (0.028, 0.018, 0.050), mats["belt"], 0.005)
    radio.rotation_euler[1] = math.radians(-8.0)
    objects.append(radio)
    cord = kit.add_curve(
        "Police_v22_RadioCord",
        (
            (-0.151, radio_surface - 0.038, 1.295),
            (-0.120, front_surface_y(uniform, -0.120, 1.215) - 0.014, 1.215),
            (-0.105, front_surface_y(uniform, -0.105, 1.115) - 0.014, 1.115),
        ),
        0.0022,
        mats["belt"],
    )
    objects.append(cord)
    return objects


def convert_curves(objects: list[bpy.types.Object]) -> list[bpy.types.Object]:
    converted: list[bpy.types.Object] = []
    for obj in objects:
        if obj.type == "CURVE":
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.convert(target="MESH")
            obj = bpy.context.object
        converted.append(obj)
    return converted


def scene_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects if obj.type == "MESH" for corner in obj.bound_box]
    low = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    high = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return low, high


def setup_studio() -> None:
    kit.setup_studio()
    scene = bpy.context.scene
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.018, 0.022, 0.030, 1.0)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.30


def render_views(character: list[bpy.types.Object]) -> None:
    REVIEW_OUT.mkdir(parents=True, exist_ok=True)
    low, high = scene_bounds(character)
    center = (low + high) * 0.5
    width, depth, height = high.x - low.x, high.y - low.y, high.z - low.z
    distance = height * 3.1
    views = {
        "front": Vector((center.x, center.y - distance, center.z + 0.018)),
        "side": Vector((center.x + distance, center.y, center.z + 0.018)),
        "back": Vector((center.x, center.y + distance, center.z + 0.018)),
        "top": Vector((center.x, center.y, center.z + distance)),
    }
    for name in ("front", "side", "top", "back"):
        bpy.ops.object.camera_add(location=views[name])
        camera = bpy.context.object
        camera.name = f"Police_v22_Camera_{name}"
        kit.look_at(camera, center)
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = max(height * 1.08, width * 1.36) if name != "top" else max(width, depth) * 1.32
        camera.data.lens = 72
        bpy.context.scene.camera = camera
        bpy.context.scene.render.resolution_x = 960
        bpy.context.scene.render.resolution_y = 1280 if name != "top" else 960
        bpy.context.scene.render.resolution_percentage = 100
        bpy.context.scene.render.filepath = str(REVIEW_OUT / f"Police_v22_{name}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(camera, do_unlink=True)

    face_target = Vector((0.0, -0.035, 1.690))
    bpy.ops.object.camera_add(location=(0.0, -1.05, 1.690))
    camera = bpy.context.object
    camera.name = "Police_v22_Camera_face_closeup"
    kit.look_at(camera, face_target)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 0.38
    camera.data.lens = 82
    bpy.context.scene.camera = camera
    bpy.context.scene.render.resolution_x = 960
    bpy.context.scene.render.resolution_y = 960
    bpy.context.scene.render.resolution_percentage = 100
    bpy.context.scene.render.filepath = str(REVIEW_OUT / "Police_v22_face_closeup.png")
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera, do_unlink=True)

    bpy.ops.object.camera_add(location=(1.05, -0.035, 1.690))
    camera = bpy.context.object
    camera.name = "Police_v22_Camera_face_profile"
    kit.look_at(camera, face_target)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 0.40
    camera.data.lens = 82
    bpy.context.scene.camera = camera
    bpy.context.scene.render.filepath = str(REVIEW_OUT / "Police_v22_face_profile.png")
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera, do_unlink=True)

    nape_target = Vector((0.0, 0.020, 1.585))
    bpy.ops.object.camera_add(location=(0.0, 1.05, 1.585))
    camera = bpy.context.object
    camera.name = "Police_v22_Camera_nape_closeup"
    kit.look_at(camera, nape_target)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 0.43
    camera.data.lens = 82
    bpy.context.scene.camera = camera
    bpy.context.scene.render.filepath = str(REVIEW_OUT / "Police_v22_nape_closeup.png")
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera, do_unlink=True)


def mesh_stats(objects: list[bpy.types.Object]) -> dict[str, int | float | list[float]]:
    vertices = polygons = triangles = 0
    for obj in objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        mesh.calc_loop_triangles()
        vertices += len(mesh.vertices)
        polygons += len(mesh.polygons)
        triangles += len(mesh.loop_triangles)
    low, high = scene_bounds(objects)
    return {
        "vertices": vertices,
        "polygons": polygons,
        "triangles": triangles,
        "bounds_min": [round(value, 5) for value in low],
        "bounds_max": [round(value, 5) for value in high],
        "height_m": round(high.z - low.z, 5),
    }


def export(character: list[bpy.types.Object]) -> None:
    ASSET_OUT.mkdir(parents=True, exist_ok=True)
    report_dir = ASSET_OUT / "Reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    blend = ASSET_OUT / f"{ASSET_NAME}.blend"
    fbx = ASSET_OUT / f"{ASSET_NAME}.fbx"
    glb = ASSET_OUT / f"{ASSET_NAME}.glb"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in character:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = character[0]
    bpy.ops.export_scene.fbx(
        filepath=str(fbx),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        axis_forward="Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
        bake_anim=False,
    )
    bpy.ops.export_scene.gltf(
        filepath=str(glb),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
    )
    report = {
        "asset": ASSET_NAME,
        "source": str(SOURCE_BLEND.relative_to(ROOT)),
        "anatomy_basis": "complete matched MPFB adult male human",
        "stance": "relaxed neutral with finger curl baked before export",
        "skin_texture": str(SKIN_TEXTURE.relative_to(ROOT)),
        "eye_proxy": str(EYE_PROXY.relative_to(ROOT)),
        "eye_texture": str(EYE_TEXTURE.relative_to(ROOT)),
        "four_view_dir": str(REVIEW_OUT.relative_to(ROOT)),
        "stats": mesh_stats(character),
        "files": [str(path.relative_to(ROOT)) for path in (blend, fbx, glb)],
    }
    (report_dir / "Police_HumanAnatomyRemodel_v22_quality_report.json").write_text(
        json.dumps(report, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )


def build() -> None:
    reset_scene()
    source = append_source_character()
    for category, obj in source.items():
        apply_anatomy_polish(obj, category)
    mats = build_materials()
    assign_materials(source, mats)
    details = (
        add_high_poly_eye_proxy(mats)
        + add_cap_crown(mats)
        + add_uniform_details(mats, source["uniform"])
    )
    details = convert_curves(details)
    character = list(source.values()) + details
    setup_studio()
    render_views(character)
    export(character)


def main() -> int:
    build()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
