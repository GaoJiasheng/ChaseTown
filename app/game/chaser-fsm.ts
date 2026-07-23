import type {
  ChaserMode,
  ChaserState,
  GameConfig,
  LevelDefinition,
  PerceptionEvidence,
  Point,
  PublicEvidenceMemory,
  SoundEvidenceSourceType,
} from "./contracts.ts";
import { distanceBetween, findPath, isWalkable, neighbors, normalizeVector, pointKey } from "./navigation.ts";

export interface ChaserBrainInput {
  /** Deliberately contains evidence, not PlayerState or playerPosition. */
  evidence: PerceptionEvidence;
  /**
   * A simultaneously heard public sound. Visual evidence remains primary;
   * this can only enter the bounded ledger/deferred queue.
   */
  secondarySoundEvidence?: Extract<PerceptionEvidence, { kind: "sound" }>;
  reachedTarget: boolean;
  nowSeconds: number;
  deltaSeconds: number;
}

export interface CompletedSoundInvestigation {
  readonly sourceId: string;
  readonly sourceType: SoundEvidenceSourceType;
}

export interface ChaserBrainResult {
  state: ChaserState;
  completedHideCheckId: string | null;
  completedHideCheckSource: "witnessed" | "search" | null;
  completedSoundInvestigation?: CompletedSoundInvestigation;
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
    searchHideSpotId: null,
    hideCheckSource: null,
    searchHideChecksCompleted: 0,
    inspectedHideSpotIds: Object.freeze([]),
    memory: {
      lastKnownPosition: null,
      lastSeenAtSeconds: null,
      lastHeardAtSeconds: null,
      lastKnownEvidence: null,
      deferredSoundEvidence: null,
      witnessedHideSpotId: null,
      evidenceTrail: Object.freeze([]),
    },
  };
}

function enterMode(state: ChaserState, mode: ChaserMode): ChaserState {
  return { ...state, mode, modeElapsedSeconds: 0, visualConfirmationSeconds: null };
}

