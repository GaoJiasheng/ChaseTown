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

/**
 * Pure budget predicate used by both the governor and renderer integration.
 * Omitted shadow counters are permitted while a backend cannot expose a
 * separate shadow pass; supplied counters must still be valid and in budget.
 */
export function renderWorkloadFitsProfile(
  profile: RenderQualityProfile,
  workload: RenderWorkloadSample,
): boolean {
  if (
    !isFiniteNonNegative(workload.visibleTriangles)
    || !isFiniteNonNegative(workload.drawCalls)
    || workload.visibleTriangles > profile.maximumVisibleTriangles
    || workload.drawCalls > profile.maximumDrawCalls
  ) return false;
  if (
    workload.shadowTriangles !== undefined
    && (
      !isFiniteNonNegative(workload.shadowTriangles)
      || workload.shadowTriangles > profile.maximumShadowTriangles
    )
  ) return false;
  if (
    workload.shadowDrawCalls !== undefined
    && (
      !isFiniteNonNegative(workload.shadowDrawCalls)
      || workload.shadowDrawCalls > profile.maximumShadowDrawCalls
    )
  ) return false;
  return true;
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
