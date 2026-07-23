import type { HideSpotDefinition, LevelDefinition, Point } from "./contracts.ts";
import {
  distanceBetween,
  findPath,
  hasLineOfSight,
  isWalkable,
  neighbors,
} from "./navigation.ts";

export type HideGuidanceRisk = "low" | "medium" | "high";
export type HideGuidanceReason =
  | "tutorial-certified"
  | "unknown-chaser"
  | "stale-chaser-evidence"
  | "known-line-of-sight"
  | "breaks-known-line-of-sight"
  | "evidence-search-can-reach"
  | "chaser-can-intercept"
  | "limited-time-margin"
  | "known-chaser-distant"
  | "chaser-route-blocked";

/**
 * This deliberately accepts a player-facing observation rather than
 * ChaserState. Callers cannot accidentally turn a hidden world position into
 * a HUD hint.
 */
export interface PlayerKnownChaserEvidence {
  readonly position: Point;
  readonly observedAtSeconds: number;
  /** Player-owned memory of where mutual observation last occurred. */
  readonly playerPositionAtObservation?: Point;
}

export interface HideGuidanceInput {
  readonly playerPosition: Point;
  readonly nowSeconds: number;
  /** Pass the player's current pace, including a light-step modifier. */
  readonly playerSpeed: number;
  readonly chaserSpeed: number;
  readonly hideEnterExposureSeconds: number;
  readonly knownChaser?: PlayerKnownChaserEvidence | null;
  /**
   * First-clear preference only. It may win within the safest risk tier, but
   * it can never override a safer candidate or force a high-risk instruction.
   */
  readonly tutorialHideSpotId?: string | null;
  readonly knowledgeFreshSeconds?: number;
  /** Conservative allowance for reaching the interaction anchor and turning. */
  readonly interactionBufferSeconds?: number;
  /** Public difficulty knobs used only with player-owned visual evidence. */
  readonly searchHideCheckBudget?: number;
  readonly searchHideRadiusCells?: number;
}

export interface HideGuidanceCandidate {
  readonly hideSpotId: string;
  readonly routeDistanceCells: number;
  readonly playerArrivalSeconds: number;
  /** Null means the player has no fresh positional evidence to estimate it. */
  readonly chaserArrivalSeconds: number | null;
  /** Positive means the player is expected to finish entering first. */
  readonly interceptMarginSeconds: number | null;
  /** Null means the player has no fresh positional evidence to assess it. */
  readonly breaksKnownLineOfSight: boolean | null;
  /** Time along the player's route before the known sightline is broken. */
  readonly lineOfSightBreakSeconds: number | null;
  /** First route cell screened from the last player-observed chaser position. */
  readonly lineOfSightBreakPoint: Point | null;
  /** Consecutive screened cells after the first sightline break. */
  readonly coveredRouteCells: number | null;
  readonly risk: HideGuidanceRisk;
  readonly reasons: readonly HideGuidanceReason[];
}

export type HideGuidanceSelection = "tutorial" | "survivability" | "held";

export interface HideGuidanceHidePlan {
  readonly strategy: "hide";
  readonly selection: HideGuidanceSelection;
  readonly recommended: HideGuidanceCandidate;
  /** Reachable candidates, ordered by survivability and then route cost. */
  readonly candidates: readonly HideGuidanceCandidate[];
}

export interface HideGuidanceBreakSightPlan {
  readonly strategy: "break-line-of-sight";
  readonly reason: "no-survivable-hide";
  /** Public-geometry cover waypoint; never a locker or hidden live position. */
  readonly waypoint: Point | null;
  readonly recommended: null;
  /** High-risk candidates remain available for honest UI explanation only. */
  readonly candidates: readonly HideGuidanceCandidate[];
}

export type HideGuidancePlan = HideGuidanceHidePlan | HideGuidanceBreakSightPlan;

