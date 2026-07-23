import type { ChaserMode, GameConfig, GamePhase, PlayerMode, PlayerState } from "./contracts.ts";
import type { AnimationState } from "./animation/actor-runtime.ts";

export interface LockerDoorClaim {
  owner: "idle" | "player" | "chaser";
  hasAction: boolean;
  actionRunning: boolean;
  queuedActions: number;
  peeking: boolean;
  peekClosing: boolean;
}

/** Player-authored door motion always wins over a concurrent AI inspection. */
export function canChaserTakeLockerDoor(claim: LockerDoorClaim): boolean {
  const playerBusy = claim.owner === "player"
    && (claim.hasAction || claim.queuedActions > 0 || claim.peeking || claim.peekClosing);
  return !playerBusy && !claim.actionRunning && !claim.peekClosing;
}

/**
 * World rendering is deliberately independent from player knowledge. The
 * chaser remains a physical 3D actor during exposed play and capture; walls
 * and depth provide honest occlusion. A fully concealed player cannot inspect
 * the world until the authored peek/exposure marker, and the resolved escape
 * tableau removes the chaser from the scene.
 */
export function shouldRenderChaserModel(phase: GamePhase, playerVisuallyExposed: boolean): boolean {
  return phase !== "won" && (phase !== "playing" || playerVisuallyExposed);
}

/** Keeps the visible performance contract in lockstep with AI locomotion. */
export function chaserAnimationForMode(
  mode: ChaserMode,
  worldSpeed: number,
  atCheckedLocker: boolean,
): AnimationState {
  switch (mode) {
    case "spawn-delay": return "idle";
    case "patrol": return worldSpeed > 0.1 ? "walk" : "idle";
    case "suspicious": return "alert";
    case "chase": return "run";
    // Arrival can happen between 10 Hz decision ticks. Use actual world
    // displacement for those final frames so the actor plants its feet
    // instead of running in place while the brain enters the scan state.
    case "lost-sight": return worldSpeed > 0.1 ? "run" : "idle";
    case "go-to-last-known": return worldSpeed > 0.1 ? "run" : "idle";
    case "scan-last-known": return "search";
    case "search": return worldSpeed > 0.1 ? "walk" : "search";
    case "check-hide": return atCheckedLocker ? "checkLocker" : "walk";
  }
}

/**
 * Starts a two-actor composition whenever an exposed player can genuinely
 * observe the spawned pursuer, not only after the FSM has entered chase. This
 * gives both first acquisition and search-chain reacquisition a camera lead-in
 * without revealing anything through walls or a closed locker.
 */
export function shouldFrameChaser(
  phase: GamePhase,
  mode: ChaserMode,
  chaserObservable: boolean,
): boolean {
  return phase === "playing"
    && chaserObservable
    && mode !== "spawn-delay";
}

/**
 * State for a follow camera whose bearing is owned elsewhere and never
 * changed by normal movement or threat framing. Keeping direction out of this
 * value is intentional: callers can move the look-at point without changing
 * screen-relative movement controls.
 */
export interface FixedCameraFollowState {
  readonly focus: CameraFramingVector;
  readonly heldThreatFocus: CameraFramingVector | null;
  readonly threatHoldRemainingSeconds: number;
}

export interface FixedCameraFollowInput {
  readonly playerFocus: CameraFramingVector;
  readonly deltaSeconds: number;
  /** Only pass a threat the player is allowed to observe. */
  readonly observableThreatFocus?: CameraFramingVector | null;
  /** World-space radius in the ground plane before routine follow starts. */
  readonly deadZoneRadius?: number;
  /** Keeps the final legal threat composition briefly after line of sight ends. */
  readonly threatHoldSeconds?: number;
  /** Optional cap for a presentation-layer smoothing step. */
  readonly maximumFocusSpeed?: number;
}

const finiteVector3 = (value: CameraFramingVector | null | undefined): value is CameraFramingVector => {
  if (!value) return false;
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
};

const finiteDeltaSeconds = (value: number) => (
  Number.isFinite(value) ? Math.min(0.25, Math.max(0, value)) : 0
);

export function createFixedCameraFollowState(focus: CameraFramingVector): FixedCameraFollowState {
  const safeFocus = finiteVector3(focus) ? { ...focus } : { x: 0, y: 0, z: 0 };
  return Object.freeze({
    focus: Object.freeze(safeFocus),
    heldThreatFocus: null,
    threatHoldRemainingSeconds: 0,
  });
}

