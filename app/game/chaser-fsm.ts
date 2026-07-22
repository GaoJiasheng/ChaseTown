import type {
  ChaserMode,
  ChaserState,
  GameConfig,
  LevelDefinition,
  PerceptionEvidence,
  Point,
} from "./contracts.ts";
import { distanceBetween, isWalkable, normalizeVector, pointKey } from "./navigation.ts";

export interface ChaserBrainInput {
  /** Deliberately contains evidence, not PlayerState or playerPosition. */
  evidence: PerceptionEvidence;
  reachedTarget: boolean;
  nowSeconds: number;
  deltaSeconds: number;
}

export interface ChaserBrainResult {
  state: ChaserState;
  completedHideCheckId: string | null;
}

export function createInitialChaser(
  level: LevelDefinition,
  config: GameConfig,
  position: Point = level.chaserStart,
  heading: Point = level.chaserStartHeading,
): ChaserState {
  return {
    position: { ...position },
    heading: normalizeVector(heading),
    mode: config.spawnDelaySeconds > 0 ? "spawn-delay" : "patrol",
    modeElapsedSeconds: 0,
    patrolIndex: 0,
    searchSeed: 1,
    searchIndex: 0,
    searchWaypointElapsedSeconds: 0,
    memory: {
      lastKnownPosition: null,
      lastSeenAtSeconds: null,
      witnessedHideSpotId: null,
    },
  };
}

function enterMode(state: ChaserState, mode: ChaserMode): ChaserState {
  return { ...state, mode, modeElapsedSeconds: 0 };
}

function evidenceSearchSeed(state: ChaserState): number {
  const point = state.memory.lastKnownPosition ?? state.position;
  const observedTick = Math.round((state.memory.lastSeenAtSeconds ?? 0) * 10);
  let seed = (Math.round(point.x * 100) * 73856093)
    ^ (Math.round(point.y * 100) * 19349663)
    ^ (observedTick * 83492791);
  seed >>>= 0;
  return seed || 1;
}

function enterSearch(state: ChaserState): ChaserState {
  return {
    ...enterMode(state, "search"),
    searchSeed: evidenceSearchSeed(state),
    searchIndex: 0,
    searchWaypointElapsedSeconds: 0,
  };
}

function rememberVisibleTarget(state: ChaserState, evidence: Exclude<PerceptionEvidence, { kind: "none" } | { kind: "sound" }>): ChaserState {
  return {
    ...state,
    memory: {
      lastKnownPosition: { ...evidence.position },
      lastSeenAtSeconds: evidence.observedAtSeconds,
      witnessedHideSpotId: evidence.kind === "hide-entry-visible" ? evidence.hideSpotId : null,
    },
  };
}

/**
 * Pure chaser decision layer. Its public signature makes omniscient targeting
 * impossible: no player state, player position, or runtime locker occupancy is
 * available here.
 */
