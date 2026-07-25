import type { CampaignTheme } from "./campaign.ts";
import type { LevelDefinition, Point } from "./contracts.ts";
import {
  findPath,
  isWalkable,
  neighbors,
  pointKey,
} from "./navigation.ts";

export type ThemeObjectiveStage = "preparation" | "escape-unlock" | "complete";

export type ThemeObjectiveVerb =
  | "restore-bell-power"
  | "authorize-campus-gate"
  | "release-campus-gate"
  | "engage-backup-generator"
  | "equalize-isolation-pressure"
  | "release-isolation-lock"
  | "prime-smoke-extractor"
  | "release-hydraulic-brake"
  | "raise-apparatus-shutter"
  | "bleed-steam-pressure"
  | "reset-safety-interlock"
  | "release-line-gate";

export interface ObjectiveSoftlockSafety {
  /**
   * A failed or interrupted interaction can always be attempted again.
   * Mandatory objectives may never rely on a one-shot timing window.
   */
  readonly retryable: true;
  /** Mandatory progress cannot consume a unique item before it succeeds. */
  readonly consumesRequiredResource: false;
  /** Completion cannot close the only route to another mandatory objective. */
  readonly closesRequiredRoute: false;
}

export interface ThemeObjectiveDefinition {
  readonly id: string;
  readonly theme: CampaignTheme;
  readonly stage: Exclude<ThemeObjectiveStage, "complete">;
  readonly verb: ThemeObjectiveVerb;
  readonly label: string;
  readonly interactionPrompt: string;
  readonly completionHint: string;
  /**
   * Authored, non-movement commitment used by the mission clock and mastery
   * lower-bound solver. The interaction may be interrupted and retried, but a
   * successful completion must spend at least this long at the control.
   */
  readonly commitmentSeconds: number;
  readonly prerequisites: readonly string[];
  readonly unlocksExit: boolean;
  readonly safety: ObjectiveSoftlockSafety;
}

export interface ThemeMissionDefinition {
  readonly id: string;
  readonly theme: CampaignTheme;
  readonly title: string;
  readonly briefing: string;
  /**
   * Stage one contains two independent objectives. Stage two contains the
   * final exit release and depends on both, so either preparation order works.
   */
  readonly objectives: readonly ThemeObjectiveDefinition[];
  readonly exitObjectiveId: string;
}

export interface ThemeMissionState {
  readonly definitionId: string;
  readonly stage: ThemeObjectiveStage;
  readonly completedObjectiveIds: readonly string[];
  readonly exitUnlocked: boolean;
}

export type ThemeMissionEvent =
  | {
      readonly type: "objective-rejected";
      readonly objectiveId: string;
      readonly reason: "unknown-objective" | "prerequisite-missing" | "already-completed" | "mission-complete";
    }
  | {
      readonly type: "objective-completed";
      readonly objectiveId: string;
      readonly verb: ThemeObjectiveVerb;
    }
  | {
      readonly type: "stage-changed";
      readonly from: ThemeObjectiveStage;
      readonly to: ThemeObjectiveStage;
    }
  | { readonly type: "exit-unlocked"; readonly objectiveId: string };

export interface ThemeMissionStep {
  readonly state: ThemeMissionState;
  readonly events: readonly ThemeMissionEvent[];
  readonly availableObjectiveIds: readonly string[];
}

export interface MissionObjectivePlacement {
  readonly objectiveId: string;
  readonly position: Point;
}

export interface MissionOrderAudit {
  readonly objectiveIds: readonly string[];
  readonly reachable: boolean;
  readonly failedLeg: string | null;
  /** Exact navigable cell distance for this legal order, including the exit. */
  readonly routeDistanceCells: number | null;
}

export interface MissionSoftlockAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly orders: readonly MissionOrderAudit[];
  readonly directRouteDistanceCells: number;
  readonly shortestOrderDistanceCells: number | null;
  readonly longestOrderDistanceCells: number | null;
  readonly shortestDetourRatio: number | null;
  readonly orderImbalanceRatio: number | null;
}

