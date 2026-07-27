import type { CampaignTheme } from "./campaign.ts";
import type { Point } from "./contracts.ts";
import type { LandmarkBeatPlan } from "./environment-composition.ts";

/**
 * Pure composition contracts for placing authored hero spaces and framing the
 * hospital chapter. This module intentionally owns no Three.js objects, scene
 * mutations or asset URLs.
 */

export type NarrativeLandmarkBeat = Pick<
  LandmarkBeatPlan,
  "id" | "focusCell" | "routeTangent" | "lateralBias" | "routeIndex"
>;

export interface NarrativeRoomAnchor {
  readonly cell: Point;
  readonly point: Point;
  /** Rotation around world up; authored forward is (sin(rotation), cos(rotation)). */
  readonly rotation: number;
}

export interface NarrativeAnchorSelectionOptions {
  /**
   * Selected hero roots must keep this much grid-space separation. The
   * runtime's authored decor anchors already use 3.4 cells, so matching that
   * value preserves the established navigation/readability margin.
   */
  readonly minimumSpacingCells?: number;
  /**
   * Optional rejection radius. Infinity keeps the nearest valid room anchor
   * available and lets the runtime retain its existing explicit fallback.
   */
  readonly maximumBeatDistanceCells?: number;
}

export interface NarrativeAnchorSelection {
  readonly beatId: string;
  readonly beatIndex: number;
  readonly routeIndex: number;
  readonly matched: boolean;
  readonly candidateKey: string | null;
  readonly anchor: NarrativeRoomAnchor | null;
  readonly distanceCells: number | null;
  /** 0 is opposite the authored side, 1 is exactly on it, 0.5 is neutral. */
  readonly routeSideAlignment: number | null;
  /** 0 faces away from the beat, 1 faces it, 0.5 is neutral. */
  readonly facingAlignment: number | null;
  readonly score: number | null;
}

export const NARRATIVE_ANCHOR_SELECTION_DEFAULTS = Object.freeze({
  minimumSpacingCells: 3.4,
  maximumBeatDistanceCells: Number.POSITIVE_INFINITY,
  routeSidePenaltyWeight: 0.9,
  facingPenaltyWeight: 0.55,
});

interface CandidateRecord {
  readonly key: string;
  readonly placementKey: string;
  readonly anchor: NarrativeRoomAnchor;
}

interface CandidateMatch {
  readonly candidate: CandidateRecord;
  readonly distanceCells: number;
  readonly routeSideAlignment: number;
  readonly facingAlignment: number;
  readonly score: number;
}

interface SearchResult {
  readonly assignments: readonly (CandidateMatch | null)[];
  readonly matchedCount: number;
  readonly totalScore: number;
  readonly signature: string;
}

const SCORE_EPSILON = 1e-9;
const MAXIMUM_SPACING_CELLS = 64;
const MAXIMUM_BEAT_DISTANCE_CELLS = 256;

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function frozenPoint(point: Point): Point {
  return Object.freeze({ x: point.x, y: point.y });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function boundedOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === Number.POSITIVE_INFINITY && fallback === Number.POSITIVE_INFINITY) {
    return value;
  }
  return Number.isFinite(value)
    ? clamp(value as number, minimum, maximum)
    : fallback;
}

function normalized(point: Point): Point | null {
  const length = Math.hypot(point.x, point.y);
  return length > 1e-9 && Number.isFinite(length)
    ? { x: point.x / length, y: point.y / length }
    : null;
}

