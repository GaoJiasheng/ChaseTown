import assert from "node:assert/strict";
import test from "node:test";

import {
  createStealthEvidenceState,
  DEFAULT_STEALTH_EVIDENCE_DEFINITION,
  defineStealthEvidence,
  queryStealthEvidenceForAi,
  replayStealthEvidence,
  selectStealthEvidenceForAi,
  STEALTH_EVIDENCE_MAX_SERIAL,
  STEALTH_EVIDENCE_MAX_TICK,
  stealthEvidenceConfidenceAtTick,
  stepStealthEvidence,
  validateStealthEvidenceDefinition,
} from "../app/game/stealth-evidence.ts";

const publicSource = (kind, publicId, publicity = "world-observable") => ({
  kind,
  publicId,
  publicity,
});

const footprint = (overrides = {}) => ({
  kind: "footprint",
  position: { x: 2, y: 0 },
  source: publicSource("surface", "library-floor-east"),
  detail: { direction: { x: 1, y: 0 } },
  ...overrides,
});

const doorState = (overrides = {}) => ({
  kind: "door-state",
  position: { x: 4, y: 0 },
  source: publicSource("door", "library-reading-room-door"),
  detail: { state: "open" },
  ...overrides,
});

const movedObject = (overrides = {}) => ({
  kind: "moved-object",
  position: { x: 6, y: 0 },
  source: publicSource("object", "library-reference-cart"),
  detail: { state: "moved" },
  ...overrides,
});

const powerChange = (overrides = {}) => ({
  kind: "power-change",
  position: { x: 8, y: 0 },
  source: publicSource("power-grid", "library-east-breaker"),
  detail: { state: "offline" },
  ...overrides,
});

const decoyResidue = (overrides = {}) => ({
  kind: "decoy-residue",
  position: { x: 10, y: 0 },
  source: publicSource("decoy", "library-notebook-decoy-1"),
  detail: { state: "fresh" },
  ...overrides,
});

const command = (observation, tick = 0, type = "record") => ({
  type,
  tick,
  observation,
});

const broadQuery = (overrides = {}) => ({
  atTick: 0,
  observer: {
    position: { x: 0, y: 0 },
    heading: { x: 1, y: 0 },
  },
  maximumDistance: 30,
  fieldOfViewDegrees: 360,
  ...overrides,
});

function testDefinition(overrides = {}) {
  const { rules: ruleOverrides, ...topLevelOverrides } = overrides;
  const base = DEFAULT_STEALTH_EVIDENCE_DEFINITION;
  return defineStealthEvidence({
    ...base,
    id: "stealth-evidence-test",
    ...topLevelOverrides,
    rules: {
      footprint: {
        ...base.rules.footprint,
        ...ruleOverrides?.footprint,
      },
      "door-state": {
        ...base.rules["door-state"],
        ...ruleOverrides?.["door-state"],
      },
      "moved-object": {
        ...base.rules["moved-object"],
        ...ruleOverrides?.["moved-object"],
      },
      "power-change": {
        ...base.rules["power-change"],
        ...ruleOverrides?.["power-change"],
      },
      "decoy-residue": {
        ...base.rules["decoy-residue"],
        ...ruleOverrides?.["decoy-residue"],
      },
    },
  });
}

function recordOne(state, observation, tick = state.tick) {
  const step = stepStealthEvidence(state, command(observation, tick));
  assert.equal(step.accepted, true);
  assert.equal(step.rejection, null);
  return step;
}

test("the ledger supports all five authored public evidence families", () => {
  let state = createStealthEvidenceState();
  const observations = [
    footprint(),
    doorState(),
    movedObject(),
    powerChange(),
    decoyResidue(),
  ];

  for (const [index, observation] of observations.entries()) {
    const step = recordOne(state, observation, index);
    state = step.state;
    assert.deepEqual(step.events.at(-1), {
      type: "evidence-recorded",
      evidence: step.events.at(-1).evidence,
      atTick: index,
    });
  }

  assert.deepEqual(state.records.map(({ kind }) => kind), [
    "footprint",
    "door-state",
    "moved-object",
    "power-change",
    "decoy-residue",
  ]);
  assert.deepEqual(state.records.map(({ id }) => id), [
    "campaign-stealth-evidence-v1:evidence:1",
    "campaign-stealth-evidence-v1:evidence:2",
    "campaign-stealth-evidence-v1:evidence:3",
    "campaign-stealth-evidence-v1:evidence:4",
    "campaign-stealth-evidence-v1:evidence:5",
  ]);
  assert.ok(state.records.every(({ origin }) => origin === "authentic"));
  assert.deepEqual(state.records[0].detail, {
    direction: { x: 1, y: 0 },
  });

  const query = queryStealthEvidenceForAi(state, broadQuery({ atTick: 4 }));
  assert.equal(query.length, 5);
  assert.ok(query.every(({ evidence }) => evidence.source.publicity === "world-observable"));
  assert.ok(query.some(({ evidence }) => evidence.source.publicId === "library-east-breaker"));
});

