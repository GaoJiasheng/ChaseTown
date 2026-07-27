import type { Point } from "./contracts.ts";

export type HospitalDressingCategory =
  | "ambient"
  | "featured"
  | "narrative"
  | "shared";

export interface HospitalDressingAnchor {
  readonly cell: Point;
  readonly point: Point;
  readonly rotation: number;
}

export interface HospitalDressingFootprintSpec {
  /** Local X half-extent in grid cells. */
  readonly halfWidth: number;
  /** Local Z half-extent in grid cells. */
  readonly halfDepth: number;
}

export interface HospitalDressingFootprint extends HospitalDressingFootprintSpec {
  readonly center: Point;
  readonly rotationRadians: number;
}

export interface HospitalDressingRequest {
  readonly id: string;
  readonly category: Exclude<HospitalDressingCategory, "narrative">;
  readonly footprint: HospitalDressingFootprintSpec;
}

export interface HospitalDressingReservation {
  readonly id: string;
  readonly category: "narrative";
  readonly footprint: HospitalDressingFootprint;
}

export interface HospitalDressingPlacement {
  readonly id: string;
  readonly category: Exclude<HospitalDressingCategory, "narrative">;
  readonly anchor: HospitalDressingAnchor;
  readonly footprint: HospitalDressingFootprint;
  readonly bayIndex: number;
  readonly tangentOffsetCells: number;
  readonly depthOffsetCells: number;
}

export interface HospitalDressingLayout {
  readonly placements: readonly HospitalDressingPlacement[];
  readonly reservations: readonly HospitalDressingReservation[];
  readonly unplacedIds: readonly string[];
}

export interface HospitalDressingLayoutOptions {
  readonly minimumClearanceCells?: number;
  readonly supportsFootprint?: (
    footprint: HospitalDressingFootprint,
    request: HospitalDressingRequest,
  ) => boolean;
}

/**
 * Conservative runtime footprints in grid cells, derived from the fitted GLB
 * bounds used by `fitProp`/`anchorAuthoredStatic`. The small margin included
 * here is separate from the inter-object clearance applied by the planner.
 */
export const HOSPITAL_DRESSING_FOOTPRINTS = Object.freeze({
  narrativeCluster: Object.freeze({ halfWidth: 0.72, halfDepth: 0.38 }),
  ambientCluster: Object.freeze({ halfWidth: 0.54, halfDepth: 0.4 }),
  HospitalBed: Object.freeze({ halfWidth: 0.52, halfDepth: 0.25 }),
  HospitalIVStation: Object.freeze({ halfWidth: 0.25, halfDepth: 0.23 }),
  HospitalCrashCart: Object.freeze({ halfWidth: 0.26, halfDepth: 0.2 }),
  HospitalPrivacyScreen: Object.freeze({ halfWidth: 0.69, halfDepth: 0.07 }),
  bulletin: Object.freeze({ halfWidth: 0.53, halfDepth: 0.08 }),
} as const satisfies Readonly<Record<string, HospitalDressingFootprintSpec>>);

export const HOSPITAL_DRESSING_MINIMUM_CLEARANCE_CELLS = 0.12;

// Each authored room anchor is a bay entrance, not an exclusive prop origin.
// A compact two-dimensional slot lattice lets a large room host several
// independently validated props while retaining deterministic wall alignment.
const BAY_SLOT_OFFSETS_CELLS = Object.freeze([
  0,
  0.8,
  -0.8,
  1.6,
  -1.6,
  2.4,
  -2.4,
  3.2,
  -3.2,
]);
const SEARCH_NODE_BUDGET = 75_000;
const EPSILON = 1e-9;

interface PlacementCandidate extends HospitalDressingPlacement {
  readonly score: number;
  readonly signature: string;
}

function finitePoint(point: Point): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function freezePoint(point: Point): Point {
  return Object.freeze({ x: point.x, y: point.y });
}

function validFootprintSpec(
  footprint: HospitalDressingFootprintSpec,
): boolean {
  return Number.isFinite(footprint.halfWidth)
    && Number.isFinite(footprint.halfDepth)
    && footprint.halfWidth >= 0
    && footprint.halfDepth >= 0;
}

function canonicalNumber(value: number): string {
  return (Math.abs(value) < 5e-7 ? 0 : value).toFixed(6);
}

function placementSignature(
  point: Point,
  rotation: number,
): string {
  return [
    canonicalNumber(point.x),
    canonicalNumber(point.y),
    canonicalNumber(rotation),
  ].join(":");
}

