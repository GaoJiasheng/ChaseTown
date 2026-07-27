import assert from "node:assert/strict";
import test from "node:test";

import {
  actionableSoundConfidence,
  createInitialChaser,
  generateSearchHypotheses,
  generateSearchWaypoints,
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
  mechanicActivationNoiseStimulus,
  mechanicRequiresMovementCommitment,
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

test("mechanic activation costs have a real commitment or an immediate public sound", () => {
  const campus = createThemeMechanicDefinition("campus", "bell-cost", { x: 3, y: 4 });
  const campusWarning = stepMechanicInstance(createMechanicInstance(campus), {
    activationRequested: true,
    actorPosition: { x: 3, y: 4 },
    deltaSeconds: 0,
    nowSeconds: 0,
  }).instance;
  const campusNoise = mechanicActivationNoiseStimulus(campus);
  assert.equal(mechanicRequiresMovementCommitment(campusWarning), false);
  assert.equal(campusNoise?.sourceType, "player-movement");
  assert.deepEqual(campusNoise?.position, campus.position);
  assert.ok((campusNoise?.confidence ?? 0) >= 0.82);

  for (const theme of ["hospital", "fire-station"]) {
    const definition = createThemeMechanicDefinition(theme, `${theme}-cost`, { x: 3, y: 4 });
    const warning = stepMechanicInstance(createMechanicInstance(definition), {
      activationRequested: true,
      actorPosition: { x: 3, y: 4 },
      deltaSeconds: 0,
      nowSeconds: 0,
    }).instance;
    assert.equal(mechanicRequiresMovementCommitment(warning), true);
    assert.equal(mechanicActivationNoiseStimulus(definition), null);
    assert.match(definition.warningHint, /保持位置/);
  }
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
    searchPlan: generateSearchWaypoints(
      crossLevel,
      evidence.position,
      left.state.searchSeed,
    ),
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

test("a habituated loud emitter cannot suppress a fresh player sound", () => {
  const cfg = config();
  let chaser = createInitialChaser(crossLevel, cfg);
  for (let use = 0; use < 10; use += 1) {
    chaser = { ...chaser, mode: "patrol", modeElapsedSeconds: 0 };
    chaser = stepChaserBrain(chaser, crossLevel, cfg, {
      evidence: {
        kind: "sound",
        position: { x: 4, y: 7 },
        strength: 0.95,
        confidence: 0.9,
        decayPerSecond: 0.05,
        sourceType: "environment-decoy",
        sourceId: "worn-out-alarm",
        observedAtSeconds: use + 1,
      },
      reachedTarget: false,
      nowSeconds: use + 1,
      deltaSeconds: cfg.aiTickSeconds,
    }).state;
  }
  chaser = { ...chaser, mode: "patrol", modeElapsedSeconds: 0 };
  const playerSound = {
    kind: "sound",
    position: { x: 2, y: 4 },
    strength: 0.55,
    confidence: 0.85,
    decayPerSecond: 0.16,
    sourceType: "hide-interaction",
    sourceId: "fresh-locker-edge",
    observedAtSeconds: 11,
  };
  const result = stepChaserBrain(chaser, crossLevel, cfg, {
    evidence: {
      kind: "sound",
      position: { x: 4, y: 7 },
      strength: 0.95,
      confidence: 0.9,
      decayPerSecond: 0.05,
      sourceType: "environment-decoy",
      sourceId: "worn-out-alarm",
      observedAtSeconds: 11,
    },
    secondarySoundEvidence: playerSound,
    reachedTarget: false,
    nowSeconds: 11,
    deltaSeconds: cfg.aiTickSeconds,
  });

  assert.equal(result.state.mode, "go-to-last-known");
  assert.deepEqual(result.state.memory.lastKnownPosition, playerSound.position);
  assert.equal(result.state.memory.lastHeardAtSeconds, 11);
  assert.equal(
    result.state.memory.evidenceTrail?.some(
      (entry) => entry.sourceId === playerSound.sourceId,
    ),
    true,
  );
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
    completedAtSeconds: completions[0].completedAtSeconds,
    completedAtTick: completions[0].completedAtTick,
  }]);
  assert.ok(Number.isFinite(completions[0].completedAtSeconds));
  assert.ok(Number.isInteger(completions[0].completedAtTick));
});

test("authored world sounds survive same-tick strength competition and drain once", () => {
  const level = createLevel({
    id: "authored-sound-queue",
    width: 9,
    height: 1,
    walkable: [Array.from({ length: 9 }, () => true)],
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
      hearingRange: 12,
      visionRange: 0.1,
      proximitySenseRange: 0,
      catchRange: 0.01,
      soundUncertaintyCells: 0,
    }),
  });
  for (const [sourceId, strength] of [
    ["source-1.0", 1],
    ["source-0.9", 0.9],
    ["source-0.8", 0.8],
  ]) {
    assert.equal(simulation.emitWorldSound({
      position: { x: 6, y: 0 },
      strength,
      confidence: 0.9,
      sourceType: "environment-decoy",
      sourceId,
    }), true);
  }
  assert.deepEqual(
    simulation.getWorldSoundQueueSnapshot().authoredPending.map(
      (entry) => entry.sourceId,
    ),
    ["source-1.0", "source-0.9", "source-0.8"],
  );

  simulation.advance(0.15);
  const drained = simulation.getWorldSoundQueueSnapshot();
  assert.equal(drained.authoredPending.length, 0);
  assert.equal(drained.acceptedCount, 3);
  assert.equal(drained.deliveredCount, 3);
  assert.equal(drained.lastDeliveredSourceId, "source-0.8");
});