test("stateful fixture evidence supersedes its old public state deterministically", () => {
  let step = recordOne(createStealthEvidenceState(), doorState(), 0);
  const firstId = step.state.records[0].id;
  step = recordOne(step.state, doorState({
    position: { x: 4.25, y: 0 },
    detail: { state: "closed" },
  }), 8);

  assert.equal(step.state.records.length, 1);
  assert.equal(step.state.records[0].detail.state, "closed");
  assert.equal(step.state.records[0].id.endsWith(":2"), true);
  assert.deepEqual(step.events.map(({ type }) => type), [
    "evidence-recorded",
    "evidence-superseded",
  ]);
  assert.equal(step.events[1].evidenceId, firstId);
  assert.equal(step.events[1].replacementEvidenceId, step.state.records[0].id);

  step = recordOne(step.state, footprint({
    position: { x: 1, y: 1 },
  }), 8);
  step = recordOne(step.state, footprint({
    position: { x: 1.5, y: 1 },
  }), 8);
  assert.equal(
    step.state.records.filter(({ kind }) => kind === "footprint").length,
    2,
    "footprints on one public surface should form a trail, not overwrite one another",
  );
});

test("confidence decay and expiry are fixed-tick exact", () => {
  const definition = testDefinition({
    minimumRetainedConfidence: 0,
    minimumAiConfidence: 0,
    rules: {
      footprint: {
        initialConfidence: 1,
        decayPerTick: 0.1,
        lifetimeTicks: 10,
      },
    },
  });
  let state = createStealthEvidenceState(definition, 5);
  state = recordOne(state, footprint(), 5).state;
  const evidence = state.records[0];

  assert.equal(stealthEvidenceConfidenceAtTick(evidence, 5), 1);
  assert.ok(Math.abs(stealthEvidenceConfidenceAtTick(evidence, 8) - 0.7) < 1e-12);
  assert.throws(
    () => stealthEvidenceConfidenceAtTick(evidence, 4),
    /at or after its creation tick/,
  );

  const beforeBoundary = stepStealthEvidence(state, { type: "advance", tick: 14 });
  assert.equal(beforeBoundary.accepted, true);
  assert.equal(beforeBoundary.state.records.length, 1);
  assert.ok(
    Math.abs(
      queryStealthEvidenceForAi(
        beforeBoundary.state,
        broadQuery({ atTick: 14, minimumConfidence: 0 }),
      )[0].evidence.confidence - 0.1,
    ) < 1e-12,
  );

  const atBoundary = stepStealthEvidence(beforeBoundary.state, {
    type: "advance",
    tick: 15,
  });
  assert.equal(atBoundary.state.records.length, 0);
  assert.deepEqual(atBoundary.events.map(({ type }) => type), ["evidence-expired"]);
  assert.equal(atBoundary.events[0].atTick, 15);
});

test("direct and granular advancement produce the same tick-derived state", () => {
  const definition = testDefinition({
    minimumRetainedConfidence: 0,
    rules: {
      footprint: {
        decayPerTick: 0.001,
        lifetimeTicks: 1_000,
      },
    },
  });
  const recorded = recordOne(
    createStealthEvidenceState(definition),
    footprint({
      detail: {
        direction: {
          x: 478_984.02486564964,
          y: -588_813.5880277476,
        },
      },
    }),
    0,
  ).state;
  const direct = stepStealthEvidence(recorded, { type: "advance", tick: 120 }).state;
  let granular = recorded;
  for (let tick = 1; tick <= 120; tick += 1) {
    granular = stepStealthEvidence(granular, { type: "advance", tick }).state;
  }

  assert.deepEqual(granular, direct);
  assert.equal(JSON.stringify(granular), JSON.stringify(direct));
  assert.equal(
    queryStealthEvidenceForAi(direct, broadQuery({ atTick: 120 }))[0]
      .evidence.confidence,
    queryStealthEvidenceForAi(granular, broadQuery({ atTick: 120 }))[0]
      .evidence.confidence,
  );
});

test("batched and granular fixed ticks emit the same authoritative expiry edge", () => {
  const definition = testDefinition({
    minimumRetainedConfidence: 0,
    minimumAiConfidence: 0,
    rules: {
      footprint: {
        initialConfidence: 1,
        decayPerTick: 0,
        lifetimeTicks: 10,
      },
    },
  });
  const recorded = command(footprint(), 0);
  const direct = replayStealthEvidence(definition, [
    recorded,
    { type: "advance", tick: 20 },
  ]);
  const granular = replayStealthEvidence(definition, [
    recorded,
    ...Array.from({ length: 20 }, (_, index) => ({
      type: "advance",
      tick: index + 1,
    })),
  ]);

  assert.deepEqual(direct.state, granular.state);
  assert.deepEqual(direct.events, granular.events);
  assert.equal(direct.fingerprint, granular.fingerprint);
  const expiration = direct.events.find(({ type }) => type === "evidence-expired");
  assert.equal(expiration.atTick, 10);
});

