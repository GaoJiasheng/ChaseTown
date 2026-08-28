import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  CHARACTER_BOOTSTRAP_CONTRACTS,
  decodedKtx2Rgba,
} from "../tools/art_pipeline/build_character_bootstrap.mjs";
import {
  CHARACTER_LOD_CONTRACTS,
} from "../tools/art_pipeline/build_character_lod1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTER_DIRECTORY = path.join(ROOT, "public", "models", "characters");
const BOOTSTRAP_REPORT = path.join(ROOT, "art-source", "reports", "character-bootstrap.json");
const APP_SOURCE = path.join(ROOT, "app", "chasing-game.tsx");
const PBR_PIPELINE_SOURCE = await readFile(
  path.join(ROOT, "tools", "art_pipeline", "apply_character_pbr.py"),
  "utf8",
);
const A2_PIPELINE_SOURCE = await readFile(
  path.join(ROOT, "tools", "art_pipeline", "build_a2_police_visual_rework.py"),
  "utf8",
);
const POLICE_ANIMATION_WRAPPER_SOURCE = await readFile(
  path.join(ROOT, "tools", "art_pipeline", "build_police_animation_candidate.py"),
  "utf8",
);
const POLICE_ANIMATION_REPORT = JSON.parse(await readFile(
  path.join(
    ROOT,
    "art-source",
    "Characters",
    "Police",
    "ReferenceStandard",
    "A2_VisualRework_2026_08_29",
    "Reports",
    "Police_A2_animation_set_report.json",
  ),
  "utf8",
));
const POLICE_PBR_REPORT = JSON.parse(await readFile(
  path.join(
    ROOT,
    "art-source",
    "Characters",
    "Police",
    "ReferenceStandard",
    "A2_VisualRework_2026_08_29",
    "Reports",
    "Police_A2_pbr_report.json",
  ),
  "utf8",
));
const HIGH_BASENAME = "police.glb";
const BOOTSTRAP_BASENAME = "police-bootstrap.glb";
const LOD1_BASENAME = "police-lod1.glb";

const HIGH_MAX_BYTES = 8_850_000;
const BOOTSTRAP_MAX_BYTES = 2 * 1024 * 1024;
const MIN_TRIANGLES = 40_000;
const MAX_TRIANGLES = 60_000;
const WEIGHT_EPSILON = 1e-6;

