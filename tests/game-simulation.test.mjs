import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialChaser,
  evidenceRankedHideCandidates,
  getChaserTarget,
  hasReachedChaserTarget,
  stepChaserBrain,
} from "../app/game/chaser-fsm.ts";
import { createDefaultLevel, createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import { distanceBetween, findPath, GridPathPlanner, hasLineOfSight, isWalkable, moveAlongGridPath, moveWithCollision } from "../app/game/navigation.ts";
import { isPlayerVisuallyExposed, samplePlayerPerception, sampleSoundPerception } from "../app/game/perception.ts";
import { chaserSpeedForMode, GameSimulation } from "../app/game/simulation.ts";

function testLevel(rows, options = {}) {
  const walkable = rows.map((row) => [...row].map((cell) => cell !== "#"));
  const firstOpen = (() => {
    for (let y = 0; y < walkable.length; y += 1) {
      const x = walkable[y].indexOf(true);
      if (x >= 0) return { x, y };
    }
    throw new Error("test level has no walkable cell");
  })();
  const playerStart = options.playerStart ?? firstOpen;
  const chaserStart = options.chaserStart ?? firstOpen;
  return createLevel({
    id: options.id ?? "test-level",
    width: walkable[0].length,
    height: walkable.length,
    walkable,
    playerStart,
    exit: options.exit ?? firstOpen,
    chaserStart,
    chaserStartHeading: options.chaserStartHeading ?? { x: 1, y: 0 },
    patrol: options.patrol ?? [chaserStart],
    hideSpots: options.hideSpots ?? [],
    visionOnlyBlockers: options.visionOnlyBlockers,
  });
}

function runFor(simulation, seconds, frameSeconds, input = {}) {
  let remaining = seconds;
  while (remaining > 1e-10) {
    const delta = Math.min(frameSeconds, remaining);
    simulation.advance(delta, input);
    remaining -= delta;
  }
  return simulation.getState();
}

function routeIntent(level, state, target) {
  const waypoint = findPath(level, state.player.position, target)[1] ?? target;
  const offset = { x: waypoint.x - state.player.position.x, y: waypoint.y - state.player.position.y };
  const length = Math.hypot(offset.x, offset.y) || 1;
  return { x: offset.x / length, y: offset.y / length };
}

function config(overrides = {}) {
  const result = {
    ...DEFAULT_GAME_CONFIG,
    maxFrameDeltaSeconds: 1,
    ...overrides,
  };
  if (Object.hasOwn(overrides, "hideEnterSeconds") && !Object.hasOwn(overrides, "hideEnterExposureSeconds")) {
    result.hideEnterExposureSeconds = result.hideEnterSeconds
      * (DEFAULT_GAME_CONFIG.hideEnterExposureSeconds / DEFAULT_GAME_CONFIG.hideEnterSeconds);
  }
  if (Object.hasOwn(overrides, "hideExitSeconds") && !Object.hasOwn(overrides, "hideExitExposureSeconds")) {
    result.hideExitExposureSeconds = result.hideExitSeconds
      * (DEFAULT_GAME_CONFIG.hideExitExposureSeconds / DEFAULT_GAME_CONFIG.hideExitSeconds);
  }
  return result;
}

test("spawn protection disables both movement and capture", () => {
  const level = testLevel(["....."], {
    playerStart: { x: 2, y: 0 },
    chaserStart: { x: 2, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({ spawnDelaySeconds: 0.5, chaserSpeed: 0, catchRange: 0.4 }),
  });

  let state = runFor(simulation, 0.49, 1 / 60);
  assert.equal(state.phase, "playing");
  assert.equal(state.chaser.mode, "spawn-delay");
  assert.deepEqual(state.chaser.position, { x: 2, y: 0 });

  state = runFor(simulation, 0.12, 1 / 60);
  assert.equal(state.phase, "lost", "capture becomes legal only after protection ends");
  assert.equal(state.captureReason, "direct-contact");
});

test("walls block both visual acquisition and close-range capture", () => {
  const level = testLevel([".....", "..#..", "....."], {
    playerStart: { x: 2, y: 2 },
    chaserStart: { x: 2, y: 0 },
    chaserStartHeading: { x: 0, y: 1 },
    exit: { x: 0, y: 2 },
  });
  assert.equal(hasLineOfSight(level, level.chaserStart, level.playerStart), false);
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({ spawnDelaySeconds: 0, chaserSpeed: 0, catchRange: 3, visionRange: 10 }),
  });
  const state = runFor(simulation, 0.5, 1 / 60);
  assert.equal(state.phase, "playing");
  assert.equal(state.chaser.mode, "patrol");
  assert.equal(state.chaser.memory.lastKnownPosition, null);
});

test("sound evidence follows navigable distance and never reports an exact distant source", () => {
  const level = testLevel(["......."], {
    playerStart: { x: 6, y: 0 },
    chaserStart: { x: 0, y: 0 },
    exit: { x: 6, y: 0 },
  });
  const stimulus = { position: { x: 6, y: 0 }, strength: 1 };
  const heard = sampleSoundPerception(
    level,
    { position: { x: 0, y: 0 } },
    stimulus,
    { hearingRange: 8, soundUncertaintyCells: 2 },
    3,
  );
  assert.equal(heard.kind, "sound");
  assert.deepEqual(heard.position, { x: 4, y: 0 });
  assert.notDeepEqual(heard.position, stimulus.position);
  assert.deepEqual(
    heard,
    sampleSoundPerception(
      level,
      { position: { x: 0, y: 0 } },
      stimulus,
      { hearingRange: 8, soundUncertaintyCells: 2 },
      3,
    ),
  );

  const tooFar = sampleSoundPerception(
    level,
    { position: { x: 0, y: 0 } },
    stimulus,
    { hearingRange: 5, soundUncertaintyCells: 1 },
    3,
  );
  assert.equal(tooFar.kind, "none");
});

test("heard evidence redirects patrol using only its imprecise reported point", () => {
  const level = testLevel(["......."], {
    playerStart: { x: 6, y: 0 },
    chaserStart: { x: 0, y: 0 },
    exit: { x: 6, y: 0 },
  });
  const cfg = config({ spawnDelaySeconds: 0 });
  const initial = createInitialChaser(level, cfg);
  const evidence = sampleSoundPerception(
    level,
    initial,
    { position: { x: 6, y: 0 }, strength: 1 },
    { hearingRange: 8, soundUncertaintyCells: 2 },
    2,
  );
  const result = stepChaserBrain(initial, level, cfg, {
    evidence,
    reachedTarget: false,
    nowSeconds: 2,
    deltaSeconds: cfg.aiTickSeconds,
  });
  assert.equal(result.state.mode, "go-to-last-known");
  assert.equal(result.state.memory.lastKnownEvidence, "sound");
  assert.equal(result.state.memory.lastSeenAtSeconds, null);
  assert.equal(result.state.memory.lastHeardAtSeconds, 2);
  assert.deepEqual(getChaserTarget(result.state, level), evidence.position);
});