test("AI selection uses public observer pose, FOV, confidence and geometry only", () => {
  let state = createStealthEvidenceState();
  state = recordOne(state, footprint({
    position: { x: 4, y: 0 },
    source: publicSource("surface", "east-floor"),
  }), 0).state;
  state = recordOne(state, doorState({
    position: { x: 7, y: 0 },
    source: publicSource("door", "east-door"),
  }), 0).state;
  state = recordOne(state, movedObject({
    position: { x: 0, y: 4 },
    source: publicSource("object", "north-cart"),
  }), 0).state;

  const callbackEvidence = [];
  const candidates = queryStealthEvidenceForAi(
    state,
    broadQuery({
      fieldOfViewDegrees: 90,
      maximumDistance: 10,
      limit: 4,
    }),
    {
      isVisible(from, to, evidence) {
        assert.deepEqual(from, { x: 0, y: 0 });
        assert.ok(Object.isFrozen(from));
        assert.ok(Object.isFrozen(to));
        assert.ok(Object.isFrozen(evidence));
        callbackEvidence.push(evidence);
        return evidence.source.publicId !== "east-door";
      },
      isReachable(_from, _to, evidence) {
        return evidence.source.publicId !== "north-cart";
      },
    },
  );

  assert.deepEqual(
    callbackEvidence.map(({ source }) => source.publicId).sort(),
    ["east-door", "east-floor"],
    "the north clue should have failed the public FOV before callbacks",
  );
  assert.deepEqual(candidates.map(({ evidence }) => evidence.source.publicId), [
    "east-floor",
  ]);
  assert.equal(candidates[0].distance, 4);
  assert.equal(candidates[0].headingAlignment, 1);
  assert.ok(candidates[0].investigationScore > 0);

  const selected = selectStealthEvidenceForAi(
    state,
    broadQuery({ fieldOfViewDegrees: 90, maximumDistance: 10 }),
  );
  assert.equal(
    selected.evidence.source.publicId,
    "east-door",
    "the higher-priority public door change should win without geometry filtering",
  );
});

test("360-degree observation clamps adversarial floating alignment", () => {
  const state = recordOne(
    createStealthEvidenceState(),
    footprint({ position: { x: -1, y: -6 } }),
    0,
  ).state;
  const candidates = queryStealthEvidenceForAi(state, broadQuery({
    observer: {
      position: { x: 0, y: 0 },
      heading: { x: 1, y: 6 },
    },
    fieldOfViewDegrees: 360,
  }));

  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].headingAlignment >= -1);
  assert.ok(candidates[0].headingAlignment <= 1);
  assert.equal(candidates[0].headingAlignment, -1);
});

test("the AI projection is occupancy-blind and strips countermeasure origin", () => {
  let state = createStealthEvidenceState();
  state = recordOne(state, footprint(), 0).state;
  const forged = stepStealthEvidence(state, command(
    footprint({
      position: { x: 3, y: 0 },
      source: publicSource("surface", "library-floor-west"),
    }),
    0,
    "forge",
  ));
  assert.equal(forged.accepted, true);
  assert.equal(forged.state.records.at(-1).origin, "fabricated");

  const candidates = queryStealthEvidenceForAi(forged.state, broadQuery());
  assert.equal(candidates.length, 2);
  const forbiddenKey = /origin|fabricat|occup|hidden|player|actor|countermeasure/iu;
  const inspectKeys = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, forbiddenKey);
      inspectKeys(child);
    }
  };
  inspectKeys(candidates);
  for (const { evidence } of candidates) {
    assert.deepEqual(Object.keys(evidence), [
      "id",
      "kind",
      "position",
      "source",
      "detail",
      "createdAtTick",
      "ageTicks",
      "expiresAtTick",
      "confidence",
    ]);
    assert.deepEqual(Object.keys(evidence.source), [
      "publicId",
      "kind",
      "publicity",
    ]);
  }

  assert.throws(
    () => queryStealthEvidenceForAi(forged.state, {
      ...broadQuery(),
      playerPosition: { x: 99, y: 99 },
    }),
    /invalid or private fields/,
  );
  assert.throws(
    () => queryStealthEvidenceForAi(forged.state, {
      ...broadQuery(),
      observer: {
        ...broadQuery().observer,
        occupiedHideSpotId: "secret-locker",
      },
    }),
    /finite public position and heading/,
  );
});

