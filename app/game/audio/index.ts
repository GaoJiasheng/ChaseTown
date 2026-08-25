import * as THREE from "three";

import { P2_TUNING } from "../config/index.js";
import type { ActorMotionRuntime, Phase } from "../core/types.js";
type SynthContext = {
  currentTime: number;
  state: "closed" | "running" | "suspended" | "interrupted";
  destination: AudioDestinationNode;
  createOscillator: () => OscillatorNode;
  createGain: () => GainNode;
  resume: () => Promise<void>;
  suspend: () => Promise<void>;
  close: () => Promise<void>;
};
type SynthConstructor = new () => SynthContext;

export function makeSynthAudioRuntime(target: Window) {
  let context: SynthContext | null = null;
  let nextHeartbeatAt = 0;
  let lastStepIndex = 0;
  let lastPhase: Phase = "ready";
  const sources = new Set<OscillatorNode>();
  const snapshot = {
    created: false,
    state: "not-created",
    unlocks: 0,
    heartbeats: 0,
    footsteps: 0,
    winStingers: 0,
    lossStingers: 0,
    activeSources: 0,
    heartbeatIntervalSeconds: P2_TUNING.heartbeatSlowSeconds as number,
    lastThreat: 0,
  };
  const syncSnapshot = () => {
    snapshot.state = context?.state ?? "not-created";
    snapshot.activeSources = sources.size;
  };
  const tone = (frequency: number, gainValue: number, duration: number, delay = 0, wave: OscillatorType = "sine") => {
    if (!context || context.state !== "running") return;
    const startsAt = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), startsAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    sources.add(oscillator);
    oscillator.onended = () => {
      sources.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
      syncSnapshot();
    };
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration + 0.015);
    syncSnapshot();
  };
  const stopSources = () => {
    for (const source of [...sources]) {
      source.onended = null;
      try { source.stop(); } catch { /* The node may already have ended. */ }
      source.disconnect();
      sources.delete(source);
    }
    syncSnapshot();
  };
  const unlock = async () => {
    if (!context) {
      const contextKey = ["Audio", "Context"].join("");
      const constructor = (target as unknown as Record<string, unknown>)[contextKey] as SynthConstructor | undefined;
      if (!constructor) return;
      context = new constructor();
      snapshot.created = true;
      nextHeartbeatAt = context.currentTime + 0.12;
    }
    if (context.state === "suspended" || context.state === "interrupted") await context.resume();
    snapshot.unlocks += 1;
    syncSnapshot();
  };
  const update = (threat: number, motion: ActorMotionRuntime | undefined) => {
    snapshot.lastThreat = threat;
    if (!context || context.state !== "running" || lastPhase !== "playing") return;
    const heartbeatInterval = THREE.MathUtils.lerp(
      P2_TUNING.heartbeatSlowSeconds,
      P2_TUNING.heartbeatFastSeconds,
      threat,
    );
    snapshot.heartbeatIntervalSeconds = heartbeatInterval;
    if (threat > 0.08 && context.currentTime >= nextHeartbeatAt) {
      const gain = THREE.MathUtils.lerp(P2_TUNING.heartbeatQuietGain, P2_TUNING.heartbeatLoudGain, threat);
      tone(68 + threat * 12, gain, 0.09, 0, "sine");
      tone(52 + threat * 8, gain * 0.72, 0.1, 0.12, "sine");
      snapshot.heartbeats += 1;
      nextHeartbeatAt = context.currentTime + heartbeatInterval;
    }
    if (motion && motion.gaitWeight > 0.3 && motion.actualSpeed > 0.2) {
      const stepIndex = Math.floor(motion.gaitPhase / P2_TUNING.footstepPhaseRadians);
      if (stepIndex !== lastStepIndex) {
        lastStepIndex = stepIndex;
        tone(92 + (stepIndex & 1) * 12, 0.025 * motion.gaitWeight, 0.045, 0, "triangle");
        snapshot.footsteps += 1;
      }
    } else if (motion) {
      lastStepIndex = Math.floor(motion.gaitPhase / P2_TUNING.footstepPhaseRadians);
    }
    syncSnapshot();
  };
  const onPhase = (next: Phase) => {
    if (next === lastPhase) return;
    lastPhase = next;
    if (next !== "playing") stopSources();
    if (next === "won") {
      tone(392, 0.055, 0.16, 0, "triangle");
      tone(523.25, 0.06, 0.2, 0.14, "triangle");
      tone(659.25, 0.065, 0.32, 0.3, "triangle");
      snapshot.winStingers += 1;
    } else if (next === "lost") {
      tone(196, 0.065, 0.2, 0, "sawtooth");
      tone(146.83, 0.055, 0.38, 0.17, "sawtooth");
      snapshot.lossStingers += 1;
    }
    syncSnapshot();
  };
  const suspend = async () => {
    stopSources();
    if (context?.state === "running") await context.suspend();
    syncSnapshot();
  };
  const dispose = async () => {
    stopSources();
    if (context && context.state !== "closed") await context.close();
    syncSnapshot();
  };
  return { unlock, update, onPhase, suspend, dispose, getSnapshot: () => ({ ...snapshot }) };
}
