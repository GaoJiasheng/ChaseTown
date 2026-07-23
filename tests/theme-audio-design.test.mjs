import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  renderThemeIdentityPcm,
  themeAudioIdentityProfile,
  themeRhythmicOnsets,
  themeSpectralCentroidHertz,
  threatLayerMixForMode,
} from "../app/game/audio/theme-audio-design.ts";

const THEMES = ["campus", "hospital", "fire-station", "factory"];

test("four campaign identities have unique spectral, tempo, and rhythm fingerprints", () => {
  const profiles = THEMES.map((theme) => themeAudioIdentityProfile(theme));
  assert.equal(new Set(profiles.map(({ instrumentIdentity }) => instrumentIdentity)).size, 4);
  assert.equal(new Set(profiles.map(({ mechanicIdentity }) => mechanicIdentity)).size, 4);
  assert.equal(new Set(profiles.map(({ tempoBpm }) => tempoBpm)).size, 4);
  assert.equal(
    new Set(profiles.map(({ rhythmPattern }) => rhythmPattern.join(","))).size,
    4,
  );
  assert.equal(
    new Set(THEMES.map((theme) => themeSpectralCentroidHertz(theme).toFixed(3))).size,
    4,
  );
  assert.equal(
    new Set(THEMES.map((theme) => {
      const onsets = themeRhythmicOnsets(theme);
      return onsets.slice(1).map((onset, index) => (
        onset - onsets[index]
      ).toFixed(3)).join(",");
    })).size,
    4,
  );

  for (const profile of profiles) {
    assert.equal(profile.rhythmPattern.length, profile.noteSequence.length);
    assert.ok(profile.partials.length >= 3, "identity must be a material spectrum, not one tone");
    assert.ok(profile.outputGain > 0 && profile.outputGain < 0.01);
    assert.ok(profile.rhythmPattern.filter((accent) => accent > 0).length >= 4);
  }
});

test("rendered theme loops are deterministic, bounded, distinct, and seam-safe", () => {
  const signatures = new Set();
  for (const theme of THEMES) {
    const first = renderThemeIdentityPcm(theme, 4_000, 4);
    const second = renderThemeIdentityPcm(theme, 4_000, 4);
    assert.deepEqual(first.samples, second.samples);
    assert.deepEqual(first.onsetsSeconds, second.onsetsSeconds);
    assert.ok(first.durationSeconds >= 4);
    assert.ok(first.onsetsSeconds.length >= 4);
    assert.ok(first.samples.every(Number.isFinite));
    const peak = first.samples.reduce(
      (maximum, sample) => Math.max(maximum, Math.abs(sample)),
      0,
    );
    const rms = Math.sqrt(
      first.samples.reduce((sum, sample) => sum + sample * sample, 0)
        / first.samples.length,
    );
    assert.ok(peak > 0.6 && peak <= 0.721);
    assert.ok(rms > 0.015 && rms < 0.4);
    assert.ok(Math.abs(first.samples[0]) < 1e-8);
    assert.ok(Math.abs(first.samples.at(-1)) < 1e-8);
    const stride = Math.max(1, Math.floor(first.samples.length / 64));
    signatures.add(
      Array.from({ length: 64 }, (_, index) => (
        first.samples[index * stride] ?? 0
      ).toFixed(4)).join(","),
    );
  }
  assert.equal(signatures.size, 4);
});

test("threat layer states stay restrained and define non-zero click-free transitions", () => {
  for (const theme of THEMES) {
    const patrol = threatLayerMixForMode(theme, "patrol", 0);
    const suspicious = threatLayerMixForMode(theme, "suspicious", 0.5);
    const chase = threatLayerMixForMode(theme, "chase", 1);
    const checking = threatLayerMixForMode(theme, "check-hide", 1);
    const release = threatLayerMixForMode(theme, "lost-sight", 0.5);
    assert.equal(patrol.gain, 0);
    assert.ok(chase.gain > suspicious.gain);
    assert.ok(checking.gain > release.gain);
    assert.ok(chase.gain < 0.015);
    assert.ok(chase.transitionSeconds >= 0.1);
    assert.ok(release.transitionSeconds > chase.transitionSeconds);
    assert.ok(chase.filterHertz !== suspicious.filterHertz);
  }
});

test("theme generator is self-contained and cannot add an audio request", async () => {
  const source = await readFile(
    new URL("../app/game/audio/theme-audio-design.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\/audio\//u);
  assert.doesNotMatch(source, /new\s+AudioContext/u);
});
