import type {
  GameConfig,
  GamePhase,
  LevelDefinition,
  PlayerMode,
  Point,
  SimulationEvent,
} from "./contracts.ts";
import { DEFAULT_GAME_CONFIG } from "./level.ts";
import { findPath, isWalkable } from "./navigation.ts";
import {
  auditThemeMissionSoftlock,
  planThemeMissionPlacements,
  themeMissionDefinition,
  type MissionObjectivePlacement,
  type ThemeMissionDefinition,
} from "./theme-objectives.ts";

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
export const STANDARD_MASTERY_EXECUTION_MARGIN = 0.18;
export const ASSISTED_MASTERY_EXECUTION_MARGIN = 0.28;

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

export interface ThemeMasteryMissionRoute {
  readonly kind?: "theme";
  readonly definition: ThemeMissionDefinition;
  readonly placements: readonly MissionObjectivePlacement[];
}

export interface OrderedMasteryMissionObjective {
  readonly id: string;
  readonly position: Point;
  readonly commitmentSeconds: number;
}

/**
 * A runtime-authored linear route. Array order is authoritative: mastery must
 * prove spawn → objective[0..n] → the active level exit, never substitute a
 * shorter permutation.
 */
export interface OrderedMasteryMissionRoute {
  readonly kind: "ordered";
  readonly id: string;
  readonly objectives: readonly OrderedMasteryMissionObjective[];
}

export type MasteryMissionRoute =
  | ThemeMasteryMissionRoute
  | OrderedMasteryMissionRoute;

export interface OrderedMasteryMissionLegAudit {
  readonly fromId: "spawn" | string;
  readonly toId: "exit" | string;
  readonly reachable: boolean;
  readonly distanceCells: number | null;
}

export interface OrderedMasteryMissionAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly objectiveIds: readonly string[];
  readonly legs: readonly OrderedMasteryMissionLegAudit[];
  readonly routeDistanceCells: number | null;
  readonly objectiveSeconds: number;
}

export interface MasteryTargetOptions {
  readonly context?: Readonly<MasteryContext>;
  /**
   * Runtime-authored routes take priority (notably certified Remix variants
   * and G2 branching plans). Use kind:"ordered" when objective sequence is
   * gameplay-authoritative. Campaign originals otherwise receive the
   * deterministic route plan from theme-objectives.
   */
  readonly mission?: Readonly<MasteryMissionRoute> | null;
  readonly challengeIds?: readonly MasteryChallengeId[];
  readonly executionMarginRatio?: number;
}

