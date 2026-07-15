#!/usr/bin/env python3
"""Bind the approved static v3 character candidates to the shared humanoid rig.

This utility uses assimp/glTF as the deterministic local fallback when Blender
cannot complete the rigging path in the active execution environment:

1. assimp exports the static source FBX to glTF2.
2. The 21-joint Rig_Humanoid_Shared hierarchy is copied from the production
   rig FBX exactly once, scaled to the candidate mesh height, and added as one
   shared glTF skin referenced by every mesh node.
3. Per-vertex humanoid weights are generated from anatomical heuristics, with
   small accessory primitives rigid-bound to one suitable bone.
4. assimp exports the rigged glTF back to FBX and verifies it with assimp dump.

The script only writes new Rigged_2026_07_13 folders and reports.
"""

from __future__ import annotations

import argparse
import copy
from collections import Counter
import json
import math
import re
import shutil
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
SHARED_RIG = ROOT / "art-source" / "_Shared" / "Animations" / "Rig_Humanoid_Shared.fbx"
RIG_OUTPUT_DIR = "Rigged_2026_07_13"
ZERO_WEIGHT_WARNING_THRESHOLD_PERCENT = 2.0
REQUIRED_SKINNED_HAND_BONES = ["LeftHand", "RightHand"]

BONE_NAMES = [
    "Hips",
    "Spine",
    "Chest",
    "Neck",
    "Head",
    "LeftShoulder",
    "LeftUpperArm",
    "LeftLowerArm",
    "LeftHand",
    "RightShoulder",
    "RightUpperArm",
    "RightLowerArm",
    "RightHand",
    "LeftUpperLeg",
    "LeftLowerLeg",
    "LeftFoot",
    "LeftToes",
    "RightUpperLeg",
    "RightLowerLeg",
    "RightFoot",
    "RightToes",
]

ROLE_STYLE_SPECS = [
    {
        "role": "Kid",
        "style": "Stylized",
        "source": "art-source/Characters/Kid/Stylized/HunyuanHumanRework_2026_07_12_v3/Kid_Cartoon_HunyuanHuman_v3.fbx",
        "output_name": "Kid_Stylized_Rigged",
    },
    {
        "role": "Kid",
        "style": "Photoreal",
        "source": "art-source/Characters/Kid/Photoreal/HunyuanHumanRework_2026_07_12_v3/Kid_Photoreal_HunyuanHuman_v3.fbx",
        "output_name": "Kid_Photoreal_Rigged",
    },
    {
        "role": "Kid",
        "style": "BlindBox",
        "source": "art-source/Characters/Kid/BlindBox/HunyuanHumanRework_2026_07_12_v3/Kid_BlindBox_HunyuanHuman_v3.fbx",
        "output_name": "Kid_BlindBox_Rigged",
    },
    {
        "role": "Villain",
        "style": "Stylized",
        "source": "art-source/Characters/Villain/Stylized/CharacterRoleRework_2026_07_12_v3/Villain_Stylized_RoleHuman_v3.fbx",
        "output_name": "Villain_Stylized_Rigged",
    },
    {
        "role": "Villain",
        "style": "Photoreal",
        "source": "art-source/Characters/Villain/Photoreal/CharacterRoleRework_2026_07_12_v3/Villain_Photoreal_RoleHuman_v3.fbx",
        "output_name": "Villain_Photoreal_Rigged",
    },
    {
        "role": "Villain",
        "style": "BlindBox",
        "source": "art-source/Characters/Villain/BlindBox/CharacterRoleRework_2026_07_12_v3/Villain_BlindBox_RoleHuman_v3.fbx",
        "output_name": "Villain_BlindBox_Rigged",
    },
    {
        "role": "Police",
        "style": "Stylized",
        "source": "art-source/Characters/Police/Stylized/CharacterRoleRework_2026_07_12_v3/Police_Stylized_RoleHuman_v3.fbx",
        "output_name": "Police_Stylized_Rigged",
    },
    {
        "role": "Police",
        "style": "Photoreal",
        "source": "art-source/Characters/Police/Photoreal/CharacterRoleRework_2026_07_12_v3/Police_Photoreal_RoleHuman_v3.fbx",
        "output_name": "Police_Photoreal_Rigged",
    },
    {
        "role": "Police",
        "style": "BlindBox",
        "source": "art-source/Characters/Police/BlindBox/CharacterRoleRework_2026_07_12_v3/Police_BlindBox_RoleHuman_v3.fbx",
        "output_name": "Police_BlindBox_Rigged",
    },
]


@dataclass
class PrimitiveWeightSummary:
    node_name: str
    mesh_name: str
    material_name: str
    mode: str
    rigid_bone: str | None
    vertex_count: int
    zero_weight_vertices: int
    zero_weight_percentage: float
    min_total_weight: float
    assignment_counts: dict[str, int]
    nonzero_counts: dict[str, int]
    weight_sums: dict[str, float]


def run(cmd: list[str], *, cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "Command failed: "
            + " ".join(cmd)
            + "\nSTDOUT:\n"
            + proc.stdout
            + "\nSTDERR:\n"
            + proc.stderr
        )
    return proc


def rel(path: Path) -> str:
    return str(path.resolve().relative_to(ROOT))


def align4(data: bytearray) -> None:
    while len(data) % 4 != 0:
        data.append(0)


def matrix_to_np(matrix: list[float] | None) -> np.ndarray:
    if matrix is None:
        return np.identity(4, dtype=np.float64)
    return np.array(matrix, dtype=np.float64).reshape((4, 4), order="F")


def np_to_matrix(matrix: np.ndarray) -> list[float]:
    return [float(v) for v in matrix.reshape(16, order="F")]


def accessor_view(gltf: dict[str, Any], bin_data: bytes, accessor_index: int) -> tuple[int, int, int, int, int | None]:
    accessor = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    view_offset = view.get("byteOffset", 0)
    accessor_offset = accessor.get("byteOffset", 0)
    byte_offset = view_offset + accessor_offset
    stride = view.get("byteStride")
    count = accessor["count"]
    component_type = accessor["componentType"]
    accessor_type = accessor["type"]
    return byte_offset, count, component_type, component_count(accessor_type), stride


def component_count(accessor_type: str) -> int:
    return {
        "SCALAR": 1,
        "VEC2": 2,
        "VEC3": 3,
        "VEC4": 4,
        "MAT4": 16,
    }[accessor_type]


def read_positions(gltf: dict[str, Any], bin_data: bytes, accessor_index: int) -> list[tuple[float, float, float]]:
    byte_offset, count, component_type, comps, stride = accessor_view(gltf, bin_data, accessor_index)
    if component_type != 5126 or comps != 3:
        raise ValueError(f"POSITION accessor {accessor_index} is not FLOAT VEC3")
    stride = stride or 12
    positions: list[tuple[float, float, float]] = []
    for i in range(count):
        start = byte_offset + i * stride
        positions.append(struct.unpack_from("<fff", bin_data, start))
    return positions


