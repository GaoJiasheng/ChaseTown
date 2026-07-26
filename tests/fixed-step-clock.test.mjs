import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceFixedStepClock,
  createFixedStepClock,
  DEFAULT_FIXED_STEP_SECONDS,
  resetFixedStepClock,
} from "../app/game/fixed-step-clock.ts";

function advanceFrames(refreshRateHz, durationSeconds) {
  let state = createFixedStepClock();
  let producedTicks = 0;

  for (
    let frame = 0;
    frame < refreshRateHz * durationSeconds;
    frame += 1
  ) {
    const result = advanceFixedStepClock(state, 1 / refreshRateHz);
    state = result.state;
    producedTicks += result.tickCount;
  }

  return { state, producedTicks };
}

test("30, 60, 120, and 144Hz produce the same 60Hz ticks over equal time", () => {
  const tenSeconds = [30, 60, 120, 144].map((refreshRateHz) => ({
    refreshRateHz,
    ...advanceFrames(refreshRateHz, 10),
  }));

  for (const result of tenSeconds) {
    assert.equal(result.producedTicks, 600, `${result.refreshRateHz}Hz drifted`);
    assert.equal(result.state.tick, 600);
    assert.equal(result.state.remainderSeconds, 0);
  }
});

test("frame partitioning is equivalent and emitted tick ranges stay consecutive", () => {
  const frameDeltas = [
    1 / 120,
    1 / 144,
    1 / 90,
    1 / 100,
    1 / 75,
  ];
  const totalDelta = frameDeltas.reduce((sum, delta) => sum + delta, 0);

  let partitioned = createFixedStepClock({ initialTick: 40 });
  const emittedTicks = [];
  for (const delta of frameDeltas) {
    const result = advanceFixedStepClock(partitioned, delta);
    if (result.firstTick !== null) {
      for (let tick = result.firstTick; tick <= result.lastTick; tick += 1) {
        emittedTicks.push(tick);
      }
    }
    partitioned = result.state;
  }

  const combined = advanceFixedStepClock(
    createFixedStepClock({ initialTick: 40 }),
    totalDelta,
  );

  assert.equal(partitioned.tick, combined.state.tick);
  assert.ok(
    Math.abs(
      partitioned.remainderSeconds - combined.state.remainderSeconds,
    ) <= Number.EPSILON,
  );
  assert.deepEqual(
    emittedTicks,
    Array.from(
      { length: partitioned.tick - 40 },
      (_, index) => 41 + index,
    ),
  );
});

test("long frames are clamped before fixed ticks are produced", () => {
  const state = createFixedStepClock({
    maxFrameDeltaSeconds: 0.1,
  });
  const result = advanceFixedStepClock(state, 2);

  assert.equal(result.tickCount, 6);
  assert.equal(result.firstTick, 1);
  assert.equal(result.lastTick, 6);
  assert.equal(result.boundedDeltaSeconds, 0.1);
  assert.equal(result.droppedDeltaSeconds, 1.9);
  assert.ok(result.state.remainderSeconds < DEFAULT_FIXED_STEP_SECONDS);
  assert.ok(result.state.remainderSeconds >= 0);
});

test("sub-step accumulation never returns negative remainder or negative zero", () => {
  let state = createFixedStepClock();
  for (let frame = 0; frame < 144 * 60; frame += 1) {
    const result = advanceFixedStepClock(state, 1 / 144);
    state = result.state;
    assert.ok(state.remainderSeconds >= 0);
    assert.ok(state.remainderSeconds < state.fixedStepSeconds);
    assert.equal(Object.is(state.remainderSeconds, -0), false);
  }
  assert.equal(state.tick, 3_600);
  assert.equal(state.remainderSeconds, 0);
});

test("finite clocks remain stable even when their time unit is very large", () => {
  let state = createFixedStepClock({
    fixedStepSeconds: 1e300,
    maxFrameDeltaSeconds: 1e300,
  });
  state = advanceFixedStepClock(state, 5e299).state;
  const completed = advanceFixedStepClock(state, 1e300);

  assert.equal(completed.tickCount, 1);
  assert.equal(completed.state.tick, 1);
  assert.ok(Number.isFinite(completed.state.remainderSeconds));
  assert.equal(completed.state.remainderSeconds, 5e299);
});

test("create, advance, and reset are immutable", () => {
  const created = createFixedStepClock({
    fixedStepSeconds: 1 / 60,
    maxFrameDeltaSeconds: 0.2,
    initialTick: 12,
  });
  const advanced = advanceFixedStepClock(created, 1 / 120);
  const reset = resetFixedStepClock(advanced.state, 7);

  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(advanced), true);
  assert.equal(Object.isFrozen(advanced.state), true);
  assert.deepEqual(created, {
    fixedStepSeconds: 1 / 60,
    maxFrameDeltaSeconds: 0.2,
    tick: 12,
    remainderSeconds: 0,
  });
  assert.deepEqual(reset, {
    fixedStepSeconds: 1 / 60,
    maxFrameDeltaSeconds: 0.2,
    tick: 7,
    remainderSeconds: 0,
  });
});

test("invalid time, configuration, remainder, and tick values fail closed", () => {
  for (const delta of [-0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => advanceFixedStepClock(createFixedStepClock(), delta),
      /renderDeltaSeconds must be finite and non-negative/,
    );
  }

  for (const fixedStepSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createFixedStepClock({ fixedStepSeconds }),
      /fixedStepSeconds must be finite and greater than zero/,
    );
  }

  for (const maxFrameDeltaSeconds of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () => createFixedStepClock({ maxFrameDeltaSeconds }),
      /maxFrameDeltaSeconds must be finite and greater than zero/,
    );
  }

  for (const initialTick of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => createFixedStepClock({ initialTick }),
      /initialTick must be a non-negative safe integer/,
    );
  }

  const valid = createFixedStepClock();
  assert.throws(
    () => advanceFixedStepClock({
      ...valid,
      remainderSeconds: valid.fixedStepSeconds,
    }, 0),
    /remainderSeconds must be finite and in \[0, fixedStepSeconds\)/,
  );
  assert.throws(
    () => resetFixedStepClock(valid, -1),
    /initialTick must be a non-negative safe integer/,
  );
});
