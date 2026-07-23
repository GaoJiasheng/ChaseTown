import assert from "node:assert/strict";
import test from "node:test";

import {
  FOLEY_ASSET_URLS,
  footstepCueForAnimationMarker,
  ImmersiveSoundscapeController,
  lockerListeningMix,
  soundPanForWorldPoints,
  spatializeWorldSound,
  themeAudioIdentityProfile,
  themeMechanicAudioProfile,
  themeSoundProfile,
  threatLayerMixForMode,
  worldSoundPriority,
} from "../app/game/audio/immersive-soundscape.ts";
import { screenMoveToWorld } from "../app/game/input.ts";

test("soundscape construction is DOM-free and unsupported unlock fails safely", async () => {
  const controller = new ImmersiveSoundscapeController("campus", () => null);
  assert.equal(await controller.unlock(), false);
  assert.equal(controller.setThemeMechanicActivity(-2), 0);
  assert.equal(controller.setThemeMechanicActivity(3), 1);
  assert.equal(controller.getThemeMechanicActivity(), 1);
  assert.equal(controller.triggerThemeMechanic(), false);
  await controller.dispose();
  assert.equal(controller.setThemeMechanicActivity(0.4), 0.4);
  assert.equal(controller.triggerThemeMechanic(), false);
});

test("theme sound profiles provide distinct material and ambience palettes", () => {
  const campus = themeSoundProfile("campus");
  const hospital = themeSoundProfile("hospital");
  const fire = themeSoundProfile("fire-station");
  const factory = themeSoundProfile("factory");
  assert.notEqual(campus.stepNoiseColorHertz, hospital.stepNoiseColorHertz);
  assert.ok(factory.machineryGain > campus.machineryGain);
  assert.ok(fire.playerStepHertz > factory.playerStepHertz);
  assert.notEqual(campus.ambienceIdentity, hospital.ambienceIdentity);
  assert.notEqual(fire.detailPulseSeconds, factory.detailPulseSeconds);
});

test("directional footsteps agree with the immutable screen-right axis", () => {
  const listener = { x: 10, y: 10 };
  const rightDirection = screenMoveToWorld({ x: 1, y: 0 });
  const screenRight = soundPanForWorldPoints(listener, {
    x: listener.x + rightDirection.x,
    y: listener.y + rightDirection.y,
  });
  const screenLeft = soundPanForWorldPoints(listener, {
    x: listener.x - rightDirection.x,
    y: listener.y - rightDirection.y,
  });
  assert.ok(screenRight > 0.8);
  assert.ok(screenLeft < -0.8);
  assert.equal(soundPanForWorldPoints(listener, listener), 0);
});

test("animation marker footsteps use player-safe chaser audibility bands", () => {
  const profile = themeSoundProfile("factory");
  const player = footstepCueForAnimationMarker(profile, {
    actor: "player",
    elapsedSeconds: 4,
    worldSpeed: 4,
  });
  assert.equal(player?.pan, 0);
  assert.equal(player?.frequency, profile.playerStepHertz);
  assert.ok((player?.peakGain ?? 0) > 0.05);

  assert.equal(footstepCueForAnimationMarker(profile, {
    actor: "chaser",
    elapsedSeconds: 4,
    worldSpeed: 4,
  }), null, "an unseen chaser is silent by default");

  const quiet = footstepCueForAnimationMarker(profile, {
    actor: "chaser",
    elapsedSeconds: 4,
    worldSpeed: 4,
    audibility: 0.4,
    pan: 0.42,
  });
  const sameBand = footstepCueForAnimationMarker(profile, {
    actor: "chaser",
    elapsedSeconds: 4,
    worldSpeed: 4,
    audibility: 0.48,
    pan: 0.42,
  });
  assert.equal(quiet?.pan, 0.42);
  assert.equal(quiet?.peakGain, sameBand?.peakGain, "gain must not reveal continuous distance");
});