test("occupancy metamorphic: hidden locker changes cannot alter AI candidates or replay fingerprint", () => {
  const definition = testDefinition();
  const commands = [
    command(footprint({
      position: { x: 3, y: 0 },
      source: publicSource("surface", "metamorphic-east-floor"),
    }), 0),
    command(doorState({
      position: { x: 5, y: 0 },
      source: publicSource("door", "metamorphic-east-door"),
    }), 0),
    command(movedObject({
      position: { x: 7, y: 0 },
      source: publicSource("object", "metamorphic-east-cart"),
    }), 0),
    { type: "advance", tick: 24 },
  ];
  const publicLevelGeometry = Object.freeze({
    maximumX: 9,
    blockedSightKeys: Object.freeze(["6:1"]),
  });
  const occupancyVariants = [
    Object.freeze({
      hideSpotRuntimeStates: Object.freeze([
        Object.freeze({ id: "east-locker", occupiedByPlayer: true }),
        Object.freeze({ id: "west-locker", occupiedByPlayer: false }),
      ]),
      hiddenPlayerPosition: Object.freeze({ x: 8, y: 8 }),
    }),
    Object.freeze({
      hideSpotRuntimeStates: Object.freeze([
        Object.freeze({ id: "east-locker", occupiedByPlayer: false }),
        Object.freeze({ id: "west-locker", occupiedByPlayer: true }),
      ]),
      hiddenPlayerPosition: Object.freeze({ x: -8, y: -8 }),
    }),
  ];
  assert.notDeepEqual(occupancyVariants[0], occupancyVariants[1]);

  const runVariant = (runtimeOnlyState) => {
    assert.ok(
      runtimeOnlyState.hideSpotRuntimeStates.some(
        ({ occupiedByPlayer }) => occupiedByPlayer,
      ),
    );
    const replay = replayStealthEvidence(definition, commands);
    const candidates = queryStealthEvidenceForAi(
      replay.state,
      broadQuery({
        atTick: replay.state.tick,
        fieldOfViewDegrees: 120,
        maximumDistance: publicLevelGeometry.maximumX,
      }),
      {
        isVisible(_from, to) {
          const publicKey = `${Math.round(to.x)}:${Math.round(to.y)}`;
          return !publicLevelGeometry.blockedSightKeys.includes(publicKey);
        },
        isReachable(_from, to) {
          return to.x >= 0 && to.x <= publicLevelGeometry.maximumX;
        },
      },
    );
    return {
      candidateSequence: candidates.map((candidate) => ({
        id: candidate.evidence.id,
        kind: candidate.evidence.kind,
        publicSourceId: candidate.evidence.source.publicId,
        confidence: candidate.evidence.confidence,
        distance: candidate.distance,
        headingAlignment: candidate.headingAlignment,
        investigationScore: candidate.investigationScore,
      })),
      replayFingerprint: replay.fingerprint,
    };
  };

  const occupiedEast = runVariant(occupancyVariants[0]);
  const occupiedWest = runVariant(occupancyVariants[1]);
  assert.deepEqual(occupiedWest, occupiedEast);
  assert.ok(occupiedEast.candidateSequence.length >= 3);
  assert.match(occupiedEast.replayFingerprint, /^[a-f0-9]{8}$/u);
  assert.doesNotMatch(
    JSON.stringify(occupiedEast),
    /occupied|hiddenPlayer|east-locker|west-locker/iu,
  );
});

test("query snapshots prevent callbacks from mutating tick, limit or callback policy", () => {
  let state = recordOne(
    createStealthEvidenceState(),
    footprint({ source: publicSource("surface", "mutable-query-floor-a") }),
    0,
  ).state;
  state = recordOne(state, footprint({
    position: { x: 3, y: 0 },
    source: publicSource("surface", "mutable-query-floor-b"),
  }), 0).state;
  const query = broadQuery();
  const geometry = {
    isVisible() {
      query.atTick = -1;
      query.limit = 0;
      geometry.isReachable = () => false;
      return true;
    },
    isReachable: () => true,
  };

  const candidates = queryStealthEvidenceForAi(state, query, geometry);
  assert.equal(candidates.length, 2);
});

test("erase pays explicit budget, commitment and public-disturbance costs", () => {
  let state = recordOne(createStealthEvidenceState(), footprint(), 0).state;
  const evidenceId = state.records[0].id;
  let step = stepStealthEvidence(state, {
    type: "erase",
    tick: 0,
    evidenceId,
  });

  assert.equal(step.accepted, true);
  assert.equal(step.state.records.length, 0);
  assert.equal(step.state.countermeasureBudgetRemaining, 9);
  assert.equal(step.state.countermeasureBudgetSpent, 1);
  assert.equal(step.state.countermeasureBusyUntilTick, 24);
  assert.equal(step.state.erasedEvidenceCount, 1);
  assert.deepEqual(step.events.map(({ type }) => type), [
    "countermeasure-cost-paid",
    "evidence-erased",
  ]);
  assert.deepEqual(step.events[0], {
    type: "countermeasure-cost-paid",
    action: "erase",
    budgetSpent: 1,
    budgetRemaining: 9,
    commitmentEndsAtTick: 24,
    publicNoiseStrength: 0.08,
    atTick: 0,
  });

  state = recordOne(step.state, footprint({
    source: publicSource("surface", "other-floor"),
  }), 0).state;
  const secondId = state.records[0].id;
  step = stepStealthEvidence(state, {
    type: "erase",
    tick: 23,
    evidenceId: secondId,
  });
  assert.equal(step.accepted, false);
  assert.equal(step.rejection, "countermeasure-busy");
  assert.equal(step.state.countermeasureBudgetRemaining, 9);
  assert.equal(step.state.records.length, 1);

  step = stepStealthEvidence(step.state, {
    type: "erase",
    tick: 24,
    evidenceId: secondId,
  });
  assert.equal(step.accepted, true);
  assert.equal(step.state.countermeasureBudgetRemaining, 8);
});