/**
 * Backward-compatible shape used by the current renderer. New integrations
 * should consume planHideGuidance so "break-line-of-sight" can be explained.
 */
export interface HideGuidanceResult {
  readonly selection: "tutorial" | "nearest";
  readonly recommended: HideGuidanceCandidate;
  readonly candidates: readonly HideGuidanceCandidate[];
}

export type HideGuidanceTargetState =
  | {
      readonly kind: "hide";
      readonly hideSpotId: string;
      readonly selectedAtSeconds: number;
    }
  | {
      readonly kind: "break-line-of-sight";
      readonly waypoint: Point;
      readonly selectedAtSeconds: number;
    };

export interface HideGuidanceStabilityOptions {
  readonly minimumHoldSeconds?: number;
  readonly minimumMarginGainSeconds?: number;
  readonly minimumRouteGainCells?: number;
  readonly playerPosition?: Point;
  readonly waypointReachedCells?: number;
}

export interface StabilizedHideGuidance {
  readonly plan: HideGuidancePlan | null;
  readonly targetState: HideGuidanceTargetState | null;
  readonly switched: boolean;
}

const DEFAULT_KNOWLEDGE_FRESH_SECONDS = 3;
const DEFAULT_INTERACTION_BUFFER_SECONDS = 0.35;
const HIGH_RISK_MARGIN_SECONDS = 0.75;
const MEDIUM_RISK_MARGIN_SECONDS = 2.5;
const SLOW_SIGHT_BREAK_SECONDS = 1.25;

const RISK_RANK: Readonly<Record<HideGuidanceRisk, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

const routeDistanceCells = (route: readonly Point[]) => (
  route.length ? route.length - 1 : Number.POSITIVE_INFINITY
);

function lineOfSightBreak(
  level: LevelDefinition,
  route: readonly Point[],
  knownChaserPosition: Point,
  playerSpeed: number,
): { seconds: number; point: Point | null; coveredCells: number } {
  if (!route.length) {
    return { seconds: Number.POSITIVE_INFINITY, point: null, coveredCells: 0 };
  }
  const firstScreenedIndex = route.findIndex((point) => (
    !hasLineOfSight(level, knownChaserPosition, point)
  ));
  if (firstScreenedIndex < 0) {
    return { seconds: Number.POSITIVE_INFINITY, point: null, coveredCells: 0 };
  }
  let coveredCells = 0;
  while (
    firstScreenedIndex + coveredCells < route.length
    && !hasLineOfSight(
      level,
      knownChaserPosition,
      route[firstScreenedIndex + coveredCells],
    )
  ) coveredCells += 1;
  // Lead the player far enough behind the corner for the sight break to be
  // stable, but never turn an evasion waypoint into the locker itself.
  const maximumWaypointOffset = Math.max(0, route.length - firstScreenedIndex - 2);
  const waypointOffset = Math.min(2, coveredCells - 1, maximumWaypointOffset);
  return {
    seconds: firstScreenedIndex / Math.max(playerSpeed, 1e-6),
    point: { ...route[firstScreenedIndex + Math.max(0, waypointOffset)] },
    coveredCells,
  };
}

