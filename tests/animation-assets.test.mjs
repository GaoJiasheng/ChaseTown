import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTE_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readGlb(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not GLB`);
  let json = null;
  let binary = null;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const content = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(content.toString("utf8").replace(/\0+$/u, "").trim());
    if (type === 0x004e4942) binary = content;
    offset += 8 + length;
  }
  assert.ok(json && binary, `${filename} needs JSON and BIN chunks`);
  return { json, binary };
}

async function decodeMeshoptBufferViews(asset) {
  const compressedViews = (asset.json.bufferViews ?? [])
    .map((view, index) => ({ view, index, compression: view.extensions?.EXT_meshopt_compression }))
    .filter(({ compression }) => compression);
  if (!compressedViews.length) return asset;
  await MeshoptDecoder.ready;
  assert.equal(MeshoptDecoder.supported, true, "the project Meshopt decoder must support compressed locker assets");
  const decodedViews = new Map();
  for (const { index, compression } of compressedViews) {
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
    decodedViews.set(index, Buffer.from(target.buffer, target.byteOffset, target.byteLength));
  }
  return { ...asset, decodedViews };
}

function floatAccessor(asset, accessorIndex) {
  const accessor = asset.json.accessors[accessorIndex];
  assert.equal(accessor.sparse, undefined, "production animation accessors cannot be sparse");
  const viewIndex = accessor.bufferView;
  const view = asset.json.bufferViews[viewIndex];
  const components = COMPONENTS[accessor.type];
  assert.ok(components, `unsupported accessor type ${accessor.type}`);
  const componentBytes = COMPONENT_BYTE_SIZE[accessor.componentType];
  assert.ok(componentBytes, `unsupported accessor component type ${accessor.componentType}`);
  const decoded = asset.decodedViews?.get(viewIndex);
  const bytes = decoded ?? asset.binary;
  const stride = view.byteStride ?? components * componentBytes;
  const start = (decoded ? 0 : (view.byteOffset ?? 0)) + (accessor.byteOffset ?? 0);
  const readers = {
    5120: (offset) => bytes.readInt8(offset),
    5121: (offset) => bytes.readUInt8(offset),
    5122: (offset) => bytes.readInt16LE(offset),
    5123: (offset) => bytes.readUInt16LE(offset),
    5125: (offset) => bytes.readUInt32LE(offset),
    5126: (offset) => bytes.readFloatLE(offset),
  };
  const normalizers = {
    5120: (value) => Math.max(value / 127, -1),
    5121: (value) => value / 255,
    5122: (value) => Math.max(value / 32767, -1),
    5123: (value) => value / 65535,
  };
  const values = [];
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < components; component += 1) {
      const value = readers[accessor.componentType](start + item * stride + component * componentBytes);
      values.push(accessor.normalized ? normalizers[accessor.componentType](value) : value);
    }
  }
  return values;
}

function animationDuration(asset, animation) {
  return Math.max(...animation.samplers.map((sampler) => {
    const accessor = asset.json.accessors[sampler.input];
    return accessor.max?.[0] ?? Math.max(...floatAccessor(asset, sampler.input));
  }));
}

function rotationMotion(asset, animation) {
  let totalRange = 0;
  let rotationTargets = 0;
  for (const channel of animation.channels) {
    if (channel.target.path !== "rotation") continue;
    rotationTargets += 1;
    const outputIndex = animation.samplers[channel.sampler].output;
    const accessor = asset.json.accessors[outputIndex];
    const components = COMPONENTS[accessor.type];
    const values = floatAccessor(asset, outputIndex);
    for (let component = 0; component < components; component += 1) {
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (let item = component; item < values.length; item += components) {
        minimum = Math.min(minimum, values[item]);
        maximum = Math.max(maximum, values[item]);
      }
      totalRange += maximum - minimum;
    }
  }
  return { totalRange, rotationTargets };
}

function quaternionAnglesDegrees(asset, animation) {
  const channel = animation.channels.find((entry) => entry.target.path === "rotation");
  assert.ok(channel, `${animation.name} needs a rotation channel`);
  const sampler = animation.samplers[channel.sampler];
  const accessor = asset.json.accessors[sampler.output];
  assert.equal(accessor.type, "VEC4", `${animation.name} must export quaternion rotations`);
  const quaternions = floatAccessor(asset, sampler.output);
  const angles = [];
  for (let offset = 0; offset < quaternions.length; offset += 4) {
    const w = Math.min(1, Math.abs(quaternions[offset + 3]));
    angles.push(2 * Math.acos(w) * 180 / Math.PI);
  }
  return angles;
}

const CHARACTER_CONTRACTS = {
  kid: {
    clips: ["Idle", "Walk", "Run", "TurnLeft", "TurnRight", "HideEnter", "HideIdle", "HidePeek", "HideExit", "Caught", "EscapeCelebrate", "Interact"],
    minimumDuration: { TurnLeft: 0.55, TurnRight: 0.55, Caught: 0.8, HideEnter: 1, HideIdle: 1.5, HidePeek: 0.8, HideExit: 0.8 },
    exactDuration: { TurnLeft: 0.6, TurnRight: 0.6 },
    maxBytes: 5_100_000,
  },
  villain: {
    clips: ["Idle", "PatrolWalk", "Run", "Alert", "LostSight", "Search", "CheckHide", "Catch"],
    minimumDuration: { Alert: 0.35, LostSight: 1, Search: 1, CheckHide: 1.5, Catch: 0.7 },
    maxBytes: 4_850_000,
  },
  police: {
    clips: ["Idle", "Run", "Alert", "Interact", "Resolve"],
    minimumDuration: { Resolve: 0.7 },
    maxBytes: 8_850_000,
  },
};

for (const [role, contract] of Object.entries(CHARACTER_CONTRACTS)) {
  test(`${role} ships only its complete moving production animation set`, async () => {
    const filename = path.join(ROOT, "public/models/characters", `${role}.glb`);
    const buffer = await readFile(filename);
    const asset = await decodeMeshoptBufferViews(readGlb(buffer, filename));
    const animations = asset.json.animations ?? [];
    assert.deepEqual(animations.map((animation) => animation.name).sort(), [...contract.clips].sort());
    assert.equal(asset.json.skins?.[0]?.joints?.length, 21, `${role} must keep the approved 21-bone web rig`);
    assert.ok(buffer.length <= contract.maxBytes, `${role} exceeds its Meshopt web budget (${buffer.length} bytes)`);
    assert.ok(asset.json.extensionsRequired?.includes("EXT_meshopt_compression"), `${role} must require Meshopt compression`);
    assert.equal(
      asset.json.extensionsRequired?.includes("KHR_mesh_quantization"),
      false,
      `${role} must retain authored floating-point geometry`,
    );

    for (const animation of animations) {
      const duration = animationDuration(asset, animation);
      assert.ok(duration >= (contract.minimumDuration[animation.name] ?? 0.3), `${role}/${animation.name} is too short (${duration}s)`);
      if (contract.exactDuration?.[animation.name] !== undefined) {
        assert.ok(
          Math.abs(duration - contract.exactDuration[animation.name]) < 1e-6,
          `${role}/${animation.name} must match the authored/runtime timing contract`,
        );
      }
      const motion = rotationMotion(asset, animation);
      assert.ok(motion.rotationTargets >= 20, `${role}/${animation.name} does not animate the full body`);
      assert.ok(motion.totalRange > 0.035, `${role}/${animation.name} is static or effectively a rest pose`);
      assert.doesNotMatch(animation.name, /t[ -]?pose|ual_source|loop$/iu);
    }
  });
}

test("hero locker ships authored hierarchy and all door performances", async () => {
  const filename = path.join(ROOT, "public/models/environment/locker.glb");
  const buffer = await readFile(filename);
  const asset = await decodeMeshoptBufferViews(readGlb(buffer, filename));
  const names = new Set(asset.json.nodes.map((node) => node.name));
  for (const required of ["DoorPivot", "HideAnchor", "HandIK", "PeekAnchor", "CameraAnchor", "SearchAnchor"]) {
    assert.ok(names.has(required), `hero locker is missing ${required}`);
  }
  assert.deepEqual(
    (asset.json.animations ?? []).map((animation) => animation.name).sort(),
    [...LOCKER_CLIPS].sort(),
  );
  const pivotIndex = asset.json.nodes.findIndex((node) => node.name === "DoorPivot");
  const restRotation = asset.json.nodes[pivotIndex].rotation ?? [0, 0, 0, 1];
  assert.ok(
    restRotation.every((value, index) => Math.abs(value - [0, 0, 0, 1][index]) < 1e-6),
    "hero locker must load with its idle door closed",
  );
  for (const animation of asset.json.animations) {
    const contract = LOCKER_ANIMATION_CONTRACTS[animation.name];
    assert.ok(contract, `${animation.name} is missing a locked runtime contract`);
    assert.ok(Math.abs(animationDuration(asset, animation) - contract.duration) < 1e-5, `${animation.name} duration drifted`);
    assert.equal(animation.channels.length, 1, `${animation.name} may only drive the door pivot`);
    assert.deepEqual(animation.channels[0].target, { node: pivotIndex, path: "rotation" });
    const angles = quaternionAnglesDegrees(asset, animation);
    assert.ok(Math.abs(angles[0] - contract.startAngle) < 0.2, `${animation.name} start pose drifted`);
    assert.ok(Math.abs(angles.at(-1) - contract.endAngle) < 0.2, `${animation.name} end pose drifted`);
    assert.ok(Math.max(...angles) >= contract.minimumPeakAngle - 0.01, `${animation.name} lost its authored swing/overshoot`);
  }

  const triangles = (asset.json.meshes ?? []).reduce((total, mesh) => total + mesh.primitives.reduce(
    (meshTotal, primitive) => meshTotal + asset.json.accessors[primitive.indices].count / 3,
    0,
  ), 0);
  assert.ok(triangles >= 45_000, `hero locker lost production detail (${triangles} triangles)`);
  assert.ok(triangles <= 60_000, `hero locker exceeds its interactive prop geometry budget (${triangles} triangles)`);
  assert.ok(buffer.length <= 1_700_000, `hero locker exceeds its 1.7 MB Meshopt budget (${buffer.length} bytes)`);
  assert.ok(asset.json.extensionsRequired?.includes("EXT_meshopt_compression"), "hero locker must require Meshopt compression");
  const materials = new Set((asset.json.materials ?? []).map((material) => material.name));
  for (const material of ["M_Locker_BluePaint", "M_Locker_BrushedSteel", "M_Locker_WornMetal", "M_Locker_Interior", "M_Locker_Rubber"]) {
    assert.ok(materials.has(material), `hero locker is missing ${material}`);
  }
});

const LOCKER_CLIPS = [
  "Locker_Door_Open_Enter",
  "Locker_Door_Close_Enter",
  "Locker_Door_Open_Exit",
  "Locker_Door_Close_Exit",
  "Locker_Door_Check_Open",
  "Locker_Door_Check_Close",
];

const LOCKER_ANIMATION_CONTRACTS = {
  Locker_Door_Check_Close: { duration: 1.2, startAngle: 77, endAngle: 0, minimumPeakAngle: 77 },
  Locker_Door_Check_Open: { duration: 0.9333333, startAngle: 0, endAngle: 77, minimumPeakAngle: 79 },
  Locker_Door_Close_Enter: { duration: 1.2, startAngle: 102, endAngle: 0, minimumPeakAngle: 102 },
  Locker_Door_Close_Exit: { duration: 1.1, startAngle: 102, endAngle: 0, minimumPeakAngle: 102 },
  Locker_Door_Open_Enter: { duration: 1.0666667, startAngle: 0, endAngle: 102, minimumPeakAngle: 106 },
  Locker_Door_Open_Exit: { duration: 0.8333333, startAngle: 0, endAngle: 102, minimumPeakAngle: 104.8 },
};