export function hospitalDressingFootprintAt(
  anchor: Pick<HospitalDressingAnchor, "point" | "rotation">,
  spec: HospitalDressingFootprintSpec,
): HospitalDressingFootprint {
  if (
    !finitePoint(anchor.point)
    || !Number.isFinite(anchor.rotation)
    || !validFootprintSpec(spec)
  ) {
    throw new Error("Hospital dressing footprint must be finite and non-negative");
  }
  return Object.freeze({
    center: freezePoint(anchor.point),
    halfWidth: spec.halfWidth,
    halfDepth: spec.halfDepth,
    rotationRadians: anchor.rotation,
  });
}

export function offsetHospitalDressingAnchor(
  anchor: HospitalDressingAnchor,
  tangentOffsetCells: number,
  depthOffsetCells: number,
): HospitalDressingAnchor {
  if (
    !finitePoint(anchor.cell)
    || !finitePoint(anchor.point)
    || !Number.isFinite(anchor.rotation)
    || !Number.isFinite(tangentOffsetCells)
    || !Number.isFinite(depthOffsetCells)
  ) {
    throw new Error("Hospital dressing anchor and offsets must be finite");
  }
  const facing = {
    x: Math.sin(anchor.rotation),
    y: Math.cos(anchor.rotation),
  };
  const tangent = {
    x: Math.cos(anchor.rotation),
    y: -Math.sin(anchor.rotation),
  };
  const point = freezePoint({
    x: anchor.point.x
      + tangent.x * tangentOffsetCells
      + facing.x * depthOffsetCells,
    y: anchor.point.y
      + tangent.y * tangentOffsetCells
      + facing.y * depthOffsetCells,
  });
  return Object.freeze({
    cell: point,
    point,
    rotation: anchor.rotation,
  });
}

function footprintAxes(rotation: number) {
  return [
    { x: Math.cos(rotation), y: Math.sin(rotation) },
    { x: -Math.sin(rotation), y: Math.cos(rotation) },
  ] as const;
}

function dot(left: Point, right: Point): number {
  return left.x * right.x + left.y * right.y;
}

/**
 * Separating-axis test for two oriented footprint rectangles. Clearance is
 * divided equally between the rectangles, so a `false` result guarantees the
 * requested free gap rather than merely preventing center-point collisions.
 */
export function hospitalDressingFootprintsOverlap(
  left: HospitalDressingFootprint,
  right: HospitalDressingFootprint,
  minimumClearanceCells = HOSPITAL_DRESSING_MINIMUM_CLEARANCE_CELLS,
): boolean {
  if (
    !finitePoint(left.center)
    || !finitePoint(right.center)
    || !Number.isFinite(left.rotationRadians)
    || !Number.isFinite(right.rotationRadians)
    || !validFootprintSpec(left)
    || !validFootprintSpec(right)
  ) {
    throw new Error("Hospital dressing overlap test received an invalid footprint");
  }
  const clearance = Number.isFinite(minimumClearanceCells)
    ? Math.max(0, minimumClearanceCells)
    : HOSPITAL_DRESSING_MINIMUM_CLEARANCE_CELLS;
  const leftAxes = footprintAxes(left.rotationRadians);
  const rightAxes = footprintAxes(right.rotationRadians);
  const delta = {
    x: right.center.x - left.center.x,
    y: right.center.y - left.center.y,
  };
  for (const axis of [...leftAxes, ...rightAxes]) {
    const centerDistance = Math.abs(dot(delta, axis));
    const leftRadius = (left.halfWidth + clearance / 2)
        * Math.abs(dot(leftAxes[0], axis))
      + (left.halfDepth + clearance / 2)
        * Math.abs(dot(leftAxes[1], axis));
    const rightRadius = (right.halfWidth + clearance / 2)
        * Math.abs(dot(rightAxes[0], axis))
      + (right.halfDepth + clearance / 2)
        * Math.abs(dot(rightAxes[1], axis));
    if (centerDistance + EPSILON >= leftRadius + rightRadius) return false;
  }
  return true;
}

function candidatePlacements(
  bays: readonly HospitalDressingAnchor[],
  request: HospitalDressingRequest,
  supportsFootprint: NonNullable<HospitalDressingLayoutOptions["supportsFootprint"]>,
): readonly PlacementCandidate[] {
  const candidates: PlacementCandidate[] = [];
  const signatures = new Set<string>();
  for (const [bayIndex, bay] of bays.entries()) {
    for (const [depthIndex, depthOffsetCells] of BAY_SLOT_OFFSETS_CELLS.entries()) {
      for (const [tangentIndex, tangentOffsetCells] of BAY_SLOT_OFFSETS_CELLS.entries()) {
        const anchor = offsetHospitalDressingAnchor(
          bay,
          tangentOffsetCells,
          depthOffsetCells,
        );
        const signature = placementSignature(anchor.point, anchor.rotation);
        if (signatures.has(signature)) continue;
        const footprint = hospitalDressingFootprintAt(
          anchor,
          request.footprint,
        );
        if (!supportsFootprint(footprint, request)) continue;
        signatures.add(signature);
        candidates.push(Object.freeze({
          id: request.id,
          category: request.category,
          anchor,
          footprint,
          bayIndex,
          tangentOffsetCells,
          depthOffsetCells,
          // Prefer a free origin in another bay to crowding one room. Only
          // then expand across the local slot lattice.
          score: Math.hypot(tangentOffsetCells, depthOffsetCells) * 10
            + bayIndex * 0.1
            + depthIndex * 0.001
            + tangentIndex * 0.0001,
          signature,
        }));
      }
    }
  }
  candidates.sort((left, right) => (
    left.score - right.score
    || left.signature.localeCompare(right.signature)
    || left.id.localeCompare(right.id)
  ));
  return Object.freeze(candidates);
}

