"""Build the compact, engine-neutral environment kits used by the Web campaign.

Run with:
  blender --background --python scripts/build-theme-kits.py

The source master is saved as one .blend while each theme is exported as a
small GLB containing named, independently cloneable props.  The kits reuse the
project's compact 512px BaseColor/Normal/ORM library, embedded once per GLB, so
walls and hero props retain full glTF PBR surface variation without extra
runtime requests.
"""

from __future__ import annotations

import math
from pathlib import Path
import subprocess

import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "models" / "environment" / "themes"
MASTER = ROOT / "art-source" / "Environment" / "ThemeKits" / "Chasing_Theme_Environment_Kits.blend"
SHARED_TEXTURES = ROOT / "public" / "models" / "SharedTextures"
ORM_TEXTURES = ROOT / "work" / "art_pipeline" / "environment-orm"
ORM_GENERATOR = ROOT / "tools" / "art_pipeline" / "generate_environment_runtime_orm.mjs"
GLTFPACK = ROOT / "node_modules" / ".bin" / "gltfpack"


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.materials:
        bpy.data.materials.remove(block)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)


def material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    metallic: float = 0.0,
    roughness: float = 0.48,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
    alpha_blend: bool = False,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Alpha"].default_value = color[3]
    if emission:
        emission_input = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
        if emission_input:
            emission_input.default_value = emission
        strength_input = shader.inputs.get("Emission Strength")
        if strength_input:
            strength_input.default_value = emission_strength
    if alpha_blend:
        mat.surface_render_method = "DITHERED"
        mat.use_transparency_overlap = False
    return mat


def ensure_gltf_occlusion_group() -> bpy.types.NodeTree:
    """Create the exporter-recognized, non-rendering glTF occlusion socket."""
    group = bpy.data.node_groups.get("glTF Material Output")
    if group is None:
        group = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    if "Occlusion" not in group.interface.items_tree:
        group.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketColor")
    return group


def attach_texture_pair(
    mat: bpy.types.Material,
    texture_stem: str,
    *,
    normal_strength: float = 0.72,
    use_base_color: bool = True,
) -> None:
    """Attach an export-safe BaseColor/Normal/ORM set from the shared library."""
    base_path = SHARED_TEXTURES / f"{texture_stem}_BaseColor_2K.png"
    normal_path = SHARED_TEXTURES / f"{texture_stem}_Normal_2K.png"
    orm_path = ORM_TEXTURES / f"{texture_stem}_ORM_512.png"
    if not base_path.is_file() or not normal_path.is_file() or not orm_path.is_file():
        raise FileNotFoundError(f"Missing shared PBR set for {texture_stem}")

    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    shader = nodes.get("Principled BSDF")
    if use_base_color:
        base_image = bpy.data.images.load(str(base_path), check_existing=True)
        base_image.colorspace_settings.name = "sRGB"
        base_node = nodes.new("ShaderNodeTexImage")
        base_node.name = f"{texture_stem}_BaseColor"
        base_node.label = "Shared 512px PBR base color"
        base_node.image = base_image
        links.new(base_node.outputs["Color"], shader.inputs["Base Color"])

    normal_image = bpy.data.images.load(str(normal_path), check_existing=True)
    normal_image.colorspace_settings.name = "Non-Color"
    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.name = f"{texture_stem}_Normal"
    normal_node.label = "Shared 512px OpenGL normal"
    normal_node.image = normal_image
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = normal_strength
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])

    orm_image = bpy.data.images.load(str(orm_path), check_existing=True)
    orm_image.colorspace_settings.name = "Non-Color"
    orm_node = nodes.new("ShaderNodeTexImage")
    orm_node.name = f"{texture_stem}_ORM"
    orm_node.label = "glTF ORM: AO / roughness / metallic"
    orm_node.image = orm_image
    separate = nodes.new("ShaderNodeSeparateColor")
    separate.mode = "RGB"
    links.new(orm_node.outputs["Color"], separate.inputs["Color"])
    # Factors remain at one so the packed physical response is not attenuated
    # a second time in glTF. Surface-family differentiation lives in the ORM.
    shader.inputs["Roughness"].default_value = 1.0
    shader.inputs["Metallic"].default_value = 1.0
    links.new(separate.outputs["Green"], shader.inputs["Roughness"])
    links.new(separate.outputs["Blue"], shader.inputs["Metallic"])
    gltf_output = nodes.new("ShaderNodeGroup")
    gltf_output.name = "glTF Material Output"
    gltf_output.node_tree = ensure_gltf_occlusion_group()
    links.new(orm_node.outputs["Color"], gltf_output.inputs["Occlusion"])


def theme_collection(name: str) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def link_to_collection(obj: bpy.types.Object, collection: bpy.types.Collection) -> None:
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)


def root(name: str, collection: bpy.types.Collection, x: float) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "CUBE"
    obj.empty_display_size = 0.35
    obj.location.x = x
    collection.objects.link(obj)
    return obj


def parent(obj: bpy.types.Object, owner: bpy.types.Object) -> bpy.types.Object:
    obj.parent = owner
    obj.matrix_parent_inverse = owner.matrix_world.inverted()
    return obj