function assessCandidate(
  level: LevelDefinition,
  spot: HideSpotDefinition,
  playerRoute: readonly Point[],
  input: HideGuidanceInput,
): HideGuidanceCandidate {
  const distance = routeDistanceCells(playerRoute);
  const playerArrivalSeconds = distance / Math.max(input.playerSpeed, 1e-6)
    + Math.max(0, input.hideEnterExposureSeconds)
    + Math.max(0, input.interactionBufferSeconds ?? DEFAULT_INTERACTION_BUFFER_SECONDS);
  const known = input.knownChaser;
  const freshness = input.knowledgeFreshSeconds ?? DEFAULT_KNOWLEDGE_FRESH_SECONDS;
  const evidenceAgeSeconds = known
    ? Math.max(0, input.nowSeconds - known.observedAtSeconds)
    : Number.POSITIVE_INFINITY;

  if (!known) {
    return Object.freeze({
      hideSpotId: spot.id,
      routeDistanceCells: distance,
      playerArrivalSeconds,
      chaserArrivalSeconds: null,
      interceptMarginSeconds: null,
      breaksKnownLineOfSight: null,
      lineOfSightBreakSeconds: null,
      lineOfSightBreakPoint: null,
      coveredRouteCells: null,
      risk: "medium",
      reasons: Object.freeze(["unknown-chaser"] as const),
    });
  }

  if (evidenceAgeSeconds > freshness) {
    return Object.freeze({
      hideSpotId: spot.id,
      routeDistanceCells: distance,
      playerArrivalSeconds,
      chaserArrivalSeconds: null,
      interceptMarginSeconds: null,
      breaksKnownLineOfSight: null,
      lineOfSightBreakSeconds: null,
      lineOfSightBreakPoint: null,
      coveredRouteCells: null,
      risk: "medium",
      reasons: Object.freeze(["stale-chaser-evidence"] as const),
    });
  }

  const chaserRoute = findPath(level, known.position, spot.approach);
  if (!chaserRoute.length) {
    return Object.freeze({
      hideSpotId: spot.id,
      routeDistanceCells: distance,
      playerArrivalSeconds,
      chaserArrivalSeconds: Number.POSITIVE_INFINITY,
      interceptMarginSeconds: Number.POSITIVE_INFINITY,
      breaksKnownLineOfSight: true,
      lineOfSightBreakSeconds: 0,
      lineOfSightBreakPoint: { ...playerRoute[0] },
      coveredRouteCells: playerRoute.length,
      risk: "low",
      reasons: Object.freeze(["chaser-route-blocked"] as const),
    });
  }

  const chaserDistance = routeDistanceCells(chaserRoute);
  // Fresh evidence still ages between observations. Conservatively grant the
  // chaser that much possible path progress without reading its hidden live
  // position or predicting a privileged route.
  const remainingChaserDistance = Math.max(
    0,
    chaserDistance - evidenceAgeSeconds * Math.max(input.chaserSpeed, 0),
  );
  const chaserArrivalSeconds = remainingChaserDistance / Math.max(input.chaserSpeed, 1e-6);
  const interceptMarginSeconds = chaserArrivalSeconds - playerArrivalSeconds;
  const sightBreak = lineOfSightBreak(
    level,
    playerRoute,
    known.position,
    input.playerSpeed,
  );
  const sightBreakSeconds = sightBreak.seconds;
  const breaksKnownLineOfSight = Number.isFinite(sightBreakSeconds);
  const playerAlreadyScreened = !hasLineOfSight(level, known.position, playerRoute[0]);
  const knownLineOfSightAtHide = hasLineOfSight(level, known.position, spot.approach);
  const directInterceptRelevant = !playerAlreadyScreened;
  const searchEvidenceDistance = known.playerPositionAtObservation
    ? routeDistanceCells(findPath(level, known.playerPositionAtObservation, spot.approach))
    : Number.POSITIVE_INFINITY;
  const evidenceSearchCanReach = (input.searchHideCheckBudget ?? 0) > 0
    && searchEvidenceDistance <= Math.max(0, input.searchHideRadiusCells ?? 0);
  const reasons: HideGuidanceReason[] = [];

  if (knownLineOfSightAtHide) reasons.push("known-line-of-sight");
  else if (breaksKnownLineOfSight) reasons.push("breaks-known-line-of-sight");
  if (evidenceSearchCanReach) reasons.push("evidence-search-can-reach");
  if (
    directInterceptRelevant
    && interceptMarginSeconds <= HIGH_RISK_MARGIN_SECONDS
  ) reasons.push("chaser-can-intercept");
  else if (
    (directInterceptRelevant && interceptMarginSeconds <= MEDIUM_RISK_MARGIN_SECONDS)
    || sightBreakSeconds > SLOW_SIGHT_BREAK_SECONDS
  ) reasons.push("limited-time-margin");

  let risk: HideGuidanceRisk;
  if (
    knownLineOfSightAtHide
    || !breaksKnownLineOfSight
    || evidenceSearchCanReach
    || (directInterceptRelevant && interceptMarginSeconds <= HIGH_RISK_MARGIN_SECONDS)
  ) {
    risk = "high";
  } else if (
    (directInterceptRelevant && interceptMarginSeconds <= MEDIUM_RISK_MARGIN_SECONDS)
    || sightBreakSeconds > SLOW_SIGHT_BREAK_SECONDS
  ) {
    risk = "medium";
  } else {
    risk = "low";
    if (!reasons.length || reasons.every((reason) => reason === "breaks-known-line-of-sight")) {
      reasons.push("known-chaser-distant");
    }
  }

  return Object.freeze({
    hideSpotId: spot.id,
    routeDistanceCells: distance,
    playerArrivalSeconds,
    chaserArrivalSeconds,
    interceptMarginSeconds,
    breaksKnownLineOfSight,
    lineOfSightBreakSeconds: sightBreakSeconds,
    lineOfSightBreakPoint: sightBreak.point,
    coveredRouteCells: sightBreak.coveredCells,
    risk,
    reasons: Object.freeze(reasons),
  });
}