export function stepChaserBrain(
  state: ChaserState,
  level: LevelDefinition,
  config: GameConfig,
  input: ChaserBrainInput,
): ChaserBrainResult {
  const elapsed = state.modeElapsedSeconds + input.deltaSeconds;
  let next: ChaserState = { ...state, modeElapsedSeconds: elapsed, memory: { ...state.memory } };

  if (state.mode === "spawn-delay") {
    if (elapsed + 1e-9 >= config.spawnDelaySeconds) next = enterMode(next, "patrol");
    return { state: next, completedHideCheckId: null };
  }

  if (input.evidence.kind === "hide-entry-visible") {
    next = rememberVisibleTarget(next, input.evidence);
    next = enterMode(next, "check-hide");
    return { state: next, completedHideCheckId: null };
  }

  if (input.evidence.kind === "player-visible") {
    next = rememberVisibleTarget(next, input.evidence);
    if (state.mode === "patrol") {
      next = enterMode(next, "suspicious");
    } else if (state.mode === "suspicious") {
      if (elapsed + 1e-9 >= config.suspiciousSeconds) next = enterMode(next, "chase");
    } else {
      next = enterMode(next, "chase");
    }
    return { state: next, completedHideCheckId: null };
  }

  switch (state.mode) {
    case "patrol":
      if (input.reachedTarget && level.patrol.length) {
        next = { ...next, patrolIndex: (state.patrolIndex + 1) % level.patrol.length };
      }
      break;
    case "suspicious":
      // Even a one-tick glimpse is evidence. Losing it during confirmation
      // enters the same last-known/search chain instead of instant amnesia.
      next = next.memory.lastKnownPosition ? enterMode(next, "lost-sight") : enterMode(next, "patrol");
      break;
    case "chase":
      next = enterMode(next, "lost-sight");
      break;
    case "lost-sight":
      if (elapsed + 1e-9 >= config.lostSightGraceSeconds) next = enterMode(next, "go-to-last-known");
      break;
    case "go-to-last-known":
      if (!next.memory.lastKnownPosition || input.reachedTarget) next = enterSearch(next);
      break;
    case "search":
      if (elapsed + 1e-9 >= config.searchSeconds) {
        next = enterMode({
          ...next,
          searchIndex: 0,
          searchWaypointElapsedSeconds: 0,
          memory: { lastKnownPosition: null, lastSeenAtSeconds: null, witnessedHideSpotId: null },
        }, "patrol");
      } else if (input.reachedTarget) {
        const waypointElapsed = state.searchWaypointElapsedSeconds + input.deltaSeconds;
        if (waypointElapsed + 1e-9 >= config.searchWaypointSeconds) {
          next = { ...next, searchIndex: state.searchIndex + 1, searchWaypointElapsedSeconds: 0 };
        } else next = { ...next, searchWaypointElapsedSeconds: waypointElapsed };
      } else {
        next = { ...next, searchWaypointElapsedSeconds: 0 };
      }
      break;
    case "check-hide": {
      if (!input.reachedTarget) {
        // Inspection time starts at the locker, not while travelling to it.
        next = { ...next, modeElapsedSeconds: 0 };
        break;
      }
      if (elapsed + 1e-9 >= config.checkHideSeconds) {
        const completedHideCheckId = next.memory.witnessedHideSpotId;
        next = enterSearch({
          ...next,
          memory: { ...next.memory, witnessedHideSpotId: null },
        });
        return { state: next, completedHideCheckId };
      }
      break;
    }
  }
  return { state: next, completedHideCheckId: null };
}

function searchWaypoints(level: LevelDefinition, anchor: Point, seed: number): Point[] {
  const origin = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
  const offsets = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
    { x: 2, y: 0 },
    { x: 0, y: 2 },
    { x: -2, y: 0 },
    { x: 0, y: -2 },
  ];
  const candidates = offsets
    .map((offset) => ({ x: origin.x + offset.x, y: origin.y + offset.y }))
    .filter((point) => isWalkable(level, point));
  for (const spot of level.hideSpots) {
    if (distanceBetween(spot.approach, origin) <= 3) candidates.push({ ...spot.approach });
  }
  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = pointKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Fisher-Yates with a tiny deterministic PRNG keeps fixed-step/replay tests
  // reproducible while varying the search order with observed encounter data.
  let randomState = seed >>> 0 || 1;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x1_0000_0000;
  };
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [unique[index], unique[swap]] = [unique[swap], unique[index]];
  }
  return unique;
}

/** Derives navigation intent exclusively from chaser-owned memory and level data. */
export function getChaserTarget(state: ChaserState, level: LevelDefinition): Point | null {
  switch (state.mode) {
    case "patrol":
      return level.patrol.length ? { ...level.patrol[state.patrolIndex % level.patrol.length] } : null;
    case "chase":
    case "lost-sight":
    case "go-to-last-known":
      return state.memory.lastKnownPosition ? { ...state.memory.lastKnownPosition } : null;
    case "search": {
      if (!state.memory.lastKnownPosition) return null;
      const candidates = searchWaypoints(level, state.memory.lastKnownPosition, state.searchSeed);
      if (!candidates.length) return { ...state.memory.lastKnownPosition };
      const index = state.searchIndex % candidates.length;
      return { ...candidates[index] };
    }
    case "check-hide": {
      const id = state.memory.witnessedHideSpotId;
      const spot = id ? level.hideSpots.find((candidate) => candidate.id === id) : null;
      return spot ? { ...spot.approach } : state.memory.lastKnownPosition ? { ...state.memory.lastKnownPosition } : null;
    }
    case "spawn-delay":
    case "suspicious":
      return null;
  }
}

export function hasReachedChaserTarget(state: ChaserState, level: LevelDefinition): boolean {
  const target = getChaserTarget(state, level);
  return Boolean(target && distanceBetween(state.position, target) <= 0.12);
}
