import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTER_DIRECTORY = path.join(ROOT, "public", "models", "characters");
const RUNTIME_MANIFEST = path.join(ROOT, "dist", "client", "runtime-asset-manifest.json");
const ANIMATION_REPORT = path.join(
  ROOT,
  "art-source",
  "_Shared",
  "Animations",
  "Reports",
  "villain_web_animation_set.json",
);
const RUNTIME_KTX2_REPORT = path.join(
  ROOT,
  "docs",
  "art_production",
  "reports",
  "runtime-ktx2.json",
);
const LOD_REPORT = path.join(ROOT, "art-source", "reports", "character-lod1.json");
const BOOTSTRAP_REPORT = path.join(ROOT, "art-source", "reports", "character-bootstrap.json");
const FIRST_PLAYABLE_BASELINE_BYTES = 8_309_819;
const VILLAIN_BOOTSTRAP_MAX_BYTES = 1_474_540;
const NATIVE_GLTFPACK_SHA256 = "037336fafa46f342fe118ce8d17877fecb3deb1cd6dd8f62ee2a95bfaf2b79df";
const VILLAIN_HIGH_TRIANGLES = Object.freeze({ minimum: 45_000, maximum: 75_000 });
const VILLAIN_LOD_TRIANGLES = Object.freeze({ minimum: 20_000, maximum: 32_000 });
const VILLAIN_SKINNED_PARTS = Object.freeze([
  "Villain_A2_BootL",
  "Villain_A2_BootR",
  "Villain_A2_CoatSkirtL",
  "Villain_A2_CoatSkirtR",
  "Villain_A2_CoatTorso",
  "Villain_A2_FaceShadow",
  "Villain_A2_Hood",
  "Villain_A2_LiningHardware",
  "Villain_A2_PantsL",
  "Villain_A2_PantsR",
  "Villain_A2_SleeveL",
  "Villain_A2_SleeveR",
]);
const VILLAIN_SEMANTIC_MATERIALS = Object.freeze([
  "M_Villain_A2_boots",
  "M_Villain_A2_coat",
  "M_Villain_A2_face_shadow",
  "M_Villain_A2_hood",
  "M_Villain_A2_lining_hardware",
  "M_Villain_A2_pants",
]);
const FLOOR_TOLERANCE_METERS = 0.0025;
const UNIT_SCALE_TOLERANCE = 0.0001;
const WEIGHT_EPSILON = 1e-6;

const VILLAIN_CLIP_DURATIONS = Object.freeze({
  Alert: 0.6,
  Catch: 1.2,
  CheckHide: 2.2666667,
  Idle: 2.5,
  LostSight: 1.7666667,
  PatrolWalk: 1.4666667,
  Run: 0.8666667,
  Search: 1.4333333,
});

const JOINT_PARENTS = Object.freeze({
  Hips: null,
  Spine: "Hips",
  Chest: "Spine",
  Neck: "Chest",
  Head: "Neck",
  LeftShoulder: "Chest",
  LeftUpperArm: "LeftShoulder",
  LeftLowerArm: "LeftUpperArm",
  LeftHand: "LeftLowerArm",
  RightShoulder: "Chest",
  RightUpperArm: "RightShoulder",
  RightLowerArm: "RightUpperArm",
  RightHand: "RightLowerArm",
  LeftUpperLeg: "Hips",
  LeftLowerLeg: "LeftUpperLeg",
  LeftFoot: "LeftLowerLeg",
  LeftToes: "LeftFoot",
  RightUpperLeg: "Hips",
  RightLowerLeg: "RightUpperLeg",
  RightFoot: "RightLowerLeg",
  RightToes: "RightFoot",
});
const JOINT_NAMES = Object.freeze(Object.keys(JOINT_PARENTS));