/**
 * Advances a fixed-bearing camera focus. A player can roam inside the dead
 * zone without panning the view; a newly observed threat composes both actors
 * and remains held for a short, bounded grace period. This function never
 * supplies or mutates a camera direction, so its use cannot reverse the
 * screen-to-world input basis.
 */
export function stepFixedCameraFollow(
  previous: FixedCameraFollowState,
  input: FixedCameraFollowInput,
): FixedCameraFollowState {
  const focus = finiteVector3(previous.focus) ? previous.focus : { x: 0, y: 0, z: 0 };
  const playerFocus = finiteVector3(input.playerFocus) ? input.playerFocus : focus;
  const deltaSeconds = finiteDeltaSeconds(input.deltaSeconds);
  const observedThreat = finiteVector3(input.observableThreatFocus)
    ? input.observableThreatFocus
    : null;
  const threatHoldSeconds = Number.isFinite(input.threatHoldSeconds)
    ? Math.max(0, input.threatHoldSeconds ?? 0)
    : 0.9;
  const holdRemaining = observedThreat
    ? threatHoldSeconds
    : Math.max(0, Number.isFinite(previous.threatHoldRemainingSeconds)
      ? previous.threatHoldRemainingSeconds - deltaSeconds
      : 0);
  const heldThreatFocus = observedThreat
    ? { ...observedThreat }
    : finiteVector3(previous.heldThreatFocus) && holdRemaining > 0
      ? { ...previous.heldThreatFocus }
      : null;
  const target = heldThreatFocus
    ? {
      x: (playerFocus.x + heldThreatFocus.x) / 2,
      y: (playerFocus.y + heldThreatFocus.y) / 2,
      z: (playerFocus.z + heldThreatFocus.z) / 2,
    }
    : playerFocus;
  const deadZoneRadius = Number.isFinite(input.deadZoneRadius)
    ? Math.max(0, input.deadZoneRadius ?? 0)
    : 1.15;
  const offsetX = target.x - focus.x;
  const offsetZ = target.z - focus.z;
  const groundDistance = Math.hypot(offsetX, offsetZ);
  let desired = groundDistance <= deadZoneRadius || groundDistance <= 1e-9
    ? { ...focus }
    : {
      x: target.x - offsetX / groundDistance * deadZoneRadius,
      y: target.y,
      z: target.z - offsetZ / groundDistance * deadZoneRadius,
    };
  const maximumFocusSpeed = Number.isFinite(input.maximumFocusSpeed)
    ? Math.max(0, input.maximumFocusSpeed ?? 0)
    : Number.POSITIVE_INFINITY;
  const maximumStep = maximumFocusSpeed * deltaSeconds;
  const desiredOffset = {
    x: desired.x - focus.x,
    y: desired.y - focus.y,
    z: desired.z - focus.z,
  };
  const desiredDistance = vectorLength3(desiredOffset);
  if (Number.isFinite(maximumStep) && desiredDistance > maximumStep && desiredDistance > 1e-9) {
    const scale = maximumStep / desiredDistance;
    desired = {
      x: focus.x + desiredOffset.x * scale,
      y: focus.y + desiredOffset.y * scale,
      z: focus.z + desiredOffset.z * scale,
    };
  }
  return Object.freeze({
    focus: Object.freeze(desired),
    heldThreatFocus: heldThreatFocus ? Object.freeze(heldThreatFocus) : null,
    threatHoldRemainingSeconds: holdRemaining,
  });
}

export interface CameraFramingVector {
  x: number;
  y: number;
  z: number;
}