/**
 * Packs hospital props into footprint-checked slots inside authored room bays.
 *
 * The bounded backtracking search prevents an early large prop from starving
 * a later constrained prop. If authoring becomes impossible, the deterministic
 * maximal fallback reports every omitted id so runtime and tests fail loudly
 * instead of silently dropping hospital art.
 */
export function planHospitalDressingLayout(
  bays: readonly HospitalDressingAnchor[],
  requests: readonly HospitalDressingRequest[],
  reservations: readonly HospitalDressingReservation[],
  options: HospitalDressingLayoutOptions = {},
): HospitalDressingLayout {
  const ids = new Set<string>();
  for (const item of [...requests, ...reservations]) {
    if (!item.id || ids.has(item.id)) {
      throw new Error(`Hospital dressing ids must be unique: ${item.id || "<empty>"}`);
    }
    ids.add(item.id);
  }
  for (const bay of bays) {
    if (
      !finitePoint(bay.cell)
      || !finitePoint(bay.point)
      || !Number.isFinite(bay.rotation)
    ) throw new Error("Hospital dressing bay must be finite");
  }
  for (const request of requests) {
    if (!validFootprintSpec(request.footprint)) {
      throw new Error(`Hospital dressing request ${request.id} has an invalid footprint`);
    }
  }
  const minimumClearanceCells = Number.isFinite(options.minimumClearanceCells)
    ? Math.max(0, options.minimumClearanceCells ?? 0)
    : HOSPITAL_DRESSING_MINIMUM_CLEARANCE_CELLS;
  const supportsFootprint = options.supportsFootprint ?? (() => true);
  const candidatesById = new Map(
    requests.map((request) => [
      request.id,
      candidatePlacements(bays, request, supportsFootprint),
    ]),
  );
  const requestOrder = [...requests].sort((left, right) => {
    const leftCandidates = candidatesById.get(left.id)?.length ?? 0;
    const rightCandidates = candidatesById.get(right.id)?.length ?? 0;
    return leftCandidates - rightCandidates
      || right.footprint.halfWidth * right.footprint.halfDepth
        - left.footprint.halfWidth * left.footprint.halfDepth
      || requests.indexOf(left) - requests.indexOf(right);
  });
  const occupied = reservations.map(({ footprint }) => footprint);
  const assignments = new Map<string, HospitalDressingPlacement>();
  let visitedNodes = 0;

  const search = (requestIndex: number): boolean => {
    if (requestIndex >= requestOrder.length) return true;
    if (visitedNodes >= SEARCH_NODE_BUDGET) return false;
    const request = requestOrder[requestIndex];
    for (const candidate of candidatesById.get(request.id) ?? []) {
      visitedNodes += 1;
      if (occupied.some((footprint) => hospitalDressingFootprintsOverlap(
        candidate.footprint,
        footprint,
        minimumClearanceCells,
      ))) continue;
      occupied.push(candidate.footprint);
      assignments.set(request.id, candidate);
      if (search(requestIndex + 1)) return true;
      assignments.delete(request.id);
      occupied.pop();
      if (visitedNodes >= SEARCH_NODE_BUDGET) break;
    }
    return false;
  };

  const complete = search(0);
  if (!complete) {
    assignments.clear();
    occupied.splice(0, occupied.length, ...reservations.map(({ footprint }) => footprint));
    for (const request of requestOrder) {
      const candidate = (candidatesById.get(request.id) ?? []).find((entry) => (
        occupied.every((footprint) => !hospitalDressingFootprintsOverlap(
          entry.footprint,
          footprint,
          minimumClearanceCells,
        ))
      ));
      if (!candidate) continue;
      assignments.set(request.id, candidate);
      occupied.push(candidate.footprint);
    }
  }

  const placements = requests
    .map((request) => assignments.get(request.id))
    .filter((placement): placement is HospitalDressingPlacement => Boolean(placement));
  return Object.freeze({
    placements: Object.freeze(placements),
    reservations: Object.freeze([...reservations]),
    unplacedIds: Object.freeze(
      requests
        .filter((request) => !assignments.has(request.id))
        .map((request) => request.id),
    ),
  });
}