const COMPONENTS = new Map([
  ["SCALAR", 1],
  ["VEC2", 2],
  ["VEC3", 3],
  ["VEC4", 4],
  ["MAT2", 4],
  ["MAT3", 9],
  ["MAT4", 16],
]);
const COMPONENT_BYTES = new Map([
  [5120, 1],
  [5121, 1],
  [5122, 2],
  [5123, 2],
  [5125, 4],
  [5126, 4],
]);
const COMPONENT_READERS = new Map([
  [5120, "readInt8"],
  [5121, "readUInt8"],
  [5122, "readInt16LE"],
  [5123, "readUInt16LE"],
  [5125, "readUInt32LE"],
  [5126, "readFloatLE"],
]);
const COMPONENT_NORMALIZERS = new Map([
  [5120, (value) => Math.max(value / 127, -1)],
  [5121, (value) => value / 255],
  [5122, (value) => Math.max(value / 32767, -1)],
  [5123, (value) => value / 65535],
]);
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const assetPromises = new Map();

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function readGlb(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not GLB`);
  assert.equal(buffer.readUInt32LE(4), 2, `${filename} must use glTF 2.0`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} declares the wrong size`);
  let json;
  let binary;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    assert.equal(payload.length, length, `${filename} contains a truncated GLB chunk`);
    if (type === 0x4e4f534a) {
      json = JSON.parse(payload.toString("utf8").replace(/[\0 ]+$/u, "").trim());
    } else if (type === 0x004e4942) {
      binary = payload;
    }
    offset += 8 + length;
  }
  assert.ok(json && binary, `${filename} must contain JSON and BIN chunks`);
  const embeddedBufferIndex = json.buffers.findIndex(
    (candidate) => candidate.uri === undefined
      && !candidate.extensions?.EXT_meshopt_compression?.fallback,
  );
  assert.ok(embeddedBufferIndex >= 0, `${filename} has no embedded physical buffer`);
  return {
    filename,
    buffer,
    json,
    binary,
    embeddedBufferIndex,
    decodedViews: new Map(),
  };
}

async function decodeMeshopt(asset) {
  const compressedViews = (asset.json.bufferViews ?? [])
    .map((view, index) => ({
      index,
      compression: view.extensions?.EXT_meshopt_compression,
    }))
    .filter(({ compression }) => compression);
  assert.ok(compressedViews.length > 0, `${asset.filename} must use Meshopt`);
  await MeshoptDecoder.ready;
  assert.equal(MeshoptDecoder.supported, true, "the pinned Meshopt decoder is unavailable");
  for (const { index, compression } of compressedViews) {
    assert.equal(
      compression.buffer,
      asset.embeddedBufferIndex,
      `${asset.filename} Meshopt view ${index} is not embedded`,
    );
    const decoded = new Uint8Array(compression.count * compression.byteStride);
    const source = new Uint8Array(
      asset.binary.buffer,
      asset.binary.byteOffset + (compression.byteOffset ?? 0),
      compression.byteLength,
    );
    MeshoptDecoder.decodeGltfBuffer(
      decoded,
      compression.count,
      compression.byteStride,
      source,
      compression.mode,
      compression.filter,
    );
    asset.decodedViews.set(
      index,
      Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength),
    );
  }
  return asset;
}

async function loadVariant(basename) {
  if (!assetPromises.has(basename)) {
    assetPromises.set(basename, (async () => {
      const filename = path.join(CHARACTER_DIRECTORY, basename);
      return decodeMeshopt(readGlb(await readFile(filename), filename));
    })());
  }
  return assetPromises.get(basename);
}

function accessorRows(asset, accessorIndex) {
  const accessor = asset.json.accessors[accessorIndex];
  assert.ok(accessor, `${asset.filename} references missing accessor ${accessorIndex}`);
  assert.equal(accessor.sparse, undefined, `${asset.filename} cannot use sparse actor accessors`);
  const viewIndex = accessor.bufferView;
  const view = asset.json.bufferViews[viewIndex];
  const components = COMPONENTS.get(accessor.type);
  const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
  const reader = COMPONENT_READERS.get(accessor.componentType);
  assert.ok(components && componentBytes && reader, `${asset.filename} has an unsupported accessor`);
  const decoded = asset.decodedViews.get(viewIndex);
  const bytes = decoded ?? asset.binary;
  const stride = view.byteStride ?? components * componentBytes;
  const start = (decoded ? 0 : (view.byteOffset ?? 0)) + (accessor.byteOffset ?? 0);
  const normalize = COMPONENT_NORMALIZERS.get(accessor.componentType);
  if (accessor.normalized) {
    assert.ok(normalize, `${asset.filename} uses an unsupported normalized accessor`);
  }
  const rows = [];
  for (let item = 0; item < accessor.count; item += 1) {
    const row = [];
    for (let component = 0; component < components; component += 1) {
      const value = bytes[reader](start + item * stride + component * componentBytes);
      row.push(accessor.normalized ? normalize(value) : value);
    }
    rows.push(row);
  }
  return rows;
}

function localNodeMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
    new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
  );
}

function parentIndexes(asset) {
  const parents = new Map();
  for (const [parentIndex, node] of asset.json.nodes.entries()) {
    for (const childIndex of node.children ?? []) {
      assert.equal(
        parents.has(childIndex),
        false,
        `${asset.filename} node ${childIndex} has multiple parents`,
      );
      parents.set(childIndex, parentIndex);
    }
  }
  return parents;
}

