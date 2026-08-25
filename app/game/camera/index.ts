import * as THREE from "three";

import { P2_TUNING } from "../config/index.js";
import type { AiState, Phase } from "../core/types.js";
export const CAMERA_DIRECTION = Object.freeze({ x: 0.446, y: 0.668, z: 0.595 });
const cameraGroundLength = Math.hypot(CAMERA_DIRECTION.x, CAMERA_DIRECTION.z);
export const SCREEN_UP = Object.freeze({
  x: -CAMERA_DIRECTION.x / cameraGroundLength,
  y: -CAMERA_DIRECTION.z / cameraGroundLength,
});
export const SCREEN_RIGHT = Object.freeze({ x: -SCREEN_UP.y, y: SCREEN_UP.x });

export function threatStateFactor(state: AiState) {
  return state === "chase" || state === "search" ? 1 : P2_TUNING.unawareStateFactor;
}
export function proximityThreat(enemyDistance: number) {
  const span = P2_TUNING.threatFarDistance - P2_TUNING.threatNearDistance;
  const ratio = THREE.MathUtils.clamp((enemyDistance - P2_TUNING.threatNearDistance) / span, 0, 1);
  const smooth = ratio * ratio * (3 - 2 * ratio);
  return 1 - smooth;
}

export function finalThreat(enemyDistance: number, state: AiState, phase: Phase = "playing") {
  if (phase !== "playing") return 0;
  return proximityThreat(enemyDistance) * threatStateFactor(state);
}

export function vignetteStrength(threat: number) {
  return THREE.MathUtils.clamp(
    (threat - P2_TUNING.vignetteDeadzone) / (1 - P2_TUNING.vignetteDeadzone),
    0,
    1,
  );
}


export function shortestAngle(from: number, to: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function dampAngle(from: number, to: number, damping: number, delta: number) {
  return from + shortestAngle(from, to) * (1 - Math.exp(-damping * Math.max(0, delta)));
}
