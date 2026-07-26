import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialChaser,
  stepChaserBrain,
} from "../app/game/chaser-fsm.ts";
import { createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import { aiEvidenceCandidateToPerception } from "../app/game/stealth-expansion.ts";
import { GameSimulation } from "../app/game/simulation.ts";

function config(overrides = {}) {
  return {
    ...DEFAULT_GAME_CONFIG,
    fixedStepSeconds: 1 / 60,
    maxFrameDeltaSeconds: 1,
    aiTickSeconds: 0.05,
    spawnDelaySeconds: 0,
    proximitySenseRange: 0.01,
    catchRange: 0.01,
    ...overrides,
  };
}

function openLevel({
  id,
  width,
  height = 3,
  playerStart,
  exit,
  chaserStart,
  chaserStartHeading = { x: 1, y: 0 },
  patrol = [chaserStart],
}) {
  return createLevel({
    id,
    width,
    height,
    walkable: Array.from(
      { length: height },
      () => Array.from({ length: width }, () => true),
    ),
    playerStart,
    exit,
    chaserStart,
    chaserStartHeading,
    patrol,
    hideSpots: [],
  });
}

function worldClue(overrides = {}) {
  return {
    kind: "world-clue",
    clueId: "clue:door:west",
    position: { x: 4, y: 2 },
    observedAtSeconds: 0,
    confidence: 0.92,
    sourceType: "door-disturbance",
    decayPerSecond: 0.01,
    ...overrides,
  };
}

test("a public world clue drives approach, left/right arrival scan, search, and one investigation receipt", () => {
  const level = openLevel({
    id: "world-clue-full-investigation",
    width: 9,
    playerStart: { x: 8, y: 0 },
    exit: { x: 0, y: 0 },
    chaserStart: { x: 0, y: 2 },
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      chaserSpeed: 4,
      visionRange: 0.1,
      lastKnownScanSeconds: 0.5,
      searchSeconds: 1.5,
      searchWaypointSeconds: 0.2,
    }),
  });
  const clue = worldClue();

  assert.equal(simulation.emitWorldClue(clue), true);
  const modes = [];
  const scanYawSides = [];
  const receipts = [];
  let scanOrigin = null;
  for (let frame = 0; frame < 300; frame += 1) {
    const state = simulation.advance(1 / 60);
    modes.push(state.chaser.mode);
    if (state.chaser.mode === "scan-last-known") {
      scanOrigin ??= state.chaser.scanOriginHeading;
      scanYawSides.push(
        scanOrigin.x * state.chaser.heading.y
          - scanOrigin.y * state.chaser.heading.x,
      );
    }
    receipts.push(...state.events.filter((event) => (
      event.type === "evidence-investigation-completed"
    )));
  }

  const approachAt = modes.indexOf("go-to-last-known");
  const scanAt = modes.indexOf("scan-last-known");
  const searchAt = modes.indexOf("search");
  assert.ok(approachAt >= 0, "the clue never became a navigation anchor");
  assert.ok(scanAt > approachAt, "arrival scan did not follow clue approach");
  assert.ok(searchAt > scanAt, "local search did not follow the arrival scan");
  assert.ok(
    Math.min(...scanYawSides) < -0.35 && Math.max(...scanYawSides) > 0.35,
    "arrival performance did not visibly inspect both sides",
  );
  assert.equal(
    simulation.getState().chaser.memory.evidenceTrail?.some((entry) => (
      entry.kind === "world-clue"
      && entry.sourceId === clue.clueId
      && entry.sourceType === clue.sourceType
    )),
    false,
    "the completed short search should eventually release stale evidence",
  );
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], {
    type: "evidence-investigation-completed",
    evidenceId: clue.clueId,
    sourceType: clue.sourceType,
    completedAtSeconds: receipts[0].completedAtSeconds,
    completedAtTick: receipts[0].completedAtTick,
  });
  assert.ok(Number.isFinite(receipts[0].completedAtSeconds));
  assert.ok(Number.isInteger(receipts[0].completedAtTick));
});