function globalNodeMatrix(asset, nodeIndex, parents = parentIndexes(asset)) {
  const chain = [];
  const visited = new Set();
  for (let current = nodeIndex; current !== undefined; current = parents.get(current)) {
    assert.equal(visited.has(current), false, `${asset.filename} node hierarchy contains a cycle`);
    visited.add(current);
    chain.push(current);
  }
  const matrix = new THREE.Matrix4();
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    matrix.multiply(localNodeMatrix(asset.json.nodes[chain[index]]));
  }
  return matrix;
}

function sceneBounds(asset) {
  const bounds = new THREE.Box3();
  const visit = (nodeIndex, parentMatrix) => {
    const node = asset.json.nodes[nodeIndex];
    const worldMatrix = parentMatrix.clone().multiply(localNodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of asset.json.meshes[node.mesh].primitives) {
        const position = asset.json.accessors[primitive.attributes.POSITION];
        assert.ok(position.min && position.max, `${asset.filename} needs POSITION bounds`);
        bounds.union(new THREE.Box3(
          new THREE.Vector3(...position.min),
          new THREE.Vector3(...position.max),
        ).applyMatrix4(worldMatrix));
      }
    }
    for (const child of node.children ?? []) visit(child, worldMatrix);
  };
  for (const nodeIndex of asset.json.scenes[asset.json.scene ?? 0].nodes ?? []) {
    visit(nodeIndex, new THREE.Matrix4());
  }
  assert.equal(bounds.isEmpty(), false, `${asset.filename} has no visible geometry`);
  return bounds;
}

function assertUnitScale(asset, nodeIndex, label) {
  const scale = new THREE.Vector3();
  localNodeMatrix(asset.json.nodes[nodeIndex]).decompose(
    new THREE.Vector3(),
    new THREE.Quaternion(),
    scale,
  );
  for (const [axis, value] of Object.entries({ x: scale.x, y: scale.y, z: scale.z })) {
    assert.ok(
      Math.abs(value - 1) <= UNIT_SCALE_TOLERANCE,
      `${asset.filename} ${label} ${axis}-scale must be 1, received ${value}`,
    );
  }
}

