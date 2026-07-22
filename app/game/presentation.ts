import type { GameConfig, PlayerState } from "./contracts.ts";

export interface LockerDoorClaim {
  owner: "idle" | "player" | "chaser";
  hasAction: boolean;
  actionRunning: boolean;
  queuedActions: number;
  peeking: boolean;
  peekClosing: boolean;
}

/** Player-authored door motion always wins over a concurrent AI inspection. */
export function canChaserTakeLockerDoor(claim: LockerDoorClaim): boolean {
  const playerBusy = claim.owner === "player"
    && (claim.hasAction || claim.queuedActions > 0 || claim.peeking || claim.peekClosing);
  return !playerBusy && !claim.actionRunning && !claim.peekClosing;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Keeps game and authored animation time aligned at ordinary low frame rates,
 * while bounding a long scheduler stall so one frame cannot trigger an
 * unbounded fixed-step catch-up.
 */
export function boundedFrameDeltaSeconds(previousMs: number, nowMs: number, maximumSeconds: number) {
  if (![previousMs, nowMs, maximumSeconds].every(Number.isFinite) || maximumSeconds <= 0) return 0;
  return Math.min(Math.max(0, (nowMs - previousMs) / 1000), maximumSeconds);
}

function smoothstep(value: number, start: number, end: number) {
  const progress = clamp01((value - start) / Math.max(end - start, 1e-6));
  return progress * progress * (3 - 2 * progress);
}

/**
 * Drives the locker view mask from the same authored timing markers used by
 * perception. `cover=1` is fully enclosed; `peek=1` is the open observation
 * slit. This keeps what the player sees aligned with when the AI can see them.
 */
export function lockerVisionMix(
  player: Pick<PlayerState, "mode" | "transitionRemainingSeconds">,
  config: Pick<
    GameConfig,
    | "hideEnterSeconds"
    | "hideEnterExposureSeconds"
    | "hideExitSeconds"
    | "hideExitExposureSeconds"
    | "peekEnterSeconds"
    | "peekExitSeconds"
  >,
): { cover: number; peek: number } {
  switch (player.mode) {
    case "hidden": return { cover: 1, peek: 0 };
    case "entering-peek": {
      const progress = clamp01(1 - player.transitionRemainingSeconds / config.peekEnterSeconds);
      return { cover: 1 - progress, peek: progress };
    }
    case "peeking": return { cover: 0, peek: 1 };
    case "exiting-peek": {
      const openFraction = clamp01(player.transitionRemainingSeconds / config.peekExitSeconds);
      return { cover: 1 - openFraction, peek: openFraction };
    }
    case "entering-hide": {
      const elapsed = config.hideEnterSeconds - player.transitionRemainingSeconds;
      const cover = smoothstep(
        elapsed,
        Math.max(0, config.hideEnterExposureSeconds - 0.34),
        config.hideEnterExposureSeconds,
      );
      return { cover, peek: 0 };
    }
    case "exiting-hide": {
      const elapsed = config.hideExitSeconds - player.transitionRemainingSeconds;
      const opened = smoothstep(
        elapsed,
        config.hideExitExposureSeconds,
        config.hideExitExposureSeconds + 0.28,
      );
      return { cover: 1 - opened, peek: 0 };
    }
    case "free":
    case "aligning-hide":
    case "caught":
    case "escaped":
      return { cover: 0, peek: 0 };
  }
}

/**
 * Frame-rate-independent attack/release used by camera occluders. Entering an
 * obstruction clears the player quickly, while recovery is deliberately
 * slower so a ray grazing a wall corner cannot make the material flicker.
 */
export function smoothOcclusionStrength(current: number, obscured: boolean, deltaSeconds: number) {
  const from = clamp01(current);
  const target = obscured ? 1 : 0;
  const response = obscured ? 12 : 5.5;
  const delta = Math.max(0, deltaSeconds);
  return clamp01(from + (target - from) * (1 - Math.exp(-response * delta)));
}
