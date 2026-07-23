import type {
  GameConfig,
  GamePhase,
  LevelDefinition,
  PlayerMode,
  SimulationEvent,
} from "./contracts.ts";
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
export type RunRuleset = "standard" | "assisted";
export type TelemetryThreat = "calm" | "caution" | "active";

export const SAFE_HIDE_EXIT_SECONDS = 2.5;
export const RUN_TELEMETRY_VERSION = 2;

export interface MasteryContext {
  readonly levelId: string;
  readonly theme?: "campus" | "hospital" | "fire-station" | "factory";
  /**
   * Assisted runs keep their own best time and mastery record. Missing means
   * Standard so progress written before v2 remains ranked and migrates safely.
   */
  readonly ruleset?: RunRuleset;
}

export interface MasteryProfile {
  readonly id: string;
  readonly challengeIds: readonly [
    MasteryChallengeId,
    MasteryChallengeId,
    MasteryChallengeId,
  ];
}

/**
 * Per-run facts only. This is intentionally not persisted as campaign
 * progress. Optional v2 fields let legacy telemetry snapshots remain readable.
 */
export interface RunTelemetry {
  detections: number;
  hideEntries: number;
  safeHideExits: number;
  lockerSearches: number;
  readonly masteryContext?: MasteryContext;
  telemetryVersion?: typeof RUN_TELEMETRY_VERSION;
  hideExits?: number;
  threatReacquisitions?: number;
  decoysDeployed?: number;
  decoyInvestigations?: number;
  themeMechanicUses?: number;
  themeMechanicAdvantages?: number;
  routeReplans?: number;
  /** Internal causal ledger; IDs never contain hidden pursuer knowledge. */
  deployedDecoyIds?: readonly string[];
  investigatedDecoyIds?: readonly string[];
  usedThemeMechanicIds?: readonly string[];
  benefitedThemeMechanicIds?: readonly string[];
  lastRouteId?: string | null;
  pendingSafeHideExitSeconds?: number | null;
}

export interface MasteryChallenge {
  id: MasteryChallengeId;
  label: string;
  description: string;
  completed: boolean;
}

export interface MasteryObjective {
  id: MasteryChallengeId;
  label: string;
  description: string;
}

export interface RunMasteryPreview {
  targetSeconds: number;
  profileId: string;
  ruleset: RunRuleset;
  ranked: boolean;
  objectives: readonly MasteryObjective[];
}

export interface RunMasteryResult {
  completedSeconds: number;
  targetSeconds: number;
  profileId: string;
  rank: MasteryRank;
  ruleset: RunRuleset;
  /** Assisted results are valid personal records but never overwrite Standard. */
  ranked: boolean;
  challenges: readonly MasteryChallenge[];
}

export interface StoredMastery {
  rank: MasteryRank;
  challengeIds: readonly MasteryChallengeId[];
  /** Missing on legacy progress written before campaign-specific profiles. */
  profileId?: string;
}

export type RunCausalEvent =
  | { readonly type: "decoy-deployed"; readonly decoyId: string }
  | {
      readonly type: "investigation-completed";
      readonly evidenceId: string;
      readonly source: "decoy" | "theme-mechanic" | "ambient";
    }
  | { readonly type: "theme-mechanic-used"; readonly mechanicId: string }
  | {
      readonly type: "theme-mechanic-advantage";
      readonly mechanicId: string;
      readonly advantage: "masked-sound" | "blocked-vision" | "diverted-pursuer";
    }
  | { readonly type: "route-selected"; readonly routeId: string }
  | {
      readonly type: "route-replanned";
      readonly fromRouteId: string;
      readonly toRouteId: string;
      readonly reason: "threat" | "blocked" | "objective" | "player-choice";
    };

export interface RunTelemetryFrame {
  readonly deltaSeconds: number;
  readonly events: readonly SimulationEvent[];
  readonly phase: GamePhase;
  readonly playerMode: PlayerMode;
  readonly threat: TelemetryThreat;
  readonly causalEvents?: readonly RunCausalEvent[];
}

