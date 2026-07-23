import type { GameConfig } from "./contracts.ts";
import type { RunRuleset } from "./mastery.ts";

export const GAMEPLAY_PREFERENCES_KEY = "chasing.gameplay-preferences.v1";
export const GAMEPLAY_PREFERENCES_VERSION = 1;

export type HudDensity = "cinematic" | "full";

export interface GameplayPreferences {
  readonly version: typeof GAMEPLAY_PREFERENCES_VERSION;
  readonly ruleset: RunRuleset;
  readonly personalGhostEnabled: boolean;
  readonly hudDensity: HudDensity;
  readonly hapticsEnabled: boolean;
  readonly highContrast: boolean;
  readonly reducedMotion: boolean;
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_GAMEPLAY_PREFERENCES: Readonly<GameplayPreferences> = Object.freeze({
  version: GAMEPLAY_PREFERENCES_VERSION,
  ruleset: "standard",
  personalGhostEnabled: true,
  hudDensity: "cinematic",
  hapticsEnabled: true,
  highContrast: false,
  reducedMotion: false,
});

export function sanitizeGameplayPreferences(value: unknown): GameplayPreferences {
  if (!value || typeof value !== "object") return DEFAULT_GAMEPLAY_PREFERENCES;
  const candidate = value as Partial<GameplayPreferences>;
  return Object.freeze({
    version: GAMEPLAY_PREFERENCES_VERSION,
    ruleset: candidate.ruleset === "assisted" ? "assisted" : "standard",
    personalGhostEnabled: candidate.personalGhostEnabled !== false,
    hudDensity: candidate.hudDensity === "full" ? "full" : "cinematic",
    hapticsEnabled: candidate.hapticsEnabled !== false,
    highContrast: candidate.highContrast === true,
    reducedMotion: candidate.reducedMotion === true,
  });
}

export function loadGameplayPreferences(
  storage: PreferenceStorage,
): GameplayPreferences {
  try {
    const serialized = storage.getItem(GAMEPLAY_PREFERENCES_KEY);
    return serialized
      ? sanitizeGameplayPreferences(JSON.parse(serialized))
      : DEFAULT_GAMEPLAY_PREFERENCES;
  } catch {
    return DEFAULT_GAMEPLAY_PREFERENCES;
  }
}

export function saveGameplayPreferences(
  storage: PreferenceStorage,
  preferences: Readonly<GameplayPreferences>,
): boolean {
  try {
    storage.setItem(
      GAMEPLAY_PREFERENCES_KEY,
      JSON.stringify(sanitizeGameplayPreferences(preferences)),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Assisted mode changes only public difficulty knobs. It never changes maze
 * collision, evidence provenance or the screen-relative input contract.
 */
export function assistedGameplayConfig(
  config: Readonly<Partial<GameConfig>>,
): Readonly<Partial<GameConfig>> {
  const scale = (value: number | undefined, multiplier: number) => (
    value === undefined ? undefined : Number((value * multiplier).toFixed(3))
  );
  return Object.freeze({
    ...config,
    chaserSpeed: scale(config.chaserSpeed, 0.88),
    spawnDelaySeconds: config.spawnDelaySeconds === undefined
      ? undefined
      : Number((config.spawnDelaySeconds + 1.2).toFixed(3)),
    suspiciousSeconds: config.suspiciousSeconds === undefined
      ? undefined
      : Number((config.suspiciousSeconds + 0.18).toFixed(3)),
    lastKnownScanSeconds: config.lastKnownScanSeconds === undefined
      ? undefined
      : Number((config.lastKnownScanSeconds + 0.45).toFixed(3)),
    searchSeconds: scale(config.searchSeconds, 0.82),
    searchWaypointSeconds: scale(config.searchWaypointSeconds, 1.18),
    searchHideCheckBudget: config.searchHideCheckBudget === undefined
      ? undefined
      : Math.max(0, config.searchHideCheckBudget - 1),
    hearingRange: scale(config.hearingRange, 0.85),
    visionRange: scale(config.visionRange, 0.86),
    hideInteractRange: scale(config.hideInteractRange, 1.15),
    hideEnterSeconds: scale(config.hideEnterSeconds, 0.88),
    hideEnterExposureSeconds: scale(config.hideEnterExposureSeconds, 0.88),
    hideExitSeconds: scale(config.hideExitSeconds, 0.88),
    hideExitExposureSeconds: scale(config.hideExitExposureSeconds, 0.88),
  });
}

export type HapticCue =
  | "interaction-ready"
  | "theme-warning"
  | "detected"
  | "hide-latched"
  | "captured"
  | "escaped";

export const HAPTIC_PATTERNS: Readonly<Record<HapticCue, readonly number[]>> = Object.freeze({
  "interaction-ready": Object.freeze([18]),
  "theme-warning": Object.freeze([28, 36, 28]),
  detected: Object.freeze([50, 28, 70]),
  "hide-latched": Object.freeze([18, 24, 18]),
  captured: Object.freeze([90, 45, 120]),
  escaped: Object.freeze([24, 30, 24, 30, 55]),
});

export function playHapticCue(
  cue: HapticCue,
  enabled: boolean,
  vibrate: ((pattern: number | number[]) => boolean) | undefined,
): boolean {
  if (!enabled || !vibrate) return false;
  try {
    return vibrate([...HAPTIC_PATTERNS[cue]]);
  } catch {
    return false;
  }
}
