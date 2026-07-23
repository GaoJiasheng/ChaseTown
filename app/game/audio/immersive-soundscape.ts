import type { CampaignTheme } from "../campaign.ts";
import type { ChaserMode, Point } from "../contracts.ts";
import { fixedCameraGroundBasis } from "../input.ts";

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
  /** Retained for backwards-compatible diagnostics; never used for hidden-world panning. */
  readonly playerPosition: Point;
  /** Retained for backwards-compatible diagnostics; never used for hidden-world panning. */
  readonly chaserPosition: Point;
  readonly playerSpeed: number;
  readonly chaserSpeed: number;
  readonly chaserMode: ChaserMode;
  /** Player-legal, coarse 0..1 threat audibility. Omitted means silent. */
  readonly chaserAudibility?: number;
  /** Player-legal screen-relative direction, only when the chaser is observable. */
  readonly chaserPan?: number;
}

export type FootstepActor = "player" | "chaser";

/**
 * A presentation-layer animation marker. Chaser panning and audibility are
 * deliberately caller-supplied player knowledge rather than a world position:
 * a hidden chaser must not leak exact distance through its footfalls.
 */
export interface AnimationFootstepEvent {
  readonly actor: FootstepActor;
  readonly elapsedSeconds: number;
  readonly worldSpeed: number;
  /** Chaser-only broad 0..1 audibility cue; omitted means silent. */
  readonly audibility?: number;
  /** Chaser-only screen-relative pan derived from legal player knowledge. */
  readonly pan?: number;
}

export interface FootstepCue {
  readonly frequency: number;
  readonly colorHertz: number;
  readonly pan: number;
  readonly peakGain: number;
}

export type FoleySet =
  | "step-soft"
  | "step-hard"
  | "locker-open"
  | "locker-close"
  | "locker-latch"
  | "cloth"
  | "caught"
  | "metal-hit";

export const FOLEY_ASSET_URLS: Readonly<Record<FoleySet, readonly string[]>> = Object.freeze({
  "step-soft": Object.freeze([
    "/audio/foley/step-soft-01.ogg",
    "/audio/foley/step-soft-02.ogg",
    "/audio/foley/step-soft-03.ogg",
    "/audio/foley/step-soft-04.ogg",
    "/audio/foley/step-soft-05.ogg",
  ]),
  "step-hard": Object.freeze([
    "/audio/foley/step-hard-01.ogg",
    "/audio/foley/step-hard-02.ogg",
    "/audio/foley/step-hard-03.ogg",
    "/audio/foley/step-hard-04.ogg",
    "/audio/foley/step-hard-05.ogg",
  ]),
  "locker-open": Object.freeze([
    "/audio/foley/locker-open-01.ogg",
    "/audio/foley/locker-open-02.ogg",
  ]),
  "locker-close": Object.freeze([
    "/audio/foley/locker-close-01.ogg",
    "/audio/foley/locker-close-02.ogg",
  ]),
  "locker-latch": Object.freeze(["/audio/foley/locker-latch.ogg"]),
  cloth: Object.freeze([
    "/audio/foley/cloth-01.ogg",
    "/audio/foley/cloth-02.ogg",
  ]),
  caught: Object.freeze([
    "/audio/foley/caught-01.ogg",
    "/audio/foley/caught-02.ogg",
  ]),
  "metal-hit": Object.freeze([
    "/audio/foley/metal-hit-01.ogg",
    "/audio/foley/metal-hit-02.ogg",
  ]),
});

export interface ThemeMechanicAudioProfile {
  readonly foleySet: FoleySet;
  readonly playbackRate: number;
  readonly peakGain: number;
  readonly fallbackHertz: number;
  readonly fallbackDurationSeconds: number;
}

/** Theme events use the already licensed CC0 Foley pool before synthesis. */
export const THEME_MECHANIC_AUDIO_PROFILES: Readonly<Record<CampaignTheme, ThemeMechanicAudioProfile>> = Object.freeze({
  campus: Object.freeze({
    foleySet: "metal-hit", playbackRate: 1.34, peakGain: 0.12, fallbackHertz: 860, fallbackDurationSeconds: 0.52,
  }),
  hospital: Object.freeze({
    foleySet: "cloth", playbackRate: 0.9, peakGain: 0.075, fallbackHertz: 410, fallbackDurationSeconds: 0.34,
  }),
  "fire-station": Object.freeze({
    foleySet: "cloth", playbackRate: 0.7, peakGain: 0.115, fallbackHertz: 176, fallbackDurationSeconds: 0.48,
  }),
  factory: Object.freeze({
    foleySet: "metal-hit", playbackRate: 0.74, peakGain: 0.16, fallbackHertz: 94, fallbackDurationSeconds: 0.42,
  }),
});

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
  const { screenRight } = fixedCameraGroundBasis();
  return Math.max(-0.88, Math.min(0.88, (dx * screenRight.x + dy * screenRight.y) / distance));
}

