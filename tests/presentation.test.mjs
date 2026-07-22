import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import {
  baseCameraDistanceForAspect,
  boundedFrameDeltaSeconds,
  canChaserTakeLockerDoor,
  chaserAnimationForMode,
  lockerVisionMix,
  requiredCameraDistanceForFraming,
  shouldFrameChaser,
  shouldRenderChaserModel,
  smoothOcclusionStrength,
} from "../app/game/presentation.ts";

test("last-known pursuit and arrival scan use authored locomotion and search performances", () => {
  assert.equal(chaserAnimationForMode("lost-sight", 1.8, false), "run");
  assert.equal(chaserAnimationForMode("lost-sight", 0, false), "idle");
  assert.equal(chaserAnimationForMode("go-to-last-known", 1.8, false), "run");
  assert.equal(chaserAnimationForMode("go-to-last-known", 0, false), "idle");
  assert.equal(chaserAnimationForMode("scan-last-known", 0, false), "search");
  assert.equal(chaserAnimationForMode("search", 0.7, false), "walk");
});

const mix = (mode, transitionRemainingSeconds) => lockerVisionMix(
  { mode, transitionRemainingSeconds },
  DEFAULT_GAME_CONFIG,
);

test("locker mask closes exactly by the hide-entry safety marker", () => {
  assert.deepEqual(mix("entering-hide", DEFAULT_GAME_CONFIG.hideEnterSeconds), { cover: 0, peek: 0 });
  const atSafeMarker = mix(
    "entering-hide",
    DEFAULT_GAME_CONFIG.hideEnterSeconds - DEFAULT_GAME_CONFIG.hideEnterExposureSeconds,
  );
  assert.equal(atSafeMarker.cover, 1);
  assert.equal(atSafeMarker.peek, 0);
});

test("locker mask stays closed until the authored exit exposure marker", () => {
  assert.deepEqual(mix("exiting-hide", DEFAULT_GAME_CONFIG.hideExitSeconds), { cover: 1, peek: 0 });
  const justBefore = mix(
    "exiting-hide",
    DEFAULT_GAME_CONFIG.hideExitSeconds - DEFAULT_GAME_CONFIG.hideExitExposureSeconds + 0.01,
  );
  assert.equal(justBefore.cover, 1);
  const fullyOpen = mix(
    "exiting-hide",
    DEFAULT_GAME_CONFIG.hideExitSeconds - DEFAULT_GAME_CONFIG.hideExitExposureSeconds - 0.28,
  );
  assert.equal(fullyOpen.cover, 0);
});

test("peek mask opens and closes continuously instead of popping", () => {
  assert.deepEqual(mix("hidden", 0), { cover: 1, peek: 0 });
  const openingHalf = mix("entering-peek", DEFAULT_GAME_CONFIG.peekEnterSeconds / 2);
  assert.ok(Math.abs(openingHalf.cover - 0.5) < 1e-9);
  assert.ok(Math.abs(openingHalf.peek - 0.5) < 1e-9);
  assert.deepEqual(mix("peeking", 0), { cover: 0, peek: 1 });
  const closingHalf = mix("exiting-peek", DEFAULT_GAME_CONFIG.peekExitSeconds / 2);
  assert.ok(Math.abs(closingHalf.cover - 0.5) < 1e-9);
  assert.ok(Math.abs(closingHalf.peek - 0.5) < 1e-9);
});

test("camera occlusion fades in quickly and restores smoothly at any frame rate", () => {
  const run = (hz, obscured, seconds, initial = 0) => {
    let value = initial;
    for (let frame = 0; frame < hz * seconds; frame += 1) {
      value = smoothOcclusionStrength(value, obscured, 1 / hz);
    }
    return value;
  };
  // Durations are an exact integer frame count at every cadence so this
  // asserts the damping equation, not JavaScript loop rounding at 7.5 frames.
  const attacks = [30, 60, 120].map((hz) => run(hz, true, 0.4));
  const releases = [30, 60, 120].map((hz) => run(hz, false, 0.6, attacks[0]));
  assert.ok(attacks.every((value) => value > 0.99));
  assert.ok(releases.every((value) => value < 0.04));
  assert.ok(Math.max(...attacks) - Math.min(...attacks) < 1e-9);
  assert.ok(Math.max(...releases) - Math.min(...releases) < 1e-9);
});

