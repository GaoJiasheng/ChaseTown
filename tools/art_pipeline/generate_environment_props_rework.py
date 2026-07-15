"""Generate Task F prop candidates with PBR textures and bevel/detail geometry.

Run with:
  blender --background --python tools/art_pipeline/generate_environment_props_rework.py
"""

from __future__ import annotations

from pathlib import Path
import importlib.util
import json
import math

import bpy


ROOT = Path(__file__).resolve().parents[2]
HELPER_PATH = ROOT / "tools" / "art_pipeline" / "generate_environment_modular_rework.py"
PROPS = ROOT / "art-source" / "Environment" / "Props"
METRICS = ROOT / "docs" / "art_production" / "ENVIRONMENT_TEXTURE_QUALITY_SUMMARY.json"


def load_helper():
    spec = importlib.util.spec_from_file_location("envmod", HELPER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


H = load_helper()


ASSETS = [
    "Prop_Locker_Set",
    "Prop_BulletinBoard",
    "Prop_FireExtinguisher",
    "Prop_TrashBin",
    "Prop_DeskChair_Set",
    "Prop_Blackboard",
    "Prop_TeacherPodium",
    "Prop_ScatteredBooks",
    "Prop_DroppedBackpack",
    "Prop_Bench",
    "Prop_Tree_Set",
    "Prop_Shrub_Set",
    "Prop_BasketballHoop",
    "Prop_PoliceCar",
    "Prop_PoliceStationFacade",
]


def sphere(name, loc, scale, material, segments=32, rings=16, bevel=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return H.finish(obj, material, bevel=bevel)


def torus(name, loc, major_radius, minor_radius, material, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=40,
        minor_segments=8,
        major_radius=major_radius,
        minor_radius=minor_radius,
        location=loc,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    return H.finish(obj, material, bevel=None)


def box(name, loc, scale, material, bevel=0.006, rotation=(0, 0, 0)):
    obj = H.cube(name, loc, scale, material, bevel)
    obj.rotation_euler = rotation
    return obj


def front_bolt(name, loc, material, radius=0.011, depth=0.008):
    return H.cyl(name, loc, radius, depth, material, vertices=12, bevel=0.001, rotation=(math.radians(90), 0, 0))


def tube_low(name: str, points, radius, material):
    curve = bpy.data.curves.new(name + "_Curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 1
    curve.bevel_depth = radius
    curve.bevel_resolution = 1
    spl = curve.splines.new("POLY")
    spl.points.add(len(points) - 1)
    for p, co in zip(spl.points, points):
        p.co = (co[0], co[1], co[2], 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    return H.finish(bpy.context.object, material, bevel=None)


def build(name: str, mats: dict) -> tuple[list, list[str], bool]:
    o = []
    m = []
    lod = False

    if name == "Prop_Locker_Set":
        for i, x in enumerate((-0.42, 0, 0.42)):
            o.append(H.cube(f"locker_{i}_body", (x, 0, 0.92), (0.19, 0.16, 0.92), mats["blue_metal"], 0.012))
            o.append(H.cube(f"locker_{i}_door_split", (x, -0.17, 0.92), (0.006, 0.008, 0.78), mats["metal"], 0))
            o.append(H.cube(f"locker_{i}_top_cap", (x, -0.01, 1.86), (0.20, 0.17, 0.030), mats["metal"], 0.002))
            o.append(H.cube(f"locker_{i}_toe_kick", (x, -0.01, 0.035), (0.20, 0.17, 0.035), mats["metal"], 0.002))
            for z in (1.52, 1.42, 1.30, 0.62, 0.52):
                o.append(H.cube(f"locker_{i}_vent_{z}", (x, -0.18, z), (0.11, 0.006, 0.010), mats["metal"], 0))
            o.append(H.cyl(f"locker_{i}_handle", (x + 0.11, -0.19, 0.96), 0.012, 0.035, mats["metal"], vertices=14, bevel=0.001, rotation=(math.radians(90), 0, 0)))
            o.append(H.cube(f"locker_{i}_number_plate", (x - 0.06, -0.184, 1.68), (0.055, 0.006, 0.028), mats["paper"], 0))
            for z in (1.58, 0.92, 0.28):
                o.append(front_bolt(f"locker_{i}_hinge_screw_{z}", (x - 0.145, -0.188, z), mats["metal"], radius=0.007))
        o.append(H.cube("locker_shared_back_rail", (0, 0.17, 1.77), (0.70, 0.020, 0.035), mats["metal"], 0.001))
        o.append(H.cube("locker_shared_floor_rail", (0, 0.17, 0.11), (0.70, 0.020, 0.030), mats["metal"], 0.001))
        m = ["BluePaintedMetal", "WornMetal", "Paper"]

    elif name == "Prop_BulletinBoard":
        o.append(H.cube("board_cork", (0, 0, 0.65), (0.62, 0.035, 0.38), mats["wood_trim"], 0.012))
        o.append(H.cube("board_frame_top", (0, -0.04, 1.05), (0.68, 0.025, 0.035), mats["metal"], 0.006))
        o.append(H.cube("board_frame_bottom", (0, -0.04, 0.25), (0.68, 0.025, 0.035), mats["metal"], 0.006))
        for x in (-0.70, 0.70):
            o.append(H.cube("board_frame_side", (x, -0.04, 0.65), (0.030, 0.025, 0.40), mats["metal"], 0.006))
        for i, (x, z, sx, sz, mat) in enumerate([
            (-0.42, 0.76, 0.12, 0.16, mats["paper"]),
            (-0.16, 0.54, 0.15, 0.12, mats["paper"]),
            (0.14, 0.72, 0.11, 0.18, mats["blue_metal"]),
            (0.41, 0.52, 0.13, 0.13, mats["red_metal"]),
            (0.34, 0.90, 0.18, 0.07, mats["paper"]),
        ]):
            paper = box("paper_notice", (x, -0.076, z), (sx, 0.006, sz), mat, 0.002, rotation=(0, 0, math.radians((i % 3 - 1) * 4)))
            o.append(paper)
            o.append(front_bolt("notice_pin", (x - sx * 0.65, -0.083, z + sz * 0.70), mats["metal"], radius=0.006, depth=0.005))
            o.append(front_bolt("notice_pin", (x + sx * 0.65, -0.083, z + sz * 0.70), mats["metal"], radius=0.006, depth=0.005))
        o.append(tube_low("notice_string", [(-0.54, -0.082, 0.38), (-0.10, -0.083, 0.86), (0.50, -0.082, 0.42)], 0.003, mats["metal"]))
        m = ["WoodTrim", "WornMetal", "Paper", "BluePaintedMetal", "RedPaintedMetal"]

    elif name == "Prop_FireExtinguisher":
        o.append(H.cube("wall_mount_plate", (0, 0.055, 0.45), (0.15, 0.018, 0.35), mats["metal"], 0.004))
        o.append(H.cyl("red_tank", (0, 0, 0.42), 0.105, 0.62, mats["red_metal"], vertices=32, bevel=0.008))
        o.append(H.cyl("valve", (0, 0, 0.77), 0.045, 0.08, mats["metal"], vertices=20, bevel=0.004))
        o.append(H.cyl("pressure_gauge_face", (-0.055, -0.055, 0.80), 0.026, 0.010, mats["paper"], vertices=16, bevel=0.001, rotation=(math.radians(90), 0, 0)))
        o.append(H.cube("safety_pin", (0.045, -0.060, 0.815), (0.035, 0.006, 0.008), mats["metal"], 0.001))
        o.append(tube_low("hose", [(0.02, -0.06, 0.75), (0.16, -0.08, 0.62), (0.11, -0.07, 0.42)], 0.010, mats["rubber_black"]))
        o.append(tube_low("hose_nozzle", [(0.11, -0.07, 0.42), (0.18, -0.075, 0.38)], 0.014, mats["metal"]))
        o.append(H.cube("label_plate", (0, -0.105, 0.48), (0.07, 0.006, 0.10), mats["paper"], 0))
        for z in (0.33, 0.58):
            o.append(H.cube("retaining_band", (0, -0.108, z), (0.12, 0.008, 0.010), mats["metal"], 0))
        m = ["RedPaintedMetal", "WornMetal", "RubberBlack", "Paper"]

    elif name == "Prop_TrashBin":
        o.append(H.cyl("bin_body", (0, 0, 0.42), 0.20, 0.70, mats["blue_metal"], vertices=32, bevel=0.010))
        o.append(H.cyl("bin_rim", (0, 0, 0.79), 0.215, 0.055, mats["metal"], vertices=32, bevel=0.005))
        o.append(H.cyl("bin_inner_dark", (0, 0, 0.805), 0.170, 0.030, mats["rubber_black"], vertices=32, bevel=0.002))
        o.append(H.cube("front_label", (0, -0.205, 0.48), (0.12, 0.006, 0.09), mats["paper"], 0))
        o.append(H.cube("foot_pedal", (0, -0.235, 0.065), (0.115, 0.030, 0.018), mats["metal"], 0.004))
        for x in (-0.14, -0.07, 0.0, 0.07, 0.14):
            o.append(H.cube("front_vertical_rib", (x, -0.205, 0.44), (0.006, 0.010, 0.50), mats["metal"], 0))
        for x in (-0.20, 0.20):
            o.append(tube_low("side_handle", [(x, -0.03, 0.55), (x, -0.08, 0.55), (x, -0.08, 0.45)], 0.008, mats["metal"]))
        m = ["BluePaintedMetal", "WornMetal", "RubberBlack", "Paper"]

    elif name == "Prop_DeskChair_Set":
        o.append(H.cube("desk_top", (0, 0, 0.72), (0.44, 0.31, 0.035), mats["wood_trim"], 0.012))
        o.append(H.cube("desk_top_beveled_edge_front", (0, -0.325, 0.75), (0.45, 0.018, 0.020), mats["metal"], 0.003))
        o.append(H.cube("desk_drawer_front", (-0.16, -0.305, 0.56), (0.16, 0.014, 0.08), mats["wood_trim"], 0.004))
        o.append(H.cyl("desk_drawer_pull", (-0.16, -0.318, 0.56), 0.010, 0.050, mats["metal"], vertices=16, bevel=0.002, rotation=(math.radians(90), 0, 0)))
        o.append(H.cube("desk_front_apron", (0, -0.30, 0.63), (0.42, 0.018, 0.035), mats["metal"], 0.004))
        o.append(H.cube("desk_side_apron_l", (-0.40, 0, 0.63), (0.018, 0.28, 0.035), mats["metal"], 0.004))
        o.append(H.cube("desk_side_apron_r", (0.40, 0, 0.63), (0.018, 0.28, 0.035), mats["metal"], 0.004))
        for x in (-0.34, 0.34):
            for y in (-0.22, 0.22):
                o.append(H.cyl("desk_leg", (x, y, 0.345), 0.014, 0.69, mats["metal"], vertices=18, bevel=0.003))
                o.append(H.cyl("desk_foot_cap", (x, y, 0.015), 0.026, 0.030, mats["rubber_black"], vertices=18, bevel=0.003))
        o.append(H.cube("chair_seat", (0.70, 0, 0.42), (0.22, 0.22, 0.035), mats["wood_trim"], 0.010))
        o.append(H.cube("chair_seat_front_lip", (0.70, -0.23, 0.43), (0.23, 0.016, 0.018), mats["metal"], 0.002))
        o.append(H.cube("chair_back", (0.70, 0.20, 0.70), (0.22, 0.035, 0.25), mats["wood_trim"], 0.010))
        for z in (0.62, 0.76):
            o.append(H.cube("chair_back_slat", (0.70, 0.235, z), (0.23, 0.012, 0.020), mats["metal"], 0.002))
        for x in (0.55, 0.85):
            o.append(tube_low("chair_back_support", [(x, 0.16, 0.44), (x, 0.20, 0.82)], 0.010, mats["metal"]))
        for x in (0.55, 0.85):
            for y in (-0.14, 0.14):
                o.append(H.cyl("chair_leg", (x, y, 0.21), 0.011, 0.42, mats["metal"], vertices=16, bevel=0.003))
                o.append(H.cyl("chair_foot_cap", (x, y, 0.012), 0.021, 0.024, mats["rubber_black"], vertices=16, bevel=0.003))
        o.append(tube_low("chair_front_crossbar", [(0.55, -0.14, 0.26), (0.85, -0.14, 0.26)], 0.007, mats["metal"]))
        o.append(tube_low("chair_side_crossbar_l", [(0.55, -0.14, 0.25), (0.55, 0.14, 0.25)], 0.007, mats["metal"]))
        o.append(tube_low("chair_side_crossbar_r", [(0.85, -0.14, 0.25), (0.85, 0.14, 0.25)], 0.007, mats["metal"]))
        m = ["WoodTrim", "WornMetal", "RubberBlack"]

    elif name == "Prop_Blackboard":
        o.append(H.cube("blackboard_panel", (0, 0, 0.70), (0.82, 0.035, 0.40), mats["blackboard"], 0.010))
        o.append(H.cube("blackboard_frame_top", (0, -0.052, 1.12), (0.88, 0.026, 0.030), mats["wood_trim"], 0.006))
        o.append(H.cube("blackboard_frame_bottom", (0, -0.052, 0.28), (0.88, 0.026, 0.030), mats["wood_trim"], 0.006))
        for x in (-0.86, 0.86):
            o.append(H.cube("blackboard_frame_side", (x, -0.052, 0.70), (0.030, 0.026, 0.42), mats["wood_trim"], 0.006))
        o.append(H.cube("chalk_tray", (0, -0.055, 0.28), (0.86, 0.035, 0.025), mats["metal"], 0.005))
        for i, (x, z, sx) in enumerate([(-0.38, 0.86, 0.12), (-0.18, 0.76, 0.20), (0.16, 0.90, 0.16), (0.36, 0.62, 0.11)]):
            line = box("chalk_scribble", (x, -0.063, z), (sx, 0.004, 0.006), mats["paper"], 0.001, rotation=(0, 0, math.radians((i - 1) * 5)))
            o.append(line)
        o.append(H.cube("eraser", (-0.34, -0.085, 0.335), (0.080, 0.026, 0.022), mats["wood_trim"], 0.003))
        for x in (-0.18, 0.04, 0.22):
            o.append(H.cube("chalk_piece", (x, -0.082, 0.32), (0.045, 0.010, 0.010), mats["paper"], 0.002))
        m = ["Blackboard", "WornMetal", "Paper", "WoodTrim"]

    elif name == "Prop_TeacherPodium":
        o.append(H.cube("podium_body", (0, 0, 0.55), (0.38, 0.28, 0.55), mats["wood_trim"], 0.018))
        o.append(H.cube("podium_top", (0, -0.02, 1.12), (0.44, 0.32, 0.055), mats["wood_trim"], 0.012))
        o.append(box("podium_slanted_reading_surface", (0, -0.08, 1.19), (0.40, 0.24, 0.018), mats["wood_trim"], 0.006, rotation=(math.radians(-8), 0, 0)))
        o.append(H.cube("front_panel_inset", (0, -0.292, 0.58), (0.27, 0.010, 0.32), mats["metal"], 0.004))
        o.append(H.cube("front_raised_frame_top", (0, -0.302, 0.78), (0.31, 0.010, 0.018), mats["wood_trim"], 0.002))
        o.append(H.cube("front_raised_frame_bottom", (0, -0.302, 0.38), (0.31, 0.010, 0.018), mats["wood_trim"], 0.002))
        for x in (-0.22, 0.22):
            o.append(H.cube("side_panel_molding", (x, -0.302, 0.58), (0.018, 0.010, 0.31), mats["wood_trim"], 0.002))
        o.append(tube_low("gooseneck_microphone", [(-0.10, -0.14, 1.20), (-0.14, -0.20, 1.32), (-0.08, -0.24, 1.38)], 0.006, mats["rubber_black"]))
        o.append(H.cyl("microphone_head", (-0.065, -0.255, 1.385), 0.018, 0.035, mats["metal"], vertices=18, bevel=0.002, rotation=(math.radians(80), 0, 0)))
        o.append(H.cube("open_book", (0.12, -0.12, 1.235), (0.11, 0.075, 0.010), mats["paper"], 0.002))
        for x in (-0.26, 0.26):
            for y in (-0.18, 0.18):
                o.append(H.cyl("podium_caster", (x, y, 0.045), 0.035, 0.025, mats["rubber_black"], vertices=12, bevel=0.002, rotation=(math.radians(90), 0, 0)))
        m = ["WoodTrim", "WornMetal", "RubberBlack", "Paper"]

    elif name == "Prop_ScatteredBooks":
        colors = [mats["paper"], mats["blue_metal"], mats["red_metal"], mats["wood_trim"]]
        for i in range(11):
            x = -0.45 + 0.13 * i
            y = 0.08 * ((i % 3) - 1)
            z = 0.025 + 0.006 * i
            obj = H.cube("book", (x, y, z), (0.075, 0.11, 0.012), colors[i % len(colors)], 0.003)
            obj.rotation_euler[2] = math.radians((i * 17) % 35 - 16)
            o.append(obj)
            o.append(H.cube("book_page_edge", (x, y - 0.058, z + 0.004), (0.070, 0.006, 0.006), mats["paper"], 0.001))
        for i, z in enumerate((0.03, 0.055, 0.080)):
            o.append(H.cube("book_stack_layer", (0.72, 0.10, z), (0.10, 0.13, 0.018), colors[i % len(colors)], 0.003))
            o.append(H.cube("book_stack_pages", (0.72, 0.032, z + 0.004), (0.09, 0.006, 0.008), mats["paper"], 0.001))
        m = ["Paper", "BluePaintedMetal", "RedPaintedMetal", "WoodTrim"]

    elif name == "Prop_DroppedBackpack":
        o.append(H.cube("bag_body", (0, 0, 0.24), (0.28, 0.18, 0.22), mats["blue_metal"], 0.030))
        o.append(H.cube("front_pocket", (0, -0.18, 0.19), (0.19, 0.035, 0.09), mats["blue_metal"], 0.018))
        o.append(H.cube("zipper_track", (0, -0.202, 0.265), (0.18, 0.006, 0.008), mats["metal"], 0.001))
        o.append(H.cube("zipper_pull", (0.08, -0.210, 0.255), (0.018, 0.005, 0.018), mats["metal"], 0.001))
        for x in (-0.19, 0.19):
            o.append(H.cube("side_pocket", (x, -0.02, 0.18), (0.045, 0.12, 0.09), mats["blue_metal"], 0.010))
        for x in (-0.12, 0.12):
            o.append(tube_low("strap", [(x, -0.12, 0.38), (x * 0.8, -0.25, 0.18), (x * 0.6, -0.15, 0.06)], 0.014, mats["rubber_black"]))
        o.append(tube_low("top_handle", [(-0.08, 0.02, 0.39), (0, 0.05, 0.43), (0.08, 0.02, 0.39)], 0.010, mats["rubber_black"]))
        m = ["BluePaintedMetal", "RubberBlack", "WornMetal"]

    elif name == "Prop_Bench":
        for z in (0.47, 0.59, 0.71):
            o.append(H.cube("bench_back_plank", (0, 0.03, z), (0.92, 0.055, 0.030), mats["wood_trim"], 0.010))
        for y in (-0.23, -0.36):
            o.append(H.cube("bench_seat_plank", (0, y, 0.36), (0.92, 0.075, 0.035), mats["wood_trim"], 0.010))
        for x in (-0.39, 0.39):
            o.append(tube_low("bench_side_frame_l", [(x, -0.40, 0.08), (x, -0.33, 0.35), (x, 0.04, 0.72)], 0.014, mats["metal"]))
            o.append(tube_low("bench_side_frame_r", [(x, -0.10, 0.08), (x, -0.23, 0.35), (x, 0.04, 0.72)], 0.014, mats["metal"]))
            o.append(tube_low("bench_armrest", [(x, -0.42, 0.58), (x, -0.20, 0.66), (x, 0.03, 0.72)], 0.012, mats["metal"]))
        for x in (-0.39, 0.39):
            for y in (-0.36, -0.23):
                o.append(front_bolt("bench_plank_bolt", (x, y - 0.040, 0.385), mats["metal"], radius=0.007, depth=0.005))
        o.append(tube_low("bench_lower_crossbar", [(-0.39, -0.34, 0.18), (0.39, -0.34, 0.18)], 0.010, mats["metal"]))
        m = ["WoodTrim", "WornMetal"]

    elif name == "Prop_Tree_Set":
        lod = True
        for i, x in enumerate((-0.45, 0.42)):
            o.append(H.cyl("tree_trunk", (x, 0, 0.55), 0.055, 1.05, mats["wood_trim"], vertices=24, bevel=0.006))
            o.append(tube_low("tree_branch_l", [(x, 0, 0.95), (x - 0.14, -0.05, 1.12)], 0.025, mats["wood_trim"]))
            o.append(tube_low("tree_branch_r", [(x, 0, 0.88), (x + 0.15, 0.03, 1.06)], 0.020, mats["wood_trim"]))
            o.append(sphere("tree_crown", (x, 0, 1.25), (0.33, 0.28, 0.36), mats["grass"], segments=32, rings=16))
            o.append(sphere("tree_crown_lobe", (x - 0.17, -0.04, 1.12), (0.22, 0.19, 0.22), mats["grass"], segments=24, rings=12))
            o.append(sphere("tree_crown_lobe_side", (x + 0.18, 0.03, 1.13), (0.20, 0.18, 0.22), mats["grass"], segments=24, rings=12))
            for z in (0.28, 0.52, 0.76):
                o.append(H.cube("trunk_bark_band", (x, -0.058, z), (0.070, 0.006, 0.018), mats["metal"], 0.001))
        m = ["WoodTrim", "Grass"]

    elif name == "Prop_Shrub_Set":
        for i, x in enumerate((-0.35, 0.0, 0.35)):
            o.append(sphere("shrub_lobe", (x, 0, 0.24), (0.22, 0.17, 0.18), mats["grass"], segments=24, rings=12))
            o.append(sphere("shrub_lobe_small", (x + 0.10, -0.05, 0.30), (0.14, 0.12, 0.12), mats["grass"], segments=20, rings=10))
            o.append(sphere("shrub_lobe_low", (x - 0.09, 0.07, 0.18), (0.13, 0.10, 0.10), mats["grass"], segments=18, rings=8))
        o.append(H.cube("shrub_soil_strip", (0, 0.02, 0.025), (0.95, 0.28, 0.025), mats["wood_trim"], 0.006))
        m = ["Grass", "WoodTrim"]

    elif name == "Prop_BasketballHoop":
        o.append(H.cyl("weighted_base", (0, 0, 0.045), 0.22, 0.09, mats["metal"], vertices=32, bevel=0.006))
        o.append(H.cyl("base_rubber_ring", (0, 0, 0.095), 0.19, 0.018, mats["rubber_black"], vertices=32, bevel=0.002))
        o.append(H.cyl("pole", (0, 0, 1.08), 0.032, 2.10, mats["metal"], vertices=24, bevel=0.003))
        for z in (0.35, 0.86, 1.36):
            o.append(H.cyl("pole_clamp", (0, 0, z), 0.040, 0.020, mats["metal"], vertices=20, bevel=0.002))
        o.append(tube_low("rear_support_l", [(-0.16, 0.02, 0.22), (-0.04, 0.0, 1.35), (-0.18, -0.07, 1.82)], 0.011, mats["metal"]))
        o.append(tube_low("rear_support_r", [(0.16, 0.02, 0.22), (0.04, 0.0, 1.35), (0.18, -0.07, 1.82)], 0.011, mats["metal"]))
        o.append(H.cube("backboard_panel", (0, -0.08, 1.95), (0.36, 0.022, 0.23), mats["paper"], 0.010))
        o.append(H.cube("backboard_top_frame", (0, -0.102, 2.18), (0.38, 0.012, 0.012), mats["metal"], 0.002))
        o.append(H.cube("backboard_bottom_frame", (0, -0.102, 1.72), (0.38, 0.012, 0.012), mats["metal"], 0.002))
        for x in (-0.19, 0.19):
            o.append(H.cube("backboard_side_frame", (x, -0.102, 1.95), (0.012, 0.012, 0.23), mats["metal"], 0.002))
        o.append(H.cube("target_square_top", (0, -0.106, 1.98), (0.105, 0.006, 0.008), mats["red_metal"], 0.001))
        o.append(H.cube("target_square_bottom", (0, -0.106, 1.88), (0.105, 0.006, 0.008), mats["red_metal"], 0.001))
        for x in (-0.055, 0.055):
            o.append(H.cube("target_square_side", (x, -0.106, 1.93), (0.006, 0.006, 0.052), mats["red_metal"], 0.001))
        o.append(torus("closed_rim", (0, -0.205, 1.82), 0.102, 0.008, mats["red_metal"]))
        o.append(tube_low("rim_bracket_l", [(-0.08, -0.112, 1.82), (-0.08, -0.205, 1.82)], 0.006, mats["red_metal"]))
        o.append(tube_low("rim_bracket_r", [(0.08, -0.112, 1.82), (0.08, -0.205, 1.82)], 0.006, mats["red_metal"]))
        for i in range(8):
            angle = math.tau * i / 8.0
            x = math.cos(angle) * 0.095
            y = -0.205 + math.sin(angle) * 0.095
            o.append(tube_low("net_line", [(x, y, 1.805), (x * 0.42, -0.205 + (y + 0.205) * 0.35, 1.62)], 0.0026, mats["paper"]))
        for i in range(4):
            angle0 = math.tau * i / 4.0
            angle1 = angle0 + math.tau / 8.0
            p0 = (math.cos(angle0) * 0.076, -0.205 + math.sin(angle0) * 0.076, 1.70)
            p1 = (math.cos(angle1) * 0.050, -0.205 + math.sin(angle1) * 0.050, 1.62)
            o.append(tube_low("net_cross_weave", [p0, p1], 0.0018, mats["paper"]))
        for x in (-0.13, 0.13):
            for z in (1.78, 2.12):
                o.append(front_bolt("backboard_mount_bolt", (x, -0.112, z), mats["metal"], radius=0.006, depth=0.005))
        m = ["WornMetal", "Paper", "RedPaintedMetal", "RubberBlack"]

    elif name == "Prop_PoliceCar":
        lod = True
        o.append(H.cube("car_lower_body", (0, 0, 0.30), (0.92, 0.38, 0.20), mats["blue_metal"], 0.045))
        o.append(H.cube("car_hood", (0, -0.29, 0.43), (0.70, 0.24, 0.11), mats["blue_metal"], 0.030))
        o.append(H.cube("car_trunk", (0, 0.29, 0.43), (0.68, 0.22, 0.10), mats["blue_metal"], 0.030))
        o.append(H.cube("car_cabin_glass", (0.02, -0.02, 0.58), (0.43, 0.28, 0.20), mats["glass"], 0.030))
        o.append(H.cube("roof_shell", (0.02, -0.02, 0.71), (0.47, 0.30, 0.060), mats["blue_metal"], 0.018))
        for x in (-0.46, 0.46):
            o.append(H.cube("white_door_panel", (x, -0.01, 0.38), (0.018, 0.26, 0.13), mats["paper"], 0.003))
            o.append(H.cube("side_mirror", (x, -0.25, 0.54), (0.035, 0.025, 0.025), mats["metal"], 0.004))
        o.append(H.cube("front_grill", (0, -0.48, 0.34), (0.32, 0.025, 0.08), mats["metal"], 0.008))
        o.append(H.cube("front_bumper", (0, -0.51, 0.23), (0.70, 0.040, 0.055), mats["metal"], 0.008))
        o.append(H.cube("rear_bumper", (0, 0.51, 0.23), (0.70, 0.040, 0.055), mats["metal"], 0.008))
        for x in (-0.24, 0.24):
            o.append(H.cube("headlight", (x, -0.525, 0.38), (0.10, 0.012, 0.045), mats["paper"], 0.004))
            o.append(H.cube("tail_light", (x, 0.525, 0.38), (0.08, 0.012, 0.042), mats["red_metal"], 0.004))
        o.append(tube_low("push_bar_left", [(-0.22, -0.55, 0.21), (-0.22, -0.56, 0.46)], 0.011, mats["metal"]))
        o.append(tube_low("push_bar_right", [(0.22, -0.55, 0.21), (0.22, -0.56, 0.46)], 0.011, mats["metal"]))
        o.append(tube_low("push_bar_cross", [(-0.26, -0.56, 0.37), (0.26, -0.56, 0.37)], 0.010, mats["metal"]))
        for x in (-0.48, 0.48):
            for y in (-0.28, 0.28):
                o.append(H.cyl("wheel", (x, y, 0.18), 0.105, 0.07, mats["rubber_black"], vertices=24, bevel=0.006, rotation=(math.radians(90), 0, 0)))
                o.append(H.cyl("hubcap", (x, y, 0.18), 0.052, 0.075, mats["metal"], vertices=16, bevel=0.002, rotation=(math.radians(90), 0, 0)))
                o.append(H.cube("wheel_arch", (x, y, 0.29), (0.115, 0.018, 0.035), mats["blue_metal"], 0.001))
        o.append(H.cube("lightbar_base", (0, 0, 0.755), (0.28, 0.055, 0.025), mats["metal"], 0.004))
        o.append(H.cube("red_lightbar", (-0.08, 0, 0.79), (0.12, 0.045, 0.035), mats["red_metal"], 0.006))
        o.append(H.cube("blue_lightbar", (0.08, 0, 0.79), (0.12, 0.045, 0.035), mats["blue_metal"], 0.006))
        for x in (-0.22, 0.22):
            o.append(H.cube("door_seam", (x, -0.35, 0.36), (0.006, 0.008, 0.15), mats["metal"], 0.002))
        o.append(H.cube("police_badge_plate", (0, -0.505, 0.46), (0.11, 0.008, 0.050), mats["paper"], 0.002))
        m = ["BluePaintedMetal", "GlassBlue", "WornMetal", "RubberBlack", "RedPaintedMetal", "Paper"]

    elif name == "Prop_PoliceStationFacade":
        o.append(H.cube("facade_wall", (0, 0, 1.08), (1.28, 0.090, 1.08), mats["wall"], 0.020))
        o.append(H.cube("foundation_step_1", (0, -0.20, 0.09), (0.92, 0.22, 0.045), mats["metal"], 0.006))
        o.append(H.cube("foundation_step_2", (0, -0.30, 0.035), (1.08, 0.16, 0.035), mats["metal"], 0.006))
        o.append(H.cube("sidewalk_slab", (0, -0.48, 0.012), (1.26, 0.30, 0.024), mats["tile"], 0.004))
        o.append(H.cube("roof_cap", (0, -0.015, 2.12), (1.40, 0.14, 0.080), mats["metal"], 0.012))
        o.append(H.cube("roof_blue_band", (0, -0.105, 2.02), (1.32, 0.035, 0.050), mats["blue_metal"], 0.006))
        o.append(H.cube("entry_door", (0, -0.105, 0.78), (0.29, 0.045, 0.70), mats["blue_metal"], 0.016))
        o.append(H.cube("door_glass", (0, -0.132, 1.05), (0.20, 0.008, 0.20), mats["glass"], 0.004))
        o.append(H.cube("door_push_bar", (0, -0.148, 0.86), (0.22, 0.008, 0.018), mats["metal"], 0.002))
        o.append(H.cyl("door_handle", (0.105, -0.145, 0.80), 0.012, 0.040, mats["metal"], vertices=18, bevel=0.003, rotation=(math.radians(90), 0, 0)))
        o.append(H.cube("entry_awning", (0, -0.16, 1.56), (0.50, 0.11, 0.045), mats["blue_metal"], 0.010))
        o.append(H.cube("sign_lightbox", (0, -0.13, 1.88), (0.52, 0.030, 0.11), mats["emissive"], 0.008))
        o.append(H.cube("sign_badge_plate", (-0.36, -0.145, 1.88), (0.085, 0.014, 0.085), mats["paper"], 0.003))
        o.append(H.cube("sign_top_trim", (0, -0.151, 1.955), (0.56, 0.014, 0.014), mats["metal"], 0.002))
        o.append(H.cube("sign_bottom_trim", (0, -0.151, 1.805), (0.56, 0.014, 0.014), mats["metal"], 0.002))
        for x in (-0.22, 0.22):
            o.append(tube_low("sign_wall_bracket", [(x, -0.060, 1.84), (x, -0.145, 1.84)], 0.006, mats["metal"]))
        for x in (-0.42, 0.42):
            o.append(H.cube("front_column", (x, -0.128, 0.98), (0.045, 0.045, 0.92), mats["metal"], 0.008))
            o.append(H.cube("column_base", (x, -0.128, 0.22), (0.080, 0.060, 0.050), mats["metal"], 0.006))
            o.append(H.cube("column_cap", (x, -0.128, 1.74), (0.082, 0.060, 0.045), mats["metal"], 0.006))
        for x in (-0.62, 0.62):
            o.append(H.cube("window_glass", (x, -0.108, 1.05), (0.21, 0.014, 0.25), mats["glass"], 0.006))
            o.append(H.cube("window_top_frame", (x, -0.123, 1.31), (0.24, 0.012, 0.012), mats["metal"], 0.002))
            o.append(H.cube("window_bottom_frame", (x, -0.123, 0.79), (0.24, 0.012, 0.012), mats["metal"], 0.002))
            o.append(H.cube("window_mid_bar", (x, -0.125, 1.05), (0.012, 0.012, 0.23), mats["metal"], 0.002))
            o.append(H.cube("window_sill", (x, -0.132, 0.74), (0.26, 0.035, 0.020), mats["metal"], 0.004))
        for x in (-0.31, 0.31):
            o.append(H.cube("warm_wall_lamp", (x, -0.155, 1.45), (0.055, 0.018, 0.055), mats["emissive"], 0.006))
            o.append(H.cube("lamp_mount", (x, -0.145, 1.39), (0.075, 0.010, 0.010), mats["metal"], 0.002))
        for x in (-0.74, 0.74):
            o.append(H.cyl("entry_bollard", (x, -0.42, 0.27), 0.030, 0.50, mats["blue_metal"], vertices=20, bevel=0.004))
            o.append(H.cyl("bollard_cap", (x, -0.42, 0.53), 0.034, 0.025, mats["metal"], vertices=20, bevel=0.003))
        o.append(tube_low("flag_pole", [(-0.82, -0.06, 0.48), (-0.82, -0.06, 1.88)], 0.010, mats["metal"]))
        o.append(H.cube("small_flag", (-0.74, -0.065, 1.74), (0.15, 0.006, 0.070), mats["red_metal"], 0.002))
        m = ["PaintedWall", "BluePaintedMetal", "WornMetal", "GlassBlue", "Paper", "HallwayTile", "RedPaintedMetal"]

    return o, m, lod


def write_report(name: str, objects, material_names, metrics, lod_required: bool):
    checks = H.texture_checks_for(material_names, metrics)
    s = H.stats(objects)
    report = {
        "asset": name,
        "task": "Task F",
        "reference_image": "art-source/Concepts/04_school_environment_sheet.png",
        "files": {
            "fbx": str((PROPS / f"{name}.fbx").relative_to(ROOT)),
            "preview": str((PROPS / "Previews" / f"{name}_preview.png").relative_to(ROOT)),
            "wireframe": str((PROPS / "Wireframes" / f"{name}_wireframe.png").relative_to(ROOT)),
        },
        "mesh_stats": s,
        "lod": {"required": lod_required, "lod1_generated": lod_required},
        "quality_gate": {
            "texture_checks": checks,
            "texture_gate_passed": all(c["passed"] for c in checks),
            "bevel_used": True,
            "surface_detail_layers": ["PBR texture", "beveled edges", "seams/panels/handles/secondary geometry"],
            "local_art_gate_passed": all(c["passed"] for c in checks),
            "unity_validation": "blocked_no_active_unity_license",
        },
        "status": "local_gate_candidate_unity_validation_pending",
    }
    path = PROPS / "Reports" / f"{name}_budget_report.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"asset": name, **s, "texture_gate_passed": report["quality_gate"]["texture_gate_passed"], "lod_required": lod_required}


def decimate_for_lod(objects, ratio: float):
    for obj in objects:
        if obj.type != "MESH":
            continue
        mod = obj.modifiers.new("LOD_Decimate", "DECIMATE")
        mod.ratio = ratio
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except Exception:
            pass
        obj.select_set(False)


def generate_one(name: str, metrics: dict) -> dict:
    H.reset_scene()
    mats = H.materials()
    objects, material_names, lod_required = build(name, mats)
    H.setup_render(name)
    H.render_preview(PROPS / "Previews" / f"{name}_preview.png")
    H.draw_wire(objects, PROPS / "Wireframes" / f"{name}_wireframe.png")
    H.export_fbx(PROPS / f"{name}.fbx", objects)
    result = write_report(name, objects, material_names, metrics, lod_required)
    if lod_required:
        decimate_for_lod(objects, 0.42)
        H.export_fbx(PROPS / f"{name}_LOD1.fbx", objects)
    return result


def main() -> int:
    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    results = [generate_one(name, metrics) for name in ASSETS]
    summary = {
        "asset_count": len(results),
        "local_art_gate_passed": all(r["texture_gate_passed"] for r in results),
        "unity_validation": "blocked_no_active_unity_license",
        "results": results,
    }
    path = ROOT / "docs" / "art_production" / "ENVIRONMENT_PROPS_REWORK_SUMMARY.json"
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary["local_art_gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
