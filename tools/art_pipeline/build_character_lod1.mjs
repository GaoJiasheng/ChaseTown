#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CHARACTER_DIRECTORY = path.join(
  ROOT,
  "public",
  "models",
  "characters",
);
export const DEFAULT_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "character-lod1.json",
);
export const FORMAT_VERSION = 1;

export const GLTFPACK_ARGUMENTS = Object.freeze([
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-si",
  "0.65",
  "-se",
  "0.002",
  "-tu",
  "-tq",
  "9",
  "-ts",
  "0.75",
  "-tj",
  "4",
  "-af",
  "0",
  "-at",
  "24",
  "-ar",
  "16",
  "-as",
  "24",
]);

export const CHARACTER_LOD_CONTRACTS = Object.freeze({
  kid: Object.freeze({
    clips: Object.freeze([
      "Caught",
      "EscapeCelebrate",
      "HideEnter",
      "HideExit",
      "HideIdle",
      "HidePeek",
      "Idle",
      "Interact",
      "Run",
      "TurnLeft",
      "TurnRight",
      "Walk",
    ]),
    maxBytes: 3_050_000,
    minimumTriangleRatio: 0.64,
    maximumTriangleRatio: 0.69,
  }),
  villain: Object.freeze({
    clips: Object.freeze([
      "Alert",
      "Catch",
      "CheckHide",
      "Idle",
      "LostSight",
      "PatrolWalk",
      "Run",
      "Search",
    ]),
    maxBytes: 2_700_000,
    minimumTriangleRatio: 0.63,
    maximumTriangleRatio: 0.68,
  }),
});

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

function parseArguments(argv) {
  const options = {
    check: false,
    sourceDirectory: DEFAULT_CHARACTER_DIRECTORY,
    outputDirectory: DEFAULT_CHARACTER_DIRECTORY,
    report: DEFAULT_REPORT,
    gltfpack: process.env.GLTFPACK_NATIVE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} needs a value`);
    if (argument === "--source-dir") options.sourceDirectory = path.resolve(value);
    else if (argument === "--output-dir") options.outputDirectory = path.resolve(value);
    else if (argument === "--report") options.report = path.resolve(value);
    else if (argument === "--gltfpack") options.gltfpack = path.resolve(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return options;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function round(value, digits = 8) {
  return Number(value.toFixed(digits));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function readGlb(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
  assert.equal(buffer.readUInt32LE(4), 2, `${filename} must use glTF 2.0`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} declares the wrong size`);
  let json;
  let binary;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const content = buffer.subarray(offset + 8, offset + 8 + length);
    assert.equal(content.length, length, `${filename} contains a truncated GLB chunk`);
    if (type === 0x4e4f534a) {
      json = JSON.parse(content.toString("utf8").replace(/[\0 ]+$/u, "").trim());
    } else if (type === 0x004e4942) {
      binary = content;
    }
    offset += 8 + length;
  }
  assert.ok(json && binary, `${filename} must contain JSON and BIN chunks`);
  return { filename, buffer, json, binary, decodedViews: new Map() };
}

async function loadGlb(filename) {
  return readGlb(await readFile(filename), filename);
}

function hasMeshopt(asset) {
  return Boolean(
    asset.json.extensionsRequired?.includes("EXT_meshopt_compression")
      && asset.json.bufferViews?.some((view) => view.extensions?.EXT_meshopt_compression),
  );
}