function dot(left: Point, right: Point): number {
  return left.x * right.x + left.y * right.y;
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function canonicalNumber(value: number): string {
  const rounded = Math.abs(value) < 5e-7 ? 0 : value;
  return rounded.toFixed(6);
}

function normalizedRotation(rotation: number): number {
  const tau = Math.PI * 2;
  const wrapped = ((rotation + Math.PI) % tau + tau) % tau - Math.PI;
  return Math.abs(wrapped) < 1e-12 ? 0 : wrapped;
}

function candidatePlacementKey(anchor: NarrativeRoomAnchor): string {
  return [
    canonicalNumber(anchor.cell.x),
    canonicalNumber(anchor.cell.y),
    canonicalNumber(anchor.point.x),
    canonicalNumber(anchor.point.y),
  ].join(":");
}

function candidateKey(anchor: NarrativeRoomAnchor): string {
  return `${candidatePlacementKey(anchor)}:${canonicalNumber(normalizedRotation(anchor.rotation))}`;
}

function canonicalCandidates(
  anchors: readonly NarrativeRoomAnchor[],
): readonly CandidateRecord[] {
  const byKey = new Map<string, CandidateRecord>();
  for (const anchor of anchors) {
    if (
      !anchor
      || !finitePoint(anchor.cell)
      || !finitePoint(anchor.point)
      || !Number.isFinite(anchor.rotation)
    ) {
      continue;
    }
    const frozenAnchor = Object.freeze({
      cell: frozenPoint(anchor.cell),
      point: frozenPoint(anchor.point),
      rotation: normalizedRotation(anchor.rotation),
    });
    const placementKey = candidatePlacementKey(frozenAnchor);
    const record = Object.freeze({
      key: candidateKey(frozenAnchor),
      placementKey,
      anchor: frozenAnchor,
    });
    if (!byKey.has(record.key)) byKey.set(record.key, record);
  }
  return Object.freeze(
    [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function alignment01(left: Point | null, right: Point | null): number {
  if (!left || !right) return 0.5;
  return clamp((dot(left, right) + 1) / 2, 0, 1);
}

function matchForCandidate(
  beat: NarrativeLandmarkBeat,
  candidate: CandidateRecord,
): CandidateMatch {
  const routeTangent = normalized(beat.routeTangent);
  const preferredSide = routeTangent
    ? {
        x: routeTangent.y * beat.lateralBias,
        y: -routeTangent.x * beat.lateralBias,
      }
    : null;
  const beatToAnchor = normalized({
    x: candidate.anchor.point.x - beat.focusCell.x,
    y: candidate.anchor.point.y - beat.focusCell.y,
  });
  const anchorToBeat = normalized({
    x: beat.focusCell.x - candidate.anchor.point.x,
    y: beat.focusCell.y - candidate.anchor.point.y,
  });
  const authoredForward = {
    x: Math.sin(candidate.anchor.rotation),
    y: Math.cos(candidate.anchor.rotation),
  };
  const distanceCells = distance(beat.focusCell, candidate.anchor.point);
  const routeSideAlignment = alignment01(preferredSide, beatToAnchor);
  const facingAlignment = alignment01(authoredForward, anchorToBeat);
  const score = distanceCells
    + (1 - routeSideAlignment)
      * NARRATIVE_ANCHOR_SELECTION_DEFAULTS.routeSidePenaltyWeight
    + (1 - facingAlignment)
      * NARRATIVE_ANCHOR_SELECTION_DEFAULTS.facingPenaltyWeight;
  return Object.freeze({
    candidate,
    distanceCells,
    routeSideAlignment,
    facingAlignment,
    score,
  });
}

function isBetterSearchResult(
  candidate: SearchResult,
  current: SearchResult | null,
): boolean {
  if (!current) return true;
  if (candidate.matchedCount !== current.matchedCount) {
    return candidate.matchedCount > current.matchedCount;
  }
  if (Math.abs(candidate.totalScore - current.totalScore) > SCORE_EPSILON) {
    return candidate.totalScore < current.totalScore;
  }
  return candidate.signature.localeCompare(current.signature) < 0;
}

/**
 * Selects a globally consistent authored room anchor for each landmark beat.
 *
 * Match count wins before score, preventing an early greedy choice from
 * starving a later beat. Within a full match, distance is the primary cost
 * while route-side and authored-facing alignment break near ties. The current
 * production contract has three beats and at most fourteen candidates, so the
 * exhaustive search remains tiny and gives deterministic, order-independent
 * results.
 */
export function selectNarrativeRoomAnchors(
  beats: readonly NarrativeLandmarkBeat[],
  roomAnchors: readonly NarrativeRoomAnchor[],
  options: NarrativeAnchorSelectionOptions = {},
): readonly NarrativeAnchorSelection[] {
  if (beats.length === 0) return Object.freeze([]);
  const candidates = canonicalCandidates(roomAnchors);
  const minimumSpacingCells = boundedOption(
    options.minimumSpacingCells,
    NARRATIVE_ANCHOR_SELECTION_DEFAULTS.minimumSpacingCells,
    0,
    MAXIMUM_SPACING_CELLS,
  );
  const maximumBeatDistanceCells = boundedOption(
    options.maximumBeatDistanceCells,
    NARRATIVE_ANCHOR_SELECTION_DEFAULTS.maximumBeatDistanceCells,
    0,
    MAXIMUM_BEAT_DISTANCE_CELLS,
  );
  const candidateMatches = beats.map((beat) => {
    if (
      !beat
      || !finitePoint(beat.focusCell)
      || !finitePoint(beat.routeTangent)
      || (beat.lateralBias !== -1 && beat.lateralBias !== 1)
    ) {
      return Object.freeze([]) as readonly CandidateMatch[];
    }
    return Object.freeze(
      candidates
        .map((candidate) => matchForCandidate(beat, candidate))
        .filter(({ distanceCells }) => distanceCells <= maximumBeatDistanceCells)
        .sort((left, right) => (
          left.score - right.score
          || left.candidate.key.localeCompare(right.candidate.key)
        )),
    );
  });

  const searchState: { best: SearchResult | null } = { best: null };
  const assignments: (CandidateMatch | null)[] = Array(beats.length).fill(null);
  const selectedCandidates: CandidateRecord[] = [];

  const search = (
    beatIndex: number,
    matchedCount: number,
    totalScore: number,
  ) => {
    const maximumPossibleMatches = matchedCount + beats.length - beatIndex;
    if (
      searchState.best
      && maximumPossibleMatches < searchState.best.matchedCount
    ) {
      return;
    }
    if (beatIndex >= beats.length) {
      const snapshot = Object.freeze([...assignments]);
      const result: SearchResult = Object.freeze({
        assignments: snapshot,
        matchedCount,
        totalScore,
        signature: snapshot
          .map((match) => match?.candidate.key ?? "~")
          .join("|"),
      });
      if (isBetterSearchResult(result, searchState.best)) {
        searchState.best = result;
      }
      return;
    }

    for (const match of candidateMatches[beatIndex]) {
      if (selectedCandidates.some(({ placementKey }) => (
        placementKey === match.candidate.placementKey
      ))) {
        continue;
      }
      if (selectedCandidates.some((selected) => (
        distance(selected.anchor.point, match.candidate.anchor.point)
          + SCORE_EPSILON < minimumSpacingCells
      ))) {
        continue;
      }
      assignments[beatIndex] = match;
      selectedCandidates.push(match.candidate);
      search(beatIndex + 1, matchedCount + 1, totalScore + match.score);
      selectedCandidates.pop();
      assignments[beatIndex] = null;
    }

    assignments[beatIndex] = null;
    search(beatIndex + 1, matchedCount, totalScore);
  };

  search(0, 0, 0);
  const resolvedAssignments = searchState.best?.assignments ?? assignments;
  return Object.freeze(beats.map((beat, beatIndex) => {
    const match = resolvedAssignments[beatIndex];
    return Object.freeze({
      beatId: beat.id,
      beatIndex,
      routeIndex: beat.routeIndex,
      matched: Boolean(match),
      candidateKey: match?.candidate.key ?? null,
      anchor: match?.candidate.anchor ?? null,
      distanceCells: match?.distanceCells ?? null,
      routeSideAlignment: match?.routeSideAlignment ?? null,
      facingAlignment: match?.facingAlignment ?? null,
      score: match?.score ?? null,
    });
  }));
}

export interface FixedBearingCameraPolicy {
  readonly profile: "hospital-cinematic" | "default";
  readonly bearingMode: "fixed";
  readonly allowsBearingRotation: false;
  readonly edgeInsetWorldUnits: number;
  readonly maximumFocusShiftWorldUnits: number;
  readonly safeHorizontalNdc: number;
  readonly safeVerticalNdc: number;
  /** Screenshot acceptance target, not a source of runtime camera rotation. */
  readonly maximumDarkExteriorFraction: number;
}

export type FixedBearingCameraPolicyOverrides = Partial<Pick<
  FixedBearingCameraPolicy,
  | "edgeInsetWorldUnits"
  | "maximumFocusShiftWorldUnits"
  | "safeHorizontalNdc"
  | "safeVerticalNdc"
  | "maximumDarkExteriorFraction"
>>;

export interface CameraBearing {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FixedBearingCameraPlan {
  readonly bearing: CameraBearing;
  readonly policy: FixedBearingCameraPolicy;
}

export const FIXED_BEARING_CAMERA_POLICY_BOUNDS = Object.freeze({
  edgeInsetWorldUnits: Object.freeze({ minimum: 0, maximum: 12 }),
  maximumFocusShiftWorldUnits: Object.freeze({ minimum: 0, maximum: 8 }),
  safeHorizontalNdc: Object.freeze({ minimum: 0.05, maximum: 0.9 }),
  safeVerticalNdc: Object.freeze({ minimum: 0.05, maximum: 0.9 }),
  maximumDarkExteriorFraction: Object.freeze({ minimum: 0.1, maximum: 0.5 }),
});

export const DEFAULT_FIXED_BEARING_CAMERA_POLICY: FixedBearingCameraPolicy =
  Object.freeze({
    profile: "default",
    bearingMode: "fixed",
    allowsBearingRotation: false,
    edgeInsetWorldUnits: 7.4,
    maximumFocusShiftWorldUnits: 5.2,
    safeHorizontalNdc: 0.44,
    safeVerticalNdc: 0.34,
    maximumDarkExteriorFraction: 0.35,
  });

export const HOSPITAL_FIXED_BEARING_CAMERA_POLICY: FixedBearingCameraPolicy =
  Object.freeze({
    profile: "hospital-cinematic",
    bearingMode: "fixed",
    allowsBearingRotation: false,
    edgeInsetWorldUnits: 9,
    maximumFocusShiftWorldUnits: 6.8,
    safeHorizontalNdc: 0.52,
    safeVerticalNdc: 0.38,
    maximumDarkExteriorFraction: 0.25,
  });

function boundedPolicyValue(
  value: number | undefined,
  fallback: number,
  bounds: { readonly minimum: number; readonly maximum: number },
): number {
  return Number.isFinite(value)
    ? clamp(value as number, bounds.minimum, bounds.maximum)
    : fallback;
}

/**
 * Hospital receives a stronger inward focus translation. Every other theme,
 * including an unknown future theme, retains the current traversal defaults.
 */
export function fixedBearingCameraPolicyForTheme(
  theme: CampaignTheme | string,
  overrides: FixedBearingCameraPolicyOverrides = {},
): FixedBearingCameraPolicy {
  const base = theme === "hospital"
    ? HOSPITAL_FIXED_BEARING_CAMERA_POLICY
    : DEFAULT_FIXED_BEARING_CAMERA_POLICY;
  return Object.freeze({
    profile: base.profile,
    bearingMode: "fixed",
    allowsBearingRotation: false,
    edgeInsetWorldUnits: boundedPolicyValue(
      overrides.edgeInsetWorldUnits,
      base.edgeInsetWorldUnits,
      FIXED_BEARING_CAMERA_POLICY_BOUNDS.edgeInsetWorldUnits,
    ),
    maximumFocusShiftWorldUnits: boundedPolicyValue(
      overrides.maximumFocusShiftWorldUnits,
      base.maximumFocusShiftWorldUnits,
      FIXED_BEARING_CAMERA_POLICY_BOUNDS.maximumFocusShiftWorldUnits,
    ),
    safeHorizontalNdc: boundedPolicyValue(
      overrides.safeHorizontalNdc,
      base.safeHorizontalNdc,
      FIXED_BEARING_CAMERA_POLICY_BOUNDS.safeHorizontalNdc,
    ),
    safeVerticalNdc: boundedPolicyValue(
      overrides.safeVerticalNdc,
      base.safeVerticalNdc,
      FIXED_BEARING_CAMERA_POLICY_BOUNDS.safeVerticalNdc,
    ),
    maximumDarkExteriorFraction: boundedPolicyValue(
      overrides.maximumDarkExteriorFraction,
      base.maximumDarkExteriorFraction,
      FIXED_BEARING_CAMERA_POLICY_BOUNDS.maximumDarkExteriorFraction,
    ),
  });
}

/**
 * Couples the focus policy to an immutable bearing without normalizing,
 * rotating or otherwise changing the input direction.
 */
export function createFixedBearingCameraPlan(
  theme: CampaignTheme | string,
  bearing: CameraBearing,
  overrides: FixedBearingCameraPolicyOverrides = {},
): FixedBearingCameraPlan {
  if (![bearing.x, bearing.y, bearing.z].every(Number.isFinite)) {
    throw new RangeError("Fixed camera bearing must contain finite x/y/z components");
  }
  return Object.freeze({
    bearing: Object.freeze({
      x: bearing.x,
      y: bearing.y,
      z: bearing.z,
    }),
    policy: fixedBearingCameraPolicyForTheme(theme, overrides),
  });
}