export interface CameraViewportInsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface CameraSafeViewport {
  /** NDC bounds after reserving HUD/touch-control space. */
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface CameraFramingRequest {
  focus: CameraFramingVector;
  points: readonly CameraFramingVector[];
  /** Normalized direction from focus toward the camera. */
  cameraDirection: CameraFramingVector;
  verticalFovDegrees: number;
  aspect: number;
  horizontalMargin?: number;
  verticalMargin?: number;
  safeHorizontalNdc?: number;
  safeVerticalNdc?: number;
  /** Asymmetric safe area wins over the legacy symmetric NDC extents. */
  safeViewport?: CameraSafeViewport;
}

const vectorLength3 = (value: CameraFramingVector) => Math.hypot(value.x, value.y, value.z);
const normalize3 = (value: CameraFramingVector, fallback: CameraFramingVector): CameraFramingVector => {
  const length = vectorLength3(value);
  return length > 1e-9
    ? { x: value.x / length, y: value.y / length, z: value.z / length }
    : { ...fallback };
};
const dot3 = (left: CameraFramingVector, right: CameraFramingVector) => (
  left.x * right.x + left.y * right.y + left.z * right.z
);
const cross3 = (left: CameraFramingVector, right: CameraFramingVector): CameraFramingVector => ({
  x: left.y * right.z - left.z * right.y,
  y: left.z * right.x - left.x * right.z,
  z: left.x * right.y - left.y * right.x,
});

const finiteNonNegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;

/**
 * Converts measured UI insets into a camera-safe NDC rectangle. Each side is
 * capped below half the viewport so the immutable camera center remains a
 * usable fallback even on extremely small or malformed layouts.
 */
export function cameraSafeViewportFromInsets(
  viewportWidth: number,
  viewportHeight: number,
  insets: CameraViewportInsets,
): CameraSafeViewport {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  let left = Math.min(width * 0.48, finiteNonNegative(insets.left));
  let right = Math.min(width * 0.48, finiteNonNegative(insets.right));
  let top = Math.min(height * 0.48, finiteNonNegative(insets.top));
  let bottom = Math.min(height * 0.48, finiteNonNegative(insets.bottom));
  if (left + right > width * 0.92) {
    const scale = width * 0.92 / (left + right);
    left *= scale;
    right *= scale;
  }
  if (top + bottom > height * 0.92) {
    const scale = height * 0.92 / (top + bottom);
    top *= scale;
    bottom *= scale;
  }
  return Object.freeze({
    minX: -1 + (left / width) * 2,
    maxX: 1 - (right / width) * 2,
    minY: -1 + (bottom / height) * 2,
    maxY: 1 - (top / height) * 2,
  });
}

/**
 * Matches the current touch HUD footprint without baking DOM knowledge into
 * the camera solver. The bottom reservation moves actors above both control
 * clusters; small side gutters retain room for edge markers.
 */
export function gameplayCameraInsetsForViewport(
  viewportWidth: number,
  viewportHeight: number,
  coarsePointer: boolean,
): CameraViewportInsets {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  if (!coarsePointer) return Object.freeze({ left: 12, right: 12, top: 12, bottom: 18 });
  const portrait = height >= width;
  return Object.freeze({
    left: Math.min(22, width * 0.055),
    right: Math.min(22, width * 0.055),
    top: Math.min(portrait ? 74 : 60, height * 0.12),
    bottom: Math.min(portrait ? 132 : 82, height * (portrait ? 0.19 : 0.16)),
  });
}

function cameraBasis(cameraDirection: CameraFramingVector) {
  const direction = normalize3(cameraDirection, { x: 0, y: 1, z: 0 });
  const forward = { x: -direction.x, y: -direction.y, z: -direction.z };
  const right = normalize3(cross3(forward, { x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
  const up = normalize3(cross3(right, forward), { x: 0, y: 1, z: 0 });
  return { direction, forward, right, up };
}

function projectionSlopes(verticalFovDegrees: number, aspect: number) {
  const halfFovRadians = Math.min(89, Math.max(1, verticalFovDegrees / 2)) * Math.PI / 180;
  const vertical = Math.tan(halfFovRadians);
  return { vertical, horizontal: vertical * Math.max(0.1, aspect) };
}

function normalizedSafeViewport(safeViewport: CameraSafeViewport): CameraSafeViewport {
  const finiteOr = (value: number, fallback: number) => (
    Number.isFinite(value) ? value : fallback
  );
  let minX = Math.min(-0.001, finiteOr(safeViewport.minX, -0.82));
  let maxX = Math.max(0.001, finiteOr(safeViewport.maxX, 0.82));
  let minY = Math.min(-0.001, finiteOr(safeViewport.minY, -0.8));
  let maxY = Math.max(0.001, finiteOr(safeViewport.maxY, 0.8));
  minX = Math.max(-1, minX);
  maxX = Math.min(1, maxX);
  minY = Math.max(-1, minY);
  maxY = Math.min(1, maxY);
  return { minX, maxX, minY, maxY };
}

function safeViewportCapacities(request: CameraFramingRequest) {
  if (request.safeViewport) {
    const safeViewport = normalizedSafeViewport(request.safeViewport);
    return {
      left: Math.max(0.05, -safeViewport.minX),
      right: Math.max(0.05, safeViewport.maxX),
      down: Math.max(0.05, -safeViewport.minY),
      up: Math.max(0.05, safeViewport.maxY),
    };
  }
  const horizontal = Math.min(0.98, Math.max(0.1, request.safeHorizontalNdc ?? 0.82));
  const vertical = Math.min(0.98, Math.max(0.1, request.safeVerticalNdc ?? 0.8));
  return { left: horizontal, right: horizontal, down: vertical, up: vertical };
}

/**
 * Calculates the minimum focus-to-camera distance needed to keep every actor
 * anchor (plus an authored body margin) inside a safe NDC rectangle. The
 * calculation uses the current smoothed focus, so a chase can expand the view
 * before its midpoint composition has fully settled. Manual zoom is never
 * allowed to undercut this distance.
 */
export function requiredCameraDistanceForFraming(request: CameraFramingRequest): number {
  if (!request.points.length) return 0;
  const { forward, right, up } = cameraBasis(request.cameraDirection);
  const slopes = projectionSlopes(request.verticalFovDegrees, request.aspect);
  const safe = safeViewportCapacities(request);
  const horizontalMargin = Math.max(0, request.horizontalMargin ?? 0.9);
  const verticalMargin = Math.max(0, request.verticalMargin ?? 1.05);
  let required = 0;
  for (const point of request.points) {
    const relative = {
      x: point.x - request.focus.x,
      y: point.y - request.focus.y,
      z: point.z - request.focus.z,
    };
    const forwardOffset = dot3(relative, forward);
    const cameraX = dot3(relative, right);
    const cameraY = dot3(relative, up);
    const horizontal = Math.max(
      (cameraX + horizontalMargin) / (slopes.horizontal * safe.right),
      (-cameraX + horizontalMargin) / (slopes.horizontal * safe.left),
    ) - forwardOffset;
    const vertical = Math.max(
      (cameraY + verticalMargin) / (slopes.vertical * safe.up),
      (-cameraY + verticalMargin) / (slopes.vertical * safe.down),
    ) - forwardOffset;
    required = Math.max(required, horizontal, vertical);
  }
  return Math.max(0, required);
}

export interface FixedCameraProjectionRequest {
  readonly focus: CameraFramingVector;
  readonly point: CameraFramingVector;
  readonly cameraDirection: CameraFramingVector;
  readonly cameraDistance: number;
  readonly verticalFovDegrees: number;
  readonly aspect: number;
}

/** Projects a world point without constructing a Three.js camera. */
export function projectPointToFixedCameraNdc(
  request: FixedCameraProjectionRequest,
): CameraFramingVector | null {
  if (
    !Number.isFinite(request.cameraDistance)
    || request.cameraDistance <= 0
    || !Number.isFinite(request.aspect)
    || request.aspect <= 0
  ) return null;
  const { direction, forward, right, up } = cameraBasis(request.cameraDirection);
  const slopes = projectionSlopes(request.verticalFovDegrees, request.aspect);
  const cameraPosition = {
    x: request.focus.x + direction.x * request.cameraDistance,
    y: request.focus.y + direction.y * request.cameraDistance,
    z: request.focus.z + direction.z * request.cameraDistance,
  };
  const relative = {
    x: request.point.x - cameraPosition.x,
    y: request.point.y - cameraPosition.y,
    z: request.point.z - cameraPosition.z,
  };
  const depth = dot3(relative, forward);
  if (!Number.isFinite(depth) || depth <= 1e-6) return null;
  return {
    x: dot3(relative, right) / (depth * slopes.horizontal),
    y: dot3(relative, up) / (depth * slopes.vertical),
    z: depth,
  };
}

export interface SafeViewportCameraFocusRequest {
  readonly focus: CameraFramingVector;
  readonly cameraDirection: CameraFramingVector;
  readonly cameraDistance: number;
  readonly verticalFovDegrees: number;
  readonly aspect: number;
  readonly safeViewport: CameraSafeViewport;
}

/**
 * Translates the look-at point while preserving camera direction, placing the
 * original gameplay focus at the center of an asymmetric mobile safe area.
 */
export function cameraFocusForSafeViewport(
  request: SafeViewportCameraFocusRequest,
): CameraFramingVector {
  if (
    !Number.isFinite(request.cameraDistance)
    || request.cameraDistance <= 0
    || !Number.isFinite(request.aspect)
    || request.aspect <= 0
  ) return { ...request.focus };
  const { right, up } = cameraBasis(request.cameraDirection);
  const slopes = projectionSlopes(request.verticalFovDegrees, request.aspect);
  const safeViewport = normalizedSafeViewport(request.safeViewport);
  const centerX = (safeViewport.minX + safeViewport.maxX) / 2;
  const centerY = (safeViewport.minY + safeViewport.maxY) / 2;
  const horizontalShift = -centerX * request.cameraDistance * slopes.horizontal;
  const verticalShift = -centerY * request.cameraDistance * slopes.vertical;
  return {
    x: request.focus.x + right.x * horizontalShift + up.x * verticalShift,
    y: request.focus.y + right.y * horizontalShift + up.y * verticalShift,
    z: request.focus.z + right.z * horizontalShift + up.z * verticalShift,
  };
}

export interface CameraActorReadabilityTarget {
  /** Character-bounds center, not the ground/root point. */
  readonly center: CameraFramingVector;
  readonly height: number;
}

export interface ActorScreenHeightRequest {
  readonly focus: CameraFramingVector;
  readonly actor: CameraActorReadabilityTarget;
  readonly cameraDirection: CameraFramingVector;
  readonly cameraDistance: number;
  readonly verticalFovDegrees: number;
  readonly aspect: number;
  readonly viewportHeightPixels: number;
}

/** Exact projected head-to-foot height for a fixed-direction camera. */
export function projectedActorScreenHeightPixels(request: ActorScreenHeightRequest): number {
  if (
    !Number.isFinite(request.actor.height)
    || request.actor.height <= 0
    || !Number.isFinite(request.viewportHeightPixels)
    || request.viewportHeightPixels <= 0
  ) return 0;
  const halfHeight = request.actor.height / 2;
  const feet = projectPointToFixedCameraNdc({
    ...request,
    point: { ...request.actor.center, y: request.actor.center.y - halfHeight },
  });
  const head = projectPointToFixedCameraNdc({
    ...request,
    point: { ...request.actor.center, y: request.actor.center.y + halfHeight },
  });
  if (!feet || !head) return 0;
  return Math.abs(head.y - feet.y) * request.viewportHeightPixels / 2;
}

export interface ActorReadabilityDistanceRequest extends Omit<ActorScreenHeightRequest, "cameraDistance"> {
  readonly minimumScreenHeightPixels: number;
  readonly minimumDistance?: number;
  readonly maximumDistance?: number;
}

/**
 * Returns the furthest camera distance that preserves a minimum actor height.
 * A zero result means the requested size is impossible in the supplied range.
 */
export function maximumCameraDistanceForActorReadability(
  request: ActorReadabilityDistanceRequest,
): number {
  const minimumDistance = Math.max(0.1, request.minimumDistance ?? 0.5);
  const maximumDistance = Math.max(minimumDistance, request.maximumDistance ?? 120);
  if (!Number.isFinite(request.minimumScreenHeightPixels) || request.minimumScreenHeightPixels <= 0) {
    return maximumDistance;
  }
  const screenHeightAt = (cameraDistance: number) => projectedActorScreenHeightPixels({
    ...request,
    cameraDistance,
  });
  if (screenHeightAt(minimumDistance) + 1e-9 < request.minimumScreenHeightPixels) return 0;
  if (screenHeightAt(maximumDistance) >= request.minimumScreenHeightPixels) return maximumDistance;
  let low = minimumDistance;
  let high = maximumDistance;
  for (let iteration = 0; iteration < 44; iteration += 1) {
    const middle = (low + high) / 2;
    if (screenHeightAt(middle) >= request.minimumScreenHeightPixels) low = middle;
    else high = middle;
  }
  return low;
}

export interface FixedCameraCompositionRequest extends Omit<CameraFramingRequest, "points"> {
  readonly actors: readonly CameraActorReadabilityTarget[];
  readonly viewportHeightPixels: number;
  readonly minimumActorScreenHeightPixels: number;
  readonly preferredDistance: number;
  readonly minimumDistance?: number;
  readonly maximumDistance?: number;
}

export interface FixedCameraCompositionConstraints {
  readonly distance: number;
  readonly requiredFramingDistance: number;
  readonly maximumReadableDistance: number;
  readonly feasible: boolean;
  readonly framingSatisfied: boolean;
  readonly readabilitySatisfied: boolean;
}

/**
 * Resolves dual-target visibility and character readability without rotating
 * the camera. Honest two-actor framing wins when the constraints conflict,
 * and the result explicitly reports that compromise to telemetry/QA.
 */
export function fixedCameraCompositionConstraints(
  request: FixedCameraCompositionRequest,
): FixedCameraCompositionConstraints {
  const minimumDistance = Math.max(0.1, request.minimumDistance ?? 0.5);
  const maximumDistance = Math.max(minimumDistance, request.maximumDistance ?? 120);
  const framingDistance = requiredCameraDistanceForFraming({
    ...request,
    points: request.actors.map(({ center }) => center),
  });
  const readableDistances = request.actors.map((actor) => maximumCameraDistanceForActorReadability({
    focus: request.focus,
    actor,
    cameraDirection: request.cameraDirection,
    verticalFovDegrees: request.verticalFovDegrees,
    aspect: request.aspect,
    viewportHeightPixels: request.viewportHeightPixels,
    minimumScreenHeightPixels: request.minimumActorScreenHeightPixels,
    minimumDistance,
    maximumDistance,
  }));
  const maximumReadableDistance = readableDistances.length
    ? Math.min(...readableDistances)
    : maximumDistance;
  const required = Math.max(minimumDistance, framingDistance);
  const readable = Math.min(maximumDistance, maximumReadableDistance);
  const feasible = required <= readable + 1e-7;
  const preferred = Number.isFinite(request.preferredDistance)
    ? request.preferredDistance
    : required;
  const distance = feasible
    ? Math.min(readable, Math.max(required, preferred))
    : Math.min(maximumDistance, required);
  return Object.freeze({
    distance,
    requiredFramingDistance: framingDistance,
    maximumReadableDistance,
    feasible,
    framingSatisfied: distance + 1e-7 >= framingDistance,
    readabilitySatisfied: distance <= maximumReadableDistance + 1e-7,
  });
}

/**
 * Portrait screens need a slightly closer default composition because their
 * vertical canvas otherwise spends too much space on empty foreground. The
 * exact two-actor framing solver still wins whenever separation requires a
 * wider shot, so this never crops a visible pursuer.
 */
export function baseCameraDistanceForAspect(aspect: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const portraitBlend = Math.min(1, Math.max(0, (0.86 - safeAspect) / 0.4));
  return 14.8 - portraitBlend * 1.6;
}

/**
 * Preserve the player's wide exploration view, then move in only for authored
 * character performances that would otherwise be unreadable at maze scale.
 * Threat framing can still push the camera back when both actors must fit.
 */
export function cameraDistanceScaleForPlayerMode(mode: PlayerMode): number {
  switch (mode) {
    case "aligning-hide":
    case "entering-hide":
    case "exiting-hide":
      return 0.78;
    case "entering-peek":
    case "peeking":
    case "exiting-peek":
      return 0.84;
    case "caught":
    case "escaped":
      return 0.86;
    case "hidden":
      return 0.9;
    case "free":
      return 1;
  }
}

export interface CameraFocusBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface EdgeHideCameraFocusRequest {
  focus: CameraFramingVector;
  bounds: CameraFocusBounds;
  mode: PlayerMode;
  cameraDirection: CameraFramingVector;
  cameraDistance: number;
  verticalFovDegrees: number;
  aspect: number;
  edgeInset?: number;
  maximumShift?: number;
  safeHorizontalNdc?: number;
  safeVerticalNdc?: number;
}

const EDGE_HIDE_CAMERA_MODES: ReadonlySet<PlayerMode> = new Set([
  "aligning-hide",
  "entering-hide",
  "hidden",
  "entering-peek",
  "peeking",
  "exiting-peek",
  "exiting-hide",
]);

/**
 * Moves the look-at point slightly into the playfield for locker performances
 * on an outer map edge. This is a framing translation only: the immutable
 * camera direction (and therefore the player's screen-relative controls) is
 * never rotated. The final shift is projection-limited so a portrait viewport
 * keeps the performer inside a conservative central safe frame.
 */
export function cameraFocusForEdgeHide(request: EdgeHideCameraFocusRequest): CameraFramingVector {
  if (!EDGE_HIDE_CAMERA_MODES.has(request.mode)) return { ...request.focus };
  const values = [
    request.focus.x,
    request.focus.y,
    request.focus.z,
    request.bounds.minX,
    request.bounds.maxX,
    request.bounds.minZ,
    request.bounds.maxZ,
    request.cameraDistance,
    request.verticalFovDegrees,
    request.aspect,
  ];
  if (!values.every(Number.isFinite)
    || request.bounds.maxX <= request.bounds.minX
    || request.bounds.maxZ <= request.bounds.minZ
    || request.cameraDistance <= 0
    || request.aspect <= 0) {
    return { ...request.focus };
  }

  const requestedInset = Math.max(0, request.edgeInset ?? 8);
  const xInset = Math.min(requestedInset, (request.bounds.maxX - request.bounds.minX) / 2);
  const zInset = Math.min(requestedInset, (request.bounds.maxZ - request.bounds.minZ) / 2);
  const safeMinX = request.bounds.minX + xInset;
  const safeMaxX = request.bounds.maxX - xInset;
  const safeMinZ = request.bounds.minZ + zInset;
  const safeMaxZ = request.bounds.maxZ - zInset;
  let shift = {
    x: Math.min(safeMaxX, Math.max(safeMinX, request.focus.x)) - request.focus.x,
    y: 0,
    z: Math.min(safeMaxZ, Math.max(safeMinZ, request.focus.z)) - request.focus.z,
  };
  const shiftLength = vectorLength3(shift);
  if (shiftLength <= 1e-9) return { ...request.focus };
  // Two grid metres per cell: at most two cells of translation is enough to
  // move the boundary off centre without turning this into a detached camera.
  const maximumShift = Math.max(0, request.maximumShift ?? 4);
  if (maximumShift <= 1e-9) return { ...request.focus };
  if (shiftLength > maximumShift) {
    const scale = maximumShift / shiftLength;
    shift = { x: shift.x * scale, y: 0, z: shift.z * scale };
  }

  const direction = normalize3(request.cameraDirection, { x: 0, y: 1, z: 0 });
  const forward = { x: -direction.x, y: -direction.y, z: -direction.z };
  const right = normalize3(cross3(forward, { x: 0, y: 1, z: 0 }), { x: 1, y: 0, z: 0 });
  const up = normalize3(cross3(right, forward), { x: 0, y: 1, z: 0 });
  const halfFovRadians = Math.min(89, Math.max(1, request.verticalFovDegrees / 2)) * Math.PI / 180;
  const verticalSlope = Math.tan(halfFovRadians);
  const horizontalSlope = verticalSlope * Math.max(0.1, request.aspect);
  const safeHorizontal = Math.min(0.9, Math.max(0.05, request.safeHorizontalNdc ?? 0.32));
  const safeVertical = Math.min(0.9, Math.max(0.05, request.safeVerticalNdc ?? 0.26));
  const isProjectionSafe = (scale: number) => {
    // The performer remains at the original focus while the camera looks at
    // focus + shift, hence its camera-space offset is the negative shift.
    const relative = { x: -shift.x * scale, y: 0, z: -shift.z * scale };
    const depth = request.cameraDistance + dot3(relative, forward);
    if (depth <= 0.1) return false;
    const horizontalNdc = Math.abs(dot3(relative, right)) / (depth * horizontalSlope);
    const verticalNdc = Math.abs(dot3(relative, up)) / (depth * verticalSlope);
    return horizontalNdc <= safeHorizontal && verticalNdc <= safeVertical;
  };

  let projectionScale = 1;
  if (!isProjectionSafe(1)) {
    let low = 0;
    let high = 1;
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const middle = (low + high) / 2;
      if (isProjectionSafe(middle)) low = middle;
      else high = middle;
    }
    projectionScale = low;
  }
  return {
    x: request.focus.x + shift.x * projectionScale,
    y: request.focus.y,
    z: request.focus.z + shift.z * projectionScale,
  };
}

/**
 * Applies a restrained inward bias while the player traverses an outer lane.
 * This uses the same projection-safe solver as locker framing, but caps the
 * translation at two cells so the actor remains inside the central safe frame
 * while excess exterior ground is kept out of the shot.
 */
export function cameraFocusForTraversalEdge(
  request: Omit<EdgeHideCameraFocusRequest, "mode">,
): CameraFramingVector {
  return cameraFocusForEdgeHide({
    ...request,
    mode: "hidden",
    edgeInset: request.edgeInset ?? 6.4,
    maximumShift: request.maximumShift ?? 4,
    safeHorizontalNdc: request.safeHorizontalNdc ?? 0.44,
    safeVerticalNdc: request.safeVerticalNdc ?? 0.34,
  });
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export type ReadableActorRole = "player" | "chaser" | "ally";

/**
 * Authored character shaders use this bounded Fresnel strength to retain
 * their textured silhouette in dark chapters. It never bypasses depth or
 * visibility, so walls and closed lockers continue to hide the pursuer.
 */
export function actorReadabilityRimStrength(
  role: ReadableActorRole,
  chaserMode: ChaserMode,
  rendered = true,
): number {
  if (!rendered) return 0;
  if (role === "player") return 0.28;
  if (role === "ally") return 0.24;
  switch (chaserMode) {
    case "chase": return 0.68;
    case "suspicious":
    case "lost-sight":
    case "go-to-last-known": return 0.5;
    case "scan-last-known":
    case "search":
    case "check-hide": return 0.42;
    case "patrol": return 0.34;
    case "spawn-delay": return 0.22;
  }
}

/**
 * Keeps game and authored animation time aligned at ordinary low frame rates,
 * while bounding a long scheduler stall so one frame cannot trigger an
 * unbounded fixed-step catch-up.
 */
export function boundedFrameDeltaSeconds(previousMs: number, nowMs: number, maximumSeconds: number) {
  if (![previousMs, nowMs, maximumSeconds].every(Number.isFinite) || maximumSeconds <= 0) return 0;
  return Math.min(Math.max(0, (nowMs - previousMs) / 1000), maximumSeconds);
}

function smoothstep(value: number, start: number, end: number) {
  const progress = clamp01((value - start) / Math.max(end - start, 1e-6));
  return progress * progress * (3 - 2 * progress);
}

/**
 * Drives the locker view mask from the same authored timing markers used by
 * perception. `cover=1` is fully enclosed; `peek=1` is the open observation
 * slit. This keeps what the player sees aligned with when the AI can see them.
 */
export function lockerVisionMix(
  player: Pick<PlayerState, "mode" | "transitionRemainingSeconds">,
  config: Pick<
    GameConfig,
    | "hideEnterSeconds"
    | "hideEnterExposureSeconds"
    | "hideExitSeconds"
    | "hideExitExposureSeconds"
    | "peekEnterSeconds"
    | "peekExitSeconds"
  >,
): { cover: number; peek: number } {
  switch (player.mode) {
    case "hidden": return { cover: 1, peek: 0 };
    case "entering-peek": {
      const progress = clamp01(1 - player.transitionRemainingSeconds / config.peekEnterSeconds);
      return { cover: 1 - progress, peek: progress };
    }
    case "peeking": return { cover: 0, peek: 1 };
    case "exiting-peek": {
      const openFraction = clamp01(player.transitionRemainingSeconds / config.peekExitSeconds);
      return { cover: 1 - openFraction, peek: openFraction };
    }
    case "entering-hide": {
      const elapsed = config.hideEnterSeconds - player.transitionRemainingSeconds;
      const cover = smoothstep(
        elapsed,
        Math.max(0, config.hideEnterExposureSeconds - 0.34),
        config.hideEnterExposureSeconds,
      );
      return { cover, peek: 0 };
    }
    case "exiting-hide": {
      const elapsed = config.hideExitSeconds - player.transitionRemainingSeconds;
      const opened = smoothstep(
        elapsed,
        config.hideExitExposureSeconds,
        config.hideExitExposureSeconds + 0.28,
      );
      return { cover: 1 - opened, peek: 0 };
    }
    case "free":
    case "aligning-hide":
    case "caught":
    case "escaped":
      return { cover: 0, peek: 0 };
  }
}

/**
 * Models subtle eye adaptation through the observation slit. A sealed locker
 * receives no lift; a fully open peek remains restrained enough to preserve
 * each chapter's authored night lighting.
 */
export function lockerObservationExposureMultiplier(
  vision: Readonly<{ cover: number; peek: number }>,
): number {
  const openPeek = clamp01(vision.peek) * (1 - clamp01(vision.cover));
  return 1 + openPeek * 0.18;
}

/**
 * Frame-rate-independent attack/release used by camera occluders. Entering an
 * obstruction clears the player quickly, while recovery is deliberately
 * slower so a ray grazing a wall corner cannot make the material flicker.
 */
export function smoothOcclusionStrength(current: number, obscured: boolean, deltaSeconds: number) {
  const from = clamp01(current);
  const target = obscured ? 1 : 0;
  const response = obscured ? 12 : 5.5;
  const delta = Math.max(0, deltaSeconds);
  return clamp01(from + (target - from) * (1 - Math.exp(-response * delta)));
}
