import type {
  ChaserMode,
  ChaserState,
  GameConfig,
  LevelDefinition,
  PerceptionEvidence,
  Point,
  PublicEvidenceMemory,
  PublicRegionSuspicion,
  SoundEvidenceSourceType,
  WorldClueSourceType,
} from "./contracts.ts";
import { distanceBetween, findPath, isWalkable, neighbors, normalizeVector, pointKey } from "./navigation.ts";

export interface ChaserBrainInput {
  /** Deliberately contains evidence, not PlayerState or playerPosition. */
  evidence: PerceptionEvidence;
  /**
   * A simultaneously heard public sound. The primary visual or louder sound
   * remains the navigation anchor; this can only enter the bounded
   * ledger/deferred queue.
   */
  secondarySoundEvidence?: Extract<PerceptionEvidence, { kind: "sound" }>;
  reachedTarget: boolean;
  nowSeconds: number;
  deltaSeconds: number;
}

export interface CompletedEvidenceInvestigation {
  readonly sourceId: string;
  readonly sourceType: SoundEvidenceSourceType | WorldClueSourceType;
}

export interface ChaserBrainResult {
  state: ChaserState;
  completedHideCheckId: string | null;
  completedHideCheckSource: "witnessed" | "search" | null;
  /** Backward-compatible sound-only receipt used by existing adapters. */
  completedSoundInvestigation?: CompletedEvidenceInvestigation;
  completedEvidenceInvestigation?: CompletedEvidenceInvestigation;
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
    searchPlan: Object.freeze([]),
    searchIndex: 0,
    searchWaypointElapsedSeconds: 0,
    searchHideSpotId: null,
    hideCheckSource: null,
    searchHideChecksCompleted: 0,
    inspectedHideSpotIds: Object.freeze([]),
    memory: {
      lastKnownPosition: null,
      lastKnownDirection: null,
      lastSeenAtSeconds: null,
      lastHeardAtSeconds: null,
      lastClueAtSeconds: null,
      lastKnownEvidence: null,
      deferredSoundEvidence: null,
      witnessedHideSpotId: null,
      evidenceTrail: Object.freeze([]),
      regionSuspicion: Object.freeze([]),
    },
  };
}

function enterMode(state: ChaserState, mode: ChaserMode): ChaserState {
  return {
    ...state,
    mode,
    modeElapsedSeconds: 0,
    visualConfirmationSeconds: null,
    ...(
      mode === "search" || mode === "check-hide"
        ? {}
        : { searchPlan: Object.freeze([]) }
    ),
  };
}

function evidenceSearchSeed(state: ChaserState): number {
  const point = state.memory.lastKnownPosition ?? state.position;
  const evidenceAtSeconds = state.memory.lastKnownEvidence === "sound"
    ? state.memory.lastHeardAtSeconds
    : state.memory.lastKnownEvidence === "world-clue"
      ? state.memory.lastClueAtSeconds
      : state.memory.lastSeenAtSeconds;
  const observedTick = Math.round((evidenceAtSeconds ?? 0) * 10);
  let seed = (Math.round(point.x * 100) * 73856093)
    ^ (Math.round(point.y * 100) * 19349663)
    ^ (observedTick * 83492791);
  seed >>>= 0;
  return seed || 1;
}

