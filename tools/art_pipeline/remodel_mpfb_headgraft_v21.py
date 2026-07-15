#!/usr/bin/env python3
"""Build v21 review characters with MPFB adult head grafts.

The mature MPFB head topology is trimmed at the neck and aligned inside the
native Hunyuan hood/cap.  The generated body, clothing silhouette, arms, hands,
and role accessories stay unchanged.  No front-only face shell is used.
"""

from __future__ import annotations

import argparse
import sys
from math import cos, sin, tau
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import remodel_kid_v18_pilot as kit
import remodel_villain_police_v18 as adults
import remodel_native_hybrid_v20 as v20


REVIEW_ROOT = ROOT / "docs/art_production/fourview_remodel_v21_mpfb_headgraft"
POLICE_HEAD_REARWARD_OFFSET = 0.055

MPFB = {
    "Police": {
        "blend": ROOT / "art-source/Characters/Police/Photoreal/MPFBRoleRework_2026_07_12_v29/Police_Photoreal_MPFBHuman_v29.blend",
        "prefix": "Police_Photoreal_MPFBHuman_v29",
        "hair": "short01",
        "source_center": Vector((0.0, 0.0, 1.650)),
        "target_center": Vector((0.0, 0.065 + POLICE_HEAD_REARWARD_OFFSET, 1.548)),
        "neck_cut": 1.515,
        "scale": 1.15,
        "eye": Vector((0.03724, -0.1480, 1.68142)),
        "mouth_y": -0.153,
        "mouth_z": 1.550,
    },
    "Villain": {
        "blend": ROOT / "art-source/Characters/Villain/Photoreal/MPFBRoleRework_2026_07_12_v29/Villain_Photoreal_MPFBHuman_v29.blend",
        "prefix": "Villain_Photoreal_MPFBHuman_v29",
        "hair": "short02",
        "source_center": Vector((0.0, 0.0, 1.710)),
        "target_center": Vector((0.0, -0.006, 1.540)),
        "neck_cut": 1.565,
        "scale": 1.10,
        "eye": Vector((0.03840, -0.1520, 1.74391)),
        "mouth_y": -0.157,
        "mouth_z": 1.606,
    },
}


def trim_head(obj: bpy.types.Object, z_cut: float) -> None:
    obj.data = obj.data.copy()
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    doomed = []
    for vertex in mesh.verts:
        co = vertex.co
        neck_band = co.z < z_cut + 0.045
        outside_neck = neck_band and (abs(co.x) > 0.086 or not (-0.105 < co.y < 0.070))
        outside_head = abs(co.x) > 0.165 or not (-0.225 < co.y < 0.105)
        if co.z < z_cut or outside_neck or outside_head:
            doomed.append(vertex)
    bmesh.ops.delete(mesh, geom=doomed, context="VERTS")
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.update()


def refine_native_body(obj: bpy.types.Object, role: str) -> None:
    if role != "Police":
        return
    for vertex in obj.data.vertices:
        co = vertex.co
        upper = v20.smoothstep(0.72, 1.18, co.z)
        shoulder = v20.smoothstep(1.16, 1.30, co.z) * (1.0 - v20.smoothstep(1.48, 1.58, co.z))
        co.x *= 1.0 - 0.13 * upper - 0.045 * shoulder
        depth_center = -0.015
        co.y = depth_center + (co.y - depth_center) * (1.0 - 0.12 * upper)
        posture = v20.smoothstep(0.92, 1.30, co.z) * (1.0 - v20.smoothstep(1.54, 1.64, co.z))
        co.y += 0.026 * posture
        native_head = (
            v20.smoothstep(1.34, 1.43, co.z)
            * (1.0 - v20.smoothstep(1.61, 1.67, co.z))
            * (1.0 - v20.smoothstep(0.145, 0.190, abs(co.x)))
            * (1.0 - v20.smoothstep(0.080, 0.150, co.y))
        )
        co.y += 0.020 * native_head
        head_recenter = (
            v20.smoothstep(1.46, 1.56, co.z)
            * (1.0 - v20.smoothstep(0.17, 0.24, abs(co.x)))
        )
        co.y += POLICE_HEAD_REARWARD_OFFSET * head_recenter
        collar_drop = (
            v20.smoothstep(1.32, 1.40, co.z)
            * (1.0 - v20.smoothstep(1.52, 1.60, co.z))
            * (1.0 - v20.smoothstep(0.10, 0.20, abs(co.x)))
            * (1.0 - v20.smoothstep(0.14, 0.22, abs(co.y)))
        )
        co.z -= 0.045 * collar_drop
        shoulder_outer = v20.smoothstep(0.115, 0.285, abs(co.x))
        shoulder_peak = v20.smoothstep(1.16, 1.29, co.z) * (1.0 - v20.smoothstep(1.39, 1.49, co.z))
        co.z -= 0.038 * shoulder_outer * shoulder_peak
        # The native body includes its own head and neck shell. Keep that shell
        # inside the MPFB graft so it cannot mask the skin nape in rear views.
        # The fade ends below the cap band, preserving the fitted police cap.
        native_shell = (
            v20.smoothstep(1.335, 1.405, co.z)
            * (1.0 - v20.smoothstep(1.555, 1.605, co.z))
            * (1.0 - v20.smoothstep(0.145, 0.205, abs(co.x)))
        )
        shell_center_y = 0.065
        co.x *= 1.0 - 0.75 * native_shell
        co.y = shell_center_y + (co.y - shell_center_y) * (1.0 - 0.80 * native_shell)
        if co.z > 1.625:
            co.z = 1.625 + (co.z - 1.625) * 0.74
            co.y += 0.020

    obj.data.update()