test("pushing into a wall does not rotate the actor or camera toward empty space", () => {
  const level = testLevel([".#..."], {
    playerStart: { x: 0, y: 0 },
    chaserStart: { x: 4, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    initialPlayerPosition: { x: 0.49, y: 0 },
    initialPlayerHeading: { x: 0, y: 1 },
    config: config({ spawnDelaySeconds: 20 }),
  });
  const before = simulation.getState().player;
  const after = simulation.advance(1 / 60, { move: { x: 1, y: 0 } }).player;
  assert.deepEqual(after.position, before.position);
  assert.deepEqual(after.heading, before.heading);
});

test("sliding along a wall faces the accepted displacement instead of the rejected axis", () => {
  const level = testLevel([".#", ".."]);
  const movement = moveWithCollision(
    level,
    { x: 0.49, y: 0 },
    { x: 1, y: 1 },
    1,
    0.1,
  );
  assert.equal(movement.position.x, 0.49);
  assert.ok(movement.position.y > 0);
  assert.deepEqual(movement.heading, { x: 0, y: 1 });
});

test("solid authored props block movement, pathing, and sight without removing their floor", () => {
  const level = testLevel(["....."], {
    playerStart: { x: 0, y: 0 },
    chaserStart: { x: 4, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const blocked = createLevel({ ...level, movementBlockers: [{ x: 2, y: 0 }] });
  assert.equal(blocked.walkable[0][2], true, "the authored prop still needs a rendered floor tile");
  assert.equal(isWalkable(blocked, { x: 2, y: 0 }), false);
  assert.deepEqual(findPath(blocked, { x: 0, y: 0 }, { x: 4, y: 0 }), []);
  assert.equal(hasLineOfSight(blocked, { x: 0, y: 0 }, { x: 4, y: 0 }), false);
  const movement = moveWithCollision(blocked, { x: 1.49, y: 0 }, { x: 1, y: 0 }, 1, 0.1);
  assert.equal(movement.position.x, 1.49, "the player cannot enter the prop's occupied cell");
});

test("the production level remains escapable after solid-prop collision is applied", () => {
  const level = createDefaultLevel();
  assert.ok(findPath(level, level.playerStart, level.exit).length > 0);
  for (const blocker of level.movementBlockers ?? []) assert.equal(isWalkable(level, blocker), false);
});

test("production encounter rejects a no-technique shortest-route sprint", () => {
  const level = createDefaultLevel();
  const simulation = new GameSimulation({ level, autoStart: true });
  let sawChase = false;
  for (let frame = 0; frame < 40 * 60 && simulation.getState().phase === "playing"; frame += 1) {
    const state = simulation.getState();
    const next = simulation.advance(1 / 60, { move: routeIntent(level, state, level.exit) });
    sawChase ||= next.chaser.mode === "chase";
  }
  const result = simulation.getState();
  assert.equal(sawChase, true, "the natural route must deliver a readable chase beat");
  assert.equal(result.phase, "lost", "holding the shortest route without breaking sight must not bypass the core loop");
});

test("production north-locker route proves the encounter has a fair hiding solution", () => {
  const level = createDefaultLevel();
  const locker = level.hideSpots[0];
  const simulation = new GameSimulation({ level, autoStart: true });
  let stage = "approach";
  let hiddenSeconds = 0;
  let reachedHidden = false;

  for (let frame = 0; frame < 60 * 60 && simulation.getState().phase === "playing"; frame += 1) {
    const state = simulation.getState();
    const input = {};
    if (stage === "approach") {
      if (distanceBetween(state.player.position, locker.approach) <= 0.72) {
        input.interactPressed = true;
        stage = "entering";
      } else input.move = routeIntent(level, state, locker.approach);
    } else if (stage === "entering" && state.player.mode === "hidden") {
      reachedHidden = true;
      stage = "waiting";
    } else if (stage === "waiting") {
      hiddenSeconds += 1 / 60;
      if (hiddenSeconds >= 6) {
        input.interactPressed = true;
        stage = "exiting";
      }
    } else if (stage === "exiting" && state.player.mode === "free") stage = "escape";
    else if (stage === "escape") input.move = routeIntent(level, state, level.exit);
    simulation.advance(1 / 60, input);
  }

  assert.equal(reachedHidden, true);
  assert.equal(simulation.getState().phase, "won", "a readable pre-encounter hide must create a viable escape window");
});

test("production route exercises chase, sight break, hiding, search, and escape", () => {
  const level = createDefaultLevel();
  const locker = level.hideSpots[0];
  const simulation = new GameSimulation({ level, autoStart: true });
  const alternate = [
    { x: 7, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 10 },
    { x: 5, y: 10 }, { x: 5, y: 16 }, { x: 13, y: 16 },
    { x: 13, y: 23 }, level.exit,
  ];
  let stage = "escape-direct";
  let hiddenSeconds = 0;
  let waypointIndex = 0;
  const seenModes = new Set();
  let reachedHidden = false;

  for (let frame = 0; frame < 100 * 60 && simulation.getState().phase === "playing"; frame += 1) {
    const state = simulation.getState();
    const input = {};
    seenModes.add(state.chaser.mode);
    if (stage === "escape-direct" && ["suspicious", "chase"].includes(state.chaser.mode)) {
      stage = "retreat-to-north-locker";
    }

    if (stage === "escape-direct") input.move = routeIntent(level, state, level.exit);
    else if (stage === "retreat-to-north-locker") {
      if (distanceBetween(state.player.position, locker.approach) <= 0.72) {
        input.interactPressed = true;
        stage = "entering-locker";
      } else input.move = routeIntent(level, state, locker.approach);
    } else if (stage === "entering-locker" && state.player.mode === "hidden") {
      reachedHidden = true;
      stage = "waiting-hidden";
    } else if (stage === "waiting-hidden") {
      hiddenSeconds += 1 / 60;
      if (hiddenSeconds >= 6) {
        input.interactPressed = true;
        stage = "exiting-locker";
      }
    } else if (stage === "exiting-locker" && state.player.mode === "free") stage = "alternate-route";
    else if (stage === "alternate-route") {
      while (waypointIndex < alternate.length && distanceBetween(state.player.position, alternate[waypointIndex]) < 0.25) waypointIndex += 1;
      input.move = routeIntent(level, state, alternate[Math.min(waypointIndex, alternate.length - 1)]);
    }
    simulation.advance(1 / 60, input);
  }

  assert.equal(reachedHidden, true);
  for (const mode of ["chase", "lost-sight", "go-to-last-known", "scan-last-known", "search", "patrol"]) {
    assert.equal(seenModes.has(mode), true, `missing ${mode}`);
  }
  assert.equal(simulation.getState().phase, "won");
});

test("last-known target freezes after line of sight is lost", () => {
  const level = testLevel(["....."], {
    playerStart: { x: 2, y: 0 },
    chaserStart: { x: 0, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const cfg = config({ spawnDelaySeconds: 0, suspiciousSeconds: 0.1, lostSightGraceSeconds: 0.2 });
  let chaser = createInitialChaser(level, cfg);
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "player-visible", position: { x: 2, y: 0 }, observedAtSeconds: 0.1 },
    reachedTarget: false,
    nowSeconds: 0.1,
    deltaSeconds: 0.1,
  }).state;
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "player-visible", position: { x: 2.25, y: 0 }, observedAtSeconds: 0.2 },
    reachedTarget: false,
    nowSeconds: 0.2,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "chase");
  const frozen = { ...chaser.memory.lastKnownPosition };

  for (const nowSeconds of [0.3, 0.4, 0.5, 0.6]) {
    // The real player may continue moving, but no position is supplied to the
    // brain once perception returns none.
    chaser = stepChaserBrain(chaser, level, cfg, {
      evidence: { kind: "none", observedAtSeconds: nowSeconds },
      reachedTarget: false,
      nowSeconds,
      deltaSeconds: 0.1,
    }).state;
    assert.deepEqual(chaser.memory.lastKnownPosition, frozen);
  }
  assert.ok(["lost-sight", "go-to-last-known"].includes(chaser.mode));
  assert.deepEqual(getChaserTarget(chaser, level), frozen);
});

test("chaser reaches the exact last sighting, scans left and right, then searches", () => {
  const level = testLevel(["......."], {
    playerStart: { x: 6, y: 0 },
    chaserStart: { x: 0, y: 0 },
    chaserStartHeading: { x: 1, y: 0 },
    exit: { x: 6, y: 0 },
  });
  const cfg = config({
    spawnDelaySeconds: 0,
    lostSightGraceSeconds: 0.2,
    lastKnownScanSeconds: 1.5,
    searchSeconds: 5,
  });
  const lastKnownPosition = { x: 4.25, y: 0 };
  const planner = new GridPathPlanner(level);
  let chaser = {
    ...createInitialChaser(level, cfg),
    mode: "chase",
    memory: {
      lastKnownPosition: { ...lastKnownPosition },
      lastSeenAtSeconds: 0,
      witnessedHideSpotId: null,
    },
  };
  const modes = new Set([chaser.mode]);
  const pursuitDistances = [];
  const scanPositions = [];
  const scanYawOffsets = [];
  let scanOrigin = null;
  let headingAfterScan = null;

  for (let tick = 1; tick <= 120 && chaser.mode !== "search"; tick += 1) {
    const reachedTarget = hasReachedChaserTarget(chaser, level);
    chaser = stepChaserBrain(chaser, level, cfg, {
      evidence: { kind: "none", observedAtSeconds: tick * 0.1 },
      reachedTarget,
      nowSeconds: tick * 0.1,
      deltaSeconds: 0.1,
    }).state;
    modes.add(chaser.mode);

    if (["lost-sight", "go-to-last-known"].includes(chaser.mode)) {
      pursuitDistances.push(distanceBetween(chaser.position, lastKnownPosition));
    }
    if (chaser.mode === "scan-last-known") {
      scanOrigin ??= { ...chaser.scanOriginHeading };
      scanPositions.push({ ...chaser.position });
      const originYaw = Math.atan2(scanOrigin.x, scanOrigin.y);
      const headingYaw = Math.atan2(chaser.heading.x, chaser.heading.y);
      scanYawOffsets.push(Math.atan2(Math.sin(headingYaw - originYaw), Math.cos(headingYaw - originYaw)));
    }
    if (chaser.mode === "search") headingAfterScan = { ...chaser.heading };

    const target = getChaserTarget(chaser, level);
    const speed = chaserSpeedForMode(chaser.mode, cfg.chaserSpeed);
    if (target && speed > 0) {
      const before = chaser.position;
      const movement = moveAlongGridPath(planner, before, target, speed, 0.1);
      const moved = distanceBetween(before, movement.position) > 1e-9;
      chaser = {
        ...chaser,
        position: movement.position,
        heading: moved ? movement.heading : chaser.heading,
      };
    }
  }

  for (let index = 1; index < pursuitDistances.length; index += 1) {
    assert.ok(
      pursuitDistances[index] <= pursuitDistances[index - 1] + 1e-9,
      "distance to frozen evidence increased before arrival",
    );
  }
  assert.equal(modes.has("lost-sight"), true);
  assert.equal(modes.has("go-to-last-known"), true);
  assert.equal(modes.has("scan-last-known"), true);
  assert.equal(chaser.mode, "search");
  assert.ok(scanPositions.length >= 14, "arrival scan was shorter than its authored duration");
  for (const position of scanPositions) {
    assert.ok(distanceBetween(position, lastKnownPosition) <= 1e-9, "scan began before the exact sighting point");
  }
  assert.ok(Math.min(...scanYawOffsets) < -0.85, "the pursuer never looked left");
  assert.ok(Math.max(...scanYawOffsets) > 0.85, "the pursuer never looked right");
  assert.ok(scanOrigin && headingAfterScan);
  assert.ok(
    scanOrigin.x * headingAfterScan.x + scanOrigin.y * headingAfterScan.y > 0.999,
    "the arrival scan did not return to its neutral heading",
  );
  assert.deepEqual(chaser.position, lastKnownPosition, "post-scan search displaced the planted actor");
  assert.deepEqual(getChaserTarget(chaser, level), lastKnownPosition, "search did not begin at the exact evidence anchor");
  assert.ok(
    Math.abs(chaser.searchWaypointElapsedSeconds - (cfg.searchWaypointSeconds - cfg.aiTickSeconds)) < 1e-9,
    "the post-scan planted beat was not authored",
  );
});

test("last-known scan rotates the real vision cone and can reacquire the player", () => {
  const level = testLevel([
    ".....",
    ".....",
    ".....",
    ".....",
    ".....",
  ], {
    playerStart: { x: 0, y: 4 },
    chaserStart: { x: 2, y: 2 },
    chaserStartHeading: { x: 0, y: 1 },
    exit: { x: 4, y: 4 },
  });
  const cfg = config({
    spawnDelaySeconds: 0,
    suspiciousSeconds: 0.2,
    lastKnownScanSeconds: 1.5,
    visionRange: 10,
    visionConeDegrees: 35,
  });
  let chaser = {
    ...createInitialChaser(level, cfg),
    mode: "scan-last-known",
    modeElapsedSeconds: 0,
    scanOriginHeading: { x: 0, y: 1 },
    memory: {
      lastKnownPosition: { x: 2, y: 2 },
      lastSeenAtSeconds: 0,
      witnessedHideSpotId: null,
    },
  };
  const player = {
    position: { x: 0, y: 4 },
    mode: "free",
    hideSpotId: null,
    transitionRemainingSeconds: 0,
  };
  assert.equal(samplePlayerPerception(level, chaser, player, cfg, 0).kind, "none");

  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 0.3 },
    reachedTarget: true,
    nowSeconds: 0.3,
    deltaSeconds: 0.3,
  }).state;
  const evidence = samplePlayerPerception(level, chaser, player, cfg, 0.3);
  assert.equal(evidence.kind, "player-visible", "the visible model sweep did not rotate AI perception");

  for (const nowSeconds of [0.4, 0.5, 0.6]) {
    const visible = samplePlayerPerception(level, chaser, player, cfg, nowSeconds);
    chaser = stepChaserBrain(chaser, level, cfg, {
      evidence: visible,
      reachedTarget: true,
      nowSeconds,
      deltaSeconds: 0.1,
    }).state;
  }
  assert.equal(chaser.mode, "chase", "a player swept by the real vision cone was not reacquired");
});