def box(
    name: str,
    size: tuple[float, float, float],
    location: tuple[float, float, float],
    mat: bpy.types.Material,
    owner: bpy.types.Object,
    *,
    bevel: float = 0.045,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    # Micro decals, seams and warning strips are already sub-pixel at the game
    # camera. Beveling their paper-thin edge multiplies vertices without
    # changing the image, so only construction-scale pieces receive a chamfer.
    if bevel > 0 and min(size) >= .04 and bevel >= .009:
        mod = obj.modifiers.new("Soft industrial edges", "BEVEL")
        mod.width = min(bevel, min(size) * 0.22)
        # Campaign story vignettes appear in groups and therefore use a
        # two-segment production chamfer.  At gameplay distance it preserves
        # the same highlight roll while keeping all ten authored chapters
        # inside the Web mesh budget.
        mod.segments = 2 if owner.get("chasing_prop_set") else (3 if bevel >= .035 and min(size) >= .18 else 2)
    obj.data.materials.append(mat)
    link_to_collection(obj, owner.users_collection[0])
    return parent(obj, owner)


def cylinder(
    name: str,
    radius: float,
    depth: float,
    location: tuple[float, float, float],
    mat: bpy.types.Material,
    owner: bpy.types.Object,
    *,
    rotation: tuple[float, float, float] = (0, 0, 0),
    vertices: int = 32,
    bevel: float = 0.025,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    if bevel and bevel >= .009:
        mod = obj.modifiers.new("Machined edge", "BEVEL")
        mod.width = min(bevel, radius * 0.16, depth * 0.12)
        mod.segments = 2 if owner.get("chasing_prop_set") else (3 if radius >= .2 else 2)
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = polygon.normal.z < 0.95
    link_to_collection(obj, owner.users_collection[0])
    return parent(obj, owner)


def sphere(
    name: str,
    radius: float,
    location: tuple[float, float, float],
    mat: bpy.types.Material,
    owner: bpy.types.Object,
    scale: tuple[float, float, float] = (1, 1, 1),
) -> bpy.types.Object:
    # A 24x14 sphere remains perfectly smooth in the elevated gameplay camera
    # while keeping the triangle budget available for silhouette and dressing.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=14, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    link_to_collection(obj, owner.users_collection[0])
    return parent(obj, owner)


def torus(
    name: str,
    major: float,
    minor: float,
    location: tuple[float, float, float],
    mat: bpy.types.Material,
    owner: bpy.types.Object,
    *,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major,
        minor_radius=minor,
        major_segments=32,
        minor_segments=8,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    link_to_collection(obj, owner.users_collection[0])
    return parent(obj, owner)


def add_projected_uv(mesh: bpy.types.Mesh) -> None:
    """Give authored profile meshes a stable metre-scaled UV0 for glTF PBR."""
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        normal = polygon.normal
        for loop_index in polygon.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            if abs(normal.y) >= max(abs(normal.x), abs(normal.z)):
                uv = (vertex.x * .5, vertex.z * .5)
            elif abs(normal.x) >= abs(normal.z):
                uv = (vertex.y * .5, vertex.z * .5)
            else:
                uv = (vertex.x * .5, vertex.y * .5)
            uv_layer.data[loop_index].uv = uv


def profile_prism(
    name: str,
    profile: tuple[tuple[float, float], ...],
    center_x: float,
    center_y: float,
    depth: float,
    mat: bpy.types.Material,
    owner: bpy.types.Object,
    *,
    bevel: float = .018,
) -> bpy.types.Object:
    """Extrude a hand-authored X/Z construction profile through Y."""
    count = len(profile)
    vertices = [
        (px, -depth / 2, pz)
        for px, pz in profile
    ] + [
        (px, depth / 2, pz)
        for px, pz in profile
    ]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    add_projected_uv(mesh)
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    link_to_collection(obj, owner.users_collection[0])
    obj.parent = owner
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.location = (0, center_y, 0)
    if bevel:
        modifier = obj.modifiers.new("Authored profile edge roll", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    return obj


def arch_band(
    name: str,
    center_x: float,
    center_y: float,
    spring_z: float,
    radius: float,
    thickness: float,
    depth: float,
    mat: bpy.types.Material,
    owner: bpy.types.Object,
    *,
    axis: str = "x",
    segments: int = 14,
) -> bpy.types.Object:
    """Build a single continuous masonry/steel arch instead of box segments."""
    outer = []
    inner = []
    for index in range(segments + 1):
        angle = math.pi * index / segments
        horizontal = math.cos(angle)
        height = math.sin(angle)
        outer.append((horizontal * radius, spring_z + height * radius))
        inner_radius = radius - thickness
        inner.append((horizontal * inner_radius, spring_z + height * inner_radius))
    ring = outer + list(reversed(inner))
    count = len(ring)
    vertices: list[tuple[float, float, float]] = []
    for side in (-1, 1):
        for horizontal, z in ring:
            if axis == "x":
                vertices.append((horizontal, side * depth / 2, z))
            else:
                vertices.append((side * depth / 2, horizontal, z))
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    add_projected_uv(mesh)
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(mat)
    link_to_collection(obj, owner.users_collection[0])
    obj.parent = owner
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.location = (0, center_y, 0)
    return obj


def text_mesh(
    name: str,
    value: str,
    location: tuple[float, float, float],
    size: float,
    mat: bpy.types.Material,
    owner: bpy.types.Object,
    *,
    rotation: tuple[float, float, float] = (math.pi / 2, 0, 0),
) -> bpy.types.Object:
    bpy.ops.object.text_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.body = value
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = size
    obj.data.extrude = 0.018
    obj.data.bevel_depth = 0.008
    obj.data.bevel_resolution = 2
    obj.data.materials.append(mat)
    bpy.ops.object.convert(target="MESH")
    link_to_collection(obj, owner.users_collection[0])
    return parent(obj, owner)


def wheel(name: str, x: float, y: float, z: float, radius: float, mat, owner) -> None:
    torus(name, radius, radius * 0.17, (x, y, z), mat, owner, rotation=(math.pi / 2, 0, 0))
    cylinder(f"{name}_Hub", radius * 0.18, radius * 0.26, (x, y, z), mat, owner, rotation=(math.pi / 2, 0, 0), vertices=24)


def build_campus(collection, m):
    x = 0.0
    case = root("CampusTrophyCase", collection, x)
    box("TrophyCaseBody", (1.65, .42, 1.9), (x, 0, .95), m["navy"], case, bevel=.065)
    box("TrophyCaseInset", (1.48, .05, 1.52), (x, -.235, 1.02), m["glass"], case, bevel=.025)
    for z in (.48, .97, 1.46):
        box(f"Shelf_{z}", (1.48, .35, .045), (x, 0, z), m["brass"], case, bevel=.018)
    for i, (px, pz) in enumerate(((-.48, .69), (0, .69), (.48, .69), (-.25, 1.18), (.3, 1.18))):
        cylinder(f"TrophyStem_{i}", .045, .22, (x + px, -.25, pz), m["brass"], case)
        sphere(f"TrophyCup_{i}", .11, (x + px, -.25, pz + .16), m["gold"], case, (1.2, .7, .75))
        box(f"TrophyBase_{i}", (.21, .13, .07), (x + px, -.25, pz - .14), m["wood"], case, bevel=.018)
    x += 4.5
    vend = root("CampusVendingMachine", collection, x)
    box("VendingBody", (1.05, .72, 1.9), (x, 0, .95), m["navy"], vend, bevel=.09)
    box("VendingWindow", (.7, .035, 1.08), (x - .08, -.38, 1.2), m["glass"], vend, bevel=.025)
    for row in range(4):
        for col in range(4):
            cylinder(f"Bottle_{row}_{col}", .045, .16, (x - .34 + col * .18, -.425, .82 + row * .22), m[["cyan", "gold", "red", "white"][col]], vend)
    box("VendingControl", (.19, .04, .48), (x + .38, -.395, 1.16), m["black"], vend, bevel=.018)
    box("VendingGlow", (.13, .025, .12), (x + .38, -.43, 1.36), m["screen"], vend, bevel=.01)
    box("VendingSlot", (.6, .04, .18), (x - .08, -.41, .28), m["black"], vend, bevel=.02)
    x += 4.0
    fountain = root("CampusWaterFountain", collection, x)
    box("FountainColumn", (.58, .42, 1.0), (x, 0, .5), m["steel"], fountain, bevel=.08)
    box("FountainBasin", (.7, .55, .16), (x, -.07, 1.02), m["steel_light"], fountain, bevel=.07)
    sphere("FountainBowl", .22, (x, -.16, 1.1), m["black"], fountain, (1.25, .82, .28))
    cylinder("FountainTap", .035, .18, (x + .2, -.25, 1.22), m["chrome"], fountain, rotation=(math.pi / 2, 0, 0))
    x += 3.3
    rack = root("CampusBikeRack", collection, x)
    for i in range(5):
        torus(f"RackLoop_{i}", .42, .035, (x - .9 + i * .45, 0, .43), m["chrome"], rack, rotation=(math.pi / 2, 0, 0))
    box("RackRail", (2.3, .12, .12), (x, .24, .13), m["steel"], rack, bevel=.04)
    x += 4.2
    sign = root("CampusWayfinding", collection, x)
    box("CampusSignFrame", (2.25, .18, 1.05), (x, 0, 1.5), m["navy"], sign, bevel=.07)
    box("CampusSignFace", (2.05, .04, .86), (x, -.115, 1.5), m["blue"], sign, bevel=.035)
    cylinder("CampusPostL", .055, 1.95, (x - .8, 0, .65), m["steel"], sign)
    cylinder("CampusPostR", .055, 1.95, (x + .8, 0, .65), m["steel"], sign)
    text_mesh("CampusLetters", "CAMPUS", (x, -.145, 1.56), .34, m["white"], sign)


def build_hospital(collection, m):
    x = 0.0
    bed = root("HospitalBed", collection, x)
    box("BedFrame", (2.2, 1.0, .13), (x, 0, .55), m["steel"], bed, bevel=.045)
    box("BedMattress", (2.02, .91, .22), (x, 0, .72), m["hospital_blue"], bed, bevel=.11)
    box("BedSheet", (1.35, .92, .045), (x + .22, 0, .85), m["white"], bed, bevel=.025)
    box("BedPillow", (.52, .72, .18), (x - .68, 0, .91), m["white"], bed, bevel=.1, rotation=(0, .08, 0))
    for px in (-1.06, 1.06):
        box(f"BedEnd_{px}", (.09, 1.05, .88), (x + px, 0, .88), m["hospital_teal"], bed, bevel=.055)
    for py in (-.51, .51):
        box(f"BedRail_{py}", (1.35, .055, .34), (x, py, .99), m["chrome"], bed, bevel=.025)
        for px in (-.52, -.17, .17, .52):
            cylinder(f"BedRailBar_{py}_{px}", .018, .28, (x + px, py, .86), m["chrome"], bed)
    for px in (-.82, .82):
        for py in (-.36, .36):
            cylinder(f"BedLeg_{px}_{py}", .035, .42, (x + px, py, .29), m["steel"], bed)
            wheel(f"BedWheel_{px}_{py}", x + px, py, .1, .11, m["rubber"], bed)
    x += 4.4
    cart = root("HospitalCrashCart", collection, x)
    box("CartBody", (.78, .56, 1.18), (x, 0, .72), m["hospital_teal"], cart, bevel=.07)
    box("CartTop", (.9, .68, .09), (x, 0, 1.33), m["steel_light"], cart, bevel=.045)
    for i in range(4):
        box(f"CartDrawer_{i}", (.66, .035, .2), (x, -.3, .55 + i * .23), m["white"], cart, bevel=.016)
        box(f"CartHandle_{i}", (.26, .035, .025), (x, -.335, .55 + i * .23), m["chrome"], cart, bevel=.01)
    for px in (-.3, .3):
        for py in (-.2, .2):
            wheel(f"CartWheel_{px}_{py}", x + px, py, .09, .09, m["rubber"], cart)
    box("DefibUnit", (.46, .34, .25), (x, .02, 1.5), m["white"], cart, bevel=.05)
    box("DefibScreen", (.29, .025, .13), (x, -.19, 1.52), m["screen"], cart, bevel=.012)
    x += 3.2
    iv = root("HospitalIVStation", collection, x)
    cylinder("IVPole", .035, 1.95, (x, 0, .98), m["chrome"], iv)
    for angle in range(0, 360, 72):
        a = math.radians(angle)
        box(f"IVBase_{angle}", (.62, .055, .055), (x + math.cos(a) * .22, math.sin(a) * .22, .09), m["chrome"], iv, rotation=(0, a, 0))
        wheel(f"IVWheel_{angle}", x + math.cos(a) * .46, math.sin(a) * .46, .07, .065, m["rubber"], iv)
    box("IVHook", (.48, .035, .035), (x, 0, 1.94), m["chrome"], iv, bevel=.012)
    box("IVBag", (.25, .055, .43), (x - .17, -.03, 1.63), m["medical_bag"], iv, bevel=.055)
    cylinder("IVDrip", .008, 1.05, (x - .17, -.03, 1.0), m["tube"], iv)
    x += 3.0
    chair = root("HospitalWheelchair", collection, x)
    for py in (-.43, .43):
        wheel(f"ChairWheel_{py}", x, py, .48, .43, m["rubber"], chair)
    box("ChairSeat", (.65, .72, .1), (x, 0, .55), m["hospital_blue"], chair, bevel=.055)
    box("ChairBack", (.18, .72, .8), (x + .32, 0, .96), m["hospital_blue"], chair, bevel=.07, rotation=(0, -.12, 0))
    for py in (-.4, .4):
        cylinder(f"ChairHandle_{py}", .025, .42, (x + .47, py, 1.32), m["chrome"], chair, rotation=(0, math.pi / 2, 0))
        box(f"ChairArm_{py}", (.55, .055, .055), (x, py, .91), m["chrome"], chair, bevel=.02)
    box("ChairFoot", (.46, .65, .055), (x - .5, 0, .22), m["chrome"], chair, bevel=.025, rotation=(0, -.18, 0))
    x += 3.5
    screen = root("HospitalPrivacyScreen", collection, x)
    for i in (-1, 0, 1):
        box(f"ScreenPanel_{i}", (.82, .055, 1.45), (x + i * .82, 0, 1.02), m["privacy"], screen, bevel=.035)
        box(f"ScreenTop_{i}", (.86, .065, .065), (x + i * .82, 0, 1.77), m["chrome"], screen, bevel=.02)
        cylinder(f"ScreenPost_{i}", .035, 1.75, (x + i * .82 - .39, 0, .9), m["chrome"], screen)
        wheel(f"ScreenWheel_{i}", x + i * .82 - .39, 0, .07, .07, m["rubber"], screen)
    x += 4.8
    sign = root("HospitalWayfinding", collection, x)
    box("HospitalSign", (2.25, .16, .92), (x, 0, 1.6), m["hospital_teal"], sign, bevel=.075)
    box("HospitalCrossV", (.22, .04, .55), (x - .72, -.105, 1.6), m["white"], sign, bevel=.025)
    box("HospitalCrossH", (.55, .04, .22), (x - .72, -.105, 1.6), m["white"], sign, bevel=.025)
    text_mesh("HospitalLetters", "WARD 4", (x + .3, -.115, 1.61), .28, m["white"], sign)
    cylinder("HospitalPost", .06, 1.62, (x, .03, .75), m["chrome"], sign)


def build_fire(collection, m):
    x = 0.0
    truck = root("FireEngine", collection, x)
    box("TruckChassis", (3.9, 1.5, .25), (x, 0, .55), m["black"], truck, bevel=.07)
    box("TruckBody", (2.25, 1.42, 1.35), (x + .72, 0, 1.27), m["fire_red"], truck, bevel=.12)
    box("TruckCab", (1.35, 1.4, 1.5), (x - 1.08, 0, 1.25), m["fire_red"], truck, bevel=.14)
    box("CabWindshield", (.05, 1.03, .54), (x - 1.79, 0, 1.55), m["smoke_glass"], truck, bevel=.025, rotation=(0, .08, 0))
    for py in (-.71, .71):
        box(f"CabWindow_{py}", (.57, .025, .48), (x - 1.14, py, 1.58), m["smoke_glass"], truck, bevel=.035)
        box(f"ReflectiveStripe_{py}", (3.5, .025, .13), (x + .08, py + (-.012 if py < 0 else .012), 1.04), m["reflective"], truck, bevel=.015)
        for px in (-1.23, .95):
            wheel(f"TruckWheel_{px}_{py}", x + px, py, .54, .43, m["rubber"], truck)
    box("TruckGrille", (.055, .92, .44), (x - 1.77, 0, .8), m["chrome"], truck, bevel=.018)
    for py in (-.38, .38):
        cylinder(f"TruckLamp_{py}", .12, .045, (x - 1.815, py, 1.02), m["lamp"], truck, rotation=(0, math.pi / 2, 0))
    for py in (-.42, .42):
        cylinder(f"Beacon_{py}", .12, .2, (x - .8, py, 2.12), m["beacon"], truck)
    box("LadderRailL", (2.4, .07, .07), (x + .48, -.35, 2.08), m["chrome"], truck, bevel=.02)
    box("LadderRailR", (2.4, .07, .07), (x + .48, .35, 2.08), m["chrome"], truck, bevel=.02)
    for i in range(8):
        box(f"LadderRung_{i}", (.06, .72, .06), (x - .55 + i * .3, 0, 2.08), m["chrome"], truck, bevel=.018)
    for i in range(3):
        cylinder(f"HosePort_{i}", .14, .06, (x + .35 + i * .48, -.735, 1.42), m["brass"], truck, rotation=(math.pi / 2, 0, 0))
    x += 6.2
    rack = root("FireGearRack", collection, x)
    box("GearRackFrame", (2.2, .6, 2.15), (x, 0, 1.08), m["steel_dark"], rack, bevel=.07)
    box("GearRackOpen", (2.02, .04, 1.85), (x, -.33, 1.08), m["black"], rack, bevel=.025)
    for i in (-1, 0, 1):
        px = x + i * .62
        sphere(f"Helmet_{i}", .24, (px, -.39, 1.72), m["helmet"], rack, (1.18, .82, .72))
        box(f"CoatBody_{i}", (.46, .12, .73), (px, -.39, 1.08), m["coat"], rack, bevel=.09)
        box(f"CoatStripe_{i}", (.48, .025, .1), (px, -.465, 1.03), m["reflective"], rack, bevel=.018)
        for side in (-1, 1):
            box(f"CoatArm_{i}_{side}", (.16, .11, .65), (px + side * .27, -.39, 1.08), m["coat"], rack, bevel=.06, rotation=(0, side * .12, 0))
        for side in (-1, 1):
            box(f"Boot_{i}_{side}", (.18, .3, .35), (px + side * .12, -.38, .35), m["rubber"], rack, bevel=.06)
    x += 4.6
    reel = root("FireHoseReel", collection, x)
    box("ReelFrame", (1.45, .72, 1.62), (x, 0, .83), m["steel_dark"], reel, bevel=.08)
    box("ReelInset", (1.2, .04, 1.28), (x, -.39, .86), m["black"], reel, bevel=.04)
    for radius in (.47, .39, .31, .23):
        torus(f"HoseCoil_{radius}", radius, .055, (x, -.445, .92), m["hose"], reel, rotation=(math.pi / 2, 0, 0))
    cylinder("ReelHub", .12, .15, (x, -.46, .92), m["brass"], reel, rotation=(math.pi / 2, 0, 0))
    box("ReelLabel", (.84, .03, .18), (x, -.42, 1.46), m["fire_red"], reel, bevel=.02)
    text_mesh("ReelLetters", "HOSE", (x, -.445, 1.47), .15, m["white"], reel)
    x += 3.5
    hydrant = root("FireHydrant", collection, x)
    cylinder("HydrantBody", .28, .9, (x, 0, .55), m["fire_red"], hydrant, vertices=40, bevel=.045)
    cylinder("HydrantTop", .38, .12, (x, 0, 1.02), m["fire_red"], hydrant, vertices=40, bevel=.04)
    sphere("HydrantCap", .34, (x, 0, 1.09), m["fire_red"], hydrant, (1, 1, .38))
    for py in (-.37, .37):
        cylinder(f"HydrantPort_{py}", .17, .22, (x, py, .72), m["brass"], hydrant, rotation=(math.pi / 2, 0, 0))
    cylinder("HydrantBolt", .06, .13, (x, 0, 1.28), m["brass"], hydrant)
    x += 3.2
    sign = root("FireStationWayfinding", collection, x)
    box("FireSignFrame", (2.4, .17, 1.1), (x, 0, 1.58), m["steel_dark"], sign, bevel=.08)
    box("FireSignFace", (2.18, .04, .88), (x, -.12, 1.58), m["fire_red"], sign, bevel=.045)
    text_mesh("FireLetters", "FIRE 07", (x, -.15, 1.59), .33, m["white"], sign)
    for px in (-.82, .82):
        cylinder(f"FireSignPost_{px}", .055, 1.6, (x + px, 0, .72), m["steel"], sign)
    x += 4.5
    cones = root("FireSafetyCones", collection, x)
    for i in (-1, 0, 1):
        px = x + i * .62
        bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=.25, radius2=.08, depth=.75, location=(px, 0, .43))
        obj = bpy.context.object
        obj.name = f"Cone_{i}"
        obj.data.materials.append(m["orange"])
        link_to_collection(obj, collection)
        parent(obj, cones)
        box(f"ConeStripe_{i}", (.31, .31, .11), (px, 0, .47), m["reflective"], cones, bevel=.025)
        box(f"ConeBase_{i}", (.58, .58, .08), (px, 0, .07), m["rubber"], cones, bevel=.035)


def build_factory(collection, m):
    x = 0.0
    pipes = root("FactoryPipeAssembly", collection, x)
    for i, (py, radius, color) in enumerate(((-.55, .12, "factory_blue"), (0, .16, "steel"), (.58, .1, "hazard_yellow"))):
        cylinder(f"Pipe_{i}", radius, 2.8, (x, py, 1.2 + i * .34), m[color], pipes, rotation=(0, math.pi / 2, 0), vertices=36)
        for px in (-1.12, 0, 1.12):
            torus(f"PipeFlange_{i}_{px}", radius * 1.45, radius * .22, (x + px, py, 1.2 + i * .34), m["steel_dark"], pipes, rotation=(0, math.pi / 2, 0))
    for px in (-.55, .55):
        cylinder(f"ValveStem_{px}", .055, .42, (x + px, 0, 1.75), m["brass"], pipes)
        torus(f"ValveWheel_{px}", .23, .035, (x + px, 0, 1.98), m["valve_red"], pipes)
        for a in range(0, 360, 45):
            ang = math.radians(a)
            box(f"ValveSpoke_{px}_{a}", (.38, .035, .035), (x + px, math.sin(ang) * .015, 1.98), m["valve_red"], pipes, bevel=.012, rotation=(0, ang, 0))
    for px in (-1.25, 1.25):
        box(f"PipeStand_{px}", (.16, .9, 1.9), (x + px, 0, .88), m["steel_dark"], pipes, bevel=.05)
    x += 4.9
    tank = root("FactoryStorageTank", collection, x)
    cylinder("TankBody", .72, 1.75, (x, 0, 1.0), m["steel_light"], tank, vertices=48, bevel=.06)
    sphere("TankTop", .72, (x, 0, 1.88), m["steel_light"], tank, (1, 1, .42))
    for z in (.36, 1.1, 1.72):
        torus(f"TankBand_{z}", .73, .035, (x, 0, z), m["steel_dark"], tank)
    for z in (.38, .7, 1.02, 1.34, 1.66):
        box(f"LadderStep_{z}", (.52, .055, .055), (x - .78, 0, z), m["hazard_yellow"], tank, bevel=.016)
    for py in (-.25, .25):
        box(f"LadderRail_{py}", (.055, .055, 1.65), (x - .78, py, 1.0), m["hazard_yellow"], tank, bevel=.016)
    cylinder("TankGauge", .18, .08, (x, -.77, 1.38), m["white"], tank, rotation=(math.pi / 2, 0, 0), vertices=40)
    cylinder("GaugeFace", .14, .025, (x, -.825, 1.38), m["screen"], tank, rotation=(math.pi / 2, 0, 0), vertices=40)
    x += 3.8
    console = root("FactoryControlConsole", collection, x)
    box("ConsoleBase", (1.7, .82, 1.22), (x, 0, .67), m["steel_dark"], console, bevel=.09)
    box("ConsolePanel", (1.58, .08, .62), (x, -.46, 1.25), m["steel"], console, bevel=.045, rotation=(.28, 0, 0))
    for i in (-1, 0, 1):
        box(f"ConsoleScreen_{i}", (.36, .025, .22), (x + i * .47, -.54, 1.32), m["screen"], console, bevel=.018, rotation=(.28, 0, 0))
    for row in range(2):
        for col in range(5):
            sphere(f"ConsoleButton_{row}_{col}", .04, (x - .55 + col * .28, -.51, .96 + row * .16), m[["lamp", "valve_red", "screen"][col % 3]], console, (1, .55, 1))
    x += 4.2
    conveyor = root("FactoryConveyor", collection, x)
    box("ConveyorFrame", (3.0, 1.0, .15), (x, 0, .72), m["steel_dark"], conveyor, bevel=.055)
    box("ConveyorBelt", (2.88, .82, .08), (x, 0, .84), m["rubber"], conveyor, bevel=.035)
    for px in (-1.22, -.73, -.24, .24, .73, 1.22):
        cylinder(f"Roller_{px}", .09, .92, (x + px, 0, .86), m["chrome"], conveyor, rotation=(math.pi / 2, 0, 0), vertices=28)
    for px in (-1.2, 1.2):
        for py in (-.4, .4):
            box(f"ConveyorLeg_{px}_{py}", (.1, .1, .72), (x + px, py, .36), m["hazard_yellow"], conveyor, bevel=.025)
    for i, px in enumerate((-.7, .35)):
        box(f"ConveyorCrate_{i}", (.62, .58, .55), (x + px, 0, 1.16), m["crate"], conveyor, bevel=.06)
        for z in (.93, 1.4):
            box(f"CrateBand_{i}_{z}", (.67, .07, .07), (x + px, 0, z), m["wood_dark"], conveyor, bevel=.015)
    x += 5.2
    barrier = root("FactorySafetyBarrier", collection, x)
    for px in (-1.2, 1.2):
        box(f"BarrierPost_{px}", (.14, .14, 1.35), (x + px, 0, .68), m["hazard_yellow"], barrier, bevel=.035)
        box(f"BarrierFoot_{px}", (.52, .58, .09), (x + px, 0, .06), m["steel_dark"], barrier, bevel=.03)
    for row, z in enumerate((.48, .92, 1.28)):
        for segment in range(8):
            box(f"BarrierRail_{row}_{segment}", (.31, .12, .12), (x - 1.08 + segment * .31, 0, z), m["hazard_yellow" if segment % 2 == 0 else "black"], barrier, bevel=.025)
    x += 4.5
    crates = root("FactoryCrateStack", collection, x)
    for i, (px, py, z) in enumerate(((-.55, 0, .4), (.25, .1, .4), (.05, -.05, 1.18))):
        box(f"Crate_{i}", (.72, .68, .72), (x + px, py, z), m["crate"], crates, bevel=.055)
        for dz in (-.27, .27):
            box(f"CrateBandH_{i}_{dz}", (.76, .07, .07), (x + px, py, z + dz), m["wood_dark"], crates, bevel=.015)
        for dx in (-.27, .27):
            box(f"CrateBandV_{i}_{dx}", (.07, .07, .76), (x + px + dx, py, z), m["wood_dark"], crates, bevel=.015)


def build_architecture_wall(collection, m, theme: str) -> None:
    """Create a full-height architectural bay, later material-merged + instanced."""
    x = 30.0
    if theme == "campus":
        wall = root("CampusArchitectureWall", collection, x)
        box("CampusWallPlaster", (2.18, .2, 2.3), (x, 0, 1.15), m["white"], wall, bevel=.015)
        box("CampusWainscot", (2.12, .255, .72), (x, -.02, .42), m["wood"], wall, bevel=.025)
        box("CampusTopBand", (2.16, .27, .14), (x, -.025, 2.16), m["navy"], wall, bevel=.015)
        box("CampusChairRail", (2.16, .3, .095), (x, -.04, .84), m["brass"], wall, bevel=.015)
        for px in (-.98, 0, .98):
            box(f"CampusPilaster_{px}", (.105, .3, 2.2), (x + px, -.04, 1.1), m["navy"], wall, bevel=0)
        for px in (-.5, .5):
            box(f"CampusInset_{px}", (.75, .03, .82), (x + px, -.13, 1.46), m["blue"], wall, bevel=.018)
            box(f"CampusInsetGlow_{px}", (.58, .025, .055), (x + px, -.155, 1.78), m["gold"], wall, bevel=0)
    elif theme == "hospital":
        wall = root("HospitalArchitectureWall", collection, x)
        box("HospitalWallPanel", (2.18, .2, 2.3), (x, 0, 1.15), m["white"], wall, bevel=.015)
        box("HospitalLowerPanel", (2.14, .25, .67), (x, -.02, .38), m["hospital_teal"], wall, bevel=.02)
        box("HospitalKickPlate", (2.16, .275, .18), (x, -.035, .13), m["steel_light"], wall, bevel=0)
        box("HospitalWayBand", (2.18, .285, .15), (x, -.04, 1.48), m["hospital_teal"], wall, bevel=0)
        cylinder("HospitalHandrail", .045, 1.96, (x, -.2, .91), m["chrome"], wall, rotation=(0, math.pi / 2, 0), vertices=16, bevel=0)
        for px in (-.78, .78):
            box(f"HospitalPanelSeam_{px}", (.035, .26, 2.16), (x + px, -.025, 1.08), m["steel_light"], wall, bevel=0)
        box("HospitalCallPanel", (.28, .045, .42), (x + .48, -.15, 1.85), m["steel"], wall, bevel=.018)
        box("HospitalCallGlow", (.17, .025, .16), (x + .48, -.18, 1.91), m["screen"], wall, bevel=0)
    elif theme == "fire":
        wall = root("FireArchitectureWall", collection, x)
        box("FireWallBacking", (2.18, .22, 2.3), (x, 0, 1.15), m["steel_dark"], wall, bevel=0)
        for row in range(8):
            offset = .16 if row % 2 else 0
            for col in range(7):
                px = x - .95 + col * .31 + offset
                if px > x + 1.02:
                    continue
                box(f"FireBrick_{row}_{col}", (.285, .09, .235), (px, -.155, .43 + row * .25), m["brick_fire"], wall, bevel=0)
        box("FireSteelBase", (2.16, .31, .38), (x, -.035, .23), m["black"], wall, bevel=0)
        for segment in range(10):
            box(
                f"FireHazard_{segment}",
                (.23, .32, .12),
                (x - 1.02 + segment * .225, -.05, .52),
                m["hazard_yellow" if segment % 2 == 0 else "black"],
                wall,
                bevel=0,
            )
        cylinder("FireUtilityPipe", .065, 1.72, (x + .72, -.25, 1.34), m["fire_red"], wall, vertices=12, bevel=0)
        for z in (.72, 1.94):
            cylinder(f"FirePipeClamp_{z}", .09, .045, (x + .72, -.25, z), m["brass"], wall, vertices=20, bevel=0)
    else:
        wall = root("FactoryArchitectureWall", collection, x)
        box("FactoryWallBacking", (2.18, .22, 2.3), (x, 0, 1.15), m["steel_dark"], wall, bevel=0)
        box("FactoryLowerArmor", (2.14, .29, .72), (x, -.035, .4), m["factory_blue"], wall, bevel=0)
        for col in range(12):
            px = x - 1.0 + col * .18
            box(f"FactoryRib_{col}", (.055, .31, 2.12), (px, -.04, 1.16), m["steel"], wall, bevel=0)
        for segment in range(10):
            box(
                f"FactoryHazard_{segment}",
                (.23, .33, .13),
                (x - 1.02 + segment * .225, -.055, .79),
                m["hazard_yellow" if segment % 2 == 0 else "black"],
                wall,
                bevel=0,
            )
        cylinder("FactoryConduitA", .045, 1.62, (x - .55, -.24, 1.5), m["factory_blue"], wall, vertices=12, bevel=0)
        cylinder("FactoryConduitB", .035, 1.35, (x - .35, -.24, 1.57), m["hazard_yellow"], wall, vertices=12, bevel=0)
        box("FactoryJunctionBox", (.42, .16, .52), (x + .46, -.19, 1.52), m["steel"], wall, bevel=.018)
        box("FactoryJunctionGlow", (.18, .025, .13), (x + .46, -.285, 1.61), m["screen"], wall, bevel=0)


# ---------------------------------------------------------------------------
# Production environment extension
# ---------------------------------------------------------------------------
#
# The first campaign pass proved the gameplay and export pipeline, but its
# architecture used one repeated wall bay and a small number of isolated hero
# props.  The production pass below deliberately spends geometry on readable
# silhouette, construction logic, contact details and authored variation.  It
# also exposes a stable semantic node contract so the Web runtime can swap
# wall/floor/dressing variants without knowing Blender object internals.


THEME_PREFIX = {
    "campus": "Campus",
    "hospital": "Hospital",
    "fire": "FireStation",
    "factory": "Factory",
}


# Runtime-facing story modules.  Every campaign propSet receives three
# landmarks plus an arrival, exit and hide surround.  These are intentionally
# primary node names from LevelArtLayout rather than compatibility aliases: the
# Web runtime can therefore distinguish a library from a laboratory even when
# both chapters share the Campus material language.
LEVEL_STORY_SPECS = {
    "campus": (
        {
            "prop_set": "campus-classic",
            "label": "CLASS",
            "landmarks": (
                ("CampusClassroomCluster", "classroom"),
                ("CampusCourtyardCluster", "courtyard"),
                ("CampusClassicLandmark", "heritage"),
            ),
            "arrival": "CampusClassicArrivalCluster",
            "exit": "CampusGateDressing",
            "hide": "CampusClassicHideDressing",
        },
        {
            "prop_set": "campus-library",
            "label": "LIBRARY",
            "landmarks": (
                ("CampusLibraryShelves", "library-shelves"),
                ("CampusReadingCluster", "reading"),
                ("CampusArchiveCluster", "archive"),
            ),
            "arrival": "CampusLibraryArrivalCluster",
            "exit": "CampusLibraryExitCluster",
            "hide": "CampusLibraryHideDressing",
        },
        {
            "prop_set": "campus-science",
            "label": "SCIENCE",
            "landmarks": (
                ("CampusLabBenchCluster", "lab-bench"),
                ("CampusFumeHoodCluster", "fume-hood"),
                ("CampusGreenhouseCluster", "greenhouse"),
            ),
            "arrival": "CampusScienceArrivalCluster",
            "exit": "CampusScienceExitCluster",
            "hide": "CampusScienceHideDressing",
        },
    ),
    "hospital": (
        {
            "prop_set": "hospital-outpatient",
            "label": "TRIAGE",
            "landmarks": (
                ("HospitalTriageCluster", "triage"),
                ("HospitalWaitingCluster", "waiting"),
                ("HospitalPharmacyCluster", "pharmacy"),
            ),
            "arrival": "HospitalOutpatientArrivalCluster",
            "exit": "HospitalOutpatientExitCluster",
            "hide": "HospitalOutpatientHideDressing",
        },
        {
            "prop_set": "hospital-isolation",
            "label": "ISOLATION",
            "landmarks": (
                ("HospitalDeconCluster", "decon"),
                ("HospitalIsolationWardCluster", "isolation-ward"),
                ("HospitalAirlockCluster", "airlock"),
            ),
            "arrival": "HospitalIsolationArrivalCluster",
            "exit": "HospitalIsolationExitCluster",
            "hide": "HospitalIsolationHideDressing",
        },
    ),
    "fire": (
        {
            "prop_set": "fire-engine-bay",
            "label": "ENGINE 07",
            "landmarks": (
                ("FireStationEngineBayCluster", "engine-bay"),
                ("FireStationTurnoutCluster", "turnout"),
                ("FireStationHoseServiceCluster", "hose-service"),
            ),
            "arrival": "FireStationEngineBayArrivalCluster",
            "exit": "FireStationEngineBayExitCluster",
            "hide": "FireStationEngineBayHideDressing",
        },
        {
            "prop_set": "fire-training",
            "label": "TRAINING",
            "landmarks": (
                ("FireStationTrainingCluster", "training"),
                ("FireStationRopeRescueCluster", "rope-rescue"),
                ("FireStationBreathingGearCluster", "breathing-gear"),
            ),
            "arrival": "FireStationTrainingArrivalCluster",
            "exit": "FireStationTrainingExitCluster",
            "hide": "FireStationTrainingHideDressing",
        },
    ),
    "factory": (
        {
            "prop_set": "factory-assembly",
            "label": "ASSEMBLY",
            "landmarks": (
                ("FactoryAssemblyLineCluster", "assembly-line"),
                ("FactoryRobotCellCluster", "robot-cell"),
                ("FactoryInspectionCluster", "inspection"),
            ),
            "arrival": "FactoryAssemblyArrivalCluster",
            "exit": "FactoryAssemblyExitCluster",
            "hide": "FactoryAssemblyHideDressing",
        },
        {
            "prop_set": "factory-turbine",
            "label": "TURBINE",
            "landmarks": (
                ("FactoryTurbineCluster", "turbine"),
                ("FactoryHighPressurePipeCluster", "high-pressure"),
                ("FactoryBreakerCluster", "breaker"),
            ),
            "arrival": "FactoryTurbineArrivalCluster",
            "exit": "FactoryTurbineExitCluster",
            "hide": "FactoryTurbineHideDressing",
        },
        {
            "prop_set": "factory-foundry",
            "label": "FOUNDRY",
            "landmarks": (
                ("FactoryFurnaceCluster", "furnace"),
                ("FactoryCastingCluster", "casting"),
                ("FactoryCoolingCluster", "cooling"),
            ),
            "arrival": "FactoryFoundryArrivalCluster",
            "exit": "FactoryFoundryExitCluster",
            "hide": "FactoryFoundryHideDressing",
        },
    ),
}


def semantic_root(name: str, collection: bpy.types.Collection, x: float, semantic: str) -> bpy.types.Object:
    owner = root(name, collection, x)
    owner["chasing_semantic"] = semantic
    owner["authored_scale_meters"] = True
    return owner


def delete_hierarchy(owner: bpy.types.Object) -> None:
    for child in list(owner.children):
        delete_hierarchy(child)
    bpy.data.objects.remove(owner, do_unlink=True)


def linked_alias(
    source: bpy.types.Object,
    name: str,
    collection: bpy.types.Collection,
    *,
    semantic: str | None = None,
) -> bpy.types.Object:
    """Duplicate a hierarchy while sharing mesh datablocks.

    Aliases preserve the legacy node contract at very small file cost.  The
    duplicate may overlap in the source master because consumers isolate the
    named root before fitting it into the level.
    """

    def clone_branch(original: bpy.types.Object, clone_parent: bpy.types.Object | None) -> bpy.types.Object:
        duplicate = original.copy()
        if original.data is not None:
            duplicate.data = original.data
        collection.objects.link(duplicate)
        duplicate.parent = clone_parent
        duplicate.matrix_parent_inverse = original.matrix_parent_inverse.copy()
        duplicate.matrix_basis = original.matrix_basis.copy()
        for child in original.children:
            clone_branch(child, duplicate)
        return duplicate

    result = clone_branch(source, None)
    result.name = name
    result["chasing_semantic"] = semantic or source.get("chasing_semantic", "compatibility-alias")
    result["authored_scale_meters"] = True
    return result


def add_fastener_line(
    owner: bpy.types.Object,
    m,
    *,
    x: float,
    y: float,
    z: float,
    count: int,
    spacing: float,
    horizontal: bool = True,
    prefix: str = "Fastener",
) -> None:
    for index in range(count):
        delta = (index - (count - 1) / 2) * spacing
        cylinder(
            f"{prefix}_{index}",
            .018,
            .018,
            (x + (delta if horizontal else 0), y, z + (0 if horizontal else delta)),
            m["brass"] if "Hospital" not in owner.name else m["chrome"],
            owner,
            rotation=(math.pi / 2, 0, 0),
            vertices=12,
            bevel=0,
        )


def add_hazard_band(
    owner,
    m,
    x: float,
    y: float,
    z: float,
    width: float = 1.92,
    prefix: str = "Hazard",
    *,
    floor: bool = False,
) -> None:
    segments = 10
    segment_width = width / segments
    for index in range(segments):
        box(
            f"{prefix}_{index}",
            (segment_width + .006, .025, .105),
            (x - width / 2 + segment_width * (index + .5), y, z),
            m["hazard_yellow" if index % 2 == 0 else "black"],
            owner,
            bevel=.006,
            # Floor bands use crisp alternating safety blocks. Wall bands tilt
            # in the X/Z plane and read as chevrons from the corridor camera.
            rotation=(0, 0, 0) if floor else (0, (-.34 if index % 2 == 0 else .34), 0),
        )


def add_wall_shell(owner, m, theme: str, x: float) -> None:
    """Author the common construction layers of a two-metre wall bay."""
    if theme == "campus":
        box("WallCore", (2.0, .2, 2.34), (x, 0, 1.17), m["concrete"], owner, bevel=.018)
        box("WallWainscot", (1.96, .255, .7), (x, -.025, .4), m["wood"], owner, bevel=.025)
        box("WallTopCap", (2.04, .29, .12), (x, -.03, 2.28), m["navy"], owner, bevel=.018)
        box("WallChairRail", (2.02, .3, .095), (x, -.045, .81), m["brass"], owner, bevel=.014)
        for px in (-.94, .94):
            box(f"WallPilaster_{px}", (.11, .29, 2.22), (x + px, -.04, 1.11), m["navy"], owner, bevel=.01)
    elif theme == "hospital":
        box("WallCore", (2.0, .2, 2.34), (x, 0, 1.17), m["linoleum"], owner, bevel=.016)
        box("WallLowerPanel", (1.98, .25, .66), (x, -.02, .39), m["hospital_teal"], owner, bevel=.018)
        box("WallKickPlate", (2.0, .28, .17), (x, -.04, .105), m["steel_light"], owner, bevel=.008)
        box("WallWayfindingBand", (2.0, .285, .14), (x, -.045, 1.48), m["hospital_teal"], owner, bevel=.008)
        cylinder("WallHandrail", .042, 1.86, (x, -.205, .9), m["chrome"], owner, rotation=(0, math.pi / 2, 0), vertices=16, bevel=.008)
        for px in (-.72, .72):
            box(f"WallSeam_{px}", (.025, .265, 2.12), (x + px, -.03, 1.08), m["steel_light"], owner, bevel=0)
    elif theme == "fire":
        box("WallCore", (2.0, .2, 2.34), (x, 0, 1.17), m["concrete_dark"], owner, bevel=.012)
        # A shallow brick relief reads as masonry without the toy-like full
        # block wall of the prototype.
        for row in range(7):
            offset = .14 if row % 2 else 0
            for col in range(7):
                px = x - .88 + col * .28 + offset
                if px > x + .92:
                    continue
                box(
                    f"Brick_{row}_{col}",
                    (.255, .035, .215),
                    (px, -.12, .67 + row * .225),
                    m["brick_fire"],
                    owner,
                    bevel=.008,
                )
        box("WallSteelBase", (2.0, .28, .37), (x, -.035, .22), m["black"], owner, bevel=.012)
        add_hazard_band(owner, m, x, -.198, .51, prefix="FireHazard")
        box("WallTopBeam", (2.05, .3, .16), (x, -.035, 2.26), m["steel_dark"], owner, bevel=.018)
    else:
        box("WallCore", (2.0, .21, 2.34), (x, 0, 1.17), m["concrete_dark"], owner, bevel=.01)
        box("WallLowerArmor", (1.98, .28, .7), (x, -.035, .39), m["factory_blue"], owner, bevel=.008)
        for col in range(11):
            px = x - .9 + col * .18
            box(f"Corrugation_{col}", (.045, .3, 2.12), (px, -.04, 1.15), m["steel"], owner, bevel=.006)
        add_hazard_band(owner, m, x, -.21, .78, prefix="FactoryHazard")
        box("WallTopBeam", (2.05, .31, .17), (x, -.04, 2.25), m["steel_dark"], owner, bevel=.015)


def add_wall_silhouette(owner, m, theme: str, x: float, variant: str) -> None:
    """Give B/C bays distinct skyline profiles, not merely different decals."""
    if variant == "A":
        return
    if theme == "campus":
        if variant == "B":
            profile_prism(
                "LibraryGableCrown",
                ((-1.01, 2.19), (-.72, 2.39), (0, 2.64), (.72, 2.39), (1.01, 2.19)),
                x, -.025, .27, m["navy"], owner, bevel=.022,
            )
            profile_prism(
                "LibraryGableInset",
                ((-.72, 2.27), (0, 2.53), (.72, 2.27), (.6, 2.22), (0, 2.43), (-.6, 2.22)),
                x, -.18, .035, m["brass"], owner, bevel=.009,
            )
        else:
            arch_band("ScienceClerestoryArch", x, -.02, 2.16, .49, .115, .28, m["steel_light"], owner, segments=16)
            box("ScienceClerestoryGlow", (.55, .035, .12), (x, -.185, 2.48), m["screen"], owner, bevel=.025)
    elif theme == "hospital":
        profile = (
            ((-1.01, 2.18), (-.78, 2.4), (-.36, 2.53), (.36, 2.53), (.78, 2.4), (1.01, 2.18))
            if variant == "B"
            else ((-1.01, 2.18), (-.68, 2.34), (-.2, 2.43), (.2, 2.43), (.68, 2.34), (1.01, 2.18))
        )
        profile_prism("HospitalCovedHeader", profile, x, -.02, .28, m["hospital_teal"], owner, bevel=.028)
        for px in (-.58, .58):
            cylinder(f"HospitalHeaderLamp_{px}", .065, .045, (x + px, -.19, 2.32), m["screen"], owner, rotation=(math.pi / 2, 0, 0), vertices=20, bevel=.008)
    elif theme == "fire":
        profile_prism(
            "FireBayTrussCrown",
            ((-1.03, 2.17), (-.76, 2.48), (-.2, 2.31), (.38, 2.58), (1.03, 2.2), (1.03, 2.12), (-1.03, 2.12)),
            x, -.015, .31, m["steel_dark"], owner, bevel=.018,
        )
        if variant == "C":
            arch_band("FireBayPipeLoop", x, -.19, 2.09, .58, .07, .095, m["fire_red"], owner, segments=14)
    else:
        profile = (
            ((-1.03, 2.15), (-.65, 2.53), (-.25, 2.19), (.17, 2.5), (.58, 2.2), (1.03, 2.45), (1.03, 2.12), (-1.03, 2.12))
            if variant == "B"
            else ((-1.03, 2.16), (-.72, 2.35), (-.42, 2.22), (-.08, 2.56), (.3, 2.2), (.68, 2.44), (1.03, 2.2), (1.03, 2.12), (-1.03, 2.12))
        )
        profile_prism("FactorySawtoothCrown", profile, x, -.02, .32, m["steel_dark"], owner, bevel=.016)
        box("FactoryCrownWarning", (1.15, .035, .1), (x, -.205, 2.27), m["hazard_yellow"], owner, bevel=.008)


def build_wall_variant(collection, m, theme: str, name: str, x: float, variant: str) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, f"architecture-wall-{variant.lower()}")
    add_wall_shell(owner, m, theme, x)
    add_wall_silhouette(owner, m, theme, x, variant)

    if theme == "campus":
        if variant == "A":
            for px in (-.48, .48):
                box(f"InsetPanel_{px}", (.72, .035, .78), (x + px, -.135, 1.43), m["blue"], owner, bevel=.022)
                box(f"InsetHighlight_{px}", (.55, .025, .045), (x + px, -.16, 1.75), m["gold"], owner, bevel=.006)
        elif variant == "B":
            box("NoticeFrame", (1.38, .075, .8), (x, -.165, 1.5), m["wood_dark"], owner, bevel=.028)
            box("NoticeBacking", (1.22, .025, .64), (x, -.22, 1.5), m["black"], owner, bevel=.012)
            for index, (px, pz, mat) in enumerate(((-.38, 1.64, "paper"), (.05, 1.46, "white"), (.38, 1.67, "paper"), (-.2, 1.32, "red"))):
                box(f"Notice_{index}", (.28, .015, .2), (x + px, -.242, pz), m[mat], owner, bevel=.005, rotation=(0, 0, (-.05 + index * .035)))
            add_fastener_line(owner, m, x=x, y=-.235, z=1.5, count=2, spacing=1.1, prefix="NoticePin")
        else:
            box("LabServicePanel", (1.34, .06, .7), (x, -.16, 1.5), m["steel"], owner, bevel=.03)
            box("LabServiceGlass", (.83, .025, .42), (x - .16, -.205, 1.54), m["glass"], owner, bevel=.018)
            for index in range(3):
                cylinder(f"ServiceDial_{index}", .055, .025, (x + .42, -.21, 1.34 + index * .17), m[["screen", "red", "gold"][index]], owner, rotation=(math.pi / 2, 0, 0), vertices=20, bevel=.006)
    elif theme == "hospital":
        if variant == "A":
            box("CallPanel", (.31, .05, .48), (x + .48, -.17, 1.84), m["steel"], owner, bevel=.022)
            box("CallScreen", (.19, .022, .17), (x + .48, -.205, 1.94), m["screen"], owner, bevel=.008)
            for pz in (1.73, 1.8):
                cylinder(f"CallButton_{pz}", .035, .018, (x + .48, -.21, pz), m["lamp"], owner, rotation=(math.pi / 2, 0, 0), vertices=16, bevel=.004)
        elif variant == "B":
            box("MedicalServiceRail", (1.22, .08, .42), (x, -.17, 1.83), m["steel_light"], owner, bevel=.026)
            for index, px in enumerate((-.42, -.14, .14, .42)):
                cylinder(f"MedicalPort_{index}", .065, .026, (x + px, -.225, 1.84), m[["hospital_teal", "gold", "screen", "red"][index]], owner, rotation=(math.pi / 2, 0, 0), vertices=20, bevel=.006)
            box("MedicalRailLabel", (.7, .018, .09), (x, -.228, 2.0), m["paper"], owner, bevel=.006)
        else:
            box("ObservationFrame", (1.36, .08, .78), (x, -.16, 1.75), m["steel_light"], owner, bevel=.025)
            box("ObservationGlass", (1.19, .022, .61), (x, -.22, 1.75), m["glass"], owner, bevel=.018)
            for px in (-.4, 0, .4):
                box(f"ObservationMullion_{px}", (.035, .025, .63), (x + px, -.235, 1.75), m["chrome"], owner, bevel=.006)
    elif theme == "fire":
        if variant == "A":
            cylinder("UtilityPipe", .065, 1.52, (x + .62, -.23, 1.39), m["fire_red"], owner, vertices=16, bevel=.012)
            for pz in (.72, 1.9):
                cylinder(f"PipeClamp_{pz}", .092, .045, (x + .62, -.23, pz), m["brass"], owner, vertices=20, bevel=.006)
            box("StationPlaque", (.72, .035, .28), (x - .34, -.2, 1.82), m["fire_red"], owner, bevel=.025)
            add_fastener_line(owner, m, x=x-.34, y=-.225, z=1.82, count=2, spacing=.52, prefix="PlaqueBolt")
        elif variant == "B":
            box("HoseCabinetFrame", (1.16, .09, .92), (x, -.17, 1.47), m["fire_red"], owner, bevel=.035)
            box("HoseCabinetGlass", (.94, .025, .69), (x, -.235, 1.47), m["glass"], owner, bevel=.02)
            for radius in (.28, .21, .14):
                torus(f"WallHose_{radius}", radius, .034, (x, -.265, 1.46), m["hose"], owner, rotation=(math.pi / 2, 0, 0))
        else:
            box("VentFrame", (1.35, .075, .78), (x, -.17, 1.5), m["steel_dark"], owner, bevel=.025)
            for index in range(7):
                box(f"VentLouver_{index}", (1.16, .05, .055), (x, -.225, 1.25 + index * .085), m["steel"], owner, bevel=.008, rotation=(.13, 0, 0))
            cylinder("AlarmBell", .13, .06, (x + .72, -.2, 2.02), m["fire_red"], owner, rotation=(math.pi / 2, 0, 0), vertices=24, bevel=.012)
    else:
        if variant == "A":
            for index, (px, radius, mat) in enumerate(((-.58, .045, "factory_blue"), (-.38, .035, "hazard_yellow"))):
                cylinder(f"Conduit_{index}", radius, 1.45, (x + px, -.225, 1.48), m[mat], owner, vertices=14, bevel=.006)
            box("JunctionBox", (.46, .17, .54), (x + .42, -.19, 1.55), m["steel"], owner, bevel=.025)
            box("JunctionScreen", (.2, .025, .14), (x + .42, -.285, 1.64), m["screen"], owner, bevel=.008)
        elif variant == "B":
            box("InspectionPanel", (1.18, .11, .92), (x, -.18, 1.49), m["steel_dark"], owner, bevel=.035)
            box("InspectionInset", (.96, .03, .7), (x, -.25, 1.49), m["factory_blue"], owner, bevel=.018)
            add_fastener_line(owner, m, x=x, y=-.275, z=1.76, count=4, spacing=.25, prefix="PanelBoltTop")
            add_fastener_line(owner, m, x=x, y=-.275, z=1.22, count=4, spacing=.25, prefix="PanelBoltBottom")
        else:
            box("LouverFrame", (1.36, .09, .84), (x, -.18, 1.54), m["black"], owner, bevel=.028)
            for index in range(8):
                box(f"Louver_{index}", (1.15, .06, .05), (x, -.24, 1.25 + index * .083), m["steel"], owner, bevel=.006, rotation=(.15, 0, 0))
            box("WarningPlate", (.52, .025, .18), (x + .54, -.245, 2.02), m["hazard_yellow"], owner, bevel=.012)
    return owner


def build_wall_wide(collection, m, theme: str, name: str, x: float) -> bpy.types.Object:
    """Author a continuous four-metre bay for long corridor boundaries.

    The runtime replaces pairs of two-metre panels with this module.  It has a
    genuinely continuous wall field, cap and handrail, so the long elevation
    no longer reads as two duplicated boxes with a post at every grid cell.
    """
    owner = semantic_root(name, collection, x, "architecture-wall-wide")
    if theme == "campus":
        box("WideWallCore", (4.0, .21, 2.34), (x, 0, 1.17), m["concrete"], owner, bevel=.018)
        box("WideWainscot", (3.96, .255, .7), (x, -.025, .4), m["wood"], owner, bevel=.025)
        box("WideChairRail", (4.02, .3, .095), (x, -.045, .81), m["brass"], owner, bevel=.014)
        profile_prism(
            "WideLibraryCrown",
            ((-2.04, 2.18), (-1.62, 2.34), (-1.02, 2.34), (-.7, 2.48),
             (0, 2.68), (.7, 2.48), (1.02, 2.34), (1.62, 2.34), (2.04, 2.18)),
            x, -.025, .29, m["navy"], owner, bevel=.022,
        )
        for px in (-1.86, 0, 1.86):
            box(f"WidePilaster_{px}", (.13, .3, 2.22), (x + px, -.045, 1.11), m["navy"], owner, bevel=.012)
        for index, px in enumerate((-1.18, 0, 1.18)):
            frame_mat = m["wood_dark"] if index != 1 else m["steel"]
            box(f"WideDisplayFrame_{index}", (.88, .075, .72), (x + px, -.17, 1.5), frame_mat, owner, bevel=.03)
            box(f"WideDisplayInset_{index}", (.72, .025, .55), (x + px, -.225, 1.5), m["black" if index != 1 else "glass"], owner, bevel=.016)
            box(f"WideDisplayLabel_{index}", (.4, .018, .09), (x + px, -.248, 1.72), m["paper" if index != 1 else "screen"], owner, bevel=.006)
            cylinder(f"WideDisplayMedallion_{index}", .095, .035, (x + px, -.235, 2.0), m["brass"], owner, rotation=(math.pi / 2, 0, 0), vertices=24, bevel=.006)
    elif theme == "hospital":
        box("WideWallCore", (4.0, .2, 2.34), (x, 0, 1.17), m["linoleum"], owner, bevel=.016)
        box("WideLowerPanel", (3.98, .25, .66), (x, -.02, .39), m["hospital_teal"], owner, bevel=.018)
        box("WideKickPlate", (4.0, .28, .17), (x, -.04, .105), m["steel_light"], owner, bevel=.008)
        box("WideWayfindingBand", (4.0, .285, .14), (x, -.045, 1.48), m["hospital_teal"], owner, bevel=.008)
        cylinder("WideHandrail", .044, 3.72, (x, -.205, .9), m["chrome"], owner, rotation=(0, math.pi / 2, 0), vertices=18, bevel=.008)
        profile_prism(
            "WideCovedHeader",
            ((-2.02, 2.18), (-1.72, 2.36), (-1.18, 2.48), (-.55, 2.53),
             (.55, 2.53), (1.18, 2.48), (1.72, 2.36), (2.02, 2.18)),
            x, -.02, .28, m["hospital_teal"], owner, bevel=.028,
        )
        for index, px in enumerate((-1.25, 0, 1.25)):
            box(f"WideObservationFrame_{index}", (.92, .08, .68), (x + px, -.16, 1.83), m["steel_light"], owner, bevel=.025)
            box(f"WideObservationGlass_{index}", (.76, .022, .52), (x + px, -.22, 1.83), m["glass"], owner, bevel=.018)
            cylinder(f"WideHeaderLamp_{index}", .055, .04, (x + px, -.2, 2.36), m["screen"], owner, rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.006)
    elif theme == "fire":
        box("WideWallCore", (4.0, .2, 2.34), (x, 0, 1.17), m["brick_fire"], owner, bevel=.012)
        box("WideSteelBase", (4.0, .28, .37), (x, -.035, .22), m["black"], owner, bevel=.012)
        add_hazard_band(owner, m, x - .98, -.198, .51, width=1.92, prefix="WideFireHazardLeft")
        add_hazard_band(owner, m, x + .98, -.198, .51, width=1.92, prefix="WideFireHazardRight")
        profile_prism(
            "WideFireTruss",
            ((-2.05, 2.15), (-1.58, 2.5), (-.96, 2.26), (-.34, 2.56),
             (.34, 2.3), (.96, 2.57), (1.58, 2.3), (2.05, 2.18), (2.05, 2.1), (-2.05, 2.1)),
            x, -.02, .31, m["steel_dark"], owner, bevel=.018,
        )
        for px in (-1.86, 0, 1.86):
            box(f"WideFireColumn_{px}", (.15, .31, 2.18), (x + px, -.04, 1.09), m["fire_red"], owner, bevel=.014)
        for index, px in enumerate((-1.18, 0, 1.18)):
            box(f"WideFireServiceFrame_{index}", (.8, .085, .72), (x + px, -.17, 1.48), m["fire_red"], owner, bevel=.03)
            arch_band(f"WideFireHose_{index}", x + px, -.235, 1.34, .27, .045, .07, m["hose"], owner, segments=12)
            cylinder(f"WideFireBell_{index}", .075, .035, (x + px, -.23, 1.86), m["brass"], owner, rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.006)
    else:
        box("WideWallCore", (4.0, .21, 2.34), (x, 0, 1.17), m["concrete_dark"], owner, bevel=.01)
        box("WideLowerArmor", (3.98, .28, .7), (x, -.035, .39), m["factory_blue"], owner, bevel=.008)
        for col in range(21):
            px = x - 1.8 + col * .18
            box(f"WideCorrugation_{col}", (.045, .3, 2.12), (px, -.04, 1.15), m["steel"], owner, bevel=.006)
        add_hazard_band(owner, m, x - .98, -.21, .78, width=1.92, prefix="WideFactoryHazardLeft")
        add_hazard_band(owner, m, x + .98, -.21, .78, width=1.92, prefix="WideFactoryHazardRight")
        profile_prism(
            "WideSawtoothCrown",
            ((-2.04, 2.14), (-1.63, 2.55), (-1.2, 2.2), (-.75, 2.5),
             (-.3, 2.2), (.18, 2.58), (.64, 2.2), (1.1, 2.5), (1.56, 2.2),
             (2.04, 2.45), (2.04, 2.11), (-2.04, 2.11)),
            x, -.02, .32, m["steel_dark"], owner, bevel=.016,
        )
        for px in (-1.86, 0, 1.86):
            box(f"WideFactoryColumn_{px}", (.16, .32, 2.2), (x + px, -.04, 1.1), m["hazard_yellow"], owner, bevel=.012)
        for index, px in enumerate((-1.2, 0, 1.2)):
            box(f"WideFactoryPanel_{index}", (.76, .11, .72), (x + px, -.19, 1.48), m["steel_dark"], owner, bevel=.03)
            box(f"WideFactoryInset_{index}", (.6, .03, .54), (x + px, -.255, 1.48), m["factory_blue" if index != 1 else "black"], owner, bevel=.016)
            box(f"WideFactoryStatus_{index}", (.31, .025, .08), (x + px, -.278, 1.72), m["screen" if index == 1 else "hazard_yellow"], owner, bevel=.006)
    owner["chasing_continuous_span_meters"] = 4.0
    return owner


def build_wall_end(collection, m, theme: str, name: str, x: float) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, "architecture-wall-end")
    add_wall_shell(owner, m, theme, x)
    post_mat = m["navy"] if theme == "campus" else m["hospital_teal"] if theme == "hospital" else m["fire_red"] if theme == "fire" else m["hazard_yellow"]
    for px in (-.91, .91):
        box(f"EndPost_{px}", (.18, .36, 2.42), (x + px, -.055, 1.21), post_mat, owner, bevel=.025)
        box(f"EndPostFoot_{px}", (.28, .43, .13), (x + px, -.055, .07), m["steel_dark"], owner, bevel=.018)
        add_fastener_line(owner, m, x=x+px, y=-.285, z=1.18, count=4, spacing=.38, horizontal=False, prefix=f"EndPostBolt_{px}")
    box("EndCapPlaque", (.72, .04, .24), (x, -.2, 1.88), post_mat, owner, bevel=.025)
    return owner


def build_architecture_corner(collection, m, theme: str, name: str, x: float) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, "architecture-corner")
    post_mat = m["navy"] if theme == "campus" else m["hospital_teal"] if theme == "hospital" else m["fire_red"] if theme == "fire" else m["factory_blue"]
    box("CornerCore", (.38, .38, 2.42), (x, 0, 1.21), m["concrete_dark" if theme in ("fire", "factory") else "concrete"], owner, bevel=.025)
    for angle, (dx, dy) in enumerate(((.18, 0), (-.18, 0), (0, .18), (0, -.18))):
        box(f"CornerTrim_{angle}", (.07 if dx else .34, .34 if dx else .07, 2.3), (x + dx, dy, 1.18), post_mat, owner, bevel=.012)
    box("CornerFoot", (.52, .52, .16), (x, 0, .08), m["steel_dark"], owner, bevel=.025)
    box("CornerCap", (.49, .49, .15), (x, 0, 2.41), m["brass" if theme == "campus" else "steel_light"], owner, bevel=.025)
    cylinder("CornerBeacon", .085, .12, (x, -.245, 2.12), m["screen" if theme in ("campus", "hospital") else "beacon" if theme == "fire" else "lamp"], owner, rotation=(math.pi / 2, 0, 0), vertices=20, bevel=.012)
    return owner


