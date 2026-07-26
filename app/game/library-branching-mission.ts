import type { LevelDefinition, Point } from "./contracts.ts";
import type { GhostRuleEventInput } from "./ghost-race.ts";
import {
  availableThemeObjectiveIds,
  THEME_MISSION_DEFINITIONS,
  type ObjectiveSoftlockSafety,
  type ThemeMissionDefinition,
  type ThemeMissionEvent,
  type ThemeMissionState,
  type ThemeMissionStep,
} from "./theme-objectives.ts";
import {
  findPath,
  isWalkable,
  pointKey,
} from "./navigation.ts";

export const LIBRARY_BRANCHING_MISSION_VERSION = 1;
/** Mission and hide prompts must never be actionable from one position. */
export const LIBRARY_MISSION_INTERACTION_EXCLUSION_CELLS = 2.6;
export const LIBRARY_MISSION_MINIMUM_SUPPORTED_FRAME_RATE = 30;

export interface LibraryMissionCommitmentWindow {
  readonly startedAtTick: number;
  readonly durationTicks: number;
  readonly completesAtTick: number;
  readonly durationSeconds: number;
}

export type LibraryMissionPlanId = "access-authorization" | "fire-release";
export type LibraryMissionExitId = "front-gate" | "loading-fire-exit";
export type LibraryMissionStatus = "planning" | "preparation" | "exit-ready" | "escaped";
export type LibraryObjectiveAttemptOutcome = "completed" | "interrupted" | "cancelled";

/**
 * Commitment time is expressed in authoritative simulation ticks. Rounding
 * to complete render-frame groups at the supported 30 Hz floor prevents a
 * 30 Hz frame from straddling the unlock tick while 60/120/144 Hz do not.
 */
export function libraryMissionCommitmentWindow(
  startedAtTick: number,
  requestedSeconds: number,
  fixedStepSeconds: number,
): LibraryMissionCommitmentWindow {
  if (!Number.isInteger(startedAtTick) || startedAtTick < 0) {
    throw new Error("Mission commitment start tick must be a non-negative integer");
  }
  if (!Number.isFinite(requestedSeconds) || requestedSeconds <= 0) {
    throw new Error("Mission commitment seconds must be finite and positive");
  }
  if (!Number.isFinite(fixedStepSeconds) || fixedStepSeconds <= 0) {
    throw new Error("Mission fixed step must be finite and positive");
  }
  const rawDurationTicks = Math.max(
    1,
    Math.ceil((requestedSeconds - 1e-9) / fixedStepSeconds),
  );
  const ticksPerMinimumRenderFrame = Math.max(
    1,
    Math.ceil(
      (1 / LIBRARY_MISSION_MINIMUM_SUPPORTED_FRAME_RATE - 1e-9)
        / fixedStepSeconds,
    ),
  );
  const durationTicks = Math.ceil(
    rawDurationTicks / ticksPerMinimumRenderFrame,
  ) * ticksPerMinimumRenderFrame;
  return Object.freeze({
    startedAtTick,
    durationTicks,
    completesAtTick: startedAtTick + durationTicks,
    durationSeconds: durationTicks * fixedStepSeconds,
  });
}

export interface LibraryMissionRecoveryPolicy {
  readonly failedObjectivesAreRetryable: true;
  readonly planSwitchAllowedUntilEscape: true;
  readonly completedProgressPersistsAcrossSwitch: true;
  readonly unlockedExitsPersistAcrossSwitch: true;
  readonly consumesRequiredResource: false;
}

export interface LibraryMissionObjectiveDefinition {
  readonly id: string;
  readonly planId: LibraryMissionPlanId;
  readonly kind: "preparation" | "exit-unlock";
  readonly label: string;
  readonly interactionPrompt: string;
  readonly completionHint: string;
  readonly commitmentSeconds: number;
  readonly prerequisites: readonly string[];
  readonly unlocksExitId: LibraryMissionExitId | null;
  readonly safety: ObjectiveSoftlockSafety;
}

export interface LibraryMissionPlanDefinition {
  readonly id: LibraryMissionPlanId;
  readonly label: string;
  readonly strategy: string;
  readonly objectiveIds: readonly string[];
  readonly preparationObjectiveIds: readonly string[];
  readonly unlockObjectiveId: string;
  readonly exitId: LibraryMissionExitId;
}

export interface LibraryMissionExitDefinition {
  readonly id: LibraryMissionExitId;
  readonly planId: LibraryMissionPlanId;
  readonly label: string;
  readonly unlockObjectiveId: string;
}

export interface LibraryBranchingMissionDefinition {
  readonly version: typeof LIBRARY_BRANCHING_MISSION_VERSION;
  readonly id: string;
  readonly levelId: string;
  readonly title: string;
  readonly briefing: string;
  readonly recovery: LibraryMissionRecoveryPolicy;
  readonly plans: readonly LibraryMissionPlanDefinition[];
  readonly objectives: readonly LibraryMissionObjectiveDefinition[];
  readonly exits: readonly LibraryMissionExitDefinition[];
}

export interface LibraryMissionFailedAttempt {
  readonly objectiveId: string;
  readonly count: number;
}

export interface LibraryMissionState {
  readonly version: typeof LIBRARY_BRANCHING_MISSION_VERSION;
  readonly definitionId: string;
  readonly activePlanId: LibraryMissionPlanId | null;
  readonly status: LibraryMissionStatus;
  readonly completedObjectiveIds: readonly string[];
  readonly unlockedExitIds: readonly LibraryMissionExitId[];
  readonly failedAttempts: readonly LibraryMissionFailedAttempt[];
  readonly escapedViaExitId: LibraryMissionExitId | null;
}