def append_accessor(
    gltf: dict[str, Any],
    bin_blob: bytearray,
    payload: bytes,
    *,
    component_type: int,
    accessor_type: str,
    count: int,
    target: int | None = None,
    min_value: list[float] | list[int] | None = None,
    max_value: list[float] | list[int] | None = None,
) -> int:
    align4(bin_blob)
    offset = len(bin_blob)
    bin_blob.extend(payload)
    view: dict[str, Any] = {
        "buffer": 0,
        "byteOffset": offset,
        "byteLength": len(payload),
    }
    if target is not None:
        view["target"] = target
    view_index = len(gltf.setdefault("bufferViews", []))
    gltf["bufferViews"].append(view)
    accessor: dict[str, Any] = {
        "bufferView": view_index,
        "byteOffset": 0,
        "componentType": component_type,
        "count": count,
        "type": accessor_type,
    }
    if min_value is not None:
        accessor["min"] = min_value
    if max_value is not None:
        accessor["max"] = max_value
    accessor_index = len(gltf.setdefault("accessors", []))
    gltf["accessors"].append(accessor)
    return accessor_index


def descendants_by_name(gltf: dict[str, Any], root_index: int) -> dict[str, int]:
    nodes = gltf["nodes"]
    found: dict[str, int] = {}

    def walk(index: int) -> None:
        name = nodes[index].get("name", "")
        if name:
            found[name] = index
        for child in nodes[index].get("children", []):
            walk(child)

    walk(root_index)
    return found


def find_existing_skeleton(static_gltf: dict[str, Any]) -> tuple[int, list[int]] | None:
    for index, node in enumerate(static_gltf.get("nodes", [])):
        if node.get("name") != "Rig_Humanoid_Shared":
            continue
        by_name = descendants_by_name(static_gltf, index)
        if all(name in by_name for name in BONE_NAMES):
            return index, [by_name[name] for name in BONE_NAMES]
    return None


def collect_node_subtree(gltf: dict[str, Any], root_index: int) -> set[int]:
    nodes = gltf["nodes"]
    found: set[int] = set()

    def walk(index: int) -> None:
        if index in found:
            return
        found.add(index)
        for child in nodes[index].get("children", []):
            walk(child)

    walk(root_index)
    return found


def can_reuse_existing_skeleton(gltf: dict[str, Any], rig_root: int, joint_indices: list[int]) -> bool:
    """Only reuse existing skeletons when the rig root is a clean joint root.

    The CharacterRoleRework sources have the display meshes parented directly
    under Rig_Humanoid_Shared next to Hips. Unity's humanoid importer accepts
    the Kid route's pure Rig_Humanoid_Shared -> Hips hierarchy, so mixed
    mesh/joint roots are sanitized and replaced with a clean shared-rig copy.
    """
    nodes = gltf["nodes"]
    joint_set = set(joint_indices)
    direct_children = nodes[rig_root].get("children", [])
    return len(direct_children) == 1 and direct_children[0] in joint_set


def sanitize_mixed_existing_skeleton(
    static_gltf: dict[str, Any],
    rig_root: int,
    joint_indices: list[int],
) -> dict[str, Any]:
    nodes = static_gltf["nodes"]
    used_names = {node.get("name", "") for index, node in enumerate(nodes) if index != rig_root and node.get("name")}
    old_root_name = nodes[rig_root].get("name", "")
    new_root_name = unique_name("Source_MeshRoot", used_names)
    nodes[rig_root]["name"] = new_root_name

    joint_set = set(joint_indices)
    old_children = list(nodes[rig_root].get("children", []))
    removed_joint_roots = [child for child in old_children if child in joint_set]
    removed_joint_root_names = [nodes[child].get("name", "") for child in removed_joint_roots]
    retained_children = [child for child in old_children if child not in joint_set]
    nodes[rig_root]["children"] = retained_children

    removed_joint_subtree: set[int] = set()
    for child in removed_joint_roots:
        removed_joint_subtree.update(collect_node_subtree(static_gltf, child))

    for index in sorted(removed_joint_subtree):
        old_name = nodes[index].get("name", "")
        if not old_name:
            continue
        new_name = unique_name(f"SourceUnused_{old_name}", used_names)
        nodes[index]["name"] = new_name

    retained_mesh_children = [child for child in retained_children if "mesh" in nodes[child]]
    return {
        "sanitized_existing_mixed_mesh_joint_root": True,
        "old_root_name": old_root_name,
        "new_mesh_root_name": new_root_name,
        "retained_direct_mesh_child_count": len(retained_mesh_children),
        "removed_old_joint_root_names": removed_joint_root_names,
        "renamed_old_joint_count": len(removed_joint_subtree),
    }


def copy_and_scale_skeleton(
    static_gltf: dict[str, Any],
    rig_gltf: dict[str, Any],
    height: float,
) -> tuple[int, list[int], str, float | None, dict[str, Any] | None]:
    existing = find_existing_skeleton(static_gltf)
    if existing is not None:
        rig_root, joint_indices = existing
        if can_reuse_existing_skeleton(static_gltf, rig_root, joint_indices):
            return rig_root, joint_indices, "existing_static_source_transform_hierarchy", None, None
        skeleton_cleanup = sanitize_mixed_existing_skeleton(static_gltf, rig_root, joint_indices)
    else:
        skeleton_cleanup = None

    rig_nodes = rig_gltf["nodes"]
    source_by_name = {node.get("name", ""): i for i, node in enumerate(rig_nodes)}
    missing = [name for name in ["Rig_Humanoid_Shared", *BONE_NAMES] if name not in source_by_name]
    if missing:
        raise RuntimeError("Shared rig glTF is missing nodes: " + ", ".join(missing))

    scale = height / 1.82
    old_to_new: dict[int, int] = {}
    nodes = static_gltf.setdefault("nodes", [])

    def clone_node(old_index: int) -> int:
        old = rig_nodes[old_index]
        new_index = len(nodes)
        old_to_new[old_index] = new_index
        new_node: dict[str, Any] = {"name": old.get("name", "")}
        if "matrix" in old:
            matrix = list(old["matrix"])
            if old.get("name") in BONE_NAMES:
                matrix[12] *= scale
                matrix[13] *= scale
                matrix[14] *= scale
            new_node["matrix"] = matrix
        if "translation" in old:
            translation = list(old["translation"])
            if old.get("name") in BONE_NAMES:
                translation = [v * scale for v in translation]
            new_node["translation"] = translation
        if "rotation" in old:
            new_node["rotation"] = list(old["rotation"])
        if "scale" in old:
            new_node["scale"] = list(old["scale"])
        if "extras" in old:
            new_node["extras"] = dict(old["extras"])
        nodes.append(new_node)
        children = []
        for child in old.get("children", []):
            children.append(clone_node(child))
        if children:
            new_node["children"] = children
        return new_index

    rig_root = clone_node(source_by_name["Rig_Humanoid_Shared"])
    root_node = static_gltf["scenes"][static_gltf.get("scene", 0)]["nodes"][0]
    root_children = nodes[root_node].setdefault("children", [])
    root_children.append(rig_root)
    joint_indices = [old_to_new[source_by_name[name]] for name in BONE_NAMES]
    joint_source = "appended_from_shared_rig_fbx"
    if skeleton_cleanup is not None:
        joint_source = "appended_from_shared_rig_fbx_after_sanitizing_existing_source_skeleton"
    return rig_root, joint_indices, joint_source, scale, skeleton_cleanup


