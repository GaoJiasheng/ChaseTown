import type {
  ChaserState,
  GameConfig,
  LevelDefinition,
  PerceptionEvidence,
  PlayerMode,
  Point,
  SoundEvidenceSourceType,
} from "./contracts.ts";
import { distanceBetween, findPath, hasLineOfSight, normalizeVector } from "./navigation.ts";

/** Full target truth is intentionally accepted only by this module. */
export interface PerceptionTarget {
  position: Point;
  mode: PlayerMode;
  hideSpotId: string | null;
  transitionRemainingSeconds: number;
  /**
   * Public visual disturbance authored by the active hide archetype. Zero is
   * fully concealed; partial values reduce legal acquisition range. This is
   * never a private concealed coordinate or occupancy query.
   */
  visualExposureMultiplier?: number;
}

export interface SoundStimulus {
  readonly position: Point;
  /** Normalized authored loudness. Values outside [0, 1] are clamped. */
  readonly strength: number;
  /** Explicit public provenance; authored mechanisms should never pose as footsteps. */
  readonly sourceType?: SoundEvidenceSourceType;
  /** Stable id enables fair, deterministic habituation to a repeatedly abused emitter. */
  readonly sourceId?: string;
  /** Authored reliability before distance attenuation. */
  readonly confidence?: number;
  /** Linear reliability loss per second after the sample is heard. */
  readonly decayPerSecond?: number;
}

/**
 * Converts a world sound into deliberately imprecise evidence. Navigable
 * distance models sound travelling around walls, while the reported point
 * stops short of the true source by at least the configured uncertainty.
 */
export function sampleSoundPerception(
  level: LevelDefinition,
  observer: Pick<ChaserState, "position">,
  stimulus: SoundStimulus,
  config: Pick<GameConfig, "hearingRange" | "soundUncertaintyCells">,
  observedAtSeconds: number,
): PerceptionEvidence {
  const authoredStrength = Math.min(1, Math.max(0, stimulus.strength));
  if (authoredStrength <= 0) return { kind: "none", observedAtSeconds };

  const route = findPath(level, observer.position, stimulus.position);
  if (!route.length) return { kind: "none", observedAtSeconds };
  const distance = route.length - 1;
  const audibleRange = Math.max(0, config.hearingRange) * authoredStrength;
  if (distance > audibleRange) return { kind: "none", observedAtSeconds };

  const uncertainty = Math.max(0, config.soundUncertaintyCells);
  const uncertaintySteps = Math.min(
    distance,
    Math.ceil(uncertainty / Math.max(authoredStrength, 0.25)),
  );
  const reportedIndex = Math.max(0, route.length - 1 - uncertaintySteps);
  const attenuatedStrength = authoredStrength * (1 - distance / Math.max(audibleRange + 1, 1));
  const perceivedStrength = Math.min(1, Math.max(0.01, attenuatedStrength));
  const authoredConfidence = Number.isFinite(stimulus.confidence)
    ? Math.min(1, Math.max(0, stimulus.confidence ?? 1))
    : 1;
  return {
    kind: "sound",
    position: { ...route[reportedIndex] },
    strength: perceivedStrength,
    observedAtSeconds,
    sourceType: stimulus.sourceType ?? "unknown",
    ...(stimulus.sourceId ? { sourceId: stimulus.sourceId } : {}),
    confidence: Math.min(1, perceivedStrength * authoredConfidence),
    decayPerSecond: Number.isFinite(stimulus.decayPerSecond)
      ? Math.max(0, stimulus.decayPerSecond ?? 0)
      : 0,
  };
}

export function playerVisualExposureMultiplier(
  target: Pick<PerceptionTarget, "mode" | "transitionRemainingSeconds" | "visualExposureMultiplier">,
  config: Pick<GameConfig, "hideEnterSeconds" | "hideEnterExposureSeconds" | "hideExitSeconds" | "hideExitExposureSeconds">,
): number {
  const authoredMultiplier = Number.isFinite(target.visualExposureMultiplier)
    ? Math.min(1, Math.max(0, target.visualExposureMultiplier ?? 1))
    : target.mode === "hidden"
      ? 0
      : 1;
  const fullyExposed = (() => {
    switch (target.mode) {
      case "free":
      case "aligning-hide":
      case "peeking":
      case "caught":
      case "escaped": return true;
      case "exiting-peek":
        // A tap released before the opening transition advances produces one
        // logical closing frame with zero remaining open time. The visual mask
        // is already fully shut, so perception must not see through that frame.
        return target.transitionRemainingSeconds > 1e-6;
      case "entering-hide":
        return config.hideEnterSeconds - target.transitionRemainingSeconds < config.hideEnterExposureSeconds;
      case "exiting-hide":
        return config.hideExitSeconds - target.transitionRemainingSeconds >= config.hideExitExposureSeconds;
      case "entering-peek": return false;
      case "hidden": return authoredMultiplier > 0;
    }
  })();
  return fullyExposed ? authoredMultiplier : 0;
}

export function isPlayerVisuallyExposed(
  target: Pick<PerceptionTarget, "mode" | "transitionRemainingSeconds" | "visualExposureMultiplier">,
  config: Pick<GameConfig, "hideEnterSeconds" | "hideEnterExposureSeconds" | "hideExitSeconds" | "hideExitExposureSeconds">,
): boolean {
  return playerVisualExposureMultiplier(target, config) > 0;
}

export function samplePlayerPerception(
  level: LevelDefinition,
  observer: Pick<ChaserState, "position" | "heading">,
  target: PerceptionTarget,
  config: GameConfig,
  observedAtSeconds: number,
): PerceptionEvidence {
  const exposureMultiplier = playerVisualExposureMultiplier(target, config);
  if (exposureMultiplier <= 0) return { kind: "none", observedAtSeconds };

  const offset = { x: target.position.x - observer.position.x, y: target.position.y - observer.position.y };
  const distance = distanceBetween(observer.position, target.position);
  if (
    distance > config.visionRange * exposureMultiplier
    || !hasLineOfSight(level, observer.position, target.position)
  ) {
    return { kind: "none", observedAtSeconds };
  }

  if (distance > config.proximitySenseRange) {
    const forward = normalizeVector(observer.heading);
    const direction = normalizeVector(offset);
    const threshold = Math.cos((config.visionConeDegrees * Math.PI) / 360);
    if (forward.x * direction.x + forward.y * direction.y < threshold) {
      return { kind: "none", observedAtSeconds };
    }
  }

  if (target.mode === "entering-hide" && target.hideSpotId) {
    return {
      kind: "hide-entry-visible",
      hideSpotId: target.hideSpotId,
      position: { ...target.position },
      observedAtSeconds,
    };
  }
  return { kind: "player-visible", position: { ...target.position }, observedAtSeconds };
}
