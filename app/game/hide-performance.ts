import type { PlayerMode, Point } from "./contracts.ts";

export interface PairedHidePresentationRequest {
  readonly mode: PlayerMode;
  readonly playerPosition: Point;
  readonly approach: Point;
  /** Locker-local HideAnchor expressed in level coordinates. */
  readonly lockerAnchor: Point;
  /** Unit direction from the cabinet interior toward its doorway. */
  readonly facing: Point;
  readonly transitionRemainingSeconds: number;
  readonly transitionDurationSeconds: number;
  readonly inwardDistanceCells?: number;
  readonly sideStepCells?: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
const interpolate = (from: Point, to: Point, amount: number): Point => ({
  x: from.x + (to.x - from.x) * amount,
  y: from.y + (to.y - from.y) * amount,
});

/**
 * One locker-local root path shared by enter and exit. The authored skeleton
 * supplies the body performance while this curve prevents the torso and feet
 * from remaining on the door plane: plant at the handle, side-step past the
 * hinged leaf, then settle deeper inside before the close marker.
 */
export function pairedHidePresentationPoint(request: PairedHidePresentationRequest): Point {
  const inward = Math.max(0, request.inwardDistanceCells ?? 0.12);
  const sideStep = Math.max(0, request.sideStepCells ?? 0.065);
  const concealed = {
    x: request.lockerAnchor.x - request.facing.x * inward,
    y: request.lockerAnchor.y - request.facing.y * inward,
  };
  if (["hidden", "entering-peek", "peeking", "exiting-peek"].includes(request.mode)) {
    return concealed;
  }
  if (request.mode !== "entering-hide" && request.mode !== "exiting-hide") {
    return { ...request.playerPosition };
  }

  const progress = clamp01(
    1 - request.transitionRemainingSeconds / Math.max(request.transitionDurationSeconds, 1e-6),
  );
  const travel = smoothstep(clamp01((progress - 0.12) / 0.72));
  const entering = request.mode === "entering-hide";
  const base = entering
    ? interpolate(request.approach, concealed, travel)
    : interpolate(concealed, request.approach, travel);
  // Local +X is the safe side of the consistently left-hinged hero locker.
  // Fade the displacement to zero at both endpoints so logic anchors remain
  // exact and entry/exit are perfect reverses.
  const side = Math.sin(progress * Math.PI) * sideStep;
  return {
    x: base.x + request.facing.y * side,
    y: base.y - request.facing.x * side,
  };
}

