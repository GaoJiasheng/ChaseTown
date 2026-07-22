import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AdaptiveScoreController,
  calculateAdaptiveGains,
  calculateWrappedDrift,
  clampThreat,
  EXPLORE_SCORE_URL,
  prewarmAdaptiveScoreAssets,
  reduceAdaptiveScoreStatus,
  smoothingTimeConstant,
  THREAT_SCORE_URL,
} from "../app/game/audio/adaptive-score.ts";

test("both mastered score stems are materialized in cache before first interaction", async () => {
  const requests = [];
  const consumed = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      async arrayBuffer() {
        consumed.push(url);
        return new ArrayBuffer(8);
      },
    };
  };

  const result = await prewarmAdaptiveScoreAssets(fetcher);
  assert.deepEqual(result, {
    loaded: [EXPLORE_SCORE_URL, THREAT_SCORE_URL],
    failed: [],
  });
  assert.deepEqual(requests.map(({ url }) => url), [EXPLORE_SCORE_URL, THREAT_SCORE_URL]);
  assert.ok(requests.every(({ init }) => init.cache === "force-cache" && init.credentials === "same-origin"));
  assert.deepEqual(consumed, [EXPLORE_SCORE_URL, THREAT_SCORE_URL]);
});

test("floor-preserving equal-power gains hit mastered endpoints", () => {
  assert.deepEqual(calculateAdaptiveGains(0), { explore: 1, threat: 0 });
  const fullThreat = calculateAdaptiveGains(1);
  assert.ok(Math.abs(fullThreat.explore - 0.4) < 1e-12);
  assert.ok(Math.abs(fullThreat.threat - 0.94) < 1e-12);
  assert.deepEqual(calculateAdaptiveGains(-20), calculateAdaptiveGains(0));
  assert.deepEqual(calculateAdaptiveGains(20), calculateAdaptiveGains(1));
});

test("gain curve is monotonic and keeps combined power stable", () => {
  let previous = calculateAdaptiveGains(0);
  for (let step = 1; step <= 100; step += 1) {
    const gains = calculateAdaptiveGains(step / 100);
    assert.ok(gains.explore <= previous.explore);
    assert.ok(gains.threat >= previous.threat);
    const combinedPower = gains.explore ** 2 + gains.threat ** 2;
    assert.ok(combinedPower >= 0.999 && combinedPower <= 1.045);
    previous = gains;
  }
});

test("threat clamping and attack/release smoothing are deterministic", () => {
  assert.equal(clampThreat(-1), 0);
  assert.equal(clampThreat(0.42), 0.42);
  assert.equal(clampThreat(2), 1);
  assert.ok(smoothingTimeConstant(0.2, 0.8) < smoothingTimeConstant(0.8, 0.2));
  assert.equal(smoothingTimeConstant(0.5, 0.5), smoothingTimeConstant(0.2, 0.8));
});

test("wrapped drift treats opposite sides of a loop seam as adjacent", () => {
  assert.ok(Math.abs(calculateWrappedDrift(37.99, 0.01, 38) - 0.02) < 1e-9);
  assert.ok(Math.abs(calculateWrappedDrift(0.01, 37.99, 38) + 0.02) < 1e-9);
  assert.equal(calculateWrappedDrift(10, 10.015, 38), 0.015000000000000568);
});

test("status reducer preserves terminal disposal and diagnoses failure state", () => {
  let status = "idle";
  status = reduceAdaptiveScoreStatus(status, "begin-unlock");
  assert.equal(status, "unlocking");
  status = reduceAdaptiveScoreStatus(status, "play");
  assert.equal(status, "playing");
  status = reduceAdaptiveScoreStatus(status, "suspend");
  assert.equal(status, "suspended");
  status = reduceAdaptiveScoreStatus(status, "fail");
  assert.equal(status, "error");
  assert.equal(reduceAdaptiveScoreStatus(status, "play"), "error");
  status = reduceAdaptiveScoreStatus(status, "dispose");
  assert.equal(status, "disposed");
  assert.equal(reduceAdaptiveScoreStatus(status, "play"), "disposed");
});

test("controller construction and pre-unlock controls are DOM-free", async () => {
  const controller = new AdaptiveScoreController(null);
  assert.deepEqual(controller.getSnapshot().targetGains, calculateAdaptiveGains(0));
  assert.equal(controller.setThreat(0.75).ok, true);
  assert.equal(controller.setMuted(true).ok, true);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.unlocked, false);
  assert.equal(snapshot.muted, true);
  assert.equal(snapshot.threat, 0.75);
  assert.equal(snapshot.explore.url, EXPLORE_SCORE_URL);
  assert.equal(snapshot.threatTrack.url, THREAT_SCORE_URL);
  const unlock = await controller.unlock();
  assert.equal(unlock.ok, false);
  assert.equal(unlock.error.code, "unsupported-environment");
});

test("invalid threat returns a diagnostic without corrupting the prior mix", () => {
  const controller = new AdaptiveScoreController(null);
  controller.setThreat(0.3);
  const result = controller.setThreat(Number.NaN);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-threat");
  assert.equal(controller.getSnapshot().threat, 0.3);
});