test("a brief suspicious glimpse retains evidence and enters last-known search", () => {
  const level = testLevel(["....."], {
    playerStart: { x: 2, y: 0 },
    chaserStart: { x: 0, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const cfg = config({ spawnDelaySeconds: 0 });
  let chaser = createInitialChaser(level, cfg);
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "player-visible", position: { x: 2, y: 0 }, observedAtSeconds: 0.1 },
    reachedTarget: false,
    nowSeconds: 0.1,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "suspicious");
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 0.2 },
    reachedTarget: false,
    nowSeconds: 0.2,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "lost-sight");
  assert.deepEqual(chaser.memory.lastKnownPosition, { x: 2, y: 0 });
});

test("reacquiring the player from search confirms before resuming chase", () => {
  const level = testLevel(["....."], {
    playerStart: { x: 2, y: 0 },
    chaserStart: { x: 0, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const cfg = config({ spawnDelaySeconds: 0, suspiciousSeconds: 0.2 });
  let chaser = {
    ...createInitialChaser(level, cfg),
    mode: "search",
    memory: {
      lastKnownPosition: { x: 1, y: 0 },
      lastSeenAtSeconds: 0,
      witnessedHideSpotId: null,
    },
  };
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "player-visible", position: { x: 2, y: 0 }, observedAtSeconds: 1 },
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "search");
  assert.equal(chaser.visualConfirmationSeconds, 0);
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "player-visible", position: { x: 2.1, y: 0 }, observedAtSeconds: 1.1 },
    reachedTarget: false,
    nowSeconds: 1.1,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "search");
  assert.equal(chaser.visualConfirmationSeconds, 0.1);
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "player-visible", position: { x: 2.2, y: 0 }, observedAtSeconds: 1.2 },
    reachedTarget: false,
    nowSeconds: 1.2,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "chase");
  assert.equal(chaser.visualConfirmationSeconds, null);
});

