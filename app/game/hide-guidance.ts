import type { HideSpotDefinition, LevelDefinition, Point } from "./contracts.ts";
import { findPath, hasLineOfSight } from "./navigation.ts";

export type HideGuidanceRisk = "low" | "medium" | "high";
export type HideGuidanceReason =
  | "tutorial-certified"
  | "unknown-chaser"
  | "stale-chaser-evidence"
  | "known-line-of-sight"
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
}

export interface HideGuidanceInput {
  readonly playerPosition: Point;
  readonly nowSeconds: number;
  readonly playerSpeed: number;
  readonly chaserSpeed: number;
  readonly hideEnterExposureSeconds: number;
  readonly knownChaser?: PlayerKnownChaserEvidence | null;
  /** First-clear only; later runs can omit this to restore nearest selection. */
  readonly tutorialHideSpotId?: string | null;
  readonly knowledgeFreshSeconds?: number;
}

export interface HideGuidanceCandidate {
  readonly hideSpotId: string;
  readonly routeDistanceCells: number;
  readonly risk: HideGuidanceRisk;
  readonly reasons: readonly HideGuidanceReason[];
}

export interface HideGuidanceResult {
  readonly selection: "tutorial" | "nearest";
  readonly recommended: HideGuidanceCandidate;
  /** Reachable candidates, ordered by player route distance and stable id. */
  readonly candidates: readonly HideGuidanceCandidate[];
}

const routeDistanceCells = (level: LevelDefinition, from: Point, to: Point) => {
  const route = findPath(level, from, to);
  return route.length ? route.length - 1 : Number.POSITIVE_INFINITY;
};

function classifyRisk(
  level: LevelDefinition,
  spot: HideSpotDefinition,
  playerRouteDistance: number,
  input: HideGuidanceInput,
): Pick<HideGuidanceCandidate, "risk" | "reasons"> {
  const known = input.knownChaser;
  if (!known) return { risk: "medium", reasons: Object.freeze(["unknown-chaser"]) };

  const freshness = input.knowledgeFreshSeconds ?? 3;
  if (input.nowSeconds - known.observedAtSeconds > freshness) {
    return { risk: "medium", reasons: Object.freeze(["stale-chaser-evidence"]) };
  }

  const chaserRouteDistance = routeDistanceCells(level, known.position, spot.approach);
  if (!Number.isFinite(chaserRouteDistance)) {
    return { risk: "low", reasons: Object.freeze(["chaser-route-blocked"]) };
  }

  const playerArrivalSeconds = playerRouteDistance / Math.max(input.playerSpeed, 1e-6)
    + Math.max(0, input.hideEnterExposureSeconds);
  const chaserArrivalSeconds = chaserRouteDistance / Math.max(input.chaserSpeed, 1e-6);
  const timeMarginSeconds = chaserArrivalSeconds - playerArrivalSeconds;
  const knownLineOfSight = hasLineOfSight(level, known.position, spot.approach);
  const reasons: HideGuidanceReason[] = [];

  if (knownLineOfSight) reasons.push("known-line-of-sight");
  if (timeMarginSeconds <= 0.75) reasons.push("chaser-can-intercept");
  else if (timeMarginSeconds <= 2.5) reasons.push("limited-time-margin");

  if (knownLineOfSight || timeMarginSeconds <= 0.75) {
    return { risk: "high", reasons: Object.freeze(reasons) };
  }
  if (timeMarginSeconds <= 2.5) {
    return { risk: "medium", reasons: Object.freeze(reasons) };
  }
  return { risk: "low", reasons: Object.freeze(["known-chaser-distant"]) };
}

export function recommendHideSpot(
  level: LevelDefinition,
  input: HideGuidanceInput,
): HideGuidanceResult | null {
  const candidates = level.hideSpots
    .map((spot) => {
      const distance = routeDistanceCells(level, input.playerPosition, spot.approach);
      if (!Number.isFinite(distance)) return null;
      const assessment = classifyRisk(level, spot, distance, input);
      return Object.freeze({
        hideSpotId: spot.id,
        routeDistanceCells: distance,
        risk: assessment.risk,
        reasons: assessment.reasons,
      }) satisfies HideGuidanceCandidate;
    })
    .filter((candidate): candidate is HideGuidanceCandidate => candidate !== null)
    .sort((left, right) => (
      left.routeDistanceCells - right.routeDistanceCells
      || left.hideSpotId.localeCompare(right.hideSpotId)
    ));

  if (!candidates.length) return null;
  const tutorial = input.tutorialHideSpotId
    ? candidates.find((candidate) => candidate.hideSpotId === input.tutorialHideSpotId)
    : undefined;
  const recommended = tutorial ?? candidates[0];
  const reasons = tutorial && !recommended.reasons.includes("tutorial-certified")
    ? Object.freeze(["tutorial-certified" as const, ...recommended.reasons])
    : recommended.reasons;

  return Object.freeze({
    selection: tutorial ? "tutorial" : "nearest",
    recommended: Object.freeze({ ...recommended, reasons }),
    candidates: Object.freeze(candidates),
  });
}
