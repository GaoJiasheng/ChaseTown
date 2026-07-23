import assert from "node:assert/strict";
import test from "node:test";

import {
  assistedGameplayConfig,
  DEFAULT_GAMEPLAY_PREFERENCES,
  loadGameplayPreferences,
  playHapticCue,
  sanitizeGameplayPreferences,
  saveGameplayPreferences,
} from "../app/game/gameplay-preferences.ts";

class MemoryStorage {
  value = null;

  getItem() {
    return this.value;
  }

  setItem(_key, value) {
    this.value = value;
  }
}

test("gameplay preferences migrate conservatively and persist", () => {
  assert.deepEqual(sanitizeGameplayPreferences(null), DEFAULT_GAMEPLAY_PREFERENCES);
  const sanitized = sanitizeGameplayPreferences({
    ruleset: "assisted",
    personalGhostEnabled: false,
    hudDensity: "full",
    hapticsEnabled: false,
    highContrast: true,
    reducedMotion: true,
    ignored: "foreign",
  });
  assert.equal(sanitized.ruleset, "assisted");
  assert.equal(sanitized.personalGhostEnabled, false);
  assert.equal(sanitized.highContrast, true);

  const storage = new MemoryStorage();
  assert.equal(saveGameplayPreferences(storage, sanitized), true);
  assert.deepEqual(loadGameplayPreferences(storage), sanitized);
  storage.value = "{broken";
  assert.deepEqual(loadGameplayPreferences(storage), DEFAULT_GAMEPLAY_PREFERENCES);
});

test("assisted config eases only public gameplay knobs", () => {
  const standard = {
    fixedStepSeconds: 1 / 60,
    playerSpeed: 2.64,
    chaserSpeed: 2.4,
    spawnDelaySeconds: 0.5,
    suspiciousSeconds: 0.15,
    searchSeconds: 7,
    searchWaypointSeconds: 0.65,
    searchHideCheckBudget: 2,
    hearingRange: 8,
    visionRange: 9,
    hideInteractRange: 1,
    hideEnterSeconds: 1.8,
    hideEnterExposureSeconds: 1.4,
    hideExitSeconds: 1.5,
    hideExitExposureSeconds: 0.3,
  };
  const assisted = assistedGameplayConfig(standard);
  assert.equal(assisted.fixedStepSeconds, standard.fixedStepSeconds);
  assert.equal(assisted.playerSpeed, standard.playerSpeed);
  assert.ok(assisted.chaserSpeed < standard.chaserSpeed);
  assert.ok(assisted.spawnDelaySeconds > standard.spawnDelaySeconds);
  assert.ok(assisted.suspiciousSeconds > standard.suspiciousSeconds);
  assert.ok(assisted.searchSeconds < standard.searchSeconds);
  assert.equal(assisted.searchHideCheckBudget, 1);
  assert.ok(assisted.hearingRange < standard.hearingRange);
  assert.ok(assisted.visionRange < standard.visionRange);
  assert.ok(assisted.hideEnterSeconds < standard.hideEnterSeconds);
});

test("haptics are opt-in safe and use semantic patterns", () => {
  const calls = [];
  assert.equal(playHapticCue("detected", false, (pattern) => {
    calls.push(pattern);
    return true;
  }), false);
  assert.equal(calls.length, 0);
  assert.equal(playHapticCue("detected", true, (pattern) => {
    calls.push(pattern);
    return true;
  }), true);
  assert.deepEqual(calls, [[50, 28, 70]]);
  assert.equal(playHapticCue("escaped", true, undefined), false);
});
