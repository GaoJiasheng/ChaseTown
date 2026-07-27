import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_CAUSAL_REPLAY_MAX_TIMELINE_ENTRIES,
  FAILURE_CAUSAL_REPLAY_MAX_TRACK_SAMPLES,
  buildFailureCausalReplay,
} from "../app/game/failure-causal-replay.ts";

function timed(atSeconds, event) {
  return { atSeconds, event };
}

function publicEvidence(overrides = {}) {
  return {
    kind: "sound",
    position: { x: 4, y: 2 },
    observedAtSeconds: 14,
    confidence: 0.8,
    decayPerSecond: 0.1,
    sourceType: "player-movement",
    sourceId: "public-footstep",
    repeatCount: 0,
    hideSpotId: null,
    strength: 0.8,
    ...overrides,
  };
}

function replay(overrides = {}) {
  return buildFailureCausalReplay({
    capturedAtSeconds: 20,
    publicEvents: [
      timed(8, { type: "chaser-mode-changed", from: "patrol", to: "suspicious" }),
      timed(12, { type: "player-mode-changed", from: "free", to: "entering-hide" }),
      timed(13, { type: "chaser-mode-changed", from: "search", to: "chase" }),
      timed(16, {
        type: "evidence-investigation-completed",
        evidenceId: "footstep-public-id",
        sourceType: "player-movement",
        completedAtSeconds: 16,
        completedAtTick: 960,
      }),
      timed(19, { type: "hide-check-completed", hideSpotId: "locker-west", occupied: true }),
      timed(20, { type: "player-captured", reason: "search-hide-check" }),
    ],
    publicEvidence: [
      publicEvidence({ observedAtSeconds: 13.5 }),
    ],
    playerActions: [
      { atSeconds: 11, action: "sprint", position: { x: 1, y: 1 } },
      { atSeconds: 11.2, action: "sprint", position: { x: 2, y: 1 } },
      { atSeconds: 17.5, action: "peek", position: { x: 4, y: 1 } },
    ],
    ...overrides,
  });
}

function assertPublicReplayText(result) {
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "occupancy",
    "occupied",
    "命中",
    "检查落空",
    "占用",
    "藏点有人",
    "发现玩家",
    "仍留",
    "仍留在藏点",
    "仍留在这个藏点",
    "仍在柜内",
    "藏点内有人",
    "hide-check-hit",
    "hide-check-miss",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `leaked hidden-state semantic: ${forbidden}`);
  }
}

test("builds a bounded chronological ten-second causal replay with a primary cause and correction", () => {
  const result = replay();

  assert.equal(result.captureReason, "search-hide-check");
  assert.deepEqual(result.window, {
    startSeconds: 10,
    endSeconds: 20,
    durationSeconds: 10,
  });
  assert.ok(result.timeline.length >= 3);
  assert.ok(result.timeline.length <= FAILURE_CAUSAL_REPLAY_MAX_TIMELINE_ENTRIES);
  assert.ok(result.timeline.every((entry) => entry.atSeconds >= 10 && entry.atSeconds <= 20));
  assert.deepEqual(
    result.timeline.map((entry) => entry.atSeconds),
    [...result.timeline.map((entry) => entry.atSeconds)].sort((left, right) => left - right),
  );
  assert.equal(result.timeline.at(-1).kind, "capture");
  assert.match(result.timeline.at(-1).label, /证据把他带到了柜门前/);
  assert.deepEqual(result.primaryCause, {
    code: "search-hide-check",
    label: "证据把他带到了柜门前",
    detail: "最后目击路径或奔跑声让这个柜子成为合理的搜索目标。",
    iconToken: "search",
  });
  assert.equal(result.advice.label, "下次这样做");
  assert.match(result.advice.detail, /少走直线/);
  assert.equal(result.advice.iconToken, "advice");
  assertPublicReplayText(result);
});

