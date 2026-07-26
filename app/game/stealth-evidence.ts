import type { Point } from "./contracts.ts";

export const STEALTH_EVIDENCE_VERSION = 1;
export const STEALTH_EVIDENCE_ID_MAX_LENGTH = 120;
export const STEALTH_EVIDENCE_DEFINITION_ID_MAX_LENGTH = 80;
export const STEALTH_EVIDENCE_RECORD_ID_MAX_LENGTH = 180;
export const STEALTH_EVIDENCE_MAX_COORDINATE = 1_000_000;
export const STEALTH_EVIDENCE_MAX_TICK = 2_147_483_647;
export const STEALTH_EVIDENCE_MAX_BUDGET = 1_000_000;
export const STEALTH_EVIDENCE_MAX_SERIAL = 2_147_483_647;

export const STEALTH_EVIDENCE_KINDS = Object.freeze([
  "footprint",
  "door-state",
  "moved-object",
  "power-change",
  "decoy-residue",
] as const);

export type StealthEvidenceKind = typeof STEALTH_EVIDENCE_KINDS[number];

export type EvidencePublicity = "world-observable" | "publicly-announced";
export type EvidenceSourceKind =
  | "surface"
  | "door"
  | "object"
  | "power-grid"
  | "decoy";

export interface PublicEvidenceSource {
  /**
   * Stable authored world identity. This must identify a public surface,
   * fixture, object, grid or decoy — never a player/session/account.
   */
  readonly publicId: string;
  readonly kind: EvidenceSourceKind;
  readonly publicity: EvidencePublicity;
}

export interface FootprintEvidenceDetail {
  readonly direction: Point;
}

export interface DoorStateEvidenceDetail {
  readonly state: "open" | "closed" | "forced";
}

export interface MovedObjectEvidenceDetail {
  readonly state: "moved" | "restored" | "missing";
}

export interface PowerChangeEvidenceDetail {
  readonly state: "online" | "offline" | "unstable";
}

export interface DecoyResidueEvidenceDetail {
  readonly state: "fresh" | "spent";
}

export type PublicEvidenceObservation =
  | {
      readonly kind: "footprint";
      readonly position: Point;
      readonly source: PublicEvidenceSource & { readonly kind: "surface" };
      readonly detail: FootprintEvidenceDetail;
      readonly confidenceScale?: number;
    }
  | {
      readonly kind: "door-state";
      readonly position: Point;
      readonly source: PublicEvidenceSource & { readonly kind: "door" };
      readonly detail: DoorStateEvidenceDetail;
      readonly confidenceScale?: number;
    }
  | {
      readonly kind: "moved-object";
      readonly position: Point;
      readonly source: PublicEvidenceSource & { readonly kind: "object" };
      readonly detail: MovedObjectEvidenceDetail;
      readonly confidenceScale?: number;
    }
  | {
      readonly kind: "power-change";
      readonly position: Point;
      readonly source: PublicEvidenceSource & { readonly kind: "power-grid" };
      readonly detail: PowerChangeEvidenceDetail;
      readonly confidenceScale?: number;
    }
  | {
      readonly kind: "decoy-residue";
      readonly position: Point;
      readonly source: PublicEvidenceSource & { readonly kind: "decoy" };
      readonly detail: DecoyResidueEvidenceDetail;
      readonly confidenceScale?: number;
    };

export interface CountermeasureCost {
  readonly budgetUnits: number;
  readonly commitmentTicks: number;
  /**
   * Public disturbance proposal for the owning runtime. The evidence domain
   * does not inject sound directly, so delivery remains explicit/auditable.
   */
  readonly publicNoiseStrength: number;
}

export interface StealthEvidenceKindRule {
  readonly initialConfidence: number;
  readonly decayPerTick: number;
  readonly lifetimeTicks: number;
  readonly aiPriority: number;
  readonly erase: CountermeasureCost | null;
  readonly forge: (CountermeasureCost & {
    readonly confidenceMultiplier: number;
  }) | null;
}

export interface StealthEvidenceDefinition {
  readonly version: typeof STEALTH_EVIDENCE_VERSION;
  readonly id: string;
  readonly fixedStepSeconds: number;
  readonly maximumRecords: number;
  readonly countermeasureBudget: number;
  readonly minimumRetainedConfidence: number;
  readonly minimumAiConfidence: number;
  readonly rules: Readonly<Record<StealthEvidenceKind, StealthEvidenceKindRule>>;
}

type EvidenceOrigin = "authentic" | "fabricated";

/**
 * Authoritative ledger entry. `origin` is deliberately private to this domain
 * boundary and is never present in AiEvidenceView.
 */
export interface StealthEvidenceRecord {
  readonly id: string;
  readonly kind: StealthEvidenceKind;
  readonly position: Point;
  readonly source: PublicEvidenceSource;
  readonly detail:
    | FootprintEvidenceDetail
    | DoorStateEvidenceDetail
    | MovedObjectEvidenceDetail
    | PowerChangeEvidenceDetail
    | DecoyResidueEvidenceDetail;
  readonly createdAtTick: number;
  readonly expiresAtTick: number;
  readonly initialConfidence: number;
  readonly decayPerTick: number;
  readonly origin: EvidenceOrigin;
}

export interface StealthEvidenceState {
  readonly version: typeof STEALTH_EVIDENCE_VERSION;
  readonly definition: StealthEvidenceDefinition;
  readonly tick: number;
  readonly nextEvidenceSerial: number;
  readonly countermeasureBudgetRemaining: number;
  readonly countermeasureBudgetSpent: number;
  readonly countermeasureBusyUntilTick: number;
  readonly erasedEvidenceCount: number;
  readonly forgedEvidenceCount: number;
  readonly records: readonly StealthEvidenceRecord[];
}

export type StealthEvidenceCommand =
  | {
      readonly type: "advance";
      readonly tick: number;
    }
  | {
      readonly type: "record";
      readonly tick: number;
      readonly observation: PublicEvidenceObservation;
    }
  | {
      readonly type: "erase";
      readonly tick: number;
      readonly evidenceId: string;
    }
  | {
      readonly type: "forge";
      readonly tick: number;
      readonly observation: PublicEvidenceObservation;
    };

export type StealthEvidenceRejection =
  | "invalid-command"
  | "unknown-command"
  | "invalid-tick"
  | "tick-overflow"
  | "time-regression"
  | "invalid-evidence-id"
  | "invalid-position"
  | "invalid-source"
  | "source-kind-mismatch"
  | "invalid-detail"
  | "invalid-confidence-scale"
  | "confidence-below-retention"
  | "evidence-capacity-exhausted"
  | "evidence-not-found"
  | "countermeasure-busy"
  | "insufficient-countermeasure-budget"
  | "evidence-not-erasable"
  | "evidence-not-forgeable"
  | "public-announcement-not-forgeable";

export interface AiEvidenceView {
  readonly id: string;
  readonly kind: StealthEvidenceKind;
  readonly position: Point;
  readonly source: PublicEvidenceSource;
  readonly detail:
    | FootprintEvidenceDetail
    | DoorStateEvidenceDetail
    | MovedObjectEvidenceDetail
    | PowerChangeEvidenceDetail
    | DecoyResidueEvidenceDetail;
  readonly createdAtTick: number;
  readonly ageTicks: number;
  readonly expiresAtTick: number;
  readonly confidence: number;
}

