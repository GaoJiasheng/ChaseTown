import { P1_TUNING } from "../config/index.js";
import type { Phase } from "../core/types.js";
export function markerTargetOpacity(phase: Phase, playingElapsedMs: number, threat: number, villainMarker: boolean) {
  if (phase !== "playing") return 1;
  if (villainMarker && threat > 0.6) return 1;
  return playingElapsedMs < P1_TUNING.markerDelayMs ? 1 : 0;
}