export interface ThemeMissionPlacementOptions {
  /** Shortest legal preparation order relative to the direct spawn→exit path. */
  readonly minimumDetourRatio?: number;
  /** Prevents objectives from turning a chapter into accidental backtracking. */
  readonly maximumDetourRatio?: number;
  /** Difference between the two legal orders, relative to the shorter order. */
  readonly maximumOrderImbalanceRatio?: number;
}

export interface ThemeMissionPlacementPlan {
  readonly placements: readonly MissionObjectivePlacement[];
  readonly audit: MissionSoftlockAudit;
  readonly targetDetourRatio: number;
}

const SOFTLOCK_SAFE: ObjectiveSoftlockSafety = Object.freeze({
  retryable: true,
  consumesRequiredResource: false,
  closesRequiredRoute: false,
});

const OBJECTIVE_COMMITMENT_SECONDS: Readonly<Record<ThemeObjectiveVerb, number>> = Object.freeze({
  "restore-bell-power": 0.9,
  "authorize-campus-gate": 1.1,
  "release-campus-gate": 1,
  "engage-backup-generator": 1.2,
  "equalize-isolation-pressure": 1.1,
  "release-isolation-lock": 0.9,
  "prime-smoke-extractor": 1.15,
  "release-hydraulic-brake": 0.95,
  "raise-apparatus-shutter": 1.25,
  "bleed-steam-pressure": 1.2,
  "reset-safety-interlock": 1,
  "release-line-gate": 1.15,
});

const objective = (
  theme: CampaignTheme,
  id: string,
  stage: ThemeObjectiveDefinition["stage"],
  verb: ThemeObjectiveVerb,
  label: string,
  interactionPrompt: string,
  completionHint: string,
  prerequisites: readonly string[] = [],
  unlocksExit = false,
): ThemeObjectiveDefinition => Object.freeze({
  id,
  theme,
  stage,
  verb,
  label,
  interactionPrompt,
  completionHint,
  commitmentSeconds: OBJECTIVE_COMMITMENT_SECONDS[verb],
  prerequisites: Object.freeze([...prerequisites]),
  unlocksExit,
  safety: SOFTLOCK_SAFE,
});

const mission = (
  value: Omit<ThemeMissionDefinition, "objectives"> & {
    objectives: readonly ThemeObjectiveDefinition[];
  },
): ThemeMissionDefinition => {
  const definition: ThemeMissionDefinition = Object.freeze({
    ...value,
    objectives: Object.freeze([...value.objectives]),
  });
  validateThemeMissionDefinition(definition);
  return definition;
};

const campusPower = "campus:bell-power";
const campusAuthorization = "campus:gate-authorization";
const hospitalPower = "hospital:backup-generator";
const hospitalPressure = "hospital:pressure-bypass";
const fireExtractor = "fire-station:smoke-extractor";
const fireBrake = "fire-station:hydraulic-brake";
const factoryPressure = "factory:steam-bleed";
const factoryInterlock = "factory:safety-interlock";

