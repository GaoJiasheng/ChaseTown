import type { CampaignTheme } from "../campaign.ts";
import type { ChaserMode, Point } from "../contracts.ts";

export type DiegeticSoundEvent =
  | "locker-open"
  | "locker-close"
  | "locker-check"
  | "alert"
  | "sight-lost"
  | "caught"
  | "escaped";

export interface ThemeSoundProfile {
  readonly noiseFilterHertz: number;
  readonly noiseGain: number;
  readonly machineryHertz: number;
  readonly machineryGain: number;
  readonly playerStepHertz: number;
  readonly chaserStepHertz: number;
  readonly stepNoiseColorHertz: number;
}

export interface SoundscapeFrame {
  readonly elapsedSeconds: number;
  readonly playerPosition: Point;
  readonly chaserPosition: Point;
  readonly playerSpeed: number;
  readonly chaserSpeed: number;
  readonly chaserMode: ChaserMode;
}

const THEME_SOUND_PROFILES: Readonly<Record<CampaignTheme, ThemeSoundProfile>> = Object.freeze({
  campus: Object.freeze({
    noiseFilterHertz: 1850,
    noiseGain: 0.014,
    machineryHertz: 46,
    machineryGain: 0.004,
    playerStepHertz: 118,
    chaserStepHertz: 84,
    stepNoiseColorHertz: 1550,
  }),
  hospital: Object.freeze({
    noiseFilterHertz: 2700,
    noiseGain: 0.012,
    machineryHertz: 58,
    machineryGain: 0.005,
    playerStepHertz: 145,
    chaserStepHertz: 98,
    stepNoiseColorHertz: 2450,
  }),
  "fire-station": Object.freeze({
    noiseFilterHertz: 930,
    noiseGain: 0.018,
    machineryHertz: 41,
    machineryGain: 0.008,
    playerStepHertz: 92,
    chaserStepHertz: 69,
    stepNoiseColorHertz: 1150,
  }),
  factory: Object.freeze({
    noiseFilterHertz: 680,
    noiseGain: 0.021,
    machineryHertz: 34,
    machineryGain: 0.011,
    playerStepHertz: 78,
    chaserStepHertz: 56,
    stepNoiseColorHertz: 820,
  }),
});

export function themeSoundProfile(theme: CampaignTheme): ThemeSoundProfile {
  return THEME_SOUND_PROFILES[theme];
}

/** Fixed-camera stereo placement; no hidden source may reveal exact distance. */
export function soundPanForWorldPoints(listener: Point, source: Point): number {
  const dx = source.x - listener.x;
  const dy = source.y - listener.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 1e-6) return 0;
  // The fixed camera looks diagonally across the grid. Its screen-right axis
  // is stable, so audio direction can never contradict WASD.
  const screenRightX = Math.SQRT1_2;
  const screenRightY = -Math.SQRT1_2;
  return Math.max(-0.88, Math.min(0.88, (dx * screenRightX + dy * screenRightY) / distance));
}