test("same-tick sight remains primary and a world clue cannot overwrite a committed visual anchor", () => {
  const level = openLevel({
    id: "visual-over-world-clue",
    width: 9,
    height: 1,
    playerStart: { x: 8, y: 0 },
    exit: { x: 7, y: 0 },
    chaserStart: { x: 0, y: 0 },
  });
  const cfg = config({
    chaserSpeed: 0,
    visionRange: 10,
    visionConeDegrees: 180,
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: cfg,
  });
  const clue = worldClue({
    clueId: "clue:prop:same-tick",
    position: { x: 3, y: 0 },
    sourceType: "disturbed-prop",
  });

  simulation.emitWorldClue(clue);
  const state = simulation.advance(0.05);
  assert.equal(state.chaser.memory.lastKnownEvidence, "visual");
  assert.deepEqual(state.chaser.memory.lastKnownPosition, level.playerStart);
  assert.equal(state.chaser.mode, "suspicious");
  assert.deepEqual(simulation.getWorldClueQueueSnapshot(), {
    pending: [{
      clueId: clue.clueId,
      sourceType: clue.sourceType,
      confidence: clue.confidence,
      observedAtSeconds: clue.observedAtSeconds,
    }],
    acceptedCount: 1,
    deliveredCount: 0,
    lastDeliveredClueId: null,
  });

  const directOverride = stepChaserBrain(state.chaser, level, cfg, {
    evidence: clue,
    reachedTarget: false,
    nowSeconds: 0.1,
    deltaSeconds: 0.05,
  }).state;
  assert.equal(directOverride.memory.lastKnownEvidence, "visual");
  assert.deepEqual(directOverride.memory.lastKnownPosition, level.playerStart);
  assert.equal(
    directOverride.mode,
    "lost-sight",
    "losing sight should pursue the visual anchor, not reroute to the weaker clue",
  );
});

test("a world clue cannot erase a concurrent public sound while visual pursuit stays primary", () => {
  const level = openLevel({
    id: "visual-clue-sound-concurrency",
    width: 10,
    height: 1,
    playerStart: { x: 9, y: 0 },
    exit: { x: 8, y: 0 },
    chaserStart: { x: 0, y: 0 },
  });
  const cfg = config({
    chaserSpeed: 0,
    visionRange: 12,
    visionConeDegrees: 180,
  });
  const initial = createInitialChaser(level, cfg);
  const visual = {
    kind: "player-visible",
    position: { x: 9, y: 0 },
    observedAtSeconds: 1,
  };
  const visuallyCommitted = stepChaserBrain(initial, level, cfg, {
    evidence: visual,
    reachedTarget: false,
    nowSeconds: 1,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;
  const clue = worldClue({
    clueId: "clue:door:concurrent",
    position: { x: 4, y: 0 },
    observedAtSeconds: 1.05,
  });
  const sound = {
    kind: "sound",
    position: { x: 2, y: 0 },
    strength: 0.88,
    confidence: 0.84,
    decayPerSecond: 0.1,
    sourceType: "environment-decoy",
    sourceId: "concurrent-bell",
    observedAtSeconds: 1.05,
  };

  const result = stepChaserBrain(visuallyCommitted, level, cfg, {
    evidence: clue,
    secondarySoundEvidence: sound,
    reachedTarget: false,
    nowSeconds: 1.05,
    deltaSeconds: cfg.aiTickSeconds,
  }).state;

  assert.equal(result.memory.lastKnownEvidence, "visual");
  assert.deepEqual(result.memory.lastKnownPosition, visual.position);
  assert.equal(result.memory.deferredSoundEvidence?.sourceId, sound.sourceId);
  assert.deepEqual(
    new Set(result.memory.evidenceTrail?.map((entry) => entry.sourceId)),
    new Set(["player-visual", clue.clueId, sound.sourceId]),
  );
});

test("a stable clueId is idempotent at ingestion and cannot reset an in-flight route", () => {
  const level = openLevel({
    id: "world-clue-idempotence",
    width: 10,
    playerStart: { x: 9, y: 0 },
    exit: { x: 0, y: 0 },
    chaserStart: { x: 0, y: 2 },
  });
  const cfg = config({ visionRange: 0.1, chaserSpeed: 0 });
  const clue = worldClue({
    clueId: "clue:stable-id",
    position: { x: 8, y: 2 },
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: cfg,
  });

  assert.equal(simulation.emitWorldClue(clue), true);
  assert.equal(simulation.emitWorldClue({ ...clue, confidence: 0.2 }), true);
  assert.deepEqual(simulation.getWorldClueQueueSnapshot(), {
    pending: [{
      clueId: clue.clueId,
      sourceType: clue.sourceType,
      confidence: clue.confidence,
      observedAtSeconds: clue.observedAtSeconds,
    }],
    acceptedCount: 1,
    deliveredCount: 0,
    lastDeliveredClueId: null,
  });
  simulation.advance(0.05);
  assert.deepEqual(simulation.getWorldClueQueueSnapshot(), {
    pending: [],
    acceptedCount: 1,
    deliveredCount: 1,
    lastDeliveredClueId: clue.clueId,
  });
  assert.equal(simulation.emitWorldClue({ ...clue, observedAtSeconds: 0.05 }), true);
  assert.equal(simulation.getWorldClueQueueSnapshot().pending.length, 0);

  let chaser = createInitialChaser(level, cfg);
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: clue,
    reachedTarget: false,
    nowSeconds: 0.05,
    deltaSeconds: 0.05,
  }).state;
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { kind: "none", observedAtSeconds: 0.25 },
    reachedTarget: false,
    nowSeconds: 0.25,
    deltaSeconds: 0.2,
  }).state;
  const elapsedBeforeDuplicate = chaser.modeElapsedSeconds;
  const anchorBeforeDuplicate = chaser.memory.lastKnownPosition;
  chaser = stepChaserBrain(chaser, level, cfg, {
    evidence: { ...clue, observedAtSeconds: 0.3 },
    reachedTarget: false,
    nowSeconds: 0.3,
    deltaSeconds: 0.05,
  }).state;

  assert.equal(chaser.mode, "go-to-last-known");
  assert.ok(chaser.modeElapsedSeconds > elapsedBeforeDuplicate);
  assert.deepEqual(chaser.memory.lastKnownPosition, anchorBeforeDuplicate);
  assert.equal(
    chaser.memory.evidenceTrail?.filter((entry) => (
      entry.kind === "world-clue" && entry.sourceId === clue.clueId
    )).length,
    1,
  );
});