def refine_kid_face(
    body: bpy.types.Object,
    features: list[bpy.types.Object],
    mats: dict[str, bpy.types.Material],
) -> list[bpy.types.Object]:
    colors = body.data.color_attributes.get("BodyPalette")
    if colors:
        skin = (0.46, 0.170, 0.075, 1.0)
        for vertex in body.data.vertices:
            co = vertex.co
            if 0.948 < co.z < 0.990 and abs(co.x) < 0.060 and co.y < -0.105:
                colors.data[vertex.index].color = skin

    kept: list[bpy.types.Object] = []
    for obj in features:
        if "Mouth" in obj.name:
            bpy.data.objects.remove(obj, do_unlink=True)
            continue
        if any(token in obj.name for token in ("Eye_", "Iris_", "Pupil_", "Glint_", "Lid_")):
            if obj.type == "MESH":
                center_z = sum(vertex.co.z for vertex in obj.data.vertices) / max(len(obj.data.vertices), 1)
                for vertex in obj.data.vertices:
                    vertex.co.y += 0.004
                    if "Eye_" in obj.name:
                        vertex.co.z = center_z + (vertex.co.z - center_z) * 0.64
                    elif any(token in obj.name for token in ("Iris_", "Pupil_")):
                        vertex.co.z = center_z + (vertex.co.z - center_z) * 0.72
            else:
                obj.location.y += 0.004
        kept.append(obj)
    return kept


def refine_police_accessories(objects: list[bpy.types.Object]) -> list[bpy.types.Object]:
    for obj in objects:
        delta = Vector((0.0, 0.0, 0.0))
        if "CapBadge" in obj.name:
            delta = Vector((0.0, 0.032 + POLICE_HEAD_REARWARD_OFFSET, -0.002))
        elif any(token in obj.name for token in ("ChestBadge", "Nameplate", "ShirtButton")):
            delta = Vector((0.0, 0.026, 0.0))
        elif "ShoulderPatch" in obj.name:
            delta = Vector((0.0, 0.022, -0.018))
        if delta.length_squared == 0.0:
            continue
        if obj.type == "MESH":
            obj.data.transform(Matrix.Translation(delta))
        else:
            obj.location += delta
    return objects


