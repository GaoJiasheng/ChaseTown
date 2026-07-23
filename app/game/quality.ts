export type RenderQualityTier = "high" | "balanced" | "mobile";

export interface RenderQualityProfile {
  readonly tier: RenderQualityTier;
  readonly maximumPixelRatio: number;
  readonly shadowMapSize: 1024 | 2048;
  readonly occlusionProbeSeconds: number;
  readonly atmosphericParticleScale: number;
  readonly maximumDynamicLights: number;
  /** Main colour pass budget after LOD and decorative distance culling. */
  readonly maximumVisibleTriangles: number;
  /** Total frame submissions as reported by WebGLRenderer.info.render.calls. */
  readonly maximumDrawCalls: number;
  /** Shadow-only geometry budget for the active key light. */
  readonly maximumShadowTriangles: number;
  /** Shadow-map submissions for the active key light. */
  readonly maximumShadowDrawCalls: number;
  /** Whether authored static architecture may render into the live shadow map. */
  readonly staticEnvironmentShadows: boolean;
  /** Maximum player-relative distance at which non-gameplay dressing stays visible. */
  readonly decorativeDistanceMeters: number;
}

export interface DeviceQualityHints {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
  readonly coarsePointer: boolean;
  readonly deviceMemoryGb?: number;
  readonly hardwareConcurrency?: number;
}

export interface RenderWorkloadSample {
  readonly visibleTriangles: number;
  readonly drawCalls: number;
  readonly shadowTriangles?: number;
  readonly shadowDrawCalls?: number;
}

export type RenderBudgetMetric =
  | "visibleTriangles"
  | "drawCalls"
  | "shadowTriangles"
  | "shadowDrawCalls";

export interface RenderBudgetUtilization {
  readonly visibleTriangles: number;
  readonly drawCalls: number;
  readonly shadowTriangles?: number;
  readonly shadowDrawCalls?: number;
  /** Largest supplied workload-to-budget ratio. Invalid counters report Infinity. */
  readonly peak: number;
  readonly exceeded: readonly RenderBudgetMetric[];
}

export type EmergencyDegradationLevel = 0 | 1 | 2 | 3;

export interface EmergencyDegradationState {
  readonly level: EmergencyDegradationLevel;
  readonly overloadSeconds: number;
  readonly recoverySeconds: number;
}

export interface EmergencyDegradationInput {
  readonly tier: RenderQualityTier;
  readonly p95FrameMilliseconds: number;
  readonly elapsedSeconds: number;
  readonly workload: RenderWorkloadSample;
}

export interface EmergencyRenderPolicy {
  readonly level: EmergencyDegradationLevel;
  /** Added to a decorative object's normal full/reduced/impostor LOD index. */
  readonly decorativeLodBias: 0 | 1 | 2 | 3;
  /** Applied before the profile's decorativeDistanceMeters cutoff. */
  readonly decorativeDistanceScale: number;
  /** Applied after the profile's authored atmosphericParticleScale. */
  readonly atmosphericParticleScale: number;
  readonly dynamicLightScale: number;
  readonly shadowCasterMode:
    | "profile"
    | "critical-and-near"
    | "critical-only"
    | "characters-only";
  readonly hideOptionalDecorations: boolean;
  readonly disableExpensivePostEffects: boolean;
}

export const RENDER_QUALITY_PROFILES: Readonly<Record<RenderQualityTier, RenderQualityProfile>> =
  Object.freeze({
    high: Object.freeze({
      tier: "high",
      maximumPixelRatio: 1.5,
      shadowMapSize: 2048,
      occlusionProbeSeconds: 0.075,
      atmosphericParticleScale: 1,
      maximumDynamicLights: 5,
      maximumVisibleTriangles: 2_600_000,
      maximumDrawCalls: 650,
      maximumShadowTriangles: 1_500_000,
      maximumShadowDrawCalls: 300,
      staticEnvironmentShadows: true,
      decorativeDistanceMeters: 90,
    }),
    balanced: Object.freeze({
      tier: "balanced",
      maximumPixelRatio: 1.25,
      shadowMapSize: 1024,
      occlusionProbeSeconds: 0.1,
      atmosphericParticleScale: 0.72,
      maximumDynamicLights: 4,
      maximumVisibleTriangles: 1_500_000,
      maximumDrawCalls: 400,
      maximumShadowTriangles: 500_000,
      maximumShadowDrawCalls: 120,
      staticEnvironmentShadows: false,
      decorativeDistanceMeters: 56,
    }),
    mobile: Object.freeze({
      tier: "mobile",
      maximumPixelRatio: 1,
      shadowMapSize: 1024,
      occlusionProbeSeconds: 0.14,
      atmosphericParticleScale: 0.45,
      maximumDynamicLights: 3,
      maximumVisibleTriangles: 900_000,
      maximumDrawCalls: 250,
      maximumShadowTriangles: 360_000,
      maximumShadowDrawCalls: 70,
      staticEnvironmentShadows: false,
      decorativeDistanceMeters: 36,
    }),
  });