export type StealthEvidenceEvent =
  | {
      readonly type: "command-rejected";
      readonly commandType: string;
      readonly reason: StealthEvidenceRejection;
      readonly atTick: number;
    }
  | {
      readonly type: "evidence-recorded";
      readonly evidence: AiEvidenceView;
      readonly atTick: number;
    }
  | {
      readonly type: "evidence-forged";
      readonly evidence: AiEvidenceView;
      readonly atTick: number;
    }
  | {
      readonly type: "evidence-erased";
      readonly evidenceId: string;
      readonly kind: StealthEvidenceKind;
      readonly source: PublicEvidenceSource;
      readonly atTick: number;
    }
  | {
      readonly type: "evidence-expired";
      readonly evidenceId: string;
      readonly kind: StealthEvidenceKind;
      readonly source: PublicEvidenceSource;
      readonly atTick: number;
    }
  | {
      readonly type: "evidence-superseded";
      readonly evidenceId: string;
      readonly replacementEvidenceId: string;
      readonly kind: StealthEvidenceKind;
      readonly source: PublicEvidenceSource;
      readonly atTick: number;
    }
  | {
      readonly type: "evidence-evicted";
      readonly evidenceId: string;
      readonly kind: StealthEvidenceKind;
      readonly source: PublicEvidenceSource;
      readonly atTick: number;
    }
  | {
      readonly type: "evidence-discarded";
      readonly evidence: AiEvidenceView;
      readonly reason: "lower-ranked-than-retained-evidence";
      readonly atTick: number;
    }
  | {
      readonly type: "countermeasure-cost-paid";
      readonly action: "erase" | "forge";
      readonly budgetSpent: number;
      readonly budgetRemaining: number;
      readonly commitmentEndsAtTick: number;
      readonly publicNoiseStrength: number;
      readonly atTick: number;
    };

export interface StealthEvidenceStep {
  readonly state: StealthEvidenceState;
  readonly accepted: boolean;
  readonly rejection: StealthEvidenceRejection | null;
  readonly events: readonly StealthEvidenceEvent[];
}

export interface AiEvidenceObserver {
  /** Public chaser/observer position, never the hidden player's position. */
  readonly position: Point;
  readonly heading: Point;
}

export interface AiEvidenceQuery {
  readonly atTick: number;
  readonly observer: AiEvidenceObserver;
  readonly maximumDistance: number;
  readonly fieldOfViewDegrees: number;
  readonly minimumConfidence?: number;
  readonly kinds?: readonly StealthEvidenceKind[];
  readonly limit?: number;
}

export interface AiEvidenceCandidate {
  readonly evidence: AiEvidenceView;
  readonly distance: number;
  readonly headingAlignment: number;
  readonly investigationScore: number;
}

/**
 * These callbacks must consult only authored/public geometry. They receive no
 * ledger state, origin marker, player position, hide occupancy or actor id.
 */
export interface AiEvidencePublicGeometry {
  readonly isVisible?: (
    observerPosition: Readonly<Point>,
    evidencePosition: Readonly<Point>,
    evidence: AiEvidenceView,
  ) => boolean;
  readonly isReachable?: (
    observerPosition: Readonly<Point>,
    evidencePosition: Readonly<Point>,
    evidence: AiEvidenceView,
  ) => boolean;
}

export interface StealthEvidenceReplay {
  readonly state: StealthEvidenceState;
  readonly events: readonly StealthEvidenceEvent[];
  readonly fingerprint: string;
}

const SOURCE_KIND_FOR_EVIDENCE: Readonly<Record<StealthEvidenceKind, EvidenceSourceKind>> =
  Object.freeze({
    footprint: "surface",
    "door-state": "door",
    "moved-object": "object",
    "power-change": "power-grid",
    "decoy-residue": "decoy",
  });

const STATEFUL_EVIDENCE_KINDS: ReadonlySet<StealthEvidenceKind> = new Set([
  "door-state",
  "moved-object",
  "power-change",
  "decoy-residue",
]);

const ALLOWED_COMMAND_KEYS: Readonly<Record<StealthEvidenceCommand["type"], readonly string[]>> =
  Object.freeze({
    advance: Object.freeze(["type", "tick"]),
    record: Object.freeze(["type", "tick", "observation"]),
    erase: Object.freeze(["type", "tick", "evidenceId"]),
    forge: Object.freeze(["type", "tick", "observation"]),
  });

const ALLOWED_QUERY_KEYS = Object.freeze([
  "atTick",
  "observer",
  "maximumDistance",
  "fieldOfViewDegrees",
  "minimumConfidence",
  "kinds",
  "limit",
]);

const DEFINITION_KEYS = Object.freeze([
  "version",
  "id",
  "fixedStepSeconds",
  "maximumRecords",
  "countermeasureBudget",
  "minimumRetainedConfidence",
  "minimumAiConfidence",
  "rules",
]);

const RULE_KEYS = Object.freeze([
  "initialConfidence",
  "decayPerTick",
  "lifetimeTicks",
  "aiPriority",
  "erase",
  "forge",
]);

const COST_KEYS = Object.freeze([
  "budgetUnits",
  "commitmentTicks",
  "publicNoiseStrength",
]);

const FORGE_COST_KEYS = Object.freeze([
  ...COST_KEYS,
  "confidenceMultiplier",
]);

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const clampSigned = (value: number) => Math.max(-1, Math.min(1, value));

function compareStableIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => (
      typeof key === "string"
      && allowed.includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && Object.hasOwn(
        Object.getOwnPropertyDescriptor(value, key) ?? {},
        "value",
      )
    ))
      && required.every((key) => keys.includes(key));
  } catch {
    return false;
  }
}

