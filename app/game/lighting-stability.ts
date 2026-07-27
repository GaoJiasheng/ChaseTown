/**
 * Pure helpers for keeping authored lighting stable while the camera and
 * light pool move. This module intentionally owns no Three.js objects.
 */

export interface LightingVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ShadowMapDimensions {
  readonly width: number;
  readonly height: number;
}

export interface DirectionalShadowSnapOptions {
  /** World-space point the fixed-bearing directional light follows. */
  readonly target: LightingVector3;
  /** Fixed world-space vector from the target to the light. */
  readonly lightOffset: LightingVector3;
  readonly frustumWidth: number;
  readonly frustumHeight: number;
  readonly shadowMapSize: number | ShadowMapDimensions;
  /** Optional camera-up reference; world up is used by default. */
  readonly worldUp?: LightingVector3;
}

export interface DirectionalShadowSnapResult {
  readonly snappedTarget: LightingVector3;
  readonly snappedLightPosition: LightingVector3;
  readonly lightRight: LightingVector3;
  readonly lightUp: LightingVector3;
  readonly lightForward: LightingVector3;
  readonly texelWorldSizeX: number;
  readonly texelWorldSizeY: number;
  readonly lightSpaceX: number;
  readonly lightSpaceY: number;
  readonly snappedLightSpaceX: number;
  readonly snappedLightSpaceY: number;
  readonly worldError: number;
  readonly maximumWorldError: number;
  /** False means one or more invalid inputs were replaced with safe defaults. */
  readonly valid: boolean;
}

export interface StableLightCandidate {
  readonly id: string;
  /** Higher priority always preempts a lower-priority light. */
  readonly priority?: number;
  /** Higher score wins within the same priority tier. */
  readonly score: number;
  readonly enabled?: boolean;
}

export interface StableLightBudgetOptions {
  readonly capacity: number;
  readonly previousSelectedIds?: Iterable<string>;
  /**
   * A previous light keeps its slot until an equal-priority challenger beats
   * its score by strictly more than this margin.
   */
  readonly hysteresisMargin?: number;
}

export interface RankedLightCandidate {
  readonly id: string;
  readonly priority: number;
  readonly score: number;
  readonly effectiveScore: number;
  readonly wasPreviouslySelected: boolean;
}

export interface StableLightBudgetSelection {
  readonly selectedIds: readonly string[];
  readonly rankedCandidates: readonly RankedLightCandidate[];
}

export interface LightBlendOptions {
  /** Exponential approach rate, in inverse seconds. */
  readonly fadeInRate?: number;
  /** Exponential approach rate, in inverse seconds. */
  readonly fadeOutRate?: number;
}

export const DEFAULT_LIGHT_BLEND_OPTIONS = Object.freeze({
  fadeInRate: 11,
  fadeOutRate: 8,
});

export interface StableLightHandoffEntry {
  readonly id: string;
  readonly gain: number;
  /** The gameplay-authored intensity before presentation budgeting. */
  readonly sourceIntensity: number;
  readonly enabled?: boolean;
}

export interface StableLightHandoffTransition {
  readonly outgoingId: string;
  readonly incomingId: string;
  /** Linear transition time. Presentation uses a smoothstep of this value. */
  readonly progress: number;
  readonly outgoingStartGain: number;
  readonly incomingStartGain: number;
}

export interface StableLightHandoffOptions {
  /** Physical shader-visible light capacity, including one transient slot. */
  readonly capacity: number;
  readonly previousSelectedIds?: Iterable<string>;
  readonly desiredSelectedIds?: Iterable<string>;
  readonly previousTransition?: StableLightHandoffTransition | null;
  readonly deltaSeconds: number;
  /** Duration of a spatial A/B overlap handoff. */
  readonly transitionDurationSeconds?: number;
  /** Rate used for non-replacement removals and the capacity-one fallback. */
  readonly fadeOutRate?: number;
  /** Rate used for ordinary admissions and the capacity-one recovery. */
  readonly fadeInRate?: number;
  /**
   * Capacity-one is unable to overlap two spatial sources. It fades the
   * incumbent to a source-weighted energy that the replacement can reproduce,
   * with this gain as its upper target.
   */
  readonly handoffFloor?: number;
  readonly releaseThreshold?: number;
}

