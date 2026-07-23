import type { MoveIntent, Point } from "./contracts.ts";

/**
 * Horizontal direction from the gameplay focus toward the fixed camera.
 * Keeping this in the input adapter makes the screen controls and camera rig
 * share one immutable basis instead of drifting apart as the player turns.
 */
export const FIXED_CAMERA_GROUND_DIRECTION: Readonly<Point> = Object.freeze({
  // A fixed three-quarter azimuth reveals wall depth and prop silhouettes.
  // Input is projected through this same basis below, so controls never flip.
  x: 0.34,
  y: -0.58,
});

export interface FixedCameraGroundBasis {
  /** Horizontal direction from the focus toward the camera (screen-down). */
  readonly cameraBack: Readonly<Point>;
  /** World direction that projects to screen-right. */
  readonly screenRight: Readonly<Point>;
}

const fixedCameraGroundLength = Math.hypot(
  FIXED_CAMERA_GROUND_DIRECTION.x,
  FIXED_CAMERA_GROUND_DIRECTION.y,
) || 1;

const FIXED_CAMERA_GROUND_BASIS: FixedCameraGroundBasis = Object.freeze({
  cameraBack: Object.freeze({
    x: FIXED_CAMERA_GROUND_DIRECTION.x / fixedCameraGroundLength,
    y: FIXED_CAMERA_GROUND_DIRECTION.y / fixedCameraGroundLength,
  }),
  screenRight: Object.freeze({
    x: FIXED_CAMERA_GROUND_DIRECTION.y / fixedCameraGroundLength,
    y: -FIXED_CAMERA_GROUND_DIRECTION.x / fixedCameraGroundLength,
  }),
});

/**
 * Shared immutable screen-space basis for controls, HUD arrows, and audio.
 * Consumers must not approximate this with a generic diagonal: the authored
 * camera azimuth is deliberately not 45 degrees.
 */
export function fixedCameraGroundBasis(): FixedCameraGroundBasis {
  return FIXED_CAMERA_GROUND_BASIS;
}

/**
 * Converts a screen-space stick/keyboard vector into the simulation's world
 * axes. Positive x means screen-right and positive y means screen-down, so the
 * four labelled controls always move in the direction shown on screen.
 */
export function screenMoveToWorld(move: MoveIntent): MoveIntent {
  if (Math.abs(move.x) <= 1e-9 && Math.abs(move.y) <= 1e-9) return { x: 0, y: 0 };
  const { cameraBack, screenRight } = fixedCameraGroundBasis();
  const world = {
    x: screenRight.x * move.x + cameraBack.x * move.y,
    y: screenRight.y * move.x + cameraBack.y * move.y,
  };
  const length = Math.hypot(world.x, world.y);
  const normalized = length <= 1 ? world : { x: world.x / length, y: world.y / length };
  return {
    x: Math.abs(normalized.x) <= 1e-12 ? 0 : normalized.x,
    y: Math.abs(normalized.y) <= 1e-12 ? 0 : normalized.y,
  };
}

/**
 * Space/Enter already activate the focused HTML control. The global game
 * handler must stand down or one key press can both click a button and issue
 * a second gameplay command.
 */
export function shouldIgnoreFocusedControlKey(key: string, focusedControl: boolean): boolean {
  return focusedControl && (key === " " || key === "enter");
}
