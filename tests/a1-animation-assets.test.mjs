import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

import { loadGameModule } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = await loadGameModule(ROOT, "a1-animation-assets");
const CHARACTERS = ["kid", "villain", "police"];
const CLIPS = ["Idle", "Run", "Walk", "TurnLeft", "TurnRight", "LookAround", "ScaredCaught", "Celebrate", "PointAlert"];
const BONES = new Set([
  "Hips", "Spine", "Chest", "Neck", "Head",
  "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
  "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
  "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
  "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
]);

if (!("self" in globalThis)) globalThis.self = globalThis;
if (!("ProgressEvent" in globalThis)) {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, values = {}) {
      this.type = type;
      Object.assign(this, values);
    }
  };
}
if (!("createImageBitmap" in globalThis)) {
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
}

const skinnedWorldPosition = (mesh, index) => {
  const position = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), index);
  return mesh.localToWorld(mesh.applyBoneTransform(index, position));
};

const degrees = (radians) => THREE.MathUtils.radToDeg(radians);

const sampleTrackQuaternion = (clip, boneName, time) => {
  const track = clip.tracks.find((candidate) => candidate.name === `${boneName}.quaternion`);
  assert.ok(track instanceof THREE.QuaternionKeyframeTrack, `${clip.name}/${boneName} rotation track`);
  const value = track.createInterpolant(new Float32Array(4)).evaluate(time);
  return new THREE.Quaternion().fromArray(value).normalize();
};

const sampleRestDelta = (clip, bone, time) => bone.quaternion.clone()
  .invert()
  .multiply(sampleTrackQuaternion(clip, bone.name, time))
  .normalize();