const CLIP_DURATION_RANGES = Object.freeze({
  Alert: Object.freeze([0.8, 2.2]),
  Idle: Object.freeze([1.5, 4]),
  Interact: Object.freeze([1, 3]),
  Resolve: Object.freeze([0.7, 2.2]),
  Run: Object.freeze([0.55, 1.4]),
});
const CLIP_NAMES = Object.freeze(Object.keys(CLIP_DURATION_RANGES).sort());

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
const JOINT_NAMES = Object.freeze(Object.keys(JOINT_PARENTS).sort());

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
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} declares the wrong byte length`);

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
    (bufferDefinition) => bufferDefinition.uri === undefined
      && !bufferDefinition.extensions?.EXT_meshopt_compression?.fallback,
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

function assertRigAndWeights(asset) {
  assert.equal(asset.json.skins?.length, 1, `${asset.filename} must contain one shared skin`);
  const skin = asset.json.skins[0];
  assert.equal(skin.joints.length, 21, `${asset.filename} must retain exactly 21 joints`);
  assert.equal(new Set(skin.joints).size, 21, `${asset.filename} repeats a joint node`);

  const indexesByName = new Map();
  for (const [nodeIndex, node] of asset.json.nodes.entries()) {
    if (!node.name) continue;
    const indexes = indexesByName.get(node.name) ?? [];
    indexes.push(nodeIndex);
    indexesByName.set(node.name, indexes);
  }
  for (const name of JOINT_NAMES) {
    assert.equal(
      indexesByName.get(name)?.length,
      1,
      `${asset.filename} must contain ${name} exactly once`,
    );
  }

  // Police's valid historical assets use a different skin.joints array order
  // from Kid/Villain. Identity and parentage are the contract, not slot order.
  const jointNamesInSkinOrder = skin.joints.map((nodeIndex) => asset.json.nodes[nodeIndex]?.name);
  assert.deepEqual(
    [...jointNamesInSkinOrder].sort(),
    JOINT_NAMES,
    `${asset.filename} changed the canonical joint set`,
  );
  const jointNodeByName = new Map(
    skin.joints.map((nodeIndex) => [asset.json.nodes[nodeIndex].name, nodeIndex]),
  );
  const parents = parentIndexes(asset);
  for (const [name, expectedParent] of Object.entries(JOINT_PARENTS)) {
    const nodeIndex = jointNodeByName.get(name);
    const parentIndex = parents.get(nodeIndex);
    if (expectedParent === null) {
      assert.equal(
        skin.joints.includes(parentIndex),
        false,
        `${asset.filename}/${name} must be the joint hierarchy root`,
      );
    } else {
      assert.equal(
        parentIndex,
        jointNodeByName.get(expectedParent),
        `${asset.filename}/${name} must be parented to ${expectedParent}`,
      );
    }
  }

  const meshNodes = asset.json.nodes.filter((node) => node.mesh !== undefined);
  assert.ok(meshNodes.length > 0, `${asset.filename} has no skinned meshes`);
  for (const node of meshNodes) {
    assert.equal(node.skin, 0, `${asset.filename}/${node.name ?? node.mesh} must use the shared skin`);
  }

  const handSlots = new Map([
    ["LeftHand", jointNamesInSkinOrder.indexOf("LeftHand")],
    ["RightHand", jointNamesInSkinOrder.indexOf("RightHand")],
  ]);
  let vertices = 0;
  let zeroWeightVertices = 0;
  const handVertices = new Map([["LeftHand", 0], ["RightHand", 0]]);

  for (const mesh of asset.json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const positionCount = asset.json.accessors[primitive.attributes.POSITION]?.count;
      assert.ok(positionCount > 0, `${asset.filename}/${mesh.name} has no POSITION vertices`);
      const setIndexes = [0, 1].filter((setIndex) => (
        primitive.attributes[`JOINTS_${setIndex}`] !== undefined
          || primitive.attributes[`WEIGHTS_${setIndex}`] !== undefined
      ));
      assert.ok(setIndexes.includes(0), `${asset.filename}/${mesh.name} lacks JOINTS_0/WEIGHTS_0`);
      const sets = setIndexes.map((setIndex) => {
        const jointAccessor = primitive.attributes[`JOINTS_${setIndex}`];
        const weightAccessor = primitive.attributes[`WEIGHTS_${setIndex}`];
        assert.notEqual(jointAccessor, undefined, `${asset.filename} lacks JOINTS_${setIndex}`);
        assert.notEqual(weightAccessor, undefined, `${asset.filename} lacks WEIGHTS_${setIndex}`);
        const joints = accessorRows(asset, jointAccessor);
        const weights = accessorRows(asset, weightAccessor);
        assert.equal(joints.length, positionCount, `${asset.filename} JOINTS_${setIndex} count drifted`);
        assert.equal(weights.length, positionCount, `${asset.filename} WEIGHTS_${setIndex} count drifted`);
        return { joints, weights };
      });

      for (let vertex = 0; vertex < positionCount; vertex += 1) {
        vertices += 1;
        let weightSum = 0;
        const influencedHands = new Set();
        for (const { joints, weights } of sets) {
          assert.equal(joints[vertex].length, weights[vertex].length);
          for (let influence = 0; influence < weights[vertex].length; influence += 1) {
            const joint = joints[vertex][influence];
            const weight = weights[vertex][influence];
            assert.ok(
              Number.isInteger(joint) && joint >= 0 && joint < skin.joints.length,
              `${asset.filename} has invalid joint slot ${joint}`,
            );
            assert.ok(
              Number.isFinite(weight) && weight >= 0,
              `${asset.filename} has invalid skin weight ${weight}`,
            );
            weightSum += weight;
            for (const [hand, slot] of handSlots) {
              if (joint === slot && weight > WEIGHT_EPSILON) influencedHands.add(hand);
            }
          }
        }
        if (weightSum <= WEIGHT_EPSILON) zeroWeightVertices += 1;
        for (const hand of influencedHands) {
          handVertices.set(hand, handVertices.get(hand) + 1);
        }
      }
    }
  }

  assert.ok(vertices > 0, `${asset.filename} has no weighted vertices`);
  assert.ok(
    zeroWeightVertices / vertices < 0.02,
    `${asset.filename} has ${zeroWeightVertices}/${vertices} zero-weight vertices`,
  );
  for (const [hand, count] of handVertices) {
    assert.ok(count > 0, `${asset.filename}/${hand} influences zero vertices`);
  }
  return { vertices, zeroWeightVertices, handVertices };
}

function textureSource(texture) {
  return texture.extensions?.KHR_texture_basisu?.source ?? texture.source;
}

function assertMeshoptKtx2(asset) {
  assert.ok(
    asset.json.extensionsRequired?.includes("EXT_meshopt_compression"),
    `${asset.filename} must require Meshopt`,
  );
  assert.ok(
    asset.json.extensionsRequired?.includes("KHR_texture_basisu"),
    `${asset.filename} must require KHR_texture_basisu`,
  );
  assert.equal(
    asset.json.extensionsRequired?.includes("KHR_mesh_quantization"),
    false,
    `${asset.filename} must retain authored floating-point geometry`,
  );
  assert.ok((asset.json.images?.length ?? 0) >= 3, `${asset.filename} must retain PBR textures`);
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

function embeddedImagePayload(asset, image) {
  const view = asset.json.bufferViews[image.bufferView];
  assert.equal(view.buffer, asset.embeddedBufferIndex);
  const start = view.byteOffset ?? 0;
  return asset.binary.subarray(start, start + view.byteLength);
}

function decodedRgbStatistics(data) {
  let sum = 0;
  let sumSquares = 0;
  const channelSums = [0, 0, 0];
  const channelSumSquares = [0, 0, 0];
  let pixels = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = data[offset + channel];
      sum += value;
      sumSquares += value * value;
      channelSums[channel] += value;
      channelSumSquares[channel] += value * value;
    }
    pixels += 1;
  }
  const samples = pixels * 3;
  const mean = sum / samples;
  return {
    stddev: Math.sqrt(Math.max(0, sumSquares / samples - mean * mean)),
    channelStddev: channelSums.map((channelSum, channel) => {
      const channelMean = channelSum / pixels;
      return Math.sqrt(Math.max(
        0,
        channelSumSquares[channel] / pixels - channelMean * channelMean,
      ));
    }),
  };
}

async function decodedTextureQuality(asset) {
  return Promise.all((asset.json.images ?? []).map(async (image) => ({
    name: image.name,
    statistics: decodedRgbStatistics((await decodedKtx2Rgba(
      embeddedImagePayload(asset, image),
      `${asset.filename}/${image.name}`,
    )).data),
  })));
}

function animationDuration(asset, animation) {
  return Math.max(...animation.samplers.map((sampler) => {
    const accessor = asset.json.accessors[sampler.input];
    return accessor.max?.[0]
      ?? Math.max(...accessorRows(asset, sampler.input).map(([time]) => time));
  }));
}

function quaternionAngle(left, right) {
  const leftLength = Math.hypot(...left);
  const rightLength = Math.hypot(...right);
  assert.ok(leftLength > 0 && rightLength > 0, "animation contains a zero quaternion");
  const dot = Math.abs(left.reduce(
    (total, value, index) => total + value * right[index],
    0,
  ) / (leftLength * rightLength));
  return 2 * Math.acos(Math.min(1, Math.max(-1, dot)));
}

function rotationTravelRadians(asset, animation) {
  let travel = 0;
  for (const channel of animation.channels) {
    if (channel.target.path !== "rotation") continue;
    const values = accessorRows(asset, animation.samplers[channel.sampler].output);
    for (let index = 1; index < values.length; index += 1) {
      travel += quaternionAngle(values[index - 1], values[index]);
    }
  }
  return travel;
}

function assertGameplayClips(asset) {
  const animations = asset.json.animations ?? [];
  assert.deepEqual(
    animations.map(({ name }) => name).sort(),
    CLIP_NAMES,
    `${asset.filename} changed the five-clip remote Police contract`,
  );
  const jointIndexes = new Set(asset.json.skins[0].joints);
  for (const animation of animations) {
    const [minimum, maximum] = CLIP_DURATION_RANGES[animation.name];
    const duration = animationDuration(asset, animation);
    assert.ok(
      duration >= minimum && duration <= maximum,
      `${asset.filename}/${animation.name} has implausible duration ${duration}s`,
    );
    const rotationTargets = new Set();
    const channelKeys = new Set();
    for (const channel of animation.channels) {
      assert.ok(
        jointIndexes.has(channel.target.node),
        `${asset.filename}/${animation.name} targets a non-joint node`,
      );
      const nodeName = asset.json.nodes[channel.target.node].name;
      const key = `${nodeName}|${channel.target.path}`;
      assert.equal(
        channelKeys.has(key),
        false,
        `${asset.filename}/${animation.name} repeats channel ${key}`,
      );
      channelKeys.add(key);
      if (channel.target.path === "rotation") rotationTargets.add(nodeName);
    }
    assert.ok(
      rotationTargets.size >= 20,
      `${asset.filename}/${animation.name} animates only ${rotationTargets.size} joint rotations`,
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

test("M1 Police high and bootstrap keep the unique 21-joint hierarchy and weight coverage", async () => {
  for (const basename of [HIGH_BASENAME, BOOTSTRAP_BASENAME]) {
    assertRigAndWeights(await loadVariant(basename));
  }
});

test("M1 Police high and bootstrap ship the exact five moving gameplay clips", async () => {
  for (const basename of [HIGH_BASENAME, BOOTSTRAP_BASENAME]) {
    assertGameplayClips(await loadVariant(basename));
  }
});

test("M1 Police high and bootstrap use Meshopt plus embedded KTX2 within budget", async () => {
  const [high, bootstrap] = await Promise.all([
    loadVariant(HIGH_BASENAME),
    loadVariant(BOOTSTRAP_BASENAME),
  ]);
  assertMeshoptKtx2(high);
  assertMeshoptKtx2(bootstrap);
  assert.ok(high.buffer.length <= HIGH_MAX_BYTES, `Police high grew to ${high.buffer.length} bytes`);
  assert.ok(
    bootstrap.buffer.length <= BOOTSTRAP_MAX_BYTES,
    `Police bootstrap grew to ${bootstrap.buffer.length} bytes`,
  );
  for (const asset of [high, bootstrap]) {
    const triangles = triangleCount(asset);
    assert.ok(
      triangles >= MIN_TRIANGLES && triangles <= MAX_TRIANGLES,
      `${asset.filename} has ${triangles} triangles; expected ${MIN_TRIANGLES}-${MAX_TRIANGLES}`,
    );
  }
});

test("M1 Police decoded PBR surfaces retain authored tonal, normal and AO detail", async () => {
  for (const basename of [HIGH_BASENAME, BOOTSTRAP_BASENAME]) {
    const asset = await loadVariant(basename);
    const textures = await decodedTextureQuality(asset);
    const categoryCounts = { baseColor: 0, normal: 0, orm: 0 };
    for (const texture of textures) {
      if (texture.name.includes("BaseColor") || texture.name === "young_lightskinned_male_diffuse2") {
        categoryCounts.baseColor += 1;
        assert.ok(
          texture.statistics.stddev >= 8,
          `${basename}/${texture.name} BaseColor stddev ${texture.statistics.stddev} is flat`,
        );
      } else if (texture.name.includes("Normal")) {
        categoryCounts.normal += 1;
        assert.ok(
          texture.statistics.stddev >= 4,
          `${basename}/${texture.name} Normal stddev ${texture.statistics.stddev} is flat`,
        );
        assert.ok(
          texture.statistics.channelStddev[0] >= 4
            && texture.statistics.channelStddev[1] >= 4,
          `${basename}/${texture.name} tangent R/G detail regressed`,
        );
      } else if (texture.name.includes("ORM")) {
        categoryCounts.orm += 1;
        assert.ok(
          texture.statistics.channelStddev[0] >= 3,
          `${basename}/${texture.name} AO(R) stddev ${texture.statistics.channelStddev[0]} is flat`,
        );
      }
    }
    assert.ok(categoryCounts.baseColor > 0, `${basename} exposes no decoded BaseColor texture gate`);
    assert.ok(categoryCounts.normal > 0, `${basename} exposes no decoded Normal texture gate`);
    assert.ok(categoryCounts.orm > 0, `${basename} exposes no decoded ORM texture gate`);
  }
});

test("M1 Police authoring pipeline treats texture stddev as a hard failure", () => {
  assert.match(PBR_PIPELINE_SOURCE, /failed_texture_gates = \[/);
  assert.match(
    PBR_PIPELINE_SOURCE,
    /if failed_texture_gates:[\s\S]*raise RuntimeError\([\s\S]*Generated texture stddev gate failed/,
  );
});

test("M1 Police authoring validation GLB cannot leak into art-source", () => {
  assert.match(A2_PIPELINE_SOURCE, /Path\(tempfile\.gettempdir\(\)\)/);
  assert.doesNotMatch(
    A2_PIPELINE_SOURCE,
    /DEFAULT_AUTHORING_GLB\s*=\s*A2_ROOT/u,
  );
  assert.match(
    A2_PIPELINE_SOURCE,
    /if output_glb == DEFAULT_AUTHORING_GLB\.resolve\(\):\s*\n\s*output_glb\.unlink\(missing_ok=True\)/u,
  );
});

test("M1 Police animation candidate provenance stays ephemeral and host-neutral", () => {
  assert.doesNotMatch(POLICE_ANIMATION_WRAPPER_SOURCE, /animation_builder\.ROOT\s*=/u);
  assert.match(
    POLICE_ANIMATION_WRAPPER_SOURCE,
    /result\["sourceBlend"\]\s*=\s*animation_builder\.display_path\(source_blend\)/u,
  );
  assert.equal(POLICE_ANIMATION_REPORT.outputAtBuildTime.ephemeral, true);
  assert.equal(
    POLICE_ANIMATION_REPORT.outputAtBuildTime.path,
    "police-a2-animated-prepbr.glb",
  );
  assert.equal(path.isAbsolute(POLICE_ANIMATION_REPORT.sourceBlend), false);
});

test("M1 Police PBR report contains no host-specific temporary paths", () => {
  assert.equal(path.isAbsolute(POLICE_PBR_REPORT.input), false);
  assert.equal(path.isAbsolute(POLICE_PBR_REPORT.output), false);
  for (const evidence of Object.values(POLICE_PBR_REPORT.generatedTextureQuality)) {
    assert.equal(path.isAbsolute(evidence.path), false);
  }
});

test("M1 Police bootstrap changes image payloads only", async () => {
  const [high, bootstrap] = await Promise.all([
    loadVariant(HIGH_BASENAME),
    loadVariant(BOOTSTRAP_BASENAME),
  ]);
  assert.equal(triangleCount(bootstrap), triangleCount(high));
  assert.deepEqual(geometryContract(bootstrap), geometryContract(high));
  assert.deepEqual(animationContract(bootstrap), animationContract(high));
  assert.deepEqual(nonImageTransport(bootstrap), nonImageTransport(high));
  assert.deepEqual(semanticContract(bootstrap), semanticContract(high));
  for (const animation of high.json.animations) {
    const bootstrapAnimation = bootstrap.json.animations.find(({ name }) => name === animation.name);
    assert.ok(bootstrapAnimation, `${BOOTSTRAP_BASENAME} lost ${animation.name}`);
    assert.ok(
      Math.abs(animationDuration(high, animation) - animationDuration(bootstrap, bootstrapAnimation)) < 1e-6,
      `${animation.name} duration changed in bootstrap transport`,
    );
  }
});

test("M1 Police remains a high-to-bootstrap lazy actor with no accidental lod1", async () => {
  assert.equal(
    Object.hasOwn(CHARACTER_LOD_CONTRACTS, "police"),
    false,
    "Police must not enter the Kid/Villain lod1 pipeline",
  );
  await assert.rejects(
    readFile(path.join(CHARACTER_DIRECTORY, LOD1_BASENAME)),
    (error) => error?.code === "ENOENT",
    `${LOD1_BASENAME} must not be deployed`,
  );
  assert.equal(CHARACTER_BOOTSTRAP_CONTRACTS.police.referenceVariant, "original");
  assert.deepEqual([...CHARACTER_BOOTSTRAP_CONTRACTS.police.clips].sort(), CLIP_NAMES);
  assert.equal(CHARACTER_BOOTSTRAP_CONTRACTS.police.maxBytes, BOOTSTRAP_MAX_BYTES);

  const [report, high, bootstrap] = await Promise.all([
    readFile(BOOTSTRAP_REPORT, "utf8").then(JSON.parse),
    loadVariant(HIGH_BASENAME),
    loadVariant(BOOTSTRAP_BASENAME),
  ]);
  const entry = report.characters.find(({ role }) => role === "police");
  assert.ok(entry, "character-bootstrap report is missing Police");
  assert.equal(entry.reference.variant, "original");
  assert.equal(entry.reference.path, `public/models/characters/${HIGH_BASENAME}`);
  assert.equal(entry.reference.bytes, high.buffer.length);
  assert.equal(entry.reference.sha256, sha256(high.buffer));
  assert.equal(entry.reference.triangles, triangleCount(high));
  assert.equal(entry.bootstrap.path, `public/models/characters/${BOOTSTRAP_BASENAME}`);
  assert.equal(entry.bootstrap.bytes, bootstrap.buffer.length);
  assert.equal(entry.bootstrap.sha256, sha256(bootstrap.buffer));
  assert.equal(entry.bootstrap.triangles, triangleCount(bootstrap));
  assert.deepEqual(entry.quality.clips, CLIP_NAMES);
});

test("M1 Police runtime requires every aliased gameplay clip, including Alert", async () => {
  const source = await readFile(APP_SOURCE, "utf8");
  const actorSpecsStart = source.indexOf("const ACTOR_SPECS");
  const actorSpecsEnd = source.indexOf("const STRUCTURE_ASSETS", actorSpecsStart);
  assert.ok(actorSpecsStart >= 0 && actorSpecsEnd > actorSpecsStart, "cannot locate ACTOR_SPECS");
  const actorSpecs = source.slice(actorSpecsStart, actorSpecsEnd);
  const policeSpec = actorSpecs.match(
    /police:\s*\{[\s\S]*?aliases:\s*\{([\s\S]*?)\},[\s\S]*?required:\s*\[([^\]]+)\]\s*as AnimationState\[\],[\s\S]*?\n\s*\},/u,
  );
  assert.ok(policeSpec, "cannot locate ACTOR_SPECS.police required clip contract");
  const aliases = Object.fromEntries(
    [...policeSpec[1].matchAll(/(\w+):\s*"([^"]+)"/gu)]
      .map((match) => [match[1], match[2]]),
  );
  assert.deepEqual(aliases, {
    idle: "Idle",
    run: "Run",
    point: "Interact",
    protect: "Resolve",
    alert: "Alert",
  });
  const requiredAliases = [...policeSpec[2].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(
    [...requiredAliases].sort(),
    ["alert", "idle", "point", "protect", "run"],
    "Police required aliases must cover all five deployed clips",
  );
});
