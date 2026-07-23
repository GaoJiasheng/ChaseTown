import type { MoveIntent } from "./contracts.ts";

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface VirtualStickSample extends MoveIntent {
  /** 0..1 distance after the dead zone has been removed. */
  readonly strength: number;
  /** Pixel displacement used to place the visual thumb. */
  readonly thumbX: number;
  readonly thumbY: number;
}

const finite = (value: number) => Number.isFinite(value) ? value : 0;

/**
 * Samples a circular analogue stick with radial clamping and a smooth dead
 * zone. Positive y is screen-down, matching the fixed-camera input adapter.
 */
export function sampleVirtualStick(
  center: ScreenPoint,
  pointer: ScreenPoint,
  radiusPixels: number,
  deadZoneRatio = 0.12,
): VirtualStickSample {
  const radius = Math.max(1, finite(radiusPixels));
  const deadZone = Math.max(0, Math.min(0.8, finite(deadZoneRatio)));
  const rawX = finite(pointer.x) - finite(center.x);
  const rawY = finite(pointer.y) - finite(center.y);
  const rawLength = Math.hypot(rawX, rawY);
  if (rawLength <= radius * deadZone || rawLength <= 1e-9) {
    return { x: 0, y: 0, strength: 0, thumbX: 0, thumbY: 0 };
  }
  const clampedLength = Math.min(radius, rawLength);
  const directionX = rawX / rawLength;
  const directionY = rawY / rawLength;
  const normalizedLength = clampedLength / radius;
  const strength = Math.min(
    1,
    Math.max(0, (normalizedLength - deadZone) / (1 - deadZone)),
  );
  return {
    x: directionX * strength,
    y: directionY * strength,
    strength,
    thumbX: directionX * clampedLength,
    thumbY: directionY * clampedLength,
  };
}

/** Combines keyboard and touch intent without allowing diagonal speed boosts. */
export function combineScreenMove(
  keyboard: MoveIntent,
  analogue: MoveIntent,
): MoveIntent {
  const x = finite(keyboard.x) + finite(analogue.x);
  const y = finite(keyboard.y) + finite(analogue.y);
  const length = Math.hypot(x, y);
  if (length <= 1) return { x, y };
  return { x: x / length, y: y / length };
}
