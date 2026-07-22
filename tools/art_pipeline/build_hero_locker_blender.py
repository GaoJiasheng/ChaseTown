"""Build the production Hero Locker used by the Web hiding interaction.

Run from the repository root with:

    blender --background --python tools/art_pipeline/build_hero_locker_blender.py

The script intentionally authors a real interactive prop rather than a runtime
primitive placeholder. It creates a hollow cabinet, an independently pivoted
door, interaction anchors, six damped door actions, a clean Blender master,
the runtime GLB, and three temporary review renders.
"""

from __future__ import annotations

from pathlib import Path
import json
import math
import os
import struct

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "art-source" / "Environment" / "Interactive"
BLEND_PATH = SOURCE_DIR / "Locker_Hero.blend"
GLB_PATH = ROOT / "public" / "models" / "environment" / "locker.glb"
TEXTURE_DIR = ROOT / "public" / "models" / "SharedTextures"
REVIEW_DIR = Path(os.environ.get("CHASING_LOCKER_REVIEW_DIR", "/tmp/chasing-hero-locker-review"))

WIDTH = 0.92
DEPTH = 0.62
HEIGHT = 1.96
SHELL = 0.038
FRONT_Y = -DEPTH / 2
DOOR_Y = FRONT_Y - 0.030
DOOR_WIDTH = WIDTH - 0.070
DOOR_HEIGHT = HEIGHT - 0.145
DOOR_BOTTOM = 0.070
HINGE_X = -DOOR_WIDTH / 2
OPEN_ANGLE_DEG = -102.0


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.actions,
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


def smart_uv(obj: bpy.types.Object) -> None:
    if obj.type != "MESH" or not obj.data.polygons:
        return
    activate(obj)
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(62), island_margin=0.025)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")


def triangulate_mesh(obj: bpy.types.Object) -> None:
    if obj.type != "MESH" or not obj.data.polygons:
        return
    modifier = obj.modifiers.new("Production_Triangulate", "TRIANGULATE")
    modifier.quad_method = "BEAUTY"
    modifier.ngon_method = "BEAUTY"
    apply_modifier(obj, modifier)