def build_architecture_doorway(collection, m, theme: str, name: str, x: float) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, "architecture-doorway")
    frame_mat = m["navy"] if theme == "campus" else m["hospital_teal"] if theme == "hospital" else m["fire_red"] if theme == "fire" else m["factory_blue"]
    for px in (-.84, .84):
        box(f"DoorJamb_{px}", (.3, .34, 2.35), (x + px, 0, 1.175), frame_mat, owner, bevel=.028)
        box(f"DoorJambFoot_{px}", (.38, .42, .14), (x + px, 0, .07), m["steel_dark"], owner, bevel=.018)
    box("DoorLintel", (2.0, .36, .36), (x, 0, 2.18), frame_mat, owner, bevel=.03)
    box("DoorHeaderLight", (.62, .055, .13), (x, -.205, 2.2), m["screen" if theme != "fire" else "beacon"], owner, bevel=.02)
    if theme == "hospital":
        for px in (-.4, .4):
            box(f"SlidingDoor_{px}", (.76, .12, 1.88), (x + px, .08, 1.04), m["linoleum"], owner, bevel=.025)
            box(f"DoorGlass_{px}", (.42, .025, .72), (x + px, -.005, 1.38), m["glass"], owner, bevel=.018)
        box("HospitalCrossV", (.13, .025, .4), (x, -.22, 2.2), m["white"], owner, bevel=.012)
        box("HospitalCrossH", (.4, .025, .13), (x, -.22, 2.2), m["white"], owner, bevel=.012)
    elif theme == "fire":
        box("FireDoor", (1.5, .12, 1.9), (x, .08, 1.03), m["steel_dark"], owner, bevel=.022)
        for index in range(7):
            box(f"FireDoorSlat_{index}", (1.4, .035, .07), (x, -.005, .35 + index * .23), m["steel"], owner, bevel=.008)
        add_hazard_band(owner, m, x, -.03, .25, width=1.35, prefix="DoorHazard")
    elif theme == "factory":
        box("FactoryDoor", (1.5, .12, 1.9), (x, .08, 1.03), m["factory_blue"], owner, bevel=.022)
        for px in (-.48, 0, .48):
            box(f"FactoryDoorRib_{px}", (.06, .035, 1.72), (x + px, -.005, 1.05), m["steel"], owner, bevel=.008)
        box("FactoryDoorWindow", (.62, .025, .34), (x, -.015, 1.48), m["smoke_glass"], owner, bevel=.018)
    else:
        box("CampusDoor", (1.5, .12, 1.9), (x, .08, 1.03), m["wood"], owner, bevel=.028)
        box("CampusDoorInset", (1.22, .035, 1.55), (x, -.005, .98), m["navy"], owner, bevel=.018)
        box("CampusDoorWindow", (.34, .025, .67), (x, -.025, 1.42), m["glass"], owner, bevel=.018)
        cylinder("CampusDoorHandle", .035, .17, (x + .52, -.06, .95), m["brass"], owner, rotation=(math.pi / 2, 0, 0), vertices=16, bevel=.006)
    return owner


