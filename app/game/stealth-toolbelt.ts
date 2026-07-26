import type { LevelDefinition, Point } from "./contracts.ts";
import { distanceBetween, hasLineOfSight, isWalkable, normalizeVector } from "./navigation.ts";

/**
 * This module intentionally works in integer simulation ticks. Rendering may
 * run at any cadence, but callers must issue commands and advance the toolbelt
 * from the game's fixed-step loop.
 */
export type StealthToolKind =
  | "door-wedge"
  | "corner-mirror"
  | "temporary-blackout";

export const STEALTH_TOOL_KINDS: readonly StealthToolKind[] = Object.freeze([
  "door-wedge",
  "corner-mirror",
  "temporary-blackout",
]);

export type StealthToolRiskChannel = "sound" | "visual" | "infrastructure";

export interface StealthToolRiskDefinition {
  readonly channel: StealthToolRiskChannel;
  /** Public evidence strength offered to an adapter; never a detection result. */
  readonly strength: number;
  readonly confidence: number;
  readonly evidenceLifetimeTicks: number;
}

interface StealthToolDefinitionBase {
  readonly kind: StealthToolKind;
  readonly capacity: number;
  readonly interactionRangeCells: number;
  readonly commitmentTicks: number;
  readonly cooldownTicks: number;
  readonly effectTicks: number;
  readonly risk: StealthToolRiskDefinition;
}

export interface DoorWedgeToolDefinition extends StealthToolDefinitionBase {
  readonly kind: "door-wedge";
  /**
   * Delay proposed when the chaser publicly attempts the authored doorway.
   * The receipt explicitly forbids changing player passability.
   */
  readonly chaserTraversalDelayTicks: number;
}

export interface CornerMirrorToolDefinition extends StealthToolDefinitionBase {
  readonly kind: "corner-mirror";
  readonly observationRangeCells: number;
  readonly observationConeDegrees: number;
}

export interface TemporaryBlackoutToolDefinition extends StealthToolDefinitionBase {
  readonly kind: "temporary-blackout";
  /**
   * Legal perception multiplier. A value of zero is rejected so the adapter
   * can never turn an authored blackout into perfect invisibility.
   */
  readonly visionRangeMultiplier: number;
  readonly ambientSoundMasking: number;
}

export type StealthToolDefinition =
  | DoorWedgeToolDefinition
  | CornerMirrorToolDefinition
  | TemporaryBlackoutToolDefinition;

export interface StealthToolbeltDefinition {
  readonly id: string;
  readonly ticksPerSecond: number;
  /**
   * Hard authoring ceiling for every effect, target failsafe, and risk trace.
   * This is the domain-level guarantee that no tool creates a permanent state.
   */
  readonly maximumFailsafeTicks: number;
  readonly receiptLedgerCapacity: number;
  readonly tools: Readonly<{
    readonly "door-wedge": DoorWedgeToolDefinition;
    readonly "corner-mirror": CornerMirrorToolDefinition;
    readonly "temporary-blackout": TemporaryBlackoutToolDefinition;
  }>;
}

const risk = (
  channel: StealthToolRiskChannel,
  strength: number,
  confidence: number,
  evidenceLifetimeTicks: number,
): StealthToolRiskDefinition => Object.freeze({
  channel,
  strength,
  confidence,
  evidenceLifetimeTicks,
});

export const GOLD_STEALTH_TOOLBELT_DEFINITION: StealthToolbeltDefinition =
  Object.freeze({
    id: "gold-stealth-toolbelt",
    ticksPerSecond: 60,
    maximumFailsafeTicks: 60 * 20,
    receiptLedgerCapacity: 12,
    tools: Object.freeze({
      "door-wedge": Object.freeze({
        kind: "door-wedge",
        capacity: 2,
        interactionRangeCells: 1.45,
        commitmentTicks: 24,
        cooldownTicks: 180,
        effectTicks: 300,
        chaserTraversalDelayTicks: 72,
        risk: risk("sound", 0.34, 0.76, 240),
      }),
      "corner-mirror": Object.freeze({
        kind: "corner-mirror",
        capacity: 4,
        interactionRangeCells: 1.2,
        commitmentTicks: 9,
        cooldownTicks: 45,
        effectTicks: 90,
        observationRangeCells: 8,
        observationConeDegrees: 58,
        risk: risk("visual", 0.14, 0.58, 90),
      }),
      "temporary-blackout": Object.freeze({
        kind: "temporary-blackout",
        capacity: 1,
        interactionRangeCells: 1.5,
        commitmentTicks: 36,
        cooldownTicks: 600,
        effectTicks: 420,
        visionRangeMultiplier: 0.52,
        ambientSoundMasking: 0.3,
        risk: risk("infrastructure", 0.7, 0.9, 420),
      }),
    }),
  });