async function decodeMeshopt(asset) {
  const compressed = (asset.json.bufferViews ?? [])
    .map((view, index) => ({ index, compression: view.extensions?.EXT_meshopt_compression }))
    .filter(({ compression }) => compression);
  if (!compressed.length) return asset;
  await MeshoptDecoder.ready;
  assert.equal(MeshoptDecoder.supported, true, "The pinned Meshopt decoder is unavailable");
  for (const { index, compression } of compressed) {
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

function accessorRows(asset, accessorIndex) {
  const accessor = asset.json.accessors[accessorIndex];
  assert.equal(accessor.sparse, undefined, `${asset.filename} cannot use sparse LOD accessors`);
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
  const rows = [];
  for (let item = 0; item < accessor.count; item += 1) {
    const row = [];
    for (let component = 0; component < components; component += 1) {
      const offset = start + item * stride + component * componentBytes;
      const value = bytes[reader](offset);
      row.push(accessor.normalized ? normalize(value) : value);
    }
    rows.push(row);
  }
  return rows;
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

function localNodeMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
    new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
  );
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
  assert.equal(bounds.isEmpty(), false, `${asset.filename} has no rendered bounds`);
  return bounds;
}

function maximumArrayDelta(left, right) {
  assert.equal(left.length, right.length);
  return Math.max(...left.map((value, index) => Math.abs(value - right[index])));
}

function animationDuration(asset, animation) {
  return Math.max(...animation.samplers.map((sampler) => {
    const input = asset.json.accessors[sampler.input];
    return input.max?.[0] ?? Math.max(...accessorRows(asset, sampler.input).map(([time]) => time));
  }));
}

function animationTracks(asset, animation) {
  const tracks = new Map();
  for (const channel of animation.channels) {
    const node = asset.json.nodes[channel.target.node];
    const sampler = animation.samplers[channel.sampler];
    assert.ok(node.name, `${asset.filename}/${animation.name} targets an unnamed node`);
    tracks.set(`${node.name}|${channel.target.path}`, {
      interpolation: sampler.interpolation ?? "LINEAR",
      times: accessorRows(asset, sampler.input).map(([time]) => time),
      values: accessorRows(asset, sampler.output),
    });
  }
  return tracks;
}

function quaternionFromArray(value) {
  return new THREE.Quaternion(...value).normalize();
}

function sampleTrack(track, time, fallback, pathName) {
  if (!track) return fallback;
  let lower = 0;
  while (lower + 1 < track.times.length && track.times[lower + 1] <= time + 1e-8) {
    lower += 1;
  }
  if (lower + 1 >= track.times.length || track.interpolation === "STEP") {
    return track.values[lower];
  }
  assert.equal(track.interpolation, "LINEAR", "CUBICSPLINE needs an explicit LOD sampler");
  const upper = lower + 1;
  const amount = THREE.MathUtils.clamp(
    (time - track.times[lower]) / (track.times[upper] - track.times[lower]),
    0,
    1,
  );
  if (pathName === "rotation") {
    return quaternionFromArray(track.values[lower])
      .slerp(quaternionFromArray(track.values[upper]), amount)
      .toArray();
  }
  return track.values[lower].map((value, index) => (
    THREE.MathUtils.lerp(value, track.values[upper][index], amount)
  ));
}

function nodeDefault(node, pathName) {
  if (pathName === "rotation") return node.rotation ?? [0, 0, 0, 1];
  if (pathName === "translation") return node.translation ?? [0, 0, 0];
  if (pathName === "scale") return node.scale ?? [1, 1, 1];
  throw new Error(`Unsupported animation target: ${pathName}`);
}

function animationMotion(asset, animation) {
  let rotationTravelDegrees = 0;
  let translationTravelMeters = 0;
  let scaleTravel = 0;
  let animatedJointChannels = 0;
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler];
    const values = accessorRows(asset, sampler.output);
    if (channel.target.path === "rotation") {
      animatedJointChannels += 1;
      for (let index = 1; index < values.length; index += 1) {
        rotationTravelDegrees += THREE.MathUtils.radToDeg(
          quaternionFromArray(values[index - 1]).angleTo(quaternionFromArray(values[index])),
        );
      }
    } else {
      for (let index = 1; index < values.length; index += 1) {
        const distance = Math.hypot(
          ...values[index].map((value, component) => value - values[index - 1][component]),
        );
        if (channel.target.path === "translation") translationTravelMeters += distance;
        else if (channel.target.path === "scale") scaleTravel += distance;
      }
    }
  }
  return {
    animatedJointChannels,
    rotationTravelDegrees: round(rotationTravelDegrees, 5),
    translationTravelMeters: round(translationTravelMeters, 7),
    scaleTravel: round(scaleTravel, 7),
  };
}

