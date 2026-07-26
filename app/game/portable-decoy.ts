import type {
  LevelDefinition,
  Point,
  SoundEvidenceSourceType,
} from "./contracts.ts";
import { distanceBetween, hasLineOfSight, isWalkable } from "./navigation.ts";
import type { SoundStimulus } from "./perception.ts";

const TIME_EPSILON_SECONDS = 1e-9;

export interface PortableDecoyDefinition {
  readonly id: string;
  /** Number of physical decoys available for one run. */
  readonly capacity: number;
  /** Maximum straight-line placement distance from the acting player. */
  readonly placementRange: number;
  /** Delay between placement and the one-shot public sound. */
  readonly fuseSeconds: number;
  /** Maximum time the emitted decoy remains eligible for an investigation receipt. */
  readonly activeLifetimeSeconds: number;
  /** Minimum interval between accepted placements. */
  readonly cooldownSeconds: number;
  readonly soundStrength: number;
  readonly soundConfidence: number;
  readonly soundDecayPerSecond: number;
  /** Per-use credibility multiplier; deployment zero uses the authored base confidence. */
  readonly repeatConfidenceMultiplier: number;
}

export const LIBRARY_PORTABLE_DECOY_DEFINITION: PortableDecoyDefinition = Object.freeze({
  id: "library-portable-decoy",
  capacity: 2,
  placementRange: 4.5,
  fuseSeconds: 0.45,
  activeLifetimeSeconds: 12,
  cooldownSeconds: 4.5,
  soundStrength: 0.9,
  soundConfidence: 0.84,
  soundDecayPerSecond: 0.1,
  repeatConfidenceMultiplier: 0.68,
});

export interface PortableDecoyDeployment {
  readonly deploymentId: string;
  /**
   * Unique evidence id for this physical item. Repeat-use credibility is
   * applied before emission, avoiding a late AI receipt resolving a newer item.
   */
  readonly sourceId: string;
  readonly position: Point;
  readonly deployedAtSeconds: number;
  readonly soundAtSeconds: number;
  readonly expiresAtSeconds: number;
  readonly soundEmitted: boolean;
  readonly effectiveConfidence: number;
}

export interface PortableDecoyState {
  readonly definition: PortableDecoyDefinition;
  readonly inventoryRemaining: number;
  readonly deploymentCount: number;
  readonly activeDeployment: PortableDecoyDeployment | null;
  readonly nextDeployAtSeconds: number;
  readonly updatedAtSeconds: number;
}

export type PortableDecoyDeployRejection =
  | "invalid-time"
  | "time-regression"
  | "deployment-active"
  | "inventory-empty"
  | "cooldown-active"
  | "invalid-actor-position"
  | "actor-not-walkable"
  | "invalid-landing-position"
  | "landing-not-walkable"
  | "out-of-range"
  | "trajectory-blocked";

export type PortableDecoyEvent =
  | {
      readonly type: "deployed";
      readonly decoyId: string;
      readonly deploymentId: string;
      readonly sourceId: string;
      readonly position: Point;
      readonly inventoryRemaining: number;
      readonly atSeconds: number;
    }
  | {
      readonly type: "sound-emitted";
      readonly decoyId: string;
      readonly deploymentId: string;
      readonly sourceId: string;
      readonly position: Point;
      readonly effectiveConfidence: number;
      readonly atSeconds: number;
    }
  | {
      readonly type: "investigation-completed";
      readonly decoyId: string;
      readonly deploymentId: string;
      readonly sourceId: string;
      readonly atSeconds: number;
    }
  | {
      readonly type: "expired";
      readonly decoyId: string;
      readonly deploymentId: string;
      readonly sourceId: string;
      readonly atSeconds: number;
    }
  | {
      readonly type: "ready";
      readonly decoyId: string;
      readonly atSeconds: number;
    };

export interface PortableDecoyDeployInput {
  readonly nowSeconds: number;
  readonly actorPosition: Point;
  readonly landingPosition: Point;
}

export interface PortableDecoyDeployResult {
  readonly state: PortableDecoyState;
  readonly accepted: boolean;
  readonly rejection: PortableDecoyDeployRejection | null;
  readonly events: readonly PortableDecoyEvent[];
}