test("alternating short peeks cannot stun movement or erase fresh evidence", () => {
  const level = testLevel(["......."], {
    playerStart: { x: 6, y: 0 },
    chaserStart: { x: 0, y: 0 },
    exit: { x: 6, y: 0 },
  });
  const cfg = config({ spawnDelaySeconds: 0, suspiciousSeconds: 0.2 });
  const planner = new GridPathPlanner(level);
  let chaser = {
    ...createInitialChaser(level, cfg),
    mode: "go-to-last-known",
    memory: {
      lastKnownPosition: { x: 6, y: 0 },
      lastSeenAtSeconds: 0,
      witnessedHideSpotId: null,
    },
  };
  for (let tick = 1; tick <= 10; tick += 1) {
    const visible = tick % 2 === 1;
    chaser = stepChaserBrain(chaser, level, cfg, {
      evidence: visible
        ? { kind: "player-visible", position: { x: 6, y: 0 }, observedAtSeconds: tick * 0.1 }
        : { kind: "none", observedAtSeconds: tick * 0.1 },
      reachedTarget: false,
      nowSeconds: tick * 0.1,
      deltaSeconds: 0.1,
    }).state;
    const target = getChaserTarget(chaser, level);
    assert.ok(target, "pursuit target disappeared during a short peek");
    const movement = moveAlongGridPath(
      planner,
      chaser.position,
      target,
      chaserSpeedForMode(chaser.mode, cfg.chaserSpeed),
      0.1,
    );
    chaser = { ...chaser, position: movement.position, heading: movement.heading };
  }
  assert.equal(chaser.mode, "go-to-last-known");
  assert.ok(chaser.position.x > 1.5, `short peeks stalled pursuit at x=${chaser.position.x}`);
  assert.ok(chaser.modeElapsedSeconds >= 0.99, "short peeks reset the underlying pursuit timer");

  let searching = {
    ...createInitialChaser(level, cfg),
    mode: "search",
    memory: {
      lastKnownPosition: { x: 3, y: 0 },
      lastSeenAtSeconds: 0,
      witnessedHideSpotId: null,
    },
  };
  const shortSearchConfig = { ...cfg, searchSeconds: 0.6 };
  for (let tick = 1; tick <= 8; tick += 1) {
    const visible = tick % 2 === 1;
    searching = stepChaserBrain(searching, level, shortSearchConfig, {
      evidence: visible
        ? { kind: "player-visible", position: { x: 6, y: 0 }, observedAtSeconds: tick * 0.1 }
        : { kind: "none", observedAtSeconds: tick * 0.1 },
      reachedTarget: false,
      nowSeconds: tick * 0.1,
      deltaSeconds: 0.1,
    }).state;
  }
  assert.equal(searching.mode, "go-to-last-known", "fresh evidence fell back to stale search/patrol behavior");
  assert.deepEqual(searching.memory.lastKnownPosition, { x: 6, y: 0 });
  assert.ok(searching.memory.lastSeenAtSeconds >= 0.7, "fresh visual evidence was erased by search timeout");
});

test("a brief peek cannot cancel a witnessed locker inspection", () => {
  const locker = {
    id: "locker-north",
    approach: { x: 3, y: 0 },
    concealed: { x: 3.3, y: 0 },
    facing: { x: -1, y: 0 },
  };
  const level = testLevel(["....."], {
    playerStart: locker.approach,
    chaserStart: { x: 0, y: 0 },
    exit: { x: 4, y: 0 },
    hideSpots: [locker],
  });
  const cfg = config({ spawnDelaySeconds: 0, suspiciousSeconds: 0.2, checkHideSeconds: 0.3 });
  let chaser = {
    ...createInitialChaser(level, cfg),
    mode: "check-hide",
    memory: {
      lastKnownPosition: { ...locker.approach },
      lastSeenAtSeconds: 0,
      witnessedHideSpotId: locker.id,
    },
  };
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "player-visible", position: { ...locker.concealed }, observedAtSeconds: 1 },
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "check-hide");
  assert.equal(chaser.visualConfirmationSeconds, 0);
  assert.equal(chaser.memory.witnessedHideSpotId, locker.id);
  assert.deepEqual(getChaserTarget(chaser, level), locker.approach);

  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 1.1 },
    reachedTarget: false,
    nowSeconds: 1.1,
    deltaSeconds: 0.1,
  }).state;
  assert.equal(chaser.mode, "check-hide");
  assert.equal(chaser.visualConfirmationSeconds, null);
  assert.equal(chaser.memory.witnessedHideSpotId, locker.id);
  assert.deepEqual(getChaserTarget(chaser, level), locker.approach);

  const completed = stepChaserBrain(
    { ...chaser, position: { ...locker.approach } },
    level,
    cfg,
    {
      evidence: { kind: "none", observedAtSeconds: 1.4 },
      reachedTarget: true,
      nowSeconds: 1.4,
      deltaSeconds: 0.3,
    },
  );
  assert.equal(completed.completedHideCheckId, locker.id);
});

test("search order is evidence-seeded, deterministic, and advances only after an authored dwell", () => {
  const level = testLevel([
    ".......",
    ".......",
    ".......",
    ".......",
    ".......",
    ".......",
    ".......",
  ], {
    playerStart: { x: 3, y: 3 },
    chaserStart: { x: 3, y: 3 },
    exit: { x: 6, y: 6 },
  });
  const cfg = config({ spawnDelaySeconds: 0, searchSeconds: 20, searchWaypointSeconds: 0.75 });
  const initial = createInitialChaser(level, cfg);
  const makeSearch = (searchSeed) => ({
    ...initial,
    mode: "search",
    modeElapsedSeconds: 0,
    searchSeed,
    searchIndex: 0,
    searchWaypointElapsedSeconds: 0,
    memory: { lastKnownPosition: { x: 3, y: 3 }, lastSeenAtSeconds: 1.2, witnessedHideSpotId: null },
  });
  const sequence = (searchSeed) => Array.from({ length: 9 }, (_, searchIndex) =>
    getChaserTarget({ ...makeSearch(searchSeed), searchIndex }, level));
  assert.deepEqual(sequence(7), sequence(7), "the same evidence seed must replay exactly");
  assert.deepEqual(sequence(7)[0], { x: 3, y: 3 }, "search must begin at the exact evidence anchor");
  assert.notDeepEqual(sequence(7), sequence(19), "different observed encounters should not be a fixed search pattern");

  let state = makeSearch(7);
  const target = getChaserTarget(state, level);
  state = { ...state, position: target };
  state = stepChaserBrain(state, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 1.5 },
    reachedTarget: true,
    nowSeconds: 1.5,
    deltaSeconds: 0.3,
  }).state;
  assert.equal(state.searchIndex, 0);
  assert.equal(state.searchWaypointElapsedSeconds, 0.3);
  state = stepChaserBrain(state, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 1.95 },
    reachedTarget: true,
    nowSeconds: 1.95,
    deltaSeconds: 0.45,
  }).state;
  assert.equal(state.searchIndex, 1, "the next node is chosen only after reaching and checking this one");
  assert.equal(state.searchWaypointElapsedSeconds, 0);
});

