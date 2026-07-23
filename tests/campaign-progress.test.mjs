import assert from "node:assert/strict";
import test from "node:test";

import {
  createCampaignProgress,
  sanitizeCampaignProgress,
} from "../app/game/campaign-progress.ts";

const levelIds = ["one", "two", "three"];

test("legacy time-only progress migrates without losing precise best times", () => {
  assert.deepEqual(sanitizeCampaignProgress({
    unlockedThrough: 2,
    bestSeconds: { one: 42, two: 31.27 },
  }, levelIds), {
    unlockedThrough: 2,
    bestSeconds: { one: 42, two: 31.27 },
    mastery: {},
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
  });
});

test("unavailable or malformed storage always retains the first playable chapter", () => {
  assert.deepEqual(sanitizeCampaignProgress(null, levelIds), createCampaignProgress());
  assert.deepEqual(sanitizeCampaignProgress("bad-json-shape", levelIds), createCampaignProgress());
  assert.deepEqual(sanitizeCampaignProgress({}, []), createCampaignProgress());
});
