import assert from "node:assert/strict";
import test from "node:test";

import {
  createObjectiveGuidanceState,
  deriveRouteGuidanceGeometry,
  updateObjectiveGuidance,
} from "../app/game/navigation-guidance.ts";

const turn = { direction: { x: 1, y: 0 }, distanceMeters: 4 };

const sample = (state, overrides = {}) => updateObjectiveGuidance(state, {
  deltaSeconds: 0.25,
  routeDistanceMeters: 10,
  movement: { x: 1, y: 0 },
  routeDirection: { x: 1, y: 0 },
  nextTurn: turn,
  ...overrides,
});

test("route geometry exposes distance, immediate leg and only the first legal turn", () => {
  assert.deepEqual(deriveRouteGuidanceGeometry([
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 3, y: 2 },
    { x: 3, y: 3 },
  ], 2), {
    routeDistanceMeters: 8,
    routeDirection: { x: 1, y: 0 },
    nextTurn: {
      direction: { x: 0, y: 1 },
      distanceMeters: 4,
    },
  });
  assert.deepEqual(deriveRouteGuidanceGeometry([{ x: 1, y: 1 }], 2), {
    routeDistanceMeters: 0,
    routeDirection: null,
    nextTurn: null,
  });
});

test("objective guidance stays direct while normal route progress repeatedly clears the stall timer", () => {
  let result = sample(createObjectiveGuidanceState(), { routeDistanceMeters: 10 });
  for (let distance = 9.9; distance >= 7; distance -= 0.1) {
    result = sample(result.state, { routeDistanceMeters: distance });
    assert.equal(result.mode, "direct");
    assert.equal(result.nextTurn, null);
  }
});

test("objective guidance escalates only after sustained wrong-way or stalled movement", () => {
  let result = sample(createObjectiveGuidanceState(), {
    movement: { x: -1, y: 0 },
    wrongDirectionThresholdSeconds: 0.8,
  });
  for (let step = 0; step < 2; step += 1) {
    result = sample(result.state, {
      movement: { x: -1, y: 0 },
      wrongDirectionThresholdSeconds: 0.8,
    });
  }
  assert.equal(result.mode, "direct", "three quarter-seconds must not cause a one-sample hint");
  result = sample(result.state, {
    movement: { x: -1, y: 0 },
    wrongDirectionThresholdSeconds: 0.8,
  });
  assert.equal(result.mode, "next-turn");
  assert.equal(result.nextTurn, turn);

  let stalled = sample(createObjectiveGuidanceState(), { noProgressThresholdSeconds: 1 });
  for (let step = 0; step < 3; step += 1) {
    stalled = sample(stalled.state, { noProgressThresholdSeconds: 1 });
  }
  assert.equal(stalled.mode, "next-turn");
});

test("next-turn hint has recovery hysteresis and never activates without a legal route cue", () => {
  let result = sample(createObjectiveGuidanceState(), {
    movement: { x: -1, y: 0 },
    wrongDirectionThresholdSeconds: 0.25,
    recoveryThresholdSeconds: 0.65,
  });
  assert.equal(result.mode, "next-turn");

  result = sample(result.state, {
    routeDistanceMeters: 9.5,
    recoveryThresholdSeconds: 0.65,
  });
  assert.equal(result.mode, "next-turn", "one correct sample must not flicker the guidance off");
  result = sample(result.state, {
    routeDistanceMeters: 9,
    recoveryThresholdSeconds: 0.65,
  });
  result = sample(result.state, {
    routeDistanceMeters: 8.5,
    recoveryThresholdSeconds: 0.65,
  });
  assert.equal(result.mode, "direct", "sustained route progress clears the escalation");

  let noRoute = sample(createObjectiveGuidanceState(), {
    movement: { x: -1, y: 0 },
    wrongDirectionThresholdSeconds: 0.25,
    nextTurn: null,
  });
  noRoute = sample(noRoute.state, {
    movement: { x: -1, y: 0 },
    wrongDirectionThresholdSeconds: 0.25,
    nextTurn: null,
  });
  assert.equal(noRoute.mode, "direct");
});