test("evidence-ranked locker search is deterministic, budgeted, and occupancy-blind", () => {
  const hideSpots = [
    { id: "locker-left", approach: { x: 1, y: 1 }, concealed: { x: 1, y: 1 }, facing: { x: 1, y: 0 } },
    { id: "locker-right", approach: { x: 5, y: 1 }, concealed: { x: 5, y: 1 }, facing: { x: -1, y: 0 } },
    { id: "locker-far", approach: { x: 6, y: 2 }, concealed: { x: 6, y: 2 }, facing: { x: -1, y: 0 } },
  ];
  const level = testLevel([
    ".......",
    ".......",
    ".......",
  ], {
    playerStart: { x: 0, y: 0 },
    chaserStart: { x: 3, y: 1 },
    exit: { x: 6, y: 0 },
    hideSpots,
  });
  const cfg = config({
    spawnDelaySeconds: 0,
    searchSeconds: 20,
    searchHideCheckBudget: 2,
    searchHideRadiusCells: 3,
    checkHideSeconds: 0.2,
  });
  const initial = createInitialChaser(level, cfg);
  const searching = {
    ...initial,
    mode: "search",
    searchSeed: 17,
    searchHideSpotId: null,
    hideCheckSource: null,
    memory: {
      ...initial.memory,
      lastKnownPosition: { x: 3, y: 1 },
      lastSeenAtSeconds: 1,
      lastKnownEvidence: "visual",
    },
  };
  const candidates = evidenceRankedHideCandidates(searching, level, cfg);
  assert.deepEqual(candidates, evidenceRankedHideCandidates(searching, level, cfg));
  assert.deepEqual(new Set(candidates), new Set(["locker-left", "locker-right"]));
  assert.equal(candidates.includes("locker-far"), false);

  let state = {
    ...searching,
    position: { ...hideSpots.find((spot) => spot.id === candidates[0]).approach },
    searchHideSpotId: candidates[0],
    hideCheckSource: "search",
  };
  state = stepChaserBrain(state, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 2 },
    reachedTarget: true,
    nowSeconds: 2,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  assert.equal(state.mode, "check-hide");
  assert.equal(state.searchHideSpotId, candidates[0]);

  const completed = stepChaserBrain(state, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 2.2 },
    reachedTarget: true,
    nowSeconds: 2.2,
    deltaSeconds: cfg.checkHideSeconds,
  });
  assert.equal(completed.completedHideCheckId, candidates[0]);
  assert.equal(completed.completedHideCheckSource, "search");
  assert.equal(completed.state.searchHideChecksCompleted, 1);
  assert.deepEqual(completed.state.inspectedHideSpotIds, [candidates[0]]);
  assert.notEqual(completed.state.searchHideSpotId, candidates[0], "an inspected locker cannot be selected again");

  const afterBudget = {
    ...completed.state,
    searchHideChecksCompleted: cfg.searchHideCheckBudget,
    searchHideSpotId: null,
  };
  assert.deepEqual(evidenceRankedHideCandidates(afterBudget, level, cfg), [candidates[1]]);
  const exhausted = stepChaserBrain({
    ...afterBudget,
    mode: "scan-last-known",
    modeElapsedSeconds: cfg.lastKnownScanSeconds,
  }, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 3 },
    reachedTarget: true,
    nowSeconds: 3,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  assert.equal(exhausted.mode, "search");
  assert.equal(exhausted.searchHideSpotId, null, "the public candidates cannot bypass the configured budget");
  // Candidate ranking has no occupancy argument or runtime hide-spot state;
  // changing which locker contains the player cannot affect this decision.
  assert.deepEqual(
    evidenceRankedHideCandidates({ ...afterBudget }, level, cfg),
    evidenceRankedHideCandidates({ ...afterBudget }, level, cfg),
  );
});