function animationDeviation(source, lod) {
  let maxRotationDegrees = 0;
  let maxTranslationMeters = 0;
  let maxScaleDelta = 0;
  for (const sourceAnimation of source.json.animations ?? []) {
    const lodAnimation = lod.json.animations.find(
      (animation) => animation.name === sourceAnimation.name,
    );
    assert.ok(lodAnimation, `${lod.filename} lost ${sourceAnimation.name}`);
    const sourceTracks = animationTracks(source, sourceAnimation);
    const lodTracks = animationTracks(lod, lodAnimation);
    for (const key of new Set([...sourceTracks.keys(), ...lodTracks.keys()])) {
      const separator = key.lastIndexOf("|");
      const nodeName = key.slice(0, separator);
      const pathName = key.slice(separator + 1);
      const sourceNode = source.json.nodes.find((node) => node.name === nodeName);
      const lodNode = lod.json.nodes.find((node) => node.name === nodeName);
      assert.ok(sourceNode && lodNode, `${lod.filename} lost animated node ${nodeName}`);
      const sourceTrack = sourceTracks.get(key);
      const lodTrack = lodTracks.get(key);
      const times = sortedUnique([...(sourceTrack?.times ?? []), ...(lodTrack?.times ?? [])]);
      for (const time of times) {
        const left = sampleTrack(
          sourceTrack,
          time,
          nodeDefault(sourceNode, pathName),
          pathName,
        );
        const right = sampleTrack(
          lodTrack,
          time,
          nodeDefault(lodNode, pathName),
          pathName,
        );
        if (pathName === "rotation") {
          maxRotationDegrees = Math.max(
            maxRotationDegrees,
            THREE.MathUtils.radToDeg(
              quaternionFromArray(left).angleTo(quaternionFromArray(right)),
            ),
          );
        } else {
          const delta = Math.hypot(
            ...left.map((value, index) => value - right[index]),
          );
          if (pathName === "translation") {
            maxTranslationMeters = Math.max(maxTranslationMeters, delta);
          } else {
            maxScaleDelta = Math.max(maxScaleDelta, delta);
          }
        }
      }
    }
  }
  return {
    maxRotationDegrees: round(maxRotationDegrees, 7),
    maxTranslationMeters: round(maxTranslationMeters, 9),
    maxScaleDelta: round(maxScaleDelta, 9),
  };
}

function ktx2Metadata(payload, label) {
  assert.equal(
    payload.subarray(0, 12).toString("hex"),
    "ab4b5458203230bb0d0a1a0a",
    `${label} is not a KTX2 payload`,
  );
  assert.ok(payload.length >= 48, `${label} has a truncated KTX2 header`);
  return {
    width: payload.readUInt32LE(20),
    height: payload.readUInt32LE(24),
    levels: payload.readUInt32LE(40),
  };
}

function embeddedTextures(asset) {
  return (asset.json.images ?? []).map((image, index) => {
    assert.equal(image.uri, undefined, `${asset.filename} texture ${index} must stay embedded`);
    assert.equal(image.mimeType, "image/ktx2", `${asset.filename} texture ${index} must use KTX2`);
    const view = asset.json.bufferViews[image.bufferView];
    assert.equal(
      view.extensions?.EXT_meshopt_compression,
      undefined,
      `${asset.filename} texture ${index} cannot be Meshopt filtered`,
    );
    const payload = asset.binary.subarray(
      view.byteOffset ?? 0,
      (view.byteOffset ?? 0) + view.byteLength,
    );
    return {
      name: image.name,
      bytes: payload.length,
      sha256: sha256(payload),
      ...ktx2Metadata(payload, `${asset.filename}/${image.name ?? index}`),
    };
  });
}