function isPlainDataArray(
  value: unknown,
  maximumLength: number,
): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    if (
      !Number.isSafeInteger(value.length)
      || value.length < 0
      || value.length > maximumLength
    ) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => (
        typeof key !== "string"
        || (
          key !== "length"
          && !/^(0|[1-9]\d*)$/u.test(key)
        )
      ))
      || !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
    ) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ownDataValue(
  value: Record<string, unknown>,
  key: string,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

const REJECTED_SNAPSHOT = Symbol("rejected-stealth-evidence-snapshot");
const MAX_UNTRUSTED_PROPERTIES = 4_096;
const MAX_UNTRUSTED_DEPTH = 8;

interface SnapshotBudget {
  remainingProperties: number;
}

/**
 * Reads descriptor values rather than invoking properties. This converts
 * accessor/Proxy-shaped inputs into an immutable data snapshot before any
 * validation or execution can observe a second, different value.
 */
function snapshotUntrustedData(
  value: unknown,
  budget: SnapshotBudget = { remainingProperties: MAX_UNTRUSTED_PROPERTIES },
  depth = 0,
): unknown | typeof REJECTED_SNAPSHOT {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) return value;
  if (typeof value === "function") return value;
  if (depth > MAX_UNTRUSTED_DEPTH) return REJECTED_SNAPSHOT;

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return REJECTED_SNAPSHOT;
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return REJECTED_SNAPSHOT;
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > MAX_UNTRUSTED_PROPERTIES
    ) return REJECTED_SNAPSHOT;
    const length = Number(lengthDescriptor.value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== length + 1
      || keys.some((key) => (
        typeof key !== "string"
        || (
          key !== "length"
          && !/^(0|[1-9]\d*)$/u.test(key)
        )
      ))
    ) return REJECTED_SNAPSHOT;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
        || budget.remainingProperties <= 0
      ) return REJECTED_SNAPSHOT;
      budget.remainingProperties -= 1;
      const item = snapshotUntrustedData(descriptor.value, budget, depth + 1);
      if (item === REJECTED_SNAPSHOT) return REJECTED_SNAPSHOT;
      result.push(item);
    }
    return Object.freeze(result);
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return REJECTED_SNAPSHOT;
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (
      typeof key !== "string"
      || !descriptor
      || !Object.hasOwn(descriptor, "value")
      || descriptor.enumerable !== true
      || budget.remainingProperties <= 0
    ) return REJECTED_SNAPSHOT;
    budget.remainingProperties -= 1;
    const property = snapshotUntrustedData(descriptor.value, budget, depth + 1);
    if (property === REJECTED_SNAPSHOT) return REJECTED_SNAPSHOT;
    Object.defineProperty(result, key, {
      value: property,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(result);
}

function snapshotUntrustedArrayShallow(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > maximumLength
    ) return null;
    const length = Number(lengthDescriptor.value);
    if (Reflect.ownKeys(descriptors).length !== length + 1) return null;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true
      ) return null;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function validIdentity(
  value: unknown,
  maximumLength = STEALTH_EVIDENCE_ID_MAX_LENGTH,
): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTick(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= 0
    && Number(value) <= STEALTH_EVIDENCE_MAX_TICK;
}

function validPoint(value: unknown): value is Point {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["x", "y"], ["x", "y"])) return false;
  return typeof value.x === "number"
    && Number.isFinite(value.x)
    && Math.abs(value.x) <= STEALTH_EVIDENCE_MAX_COORDINATE
    && typeof value.y === "number"
    && Number.isFinite(value.y)
    && Math.abs(value.y) <= STEALTH_EVIDENCE_MAX_COORDINATE;
}

function validDirection(value: unknown): value is Point {
  return validPoint(value) && Math.hypot(value.x, value.y) > 1e-12;
}

function normalizedDirection(value: Point): Point {
  const length = Math.hypot(value.x, value.y);
  return Object.freeze({ x: value.x / length, y: value.y / length });
}

function validSource(value: unknown): value is PublicEvidenceSource {
  if (
    !isPlainRecord(value)
    || !hasOnlyKeys(value, ["publicId", "kind", "publicity"], [
      "publicId",
      "kind",
      "publicity",
    ])
  ) return false;
  return validIdentity(value.publicId)
    && typeof value.kind === "string"
    && ["surface", "door", "object", "power-grid", "decoy"].includes(value.kind)
    && typeof value.publicity === "string"
    && ["world-observable", "publicly-announced"].includes(value.publicity);
}

function validDetail(kind: StealthEvidenceKind, value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  switch (kind) {
    case "footprint":
      return hasOnlyKeys(value, ["direction"], ["direction"])
        && validDirection(value.direction);
    case "door-state":
      return hasOnlyKeys(value, ["state"], ["state"])
        && typeof value.state === "string"
        && ["open", "closed", "forced"].includes(value.state);
    case "moved-object":
      return hasOnlyKeys(value, ["state"], ["state"])
        && typeof value.state === "string"
        && ["moved", "restored", "missing"].includes(value.state);
    case "power-change":
      return hasOnlyKeys(value, ["state"], ["state"])
        && typeof value.state === "string"
        && ["online", "offline", "unstable"].includes(value.state);
    case "decoy-residue":
      return hasOnlyKeys(value, ["state"], ["state"])
        && typeof value.state === "string"
        && ["fresh", "spent"].includes(value.state);
  }
}

function observationRejection(value: unknown): StealthEvidenceRejection | null {
  if (
    !isPlainRecord(value)
    || !hasOnlyKeys(
      value,
      ["kind", "position", "source", "detail", "confidenceScale"],
      ["kind", "position", "source", "detail"],
    )
    || !STEALTH_EVIDENCE_KINDS.includes(value.kind as StealthEvidenceKind)
  ) return "invalid-command";
  if (!validPoint(value.position)) return "invalid-position";
  if (!validSource(value.source)) return "invalid-source";
  if (value.source.kind !== SOURCE_KIND_FOR_EVIDENCE[value.kind as StealthEvidenceKind]) {
    return "source-kind-mismatch";
  }
  if (!validDetail(value.kind as StealthEvidenceKind, value.detail)) return "invalid-detail";
  if (
    Object.hasOwn(value, "confidenceScale")
    && (
      typeof value.confidenceScale !== "number"
      || !Number.isFinite(value.confidenceScale)
      || value.confidenceScale <= 0
      || value.confidenceScale > 1
    )
  ) return "invalid-confidence-scale";
  return null;
}

function copySource(source: PublicEvidenceSource): PublicEvidenceSource {
  return Object.freeze({
    publicId: source.publicId,
    kind: source.kind,
    publicity: source.publicity,
  });
}

function copyDetail(
  kind: StealthEvidenceKind,
  detail: PublicEvidenceObservation["detail"],
  normalizeFootprint = false,
): StealthEvidenceRecord["detail"] {
  if (kind === "footprint") {
    const direction = (detail as FootprintEvidenceDetail).direction;
    return Object.freeze({
      direction: normalizeFootprint
        ? normalizedDirection(direction)
        : Object.freeze({ ...direction }),
    });
  }
  return Object.freeze({ ...detail });
}

function freezeCost<T extends CountermeasureCost>(cost: T): T {
  return Object.freeze({ ...cost });
}

function freezeRule(rule: StealthEvidenceKindRule): StealthEvidenceKindRule {
  return Object.freeze({
    ...rule,
    erase: rule.erase ? freezeCost(rule.erase) : null,
    forge: rule.forge ? freezeCost(rule.forge) : null,
  });
}

function freezeDefinition(
  definition: StealthEvidenceDefinition,
): StealthEvidenceDefinition {
  return Object.freeze({
    version: STEALTH_EVIDENCE_VERSION,
    id: definition.id,
    fixedStepSeconds: definition.fixedStepSeconds,
    maximumRecords: definition.maximumRecords,
    countermeasureBudget: definition.countermeasureBudget,
    minimumRetainedConfidence: definition.minimumRetainedConfidence,
    minimumAiConfidence: definition.minimumAiConfidence,
    rules: Object.freeze({
      footprint: freezeRule(definition.rules.footprint),
      "door-state": freezeRule(definition.rules["door-state"]),
      "moved-object": freezeRule(definition.rules["moved-object"]),
      "power-change": freezeRule(definition.rules["power-change"]),
      "decoy-residue": freezeRule(definition.rules["decoy-residue"]),
    }),
  });
}

function freezeRecord(record: StealthEvidenceRecord): StealthEvidenceRecord {
  return Object.freeze({
    ...record,
    position: Object.freeze({ ...record.position }),
    source: copySource(record.source),
    detail: copyDetail(record.kind, record.detail),
  });
}

