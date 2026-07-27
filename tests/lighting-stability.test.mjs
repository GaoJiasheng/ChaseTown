import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  advanceLightBlendGain,
  advanceStableLightHandoff,
  DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS,
  sanitizeAuthoredLightIntensity,
  selectStableLightBudget,
  snapDirectionalShadowAnchor,
  steadyLightCapacityForPhysicalCapacity,
} from "../app/game/lighting-stability.ts";

const GAME_SOURCE = await readFile(
  new URL("../app/chasing-game.tsx", import.meta.url),
  "utf8",
);

const shadowInput = (x) => ({
  target: { x, y: 0, z: 0 },
  lightOffset: { x: 0, y: 12, z: 8 },
  frustumWidth: 20,
  frustumHeight: 12,
  shadowMapSize: { width: 200, height: 120 },
});

test("sub-texel target movement keeps the same fixed-bearing shadow anchor", () => {
  const first = snapDirectionalShadowAnchor(shadowInput(2.011));
  const second = snapDirectionalShadowAnchor(shadowInput(2.039));

  assert.equal(first.valid, true);
  assert.deepEqual(first.snappedTarget, second.snappedTarget);
  assert.deepEqual(first.lightForward, second.lightForward);
  assert.equal(first.texelWorldSizeX, 0.1);
  assert.equal(first.texelWorldSizeY, 0.1);
  assert.ok(first.worldError <= first.maximumWorldError + 1e-12);
  assert.ok(first.worldError <= Math.max(
    first.texelWorldSizeX,
    first.texelWorldSizeY,
  ));
});

test("crossing a shadow texel threshold changes the anchor exactly once", () => {
  const before = snapDirectionalShadowAnchor(shadowInput(2.049));
  const crossed = snapDirectionalShadowAnchor(shadowInput(2.051));
  const after = snapDirectionalShadowAnchor(shadowInput(2.089));

  assert.notDeepEqual(before.snappedTarget, crossed.snappedTarget);
  assert.deepEqual(crossed.snappedTarget, after.snappedTarget);
  assert.ok(
    Math.abs(crossed.snappedLightSpaceX - before.snappedLightSpaceX - 0.1)
      < 1e-12,
  );
  assert.deepEqual(
    {
      x: crossed.snappedLightPosition.x - crossed.snappedTarget.x,
      y: crossed.snappedLightPosition.y - crossed.snappedTarget.y,
      z: crossed.snappedLightPosition.z - crossed.snappedTarget.z,
    },
    shadowInput(0).lightOffset,
  );
});

test("shadow snapping sanitizes invalid inputs and always returns finite diagnostics", () => {
  const result = snapDirectionalShadowAnchor({
    target: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: 3 },
    lightOffset: { x: 0, y: 0, z: 0 },
    frustumWidth: -1,
    frustumHeight: Number.NaN,
    shadowMapSize: { width: 0, height: Number.POSITIVE_INFINITY },
    worldUp: { x: Number.NaN, y: 1, z: 0 },
  });

  assert.equal(result.valid, false);
  for (const vector of [
    result.snappedTarget,
    result.snappedLightPosition,
    result.lightRight,
    result.lightUp,
    result.lightForward,
  ]) {
    assert.ok(Object.values(vector).every(Number.isFinite));
  }
  for (const value of [
    result.texelWorldSizeX,
    result.texelWorldSizeY,
    result.lightSpaceX,
    result.lightSpaceY,
    result.snappedLightSpaceX,
    result.snappedLightSpaceY,
    result.worldError,
    result.maximumWorldError,
  ]) {
    assert.ok(Number.isFinite(value));
  }
});

test("light budget selection is independent from candidate input order", () => {
  const lights = [
    { id: "locker", priority: 1, score: 4 },
    { id: "pharmacy", priority: 2, score: 1 },
    { id: "triage", priority: 1, score: 7 },
    { id: "waiting", priority: 1, score: 6 },
  ];
  const options = {
    capacity: 3,
    previousSelectedIds: ["locker"],
    hysteresisMargin: 0.5,
  };
  const first = selectStableLightBudget(lights, options);
  const second = selectStableLightBudget([...lights].reverse(), options);

  assert.deepEqual(first, second);
  assert.deepEqual(first.selectedIds, ["pharmacy", "triage", "waiting"]);
});