function skinJointNames(asset) {
  return (asset.json.skins ?? []).map((skin) => (
    skin.joints.map((nodeIndex) => asset.json.nodes[nodeIndex].name)
  ));
}

function animationSummary(asset) {
  return Object.fromEntries(
    [...(asset.json.animations ?? [])]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((animation) => [
        animation.name,
        {
          durationSeconds: round(animationDuration(asset, animation), 7),
          ...animationMotion(asset, animation),
        },
      ]),
  );
}

export async function auditLodPair(role, sourceFilename, lodFilename) {
  const contract = CHARACTER_LOD_CONTRACTS[role];
  assert.ok(contract, `No LOD contract exists for ${role}`);
  const [source, lod] = await Promise.all([
    loadGlb(sourceFilename),
    loadGlb(lodFilename),
  ]);
  await Promise.all([decodeMeshopt(source), decodeMeshopt(lod)]);

  assert.ok(hasMeshopt(source), `${sourceFilename} must be the shipped Meshopt high model`);
  assert.ok(hasMeshopt(lod), `${lodFilename} must require Meshopt`);
  assert.ok(
    source.json.extensionsRequired?.includes("KHR_texture_basisu"),
    `${sourceFilename} must be the shipped KTX2 high model`,
  );
  assert.ok(
    lod.json.extensionsRequired?.includes("KHR_texture_basisu"),
    `${lodFilename} must retain KHR_texture_basisu`,
  );
  assert.ok(
    lod.json.extensionsRequired?.includes("KHR_mesh_quantization"),
    `${lodFilename} must use the approved LOD geometry quantization`,
  );

  const sourceNamedNodes = sortedUnique(
    source.json.nodes.map((node) => node.name).filter(Boolean),
  );
  const lodNamedNodes = sortedUnique(
    lod.json.nodes.map((node) => node.name).filter(Boolean),
  );
  assert.deepEqual(lodNamedNodes, sourceNamedNodes, `${lodFilename} changed the named-node contract`);
  assert.deepEqual(
    skinJointNames(lod),
    skinJointNames(source),
    `${lodFilename} changed the approved skeleton`,
  );
  assert.equal(lod.json.skins?.[0]?.joints?.length, 21, `${lodFilename} must retain 21 joints`);

  const sourceMaterials = sortedUnique(
    (source.json.materials ?? []).map((material) => material.name),
  );
  const lodMaterials = sortedUnique(
    (lod.json.materials ?? []).map((material) => material.name),
  );
  assert.deepEqual(lodMaterials, sourceMaterials, `${lodFilename} changed material identities`);

  const sourceClips = sortedUnique(
    (source.json.animations ?? []).map((animation) => animation.name),
  );
  const lodClips = sortedUnique(
    (lod.json.animations ?? []).map((animation) => animation.name),
  );
  assert.deepEqual(sourceClips, [...contract.clips].sort(), `${sourceFilename} clip contract drifted`);
  assert.deepEqual(lodClips, [...contract.clips].sort(), `${lodFilename} lost an animation clip`);

  const sourceAnimations = animationSummary(source);
  const lodAnimations = animationSummary(lod);
  for (const clip of contract.clips) {
    assert.ok(
      Math.abs(
        sourceAnimations[clip].durationSeconds - lodAnimations[clip].durationSeconds,
      ) <= 1e-6,
      `${lodFilename}/${clip} duration drifted`,
    );
    assert.ok(
      lodAnimations[clip].animatedJointChannels >= 20,
      `${lodFilename}/${clip} no longer animates the complete body`,
    );
    const sourceTravel = sourceAnimations[clip].rotationTravelDegrees;
    const lodTravel = lodAnimations[clip].rotationTravelDegrees;
    assert.ok(sourceTravel > 1, `${sourceFilename}/${clip} is effectively static`);
    assert.ok(
      lodTravel >= sourceTravel * 0.985 && lodTravel <= sourceTravel * 1.015,
      `${lodFilename}/${clip} changed rotational performance amplitude`,
    );
  }

  const sourceTextures = embeddedTextures(source);
  const lodTextures = embeddedTextures(lod);
  assert.deepEqual(
    lodTextures,
    sourceTextures,
    `${lodFilename} must preserve byte-identical high-quality KTX2 surfaces`,
  );

  const sourceTriangles = triangleCount(source);
  const lodTriangles = triangleCount(lod);
  const triangleRatio = lodTriangles / sourceTriangles;
  assert.ok(
    triangleRatio >= contract.minimumTriangleRatio
      && triangleRatio <= contract.maximumTriangleRatio,
    `${lodFilename} triangle ratio ${triangleRatio} is outside the reviewed LOD envelope`,
  );

  const sourceBounds = sceneBounds(source);
  const lodBounds = sceneBounds(lod);
  const boundsMaxDeltaMeters = Math.max(
    maximumArrayDelta(sourceBounds.min.toArray(), lodBounds.min.toArray()),
    maximumArrayDelta(sourceBounds.max.toArray(), lodBounds.max.toArray()),
  );
  assert.ok(
    boundsMaxDeltaMeters <= 0.0015,
    `${lodFilename} changed its silhouette bounds by ${boundsMaxDeltaMeters} m`,
  );

  const deviation = animationDeviation(source, lod);
  assert.ok(
    deviation.maxRotationDegrees <= 0.01,
    `${lodFilename} animation rotation drifted ${deviation.maxRotationDegrees}°`,
  );
  assert.ok(
    deviation.maxTranslationMeters <= 0.00001,
    `${lodFilename} animation translation drifted ${deviation.maxTranslationMeters} m`,
  );
  assert.ok(
    deviation.maxScaleDelta <= 0.00001,
    `${lodFilename} animation scale drifted ${deviation.maxScaleDelta}`,
  );

  const sourceBytes = source.buffer.length;
  const lodBytes = lod.buffer.length;
  const savedBytes = sourceBytes - lodBytes;
  const savedPercent = (1 - lodBytes / sourceBytes) * 100;
  assert.ok(lodBytes <= contract.maxBytes, `${lodFilename} exceeds ${contract.maxBytes} bytes`);
  assert.ok(savedPercent >= 30, `${lodFilename} saves only ${savedPercent}%`);

  return {
    role,
    source: {
      path: path.relative(ROOT, sourceFilename),
      bytes: sourceBytes,
      sha256: sha256(source.buffer),
      triangles: sourceTriangles,
    },
    lod: {
      path: path.relative(ROOT, lodFilename),
      bytes: lodBytes,
      sha256: sha256(lod.buffer),
      savedBytes,
      savedPercent: round(savedPercent, 3),
      triangles: lodTriangles,
      triangleRatio: round(triangleRatio, 6),
    },
    quality: {
      namedNodes: sourceNamedNodes.length,
      joints: skinJointNames(lod)[0].length,
      materials: sourceMaterials,
      textures: sourceTextures,
      clips: lodClips,
      animations: lodAnimations,
      boundsMaxDeltaMeters: round(boundsMaxDeltaMeters, 9),
      animationDeviation: deviation,
    },
  };
}

