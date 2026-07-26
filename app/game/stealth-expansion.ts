import type {
  LevelDefinition,
  PerceptionEvidence,
  Point,
  WorldClueSourceType,
} from "./contracts.ts";
import { hasLineOfSight, isWalkable, normalizeVector } from "./navigation.ts";
import type { AiEvidenceCandidate, StealthEvidenceKind } from "./stealth-evidence.ts";
import type {
  CornerMirrorReceipt,
  DoorWedgeReceipt,
  StealthToolKind,
  StealthToolTarget,
} from "./stealth-toolbelt.ts";
import {
  DEFAULT_TENSION_DIRECTOR_POLICY,
  TENSION_DIRECTOR_VERSION,
  type TensionDirectorDefinition,
  type TensionDirectorSuggestion,
} from "./tension-director.ts";

const CARDINALS: readonly Point[] = Object.freeze([
  Object.freeze({ x: 0, y: -1 }),
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 0, y: 1 }),
  Object.freeze({ x: -1, y: 0 }),
]);

const cell = (point: Point): Point => ({
  x: Math.round(point.x),
  y: Math.round(point.y),
});

function nearbyWalkableCells(
  level: LevelDefinition,
  actorPosition: Point,
): readonly Point[] {
  const origin = cell(actorPosition);
  return [origin, ...CARDINALS.map((offset) => ({
    x: origin.x + offset.x,
    y: origin.y + offset.y,
  }))]
    .filter((candidate) => isWalkable(level, candidate))
    .sort((left, right) => (
      Math.hypot(left.x - actorPosition.x, left.y - actorPosition.y)
        - Math.hypot(right.x - actorPosition.x, right.y - actorPosition.y)
      || left.y - right.y
      || left.x - right.x
    ));
}

function opaqueDirections(level: LevelDefinition, point: Point): readonly Point[] {
  return CARDINALS.filter((offset) => !isWalkable(level, {
    x: point.x + offset.x,
    y: point.y + offset.y,
  }));
}

function isNarrowDoorCell(level: LevelDefinition, point: Point): boolean {
  const north = isWalkable(level, { x: point.x, y: point.y - 1 });
  const east = isWalkable(level, { x: point.x + 1, y: point.y });
  const south = isWalkable(level, { x: point.x, y: point.y + 1 });
  const west = isWalkable(level, { x: point.x - 1, y: point.y });
  return (north && south && !east && !west)
    || (east && west && !north && !south);
}

function doorTraversalAxis(
  level: LevelDefinition,
  point: Point,
): "horizontal" | "vertical" | null {
  if (!isNarrowDoorCell(level, point)) return null;
  return isWalkable(level, { x: point.x, y: point.y - 1 })
    ? "vertical"
    : "horizontal";
}

function nearestAuthoredThreshold(
  level: LevelDefinition,
  actorPosition: Point,
): Point | null {
  const candidates = nearbyWalkableCells(level, actorPosition);
  return candidates.find((candidate) => isNarrowDoorCell(level, candidate))
    ?? null;
}

function isOpaqueCornerCell(level: LevelDefinition, point: Point): boolean {
  const opaque = opaqueDirections(level, point);
  return opaque.some((first) => opaque.some((second) => (
    first !== second
    && first.x * second.x + first.y * second.y === 0
  )));
}

function nearestOpaqueCorner(
  level: LevelDefinition,
  actorPosition: Point,
): Point | null {
  const candidates = nearbyWalkableCells(level, actorPosition);
  return candidates.find((candidate) => isOpaqueCornerCell(level, candidate))
    ?? null;
}

