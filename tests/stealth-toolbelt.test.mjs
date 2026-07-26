import assert from "node:assert/strict";
import test from "node:test";

import { createLevel } from "../app/game/level.ts";
import {
  advanceStealthToolbelt,
  auditStealthToolbeltDefinition,
  beginStealthToolUse,
  createStealthToolbeltState,
  GOLD_STEALTH_TOOLBELT_DEFINITION,
  sampleStealthToolbelt,
  stealthToolTicksToSeconds,
} from "../app/game/stealth-toolbelt.ts";

function levelFromRows(rows) {
  return createLevel({
    id: "stealth-toolbelt-test",
    width: rows[0].length,
    height: rows.length,
    walkable: rows.map((row) => [...row].map((cell) => cell !== "#")),
    playerStart: { x: 1, y: 1 },
    exit: { x: rows[0].length - 2, y: 1 },
    chaserStart: { x: 1, y: rows.length - 2 },
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [{ x: 1, y: rows.length - 2 }],
    hideSpots: [],
  });
}

const openRoom = levelFromRows([
  "#########",
  "#.......#",
  "#.......#",
  "#.......#",
  "#########",
]);

const dividedRoom = levelFromRows([
  "#########",
  "#...#...#",
  "#...#...#",
  "#...#...#",
  "#########",
]);

const doorTarget = (overrides = {}) => ({
  kind: "door",
  id: "library-east-door",
  interactionPoint: { x: 2, y: 1 },
  routeSafetyAuditId: "library-east-door:v3",
  traversalAxis: "horizontal",
  playerPassageRemainsAvailable: true,
  autoReleaseTicks: 240,
  ...overrides,
});

const mirrorTarget = (overrides = {}) => ({
  kind: "corner",
  id: "library-stacks-corner",
  interactionPoint: { x: 2, y: 1 },
  hasOpaqueCorner: true,
  outwardHeading: { x: 3, y: 0 },
  ...overrides,
});

const blackoutTarget = (overrides = {}) => ({
  kind: "power-circuit",
  id: "library-lighting-circuit",
  interactionPoint: { x: 2, y: 2 },
  autoRestoreTicks: 360,
  emergencyVisibilityFloor: 0.35,
  ...overrides,
});

function begin(state, tool, target, actorPosition = { x: 1, y: 1 }) {
  return beginStealthToolUse(state, openRoom, {
    tick: state.tick,
    tool,
    actorPosition,
    target,
  });
}

test("gold toolbelt definition passes bounded-effect safety validation", () => {
  const audit = auditStealthToolbeltDefinition(GOLD_STEALTH_TOOLBELT_DEFINITION);
  assert.deepEqual(audit, { passed: true, failures: [] });
  assert.equal(stealthToolTicksToSeconds(GOLD_STEALTH_TOOLBELT_DEFINITION, 90), 1.5);
  assert.equal(Object.isFrozen(GOLD_STEALTH_TOOLBELT_DEFINITION.tools), true);

  const unsafe = {
    ...GOLD_STEALTH_TOOLBELT_DEFINITION,
    tools: {
      ...GOLD_STEALTH_TOOLBELT_DEFINITION.tools,
      "temporary-blackout": {
        ...GOLD_STEALTH_TOOLBELT_DEFINITION.tools["temporary-blackout"],
        effectTicks: Number.POSITIVE_INFINITY,
        visionRangeMultiplier: 0,
      },
    },
  };
  const unsafeAudit = auditStealthToolbeltDefinition(unsafe);
  assert.equal(unsafeAudit.passed, false);
  assert.match(unsafeAudit.failures.join("\n"), /failsafe ceiling|must be positive/);
  assert.match(unsafeAudit.failures.join("\n"), /vision multiplier/);
  assert.throws(() => createStealthToolbeltState(unsafe), /Invalid stealth toolbelt/);
});