def compute_global_matrices(gltf: dict[str, Any]) -> dict[int, np.ndarray]:
    nodes = gltf["nodes"]
    scene_roots = gltf["scenes"][gltf.get("scene", 0)]["nodes"]
    globals_by_index: dict[int, np.ndarray] = {}

    def walk(index: int, parent: np.ndarray) -> None:
        local = matrix_to_np(nodes[index].get("matrix"))
        globals_by_index[index] = parent @ local
        for child in nodes[index].get("children", []):
            walk(child, globals_by_index[index])

    for root_index in scene_roots:
        walk(root_index, np.identity(4, dtype=np.float64))
    return globals_by_index


def add_inverse_bind_accessor(
    gltf: dict[str, Any],
    bin_blob: bytearray,
    joint_indices: list[int],
    globals_by_index: dict[int, np.ndarray],
    mesh_bind_global: np.ndarray,
) -> tuple[int, float]:
    matrices = []
    maximum_residual = 0.0
    for joint_index in joint_indices:
        # glTF skinning is evaluated in mesh-node space. At bind pose,
        # inverse(meshGlobal) * jointGlobal * inverseBind must be identity.
        inverse_bind = np.linalg.inv(globals_by_index[joint_index]) @ mesh_bind_global
        residual = np.linalg.inv(mesh_bind_global) @ globals_by_index[joint_index] @ inverse_bind
        maximum_residual = max(maximum_residual, float(np.max(np.abs(residual - np.identity(4)))))
        matrices.append(inverse_bind.astype(np.float32))
    payload = b"".join(struct.pack("<16f", *matrix.reshape(16, order="F")) for matrix in matrices)
    accessor = append_accessor(
        gltf,
        bin_blob,
        payload,
        component_type=5126,
        accessor_type="MAT4",
        count=len(joint_indices),
    )
    return accessor, maximum_residual


def add_mesh_relative_skins(
    gltf: dict[str, Any],
    bin_blob: bytearray,
    joint_indices: list[int],
) -> tuple[dict[int, int], dict[str, Any]]:
    globals_by_index = compute_global_matrices(gltf)
    mesh_nodes = [index for index, node in enumerate(gltf.get("nodes", [])) if "mesh" in node]
    if not mesh_nodes:
        raise RuntimeError("Cannot build a skin without mesh nodes")

    skin_by_mesh_node: dict[int, int] = {}
    skin_by_matrix: dict[tuple[float, ...], int] = {}
    maximum_residual = 0.0
    for node_index in mesh_nodes:
        mesh_bind_global = globals_by_index[node_index]
        matrix_key = tuple(float(value) for value in np.round(mesh_bind_global.reshape(16), decimals=7))
        skin_index = skin_by_matrix.get(matrix_key)
        if skin_index is None:
            inverse_accessor, residual = add_inverse_bind_accessor(
                gltf,
                bin_blob,
                joint_indices,
                globals_by_index,
                mesh_bind_global,
            )
            maximum_residual = max(maximum_residual, residual)
            skin_index = len(gltf.setdefault("skins", []))
            gltf["skins"].append(
                {
                    "name": f"Rig_Humanoid_Shared_Skin_{len(skin_by_matrix):02d}",
                    "skeleton": joint_indices[0],
                    "joints": joint_indices,
                    "inverseBindMatrices": inverse_accessor,
                }
            )
            skin_by_matrix[matrix_key] = skin_index
        skin_by_mesh_node[node_index] = skin_index
        gltf["nodes"][node_index]["skin"] = skin_index

    diagnostics = {
        "formula": "inverse(jointGlobal) * meshGlobal",
        "mesh_node_count": len(mesh_nodes),
        "unique_mesh_bind_transform_count": len(skin_by_matrix),
        "shared_scene_skeleton_count": 1,
        "maximum_bind_pose_identity_residual": maximum_residual,
        "bind_pose_identity_residual_passed": maximum_residual <= 1e-5,
    }
    if not diagnostics["bind_pose_identity_residual_passed"]:
        raise RuntimeError(f"Inverse-bind residual is too large: {maximum_residual}")
    return skin_by_mesh_node, diagnostics


def material_name(gltf: dict[str, Any], material_index: int | None) -> str:
    if material_index is None:
        return ""
    materials = gltf.get("materials", [])
    if 0 <= material_index < len(materials):
        return materials[material_index].get("name", "")
    return ""