function freezeState(state: StealthEvidenceState): StealthEvidenceState {
  return Object.freeze({
    ...state,
    records: Object.freeze(state.records.map(freezeRecord)),
  });
}

function freezeAiView(view: AiEvidenceView): AiEvidenceView {
  return Object.freeze({
    ...view,
    position: Object.freeze({ ...view.position }),
    source: copySource(view.source),
    detail: copyDetail(view.kind, view.detail),
  });
}

function freezeEvent(event: StealthEvidenceEvent): StealthEvidenceEvent {
  if ("evidence" in event) {
    return Object.freeze({ ...event, evidence: freezeAiView(event.evidence) });
  }
  if ("source" in event) {
    return Object.freeze({ ...event, source: copySource(event.source) });
  }
  return Object.freeze({ ...event });
}

function freezeEvents(events: readonly StealthEvidenceEvent[]): readonly StealthEvidenceEvent[] {
  return Object.freeze(events.map(freezeEvent));
}

function validCost(cost: CountermeasureCost, label: string): void {
  if (
    !Number.isSafeInteger(cost.budgetUnits)
    || cost.budgetUnits < 0
    || cost.budgetUnits > STEALTH_EVIDENCE_MAX_BUDGET
  ) {
    throw new Error(`${label} budgetUnits must be a non-negative integer`);
  }
  if (
    !Number.isSafeInteger(cost.commitmentTicks)
    || cost.commitmentTicks < 0
    || cost.commitmentTicks > STEALTH_EVIDENCE_MAX_TICK
  ) {
    throw new Error(`${label} commitmentTicks must be a non-negative integer`);
  }
  if (
    !Number.isFinite(cost.publicNoiseStrength)
    || cost.publicNoiseStrength < 0
    || cost.publicNoiseStrength > 1
  ) {
    throw new Error(`${label} publicNoiseStrength must be in [0, 1]`);
  }
}

function validateStealthEvidenceDefinitionSnapshot(
  definition: StealthEvidenceDefinition,
): void {
  if (
    !isPlainRecord(definition)
    || !hasOnlyKeys(
      definition as unknown as Record<string, unknown>,
      DEFINITION_KEYS,
      DEFINITION_KEYS,
    )
  ) {
    throw new Error("Stealth evidence definition must be an object");
  }
  if (definition.version !== STEALTH_EVIDENCE_VERSION) {
    throw new Error(`Stealth evidence version must be ${STEALTH_EVIDENCE_VERSION}`);
  }
  if (!validIdentity(definition.id, STEALTH_EVIDENCE_DEFINITION_ID_MAX_LENGTH)) {
    throw new Error("Stealth evidence definition id must be a public, bounded identity");
  }
  if (
    !Number.isFinite(definition.fixedStepSeconds)
    || definition.fixedStepSeconds <= 0
    || definition.fixedStepSeconds > 1
  ) {
    throw new Error("Stealth evidence fixedStepSeconds must be in (0, 1]");
  }
  if (
    !Number.isSafeInteger(definition.maximumRecords)
    || definition.maximumRecords <= 0
    || definition.maximumRecords > 512
  ) {
    throw new Error("Stealth evidence maximumRecords must be an integer in [1, 512]");
  }
  if (
    !Number.isSafeInteger(definition.countermeasureBudget)
    || definition.countermeasureBudget < 0
    || definition.countermeasureBudget > STEALTH_EVIDENCE_MAX_BUDGET
  ) {
    throw new Error("Stealth evidence countermeasureBudget must be a non-negative integer");
  }
  if (
    !Number.isFinite(definition.minimumRetainedConfidence)
    || definition.minimumRetainedConfidence < 0
    || definition.minimumRetainedConfidence >= 1
  ) {
    throw new Error("minimumRetainedConfidence must be in [0, 1)");
  }
  if (
    !Number.isFinite(definition.minimumAiConfidence)
    || definition.minimumAiConfidence < definition.minimumRetainedConfidence
    || definition.minimumAiConfidence > 1
  ) {
    throw new Error("minimumAiConfidence must be between retained confidence and 1");
  }
  if (
    !isPlainRecord(definition.rules)
    || !hasOnlyKeys(
      definition.rules as unknown as Record<string, unknown>,
      STEALTH_EVIDENCE_KINDS,
      STEALTH_EVIDENCE_KINDS,
    )
  ) {
    throw new Error("Stealth evidence rules must be provided");
  }
  for (const kind of STEALTH_EVIDENCE_KINDS) {
    const rule = definition.rules[kind];
    if (
      !isPlainRecord(rule)
      || !hasOnlyKeys(
        rule as unknown as Record<string, unknown>,
        RULE_KEYS,
        RULE_KEYS,
      )
    ) {
      throw new Error(`Missing stealth evidence rule for ${kind}`);
    }
    if (
      !Number.isFinite(rule.initialConfidence)
      || rule.initialConfidence <= 0
      || rule.initialConfidence > 1
    ) {
      throw new Error(`${kind} initialConfidence must be in (0, 1]`);
    }
    if (
      !Number.isFinite(rule.decayPerTick)
      || rule.decayPerTick < 0
      || rule.decayPerTick > 1
    ) {
      throw new Error(`${kind} decayPerTick must be in [0, 1]`);
    }
    if (
      !Number.isSafeInteger(rule.lifetimeTicks)
      || rule.lifetimeTicks <= 0
      || rule.lifetimeTicks > STEALTH_EVIDENCE_MAX_TICK
    ) {
      throw new Error(`${kind} lifetimeTicks must be a positive integer`);
    }
    if (!Number.isFinite(rule.aiPriority) || rule.aiPriority <= 0 || rule.aiPriority > 10) {
      throw new Error(`${kind} aiPriority must be in (0, 10]`);
    }
    if (rule.erase !== null) {
      if (
        !isPlainRecord(rule.erase)
        || !hasOnlyKeys(
          rule.erase as unknown as Record<string, unknown>,
          COST_KEYS,
          COST_KEYS,
        )
      ) {
        throw new Error(`${kind} erase cost contains unsupported fields`);
      }
      validCost(rule.erase, `${kind} erase`);
    }
    if (rule.forge !== null) {
      if (
        !isPlainRecord(rule.forge)
        || !hasOnlyKeys(
          rule.forge as unknown as Record<string, unknown>,
          FORGE_COST_KEYS,
          FORGE_COST_KEYS,
        )
      ) {
        throw new Error(`${kind} forge cost contains unsupported fields`);
      }
      validCost(rule.forge, `${kind} forge`);
      if (
        !Number.isFinite(rule.forge.confidenceMultiplier)
        || rule.forge.confidenceMultiplier <= 0
        || rule.forge.confidenceMultiplier > 1
      ) {
        throw new Error(`${kind} forge confidenceMultiplier must be in (0, 1]`);
      }
    }
  }
}

function canonicalDefinitionInput(
  definition: StealthEvidenceDefinition,
): StealthEvidenceDefinition {
  const snapshot = snapshotUntrustedData(definition);
  if (snapshot === REJECTED_SNAPSHOT) {
    throw new Error("Stealth evidence definition must be an object");
  }
  validateStealthEvidenceDefinitionSnapshot(
    snapshot as StealthEvidenceDefinition,
  );
  return snapshot as StealthEvidenceDefinition;
}

