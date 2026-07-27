import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialChaser,
  generateSearchHypotheses,
  generateSearchWaypoints,
  getChaserTarget,
  stepChaserBrain,
} from "../app/game/chaser-fsm.ts";
import {
  applyHideDisturbance,
  decayHideDisturbance,
  HIDE_ARCHETYPE_PROFILES,
  hideExitStyleProfile,
} from "../app/game/hide-archetypes.ts";
import { createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import { findPath } from "../app/game/navigation.ts";
import { GameSimulation } from "../app/game/simulation.ts";

const config = (overrides = {}) => {
  const result = {
    ...DEFAULT_GAME_CONFIG,
    maxFrameDeltaSeconds: 2,
    spawnDelaySeconds: 0,
    ...overrides,
  };
  if (
    Object.hasOwn(overrides, "hideEnterSeconds")
    && !Object.hasOwn(overrides, "hideEnterExposureSeconds")
  ) {
    result.hideEnterExposureSeconds = result.hideEnterSeconds
      * (DEFAULT_GAME_CONFIG.hideEnterExposureSeconds / DEFAULT_GAME_CONFIG.hideEnterSeconds);
  }
  if (
    Object.hasOwn(overrides, "hideExitSeconds")
    && !Object.hasOwn(overrides, "hideExitExposureSeconds")
  ) {
    result.hideExitExposureSeconds = result.hideExitSeconds
      * (DEFAULT_GAME_CONFIG.hideExitExposureSeconds / DEFAULT_GAME_CONFIG.hideExitSeconds);
  }
  return result;
};

const branchingLevel = createLevel({
  id: "p0-directional-search",
  width: 9,
  height: 9,
  walkable: [
    [false, false, false, false, true, false, false, false, false],
    [false, false, false, false, true, false, false, false, false],
    [false, false, false, false, true, false, false, false, false],
    [false, false, false, false, true, false, false, false, false],
    [true, true, true, true, true, true, true, true, true],
    [false, false, true, false, true, false, true, false, false],
    [false, false, true, false, true, false, true, false, false],
    [false, false, true, true, true, true, true, false, false],
    [false, false, false, false, false, false, false, false, false],
  ],
  playerStart: { x: 0, y: 4 },
  exit: { x: 8, y: 4 },
  chaserStart: { x: 1, y: 4 },
  chaserStartHeading: { x: 1, y: 0 },
  patrol: [{ x: 1, y: 4 }],
  hideSpots: [],
});

test("public last direction deterministically prioritizes real reachable navigation branches", () => {
  const context = {
    preferredDirection: { x: 1, y: 0 },
    regionSuspicion: [],
  };
  const first = generateSearchHypotheses(
    branchingLevel,
    { x: 4, y: 4 },
    71,
    5,
    context,
  );
  const replay = generateSearchHypotheses(
    branchingLevel,
    { x: 4, y: 4 },
    71,
    5,
    context,
  );

  assert.deepEqual(first, replay);
  assert.ok(first.length >= 3 && first.length <= 5);
  assert.equal(first[0].fallback, false);
  assert.ok(
    first[0].branchHeading.x > 0.9,
    `expected eastward public travel direction first, got ${JSON.stringify(first[0])}`,
  );
  for (const hypothesis of first) {
    assert.ok(findPath(branchingLevel, { x: 4, y: 4 }, hypothesis.target).length > 0);
  }

  const seedOnly = generateSearchHypotheses(
    branchingLevel,
    { x: 4, y: 4 },
    1,
    5,
  );
  const suspicionOrdered = generateSearchHypotheses(
    branchingLevel,
    { x: 4, y: 4 },
    1,
    5,
    {
      regionSuspicion: [{
        regionId: "junction:8,4",
        anchor: { x: 8, y: 4 },
        confidence: 1,
        updatedAtSeconds: 0,
        decayPerSecond: 0.05,
      }],
    },
  );
  assert.ok(seedOnly[0].branchHeading.x < -0.9);
  assert.ok(suspicionOrdered[0].branchHeading.x > 0.9);

  const cfg = config();
  const observed = stepChaserBrain(
    createInitialChaser(branchingLevel, cfg),
    branchingLevel,
    cfg,
    {
      evidence: {
        kind: "player-visible",
        position: { x: 4, y: 4 },
        direction: { x: 1, y: 0 },
        observedAtSeconds: 1,
      },
      reachedTarget: false,
      nowSeconds: 1,
      deltaSeconds: cfg.aiTickSeconds,
    },
  ).state;
  assert.deepEqual(observed.memory.lastKnownDirection, { x: 1, y: 0 });
  const searching = {
    ...observed,
    mode: "search",
    searchSeed: 71,
    searchPlan: generateSearchWaypoints(
      branchingLevel,
      observed.memory.lastKnownPosition,
      71,
      {
        preferredDirection: observed.memory.lastKnownDirection,
        regionSuspicion: observed.memory.regionSuspicion,
      },
    ),
    searchIndex: 1,
    searchHideSpotId: null,
  };
  assert.ok(getChaserTarget(searching, branchingLevel).x > 4);
});

test("search snapshots its public plan so suspicion decay cannot retarget the current waypoint", () => {
  const cfg = config({
    lastKnownScanSeconds: 0.4,
    searchSeconds: 10,
    searchHideCheckBudget: 0,
  });
  const initial = createInitialChaser(branchingLevel, cfg);
  const scanReady = {
    ...initial,
    position: { x: 4, y: 4 },
    mode: "scan-last-known",
    modeElapsedSeconds: cfg.lastKnownScanSeconds,
    memory: {
      ...initial.memory,
      lastKnownPosition: { x: 4, y: 4 },
      lastHeardAtSeconds: 0,
      lastKnownEvidence: "sound",
      regionSuspicion: [{
        regionId: "junction:8,4",
        anchor: { x: 8, y: 4 },
        confidence: 0.06,
        updatedAtSeconds: 0,
        decayPerSecond: 0.02,
      }],
    },
  };
  let searching = stepChaserBrain(scanReady, branchingLevel, cfg, {
    evidence: { kind: "none", observedAtSeconds: 0 },
    reachedTarget: true,
    nowSeconds: 0,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  assert.equal(searching.mode, "search");
  assert.ok(searching.searchPlan.length >= 3);

  searching = { ...searching, searchIndex: 1 };
  const capturedPlan = searching.searchPlan;
  const targetBeforeDecay = getChaserTarget(searching, branchingLevel);
  assert.ok(targetBeforeDecay.x > 4, "the live suspicion should influence the entry snapshot");

  const decayed = stepChaserBrain(searching, branchingLevel, cfg, {
    evidence: { kind: "none", observedAtSeconds: 1 },
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  assert.deepEqual(decayed.memory.regionSuspicion, []);
  assert.equal(decayed.searchIndex, searching.searchIndex);
  assert.strictEqual(
    decayed.searchPlan,
    capturedPlan,
    "an AI tick must retain the captured plan rather than rebuild it",
  );
  assert.deepEqual(
    getChaserTarget(decayed, branchingLevel),
    targetBeforeDecay,
    "the same search index must keep its target after its ordering prior expires",
  );
});

test("movement-frame search target reads use only the cached plan with constant lookups", () => {
  const cfg = config({ searchHideCheckBudget: 0 });
  const initial = createInitialChaser(branchingLevel, cfg);
  const anchor = { x: 4, y: 4 };
  const generated = generateSearchWaypoints(branchingLevel, anchor, 71);
  let lengthReads = 0;
  let waypointReads = 0;
  const countedPlan = new Proxy(generated, {
    get(target, property) {
      if (property === "length") lengthReads += 1;
      else if (typeof property === "string" && /^\d+$/.test(property)) waypointReads += 1;
      return Reflect.get(target, property, target);
    },
  });
  const searching = {
    ...initial,
    mode: "search",
    searchIndex: 1,
    searchPlan: countedPlan,
    searchHideSpotId: null,
    memory: {
      ...initial.memory,
      lastKnownPosition: anchor,
      lastKnownEvidence: "sound",
    },
  };
  const forbiddenGeometry = new Proxy(branchingLevel, {
    get(_target, property) {
      throw new Error(`cached target resolution touched level geometry: ${String(property)}`);
    },
  });

  for (let frame = 0; frame < 600; frame += 1) {
    assert.deepEqual(getChaserTarget(searching, forbiddenGeometry), generated[1]);
  }
  assert.equal(lengthReads, 600);
  assert.equal(waypointReads, 600);
});

test("public region suspicion is decaying, deterministic, bounded to four, and never changes a chase target", () => {
  const openLevel = createLevel({
    id: "p0-public-regions",
    width: 9,
    height: 9,
    walkable: Array.from({ length: 9 }, () => Array(9).fill(true)),
    playerStart: { x: 8, y: 8 },
    exit: { x: 8, y: 0 },
    chaserStart: { x: 0, y: 0 },
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }],
    hideSpots: [],
  });
  const cfg = config();
  let chaser = createInitialChaser(openLevel, cfg);
  const publicPoints = [
    { x: 1, y: 1 },
    { x: 7, y: 1 },
    { x: 1, y: 7 },
    { x: 7, y: 7 },
    { x: 4, y: 4 },
  ];
  for (let index = 0; index < publicPoints.length; index += 1) {
    const nowSeconds = index + 1;
    chaser = stepChaserBrain(chaser, openLevel, cfg, {
      evidence: {
        kind: "world-clue",
        clueId: `public-clue-${index}`,
        position: publicPoints[index],
        observedAtSeconds: nowSeconds,
        confidence: 0.8,
        decayPerSecond: 0.02,
        sourceType: "disturbed-prop",
      },
      reachedTarget: false,
      nowSeconds,
      deltaSeconds: cfg.aiTickSeconds,
    }).state;
  }

  assert.equal(chaser.memory.regionSuspicion.length, 4);
  assert.equal(
    chaser.memory.regionSuspicion.some((entry) => (
      Object.hasOwn(entry, "occupiedByPlayer")
      || Object.hasOwn(entry, "hideSpotId")
      || Object.hasOwn(entry, "playerPosition")
    )),
    false,
  );
  const deterministic = chaser.memory.regionSuspicion;
  const decayed = stepChaserBrain(chaser, openLevel, cfg, {
    evidence: { kind: "none", observedAtSeconds: 8 },
    reachedTarget: false,
    nowSeconds: 8,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  assert.ok(decayed.memory.regionSuspicion.length <= 4);
  assert.ok(
    decayed.memory.regionSuspicion.every((entry) => (
      entry.confidence
      < deterministic.find((prior) => prior.regionId === entry.regionId).confidence
    )),
  );

  const chaseA = {
    ...decayed,
    mode: "chase",
    memory: {
      ...decayed.memory,
      lastKnownPosition: { x: 6, y: 6 },
    },
  };
  const chaseB = {
    ...chaseA,
    memory: { ...chaseA.memory, regionSuspicion: [] },
  };
  assert.deepEqual(getChaserTarget(chaseA, openLevel), getChaserTarget(chaseB, openLevel));
});

test("hide disturbance accumulates 0–3 from public transitions and decays by fixed ticks", () => {
  let runtime = {
    id: "p0-locker",
    occupiedByPlayer: false,
    disturbanceLevel: 0,
    disturbanceRevision: 0,
    disturbanceUpdatedAtTick: 0,
    useCount: 0,
    peekCount: 0,
  };
  runtime = applyHideDisturbance(runtime, "enter", 10);
  assert.equal(runtime.disturbanceLevel, 1);
  assert.equal(runtime.useCount, 1);
  runtime = applyHideDisturbance(runtime, "peek", 11);
  assert.equal(runtime.disturbanceLevel, 2);
  assert.equal(runtime.peekCount, 1);
  runtime = applyHideDisturbance(runtime, "exit-quick", 12);
  assert.equal(runtime.disturbanceLevel, 3);
  runtime = applyHideDisturbance(runtime, "enter", 13);
  assert.equal(runtime.disturbanceLevel, 3, "public disturbance must saturate at level three");
  assert.equal(runtime.useCount, 2, "repeated use remains public even after saturation");

  const oneStage = decayHideDisturbance(runtime, 73, 60);
  assert.equal(oneStage.disturbanceLevel, 2);
  const expired = decayHideDisturbance(oneStage, 253, 60);
  assert.equal(expired.disturbanceLevel, 0);
  assert.equal(
    applyHideDisturbance(expired, "exit-quick", 254).disturbanceLevel,
    3,
    "quick exit must create a level-three public disturbance from a settled hide",
  );
  assert.equal(
    applyHideDisturbance(expired, "exit-careful", 254).disturbanceLevel,
    1,
    "careful exit must remain a low-disturbance option",
  );

  assert.ok(hideExitStyleProfile("quick").durationMultiplier < 1);
  assert.ok(hideExitStyleProfile("quick").soundMultiplier > 1);
  assert.ok(hideExitStyleProfile("careful").durationMultiplier > 1);
  assert.ok(hideExitStyleProfile("careful").soundMultiplier < 1);
});

function hideVisibilityLevel(chaserHeading) {
  const spot = {
    id: "los-locker",
    approach: { x: 2, y: 0 },
    concealed: { x: 2, y: -0.3 },
    facing: { x: 1, y: 0 },
  };
  return {
    spot,
    level: createLevel({
      id: `p0-hide-los-${chaserHeading.x}`,
      width: 9,
      height: 1,
      walkable: [Array(9).fill(true)],
      playerStart: { ...spot.approach },
      exit: { x: 0, y: 0 },
      chaserStart: { x: 8, y: 0 },
      chaserStartHeading: chaserHeading,
      patrol: [{ x: 8, y: 0 }],
      hideSpots: [spot],
    }),
  };
}

function runFrames(simulation, frameRate, seconds, inputForFrame = () => ({})) {
  const count = Math.round(frameRate * seconds);
  let state = simulation.getState();
  for (let frame = 0; frame < count; frame += 1) {
    state = simulation.advance(1 / frameRate, inputForFrame(frame));
  }
  return state;
}

function disturbWhileOutsideVision(chaserHeading) {
  const { level, spot } = hideVisibilityLevel(chaserHeading);
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    initialPlayerHeading: spot.facing,
    config: config({
      aiTickSeconds: 0.05,
      chaserSpeed: 0,
      hideEnterSeconds: 0.1,
      hideInteractRange: 0.2,
      hearingRange: 0.1,
      soundUncertaintyCells: 0,
      visionRange: 10,
      visionConeDegrees: 60,
      proximitySenseRange: 0.1,
      catchRange: 0.05,
    }),
  });
  runFrames(simulation, 60, 0.3, (frame) => ({
    interactPressed: frame === 0,
    visionRangeMultiplier: 0.5,
  }));
  assert.equal(simulation.getState().player.mode, "hidden");
  assert.equal(simulation.getState().hideSpots[spot.id].disturbanceLevel, 1);
  return { simulation, spot };
}

test("hide disturbance becomes AI evidence only through normal range, cone, and LOS", () => {
  const toward = disturbWhileOutsideVision({ x: -1, y: 0 });
  const away = disturbWhileOutsideVision({ x: 1, y: 0 });

  runFrames(toward.simulation, 60, 0.2, () => ({ visionRangeMultiplier: 1 }));
  runFrames(away.simulation, 60, 0.2, () => ({ visionRangeMultiplier: 1 }));

  const towardState = toward.simulation.getState();
  const awayState = away.simulation.getState();
  assert.equal(towardState.chaser.memory.lastKnownEvidence, null);
  assert.match(
    towardState.chaser.memory.evidenceTrail[0].sourceId,
    /^hide-disturbance:/,
  );
  assert.ok(towardState.chaser.memory.regionSuspicion.length > 0);
  assert.equal(awayState.chaser.memory.lastKnownEvidence, null);
  assert.equal(away.simulation.getWorldClueQueueSnapshot().acceptedCount, 0);
});

function runStyledExitAt(frameRate, style, settleSeconds = 0) {
  const { level, spot } = hideVisibilityLevel({ x: 1, y: 0 });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    initialPlayerHeading: spot.facing,
    config: config({
      fixedStepSeconds: 1 / 60,
      aiTickSeconds: 0.1,
      spawnDelaySeconds: 100,
      chaserSpeed: 0,
      hideEnterSeconds: 0.05,
      hideExitSeconds: 0.6,
      hideInteractRange: 0.2,
      hearingRange: 0.1,
    }),
  });
  runFrames(simulation, frameRate, 0.5, (frame) => ({
    interactPressed: frame === 0,
  }));
  assert.equal(simulation.getState().player.mode, "hidden");
  runFrames(simulation, frameRate, settleSeconds);
  runFrames(simulation, frameRate, 2, (frame) => ({
    interactPressed: frame === 0,
    hideExitStyle: style,
  }));
  const state = simulation.getState();
  return {
    phase: state.phase,
    tick: state.tick,
    elapsedSeconds: state.elapsedSeconds,
    player: state.player,
    hideSpots: state.hideSpots,
    chaser: state.chaser,
  };
}

test("quick and careful exit commands replay identically at 30/60/120/144 Hz", () => {
  for (const style of ["quick", "careful"]) {
    const snapshots = [30, 60, 120, 144].map((hz) => runStyledExitAt(hz, style));
    for (const snapshot of snapshots) {
      assert.equal(snapshot.tick, 150);
      assert.equal(snapshot.player.mode, "free");
      assert.equal(snapshot.player.hideExitStyle, null);
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
    assert.deepEqual(snapshots[1], snapshots[2]);
    assert.deepEqual(snapshots[2], snapshots[3]);
  }

  const quick = runStyledExitAt(60, "quick");
  const careful = runStyledExitAt(60, "careful");
  assert.equal(quick.hideSpots["los-locker"].disturbanceLevel, 3);
  assert.equal(careful.hideSpots["los-locker"].disturbanceLevel, 2);
  assert.notDeepEqual(quick, careful, "exit style must remain part of deterministic replay input");

  const settledQuick = runStyledExitAt(60, "quick", 13);
  const settledCareful = runStyledExitAt(60, "careful", 13);
  assert.equal(settledQuick.hideSpots["los-locker"].disturbanceLevel, 3);
  assert.equal(settledCareful.hideSpots["los-locker"].disturbanceLevel, 1);
});

const EXIT_PERCEPTION_STEP = 1 / 60;
const EXIT_HEARING_RANGE = 100;
const EXIT_EXPOSURE_SECONDS = 0.18;

function enterPerceptionTestLocker(simulation) {
  runFrames(simulation, 60, 0.5, (frame) => ({
    interactPressed: frame === 0,
    environmentSoundMasking: 1,
    visionRangeMultiplier: 0.5,
  }));
  assert.equal(simulation.getState().player.mode, "hidden");
  assert.equal(
    simulation.getState().chaser.memory.evidenceTrail.some(
      (entry) => entry.kind === "sound" || entry.kind === "visual",
    ),
    false,
    "the controlled entry leaked evidence into the exit measurement",
  );
}

function observeStyledExitSound(style) {
  const { level, spot } = hideVisibilityLevel({ x: 0, y: 1 });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    initialPlayerHeading: spot.facing,
    config: config({
      fixedStepSeconds: EXIT_PERCEPTION_STEP,
      aiTickSeconds: EXIT_PERCEPTION_STEP,
      chaserSpeed: 0,
      hideEnterSeconds: 0.05,
      hideExitSeconds: 0.6,
      hideExitExposureSeconds: EXIT_EXPOSURE_SECONDS,
      hideInteractRange: 0.2,
      hearingRange: EXIT_HEARING_RANGE,
      soundUncertaintyCells: 0,
      visionRange: 1,
      visionConeDegrees: 60,
      proximitySenseRange: 0.1,
      catchRange: 0.05,
    }),
  });
  enterPerceptionTestLocker(simulation);

  const state = simulation.advance(EXIT_PERCEPTION_STEP, {
    interactPressed: true,
    hideExitStyle: style,
    environmentSoundMasking: 0,
    visionRangeMultiplier: 0.5,
  });
  assert.equal(state.player.mode, "exiting-hide");
  assert.equal(state.chaser.memory.lastKnownEvidence, "sound");
  const sound = state.chaser.memory.evidenceTrail.find(
    (entry) => entry.kind === "sound" && entry.sourceType === "hide-interaction",
  );
  assert.ok(sound, `${style} exit sound never reached AI memory`);

  const authoredStrength = Math.min(
    1,
    HIDE_ARCHETYPE_PROFILES["hard-locker"].evidence.exitSoundStrength
      * hideExitStyleProfile(style).soundMultiplier,
  );
  const routeDistance = findPath(level, state.chaser.position, spot.approach).length - 1;
  const audibleRange = EXIT_HEARING_RANGE * authoredStrength;
  const expectedPerceivedStrength = Math.min(
    1,
    Math.max(
      0.01,
      authoredStrength * (1 - routeDistance / Math.max(audibleRange + 1, 1)),
    ),
  );
  assert.ok(
    Math.abs(sound.strength - expectedPerceivedStrength) <= 1e-12,
    `${style} AI sound strength ${sound.strength} != ${expectedPerceivedStrength}`,
  );
  return sound.strength;
}