function stableIdHash(value: string, seed: number): number {
  let hash = seed >>> 0 || 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const MAX_PUBLIC_EVIDENCE = 3;
const MIN_ACTIONABLE_SOUND_CONFIDENCE = 0.16;
const MIN_ACTIONABLE_WORLD_CLUE_CONFIDENCE = 0.3;

function soundSourceType(
  evidence: Pick<Extract<PerceptionEvidence, { kind: "sound" }>, "sourceType">,
): SoundEvidenceSourceType {
  return evidence.sourceType ?? "unknown";
}

function soundBaseConfidence(
  evidence: Pick<Extract<PerceptionEvidence, { kind: "sound" }>, "confidence" | "strength">,
): number {
  return clamp01(evidence.confidence ?? evidence.strength);
}

function repeatedSourceCount(
  state: ChaserState,
  evidence: Extract<PerceptionEvidence, { kind: "sound" }>,
): number {
  if (!evidence.sourceId) return -1;
  return state.memory.evidenceTrail?.find((entry) => (
    entry.kind === "sound"
    && entry.sourceId === evidence.sourceId
    && entry.sourceType === soundSourceType(evidence)
  ))?.repeatCount ?? -1;
}

/**
 * A stable authored emitter becomes less persuasive when repeatedly abused.
 * Anonymous footsteps do not habituate because they cannot be linked without
 * inventing hidden identity.
 */
export function actionableSoundConfidence(
  state: ChaserState,
  evidence: Extract<PerceptionEvidence, { kind: "sound" }>,
): number {
  const priorRepeatCount = repeatedSourceCount(state, evidence);
  const nextRepeatCount = priorRepeatCount < 0 ? 0 : priorRepeatCount + 1;
  const habituation = 1 / (1 + nextRepeatCount * 0.65);
  return soundBaseConfidence(evidence) * habituation;
}

function publicEvidenceRecord(
  state: ChaserState,
  evidence: Exclude<PerceptionEvidence, { kind: "none" }>,
): PublicEvidenceMemory {
  const direction = evidence.direction
    && Math.hypot(evidence.direction.x, evidence.direction.y) > 1e-9
    ? Object.freeze(normalizeVector(evidence.direction))
    : null;
  if (evidence.kind === "sound") {
    const priorRepeatCount = repeatedSourceCount(state, evidence);
    const repeatCount = priorRepeatCount < 0 ? 0 : priorRepeatCount + 1;
    return Object.freeze({
      kind: "sound",
      position: Object.freeze({ ...evidence.position }),
      direction,
      observedAtSeconds: evidence.observedAtSeconds,
      confidence: actionableSoundConfidence(state, evidence),
      decayPerSecond: Math.max(0, evidence.decayPerSecond ?? 0.12),
      sourceType: soundSourceType(evidence),
      sourceId: evidence.sourceId ?? null,
      repeatCount,
      hideSpotId: null,
      strength: clamp01(evidence.strength),
    });
  }
  if (evidence.kind === "world-clue") {
    return Object.freeze({
      kind: "world-clue",
      position: Object.freeze({ ...evidence.position }),
      direction,
      observedAtSeconds: evidence.observedAtSeconds,
      confidence: clamp01(evidence.confidence),
      decayPerSecond: Math.max(0, evidence.decayPerSecond ?? 0.06),
      sourceType: evidence.sourceType,
      sourceId: evidence.clueId,
      repeatCount: 0,
      hideSpotId: null,
      strength: clamp01(evidence.confidence),
    });
  }
  return Object.freeze({
    kind: evidence.kind === "hide-entry-visible" ? "hide-entry-visible" : "visual",
    position: Object.freeze({ ...evidence.position }),
    direction,
    observedAtSeconds: evidence.observedAtSeconds,
    confidence: 1,
    decayPerSecond: evidence.kind === "hide-entry-visible" ? 0.025 : 0.08,
    sourceType: "player",
    sourceId: evidence.kind === "hide-entry-visible" ? `hide:${evidence.hideSpotId}` : "player-visual",
    repeatCount: 0,
    hideSpotId: evidence.kind === "hide-entry-visible" ? evidence.hideSpotId : null,
    strength: 1,
  });
}

function decayedEvidenceConfidence(entry: PublicEvidenceMemory, nowSeconds: number): number {
  const age = Math.max(0, nowSeconds - entry.observedAtSeconds);
  return clamp01(entry.confidence - age * Math.max(0, entry.decayPerSecond));
}

function evidencePriority(entry: PublicEvidenceMemory): number {
  switch (entry.kind) {
    case "hide-entry-visible": return 4;
    case "visual": return 3;
    case "world-clue": return 2;
    case "sound": return 1;
  }
}

function rememberPublicEvidence(
  state: ChaserState,
  evidence: Exclude<PerceptionEvidence, { kind: "none" }>,
): readonly PublicEvidenceMemory[] {
  const nextRecord = publicEvidenceRecord(state, evidence);
  const previous = state.memory.evidenceTrail ?? [];
  const replaces = (entry: PublicEvidenceMemory) => (
    nextRecord.sourceId !== null
    && entry.kind === nextRecord.kind
    && entry.sourceId === nextRecord.sourceId
    && entry.sourceType === nextRecord.sourceType
  );
  const retained = previous.filter((entry) => (
    !replaces(entry)
    && decayedEvidenceConfidence(entry, evidence.observedAtSeconds) > 0.05
  ));
  return Object.freeze([...retained, nextRecord]
    .sort((left, right) => (
      evidencePriority(right) - evidencePriority(left)
      || decayedEvidenceConfidence(right, evidence.observedAtSeconds)
        - decayedEvidenceConfidence(left, evidence.observedAtSeconds)
      || right.observedAtSeconds - left.observedAtSeconds
      || (right.sourceId ?? "").localeCompare(left.sourceId ?? "")
    ))
    .slice(0, MAX_PUBLIC_EVIDENCE));
}

export function publicEvidenceLedger(
  state: ChaserState,
  nowSeconds: number,
): readonly PublicEvidenceMemory[] {
  return Object.freeze((state.memory.evidenceTrail ?? [])
    .filter((entry) => decayedEvidenceConfidence(entry, nowSeconds) > 0.05)
    .map((entry) => Object.freeze({
      ...entry,
      position: Object.freeze({ ...entry.position }),
      direction: entry.direction ? Object.freeze({ ...entry.direction }) : null,
      confidence: decayedEvidenceConfidence(entry, nowSeconds),
    })));
}

function publicNavigationRegion(
  level: LevelDefinition,
  position: Point,
): { regionId: string; anchor: Point } | null {
  const origin = { x: Math.round(position.x), y: Math.round(position.y) };
  if (!isWalkable(level, origin)) return null;
  const queue: Point[] = [origin];
  const visited = new Set<string>([pointKey(origin)]);
  let depthStart = 0;
  while (depthStart < queue.length) {
    const depthEnd = queue.length;
    const landmarks = queue
      .slice(depthStart, depthEnd)
      .filter((point) => neighbors(level, point).length !== 2)
      .sort((left, right) => pointKey(left).localeCompare(pointKey(right)));
    if (landmarks.length) {
      const anchor = landmarks[0];
      const degree = neighbors(level, anchor).length;
      return {
        regionId: `${degree >= 3 ? "junction" : "corridor-end"}:${pointKey(anchor)}`,
        anchor: { ...anchor },
      };
    }
    for (let index = depthStart; index < depthEnd; index += 1) {
      for (const adjacent of neighbors(level, queue[index])) {
        const key = pointKey(adjacent);
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push(adjacent);
      }
    }
    depthStart = depthEnd;
  }
  return { regionId: `corridor:${pointKey(origin)}`, anchor: origin };
}

export function decayPublicRegionSuspicion(
  suspicion: readonly PublicRegionSuspicion[],
  nowSeconds: number,
): readonly PublicRegionSuspicion[] {
  return Object.freeze(suspicion
    .map((entry) => {
      const age = Math.max(0, nowSeconds - entry.updatedAtSeconds);
      return Object.freeze({
        ...entry,
        anchor: Object.freeze({ ...entry.anchor }),
        confidence: clamp01(entry.confidence - age * Math.max(0, entry.decayPerSecond)),
        updatedAtSeconds: nowSeconds,
      });
    })
    .filter((entry) => entry.confidence > 0.05)
    .sort((left, right) => (
      right.confidence - left.confidence
      || right.updatedAtSeconds - left.updatedAtSeconds
      || left.regionId.localeCompare(right.regionId)
    ))
    .slice(0, 4));
}

function suspicionEvidenceConfidence(
  state: ChaserState,
  evidence: Exclude<PerceptionEvidence, { kind: "none" }>,
): number {
  if (evidence.kind === "sound") return actionableSoundConfidence(state, evidence);
  if (evidence.kind === "world-clue") return clamp01(evidence.confidence);
  return 1;
}

function suspicionEvidenceDecay(
  evidence: Exclude<PerceptionEvidence, { kind: "none" }>,
): number {
  if (evidence.kind === "sound") return Math.max(0.025, (evidence.decayPerSecond ?? 0.12) * 0.35);
  if (evidence.kind === "world-clue") return Math.max(0.02, (evidence.decayPerSecond ?? 0.06) * 0.5);
  return evidence.kind === "hide-entry-visible" ? 0.025 : 0.04;
}

function rememberPublicRegion(
  state: ChaserState,
  level: LevelDefinition,
  evidence: Exclude<PerceptionEvidence, { kind: "none" }>,
  nowSeconds: number,
): ChaserState {
  const region = publicNavigationRegion(level, evidence.position);
  const evidenceConfidence = suspicionEvidenceConfidence(state, evidence);
  const exhaustedStableSound = evidence.kind === "sound"
    && Boolean(evidence.sourceId)
    && ["environment-decoy", "environment-hazard"].includes(soundSourceType(evidence))
    && evidenceConfidence < MIN_ACTIONABLE_SOUND_CONFIDENCE;
  if (!region || evidenceConfidence <= 0.08 || exhaustedStableSound) return state;
  const decayed = decayPublicRegionSuspicion(
    state.memory.regionSuspicion ?? [],
    nowSeconds,
  );
  const previous = decayed.find((entry) => entry.regionId === region.regionId);
  const nextEntry: PublicRegionSuspicion = Object.freeze({
    regionId: region.regionId,
    anchor: Object.freeze({ ...region.anchor }),
    confidence: clamp01((previous?.confidence ?? 0) + evidenceConfidence * 0.55),
    updatedAtSeconds: nowSeconds,
    decayPerSecond: suspicionEvidenceDecay(evidence),
  });
  const nextSuspicion = Object.freeze([
    ...decayed.filter((entry) => entry.regionId !== region.regionId),
    nextEntry,
  ].sort((left, right) => (
    right.confidence - left.confidence
    || right.updatedAtSeconds - left.updatedAtSeconds
    || left.regionId.localeCompare(right.regionId)
  )).slice(0, 4));
  return {
    ...state,
    memory: { ...state.memory, regionSuspicion: nextSuspicion },
  };
}

function publicTravelDirection(
  state: ChaserState,
  evidence: Exclude<PerceptionEvidence, { kind: "none" }>,
): Point | null {
  if (evidence.direction && Math.hypot(evidence.direction.x, evidence.direction.y) > 1e-9) {
    return normalizeVector(evidence.direction);
  }
  const previous = state.memory.lastKnownPosition;
  if (previous) {
    const displacement = {
      x: evidence.position.x - previous.x,
      y: evidence.position.y - previous.y,
    };
    if (Math.hypot(displacement.x, displacement.y) > 0.1) {
      return normalizeVector(displacement);
    }
  }
  return state.memory.lastKnownDirection
    ? { ...state.memory.lastKnownDirection }
    : null;
}

/**
 * Public level geometry plus remembered evidence are the complete input.
 * Runtime locker occupancy is intentionally absent from both the signature
 * and ChaserState, preserving FAIR-01 by construction.
 */
export function evidenceRankedHideCandidates(
  state: ChaserState,
  level: LevelDefinition,
  config: Pick<GameConfig, "searchHideRadiusCells">,
): readonly string[] {
  const anchor = state.memory.lastKnownPosition;
  if (!anchor || config.searchHideRadiusCells <= 0) return Object.freeze([]);
  const inspected = new Set(state.inspectedHideSpotIds);
  return Object.freeze(level.hideSpots
    .map((spot) => ({
      id: spot.id,
      routeDistance: findPath(level, anchor, spot.approach).length - 1,
      tieBreak: stableIdHash(spot.id, state.searchSeed),
    }))
    .filter((candidate) => (
      !inspected.has(candidate.id)
      && candidate.routeDistance >= 0
      && candidate.routeDistance <= config.searchHideRadiusCells
    ))
    .sort((left, right) => (
      left.routeDistance - right.routeDistance
      || left.tieBreak - right.tieBreak
      || left.id.localeCompare(right.id)
    ))
    .map((candidate) => candidate.id));
}

function enterSearch(
  state: ChaserState,
  level: LevelDefinition,
  config: GameConfig,
  initialWaypointElapsedSeconds = 0,
): ChaserState {
  const seeded = {
    ...enterMode(state, "search"),
    searchSeed: evidenceSearchSeed(state),
    searchPlan: Object.freeze([]) as readonly Point[],
    searchIndex: 0,
    searchWaypointElapsedSeconds: initialWaypointElapsedSeconds,
    searchHideSpotId: null,
    hideCheckSource: null,
  };
  const hasBudget = seeded.searchHideChecksCompleted < Math.floor(config.searchHideCheckBudget);
  const searchHideSpotId = hasBudget
    ? evidenceRankedHideCandidates(seeded, level, config)[0] ?? null
    : null;
  const searchPlan = seeded.memory.lastKnownPosition
    ? generateSearchWaypoints(
        level,
        seeded.memory.lastKnownPosition,
        seeded.searchSeed,
        {
          // Only a continuous visual track exposes travel direction. Sound and
          // object clues retain the public regional prior without an oracle
          // heading.
          preferredDirection: seeded.memory.lastKnownEvidence === "visual"
            ? seeded.memory.lastKnownDirection
            : null,
          regionSuspicion: seeded.memory.regionSuspicion,
        },
      )
    : Object.freeze([]);
  return {
    ...seeded,
    searchPlan,
    searchHideSpotId,
    hideCheckSource: searchHideSpotId ? "search" : null,
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
  const preserveActiveHideCheck = state.mode === "check-hide" && evidence.kind === "player-visible";
  const evidenceTrail = rememberPublicEvidence(state, evidence);
  const lastKnownDirection = publicTravelDirection(state, evidence);
  return {
    ...state,
    searchHideSpotId: preserveActiveHideCheck ? state.searchHideSpotId : null,
    hideCheckSource: preserveActiveHideCheck ? state.hideCheckSource : null,
    searchHideChecksCompleted: preserveActiveHideCheck ? state.searchHideChecksCompleted : 0,
    inspectedHideSpotIds: preserveActiveHideCheck ? state.inspectedHideSpotIds : Object.freeze([]),
    memory: {
      ...state.memory,
      lastKnownPosition: { ...evidence.position },
      lastKnownDirection,
      lastSeenAtSeconds: evidence.observedAtSeconds,
      lastHeardAtSeconds: null,
      lastClueAtSeconds: state.memory.lastClueAtSeconds,
      lastKnownEvidence: "visual",
      // A fresh visual point remains primary, but must not erase a legally
      // heard secondary cue before its post-visual investigation window.
      deferredSoundEvidence: state.memory.deferredSoundEvidence,
      witnessedHideSpotId: evidence.kind === "hide-entry-visible"
        ? evidence.hideSpotId
        : state.mode === "check-hide"
          ? state.memory.witnessedHideSpotId
          : null,
      evidenceTrail,
    },
  };
}

function rememberSoundTarget(
  state: ChaserState,
  evidence: Extract<PerceptionEvidence, { kind: "sound" }>,
): ChaserState {
  const evidenceTrail = rememberPublicEvidence(state, evidence);
  const lastKnownDirection = publicTravelDirection(state, evidence);
  return {
    ...state,
    searchHideSpotId: null,
    hideCheckSource: null,
    searchHideChecksCompleted: 0,
    inspectedHideSpotIds: Object.freeze([]),
    memory: {
      ...state.memory,
      lastKnownPosition: { ...evidence.position },
      lastKnownDirection,
      lastHeardAtSeconds: evidence.observedAtSeconds,
      lastKnownEvidence: "sound",
      deferredSoundEvidence: null,
      witnessedHideSpotId: null,
      evidenceTrail,
    },
  };
}

function rememberWorldClueTarget(
  state: ChaserState,
  evidence: Extract<PerceptionEvidence, { kind: "world-clue" }>,
): ChaserState {
  const evidenceTrail = rememberPublicEvidence(state, evidence);
  const lastKnownDirection = publicTravelDirection(state, evidence);
  return {
    ...state,
    searchHideSpotId: null,
    hideCheckSource: null,
    searchHideChecksCompleted: 0,
    inspectedHideSpotIds: Object.freeze([]),
    memory: {
      ...state.memory,
      lastKnownPosition: { ...evidence.position },
      lastKnownDirection,
      lastClueAtSeconds: evidence.observedAtSeconds,
      lastKnownEvidence: "world-clue",
      deferredSoundEvidence: null,
      witnessedHideSpotId: null,
      evidenceTrail,
    },
  };
}

type SoundEvidence = Extract<PerceptionEvidence, { kind: "sound" }>;

function deferredSoundMaxAge(config: GameConfig): number {
  // A heard point remains actionable through lost-sight, the planted scan and
  // two local-search beats. Older samples are too stale to justify abandoning
  // the stronger visual anchor.
  return config.lostSightGraceSeconds
    + config.lastKnownScanSeconds
    + config.searchWaypointSeconds * 2;
}

function soundEvidenceUtility(
  state: Pick<ChaserState, "position">,
  level: LevelDefinition,
  config: GameConfig,
  evidence: Pick<SoundEvidence, "position" | "strength" | "observedAtSeconds" | "confidence">,
  nowSeconds: number,
): number {
  const age = Math.max(0, nowSeconds - evidence.observedAtSeconds);
  const maxAge = Math.max(config.aiTickSeconds, deferredSoundMaxAge(config));
  if (age > maxAge + 1e-9) return Number.NEGATIVE_INFINITY;
  const route = findPath(level, state.position, evidence.position);
  if (!route.length) return Number.NEGATIVE_INFINITY;
  const routeDistance = Math.max(0, route.length - 1);
  const distanceScale = Math.max(1, config.hearingRange + config.soundUncertaintyCells);
  const freshness = 1 - clamp01(age / maxAge);
  const proximity = 1 - clamp01(routeDistance / distanceScale);
  const confidence = clamp01(evidence.confidence ?? evidence.strength);
  return clamp01(evidence.strength) * 0.35 + confidence * 0.25 + freshness * 0.3 + proximity * 0.1;
}

function deferSoundEvidence(
  state: ChaserState,
  level: LevelDefinition,
  config: GameConfig,
  evidence: SoundEvidence,
  nowSeconds: number,
): ChaserState {
  const candidateUtility = soundEvidenceUtility(state, level, config, evidence, nowSeconds);
  if (!Number.isFinite(candidateUtility)) return state;
  const previous = state.memory.deferredSoundEvidence;
  const previousUtility = previous
    ? soundEvidenceUtility(state, level, config, previous, nowSeconds)
    : Number.NEGATIVE_INFINITY;
  if (
    candidateUtility + 1e-9 < previousUtility
    || (
      Math.abs(candidateUtility - previousUtility) <= 1e-9
      && previous
      && evidence.observedAtSeconds <= previous.observedAtSeconds
    )
  ) return state;
  return {
    ...state,
    memory: {
      ...state.memory,
      deferredSoundEvidence: {
        position: { ...evidence.position },
        ...(evidence.direction ? { direction: normalizeVector(evidence.direction) } : {}),
        strength: clamp01(evidence.strength),
        observedAtSeconds: evidence.observedAtSeconds,
        sourceType: soundSourceType(evidence),
        ...(evidence.sourceId ? { sourceId: evidence.sourceId } : {}),
        confidence: actionableSoundConfidence(state, evidence),
        decayPerSecond: Math.max(0, evidence.decayPerSecond ?? 0.12),
      },
      evidenceTrail: rememberPublicEvidence(state, evidence),
    },
  };
}

function rememberConcurrentSound(
  state: ChaserState,
  level: LevelDefinition,
  config: GameConfig,
  evidence: SoundEvidence,
  nowSeconds: number,
): ChaserState {
  const confidence = actionableSoundConfidence(state, evidence);
  const stableEnvironmentEmitter = Boolean(
    evidence.sourceId
    && ["environment-decoy", "environment-hazard"].includes(soundSourceType(evidence)),
  );
  if (stableEnvironmentEmitter && confidence < MIN_ACTIONABLE_SOUND_CONFIDENCE) {
    return {
      ...state,
      memory: {
        ...state.memory,
        evidenceTrail: rememberPublicEvidence(state, evidence),
      },
    };
  }
  return deferSoundEvidence(state, level, config, evidence, nowSeconds);
}

function drivingInvestigableEvidence(state: ChaserState): PublicEvidenceMemory | null {
  if (
    state.memory.lastKnownEvidence !== "sound"
    && state.memory.lastKnownEvidence !== "world-clue"
  ) return null;
  const observedAtSeconds = state.memory.lastKnownEvidence === "sound"
    ? state.memory.lastHeardAtSeconds
    : state.memory.lastClueAtSeconds;
  return (state.memory.evidenceTrail ?? []).find((entry) => (
    entry.kind === state.memory.lastKnownEvidence
    && Math.abs(entry.observedAtSeconds - (observedAtSeconds ?? -1)) <= 1e-6
  )) ?? null;
}

function promoteDeferredSound(
  state: ChaserState,
  level: LevelDefinition,
  config: GameConfig,
  nowSeconds: number,
): { state: ChaserState; promoted: boolean } {
  const deferred = state.memory.deferredSoundEvidence;
  const withoutDeferred = deferred
    ? { ...state, memory: { ...state.memory, deferredSoundEvidence: null } }
    : state;
  if (
    !deferred
    || soundEvidenceUtility(state, level, config, deferred, nowSeconds) < 0.2
  ) return { state: withoutDeferred, promoted: false };
  const promoted = {
    ...withoutDeferred,
    searchHideSpotId: null,
    hideCheckSource: null,
    searchHideChecksCompleted: 0,
    inspectedHideSpotIds: Object.freeze([]),
    memory: {
      ...withoutDeferred.memory,
      lastKnownPosition: { ...deferred.position },
      lastKnownDirection: deferred.direction
        ? normalizeVector(deferred.direction)
        : publicTravelDirection(withoutDeferred, {
            kind: "sound",
            position: deferred.position,
            strength: deferred.strength,
            observedAtSeconds: deferred.observedAtSeconds,
            ...(deferred.sourceType ? { sourceType: deferred.sourceType } : {}),
            ...(deferred.sourceId ? { sourceId: deferred.sourceId } : {}),
            ...(deferred.confidence !== undefined ? { confidence: deferred.confidence } : {}),
            ...(deferred.decayPerSecond !== undefined
              ? { decayPerSecond: deferred.decayPerSecond }
              : {}),
          }),
      lastHeardAtSeconds: deferred.observedAtSeconds,
      lastKnownEvidence: "sound" as const,
      deferredSoundEvidence: null,
      witnessedHideSpotId: null,
    },
  };
  return {
    // The deferred sample was already registered when first heard. Promotion
    // changes only which public fact drives navigation; it is not a second
    // emitter use and therefore must not add another habituation penalty.
    state: enterMode(promoted, "go-to-last-known"),
    promoted: true,
  };
}

function patrolIndexAfterExhaustedSearch(
  level: LevelDefinition,
  suspicion: readonly PublicRegionSuspicion[],
  currentIndex: number,
): number {
  if (!level.patrol.length || !suspicion.length) return currentIndex;
  const normalizedCurrentIndex =
    ((currentIndex % level.patrol.length) + level.patrol.length) % level.patrol.length;
  const currentPoint = level.patrol[normalizedCurrentIndex];
  const currentRegionDistance = suspicion.reduce((nearest, region) => {
    const route = findPath(level, currentPoint, region.anchor);
    return route.length
      ? Math.min(nearest, Math.max(0, route.length - 1))
      : nearest;
  }, Number.POSITIVE_INFINITY);
  // Preserve authored patrol continuity unless its immediate target would
  // revisit the region that the completed search just exhausted. This keeps
  // suspicion from turning into a map-wide avoidance oracle.
  if (currentRegionDistance > 2) return currentIndex;
  return level.patrol
    .map((point, index) => {
      const affinity = suspicion.reduce((total, region) => {
        const route = findPath(level, point, region.anchor);
        if (!route.length) return total;
        return total + clamp01(region.confidence) / (1 + route.length - 1);
      }, 0);
      const cycleOffset =
        (index - currentIndex + level.patrol.length) % level.patrol.length;
      return { index, affinity, cycleOffset: cycleOffset || level.patrol.length };
    })
    // A completed, fruitless search temporarily clears its hottest region.
    // Patrol resumes through the least-suspicious public corridor instead of
    // immediately retracing the same route and camping the evidence anchor.
    .sort((left, right) => (
      left.affinity - right.affinity
      || left.cycleOffset - right.cycleOffset
      || left.index - right.index
    ))[0]?.index ?? currentIndex;
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
  let next: ChaserState = {
    ...state,
    modeElapsedSeconds: elapsed,
    memory: {
      ...state.memory,
      regionSuspicion: decayPublicRegionSuspicion(
        state.memory.regionSuspicion ?? [],
        input.nowSeconds,
      ),
    },
  };

  if (state.mode === "spawn-delay") {
    if (elapsed + 1e-9 >= config.spawnDelaySeconds) next = enterMode(next, "patrol");
    return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
  }

  if (input.evidence.kind !== "none") {
    next = rememberPublicRegion(next, level, input.evidence, input.nowSeconds);
  }
  if (input.secondarySoundEvidence) {
    next = rememberPublicRegion(
      next,
      level,
      input.secondarySoundEvidence,
      input.nowSeconds,
    );
  }

  if (input.evidence.kind === "hide-entry-visible") {
    next = rememberVisibleTarget(next, input.evidence);
    next = {
      ...enterMode(next, "check-hide"),
      searchHideSpotId: input.evidence.hideSpotId,
      hideCheckSource: "witnessed",
    };
    if (input.secondarySoundEvidence) {
      next = rememberConcurrentSound(
        next,
        level,
        config,
        input.secondarySoundEvidence,
        input.nowSeconds,
      );
    }
    return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
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
          searchHideSpotId: null,
          hideCheckSource: null,
          memory: { ...next.memory, witnessedHideSpotId: null },
        }, "chase");
      }
    }
    if (input.secondarySoundEvidence) {
      next = rememberConcurrentSound(
        next,
        level,
        config,
        input.secondarySoundEvidence,
        input.nowSeconds,
      );
    }
    return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
  }

  if (input.evidence.kind === "world-clue") {
    const worldClue = input.evidence;
    const lowConfidenceObservation =
      clamp01(worldClue.confidence) < MIN_ACTIONABLE_WORLD_CLUE_CONFIDENCE;
    const alreadyDrivingSameClue = next.memory.lastKnownEvidence === "world-clue"
      && next.memory.evidenceTrail?.some((entry) => (
        entry.kind === "world-clue"
        && entry.sourceId === worldClue.clueId
      ));
    const committedToVisualAnchor = state.memory.lastKnownEvidence === "visual"
      && ["suspicious", "chase", "lost-sight", "go-to-last-known", "scan-last-known"].includes(state.mode);
    if (
      lowConfidenceObservation
      || committedToVisualAnchor
      || state.mode === "check-hide"
      || alreadyDrivingSameClue
    ) {
      next = {
        ...next,
        memory: {
          ...next.memory,
          evidenceTrail: rememberPublicEvidence(next, worldClue),
        },
      };
      if (input.secondarySoundEvidence) {
        next = rememberConcurrentSound(
          next,
          level,
          config,
          input.secondarySoundEvidence,
          input.nowSeconds,
        );
      }
    } else {
      next = enterMode(rememberWorldClueTarget(next, worldClue), "go-to-last-known");
      if (input.secondarySoundEvidence) {
        next = rememberConcurrentSound(
          next,
          level,
          config,
          input.secondarySoundEvidence,
          input.nowSeconds,
        );
      }
      return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
    }
  }

  if (input.evidence.kind === "sound") {
    let secondarySoundHandled = false;
    const confidence = actionableSoundConfidence(next, input.evidence);
    const stableEnvironmentEmitter = Boolean(
      input.evidence.sourceId
      && ["environment-decoy", "environment-hazard"].includes(soundSourceType(input.evidence)),
    );
    if (stableEnvironmentEmitter && confidence < MIN_ACTIONABLE_SOUND_CONFIDENCE) {
      // The brain remembers that this public emitter cried wolf, but a worn-out
      // decoy can no longer reset its route or search timer.
      next = {
        ...next,
        memory: {
          ...next.memory,
          evidenceTrail: rememberPublicEvidence(next, input.evidence),
        },
      };
      const secondary = input.secondarySoundEvidence;
      if (secondary) {
        const secondaryConfidence = actionableSoundConfidence(next, secondary);
        const secondaryStableEnvironmentEmitter = Boolean(
          secondary.sourceId
          && ["environment-decoy", "environment-hazard"].includes(
            soundSourceType(secondary),
          ),
        );
        if (
          !secondaryStableEnvironmentEmitter
          || secondaryConfidence >= MIN_ACTIONABLE_SOUND_CONFIDENCE
        ) {
          const committedToVisualAnchor = state.memory.lastKnownEvidence === "visual"
            && ["suspicious", "chase", "lost-sight", "go-to-last-known", "scan-last-known"].includes(state.mode);
          if (committedToVisualAnchor || state.mode === "check-hide") {
            next = deferSoundEvidence(next, level, config, secondary, input.nowSeconds);
          } else {
            next = enterMode(rememberSoundTarget(next, secondary), "go-to-last-known");
            return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
          }
        } else {
          next = rememberConcurrentSound(next, level, config, secondary, input.nowSeconds);
        }
        secondarySoundHandled = true;
      }
    } else {
      const committedToVisualAnchor = state.memory.lastKnownEvidence === "visual"
        && ["suspicious", "chase", "lost-sight", "go-to-last-known", "scan-last-known"].includes(state.mode);
      if (committedToVisualAnchor || state.mode === "check-hide") {
        // Preserve the stronger visual point and the authored locker inspection,
        // but do not discard the new sound. Only its already-imprecise perceived
        // point is stored; no player position or locker occupancy enters memory.
        next = deferSoundEvidence(next, level, config, input.evidence, input.nowSeconds);
      } else {
        next = enterMode(rememberSoundTarget(next, input.evidence), "go-to-last-known");
        if (input.secondarySoundEvidence) {
          next = rememberConcurrentSound(
            next,
            level,
            config,
            input.secondarySoundEvidence,
            input.nowSeconds,
          );
        }
        return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
      }
    }
    if (input.secondarySoundEvidence && !secondarySoundHandled) {
      next = rememberConcurrentSound(
        next,
        level,
        config,
        input.secondarySoundEvidence,
        input.nowSeconds,
      );
    }
  }

  if (state.visualConfirmationSeconds !== null) {
    // A brief reacquisition is still newer evidence than the search that was
    // already in progress. If confirmation breaks, pursue that latest point
    // instead of letting an old search timeout erase it or inserting another
    // stationary lost-sight beat.
    if (state.mode === "check-hide") {
      // A brief peek cannot cancel an already-authored locker inspection.
      // Clear only the provisional confirmation and continue its walk/door
      // timer; a sustained view still promotes to chase above.
      next = { ...next, visualConfirmationSeconds: null };
    } else {
      next = state.mode === "go-to-last-known"
        ? { ...next, visualConfirmationSeconds: null }
        : enterMode(next, "go-to-last-known");
      return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
    }
  } else {
    next = { ...next, visualConfirmationSeconds: null };
  }

  let completedEvidenceInvestigation: CompletedEvidenceInvestigation | undefined;
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
      if (!next.memory.lastKnownPosition) next = enterSearch(next, level, config);
      else if (input.reachedTarget) next = enterLastKnownScan(next);
      break;
    case "scan-last-known":
      next = {
        ...next,
        heading: lastKnownScanHeading(state.scanOriginHeading, elapsed, config.lastKnownScanSeconds),
      };
      if (elapsed + 1e-9 >= config.lastKnownScanSeconds) {
        const investigatedEvidence = drivingInvestigableEvidence(state);
        if (
          investigatedEvidence?.sourceId
          && investigatedEvidence.sourceType !== "player"
        ) {
          completedEvidenceInvestigation = {
            sourceId: investigatedEvidence.sourceId,
            sourceType: investigatedEvidence.sourceType,
          };
        }
        const deferred = promoteDeferredSound(next, level, config, input.nowSeconds);
        if (deferred.promoted) {
          next = deferred.state;
          break;
        }
        // Search index zero is the exact continuous sighting point. Keep one
        // AI beat planted there so the centred final scan pose is rendered
        // before the first wider-search step can change position or heading.
        next = enterSearch(
          deferred.state,
          level,
          config,
          Math.max(0, config.searchWaypointSeconds - config.aiTickSeconds),
        );
      }
      break;
    case "search":
      if (elapsed + 1e-9 >= config.searchSeconds) {
        const regionSuspicion = decayPublicRegionSuspicion(
          next.memory.regionSuspicion ?? [],
          input.nowSeconds,
        );
        next = enterMode({
          ...next,
          patrolIndex: patrolIndexAfterExhaustedSearch(
            level,
            regionSuspicion,
            state.patrolIndex,
          ),
          searchIndex: 0,
          searchWaypointElapsedSeconds: 0,
          searchHideSpotId: null,
          hideCheckSource: null,
          searchHideChecksCompleted: 0,
          inspectedHideSpotIds: Object.freeze([]),
          memory: {
            lastKnownPosition: null,
            lastKnownDirection: null,
            lastSeenAtSeconds: null,
            lastHeardAtSeconds: null,
            lastClueAtSeconds: null,
            lastKnownEvidence: null,
            deferredSoundEvidence: null,
            witnessedHideSpotId: null,
            evidenceTrail: Object.freeze([]),
            regionSuspicion,
          },
        }, "patrol");
      } else if (state.searchHideSpotId && input.reachedTarget) {
        next = {
          ...enterMode(next, "check-hide"),
          searchHideSpotId: state.searchHideSpotId,
          hideCheckSource: "search",
        };
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
        const completedHideCheckId = state.searchHideSpotId ?? state.memory.witnessedHideSpotId;
        const completedHideCheckSource = state.hideCheckSource
          ?? (state.memory.witnessedHideSpotId ? "witnessed" : null);
        const inspectedHideSpotIds = completedHideCheckId
          ? Object.freeze([...new Set([...state.inspectedHideSpotIds, completedHideCheckId])])
          : state.inspectedHideSpotIds;
        const continued = enterSearch({
          ...next,
          searchHideSpotId: null,
          hideCheckSource: null,
          searchHideChecksCompleted: state.searchHideChecksCompleted
            + Number(completedHideCheckSource === "search"),
          inspectedHideSpotIds,
          memory: { ...next.memory, witnessedHideSpotId: null },
        }, level, config);
        next = promoteDeferredSound(continued, level, config, input.nowSeconds).state;
        return { state: next, completedHideCheckId, completedHideCheckSource };
      }
      break;
    }
  }
  return {
    state: next,
    completedHideCheckId: null,
    completedHideCheckSource: null,
    ...(completedEvidenceInvestigation && completedEvidenceInvestigation.sourceType !== "footprint"
      && completedEvidenceInvestigation.sourceType !== "disturbed-prop"
      && completedEvidenceInvestigation.sourceType !== "door-disturbance"
      && completedEvidenceInvestigation.sourceType !== "infrastructure-anomaly"
      ? { completedSoundInvestigation: completedEvidenceInvestigation }
      : {}),
    ...(completedEvidenceInvestigation ? { completedEvidenceInvestigation } : {}),
  };
}

