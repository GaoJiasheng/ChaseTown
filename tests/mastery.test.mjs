import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS, getCampaignGameplayConfig } from "../app/game/campaign.ts";
import {
  applyRunEvents,
  createRunTelemetry,
  evaluateRunMastery,
  masteryTargetSeconds,
  mergeStoredMastery,
  personalBestDelta,
} from "../app/game/mastery.ts";

test("telemetry counts authored stealth beats without double-counting lost-sight recovery", () => {
  const telemetry = applyRunEvents(createRunTelemetry(), [
    { type: "chaser-mode-changed", from: "patrol", to: "chase" },
    { type: "chaser-mode-changed", from: "chase", to: "lost-sight" },
    { type: "chaser-mode-changed", from: "lost-sight", to: "chase" },
    { type: "player-mode-changed", from: "free", to: "entering-hide" },
    { type: "player-mode-changed", from: "exiting-hide", to: "free" },
    { type: "hide-check-completed", hideSpotId: "locker", occupied: false },
  ]);

  assert.deepEqual(telemetry, {
    detections: 1,
    hideEntries: 1,
    safeHideExits: 1,
    lockerSearches: 1,
  });
});

test("every campaign level receives a finite, achievable-looking mastery target", () => {
  const targets = CAMPAIGN_LEVELS.map((level) => (
    masteryTargetSeconds(level, getCampaignGameplayConfig(level))
  ));
  assert.ok(targets.every((seconds) => Number.isInteger(seconds) && seconds >= 20 && seconds <= 90));
  assert.ok(new Set(targets).size >= 5, "authored maze lengths should not collapse to one target");
});

test("run evaluation awards readable bronze, silver and gold mastery", () => {
  const base = { hideEntries: 1, lockerSearches: 0 };
  const bronze = evaluateRunMastery(50, 30, {
    ...base,
    safeHideExits: 0,
    detections: 3,
  });
  const silver = evaluateRunMastery(50, 30, {
    ...base,
    safeHideExits: 1,
    detections: 1,
  });
  const gold = evaluateRunMastery(29.994, 30, {
    ...base,
    safeHideExits: 1,
    detections: 1,
  });

  assert.equal(bronze.rank, "bronze");
  assert.equal(silver.rank, "silver");
  assert.equal(gold.rank, "gold");
  assert.equal(gold.completedSeconds, 29.99);
  assert.deepEqual(gold.challenges.map(({ completed }) => completed), [true, true, true]);
});

test("stored mastery keeps the best rank and unions objectives across runs", () => {
  const first = evaluateRunMastery(24, 30, {
    detections: 4,
    hideEntries: 0,
    safeHideExits: 0,
    lockerSearches: 0,
  });
  const second = evaluateRunMastery(44, 30, {
    detections: 1,
    hideEntries: 1,
    safeHideExits: 1,
    lockerSearches: 0,
  });
  const afterFirst = mergeStoredMastery(undefined, first);
  const afterSecond = mergeStoredMastery(afterFirst, second);

  assert.equal(afterSecond.rank, "silver");
  assert.deepEqual(afterSecond.challengeIds, [
    "hide-and-slip",
    "single-sighting",
    "beat-target",
  ]);
});

test("personal best feedback preserves hundredths and reports the correct direction", () => {
  assert.deepEqual(personalBestDelta(undefined, 35.25), {
    isPersonalBest: true,
    deltaSeconds: null,
  });
  assert.deepEqual(personalBestDelta(35.25, 34.8), {
    isPersonalBest: true,
    deltaSeconds: -0.45,
  });
  assert.deepEqual(personalBestDelta(35.25, 36.1), {
    isPersonalBest: false,
    deltaSeconds: 0.85,
  });
});