const clampUnit = (value: number | undefined) => (
  value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
);

export function themeMechanicAudioProfile(theme: CampaignTheme): ThemeMechanicAudioProfile {
  return THEME_MECHANIC_AUDIO_PROFILES[theme];
}

/**
 * Maps a marker to a short physical footstep without accepting hidden-world
 * positions. Chaser audibility is quantized to broad bands, so even a legal
 * caller cannot turn gain into a distance readout.
 */
export function footstepCueForAnimationMarker(
  profile: ThemeSoundProfile,
  event: AnimationFootstepEvent,
): FootstepCue | null {
  if (!Number.isFinite(event.worldSpeed) || event.worldSpeed <= 0.01) return null;
  if (event.actor === "player") {
    return Object.freeze({
      frequency: profile.playerStepHertz,
      colorHertz: profile.stepNoiseColorHertz,
      pan: 0,
      peakGain: event.worldSpeed > 3 ? 0.055 : 0.038,
    });
  }
  // Four coarse bands preserve a useful near/far feeling without exposing a
  // continuously decodable distance to an unseen pursuer.
  const audibility = Math.round(clampUnit(event.audibility) * 3) / 3;
  if (audibility <= 0) return null;
  return Object.freeze({
    frequency: profile.chaserStepHertz,
    colorHertz: profile.stepNoiseColorHertz * 0.82,
    pan: event.pan !== undefined && Number.isFinite(event.pan)
      ? Math.max(-0.88, Math.min(0.88, event.pan))
      : 0,
    peakGain: 0.018 + audibility * 0.052,
  });
}

