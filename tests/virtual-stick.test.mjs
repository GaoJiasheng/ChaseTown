import assert from "node:assert/strict";
import test from "node:test";

import {
  combineScreenMove,
  sampleVirtualStick,
} from "../app/game/virtual-stick.ts";

test("virtual stick applies a radial dead zone and preserves screen directions", () => {
  assert.deepEqual(
    sampleVirtualStick({ x: 100, y: 100 }, { x: 104, y: 104 }, 50),
    { x: 0, y: 0, strength: 0, thumbX: 0, thumbY: 0 },
  );
  const right = sampleVirtualStick({ x: 100, y: 100 }, { x: 125, y: 100 }, 50);
  assert.ok(right.x > 0);
  assert.equal(right.y, 0);
  assert.equal(right.thumbX, 25);
  const up = sampleVirtualStick({ x: 100, y: 100 }, { x: 100, y: 70 }, 50);
  assert.equal(up.x, 0);
  assert.ok(up.y < 0);
  assert.equal(up.thumbY, -30);
});

test("virtual stick clamps pointer capture outside the base without changing direction", () => {
  const sampled = sampleVirtualStick({ x: 0, y: 0 }, { x: 300, y: 400 }, 50);
  assert.equal(sampled.strength, 1);
  assert.equal(Math.round(sampled.thumbX), 30);
  assert.equal(Math.round(sampled.thumbY), 40);
  assert.equal(Math.round(Math.hypot(sampled.x, sampled.y) * 100), 100);
});

test("keyboard and analogue intent cannot create diagonal speed boosts", () => {
  assert.deepEqual(combineScreenMove({ x: 0, y: 0 }, { x: 0.4, y: -0.2 }), {
    x: 0.4,
    y: -0.2,
  });
  const combined = combineScreenMove({ x: 1, y: 0 }, { x: 0, y: -1 });
  assert.ok(Math.abs(Math.hypot(combined.x, combined.y) - 1) < 1e-12);
  assert.ok(combined.x > 0 && combined.y < 0);
});
