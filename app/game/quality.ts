export type RenderQualityTier = "high" | "balanced" | "mobile";

export interface RenderQualityProfile {
  readonly tier: RenderQualityTier;
  readonly maximumPixelRatio: number;
  readonly shadowMapSize: 1024 | 2048;
  readonly occlusionProbeSeconds: number;
  readonly atmosphericParticleScale: number;
  readonly maximumDynamicLights: number;
}

export interface DeviceQualityHints {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly devicePixelRatio: number;
  readonly coarsePointer: boolean;
  readonly deviceMemoryGb?: number;
  readonly hardwareConcurrency?: number;
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
    }),
    balanced: Object.freeze({
      tier: "balanced",
      maximumPixelRatio: 1.25,
      shadowMapSize: 1024,
      occlusionProbeSeconds: 0.1,
      atmosphericParticleScale: 0.72,
      maximumDynamicLights: 4,
    }),
    mobile: Object.freeze({
      tier: "mobile",
      maximumPixelRatio: 1,
      shadowMapSize: 1024,
      occlusionProbeSeconds: 0.14,
      atmosphericParticleScale: 0.45,
      maximumDynamicLights: 3,
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

/**
 * Hysteretic quality decision evaluated on a rolling p95 frame time. A
 * downgrade reacts to sustained missed frames; an upgrade is deliberately
 * slower so resolution never chatters during a chase.
 */
export function nextRenderQuality(
  current: RenderQualityTier,
  p95FrameMilliseconds: number,
  stableSeconds: number,
): RenderQualityTier {
  if (!Number.isFinite(p95FrameMilliseconds) || p95FrameMilliseconds <= 0) return current;
  const index = QUALITY_ORDER.indexOf(current);
  const overloadThreshold = current === "high" ? 18.5 : current === "balanced" ? 25 : 35;
  if (p95FrameMilliseconds > overloadThreshold && stableSeconds >= 2.5 && index > 0) {
    return QUALITY_ORDER[index - 1];
  }
  const headroomThreshold = current === "mobile" ? 18 : 15;
  if (
    p95FrameMilliseconds < headroomThreshold
    && stableSeconds >= 12
    && index < QUALITY_ORDER.length - 1
  ) return QUALITY_ORDER[index + 1];
  return current;
}

