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

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export function lastKnownScanHeading(origin: Point, elapsedSeconds: number, durationSeconds: number): Point {
  const progress = clamp01(elapsedSeconds / Math.max(durationSeconds, 1e-6));
  const maximumYaw = 55 * Math.PI / 180;
  let yawOffset: number;
  if (progress < 0.2) {
    yawOffset = -maximumYaw * smoothstep(progress / 0.2);
  } else if (progress < 0.32) {
    yawOffset = -maximumYaw;
  } else if (progress < 0.68) {
    yawOffset = -maximumYaw + maximumYaw * 2 * smoothstep((progress - 0.32) / 0.36);
  } else if (progress < 0.8) {
    yawOffset = maximumYaw;
  } else {
    yawOffset = maximumYaw * (1 - smoothstep((progress - 0.8) / 0.2));
  }
  const normalizedOrigin = normalizeVector(origin);
  const yaw = Math.atan2(normalizedOrigin.x, normalizedOrigin.y) + yawOffset;
  return { x: Math.sin(yaw), y: Math.cos(yaw) };
}

export function createInitialChaser(
  level: LevelDefinition,
  config: GameConfig,
  position: Point = level.chaserStart,
  heading: Point = level.chaserStartHeading,
): ChaserState {
  const normalizedHeading = normalizeVector(heading);
  return {
    position: { ...position },
    heading: normalizedHeading,
    mode: config.spawnDelaySeconds > 0 ? "spawn-delay" : "patrol",
    modeElapsedSeconds: 0,
    visualConfirmationSeconds: null,
    patrolIndex: 0,
    scanOriginHeading: { ...normalizedHeading },
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
  return { ...state, mode, modeElapsedSeconds: 0, visualConfirmationSeconds: null };
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

function enterSearch(state: ChaserState, initialWaypointElapsedSeconds = 0): ChaserState {
  return {
    ...enterMode(state, "search"),
    searchSeed: evidenceSearchSeed(state),
    searchIndex: 0,
    searchWaypointElapsedSeconds: initialWaypointElapsedSeconds,
  };
}

function enterLastKnownScan(state: ChaserState): ChaserState {
  const origin = normalizeVector(state.heading);
  const sighting = state.memory.lastKnownPosition;
  return {
    ...enterMode(state, "scan-last-known"),
    // Reach checks use a tiny numerical tolerance. Snap that final fraction
    // so the planted scan happens at the observed continuous world point and
    // the following search dwell cannot introduce a last-frame foot slide.
    position: sighting ? { ...sighting } : { ...state.position },
    heading: { ...origin },
    scanOriginHeading: { ...origin },
  };
}

function rememberVisibleTarget(state: ChaserState, evidence: Exclude<PerceptionEvidence, { kind: "none" } | { kind: "sound" }>): ChaserState {
  return {
    ...state,
    memory: {
      lastKnownPosition: { ...evidence.position },
      lastSeenAtSeconds: evidence.observedAtSeconds,
      witnessedHideSpotId: evidence.kind === "hide-entry-visible"
        ? evidence.hideSpotId
        : state.mode === "check-hide"
          ? state.memory.witnessedHideSpotId
          : null,
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
    if (state.mode === "suspicious") {
      if (elapsed + 1e-9 >= config.suspiciousSeconds) next = enterMode(next, "chase");
    } else if (state.mode === "patrol") {
      next = enterMode(next, "suspicious");
    } else if (state.mode === "chase") {
      next = { ...next, visualConfirmationSeconds: null };
    } else {
      // Reacquisition confirmation belongs alongside the existing pursuit
      // mode instead of replacing it. Search/last-known/check timers and
      // movement continue, preventing short peeks from stun-locking the AI,
      // while presentation still gets a full lead-in before chase resumes.
      const confirmationSeconds = state.visualConfirmationSeconds === null
        ? 0
        : state.visualConfirmationSeconds + input.deltaSeconds;
      next = { ...next, visualConfirmationSeconds: confirmationSeconds };
      if (confirmationSeconds + 1e-9 >= config.suspiciousSeconds) {
        next = enterMode({
          ...next,
          memory: { ...next.memory, witnessedHideSpotId: null },
        }, "chase");
      }
    }
    return { state: next, completedHideCheckId: null };
  }

  if (state.visualConfirmationSeconds !== null) {
    // A brief reacquisition is still newer evidence than the search that was
    // already in progress. If confirmation breaks, pursue that latest point
    // instead of letting an old search timeout erase it or inserting another
    // stationary lost-sight beat.
    if (state.mode === "check-hide") {
      // A brief peek cannot cancel a locker inspection backed by the stronger
      // witnessed-entry evidence. Clear only the provisional confirmation and
      // continue the existing walk/door timer below.
      next = { ...next, visualConfirmationSeconds: null };
    } else {
      next = state.mode === "go-to-last-known"
        ? { ...next, visualConfirmationSeconds: null }
        : enterMode(next, "go-to-last-known");
      return { state: next, completedHideCheckId: null };
    }
  } else {
    next = { ...next, visualConfirmationSeconds: null };
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
      if (next.memory.lastKnownPosition && input.reachedTarget) next = enterLastKnownScan(next);
      else if (elapsed + 1e-9 >= config.lostSightGraceSeconds) next = enterMode(next, "go-to-last-known");
      break;
    case "go-to-last-known":
      if (!next.memory.lastKnownPosition) next = enterSearch(next);
      else if (input.reachedTarget) next = enterLastKnownScan(next);
      break;
    case "scan-last-known":
      next = {
        ...next,
        heading: lastKnownScanHeading(state.scanOriginHeading, elapsed, config.lastKnownScanSeconds),
      };
      if (elapsed + 1e-9 >= config.lastKnownScanSeconds) {
        // Search index zero is the exact continuous sighting point. Keep one
        // AI beat planted there so the centred final scan pose is rendered
        // before the first wider-search step can change position or heading.
        next = enterSearch(next, Math.max(0, config.searchWaypointSeconds - config.aiTickSeconds));
      }
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
  const seen = new Set<string>([pointKey(anchor)]);
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
  // The exact, potentially sub-cell evidence point is never shuffled away.
  // It supplies the planted post-scan beat; only the surrounding search order
  // varies with observed encounter evidence.
  return [{ ...anchor }, ...unique];
}

/** Derives navigation intent exclusively from chaser-owned memory and level data. */
export function getChaserTarget(state: ChaserState, level: LevelDefinition): Point | null {
  switch (state.mode) {
    case "patrol":
      return level.patrol.length ? { ...level.patrol[state.patrolIndex % level.patrol.length] } : null;
    case "chase":
    case "lost-sight":
    case "go-to-last-known":
    case "scan-last-known":
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
  // The final visual evidence is a continuous world point, not merely a grid
  // cell. Reach it almost exactly before planting the feet for the authored
  // scan; wider tolerances remain appropriate for patrol and locker checks.
  const tolerance = ["lost-sight", "go-to-last-known"].includes(state.mode) ? 0.02 : 0.12;
  return Boolean(target && distanceBetween(state.position, target) <= tolerance);
}
