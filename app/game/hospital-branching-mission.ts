import type { LevelDefinition, Point } from "./contracts.ts";
import type { GhostRuleEventInput } from "./ghost-race.ts";
import type { OrderedMasteryMissionRoute } from "./mastery.ts";
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

export const HOSPITAL_BRANCHING_MISSION_VERSION = 1;
export const HOSPITAL_TOOL_LOADOUT_VERSION = 1;
/** Mission, exit, and hide prompts must never compete at the same position. */
export const HOSPITAL_MISSION_INTERACTION_EXCLUSION_CELLS = 2.6;
export const HOSPITAL_MISSION_MINIMUM_SUPPORTED_FRAME_RATE = 30;
/** The authored quiet route must be materially, rather than cosmetically, longer. */
export const HOSPITAL_MISSION_MINIMUM_ROUTE_ADVANTAGE_CELLS = 8;

export type HospitalMissionPlanId =
  | "pharmacy-authorization"
  | "emergency-maintenance";
export type HospitalMissionExitId =
  | "ambulance-entrance"
  | "maintenance-passage";
export type HospitalMissionStatus =
  | "planning"
  | "preparation"
  | "exit-ready"
  | "escaped";
export type HospitalObjectiveAttemptOutcome =
  | "completed"
  | "interrupted"
  | "cancelled";
export type HospitalMissionRouteProfile =
  | "quiet-long"
  | "high-risk-short";

export interface HospitalMissionCommitmentWindow {
  readonly startedAtTick: number;
  readonly durationTicks: number;
  readonly completesAtTick: number;
  readonly durationSeconds: number;
}

export interface HospitalMissionExposureWindow {
  readonly startsAtTick: number;
  readonly durationTicks: number;
  readonly endsAtTick: number;
  readonly durationSeconds: number;
}

/**
 * Converts authored seconds into authoritative simulation ticks. Completing
 * on full 30 Hz frame groups keeps the result identical at 30/60/120/144 Hz.
 */
export function hospitalMissionCommitmentWindow(
  startedAtTick: number,
  requestedSeconds: number,
  fixedStepSeconds: number,
): HospitalMissionCommitmentWindow {
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
      (1 / HOSPITAL_MISSION_MINIMUM_SUPPORTED_FRAME_RATE - 1e-9)
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

/**
 * Places authored exposure at the end of the interaction. Short, quiet
 * terminal work can therefore remain covered until its final confirmation,
 * while an exposure longer than the commitment begins immediately and
 * persists after the interaction completes.
 */
export function hospitalMissionExposureWindow(
  commitment: Readonly<HospitalMissionCommitmentWindow>,
  requestedSeconds: number,
  fixedStepSeconds: number,
): HospitalMissionExposureWindow | null {
  if (!Number.isFinite(requestedSeconds) || requestedSeconds < 0) {
    throw new Error("Mission exposure seconds must be finite and non-negative");
  }
  if (!Number.isFinite(fixedStepSeconds) || fixedStepSeconds <= 0) {
    throw new Error("Mission fixed step must be finite and positive");
  }
  if (requestedSeconds === 0) return null;
  const durationTicks = Math.max(
    1,
    Math.ceil((requestedSeconds - 1e-9) / fixedStepSeconds),
  );
  const startsAtTick = Math.max(
    commitment.startedAtTick,
    commitment.completesAtTick - durationTicks,
  );
  return Object.freeze({
    startsAtTick,
    durationTicks,
    endsAtTick: startsAtTick + durationTicks,
    durationSeconds: durationTicks * fixedStepSeconds,
  });
}

/**
 * Exposure windows describe fixed-step interval boundaries. A commitment
 * created at tick T first affects the interval ending at T + 1, so exactly
 * `durationTicks` samples are active in `(startsAtTick, endsAtTick]`.
 */
export function hospitalMissionExposureActiveAtTick(
  window: Readonly<HospitalMissionExposureWindow>,
  tick: number,
): boolean {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error("Mission exposure sample tick must be a non-negative integer");
  }
  return tick > window.startsAtTick && tick <= window.endsAtTick;
}

export interface HospitalMissionInteractionCost {
  /** Non-movement commitment paid at the authored interaction anchor. */
  readonly commitmentSeconds: number;
  /** Public sound stimulus emitted by the interaction, normalized to [0, 1]. */
  readonly noiseStrength: number;
  /** Seconds for which the interaction leaves the player deliberately exposed. */
  readonly exposureSeconds: number;
}

export interface HospitalMissionPlanCostSummary {
  readonly commitmentSeconds: number;
  readonly noiseStrength: number;
  readonly exposureSeconds: number;
}

export interface HospitalMissionRecoveryPolicy {
  readonly failedObjectivesAreRetryable: true;
  readonly planSwitchAllowedUntilEscape: true;
  readonly completedProgressPersistsAcrossSwitch: true;
  readonly unlockedExitsPersistAcrossSwitch: true;
  readonly consumesRequiredResource: false;
  readonly loadoutIsNeverMissionCritical: true;
}

export interface HospitalMissionObjectiveDefinition {
  readonly id: string;
  readonly planId: HospitalMissionPlanId;
  readonly kind: "preparation" | "exit-unlock";
  readonly label: string;
  readonly interactionPrompt: string;
  readonly completionHint: string;
  readonly cost: HospitalMissionInteractionCost;
  readonly prerequisites: readonly string[];
  readonly unlocksExitId: HospitalMissionExitId | null;
  readonly safety: ObjectiveSoftlockSafety;
}

export interface HospitalMissionPlanDefinition {
  readonly id: HospitalMissionPlanId;
  readonly label: string;
  readonly strategy: string;
  readonly routeProfile: HospitalMissionRouteProfile;
  readonly promise: {
    readonly commitment: "longer" | "shorter";
    readonly noise: "low" | "high";
    readonly exposure: "low" | "high";
  };
  readonly objectiveIds: readonly string[];
  readonly preparationObjectiveIds: readonly string[];
  readonly unlockObjectiveId: string;
  readonly exitId: HospitalMissionExitId;
}

export interface HospitalMissionExitDefinition {
  readonly id: HospitalMissionExitId;
  readonly planId: HospitalMissionPlanId;
  readonly label: string;
  readonly unlockObjectiveId: string;
}

export interface HospitalBranchingMissionDefinition {
  readonly version: typeof HOSPITAL_BRANCHING_MISSION_VERSION;
  readonly id: string;
  readonly levelId: string;
  readonly title: string;
  readonly briefing: string;
  readonly recovery: HospitalMissionRecoveryPolicy;
  readonly plans: readonly HospitalMissionPlanDefinition[];
  readonly objectives: readonly HospitalMissionObjectiveDefinition[];
  readonly exits: readonly HospitalMissionExitDefinition[];
}

export interface HospitalMissionFailedAttempt {
  readonly objectiveId: string;
  readonly count: number;
}

export interface HospitalMissionState {
  readonly version: typeof HOSPITAL_BRANCHING_MISSION_VERSION;
  readonly definitionId: string;
  readonly activePlanId: HospitalMissionPlanId | null;
  readonly status: HospitalMissionStatus;
  readonly completedObjectiveIds: readonly string[];
  readonly unlockedExitIds: readonly HospitalMissionExitId[];
  readonly failedAttempts: readonly HospitalMissionFailedAttempt[];
  readonly escapedViaExitId: HospitalMissionExitId | null;
}

