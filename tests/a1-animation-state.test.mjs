import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { loadGameModule } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = await loadGameModule(ROOT, "a1-animation-state");

const makeClip = (name, angle = 0.08) => new THREE.AnimationClip(name, 1, [
  new THREE.QuaternionKeyframeTrack("Hips.quaternion", [0, 1], [
    0, 0, 0, 1,
    0, Math.sin(angle / 2), 0, Math.cos(angle / 2),
  ]),
]);

const clips = game.ACTOR_CLIP_NAMES.map((name, index) => makeClip(`Anim_${name}`, 0.03 * (index + 1)));

const makeActor = (role, getPlayer, animationOptions) => {
  const actor = new THREE.Group();
  const visual = new THREE.Group();
  visual.userData.baseY = 0;
  actor.add(visual);
  actor.userData.visual = visual;
  const rigRoot = new THREE.Group();
  rigRoot.name = "Rig_Humanoid_Shared";
  const hips = new THREE.Bone();
  hips.name = "Hips";
  rigRoot.add(hips);
  visual.add(rigRoot);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 8), new THREE.MeshBasicMaterial());
  actor.add(ring);
  actor.userData.ring = ring;
  actor.userData.actorBatch = { afterMeshes: role === "kid" ? 13 : role === "villain" ? 6 : 11 };
  game.attachActorAnimations(actor, role, clips, getPlayer, animationOptions);
  return { actor, hips };
};

const addBone = (parent, name, position) => {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.copy(position);
  parent.add(bone);
  return bone;
};

const makeShadowActor = () => {
  const actor = new THREE.Group();
  const visual = new THREE.Group();
  visual.userData.baseY = 0;
  actor.add(visual);
  actor.userData.visual = visual;
  const hips = addBone(visual, "Hips", new THREE.Vector3(0, 0.9, 0));
  const chest = addBone(hips, "Chest", new THREE.Vector3(0, 0.45, 0));
  const neck = addBone(chest, "Neck", new THREE.Vector3(0, 0.28, 0));
  addBone(neck, "Head", new THREE.Vector3(0, 0.18, 0));
  const leftUpperArm = addBone(chest, "LeftUpperArm", new THREE.Vector3(-0.28, 0.18, 0));
  const leftLowerArm = addBone(leftUpperArm, "LeftLowerArm", new THREE.Vector3(-0.34, 0, 0));
  addBone(leftLowerArm, "LeftHand", new THREE.Vector3(-0.28, 0, 0));
  const rightUpperArm = addBone(chest, "RightUpperArm", new THREE.Vector3(0.28, 0.18, 0));
  const rightLowerArm = addBone(rightUpperArm, "RightLowerArm", new THREE.Vector3(0.34, 0, 0));
  addBone(rightLowerArm, "RightHand", new THREE.Vector3(0.28, 0, 0));
  const leftUpperLeg = addBone(hips, "LeftUpperLeg", new THREE.Vector3(-0.14, -0.08, 0));
  const leftLowerLeg = addBone(leftUpperLeg, "LeftLowerLeg", new THREE.Vector3(0, -0.5, 0));
  const leftFoot = addBone(leftLowerLeg, "LeftFoot", new THREE.Vector3(0, -0.45, 0.05));
  addBone(leftFoot, "LeftToes", new THREE.Vector3(0, 0, 0.28));
  const rightUpperLeg = addBone(hips, "RightUpperLeg", new THREE.Vector3(0.14, -0.08, 0));
  const rightLowerLeg = addBone(rightUpperLeg, "RightLowerLeg", new THREE.Vector3(0, -0.5, 0));
  const rightFoot = addBone(rightLowerLeg, "RightFoot", new THREE.Vector3(0, -0.45, 0.05));
  addBone(rightFoot, "RightToes", new THREE.Vector3(0, 0, 0.28));
  actor.updateMatrixWorld(true);
  const bones = [];
  actor.traverse((object) => { if (object instanceof THREE.Bone) bones.push(object); });
  const skeleton = new THREE.Skeleton(bones);
  skeleton.calculateInverses();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0.2, 0, 0, 0, 0.4, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(12), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setIndex([0, 1, 2]);
  const source = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  visual.add(source);
  source.bind(skeleton, new THREE.Matrix4());
  actor.updateMatrixWorld(true);
  actor.userData.actorBatch = { afterMeshes: 1 };
  const shadow = game.createActorShadowProxy(actor);
  return { actor, leftUpperArm, shadow: shadow.proxy };
};