export const EMPTY_RUN_TELEMETRY: Readonly<RunTelemetry> = Object.freeze({
  detections: 0,
  hideEntries: 0,
  safeHideExits: 0,
  lockerSearches: 0,
  telemetryVersion: RUN_TELEMETRY_VERSION,
  hideExits: 0,
  threatReacquisitions: 0,
  decoysDeployed: 0,
  decoyInvestigations: 0,
  themeMechanicUses: 0,
  themeMechanicAdvantages: 0,
  routeReplans: 0,
  deployedDecoyIds: Object.freeze([]),
  investigatedDecoyIds: Object.freeze([]),
  usedThemeMechanicIds: Object.freeze([]),
  benefitedThemeMechanicIds: Object.freeze([]),
  lastRouteId: null,
  pendingSafeHideExitSeconds: null,
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

const finiteCount = (value: number | undefined) => (
  Number.isFinite(value) ? Math.max(0, Number(value)) : 0
);

const appendUnique = (values: readonly string[] | undefined, value: string): readonly string[] => (
  values?.includes(value) ? values : Object.freeze([...(values ?? []), value])
);

function rulesetFor(telemetry: Readonly<RunTelemetry>): RunRuleset {
  return telemetry.masteryContext?.ruleset === "assisted" ? "assisted" : "standard";
}

export function getMasteryProfile(context?: Readonly<MasteryContext>): MasteryProfile {
  if (!context) return LEGACY_MASTERY_PROFILE;
  return LEVEL_MASTERY_PROFILES[context.levelId]
    ?? (context.theme ? THEME_MASTERY_PROFILES[context.theme] : undefined)
    ?? LEGACY_MASTERY_PROFILE;
}

export function createRunTelemetry(context?: Readonly<MasteryContext>): RunTelemetry {
  const telemetry: RunTelemetry = {
    ...EMPTY_RUN_TELEMETRY,
    deployedDecoyIds: [],
    investigatedDecoyIds: [],
    usedThemeMechanicIds: [],
    benefitedThemeMechanicIds: [],
  };
  if (!context) return telemetry;
  return {
    ...telemetry,
    masteryContext: Object.freeze({ ...context }),
  };
}

/**
 * Compatibility reducer used by the current render loop. It preserves the v1
 * immediate "left the locker" meaning of safeHideExits. New integrations
 * should use applyRunTelemetryFrame(), which proves 2.5 safe seconds.
 */
export function applyRunEvents(telemetry: RunTelemetry, events: readonly SimulationEvent[]): RunTelemetry {
  const next = { ...telemetry };
  for (const event of events) {
    if (event.type === "chaser-mode-changed" && event.to === "chase") {
      if (event.from === "lost-sight") {
        next.threatReacquisitions = finiteCount(next.threatReacquisitions) + 1;
      } else {
        next.detections += 1;
      }
    } else if (event.type === "player-mode-changed") {
      if (event.to === "entering-hide") next.hideEntries += 1;
      if (event.from === "exiting-hide" && event.to === "free") {
        next.hideExits = finiteCount(next.hideExits) + 1;
        next.safeHideExits += 1;
      }
    } else if (event.type === "hide-check-completed") {
      next.lockerSearches += 1;
    }
  }
  return next;
}

/**
 * Strict causal telemetry reducer. A locker exit becomes safe only after the
 * player spends 2.5 continuous seconds free, out of active threat, and alive.
 * Generic empty-locker checks cannot satisfy the decoy objective: the same
 * public evidence ID must first be emitted by a player decoy.
 */
export function applyRunTelemetryFrame(
  telemetry: RunTelemetry,
  frame: Readonly<RunTelemetryFrame>,
): RunTelemetry {
  if (!Number.isFinite(frame.deltaSeconds) || frame.deltaSeconds < 0) {
    throw new Error("Telemetry delta must be a finite non-negative number");
  }

  const next: RunTelemetry = {
    ...telemetry,
    telemetryVersion: RUN_TELEMETRY_VERSION,
    deployedDecoyIds: [...(telemetry.deployedDecoyIds ?? [])],
    investigatedDecoyIds: [...(telemetry.investigatedDecoyIds ?? [])],
    usedThemeMechanicIds: [...(telemetry.usedThemeMechanicIds ?? [])],
    benefitedThemeMechanicIds: [...(telemetry.benefitedThemeMechanicIds ?? [])],
  };
  let startedExitThisFrame = false;

  for (const event of frame.events) {
    if (event.type === "chaser-mode-changed" && event.to === "chase") {
      if (event.from === "lost-sight") {
        next.threatReacquisitions = finiteCount(next.threatReacquisitions) + 1;
      } else {
        next.detections += 1;
      }
    } else if (event.type === "player-mode-changed") {
      if (event.to === "entering-hide") {
        next.hideEntries += 1;
        next.pendingSafeHideExitSeconds = null;
      }
      if (event.from === "exiting-hide" && event.to === "free") {
        next.hideExits = finiteCount(next.hideExits) + 1;
        next.pendingSafeHideExitSeconds = 0;
        startedExitThisFrame = true;
      }
    } else if (event.type === "hide-check-completed") {
      next.lockerSearches += 1;
    } else if (
      event.type === "player-captured"
      || (event.type === "phase-changed" && event.to === "lost")
    ) {
      next.pendingSafeHideExitSeconds = null;
    }
  }

  for (const event of frame.causalEvents ?? []) {
    switch (event.type) {
      case "decoy-deployed": {
        const previousLength = next.deployedDecoyIds?.length ?? 0;
        next.deployedDecoyIds = appendUnique(next.deployedDecoyIds, event.decoyId);
        if ((next.deployedDecoyIds?.length ?? 0) > previousLength) {
          next.decoysDeployed = finiteCount(next.decoysDeployed) + 1;
        }
        break;
      }
      case "investigation-completed": {
        if (
          (event.source === "decoy" || event.source === "theme-mechanic")
          && next.deployedDecoyIds?.includes(event.evidenceId)
          && !next.investigatedDecoyIds?.includes(event.evidenceId)
        ) {
          next.investigatedDecoyIds = appendUnique(next.investigatedDecoyIds, event.evidenceId);
          next.decoyInvestigations = finiteCount(next.decoyInvestigations) + 1;
        }
        break;
      }
      case "theme-mechanic-used": {
        next.themeMechanicUses = finiteCount(next.themeMechanicUses) + 1;
        next.usedThemeMechanicIds = appendUnique(next.usedThemeMechanicIds, event.mechanicId);
        break;
      }
      case "theme-mechanic-advantage": {
        if (
          next.usedThemeMechanicIds?.includes(event.mechanicId)
          && !next.benefitedThemeMechanicIds?.includes(event.mechanicId)
        ) {
          next.benefitedThemeMechanicIds = appendUnique(
            next.benefitedThemeMechanicIds,
            event.mechanicId,
          );
          next.themeMechanicAdvantages = finiteCount(next.themeMechanicAdvantages) + 1;
        }
        break;
      }
      case "route-selected":
        next.lastRouteId = event.routeId;
        break;
      case "route-replanned":
        if (
          event.fromRouteId !== event.toRouteId
          && (next.lastRouteId === undefined || next.lastRouteId === event.fromRouteId)
        ) {
          next.routeReplans = finiteCount(next.routeReplans) + 1;
          next.lastRouteId = event.toRouteId;
        }
        break;
    }
  }

  if (
    !startedExitThisFrame
    && next.pendingSafeHideExitSeconds !== null
    && next.pendingSafeHideExitSeconds !== undefined
  ) {
    const remainsSafe = frame.phase === "playing"
      && frame.playerMode === "free"
      && frame.threat !== "active";
    if (!remainsSafe) {
      next.pendingSafeHideExitSeconds = null;
    } else {
      next.pendingSafeHideExitSeconds += frame.deltaSeconds;
      if (next.pendingSafeHideExitSeconds + 1e-9 >= SAFE_HIDE_EXIT_SECONDS) {
        next.safeHideExits += 1;
        next.pendingSafeHideExitSeconds = null;
      }
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

function objectiveFor(id: MasteryChallengeId, targetSeconds: number): MasteryObjective {
  switch (id) {
    case "hide-and-slip":
      return {
        id,
        label: "藏身脱逃",
        description: `至少完成一次藏身，离柜后安全坚持 ${SAFE_HIDE_EXIT_SECONDS.toFixed(1)} 秒`,
      };
    case "single-sighting":
      return {
        id,
        label: "一次目击",
        description: "整局最多只让追捕者锁定一次",
      };
    case "beat-target":
      return {
        id,
        label: "极速逃生",
        description: `${targetSeconds.toFixed(0)} 秒内抵达出口`,
      };
    case "ghost-escape":
      return {
        id,
        label: "无影脱逃",
        description: "全程不让追捕者锁定目标",
      };
    case "no-hide-clear":
      return {
        id,
        label: "不停步",
        description: "不进入藏身点完成逃生",
      };
    case "double-slip":
      return {
        id,
        label: "双重脱身",
        description: `两次离柜后都安全坚持 ${SAFE_HIDE_EXIT_SECONDS.toFixed(1)} 秒`,
      };
    case "decoy-search":
      return {
        id,
        label: "调虎离山",
        description: "让追捕者调查一次你主动制造的假线索",
      };
    case "no-locker-search":
      return {
        id,
        label: "不留线索",
        description: "不让追捕者完成任何搜柜",
      };
  }
}

export function previewRunMastery(
  level: LevelDefinition,
  config: Partial<GameConfig>,
  context?: Readonly<MasteryContext>,
): RunMasteryPreview {
  const profile = getMasteryProfile(context);
  const targetSeconds = masteryTargetSeconds(level, config);
  const ruleset = context?.ruleset === "assisted" ? "assisted" : "standard";
  return Object.freeze({
    targetSeconds,
    profileId: profile.id,
    ruleset,
    ranked: ruleset === "standard",
    objectives: Object.freeze(profile.challengeIds.map((id) => Object.freeze(
      objectiveFor(id, targetSeconds),
    ))),
  });
}

export function evaluateRunMastery(
  completedSeconds: number,
  targetSeconds: number,
  telemetry: Readonly<RunTelemetry>,
): RunMasteryResult {
  const preciseSeconds = Math.max(0.01, Math.round(completedSeconds * 100) / 100);
  const masteryProfile = getMasteryProfile(telemetry.masteryContext);
  const causalDecoyInvestigations = telemetry.telemetryVersion === RUN_TELEMETRY_VERSION
    ? finiteCount(telemetry.decoyInvestigations)
    : telemetry.lockerSearches;
  const challenges: readonly MasteryChallenge[] = masteryProfile.challengeIds.map((id) => {
    const objective = objectiveFor(id, targetSeconds);
    let completed = false;
    switch (id) {
      case "hide-and-slip":
        completed = telemetry.safeHideExits >= 1;
        break;
      case "single-sighting":
        completed = telemetry.detections <= 1;
        break;
      case "beat-target":
        completed = preciseSeconds <= targetSeconds;
        break;
      case "ghost-escape":
        completed = telemetry.detections === 0;
        break;
      case "no-hide-clear":
        completed = telemetry.hideEntries === 0;
        break;
      case "double-slip":
        completed = telemetry.safeHideExits >= 2;
        break;
      case "decoy-search":
        completed = causalDecoyInvestigations >= 1;
        break;
      case "no-locker-search":
        completed = telemetry.lockerSearches === 0;
        break;
    }
    return { ...objective, completed };
  });
  const completedChallenges = challenges.filter((challenge) => challenge.completed).length;
  const rank: MasteryRank = completedChallenges === challenges.length
    ? "gold"
    : completedChallenges >= 2
      ? "silver"
      : "bronze";
  const ruleset = rulesetFor(telemetry);
  return {
    completedSeconds: preciseSeconds,
    targetSeconds,
    profileId: masteryProfile.id,
    rank,
    ruleset,
    ranked: ruleset === "standard",
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