test("hysteresis prevents equal-priority flapping but dominant scores preempt", () => {
  const held = { id: "held", priority: 1, score: 10 };
  const stable = selectStableLightBudget(
    [held, { id: "challenger", priority: 1, score: 10.49 }],
    {
      capacity: 1,
      previousSelectedIds: ["held"],
      hysteresisMargin: 0.5,
    },
  );
  const boundary = selectStableLightBudget(
    [held, { id: "challenger", priority: 1, score: 10.5 }],
    {
      capacity: 1,
      previousSelectedIds: ["held"],
      hysteresisMargin: 0.5,
    },
  );
  const preempted = selectStableLightBudget(
    [held, { id: "challenger", priority: 1, score: 10.51 }],
    {
      capacity: 1,
      previousSelectedIds: ["held"],
      hysteresisMargin: 0.5,
    },
  );
  const higherPriority = selectStableLightBudget(
    [held, { id: "hero", priority: 2, score: -100 }],
    {
      capacity: 1,
      previousSelectedIds: ["held"],
      hysteresisMargin: 999,
    },
  );

  assert.deepEqual(stable.selectedIds, ["held"]);
  assert.deepEqual(boundary.selectedIds, ["held"]);
  assert.deepEqual(preempted.selectedIds, ["challenger"]);
  assert.deepEqual(higherPriority.selectedIds, ["hero"]);
});

test("zero capacity and malformed light inputs fail safely", () => {
  assert.deepEqual(
    selectStableLightBudget(
      [{ id: "a", score: 1 }],
      { capacity: 0, previousSelectedIds: ["a"] },
    ).selectedIds,
    [],
  );
  const safe = selectStableLightBudget(
    [
      { id: "", score: 5 },
      { id: "nan", score: Number.NaN },
      { id: "disabled", score: 100, enabled: false },
      { id: "valid", score: 2, priority: Number.NaN },
      { id: "valid", score: 3 },
    ],
    { capacity: Number.NaN, hysteresisMargin: Number.POSITIVE_INFINITY },
  );
  assert.deepEqual(safe.selectedIds, []);

  const recovered = selectStableLightBudget(
    [{ id: "valid", score: 2, priority: Number.NaN }],
    { capacity: 1, hysteresisMargin: Number.NaN },
  );
  assert.deepEqual(recovered.selectedIds, ["valid"]);
});

test("light blend is monotonic, finite and frame-rate independent", () => {
  const options = { fadeInRate: 7, fadeOutRate: 5 };
  let gain = 0;
  const rise = [];
  for (let index = 0; index < 120; index += 1) {
    gain = advanceLightBlendGain(gain, true, 1 / 120, options);
    rise.push(gain);
  }
  assert.ok(rise.every(Number.isFinite));
  assert.ok(rise.every((value, index) => index === 0 || value >= rise[index - 1]));
  assert.ok(gain > 0 && gain < 1);

  const oneStep = advanceLightBlendGain(0, true, 1, options);
  const twoSteps = advanceLightBlendGain(
    advanceLightBlendGain(0, true, 0.4, options),
    true,
    0.6,
    options,
  );
  assert.ok(Math.abs(oneStep - twoSteps) < 1e-12);

  const falling = advanceLightBlendGain(gain, false, 0.2, options);
  assert.ok(falling >= 0 && falling < gain);
  assert.equal(
    advanceLightBlendGain(Number.NaN, true, Number.NaN, {
      fadeInRate: Number.POSITIVE_INFINITY,
    }),
    0,
  );
});

test("an explicit authored zero clears a budget-excluded stale source", () => {
  const excluded = {
    sourceIntensity: 1.6,
    appliedIntensity: 0,
    gain: 0,
  };
  excluded.sourceIntensity = sanitizeAuthoredLightIntensity(0);
  assert.equal(excluded.sourceIntensity, 0);

  const handoff = advanceStableLightHandoff(
    [
      {
        id: "stale-locker",
        gain: 1,
        sourceIntensity: excluded.sourceIntensity,
        enabled: excluded.sourceIntensity > 1e-4,
      },
      { id: "mission", gain: 0, sourceIntensity: 2, enabled: true },
    ],
    {
      capacity: 1,
      previousSelectedIds: ["stale-locker"],
      desiredSelectedIds: ["mission"],
      deltaSeconds: 1 / 60,
    },
  );
  assert.deepEqual(handoff.releasedIds, ["stale-locker"]);
  assert.deepEqual(handoff.admittedIds, ["mission"]);
  assert.deepEqual(handoff.selectedIds, ["mission"]);
  assert.equal(handoff.lights.find(({ id }) => id === "stale-locker")?.gain, 0);
  assert.ok(
    handoff.lights.find(({ id }) => id === "mission")?.gain
      >= DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS.handoffFloor,
  );
  assert.ok(handoff.totalAppliedIntensity > 0);
});