export const THEME_MISSION_DEFINITIONS: Readonly<Record<CampaignTheme, ThemeMissionDefinition>> = Object.freeze({
  campus: mission({
    id: "theme-mission:campus:v1",
    theme: "campus",
    title: "解除校门封锁",
    briefing: "恢复走廊铃电并完成门禁授权；两处准备可按任意顺序完成。",
    exitObjectiveId: "campus:release-gate",
    objectives: [
      objective(
        "campus",
        campusPower,
        "preparation",
        "restore-bell-power",
        "恢复铃电",
        "合上走廊铃电闸",
        "铃声线路已恢复，可用于掩护行动",
      ),
      objective(
        "campus",
        campusAuthorization,
        "preparation",
        "authorize-campus-gate",
        "授权校门",
        "在门卫终端写入离校授权",
        "门禁已接受离校授权",
      ),
      objective(
        "campus",
        "campus:release-gate",
        "escape-unlock",
        "release-campus-gate",
        "释放校门",
        "解除校门电磁锁",
        "校门已开放，立即撤离",
        [campusPower, campusAuthorization],
        true,
      ),
    ],
  }),
  hospital: mission({
    id: "theme-mission:hospital:v1",
    theme: "hospital",
    title: "解除隔离封锁",
    briefing: "启用备用电源并平衡负压；两项准备完成后才能释放隔离门。",
    exitObjectiveId: "hospital:release-isolation",
    objectives: [
      objective(
        "hospital",
        hospitalPower,
        "preparation",
        "engage-backup-generator",
        "启动备用电源",
        "切入医疗备用发电机",
        "隔离门控制器已重新上电",
      ),
      objective(
        "hospital",
        hospitalPressure,
        "preparation",
        "equalize-isolation-pressure",
        "平衡负压",
        "开启负压旁通阀",
        "门体两侧压差已回到安全范围",
      ),
      objective(
        "hospital",
        "hospital:release-isolation",
        "escape-unlock",
        "release-isolation-lock",
        "释放隔离门",
        "解除隔离区磁力锁",
        "隔离门已解锁，立即撤离",
        [hospitalPower, hospitalPressure],
        true,
      ),
    ],
  }),
  "fire-station": mission({
    id: "theme-mission:fire-station:v1",
    theme: "fire-station",
    title: "打开消防车库",
    briefing: "预热排烟机并释放卷帘液压制动；完成后升起车库卷帘。",
    exitObjectiveId: "fire-station:raise-shutter",
    objectives: [
      objective(
        "fire-station",
        fireExtractor,
        "preparation",
        "prime-smoke-extractor",
        "预热排烟机",
        "启动训练塔排烟机",
        "排烟风道已建立稳定负压",
      ),
      objective(
        "fire-station",
        fireBrake,
        "preparation",
        "release-hydraulic-brake",
        "释放液压制动",
        "扳下卷帘液压旁路",
        "卷帘制动已经释放",
      ),
      objective(
        "fire-station",
        "fire-station:raise-shutter",
        "escape-unlock",
        "raise-apparatus-shutter",
        "升起车库卷帘",
        "持续按住卷帘上升开关",
        "消防车库出口已打开",
        [fireExtractor, fireBrake],
        true,
      ),
    ],
  }),
  factory: mission({
    id: "theme-mission:factory:v1",
    theme: "factory",
    title: "解除产线联锁",
    briefing: "先泄放蒸汽并复位安全联锁；完成后释放产线出口。",
    exitObjectiveId: "factory:release-line-gate",
    objectives: [
      objective(
        "factory",
        factoryPressure,
        "preparation",
        "bleed-steam-pressure",
        "泄放蒸汽",
        "旋开主管泄压阀",
        "主管压力已降到安全阈值",
      ),
      objective(
        "factory",
        factoryInterlock,
        "preparation",
        "reset-safety-interlock",
        "复位安全联锁",
        "复位总装线安全继电器",
        "产线联锁已允许人工释放",
      ),
      objective(
        "factory",
        "factory:release-line-gate",
        "escape-unlock",
        "release-line-gate",
        "释放产线出口",
        "解除出口机械联锁",
        "产线出口已经开放",
        [factoryPressure, factoryInterlock],
        true,
      ),
    ],
  }),
});

