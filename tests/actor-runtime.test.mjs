import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ActorAnimator } from "../app/game/animation/actor-runtime.ts";

function clip(name, duration = 1) {
  return new THREE.AnimationClip(name, duration, [
    new THREE.NumberKeyframeTrack(".position[x]", [0, duration], [0, 1]),
  ]);
}

test("ActorAnimator fails loudly when a required production clip is missing", () => {
  const animator = new ActorAnimator(new THREE.Group(), [clip("Kid_Idle_Breathe_A")], {
    idle: "Kid_Idle_Breathe_A",
    run: "Kid_Run",
  });
  assert.throws(() => animator.require(["idle", "run"]), /Missing production animation states: run/);
  animator.dispose();
});

test("ActorAnimator cross-fades approved clips and emits authored markers", () => {
  const root = new THREE.Group();
  const animator = new ActorAnimator(
    root,
    [clip("Kid_Idle_Breathe_A", 2), clip("Kid_Run", 1)],
    { idle: "Kid_Idle_Breathe_A", run: "Kid_Run" },
    { run: [{ name: "footLContact", normalizedTime: 0.25 }] },
  );
  const markers = [];
  animator.setMarkerListener((_state, marker) => markers.push(marker.name));
  animator.require(["idle", "run"]);
  animator.play("idle", { fade: 0 });
  animator.update(0.1);
  animator.play("run", { fade: 0.15 });
  animator.update(0.3);
  assert.equal(animator.snapshot().state, "run");
  assert.deepEqual(markers, ["footLContact"]);
  animator.dispose();
});

test("ActorAnimator explicitly restarts a finished in-place turn for a 180-degree pivot", () => {
  const animator = new ActorAnimator(
    new THREE.Group(),
    [clip("TurnLeft", 0.6)],
    { turnLeft: "TurnLeft" },
  );
  animator.play("turnLeft", { loop: false, fade: 0 });
  animator.update(0.6);
  animator.play("turnLeft", { loop: false, restart: true, fade: 0 });
  const restarted = animator.snapshot();
  assert.equal(restarted.state, "turnLeft");
  assert.equal(restarted.playing, true);
  assert.ok(restarted.normalizedTime < 1e-9);
  animator.dispose();
});