const skinnedWorldPosition = (mesh, index) => {
  const position = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), index);
  return mesh.localToWorld(mesh.applyBoneTransform(index, position));
};

const baseContext = (overrides = {}) => ({
  role: "kid",
  moving: false,
  gaitWeight: 0,
  caught: false,
  won: false,
  reducedMotion: false,
  seesPlayer: false,
  searchHolding: false,
  turnDelta: 0,
  ...overrides,
});

test("A1 indexes all nine embedded glTF clips by canonical name", () => {
  assert.equal(game.canonicalActorClipName("Anim_LookAround.001"), "LookAround");
  assert.equal(game.canonicalActorClipName("Rig|Anim_ScaredCaught"), "ScaredCaught");
  assert.equal(game.canonicalActorClipName("unknown"), null);
  const indexed = game.indexActorClips(clips);
  assert.deepEqual(indexed.missing, []);
  assert.deepEqual(Object.keys(indexed.indexed), game.ACTOR_CLIP_NAMES);
});

test("A1 state mapping covers locomotion, search, capture, and victory without overriding damped root turns", () => {
  assert.deepEqual(game.selectActorAnimationPlan(baseContext()), { base: "Idle", special: null, reason: "idle" });
  assert.deepEqual(game.selectActorAnimationPlan(baseContext({ moving: true })), { base: "Run", special: null, reason: "player-run" });
  assert.deepEqual(game.selectActorAnimationPlan(baseContext({ role: "villain", moving: true })), { base: "Walk", special: null, reason: "patrol-or-search-walk" });
  assert.deepEqual(game.selectActorAnimationPlan(baseContext({ role: "villain", moving: true, seesPlayer: true })), { base: "Run", special: null, reason: "chase-run" });
  assert.deepEqual(game.selectActorAnimationPlan(baseContext({ role: "villain", searchHolding: true })), { base: "Idle", special: "LookAround", reason: "search-hold" });
  assert.deepEqual(game.selectActorAnimationPlan(baseContext({ caught: true })), { base: "Idle", special: "ScaredCaught", reason: "capture" });
  assert.deepEqual(game.selectActorAnimationPlan(baseContext({ won: true })), { base: "Idle", special: "Celebrate", reason: "victory-celebrate" });
  assert.deepEqual(game.selectActorAnimationPlan(baseContext({ role: "police", won: true })), { base: "Idle", special: "PointAlert", reason: "victory-point" });
  assert.equal(game.selectActorAnimationPlan(baseContext({ role: "villain", won: true, turnDelta: 0.5 })).special, null);
  assert.deepEqual(
    game.selectActorAnimationPlan(baseContext({ role: "police", turnDelta: 0.5 })),
    { base: "Idle", special: null, reason: "idle" },
    "the existing P1 root-heading damping stays authoritative; turn clips remain QA-auditionable",
  );
  assert.deepEqual(
    game.selectActorAnimationPlan(baseContext({ role: "police", turnDelta: -0.5 })),
    { base: "Idle", special: null, reason: "idle" },
  );
  for (const reducedContext of [
    baseContext({ role: "villain", searchHolding: true, reducedMotion: true }),
    baseContext({ won: true, reducedMotion: true }),
    baseContext({ role: "police", won: true, turnDelta: 0.5, reducedMotion: true }),
    baseContext({ role: "police", turnDelta: -0.5, reducedMotion: true }),
  ]) {
    assert.deepEqual(game.selectActorAnimationPlan(reducedContext), { base: "Idle", special: null, reason: "reduced-idle" });
  }
});

