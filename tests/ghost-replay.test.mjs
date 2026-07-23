import assert from "node:assert/strict";
import test from "node:test";

import {
  GHOST_POSITION_ERROR_BUDGET_CELLS,
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