export function validateStealthEvidenceDefinition(
  definition: StealthEvidenceDefinition,
): void {
  canonicalDefinitionInput(definition);
}

export function defineStealthEvidence(
  definition: StealthEvidenceDefinition,
): StealthEvidenceDefinition {
  return freezeDefinition(canonicalDefinitionInput(definition));
}

const cost = (
  budgetUnits: number,
  commitmentTicks: number,
  publicNoiseStrength: number,
): CountermeasureCost => Object.freeze({
  budgetUnits,
  commitmentTicks,
  publicNoiseStrength,
});

const forgeCost = (
  budgetUnits: number,
  commitmentTicks: number,
  publicNoiseStrength: number,
  confidenceMultiplier: number,
): CountermeasureCost & { readonly confidenceMultiplier: number } => Object.freeze({
  budgetUnits,
  commitmentTicks,
  publicNoiseStrength,
  confidenceMultiplier,
});

/**
 * Sixty-Hz authored defaults. Every duration is stored in ticks; the seconds
 * value is metadata for runtime compatibility and never drives decay.
 */
export const DEFAULT_STEALTH_EVIDENCE_DEFINITION = defineStealthEvidence({
  version: STEALTH_EVIDENCE_VERSION,
  id: "campaign-stealth-evidence-v1",
  fixedStepSeconds: 1 / 60,
  maximumRecords: 48,
  countermeasureBudget: 10,
  minimumRetainedConfidence: 0.02,
  minimumAiConfidence: 0.12,
  rules: {
    footprint: {
      initialConfidence: 0.88,
      decayPerTick: 0.0008,
      lifetimeTicks: 900,
      aiPriority: 1,
      erase: cost(1, 24, 0.08),
      forge: forgeCost(2, 45, 0.2, 0.82),
    },
    "door-state": {
      initialConfidence: 0.94,
      decayPerTick: 0.00028,
      lifetimeTicks: 1_800,
      aiPriority: 1.08,
      erase: cost(2, 42, 0.28),
      forge: forgeCost(3, 72, 0.38, 0.76),
    },
    "moved-object": {
      initialConfidence: 0.9,
      decayPerTick: 0.00022,
      lifetimeTicks: 2_400,
      aiPriority: 1.12,
      erase: cost(2, 54, 0.22),
      forge: forgeCost(3, 84, 0.34, 0.8),
    },
    "power-change": {
      initialConfidence: 0.98,
      decayPerTick: 0.0005,
      lifetimeTicks: 1_200,
      aiPriority: 1.2,
      erase: cost(3, 90, 0.44),
      forge: forgeCost(4, 120, 0.52, 0.72),
    },
    "decoy-residue": {
      initialConfidence: 0.8,
      decayPerTick: 0.00042,
      lifetimeTicks: 1_500,
      aiPriority: 0.9,
      erase: cost(1, 30, 0.1),
      forge: forgeCost(2, 48, 0.24, 0.74),
    },
  },
});

export function createStealthEvidenceState(
  definition: StealthEvidenceDefinition = DEFAULT_STEALTH_EVIDENCE_DEFINITION,
  initialTick = 0,
): StealthEvidenceState {
  const canonicalDefinition = canonicalDefinitionInput(definition);
  if (!validTick(initialTick)) {
    throw new Error("Stealth evidence initial tick must be a non-negative integer");
  }
  const frozenDefinition = freezeDefinition(canonicalDefinition);
  return freezeState({
    version: STEALTH_EVIDENCE_VERSION,
    definition: frozenDefinition,
    tick: initialTick,
    nextEvidenceSerial: 1,
    countermeasureBudgetRemaining: frozenDefinition.countermeasureBudget,
    countermeasureBudgetSpent: 0,
    countermeasureBusyUntilTick: initialTick,
    erasedEvidenceCount: 0,
    forgedEvidenceCount: 0,
    records: Object.freeze([]),
  });
}

export function stealthEvidenceConfidenceAtTick(
  record: StealthEvidenceRecord,
  tick: number,
): number {
  if (!validTick(tick) || tick < record.createdAtTick) {
    throw new Error("Evidence confidence tick must be at or after its creation tick");
  }
  return clamp01(
    record.initialConfidence - record.decayPerTick * (tick - record.createdAtTick),
  );
}

function recordActiveAtTick(
  definition: StealthEvidenceDefinition,
  record: StealthEvidenceRecord,
  tick: number,
): boolean {
  return tick < record.expiresAtTick
    && stealthEvidenceConfidenceAtTick(record, tick)
      + Number.EPSILON >= definition.minimumRetainedConfidence;
}

function firstInactiveTick(
  definition: StealthEvidenceDefinition,
  record: StealthEvidenceRecord,
): number {
  if (!recordActiveAtTick(definition, record, record.createdAtTick)) {
    return record.createdAtTick;
  }
  let lastActiveTick = record.createdAtTick;
  let firstInactive = record.expiresAtTick;
  while (lastActiveTick + 1 < firstInactive) {
    const candidate = lastActiveTick
      + Math.floor((firstInactive - lastActiveTick) / 2);
    if (recordActiveAtTick(definition, record, candidate)) {
      lastActiveTick = candidate;
    } else {
      firstInactive = candidate;
    }
  }
  return firstInactive;
}

function aiViewAtTick(record: StealthEvidenceRecord, tick: number): AiEvidenceView {
  return freezeAiView({
    id: record.id,
    kind: record.kind,
    position: record.position,
    source: record.source,
    detail: record.detail,
    createdAtTick: record.createdAtTick,
    ageTicks: tick - record.createdAtTick,
    expiresAtTick: record.expiresAtTick,
    confidence: stealthEvidenceConfidenceAtTick(record, tick),
  });
}

function advanceState(
  source: StealthEvidenceState,
  tick: number,
): {
  readonly state: StealthEvidenceState;
  readonly events: readonly StealthEvidenceEvent[];
} {
  const active: StealthEvidenceRecord[] = [];
  const events: StealthEvidenceEvent[] = [];
  for (const record of source.records) {
    if (recordActiveAtTick(source.definition, record, tick)) {
      active.push(record);
    } else {
      events.push({
        type: "evidence-expired",
        evidenceId: record.id,
        kind: record.kind,
        source: record.source,
        atTick: firstInactiveTick(source.definition, record),
      });
    }
  }
  events.sort((left, right) => (
    left.atTick - right.atTick
    || (
      left.type === "evidence-expired"
      && right.type === "evidence-expired"
        ? compareStableIdentity(left.evidenceId, right.evidenceId)
        : 0
    )
  ));
  if (tick === source.tick && active.length === source.records.length) {
    return Object.freeze({ state: source, events: Object.freeze([]) });
  }
  return Object.freeze({
    state: freezeState({
      ...source,
      tick,
      records: active,
    }),
    events: freezeEvents(events),
  });
}

function rejected(
  state: StealthEvidenceState,
  reason: StealthEvidenceRejection,
  commandType: string,
  priorEvents: readonly StealthEvidenceEvent[] = Object.freeze([]),
): StealthEvidenceStep {
  return Object.freeze({
    state,
    accepted: false,
    rejection: reason,
    events: freezeEvents([
      ...priorEvents,
      {
        type: "command-rejected",
        commandType,
        reason,
        atTick: state.tick,
      },
    ]),
  });
}