export type HospitalMissionCommand =
  | {
      readonly type: "select-plan";
      readonly planId: HospitalMissionPlanId;
    }
  | {
      readonly type: "attempt-objective";
      readonly objectiveId: string;
      readonly outcome: HospitalObjectiveAttemptOutcome;
    }
  | {
      readonly type: "escape";
      readonly exitId: HospitalMissionExitId;
    };

export type HospitalMissionRejectionReason =
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

export type HospitalMissionEvent =
  | {
      readonly type: "plan-selected";
      readonly planId: HospitalMissionPlanId;
    }
  | {
      readonly type: "plan-switched";
      readonly fromPlanId: HospitalMissionPlanId;
      readonly toPlanId: HospitalMissionPlanId;
      readonly retainedObjectiveIds: readonly string[];
      readonly retainedExitIds: readonly HospitalMissionExitId[];
    }
  | {
      readonly type: "command-rejected";
      readonly commandType: HospitalMissionCommand["type"];
      readonly targetId: string;
      readonly reason: HospitalMissionRejectionReason;
    }
  | {
      readonly type: "objective-attempt-failed";
      readonly objectiveId: string;
      readonly planId: HospitalMissionPlanId;
      readonly reason: Exclude<HospitalObjectiveAttemptOutcome, "completed">;
      readonly retryable: true;
      readonly cost: HospitalMissionInteractionCost;
    }
  | {
      readonly type: "objective-completed";
      readonly objectiveId: string;
      readonly planId: HospitalMissionPlanId;
      readonly cost: HospitalMissionInteractionCost;
    }
  | {
      readonly type: "exit-unlocked";
      readonly exitId: HospitalMissionExitId;
      readonly planId: HospitalMissionPlanId;
      readonly objectiveId: string;
    }
  | {
      readonly type: "mission-completed";
      readonly exitId: HospitalMissionExitId;
      readonly planId: HospitalMissionPlanId;
    };

export interface HospitalMissionStep {
  readonly state: HospitalMissionState;
  readonly events: readonly HospitalMissionEvent[];
  readonly availableObjectiveIds: readonly string[];
  readonly availableExitIds: readonly HospitalMissionExitId[];
}

export interface HospitalMissionReplay {
  readonly state: HospitalMissionState;
  readonly events: readonly HospitalMissionEvent[];
  readonly fingerprint: string;
}

export interface HospitalMissionTopology {
  readonly levelId: string;
  readonly objectivePlacements: readonly {
    readonly objectiveId: string;
    readonly position: Point;
  }[];
  readonly exitPlacements: readonly {
    readonly exitId: HospitalMissionExitId;
    readonly position: Point;
  }[];
}

export interface HospitalPlanTopologyAudit {
  readonly planId: HospitalMissionPlanId;
  readonly exitId: HospitalMissionExitId;
  readonly reachable: boolean;
  readonly failedLeg: string | null;
  readonly routeDistanceCells: number | null;
}

export interface HospitalSwitchTopologyAudit {
  readonly fromPlanId: HospitalMissionPlanId;
  readonly completedPrefixLength: number;
  readonly toPlanId: HospitalMissionPlanId;
  readonly reachable: boolean;
  readonly failedLeg: string | null;
}

export interface HospitalRoutePromiseAudit {
  readonly passed: boolean;
  readonly quietPlanId: HospitalMissionPlanId | null;
  readonly riskyPlanId: HospitalMissionPlanId | null;
  readonly quietRouteDistanceCells: number | null;
  readonly riskyRouteDistanceCells: number | null;
  readonly riskyRouteAdvantageCells: number | null;
}

export interface HospitalMissionEntityTopologyAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly plans: readonly HospitalPlanTopologyAudit[];
  readonly switches: readonly HospitalSwitchTopologyAudit[];
  readonly routePromise: HospitalRoutePromiseAudit;
}

export interface HospitalThemeMissionAdapterStep extends ThemeMissionStep {
  readonly ghostEvents: readonly GhostRuleEventInput[];
}

const SOFTLOCK_SAFE: ObjectiveSoftlockSafety = Object.freeze({
  retryable: true,
  consumesRequiredResource: false,
  closesRequiredRoute: false,
});

export const HOSPITAL_MISSION_RECOVERY_POLICY: HospitalMissionRecoveryPolicy =
  Object.freeze({
    failedObjectivesAreRetryable: true,
    planSwitchAllowedUntilEscape: true,
    completedProgressPersistsAcrossSwitch: true,
    unlockedExitsPersistAcrossSwitch: true,
    consumesRequiredResource: false,
    loadoutIsNeverMissionCritical: true,
  });

function freezeCost(
  value: HospitalMissionInteractionCost,
): HospitalMissionInteractionCost {
  return Object.freeze({ ...value });
}

function freezeObjective(
  value: Omit<HospitalMissionObjectiveDefinition, "safety">,
): HospitalMissionObjectiveDefinition {
  return Object.freeze({
    ...value,
    cost: freezeCost(value.cost),
    prerequisites: Object.freeze([...value.prerequisites]),
    safety: SOFTLOCK_SAFE,
  });
}

function freezePlan(
  value: HospitalMissionPlanDefinition,
): HospitalMissionPlanDefinition {
  return Object.freeze({
    ...value,
    promise: Object.freeze({ ...value.promise }),
    objectiveIds: Object.freeze([...value.objectiveIds]),
    preparationObjectiveIds: Object.freeze([...value.preparationObjectiveIds]),
  });
}

const pharmacyCredential = "hospital:recover-pharmacy-authorization";
const ambulancePermit = "hospital:write-ambulance-egress-permit";
const ambulanceRelease = "hospital:release-ambulance-entrance";
const emergencyPower = "hospital:restore-emergency-power";
const maintenanceInterlock = "hospital:bypass-maintenance-interlock";
const maintenanceRelease = "hospital:release-maintenance-passage";

/**
 * “午夜门诊” keeps the old hospital theme mission intact while defining the
 * richer chapter contract expected by the runtime, replay, and mastery layers.
 */