function evidenceSearchSeed(state: ChaserState): number {
  const point = state.memory.lastKnownPosition ?? state.position;
  const evidenceAtSeconds = state.memory.lastKnownEvidence === "sound"
    ? state.memory.lastHeardAtSeconds
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
  if (evidence.kind === "sound") {
    const priorRepeatCount = repeatedSourceCount(state, evidence);
    const repeatCount = priorRepeatCount < 0 ? 0 : priorRepeatCount + 1;
    return Object.freeze({
      kind: "sound",
      position: Object.freeze({ ...evidence.position }),
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
  return Object.freeze({
    kind: evidence.kind === "hide-entry-visible" ? "hide-entry-visible" : "visual",
    position: Object.freeze({ ...evidence.position }),
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
    case "hide-entry-visible": return 3;
    case "visual": return 2;
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
      confidence: decayedEvidenceConfidence(entry, nowSeconds),
    })));
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
    searchIndex: 0,
    searchWaypointElapsedSeconds: initialWaypointElapsedSeconds,
    searchHideSpotId: null,
    hideCheckSource: null,
  };
  const hasBudget = seeded.searchHideChecksCompleted < Math.floor(config.searchHideCheckBudget);
  const searchHideSpotId = hasBudget
    ? evidenceRankedHideCandidates(seeded, level, config)[0] ?? null
    : null;
  return { ...seeded, searchHideSpotId, hideCheckSource: searchHideSpotId ? "search" : null };
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
  return {
    ...state,
    searchHideSpotId: preserveActiveHideCheck ? state.searchHideSpotId : null,
    hideCheckSource: preserveActiveHideCheck ? state.hideCheckSource : null,
    searchHideChecksCompleted: preserveActiveHideCheck ? state.searchHideChecksCompleted : 0,
    inspectedHideSpotIds: preserveActiveHideCheck ? state.inspectedHideSpotIds : Object.freeze([]),
    memory: {
      lastKnownPosition: { ...evidence.position },
      lastSeenAtSeconds: evidence.observedAtSeconds,
      lastHeardAtSeconds: null,
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
  return {
    ...state,
    searchHideSpotId: null,
    hideCheckSource: null,
    searchHideChecksCompleted: 0,
    inspectedHideSpotIds: Object.freeze([]),
    memory: {
      ...state.memory,
      lastKnownPosition: { ...evidence.position },
      lastHeardAtSeconds: evidence.observedAtSeconds,
      lastKnownEvidence: "sound",
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

function drivingSoundEvidence(state: ChaserState): PublicEvidenceMemory | null {
  if (state.memory.lastKnownEvidence !== "sound") return null;
  return (state.memory.evidenceTrail ?? []).find((entry) => (
    entry.kind === "sound"
    && Math.abs(entry.observedAtSeconds - (state.memory.lastHeardAtSeconds ?? -1)) <= 1e-6
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
    return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
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

  if (input.evidence.kind === "sound") {
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
        return { state: next, completedHideCheckId: null, completedHideCheckSource: null };
      }
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

  let completedSoundInvestigation: CompletedSoundInvestigation | undefined;
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
        const investigatedSound = drivingSoundEvidence(state);
        if (
          investigatedSound?.sourceId
          && investigatedSound.sourceType !== "player"
        ) {
          completedSoundInvestigation = {
            sourceId: investigatedSound.sourceId,
            sourceType: investigatedSound.sourceType,
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
        next = enterMode({
          ...next,
          searchIndex: 0,
          searchWaypointElapsedSeconds: 0,
          searchHideSpotId: null,
          hideCheckSource: null,
          searchHideChecksCompleted: 0,
          inspectedHideSpotIds: Object.freeze([]),
          memory: {
            lastKnownPosition: null,
            lastSeenAtSeconds: null,
            lastHeardAtSeconds: null,
            lastKnownEvidence: null,
            deferredSoundEvidence: null,
            witnessedHideSpotId: null,
            evidenceTrail: Object.freeze([]),
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
    ...(completedSoundInvestigation ? { completedSoundInvestigation } : {}),
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
      let previous = junction;
      let target = firstStep;
      // Follow a definite branch through a short corridor. Stop at the next
      // decision so a hypothesis never crosses a second unexplained fork.
      for (let depth = 1; depth < 2; depth += 1) {
        const onward = neighbors(level, target)
          .filter((candidate) => pointKey(candidate) !== pointKey(previous));
        if (onward.length !== 1) break;
        previous = target;
        target = onward[0];
      }
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
    left.routeDistance - right.routeDistance
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
      .sort((left, right) => (
        stableIdHash(pointKey(left), seed ^ 0x9e3779b9)
          - stableIdHash(pointKey(right), seed ^ 0x9e3779b9)
        || (distance.get(pointKey(left)) ?? 0) - (distance.get(pointKey(right)) ?? 0)
      ));
    for (const target of fallback) {
      const route = findPath(level, origin, target);
      if (!route.length) continue;
      const junction = route.slice(0, -1).reverse()
        .find((point) => neighbors(level, point).length >= 3)
        ?? origin;
      const previous = route[Math.max(0, route.length - 2)] ?? origin;
      unique.push(Object.freeze({
        target: Object.freeze({ ...target }),
        junction: Object.freeze({ ...junction }),
        routeDistance: route.length - 1,
        branchHeading: Object.freeze(normalizeVector({
          x: target.x - previous.x,
          y: target.y - previous.y,
        })),
        fallback: true,
      }));
      seen.add(pointKey(target));
      if (unique.length >= Math.min(3, limit)) break;
    }
  }
  return Object.freeze(unique.slice(0, limit));
}

function graphSearchWaypoints(level: LevelDefinition, anchor: Point, seed: number): Point[] {
  // The exact, potentially sub-cell evidence point supplies the planted
  // post-scan beat. Broader points are branch hypotheses from the nav graph.
  return [
    { ...anchor },
    ...generateSearchHypotheses(level, anchor, seed).map((hypothesis) => ({ ...hypothesis.target })),
  ];
}

function legacyLocalSearchWaypoints(level: LevelDefinition, anchor: Point, seed: number): Point[] {
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
  return [{ ...anchor }, ...unique];
}

function searchWaypoints(state: ChaserState, level: LevelDefinition, anchor: Point): Point[] {
  const drivingSound = drivingSoundEvidence(state);
  const authoredEnvironmentEvidence = Boolean(
    drivingSound
    && ["environment-decoy", "environment-hazard"].includes(drivingSound.sourceType),
  );
  // Certified visual/footstep routes retain their calibrated local sweep.
  // Player-triggered authored mechanisms opt into the richer branch search,
  // giving the new system depth without silently invalidating ten fair routes.
  return authoredEnvironmentEvidence
    ? graphSearchWaypoints(level, anchor, state.searchSeed)
    : legacyLocalSearchWaypoints(level, anchor, state.searchSeed);
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
      const candidates = searchWaypoints(state, level, state.memory.lastKnownPosition);
      if (!candidates.length) return { ...state.memory.lastKnownPosition };
      const index = state.searchIndex % candidates.length;
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