function validCommandType(value: unknown): value is StealthEvidenceCommand["type"] {
  return typeof value === "string"
    && ["advance", "record", "erase", "forge"].includes(value);
}

function commandTypeForEvent(command: unknown): string {
  if (!isPlainRecord(command)) return "invalid";
  const type = ownDataValue(command, "type");
  if (!validIdentity(type)) return "invalid";
  return type.slice(0, STEALTH_EVIDENCE_ID_MAX_LENGTH);
}

function structuralCommandRejection(command: unknown): StealthEvidenceRejection | null {
  if (!isPlainRecord(command)) return "invalid-command";
  const commandType = ownDataValue(command, "type");
  if (typeof commandType !== "string") return "invalid-command";
  if (!validCommandType(commandType)) return "unknown-command";
  if (
    !hasOnlyKeys(
      command,
      ALLOWED_COMMAND_KEYS[commandType],
      ALLOWED_COMMAND_KEYS[commandType],
    )
  ) return "invalid-command";
  const tick = ownDataValue(command, "tick");
  if (!validTick(tick)) return "invalid-tick";
  if (commandType === "erase") {
    return validIdentity(
      ownDataValue(command, "evidenceId"),
      STEALTH_EVIDENCE_RECORD_ID_MAX_LENGTH,
    )
      ? null
      : "invalid-evidence-id";
  }
  if (commandType === "record" || commandType === "forge") {
    return observationRejection(ownDataValue(command, "observation"));
  }
  return null;
}

function copyObservation(value: PublicEvidenceObservation): PublicEvidenceObservation {
  return Object.freeze({
    kind: value.kind,
    position: Object.freeze({ ...value.position }),
    source: copySource(value.source),
    detail: copyDetail(value.kind, value.detail, true),
    ...(value.confidenceScale === undefined
      ? {}
      : { confidenceScale: value.confidenceScale }),
  }) as PublicEvidenceObservation;
}

function lowestValueRecord(
  definition: StealthEvidenceDefinition,
  records: readonly StealthEvidenceRecord[],
  tick: number,
): StealthEvidenceRecord {
  return [...records].sort((left, right) => (
    (
      stealthEvidenceConfidenceAtTick(left, tick)
      * definition.rules[left.kind].aiPriority
    ) - (
      stealthEvidenceConfidenceAtTick(right, tick)
      * definition.rules[right.kind].aiPriority
    )
    || left.createdAtTick - right.createdAtTick
    || compareStableIdentity(left.id, right.id)
  ))[0];
}

function initialEvidenceConfidence(
  definition: StealthEvidenceDefinition,
  observation: PublicEvidenceObservation,
  origin: EvidenceOrigin,
): number {
  const rule = definition.rules[observation.kind];
  return clamp01(
    rule.initialConfidence
      * (observation.confidenceScale ?? 1)
      * (origin === "fabricated" ? (rule.forge?.confidenceMultiplier ?? 1) : 1),
  );
}

function tickAdditionOverflows(tick: number, durationTicks: number): boolean {
  return durationTicks > STEALTH_EVIDENCE_MAX_TICK - tick;
}

function evidenceSerialAvailable(state: StealthEvidenceState): boolean {
  return Number.isSafeInteger(state.nextEvidenceSerial)
    && state.nextEvidenceSerial >= 1
    && state.nextEvidenceSerial <= STEALTH_EVIDENCE_MAX_SERIAL;
}

function addEvidence(
  source: StealthEvidenceState,
  observationValue: PublicEvidenceObservation,
  origin: EvidenceOrigin,
): {
  readonly state: StealthEvidenceState;
  readonly events: readonly StealthEvidenceEvent[];
  readonly evidence: AiEvidenceView;
  readonly retained: boolean;
} {
  const observation = copyObservation(observationValue);
  const rule = source.definition.rules[observation.kind];
  const serial = source.nextEvidenceSerial;
  const record = freezeRecord({
    id: `${source.definition.id}:evidence:${serial}`,
    kind: observation.kind,
    position: observation.position,
    source: observation.source,
    detail: observation.detail,
    createdAtTick: source.tick,
    expiresAtTick: source.tick + rule.lifetimeTicks,
    initialConfidence: initialEvidenceConfidence(
      source.definition,
      observation,
      origin,
    ),
    decayPerTick: rule.decayPerTick,
    origin,
  });
  let records = [...source.records];
  const events: StealthEvidenceEvent[] = [];

  if (STATEFUL_EVIDENCE_KINDS.has(record.kind)) {
    const superseded = records.filter((candidate) => (
      candidate.kind === record.kind
      && candidate.source.kind === record.source.kind
      && candidate.source.publicId === record.source.publicId
    ));
    if (superseded.length > 0) {
      const supersededIds = new Set(superseded.map(({ id }) => id));
      records = records.filter(({ id }) => !supersededIds.has(id));
      for (const previous of superseded) {
        events.push({
          type: "evidence-superseded",
          evidenceId: previous.id,
          replacementEvidenceId: record.id,
          kind: previous.kind,
          source: previous.source,
          atTick: source.tick,
        });
      }
    }
  }

  let retained = true;
  if (records.length >= source.definition.maximumRecords) {
    const weakest = lowestValueRecord(
      source.definition,
      [...records, record],
      source.tick,
    );
    if (weakest.id === record.id) {
      retained = false;
      events.push({
        type: "evidence-discarded",
        evidence: aiViewAtTick(record, source.tick),
        reason: "lower-ranked-than-retained-evidence",
        atTick: source.tick,
      });
    } else {
      records = records.filter(({ id }) => id !== weakest.id);
      events.push({
        type: "evidence-evicted",
        evidenceId: weakest.id,
        kind: weakest.kind,
        source: weakest.source,
        atTick: source.tick,
      });
    }
  }
  if (retained) records.push(record);
  const state = freezeState({
    ...source,
    nextEvidenceSerial: serial + 1,
    records,
  });
  return Object.freeze({
    state,
    events: freezeEvents(events),
    evidence: aiViewAtTick(record, source.tick),
    retained,
  });
}

function applyCountermeasureCost(
  source: StealthEvidenceState,
  action: "erase" | "forge",
  actionCost: CountermeasureCost,
): {
  readonly state: StealthEvidenceState;
  readonly event: StealthEvidenceEvent;
} {
  const remaining = source.countermeasureBudgetRemaining - actionCost.budgetUnits;
  const state = freezeState({
    ...source,
    countermeasureBudgetRemaining: remaining,
    countermeasureBudgetSpent:
      source.countermeasureBudgetSpent + actionCost.budgetUnits,
    countermeasureBusyUntilTick: source.tick + actionCost.commitmentTicks,
  });
  return Object.freeze({
    state,
    event: Object.freeze({
      type: "countermeasure-cost-paid",
      action,
      budgetSpent: actionCost.budgetUnits,
      budgetRemaining: remaining,
      commitmentEndsAtTick: state.countermeasureBusyUntilTick,
      publicNoiseStrength: actionCost.publicNoiseStrength,
      atTick: source.tick,
    }),
  });
}

/**
 * Applies one command at an authoritative simulation tick. There are no
 * floating-time inputs, random values or render-frame dependencies.
 */
