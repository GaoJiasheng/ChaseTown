import * as THREE from "three";

import { P0_TUNING, P1_TUNING, P2_TUNING } from "../config/index.js";
import type { AiMemory, AiState, Point } from "../core/types.js";
import { shortestAngle } from "../camera/index.js";
import { canPlayerOccupy, distance, findGridPath, hasLineOfSight, roundedCell } from "../level/maze.js";
export function pathCacheSignature(state: AiState, from: Point, target: Point) {
  const start = roundedCell(from);
  const goal = roundedCell(target);
  return `${state}:${start.x},${start.y}>${goal.x},${goal.y}`;
}
export function pathCacheInvalidationReason(previousSignature: string, nextSignature: string) {
  if (!previousSignature) return "empty-cache";
  if (previousSignature === nextSignature) return null;
  const [previousState, previousCells] = previousSignature.split(":");
  const [nextState, nextCells] = nextSignature.split(":");
  if (previousState !== nextState) return "ai-state";
  const [previousFrom, previousTarget] = previousCells.split(">");
  const [nextFrom, nextTarget] = nextCells.split(">");
  if (previousFrom !== nextFrom) return "villain-cell";
  if (previousTarget !== nextTarget) return "target-cell";
  return "signature";
}

export function stepVillainToward(
  entity: Point,
  target: Point,
  heading: number,
  speed: number,
  delta: number,
  cachedRoute?: readonly Point[],
) {
  const route = cachedRoute ?? findGridPath(entity, target);
  const next = route[1] ?? target;
  if (!route.length) {
    return { point: entity, heading, turnError: 0, speedMultiplier: 1 };
  }
  const dx = next.x - entity.x;
  const dy = next.y - entity.y;
  const length = Math.hypot(dx, dy) || 1;
  const desiredHeading = Math.atan2(dx, dy);
  const turnError = shortestAngle(heading, desiredHeading);
  const turn = THREE.MathUtils.clamp(
    turnError,
    -P0_TUNING.villainTurnSpeed * delta,
    P0_TUNING.villainTurnSpeed * delta,
  );
  const nextHeading = heading + turn;
  const sharpTurnMultiplier = Math.abs(turnError) > Math.PI / 2
    ? P0_TUNING.sharpTurnSpeedMultiplier
    : 1;
  const pathAlignmentMultiplier = cachedRoute === undefined
    ? 1
    : THREE.MathUtils.clamp(Math.cos(Math.abs(turnError)), P2_TUNING.pathTurnMinimumMultiplier, 1);
  const speedMultiplier = sharpTurnMultiplier * pathAlignmentMultiplier;
  const step = Math.min(speed * speedMultiplier * delta, length);
  const candidateX = entity.x + Math.sin(nextHeading) * step;
  const candidateY = entity.y + Math.cos(nextHeading) * step;
  const point = { ...entity };
  if (canPlayerOccupy(candidateX, point.y, P1_TUNING.villainCollisionMargin)) point.x = candidateX;
  if (canPlayerOccupy(point.x, candidateY, P1_TUNING.villainCollisionMargin)) point.y = candidateY;
  return { point, heading: nextHeading, turnError, speedMultiplier };
}

export function planVillainAi(
  memory: AiMemory,
  villainPoint: Point,
  playerPoint: Point,
  now: number,
  startTime: number,
) {
  if (now - startTime < P0_TUNING.startDelayMs) {
    return {
      memory: { state: "delay" as const, lastKnown: null, searchArrivedAt: null },
      target: null,
      seesPlayer: false,
    };
  }

  const seesPlayer = distance(villainPoint, playerPoint) < P0_TUNING.perceptionRadius
    && hasLineOfSight(villainPoint, playerPoint);
  if (seesPlayer) {
    return {
      memory: { state: "chase" as const, lastKnown: { ...playerPoint }, searchArrivedAt: null },
      target: { ...playerPoint },
      seesPlayer: true,
    };
  }

  if (memory.state === "chase" && memory.lastKnown) {
    return {
      memory: { state: "search" as const, lastKnown: { ...memory.lastKnown }, searchArrivedAt: null },
      target: { ...memory.lastKnown },
      seesPlayer: false,
    };
  }

  if (memory.state === "search" && memory.lastKnown) {
    if (distance(villainPoint, memory.lastKnown) >= 0.2) {
      return {
        memory: { ...memory, searchArrivedAt: null },
        target: { ...memory.lastKnown },
        seesPlayer: false,
      };
    }
    const arrivedAt = memory.searchArrivedAt ?? now;
    if (now - arrivedAt < P0_TUNING.searchHoldMs) {
      return {
        memory: { ...memory, searchArrivedAt: arrivedAt },
        target: null,
        seesPlayer: false,
      };
    }
  }

  return {
    memory: { state: "patrol" as const, lastKnown: null, searchArrivedAt: null },
    target: null,
    seesPlayer: false,
  };
}
