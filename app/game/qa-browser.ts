import type { Point } from "./contracts.ts";

/**
 * Parses an opt-in QA scenario coordinate without widening normal gameplay
 * input. The browser evidence harness uses this only when `?qa=...` is present.
 */
export function parseQaPoint(value: string | null): Point | null {
  if (!value) return null;
  const coordinates = value.split(",").map((part) => Number(part.trim()));
  if (
    coordinates.length !== 2
    || coordinates.some((coordinate) => !Number.isFinite(coordinate))
    || coordinates.some((coordinate) => coordinate < 0 || coordinate > 255)
  ) return null;
  return { x: coordinates[0], y: coordinates[1] };
}

/** Returns a one-based campaign level for deterministic browser evidence. */
export function parseQaLevel(value: string | null, levelCount = 10): number | null {
  if (!value) return null;
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1 || level > levelCount) return null;
  return level;
}

/** Bounds opt-in spawn delay used to hold a stable formal-camera art frame. */
export function parseQaDelaySeconds(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) return 0;
  return seconds;
}