export interface StableLightHandoffSample {
  readonly id: string;
  readonly gain: number;
  readonly sourceIntensity: number;
  readonly appliedIntensity: number;
  readonly selected: boolean;
  readonly enabled: boolean;
}

export interface StableLightHandoffResult {
  readonly lights: readonly StableLightHandoffSample[];
  readonly selectedIds: readonly string[];
  readonly admittedIds: readonly string[];
  readonly releasedIds: readonly string[];
  readonly visibleIds: readonly string[];
  /** Backward-compatible aggregate; now source-intensity weighted. */
  readonly totalGain: number;
  readonly previousTotalAppliedIntensity: number;
  readonly totalAppliedIntensity: number;
  readonly appliedIntensityDelta: number;
  readonly transition: StableLightHandoffTransition | null;
}

export const DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS = Object.freeze({
  fadeOutRate: 6,
  fadeInRate: 3.5,
  transitionDurationSeconds: 0.45,
  handoffFloor: 0.9,
  releaseThreshold: 0.002,
});

const VECTOR_EPSILON = 1e-9;
const DEFAULT_OFFSET = Object.freeze({ x: 0, y: 1, z: 0 });
const DEFAULT_WORLD_UP = Object.freeze({ x: 0, y: 1, z: 0 });

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveFiniteOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteVector(
  value: LightingVector3 | undefined,
  fallback: LightingVector3,
): { readonly vector: LightingVector3; readonly valid: boolean } {
  const valid = Boolean(
    value
      && Number.isFinite(value.x)
      && Number.isFinite(value.y)
      && Number.isFinite(value.z),
  );
  return {
    vector: Object.freeze({
      x: finiteOr(value?.x ?? Number.NaN, fallback.x),
      y: finiteOr(value?.y ?? Number.NaN, fallback.y),
      z: finiteOr(value?.z ?? Number.NaN, fallback.z),
    }),
    valid,
  };
}

