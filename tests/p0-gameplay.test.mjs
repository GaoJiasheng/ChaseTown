import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadGameModule, readGameSource } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readGameSource(ROOT);
const game = await loadGameModule(ROOT, "p0-gameplay");

test("P0 tuning stays within the approved construction values", () => {
  assert.deepEqual(game.P0_TUNING, {
    playerSpeed: 3.7,
    villainSpeed: 3.4,
    perceptionRadius: 5.5,
    startDelayMs: 1500,
    searchHoldMs: 2500,
    villainTurnSpeed: 3.2,
    sharpTurnSpeedMultiplier: 0.45,
    playerCollisionMargin: 0.18,
    captureFreezeMs: 600,
    lineOfSightSampleStep: 0.25,
  });
});

test("P0-1 line of sight distinguishes a five-cell corridor from a five-cell wall occlusion", () => {
  const visibleA = { x: 1, y: 1 };
  const visibleB = { x: 1, y: 6 };
  const occludedA = { x: 1, y: 7 };
  const occludedB = { x: 5, y: 10 };
  assert.equal(Math.hypot(visibleA.x - visibleB.x, visibleA.y - visibleB.y), 5);
  assert.equal(Math.hypot(occludedA.x - occludedB.x, occludedA.y - occludedB.y), 5);
  assert.equal(game.hasLineOfSight(visibleA, visibleB), true);
  assert.equal(game.hasLineOfSight(occludedA, occludedB), false);
});

test("P0-1/P0-2 AI delays, chases only with LOS, searches lastKnown, then patrols", () => {
  const delay = game.planVillainAi(
    { state: "delay", lastKnown: null, searchArrivedAt: null },
    { x: 1, y: 6 },
    { x: 1, y: 1 },
    1400,
    0,
  );
  assert.equal(delay.memory.state, "delay");

  const chase = game.planVillainAi(
    delay.memory,
    { x: 1, y: 6 },
    { x: 1, y: 1 },
    1600,
    0,
  );
  assert.equal(chase.memory.state, "chase");
  assert.deepEqual(chase.memory.lastKnown, { x: 1, y: 1 });

  const search = game.planVillainAi(
    chase.memory,
    { x: 1, y: 7 },
    { x: 5, y: 10 },
    1700,
    0,
  );
  assert.equal(search.memory.state, "search");
  assert.deepEqual(search.target, { x: 1, y: 1 });

  const arrived = game.planVillainAi(search.memory, { x: 1, y: 1 }, { x: 5, y: 10 }, 2000, 0);
  assert.equal(arrived.memory.state, "search");
  assert.equal(arrived.memory.searchArrivedAt, 2000);
  assert.equal(arrived.target, null);

  const holding = game.planVillainAi(arrived.memory, { x: 1, y: 1 }, { x: 5, y: 10 }, 4499, 0);
  assert.equal(holding.memory.state, "search");
  const patrol = game.planVillainAi(arrived.memory, { x: 1, y: 1 }, { x: 5, y: 10 }, 4500, 0);
  assert.equal(patrol.memory.state, "patrol");
  assert.equal(patrol.memory.lastKnown, null);
});

test("P0-2 final spawn and patrol route preserve the full three-second observation window", () => {
  const player = { x: 1, y: 1 };
  const patrolPoints = [{ x: 7, y: 7 }, { x: 15, y: 3 }];
  let patrolIndex = 0;
  let villain = { x: 7, y: 1 };
  let heading = Math.PI / 2;
  let memory = { state: "delay", lastKnown: null, searchArrivedAt: null };
  const states = [];
  for (let now = 0; now <= 3000; now += 40) {
    const decision = game.planVillainAi(memory, villain, player, now, 0);
    memory = decision.memory;
    states.push(memory.state);
    if (memory.state === "patrol") {
      const target = patrolPoints[patrolIndex];
      const step = game.stepVillainToward(villain, target, heading, game.P0_TUNING.villainSpeed, 0.04);
      villain = step.point;
      heading = step.heading;
      if (Math.hypot(villain.x - target.x, villain.y - target.y) < 0.25) {
        patrolIndex = Math.min(patrolIndex + 1, patrolPoints.length - 1);
      }
    }
  }
  assert.equal(states.includes("chase"), false);
  assert.ok(Math.hypot(villain.x - player.x, villain.y - player.y) > game.P0_TUNING.perceptionRadius);
  assert.match(source, /const VILLAIN_START = \{ x: 7, y: 1 \}/u);
});

test("P0-3 villain heading is rate-limited and a greater-than-90-degree turn slows movement", () => {
  const result = game.stepVillainToward(
    { x: 1, y: 1 },
    { x: 7, y: 1 },
    -Math.PI / 2,
    game.P0_TUNING.villainSpeed,
    0.1,
  );
  assert.ok(Math.abs(result.heading - (-Math.PI / 2 + 0.32)) < 1e-9);
  assert.equal(result.speedMultiplier, 0.45);
  assert.ok(Math.abs(result.turnError) > Math.PI / 2);
});

test("P0-4 W maps exactly to screen-up and diagonal intent remains normalized", () => {
  const cameraGround = { x: -0.446, y: -0.595 };
  const groundLength = Math.hypot(cameraGround.x, cameraGround.y);
  const expectedUp = { x: cameraGround.x / groundLength, y: cameraGround.y / groundLength };
  const w = game.screenAlignedMove(0, -1);
  const dot = w.x * expectedUp.x + w.y * expectedUp.y;
  const angle = Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI;
  assert.ok(angle < 1e-6, `W alignment drifted by ${angle} degrees`);
  const diagonal = game.screenAlignedMove(1, -1);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-12);
});

test("P0-5 collision margin rejects wall overlap while preserving corridor centers and corners", () => {
  assert.equal(game.canPlayerOccupy(1, 5), true);
  assert.equal(game.canPlayerOccupy(1.4, 5), false);
  for (const point of [
    { x: 1, y: 1 },
    { x: 1, y: 10 },
    { x: 5, y: 10 },
    { x: 5, y: 16 },
    { x: 13, y: 16 },
    { x: 13, y: 23 },
    { x: 23, y: 23 },
  ]) {
    assert.equal(game.canPlayerOccupy(point.x, point.y), true, `route center ${point.x},${point.y} must stay reachable`);
  }
});

test("P0-6/P0-7 source contract keeps capture timing, win elapsed, countdown label and QA evidence", () => {
  assert.match(source, /phaseRef\.current === "caught"/u);
  assert.match(source, /capture-transition/u);
  assert.match(source, /用时 \$\{elapsed\}s/u);
  assert.match(source, /villainLabel/u);
  assert.match(source, /aiState/u);
  assert.match(source, /lastKnown/u);
  assert.match(source, /render:\s*\{ calls:/u);
  assert.match(source, /JSON\.stringify\(qaApi\.getState\(\)\)/u);
});