test("world sound spatialization combines authored distance, screen pan and obstruction", () => {
  const listenerPosition = { x: 5, y: 5 };
  const near = spatializeWorldSound({
    listenerPosition,
    sourcePosition: { x: 7, y: 5 },
    kind: "objective",
    maxDistance: 12,
    baseGain: 0.2,
  });
  const far = spatializeWorldSound({
    listenerPosition,
    sourcePosition: { x: 14, y: 5 },
    kind: "objective",
    maxDistance: 12,
    baseGain: 0.2,
  });
  const obstructed = spatializeWorldSound({
    listenerPosition,
    sourcePosition: { x: 7, y: 5 },
    kind: "objective",
    maxDistance: 12,
    baseGain: 0.2,
    occlusion: 1,
  });
  assert.ok(near.gain > far.gain, "distance attenuation must be monotonic");
  assert.ok(near.pan !== 0, "a non-centred world source must preserve fixed-camera direction");
  assert.ok(obstructed.gain < near.gain, "walls reduce energy");
  assert.ok(obstructed.lowpassHertz < near.lowpassHertz, "walls also remove high frequencies");
  assert.equal(spatializeWorldSound({
    listenerPosition,
    sourcePosition: { x: 50, y: 50 },
    kind: "ambient-detail",
    maxDistance: 4,
  }).gain, 0);
});

test("locker acoustics muffle the room but preserve door-side threat readability", () => {
  const open = lockerListeningMix({ insideHideSpot: false }, 0);
  const calmHidden = lockerListeningMix({
    insideHideSpot: true,
    doorOpenness: 0,
    breathIntensity: 0.6,
  }, 0);
  const dangerHidden = lockerListeningMix({
    insideHideSpot: true,
    doorOpenness: 0,
    breathIntensity: 0.6,
  }, 1);
  const peeking = lockerListeningMix({
    insideHideSpot: true,
    doorOpenness: 0.45,
    breathIntensity: 0.6,
  }, 0.5);
  assert.ok(calmHidden.externalGain < open.externalGain);
  assert.ok(calmHidden.externalLowpassHertz < open.externalLowpassHertz);
  assert.ok(peeking.externalLowpassHertz > calmHidden.externalLowpassHertz);
  assert.ok(dangerHidden.externalLowpassHertz > calmHidden.externalLowpassHertz);
  assert.ok(dangerHidden.threatGainBoost > calmHidden.threatGainBoost);
  assert.ok(dangerHidden.breathGain < calmHidden.breathGain, "breath ducks under readable door footsteps");
});

test("auditory priority protects gameplay evidence from decorative ambience", () => {
  assert.ok(worldSoundPriority("threat-interaction") > worldSoundPriority("threat-footstep"));
  assert.ok(worldSoundPriority("threat-footstep") > worldSoundPriority("objective"));
  assert.ok(worldSoundPriority("objective") > worldSoundPriority("theme-event"));
  assert.ok(worldSoundPriority("theme-event") > worldSoundPriority("ambient-detail"));

  const common = {
    listenerPosition: { x: 1, y: 1 },
    sourcePosition: { x: 4, y: 1 },
    maxDistance: 10,
    baseGain: 0.12,
    occlusion: 0.8,
    listenerAcoustics: { insideHideSpot: true, doorOpenness: 0 },
  };
  const threat = spatializeWorldSound({ ...common, kind: "threat-footstep" });
  const ambience = spatializeWorldSound({ ...common, kind: "ambient-detail" });
  assert.ok(threat.gain > ambience.gain);
  assert.ok(threat.lowpassHertz > ambience.lowpassHertz);
});