function length(vector: LightingVector3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalized(
  vector: LightingVector3,
  fallback: LightingVector3,
): { readonly vector: LightingVector3; readonly valid: boolean } {
  const magnitude = length(vector);
  if (!Number.isFinite(magnitude) || magnitude <= VECTOR_EPSILON) {
    return { vector: fallback, valid: false };
  }
  return {
    vector: Object.freeze({
      x: vector.x / magnitude,
      y: vector.y / magnitude,
      z: vector.z / magnitude,
    }),
    valid: true,
  };
}

function dot(left: LightingVector3, right: LightingVector3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(
  left: LightingVector3,
  right: LightingVector3,
): LightingVector3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function add(
  left: LightingVector3,
  right: LightingVector3,
): LightingVector3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function scaled(vector: LightingVector3, scale: number): LightingVector3 {
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function finiteResultVector(
  value: LightingVector3,
  fallback: LightingVector3,
): LightingVector3 {
  return Object.freeze({
    x: finiteOr(value.x, fallback.x),
    y: finiteOr(value.y, fallback.y),
    z: finiteOr(value.z, fallback.z),
  });
}

function leastAlignedCanonicalAxis(direction: LightingVector3): LightingVector3 {
  const candidates = [
    Object.freeze({ x: 1, y: 0, z: 0 }),
    Object.freeze({ x: 0, y: 1, z: 0 }),
    Object.freeze({ x: 0, y: 0, z: 1 }),
  ];
  return candidates.reduce((best, candidate) => (
    Math.abs(dot(direction, candidate)) < Math.abs(dot(direction, best))
      ? candidate
      : best
  ));
}

function snapScalar(value: number, increment: number): number {
  const scaledValue = value / increment;
  if (!Number.isFinite(scaledValue)) return value;
  const snapped = Math.floor(scaledValue + 0.5) * increment;
  return Number.isFinite(snapped) ? snapped : value;
}

/**
 * Snaps a fixed-bearing directional-light anchor to its shadow-map texel grid.
 *
 * Only the light-space right/up translation is quantized. Depth and the
 * target-to-light offset remain unchanged, so the bearing cannot rotate.
 */
export function snapDirectionalShadowAnchor(
  options: DirectionalShadowSnapOptions,
): DirectionalShadowSnapResult {
  const targetInput = finiteVector(options?.target, Object.freeze({ x: 0, y: 0, z: 0 }));
  const offsetInput = finiteVector(options?.lightOffset, DEFAULT_OFFSET);
  const widthValid = Number.isFinite(options?.frustumWidth)
    && options.frustumWidth > 0;
  const heightValid = Number.isFinite(options?.frustumHeight)
    && options.frustumHeight > 0;
  const frustumWidth = positiveFiniteOr(options?.frustumWidth, 1);
  const frustumHeight = positiveFiniteOr(options?.frustumHeight, 1);
  const mapInput = options?.shadowMapSize;
  const rawMapWidth = typeof mapInput === "number" ? mapInput : mapInput?.width;
  const rawMapHeight = typeof mapInput === "number" ? mapInput : mapInput?.height;
  const mapWidthValid = Number.isFinite(rawMapWidth) && (rawMapWidth as number) >= 1;
  const mapHeightValid = Number.isFinite(rawMapHeight) && (rawMapHeight as number) >= 1;
  const mapWidth = Math.max(1, Math.floor(positiveFiniteOr(rawMapWidth ?? Number.NaN, 1)));
  const mapHeight = Math.max(1, Math.floor(positiveFiniteOr(rawMapHeight ?? Number.NaN, 1)));
  const worldUpInput = options?.worldUp
    ? finiteVector(options.worldUp, DEFAULT_WORLD_UP)
    : { vector: DEFAULT_WORLD_UP, valid: true };

  const offsetDirection = normalized(offsetInput.vector, DEFAULT_OFFSET);
  const lightForward = finiteResultVector(
    scaled(offsetDirection.vector, -1),
    Object.freeze({ x: 0, y: -1, z: 0 }),
  );
  let rightResult = normalized(cross(lightForward, worldUpInput.vector), DEFAULT_OFFSET);
  let basisFallbackUsed = !rightResult.valid;
  if (!rightResult.valid) {
    rightResult = normalized(
      cross(lightForward, leastAlignedCanonicalAxis(lightForward)),
      Object.freeze({ x: 1, y: 0, z: 0 }),
    );
  }
  const lightRight = finiteResultVector(
    rightResult.vector,
    Object.freeze({ x: 1, y: 0, z: 0 }),
  );
  const upResult = normalized(
    cross(lightRight, lightForward),
    Object.freeze({ x: 0, y: 0, z: 1 }),
  );
  basisFallbackUsed ||= !upResult.valid;
  const lightUp = finiteResultVector(
    upResult.vector,
    Object.freeze({ x: 0, y: 0, z: 1 }),
  );

  const texelWorldSizeX = frustumWidth / mapWidth;
  const texelWorldSizeY = frustumHeight / mapHeight;
  const lightSpaceX = dot(targetInput.vector, lightRight);
  const lightSpaceY = dot(targetInput.vector, lightUp);
  const snappedLightSpaceX = snapScalar(lightSpaceX, texelWorldSizeX);
  const snappedLightSpaceY = snapScalar(lightSpaceY, texelWorldSizeY);
  const deltaX = snappedLightSpaceX - lightSpaceX;
  const deltaY = snappedLightSpaceY - lightSpaceY;
  const snappedTarget = finiteResultVector(
    add(
      targetInput.vector,
      add(scaled(lightRight, deltaX), scaled(lightUp, deltaY)),
    ),
    targetInput.vector,
  );
  const snappedLightPosition = finiteResultVector(
    add(snappedTarget, offsetInput.vector),
    snappedTarget,
  );
  const worldError = Math.hypot(deltaX, deltaY);

  return Object.freeze({
    snappedTarget,
    snappedLightPosition,
    lightRight,
    lightUp,
    lightForward,
    texelWorldSizeX,
    texelWorldSizeY,
    lightSpaceX,
    lightSpaceY,
    snappedLightSpaceX,
    snappedLightSpaceY,
    worldError: finiteOr(worldError, 0),
    maximumWorldError: Math.hypot(texelWorldSizeX, texelWorldSizeY) / 2,
    valid: targetInput.valid
      && offsetInput.valid
      && offsetDirection.valid
      && widthValid
      && heightValid
      && mapWidthValid
      && mapHeightValid
      && worldUpInput.valid
      && !basisFallbackUsed,
  });
}

function canonicalPreviousIds(
  previousSelectedIds: Iterable<string> | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!previousSelectedIds) return ids;
  try {
    for (const id of previousSelectedIds) {
      if (typeof id === "string" && id.trim()) ids.add(id);
    }
  } catch {
    return new Set<string>();
  }
  return ids;
}

function betterDuplicate(
  candidate: RankedLightCandidate,
  current: RankedLightCandidate,
): boolean {
  if (candidate.priority !== current.priority) {
    return candidate.priority > current.priority;
  }
  if (candidate.score !== current.score) return candidate.score > current.score;
  return false;
}

function compareRankedLights(
  left: RankedLightCandidate,
  right: RankedLightCandidate,
): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.effectiveScore !== right.effectiveScore) {
    return right.effectiveScore - left.effectiveScore;
  }
  if (left.wasPreviouslySelected !== right.wasPreviouslySelected) {
    return left.wasPreviouslySelected ? -1 : 1;
  }
  if (left.score !== right.score) return right.score - left.score;
  return left.id.localeCompare(right.id);
}