export type LibraryMissionCommand =
  | {
      readonly type: "select-plan";
      readonly planId: LibraryMissionPlanId;
    }
  | {
      readonly type: "attempt-objective";
      readonly objectiveId: string;
      readonly outcome: LibraryObjectiveAttemptOutcome;
    }
  | {
      readonly type: "escape";
      readonly exitId: LibraryMissionExitId;
    };

export type LibraryMissionRejectionReason =
  | "mission-complete"
  | "unknown-plan"
  | "already-selected"
  | "unknown-objective"
  | "plan-not-selected"
  | "inactive-plan"
  | "already-completed"
  | "prerequisite-missing"
  | "unknown-exit"
  | "exit-locked";

export type LibraryMissionEvent =
  | {
      readonly type: "plan-selected";
      readonly planId: LibraryMissionPlanId;
    }
  | {
      readonly type: "plan-switched";
      readonly fromPlanId: LibraryMissionPlanId;
      readonly toPlanId: LibraryMissionPlanId;
      readonly retainedObjectiveIds: readonly string[];
      readonly retainedExitIds: readonly LibraryMissionExitId[];
    }
  | {
      readonly type: "command-rejected";
      readonly commandType: LibraryMissionCommand["type"];
      readonly targetId: string;
      readonly reason: LibraryMissionRejectionReason;
    }
  | {
      readonly type: "objective-attempt-failed";
      readonly objectiveId: string;
      readonly planId: LibraryMissionPlanId;
      readonly reason: Exclude<LibraryObjectiveAttemptOutcome, "completed">;
      readonly retryable: true;
    }
  | {
      readonly type: "objective-completed";
      readonly objectiveId: string;
      readonly planId: LibraryMissionPlanId;
    }
  | {
      readonly type: "exit-unlocked";
      readonly exitId: LibraryMissionExitId;
      readonly planId: LibraryMissionPlanId;
      readonly objectiveId: string;
    }
  | {
      readonly type: "mission-completed";
      readonly exitId: LibraryMissionExitId;
      readonly planId: LibraryMissionPlanId;
    };

export interface LibraryMissionStep {
  readonly state: LibraryMissionState;
  readonly events: readonly LibraryMissionEvent[];
  readonly availableObjectiveIds: readonly string[];
  readonly availableExitIds: readonly LibraryMissionExitId[];
}

export interface LibraryMissionReplay {
  readonly state: LibraryMissionState;
  readonly events: readonly LibraryMissionEvent[];
  readonly fingerprint: string;
}

export interface LibraryMissionTopology {
  readonly levelId: string;
  readonly objectivePlacements: readonly {
    readonly objectiveId: string;
    readonly position: Point;
  }[];
  readonly exitPlacements: readonly {
    readonly exitId: LibraryMissionExitId;
    readonly position: Point;
  }[];
}

export interface LibraryPlanSoftlockAudit {
  readonly planId: LibraryMissionPlanId;
  readonly exitId: LibraryMissionExitId;
  readonly reachable: boolean;
  readonly failedLeg: string | null;
  readonly routeDistanceCells: number | null;
}

export interface LibrarySwitchSoftlockAudit {
  readonly fromPlanId: LibraryMissionPlanId;
  readonly completedPrefixLength: number;
  readonly toPlanId: LibraryMissionPlanId;
  readonly reachable: boolean;
  readonly failedLeg: string | null;
}

export interface LibraryMissionSoftlockAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly plans: readonly LibraryPlanSoftlockAudit[];
  readonly switches: readonly LibrarySwitchSoftlockAudit[];
}

export interface LibraryThemeMissionAdapterStep extends ThemeMissionStep {
  /**
   * A monotonic v1 sidecar for GhostRuleProgressTracker. Exact plan and exit
   * identity remains in LibraryMissionEvent; legacy ghosts receive milestones.
   */
  readonly ghostEvents: readonly GhostRuleEventInput[];
}

const SOFTLOCK_SAFE: ObjectiveSoftlockSafety = Object.freeze({
  retryable: true,
  consumesRequiredResource: false,
  closesRequiredRoute: false,
});

export const LIBRARY_MISSION_RECOVERY_POLICY: LibraryMissionRecoveryPolicy = Object.freeze({
  failedObjectivesAreRetryable: true,
  planSwitchAllowedUntilEscape: true,
  completedProgressPersistsAcrossSwitch: true,
  unlockedExitsPersistAcrossSwitch: true,
  consumesRequiredResource: false,
});

function freezeObjective(
  value: Omit<LibraryMissionObjectiveDefinition, "safety">,
): LibraryMissionObjectiveDefinition {
  return Object.freeze({
    ...value,
    prerequisites: Object.freeze([...value.prerequisites]),
    safety: SOFTLOCK_SAFE,
  });
}

function freezePlan(value: LibraryMissionPlanDefinition): LibraryMissionPlanDefinition {
  return Object.freeze({
    ...value,
    objectiveIds: Object.freeze([...value.objectiveIds]),
    preparationObjectiveIds: Object.freeze([...value.preparationObjectiveIds]),
  });
}

const accessPass = "library:retrieve-temporary-pass";
const accessAuthorization = "library:write-front-gate-authorization";
const accessRelease = "library:release-front-gate";
const firePower = "library:restore-egress-circuit";
const fireLinkage = "library:prime-fire-door-linkage";
const fireRelease = "library:release-loading-fire-door";