test("A1 configures locomotion/search loops and clamps every one-shot", () => {
  const runtime = makeActor("kid", () => ({ x: 1, y: 1 })).actor.userData.animationRuntime;
  for (const name of ["Idle", "Run", "Walk", "LookAround"]) {
    assert.equal(runtime.actions[name].loop, THREE.LoopRepeat, `${name} loop mode`);
  }
  for (const name of ["TurnLeft", "TurnRight", "ScaredCaught", "Celebrate", "PointAlert"]) {
    assert.equal(runtime.actions[name].loop, THREE.LoopOnce, `${name} loop mode`);
    assert.equal(runtime.actions[name].clampWhenFinished, true, `${name} clamp`);
  }
});

test("A1 AnimationMixer follows the existing 0.15 second gait blend and writes serializable QA", () => {
  let player = { x: 1, y: 1 };
  const { actor, hips } = makeActor("kid", () => player);
  actor.position.copy(game.world(player));
  game.poseRig(actor, 0, 0);

  player = { x: 1.1, y: 1 };
  game.syncActor(actor, player, 0, 0.05);
  const first = actor.userData.motion.animation;
  assert.equal(first.source, "embedded-gltf");
  assert.deepEqual(first.availableClips, game.ACTOR_CLIP_NAMES);
  assert.deepEqual(first.missingClips, []);
  assert.equal(first.currentClip, "Run");
  assert.ok(Math.abs(first.weights.Idle - 2 / 3) < 1e-9);
  assert.ok(Math.abs(first.weights.Run - 1 / 3) < 1e-9);
  assert.equal(first.transitionSeconds, 0.15);
  assert.equal(first.batchMeshes, 13);
  assert.doesNotThrow(() => JSON.stringify(first));

  for (const x of [1.2, 1.3]) {
    player = { x, y: 1 };
    game.syncActor(actor, player, 0, 0.05);
  }
  assert.equal(actor.userData.motion.gaitWeight, 1);
  assert.equal(actor.userData.motion.animation.weights.Run, 1);
  assert.ok(Math.abs(hips.quaternion.y) > 0, "the real mixer must apply a bone track");
});

test("A1 QA reads isolated snapshots and the existing resource cleanup stops the mixer", () => {
  let player = { x: 1, y: 1 };
  const { actor } = makeActor("kid", () => player);
  actor.position.copy(game.world(player));
  game.poseRig(actor, 0, 0);
  player = { x: 1.1, y: 1 };
  game.syncActor(actor, player, 0, 0.05);

  const first = actor.userData.motion.animation;
  assert.equal(first.cleanupBound, true);
  first.weights.Run = 99;
  first.activeClips.push("Celebrate");
  const second = actor.userData.motion.animation;
  assert.notEqual(second, first);
  assert.ok(second.weights.Run < 1);
  assert.equal(second.activeClips.includes("Celebrate"), false);

  actor.userData.ring.geometry.dispose();
  assert.equal(actor.userData.animationRuntime, undefined);
  assert.equal("animation" in actor.userData.motion, false);
});

