#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CHARACTER_DIRECTORY = path.join(ROOT, "public", "models", "characters");
const DEFAULT_REPORT = path.join(
  ROOT,
  "docs",
  "art_production",
  "reports",
  "character-runtime-meshopt.json",
);
const GLTFPACK = path.join(ROOT, "node_modules", ".bin", "gltfpack");
const ROLES = ["kid", "villain", "police"];
const FORMAT_VERSION = 1;

// Deliberately do not quantize authored vertex attributes. Meshopt changes the
// transport representation only; silhouettes, UVs, normals, skin weights and
// material response retain their source floating-point precision. Animation
// sampling is retained, while constant channels may be removed losslessly.
export const GLTFPACK_ARGUMENTS = Object.freeze([
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-noq",
  "-af",
  "0",
  "-at",
  "24",
  "-ar",
  "16",
  "-as",
  "24",
]);

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
  const result = {
    sourceDirectory: DEFAULT_CHARACTER_DIRECTORY,
    outputDirectory: DEFAULT_CHARACTER_DIRECTORY,
    report: DEFAULT_REPORT,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      result.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} needs a value`);
    if (argument === "--source-dir") result.sourceDirectory = path.resolve(value);
    else if (argument === "--output-dir") result.outputDirectory = path.resolve(value);
    else if (argument === "--report") result.report = path.resolve(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return result;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function readGlb(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
  assert.equal(buffer.readUInt32LE(4), 2, `${filename} must use glTF 2.0`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} declares the wrong byte length`);
  let json;
  let binary;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const content = buffer.subarray(offset + 8, offset + 8 + length);
    assert.equal(content.length, length, `${filename} has a truncated GLB chunk`);
    if (type === 0x4e4f534a) {
      json = JSON.parse(content.toString("utf8").replace(/[\0 ]+$/u, "").trim());
    }
    if (type === 0x004e4942) binary = content;
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
  assert.equal(MeshoptDecoder.supported, true, "The pinned Three.js Meshopt decoder is unavailable");
  for (const { index, compression } of compressed) {
    const target = new Uint8Array(compression.count * compression.byteStride);
    const source = new Uint8Array(
      asset.binary.buffer,
      asset.binary.byteOffset + (compression.byteOffset ?? 0),
      compression.byteLength,
    );
    MeshoptDecoder.decodeGltfBuffer(
      target,
      compression.count,
      compression.byteStride,
      source,
      compression.mode,
      compression.filter,
    );
    asset.decodedViews.set(
      index,
      Buffer.from(target.buffer, target.byteOffset, target.byteLength),
    );
  }
  return asset;
}

function accessorRows(asset, accessorIndex) {
  const accessor = asset.json.accessors[accessorIndex];
  assert.equal(accessor.sparse, undefined, `${asset.filename} cannot use sparse runtime accessors`);
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

function normalizeQuaternion(value) {
  if (value.length !== 4) return value;
  const length = Math.hypot(...value);
  return value.map((component) => component / length);
}

function animationTracks(asset, animation) {
  const tracks = new Map();
  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler];
    const node = asset.json.nodes[channel.target.node];
    assert.ok(node.name, `${asset.filename}/${animation.name} targets an unnamed node`);
    tracks.set(`${node.name}|${channel.target.path}`, {
      interpolation: sampler.interpolation ?? "LINEAR",
      times: accessorRows(asset, sampler.input).map(([time]) => time),
      values: accessorRows(asset, sampler.output),
    });
  }
  return tracks;
}

function sampleTrack(track, time, fallback) {
  if (!track) return normalizeQuaternion(fallback);
  let lower = 0;
  while (lower + 1 < track.times.length && track.times[lower + 1] <= time + 1e-8) {
    lower += 1;
  }
  if (lower + 1 >= track.times.length || track.interpolation === "STEP") {
    return normalizeQuaternion(track.values[lower]);
  }
  assert.equal(track.interpolation, "LINEAR", "CUBICSPLINE character tracks require an explicit sampler");
  const upper = lower + 1;
  const mix = THREE.MathUtils.clamp(
    (time - track.times[lower]) / (track.times[upper] - track.times[lower]),
    0,
    1,
  );
  return normalizeQuaternion(
    track.values[lower].map((value, index) => (
      THREE.MathUtils.lerp(value, track.values[upper][index], mix)
    )),
  );
}

function nodeDefault(node, pathName) {
  if (pathName === "rotation") return node.rotation ?? [0, 0, 0, 1];
  if (pathName === "translation") return node.translation ?? [0, 0, 0];
  if (pathName === "scale") return node.scale ?? [1, 1, 1];
  throw new Error(`Unsupported animation path: ${pathName}`);
}