/**
 * G2 owns a new contract instead of widening ThemeMissionDefinition. The old
 * definition remains valid for ten-level runtime and replay compatibility.
 */
export const LIBRARY_BRANCHING_MISSION: LibraryBranchingMissionDefinition = Object.freeze({
  version: LIBRARY_BRANCHING_MISSION_VERSION,
  id: "level-mission:campus-library-lockdown:g2:v1",
  levelId: "campus-library-lockdown",
  title: "封馆图书楼 · 双路脱身",
  briefing: "局前选择门禁授权或消防释放；两条路线条件不同，并且只解锁各自的实体出口。",
  recovery: LIBRARY_MISSION_RECOVERY_POLICY,
  plans: Object.freeze([
    freezePlan({
      id: "access-authorization",
      label: "门禁授权",
      strategy: "先取得临时通行凭证，再写入正门授权；路线更长但操作安静。",
      objectiveIds: Object.freeze([accessPass, accessAuthorization, accessRelease]),
      preparationObjectiveIds: Object.freeze([accessPass, accessAuthorization]),
      unlockObjectiveId: accessRelease,
      exitId: "front-gate",
    }),
    freezePlan({
      id: "fire-release",
      label: "消防释放",
      strategy: "恢复疏散回路并预备机械连杆；路线更短，但操作会产生明显公开声音。",
      objectiveIds: Object.freeze([firePower, fireLinkage, fireRelease]),
      preparationObjectiveIds: Object.freeze([firePower, fireLinkage]),
      unlockObjectiveId: fireRelease,
      exitId: "loading-fire-exit",
    }),
  ]),
  objectives: Object.freeze([
    freezeObjective({
      id: accessPass,
      planId: "access-authorization",
      kind: "preparation",
      label: "取得临时通行证",
      interactionPrompt: "从借阅台保管盒取出临时通行证",
      completionHint: "通行凭证已取得，前往保安终端",
      commitmentSeconds: 1.05,
      prerequisites: Object.freeze([]),
      unlocksExitId: null,
    }),
    freezeObjective({
      id: accessAuthorization,
      planId: "access-authorization",
      kind: "preparation",
      label: "写入正门授权",
      interactionPrompt: "在保安终端写入一次性离馆授权",
      completionHint: "授权已写入，可到正门控制器释放门锁",
      commitmentSeconds: 1.35,
      prerequisites: Object.freeze([accessPass]),
      unlocksExitId: null,
    }),
    freezeObjective({
      id: accessRelease,
      planId: "access-authorization",
      kind: "exit-unlock",
      label: "释放图书楼正门",
      interactionPrompt: "使用临时授权解除正门电磁锁",
      completionHint: "正门已解锁",
      commitmentSeconds: 1,
      prerequisites: Object.freeze([accessAuthorization]),
      unlocksExitId: "front-gate",
    }),
    freezeObjective({
      id: firePower,
      planId: "fire-release",
      kind: "preparation",
      label: "恢复疏散回路",
      interactionPrompt: "合上后勤走廊疏散电路",
      completionHint: "消防释放回路已上电",
      commitmentSeconds: 1.2,
      prerequisites: Object.freeze([]),
      unlocksExitId: null,
    }),
    freezeObjective({
      id: fireLinkage,
      planId: "fire-release",
      kind: "preparation",
      label: "预备消防门连杆",
      interactionPrompt: "拉下消防门机械旁路连杆",
      completionHint: "后勤消防门已允许人工释放",
      commitmentSeconds: 1.15,
      prerequisites: Object.freeze([firePower]),
      unlocksExitId: null,
    }),
    freezeObjective({
      id: fireRelease,
      planId: "fire-release",
      kind: "exit-unlock",
      label: "释放后勤消防门",
      interactionPrompt: "持续按住后勤消防门释放机构",
      completionHint: "后勤消防出口已解锁",
      commitmentSeconds: 1.25,
      prerequisites: Object.freeze([fireLinkage]),
      unlocksExitId: "loading-fire-exit",
    }),
  ]),
  exits: Object.freeze([
    Object.freeze({
      id: "front-gate",
      planId: "access-authorization",
      label: "图书楼正门",
      unlockObjectiveId: accessRelease,
    }),
    Object.freeze({
      id: "loading-fire-exit",
      planId: "fire-release",
      label: "后勤消防出口",
      unlockObjectiveId: fireRelease,
    }),
  ]),
});

/**
 * Authoring anchors stay outside CampaignLevelDefinition until G2 is wired to
 * the runtime. Both exits already use distinct walkable branches of level 2.
 */
