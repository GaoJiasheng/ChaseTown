import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

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

function floatAccessor(asset, accessorIndex) {
  const accessor = asset.json.accessors[accessorIndex];
  assert.equal(accessor.componentType, 5126, "animation accessors must be float32");
  assert.equal(accessor.sparse, undefined, "production animation accessors cannot be sparse");
  const view = asset.json.bufferViews[accessor.bufferView];
  const components = COMPONENTS[accessor.type];
  assert.ok(components, `unsupported accessor type ${accessor.type}`);
  const stride = view.byteStride ?? components * 4;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const values = [];
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < components; component += 1) {
      values.push(asset.binary.readFloatLE(start + item * stride + component * 4));
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

const CHARACTER_CONTRACTS = {
  kid: {
    clips: ["Idle", "Walk", "Run", "TurnLeft", "TurnRight", "HideEnter", "HideIdle", "HidePeek", "HideExit", "Caught", "EscapeCelebrate", "Interact"],
    minimumDuration: { TurnLeft: 0.55, TurnRight: 0.55, Caught: 0.8, HideEnter: 1, HideIdle: 1.5, HidePeek: 0.8, HideExit: 0.8 },
    exactDuration: { TurnLeft: 0.6, TurnRight: 0.6 },
  },
  villain: {
    clips: ["Idle", "PatrolWalk", "Run", "Alert", "LostSight", "Search", "CheckHide", "Catch"],
    minimumDuration: { Alert: 0.35, LostSight: 1, Search: 1, CheckHide: 1.5, Catch: 0.7 },
  },
  police: {
    clips: ["Idle", "Run", "Alert", "Interact", "Resolve"],
    minimumDuration: { Resolve: 0.7 },
  },
};

for (const [role, contract] of Object.entries(CHARACTER_CONTRACTS)) {
  test(`${role} ships only its complete moving production animation set`, async () => {
    const filename = path.join(ROOT, "public/models/characters", `${role}.glb`);
    const asset = readGlb(await readFile(filename), filename);
    const animations = asset.json.animations ?? [];
    assert.deepEqual(animations.map((animation) => animation.name).sort(), [...contract.clips].sort());
    assert.equal(asset.json.skins?.[0]?.joints?.length, 21, `${role} must keep the approved 21-bone web rig`);
    assert.ok((await readFile(filename)).length < 12 * 1024 * 1024, `${role} exceeds the per-character web budget`);

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
  const asset = readGlb(await readFile(filename), filename);
  const names = new Set(asset.json.nodes.map((node) => node.name));
  for (const required of ["DoorPivot", "HideAnchor", "HandIK", "PeekAnchor", "CameraAnchor", "SearchAnchor"]) {
    assert.ok(names.has(required), `hero locker is missing ${required}`);
  }
  assert.deepEqual(
    (asset.json.animations ?? []).map((animation) => animation.name).sort(),
    [...LOCKER_CLIPS].sort(),
  );
  for (const animation of asset.json.animations) {
    assert.ok(animationDuration(asset, animation) >= 0.75, `${animation.name} is too abrupt`);
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