function assertRigAndSkinning(asset) {
  assert.equal(asset.json.skins?.length, 1, `${asset.filename} must contain exactly one skin`);
  const skin = asset.json.skins[0];
  assert.equal(skin.joints.length, 21, `${asset.filename} must retain exactly 21 joints`);
  const nodesByName = new Map();
  for (const [nodeIndex, node] of asset.json.nodes.entries()) {
    if (!node.name) continue;
    const indexes = nodesByName.get(node.name) ?? [];
    indexes.push(nodeIndex);
    nodesByName.set(node.name, indexes);
  }
  for (const name of JOINT_NAMES) {
    assert.deepEqual(
      nodesByName.get(name),
      [asset.json.nodes.findIndex((node) => node.name === name)],
      `${asset.filename} must contain exactly one ${name} joint node`,
    );
  }
  const jointNames = skin.joints.map((nodeIndex) => asset.json.nodes[nodeIndex]?.name);
  assert.deepEqual(jointNames, JOINT_NAMES, `${asset.filename} changed joint order or identity`);
  assert.equal(new Set(skin.joints).size, 21, `${asset.filename} repeats a joint index`);

  const parents = parentIndexes(asset);
  const jointIndexByName = new Map(jointNames.map((name, index) => [name, skin.joints[index]]));
  for (const [name, expectedParent] of Object.entries(JOINT_PARENTS)) {
    const nodeIndex = jointIndexByName.get(name);
    const actualParentIndex = parents.get(nodeIndex);
    if (expectedParent === null) {
      assert.equal(
        skin.joints.includes(actualParentIndex),
        false,
        `${asset.filename}/${name} must be the joint hierarchy root`,
      );
    } else {
      assert.equal(
        actualParentIndex,
        jointIndexByName.get(expectedParent),
        `${asset.filename}/${name} must be parented to ${expectedParent}`,
      );
    }
    assertUnitScale(asset, nodeIndex, `joint ${name}`);
  }

  for (const rootIndex of asset.json.scenes[asset.json.scene ?? 0].nodes ?? []) {
    assertUnitScale(asset, rootIndex, `scene root ${asset.json.nodes[rootIndex].name ?? rootIndex}`);
  }
  const meshNodes = asset.json.nodes
    .map((node, nodeIndex) => ({ node, nodeIndex }))
    .filter(({ node }) => node.mesh !== undefined);
  const partNameFor = ({ node, nodeIndex }) => (
    node.name
      ?? asset.json.nodes[parents.get(nodeIndex)]?.name
      ?? asset.json.meshes[node.mesh]?.name
  );
  assert.deepEqual(
    meshNodes.map(partNameFor).sort(),
    [...VILLAIN_SKINNED_PARTS].sort(),
    `${asset.filename} must retain the 12 reviewed garment/body parts`,
  );
  for (const meshNode of meshNodes) {
    const { node, nodeIndex } = meshNode;
    const partName = partNameFor(meshNode) ?? nodeIndex;
    assert.equal(node.skin, 0, `${asset.filename}/${partName} must use the canonical skin`);
    if (node.name) {
      assertUnitScale(asset, nodeIndex, `mesh node ${partName}`);
    } else {
      assertUnitScale(asset, parents.get(nodeIndex), `semantic wrapper ${partName}`);
    }
  }

  const hipsZ = new THREE.Vector3()
    .setFromMatrixPosition(globalNodeMatrix(asset, jointIndexByName.get("Hips"), parents)).z;
  for (const toe of ["LeftToes", "RightToes"]) {
    const toeZ = new THREE.Vector3()
      .setFromMatrixPosition(globalNodeMatrix(asset, jointIndexByName.get(toe), parents)).z;
    assert.ok(
      toeZ >= hipsZ + 0.05,
      `${asset.filename}/${toe} must point toward +Z (hips ${hipsZ}, toe ${toeZ})`,
    );
  }

  let vertices = 0;
  let zeroWeightVertices = 0;
  const influencedVertices = new Map([["LeftHand", 0], ["RightHand", 0]]);
  const handJointSlots = new Map(
    [...influencedVertices.keys()].map((name) => [name, jointNames.indexOf(name)]),
  );
  for (const mesh of asset.json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const positionCount = asset.json.accessors[primitive.attributes.POSITION].count;
      const skinSets = [0, 1]
        .filter((setIndex) => (
          primitive.attributes[`JOINTS_${setIndex}`] !== undefined
            || primitive.attributes[`WEIGHTS_${setIndex}`] !== undefined
        ));
      assert.ok(skinSets.includes(0), `${asset.filename} must provide JOINTS_0/WEIGHTS_0`);
      const sets = skinSets.map((setIndex) => {
        const jointAccessor = primitive.attributes[`JOINTS_${setIndex}`];
        const weightAccessor = primitive.attributes[`WEIGHTS_${setIndex}`];
        assert.notEqual(jointAccessor, undefined, `${asset.filename} is missing JOINTS_${setIndex}`);
        assert.notEqual(weightAccessor, undefined, `${asset.filename} is missing WEIGHTS_${setIndex}`);
        const joints = accessorRows(asset, jointAccessor);
        const weights = accessorRows(asset, weightAccessor);
        assert.equal(joints.length, positionCount, `${asset.filename} JOINTS_${setIndex} count drifted`);
        assert.equal(weights.length, positionCount, `${asset.filename} WEIGHTS_${setIndex} count drifted`);
        return { joints, weights };
      });
      for (let vertex = 0; vertex < positionCount; vertex += 1) {
        vertices += 1;
        let weightSum = 0;
        const vertexHands = new Set();
        for (const { joints, weights } of sets) {
          assert.equal(joints[vertex].length, weights[vertex].length);
          for (let influence = 0; influence < weights[vertex].length; influence += 1) {
            const joint = joints[vertex][influence];
            const weight = weights[vertex][influence];
            assert.ok(Number.isInteger(joint) && joint >= 0 && joint < 21, `${asset.filename} has an invalid joint slot`);
            assert.ok(Number.isFinite(weight) && weight >= 0, `${asset.filename} has an invalid skin weight`);
            weightSum += weight;
            for (const [hand, slot] of handJointSlots) {
              if (joint === slot && weight > WEIGHT_EPSILON) vertexHands.add(hand);
            }
          }
        }
        if (weightSum <= WEIGHT_EPSILON) zeroWeightVertices += 1;
        for (const hand of vertexHands) {
          influencedVertices.set(hand, influencedVertices.get(hand) + 1);
        }
      }
    }
  }
  assert.ok(vertices > 0, `${asset.filename} has no weighted vertices`);
  assert.ok(
    zeroWeightVertices / vertices < 0.02,
    `${asset.filename} has ${zeroWeightVertices}/${vertices} zero-weight vertices`,
  );
  for (const [hand, count] of influencedVertices) {
    assert.ok(count > 0, `${asset.filename}/${hand} influences zero vertices`);
  }

  const bounds = sceneBounds(asset);
  const height = bounds.max.y - bounds.min.y;
  assert.ok(height >= 1.6 && height <= 2.2, `${asset.filename} has implausible height ${height}m`);
  assert.ok(
    Math.abs(bounds.min.y) <= FLOOR_TOLERANCE_METERS,
    `${asset.filename} feet must land at Y=0, received ${bounds.min.y}`,
  );
}