export const HOSPITAL_BRANCHING_MISSION: HospitalBranchingMissionDefinition =
  Object.freeze({
    version: HOSPITAL_BRANCHING_MISSION_VERSION,
    id: "level-mission:hospital-outpatient-afterhours:g2:v1",
    levelId: "hospital-outpatient-afterhours",
    title: "午夜门诊 · 双线撤离",
    briefing:
      "局前选择安静但漫长的药房授权路线，或高风险的应急供电捷径；两条路线解锁不同实体出口，途中可无损改换计划。",
    recovery: HOSPITAL_MISSION_RECOVERY_POLICY,
    plans: Object.freeze([
      freezePlan({
        id: "pharmacy-authorization",
        label: "药房授权 → 救护车入口",
        strategy:
          "绕行药房与救护调度终端，逐段写入离院许可；公开声音和暴露都较低，但路程及操作时间更长。",
        routeProfile: "quiet-long",
        promise: Object.freeze({
          commitment: "longer",
          noise: "low",
          exposure: "low",
        }),
        objectiveIds: Object.freeze([
          pharmacyCredential,
          ambulancePermit,
          ambulanceRelease,
        ]),
        preparationObjectiveIds: Object.freeze([
          pharmacyCredential,
          ambulancePermit,
        ]),
        unlockObjectiveId: ambulanceRelease,
        exitId: "ambulance-entrance",
      }),
      freezePlan({
        id: "emergency-maintenance",
        label: "应急供电 → 维护通道",
        strategy:
          "在南侧应急配电箱强送电后直接旁路维护联锁；路程和操作更短，但每一步都会制造强公开声音并持续暴露。",
        routeProfile: "high-risk-short",
        promise: Object.freeze({
          commitment: "shorter",
          noise: "high",
          exposure: "high",
        }),
        objectiveIds: Object.freeze([
          emergencyPower,
          maintenanceInterlock,
          maintenanceRelease,
        ]),
        preparationObjectiveIds: Object.freeze([
          emergencyPower,
          maintenanceInterlock,
        ]),
        unlockObjectiveId: maintenanceRelease,
        exitId: "maintenance-passage",
      }),
    ]),
    objectives: Object.freeze([
      freezeObjective({
        id: pharmacyCredential,
        planId: "pharmacy-authorization",
        kind: "preparation",
        label: "取得药房夜间授权",
        interactionPrompt: "在药房授权终端读取夜班药师凭证",
        completionHint: "凭证已取得，前往救护调度终端",
        cost: { commitmentSeconds: 1.4, noiseStrength: 0.05, exposureSeconds: 0.3 },
        prerequisites: Object.freeze([]),
        unlocksExitId: null,
      }),
      freezeObjective({
        id: ambulancePermit,
        planId: "pharmacy-authorization",
        kind: "preparation",
        label: "写入救护车入口许可",
        interactionPrompt: "用药房凭证写入一次性救护通道许可",
        completionHint: "许可已写入，可前往救护车入口控制器",
        cost: { commitmentSeconds: 1.65, noiseStrength: 0.07, exposureSeconds: 0.45 },
        prerequisites: Object.freeze([pharmacyCredential]),
        unlocksExitId: null,
      }),
      freezeObjective({
        id: ambulanceRelease,
        planId: "pharmacy-authorization",
        kind: "exit-unlock",
        label: "释放救护车入口",
        interactionPrompt: "确认许可并解除救护车入口磁力锁",
        completionHint: "救护车入口已解锁",
        cost: { commitmentSeconds: 1.25, noiseStrength: 0.1, exposureSeconds: 0.4 },
        prerequisites: Object.freeze([ambulancePermit]),
        unlocksExitId: "ambulance-entrance",
      }),
      freezeObjective({
        id: emergencyPower,
        planId: "emergency-maintenance",
        kind: "preparation",
        label: "强送应急供电",
        interactionPrompt: "扳动南侧应急配电箱的机械总闸",
        completionHint: "维护回路已带电；巨响会暴露当前位置",
        cost: { commitmentSeconds: 0.85, noiseStrength: 0.85, exposureSeconds: 1.2 },
        prerequisites: Object.freeze([]),
        unlocksExitId: null,
      }),
      freezeObjective({
        id: maintenanceInterlock,
        planId: "emergency-maintenance",
        kind: "preparation",
        label: "旁路维护联锁",
        interactionPrompt: "持续压住维护联锁并插入旁路销",
        completionHint: "联锁已旁路；维护通道允许人工释放",
        cost: { commitmentSeconds: 1, noiseStrength: 0.72, exposureSeconds: 1.35 },
        prerequisites: Object.freeze([emergencyPower]),
        unlocksExitId: null,
      }),
      freezeObjective({
        id: maintenanceRelease,
        planId: "emergency-maintenance",
        kind: "exit-unlock",
        label: "释放维护通道",
        interactionPrompt: "拉下维护通道的紧急释放杆",
        completionHint: "维护通道已解锁；立即撤离",
        cost: { commitmentSeconds: 0.8, noiseStrength: 0.92, exposureSeconds: 1.65 },
        prerequisites: Object.freeze([maintenanceInterlock]),
        unlocksExitId: "maintenance-passage",
      }),
    ]),
    exits: Object.freeze([
      Object.freeze({
        id: "ambulance-entrance",
        planId: "pharmacy-authorization",
        label: "救护车入口",
        unlockObjectiveId: ambulanceRelease,
      }),
      Object.freeze({
        id: "maintenance-passage",
        planId: "emergency-maintenance",
        label: "维护通道",
        unlockObjectiveId: maintenanceRelease,
      }),
    ]),
  });

/**
 * All anchors are authored against the existing outpatient walkable graph.
 * Exits are independent: the ambulance route uses the east entrance while the
 * emergency route terminates at the south-east maintenance branch.
 */
export const HOSPITAL_BRANCHING_MISSION_TOPOLOGY: HospitalMissionTopology =
  Object.freeze({
    levelId: HOSPITAL_BRANCHING_MISSION.levelId,
    objectivePlacements: Object.freeze([
      Object.freeze({
        objectiveId: pharmacyCredential,
        position: Object.freeze({ x: 12, y: 2 }),
      }),
      Object.freeze({
        objectiveId: ambulancePermit,
        position: Object.freeze({ x: 19, y: 4 }),
      }),
      Object.freeze({
        objectiveId: ambulanceRelease,
        position: Object.freeze({ x: 23, y: 4 }),
      }),
      Object.freeze({
        objectiveId: emergencyPower,
        position: Object.freeze({ x: 5, y: 18 }),
      }),
      Object.freeze({
        objectiveId: maintenanceInterlock,
        position: Object.freeze({ x: 11, y: 20 }),
      }),
      Object.freeze({
        objectiveId: maintenanceRelease,
        position: Object.freeze({ x: 18, y: 21 }),
      }),
    ]),
    exitPlacements: Object.freeze([
      Object.freeze({
        exitId: "ambulance-entrance",
        position: Object.freeze({ x: 23, y: 12 }),
      }),
      Object.freeze({
        exitId: "maintenance-passage",
        position: Object.freeze({ x: 23, y: 21 }),
      }),
    ]),
  });

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function planCostSummaryUnchecked(
  definition: HospitalBranchingMissionDefinition,
  plan: HospitalMissionPlanDefinition,
): HospitalMissionPlanCostSummary {
  const costs = plan.objectiveIds
    .map((id) => definition.objectives.find((item) => item.id === id)?.cost)
    .filter((cost): cost is HospitalMissionInteractionCost => Boolean(cost));
  return Object.freeze(costs.reduce(
    (total, cost) => ({
      commitmentSeconds: total.commitmentSeconds + cost.commitmentSeconds,
      noiseStrength: total.noiseStrength + cost.noiseStrength,
      exposureSeconds: total.exposureSeconds + cost.exposureSeconds,
    }),
    { commitmentSeconds: 0, noiseStrength: 0, exposureSeconds: 0 },
  ));
}

export function summarizeHospitalMissionPlanCosts(
  definition: HospitalBranchingMissionDefinition,
  planId: HospitalMissionPlanId,
): HospitalMissionPlanCostSummary {
  const plan = definition.plans.find(({ id }) => id === planId);
  if (!plan) throw new Error(`Unknown hospital mission plan ${planId}`);
  return planCostSummaryUnchecked(definition, plan);
}

