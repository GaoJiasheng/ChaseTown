import assert from "node:assert/strict";
import test from "node:test";

import {
  GHOST_POSITION_ERROR_BUDGET_CELLS,
  GHOST_REPLAY_ID_MAX_LENGTH,
  GHOST_REPLAY_MAX_RULE_EVENTS,
  GhostFixedStepInputBuffer,
  GhostInputRecorder,
  GhostReplayCursor,
  estimateGhostStorageBytes,
  ghostStorageKey,
  loadPersonalGhost,
  measureGhostReplayAccuracy,
  parseGhostRecording,
  sampleGhostInput,
  savePersonalBestGhost,
  savePersonalGhost,
  serializeGhostRecording,
} from "../app/game/ghost-replay.ts";
import {
  canRacePersonalGhost,
  GhostRaceTracker,
  GhostRuleProgressTracker,
} from "../app/game/ghost-race.ts";
import { createLevel } from "../app/game/level.ts";
import { GameSimulation } from "../app/game/simulation.ts";

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function replayChecksum(payload) {
  const value = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function resignSerializedGhost(raw) {
  const payload = { ...raw };
  delete payload.checksum;
  return JSON.stringify({
    ...payload,
    checksum: replayChecksum(payload),
  });
}

test("ghost input recording is change-compressed while interaction remains a one-tick edge", () => {
  const recorder = new GhostInputRecorder("campus", 1 / 60);
  for (let tick = 0; tick < 120; tick += 1) {
    recorder.record(tick, {
      move: tick < 60 ? { x: 1, y: 0 } : { x: 0, y: 1 },
      peekHeld: tick >= 80,
      hideExitChoice: tick >= 100 ? "alternate" : "origin",
      interactPressed: tick === 30,
    });
  }
  const recording = recorder.finish(120);
  assert.ok(recording);
  assert.ok(recording.keyframes.length <= 6);
  assert.equal(sampleGhostInput(recording, 30).interactPressed, true);
  assert.equal(sampleGhostInput(recording, 31).interactPressed, false);
  assert.equal(sampleGhostInput(recording, 79).peekHeld, false);
  assert.equal(sampleGhostInput(recording, 80).peekHeld, true);
  assert.equal(sampleGhostInput(recording, 99).hideExitChoice, "origin");
  assert.equal(sampleGhostInput(recording, 100).hideExitChoice, "alternate");

  const cursor = new GhostReplayCursor(recording);
  for (const tick of [0, 30, 31, 60, 80, 119]) {
    assert.deepEqual(cursor.sample(tick), sampleGhostInput(recording, tick));
  }
  assert.deepEqual(cursor.sample(10), sampleGhostInput(recording, 10), "cursor can seek backwards");
});

test("hide exit styles use mutually exclusive held flags and remain change-compressed", () => {
  const recorder = new GhostInputRecorder("hide-exit-styles", 1 / 60);
  for (let tick = 0; tick < 80; tick += 1) {
    const hideExitStyle = tick < 20
      ? "standard"
      : tick < 40
        ? "quick"
        : tick < 60
          ? "careful"
          : "standard";
    recorder.record(tick, {
      move: { x: 0, y: 0 },
      hideExitStyle,
      interactPressed: tick === 30,
    });
  }
  const recording = recorder.finish(80);
  assert.ok(recording);
  assert.deepEqual(
    recording.keyframes,
    [
      [0, 0, 0, 0],
      [20, 0, 0, 16],
      [30, 0, 0, 20],
      [40, 0, 0, 32],
      [60, 0, 0, 0],
    ],
    "styles should add frames only when the held style changes",
  );
  assert.equal(sampleGhostInput(recording, 19).hideExitStyle, "standard");
  assert.equal(sampleGhostInput(recording, 20).hideExitStyle, "quick");
  assert.equal(sampleGhostInput(recording, 30).hideExitStyle, "quick");
  assert.equal(sampleGhostInput(recording, 30).interactPressed, true);
  assert.equal(sampleGhostInput(recording, 31).interactPressed, false);
  assert.equal(sampleGhostInput(recording, 40).hideExitStyle, "careful");
  assert.equal(sampleGhostInput(recording, 60).hideExitStyle, "standard");

  const cursor = new GhostReplayCursor(recording);
  assert.equal(cursor.sample(55).hideExitStyle, "careful");
  assert.equal(cursor.sample(65).hideExitStyle, "standard");
  assert.equal(cursor.sample(25).hideExitStyle, "quick", "backward seek lost exit style");
});

test("parser rejects impossible dual exit-style flags but accepts legacy zero-bit Standard", () => {
  const recorder = new GhostInputRecorder("hide-exit-conflict", 1 / 60);
  recorder.record(0, { hideExitStyle: "quick" });
  const recording = recorder.finish(10);
  assert.ok(recording);
  const conflicting = JSON.parse(serializeGhostRecording(recording));
  conflicting.keyframes[0][3] = 16 | 32;
  assert.equal(
    parseGhostRecording(resignSerializedGhost(conflicting)),
    null,
    "a checksum-valid quick+careful frame must still be rejected",
  );

  const legacyPayload = {
    version: 1,
    levelId: "legacy-standard-zero-bit",
    fixedStepSeconds: 1 / 60,
    durationTicks: 10,
    keyframes: [
      [0, 127, 0, 0],
      [5, 0, 0, 8],
    ],
  };
  const legacy = parseGhostRecording(JSON.stringify({
    ...legacyPayload,
    checksum: replayChecksum(legacyPayload),
  }));
  assert.ok(legacy);
  assert.equal(sampleGhostInput(legacy, 0).hideExitStyle, "standard");
  assert.equal(sampleGhostInput(legacy, 7).hideExitStyle, "standard");
  assert.equal(sampleGhostInput(legacy, 7).hideExitChoice, "alternate");
  assert.deepEqual(
    parseGhostRecording(serializeGhostRecording(legacy)),
    legacy,
    "legacy v1 recording should round-trip without migration",
  );
});

test("checksum, level allowlist, per-run budget, and local storage reject corrupt ghosts", () => {
  const recorder = new GhostInputRecorder("hospital", 1 / 60);
  recorder.record(0, { move: { x: 1, y: 0 } });
  const recording = recorder.finish(60);
  assert.ok(recording);
  const serialized = serializeGhostRecording(recording);
  assert.ok(estimateGhostStorageBytes(recording) < 64 * 1024);
  assert.deepEqual(parseGhostRecording(serialized, new Set(["hospital"])), recording);
  assert.equal(parseGhostRecording(serialized, new Set(["factory"])), null);
  assert.equal(parseGhostRecording(serialized.replace("\"durationTicks\":60", "\"durationTicks\":61")), null);

  const storage = new MemoryStorage();
  assert.equal(savePersonalGhost(storage, recording), true);
  assert.deepEqual(loadPersonalGhost(storage, "hospital"), recording);
  assert.ok(storage.values.has(ghostStorageKey("hospital")));
  storage.setItem(ghostStorageKey("hospital"), "{broken");
  assert.equal(loadPersonalGhost(storage, "hospital"), null);

  const tiny = new GhostInputRecorder("overflow", 1 / 60, { maximumBytes: 256 });
  let accepted = true;
  for (let tick = 0; tick < 100 && accepted; tick += 1) {
    accepted = tiny.record(tick, {
      move: { x: tick % 2 ? 1 : -1, y: tick % 3 ? 0.5 : -0.5 },
    });
  }
  assert.equal(tiny.overflowed, true);
  assert.equal(tiny.finish(100), null);
});

test("mission-faithful rule events round-trip without invalidating legacy v1 ghosts", () => {
  const recorder = new GhostInputRecorder("mission-sidecar", 1 / 60);
  recorder.record(0, { move: { x: 1, y: 0 } });
  assert.equal(recorder.recordRuleEvent({
    tick: 20,
    type: "objective-completed",
    objectiveId: "power",
  }), true);
  assert.equal(recorder.recordRuleEvent({
    tick: 20,
    type: "mechanic-committed",
    mechanicId: "bell-west",
  }), true);
  assert.equal(recorder.recordRuleEvent({
    tick: 40,
    type: "exit-unlocked",
    objectiveId: "release",
  }), true);
  assert.equal(recorder.recordRuleEvent({ tick: 60, type: "run-completed" }), true);
  const recording = recorder.finish(60);
  assert.ok(recording);
  assert.equal(recording.ruleEvents?.length, 4);
  assert.deepEqual(
    parseGhostRecording(
      serializeGhostRecording(recording),
      new Set(["mission-sidecar"]),
    ),
    recording,
  );

  const malformed = JSON.parse(serializeGhostRecording(recording));
  malformed.ruleEvents[0].tick = 61;
  assert.equal(parseGhostRecording(JSON.stringify(malformed)), null);

  const legacy = new GhostInputRecorder("legacy-no-sidecar", 1 / 60);
  legacy.record(0, { move: { x: 0, y: 1 } });
  const legacyRecording = legacy.finish(30);
  assert.ok(legacyRecording);
  assert.equal(legacyRecording.ruleEvents, undefined);
  assert.deepEqual(
    parseGhostRecording(serializeGhostRecording(legacyRecording)),
    legacyRecording,
  );
});

test("portable decoy commands round-trip with canonical identity, landing, and checksum", () => {
  const firstLanding = { x: 6.25, y: 4.5 };
  const recorder = new GhostInputRecorder("portable-decoy-sidecar", 1 / 60);
  recorder.record(0, { move: { x: 1, y: 0 } });
  assert.equal(recorder.recordRuleEvent({
    tick: 12,
    type: "portable-decoy-thrown",
    deploymentId: "library-portable-decoy:deployment:1",
    sourceId: "library-portable-decoy:source:1",
    landing: firstLanding,
  }), true);
  assert.equal(recorder.recordRuleEvent({
    sourceId: "library-portable-decoy:source:2",
    landing: { y: 7.75, x: 3.125 },
    deploymentId: "library-portable-decoy:deployment:2",
    type: "portable-decoy-thrown",
    tick: 12,
  }), true);
  firstLanding.x = 99;

  const recording = recorder.finish(30);
  assert.ok(recording);
  const decoyEvents = recording.ruleEvents?.filter(
    (event) => event.type === "portable-decoy-thrown",
  );
  assert.deepEqual(decoyEvents?.map((event) => event.deploymentId), [
    "library-portable-decoy:deployment:1",
    "library-portable-decoy:deployment:2",
  ]);
  assert.deepEqual(decoyEvents?.map((event) => event.landing), [
    { x: 6.25, y: 4.5 },
    { x: 3.125, y: 7.75 },
  ]);
  assert.equal(Object.isFrozen(decoyEvents?.[0].landing), true);

  const serialized = serializeGhostRecording(recording);
  const parsed = parseGhostRecording(
    serialized,
    new Set(["portable-decoy-sidecar"]),
  );
  assert.deepEqual(parsed, recording);
  assert.equal(Object.isFrozen(parsed.ruleEvents[0].landing), true);

  const sameCommands = new GhostInputRecorder("portable-decoy-sidecar", 1 / 60);
  sameCommands.record(0, { move: { x: 1, y: 0 } });
  sameCommands.recordRuleEvent({
    landing: { y: 4.5, x: 6.25 },
    sourceId: "library-portable-decoy:source:1",
    tick: 12,
    deploymentId: "library-portable-decoy:deployment:1",
    type: "portable-decoy-thrown",
  });
  sameCommands.recordRuleEvent({
    tick: 12,
    type: "portable-decoy-thrown",
    deploymentId: "library-portable-decoy:deployment:2",
    sourceId: "library-portable-decoy:source:2",
    landing: { x: 3.125, y: 7.75 },
  });
  const sameRecording = sameCommands.finish(30);
  assert.ok(sameRecording);
  assert.equal(sameRecording.checksum, recording.checksum);
  assert.equal(serializeGhostRecording(sameRecording), serialized);

  const tampered = JSON.parse(serialized);
  tampered.ruleEvents[0].landing.x = 6.5;
  assert.equal(parseGhostRecording(JSON.stringify(tampered)), null);
});

test("portable decoy sidecar rejects non-finite, ambiguous, and malformed payloads", () => {
  const event = (overrides = {}) => ({
    tick: 10,
    type: "portable-decoy-thrown",
    deploymentId: "decoy:deployment:1",
    sourceId: "decoy:source:1",
    landing: { x: 2.5, y: 3.5 },
    ...overrides,
  });
  for (const invalid of [
    event({ deploymentId: "" }),
    event({ deploymentId: " padded" }),
    event({ sourceId: `s${"x".repeat(GHOST_REPLAY_ID_MAX_LENGTH)}` }),
    event({ landing: { x: Number.NaN, y: 3.5 } }),
    event({ landing: { x: 2.5, y: Number.POSITIVE_INFINITY } }),
    event({ landing: { x: 2.5, y: 3.5, z: 0 } }),
    event({ debugLabel: "not-part-of-the-command" }),
  ]) {
    const recorder = new GhostInputRecorder("portable-decoy-invalid", 1 / 60);
    recorder.record(0, {});
    assert.equal(recorder.recordRuleEvent(invalid), false);
    assert.equal(recorder.overflowed, false);
  }

  const ordered = new GhostInputRecorder("portable-decoy-order", 1 / 60);
  ordered.record(0, {});
  assert.equal(ordered.recordRuleEvent(event()), true);
  assert.equal(ordered.recordRuleEvent(event({
    tick: 9,
    deploymentId: "decoy:deployment:2",
    sourceId: "decoy:source:2",
  })), false);

  const valid = new GhostInputRecorder("portable-decoy-parse", 1 / 60);
  valid.record(0, {});
  valid.recordRuleEvent(event());
  const validRecording = valid.finish(20);
  assert.ok(validRecording);
  const serialized = serializeGhostRecording(validRecording);
  const malformedMutations = [
    (raw) => { raw.ruleEvents[0].landing.x = null; },
    (raw) => { raw.ruleEvents[0].landing.z = 0; },
    (raw) => { raw.ruleEvents[0].sourceId = " "; },
    (raw) => { raw.ruleEvents[0].deploymentId = "x".repeat(GHOST_REPLAY_ID_MAX_LENGTH + 1); },
    (raw) => { raw.ruleEvents[0].unexpected = true; },
  ];
  for (const mutate of malformedMutations) {
    const raw = JSON.parse(serialized);
    mutate(raw);
    assert.equal(
      parseGhostRecording(resignSerializedGhost(raw)),
      null,
      "structurally illegal payload survived a valid checksum",
    );
  }

  const invalidPayload = {
    ...validRecording,
    ruleEvents: [{
      ...validRecording.ruleEvents[0],
      landing: { x: Number.NaN, y: 3.5 },
    }],
  };
  delete invalidPayload.checksum;
  assert.throws(
    () => serializeGhostRecording({
      ...invalidPayload,
      checksum: replayChecksum(invalidPayload),
    }),
    /invalid checksum/,
  );
});

test("same-tick portable decoy order and rule-event byte/count budgets are deterministic", () => {
  const ordered = new GhostInputRecorder("portable-decoy-same-tick", 1 / 60);
  ordered.record(0, {});
  for (const index of [3, 1, 2]) {
    assert.equal(ordered.recordRuleEvent({
      tick: 8,
      type: "portable-decoy-thrown",
      deploymentId: `deployment:${index}`,
      sourceId: `source:${index}`,
      landing: { x: index + 0.25, y: index + 0.75 },
    }), true);
  }
  const orderedRecording = ordered.finish(12);
  assert.ok(orderedRecording);
  const parsedOrdered = parseGhostRecording(
    serializeGhostRecording(orderedRecording),
  );
  assert.ok(parsedOrdered);
  assert.deepEqual(
    parsedOrdered.ruleEvents.map((event) => event.deploymentId),
    ["deployment:3", "deployment:1", "deployment:2"],
  );

  const countBounded = new GhostInputRecorder("portable-decoy-count-budget", 1 / 60);
  countBounded.record(0, {});
  for (let index = 0; index < GHOST_REPLAY_MAX_RULE_EVENTS; index += 1) {
    assert.equal(countBounded.recordRuleEvent({
      tick: 1,
      type: "portable-decoy-thrown",
      deploymentId: `deployment:${index}`,
      sourceId: `source:${index}`,
      landing: { x: index / 10, y: 1 },
    }), true);
  }
  assert.equal(countBounded.recordRuleEvent({
    tick: 1,
    type: "portable-decoy-thrown",
    deploymentId: "deployment:overflow",
    sourceId: "source:overflow",
    landing: { x: 0, y: 1 },
  }), false);
  assert.equal(countBounded.overflowed, true);
  assert.equal(countBounded.finish(1), null);

  const byteBounded = new GhostInputRecorder(
    "portable-decoy-byte-budget",
    1 / 60,
    { maximumBytes: 1024 },
  );
  byteBounded.record(0, {});
  let accepted = 0;
  for (let index = 0; index < 20; index += 1) {
    const suffix = `${index}-${"x".repeat(76)}`;
    if (!byteBounded.recordRuleEvent({
      tick: 4,
      type: "portable-decoy-thrown",
      deploymentId: `deployment-${suffix}`,
      sourceId: `source-${suffix}`,
      landing: { x: index + 0.125, y: 2.5 },
    })) break;
    accepted += 1;
  }
  assert.ok(accepted > 0 && accepted < 20);
  assert.equal(byteBounded.overflowed, true);
  assert.equal(byteBounded.finish(4), null);
});

test("fixed-step input buffer preserves a sub-frame interaction edge at 144 Hz", () => {
  const buffer = new GhostFixedStepInputBuffer();
  buffer.stage(0, {
    move: { x: 0, y: 0 },
    interactPressed: false,
  });
  assert.equal(buffer.consumeIfAdvanced(0), null);
  buffer.stage(0, {
    move: { x: 1, y: 0 },
    interactPressed: true,
    sneakHeld: true,
    hideExitStyle: "quick",
  });
  buffer.stage(0, {
    move: { x: 0, y: 1 },
    interactPressed: false,
    sneakHeld: false,
    hideExitStyle: "careful",
  });
  const committed = buffer.consumeIfAdvanced(1);
  assert.equal(committed?.tick, 0);
  assert.deepEqual(committed?.input.move, { x: 0, y: 1 });
  assert.equal(committed?.input.interactPressed, true);
  assert.equal(committed?.input.sneakHeld, false);
  assert.equal(committed?.input.hideExitStyle, "careful");
  assert.equal(buffer.consumeIfAdvanced(2), null);

  buffer.stage(1, { move: { x: -1, y: 0 }, hideExitStyle: "quick" });
  const quick = buffer.consumeIfAdvanced(2);
  assert.equal(quick?.input.hideExitStyle, "quick");
  buffer.stage(2, { move: { x: -1, y: 0 }, hideExitStyle: "standard" });
  buffer.reset();
  assert.equal(buffer.consumeIfAdvanced(3), null);
});

test("fixed-step input buffer retains an explicitly selected exit style across sparse stages", () => {
  const buffer = new GhostFixedStepInputBuffer();
  buffer.stage(0, {
    hideExitStyle: "quick",
    move: { x: 1, y: 0 },
  });
  buffer.stage(0, {
    interactPressed: true,
    move: { x: 0, y: 1 },
  });
  buffer.stage(0, {
    interactPressed: false,
    move: { x: -1, y: 0 },
  });
  const sameTick = buffer.consumeIfAdvanced(1);
  assert.equal(sameTick?.input.hideExitStyle, "quick");
  assert.equal(sameTick?.input.interactPressed, true);
  assert.deepEqual(sameTick?.input.move, { x: -1, y: 0 });

  buffer.stage(1, { move: { x: 0, y: -1 } });
  const nextTick = buffer.consumeIfAdvanced(2);
  assert.equal(
    nextTick?.input.hideExitStyle,
    "quick",
    "a sparse later tick diverged from GameSimulation held-input semantics",
  );

  buffer.stage(2, { hideExitStyle: "standard" });
  assert.equal(buffer.consumeIfAdvanced(3)?.input.hideExitStyle, "standard");
  buffer.reset();
  buffer.stage(3, {});
  assert.equal(
    buffer.consumeIfAdvanced(4)?.input.hideExitStyle,
    undefined,
    "reset leaked a prior run's held style",
  );
});

test("pre-step ghost recording reproduces fixed-step movement at 30/60/120/144 Hz", () => {
  const walkable = Array.from({ length: 40 }, () => Array(40).fill(true));
  const level = createLevel({
    id: "ghost-render-rate-contract",
    width: 40,
    height: 40,
    walkable,
    playerStart: { x: 4, y: 4 },
    exit: { x: 38, y: 38 },
    chaserStart: { x: 38, y: 2 },
    chaserStartHeading: { x: 0, y: 1 },
    patrol: [{ x: 38, y: 36 }],
    hideSpots: [],
  });
  const options = {
    level,
    autoStart: true,
    config: {
      fixedStepSeconds: 1 / 60,
      spawnDelaySeconds: 999,
    },
  };

  for (const renderRate of [30, 60, 120, 144]) {
    const referenceSimulation = new GameSimulation(options);
    const recorder = new GhostInputRecorder(`${level.id}:${renderRate}`, 1 / 60);
    const buffer = new GhostFixedStepInputBuffer();
    let renderFrame = 0;
    let referenceState = referenceSimulation.getState();
    while (referenceState.tick < 180) {
      const preStepTick = referenceState.tick;
      const input = {
        move: preStepTick < 90 ? { x: 1, y: 0 } : { x: 0, y: 1 },
        // At 144 Hz this edge lands on a render frame that cannot advance the
        // fixed simulation by itself. The following neutral frame must not
        // erase it from the recording.
        interactPressed: renderRate === 144 && renderFrame === 1,
      };
      buffer.stage(preStepTick, input);
      referenceState = referenceSimulation.advance(1 / renderRate, input);
      const committed = buffer.consumeIfAdvanced(referenceState.tick);
      if (committed) recorder.record(committed.tick, committed.input);
      renderFrame += 1;
    }
    const recording = recorder.finish(referenceState.tick);
    assert.ok(recording, `${renderRate} Hz recording failed`);
    if (renderRate === 144) {
      assert.equal(sampleGhostInput(recording, 0).interactPressed, true);
      assert.equal(sampleGhostInput(recording, 1).interactPressed, false);
    }

    const replaySimulation = new GameSimulation(options);
    const cursor = new GhostReplayCursor(recording);
    let replayState = replaySimulation.getState();
    while (replayState.tick < recording.durationTicks) {
      replayState = replaySimulation.advance(
        recording.fixedStepSeconds,
        cursor.sample(replayState.tick),
      );
    }
    const error = Math.hypot(
      referenceState.player.position.x - replayState.player.position.x,
      referenceState.player.position.y - replayState.player.position.y,
    );
    assert.ok(
      error <= GHOST_POSITION_ERROR_BUDGET_CELLS,
      `${renderRate} Hz replay drifted by ${error.toFixed(6)} cells`,
    );
    assert.equal(replayState.tick, referenceState.tick);
  }
});

function replayStyledHideExit(style) {
  const spot = {
    id: `ghost-${style}-locker`,
    approach: { x: 2, y: 0 },
    concealed: { x: 2, y: -0.3 },
    facing: { x: 1, y: 0 },
  };
  const level = createLevel({
    id: `ghost-hide-exit-${style}`,
    width: 10,
    height: 1,
    walkable: [Array(10).fill(true)],
    playerStart: { ...spot.approach },
    exit: { x: 0, y: 0 },
    chaserStart: { x: 9, y: 0 },
    chaserStartHeading: { x: 0, y: 1 },
    patrol: [{ x: 9, y: 0 }],
    hideSpots: [spot],
  });
  const options = {
    level,
    autoStart: true,
    initialPlayerHeading: spot.facing,
    config: {
      fixedStepSeconds: 1 / 60,
      maxFrameDeltaSeconds: 2,
      spawnDelaySeconds: 999,
      chaserSpeed: 0,
      hideEnterSeconds: 0.1,
      hideEnterExposureSeconds: 0.08,
      hideExitSeconds: 0.6,
      hideExitExposureSeconds: 0.1,
      hideInteractRange: 0.2,
      catchRange: 0.05,
      hearingRange: 0.1,
    },
  };
  const reference = new GameSimulation(options);
  const recorder = new GhostInputRecorder(level.id, 1 / 60);
  let referenceExitTick = null;
  let referenceState = reference.getState();
  for (let tick = 0; tick < 90; tick += 1) {
    const input = {
      hideExitStyle: style,
      interactPressed: tick === 0 || tick === 12,
    };
    recorder.record(tick, input);
    referenceState = reference.advance(1 / 60, input);
    if (tick > 12 && referenceExitTick === null && referenceState.player.mode === "free") {
      referenceExitTick = referenceState.tick;
    }
  }
  const recording = recorder.finish(referenceState.tick);
  assert.ok(recording);

  const replay = new GameSimulation(options);
  const cursor = new GhostReplayCursor(recording);
  let replayExitTick = null;
  let replayState = replay.getState();
  while (replayState.tick < recording.durationTicks) {
    replayState = replay.advance(
      recording.fixedStepSeconds,
      cursor.sample(replayState.tick),
    );
    if (replayState.tick > 12 && replayExitTick === null && replayState.player.mode === "free") {
      replayExitTick = replayState.tick;
    }
  }
  assert.equal(replayExitTick, referenceExitTick);
  assert.deepEqual(replayState.player, referenceState.player);
  assert.deepEqual(replayState.hideSpots, referenceState.hideSpots);
  return {
    exitTick: referenceExitTick,
    disturbance: referenceState.hideSpots[spot.id].disturbanceLevel,
  };
}

test("quick and careful ghost inputs reproduce their distinct hide-exit timing", () => {
  const quick = replayStyledHideExit("quick");
  const careful = replayStyledHideExit("careful");
  assert.ok(quick.exitTick < careful.exitTick);
  assert.equal(quick.disturbance, 3);
  assert.equal(careful.disturbance, 2);
});

test("quantized replay stays deterministic inside the 0.1-cell personal ghost budget", () => {
  const walkable = Array.from({ length: 12 }, () => Array(12).fill(true));
  const level = createLevel({
    id: "ghost-accuracy",
    width: 12,
    height: 12,
    walkable,
    playerStart: { x: 1, y: 1 },
    exit: { x: 10, y: 10 },
    chaserStart: { x: 10, y: 1 },
    chaserStartHeading: { x: 0, y: 1 },
    patrol: [{ x: 10, y: 10 }],
    hideSpots: [],
  });
  const options = {
    level,
    autoStart: true,
    config: {
      fixedStepSeconds: 1 / 60,
      spawnDelaySeconds: 999,
    },
  };
  const referenceSimulation = new GameSimulation(options);
  const recorder = new GhostInputRecorder(level.id, 1 / 60);
  const reference = [];

  for (let tick = 0; tick < 180; tick += 1) {
    const input = tick < 90
      ? { move: { x: 1, y: 0 } }
      : { move: { x: 0, y: 1 } };
    recorder.record(tick, input);
    const state = referenceSimulation.advance(1 / 60, input);
    if (tick % 15 === 0) reference.push({ tick, position: state.player.position });
  }
  const recording = recorder.finish(180);
  assert.ok(recording);

  const replaySimulation = new GameSimulation(options);
  const cursor = new GhostReplayCursor(recording);
  const replayed = [];
  for (let tick = 0; tick < 180; tick += 1) {
    const state = replaySimulation.advance(1 / 60, cursor.sample(tick));
    if (tick % 15 === 0) replayed.push({ tick, position: state.player.position });
  }
  const accuracy = measureGhostReplayAccuracy(reference, replayed);
  assert.equal(accuracy.comparedSamples, reference.length);
  assert.ok(accuracy.maximumPositionErrorCells <= GHOST_POSITION_ERROR_BUDGET_CELLS);
  assert.equal(accuracy.withinBudget, true);
});

test("only a faster Standard run replaces the ranked personal ghost", () => {
  const storage = new MemoryStorage();
  const makeRecording = (ticks) => {
    const recorder = new GhostInputRecorder("campus", 1 / 60);
    recorder.record(0, { move: { x: 1, y: 0 } });
    return recorder.finish(ticks);
  };
  const first = makeRecording(600);
  const slower = makeRecording(720);
  const faster = makeRecording(540);
  assert.ok(first && slower && faster);

  assert.equal(savePersonalBestGhost(storage, first).status, "saved-first");
  assert.equal(savePersonalBestGhost(storage, slower).status, "kept-faster");
  assert.deepEqual(loadPersonalGhost(storage, "campus"), first);
  assert.equal(savePersonalBestGhost(storage, faster, "assisted").status, "rejected-assisted");
  assert.deepEqual(loadPersonalGhost(storage, "campus"), first);
  assert.equal(savePersonalBestGhost(storage, faster).status, "saved-faster");
  assert.deepEqual(loadPersonalGhost(storage, "campus"), faster);
});

test("ghost race eligibility and split deltas stay isolated from gameplay", () => {
  const recorder = new GhostInputRecorder("factory", 1 / 60);
  recorder.record(0, { move: { x: 1, y: 0 } });
  const recording = recorder.finish(600);
  assert.ok(recording);
  assert.equal(canRacePersonalGhost({
    recording,
    levelId: "factory",
    fixedStepSeconds: 1 / 60,
    ruleset: "standard",
  }), true);
  assert.equal(canRacePersonalGhost({
    recording,
    levelId: "factory",
    fixedStepSeconds: 1 / 60,
    ruleset: "assisted",
  }), false);

  const tracker = new GhostRaceTracker(recording, 100);
  let snapshot = tracker.update({
    elapsedSeconds: 4,
    playerRemainingMeters: 74,
    ghostRemainingMeters: 78,
  });
  assert.equal(snapshot.leader, "player");
  assert.equal(snapshot.playerLeadMeters, 4);
  assert.equal(snapshot.latestSplit, null);

  snapshot = tracker.update({
    elapsedSeconds: 5,
    playerRemainingMeters: 70,
    ghostRemainingMeters: 74,
  });
  assert.equal(snapshot.latestSplit?.id, "opening");
  assert.equal(snapshot.latestSplit?.deltaSeconds, -1);
  assert.deepEqual(snapshot.completedSplitIds, ["opening"]);
});

test("ghost rule progress records mission/mechanic events and cannot regress", () => {
  const tracker = new GhostRuleProgressTracker(["power", "pressure", "release"]);
  let progress = tracker.update({
    tick: 0,
    routeProgress: 0.95,
  });
  assert.equal(progress.stage, "preparation");
  assert.equal(progress.normalizedProgress, 0, "approaching a locked exit advanced the ghost");

  progress = tracker.update({
    tick: 20,
    routeProgress: 0.1,
    events: [
      { type: "objective-completed", objectiveId: "power" },
      { type: "mechanic-committed", mechanicId: "alarm-decoy" },
    ],
  });
  const afterFirstObjective = progress.normalizedProgress;
  assert.deepEqual(progress.completedObjectiveIds, ["power"]);
  assert.deepEqual(progress.committedMechanicIds, ["alarm-decoy"]);

  progress = tracker.update({
    tick: 21,
    routeProgress: 0,
    events: [
      { type: "objective-completed", objectiveId: "power" },
      { type: "mechanic-committed", mechanicId: "alarm-decoy" },
    ],
  });
  assert.equal(progress.events.length, 2, "duplicate public events changed replay history");
  assert.equal(progress.normalizedProgress, afterFirstObjective);

  progress = tracker.update({
    tick: 80,
    routeProgress: 0.2,
    events: [
      { type: "objective-completed", objectiveId: "pressure" },
      { type: "objective-completed", objectiveId: "release" },
      { type: "exit-unlocked", objectiveId: "release" },
    ],
  });
  assert.equal(progress.stage, "escape");
  const afterUnlock = progress.normalizedProgress;

  progress = tracker.update({ tick: 100, routeProgress: 0.8 });
  const afterAdvance = progress.normalizedProgress;
  assert.ok(afterAdvance > afterUnlock);
  progress = tracker.update({ tick: 110, routeProgress: 0.1 });
  assert.equal(progress.normalizedProgress, afterAdvance, "route backtracking regressed ghost progress");

  progress = tracker.update({
    tick: 120,
    routeProgress: 0.9,
    events: [{ type: "run-completed" }],
  });
  assert.equal(progress.stage, "complete");
  assert.equal(progress.normalizedProgress, 1);
  assert.deepEqual(progress.events.map(({ sequence }) => sequence), [0, 1, 2, 3, 4, 5]);
  assert.throws(
    () => new GhostRuleProgressTracker(["release"]).update({
      tick: 0,
      routeProgress: 1,
      events: [{ type: "exit-unlocked", objectiveId: "release" }],
    }),
    /before every objective/,
  );
});

test("mission-faithful ghost race does not reward standing beside a locked exit", () => {
  const recorder = new GhostInputRecorder("mission-race", 1 / 60);
  recorder.record(0, { move: { x: 1, y: 0 } });
  const recording = recorder.finish(600);
  assert.ok(recording);
  const tracker = new GhostRaceTracker(recording, 100);
  const ruleProgress = (normalizedProgress, stage) => ({
    version: 1,
    tick: 60,
    stage,
    normalizedProgress,
    routeProgress: normalizedProgress,
    completedObjectiveIds: [],
    committedMechanicIds: [],
    exitUnlocked: stage === "escape" || stage === "complete",
    runCompleted: stage === "complete",
    events: [],
  });

  let snapshot = tracker.update({
    elapsedSeconds: 3,
    playerRemainingMeters: 4,
    ghostRemainingMeters: 65,
    playerRuleProgress: ruleProgress(0.2, "preparation"),
    ghostRuleProgress: ruleProgress(0.76, "escape"),
  });
  assert.ok(snapshot.playerLeadMeters > 0, "test setup no longer puts player by the exit");
  assert.equal(snapshot.leader, "ghost");
  assert.ok(snapshot.playerLeadProgress < 0);
  assert.deepEqual(snapshot.completedSplitIds, []);

  snapshot = tracker.update({
    elapsedSeconds: 5,
    playerRemainingMeters: 3,
    ghostRemainingMeters: 60,
    playerRuleProgress: ruleProgress(0.8, "escape"),
    ghostRuleProgress: ruleProgress(0.8, "escape"),
  });
  assert.equal(snapshot.latestSplit?.id, "final");
  assert.equal(snapshot.latestSplit?.deltaSeconds, 2);
  assert.deepEqual(snapshot.completedSplitIds, ["opening", "midpoint", "final"]);
});

test("mission-faithful ghost race never breaks a semantic tie with locked-exit distance", () => {
  const recorder = new GhostInputRecorder("mission-tie", 1 / 60);
  recorder.record(0, { move: { x: 0, y: 0 } });
  const recording = recorder.finish(600);
  assert.ok(recording);
  const tracker = new GhostRaceTracker(recording, 100);
  const progress = {
    version: 1,
    tick: 60,
    stage: "preparation",
    normalizedProgress: 0.32,
    routeProgress: 0,
    completedObjectiveIds: ["power"],
    committedMechanicIds: [],
    exitUnlocked: false,
    runCompleted: false,
    events: [],
  };
  const snapshot = tracker.update({
    elapsedSeconds: 4,
    playerRemainingMeters: 2,
    ghostRemainingMeters: 98,
    playerRuleProgress: progress,
    ghostRuleProgress: progress,
  });
  assert.ok(snapshot.playerLeadMeters > 90, "test setup no longer creates a spatial lead");
  assert.equal(snapshot.playerLeadProgress, 0);
  assert.equal(snapshot.leader, "tied");
});