function safetyMargin(candidate: HideGuidanceCandidate): number {
  return candidate.interceptMarginSeconds ?? Number.NEGATIVE_INFINITY;
}

function sightBreakTime(candidate: HideGuidanceCandidate): number {
  return candidate.lineOfSightBreakSeconds ?? Number.POSITIVE_INFINITY;
}

function compareSurvivability(
  left: HideGuidanceCandidate,
  right: HideGuidanceCandidate,
): number {
  return RISK_RANK[left.risk] - RISK_RANK[right.risk]
    || Number(right.breaksKnownLineOfSight === true) - Number(left.breaksKnownLineOfSight === true)
    || sightBreakTime(left) - sightBreakTime(right)
    || (right.coveredRouteCells ?? -1) - (left.coveredRouteCells ?? -1)
    || left.playerArrivalSeconds - right.playerArrivalSeconds
    || safetyMargin(right) - safetyMargin(left)
    || left.routeDistanceCells - right.routeDistanceCells
    || left.hideSpotId.localeCompare(right.hideSpotId);
}

function withTutorialReason(candidate: HideGuidanceCandidate): HideGuidanceCandidate {
  if (candidate.reasons.includes("tutorial-certified")) return candidate;
  return Object.freeze({
    ...candidate,
    reasons: Object.freeze(["tutorial-certified" as const, ...candidate.reasons]),
  });
}

function nearestBreakSightWaypoint(
  level: LevelDefinition,
  playerPosition: Point,
  knownChaserPosition: Point | null,
): Point | null {
  if (!knownChaserPosition) return null;
  const candidates: { point: Point; routeDistance: number; deadEnd: boolean }[] = [];
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const point = { x, y };
      if (!isWalkable(level, point) || hasLineOfSight(level, knownChaserPosition, point)) continue;
      const route = findPath(level, playerPosition, point);
      if (route.length <= 1) continue;
      candidates.push({
        point,
        routeDistance: route.length - 1,
        deadEnd: neighbors(level, point).length <= 1,
      });
    }
  }
  candidates.sort((left, right) => (
    Number(left.deadEnd) - Number(right.deadEnd)
    || left.routeDistance - right.routeDistance
    || left.point.y - right.point.y
    || left.point.x - right.point.x
  ));
  return candidates.length ? Object.freeze({ ...candidates[0].point }) : null;
}

/**
 * Computes an honest player-facing action plan. High-risk lockers are never
 * emitted as a target: when every reachable option is high risk, the result
 * explicitly instructs the caller to break line of sight first.
 */
