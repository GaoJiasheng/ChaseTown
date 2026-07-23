import assert from "node:assert/strict";
import test from "node:test";

import { pairedHidePresentationPoint } from "../app/game/hide-performance.ts";

const base = {
  playerPosition: { x: 5, y: 5 },
  approach: { x: 5, y: 5 },
  lockerAnchor: { x: 5, y: 4.65 },
  facing: { x: 0, y: 1 },
  transitionDurationSeconds: 1.8,
};

test("paired hide path settles the actor behind the door plane", () => {
  const hidden = pairedHidePresentationPoint({
    ...base,
    mode: "hidden",
    transitionRemainingSeconds: 0,
  });
  assert.deepEqual(hidden, { x: 5, y: 4.53 });
});

test("entry and exit use the same side-step corridor in reverse", () => {
  const entering = pairedHidePresentationPoint({
    ...base,
    mode: "entering-hide",
    transitionRemainingSeconds: 0.9,
  });
  const exiting = pairedHidePresentationPoint({
    ...base,
    mode: "exiting-hide",
    transitionRemainingSeconds: 0.9,
  });
  assert.ok(entering.x > 5);
  assert.ok(exiting.x > 5);
  assert.ok(Math.abs((entering.y + exiting.y) - (base.approach.y + 4.53)) < 1e-9);
});

test("free movement remains owned by simulation", () => {
  assert.deepEqual(pairedHidePresentationPoint({
    ...base,
    mode: "free",
    transitionRemainingSeconds: 0,
  }), base.playerPosition);
});