function reportFor(entries, toolVersion, generatedAt) {
  const sourceBytes = entries.reduce((total, entry) => total + entry.source.bytes, 0);
  const lodBytes = entries.reduce((total, entry) => total + entry.lod.bytes, 0);
  return {
    formatVersion: FORMAT_VERSION,
    generatedAt,
    policy: {
      derivativeOnly: true,
      sourceAssetsUnmodified: true,
      intendedUse: "First-frame and constrained-device render; retain the high model for later promotion.",
      targetTriangleRatio: 0.65,
      maximumSimplificationError: 0.002,
      geometryQuantization: true,
      animationResampling: false,
      textures: "Byte-identical embedded KTX2 surfaces retained from the approved high model.",
    },
    tool: {
      name: "gltfpack",
      version: toolVersion,
      arguments: GLTFPACK_ARGUMENTS,
    },
    budgets: Object.fromEntries(
      Object.entries(CHARACTER_LOD_CONTRACTS).map(([role, contract]) => [
        role,
        {
          maxBytes: contract.maxBytes,
          minimumTriangleRatio: contract.minimumTriangleRatio,
          maximumTriangleRatio: contract.maximumTriangleRatio,
        },
      ]),
    ),
    totals: {
      sourceBytes,
      lodBytes,
      savedBytes: sourceBytes - lodBytes,
      savedPercent: round((1 - lodBytes / sourceBytes) * 100, 3),
    },
    characters: entries,
  };
}