function defaultAudioContext(): AudioContext | null {
  const scope = globalThis as typeof globalThis & {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  return Context ? new Context() : null;
}

function footstepSetForTheme(theme: CampaignTheme): FoleySet {
  return theme === "campus" ? "step-soft" : "step-hard";
}

/**
 * A compact diegetic layer underneath the mastered adaptive score. Recorded
 * CC0 Foley is streamed after the first audio gesture; deterministic physical
 * transients remain only as a network/decoder fallback.
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
  private themeMechanicActivity = 0;
  private appliedThemeMechanicActivity = Number.NaN;
  private muted = false;
  private disposed = false;
  private lastPlayerStepSeconds = Number.NEGATIVE_INFINITY;
  private lastChaserStepSeconds = Number.NEGATIVE_INFINITY;
  private lastPlayerMarkerSeconds = Number.NEGATIVE_INFINITY;
  private lastChaserMarkerSeconds = Number.NEGATIVE_INFINITY;
  private previousChaserMode: ChaserMode = "spawn-delay";
  private readonly foleyBuffers = new Map<FoleySet, AudioBuffer[]>();
  private readonly foleyCursor = new Map<FoleySet, number>();
  private readonly foleyAbort = new AbortController();
  private foleyLoadPromise: Promise<void> | null = null;

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
      this.foleyLoadPromise = this.preloadFoley(context);
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
    this.appliedThemeMechanicActivity = Number.NaN;
    this.applyThemeMix(0.35);
  }

  setMuted(muted: boolean) {
    this.muted = Boolean(muted);
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.72, now, 0.012);
  }

  /**
   * Smoothly mixes a player-facing theme event into the local ambience. This
   * never touches the master gain, so mute state remains entirely authoritative.
   */
  setThemeMechanicActivity(activity: number): number {
    this.themeMechanicActivity = clampUnit(activity);
    const reachedBoundary = this.themeMechanicActivity === 0 || this.themeMechanicActivity === 1;
    if (
      !Number.isFinite(this.appliedThemeMechanicActivity)
      || Math.abs(this.themeMechanicActivity - this.appliedThemeMechanicActivity) >= 0.02
      || (reachedBoundary && this.themeMechanicActivity !== this.appliedThemeMechanicActivity)
    ) {
      this.applyThemeMix(0.18);
    }
    return this.themeMechanicActivity;
  }

  getThemeMechanicActivity(): number {
    return this.themeMechanicActivity;
  }

  /**
   * Plays a theme event with no spatial inputs. A CC0 Foley buffer is preferred
   * whenever decoded; a short synthesized transient is only a load fallback.
   */
  triggerThemeMechanic(): boolean {
    if (!this.context || this.context.state !== "running" || this.disposed) return false;
    const profile = themeMechanicAudioProfile(this.theme);
    const activityMix = 0.72 + this.themeMechanicActivity * 0.28;
    if (this.playSample(profile.foleySet, 0, profile.peakGain * activityMix, profile.playbackRate)) return true;
    this.playThemeMechanicFallback(profile, activityMix);
    return true;
  }

  /**
   * Plays a footstep at an authored animation contact. The regular speed
   * cadence is suppressed briefly for this actor, then resumes automatically
   * if a legacy asset does not provide contact markers.
   */
  triggerAnimationFootstep(event: AnimationFootstepEvent): boolean {
    if (!Number.isFinite(event.elapsedSeconds)) return false;
    if (event.actor === "player") this.lastPlayerMarkerSeconds = event.elapsedSeconds;
    else this.lastChaserMarkerSeconds = event.elapsedSeconds;
    const cue = footstepCueForAnimationMarker(themeSoundProfile(this.theme), event);
    if (!cue || !this.context || this.context.state !== "running" || this.disposed) return false;
    this.playFootstep(cue.frequency, cue.colorHertz, cue.pan, cue.peakGain, event.actor);
    return true;
  }

  update(frame: SoundscapeFrame) {
    if (!this.context || this.context.state !== "running" || this.disposed) return;
    if (frame.elapsedSeconds < Math.max(
      this.lastPlayerStepSeconds,
      this.lastChaserStepSeconds,
      this.lastPlayerMarkerSeconds,
      this.lastChaserMarkerSeconds,
    )) {
      this.lastPlayerStepSeconds = Number.NEGATIVE_INFINITY;
      this.lastChaserStepSeconds = Number.NEGATIVE_INFINITY;
      this.lastPlayerMarkerSeconds = Number.NEGATIVE_INFINITY;
      this.lastChaserMarkerSeconds = Number.NEGATIVE_INFINITY;
      this.previousChaserMode = "spawn-delay";
    }
    const profile = themeSoundProfile(this.theme);
    const playerMarkersFresh = frame.elapsedSeconds - this.lastPlayerMarkerSeconds <= 0.72;
    const playerCadence = frame.playerSpeed > 3 ? 0.31 : 0.43;
    if (
      !playerMarkersFresh
      &&
      frame.playerSpeed > 0.35
      && frame.elapsedSeconds - this.lastPlayerStepSeconds >= playerCadence
    ) {
      this.playFootstep(
        profile.playerStepHertz,
        profile.stepNoiseColorHertz,
        0,
        frame.playerSpeed > 3 ? 0.055 : 0.038,
        "player",
      );
      this.lastPlayerStepSeconds = frame.elapsedSeconds;
    }
    const chaserAudible = frame.chaserMode !== "spawn-delay";
    const chaserMarkersFresh = frame.elapsedSeconds - this.lastChaserMarkerSeconds <= 0.72;
    const chaserCadence = frame.chaserMode === "chase" ? 0.3 : 0.49;
    if (
      !chaserMarkersFresh
      &&
      chaserAudible
      && frame.chaserSpeed > 0.25
      && frame.elapsedSeconds - this.lastChaserStepSeconds >= chaserCadence
    ) {
      const audibility = Math.round(clampUnit(frame.chaserAudibility) * 3) / 3;
      if (audibility > 0) {
        const pan = Number.isFinite(frame.chaserPan)
          ? Math.max(-0.88, Math.min(0.88, frame.chaserPan ?? 0))
          : 0;
        const gain = 0.018 + audibility * 0.052;
        this.playFootstep(
          profile.chaserStepHertz,
          profile.stepNoiseColorHertz * 0.82,
          pan,
          gain,
          "chaser",
        );
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
    const sampled = event === "locker-open"
      ? this.playSample("locker-open", pan, 0.19, 1.08)
      : event === "locker-close"
        ? this.playSample("locker-close", pan, 0.2, 1.08)
        : event === "locker-check"
          ? this.playSample("locker-latch", pan, 0.18, 0.96)
          : event === "caught"
            ? this.playSample("caught", pan, 0.24, 0.9)
            : event === "alert" || event === "escaped"
              ? this.playSample("metal-hit", pan, event === "alert" ? 0.08 : 0.13, event === "alert" ? 0.82 : 1.18)
              : event === "sight-lost"
                ? this.playSample("cloth", pan, 0.08, 0.88)
                : false;
    if (sampled) return;
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
    this.foleyAbort.abort();
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
    this.foleyBuffers.clear();
    this.foleyCursor.clear();
    this.foleyLoadPromise = null;
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

  private applyThemeMix(timeConstantSeconds: number) {
    if (!this.context || !this.ambienceGain || !this.ambienceFilter || !this.machineryGain || !this.machineryOscillator) return;
    const profile = themeSoundProfile(this.theme);
    const activity = this.themeMechanicActivity;
    const now = this.context.currentTime;
    const smooth = (parameter: AudioParam, value: number) => {
      if (typeof parameter.cancelAndHoldAtTime === "function") {
        parameter.cancelAndHoldAtTime(now);
      } else {
        const heldValue = parameter.value;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(heldValue, now);
      }
      parameter.setTargetAtTime(value, now, timeConstantSeconds);
    };
    smooth(
      this.ambienceFilter.frequency,
      profile.noiseFilterHertz * (1 - activity * 0.18),
    );
    smooth(
      this.ambienceGain.gain,
      profile.noiseGain * (1 + activity * 1.1),
    );
    smooth(
      this.machineryOscillator.frequency,
      profile.machineryHertz * (1 + activity * 0.06),
    );
    smooth(
      this.machineryGain.gain,
      profile.machineryGain * (1 + activity * 2.4),
    );
    this.appliedThemeMechanicActivity = activity;
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

  private async preloadFoley(context: AudioContext) {
    const pending = (Object.entries(FOLEY_ASSET_URLS) as [FoleySet, readonly string[]][])
      .flatMap(([set, urls]) => urls.map((url) => ({ set, url })));
    let cursor = 0;
    const loadNext = async () => {
      while (!this.disposed && cursor < pending.length) {
        const asset = pending[cursor];
        cursor += 1;
        try {
          const response = await fetch(asset.url, {
            cache: "force-cache",
            signal: this.foleyAbort.signal,
          });
          if (!response.ok) continue;
          const decoded = await context.decodeAudioData(await response.arrayBuffer());
          if (this.disposed) return;
          const buffers = this.foleyBuffers.get(asset.set) ?? [];
          buffers.push(decoded);
          this.foleyBuffers.set(asset.set, buffers);
        } catch {
          if (this.foleyAbort.signal.aborted) return;
        }
      }
    };
    await Promise.all([loadNext(), loadNext(), loadNext()]);
  }

  private playSample(
    set: FoleySet,
    pan: number,
    peakGain: number,
    playbackRate: number,
  ): boolean {
    const context = this.context;
    const buffers = this.foleyBuffers.get(set);
    if (!context || !buffers?.length) return false;
    const index = this.foleyCursor.get(set) ?? 0;
    const buffer = buffers[index % buffers.length];
    this.foleyCursor.set(set, index + 1);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    const gain = context.createGain();
    gain.gain.value = peakGain;
    source.connect(gain);
    gain.connect(this.pannedOutput(pan));
    source.start();
    return true;
  }

  private playThemeMechanicFallback(profile: ThemeMechanicAudioProfile, activityMix: number) {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    const output = this.pannedOutput(0);
    const gain = context.createGain();
    const peakGain = profile.peakGain * activityMix * 0.7;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + profile.fallbackDurationSeconds);
    gain.connect(output);
    const oscillator = context.createOscillator();
    oscillator.type = this.theme === "factory" ? "sawtooth" : this.theme === "campus" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(profile.fallbackHertz, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(34, profile.fallbackHertz * (this.theme === "campus" ? 1.58 : 0.68)),
      now + profile.fallbackDurationSeconds,
    );
    oscillator.connect(gain);
    oscillator.start(now);
    oscillator.stop(now + profile.fallbackDurationSeconds + 0.02);
  }

  private playFootstep(
    frequency: number,
    colorHertz: number,
    pan: number,
    peakGain: number,
    actor: FootstepActor,
  ) {
    const context = this.context;
    if (!context) return;
    const sampled = this.playSample(
      footstepSetForTheme(this.theme),
      pan,
      peakGain * (actor === "chaser" ? 1.75 : 1.6),
      actor === "chaser" ? 0.84 : 1.06,
    );
    if (sampled) return;
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