test("repeated interaction unlocks do not restart an already-playing score", async () => {
  const tracks = [];
  const audioParam = () => ({
    value: 1,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; },
    setTargetAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
  });
  const environment = {
    createAudioContext() {
      return {
        state: "running",
        currentTime: 0,
        destination: {},
        onstatechange: null,
        createGain: () => ({ gain: audioParam(), connect() {}, disconnect() {} }),
        createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
        async resume() { this.state = "running"; },
        async close() { this.state = "closed"; },
      };
    },
    createAudioElement(url) {
      const listeners = new Map();
      const track = {
        src: url,
        currentTime: 0,
        duration: 38.02,
        paused: true,
        readyState: 4,
        error: null,
        playbackRate: 1,
        playCalls: 0,
        async play() { this.playCalls += 1; this.paused = false; },
        pause() { this.paused = true; },
        load() {},
        setAttribute() {},
        removeAttribute() {},
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name) { listeners.delete(name); },
      };
      tracks.push(track);
      return track;
    },
    setInterval: () => 17,
    clearInterval() {},
    nowMs: () => 0,
    visibilityDocument: null,
  };
  const controller = new AdaptiveScoreController(environment);
  assert.equal((await controller.unlock()).ok, true);
  tracks[0].currentTime = 12.5;
  tracks[1].currentTime = 12.5;

  assert.equal((await controller.unlock()).ok, true);
  assert.deepEqual(tracks.map((track) => track.currentTime), [12.5, 12.5]);
  assert.deepEqual(tracks.map((track) => track.playCalls), [1, 1]);
  await controller.dispose();
});

function createFailureInjectionHarness({ failSourceCall = null, failFirstInterval = false } = {}) {
  const tracks = [];
  const contexts = [];
  const sources = [];
  const gains = [];
  let sourceCalls = 0;
  let intervalCalls = 0;
  const audioParam = () => ({
    value: 1,
    cancelAndHoldAtTime() {},
    cancelScheduledValues() {},
    setValueAtTime(value) { this.value = value; },
    setTargetAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; },
  });
  const environment = {
    createAudioContext() {
      const context = {
        state: "running",
        currentTime: 0,
        destination: {},
        onstatechange: null,
        closeCalls: 0,
        createGain() {
          const gain = { gain: audioParam(), disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
          gains.push(gain);
          return gain;
        },
        createMediaElementSource() {
          sourceCalls += 1;
          if (sourceCalls === failSourceCall) throw new Error("injected media source failure");
          const source = { disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
          sources.push(source);
          return source;
        },
        async resume() { this.state = "running"; },
        async close() { this.closeCalls += 1; this.state = "closed"; },
      };
      contexts.push(context);
      return context;
    },
    createAudioElement(url) {
      const listeners = new Map();
      const track = {
        src: url,
        currentTime: 0,
        duration: 38.02,
        paused: true,
        readyState: 4,
        error: null,
        playbackRate: 1,
        playCalls: 0,
        pauseCalls: 0,
        removedSource: false,
        async play() { this.playCalls += 1; this.paused = false; },
        pause() { this.pauseCalls += 1; this.paused = true; },
        load() {},
        setAttribute() {},
        removeAttribute(name) { if (name === "src") { this.src = ""; this.removedSource = true; } },
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name) { listeners.delete(name); },
        listenerCount() { return listeners.size; },
      };
      tracks.push(track);
      return track;
    },
    setInterval() {
      intervalCalls += 1;
      if (failFirstInterval && intervalCalls === 1) throw new Error("injected timer failure");
      return 23;
    },
    clearInterval() {},
    nowMs: () => 42,
    visibilityDocument: null,
  };
  return { environment, tracks, contexts, sources, gains };
}

test("synchronization setup failure pauses both stems and can recover on the next gesture", async () => {
  const harness = createFailureInjectionHarness({ failFirstInterval: true });
  const controller = new AdaptiveScoreController(harness.environment);

  const first = await controller.unlock();
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "synchronization-failed");
  assert.equal(first.snapshot.status, "error");
  assert.deepEqual(harness.tracks.map((track) => track.paused), [true, true]);

  const retry = await controller.unlock();
  assert.equal(retry.ok, true);
  assert.equal(retry.snapshot.status, "playing");
  assert.deepEqual(harness.tracks.map((track) => track.playCalls), [2, 2]);
  await controller.dispose();
});

test("a partial media graph is fully cleaned up and rebuilt on retry", async () => {
  const harness = createFailureInjectionHarness({ failSourceCall: 2 });
  const controller = new AdaptiveScoreController(harness.environment);

  const first = await controller.unlock();
  assert.equal(first.ok, false);
  assert.equal(first.error.code, "media-source-failed");
  assert.equal(first.snapshot.status, "error");
  assert.equal(first.snapshot.unlocked, false);
  assert.equal(harness.contexts.length, 1);
  assert.equal(harness.contexts[0].closeCalls, 1);
  assert.deepEqual(harness.tracks.slice(0, 2).map((track) => track.removedSource), [true, true]);
  assert.deepEqual(harness.tracks.slice(0, 2).map((track) => track.listenerCount()), [0, 0]);
  assert.equal(harness.sources[0].disconnected, true);
  assert.equal(harness.gains[0].disconnected, true);
  assert.equal(harness.gains[1].disconnected, true);

  const retry = await controller.unlock();
  assert.equal(retry.ok, true);
  assert.equal(retry.snapshot.status, "playing");
  assert.equal(retry.snapshot.unlocked, true);
  assert.equal(harness.contexts.length, 2);
  assert.deepEqual(harness.tracks.slice(2).map((track) => track.playCalls), [1, 1]);
  await controller.dispose();
});

test("production controller contains no oscillator or synthesized-beep fallback", async () => {
  const source = await readFile(new URL("../app/game/audio/adaptive-score.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createOscillator|OscillatorNode|\bbeep\b/iu);
  assert.match(source, /slow-drift-explore\.m4a/);
  assert.match(source, /slow-drift-threat\.m4a/);
});