export const LIBRARY_BRANCHING_MISSION_TOPOLOGY: LibraryMissionTopology = Object.freeze({
  levelId: LIBRARY_BRANCHING_MISSION.levelId,
  objectivePlacements: Object.freeze([
    Object.freeze({ objectiveId: accessPass, position: Object.freeze({ x: 11, y: 14 }) }),
    Object.freeze({ objectiveId: accessAuthorization, position: Object.freeze({ x: 18, y: 4 }) }),
    Object.freeze({ objectiveId: accessRelease, position: Object.freeze({ x: 23, y: 7 }) }),
    Object.freeze({ objectiveId: firePower, position: Object.freeze({ x: 7, y: 17 }) }),
    Object.freeze({ objectiveId: fireLinkage, position: Object.freeze({ x: 5, y: 10 }) }),
    Object.freeze({ objectiveId: fireRelease, position: Object.freeze({ x: 5, y: 5 }) }),
  ]),
  exitPlacements: Object.freeze([
    Object.freeze({ exitId: "front-gate", position: Object.freeze({ x: 23, y: 1 }) }),
    Object.freeze({ exitId: "loading-fire-exit", position: Object.freeze({ x: 2, y: 5 }) }),
  ]),
});

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function definitionFailures(definition: LibraryBranchingMissionDefinition): string[] {
  const failures: string[] = [];
  try {
    assertNonEmpty(definition.id, "Mission id");
    assertNonEmpty(definition.levelId, "Mission level id");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (definition.version !== LIBRARY_BRANCHING_MISSION_VERSION) {
    failures.push("Library mission version is unsupported");
  }
  if (definition.plans.length !== 2) failures.push("Library mission requires exactly two plans");
  if (definition.exits.length !== 2) failures.push("Library mission requires exactly two exits");
  if (
    definition.recovery.failedObjectivesAreRetryable !== true
    || definition.recovery.planSwitchAllowedUntilEscape !== true
    || definition.recovery.completedProgressPersistsAcrossSwitch !== true
    || definition.recovery.unlockedExitsPersistAcrossSwitch !== true
    || definition.recovery.consumesRequiredResource !== false
  ) failures.push("Library mission violates the recovery policy");

  const planById = new Map<LibraryMissionPlanId, LibraryMissionPlanDefinition>();
  const objectiveById = new Map<string, LibraryMissionObjectiveDefinition>();
  const exitById = new Map<LibraryMissionExitId, LibraryMissionExitDefinition>();
  for (const plan of definition.plans) {
    if (planById.has(plan.id)) failures.push(`Duplicate plan ${plan.id}`);
    planById.set(plan.id, plan);
  }
  for (const item of definition.objectives) {
    if (objectiveById.has(item.id)) failures.push(`Duplicate objective ${item.id}`);
    objectiveById.set(item.id, item);
    if (
      item.safety.retryable !== true
      || item.safety.consumesRequiredResource !== false
      || item.safety.closesRequiredRoute !== false
    ) failures.push(`Objective ${item.id} violates the softlock safety contract`);
    if (
      !Number.isFinite(item.commitmentSeconds)
      || item.commitmentSeconds < 0.4
      || item.commitmentSeconds > 2.5
    ) failures.push(`Objective ${item.id} has an invalid commitment time`);
  }
  for (const exit of definition.exits) {
    if (exitById.has(exit.id)) failures.push(`Duplicate exit ${exit.id}`);
    exitById.set(exit.id, exit);
  }

  const preparationSignatures = new Set<string>();
  for (const plan of definition.plans) {
    const exit = exitById.get(plan.exitId);
    if (!exit || exit.planId !== plan.id || exit.unlockObjectiveId !== plan.unlockObjectiveId) {
      failures.push(`Plan ${plan.id} does not own one independent exit`);
    }
    if (
      plan.objectiveIds.length < 3
      || plan.preparationObjectiveIds.length < 2
      || plan.objectiveIds.at(-1) !== plan.unlockObjectiveId
    ) failures.push(`Plan ${plan.id} requires distinct preparation and a final exit unlock`);
    if (
      new Set(plan.objectiveIds).size !== plan.objectiveIds.length
      || new Set(plan.preparationObjectiveIds).size !== plan.preparationObjectiveIds.length
    ) failures.push(`Plan ${plan.id} repeats objectives`);
    preparationSignatures.add([...plan.preparationObjectiveIds].sort().join("|"));

    const objectiveIdSet = new Set(plan.objectiveIds);
    for (const objectiveId of plan.objectiveIds) {
      const item = objectiveById.get(objectiveId);
      if (!item || item.planId !== plan.id) {
        failures.push(`Plan ${plan.id} references an objective it does not own: ${objectiveId}`);
        continue;
      }
      const shouldUnlock = objectiveId === plan.unlockObjectiveId;
      if (
        (shouldUnlock && (item.kind !== "exit-unlock" || item.unlocksExitId !== plan.exitId))
        || (!shouldUnlock && (item.kind !== "preparation" || item.unlocksExitId !== null))
      ) failures.push(`Objective ${objectiveId} has an invalid phase or exit binding`);
      for (const prerequisiteId of item.prerequisites) {
        if (!objectiveIdSet.has(prerequisiteId)) {
          failures.push(`Objective ${objectiveId} depends on another plan: ${prerequisiteId}`);
        }
      }
    }
    if (
      plan.preparationObjectiveIds.some((id) => !objectiveIdSet.has(id))
      || plan.preparationObjectiveIds.includes(plan.unlockObjectiveId)
    ) failures.push(`Plan ${plan.id} has invalid preparation objective IDs`);

    const completed = new Set<string>();
    let guard = 0;
    while (completed.size < plan.objectiveIds.length && guard <= plan.objectiveIds.length) {
      const available = plan.objectiveIds.filter((id) => {
        const item = objectiveById.get(id);
        return item
          && !completed.has(id)
          && item.prerequisites.every((prerequisiteId) => completed.has(prerequisiteId));
      });
      if (available.length === 0) break;
      for (const id of available) completed.add(id);
      guard += 1;
    }
    if (completed.size !== plan.objectiveIds.length) {
      failures.push(`Plan ${plan.id} contains an objective cycle or unreachable prerequisite`);
    }
  }
  if (preparationSignatures.size !== definition.plans.length) {
    failures.push("The two plans do not have different preparation conditions");
  }
  for (const item of definition.objectives) {
    if (!planById.get(item.planId)?.objectiveIds.includes(item.id)) {
      failures.push(`Orphan objective ${item.id}`);
    }
  }
  for (const exit of definition.exits) {
    if (!planById.has(exit.planId)) failures.push(`Orphan exit ${exit.id}`);
  }
  return failures;
}

export function validateLibraryBranchingMissionDefinition(
  definition: LibraryBranchingMissionDefinition,
): void {
  const failures = definitionFailures(definition);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

function stateStatus(
  activePlanId: LibraryMissionPlanId | null,
  unlockedExitIds: readonly LibraryMissionExitId[],
  escapedViaExitId: LibraryMissionExitId | null,
): LibraryMissionStatus {
  if (escapedViaExitId) return "escaped";
  if (unlockedExitIds.length > 0) return "exit-ready";
  return activePlanId ? "preparation" : "planning";
}

function freezeState(
  definition: LibraryBranchingMissionDefinition,
  value: Omit<LibraryMissionState, "version" | "definitionId" | "status">,
): LibraryMissionState {
  const completed = definition.objectives
    .map(({ id }) => id)
    .filter((id) => value.completedObjectiveIds.includes(id));
  const exits = definition.exits
    .map(({ id }) => id)
    .filter((id) => value.unlockedExitIds.includes(id));
  const failures = definition.objectives
    .map(({ id }) => value.failedAttempts.find((entry) => entry.objectiveId === id))
    .filter((entry): entry is LibraryMissionFailedAttempt => Boolean(entry?.count))
    .map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({
    version: LIBRARY_BRANCHING_MISSION_VERSION,
    definitionId: definition.id,
    activePlanId: value.activePlanId,
    status: stateStatus(value.activePlanId, exits, value.escapedViaExitId),
    completedObjectiveIds: Object.freeze(completed),
    unlockedExitIds: Object.freeze(exits),
    failedAttempts: Object.freeze(failures),
    escapedViaExitId: value.escapedViaExitId,
  });
}

function validateState(
  definition: LibraryBranchingMissionDefinition,
  state: LibraryMissionState,
) {
  if (
    state.version !== definition.version
    || state.definitionId !== definition.id
  ) throw new Error("Library mission state belongs to another definition or version");
  const objectiveIds = new Set(definition.objectives.map(({ id }) => id));
  const exitIds = new Set(definition.exits.map(({ id }) => id));
  if (
    state.activePlanId
    && !definition.plans.some(({ id }) => id === state.activePlanId)
  ) throw new Error("Library mission state selects an unknown plan");
  if (
    state.completedObjectiveIds.some((id) => !objectiveIds.has(id))
    || state.unlockedExitIds.some((id) => !exitIds.has(id))
  ) throw new Error("Library mission state contains unknown progress");
  if (
    new Set(state.completedObjectiveIds).size !== state.completedObjectiveIds.length
    || new Set(state.unlockedExitIds).size !== state.unlockedExitIds.length
    || new Set(state.failedAttempts.map(({ objectiveId }) => objectiveId)).size
      !== state.failedAttempts.length
  ) throw new Error("Library mission state contains duplicate progress");
  for (const objectiveId of state.completedObjectiveIds) {
    const item = definition.objectives.find(({ id }) => id === objectiveId);
    if (!item?.prerequisites.every((id) => state.completedObjectiveIds.includes(id))) {
      throw new Error(`Library mission state completed ${objectiveId} before its prerequisite`);
    }
  }
  for (const failure of state.failedAttempts) {
    if (
      !objectiveIds.has(failure.objectiveId)
      || !Number.isInteger(failure.count)
      || failure.count <= 0
    ) throw new Error("Library mission state contains an invalid failed attempt");
  }
  for (const exitId of state.unlockedExitIds) {
    const exit = definition.exits.find(({ id }) => id === exitId);
    if (!exit || !state.completedObjectiveIds.includes(exit.unlockObjectiveId)) {
      throw new Error(`Library mission state unlocks ${exitId} without its objective`);
    }
  }
  if (
    state.escapedViaExitId
    && !state.unlockedExitIds.includes(state.escapedViaExitId)
  ) throw new Error("Library mission state escaped through a locked exit");
  if (
    state.status !== stateStatus(
      state.activePlanId,
      state.unlockedExitIds,
      state.escapedViaExitId,
    )
  ) throw new Error("Library mission state has an inconsistent status");
}

export function createInitialLibraryMissionState(
  definition: LibraryBranchingMissionDefinition = LIBRARY_BRANCHING_MISSION,
): LibraryMissionState {
  validateLibraryBranchingMissionDefinition(definition);
  return freezeState(definition, {
    activePlanId: null,
    completedObjectiveIds: [],
    unlockedExitIds: [],
    failedAttempts: [],
    escapedViaExitId: null,
  });
}

export function availableLibraryObjectiveIds(
  definition: LibraryBranchingMissionDefinition,
  state: LibraryMissionState,
): readonly string[] {
  validateState(definition, state);
  if (!state.activePlanId || state.status === "escaped") return Object.freeze([]);
  const completed = new Set(state.completedObjectiveIds);
  return Object.freeze(definition.objectives
    .filter((item) => (
      item.planId === state.activePlanId
      && !completed.has(item.id)
      && item.prerequisites.every((id) => completed.has(id))
    ))
    .map(({ id }) => id));
}

export function availableLibraryExitIds(
  definition: LibraryBranchingMissionDefinition,
  state: LibraryMissionState,
): readonly LibraryMissionExitId[] {
  validateState(definition, state);
  return state.status === "escaped"
    ? Object.freeze([])
    : Object.freeze([...state.unlockedExitIds]);
}

function rejected(
  definition: LibraryBranchingMissionDefinition,
  state: LibraryMissionState,
  command: LibraryMissionCommand,
  reason: LibraryMissionRejectionReason,
): LibraryMissionStep {
  const targetId = command.type === "select-plan"
    ? command.planId
    : command.type === "attempt-objective"
      ? command.objectiveId
      : command.exitId;
  return Object.freeze({
    state,
    events: Object.freeze([Object.freeze({
      type: "command-rejected",
      commandType: command.type,
      targetId,
      reason,
    })]),
    availableObjectiveIds: availableLibraryObjectiveIds(definition, state),
    availableExitIds: availableLibraryExitIds(definition, state),
  });
}

function withAvailability(
  definition: LibraryBranchingMissionDefinition,
  state: LibraryMissionState,
  events: readonly LibraryMissionEvent[],
): LibraryMissionStep {
  return Object.freeze({
    state,
    events: Object.freeze([...events]),
    availableObjectiveIds: availableLibraryObjectiveIds(definition, state),
    availableExitIds: availableLibraryExitIds(definition, state),
  });
}

export function stepLibraryBranchingMission(
  definition: LibraryBranchingMissionDefinition,
  state: LibraryMissionState,
  command: LibraryMissionCommand,
): LibraryMissionStep {
  validateLibraryBranchingMissionDefinition(definition);
  validateState(definition, state);
  if (state.status === "escaped") return rejected(definition, state, command, "mission-complete");

  if (command.type === "select-plan") {
    const plan = definition.plans.find(({ id }) => id === command.planId);
    if (!plan) return rejected(definition, state, command, "unknown-plan");
    if (state.activePlanId === plan.id) {
      return rejected(definition, state, command, "already-selected");
    }
    const previousPlanId = state.activePlanId;
    const next = freezeState(definition, {
      ...state,
      activePlanId: plan.id,
    });
    const event: LibraryMissionEvent = previousPlanId
      ? Object.freeze({
          type: "plan-switched",
          fromPlanId: previousPlanId,
          toPlanId: plan.id,
          retainedObjectiveIds: Object.freeze([...state.completedObjectiveIds]),
          retainedExitIds: Object.freeze([...state.unlockedExitIds]),
        })
      : Object.freeze({ type: "plan-selected", planId: plan.id });
    return withAvailability(definition, next, [event]);
  }

  if (command.type === "attempt-objective") {
    const item = definition.objectives.find(({ id }) => id === command.objectiveId);
    if (!item) return rejected(definition, state, command, "unknown-objective");
    if (!state.activePlanId) return rejected(definition, state, command, "plan-not-selected");
    if (item.planId !== state.activePlanId) {
      return rejected(definition, state, command, "inactive-plan");
    }
    if (state.completedObjectiveIds.includes(item.id)) {
      return rejected(definition, state, command, "already-completed");
    }
    if (!item.prerequisites.every((id) => state.completedObjectiveIds.includes(id))) {
      return rejected(definition, state, command, "prerequisite-missing");
    }
    if (command.outcome !== "completed") {
      const previousCount = state.failedAttempts
        .find(({ objectiveId }) => objectiveId === item.id)?.count ?? 0;
      const next = freezeState(definition, {
        ...state,
        failedAttempts: [
          ...state.failedAttempts.filter(({ objectiveId }) => objectiveId !== item.id),
          { objectiveId: item.id, count: previousCount + 1 },
        ],
      });
      return withAvailability(definition, next, [Object.freeze({
        type: "objective-attempt-failed",
        objectiveId: item.id,
        planId: item.planId,
        reason: command.outcome,
        retryable: true,
      })]);
    }

    const unlockedExitIds = item.unlocksExitId
      ? [...state.unlockedExitIds, item.unlocksExitId]
      : state.unlockedExitIds;
    const next = freezeState(definition, {
      ...state,
      completedObjectiveIds: [...state.completedObjectiveIds, item.id],
      unlockedExitIds,
    });
    const events: LibraryMissionEvent[] = [Object.freeze({
      type: "objective-completed",
      objectiveId: item.id,
      planId: item.planId,
    })];
    if (item.unlocksExitId) {
      events.push(Object.freeze({
        type: "exit-unlocked",
        exitId: item.unlocksExitId,
        planId: item.planId,
        objectiveId: item.id,
      }));
    }
    return withAvailability(definition, next, events);
  }

  const exit = definition.exits.find(({ id }) => id === command.exitId);
  if (!exit) return rejected(definition, state, command, "unknown-exit");
  if (!state.unlockedExitIds.includes(exit.id)) {
    return rejected(definition, state, command, "exit-locked");
  }
  const next = freezeState(definition, {
    ...state,
    escapedViaExitId: exit.id,
  });
  return withAvailability(definition, next, [Object.freeze({
    type: "mission-completed",
    exitId: exit.id,
    planId: exit.planId,
  })]);
}

export function replayLibraryMission(
  commands: readonly LibraryMissionCommand[],
  definition: LibraryBranchingMissionDefinition = LIBRARY_BRANCHING_MISSION,
): LibraryMissionReplay {
  let state = createInitialLibraryMissionState(definition);
  const events: LibraryMissionEvent[] = [];
  for (const command of commands) {
    const step = stepLibraryBranchingMission(definition, state, command);
    state = step.state;
    events.push(...step.events);
  }
  const value = JSON.stringify({ state, events });
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return Object.freeze({
    state,
    events: Object.freeze(events),
    fingerprint: (hash >>> 0).toString(16).padStart(8, "0"),
  });
}

function routeLeg(
  level: LevelDefinition,
  from: Point,
  to: Point | undefined,
  label: string,
): { readonly next: Point; readonly distance: number; readonly failure: string | null } {
  if (!to) return { next: from, distance: 0, failure: `Missing placement for ${label}` };
  const route = findPath(level, from, to);
  return route.length > 0
    ? { next: to, distance: route.length - 1, failure: null }
    : { next: from, distance: 0, failure: `Unreachable leg ${pointKey(from)} -> ${label}` };
}

/**
 * Proves both complete routes and every mid-plan switch against the authored
 * level graph. Dynamic interactions are safe because no mandatory objective
 * consumes a unique resource or closes a required route.
 */
export function auditLibraryMissionSoftlocks(
  level: LevelDefinition,
  definition: LibraryBranchingMissionDefinition = LIBRARY_BRANCHING_MISSION,
  topology: LibraryMissionTopology = LIBRARY_BRANCHING_MISSION_TOPOLOGY,
): LibraryMissionSoftlockAudit {
  const failures = definitionFailures(definition);
  if (level.id !== definition.levelId || topology.levelId !== definition.levelId) {
    failures.push("Library mission topology belongs to another level");
  }
  const objectivePositions = new Map<string, Point>();
  const exitPositions = new Map<LibraryMissionExitId, Point>();
  const occupied = new Set<string>();
  for (const placement of topology.objectivePlacements) {
    if (objectivePositions.has(placement.objectiveId)) {
      failures.push(`Duplicate objective placement ${placement.objectiveId}`);
    }
    if (!definition.objectives.some(({ id }) => id === placement.objectiveId)) {
      failures.push(`Unknown objective placement ${placement.objectiveId}`);
    }
    if (!isWalkable(level, placement.position)) {
      failures.push(`Objective ${placement.objectiveId} is not on a walkable cell`);
    }
    for (const hideSpot of level.hideSpots) {
      if (
        Math.hypot(
          placement.position.x - hideSpot.approach.x,
          placement.position.y - hideSpot.approach.y,
        ) < LIBRARY_MISSION_INTERACTION_EXCLUSION_CELLS
      ) {
        failures.push(
          `Objective ${placement.objectiveId} overlaps hide interaction ${hideSpot.id}`,
        );
      }
    }
    const key = pointKey(placement.position);
    if (occupied.has(key)) failures.push(`Mission anchors overlap at ${key}`);
    occupied.add(key);
    objectivePositions.set(placement.objectiveId, placement.position);
  }
  for (const item of definition.objectives) {
    if (!objectivePositions.has(item.id)) failures.push(`Missing placement for ${item.id}`);
  }
  for (const placement of topology.exitPlacements) {
    if (exitPositions.has(placement.exitId)) failures.push(`Duplicate exit placement ${placement.exitId}`);
    if (!definition.exits.some(({ id }) => id === placement.exitId)) {
      failures.push(`Unknown exit placement ${placement.exitId}`);
    }
    if (!isWalkable(level, placement.position)) {
      failures.push(`Exit ${placement.exitId} is not on a walkable cell`);
    }
    const key = pointKey(placement.position);
    if (occupied.has(key)) failures.push(`Mission anchors overlap at ${key}`);
    occupied.add(key);
    exitPositions.set(placement.exitId, placement.position);
  }
  for (const exit of definition.exits) {
    if (!exitPositions.has(exit.id)) failures.push(`Missing placement for ${exit.id}`);
  }

  const plans = definition.plans.map((plan): LibraryPlanSoftlockAudit => {
    let from = level.playerStart;
    let distance = 0;
    let failedLeg: string | null = null;
    for (const objectiveId of plan.objectiveIds) {
      const leg = routeLeg(level, from, objectivePositions.get(objectiveId), objectiveId);
      if (leg.failure) {
        failedLeg = leg.failure;
        break;
      }
      from = leg.next;
      distance += leg.distance;
    }
    if (!failedLeg) {
      const leg = routeLeg(level, from, exitPositions.get(plan.exitId), plan.exitId);
      failedLeg = leg.failure;
      distance += leg.distance;
    }
    if (failedLeg) failures.push(`${plan.id}: ${failedLeg}`);
    return Object.freeze({
      planId: plan.id,
      exitId: plan.exitId,
      reachable: failedLeg === null,
      failedLeg,
      routeDistanceCells: failedLeg ? null : distance,
    });
  });

  const switches: LibrarySwitchSoftlockAudit[] = [];
  for (const fromPlan of definition.plans) {
    for (let prefix = 0; prefix <= fromPlan.objectiveIds.length; prefix += 1) {
      let from = level.playerStart;
      let prefixFailure: string | null = null;
      for (const objectiveId of fromPlan.objectiveIds.slice(0, prefix)) {
        const leg = routeLeg(level, from, objectivePositions.get(objectiveId), objectiveId);
        prefixFailure = leg.failure;
        if (prefixFailure) break;
        from = leg.next;
      }
      for (const toPlan of definition.plans.filter(({ id }) => id !== fromPlan.id)) {
        let failedLeg = prefixFailure;
        let cursor = from;
        for (const objectiveId of toPlan.objectiveIds) {
          if (failedLeg) break;
          const leg = routeLeg(level, cursor, objectivePositions.get(objectiveId), objectiveId);
          failedLeg = leg.failure;
          cursor = leg.next;
        }
        if (!failedLeg) {
          failedLeg = routeLeg(
            level,
            cursor,
            exitPositions.get(toPlan.exitId),
            toPlan.exitId,
          ).failure;
        }
        if (failedLeg) {
          failures.push(`${fromPlan.id}[${prefix}] -> ${toPlan.id}: ${failedLeg}`);
        }
        switches.push(Object.freeze({
          fromPlanId: fromPlan.id,
          completedPrefixLength: prefix,
          toPlanId: toPlan.id,
          reachable: failedLeg === null,
          failedLeg,
        }));
      }
    }
  }
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    plans: Object.freeze(plans),
    switches: Object.freeze(switches),
  });
}