test("a 60 Hz unequal-intensity A-to-B handoff overlaps across frames without an energy jump", () => {
  let lights = [
    { id: "a", gain: 1, sourceIntensity: 2, enabled: true },
    { id: "b", gain: 0, sourceIntensity: 8, enabled: true },
  ];
  let selectedIds = ["a"];
  let transition = null;
  let admitFrame = null;
  let releaseFrame = null;
  let overlapFrames = 0;
  let maximumNormalizedEnergyDelta = 0;

  for (let frame = 1; frame <= 90; frame += 1) {
    const result = advanceStableLightHandoff(lights, {
      capacity: 2,
      previousSelectedIds: selectedIds,
      desiredSelectedIds: ["b"],
      previousTransition: transition,
      deltaSeconds: 1 / 60,
    });
    lights = result.lights.map(({
      id,
      gain,
      sourceIntensity,
      enabled,
    }) => ({ id, gain, sourceIntensity, enabled }));
    selectedIds = [...result.selectedIds];
    transition = result.transition;
    maximumNormalizedEnergyDelta = Math.max(
      maximumNormalizedEnergyDelta,
      Math.abs(result.appliedIntensityDelta) / 6,
    );

    assert.ok(result.selectedIds.length <= 2, `frame ${frame} exceeded physical capacity`);
    assert.ok(result.visibleIds.length <= 2, `frame ${frame} violated the visible cap`);
    assert.ok(result.totalAppliedIntensity >= 2, `frame ${frame} dipped below the darker endpoint`);
    assert.equal(result.totalGain, result.totalAppliedIntensity);
    const a = result.lights.find(({ id }) => id === "a");
    const b = result.lights.find(({ id }) => id === "b");
    if ((a?.gain ?? 0) > 0.002 && (b?.gain ?? 0) > 0.002) overlapFrames += 1;
    if (result.admittedIds.includes("b")) admitFrame = frame;
    if (result.releasedIds.includes("a")) releaseFrame = frame;
  }

  assert.ok(overlapFrames >= 20, `only ${overlapFrames} overlap frames were observed`);
  assert.ok(admitFrame && releaseFrame && admitFrame < releaseFrame);
  assert.ok(
    maximumNormalizedEnergyDelta <= 0.06,
    `source-weighted energy changed ${maximumNormalizedEnergyDelta} of the endpoint range in one frame`,
  );
  assert.deepEqual(selectedIds, ["b"]);
  assert.equal(lights.find(({ id }) => id === "a")?.gain, 0);
  assert.equal(lights.find(({ id }) => id === "b")?.gain, 1);
  assert.equal(transition, null);
});

test("physical capacity three serializes two replacements through one transient slot", () => {
  assert.equal(steadyLightCapacityForPhysicalCapacity(3), 2);
  let lights = [
    { id: "a", gain: 1, sourceIntensity: 1, enabled: true },
    { id: "c", gain: 1, sourceIntensity: 3, enabled: true },
    { id: "b", gain: 0, sourceIntensity: 4, enabled: true },
    { id: "d", gain: 0, sourceIntensity: 0.7, enabled: true },
  ];
  let selectedIds = ["a", "c"];
  let transition = null;
  let sawFirstOverlap = false;
  let sawSecondOverlap = false;
  let maximumEnergyDelta = 0;

  for (let frame = 1; frame <= 180; frame += 1) {
    const result = advanceStableLightHandoff(lights, {
      capacity: 3,
      previousSelectedIds: selectedIds,
      desiredSelectedIds: ["b", "d"],
      previousTransition: transition,
      deltaSeconds: 1 / 60,
    });
    lights = result.lights.map(({
      id,
      gain,
      sourceIntensity,
      enabled,
    }) => ({ id, gain, sourceIntensity, enabled }));
    selectedIds = [...result.selectedIds];
    transition = result.transition;
    maximumEnergyDelta = Math.max(
      maximumEnergyDelta,
      Math.abs(result.appliedIntensityDelta),
    );

    assert.ok(result.selectedIds.length <= 3, `frame ${frame} exceeded physical capacity`);
    assert.ok(result.visibleIds.length <= 3, `frame ${frame} exceeded visible capacity`);
    assert.ok(result.totalAppliedIntensity > 0, `frame ${frame} went black`);
    const gains = Object.fromEntries(result.lights.map(({ id, gain }) => [id, gain]));
    if (gains.a > 0.002 && gains.b > 0.002) sawFirstOverlap = true;
    if (gains.c > 0.002 && gains.d > 0.002) sawSecondOverlap = true;
  }

  assert.equal(sawFirstOverlap, true);
  assert.equal(sawSecondOverlap, true);
  assert.ok(
    maximumEnergyDelta / 3 <= 0.06,
    `one frame changed ${maximumEnergyDelta / 3} of the largest endpoint range`,
  );
  assert.deepEqual(new Set(selectedIds), new Set(["b", "d"]));
  assert.equal(transition, null);
  assert.equal(lights.find(({ id }) => id === "b")?.gain, 1);
  assert.equal(lights.find(({ id }) => id === "d")?.gain, 1);
});