/**
 * Structurally matches ChaserBrainResult.completedSoundInvestigation. A
 * SimulationEvent can be adapted by mapping evidenceId to sourceId.
 */
export interface PortableDecoyInvestigationCompletion {
  readonly sourceId: string;
  readonly sourceType: SoundEvidenceSourceType;
  /** Fixed-step event time; lets a later render frame validate the legal edge. */
  readonly completedAtSeconds?: number;
}

export interface PortableDecoyStepInput {
  readonly nowSeconds: number;
  readonly deltaSeconds: number;
  readonly completedInvestigation?: PortableDecoyInvestigationCompletion;
}

export interface PortableDecoyStep {
  readonly state: PortableDecoyState;
  readonly sample: PortableDecoySample;
  readonly events: readonly PortableDecoyEvent[];
  /**
   * Delivery proposal for GameSimulation.emitWorldSound. The proposal remains
   * available on later steps until acknowledgePortableDecoySound confirms that
   * the simulation accepted it.
   */
  readonly pendingSoundStimulus: SoundStimulus | null;
  /**
   * @deprecated Transitional alias for pendingSoundStimulus. A non-null value
   * is only a delivery proposal and does not mean that soundEmitted is true.
   */
  readonly emittedSoundStimulus: SoundStimulus | null;
}

export type PortableDecoySoundAcknowledgeRejection =
  | "invalid-time"
  | "time-regression"
  | "no-active-deployment"
  | "source-mismatch"
  | "not-due"
  | "already-acknowledged"
  | "deployment-expired";

export interface PortableDecoySoundAcknowledgeInput {
  readonly nowSeconds: number;
  readonly sourceId: string;
}

export interface PortableDecoySoundAcknowledgeResult {
  readonly state: PortableDecoyState;
  readonly acknowledged: boolean;
  readonly rejection: PortableDecoySoundAcknowledgeRejection | null;
  readonly events: readonly PortableDecoyEvent[];
}

export type PortableDecoyPhase =
  | "ready"
  | "cooldown"
  | "arming"
  | "awaiting-delivery"
  | "awaiting-investigation"
  | "depleted";

export interface PortableDecoySample {
  readonly phase: PortableDecoyPhase;
  readonly canDeploy: boolean;
  readonly inventoryRemaining: number;
  readonly cooldownRemainingSeconds: number;
  readonly progress: number;
  readonly deploymentId: string | null;
  readonly sourceId: string | null;
  readonly position: Point | null;
  readonly effectiveConfidence: number;
}

const finitePoint = (point: Point) => (
  Number.isFinite(point.x) && Number.isFinite(point.y)
);

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function validateDefinition(definition: PortableDecoyDefinition) {
  if (!definition.id.trim()) throw new Error("Portable decoy id must not be empty");
  if (!Number.isInteger(definition.capacity) || definition.capacity <= 0) {
    throw new Error("Portable decoy capacity must be a positive integer");
  }
  for (const [name, value, allowZero] of [
    ["placementRange", definition.placementRange, false],
    ["fuseSeconds", definition.fuseSeconds, true],
    ["activeLifetimeSeconds", definition.activeLifetimeSeconds, false],
    ["cooldownSeconds", definition.cooldownSeconds, true],
    ["soundDecayPerSecond", definition.soundDecayPerSecond, true],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value <= 0)) {
      throw new Error(`${name} must be finite and ${allowZero ? "non-negative" : "greater than zero"}`);
    }
  }
  for (const [name, value] of [
    ["soundStrength", definition.soundStrength],
    ["soundConfidence", definition.soundConfidence],
    ["repeatConfidenceMultiplier", definition.repeatConfidenceMultiplier],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`${name} must be in (0, 1]`);
    }
  }
}

function freezeDefinition(definition: PortableDecoyDefinition): PortableDecoyDefinition {
  return Object.freeze({ ...definition });
}

function freezeDeployment(deployment: PortableDecoyDeployment): PortableDecoyDeployment {
  return Object.freeze({
    ...deployment,
    position: Object.freeze({ ...deployment.position }),
  });
}

function freezeState(state: PortableDecoyState): PortableDecoyState {
  return Object.freeze({
    ...state,
    activeDeployment: state.activeDeployment
      ? freezeDeployment(state.activeDeployment)
      : null,
  });
}

