import * as THREE from "three";

import { CELL, P0_TUNING, SIZE } from "../config/index.js";
import type { Point } from "../core/types.js";
function carve(grid: boolean[][], points: Point[]) {
  for (let i = 1; i < points.length; i += 1) {
    let { x, y } = points[i - 1];
    const target = points[i];
    while (x !== target.x || y !== target.y) {
      grid[y][x] = true;
      if (x !== target.x) x += Math.sign(target.x - x);
      else y += Math.sign(target.y - y);
    }
    grid[y][x] = true;
  }
}
function makeMaze() {
  const grid = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  carve(grid, [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 7 }, { x: 11, y: 7 }, { x: 11, y: 13 }, { x: 17, y: 13 }, { x: 17, y: 19 }, { x: 23, y: 19 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 1, y: 1 }, { x: 1, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 16 }, { x: 13, y: 16 }, { x: 13, y: 23 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 7, y: 7 }, { x: 7, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 10 }, { x: 21, y: 10 }, { x: 21, y: 23 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 3, y: 10 }, { x: 3, y: 14 }]);
  carve(grid, [{ x: 9, y: 13 }, { x: 9, y: 20 }]);
  carve(grid, [{ x: 15, y: 3 }, { x: 20, y: 3 }]);
  carve(grid, [{ x: 17, y: 16 }, { x: 22, y: 16 }]);
  carve(grid, [{ x: 11, y: 7 }, { x: 14, y: 7 }]);
  return grid;
}

export const MAZE = makeMaze();
export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const pointKey = (point: Point) => `${point.x},${point.y}`;
export const canWalk = (x: number, y: number) => MAZE[Math.round(y)]?.[Math.round(x)] ?? false;
export const world = (point: Point, out = new THREE.Vector3()) => out.set(
  (point.x - (SIZE - 1) / 2) * CELL,
  0,
  (point.y - (SIZE - 1) / 2) * CELL,
);

export function hasLineOfSight(a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(span / P0_TUNING.lineOfSightSampleStep));
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    if (!canWalk(a.x + dx * progress, a.y + dy * progress)) return false;
  }
  return true;
}

export function canPlayerOccupy(x: number, y: number, margin: number = P0_TUNING.playerCollisionMargin) {
  return canWalk(x - margin, y - margin)
    && canWalk(x + margin, y - margin)
    && canWalk(x - margin, y + margin)
    && canWalk(x + margin, y + margin);
}

export function gridQuarterTurn(x: number, y: number, salt = 0) {
  let hash = (Math.imul(x + 101, 374761393) ^ Math.imul(y + 211, 668265263) ^ Math.imul(salt + 17, 2246822519)) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) & 3;
}

function neighbors(point: Point) {
  return [
    { x: point.x + 1, y: point.y },
    { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x, y: point.y - 1 },
  ].filter((candidate) => canWalk(candidate.x, candidate.y));
}

export function findGridPath(from: Point, to: Point) {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const goal = { x: Math.round(to.x), y: Math.round(to.y) };
  const queue = [start];
  const cameFrom = new Map<string, Point | null>([[pointKey(start), null]]);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    if (pointKey(current) === pointKey(goal)) break;
    for (const next of neighbors(current)) {
      if (!cameFrom.has(pointKey(next))) {
        cameFrom.set(pointKey(next), current);
        queue.push(next);
      }
    }
  }
  if (!cameFrom.has(pointKey(goal))) return [];
  const route: Point[] = [];
  let current: Point | null = goal;
  while (current) {
    route.push(current);
    current = cameFrom.get(pointKey(current)) ?? null;
  }
  return route.reverse();
}

export const roundedCell = (point: Point) => ({ x: Math.round(point.x), y: Math.round(point.y) });

export function gridPathDistanceMeters(from: Point, to: Point) {
  const route = findGridPath(from, to);
  return route.length ? (route.length - 1) * CELL : null;
}