def add_police_neck_blend(mats: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Add a smooth anatomical bridge between the grafted head and uniform."""
    segments = 96
    rings = (
        # z, radius x, radius y, center y
        (1.405, 0.068, 0.068, 0.057),
        (1.422, 0.065, 0.066, 0.058),
        (1.442, 0.062, 0.064, 0.059),
        (1.462, 0.061, 0.065, 0.061),
        (1.482, 0.063, 0.068, 0.063),
        (1.502, 0.067, 0.073, 0.065),
    )
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int, int]] = []
    for z, radius_x, radius_y, center_y in rings:
        for segment in range(segments):
            angle = tau * segment / segments
            vertices.append((radius_x * cos(angle), center_y + radius_y * sin(angle), z))
    for ring in range(len(rings) - 1):
        for segment in range(segments):
            next_segment = (segment + 1) % segments
            a = ring * segments + segment
            b = ring * segments + next_segment
            c = (ring + 1) * segments + next_segment
            d = (ring + 1) * segments + segment
            faces.append((a, b, c, d))
    mesh = bpy.data.meshes.new("Police_v21_AnatomicalNeckBlend_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    neck = bpy.data.objects.new("Police_v21_AnatomicalNeckBlend", mesh)
    bpy.context.collection.objects.link(neck)
    neck.data.materials.append(mats["skin"])
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return neck


def add_police_uniform_collar(mats: dict[str, bpy.types.Material]) -> bpy.types.Object:
    """Build a front-open, softly beveled collar that masks the neck seam."""
    segments = 80
    start_angle = -0.70
    end_angle = tau * 0.5 + 0.70
    loop_specs = (
        # radius x, radius y, base z, follows angled top
        (0.086, 0.091, 1.367, False),
        (0.082, 0.086, 1.407, True),
        (0.069, 0.074, 1.407, True),
        (0.070, 0.076, 1.367, False),
    )
    center_y = 0.057
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int, int]] = []
    for radius_x, radius_y, base_z, angled in loop_specs:
        for segment in range(segments + 1):
            progress = segment / segments
            angle = start_angle + (end_angle - start_angle) * segment / segments
            if angled:
                end_taper = v20.smoothstep(0.0, 0.18, progress) * (
                    1.0 - v20.smoothstep(0.82, 1.0, progress)
                )
                z = 1.367 + (base_z - 1.367 + 0.004 * sin(angle)) * end_taper
            else:
                z = base_z
            vertices.append((radius_x * cos(angle), center_y + radius_y * sin(angle), z))
    for loop in range(len(loop_specs)):
        next_loop = (loop + 1) % len(loop_specs)
        for segment in range(segments):
            next_segment = segment + 1
            a = loop * (segments + 1) + segment
            b = loop * (segments + 1) + next_segment
            c = next_loop * (segments + 1) + next_segment
            d = next_loop * (segments + 1) + segment
            faces.append((a, b, c, d))
    for segment, reverse in ((0, False), (segments, True)):
        cap = tuple(loop * (segments + 1) + segment for loop in range(len(loop_specs)))
        faces.append(tuple(reversed(cap)) if reverse else cap)
    mesh = bpy.data.meshes.new("Police_v21_UniformCollar_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    collar = bpy.data.objects.new("Police_v21_UniformCollar", mesh)
    bpy.context.collection.objects.link(collar)
    collar.data.materials.append(mats["uniform"])
    bevel = collar.modifiers.new("TailoredCollarEdge", "BEVEL")
    bevel.width = 0.0025
    bevel.segments = 3
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    return collar


def add_graft_features(role: str, mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    spec = MPFB[role]
    scale = spec["scale"]
    source = spec["eye"]
    base = spec["target_center"] + (source - spec["source_center"]) * scale
    base.y += 0.004
    objects: list[bpy.types.Object] = []
    eye_radii = (0.0132, 0.0060, 0.0068) if role == "Police" else (0.0135, 0.0062, 0.0070)
    for side in (-1.0, 1.0):
        center = Vector((side * base.x, base.y, base.z))
        eye = kit.add_uv_sphere(f"{role}_v21_Eye_{side:+.0f}", center, eye_radii, mats["eye_white"], 56, 28)
        iris = kit.add_uv_sphere(
            f"{role}_v21_Iris_{side:+.0f}",
            (center.x, center.y - 0.0055, center.z),
            (0.0054, 0.0013, 0.0049),
            mats["iris"],
            44,
            22,
        )
        pupil = kit.add_uv_sphere(
            f"{role}_v21_Pupil_{side:+.0f}",
            (center.x, center.y - 0.0067, center.z),
            (0.0025, 0.0008, 0.0029),
            mats["pupil"],
            36,
            18,
        )
        glint = kit.add_uv_sphere(
            f"{role}_v21_Glint_{side:+.0f}",
            (center.x - 0.0020, center.y - 0.0075, center.z + 0.0024),
            (0.0013, 0.00045, 0.0015),
            mats["eye_white"],
            24,
            12,
        )
        if role == "Villain":
            brow_points = (
                (center.x + side * 0.016, center.y - 0.0035, center.z + 0.023),
                (center.x, center.y - 0.0045, center.z + 0.020),
                (center.x - side * 0.016, center.y - 0.0035, center.z + 0.016),
            )
        else:
            brow_points = (
                (center.x - 0.016, center.y - 0.0035, center.z + 0.020),
                (center.x, center.y - 0.0045, center.z + 0.022),
                (center.x + 0.016, center.y - 0.0035, center.z + 0.020),
            )
        brow = kit.add_curve(f"{role}_v21_Brow_{side:+.0f}", brow_points, 0.0018, mats["line"])
        objects.extend((eye, iris, pupil, glint, brow))
    return objects


def load_mpfb_head(role: str, mats: dict[str, bpy.types.Material]) -> list[bpy.types.Object]:
    spec = MPFB[role]
    prefix = spec["prefix"]
    body_name = f"{prefix}_SourceHuman_export"
    hair_name = f"{prefix}_SourceHuman.{spec['hair']}_export"
    eyebrow_name = f"{prefix}_SourceHuman.eyebrow001_export"
    lash_name = f"{prefix}_SourceHuman.eyelashes01_export"
    detail_names: list[str] = []
    requested = [body_name] + ([hair_name] if role == "Police" else []) + detail_names
    with bpy.data.libraries.load(str(spec["blend"]), link=False) as (available, loaded):
        missing = [name for name in requested if name not in available.objects]
        if missing:
            raise RuntimeError(f"Missing MPFB objects for {role}: {missing}")
        loaded.objects = requested
    objects = [obj for obj in loaded.objects if obj is not None]
    parent_objects = {obj.parent for obj in objects if obj.parent is not None}
    for parent in parent_objects:
        if parent.name not in bpy.context.scene.objects:
            bpy.context.collection.objects.link(parent)
    for obj in objects:
        bpy.context.collection.objects.link(obj)
        obj.hide_render = False
        obj.hide_set(False)
    bpy.context.view_layer.update()

    # MPFB facial parts use a mix of armature, parent scale, and object-space
    # offsets. Bake their evaluated world-space result before detaching them.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    baked_meshes: dict[bpy.types.Object, bpy.types.Mesh] = {}
    for obj in objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        baked = bpy.data.meshes.new_from_object(
            evaluated,
            preserve_all_data_layers=True,
            depsgraph=depsgraph,
        )
        baked.transform(evaluated.matrix_world)
        baked_meshes[obj] = baked
    for obj, baked in baked_meshes.items():
        obj.parent = None
        obj.data = baked
        obj.matrix_world = Matrix.Identity(4)
        for modifier in list(obj.modifiers):
            obj.modifiers.remove(modifier)
    for parent in parent_objects:
        bpy.data.objects.remove(parent, do_unlink=True)

    body = next(obj for obj in objects if obj.name == body_name)
    trim_head(body, spec["neck_cut"])
    body.name = f"{role}_v21_MPFB_HeadNeck"
    body.data.materials.clear()
    body.data.materials.append(mats["skin"])
    for polygon in body.data.polygons:
        polygon.use_smooth = True

    if role == "Police":
        hair = next(obj for obj in objects if obj.name == hair_name)
        hair.data.materials.clear()
        hair.data.materials.append(mats["hair"])

    for obj in objects:
        if "eyebrow" in obj.name.lower() or "eyelash" in obj.name.lower() or "Expression_Brow" in obj.name:
            obj.data.materials.clear()
            obj.data.materials.append(mats["line"])

    scale = spec["scale"]
    transform = (
        Matrix.Translation(spec["target_center"])
        @ Matrix.Scale(scale, 4)
        @ Matrix.Translation(-spec["source_center"])
    )
    for obj in objects:
        obj.matrix_world = transform @ obj.matrix_world
    if role == "Police":
        # Keep the neck root seated in the collar while progressively moving
        # the cranium rearward. A rigid translation buries the whole neck.
        inverse = body.matrix_world.inverted()
        for vertex in body.data.vertices:
            world = body.matrix_world @ vertex.co
            head_weight = v20.smoothstep(1.43, 1.58, world.z)
            world.y -= POLICE_HEAD_REARWARD_OFFSET * (1.0 - head_weight)
            vertex.co = inverse @ world
        body.data.update()

        # Lift the pointed lower hair mass into a readable nape line. The
        # center stays slightly lower than the sides, matching a short haircut
        # while exposing enough real neck skin for rear and three-quarter views.
        inverse = hair.matrix_world.inverted()
        for vertex in hair.data.vertices:
            world = hair.matrix_world @ vertex.co
            rear_weight = v20.smoothstep(0.055, 0.125, world.y)
            center_to_side = v20.smoothstep(0.020, 0.105, abs(world.x))
            target_hairline = 1.493 + 0.018 * center_to_side
            if world.z < target_hairline:
                world.z += (target_hairline - world.z) * 0.92 * rear_weight
            vertex.co = inverse @ world
        hair.data.update()
    return objects + add_graft_features(role, mats)


def hide_native_adult_head(body: bpy.types.Object, role: str) -> None:
    colors = body.data.color_attributes.get("BodyPalette")
    if not colors:
        return
    hidden = (0.0035, 0.0020, 0.0012, 1.0) if role == "Police" else (0.006, 0.005, 0.004, 1.0)
    for vertex in body.data.vertices:
        if 1.350 < vertex.co.z < 1.640 and abs(vertex.co.x) < 0.175 and vertex.co.y < -0.055:
            colors.data[vertex.index].color = hidden


def render_views(role: str, character: list[bpy.types.Object]) -> None:
    out = REVIEW_ROOT / role
    out.mkdir(parents=True, exist_ok=True)
    low, high = kit.bounds(character)
    center = 0.5 * (low + high)
    width, depth, height = high.x - low.x, high.y - low.y, high.z - low.z
    distance = height * 3.0
    positions = {
        "front": Vector((center.x, center.y - distance, center.z + 0.015)),
        "side": Vector((center.x + distance, center.y, center.z + 0.015)),
        "top": Vector((center.x, center.y, center.z + distance)),
        "back": Vector((center.x, center.y + distance, center.z + 0.015)),
    }
    for view in ("front", "side", "top", "back"):
        bpy.ops.object.camera_add(location=positions[view])
        camera = bpy.context.object
        kit.look_at(camera, center)
        camera.data.type = "ORTHO"
        camera.data.ortho_scale = max(height * 1.10, width * 1.35) if view != "top" else max(width, depth) * 1.34
        camera.data.lens = 72
        bpy.context.scene.camera = camera
        bpy.context.scene.render.resolution_x = 900
        bpy.context.scene.render.resolution_y = 1200 if view != "top" else 900
        bpy.context.scene.render.resolution_percentage = 100
        bpy.context.scene.render.filepath = str(out / f"{role}_v21_{view}.png")
        bpy.ops.render.render(write_still=True)
        bpy.data.objects.remove(camera, do_unlink=True)


def export(role: str, character: list[bpy.types.Object]) -> None:
    asset = ROOT / f"art-source/Characters/{role}/ReferenceStandard/PrecisionRemodel_2026_07_13_v21"
    asset.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(asset / f"{role}_PrecisionRemodel_v21.blend"))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in character:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = character[0]
    bpy.ops.export_scene.gltf(filepath=str(asset / f"{role}_PrecisionRemodel_v21.glb"), export_format="GLB", use_selection=True)
    bpy.ops.export_scene.fbx(
        filepath=str(asset / f"{role}_PrecisionRemodel_v21.fbx"),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        axis_forward="Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
    )


def build(role: str) -> None:
    kit.reset_scene()
    body = v20.import_role(role)
    refine_native_body(body, role)
    if role == "Kid":
        mats = kit.build_materials()
        v20.assign_vertex_palette(body, role)
        face_features = refine_kid_face(body, v20.add_kid_features(mats), mats)
        details = face_features + kit.add_backpack(mats) + kit.add_sock_stripes(mats) + kit.add_shoe_laces(mats)
    elif role == "Villain":
        mats = adults.villain_materials()
        v20.assign_vertex_palette(body, role)
        details = load_mpfb_head(role, mats)
    else:
        mats = adults.police_materials()
        v20.assign_vertex_palette(body, role)
        accessories = refine_police_accessories(v20.add_police_accessories(mats))
        details = (
            load_mpfb_head(role, mats)
            + [add_police_neck_blend(mats), add_police_uniform_collar(mats)]
            + accessories
        )
    details = kit.convert_curves(details)
    character = [body] + details
    kit.setup_studio()
    render_views(role, character)
    export(role, character)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("roles", nargs="*", choices=("Kid", "Villain", "Police"))
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(argv)
    for role in args.roles or ("Kid", "Villain", "Police"):
        build(role)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