interface StealthToolTargetBase {
  readonly id: string;
  /** Public authored interaction anchor, not a runtime actor position. */
  readonly interactionPoint: Point;
}

export interface DoorWedgeTarget extends StealthToolTargetBase {
  readonly kind: "door";
  readonly routeSafetyAuditId: string;
  /** Public authored traversal axis through the narrow threshold. */
  readonly traversalAxis: "horizontal" | "vertical";
  /**
   * Must be true. Door-wedge receipts only delay chaser traversal and must not
   * alter the player's collision or navigation graph.
   */
  readonly playerPassageRemainsAvailable: boolean;
  readonly autoReleaseTicks: number;
}

export interface CornerMirrorTarget extends StealthToolTargetBase {
  readonly kind: "corner";
  readonly hasOpaqueCorner: boolean;
  /** Public view direction authored into the level. */
  readonly outwardHeading: Point;
}

export interface TemporaryBlackoutTarget extends StealthToolTargetBase {
  readonly kind: "power-circuit";
  readonly autoRestoreTicks: number;
  /**
   * Authored emergency-light floor. Values below 0.25 are rejected to retain
   * readable geometry and a fair, non-binary perception contract.
   */
  readonly emergencyVisibilityFloor: number;
}

export type StealthToolTarget =
  | DoorWedgeTarget
  | CornerMirrorTarget
  | TemporaryBlackoutTarget;

export interface StealthToolRiskEvidence {
  readonly sourceId: string;
  readonly sourceType: "stealth-tool-risk";
  readonly tool: StealthToolKind;
  readonly channel: StealthToolRiskChannel;
  readonly position: Point;
  readonly strength: number;
  readonly confidence: number;
  readonly emittedAtTick: number;
  readonly expiresAtTick: number;
}

interface StealthToolReceiptBase {
  readonly receiptId: string;
  readonly useId: string;
  readonly toolbeltId: string;
  readonly tool: StealthToolKind;
  readonly targetId: string;
  readonly issuedAtTick: number;
  readonly expiresAtTick: number;
  readonly riskEvidence: StealthToolRiskEvidence;
}

export interface DoorWedgeReceipt extends StealthToolReceiptBase {
  readonly tool: "door-wedge";
  readonly effect: Readonly<{
    readonly kind: "chaser-door-delay";
    readonly doorId: string;
    readonly traversalAxis: "horizontal" | "vertical";
    readonly delayTicksPerAttempt: number;
    readonly appliesTo: "chaser-traversal";
    readonly playerPassagePolicy: "always-passable";
    readonly autoReleaseAtTick: number;
  }>;
}

export interface CornerMirrorReceipt extends StealthToolReceiptBase {
  readonly tool: "corner-mirror";
  readonly effect: Readonly<{
    readonly kind: "public-corner-observation";
    readonly cornerId: string;
    readonly origin: Point;
    readonly heading: Point;
    readonly rangeCells: number;
    readonly coneDegrees: number;
    readonly observationEndsAtTick: number;
  }>;
}

export interface TemporaryBlackoutReceipt extends StealthToolReceiptBase {
  readonly tool: "temporary-blackout";
  readonly effect: Readonly<{
    readonly kind: "temporary-visibility-modifier";
    readonly circuitId: string;
    readonly visionRangeMultiplier: number;
    readonly emergencyVisibilityFloor: number;
    readonly ambientSoundMasking: number;
    readonly autoRestoreAtTick: number;
  }>;
}

export type StealthToolReceipt =
  | DoorWedgeReceipt
  | CornerMirrorReceipt
  | TemporaryBlackoutReceipt;

export interface StealthToolRuntime {
  readonly inventoryRemaining: number;
  readonly nextUseAtTick: number;
  readonly cooldownEventPending: boolean;
}

export interface StealthToolCommitment {
  readonly useId: string;
  readonly tool: StealthToolKind;
  readonly target: StealthToolTarget;
  readonly startedAtTick: number;
  readonly completesAtTick: number;
}

export interface StealthToolActiveEffect {
  readonly tool: StealthToolKind;
  readonly receipt: StealthToolReceipt;
  readonly endsAtTick: number;
}

export interface StealthToolbeltState {
  readonly definition: StealthToolbeltDefinition;
  readonly tick: number;
  readonly useSequence: number;
  readonly tools: Readonly<Record<StealthToolKind, StealthToolRuntime>>;
  readonly commitment: StealthToolCommitment | null;
  readonly activeEffects: Readonly<Partial<Record<StealthToolKind, StealthToolActiveEffect>>>;
  /** Bounded telemetry/audit history; authoritative effects live above. */
  readonly receiptLedger: readonly StealthToolReceipt[];
}

