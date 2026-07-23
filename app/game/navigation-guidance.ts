import type { Point } from "./contracts.ts";

export type ObjectiveGuidanceMode = "direct" | "next-turn";

/** A player-facing cue derived from a legal route, never from hidden actors. */
export interface RouteTurnHint {
  readonly direction: Point;
  readonly distanceMeters: number;
}

export interface RouteGuidanceGeometry {
  readonly routeDistanceMeters: number;
  readonly routeDirection: Point | null;
  readonly nextTurn: RouteTurnHint | null;
}

export interface ObjectiveGuidanceState {
  readonly previousRouteDistanceMeters: number | null;
  /** Last distance that represented enough progress to reset the stall timer. */
  readonly progressReferenceRouteDistanceMeters: number | null;
  readonly noProgressSeconds: number;
  readonly wrongDirectionSeconds: number;
  readonly recoverySeconds: number;
  readonly routeHintActive: boolean;
}

export interface ObjectiveGuidanceInput {
  readonly deltaSeconds: number;
  /** Remaining distance along the currently legal route to the objective. */
  readonly routeDistanceMeters: number;
  /** Movement signal in world-space; intended movement lets wall stalls escalate too. */
  readonly movement: Point;
  /** Direction of the route's immediate legal leg. */
  readonly routeDirection?: Point | null;
  /** The next route-aware cue to expose only after escalation. */
  readonly nextTurn?: RouteTurnHint | null;
  readonly progressDistanceMeters?: number;
  readonly noProgressThresholdSeconds?: number;
  readonly wrongDirectionThresholdSeconds?: number;
  readonly recoveryThresholdSeconds?: number;
}

export interface ObjectiveGuidanceResult {
  readonly state: ObjectiveGuidanceState;
  readonly mode: ObjectiveGuidanceMode;
  readonly nextTurn: RouteTurnHint | null;
}

const finiteNonNegative = (value: number | undefined, fallback = 0) => (
  value !== undefined && Number.isFinite(value) ? Math.max(0, value) : fallback
);

const length = (value: Point | null | undefined) => {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return 0;
  return Math.hypot(value.x, value.y);
};

const validTurnHint = (hint: RouteTurnHint | null | undefined): hint is RouteTurnHint => {
  if (!hint) return false;
  return length(hint.direction) > 1e-6
    && Number.isFinite(hint.distanceMeters)
    && hint.distanceMeters >= 0;
};

export function createObjectiveGuidanceState(): ObjectiveGuidanceState {
  return Object.freeze({
    previousRouteDistanceMeters: null,
    progressReferenceRouteDistanceMeters: null,
    noProgressSeconds: 0,
    wrongDirectionSeconds: 0,
    recoverySeconds: 0,
    routeHintActive: false,
  });
}

const normalizedSegment = (from: Point, to: Point): Point | null => {
  const x = to.x - from.x;
  const y = to.y - from.y;
  const segmentLength = Math.hypot(x, y);
  return segmentLength > 1e-6 ? { x: x / segmentLength, y: y / segmentLength } : null;
};

/** Extracts only legal route geometry; it contains no hidden actor state. */
export function deriveRouteGuidanceGeometry(
  route: readonly Point[],
  cellMeters = 1,
): RouteGuidanceGeometry {
  const metersPerCell = Number.isFinite(cellMeters) ? Math.max(0.01, cellMeters) : 1;
  const routeDistanceMeters = Math.max(0, route.length - 1) * metersPerCell;
  if (route.length < 2) {
    return Object.freeze({ routeDistanceMeters, routeDirection: null, nextTurn: null });
  }
  const routeDirection = normalizedSegment(route[0], route[1]);
  if (!routeDirection) {
    return Object.freeze({ routeDistanceMeters, routeDirection: null, nextTurn: null });
  }
  for (let index = 2; index < route.length; index += 1) {
    const direction = normalizedSegment(route[index - 1], route[index]);
    if (!direction) continue;
    const alignment = routeDirection.x * direction.x + routeDirection.y * direction.y;
    if (alignment < 0.999) {
      return Object.freeze({
        routeDistanceMeters,
        routeDirection: Object.freeze(routeDirection),
        nextTurn: Object.freeze({
          direction: Object.freeze(direction),
          distanceMeters: (index - 1) * metersPerCell,
        }),
      });
    }
  }
  return Object.freeze({
    routeDistanceMeters,
    routeDirection: Object.freeze(routeDirection),
    nextTurn: null,
  });
}