function cornerObservationHeading(
  level: LevelDefinition,
  corner: Point,
  actorPosition: Point,
  actorHeading: Point,
): Point {
  const approach = normalizeVector({
    x: actorPosition.x - corner.x,
    y: actorPosition.y - corner.y,
  }, actorHeading);
  const openDirections = CARDINALS.filter((direction) => isWalkable(level, {
    x: corner.x + direction.x,
    y: corner.y + direction.y,
  }));
  const aroundCorner = openDirections
    .filter((direction) => (
      direction.x * approach.x + direction.y * approach.y < 0.5
    ))
    .sort((left, right) => (
      (right.x * actorHeading.x + right.y * actorHeading.y)
        - (left.x * actorHeading.x + left.y * actorHeading.y)
    ));
  return Object.freeze({
    ...(aroundCorner[0] ?? openDirections[0] ?? normalizeVector(actorHeading)),
  });
}

/**
 * Resolves only public authored geometry. Door/mirror anchors are walkable
 * threshold cells; blackout always binds to the visible theme control panel.
 */
export function resolveStealthToolTarget(
  tool: StealthToolKind,
  level: LevelDefinition,
  actorPosition: Point,
  actorHeading: Point,
  powerCircuitPosition: Point,
): StealthToolTarget | null {
  if (tool === "temporary-blackout") {
    return Object.freeze({
      kind: "power-circuit",
      id: `${level.id}:primary-lighting-circuit`,
      interactionPoint: Object.freeze({ ...powerCircuitPosition }),
      autoRestoreTicks: 360,
      emergencyVisibilityFloor: 0.35,
    });
  }
  if (tool === "door-wedge") {
    const threshold = nearestAuthoredThreshold(level, actorPosition);
    if (!threshold) return null;
    const traversalAxis = doorTraversalAxis(level, threshold);
    if (!traversalAxis) return null;
    return Object.freeze({
      kind: "door",
      id: `${level.id}:threshold:${threshold.x}:${threshold.y}`,
      interactionPoint: Object.freeze(threshold),
      routeSafetyAuditId: `${level.id}:player-route-remains-open:v1`,
      traversalAxis,
      playerPassageRemainsAvailable: true,
      autoReleaseTicks: 300,
    });
  }
  const corner = nearestOpaqueCorner(level, actorPosition);
  if (!corner) return null;
  const outwardHeading = cornerObservationHeading(
    level,
    corner,
    actorPosition,
    actorHeading,
  );
  return Object.freeze({
    kind: "corner",
    id: `${level.id}:corner:${corner.x}:${corner.y}`,
    interactionPoint: Object.freeze(corner),
    hasOpaqueCorner: true,
    outwardHeading: Object.freeze(outwardHeading),
  });
}

/**
 * A wedge delays only a public traversal attempt through its authored narrow
 * threshold. Merely standing beside the wall, moving parallel to the doorway,
 * or moving away cannot trigger it.
 */
export function isDoorWedgeTraversalAttempt(
  receipt: DoorWedgeReceipt,
  chaserPosition: Point,
  chaserHeading: Point,
): boolean {
  const heading = normalizeVector(chaserHeading);
  const toDoor = {
    x: receipt.riskEvidence.position.x - chaserPosition.x,
    y: receipt.riskEvidence.position.y - chaserPosition.y,
  };
  const vertical = receipt.effect.traversalAxis === "vertical";
  const alongDistance = Math.abs(vertical ? toDoor.y : toDoor.x);
  const crossDistance = Math.abs(vertical ? toDoor.x : toDoor.y);
  const axisAlignment = Math.abs(vertical ? heading.y : heading.x);
  const approachDot = toDoor.x * heading.x + toDoor.y * heading.y;
  return alongDistance <= 0.95
    && crossDistance <= 0.34
    && axisAlignment >= 0.72
    && approachDot >= -0.06;
}

export function canCornerMirrorObservePoint(
  receipt: CornerMirrorReceipt,
  point: Point,
  level: LevelDefinition,
): boolean {
  const offset = {
    x: point.x - receipt.effect.origin.x,
    y: point.y - receipt.effect.origin.y,
  };
  const distance = Math.hypot(offset.x, offset.y);
  if (distance > receipt.effect.rangeCells + Number.EPSILON) return false;
  const heading = normalizeVector(receipt.effect.heading);
  const alignment = distance <= 1e-9
    ? 1
    : (offset.x * heading.x + offset.y * heading.y) / distance;
  const minimumAlignment = Math.cos(receipt.effect.coneDegrees * Math.PI / 360);
  return alignment + Number.EPSILON >= minimumAlignment
    && hasLineOfSight(level, receipt.effect.origin, point);
}

