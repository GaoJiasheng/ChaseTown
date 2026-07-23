import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_LEVELS,
  getCampaignHideGuidancePolicy,
} from "../app/game/campaign.ts";
import { recommendHideSpot } from "../app/game/hide-guidance.ts";
import { createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";

function levelFromRows(rows, options = {}) {
  const walkable = rows.map((row) => [...row].map((cell) => cell !== "#"));
  const first = (() => {
    for (let y = 0; y < walkable.length; y += 1) {
      const x = walkable[y].indexOf(true);
      if (x >= 0) return { x, y };
    }
    throw new Error("test level has no floor");
  })();
  return createLevel({
    id: options.id ?? "hide-guidance-test",
    width: walkable[0].length,
    height: walkable.length,
    walkable,
    playerStart: options.playerStart ?? first,
    exit: options.exit ?? first,
    chaserStart: options.chaserStart ?? first,
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [options.chaserStart ?? first],
    hideSpots: options.hideSpots ?? [],
  });
}

const guidanceInput = (overrides = {}) => ({
  playerPosition: { x: 0, y: 0 },
  nowSeconds: 10,
  playerSpeed: DEFAULT_GAME_CONFIG.playerSpeed,
  chaserSpeed: DEFAULT_GAME_CONFIG.chaserSpeed,
  hideEnterExposureSeconds: DEFAULT_GAME_CONFIG.hideEnterExposureSeconds,
  ...overrides,
});

test("the first three chapters expose regression-certified tutorial lockers only", () => {
  const policies = CAMPAIGN_LEVELS.map(getCampaignHideGuidancePolicy);
  assert.deepEqual(
    policies.slice(0, 3).map((policy) => policy.tutorialHideSpotId),
    ["locker-north", "library-map-case", "science-chemical-cabinet"],
  );
  assert.ok(policies.slice(3).every((policy) => policy.tutorialHideSpotId === null));
});

test("first-clear tutorial guidance overrides geometric nearest without hiding its risk", () => {
  const level = levelFromRows(["......."], {
    exit: { x: 6, y: 0 },
    chaserStart: { x: 6, y: 0 },
    hideSpots: [
      { id: "nearest", approach: { x: 1, y: 0 }, concealed: { x: 1, y: 0 }, facing: { x: 1, y: 0 } },
      { id: "certified", approach: { x: 5, y: 0 }, concealed: { x: 5, y: 0 }, facing: { x: -1, y: 0 } },
    ],
  });
  const result = recommendHideSpot(level, guidanceInput({
    tutorialHideSpotId: "certified",
    knownChaser: { position: { x: 6, y: 0 }, observedAtSeconds: 9.9 },
  }));
  assert.equal(result.selection, "tutorial");
  assert.equal(result.recommended.hideSpotId, "certified");
  assert.equal(result.recommended.risk, "high");
  assert.equal(result.recommended.reasons.includes("tutorial-certified"), true);
  assert.equal(result.candidates[0].hideSpotId, "nearest", "candidate ordering remains honest");
});

test("post-tutorial selection is nearest by navigable route with deterministic tie-breaking", () => {
  const level = levelFromRows([
    "...",
    "...",
    "...",
  ], {
    playerStart: { x: 1, y: 1 },
    exit: { x: 2, y: 2 },
    chaserStart: { x: 2, y: 2 },
    hideSpots: [
      { id: "z-right", approach: { x: 2, y: 1 }, concealed: { x: 2, y: 1 }, facing: { x: -1, y: 0 } },
      { id: "a-left", approach: { x: 0, y: 1 }, concealed: { x: 0, y: 1 }, facing: { x: 1, y: 0 } },
    ],
  });
  const input = guidanceInput({ playerPosition: { x: 1, y: 1 } });
  assert.deepEqual(recommendHideSpot(level, input), recommendHideSpot(level, input));
  assert.equal(recommendHideSpot(level, input).recommended.hideSpotId, "a-left");
  assert.equal(recommendHideSpot(level, input).selection, "nearest");
});

test("risk uses only fresh player-known evidence and preserves uncertainty", () => {
  const highLevel = levelFromRows(["......."], {
    exit: { x: 6, y: 0 },
    chaserStart: { x: 4, y: 0 },
    hideSpots: [
      { id: "visible", approach: { x: 5, y: 0 }, concealed: { x: 5, y: 0 }, facing: { x: -1, y: 0 } },
    ],
  });
  const fresh = recommendHideSpot(highLevel, guidanceInput({
    knownChaser: { position: { x: 4, y: 0 }, observedAtSeconds: 9.9 },
  }));
  assert.equal(fresh.recommended.risk, "high");
  assert.equal(fresh.recommended.reasons.includes("known-line-of-sight"), true);

  const unknown = recommendHideSpot(highLevel, guidanceInput({ knownChaser: null }));
  assert.equal(unknown.recommended.risk, "medium");
  assert.deepEqual(unknown.recommended.reasons, ["unknown-chaser"]);

  const stale = recommendHideSpot(highLevel, guidanceInput({
    knownChaser: { position: { x: 4, y: 0 }, observedAtSeconds: 1 },
  }));
  assert.equal(stale.recommended.risk, "medium");
  assert.deepEqual(stale.recommended.reasons, ["stale-chaser-evidence"]);

  const lowLevel = levelFromRows([
    ".......",
    ".#####.",
    ".......",
  ], {
    playerStart: { x: 4, y: 2 },
    exit: { x: 6, y: 2 },
    chaserStart: { x: 0, y: 0 },
    hideSpots: [
      { id: "screened", approach: { x: 6, y: 2 }, concealed: { x: 6, y: 2 }, facing: { x: -1, y: 0 } },
    ],
  });
  const screened = recommendHideSpot(lowLevel, guidanceInput({
    playerPosition: { x: 4, y: 2 },
    playerSpeed: 3,
    chaserSpeed: 1,
    hideEnterExposureSeconds: 0.2,
    knownChaser: { position: { x: 0, y: 0 }, observedAtSeconds: 9.9 },
  }));
  assert.equal(screened.recommended.risk, "low");
  assert.deepEqual(screened.recommended.reasons, ["known-chaser-distant"]);
});