test("door wedge produces a temporary chaser-only delay with exact commitment and failsafe edges", () => {
  const initial = createStealthToolbeltState();
  const started = begin(initial, "door-wedge", doorTarget());
  assert.equal(started.accepted, true);
  assert.equal(started.state.tools["door-wedge"].inventoryRemaining, 1);
  assert.deepEqual(started.events.map((event) => event.type), ["tool-use-started"]);
  assert.equal(started.events[0].completesAtTick, 24);
  assert.equal(sampleStealthToolbelt(started.state).tools["door-wedge"].phase, "commitment");

  const before = advanceStealthToolbelt(started.state, 23);
  assert.deepEqual(before.events, []);
  assert.deepEqual(before.receipts, []);

  const completed = advanceStealthToolbelt(before.state, 24);
  assert.deepEqual(completed.events.map((event) => event.type), [
    "tool-commitment-completed",
    "tool-risk-emitted",
  ]);
  assert.equal(completed.receipts.length, 1);
  const receipt = completed.receipts[0];
  assert.equal(receipt.tool, "door-wedge");
  assert.deepEqual(receipt.effect, {
    kind: "chaser-door-delay",
    doorId: "library-east-door",
    traversalAxis: "horizontal",
    delayTicksPerAttempt: 72,
    appliesTo: "chaser-traversal",
    playerPassagePolicy: "always-passable",
    autoReleaseAtTick: 264,
  });
  assert.equal(receipt.expiresAtTick, 264, "target failsafe did not cap the authored effect");
  assert.equal(receipt.riskEvidence.channel, "sound");
  assert.equal(Object.isFrozen(receipt.effect), true);

  const cooldown = advanceStealthToolbelt(completed.state, 180);
  assert.deepEqual(cooldown.events.map((event) => event.type), ["tool-cooldown-ended"]);
  assert.equal(sampleStealthToolbelt(cooldown.state).tools["door-wedge"].phase, "active");

  const released = advanceStealthToolbelt(cooldown.state, 264);
  assert.deepEqual(released.events.map((event) => event.type), ["tool-effect-ended"]);
  assert.equal(released.events[0].reason, "failsafe");
  assert.equal(released.state.activeEffects["door-wedge"], undefined);
  assert.equal(sampleStealthToolbelt(released.state).tools["door-wedge"].canUse, true);
});