export interface MasteryTargetPlan {
  readonly targetSeconds: number;
  readonly ruleset: RunRuleset;
  readonly directRouteDistanceCells: number;
  readonly missionRouteDistanceCells: number;
  readonly missionObjectiveSeconds: number;
  /** Time during which a mastery-required transition prevents movement. */
  readonly challengeForcedSeconds: number;
  readonly theoreticalMinimumSeconds: number;
  readonly executionMarginRatio: number;
  readonly executionMarginSeconds: number;
  readonly mission: MasteryMissionRoute | null;
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

function campaignThemeFor(
  level: LevelDefinition,
  context?: Readonly<MasteryContext>,
): MasteryContext["theme"] | undefined {
  if (context?.theme) return context.theme;
  const candidate = level as LevelDefinition & {
    readonly campaign?: { readonly theme?: unknown };
  };
  const theme = candidate.campaign?.theme;
  return theme === "campus"
    || theme === "hospital"
    || theme === "fire-station"
    || theme === "factory"
    ? theme
    : undefined;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function freezeOrderedMissionRoute(
  route: Readonly<OrderedMasteryMissionRoute>,
): OrderedMasteryMissionRoute {
  return Object.freeze({
    kind: "ordered",
    id: route.id,
    objectives: Object.freeze(route.objectives.map((objective) => Object.freeze({
      id: objective.id,
      position: Object.freeze({ ...objective.position }),
      commitmentSeconds: objective.commitmentSeconds,
    }))),
  });
}

function freezeThemeMissionRoute(
  route: Readonly<ThemeMasteryMissionRoute>,
): ThemeMasteryMissionRoute {
  return Object.freeze({
    kind: "theme",
    definition: route.definition,
    placements: Object.freeze([...route.placements]),
  });
}

/**
 * Audits a linear runtime route without widening ThemeMissionDefinition.
 * This is used by branching missions after one plan and one physical exit are
 * selected. It rejects malformed authoring and proves every exact leg.
 */
export function auditOrderedMasteryMissionRoute(
  level: LevelDefinition,
  route: Readonly<OrderedMasteryMissionRoute>,
): OrderedMasteryMissionAudit {
  const failures: string[] = [];
  const legs: OrderedMasteryMissionLegAudit[] = [];
  const objectiveIds = route.objectives.map(({ id }) => id);
  let objectiveSeconds = 0;

  if (!route.id.trim()) failures.push("Ordered mastery mission id must not be empty");
  if (route.objectives.length === 0) {
    failures.push("Ordered mastery mission requires at least one objective");
  }
  const seen = new Set<string>();
  for (const objective of route.objectives) {
    if (!objective.id.trim()) {
      failures.push("Ordered mastery objective id must not be empty");
    } else if (seen.has(objective.id)) {
      failures.push(`Duplicate ordered mastery objective ${objective.id}`);
    }
    seen.add(objective.id);
    if (
      !Number.isFinite(objective.position.x)
      || !Number.isFinite(objective.position.y)
    ) {
      failures.push(`Ordered mastery objective ${objective.id} has an invalid position`);
    } else if (!isWalkable(level, objective.position)) {
      failures.push(`Ordered mastery objective ${objective.id} is not on a walkable cell`);
    }
    if (
      !Number.isFinite(objective.commitmentSeconds)
      || objective.commitmentSeconds < 0
    ) {
      failures.push(`Ordered mastery objective ${objective.id} has an invalid commitment time`);
    } else {
      objectiveSeconds += objective.commitmentSeconds;
    }
  }

  let cursor = level.playerStart;
  let cursorId = "spawn";
  let routeDistanceCells = 0;
  if (failures.length === 0) {
    for (const objective of route.objectives) {
      const path = findPath(level, cursor, objective.position);
      const reachable = path.length > 0;
      const distanceCells = reachable ? path.length - 1 : null;
      legs.push(Object.freeze({
        fromId: cursorId,
        toId: objective.id,
        reachable,
        distanceCells,
      }));
      if (distanceCells === null) {
        failures.push(`Unreachable ordered mastery leg ${cursorId} -> ${objective.id}`);
        break;
      }
      routeDistanceCells += distanceCells;
      cursor = objective.position;
      cursorId = objective.id;
    }
    if (failures.length === 0) {
      const path = findPath(level, cursor, level.exit);
      const reachable = path.length > 0;
      const distanceCells = reachable ? path.length - 1 : null;
      legs.push(Object.freeze({
        fromId: cursorId,
        toId: "exit",
        reachable,
        distanceCells,
      }));
      if (distanceCells !== null) {
        routeDistanceCells += distanceCells;
      } else {
        failures.push(`Unreachable ordered mastery leg ${cursorId} -> exit`);
      }
    }
  }

  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    objectiveIds: Object.freeze([...objectiveIds]),
    legs: Object.freeze(legs),
    routeDistanceCells: failures.length === 0 ? routeDistanceCells : null,
    objectiveSeconds,
  });
}

/**
 * Produces an auditable lower-bound plan instead of guessing from the direct
 * exit route. Mission topology, non-movement interactions, profile-specific
 * hide transitions, the active layout and the Standard/Assisted lane all
 * contribute before a human execution margin is added.
 */
