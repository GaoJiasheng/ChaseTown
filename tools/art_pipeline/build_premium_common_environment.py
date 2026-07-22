"""Build the premium shared environment library used by the web game.

This is the reproducible source-of-truth pipeline for the non-theme-specific
props.  It deliberately keeps texture images shared between GLBs so a richer
silhouette does not multiply the download cost.  The generated Blender master
is retained as source art while the compact runtime GLBs replace the prototype
exports in ``public/models/environment``.

Run from the repository root:

    blender --background --python tools/art_pipeline/build_premium_common_environment.py
"""

from __future__ import annotations

from pathlib import Path
import importlib.util
import json
import math
import random
import shutil
import struct
import subprocess
import tempfile

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "public" / "models" / "environment"
TEXTURES = ROOT / "public" / "models" / "SharedTextures"
SOURCE_DIR = ROOT / "art-source" / "Environment" / "Premium"
MASTER_BLEND = SOURCE_DIR / "Chasing_Premium_Common_Environment.blend"
REPORT = ROOT / "docs" / "art_production" / "PREMIUM_COMMON_ENVIRONMENT_REPORT.json"
GLTFPACK = ROOT / "node_modules" / ".bin" / "gltfpack"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


H = load_module(
    "chasing_environment_modular",
    ROOT / "tools" / "art_pipeline" / "generate_environment_modular_rework.py",
)
P = load_module(
    "chasing_environment_props",
    ROOT / "tools" / "art_pipeline" / "generate_environment_props_rework.py",
)

# The old Unity-era sources were pruned intentionally.  Runtime textures are
# now canonical and are shared by every compact GLB.
H.TEXTURES = TEXTURES
P.H.TEXTURES = TEXTURES


CORE_ASSETS = {
    "Door_FrontGate": "front-gate.glb",
    "Door_Classroom": "classroom-door.glb",
    "Door_RearExit": "exit.glb",
    "Light_Ceiling_Emissive": "ceiling-light.glb",
}

PROP_ASSETS = {
    "Prop_BulletinBoard": "bulletin.glb",
    "Prop_FireExtinguisher": "extinguisher.glb",
    "Prop_TrashBin": "trash.glb",
    "Prop_DeskChair_Set": "desk-chair.glb",
    "Prop_Blackboard": "blackboard.glb",
    "Prop_TeacherPodium": "podium.glb",
    "Prop_ScatteredBooks": "books.glb",
    "Prop_DroppedBackpack": "backpack.glb",
    "Prop_Bench": "bench.glb",
    "Prop_Tree_Set": "tree.glb",
    "Prop_Shrub_Set": "shrub.glb",
    "Prop_BasketballHoop": "basketball.glb",
    "Prop_PoliceCar": "police-car.glb",
    "Prop_PoliceStationFacade": "station.glb",
}


