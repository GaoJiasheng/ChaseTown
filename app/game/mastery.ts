import type { GameConfig, LevelDefinition, SimulationEvent } from "./contracts.ts";
import { DEFAULT_GAME_CONFIG } from "./level.ts";
import { findPath } from "./navigation.ts";

export const MASTERY_CHALLENGE_IDS = [
  "hide-and-slip",
  "single-sighting",
  "beat-target",
  "ghost-escape",
  "no-hide-clear",
  "double-slip",
  "decoy-search",
  "no-locker-search",
] as const;

export type MasteryChallengeId = (typeof MASTERY_CHALLENGE_IDS)[number];
export type MasteryRank = "bronze" | "silver" | "gold";

export interface MasteryContext {
  readonly levelId: string;
  readonly theme?: "campus" | "hospital" | "fire-station" | "factory";
}

export interface MasteryProfile {
  readonly id: string;
  readonly challengeIds: readonly [
    MasteryChallengeId,
    MasteryChallengeId,
    MasteryChallengeId,
  ];
}

export interface RunTelemetry {
  detections: number;
  hideEntries: number;
  safeHideExits: number;
  lockerSearches: number;
  readonly masteryContext?: MasteryContext;
}

export interface MasteryChallenge {
  id: MasteryChallengeId;
  label: string;
  description: string;
  completed: boolean;
}

export interface RunMasteryResult {
  completedSeconds: number;
  targetSeconds: number;
  profileId: string;
  rank: MasteryRank;
  challenges: readonly MasteryChallenge[];
}

export interface StoredMastery {
  rank: MasteryRank;
  challengeIds: readonly MasteryChallengeId[];
  /** Missing on legacy progress written before campaign-specific profiles. */
  profileId?: string;
}

export const EMPTY_RUN_TELEMETRY: Readonly<RunTelemetry> = Object.freeze({
  detections: 0,
  hideEntries: 0,
  safeHideExits: 0,
  lockerSearches: 0,
});

const RANK_SCORE: Readonly<Record<MasteryRank, number>> = Object.freeze({
  bronze: 1,
  silver: 2,
  gold: 3,
});

const profile = (
  id: string,
  challengeIds: MasteryProfile["challengeIds"],
): MasteryProfile => Object.freeze({
  id,
  challengeIds: Object.freeze([...challengeIds]) as unknown as MasteryProfile["challengeIds"],
});

export const LEGACY_MASTERY_PROFILE = profile("legacy:core:v1", [
  "hide-and-slip",
  "single-sighting",
  "beat-target",
]);

const THEME_MASTERY_PROFILES: Readonly<Record<NonNullable<MasteryContext["theme"]>, MasteryProfile>> = Object.freeze({
  campus: profile("theme:campus:v2", ["ghost-escape", "hide-and-slip", "beat-target"]),
  hospital: profile("theme:hospital:v2", ["double-slip", "single-sighting", "no-locker-search"]),
  "fire-station": profile("theme:fire-station:v2", ["double-slip", "single-sighting", "beat-target"]),
  factory: profile("theme:factory:v2", ["no-hide-clear", "single-sighting", "beat-target"]),
});

const LEVEL_MASTERY_PROFILES: Readonly<Record<string, MasteryProfile>> = Object.freeze({
  "school-maze-v1": profile("level:school-maze-v1:v2", ["ghost-escape", "hide-and-slip", "beat-target"]),
  "campus-library-lockdown": profile("level:campus-library-lockdown:v2", ["no-hide-clear", "ghost-escape", "beat-target"]),
  "campus-science-wing": profile("level:campus-science-wing:v2", ["decoy-search", "single-sighting", "beat-target"]),
  "hospital-outpatient-afterhours": profile("level:hospital-outpatient-afterhours:v2", ["double-slip", "decoy-search", "single-sighting"]),
  "hospital-isolation-basement": profile("level:hospital-isolation-basement:v2", ["double-slip", "single-sighting", "no-locker-search"]),
  "fire-station-engine-bay": profile("level:fire-station-engine-bay:v2", ["ghost-escape", "double-slip", "no-locker-search"]),
  "fire-station-training-tower": profile("level:fire-station-training-tower:v2", ["double-slip", "single-sighting", "beat-target"]),
  "factory-assembly-nightshift": profile("level:factory-assembly-nightshift:v2", ["no-hide-clear", "single-sighting", "beat-target"]),
  "factory-turbine-hall": profile("level:factory-turbine-hall:v2", ["ghost-escape", "hide-and-slip", "beat-target"]),
  "factory-foundry-final-run": profile("level:factory-foundry-final-run:v2", ["double-slip", "single-sighting", "beat-target"]),
});

export function getMasteryProfile(context?: Readonly<MasteryContext>): MasteryProfile {
  if (!context) return LEGACY_MASTERY_PROFILE;
  return LEVEL_MASTERY_PROFILES[context.levelId]
    ?? (context.theme ? THEME_MASTERY_PROFILES[context.theme] : undefined)
    ?? LEGACY_MASTERY_PROFILE;
}

export function createRunTelemetry(context?: Readonly<MasteryContext>): RunTelemetry {
  if (!context) return { ...EMPTY_RUN_TELEMETRY };
  return {
    ...EMPTY_RUN_TELEMETRY,
    masteryContext: Object.freeze({ ...context }),
  };
}

/**
 * Keeps run-stat collection deterministic and independent from rendering.
 * A detection is counted when the pursuer commits to a fresh chase, rather
 * than during every intermediate suspicious/search state transition.
 */