def build_architecture_junction(collection, m, theme: str, name: str, x: float) -> bpy.types.Object:
    """Create a theme-specific overhead landmark for meaningful maze choices."""
    owner = semantic_root(name, collection, x, "architecture-junction")
    frame_mat = m["navy"] if theme == "campus" else m["hospital_teal"] if theme == "hospital" else m["fire_red"] if theme == "fire" else m["factory_blue"]
    trim_mat = m["brass"] if theme == "campus" else m["steel_light"] if theme == "hospital" else m["steel_dark"]
    arch_band("JunctionArchEastWest", x, 0, 1.62, .9, .12, .18, frame_mat, owner, axis="x", segments=18)
    arch_band("JunctionArchNorthSouth", x, 0, 1.62, .9, .12, .18, frame_mat, owner, axis="y", segments=18)
    # Four tapered upper brackets visually carry the crossing while the lower
    # 1.62m remains clear, so the landmark never changes navigation collision.
    for index, (px, py, rotation) in enumerate(((-.76, -.76, .78), (.76, -.76, -.78), (-.76, .76, -.78), (.76, .76, .78))):
        box(
            f"JunctionKnee_{index}",
            (.42, .1, .11),
            (x + px * .72, py * .72, 2.05),
            trim_mat,
            owner,
            bevel=.025,
            rotation=(0, rotation, 0),
        )
    cylinder("JunctionCeilingBoss", .23, .11, (x, 0, 2.55), trim_mat, owner, vertices=32, bevel=.025)
    if theme == "campus":
        box("CampusJunctionSign", (.92, .08, .3), (x, -.08, 2.08), m["blue"], owner, bevel=.045)
        text_mesh("CampusJunctionLettering", "HALL", (x, -.13, 2.08), .16, m["white"], owner)
    elif theme == "hospital":
        box("HospitalJunctionLight", (.86, .86, .055), (x, 0, 2.46), m["screen"], owner, bevel=.09)
        for angle in range(0, 360, 90):
            radians = math.radians(angle)
            box(
                f"HospitalDirectionTab_{angle}",
                (.42, .08, .18),
                (x + math.cos(radians) * .52, math.sin(radians) * .52, 2.18),
                m["white"], owner, bevel=.025, rotation=(0, -radians, 0),
            )
    elif theme == "fire":
        for axis, rotation in (("EW", (0, math.pi / 2, 0)), ("NS", (math.pi / 2, 0, 0))):
            cylinder(f"FireJunctionPipe_{axis}", .055, 1.55, (x, 0, 2.42), m["brass"], owner, rotation=rotation, vertices=20, bevel=.009)
        cylinder("FireJunctionBeacon", .105, .18, (x, 0, 2.72), m["beacon"], owner, vertices=24, bevel=.015)
    else:
        profile_prism(
            "FactoryJunctionTruss",
            ((-.92, 2.15), (-.62, 2.49), (-.18, 2.2), (.22, 2.5), (.64, 2.18), (.92, 2.42), (.92, 2.1), (-.92, 2.1)),
            x, 0, .16, m["steel_dark"], owner, bevel=.014,
        )
        add_fastener_line(owner, m, x=x, y=-.13, z=2.26, count=5, spacing=.31, prefix="FactoryJunctionRivet")
    owner["chasing_choice_landmark"] = True
    return owner


def build_floor_module(collection, m, theme: str, name: str, x: float, variant: str) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, f"floor-{variant.lower()}")
    if theme == "campus":
        base_mat = m["concrete"] if variant == "Primary" else m["wood"] if variant == "Secondary" else m["rubber"]
    elif theme == "hospital":
        base_mat = m["linoleum"] if variant != "Service" else m["hospital_teal"]
    elif theme == "fire":
        base_mat = m["epoxy_red"] if variant == "Primary" else m["concrete"] if variant == "Secondary" else m["steel_dark"]
    else:
        base_mat = m["concrete"] if variant == "Primary" else m["steel_dark"] if variant == "Secondary" else m["factory_blue"]
    box("FloorSlab", (2.0, 2.0, .1), (x, 0, .05), base_mat, owner, bevel=.012)

    if variant == "Primary":
        seam_mat = m["brass"] if theme == "campus" else m["hospital_teal"] if theme == "hospital" else m["black"]
        for offset in (-.5, 0, .5):
            box(f"FloorSeamX_{offset}", (1.92, .015, .008), (x, offset, .106), seam_mat, owner, bevel=0)
            box(f"FloorSeamY_{offset}", (.015, 1.92, .008), (x + offset, 0, .106), seam_mat, owner, bevel=0)
        if theme in ("fire", "factory"):
            cylinder("FloorDrain", .19, .012, (x + .53, -.52, .112), m["steel"], owner, vertices=24, bevel=.004)
            for index in range(4):
                box(f"DrainSlot_{index}", (.25, .025, .006), (x + .53, -.62 + index * .065, .12), m["black"], owner, bevel=0)
    elif variant == "Secondary":
        if theme == "campus":
            for offset in (-.72, -.36, 0, .36, .72):
                box(f"WoodJoint_{offset}", (.014, 1.9, .009), (x + offset, 0, .108), m["wood_dark"], owner, bevel=0)
        elif theme == "hospital":
            for index, offset in enumerate((-.72, -.24, .24, .72)):
                box(f"WardInlay_{index}", (.16, 1.9, .009), (x + offset, 0, .108), m["hospital_teal" if index % 2 == 0 else "white"], owner, bevel=.004)
        else:
            for offset in (-.75, -.45, -.15, .15, .45, .75):
                box(f"GrateBar_{offset}", (.11, 1.88, .055), (x + offset, 0, .13), m["steel"], owner, bevel=.012)
            for offset in (-.72, 0, .72):
                box(f"GrateCross_{offset}", (1.88, .09, .055), (x, offset, .132), m["steel_dark"], owner, bevel=.01)
    else:
        add_hazard_band(owner, m, x, -.66, .114, width=1.82, prefix="ServiceHazardNorth", floor=True)
        add_hazard_band(owner, m, x, .66, .114, width=1.82, prefix="ServiceHazardSouth", floor=True)
        for px in (-.78, .78):
            cylinder(f"ServiceAnchor_{px}", .035, .015, (x + px, 0, .12), m["brass"], owner, vertices=12, bevel=0)
    return owner


