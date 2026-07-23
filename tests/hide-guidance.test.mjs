import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_LEVELS,
  getCampaignHideGuidancePolicy,
} from "../app/game/campaign.ts";
import {
  planHideGuidance,
  recommendHideSpot,
  stabilizeHideGuidance,
} from "../app/game/hide-guidance.ts";
import { createLevel, DEFAULT_GAME_CONFIG } from "../app/game/level.ts";
import { findPath, hasLineOfSight } from "../app/game/navigation.ts";

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
  interactionBufferSeconds: 0,
  ...overrides,
});

const riskRank = { low: 0, medium: 1, high: 2 };

test("the first three chapters expose regression-certified tutorial lockers only", () => {
  const policies = CAMPAIGN_LEVELS.map(getCampaignHideGuidancePolicy);
  assert.deepEqual(
    policies.slice(0, 3).map((policy) => policy.tutorialHideSpotId),
    ["locker-north", "library-map-case", "science-chemical-cabinet"],
  );
  assert.ok(policies.slice(3).every((policy) => policy.tutorialHideSpotId === null));
});

test("survivability beats proximity and an unsafe tutorial preference", () => {
  const level = levelFromRows([
    ".........",
    "....#....",
    ".........",
  ], {
    playerStart: { x: 3, y: 0 },
    exit: { x: 8, y: 2 },
    chaserStart: { x: 8, y: 0 },
    hideSpots: [
      { id: "near-visible", approach: { x: 5, y: 0 }, concealed: { x: 5, y: 0 }, facing: { x: -1, y: 0 } },
      { id: "far-screened", approach: { x: 1, y: 2 }, concealed: { x: 1, y: 2 }, facing: { x: 1, y: 0 } },
    ],
  });
  const plan = planHideGuidance(level, guidanceInput({
    playerPosition: level.playerStart,
    playerSpeed: 3,
    chaserSpeed: 1,
    hideEnterExposureSeconds: 0.2,
    tutorialHideSpotId: "near-visible",
    knownChaser: {
      position: level.chaserStart,
      playerPositionAtObservation: level.playerStart,
      observedAtSeconds: 9.9,
    },
  }));

  assert.equal(plan.strategy, "hide");
  assert.equal(plan.selection, "survivability");
  assert.equal(plan.recommended.hideSpotId, "far-screened");
  assert.equal(plan.recommended.risk, "low");
  assert.equal(plan.candidates.find((candidate) => candidate.hideSpotId === "near-visible").risk, "high");
});

test("tutorial preference applies only inside the safest risk tier", () => {
  const level = levelFromRows(["....."], {
    playerStart: { x: 2, y: 0 },
    exit: { x: 4, y: 0 },
    chaserStart: { x: 4, y: 0 },
    hideSpots: [
      { id: "a-near", approach: { x: 1, y: 0 }, concealed: { x: 1, y: 0 }, facing: { x: 1, y: 0 } },
      { id: "tutorial", approach: { x: 0, y: 0 }, concealed: { x: 0, y: 0 }, facing: { x: 1, y: 0 } },
    ],
  });
  const plan = planHideGuidance(level, guidanceInput({
    playerPosition: level.playerStart,
    knownChaser: null,
    tutorialHideSpotId: "tutorial",
  }));
  assert.equal(plan.strategy, "hide");
  assert.equal(plan.selection, "tutorial");
  assert.equal(plan.recommended.hideSpotId, "tutorial");
  assert.ok(plan.recommended.reasons.includes("tutorial-certified"));
});

test("all high-risk lockers return an explicit cover strategy and no legacy locker arrow", () => {
  const level = levelFromRows([
    ".......",
    "###.###",
    ".......",
  ], {
    playerStart: { x: 1, y: 0 },
    exit: { x: 6, y: 2 },
    chaserStart: { x: 6, y: 0 },
    hideSpots: [
      { id: "visible-a", approach: { x: 4, y: 0 }, concealed: { x: 4, y: 0 }, facing: { x: -1, y: 0 } },
      { id: "visible-b", approach: { x: 5, y: 0 }, concealed: { x: 5, y: 0 }, facing: { x: -1, y: 0 } },
    ],
  });
  const input = guidanceInput({
    playerPosition: level.playerStart,
    knownChaser: {
      position: level.chaserStart,
      playerPositionAtObservation: level.playerStart,
      observedAtSeconds: 9.9,
    },
  });
  const plan = planHideGuidance(level, input);
  assert.equal(plan.strategy, "break-line-of-sight");
  assert.equal(plan.reason, "no-survivable-hide");
  assert.equal(plan.recommended, null);
  assert.ok(plan.candidates.every((candidate) => candidate.risk === "high"));
  assert.equal(recommendHideSpot(level, input), null);
  if (plan.waypoint) {
    assert.ok(findPath(level, level.playerStart, plan.waypoint).length > 1);
    assert.equal(hasLineOfSight(level, level.chaserStart, plan.waypoint), false);
  }
});