const assertNearDegrees = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}±${tolerance}°, got ${actual}°`,
  );
};

const dynamicSkinnedSize = (root) => {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  root.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    object.skeleton.update();
    object.computeBoundingBox();
    bounds.union(object.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  assert.equal(bounds.isEmpty(), false, "dynamic skinned bounds must contain geometry");
  return bounds.getSize(new THREE.Vector3());
};

test("A1 real compressed characters expose nine non-empty quaternion-only clips to Three.js", async () => {
  for (const character of CHARACTERS) {
    const bytes = await readFile(path.join(ROOT, "public", "models", "characters", `${character}.glb`));
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await new Promise((resolve, reject) => loader.parse(data, "", resolve, reject));
    const bones = [];
    gltf.scene.traverse((object) => { if (object instanceof THREE.Bone) bones.push(object); });
    assert.equal(bones.length, 21, `${character} shared skeleton joint count`);
    assert.equal(new Set(bones.map((bone) => bone.name)).size, 21, `${character} unique joint names`);
    assert.ok(bones.every((bone) => BONES.has(bone.name) && !/\.\d+$/u.test(bone.name)), `${character} canonical joint names`);
    assert.deepEqual(gltf.animations.map((clip) => clip.name), CLIPS, `${character} clip names/order`);
    for (const clip of gltf.animations) {
      assert.ok(clip.duration > 0, `${character}/${clip.name} duration`);
      assert.ok(clip.tracks.length > 0, `${character}/${clip.name} tracks`);
      let animatedTracks = 0;
      for (const track of clip.tracks) {
        assert.ok(track instanceof THREE.QuaternionKeyframeTrack, `${character}/${clip.name}/${track.name} type`);
        const match = /^(.+)\.quaternion$/u.exec(track.name);
        assert.ok(match && BONES.has(match[1]), `${character}/${clip.name}/${track.name} target bone`);
        assert.ok(track.times.length >= 1, `${character}/${clip.name}/${track.name} keyframes`);
        if (track.times.length >= 2) animatedTracks += 1;
        assert.equal(track.values.length, track.times.length * 4, `${character}/${clip.name}/${track.name} quaternion width`);
      }
      assert.ok(animatedTracks > 0, `${character}/${clip.name} must retain changing tracks`);
    }

    const hips = bones.find((bone) => bone.name === "Hips");
    assert.ok(hips, `${character} Hips bone`);
    for (const [clipName, signedAngle] of [["TurnLeft", -Math.PI / 2], ["TurnRight", Math.PI / 2]]) {
      const clip = gltf.animations.find((candidate) => candidate.name === clipName);
      const track = clip.tracks.find((candidate) => candidate.name === "Hips.quaternion");
      assert.ok(track instanceof THREE.QuaternionKeyframeTrack, `${character}/${clipName} Hips track`);
      const first = new THREE.Quaternion().fromArray(track.values, 0).normalize();
      const last = new THREE.Quaternion().fromArray(track.values, track.values.length - 4).normalize();
      const actualDelta = hips.quaternion.clone().invert().multiply(last).normalize();
      const expectedDelta = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        signedAngle,
      );
      assert.ok(first.angleTo(hips.quaternion) < 1e-5, `${character}/${clipName} begins at rest`);
      assert.ok(actualDelta.angleTo(expectedDelta) < 1e-4, `${character}/${clipName} endpoint direction`);
      assert.ok(Math.abs(actualDelta.x) < 1e-5, `${character}/${clipName} has no X roll component`);
      assert.ok(Math.abs(actualDelta.z) < 1e-5, `${character}/${clipName} has no Z roll component`);
    }

    // These checks intentionally validate the authored pose semantics in the
    // final compressed runtime GLB. Merely checking that tracks exist would not
    // catch assigning an FBX Action to another FBX's incompatible bind rest.
    const boneByName = new Map(bones.map((bone) => [bone.name, bone]));
    const semanticEuler = (clipName, boneName, time, axis) => {
      const clip = gltf.animations.find((candidate) => candidate.name === clipName);
      const delta = sampleRestDelta(clip, boneByName.get(boneName), time);
      return degrees(new THREE.Euler().setFromQuaternion(delta, "XYZ")[axis]);
    };
    const semanticMagnitude = (clipName, boneName, time) => {
      const clip = gltf.animations.find((candidate) => candidate.name === clipName);
      return degrees(sampleRestDelta(clip, boneByName.get(boneName), time).angleTo(new THREE.Quaternion()));
    };
    for (const [clipName, times, expected] of [
      ["Run", [0, 9 / 30, 19 / 30], [-34, 34, -34]],
      ["Walk", [0, 19 / 30, 39 / 30], [-15.3, 15.3, -15.3]],
    ]) {
      times.forEach((time, index) => assertNearDegrees(
        semanticEuler(clipName, "LeftUpperLeg", time, "x"),
        expected[index],
        0.5,
        `${character}/${clipName}/LeftUpperLeg key ${index}`,
      ));
    }
    [0, 44 / 30, 89 / 30].forEach((time, index) => assertNearDegrees(
      semanticEuler("LookAround", "Head", time, "z"),
      [-28, 28, -28][index],
      0.5,
      `${character}/LookAround/Head key ${index}`,
    ));
    for (const [clipName, boneName, times, expected] of [
      ["ScaredCaught", "LeftUpperArm", [0, 17 / 30, 35 / 30], [0, 74.4, 89.3]],
      ["Celebrate", "LeftUpperArm", [0, 19 / 30, 39 / 30], [40, 125.8, 110.4]],
      ["PointAlert", "RightUpperArm", [0, 17 / 30, 41 / 30], [4, 2.83, 2.83]],
    ]) {
      times.forEach((time, index) => assertNearDegrees(
        semanticMagnitude(clipName, boneName, time),
        expected[index],
        0.9,
        `${character}/${clipName}/${boneName} key ${index}`,
      ));
    }
    for (const [clipName, expected] of [
      ["TurnLeft", [0, -45, -90]],
      ["TurnRight", [0, 45, 90]],
    ]) {
      [0, 11 / 30, 23 / 30].forEach((time, index) => assertNearDegrees(
        semanticEuler(clipName, "Hips", time, "y"),
        expected[index],
        0.5,
        `${character}/${clipName}/Hips key ${index}`,
      ));
    }

    const hipsRest = hips.quaternion.clone();
    const restSize = dynamicSkinnedSize(gltf.scene);
    for (const clipName of ["TurnLeft", "TurnRight"]) {
      const clip = gltf.animations.find((candidate) => candidate.name === clipName);
      hips.quaternion.copy(sampleTrackQuaternion(clip, "Hips", 11 / 30));
      const midpointSize = dynamicSkinnedSize(gltf.scene);
      assert.ok(
        midpointSize.y >= restSize.y * 0.97,
        `${character}/${clipName} must preserve upright height; rest=${restSize.y}, midpoint=${midpointSize.y}`,
      );
      assert.ok(
        Math.abs(midpointSize.y - restSize.y) <= restSize.y * 0.03,
        `${character}/${clipName} dynamic bounds height must remain stable`,
      );
    }
    hips.quaternion.copy(hipsRest);
    dynamicSkinnedSize(gltf.scene);

    const actor = new THREE.Group();
    const visual = new THREE.Group();
    visual.userData.baseY = 0;
    actor.userData.visual = visual;
    actor.add(visual);
    visual.add(gltf.scene);
    const batch = game.batchCompatibleActorSkins(gltf.scene);
    actor.userData.actorBatch = batch.budget;
    const shadow = game.createActorShadowProxy(actor);
    assert.ok(shadow.proxy instanceof THREE.SkinnedMesh, `${character} P4 shadow proxy`);
    const runtime = game.attachActorAnimations(actor, character, gltf.animations, () => ({ x: 1, y: 1 }));
    assert.equal(runtime.qa.shadowSkeletonShared, true, `${character} mixer/shadow shared skeleton`);

    const arm = bones.find((bone) => bone.name === "LeftUpperArm");
    const armIndex = shadow.proxy.skeleton.bones.indexOf(arm);
    const skinIndex = shadow.proxy.geometry.getAttribute("skinIndex");
    let armVertex = -1;
    for (let index = 0; index < skinIndex.count; index += 1) {
      if (skinIndex.getX(index) === armIndex) {
        armVertex = index;
        break;
      }
    }
    assert.ok(armVertex >= 0, `${character} articulated arm shadow segment`);
    const before = skinnedWorldPosition(shadow.proxy, armVertex);
    for (const gaitWeight of [1 / 3, 2 / 3, 1]) {
      game.updateActorAnimations(actor, 0.05, Math.PI, {
        role: character,
        moving: true,
        gaitWeight,
        caught: false,
        won: false,
        reducedMotion: false,
        seesPlayer: character === "villain",
        searchHolding: false,
        turnDelta: 0,
      });
    }
    actor.updateMatrixWorld(true);
    const after = skinnedWorldPosition(shadow.proxy, armVertex);
    assert.ok(after.distanceTo(before) > 0.001, `${character} clip-driven shadow deformation`);
  }
});
