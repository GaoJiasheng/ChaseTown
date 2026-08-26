import { P1_TUNING, P3_TUNING } from "../config/index.js";
import type { AiState, Phase } from "../core/types.js";
export function markerTargetOpacity(phase: Phase, playingElapsedMs: number, threat: number, villainMarker: boolean) {
  if (phase !== "playing") return 1;
  if (villainMarker && threat > 0.6) return 1;
  return playingElapsedMs < P1_TUNING.markerDelayMs ? 1 : 0;
}

export function searchLookOffset(state: AiState, searchArrivedAt: number | null, now: number) {
  if (state !== "search" || searchArrivedAt === null || now < searchArrivedAt) return 0;
  const phase = ((now - searchArrivedAt) / P3_TUNING.searchLookPeriodMs) * Math.PI * 2;
  return Math.sin(phase) * P3_TUNING.searchLookAmplitude;
}