export const INITIAL_EMERGENCY_DEGRADATION_STATE: EmergencyDegradationState =
  Object.freeze({
    level: 0,
    overloadSeconds: 0,
    recoverySeconds: 0,
  });

export const EMERGENCY_RENDER_POLICIES: Readonly<
  Record<EmergencyDegradationLevel, EmergencyRenderPolicy>
> = Object.freeze({
  0: Object.freeze({
    level: 0,
    decorativeLodBias: 0,
    decorativeDistanceScale: 1,
    atmosphericParticleScale: 1,
    dynamicLightScale: 1,
    shadowCasterMode: "profile",
    hideOptionalDecorations: false,
    disableExpensivePostEffects: false,
  }),
  1: Object.freeze({
    level: 1,
    decorativeLodBias: 1,
    decorativeDistanceScale: 0.82,
    atmosphericParticleScale: 0.72,
    dynamicLightScale: 0.8,
    shadowCasterMode: "critical-and-near",
    hideOptionalDecorations: false,
    disableExpensivePostEffects: false,
  }),
  2: Object.freeze({
    level: 2,
    decorativeLodBias: 2,
    decorativeDistanceScale: 0.64,
    atmosphericParticleScale: 0.42,
    dynamicLightScale: 0.6,
    shadowCasterMode: "critical-only",
    hideOptionalDecorations: false,
    disableExpensivePostEffects: true,
  }),
  3: Object.freeze({
    level: 3,
    decorativeLodBias: 3,
    decorativeDistanceScale: 0.48,
    atmosphericParticleScale: 0.2,
    dynamicLightScale: 0.4,
    shadowCasterMode: "characters-only",
    hideOptionalDecorations: true,
    disableExpensivePostEffects: true,
  }),
});

/**
 * Pick a conservative first frame without permanently penalising capable
 * phones. The runtime governor may still move one tier in either direction
 * after observing real frame cost.
 */
export function selectInitialRenderQuality(hints: DeviceQualityHints): RenderQualityTier {
  const shortestSide = Math.min(
    Number.isFinite(hints.viewportWidth) ? hints.viewportWidth : 0,
    Number.isFinite(hints.viewportHeight) ? hints.viewportHeight : 0,
  );
  const memory = hints.deviceMemoryGb ?? 8;
  const cores = hints.hardwareConcurrency ?? 8;
  if (
    shortestSide > 0
    && (
      memory <= 4
      || cores <= 4
      || (hints.coarsePointer && hints.devicePixelRatio >= 2.5)
      || (hints.coarsePointer && shortestSide <= 430)
    )
  ) return "mobile";
  if (
    hints.coarsePointer
    || memory <= 8
    || cores <= 6
    || shortestSide <= 820
  ) return "balanced";
  return "high";
}

const QUALITY_ORDER: readonly RenderQualityTier[] = ["mobile", "balanced", "high"];
const DOWNGRADE_HOLD_SECONDS = 2.5;
const UPGRADE_HOLD_SECONDS = 12;

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function budgetRatio(value: number | undefined, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNonNegative(value)) return Number.POSITIVE_INFINITY;
  return value / maximum;
}

/**
 * Detailed counterpart to renderWorkloadFitsProfile(). Keeping shadow pass
 * counters separate is important: a cheap colour pass can still be dominated
 * by one oversized realtime shadow map.
 */
export function renderBudgetUtilization(
  profile: RenderQualityProfile,
  workload: RenderWorkloadSample,
): RenderBudgetUtilization {
  const values = {
    visibleTriangles: budgetRatio(
      workload.visibleTriangles,
      profile.maximumVisibleTriangles,
    )!,
    drawCalls: budgetRatio(workload.drawCalls, profile.maximumDrawCalls)!,
    shadowTriangles: budgetRatio(
      workload.shadowTriangles,
      profile.maximumShadowTriangles,
    ),
    shadowDrawCalls: budgetRatio(
      workload.shadowDrawCalls,
      profile.maximumShadowDrawCalls,
    ),
  };
  const exceeded = (Object.entries(values) as Array<
    [RenderBudgetMetric, number | undefined]
  >)
    .filter(([, value]) => value !== undefined && value > 1)
    .map(([metric]) => metric);
  const suppliedRatios = Object.values(values)
    .filter((value): value is number => value !== undefined);
  return Object.freeze({
    ...values,
    peak: Math.max(...suppliedRatios),
    exceeded: Object.freeze(exceeded),
  });
}