test("corner mirror grants only an authored public view aperture and never an actor snapshot", () => {
  const started = begin(createStealthToolbeltState(), "corner-mirror", mirrorTarget());
  const completed = advanceStealthToolbelt(started.state, 9);
  const receipt = completed.receipts[0];
  assert.equal(receipt.tool, "corner-mirror");
  assert.deepEqual(receipt.effect, {
    kind: "public-corner-observation",
    cornerId: "library-stacks-corner",
    origin: { x: 2, y: 1 },
    heading: { x: 1, y: 0 },
    rangeCells: 8,
    coneDegrees: 58,
    observationEndsAtTick: 99,
  });
  assert.equal(receipt.riskEvidence.channel, "visual");

  const serialized = JSON.stringify(receipt);
  for (const forbidden of [
    "playerPosition",
    "chaserPosition",
    "hiddenPlayer",
    "occupiedByPlayer",
    "witnessedHideSpotId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `receipt leaked ${forbidden}`);
  }
  assert.equal(
    "actors" in receipt.effect,
    false,
    "mirror receipt should authorize a render/perception query, not reveal actors",
  );
});

test("blackout retains emergency visibility and restores itself at the stricter target failsafe", () => {
  const started = begin(
    createStealthToolbeltState(),
    "temporary-blackout",
    blackoutTarget({ autoRestoreTicks: 120, emergencyVisibilityFloor: 0.6 }),
    { x: 1, y: 2 },
  );
  assert.equal(started.accepted, true);
  const completed = advanceStealthToolbelt(started.state, 36);
  const receipt = completed.receipts[0];
  assert.equal(receipt.tool, "temporary-blackout");
  assert.deepEqual(receipt.effect, {
    kind: "temporary-visibility-modifier",
    circuitId: "library-lighting-circuit",
    visionRangeMultiplier: 0.6,
    emergencyVisibilityFloor: 0.6,
    ambientSoundMasking: 0.3,
    autoRestoreAtTick: 156,
  });
  assert.equal(receipt.expiresAtTick, 156);
  assert.ok(receipt.effect.visionRangeMultiplier >= receipt.effect.emergencyVisibilityFloor);
  assert.ok(receipt.effect.visionRangeMultiplier >= 0.25);

  const restored = advanceStealthToolbelt(completed.state, 156);
  assert.deepEqual(restored.events.map((event) => event.type), ["tool-effect-ended"]);
  assert.equal(restored.state.activeEffects["temporary-blackout"], undefined);
});

test("all illegal interactions reject atomically without inventory, cooldown, event, or sequence consumption", () => {
  const initial = createStealthToolbeltState();
  const attempts = [
    beginStealthToolUse(initial, openRoom, {
      tick: -1,
      tool: "door-wedge",
      actorPosition: { x: 1, y: 1 },
      target: doorTarget(),
    }),
    beginStealthToolUse(initial, openRoom, {
      tick: 1,
      tool: "door-wedge",
      actorPosition: { x: 1, y: 1 },
      target: doorTarget(),
    }),
    begin(initial, "door-wedge", mirrorTarget()),
    begin(initial, "door-wedge", doorTarget(), { x: Number.NaN, y: 1 }),
    begin(initial, "door-wedge", doorTarget(), { x: 0, y: 0 }),
    begin(initial, "door-wedge", doorTarget({ interactionPoint: { x: 0, y: 0 } })),
    begin(initial, "door-wedge", doorTarget({ interactionPoint: { x: 7, y: 3 } })),
    begin(
      initial,
      "door-wedge",
      doorTarget({ playerPassageRemainsAvailable: false }),
    ),
    begin(initial, "corner-mirror", mirrorTarget({ hasOpaqueCorner: false })),
    begin(
      initial,
      "temporary-blackout",
      blackoutTarget({ emergencyVisibilityFloor: 0 }),
      { x: 1, y: 2 },
    ),
    beginStealthToolUse(initial, dividedRoom, {
      tick: 0,
      tool: "door-wedge",
      actorPosition: { x: 3.4, y: 1 },
      target: doorTarget({ interactionPoint: { x: 4.6, y: 1 } }),
    }),
  ];
  assert.deepEqual(attempts.map((attempt) => attempt.rejection), [
    "invalid-tick",
    "tick-mismatch",
    "target-kind-mismatch",
    "invalid-actor-position",
    "actor-not-walkable",
    "target-not-walkable",
    "out-of-range",
    "unsafe-door-target",
    "unsafe-mirror-target",
    "unsafe-blackout-target",
    "interaction-blocked",
  ]);
  for (const attempt of attempts) {
    assert.equal(attempt.accepted, false);
    assert.equal(attempt.state, initial);
    assert.deepEqual(attempt.events, []);
    assert.deepEqual(attempt.receipts, []);
    assert.equal(attempt.state.useSequence, 0);
    for (const tool of Object.values(attempt.state.tools)) {
      assert.equal(tool.cooldownEventPending, false);
    }
  }
});

test("commitments, active effects, inventory, and cooldowns bound repeated use without deadlocking other tools", () => {
  let state = createStealthToolbeltState();
  let result = begin(state, "door-wedge", doorTarget());
  state = result.state;

  const overlappingCommitment = begin(state, "corner-mirror", mirrorTarget());
  assert.equal(overlappingCommitment.rejection, "commitment-active");
  state = advanceStealthToolbelt(state, 24).state;

  const sameToolWhileActive = begin(
    state,
    "door-wedge",
    doorTarget({ id: "second-door" }),
  );
  assert.equal(sameToolWhileActive.rejection, "cooldown-active");

  result = begin(state, "corner-mirror", mirrorTarget());
  assert.equal(result.accepted, true, "an active wedge incorrectly locked the whole toolbelt");
  state = advanceStealthToolbelt(result.state, 33).state;
  assert.equal(state.activeEffects["door-wedge"]?.tool, "door-wedge");
  assert.equal(state.activeEffects["corner-mirror"]?.tool, "corner-mirror");

  state = advanceStealthToolbelt(state, 264).state;
  result = begin(state, "door-wedge", doorTarget({ id: "second-door" }));
  assert.equal(result.accepted, true);
  assert.equal(result.state.tools["door-wedge"].inventoryRemaining, 0);
  state = advanceStealthToolbelt(result.state, 288).state;
  state = advanceStealthToolbelt(state, 528).state;

  const exhausted = begin(state, "door-wedge", doorTarget({ id: "third-door" }));
  assert.equal(exhausted.rejection, "inventory-empty");
  assert.equal(sampleStealthToolbelt(exhausted.state).tools["door-wedge"].phase, "depleted");
});

function runAtRenderRate(renderRate) {
  let state = createStealthToolbeltState();
  const events = [];
  const receipts = [];
  const commands = new Map([
    [0, ["door-wedge", doorTarget()]],
    [60, ["corner-mirror", mirrorTarget()]],
    [120, ["temporary-blackout", blackoutTarget()]],
  ]);
  const finalTick = 600;
  const renderFrames = renderRate * 10;

  const processFixedTick = () => {
    const command = commands.get(state.tick);
    if (command) {
      const started = begin(state, command[0], command[1], (
        command[0] === "temporary-blackout" ? { x: 1, y: 2 } : { x: 1, y: 1 }
      ));
      assert.equal(started.accepted, true);
      state = started.state;
      events.push(...started.events);
    }
    const advanced = advanceStealthToolbelt(state, state.tick + 1);
    state = advanced.state;
    events.push(...advanced.events);
    receipts.push(...advanced.receipts);
  };

  for (let frame = 1; frame <= renderFrames; frame += 1) {
    const renderTargetTick = Math.floor((frame * 60) / renderRate + 1e-9);
    while (state.tick < Math.min(renderTargetTick, finalTick)) processFixedTick();
  }
  while (state.tick < finalTick) processFixedTick();
  return {
    state,
    events,
    receipts,
    sample: sampleStealthToolbelt(state),
  };
}

test("fixed-tick outcomes and receipts are identical at 30, 60, 120, and 144 Hz", () => {
  const baseline = runAtRenderRate(60);
  for (const renderRate of [30, 120, 144]) {
    assert.deepEqual(runAtRenderRate(renderRate), baseline, `${renderRate} Hz diverged`);
  }
  assert.deepEqual(baseline.receipts.map((receipt) => [
    receipt.tool,
    receipt.issuedAtTick,
    receipt.expiresAtTick,
  ]), [
    ["door-wedge", 24, 264],
    ["corner-mirror", 69, 159],
    ["temporary-blackout", 156, 516],
  ]);
  assert.equal(baseline.state.tick, 600);
  assert.deepEqual(baseline.state.activeEffects, {});
});

test("large time partitions preserve every exact boundary and receipt", () => {
  const started = begin(createStealthToolbeltState(), "door-wedge", doorTarget());
  const single = advanceStealthToolbelt(started.state, 300);

  let state = started.state;
  const events = [];
  const receipts = [];
  for (const tick of [1, 23, 24, 179, 180, 263, 264, 300]) {
    const advanced = advanceStealthToolbelt(state, tick);
    state = advanced.state;
    events.push(...advanced.events);
    receipts.push(...advanced.receipts);
  }
  assert.deepEqual(state, single.state);
  assert.deepEqual(events, single.events);
  assert.deepEqual(receipts, single.receipts);
  assert.deepEqual(events.map((event) => [event.type, event.atTick]), [
    ["tool-commitment-completed", 24],
    ["tool-risk-emitted", 24],
    ["tool-cooldown-ended", 180],
    ["tool-effect-ended", 264],
  ]);
  assert.throws(() => advanceStealthToolbelt(state, 299), /must not move backwards/);
  assert.throws(() => advanceStealthToolbelt(state, 300.5), /non-negative integer/);
});

test("receipt ledger is bounded independently from active authoritative effects", () => {
  const definition = {
    ...GOLD_STEALTH_TOOLBELT_DEFINITION,
    id: "bounded-receipt-ledger",
    receiptLedgerCapacity: 2,
  };
  let state = createStealthToolbeltState(definition);

  let started = begin(state, "door-wedge", doorTarget());
  state = advanceStealthToolbelt(started.state, 24).state;
  started = begin(state, "corner-mirror", mirrorTarget());
  state = advanceStealthToolbelt(started.state, 33).state;
  started = begin(
    state,
    "temporary-blackout",
    blackoutTarget(),
    { x: 1, y: 2 },
  );
  state = advanceStealthToolbelt(started.state, 69).state;

  assert.equal(state.receiptLedger.length, 2);
  assert.deepEqual(state.receiptLedger.map((receipt) => receipt.tool), [
    "corner-mirror",
    "temporary-blackout",
  ]);
  assert.ok(
    state.activeEffects["door-wedge"],
    "trimming telemetry receipts incorrectly removed an authoritative active effect",
  );
});