export interface SearchHypothesis {
  /** Reachable point the chaser will physically inspect. */
  readonly target: Point;
  /** Real navigation-graph junction from which this branch originates. */
  readonly junction: Point;
  readonly routeDistance: number;
  readonly branchHeading: Point;
  readonly fallback: boolean;
}

export interface SearchHypothesisContext {
  /** Direction supplied by a legal perception adapter; never concealed state. */
  readonly preferredDirection?: Point | null;
  /** Decayed public regions used only as an ordering prior. */
  readonly regionSuspicion?: readonly PublicRegionSuspicion[];
}

function hypothesisSuspicionAffinity(
  level: LevelDefinition,
  target: Point,
  suspicion: readonly PublicRegionSuspicion[],
): number {
  let best = 0;
  for (const region of suspicion) {
    const route = findPath(level, target, region.anchor);
    if (!route.length) continue;
    best = Math.max(
      best,
      clamp01(region.confidence) / (1 + Math.max(0, route.length - 1) * 0.35),
    );
  }
  return best;
}

function hypothesisOrderScore(
  level: LevelDefinition,
  hypothesis: SearchHypothesis,
  context: SearchHypothesisContext,
): number {
  const direction = context.preferredDirection
    && Math.hypot(context.preferredDirection.x, context.preferredDirection.y) > 1e-9
    ? normalizeVector(context.preferredDirection)
    : null;
  const alignment = direction
    ? hypothesis.branchHeading.x * direction.x + hypothesis.branchHeading.y * direction.y
    : 0;
  const suspicion = hypothesisSuspicionAffinity(
    level,
    hypothesis.target,
    context.regionSuspicion ?? [],
  );
  // Direction and suspicion break nearby branch ties without allowing a
  // weak public clue to outweigh several cells of real navigation distance.
  return hypothesis.routeDistance - alignment * 0.35 - suspicion * 0.4;
}