def build_exterior_ground(collection, m, theme: str, name: str, x: float) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, "exterior-ground")
    ground_mat = m["grass"] if theme == "campus" else m["concrete"]
    box("ExteriorGroundSlab", (2.0, 2.0, .09), (x, 0, .045), ground_mat, owner, bevel=.012)
    if theme == "campus":
        for index, (px, py, radius) in enumerate(((-.55, .42, .13), (.58, -.31, .1), (.18, .67, .07))):
            cylinder(f"ExteriorPatch_{index}", radius, .012, (x + px, py, .098), m["concrete_dark"], owner, vertices=18, bevel=0)
        box("ExteriorCurb", (2.0, .2, .16), (x, -.9, .12), m["concrete"], owner, bevel=.018)
    else:
        for index, (start_x, start_y, length, angle) in enumerate(((-.65, .38, .72, .32), (.42, -.22, .58, -.48), (-.2, -.62, .46, .68))):
            box(f"GroundCrack_{index}", (length, .022, .008), (x + start_x, start_y, .1), m["black"], owner, bevel=0, rotation=(0, 0, angle))
        if theme == "fire":
            box("BayGuide", (.12, 1.72, .009), (x, 0, .103), m["reflective"], owner, bevel=.005)
        elif theme == "factory":
            add_hazard_band(owner, m, x, -.72, .105, width=1.75, prefix="ExteriorHazard", floor=True)
        else:
            box("AmbulanceGuide", (.09, 1.65, .009), (x, 0, .103), m["hospital_teal"], owner, bevel=.004)
    return owner


def build_hide_dressing(collection, m, theme: str, name: str, x: float) -> bpy.types.Object:
    """Build a non-animated thematic surround for the shared hero locker.

    The clear central volume is 0.92m wide x 0.66m deep x 2.08m tall.  Runtime
    can place the animated locker inside without covering its DoorPivot.
    """
    owner = semantic_root(name, collection, x, "hide-dressing")
    frame_mat = m["navy"] if theme == "campus" else m["hospital_teal"] if theme == "hospital" else m["fire_red"] if theme == "fire" else m["factory_blue"]
    for px in (-.62, .62):
        box(f"HideSide_{px}", (.25, .72, 2.08), (x + px, 0, 1.04), frame_mat, owner, bevel=.035)
        box(f"HideSideInset_{px}", (.17, .035, 1.68), (x + px, -.38, 1.04), m["steel_dark"], owner, bevel=.018)
        box(f"HideFoot_{px}", (.36, .84, .13), (x + px, 0, .07), m["steel_dark"], owner, bevel=.02)
    box("HideCanopy", (1.48, .78, .2), (x, 0, 2.16), frame_mat, owner, bevel=.035)
    box("HideThreshold", (1.28, .72, .07), (x, 0, .035), m["rubber"], owner, bevel=.012)
    box("HideHeaderSign", (.76, .04, .18), (x, -.42, 2.16), m["screen" if theme in ("campus", "hospital") else "reflective"], owner, bevel=.018)

    if theme == "campus":
        for index, (px, pz, mat) in enumerate(((-.62, 1.55, "paper"), (.62, 1.25, "red"), (-.62, .72, "white"))):
            box(f"CampusLockerSticker_{index}", (.14, .018, .18), (x + px, -.405, pz), m[mat], owner, bevel=.005, rotation=(0, 0, .06 * (index - 1)))
        for px in (-.22, .22):
            cylinder(f"CampusHeaderLamp_{px}", .045, .03, (x + px, -.445, 2.17), m["lamp"], owner, rotation=(math.pi / 2, 0, 0), vertices=16, bevel=.006)
    elif theme == "hospital":
        box("HospitalHideCrossV", (.12, .025, .38), (x, -.445, 2.16), m["white"], owner, bevel=.012)
        box("HospitalHideCrossH", (.38, .025, .12), (x, -.445, 2.16), m["white"], owner, bevel=.012)
        for side in (-1, 1):
            cylinder(f"HospitalOxygenLine_{side}", .032, 1.35, (x + side * .62, -.405, 1.25), m["chrome"], owner, vertices=14, bevel=.005)
            cylinder(f"HospitalServicePort_{side}", .06, .022, (x + side * .62, -.43, 1.72), m["hospital_teal"], owner, rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.006)
    elif theme == "fire":
        add_hazard_band(owner, m, x, -.425, .19, width=1.18, prefix="HideHazard")
        for side in (-1, 1):
            cylinder(f"FireHideHook_{side}", .035, .22, (x + side * .62, -.46, 1.55), m["brass"], owner, rotation=(math.pi / 2, 0, 0), vertices=14, bevel=.006)
            box(f"FireHideCoat_{side}", (.18, .08, .64), (x + side * .62, -.49, 1.08), m["coat"], owner, bevel=.055)
            box(f"FireHideReflective_{side}", (.19, .018, .08), (x + side * .62, -.54, 1.06), m["reflective"], owner, bevel=.005)
    else:
        add_hazard_band(owner, m, x, -.425, .19, width=1.18, prefix="HideHazard")
        for side, mat in ((-1, "factory_blue"), (1, "hazard_yellow")):
            cylinder(f"FactoryHideConduit_{side}", .035, 1.42, (x + side * .62, -.43, 1.28), m[mat], owner, vertices=14, bevel=.006)
        box("FactoryHideJunction", (.34, .055, .4), (x + .62, -.435, 1.66), m["steel"], owner, bevel=.022)
        box("FactoryHideScreen", (.17, .018, .11), (x + .62, -.47, 1.73), m["screen"], owner, bevel=.006)
    return owner


def build_campus_cluster(collection, m, name: str, x: float, variant: str) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, f"dressing-cluster-{variant.lower()}")
    if variant == "A":
        # Library return cart with visible book silhouettes and caster details.
        box("LibraryCartFrame", (1.42, .68, 1.16), (x, 0, .68), m["navy"], owner, bevel=.055)
        box("LibraryCartOpen", (1.22, .58, .9), (x, -.06, .72), m["black"], owner, bevel=.028)
        for pz in (.38, .72, 1.06):
            box(f"LibraryShelf_{pz}", (1.24, .62, .055), (x, 0, pz), m["brass"], owner, bevel=.012)
        for index in range(10):
            px = x - .48 + (index % 5) * .24
            pz = .53 + (index // 5) * .35
            box(f"CartBook_{index}", (.16 + (index % 2) * .035, .42, .24), (px, -.04, pz), m[["paper", "blue", "red", "wood"][index % 4]], owner, bevel=.018, rotation=(0, 0, .025 * ((index % 3) - 1)))
        for px in (-.52, .52):
            for py in (-.25, .25):
                cylinder(f"CartCaster_{px}_{py}", .075, .045, (x + px, py, .08), m["rubber"], owner, rotation=(math.pi / 2, 0, 0), vertices=16, bevel=.006)
    elif variant == "B":
        # Notice/planter vignette breaks long school corridors with organic mass.
        cylinder("Planter", .42, .52, (x - .5, 0, .28), m["concrete_dark"], owner, vertices=28, bevel=.035)
        for index in range(9):
            angle = index * 2.39996
            sphere(f"PlanterLeaf_{index}", .24, (x - .5 + math.cos(angle) * .27, math.sin(angle) * .22, .62 + (index % 3) * .13), m["grass"], owner, (1, .62, .55))
        box("FreestandingNotice", (1.12, .11, .76), (x + .55, 0, 1.12), m["wood_dark"], owner, bevel=.035)
        box("NoticeFace", (.95, .035, .59), (x + .55, -.075, 1.12), m["black"], owner, bevel=.016)
        for index, (px, pz) in enumerate(((-.22, 1.23), (.2, 1.16), (0, .96))):
            box(f"ClusterNotice_{index}", (.3, .018, .18), (x + .55 + px, -.105, pz), m["paper" if index != 1 else "red"], owner, bevel=.005)
        for px in (.18, .92):
            cylinder(f"NoticePost_{px}", .035, .75, (x + px, .03, .42), m["steel"], owner, vertices=14, bevel=.006)
    else:
        box("SportsBench", (1.72, .48, .15), (x, 0, .46), m["wood"], owner, bevel=.035)
        for px in (-.68, .68):
            box(f"SportsBenchLeg_{px}", (.12, .38, .45), (x + px, 0, .23), m["steel_dark"], owner, bevel=.02)
        for index, px in enumerate((-.46, 0, .46)):
            box(f"SportsBag_{index}", (.42, .34, .3), (x + px, -.35 + (index % 2) * .7, .2), m[["navy", "red", "blue"][index]], owner, bevel=.09)
            torus(f"SportsBagHandle_{index}", .14, .018, (x + px, -.35 + (index % 2) * .7, .42), m["rubber"], owner, rotation=(math.pi / 2, 0, 0))
        sphere("SportsBall", .22, (x + .75, -.4, .24), m["orange"], owner)
    return owner


def build_hospital_cluster(collection, m, name: str, x: float, variant: str) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, f"dressing-cluster-{variant.lower()}")
    if variant == "A":
        box("SupplyCart", (1.12, .68, 1.22), (x, 0, .65), m["hospital_teal"], owner, bevel=.065)
        for index in range(4):
            box(f"SupplyDrawer_{index}", (.94, .035, .19), (x, -.36, .43 + index * .23), m["white"], owner, bevel=.012)
            box(f"SupplyHandle_{index}", (.28, .025, .028), (x, -.395, .43 + index * .23), m["chrome"], owner, bevel=.006)
        box("SupplyTray", (1.2, .76, .08), (x, 0, 1.3), m["steel_light"], owner, bevel=.03)
        for px in (-.42, .42):
            cylinder(f"OxygenBottle_{px}", .12, .72, (x + px, .1, 1.7), m["hospital_teal"], owner, vertices=24, bevel=.025)
            sphere(f"OxygenTop_{px}", .12, (x + px, .1, 2.06), m["hospital_teal"], owner, (1, 1, .55))
            cylinder(f"OxygenValve_{px}", .035, .14, (x + px, .1, 2.18), m["brass"], owner, vertices=14, bevel=.006)
    elif variant == "B":
        for index, px in enumerate((-.62, .62)):
            box(f"WaitingSeat_{index}", (.72, .72, .11), (x + px, 0, .48), m["hospital_blue"], owner, bevel=.06)
            box(f"WaitingBack_{index}", (.12, .72, .82), (x + px + .31, 0, .86), m["hospital_blue"], owner, bevel=.065, rotation=(0, -.08, 0))
            for py in (-.31, .31):
                box(f"WaitingLeg_{index}_{py}", (.08, .08, .45), (x + px, py, .23), m["chrome"], owner, bevel=.016)
        cylinder("WaitingTable", .38, .08, (x, -.74, .55), m["steel_light"], owner, vertices=28, bevel=.025)
        cylinder("WaitingTablePost", .05, .5, (x, -.74, .29), m["chrome"], owner, vertices=16, bevel=.008)
        for index in range(3):
            box(f"Magazine_{index}", (.34, .22, .025), (x + (index - 1) * .08, -.74 + (index - 1) * .04, .61 + index * .012), m[["paper", "blue", "red"][index]], owner, bevel=.008, rotation=(0, 0, .14 * (index - 1)))
    else:
        box("DeconStation", (1.3, .52, 1.72), (x, 0, .9), m["steel_light"], owner, bevel=.055)
        box("DeconInset", (1.06, .035, 1.34), (x, -.285, .92), m["hospital_teal"], owner, bevel=.025)
        box("DeconDispenser", (.34, .18, .5), (x - .32, -.38, 1.08), m["white"], owner, bevel=.045)
        cylinder("DeconPump", .035, .2, (x - .32, -.48, 1.38), m["chrome"], owner, rotation=(math.pi / 2, 0, 0), vertices=14, bevel=.006)
        cylinder("BiohazardBin", .28, .58, (x + .48, -.35, .31), m["red"], owner, vertices=28, bevel=.035)
        box("BiohazardLid", (.66, .54, .09), (x + .48, -.35, .63), m["black"], owner, bevel=.035)
    return owner


def build_fire_cluster(collection, m, name: str, x: float, variant: str) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, f"dressing-cluster-{variant.lower()}")
    if variant == "A":
        box("SCBARack", (1.58, .54, 1.72), (x, 0, .9), m["steel_dark"], owner, bevel=.055)
        box("SCBARackOpen", (1.37, .035, 1.42), (x, -.295, .92), m["black"], owner, bevel=.022)
        for index, px in enumerate((-.45, 0, .45)):
            cylinder(f"SCBATank_{index}", .14, .86, (x + px, -.34, .95), m["steel_light"], owner, vertices=24, bevel=.025)
            sphere(f"SCBATankCap_{index}", .14, (x + px, -.34, 1.38), m["steel_light"], owner, (1, 1, .45))
            box(f"SCBAStrap_{index}", (.32, .045, .14), (x + px, -.43, .86), m["coat"], owner, bevel=.025)
            cylinder(f"SCBAValve_{index}", .035, .14, (x + px, -.34, 1.51), m["brass"], owner, vertices=14, bevel=.006)
    elif variant == "B":
        box("FireWorkbench", (1.8, .72, .16), (x, 0, .92), m["wood"], owner, bevel=.035)
        for px in (-.72, .72):
            box(f"WorkbenchLeg_{px}", (.14, .58, .88), (x + px, 0, .45), m["steel_dark"], owner, bevel=.025)
        box("WorkbenchBack", (1.8, .12, .86), (x, .3, 1.38), m["steel_dark"], owner, bevel=.025)
        for index, (px, pz) in enumerate(((-.55, 1.55), (-.18, 1.27), (.2, 1.52), (.58, 1.27))):
            cylinder(f"Tool_{index}", .028, .42, (x + px, .22, pz), m["chrome" if index % 2 == 0 else "fire_red"], owner, vertices=12, bevel=.005, rotation=(0, .1 * (index - 1), 0))
        box("WorkbenchCase", (.62, .42, .28), (x + .35, -.12, 1.12), m["fire_red"], owner, bevel=.045)
    else:
        for index, px in enumerate((-.62, 0, .62)):
            bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=.26, radius2=.08, depth=.76, location=(x + px, 0, .42))
            cone = bpy.context.object
            cone.name = f"ClusterCone_{index}"
            cone.data.materials.append(m["orange"])
            link_to_collection(cone, collection)
            parent(cone, owner)
            box(f"ConeStripe_{index}", (.32, .32, .1), (x + px, 0, .47), m["reflective"], owner, bevel=.02)
            box(f"ConeBase_{index}", (.56, .56, .07), (x + px, 0, .055), m["rubber"], owner, bevel=.025)
        for index, py in enumerate((-.44, .44)):
            torus(f"RolledHose_{index}", .35, .06, (x, py, .42), m["hose"], owner)
            cylinder(f"HoseNozzle_{index}", .075, .42, (x + .42, py, .22), m["brass"], owner, rotation=(0, math.pi / 2, 0), vertices=18, bevel=.012)
    return owner


def build_factory_cluster(collection, m, name: str, x: float, variant: str) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, f"dressing-cluster-{variant.lower()}")
    if variant == "A":
        box("Pallet", (1.85, 1.05, .13), (x, 0, .09), m["wood"], owner, bevel=.02)
        for px in (-.68, 0, .68):
            box(f"PalletRunner_{px}", (.18, 1.05, .18), (x + px, 0, .16), m["wood_dark"], owner, bevel=.018)
        for index, px in enumerate((-.5, .5)):
            cylinder(f"ChemicalDrum_{index}", .38, 1.06, (x + px, 0, .78), m["factory_blue" if index == 0 else "hazard_yellow"], owner, vertices=32, bevel=.035)
            for pz in (.3, .77, 1.26):
                torus(f"DrumBand_{index}_{pz}", .385, .025, (x + px, 0, pz), m["steel_dark"], owner)
            box(f"DrumLabel_{index}", (.31, .025, .28), (x + px, -.39, .82), m["paper"], owner, bevel=.012)
    elif variant == "B":
        cylinder("CableSpoolCore", .18, .92, (x - .45, 0, .55), m["wood_dark"], owner, rotation=(math.pi / 2, 0, 0), vertices=24, bevel=.02)
        for py in (-.49, .49):
            cylinder(f"CableSpoolDisc_{py}", .58, .09, (x - .45, py, .55), m["wood"], owner, rotation=(math.pi / 2, 0, 0), vertices=28, bevel=.025)
        for radius in (.4, .34, .28):
            torus(f"CableLoop_{radius}", radius, .055, (x - .45, -.56, .55), m["rubber"], owner, rotation=(math.pi / 2, 0, 0))
        box("ToolCart", (.82, .58, 1.08), (x + .65, 0, .59), m["factory_blue"], owner, bevel=.055)
        for index in range(4):
            box(f"ToolDrawer_{index}", (.68, .035, .17), (x + .65, -.31, .42 + index * .2), m["steel"], owner, bevel=.012)
        box("ToolCartTop", (.92, .68, .08), (x + .65, 0, 1.16), m["steel_light"], owner, bevel=.025)
    else:
        for index, px in enumerate((-.58, .58)):
            box(f"ElectricalCabinet_{index}", (.82, .52, 1.58), (x + px, 0, .82), m["steel_dark"], owner, bevel=.055)
            box(f"ElectricalDoor_{index}", (.68, .035, 1.34), (x + px, -.285, .84), m["factory_blue"], owner, bevel=.025)
            box(f"ElectricalScreen_{index}", (.3, .022, .16), (x + px, -.315, 1.27), m["screen"], owner, bevel=.008)
            add_fastener_line(owner, m, x=x+px, y=-.32, z=.42, count=3, spacing=.22, prefix=f"CabinetButton_{index}")
        for side, mat in ((-1, "factory_blue"), (1, "hazard_yellow")):
            cylinder(f"CabinetConduit_{side}", .045, 1.42, (x + side * 1.02, 0, .78), m[mat], owner, vertices=14, bevel=.006)
    return owner


def build_dressing_clusters(collection, m, theme: str, prefix: str, start_x: float) -> list[bpy.types.Object]:
    builders = {
        "campus": build_campus_cluster,
        "hospital": build_hospital_cluster,
        "fire": build_fire_cluster,
        "factory": build_factory_cluster,
    }
    builder = builders[theme]
    return [
        builder(collection, m, f"{prefix}DressingCluster{variant}", start_x + index * 4.5, variant)
        for index, variant in enumerate(("A", "B", "C"))
    ]


def story_root(
    name: str,
    collection: bpy.types.Collection,
    x: float,
    prop_set: str,
    role: str,
    motif: str,
) -> bpy.types.Object:
    owner = semantic_root(name, collection, x, f"campaign-{role}")
    owner["chasing_prop_set"] = prop_set
    owner["chasing_story_role"] = role
    owner["chasing_motif"] = motif
    owner["chasing_unique_signature"] = name
    return owner