export function planHideGuidance(
  level: LevelDefinition,
  input: HideGuidanceInput,
): HideGuidancePlan | null {
  const candidates = level.hideSpots
    .map((spot) => {
      const route = findPath(level, input.playerPosition, spot.approach);
      return route.length ? assessCandidate(level, spot, route, input) : null;
    })
    .filter((candidate): candidate is HideGuidanceCandidate => candidate !== null)
    .sort(compareSurvivability);

  if (!candidates.length) return null;
  if (candidates.every((candidate) => candidate.risk === "high")) {
    const routeWaypoint = [...candidates]
      .filter((candidate) => (
        candidate.lineOfSightBreakPoint !== null
        && findPath(level, input.playerPosition, candidate.lineOfSightBreakPoint).length > 1
      ))
      .sort((left, right) => (
        sightBreakTime(left) - sightBreakTime(right)
        || (right.coveredRouteCells ?? -1) - (left.coveredRouteCells ?? -1)
        || compareSurvivability(left, right)
      ))[0]?.lineOfSightBreakPoint;
    return Object.freeze({
      strategy: "break-line-of-sight",
      reason: "no-survivable-hide",
      waypoint: routeWaypoint
        ? Object.freeze({ ...routeWaypoint })
        : nearestBreakSightWaypoint(
            level,
            input.playerPosition,
            input.knownChaser?.position ?? null,
          ),
      recommended: null,
      candidates: Object.freeze(candidates),
    });
  }

  const safestRisk = candidates[0].risk;
  const tutorial = input.tutorialHideSpotId
    ? candidates.find((candidate) => (
        candidate.hideSpotId === input.tutorialHideSpotId
        && candidate.risk === safestRisk
        && candidate.risk !== "high"
      ))
    : undefined;
  const recommended = tutorial ? withTutorialReason(tutorial) : candidates[0];

  return Object.freeze({
    strategy: "hide",
    selection: tutorial ? "tutorial" : "survivability",
    recommended,
    candidates: Object.freeze(candidates),
  });
}

/**
 * Legacy renderer bridge. Returning null for the break-sight strategy removes
 * the misleading locker arrow even before the richer strategy copy is wired.
 */
export function recommendHideSpot(
  level: LevelDefinition,
  input: HideGuidanceInput,
): HideGuidanceResult | null {
  const plan = planHideGuidance(level, input);
  if (!plan || plan.strategy === "break-line-of-sight") return null;
  return Object.freeze({
    selection: plan.selection === "tutorial" ? "tutorial" : "nearest",
    recommended: plan.recommended,
    candidates: plan.candidates,
  });
}

function replaceRecommendation(
  plan: HideGuidanceHidePlan,
  recommended: HideGuidanceCandidate,
): HideGuidanceHidePlan {
  return Object.freeze({
    ...plan,
    selection: "held",
    recommended,
  });
}

function heldBreakSightPlan(
  candidates: readonly HideGuidanceCandidate[],
  waypoint: Point,
): HideGuidanceBreakSightPlan {
  return Object.freeze({
    strategy: "break-line-of-sight",
    reason: "no-survivable-hide",
    waypoint: Object.freeze({ ...waypoint }),
    recommended: null,
    candidates,
  });
}

function reachedBreakSightWaypoint(
  state: Extract<HideGuidanceTargetState, { kind: "break-line-of-sight" }>,
  options: HideGuidanceStabilityOptions,
): boolean {
  return Boolean(
    options.playerPosition
    && distanceBetween(options.playerPosition, state.waypoint)
      <= (options.waypointReachedCells ?? 0.4),
  );
}

/**
 * Pure target hysteresis. Safer targets switch immediately; equally safe
 * targets must provide a material time/route advantage before the hold expires.
 * A break-sight plan always clears the old locker target.
 */