test("duplicate and shuffled inputs produce the same stable timeline and identifiers", () => {
  const publicEvents = [
    timed(18, { type: "player-mode-changed", from: "hidden", to: "entering-peek" }),
    timed(18.1, { type: "player-mode-changed", from: "entering-peek", to: "peeking" }),
    timed(19, { type: "chaser-mode-changed", from: "search", to: "check-hide" }),
    timed(20, { type: "player-captured", reason: "witnessed-hide-check" }),
  ];
  const publicEvidenceLog = [
    publicEvidence({
      kind: "hide-entry-visible",
      observedAtSeconds: 15,
      sourceType: "player",
      sourceId: "hide:private-looking-id",
      hideSpotId: "private-looking-id",
      confidence: 1,
      strength: 1,
    }),
    publicEvidence({
      kind: "hide-entry-visible",
      observedAtSeconds: 15,
      sourceType: "player",
      sourceId: "hide:private-looking-id",
      hideSpotId: "private-looking-id",
      confidence: 1,
      strength: 1,
    }),
  ];
  const playerActions = [
    { atSeconds: 18.05, action: "peek" },
    { atSeconds: 18.05, action: "peek" },
  ];
  const first = buildFailureCausalReplay({
    capturedAtSeconds: 20,
    publicEvents: [...publicEvents, ...publicEvents],
    publicEvidence: publicEvidenceLog,
    playerActions,
  });
  const second = buildFailureCausalReplay({
    capturedAtSeconds: 20,
    publicEvents: [...publicEvents, ...publicEvents].reverse(),
    publicEvidence: [...publicEvidenceLog].reverse(),
    playerActions: [...playerActions].reverse(),
  });

  assert.deepEqual(second, first);
  assert.equal(first.timeline.filter(({ label }) => label.includes("窥视")).length, 1);
  assert.equal(new Set(first.timeline.map(({ id }) => id)).size, first.timeline.length);
});

test("the projection never exposes evidence ids, hide ids, coordinates, authored cue text, or raw AI actions", () => {
  const result = buildFailureCausalReplay({
    capturedAtSeconds: 12,
    legacyCaptureReason: "SECRET_LEGACY_REASON",
    publicEvents: [
      timed(8, {
        type: "chaser-archetype-telegraph-started",
        archetype: "hospital-inspector",
        rule: "inspect-public-hide-clue",
        warningSeconds: 0.65,
        cueLabel: "SECRET_TARGET_CUE",
        cueAudioToken: "SECRET_AUDIO_TOKEN",
        cueAnimationToken: "SECRET_ANIMATION_TOKEN",
      }),
      timed(9, {
        type: "chaser-archetype-action-started",
        archetype: "hospital-inspector",
        rule: "inspect-public-hide-clue",
        action: "inspect-public-hide-clue",
      }),
      timed(10, {
        type: "evidence-investigation-completed",
        evidenceId: "SECRET_EVIDENCE_ID",
        sourceType: "door-disturbance",
        completedAtSeconds: 10,
        completedAtTick: 600,
      }),
      timed(11, {
        type: "hide-check-completed",
        hideSpotId: "SECRET_HIDE_SPOT",
        occupied: true,
      }),
    ],
    publicEvidence: [
      publicEvidence({
        kind: "hide-entry-visible",
        position: { x: 9876.543, y: -4567.89 },
        observedAtSeconds: 7,
        sourceType: "player",
        sourceId: "SECRET_SOURCE_ID",
        hideSpotId: "SECRET_HIDE_SPOT",
      }),
    ],
  });
  const serialized = JSON.stringify(result);

  for (const secret of [
    "SECRET_LEGACY_REASON",
    "SECRET_TARGET_CUE",
    "SECRET_AUDIO_TOKEN",
    "SECRET_ANIMATION_TOKEN",
    "SECRET_EVIDENCE_ID",
    "SECRET_SOURCE_ID",
    "SECRET_HIDE_SPOT",
    "inspect-public-hide-clue",
    "9876.543",
    "-4567.89",
  ]) assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  assert.equal(Object.hasOwn(result, "chaserPosition"), false);
  assert.equal(Object.hasOwn(result, "occupancy"), false);
  assertPublicReplayText(result);
});

