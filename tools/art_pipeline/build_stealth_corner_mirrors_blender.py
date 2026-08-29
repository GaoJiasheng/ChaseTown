"""Author the four production convex corner mirrors used by stealth gameplay.

Run from the repository root:

    blender --background --python tools/art_pipeline/build_stealth_corner_mirrors_blender.py

To reproduce only the runtime GLB from the checked-in approved Blender master:

    CHASING_MIRROR_EXPORT_EXISTING=1 blender --background \
      --python tools/art_pipeline/build_stealth_corner_mirrors_blender.py

The authored Blender coordinate system is Z-up with the wall on the X/Z plane
and the mirror facing Blender -Y. Blender's glTF Y-up conversion therefore
exports the visible mirror face toward local +Z, which is the runtime contract.

The file deliberately contains real hard-surface assemblies: a mathematically
convex metal mirror, deep protective bezel and rear shell, offset wall plate,
dual articulated arms, two-axis gimbals, lock knobs, washers and fasteners.
Only the tiny status LED is emissive. Every theme is independently selectable
through its exact root node and contains the six exact runtime mesh names.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import hashlib
import json
import math
import os
import random
import struct
import subprocess
import tempfile

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "art-source" / "Environment" / "Interactive"
BLEND_PATH = SOURCE_DIR / "Stealth_Corner_Mirrors.blend"
GLB_PATH = ROOT / "public" / "models" / "environment" / "stealth-corner-mirrors.glb"
REVIEW_DIR = Path(
    os.environ.get(
        "CHASING_CORNER_MIRROR_REVIEW_DIR",
        "/tmp/chasing-corner-mirror-asset-review",
    )
)
GLTFPACK_CANDIDATES = (
    os.environ.get("GLTFPACK_KTX2"),
    os.environ.get("GLTFPACK_NATIVE"),
    "/private/tmp/gltfpack-macos-v1.2/gltfpack",
    "/opt/homebrew/bin/gltfpack",
)
GLTFPACK_VERSION = "gltfpack 1.2"
GLTFPACK_BINARY_SHA256 = "037336fafa46f342fe118ce8d17877fecb3deb1cd6dd8f62ee2a95bfaf2b79df"
GLTFPACK_ARGUMENTS = (
    "-cc", "-kn", "-km", "-ke",
    "-vp", "14", "-vn", "8", "-vt", "10",
    "-tc", "-tq", "10", "-tj", "4",
)

MIRROR_RADIUS = 0.34
MIRROR_DIAMETER = MIRROR_RADIUS * 2.0
MIRROR_CENTER = Vector((0.30, -0.34, 1.55))
MIRROR_TILT_DEGREES = 10.0
MIRROR_TILT_RADIANS = math.radians(MIRROR_TILT_DEGREES)
PBR_TEXTURE_SIZE = 192
MIRROR_OUTWARD = Vector(
    (0.0, -math.cos(MIRROR_TILT_RADIANS), math.sin(MIRROR_TILT_RADIANS))
).normalized()
PLATE_CENTER = Vector((0.0, 0.002, 1.55))

ROOT_NAMES = (
    "CampusCornerMirror",
    "HospitalCornerMirror",
    "FireStationCornerMirror",
    "FactoryCornerMirror",
)
RUNTIME_MESH_NAMES = (
    "polished-corner-mirror-face",
    "authored-corner-mirror-rim",
    "corner-mirror-wall-plate",
    "corner-mirror-articulated-arm",
    "corner-mirror-fasteners",
    "corner-mirror-status-led",
)


@dataclass(frozen=True)
class Theme:
    key: str
    root_name: str
    frame_color: tuple[float, float, float, float]
    plate_color: tuple[float, float, float, float]
    accent_color: tuple[float, float, float, float]
    arm_color: tuple[float, float, float, float]
    frame_metallic: float
    frame_roughness: float
    plate_metallic: float
    plate_roughness: float
    accent_style: str


THEMES = (
    Theme(
        "campus",
        "CampusCornerMirror",
        (0.025, 0.090, 0.205, 1.0),
        (0.040, 0.125, 0.245, 1.0),
        (0.94, 0.53, 0.065, 1.0),
        (0.26, 0.31, 0.36, 1.0),
        0.66,
        0.22,
        0.44,
        0.29,
        "campus-badge",
    ),
    Theme(
        "hospital",
        "HospitalCornerMirror",
        (0.72, 0.82, 0.84, 1.0),
        (0.78, 0.87, 0.88, 1.0),
        (0.015, 0.43, 0.41, 1.0),
        (0.42, 0.50, 0.52, 1.0),
        0.48,
        0.20,
        0.32,
        0.24,
        "hospital-cross",
    ),
    Theme(
        "fire-station",
        "FireStationCornerMirror",
        (0.49, 0.025, 0.018, 1.0),
        (0.38, 0.018, 0.014, 1.0),
        (0.98, 0.48, 0.025, 1.0),
        (0.39, 0.20, 0.050, 1.0),
        0.70,
        0.20,
        0.58,
        0.27,
        "fire-hazard",
    ),
    Theme(
        "factory",
        "FactoryCornerMirror",
        (0.055, 0.063, 0.070, 1.0),
        (0.075, 0.082, 0.088, 1.0),
        (0.96, 0.255, 0.018, 1.0),
        (0.20, 0.225, 0.24, 1.0),
        0.82,
        0.25,
        0.72,
        0.31,
        "factory-rivets",
    ),
)


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for datablock in list(datablocks):
            datablocks.remove(datablock)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.fps = 30
    scene.render.fps_base = 1.0


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifier(obj: bpy.types.Object, modifier: bpy.types.Modifier) -> None:
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def parent_keep_world(obj: bpy.types.Object, parent: bpy.types.Object) -> None:
    matrix_world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = matrix_world


def material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    metallic: float,
    roughness: float,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    result.diffuse_color = color
    result["authoringMetallic"] = metallic
    result["authoringRoughness"] = roughness
    result["emissiveApproved"] = bool(emission and emission_strength > 0.0)
    bsdf = result.node_tree.nodes.get("Principled BSDF")
    assert bsdf is not None
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.18 if metallic > 0.7 else 0.08
    if "Coat Roughness" in bsdf.inputs:
        bsdf.inputs["Coat Roughness"].default_value = min(roughness * 0.75, 0.22)
    emission_socket = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
    emission_strength_socket = bsdf.inputs.get("Emission Strength")
    if emission_socket is not None:
        emission_socket.default_value = emission or (0.0, 0.0, 0.0, 1.0)
    if emission_strength_socket is not None:
        emission_strength_socket.default_value = emission_strength
    return result


def generated_surface_texture(
    name: str,
    color: tuple[float, float, float, float],
    *,
    theme_seed: int,
    roughness: bool,
    size: int = PBR_TEXTURE_SIZE,
    image: bpy.types.Image | None = None,
) -> bpy.types.Image:
    """Create a compact, deterministic powder-coat/brushed-metal PBR map.

    The deliberately low-amplitude, directional pattern survives game-scale
    minification. Blender authors lossless PNG pixels; the final export keeps
    the full 192 px maps in embedded KTX2/BasisU inside a 520 KB runtime GLB.
    """
    image = image or bpy.data.images.new(name, width=size, height=size, alpha=True)
    if tuple(image.size) != (size, size):
        image.scale(size, size)
    image.file_format = "PNG"
    if roughness:
        image.colorspace_settings.name = "Non-Color"
    rng = random.Random(theme_seed + (9109 if roughness else 0))
    phase_a = rng.random() * math.tau
    phase_b = rng.random() * math.tau
    sparse_marks = {
        (rng.randrange(size), rng.randrange(size)): rng.uniform(-0.10, 0.10)
        for _ in range(34)
    }
    pixels: list[float] = []
    for y in range(size):
        v = y / max(size - 1, 1)
        for x in range(size):
            u = x / max(size - 1, 1)
            brushed = math.sin(v * math.tau * 21.0 + phase_a) * 0.055
            powder = math.sin((u * 7.0 + v * 5.0) * math.tau + phase_b) * 0.040
            powder += math.sin((u * 19.0 - v * 11.0) * math.tau + phase_a) * 0.025
            fleck = sparse_marks.get((x, y), 0.0)
            if roughness:
                value = min(max(0.46 + brushed * 1.9 + powder * 1.35 + fleck, 0.30), 0.66)
                pixels.extend((value, value, value, 1.0))
            else:
                multiplier = 1.0 + brushed + powder + fleck * 0.80
                powder_coat_relief = (brushed + powder) * 0.72
                pixels.extend(
                    (
                        min(max(color[0] * multiplier + powder_coat_relief, 0.0), 1.0),
                        min(max(color[1] * multiplier + powder_coat_relief, 0.0), 1.0),
                        min(max(color[2] * multiplier + powder_coat_relief, 0.0), 1.0),
                        1.0,
                    )
                )
    image.pixels.foreach_set(pixels)
    image.update()
    image.pack()
    image["embeddedRuntimePBR"] = True
    image["mapRole"] = "roughness" if roughness else "baseColor"
    return image


def textured_plate_material(theme: Theme) -> bpy.types.Material:
    prefix = theme.root_name.removesuffix("CornerMirror")
    result = material(
        f"M_{prefix}_CornerMirror_WallPlate_TexturedPBR",
        theme.plate_color,
        metallic=theme.plate_metallic,
        roughness=theme.plate_roughness,
    )
    result["embeddedTextureSet"] = f"{prefix}_WallPlate_{PBR_TEXTURE_SIZE}"
    nodes = result.node_tree.nodes
    links = result.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    assert bsdf is not None
    seed = 4171 + list(ROOT_NAMES).index(theme.root_name) * 733
    base_image = generated_surface_texture(
        f"T_{prefix}_WallPlate_BaseColor_{PBR_TEXTURE_SIZE}",
        theme.plate_color,
        theme_seed=seed,
        roughness=False,
    )
    roughness_image = generated_surface_texture(
        f"T_{prefix}_WallPlate_Roughness_{PBR_TEXTURE_SIZE}",
        theme.plate_color,
        theme_seed=seed,
        roughness=True,
    )
    base_texture = nodes.new("ShaderNodeTexImage")
    base_texture.name = f"T_{prefix}_WallPlate_BaseColor"
    base_texture.image = base_image
    base_texture.interpolation = "Linear"
    roughness_texture = nodes.new("ShaderNodeTexImage")
    roughness_texture.name = f"T_{prefix}_WallPlate_Roughness"
    roughness_texture.image = roughness_image
    roughness_texture.interpolation = "Linear"
    links.new(base_texture.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(roughness_texture.outputs["Color"], bsdf.inputs["Roughness"])
    return result


def make_materials() -> dict[str, bpy.types.Material]:
    materials = {
        "mirror": material(
            "M_CornerMirror_PolishedConvexMetal",
            (0.63, 0.72, 0.77, 1.0),
            metallic=0.90,
            roughness=0.10,
        ),
        "chrome": material(
            "M_CornerMirror_BrushedStainless",
            (0.30, 0.34, 0.37, 1.0),
            metallic=0.88,
            roughness=0.22,
        ),
        "rubber": material(
            "M_CornerMirror_Gasket",
            (0.008, 0.010, 0.012, 1.0),
            metallic=0.02,
            roughness=0.72,
        ),
        "led": material(
            "M_CornerMirror_StatusLED_ApprovedEmissive",
            (0.04, 0.30, 0.10, 1.0),
            metallic=0.05,
            roughness=0.19,
            emission=(0.025, 0.15, 0.045, 1.0),
            emission_strength=0.22,
        ),
    }
    for theme in THEMES:
        prefix = theme.root_name.removesuffix("CornerMirror")
        materials[f"{theme.key}:frame"] = material(
            f"M_{prefix}_CornerMirror_Frame",
            theme.frame_color,
            metallic=theme.frame_metallic,
            roughness=theme.frame_roughness,
        )
        materials[f"{theme.key}:plate"] = textured_plate_material(theme)
        materials[f"{theme.key}:accent"] = material(
            f"M_{prefix}_CornerMirror_ThemeAccent",
            theme.accent_color,
            metallic=0.54 if theme.key != "hospital" else 0.24,
            roughness=0.24 if theme.key != "hospital" else 0.30,
        )
        materials[f"{theme.key}:arm"] = material(
            f"M_{prefix}_CornerMirror_ArticulatedHardware",
            theme.arm_color,
            metallic=0.86,
            roughness=0.24,
        )
    return materials


def finish_mesh(
    obj: bpy.types.Object,
    assigned_material: bpy.types.Material,
    *,
    bevel: float = 0.0,
    bevel_segments: int = 3,
    smooth: bool = False,
) -> bpy.types.Object:
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0.0:
        modifier = obj.modifiers.new("ProductionEdgeRadius", "BEVEL")
        modifier.width = bevel
        modifier.segments = bevel_segments
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(28.0)
        try:
            modifier.harden_normals = True
        except Exception:
            pass
        apply_modifier(obj, modifier)
    obj.data.materials.clear()
    obj.data.materials.append(assigned_material)
    smart_uv(obj)
    for polygon in obj.data.polygons:
        polygon.use_smooth = smooth
    return obj


def smart_uv(obj: bpy.types.Object) -> None:
    if obj.type != "MESH" or not obj.data.polygons:
        return
    activate(obj)
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(58.0), island_margin=0.025)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")


def box(
    name: str,
    location: Vector | tuple[float, float, float],
    dimensions: tuple[float, float, float],
    assigned_material: bpy.types.Material,
    *,
    bevel: float = 0.008,
    bevel_segments: int = 3,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    return finish_mesh(
        obj,
        assigned_material,
        bevel=bevel,
        bevel_segments=bevel_segments,
        smooth=False,
    )


def cylinder_axis(
    name: str,
    center: Vector | tuple[float, float, float],
    radius: float,
    depth: float,
    axis: Vector | tuple[float, float, float],
    assigned_material: bpy.types.Material,
    *,
    vertices: int = 24,
    bevel: float = 0.002,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=center,
    )
    obj = bpy.context.object
    obj.name = name
    direction = Vector(axis).normalized()
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    obj.rotation_mode = "XYZ"
    return finish_mesh(obj, assigned_material, bevel=bevel, bevel_segments=2, smooth=True)


def cylinder_between(
    name: str,
    start: Vector,
    end: Vector,
    radius: float,
    assigned_material: bpy.types.Material,
    *,
    vertices: int = 24,
    bevel: float = 0.002,
) -> bpy.types.Object:
    delta = end - start
    return cylinder_axis(
        name,
        (start + end) * 0.5,
        radius,
        delta.length,
        delta,
        assigned_material,
        vertices=vertices,
        bevel=bevel,
    )


def uv_sphere(
    name: str,
    center: Vector | tuple[float, float, float],
    radius: float,
    assigned_material: bpy.types.Material,
    *,
    segments: int = 24,
    rings: int = 12,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments,
        ring_count=rings,
        radius=radius,
        location=center,
    )
    obj = bpy.context.object
    obj.name = name
    return finish_mesh(obj, assigned_material, smooth=True)


def torus_axis(
    name: str,
    center: Vector,
    major_radius: float,
    minor_radius: float,
    axis: Vector,
    assigned_material: bpy.types.Material,
    *,
    major_segments: int = 64,
    minor_segments: int = 12,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        align="WORLD",
        major_segments=major_segments,
        minor_segments=minor_segments,
        location=center,
        major_radius=major_radius,
        minor_radius=minor_radius,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector(axis).normalized().to_track_quat("Z", "Y")
    obj.rotation_mode = "XYZ"
    return finish_mesh(obj, assigned_material, smooth=True)


def convex_mirror_face(name: str, assigned_material: bpy.types.Material) -> bpy.types.Object:
    """Create a real spherical cap with a 680 mm optical aperture."""
    radial_segments = 64
    radial_rings = 10
    curvature_radius = 1.27
    edge_root = math.sqrt(curvature_radius**2 - MIRROR_RADIUS**2)
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []

    sag_center = curvature_radius - edge_root
    vertices.append((0.0, -sag_center, 0.0))
    for ring in range(1, radial_rings + 1):
        radius = MIRROR_RADIUS * ring / radial_rings
        sag = math.sqrt(curvature_radius**2 - radius**2) - edge_root
        for segment in range(radial_segments):
            theta = segment * math.tau / radial_segments
            vertices.append((radius * math.cos(theta), -sag, radius * math.sin(theta)))

    first_ring = 1
    for segment in range(radial_segments):
        next_segment = (segment + 1) % radial_segments
        faces.append((0, first_ring + segment, first_ring + next_segment))
    for ring in range(1, radial_rings):
        inner = 1 + (ring - 1) * radial_segments
        outer = 1 + ring * radial_segments
        for segment in range(radial_segments):
            next_segment = (segment + 1) % radial_segments
            faces.append(
                (
                    inner + segment,
                    outer + segment,
                    outer + next_segment,
                    inner + next_segment,
                )
            )

    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = MIRROR_CENTER
    obj.rotation_euler[0] = -MIRROR_TILT_RADIANS
    return finish_mesh(obj, assigned_material, smooth=True)


def join_role(
    theme: Theme,
    runtime_name: str,
    parts: list[bpy.types.Object],
    root: bpy.types.Object,
) -> bpy.types.Object:
    if not parts:
        raise RuntimeError(f"{theme.root_name}/{runtime_name} has no authored geometry")
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = f"{theme.root_name}__{runtime_name}"
    joined.data.name = f"{theme.root_name}__{runtime_name}__Mesh"
    joined["runtimeNodeName"] = runtime_name
    joined["assetPart"] = runtime_name
    joined["theme"] = theme.key
    joined["productionGeometry"] = True
    parent_keep_world(joined, root)
    return joined


def create_root(theme: Theme) -> bpy.types.Object:
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    root = bpy.context.object
    root.name = theme.root_name
    root.empty_display_size = 0.16
    root["assetRole"] = "stealth_corner_mirror"
    root["assetVersion"] = "StealthCornerMirror_v1"
    root["theme"] = theme.key
    root["unit"] = "meter"
    root["frontAxisGlTF"] = "+Z"
    root["frontAxisBlender"] = "-Y"
    root["mirrorDiameterMeters"] = MIRROR_DIAMETER
    root["mirrorCenterHeightMeters"] = MIRROR_CENTER.z
    root["mirrorTiltDegrees"] = MIRROR_TILT_DEGREES
    root["hasProductionGeometry"] = True
    root["hasRuntimePrimitiveFallback"] = False
    root["onlyStatusLedIsEmissive"] = True
    root["gltfpackVersion"] = GLTFPACK_VERSION
    root["gltfpackBinarySha256"] = GLTFPACK_BINARY_SHA256
    return root


def build_face(theme: Theme, mats: dict[str, bpy.types.Material], root: bpy.types.Object) -> None:
    face = convex_mirror_face(f"{theme.root_name}_ConvexOpticalSurface", mats["mirror"])
    face["opticalDiameterMeters"] = MIRROR_DIAMETER
    face["curvature"] = "spherical_convex"
    face["metallic"] = 0.90
    face["roughness"] = 0.10
    face["emissive"] = 0.0
    join_role(theme, "polished-corner-mirror-face", [face], root)


def build_rim(theme: Theme, mats: dict[str, bpy.types.Material], root: bpy.types.Object) -> None:
    frame = mats[f"{theme.key}:frame"]
    accent = mats[f"{theme.key}:accent"]
    rubber = mats["rubber"]
    parts: list[bpy.types.Object] = []

    # Deep rear shell gives a true manufactured profile rather than a flat ring.
    shell_center = MIRROR_CENTER - MIRROR_OUTWARD * 0.040
    shell = cylinder_axis(
        f"{theme.root_name}_RearShell",
        shell_center,
        0.398,
        0.064,
        MIRROR_OUTWARD,
        frame,
        vertices=64,
        bevel=0.009,
    )
    parts.append(shell)
    parts.append(
        torus_axis(
            f"{theme.root_name}_ThickProtectiveBezel",
            MIRROR_CENTER + MIRROR_OUTWARD * 0.003,
            0.374,
            0.047,
            MIRROR_OUTWARD,
            frame,
            major_segments=64,
            minor_segments=14,
        )
    )
    parts.append(
        torus_axis(
            f"{theme.root_name}_OpticalRubberGasket",
            MIRROR_CENTER + MIRROR_OUTWARD * 0.016,
            0.346,
            0.011,
            MIRROR_OUTWARD,
            rubber,
            major_segments=64,
            minor_segments=8,
        )
    )
    parts.append(
        torus_axis(
            f"{theme.root_name}_ThemeInlay",
            MIRROR_CENTER + MIRROR_OUTWARD * 0.047,
            0.375,
            0.009,
            MIRROR_OUTWARD,
            accent,
            major_segments=64,
            minor_segments=8,
        )
    )

    # Robust molded tabs are theme-coded and visibly change the silhouette.
    if theme.accent_style == "campus-badge":
        tab_angles = (math.radians(78), math.radians(258))
    elif theme.accent_style == "hospital-cross":
        tab_angles = tuple(math.radians(value) for value in (0, 90, 180, 270))
    elif theme.accent_style == "fire-hazard":
        tab_angles = tuple(math.radians(value) for value in (22, 68, 112, 158, 202, 248, 292, 338))
    else:
        tab_angles = tuple(math.radians(value) for value in (0, 45, 90, 135, 180, 225, 270, 315))
    for index, angle in enumerate(tab_angles):
        x_axis = math.cos(angle)
        z_axis = math.sin(angle)
        center = MIRROR_CENTER + Vector((x_axis * 0.376, 0.0, z_axis * 0.376))
        center += MIRROR_OUTWARD * 0.050
        tab = box(
            f"{theme.root_name}_BezelClamp_{index:02d}",
            center,
            (0.052 if theme.key != "fire-station" else 0.064, 0.028, 0.028),
            accent,
            bevel=0.006,
            bevel_segments=3,
        )
        tab.rotation_euler[1] = -angle
        parts.append(tab)
    rim = join_role(theme, "authored-corner-mirror-rim", parts, root)
    rim["frameEmissive"] = 0.0
    rim["protectiveBezelThicknessMeters"] = 0.094


def build_wall_plate(theme: Theme, mats: dict[str, bpy.types.Material], root: bpy.types.Object) -> None:
    plate = mats[f"{theme.key}:plate"]
    accent = mats[f"{theme.key}:accent"]
    parts = [
        box(
            f"{theme.root_name}_WallPlateBody",
            PLATE_CENTER,
            (0.245, 0.062, 0.355),
            plate,
            bevel=0.026,
            bevel_segments=5,
        ),
        box(
            f"{theme.root_name}_WallPlateRaisedSpine",
            PLATE_CENTER + Vector((0.0, -0.037, 0.0)),
            (0.112, 0.018, 0.265),
            accent,
            bevel=0.014,
            bevel_segments=4,
        ),
    ]
    if theme.accent_style == "hospital-cross":
        parts.extend(
            (
                box(
                    f"{theme.root_name}_HospitalCrossVertical",
                    PLATE_CENTER + Vector((0.0, -0.052, 0.0)),
                    (0.034, 0.012, 0.128),
                    accent,
                    bevel=0.007,
                    bevel_segments=3,
                ),
                box(
                    f"{theme.root_name}_HospitalCrossHorizontal",
                    PLATE_CENTER + Vector((0.0, -0.052, 0.0)),
                    (0.110, 0.012, 0.034),
                    accent,
                    bevel=0.007,
                    bevel_segments=3,
                ),
            )
        )
    elif theme.accent_style == "campus-badge":
        parts.extend(
            (
                box(
                    f"{theme.root_name}_CampusBadgeTop",
                    PLATE_CENTER + Vector((0.0, -0.052, 0.060)),
                    (0.086, 0.012, 0.026),
                    accent,
                    bevel=0.008,
                    bevel_segments=3,
                ),
                box(
                    f"{theme.root_name}_CampusBadgeBottom",
                    PLATE_CENTER + Vector((0.0, -0.052, 0.015)),
                    (0.062, 0.012, 0.021),
                    accent,
                    bevel=0.007,
                    bevel_segments=3,
                ),
            )
        )
    elif theme.accent_style == "fire-hazard":
        for index, x in enumerate((-0.062, 0.0, 0.062)):
            stripe = box(
                f"{theme.root_name}_FireReflectiveStripe_{index}",
                PLATE_CENTER + Vector((x, -0.052, 0.0)),
                (0.025, 0.012, 0.235),
                accent,
                bevel=0.005,
                bevel_segments=2,
            )
            stripe.rotation_euler[1] = math.radians(-11.0)
            parts.append(stripe)
    else:
        for index, z in enumerate((-0.086, 0.0, 0.086)):
            stripe = box(
                f"{theme.root_name}_FactoryHazardBar_{index}",
                PLATE_CENTER + Vector((0.0, -0.052, z)),
                (0.100, 0.012, 0.021),
                accent,
                bevel=0.004,
                bevel_segments=2,
            )
            stripe.rotation_euler[1] = math.radians(18.0)
            parts.append(stripe)
    wall_plate = join_role(theme, "corner-mirror-wall-plate", parts, root)
    wall_plate["wallPlaneBlender"] = "XZ"
    wall_plate["mountingCenterMeters"] = list(PLATE_CENTER)


def build_articulated_arm(
    theme: Theme,
    mats: dict[str, bpy.types.Material],
    root: bpy.types.Object,
) -> None:
    arm = mats[f"{theme.key}:arm"]
    accent = mats[f"{theme.key}:accent"]
    parts: list[bpy.types.Object] = []
    wall_joints = (
        Vector((0.0, -0.060, 1.655)),
        Vector((0.0, -0.060, 1.445)),
    )
    elbow_joints = (
        Vector((0.155, -0.185, 1.660)),
        Vector((0.155, -0.185, 1.440)),
    )
    head_joints = (
        Vector((0.235, -0.268, 1.655)),
        Vector((0.235, -0.268, 1.445)),
    )
    for index, (wall_joint, elbow_joint, head_joint) in enumerate(
        zip(wall_joints, elbow_joints, head_joints)
    ):
        parts.append(
            cylinder_between(
                f"{theme.root_name}_ArmPrimary_{index}",
                wall_joint,
                elbow_joint,
                0.025,
                arm,
                vertices=28,
                bevel=0.003,
            )
        )
        parts.append(
            cylinder_between(
                f"{theme.root_name}_ArmSecondary_{index}",
                elbow_joint,
                head_joint,
                0.025,
                arm,
                vertices=28,
                bevel=0.003,
            )
        )
        for joint_index, joint in enumerate((wall_joint, elbow_joint, head_joint)):
            parts.append(
                uv_sphere(
                    f"{theme.root_name}_UniversalJoint_{index}_{joint_index}",
                    joint,
                    0.043 if joint_index == 1 else 0.038,
                    accent if joint_index == 1 else arm,
                    segments=24,
                    rings=12,
                )
            )
            parts.append(
                cylinder_axis(
                    f"{theme.root_name}_GimbalPin_{index}_{joint_index}",
                    joint,
                    0.018,
                    0.082,
                    Vector((1.0, 0.0, 0.0)),
                    arm,
                    vertices=20,
                    bevel=0.002,
                )
            )
    # Cross-head yoke and wall pivot together provide two independent axes.
    parts.extend(
        (
            cylinder_between(
                f"{theme.root_name}_MirrorHeadYoke",
                head_joints[1],
                head_joints[0],
                0.020,
                arm,
                vertices=28,
                bevel=0.003,
            ),
            cylinder_axis(
                f"{theme.root_name}_WallVerticalPivot",
                Vector((0.0, -0.058, 1.55)),
                0.024,
                0.255,
                Vector((0.0, 0.0, 1.0)),
                arm,
                vertices=28,
                bevel=0.003,
            ),
        )
    )
    articulated = join_role(theme, "corner-mirror-articulated-arm", parts, root)
    articulated["jointType"] = "dual-arm_two-axis_universal"
    articulated["articulatedArmCount"] = 2


def build_fasteners(theme: Theme, mats: dict[str, bpy.types.Material], root: bpy.types.Object) -> None:
    chrome = mats["chrome"]
    accent = mats[f"{theme.key}:accent"]
    parts: list[bpy.types.Object] = []
    outward_axis = Vector((0.0, -1.0, 0.0))
    for index, (x, z) in enumerate(
        (
            (-0.078, 1.675),
            (0.078, 1.675),
            (-0.078, 1.425),
            (0.078, 1.425),
        )
    ):
        parts.extend(
            (
                cylinder_axis(
                    f"{theme.root_name}_WallWasher_{index}",
                    Vector((x, -0.038, z)),
                    0.018,
                    0.007,
                    outward_axis,
                    chrome,
                    vertices=20,
                    bevel=0.001,
                ),
                cylinder_axis(
                    f"{theme.root_name}_WallBolt_{index}",
                    Vector((x, -0.045, z)),
                    0.010,
                    0.014,
                    outward_axis,
                    chrome,
                    vertices=12,
                    bevel=0.0015,
                ),
            )
        )
    for index, center in enumerate(
        (
            Vector((0.155, -0.185, 1.660)),
            Vector((0.155, -0.185, 1.440)),
        )
    ):
        parts.append(
            cylinder_axis(
                f"{theme.root_name}_StarLockKnob_{index}",
                center + Vector((-0.055, 0.0, 0.0)),
                0.037,
                0.025,
                Vector((1.0, 0.0, 0.0)),
                accent,
                vertices=12,
                bevel=0.004,
            )
        )
        parts.append(
            cylinder_axis(
                f"{theme.root_name}_LockKnobCap_{index}",
                center + Vector((-0.071, 0.0, 0.0)),
                0.016,
                0.008,
                Vector((1.0, 0.0, 0.0)),
                chrome,
                vertices=20,
                bevel=0.002,
            )
        )
    # Four bezel screws sit on the same tilted optical plane.
    tangent_x = Vector((1.0, 0.0, 0.0))
    tangent_z = MIRROR_OUTWARD.cross(tangent_x).normalized()
    for index, angle in enumerate(tuple(math.radians(value) for value in (45, 135, 225, 315))):
        radial = tangent_x * math.cos(angle) + tangent_z * math.sin(angle)
        center = MIRROR_CENTER + radial * 0.374 + MIRROR_OUTWARD * 0.054
        parts.append(
            cylinder_axis(
                f"{theme.root_name}_BezelFastener_{index}",
                center,
                0.009,
                0.012,
                MIRROR_OUTWARD,
                chrome,
                vertices=12,
                bevel=0.0015,
            )
        )
    fasteners = join_role(theme, "corner-mirror-fasteners", parts, root)
    fasteners["fastenerCount"] = len(parts)
    fasteners["includesWashers"] = True
    fasteners["includesLockKnobs"] = True


def build_led(theme: Theme, mats: dict[str, bpy.types.Material], root: bpy.types.Object) -> None:
    led_center = Vector((0.085, -0.052, 1.395))
    parts = [
        cylinder_axis(
            f"{theme.root_name}_StatusLEDLens",
            led_center,
            0.012,
            0.008,
            Vector((0.0, -1.0, 0.0)),
            mats["led"],
            vertices=24,
            bevel=0.002,
        )
    ]
    led = join_role(theme, "corner-mirror-status-led", parts, root)
    led["approvedEmissive"] = True
    led["emissionStrength"] = 0.22
    led["diameterMeters"] = 0.024


def build_theme(theme: Theme, mats: dict[str, bpy.types.Material]) -> bpy.types.Object:
    root = create_root(theme)
    build_face(theme, mats, root)
    build_rim(theme, mats, root)
    build_wall_plate(theme, mats, root)
    build_articulated_arm(theme, mats, root)
    build_fasteners(theme, mats, root)
    build_led(theme, mats, root)
    return root


def descendants(root: bpy.types.Object) -> list[bpy.types.Object]:
    result = [root]
    stack = list(root.children)
    while stack:
        child = stack.pop()
        result.append(child)
        stack.extend(child.children)
    return result


def inspect_authored_scene(roots: list[bpy.types.Object]) -> dict:
    mesh_objects: list[bpy.types.Object] = []
    material_names: set[str] = set()
    vertex_count = 0
    triangle_count = 0
    theme_reports = []
    for root in roots:
        children = descendants(root)[1:]
        roles = {
            child.get("runtimeNodeName")
            for child in children
            if child.type == "MESH"
        }
        missing = sorted(set(RUNTIME_MESH_NAMES) - roles)
        if missing:
            raise RuntimeError(f"{root.name} is missing runtime meshes: {missing}")
        if len([child for child in children if child.type == "MESH"]) != len(RUNTIME_MESH_NAMES):
            raise RuntimeError(f"{root.name} must contain exactly six consolidated production meshes")
        for child in children:
            if child.type != "MESH":
                continue
            mesh_objects.append(child)
            vertex_count += len(child.data.vertices)
            triangle_count += sum(max(len(poly.vertices) - 2, 1) for poly in child.data.polygons)
            material_names.update(material.name for material in child.data.materials)
        theme_reports.append(
            {
                "root": root.name,
                "theme": root["theme"],
                "meshRoles": sorted(roles),
                "meshCount": len([child for child in children if child.type == "MESH"]),
            }
        )

    non_led_emissive = []
    approved_emissive = []
    for assigned_material in bpy.data.materials:
        if not assigned_material.use_nodes:
            continue
        bsdf = assigned_material.node_tree.nodes.get("Principled BSDF")
        if bsdf is None:
            continue
        socket = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        strength_socket = bsdf.inputs.get("Emission Strength")
        color = tuple(socket.default_value[:3]) if socket is not None else (0.0, 0.0, 0.0)
        strength = float(strength_socket.default_value) if strength_socket is not None else 0.0
        is_emissive = strength > 0.0 and max(color) > 0.0
        if is_emissive and assigned_material.get("emissiveApproved"):
            approved_emissive.append(assigned_material.name)
        elif is_emissive:
            non_led_emissive.append(assigned_material.name)
    if non_led_emissive:
        raise RuntimeError(f"Unapproved emissive materials: {non_led_emissive}")
    if approved_emissive != ["M_CornerMirror_StatusLED_ApprovedEmissive"]:
        raise RuntimeError(f"Unexpected emissive whitelist: {approved_emissive}")

    textured_materials = sorted(
        assigned_material.name
        for assigned_material in bpy.data.materials
        if assigned_material.use_nodes
        and any(node.type == "TEX_IMAGE" and node.image is not None for node in assigned_material.node_tree.nodes)
    )
    expected_textured = {
        f"M_{theme.root_name.removesuffix('CornerMirror')}_CornerMirror_WallPlate_TexturedPBR"
        for theme in THEMES
    }
    missing_textured = sorted(expected_textured - set(textured_materials))
    if missing_textured:
        raise RuntimeError(f"Each theme needs an embedded textured PBR material: {missing_textured}")

    mirror_material = bpy.data.materials["M_CornerMirror_PolishedConvexMetal"]
    if abs(float(mirror_material["authoringMetallic"]) - 0.90) > 1e-6:
        raise RuntimeError("Mirror metallic must be exactly 0.90")
    if abs(float(mirror_material["authoringRoughness"]) - 0.10) > 1e-6:
        raise RuntimeError("Mirror roughness must be exactly 0.10")

    return {
        "rootCount": len(roots),
        "meshCount": len(mesh_objects),
        "materialCount": len(material_names),
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "mirrorDiameterMeters": MIRROR_DIAMETER,
        "mirrorCenterHeightMeters": MIRROR_CENTER.z,
        "mirrorTiltDegrees": MIRROR_TILT_DEGREES,
        "embeddedPbrTextureResolution": PBR_TEXTURE_SIZE,
        "frontAxisGlTF": "+Z",
        "approvedEmissiveMaterials": approved_emissive,
        "texturedMaterialCount": len(textured_materials),
        "texturedMaterials": textured_materials,
        "themes": theme_reports,
    }


def glb_document(path: Path) -> tuple[dict, int, int]:
    payload = path.read_bytes()
    if payload[:4] != b"glTF" or struct.unpack_from("<I", payload, 4)[0] != 2:
        raise RuntimeError(f"Not a glTF 2.0 binary: {path}")
    offset = 12
    while offset + 8 <= len(payload):
        chunk_length, chunk_type = struct.unpack_from("<II", payload, offset)
        data_start = offset + 8
        if chunk_type == 0x4E4F534A:
            document = json.loads(
                payload[data_start : data_start + chunk_length].decode("utf-8").rstrip(" \0")
            )
            return document, data_start, chunk_length
        offset = data_start + chunk_length
    raise RuntimeError(f"Missing GLB JSON chunk: {path}")


def embedded_texture_dimensions(path: Path, document: dict) -> list[tuple[int, int]]:
    payload = path.read_bytes()
    binary_start = None
    offset = 12
    while offset + 8 <= len(payload):
        chunk_length, chunk_type = struct.unpack_from("<II", payload, offset)
        data_start = offset + 8
        if chunk_type == 0x004E4942:
            binary_start = data_start
            break
        offset = data_start + chunk_length
    if binary_start is None:
        raise RuntimeError("Corner-mirror GLB has no binary chunk")
    dimensions = []
    for image in document.get("images", []):
        view = document["bufferViews"][image["bufferView"]]
        image_start = binary_start + int(view.get("byteOffset", 0))
        image_payload = payload[image_start:]
        if image_payload[:8] == b"\x89PNG\r\n\x1a\n":
            width, height = struct.unpack_from(">II", image_payload, 16)
        elif image_payload[:12] == b"\xABKTX 20\xBB\r\n\x1A\n":
            width, height = struct.unpack_from("<II", image_payload, 20)
        else:
            raise RuntimeError(f"Embedded PBR image is neither PNG nor KTX2: {image.get('name')}")
        dimensions.append((width, height))
    return dimensions


def resolve_native_gltfpack() -> Path:
    rejected_hashes = []
    for candidate in GLTFPACK_CANDIDATES:
        if not candidate:
            continue
        executable = Path(candidate).expanduser().resolve()
        if not executable.is_file():
            continue
        completed = subprocess.run(
            [str(executable), "-v"],
            cwd=ROOT,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if completed.returncode != 0 or completed.stdout.strip() != GLTFPACK_VERSION:
            continue
        binary_sha256 = hashlib.sha256(executable.read_bytes()).hexdigest()
        if binary_sha256 != GLTFPACK_BINARY_SHA256:
            rejected_hashes.append(f"{executable}={binary_sha256}")
            continue
        return executable
    mismatch = f" Rejected unpinned binaries: {', '.join(rejected_hashes)}." if rejected_hashes else ""
    raise FileNotFoundError(
        "The pinned official native gltfpack 1.2 binary with BasisU is "
        "required. Set GLTFPACK_KTX2 or install it at "
        f"/private/tmp/gltfpack-macos-v1.2/gltfpack.{mismatch}"
    )


def enforce_runtime_node_names(path: Path) -> None:
    payload = bytearray(path.read_bytes())
    document, json_start, json_length = glb_document(path)
    rewritten = 0
    for node in document.get("nodes", []):
        runtime_name = node.get("extras", {}).get("runtimeNodeName")
        if runtime_name:
            node["name"] = runtime_name
            rewritten += 1
    if rewritten != len(THEMES) * len(RUNTIME_MESH_NAMES):
        raise RuntimeError(f"Expected 24 runtime mesh names, rewrote {rewritten}")
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > json_length:
        raise RuntimeError("Runtime node-name rewrite outgrew the GLB JSON chunk")
    payload[json_start : json_start + json_length] = encoded + b" " * (json_length - len(encoded))
    path.write_bytes(payload)


def audit_glb(path: Path, authored_report: dict) -> dict:
    document, _, _ = glb_document(path)
    nodes = document.get("nodes", [])
    names = [node.get("name") for node in nodes]
    missing_roots = sorted(set(ROOT_NAMES) - set(names))
    if missing_roots:
        raise RuntimeError(f"Runtime GLB lost theme roots: {missing_roots}")
    role_counts = {name: names.count(name) for name in RUNTIME_MESH_NAMES}
    invalid_counts = {name: count for name, count in role_counts.items() if count != len(THEMES)}
    if invalid_counts:
        raise RuntimeError(f"Runtime role nodes must occur once per theme: {invalid_counts}")
    hierarchy_report = {}
    for root_name in ROOT_NAMES:
        root_index = names.index(root_name)
        stack = list(nodes[root_index].get("children", []))
        descendants_names: list[str] = []
        while stack:
            node_index = stack.pop()
            node = nodes[node_index]
            descendants_names.append(node.get("name", ""))
            stack.extend(node.get("children", []))
        descendant_roles = sorted(set(descendants_names) & set(RUNTIME_MESH_NAMES))
        if descendant_roles != sorted(RUNTIME_MESH_NAMES):
            raise RuntimeError(
                f"{root_name} does not own all six runtime mesh roles: {descendant_roles}"
            )
        extras = nodes[root_index].get("extras", {})
        if extras.get("frontAxisGlTF") != "+Z":
            raise RuntimeError(f"{root_name} lost its +Z runtime-facing contract")
        hierarchy_report[root_name] = descendant_roles
    if path.stat().st_size > 520_000:
        raise RuntimeError(f"Runtime GLB exceeds its 520 KB first-playable budget: {path.stat().st_size}")
    required_extensions = set(document.get("extensionsRequired", []))
    for required_extension in (
        "EXT_meshopt_compression",
        "KHR_mesh_quantization",
        "KHR_texture_basisu",
    ):
        if required_extension not in required_extensions:
            raise RuntimeError(f"Runtime GLB lost required extension: {required_extension}")

    materials = document.get("materials", [])
    emissive_materials = []
    for entry in materials:
        factor = entry.get("emissiveFactor", [0.0, 0.0, 0.0])
        if max(factor) > 0.0:
            emissive_materials.append(entry.get("name"))
    expected_led = "M_CornerMirror_StatusLED_ApprovedEmissive"
    if emissive_materials != [expected_led]:
        raise RuntimeError(f"Only the LED may be emissive in GLB: {emissive_materials}")

    mirror = next(
        (entry for entry in materials if entry.get("name") == "M_CornerMirror_PolishedConvexMetal"),
        None,
    )
    if mirror is None:
        raise RuntimeError("Runtime GLB lost the polished mirror material")
    pbr = mirror.get("pbrMetallicRoughness", {})
    if abs(float(pbr.get("metallicFactor", -1.0)) - 0.90) > 0.01:
        raise RuntimeError(f"Runtime mirror metallic drifted: {pbr.get('metallicFactor')}")
    if abs(float(pbr.get("roughnessFactor", -1.0)) - 0.10) > 0.01:
        raise RuntimeError(f"Runtime mirror roughness drifted: {pbr.get('roughnessFactor')}")

    expected_textured = {
        f"M_{theme.root_name.removesuffix('CornerMirror')}_CornerMirror_WallPlate_TexturedPBR"
        for theme in THEMES
    }
    textured_materials = {
        entry.get("name")
        for entry in materials
        if entry.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        and entry.get("pbrMetallicRoughness", {}).get("metallicRoughnessTexture")
    }
    missing_textured = sorted(expected_textured - textured_materials)
    if missing_textured:
        raise RuntimeError(f"GLB lost per-theme embedded PBR maps: {missing_textured}")
    images = document.get("images", [])
    if len(images) < len(THEMES) * 2:
        raise RuntimeError(f"Expected at least eight embedded PBR images, found {len(images)}")
    if any(image.get("uri") or image.get("bufferView") is None for image in images):
        raise RuntimeError("Corner-mirror PBR images must be embedded in the GLB")
    image_dimensions = embedded_texture_dimensions(path, document)
    expected_dimensions = (PBR_TEXTURE_SIZE, PBR_TEXTURE_SIZE)
    if any(dimensions != expected_dimensions for dimensions in image_dimensions):
        raise RuntimeError(
            f"Embedded PBR images must all be {expected_dimensions}: {image_dimensions}"
        )

    primitive_count = sum(len(mesh.get("primitives", [])) for mesh in document.get("meshes", []))
    position_vertices = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor_index = primitive.get("attributes", {}).get("POSITION")
            if accessor_index is not None:
                position_vertices += int(document["accessors"][accessor_index]["count"])
    return {
        **authored_report,
        "glbBytes": path.stat().st_size,
        "glbNodeCount": len(nodes),
        "glbMeshCount": len(document.get("meshes", [])),
        "glbPrimitiveCount": primitive_count,
        "glbMaterialCount": len(materials),
        "glbPositionVertexCount": position_vertices,
        "glbImageCount": len(images),
        "glbImageDimensions": image_dimensions,
        "glbTexturedMaterialCount": len(textured_materials),
        "glbTexturedMaterials": sorted(textured_materials),
        "runtimeRoleCounts": role_counts,
        "runtimeThemeHierarchy": hierarchy_report,
        "extensionsRequired": document.get("extensionsRequired", []),
        "glbEmissiveMaterials": emissive_materials,
    }


def save_and_export(
    roots: list[bpy.types.Object],
    authored_report: dict,
    *,
    save_master: bool = True,
) -> dict:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    GLB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if save_master:
        bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)
    with tempfile.NamedTemporaryFile(
        prefix=".stealth-corner-mirrors-uncompressed-",
        suffix=".glb",
        dir=GLB_PATH.parent,
        delete=False,
    ) as uncompressed_file:
        uncompressed_path = Path(uncompressed_file.name)
    with tempfile.NamedTemporaryFile(
        prefix=".stealth-corner-mirrors-meshopt-",
        suffix=".glb",
        dir=GLB_PATH.parent,
        delete=False,
    ) as compressed_file:
        compressed_path = Path(compressed_file.name)
    try:
        bpy.ops.object.select_all(action="DESELECT")
        for root in roots:
            for obj in descendants(root):
                obj.select_set(True)
        bpy.context.view_layer.objects.active = roots[0]
        bpy.ops.export_scene.gltf(
            filepath=str(uncompressed_path),
            export_format="GLB",
            use_selection=True,
            export_yup=True,
            export_texcoords=True,
            export_normals=True,
            export_tangents=False,
            export_materials="EXPORT",
            export_animations=False,
            export_extras=True,
            export_cameras=False,
            export_lights=False,
            export_image_format="AUTO",
        )
        gltfpack = resolve_native_gltfpack()
        command = [
            str(gltfpack),
            "-i",
            str(uncompressed_path),
            "-o",
            str(compressed_path),
            *GLTFPACK_ARGUMENTS,
        ]
        completed = subprocess.run(
            command,
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if completed.stdout.strip():
            print(completed.stdout.strip())
        enforce_runtime_node_names(compressed_path)
        runtime_report = audit_glb(compressed_path, authored_report)
        os.replace(compressed_path, GLB_PATH)
        GLB_PATH.chmod(0o644)
    finally:
        uncompressed_path.unlink(missing_ok=True)
        compressed_path.unlink(missing_ok=True)
    return runtime_report


def look_at(obj: bpy.types.Object, target: Vector | tuple[float, float, float]) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_review_scene(mats: dict[str, bpy.types.Material]) -> bpy.types.Object:
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 920
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    if background is not None:
        background.inputs["Color"].default_value = (0.010, 0.014, 0.022, 1.0)
        background.inputs["Strength"].default_value = 0.18

    review_wall_material = material(
        "M_ReviewWall",
        (0.15, 0.18, 0.22, 1.0),
        metallic=0.02,
        roughness=0.67,
    )
    review_floor_material = material(
        "M_ReviewFloor",
        (0.025, 0.030, 0.038, 1.0),
        metallic=0.12,
        roughness=0.40,
    )
    wall = box(
        "ReviewWall",
        (0.0, 0.105, 1.45),
        (12.0, 0.12, 3.20),
        review_wall_material,
        bevel=0.018,
        bevel_segments=3,
    )
    wall["reviewOnly"] = True
    floor = box(
        "ReviewFloor",
        (0.0, -1.60, -0.045),
        (12.0, 5.0, 0.09),
        review_floor_material,
        bevel=0.018,
        bevel_segments=3,
    )
    floor["reviewOnly"] = True

    lights = (
        ("Review_Key", (2.7, -3.8, 3.8), 760.0, 3.0, (1.0, 0.82, 0.66)),
        ("Review_Fill", (-3.2, -2.2, 2.3), 460.0, 3.2, (0.46, 0.68, 1.0)),
        ("Review_Rim", (2.0, 0.1, 3.0), 680.0, 2.5, (0.35, 0.56, 1.0)),
        ("Review_Softbox", (-0.2, -1.0, 4.8), 520.0, 2.8, (1.0, 0.97, 0.88)),
    )
    for name, location, energy, size, color in lights:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        look_at(light, (0.25, -0.25, 1.45))

    bpy.ops.object.camera_add(location=(2.6, -4.3, 2.45))
    camera = bpy.context.object
    camera.name = "ReviewCamera"
    camera.data.lens = 62
    camera.data.sensor_width = 36
    look_at(camera, (0.22, -0.23, 1.46))
    scene.camera = camera
    return camera


def render_reviews(roots: list[bpy.types.Object], mats: dict[str, bpy.types.Material]) -> list[str]:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    for old_file in REVIEW_DIR.glob("*.png"):
        old_file.unlink()
    camera = setup_review_scene(mats)
    rendered: list[str] = []

    for root in roots:
        for candidate in roots:
            for obj in descendants(candidate):
                obj.hide_render = candidate is not root
            candidate.location = (0.0, 0.0, 0.0)
        theme = root["theme"]
        shots = (
            (
                f"{theme}-hero-three-quarter.png",
                Vector((2.35, -4.0, 2.35)),
                Vector((0.22, -0.24, 1.49)),
                64,
            ),
            (
                f"{theme}-bracket-profile.png",
                Vector((-2.15, -2.65, 1.95)),
                Vector((0.12, -0.18, 1.54)),
                70,
            ),
        )
        for filename, camera_position, target, lens in shots:
            camera.location = camera_position
            camera.data.lens = lens
            look_at(camera, target)
            bpy.context.scene.render.filepath = str(REVIEW_DIR / filename)
            bpy.ops.render.render(write_still=True)
            rendered.append(filename)

    for candidate, x in zip(roots, (-1.62, -0.54, 0.54, 1.62)):
        for obj in descendants(candidate):
            obj.hide_render = False
        candidate.location = (x, 0.0, 0.0)
    camera.location = (0.4, -7.6, 2.55)
    camera.data.lens = 58
    look_at(camera, (0.15, -0.18, 1.43))
    lineup_name = "all-themes-production-lineup.png"
    bpy.context.scene.render.filepath = str(REVIEW_DIR / lineup_name)
    bpy.ops.render.render(write_still=True)
    rendered.append(lineup_name)

    for root in roots:
        root.location = (0.0, 0.0, 0.0)
        for obj in descendants(root):
            obj.hide_render = False
    return rendered


def main() -> None:
    # Deterministic generated masters must not leave large .blend1 backups.
    bpy.context.preferences.filepaths.save_version = 0
    export_existing = os.environ.get("CHASING_MIRROR_EXPORT_EXISTING") == "1"
    if export_existing:
        if not BLEND_PATH.is_file():
            raise FileNotFoundError(f"Approved mirror master is missing: {BLEND_PATH}")
        bpy.ops.wm.open_mainfile(filepath=str(BLEND_PATH))
        roots = [bpy.data.objects.get(name) for name in ROOT_NAMES]
        if any(root is None for root in roots):
            raise RuntimeError("Approved mirror master lost one or more themed roots")
        if os.environ.get("CHASING_MIRROR_REFRESH_TEXTURES") == "1":
            for index, theme in enumerate(THEMES):
                prefix = theme.root_name.removesuffix("CornerMirror")
                seed = 4171 + index * 733
                for suffix, roughness in (("BaseColor", False), ("Roughness", True)):
                    name = f"T_{prefix}_WallPlate_{suffix}_{PBR_TEXTURE_SIZE}"
                    image = bpy.data.images.get(name)
                    if image is None:
                        raise RuntimeError(f"Approved mirror master lost {name}")
                    generated_surface_texture(
                        name,
                        theme.plate_color,
                        theme_seed=seed,
                        roughness=roughness,
                        image=image,
                    )
        authored_report = inspect_authored_scene(roots)
        runtime_report = save_and_export(roots, authored_report, save_master=False)
        preview_files = []
        previews_regenerated = False
    else:
        reset_scene()
        mats = make_materials()
        roots = [build_theme(theme, mats) for theme in THEMES]
        authored_report = inspect_authored_scene(roots)
        runtime_report = save_and_export(roots, authored_report)
        preview_files = render_reviews(roots, mats)
        previews_regenerated = True
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    report = {
        **runtime_report,
        "tool": {
            "name": "gltfpack",
            "version": GLTFPACK_VERSION,
            "binarySha256": GLTFPACK_BINARY_SHA256,
            "arguments": list(GLTFPACK_ARGUMENTS),
        },
        "blendPath": str(BLEND_PATH),
        "glbPath": str(GLB_PATH),
        "reviewDirectory": str(REVIEW_DIR),
        "previewFiles": preview_files,
        "previewsRegenerated": previews_regenerated,
    }
    (REVIEW_DIR / "asset-audit.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print("STEALTH_CORNER_MIRROR_AUDIT=" + json.dumps(report, ensure_ascii=False))
    print(f"STEALTH_CORNER_MIRROR_BLEND={BLEND_PATH}")
    print(f"STEALTH_CORNER_MIRROR_GLB={GLB_PATH}")
    print(f"STEALTH_CORNER_MIRROR_GLB_BYTES={GLB_PATH.stat().st_size}")
    print(f"STEALTH_CORNER_MIRROR_REVIEWS={REVIEW_DIR}")


if __name__ == "__main__":
    main()