/**
 * Holds the simple objective cue during ordinary exploration. It exposes a
 * route-aware next-turn hint only after the player has been moving without
 * progress or has persistently travelled against the route. Once shown, the
 * cue needs sustained real progress to dismiss, preventing junction flicker.
 */
export function updateObjectiveGuidance(
  previous: ObjectiveGuidanceState,
  input: ObjectiveGuidanceInput,
): ObjectiveGuidanceResult {
  const deltaSeconds = Math.min(0.25, finiteNonNegative(input.deltaSeconds));
  const routeDistanceMeters = Number.isFinite(input.routeDistanceMeters)
    ? Math.max(0, input.routeDistanceMeters)
    : null;
  const progressDistanceMeters = Math.max(0.05, finiteNonNegative(input.progressDistanceMeters, 0.3));
  const movementLength = length(input.movement);
  const moving = movementLength >= Math.max(0.03, progressDistanceMeters * 0.16);
  const progressReference = previous.progressReferenceRouteDistanceMeters ?? routeDistanceMeters;
  const madeProgress = routeDistanceMeters !== null
    && progressReference !== null
    && progressReference - routeDistanceMeters >= progressDistanceMeters;
  const movingTowardObjective = routeDistanceMeters !== null
    && previous.previousRouteDistanceMeters !== null
    && routeDistanceMeters + 1e-5 < previous.previousRouteDistanceMeters;
  const routeDirectionLength = length(input.routeDirection);
  const wrongDirection = moving
    && routeDirectionLength > 1e-6
    && (input.movement.x * input.routeDirection!.x + input.movement.y * input.routeDirection!.y)
      / (movementLength * routeDirectionLength) <= -0.25;
  const routeRemaining = routeDistanceMeters !== null && routeDistanceMeters > progressDistanceMeters;
  const noProgressSeconds = madeProgress
    ? 0
    : routeRemaining && moving
      ? finiteNonNegative(previous.noProgressSeconds) + deltaSeconds
      : Math.max(0, finiteNonNegative(previous.noProgressSeconds) - deltaSeconds * 2);
  const wrongDirectionSeconds = routeRemaining && wrongDirection
    ? finiteNonNegative(previous.wrongDirectionSeconds) + deltaSeconds
    : Math.max(0, finiteNonNegative(previous.wrongDirectionSeconds) - deltaSeconds * 2);
  const canShowRouteHint = routeRemaining && validTurnHint(input.nextTurn);
  const noProgressThreshold = Math.max(0.25, finiteNonNegative(input.noProgressThresholdSeconds, 2.2));
  const wrongDirectionThreshold = Math.max(0.2, finiteNonNegative(input.wrongDirectionThresholdSeconds, 0.8));
  const recoveryThreshold = Math.max(0.2, finiteNonNegative(input.recoveryThresholdSeconds, 0.65));
  let routeHintActive = previous.routeHintActive && canShowRouteHint;
  let recoverySeconds = routeHintActive && movingTowardObjective
    ? finiteNonNegative(previous.recoverySeconds) + deltaSeconds
    : 0;
  if (routeHintActive && recoverySeconds >= recoveryThreshold) {
    routeHintActive = false;
    recoverySeconds = 0;
  }
  if (!routeHintActive && canShowRouteHint && (
    noProgressSeconds >= noProgressThreshold
    || wrongDirectionSeconds >= wrongDirectionThreshold
  )) {
    routeHintActive = true;
  }
  const state = Object.freeze({
    previousRouteDistanceMeters: routeDistanceMeters,
    progressReferenceRouteDistanceMeters: madeProgress ? routeDistanceMeters : progressReference,
    noProgressSeconds: routeHintActive ? noProgressSeconds : Math.min(noProgressSeconds, noProgressThreshold),
    wrongDirectionSeconds: routeHintActive
      ? wrongDirectionSeconds
      : Math.min(wrongDirectionSeconds, wrongDirectionThreshold),
    recoverySeconds,
    routeHintActive,
  });
  return Object.freeze({
    state,
    mode: routeHintActive ? "next-turn" : "direct",
    nextTurn: routeHintActive && validTurnHint(input.nextTurn) ? input.nextTurn : null,
  });
}