export function applyRunEvents(telemetry: RunTelemetry, events: readonly SimulationEvent[]): RunTelemetry {
  const next = { ...telemetry };
  for (const event of events) {
    if (event.type === "chaser-mode-changed" && event.to === "chase" && event.from !== "lost-sight") {
      next.detections += 1;
    } else if (event.type === "player-mode-changed") {
      if (event.to === "entering-hide") next.hideEntries += 1;
      if (event.from === "exiting-hide" && event.to === "free") next.safeHideExits += 1;
    } else if (event.type === "hide-check-completed") {
      next.lockerSearches += 1;
    }
  }
  return next;
}

export function masteryTargetSeconds(level: LevelDefinition, config: Partial<GameConfig>): number {
  const shortestPathCells = Math.max(1, findPath(level, level.playerStart, level.exit).length - 1);
  const playerSpeed = config.playerSpeed ?? DEFAULT_GAME_CONFIG.playerSpeed;
  const hideEnterSeconds = config.hideEnterSeconds ?? DEFAULT_GAME_CONFIG.hideEnterSeconds;
  const hideExitSeconds = config.hideExitSeconds ?? DEFAULT_GAME_CONFIG.hideExitSeconds;
  const directTravelSeconds = shortestPathCells / Math.max(0.1, playerSpeed);
  const authoredHideBeatSeconds = hideEnterSeconds + hideExitSeconds + 5;
  return Math.max(20, Math.round(directTravelSeconds * 1.85 + authoredHideBeatSeconds));
}

export function evaluateRunMastery(
  completedSeconds: number,
  targetSeconds: number,
  telemetry: Readonly<RunTelemetry>,
): RunMasteryResult {
  const preciseSeconds = Math.max(0.01, Math.round(completedSeconds * 100) / 100);
  const masteryProfile = getMasteryProfile(telemetry.masteryContext);
  const challenges: readonly MasteryChallenge[] = masteryProfile.challengeIds.map((id) => {
    switch (id) {
      case "hide-and-slip":
        return {
          id,
          label: "藏身脱逃",
          description: "至少完成一次藏身，并安全离柜",
          completed: telemetry.safeHideExits >= 1,
        };
      case "single-sighting":
        return {
          id,
          label: "一次目击",
          description: "整局最多只让追捕者锁定一次",
          completed: telemetry.detections <= 1,
        };
      case "beat-target":
        return {
          id,
          label: "极速逃生",
          description: `${targetSeconds.toFixed(0)} 秒内抵达出口`,
          completed: preciseSeconds <= targetSeconds,
        };
      case "ghost-escape":
        return {
          id,
          label: "无影脱逃",
          description: "全程不让追捕者锁定目标",
          completed: telemetry.detections === 0,
        };
      case "no-hide-clear":
        return {
          id,
          label: "不停步",
          description: "不进入藏身点完成逃生",
          completed: telemetry.hideEntries === 0,
        };
      case "double-slip":
        return {
          id,
          label: "双重脱身",
          description: "完成两次藏身并安全离柜",
          completed: telemetry.safeHideExits >= 2,
        };
      case "decoy-search":
        return {
          id,
          label: "调虎离山",
          description: "诱导追捕者完成一次空柜搜查",
          completed: telemetry.lockerSearches >= 1,
        };
      case "no-locker-search":
        return {
          id,
          label: "不留线索",
          description: "不让追捕者完成任何搜柜",
          completed: telemetry.lockerSearches === 0,
        };
    }
  });
  const completedChallenges = challenges.filter((challenge) => challenge.completed).length;
  const rank: MasteryRank = completedChallenges === challenges.length
    ? "gold"
    : completedChallenges >= 2
      ? "silver"
      : "bronze";
  return {
    completedSeconds: preciseSeconds,
    targetSeconds,
    profileId: masteryProfile.id,
    rank,
    challenges,
  };
}

export function mergeStoredMastery(
  previous: StoredMastery | undefined,
  result: RunMasteryResult,
): StoredMastery {
  const earned = result.challenges
    .filter((challenge) => challenge.completed)
    .map((challenge) => challenge.id);
  const challengeIds = MASTERY_CHALLENGE_IDS.filter((id) => (
    previous?.challengeIds.includes(id) || earned.includes(id)
  ));
  const previousProfileId = previous?.profileId ?? LEGACY_MASTERY_PROFILE.id;
  const profileChanged = Boolean(previous && previousProfileId !== result.profileId);
  const migratedPreviousRank = profileChanged && previous?.rank === "gold"
    ? "silver"
    : previous?.rank;
  const rank = !migratedPreviousRank || RANK_SCORE[result.rank] > RANK_SCORE[migratedPreviousRank]
    ? result.rank
    : migratedPreviousRank;
  return result.profileId === LEGACY_MASTERY_PROFILE.id
    ? { rank, challengeIds }
    : { rank, challengeIds, profileId: result.profileId };
}

export function personalBestDelta(
  previousBestSeconds: number | undefined,
  completedSeconds: number,
): { isPersonalBest: boolean; deltaSeconds: number | null } {
  if (!previousBestSeconds) return { isPersonalBest: true, deltaSeconds: null };
  const deltaSeconds = Math.round((completedSeconds - previousBestSeconds) * 100) / 100;
  return {
    isPersonalBest: deltaSeconds < 0,
    deltaSeconds,
  };
}