export type StealthToolUseRejection =
  | "invalid-tick"
  | "tick-mismatch"
  | "commitment-active"
  | "inventory-empty"
  | "cooldown-active"
  | "effect-active"
  | "invalid-actor-position"
  | "actor-not-walkable"
  | "target-kind-mismatch"
  | "invalid-target"
  | "target-not-walkable"
  | "out-of-range"
  | "interaction-blocked"
  | "unsafe-door-target"
  | "unsafe-mirror-target"
  | "unsafe-blackout-target";

export interface BeginStealthToolUseInput {
  readonly tick: number;
  readonly tool: StealthToolKind;
  readonly actorPosition: Point;
  readonly target: StealthToolTarget;
}

export type StealthToolEvent =
  | {
      readonly type: "tool-use-started";
      readonly tool: StealthToolKind;
      readonly useId: string;
      readonly targetId: string;
      readonly atTick: number;
      readonly completesAtTick: number;
      readonly inventoryRemaining: number;
    }
  | {
      readonly type: "tool-commitment-completed";
      readonly tool: StealthToolKind;
      readonly useId: string;
      readonly receipt: StealthToolReceipt;
      readonly atTick: number;
    }
  | {
      readonly type: "tool-risk-emitted";
      readonly tool: StealthToolKind;
      readonly useId: string;
      readonly evidence: StealthToolRiskEvidence;
      readonly atTick: number;
    }
  | {
      readonly type: "tool-effect-ended";
      readonly tool: StealthToolKind;
      readonly useId: string;
      readonly receiptId: string;
      readonly reason: "failsafe";
      readonly atTick: number;
    }
  | {
      readonly type: "tool-cooldown-ended";
      readonly tool: StealthToolKind;
      readonly atTick: number;
    };

export interface BeginStealthToolUseResult {
  readonly state: StealthToolbeltState;
  readonly accepted: boolean;
  readonly rejection: StealthToolUseRejection | null;
  readonly events: readonly StealthToolEvent[];
  readonly receipts: readonly StealthToolReceipt[];
}

export interface AdvanceStealthToolbeltResult {
  readonly state: StealthToolbeltState;
  readonly events: readonly StealthToolEvent[];
  readonly receipts: readonly StealthToolReceipt[];
}

export type StealthToolPhase =
  | "ready"
  | "commitment"
  | "active"
  | "cooldown"
  | "depleted";

export interface StealthToolSample {
  readonly tool: StealthToolKind;
  readonly phase: StealthToolPhase;
  readonly canUse: boolean;
  readonly inventoryRemaining: number;
  readonly commitmentRemainingTicks: number;
  readonly cooldownRemainingTicks: number;
  readonly effectRemainingTicks: number;
}

export interface StealthToolbeltSample {
  readonly tick: number;
  readonly tools: Readonly<Record<StealthToolKind, StealthToolSample>>;
}

export interface StealthToolbeltSafetyAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

const finitePoint = (point: Point) => (
  Number.isFinite(point.x) && Number.isFinite(point.y)
);

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;
const inUnitInterval = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
const nonEmpty = (value: string) => Boolean(value.trim());

function freezePoint(point: Point): Point {
  return Object.freeze({ ...point });
}

function freezeRiskDefinition(value: StealthToolRiskDefinition): StealthToolRiskDefinition {
  return Object.freeze({ ...value });
}

function freezeToolDefinition(value: DoorWedgeToolDefinition): DoorWedgeToolDefinition;
function freezeToolDefinition(value: CornerMirrorToolDefinition): CornerMirrorToolDefinition;
function freezeToolDefinition(
  value: TemporaryBlackoutToolDefinition,
): TemporaryBlackoutToolDefinition;
function freezeToolDefinition(value: StealthToolDefinition): StealthToolDefinition {
  if (value.kind === "door-wedge") {
    return Object.freeze({ ...value, risk: freezeRiskDefinition(value.risk) });
  }
  if (value.kind === "corner-mirror") {
    return Object.freeze({ ...value, risk: freezeRiskDefinition(value.risk) });
  }
  return Object.freeze({ ...value, risk: freezeRiskDefinition(value.risk) });
}

