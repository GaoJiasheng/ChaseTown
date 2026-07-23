import assert from "node:assert/strict";
import test from "node:test";

import {
  footstepCueForAnimationMarker,
  ImmersiveSoundscapeController,
  lockerListeningMix,
  soundPanForWorldPoints,
  spatializeWorldSound,
  themeMechanicAudioProfile,
  themeSoundProfile,
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

function createFakeAudioContext() {
  const parameters = [];
  const audioParam = () => {
    const parameter = {
      value: 0,
      targets: [],
      cancelScheduledValues() {},
      setTargetAtTime(value, time, constant) {
        this.value = value;
        this.targets.push({ value, time, constant });
      },
      setValueAtTime(value) { this.value = value; },
      exponentialRampToValueAtTime(value) { this.value = value; },
    };
    parameters.push(parameter);
    return parameter;
  };
  const gains = [];
  const oscillators = [];
  const bufferSources = [];
  const context = {
    state: "running",
    currentTime: 2,
    sampleRate: 100,
    destination: {},
    resume: async () => {},
    close: async () => { context.state = "closed"; },
    createGain: () => {
      const node = { gain: audioParam(), connect() {}, disconnect() {} };
      gains.push(node);
      return node;
    },
    createBiquadFilter: () => ({ type: "lowpass", frequency: audioParam(), Q: audioParam(), connect() {} }),
    createBufferSource: () => {
      const node = { buffer: null, loop: false, playbackRate: audioParam(), connect() {}, start() {}, stop() {} };
      bufferSources.push(node);
      return node;
    },
    createOscillator: () => {
      const node = { type: "sine", frequency: audioParam(), connect() {}, start() {}, stop() {} };
      oscillators.push(node);
      return node;
    },
    createStereoPanner: () => ({ pan: audioParam(), connect() {} }),
    createBuffer: (_channels, length) => ({ getChannelData: () => new Float32Array(length) }),
  };
  return { context, gains, oscillators, bufferSources, parameters };
}

test("theme activity smooths only local ambience and theme trigger prefers CC0 buffers", async () => {
  const fake = createFakeAudioContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  const controller = new ImmersiveSoundscapeController("factory", () => fake.context);
  try {
    assert.equal(await controller.unlock(), true);
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
    const enclosureTargetCount = fake.gains[4].gain.targets.length;
    controller.setListenerAcoustics({
      insideHideSpot: true,
      doorOpenness: 0,
      breathIntensity: 0.705,
    }, 0.8);
    assert.equal(
      fake.gains[4].gain.targets.length,
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
    assert.equal(fake.bufferSources.length, sourcesBeforeSample + 1, "decoded CC0 sample wins");
    assert.equal(fake.oscillators.length, oscillatorsBeforeSample, "synth remains fallback only");

    controller.foleyBuffers.clear();
    assert.equal(controller.triggerThemeMechanic(), true);
    assert.ok(fake.oscillators.length > oscillatorsBeforeSample, "synth is safe when no sample decoded");
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