const WORLD_CLUE_SOURCE: Readonly<Record<StealthEvidenceKind, WorldClueSourceType>> =
  Object.freeze({
    footprint: "footprint",
    "door-state": "door-disturbance",
    "moved-object": "disturbed-prop",
    "power-change": "infrastructure-anomaly",
    "decoy-residue": "disturbed-prop",
  });

export function aiEvidenceCandidateToPerception(
  candidate: AiEvidenceCandidate,
  observedAtSeconds: number,
): Extract<PerceptionEvidence, { kind: "world-clue" }> {
  return Object.freeze({
    kind: "world-clue",
    clueId: candidate.evidence.id,
    position: Object.freeze({ ...candidate.evidence.position }),
    observedAtSeconds,
    confidence: candidate.evidence.confidence,
    sourceType: WORLD_CLUE_SOURCE[candidate.evidence.kind],
    decayPerSecond: 0.055,
  });
}

export function createCampaignTensionDirectorDefinition(
  levelId: string,
  routeIds: readonly string[],
  fixedStepSeconds: number,
): TensionDirectorDefinition {
  const routes = routeIds.length ? [...new Set(routeIds)] : [`${levelId}:primary-route`];
  return Object.freeze({
    version: TENSION_DIRECTOR_VERSION,
    id: `${levelId}:fair-tension-director`,
    routeIds: Object.freeze(routes),
    minimumLegalRouteCount: 1,
    policy: Object.freeze({
      ...DEFAULT_TENSION_DIRECTOR_POLICY,
      fixedStepSeconds,
    }),
    events: Object.freeze([
      Object.freeze({
        id: "public-address-sweep",
        label: "广播巡检",
        kind: "broadcast",
        minimumTier: "watchful",
        warningTicks: 120,
        durationTicks: 240,
        cooldownTicks: 660,
        publicChannelId: `${levelId}:public-address`,
        blockedRouteIds: Object.freeze([]),
        intensityPermille: 620,
      }),
      Object.freeze({
        id: "patrol-pressure-window",
        label: "巡逻提速",
        kind: "patrol-pressure",
        minimumTier: "heightened",
        warningTicks: 150,
        durationTicks: 360,
        cooldownTicks: 780,
        publicChannelId: null,
        blockedRouteIds: Object.freeze([]),
        intensityPermille: 180,
      }),
      Object.freeze({
        id: "lighting-load-shed",
        label: "照明降载",
        kind: "blackout",
        minimumTier: "watchful",
        warningTicks: 180,
        durationTicks: 300,
        cooldownTicks: 900,
        publicChannelId: `${levelId}:lighting-grid`,
        blockedRouteIds: Object.freeze([]),
        intensityPermille: 480,
      }),
    ]),
  });
}

export function tensionDirectorModifiers(
  suggestion: TensionDirectorSuggestion | null,
  active: boolean,
) {
  if (!suggestion || !active) {
    return Object.freeze({
      chaserSpeedMultiplier: 1,
      visionRangeMultiplier: 1,
      soundMasking: 0,
    });
  }
  const intensity = suggestion.intensityPermille / 1_000;
  return Object.freeze({
    chaserSpeedMultiplier: suggestion.kind === "patrol-pressure"
      ? 1 + Math.min(0.25, intensity)
      : 1,
    visionRangeMultiplier: suggestion.kind === "blackout"
      ? Math.max(0.5, 1 - intensity)
      : 1,
    soundMasking: suggestion.kind === "broadcast"
      ? Math.min(0.42, intensity * 0.55)
      : 0,
  });
}