def story_materials(theme: str, m) -> tuple:
    if theme == "campus":
        return m["navy"], m["blue"], m["brass"], m["wood"], m["paper"], m["lamp"]
    if theme == "hospital":
        return m["hospital_teal"], m["hospital_blue"], m["chrome"], m["white"], m["paper"], m["screen"]
    if theme == "fire":
        return m["fire_red"], m["coat"], m["reflective"], m["steel_dark"], m["paper"], m["beacon"]
    return m["factory_blue"], m["hazard_yellow"], m["steel_light"], m["steel_dark"], m["paper"], m["screen"]


def instance_story_meshes(
    source_name: str,
    owner: bpy.types.Object,
    collection: bpy.types.Collection,
    location: tuple[float, float, float],
    *,
    rotation: float = 0.0,
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> int:
    """Recompose a polished hero hierarchy inside a story cluster.

    Mesh datablocks remain shared in the Blender master, while each copied
    object gets a new authored transform and provenance marker.  The story
    root also contains its own construction pieces, so this can never degrade
    into a same-node compatibility alias.
    """
    source = bpy.data.objects.get(source_name)
    if source is None:
        raise RuntimeError(f"Missing story source hierarchy: {source_name}")
    target = (
        Matrix.Translation(Vector(location))
        @ Matrix.Rotation(rotation, 4, "Z")
        @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1.0)))
    )
    source_inverse = source.matrix_world.inverted()
    copied = 0

    def visit(branch: bpy.types.Object) -> None:
        nonlocal copied
        for child in branch.children:
            if child.type == "MESH":
                duplicate = child.copy()
                duplicate.data = child.data
                duplicate.name = f"{owner.name}_{source_name}_{copied:02d}"
                duplicate["chasing_reused_from"] = source_name
                collection.objects.link(duplicate)
                duplicate.matrix_world = target @ source_inverse @ child.matrix_world
                duplicate.parent = owner
                duplicate.matrix_parent_inverse = owner.matrix_world.inverted()
                copied += 1
            visit(child)

    visit(source)
    if copied == 0:
        raise RuntimeError(f"Story source hierarchy contains no meshes: {source_name}")
    owner["chasing_reuses"] = source_name
    return copied


def build_story_landmark(collection, m, theme: str, spec, name: str, motif: str, x: float) -> bpy.types.Object:
    owner = story_root(name, collection, x, spec["prop_set"], "landmark", motif)
    accent, secondary, trim, dark, light, glow = story_materials(theme, m)
    tag = owner.name

    def b(part, size, location, mat, *, bevel=.035, rotation=(0, 0, 0)):
        return box(f"{tag}_{part}", size, location, mat, owner, bevel=bevel, rotation=rotation)

    def c(part, radius, depth, location, mat, *, rotation=(0, 0, 0), vertices=24, bevel=.018):
        return cylinder(f"{tag}_{part}", radius, depth, location, mat, owner, rotation=rotation, vertices=vertices, bevel=bevel)

    def s(part, radius, location, mat, scale=(1, 1, 1)):
        return sphere(f"{tag}_{part}", radius, location, mat, owner, scale)

    def t(part, major, minor, location, mat, *, rotation=(0, 0, 0)):
        return torus(f"{tag}_{part}", major, minor, location, mat, owner, rotation=rotation)

    if motif == "classroom":
        b("DeskTop", (2.15, .82, .12), (x, 0, .82), m["wood"], bevel=.045)
        b("DeskApron", (1.92, .1, .58), (x, .34, .5), accent, bevel=.025)
        for side in (-.86, .86):
            b(f"DeskLeg_{side}", (.11, .65, .78), (x + side, 0, .4), trim, bevel=.018)
        b("ChairSeat", (.65, .62, .12), (x, -.82, .47), secondary, bevel=.055)
        b("ChairBack", (.68, .11, .7), (x, -1.07, .84), secondary, bevel=.06, rotation=(-.08, 0, 0))
        b("LessonBook", (.52, .34, .055), (x - .45, -.08, .92), light, bevel=.012, rotation=(0, 0, -.08))
    elif motif == "courtyard":
        c("Planter", .48, .58, (x - .58, 0, .3), m["concrete_dark"], vertices=28, bevel=.035)
        for index, offset in enumerate(((-.18, -.05, .74), (.18, .02, .85), (0, .18, 1.0))):
            s(f"Plant_{index}", .29, (x - .58 + offset[0], offset[1], offset[2]), m["grass"], (1, .65, .58))
        b("BenchSeat", (1.45, .52, .14), (x + .62, 0, .48), m["wood"], bevel=.04)
        for side in (.12, 1.12):
            b(f"BenchLeg_{side}", (.11, .4, .46), (x + side, 0, .24), trim, bevel=.018)
        b("CampusPlaque", (.78, .06, .44), (x + .62, .23, 1.05), accent, bevel=.03)
    elif motif == "heritage":
        b("Plinth", (1.55, .78, .32), (x, 0, .16), m["wood_dark"], bevel=.055)
        b("Display", (1.3, .42, 1.12), (x, 0, .86), accent, bevel=.06)
        b("Glass", (1.08, .035, .86), (x, -.235, .9), m["glass"], bevel=.02)
        for index, px in enumerate((-.35, 0, .35)):
            c(f"TrophyStem_{index}", .035, .38 + index * .08, (x + px, -.28, .82), trim, vertices=16, bevel=.005)
            s(f"TrophyCup_{index}", .12, (x + px, -.28, 1.08 + index * .04), m["gold"], (1.25, .72, .8))
    elif motif == "library-shelves":
        for side in (-.88, .88):
            b(f"BookcaseSide_{side}", (.13, .62, 2.05), (x + side, 0, 1.04), m["wood_dark"], bevel=.025)
        for index, pz in enumerate((.18, .62, 1.06, 1.5, 1.94)):
            b(f"Shelf_{index}", (1.82, .66, .09), (x, 0, pz), m["wood"], bevel=.016)
        for index, (px, pz, mat) in enumerate(((-.55, .4, "red"), (-.1, .84, "paper"), (.42, 1.28, "blue"), (.08, 1.72, "wood"))):
            b(f"BookBank_{index}", (.42, .5, .27), (x + px, -.05, pz), m[mat], bevel=.018, rotation=(0, 0, .025 * (index - 1)))
    elif motif == "reading":
        c("ReadingTable", .62, .1, (x, 0, .68), m["wood"], vertices=32, bevel=.035)
        c("TablePost", .075, .64, (x, 0, .34), trim, vertices=18, bevel=.01)
        for index, angle in enumerate((0, math.tau / 3, math.tau * 2 / 3)):
            px, py = math.cos(angle) * 1.0, math.sin(angle) * 1.0
            b(f"Seat_{index}", (.55, .55, .12), (x + px, py, .45), secondary, bevel=.055, rotation=(0, 0, angle))
            b(f"Back_{index}", (.58, .11, .62), (x + px * 1.16, py * 1.16, .76), accent, bevel=.055, rotation=(0, 0, angle))
        b("OpenBook", (.56, .4, .045), (x, -.08, .75), light, bevel=.012, rotation=(0, 0, .12))
    elif motif == "archive":
        for index, px in enumerate((-.72, 0, .72)):
            b(f"ArchiveCabinet_{index}", (.62, .52, 1.78), (x + px, 0, .9), accent if index != 1 else secondary, bevel=.045)
            b(f"ArchiveLabel_{index}", (.28, .025, .12), (x + px, -.275, 1.42), light, bevel=.008)
        for side in (-.98, .98):
            c(f"LadderRail_{side}", .035, 1.82, (x + side, -.42, 1.02), trim, vertices=14, bevel=.005)
        for index in range(4):
            b(f"LadderRung_{index}", (1.92, .07, .055), (x, -.42, .38 + index * .38), trim, bevel=.008)
    elif motif == "lab-bench":
        b("LabBase", (2.18, .78, .72), (x, 0, .38), accent, bevel=.045)
        b("LabTop", (2.32, .9, .12), (x, 0, .81), m["steel_light"], bevel=.035)
        c("Sink", .27, .07, (x - .58, -.05, .89), m["steel_dark"], vertices=28, bevel=.012)
        c("Tap", .035, .46, (x - .78, .05, 1.08), trim, vertices=14, bevel=.006)
        b("ReagentRail", (1.0, .16, .45), (x + .48, .26, 1.1), dark, bevel=.025)
        for index, px in enumerate((.15, .48, .81)):
            c(f"Flask_{index}", .075, .28 + index * .05, (x + px, .12, 1.06), m[["cyan", "red", "medical_bag"][index]], vertices=18, bevel=.008)
    elif motif == "fume-hood":
        b("HoodBody", (1.86, .76, 2.1), (x, 0, 1.06), dark, bevel=.045)
        b("WorkChamber", (1.58, .035, .92), (x, -.405, 1.16), m["glass"], bevel=.02)
        b("LowerCabinet", (1.66, .68, .64), (x, 0, .34), accent, bevel=.035)
        b("HoodCrown", (1.95, .82, .27), (x, 0, 2.08), secondary, bevel=.035)
        c("VentStack", .22, .64, (x, .12, 2.48), m["steel"], vertices=24, bevel=.02)
        b("ControlGlow", (.22, .025, .32), (x + .63, -.43, 1.77), glow, bevel=.01)
    elif motif == "greenhouse":
        b("PlanterBed", (2.05, .95, .48), (x, 0, .25), m["wood_dark"], bevel=.04)
        b("Soil", (1.88, .78, .08), (x, 0, .51), m["concrete_dark"], bevel=.016)
        for side in (-.86, .86):
            b(f"GlassPost_{side}", (.07, .08, 1.58), (x + side, 0, 1.25), trim, bevel=.01)
        b("GlassRoof", (1.95, .78, .06), (x, 0, 2.03), m["glass"], bevel=.018, rotation=(0, .08, 0))
        for index, px in enumerate((-.58, 0, .58)):
            s(f"Specimen_{index}", .3, (x + px, -.04, .82 + index * .12), m["grass"], (1, .72, .62))
    elif motif == "triage":
        b("TriageDesk", (2.12, .82, .78), (x, 0, .42), accent, bevel=.06)
        b("CounterTop", (2.28, .94, .12), (x, 0, .86), m["steel_light"], bevel=.04)
        b("PrivacyWing", (.72, .12, 1.15), (x - .7, .34, 1.32), secondary, bevel=.045)
        b("Monitor", (.68, .16, .5), (x + .42, -.12, 1.23), dark, bevel=.035)
        b("MonitorGlow", (.54, .025, .34), (x + .42, -.22, 1.26), glow, bevel=.012)
        c("VitalsPole", .045, 1.52, (x + .92, .2, .88), trim, vertices=16, bevel=.006)
        b("Chart", (.46, .32, .035), (x - .08, -.12, .96), light, bevel=.01, rotation=(0, 0, -.1))
    elif motif == "waiting":
        b("SeatBeam", (2.38, .18, .18), (x, .08, .48), trim, bevel=.025)
        for index, px in enumerate((-.78, 0, .78)):
            b(f"Seat_{index}", (.66, .62, .13), (x + px, 0, .51), secondary, bevel=.055)
            b(f"Back_{index}", (.66, .12, .75), (x + px, .27, .9), secondary, bevel=.06, rotation=(.06, 0, 0))
        c("SideTable", .31, .08, (x + 1.22, -.15, .6), m["steel_light"], vertices=28, bevel=.02)
        c("TablePost", .045, .55, (x + 1.22, -.15, .31), trim, vertices=14, bevel=.006)
    elif motif == "pharmacy":
        b("PharmacyCase", (2.05, .62, 1.92), (x, 0, .98), m["white"], bevel=.045)
        b("GlassFront", (1.82, .035, 1.6), (x, -.33, 1.02), m["glass"], bevel=.018)
        for index, pz in enumerate((.38, .78, 1.18, 1.58)):
            b(f"Shelf_{index}", (1.84, .56, .065), (x, 0, pz), trim, bevel=.012)
        for index, px in enumerate((-.58, -.2, .2, .58)):
            c(f"BottleBank_{index}", .075, .32 + (index % 2) * .12, (x + px, -.2, .63 + (index % 2) * .42), m[["medical_bag", "hospital_teal", "white", "cyan"][index]], vertices=18, bevel=.008)
        # The chase camera can legitimately see the service side while the
        # cabinet faces the corridor. Give that side the same authored finish
        # as the display front instead of exposing a featureless white slab.
        b("PharmacyBackInset", (1.82, .035, 1.6), (x, .33, 1.02), dark, bevel=.018)
        b("PharmacyBackHeader", (1.68, .035, .25), (x, .355, 1.7), accent, bevel=.022)
        for index, px in enumerate((-.57, 0, .57)):
            b(f"PharmacyServicePanel_{index}", (.5, .028, 1.08), (x + px, .36, .92), secondary, bevel=.025)
            b(f"PharmacyPanelRail_{index}", (.055, .032, 1.14), (x + px - .25, .375, .92), trim, bevel=.008)
        for index, pz in enumerate((.52, .67, .82, .97)):
            b(f"PharmacyVent_{index}", (.38, .026, .035), (x + .57, .39, pz), trim, bevel=.006)
        b("PharmacyServiceCrossV", (.095, .028, .38), (x - .57, .39, 1.05), m["white"], bevel=.009)
        b("PharmacyServiceCrossH", (.38, .028, .095), (x - .57, .39, 1.05), m["white"], bevel=.009)
        c("PharmacyServiceLatch", .055, .035, (x, .4, .54), m["chrome"], rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.006)
    elif motif == "decon":
        b("DeconPan", (1.82, 1.0, .14), (x, 0, .08), m["steel_light"], bevel=.035)
        for side in (-.78, .78):
            b(f"ShowerPost_{side}", (.1, .14, 2.22), (x + side, .28, 1.13), accent, bevel=.018)
            c(f"SprayLine_{side}", .035, 1.55, (x + side, -.1, 1.3), trim, vertices=14, bevel=.006)
        b("DeconHeader", (1.76, .2, .2), (x, .28, 2.2), accent, bevel=.03)
        for side in (-.52, .52):
            c(f"Nozzle_{side}", .09, .18, (x + side, -.2, 1.82), m["hospital_teal"], rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.01)
    elif motif == "isolation-ward":
        b("WardBed", (2.22, .86, .28), (x, 0, .6), m["white"], bevel=.07)
        b("Mattress", (1.92, .76, .18), (x + .08, 0, .83), secondary, bevel=.07)
        b("Headwall", (.18, 1.05, 1.52), (x - 1.03, .08, 1.18), accent, bevel=.035)
        b("ServiceRail", (.09, .86, .45), (x - 1.15, -.05, 1.5), m["steel_light"], bevel=.02)
        b("Monitor", (.5, .12, .42), (x - .72, -.38, 1.65), dark, bevel=.03)
        b("MonitorGlow", (.38, .025, .28), (x - .72, -.455, 1.67), glow, bevel=.01)
        c("OxygenPort", .06, .03, (x - 1.17, -.2, 1.4), trim, rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.006)
    elif motif == "airlock":
        for side in (-.9, .9):
            b(f"AirlockPost_{side}", (.18, .62, 2.24), (x + side, 0, 1.12), m["steel_light"], bevel=.03)
        b("AirlockHeader", (1.98, .68, .28), (x, 0, 2.13), accent, bevel=.035)
        b("SealDoor", (1.55, .12, 1.86), (x, .12, 1.02), dark, bevel=.04)
        b("Observation", (.68, .025, .44), (x, .045, 1.47), m["glass"], bevel=.018)
        b("Threshold", (1.78, .76, .09), (x, 0, .05), m["rubber"], bevel=.015)
        s("WarningBeacon", .11, (x + .65, -.38, 2.15), glow, (1, .75, .65))
    elif motif == "engine-bay":
        b("ServiceChest", (1.72, .72, 1.05), (x, 0, .56), accent, bevel=.055)
        for index in range(4):
            b(f"Drawer_{index}", (1.5, .035, .17), (x, -.38, .3 + index * .2), m["steel"], bevel=.012)
        t("HoseLoop", .48, .075, (x + .78, -.42, 1.3), m["hose"], rotation=(math.pi / 2, 0, 0))
        c("ServiceLamp", .1, .16, (x - .65, -.44, 1.3), glow, rotation=(math.pi / 2, 0, 0), vertices=20, bevel=.01)
    elif motif == "turnout":
        b("TurnoutRack", (2.08, .58, 1.92), (x, 0, .98), dark, bevel=.05)
        b("RackOpen", (1.82, .035, 1.62), (x, -.31, 1.0), m["black"], bevel=.022)
        for index, px in enumerate((-.58, 0, .58)):
            b(f"Coat_{index}", (.42, .16, .82), (x + px, -.4, .95), secondary, bevel=.08)
            b(f"Reflective_{index}", (.44, .025, .11), (x + px, -.5, .92), trim, bevel=.008)
            s(f"Helmet_{index}", .23, (x + px, -.38, 1.63), m["helmet"], (1, .78, .72))
    elif motif == "hose-service":
        b("WashBench", (2.1, .84, .72), (x, 0, .39), m["steel_dark"], bevel=.05)
        b("WashTop", (2.22, .94, .12), (x, 0, .79), m["steel_light"], bevel=.035)
        c("Basin", .34, .08, (x - .55, -.03, .88), m["black"], vertices=28, bevel=.015)
        t("ServiceReel", .48, .07, (x + .56, .32, 1.34), m["hose"], rotation=(math.pi / 2, 0, 0))
        c("Nozzle", .085, .55, (x + .68, -.25, 1.0), trim, rotation=(0, math.pi / 2, 0), vertices=18, bevel=.012)
        b("DrainGrate", (.72, .52, .035), (x - .55, 0, .87), m["steel"], bevel=.008)
    elif motif == "training":
        b("ObstacleWall", (2.05, .34, 1.88), (x, .18, .95), dark, bevel=.035)
        b("ClimbOpening", (.76, .035, .78), (x, -.015, 1.05), m["black"], bevel=.02)
        for side in (-.78, .78):
            c(f"LadderRail_{side}", .04, 1.76, (x + side, -.28, .94), trim, vertices=14, bevel=.006)
        for index in range(4):
            b(f"LadderRung_{index}", (1.5, .08, .055), (x, -.28, .34 + index * .38), trim, bevel=.008)
        b("Target", (.45, .04, .45), (x, -.21, 1.55), accent, bevel=.02)
    elif motif == "rope-rescue":
        b("RescueBeam", (2.18, .22, .22), (x, 0, 2.05), m["steel_light"], bevel=.035)
        for side in (-.92, .92):
            b(f"TripodLeg_{side}", (.16, .18, 2.0), (x + side, 0, 1.02), dark, bevel=.025, rotation=(0, -.12 * side, 0))
        t("RopeCoil", .48, .055, (x - .45, -.2, .5), m["hose"], rotation=(math.pi / 2, 0, 0))
        c("RescueLine", .025, 1.55, (x + .28, -.08, 1.22), m["reflective"], vertices=12, bevel=.004)
        t("Carabiner", .16, .035, (x + .28, -.08, .43), trim, rotation=(math.pi / 2, 0, 0))
    elif motif == "breathing-gear":
        b("BreathingRack", (1.92, .58, 1.82), (x, 0, .93), dark, bevel=.05)
        b("RackOpen", (1.68, .035, 1.52), (x, -.31, .95), m["black"], bevel=.022)
        for index, px in enumerate((-.54, 0, .54)):
            c(f"Cylinder_{index}", .15, 1.0, (x + px, -.38, .94), m["steel_light"], vertices=24, bevel=.025)
            b(f"Harness_{index}", (.34, .045, .18), (x + px, -.49, .78), secondary, bevel=.025)
            c(f"Valve_{index}", .035, .16, (x + px, -.38, 1.5), trim, vertices=14, bevel=.006)
    elif motif == "assembly-line":
        b("ConveyorFrame", (2.55, .92, .58), (x, 0, .52), dark, bevel=.05)
        b("ConveyorBelt", (2.42, .78, .12), (x, 0, .84), m["rubber"], bevel=.025)
        for index, px in enumerate((-.9, -.3, .3, .9)):
            c(f"Roller_{index}", .09, .82, (x + px, 0, .85), trim, rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.008)
        b("PartCrate", (.58, .58, .48), (x + .52, 0, 1.13), secondary, bevel=.045)
    elif motif == "robot-cell":
        c("RobotBase", .48, .32, (x, 0, .18), accent, vertices=28, bevel=.035)
        c("RobotShoulder", .22, .88, (x, 0, .75), trim, vertices=24, bevel=.025)
        c("RobotArmA", .16, .92, (x + .35, 0, 1.23), accent, rotation=(0, .8, 0), vertices=22, bevel=.022)
        c("RobotArmB", .13, .82, (x + .82, 0, 1.58), secondary, rotation=(0, 1.18, 0), vertices=20, bevel=.018)
        s("RobotJoint", .24, (x + .55, 0, 1.38), trim)
        b("SafetyFence", (2.5, .08, 1.18), (x, .72, .62), m["hazard_yellow"], bevel=.018)
        b("CellScreen", (.42, .08, .34), (x - .92, -.2, 1.05), glow, bevel=.025)
    elif motif == "inspection":
        b("InspectionBench", (2.15, .78, .78), (x, 0, .42), m["steel_dark"], bevel=.045)
        b("SurfacePlate", (2.28, .9, .11), (x, 0, .86), m["steel_light"], bevel=.025)
        b("GaugeTower", (.36, .34, 1.28), (x - .72, .1, 1.45), accent, bevel=.035)
        c("GaugeFace", .16, .06, (x - .72, -.12, 1.72), glow, rotation=(math.pi / 2, 0, 0), vertices=24, bevel=.012)
        b("InspectionScreen", (.7, .12, .52), (x + .58, .12, 1.34), dark, bevel=.035)
        b("ScreenGlow", (.56, .025, .38), (x + .58, .04, 1.37), glow, bevel=.012)
        b("MeasuredPart", (.46, .46, .35), (x, -.1, 1.08), secondary, bevel=.045)
    elif motif == "turbine":
        c("Rotor", .5, 2.1, (x, 0, .82), m["steel_light"], rotation=(0, math.pi / 2, 0), vertices=32, bevel=.035)
        for index, px in enumerate((-.78, 0, .78)):
            t(f"RotorRing_{index}", .51, .065, (x + px, 0, .82), accent if index == 1 else dark, rotation=(0, math.pi / 2, 0))
        for side in (-.72, .72):
            b(f"TurbinePedestal_{side}", (.34, .72, .62), (x + side, 0, .33), dark, bevel=.04)
        b("TurbinePlate", (1.1, .08, .25), (x, -.58, .35), secondary, bevel=.02)
    elif motif == "high-pressure":
        for index, pz in enumerate((.48, 1.03, 1.58)):
            c(f"PressurePipe_{index}", .12 + index * .025, 2.2, (x, 0, pz), accent if index != 1 else m["steel_light"], rotation=(0, math.pi / 2, 0), vertices=24, bevel=.02)
            for px in (-.82, .82):
                t(f"Flange_{index}_{px}", .19 + index * .02, .035, (x + px, 0, pz), trim, rotation=(0, math.pi / 2, 0))
        t("ValveWheel", .29, .05, (x, -.2, 1.88), m["valve_red"], rotation=(math.pi / 2, 0, 0))
        c("ValveStem", .035, .42, (x, 0, 1.72), trim, vertices=14, bevel=.006)
    elif motif == "breaker":
        for index, px in enumerate((-.58, .58)):
            b(f"BreakerCabinet_{index}", (.94, .58, 1.82), (x + px, 0, .93), dark, bevel=.05)
            b(f"BreakerDoor_{index}", (.78, .035, 1.54), (x + px, -.31, .95), accent, bevel=.025)
            b(f"BreakerScreen_{index}", (.36, .025, .2), (x + px, -.34, 1.38), glow, bevel=.008)
            for button in range(2):
                c(f"Button_{index}_{button}", .035, .02, (x + px + (button - .5) * .18, -.35, .72), m["lamp" if button == 0 else "red"], rotation=(math.pi / 2, 0, 0), vertices=14, bevel=.004)
        c("MainConduit", .055, 1.55, (x, .38, 1.02), secondary, vertices=16, bevel=.008)
    elif motif == "furnace":
        c("FurnaceBody", .78, 1.92, (x, 0, 1.0), dark, vertices=32, bevel=.045)
        b("FurnaceOpening", (.92, .08, .9), (x, -.79, .75), m["black"], bevel=.045)
        b("MoltenGlow", (.68, .025, .62), (x, -.85, .7), m["beacon"], bevel=.03)
        for side in (-.82, .82):
            b(f"FurnaceBrace_{side}", (.18, .48, 1.86), (x + side, 0, .98), accent, bevel=.025)
        c("Exhaust", .25, .78, (x, .1, 2.31), m["steel_dark"], vertices=24, bevel=.025)
    elif motif == "casting":
        b("CastingDeck", (2.35, 1.12, .16), (x, 0, .12), dark, bevel=.035)
        c("Ladle", .58, .82, (x - .45, 0, .75), m["steel_dark"], vertices=28, bevel=.04)
        t("LadleRim", .58, .06, (x - .45, 0, 1.17), trim)
        for side in (-.88, .12):
            b(f"LadleSupport_{side}", (.16, .42, 1.25), (x + side, .35, .7), accent, bevel=.025)
        b("CastingMould", (.78, .72, .42), (x + .72, -.05, .37), secondary, bevel=.045)
        b("PourGlow", (.52, .025, .19), (x + .72, -.43, .42), m["beacon"], bevel=.015)
    elif motif == "cooling":
        c("CoolingTank", .58, 1.62, (x - .55, 0, .84), accent, vertices=32, bevel=.04)
        t("TankBandA", .59, .045, (x - .55, 0, .42), trim)
        t("TankBandB", .59, .045, (x - .55, 0, 1.28), trim)
        t("CoolingFan", .58, .07, (x + .68, -.2, 1.05), dark, rotation=(math.pi / 2, 0, 0))
        c("FanHub", .13, .12, (x + .68, -.28, 1.05), trim, rotation=(math.pi / 2, 0, 0), vertices=20, bevel=.012)
        for side in (-.32, .32):
            c(f"CoolantPipe_{side}", .075, 1.65, (x + side, .32, .62), secondary, rotation=(0, math.pi / 2, 0), vertices=18, bevel=.012)
        b("CoolingBase", (2.15, .86, .18), (x, 0, .11), dark, bevel=.03)
    else:
        raise ValueError(f"Unknown story landmark motif: {motif}")
    return owner