function freezeDefinition(value: StealthToolbeltDefinition): StealthToolbeltDefinition {
  return Object.freeze({
    ...value,
    tools: Object.freeze({
      "door-wedge": freezeToolDefinition(value.tools["door-wedge"]),
      "corner-mirror": freezeToolDefinition(value.tools["corner-mirror"]),
      "temporary-blackout": freezeToolDefinition(value.tools["temporary-blackout"]),
    }),
  });
}

function freezeTarget(target: StealthToolTarget): StealthToolTarget {
  if (target.kind === "corner") {
    return Object.freeze({
      ...target,
      interactionPoint: freezePoint(target.interactionPoint),
      outwardHeading: freezePoint(target.outwardHeading),
    });
  }
  return Object.freeze({
    ...target,
    interactionPoint: freezePoint(target.interactionPoint),
  });
}

function freezeRiskEvidence(value: StealthToolRiskEvidence): StealthToolRiskEvidence {
  return Object.freeze({
    ...value,
    position: freezePoint(value.position),
  });
}

function freezeReceipt(receipt: StealthToolReceipt): StealthToolReceipt {
  const riskEvidence = freezeRiskEvidence(receipt.riskEvidence);
  if (receipt.tool === "corner-mirror") {
    return Object.freeze({
      ...receipt,
      riskEvidence,
      effect: Object.freeze({
        ...receipt.effect,
        origin: freezePoint(receipt.effect.origin),
        heading: freezePoint(receipt.effect.heading),
      }),
    });
  }
  return Object.freeze({
    ...receipt,
    riskEvidence,
    effect: Object.freeze({ ...receipt.effect }),
  }) as StealthToolReceipt;
}

function freezeEvent(event: StealthToolEvent): StealthToolEvent {
  if (event.type === "tool-commitment-completed") {
    return Object.freeze({ ...event, receipt: freezeReceipt(event.receipt) });
  }
  if (event.type === "tool-risk-emitted") {
    return Object.freeze({ ...event, evidence: freezeRiskEvidence(event.evidence) });
  }
  return Object.freeze({ ...event });
}

function freezeEvents(events: readonly StealthToolEvent[]): readonly StealthToolEvent[] {
  return Object.freeze(events.map(freezeEvent));
}

function freezeReceipts(receipts: readonly StealthToolReceipt[]): readonly StealthToolReceipt[] {
  return Object.freeze(receipts.map(freezeReceipt));
}

function freezeState(state: StealthToolbeltState): StealthToolbeltState {
  const effects: Partial<Record<StealthToolKind, StealthToolActiveEffect>> = {};
  for (const kind of STEALTH_TOOL_KINDS) {
    const active = state.activeEffects[kind];
    if (active) {
      effects[kind] = Object.freeze({
        ...active,
        receipt: freezeReceipt(active.receipt),
      });
    }
  }
  return Object.freeze({
    ...state,
    definition: freezeDefinition(state.definition),
    tools: Object.freeze({
      "door-wedge": Object.freeze({ ...state.tools["door-wedge"] }),
      "corner-mirror": Object.freeze({ ...state.tools["corner-mirror"] }),
      "temporary-blackout": Object.freeze({ ...state.tools["temporary-blackout"] }),
    }),
    commitment: state.commitment
      ? Object.freeze({
          ...state.commitment,
          target: freezeTarget(state.commitment.target),
        })
      : null,
    activeEffects: Object.freeze(effects),
    receiptLedger: freezeReceipts(state.receiptLedger),
  });
}