def activate(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def premium_finish(obj, material, bevel=0.015):
    """Production bevel/normal pass with readable highlights at game scale."""
    obj.data.materials.clear()
    obj.data.materials.append(material)
    H.assign_uv(obj)
    if bevel:
        modifier = obj.modifiers.new("Premium_Radius", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
        modifier.limit_method = "ANGLE"
        modifier.angle_limit = math.radians(26)
        try:
            modifier.harden_normals = True
        except Exception:
            pass
    activate(obj)
    for modifier in list(obj.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        except Exception:
            pass
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.select_set(False)
    return obj


# All legacy builder helpers resolve ``finish`` dynamically from their module.
H.finish = premium_finish
P.H.finish = premium_finish


def delete_objects(objects: list[bpy.types.Object]) -> None:
    for obj in list(objects):
        if obj and obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    objects.clear()


def custom_mesh(
    name: str,
    vertices: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    material,
    bevel: float = 0.0,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return premium_finish(obj, material, bevel)


def irregular_ico(name, loc, radius, material, seed, subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=radius, location=loc)
    obj = bpy.context.object
    obj.name = name
    rng = random.Random(seed)
    for vertex in obj.data.vertices:
        normal = vertex.co.normalized()
        vertical = 0.92 + 0.18 * max(normal.z, 0.0)
        jitter = 0.82 + rng.random() * 0.28
        vertex.co.x *= jitter
        vertex.co.y *= 0.88 + rng.random() * 0.24
        vertex.co.z *= vertical * (0.90 + rng.random() * 0.18)
    return premium_finish(obj, material, 0.018)


def create_book(
    objects,
    mats,
    name,
    loc,
    size=(0.18, 0.25, 0.035),
    color="blue_metal",
    rotation=0.0,
):
    x, y, z = loc
    sx, sy, sz = size
    page = H.cube(name + "_PageBlock", (x, y, z + sz * 0.46), (sx * 0.47, sy * 0.47, sz * 0.40), mats["paper"], 0.006)
    cover_bottom = H.cube(name + "_CoverBottom", (x, y, z + sz * 0.06), (sx * 0.52, sy * 0.52, sz * 0.07), mats[color], 0.004)
    cover_top = H.cube(name + "_CoverTop", (x, y, z + sz * 0.91), (sx * 0.52, sy * 0.52, sz * 0.07), mats[color], 0.004)
    spine = H.cyl(
        name + "_RoundedSpine",
        (x - sx * 0.51, y, z + sz * 0.49),
        sz * 0.43,
        sy * 1.02,
        mats[color],
        vertices=20,
        bevel=0.002,
        rotation=(math.radians(90), 0, 0),
    )
    label = H.cube(name + "_SpineLabel", (x - sx * 0.545, y - sy * 0.10, z + sz * 0.53), (0.006, sy * 0.23, sz * 0.19), mats["paper"], 0.001)
    for obj in (page, cover_bottom, cover_top, spine, label):
        obj.rotation_euler[2] = rotation
        objects.append(obj)


def create_open_book(objects, mats, loc, scale=1.0, rotation=0.0):
    x0, y0, z0 = loc
    all_pages = []
    for page_index, side in enumerate((-1, 1)):
        cols, rows = 8, 5
        vertices = []
        faces = []
        for row in range(rows):
            v = row / (rows - 1)
            for col in range(cols):
                u = col / (cols - 1)
                x = side * (0.012 + u * 0.205) * scale
                y = (v - 0.5) * 0.31 * scale
                arch = (0.027 * (1.0 - u) + 0.010 * math.sin(u * math.pi)) * scale
                flutter = math.sin(v * math.pi * 2.0 + page_index) * 0.0025 * u * scale
                vertices.append((x, y, arch + flutter))
        for row in range(rows - 1):
            for col in range(cols - 1):
                a = row * cols + col
                faces.append((a, a + 1, a + cols + 1, a + cols))
        page = custom_mesh(f"OpenBook_Page_{page_index}", vertices, faces, mats["paper"])
        solidify = page.modifiers.new("Paper_Thickness", "SOLIDIFY")
        solidify.thickness = 0.0022 * scale
        activate(page)
        bpy.ops.object.modifier_apply(modifier=solidify.name)
        page.location = (x0, y0, z0)
        page.rotation_euler[2] = rotation
        all_pages.append(page)
    cover = H.cube("OpenBook_Cover", (x0, y0, z0 - 0.003), (0.225 * scale, 0.165 * scale, 0.004 * scale), mats["red_metal"], 0.004)
    cover.rotation_euler[2] = rotation
    spine = H.cyl(
        "OpenBook_Spine",
        (x0, y0, z0 + 0.006 * scale),
        0.012 * scale,
        0.33 * scale,
        mats["red_metal"],
        vertices=24,
        bevel=0.002,
        rotation=(math.radians(90), 0, 0),
    )
    spine.rotation_euler[2] = rotation
    objects.extend(all_pages + [cover, spine])


def rebuild_books(objects, mats):
    delete_objects(objects)
    palette = ["blue_metal", "red_metal", "wood_trim", "blue_metal", "red_metal"]
    stacks = [
        ((-0.48, -0.06), 3, -12),
        ((0.52, 0.11), 4, 9),
    ]
    for stack_index, ((x, y), count, angle) in enumerate(stacks):
        height = 0.0
        for index in range(count):
            thickness = 0.038 + 0.008 * ((index + stack_index) % 2)
            create_book(
                objects,
                mats,
                f"BookStack_{stack_index}_{index}",
                (x + (index % 2) * 0.012, y, height),
                size=(0.19 + 0.025 * (index % 2), 0.27 - 0.018 * index, thickness),
                color=palette[(index + stack_index) % len(palette)],
                rotation=math.radians(angle + index * 3),
            )
            height += thickness + 0.006
    create_book(objects, mats, "Dropped_Notebook", (0.05, -0.24, 0.0), (0.17, 0.23, 0.028), "wood_trim", math.radians(-24))
    create_open_book(objects, mats, (0.03, 0.17, 0.022), 0.95, math.radians(7))
    # Binder rings and two page markers make the silhouette legible from above.
    for y in (-0.085, 0.0, 0.085):
        ring = P.torus("Binder_Ring", (0.05, -0.24 + y, 0.040), 0.014, 0.003, mats["metal"], rotation=(math.radians(90), 0, 0))
        ring.rotation_euler[2] = math.radians(-24)
        objects.append(ring)
    objects.append(H.cube("Fabric_Bookmark", (0.105, 0.17, 0.062), (0.010, 0.13, 0.0025), mats["red_metal"], 0.001))
    return ["Paper", "BluePaintedMetal", "RedPaintedMetal", "WoodTrim", "WornMetal"]


def enrich_desk(objects, mats):
    # Bent tubular frame, fasteners, laminated edge and everyday story props.
    for x in (-0.34, 0.34):
        objects.append(P.tube_low(f"Desk_BentFrame_{x}", [(x, -0.24, 0.67), (x, -0.24, 0.10), (x, 0.24, 0.10), (x, 0.24, 0.67)], 0.017, mats["metal"]))
        for y in (-0.24, 0.24):
            objects.append(H.cyl("Desk_FrameFoot", (x, y, 0.035), 0.027, 0.030, mats["rubber_black"], vertices=24, bevel=0.004))
    for x in (-0.36, 0.36):
        for y in (-0.255, 0.255):
            objects.append(H.cyl("Desk_CountersunkFastener", (x, y, 0.768), 0.008, 0.006, mats["metal"], vertices=20, bevel=0.001))
    # A real pencil and exercise book keep the desk from reading as a display prop.
    pencil = H.cyl("Desk_Pencil", (-0.12, -0.04, 0.773), 0.006, 0.29, mats["red_metal"], vertices=12, bevel=0.001, rotation=(0, math.radians(90), 0))
    pencil.rotation_euler[2] = math.radians(8)
    objects.append(pencil)
    create_book(objects, mats, "Desk_ExerciseBook", (0.14, 0.02, 0.772), (0.15, 0.21, 0.026), "blue_metal", math.radians(-6))
    # Sculpted back shell: tapered sides avoid the previous rounded-box look.
    verts = [(-0.22, 0, -0.24), (0.22, 0, -0.24), (0.19, -0.018, 0.24), (-0.19, -0.018, 0.24),
             (-0.20, 0.035, -0.22), (0.20, 0.035, -0.22), (0.17, 0.015, 0.22), (-0.17, 0.015, 0.22)]
    faces = [(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    shell = custom_mesh("Chair_MoldedBackShell", verts, faces, mats["wood_trim"], 0.018)
    shell.location = (0.70, 0.205, 0.70)
    objects.append(shell)


def enrich_bench(objects, mats):
    for x in (-0.74, 0.74):
        objects.append(P.tube_low("Bench_CastScroll", [(x, -0.42, 0.10), (x, -0.48, 0.34), (x, -0.36, 0.56), (x, -0.15, 0.61), (x, 0.04, 0.72)], 0.024, mats["metal"]))
        objects.append(H.cube("Bench_AnchorPlate", (x, -0.24, 0.025), (0.09, 0.15, 0.025), mats["metal"], 0.012))
        for y in (-0.32, -0.16):
            objects.append(H.cyl("Bench_AnchorBolt", (x, y, 0.060), 0.012, 0.014, mats["metal"], vertices=12, bevel=0.002))
    for x in (-0.72, 0.0, 0.72):
        for z in (0.47, 0.59, 0.71):
            objects.append(H.cyl("Bench_SlatBolt", (x, -0.030, z), 0.008, 0.012, mats["metal"], vertices=20, bevel=0.001, rotation=(math.radians(90), 0, 0)))


def enrich_backpack(objects, mats):
    # Piping seams and padded back channels break the soft bag away from a box.
    for side in (-1, 1):
        objects.append(P.tube_low("Backpack_PipedSeam", [(side * 0.25, -0.15, 0.09), (side * 0.28, -0.16, 0.25), (side * 0.20, -0.12, 0.43)], 0.007, mats["metal"]))
    for x in (-0.09, 0.09):
        objects.append(H.cube("Backpack_BackPad", (x, 0.185, 0.25), (0.055, 0.018, 0.15), mats["rubber_black"], 0.018))
    for i in range(8):
        x = -0.14 + i * 0.04
        objects.append(H.cube("Backpack_ZipperTooth", (x, -0.214, 0.268 + math.sin(i * 0.8) * 0.006), (0.007, 0.004, 0.006), mats["metal"], 0.001))


def rebuild_tree(objects, mats):
    delete_objects(objects)
    random.seed(1337)
    for tree_index, (x0, y0, height, scale) in enumerate(((-0.48, 0.03, 1.35, 1.0), (0.52, -0.05, 1.10, 0.82))):
        # Slightly tapered trunk made from stacked frustums rather than a cylinder.
        for segment in range(4):
            z = 0.15 + segment * height * 0.19
            radius = (0.090 - segment * 0.012) * scale
            trunk = H.cyl(f"Tree{tree_index}_Trunk{segment}", (x0, y0, z), radius, height * 0.38, mats["wood_trim"], vertices=14, bevel=0.008)
            trunk.rotation_euler[1] = math.radians((segment - 1.5) * 1.8)
            objects.append(trunk)
        branch_points = [
            ((x0, y0, height * 0.53), (x0 - 0.24 * scale, y0 - 0.05, height * 0.82)),
            ((x0, y0, height * 0.62), (x0 + 0.25 * scale, y0 + 0.03, height * 0.92)),
            ((x0, y0, height * 0.68), (x0 + 0.05, y0 + 0.20 * scale, height * 1.02)),
        ]
        for branch_index, (start, end) in enumerate(branch_points):
            objects.append(P.tube_low(f"Tree{tree_index}_Branch{branch_index}", [start, end], 0.032 * scale, mats["wood_trim"]))
        crown_centers = [
            (x0, y0, height * 1.02, 0.34),
            (x0 - 0.26 * scale, y0 - 0.02, height * 0.89, 0.27),
            (x0 + 0.25 * scale, y0 + 0.02, height * 0.92, 0.29),
            (x0 + 0.02, y0 + 0.22 * scale, height * 0.91, 0.25),
            (x0 - 0.08, y0 - 0.18 * scale, height * 1.13, 0.24),
        ]
        for crown_index, (x, y, z, r) in enumerate(crown_centers):
            objects.append(irregular_ico(f"Tree{tree_index}_LeafMass{crown_index}", (x, y, z), r * scale, mats["grass"], 500 + tree_index * 20 + crown_index, 2))
        # Root flare and leaf litter visibly ground the tree.
        for angle in range(0, 360, 60):
            a = math.radians(angle)
            objects.append(P.tube_low("Tree_RootFlare", [(x0, y0, 0.10), (x0 + math.cos(a) * 0.20 * scale, y0 + math.sin(a) * 0.20 * scale, 0.015)], 0.018 * scale, mats["wood_trim"]))
    return ["WoodTrim", "Grass"]


def rebuild_shrub(objects, mats):
    delete_objects(objects)
    for i in range(13):
        angle = i * 2.39996
        radius = 0.09 + 0.045 * (i % 4)
        x = math.cos(angle) * radius * 2.2
        y = math.sin(angle) * radius
        z = 0.17 + 0.035 * (i % 3)
        objects.append(irregular_ico(f"Shrub_LeafMass_{i}", (x, y, z), 0.15 + 0.015 * (i % 4), mats["grass"], 800 + i, 2))
    objects.append(H.cube("Shrub_Planter", (0, 0, 0.055), (0.74, 0.25, 0.055), mats["wood_trim"], 0.025))
    objects.append(H.cube("Shrub_Soil", (0, 0, 0.116), (0.68, 0.21, 0.012), mats["rubber_black"], 0.010))
    return ["Grass", "WoodTrim", "RubberBlack"]


def enrich_police_car(objects, mats):
    for x in (-0.30, -0.15, 0.0, 0.15, 0.30):
        objects.append(H.cube("Police_GrilleSlat", (x, -0.512, 0.34), (0.016, 0.009, 0.064), mats["rubber_black"], 0.002))
    for side in (-1, 1):
        objects.append(H.cyl("Police_SpotLamp", (side * 0.45, -0.25, 0.63), 0.045, 0.038, mats["metal"], vertices=28, bevel=0.004, rotation=(math.radians(90), 0, 0)))
        objects.append(H.cube("Police_DoorHandle", (side * 0.47, -0.05, 0.48), (0.010, 0.055, 0.012), mats["metal"], 0.004))
    objects.append(H.cube("Police_LicensePlate", (0, -0.555, 0.22), (0.13, 0.009, 0.035), mats["paper"], 0.004))


def enhance_prop(name, objects, mats, material_names):
    if name == "Prop_ScatteredBooks":
        return rebuild_books(objects, mats)
    if name == "Prop_Tree_Set":
        return rebuild_tree(objects, mats)
    if name == "Prop_Shrub_Set":
        return rebuild_shrub(objects, mats)
    if name == "Prop_DeskChair_Set":
        enrich_desk(objects, mats)
        return material_names + ["Paper", "BluePaintedMetal", "RedPaintedMetal"]
    if name == "Prop_Bench":
        enrich_bench(objects, mats)
    elif name == "Prop_DroppedBackpack":
        enrich_backpack(objects, mats)
    elif name == "Prop_PoliceCar":
        enrich_police_car(objects, mats)
    return material_names


def set_texture_paths() -> None:
    for image in bpy.data.images:
        if image.source != "FILE":
            continue
        filename = Path(bpy.path.abspath(image.filepath)).name
        if (TEXTURES / filename).is_file():
            image.filepath = str(TEXTURES / filename)


def export_fbx(path: Path, objects: list[bpy.types.Object]) -> None:
    set_texture_paths()
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.fbx(
        filepath=str(path),
        use_selection=True,
        object_types={"MESH"},
        apply_unit_scale=True,
        bake_space_transform=False,
        axis_forward="Z",
        axis_up="Y",
        path_mode="RELATIVE",
        embed_textures=False,
    )


def read_glb(path: Path):
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError(f"Not a GLB: {path}")
    offset = 12
    chunks = []
    while offset < len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        chunks.append((kind, data[offset : offset + length]))
        offset += length
    document = json.loads(chunks[0][1].rstrip(b" \x00").decode("utf-8"))
    return document, chunks[1:]


def rewrite_glb(path: Path, document: dict, chunks) -> None:
    payload = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    payload += b" " * ((4 - len(payload) % 4) % 4)
    body = struct.pack("<II", len(payload), 0x4E4F534A) + payload
    for kind, chunk in chunks:
        padded = chunk + b"\x00" * ((4 - len(chunk) % 4) % 4)
        body += struct.pack("<II", len(padded), kind) + padded
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)


def normalize_texture_uris(path: Path) -> dict:
    document, chunks = read_glb(path)
    for image in document.get("images", []):
        uri = image.get("uri")
        if uri:
            image["uri"] = "../SharedTextures/" + Path(uri.replace("\\", "/")).name
    # Assimp can bake Blender's emission strength into emissiveFactor.  Core
    # glTF requires every factor channel to stay in [0, 1] unless the explicit
    # emissive-strength extension is declared, so keep shared props portable.
    for material in document.get("materials", []):
        if "emissiveFactor" in material:
            material["emissiveFactor"] = [min(1.0, max(0.0, float(channel))) for channel in material["emissiveFactor"]]
    rewrite_glb(path, document, chunks)
    mesh_triangles = []
    for mesh in document.get("meshes", []):
        mesh_triangles.append(sum(
            document.get("accessors", [])[primitive["indices"]].get("count", 0) // 3
            for primitive in mesh.get("primitives", [])
        ))
    unique_triangles = sum(mesh_triangles)

    def rendered_subtree_triangles(node_index: int) -> int:
        node = document.get("nodes", [])[node_index]
        own = mesh_triangles[node["mesh"]] if "mesh" in node else 0
        return own + sum(rendered_subtree_triangles(child) for child in node.get("children", []))

    active_scene = document.get("scenes", [])[document.get("scene", 0)]
    triangles = sum(rendered_subtree_triangles(root) for root in active_scene.get("nodes", []))
    return {
        "bytes": path.stat().st_size,
        "nodes": len(document.get("nodes", [])),
        "meshes": len(document.get("meshes", [])),
        "materials": len(document.get("materials", [])),
        "images": len(document.get("images", [])),
        "triangles": triangles,
        "uniqueTriangles": unique_triangles,
    }


def optimize_runtime_glb(path: Path) -> None:
    """Generate explicit tangents and losslessly Meshopt-compress geometry.

    Shared images remain external, named nodes/materials and extras remain
    stable, and ``-noq`` preserves authored floating-point vertex attributes.
    """
    if not GLTFPACK.is_file():
        raise RuntimeError("Pinned gltfpack is missing; run npm install before building environment art")
    optimized = path.with_name(f".{path.stem}.meshopt.tmp.glb")
    optimized.unlink(missing_ok=True)
    try:
        subprocess.run(
            [
                str(GLTFPACK), "-i", str(path), "-o", str(optimized),
                "-c", "-gt", "-kn", "-km", "-ke", "-tr", "-noq",
            ],
            check=True,
        )
        optimized.replace(path)
    finally:
        optimized.unlink(missing_ok=True)


def convert_runtime(fbx: Path, glb: Path) -> dict:
    glb.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["assimp", "export", str(fbx), str(glb), "-fglb2"], check=True, stdout=subprocess.DEVNULL)
    normalize_texture_uris(glb)
    optimize_runtime_glb(glb)
    return normalize_texture_uris(glb)


def build_runtime_assets(temp_dir: Path) -> list[dict]:
    results = []
    for source_name, runtime_name in CORE_ASSETS.items():
        H.reset_scene()
        H.TEXTURES = TEXTURES
        mats = H.materials()
        objects = H.build_asset(source_name, mats)
        fbx = temp_dir / f"{source_name}.fbx"
        export_fbx(fbx, objects)
        stats = convert_runtime(fbx, RUNTIME / runtime_name)
        results.append({"source": source_name, "runtime": runtime_name, **stats})
        print(f"PREMIUM_ASSET={runtime_name} TRIANGLES={stats['triangles']} BYTES={stats['bytes']}")

    for source_name, runtime_name in PROP_ASSETS.items():
        H.reset_scene()
        P.H.TEXTURES = TEXTURES
        mats = P.H.materials()
        objects, material_names, _lod = P.build(source_name, mats)
        material_names = enhance_prop(source_name, objects, mats, material_names)
        fbx = temp_dir / f"{source_name}.fbx"
        export_fbx(fbx, objects)
        stats = convert_runtime(fbx, RUNTIME / runtime_name)
        results.append({"source": source_name, "runtime": runtime_name, "semanticMaterials": sorted(set(material_names)), **stats})
        print(f"PREMIUM_ASSET={runtime_name} TRIANGLES={stats['triangles']} BYTES={stats['bytes']}")
    return results


def build_master(temp_dir: Path) -> None:
    H.reset_scene()
    all_sources = list(CORE_ASSETS) + list(PROP_ASSETS)
    for index, source_name in enumerate(all_sources):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.fbx(filepath=str(temp_dir / f"{source_name}.fbx"), use_custom_normals=True)
        imported = [obj for obj in bpy.data.objects if obj not in before]
        collection = bpy.data.collections.new(source_name)
        bpy.context.scene.collection.children.link(collection)
        x = (index % 6) * 4.0
        y = (index // 6) * 4.0
        for obj in imported:
            for existing in list(obj.users_collection):
                existing.objects.unlink(obj)
            collection.objects.link(obj)
            obj.location += Vector((x, y, 0.0))
        collection["sourceAsset"] = source_name
        collection["runtimeAsset"] = (CORE_ASSETS | PROP_ASSETS)[source_name]
        collection["qualityTier"] = "premium_web_environment_v2"
    set_texture_paths()
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    bpy.context.scene["pipeline"] = "build_premium_common_environment.py"
    bpy.context.scene["units"] = "meters"
    bpy.context.scene["artDirection"] = "stylized_realism_readable_from_gameplay_camera"
    # This master is generated deterministically; Blender's numbered backup
    # duplicates megabytes of source art without adding recovery value.
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(MASTER_BLEND), compress=True)


def prune_unreferenced_shared_textures() -> list[str]:
    """Keep the runtime texture directory equal to the shipped GLB URI set."""
    referenced = set()
    for glb in (ROOT / "public" / "models").rglob("*.glb"):
        document, _chunks = read_glb(glb)
        for image in document.get("images", []):
            uri = str(image.get("uri", "")).replace("\\", "/")
            if "SharedTextures/" in uri:
                referenced.add(Path(uri).name)

    removed = []
    for texture in TEXTURES.glob("*"):
        if texture.is_file() and texture.name not in referenced:
            texture.unlink()
            removed.append(texture.name)
    return sorted(removed)


def main() -> int:
    if not shutil.which("assimp"):
        raise RuntimeError("assimp is required to build compact shared-texture GLBs")
    with tempfile.TemporaryDirectory(prefix="chasing-premium-environment-") as temp:
        temp_dir = Path(temp)
        results = build_runtime_assets(temp_dir)
        build_master(temp_dir)
    removed_textures = prune_unreferenced_shared_textures()
    if removed_textures:
        print(f"PRUNED_UNUSED_TEXTURES={','.join(removed_textures)}")
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "pipeline": "premium_common_environment_v2",
        "sourceMaster": str(MASTER_BLEND.relative_to(ROOT)),
        "sharedTextureDirectory": str(TEXTURES.relative_to(ROOT)),
        "assetCount": len(results),
        "totalRuntimeBytes": sum(item["bytes"] for item in results),
        "totalTriangles": sum(item["triangles"] for item in results),
        "assets": results,
    }
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