test("all current reasons retain deterministic useful feedback and a two-to-six-node replay", () => {
  for (const reason of [
    "direct-contact",
    "exposed-hide-entry",
    "unsafe-hide-exit",
    "witnessed-hide-check",
    "search-hide-check",
  ]) {
    const result = buildFailureCausalReplay({
      capturedAtSeconds: 10,
      publicEvents: [timed(10, { type: "player-captured", reason })],
    });
    assert.equal(result.captureReason, reason);
    assert.equal(result.primaryCause.code, reason);
    assert.ok(result.primaryCause.label.length >= 4);
    assert.ok(result.primaryCause.detail.endsWith("。"));
    assert.ok(result.advice.detail.endsWith("。"));
    assert.ok(result.timeline.length >= 2);
    assert.ok(result.timeline.length <= FAILURE_CAUSAL_REPLAY_MAX_TIMELINE_ENTRIES);
    assert.equal(result.timeline.at(-1).kind, "capture");
    assertPublicReplayText(result);
  }

  assert.equal(buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [],
    legacyCaptureReason: "locker-search",
  }).captureReason, "search-hide-check");
  assert.equal(buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [],
    legacyCaptureReason: null,
  }).captureReason, "direct-contact");
  assert.equal(buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [],
    legacyCaptureReason: "future-private-reason",
  }).captureReason, "direct-contact");
});

test("legacy reason inference uses only public actions, check occurrence, and evidence", () => {
  const witnessed = buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [
      timed(9.5, { type: "hide-check-completed", hideSpotId: "any", occupied: true }),
    ],
    publicEvidence: [
      publicEvidence({
        kind: "hide-entry-visible",
        observedAtSeconds: 5,
        sourceType: "player",
      }),
    ],
  });
  assert.equal(witnessed.captureReason, "witnessed-hide-check");

  const witnessedWithOppositePrivateBit = buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [
      timed(9.5, { type: "hide-check-completed", hideSpotId: "any", occupied: false }),
    ],
    publicEvidence: [
      publicEvidence({
        kind: "hide-entry-visible",
        observedAtSeconds: 5,
        sourceType: "player",
      }),
    ],
  });
  assert.deepEqual(witnessedWithOppositePrivateBit, witnessed);

  const searched = buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [
      timed(9.5, { type: "hide-check-completed", hideSpotId: "any", occupied: true }),
    ],
  });
  assert.equal(searched.captureReason, "search-hide-check");

  const searchedWithOppositePrivateBit = buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [
      timed(9.5, { type: "hide-check-completed", hideSpotId: "any", occupied: false }),
    ],
  });
  assert.deepEqual(searchedWithOppositePrivateBit, searched);

  const unsafeExit = buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [],
    playerActions: [{ atSeconds: 9, action: "hide-exit" }],
  });
  assert.equal(unsafeExit.captureReason, "unsafe-hide-exit");

  const exposedEntry = buildFailureCausalReplay({
    capturedAtSeconds: 10,
    publicEvents: [],
    publicEvidence: [
      publicEvidence({
        kind: "hide-entry-visible",
        observedAtSeconds: 9,
        sourceType: "player",
      }),
    ],
  });
  assert.equal(exposedEntry.captureReason, "exposed-hide-entry");
  for (const result of [
    witnessed,
    witnessedWithOppositePrivateBit,
    searched,
    searchedWithOppositePrivateBit,
    unsafeExit,
    exposedEntry,
  ]) assertPublicReplayText(result);
});

test("capture-only input synthesizes one actionable public risk node before capture", () => {
  const result = buildFailureCausalReplay({
    capturedAtSeconds: 0,
    publicEvents: [
      timed(0, { type: "player-captured", reason: "direct-contact" }),
    ],
  });

  assert.equal(result.timeline.length, 2);
  assert.equal(result.timeline[0].kind, "threat-feedback");
  assert.match(result.timeline[0].detail, /减速观察/);
  assert.equal(result.timeline[1].kind, "capture");
  assertPublicReplayText(result);
});

