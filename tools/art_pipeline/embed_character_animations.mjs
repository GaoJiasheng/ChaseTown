#!/usr/bin/env node

/**
 * Retarget Blender-sampled, canonical-rest-relative humanoid deltas onto the
 * existing runtime character skeletons and embed the resulting clips in-place.
 *
 * The source FBXs use the same semantic joint names as the characters, but the
 * three runtime rigs have role-specific proportions. Blender independently
 * evaluates each FBX on its own armature before producing the canonical delta;
 * this encoder only composes targetRest * delta. Only target-specific
 * quaternion tracks are serialized, so no source translation or scale track
 * can alter a character's bind proportions.
 */

import fs from "node:fs";
import path from "node:path";

import * as THREE from "three";

const GLTF_JSON_CHUNK = 0x4e4f534a;
const GLTF_BIN_CHUNK = 0x004e4942;
const FLOAT_COMPONENT = 5126;
const CONSTANT_TRACK_EPSILON_RADIANS = 0.002;
const KEY_REDUCTION_EPSILON_RADIANS = 0.001;
const TURN_ENDPOINT_EPSILON_RADIANS = 0.0001;
const TURN_AXIS = new THREE.Vector3(0, 1, 0);
// Blender uses Z-up, while glTF/Three.js use Y-up. Conjugating a local delta
// by this basis maps Blender (x, y, z) to glTF (x, z, -y), preserving the sign
// of the authored Z yaw as Three.js Y yaw.
const BLENDER_TO_GLTF_BASIS = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const GLTF_TO_BLENDER_BASIS = BLENDER_TO_GLTF_BASIS.clone().invert();
const EXPECTED_BONES = [
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
];
const EXPECTED_CLIPS = [
  "Idle",
  "Run",
  "Walk",
  "TurnLeft",
  "TurnRight",
  "LookAround",
  "ScaredCaught",
  "Celebrate",
  "PointAlert",
];

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${flag ?? "<end>"}.`);
    }
    values.set(flag.slice(2), value);
  }
  const samples = values.get("samples");
  const outputDir = values.get("output-dir");
  const characters = values.get("characters");
  if (!samples || !outputDir || !characters) {
    throw new Error("Required: --samples FILE --output-dir DIR --characters FILE,FILE,FILE");
  }
  return { samples, outputDir, characters: characters.split(",").filter(Boolean) };
}

function parseGlb(file) {
  const payload = fs.readFileSync(file);
  if (payload.toString("ascii", 0, 4) !== "glTF" || payload.readUInt32LE(4) !== 2) {
    throw new Error(`${file} is not a glTF 2.0 GLB.`);
  }
  if (payload.readUInt32LE(8) !== payload.length) {
    throw new Error(`${file} has an invalid declared length.`);
  }
  let document = null;
  let binary = Buffer.alloc(0);
  for (let offset = 12; offset + 8 <= payload.length;) {
    const length = payload.readUInt32LE(offset);
    const type = payload.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > payload.length) throw new Error(`${file} contains a truncated GLB chunk.`);
    if (type === GLTF_JSON_CHUNK) {
      document = JSON.parse(payload.subarray(start, end).toString("utf8").trimEnd());
    } else if (type === GLTF_BIN_CHUNK) {
      binary = Buffer.from(payload.subarray(start, end));
    }
    offset = end;
  }
  if (!document) throw new Error(`${file} has no JSON chunk.`);
  return { document, binary };
}

function writeGlb(file, document, binary) {
  const jsonPayload = Buffer.from(JSON.stringify(document), "utf8");
  const jsonPadding = (4 - (jsonPayload.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonPayload, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - (binary.length % 4)) % 4;
  const paddedBinary = Buffer.concat([binary, Buffer.alloc(binPadding)]);
  const total = 12 + 8 + paddedJson.length + (paddedBinary.length ? 8 + paddedBinary.length : 0);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(GLTF_JSON_CHUNK, 4);
  const chunks = [header, jsonHeader, paddedJson];
  if (paddedBinary.length) {
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(paddedBinary.length, 0);
    binHeader.writeUInt32LE(GLTF_BIN_CHUNK, 4);
    chunks.push(binHeader, paddedBinary);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(chunks));
}

function applyNodeTransform(object, node) {
  if (node.matrix) {
    object.matrix.fromArray(node.matrix);
    object.matrix.decompose(object.position, object.quaternion, object.scale);
  } else {
    object.position.fromArray(node.translation ?? [0, 0, 0]);
    object.quaternion.fromArray(node.rotation ?? [0, 0, 0, 1]);
    object.scale.fromArray(node.scale ?? [1, 1, 1]);
  }
  object.updateMatrix();
}

function buildSkeleton(document) {
  const skin = document.skins?.[0];
  if (!skin || skin.joints.length !== EXPECTED_BONES.length) {
    throw new Error(`Expected one ${EXPECTED_BONES.length}-joint humanoid skin.`);
  }
  const jointSet = new Set(skin.joints);
  const byIndex = new Map();
  for (const nodeIndex of skin.joints) {
    const node = document.nodes[nodeIndex];
    const bone = new THREE.Bone();
    bone.name = node.name ?? "";
    applyNodeTransform(bone, node);
    byIndex.set(nodeIndex, bone);
  }
  const names = skin.joints.map((nodeIndex) => document.nodes[nodeIndex].name);
  if (names.join("\n") !== EXPECTED_BONES.join("\n")) {
    throw new Error(`Unexpected humanoid joint order: ${names.join(", ")}`);
  }
  const childIndices = new Set();
  for (const nodeIndex of skin.joints) {
    for (const childIndex of document.nodes[nodeIndex].children ?? []) {
      if (!jointSet.has(childIndex)) continue;
      byIndex.get(nodeIndex).add(byIndex.get(childIndex));
      childIndices.add(childIndex);
    }
  }
  const roots = skin.joints.filter((nodeIndex) => !childIndices.has(nodeIndex));
  if (roots.length !== 1 || document.nodes[roots[0]].name !== "Hips") {
    throw new Error("Humanoid skeleton must have Hips as its single joint root.");
  }
  byIndex.get(roots[0]).updateMatrixWorld(true);
  return new THREE.Skeleton(skin.joints.map((nodeIndex) => byIndex.get(nodeIndex)));
}

function parseSampledClips(file) {
  const samples = JSON.parse(fs.readFileSync(file, "utf8"));
  if (samples.schema !== "chasing-canonical-rest-animation-deltas-v1") {
    throw new Error(`Unexpected animation sample schema ${samples.schema ?? "<missing>"}.`);
  }
  if (samples.bones?.join("\n") !== EXPECTED_BONES.join("\n")) {
    throw new Error(`Unexpected sampled bones: ${(samples.bones ?? []).join(", ")}`);
  }
  const clipNames = (samples.clips ?? []).map((clip) => clip.name);
  if (clipNames.join("\n") !== EXPECTED_CLIPS.join("\n")) {
    throw new Error(`Unexpected sampled clips: ${clipNames.join(", ")}`);
  }
  const clips = samples.clips.map((sampled) => {
    if (!Array.isArray(sampled.times) || sampled.times.length < 2) {
      throw new Error(`${sampled.name} has no sampled timeline.`);
    }
    if (sampled.times.some((value, index) => !Number.isFinite(value)
      || value < 0
      || (index > 0 && value <= sampled.times[index - 1]))) {
      throw new Error(`${sampled.name} has an invalid sampled timeline.`);
    }
    if (Object.keys(sampled.tracks ?? {}).join("\n") !== EXPECTED_BONES.join("\n")) {
      throw new Error(`${sampled.name} does not contain the canonical 21 delta tracks.`);
    }
    const times = Float32Array.from(sampled.times);
    const tracks = EXPECTED_BONES.map((boneName) => {
      const sourceValues = sampled.tracks[boneName];
      if (!Array.isArray(sourceValues)
        || sourceValues.length !== times.length
        || sourceValues.some((value) => !Array.isArray(value)
          || value.length !== 4
          || value.some((component) => !Number.isFinite(component)))) {
        throw new Error(`${sampled.name}/${boneName} has invalid quaternion samples.`);
      }
      return new THREE.QuaternionKeyframeTrack(
        `${boneName}.quaternion`,
        times,
        normalizedQuaternionValues(Float32Array.from(sourceValues.flat())),
      );
    });
    const clip = new THREE.AnimationClip(sampled.name, -1, tracks);
    clip.userData = {
      source: sampled.source,
      sourceFps: sampled.fps,
      canonicalRestSha256: samples.canonicalRestSha256,
    };
    return clip;
  });
  return {
    clips,
    metadata: {
      schema: samples.schema,
      canonicalRig: samples.canonicalRig,
      canonicalRestSha256: samples.canonicalRestSha256,
    },
  };
}

function appendAligned(state, typedArray) {
  const input = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const padding = (4 - (state.binary.length % 4)) % 4;
  if (padding) state.binary = Buffer.concat([state.binary, Buffer.alloc(padding)]);
  const offset = state.binary.length;
  state.binary = Buffer.concat([state.binary, input]);
  return { offset, length: input.length };
}

function appendAccessor(state, typedArray, type, count, includeRange = false) {
  const bytes = appendAligned(state, typedArray);
  const viewIndex = state.document.bufferViews.length;
  state.document.bufferViews.push({ buffer: 0, byteOffset: bytes.offset, byteLength: bytes.length });
  const accessor = { bufferView: viewIndex, componentType: FLOAT_COMPONENT, count, type };
  if (includeRange) {
    accessor.min = [Math.min(...typedArray)];
    accessor.max = [Math.max(...typedArray)];
  }
  const accessorIndex = state.document.accessors.length;
  state.document.accessors.push(accessor);
  return accessorIndex;
}

function normalizedQuaternionValues(valuesInput) {
  const values = new Float32Array(valuesInput.length);
  const quaternion = new THREE.Quaternion();
  let previous = null;
  for (let index = 0; index < valuesInput.length; index += 4) {
    quaternion.fromArray(valuesInput, index).normalize();
    if (previous && previous.dot(quaternion) < 0) {
      quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
    }
    quaternion.toArray(values, index);
    previous = quaternion.clone();
  }
  return values;
}

function nodeRestQuaternion(document, nodeIndex) {
  const node = document.nodes[nodeIndex];
  if (node.matrix) {
    const matrix = new THREE.Matrix4().fromArray(node.matrix);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    matrix.decompose(position, quaternion, scale);
    return quaternion.normalize();
  }
  return new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]).normalize();
}

function retargetDeltaQuaternionTrack(sourceTrack, targetRest, convertBlenderRootYaw = false) {
  const delta = new THREE.Quaternion();
  const convertedDelta = new THREE.Quaternion();
  const targetAnimated = new THREE.Quaternion();
  const values = new Float32Array(sourceTrack.values.length);
  for (let index = 0; index < sourceTrack.values.length; index += 4) {
    // Blender already sampled Q_delta from each FBX's own evaluated pose:
    // inverse(Q_canonical_rest_local) * Q_source_pose_local.
    delta.fromArray(sourceTrack.values, index).normalize();
    if (convertBlenderRootYaw) {
      convertedDelta.copy(BLENDER_TO_GLTF_BASIS)
        .multiply(delta)
        .multiply(GLTF_TO_BLENDER_BASIS)
        .normalize();
    } else {
      convertedDelta.copy(delta);
    }
    // Q_target_animated = Q_target_rest * Q_delta
    targetAnimated.copy(targetRest).multiply(convertedDelta).normalize().toArray(values, index);
  }
  return normalizedQuaternionValues(values);
}

function reduceQuaternionTrack(timesInput, valuesInput, tolerance = KEY_REDUCTION_EPSILON_RADIANS) {
  if (timesInput.length <= 2) {
    return { times: Float32Array.from(timesInput), values: Float32Array.from(valuesInput) };
  }
  const keep = new Set([0, timesInput.length - 1]);
  const stack = [[0, timesInput.length - 1]];
  const startQuaternion = new THREE.Quaternion();
  const endQuaternion = new THREE.Quaternion();
  const expected = new THREE.Quaternion();
  const actual = new THREE.Quaternion();
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start <= 1) continue;
    startQuaternion.fromArray(valuesInput, start * 4).normalize();
    endQuaternion.fromArray(valuesInput, end * 4).normalize();
    const duration = timesInput[end] - timesInput[start];
    let maximumError = -1;
    let split = -1;
    for (let index = start + 1; index < end; index += 1) {
      const alpha = duration > 0 ? (timesInput[index] - timesInput[start]) / duration : 0;
      expected.slerpQuaternions(startQuaternion, endQuaternion, alpha).normalize();
      actual.fromArray(valuesInput, index * 4).normalize();
      const error = expected.angleTo(actual);
      if (error > maximumError) {
        maximumError = error;
        split = index;
      }
    }
    if (maximumError > tolerance && split > start && split < end) {
      keep.add(split);
      stack.push([start, split], [split, end]);
    }
  }
  const indices = [...keep].sort((a, b) => a - b);
  const times = new Float32Array(indices.length);
  const values = new Float32Array(indices.length * 4);
  indices.forEach((sourceIndex, outputIndex) => {
    times[outputIndex] = timesInput[sourceIndex];
    values.set(valuesInput.subarray(sourceIndex * 4, sourceIndex * 4 + 4), outputIndex * 4);
  });
  return { times, values };
}

function animationFreeBase(targetGlb) {
  const document = structuredClone(targetGlb.document);
  let binary = Buffer.from(targetGlb.binary);
  const marker = document.asset?.extras?.chasingA1Animation;
  if (marker) {
    document.accessors = document.accessors.slice(0, marker.baseAccessorCount);
    document.bufferViews = document.bufferViews.slice(0, marker.baseBufferViewCount);
    binary = binary.subarray(0, marker.baseBufferByteLength);
    document.buffers[0].byteLength = marker.baseBufferByteLength;
    document.animations = [];
    delete document.asset.extras.chasingA1Animation;
    if (Object.keys(document.asset.extras).length === 0) delete document.asset.extras;
  } else if ((document.animations ?? []).length) {
    throw new Error("Character already has animations without the A1 rebuild marker; provide an animation-free base GLB.");
  }
  document.animations = [];
  return { document, binary };
}

function embedClips(targetGlb, clips, sampleMetadata, targetName) {
  buildSkeleton(targetGlb.document);
  const targetNodeByName = new Map(
    targetGlb.document.skins[0].joints.map((index) => [targetGlb.document.nodes[index].name, index]),
  );
  const base = animationFreeBase(targetGlb);
  const state = { document: base.document, binary: base.binary };
  state.document.bufferViews ??= [];
  state.document.accessors ??= [];
  const baseAccessorCount = state.document.accessors.length;
  const baseBufferViewCount = state.document.bufferViews.length;
  const baseBufferByteLength = state.document.buffers[0].byteLength;

  const report = [];
  for (const sourceClip of clips) {
    const quaternionTracks = sourceClip.tracks.filter((track) => track instanceof THREE.QuaternionKeyframeTrack);
    if (quaternionTracks.length !== EXPECTED_BONES.length) {
      throw new Error(`${targetName}/${sourceClip.name} has ${quaternionTracks.length} source rotation tracks, expected ${EXPECTED_BONES.length}.`);
    }
    const samplers = [];
    const channels = [];
    let frameCount = 0;
    let outputKeyframes = 0;
    let idleRestAngularError = 0;
    const boneMotionRadians = {};
    for (const track of quaternionTracks) {
      const match = /^(.+)\.quaternion$/u.exec(track.name);
      const boneName = match?.[1];
      const nodeIndex = targetNodeByName.get(boneName);
      if (!boneName || nodeIndex === undefined) {
        throw new Error(`Cannot bind source track ${track.name}.`);
      }
      const sourceTimes = Float32Array.from(track.times);
      const targetRest = nodeRestQuaternion(targetGlb.document, nodeIndex);
      const convertBlenderRootYaw = (
        (sourceClip.name === "TurnLeft" || sourceClip.name === "TurnRight")
        && boneName === "Hips"
      );
      const values = retargetDeltaQuaternionTrack(track, targetRest, convertBlenderRootYaw);
      if (sourceClip.name === "Idle") {
        // FBX round-tripping introduces sub-0.03-degree float drift even when
        // the authored first/last pose is identity. Pin both loop boundaries
        // to the target rest quaternion so entering Idle never nudges the rig.
        targetRest.toArray(values, 0);
        targetRest.toArray(values, values.length - 4);
        const first = new THREE.Quaternion().fromArray(values, 0).normalize();
        idleRestAngularError = Math.max(idleRestAngularError, first.angleTo(targetRest));
      }
      const sampled = new THREE.Quaternion();
      let maximumDelta = 0;
      for (let valueIndex = 0; valueIndex < values.length; valueIndex += 4) {
        sampled.fromArray(values, valueIndex).normalize();
        maximumDelta = Math.max(maximumDelta, sampled.angleTo(targetRest));
      }
      boneMotionRadians[boneName] = maximumDelta;
      if ((sourceClip.name === "TurnLeft" || sourceClip.name === "TurnRight") && boneName === "Hips") {
        const first = new THREE.Quaternion().fromArray(values, 0).normalize();
        const last = new THREE.Quaternion().fromArray(values, values.length - 4).normalize();
        const expectedTurn = new THREE.Quaternion().setFromAxisAngle(
          TURN_AXIS,
          sourceClip.name === "TurnLeft" ? -Math.PI / 2 : Math.PI / 2,
        );
        const actualTurn = targetRest.clone().invert().multiply(last).normalize();
        if (first.angleTo(targetRest) > TURN_ENDPOINT_EPSILON_RADIANS) {
          throw new Error(`${targetName}/${sourceClip.name} does not begin at the target rest pose.`);
        }
        if (actualTurn.angleTo(expectedTurn) > TURN_ENDPOINT_EPSILON_RADIANS) {
          throw new Error(`${targetName}/${sourceClip.name} endpoint direction or angle is incorrect.`);
        }
      }
      frameCount = Math.max(frameCount, sourceTimes.length);
      if (maximumDelta <= CONSTANT_TRACK_EPSILON_RADIANS) continue;
      const reduced = reduceQuaternionTrack(sourceTimes, values);
      outputKeyframes += reduced.times.length;
      const input = appendAccessor(state, reduced.times, "SCALAR", reduced.times.length, true);
      const output = appendAccessor(state, reduced.values, "VEC4", reduced.times.length);
      const samplerIndex = samplers.length;
      samplers.push({ input, output, interpolation: "LINEAR" });
      channels.push({ sampler: samplerIndex, target: { node: nodeIndex, path: "rotation" } });
    }
    state.document.animations.push({
      name: sourceClip.name,
      samplers,
      channels,
      extras: {
        source: sourceClip.userData.source,
        retargetedTo: targetName,
        fps: sourceClip.userData.sourceFps,
        rootMotion: false,
        canonicalRestSha256: sampleMetadata.canonicalRestSha256,
      },
    });
    if (sourceClip.name === "Idle" && idleRestAngularError > 1e-6) {
      throw new Error(`${targetName}/Idle frame zero changed target rest by ${idleRestAngularError} radians.`);
    }
    report.push({
      name: sourceClip.name,
      durationSeconds: sourceClip.duration,
      frames: frameCount,
      sourceRotationTracks: quaternionTracks.length,
      rotationTracks: channels.length,
      outputKeyframes,
      animatedBonesOverPointZeroOneRadians: Object.entries(boneMotionRadians)
        .filter(([, radians]) => radians > 0.01)
        .map(([name]) => name)
        .sort(),
      maxAngularDeltaRadians: Math.max(...Object.values(boneMotionRadians)),
      localRetargetFormula: "Blender: inverse(canonicalRestLocal) * independently evaluated FBX poseLocal; encoder: targetRest * delta",
      turnNeutralSource: sourceClip.name === "TurnLeft" || sourceClip.name === "TurnRight"
        ? "first independently sampled Hips delta"
        : null,
      turnCoordinateBasis: sourceClip.name === "TurnLeft" || sourceClip.name === "TurnRight"
        ? "Blender (x,y,z) -> glTF/Three (x,z,-y); authored Z yaw becomes Y yaw"
        : null,
      idleFrameZeroMaxAngularErrorRadians: sourceClip.name === "Idle" ? idleRestAngularError : null,
    });
  }
  state.document.buffers[0].byteLength = state.binary.length;
  state.document.asset ??= { version: "2.0" };
  state.document.asset.extras ??= {};
  state.document.asset.extras.chasingA1Animation = {
    baseAccessorCount,
    baseBufferViewCount,
    baseBufferByteLength,
    clipCount: EXPECTED_CLIPS.length,
    sourceFps: 30,
    encoding: "rotation-only float32; constant tracks removed; quaternion RDP key reduction",
    samplingSchema: sampleMetadata.schema,
    canonicalRig: sampleMetadata.canonicalRig,
    canonicalRestSha256: sampleMetadata.canonicalRestSha256,
    turnCoordinateBasis: "Blender (x,y,z) -> glTF/Three (x,z,-y)",
    constantTrackEpsilonRadians: CONSTANT_TRACK_EPSILON_RADIANS,
    keyReductionEpsilonRadians: KEY_REDUCTION_EPSILON_RADIANS,
  };
  return { ...state, report };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sampled = parseSampledClips(options.samples);
  const reports = [];
  for (const characterFile of options.characters) {
    const target = parseGlb(characterFile);
    const targetName = path.basename(characterFile, path.extname(characterFile));
    const embedded = embedClips(target, sampled.clips, sampled.metadata, targetName);
    const output = path.join(options.outputDir, `${targetName}.glb`);
    writeGlb(output, embedded.document, embedded.binary);
    reports.push({
      character: targetName,
      output: path.posix.join("public/models/characters", path.basename(output)),
      clips: embedded.report,
    });
  }
  process.stdout.write(`${JSON.stringify({ characters: reports }, null, 2)}\n`);
}

main();
