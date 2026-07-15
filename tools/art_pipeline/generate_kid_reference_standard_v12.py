#!/usr/bin/env python3
"""Generate a reference-standard stylized kid model.

This pass targets the supplied reference: natural kid proportions, large
expressive eyes, layered black hair, navy hoodie, black shorts, striped socks,
red sneakers, and clear backpack straps. It is an art-only standalone asset
candidate, kept separate from earlier Hunyuan/MPFB batches.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION_DIR = "KidReferenceRework_2026_07_12_v12"
ASSET = "Kid_Reference_Stylized_v12"
OUT_DIR = ROOT / "art-source" / "Characters" / "Kid" / "ReferenceStandard" / VERSION_DIR
PREVIEW = OUT_DIR / "Previews" / f"{ASSET}_preview.png"
WIRE = OUT_DIR / "Wireframes" / f"{ASSET}_wireframe.png"
REPORT = OUT_DIR / "Reports" / f"{ASSET}_budget_report.json"
SUMMARY = ROOT / "docs" / "art_production" / "KID_REFERENCE_STANDARD_REWORK_SUMMARY_V12.json"


def run_blender() -> None:
    subprocess.run(
        ["blender", "--background", "--python", str(Path(__file__).resolve()), "--", "--build"],
        cwd=str(ROOT),
        check=True,
    )


def build() -> None:
    import bpy
    from mathutils import Vector

    def reset_scene() -> None:
        bpy.ops.object.select_all(action="SELECT")
        bpy.ops.object.delete()
        bpy.context.scene.render.engine = "CYCLES"
        bpy.context.scene.cycles.samples = 96
        bpy.context.scene.cycles.use_denoising = True
        bpy.context.scene.view_settings.view_transform = "Filmic"
        bpy.context.scene.view_settings.look = "Medium High Contrast"
        bpy.context.scene.render.resolution_x = 1440
        bpy.context.scene.render.resolution_y = 1900
        bpy.context.scene.world = bpy.data.worlds.new("Kid_Reference_White_World") if not bpy.context.scene.world else bpy.context.scene.world
        bpy.context.scene.world.color = (1.0, 1.0, 1.0)

    def make_mat(name: str, base, roughness=0.55, metallic=0.0, noise_scale=0.0, bump_strength=0.0, bump_distance=0.008):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        bsdf = nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = base
            bsdf.inputs["Roughness"].default_value = roughness
            bsdf.inputs["Metallic"].default_value = metallic
            if noise_scale and bump_strength:
                noise = nodes.new("ShaderNodeTexNoise")
                noise.inputs["Scale"].default_value = noise_scale
                noise.inputs["Detail"].default_value = 14
                noise.inputs["Roughness"].default_value = 0.64
                bump = nodes.new("ShaderNodeBump")
                bump.inputs["Strength"].default_value = bump_strength
                bump.inputs["Distance"].default_value = bump_distance
                mat.node_tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
                mat.node_tree.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
        return mat

    def finish(obj, mat, shade=True, weighted=True):
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        if shade:
            for poly in obj.data.polygons:
                poly.use_smooth = True
        if weighted and obj.type == "MESH":
            try:
                mod = obj.modifiers.new("Weighted_Normals", "WEIGHTED_NORMAL")
                mod.keep_sharp = True
            except Exception:
                pass
        return obj

    def apply_transform(obj):
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    def uv_sphere(name, loc, scale, mat, segments=48, rings=24, rotation=(0, 0, 0), decimate=None):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc, rotation=rotation)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        apply_transform(obj)
        if decimate:
            mod = obj.modifiers.new("Budget_Decimate", "DECIMATE")
            mod.ratio = decimate
        return finish(obj, mat)

    def cube(name, loc, scale, mat, bevel=0.0, rotation=(0, 0, 0)):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rotation)
        obj = bpy.context.object
        obj.name = name
        obj.scale = scale
        apply_transform(obj)
        if bevel:
            mod = obj.modifiers.new("Soft_Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 8
            mod.affect = "EDGES"
        return finish(obj, mat, shade=True)

    def cylinder(name, loc, radius, depth, mat, vertices=48, rotation=(0, 0, 0), bevel=0.0):
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc, rotation=rotation)
        obj = bpy.context.object
        obj.name = name
        if bevel:
            mod = obj.modifiers.new("Soft_Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = 5
        return finish(obj, mat)

    def tube(name, points, radius, mat, resolution=4):
        curve = bpy.data.curves.new(name + "_Curve", "CURVE")
        curve.dimensions = "3D"
        curve.resolution_u = resolution
        curve.bevel_depth = radius
        curve.bevel_resolution = 4
        spl = curve.splines.new("POLY")
        spl.points.add(len(points) - 1)
        for point, co in zip(spl.points, points):
            point.co = (co[0], co[1], co[2], 1.0)
        obj = bpy.data.objects.new(name, curve)
        bpy.context.collection.objects.link(obj)
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.convert(target="MESH")
        return finish(bpy.context.object, mat)

    def torus(name, loc, major, minor, mat, rotation=(0, 0, 0), major_segments=96, minor_segments=14):
        bpy.ops.mesh.primitive_torus_add(
            major_segments=major_segments,
            minor_segments=minor_segments,
            major_radius=major,
            minor_radius=minor,
            location=loc,
            rotation=rotation,
        )
        obj = bpy.context.object
        obj.name = name
        return finish(obj, mat)

    def hair_lock(name, loc, length, width, thickness, mat, rotation=(0, 0, 0), bend=0.0, segments=10, sides=14):
        verts = []
        faces = []
        for i in range(segments):
            t = i / max(segments - 1, 1)
            taper = math.sin(math.pi * (0.08 + 0.84 * t))
            taper = max(0.04, taper) * (1.02 - t * 0.30)
            cx = bend * math.sin(math.pi * t)
            cz = -length * t
            for j in range(sides):
                a = math.tau * j / sides
                rx = width * taper * math.cos(a)
                ry = thickness * taper * math.sin(a)
                verts.append((cx + rx, ry, cz))
        for i in range(segments - 1):
            for j in range(sides):
                a = i * sides + j
                b = i * sides + (j + 1) % sides
                c = (i + 1) * sides + (j + 1) % sides
                d = (i + 1) * sides + j
                faces.append((a, b, c, d))
        faces.append(tuple(range(sides - 1, -1, -1)))
        end = (segments - 1) * sides
        faces.append(tuple(end + j for j in range(sides)))
        mesh = bpy.data.meshes.new(name + "_Mesh")
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = loc
        obj.rotation_euler = rotation
        return finish(obj, mat)

    def look_at(obj, target: Vector) -> None:
        direction = target - obj.location
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

    def triangle_count(objects) -> int:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        total = 0
        for obj in objects:
            if obj.type != "MESH" or obj.get("exclude_from_export"):
                continue
            eval_obj = obj.evaluated_get(depsgraph)
            mesh = eval_obj.to_mesh()
            mesh.calc_loop_triangles()
            total += len(mesh.loop_triangles)
            eval_obj.to_mesh_clear()
        return total

    def create_armature():
        bpy.ops.object.armature_add(location=(0, 0, 0.0))
        arm = bpy.context.object
        arm.name = "Rig_Humanoid_ReferenceKid"
        bpy.ops.object.mode_set(mode="EDIT")
        bones = arm.data.edit_bones
        root = bones[0]
        root.name = "Hips"
        root.head = (0, 0, 0.70)
        root.tail = (0, 0, 0.88)
        spine = bones.new("Spine")
        spine.head = root.tail
        spine.tail = (0, 0, 1.07)
        spine.parent = root
        chest = bones.new("Chest")
        chest.head = spine.tail
        chest.tail = (0, 0, 1.18)
        chest.parent = spine
        neck = bones.new("Neck")
        neck.head = chest.tail
        neck.tail = (0, 0, 1.25)
        neck.parent = chest
        head = bones.new("Head")
        head.head = neck.tail
        head.tail = (0, 0, 1.50)
        head.parent = neck
        for side, sx in [("L", -1), ("R", 1)]:
            upper = bones.new(f"UpperArm_{side}")
            upper.head = (sx * 0.130, 0, 1.13)
            upper.tail = (sx * 0.245, 0, 0.94)
            upper.parent = chest
            lower = bones.new(f"LowerArm_{side}")
            lower.head = upper.tail
            lower.tail = (sx * 0.285, 0, 0.75)
            lower.parent = upper
            hand = bones.new(f"Hand_{side}")
            hand.head = lower.tail
            hand.tail = (sx * 0.290, 0, 0.66)
            hand.parent = lower
            thigh = bones.new(f"UpperLeg_{side}")
            thigh.head = (sx * 0.060, 0, 0.70)
            thigh.tail = (sx * 0.070, 0, 0.43)
            thigh.parent = root
            calf = bones.new(f"LowerLeg_{side}")
            calf.head = thigh.tail
            calf.tail = (sx * 0.075, 0, 0.18)
            calf.parent = thigh
            foot = bones.new(f"Foot_{side}")
            foot.head = calf.tail
            foot.tail = (sx * 0.075, -0.070, 0.06)
            foot.parent = calf
        bpy.ops.object.mode_set(mode="OBJECT")
        arm.hide_render = True
        return arm

    def bind_parent(obj, arm):
        obj.parent = arm

    reset_scene()

    mats = {
        "skin": make_mat("KidRef_Skin_Warm", (0.76, 0.48, 0.30, 1), 0.52, noise_scale=68, bump_strength=0.010, bump_distance=0.006),
        "skin_soft": make_mat("KidRef_Skin_SoftHighlight", (0.90, 0.62, 0.42, 1), 0.54),
        "blush": make_mat("KidRef_Cheek_Blush", (0.95, 0.34, 0.28, 1), 0.62),
        "hair": make_mat("KidRef_Hair_DeepBlackBrown", (0.018, 0.014, 0.010, 1), 0.44, noise_scale=95, bump_strength=0.035, bump_distance=0.014),
        "hair_hi": make_mat("KidRef_Hair_WarmHighlight", (0.11, 0.085, 0.062, 1), 0.48),
        "hoodie": make_mat("KidRef_Navy_Hoodie_Fleece", (0.010, 0.020, 0.052, 1), 0.84, noise_scale=55, bump_strength=0.055, bump_distance=0.020),
        "hoodie_dark": make_mat("KidRef_Hoodie_ShadowRib", (0.005, 0.010, 0.028, 1), 0.88, noise_scale=70, bump_strength=0.045, bump_distance=0.014),
        "shorts": make_mat("KidRef_Black_DenimShorts", (0.010, 0.010, 0.010, 1), 0.82, noise_scale=82, bump_strength=0.050, bump_distance=0.018),
        "shorts_edge": make_mat("KidRef_Denim_EdgeWear", (0.095, 0.092, 0.088, 1), 0.72),
        "strap": make_mat("KidRef_Backpack_BlackNylon", (0.006, 0.006, 0.007, 1), 0.67, noise_scale=90, bump_strength=0.040, bump_distance=0.012),
        "strap_edge": make_mat("KidRef_Backpack_Stitch", (0.16, 0.16, 0.15, 1), 0.58),
        "lace": make_mat("KidRef_Cord_White", (0.88, 0.86, 0.80, 1), 0.44),
        "eye_white": make_mat("KidRef_EyeWhite", (0.98, 0.94, 0.86, 1), 0.32),
        "iris": make_mat("KidRef_Iris_Brown", (0.33, 0.16, 0.055, 1), 0.24),
        "pupil": make_mat("KidRef_Pupil", (0.004, 0.003, 0.002, 1), 0.18),
        "highlight": make_mat("KidRef_EyeHighlight", (1, 1, 0.94, 1), 0.12),
        "sock": make_mat("KidRef_Sock_WhiteCotton", (0.86, 0.85, 0.78, 1), 0.72, noise_scale=45, bump_strength=0.030, bump_distance=0.010),
        "shoe": make_mat("KidRef_RedCanvasSneaker", (0.76, 0.115, 0.055, 1), 0.64, noise_scale=60, bump_strength=0.040, bump_distance=0.012),
        "sole": make_mat("KidRef_OffWhite_RubberSole", (0.78, 0.72, 0.62, 1), 0.66, noise_scale=42, bump_strength=0.025, bump_distance=0.008),
        "metal": make_mat("KidRef_DarkMetal_Buckle", (0.035, 0.033, 0.030, 1), 0.36, metallic=0.25),
    }

    objects = []

    # Body and face proportions are closer to the reference than the old toy-like v10.
    objects.append(uv_sphere("Head_Rounded_KidFace", (0, -0.006, 1.318), (0.118, 0.099, 0.146), mats["skin"], 72, 36))
    objects.append(uv_sphere("Neck", (0, 0.004, 1.145), (0.032, 0.030, 0.038), mats["skin"], 36, 18))
    objects.append(uv_sphere("Left_Ear", (-0.119, -0.004, 1.318), (0.019, 0.012, 0.030), mats["skin"], 32, 16))
    objects.append(uv_sphere("Right_Ear", (0.119, -0.004, 1.318), (0.019, 0.012, 0.030), mats["skin"], 32, 16))
    objects.append(uv_sphere("Left_InnerEar", (-0.123, -0.015, 1.316), (0.008, 0.003, 0.015), mats["skin_soft"], 20, 8))
    objects.append(uv_sphere("Right_InnerEar", (0.123, -0.015, 1.316), (0.008, 0.003, 0.015), mats["skin_soft"], 20, 8))

    for side in (-1, 1):
        x = side * 0.049
        objects.append(uv_sphere(f"EyeWhite_{side}", (x, -0.101, 1.333), (0.030, 0.008, 0.036), mats["eye_white"], 48, 20))
        objects.append(uv_sphere(f"Iris_{side}", (x, -0.111, 1.331), (0.016, 0.003, 0.021), mats["iris"], 36, 12))
        objects.append(uv_sphere(f"Pupil_{side}", (x, -0.114, 1.331), (0.008, 0.0018, 0.011), mats["pupil"], 24, 10))
        objects.append(uv_sphere(f"EyeCatchlight_{side}", (x - side * 0.008, -0.117, 1.344), (0.005, 0.0012, 0.006), mats["highlight"], 16, 6))
        objects.append(tube(f"UpperLid_{side}", [(x - side * 0.031, -0.116, 1.356), (x, -0.119, 1.367), (x + side * 0.031, -0.116, 1.356)], 0.0018, mats["hair"], 5))
        objects.append(tube(f"LowerLid_{side}", [(x - side * 0.026, -0.116, 1.310), (x, -0.118, 1.305), (x + side * 0.026, -0.116, 1.310)], 0.0012, mats["skin_soft"], 4))
        objects.append(tube(f"Eyebrow_{side}", [(x - side * 0.030, -0.121, 1.395), (x, -0.124, 1.404), (x + side * 0.030, -0.121, 1.395)], 0.0036, mats["hair"], 5))
        objects.append(uv_sphere(f"CheekBlush_{side}", (side * 0.061, -0.110, 1.270), (0.021, 0.0016, 0.010), mats["blush"], 18, 6, decimate=0.55))

    objects.append(uv_sphere("Nose_Button", (0, -0.116, 1.304), (0.010, 0.008, 0.014), mats["skin_soft"], 24, 10))
    objects.append(tube("Smile_SoftCurve", [(-0.026, -0.123, 1.260), (-0.008, -0.126, 1.252), (0.010, -0.126, 1.252), (0.027, -0.123, 1.260)], 0.0015, make_mat("KidRef_Smile_Warm", (0.44, 0.13, 0.095, 1), 0.46), 5))
    for i, (x, z) in enumerate([(-0.044, 1.300), (-0.034, 1.288), (0.045, 1.302), (0.034, 1.290)]):
        objects.append(uv_sphere(f"Freckle_{i}", (x, -0.128, z), (0.0024, 0.0007, 0.0024), make_mat("KidRef_Freckle", (0.28, 0.12, 0.070, 1), 0.55), 10, 4))

    # Hair cap and many sculpted locks. These are bulky tapered meshes, not a drawn-on hairline.
    objects.append(uv_sphere("Hair_BaseCap", (0, -0.003, 1.432), (0.132, 0.108, 0.091), mats["hair"], 72, 28))
    front_locks = [
        ("FrontLock_Center_Heavy", (0.006, -0.108, 1.486), 0.165, 0.030, 0.014, (0.18, 0.06, -0.18), -0.014),
        ("FrontLock_Left_Sweep", (-0.040, -0.108, 1.476), 0.142, 0.026, 0.013, (0.28, -0.18, 0.42), 0.016),
        ("FrontLock_Right_Sweep", (0.047, -0.108, 1.468), 0.125, 0.023, 0.012, (0.24, 0.18, -0.45), -0.014),
        ("ForeheadLock_LeftSmall", (-0.074, -0.097, 1.452), 0.100, 0.019, 0.010, (0.34, -0.22, 0.70), 0.010),
        ("ForeheadLock_RightSmall", (0.078, -0.096, 1.448), 0.092, 0.018, 0.010, (0.30, 0.18, -0.70), -0.010),
    ]
    crown_locks = [
        ("CrownLock_BackLeft", (-0.049, 0.000, 1.525), 0.120, 0.025, 0.013, (-0.38, -0.45, 0.85), 0.020),
        ("CrownLock_BackRight", (0.045, 0.002, 1.525), 0.120, 0.025, 0.013, (-0.35, 0.42, -0.85), -0.020),
        ("TopSpike_Left", (-0.040, -0.018, 1.530), 0.085, 0.017, 0.009, (-0.52, -0.55, 0.90), 0.010),
        ("TopSpike_Right", (0.052, -0.012, 1.525), 0.088, 0.017, 0.009, (-0.55, 0.50, -0.95), -0.010),
        ("SideLock_LeftOuter", (-0.118, -0.020, 1.430), 0.105, 0.020, 0.011, (0.08, -0.58, 1.45), 0.010),
        ("SideLock_RightOuter", (0.118, -0.020, 1.430), 0.105, 0.020, 0.011, (0.08, 0.58, -1.45), -0.010),
        ("Sideburn_Left", (-0.108, -0.070, 1.370), 0.080, 0.015, 0.008, (0.12, -0.20, 0.45), 0.005),
        ("Sideburn_Right", (0.108, -0.070, 1.370), 0.080, 0.015, 0.008, (0.12, 0.20, -0.45), -0.005),
    ]
    for name, loc, length, width, thickness, rotation, bend in front_locks + crown_locks:
        objects.append(hair_lock(name, loc, length, width, thickness, mats["hair"], rotation, bend, segments=12, sides=16))
    for x, z, length, rotz in [(-0.080, 1.445, 0.055, 0.72), (-0.026, 1.480, 0.070, 0.18), (0.030, 1.476, 0.066, -0.22), (0.080, 1.442, 0.052, -0.72)]:
        objects.append(hair_lock(f"Hair_Warm_Highlight_{x:.2f}", (x, -0.132, z), length, 0.006, 0.0024, mats["hair_hi"], (0.20, 0.0, rotz), 0.004, 8, 8))

    # Hoodie torso, hood, sleeves, drawstrings, pocket, and backpack.
    objects.append(cube("Hoodie_Body_RoundedFleece", (0, -0.010, 0.910), (0.205, 0.076, 0.270), mats["hoodie"], 0.036))
    objects.append(cube("Hoodie_Waist_Rib", (0, -0.048, 0.645), (0.205, 0.014, 0.027), mats["hoodie_dark"], 0.010))
    objects.append(torus("Hood_Collar_Ring", (0, -0.030, 1.130), 0.082, 0.017, mats["hoodie"], rotation=(math.pi / 2, 0, 0), major_segments=104, minor_segments=16))
    objects.append(uv_sphere("Hood_Back_Bowl", (0, 0.048, 1.130), (0.128, 0.060, 0.062), mats["hoodie"], 48, 18, decimate=0.72))
    objects.append(cube("KangarooPocket_Main", (0, -0.089, 0.805), (0.118, 0.010, 0.058), mats["hoodie"], 0.012))
    objects.append(tube("KangarooPocket_LeftSeam", [(-0.105, -0.102, 0.842), (-0.074, -0.105, 0.774)], 0.0022, mats["hoodie_dark"], 4))
    objects.append(tube("KangarooPocket_RightSeam", [(0.105, -0.102, 0.842), (0.074, -0.105, 0.774)], 0.0022, mats["hoodie_dark"], 4))
    objects.append(tube("Hoodie_Bottom_Stitch", [(-0.176, -0.091, 0.674), (0.176, -0.091, 0.674)], 0.0020, mats["hoodie_dark"], 2))
    for side in (-1, 1):
        sx = side * 0.044
        objects.append(tube(f"Drawstring_{side}", [(sx, -0.102, 1.090), (sx + side * 0.006, -0.108, 1.010), (sx + side * 0.001, -0.107, 0.970)], 0.0030, mats["lace"], 5))
        objects.append(uv_sphere(f"Drawstring_Knot_{side}", (sx + side * 0.005, -0.109, 1.020), (0.007, 0.0035, 0.009), mats["lace"], 16, 8))
        objects.append(cylinder(f"Drawstring_Tip_{side}", (sx + side * 0.001, -0.108, 0.952), 0.0035, 0.021, mats["lace"], 16, rotation=(0, 0, 0), bevel=0.001))
        objects.append(tube(f"Sleeve_{side}", [(side * 0.173, -0.010, 1.065), (side * 0.220, -0.015, 0.875), (side * 0.230, -0.018, 0.705)], 0.034, mats["hoodie"], 5))
        objects.append(uv_sphere(f"Shoulder_Cap_{side}", (side * 0.170, -0.004, 1.075), (0.043, 0.036, 0.060), mats["hoodie"], 28, 12))
        objects.append(tube(f"Sleeve_Fold_Upper_{side}", [(side * 0.194, -0.055, 0.950), (side * 0.224, -0.058, 0.928)], 0.0022, mats["hoodie_dark"], 3))
        objects.append(tube(f"Sleeve_Fold_Lower_{side}", [(side * 0.208, -0.057, 0.815), (side * 0.233, -0.058, 0.792)], 0.0020, mats["hoodie_dark"], 3))
        objects.append(torus(f"Sleeve_Cuff_{side}", (side * 0.232, -0.018, 0.692), 0.026, 0.007, mats["hoodie_dark"], rotation=(0, math.pi / 2, 0), major_segments=48, minor_segments=10))
        objects.append(uv_sphere(f"Palm_{side}", (side * 0.235, -0.027, 0.620), (0.022, 0.016, 0.035), mats["skin"], 28, 14))
        for i, off in enumerate([-0.020, -0.008, 0.004, 0.016]):
            objects.append(tube(f"Finger_{side}_{i}", [(side * (0.230 + off * side), -0.044, 0.603), (side * (0.232 + off * side), -0.050, 0.570)], 0.0035, mats["skin"], 2))
        objects.append(tube(f"Thumb_{side}", [(side * 0.217, -0.040, 0.620), (side * 0.200, -0.047, 0.590)], 0.0048, mats["skin"], 2))
        objects.append(tube(f"Backpack_PaddedStrap_{side}", [(side * 0.112, -0.116, 1.095), (side * 0.143, -0.124, 0.910), (side * 0.118, -0.118, 0.720)], 0.012, mats["strap"], 5))
        objects.append(tube(f"Backpack_EdgeStitch_{side}", [(side * 0.098, -0.133, 1.070), (side * 0.128, -0.140, 0.745)], 0.0014, mats["strap_edge"], 4))
        objects.append(cube(f"Strap_Adjuster_{side}", (side * 0.128, -0.134, 0.905), (0.016, 0.006, 0.022), mats["metal"], 0.004))

    # Shorts, legs, socks, shoes.
    objects.append(cube("Shorts_Waistband", (0, -0.030, 0.610), (0.182, 0.056, 0.032), mats["shorts"], 0.010))
    for side in (-1, 1):
        objects.append(cube(f"Shorts_Leg_{side}", (side * 0.060, -0.026, 0.510), (0.076, 0.062, 0.118), mats["shorts"], 0.018))
        objects.append(tube(f"Shorts_Hem_{side}", [(side * 0.012, -0.082, 0.400), (side * 0.116, -0.082, 0.400)], 0.0026, mats["shorts_edge"], 2))
        objects.append(tube(f"Shorts_SideSeam_{side}", [(side * 0.126, -0.080, 0.605), (side * 0.120, -0.080, 0.405)], 0.0018, mats["shorts_edge"], 2))
        objects.append(tube(f"Leg_{side}", [(side * 0.060, -0.002, 0.395), (side * 0.065, -0.002, 0.185)], 0.028, mats["skin"], 5))
        objects.append(uv_sphere(f"Knee_{side}", (side * 0.063, -0.025, 0.300), (0.027, 0.016, 0.024), mats["skin_soft"], 24, 10))
        objects.append(cylinder(f"Sock_{side}", (side * 0.068, -0.002, 0.145), 0.032, 0.125, mats["sock"], 40, bevel=0.002))
        for stripe, z in enumerate([0.185, 0.168]):
            objects.append(cylinder(f"Sock_NavyStripe_{side}_{stripe}", (side * 0.068, -0.002, z), 0.033, 0.009, mats["hoodie"], 40, bevel=0.001))
        objects.append(cube(f"Shoe_Sole_{side}", (side * 0.073, -0.050, 0.040), (0.062, 0.112, 0.018), mats["sole"], 0.009))
        objects.append(uv_sphere(f"Shoe_RedUpper_{side}", (side * 0.073, -0.073, 0.074), (0.055, 0.084, 0.034), mats["shoe"], 38, 14))
        objects.append(cube(f"Shoe_RedSidePanel_{side}", (side * 0.073, -0.098, 0.076), (0.050, 0.030, 0.025), mats["shoe"], 0.006))
        objects.append(uv_sphere(f"Shoe_WhiteToe_{side}", (side * 0.073, -0.132, 0.068), (0.034, 0.023, 0.017), mats["sole"], 24, 10))
        for lace_i, z in enumerate([0.093, 0.080, 0.067]):
            objects.append(tube(f"Shoe_Lace_{side}_{lace_i}", [(side * 0.043, -0.132, z), (side * 0.102, -0.132, z + 0.002)], 0.0024, mats["lace"], 2))
        for eyelet_i, xoff in enumerate([-0.020, 0.020]):
            for z in [0.092, 0.079, 0.066]:
                objects.append(uv_sphere(f"Shoe_Eyelet_{side}_{eyelet_i}_{z:.2f}", (side * (0.073 + xoff), -0.135, z), (0.0034, 0.0013, 0.0034), mats["metal"], 8, 4))

    arm = create_armature()
    for obj in objects:
        bind_parent(obj, arm)

    # Lighting and camera are set to a clean product-character view like the reference.
    bpy.ops.object.light_add(type="AREA", location=(-1.0, -2.7, 2.45))
    key = bpy.context.object
    key.name = "Key_Softbox"
    key.data.energy = 720
    key.data.size = 2.25
    bpy.ops.object.light_add(type="AREA", location=(1.2, -1.9, 1.35))
    fill = bpy.context.object
    fill.name = "Eye_Fill"
    fill.data.energy = 160
    fill.data.size = 1.6
    bpy.ops.object.light_add(type="AREA", location=(0.0, 0.9, 1.65))
    rim = bpy.context.object
    rim.name = "Hair_Rim_Light"
    rim.data.energy = 145
    rim.data.size = 1.4

    bpy.ops.object.camera_add(location=(0.0, -4.0, 0.90))
    cam = bpy.context.object
    look_at(cam, Vector((0, -0.01, 0.84)))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 1.64
    bpy.context.scene.camera = cam

    bpy.ops.mesh.primitive_plane_add(size=1.65, location=(0, 0, -0.010))
    floor = bpy.context.object
    floor.name = "Preview_Ground"
    floor["exclude_from_export"] = True
    floor.data.materials.append(make_mat("Preview_WhiteFloor", (0.92, 0.92, 0.90, 1), 0.74))
    bpy.ops.mesh.primitive_plane_add(size=3.2, location=(0, 0.92, 0.82), rotation=(math.pi / 2, 0, 0))
    backdrop = bpy.context.object
    backdrop.name = "Preview_WhiteBackdrop"
    backdrop["exclude_from_export"] = True
    backdrop.data.materials.append(make_mat("Preview_WhiteBackdropMat", (0.96, 0.96, 0.94, 1), 0.78))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "Previews").mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "Wireframes").mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "Reports").mkdir(parents=True, exist_ok=True)

    blend = OUT_DIR / f"{ASSET}.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend))

    export_objects = [obj for obj in objects + [arm] if not obj.get("exclude_from_export")]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = arm
    glb = OUT_DIR / f"{ASSET}.glb"
    fbx = OUT_DIR / f"{ASSET}.fbx"
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
    bpy.ops.export_scene.fbx(
        filepath=str(fbx),
        use_selection=True,
        object_types={"MESH", "ARMATURE"},
        apply_unit_scale=True,
        axis_forward="Z",
        axis_up="Y",
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="COPY",
        embed_textures=False,
    )

    bpy.context.scene.render.filepath = str(PREVIEW)
    bpy.ops.render.render(write_still=True)

    # Simple wireframe audit render.
    wire_mat = make_mat("Wireframe_Audit_Dark", (0.02, 0.02, 0.02, 1), 0.55)
    for obj in objects:
        if obj.type != "MESH":
            continue
        obj.data.materials.append(wire_mat)
        mod = obj.modifiers.new("Wire_Audit", "WIREFRAME")
        mod.thickness = 0.0014
        mod.use_replace = False
        mod.material_offset = len(obj.data.materials) - 1
    bpy.context.scene.render.filepath = str(WIRE)
    bpy.ops.render.render(write_still=True)

    tri_count = triangle_count(objects)
    report = {
        "asset": ASSET,
        "style": "ReferenceStandardStylized",
        "status": "art_only_reference_standard_candidate_user_visual_review_pending",
        "reference": "codex-clipboard-83a211f3-7725-48ba-a482-5d953147e159.png",
        "targets": [
            "Natural kid proportions instead of toy-like v10 proportions",
            "Layered volumetric black hair locks",
            "Large expressive eyes with iris, pupil, lids, brow, catchlight",
            "Navy hoodie with hood, drawstrings, pocket, ribbing, and fleece material",
            "Black shorts, bare legs, striped socks, red canvas sneakers",
            "Black backpack straps and adjusters",
        ],
        "outputs": {
            "blend": str(blend.relative_to(ROOT)),
            "fbx": str(fbx.relative_to(ROOT)),
            "glb": str(glb.relative_to(ROOT)),
            "preview": str(PREVIEW.relative_to(ROOT)),
            "wireframe": str(WIRE.relative_to(ROOT)),
        },
        "triangles": tri_count,
        "unity_validation": "blocked_no_active_unity_license",
        "limitations": [
            "Procedural local Blender model, not hand-sculpted studio topology.",
            "Armature is present as a layout skeleton; full production skinning and Unity Humanoid Avatar validation still need Unity license access.",
        ],
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    SUMMARY.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    if "--build" in sys.argv:
        build()
    else:
        run_blender()
