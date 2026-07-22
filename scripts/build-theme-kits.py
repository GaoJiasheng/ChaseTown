"""Build the compact, engine-neutral environment kits used by the Web campaign.

Run with:
  blender --background --python scripts/build-theme-kits.py

The source master is saved as one .blend while each theme is exported as a
small GLB containing named, independently cloneable props.  The kits reuse the
project's compact 512px PBR color/normal library, embedded once per GLB, so the
walls and hero props retain real surface grain without extra runtime requests.
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "models" / "environment" / "themes"
MASTER = ROOT / "art-source" / "Environment" / "ThemeKits" / "Chasing_Theme_Environment_Kits.blend"
SHARED_TEXTURES = ROOT / "public" / "models" / "SharedTextures"


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


def attach_texture_pair(mat: bpy.types.Material, texture_stem: str, *, normal_strength: float = 0.72) -> None:
    """Attach an export-safe base-color/normal pair from the shared PBR set."""
    base_path = SHARED_TEXTURES / f"{texture_stem}_BaseColor_2K.png"
    normal_path = SHARED_TEXTURES / f"{texture_stem}_Normal_2K.png"
    if not base_path.is_file() or not normal_path.is_file():
        raise FileNotFoundError(f"Missing shared PBR pair for {texture_stem}")

    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    shader = nodes.get("Principled BSDF")
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
    if bevel > 0:
        mod = obj.modifiers.new("Soft industrial edges", "BEVEL")
        mod.width = min(bevel, min(size) * 0.22)
        mod.segments = 3
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
    if bevel:
        mod = obj.modifiers.new("Machined edge", "BEVEL")
        mod.width = min(bevel, radius * 0.16, depth * 0.12)
        mod.segments = 3
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
    bpy.ops.mesh.primitive_uv_sphere_add(segments=28, ring_count=16, radius=radius, location=location)
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
        major_segments=40,
        minor_segments=10,
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


def export_collection(collection: bpy.types.Collection, filename: str) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.all_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(collection.objects))
    bpy.ops.export_scene.gltf(
        filepath=str(OUT / filename),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
        export_materials="EXPORT",
        # WebP keeps the embedded 512px PBR pairs compact enough for a web
        # campaign without sacrificing the authored normal-map response.
        export_image_format="WEBP",
        export_image_quality=78,
        export_image_webp_fallback=False,
        export_yup=True,
    )


def main() -> None:
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
