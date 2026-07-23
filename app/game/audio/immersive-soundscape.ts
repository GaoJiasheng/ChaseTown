import type { CampaignTheme } from "../campaign.ts";
import type { ChaserMode, Point } from "../contracts.ts";
import { fixedCameraGroundBasis } from "../input.ts";
import {
  renderThemeIdentityPcm,
  renderThreatTexturePcm,
  themeAudioIdentityProfile,
  threatLayerMixForMode,
  type ThreatLayerMix,
} from "./theme-audio-design.ts";

export {
  renderThemeIdentityPcm,
  themeAudioIdentityProfile,
  themeRhythmicOnsets,
  themeSpectralCentroidHertz,
  threatLayerMixForMode,
} from "./theme-audio-design.ts";
export type {
  RenderedThemeIdentity,
  ThemeAudioIdentityProfile,
  ThemeAudioPartial,
  ThreatLayerMix,
} from "./theme-audio-design.ts";

export type DiegeticSoundEvent =
  | "locker-open"
  | "locker-close"
  | "locker-check"
  | "alert"
  | "sight-lost"
  | "caught"
  | "escaped";

export interface ThemeSoundProfile {
  /** Human-readable mix intent used by diagnostics and authored level tooling. */
  readonly ambienceIdentity: string;
  readonly noiseFilterHertz: number;
  readonly noiseGain: number;
  readonly machineryHertz: number;
  readonly machineryGain: number;
  /** A sparse, filtered texture layer: air, cloth, radio hash, or metal resonance. */
  readonly detailFilterHertz: number;
  readonly detailFilterQ: number;
  readonly detailGain: number;
  readonly detailPulseSeconds: number;
  readonly playerStepHertz: number;
  readonly chaserStepHertz: number;
  readonly stepNoiseColorHertz: number;
}

export type WorldSoundKind =
  | "threat-footstep"
  | "threat-interaction"
  | "objective"
  | "theme-event"
  | "ambient-detail";

/**
 * Listener-side acoustics. `insideHideSpot` is intentionally independent from
 * a particular hide-spot id, so audio never receives secret gameplay state.
 */
export interface ListenerAcoustics {
  readonly insideHideSpot: boolean;
  /** 0 is fully closed, 1 is open. Defaults to 0 while hidden and 1 outside. */
  readonly doorOpenness?: number;
  /** Extra authored wall/room obstruction in the 0..1 range. */
  readonly roomOcclusion?: number;
  /** Calm-to-panicked breathing intensity in the 0..1 range. */
  readonly breathIntensity?: number;
}

export interface LockerListeningMix {
  readonly externalGain: number;
  readonly externalLowpassHertz: number;
  readonly externalFilterQ: number;
  readonly breathGain: number;
  readonly threatGainBoost: number;
}

export interface WorldSoundSpatialInput {
  /** Only pass a public/legally audible location; never raw hidden AI state. */
  readonly listenerPosition: Point;
  readonly sourcePosition: Point;
  readonly kind: WorldSoundKind;
  readonly maxDistance: number;
  readonly baseGain?: number;
  readonly occlusion?: number;
  readonly listenerAcoustics?: ListenerAcoustics;
}

export interface WorldSoundSpatialMix {
  readonly distance: number;
  readonly normalizedDistance: number;
  readonly gain: number;
  readonly pan: number;
  readonly lowpassHertz: number;
  readonly priority: number;
}

export interface WorldSoundEvent extends WorldSoundSpatialInput {
  readonly foleySet: FoleySet;
  readonly playbackRate?: number;
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
  /** Optional hide/room state for enclosure filtering and restrained breathing. */
  readonly listenerAcoustics?: ListenerAcoustics;
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
  /** Several resonances and staggered impacts prevent a single-note fallback. */
  readonly fallbackSpectrumHertz: readonly number[];
  readonly fallbackPulseOffsetsSeconds: readonly number[];
  readonly fallbackNoiseMix: number;
  readonly fallbackFilterHertz: number;
}

/** Theme events use the already licensed CC0 Foley pool before synthesis. */
export const THEME_MECHANIC_AUDIO_PROFILES: Readonly<Record<CampaignTheme, ThemeMechanicAudioProfile>> = Object.freeze({
  campus: Object.freeze({
    foleySet: "metal-hit",
    playbackRate: 1.34,
    peakGain: 0.12,
    fallbackHertz: 860,
    fallbackDurationSeconds: 0.52,
    fallbackSpectrumHertz: Object.freeze([430, 862, 1_716]),
    fallbackPulseOffsetsSeconds: Object.freeze([0, 0.17]),
    fallbackNoiseMix: 0.18,
    fallbackFilterHertz: 2_900,
  }),
  hospital: Object.freeze({
    foleySet: "cloth",
    playbackRate: 0.9,
    peakGain: 0.075,
    fallbackHertz: 410,
    fallbackDurationSeconds: 0.68,
    fallbackSpectrumHertz: Object.freeze([205, 574, 1_107]),
    fallbackPulseOffsetsSeconds: Object.freeze([0, 0.24]),
    fallbackNoiseMix: 0.42,
    fallbackFilterHertz: 1_780,
  }),
  "fire-station": Object.freeze({
    foleySet: "cloth",
    playbackRate: 0.7,
    peakGain: 0.115,
    fallbackHertz: 176,
    fallbackDurationSeconds: 0.74,
    fallbackSpectrumHertz: Object.freeze([88, 176, 264, 492]),
    fallbackPulseOffsetsSeconds: Object.freeze([0, 0.12, 0.34]),
    fallbackNoiseMix: 0.58,
    fallbackFilterHertz: 1_320,
  }),
  factory: Object.freeze({
    foleySet: "metal-hit",
    playbackRate: 0.74,
    peakGain: 0.16,
    fallbackHertz: 94,
    fallbackDurationSeconds: 0.72,
    fallbackSpectrumHertz: Object.freeze([94, 251, 407, 582]),
    fallbackPulseOffsetsSeconds: Object.freeze([0, 0.095, 0.31]),
    fallbackNoiseMix: 0.34,
    fallbackFilterHertz: 1_180,
  }),
});