test("world clue idempotence memory stays bounded and accepts the 97th consumed clue", () => {
  const level = openLevel({
    id: "world-clue-bounded-recent-id-window",
    width: 9,
    playerStart: { x: 8, y: 0 },
    exit: { x: 0, y: 0 },
    chaserStart: { x: 0, y: 2 },
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      chaserSpeed: 0,
      visionRange: 0.1,
    }),
  });

  for (let index = 0; index < 97; index += 1) {
    const clue = worldClue({
      clueId: `clue:rolling:${index}`,
      observedAtSeconds: simulation.getState().elapsedSeconds,
    });
    assert.equal(
      simulation.emitWorldClue(clue),
      true,
      `unique clue ${index + 1} should be admitted`,
    );
    assert.equal(
      simulation.emitWorldClue({ ...clue, confidence: 0.2 }),
      true,
      "a recent duplicate should remain an idempotent success",
    );
    simulation.advance(0.05);
    assert.equal(simulation.getWorldClueQueueSnapshot().pending.length, 0);
  }

  assert.deepEqual(simulation.getWorldClueQueueSnapshot(), {
    pending: [],
    acceptedCount: 97,
    deliveredCount: 97,
    lastDeliveredClueId: "clue:rolling:96",
  });

  assert.equal(
    simulation.emitWorldClue(worldClue({
      clueId: "clue:rolling:0",
      observedAtSeconds: simulation.getState().elapsedSeconds,
    })),
    true,
    "the oldest consumed id should be reusable after leaving the recent window",
  );
  assert.equal(simulation.getWorldClueQueueSnapshot().acceptedCount, 98);
});

test("the AI projection white-lists public clue fields and discards genuine/forged metadata", () => {
  const baseCandidate = {
    evidence: {
      id: "trace:neutral",
      kind: "footprint",
      position: { x: 2, y: 3 },
      source: {
        publicId: "floor:west-corridor",
        kind: "surface",
        publicity: "world-observable",
      },
      detail: { direction: { x: 1, y: 0 } },
      createdAtTick: 20,
      ageTicks: 5,
      expiresAtTick: 200,
      confidence: 0.84,
    },
    distance: 2,
    headingAlignment: 1,
    investigationScore: 0.84,
  };
  const genuineCandidate = {
    ...baseCandidate,
    authenticity: "genuine",
    evidence: {
      ...baseCandidate.evidence,
      origin: "authentic",
      forged: false,
    },
  };
  const forgedCandidate = {
    ...baseCandidate,
    authenticity: "forged",
    evidence: {
      ...baseCandidate.evidence,
      origin: "fabricated",
      forged: true,
    },
  };

  const genuinePerception = aiEvidenceCandidateToPerception(genuineCandidate, 2.5);
  const forgedPerception = aiEvidenceCandidateToPerception(forgedCandidate, 2.5);
  assert.deepEqual(genuinePerception, forgedPerception);
  assert.deepEqual(Object.keys(genuinePerception).sort(), [
    "clueId",
    "confidence",
    "decayPerSecond",
    "kind",
    "observedAtSeconds",
    "position",
    "sourceType",
  ]);
  assert.doesNotMatch(
    JSON.stringify(genuinePerception),
    /authentic|fabricated|forged|genuine|origin/i,
  );
});