function createFakeAudioContext({
  initialState = "running",
  rejectResume = false,
  failGainCall = null,
} = {}) {
  const parameters = [];
  const audioParam = () => {
    const parameter = {
      value: 0,
      targets: [],
      holds: [],
      sets: [],
      ramps: [],
      cancelAndHoldAtTime(time) { this.holds.push(time); },
      cancelScheduledValues() {},
      setTargetAtTime(value, time, constant) {
        this.value = value;
        this.targets.push({ value, time, constant });
      },
      setValueAtTime(value, time) {
        this.value = value;
        this.sets.push({ value, time });
      },
      exponentialRampToValueAtTime(value, time) {
        this.value = value;
        this.ramps.push({ value, time, kind: "exponential" });
      },
      linearRampToValueAtTime(value, time) {
        this.value = value;
        this.ramps.push({ value, time, kind: "linear" });
      },
    };
    parameters.push(parameter);
    return parameter;
  };
  const gains = [];
  const filters = [];
  const oscillators = [];
  const bufferSources = [];
  const panners = [];
  const buffers = [];
  let gainCalls = 0;
  const scheduledSource = (extra) => ({
    ...extra,
    disconnected: false,
    startCalls: [],
    stopCalls: [],
    connect() {},
    disconnect() { this.disconnected = true; },
    start(time) { this.startCalls.push(time); },
    stop(time) { this.stopCalls.push(time); },
  });
  const context = {
    state: initialState,
    currentTime: 2,
    sampleRate: 1_000,
    destination: {},
    closeCalls: 0,
    resume: async () => {
      if (rejectResume) throw new Error("resume rejected");
      context.state = "running";
    },
    close: async () => {
      context.closeCalls += 1;
      context.state = "closed";
    },
    createGain: () => {
      gainCalls += 1;
      if (gainCalls === failGainCall) throw new Error("gain creation failed");
      const node = {
        gain: audioParam(),
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; },
      };
      gains.push(node);
      return node;
    },
    createBiquadFilter: () => {
      const node = {
        type: "lowpass",
        frequency: audioParam(),
        Q: audioParam(),
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; },
      };
      filters.push(node);
      return node;
    },
    createBufferSource: () => {
      const node = scheduledSource({
        buffer: null,
        loop: false,
        playbackRate: audioParam(),
      });
      bufferSources.push(node);
      return node;
    },
    createOscillator: () => {
      const node = scheduledSource({
        type: "sine",
        frequency: audioParam(),
      });
      oscillators.push(node);
      return node;
    },
    createStereoPanner: () => {
      const node = {
        pan: audioParam(),
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; },
      };
      panners.push(node);
      return node;
    },
    createBuffer: (_channels, length, sampleRate) => {
      const data = new Float32Array(length);
      const buffer = { sampleRate, getChannelData: () => data };
      buffers.push(buffer);
      return buffer;
    },
    decodeAudioData: async () => ({}),
  };
  return {
    context,
    gains,
    filters,
    oscillators,
    bufferSources,
    panners,
    buffers,
    parameters,
  };
}