def build_story_arrival(collection, m, theme: str, spec, x: float, variant: int) -> bpy.types.Object:
    name = spec["arrival"]
    owner = story_root(name, collection, x, spec["prop_set"], "arrival", spec["label"].lower().replace(" ", "-"))
    accent, secondary, trim, dark, light, glow = story_materials(theme, m)
    width = 2.05 + (variant % 3) * .18
    height = 2.0 + (variant % 2) * .14
    for side in (-1, 1):
        px = x + side * width / 2
        if variant % 2:
            cylinder(f"{name}_ArrivalPost_{side}", .09, height, (px, 0, height / 2), trim, owner, vertices=18, bevel=.012)
        else:
            box(f"{name}_ArrivalPost_{side}", (.16, .28, height), (px, 0, height / 2), dark, owner, bevel=.025)
    box(f"{name}_ArrivalHeader", (width + .26, .34, .28), (x, 0, height), accent, owner, bevel=.04)
    box(f"{name}_ArrivalSign", (1.58, .045, .48), (x, -.205, height - .04), secondary, owner, bevel=.025)
    box(f"{name}_ArrivalThreshold", (width + .18, .82, .08), (x, 0, .05), m["rubber"], owner, bevel=.014)
    sphere(f"{name}_ArrivalBeacon", .1, (x + width * .34, -.22, height + .24), glow, owner, (1, .75, .65))
    text_mesh(f"{name}_ArrivalLabel", spec["label"], (x, -.24, height), .23, light, owner)

    # Explicitly close the three coverage holes found by the runtime audit.
    if spec["prop_set"] == "hospital-outpatient":
        instance_story_meshes("HospitalIVStation", owner, collection, (x + 1.65, .38, 0), scale=(.82, .82, .82))
    elif spec["prop_set"] == "fire-engine-bay":
        instance_story_meshes("FireStationWayfinding", owner, collection, (x + 1.9, .5, 0), scale=(.78, .78, .78))
    elif spec["prop_set"] == "fire-training":
        instance_story_meshes("FireSafetyCones", owner, collection, (x + 1.55, .35, 0), scale=(.8, .8, .8))
    return owner


def build_story_exit(collection, m, theme: str, spec, x: float, variant: int) -> bpy.types.Object:
    name = spec["exit"]
    owner = story_root(name, collection, x, spec["prop_set"], "exit", f"egress-{variant + 1}")
    accent, secondary, trim, dark, light, glow = story_materials(theme, m)
    width = 1.9 + (variant % 3) * .16
    for side in (-1, 1):
        box(f"{name}_ExitPier_{side}", (.22, .46, 1.74 + variant % 2 * .18), (x + side * width / 2, 0, .9), dark, owner, bevel=.035)
        cylinder(f"{name}_ExitLamp_{side}", .07, .08, (x + side * width / 2, -.28, 1.58), glow, owner, rotation=(math.pi / 2, 0, 0), vertices=18, bevel=.008)
    box(f"{name}_ExitHeader", (width + .28, .5, .28), (x, 0, 1.82), accent, owner, bevel=.04)
    box(f"{name}_ExitScreen", (.9, .035, .34), (x, -.27, 1.82), secondary, owner, bevel=.018)
    box(f"{name}_ArrowShaft", (.42, .025, .08), (x - .08, -.295, 1.82), light, owner, bevel=.006)
    box(f"{name}_ArrowHeadA", (.25, .025, .08), (x + .18, -.295, 1.9), light, owner, bevel=.006, rotation=(0, .72, 0))
    box(f"{name}_ArrowHeadB", (.25, .025, .08), (x + .18, -.295, 1.74), light, owner, bevel=.006, rotation=(0, -.72, 0))
    box(f"{name}_ExitThreshold", (width + .12, .86, .08), (x, 0, .05), trim, owner, bevel=.012)
    prop_set = spec["prop_set"]
    if prop_set == "campus-classic":
        box(f"{name}_GateCrest", (.72, .12, .24), (x, .22, 2.12), m["wood"], owner, bevel=.035)
        sphere(f"{name}_CrestMedallion", .12, (x, -.31, 2.13), m["gold"], owner, (1, .7, 1))
    elif prop_set == "campus-library":
        for side in (-1, 1):
            cylinder(f"{name}_BookScanner_{side}", .055, 1.35, (x + side * .7, -.32, .72), m["screen"], owner, vertices=16, bevel=.008)
        box(f"{name}_ReturnSlot", (.52, .05, .22), (x - .55, -.29, 1.28), m["black"], owner, bevel=.015)
    elif prop_set == "campus-science":
        cylinder(f"{name}_ExtractionDuct", .16, .82, (x + .72, .18, 2.2), m["steel"], owner, vertices=22, bevel=.018)
        box(f"{name}_EmergencyPanel", (.3, .05, .46), (x - .68, -.29, 1.22), m["red"], owner, bevel=.025)
    elif prop_set == "hospital-outpatient":
        box(f"{name}_MedicalCrossV", (.12, .03, .42), (x - .62, -.3, 1.28), m["white"], owner, bevel=.01)
        box(f"{name}_MedicalCrossH", (.42, .03, .12), (x - .62, -.3, 1.28), m["white"], owner, bevel=.01)
    elif prop_set == "hospital-isolation":
        for side in (-1, 1):
            cylinder(f"{name}_PressureSeal_{side}", .045, 1.45, (x + side * .72, -.3, .82), m["chrome"], owner, vertices=16, bevel=.006)
        sphere(f"{name}_SealStatus", .08, (x, -.31, 2.08), m["screen"], owner, (1, .7, .7))
    elif prop_set == "fire-engine-bay":
        for index, pz in enumerate((.42, .74, 1.06, 1.38)):
            box(f"{name}_ShutterRib_{index}", (1.42, .05, .08), (x, .25, pz), m["steel"], owner, bevel=.008)
    elif prop_set == "fire-training":
        for side in (-1, 1):
            box(f"{name}_TrainingBrace_{side}", (.12, .09, 1.4), (x + side * .58, .24, .78), m["reflective"], owner, bevel=.012, rotation=(0, side * .24, 0))
        torus(f"{name}_RescueMarker", .17, .035, (x, -.3, 2.1), m["hose"], owner, rotation=(math.pi / 2, 0, 0))
    elif prop_set == "factory-assembly":
        box(f"{name}_LineStatus", (.46, .05, .38), (x - .62, -.3, 1.26), m["screen"], owner, bevel=.025)
        box(f"{name}_PartCounter", (.26, .05, .18), (x + .62, -.3, 1.22), m["hazard_yellow"], owner, bevel=.018)
    elif prop_set == "factory-turbine":
        cylinder(f"{name}_EgressPipe", .09, 1.62, (x, .28, 2.13), m["factory_blue"], owner, rotation=(0, math.pi / 2, 0), vertices=20, bevel=.014)
        for side in (-.64, .64):
            torus(f"{name}_PipeFlange_{side}", .14, .035, (x + side, .28, 2.13), m["steel_light"], owner, rotation=(0, math.pi / 2, 0))
    else:
        box(f"{name}_HeatShield", (1.34, .08, .34), (x, .26, 2.12), m["steel_light"], owner, bevel=.025)
        for side in (-1, 1):
            sphere(f"{name}_HeatBeacon_{side}", .075, (x + side * .5, -.31, 2.13), m["beacon"], owner, (1, .68, .68))
    return owner


def build_story_hide(collection, m, theme: str, spec, x: float, variant: int) -> bpy.types.Object:
    name = spec["hide"]
    owner = story_root(name, collection, x, spec["prop_set"], "hide-dressing", f"hide-{variant + 1}")
    accent, secondary, trim, dark, light, glow = story_materials(theme, m)
    for side in (-1, 1):
        box(f"{name}_HideSide_{side}", (.22, .76, 2.1), (x + side * .66, 0, 1.05), accent if side < 0 else secondary, owner, bevel=.035)
        box(f"{name}_HideInset_{side}", (.14, .035, 1.68), (x + side * .66, -.4, 1.04), dark, owner, bevel=.016)
    box(f"{name}_HideCanopy", (1.5, .8, .2), (x, 0, 2.16), accent, owner, bevel=.04)
    box(f"{name}_HideThreshold", (1.28, .74, .07), (x, 0, .04), m["rubber"], owner, bevel=.012)
    box(f"{name}_HideHeader", (.78, .045, .18), (x, -.43, 2.16), glow, owner, bevel=.018)

    prop_set = spec["prop_set"]
    if prop_set == "campus-classic":
        box(f"{name}_SchoolBag", (.38, .16, .48), (x - .67, -.48, .78), m["red"], owner, bevel=.08)
        torus(f"{name}_BagHandle", .14, .02, (x - .67, -.51, 1.06), m["rubber"], owner, rotation=(math.pi / 2, 0, 0))
    elif prop_set == "campus-library":
        for index, (pz, mat) in enumerate(((.52, "blue"), (.78, "paper"), (1.02, "red"))):
            box(f"{name}_Spine_{index}", (.16, .18, .28), (x + .67, -.48, pz), m[mat], owner, bevel=.015, rotation=(0, 0, .035 * (index - 1)))
    elif prop_set == "campus-science":
        cylinder(f"{name}_GasBottle", .12, .82, (x + .67, -.48, .72), m["cyan"], owner, vertices=22, bevel=.02)
        torus(f"{name}_SafetyHose", .23, .035, (x - .67, -.49, 1.12), m["rubber"], owner, rotation=(math.pi / 2, 0, 0))
        box(f"{name}_HazardLabel", (.18, .025, .18), (x + .67, -.57, .78), m["reflective"], owner, bevel=.008)
    elif prop_set == "hospital-outpatient":
        for index, pz in enumerate((.55, .87, 1.19)):
            cylinder(f"{name}_LinenRoll_{index}", .12, .34, (x - .68, -.48, pz), m["white"], owner, rotation=(0, math.pi / 2, 0), vertices=22, bevel=.015)
    elif prop_set == "hospital-isolation":
        box(f"{name}_PressureFilter", (.3, .12, .46), (x + .67, -.48, 1.2), m["steel_light"], owner, bevel=.035)
        cylinder(f"{name}_PressureLine", .035, 1.25, (x + .67, -.48, .82), trim, owner, vertices=14, bevel=.006)
        sphere(f"{name}_StatusLamp", .065, (x + .67, -.56, 1.35), glow, owner, (1, .65, .65))
    elif prop_set == "fire-engine-bay":
        for side in (-1, 1):
            box(f"{name}_TurnoutCoat_{side}", (.18, .1, .68), (x + side * .67, -.5, 1.05), m["coat"], owner, bevel=.06)
            box(f"{name}_TurnoutStripe_{side}", (.19, .025, .09), (x + side * .67, -.57, 1.0), m["reflective"], owner, bevel=.006)
    elif prop_set == "fire-training":
        torus(f"{name}_TrainingRope", .26, .045, (x - .67, -.5, 1.06), m["hose"], owner, rotation=(math.pi / 2, 0, 0))
        torus(f"{name}_Carabiner", .12, .025, (x + .67, -.5, 1.32), trim, owner, rotation=(math.pi / 2, 0, 0))
        box(f"{name}_HeatBadge", (.2, .025, .28), (x + .67, -.55, .76), m["reflective"], owner, bevel=.01)
    elif prop_set == "factory-assembly":
        box(f"{name}_PartsBin", (.32, .22, .48), (x - .67, -.47, .72), secondary, owner, bevel=.045)
        torus(f"{name}_DriveGear", .18, .045, (x + .67, -.5, 1.08), trim, owner, rotation=(math.pi / 2, 0, 0))
    elif prop_set == "factory-turbine":
        for side, pz in ((-1, .78), (1, 1.22)):
            cylinder(f"{name}_ServicePipe_{side}", .055, 1.12, (x + side * .67, -.48, pz), accent if side < 0 else secondary, owner, vertices=16, bevel=.008)
        torus(f"{name}_Valve", .16, .035, (x + .67, -.5, 1.58), m["valve_red"], owner, rotation=(math.pi / 2, 0, 0))
    else:
        box(f"{name}_HeatShield", (.24, .1, 1.02), (x - .67, -.48, .86), m["steel_light"], owner, bevel=.025)
        add_hazard_band(owner, m, x + .67, -.5, .72, width=.34, prefix=f"{name}_FoundryHazard")
        sphere(f"{name}_HeatLamp", .075, (x + .67, -.54, 1.54), m["beacon"], owner, (1, .65, .65))
    return owner