function textureSource(texture) {
  return texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
}

function assertSemanticKtx2Surfaces(asset) {
  assert.equal(asset.json.meshes?.length, 12, `${asset.filename} must retain 12 real skinned parts`);
  assert.deepEqual(
    (asset.json.materials ?? []).map(({ name }) => name).sort(),
    [...VILLAIN_SEMANTIC_MATERIALS].sort(),
    `${asset.filename} must retain the six reviewed semantic materials`,
  );
  const usedMaterials = new Set();
  for (const mesh of asset.json.meshes) {
    assert.equal(mesh.primitives.length, 1, `${asset.filename}/${mesh.name} must contain one primitive`);
    const primitive = mesh.primitives[0];
    assert.ok(
      Number.isInteger(primitive.material),
      `${asset.filename}/${mesh.name} must reference a semantic material`,
    );
    usedMaterials.add(primitive.material);
    for (const semantic of ["POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0", "JOINTS_0", "WEIGHTS_0"]) {
      assert.notEqual(
        primitive.attributes[semantic],
        undefined,
        `${asset.filename}/${mesh.name} is missing ${semantic}`,
      );
    }
  }
  assert.deepEqual(
    [...usedMaterials].sort((left, right) => left - right),
    asset.json.materials.map((_, index) => index),
    `${asset.filename} contains an unused or fake semantic material`,
  );
  assert.equal(asset.json.textures?.length, 3, `${asset.filename} must share one three-map PBR atlas`);
  assert.equal(asset.json.images?.length, 3, `${asset.filename} must embed one three-map PBR atlas`);
  const textureBindings = asset.json.materials.map((material) => ({
    baseColor: material.pbrMetallicRoughness?.baseColorTexture?.index,
    metallicRoughness: material.pbrMetallicRoughness?.metallicRoughnessTexture?.index,
    normal: material.normalTexture?.index,
    occlusion: material.occlusionTexture?.index,
  }));
  assert.equal(
    new Set(textureBindings.map((binding) => JSON.stringify(binding))).size,
    1,
    `${asset.filename} semantic materials must reuse the same atlas textures`,
  );
  const physicalSignatures = asset.json.materials.map((material) => JSON.stringify({
    metallic: material.pbrMetallicRoughness?.metallicFactor ?? 1,
    roughness: material.pbrMetallicRoughness?.roughnessFactor ?? 1,
    normalScale: material.normalTexture?.scale ?? 1,
  }));
  assert.ok(
    new Set(physicalSignatures).size >= 4,
    `${asset.filename} semantic materials must encode real, not label-only, surface differences`,
  );
  assert.ok(
    asset.json.extensionsRequired?.includes("EXT_meshopt_compression"),
    `${asset.filename} must require Meshopt`,
  );
  assert.ok(
    asset.json.extensionsRequired?.includes("KHR_texture_basisu"),
    `${asset.filename} must require KHR_texture_basisu`,
  );
  assert.ok((asset.json.images?.length ?? 0) >= 3, `${asset.filename} must retain PBR surfaces`);
  for (const [imageIndex, image] of asset.json.images.entries()) {
    assert.equal(image.uri, undefined, `${asset.filename} image ${imageIndex} must stay embedded`);
    assert.equal(image.mimeType, "image/ktx2", `${asset.filename} image ${imageIndex} must be KTX2`);
    const view = asset.json.bufferViews[image.bufferView];
    assert.equal(view.buffer, asset.embeddedBufferIndex);
    const start = view.byteOffset ?? 0;
    assert.equal(
      asset.binary.subarray(start, start + KTX2_SIGNATURE.length).equals(KTX2_SIGNATURE),
      true,
      `${asset.filename} image ${imageIndex} has an invalid KTX2 signature`,
    );
  }
  for (const [textureIndex, texture] of (asset.json.textures ?? []).entries()) {
    const source = textureSource(texture);
    assert.ok(Number.isInteger(source), `${asset.filename} texture ${textureIndex} has no source`);
    assert.equal(
      asset.json.images[source].mimeType,
      "image/ktx2",
      `${asset.filename} texture ${textureIndex} bypasses KTX2`,
    );
  }
}