test("theme activity smooths only local ambience and theme trigger prefers CC0 buffers", async () => {
  const fake = createFakeAudioContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  const controller = new ImmersiveSoundscapeController("factory", () => fake.context);
  try {
    assert.equal(await controller.unlock(), true);
    await controller.foleyLoadPromise;
    controller.setMuted(true);
    const masterTargetCount = fake.gains[0].gain.targets.length;
    assert.equal(controller.setThemeMechanicActivity(0.5), 0.5);
    assert.ok(fake.gains[1].gain.targets.length > 0, "ambience gain should smooth toward activity");
    assert.ok(fake.gains[2].gain.targets.length > 0, "machinery gain should smooth toward activity");
    assert.equal(fake.gains[0].gain.targets.length, masterTargetCount, "activity must not undo mute at master gain");
    const ambienceTargetCount = fake.gains[1].gain.targets.length;
    controller.setThemeMechanicActivity(0.505);
    controller.setThemeMechanicActivity(0.51);
    assert.equal(
      fake.gains[1].gain.targets.length,
      ambienceTargetCount,
      "sub-threshold frame updates must not grow the AudioParam automation queue",
    );
    controller.setThemeMechanicActivity(0.53);
    assert.equal(fake.gains[1].gain.targets.length, ambienceTargetCount + 1);

    const enclosure = controller.setListenerAcoustics({
      insideHideSpot: true,
      doorOpenness: 0,
      breathIntensity: 0.7,
    }, 0.8);
    assert.ok(enclosure.externalLowpassHertz < 2000);
    assert.ok(enclosure.breathGain > 0);
    const enclosureTargetCount = fake.gains[6].gain.targets.length;
    controller.setListenerAcoustics({
      insideHideSpot: true,
      doorOpenness: 0,
      breathIntensity: 0.705,
    }, 0.8);
    assert.equal(
      fake.gains[6].gain.targets.length,
      enclosureTargetCount,
      "breath-only micro changes do not churn the external filter graph",
    );
    const sourcesBeforeBreath = fake.bufferSources.length;
    controller.update({
      elapsedSeconds: 1,
      playerPosition: { x: 1, y: 1 },
      chaserPosition: { x: 1, y: 1 },
      playerSpeed: 0,
      chaserSpeed: 0,
      chaserMode: "search",
      chaserAudibility: 0.8,
      listenerAcoustics: {
        insideHideSpot: true,
        doorOpenness: 0,
        breathIntensity: 0.705,
      },
    });
    assert.ok(
      fake.bufferSources.length > sourcesBeforeBreath,
      "the hidden listener gets a restrained procedural breath layer",
    );

    const audioProfile = themeMechanicAudioProfile("factory");
    controller.foleyBuffers.set(audioProfile.foleySet, [{}]);
    const oscillatorsBeforeSample = fake.oscillators.length;
    const sourcesBeforeSample = fake.bufferSources.length;
    assert.equal(controller.triggerThemeMechanic(), true);
    assert.equal(
      fake.bufferSources.length,
      sourcesBeforeSample + 2,
      "decoded CC0 sample is supported by one quiet themed material layer",
    );
    assert.equal(fake.oscillators.length, oscillatorsBeforeSample, "theme event is never a single oscillator beep");

    controller.foleyBuffers.clear();
    const sourcesBeforeFallback = fake.bufferSources.length;
    assert.equal(controller.triggerThemeMechanic(), true);
    assert.equal(
      fake.bufferSources.length,
      sourcesBeforeFallback + 1,
      "a generated multi-partial buffer is the network-free fallback",
    );
    assert.equal(fake.oscillators.length, oscillatorsBeforeSample);
    assert.equal(controller.triggerThemeMechanic.length, 0, "theme event never accepts hidden positions");

    controller.foleyBuffers.set("step-hard", [{}]);
    const worldSourcesBefore = fake.bufferSources.length;
    const worldMix = controller.triggerWorldSound({
      listenerPosition: { x: 2, y: 2 },
      sourcePosition: { x: 4, y: 2 },
      kind: "threat-footstep",
      maxDistance: 10,
      baseGain: 0.11,
      occlusion: 0.5,
      foleySet: "step-hard",
    });
    assert.ok((worldMix?.gain ?? 0) > 0);
    assert.ok(fake.bufferSources.length > worldSourcesBefore);
  } finally {
    await controller.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("procedural identities add no pre-gesture requests and reuse only the existing Foley budget", async () => {
  const fake = createFakeAudioContext();
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: false };
  };
  const controller = new ImmersiveSoundscapeController("hospital", () => fake.context);
  try {
    controller.setTheme("hospital");
    controller.setMuted(true);
    controller.setThemeMechanicActivity(0.6);
    assert.equal(requests.length, 0, "construction and first-paint controls stay network-free");

    assert.equal(await controller.unlock(), true);
    await controller.foleyLoadPromise;
    const expectedUrls = Object.values(FOLEY_ASSET_URLS).flat().toSorted();
    assert.deepEqual(
      requests.map(({ url }) => url).toSorted(),
      expectedUrls,
      "audio unlock must not introduce another asset family",
    );
    assert.ok(requests.every(({ init }) => init.cache === "force-cache"));
  } finally {
    await controller.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("threat, enclosure, and mute transitions use held smoothing instead of hard gain jumps", async () => {
  const fake = createFakeAudioContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  const controller = new ImmersiveSoundscapeController("fire-station", () => fake.context);
  const frame = (elapsedSeconds, chaserMode, chaserAudibility) => ({
    elapsedSeconds,
    playerPosition: { x: 0, y: 0 },
    chaserPosition: { x: 0, y: 0 },
    playerSpeed: 0,
    chaserSpeed: 0,
    chaserMode,
    chaserAudibility,
    listenerAcoustics: {
      insideHideSpot: true,
      doorOpenness: 0,
      roomOcclusion: 0.7,
      breathIntensity: 0.75,
    },
  });
  try {
    assert.equal(await controller.unlock(), true);
    await controller.foleyLoadPromise;
    const threatGain = fake.gains[5].gain;
    controller.update(frame(1, "suspicious", 1 / 3));
    controller.update(frame(1.3, "chase", 1));
    controller.update(frame(2, "lost-sight", 2 / 3));
    controller.update(frame(3, "patrol", 0));

    const targetValues = threatGain.targets.map(({ value }) => value);
    assert.ok(targetValues.some((value) => value > 0.004 && value < 0.01));
    assert.ok(targetValues.some((value) => value > 0.012));
    assert.equal(targetValues.at(-1), 0);
    assert.ok(threatGain.targets.every(({ constant }) => constant >= 0.018));
    assert.ok(threatGain.holds.length >= threatGain.targets.length);
    assert.equal(threatGain.sets.length, 0, "runtime transitions never write a discontinuous value");

    controller.setMuted(true);
    controller.update(frame(4, "chase", 1));
    controller.setMuted(false);
    const masterTargets = fake.gains[0].gain.targets.map(({ value }) => value);
    assert.deepEqual(masterTargets.slice(-2), [0, 0.72]);
    assert.ok(
      fake.gains[5].gain.targets.at(-1).value > 0,
      "master mute does not erase the underlying threat mix",
    );
  } finally {
    await controller.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("live theme changes crossfade generated loops and same-theme calls stay idempotent", async () => {
  const fake = createFakeAudioContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  const controller = new ImmersiveSoundscapeController("campus", () => fake.context);
  try {
    assert.equal(await controller.unlock(), true);
    await controller.foleyLoadPromise;
    const oldIdentity = fake.bufferSources[3];
    const oldThreat = fake.bufferSources[4];
    const oldDetail = fake.bufferSources[2];
    controller.update({
      elapsedSeconds: 1,
      playerPosition: { x: 0, y: 0 },
      chaserPosition: { x: 0, y: 0 },
      playerSpeed: 0,
      chaserSpeed: 0,
      chaserMode: "chase",
      chaserAudibility: 1,
    });
    const sourcesBefore = fake.bufferSources.length;
    const identityGain = fake.gains[4].gain;
    const threatGain = fake.gains[5].gain;
    const threatFilter = fake.filters[4];

    controller.setTheme("factory");
    assert.equal(fake.bufferSources.length, sourcesBefore + 3);
    assert.ok(oldIdentity.stopCalls.some((time) => time > fake.context.currentTime));
    assert.ok(oldThreat.stopCalls.some((time) => time > fake.context.currentTime));
    assert.ok(oldDetail.stopCalls.some((time) => time > fake.context.currentTime));
    assert.ok(
      fake.bufferSources.slice(-3).every(
        (source) => source.startCalls[0] > fake.context.currentTime,
      ),
    );
    assert.deepEqual(
      identityGain.targets.slice(-2).map(({ value }) => value),
      [0, themeAudioIdentityProfile("factory").outputGain],
    );
    assert.ok(identityGain.targets.slice(-2).every(({ constant }) => constant > 0));
    assert.equal(identityGain.sets.length, 0);
    assert.deepEqual(
      threatGain.targets.slice(-2).map(({ value }) => value),
      [0, threatLayerMixForMode("factory", "chase", 1).gain],
    );
    assert.equal(
      threatFilter.frequency.targets.at(-1).value,
      threatLayerMixForMode("factory", "chase", 1).filterHertz,
    );

    const afterChange = fake.bufferSources.length;
    controller.setTheme("factory");
    assert.equal(fake.bufferSources.length, afterChange);
  } finally {
    await controller.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("locker latch, threat telegraph, and close breath are layered buffers", async () => {
  const fake = createFakeAudioContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  const controller = new ImmersiveSoundscapeController("campus", () => fake.context);
  try {
    assert.equal(await controller.unlock(), true);
    await controller.foleyLoadPromise;
    const beforeLatch = fake.bufferSources.length;
    controller.trigger("locker-check");
    assert.equal(fake.bufferSources.length, beforeLatch + 1);
    assert.equal(fake.oscillators.length, 0, "latch fallback is material noise plus resonances, not a beep");

    const beforeAlert = fake.bufferSources.length;
    controller.trigger("alert");
    assert.equal(fake.bufferSources.length, beforeAlert + 1);
    controller.trigger("alert");
    assert.equal(
      fake.bufferSources.length,
      beforeAlert + 1,
      "rapid suspicious-to-chase changes do not stack long telegraphs",
    );
    fake.context.currentTime += 0.5;
    controller.trigger("alert");
    assert.equal(fake.bufferSources.length, beforeAlert + 2);

    const beforeBreath = fake.bufferSources.length;
    controller.update({
      elapsedSeconds: 5,
      playerPosition: { x: 0, y: 0 },
      chaserPosition: { x: 0, y: 0 },
      playerSpeed: 0,
      chaserSpeed: 0,
      chaserMode: "check-hide",
      chaserAudibility: 1,
      listenerAcoustics: {
        insideHideSpot: true,
        doorOpenness: 0,
        roomOcclusion: 0.8,
        breathIntensity: 1,
      },
    });
    assert.ok(
      fake.bufferSources.length >= beforeBreath + 2,
      "separate mouth-air and chest breath bands are present over the smoothed threat bed",
    );
  } finally {
    await controller.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("AudioContext creation, graph construction, and resume failures degrade to false", async () => {
  const throwing = new ImmersiveSoundscapeController("campus", () => {
    throw new Error("context unavailable");
  });
  assert.equal(await throwing.unlock(), false);
  await throwing.dispose();

  const failedGraph = createFakeAudioContext({ failGainCall: 4 });
  const graphController = new ImmersiveSoundscapeController(
    "factory",
    () => failedGraph.context,
  );
  assert.equal(await graphController.unlock(), false);
  assert.equal(failedGraph.context.closeCalls, 1);
  assert.ok(failedGraph.bufferSources.every((source) => source.stopCalls.length >= 1));
  assert.ok(failedGraph.bufferSources.every((source) => source.disconnected));
  assert.ok(failedGraph.gains.every((gain) => gain.disconnected));

  const failedResume = createFakeAudioContext({
    initialState: "suspended",
    rejectResume: true,
  });
  const resumeController = new ImmersiveSoundscapeController(
    "hospital",
    () => failedResume.context,
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    assert.equal(await resumeController.unlock(), false);
    await resumeController.foleyLoadPromise;
  } finally {
    await resumeController.dispose();
    globalThis.fetch = originalFetch;
  }
  assert.equal(failedResume.context.closeCalls, 1);
});

test("dispose stops every scheduled source, disconnects the graph, and is idempotent", async () => {
  const fake = createFakeAudioContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  const controller = new ImmersiveSoundscapeController("factory", () => fake.context);
  try {
    assert.equal(await controller.unlock(), true);
    await controller.foleyLoadPromise;
    controller.trigger("locker-check", 0.4);
    controller.trigger("alert", -0.3);
    controller.update({
      elapsedSeconds: 3,
      playerPosition: { x: 0, y: 0 },
      chaserPosition: { x: 0, y: 0 },
      playerSpeed: 1,
      chaserSpeed: 0,
      chaserMode: "chase",
      chaserAudibility: 1,
      listenerAcoustics: {
        insideHideSpot: true,
        doorOpenness: 0,
        roomOcclusion: 0.8,
        breathIntensity: 1,
      },
    });
    assert.ok(fake.bufferSources.length > 7);
    assert.ok(fake.oscillators.length > 0);

    await controller.dispose();
    assert.equal(fake.context.state, "closed");
    assert.equal(fake.context.closeCalls, 1);
    assert.ok(fake.bufferSources.every((source) => source.stopCalls.length >= 1));
    assert.ok(fake.bufferSources.every((source) => source.disconnected));
    assert.ok(fake.oscillators.every((source) => source.stopCalls.length >= 1));
    assert.ok(fake.oscillators.every((source) => source.disconnected));
    assert.ok(fake.gains.slice(0, 7).every((gain) => gain.disconnected));
    assert.ok(fake.filters.slice(0, 6).every((filter) => filter.disconnected));
    assert.ok(fake.panners.every((panner) => panner.disconnected));
    assert.equal(controller.activeSources.size, 0);
    assert.equal(controller.foleyAbort.signal.aborted, true);

    await controller.dispose();
    assert.equal(fake.context.closeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