/**
 * Builds three-to-five public-geometry search hypotheses. Real junction
 * branches are preferred; narrow maps fall back to reachable bends/dead ends
 * rather than inventing off-grid offsets.
 */
export function generateSearchHypotheses(
  level: LevelDefinition,
  anchor: Point,
  seed: number,
  maximum = 5,
  context: SearchHypothesisContext = {},
): readonly SearchHypothesis[] {
  const limit = Math.max(3, Math.min(5, Math.floor(maximum)));
  const origin = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
  if (!isWalkable(level, origin)) return Object.freeze([]);

  const parent = new Map<string, Point | null>([[pointKey(origin), null]]);
  const distance = new Map<string, number>([[pointKey(origin), 0]]);
  const queue: Point[] = [origin];
  const reachable: Point[] = [];
  const maximumGraphDistance = Math.max(6, Math.min(12, Math.ceil(Math.hypot(level.width, level.height) / 2)));
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const currentDistance = distance.get(pointKey(current)) ?? 0;
    reachable.push(current);
    if (currentDistance >= maximumGraphDistance) continue;
    for (const next of neighbors(level, current)) {
      const key = pointKey(next);
      if (parent.has(key)) continue;
      parent.set(key, current);
      distance.set(key, currentDistance + 1);
      queue.push(next);
    }
  }

  const candidates: SearchHypothesis[] = [];
  for (const junction of reachable) {
    const junctionNeighbors = neighbors(level, junction);
    if (junctionNeighbors.length < 3) continue;
    const incoming = parent.get(pointKey(junction));
    for (const firstStep of junctionNeighbors) {
      if (incoming && pointKey(firstStep) === pointKey(incoming)) continue;
      // The first cell beyond a real junction is enough to commit to that
      // branch. Deeper travel belongs to later evidence, preventing one
      // hypothesis from becoming an unearned corridor-long pursuit.
      const target = firstStep;
      const route = findPath(level, origin, target);
      if (!route.length || pointKey(target) === pointKey(origin)) continue;
      candidates.push(Object.freeze({
        target: Object.freeze({ ...target }),
        junction: Object.freeze({ ...junction }),
        routeDistance: route.length - 1,
        branchHeading: Object.freeze(normalizeVector({
          x: firstStep.x - junction.x,
          y: firstStep.y - junction.y,
        })),
        fallback: false,
      }));
    }
  }

  const ordered = candidates.sort((left, right) => (
    hypothesisOrderScore(level, left, context)
      - hypothesisOrderScore(level, right, context)
    || stableIdHash(`${pointKey(left.junction)}>${pointKey(left.target)}`, seed)
      - stableIdHash(`${pointKey(right.junction)}>${pointKey(right.target)}`, seed)
    || pointKey(left.target).localeCompare(pointKey(right.target))
  ));
  const unique: SearchHypothesis[] = [];
  const seen = new Set<string>([pointKey(origin)]);
  for (const candidate of ordered) {
    const key = pointKey(candidate.target);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= limit) break;
  }

  if (unique.length < 3) {
    const fallback = reachable
      .filter((point) => pointKey(point) !== pointKey(origin) && !seen.has(pointKey(point)))
      .map((target) => {
        const route = findPath(level, origin, target);
        const junction = route.slice(0, -1).reverse()
          .find((point) => neighbors(level, point).length >= 3)
          ?? origin;
        const previous = route[Math.max(0, route.length - 2)] ?? origin;
        return {
          target,
          route,
          hypothesis: Object.freeze({
            target: Object.freeze({ ...target }),
            junction: Object.freeze({ ...junction }),
            routeDistance: Math.max(0, route.length - 1),
            branchHeading: Object.freeze(normalizeVector({
              x: target.x - previous.x,
              y: target.y - previous.y,
            })),
            fallback: true,
          }),
        };
      })
      .filter(({ route }) => route.length)
      .sort((left, right) => (
        hypothesisOrderScore(level, left.hypothesis, context)
          - hypothesisOrderScore(level, right.hypothesis, context)
        || stableIdHash(pointKey(left.target), seed ^ 0x9e3779b9)
          - stableIdHash(pointKey(right.target), seed ^ 0x9e3779b9)
      ));
    for (const { target, hypothesis } of fallback) {
      unique.push(hypothesis);
      seen.add(pointKey(target));
      if (unique.length >= Math.min(3, limit)) break;
    }
  }
  return Object.freeze(unique.slice(0, limit));
}