test("lookback requests are clamped to eight–twelve seconds and reject invalid capture clocks", () => {
  const minimum = buildFailureCausalReplay({
    capturedAtSeconds: 30,
    windowSeconds: 2,
    publicEvents: [
      timed(21.99, { type: "player-mode-changed", from: "free", to: "entering-hide" }),
      timed(22, { type: "player-mode-changed", from: "hidden", to: "exiting-hide" }),
    ],
  });
  assert.deepEqual(minimum.window, {
    startSeconds: 22,
    endSeconds: 30,
    durationSeconds: 8,
  });
  assert.equal(minimum.timeline.some(({ label }) => label.includes("进入藏点")), false);
  assert.equal(minimum.timeline.some(({ label }) => label.includes("打开藏点")), true);

  const maximum = buildFailureCausalReplay({
    capturedAtSeconds: 30,
    windowSeconds: 99,
    publicEvents: [
      timed(18, { type: "player-mode-changed", from: "free", to: "entering-hide" }),
    ],
  });
  assert.deepEqual(maximum.window, {
    startSeconds: 18,
    endSeconds: 30,
    durationSeconds: 12,
  });
  assert.equal(maximum.timeline.some(({ label }) => label.includes("进入藏点")), true);

  const shortRun = buildFailureCausalReplay({
    capturedAtSeconds: 5,
    publicEvents: [],
  });
  assert.deepEqual(shortRun.window, {
    startSeconds: 0,
    endSeconds: 5,
    durationSeconds: 5,
  });
  assert.throws(
    () => buildFailureCausalReplay({ capturedAtSeconds: Number.NaN, publicEvents: [] }),
    /capturedAtSeconds/,
  );
});

test("semantic trajectory is optional, bounded, deterministic, and contains only player samples", () => {
  const actions = Array.from({ length: 60 }, (_, index) => ({
    atSeconds: 20 + index * 0.15,
    action: index % 4 === 0 ? "sprint" : "move",
    position: { x: index * 0.25, y: index % 3 },
  }));
  actions.push({ ...actions[30], position: { ...actions[30].position } });
  actions.push({ atSeconds: 29, action: "peek", position: { x: Number.POSITIVE_INFINITY, y: 0 } });
  const withoutTrack = buildFailureCausalReplay({
    capturedAtSeconds: 30,
    publicEvents: [],
    playerActions: actions,
  });
  assert.equal(withoutTrack.semanticTrack, undefined);

  const withTrack = buildFailureCausalReplay({
    capturedAtSeconds: 30,
    publicEvents: [],
    playerActions: [...actions].reverse(),
    publicEvidence: [
      publicEvidence({
        observedAtSeconds: 25,
        position: { x: 9999, y: 8888 },
        sourceId: "evidence-position-must-not-enter-track",
      }),
    ],
    includeSemanticTrack: true,
  });
  assert.ok(withTrack.semanticTrack);
  assert.ok(withTrack.semanticTrack.samples.length <= FAILURE_CAUSAL_REPLAY_MAX_TRACK_SAMPLES);
  assert.deepEqual(
    withTrack.semanticTrack.samples.map(({ atSeconds }) => atSeconds),
    [...withTrack.semanticTrack.samples.map(({ atSeconds }) => atSeconds)]
      .sort((left, right) => left - right),
  );
  assert.ok(withTrack.semanticTrack.samples.every(({ position }) => (
    position.x !== 9999 && position.y !== 8888
  )));
  assert.equal(
    new Set(withTrack.semanticTrack.samples.map((sample) => JSON.stringify(sample))).size,
    withTrack.semanticTrack.samples.length,
  );
  assert.equal(Object.isFrozen(withTrack.semanticTrack), true);
  assert.equal(Object.isFrozen(withTrack.semanticTrack.samples), true);
  assert.equal(Object.isFrozen(withTrack.semanticTrack.samples[0].position), true);
});

test("the complete result is deeply immutable without mutating caller logs", () => {
  const publicEvents = [
    timed(19, { type: "player-mode-changed", from: "hidden", to: "exiting-hide" }),
    timed(20, { type: "player-captured", reason: "unsafe-hide-exit" }),
  ];
  const snapshot = structuredClone(publicEvents);
  const result = buildFailureCausalReplay({
    capturedAtSeconds: 20,
    publicEvents,
  });

  assert.deepEqual(publicEvents, snapshot);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.window), true);
  assert.equal(Object.isFrozen(result.timeline), true);
  assert.equal(Object.isFrozen(result.timeline[0]), true);
  assert.equal(Object.isFrozen(result.primaryCause), true);
  assert.equal(Object.isFrozen(result.advice), true);
});
