import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS } from "../app/game/campaign.ts";
import { runtimeAtmosphereForLevel } from "../app/game/atmosphere.ts";

test("all ten chapters resolve to authored runtime atmosphere profiles", () => {
  const profiles = CAMPAIGN_LEVELS.map(runtimeAtmosphereForLevel);
  assert.equal(profiles.length, 10);
  for (const profile of profiles) {
    assert.ok(profile.exposure >= 0.85 && profile.exposure <= 1.1);
    assert.ok(profile.fogDensity > 0 && profile.fogDensity < 0.04);
    assert.ok(profile.particleCount >= 0);
  }
  const signatures = new Set(profiles.map((profile) => [
    profile.exposure,
    profile.fogDensity,
    profile.pulseHertz,
    profile.particleKind,
    profile.particleCount,
  ].join(":")));
  assert.equal(signatures.size, 10);
});

test("later industrial chapters carry stronger atmosphere without excessive exposure", () => {
  const training = runtimeAtmosphereForLevel(CAMPAIGN_LEVELS[6]);
  const foundry = runtimeAtmosphereForLevel(CAMPAIGN_LEVELS[9]);
  assert.equal(training.particleKind, "embers");
  assert.equal(foundry.particleKind, "embers");
  assert.ok(CAMPAIGN_LEVELS
    .slice(0, 3)
    .map(runtimeAtmosphereForLevel)
    .every((profile) => foundry.bounceIntensity > profile.bounceIntensity));
  assert.ok(foundry.exposure <= 0.95);
});