function planProgress(
  definition: LibraryBranchingMissionDefinition,
  state: LibraryMissionState,
  plan: LibraryMissionPlanDefinition,
): number {
  let progress = 0;
  for (const objectiveId of plan.objectiveIds) {
    if (!state.completedObjectiveIds.includes(objectiveId)) break;
    progress += 1;
  }
  return Math.min(progress, definition.objectives.length);
}

/**
 * Projects the richer G2 state onto the existing single-exit shape. It uses
 * the furthest completed plan as three monotonic milestones, so switching never
 * deletes legacy progress and any independently unlocked exit maps to the old
 * exit gate.
 */
export function adaptLibraryMissionToThemeMissionState(
  state: LibraryMissionState,
  definition: LibraryBranchingMissionDefinition = LIBRARY_BRANCHING_MISSION,
  legacyDefinition: ThemeMissionDefinition = THEME_MISSION_DEFINITIONS.campus,
): ThemeMissionState {
  validateState(definition, state);
  const legacyObjectives = legacyDefinition.objectives;
  if (legacyObjectives.length !== 3 || legacyDefinition.theme !== "campus") {
    throw new Error("Library adapter requires the three-objective campus legacy mission");
  }
  const milestoneCount = state.unlockedExitIds.length > 0
    ? legacyObjectives.length
    : Math.max(...definition.plans.map((plan) => planProgress(definition, state, plan)));
  const completedObjectiveIds = legacyObjectives
    .slice(0, milestoneCount)
    .map(({ id }) => id);
  const exitUnlocked = state.unlockedExitIds.length > 0;
  const preparationCount = legacyObjectives.filter(({ stage }) => stage === "preparation").length;
  const stage: ThemeMissionState["stage"] = exitUnlocked
    ? "complete"
    : milestoneCount >= preparationCount
      ? "escape-unlock"
      : "preparation";
  return Object.freeze({
    definitionId: legacyDefinition.id,
    stage,
    completedObjectiveIds: Object.freeze(completedObjectiveIds),
    exitUnlocked,
  });
}

