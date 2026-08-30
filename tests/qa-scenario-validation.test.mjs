import assert from "node:assert/strict";
import test from "node:test";
import { validateQaScenario } from "../app/game/qa-scenario.ts";

test("QA scenarios accept finite public positions with a normalized delay", () => {
  assert.deepEqual(validateQaScenario({
    player: { x: 1, y: 2 },
    chaser: { x: 3, y: 4 },
    chaserHeading: { x: 0, y: 1 },
    spawnDelaySeconds: 5,
  }), {
    ok: true,
    value: {
      player: { x: 1, y: 2 },
      chaser: { x: 3, y: 4 },
      chaserHeading: { x: 0, y: 1 },
      spawnDelaySeconds: 5,
    },
  });
});

test("QA scenario validation rejects symbolic and non-finite headings without throwing", () => {
  const base = { player: { x: 1, y: 2 }, chaser: { x: 3, y: 4 } };
  assert.deepEqual(validateQaScenario({ ...base, chaserHeading: "toPlayer" }), {
    ok: false,
    error: "QA scenario chaserHeading must be a finite { x, y } point.",
  });
  assert.deepEqual(validateQaScenario({ ...base, chaserHeading: { x: Number.NaN, y: 0 } }), {
    ok: false,
    error: "QA scenario chaserHeading must be a finite { x, y } point.",
  });
});

test("QA scenario validation rejects malformed positions and delays before simulation", () => {
  assert.deepEqual(validateQaScenario({ player: null, chaser: { x: 0, y: 0 } }), {
    ok: false,
    error: "QA scenario player must be a finite { x, y } point.",
  });
  assert.deepEqual(validateQaScenario({
    player: { x: 0, y: 0 },
    chaser: { x: 1, y: 1 },
    spawnDelaySeconds: Number.POSITIVE_INFINITY,
  }), {
    ok: false,
    error: "QA scenario spawnDelaySeconds must be a finite non-negative number.",
  });
});