export function masteryTargetPlan(
  level: LevelDefinition,
  config: Partial<GameConfig>,
  options: Readonly<MasteryTargetOptions> = {},
): MasteryTargetPlan {
  const directRouteDistanceCells = Math.max(
    1,
    findPath(level, level.playerStart, level.exit).length - 1,
  );
  const inferredContext: MasteryContext = {
    levelId: level.id,
    theme: campaignThemeFor(level, options.context),
    ruleset: options.context?.ruleset,
  };
  const context = options.context ?? inferredContext;
  const ruleset: RunRuleset = context.ruleset === "assisted" ? "assisted" : "standard";
  const theme = campaignThemeFor(level, context);
  let mission: MasteryMissionRoute | null = options.mission
    ? options.mission.kind === "ordered"
      ? freezeOrderedMissionRoute(options.mission)
      : freezeThemeMissionRoute(options.mission)
    : null;
  if (options.mission === undefined && theme) {
    const definition = themeMissionDefinition(theme);
    const planned = planThemeMissionPlacements(level, definition);
    mission = freezeThemeMissionRoute({
      definition,
      placements: planned.placements,
    });
  }

  let missionRouteDistanceCells = directRouteDistanceCells;
  let missionObjectiveSeconds = 0;
  if (mission) {
    if (mission.kind === "ordered") {
      const audit = auditOrderedMasteryMissionRoute(level, mission);
      if (!audit.passed || audit.routeDistanceCells === null) {
        throw new Error(`Mastery ordered mission route is invalid: ${audit.failures.join("; ")}`);
      }
      missionRouteDistanceCells = Math.max(
        directRouteDistanceCells,
        audit.routeDistanceCells,
      );
      missionObjectiveSeconds = audit.objectiveSeconds;
    } else {
      const audit = auditThemeMissionSoftlock(
        level,
        mission.definition,
        mission.placements,
      );
      if (!audit.passed || audit.shortestOrderDistanceCells === null) {
        throw new Error(`Mastery mission route is invalid: ${audit.failures.join("; ")}`);
      }
      missionRouteDistanceCells = Math.max(
        directRouteDistanceCells,
        audit.shortestOrderDistanceCells,
      );
      missionObjectiveSeconds = mission.definition.objectives.reduce(
        (sum, objective) => sum + objective.commitmentSeconds,
        0,
      );
    }
  }

  const challengeIds = options.challengeIds
    ?? getMasteryProfile(context).challengeIds;
  const requiredHideCount = challengeIds.includes("double-slip")
    ? 2
    : challengeIds.includes("hide-and-slip") ? 1 : 0;
  const hideEnterSeconds = finitePositive(
    config.hideEnterSeconds,
    DEFAULT_GAME_CONFIG.hideEnterSeconds,
  );
  const hideExitSeconds = finitePositive(
    config.hideExitSeconds,
    DEFAULT_GAME_CONFIG.hideExitSeconds,
  );
  const challengeForcedSeconds = requiredHideCount
    * (hideEnterSeconds + hideExitSeconds);
  const playerSpeed = finitePositive(
    config.playerSpeed,
    DEFAULT_GAME_CONFIG.playerSpeed,
  );
  const travelSeconds = missionRouteDistanceCells / playerSpeed;
  const theoreticalMinimumSeconds = travelSeconds
    + missionObjectiveSeconds
    + challengeForcedSeconds;
  const defaultMargin = ruleset === "assisted"
    ? ASSISTED_MASTERY_EXECUTION_MARGIN
    : STANDARD_MASTERY_EXECUTION_MARGIN;
  const executionMarginRatio = Number.isFinite(options.executionMarginRatio)
    ? Math.min(0.75, Math.max(0.1, Number(options.executionMarginRatio)))
    : defaultMargin;
  // A fixed sub-second allowance covers input sampling and the final exit
  // trigger without making short layouts disproportionately strict.
  const executionMarginSeconds = theoreticalMinimumSeconds * executionMarginRatio + 1;
  const targetSeconds = Math.max(
    20,
    Math.ceil(theoreticalMinimumSeconds + executionMarginSeconds),
  );

  return Object.freeze({
    targetSeconds,
    ruleset,
    directRouteDistanceCells,
    missionRouteDistanceCells,
    missionObjectiveSeconds,
    challengeForcedSeconds,
    theoreticalMinimumSeconds,
    executionMarginRatio,
    executionMarginSeconds,
    mission,
  });
}

export function masteryTargetSeconds(
  level: LevelDefinition,
  config: Partial<GameConfig>,
  options: Readonly<MasteryTargetOptions> = {},
): number {
  return masteryTargetPlan(level, config, options).targetSeconds;
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
): RunMasteryPreview;
export function previewRunMastery(
  level: LevelDefinition,
  config: Partial<GameConfig>,
  options?: Readonly<MasteryTargetOptions>,
): RunMasteryPreview;
export function previewRunMastery(
  level: LevelDefinition,
  config: Partial<GameConfig>,
  contextOrOptions?: Readonly<MasteryContext> | Readonly<MasteryTargetOptions>,
): RunMasteryPreview {
  const options: Readonly<MasteryTargetOptions> = contextOrOptions
    && "levelId" in contextOrOptions
    ? { context: contextOrOptions }
    : contextOrOptions ?? {};
  const context = options.context ?? {
    levelId: level.id,
    theme: campaignThemeFor(level),
  };
  const profile = getMasteryProfile(context);
  const targetSeconds = masteryTargetSeconds(level, config, options);
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