def finish_mesh(obj: bpy.types.Object, material: bpy.types.Material | None, bevel: float = 0.0, segments: int = 3) -> bpy.types.Object:
    if bevel > 0:
        modifier = obj.modifiers.new("Production_Bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = segments
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(28)
        modifier.harden_normals = True
        apply_modifier(obj, modifier)
    if material is not None:
        obj.data.materials.clear()
        obj.data.materials.append(material)
    smart_uv(obj)
    triangulate_mesh(obj)
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return obj


def box(
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    material: bpy.types.Material | None,
    bevel: float = 0.008,
    segments: int = 3,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish_mesh(obj, material, bevel, segments)


def cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    material: bpy.types.Material | None,
    *,
    vertices: int = 32,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    bevel: float = 0.002,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish_mesh(obj, material, bevel, 2)


def rounded_slot_cutter(name: str, location: tuple[float, float, float]) -> bpy.types.Object:
    cutter = box(name, location, (0.245, 0.120, 0.036), None, bevel=0.017, segments=5)
    return cutter


def parent_keep_world(obj: bpy.types.Object, parent: bpy.types.Object) -> None:
    matrix_world = obj.matrix_world.copy()
    obj.parent = parent
    obj.matrix_world = matrix_world


def curve_tube(
    name: str,
    points: list[tuple[float, float, float]],
    radius: float,
    material: bpy.types.Material,
    bevel_resolution: int = 3,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name + "_Curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 3
    curve.bevel_depth = radius
    curve.bevel_resolution = bevel_resolution
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, coordinate in zip(spline.bezier_points, points):
        point.co = coordinate
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = name
    return finish_mesh(obj, material, bevel=0.0)


def plain_material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float,
    metallic: float = 0.0,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = color
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    assert bsdf is not None
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return material


def textured_material(
    name: str,
    texture_stem: str,
    roughness: float,
    metallic: float,
    normal_strength: float = 0.48,
) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    assert bsdf is not None
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic

    base_path = TEXTURE_DIR / f"Env_{texture_stem}_BaseColor_2K.png"
    normal_path = TEXTURE_DIR / f"Env_{texture_stem}_Normal_2K.png"
    if not base_path.is_file() or not normal_path.is_file():
        raise FileNotFoundError(f"Hero Locker texture set is incomplete: {texture_stem}")

    base_image = bpy.data.images.load(str(base_path), check_existing=True)
    base_image.name = f"HeroLocker_{texture_stem}_BaseColor"
    base_texture = nodes.new("ShaderNodeTexImage")
    base_texture.name = f"T_{texture_stem}_BaseColor"
    base_texture.image = base_image
    links.new(base_texture.outputs["Color"], bsdf.inputs["Base Color"])

    normal_image = bpy.data.images.load(str(normal_path), check_existing=True)
    normal_image.name = f"HeroLocker_{texture_stem}_Normal"
    normal_image.colorspace_settings.name = "Non-Color"
    normal_texture = nodes.new("ShaderNodeTexImage")
    normal_texture.name = f"T_{texture_stem}_Normal"
    normal_texture.image = normal_image
    normal_node = nodes.new("ShaderNodeNormalMap")
    normal_node.inputs["Strength"].default_value = normal_strength
    links.new(normal_texture.outputs["Color"], normal_node.inputs["Color"])
    links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
    return material


def make_materials() -> dict[str, bpy.types.Material]:
    return {
        "paint": textured_material("M_Locker_BluePaint", "BluePaintedMetal", 0.35, 0.12, 0.50),
        "metal": textured_material("M_Locker_WornMetal", "WornMetal", 0.32, 0.72, 0.42),
        "paper": textured_material("M_Locker_Paper", "Paper", 0.82, 0.0, 0.24),
        "interior": plain_material("M_Locker_Interior", (0.042, 0.055, 0.066, 1.0), 0.42, 0.35),
        "recess": plain_material("M_Locker_VentShadow", (0.008, 0.012, 0.015, 1.0), 0.58, 0.05),
        "rubber": plain_material("M_Locker_Rubber", (0.012, 0.014, 0.016, 1.0), 0.66, 0.0),
        "letter": plain_material("M_Locker_Lettering", (0.035, 0.045, 0.052, 1.0), 0.52, 0.15),
        "brass": plain_material("M_Locker_Brass", (0.36, 0.21, 0.065, 1.0), 0.24, 0.82),
    }


def create_text(
    name: str,
    text: str,
    location: tuple[float, float, float],
    size: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.object.text_add(location=location, rotation=(math.radians(90), 0.0, 0.0))
    obj = bpy.context.object
    obj.name = name
    obj.data.body = text
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = size
    obj.data.extrude = 0.0015
    obj.data.bevel_depth = 0.0007
    obj.data.bevel_resolution = 2
    obj.data.materials.append(material)
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = name
    return finish_mesh(obj, material, bevel=0.0)


def create_anchor(
    name: str,
    location: tuple[float, float, float],
    parent: bpy.types.Object,
    *,
    role: str,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.object.empty_add(type="ARROWS", location=location, rotation=rotation)
    anchor = bpy.context.object
    anchor.name = name
    anchor.empty_display_size = 0.12
    anchor["anchorRole"] = role
    parent_keep_world(anchor, parent)
    return anchor


def build_door(materials: dict[str, bpy.types.Material], root: bpy.types.Object) -> tuple[bpy.types.Object, bpy.types.Object]:
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(HINGE_X, DOOR_Y, 0.0))
    pivot = bpy.context.object
    pivot.name = "DoorPivot"
    pivot.rotation_mode = "XYZ"
    pivot.empty_display_size = 0.16
    pivot["hingeAxis"] = "Z"
    pivot["closedDegrees"] = 0.0
    pivot["openDegrees"] = OPEN_ANGLE_DEG
    parent_keep_world(pivot, root)

    door_center_z = DOOR_BOTTOM + DOOR_HEIGHT / 2
    door = box(
        "LockerDoor_PressedSteel",
        (0.0, DOOR_Y, door_center_z),
        (DOOR_WIDTH, 0.050, DOOR_HEIGHT),
        materials["paint"],
        bevel=0.0,
    )

    # Twelve true openings are cut through the steel door. Dark backing plates
    # are placed behind the openings so they read correctly in both closed and
    # open-door views.
    slot_locations: list[tuple[float, float, float]] = []
    for x in (-0.205, 0.205):
        for z in (1.60, 1.525, 1.450, 0.510, 0.435, 0.360):
            slot_locations.append((x, DOOR_Y, z))
    for index, location in enumerate(slot_locations):
        cutter = rounded_slot_cutter(f"VentCutter_{index:02d}", location)
        boolean = door.modifiers.new(f"VentBoolean_{index:02d}", "BOOLEAN")
        boolean.operation = "DIFFERENCE"
        boolean.solver = "EXACT"
        boolean.object = cutter
        apply_modifier(door, boolean)
        bpy.data.objects.remove(cutter, do_unlink=True)
    finish_mesh(door, materials["paint"], bevel=0.0065, segments=4)
    parent_keep_world(door, pivot)

    # Pressed-steel reinforcement profile. The thin beveled rails produce a
    # readable embossed door silhouette without painting fake line art.
    rail_y = DOOR_Y - 0.031
    rails = [
        ("Door_Press_Left", (-0.370, rail_y, 1.055), (0.022, 0.018, 1.550)),
        ("Door_Press_Right", (0.370, rail_y, 1.055), (0.022, 0.018, 1.550)),
        ("Door_Press_Top", (0.0, rail_y, 1.830), (0.740, 0.018, 0.026)),
        ("Door_Press_Bottom", (0.0, rail_y, 0.280), (0.740, 0.018, 0.026)),
        ("Door_Press_MidTop", (0.0, rail_y, 1.292), (0.620, 0.016, 0.020)),
        ("Door_Press_MidBottom", (0.0, rail_y, 0.660), (0.620, 0.016, 0.020)),
        ("Door_Press_UpperLeft", (-0.302, rail_y, 0.975), (0.018, 0.016, 0.635)),
        ("Door_Press_UpperRight", (0.302, rail_y, 0.975), (0.018, 0.016, 0.635)),
    ]
    for name, location, dimensions in rails:
        rail = box(name, location, dimensions, materials["metal"], bevel=0.006, segments=3)
        parent_keep_world(rail, pivot)

    # Recessed center panel and a softly beveled school identity panel.
    center_panel = box(
        "Door_RecessedCenterPanel",
        (0.0, DOOR_Y - 0.027, 0.975),
        (0.560, 0.012, 0.520),
        materials["paint"],
        bevel=0.018,
        segments=4,
    )
    parent_keep_world(center_panel, pivot)

    badge = box(
        "Door_NumberPlate",
        (0.245, DOOR_Y - 0.047, 1.755),
        (0.175, 0.018, 0.105),
        materials["metal"],
        bevel=0.012,
        segments=4,
    )
    parent_keep_world(badge, pivot)
    badge_inset = box(
        "Door_NumberPlateInset",
        (0.245, DOOR_Y - 0.058, 1.755),
        (0.135, 0.010, 0.068),
        materials["paper"],
        bevel=0.005,
        segments=3,
    )
    parent_keep_world(badge_inset, pivot)
    number = create_text(
        "Door_Number_A17",
        "A17",
        (0.245, DOOR_Y - 0.066, 1.753),
        0.052,
        materials["letter"],
    )
    parent_keep_world(number, pivot)

    # A substantial sprung pull handle with separate standoffs, latch plate,
    # key cylinder and fasteners. Every moving component is a DoorPivot child.
    latch_plate = box(
        "Door_HandleLatchPlate",
        (0.274, DOOR_Y - 0.050, 1.075),
        (0.180, 0.026, 0.315),
        materials["metal"],
        bevel=0.018,
        segments=4,
    )
    parent_keep_world(latch_plate, pivot)
    grip = cylinder(
        "Door_HandleGrip",
        (0.310, DOOR_Y - 0.105, 1.080),
        0.020,
        0.205,
        materials["metal"],
        vertices=40,
        bevel=0.004,
    )
    parent_keep_world(grip, pivot)
    for z in (0.982, 1.178):
        standoff = cylinder(
            f"Door_HandleStandoff_{z:.3f}",
            (0.310, DOOR_Y - 0.071, z),
            0.022,
            0.070,
            materials["metal"],
            vertices=32,
            rotation=(math.radians(90), 0.0, 0.0),
            bevel=0.003,
        )
        parent_keep_world(standoff, pivot)
    key_ring = cylinder(
        "Door_KeyCylinder",
        (0.225, DOOR_Y - 0.070, 0.980),
        0.031,
        0.025,
        materials["brass"],
        vertices=40,
        rotation=(math.radians(90), 0.0, 0.0),
        bevel=0.003,
    )
    parent_keep_world(key_ring, pivot)
    key_slot = box(
        "Door_KeySlot",
        (0.225, DOOR_Y - 0.086, 0.980),
        (0.008, 0.006, 0.025),
        materials["recess"],
        bevel=0.002,
        segments=2,
    )
    parent_keep_world(key_slot, pivot)

    for x in (0.208, 0.340):
        for z in (0.950, 1.200):
            screw = cylinder(
                f"Door_HandleScrew_{x:.3f}_{z:.3f}",
                (x, DOOR_Y - 0.069, z),
                0.008,
                0.009,
                materials["metal"],
                vertices=20,
                rotation=(math.radians(90), 0.0, 0.0),
                bevel=0.0015,
            )
            parent_keep_world(screw, pivot)

    # The door-side hinge leaves move with the pivot. The barrel and cabinet
    # leaf are authored separately on the fixed body in build_body().
    for index, z in enumerate((0.330, 0.970, 1.610)):
        moving_leaf = box(
            f"Hinge_MovingLeaf_{index}",
            (HINGE_X + 0.040, DOOR_Y - 0.037, z),
            (0.078, 0.016, 0.120),
            materials["metal"],
            bevel=0.005,
            segments=3,
        )
        parent_keep_world(moving_leaf, pivot)
        for screw_z in (z - 0.030, z + 0.030):
            screw = cylinder(
                f"Hinge_MovingScrew_{index}_{screw_z:.3f}",
                (HINGE_X + 0.052, DOOR_Y - 0.050, screw_z),
                0.006,
                0.008,
                materials["metal"],
                vertices=16,
                rotation=(math.radians(90), 0.0, 0.0),
                bevel=0.001,
            )
            parent_keep_world(screw, pivot)

    create_anchor(
        "HandIK",
        (0.310, DOOR_Y - 0.130, 1.080),
        pivot,
        role="moving_door_handle_contact",
        rotation=(math.radians(90), 0.0, 0.0),
    )
    return pivot, door


def build_body(materials: dict[str, bpy.types.Material], root: bpy.types.Object) -> None:
    back_y = DEPTH / 2 - SHELL / 2
    side_x = WIDTH / 2 - SHELL / 2
    top_z = HEIGHT - SHELL / 2
    bottom_z = SHELL / 2
    body_parts = [
        box("Cabinet_Back", (0.0, back_y, HEIGHT / 2), (WIDTH, SHELL, HEIGHT), materials["paint"], 0.010, 4),
        box("Cabinet_LeftWall", (-side_x, 0.0, HEIGHT / 2), (SHELL, DEPTH, HEIGHT), materials["paint"], 0.010, 4),
        box("Cabinet_RightWall", (side_x, 0.0, HEIGHT / 2), (SHELL, DEPTH, HEIGHT), materials["paint"], 0.010, 4),
        box("Cabinet_Top", (0.0, 0.0, top_z), (WIDTH, DEPTH, SHELL), materials["paint"], 0.010, 4),
        box("Cabinet_Floor", (0.0, 0.0, bottom_z), (WIDTH, DEPTH, SHELL), materials["interior"], 0.010, 4),
        box("Cabinet_InnerBack", (0.0, back_y - 0.023, 0.960), (WIDTH - 0.095, 0.018, HEIGHT - 0.130), materials["interior"], 0.006, 3),
        box("Cabinet_UpperShelf", (0.0, 0.015, 1.535), (WIDTH - 0.105, DEPTH - 0.100, 0.040), materials["metal"], 0.008, 3),
        box("Cabinet_ShelfFrontLip", (0.0, FRONT_Y + 0.080, 1.510), (WIDTH - 0.105, 0.030, 0.090), materials["metal"], 0.006, 3),
        box("Cabinet_TopCap", (0.0, 0.0, HEIGHT + 0.025), (WIDTH + 0.050, DEPTH + 0.035, 0.055), materials["metal"], 0.014, 4),
        box("Cabinet_ToeKick", (0.0, FRONT_Y + 0.035, 0.085), (WIDTH - 0.040, 0.055, 0.135), materials["metal"], 0.008, 3),
    ]
    for obj in body_parts:
        parent_keep_world(obj, root)

    # Front rolled-steel frame and a continuous rubber seal give the doorway a
    # believable thickness when the door opens.
    frame_specs = [
        ("Frame_Left", (-WIDTH / 2 + 0.028, FRONT_Y - 0.012, 1.005), (0.055, 0.060, 1.830)),
        ("Frame_Right", (WIDTH / 2 - 0.028, FRONT_Y - 0.012, 1.005), (0.055, 0.060, 1.830)),
        ("Frame_Top", (0.0, FRONT_Y - 0.012, 1.905), (WIDTH - 0.055, 0.060, 0.060)),
        ("Frame_Bottom", (0.0, FRONT_Y - 0.012, 0.100), (WIDTH - 0.055, 0.060, 0.060)),
    ]
    for name, location, dimensions in frame_specs:
        obj = box(name, location, dimensions, materials["metal"], bevel=0.010, segments=4)
        parent_keep_world(obj, root)

    gasket_specs = [
        ("Gasket_Left", (-WIDTH / 2 + 0.061, FRONT_Y - 0.046, 1.005), (0.014, 0.012, 1.720)),
        ("Gasket_Right", (WIDTH / 2 - 0.061, FRONT_Y - 0.046, 1.005), (0.014, 0.012, 1.720)),
        ("Gasket_Top", (0.0, FRONT_Y - 0.046, 1.866), (WIDTH - 0.135, 0.012, 0.014)),
        ("Gasket_Bottom", (0.0, FRONT_Y - 0.046, 0.145), (WIDTH - 0.135, 0.012, 0.014)),
    ]
    for name, location, dimensions in gasket_specs:
        obj = box(name, location, dimensions, materials["rubber"], bevel=0.006, segments=3)
        parent_keep_world(obj, root)

    # Interior hanger rail and two real hooks.
    hanger = cylinder(
        "Interior_HangerRail",
        (0.0, 0.105, 1.405),
        0.018,
        WIDTH - 0.180,
        materials["metal"],
        vertices=36,
        rotation=(0.0, math.radians(90), 0.0),
        bevel=0.003,
    )
    parent_keep_world(hanger, root)
    for index, x in enumerate((-0.245, 0.245)):
        hook = curve_tube(
            f"Interior_CoatHook_{index}",
            [
                (x, 0.270, 1.310),
                (x, 0.210, 1.275),
                (x, 0.165, 1.320),
                (x, 0.185, 1.355),
            ],
            0.010,
            materials["metal"],
            bevel_resolution=3,
        )
        parent_keep_world(hook, root)

    # Shelf supports, floor tread and a small interior safety card.
    for x in (-0.355, 0.355):
        bracket = box(
            f"Shelf_Bracket_{x:+.3f}",
            (x, 0.205, 1.465),
            (0.045, 0.170, 0.115),
            materials["metal"],
            bevel=0.007,
            segments=3,
        )
        parent_keep_world(bracket, root)
    tread = box(
        "Interior_RubberTread",
        (0.0, 0.015, 0.070),
        (WIDTH - 0.145, DEPTH - 0.150, 0.018),
        materials["rubber"],
        bevel=0.012,
        segments=4,
    )
    parent_keep_world(tread, root)
    safety_card = box(
        "Interior_SafetyCard",
        (0.0, DEPTH / 2 - 0.055, 1.080),
        (0.320, 0.010, 0.185),
        materials["paper"],
        bevel=0.010,
        segments=3,
    )
    parent_keep_world(safety_card, root)
    safety_text = create_text(
        "Interior_SafetyText",
        "STAY QUIET",
        (0.0, DEPTH / 2 - 0.063, 1.080),
        0.036,
        materials["letter"],
    )
    parent_keep_world(safety_text, root)

    # Fixed hinge leaves, barrels, end caps and body screws.
    for index, z in enumerate((0.330, 0.970, 1.610)):
        fixed_leaf = box(
            f"Hinge_FixedLeaf_{index}",
            (HINGE_X - 0.030, FRONT_Y - 0.040, z),
            (0.066, 0.018, 0.140),
            materials["metal"],
            bevel=0.005,
            segments=3,
        )
        parent_keep_world(fixed_leaf, root)
        barrel = cylinder(
            f"Hinge_Barrel_{index}",
            (HINGE_X, DOOR_Y - 0.012, z),
            0.022,
            0.175,
            materials["metal"],
            vertices=40,
            bevel=0.003,
        )
        parent_keep_world(barrel, root)
        for cap_z in (z - 0.092, z + 0.092):
            cap = cylinder(
                f"Hinge_Cap_{index}_{cap_z:.3f}",
                (HINGE_X, DOOR_Y - 0.012, cap_z),
                0.024,
                0.012,
                materials["brass"],
                vertices=40,
                bevel=0.003,
            )
            parent_keep_world(cap, root)
        for screw_z in (z - 0.036, z + 0.036):
            screw = cylinder(
                f"Hinge_FixedScrew_{index}_{screw_z:.3f}",
                (HINGE_X - 0.038, FRONT_Y - 0.054, screw_z),
                0.006,
                0.008,
                materials["metal"],
                vertices=16,
                rotation=(math.radians(90), 0.0, 0.0),
                bevel=0.001,
            )
            parent_keep_world(screw, root)

    for x in (-0.330, 0.330):
        foot = cylinder(
            f"LevelingFoot_{x:+.3f}",
            (x, 0.150, -0.018),
            0.055,
            0.036,
            materials["rubber"],
            vertices=36,
            bevel=0.005,
        )
        parent_keep_world(foot, root)


def create_actions(pivot: bpy.types.Object) -> None:
    clips: dict[str, list[tuple[int, float]]] = {
        "Locker_Door_Open_Enter": [(1, 0.0), (5, -8.0), (13, -62.0), (22, -106.0), (27, -99.0), (32, OPEN_ANGLE_DEG)],
        "Locker_Door_Close_Enter": [(1, OPEN_ANGLE_DEG), (7, -91.0), (19, -28.0), (27, 3.0), (31, -1.6), (36, 0.0)],
        "Locker_Door_Open_Exit": [(1, 0.0), (4, -12.0), (12, -77.0), (20, -105.0), (25, OPEN_ANGLE_DEG)],
        "Locker_Door_Close_Exit": [(1, OPEN_ANGLE_DEG), (8, -78.0), (18, -18.0), (24, 2.3), (29, -0.8), (33, 0.0)],
        "Locker_Door_Check_Open": [(1, 0.0), (4, -5.0), (10, -38.0), (18, -79.0), (23, -74.0), (28, -77.0)],
        "Locker_Door_Check_Close": [(1, -77.0), (8, -66.0), (18, -17.0), (25, 4.2), (30, -2.0), (36, 0.0)],
    }
    pivot.animation_data_create()
    for name, keys in clips.items():
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        action["loop"] = False
        action["fps"] = 30
        action["motionStyle"] = "authored_bezier_with_mechanical_overshoot"
        pivot.animation_data.action = action
        for frame, angle_degrees in keys:
            bpy.context.scene.frame_set(frame)
            pivot.rotation_euler = (0.0, 0.0, math.radians(angle_degrees))
            pivot.keyframe_insert(data_path="rotation_euler", index=2, frame=frame, group="HeroLockerDoor")
        for layer in action.layers:
            for strip in layer.strips:
                for slot in action.slots:
                    channelbag = strip.channelbag(slot, ensure=False)
                    if channelbag is None:
                        continue
                    for fcurve in channelbag.fcurves:
                        for keyframe in fcurve.keyframe_points:
                            keyframe.interpolation = "BEZIER"
                            keyframe.handle_left_type = "AUTO_CLAMPED"
                            keyframe.handle_right_type = "AUTO_CLAMPED"
        track = pivot.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, int(action.frame_range[0]), action)
        strip.name = name
        if strip.action_slot is None and action.slots:
            strip.action_slot = action.slots[0]
    pivot.animation_data.action = None
    pivot.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.scene.frame_set(1)


def make_root_and_anchors() -> tuple[bpy.types.Object, bpy.types.Object]:
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0.0, 0.0, 0.0))
    root = bpy.context.object
    root.name = "Locker_Hero"
    root.empty_display_size = 0.25
    root["assetRole"] = "interactive_hideable"
    root["assetVersion"] = "HeroLocker_v1"
    root["unit"] = "meter"
    root["frontAxisBlender"] = "-Y"
    root["frontAxisGlTF"] = "+Z"
    root["hasProductionGeometry"] = True
    root["hasRuntimePrimitiveFallback"] = False

    create_anchor("HideAnchor", (0.0, 0.055, 0.080), root, role="player_hidden_root")
    create_anchor("PeekAnchor", (0.205, FRONT_Y + 0.075, 1.265), root, role="player_peek_head")
    create_anchor(
        "CameraAnchor",
        (0.0, 0.185, 1.330),
        root,
        role="hidden_camera",
        rotation=(math.radians(90), 0.0, 0.0),
    )
    create_anchor(
        "SearchAnchor",
        (0.0, FRONT_Y - 0.920, 0.0),
        root,
        role="villain_search_root",
        rotation=(0.0, 0.0, math.radians(180)),
    )
    return root, bpy.context.object


def set_relative_image_paths() -> None:
    prefix = "//../../../public/models/SharedTextures/"
    for image in bpy.data.images:
        if not image.source == "FILE":
            continue
        filename = Path(bpy.path.abspath(image.filepath)).name
        if (TEXTURE_DIR / filename).is_file():
            image.filepath = prefix + filename


def production_objects(root: bpy.types.Object) -> list[bpy.types.Object]:
    result = [root]
    stack = list(root.children)
    while stack:
        obj = stack.pop()
        result.append(obj)
        stack.extend(obj.children)
    return result


def join_direct_mesh_children(parent: bpy.types.Object, prefix: str) -> None:
    buckets: dict[str, list[bpy.types.Object]] = {}
    for child in list(parent.children):
        if child.type != "MESH" or not child.data.materials:
            continue
        material = child.data.materials[0]
        buckets.setdefault(material.name, []).append(child)
    for material_name, objects in buckets.items():
        if not objects:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        joined = bpy.context.object
        safe_material_name = material_name.removeprefix("M_Locker_")
        joined.name = f"{prefix}_{safe_material_name}"
        joined.data.name = f"{joined.name}_Mesh"


def sanitize_exported_glb(path: Path) -> int:
    """Repair exporter edge cases without changing the authored appearance.

    Blender 5.1 writes both URI and a tiny placeholder bufferView when a GLB
    keeps original external textures, which violates the image one-of rule.
    Boolean seams can also yield zero MikkTSpace tangents. Three.js can render
    those seams, but the official validator correctly rejects them. Preserve
    the shared texture URIs, remove the redundant image references, and replace
    only invalid tangents with a normalized tangent orthogonal to the vertex
    normal. The GLB chunk sizes remain unchanged.
    """
    payload = bytearray(path.read_bytes())
    if payload[:4] != b"glTF" or struct.unpack_from("<I", payload, 4)[0] != 2:
        raise RuntimeError(f"Not a glTF 2.0 GLB: {path}")
    offset = 12
    json_start = json_length = binary_start = None
    while offset + 8 <= len(payload):
        chunk_length, chunk_type = struct.unpack_from("<II", payload, offset)
        data_start = offset + 8
        if chunk_type == 0x4E4F534A:
            json_start, json_length = data_start, chunk_length
        elif chunk_type == 0x004E4942:
            binary_start = data_start
        offset = data_start + chunk_length
    if json_start is None or json_length is None or binary_start is None:
        raise RuntimeError(f"Incomplete GLB chunks: {path}")
    document = json.loads(bytes(payload[json_start:json_start + json_length]).decode("utf-8").rstrip(" \0"))

    for image in document.get("images", []):
        if image.get("uri"):
            image.pop("bufferView", None)

    component_sizes = {5126: 4}

    def accessor_info(index: int, components: int) -> tuple[int, int, int]:
        accessor = document["accessors"][index]
        if accessor.get("componentType") not in component_sizes:
            raise RuntimeError(f"Unsupported tangent accessor component type: {accessor.get('componentType')}")
        view = document["bufferViews"][accessor["bufferView"]]
        stride = view.get("byteStride", components * component_sizes[accessor["componentType"]])
        start = binary_start + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return start, stride, accessor["count"]

    repaired = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            attributes = primitive.get("attributes", {})
            if "TANGENT" not in attributes or "NORMAL" not in attributes:
                continue
            tangent_start, tangent_stride, tangent_count = accessor_info(attributes["TANGENT"], 4)
            normal_start, normal_stride, normal_count = accessor_info(attributes["NORMAL"], 3)
            if tangent_count != normal_count:
                raise RuntimeError("Hero Locker tangent and normal accessor counts differ")
            for index in range(tangent_count):
                tangent_offset = tangent_start + index * tangent_stride
                normal_offset = normal_start + index * normal_stride
                tx, ty, tz, handedness = struct.unpack_from("<4f", payload, tangent_offset)
                length = math.sqrt(tx * tx + ty * ty + tz * tz) if all(math.isfinite(v) for v in (tx, ty, tz)) else 0.0
                if length < 0.5:
                    nx, ny, nz = struct.unpack_from("<3f", payload, normal_offset)
                    normal_length = math.sqrt(nx * nx + ny * ny + nz * nz)
                    if normal_length < 1e-6:
                        nx, ny, nz = 0.0, 0.0, 1.0
                    else:
                        nx, ny, nz = nx / normal_length, ny / normal_length, nz / normal_length
                    axis = (1.0, 0.0, 0.0) if abs(nx) < 0.9 else (0.0, 1.0, 0.0)
                    dot = axis[0] * nx + axis[1] * ny + axis[2] * nz
                    tx, ty, tz = axis[0] - dot * nx, axis[1] - dot * ny, axis[2] - dot * nz
                    length = math.sqrt(tx * tx + ty * ty + tz * tz)
                    repaired += 1
                tx, ty, tz = tx / length, ty / length, tz / length
                if not math.isfinite(handedness) or abs(handedness) < 0.5:
                    handedness = 1.0
                else:
                    handedness = 1.0 if handedness > 0 else -1.0
                struct.pack_into("<4f", payload, tangent_offset, tx, ty, tz, handedness)

    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > json_length:
        raise RuntimeError("Sanitized GLB JSON no longer fits its original chunk")
    payload[json_start:json_start + json_length] = encoded + b" " * (json_length - len(encoded))
    path.write_bytes(payload)
    return repaired


def save_and_export(root: bpy.types.Object) -> None:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    GLB_PATH.parent.mkdir(parents=True, exist_ok=True)
    set_relative_image_paths()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in production_objects(root):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials="EXPORT",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_merge_animation="ACTION",
        export_force_sampling=True,
        export_frame_step=1,
        export_optimize_animation_size=False,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_image_format="AUTO",
        export_keep_originals=True,
    )
    repaired_tangents = sanitize_exported_glb(GLB_PATH)
    print(f"HERO_LOCKER_REPAIRED_TANGENTS={repaired_tangents}")
    pivot = bpy.data.objects.get("DoorPivot")
    if pivot is not None and pivot.animation_data is not None:
        for track in list(pivot.animation_data.nla_tracks):
            pivot.animation_data.nla_tracks.remove(track)
        pivot.animation_data.action = None
        pivot.rotation_euler = (0.0, 0.0, 0.0)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)


