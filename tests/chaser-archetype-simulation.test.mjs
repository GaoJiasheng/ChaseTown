import assert from "node:assert/strict";
import test from "node:test";

import { CHASER_ARCHETYPE_PROFILES } from "../app/game/chaser-archetypes.ts";
import { getChaserTarget } from "../app/game/chaser-fsm.ts";
import { createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import { distanceBetween } from "../app/game/navigation.ts";
import { GameSimulation } from "../app/game/simulation.ts";

function levelFromRows(rows, options) {
  return createLevel({
    id: options.id,
    width: rows[0].length,
    height: rows.length,
    walkable: rows.map((row) => [...row].map((cell) => cell !== "#")),
    playerStart: options.playerStart,
    exit: options.exit,
    chaserStart: options.chaserStart,
    chaserStartHeading: options.chaserStartHeading ?? { x: 1, y: 0 },
    patrol: options.patrol,
    hideSpots: options.hideSpots ?? [],
  });
}

function archetypeConfig(overrides = {}) {
  return {
    ...DEFAULT_GAME_CONFIG,
    maxFrameDeltaSeconds: 1,
    spawnDelaySeconds: 0,
    playerSpeed: 0,
    chaserSpeed: 4,
    visionRange: 0.1,
    proximitySenseRange: 0.01,
    catchRange: 0.01,
    searchHideRadiusCells: 8,
    checkHideSeconds: 0.35,
    hearingRange: 12,
    soundUncertaintyCells: 0,
    ...overrides,
  };
}

function advanceFor(simulation, seconds, frameSeconds, input = {}) {
  const events = [];
  let remaining = seconds;
  while (remaining > 1e-10) {
    const delta = Math.min(frameSeconds, remaining);
    const state = simulation.advance(delta, input);
    events.push(...state.events);
    remaining -= delta;
  }
  return events;
}

function advanceUntil(simulation, predicate, maximumSeconds = 4, frameSeconds = 1 / 60, input = {}) {
  const events = [];
  let elapsed = 0;
  while (elapsed < maximumSeconds - 1e-10) {
    const state = simulation.advance(frameSeconds, input);
    events.push(...state.events);
    elapsed += frameSeconds;
    if (predicate(simulation.getChaserArchetypeRuntime(), state, events)) {
      return { elapsed, events, state };
    }
  }
  assert.fail(`condition was not reached within ${maximumSeconds} seconds`);
}

const campusLevel = levelFromRows([
  "##.##",
  "##.##",
  ".....",
  "##.##",
  "##.##",
], {
  id: "campus-runtime",
  playerStart: { x: 2, y: 4 },
  exit: { x: 0, y: 2 },
  chaserStart: { x: 2, y: 0 },
  chaserStartHeading: { x: 0, y: 1 },
  patrol: [{ x: 2, y: 2 }, { x: 4, y: 2 }],
});

const corridorLevel = levelFromRows([
  "#########",
  ".........",
  "#########",
], {
  id: "hide-runtime",
  playerStart: { x: 8, y: 1 },
  exit: { x: 7, y: 1 },
  chaserStart: { x: 0, y: 1 },
  patrol: [{ x: 0, y: 1 }],
  hideSpots: [{
    id: "public-hide",
    approach: { x: 6, y: 1 },
    concealed: { x: 6.25, y: 1 },
    facing: { x: -1, y: 0 },
  }],
});

test("campus public patrol arrival stops for the complete cue and performs a real branch scan", () => {
  const simulation = new GameSimulation({
    level: campusLevel,
    autoStart: true,
    config: archetypeConfig(),
    chaserArchetypeProfile: CHASER_ARCHETYPE_PROFILES.campus,
  });
  const telegraph = advanceUntil(
    simulation,
    (runtime) => runtime.phase === "telegraph",
  );
  assert.ok(telegraph.events.some((event) => (
    event.type === "chaser-archetype-telegraph-started"
    && event.rule === "scan-public-junction"
  )));
  const planted = simulation.getState().chaser.position;
  advanceFor(
    simulation,
    CHASER_ARCHETYPE_PROFILES.campus.warningSeconds - 0.05,
    1 / 60,
  );
  assert.equal(simulation.getChaserArchetypeRuntime().phase, "telegraph");
  assert.deepEqual(simulation.getState().chaser.position, planted, "telegraph translated the chaser");

  const actionStart = advanceUntil(
    simulation,
    (runtime) => runtime.phase === "acting",
    0.3,
  );
  assert.ok(actionStart.events.some((event) => (
    event.type === "chaser-archetype-action-started"
    && event.action === "scan-public-junction"
  )));
  const headingBeforeScan = simulation.getState().chaser.heading;
  advanceFor(simulation, 0.45, 1 / 60);
  const scanning = simulation.getState();
  assert.deepEqual(scanning.chaser.position, planted, "junction scan translated instead of looking");
  assert.notDeepEqual(scanning.chaser.heading, headingBeforeScan, "junction branches were never scanned");

  const finished = advanceUntil(
    simulation,
    (runtime, _state, events) => (
      runtime.phase === "idle"
      && events.some((event) => event.type === "chaser-archetype-action-finished")
    ),
    1,
  );
  assert.ok(finished.events.some((event) => (
    event.type === "chaser-archetype-action-finished"
    && event.outcome === "completed"
  )));
  advanceFor(simulation, 0.35, 1 / 60);
  assert.ok(
    distanceBetween(simulation.getState().chaser.position, planted) > 0.05,
    "patrol did not resume after the public scan",
  );
});

test("hospital cue redirects navigation to the legal public hide candidate and completes an inspection", () => {
  const simulation = new GameSimulation({
    level: corridorLevel,
    autoStart: true,
    config: archetypeConfig({ chaserSpeed: 8 }),
    chaserArchetypeProfile: CHASER_ARCHETYPE_PROFILES.hospital,
  });
  simulation.emitWorldSound({
    position: { x: 3, y: 1 },
    strength: 1,
    sourceType: "hide-interaction",
    sourceId: "public-door-clack",
    confidence: 0.8,
  });
  const cue = advanceUntil(simulation, (runtime) => runtime.phase === "telegraph");
  assert.ok(cue.events.some((event) => (
    event.type === "chaser-archetype-telegraph-started"
    && event.rule === "inspect-public-hide-clue"
  )));
  const planted = simulation.getState().chaser.position;
  advanceFor(
    simulation,
    CHASER_ARCHETYPE_PROFILES.hospital.warningSeconds - 0.05,
    1 / 60,
  );
  assert.deepEqual(simulation.getState().chaser.position, planted);

  advanceUntil(simulation, (runtime) => runtime.phase === "acting", 0.3);
  const runtime = simulation.getChaserArchetypeRuntime();
  assert.equal(runtime.action, "inspect-public-hide-clue");
  assert.deepEqual(runtime.navigationTarget, corridorLevel.hideSpots[0].approach);
  assert.deepEqual(
    getChaserTarget(simulation.getState().chaser, corridorLevel),
    corridorLevel.hideSpots[0].approach,
    "ordinary FSM navigation was not redirected to the certified candidate",
  );
  const events = advanceFor(simulation, 3, 1 / 60);
  assert.ok(events.some((event) => (
    event.type === "hide-check-completed"
    && event.hideSpotId === "public-hide"
  )));
  assert.ok(events.some((event) => (
    event.type === "chaser-archetype-action-finished"
    && event.action === "inspect-public-hide-clue"
    && event.outcome === "completed"
  )));
});

test("fire cue commits to the sampled uncertain sound point with an actual focus-speed change", () => {
  const simulation = new GameSimulation({
    level: corridorLevel,
    autoStart: true,
    config: archetypeConfig(),
    chaserArchetypeProfile: CHASER_ARCHETYPE_PROFILES["fire-station"],
  });
  simulation.emitWorldSound({
    position: { x: 3, y: 1 },
    strength: 1,
    sourceType: "player-movement",
    sourceId: "public-footstep",
    confidence: 0.8,
  });
  advanceUntil(simulation, (runtime) => runtime.phase === "telegraph");
  const planted = simulation.getState().chaser.position;
  advanceFor(
    simulation,
    CHASER_ARCHETYPE_PROFILES["fire-station"].warningSeconds - 0.05,
    1 / 60,
  );
  assert.deepEqual(simulation.getState().chaser.position, planted);
  advanceUntil(simulation, (runtime) => runtime.phase === "acting", 0.3);
  const runtime = simulation.getChaserArchetypeRuntime();
  assert.equal(runtime.action, "focus-perceived-sound");
  assert.equal(runtime.speedMultiplier, 1.16);
  assert.deepEqual(runtime.navigationTarget, { x: 3, y: 1 });
  const beforeFocusMove = simulation.getState().chaser.position;
  advanceFor(simulation, 0.35, 1 / 60);
  assert.ok(distanceBetween(simulation.getState().chaser.position, beforeFocusMove) > 0.5);
});

test("factory cue overrides direct pursuit with a public last-seen-to-exit intercept", () => {
  const level = levelFromRows([
    ".........",
    ".........",
  ], {
    id: "factory-runtime",
    playerStart: { x: 2, y: 1 },
    exit: { x: 8, y: 1 },
    chaserStart: { x: 0, y: 0 },
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [{ x: 0, y: 0 }],
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: archetypeConfig({ visionRange: 10, visionConeDegrees: 150 }),
    chaserArchetypeProfile: CHASER_ARCHETYPE_PROFILES.factory,
  });
  const cue = advanceUntil(simulation, (runtime) => runtime.phase === "telegraph");
  assert.ok(cue.events.some((event) => (
    event.type === "chaser-archetype-telegraph-started"
    && event.rule === "intercept-public-exit-route"
  )));
  const planted = simulation.getState().chaser.position;
  advanceFor(
    simulation,
    CHASER_ARCHETYPE_PROFILES.factory.warningSeconds - 0.05,
    1 / 60,
  );
  assert.deepEqual(simulation.getState().chaser.position, planted);
  advanceUntil(simulation, (runtime) => runtime.phase === "acting", 0.3);
  const runtime = simulation.getChaserArchetypeRuntime();
  assert.equal(runtime.action, "intercept-public-exit-route");
  assert.notDeepEqual(runtime.navigationTarget, simulation.getState().chaser.memory.lastKnownPosition);
  assert.deepEqual(runtime.navigationTarget, { x: 4, y: 1 });
  advanceFor(simulation, 0.4, 1 / 60);
  assert.ok(distanceBetween(simulation.getState().chaser.position, planted) > 0.2);
});

test("null and omitted profile are exact no-ops for the legacy FSM", () => {
  const options = {
    level: campusLevel,
    autoStart: true,
    config: archetypeConfig(),
  };
  const omitted = new GameSimulation(options);
  const explicitNull = new GameSimulation({ ...options, chaserArchetypeProfile: null });
  advanceFor(omitted, 3, 1 / 60);
  advanceFor(explicitNull, 3, 1 / 60);
  assert.deepEqual(explicitNull.getState(), omitted.getState());
  assert.deepEqual(explicitNull.getChaserArchetypeRuntime(), {
    enabled: false,
    archetype: null,
    rule: null,
    phase: "idle",
    warningSeconds: 0,
    cueProgress: 0,
    cueLabel: null,
    cueAudioToken: null,
    cueAnimationToken: null,
    action: null,
    navigationTarget: null,
    speedMultiplier: 1,
  });
  assert.equal(
    explicitNull.getState().events.some((event) => event.type.startsWith("chaser-archetype-")),
    false,
  );
});

test("hospital selection is invariant to private occupancy and traversal-exit choice", () => {
  const level = levelFromRows([
    "#########",
    ".........",
    "#########",
  ], {
    id: "hospital-fairness",
    playerStart: { x: 6, y: 1 },
    exit: { x: 8, y: 1 },
    chaserStart: { x: 0, y: 1 },
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [{ x: 0, y: 1 }],
    hideSpots: [{
      id: "traversal-public-hide",
      approach: { x: 6, y: 1 },
      concealed: { x: 6.25, y: 1 },
      facing: { x: 1, y: 0 },
      archetype: "traversal-hide",
      alternateExit: { x: 7, y: 1 },
    }],
  });
  const options = {
    level,
    autoStart: true,
    config: archetypeConfig({
      chaserSpeed: 0.1,
      hideAlignSpeed: 20,
      hideAlignTurnSpeed: 20,
      hideEnterSeconds: 0.2,
      hideEnterExposureSeconds: 0.1,
    }),
    chaserArchetypeProfile: CHASER_ARCHETYPE_PROFILES.hospital,
  };
  const occupied = new GameSimulation(options);
  const empty = new GameSimulation(options);
  occupied.advance(1 / 60, {
    interactPressed: true,
    environmentSoundMasking: 1,
  });
  advanceFor(occupied, 0.5, 1 / 60, {
    environmentSoundMasking: 1,
    hideExitChoice: "alternate",
  });
  advanceFor(empty, 0.5 + 1 / 60, 1 / 60, {
    environmentSoundMasking: 1,
    hideExitChoice: "origin",
  });
  assert.equal(occupied.getState().hideSpots["traversal-public-hide"].occupiedByPlayer, true);
  assert.equal(empty.getState().hideSpots["traversal-public-hide"].occupiedByPlayer, false);
  assert.deepEqual(occupied.getState().chaser, empty.getState().chaser);

  const publicSound = {
    position: { x: 4, y: 1 },
    strength: 1,
    sourceType: "hide-interaction",
    sourceId: "shared-public-clue",
    confidence: 0.8,
  };
  occupied.emitWorldSound(publicSound);
  empty.emitWorldSound(publicSound);
  advanceUntil(occupied, (runtime) => runtime.phase === "acting", 1.5, 1 / 60, {
    hideExitChoice: "alternate",
  });
  advanceUntil(empty, (runtime) => runtime.phase === "acting", 1.5, 1 / 60, {
    hideExitChoice: "origin",
  });
  assert.deepEqual(
    occupied.getChaserArchetypeRuntime(),
    empty.getChaserArchetypeRuntime(),
    "private occupancy or selected alternate exit changed the public decision",
  );
  assert.deepEqual(
    occupied.getState().chaser,
    empty.getState().chaser,
    "private hide runtime leaked into the pursuer state",
  );
});

function cadenceScenario(theme, cadence) {
  let level = corridorLevel;
  const config = archetypeConfig({ chaserSpeed: 5 });
  if (theme === "campus") level = campusLevel;
  if (theme === "factory") {
    level = levelFromRows([
      ".........",
      ".........",
    ], {
      id: "factory-cadence",
      playerStart: { x: 2, y: 1 },
      exit: { x: 8, y: 1 },
      chaserStart: { x: 0, y: 0 },
      chaserStartHeading: { x: 1, y: 0 },
      patrol: [{ x: 0, y: 0 }],
    });
    config.visionRange = 10;
    config.visionConeDegrees = 150;
  }
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config,
    chaserArchetypeProfile: CHASER_ARCHETYPE_PROFILES[theme],
  });
  if (theme === "hospital") {
    simulation.emitWorldSound({
      position: { x: 3, y: 1 },
      strength: 1,
      sourceType: "hide-interaction",
      sourceId: "cadence-door",
    });
  } else if (theme === "fire-station") {
    simulation.emitWorldSound({
      position: { x: 3, y: 1 },
      strength: 1,
      confidence: 0.8,
      sourceType: "player-movement",
      sourceId: "cadence-step",
    });
  }
  const events = advanceFor(simulation, 3, cadence);
  return {
    chaser: simulation.getState().chaser,
    runtime: simulation.getChaserArchetypeRuntime(),
    archetypeEvents: events.filter((event) => event.type.startsWith("chaser-archetype-")),
  };
}

test("all four runtime rules are deterministic at 30, 60, and 120 Hz render cadence", () => {
  for (const theme of ["campus", "hospital", "fire-station", "factory"]) {
    const at30 = cadenceScenario(theme, 1 / 30);
    const at60 = cadenceScenario(theme, 1 / 60);
    const at120 = cadenceScenario(theme, 1 / 120);
    assert.deepEqual(at30, at60, `${theme} differed at 30 and 60 Hz`);
    assert.deepEqual(at60, at120, `${theme} differed at 60 and 120 Hz`);
    assert.ok(
      at60.archetypeEvents.some((event) => event.type === "chaser-archetype-telegraph-started"),
      `${theme} never emitted its public cue`,
    );
    assert.ok(
      at60.archetypeEvents.some((event) => event.type === "chaser-archetype-action-started"),
      `${theme} never changed behavior after its cue`,
    );
  }
});