/**
 * Selects a deterministic, hysteresis-stable subset of pooled lights.
 */
export function selectStableLightBudget(
  candidates: readonly StableLightCandidate[] | null | undefined,
  options: StableLightBudgetOptions,
): StableLightBudgetSelection {
  const rawCapacity = options?.capacity;
  const capacity = Number.isFinite(rawCapacity)
    ? Math.max(0, Math.floor(rawCapacity))
    : 0;
  const rawMargin = options?.hysteresisMargin;
  const hysteresisMargin = Number.isFinite(rawMargin) && (rawMargin as number) >= 0
    ? rawMargin as number
    : 0;
  const previousIds = canonicalPreviousIds(options?.previousSelectedIds);
  if (capacity === 0 || !Array.isArray(candidates) || candidates.length === 0) {
    return Object.freeze({
      selectedIds: Object.freeze([]),
      rankedCandidates: Object.freeze([]),
    });
  }

  const byId = new Map<string, RankedLightCandidate>();
  for (const candidate of candidates) {
    if (
      !candidate
      || candidate.enabled === false
      || typeof candidate.id !== "string"
      || !candidate.id.trim()
      || !Number.isFinite(candidate.score)
    ) {
      continue;
    }
    const priority = finiteOr(candidate.priority ?? 0, 0);
    const wasPreviouslySelected = previousIds.has(candidate.id);
    const score = candidate.score;
    const effectiveScore = score + (wasPreviouslySelected ? hysteresisMargin : 0);
    if (!Number.isFinite(effectiveScore)) continue;
    const ranked = Object.freeze({
      id: candidate.id,
      priority,
      score,
      effectiveScore,
      wasPreviouslySelected,
    });
    const current = byId.get(ranked.id);
    if (!current || betterDuplicate(ranked, current)) byId.set(ranked.id, ranked);
  }

  const rankedCandidates = Object.freeze(
    [...byId.values()].sort(compareRankedLights),
  );
  return Object.freeze({
    selectedIds: Object.freeze(
      rankedCandidates.slice(0, capacity).map(({ id }) => id),
    ),
    rankedCandidates,
  });
}

function boundedGain(gain: number): number {
  if (!Number.isFinite(gain)) return 0;
  return Math.min(1, Math.max(0, gain));
}

/**
 * Canonicalizes one explicit authored-light write.
 *
 * Callers deliberately overwrite their stored source value with this result;
 * they must not compare the write with the currently presented (budgeted)
 * intensity. In particular, an explicit zero remains authoritative even when
 * the presentation layer had already reduced that light to zero.
 */
export function sanitizeAuthoredLightIntensity(intensity: number): number {
  return Number.isFinite(intensity) ? Math.max(0, intensity) : 0;
}