def safe_name_part(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("_")
    return cleaned or fallback


def unique_name(base: str, used: set[str]) -> str:
    candidate = base
    suffix = 1
    while candidate in used:
        suffix += 1
        candidate = f"{base}_{suffix}"
    used.add(candidate)
    return candidate


def primitive_name_for(gltf: dict[str, Any], base_name: str, primitive: dict[str, Any], primitive_index: int) -> str:
    mat_name = material_name(gltf, primitive.get("material"))
    if mat_name.startswith(base_name + "_"):
        suffix = mat_name[len(base_name) + 1 :]
    else:
        suffix = mat_name or f"primitive_{primitive_index}"
    return f"{base_name}_{safe_name_part(suffix, f'primitive_{primitive_index}')}"


def mesh_node_parent_lists(gltf: dict[str, Any]) -> dict[int, list[list[int]]]:
    parents: dict[int, list[list[int]]] = {}
    for scene in gltf.get("scenes", []):
        roots = scene.setdefault("nodes", [])
        for node_index in roots:
            parents.setdefault(node_index, []).append(roots)
    for node in gltf.get("nodes", []):
        children = node.get("children", [])
        for child_index in children:
            parents.setdefault(child_index, []).append(children)
    return parents


def split_multi_primitive_mesh_nodes(gltf: dict[str, Any]) -> list[dict[str, Any]]:
    """Split glTF multi-primitive nodes before FBX export.

    Assimp's FBX exporter can serialize several primitives on one node as one
    combined FBX mesh while keeping per-primitive skin indices local. Unity then
    sees later material sections as unweighted. Single-primitive mesh nodes keep
    the FBX cluster index spaces aligned.
    """
    nodes = gltf.setdefault("nodes", [])
    meshes = gltf.setdefault("meshes", [])
    parent_lists = mesh_node_parent_lists(gltf)
    mesh_ref_counts = Counter(node.get("mesh") for node in nodes if "mesh" in node)
    used_node_names = {node.get("name", "") for node in nodes if node.get("name")}
    used_mesh_names = {mesh.get("name", "") for mesh in meshes if mesh.get("name")}
    summaries: list[dict[str, Any]] = []

    for node_index in range(len(nodes)):
        node = nodes[node_index]
        mesh_index = node.get("mesh")
        if mesh_index is None or not (0 <= mesh_index < len(meshes)):
            continue
        mesh = meshes[mesh_index]
        primitives = mesh.get("primitives", [])
        if len(primitives) <= 1:
            continue

        base_name = safe_name_part(node.get("name") or mesh.get("name") or f"mesh_{mesh_index}", f"mesh_{mesh_index}")
        new_mesh_indices: list[int] = []
        new_node_indices: list[int] = []

        for primitive_index, primitive in enumerate(primitives):
            split_name = primitive_name_for(gltf, base_name, primitive, primitive_index)
            mesh_name = unique_name(split_name, used_mesh_names)
            split_mesh = {
                key: copy.deepcopy(value)
                for key, value in mesh.items()
                if key not in {"name", "primitives"}
            }
            split_mesh["name"] = mesh_name
            split_mesh["primitives"] = [copy.deepcopy(primitive)]

            if primitive_index == 0 and mesh_ref_counts[mesh_index] == 1:
                meshes[mesh_index] = split_mesh
                split_mesh_index = mesh_index
            else:
                split_mesh_index = len(meshes)
                meshes.append(split_mesh)
            new_mesh_indices.append(split_mesh_index)

            if primitive_index == 0:
                node["mesh"] = split_mesh_index
                node["name"] = unique_name(split_name, used_node_names)
                new_node_indices.append(node_index)
                continue

            split_node = {
                key: copy.deepcopy(value)
                for key, value in node.items()
                if key not in {"children", "mesh", "name"}
            }
            split_node["name"] = unique_name(split_name, used_node_names)
            split_node["mesh"] = split_mesh_index
            split_node_index = len(nodes)
            nodes.append(split_node)
            new_node_indices.append(split_node_index)
            for parent_list in parent_lists.get(node_index, []):
                parent_list.append(split_node_index)

        summaries.append(
            {
                "original_node_index": node_index,
                "original_mesh_index": mesh_index,
                "original_primitive_count": len(primitives),
                "split_node_indices": new_node_indices,
                "split_mesh_indices": new_mesh_indices,
            }
        )

    return summaries


def node_center_hint(node: dict[str, Any], positions: list[tuple[float, float, float]]) -> tuple[float, float, float]:
    if not positions:
        return (0.0, 0.0, 0.0)
    local = np.array(
        [
            sum(p[0] for p in positions) / len(positions),
            sum(p[1] for p in positions) / len(positions),
            sum(p[2] for p in positions) / len(positions),
            1.0,
        ],
        dtype=np.float64,
    )
    matrix = matrix_to_np(node.get("matrix"))
    transformed = matrix @ local
    return (float(transformed[0] / 100.0), float(transformed[1] / 100.0), float(transformed[2] / 100.0))


def side_from_name_or_center(name: str, center: tuple[float, float, float]) -> str:
    if re.search(r"(^|[_\- ])L($|[_\- ])|Left", name, re.IGNORECASE):
        return "Left"
    if re.search(r"(^|[_\- ])R($|[_\- ])|Right", name, re.IGNORECASE):
        return "Right"
    return "Left" if center[0] < 0.0 else "Right"


def rigid_bone_for(name: str, center: tuple[float, float, float], z_ratio: float) -> str:
    lower = name.lower()
    side = side_from_name_or_center(name, center)
    if any(token in lower for token in ["servicecap", "capbadge", "capband", "capbrim", "capcrown"]):
        return "Head"
    if "shoulder" in lower or "epaulette" in lower:
        return side + "Shoulder"
    if "forearm" in lower:
        return side + "LowerArm"
    if "upper" in lower and ("sleeve" in lower or "arm" in lower):
        return side + "UpperArm"
    if "hand" in lower:
        return side + "Hand"
    if any(token in lower for token in ["shoe", "boot", "sole", "toe", "lace"]):
        return side + "Foot"
    if any(token in lower for token in ["belt", "buckle", "pouch", "clip"]):
        return "Hips"
    if any(token in lower for token in ["button", "badge", "nameplate", "pocket", "placket", "radio", "collar", "zipper", "seam", "cord"]):
        return "Chest" if z_ratio > 0.55 else "Spine"
    if any(token in lower for token in ["eye", "pupil", "cheek", "brow", "smile", "nose", "ear", "hair", "head", "face", "chin"]):
        return "Head"
    if "hem" in lower:
        return "Hips" if z_ratio < 0.52 else "Spine"
    if z_ratio > 0.82:
        return "Head"
    if z_ratio > 0.62:
        return "Chest"
    if z_ratio > 0.46:
        return "Spine"
    if z_ratio > 0.30:
        return side + "UpperLeg"
    if z_ratio > 0.12:
        return side + "LowerLeg"
    return side + "Foot"


def should_rigid_bind(node_name: str, mesh_name: str, mat_name: str, vertex_count: int) -> bool:
    lower = f"{node_name} {mesh_name} {mat_name}".lower()
    rigid_tokens = [
        "curve",
        "eye",
        "pupil",
        "cheek",
        "brow",
        "smile",
        "nose",
        "ear",
        "badge",
        "belt",
        "buckle",
        "clip",
        "pouch",
        "radio",
        "button",
        "nameplate",
        "pocket",
        "patch",
        "epaulette",
        "cuff",
        "sole",
        "toe",
        "lace",
        "hem",
        "cord",
        "capband",
        "capbrim",
        "capcrown",
        "hair",
        "hairtuft",
        "zipper",
        "seam",
    ]
    if any(token in lower for token in rigid_tokens):
        return True
    return vertex_count <= 320


def normalize_weights(weights: list[tuple[str, float]]) -> list[tuple[str, float]]:
    accum: dict[str, float] = {}
    for bone, weight in weights:
        if weight <= 0.0:
            continue
        accum[bone] = accum.get(bone, 0.0) + weight
    if not accum:
        return [("Hips", 1.0)]
    total = sum(accum.values())
    ranked = sorted(((bone, value / total) for bone, value in accum.items()), key=lambda item: item[1], reverse=True)[:4]
    total = sum(weight for _, weight in ranked)
    return [(bone, weight / total) for bone, weight in ranked]


def blend_pair(first: str, second: str, t: float) -> list[tuple[str, float]]:
    t = max(0.0, min(1.0, t))
    return normalize_weights([(first, 1.0 - t), (second, t)])


def auto_weights_for_position(
    position: tuple[float, float, float],
    *,
    min_x: float,
    max_x: float,
    min_z: float,
    height: float,
    allow_arm: bool = True,
) -> list[tuple[str, float]]:
    x, _, z_raw = position
    z = (z_raw - min_z) / max(height, 1e-5)
    center_x = (min_x + max_x) * 0.5
    x_from_center = x - center_x
    abs_x = abs(x_from_center)
    side = "Left" if x_from_center < 0.0 else "Right"
    # Arms in the approved v21 meshes hang close to the torso. A height-based
    # 15% cutoff splits the inner hand and cuff across torso/arm bones, which
    # tears those surfaces in motion. Use the actual character width instead.
    shoulder_threshold = max(0.10 * height, (max_x - min_x) * 0.30)
    leg_threshold = max(0.035 * height, (max_x - min_x) * 0.08)
    max_abs_x = max(abs(min_x - center_x), abs(max_x - center_x))
    distal_arm_t = (abs_x - shoulder_threshold) / max(max_abs_x - shoulder_threshold, 1e-5)
    distal_arm_t = max(0.0, min(1.0, distal_arm_t))

    if allow_arm and 0.34 <= z <= 0.82 and abs_x > shoulder_threshold:
        if z > 0.62:
            lower_arm_t = max(0.0, min(1.0, (0.72 - z) / 0.10))
            hand_t = max(0.0, min(1.0, (0.72 - z) / 0.14))
            hand_t *= 1.60 * (0.40 + 0.60 * distal_arm_t)
            return normalize_weights(
                [
                    (side + "UpperArm", 1.0 - lower_arm_t),
                    (side + "LowerArm", lower_arm_t),
                    (side + "Hand", hand_t),
                ]
            )
        if z > 0.46:
            hand_t = max(0.0, min(1.0, (0.62 - z) / 0.16))
            hand_t *= 0.55 + 0.45 * distal_arm_t
            return blend_pair(side + "LowerArm", side + "Hand", hand_t)
        return [(side + "Hand", 1.0)]

    if z < 0.50 and abs_x > leg_threshold:
        if z < 0.105:
            return blend_pair(side + "Foot", side + "LowerLeg", z / 0.105 * 0.25)
        if z < 0.31:
            return blend_pair(side + "LowerLeg", side + "UpperLeg", (z - 0.24) / 0.12)
        return blend_pair(side + "UpperLeg", "Hips", (z - 0.42) / 0.10)

    if z > 0.86:
        return [( "Head", 1.0 )]
    if z > 0.78:
        return blend_pair("Neck", "Head", (z - 0.78) / 0.08)
    if z > 0.68:
        return blend_pair("Chest", "Neck", (z - 0.68) / 0.10)
    if z > 0.54:
        return blend_pair("Spine", "Chest", (z - 0.54) / 0.14)
    if z > 0.42:
        return blend_pair("Hips", "Spine", (z - 0.42) / 0.12)
    if z > 0.28:
        return blend_pair("Hips", side + "UpperLeg", (0.42 - z) / 0.14 * 0.35)
    if z > 0.13:
        return [(side + "LowerLeg", 1.0)]
    return [(side + "Foot", 1.0)]


def pack_joint_weight_arrays(
    weights_per_vertex: list[list[tuple[str, float]]],
    bone_to_joint: dict[str, int],
) -> tuple[bytes, bytes, dict[str, int], dict[str, int], dict[str, float], int, float]:
    joint_payload = bytearray()
    weight_payload = bytearray()
    assignment_counts: dict[str, int] = {}
    nonzero_counts: dict[str, int] = {}
    weight_sums: dict[str, float] = {}
    zero_weight_vertices = 0
    min_total_weight = math.inf
    for weights in weights_per_vertex:
        normalized = normalize_weights(weights)
        total_weight = sum(weight for _, weight in normalized)
        min_total_weight = min(min_total_weight, total_weight)
        if total_weight <= 1e-6:
            zero_weight_vertices += 1
        padded = normalized + [("Hips", 0.0)] * (4 - len(normalized))
        for bone, _ in padded[:4]:
            joint_payload.extend(struct.pack("<H", bone_to_joint[bone]))
        for _, weight in padded[:4]:
            weight_payload.extend(struct.pack("<f", float(weight)))
        dominant = normalized[0][0]
        assignment_counts[dominant] = assignment_counts.get(dominant, 0) + 1
        for bone, weight in normalized:
            if weight <= 1e-8:
                continue
            nonzero_counts[bone] = nonzero_counts.get(bone, 0) + 1
            weight_sums[bone] = weight_sums.get(bone, 0.0) + weight
    if math.isinf(min_total_weight):
        min_total_weight = 0.0
    return (
        bytes(joint_payload),
        bytes(weight_payload),
        assignment_counts,
        nonzero_counts,
        weight_sums,
        zero_weight_vertices,
        min_total_weight,
    )


def all_position_bounds(gltf: dict[str, Any], bin_data: bytes) -> dict[str, float]:
    min_x = min_y = min_z = math.inf
    max_x = max_y = max_z = -math.inf
    total_vertices = 0
    for mesh in gltf.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor_index = primitive.get("attributes", {}).get("POSITION")
            if accessor_index is None:
                continue
            for x, y, z in read_positions(gltf, bin_data, accessor_index):
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                min_z = min(min_z, z)
                max_x = max(max_x, x)
                max_y = max(max_y, y)
                max_z = max(max_z, z)
                total_vertices += 1
    return {
        "min_x": min_x,
        "max_x": max_x,
        "min_y": min_y,
        "max_y": max_y,
        "min_z": min_z,
        "max_z": max_z,
        "height": max_z - min_z,
        "width": max_x - min_x,
        "depth": max_y - min_y,
        "vertices": total_vertices,
    }


def add_skin_weights(
    gltf: dict[str, Any],
    bin_blob: bytearray,
    bin_data: bytes,
    joint_indices: list[int],
    skin_by_mesh_node: dict[int, int],
    bounds: dict[str, float],
) -> list[PrimitiveWeightSummary]:
    bone_to_joint = {bone: i for i, bone in enumerate(BONE_NAMES)}
    mesh_node_indices = {node.get("mesh"): i for i, node in enumerate(gltf.get("nodes", [])) if "mesh" in node}
    summaries: list[PrimitiveWeightSummary] = []

    for mesh_index, mesh in enumerate(gltf.get("meshes", [])):
        node_index = mesh_node_indices.get(mesh_index)
        node = gltf["nodes"][node_index] if node_index is not None else {}
        if node_index is not None:
            gltf["nodes"][node_index]["skin"] = skin_by_mesh_node[node_index]
        for primitive_index, primitive in enumerate(mesh.get("primitives", [])):
            attrs = primitive.setdefault("attributes", {})
            position_accessor = attrs.get("POSITION")
            if position_accessor is None:
                continue
            positions = read_positions(gltf, bin_data, position_accessor)
            mesh_name = mesh.get("name", "")
            node_name = node.get("name", "")
            mat_name = material_name(gltf, primitive.get("material"))
            label = " ".join(part for part in [node_name, mesh_name, mat_name, f"primitive_{primitive_index}"] if part)
            center = node_center_hint(node, positions)
            center_z_ratio = (sum(p[2] for p in positions) / len(positions) - bounds["min_z"]) / max(bounds["height"], 1e-5)
            rigid = should_rigid_bind(node_name, mesh_name, mat_name, len(positions))
            if rigid:
                bone = rigid_bone_for(label, center, center_z_ratio)
                weights_per_vertex = [[(bone, 1.0)] for _ in positions]
                mode = "rigid_single_bone"
                rigid_bone = bone
            else:
                weights_per_vertex = [
                    auto_weights_for_position(
                        pos,
                        min_x=bounds["min_x"],
                        max_x=bounds["max_x"],
                        min_z=bounds["min_z"],
                        height=bounds["height"],
                    )
                    for pos in positions
                ]
                mode = "heuristic_humanoid_blend"
                rigid_bone = None

            (
                joint_payload,
                weight_payload,
                assignment_counts,
                nonzero_counts,
                weight_sums,
                zero_weight_vertices,
                min_total_weight,
            ) = pack_joint_weight_arrays(weights_per_vertex, bone_to_joint)
            zero_weight_percentage = zero_weight_vertices / max(len(positions), 1) * 100.0
            joint_accessor = append_accessor(
                gltf,
                bin_blob,
                joint_payload,
                component_type=5123,
                accessor_type="VEC4",
                count=len(positions),
                target=34962,
                min_value=[0, 0, 0, 0],
                max_value=[len(joint_indices) - 1] * 4,
            )
            weight_accessor = append_accessor(
                gltf,
                bin_blob,
                weight_payload,
                component_type=5126,
                accessor_type="VEC4",
                count=len(positions),
                target=34962,
                min_value=[0.0, 0.0, 0.0, 0.0],
                max_value=[1.0, 1.0, 1.0, 1.0],
            )
            attrs["JOINTS_0"] = joint_accessor
            attrs["WEIGHTS_0"] = weight_accessor
            summaries.append(
                PrimitiveWeightSummary(
                    node_name=node_name,
                    mesh_name=mesh_name,
                    material_name=mat_name,
                    mode=mode,
                    rigid_bone=rigid_bone,
                    vertex_count=len(positions),
                    zero_weight_vertices=zero_weight_vertices,
                    zero_weight_percentage=zero_weight_percentage,
                    min_total_weight=min_total_weight,
                    assignment_counts=assignment_counts,
                    nonzero_counts=nonzero_counts,
                    weight_sums=weight_sums,
                )
            )
    return summaries


def count_names_in_assimp_dump(dump_path: Path) -> tuple[Counter[str], Counter[str], Counter[str]]:
    node_counts: Counter[str] = Counter()
    mesh_bone_reference_counts: Counter[str] = Counter()
    all_name_attribute_counts: Counter[str] = Counter()
    for _, elem in ET.iterparse(dump_path, events=("end",)):
        name = elem.attrib.get("name")
        if name:
            all_name_attribute_counts[name] += 1
            if elem.tag == "Node":
                node_counts[name] += 1
            elif elem.tag == "Bone":
                mesh_bone_reference_counts[name] += 1
        elem.clear()
    return node_counts, mesh_bone_reference_counts, all_name_attribute_counts


def parse_int_list(text: str | None) -> list[int]:
    if not text:
        return []
    values: list[int] = []
    for part in text.split():
        try:
            values.append(int(part))
        except ValueError:
            continue
    return values


def analyze_assimp_skin_weight_coverage(dump_path: Path) -> dict[str, Any]:
    root = ET.parse(dump_path).getroot()
    mesh_coverages: list[dict[str, Any]] = []

    for mesh_index, mesh in enumerate(root.iter("Mesh")):
        positions = mesh.find("Positions")
        vertex_count = int(positions.attrib.get("num", 0)) if positions is not None else 0
        weighted_indices: set[int] = set()
        total_weight_entries = 0
        for weight in mesh.iter("Weight"):
            try:
                value = float((weight.text or "0").strip())
            except ValueError:
                value = 0.0
            if abs(value) <= 1e-8:
                continue
            index = weight.attrib.get("index")
            if index is None:
                continue
            try:
                vertex_index = int(index)
            except ValueError:
                continue
            total_weight_entries += 1
            if 0 <= vertex_index < vertex_count:
                weighted_indices.add(vertex_index)

        unweighted_vertices = max(vertex_count - len(weighted_indices), 0)
        unweighted_percentage = unweighted_vertices / max(vertex_count, 1) * 100.0
        mesh_coverages.append(
            {
                "mesh_index": mesh_index,
                "vertex_count": vertex_count,
                "weighted_vertex_count": len(weighted_indices),
                "unweighted_vertex_count": unweighted_vertices,
                "unweighted_vertex_percentage": unweighted_percentage,
                "weight_entry_count": total_weight_entries,
            }
        )

    node_groups: list[dict[str, Any]] = []
    for node in root.iter("Node"):
        mesh_refs = node.find("MeshRefs")
        refs = [index for index in parse_int_list(mesh_refs.text if mesh_refs is not None else None) if 0 <= index < len(mesh_coverages)]
        if not refs:
            continue
        vertex_count = sum(mesh_coverages[index]["vertex_count"] for index in refs)
        unweighted_vertices = sum(mesh_coverages[index]["unweighted_vertex_count"] for index in refs)
        node_groups.append(
            {
                "node": node.attrib.get("name", ""),
                "mesh_refs": refs,
                "vertex_count": vertex_count,
                "unweighted_vertex_count": unweighted_vertices,
                "unweighted_vertex_percentage": unweighted_vertices / max(vertex_count, 1) * 100.0,
            }
        )

    total_vertices = sum(item["vertex_count"] for item in mesh_coverages)
    total_unweighted = sum(item["unweighted_vertex_count"] for item in mesh_coverages)
    mesh_failures = [
        item
        for item in mesh_coverages
        if item["vertex_count"] > 0 and item["unweighted_vertex_percentage"] > ZERO_WEIGHT_WARNING_THRESHOLD_PERCENT
    ]
    node_group_failures = [
        item
        for item in node_groups
        if item["vertex_count"] > 0 and item["unweighted_vertex_percentage"] > ZERO_WEIGHT_WARNING_THRESHOLD_PERCENT
    ]

    return {
        "threshold_percent": ZERO_WEIGHT_WARNING_THRESHOLD_PERCENT,
        "passed": not mesh_failures and not node_group_failures,
        "vertex_count": total_vertices,
        "unweighted_vertex_count": total_unweighted,
        "unweighted_vertex_percentage": total_unweighted / max(total_vertices, 1) * 100.0,
        "mesh_coverages": mesh_coverages,
        "mesh_failures": mesh_failures,
        "node_meshref_group_coverages": node_groups,
        "node_meshref_group_failures": node_group_failures,
    }


def verify_assimp(fbx_path: Path) -> dict[str, Any]:
    info_proc = run(["assimp", "info", str(fbx_path)])
    stdout = info_proc.stdout
    bones_match = re.search(r"Bones:\s+(\d+)", stdout)
    mesh_match = re.search(r"Meshes:\s+(\d+)", stdout)
    vertex_match = re.search(r"Vertices:\s+(\d+)", stdout)
    with tempfile.TemporaryDirectory(prefix="assimp_dump_verify_") as tmp_name:
        dump_path = Path(tmp_name) / "model.assxml"
        run(["assimp", "dump", str(fbx_path), str(dump_path)])
        node_counts, mesh_bone_reference_counts, all_name_attribute_counts = count_names_in_assimp_dump(dump_path)
        skin_weight_coverage = analyze_assimp_skin_weight_coverage(dump_path)
    required_node_counts = {bone: int(node_counts[bone]) for bone in BONE_NAMES}
    mesh_reference_counts = {bone: int(mesh_bone_reference_counts[bone]) for bone in BONE_NAMES}
    all_dump_name_counts = {bone: int(all_name_attribute_counts[bone]) for bone in BONE_NAMES}
    node_count_failures = {bone: count for bone, count in required_node_counts.items() if count != 1}
    return {
        "passed": not node_count_failures and skin_weight_coverage["passed"],
        "bones_total_reported_by_assimp": int(bones_match.group(1)) if bones_match else 0,
        "bones_total_note": "Assimp's Bones total is the sum of per-mesh Bone reference tables, not the count of scene skeleton nodes.",
        "meshes": int(mesh_match.group(1)) if mesh_match else 0,
        "vertices": int(vertex_match.group(1)) if vertex_match else 0,
        "required_bone_node_occurrence_counts_from_assimp_dump": required_node_counts,
        "required_bone_node_count_failures": node_count_failures,
        "required_bone_node_counts_exactly_once": not node_count_failures,
        "required_bone_mesh_reference_counts_from_assimp_dump": mesh_reference_counts,
        "required_bone_all_name_attribute_counts_from_assimp_dump": all_dump_name_counts,
        "skin_weight_coverage_from_assimp_dump": skin_weight_coverage,
        "stdout_excerpt": "\n".join(stdout.splitlines()[:90]),
    }


def export_static_gltf(source: Path, out_gltf: Path) -> None:
    run(["assimp", "export", str(source), str(out_gltf), "-fgltf2"])


def export_shared_rig_gltf(out_gltf: Path) -> None:
    run(["assimp", "export", str(SHARED_RIG), str(out_gltf), "-fgltf2"])


def convert_gltf_to_fbx(gltf_path: Path, fbx_path: Path) -> None:
    run(["assimp", "export", str(gltf_path), str(fbx_path), "-ffbx"])


def report_note(summaries: list[PrimitiveWeightSummary]) -> str:
    rigid = sum(1 for item in summaries if item.mode == "rigid_single_bone")
    blended = sum(1 for item in summaries if item.mode == "heuristic_humanoid_blend")
    return (
        f"{blended} mesh primitives received humanoid blended weights from vertex position; "
        f"{rigid} small/accessory primitives were rigid-bound to a single best-fit bone. "
        "Blender automatic weights were not used in this run because Blender 5.1.2 exited "
        "during Metal backend startup before Python execution in the active Codex sandbox."
    )


def process_spec(spec: dict[str, str], rig_gltf: dict[str, Any], only_validate: bool = False) -> dict[str, Any]:
    source = ROOT / spec["source"]
    if not source.is_file():
        raise FileNotFoundError(source)
    out_dir = source.parents[1] / RIG_OUTPUT_DIR
    reports_dir = out_dir / "Reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)
    out_fbx = out_dir / f"{spec['output_name']}.fbx"
    report_path = reports_dir / f"{spec['output_name']}_report.json"

    with tempfile.TemporaryDirectory(prefix=f"rig_{spec['role']}_{spec['style']}_") as tmp_name:
        tmp = Path(tmp_name)
        static_gltf_path = tmp / "static.gltf"
        rigged_gltf_path = tmp / "rigged.gltf"
        export_static_gltf(source, static_gltf_path)
        gltf = json.loads(static_gltf_path.read_text(encoding="utf-8"))
        bin_path = static_gltf_path.with_suffix(".bin")
        bin_data = bin_path.read_bytes() if bin_path.is_file() else b""
        bin_blob = bytearray(bin_data)
        split_summaries = split_multi_primitive_mesh_nodes(gltf)
        bounds = all_position_bounds(gltf, bin_data)
        rig_root, joint_indices, joint_source, appended_scale, skeleton_cleanup = copy_and_scale_skeleton(
            gltf,
            rig_gltf,
            bounds["height"],
        )
        skin_by_mesh_node, inverse_bind_diagnostics = add_mesh_relative_skins(
            gltf,
            bin_blob,
            joint_indices,
        )
        summaries = add_skin_weights(gltf, bin_blob, bin_data, joint_indices, skin_by_mesh_node, bounds)
        gltf["buffers"][0]["byteLength"] = len(bin_blob)
        gltf["buffers"][0]["uri"] = "rigged.bin"
        rigged_gltf_path.write_text(json.dumps(gltf, indent=2), encoding="utf-8")
        rigged_gltf_path.with_suffix(".bin").write_bytes(bin_blob)
        if only_validate:
            out_intermediate = out_dir / f"{spec['output_name']}.gltf"
            out_bin = out_dir / f"{spec['output_name']}.bin"
            intermediate_gltf = copy.deepcopy(gltf)
            intermediate_gltf["buffers"][0]["uri"] = out_bin.name
            out_intermediate.write_text(json.dumps(intermediate_gltf, indent=2), encoding="utf-8")
            shutil.copy2(rigged_gltf_path.with_suffix(".bin"), out_bin)
        convert_gltf_to_fbx(rigged_gltf_path, out_fbx)

    verification = verify_assimp(out_fbx)
    dominant_counts: dict[str, int] = {}
    nonzero_counts: dict[str, int] = {}
    weight_sums: dict[str, float] = {}
    for summary in summaries:
        for bone, count in summary.assignment_counts.items():
            dominant_counts[bone] = dominant_counts.get(bone, 0) + count
        for bone, count in summary.nonzero_counts.items():
            nonzero_counts[bone] = nonzero_counts.get(bone, 0) + count
        for bone, weight_sum in summary.weight_sums.items():
            weight_sums[bone] = weight_sums.get(bone, 0.0) + weight_sum
    total_weighted_vertices_checked = sum(summary.vertex_count for summary in summaries)
    total_zero_weight_vertices = sum(summary.zero_weight_vertices for summary in summaries)
    zero_weight_primitive_failures = [
        {
            "node": summary.node_name,
            "mesh": summary.mesh_name,
            "material": summary.material_name,
            "vertex_count": summary.vertex_count,
            "zero_weight_vertices": summary.zero_weight_vertices,
            "zero_weight_percentage": summary.zero_weight_percentage,
        }
        for summary in summaries
        if summary.zero_weight_percentage > ZERO_WEIGHT_WARNING_THRESHOLD_PERCENT
    ]
    required_hand_influence_failures = {
        bone: int(nonzero_counts.get(bone, 0))
        for bone in REQUIRED_SKINNED_HAND_BONES
        if nonzero_counts.get(bone, 0) <= 0
    }
    report = {
        "asset": spec["output_name"],
        "role": spec["role"],
        "style": spec["style"],
        "source_fbx": spec["source"],
        "output_fbx": rel(out_fbx),
        "shared_rig_source": rel(SHARED_RIG),
        "date": "2026-07-13",
        "pipeline": "assimp_gltf_skin_fallback_shared_single_scene_skeleton",
        "path_used": "fallback",
        "mesh_bounds_from_gltf_positions_meters": {
            "height": bounds["height"],
            "width": bounds["width"],
            "depth": bounds["depth"],
            "min": [bounds["min_x"], bounds["min_y"], bounds["min_z"]],
            "max": [bounds["max_x"], bounds["max_y"], bounds["max_z"]],
        },
        "mesh_preparation": {
            "multi_primitive_nodes_split_for_unity_fbx_skinning": len(split_summaries),
            "split_summaries": split_summaries,
        },
        "rig": {
            "armature_name": "Rig_Humanoid_Shared",
            "bone_count": len(BONE_NAMES),
            "bone_names": BONE_NAMES,
            "same_names_and_hierarchy_as_shared_rig": True,
            "joint_source": joint_source,
            "joint_scale_from_mesh_height": appended_scale,
            "source_skeleton_cleanup": skeleton_cleanup,
            "rig_root_node_index_in_intermediate_gltf": rig_root,
            "single_shared_scene_skeleton_required": True,
            "inverse_bind_matrices": inverse_bind_diagnostics,
        },
        "weighting": {
            "quality_note": report_note(summaries),
            "zero_weight_warning_threshold_percent": ZERO_WEIGHT_WARNING_THRESHOLD_PERCENT,
            "generated_gltf_weight_vectors_checked": True,
            "generated_gltf_vertex_count": total_weighted_vertices_checked,
            "generated_gltf_zero_weight_vertex_count": total_zero_weight_vertices,
            "generated_gltf_zero_weight_vertex_percentage": total_zero_weight_vertices
            / max(total_weighted_vertices_checked, 1)
            * 100.0,
            "generated_gltf_zero_weight_primitive_failures": zero_weight_primitive_failures,
            "primitive_count": len(summaries),
            "heuristic_blended_primitive_count": sum(1 for item in summaries if item.mode == "heuristic_humanoid_blend"),
            "rigid_single_bone_primitive_count": sum(1 for item in summaries if item.mode == "rigid_single_bone"),
            "dominant_bone_vertex_distribution": dict(sorted(dominant_counts.items())),
            "nonzero_bone_vertex_distribution": dict(sorted(nonzero_counts.items())),
            "bone_weight_sums": {bone: weight_sums[bone] for bone in sorted(weight_sums)},
            "required_hand_influence_failures": required_hand_influence_failures,
            "primitive_summaries": [
                {
                    "node": item.node_name,
                    "mesh": item.mesh_name,
                    "material": item.material_name,
                    "mode": item.mode,
                    "rigid_bone": item.rigid_bone,
                    "vertex_count": item.vertex_count,
                    "zero_weight_vertices": item.zero_weight_vertices,
                    "zero_weight_percentage": item.zero_weight_percentage,
                    "min_total_weight": item.min_total_weight,
                    "dominant_bone_counts": dict(sorted(item.assignment_counts.items())),
                    "nonzero_bone_counts": dict(sorted(item.nonzero_counts.items())),
                    "bone_weight_sums": {bone: item.weight_sums[bone] for bone in sorted(item.weight_sums)},
                }
                for item in summaries
            ],
        },
        "assimp_verification": verification,
        "validation_summary": {
            "fbx_written": out_fbx.is_file(),
            "bones_present": verification["bones_total_reported_by_assimp"] > 0,
            "all_required_bone_node_names_exactly_once": verification["required_bone_node_counts_exactly_once"],
            "generated_gltf_zero_weight_vertices_under_threshold": not zero_weight_primitive_failures,
            "generated_gltf_required_hand_influences_present": not required_hand_influence_failures,
            "fbx_unweighted_vertices_under_threshold": verification["skin_weight_coverage_from_assimp_dump"]["passed"],
            "unity_humanoid_avatar": "pending CharacterRigSetup Unity batchmode/menu validation",
        },
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    if zero_weight_primitive_failures:
        raise RuntimeError(f"{out_fbx} failed generated glTF zero-weight check: {zero_weight_primitive_failures}")
    if required_hand_influence_failures:
        raise RuntimeError(f"{out_fbx} failed required hand influence check: {required_hand_influence_failures}")
    if not verification["required_bone_node_counts_exactly_once"]:
        failures = verification["required_bone_node_count_failures"]
        raise RuntimeError(f"{out_fbx} failed required joint node count check: {failures}")
    if not verification["skin_weight_coverage_from_assimp_dump"]["passed"]:
        failures = verification["skin_weight_coverage_from_assimp_dump"]["mesh_failures"]
        raise RuntimeError(f"{out_fbx} failed FBX skin weight coverage check: {failures}")
    return report


def load_rig_gltf(tmp: Path) -> dict[str, Any]:
    rig_gltf_path = tmp / "shared_rig.gltf"
    export_shared_rig_gltf(rig_gltf_path)
    return json.loads(rig_gltf_path.read_text(encoding="utf-8"))


def selected_specs(only: str | None) -> list[dict[str, str]]:
    if not only:
        return ROLE_STYLE_SPECS
    requested = {item.strip().lower() for item in only.split(",") if item.strip()}
    selected = []
    for spec in ROLE_STYLE_SPECS:
        key = f"{spec['role']}:{spec['style']}".lower()
        if key in requested:
            selected.append(spec)
    if not selected:
        raise ValueError(f"No specs matched --only {only!r}; use Role:Style, comma-separated.")
    return selected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="Comma-separated Role:Style list, e.g. Kid:Stylized")
    parser.add_argument("--keep-intermediate", action="store_true", help="Copy rigged intermediate glTF/bin next to the output FBX.")
    args = parser.parse_args()

    if not shutil.which("assimp"):
        raise RuntimeError("assimp command is required")
    with tempfile.TemporaryDirectory(prefix="rig_shared_") as tmp_name:
        rig_gltf = load_rig_gltf(Path(tmp_name))
        reports = [process_spec(spec, rig_gltf, only_validate=args.keep_intermediate) for spec in selected_specs(args.only)]
    print(json.dumps({"processed": [report["output_fbx"] for report in reports]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