test("unknown and stale evidence remain uncertain while evidence age erodes interception margin", () => {
  const level = levelFromRows([
    ".........",
    "....#....",
    ".........",
  ], {
    playerStart: { x: 3, y: 0 },
    exit: { x: 8, y: 2 },
    chaserStart: { x: 8, y: 0 },
    hideSpots: [
      { id: "screened", approach: { x: 1, y: 2 }, concealed: { x: 1, y: 2 }, facing: { x: 1, y: 0 } },
    ],
  });
  const unknown = planHideGuidance(level, guidanceInput({
    playerPosition: level.playerStart,
    knownChaser: null,
  }));
  const stale = planHideGuidance(level, guidanceInput({
    playerPosition: level.playerStart,
    knownChaser: { position: level.chaserStart, observedAtSeconds: 1 },
  }));
  const fresh = planHideGuidance(level, guidanceInput({
    playerPosition: level.playerStart,
    nowSeconds: 10,
    knownChaser: { position: level.chaserStart, observedAtSeconds: 10 },
  }));
  const aged = planHideGuidance(level, guidanceInput({
    playerPosition: level.playerStart,
    nowSeconds: 10,
    knownChaser: { position: level.chaserStart, observedAtSeconds: 8 },
  }));

  assert.equal(unknown.candidates[0].risk, "medium");
  assert.deepEqual(unknown.candidates[0].reasons, ["unknown-chaser"]);
  assert.equal(stale.candidates[0].risk, "medium");
  assert.deepEqual(stale.candidates[0].reasons, ["stale-chaser-evidence"]);
  assert.ok(aged.candidates[0].interceptMarginSeconds < fresh.candidates[0].interceptMarginSeconds);
});

test("light-step pace never receives a safer assessment than sprint pace", () => {
  const level = levelFromRows([
    ".........",
    "....#....",
    ".........",
  ], {
    playerStart: { x: 3, y: 0 },
    exit: { x: 8, y: 2 },
    chaserStart: { x: 8, y: 0 },
    hideSpots: [
      { id: "screened", approach: { x: 1, y: 2 }, concealed: { x: 1, y: 2 }, facing: { x: 1, y: 0 } },
    ],
  });
  const base = {
    playerPosition: level.playerStart,
    knownChaser: { position: level.chaserStart, observedAtSeconds: 9.9 },
    chaserSpeed: 1.5,
    hideEnterExposureSeconds: 0.2,
  };
  const sprint = planHideGuidance(level, guidanceInput({ ...base, playerSpeed: 3 }));
  const lightStep = planHideGuidance(level, guidanceInput({ ...base, playerSpeed: 3 * 0.58 }));
  const sprintCandidate = sprint.candidates[0];
  const lightStepCandidate = lightStep.candidates[0];
  assert.ok(lightStepCandidate.playerArrivalSeconds > sprintCandidate.playerArrivalSeconds);
  assert.ok(lightStepCandidate.interceptMarginSeconds < sprintCandidate.interceptMarginSeconds);
  assert.ok(riskRank[lightStepCandidate.risk] >= riskRank[sprintCandidate.risk]);
});

function syntheticCandidate(id, overrides = {}) {
  return Object.freeze({
    hideSpotId: id,
    routeDistanceCells: 4,
    playerArrivalSeconds: 2,
    chaserArrivalSeconds: 5,
    interceptMarginSeconds: 3,
    breaksKnownLineOfSight: true,
    lineOfSightBreakSeconds: 0.4,
    lineOfSightBreakPoint: { x: 1, y: 1 },
    coveredRouteCells: 4,
    risk: "low",
    reasons: Object.freeze(["known-chaser-distant"]),
    ...overrides,
  });
}

test("pure hysteresis holds equivalent targets, switches for safety, and completes cover first", () => {
  const a = syntheticCandidate("a", { interceptMarginSeconds: 3 });
  const b = syntheticCandidate("b", { interceptMarginSeconds: 4 });
  const planB = Object.freeze({
    strategy: "hide",
    selection: "survivability",
    recommended: b,
    candidates: Object.freeze([b, a]),
  });
  const previous = Object.freeze({ kind: "hide", hideSpotId: "a", selectedAtSeconds: 10 });

  const held = stabilizeHideGuidance(planB, previous, 10.5);
  assert.equal(held.plan.recommended.hideSpotId, "a");
  assert.equal(held.plan.selection, "held");
  assert.equal(held.switched, false);

  const switched = stabilizeHideGuidance(planB, previous, 11.3);
  assert.equal(switched.plan.recommended.hideSpotId, "b");
  assert.equal(switched.switched, true);

  const mediumA = syntheticCandidate("a", { risk: "medium", interceptMarginSeconds: 1 });
  const saferPlan = Object.freeze({
    ...planB,
    recommended: b,
    candidates: Object.freeze([b, mediumA]),
  });
  assert.equal(
    stabilizeHideGuidance(saferPlan, previous, 10.1).plan.recommended.hideSpotId,
    "b",
  );

  const breakPlan = Object.freeze({
    strategy: "break-line-of-sight",
    reason: "no-survivable-hide",
    waypoint: Object.freeze({ x: 3, y: 0 }),
    recommended: null,
    candidates: Object.freeze([syntheticCandidate("unsafe", { risk: "high" })]),
  });
  const evasion = stabilizeHideGuidance(breakPlan, null, 20, {
    playerPosition: { x: 0, y: 0 },
  });
  const prematureHide = stabilizeHideGuidance(planB, evasion.targetState, 20.5, {
    playerPosition: { x: 1, y: 0 },
  });
  assert.equal(prematureHide.plan.strategy, "break-line-of-sight");
  const coverReached = stabilizeHideGuidance(planB, evasion.targetState, 21, {
    playerPosition: { x: 3, y: 0 },
  });
  assert.equal(coverReached.plan.strategy, "hide");
});