test("chaserSpeedMultiplier zero freezes only chaser translation while player and AI clocks continue", () => {
  const level = openLevel({
    id: "bounded-chaser-translation-freeze",
    width: 11,
    playerStart: { x: 1, y: 0 },
    exit: { x: 10, y: 0 },
    chaserStart: { x: 1, y: 2 },
  });
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: config({
      playerSpeed: 2,
      chaserSpeed: 2,
      hearingRange: 0.1,
      visionRange: 0.1,
    }),
  });
  const clue = worldClue({
    clueId: "clue:freeze-route",
    position: { x: 9, y: 2 },
  });
  simulation.emitWorldClue(clue);

  const acquired = simulation.advance(0.05, { chaserSpeedMultiplier: 0 });
  assert.equal(acquired.chaser.mode, "go-to-last-known");
  const frozenPosition = acquired.chaser.position;
  const playerBefore = acquired.player.position;
  const tickBefore = acquired.tick;
  const aiModeElapsedBefore = acquired.chaser.modeElapsedSeconds;

  const frozen = simulation.advance(0.3, {
    move: { x: 1, y: 0 },
    chaserSpeedMultiplier: 0,
  });
  assert.deepEqual(frozen.chaser.position, frozenPosition);
  assert.ok(frozen.player.position.x > playerBefore.x + 0.5);
  assert.ok(frozen.tick > tickBefore);
  assert.ok(frozen.elapsedSeconds > acquired.elapsedSeconds);
  assert.ok(frozen.chaser.modeElapsedSeconds > aiModeElapsedBefore);
  assert.equal(frozen.chaser.mode, "go-to-last-known");
  assert.equal(frozen.phase, "playing");

  const resumed = simulation.advance(0.3, { chaserSpeedMultiplier: 1 });
  assert.ok(resumed.chaser.position.x > frozen.chaser.position.x + 0.5);
  assert.ok(resumed.tick > frozen.tick);
  assert.ok(resumed.chaser.modeElapsedSeconds > frozen.chaser.modeElapsedSeconds);
  assert.equal(resumed.chaser.mode, "go-to-last-known");
});

test("patrol pressure cannot leak extra speed into the visual-acquisition chase tick", () => {
  const level = openLevel({
    id: "chase-transition-speed-fairness",
    width: 12,
    playerStart: { x: 8, y: 1 },
    exit: { x: 11, y: 1 },
    chaserStart: { x: 1, y: 1 },
    patrol: [{ x: 1, y: 1 }, { x: 2, y: 1 }],
  });
  const createSimulation = () => new GameSimulation({
    level,
    autoStart: true,
    config: config({
      chaserSpeed: 2,
      visionRange: 20,
      visionHalfAngleRadians: Math.PI / 3,
      suspiciousSeconds: 0.05,
    }),
  });
  const advanceToAcquisitionBoundary = (simulation) => {
    for (let tick = 0; tick < 5; tick += 1) {
      simulation.advance(1 / 60, { chaserSpeedMultiplier: 1 });
    }
    assert.equal(simulation.getState().chaser.mode, "suspicious");
  };

  const baselineSimulation = createSimulation();
  const pressuredSimulation = createSimulation();
  const wedgedSimulation = createSimulation();
  for (const simulation of [
    baselineSimulation,
    pressuredSimulation,
    wedgedSimulation,
  ]) {
    advanceToAcquisitionBoundary(simulation);
  }

  const baseline = baselineSimulation.advance(1 / 60, {
    chaserSpeedMultiplier: 1,
  });
  const pressured = pressuredSimulation.advance(1 / 60, {
    chaserSpeedMultiplier: 1.25,
  });
  const wedged = wedgedSimulation.advance(1 / 60, {
    chaserSpeedMultiplier: 0,
  });

  assert.equal(baseline.chaser.mode, "chase");
  assert.equal(pressured.chaser.mode, "chase");
  assert.equal(wedged.chaser.mode, "chase");
  assert.deepEqual(pressured.chaser.position, baseline.chaser.position);
  assert.ok(baseline.chaser.position.x > level.chaserStart.x);
  assert.deepEqual(wedged.chaser.position, level.chaserStart);
});
