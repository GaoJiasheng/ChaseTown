import type {
  ChaserState,
  GameConfig,
  LevelDefinition,
  PerceptionEvidence,
  PlayerMode,
  Point,
} from "./contracts.ts";
import { distanceBetween, hasLineOfSight, normalizeVector } from "./navigation.ts";

/** Full target truth is intentionally accepted only by this module. */
export interface PerceptionTarget {
  position: Point;
  mode: PlayerMode;
  hideSpotId: string | null;
  transitionRemainingSeconds: number;
}

export function isPlayerVisuallyExposed(
  target: Pick<PerceptionTarget, "mode" | "transitionRemainingSeconds">,
  config: Pick<GameConfig, "hideEnterSeconds" | "hideEnterExposureSeconds" | "hideExitSeconds" | "hideExitExposureSeconds">,
): boolean {
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
    case "hidden":
    case "entering-peek": return false;
  }
}

export function samplePlayerPerception(
  level: LevelDefinition,
  observer: Pick<ChaserState, "position" | "heading">,
  target: PerceptionTarget,
  config: GameConfig,
  observedAtSeconds: number,
): PerceptionEvidence {
  if (!isPlayerVisuallyExposed(target, config)) return { kind: "none", observedAtSeconds };

  const offset = { x: target.position.x - observer.position.x, y: target.position.y - observer.position.y };
  const distance = distanceBetween(observer.position, target.position);
  if (distance > config.visionRange || !hasLineOfSight(level, observer.position, target.position)) {
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
