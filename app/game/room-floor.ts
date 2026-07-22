import type { LevelDefinition, Point } from "./contracts.ts";

export interface AuthoredRoomFloorRegion {
  /** Index of the first authored prop anchor that selected this room. */
  readonly anchorIndex: number;
  readonly cells: readonly Point[];
}

const DIRECTIONS = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
] as const;

const cellKey = (cell: Point) => `${cell.x},${cell.y}`;

/**
 * Select complete, enclosed non-walkable rooms containing authored prop
 * anchors. Non-walkable space connected to the map perimeter is exterior void
 * and must never receive room-floor art.
 */
export function authoredRoomFloorRegions(
  level: Pick<LevelDefinition, "height" | "walkable" | "width">,
  anchors: readonly Point[],
): readonly AuthoredRoomFloorRegion[] {
  const exteriorVoidCells = new Set<string>();
  const exteriorQueue: Point[] = [];
  const enqueueExterior = (cell: Point) => {
    if (
      cell.x < 0
      || cell.y < 0
      || cell.x >= level.width
      || cell.y >= level.height
      || level.walkable[cell.y][cell.x]
    ) return;
    const key = cellKey(cell);
    if (exteriorVoidCells.has(key)) return;
    exteriorVoidCells.add(key);
    exteriorQueue.push(cell);
  };
  for (let x = 0; x < level.width; x += 1) {
    enqueueExterior({ x, y: 0 });
    enqueueExterior({ x, y: level.height - 1 });
  }
  for (let y = 0; y < level.height; y += 1) {
    enqueueExterior({ x: 0, y });
    enqueueExterior({ x: level.width - 1, y });
  }
  for (let index = 0; index < exteriorQueue.length; index += 1) {
    const cell = exteriorQueue[index];
    for (const direction of DIRECTIONS) {
      enqueueExterior({ x: cell.x + direction.x, y: cell.y + direction.y });
    }
  }

  const interiorRoomByCell = new Map<string, readonly Point[]>();
  const emittedRooms = new Set<readonly Point[]>();
  const regions: AuthoredRoomFloorRegion[] = [];
  for (const [anchorIndex, origin] of anchors.entries()) {
    const originKey = cellKey(origin);
    if (
      origin.x <= 0
      || origin.y <= 0
      || origin.x >= level.width - 1
      || origin.y >= level.height - 1
      || exteriorVoidCells.has(originKey)
      || level.walkable[origin.y]?.[origin.x] !== false
    ) continue;

    let room = interiorRoomByCell.get(originKey);
    if (!room) {
      const cells: Point[] = [];
      const queue: Point[] = [origin];
      const visited = new Set<string>([originKey]);
      for (let index = 0; index < queue.length; index += 1) {
        const cell = queue[index];
        cells.push(cell);
        for (const direction of DIRECTIONS) {
          const next = { x: cell.x + direction.x, y: cell.y + direction.y };
          const key = cellKey(next);
          if (
            next.x <= 0
            || next.y <= 0
            || next.x >= level.width - 1
            || next.y >= level.height - 1
            || level.walkable[next.y][next.x]
            || exteriorVoidCells.has(key)
            || visited.has(key)
          ) continue;
          visited.add(key);
          queue.push(next);
        }
      }
      room = Object.freeze(cells);
      for (const cell of room) interiorRoomByCell.set(cellKey(cell), room);
    }
    if (emittedRooms.has(room)) continue;
    emittedRooms.add(room);
    regions.push(Object.freeze({ anchorIndex, cells: room }));
  }
  return Object.freeze(regions);
}
