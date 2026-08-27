import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { loadGameModule } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = await loadGameModule(ROOT, "p4-presentation");
const [component, css] = await Promise.all([
  readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8"),
  readFile(path.join(ROOT, "app", "globals.css"), "utf8"),
]);

test("P4-6 victory direction faces away from the exit without changing gameplay heading", () => {
  assert.equal(game.victoryAwayHeading({ x: 21, y: 21 }, game.EXIT), -Math.PI * 0.75);
  assert.equal(game.victoryAwayHeading({ x: 23, y: 21 }, game.EXIT), Math.PI);
  assert.match(component, /gameplayHeading:\s*villainHeading\.current/u);
  assert.match(component, /victoryAwayHeading\(villain\.current\)/u);
  assert.match(component, /villainSyncOptions\.dampHeading = true/u);
  assert.doesNotMatch(component, /villainHeading\.current\s*=\s*victoryAwayHeading/u);
});

test("P4-6 a stationary victory pose eases gait and heading instead of freezing animation state", () => {
  const actor = new THREE.Group();
  const visual = new THREE.Group();
  visual.userData.baseY = 0;
  actor.add(visual);
  actor.userData.visual = visual;
  actor.userData.rig = {};
  actor.userData.motion = {
    gaitWeight: 1,
    gaitPhase: 2,
    actualSpeed: 3,
    heading: 0,
    targetHeading: 0,
    visualY: 0,
    baseVisualY: 0,
  };
  actor.position.copy(game.world({ x: 1, y: 1 }));

  const options = {
    authoredHeading: Math.PI,
    dampHeading: true,
    headingDamping: game.P4_TUNING.victoryTurnDamping,
    idleBreathScale: game.P4_TUNING.reducedIdleBreathScale,
  };
  game.syncActor(actor, { x: 1, y: 1 }, 0, 0.05, options);

  assert.ok(actor.userData.motion.gaitWeight < 1 && actor.userData.motion.gaitWeight > 0);
  assert.ok(Math.abs(actor.userData.motion.heading) > 0);
  assert.equal(actor.userData.motion.actualSpeed, 0);
  for (let index = 0; index < 3; index += 1) {
    game.syncActor(actor, { x: 1, y: 1 }, 0, 0.05, options);
  }
  assert.equal(actor.userData.motion.gaitWeight, 0);
  assert.ok(Math.abs(visual.position.y) <= 0.018 * game.P4_TUNING.reducedIdleBreathScale + 1e-9);
});

test("P4-7 ready camera is subtle, slow, smoothly blended, and honors reduced motion", () => {
  assert.deepEqual(game.P4_TUNING, {
    shadowHalfExtent: 16,
    shadowMapSize: 1024,
    maxTextureAnisotropy: 8,
    exitPulsePeriodMs: 1600,
    victoryTurnDamping: 6,
    readyCameraDistanceAmplitude: 0.34,
    readyCameraLateralAmplitude: 0.18,
    readyCameraPeriodMs: 9000,
    readyCameraBlendDamping: 2.6,
    reducedIdleBreathScale: 0.5,
  });
  assert.match(component, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/u);
  assert.match(component, /readyCameraTarget[\s\S]*readyCameraBlendDamping/u);
  assert.match(component, /readyDistanceOffset[\s\S]*readyCameraDistanceAmplitude/u);
  assert.match(component, /readyLateralOffset[\s\S]*readyCameraLateralAmplitude/u);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/u);
  assert.match(css, /\.loader-dot\s*\{[^}]*animation:none/u);
});

test("P4-8 phase announcements, focus handoff, and interactive-key guard stay wired", () => {
  assert.match(component, /aria-live="assertive" aria-atomic="true"/u);
  assert.match(component, /ref=\{overlayAction\}/u);
  assert.match(component, /overlayAction\.current\?\.focus\(\)/u);
  assert.match(component, /target\.closest\("button,input,select,textarea,a\[href\],\[contenteditable='true'\]"\)/u);
  assert.match(component, /previous === "ready" \? "逃跑开始" : "游戏已重新开始"/u);
  for (const copy of [
    "准备校园场景与角色",
    "核心资源载入进度",
    "正在补充场景细节",
    "重新加载",
    "你被追捕者抓住了",
    "成功逃脱，警察已在出口接应",
  ]) assert.match(component, new RegExp(copy, "u"));
  assert.match(css, /\.primary:focus-visible/u);
  assert.match(css, /\.sr-only\s*\{/u);
});