test("A1 inferred gameplay states select search, capture, victory, and reduced-motion fallbacks", () => {
  let player = { x: 1, y: 1 };
  const getPlayer = () => player;
  const villain = makeActor("villain", getPlayer).actor;
  const villainPoint = { x: 7, y: 1 };
  villain.position.copy(game.world(villainPoint));
  game.syncActor(villain, villainPoint, 2, 0.05, { authoredHeading: 0, dampHeading: false });
  game.syncActor(villain, villainPoint, 2, 0.05, { authoredHeading: 0.1, dampHeading: false });
  assert.equal(villain.userData.motion.animation.currentClip, "LookAround");
  assert.equal(villain.userData.motion.animation.reason, "search-hold");

  const kid = makeActor("kid", getPlayer).actor;
  kid.position.copy(game.world(player));
  game.syncActor(kid, player, 0, 0.05, { freezePose: true });
  assert.equal(kid.userData.motion.animation.currentClip, "ScaredCaught");
  assert.ok(kid.userData.motion.animation.weights.ScaredCaught > 0);

  player = { ...game.EXIT };
  const readyKid = makeActor("kid", () => player).actor;
  readyKid.position.copy(game.world(player));
  game.syncActor(readyKid, player, 0, 0.05);
  assert.equal(readyKid.userData.motion.animation.currentClip, "Idle", "ready QA placement must not fake a win");

  const victoryKid = makeActor("kid", getPlayer).actor;
  victoryKid.position.copy(game.world(player));
  game.poseRig(victoryKid, 0, 0);
  game.syncActor(victoryKid, player, 0, 0.05);
  assert.equal(victoryKid.userData.motion.animation.currentClip, "Celebrate");
  game.poseRig(victoryKid, 0, 0);
  assert.equal(victoryKid.userData.motion.animation.currentClip, "Idle");
  assert.equal(victoryKid.userData.motion.animation.weights.Celebrate, 0, "reset must clear a stale one-shot");

  const police = makeActor("police", getPlayer).actor;
  police.position.copy(game.world(game.POLICE_POINT));
  game.syncActor(police, game.POLICE_POINT, 4, 0.05);
  assert.equal(police.userData.motion.animation.currentClip, "PointAlert");

  const reducedKid = makeActor("kid", getPlayer).actor;
  reducedKid.position.copy(game.world(player));
  game.syncActor(reducedKid, player, 0, 0.05, { idleBreathScale: game.P4_TUNING.reducedIdleBreathScale });
  assert.equal(reducedKid.userData.motion.animation.currentClip, "Idle");
  assert.equal(reducedKid.userData.motion.animation.reducedMotion, true);
  assert.equal(reducedKid.userData.motion.animation.weights.Celebrate, 0);
});

test("A1 locomotion keeps 0.15 second start, stop, and Walk-to-Run crossfades", () => {
  const { actor } = makeActor("villain", () => ({ x: 1, y: 1 }));
  const runtime = actor.userData.animationRuntime;
  for (const gaitWeight of [1 / 3, 2 / 3, 1]) {
    game.updateActorAnimations(actor, 0.05, gaitWeight * Math.PI, baseContext({
      role: "villain",
      moving: true,
      gaitWeight,
    }));
  }
  assert.equal(runtime.qa.weights.Walk, 1);
  assert.equal(runtime.qa.weights.Run, 0);

  game.updateActorAnimations(actor, 0.05, Math.PI, baseContext({
    role: "villain",
    moving: true,
    gaitWeight: 1,
    seesPlayer: true,
  }));
  assert.ok(Math.abs(runtime.qa.weights.Walk - 2 / 3) < 1e-9);
  assert.ok(Math.abs(runtime.qa.weights.Run - 1 / 3) < 1e-9);
  for (let index = 0; index < 2; index += 1) {
    game.updateActorAnimations(actor, 0.05, Math.PI, baseContext({
      role: "villain",
      moving: true,
      gaitWeight: 1,
      seesPlayer: true,
    }));
  }
  assert.equal(runtime.qa.weights.Walk, 0);
  assert.equal(runtime.qa.weights.Run, 1);

  for (const gaitWeight of [2 / 3, 1 / 3, 0]) {
    game.updateActorAnimations(actor, 0.05, gaitWeight * Math.PI, baseContext({
      role: "villain",
      moving: false,
      gaitWeight,
    }));
  }
  assert.equal(runtime.qa.weights.Run, 0);
  assert.equal(runtime.qa.weights.Idle, 1);
});

