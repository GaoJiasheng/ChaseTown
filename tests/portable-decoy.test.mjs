import assert from "node:assert/strict";
import test from "node:test";

import { createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import {
  acknowledgePortableDecoySound,
  createPortableDecoyState,
  deployPortableDecoy,
  LIBRARY_PORTABLE_DECOY_DEFINITION,
  samplePortableDecoy,
  stepPortableDecoy,
} from "../app/game/portable-decoy.ts";
import { GameSimulation } from "../app/game/simulation.ts";

function levelFromRows(rows, options = {}) {
  return createLevel({
    id: options.id ?? "portable-decoy-test",
    width: rows[0].length,
    height: rows.length,
    walkable: rows.map((row) => [...row].map((cell) => cell !== "#")),
    playerStart: options.playerStart ?? { x: 8, y: 1 },
    exit: options.exit ?? { x: 9, y: 1 },
    chaserStart: options.chaserStart ?? { x: 1, y: 1 },
    chaserStartHeading: options.chaserStartHeading ?? { x: 1, y: 0 },
    patrol: options.patrol ?? [{ x: 1, y: 1 }],
    hideSpots: [],
  });
}

const corridor = levelFromRows([
  "###########",
  "#.........#",
  "###########",
]);

const decoyDefinition = (overrides = {}) => ({
  ...LIBRARY_PORTABLE_DECOY_DEFINITION,
  id: "test-portable-decoy",
  placementRange: 10,
  fuseSeconds: 0.2,
  activeLifetimeSeconds: 5,
  cooldownSeconds: 0.5,
  ...overrides,
});

function acknowledgeProposal(step, nowSeconds) {
  const stimulus = step.pendingSoundStimulus;
  assert.ok(stimulus, "portable decoy did not propose its due public sound");
  const acknowledged = acknowledgePortableDecoySound(step.state, {
    nowSeconds,
    sourceId: stimulus.sourceId,
  });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(acknowledged.rejection, null);
  assert.deepEqual(acknowledged.events.map((event) => event.type), ["sound-emitted"]);
  return { state: acknowledged.state, stimulus, acknowledged };
}

test("portable decoy completes the public sound, arrival, left-right scan, and receipt chain", () => {
  let decoy = createPortableDecoyState(decoyDefinition({ capacity: 1 }));
  const deployed = deployPortableDecoy(decoy, corridor, {
    nowSeconds: 0,
    actorPosition: { x: 9, y: 1 },
    landingPosition: { x: 6, y: 1 },
  });
  assert.equal(deployed.accepted, true);
  assert.equal(deployed.state.inventoryRemaining, 0);
  assert.deepEqual(deployed.events.map((event) => event.type), ["deployed"]);
  decoy = deployed.state;

  let stepped = stepPortableDecoy(decoy, { nowSeconds: 0.2, deltaSeconds: 0.2 });
  const stimulus = stepped.pendingSoundStimulus;
  assert.ok(stimulus);
  assert.equal(stimulus.sourceType, "environment-decoy");
  assert.deepEqual(stimulus.position, { x: 6, y: 1 });
  assert.deepEqual(stepped.events, [], "a proposal must not claim successful delivery");
  assert.equal(stepped.state.activeDeployment.soundEmitted, false);

  const simulation = new GameSimulation({
    level: corridor,
    autoStart: true,
    config: {
      ...DEFAULT_GAME_CONFIG,
      maxFrameDeltaSeconds: 1,
      spawnDelaySeconds: 0,
      chaserSpeed: 7,
      visionRange: 0.1,
      proximitySenseRange: 0.01,
      catchRange: 0.01,
      hearingRange: 12,
      soundUncertaintyCells: 0,
      lastKnownScanSeconds: 0.8,
    },
  });
  assert.equal(simulation.emitWorldSound(stimulus), true);
  const acknowledged = acknowledgePortableDecoySound(stepped.state, {
    nowSeconds: 0.2,
    sourceId: stimulus.sourceId,
  });
  assert.equal(acknowledged.acknowledged, true);
  assert.deepEqual(acknowledged.events.map((event) => event.type), ["sound-emitted"]);
  decoy = acknowledged.state;

  stepped = stepPortableDecoy(decoy, { nowSeconds: 0.3, deltaSeconds: 0.1 });
  decoy = stepped.state;
  assert.equal(
    stepped.pendingSoundStimulus,
    null,
    "an acknowledged physical decoy proposed another delivery",
  );

  const modes = new Set();
  const scanHeadingY = [];
  let completion = null;
  for (let frame = 0; frame < 300 && !completion; frame += 1) {
    const state = simulation.advance(1 / 60);
    modes.add(state.chaser.mode);
    if (state.chaser.mode === "scan-last-known") scanHeadingY.push(state.chaser.heading.y);
    const completed = state.events.find((event) => (
      event.type === "evidence-investigation-completed"
      && event.evidenceId === stimulus.sourceId
    ));
    if (completed) {
      completion = {
        sourceId: completed.evidenceId,
        sourceType: completed.sourceType,
      };
    }
  }

  assert.ok(completion, "existing AI did not complete the decoy investigation");
  assert.equal(modes.has("go-to-last-known"), true, "AI never travelled to the public sound");
  assert.equal(modes.has("scan-last-known"), true, "AI skipped the authored arrival scan");
  assert.ok(Math.min(...scanHeadingY) < -0.1, "arrival scan never looked left");
  assert.ok(Math.max(...scanHeadingY) > 0.1, "arrival scan never looked right");

  const completedAt = simulation.getState().elapsedSeconds;
  stepped = stepPortableDecoy(decoy, {
    nowSeconds: completedAt,
    deltaSeconds: completedAt - decoy.updatedAtSeconds,
    completedInvestigation: completion,
  });
  assert.deepEqual(stepped.events.map((event) => event.type), ["investigation-completed"]);
  assert.equal(stepped.state.activeDeployment, null);
  assert.equal(stepped.sample.phase, "depleted");
});

test("portable decoy rejects illegal landing points without consuming inventory", () => {
  const state = createPortableDecoyState(decoyDefinition({ placementRange: 3 }));
  const attempt = (level, actorPosition, landingPosition) => deployPortableDecoy(state, level, {
    nowSeconds: 0,
    actorPosition,
    landingPosition,
  });

  assert.equal(attempt(corridor, { x: 9, y: 1 }, { x: Number.NaN, y: 1 }).rejection, "invalid-landing-position");
  assert.equal(attempt(corridor, { x: 9, y: 1 }, { x: 9, y: 0 }).rejection, "landing-not-walkable");
  assert.equal(attempt(corridor, { x: 9, y: 1 }, { x: 5, y: 1 }).rejection, "out-of-range");

  const divided = levelFromRows([
    "#########",
    "#...#...#",
    "#########",
  ], {
    id: "portable-decoy-divided",
    playerStart: { x: 6, y: 1 },
    exit: { x: 7, y: 1 },
    chaserStart: { x: 1, y: 1 },
  });
  const longRangeState = createPortableDecoyState(decoyDefinition({ placementRange: 10 }));
  const blocked = deployPortableDecoy(longRangeState, divided, {
    nowSeconds: 0,
    actorPosition: { x: 2, y: 1 },
    landingPosition: { x: 6, y: 1 },
  });
  assert.equal(blocked.rejection, "trajectory-blocked");

  for (const result of [
    attempt(corridor, { x: 9, y: 1 }, { x: Number.NaN, y: 1 }),
    attempt(corridor, { x: 9, y: 1 }, { x: 9, y: 0 }),
    attempt(corridor, { x: 9, y: 1 }, { x: 5, y: 1 }),
    blocked,
  ]) {
    assert.equal(result.accepted, false);
    assert.equal(result.state.inventoryRemaining, result.state.definition.capacity);
    assert.equal(result.state.activeDeployment, null);
  }
});

test("inventory, cooldown, and repeat-use attenuation bound repeated deployments", () => {
  let state = createPortableDecoyState(decoyDefinition({
    capacity: 2,
    fuseSeconds: 0,
    cooldownSeconds: 1,
    repeatConfidenceMultiplier: 0.5,
  }));
  let deployed = deployPortableDecoy(state, corridor, {
    nowSeconds: 0,
    actorPosition: { x: 9, y: 1 },
    landingPosition: { x: 7, y: 1 },
  });
  state = deployed.state;
  let stepped = stepPortableDecoy(state, { nowSeconds: 0, deltaSeconds: 0 });
  let acknowledged = acknowledgeProposal(stepped, 0);
  state = acknowledged.state;
  const firstStimulus = acknowledged.stimulus;

  stepped = stepPortableDecoy(state, {
    nowSeconds: 0.2,
    deltaSeconds: 0.2,
    completedInvestigation: {
      sourceId: firstStimulus.sourceId,
      sourceType: "environment-decoy",
    },
  });
  state = stepped.state;
  assert.equal(samplePortableDecoy(state, 0.2).phase, "cooldown");

  const tooSoon = deployPortableDecoy(state, corridor, {
    nowSeconds: 0.2,
    actorPosition: { x: 9, y: 1 },
    landingPosition: { x: 7, y: 1 },
  });
  assert.equal(tooSoon.rejection, "cooldown-active");

  deployed = deployPortableDecoy(state, corridor, {
    nowSeconds: 1,
    actorPosition: { x: 9, y: 1 },
    landingPosition: { x: 6, y: 1 },
  });
  assert.equal(deployed.accepted, true);
  assert.equal(deployed.state.inventoryRemaining, 0);
  state = deployed.state;
  stepped = stepPortableDecoy(state, { nowSeconds: 1, deltaSeconds: 0 });
  acknowledged = acknowledgeProposal(stepped, 1);
  state = acknowledged.state;
  const secondStimulus = acknowledged.stimulus;
  assert.notEqual(secondStimulus.sourceId, firstStimulus.sourceId);
  assert.equal(
    secondStimulus.confidence,
    firstStimulus.confidence * 0.5,
    "repeat deployment did not lose authored credibility",
  );

  const whileActive = deployPortableDecoy(state, corridor, {
    nowSeconds: 1.1,
    actorPosition: { x: 9, y: 1 },
    landingPosition: { x: 6, y: 1 },
  });
  assert.equal(whileActive.rejection, "deployment-active");

  stepped = stepPortableDecoy(state, {
    nowSeconds: 1.2,
    deltaSeconds: 0.2,
    completedInvestigation: {
      sourceId: secondStimulus.sourceId,
      sourceType: "environment-decoy",
    },
  });
  state = stepped.state;
  const exhausted = deployPortableDecoy(state, corridor, {
    nowSeconds: 2,
    actorPosition: { x: 9, y: 1 },
    landingPosition: { x: 6, y: 1 },
  });
  assert.equal(exhausted.rejection, "inventory-empty");
  assert.equal(samplePortableDecoy(state, 2).phase, "depleted");
});

test("a stronger same-tick sound cannot consume an unacknowledged decoy proposal", () => {
  const deployed = deployPortableDecoy(
    createPortableDecoyState(decoyDefinition({
      capacity: 1,
      fuseSeconds: 0,
      activeLifetimeSeconds: 1,
    })),
    corridor,
    {
      nowSeconds: 0,
      actorPosition: { x: 9, y: 1 },
      landingPosition: { x: 7, y: 1 },
    },
  );
  const proposed = stepPortableDecoy(deployed.state, {
    nowSeconds: 0,
    deltaSeconds: 0,
  });
  const firstProposal = proposed.pendingSoundStimulus;
  assert.ok(firstProposal);
  assert.deepEqual(proposed.events, []);
  assert.equal(proposed.state.activeDeployment.soundEmitted, false);
  assert.equal(proposed.sample.phase, "awaiting-delivery");

  const wrongSource = acknowledgePortableDecoySound(proposed.state, {
    nowSeconds: 0,
    sourceId: `${firstProposal.sourceId}:wrong`,
  });
  assert.equal(wrongSource.acknowledged, false);
  assert.equal(wrongSource.rejection, "source-mismatch");
  assert.equal(wrongSource.state, proposed.state);
  assert.deepEqual(wrongSource.events, []);

  let strongestOnlyPending = {
    position: { x: 5, y: 1 },
    strength: 1,
    sourceType: "environment-hazard",
    sourceId: "same-tick-strong-source",
    confidence: 1,
    decayPerSecond: 0.1,
  };
  const offerToStrongestOnlyBridge = (stimulus) => {
    if (strongestOnlyPending?.strength >= stimulus.strength) return false;
    strongestOnlyPending = stimulus;
    return true;
  };
  assert.equal(
    offerToStrongestOnlyBridge(firstProposal),
    false,
    "the test did not reproduce the stronger pending-sound rejection",
  );

  const retried = stepPortableDecoy(proposed.state, {
    nowSeconds: 1 / 60,
    deltaSeconds: 1 / 60,
  });
  assert.deepEqual(retried.pendingSoundStimulus, firstProposal);
  assert.deepEqual(retried.events, []);
  assert.equal(retried.state.activeDeployment.soundEmitted, false);

  strongestOnlyPending = null;
  assert.equal(offerToStrongestOnlyBridge(retried.pendingSoundStimulus), true);
  const accepted = acknowledgePortableDecoySound(retried.state, {
    nowSeconds: 1 / 60,
    sourceId: retried.pendingSoundStimulus.sourceId,
  });
  assert.equal(accepted.acknowledged, true);
  assert.equal(accepted.rejection, null);
  assert.equal(accepted.state.activeDeployment.soundEmitted, true);
  assert.deepEqual(accepted.events.map((event) => event.type), ["sound-emitted"]);
  assert.equal(
    accepted.events[0].atSeconds,
    0,
    "render-time acknowledgement changed the scheduled fixed-step event time",
  );

  const duplicate = acknowledgePortableDecoySound(accepted.state, {
    nowSeconds: 1 / 60,
    sourceId: retried.pendingSoundStimulus.sourceId,
  });
  assert.equal(duplicate.acknowledged, false);
  assert.equal(duplicate.rejection, "already-acknowledged");
  assert.equal(duplicate.state, accepted.state);
  assert.deepEqual(duplicate.events, []);

  const afterAcknowledgement = stepPortableDecoy(accepted.state, {
    nowSeconds: 2 / 60,
    deltaSeconds: 1 / 60,
  });
  assert.equal(afterAcknowledgement.pendingSoundStimulus, null);
  assert.deepEqual(afterAcknowledgement.events, []);
});

test("fuse and expiry boundaries are one-shot and deterministic across time partitions", () => {
  const definition = decoyDefinition({
    capacity: 1,
    fuseSeconds: 0.5,
    activeLifetimeSeconds: 1,
    cooldownSeconds: 0.25,
  });

  const run = (times) => {
    const deployed = deployPortableDecoy(
      createPortableDecoyState(definition),
      corridor,
      {
        nowSeconds: 0,
        actorPosition: { x: 9, y: 1 },
        landingPosition: { x: 7, y: 1 },
      },
    );
    let state = deployed.state;
    let previous = 0;
    const events = [...deployed.events];
    const stimuli = [];
    for (const nowSeconds of times) {
      const stepped = stepPortableDecoy(state, {
        nowSeconds,
        deltaSeconds: nowSeconds - previous,
      });
      state = stepped.state;
      events.push(...stepped.events);
      if (stepped.pendingSoundStimulus) {
        const acknowledged = acknowledgePortableDecoySound(state, {
          nowSeconds,
          sourceId: stepped.pendingSoundStimulus.sourceId,
        });
        assert.equal(acknowledged.acknowledged, true);
        state = acknowledged.state;
        events.push(...acknowledged.events);
        stimuli.push(stepped.pendingSoundStimulus);
      }
      previous = nowSeconds;
    }
    return { state, events, stimuli };
  };

  const partitioned = run([0.5 - 1e-6, 0.5, 0.75, 1.5]);
  const singleStep = run([0.5, 1.5]);
  assert.equal(partitioned.stimuli.length, 1);
  assert.equal(singleStep.stimuli.length, 1);
  assert.deepEqual(partitioned, singleStep);
  assert.deepEqual(partitioned.events.map((event) => event.type), [
    "deployed",
    "sound-emitted",
    "expired",
  ]);
  assert.equal(partitioned.state.activeDeployment, null);

  assert.throws(
    () => stepPortableDecoy(partitioned.state, { nowSeconds: 1.4, deltaSeconds: 0 }),
    /must not move backwards/,
  );
});

test("an unacknowledged proposal retries until its deterministic expiry boundary", () => {
  const deployed = deployPortableDecoy(
    createPortableDecoyState(decoyDefinition({
      capacity: 1,
      fuseSeconds: 0,
      activeLifetimeSeconds: 1,
    })),
    corridor,
    {
      nowSeconds: 0,
      actorPosition: { x: 9, y: 1 },
      landingPosition: { x: 7, y: 1 },
    },
  );
  let stepped = stepPortableDecoy(deployed.state, {
    nowSeconds: 0,
    deltaSeconds: 0,
  });
  const proposal = stepped.pendingSoundStimulus;
  assert.ok(proposal);

  stepped = stepPortableDecoy(stepped.state, {
    nowSeconds: 0.5,
    deltaSeconds: 0.5,
  });
  assert.deepEqual(stepped.pendingSoundStimulus, proposal);
  assert.equal(stepped.state.activeDeployment.soundEmitted, false);

  const tooLate = acknowledgePortableDecoySound(stepped.state, {
    nowSeconds: 1 + 1e-6,
    sourceId: proposal.sourceId,
  });
  assert.equal(tooLate.acknowledged, false);
  assert.equal(tooLate.rejection, "deployment-expired");
  assert.equal(tooLate.state, stepped.state);

  const expired = stepPortableDecoy(stepped.state, {
    nowSeconds: 1,
    deltaSeconds: 0.5,
  });
  assert.equal(expired.pendingSoundStimulus, null);
  assert.deepEqual(expired.events.map((event) => event.type), ["expired"]);
  assert.equal(expired.state.activeDeployment, null);
  assert.equal(expired.sample.phase, "depleted");
});

test("an investigation receipt resolves at the exact lifetime edge but not after expiry", () => {
  const definition = decoyDefinition({
    capacity: 1,
    fuseSeconds: 0,
    activeLifetimeSeconds: 1,
  });
  const start = () => {
    const deployed = deployPortableDecoy(
      createPortableDecoyState(definition),
      corridor,
      {
        nowSeconds: 0,
        actorPosition: { x: 9, y: 1 },
        landingPosition: { x: 7, y: 1 },
      },
    );
    const proposed = stepPortableDecoy(deployed.state, { nowSeconds: 0, deltaSeconds: 0 });
    return acknowledgeProposal(proposed, 0);
  };

  let emitted = start();
  const sourceId = emitted.stimulus.sourceId;
  let resolved = stepPortableDecoy(emitted.state, {
    nowSeconds: 1,
    deltaSeconds: 1,
    completedInvestigation: { sourceId, sourceType: "environment-decoy" },
  });
  assert.deepEqual(resolved.events.map((event) => event.type), ["investigation-completed"]);

  emitted = start();
  resolved = stepPortableDecoy(emitted.state, {
    nowSeconds: 1 + 1e-6,
    deltaSeconds: 1 + 1e-6,
    completedInvestigation: {
      sourceId: emitted.stimulus.sourceId,
      sourceType: "environment-decoy",
      completedAtSeconds: 1,
    },
  });
  assert.deepEqual(resolved.events.map((event) => event.type), ["investigation-completed"]);
  assert.equal(resolved.events[0].atSeconds, 1);

  emitted = start();
  resolved = stepPortableDecoy(emitted.state, {
    nowSeconds: 1 + 1e-6,
    deltaSeconds: 1 + 1e-6,
    completedInvestigation: {
      sourceId: emitted.stimulus.sourceId,
      sourceType: "environment-decoy",
    },
  });
  assert.deepEqual(resolved.events.map((event) => event.type), ["expired"]);
});

test("investigation receipts cannot predate the sound or arrive from the future", () => {
  const definition = decoyDefinition({
    capacity: 1,
    fuseSeconds: 0.5,
    activeLifetimeSeconds: 1,
  });
  const deployed = deployPortableDecoy(
    createPortableDecoyState(definition),
    corridor,
    {
      nowSeconds: 0,
      actorPosition: { x: 9, y: 1 },
      landingPosition: { x: 7, y: 1 },
    },
  );
  const proposed = stepPortableDecoy(deployed.state, {
    nowSeconds: 0.5,
    deltaSeconds: 0.5,
  });
  let emitted = acknowledgeProposal(proposed, 0.5).state;
  const sourceId = emitted.activeDeployment.sourceId;

  let stepped = stepPortableDecoy(emitted, {
    nowSeconds: 0.6,
    deltaSeconds: 0.1,
    completedInvestigation: {
      sourceId,
      sourceType: "environment-decoy",
      completedAtSeconds: 0.4,
    },
  });
  assert.deepEqual(stepped.events, []);
  assert.ok(stepped.state.activeDeployment);

  emitted = stepped.state;
  stepped = stepPortableDecoy(emitted, {
    nowSeconds: 0.7,
    deltaSeconds: 0.1,
    completedInvestigation: {
      sourceId,
      sourceType: "environment-decoy",
      completedAtSeconds: 0.8,
    },
  });
  assert.deepEqual(stepped.events, []);
  assert.ok(stepped.state.activeDeployment);

  stepped = stepPortableDecoy(stepped.state, {
    nowSeconds: 0.7,
    deltaSeconds: 0,
    completedInvestigation: {
      sourceId,
      sourceType: "environment-decoy",
      completedAtSeconds: 0.7,
    },
  });
  assert.deepEqual(stepped.events.map((event) => event.type), [
    "investigation-completed",
  ]);
});

test("portable decoy authoring rejects invalid finite inventory and timing contracts", () => {
  assert.throws(
    () => createPortableDecoyState(decoyDefinition({ capacity: 0 })),
    /capacity must be a positive integer/,
  );
  assert.throws(
    () => createPortableDecoyState(decoyDefinition({ activeLifetimeSeconds: 0 })),
    /activeLifetimeSeconds must be finite and greater than zero/,
  );
  assert.throws(
    () => createPortableDecoyState(decoyDefinition({ repeatConfidenceMultiplier: 1.1 })),
    /repeatConfidenceMultiplier must be in \(0, 1\]/,
  );
});
