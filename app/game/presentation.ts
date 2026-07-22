import type { ChaserMode, GameConfig, GamePhase, PlayerState } from "./contracts.ts";
import type { AnimationState } from "./animation/actor-runtime.ts";

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

/**
 * World rendering is deliberately independent from player knowledge. The
 * chaser remains a physical 3D actor during exposed play and capture; walls
 * and depth provide honest occlusion. A fully concealed player cannot inspect
 * the world until the authored peek/exposure marker, and the resolved escape
 * tableau removes the chaser from the scene.
 */
export function shouldRenderChaserModel(phase: GamePhase, playerVisuallyExposed: boolean): boolean {
  return phase !== "won" && (phase !== "playing" || playerVisuallyExposed);
}

/** Keeps the visible performance contract in lockstep with AI locomotion. */
export function chaserAnimationForMode(
  mode: ChaserMode,
  worldSpeed: number,
  atCheckedLocker: boolean,
): AnimationState {
  switch (mode) {
    case "spawn-delay": return "idle";
    case "patrol": return worldSpeed > 0.1 ? "walk" : "idle";
    case "suspicious": return "alert";
    case "chase": return "run";
    // Arrival can happen between 10 Hz decision ticks. Use actual world
    // displacement for those final frames so the actor plants its feet
    // instead of running in place while the brain enters the scan state.
    case "lost-sight": return worldSpeed > 0.1 ? "run" : "idle";
    case "go-to-last-known": return worldSpeed > 0.1 ? "run" : "idle";
    case "scan-last-known": return "search";
    case "search": return worldSpeed > 0.1 ? "walk" : "search";
    case "check-hide": return atCheckedLocker ? "checkLocker" : "walk";
  }
}

/**
 * Starts a two-actor composition whenever an exposed player can genuinely
 * observe the spawned pursuer, not only after the FSM has entered chase. This
 * gives both first acquisition and search-chain reacquisition a camera lead-in
 * without revealing anything through walls or a closed locker.
 */
export function shouldFrameChaser(
  phase: GamePhase,
  mode: ChaserMode,
  chaserObservable: boolean,
): boolean {
  return phase === "playing"
    && chaserObservable
    && mode !== "spawn-delay";
}

export interface CameraFramingVector {
  x: number;
  y: number;
  z: number;
}

export interface CameraFramingRequest {
  focus: CameraFramingVector;
  points: readonly CameraFramingVector[];
  /** Normalized direction from focus toward the camera. */
  cameraDirection: CameraFramingVector;
  verticalFovDegrees: number;
  aspect: number;
  horizontalMargin?: number;
  verticalMargin?: number;
  safeHorizontalNdc?: number;
  safeVerticalNdc?: number;
}

const vectorLength3 = (value: CameraFramingVector) => Math.hypot(value.x, value.y, value.z);
const normalize3 = (value: CameraFramingVector, fallback: CameraFramingVector): CameraFramingVector => {
  const length = vectorLength3(value);
  return length > 1e-9
    ? { x: value.x / length, y: value.y / length, z: value.z / length }
    : { ...fallback };
};
const dot3 = (left: CameraFramingVector, right: CameraFramingVector) => (
  left.x * right.x + left.y * right.y + left.z * right.z
);
const cross3 = (left: CameraFramingVector, right: CameraFramingVector): CameraFramingVector => ({
  x: left.y * right.z - left.z * right.y,
  y: left.z * right.x - left.x * right.z,
  z: left.x * right.y - left.y * right.x,
});

/**
 * Calculates the minimum focus-to-camera distance needed to keep every actor
 * anchor (plus an authored body margin) inside a safe NDC rectangle. The
 * calculation uses the current smoothed focus, so a chase can expand the view
 * before its midpoint composition has fully settled. Manual zoom is never
 * allowed to undercut this distance.
 */
export function requiredCameraDistanceForFraming(request: CameraFramingRequest): number {
  if (!request.points.length) return 0;
  const direction = normalize3(request.cameraDirection, { x: 0, y: 1, z: 0 });
  const forward = { x: -direction.x, y: -direction.y, z: -direction.z };
  const right = normalize3(cross3(forward, { x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
  const up = normalize3(cross3(right, forward), { x: 0, y: 1, z: 0 });
  const halfFovRadians = Math.min(89, Math.max(1, request.verticalFovDegrees / 2)) * Math.PI / 180;
  const verticalSlope = Math.tan(halfFovRadians);
  const horizontalSlope = verticalSlope * Math.max(0.1, request.aspect);
  const safeHorizontal = Math.min(0.98, Math.max(0.1, request.safeHorizontalNdc ?? 0.82));
  const safeVertical = Math.min(0.98, Math.max(0.1, request.safeVerticalNdc ?? 0.8));
  const horizontalMargin = Math.max(0, request.horizontalMargin ?? 0.9);
  const verticalMargin = Math.max(0, request.verticalMargin ?? 1.05);
  let required = 0;
  for (const point of request.points) {
    const relative = {
      x: point.x - request.focus.x,
      y: point.y - request.focus.y,
      z: point.z - request.focus.z,
    };
    const forwardOffset = dot3(relative, forward);
    const horizontal = (Math.abs(dot3(relative, right)) + horizontalMargin)
      / (horizontalSlope * safeHorizontal) - forwardOffset;
    const vertical = (Math.abs(dot3(relative, up)) + verticalMargin)
      / (verticalSlope * safeVertical) - forwardOffset;
    required = Math.max(required, horizontal, vertical);
  }
  return Math.max(0, required);
}

/**
 * Portrait screens need a slightly closer default composition because their
 * vertical canvas otherwise spends too much space on empty foreground. The
 * exact two-actor framing solver still wins whenever separation requires a
 * wider shot, so this never crops a visible pursuer.
 */
export function baseCameraDistanceForAspect(aspect: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const portraitBlend = Math.min(1, Math.max(0, (0.86 - safeAspect) / 0.4));
  return 16.25 - portraitBlend * 2;
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