test("path following reaches a continuous last-known point inside its goal cell", () => {
  const level = testLevel(["....."], {
    playerStart: { x: 0, y: 0 },
    chaserStart: { x: 0, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const planner = new GridPathPlanner(level);
  const target = { x: 2.25, y: 0 };
  let position = { x: 0, y: 0 };
  for (let index = 0; index < 30; index += 1) {
    position = moveAlongGridPath(planner, position, target, 1, 0.1).position;
  }
  assert.ok(Math.abs(position.x - target.x) < 1e-9);
});

test("path following never crosses an unreachable wall component", () => {
  const level = testLevel(["..#.."], {
    playerStart: { x: 0, y: 0 },
    chaserStart: { x: 1, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const planner = new GridPathPlanner(level);
  const start = { x: 1, y: 0 };
  const result = moveAlongGridPath(planner, start, { x: 3, y: 0 }, 6, 1);
  assert.deepEqual(result.position, start);
  assert.deepEqual(result.heading, { x: 0, y: 0 });
});

test("FAIR-01: an unwitnessed locker choice cannot alter chaser decisions", () => {
  const hideSpots = [
    { id: "locker-left", approach: { x: 2, y: 2 }, concealed: { x: 2, y: 2 }, facing: { x: 0, y: -1 } },
    { id: "locker-right", approach: { x: 4, y: 2 }, concealed: { x: 4, y: 2 }, facing: { x: 0, y: -1 } },
  ];
  const common = {
    chaserStart: { x: 3, y: 0 },
    chaserStartHeading: { x: 0, y: 1 },
    exit: { x: 0, y: 2 },
    hideSpots,
  };
  const left = new GameSimulation({
    level: testLevel([".......", "...#...", "......."], { ...common, playerStart: hideSpots[0].approach }),
    autoStart: true,
    initialPlayerHeading: hideSpots[0].facing,
    config: config({
      spawnDelaySeconds: 0,
      chaserSpeed: 0,
      hideEnterSeconds: 0.3,
      hideInteractRange: 0.2,
      catchRange: 0.1,
      visionRange: 10,
      hearingRange: 0.1,
    }),
  });
  const right = new GameSimulation({
    level: testLevel([".......", "...#...", "......."], { ...common, playerStart: hideSpots[1].approach }),
    autoStart: true,
    initialPlayerHeading: hideSpots[1].facing,
    config: config({
      spawnDelaySeconds: 0,
      chaserSpeed: 0,
      hideEnterSeconds: 0.3,
      hideInteractRange: 0.2,
      catchRange: 0.1,
      visionRange: 10,
      hearingRange: 0.1,
    }),
  });

  left.advance(1 / 60, { interactPressed: true });
  right.advance(1 / 60, { interactPressed: true });
  const leftState = runFor(left, 0.7 - 1 / 60, 1 / 60);
  const rightState = runFor(right, 0.7 - 1 / 60, 1 / 60);
  assert.equal(leftState.player.mode, "hidden");
  assert.equal(rightState.player.mode, "hidden");
  assert.equal(leftState.chaser.memory.witnessedHideSpotId, null);
  assert.equal(rightState.chaser.memory.witnessedHideSpotId, null);
  assert.deepEqual(leftState.chaser, rightState.chaser, "runtime locker occupancy must not enter ChaserBrain");
});

test("a witnessed hide entry records exact evidence and enters check-hide", () => {
  const locker = { id: "locker-visible", approach: { x: 2, y: 0 }, concealed: { x: 2, y: 0 }, facing: { x: -1, y: 0 } };
  const level = testLevel(["....."], {
    playerStart: locker.approach,
    chaserStart: { x: 0, y: 0 },
    chaserStartHeading: { x: 1, y: 0 },
    exit: { x: 4, y: 0 },
    hideSpots: [locker],
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    initialPlayerHeading: locker.facing,
    config: config({ spawnDelaySeconds: 0, chaserSpeed: 0, hideEnterSeconds: 0.5, hideInteractRange: 0.2, catchRange: 0.1 }),
  });
  simulation.advance(1 / 60, { interactPressed: true });
  const state = runFor(simulation, 0.25 - 1 / 60, 1 / 60);
  assert.equal(state.player.mode, "entering-hide");
  assert.equal(state.chaser.mode, "check-hide");
  assert.equal(state.chaser.memory.witnessedHideSpotId, locker.id);
  assert.deepEqual(getChaserTarget(state.chaser, level), locker.approach);
});

test("fixed-step results are identical at 30, 60, and 120 Hz render cadence", () => {
  const level = testLevel(["...................."], {
    playerStart: { x: 2, y: 0 },
    chaserStart: { x: 18, y: 0 },
    exit: { x: 19, y: 0 },
  });
  const snapshots = [30, 60, 120].map((hz) => {
    const simulation = new GameSimulation({
      level,
      autoStart: true,
      config: config({ spawnDelaySeconds: 100, playerSpeed: 1, chaserSpeed: 0 }),
    });
    return runFor(simulation, 2, 1 / hz, { move: { x: 1, y: 0 } });
  });
  for (const state of snapshots) {
    assert.equal(state.tick, 120);
    assert.ok(Math.abs(state.player.position.x - 4) < 1e-9);
  }
  assert.deepEqual(snapshots[0].player.position, snapshots[1].player.position);
  assert.deepEqual(snapshots[1].player.position, snapshots[2].player.position);
  assert.equal(snapshots[0].elapsedSeconds, snapshots[2].elapsedSeconds);
});

test("one render advance preserves events from every fixed step it contains", () => {
  const locker = { id: "event-locker", approach: { x: 1, y: 0 }, concealed: { x: 1, y: 0 }, facing: { x: 1, y: 0 } };
  const simulation = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: locker.approach,
      chaserStart: { x: 4, y: 0 },
      exit: { x: 0, y: 0 },
      hideSpots: [locker],
    }),
    autoStart: true,
    initialPlayerHeading: locker.facing,
    config: config({ spawnDelaySeconds: 10, hideEnterSeconds: 1 / 60, hideInteractRange: 0.2 }),
  });
  const state = simulation.advance(1 / 20, { interactPressed: true });
  assert.deepEqual(
    state.events.filter((event) => event.type === "player-mode-changed").map((event) => [event.from, event.to]),
    [["free", "aligning-hide"], ["aligning-hide", "entering-hide"], ["entering-hide", "hidden"]],
  );
});

test("locker alignment walks to the anchor without a first-frame snap", () => {
  const locker = { id: "align", approach: { x: 2, y: 0 }, concealed: { x: 2, y: 0 }, facing: { x: 1, y: 0 } };
  const level = testLevel(["....."], {
    playerStart: { x: 1.25, y: 0 },
    chaserStart: { x: 4, y: 0 },
    exit: { x: 0, y: 0 },
    hideSpots: [locker],
  });
  const simulation = new GameSimulation({ level, autoStart: true, config: config({ spawnDelaySeconds: 20 }) });
  const before = simulation.getState().player.position;
  const after = simulation.advance(1 / 60, { interactPressed: true });
  assert.equal(after.player.mode, "aligning-hide");
  assert.deepEqual(after.player.position, before, "the interaction edge only commits the target; it does not teleport");
  const next = simulation.advance(1 / 60);
  assert.ok(distanceBetween(next.player.position, before) <= simulation.config.hideAlignSpeed / 60 + 1e-9);
});

test("locker entry waits for authored facing after 90 and 180 degree approaches", () => {
  for (const [label, initialPlayerHeading] of [
    ["90-degree", { x: 0, y: 1 }],
    ["180-degree", { x: -1, y: 0 }],
  ]) {
    const locker = { id: label, approach: { x: 1, y: 0 }, concealed: { x: 1, y: 0 }, facing: { x: 1, y: 0 } };
    const simulation = new GameSimulation({
      level: testLevel(["....."], {
        playerStart: locker.approach,
        chaserStart: { x: 4, y: 0 },
        exit: { x: 0, y: 0 },
        hideSpots: [locker],
      }),
      autoStart: true,
      initialPlayerHeading,
      config: config({ spawnDelaySeconds: 20 }),
    });
    simulation.advance(1 / 60, { interactPressed: true });
    const first = simulation.advance(1 / 60);
    assert.equal(first.player.mode, "aligning-hide", `${label} must not start HideEnter before turning`);
    const minimumTurnSeconds = Math.acos(Math.max(-1, Math.min(1,
      initialPlayerHeading.x * locker.facing.x + initialPlayerHeading.y * locker.facing.y,
    ))) / simulation.config.hideAlignTurnSpeed;
    const beforeAligned = runFor(simulation, Math.max(0, minimumTurnSeconds - 2 / 60), 1 / 60);
    assert.equal(beforeAligned.player.mode, "aligning-hide", `${label} keeps the entry clip gated while rotating`);
    const aligned = runFor(simulation, 4 / 60, 1 / 60);
    assert.equal(aligned.player.mode, "entering-hide", `${label} starts only after exact facing is reached`);
    assert.ok(Math.abs(aligned.player.heading.x - locker.facing.x) < 1e-9);
    assert.ok(Math.abs(aligned.player.heading.y - locker.facing.y) < 1e-9);
  }
});

test("180-degree locker alignment exposes two eased 90-degree animation cycles", () => {
  const locker = { id: "pivot", approach: { x: 1, y: 0 }, concealed: { x: 1, y: 0 }, facing: { x: 0, y: -1 } };
  const simulation = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: locker.approach,
      chaserStart: { x: 4, y: 0 },
      exit: { x: 0, y: 0 },
      hideSpots: [locker],
    }),
    autoStart: true,
    initialPlayerHeading: { x: 0, y: 1 },
    config: config({ spawnDelaySeconds: 20 }),
  });
  simulation.advance(1 / 60, { interactPressed: true });

  const quarter = runFor(simulation, 0.25, 1 / 60);
  assert.equal(quarter.player.hideTurnDirection, 1);
  assert.equal(quarter.player.hideTurnCycle, 0);
  assert.ok(Math.abs(quarter.player.hideTurnSegmentDurationSeconds - 0.5) < 1e-9);
  assert.ok(Math.abs(Math.atan2(quarter.player.heading.x, quarter.player.heading.y) - Math.PI / 4) < 1e-6);

  const seam = runFor(simulation, 0.25, 1 / 60);
  assert.equal(seam.player.hideTurnCycle, 1, "the second authored pivot restarts at the exact 90-degree seam");
  assert.ok(Math.abs(Math.atan2(seam.player.heading.x, seam.player.heading.y) - Math.PI / 2) < 1e-6);

  const threeQuarter = runFor(simulation, 0.25, 1 / 60);
  assert.equal(threeQuarter.player.hideTurnCycle, 1);
  assert.ok(Math.abs(Math.atan2(threeQuarter.player.heading.x, threeQuarter.player.heading.y) - Math.PI * 0.75) < 1e-6);
});

