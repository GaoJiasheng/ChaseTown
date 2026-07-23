import assert from "node:assert/strict";
import test from "node:test";

import {
  actionableSoundConfidence,
  createInitialChaser,
  generateSearchHypotheses,
  getChaserTarget,
  publicEvidenceLedger,
  stepChaserBrain,
} from "../app/game/chaser-fsm.ts";
import { createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import { distanceBetween, findPath, moveAlongGridPath, GridPathPlanner, neighbors } from "../app/game/navigation.ts";
import { GameSimulation } from "../app/game/simulation.ts";
import {
  createMechanicInstance,
  createThemeMechanicDefinition,
  sampleMechanicInstance,
  sampleThemeMechanic,
  stepMechanicInstance,
} from "../app/game/theme-mechanics.ts";

const config = (overrides = {}) => ({
  ...DEFAULT_GAME_CONFIG,
  spawnDelaySeconds: 0,
  ...overrides,
});

const crossLevel = createLevel({
  id: "public-evidence-cross",
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
  chaserStartHeading: { x: -1, y: 0 },
  patrol: [{ x: 0, y: 4 }],
  hideSpots: [{
    id: "junction-locker",
    approach: { x: 4, y: 2 },
    concealed: { x: 4, y: 1.7 },
    facing: { x: 0, y: 1 },
  }],
});

test("placed theme mechanic warns, applies cost, emits once, falls off spatially, and cools down", () => {
  const definition = createThemeMechanicDefinition(
    "campus",
    "bell-west",
    { x: 4, y: 4 },
    {
      warningSeconds: 0.2,
      activeDurationSeconds: 0.4,
      cooldownSeconds: 0.3,
      effectRadius: 4,
    },
  );
  let instance = createMechanicInstance(definition);

  let result = stepMechanicInstance(instance, {
    activationRequested: true,
    actorPosition: { x: 8, y: 8 },
    deltaSeconds: 0,
    nowSeconds: 0,
  });
  assert.equal(result.instance.phase, "ready", "remote activation bypassed the interaction radius");
  assert.equal(result.events.length, 0);

  result = stepMechanicInstance(result.instance, {
    activationRequested: true,
    actorPosition: { x: 4.5, y: 4 },
    deltaSeconds: 0,
    nowSeconds: 0,
  });
  instance = result.instance;
  assert.equal(instance.phase, "warning");
  assert.deepEqual(result.events.map((event) => event.type), [
    "warning-started",
    "activation-cost-applied",
  ]);
  assert.equal(result.emittedSoundStimulus, null);

  result = stepMechanicInstance(instance, {
    actorPosition: { x: 4.5, y: 4 },
    deltaSeconds: 0.2,
    nowSeconds: 0.2,
  });
  instance = result.instance;
  assert.equal(instance.phase, "active");
  assert.equal(result.events.some((event) => event.type === "activated"), true);
  assert.equal(result.emittedSoundStimulus?.sourceType, "environment-decoy");
  assert.equal(result.emittedSoundStimulus?.sourceId, "bell-west:emitter");

  result = stepMechanicInstance(instance, {
    actorPosition: { x: 4.5, y: 4 },
    deltaSeconds: 0.1,
    nowSeconds: 0.3,
  });
  instance = result.instance;
  assert.equal(result.emittedSoundStimulus, null, "active sound replayed on a later frame");
  const near = sampleMechanicInstance(instance, { x: 4.5, y: 4 });
  const far = sampleMechanicInstance(instance, { x: 9, y: 4 });
  assert.ok(near.soundMasking > 0);
  assert.equal(far.soundMasking, 0);
  assert.equal(far.visionRangeMultiplier, 1);

  result = stepMechanicInstance(instance, {
    actorPosition: { x: 4.5, y: 4 },
    deltaSeconds: 0.3,
    nowSeconds: 0.6,
  });
  assert.equal(result.instance.phase, "cooldown");
  result = stepMechanicInstance(result.instance, {
    actorPosition: { x: 4.5, y: 4 },
    deltaSeconds: 0.3,
    nowSeconds: 0.9,
  });
  assert.equal(result.instance.phase, "ready");
  assert.equal(result.sample.canActivate, true);

  // Legacy automatic windows remain deterministic for existing callers.
  assert.deepEqual(sampleThemeMechanic("campus", 5), sampleThemeMechanic("campus", 27));
});

test("same public evidence produces exactly the same decision and a decoy creates a legal detour", () => {
  const cfg = config();
  const initial = createInitialChaser(crossLevel, cfg);
  const evidence = {
    kind: "sound",
    position: { x: 4, y: 7 },
    strength: 0.9,
    confidence: 0.85,
    decayPerSecond: 0.1,
    sourceType: "environment-decoy",
    sourceId: "campus-bell-east",
    observedAtSeconds: 1,
  };
  const input = {
    evidence,
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: cfg.aiTickSeconds,
  };
  const left = stepChaserBrain(structuredClone(initial), crossLevel, cfg, input);
  const right = stepChaserBrain(structuredClone(initial), crossLevel, cfg, input);
  assert.deepEqual(left, right);
  assert.equal(left.state.mode, "go-to-last-known");
  assert.deepEqual(getChaserTarget(left.state, crossLevel), evidence.position);
  assert.notDeepEqual(getChaserTarget(left.state, crossLevel), crossLevel.patrol[0]);
  assert.ok(findPath(crossLevel, initial.position, evidence.position).length > 1);
  assert.equal(left.state.memory.evidenceTrail?.[0].sourceId, evidence.sourceId);
  const searching = {
    ...left.state,
    mode: "search",
    searchIndex: 1,
  };
  const graphHypotheses = generateSearchHypotheses(
    crossLevel,
    evidence.position,
    searching.searchSeed,
  );
  assert.deepEqual(
    getChaserTarget(searching, crossLevel),
    graphHypotheses[0].target,
    "authored environmental evidence did not opt into navigation-branch search",
  );
});

test("visual hide-entry evidence outranks a simultaneous stream of authored decoys", () => {
  const cfg = config();
  const locker = crossLevel.hideSpots[0];
  let chaser = createInitialChaser(crossLevel, cfg);
  chaser = stepChaserBrain(chaser, crossLevel, cfg, {
    evidence: {
      kind: "hide-entry-visible",
      hideSpotId: locker.id,
      position: { ...locker.approach },
      observedAtSeconds: 1,
    },
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  assert.equal(chaser.mode, "check-hide");

  chaser = stepChaserBrain(chaser, crossLevel, cfg, {
    evidence: {
      kind: "sound",
      position: { x: 4, y: 7 },
      strength: 1,
      confidence: 1,
      sourceType: "environment-decoy",
      sourceId: "factory-siren",
      observedAtSeconds: 1.1,
    },
    reachedTarget: false,
    nowSeconds: 1.1,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  assert.equal(chaser.mode, "check-hide");
  assert.equal(chaser.memory.witnessedHideSpotId, locker.id);
  assert.deepEqual(getChaserTarget(chaser, crossLevel), locker.approach);
  assert.equal(publicEvidenceLedger(chaser, 1.1)[0].kind, "hide-entry-visible");
  assert.ok(publicEvidenceLedger(chaser, 1.1).length <= 3);
});

test("a same-tick visual keeps priority while a heard decoy enters the deferred ledger", () => {
  const cfg = config();
  const initial = createInitialChaser(crossLevel, cfg);
  const visible = {
    kind: "player-visible",
    position: { x: 0, y: 4 },
    observedAtSeconds: 1,
  };
  const decoy = {
    kind: "sound",
    position: { x: 4, y: 7 },
    strength: 0.9,
    confidence: 0.85,
    decayPerSecond: 0.1,
    sourceType: "environment-decoy",
    sourceId: "simultaneous-bell",
    observedAtSeconds: 1,
  };
  const result = stepChaserBrain(initial, crossLevel, cfg, {
    evidence: visible,
    secondarySoundEvidence: decoy,
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: cfg.aiTickSeconds,
  });
  assert.equal(result.state.mode, "suspicious");
  assert.equal(result.state.memory.lastKnownEvidence, "visual");
  assert.deepEqual(result.state.memory.lastKnownPosition, visible.position);
  assert.equal(result.state.memory.deferredSoundEvidence?.sourceId, decoy.sourceId);
  assert.deepEqual(
    new Set(publicEvidenceLedger(result.state, 1).map((entry) => entry.sourceId)),
    new Set(["player-visual", decoy.sourceId]),
  );
});

test("a decoy investigation completes only after its authored arrival scan", () => {
  const cfg = config();
  const evidence = {
    kind: "sound",
    position: { x: 4, y: 7 },
    strength: 0.9,
    confidence: 0.85,
    decayPerSecond: 0.1,
    sourceType: "environment-decoy",
    sourceId: "scanned-bell",
    observedAtSeconds: 1,
  };
  let chaser = stepChaserBrain(createInitialChaser(crossLevel, cfg), crossLevel, cfg, {
    evidence,
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  chaser = { ...chaser, position: { ...evidence.position } };
  let result = stepChaserBrain(chaser, crossLevel, cfg, {
    evidence: { kind: "none", observedAtSeconds: 1.1 },
    reachedTarget: true,
    nowSeconds: 1.1,
    deltaSeconds: cfg.aiTickSeconds,
  });
  assert.equal(result.state.mode, "scan-last-known");
  assert.equal(result.completedSoundInvestigation, undefined);

  result = stepChaserBrain(result.state, crossLevel, cfg, {
    evidence: { kind: "none", observedAtSeconds: 1.1 + cfg.lastKnownScanSeconds },
    reachedTarget: true,
    nowSeconds: 1.1 + cfg.lastKnownScanSeconds,
    deltaSeconds: cfg.lastKnownScanSeconds,
  });
  assert.deepEqual(result.completedSoundInvestigation, {
    sourceId: evidence.sourceId,
    sourceType: evidence.sourceType,
  });
  assert.equal(result.state.mode, "search");
});

test("repeated stable emitter abuse decays credibility and eventually stops route resets", () => {
  const cfg = config();
  let chaser = createInitialChaser(crossLevel, cfg);
  const decisions = [];
  const confidences = [];
  for (let use = 0; use < 10; use += 1) {
    chaser = { ...chaser, mode: "patrol", modeElapsedSeconds: 0 };
    const evidence = {
      kind: "sound",
      position: { x: 4, y: 7 },
      strength: 0.8,
      confidence: 0.8,
      decayPerSecond: 0.05,
      sourceType: "environment-decoy",
      sourceId: "repeatable-alarm",
      observedAtSeconds: use + 1,
    };
    confidences.push(actionableSoundConfidence(chaser, evidence));
    chaser = stepChaserBrain(chaser, crossLevel, cfg, {
      evidence,
      reachedTarget: false,
      nowSeconds: use + 1,
      deltaSeconds: cfg.aiTickSeconds,
    }).state;
    decisions.push(chaser.mode);
  }
  assert.equal(decisions[0], "go-to-last-known");
  assert.equal(decisions.at(-1), "patrol");
  assert.ok(confidences.every((value, index) => index === 0 || value < confidences[index - 1]));
  assert.ok((chaser.memory.evidenceTrail?.length ?? 0) <= 3);
  assert.ok((chaser.memory.evidenceTrail?.[0].repeatCount ?? 0) >= 8);
});

test("search hypotheses prefer real branches, remain deterministic, and are all reachable without stalls", () => {
  const hypotheses = generateSearchHypotheses(crossLevel, { x: 4, y: 4 }, 71);
  assert.ok(hypotheses.length >= 3 && hypotheses.length <= 5);
  assert.deepEqual(hypotheses, generateSearchHypotheses(crossLevel, { x: 4, y: 4 }, 71));
  assert.notDeepEqual(hypotheses, generateSearchHypotheses(crossLevel, { x: 4, y: 4 }, 83));

  for (const hypothesis of hypotheses) {
    assert.equal(hypothesis.fallback, false);
    assert.ok(neighbors(crossLevel, hypothesis.junction).length >= 3);
    assert.ok(findPath(crossLevel, { x: 4, y: 4 }, hypothesis.target).length > 0);
    const planner = new GridPathPlanner(crossLevel);
    let position = { x: 4, y: 4 };
    for (let tick = 0; tick < 200 && distanceBetween(position, hypothesis.target) > 0.02; tick += 1) {
      position = moveAlongGridPath(planner, position, hypothesis.target, 2, 0.1).position;
    }
    assert.ok(distanceBetween(position, hypothesis.target) <= 0.02, `stalled en route to ${JSON.stringify(hypothesis)}`);
  }
});

test("mechanic sound enters simulation only through fair perception sampling", () => {
  const level = createLevel({
    id: "mechanic-sound-corridor",
    width: 9,
    height: 1,
    walkable: [[true, true, true, true, true, true, true, true, true]],
    playerStart: { x: 8, y: 0 },
    exit: { x: 7, y: 0 },
    chaserStart: { x: 0, y: 0 },
    chaserStartHeading: { x: -1, y: 0 },
    patrol: [{ x: 0, y: 0 }],
    hideSpots: [],
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      aiTickSeconds: 0.05,
      chaserSpeed: 0,
      hearingRange: 10,
      soundUncertaintyCells: 2,
      visionRange: 0.1,
      catchRange: 0.1,
    }),
  });
  assert.equal(simulation.emitWorldSound({
    position: { x: 8, y: 0 },
    strength: 1,
    confidence: 0.8,
    sourceType: "environment-decoy",
    sourceId: "corridor-bell",
  }), true);
  const state = simulation.advance(0.1);
  assert.equal(state.chaser.memory.lastKnownEvidence, "sound");
  assert.equal(state.chaser.memory.evidenceTrail?.[0].sourceId, "corridor-bell");
  assert.notDeepEqual(
    state.chaser.memory.lastKnownPosition,
    { x: 8, y: 0 },
    "AI received the exact authored source instead of uncertain perceived evidence",
  );
});

test("simulation preserves a pending decoy heard on the same AI tick as visual evidence", () => {
  const level = createLevel({
    id: "same-tick-visual-decoy",
    width: 9,
    height: 1,
    walkable: [[true, true, true, true, true, true, true, true, true]],
    playerStart: { x: 8, y: 0 },
    exit: { x: 7, y: 0 },
    chaserStart: { x: 0, y: 0 },
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [{ x: 0, y: 0 }],
    hideSpots: [],
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      aiTickSeconds: 0.05,
      chaserSpeed: 0,
      hearingRange: 10,
      soundUncertaintyCells: 2,
      visionRange: 10,
      visionConeDegrees: 180,
      proximitySenseRange: 0,
      catchRange: 0.1,
    }),
  });
  simulation.emitWorldSound({
    position: { x: 6, y: 0 },
    strength: 1,
    confidence: 0.9,
    sourceType: "environment-decoy",
    sourceId: "same-tick-bell",
  });
  const state = simulation.advance(0.1);
  assert.equal(state.chaser.memory.lastKnownEvidence, "visual");
  assert.equal(state.chaser.memory.deferredSoundEvidence?.sourceId, "same-tick-bell");
  assert.equal(
    state.chaser.memory.evidenceTrail?.some((entry) => entry.sourceId === "same-tick-bell"),
    true,
  );
});

test("simulation emits one completion only after reaching and scanning a decoy point", () => {
  const level = createLevel({
    id: "decoy-investigation-completion",
    width: 9,
    height: 3,
    walkable: Array.from({ length: 3 }, () => Array.from({ length: 9 }, () => true)),
    playerStart: { x: 8, y: 0 },
    exit: { x: 8, y: 1 },
    chaserStart: { x: 0, y: 2 },
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [{ x: 0, y: 2 }],
    hideSpots: [],
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      aiTickSeconds: 0.05,
      chaserSpeed: 5,
      hearingRange: 12,
      soundUncertaintyCells: 1,
      visionRange: 0.1,
      proximitySenseRange: 0,
      catchRange: 0.01,
      lastKnownScanSeconds: 0.25,
      searchSeconds: 1,
    }),
  });
  simulation.emitWorldSound({
    position: { x: 8, y: 2 },
    strength: 1,
    confidence: 0.9,
    sourceType: "environment-decoy",
    sourceId: "completed-bell",
  });
  const completions = [];
  for (let frame = 0; frame < 360; frame += 1) {
    const state = simulation.advance(1 / 60);
    completions.push(...state.events.filter((event) => (
      event.type === "evidence-investigation-completed"
    )));
  }
  assert.deepEqual(completions, [{
    type: "evidence-investigation-completed",
    evidenceId: "completed-bell",
    sourceType: "environment-decoy",
  }]);
});