function assertNonEmpty(value: string, label: string) {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

export function validateThemeMissionDefinition(definition: ThemeMissionDefinition): void {
  assertNonEmpty(definition.id, "Mission id");
  assertNonEmpty(definition.title, "Mission title");
  if (definition.objectives.length < 3) {
    throw new Error("A two-stage theme mission requires at least three objectives");
  }
  const byId = new Map<string, ThemeObjectiveDefinition>();
  for (const item of definition.objectives) {
    assertNonEmpty(item.id, "Objective id");
    if (item.theme !== definition.theme) throw new Error(`Objective ${item.id} has the wrong theme`);
    if (byId.has(item.id)) throw new Error(`Duplicate objective id: ${item.id}`);
    if (
      !Number.isFinite(item.commitmentSeconds)
      || item.commitmentSeconds < 0.4
      || item.commitmentSeconds > 2.5
    ) throw new Error(`Objective ${item.id} has an invalid commitment time`);
    if (
      item.safety.retryable !== true
      || item.safety.consumesRequiredResource !== false
      || item.safety.closesRequiredRoute !== false
    ) throw new Error(`Objective ${item.id} violates the mandatory softlock contract`);
    byId.set(item.id, item);
  }
  const preparation = definition.objectives.filter((item) => item.stage === "preparation");
  if (preparation.length < 2 || preparation.some((item) => item.prerequisites.length > 0)) {
    throw new Error("Preparation stage requires at least two independent objectives");
  }
  const exitObjectives = definition.objectives.filter((item) => item.unlocksExit);
  if (
    exitObjectives.length !== 1
    || exitObjectives[0].id !== definition.exitObjectiveId
    || exitObjectives[0].stage !== "escape-unlock"
  ) throw new Error("Mission requires exactly one stage-two exit objective");
  for (const item of definition.objectives) {
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) throw new Error(`Objective prerequisite cycle at ${id}`);
      const prerequisite = byId.get(id);
      if (!prerequisite) throw new Error(`Unknown prerequisite ${id} for ${item.id}`);
      seen.add(id);
      for (const nested of prerequisite.prerequisites) visit(nested);
      seen.delete(id);
    };
    for (const prerequisiteId of item.prerequisites) visit(prerequisiteId);
    if (
      item.stage === "escape-unlock"
      && preparation.some((root) => !item.prerequisites.includes(root.id))
    ) throw new Error(`Stage-two objective ${item.id} must depend on every preparation objective`);
  }
}

export function themeMissionDefinition(theme: CampaignTheme): ThemeMissionDefinition {
  return THEME_MISSION_DEFINITIONS[theme];
}

function frozenState(
  definitionId: string,
  stage: ThemeObjectiveStage,
  completedObjectiveIds: readonly string[],
  exitUnlocked: boolean,
): ThemeMissionState {
  return Object.freeze({
    definitionId,
    stage,
    completedObjectiveIds: Object.freeze([...completedObjectiveIds]),
    exitUnlocked,
  });
}

export function createInitialThemeMissionState(
  definition: ThemeMissionDefinition,
): ThemeMissionState {
  validateThemeMissionDefinition(definition);
  return frozenState(definition.id, "preparation", [], false);
}

export function availableThemeObjectiveIds(
  definition: ThemeMissionDefinition,
  state: ThemeMissionState,
): readonly string[] {
  if (state.definitionId !== definition.id || state.stage === "complete") return Object.freeze([]);
  const completed = new Set(state.completedObjectiveIds);
  return Object.freeze(definition.objectives
    .filter((item) => (
      !completed.has(item.id)
      && item.prerequisites.every((id) => completed.has(id))
    ))
    .map((item) => item.id));
}