export function adaptLibraryMissionTransitionToThemeMission(
  previous: LibraryMissionState,
  next: LibraryMissionState,
  definition: LibraryBranchingMissionDefinition = LIBRARY_BRANCHING_MISSION,
  legacyDefinition: ThemeMissionDefinition = THEME_MISSION_DEFINITIONS.campus,
): LibraryThemeMissionAdapterStep {
  const previousState = adaptLibraryMissionToThemeMissionState(
    previous,
    definition,
    legacyDefinition,
  );
  const state = adaptLibraryMissionToThemeMissionState(next, definition, legacyDefinition);
  if (
    previousState.completedObjectiveIds.some((id) => !state.completedObjectiveIds.includes(id))
    || (previousState.exitUnlocked && !state.exitUnlocked)
  ) throw new Error("Library legacy projection must be monotonic");
  const newObjectiveIds = state.completedObjectiveIds
    .filter((id) => !previousState.completedObjectiveIds.includes(id));
  const events: ThemeMissionEvent[] = newObjectiveIds.map((objectiveId) => {
    const item = legacyDefinition.objectives.find(({ id }) => id === objectiveId);
    if (!item) throw new Error(`Unknown legacy objective ${objectiveId}`);
    return Object.freeze({
      type: "objective-completed",
      objectiveId,
      verb: item.verb,
    });
  });
  const ghostEvents: GhostRuleEventInput[] = newObjectiveIds.map((objectiveId) => Object.freeze({
    type: "objective-completed",
    objectiveId,
  }));
  if (!previousState.exitUnlocked && state.exitUnlocked) {
    events.push(Object.freeze({
      type: "exit-unlocked",
      objectiveId: legacyDefinition.exitObjectiveId,
    }));
    ghostEvents.push(Object.freeze({
      type: "exit-unlocked",
      objectiveId: legacyDefinition.exitObjectiveId,
    }));
  }
  if (previousState.stage !== state.stage) {
    events.push(Object.freeze({
      type: "stage-changed",
      from: previousState.stage,
      to: state.stage,
    }));
  }
  return Object.freeze({
    state,
    events: Object.freeze(events),
    availableObjectiveIds: availableThemeObjectiveIds(legacyDefinition, state),
    ghostEvents: Object.freeze(ghostEvents),
  });
}

validateLibraryBranchingMissionDefinition(LIBRARY_BRANCHING_MISSION);