function defaultAudioContext(): AudioContext | null {
  const scope = globalThis as typeof globalThis & {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  return Context ? new Context() : null;
}

/**
 * A compact diegetic layer underneath the mastered adaptive score. It uses a
 * deterministic filtered-noise bed and short physical transients, avoiding a
 * large sample download while still providing footsteps, locker mechanics and
 * directional threat information.
 */
export class ImmersiveSoundscapeController {
  private readonly createContext: () => AudioContext | null;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambienceGain: GainNode | null = null;
  private ambienceFilter: BiquadFilterNode | null = null;
  private ambienceSource: AudioBufferSourceNode | null = null;
  private machineryGain: GainNode | null = null;
  private machineryOscillator: OscillatorNode | null = null;
  private theme: CampaignTheme;
  private muted = false;
  private disposed = false;
  private lastPlayerStepSeconds = Number.NEGATIVE_INFINITY;
  private lastChaserStepSeconds = Number.NEGATIVE_INFINITY;
  private previousChaserMode: ChaserMode = "spawn-delay";

  constructor(
    theme: CampaignTheme,
    createContext: () => AudioContext | null = defaultAudioContext,
  ) {
    this.theme = theme;
    this.createContext = createContext;
  }

  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.context) {
      const context = this.createContext();
      if (!context) return false;
      this.context = context;
      this.buildGraph(context);
    }
    if (this.context.state !== "running") {
      try {
        await this.context.resume();
      } catch {
        return false;
      }
    }
    return true;
  }

  setTheme(theme: CampaignTheme) {
    this.theme = theme;
    if (!this.context || !this.ambienceGain || !this.ambienceFilter || !this.machineryGain || !this.machineryOscillator) return;
    const profile = themeSoundProfile(theme);
    const now = this.context.currentTime;
    this.ambienceFilter.frequency.setTargetAtTime(profile.noiseFilterHertz, now, 0.35);
    this.ambienceGain.gain.setTargetAtTime(profile.noiseGain, now, 0.35);
    this.machineryOscillator.frequency.setTargetAtTime(profile.machineryHertz, now, 0.4);
    this.machineryGain.gain.setTargetAtTime(profile.machineryGain, now, 0.4);
  }

  setMuted(muted: boolean) {
    this.muted = Boolean(muted);
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.72, now, 0.012);
  }

  update(frame: SoundscapeFrame) {
    if (!this.context || this.context.state !== "running" || this.disposed) return;
    if (frame.elapsedSeconds < this.lastPlayerStepSeconds) {
      this.lastPlayerStepSeconds = Number.NEGATIVE_INFINITY;
      this.lastChaserStepSeconds = Number.NEGATIVE_INFINITY;
      this.previousChaserMode = "spawn-delay";
    }
    const profile = themeSoundProfile(this.theme);
    const playerCadence = frame.playerSpeed > 3 ? 0.31 : 0.43;
    if (
      frame.playerSpeed > 0.35
      && frame.elapsedSeconds - this.lastPlayerStepSeconds >= playerCadence
    ) {
      this.playFootstep(profile.playerStepHertz, profile.stepNoiseColorHertz, 0, frame.playerSpeed > 3 ? 0.055 : 0.038);
      this.lastPlayerStepSeconds = frame.elapsedSeconds;
    }
    const chaserAudible = frame.chaserMode !== "spawn-delay";
    const chaserCadence = frame.chaserMode === "chase" ? 0.3 : 0.49;
    if (
      chaserAudible
      && frame.chaserSpeed > 0.25
      && frame.elapsedSeconds - this.lastChaserStepSeconds >= chaserCadence
    ) {
      const distance = Math.hypot(
        frame.chaserPosition.x - frame.playerPosition.x,
        frame.chaserPosition.y - frame.playerPosition.y,
      );
      // Beyond the readable radius the adaptive music communicates danger,
      // but footsteps cannot leak a precise off-screen position.
      if (distance <= 10.5) {
        const pan = soundPanForWorldPoints(frame.playerPosition, frame.chaserPosition);
        const gain = Math.max(0.018, 0.082 * (1 - distance / 13));
        this.playFootstep(profile.chaserStepHertz, profile.stepNoiseColorHertz * 0.82, pan, gain);
      }
      this.lastChaserStepSeconds = frame.elapsedSeconds;
    }
    if (frame.chaserMode !== this.previousChaserMode) {
      if (frame.chaserMode === "suspicious" || frame.chaserMode === "chase") this.trigger("alert");
      else if (frame.chaserMode === "lost-sight") this.trigger("sight-lost");
      this.previousChaserMode = frame.chaserMode;
    }
  }

  trigger(event: DiegeticSoundEvent, pan = 0) {
    if (!this.context || this.context.state !== "running" || this.disposed) return;
    const context = this.context;
    const now = context.currentTime;
    const output = this.pannedOutput(pan);
    const metallic = ["locker-open", "locker-close", "locker-check"].includes(event);
    const impact = event === "caught";
    const frequency = event === "locker-open"
      ? 188
      : event === "locker-close"
        ? 126
        : event === "locker-check"
          ? 154
          : event === "alert"
            ? 62
            : event === "sight-lost"
              ? 82
              : event === "escaped"
                ? 196
                : 48;
    const duration = metallic ? 0.24 : impact ? 0.42 : 0.28;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(metallic ? 0.082 : impact ? 0.12 : 0.055, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    gain.connect(output);
    const oscillator = context.createOscillator();
    oscillator.type = metallic ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(28, frequency * 0.62), now + duration);
    oscillator.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
    if (metallic || impact) {
      const overtoneGain = context.createGain();
      overtoneGain.gain.setValueAtTime(metallic ? 0.032 : 0.026, now);
      overtoneGain.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.78);
      overtoneGain.connect(output);
      const overtone = context.createOscillator();
      overtone.type = "sine";
      overtone.frequency.setValueAtTime(frequency * (metallic ? 3.17 : 1.74), now);
      overtone.connect(overtoneGain);
      overtone.start(now);
      overtone.stop(now + duration);
    }
  }

  async dispose() {
    this.disposed = true;
    this.ambienceSource?.stop();
    this.machineryOscillator?.stop();
    const context = this.context;
    this.context = null;
    this.master = null;
    this.ambienceGain = null;
    this.ambienceFilter = null;
    this.ambienceSource = null;
    this.machineryGain = null;
    this.machineryOscillator = null;
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // Audio teardown must never prevent the WebGL scene from disposing.
      }
    }
  }

  private buildGraph(context: AudioContext) {
    const profile = themeSoundProfile(this.theme);
    const master = context.createGain();
    master.gain.value = this.muted ? 0 : 0.72;
    master.connect(context.destination);
    this.master = master;

    const ambienceGain = context.createGain();
    ambienceGain.gain.value = profile.noiseGain;
    ambienceGain.connect(master);
    this.ambienceGain = ambienceGain;
    const ambienceFilter = context.createBiquadFilter();
    ambienceFilter.type = this.theme === "hospital" ? "highpass" : "lowpass";
    ambienceFilter.frequency.value = profile.noiseFilterHertz;
    ambienceFilter.Q.value = this.theme === "factory" ? 0.8 : 0.45;
    ambienceFilter.connect(ambienceGain);
    this.ambienceFilter = ambienceFilter;
    const ambienceSource = context.createBufferSource();
    ambienceSource.buffer = this.noiseBuffer(context, 2.4);
    ambienceSource.loop = true;
    ambienceSource.connect(ambienceFilter);
    ambienceSource.start();
    this.ambienceSource = ambienceSource;

    const machineryGain = context.createGain();
    machineryGain.gain.value = profile.machineryGain;
    machineryGain.connect(master);
    this.machineryGain = machineryGain;
    const machinery = context.createOscillator();
    machinery.type = "sine";
    machinery.frequency.value = profile.machineryHertz;
    machinery.connect(machineryGain);
    machinery.start();
    this.machineryOscillator = machinery;
  }

  private noiseBuffer(context: AudioContext, seconds: number) {
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let state = 0x51f15e;
    let previous = 0;
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const white = ((state >>> 0) / 0xffff_ffff) * 2 - 1;
      previous = previous * 0.78 + white * 0.22;
      channel[index] = previous * 0.72;
    }
    return buffer;
  }

  private playFootstep(frequency: number, colorHertz: number, pan: number, peakGain: number) {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    const output = this.pannedOutput(pan);
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = colorHertz;
    filter.Q.value = 0.7;
    filter.connect(output);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);
    gain.connect(filter);
    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer(context, 0.11);
    noise.connect(gain);
    noise.start(now);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(peakGain * 0.7, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    bodyGain.connect(output);
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(frequency, now);
    body.frequency.exponentialRampToValueAtTime(frequency * 0.62, now + 0.1);
    body.connect(bodyGain);
    body.start(now);
    body.stop(now + 0.12);
  }

  private pannedOutput(pan: number): AudioNode {
    if (!this.context || !this.master) throw new Error("Soundscape graph is unavailable");
    if (typeof this.context.createStereoPanner !== "function") return this.master;
    const panner = this.context.createStereoPanner();
    panner.pan.value = Math.max(-0.9, Math.min(0.9, pan));
    panner.connect(this.master);
    return panner;
  }
}