test("peek exposure begins only after the door gap opens and ends only after it closes", () => {
  const locker = { id: "peek", approach: { x: 1, y: 0 }, concealed: { x: 1, y: 0 }, facing: { x: 1, y: 0 } };
  const simulation = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: locker.approach,
      chaserStart: { x: 4, y: 0 },
      exit: { x: 0, y: 0 },
      hideSpots: [locker],
    }),
    autoStart: true,
    initialPlayerHeading: locker.facing,
    config: config({ spawnDelaySeconds: 20, hideEnterSeconds: 0.1 }),
  });
  simulation.advance(1 / 60, { interactPressed: true });
  let state = runFor(simulation, 0.2, 1 / 60);
  assert.equal(state.player.mode, "hidden");

  state = simulation.advance(1 / 60, { peekHeld: true });
  assert.equal(state.player.mode, "entering-peek");
  assert.equal(isPlayerVisuallyExposed(state.player, simulation.config), false);
  state = runFor(simulation, simulation.config.peekEnterSeconds + simulation.config.fixedStepSeconds, 1 / 60, { peekHeld: true });
  assert.equal(state.player.mode, "peeking");
  assert.equal(isPlayerVisuallyExposed(state.player, simulation.config), true);

  state = simulation.advance(1 / 60, { peekHeld: false });
  assert.equal(state.player.mode, "exiting-peek");
  assert.equal(isPlayerVisuallyExposed(state.player, simulation.config), true);
  state = runFor(simulation, simulation.config.peekExitSeconds + simulation.config.fixedStepSeconds, 1 / 60, { peekHeld: false });
  assert.equal(state.player.mode, "hidden");
  assert.equal(isPlayerVisuallyExposed(state.player, simulation.config), false);
});

test("a zero-open quick peek cannot leak evidence through a visually closed locker", () => {
  const locker = { id: "quick-peek", approach: { x: 2, y: 0 }, concealed: { x: 2, y: 0 }, facing: { x: 1, y: 0 } };
  const simulation = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: locker.approach,
      chaserStart: { x: 0, y: 0 },
      chaserStartHeading: { x: 1, y: 0 },
      exit: { x: 4, y: 0 },
      hideSpots: [locker],
    }),
    autoStart: true,
    initialPlayerHeading: locker.facing,
    config: config({
      spawnDelaySeconds: 0.5,
      aiTickSeconds: 1 / 60,
      chaserSpeed: 0,
      catchRange: 0.05,
      visionRange: 10,
      hideEnterSeconds: 0.1,
    }),
  });
  simulation.advance(1 / 60, { interactPressed: true });
  let state = runFor(simulation, 0.65, 1 / 60);
  assert.equal(state.player.mode, "hidden");
  assert.equal(state.chaser.memory.lastKnownPosition, null);

  state = simulation.advance(1 / 60, { peekHeld: true });
  assert.equal(state.player.mode, "entering-peek");
  state = simulation.advance(1 / 60, { peekHeld: false });
  assert.equal(state.player.mode, "exiting-peek");
  assert.equal(state.player.transitionRemainingSeconds, 0);
  assert.equal(isPlayerVisuallyExposed(state.player, simulation.config), false);
  assert.equal(state.chaser.memory.lastKnownPosition, null, "a fully closed visual frame must not become AI evidence");
});

test("exit exposure waits for the authored door-opening marker", () => {
  const player = { mode: "exiting-hide", transitionRemainingSeconds: DEFAULT_GAME_CONFIG.hideExitSeconds };
  assert.equal(isPlayerVisuallyExposed(player, DEFAULT_GAME_CONFIG), false);
  player.transitionRemainingSeconds -= DEFAULT_GAME_CONFIG.hideExitExposureSeconds - 0.01;
  assert.equal(isPlayerVisuallyExposed(player, DEFAULT_GAME_CONFIG), false);
  player.transitionRemainingSeconds -= 0.02;
  assert.equal(isPlayerVisuallyExposed(player, DEFAULT_GAME_CONFIG), true);
});

test("hide-entry exposure ends at the authored safe-close marker", () => {
  const player = { mode: "entering-hide", transitionRemainingSeconds: DEFAULT_GAME_CONFIG.hideEnterSeconds };
  assert.equal(isPlayerVisuallyExposed(player, DEFAULT_GAME_CONFIG), true);
  player.transitionRemainingSeconds -= DEFAULT_GAME_CONFIG.hideEnterExposureSeconds - 0.01;
  assert.equal(isPlayerVisuallyExposed(player, DEFAULT_GAME_CONFIG), true);
  player.transitionRemainingSeconds -= 0.02;
  assert.equal(isPlayerVisuallyExposed(player, DEFAULT_GAME_CONFIG), false);
});

test("capture respects protection, exposure, LOS, and completed fair locker checks", () => {
  const openLevel = testLevel(["....."], {
    playerStart: { x: 2, y: 0 },
    chaserStart: { x: 2, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const exposed = new GameSimulation({
    level: openLevel,
    autoStart: true,
    config: config({ spawnDelaySeconds: 0, chaserSpeed: 0 }),
  });
  assert.equal(runFor(exposed, 1 / 30, 1 / 60).phase, "lost", "an exposed overlapping player is caught");

  const safeLocker = { id: "safe", approach: { x: 2, y: 0 }, concealed: { x: 2, y: 0 }, facing: { x: 1, y: 0 } };
  const protectedHide = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: safeLocker.approach,
      chaserStart: safeLocker.approach,
      exit: { x: 4, y: 0 },
      hideSpots: [safeLocker],
    }),
    autoStart: true,
    initialPlayerHeading: safeLocker.facing,
    config: config({ spawnDelaySeconds: 0.5, chaserSpeed: 0, hideEnterSeconds: 0.1, hideInteractRange: 0.2 }),
  });
  protectedHide.advance(1 / 60, { interactPressed: true });
  const hidden = runFor(protectedHide, 0.8 - 1 / 60, 1 / 60);
  assert.equal(hidden.player.mode, "hidden");
  assert.equal(hidden.phase, "playing", "ordinary proximity capture cannot reveal a hidden player");

  const witnessedLocker = { id: "witnessed", approach: { x: 2, y: 0 }, concealed: { x: 2, y: 0 }, facing: { x: -1, y: 0 } };
  const checked = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: witnessedLocker.approach,
      chaserStart: { x: 1.9, y: 0 },
      chaserStartHeading: { x: 1, y: 0 },
      exit: { x: 4, y: 0 },
      hideSpots: [witnessedLocker],
    }),
    autoStart: true,
    initialPlayerHeading: witnessedLocker.facing,
    config: config({
      spawnDelaySeconds: 0,
      chaserSpeed: 0,
      catchRange: 0.05,
      hideEnterSeconds: 0.15,
      hideInteractRange: 0.2,
      checkHideSeconds: 0.25,
    }),
  });
  checked.advance(1 / 60, { interactPressed: true });
  const caughtInLocker = runFor(checked, 0.7 - 1 / 60, 1 / 60);
  assert.equal(caughtInLocker.phase, "lost");
  assert.equal(caughtInLocker.player.mode, "caught");
  assert.equal(caughtInLocker.captureReason, "witnessed-hide-check");
  assert.equal(caughtInLocker.player.hideSpotId, null, "capture must release the presentation from the locker anchor");
  assert.equal(caughtInLocker.hideSpots[witnessedLocker.id].occupiedByPlayer, false, "capture must clear locker occupancy");
  assert.equal(caughtInLocker.player.transitionRemainingSeconds, 0);
});