function freezeEvent(event: PortableDecoyEvent): PortableDecoyEvent {
  if ("position" in event) {
    return Object.freeze({
      ...event,
      position: Object.freeze({ ...event.position }),
    });
  }
  return Object.freeze({ ...event });
}

function freezeEvents(events: readonly PortableDecoyEvent[]): readonly PortableDecoyEvent[] {
  return Object.freeze(events.map(freezeEvent));
}

function rejected(
  state: PortableDecoyState,
  rejection: PortableDecoyDeployRejection,
): PortableDecoyDeployResult {
  return Object.freeze({
    state,
    accepted: false,
    rejection,
    events: Object.freeze([]),
  });
}

export function createPortableDecoyState(
  definition: PortableDecoyDefinition,
  nowSeconds = 0,
): PortableDecoyState {
  validateDefinition(definition);
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0) {
    throw new Error("Portable decoy initial time must be finite and non-negative");
  }
  return freezeState({
    definition: freezeDefinition(definition),
    inventoryRemaining: definition.capacity,
    deploymentCount: 0,
    activeDeployment: null,
    nextDeployAtSeconds: nowSeconds,
    updatedAtSeconds: nowSeconds,
  });
}

/**
 * Validates a physical placement against authored navigation and visibility
 * geometry. Success consumes inventory immediately; sound remains step-driven.
 */
export function deployPortableDecoy(
  source: PortableDecoyState,
  level: LevelDefinition,
  input: PortableDecoyDeployInput,
): PortableDecoyDeployResult {
  if (!Number.isFinite(input.nowSeconds) || input.nowSeconds < 0) {
    return rejected(source, "invalid-time");
  }
  if (input.nowSeconds + TIME_EPSILON_SECONDS < source.updatedAtSeconds) {
    return rejected(source, "time-regression");
  }
  if (source.activeDeployment) return rejected(source, "deployment-active");
  if (source.inventoryRemaining <= 0) return rejected(source, "inventory-empty");
  if (input.nowSeconds + TIME_EPSILON_SECONDS < source.nextDeployAtSeconds) {
    return rejected(source, "cooldown-active");
  }
  if (!finitePoint(input.actorPosition)) return rejected(source, "invalid-actor-position");
  if (!isWalkable(level, input.actorPosition)) return rejected(source, "actor-not-walkable");
  if (!finitePoint(input.landingPosition)) return rejected(source, "invalid-landing-position");
  if (!isWalkable(level, input.landingPosition)) return rejected(source, "landing-not-walkable");
  if (
    distanceBetween(input.actorPosition, input.landingPosition)
      > source.definition.placementRange + TIME_EPSILON_SECONDS
  ) return rejected(source, "out-of-range");
  if (!hasLineOfSight(level, input.actorPosition, input.landingPosition)) {
    return rejected(source, "trajectory-blocked");
  }

  const deploymentNumber = source.deploymentCount + 1;
  const deploymentId = `${source.definition.id}:deployment:${deploymentNumber}`;
  const sourceId = `${source.definition.id}:unit:${deploymentNumber}`;
  const soundAtSeconds = input.nowSeconds + source.definition.fuseSeconds;
  const effectiveConfidence = clamp01(
    source.definition.soundConfidence
      * source.definition.repeatConfidenceMultiplier ** source.deploymentCount,
  );
  const activeDeployment = freezeDeployment({
    deploymentId,
    sourceId,
    position: input.landingPosition,
    deployedAtSeconds: input.nowSeconds,
    soundAtSeconds,
    expiresAtSeconds: soundAtSeconds + source.definition.activeLifetimeSeconds,
    soundEmitted: false,
    effectiveConfidence,
  });
  const inventoryRemaining = source.inventoryRemaining - 1;
  const state = freezeState({
    ...source,
    inventoryRemaining,
    deploymentCount: deploymentNumber,
    activeDeployment,
    nextDeployAtSeconds: input.nowSeconds + source.definition.cooldownSeconds,
    updatedAtSeconds: input.nowSeconds,
  });
  const events = freezeEvents([{
    type: "deployed",
    decoyId: source.definition.id,
    deploymentId,
    sourceId,
    position: input.landingPosition,
    inventoryRemaining,
    atSeconds: input.nowSeconds,
  }]);
  return Object.freeze({
    state,
    accepted: true,
    rejection: null,
    events,
  });
}