test("A1 completes and latches the caught pose without changing the 600ms gameplay freeze", () => {
  const { actor } = makeActor("kid", () => ({ x: 1, y: 1 }));
  const runtime = actor.userData.animationRuntime;
  const expectedRate = runtime.clips.ScaredCaught.duration / (game.P0_TUNING.captureFreezeMs / 1000);
  assert.ok(Math.abs(game.captureClipTimeScale(runtime.clips.ScaredCaught.duration) - expectedRate) < 1e-12);

  for (let frame = 0; frame < 12; frame += 1) {
    game.updateActorAnimations(actor, 0.05, 0, baseContext({ caught: true }));
  }
  assert.equal(runtime.qa.currentClip, "ScaredCaught");
  assert.equal(runtime.qa.captureLatched, true);
  assert.ok(Math.abs(runtime.qa.timeScales.ScaredCaught - expectedRate) < 1e-6);
  assert.ok(runtime.qa.clipTimes.ScaredCaught >= runtime.clips.ScaredCaught.duration - 1e-6);
  assert.equal(runtime.qa.weights.ScaredCaught, 1);

  game.updateActorAnimations(actor, 0.2, 0, baseContext({ caught: false }));
  assert.equal(runtime.qa.currentClip, "ScaredCaught", "lost presentation must keep the clamped pose");
  assert.equal(runtime.qa.weights.ScaredCaught, 1);
  assert.equal(runtime.qa.clipTimes.ScaredCaught, runtime.clips.ScaredCaught.duration);

  game.resetActorAnimations(actor);
  assert.equal(runtime.qa.captureLatched, false);
  assert.equal(runtime.qa.currentClip, "Idle");
  assert.equal(runtime.qa.weights.ScaredCaught, 0);
});

test("A1 QA audition plays TurnLeft and TurnRight through the real mixer", () => {
  for (const auditionClip of ["TurnLeft", "TurnRight"]) {
    const { actor, hips } = makeActor("police", () => ({ x: 1, y: 1 }), { auditionClip });
    const before = hips.quaternion.clone();
    game.updateActorAnimations(actor, 0.2, 0, baseContext({ role: "police" }));
    const qa = actor.userData.animationRuntime.qa;
    assert.equal(qa.currentClip, auditionClip);
    assert.equal(qa.reason, "qa-audition");
    assert.equal(qa.weights[auditionClip], 1);
    assert.ok(qa.clipTimes[auditionClip] > 0);
    assert.ok(hips.quaternion.angleTo(before) > 0, `${auditionClip} must update a bone`);
  }
});

test("A1 mixer-driven bones continue to drive the P4-3 articulated shadow proxy", () => {
  const { actor, leftUpperArm, shadow } = makeShadowActor();
  assert.ok(shadow instanceof THREE.SkinnedMesh);
  const animatedClips = game.ACTOR_CLIP_NAMES.map((name, index) => new THREE.AnimationClip(`Anim_${name}`, 1, [
    new THREE.QuaternionKeyframeTrack("LeftUpperArm.quaternion", [0, 1], [
      0, 0, 0, 1,
      0, 0, Math.sin((0.12 + index * 0.02) / 2), Math.cos((0.12 + index * 0.02) / 2),
    ]),
  ]));
  const runtime = game.attachActorAnimations(actor, "kid", animatedClips, () => ({ x: 1, y: 1 }));
  assert.equal(runtime.qa.shadowProxyCreated, true);
  assert.equal(runtime.qa.shadowSkeletonShared, true);

  const armIndex = shadow.skeleton.bones.indexOf(leftUpperArm);
  const skinIndex = shadow.geometry.getAttribute("skinIndex");
  let armVertex = -1;
  for (let index = 0; index < skinIndex.count; index += 1) {
    if (skinIndex.getX(index) === armIndex) {
      armVertex = index;
      break;
    }
  }
  assert.ok(armVertex >= 0);
  const before = skinnedWorldPosition(shadow, armVertex);
  game.updateActorAnimations(actor, 0.05, Math.PI, baseContext({ moving: true, gaitWeight: 1 }));
  actor.updateMatrixWorld(true);
  const after = skinnedWorldPosition(shadow, armVertex);
  assert.ok(after.distanceTo(before) > 0.001, "the proxy silhouette must follow an AnimationMixer bone pose");
});