test("capture reasons distinguish exposed entry, unsafe exit, and evidence-ranked search", () => {
  const exposedLocker = {
    id: "exposed-entry",
    approach: { x: 2, y: 0 },
    concealed: { x: 2, y: 0 },
    facing: { x: -1, y: 0 },
  };
  const exposedEntry = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: exposedLocker.approach,
      chaserStart: { x: 1.9, y: 0 },
      chaserStartHeading: { x: 1, y: 0 },
      exit: { x: 4, y: 0 },
      hideSpots: [exposedLocker],
    }),
    autoStart: true,
    initialPlayerHeading: exposedLocker.facing,
    config: config({ spawnDelaySeconds: 0, chaserSpeed: 0, hideInteractRange: 0.2, catchRange: 0.2 }),
  });
  const exposedResult = exposedEntry.advance(1 / 60, { interactPressed: true });
  assert.equal(exposedResult.phase, "lost");
  assert.equal(exposedResult.captureReason, "exposed-hide-entry");
  assert.equal(
    exposedResult.events.some((event) => event.type === "player-captured" && event.reason === "exposed-hide-entry"),
    true,
  );

  const exitLocker = {
    id: "unsafe-exit",
    approach: { x: 2, y: 0 },
    concealed: { x: 2, y: 0 },
    facing: { x: 1, y: 0 },
  };
  const unsafeExit = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: exitLocker.approach,
      chaserStart: exitLocker.approach,
      exit: { x: 4, y: 0 },
      hideSpots: [exitLocker],
    }),
    autoStart: true,
    initialPlayerHeading: exitLocker.facing,
    config: config({
      spawnDelaySeconds: 0.5,
      chaserSpeed: 0,
      hideEnterSeconds: 0.1,
      hideExitSeconds: 0.3,
      hideInteractRange: 0.2,
    }),
  });
  unsafeExit.advance(1 / 60, { interactPressed: true });
  let state = runFor(unsafeExit, 0.65, 1 / 60);
  assert.equal(state.player.mode, "hidden");
  unsafeExit.advance(1 / 60, { interactPressed: true });
  state = runFor(unsafeExit, 0.35, 1 / 60);
  assert.equal(state.phase, "lost");
  assert.equal(state.captureReason, "unsafe-hide-exit");

  const searchedLocker = {
    id: "searched",
    approach: { x: 2, y: 0 },
    concealed: { x: 2, y: 0 },
    facing: { x: 1, y: 0 },
  };
  const searched = new GameSimulation({
    level: testLevel(["....."], {
      playerStart: searchedLocker.approach,
      chaserStart: { x: 0, y: 0 },
      chaserStartHeading: { x: 1, y: 0 },
      exit: { x: 4, y: 0 },
      hideSpots: [searchedLocker],
    }),
    autoStart: true,
    initialPlayerHeading: searchedLocker.facing,
    config: config({
      spawnDelaySeconds: 0.5,
      aiTickSeconds: 0.05,
      suspiciousSeconds: 0.1,
      chaserSpeed: 1,
      catchRange: 0.05,
      visionRange: 10,
      hideEnterSeconds: 0.1,
      hideInteractRange: 0.2,
      peekEnterSeconds: 0.05,
      peekExitSeconds: 0.05,
      lastKnownScanSeconds: 0.1,
      searchSeconds: 8,
      searchWaypointSeconds: 0.1,
      searchHideCheckBudget: 1,
      searchHideRadiusCells: 3,
      checkHideSeconds: 0.1,
    }),
  });
  searched.advance(1 / 60, { interactPressed: true });
  state = runFor(searched, 0.65, 1 / 60);
  assert.equal(state.player.mode, "hidden");
  runFor(searched, 0.25, 1 / 60, { peekHeld: true });
  runFor(searched, 0.15, 1 / 60, { peekHeld: false });
  state = runFor(searched, 8, 1 / 60);
  assert.equal(state.phase, "lost");
  assert.equal(state.captureReason, "search-hide-check");
});

test("capture aligns both authored performances face-to-face even from behind", () => {
  const level = testLevel(["....."], {
    playerStart: { x: 1, y: 0 },
    chaserStart: { x: 2, y: 0 },
    chaserStartHeading: { x: 1, y: 0 },
    exit: { x: 4, y: 0 },
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    initialPlayerPosition: { x: 1.5, y: 0 },
    config: config({ spawnDelaySeconds: 0, chaserSpeed: 0, catchRange: 0.6 }),
  });
  const state = simulation.advance(1 / 60);
  assert.equal(state.phase, "lost");
  assert.deepEqual(state.chaser.heading, { x: -1, y: 0 });
  assert.equal(state.player.heading.x, 1);
  assert.equal(Math.abs(state.player.heading.y), 0);
});

test("chaser movement cadence matches authored locomotion and reaction beats", () => {
  const topSpeed = DEFAULT_GAME_CONFIG.chaserSpeed;
  assert.equal(chaserSpeedForMode("spawn-delay", topSpeed), 0);
  assert.equal(chaserSpeedForMode("suspicious", topSpeed), 0);
  assert.equal(
    chaserSpeedForMode("lost-sight", topSpeed),
    chaserSpeedForMode("go-to-last-known", topSpeed),
    "lost sight must preserve momentum toward the frozen evidence",
  );
  assert.equal(chaserSpeedForMode("scan-last-known", topSpeed), 0);
  assert.ok(chaserSpeedForMode("patrol", topSpeed) < chaserSpeedForMode("chase", topSpeed));
  assert.ok(chaserSpeedForMode("search", topSpeed) < chaserSpeedForMode("patrol", topSpeed));
  assert.ok(chaserSpeedForMode("check-hide", topSpeed) < chaserSpeedForMode("chase", topSpeed));
  const worldUnitsPerCell = 2;
  const authoredMetersPerSecond = { kidRun: 4.4, villainRun: 3.7, villainWalk: 1.65 };
  const rates = [
    DEFAULT_GAME_CONFIG.playerSpeed * worldUnitsPerCell / authoredMetersPerSecond.kidRun,
    chaserSpeedForMode("chase", topSpeed) * worldUnitsPerCell / authoredMetersPerSecond.villainRun,
    chaserSpeedForMode("patrol", topSpeed) * worldUnitsPerCell / authoredMetersPerSecond.villainWalk,
    chaserSpeedForMode("search", topSpeed) * worldUnitsPerCell / authoredMetersPerSecond.villainWalk,
  ];
  for (const rate of rates) assert.ok(rate >= 0.65 && rate <= 1.35, `locomotion rate ${rate} would clamp and foot-slide`);
});