function animationDuration(asset, animation) {
  return Math.max(...animation.samplers.map((sampler) => {
    const input = asset.json.accessors[sampler.input];
    return input.max?.[0]
      ?? Math.max(...accessorRows(asset, sampler.input).map(([time]) => time));
  }));
}

function rotationTravelRadians(asset, animation) {
  let travel = 0;
  for (const channel of animation.channels) {
    if (channel.target.path !== "rotation") continue;
    const output = animation.samplers[channel.sampler].output;
    const values = accessorRows(asset, output);
    for (let index = 1; index < values.length; index += 1) {
      travel += new THREE.Quaternion(...values[index - 1]).normalize()
        .angleTo(new THREE.Quaternion(...values[index]).normalize());
    }
  }
  return travel;
}

function assertGameplayClips(asset) {
  const animations = asset.json.animations ?? [];
  assert.deepEqual(
    animations.map(({ name }) => name).sort(),
    Object.keys(VILLAIN_CLIP_DURATIONS).sort(),
    `${asset.filename} changed the remote gameplay clip contract`,
  );
  const skinJointIndexes = new Set(asset.json.skins[0].joints);
  const expectedChannels = [
    ...JOINT_NAMES.map((name) => `${name}|rotation`),
    "Hips|translation",
  ].sort();
  for (const animation of animations) {
    const duration = animationDuration(asset, animation);
    assert.ok(
      Math.abs(duration - VILLAIN_CLIP_DURATIONS[animation.name]) <= 0.0001,
      `${asset.filename}/${animation.name} duration drifted to ${duration}s`,
    );
    const channels = animation.channels.map((channel) => {
      assert.ok(
        skinJointIndexes.has(channel.target.node),
        `${asset.filename}/${animation.name} targets a non-joint node`,
      );
      const nodeName = asset.json.nodes[channel.target.node].name;
      return `${nodeName}|${channel.target.path}`;
    });
    assert.equal(
      new Set(channels).size,
      channels.length,
      `${asset.filename}/${animation.name} contains duplicate channels`,
    );
    assert.deepEqual(
      channels.sort(),
      expectedChannels,
      `${asset.filename}/${animation.name} must animate the complete 21-joint body`,
    );
    assert.ok(
      rotationTravelRadians(asset, animation) > 0.035,
      `${asset.filename}/${animation.name} is effectively a static pose`,
    );
  }
}

function triangleCount(asset) {
  return (asset.json.meshes ?? []).reduce((total, mesh) => (
    total + mesh.primitives.reduce((meshTotal, primitive) => {
      const accessor = asset.json.accessors[
        primitive.indices ?? primitive.attributes.POSITION
      ];
      return meshTotal + accessor.count / 3;
    }, 0)
  ), 0);
}

function imageViewIndexes(asset) {
  return new Set((asset.json.images ?? []).map((image) => image.bufferView));
}

function nonImageTransport(asset) {
  const imageViews = imageViewIndexes(asset);
  const entries = [];
  for (const [viewIndex, view] of asset.json.bufferViews.entries()) {
    if (imageViews.has(viewIndex)) continue;
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression?.buffer === asset.embeddedBufferIndex) {
      const start = compression.byteOffset ?? 0;
      const payload = asset.binary.subarray(start, start + compression.byteLength);
      entries.push({ viewIndex, kind: "meshopt", bytes: payload.length, sha256: sha256(payload) });
    } else if (view.buffer === asset.embeddedBufferIndex) {
      const start = view.byteOffset ?? 0;
      const payload = asset.binary.subarray(start, start + view.byteLength);
      entries.push({ viewIndex, kind: "physical", bytes: payload.length, sha256: sha256(payload) });
    }
  }
  return entries;
}

function accessorContract(asset, accessorIndex) {
  const accessor = asset.json.accessors[accessorIndex];
  return {
    bufferView: accessor.bufferView,
    byteOffset: accessor.byteOffset ?? 0,
    componentType: accessor.componentType,
    normalized: accessor.normalized ?? false,
    count: accessor.count,
    type: accessor.type,
    min: accessor.min,
    max: accessor.max,
  };
}