export function stepStealthEvidence(
  source: StealthEvidenceState,
  commandValue: unknown,
): StealthEvidenceStep {
  const commandSnapshot = snapshotUntrustedData(commandValue);
  const command = commandSnapshot === REJECTED_SNAPSHOT
    ? null
    : commandSnapshot;
  const structuralRejection = structuralCommandRejection(command);
  if (structuralRejection) {
    return rejected(source, structuralRejection, commandTypeForEvent(command));
  }
  const validCommand = command as StealthEvidenceCommand;
  if (validCommand.tick < source.tick) {
    return rejected(source, "time-regression", validCommand.type);
  }
  const advanced = advanceState(source, validCommand.tick);
  let state = advanced.state;
  const events = [...advanced.events];

  if (validCommand.type === "advance") {
    return Object.freeze({
      state,
      accepted: true,
      rejection: null,
      events: freezeEvents(events),
    });
  }

  if (validCommand.type === "record") {
    const rule = state.definition.rules[validCommand.observation.kind];
    if (!evidenceSerialAvailable(state)) {
      return rejected(
        state,
        "evidence-capacity-exhausted",
        validCommand.type,
        events,
      );
    }
    if (tickAdditionOverflows(state.tick, rule.lifetimeTicks)) {
      return rejected(state, "tick-overflow", validCommand.type, events);
    }
    if (
      initialEvidenceConfidence(
        state.definition,
        validCommand.observation,
        "authentic",
      ) + Number.EPSILON < state.definition.minimumRetainedConfidence
    ) {
      return rejected(
        state,
        "confidence-below-retention",
        validCommand.type,
        events,
      );
    }
    const addition = addEvidence(state, validCommand.observation, "authentic");
    state = addition.state;
    events.push({
      type: "evidence-recorded",
      evidence: addition.evidence,
      atTick: state.tick,
    }, ...addition.events);
    return Object.freeze({
      state,
      accepted: true,
      rejection: null,
      events: freezeEvents(events),
    });
  }

  if (validCommand.type === "erase") {
    const record = state.records.find(({ id }) => id === validCommand.evidenceId);
    if (!record) return rejected(state, "evidence-not-found", validCommand.type, events);
    if (state.tick < state.countermeasureBusyUntilTick) {
      return rejected(state, "countermeasure-busy", validCommand.type, events);
    }
    const actionCost = state.definition.rules[record.kind].erase;
    if (!actionCost || record.source.publicity === "publicly-announced") {
      return rejected(state, "evidence-not-erasable", validCommand.type, events);
    }
    if (state.countermeasureBudgetRemaining < actionCost.budgetUnits) {
      return rejected(
        state,
        "insufficient-countermeasure-budget",
        validCommand.type,
        events,
      );
    }
    if (tickAdditionOverflows(state.tick, actionCost.commitmentTicks)) {
      return rejected(state, "tick-overflow", validCommand.type, events);
    }
    const paid = applyCountermeasureCost(state, "erase", actionCost);
    state = freezeState({
      ...paid.state,
      erasedEvidenceCount: paid.state.erasedEvidenceCount + 1,
      records: paid.state.records.filter(({ id }) => id !== record.id),
    });
    events.push(paid.event, {
      type: "evidence-erased",
      evidenceId: record.id,
      kind: record.kind,
      source: record.source,
      atTick: state.tick,
    });
    return Object.freeze({
      state,
      accepted: true,
      rejection: null,
      events: freezeEvents(events),
    });
  }

  if (state.tick < state.countermeasureBusyUntilTick) {
    return rejected(state, "countermeasure-busy", validCommand.type, events);
  }
  if (validCommand.observation.source.publicity === "publicly-announced") {
    return rejected(
      state,
      "public-announcement-not-forgeable",
      validCommand.type,
      events,
    );
  }
  const actionCost = state.definition.rules[validCommand.observation.kind].forge;
  if (!actionCost) {
    return rejected(state, "evidence-not-forgeable", validCommand.type, events);
  }
  if (!evidenceSerialAvailable(state)) {
    return rejected(
      state,
      "evidence-capacity-exhausted",
      validCommand.type,
      events,
    );
  }
  if (state.countermeasureBudgetRemaining < actionCost.budgetUnits) {
    return rejected(
      state,
      "insufficient-countermeasure-budget",
      validCommand.type,
      events,
    );
  }
  if (
    tickAdditionOverflows(state.tick, actionCost.commitmentTicks)
    || tickAdditionOverflows(
      state.tick,
      state.definition.rules[validCommand.observation.kind].lifetimeTicks,
    )
  ) {
    return rejected(state, "tick-overflow", validCommand.type, events);
  }
  if (
    initialEvidenceConfidence(
      state.definition,
      validCommand.observation,
      "fabricated",
    ) + Number.EPSILON < state.definition.minimumRetainedConfidence
  ) {
    return rejected(
      state,
      "confidence-below-retention",
      validCommand.type,
      events,
    );
  }
  const paid = applyCountermeasureCost(state, "forge", actionCost);
  const addition = addEvidence(paid.state, validCommand.observation, "fabricated");
  state = freezeState({
    ...addition.state,
    forgedEvidenceCount: addition.state.forgedEvidenceCount + 1,
  });
  events.push(paid.event, {
    type: "evidence-forged",
    evidence: addition.evidence,
    atTick: state.tick,
  }, ...addition.events);
  return Object.freeze({
    state,
    accepted: true,
    rejection: null,
    events: freezeEvents(events),
  });
}

function queryValidationError(query: unknown): string | null {
  if (
    !isPlainRecord(query)
    || !hasOnlyKeys(query, ALLOWED_QUERY_KEYS, [
      "atTick",
      "observer",
      "maximumDistance",
      "fieldOfViewDegrees",
    ])
  ) return "AI evidence query contains invalid or private fields";
  if (!validTick(query.atTick)) {
    return "AI evidence query tick must be a non-negative integer";
  }
  if (
    !isPlainRecord(query.observer)
    || !hasOnlyKeys(query.observer, ["position", "heading"], ["position", "heading"])
    || !validPoint(query.observer.position)
    || !validDirection(query.observer.heading)
  ) return "AI evidence observer must have finite public position and heading";
  if (
    typeof query.maximumDistance !== "number"
    || !Number.isFinite(query.maximumDistance)
    || query.maximumDistance <= 0
  ) return "AI evidence maximumDistance must be finite and positive";
  if (
    typeof query.fieldOfViewDegrees !== "number"
    || !Number.isFinite(query.fieldOfViewDegrees)
    || query.fieldOfViewDegrees <= 0
    || query.fieldOfViewDegrees > 360
  ) return "AI evidence fieldOfViewDegrees must be in (0, 360]";
  if (
    Object.hasOwn(query, "minimumConfidence")
    && (
      typeof query.minimumConfidence !== "number"
      || !Number.isFinite(query.minimumConfidence)
      || query.minimumConfidence < 0
      || query.minimumConfidence > 1
    )
  ) return "AI evidence minimumConfidence must be in [0, 1]";
  if (Object.hasOwn(query, "kinds")) {
    if (
      !isPlainDataArray(query.kinds, STEALTH_EVIDENCE_KINDS.length)
      || query.kinds.length === 0
      || query.kinds.some((kind) => (
        !STEALTH_EVIDENCE_KINDS.includes(kind as StealthEvidenceKind)
      ))
      || new Set(query.kinds).size !== query.kinds.length
    ) return "AI evidence kinds must be a non-empty unique supported list";
  }
  if (
    Object.hasOwn(query, "limit")
    && (
      !Number.isInteger(query.limit)
      || Number(query.limit) <= 0
      || Number(query.limit) > 512
    )
  ) return "AI evidence query limit must be an integer in [1, 512]";
  return null;
}

