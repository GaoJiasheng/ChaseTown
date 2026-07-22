import type { LevelDefinition, MoveIntent, Point } from "./contracts.ts";

const CARDINAL_DIRECTIONS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
] as const;

export const pointKey = (point: Point) => `${Math.round(point.x)},${Math.round(point.y)}`;

export const distanceBetween = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const movementBlockerCache = new WeakMap<LevelDefinition, ReadonlySet<string>>();

function movementBlockerKeys(level: LevelDefinition): ReadonlySet<string> {
  const cached = movementBlockerCache.get(level);
  if (cached) return cached;
  const blockers = new Set((level.movementBlockers ?? []).map(pointKey));
  movementBlockerCache.set(level, blockers);
  return blockers;
}

export function normalizeVector(vector: Point, fallback: Point = { x: 0, y: 1 }): Point {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-9) return { ...fallback };
  return { x: vector.x / length, y: vector.y / length };
}

export function isWalkable(level: LevelDefinition, point: Point): boolean {
  return Boolean(level.walkable[Math.round(point.y)]?.[Math.round(point.x)])
    && !movementBlockerKeys(level).has(pointKey(point));
}

export function neighbors(level: LevelDefinition, point: Point): Point[] {
  const origin = { x: Math.round(point.x), y: Math.round(point.y) };
  return CARDINAL_DIRECTIONS
    .map((direction) => ({ x: origin.x + direction.x, y: origin.y + direction.y }))
    .filter((candidate) => isWalkable(level, candidate));
}

/**
 * Returns every grid cell touched by a line between cell centers. Exact corner
 * crossings include both adjacent cells, preventing vision leaking through a
 * diagonal crack between walls.
 */
export function supercoverCells(from: Point, to: Point): Point[] {
  let x = Math.round(from.x);
  let y = Math.round(from.y);
  const targetX = Math.round(to.x);
  const targetY = Math.round(to.y);
  const dx = targetX - x;
  const dy = targetY - y;
  const nx = Math.abs(dx);
  const ny = Math.abs(dy);
  const signX = Math.sign(dx);
  const signY = Math.sign(dy);
  let ix = 0;
  let iy = 0;
  const result: Point[] = [{ x, y }];
  const seen = new Set([`${x},${y}`]);
  const push = (point: Point) => {
    const key = `${point.x},${point.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(point);
    }
  };

  while (ix < nx || iy < ny) {
    const horizontalProgress = (1 + 2 * ix) * ny;
    const verticalProgress = (1 + 2 * iy) * nx;
    if (horizontalProgress === verticalProgress) {
      if (signX) push({ x: x + signX, y });
      if (signY) push({ x, y: y + signY });
      x += signX;
      y += signY;
      ix += 1;
      iy += 1;
      push({ x, y });
    } else if (horizontalProgress < verticalProgress) {
      x += signX;
      ix += 1;
      push({ x, y });
    } else {
      y += signY;
      iy += 1;
      push({ x, y });
    }
  }
  return result;
}

export function hasLineOfSight(level: LevelDefinition, from: Point, to: Point): boolean {
  const visionOnlyBlockers = new Set((level.visionOnlyBlockers ?? []).map(pointKey));
  return supercoverCells(from, to).every((cell, index) => {
    if (index === 0) return true;
    return isWalkable(level, cell) && !visionOnlyBlockers.has(pointKey(cell));
  });
}

export function findPath(level: LevelDefinition, from: Point, to: Point): Point[] {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const goal = { x: Math.round(to.x), y: Math.round(to.y) };
  if (!isWalkable(level, start) || !isWalkable(level, goal)) return [];

  const size = level.width * level.height;
  const parent = new Int32Array(size);
  parent.fill(-2);
  const queue = new Int32Array(size);
  const indexOf = (point: Point) => point.y * level.width + point.x;
  const pointAt = (index: number): Point => ({ x: index % level.width, y: Math.floor(index / level.width) });
  const startIndex = indexOf(start);
  const goalIndex = indexOf(goal);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIndex;
  parent[startIndex] = -1;

  while (head < tail) {
    const currentIndex = queue[head++];
    if (currentIndex === goalIndex) break;
    for (const next of neighbors(level, pointAt(currentIndex))) {
      const nextIndex = indexOf(next);
      if (parent[nextIndex] !== -2) continue;
      parent[nextIndex] = currentIndex;
      queue[tail++] = nextIndex;
    }
  }
  if (parent[goalIndex] === -2) return [];

  const route: Point[] = [];
  for (let current = goalIndex; current !== -1; current = parent[current]) route.push(pointAt(current));
  return route.reverse();
}

export class GridPathPlanner {
  private readonly cache = new Map<string, readonly Point[]>();
  private readonly level: LevelDefinition;

  constructor(level: LevelDefinition) {
    this.level = level;
  }

  path(from: Point, to: Point): readonly Point[] {
    const key = `${pointKey(from)}>${pointKey(to)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const route = findPath(this.level, from, to);
    this.cache.set(key, route);
    return route;
  }

  clear() {
    this.cache.clear();
  }
}

export function moveWithCollision(
  level: LevelDefinition,
  position: Point,
  intent: MoveIntent,
  speed: number,
  deltaSeconds: number,
): { position: Point; heading: Point } {
  const direction = normalizeVector(intent, { x: 0, y: 0 });
  const next = { ...position };
  const candidateX = { x: next.x + direction.x * speed * deltaSeconds, y: next.y };
  if (isWalkable(level, candidateX)) next.x = candidateX.x;
  const candidateY = { x: next.x, y: next.y + direction.y * speed * deltaSeconds };
  if (isWalkable(level, candidateY)) next.y = candidateY.y;
  return {
    position: next,
    heading: Math.hypot(intent.x, intent.y) > 1e-9 ? direction : { x: 0, y: 0 },
  };
}

export function moveAlongGridPath(
  planner: GridPathPlanner,
  position: Point,
  target: Point,
  speed: number,
  deltaSeconds: number,
): { position: Point; heading: Point } {
  const route = planner.path(position, target);
  if (!route.length) return { position: { ...position }, heading: { x: 0, y: 0 } };
  // A path is cell-based, while last-known observations may be continuous.
  // Once inside the goal cell, finish at the observed point rather than
  // stopping forever at the rounded cell center.
  const waypoint = route.length === 1 ? target : route[1];
  const offset = { x: waypoint.x - position.x, y: waypoint.y - position.y };
  const remaining = Math.hypot(offset.x, offset.y);
  if (remaining < 1e-9) return { position: { ...position }, heading: { x: 0, y: 0 } };
  const heading = { x: offset.x / remaining, y: offset.y / remaining };
  const step = Math.min(speed * deltaSeconds, remaining);
  return {
    position: { x: position.x + heading.x * step, y: position.y + heading.y * step },
    heading,
  };
}