/**
 * Pure budget predicate used by both the governor and renderer integration.
 * Omitted shadow counters are permitted while a backend cannot expose a
 * separate shadow pass; supplied counters must still be valid and in budget.
 */
export function renderWorkloadFitsProfile(
  profile: RenderQualityProfile,
  workload: RenderWorkloadSample,
): boolean {
  return renderBudgetUtilization(profile, workload).exceeded.length === 0;
}

function emergencyLevel(value: number): EmergencyDegradationLevel {
  return Math.min(3, Math.max(0, Math.floor(value))) as EmergencyDegradationLevel;
}

/**
 * Mobile is already the lowest quality tier, so a sustained overload there
 * needs a second, independently hysteretic safety valve. This state machine
 * escalates one step at a time and only recovers with durable 20% workload
 * headroom. Gameplay-critical renderables are protected by
 * resolveRuntimeObjectPolicy() in runtime-visibility.ts.
 */
export function updateEmergencyDegradation(
  current: EmergencyDegradationState,
  input: EmergencyDegradationInput,
): EmergencyDegradationState {
  if (
    input.tier !== "mobile"
    || !Number.isFinite(input.elapsedSeconds)
    || input.elapsedSeconds <= 0
  ) return input.tier === "mobile" ? current : INITIAL_EMERGENCY_DEGRADATION_STATE;

  const profile = RENDER_QUALITY_PROFILES.mobile;
  const utilization = renderBudgetUtilization(profile, input.workload);
  const validFrameTime = Number.isFinite(input.p95FrameMilliseconds)
    && input.p95FrameMilliseconds > 0;
  const overloaded = utilization.peak > 1
    || (validFrameTime && input.p95FrameMilliseconds > 35);
  const durableHeadroom = utilization.peak <= 0.8
    && validFrameTime
    && input.p95FrameMilliseconds < 24;

  if (overloaded) {
    const overloadSeconds = Math.max(0, current.overloadSeconds) + input.elapsedSeconds;
    const activationSeconds = current.level === 0 ? 1.5 : 2.5;
    if (overloadSeconds >= activationSeconds && current.level < 3) {
      return Object.freeze({
        level: emergencyLevel(current.level + 1),
        overloadSeconds: 0,
        recoverySeconds: 0,
      });
    }
    return Object.freeze({
      level: current.level,
      overloadSeconds,
      recoverySeconds: 0,
    });
  }

  if (durableHeadroom && current.level > 0) {
    const recoverySeconds = Math.max(0, current.recoverySeconds) + input.elapsedSeconds;
    if (recoverySeconds >= 10) {
      return Object.freeze({
        level: emergencyLevel(current.level - 1),
        overloadSeconds: 0,
        recoverySeconds: 0,
      });
    }
    return Object.freeze({
      level: current.level,
      overloadSeconds: 0,
      recoverySeconds,
    });
  }

  return Object.freeze({
    level: current.level,
    overloadSeconds: 0,
    recoverySeconds: 0,
  });
}

/**
 * Hysteretic quality decision evaluated on a rolling p95 frame time. A
 * downgrade reacts to sustained missed frames; an upgrade is deliberately
 * slower so resolution never chatters during a chase.
 */
export function nextRenderQuality(
  current: RenderQualityTier,
  p95FrameMilliseconds: number,
  stableSeconds: number,
  workload?: RenderWorkloadSample,
): RenderQualityTier {
  if (!Number.isFinite(p95FrameMilliseconds) || p95FrameMilliseconds <= 0) return current;
  const index = QUALITY_ORDER.indexOf(current);
  const overloadThreshold = current === "high" ? 18.5 : current === "balanced" ? 25 : 35;
  const workloadFits = workload
    ? renderWorkloadFitsProfile(RENDER_QUALITY_PROFILES[current], workload)
    : true;
  if (
    (p95FrameMilliseconds > overloadThreshold || !workloadFits)
    && stableSeconds >= DOWNGRADE_HOLD_SECONDS
    && index > 0
  ) {
    return QUALITY_ORDER[index - 1];
  }
  const headroomThreshold = current === "mobile" ? 18 : 15;
  if (
    p95FrameMilliseconds < headroomThreshold
    && workloadFits
    && stableSeconds >= UPGRADE_HOLD_SECONDS
    && index < QUALITY_ORDER.length - 1
  ) return QUALITY_ORDER[index + 1];
  return current;
}