export function generateSearchWaypoints(
  level: LevelDefinition,
  anchor: Point,
  seed: number,
  context: SearchHypothesisContext = {},
): readonly Point[] {
  // The exact, potentially sub-cell evidence point supplies the planted
  // post-scan beat. Each real branch hypothesis returns through that public
  // anchor before the next branch, producing a readable fan search instead
  // of accidentally converting one hypothesis into a second chase route.
  const hypotheses = generateSearchHypotheses(level, anchor, seed, 5, context);
  return Object.freeze([
    Object.freeze({ ...anchor }),
    ...hypotheses.flatMap((hypothesis) => [
      Object.freeze({ ...hypothesis.target }),
      Object.freeze({ ...anchor }),
    ]),
  ]);
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
      if (state.searchHideSpotId) {
        const spot = level.hideSpots.find((candidate) => candidate.id === state.searchHideSpotId);
        if (spot) return { ...spot.approach };
      }
      const candidates = state.searchPlan;
      const candidateCount = candidates.length;
      if (!candidateCount) return { ...state.memory.lastKnownPosition };
      const index = state.searchIndex % candidateCount;
      return { ...candidates[index] };
    }
    case "check-hide": {
      const id = state.searchHideSpotId ?? state.memory.witnessedHideSpotId;
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
