import assert from "node:assert/strict";
import test from "node:test";

import {
  createCampaignProgress,
  getCampaignRunRecord,
  recordCampaignCompletion,
  sanitizeCampaignProgress,
} from "../app/game/campaign-progress.ts";
import { createRunTelemetry, evaluateRunMastery } from "../app/game/mastery.ts";

const levelIds = ["one", "two", "three"];

test("legacy time-only progress migrates without losing precise best times", () => {
  assert.deepEqual(sanitizeCampaignProgress({
    unlockedThrough: 2,
    bestSeconds: { one: 42, two: 31.27 },
  }, levelIds), {
    unlockedThrough: 2,
    bestSeconds: { one: 42, two: 31.27 },
    mastery: {},
    assistedBestSeconds: {},
    assistedMastery: {},
    progressVersion: 2,
  });
});

test("progress sanitation clamps unlocks and removes corrupt or foreign records", () => {
  assert.deepEqual(sanitizeCampaignProgress({
    unlockedThrough: 99,
    bestSeconds: { one: -4, two: Number.NaN, foreign: 12 },
    mastery: {
      one: { rank: "diamond", challengeIds: ["beat-target"] },
      two: {
        rank: "gold",
        challengeIds: ["beat-target", "double-slip", "invented"],
        profileId: "level:two:v2",
      },
      foreign: { rank: "gold", challengeIds: ["beat-target"] },
    },
  }, levelIds), {
    unlockedThrough: 3,
    bestSeconds: {},
    mastery: {
      two: {
        rank: "gold",
        challengeIds: ["beat-target", "double-slip"],
        profileId: "level:two:v2",
      },
    },
    assistedBestSeconds: {},
    assistedMastery: {},
    progressVersion: 2,
  });
});

test("unavailable or malformed storage always retains the first playable chapter", () => {
  assert.deepEqual(sanitizeCampaignProgress(null, levelIds), createCampaignProgress());
  assert.deepEqual(sanitizeCampaignProgress("bad-json-shape", levelIds), createCampaignProgress());
  assert.deepEqual(sanitizeCampaignProgress({}, []), createCampaignProgress());
});

test("Standard and assisted results retain separate best times, mastery, and unlock authority", () => {
  const assistedResult = evaluateRunMastery(22, 30, {
    ...createRunTelemetry({ levelId: "one", ruleset: "assisted" }),
    detections: 0,
    hideEntries: 1,
    safeHideExits: 1,
  });
  const afterAssisted = recordCampaignCompletion(
    createCampaignProgress(),
    "one",
    22,
    assistedResult,
    2,
  );
  assert.equal(afterAssisted.unlockedThrough, 1);
  assert.equal(getCampaignRunRecord(afterAssisted, "one").bestSeconds, undefined);
  assert.equal(getCampaignRunRecord(afterAssisted, "one", "assisted").bestSeconds, 22);

  const standardResult = evaluateRunMastery(25, 30, {
    ...createRunTelemetry({ levelId: "one", ruleset: "standard" }),
    detections: 0,
    hideEntries: 1,
    safeHideExits: 1,
  });
  const afterStandard = recordCampaignCompletion(
    afterAssisted,
    "one",
    25,
    standardResult,
    2,
  );
  assert.equal(afterStandard.unlockedThrough, 2);
  assert.equal(getCampaignRunRecord(afterStandard, "one").bestSeconds, 25);
  assert.equal(getCampaignRunRecord(afterStandard, "one", "assisted").bestSeconds, 22);

  const migrated = sanitizeCampaignProgress(afterStandard, levelIds);
  assert.equal(migrated.bestSeconds.one, 25);
  assert.equal(migrated.assistedBestSeconds.one, 22);
});