function validateGeometry(geometry: AiEvidencePublicGeometry | undefined): void {
  if (geometry === undefined) return;
  if (
    !isPlainRecord(geometry)
    || !hasOnlyKeys(geometry as unknown as Record<string, unknown>, [
      "isVisible",
      "isReachable",
    ], [])
    || (
      geometry.isVisible !== undefined
      && typeof geometry.isVisible !== "function"
    )
    || (
      geometry.isReachable !== undefined
      && typeof geometry.isReachable !== "function"
    )
  ) {
    throw new Error("AI evidence geometry may only provide visibility/reachability callbacks");
  }
}

/**
 * Occupancy-blind query boundary. The result contains only decayed public
 * observations. Authenticity and all countermeasure metadata are stripped.
 */
export function queryStealthEvidenceForAi(
  state: StealthEvidenceState,
  queryValue: unknown,
  geometry?: AiEvidencePublicGeometry,
): readonly AiEvidenceCandidate[] {
  const querySnapshot = snapshotUntrustedData(queryValue);
  const safeQueryValue = querySnapshot === REJECTED_SNAPSHOT
    ? null
    : querySnapshot;
  const validationError = queryValidationError(safeQueryValue);
  if (validationError) throw new Error(validationError);
  const geometrySnapshot = geometry === undefined
    ? undefined
    : snapshotUntrustedData(geometry);
  if (geometrySnapshot === REJECTED_SNAPSHOT) {
    throw new Error("AI evidence geometry may only provide visibility/reachability callbacks");
  }
  const safeGeometry = geometrySnapshot as AiEvidencePublicGeometry | undefined;
  validateGeometry(safeGeometry);
  const sourceQuery = safeQueryValue as AiEvidenceQuery;
  const query: AiEvidenceQuery = Object.freeze({
    atTick: sourceQuery.atTick,
    observer: Object.freeze({
      position: Object.freeze({ ...sourceQuery.observer.position }),
      heading: Object.freeze({ ...sourceQuery.observer.heading }),
    }),
    maximumDistance: sourceQuery.maximumDistance,
    fieldOfViewDegrees: sourceQuery.fieldOfViewDegrees,
    ...(sourceQuery.minimumConfidence === undefined
      ? {}
      : { minimumConfidence: sourceQuery.minimumConfidence }),
    ...(sourceQuery.kinds === undefined
      ? {}
      : { kinds: Object.freeze([...sourceQuery.kinds]) }),
    ...(sourceQuery.limit === undefined ? {} : { limit: sourceQuery.limit }),
  });
  const isVisible = safeGeometry?.isVisible;
  const isReachable = safeGeometry?.isReachable;
  if (query.atTick < state.tick) {
    throw new Error("AI evidence query cannot inspect a past ledger tick");
  }
  const observerPosition = Object.freeze({ ...query.observer.position });
  const observerHeading = normalizedDirection(query.observer.heading);
  const halfFovRadians = query.fieldOfViewDegrees * Math.PI / 360;
  const minimumAlignment = query.fieldOfViewDegrees === 360
    ? -1
    : Math.cos(halfFovRadians);
  const minimumConfidence = Math.max(
    state.definition.minimumAiConfidence,
    query.minimumConfidence ?? 0,
  );
  const allowedKinds = query.kinds ? new Set(query.kinds) : null;
  const candidates: AiEvidenceCandidate[] = [];

  for (const record of state.records) {
    if (!recordActiveAtTick(state.definition, record, query.atTick)) continue;
    if (allowedKinds && !allowedKinds.has(record.kind)) continue;
    const confidence = stealthEvidenceConfidenceAtTick(record, query.atTick);
    if (confidence + Number.EPSILON < minimumConfidence) continue;
    const offsetX = record.position.x - observerPosition.x;
    const offsetY = record.position.y - observerPosition.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance > query.maximumDistance + Number.EPSILON) continue;
    const headingAlignment = distance <= 1e-12
      ? 1
      : clampSigned(
        (offsetX * observerHeading.x + offsetY * observerHeading.y) / distance,
      );
    if (
      query.fieldOfViewDegrees !== 360
      && headingAlignment + Number.EPSILON < minimumAlignment
    ) continue;

    const evidence = aiViewAtTick(record, query.atTick);
    const evidencePosition = evidence.position;
    if (isVisible) {
      const visible = isVisible(observerPosition, evidencePosition, evidence);
      if (typeof visible !== "boolean") {
        throw new Error("AI evidence visibility callback must return a boolean");
      }
      if (!visible) continue;
    }
    if (isReachable) {
      const reachable = isReachable(observerPosition, evidencePosition, evidence);
      if (typeof reachable !== "boolean") {
        throw new Error("AI evidence reachability callback must return a boolean");
      }
      if (!reachable) continue;
    }

    const distancePenalty = Math.min(1, distance / query.maximumDistance) * 0.15;
    const investigationScore = Math.max(
      0,
      confidence * state.definition.rules[record.kind].aiPriority
        - distancePenalty,
    );
    candidates.push(Object.freeze({
      evidence,
      distance,
      headingAlignment,
      investigationScore,
    }));
  }

  candidates.sort((left, right) => (
    right.investigationScore - left.investigationScore
    || right.evidence.confidence - left.evidence.confidence
    || right.evidence.createdAtTick - left.evidence.createdAtTick
    || compareStableIdentity(left.evidence.id, right.evidence.id)
  ));
  const limit = Math.min(query.limit ?? candidates.length, candidates.length);
  return Object.freeze(candidates.slice(0, limit));
}

export function selectStealthEvidenceForAi(
  state: StealthEvidenceState,
  query: unknown,
  geometry?: AiEvidencePublicGeometry,
): AiEvidenceCandidate | null {
  return queryStealthEvidenceForAi(state, query, geometry)[0] ?? null;
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function replayStealthEvidence(
  definition: StealthEvidenceDefinition,
  commands: readonly unknown[],
  initialTick = 0,
): StealthEvidenceReplay {
  const commandSnapshot = snapshotUntrustedArrayShallow(commands, 1_000_000);
  if (!commandSnapshot) {
    throw new Error("Stealth evidence replay commands must be an array");
  }
  let state = createStealthEvidenceState(definition, initialTick);
  const events: StealthEvidenceEvent[] = [];
  for (const command of commandSnapshot) {
    const step = stepStealthEvidence(state, command);
    state = step.state;
    events.push(...step.events);
  }
  const frozenEvents = freezeEvents(events);
  return Object.freeze({
    state,
    events: frozenEvents,
    fingerprint: stableFingerprint(JSON.stringify({
      version: STEALTH_EVIDENCE_VERSION,
      state,
      events: frozenEvents,
    })),
  });
}
