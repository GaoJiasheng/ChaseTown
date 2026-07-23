import type { GameConfig, LevelDefinition, SimulationEvent } from "./contracts.ts";
import { DEFAULT_GAME_CONFIG } from "./level.ts";
import { findPath } from "./navigation.ts";

export const MASTERY_CHALLENGE_IDS = [
  "hide-and-slip",
  "single-sighting",
  "beat-target",
] as const;

export type MasteryChallengeId = (typeof MASTERY_CHALLENGE_IDS)[number];
export type MasteryRank = "bronze" | "silver" | "gold";

export interface RunTelemetry {
  detections: number;
  hideEntries: number;
  safeHideExits: number;
  lockerSearches: number;
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
  rank: MasteryRank;
  challenges: readonly MasteryChallenge[];
}

export interface StoredMastery {
  rank: MasteryRank;
  challengeIds: readonly MasteryChallengeId[];
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

export function createRunTelemetry(): RunTelemetry {
  return { ...EMPTY_RUN_TELEMETRY };
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
  const challenges: readonly MasteryChallenge[] = [
    {
      id: "hide-and-slip",
      label: "藏身脱逃",
      description: "至少完成一次藏身，并安全离柜",
      completed: telemetry.safeHideExits >= 1,
    },
    {
      id: "single-sighting",
      label: "一次目击",
      description: "整局最多只让追捕者锁定一次",
      completed: telemetry.detections <= 1,
    },
    {
      id: "beat-target",
      label: "极速逃生",
      description: `${targetSeconds.toFixed(0)} 秒内抵达出口`,
      completed: preciseSeconds <= targetSeconds,
    },
  ];
  const completedChallenges = challenges.filter((challenge) => challenge.completed).length;
  const rank: MasteryRank = completedChallenges === challenges.length
    ? "gold"
    : completedChallenges >= 2
      ? "silver"
      : "bronze";
  return {
    completedSeconds: preciseSeconds,
    targetSeconds,
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
  const rank = !previous || RANK_SCORE[result.rank] > RANK_SCORE[previous.rank]
    ? result.rank
    : previous.rank;
  return { rank, challengeIds };
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