const THEME_SOUND_PROFILES: Readonly<Record<CampaignTheme, ThemeSoundProfile>> = Object.freeze({
  campus: Object.freeze({
    ambienceIdentity: "sunlit corridor air, distant courtyard wash, softened school fabric",
    noiseFilterHertz: 1850,
    noiseGain: 0.014,
    machineryHertz: 46,
    machineryGain: 0.004,
    detailFilterHertz: 2850,
    detailFilterQ: 0.62,
    detailGain: 0.0042,
    detailPulseSeconds: 5.8,
    playerStepHertz: 118,
    chaserStepHertz: 84,
    stepNoiseColorHertz: 1550,
  }),
  hospital: Object.freeze({
    ambienceIdentity: "filtered ventilation, fluorescent air, distant trolley texture",
    noiseFilterHertz: 2700,
    noiseGain: 0.012,
    machineryHertz: 58,
    machineryGain: 0.005,
    detailFilterHertz: 4320,
    detailFilterQ: 1.15,
    detailGain: 0.0034,
    detailPulseSeconds: 7.1,
    playerStepHertz: 145,
    chaserStepHertz: 98,
    stepNoiseColorHertz: 2450,
  }),
  "fire-station": Object.freeze({
    ambienceIdentity: "open engine bay air, canvas movement, restrained radio hash",
    noiseFilterHertz: 930,
    noiseGain: 0.018,
    machineryHertz: 41,
    machineryGain: 0.008,
    detailFilterHertz: 1260,
    detailFilterQ: 0.9,
    detailGain: 0.0058,
    detailPulseSeconds: 4.7,
    playerStepHertz: 92,
    chaserStepHertz: 69,
    stepNoiseColorHertz: 1150,
  }),
  factory: Object.freeze({
    ambienceIdentity: "low extraction rumble, broad machine air, sparse metal grit",
    noiseFilterHertz: 680,
    noiseGain: 0.021,
    machineryHertz: 34,
    machineryGain: 0.011,
    detailFilterHertz: 1740,
    detailFilterQ: 1.4,
    detailGain: 0.0065,
    detailPulseSeconds: 3.9,
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

function normalizeListenerAcoustics(
  acoustics: ListenerAcoustics | undefined,
): Required<ListenerAcoustics> {
  const insideHideSpot = acoustics?.insideHideSpot === true;
  return {
    insideHideSpot,
    doorOpenness: acoustics?.doorOpenness === undefined
      ? insideHideSpot ? 0 : 1
      : clampUnit(acoustics.doorOpenness),
    roomOcclusion: clampUnit(acoustics?.roomOcclusion),
    breathIntensity: clampUnit(acoustics?.breathIntensity),
  };
}

/**
 * The locker is muffled, never deaf. Threat transients retain enough upper-mid
 * energy to read direction, while the player's breath ducks as danger nears.
 */
export function lockerListeningMix(
  acoustics: ListenerAcoustics | undefined,
  threatAudibility = 0,
): LockerListeningMix {
  const listener = normalizeListenerAcoustics(acoustics);
  const threat = clampUnit(threatAudibility);
  const enclosure = listener.insideHideSpot
    ? 1 - listener.doorOpenness * 0.72
    : 0;
  const combinedOcclusion = 1
    - (1 - enclosure) * (1 - listener.roomOcclusion * 0.72);
  const threatReadability = listener.insideHideSpot ? threat : 0;
  return Object.freeze({
    externalGain: Math.max(0.52, 1 - combinedOcclusion * 0.37),
    externalLowpassHertz: Math.max(
      1250 + threatReadability * 520,
      19_500 - combinedOcclusion * 18_250,
    ),
    externalFilterQ: 0.45 + combinedOcclusion * 0.58,
    breathGain: listener.insideHideSpot
      ? (0.006 + listener.breathIntensity * 0.012) * (1 - threat * 0.42)
      : 0,
    threatGainBoost: 1 + threatReadability * 0.2,
  });
}

export function worldSoundPriority(kind: WorldSoundKind): number {
  switch (kind) {
    case "threat-interaction": return 1;
    case "threat-footstep": return 0.92;
    case "objective": return 0.76;
    case "theme-event": return 0.5;
    case "ambient-detail": return 0.22;
  }
}

/**
 * Distance, fixed-camera panning, obstruction and enclosure are resolved in a
 * pure function so gameplay can audit exactly what the player is allowed to
 * hear before scheduling any Web Audio nodes.
 */
export function spatializeWorldSound(input: WorldSoundSpatialInput): WorldSoundSpatialMix {
  const measuredDistance = Math.hypot(
    input.sourcePosition.x - input.listenerPosition.x,
    input.sourcePosition.y - input.listenerPosition.y,
  );
  const maxDistance = Number.isFinite(input.maxDistance)
    ? Math.max(0.25, input.maxDistance)
    : 0.25;
  const distance = Number.isFinite(measuredDistance) ? measuredDistance : maxDistance;
  const normalizedDistance = Math.max(0, Math.min(1, distance / maxDistance));
  const fade = 1 - normalizedDistance * normalizedDistance * (3 - 2 * normalizedDistance);
  const priority = worldSoundPriority(input.kind);
  const obstruction = clampUnit(input.occlusion);
  const baseGain = Number.isFinite(input.baseGain) ? Math.max(0, input.baseGain ?? 1) : 1;
  const locker = lockerListeningMix(
    input.listenerAcoustics,
    input.kind.startsWith("threat-") ? fade : 0,
  );
  // Important threats lose less energy behind authored walls than incidental
  // detail, but the low-pass still communicates that they are obstructed.
  const obstructionLoss = obstruction * (0.56 - priority * 0.24);
  const priorityFloor = input.kind.startsWith("threat-") && normalizedDistance < 1
    ? baseGain * 0.08 * priority * (1 - normalizedDistance)
    : 0;
  const openCutoff = 18_500;
  const obstructedCutoff = 820 + priority * 780;
  return Object.freeze({
    distance,
    normalizedDistance,
    gain: Math.max(
      priorityFloor,
      baseGain
        * fade
        * (1 - obstructionLoss)
        * locker.externalGain
        * (input.kind.startsWith("threat-") ? locker.threatGainBoost : 1),
    ),
    pan: soundPanForWorldPoints(input.listenerPosition, input.sourcePosition),
    lowpassHertz: Math.min(
      locker.externalLowpassHertz,
      openCutoff + (obstructedCutoff - openCutoff) * obstruction,
    ),
    priority,
  });
}

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
  private machineryFilter: BiquadFilterNode | null = null;
  private machinerySource: AudioBufferSourceNode | null = null;
  private detailGain: GainNode | null = null;
  private detailFilter: BiquadFilterNode | null = null;
  private detailSource: AudioBufferSourceNode | null = null;
  private identityGain: GainNode | null = null;
  private identityFilter: BiquadFilterNode | null = null;
  private identitySource: AudioBufferSourceNode | null = null;
  private threatGain: GainNode | null = null;
  private threatFilter: BiquadFilterNode | null = null;
  private threatSource: AudioBufferSourceNode | null = null;
  private enclosureGain: GainNode | null = null;
  private enclosureFilter: BiquadFilterNode | null = null;
  private theme: CampaignTheme;
  private themeMechanicActivity = 0;
  private appliedThemeMechanicActivity = Number.NaN;
  private listenerAcoustics: Required<ListenerAcoustics> = normalizeListenerAcoustics(undefined);
  private appliedListenerMix: LockerListeningMix | null = null;
  private appliedThreatMix: ThreatLayerMix | null = null;
  private threatAudibility = 0;
  private muted = false;
  private disposed = false;
  private lastPlayerStepSeconds = Number.NEGATIVE_INFINITY;
  private lastChaserStepSeconds = Number.NEGATIVE_INFINITY;
  private lastPlayerMarkerSeconds = Number.NEGATIVE_INFINITY;
  private lastChaserMarkerSeconds = Number.NEGATIVE_INFINITY;
  private lastBreathSeconds = Number.NEGATIVE_INFINITY;
  private lastAlertContextSeconds = Number.NEGATIVE_INFINITY;
  private previousChaserMode: ChaserMode = "spawn-delay";
  private readonly activeSources = new Set<AudioScheduledSourceNode>();
  private readonly sourceCleanupNodes = new Map<
    AudioScheduledSourceNode,
    readonly AudioNode[]
  >();
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
      let context: AudioContext | null = null;
      try {
        context = this.createContext();
        if (!context) return false;
        this.context = context;
        this.buildGraph(context);
      } catch {
        await this.abandonFailedGraph(context);
        return false;
      }
      // Existing CC0 Foley starts only after the explicit audio gesture. The
      // new theme identity is already in memory and adds no network request.
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
    if (this.disposed) return;
    if (theme === this.theme) return;
    this.theme = theme;
    this.appliedThemeMechanicActivity = Number.NaN;
    this.appliedThreatMix = null;
    try {
      this.applyThemeMix(0.35);
      this.replaceThemeIdentitySources();
      this.applyThreatMix(this.previousChaserMode, this.threatAudibility);
    } catch {
      // A browser running out of audio nodes should lose the decorative layer,
      // not the game or the mastered adaptive score.
    }
  }

  setMuted(muted: boolean) {
    this.muted = Boolean(muted);
    if (!this.context || !this.master) return;
    try {
      const now = this.context.currentTime;
      this.smoothParameter(
        this.master.gain,
        this.muted ? 0 : 0.72,
        now,
        0.012,
      );
    } catch {
      // Muted state remains authoritative and will be applied if a retry
      // creates a fresh graph.
    }
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
      try {
        this.applyThemeMix(0.18);
      } catch {
        // The returned activity remains deterministic even if automation fails.
      }
    }
    return this.themeMechanicActivity;
  }

  getThemeMechanicActivity(): number {
    return this.themeMechanicActivity;
  }

  /**
   * Applies a single listener-side acoustic model to every external sound.
   * It is safe to call every frame: insignificant changes do not enqueue new
   * automation events. The returned mix is useful for HUD/debug diagnostics.
   */
  setListenerAcoustics(
    acoustics: ListenerAcoustics,
    threatAudibility = this.threatAudibility,
  ): LockerListeningMix {
    this.listenerAcoustics = normalizeListenerAcoustics(acoustics);
    this.threatAudibility = clampUnit(threatAudibility);
    const mix = lockerListeningMix(this.listenerAcoustics, this.threatAudibility);
    if (!this.context || !this.enclosureGain || !this.enclosureFilter) {
      this.appliedListenerMix = mix;
      return mix;
    }
    const previous = this.appliedListenerMix;
    const changed = !previous
      || Math.abs(previous.externalGain - mix.externalGain) >= 0.012
      || Math.abs(previous.externalLowpassHertz - mix.externalLowpassHertz) >= 45
      || Math.abs(previous.externalFilterQ - mix.externalFilterQ) >= 0.025;
    if (!changed) return mix;
    try {
      const now = this.context.currentTime;
      this.smoothParameter(this.enclosureGain.gain, mix.externalGain, now, 0.055);
      this.smoothParameter(
        this.enclosureFilter.frequency,
        mix.externalLowpassHertz,
        now,
        this.listenerAcoustics.insideHideSpot ? 0.07 : 0.045,
      );
      this.smoothParameter(this.enclosureFilter.Q, mix.externalFilterQ, now, 0.075);
      this.appliedListenerMix = mix;
    } catch {
      // Keep the latest listener intent; the next material change may retry
      // automation without destabilizing the render loop.
    }
    return mix;
  }

  /**
   * Plays a theme event with no spatial inputs. A CC0 Foley buffer is preferred
   * whenever decoded; a short synthesized transient is only a load fallback.
   */
  triggerThemeMechanic(): boolean {
    if (!this.context || this.context.state !== "running" || this.disposed) return false;
    try {
      const profile = themeMechanicAudioProfile(this.theme);
      const activityMix = 0.72 + this.themeMechanicActivity * 0.28;
      const sampled = this.playSample(
        profile.foleySet,
        0,
        profile.peakGain * activityMix,
        profile.playbackRate,
      );
      // A quiet material layer gives decoded Foley the same thematic contour;
      // without a decoded sample it becomes the complete network-free fallback.
      this.playThemeMechanicFallback(
        profile,
        activityMix,
        sampled ? 0.24 : 1,
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Plays an authored public world cue with explicit distance, panning and
   * occlusion. The caller is responsible for passing only a location the
   * player may legally infer; hidden AI coordinates must stay outside audio.
   */
  triggerWorldSound(event: WorldSoundEvent): WorldSoundSpatialMix | null {
    if (!this.context || this.context.state !== "running" || this.disposed) return null;
    const mix = spatializeWorldSound({
      ...event,
      listenerAcoustics: event.listenerAcoustics ?? this.listenerAcoustics,
    });
    if (mix.normalizedDistance >= 1 || mix.gain <= 0.0001) return mix;
    try {
      if (this.playSpatialSample(
        event.foleySet,
        mix,
        event.playbackRate ?? 1,
      )) return mix;
      this.playWorldFallback(event.kind, mix);
    } catch {
      // Spatial diagnostics remain useful even when the audio graph refuses a
      // transient node; gameplay never depends on presentation playback.
    }
    return mix;
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
    try {
      this.playFootstep(cue.frequency, cue.colorHertz, cue.pan, cue.peakGain, event.actor);
      return true;
    } catch {
      return false;
    }
  }

  update(frame: SoundscapeFrame) {
    if (!this.context || this.context.state !== "running" || this.disposed) return;
    try {
      this.threatAudibility = clampUnit(frame.chaserAudibility);
      if (frame.listenerAcoustics) {
        this.setListenerAcoustics(frame.listenerAcoustics, this.threatAudibility);
      }
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
        this.lastBreathSeconds = Number.NEGATIVE_INFINITY;
        this.previousChaserMode = "spawn-delay";
        this.appliedThreatMix = null;
      }
      this.applyThreatMix(frame.chaserMode, this.threatAudibility);
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
      if (this.listenerAcoustics.insideHideSpot) {
        const breathCadence = 3.15 - this.threatAudibility * 0.72;
        if (frame.elapsedSeconds - this.lastBreathSeconds >= breathCadence) {
          const listening = lockerListeningMix(this.listenerAcoustics, this.threatAudibility);
          if (listening.breathGain > 0) this.playBreath(listening.breathGain, this.threatAudibility);
          this.lastBreathSeconds = frame.elapsedSeconds;
        }
      }
    } catch {
      // No soundscape node is allowed to break the animation/render frame.
    }
  }

  trigger(event: DiegeticSoundEvent, pan = 0) {
    if (!this.context || this.context.state !== "running" || this.disposed) return;
    try {
      if (event === "alert") {
        if (this.context.currentTime - this.lastAlertContextSeconds < 0.42) return;
        this.lastAlertContextSeconds = this.context.currentTime;
      }
      const sampled = event === "locker-open"
        ? this.playSample("locker-open", pan, 0.19, 1.08)
        : event === "locker-close"
          ? this.playSample("locker-close", pan, 0.2, 1.08)
          : event === "locker-check"
            ? this.playSample("locker-latch", pan, 0.18, 0.96)
            : event === "caught"
              ? this.playSample("caught", pan, 0.24, 0.9)
              : event === "alert" || event === "escaped"
                ? this.playSample(
                    "metal-hit",
                    pan,
                    event === "alert" ? 0.08 : 0.13,
                    event === "alert" ? 0.82 : 1.18,
                  )
                : event === "sight-lost"
                  ? this.playSample("cloth", pan, 0.08, 0.88)
                  : false;
      if (
        event === "locker-open"
        || event === "locker-close"
        || event === "locker-check"
      ) {
        this.playLockerMechanism(event, pan, sampled ? 0.22 : 1);
        return;
      }
      if (event === "alert") {
        this.playThreatTelegraph(pan, sampled ? 0.28 : 1);
        return;
      }
      if (!sampled) this.playNarrativeEventFallback(event, pan);
    } catch {
      // Event playback is deliberately best effort.
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.foleyAbort.abort();
    const context = this.context;
    this.stopAndDisconnectSources();
    this.disconnectPersistentGraph();
    this.clearGraphReferences();
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
    this.master = master;
    // Keep the destination silent until every continuous layer is connected.
    // A running context can otherwise advance early sources while later PCM is
    // generated, then reveal a non-zero sample when the final bus connects.
    master.gain.value = 0;
    master.connect(context.destination);

    const ambienceGain = context.createGain();
    ambienceGain.gain.value = profile.noiseGain;
    this.ambienceGain = ambienceGain;
    const ambienceFilter = context.createBiquadFilter();
    ambienceFilter.type = this.theme === "hospital" ? "highpass" : "lowpass";
    ambienceFilter.frequency.value = profile.noiseFilterHertz;
    ambienceFilter.Q.value = this.theme === "factory" ? 0.8 : 0.45;
    this.ambienceFilter = ambienceFilter;
    ambienceFilter.connect(ambienceGain);
    const ambienceSource = this.trackSource(context.createBufferSource());
    ambienceSource.buffer = this.noiseBuffer(context, 2.4);
    ambienceSource.loop = true;
    ambienceSource.connect(ambienceFilter);
    this.ambienceSource = ambienceSource;
    ambienceSource.start();

    const machineryGain = context.createGain();
    machineryGain.gain.value = profile.machineryGain;
    this.machineryGain = machineryGain;
    const machineryFilter = context.createBiquadFilter();
    machineryFilter.type = "lowpass";
    machineryFilter.frequency.value = profile.machineryHertz;
    machineryFilter.Q.value = 0.72;
    this.machineryFilter = machineryFilter;
    machineryFilter.connect(machineryGain);
    const machinerySource = this.trackSource(context.createBufferSource());
    machinerySource.buffer = this.rumbleBuffer(context, 4.9);
    machinerySource.loop = true;
    machinerySource.connect(machineryFilter);
    this.machinerySource = machinerySource;
    machinerySource.start();

    const detailGain = context.createGain();
    detailGain.gain.value = profile.detailGain;
    this.detailGain = detailGain;
    const detailFilter = context.createBiquadFilter();
    detailFilter.type = "bandpass";
    detailFilter.frequency.value = profile.detailFilterHertz;
    detailFilter.Q.value = profile.detailFilterQ;
    this.detailFilter = detailFilter;
    detailFilter.connect(detailGain);
    const detailSource = this.trackSource(context.createBufferSource());
    detailSource.buffer = this.detailTextureBuffer(context, profile);
    detailSource.loop = true;
    detailSource.connect(detailFilter);
    this.detailSource = detailSource;
    detailSource.start();

    const identity = themeAudioIdentityProfile(this.theme);
    const identityGain = context.createGain();
    identityGain.gain.value = identity.outputGain;
    this.identityGain = identityGain;
    const identityFilter = context.createBiquadFilter();
    identityFilter.type = identity.filterType;
    identityFilter.frequency.value = identity.filterHertz;
    identityFilter.Q.value = identity.filterQ;
    this.identityFilter = identityFilter;
    identityFilter.connect(identityGain);
    const identitySource = this.trackSource(context.createBufferSource());
    identitySource.buffer = this.themeIdentityBuffer(context);
    identitySource.loop = true;
    identitySource.connect(identityFilter);
    this.identitySource = identitySource;
    identitySource.start();

    const threatGain = context.createGain();
    threatGain.gain.value = 0;
    this.threatGain = threatGain;
    const threatFilter = context.createBiquadFilter();
    threatFilter.type = "bandpass";
    threatFilter.frequency.value = identity.threatBodyHertz * 4.1;
    threatFilter.Q.value = 0.62;
    this.threatFilter = threatFilter;
    threatFilter.connect(threatGain);
    const threatSource = this.trackSource(context.createBufferSource());
    threatSource.buffer = this.threatTextureBuffer(context);
    threatSource.loop = true;
    threatSource.connect(threatFilter);
    this.threatSource = threatSource;
    threatSource.start();

    const enclosureGain = context.createGain();
    const listening = lockerListeningMix(this.listenerAcoustics, this.threatAudibility);
    enclosureGain.gain.value = listening.externalGain;
    this.enclosureGain = enclosureGain;
    const enclosureFilter = context.createBiquadFilter();
    enclosureFilter.type = "lowpass";
    enclosureFilter.frequency.value = listening.externalLowpassHertz;
    enclosureFilter.Q.value = listening.externalFilterQ;
    this.enclosureFilter = enclosureFilter;
    enclosureGain.connect(enclosureFilter);
    enclosureFilter.connect(master);
    this.appliedListenerMix = listening;
    ambienceGain.connect(enclosureGain);
    machineryGain.connect(enclosureGain);
    detailGain.connect(enclosureGain);
    identityGain.connect(enclosureGain);
    threatGain.connect(enclosureGain);
    this.appliedThreatMix = threatLayerMixForMode(
      this.theme,
      this.previousChaserMode,
      this.threatAudibility,
    );
    this.smoothParameter(
      master.gain,
      this.muted ? 0 : 0.72,
      context.currentTime,
      0.012,
    );
  }

  private applyThemeMix(timeConstantSeconds: number) {
    if (
      !this.context
      || !this.ambienceGain
      || !this.ambienceFilter
      || !this.machineryGain
      || !this.machineryFilter
      || !this.detailGain
      || !this.detailFilter
      || !this.identityGain
      || !this.identityFilter
    ) return;
    const profile = themeSoundProfile(this.theme);
    const identity = themeAudioIdentityProfile(this.theme);
    const activity = this.themeMechanicActivity;
    const now = this.context.currentTime;
    this.ambienceFilter.type = this.theme === "hospital" ? "highpass" : "lowpass";
    this.detailFilter.type = "bandpass";
    this.smoothParameter(
      this.ambienceFilter.frequency,
      profile.noiseFilterHertz * (1 - activity * 0.18),
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.ambienceGain.gain,
      profile.noiseGain * (1 + activity * 1.1),
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.machineryFilter.frequency,
      profile.machineryHertz * (1 + activity * 0.06),
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.machineryGain.gain,
      profile.machineryGain * (1 + activity * 2.4),
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.detailFilter.frequency,
      profile.detailFilterHertz * (1 - activity * 0.08),
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.detailFilter.Q,
      profile.detailFilterQ,
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.detailGain.gain,
      profile.detailGain * (1 + activity * 0.52),
      now,
      timeConstantSeconds,
    );
    this.identityFilter.type = identity.filterType;
    this.smoothParameter(
      this.identityFilter.frequency,
      identity.filterHertz * (1 + activity * 0.035),
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.identityFilter.Q,
      identity.filterQ,
      now,
      timeConstantSeconds,
    );
    this.smoothParameter(
      this.identityGain.gain,
      identity.outputGain * (1 + activity * 0.28),
      now,
      timeConstantSeconds,
    );
    this.appliedThemeMechanicActivity = activity;
  }

  private smoothParameter(
    parameter: AudioParam,
    value: number,
    now: number,
    timeConstantSeconds: number,
  ) {
    if (typeof parameter.cancelAndHoldAtTime === "function") {
      parameter.cancelAndHoldAtTime(now);
    } else {
      const heldValue = parameter.value;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(heldValue, now);
    }
    parameter.setTargetAtTime(value, now, timeConstantSeconds);
  }

  private applyThreatMix(mode: ChaserMode, audibility: number) {
    if (!this.context || !this.threatGain || !this.threatFilter) return;
    const mix = threatLayerMixForMode(this.theme, mode, audibility);
    const previous = this.appliedThreatMix;
    const changed = !previous
      || Math.abs(previous.gain - mix.gain) >= 0.00035
      || Math.abs(previous.filterHertz - mix.filterHertz) >= 18
      || Math.abs(previous.filterQ - mix.filterQ) >= 0.025;
    if (!changed) return;
    try {
      const now = this.context.currentTime;
      const timeConstant = Math.max(0.018, mix.transitionSeconds / 3);
      this.smoothParameter(
        this.threatGain.gain,
        mix.gain,
        now,
        timeConstant,
      );
      this.smoothParameter(
        this.threatFilter.frequency,
        mix.filterHertz,
        now,
        timeConstant * 1.15,
      );
      this.smoothParameter(
        this.threatFilter.Q,
        mix.filterQ,
        now,
        timeConstant,
      );
      this.appliedThreatMix = mix;
    } catch {
      // Threat state stays in gameplay; failure of this decorative layer does
      // not affect the score controller or simulation.
    }
  }

  private themeIdentityBuffer(context: AudioContext): AudioBuffer {
    // The highest authored partial stays below 3 kHz. A 16 kHz procedural
    // buffer is transparent here and keeps gesture-time generation compact;
    // AudioBufferSourceNode performs the device-rate conversion.
    const generationRate = Math.min(16_000, context.sampleRate);
    const rendered = renderThemeIdentityPcm(this.theme, generationRate);
    return this.pcmBuffer(context, rendered.samples, generationRate);
  }

  private threatTextureBuffer(context: AudioContext): AudioBuffer {
    const generationRate = Math.min(12_000, context.sampleRate);
    return this.pcmBuffer(
      context,
      renderThreatTexturePcm(this.theme, generationRate),
      generationRate,
    );
  }

  private pcmBuffer(
    context: AudioContext,
    samples: Float32Array,
    sampleRate = context.sampleRate,
  ): AudioBuffer {
    const buffer = context.createBuffer(1, Math.max(1, samples.length), sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  private layeredTransientBuffer(
    context: AudioContext,
    options: {
      readonly durationSeconds: number;
      readonly frequenciesHertz: readonly number[];
      readonly pulseOffsetsSeconds?: readonly number[];
      readonly noiseMix: number;
      readonly seed: number;
      readonly shape: "impact" | "swell" | "breath";
    },
  ): AudioBuffer {
    const duration = Math.max(0.08, options.durationSeconds);
    const length = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    const pulses = options.pulseOffsetsSeconds?.length
      ? options.pulseOffsetsSeconds
      : [0];
    let state = options.seed | 0;
    let coloredNoise = 0;
    let peak = 0;
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const white = ((state >>> 0) / 0xffff_ffff) * 2 - 1;
      coloredNoise += (white - coloredNoise) * 0.32;
      const time = index / context.sampleRate;
      let sample = 0;
      for (let pulseIndex = 0; pulseIndex < pulses.length; pulseIndex += 1) {
        const local = time - pulses[pulseIndex];
        if (local < 0 || local >= duration) continue;
        const remaining = Math.max(0.04, duration - pulses[pulseIndex]);
        const phase = Math.max(0, Math.min(1, local / remaining));
        const envelope = options.shape === "impact"
          ? Math.min(1, local / 0.009) * Math.exp(-phase * 5.2)
          : options.shape === "swell"
            ? Math.sin(Math.PI * phase) ** 1.65
            : Math.sin(Math.PI * phase) ** 1.25
              * (0.72 + Math.sin(Math.PI * 2 * phase) * 0.12);
        let tone = 0;
        for (let voice = 0; voice < options.frequenciesHertz.length; voice += 1) {
          const frequency = Math.max(24, options.frequenciesHertz[voice]);
          tone += Math.sin(
            Math.PI * 2 * frequency * local + voice * 0.43,
          ) / (1 + voice * 0.72);
        }
        const pulseWeight = 1 / (1 + pulseIndex * 0.28);
        sample += envelope
          * pulseWeight
          * (
            tone * (1 - options.noiseMix)
            + coloredNoise * options.noiseMix
          );
      }
      channel[index] = sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const normalizer = peak > 0 ? 0.72 / peak : 1;
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] *= normalizer;
    }
    return buffer;
  }

  private playLayeredBuffer(
    buffer: AudioBuffer,
    pan: number,
    gainValue: number,
    filterType: BiquadFilterType,
    filterHertz: number,
    filterQ: number,
    applyListenerEnclosure = true,
  ) {
    const context = this.context;
    if (!context) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    source.buffer = buffer;
    gain.gain.value = Math.max(0, gainValue);
    filter.type = filterType;
    filter.frequency.value = Math.max(24, filterHertz);
    filter.Q.value = Math.max(0.01, filterQ);
    source.connect(gain);
    gain.connect(filter);
    const outputCleanup: AudioNode[] = [];
    filter.connect(this.pannedOutput(
      pan,
      applyListenerEnclosure,
      outputCleanup,
    ));
    this.trackSource(source, [gain, filter, ...outputCleanup]);
    source.start(context.currentTime);
  }

  private playLockerMechanism(
    event: "locker-open" | "locker-close" | "locker-check",
    pan: number,
    supportMix: number,
  ) {
    const context = this.context;
    if (!context) return;
    const identity = themeAudioIdentityProfile(this.theme);
    const duration = event === "locker-check" ? 0.58 : 0.42;
    const base = event === "locker-open"
      ? 104
      : event === "locker-close"
        ? 82
        : 128;
    const pulses = event === "locker-check"
      ? [0, 0.12, 0.31]
      : event === "locker-open"
        ? [0, 0.085]
        : [0, 0.055];
    const buffer = this.layeredTransientBuffer(context, {
      durationSeconds: duration,
      frequenciesHertz: [
        base,
        base * 2.71,
        Math.min(2_800, identity.filterHertz * 0.72),
      ],
      pulseOffsetsSeconds: pulses,
      noiseMix: event === "locker-check" ? 0.42 : 0.31,
      seed: 0x6c617463 ^ event.length,
      shape: "impact",
    });
    this.playLayeredBuffer(
      buffer,
      pan,
      (event === "locker-check" ? 0.074 : 0.062) * supportMix,
      "bandpass",
      event === "locker-check" ? 1_180 : 920,
      0.82,
    );
  }

  private playThreatTelegraph(pan: number, supportMix: number) {
    const context = this.context;
    if (!context) return;
    const identity = themeAudioIdentityProfile(this.theme);
    const buffer = this.layeredTransientBuffer(context, {
      durationSeconds: 0.82,
      frequenciesHertz: [
        identity.threatBodyHertz,
        identity.threatBodyHertz * 1.51,
        identity.threatBodyHertz * 3.17,
      ],
      pulseOffsetsSeconds: [0, 0.19],
      noiseMix: 0.58,
      seed: 0x74687265 ^ Math.floor(identity.tempoBpm),
      shape: "swell",
    });
    this.playLayeredBuffer(
      buffer,
      pan,
      0.058 * supportMix,
      "bandpass",
      identity.threatBodyHertz * 6.2,
      0.72,
    );
  }

  private playNarrativeEventFallback(
    event: Exclude<
      DiegeticSoundEvent,
      "locker-open" | "locker-close" | "locker-check" | "alert"
    >,
    pan: number,
  ) {
    const context = this.context;
    if (!context) return;
    const identity = themeAudioIdentityProfile(this.theme);
    const caught = event === "caught";
    const escaped = event === "escaped";
    const duration = caught ? 0.62 : escaped ? 0.74 : 0.48;
    const buffer = this.layeredTransientBuffer(context, {
      durationSeconds: duration,
      frequenciesHertz: caught
        ? [46, 71, 113]
        : escaped
          ? [196, 293.66, 440]
          : [identity.threatBodyHertz, identity.threatBodyHertz * 1.72],
      pulseOffsetsSeconds: caught ? [0, 0.075] : [0],
      noiseMix: caught ? 0.48 : escaped ? 0.18 : 0.66,
      seed: 0x6576656e ^ event.length,
      shape: caught ? "impact" : "swell",
    });
    this.playLayeredBuffer(
      buffer,
      pan,
      caught ? 0.12 : escaped ? 0.075 : 0.05,
      caught ? "lowpass" : "bandpass",
      caught ? 980 : escaped ? 1_850 : 720,
      0.64,
    );
  }

  private trackSource<T extends AudioScheduledSourceNode>(
    source: T,
    cleanupNodes: readonly AudioNode[] = [],
  ): T {
    this.activeSources.add(source);
    this.sourceCleanupNodes.set(source, cleanupNodes);
    const cleanup = () => {
      this.activeSources.delete(source);
      this.sourceCleanupNodes.delete(source);
      try {
        source.disconnect();
      } catch {
        // A closed AudioContext already released the node.
      }
      for (const node of cleanupNodes) {
        try {
          node.disconnect();
        } catch {
          // Best-effort cleanup for a one-shot graph.
        }
      }
    };
    const eventSource = source as T & {
      addEventListener?: (
        name: string,
        listener: () => void,
        options?: AddEventListenerOptions,
      ) => void;
    };
    eventSource.addEventListener?.("ended", cleanup, { once: true });
    return source;
  }

  private stopAndDisconnectSources() {
    for (const source of [...this.activeSources]) {
      try {
        source.stop();
      } catch {
        // A one-shot source may already have ended.
      }
      try {
        source.disconnect();
      } catch {
        // Context shutdown can make disconnect a no-op or throw.
      }
      for (const node of this.sourceCleanupNodes.get(source) ?? []) {
        try {
          node.disconnect();
        } catch {
          // Best-effort cleanup for transient companion nodes.
        }
      }
      this.sourceCleanupNodes.delete(source);
    }
    this.activeSources.clear();
    this.sourceCleanupNodes.clear();
  }

  private disconnectPersistentGraph() {
    const nodes: Array<AudioNode | null> = [
      this.master,
      this.ambienceGain,
      this.ambienceFilter,
      this.machineryGain,
      this.machineryFilter,
      this.detailGain,
      this.detailFilter,
      this.identityGain,
      this.identityFilter,
      this.threatGain,
      this.threatFilter,
      this.enclosureGain,
      this.enclosureFilter,
    ];
    for (const node of nodes) {
      try {
        node?.disconnect();
      } catch {
        // Closing the context is the final release fallback.
      }
    }
  }

  private clearGraphReferences() {
    this.context = null;
    this.master = null;
    this.ambienceGain = null;
    this.ambienceFilter = null;
    this.ambienceSource = null;
    this.machineryGain = null;
    this.machineryFilter = null;
    this.machinerySource = null;
    this.detailGain = null;
    this.detailFilter = null;
    this.detailSource = null;
    this.identityGain = null;
    this.identityFilter = null;
    this.identitySource = null;
    this.threatGain = null;
    this.threatFilter = null;
    this.threatSource = null;
    this.enclosureGain = null;
    this.enclosureFilter = null;
    this.appliedListenerMix = null;
    this.appliedThreatMix = null;
    this.lastAlertContextSeconds = Number.NEGATIVE_INFINITY;
  }

  private async abandonFailedGraph(context: AudioContext | null) {
    this.stopAndDisconnectSources();
    this.disconnectPersistentGraph();
    this.clearGraphReferences();
    if (context && context.state !== "closed") {
      try {
        await context.close();
      } catch {
        // Returning false is the complete degradation contract.
      }
    }
  }

  private replaceThemeIdentitySources() {
    const context = this.context;
    if (
      !context
      || !this.identityFilter
      || !this.identityGain
      || !this.threatFilter
      || !this.threatGain
      || !this.detailFilter
      || !this.detailGain
    ) return;
    const identity = themeAudioIdentityProfile(this.theme);
    const ambience = themeSoundProfile(this.theme);
    const threat = threatLayerMixForMode(
      this.theme,
      this.previousChaserMode,
      this.threatAudibility,
    );
    const identityBuffer = this.themeIdentityBuffer(context);
    const threatBuffer = this.threatTextureBuffer(context);
    const detailBuffer = this.detailTextureBuffer(context, ambience);
    const nextIdentity = this.trackSource(context.createBufferSource());
    const nextThreat = this.trackSource(context.createBufferSource());
    const nextDetail = this.trackSource(context.createBufferSource());
    nextIdentity.buffer = identityBuffer;
    nextIdentity.loop = true;
    nextIdentity.connect(this.identityFilter);
    nextThreat.buffer = threatBuffer;
    nextThreat.loop = true;
    nextThreat.connect(this.threatFilter);
    nextDetail.buffer = detailBuffer;
    nextDetail.loop = true;
    nextDetail.connect(this.detailFilter);
    const now = context.currentTime;
    this.smoothParameter(this.identityGain.gain, 0, now, 0.045);
    this.identityGain.gain.setTargetAtTime(
      identity.outputGain * (1 + this.themeMechanicActivity * 0.28),
      now + 0.15,
      0.065,
    );
    this.smoothParameter(this.threatGain.gain, 0, now, 0.045);
    this.threatGain.gain.setTargetAtTime(
      threat.gain,
      now + 0.15,
      0.065,
    );
    this.smoothParameter(
      this.threatFilter.frequency,
      threat.filterHertz,
      now,
      0.055,
    );
    this.smoothParameter(this.threatFilter.Q, threat.filterQ, now, 0.055);
    this.smoothParameter(this.detailGain.gain, 0, now, 0.045);
    this.detailGain.gain.setTargetAtTime(
      ambience.detailGain * (1 + this.themeMechanicActivity * 0.52),
      now + 0.15,
      0.065,
    );
    nextIdentity.start(now + 0.11);
    nextThreat.start(now + 0.11);
    nextDetail.start(now + 0.11);
    try {
      this.identitySource?.stop(now + 0.17);
      this.threatSource?.stop(now + 0.17);
      this.detailSource?.stop(now + 0.17);
    } catch {
      // An already-ended old source does not block the new identity.
    }
    this.identitySource = nextIdentity;
    this.threatSource = nextThreat;
    this.detailSource = nextDetail;
    this.appliedThreatMix = threat;
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

  /** Brown-leaning, non-periodic low energy; avoids the audible purity of a tone generator. */
  private rumbleBuffer(context: AudioContext, seconds: number) {
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let state = 0x2f6e2b1;
    let slow = 0;
    let body = 0;
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const white = ((state >>> 0) / 0xffff_ffff) * 2 - 1;
      slow += (white - slow) * 0.012;
      body += (slow - body) * 0.17;
      channel[index] = body * 0.82;
    }
    return buffer;
  }

  /**
   * Sparse air/material movement with deterministic timing. It is deliberately
   * texture rather than melody, leaving score and threat cues unobstructed.
   */
  private detailTextureBuffer(context: AudioContext, profile: ThemeSoundProfile) {
    const seconds = Math.max(8.6, profile.detailPulseSeconds * 2.35);
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let state = 0x1d872b41 ^ Math.floor(profile.detailFilterHertz * 97);
    let colored = 0;
    for (let index = 0; index < length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const white = ((state >>> 0) / 0xffff_ffff) * 2 - 1;
      colored += (white - colored) * (this.theme === "hospital" ? 0.42 : 0.2);
      const secondsAtSample = index / context.sampleRate;
      const pulsePhase = (secondsAtSample % profile.detailPulseSeconds) / profile.detailPulseSeconds;
      const secondaryPhase = (
        (secondsAtSample + profile.detailPulseSeconds * 0.37)
        % (profile.detailPulseSeconds * 1.63)
      ) / (profile.detailPulseSeconds * 1.63);
      const primaryEnvelope = pulsePhase < 0.18
        ? Math.sin((pulsePhase / 0.18) * Math.PI) ** 2
        : 0;
      const secondaryEnvelope = secondaryPhase < 0.09
        ? Math.sin((secondaryPhase / 0.09) * Math.PI) ** 2 * 0.42
        : 0;
      channel[index] = colored * (0.11 + primaryEnvelope * 0.47 + secondaryEnvelope);
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
    const outputCleanup: AudioNode[] = [];
    gain.connect(this.pannedOutput(pan, true, outputCleanup));
    this.trackSource(source, [gain, ...outputCleanup]);
    source.start();
    return true;
  }

  private playSpatialSample(
    set: FoleySet,
    mix: WorldSoundSpatialMix,
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
    source.playbackRate.value = Math.max(0.5, Math.min(1.7, playbackRate));
    const gain = context.createGain();
    gain.gain.value = mix.gain;
    const obstruction = context.createBiquadFilter();
    obstruction.type = "lowpass";
    obstruction.frequency.value = mix.lowpassHertz;
    obstruction.Q.value = 0.58;
    source.connect(gain);
    gain.connect(obstruction);
    // The spatial mix already contains listener enclosure and obstruction;
    // route it to the master to avoid applying the locker low-pass twice.
    const outputCleanup: AudioNode[] = [];
    obstruction.connect(this.pannedOutput(mix.pan, false, outputCleanup));
    this.trackSource(source, [gain, obstruction, ...outputCleanup]);
    source.start();
    return true;
  }

  private playWorldFallback(kind: WorldSoundKind, mix: WorldSoundSpatialMix) {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    // See playSpatialSample: this mix already resolves listener enclosure.
    const outputCleanup: AudioNode[] = [];
    const output = this.pannedOutput(mix.pan, false, outputCleanup);
    const obstruction = context.createBiquadFilter();
    obstruction.type = "lowpass";
    obstruction.frequency.value = mix.lowpassHertz;
    obstruction.Q.value = 0.58;
    obstruction.connect(output);
    const bodyFilter = context.createBiquadFilter();
    bodyFilter.type = kind.startsWith("threat-") ? "bandpass" : "lowpass";
    bodyFilter.frequency.value = kind === "threat-footstep"
      ? themeSoundProfile(this.theme).stepNoiseColorHertz
      : kind === "threat-interaction"
        ? 1180
        : kind === "objective"
          ? 2250
          : 1450;
    bodyFilter.Q.value = kind.startsWith("threat-") ? 0.74 : 0.48;
    bodyFilter.connect(obstruction);
    const gain = context.createGain();
    const duration = kind.startsWith("threat-") ? 0.16 : 0.28;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, mix.gain), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    gain.connect(bodyFilter);
    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer(context, duration + 0.02);
    source.connect(gain);
    this.trackSource(source, [
      gain,
      bodyFilter,
      obstruction,
      ...outputCleanup,
    ]);
    source.start(now);
  }

  private playThemeMechanicFallback(
    profile: ThemeMechanicAudioProfile,
    activityMix: number,
    supportMix: number,
  ) {
    const context = this.context;
    if (!context) return;
    const buffer = this.layeredTransientBuffer(context, {
      durationSeconds: profile.fallbackDurationSeconds,
      frequenciesHertz: profile.fallbackSpectrumHertz,
      pulseOffsetsSeconds: profile.fallbackPulseOffsetsSeconds,
      noiseMix: profile.fallbackNoiseMix,
      seed: 0x6d656368 ^ Math.floor(profile.fallbackHertz * 31),
      shape: this.theme === "hospital" ? "swell" : "impact",
    });
    this.playLayeredBuffer(
      buffer,
      0,
      profile.peakGain * activityMix * 0.7 * supportMix,
      this.theme === "campus" ? "highpass" : "bandpass",
      profile.fallbackFilterHertz,
      this.theme === "factory" ? 1.04 : 0.72,
    );
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
    const listening = lockerListeningMix(this.listenerAcoustics, this.threatAudibility);
    const readablePeak = peakGain * (actor === "chaser" ? listening.threatGainBoost : 1);
    const sampled = this.playSample(
      footstepSetForTheme(this.theme),
      pan,
      readablePeak * (actor === "chaser" ? 1.75 : 1.6),
      actor === "chaser" ? 0.84 : 1.06,
    );
    if (sampled) return;
    const now = context.currentTime;
    const outputCleanup: AudioNode[] = [];
    const output = this.pannedOutput(pan, true, outputCleanup);
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = colorHertz;
    filter.Q.value = 0.7;
    filter.connect(output);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(readablePeak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);
    gain.connect(filter);
    const noise = context.createBufferSource();
    noise.buffer = this.noiseBuffer(context, 0.11);
    noise.connect(gain);
    this.trackSource(noise, [gain, filter]);
    noise.start(now);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(readablePeak * 0.7, now);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    bodyGain.connect(output);
    const body = context.createOscillator();
    body.type = "sine";
    body.frequency.setValueAtTime(frequency, now);
    body.frequency.exponentialRampToValueAtTime(frequency * 0.62, now + 0.1);
    body.connect(bodyGain);
    this.trackSource(body, [bodyGain, ...outputCleanup]);
    body.start(now);
    body.stop(now + 0.12);
  }

  private playBreath(peakGain: number, threatAudibility: number) {
    const context = this.context;
    if (!context || !this.master) return;
    const threat = clampUnit(threatAudibility);
    const duration = 0.94 - threat * 0.14;
    const buffer = this.layeredTransientBuffer(context, {
      durationSeconds: duration,
      frequenciesHertz: [112 + threat * 18, 176 + threat * 24],
      pulseOffsetsSeconds: [0, duration * 0.47],
      noiseMix: 0.82,
      seed: 0x62726561 ^ Math.floor(threat * 997),
      shape: "breath",
    });
    // Mouth air and chest resonance share an envelope but occupy separate
    // bands, giving a close perspective without turning breath into a hiss.
    this.playLayeredBuffer(
      buffer,
      -0.025,
      Math.max(0.0002, peakGain),
      "bandpass",
      690 + threat * 210,
      0.64,
      false,
    );
    this.playLayeredBuffer(
      buffer,
      0.018,
      Math.max(0.0001, peakGain * 0.28),
      "lowpass",
      245 + threat * 42,
      0.52,
      false,
    );
  }

  private pannedOutput(
    pan: number,
    applyListenerEnclosure = true,
    cleanupNodes?: AudioNode[],
  ): AudioNode {
    if (!this.context || !this.master) throw new Error("Soundscape graph is unavailable");
    const externalOutput = applyListenerEnclosure
      ? this.enclosureGain ?? this.master
      : this.master;
    if (
      Math.abs(pan) < 0.0001
      || typeof this.context.createStereoPanner !== "function"
    ) return externalOutput;
    const panner = this.context.createStereoPanner();
    panner.pan.value = Math.max(-0.9, Math.min(0.9, pan));
    panner.connect(externalOutput);
    cleanupNodes?.push(panner);
    return panner;
  }
}