test("forgery is bounded, costs time/noise and is not labelled fake to AI", () => {
  let state = createStealthEvidenceState();
  let step = stepStealthEvidence(state, command(doorState(), 0, "forge"));
  assert.equal(step.accepted, true);
  assert.equal(step.state.countermeasureBudgetRemaining, 7);
  assert.equal(step.state.countermeasureBusyUntilTick, 72);
  assert.equal(step.state.forgedEvidenceCount, 1);
  assert.equal(step.state.records[0].origin, "fabricated");
  assert.ok(
    Math.abs(step.state.records[0].initialConfidence - 0.94 * 0.76) < 1e-12,
  );
  assert.deepEqual(step.events.map(({ type }) => type), [
    "countermeasure-cost-paid",
    "evidence-forged",
  ]);
  assert.equal(step.events[0].publicNoiseStrength, 0.38);

  const projected = queryStealthEvidenceForAi(step.state, broadQuery());
  assert.equal(projected.length, 1);
  assert.equal("origin" in projected[0].evidence, false);
  assert.equal(projected[0].evidence.source.publicity, "world-observable");

  state = step.state;
  step = stepStealthEvidence(state, command(powerChange({
    source: publicSource(
      "power-grid",
      "public-power-alarm",
      "publicly-announced",
    ),
  }), 72, "forge"));
  assert.equal(step.accepted, false);
  assert.equal(step.rejection, "public-announcement-not-forgeable");
  assert.equal(step.state.countermeasureBudgetRemaining, 7);
  assert.equal(step.state.forgedEvidenceCount, 1);
});

test("publicly announced evidence is immutable to physical cleanup", () => {
  const recorded = recordOne(
    createStealthEvidenceState(),
    powerChange({
      source: publicSource(
        "power-grid",
        "public-breaker-alarm",
        "publicly-announced",
      ),
    }),
    0,
  ).state;
  const step = stepStealthEvidence(recorded, {
    type: "erase",
    tick: 0,
    evidenceId: recorded.records[0].id,
  });
  assert.equal(step.accepted, false);
  assert.equal(step.rejection, "evidence-not-erasable");
  assert.equal(step.state.records.length, 1);
  assert.equal(step.state.countermeasureBudgetRemaining, 10);
});

test("disabled countermeasures and insufficient budgets reject atomically", () => {
  const definition = testDefinition({
    countermeasureBudget: 1,
    rules: {
      footprint: {
        erase: null,
        forge: null,
      },
      "door-state": {
        erase: {
          budgetUnits: 2,
          commitmentTicks: 1,
          publicNoiseStrength: 0,
        },
      },
    },
  });
  let state = recordOne(
    createStealthEvidenceState(definition),
    footprint(),
    0,
  ).state;
  let step = stepStealthEvidence(state, {
    type: "erase",
    tick: 0,
    evidenceId: state.records[0].id,
  });
  assert.equal(step.rejection, "evidence-not-erasable");

  step = stepStealthEvidence(step.state, command(footprint({
    source: publicSource("surface", "forgery-surface"),
  }), 0, "forge"));
  assert.equal(step.rejection, "evidence-not-forgeable");

  state = recordOne(step.state, doorState(), 0).state;
  step = stepStealthEvidence(state, {
    type: "erase",
    tick: 0,
    evidenceId: state.records.find(({ kind }) => kind === "door-state").id,
  });
  assert.equal(step.rejection, "insufficient-countermeasure-budget");
  assert.equal(step.state.countermeasureBudgetRemaining, 1);
  assert.equal(step.state.records.length, 2);
});

test("the bounded ledger evicts the weakest clue with stable tie-breaking", () => {
  const definition = testDefinition({ maximumRecords: 2 });
  let state = createStealthEvidenceState(definition);
  state = recordOne(state, doorState(), 0).state;
  state = recordOne(state, footprint({
    source: publicSource("surface", "weak-floor"),
    confidenceScale: 0.2,
  }), 0).state;
  const weakId = state.records.find(({ kind }) => kind === "footprint").id;
  const step = recordOne(state, movedObject(), 1);

  assert.equal(step.state.records.length, 2);
  assert.equal(step.state.records.some(({ id }) => id === weakId), false);
  assert.deepEqual(step.events.map(({ type }) => type), [
    "evidence-recorded",
    "evidence-evicted",
  ]);
  assert.equal(step.events[1].evidenceId, weakId);
});

