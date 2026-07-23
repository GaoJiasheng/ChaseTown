import {
  EMERGENCY_RENDER_POLICIES,
  type EmergencyDegradationLevel,
  type EmergencyRenderPolicy,
  type RenderQualityProfile,
} from "./quality.ts";

export type RuntimeRenderableRole =
  | "player"
  | "chaser"
  | "locker"
  | "objective"
  | "navigation"
  | "architecture"
  | "decoration"
  | "atmosphere";

export type DecorationLod = "full" | "reduced" | "impostor" | "culled";

export interface DecorationLodThresholds {
  readonly fullDistanceMeters: number;
  readonly reducedDistanceMeters: number;
  readonly maximumDistanceMeters: number;
  readonly hysteresisMeters: number;
}

export interface RuntimeRoomVisibility {
  /**
   * Current room plus portal-visible/adjacent rooms. An empty list means the
   * scene has no authored room graph and therefore must not be room-culled.
   */
  readonly visibleRoomIds: readonly string[];
  /**
   * Rooms allowed to remain for one portal transition when an object was
   * visible last frame. This prevents whole-room flashing at thresholds.
   */
  readonly retainedRoomIds?: readonly string[];
}

export interface RuntimeVisibilityCandidate {
  readonly role: RuntimeRenderableRole;
  readonly roomId?: string;
  readonly distanceMeters: number;
  readonly inCameraFrustum?: boolean;
  readonly gameplayCritical?: boolean;
  readonly previousVisible?: boolean;
  /**
   * Previous base LOD before emergency bias. Store this value from
   * RuntimeVisibilityDecision.baseLod, not the emergency-adjusted lod.
   */
  readonly previousLod?: DecorationLod;
}

export interface RuntimeVisibilityDecision {
  readonly visible: boolean;
  readonly baseLod: DecorationLod;
  readonly lod: DecorationLod;
  readonly protectedFromEmergency: boolean;
  readonly reason:
    | "critical"
    | "visible"
    | "outside-room-set"
    | "outside-frustum"
    | "distance"
    | "emergency";
}

export interface RuntimeObjectPolicyInput {
  readonly role: RuntimeRenderableRole;
  readonly baseVisible: boolean;
  readonly baseCastShadow: boolean;
  readonly baseLod?: DecorationLod;
  readonly nearShadowCaster?: boolean;
  readonly emergencyLevel: EmergencyDegradationLevel;
}

export interface RuntimeObjectPolicy {
  readonly visible: boolean;
  readonly castShadow: boolean;
  readonly lod: DecorationLod;
  readonly protectedFromEmergency: boolean;
}

const LOD_ORDER: readonly DecorationLod[] = [
  "full",
  "reduced",
  "impostor",
  "culled",
];

const PROTECTED_RUNTIME_ROLES: ReadonlySet<RuntimeRenderableRole> = new Set([
  "player",
  "chaser",
  "locker",
  "objective",
  "navigation",
]);

export function isGameplayCriticalRuntimeRole(role: RuntimeRenderableRole): boolean {
  return PROTECTED_RUNTIME_ROLES.has(role);
}

export function decorationLodThresholds(
  profile: RenderQualityProfile,
  maximumDistanceMeters = profile.decorativeDistanceMeters,
): DecorationLodThresholds {
  const maximum = Number.isFinite(maximumDistanceMeters)
    ? Math.max(0, maximumDistanceMeters)
    : 0;
  return Object.freeze({
    fullDistanceMeters: maximum * 0.34,
    reducedDistanceMeters: maximum * 0.68,
    maximumDistanceMeters: maximum,
    hysteresisMeters: Math.min(3, Math.max(0.75, maximum * 0.04)),
  });
}

function classifyLod(
  distanceMeters: number,
  thresholds: DecorationLodThresholds,
  boundaryOffsetMeters = 0,
): DecorationLod {
  if (distanceMeters <= thresholds.fullDistanceMeters + boundaryOffsetMeters) return "full";
  if (distanceMeters <= thresholds.reducedDistanceMeters + boundaryOffsetMeters) return "reduced";
  if (distanceMeters <= thresholds.maximumDistanceMeters + boundaryOffsetMeters) return "impostor";
  return "culled";
}

function lodIndex(lod: DecorationLod): number {
  return LOD_ORDER.indexOf(lod);
}

/**
 * Distance LOD with symmetric hysteresis. Teleports can cross several bands in
 * one decision, while ordinary threshold movement holds the previous band
 * until the object clears the margin.
 */
export function nextDecorationLod(
  distanceMeters: number,
  previousLod: DecorationLod | undefined,
  profile: RenderQualityProfile,
  maximumDistanceMeters = profile.decorativeDistanceMeters,
): DecorationLod {
  const distance = Number.isFinite(distanceMeters)
    ? Math.max(0, distanceMeters)
    : Number.POSITIVE_INFINITY;
  const thresholds = decorationLodThresholds(profile, maximumDistanceMeters);
  const unheld = classifyLod(distance, thresholds);
  if (previousLod === undefined || unheld === previousLod) return unheld;

  const movingAway = lodIndex(unheld) > lodIndex(previousLod);
  const held = classifyLod(
    distance,
    thresholds,
    movingAway ? thresholds.hysteresisMeters : -thresholds.hysteresisMeters,
  );
  return held;
}