def look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def setup_review_scene(materials: dict[str, bpy.types.Material]) -> bpy.types.Object:
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except Exception:
        pass
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.resolution_percentage = 100
    scene.render.fps = 30
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
        scene.render.image_settings.color_depth = "8"
    except Exception:
        pass
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.world.color = (0.012, 0.017, 0.026)
    if scene.world.use_nodes:
        background = scene.world.node_tree.nodes.get("Background")
        if background:
            background.inputs["Color"].default_value = (0.012, 0.018, 0.030, 1.0)
            background.inputs["Strength"].default_value = 0.24

    floor = box("Review_Floor", (0.0, 0.0, -0.075), (8.0, 8.0, 0.10), materials["recess"], bevel=0.025, segments=4)
    floor["reviewOnly"] = True

    lights = [
        ("Review_Key", "AREA", (3.3, -4.2, 4.5), 690.0, 3.0, (0.95, 0.82, 0.68)),
        ("Review_Fill", "AREA", (-3.0, -2.0, 2.8), 430.0, 3.8, (0.48, 0.68, 1.0)),
        ("Review_Rim", "AREA", (2.0, 2.7, 3.8), 760.0, 2.2, (0.34, 0.56, 1.0)),
        ("Review_Interior", "AREA", (0.0, -0.65, 1.45), 190.0, 1.1, (1.0, 0.70, 0.44)),
    ]
    for name, light_type, location, energy, size, color in lights:
        bpy.ops.object.light_add(type=light_type, location=location)
        light = bpy.context.object
        light.name = name
        light.data.energy = energy
        light.data.shape = "DISK"
        light.data.size = size
        light.data.color = color
        look_at(light, (0.0, 0.0, 1.0))

    bpy.ops.object.camera_add(location=(3.0, -4.4, 2.65))
    camera = bpy.context.object
    camera.name = "Review_Camera"
    camera.data.lens = 58
    camera.data.sensor_width = 36
    look_at(camera, (0.0, 0.0, 1.02))
    scene.camera = camera
    return camera