function validateStepTime(source: PortableDecoyState, input: PortableDecoyStepInput) {
  if (
    !Number.isFinite(input.nowSeconds)
    || input.nowSeconds < 0
    || !Number.isFinite(input.deltaSeconds)
    || input.deltaSeconds < 0
  ) throw new Error("Portable decoy step time must be finite and non-negative");
  if (input.nowSeconds + TIME_EPSILON_SECONDS < source.updatedAtSeconds) {
    throw new Error("Portable decoy time must not move backwards");
  }
}

export function portableDecoySoundStimulus(
  definition: PortableDecoyDefinition,
  deployment: PortableDecoyDeployment,
): SoundStimulus {
  return Object.freeze({
    position: Object.freeze({ ...deployment.position }),
    strength: definition.soundStrength,
    sourceType: "environment-decoy",
    sourceId: deployment.sourceId,
    confidence: deployment.effectiveConfidence,
    decayPerSecond: definition.soundDecayPerSecond,
  });
}

function rejectedSoundAcknowledgement(
  state: PortableDecoyState,
  rejection: PortableDecoySoundAcknowledgeRejection,
): PortableDecoySoundAcknowledgeResult {
  return Object.freeze({
    state,
    acknowledged: false,
    rejection,
    events: Object.freeze([]),
  });
}

/**
 * Commits a previously proposed public sound only after the simulation accepts
 * it. Callers must not invoke this when emitWorldSound returned false; leaving
 * the deployment unacknowledged makes the same proposal available next step.
 */
export function acknowledgePortableDecoySound(
  source: PortableDecoyState,
  input: PortableDecoySoundAcknowledgeInput,
): PortableDecoySoundAcknowledgeResult {
  if (!Number.isFinite(input.nowSeconds) || input.nowSeconds < 0) {
    return rejectedSoundAcknowledgement(source, "invalid-time");
  }
  if (input.nowSeconds + TIME_EPSILON_SECONDS < source.updatedAtSeconds) {
    return rejectedSoundAcknowledgement(source, "time-regression");
  }
  const active = source.activeDeployment;
  if (!active) {
    return rejectedSoundAcknowledgement(source, "no-active-deployment");
  }
  if (input.sourceId !== active.sourceId) {
    return rejectedSoundAcknowledgement(source, "source-mismatch");
  }
  if (active.soundEmitted) {
    return rejectedSoundAcknowledgement(source, "already-acknowledged");
  }
  if (input.nowSeconds + TIME_EPSILON_SECONDS < active.soundAtSeconds) {
    return rejectedSoundAcknowledgement(source, "not-due");
  }
  if (input.nowSeconds > active.expiresAtSeconds + TIME_EPSILON_SECONDS) {
    return rejectedSoundAcknowledgement(source, "deployment-expired");
  }

  const acknowledgedDeployment = freezeDeployment({
    ...active,
    soundEmitted: true,
  });
  const state = freezeState({
    ...source,
    activeDeployment: acknowledgedDeployment,
    updatedAtSeconds: input.nowSeconds,
  });
  const events = freezeEvents([{
    type: "sound-emitted",
    decoyId: source.definition.id,
    deploymentId: acknowledgedDeployment.deploymentId,
    sourceId: acknowledgedDeployment.sourceId,
    position: acknowledgedDeployment.position,
    effectiveConfidence: acknowledgedDeployment.effectiveConfidence,
    atSeconds: acknowledgedDeployment.soundAtSeconds,
  }]);
  return Object.freeze({
    state,
    acknowledged: true,
    rejection: null,
    events,
  });
}