export function auditStealthToolbeltDefinition(
  definition: StealthToolbeltDefinition,
): StealthToolbeltSafetyAudit {
  const failures: string[] = [];
  if (!nonEmpty(definition.id)) failures.push("toolbelt id must not be empty");
  if (!isPositiveInteger(definition.ticksPerSecond)) {
    failures.push("ticksPerSecond must be a positive integer");
  }
  if (!isPositiveInteger(definition.maximumFailsafeTicks)) {
    failures.push("maximumFailsafeTicks must be a positive integer");
  }
  if (
    !isPositiveInteger(definition.receiptLedgerCapacity)
    || definition.receiptLedgerCapacity > 64
  ) {
    failures.push("receiptLedgerCapacity must be an integer in [1, 64]");
  }

  for (const kind of STEALTH_TOOL_KINDS) {
    const tool = definition.tools[kind];
    if (!tool || tool.kind !== kind) {
      failures.push(`${kind} definition is missing or mismatched`);
      continue;
    }
    if (!isPositiveInteger(tool.capacity)) failures.push(`${kind} capacity must be positive`);
    if (!Number.isFinite(tool.interactionRangeCells) || tool.interactionRangeCells <= 0) {
      failures.push(`${kind} interaction range must be finite and positive`);
    }
    for (const [field, value] of [
      ["commitmentTicks", tool.commitmentTicks],
      ["cooldownTicks", tool.cooldownTicks],
      ["effectTicks", tool.effectTicks],
      ["risk.evidenceLifetimeTicks", tool.risk.evidenceLifetimeTicks],
    ] as const) {
      if (!isPositiveInteger(value)) failures.push(`${kind} ${field} must be positive`);
      if (value > definition.maximumFailsafeTicks) {
        failures.push(`${kind} ${field} exceeds the failsafe ceiling`);
      }
    }
    if (!inUnitInterval(tool.risk.strength) || !inUnitInterval(tool.risk.confidence)) {
      failures.push(`${kind} risk strength and confidence must be in [0, 1]`);
    }
  }

  const wedge = definition.tools["door-wedge"];
  if (
    !isPositiveInteger(wedge.chaserTraversalDelayTicks)
    || wedge.chaserTraversalDelayTicks > wedge.effectTicks
  ) {
    failures.push("door-wedge traversal delay must be positive and no longer than its effect");
  }
  const mirror = definition.tools["corner-mirror"];
  if (!Number.isFinite(mirror.observationRangeCells) || mirror.observationRangeCells <= 0) {
    failures.push("corner-mirror observation range must be finite and positive");
  }
  if (
    !Number.isFinite(mirror.observationConeDegrees)
    || mirror.observationConeDegrees <= 0
    || mirror.observationConeDegrees > 120
  ) {
    failures.push("corner-mirror observation cone must be in (0, 120]");
  }
  const blackout = definition.tools["temporary-blackout"];
  if (
    !Number.isFinite(blackout.visionRangeMultiplier)
    || blackout.visionRangeMultiplier < 0.25
    || blackout.visionRangeMultiplier > 1
  ) {
    failures.push("temporary-blackout vision multiplier must be in [0.25, 1]");
  }
  if (
    !Number.isFinite(blackout.ambientSoundMasking)
    || blackout.ambientSoundMasking < 0
    || blackout.ambientSoundMasking > 0.75
  ) {
    failures.push("temporary-blackout sound masking must be in [0, 0.75]");
  }

  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

export function createStealthToolbeltState(
  definition: StealthToolbeltDefinition = GOLD_STEALTH_TOOLBELT_DEFINITION,
  initialTick = 0,
): StealthToolbeltState {
  const audit = auditStealthToolbeltDefinition(definition);
  if (!audit.passed) {
    throw new Error(`Invalid stealth toolbelt definition: ${audit.failures.join("; ")}`);
  }
  if (!Number.isInteger(initialTick) || initialTick < 0) {
    throw new Error("Stealth toolbelt initial tick must be a non-negative integer");
  }
  const runtime = (capacity: number): StealthToolRuntime => ({
    inventoryRemaining: capacity,
    nextUseAtTick: initialTick,
    cooldownEventPending: false,
  });
  return freezeState({
    definition,
    tick: initialTick,
    useSequence: 0,
    tools: {
      "door-wedge": runtime(definition.tools["door-wedge"].capacity),
      "corner-mirror": runtime(definition.tools["corner-mirror"].capacity),
      "temporary-blackout": runtime(definition.tools["temporary-blackout"].capacity),
    },
    commitment: null,
    activeEffects: {},
    receiptLedger: [],
  });
}

function rejectedUse(
  state: StealthToolbeltState,
  rejection: StealthToolUseRejection,
): BeginStealthToolUseResult {
  return Object.freeze({
    state,
    accepted: false,
    rejection,
    events: Object.freeze([]),
    receipts: Object.freeze([]),
  });
}

function expectedTargetKind(tool: StealthToolKind): StealthToolTarget["kind"] {
  if (tool === "door-wedge") return "door";
  if (tool === "corner-mirror") return "corner";
  return "power-circuit";
}

function targetSafetyRejection(
  definition: StealthToolbeltDefinition,
  target: StealthToolTarget,
): StealthToolUseRejection | null {
  if (!nonEmpty(target.id) || !finitePoint(target.interactionPoint)) return "invalid-target";
  if (target.kind === "door") {
    if (
      !nonEmpty(target.routeSafetyAuditId)
      || !["horizontal", "vertical"].includes(target.traversalAxis)
      || !target.playerPassageRemainsAvailable
      || !isPositiveInteger(target.autoReleaseTicks)
      || target.autoReleaseTicks > definition.maximumFailsafeTicks
    ) return "unsafe-door-target";
  } else if (target.kind === "corner") {
    if (
      !target.hasOpaqueCorner
      || !finitePoint(target.outwardHeading)
      || Math.hypot(target.outwardHeading.x, target.outwardHeading.y) < 0.5
    ) return "unsafe-mirror-target";
  } else if (
    !isPositiveInteger(target.autoRestoreTicks)
    || target.autoRestoreTicks > definition.maximumFailsafeTicks
    || !Number.isFinite(target.emergencyVisibilityFloor)
    || target.emergencyVisibilityFloor < 0.25
    || target.emergencyVisibilityFloor > 1
  ) {
    return "unsafe-blackout-target";
  }
  return null;
}

export function beginStealthToolUse(
  source: StealthToolbeltState,
  level: LevelDefinition,
  input: BeginStealthToolUseInput,
): BeginStealthToolUseResult {
  if (!Number.isInteger(input.tick) || input.tick < 0) {
    return rejectedUse(source, "invalid-tick");
  }
  if (input.tick !== source.tick) return rejectedUse(source, "tick-mismatch");
  if (source.commitment) return rejectedUse(source, "commitment-active");

  const runtime = source.tools[input.tool];
  if (runtime.inventoryRemaining <= 0) return rejectedUse(source, "inventory-empty");
  if (input.tick < runtime.nextUseAtTick) return rejectedUse(source, "cooldown-active");
  if (source.activeEffects[input.tool]) return rejectedUse(source, "effect-active");
  if (!finitePoint(input.actorPosition)) return rejectedUse(source, "invalid-actor-position");
  if (!isWalkable(level, input.actorPosition)) return rejectedUse(source, "actor-not-walkable");
  if (input.target.kind !== expectedTargetKind(input.tool)) {
    return rejectedUse(source, "target-kind-mismatch");
  }
  const targetRejection = targetSafetyRejection(source.definition, input.target);
  if (targetRejection) return rejectedUse(source, targetRejection);
  if (!isWalkable(level, input.target.interactionPoint)) {
    return rejectedUse(source, "target-not-walkable");
  }

  const definition = source.definition.tools[input.tool];
  if (
    distanceBetween(input.actorPosition, input.target.interactionPoint)
      > definition.interactionRangeCells + Number.EPSILON
  ) return rejectedUse(source, "out-of-range");
  if (!hasLineOfSight(level, input.actorPosition, input.target.interactionPoint)) {
    return rejectedUse(source, "interaction-blocked");
  }

  const useSequence = source.useSequence + 1;
  const useId = `${source.definition.id}:use:${useSequence}`;
  const completesAtTick = input.tick + definition.commitmentTicks;
  const inventoryRemaining = runtime.inventoryRemaining - 1;
  const tools = {
    ...source.tools,
    [input.tool]: {
      inventoryRemaining,
      nextUseAtTick: input.tick + definition.cooldownTicks,
      cooldownEventPending: true,
    },
  };
  const commitment: StealthToolCommitment = {
    useId,
    tool: input.tool,
    target: input.target,
    startedAtTick: input.tick,
    completesAtTick,
  };
  const state = freezeState({
    ...source,
    useSequence,
    tools,
    commitment,
  });
  const events = freezeEvents([{
    type: "tool-use-started",
    tool: input.tool,
    useId,
    targetId: input.target.id,
    atTick: input.tick,
    completesAtTick,
    inventoryRemaining,
  }]);
  return Object.freeze({
    state,
    accepted: true,
    rejection: null,
    events,
    receipts: Object.freeze([]),
  });
}

function effectiveDurationTicks(
  definition: StealthToolDefinition,
  target: StealthToolTarget,
): number {
  if (definition.kind === "door-wedge" && target.kind === "door") {
    return Math.min(definition.effectTicks, target.autoReleaseTicks);
  }
  if (definition.kind === "temporary-blackout" && target.kind === "power-circuit") {
    return Math.min(definition.effectTicks, target.autoRestoreTicks);
  }
  return definition.effectTicks;
}

function createReceipt(
  toolbelt: StealthToolbeltDefinition,
  commitment: StealthToolCommitment,
): StealthToolReceipt {
  const definition = toolbelt.tools[commitment.tool];
  const issuedAtTick = commitment.completesAtTick;
  const expiresAtTick = issuedAtTick + effectiveDurationTicks(definition, commitment.target);
  const receiptId = `${commitment.useId}:receipt`;
  const riskEvidence: StealthToolRiskEvidence = {
    sourceId: `${commitment.useId}:risk`,
    sourceType: "stealth-tool-risk",
    tool: commitment.tool,
    channel: definition.risk.channel,
    position: commitment.target.interactionPoint,
    strength: definition.risk.strength,
    confidence: definition.risk.confidence,
    emittedAtTick: issuedAtTick,
    expiresAtTick: issuedAtTick + definition.risk.evidenceLifetimeTicks,
  };

  if (commitment.tool === "door-wedge" && commitment.target.kind === "door") {
    const wedgeDefinition = toolbelt.tools["door-wedge"];
    return freezeReceipt({
      receiptId,
      useId: commitment.useId,
      toolbeltId: toolbelt.id,
      tool: "door-wedge",
      targetId: commitment.target.id,
      issuedAtTick,
      expiresAtTick,
      riskEvidence,
      effect: {
        kind: "chaser-door-delay",
        doorId: commitment.target.id,
        traversalAxis: commitment.target.traversalAxis,
        delayTicksPerAttempt: wedgeDefinition.chaserTraversalDelayTicks,
        appliesTo: "chaser-traversal",
        playerPassagePolicy: "always-passable",
        autoReleaseAtTick: expiresAtTick,
      },
    });
  }
  if (commitment.tool === "corner-mirror" && commitment.target.kind === "corner") {
    const mirrorDefinition = toolbelt.tools["corner-mirror"];
    return freezeReceipt({
      receiptId,
      useId: commitment.useId,
      toolbeltId: toolbelt.id,
      tool: "corner-mirror",
      targetId: commitment.target.id,
      issuedAtTick,
      expiresAtTick,
      riskEvidence,
      effect: {
        kind: "public-corner-observation",
        cornerId: commitment.target.id,
        origin: commitment.target.interactionPoint,
        heading: normalizeVector(commitment.target.outwardHeading),
        rangeCells: mirrorDefinition.observationRangeCells,
        coneDegrees: mirrorDefinition.observationConeDegrees,
        observationEndsAtTick: expiresAtTick,
      },
    });
  }
  if (commitment.tool === "temporary-blackout" && commitment.target.kind === "power-circuit") {
    const blackoutDefinition = toolbelt.tools["temporary-blackout"];
    return freezeReceipt({
      receiptId,
      useId: commitment.useId,
      toolbeltId: toolbelt.id,
      tool: "temporary-blackout",
      targetId: commitment.target.id,
      issuedAtTick,
      expiresAtTick,
      riskEvidence,
      effect: {
        kind: "temporary-visibility-modifier",
        circuitId: commitment.target.id,
        visionRangeMultiplier: Math.max(
          blackoutDefinition.visionRangeMultiplier,
          commitment.target.emergencyVisibilityFloor,
        ),
        emergencyVisibilityFloor: commitment.target.emergencyVisibilityFloor,
        ambientSoundMasking: blackoutDefinition.ambientSoundMasking,
        autoRestoreAtTick: expiresAtTick,
      },
    });
  }
  throw new Error("Stealth tool commitment target no longer matches its definition");
}

function nextBoundaryTick(state: StealthToolbeltState, toTick: number): number | null {
  let next = Number.POSITIVE_INFINITY;
  const commitmentTick = state.commitment?.completesAtTick;
  if (commitmentTick !== undefined && commitmentTick > state.tick && commitmentTick <= toTick) {
    next = Math.min(next, commitmentTick);
  }
  for (const kind of STEALTH_TOOL_KINDS) {
    const effectTick = state.activeEffects[kind]?.endsAtTick;
    if (effectTick !== undefined && effectTick > state.tick && effectTick <= toTick) {
      next = Math.min(next, effectTick);
    }
    const runtime = state.tools[kind];
    if (
      runtime.cooldownEventPending
      && runtime.nextUseAtTick > state.tick
      && runtime.nextUseAtTick <= toTick
    ) {
      next = Math.min(next, runtime.nextUseAtTick);
    }
  }
  return Number.isFinite(next) ? next : null;
}

function advanceToBoundary(
  source: StealthToolbeltState,
  boundaryTick: number,
): {
  readonly state: StealthToolbeltState;
  readonly events: readonly StealthToolEvent[];
  readonly receipts: readonly StealthToolReceipt[];
} {
  const events: StealthToolEvent[] = [];
  const receipts: StealthToolReceipt[] = [];
  const tools: Record<StealthToolKind, StealthToolRuntime> = {
    "door-wedge": { ...source.tools["door-wedge"] },
    "corner-mirror": { ...source.tools["corner-mirror"] },
    "temporary-blackout": { ...source.tools["temporary-blackout"] },
  };
  const activeEffects: Partial<Record<StealthToolKind, StealthToolActiveEffect>> = {
    ...source.activeEffects,
  };
  let commitment = source.commitment;
  let ledger = [...source.receiptLedger];

  // Release old effects first, so a same-tick completion always observes the
  // released public state regardless of object iteration or render cadence.
  for (const kind of STEALTH_TOOL_KINDS) {
    const active = activeEffects[kind];
    if (active?.endsAtTick === boundaryTick) {
      delete activeEffects[kind];
      events.push({
        type: "tool-effect-ended",
        tool: kind,
        useId: active.receipt.useId,
        receiptId: active.receipt.receiptId,
        reason: "failsafe",
        atTick: boundaryTick,
      });
    }
  }

  if (commitment?.completesAtTick === boundaryTick) {
    const receipt = createReceipt(source.definition, commitment);
    receipts.push(receipt);
    ledger.push(receipt);
    ledger = ledger.slice(-source.definition.receiptLedgerCapacity);
    activeEffects[commitment.tool] = {
      tool: commitment.tool,
      receipt,
      endsAtTick: receipt.expiresAtTick,
    };
    events.push({
      type: "tool-commitment-completed",
      tool: commitment.tool,
      useId: commitment.useId,
      receipt,
      atTick: boundaryTick,
    });
    events.push({
      type: "tool-risk-emitted",
      tool: commitment.tool,
      useId: commitment.useId,
      evidence: receipt.riskEvidence,
      atTick: boundaryTick,
    });
    commitment = null;
  }

  for (const kind of STEALTH_TOOL_KINDS) {
    const runtime = tools[kind];
    if (runtime.cooldownEventPending && runtime.nextUseAtTick === boundaryTick) {
      tools[kind] = {
        ...runtime,
        cooldownEventPending: false,
      };
      events.push({
        type: "tool-cooldown-ended",
        tool: kind,
        atTick: boundaryTick,
      });
    }
  }

  return {
    state: freezeState({
      ...source,
      tick: boundaryTick,
      tools,
      commitment,
      activeEffects,
      receiptLedger: ledger,
    }),
    events: freezeEvents(events),
    receipts: freezeReceipts(receipts),
  };
}

export function advanceStealthToolbelt(
  source: StealthToolbeltState,
  toTick: number,
): AdvanceStealthToolbeltResult {
  if (!Number.isInteger(toTick) || toTick < 0) {
    throw new Error("Stealth toolbelt target tick must be a non-negative integer");
  }
  if (toTick < source.tick) {
    throw new Error("Stealth toolbelt time must not move backwards");
  }

  let state = source;
  const events: StealthToolEvent[] = [];
  const receipts: StealthToolReceipt[] = [];
  for (
    let boundary = nextBoundaryTick(state, toTick);
    boundary !== null;
    boundary = nextBoundaryTick(state, toTick)
  ) {
    const advanced = advanceToBoundary(state, boundary);
    state = advanced.state;
    events.push(...advanced.events);
    receipts.push(...advanced.receipts);
  }
  if (state.tick !== toTick) {
    state = freezeState({ ...state, tick: toTick });
  }
  return Object.freeze({
    state,
    events: freezeEvents(events),
    receipts: freezeReceipts(receipts),
  });
}

export function sampleStealthToolbelt(
  state: StealthToolbeltState,
): StealthToolbeltSample {
  const samples = {} as Record<StealthToolKind, StealthToolSample>;
  for (const kind of STEALTH_TOOL_KINDS) {
    const runtime = state.tools[kind];
    const commitment = state.commitment?.tool === kind ? state.commitment : null;
    const active = state.activeEffects[kind];
    const cooldownRemainingTicks = Math.max(0, runtime.nextUseAtTick - state.tick);
    const phase: StealthToolPhase = commitment
      ? "commitment"
      : active
        ? "active"
        : runtime.inventoryRemaining <= 0
          ? "depleted"
          : cooldownRemainingTicks > 0
            ? "cooldown"
            : "ready";
    samples[kind] = Object.freeze({
      tool: kind,
      phase,
      canUse: phase === "ready" && state.commitment === null,
      inventoryRemaining: runtime.inventoryRemaining,
      commitmentRemainingTicks: commitment
        ? Math.max(0, commitment.completesAtTick - state.tick)
        : 0,
      cooldownRemainingTicks,
      effectRemainingTicks: active ? Math.max(0, active.endsAtTick - state.tick) : 0,
    });
  }
  return Object.freeze({
    tick: state.tick,
    tools: Object.freeze(samples),
  });
}

export function stealthToolTicksToSeconds(
  definition: StealthToolbeltDefinition,
  ticks: number,
): number {
  if (!Number.isInteger(ticks) || ticks < 0) {
    throw new Error("Stealth tool duration must be a non-negative integer tick count");
  }
  return ticks / definition.ticksPerSecond;
}