export function applyDecorativeLodBias(
  lod: DecorationLod,
  bias: EmergencyRenderPolicy["decorativeLodBias"],
): DecorationLod {
  return LOD_ORDER[Math.min(LOD_ORDER.length - 1, lodIndex(lod) + bias)];
}

function roomIsVisible(
  candidate: RuntimeVisibilityCandidate,
  rooms: RuntimeRoomVisibility,
): boolean {
  if (!candidate.roomId || rooms.visibleRoomIds.length === 0) return true;
  if (rooms.visibleRoomIds.includes(candidate.roomId)) return true;
  return Boolean(
    candidate.previousVisible
    && rooms.retainedRoomIds?.includes(candidate.roomId),
  );
}

/**
 * Pure manual-culling decision. Critical objects deliberately bypass manual
 * room/distance/frustum culling; Three.js may still perform its normal camera
 * frustum test. This makes it impossible for emergency degradation to remove
 * the player, pursuer, lockers, task targets or navigation geometry.
 */
export function decideRuntimeVisibility(
  candidate: RuntimeVisibilityCandidate,
  rooms: RuntimeRoomVisibility,
  profile: RenderQualityProfile,
  emergencyLevel: EmergencyDegradationLevel = 0,
): RuntimeVisibilityDecision {
  const protectedFromEmergency = Boolean(candidate.gameplayCritical)
    || isGameplayCriticalRuntimeRole(candidate.role);
  if (protectedFromEmergency) {
    return Object.freeze({
      visible: true,
      baseLod: "full",
      lod: "full",
      protectedFromEmergency: true,
      reason: "critical",
    });
  }

  if (!roomIsVisible(candidate, rooms)) {
    return Object.freeze({
      visible: false,
      baseLod: "culled",
      lod: "culled",
      protectedFromEmergency: false,
      reason: "outside-room-set",
    });
  }
  if (candidate.inCameraFrustum === false) {
    return Object.freeze({
      visible: false,
      baseLod: "culled",
      lod: "culled",
      protectedFromEmergency: false,
      reason: "outside-frustum",
    });
  }
  if (candidate.role === "architecture") {
    return Object.freeze({
      visible: true,
      baseLod: "full",
      lod: "full",
      protectedFromEmergency: false,
      reason: "visible",
    });
  }

  const emergency = EMERGENCY_RENDER_POLICIES[emergencyLevel];
  const maximumDistance = profile.decorativeDistanceMeters
    * emergency.decorativeDistanceScale;
  const baseLod = nextDecorationLod(
    candidate.distanceMeters,
    candidate.previousLod,
    profile,
    maximumDistance,
  );
  const lod = applyDecorativeLodBias(baseLod, emergency.decorativeLodBias);
  const hiddenByEmergency = emergency.hideOptionalDecorations
    && candidate.role === "decoration";
  const visible = lod !== "culled" && !hiddenByEmergency;
  return Object.freeze({
    visible,
    baseLod,
    lod: visible ? lod : "culled",
    protectedFromEmergency: false,
    reason: hiddenByEmergency
      ? "emergency"
      : visible
        ? "visible"
        : "distance",
  });
}

/**
 * Apply emergency visibility/LOD/shadow policy to an already room-culled
 * object. Protected roles retain their visibility at every level. Shadow
 * quality can still be reduced independently without removing silhouettes or
 * interaction readability.
 */
export function resolveRuntimeObjectPolicy(
  input: RuntimeObjectPolicyInput,
): RuntimeObjectPolicy {
  const protectedFromEmergency = isGameplayCriticalRuntimeRole(input.role);
  const emergency = EMERGENCY_RENDER_POLICIES[input.emergencyLevel];
  const baseLod = input.baseLod ?? "full";
  const lod = input.role === "decoration" || input.role === "atmosphere"
    ? applyDecorativeLodBias(baseLod, emergency.decorativeLodBias)
    : baseLod;
  const visible = input.baseVisible
    && lod !== "culled"
    && !(
      emergency.hideOptionalDecorations
      && input.role === "decoration"
      && !protectedFromEmergency
    );

  let castShadow = input.baseCastShadow;
  if (emergency.shadowCasterMode === "critical-and-near") {
    castShadow = castShadow
      && (protectedFromEmergency || Boolean(input.nearShadowCaster));
  } else if (emergency.shadowCasterMode === "critical-only") {
    castShadow = castShadow && protectedFromEmergency;
  } else if (emergency.shadowCasterMode === "characters-only") {
    castShadow = castShadow && (input.role === "player" || input.role === "chaser");
  }

  return Object.freeze({
    visible,
    castShadow,
    lod: visible ? lod : "culled",
    protectedFromEmergency,
  });
}