function definitionFailures(
  definition: HospitalBranchingMissionDefinition,
): string[] {
  const failures: string[] = [];
  try {
    assertNonEmpty(definition.id, "Mission id");
    assertNonEmpty(definition.levelId, "Mission level id");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (definition.version !== HOSPITAL_BRANCHING_MISSION_VERSION) {
    failures.push("Hospital mission version is unsupported");
  }
  if (definition.plans.length !== 2) {
    failures.push("Hospital mission requires exactly two plans");
  }
  if (definition.exits.length !== 2) {
    failures.push("Hospital mission requires exactly two exits");
  }
  if (
    definition.recovery.failedObjectivesAreRetryable !== true
    || definition.recovery.planSwitchAllowedUntilEscape !== true
    || definition.recovery.completedProgressPersistsAcrossSwitch !== true
    || definition.recovery.unlockedExitsPersistAcrossSwitch !== true
    || definition.recovery.consumesRequiredResource !== false
    || definition.recovery.loadoutIsNeverMissionCritical !== true
  ) {
    failures.push("Hospital mission violates the recovery policy");
  }

  const planById = new Map<HospitalMissionPlanId, HospitalMissionPlanDefinition>();
  const objectiveById = new Map<string, HospitalMissionObjectiveDefinition>();
  const exitById = new Map<HospitalMissionExitId, HospitalMissionExitDefinition>();
  for (const plan of definition.plans) {
    if (planById.has(plan.id)) failures.push(`Duplicate plan ${plan.id}`);
    planById.set(plan.id, plan);
  }
  for (const objective of definition.objectives) {
    if (objectiveById.has(objective.id)) {
      failures.push(`Duplicate objective ${objective.id}`);
    }
    objectiveById.set(objective.id, objective);
    if (
      objective.safety.retryable !== true
      || objective.safety.consumesRequiredResource !== false
      || objective.safety.closesRequiredRoute !== false
    ) {
      failures.push(`Objective ${objective.id} violates the softlock safety contract`);
    }
    const { commitmentSeconds, noiseStrength, exposureSeconds } = objective.cost;
    if (
      !Number.isFinite(commitmentSeconds)
      || commitmentSeconds < 0.4
      || commitmentSeconds > 2.5
    ) {
      failures.push(`Objective ${objective.id} has an invalid commitment cost`);
    }
    if (
      !Number.isFinite(noiseStrength)
      || noiseStrength < 0
      || noiseStrength > 1
    ) {
      failures.push(`Objective ${objective.id} has an invalid noise cost`);
    }
    if (
      !Number.isFinite(exposureSeconds)
      || exposureSeconds < 0
      || exposureSeconds > 3
    ) {
      failures.push(`Objective ${objective.id} has an invalid exposure cost`);
    }
  }
  for (const exit of definition.exits) {
    if (exitById.has(exit.id)) failures.push(`Duplicate exit ${exit.id}`);
    exitById.set(exit.id, exit);
  }

  const routeProfiles = new Set<HospitalMissionRouteProfile>();
  const allOwnedObjectives = new Set<string>();
  for (const plan of definition.plans) {
    routeProfiles.add(plan.routeProfile);
    const exit = exitById.get(plan.exitId);
    if (
      !exit
      || exit.planId !== plan.id
      || exit.unlockObjectiveId !== plan.unlockObjectiveId
    ) {
      failures.push(`Plan ${plan.id} does not own one independent exit`);
    }
    if (
      plan.objectiveIds.length < 2
      || plan.objectiveIds.length > 3
      || plan.preparationObjectiveIds.length !== plan.objectiveIds.length - 1
      || plan.objectiveIds.at(-1) !== plan.unlockObjectiveId
    ) {
      failures.push(`Plan ${plan.id} must contain two or three tasks ending in its exit unlock`);
    }
    if (
      new Set(plan.objectiveIds).size !== plan.objectiveIds.length
      || new Set(plan.preparationObjectiveIds).size
        !== plan.preparationObjectiveIds.length
    ) {
      failures.push(`Plan ${plan.id} repeats objectives`);
    }

    const objectiveIdSet = new Set(plan.objectiveIds);
    for (const objectiveId of plan.objectiveIds) {
      if (allOwnedObjectives.has(objectiveId)) {
        failures.push(`Plans share objective ${objectiveId}`);
      }
      allOwnedObjectives.add(objectiveId);
      const objective = objectiveById.get(objectiveId);
      if (!objective || objective.planId !== plan.id) {
        failures.push(`Plan ${plan.id} references an objective it does not own: ${objectiveId}`);
        continue;
      }
      const shouldUnlock = objectiveId === plan.unlockObjectiveId;
      if (
        (shouldUnlock
          && (objective.kind !== "exit-unlock"
            || objective.unlocksExitId !== plan.exitId))
        || (!shouldUnlock
          && (objective.kind !== "preparation"
            || objective.unlocksExitId !== null))
      ) {
        failures.push(`Objective ${objectiveId} has an invalid phase or exit binding`);
      }
      for (const prerequisiteId of objective.prerequisites) {
        if (!objectiveIdSet.has(prerequisiteId)) {
          failures.push(`Objective ${objectiveId} depends on another plan: ${prerequisiteId}`);
        }
      }
    }
    if (
      plan.preparationObjectiveIds.some((id) => !objectiveIdSet.has(id))
      || plan.preparationObjectiveIds.includes(plan.unlockObjectiveId)
    ) {
      failures.push(`Plan ${plan.id} has invalid preparation objective IDs`);
    }

    const completed = new Set<string>();
    let guard = 0;
    while (
      completed.size < plan.objectiveIds.length
      && guard <= plan.objectiveIds.length
    ) {
      const available = plan.objectiveIds.filter((id) => {
        const objective = objectiveById.get(id);
        return objective
          && !completed.has(id)
          && objective.prerequisites.every((required) => completed.has(required));
      });
      if (available.length === 0) break;
      for (const id of available) completed.add(id);
      guard += 1;
    }
    if (completed.size !== plan.objectiveIds.length) {
      failures.push(`Plan ${plan.id} contains an objective cycle or unreachable prerequisite`);
    }
  }
  if (
    !routeProfiles.has("quiet-long")
    || !routeProfiles.has("high-risk-short")
  ) {
    failures.push("Hospital mission requires one quiet-long and one high-risk-short plan");
  }
  for (const objective of definition.objectives) {
    if (!planById.get(objective.planId)?.objectiveIds.includes(objective.id)) {
      failures.push(`Orphan objective ${objective.id}`);
    }
  }
  for (const exit of definition.exits) {
    if (!planById.has(exit.planId)) failures.push(`Orphan exit ${exit.id}`);
  }

  const quiet = definition.plans.find(({ routeProfile }) => routeProfile === "quiet-long");
  const risky = definition.plans.find(
    ({ routeProfile }) => routeProfile === "high-risk-short",
  );
  if (quiet && risky) {
    const quietCost = planCostSummaryUnchecked(definition, quiet);
    const riskyCost = planCostSummaryUnchecked(definition, risky);
    if (
      quiet.promise.commitment !== "longer"
      || quiet.promise.noise !== "low"
      || quiet.promise.exposure !== "low"
      || risky.promise.commitment !== "shorter"
      || risky.promise.noise !== "high"
      || risky.promise.exposure !== "high"
    ) {
      failures.push("Hospital plan labels do not match their authored cost promise");
    }
    if (quietCost.commitmentSeconds <= riskyCost.commitmentSeconds) {
      failures.push("Quiet route must promise a longer total commitment");
    }
    if (quietCost.noiseStrength >= riskyCost.noiseStrength) {
      failures.push("Quiet route must promise less total public noise");
    }
    if (quietCost.exposureSeconds >= riskyCost.exposureSeconds) {
      failures.push("Quiet route must promise less total exposure");
    }
  }
  return failures;
}

export function validateHospitalBranchingMissionDefinition(
  definition: HospitalBranchingMissionDefinition,
): void {
  const failures = definitionFailures(definition);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

function stateStatus(
  activePlanId: HospitalMissionPlanId | null,
  unlockedExitIds: readonly HospitalMissionExitId[],
  escapedViaExitId: HospitalMissionExitId | null,
): HospitalMissionStatus {
  if (escapedViaExitId) return "escaped";
  if (unlockedExitIds.length > 0) return "exit-ready";
  return activePlanId ? "preparation" : "planning";
}

function freezeState(
  definition: HospitalBranchingMissionDefinition,
  value: Omit<HospitalMissionState, "version" | "definitionId" | "status">,
): HospitalMissionState {
  const completed = definition.objectives
    .map(({ id }) => id)
    .filter((id) => value.completedObjectiveIds.includes(id));
  const exits = definition.exits
    .map(({ id }) => id)
    .filter((id) => value.unlockedExitIds.includes(id));
  const failedAttempts = definition.objectives
    .map(({ id }) => value.failedAttempts.find((entry) => entry.objectiveId === id))
    .filter((entry): entry is HospitalMissionFailedAttempt => Boolean(entry?.count))
    .map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({
    version: HOSPITAL_BRANCHING_MISSION_VERSION,
    definitionId: definition.id,
    activePlanId: value.activePlanId,
    status: stateStatus(value.activePlanId, exits, value.escapedViaExitId),
    completedObjectiveIds: Object.freeze(completed),
    unlockedExitIds: Object.freeze(exits),
    failedAttempts: Object.freeze(failedAttempts),
    escapedViaExitId: value.escapedViaExitId,
  });
}

function validateState(
  definition: HospitalBranchingMissionDefinition,
  state: HospitalMissionState,
) {
  if (
    state.version !== definition.version
    || state.definitionId !== definition.id
  ) {
    throw new Error("Hospital mission state belongs to another definition or version");
  }
  const objectiveIds = new Set(definition.objectives.map(({ id }) => id));
  const exitIds = new Set(definition.exits.map(({ id }) => id));
  if (
    state.activePlanId
    && !definition.plans.some(({ id }) => id === state.activePlanId)
  ) {
    throw new Error("Hospital mission state selects an unknown plan");
  }
  if (
    state.completedObjectiveIds.some((id) => !objectiveIds.has(id))
    || state.unlockedExitIds.some((id) => !exitIds.has(id))
  ) {
    throw new Error("Hospital mission state contains unknown progress");
  }
  if (
    new Set(state.completedObjectiveIds).size
      !== state.completedObjectiveIds.length
    || new Set(state.unlockedExitIds).size !== state.unlockedExitIds.length
    || new Set(state.failedAttempts.map(({ objectiveId }) => objectiveId)).size
      !== state.failedAttempts.length
  ) {
    throw new Error("Hospital mission state contains duplicate progress");
  }
  for (const objectiveId of state.completedObjectiveIds) {
    const objective = definition.objectives.find(({ id }) => id === objectiveId);
    if (
      !objective?.prerequisites.every(
        (required) => state.completedObjectiveIds.includes(required),
      )
    ) {
      throw new Error(`Hospital mission state completed ${objectiveId} before its prerequisite`);
    }
  }
  for (const failed of state.failedAttempts) {
    if (
      !objectiveIds.has(failed.objectiveId)
      || !Number.isInteger(failed.count)
      || failed.count <= 0
    ) {
      throw new Error("Hospital mission state contains an invalid failed attempt");
    }
  }
  for (const exitId of state.unlockedExitIds) {
    const exit = definition.exits.find(({ id }) => id === exitId);
    if (
      !exit
      || !state.completedObjectiveIds.includes(exit.unlockObjectiveId)
    ) {
      throw new Error(`Hospital mission state unlocks ${exitId} without its objective`);
    }
  }
  if (
    state.escapedViaExitId
    && !state.unlockedExitIds.includes(state.escapedViaExitId)
  ) {
    throw new Error("Hospital mission state escaped through a locked exit");
  }
  if (
    state.status !== stateStatus(
      state.activePlanId,
      state.unlockedExitIds,
      state.escapedViaExitId,
    )
  ) {
    throw new Error("Hospital mission state has an inconsistent status");
  }
}

export function createInitialHospitalMissionState(
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
): HospitalMissionState {
  validateHospitalBranchingMissionDefinition(definition);
  return freezeState(definition, {
    activePlanId: null,
    completedObjectiveIds: [],
    unlockedExitIds: [],
    failedAttempts: [],
    escapedViaExitId: null,
  });
}

export function availableHospitalObjectiveIds(
  definition: HospitalBranchingMissionDefinition,
  state: HospitalMissionState,
): readonly string[] {
  validateState(definition, state);
  if (!state.activePlanId || state.status === "escaped") return Object.freeze([]);
  const completed = new Set(state.completedObjectiveIds);
  return Object.freeze(definition.objectives
    .filter((objective) => (
      objective.planId === state.activePlanId
      && !completed.has(objective.id)
      && objective.prerequisites.every((id) => completed.has(id))
    ))
    .map(({ id }) => id));
}

export function availableHospitalExitIds(
  definition: HospitalBranchingMissionDefinition,
  state: HospitalMissionState,
): readonly HospitalMissionExitId[] {
  validateState(definition, state);
  return state.status === "escaped"
    ? Object.freeze([])
    : Object.freeze([...state.unlockedExitIds]);
}

function withAvailability(
  definition: HospitalBranchingMissionDefinition,
  state: HospitalMissionState,
  events: readonly HospitalMissionEvent[],
): HospitalMissionStep {
  return Object.freeze({
    state,
    events: Object.freeze([...events]),
    availableObjectiveIds: availableHospitalObjectiveIds(definition, state),
    availableExitIds: availableHospitalExitIds(definition, state),
  });
}

function rejected(
  definition: HospitalBranchingMissionDefinition,
  state: HospitalMissionState,
  command: HospitalMissionCommand,
  reason: HospitalMissionRejectionReason,
): HospitalMissionStep {
  const targetId = command.type === "select-plan"
    ? command.planId
    : command.type === "attempt-objective"
      ? command.objectiveId
      : command.exitId;
  return withAvailability(definition, state, [Object.freeze({
    type: "command-rejected",
    commandType: command.type,
    targetId,
    reason,
  })]);
}

export function stepHospitalBranchingMission(
  definition: HospitalBranchingMissionDefinition,
  state: HospitalMissionState,
  command: HospitalMissionCommand,
): HospitalMissionStep {
  validateHospitalBranchingMissionDefinition(definition);
  validateState(definition, state);
  if (state.status === "escaped") {
    return rejected(definition, state, command, "mission-complete");
  }

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
    const event: HospitalMissionEvent = previousPlanId
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
    const objective = definition.objectives.find(
      ({ id }) => id === command.objectiveId,
    );
    if (!objective) {
      return rejected(definition, state, command, "unknown-objective");
    }
    if (!state.activePlanId) {
      return rejected(definition, state, command, "plan-not-selected");
    }
    if (objective.planId !== state.activePlanId) {
      return rejected(definition, state, command, "inactive-plan");
    }
    if (state.completedObjectiveIds.includes(objective.id)) {
      return rejected(definition, state, command, "already-completed");
    }
    if (
      !objective.prerequisites.every(
        (id) => state.completedObjectiveIds.includes(id),
      )
    ) {
      return rejected(definition, state, command, "prerequisite-missing");
    }
    if (command.outcome !== "completed") {
      const previousCount = state.failedAttempts
        .find(({ objectiveId }) => objectiveId === objective.id)?.count ?? 0;
      const next = freezeState(definition, {
        ...state,
        failedAttempts: [
          ...state.failedAttempts.filter(
            ({ objectiveId }) => objectiveId !== objective.id,
          ),
          { objectiveId: objective.id, count: previousCount + 1 },
        ],
      });
      return withAvailability(definition, next, [Object.freeze({
        type: "objective-attempt-failed",
        objectiveId: objective.id,
        planId: objective.planId,
        reason: command.outcome,
        retryable: true,
        cost: objective.cost,
      })]);
    }

    const unlockedExitIds = objective.unlocksExitId
      ? [...state.unlockedExitIds, objective.unlocksExitId]
      : state.unlockedExitIds;
    const next = freezeState(definition, {
      ...state,
      completedObjectiveIds: [...state.completedObjectiveIds, objective.id],
      unlockedExitIds,
    });
    const events: HospitalMissionEvent[] = [Object.freeze({
      type: "objective-completed",
      objectiveId: objective.id,
      planId: objective.planId,
      cost: objective.cost,
    })];
    if (objective.unlocksExitId) {
      events.push(Object.freeze({
        type: "exit-unlocked",
        exitId: objective.unlocksExitId,
        planId: objective.planId,
        objectiveId: objective.id,
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

export function replayHospitalMission(
  commands: readonly HospitalMissionCommand[],
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
): HospitalMissionReplay {
  let state = createInitialHospitalMissionState(definition);
  const events: HospitalMissionEvent[] = [];
  for (const command of commands) {
    const step = stepHospitalBranchingMission(definition, state, command);
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
): {
  readonly next: Point;
  readonly distance: number;
  readonly failure: string | null;
} {
  if (!to) {
    return { next: from, distance: 0, failure: `Missing placement for ${label}` };
  }
  const route = findPath(level, from, to);
  return route.length > 0
    ? { next: to, distance: route.length - 1, failure: null }
    : {
        next: from,
        distance: 0,
        failure: `Unreachable leg ${pointKey(from)} -> ${label}`,
      };
}

function validAnchorPoint(position: Point): boolean {
  return Number.isInteger(position.x)
    && Number.isInteger(position.y)
    && Number.isFinite(position.x)
    && Number.isFinite(position.y);
}

/**
 * Audits every authored entity anchor, both complete routes, and every
 * mid-route switch prefix. It also proves the player-facing route promise.
 */
export function auditHospitalMissionEntityTopology(
  level: LevelDefinition,
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
  topology: HospitalMissionTopology = HOSPITAL_BRANCHING_MISSION_TOPOLOGY,
): HospitalMissionEntityTopologyAudit {
  const failures = definitionFailures(definition);
  if (
    level.id !== definition.levelId
    || topology.levelId !== definition.levelId
  ) {
    failures.push("Hospital mission topology belongs to another level");
  }
  const objectivePositions = new Map<string, Point>();
  const exitPositions = new Map<HospitalMissionExitId, Point>();
  const occupied = new Set<string>();

  const auditAnchor = (
    position: Point,
    label: string,
    includeHideExclusion = true,
  ) => {
    if (!validAnchorPoint(position)) {
      failures.push(`${label} does not use an integer grid position`);
    }
    if (!isWalkable(level, position)) {
      failures.push(`${label} is not on a walkable cell`);
    }
    if (includeHideExclusion) {
      for (const hideSpot of level.hideSpots) {
        if (
          Math.hypot(
            position.x - hideSpot.approach.x,
            position.y - hideSpot.approach.y,
          ) < HOSPITAL_MISSION_INTERACTION_EXCLUSION_CELLS
        ) {
          failures.push(`${label} overlaps hide interaction ${hideSpot.id}`);
        }
      }
    }
    const key = pointKey(position);
    if (occupied.has(key)) failures.push(`Mission anchors overlap at ${key}`);
    occupied.add(key);
  };

  for (const placement of topology.objectivePlacements) {
    if (objectivePositions.has(placement.objectiveId)) {
      failures.push(`Duplicate objective placement ${placement.objectiveId}`);
    }
    if (!definition.objectives.some(({ id }) => id === placement.objectiveId)) {
      failures.push(`Unknown objective placement ${placement.objectiveId}`);
    }
    auditAnchor(placement.position, `Objective ${placement.objectiveId}`);
    objectivePositions.set(placement.objectiveId, placement.position);
  }
  for (const objective of definition.objectives) {
    if (!objectivePositions.has(objective.id)) {
      failures.push(`Missing placement for ${objective.id}`);
    }
  }
  for (const placement of topology.exitPlacements) {
    if (exitPositions.has(placement.exitId)) {
      failures.push(`Duplicate exit placement ${placement.exitId}`);
    }
    if (!definition.exits.some(({ id }) => id === placement.exitId)) {
      failures.push(`Unknown exit placement ${placement.exitId}`);
    }
    auditAnchor(placement.position, `Exit ${placement.exitId}`);
    exitPositions.set(placement.exitId, placement.position);
  }
  for (const exit of definition.exits) {
    if (!exitPositions.has(exit.id)) {
      failures.push(`Missing placement for ${exit.id}`);
    }
  }

  const plans = definition.plans.map((plan): HospitalPlanTopologyAudit => {
    let cursor = level.playerStart;
    let distance = 0;
    let failedLeg: string | null = null;
    for (const objectiveId of plan.objectiveIds) {
      const leg = routeLeg(
        level,
        cursor,
        objectivePositions.get(objectiveId),
        objectiveId,
      );
      if (leg.failure) {
        failedLeg = leg.failure;
        break;
      }
      cursor = leg.next;
      distance += leg.distance;
    }
    if (!failedLeg) {
      const leg = routeLeg(
        level,
        cursor,
        exitPositions.get(plan.exitId),
        plan.exitId,
      );
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

  const switches: HospitalSwitchTopologyAudit[] = [];
  for (const fromPlan of definition.plans) {
    for (
      let prefix = 0;
      prefix <= fromPlan.objectiveIds.length;
      prefix += 1
    ) {
      let cursor = level.playerStart;
      let prefixFailure: string | null = null;
      for (const objectiveId of fromPlan.objectiveIds.slice(0, prefix)) {
        const leg = routeLeg(
          level,
          cursor,
          objectivePositions.get(objectiveId),
          objectiveId,
        );
        prefixFailure = leg.failure;
        if (prefixFailure) break;
        cursor = leg.next;
      }
      for (
        const toPlan of definition.plans.filter(({ id }) => id !== fromPlan.id)
      ) {
        let failedLeg = prefixFailure;
        let switchCursor = cursor;
        for (const objectiveId of toPlan.objectiveIds) {
          if (failedLeg) break;
          const leg = routeLeg(
            level,
            switchCursor,
            objectivePositions.get(objectiveId),
            objectiveId,
          );
          failedLeg = leg.failure;
          switchCursor = leg.next;
        }
        if (!failedLeg) {
          failedLeg = routeLeg(
            level,
            switchCursor,
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

  const quietPlan = definition.plans.find(
    ({ routeProfile }) => routeProfile === "quiet-long",
  );
  const riskyPlan = definition.plans.find(
    ({ routeProfile }) => routeProfile === "high-risk-short",
  );
  const quietDistance = plans.find(({ planId }) => planId === quietPlan?.id)
    ?.routeDistanceCells ?? null;
  const riskyDistance = plans.find(({ planId }) => planId === riskyPlan?.id)
    ?.routeDistanceCells ?? null;
  const riskyAdvantage = quietDistance !== null && riskyDistance !== null
    ? quietDistance - riskyDistance
    : null;
  const routePromisePassed = riskyAdvantage !== null
    && riskyAdvantage >= HOSPITAL_MISSION_MINIMUM_ROUTE_ADVANTAGE_CELLS;
  if (!routePromisePassed) {
    failures.push(
      `High-risk route must be at least ${HOSPITAL_MISSION_MINIMUM_ROUTE_ADVANTAGE_CELLS} cells shorter`,
    );
  }
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    plans: Object.freeze(plans),
    switches: Object.freeze(switches),
    routePromise: Object.freeze({
      passed: routePromisePassed,
      quietPlanId: quietPlan?.id ?? null,
      riskyPlanId: riskyPlan?.id ?? null,
      quietRouteDistanceCells: quietDistance,
      riskyRouteDistanceCells: riskyDistance,
      riskyRouteAdvantageCells: riskyAdvantage,
    }),
  });
}

/** Backward-friendly naming for callers that treat topology as a softlock audit. */
export const auditHospitalMissionSoftlocks =
  auditHospitalMissionEntityTopology;

function placementForObjective(
  topology: HospitalMissionTopology,
  objectiveId: string,
): Point {
  const placement = topology.objectivePlacements.find(
    (candidate) => candidate.objectiveId === objectiveId,
  );
  if (!placement) throw new Error(`Missing placement for ${objectiveId}`);
  return placement.position;
}

export function hospitalMissionActiveExitPosition(
  planId: HospitalMissionPlanId,
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
  topology: HospitalMissionTopology = HOSPITAL_BRANCHING_MISSION_TOPOLOGY,
): Point {
  const plan = definition.plans.find(({ id }) => id === planId);
  if (!plan) throw new Error(`Unknown hospital mission plan ${planId}`);
  const placement = topology.exitPlacements.find(
    ({ exitId }) => exitId === plan.exitId,
  );
  if (!placement) throw new Error(`Missing placement for ${plan.exitId}`);
  return Object.freeze({ ...placement.position });
}

/**
 * The existing mastery API routes to level.exit. Callers should pair this
 * ordered route with hospitalMissionLevelForPlan so the audited exit is the
 * selected plan's real physical exit.
 */
export function hospitalMissionMasteryRoute(
  planId: HospitalMissionPlanId,
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
  topology: HospitalMissionTopology = HOSPITAL_BRANCHING_MISSION_TOPOLOGY,
): OrderedMasteryMissionRoute {
  validateHospitalBranchingMissionDefinition(definition);
  const plan = definition.plans.find(({ id }) => id === planId);
  if (!plan) throw new Error(`Unknown hospital mission plan ${planId}`);
  return Object.freeze({
    kind: "ordered",
    id: `${definition.id}:${plan.id}`,
    objectives: Object.freeze(plan.objectiveIds.map((objectiveId) => {
      const objective = definition.objectives.find(({ id }) => id === objectiveId);
      if (!objective) throw new Error(`Unknown objective ${objectiveId}`);
      return Object.freeze({
        id: objective.id,
        position: Object.freeze({
          ...placementForObjective(topology, objective.id),
        }),
        commitmentSeconds: objective.cost.commitmentSeconds,
      });
    })),
  });
}

export function hospitalMissionLevelForPlan(
  level: LevelDefinition,
  planId: HospitalMissionPlanId,
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
  topology: HospitalMissionTopology = HOSPITAL_BRANCHING_MISSION_TOPOLOGY,
): LevelDefinition {
  if (level.id !== definition.levelId) {
    throw new Error("Hospital mastery level belongs to another mission");
  }
  return Object.freeze({
    ...level,
    exit: hospitalMissionActiveExitPosition(planId, definition, topology),
  });
}

/** Direct G2 events preserve real plan objective and exit identity for ghosts. */
export function hospitalMissionEventsToGhostRuleEvents(
  events: readonly HospitalMissionEvent[],
): readonly GhostRuleEventInput[] {
  return Object.freeze(events.flatMap((event): GhostRuleEventInput[] => {
    if (event.type === "objective-completed") {
      return [Object.freeze({
        type: "objective-completed",
        objectiveId: event.objectiveId,
      })];
    }
    if (event.type === "exit-unlocked") {
      return [Object.freeze({
        type: "exit-unlocked",
        objectiveId: event.objectiveId,
      })];
    }
    if (event.type === "mission-completed") {
      return [Object.freeze({ type: "run-completed" })];
    }
    return [];
  }));
}

function planProgress(
  state: HospitalMissionState,
  plan: HospitalMissionPlanDefinition,
): number {
  let progress = 0;
  for (const objectiveId of plan.objectiveIds) {
    if (!state.completedObjectiveIds.includes(objectiveId)) break;
    progress += 1;
  }
  return progress;
}

/**
 * Monotonic compatibility projection for the pre-G2 hospital runtime. It is
 * intentionally a projection only; direct ghost/mastery contracts above keep
 * the selected plan's real objective and exit identities.
 */
export function adaptHospitalMissionToThemeMissionState(
  state: HospitalMissionState,
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
  legacyDefinition: ThemeMissionDefinition = THEME_MISSION_DEFINITIONS.hospital,
): ThemeMissionState {
  validateState(definition, state);
  const legacyObjectives = legacyDefinition.objectives;
  if (legacyObjectives.length !== 3 || legacyDefinition.theme !== "hospital") {
    throw new Error("Hospital adapter requires the three-objective hospital legacy mission");
  }
  const milestoneCount = state.unlockedExitIds.length > 0
    ? legacyObjectives.length
    : Math.max(...definition.plans.map((plan) => planProgress(state, plan)));
  const completedObjectiveIds = legacyObjectives
    .slice(0, milestoneCount)
    .map(({ id }) => id);
  const exitUnlocked = state.unlockedExitIds.length > 0;
  const preparationCount = legacyObjectives.filter(
    ({ stage }) => stage === "preparation",
  ).length;
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

export function adaptHospitalMissionTransitionToThemeMission(
  previous: HospitalMissionState,
  next: HospitalMissionState,
  definition: HospitalBranchingMissionDefinition = HOSPITAL_BRANCHING_MISSION,
  legacyDefinition: ThemeMissionDefinition = THEME_MISSION_DEFINITIONS.hospital,
): HospitalThemeMissionAdapterStep {
  const previousState = adaptHospitalMissionToThemeMissionState(
    previous,
    definition,
    legacyDefinition,
  );
  const state = adaptHospitalMissionToThemeMissionState(
    next,
    definition,
    legacyDefinition,
  );
  if (
    previousState.completedObjectiveIds.some(
      (id) => !state.completedObjectiveIds.includes(id),
    )
    || (previousState.exitUnlocked && !state.exitUnlocked)
  ) {
    throw new Error("Hospital legacy projection must be monotonic");
  }
  const newObjectiveIds = state.completedObjectiveIds.filter(
    (id) => !previousState.completedObjectiveIds.includes(id),
  );
  const events: ThemeMissionEvent[] = newObjectiveIds.map((objectiveId) => {
    const objective = legacyDefinition.objectives.find(
      ({ id }) => id === objectiveId,
    );
    if (!objective) throw new Error(`Unknown legacy objective ${objectiveId}`);
    return Object.freeze({
      type: "objective-completed",
      objectiveId,
      verb: objective.verb,
    });
  });
  const ghostEvents: GhostRuleEventInput[] = newObjectiveIds.map(
    (objectiveId) => Object.freeze({
      type: "objective-completed",
      objectiveId,
    }),
  );
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

export type HospitalLoadoutToolId =
  | "door-wedge"
  | "corner-mirror"
  | "temporary-blackout"
  | "evidence-erasure";

export interface HospitalLoadoutToolDefinition {
  readonly id: HospitalLoadoutToolId;
  readonly label: string;
  readonly description: string;
  readonly runtimeBinding:
    | {
        readonly system: "stealth-toolbelt";
        readonly toolKind:
          | "door-wedge"
          | "corner-mirror"
          | "temporary-blackout";
      }
    | {
        readonly system: "stealth-evidence";
        readonly command: "erase";
      };
  /** No route may require a particular loadout, so every legal pair is safe. */
  readonly missionCritical: false;
}

export interface HospitalToolLoadoutContract {
  readonly version: typeof HOSPITAL_TOOL_LOADOUT_VERSION;
  readonly levelId: string;
  readonly selectionPhase: "pre-run";
  readonly slotCount: 2;
  readonly tools: readonly HospitalLoadoutToolDefinition[];
  readonly recommendedToolIds: readonly [
    HospitalLoadoutToolId,
    HospitalLoadoutToolId,
  ];
}

export interface HospitalToolLoadoutSelection {
  readonly version: typeof HOSPITAL_TOOL_LOADOUT_VERSION;
  readonly levelId: string;
  readonly selectedToolIds: readonly [
    HospitalLoadoutToolId,
    HospitalLoadoutToolId,
  ];
  readonly usesRecommendedLoadout: boolean;
}

export const HOSPITAL_TOOL_LOADOUT: HospitalToolLoadoutContract = Object.freeze({
  version: HOSPITAL_TOOL_LOADOUT_VERSION,
  levelId: HOSPITAL_BRANCHING_MISSION.levelId,
  selectionPhase: "pre-run",
  slotCount: 2,
  tools: Object.freeze([
    Object.freeze({
      id: "door-wedge",
      label: "门楔",
      description: "临时固定一扇可控门，制造一次路线延迟。",
      runtimeBinding: Object.freeze({
        system: "stealth-toolbelt",
        toolKind: "door-wedge",
      }),
      missionCritical: false,
    }),
    Object.freeze({
      id: "corner-mirror",
      label: "拐角镜",
      description: "在不暴露身体的情况下侦察拐角与长走廊。",
      runtimeBinding: Object.freeze({
        system: "stealth-toolbelt",
        toolKind: "corner-mirror",
      }),
      missionCritical: false,
    }),
    Object.freeze({
      id: "temporary-blackout",
      label: "临时断电",
      description: "短暂压低可见性，为高暴露操作创造窗口。",
      runtimeBinding: Object.freeze({
        system: "stealth-toolbelt",
        toolKind: "temporary-blackout",
      }),
      missionCritical: false,
    }),
    Object.freeze({
      id: "evidence-erasure",
      label: "证据抹除",
      description: "支付证据预算与公开扰动成本，清除一条可追踪证据。",
      runtimeBinding: Object.freeze({
        system: "stealth-evidence",
        command: "erase",
      }),
      missionCritical: false,
    }),
  ]),
  recommendedToolIds: Object.freeze([
    "corner-mirror",
    "temporary-blackout",
  ]) as readonly [HospitalLoadoutToolId, HospitalLoadoutToolId],
});

function loadoutFailures(contract: HospitalToolLoadoutContract): string[] {
  const failures: string[] = [];
  if (contract.version !== HOSPITAL_TOOL_LOADOUT_VERSION) {
    failures.push("Hospital loadout version is unsupported");
  }
  if (!contract.levelId.trim()) failures.push("Hospital loadout level id is empty");
  if (contract.selectionPhase !== "pre-run" || contract.slotCount !== 2) {
    failures.push("Hospital loadout must select exactly two tools before the run");
  }
  const expected: readonly HospitalLoadoutToolId[] = [
    "door-wedge",
    "corner-mirror",
    "temporary-blackout",
    "evidence-erasure",
  ];
  const ids = contract.tools.map(({ id }) => id);
  if (
    ids.length !== expected.length
    || expected.some((id) => !ids.includes(id))
    || new Set(ids).size !== ids.length
  ) {
    failures.push("Hospital loadout must expose the four authored tools exactly once");
  }
  if (contract.tools.some(({ missionCritical }) => missionCritical !== false)) {
    failures.push("Hospital loadout tools may not be mission-critical");
  }
  if (
    contract.recommendedToolIds.length !== 2
    || new Set(contract.recommendedToolIds).size !== 2
    || contract.recommendedToolIds.some((id) => !ids.includes(id))
  ) {
    failures.push("Hospital recommended loadout must contain two distinct legal tools");
  }
  return failures;
}

export function validateHospitalToolLoadoutContract(
  contract: HospitalToolLoadoutContract,
): void {
  const failures = loadoutFailures(contract);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

export function createHospitalToolLoadoutSelection(
  selectedToolIds: readonly HospitalLoadoutToolId[] =
    HOSPITAL_TOOL_LOADOUT.recommendedToolIds,
  contract: HospitalToolLoadoutContract = HOSPITAL_TOOL_LOADOUT,
): HospitalToolLoadoutSelection {
  validateHospitalToolLoadoutContract(contract);
  const allowed = new Set(contract.tools.map(({ id }) => id));
  if (selectedToolIds.length !== contract.slotCount) {
    throw new Error("Hospital loadout requires exactly two tools");
  }
  if (new Set(selectedToolIds).size !== selectedToolIds.length) {
    throw new Error("Hospital loadout tools must be distinct");
  }
  if (selectedToolIds.some((id) => !allowed.has(id))) {
    throw new Error("Hospital loadout contains an unknown tool");
  }
  const selected = Object.freeze([
    selectedToolIds[0],
    selectedToolIds[1],
  ]) as readonly [HospitalLoadoutToolId, HospitalLoadoutToolId];
  const recommended = new Set(contract.recommendedToolIds);
  return Object.freeze({
    version: HOSPITAL_TOOL_LOADOUT_VERSION,
    levelId: contract.levelId,
    selectedToolIds: selected,
    usesRecommendedLoadout:
      selected.every((id) => recommended.has(id))
      && recommended.size === selected.length,
  });
}

validateHospitalBranchingMissionDefinition(HOSPITAL_BRANCHING_MISSION);
validateHospitalToolLoadoutContract(HOSPITAL_TOOL_LOADOUT);
