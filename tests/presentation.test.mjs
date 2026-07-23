import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import {
  actorReadabilityRimStrength,
  baseCameraDistanceForAspect,
  boundedFrameDeltaSeconds,
  cameraDistanceScaleForPlayerMode,
  cameraFocusForEdgeHide,
  cameraFocusForSafeViewport,
  cameraFocusForTraversalEdge,
  cameraSafeViewportFromInsets,
  canChaserTakeLockerDoor,
  chaserAnimationForMode,
  createFixedCameraFollowState,
  fixedCameraCompositionConstraints,
  gameplayCameraInsetsForViewport,
  lockerObservationExposureMultiplier,
  lockerVisionMix,
  maximumCameraDistanceForActorReadability,
  projectPointToFixedCameraNdc,
  projectedActorScreenHeightPixels,
  requiredCameraDistanceForFraming,
  shouldFrameChaser,
  shouldRenderChaserModel,
  smoothOcclusionStrength,
  stepFixedCameraFollow,
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

test("locker observation adapts exposure only through an opened peek slit", () => {
  assert.equal(lockerObservationExposureMultiplier({ cover: 1, peek: 0 }), 1);
  assert.equal(lockerObservationExposureMultiplier({ cover: 1, peek: 1 }), 1);
  assert.equal(lockerObservationExposureMultiplier({ cover: 0, peek: 1 }), 1.18);
  const openingHalf = lockerObservationExposureMultiplier({ cover: 0.5, peek: 0.5 });
  assert.ok(Math.abs(openingHalf - 1.045) < 1e-12);
});

test("authored actor rim stays depth-honest and prioritizes an active pursuer", () => {
  assert.equal(actorReadabilityRimStrength("chaser", "chase", false), 0);
  assert.ok(
    actorReadabilityRimStrength("chaser", "chase")
      > actorReadabilityRimStrength("chaser", "patrol"),
  );
  assert.ok(actorReadabilityRimStrength("chaser", "search") > 0.3);
  assert.ok(actorReadabilityRimStrength("player", "spawn-delay") > 0.2);
  assert.ok(actorReadabilityRimStrength("ally", "chase") < actorReadabilityRimStrength("player", "chase"));
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

test("fixed-bearing follow keeps routine movement in a dead zone and holds a legal threat frame", () => {
  let follow = createFixedCameraFollowState({ x: 0, y: 1, z: 0 });
  follow = stepFixedCameraFollow(follow, {
    playerFocus: { x: 0.8, y: 1, z: 0 },
    deltaSeconds: 1 / 60,
    deadZoneRadius: 1,
  });
  assert.deepEqual(follow.focus, { x: 0, y: 1, z: 0 }, "small movement must not pan the fixed view");

  follow = stepFixedCameraFollow(follow, {
    playerFocus: { x: 4, y: 1, z: 0 },
    deltaSeconds: 1 / 60,
    deadZoneRadius: 1,
  });
  assert.deepEqual(follow.focus, { x: 3, y: 1, z: 0 }, "follow only enough to restore the dead-zone edge");

  follow = stepFixedCameraFollow(follow, {
    playerFocus: { x: 4, y: 1, z: 0 },
    observableThreatFocus: { x: 10, y: 1, z: 0 },
    deltaSeconds: 1 / 60,
    deadZoneRadius: 1,
    threatHoldSeconds: 0.5,
  });
  assert.deepEqual(follow.focus, { x: 6, y: 1, z: 0 }, "an observed threat composes both actors without rotating");
  assert.equal(follow.threatHoldRemainingSeconds, 0.5);

  follow = stepFixedCameraFollow(follow, {
    playerFocus: { x: 4, y: 1, z: 0 },
    deltaSeconds: 0.25,
    deadZoneRadius: 1,
  });
  assert.equal(follow.heldThreatFocus?.x, 10, "last observable threat persists through the bounded hold");
  follow = stepFixedCameraFollow(follow, {
    playerFocus: { x: 4, y: 1, z: 0 },
    deltaSeconds: 0.25,
    deadZoneRadius: 1,
  });
  assert.equal(follow.heldThreatFocus, null);
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
  assert.equal(baseCameraDistanceForAspect(16 / 9), 14.8);
  assert.equal(baseCameraDistanceForAspect(0.46), 13.200000000000001);
  assert.ok(baseCameraDistanceForAspect(0.7) > 13.2);
  assert.ok(baseCameraDistanceForAspect(0.7) < 14.8);
  assert.equal(baseCameraDistanceForAspect(Number.NaN), 14.8);
});

test("mobile UI insets produce a bounded asymmetric camera-safe viewport", () => {
  const insets = gameplayCameraInsetsForViewport(390, 746, true);
  assert.ok(insets.top >= 70);
  assert.ok(insets.bottom >= 125);
  assert.ok(insets.bottom > insets.top);

  const safe = cameraSafeViewportFromInsets(390, 746, insets);
  assert.ok(safe.minX < 0 && safe.maxX > 0);
  assert.ok(safe.minY < 0 && safe.maxY > 0);
  assert.ok((safe.minY + safe.maxY) / 2 > 0, "bottom controls must move the visual center upward");

  const malformed = cameraSafeViewportFromInsets(0, Number.NaN, {
    left: Number.POSITIVE_INFINITY,
    right: -10,
    top: Number.NaN,
    bottom: 99,
  });
  assert.ok(Object.values(malformed).every(Number.isFinite));
  assert.ok(malformed.minX < malformed.maxX);
  assert.ok(malformed.minY < malformed.maxY);
});

test("safe viewport focus translation preserves azimuth and moves gameplay above controls", () => {
  const focus = { x: 2, y: 0.92, z: -3 };
  const cameraDirection = { x: 0.3451465392455413, y: 0.7308985536964403, z: -0.588779390477688 };
  const safeViewport = cameraSafeViewportFromInsets(
    390,
    746,
    gameplayCameraInsetsForViewport(390, 746, true),
  );
  const shiftedFocus = cameraFocusForSafeViewport({
    focus,
    cameraDirection,
    cameraDistance: 15,
    verticalFovDegrees: 56,
    aspect: 390 / 746,
    safeViewport,
  });
  const projection = projectPointToFixedCameraNdc({
    focus: shiftedFocus,
    point: focus,
    cameraDirection,
    cameraDistance: 15,
    verticalFovDegrees: 56,
    aspect: 390 / 746,
  });
  assert.ok(projection);
  assert.ok(Math.abs(projection.x - (safeViewport.minX + safeViewport.maxX) / 2) < 1e-9);
  assert.ok(Math.abs(projection.y - (safeViewport.minY + safeViewport.maxY) / 2) < 1e-9);
});

test("actor readability returns a maximum distance at the requested pixel height", () => {
  const request = {
    focus: { x: 0, y: 0.92, z: 0 },
    actor: { center: { x: 0, y: 0.76, z: 0 }, height: 1.52 },
    cameraDirection: { x: 0.3451465392455413, y: 0.7308985536964403, z: -0.588779390477688 },
    verticalFovDegrees: 56,
    aspect: 16 / 9,
    viewportHeightPixels: 860,
    minimumScreenHeightPixels: 48,
    minimumDistance: 3,
    maximumDistance: 44,
  };
  const maximum = maximumCameraDistanceForActorReadability(request);
  assert.ok(maximum > 14 && maximum < 24, `unexpected readability distance ${maximum}`);
  const height = projectedActorScreenHeightPixels({ ...request, cameraDistance: maximum });
  assert.ok(Math.abs(height - request.minimumScreenHeightPixels) < 1e-6);
  assert.ok(
    projectedActorScreenHeightPixels({ ...request, cameraDistance: maximum + 1 }) < request.minimumScreenHeightPixels,
  );
});

test("fixed camera composition reports feasible and conflicting two-actor constraints", () => {
  const common = {
    focus: { x: 0, y: 0.92, z: 0 },
    cameraDirection: { x: 0, y: 0.7308985536964403, z: -0.682486121 },
    verticalFovDegrees: 56,
    aspect: 390 / 746,
    viewportHeightPixels: 684,
    minimumActorScreenHeightPixels: 42,
    preferredDistance: 15,
    minimumDistance: 8,
    maximumDistance: 44,
    horizontalMargin: 0.38,
    verticalMargin: 0.92,
    safeViewport: cameraSafeViewportFromInsets(390, 684, { left: 18, right: 18, top: 62, bottom: 118 }),
  };
  const nearby = fixedCameraCompositionConstraints({
    ...common,
    actors: [
      { center: { x: -2, y: 0.76, z: 0 }, height: 1.52 },
      { center: { x: 2, y: 0.94, z: 0 }, height: 1.88 },
    ],
  });
  assert.equal(nearby.feasible, true);
  assert.equal(nearby.framingSatisfied, true);
  assert.equal(nearby.readabilitySatisfied, true);
  assert.ok(nearby.distance >= nearby.requiredFramingDistance);
  assert.ok(nearby.distance <= nearby.maximumReadableDistance);

  const separated = fixedCameraCompositionConstraints({
    ...common,
    actors: [
      { center: { x: -8, y: 0.76, z: 0 }, height: 1.52 },
      { center: { x: 8, y: 0.94, z: 0 }, height: 1.88 },
    ],
  });
  assert.equal(separated.feasible, false);
  assert.equal(separated.framingSatisfied, true, "honest two-actor visibility wins over target pixel size");
  assert.equal(separated.readabilitySatisfied, false);
  assert.ok(separated.requiredFramingDistance > separated.maximumReadableDistance);
});

test("asymmetric touch safe area increases framing only toward the obstructed side", () => {
  const common = {
    focus: { x: 0, y: 0.92, z: 0 },
    cameraDirection: { x: 0, y: 0.73, z: -0.68 },
    verticalFovDegrees: 56,
    aspect: 0.6,
    horizontalMargin: 0.2,
    verticalMargin: 0.5,
    safeViewport: { minX: -0.88, maxX: 0.42, minY: -0.62, maxY: 0.82 },
  };
  const wideSide = requiredCameraDistanceForFraming({
    ...common,
    points: [{ x: 5, y: 0.92, z: 0 }],
  });
  const narrowSide = requiredCameraDistanceForFraming({
    ...common,
    points: [{ x: -5, y: 0.92, z: 0 }],
  });
  assert.ok(narrowSide > wideSide * 1.6);
});

test("locker performances receive a close readable camera without shrinking exploration", () => {
  assert.equal(cameraDistanceScaleForPlayerMode("free"), 1);
  assert.equal(cameraDistanceScaleForPlayerMode("entering-hide"), 0.78);
  assert.equal(cameraDistanceScaleForPlayerMode("exiting-hide"), 0.78);
  assert.ok(cameraDistanceScaleForPlayerMode("peeking") < 1);
  assert.ok(cameraDistanceScaleForPlayerMode("hidden") > cameraDistanceScaleForPlayerMode("entering-hide"));
});

test("edge lockers bias only the hide-performance focus into the maze", () => {
  const cameraDirection = { x: 0.3451465392455413, y: 0.7308985536964403, z: -0.588779390477688 };
  const bounds = { minX: -24, maxX: 24, minZ: -24, maxZ: 24 };
  const request = {
    bounds,
    cameraDirection,
    cameraDistance: 13,
    verticalFovDegrees: 56,
    aspect: 1.7039627039627039,
  };
  for (const focus of [
    { x: -20, y: 0.92, z: 12 }, // L4 outpatient locker
    { x: -20, y: 0.92, z: -10 }, // L10 foundry locker
  ]) {
    const framed = cameraFocusForEdgeHide({ ...request, focus, mode: "entering-hide" });
    assert.ok(framed.x > focus.x + 3.9 && framed.x <= focus.x + 4 + 1e-9);
    assert.equal(framed.y, focus.y);
    assert.equal(framed.z, focus.z);
  }

  const center = { x: 0, y: 0.92, z: 0 };
  assert.deepEqual(
    cameraFocusForEdgeHide({ ...request, focus: center, mode: "entering-hide" }),
    center,
    "central lockers must keep the authored focus",
  );
  assert.deepEqual(
    cameraFocusForEdgeHide({ ...request, focus: { x: -20, y: 0.92, z: 12 }, mode: "free" }),
    { x: -20, y: 0.92, z: 12 },
    "ordinary traversal must never inherit cinematic edge bias",
  );
});

test("outer-lane traversal receives a restrained projection-safe inward composition", () => {
  const common = {
    bounds: { minX: -24, maxX: 24, minZ: -24, maxZ: 24 },
    cameraDirection: { x: 0.3451465392455413, y: 0.7308985536964403, z: -0.588779390477688 },
    cameraDistance: 14.8,
    verticalFovDegrees: 56,
  };
  const edge = { x: -22, y: 0.92, z: 12 };
  const landscape = cameraFocusForTraversalEdge({ ...common, focus: edge, aspect: 16 / 9 });
  assert.ok(landscape.x > edge.x + 3.9 && landscape.x <= edge.x + 4 + 1e-9);
  assert.equal(landscape.y, edge.y);
  assert.equal(landscape.z, edge.z);

  const portrait = cameraFocusForTraversalEdge({ ...common, focus: edge, aspect: 0.5 });
  assert.ok(portrait.x > edge.x, "portrait framing still removes exterior dominance");
  assert.ok(portrait.x - edge.x < landscape.x - edge.x, "portrait keeps the player nearer center");
  const center = { x: 0, y: 0.92, z: 0 };
  assert.deepEqual(cameraFocusForTraversalEdge({ ...common, focus: center, aspect: 16 / 9 }), center);
});

test("portrait edge framing automatically limits performer displacement", () => {
  const common = {
    focus: { x: -20, y: 0.92, z: 12 },
    bounds: { minX: -24, maxX: 24, minZ: -24, maxZ: 24 },
    mode: "hidden",
    cameraDirection: { x: 0.3451465392455413, y: 0.7308985536964403, z: -0.588779390477688 },
    cameraDistance: 13,
    verticalFovDegrees: 56,
  };
  const landscape = cameraFocusForEdgeHide({ ...common, aspect: 1.7 });
  const portrait = cameraFocusForEdgeHide({ ...common, aspect: 0.5 });
  assert.ok(landscape.x - common.focus.x > 3);
  assert.ok(portrait.x > common.focus.x, "portrait still removes some exterior dominance");
  assert.ok(portrait.x - common.focus.x < 1.5, "portrait must keep the performer in its central safe frame");
});