test("low-value footprint spam cannot evict stronger retained evidence", () => {
  const definition = testDefinition({ maximumRecords: 2 });
  let state = createStealthEvidenceState(definition);
  state = recordOne(state, powerChange(), 0).state;
  state = recordOne(state, doorState(), 0).state;
  const retainedIds = state.records.map(({ id }) => id);
  const weak = recordOne(state, footprint({
    source: publicSource("surface", "spam-floor"),
    confidenceScale: 0.03,
  }), 1);

  assert.deepEqual(weak.state.records.map(({ id }) => id), retainedIds);
  assert.equal(weak.state.nextEvidenceSerial, 4);
  assert.deepEqual(weak.events.map(({ type }) => type), [
    "evidence-recorded",
    "evidence-discarded",
  ]);
  assert.equal(
    weak.events[1].reason,
    "lower-ranked-than-retained-evidence",
  );
  assert.equal(
    weak.events[1].evidence.source.publicId,
    "spam-floor",
  );
});

test("same definition and command stream replay to the same private state and fingerprint", () => {
  const definition = testDefinition();
  const commands = [
    command(footprint(), 0),
    command(doorState(), 5),
    { type: "advance", tick: 20 },
    command(decoyResidue(), 20, "forge"),
    { type: "advance", tick: 68 },
    command(movedObject(), 68),
    {
      type: "erase",
      tick: 68,
      evidenceId: "stealth-evidence-test:evidence:1",
    },
    { type: "advance", tick: 120 },
  ];

  const first = replayStealthEvidence(definition, commands);
  const second = replayStealthEvidence(definition, structuredClone(commands));
  assert.deepEqual(first, second);
  assert.match(first.fingerprint, /^[a-f0-9]{8}$/u);
  assert.equal(first.state.tick, 120);
  assert.equal(first.state.nextEvidenceSerial, 5);
  assert.equal(first.state.forgedEvidenceCount, 1);
  assert.ok(first.events.some(({ type }) => type === "evidence-forged"));
  assert.ok(first.events.some(({ type }) => type === "evidence-erased"));

  const altered = replayStealthEvidence(definition, [
    ...commands.slice(0, -1),
    { type: "advance", tick: 121 },
  ]);
  assert.notEqual(first.fingerprint, altered.fingerprint);
});

test("semantic rejections preserve resources while valid future attempts advance time", () => {
  let state = createStealthEvidenceState();
  state = stepStealthEvidence(state, { type: "advance", tick: 10 }).state;
  const regressed = stepStealthEvidence(state, command(footprint(), 9));
  assert.equal(regressed.rejection, "time-regression");
  assert.equal(regressed.state, state);

  const missing = stepStealthEvidence(state, {
    type: "erase",
    tick: 20,
    evidenceId: "campaign-stealth-evidence-v1:evidence:404",
  });
  assert.equal(missing.rejection, "evidence-not-found");
  assert.equal(missing.state.tick, 20);
  assert.equal(missing.state.countermeasureBudgetRemaining, 10);
  assert.equal(missing.events.at(-1).type, "command-rejected");
  assert.equal(missing.events.at(-1).atTick, 20);
});

test("near-zero clues and tick overflow reject before creating inert state", () => {
  let state = createStealthEvidenceState();
  let step = stepStealthEvidence(state, command(footprint({
    confidenceScale: 0.001,
  }), 0));
  assert.equal(step.rejection, "confidence-below-retention");
  assert.equal(step.state.records.length, 0);
  assert.equal(step.state.nextEvidenceSerial, 1);

  state = createStealthEvidenceState(
    DEFAULT_STEALTH_EVIDENCE_DEFINITION,
    STEALTH_EVIDENCE_MAX_TICK,
  );
  step = stepStealthEvidence(state, command(
    footprint(),
    STEALTH_EVIDENCE_MAX_TICK,
  ));
  assert.equal(step.rejection, "tick-overflow");
  assert.equal(step.state.records.length, 0);
  assert.equal(step.state.nextEvidenceSerial, 1);
  assert.equal(step.state.countermeasureBudgetRemaining, 10);
});

test("the final serial is unique and further evidence rejects before mutation", () => {
  const initial = createStealthEvidenceState();
  const nearCapacity = {
    ...initial,
    nextEvidenceSerial: STEALTH_EVIDENCE_MAX_SERIAL,
  };
  const last = recordOne(nearCapacity, footprint(), 0);
  assert.equal(
    last.state.records[0].id.endsWith(`:${STEALTH_EVIDENCE_MAX_SERIAL}`),
    true,
  );
  assert.equal(last.state.nextEvidenceSerial, STEALTH_EVIDENCE_MAX_SERIAL + 1);

  const exhausted = stepStealthEvidence(last.state, command(footprint({
    position: { x: 3, y: 0 },
  }), 0));
  assert.equal(exhausted.rejection, "evidence-capacity-exhausted");
  assert.equal(exhausted.state, last.state);
  assert.equal(exhausted.state.records.length, 1);
});