function geometryContract(asset) {
  return asset.json.meshes.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((primitive) => ({
      mode: primitive.mode ?? 4,
      material: primitive.material,
      attributes: Object.fromEntries(
        Object.entries(primitive.attributes)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([semantic, accessorIndex]) => [semantic, accessorContract(asset, accessorIndex)]),
      ),
      indices: primitive.indices === undefined
        ? null
        : accessorContract(asset, primitive.indices),
    })),
  }));
}

function animationContract(asset) {
  return asset.json.animations.map((animation) => ({
    name: animation.name,
    channels: animation.channels.map((channel) => ({
      node: asset.json.nodes[channel.target.node].name,
      path: channel.target.path,
      sampler: channel.sampler,
    })),
    samplers: animation.samplers.map((sampler) => ({
      interpolation: sampler.interpolation ?? "LINEAR",
      input: accessorContract(asset, sampler.input),
      output: accessorContract(asset, sampler.output),
    })),
  }));
}

function semanticContract(asset) {
  const json = structuredClone(asset.json);
  delete json.buffers;
  delete json.bufferViews;
  delete json.images;
  return json;
}

test("M1 villain high model ships the approved semantic-part KTX2 visual topology", async () => {
  const asset = await loadVariant("villain.glb");
  assertSemanticKtx2Surfaces(asset);
  assertRigAndSkinning(asset);
  const triangles = triangleCount(asset);
  assert.ok(
    triangles >= VILLAIN_HIGH_TRIANGLES.minimum
      && triangles <= VILLAIN_HIGH_TRIANGLES.maximum,
    `${asset.filename} has ${triangles} triangles; expected 45k-75k`,
  );
});

test("M1 villain keeps the unique shared rig, +Z orientation, grounded feet and unit scale in every runtime variant", async () => {
  for (const basename of ["villain.glb", "villain-lod1.glb", "villain-bootstrap.glb"]) {
    assertRigAndSkinning(await loadVariant(basename));
  }
});

test("M1 villain retains all eight full-body remote gameplay clips and their timings", async () => {
  for (const basename of ["villain.glb", "villain-lod1.glb", "villain-bootstrap.glb"]) {
    assertGameplayClips(await loadVariant(basename));
  }
});

test("M1 villain LOD and bootstrap stay inside the reviewed geometry and payload envelope", async () => {
  const [lod, bootstrap] = await Promise.all([
    loadVariant("villain-lod1.glb"),
    loadVariant("villain-bootstrap.glb"),
  ]);
  for (const asset of [lod, bootstrap]) {
    assertSemanticKtx2Surfaces(asset);
    const triangles = triangleCount(asset);
    assert.ok(
      triangles >= VILLAIN_LOD_TRIANGLES.minimum
        && triangles <= VILLAIN_LOD_TRIANGLES.maximum,
      `${asset.filename} has ${triangles} triangles; expected 20k-32k`,
    );
  }
  assert.ok(
    bootstrap.buffer.length <= VILLAIN_BOOTSTRAP_MAX_BYTES,
    `villain bootstrap grew to ${bootstrap.buffer.length} bytes`,
  );
});

test("M1 villain bootstrap changes only LOD image payloads", async () => {
  const [lod, bootstrap] = await Promise.all([
    loadVariant("villain-lod1.glb"),
    loadVariant("villain-bootstrap.glb"),
  ]);
  assert.equal(triangleCount(bootstrap), triangleCount(lod));
  assert.deepEqual(geometryContract(bootstrap), geometryContract(lod));
  assert.deepEqual(animationContract(bootstrap), animationContract(lod));
  assert.deepEqual(nonImageTransport(bootstrap), nonImageTransport(lod));
  assert.deepEqual(semanticContract(bootstrap), semanticContract(lod));
});