export function stepThemeMission(
  definition: ThemeMissionDefinition,
  state: ThemeMissionState,
  objectiveId: string,
): ThemeMissionStep {
  if (state.definitionId !== definition.id) throw new Error("Mission state belongs to another definition");
  const events: ThemeMissionEvent[] = [];
  const item = definition.objectives.find((candidate) => candidate.id === objectiveId);
  if (!item) {
    events.push({ type: "objective-rejected", objectiveId, reason: "unknown-objective" });
  } else if (state.stage === "complete") {
    events.push({ type: "objective-rejected", objectiveId, reason: "mission-complete" });
  } else if (state.completedObjectiveIds.includes(objectiveId)) {
    events.push({ type: "objective-rejected", objectiveId, reason: "already-completed" });
  } else if (!item.prerequisites.every((id) => state.completedObjectiveIds.includes(id))) {
    events.push({ type: "objective-rejected", objectiveId, reason: "prerequisite-missing" });
  } else {
    const completed = [...state.completedObjectiveIds, item.id];
    events.push({ type: "objective-completed", objectiveId: item.id, verb: item.verb });
    let stage: ThemeObjectiveStage = state.stage;
    let exitUnlocked = state.exitUnlocked;
    if (item.unlocksExit) {
      stage = "complete";
      exitUnlocked = true;
      events.push({ type: "exit-unlocked", objectiveId: item.id });
    } else {
      const preparationComplete = definition.objectives
        .filter((candidate) => candidate.stage === "preparation")
        .every((candidate) => completed.includes(candidate.id));
      if (preparationComplete && state.stage === "preparation") stage = "escape-unlock";
    }
    if (stage !== state.stage) events.push({ type: "stage-changed", from: state.stage, to: stage });
    state = frozenState(definition.id, stage, completed, exitUnlocked);
  }
  return Object.freeze({
    state,
    events: Object.freeze(events),
    availableObjectiveIds: availableThemeObjectiveIds(definition, state),
  });
}

function permutations(values: readonly string[]): readonly (readonly string[])[] {
  if (values.length <= 1) return [Object.freeze([...values])];
  return Object.freeze(values.flatMap((value, index) => (
    permutations([...values.slice(0, index), ...values.slice(index + 1)])
      .map((tail) => Object.freeze([value, ...tail]))
  )));
}

/**
 * Authoring-time proof for the static mission layer. Every legal preparation
 * order must stay connected from spawn through the final control to the exit.
 * Dynamic doors may open routes, but mandatory completion is forbidden from
 * closing the only route; that property is enforced by ObjectiveSoftlockSafety.
 */
export function auditThemeMissionSoftlock(
  level: LevelDefinition,
  definition: ThemeMissionDefinition,
  placements: readonly MissionObjectivePlacement[],
): MissionSoftlockAudit {
  validateThemeMissionDefinition(definition);
  const failures: string[] = [];
  const placementById = new Map<string, Point>();
  for (const placement of placements) {
    if (placementById.has(placement.objectiveId)) {
      failures.push(`Duplicate placement for ${placement.objectiveId}`);
      continue;
    }
    if (!definition.objectives.some((item) => item.id === placement.objectiveId)) {
      failures.push(`Unknown objective placement ${placement.objectiveId}`);
      continue;
    }
    if (!isWalkable(level, placement.position)) {
      failures.push(`Objective ${placement.objectiveId} is not on a walkable cell`);
    }
    placementById.set(placement.objectiveId, { ...placement.position });
  }
  for (const item of definition.objectives) {
    if (!placementById.has(item.id)) failures.push(`Missing placement for ${item.id}`);
  }

  const preparationIds = definition.objectives
    .filter((item) => item.stage === "preparation")
    .map((item) => item.id);
  const orders = permutations(preparationIds).map((preparationOrder): MissionOrderAudit => {
    const objectiveIds = [...preparationOrder, definition.exitObjectiveId];
    let from = level.playerStart;
    let failedLeg: string | null = null;
    let routeDistanceCells = 0;
    for (const objectiveId of objectiveIds) {
      const to = placementById.get(objectiveId);
      const route = to ? findPath(level, from, to) : [];
      if (!to || route.length === 0) {
        failedLeg = `${from.x},${from.y}->${objectiveId}`;
        break;
      }
      routeDistanceCells += Math.max(0, route.length - 1);
      from = to;
    }
    if (!failedLeg) {
      const exitRoute = findPath(level, from, level.exit);
      if (exitRoute.length === 0) {
        failedLeg = `${definition.exitObjectiveId}->exit`;
      } else {
        routeDistanceCells += Math.max(0, exitRoute.length - 1);
      }
    }
    return Object.freeze({
      objectiveIds: Object.freeze(objectiveIds),
      reachable: failedLeg === null,
      failedLeg,
      routeDistanceCells: failedLeg === null ? routeDistanceCells : null,
    });
  });
  for (const order of orders) {
    if (!order.reachable) failures.push(`Unreachable legal order: ${order.objectiveIds.join(" > ")} (${order.failedLeg})`);
  }
  const directRouteDistanceCells = Math.max(
    0,
    findPath(level, level.playerStart, level.exit).length - 1,
  );
  const legalDistances = orders
    .map((order) => order.routeDistanceCells)
    .filter((distance): distance is number => distance !== null);
  const shortestOrderDistanceCells = legalDistances.length > 0
    ? Math.min(...legalDistances)
    : null;
  const longestOrderDistanceCells = legalDistances.length > 0
    ? Math.max(...legalDistances)
    : null;
  const shortestDetourRatio = shortestOrderDistanceCells !== null
    && directRouteDistanceCells > 0
    ? shortestOrderDistanceCells / directRouteDistanceCells
    : null;
  const orderImbalanceRatio = shortestOrderDistanceCells !== null
    && longestOrderDistanceCells !== null
    && shortestOrderDistanceCells > 0
    ? (longestOrderDistanceCells - shortestOrderDistanceCells) / shortestOrderDistanceCells
    : null;
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    orders: Object.freeze(orders),
    directRouteDistanceCells,
    shortestOrderDistanceCells,
    longestOrderDistanceCells,
    shortestDetourRatio,
    orderImbalanceRatio,
  });
}