def render_reviews(pivot: bpy.types.Object, materials: dict[str, bpy.types.Material]) -> None:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    camera = setup_review_scene(materials)
    reviews = [
        ("locker_closed_three_quarter.png", 0.0, (2.8, -4.25, 2.55), (0.0, 0.0, 1.00), 58),
        ("locker_open_interior.png", OPEN_ANGLE_DEG, (3.1, -4.0, 2.42), (-0.05, 0.0, 1.00), 55),
        ("locker_open_detail.png", -74.0, (1.80, -2.55, 1.78), (0.10, -0.18, 1.14), 67),
    ]
    for filename, angle, camera_location, target, lens in reviews:
        pivot.rotation_euler = (0.0, 0.0, math.radians(angle))
        bpy.context.view_layer.update()
        camera.location = camera_location
        camera.data.lens = lens
        look_at(camera, target)
        bpy.context.scene.render.filepath = str(REVIEW_DIR / filename)
        bpy.ops.render.render(write_still=True)
    pivot.rotation_euler = (0.0, 0.0, 0.0)


def main() -> None:
    # Generated masters are deterministic; Blender's rolling .blend1 backups
    # only inflate the compact web repository and are forbidden by QA.
    bpy.context.preferences.filepaths.save_version = 0
    reset_scene()
    materials = make_materials()
    root, _ = make_root_and_anchors()
    build_body(materials, root)
    pivot, _door = build_door(materials, root)
    join_direct_mesh_children(root, "LockerBody")
    join_direct_mesh_children(pivot, "LockerDoor")
    create_actions(pivot)
    save_and_export(root)
    render_reviews(pivot, materials)
    print(f"HERO_LOCKER_BLEND={BLEND_PATH}")
    print(f"HERO_LOCKER_GLB={GLB_PATH}")
    print(f"HERO_LOCKER_REVIEWS={REVIEW_DIR}")
    print(f"HERO_LOCKER_ACTIONS={','.join(sorted(action.name for action in bpy.data.actions))}")


if __name__ == "__main__":
    main()