test("M1 villain reports bind the frozen runtime assets, reproducible encoder and decoded KTX2 quality", async () => {
  const [animationReport, runtimeKtx2, lodReport, bootstrapReport] = await Promise.all([
    readFile(ANIMATION_REPORT, "utf8").then(JSON.parse),
    readFile(RUNTIME_KTX2_REPORT, "utf8").then(JSON.parse),
    readFile(LOD_REPORT, "utf8").then(JSON.parse),
    readFile(BOOTSTRAP_REPORT, "utf8").then(JSON.parse),
  ]);
  assert.equal(animationReport.role, "villain");
  assert.equal(animationReport.artifactStage, "preMeshoptAnimationBakedRealisticLod0Staging");
  assert.notEqual(
    animationReport.outputAtBuildTime.sha256,
    animationReport.finalRuntime.high.sha256,
    "the pre-Meshopt staging artifact must not masquerade as the final runtime asset",
  );
  assert.equal(
    animationReport.qualityGates.realisticLod0.binarySha256,
    NATIVE_GLTFPACK_SHA256,
  );
  assert.equal(runtimeKtx2.actualToolchain.sharpVersion, "0.35.2");
  assert.equal(
    runtimeKtx2.actualToolchain.assetGltfpackBinarySha256[
      "public/models/characters/villain.glb"
    ],
    NATIVE_GLTFPACK_SHA256,
  );
  assert.equal(lodReport.generation.roleBinarySha256.villain, NATIVE_GLTFPACK_SHA256);
  assert.equal(bootstrapReport.generation.roleBinarySha256.villain, NATIVE_GLTFPACK_SHA256);
  assert.ok(lodReport.totals.savedPercent >= 35, "the inherited aggregate LOD gate regressed");

  const variants = Object.freeze({
    high: "villain.glb",
    lod1: "villain-lod1.glb",
    bootstrap: "villain-bootstrap.glb",
  });
  for (const [variant, basename] of Object.entries(variants)) {
    const [asset, file] = await Promise.all([
      loadVariant(basename),
      readFile(path.join(CHARACTER_DIRECTORY, basename)),
    ]);
    const record = animationReport.finalRuntime[variant];
    assert.equal(record.path, `public/models/characters/${basename}`);
    assert.equal(record.bytes, file.length);
    assert.equal(record.sha256, sha256(file));
    assert.equal(record.triangles, triangleCount(asset));
    assert.equal(record.nodes, asset.json.nodes.length);
    assert.equal(record.materials, asset.json.materials.length);
    assert.equal(record.joints, asset.json.skins[0].joints.length);
    assert.deepEqual(record.clips, Object.keys(VILLAIN_CLIP_DURATIONS).sort());

    const textures = Object.fromEntries(record.textures.map((texture) => [texture.slot, texture]));
    assert.ok(textures.baseColor.decodedRgb.stddev >= 8, `${variant} BaseColor became flat`);
    assert.ok(textures.normal.decodedRgb.channelStddev[0] >= 2.2, `${variant} Normal R lost detail`);
    assert.ok(textures.normal.decodedRgb.channelStddev[1] >= 1.35, `${variant} Normal G lost detail`);
    assert.ok(textures.orm.decodedRgb.channelStddev[0] >= 3, `${variant} ORM AO(R) became flat`);
    assert.ok(textures.baseColor.scaledAuthoredSource.peakSignalToNoiseRatioDb >= 37);
    assert.ok(textures.baseColor.scaledAuthoredSource.maximumChannelDelta <= 18);
    assert.ok(textures.normal.scaledAuthoredSource.peakSignalToNoiseRatioDb >= 44);
    assert.ok(textures.normal.scaledAuthoredSource.maximumChannelDelta <= 11);
    assert.ok(textures.orm.scaledAuthoredSource.peakSignalToNoiseRatioDb >= 47);
    assert.ok(textures.orm.scaledAuthoredSource.maximumChannelDelta <= 8);
  }
});

test("M1 villain does not exceed the accepted first-playable encoded-transfer baseline", async () => {
  const [manifest, bootstrap] = await Promise.all([
    readFile(RUNTIME_MANIFEST, "utf8").then(JSON.parse),
    loadVariant("villain-bootstrap.glb"),
  ]);
  const budget = manifest.firstPlayableBudget;
  assert.equal(budget.measurement, "encoded-transfer-bytes");
  const recomputedCriticalBytes = budget.assets
    .filter((asset) => asset.phase === "critical")
    .reduce((total, asset) => total + asset.estimatedTransferBytes, 0);
  assert.equal(budget.criticalBytes, recomputedCriticalBytes);
  assert.ok(
    budget.criticalBytes <= FIRST_PLAYABLE_BASELINE_BYTES,
    `first playable grew to ${budget.criticalBytes} encoded bytes`,
  );
  const villainRecord = budget.assets.find(
    (asset) => asset.path === "/models/characters/villain-bootstrap.glb",
  );
  assert.ok(villainRecord, "villain bootstrap is missing from first-playable accounting");
  assert.equal(villainRecord.phase, "critical");
  assert.equal(villainRecord.kind, "model");
  assert.equal(villainRecord.transferEncoding, "already-compressed");
  assert.equal(villainRecord.rawBytes, bootstrap.buffer.length);
  assert.equal(villainRecord.estimatedTransferBytes, bootstrap.buffer.length);
  assert.equal(villainRecord.sha256, sha256(bootstrap.buffer));
});