const finiteOr = (value: number | undefined, fallback: number) => (
  Number.isFinite(value) ? Number(value) : fallback
);

const defaultPlacementPlanCache = new WeakMap<
  LevelDefinition,
  Map<string, ThemeMissionPlacementPlan>
>();

function campaignDifficulty(level: LevelDefinition): number {
  const candidate = level as LevelDefinition & {
    readonly campaign?: { readonly difficulty?: unknown };
  };
  const difficulty = Number(candidate.campaign?.difficulty);
  return Number.isFinite(difficulty)
    ? Math.min(5, Math.max(1, difficulty))
    : 3;
}

/**
 * Selects objective anchors from the existing navigation graph; it never
 * opens/closes a passage or moves a gameplay anchor. The two preparation
 * controls deliberately sit on different route branches, while the final
 * control remains in the exit approach. This turns the mission into a real
 * routing choice without risking a ten-level layout rewrite.
 */
export function planThemeMissionPlacements(
  level: LevelDefinition,
  definition: ThemeMissionDefinition,
  options: Readonly<ThemeMissionPlacementOptions> = {},
): ThemeMissionPlacementPlan {
  validateThemeMissionDefinition(definition);
  const preparationObjectives = definition.objectives
    .filter((item) => item.stage === "preparation");
  if (preparationObjectives.length !== 2) {
    throw new Error("Theme mission placement currently requires exactly two preparation objectives");
  }
  const cacheable = Object.isFrozen(level) && Object.keys(options).length === 0;
  const cached = cacheable
    ? defaultPlacementPlanCache.get(level)?.get(definition.id)
    : undefined;
  if (cached) return cached;
  const directRoute = findPath(level, level.playerStart, level.exit);
  const directDistance = directRoute.length - 1;
  if (directDistance <= 0) throw new Error(`${level.id} has no navigable mission route`);

  const difficulty = campaignDifficulty(level);
  const minimumDetourRatio = Math.max(
    1,
    finiteOr(options.minimumDetourRatio, 1.12 + difficulty * 0.03),
  );
  const maximumDetourRatio = Math.max(
    minimumDetourRatio,
    finiteOr(options.maximumDetourRatio, 1.85),
  );
  const maximumOrderImbalanceRatio = Math.max(
    0,
    finiteOr(options.maximumOrderImbalanceRatio, 0.32),
  );
  const targetDetourRatio = Math.min(
    maximumDetourRatio,
    minimumDetourRatio + 0.12,
  );

  const walkable: Point[] = [];
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const point = { x, y };
      if (isWalkable(level, point)) walkable.push(point);
    }
  }
  const routeDistanceMaps = new Map<string, Int32Array>();
  const distanceMapFor = (origin: Point) => {
    const originKey = pointKey(origin);
    const cached = routeDistanceMaps.get(originKey);
    if (cached) return cached;
    const size = level.width * level.height;
    const distances = new Int32Array(size);
    distances.fill(-1);
    const queue = new Int32Array(size);
    const start = { x: Math.round(origin.x), y: Math.round(origin.y) };
    const startIndex = start.y * level.width + start.x;
    let head = 0;
    let tail = 0;
    if (isWalkable(level, start)) {
      distances[startIndex] = 0;
      queue[tail++] = startIndex;
    }
    while (head < tail) {
      const currentIndex = queue[head++];
      const current = {
        x: currentIndex % level.width,
        y: Math.floor(currentIndex / level.width),
      };
      for (const next of neighbors(level, current)) {
        const nextIndex = next.y * level.width + next.x;
        if (distances[nextIndex] >= 0) continue;
        distances[nextIndex] = distances[currentIndex] + 1;
        queue[tail++] = nextIndex;
      }
    }
    routeDistanceMaps.set(originKey, distances);
    return distances;
  };
  const routeDistance = (from: Point, to: Point) => {
    const targetX = Math.round(to.x);
    const targetY = Math.round(to.y);
    if (
      targetX < 0
      || targetY < 0
      || targetX >= level.width
      || targetY >= level.height
    ) return Number.POSITIVE_INFINITY;
    const distance = distanceMapFor(from)[targetY * level.width + targetX];
    return distance >= 0 ? distance : Number.POSITIVE_INFINITY;
  };
  const startDistance = new Map(walkable.map((point) => [pointKey(point), routeDistance(level.playerStart, point)]));
  const exitDistance = new Map(walkable.map((point) => [pointKey(point), routeDistance(point, level.exit)]));
  const minimumAnchorClearance = Math.max(2, Math.floor(directDistance * 0.06));

  const preparationCandidates = walkable.filter((point) => {
    const fromStart = startDistance.get(pointKey(point)) ?? Number.POSITIVE_INFINITY;
    const toExit = exitDistance.get(pointKey(point)) ?? Number.POSITIVE_INFINITY;
    return Number.isFinite(fromStart)
      && fromStart >= minimumAnchorClearance
      && toExit >= minimumAnchorClearance
      && pointKey(point) !== pointKey(level.chaserStart);
  });
  const finalCandidates = walkable
    .filter((point) => {
      const fromStart = startDistance.get(pointKey(point)) ?? 0;
      const toExit = exitDistance.get(pointKey(point)) ?? Number.POSITIVE_INFINITY;
      return fromStart >= directDistance * 0.58
        && toExit >= 2
        && toExit <= Math.max(4, directDistance * 0.24);
    })
    .sort((left, right) => {
      const leftDistance = exitDistance.get(pointKey(left)) ?? 0;
      const rightDistance = exitDistance.get(pointKey(right)) ?? 0;
      const target = directDistance * 0.14;
      return Math.abs(leftDistance - target) - Math.abs(rightDistance - target)
        || neighbors(level, right).length - neighbors(level, left).length
        || pointKey(left).localeCompare(pointKey(right));
    })
    .slice(0, 18);

  if (preparationCandidates.length < 2 || finalCandidates.length === 0) {
    throw new Error(`${level.id} has too few safe mission anchors`);
  }

  let selected: {
    readonly first: Point;
    readonly second: Point;
    readonly final: Point;
    readonly score: number;
  } | null = null;
  const minimumPreparationSeparation = Math.max(4, directDistance * 0.12);

  for (const final of finalCandidates) {
    const finalToExit = routeDistance(final, level.exit);
    for (let firstIndex = 0; firstIndex < preparationCandidates.length; firstIndex += 1) {
      const first = preparationCandidates[firstIndex];
      if (pointKey(first) === pointKey(final)) continue;
      for (let secondIndex = firstIndex + 1; secondIndex < preparationCandidates.length; secondIndex += 1) {
        const second = preparationCandidates[secondIndex];
        if (
          pointKey(second) === pointKey(final)
          || routeDistance(first, second) < minimumPreparationSeparation
        ) continue;
        const forward = routeDistance(level.playerStart, first)
          + routeDistance(first, second)
          + routeDistance(second, final)
          + finalToExit;
        const reverse = routeDistance(level.playerStart, second)
          + routeDistance(second, first)
          + routeDistance(first, final)
          + finalToExit;
        if (!Number.isFinite(forward) || !Number.isFinite(reverse)) continue;
        const shorter = Math.min(forward, reverse);
        const longer = Math.max(forward, reverse);
        const detourRatio = shorter / directDistance;
        const imbalanceRatio = (longer - shorter) / Math.max(1, shorter);
        const detourPenalty = Math.abs(detourRatio - targetDetourRatio);
        const lowerBoundPenalty = detourRatio < minimumDetourRatio
          ? (minimumDetourRatio - detourRatio) * 12
          : 0;
        const upperBoundPenalty = detourRatio > maximumDetourRatio
          ? (detourRatio - maximumDetourRatio) * 8
          : 0;
        const imbalancePenalty = imbalanceRatio > maximumOrderImbalanceRatio
          ? (imbalanceRatio - maximumOrderImbalanceRatio) * 10
          : imbalanceRatio * 0.25;
        const branchReward = (
          Math.min(
            routeDistance(level.playerStart, first) + routeDistance(first, level.exit) - directDistance,
            directDistance * 0.4,
          )
          + Math.min(
            routeDistance(level.playerStart, second) + routeDistance(second, level.exit) - directDistance,
            directDistance * 0.4,
          )
        ) / Math.max(1, directDistance) * 0.08;
        const score = lowerBoundPenalty
          + upperBoundPenalty
          + detourPenalty
          + imbalancePenalty
          - branchReward;
        if (
          !selected
          || score < selected.score - 1e-9
          || (
            Math.abs(score - selected.score) <= 1e-9
            && `${pointKey(first)}|${pointKey(second)}|${pointKey(final)}`
              < `${pointKey(selected.first)}|${pointKey(selected.second)}|${pointKey(selected.final)}`
          )
        ) {
          selected = { first, second, final, score };
        }
      }
    }
  }
  if (!selected) throw new Error(`${level.id} has no valid optional-order mission placement`);

  const placements = Object.freeze([
    Object.freeze({ objectiveId: preparationObjectives[0].id, position: Object.freeze({ ...selected.first }) }),
    Object.freeze({ objectiveId: preparationObjectives[1].id, position: Object.freeze({ ...selected.second }) }),
    Object.freeze({ objectiveId: definition.exitObjectiveId, position: Object.freeze({ ...selected.final }) }),
  ]);
  const audit = auditThemeMissionSoftlock(level, definition, placements);
  if (
    !audit.passed
    || audit.shortestDetourRatio === null
    || audit.shortestDetourRatio + 1e-9 < minimumDetourRatio
    || audit.shortestDetourRatio - 1e-9 > maximumDetourRatio
    || audit.orderImbalanceRatio === null
    || audit.orderImbalanceRatio - 1e-9 > maximumOrderImbalanceRatio
  ) {
    throw new Error(
      `${level.id} mission placement missed route contract `
      + `(detour=${audit.shortestDetourRatio?.toFixed(3)}, imbalance=${audit.orderImbalanceRatio?.toFixed(3)})`,
    );
  }
  const plan = Object.freeze({
    placements,
    audit,
    targetDetourRatio,
  });
  if (cacheable) {
    const byDefinition = defaultPlacementPlanCache.get(level) ?? new Map();
    byDefinition.set(definition.id, plan);
    defaultPlacementPlanCache.set(level, byDefinition);
  }
  return plan;
}