export function stepPortableDecoy(
  source: PortableDecoyState,
  input: PortableDecoyStepInput,
): PortableDecoyStep {
  validateStepTime(source, input);
  const events: PortableDecoyEvent[] = [];
  let active = source.activeDeployment;
  let pendingSoundStimulus: SoundStimulus | null = null;

  const completedInvestigation = input.completedInvestigation;
  const investigationCompletedAtSeconds =
    completedInvestigation?.completedAtSeconds ?? input.nowSeconds;
  const investigationTimeValid = Number.isFinite(
    investigationCompletedAtSeconds,
  ) && investigationCompletedAtSeconds >= 0;
  if (
    active?.soundEmitted
    && completedInvestigation?.sourceType === "environment-decoy"
    && completedInvestigation.sourceId === active.sourceId
    && investigationTimeValid
    && investigationCompletedAtSeconds
      + TIME_EPSILON_SECONDS >= active.soundAtSeconds
    && investigationCompletedAtSeconds
      <= input.nowSeconds + TIME_EPSILON_SECONDS
    && investigationCompletedAtSeconds
      <= active.expiresAtSeconds + TIME_EPSILON_SECONDS
  ) {
    events.push({
      type: "investigation-completed",
      decoyId: source.definition.id,
      deploymentId: active.deploymentId,
      sourceId: active.sourceId,
      atSeconds: investigationCompletedAtSeconds,
    });
    active = null;
  } else if (
    active
    && input.nowSeconds + TIME_EPSILON_SECONDS >= active.expiresAtSeconds
  ) {
    events.push({
      type: "expired",
      decoyId: source.definition.id,
      deploymentId: active.deploymentId,
      sourceId: active.sourceId,
      atSeconds: active.expiresAtSeconds,
    });
    active = null;
  } else if (
    active
    && !active.soundEmitted
    && input.nowSeconds + TIME_EPSILON_SECONDS >= active.soundAtSeconds
  ) {
    pendingSoundStimulus = portableDecoySoundStimulus(
      source.definition,
      active,
    );
  }

  const becameReady = (
    !active
    && source.inventoryRemaining > 0
    && input.nowSeconds + TIME_EPSILON_SECONDS >= source.nextDeployAtSeconds
    && (
      source.activeDeployment !== null
      || source.updatedAtSeconds + TIME_EPSILON_SECONDS < source.nextDeployAtSeconds
    )
  );
  if (becameReady) {
    events.push({
      type: "ready",
      decoyId: source.definition.id,
      atSeconds: source.activeDeployment ? input.nowSeconds : source.nextDeployAtSeconds,
    });
  }

  const state = freezeState({
    ...source,
    activeDeployment: active,
    updatedAtSeconds: input.nowSeconds,
  });
  return Object.freeze({
    state,
    sample: samplePortableDecoy(state, input.nowSeconds),
    events: freezeEvents(events),
    pendingSoundStimulus,
    emittedSoundStimulus: pendingSoundStimulus,
  });
}

export function samplePortableDecoy(
  state: PortableDecoyState,
  nowSeconds: number,
): PortableDecoySample {
  if (!Number.isFinite(nowSeconds) || nowSeconds < 0) {
    throw new Error("Portable decoy sample time must be finite and non-negative");
  }
  if (nowSeconds + TIME_EPSILON_SECONDS < state.updatedAtSeconds) {
    throw new Error("Portable decoy sample time must not move backwards");
  }
  const active = state.activeDeployment;
  const cooldownRemainingSeconds = Math.max(0, state.nextDeployAtSeconds - nowSeconds);
  const phase: PortableDecoyPhase = active
    ? active.soundEmitted
      ? "awaiting-investigation"
      : nowSeconds + TIME_EPSILON_SECONDS >= active.soundAtSeconds
        ? "awaiting-delivery"
        : "arming"
    : state.inventoryRemaining <= 0
      ? "depleted"
      : cooldownRemainingSeconds > TIME_EPSILON_SECONDS
        ? "cooldown"
        : "ready";
  const progress = active
    ? active.soundEmitted
      ? clamp01(
          (nowSeconds - active.soundAtSeconds)
            / Math.max(active.expiresAtSeconds - active.soundAtSeconds, TIME_EPSILON_SECONDS),
        )
      : clamp01(
          (nowSeconds - active.deployedAtSeconds)
            / Math.max(active.soundAtSeconds - active.deployedAtSeconds, TIME_EPSILON_SECONDS),
        )
    : 0;
  return Object.freeze({
    phase,
    canDeploy: !active
      && state.inventoryRemaining > 0
      && cooldownRemainingSeconds <= TIME_EPSILON_SECONDS,
    inventoryRemaining: state.inventoryRemaining,
    cooldownRemainingSeconds,
    progress,
    deploymentId: active?.deploymentId ?? null,
    sourceId: active?.sourceId ?? null,
    position: active ? Object.freeze({ ...active.position }) : null,
    effectiveConfidence: active?.effectiveConfidence ?? 0,
  });
}
