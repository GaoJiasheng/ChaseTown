import type { LevelDefinition, Point } from "./contracts.ts";

type RoomFloorLevel = Pick<LevelDefinition, "height" | "walkable" | "width">;

export type RoomFloorBoundarySide = "north" | "east" | "south" | "west";

export interface RoomFloorBounds {
  /** Tile-edge coordinates, rather than cell-center coordinates. */
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface RoomFloorBoundaryEdge {
  /** Interior floor cell owning this edge. */
  readonly cell: Point;
  /** Grid cell on the corridor side of the room boundary. */
  readonly adjacent: Point;
  readonly side: RoomFloorBoundarySide;
  /** Unit normal pointing out of the furnished room and toward the corridor. */
  readonly outward: Point;
  /** Tile-edge coordinates suitable for a one-cell skirting/threshold module. */
  readonly start: Point;
  readonly end: Point;
}

export interface EnclosedRoomFloorRegion {
  /** Stable topology-derived key; independent of prop placement order. */
  readonly id: string;
  readonly cells: readonly Point[];
  readonly boundaryEdges: readonly RoomFloorBoundaryEdge[];
  readonly bounds: RoomFloorBounds;
}

export interface AuthoredRoomFloorRegion extends EnclosedRoomFloorRegion {
  /** Index of the first authored prop anchor that selected this room. */
  readonly anchorIndex: number;
}

export interface RoomFloorBoundaryTrimPlacement {
  readonly position: Point;
  readonly rotationRadians: number;
  readonly lengthCells: 1;
}

export interface RoomFloorFootprint {
  /** Center in grid-cell coordinates; integer coordinates are tile centers. */
  readonly center: Point;
  readonly halfWidth?: number;
  readonly halfDepth?: number;
  readonly rotationRadians?: number;
  /**
   * Samples per local axis. Three checks the center, edge midpoints and
   * corners; larger values can validate unusually concave prop footprints.
   */
  readonly samplesPerAxis?: number;
  /** Pull corner samples inward to avoid treating a shared tile edge as area. */
  readonly sampleInset?: number;
}

export interface RoomFloorSupportResult {
  readonly supported: boolean;
  readonly roomId: string | null;
  readonly anchorIndex: number | null;
  readonly samples: readonly Point[];
  readonly unsupportedSamples: readonly Point[];
  readonly outOfBoundsSamples: readonly Point[];
}

const BOUNDARY_DIRECTIONS = [
  {
    side: "north",
    outward: { x: 0, y: -1 },
    start: (cell: Point) => ({ x: cell.x - 0.5, y: cell.y - 0.5 }),
    end: (cell: Point) => ({ x: cell.x + 0.5, y: cell.y - 0.5 }),
  },
  {
    side: "east",
    outward: { x: 1, y: 0 },
    start: (cell: Point) => ({ x: cell.x + 0.5, y: cell.y - 0.5 }),
    end: (cell: Point) => ({ x: cell.x + 0.5, y: cell.y + 0.5 }),
  },
  {
    side: "south",
    outward: { x: 0, y: 1 },
    start: (cell: Point) => ({ x: cell.x + 0.5, y: cell.y + 0.5 }),
    end: (cell: Point) => ({ x: cell.x - 0.5, y: cell.y + 0.5 }),
  },
  {
    side: "west",
    outward: { x: -1, y: 0 },
    start: (cell: Point) => ({ x: cell.x - 0.5, y: cell.y + 0.5 }),
    end: (cell: Point) => ({ x: cell.x - 0.5, y: cell.y - 0.5 }),
  },
] as const satisfies readonly {
  side: RoomFloorBoundarySide;
  outward: Point;
  start: (cell: Point) => Point;
  end: (cell: Point) => Point;
}[];

const DIRECTIONS = BOUNDARY_DIRECTIONS.map(({ outward }) => outward);
const cellKey = (cell: Point) => `${cell.x},${cell.y}`;
const isFiniteInteger = (value: number) => Number.isFinite(value) && Number.isInteger(value);
const isGridCell = (level: RoomFloorLevel, cell: Point) => (
  isFiniteInteger(cell.x)
  && isFiniteInteger(cell.y)
  && cell.x >= 0
  && cell.y >= 0
  && cell.x < level.width
  && cell.y < level.height
);
const isWalkable = (level: RoomFloorLevel, cell: Point) => (
  isGridCell(level, cell) && level.walkable[cell.y]?.[cell.x] === true
);

function exteriorVoidCellKeys(level: RoomFloorLevel) {
  const exterior = new Set<string>();
  const queue: Point[] = [];
  const enqueue = (cell: Point) => {
    if (!isGridCell(level, cell) || isWalkable(level, cell)) return;
    const key = cellKey(cell);
    if (exterior.has(key)) return;
    exterior.add(key);
    queue.push(cell);
  };
  for (let x = 0; x < level.width; x += 1) {
    enqueue({ x, y: 0 });
    enqueue({ x, y: level.height - 1 });
  }
  for (let y = 0; y < level.height; y += 1) {
    enqueue({ x: 0, y });
    enqueue({ x: level.width - 1, y });
  }
  for (let index = 0; index < queue.length; index += 1) {
    const cell = queue[index];
    for (const direction of DIRECTIONS) {
      enqueue({ x: cell.x + direction.x, y: cell.y + direction.y });
    }
  }
  return exterior;
}

function freezePoint(point: Point): Point {
  return Object.freeze({ x: point.x, y: point.y });
}

function buildBoundaryEdges(level: RoomFloorLevel, cells: readonly Point[]) {
  const roomCells = new Set(cells.map(cellKey));
  const edges: RoomFloorBoundaryEdge[] = [];
  for (const cell of cells) {
    for (const direction of BOUNDARY_DIRECTIONS) {
      const adjacent = {
        x: cell.x + direction.outward.x,
        y: cell.y + direction.outward.y,
      };
      if (roomCells.has(cellKey(adjacent))) continue;
      // A valid enclosed component can only meet a walkable corridor at its
      // perimeter. Refuse malformed edges rather than emitting skirting into
      // exterior void or beyond the authored grid.
      if (!isWalkable(level, adjacent)) continue;
      edges.push(Object.freeze({
        cell: freezePoint(cell),
        adjacent: freezePoint(adjacent),
        side: direction.side,
        outward: freezePoint(direction.outward),
        start: freezePoint(direction.start(cell)),
        end: freezePoint(direction.end(cell)),
      }));
    }
  }
  return Object.freeze(edges);
}

/**
 * Finds every complete non-walkable room sealed by walkable corridor cells.
 *
 * This is deliberately topology-based. It never grows a radius around a prop
 * and never treats perimeter-connected non-walkable space as a room, so floor
 * modules cannot leak through an opening into the exterior horizon.
 */
export function enclosedRoomFloorRegions(
  level: RoomFloorLevel,
): readonly EnclosedRoomFloorRegion[] {
  if (
    !Number.isInteger(level.width)
    || !Number.isInteger(level.height)
    || level.width <= 2
    || level.height <= 2
  ) return Object.freeze([]);

  const exterior = exteriorVoidCellKeys(level);
  const visited = new Set<string>();
  const regions: EnclosedRoomFloorRegion[] = [];
  for (let y = 1; y < level.height - 1; y += 1) {
    for (let x = 1; x < level.width - 1; x += 1) {
      const origin = { x, y };
      const originKey = cellKey(origin);
      if (isWalkable(level, origin) || exterior.has(originKey) || visited.has(originKey)) continue;

      const queue: Point[] = [origin];
      const cells: Point[] = [];
      visited.add(originKey);
      for (let index = 0; index < queue.length; index += 1) {
        const cell = queue[index];
        cells.push(freezePoint(cell));
        for (const direction of DIRECTIONS) {
          const next = { x: cell.x + direction.x, y: cell.y + direction.y };
          const key = cellKey(next);
          if (
            !isGridCell(level, next)
            || isWalkable(level, next)
            || exterior.has(key)
            || visited.has(key)
          ) continue;
          visited.add(key);
          queue.push(next);
        }
      }
      cells.sort((left, right) => left.y - right.y || left.x - right.x);
      const minX = Math.min(...cells.map((cell) => cell.x));
      const minY = Math.min(...cells.map((cell) => cell.y));
      const maxX = Math.max(...cells.map((cell) => cell.x));
      const maxY = Math.max(...cells.map((cell) => cell.y));
      const frozenCells = Object.freeze(cells);
      regions.push(Object.freeze({
        id: `${minX},${minY}:${cells.length}`,
        cells: frozenCells,
        boundaryEdges: buildBoundaryEdges(level, frozenCells),
        bounds: Object.freeze({
          minX: minX - 0.5,
          minY: minY - 0.5,
          maxX: maxX + 0.5,
          maxY: maxY + 0.5,
        }),
      }));
    }
  }
  return Object.freeze(regions);
}

/**
 * Select complete enclosed rooms containing authored prop anchors. Multiple
 * anchors in the same room select it once, with the first anchor retaining
 * ownership for deterministic floor material selection.
 */
export function authoredRoomFloorRegions(
  level: RoomFloorLevel,
  anchors: readonly Point[],
): readonly AuthoredRoomFloorRegion[] {
  const topology = enclosedRoomFloorRegions(level);
  const roomByCell = new Map<string, EnclosedRoomFloorRegion>();
  for (const room of topology) {
    for (const cell of room.cells) roomByCell.set(cellKey(cell), room);
  }
  const emitted = new Set<string>();
  const regions: AuthoredRoomFloorRegion[] = [];
  for (const [anchorIndex, anchor] of anchors.entries()) {
    if (!isGridCell(level, anchor)) continue;
    const room = roomByCell.get(cellKey(anchor));
    if (!room || emitted.has(room.id)) continue;
    emitted.add(room.id);
    regions.push(Object.freeze({ ...room, anchorIndex }));
  }
  return Object.freeze(regions);
}

/**
 * Converts a topology boundary edge into an inward-offset one-cell trim
 * placement. Runtime can map this grid position through its existing `world`
 * helper and scale the trim to CELL metres.
 */
export function roomFloorBoundaryTrimPlacement(
  edge: RoomFloorBoundaryEdge,
  inwardInsetCells = 0.035,
): RoomFloorBoundaryTrimPlacement {
  const inset = Number.isFinite(inwardInsetCells) ? Math.max(0, inwardInsetCells) : 0;
  return Object.freeze({
    position: Object.freeze({
      x: (edge.start.x + edge.end.x) / 2 - edge.outward.x * inset,
      y: (edge.start.y + edge.end.y) / 2 - edge.outward.y * inset,
    }),
    rotationRadians: edge.side === "east" || edge.side === "west" ? Math.PI / 2 : 0,
    lengthCells: 1,
  });
}

const pointToGridCell = (point: Point): Point => ({
  x: Math.floor(point.x + 0.5),
  y: Math.floor(point.y + 0.5),
});

/**
 * Validates that a rotated prop footprint is supported by one complete room
 * floor. The default 3×3 sampling catches unsupported corners and edge
 * midpoints that a center-only placement test would miss.
 */
export function roomFloorSupportForFootprint(
  level: RoomFloorLevel,
  regions: readonly EnclosedRoomFloorRegion[],
  footprint: RoomFloorFootprint,
): RoomFloorSupportResult {
  const halfWidth = footprint.halfWidth ?? 0;
  const halfDepth = footprint.halfDepth ?? 0;
  const rotation = footprint.rotationRadians ?? 0;
  const requestedSamples = footprint.samplesPerAxis ?? 3;
  const samplesPerAxis = Math.min(9, Math.max(1, Math.round(requestedSamples)));
  const requestedInset = footprint.sampleInset ?? 0.02;
  const inset = Number.isFinite(requestedInset) ? Math.max(0, requestedInset) : 0;
  const finite = [
    footprint.center.x,
    footprint.center.y,
    halfWidth,
    halfDepth,
    rotation,
    samplesPerAxis,
  ].every(Number.isFinite);
  if (!finite || halfWidth < 0 || halfDepth < 0) {
    const invalid = freezePoint(footprint.center);
    return Object.freeze({
      supported: false,
      roomId: null,
      anchorIndex: null,
      samples: Object.freeze([invalid]),
      unsupportedSamples: Object.freeze([invalid]),
      outOfBoundsSamples: Object.freeze([invalid]),
    });
  }

  const roomByCell = new Map<string, EnclosedRoomFloorRegion>();
  for (const room of regions) {
    for (const cell of room.cells) roomByCell.set(cellKey(cell), room);
  }
  const sampleHalfWidth = Math.max(0, halfWidth - Math.min(inset, halfWidth));
  const sampleHalfDepth = Math.max(0, halfDepth - Math.min(inset, halfDepth));
  const axisValues = (extent: number) => (
    samplesPerAxis === 1 || extent <= 1e-9
      ? [0]
      : Array.from(
          { length: samplesPerAxis },
          (_, index) => -extent + (index / (samplesPerAxis - 1)) * extent * 2,
        )
  );
  const localX = axisValues(sampleHalfWidth);
  const localY = axisValues(sampleHalfDepth);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const samples: Point[] = [];
  const unsupported: Point[] = [];
  const outOfBounds: Point[] = [];
  let selectedRoom: EnclosedRoomFloorRegion | null = null;
  for (const dy of localY) {
    for (const dx of localX) {
      const sample = freezePoint({
        x: footprint.center.x + dx * cosine - dy * sine,
        y: footprint.center.y + dx * sine + dy * cosine,
      });
      samples.push(sample);
      const cell = pointToGridCell(sample);
      if (!isGridCell(level, cell)) {
        outOfBounds.push(sample);
        unsupported.push(sample);
        continue;
      }
      const room = roomByCell.get(cellKey(cell));
      if (!room || (selectedRoom && room.id !== selectedRoom.id)) {
        unsupported.push(sample);
        continue;
      }
      selectedRoom ??= room;
    }
  }
  const anchorIndex = selectedRoom && "anchorIndex" in selectedRoom
    ? Number(selectedRoom.anchorIndex)
    : null;
  return Object.freeze({
    supported: unsupported.length === 0 && selectedRoom !== null,
    roomId: selectedRoom?.id ?? null,
    anchorIndex: Number.isInteger(anchorIndex) ? anchorIndex : null,
    samples: Object.freeze(samples),
    unsupportedSamples: Object.freeze(unsupported),
    outOfBoundsSamples: Object.freeze(outOfBounds),
  });
}
