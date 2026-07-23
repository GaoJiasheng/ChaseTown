import assert from "node:assert/strict";
import test from "node:test";

import {
  sampleThemeMechanic,
  THEME_MECHANIC_PROFILES,
  themeMechanicProfile,
} from "../app/game/theme-mechanics.ts";

test("every theme exposes a bounded periodic mechanic with player-facing copy", () => {
  for (const theme of ["campus", "hospital", "fire-station", "factory"]) {
    const profile = themeMechanicProfile(theme);
    const sample = sampleThemeMechanic(theme, profile.activeStartSeconds + profile.activeDurationSeconds / 2);
    assert.equal(sample.active, true);
    assert.ok(sample.progress > 0 && sample.progress < 1);
    assert.ok(sample.label.length > 0);
    assert.ok(sample.hudHint.length > 0);
    assert.ok(sample.soundMasking >= 0 && sample.soundMasking <= 1);
    assert.ok(sample.visionRangeMultiplier >= profile.minimumVisionRangeMultiplier - 1e-12);
    assert.ok(sample.visionRangeMultiplier <= 1);
  }
});

test("theme mechanic boundaries are deterministic and do not leave a stale effect", () => {
  const campus = themeMechanicProfile("campus");
  const justBefore = sampleThemeMechanic("campus", campus.activeStartSeconds - 1e-8);
  const atStart = sampleThemeMechanic("campus", campus.activeStartSeconds);
  const atEnd = sampleThemeMechanic("campus", campus.activeStartSeconds + campus.activeDurationSeconds);
  assert.equal(justBefore.active, false);
  assert.equal(atStart.active, true);
  assert.equal(atStart.progress, 0);
  assert.equal(atEnd.active, false);
  assert.equal(atEnd.soundMasking, 0);
  assert.equal(atEnd.visionRangeMultiplier, 1);
  assert.deepEqual(
    sampleThemeMechanic("campus", campus.activeStartSeconds + 1.25),
    sampleThemeMechanic("campus", campus.activeStartSeconds + 1.25),
  );
  assert.deepEqual(
    sampleThemeMechanic("campus", campus.activeStartSeconds + 1.25),
    sampleThemeMechanic("campus", campus.cycleSeconds + campus.activeStartSeconds + 1.25),
  );
});

test("themes remain mechanically distinct without invalid low-vision states", () => {
  const samples = Object.entries(THEME_MECHANIC_PROFILES).map(([theme, profile]) => ({
    theme,
    profile,
    sample: sampleThemeMechanic(theme, profile.activeStartSeconds + profile.activeDurationSeconds / 2),
  }));
  assert.equal(new Set(samples.map(({ profile }) => profile.kind)).size, samples.length);
  assert.equal(new Set(samples.map(({ sample }) => sample.label)).size, samples.length);
  assert.ok(samples.some(({ sample }) => sample.soundMasking >= 0.5), "factory must create a meaningful audio window");
  assert.ok(samples.some(({ sample }) => sample.visionRangeMultiplier <= 0.7), "smoke must create a meaningful sight window");

  for (const theme of ["campus", "hospital", "fire-station", "factory"]) {
    const malformed = sampleThemeMechanic(theme, Number.NaN);
    assert.equal(malformed.active, theme === "factory", "non-finite time resolves deterministically to cycle start");
    assert.ok(malformed.soundMasking >= 0 && malformed.soundMasking <= 1);
    assert.ok(malformed.visionRangeMultiplier >= 0.65);
  }
});