test("render timing preserves real time at 10 FPS and bounds only long stalls", () => {
  assert.ok(Math.abs(boundedFrameDeltaSeconds(1_000, 1_100, 0.25) - 0.1) < 1e-12);
  assert.equal(boundedFrameDeltaSeconds(1_000, 11_000, 0.25), 0.25);
  assert.equal(boundedFrameDeltaSeconds(1_100, 1_000, 0.25), 0);
  assert.equal(boundedFrameDeltaSeconds(Number.NaN, 1_000, 0.25), 0);
});

test("a chaser check can never cancel an active player door performance", () => {
  const idle = {
    owner: "idle",
    hasAction: false,
    actionRunning: false,
    queuedActions: 0,
    peeking: false,
    peekClosing: false,
  };
  assert.equal(canChaserTakeLockerDoor(idle), true);
  for (const busy of [
    { ...idle, owner: "player", hasAction: true, actionRunning: true },
    { ...idle, owner: "player", queuedActions: 1 },
    { ...idle, owner: "player", peeking: true },
    { ...idle, owner: "player", peekClosing: true },
    { ...idle, owner: "chaser", hasAction: true, actionRunning: true },
  ]) {
    assert.equal(canChaserTakeLockerDoor(busy), false);
  }
});

test("chaser world rendering never inherits the HUD knowledge gate", () => {
  assert.equal(shouldRenderChaserModel("ready", false), true);
  assert.equal(shouldRenderChaserModel("playing", true), true);
  assert.equal(shouldRenderChaserModel("playing", false), false, "a closed locker cannot leak world positions");
  assert.equal(shouldRenderChaserModel("lost", false), true);
  assert.equal(shouldRenderChaserModel("won", true), false);
});

test("every observable spawned chaser pre-frames first sight and reacquisition", () => {
  for (const mode of ["patrol", "suspicious", "chase", "lost-sight", "go-to-last-known", "scan-last-known", "search", "check-hide"]) {
    assert.equal(shouldFrameChaser("playing", mode, true), true, `${mode} should frame both actors`);
  }
  assert.equal(shouldFrameChaser("playing", "spawn-delay", true), false);
  assert.equal(shouldFrameChaser("playing", "search", false), false, "walls must not leak pursuer position");
  assert.equal(shouldFrameChaser("won", "chase", true), false);
});

test("portrait chase framing derives a safe distance from FOV and actor separation", () => {
  const focus = { x: 0, y: 0.92, z: 0 };
  const points = [
    { x: -7, y: 0.92, z: 0 },
    { x: 7, y: 1.05, z: 0 },
  ];
  const cameraDirection = { x: 0, y: 0.8164156395068652, z: -0.5774647206268071 };
  const portrait = requiredCameraDistanceForFraming({
    focus,
    points,
    cameraDirection,
    verticalFovDegrees: 56,
    aspect: 0.5,
  });
  const desktop = requiredCameraDistanceForFraming({
    focus,
    points,
    cameraDirection,
    verticalFovDegrees: 56,
    aspect: 16 / 9,
  });
  assert.ok(portrait > 35 && portrait < 38, `unexpected portrait distance ${portrait}`);
  assert.ok(desktop < 14, `desktop framing should not over-zoom: ${desktop}`);

  const readablePortrait = requiredCameraDistanceForFraming({
    focus,
    points,
    cameraDirection,
    verticalFovDegrees: 56,
    aspect: 0.5,
    horizontalMargin: 0.38,
    verticalMargin: 0.92,
    safeHorizontalNdc: 0.9,
    safeVerticalNdc: 0.84,
  });
  assert.ok(readablePortrait > 29 && readablePortrait < 32, `unexpected readable portrait distance ${readablePortrait}`);
  assert.ok(readablePortrait < portrait * 0.88, "portrait framing must materially enlarge both actors");
});

test("portrait baseline keeps actors readable without weakening safe framing", () => {
  assert.equal(baseCameraDistanceForAspect(16 / 9), 16.25);
  assert.equal(baseCameraDistanceForAspect(0.46), 14.25);
  assert.ok(baseCameraDistanceForAspect(0.7) > 14.25);
  assert.ok(baseCameraDistanceForAspect(0.7) < 16.25);
  assert.equal(baseCameraDistanceForAspect(Number.NaN), 16.25);
});