async function readReport(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

async function resolveGltfpack(explicit) {
  const candidates = [
    explicit,
    "/private/tmp/gltfpack-macos-v1.2/gltfpack",
    "/opt/homebrew/bin/gltfpack",
    path.join(ROOT, "node_modules", ".bin", "gltfpack"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const version = spawnSync(candidate, ["-v"], { encoding: "utf8" });
      if (version.status === 0) {
        return { executable: candidate, version: version.stdout.trim() };
      }
    } catch {
      // Try the next known installation. --check never needs the encoder.
    }
  }
  throw new Error(
    "A gltfpack 1.2 native binary is required. Pass --gltfpack or GLTFPACK_NATIVE.",
  );
}

async function auditShipped(options) {
  const existing = await readReport(options.report);
  assert.equal(existing.formatVersion, FORMAT_VERSION);
  assert.deepEqual(existing.tool.arguments, GLTFPACK_ARGUMENTS);
  const entries = [];
  for (const role of Object.keys(CHARACTER_LOD_CONTRACTS)) {
    entries.push(await auditLodPair(
      role,
      path.join(options.sourceDirectory, `${role}.glb`),
      path.join(options.outputDirectory, `${role}-lod1.glb`),
    ));
  }
  const current = reportFor(entries, existing.tool.version, existing.generatedAt);
  assert.deepEqual(current, existing, `${options.report} does not match the shipped LOD assets`);
  return current;
}

async function build(options) {
  const encoder = await resolveGltfpack(options.gltfpack);
  assert.match(encoder.version, /^gltfpack 1\.2(?:\b|$)/u, "LOD output requires gltfpack 1.2");
  await mkdir(options.outputDirectory, { recursive: true });
  await mkdir(path.dirname(options.report), { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(tmpdir(), "chasing-character-lod1-"));
  const staged = [];
  try {
    for (const role of Object.keys(CHARACTER_LOD_CONTRACTS)) {
      const sourceFilename = path.join(options.sourceDirectory, `${role}.glb`);
      const stagedFilename = path.join(stagingDirectory, `${role}-lod1.glb`);
      const result = spawnSync(
        encoder.executable,
        ["-i", sourceFilename, "-o", stagedFilename, ...GLTFPACK_ARGUMENTS],
        { cwd: ROOT, encoding: "utf8" },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `gltfpack failed for ${role}`);
      }
      const entry = await auditLodPair(role, sourceFilename, stagedFilename);
      const outputFilename = path.join(options.outputDirectory, `${role}-lod1.glb`);
      entry.lod.path = path.relative(ROOT, outputFilename);
      staged.push({
        role,
        entry,
        stagedFilename,
        outputFilename,
      });
    }
    const report = reportFor(
      staged.map(({ entry }) => entry),
      encoder.version,
      new Date().toISOString(),
    );
    assert.ok(report.totals.lodBytes <= 5_750_000, "Combined first-frame actors exceed 5.75 MB");
    assert.ok(report.totals.savedPercent >= 35, "Combined first-frame actors save under 35%");

    const stagedReport = path.join(stagingDirectory, "character-lod1.json");
    await writeFile(stagedReport, `${JSON.stringify(report, null, 2)}\n`);
    for (const asset of staged) {
      await rename(asset.stagedFilename, asset.outputFilename);
    }
    await rename(stagedReport, options.report);
    return report;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = options.check ? await auditShipped(options) : await build(options);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