test("quick and careful exits deliver their authored sound strength into AI perception", () => {
  const quickStrength = observeStyledExitSound("quick");
  const carefulStrength = observeStyledExitSound("careful");
  assert.ok(quickStrength > carefulStrength);
});

function observeStyledExitExposureTick(style) {
  const { level, spot } = hideVisibilityLevel({ x: -1, y: 0 });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    initialPlayerHeading: spot.facing,
    config: config({
      fixedStepSeconds: EXIT_PERCEPTION_STEP,
      aiTickSeconds: EXIT_PERCEPTION_STEP,
      chaserSpeed: 0,
      hideEnterSeconds: 0.05,
      hideExitSeconds: 0.6,
      hideExitExposureSeconds: EXIT_EXPOSURE_SECONDS,
      hideInteractRange: 0.2,
      hearingRange: 0.1,
      soundUncertaintyCells: 0,
      visionRange: 10,
      visionConeDegrees: 60,
      proximitySenseRange: 0.1,
      catchRange: 0.05,
    }),
  });
  enterPerceptionTestLocker(simulation);

  let state = simulation.advance(EXIT_PERCEPTION_STEP, {
    interactPressed: true,
    hideExitStyle: style,
    environmentSoundMasking: 1,
    visionRangeMultiplier: 1,
  });
  const exitStartedTick = state.tick;
  const exitStartedSeconds = state.elapsedSeconds;
  assert.equal(state.player.mode, "exiting-hide");
  assert.equal(
    state.chaser.memory.evidenceTrail.some((entry) => (
      entry.kind === "visual"
      && entry.observedAtSeconds >= exitStartedSeconds
    )),
    false,
    "the exit became visible before its authored exposure delay",
  );

  let firstVisualTick = null;
  for (let frame = 0; frame < 90 && firstVisualTick === null; frame += 1) {
    state = simulation.advance(EXIT_PERCEPTION_STEP, {
      environmentSoundMasking: 1,
      visionRangeMultiplier: 1,
    });
    const visual = state.chaser.memory.evidenceTrail.find((entry) => (
      entry.kind === "visual"
      && entry.observedAtSeconds >= exitStartedSeconds
    ));
    if (visual) firstVisualTick = state.tick;
  }
  assert.notEqual(firstVisualTick, null, `${style} exit never entered AI vision`);

  const expectedDelayTicks = Math.ceil(
    (
      EXIT_EXPOSURE_SECONDS
      * hideExitStyleProfile(style).exposureDelayMultiplier
      - 1e-9
    ) / EXIT_PERCEPTION_STEP,
  );
  assert.equal(firstVisualTick - exitStartedTick, expectedDelayTicks);
  return firstVisualTick - exitStartedTick;
}

test("quick and careful exits enter AI vision on their authored exposure tick", () => {
  const quickDelayTicks = observeStyledExitExposureTick("quick");
  const carefulDelayTicks = observeStyledExitExposureTick("careful");
  assert.ok(quickDelayTicks < carefulDelayTicks);
});