function animationDeviation(source, optimized) {
  let maxRotationDegrees = 0;
  let maxTranslationMeters = 0;
  let maxScaleDelta = 0;
  for (const sourceAnimation of source.json.animations ?? []) {
    const optimizedAnimation = optimized.json.animations.find(
      (animation) => animation.name === sourceAnimation.name,
    );
    assert.ok(optimizedAnimation, `${optimized.filename} lost ${sourceAnimation.name}`);
    const sourceTracks = animationTracks(source, sourceAnimation);
    const optimizedTracks = animationTracks(optimized, optimizedAnimation);
    for (const key of new Set([...sourceTracks.keys(), ...optimizedTracks.keys()])) {
      const separator = key.lastIndexOf("|");
      const nodeName = key.slice(0, separator);
      const pathName = key.slice(separator + 1);
      const sourceNode = source.json.nodes.find((node) => node.name === nodeName);
      const optimizedNode = optimized.json.nodes.find((node) => node.name === nodeName);
      assert.ok(sourceNode && optimizedNode, `${optimized.filename} lost animated node ${nodeName}`);
      const sourceTrack = sourceTracks.get(key);
      const optimizedTrack = optimizedTracks.get(key);
      const times = sourceTrack?.times ?? optimizedTrack.times;
      for (const time of times) {
        const left = sampleTrack(sourceTrack, time, nodeDefault(sourceNode, pathName));
        const right = sampleTrack(optimizedTrack, time, nodeDefault(optimizedNode, pathName));
        if (pathName === "rotation") {
          const dot = Math.min(
            1,
            Math.abs(left.reduce((total, component, index) => (
              total + component * right[index]
            ), 0)),
          );
          maxRotationDegrees = Math.max(
            maxRotationDegrees,
            THREE.MathUtils.radToDeg(2 * Math.acos(dot)),
          );
        } else {
          const delta = Math.hypot(...left.map((value, index) => value - right[index]));
          if (pathName === "translation") {
            maxTranslationMeters = Math.max(maxTranslationMeters, delta);
          } else {
            maxScaleDelta = Math.max(maxScaleDelta, delta);
          }
        }
      }
    }
  }
  return { maxRotationDegrees, maxTranslationMeters, maxScaleDelta };
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
  for (const root of asset.json.scenes[asset.json.scene ?? 0].nodes ?? []) {
    visit(root, new THREE.Matrix4());
  }
  assert.equal(bounds.isEmpty(), false, `${asset.filename} has no renderable bounds`);
  return bounds;
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

function imagePayloads(asset) {
  return (asset.json.images ?? []).map((image) => {
    assert.equal(image.uri, undefined, `${asset.filename} character textures must remain embedded`);
    const view = asset.json.bufferViews[image.bufferView];
    assert.equal(
      view.extensions?.EXT_meshopt_compression,
      undefined,
      `${asset.filename} image data cannot be Meshopt filtered`,
    );
    const payload = asset.binary.subarray(
      view.byteOffset ?? 0,
      (view.byteOffset ?? 0) + view.byteLength,
    );
    return {
      name: image.name,
      mimeType: image.mimeType,
      bytes: payload.length,
      sha256: sha256(payload),
    };
  });
}

function animationDurations(asset) {
  return Object.fromEntries((asset.json.animations ?? []).map((animation) => {
    const duration = Math.max(...animation.samplers.map((sampler) => {
      const input = asset.json.accessors[sampler.input];
      return input.max?.[0] ?? Math.max(...accessorRows(asset, sampler.input).map(([time]) => time));
    }));
    return [animation.name, duration];
  }));
}

function skinJointNames(asset) {
  return (asset.json.skins ?? []).map((skin) => (
    skin.joints.map((nodeIndex) => asset.json.nodes[nodeIndex].name)
  ));
}

function arrayMaximumDelta(left, right) {
  assert.equal(left.length, right.length);
  return Math.max(0, ...left.map((value, index) => Math.abs(value - right[index])));
}

async function validateOptimization(source, optimized) {
  await Promise.all([decodeMeshopt(source), decodeMeshopt(optimized)]);
  assert.equal(hasMeshopt(source), false, `${source.filename} is already Meshopt-compressed; refusing cumulative repacking`);
  assert.equal(hasMeshopt(optimized), true, `${optimized.filename} is missing EXT_meshopt_compression`);
  assert.equal(
    optimized.json.extensionsRequired?.includes("KHR_mesh_quantization"),
    false,
    `${optimized.filename} unexpectedly quantized authored character geometry`,
  );
  assert.deepEqual(
    sortedUnique(source.json.nodes.map((node) => node.name).filter(Boolean)),
    sortedUnique(optimized.json.nodes.map((node) => node.name).filter(Boolean)),
    `${optimized.filename} changed the named-node contract`,
  );
  assert.equal(
    optimized.json.nodes.length,
    source.json.nodes.length,
    `${optimized.filename} changed the authored node count`,
  );
  assert.deepEqual(
    skinJointNames(optimized),
    skinJointNames(source),
    `${optimized.filename} changed the approved skeleton`,
  );
  assert.deepEqual(
    sortedUnique(optimized.json.materials.map((material) => material.name)),
    sortedUnique(source.json.materials.map((material) => material.name)),
    `${optimized.filename} changed the material contract`,
  );
  assert.deepEqual(
    sortedUnique(optimized.json.animations.map((animation) => animation.name)),
    sortedUnique(source.json.animations.map((animation) => animation.name)),
    `${optimized.filename} changed the animation clip contract`,
  );
  const sourceDurations = animationDurations(source);
  const optimizedDurations = animationDurations(optimized);
  for (const [clip, duration] of Object.entries(sourceDurations)) {
    assert.ok(
      Math.abs(duration - optimizedDurations[clip]) <= 1e-6,
      `${optimized.filename}/${clip} duration changed`,
    );
  }
  assert.deepEqual(
    imagePayloads(optimized),
    imagePayloads(source),
    `${optimized.filename} changed embedded texture bytes`,
  );
  const sourceTriangles = triangleCount(source);
  const optimizedTriangles = triangleCount(optimized);
  const removedTriangles = sourceTriangles - optimizedTriangles;
  assert.ok(
    removedTriangles >= 0 && removedTriangles / sourceTriangles <= 0.001,
    `${optimized.filename} changed rendered triangle count by ${removedTriangles}/${sourceTriangles}`,
  );
  const sourceBounds = sceneBounds(source);
  const optimizedBounds = sceneBounds(optimized);
  const boundsMaxDeltaMeters = Math.max(
    arrayMaximumDelta(sourceBounds.min.toArray(), optimizedBounds.min.toArray()),
    arrayMaximumDelta(sourceBounds.max.toArray(), optimizedBounds.max.toArray()),
  );
  assert.ok(
    boundsMaxDeltaMeters <= 1e-7,
    `${optimized.filename} changed scene bounds by ${boundsMaxDeltaMeters} m`,
  );
  const deviation = animationDeviation(source, optimized);
  assert.ok(
    deviation.maxRotationDegrees <= 0.005,
    `${optimized.filename} animation rotation drifted by ${deviation.maxRotationDegrees}°`,
  );
  assert.ok(
    deviation.maxTranslationMeters <= 1e-6,
    `${optimized.filename} animation translation drifted by ${deviation.maxTranslationMeters} m`,
  );
  assert.ok(
    deviation.maxScaleDelta <= 5e-6,
    `${optimized.filename} animation scale drifted by ${deviation.maxScaleDelta}`,
  );
  return {
    namedNodes: sortedUnique(source.json.nodes.map((node) => node.name).filter(Boolean)).length,
    nodes: source.json.nodes.length,
    meshes: source.json.meshes.length,
    materials: source.json.materials.length,
    skins: source.json.skins.length,
    joints: source.json.skins[0].joints.length,
    sourceTriangles,
    optimizedTriangles,
    removedDegenerateTriangles: removedTriangles,
    clips: Object.keys(sourceDurations).sort(),
    clipDurations: Object.fromEntries(
      Object.entries(sourceDurations).sort(([left], [right]) => left.localeCompare(right)),
    ),
    textures: imagePayloads(source),
    boundsMaxDeltaMeters,
    animationDeviation: deviation,
  };
}

async function readExistingReport(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function verifyCurrentAsset(role, filename, reportEntry) {
  const asset = await loadGlb(filename);
  assert.ok(hasMeshopt(asset), `${filename} must be Meshopt-compressed`);
  assert.equal(
    asset.json.extensionsRequired?.includes("KHR_mesh_quantization"),
    false,
    `${filename} must retain authored floating-point geometry`,
  );
  const info = await stat(filename);
  assert.equal(info.size, reportEntry.optimized.bytes, `${role} optimized byte count drifted`);
  assert.equal(sha256(asset.buffer), reportEntry.optimized.sha256, `${role} optimized SHA-256 drifted`);
  assert.ok(
    asset.json.bufferViews.some((view) => view.extensions?.EXT_meshopt_compression),
    `${role} has no compressed Meshopt buffer views`,
  );
  return reportEntry;
}

async function ensureExecutable(filename) {
  await access(filename);
  const version = spawnSync(filename, ["-v"], { cwd: ROOT, encoding: "utf8" });
  if (version.status !== 0) throw new Error(version.stderr || version.stdout || "gltfpack -v failed");
  return version.stdout.trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const existingReport = await readExistingReport(options.report);
  const staged = [];
  const entries = [];
  let toolVersion = existingReport?.tool?.version ?? null;

  for (const role of ROLES) {
    const sourceFilename = path.join(options.sourceDirectory, `${role}.glb`);
    const outputFilename = path.join(options.outputDirectory, `${role}.glb`);
    const source = await loadGlb(sourceFilename);
    if (hasMeshopt(source)) {
      assert.equal(
        path.resolve(sourceFilename),
        path.resolve(outputFilename),
        `${sourceFilename} is compressed and cannot be used as a fresh optimization source`,
      );
      const existingEntry = existingReport?.characters?.find((entry) => entry.role === role);
      assert.ok(existingEntry, `${role} is compressed but ${options.report} has no provenance entry`);
      entries.push(await verifyCurrentAsset(role, outputFilename, existingEntry));
      continue;
    }
    assert.equal(options.check, false, `${sourceFilename} is not optimized`);
    toolVersion ??= await ensureExecutable(GLTFPACK);
    const temporary = path.join(
      options.outputDirectory,
      `.${role}.meshopt-${process.pid}-${Date.now()}.glb`,
    );
    try {
      const result = spawnSync(
        GLTFPACK,
        ["-i", sourceFilename, "-o", temporary, ...GLTFPACK_ARGUMENTS],
        { cwd: ROOT, encoding: "utf8" },
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `gltfpack failed for ${role}`);
      }
      const optimized = await loadGlb(temporary);
      const quality = await validateOptimization(source, optimized);
      const sourceInfo = await stat(sourceFilename);
      const optimizedInfo = await stat(temporary);
      assert.ok(
        optimizedInfo.size < sourceInfo.size,
        `${role} Meshopt output is not smaller than its source`,
      );
      const entry = {
        role,
        source: {
          bytes: sourceInfo.size,
          sha256: sha256(source.buffer),
        },
        optimized: {
          bytes: optimizedInfo.size,
          sha256: sha256(optimized.buffer),
          savedBytes: sourceInfo.size - optimizedInfo.size,
          savedPercent: Number(((1 - optimizedInfo.size / sourceInfo.size) * 100).toFixed(3)),
        },
        quality,
      };
      staged.push({ role, temporary, outputFilename });
      entries.push(entry);
    } catch (error) {
      await rm(temporary, { force: true });
      await Promise.all(staged.map(({ temporary: stagedFilename }) => (
        rm(stagedFilename, { force: true })
      )));
      throw error;
    }
  }

  if (!toolVersion) toolVersion = await ensureExecutable(GLTFPACK);
  const report = {
    formatVersion: FORMAT_VERSION,
    generatedAt: staged.length
      ? new Date().toISOString()
      : existingReport.generatedAt,
    policy: {
      geometryQuantization: false,
      textureTranscode: false,
      textureReason: "Pinned Node gltfpack has no WebP encoder; KTX2 needs a separately validated Safari-capable runtime path.",
      cumulativeRepacking: false,
    },
    tool: {
      executable: path.relative(ROOT, GLTFPACK),
      version: toolVersion,
      arguments: GLTFPACK_ARGUMENTS,
    },
    totals: {
      sourceBytes: entries.reduce((total, entry) => total + entry.source.bytes, 0),
      optimizedBytes: entries.reduce((total, entry) => total + entry.optimized.bytes, 0),
      savedBytes: entries.reduce((total, entry) => total + entry.optimized.savedBytes, 0),
      savedPercent: Number((
        (1 - entries.reduce((total, entry) => total + entry.optimized.bytes, 0)
          / entries.reduce((total, entry) => total + entry.source.bytes, 0)) * 100
      ).toFixed(3)),
    },
    characters: entries,
  };

  // Validate every role before replacing any production asset.
  for (const { temporary, outputFilename } of staged) {
    await rename(temporary, outputFilename);
  }
  if (staged.length) {
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    assert.deepEqual(
      report,
      existingReport,
      `${options.report} no longer matches the pinned optimization policy`,
    );
  }

  console.log(JSON.stringify(report, null, 2));
}

await main();