test("capacity one uses a source-weighted no-black emergency handoff", () => {
  let lights = [
    { id: "bright-a", gain: 1, sourceIntensity: 8, enabled: true },
    { id: "dim-b", gain: 0, sourceIntensity: 1, enabled: true },
  ];
  let selectedIds = ["bright-a"];
  let swap = null;
  let maximumFractionalEnergyDelta = 0;

  for (let frame = 1; frame <= 240; frame += 1) {
    const result = advanceStableLightHandoff(lights, {
      capacity: 1,
      previousSelectedIds: selectedIds,
      desiredSelectedIds: ["dim-b"],
      deltaSeconds: 1 / 60,
    });
    lights = result.lights.map(({
      id,
      gain,
      sourceIntensity,
      enabled,
    }) => ({ id, gain, sourceIntensity, enabled }));
    selectedIds = [...result.selectedIds];
    maximumFractionalEnergyDelta = Math.max(
      maximumFractionalEnergyDelta,
      Math.abs(result.appliedIntensityDelta)
        / Math.max(
          result.previousTotalAppliedIntensity,
          result.totalAppliedIntensity,
          1e-9,
        ),
    );

    assert.equal(result.selectedIds.length, 1, `frame ${frame} lost its resident`);
    assert.equal(result.visibleIds.length, 1, `frame ${frame} violated capacity one`);
    assert.ok(result.totalAppliedIntensity > 0, `frame ${frame} went black`);
    if (result.releasedIds.includes("bright-a")) swap = result;
  }

  assert.ok(swap, "capacity-one fallback never completed");
  assert.deepEqual(swap.releasedIds, ["bright-a"]);
  assert.deepEqual(swap.admittedIds, ["dim-b"]);
  assert.ok(Math.abs(swap.appliedIntensityDelta) < 1e-9);
  assert.ok(
    maximumFractionalEnergyDelta <= 0.096,
    `one emergency frame changed ${maximumFractionalEnergyDelta * 100}% of applied energy`,
  );
  assert.deepEqual(selectedIds, ["dim-b"]);
  assert.equal(lights.find(({ id }) => id === "dim-b")?.gain, 1);
});

test("runtime uses explicit authored writes and the pure handoff authority", () => {
  assert.match(
    GAME_SOURCE,
    /const authorPerformanceLightIntensity = \([\s\S]*?entry\.sourceIntensity = sourceIntensity/u,
  );
  assert.match(
    GAME_SOURCE,
    /authorPerformanceLightIntensity\(\s*locker\.beaconLight,[\s\S]*?: 0,\s*\);/u,
  );
  assert.match(
    GAME_SOURCE,
    /const steadyCapacity = steadyLightCapacityForPhysicalCapacity\(\s*physicalCapacity,\s*\);/u,
  );
  assert.match(
    GAME_SOURCE,
    /capacity: steadyCapacity,[\s\S]*?const handoff = advanceStableLightHandoff\(/u,
  );
  assert.match(GAME_SOURCE, /const handoff = advanceStableLightHandoff\(/u);
  assert.match(
    GAME_SOURCE,
    /sourceIntensity: entry\.sourceIntensity,[\s\S]*?capacity: physicalCapacity,[\s\S]*?previousTransition: performanceLightHandoff,/u,
  );
  assert.doesNotMatch(
    GAME_SOURCE,
    /Math\.abs\(entry\.light\.intensity - entry\.appliedIntensity\)/u,
  );
});