test("an unheard weak world sound cannot erase a stronger same-tick locker edge", () => {
  const level = createLevel({
    id: "world-player-sound-arbitration",
    width: 7,
    height: 3,
    walkable: Array.from({ length: 3 }, () => Array(7).fill(true)),
    playerStart: { x: 6, y: 1 },
    exit: { x: 6, y: 2 },
    chaserStart: { x: 0, y: 1 },
    chaserStartHeading: { x: -1, y: 0 },
    patrol: [{ x: 0, y: 1 }],
    hideSpots: [{
      id: "sound-arbitration-locker",
      approach: { x: 6, y: 1 },
      concealed: { x: 6, y: 0.7 },
      facing: { x: 0, y: 1 },
    }],
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      fixedStepSeconds: 0.05,
      maxFrameDeltaSeconds: 0.2,
      aiTickSeconds: 0.05,
      chaserSpeed: 0,
      visionRange: 0.1,
      proximitySenseRange: 0,
      hearingRange: 20,
      catchRange: 0.01,
      soundUncertaintyCells: 0,
      hideAlignTurnSpeed: 100,
    }),
  });

  simulation.advance(0.05, { interactPressed: true });
  assert.equal(simulation.getState().player.mode, "aligning-hide");
  assert.equal(simulation.scheduleWorldSound({
    position: { x: 3, y: 1 },
    strength: 0.05,
    confidence: 0.2,
    sourceType: "environment-decoy",
    sourceId: "unheard-weak-world",
  }, simulation.getState().elapsedSeconds), true);
  const state = simulation.advance(0.05);

  assert.equal(state.player.mode, "entering-hide");
  assert.ok(
    state.chaser.memory.evidenceTrail?.some(
      (entry) => entry.sourceType === "hide-interaction",
    ),
    "the audible locker edge was erased by an inaudible authored sound",
  );
  assert.equal(simulation.getWorldSoundQueueSnapshot().playerSoundPending, false);
  assert.equal(simulation.getWorldSoundQueueSnapshot().authoredPending.length, 0);
});

test("two audible same-tick sounds keep the stronger cue and ledger the second", () => {
  const level = createLevel({
    id: "two-audible-sounds",
    width: 7,
    height: 3,
    walkable: Array.from({ length: 3 }, () => Array(7).fill(true)),
    playerStart: { x: 6, y: 1 },
    exit: { x: 6, y: 2 },
    chaserStart: { x: 0, y: 1 },
    chaserStartHeading: { x: -1, y: 0 },
    patrol: [{ x: 0, y: 1 }],
    hideSpots: [{
      id: "two-sound-locker",
      approach: { x: 6, y: 1 },
      concealed: { x: 6, y: 0.7 },
      facing: { x: 0, y: 1 },
    }],
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      fixedStepSeconds: 0.05,
      maxFrameDeltaSeconds: 0.2,
      aiTickSeconds: 0.05,
      chaserSpeed: 0,
      visionRange: 0.1,
      proximitySenseRange: 0,
      hearingRange: 20,
      catchRange: 0.01,
      soundUncertaintyCells: 0,
      hideAlignTurnSpeed: 100,
    }),
  });

  simulation.advance(0.05, { interactPressed: true });
  assert.equal(simulation.scheduleWorldSound({
    position: { x: 1, y: 1 },
    strength: 0.2,
    confidence: 0.8,
    sourceType: "environment-decoy",
    sourceId: "audible-world",
  }, simulation.getState().elapsedSeconds), true);
  const state = simulation.advance(0.05);
  const sources = new Set(
    state.chaser.memory.evidenceTrail?.map((entry) => (
      entry.sourceType === "hide-interaction"
        ? "hide-interaction"
        : entry.sourceId
    )),
  );

  assert.equal(sources.has("hide-interaction"), true);
  assert.equal(sources.has("audible-world"), true);
  assert.equal(simulation.getWorldSoundQueueSnapshot().authoredPending.length, 0);
});

test("scheduled authored sound lands on the same fixed AI tick at 30/60/120/144Hz", () => {
  const level = createLevel({
    id: "scheduled-sound-cadence",
    width: 9,
    height: 1,
    walkable: [Array.from({ length: 9 }, () => true)],
    playerStart: { x: 8, y: 0 },
    exit: { x: 7, y: 0 },
    chaserStart: { x: 0, y: 0 },
    chaserStartHeading: { x: -1, y: 0 },
    patrol: [{ x: 0, y: 0 }],
    hideSpots: [],
  });
  const samples = [30, 60, 120, 144].map((refreshRate) => {
    const simulation = new GameSimulation({
      level,
      autoStart: true,
      config: config({
        fixedStepSeconds: 1 / 60,
        aiTickSeconds: 0.1,
        chaserSpeed: 0,
        hearingRange: 12,
        visionRange: 0.1,
        proximitySenseRange: 0,
        catchRange: 0.01,
        soundUncertaintyCells: 0,
      }),
    });
    assert.equal(simulation.scheduleWorldSound({
      position: { x: 6, y: 0 },
      strength: 0.9,
      confidence: 0.84,
      sourceType: "environment-decoy",
      sourceId: "cadence-decoy",
    }, 0.45), true);
    for (let frame = 0; frame < refreshRate * 2; frame += 1) {
      simulation.advance(1 / refreshRate);
      if (simulation.getWorldSoundQueueSnapshot().deliveredCount === 1) break;
    }
    return simulation.getWorldSoundQueueSnapshot();
  });

  assert.deepEqual(samples.map((sample) => sample.lastDeliveredTick), [
    30,
    30,
    30,
    30,
  ]);
  for (const sample of samples) {
    assert.equal(sample.acceptedCount, 1);
    assert.equal(sample.deliveredCount, 1);
    assert.equal(sample.authoredPending.length, 0);
  }
});