/**
 * Advances a selected/unselected light gain using exponential smoothing.
 * The result is frame-rate independent for a constant target and rate.
 */
export function advanceLightBlendGain(
  currentGain: number,
  selected: boolean,
  deltaSeconds: number,
  options: LightBlendOptions = DEFAULT_LIGHT_BLEND_OPTIONS,
): number {
  const current = boundedGain(currentGain);
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return current;
  const rawRate = selected
    ? options.fadeInRate ?? DEFAULT_LIGHT_BLEND_OPTIONS.fadeInRate
    : options.fadeOutRate ?? DEFAULT_LIGHT_BLEND_OPTIONS.fadeOutRate;
  if (!Number.isFinite(rawRate) || rawRate <= 0) return current;
  const target = selected ? 1 : 0;
  const alpha = 1 - Math.exp(-rawRate * deltaSeconds);
  const next = current + (target - current) * alpha;
  return boundedGain(next);
}

/**
 * Keeps one physical light slot available for a spatially continuous A/B
 * handoff. A physical capacity of one cannot reserve a slot.
 */
export function steadyLightCapacityForPhysicalCapacity(
  physicalCapacity: number,
): number {
  const capacity = Number.isFinite(physicalCapacity)
    ? Math.max(0, Math.floor(physicalCapacity))
    : 0;
  return capacity > 1 ? capacity - 1 : capacity;
}

function smoothstep01(value: number): number {
  const bounded = boundedGain(value);
  return bounded * bounded * (3 - 2 * bounded);
}

/**
 * Advances a capacity-bound light set with a persistent, multi-frame spatial
 * crossfade. The caller gives steady-state desired IDs but reserves one
 * physical slot through `steadyLightCapacityForPhysicalCapacity`; therefore an
 * incumbent and its replacement can overlap without exceeding the shader cap.
 *
 * When the physical capacity is one, overlap is impossible. That emergency
 * path first fades the incumbent to an intensity the incoming source can
 * reproduce, transfers equal applied energy on the swap frame, then recovers
 * gradually. It never inserts an empty frame.
 */