def consolidate_story_root(owner: bpy.types.Object) -> None:
    """Bake a story root's authored pieces into one multi-material assembly.

    Runtime never addresses internal story parts by name.  Keeping dozens of
    tiny primitives as separate GLB meshes would therefore waste accessors and
    draw calls.  Reused hero meshes retain their own provenance nodes, while
    the newly authored construction is joined without changing its silhouette,
    UVs, normal response or material slots.
    """
    parts = [
        child for child in owner.children
        if child.type == "MESH" and not child.get("chasing_reused_from")
    ]
    owner["chasing_story_part_count"] = len(parts)
    owner["chasing_story_batched"] = True
    if len(parts) < 2:
        return
    # Apply each source modifier in its own object context.  Joining first
    # would carry the active object's bevel onto the complete multi-part mesh
    # and bevel the assembly a second time.
    for part in parts:
        bpy.ops.object.select_all(action="DESELECT")
        part.select_set(True)
        bpy.context.view_layer.objects.active = part
        for modifier in list(part.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    assembly = bpy.context.object
    assembly.name = f"{owner.name}_AuthoredAssembly"
    assembly["chasing_story_assembly"] = True


def build_level_story_library(collection, m, theme: str, start_x: float = 90.0) -> list[bpy.types.Object]:
    roots: list[bpy.types.Object] = []
    cursor = start_x
    for variant, spec in enumerate(LEVEL_STORY_SPECS[theme]):
        for name, motif in spec["landmarks"]:
            roots.append(build_story_landmark(collection, m, theme, spec, name, motif, cursor))
            cursor += 3.8
        roots.append(build_story_arrival(collection, m, theme, spec, cursor, variant))
        cursor += 3.8
        roots.append(build_story_exit(collection, m, theme, spec, cursor, variant))
        cursor += 3.8
        roots.append(build_story_hide(collection, m, theme, spec, cursor, variant))
        cursor += 3.8
    for owner in roots:
        consolidate_story_root(owner)
    return roots


def polish_existing_hero_props(collection, m, theme: str) -> None:
    """Add secondary/readable construction detail to the first-pass hero props."""
    if theme == "campus":
        case = bpy.data.objects.get("CampusTrophyCase")
        vend = bpy.data.objects.get("CampusVendingMachine")
        if case:
            x = case.location.x
            for px in (-.78, .78):
                box(f"TrophyCaseFrame_{px}", (.075, .49, 1.82), (x + px, 0, .98), m["brass"], case, bevel=.018)
            for px in (-.52, 0, .52):
                cylinder(f"TrophySpot_{px}", .045, .04, (x + px, -.28, 1.76), m["lamp"], case, rotation=(math.pi / 2, 0, 0), vertices=16, bevel=.006)
            box("TrophyCaseCrown", (1.7, .48, .12), (x, 0, 1.92), m["wood_dark"], case, bevel=.025)
        if vend:
            x = vend.location.x
            for index in range(5):
                box(f"VendingSideVent_{index}", (.26, .025, .035), (x + .36, -.405, .66 + index * .09), m["steel"], vend, bevel=.006)
            cylinder("VendingCoinSlot", .035, .025, (x + .38, -.43, 1.16), m["brass"], vend, rotation=(math.pi / 2, 0, 0), vertices=14, bevel=.004)
            box("VendingHeader", (.72, .035, .19), (x - .08, -.41, 1.73), m["screen"], vend, bevel=.018)
    elif theme == "hospital":
        bed = bpy.data.objects.get("HospitalBed")
        cart = bpy.data.objects.get("HospitalCrashCart")
        if bed:
            x = bed.location.x
            # Layered blanket folds break the hard-box mattress silhouette.
            for index in range(5):
                box(f"BedBlanketFold_{index}", (.18, .93, .045), (x - .2 + index * .19, 0, .88 + (index % 2) * .018), m["white"], bed, bevel=.022, rotation=(0, .015 * (index - 2), 0))
            box("BedChart", (.24, .035, .34), (x - 1.12, -.34, 1.15), m["paper"], bed, bevel=.012, rotation=(0, 0, -.08))
        if cart:
            x = cart.location.x
            box("CrashCartGuard", (.94, .72, .12), (x, 0, 1.44), m["chrome"], cart, bevel=.025)
            for index, px in enumerate((-.15, .15)):
                cylinder(f"DefibControl_{index}", .035, .02, (x + px, -.205, 1.54), m["lamp" if index == 0 else "red"], cart, rotation=(math.pi / 2, 0, 0), vertices=14, bevel=.004)
    elif theme == "fire":
        truck = bpy.data.objects.get("FireEngine")
        rack = bpy.data.objects.get("FireGearRack")
        if truck:
            x = truck.location.x
            box("TruckFrontBumper", (.18, 1.58, .22), (x - 1.87, 0, .52), m["chrome"], truck, bevel=.035)
            for py in (-.84, .84):
                box(f"TruckMirrorArm_{py}", (.3, .045, .045), (x - 1.24, py, 1.68), m["chrome"], truck, bevel=.012)
                box(f"TruckMirror_{py}", (.22, .08, .28), (x - 1.36, py, 1.72), m["smoke_glass"], truck, bevel=.035)
                for index in range(4):
                    box(f"TruckCompartment_{py}_{index}", (.38, .025, .52), (x + .16 + index * .47, py, 1.45), m["fire_red"], truck, bevel=.025)
                    box(f"TruckCompartmentHandle_{py}_{index}", (.18, .018, .025), (x + .16 + index * .47, py + (-.018 if py < 0 else .018), 1.52), m["chrome"], truck, bevel=.006)
            box("TruckRoofLine", (1.42, 1.46, .12), (x - 1.08, 0, 2.02), m["fire_red"], truck, bevel=.04)
        if rack:
            x = rack.location.x
            for index, px in enumerate((-.62, 0, .62)):
                box(f"GearNameplate_{index}", (.42, .028, .1), (x + px, -.36, 1.94), m["reflective"], rack, bevel=.008)
    else:
        pipes = bpy.data.objects.get("FactoryPipeAssembly")
        console = bpy.data.objects.get("FactoryControlConsole")
        conveyor = bpy.data.objects.get("FactoryConveyor")
        if pipes:
            x = pipes.location.x
            for index, px in enumerate((-1.12, 0, 1.12)):
                for bolt_index in range(6):
                    angle = bolt_index * math.tau / 6
                    cylinder(f"PipeFlangeBolt_{index}_{bolt_index}", .022, .055, (x + px, math.cos(angle) * .23, 1.48 + math.sin(angle) * .23), m["brass"], pipes, rotation=(0, math.pi / 2, 0), vertices=10, bevel=0)
        if console:
            x = console.location.x
            box("ConsoleEmergencyStop", (.18, .12, .18), (x + .62, -.55, 1.08), m["hazard_yellow"], console, bevel=.025)
            sphere("ConsoleEmergencyButton", .065, (x + .62, -.63, 1.12), m["red"], console, (1, .65, 1))
            box("ConsoleLabelRail", (1.28, .025, .1), (x, -.56, .89), m["paper"], console, bevel=.008)
        if conveyor:
            x = conveyor.location.x
            cylinder("ConveyorMotor", .28, .66, (x + 1.45, 0, .5), m["factory_blue"], conveyor, rotation=(math.pi / 2, 0, 0), vertices=28, bevel=.035)
            box("ConveyorMotorGuard", (.58, .78, .55), (x + 1.45, 0, .5), m["steel_dark"], conveyor, bevel=.055)


def build_production_theme_extension(collection, m, theme: str) -> None:
    prefix = THEME_PREFIX[theme]
    wall_names = [f"{prefix}ArchitectureWall{variant}" for variant in ("A", "B", "C")]
    walls = [
        build_wall_variant(collection, m, theme, wall_names[index], 40.0 + index * 3.0, variant)
        for index, variant in enumerate(("A", "B", "C"))
    ]
    wall_end = build_wall_end(collection, m, theme, f"{prefix}ArchitectureWallEnd", 49.0)
    corner = build_architecture_corner(collection, m, theme, f"{prefix}ArchitectureCorner", 52.0)
    doorway = build_architecture_doorway(collection, m, theme, f"{prefix}ArchitectureDoorway", 55.0)
    wide_wall = build_wall_wide(collection, m, theme, f"{prefix}ArchitectureWallWide", 58.0)
    junction = build_architecture_junction(collection, m, theme, f"{prefix}ArchitectureJunction", 64.0)
    floors = [
        build_floor_module(collection, m, theme, f"{prefix}Floor{variant}", 68.0 + index * 3.0, variant)
        for index, variant in enumerate(("Primary", "Secondary", "Service"))
    ]
    exterior = build_exterior_ground(collection, m, theme, f"{prefix}ExteriorGround", 78.0)
    clusters = build_dressing_clusters(collection, m, theme, prefix, 82.0)
    hide = build_hide_dressing(collection, m, theme, f"{prefix}HideDressing", 96.0)
    story_roots = build_level_story_library(collection, m, theme, 101.0)
    polish_existing_hero_props(collection, m, theme)

    # Replace the first-pass single wall node with a mesh-sharing alias of the
    # new A bay so the current renderer improves before it opts into variants.
    legacy_name = {
        "campus": "CampusArchitectureWall",
        "hospital": "HospitalArchitectureWall",
        "fire": "FireArchitectureWall",
        "factory": "FactoryArchitectureWall",
    }[theme]
    legacy = bpy.data.objects.get(legacy_name)
    if legacy:
        delete_hierarchy(legacy)
    linked_alias(walls[0], legacy_name, collection, semantic="architecture-wall-legacy")

def optimize_runtime_glb(path: Path) -> None:
    """Add explicit tangent frames and losslessly Meshopt-compress geometry.

    ``-noq`` deliberately keeps the authored floating-point vertex data.  The
    optimization therefore changes transport size, not silhouettes, UVs, or
    material response. Named nodes, material names, and extras are retained
    because the runtime uses them as a semantic placement contract.
    """
    if not GLTFPACK.is_file():
        raise RuntimeError("Pinned gltfpack is missing; run npm install before building theme kits")
    optimized = path.with_name(f".{path.stem}.meshopt.tmp.glb")
    optimized.unlink(missing_ok=True)
    try:
        subprocess.run(
            [
                str(GLTFPACK), "-i", str(path), "-o", str(optimized),
                "-c", "-gt", "-kn", "-km", "-ke", "-noq",
            ],
            check=True,
        )
        optimized.replace(path)
    finally:
        optimized.unlink(missing_ok=True)


def export_collection(collection: bpy.types.Collection, filename: str) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.all_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(collection.objects))
    output = OUT / filename
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        # Preserve linked compatibility nodes as glTF instances instead of
        # baking duplicate vertex streams.
        export_apply=False,
        export_animations=False,
        export_materials="EXPORT",
        # WebP keeps the embedded 512px PBR pairs compact enough for a web
        # campaign without sacrificing the authored normal-map response.
        export_image_format="WEBP",
        export_image_quality=78,
        export_image_webp_fallback=False,
        export_extras=True,
        export_yup=True,
    )
    optimize_runtime_glb(output)


def main() -> None:
    expected_orm = ORM_TEXTURES / "Env_PaintedWall_ORM_512.png"
    if not expected_orm.is_file():
        subprocess.run(["node", str(ORM_GENERATOR)], cwd=ROOT, check=True)
    reset_scene()
    OUT.mkdir(parents=True, exist_ok=True)
    MASTER.parent.mkdir(parents=True, exist_ok=True)
    mats = {
        "black": material("PowderCoat_Black", (.025, .035, .045, 1), metallic=.35, roughness=.34),
        "navy": material("School_Navy", (.025, .10, .19, 1), metallic=.25, roughness=.3),
        "blue": material("School_Blue", (.03, .24, .48, 1), metallic=.1, roughness=.32),
        "cyan": material("Bottle_Cyan", (.04, .55, .66, 1), metallic=.05, roughness=.25),
        "red": material("Bottle_Red", (.68, .05, .07, 1), metallic=.05, roughness=.3),
        "white": material("Porcelain_White", (.86, .91, .92, 1), metallic=.05, roughness=.29),
        "brass": material("Brushed_Brass", (.52, .31, .08, 1), metallic=.9, roughness=.24),
        "gold": material("Trophy_Gold", (.84, .49, .07, 1), metallic=.95, roughness=.18),
        "wood": material("Trophy_Wood", (.18, .055, .02, 1), roughness=.42),
        "wood_dark": material("Crate_Band", (.12, .055, .018, 1), roughness=.58),
        "crate": material("Industrial_Crate", (.38, .19, .055, 1), roughness=.64),
        "steel": material("Brushed_Steel", (.22, .27, .29, 1), metallic=.85, roughness=.28),
        "steel_light": material("Satin_Steel", (.53, .58, .59, 1), metallic=.82, roughness=.24),
        "steel_dark": material("Industrial_Steel", (.08, .105, .115, 1), metallic=.76, roughness=.34),
        "chrome": material("Polished_Chrome", (.58, .65, .67, 1), metallic=1.0, roughness=.13),
        "rubber": material("Tire_Rubber", (.018, .021, .022, 1), roughness=.82),
        "glass": material("Display_Glass", (.22, .52, .66, .28), metallic=.08, roughness=.12, alpha_blend=True),
        "smoke_glass": material("Smoke_Glass", (.035, .09, .12, .48), metallic=.18, roughness=.12, alpha_blend=True),
        "screen": material("Screen_Glow", (.01, .22, .28, 1), metallic=.2, roughness=.16, emission=(.0, .55, .75, 1), emission_strength=2.2),
        "hospital_blue": material("Hospital_Mattress", (.07, .29, .43, 1), roughness=.37),
        "hospital_teal": material("Hospital_Teal", (.02, .42, .39, 1), metallic=.1, roughness=.32),
        "medical_bag": material("IV_Fluid", (.42, .8, .75, .55), roughness=.16, alpha_blend=True),
        "tube": material("Medical_Tube", (.55, .82, .78, .65), roughness=.2, alpha_blend=True),
        "privacy": material("Privacy_Fabric", (.035, .31, .36, .86), roughness=.64, alpha_blend=True),
        "fire_red": material("Fire_Engine_Red", (.58, .018, .025, 1), metallic=.48, roughness=.2),
        "reflective": material("Reflective_Stripe", (.95, .8, .16, 1), metallic=.25, roughness=.16, emission=(.75, .42, .03, 1), emission_strength=.9),
        "lamp": material("Emergency_Lamp", (.95, .82, .42, 1), roughness=.18, emission=(1, .58, .16, 1), emission_strength=2.5),
        "beacon": material("Emergency_Beacon", (.86, .015, .025, .78), roughness=.16, emission=(1, .01, .02, 1), emission_strength=2.8, alpha_blend=True),
        "helmet": material("Fire_Helmet", (.82, .57, .035, 1), metallic=.18, roughness=.25),
        "coat": material("Turnout_Gear", (.18, .12, .055, 1), roughness=.72),
        "hose": material("Fire_Hose", (.48, .29, .07, 1), roughness=.67),
        "orange": material("Safety_Orange", (.95, .22, .018, 1), roughness=.3),
        "factory_blue": material("Factory_Blue", (.025, .19, .38, 1), metallic=.65, roughness=.28),
        "hazard_yellow": material("Hazard_Yellow", (.92, .56, .025, 1), metallic=.28, roughness=.3),
        "valve_red": material("Valve_Red", (.62, .025, .018, 1), metallic=.56, roughness=.28),
        "brick_fire": material("Station_Brick", (.24, .035, .028, 1), metallic=.06, roughness=.72),
        # Architecture-grade surface families.  They share compact texture
        # pairs but retain distinct physical response and color calibration.
        "concrete": material("Architectural_Concrete", (.34, .37, .38, 1), roughness=.72),
        "concrete_dark": material("Architectural_Concrete_Dark", (.105, .12, .13, 1), roughness=.78),
        "linoleum": material("Hospital_Linoleum", (.58, .68, .68, 1), roughness=.38),
        "epoxy_red": material("FireBay_Epoxy", (.24, .045, .04, 1), roughness=.46),
        "grass": material("Campus_Landscape_Grass", (.12, .28, .09, 1), roughness=.9),
        "paper": material("Printed_Paper", (.9, .84, .68, 1), roughness=.88),
    }
    # Surface language is shared across themes, but semantic materials keep
    # their authored metallic/roughness response. The exporter embeds each
    # referenced image once per kit even when many materials reuse it.
    for key in ("white",):
        attach_texture_pair(mats[key], "Env_PaintedWall", normal_strength=.54)
    for key in ("navy", "blue", "hospital_teal", "factory_blue"):
        attach_texture_pair(mats[key], "Env_BluePaintedMetal", normal_strength=.76)
    for key in ("red", "fire_red", "valve_red"):
        attach_texture_pair(mats[key], "Env_RedPaintedMetal", normal_strength=.78)
    for key in ("wood", "wood_dark", "crate"):
        attach_texture_pair(mats[key], "Env_WoodTrim", normal_strength=.68)
    for key in ("steel", "steel_light", "steel_dark", "chrome"):
        attach_texture_pair(mats[key], "Env_WornMetal", normal_strength=.74)
    for key in ("black", "rubber"):
        attach_texture_pair(mats[key], "Env_RubberBlack", normal_strength=.62)
    for key in ("concrete", "concrete_dark", "linoleum"):
        # Keep the authored concrete/linoleum hue while sharing the same fine
        # normal grain; directly wiring the white plaster albedo would erase
        # the semantic color factor in Blender/glTF.
        attach_texture_pair(
            mats[key],
            "Env_PaintedWall",
            normal_strength=.48 if key == "linoleum" else .68,
            use_base_color=False,
        )
    attach_texture_pair(mats["epoxy_red"], "Env_RedPaintedMetal", normal_strength=.42)
    attach_texture_pair(mats["grass"], "Env_Grass", normal_strength=.82)
    attach_texture_pair(mats["paper"], "Env_Paper", normal_strength=.42)
    campus = theme_collection("Campus_Kit")
    hospital = theme_collection("Hospital_Kit")
    fire = theme_collection("Fire_Station_Kit")
    factory = theme_collection("Factory_Kit")
    build_campus(campus, mats)
    build_hospital(hospital, mats)
    build_fire(fire, mats)
    build_factory(factory, mats)
    build_architecture_wall(campus, mats, "campus")
    build_architecture_wall(hospital, mats, "hospital")
    build_architecture_wall(fire, mats, "fire")
    build_architecture_wall(factory, mats, "factory")
    build_production_theme_extension(campus, mats, "campus")
    build_production_theme_extension(hospital, mats, "hospital")
    build_production_theme_extension(fire, mats, "fire")
    build_production_theme_extension(factory, mats, "factory")
    # This source is fully generated; timestamped .blend1 backups only bloat
    # the repository and are intentionally disabled.
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER), compress=True)
    export_collection(campus, "campus-kit.glb")
    export_collection(hospital, "hospital-kit.glb")
    export_collection(fire, "fire-station-kit.glb")
    export_collection(factory, "factory-kit.glb")
    print(f"Saved source master: {MASTER}")
    print(f"Exported theme kits to: {OUT}")


if __name__ == "__main__":
    main()