export function stabilizeHideGuidance(
  plan: HideGuidancePlan | null,
  previous: HideGuidanceTargetState | null,
  nowSeconds: number,
  options: HideGuidanceStabilityOptions = {},
): StabilizedHideGuidance {
  if (!plan) {
    return Object.freeze({
      plan,
      targetState: null,
      switched: previous !== null,
    });
  }

  if (plan.strategy === "break-line-of-sight") {
    if (
      previous?.kind === "break-line-of-sight"
      && !reachedBreakSightWaypoint(previous, options)
    ) {
      return Object.freeze({
        plan: heldBreakSightPlan(plan.candidates, previous.waypoint),
        targetState: previous,
        switched: false,
      });
    }
    if (!plan.waypoint) {
      return Object.freeze({
        plan,
        targetState: null,
        switched: previous !== null,
      });
    }
    const breakState = Object.freeze({
      kind: "break-line-of-sight" as const,
      waypoint: Object.freeze({ ...plan.waypoint }),
      selectedAtSeconds: nowSeconds,
    });
    return Object.freeze({ plan, targetState: breakState, switched: true });
  }

  if (
    previous?.kind === "break-line-of-sight"
    && !reachedBreakSightWaypoint(previous, options)
  ) {
    return Object.freeze({
      plan: heldBreakSightPlan(plan.candidates, previous.waypoint),
      targetState: previous,
      switched: false,
    });
  }

  const nextState = Object.freeze({
    kind: "hide" as const,
    hideSpotId: plan.recommended.hideSpotId,
    selectedAtSeconds: nowSeconds,
  });
  if (!previous || previous.kind === "break-line-of-sight") {
    return Object.freeze({ plan, targetState: nextState, switched: true });
  }
  if (previous.hideSpotId === plan.recommended.hideSpotId) {
    return Object.freeze({ plan, targetState: previous, switched: false });
  }

  const previousCandidate = plan.candidates.find((candidate) => (
    candidate.hideSpotId === previous.hideSpotId
  ));
  if (!previousCandidate || previousCandidate.risk === "high") {
    return Object.freeze({ plan, targetState: nextState, switched: true });
  }

  const recommended = plan.recommended;
  const riskDelta = RISK_RANK[recommended.risk] - RISK_RANK[previousCandidate.risk];
  if (riskDelta < 0) {
    return Object.freeze({ plan, targetState: nextState, switched: true });
  }
  if (riskDelta > 0) {
    const held = replaceRecommendation(plan, previousCandidate);
    return Object.freeze({ plan: held, targetState: previous, switched: false });
  }

  const minimumHoldSeconds = options.minimumHoldSeconds ?? 1.25;
  const holdElapsed = Math.max(0, nowSeconds - previous.selectedAtSeconds);
  const gainsLineOfSightBreak = recommended.breaksKnownLineOfSight === true
    && previousCandidate.breaksKnownLineOfSight !== true;
  const marginGain = safetyMargin(recommended) - safetyMargin(previousCandidate);
  const routeGain = previousCandidate.routeDistanceCells - recommended.routeDistanceCells;
  const hasFreshMargins = recommended.interceptMarginSeconds !== null
    && previousCandidate.interceptMarginSeconds !== null;
  const unknownCommitGain = previousCandidate.playerArrivalSeconds
    - recommended.playerArrivalSeconds;
  const materiallyBetter = gainsLineOfSightBreak
    || (hasFreshMargins
      ? marginGain >= (options.minimumMarginGainSeconds ?? 0.75)
      : (
          unknownCommitGain >= (options.minimumMarginGainSeconds ?? 0.75)
          && routeGain >= (options.minimumRouteGainCells ?? 2)
        ));

  if (holdElapsed >= minimumHoldSeconds && materiallyBetter) {
    return Object.freeze({ plan, targetState: nextState, switched: true });
  }
  const held = replaceRecommendation(plan, previousCandidate);
  return Object.freeze({ plan: held, targetState: previous, switched: false });
}