export function advanceStableLightHandoff(
  entries: readonly StableLightHandoffEntry[] | null | undefined,
  options: StableLightHandoffOptions,
): StableLightHandoffResult {
  const rawCapacity = options?.capacity;
  const capacity = Number.isFinite(rawCapacity)
    ? Math.max(0, Math.floor(rawCapacity))
    : 0;
  const rawFadeOutRate = options?.fadeOutRate;
  const fadeOutRate = Number.isFinite(rawFadeOutRate) && (rawFadeOutRate as number) > 0
    ? rawFadeOutRate as number
    : DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS.fadeOutRate;
  const rawFadeInRate = options?.fadeInRate;
  const fadeInRate = Number.isFinite(rawFadeInRate) && (rawFadeInRate as number) > 0
    ? rawFadeInRate as number
    : DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS.fadeInRate;
  const rawTransitionDuration = options?.transitionDurationSeconds;
  const transitionDurationSeconds = (
    Number.isFinite(rawTransitionDuration)
    && (rawTransitionDuration as number) > 0
  )
    ? rawTransitionDuration as number
    : DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS.transitionDurationSeconds;
  const rawReleaseThreshold = options?.releaseThreshold;
  const releaseThreshold = Number.isFinite(rawReleaseThreshold)
    ? Math.min(0.25, Math.max(0, rawReleaseThreshold as number))
    : DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS.releaseThreshold;
  const rawHandoffFloor = options?.handoffFloor;
  const handoffFloor = Number.isFinite(rawHandoffFloor)
    ? Math.min(1, Math.max(releaseThreshold, rawHandoffFloor as number))
    : DEFAULT_STABLE_LIGHT_HANDOFF_OPTIONS.handoffFloor;

  const byId = new Map<string, {
    readonly id: string;
    readonly enabled: boolean;
    readonly sourceIntensity: number;
    gain: number;
  }>();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (
        !entry
        || typeof entry.id !== "string"
        || !entry.id.trim()
        || byId.has(entry.id)
      ) continue;
      const sourceIntensity = sanitizeAuthoredLightIntensity(
        entry.sourceIntensity,
      );
      byId.set(entry.id, {
        id: entry.id,
        enabled: entry.enabled !== false && sourceIntensity > 1e-4,
        sourceIntensity,
        gain: boundedGain(entry.gain),
      });
    }
  }

  const previousTotalAppliedIntensity = [...byId.values()].reduce(
    (total, entry) => total + (
      entry.enabled ? entry.sourceIntensity * entry.gain : 0
    ),
    0,
  );
  const steadyCapacity = steadyLightCapacityForPhysicalCapacity(capacity);
  const desiredIds = [...canonicalPreviousIds(options?.desiredSelectedIds)]
    .filter((id) => byId.get(id)?.enabled)
    .slice(0, steadyCapacity);
  const desiredSet = new Set(desiredIds);
  const selected = new Set(
    [...canonicalPreviousIds(options?.previousSelectedIds)]
      .filter((id) => byId.has(id)),
  );
  const admittedIds: string[] = [];
  const releasedIds: string[] = [];
  const admit = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    if (!admittedIds.includes(id)) admittedIds.push(id);
  };
  const release = (id: string) => {
    const entry = byId.get(id);
    if (entry) entry.gain = 0;
    if (!selected.delete(id)) return;
    if (!releasedIds.includes(id)) releasedIds.push(id);
  };
  const deltaSeconds = (
    Number.isFinite(options?.deltaSeconds)
    && options.deltaSeconds > 0
  )
    ? options.deltaSeconds
    : 0;
  let transition: StableLightHandoffTransition | null = null;
  const protectedThisFrame = new Set<string>();

  if (capacity === 0) {
    for (const id of [...selected]) release(id);
  } else if (capacity === 1) {
    // A cap change can arrive while two overlap sources are resident. Preserve
    // the desired source when possible; otherwise retain the strongest applied
    // incumbent and hand it off through the source-weighted fallback.
    const desiredId = desiredIds[0];
    const retainedId = desiredId && selected.has(desiredId)
      ? desiredId
      : [...selected]
          .filter((id) => byId.get(id)?.enabled)
          .sort((left, right) => {
            const leftEntry = byId.get(left);
            const rightEntry = byId.get(right);
            return (
              (rightEntry?.sourceIntensity ?? 0) * (rightEntry?.gain ?? 0)
              - (leftEntry?.sourceIntensity ?? 0) * (leftEntry?.gain ?? 0)
            );
          })[0];
    for (const id of [...selected]) {
      if (id !== retainedId) release(id);
    }

    let residentId: string | undefined = retainedId || undefined;
    const resident = residentId ? byId.get(residentId) : undefined;
    if (residentId && !resident?.enabled) {
      release(residentId);
      residentId = undefined;
    }

    if (!residentId) {
      if (desiredId) {
        const incoming = byId.get(desiredId);
        if (incoming?.enabled) {
          incoming.gain = Math.max(incoming.gain, handoffFloor);
          admit(desiredId);
          protectedThisFrame.add(desiredId);
        }
      }
    } else if (!desiredId) {
      const outgoing = byId.get(residentId);
      if (outgoing) {
        outgoing.gain = advanceLightBlendGain(
          outgoing.gain,
          false,
          deltaSeconds,
          { fadeInRate, fadeOutRate },
        );
        if (outgoing.gain <= releaseThreshold) release(residentId);
        else protectedThisFrame.add(residentId);
      }
    } else if (residentId !== desiredId) {
      const outgoing = byId.get(residentId);
      const incoming = byId.get(desiredId);
      if (!outgoing?.enabled) {
        release(residentId);
        if (incoming?.enabled) {
          incoming.gain = Math.max(incoming.gain, handoffFloor);
          admit(desiredId);
          protectedThisFrame.add(desiredId);
        }
      } else if (incoming?.enabled) {
        // Match the lower of the two authored intensities at the handoff
        // floor. Thus incomingGain is never above the floor and the swap frame
        // exactly preserves sourceIntensity * gain.
        const targetOutgoingGain = Math.max(
          releaseThreshold,
          handoffFloor * Math.min(
            1,
            incoming.sourceIntensity / outgoing.sourceIntensity,
          ),
        );
        if (outgoing.gain <= targetOutgoingGain + 1e-9) {
          const transferredEnergy = outgoing.sourceIntensity * outgoing.gain;
          const incomingGain = boundedGain(
            transferredEnergy / incoming.sourceIntensity,
          );
          release(residentId);
          incoming.gain = Math.max(incomingGain, releaseThreshold);
          admit(desiredId);
          protectedThisFrame.add(desiredId);
        } else {
          outgoing.gain = Math.max(
            targetOutgoingGain,
            advanceLightBlendGain(
              outgoing.gain,
              false,
              deltaSeconds,
              { fadeInRate, fadeOutRate },
            ),
          );
          protectedThisFrame.add(residentId);
        }
      }
    } else if (resident) {
      resident.gain = advanceLightBlendGain(
        resident.gain,
        true,
        deltaSeconds,
        { fadeInRate, fadeOutRate },
      );
      if (resident.gain >= 1 - releaseThreshold) resident.gain = 1;
      protectedThisFrame.add(residentId);
    }
  } else {
    const previousTransition = options?.previousTransition;
    if (
      previousTransition
      && typeof previousTransition.outgoingId === "string"
      && typeof previousTransition.incomingId === "string"
      && previousTransition.outgoingId !== previousTransition.incomingId
      && selected.has(previousTransition.outgoingId)
      && selected.has(previousTransition.incomingId)
    ) {
      const outgoing = byId.get(previousTransition.outgoingId);
      const incoming = byId.get(previousTransition.incomingId);
      if (outgoing?.enabled && incoming?.enabled) {
        transition = {
          outgoingId: previousTransition.outgoingId,
          incomingId: previousTransition.incomingId,
          progress: boundedGain(previousTransition.progress),
          outgoingStartGain: boundedGain(
            previousTransition.outgoingStartGain,
          ),
          incomingStartGain: boundedGain(
            previousTransition.incomingStartGain,
          ),
        };
      } else if (!outgoing?.enabled) {
        release(previousTransition.outgoingId);
      } else if (!incoming?.enabled) {
        release(previousTransition.incomingId);
      }
    }

    // Physical quality can shrink while a transition is live. Retain desired
    // residents first, then the transition pair, then the strongest remaining
    // sources. This branch is a cap-safety repair, not a normal handoff.
    if (selected.size > capacity) {
      const transitionPreference = transition
        ? [transition.incomingId, transition.outgoingId]
        : [];
      const retentionOrder = [
        ...desiredIds.filter((id) => selected.has(id)),
        ...transitionPreference.filter((id) => selected.has(id)),
        ...[...selected].sort((left, right) => {
          const leftEntry = byId.get(left);
          const rightEntry = byId.get(right);
          return (
            (rightEntry?.sourceIntensity ?? 0) * (rightEntry?.gain ?? 0)
            - (leftEntry?.sourceIntensity ?? 0) * (leftEntry?.gain ?? 0)
          );
        }),
      ];
      const retained = new Set(retentionOrder.slice(0, capacity));
      for (const id of [...selected]) {
        if (!retained.has(id)) release(id);
      }
      if (
        transition
        && (
          !selected.has(transition.outgoingId)
          || !selected.has(transition.incomingId)
        )
      ) transition = null;
    }

    // Explicit authored-off writes are authoritative. They may interrupt a
    // fade, but they cannot leave a stale selected light behind.
    for (const id of [...selected]) {
      if (!byId.get(id)?.enabled) release(id);
    }
    if (
      transition
      && (
        !selected.has(transition.outgoingId)
        || !selected.has(transition.incomingId)
      )
    ) transition = null;

    const pendingDesiredIds = () => desiredIds.filter(
      (id) => !selected.has(id),
    );
    if (!transition) {
      const incomingId = pendingDesiredIds()[0];
      const outgoingId = [...selected].find((id) => !desiredSet.has(id));
      if (incomingId && outgoingId && selected.size < capacity) {
        const outgoing = byId.get(outgoingId);
        const incoming = byId.get(incomingId);
        if (outgoing?.enabled && incoming?.enabled) {
          incoming.gain = 0;
          admit(incomingId);
          transition = {
            outgoingId,
            incomingId,
            progress: 0,
            outgoingStartGain: outgoing.gain,
            incomingStartGain: incoming.gain,
          };
        }
      }
    }

    if (transition) {
      const outgoing = byId.get(transition.outgoingId);
      const incoming = byId.get(transition.incomingId);
      if (outgoing?.enabled && incoming?.enabled) {
        const progress = boundedGain(
          transition.progress + deltaSeconds / transitionDurationSeconds,
        );
        const mix = smoothstep01(progress);
        outgoing.gain = boundedGain(
          transition.outgoingStartGain * (1 - mix),
        );
        incoming.gain = boundedGain(
          transition.incomingStartGain
          + (1 - transition.incomingStartGain) * mix,
        );
        protectedThisFrame.add(outgoing.id);
        protectedThisFrame.add(incoming.id);
        if (progress >= 1) {
          release(outgoing.id);
          incoming.gain = 1;
          protectedThisFrame.add(incoming.id);
          transition = null;
        } else {
          transition = {
            ...transition,
            progress,
          };
        }
      } else {
        transition = null;
      }
    }

    const pendingAfterTransition = desiredIds.some(
      (id) => !selected.has(id),
    );
    for (const id of [...selected]) {
      if (protectedThisFrame.has(id)) continue;
      const entry = byId.get(id);
      if (!entry?.enabled) {
        release(id);
        continue;
      }
      if (desiredSet.has(id)) {
        entry.gain = advanceLightBlendGain(
          entry.gain,
          true,
          deltaSeconds,
          { fadeInRate, fadeOutRate },
        );
        if (entry.gain >= 1 - releaseThreshold) entry.gain = 1;
      } else if (!pendingAfterTransition) {
        entry.gain = advanceLightBlendGain(
          entry.gain,
          false,
          deltaSeconds,
          { fadeInRate, fadeOutRate },
        );
        if (entry.gain <= releaseThreshold) release(id);
      }
      // When another desired replacement is queued, hold this incumbent at
      // full continuity until the single transient slot becomes available.
    }

    if (!transition && ![...selected].some((id) => !desiredSet.has(id))) {
      for (const desiredId of desiredIds) {
        if (selected.size >= steadyCapacity) break;
        if (selected.has(desiredId)) continue;
        const entry = byId.get(desiredId);
        if (!entry?.enabled) continue;
        entry.gain = advanceLightBlendGain(
          entry.gain,
          true,
          deltaSeconds,
          { fadeInRate, fadeOutRate },
        );
        admit(desiredId);
      }
    }
  }

  // Non-residents never retain a presentation tail: the selected set is the
  // single authority for the physical visible-light cap.
  for (const entry of byId.values()) {
    if (!selected.has(entry.id)) entry.gain = 0;
  }

  const lights = Object.freeze([...byId.values()].map((entry) => Object.freeze({
    id: entry.id,
    gain: entry.gain,
    sourceIntensity: entry.sourceIntensity,
    appliedIntensity: entry.enabled
      ? entry.sourceIntensity * entry.gain
      : 0,
    selected: selected.has(entry.id),
    enabled: entry.enabled,
  })));
  const visibleIds = Object.freeze(
    lights
      .filter(({ enabled, gain }) => enabled && gain > releaseThreshold)
      .map(({ id }) => id),
  );
  const totalAppliedIntensity = lights.reduce(
    (total, { appliedIntensity }) => total + appliedIntensity,
    0,
  );
  return Object.freeze({
    lights,
    selectedIds: Object.freeze([...selected]),
    admittedIds: Object.freeze(admittedIds),
    releasedIds: Object.freeze(releasedIds),
    visibleIds,
    totalGain: totalAppliedIntensity,
    previousTotalAppliedIntensity,
    totalAppliedIntensity,
    appliedIntensityDelta: totalAppliedIntensity
      - previousTotalAppliedIntensity,
    transition: transition ? Object.freeze(transition) : null,
  });
}