test("maximum valid definition ids still generate erasable bounded record ids", () => {
  const definition = testDefinition({ id: "e".repeat(80) });
  const recorded = recordOne(
    createStealthEvidenceState(definition),
    footprint(),
    0,
  ).state;
  assert.ok(recorded.records[0].id.length <= 180);
  const erased = stepStealthEvidence(recorded, {
    type: "erase",
    tick: 0,
    evidenceId: recorded.records[0].id,
  });
  assert.equal(erased.accepted, true);
});

test("untrusted command validation rejects malformed and privacy-expanding input", () => {
  const state = createStealthEvidenceState();
  const invalidCases = [
    [null, "invalid-command"],
    [{}, "invalid-command"],
    [{ type: "teleport", tick: 0 }, "unknown-command"],
    [{ type: "advance", tick: 0, deltaSeconds: 1 / 60 }, "invalid-command"],
    [{ type: "advance", tick: -1 }, "invalid-tick"],
    [{ type: "advance", tick: 0.5 }, "invalid-tick"],
    [{ type: "advance", tick: STEALTH_EVIDENCE_MAX_TICK + 1 }, "invalid-tick"],
    [command(footprint({ position: { x: Number.NaN, y: 0 } })), "invalid-position"],
    [command(footprint({ position: { x: 1_000_001, y: 0 } })), "invalid-position"],
    [command(footprint({
      source: publicSource("door", "wrong-source-kind"),
    })), "source-kind-mismatch"],
    [command(footprint({
      source: { ...publicSource("surface", "x"), actorId: "private-player" },
    })), "invalid-source"],
    [command(footprint({
      source: {
        ...publicSource("surface", "x"),
        publicity: {
          occupiedHideSpotId: "secret",
          toString: () => "world-observable",
        },
      },
    })), "invalid-source"],
    [command(footprint({
      source: publicSource("surface", " bad-id "),
    })), "invalid-source"],
    [command(footprint({ detail: { direction: { x: 0, y: 0 } } })), "invalid-detail"],
    [command(doorState({ detail: { state: "ajar" } })), "invalid-detail"],
    [command(doorState({
      detail: {
        state: {
          privatePlayerPosition: { x: 10, y: 10 },
          toString: () => "open",
        },
      },
    })), "invalid-detail"],
    [command(footprint({ confidenceScale: 0 })), "invalid-confidence-scale"],
    [command(footprint({ confidenceScale: Number.NaN })), "invalid-confidence-scale"],
    [{ type: "erase", tick: 0, evidenceId: "" }, "invalid-evidence-id"],
    [{
      type: "record",
      tick: 0,
      observation: {
        ...footprint(),
        privatePlayerPosition: { x: 100, y: 100 },
      },
    }, "invalid-command"],
  ];

  for (const [invalid, expected] of invalidCases) {
    const step = stepStealthEvidence(state, invalid);
    assert.equal(step.accepted, false, JSON.stringify(invalid));
    assert.equal(step.rejection, expected, JSON.stringify(invalid));
    assert.equal(step.state, state);
    assert.equal(step.events.length, 1);
    assert.equal(step.events[0].type, "command-rejected");
  }

  let accessorReads = 0;
  const accessorCommand = {};
  Object.defineProperties(accessorCommand, {
    type: {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error("command accessor executed");
      },
    },
    tick: { enumerable: true, value: 0 },
  });
  const accessorStep = stepStealthEvidence(state, accessorCommand);
  assert.equal(accessorStep.rejection, "invalid-command");
  assert.equal(accessorStep.state, state);
  assert.equal(accessorReads, 0);

  let proxyReads = 0;
  const dynamicTick = new Proxy({ type: "advance", tick: 0 }, {
    get(target, key, receiver) {
      proxyReads += 1;
      if (key === "tick") return STEALTH_EVIDENCE_MAX_TICK + 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const proxyStep = stepStealthEvidence(state, dynamicTick);
  assert.equal(proxyStep.accepted, true);
  assert.equal(proxyStep.state.tick, 0);
  assert.equal(proxyReads, 0, "execution read a Proxy property instead of its data descriptor");
});

test("AI query validation rejects private, ambiguous and non-deterministic shapes", () => {
  const state = recordOne(createStealthEvidenceState(), footprint(), 0).state;
  const invalidQueries = [
    null,
    { ...broadQuery(), deltaSeconds: 0.016 },
    { ...broadQuery(), atTick: -1 },
    { ...broadQuery(), atTick: STEALTH_EVIDENCE_MAX_TICK + 1 },
    { ...broadQuery(), observer: { position: { x: 0, y: 0 }, heading: { x: 0, y: 0 } } },
    { ...broadQuery(), maximumDistance: 0 },
    { ...broadQuery(), fieldOfViewDegrees: 0 },
    { ...broadQuery(), fieldOfViewDegrees: 361 },
    { ...broadQuery(), minimumConfidence: 2 },
    { ...broadQuery(), kinds: [] },
    { ...broadQuery(), kinds: ["footprint", "footprint"] },
    { ...broadQuery(), kinds: ["psychic-player-location"] },
    { ...broadQuery(), limit: 0 },
    { ...broadQuery(), limit: 513 },
  ];
  for (const invalid of invalidQueries) {
    assert.throws(() => queryStealthEvidenceForAi(state, invalid));
  }

  const advanced = stepStealthEvidence(state, { type: "advance", tick: 5 }).state;
  assert.throws(
    () => queryStealthEvidenceForAi(advanced, broadQuery({ atTick: 4 })),
    /past ledger tick/,
  );
  assert.throws(
    () => queryStealthEvidenceForAi(state, broadQuery(), {
      isVisible: () => "yes",
    }),
    /must return a boolean/,
  );
  assert.throws(
    () => queryStealthEvidenceForAi(state, broadQuery(), {
      isReachable: () => 1,
    }),
    /must return a boolean/,
  );
  assert.throws(
    () => queryStealthEvidenceForAi(state, broadQuery(), {
      isVisible: () => undefined,
    }),
    /must return a boolean/,
  );
  assert.throws(
    () => queryStealthEvidenceForAi(state, broadQuery(), {
      isVisible: () => true,
      readsOccupancy: true,
    }),
    /visibility\/reachability callbacks/,
  );
  assert.throws(
    () => selectStealthEvidenceForAi(state, broadQuery({ limit: 0 })),
    /limit/,
  );
  assert.throws(
    () => selectStealthEvidenceForAi(state, broadQuery({ limit: 513 })),
    /limit/,
  );

  class CommandList extends Array {
    *[Symbol.iterator]() {
      while (true) yield { type: "advance", tick: 0 };
    }
  }
  assert.throws(
    () => replayStealthEvidence(
      DEFAULT_STEALTH_EVIDENCE_DEFINITION,
      new CommandList({ type: "advance", tick: 0 }),
    ),
    /commands must be an array/,
  );
});

test("definition validation covers duration, confidence, capacity and costs", () => {
  assert.doesNotThrow(() => validateStealthEvidenceDefinition(
    DEFAULT_STEALTH_EVIDENCE_DEFINITION,
  ));

  const base = DEFAULT_STEALTH_EVIDENCE_DEFINITION;
  const cases = [
    [{ ...base, version: 2 }, /version/],
    [{ ...base, id: "" }, /definition id/],
    [{ ...base, id: "e".repeat(81) }, /definition id/],
    [{ ...base, fixedStepSeconds: 0 }, /fixedStepSeconds/],
    [{ ...base, maximumRecords: 0 }, /maximumRecords/],
    [{ ...base, maximumRecords: 513 }, /maximumRecords/],
    [{ ...base, countermeasureBudget: -1 }, /countermeasureBudget/],
    [{ ...base, privateOccupancyPolicy: "peek" }, /must be an object/],
    [{ ...base, minimumRetainedConfidence: 1 }, /minimumRetainedConfidence/],
    [{ ...base, minimumAiConfidence: 0.01 }, /minimumAiConfidence/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: { ...base.rules.footprint, initialConfidence: 0 },
      },
    }, /initialConfidence/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: { ...base.rules.footprint, decayPerTick: -0.1 },
      },
    }, /decayPerTick/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: { ...base.rules.footprint, lifetimeTicks: 0 },
      },
    }, /lifetimeTicks/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: {
          ...base.rules.footprint,
          readsPlayerOccupancy: true,
        },
      },
    }, /Missing stealth evidence rule/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: { ...base.rules.footprint, erase: false },
      },
    }, /erase cost/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: { ...base.rules.footprint, forge: 0 },
      },
    }, /forge cost/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: {
          ...base.rules.footprint,
          erase: { ...base.rules.footprint.erase, budgetUnits: 0.5 },
        },
      },
    }, /budgetUnits/],
    [{
      ...base,
      rules: {
        ...base.rules,
        footprint: {
          ...base.rules.footprint,
          forge: {
            ...base.rules.footprint.forge,
            confidenceMultiplier: 0,
          },
        },
      },
    }, /confidenceMultiplier/],
  ];

  for (const [invalid, expected] of cases) {
    assert.throws(() => validateStealthEvidenceDefinition(invalid), expected);
  }
  assert.throws(
    () => createStealthEvidenceState(base, -1),
    /initial tick/,
  );
});

test("states, events and AI projections are deeply immutable", () => {
  const recorded = recordOne(createStealthEvidenceState(), footprint({
    detail: { direction: { x: 3, y: 4 } },
  }), 0);
  const state = recorded.state;
  const candidate = queryStealthEvidenceForAi(state, broadQuery())[0];

  for (const value of [
    state,
    state.definition,
    state.definition.rules,
    state.definition.rules.footprint,
    state.records,
    state.records[0],
    state.records[0].position,
    state.records[0].source,
    state.records[0].detail,
    state.records[0].detail.direction,
    recorded.events,
    recorded.events[0],
    candidate,
    candidate.evidence,
    candidate.evidence.position,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.deepEqual(state.records[0].detail.direction, { x: 0.6, y: 0.8 });
  assert.throws(() => {
    state.records[0].position.x = 99;
  }, TypeError);
});
