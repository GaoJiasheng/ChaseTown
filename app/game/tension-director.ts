/**
 * A deterministic, advisory-only tension director.
 *
 * The director deliberately has no access to player position, heading,
 * visibility, room, or nearest-object queries. Its strict tick input accepts
 * only public aggregate run signals and globally verified route IDs. It emits
 * announced, finite event suggestions; the host remains responsible for
 * applying and reverting their authored effects.
 */

export const TENSION_DIRECTOR_VERSION = 1;

export const TENSION_DIRECTOR_EVENT_KINDS = [
  "patrol-pressure",
  "blackout",
  "broadcast",
  "door-cycle",
] as const;

export type TensionDirectorEventKind =
  (typeof TENSION_DIRECTOR_EVENT_KINDS)[number];

export type TensionTier = "rest" | "watchful" | "heightened";
export type TensionDirectorRunPhase = "playing" | "paused" | "complete";
export type TensionDirectorThreat = "safe" | "suspicious" | "chased";
export type TensionDirectorEventPhase = "warning" | "active";

export const TENSION_DIRECTOR_EVENT_INTENSITY_CAPS:
Readonly<Record<TensionDirectorEventKind, number>> = Object.freeze({
  "patrol-pressure": 250,
  blackout: 650,
  broadcast: 1_000,
  "door-cycle": 1_000,
});

export interface TensionDirectorPolicy {
  /** Informational conversion for UI copy; state progression is tick-only. */
  readonly fixedStepSeconds: number;
  readonly minimumWarningTicks: number;
  readonly maximumEventDurationTicks: number;
  readonly minimumEventCooldownTicks: number;
  readonly minimumSafeTicksBeforePressure: number;
  readonly minimumCalmTicksAfterEvent: number;
  readonly suspiciousBreatherTicks: number;
  readonly chaseBreatherTicks: number;
  readonly escapeBreatherTicks: number;
  readonly resourceRecoveryBreatherTicks: number;
  readonly criticalResourcePermille: number;
  readonly heightenedResourceFloorPermille: number;
  readonly safeRampStartTicks: number;
  readonly safeRampEndTicks: number;
  readonly safeScoreMaximum: number;
  readonly missionScoreMaximum: number;
  readonly resourceScoreMaximum: number;
  readonly watchfulEnterScore: number;
  readonly watchfulExitScore: number;
  readonly heightenedEnterScore: number;
  readonly heightenedExitScore: number;
}

export const DEFAULT_TENSION_DIRECTOR_POLICY:
Readonly<TensionDirectorPolicy> = Object.freeze({
  fixedStepSeconds: 1 / 60,
  minimumWarningTicks: 120,
  maximumEventDurationTicks: 720,
  minimumEventCooldownTicks: 480,
  minimumSafeTicksBeforePressure: 480,
  minimumCalmTicksAfterEvent: 360,
  suspiciousBreatherTicks: 300,
  chaseBreatherTicks: 480,
  escapeBreatherTicks: 600,
  resourceRecoveryBreatherTicks: 300,
  criticalResourcePermille: 150,
  heightenedResourceFloorPermille: 350,
  safeRampStartTicks: 480,
  safeRampEndTicks: 1_800,
  safeScoreMaximum: 550,
  missionScoreMaximum: 350,
  resourceScoreMaximum: 100,
  watchfulEnterScore: 360,
  watchfulExitScore: 260,
  heightenedEnterScore: 720,
  heightenedExitScore: 560,
});

export interface TensionDirectorEventDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: TensionDirectorEventKind;
  readonly minimumTier: Exclude<TensionTier, "rest">;
  readonly warningTicks: number;
  readonly durationTicks: number;
  /** Begins when a suggestion ends or is cancelled, not when it is announced. */
  readonly cooldownTicks: number;
  /**
   * Authored global channel such as a speaker bank, lighting circuit, or door
   * group. Null is only legal for a global patrol-pressure modifier.
   */
  readonly publicChannelId: string | null;
  /**
   * Whole-run route IDs temporarily disabled by this event. Only door cycles
   * may block routes. This is topology metadata, never a player-relative path.
   */
  readonly blockedRouteIds: readonly string[];
  readonly intensityPermille: number;
}

export interface TensionDirectorDefinition {
  readonly version: typeof TENSION_DIRECTOR_VERSION;
  readonly id: string;
  /** All independently authored, globally valid completion routes. */
  readonly routeIds: readonly string[];
  readonly minimumLegalRouteCount: number;
  readonly policy: TensionDirectorPolicy;
  readonly events: readonly TensionDirectorEventDefinition[];
}

/**
 * Strict fixed-tick input. Extra runtime fields are rejected, including fields
 * that could reveal a player's location or current visibility relationship.
 */
export interface TensionDirectorSignals {
  readonly tick: number;
  readonly runPhase: TensionDirectorRunPhase;
  readonly threat: TensionDirectorThreat;
  readonly safeTicks: number;
  readonly chaseTicks: number;
  readonly ticksSinceChaseEscape: number | null;
  readonly missionProgressPermille: number;
  readonly resourcesRemainingPermille: number;
  /**
   * Completion routes currently proven traversable by the host's topology
   * system. Input order is ignored and canonicalized to definition order.
   */
  readonly legalRouteIds: readonly string[];
}

export interface TensionDirectorCooldown {
  readonly eventId: string;
  readonly readyAtTick: number;
}

export interface TensionDirectorSafetyCertificate {
  readonly sourcePolicy: "public-aggregate-signals-only";
  readonly warningTicks: number;
  readonly durationTicks: number;
  readonly legalRouteIdsAtSuggestion: readonly string[];
  readonly preservedLegalRouteIds: readonly string[];
  readonly minimumLegalRouteCount: number;
  readonly routeGuarantee: true;
}

export interface TensionDirectorSuggestion {
  readonly suggestionId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly label: string;
  readonly kind: TensionDirectorEventKind;
  readonly publicChannelId: string | null;
  readonly intensityPermille: number;
  readonly blockedRouteIds: readonly string[];
  readonly announcedAtTick: number;
  readonly startsAtTick: number;
  readonly endsAtTick: number;
  readonly safety: TensionDirectorSafetyCertificate;
}

export interface TensionDirectorActiveEvent {
  readonly phase: TensionDirectorEventPhase;
  readonly suggestion: TensionDirectorSuggestion;
}

export interface TensionDirectorState {
  readonly version: typeof TENSION_DIRECTOR_VERSION;
  readonly definitionId: string;
  readonly currentTick: number;
  readonly tier: TensionTier;
  readonly score: number;
  readonly activeEvent: TensionDirectorActiveEvent | null;
  readonly cooldowns: readonly TensionDirectorCooldown[];
  /** Earliest inclusive tick on which any new suggestion may be announced. */
  readonly globalReadyAtTick: number;
  /** Earliest inclusive tick after danger/resource protection has elapsed. */
  readonly breatherUntilTick: number;
  readonly selectionCursor: number;
  readonly nextSequence: number;
  readonly lastEventId: string | null;
  readonly completedEventCount: number;
}

export type TensionDirectorTerminationReason =
  | "completed"
  | "danger-protection"
  | "recent-escape-protection"
  | "resource-protection"
  | "route-protection"
  | "run-inactive";

export type TensionDirectorLifecycleEvent =
  | {
      readonly type: "tier-changed";
      readonly atTick: number;
      readonly from: TensionTier;
      readonly to: TensionTier;
      readonly score: number;
    }
  | {
      readonly type: "event-suggested";
      readonly atTick: number;
      readonly suggestion: TensionDirectorSuggestion;
    }
  | {
      readonly type: "event-activated";
      readonly atTick: number;
      readonly suggestionId: string;
      readonly eventId: string;
    }
  | {
      readonly type: "event-cancelled";
      readonly atTick: number;
      readonly suggestionId: string;
      readonly eventId: string;
      readonly reason: Exclude<TensionDirectorTerminationReason, "completed">;
    }
  | {
      readonly type: "event-ended";
      readonly atTick: number;
      readonly suggestionId: string;
      readonly eventId: string;
      readonly reason: TensionDirectorTerminationReason;
    };

export type TensionDirectorSuppressionReason =
  | "event-in-flight"
  | "run-inactive"
  | "danger-present"
  | "recent-escape"
  | "breathing-window"
  | "minimum-safe-window"
  | "global-calm-window"
  | "critical-resources"
  | "low-tension"
  | "no-legal-route"
  | "no-tier-eligible-event"
  | "all-eligible-events-cooling-down"
  | "no-route-safe-event";

export interface TensionDirectorStep {
  readonly state: TensionDirectorState;
  readonly score: number;
  readonly tier: TensionTier;
  readonly lifecycleEvents: readonly TensionDirectorLifecycleEvent[];
  readonly suggestion: TensionDirectorSuggestion | null;
  readonly suppressionReasons: readonly TensionDirectorSuppressionReason[];
}

export interface TensionDirectorDefinitionAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly routeCount: number;
  readonly eventCount: number;
}

export interface TensionDirectorSafetyAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly definition: TensionDirectorDefinitionAudit;
  readonly processedTicks: number;
  readonly suggestionsAudited: number;
  readonly activationsAudited: number;
  readonly minimumPreservedRouteCount: number | null;
  readonly finalState: TensionDirectorState | null;
}

export interface TensionDirectorReplay {
  readonly state: TensionDirectorState;
  readonly lifecycleEvents: readonly TensionDirectorLifecycleEvent[];
  readonly fingerprint: string;
}

const DEFINITION_KEYS = new Set([
  "version",
  "id",
  "routeIds",
  "minimumLegalRouteCount",
  "policy",
  "events",
]);

const POLICY_KEYS = new Set([
  "fixedStepSeconds",
  "minimumWarningTicks",
  "maximumEventDurationTicks",
  "minimumEventCooldownTicks",
  "minimumSafeTicksBeforePressure",
  "minimumCalmTicksAfterEvent",
  "suspiciousBreatherTicks",
  "chaseBreatherTicks",
  "escapeBreatherTicks",
  "resourceRecoveryBreatherTicks",
  "criticalResourcePermille",
  "heightenedResourceFloorPermille",
  "safeRampStartTicks",
  "safeRampEndTicks",
  "safeScoreMaximum",
  "missionScoreMaximum",
  "resourceScoreMaximum",
  "watchfulEnterScore",
  "watchfulExitScore",
  "heightenedEnterScore",
  "heightenedExitScore",
]);

const EVENT_DEFINITION_KEYS = new Set([
  "id",
  "label",
  "kind",
  "minimumTier",
  "warningTicks",
  "durationTicks",
  "cooldownTicks",
  "publicChannelId",
  "blockedRouteIds",
  "intensityPermille",
]);

const SIGNAL_KEYS = new Set([
  "tick",
  "runPhase",
  "threat",
  "safeTicks",
  "chaseTicks",
  "ticksSinceChaseEscape",
  "missionProgressPermille",
  "resourcesRemainingPermille",
  "legalRouteIds",
]);

const TIER_RANK: Readonly<Record<TensionTier, number>> = Object.freeze({
  rest: 0,
  watchful: 1,
  heightened: 2,
});

const clamp = (value: number, minimum: number, maximum: number) => (
  Math.min(maximum, Math.max(minimum, value))
);

const isNonNegativeInteger = (value: unknown): value is number => (
  Number.isInteger(value) && (value as number) >= 0
);

function unexpectedKeys(
  value: object,
  allowed: ReadonlySet<string>,
): readonly string[] {
  return Object.keys(value).filter((key) => !allowed.has(key)).sort();
}

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalLegalRouteIds(
  definition: Readonly<TensionDirectorDefinition>,
  legalRouteIds: readonly string[],
): readonly string[] {
  const legal = new Set(legalRouteIds);
  return Object.freeze(definition.routeIds.filter((routeId) => legal.has(routeId)));
}

function preservedRouteIds(
  definition: Readonly<TensionDirectorDefinition>,
  event: Readonly<TensionDirectorEventDefinition>,
  legalRouteIds: readonly string[],
): readonly string[] {
  const blocked = new Set(event.blockedRouteIds);
  return Object.freeze(
    canonicalLegalRouteIds(definition, legalRouteIds)
      .filter((routeId) => !blocked.has(routeId)),
  );
}

function routeIsSafe(
  definition: Readonly<TensionDirectorDefinition>,
  event: Readonly<TensionDirectorEventDefinition>,
  legalRouteIds: readonly string[],
): boolean {
  return preservedRouteIds(definition, event, legalRouteIds).length
    >= definition.minimumLegalRouteCount;
}

function addFailure(
  failures: string[],
  condition: boolean,
  message: string,
) {
  if (!condition) failures.push(message);
}

export function auditTensionDirectorDefinition(
  definition: Readonly<TensionDirectorDefinition>,
): TensionDirectorDefinitionAudit {
  const failures: string[] = [];
  const topLevelExtraKeys = unexpectedKeys(definition, DEFINITION_KEYS);
  if (topLevelExtraKeys.length > 0) {
    failures.push(
      `Definition contains unsupported fields: ${topLevelExtraKeys.join(", ")}`,
    );
  }

  addFailure(
    failures,
    definition.version === TENSION_DIRECTOR_VERSION,
    `Definition version must be ${TENSION_DIRECTOR_VERSION}`,
  );
  addFailure(failures, validIdentifier(definition.id), "Definition id must not be empty");
  addFailure(
    failures,
    Array.isArray(definition.routeIds) && definition.routeIds.length > 0,
    "Definition must declare at least one legal route",
  );
  if (Array.isArray(definition.routeIds)) {
    for (const routeId of definition.routeIds) {
      addFailure(failures, validIdentifier(routeId), "Route ids must not be empty");
    }
    const duplicateRouteIds = duplicateValues(definition.routeIds);
    if (duplicateRouteIds.length > 0) {
      failures.push(`Duplicate route ids: ${duplicateRouteIds.join(", ")}`);
    }
  }
  addFailure(
    failures,
    Number.isInteger(definition.minimumLegalRouteCount)
      && definition.minimumLegalRouteCount >= 1
      && definition.minimumLegalRouteCount <= definition.routeIds.length,
    "minimumLegalRouteCount must preserve at least one declared route",
  );

  const policy = definition.policy;
  const policyExtraKeys = unexpectedKeys(policy, POLICY_KEYS);
  if (policyExtraKeys.length > 0) {
    failures.push(`Policy contains unsupported fields: ${policyExtraKeys.join(", ")}`);
  }
  addFailure(
    failures,
    Number.isFinite(policy.fixedStepSeconds) && policy.fixedStepSeconds > 0,
    "fixedStepSeconds must be finite and positive",
  );

  const positiveProtectionTickFields: readonly (keyof TensionDirectorPolicy)[] = [
    "minimumSafeTicksBeforePressure",
    "minimumCalmTicksAfterEvent",
    "suspiciousBreatherTicks",
    "chaseBreatherTicks",
    "escapeBreatherTicks",
    "resourceRecoveryBreatherTicks",
  ];
  for (const field of positiveProtectionTickFields) {
    addFailure(
      failures,
      Number.isInteger(policy[field]) && policy[field] > 0,
      `${field} must be a positive integer so the safe window cannot collapse`,
    );
  }
  addFailure(
    failures,
    isNonNegativeInteger(policy.safeRampStartTicks),
    "safeRampStartTicks must be a non-negative integer",
  );
  for (const field of [
    "minimumWarningTicks",
    "maximumEventDurationTicks",
    "minimumEventCooldownTicks",
    "safeRampEndTicks",
  ] as const) {
    addFailure(
      failures,
      Number.isInteger(policy[field]) && policy[field] > 0,
      `${field} must be a positive integer`,
    );
  }
  addFailure(
    failures,
    policy.safeRampEndTicks > policy.safeRampStartTicks,
    "safeRampEndTicks must be greater than safeRampStartTicks",
  );

  for (const field of [
    "criticalResourcePermille",
    "heightenedResourceFloorPermille",
    "safeScoreMaximum",
    "missionScoreMaximum",
    "resourceScoreMaximum",
    "watchfulEnterScore",
    "watchfulExitScore",
    "heightenedEnterScore",
    "heightenedExitScore",
  ] as const) {
    addFailure(
      failures,
      Number.isInteger(policy[field])
        && policy[field] >= 0
        && policy[field] <= 1_000,
      `${field} must be an integer from 0 to 1000`,
    );
  }
  addFailure(
    failures,
    policy.criticalResourcePermille < policy.heightenedResourceFloorPermille,
    "criticalResourcePermille must be below heightenedResourceFloorPermille",
  );
  addFailure(
    failures,
    policy.watchfulExitScore < policy.watchfulEnterScore,
    "Watchful hysteresis requires exit score below enter score",
  );
  addFailure(
    failures,
    policy.watchfulEnterScore <= policy.heightenedExitScore
      && policy.heightenedExitScore < policy.heightenedEnterScore,
    "Heightened hysteresis thresholds must sit above watchful entry",
  );
  addFailure(
    failures,
    policy.safeScoreMaximum
      + policy.missionScoreMaximum
      + policy.resourceScoreMaximum <= 1_000,
    "Score component maxima must not exceed 1000 in total",
  );
  addFailure(
    failures,
    policy.safeScoreMaximum
      + policy.missionScoreMaximum
      + policy.resourceScoreMaximum >= policy.heightenedEnterScore,
    "Score component maxima can never reach heightened entry",
  );

  addFailure(
    failures,
    Array.isArray(definition.events) && definition.events.length > 0,
    "Definition must declare at least one event",
  );
  const eventIds = definition.events.map(({ id }) => id);
  const duplicateEventIds = duplicateValues(eventIds);
  if (duplicateEventIds.length > 0) {
    failures.push(`Duplicate event ids: ${duplicateEventIds.join(", ")}`);
  }
  const routeIdSet = new Set(definition.routeIds);
  for (const [index, event] of definition.events.entries()) {
    const prefix = `Event ${event.id || `#${index}`}`;
    const extraKeys = unexpectedKeys(event, EVENT_DEFINITION_KEYS);
    if (extraKeys.length > 0) {
      failures.push(`${prefix} contains unsupported fields: ${extraKeys.join(", ")}`);
    }
    addFailure(failures, validIdentifier(event.id), `${prefix} id must not be empty`);
    addFailure(failures, validIdentifier(event.label), `${prefix} label must not be empty`);
    addFailure(
      failures,
      TENSION_DIRECTOR_EVENT_KINDS.includes(event.kind),
      `${prefix} has an unknown event kind`,
    );
    addFailure(
      failures,
      event.minimumTier === "watchful" || event.minimumTier === "heightened",
      `${prefix} minimum tier must be watchful or heightened`,
    );
    addFailure(
      failures,
      Number.isInteger(event.warningTicks)
        && event.warningTicks >= policy.minimumWarningTicks,
      `${prefix} warning is shorter than the policy minimum`,
    );
    addFailure(
      failures,
      Number.isInteger(event.durationTicks)
        && event.durationTicks > 0
        && event.durationTicks <= policy.maximumEventDurationTicks,
      `${prefix} duration must be finite and within the policy maximum`,
    );
    addFailure(
      failures,
      Number.isInteger(event.cooldownTicks)
        && event.cooldownTicks >= policy.minimumEventCooldownTicks,
      `${prefix} cooldown is shorter than the policy minimum`,
    );
    addFailure(
      failures,
      Number.isInteger(event.intensityPermille)
        && event.intensityPermille > 0
        && event.intensityPermille
          <= (TENSION_DIRECTOR_EVENT_INTENSITY_CAPS[event.kind] ?? 0),
      `${prefix} intensity exceeds its fairness cap`,
    );
    addFailure(
      failures,
      Array.isArray(event.blockedRouteIds),
      `${prefix} blockedRouteIds must be an array`,
    );
    const duplicateBlockedRoutes = duplicateValues(event.blockedRouteIds);
    if (duplicateBlockedRoutes.length > 0) {
      failures.push(
        `${prefix} repeats blocked routes: ${duplicateBlockedRoutes.join(", ")}`,
      );
    }
    for (const routeId of event.blockedRouteIds) {
      addFailure(
        failures,
        routeIdSet.has(routeId),
        `${prefix} blocks unknown route ${routeId}`,
      );
    }

    if (event.kind === "patrol-pressure") {
      addFailure(
        failures,
        event.publicChannelId === null,
        `${prefix} patrol pressure must be global, not spatially targeted`,
      );
      addFailure(
        failures,
        event.blockedRouteIds.length === 0,
        `${prefix} patrol pressure must not block routes`,
      );
    } else {
      addFailure(
        failures,
        validIdentifier(event.publicChannelId),
        `${prefix} requires an authored public channel`,
      );
    }
    if (event.kind === "door-cycle") {
      addFailure(
        failures,
        event.blockedRouteIds.length > 0,
        `${prefix} door cycle must name the routes it blocks`,
      );
    } else {
      addFailure(
        failures,
        event.blockedRouteIds.length === 0,
        `${prefix} is not allowed to block routes`,
      );
    }
    addFailure(
      failures,
      definition.routeIds.length - new Set(event.blockedRouteIds).size
        >= definition.minimumLegalRouteCount,
      `${prefix} can close every required legal route`,
    );
  }

  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    routeCount: definition.routeIds.length,
    eventCount: definition.events.length,
  });
}

export function validateTensionDirectorDefinition(
  definition: Readonly<TensionDirectorDefinition>,
) {
  const audit = auditTensionDirectorDefinition(definition);
  if (!audit.passed) {
    throw new Error(`Invalid tension director definition: ${audit.failures.join("; ")}`);
  }
}

function validateSignals(
  definition: Readonly<TensionDirectorDefinition>,
  state: Readonly<TensionDirectorState>,
  signals: Readonly<TensionDirectorSignals>,
) {
  const extraKeys = unexpectedKeys(signals, SIGNAL_KEYS);
  if (extraKeys.length > 0) {
    throw new Error(
      `Tension director signals contain unsupported fields: ${extraKeys.join(", ")}`,
    );
  }
  if (!Number.isInteger(signals.tick) || signals.tick !== state.currentTick + 1) {
    throw new Error(
      `Tension director requires consecutive fixed ticks; expected ${state.currentTick + 1}`,
    );
  }
  if (!["playing", "paused", "complete"].includes(signals.runPhase)) {
    throw new Error("Tension director run phase is invalid");
  }
  if (!["safe", "suspicious", "chased"].includes(signals.threat)) {
    throw new Error("Tension director threat state is invalid");
  }
  if (!isNonNegativeInteger(signals.safeTicks)) {
    throw new Error("Tension director safeTicks must be a non-negative integer");
  }
  if (!isNonNegativeInteger(signals.chaseTicks)) {
    throw new Error("Tension director chaseTicks must be a non-negative integer");
  }
  if (
    signals.ticksSinceChaseEscape !== null
    && !isNonNegativeInteger(signals.ticksSinceChaseEscape)
  ) {
    throw new Error(
      "Tension director ticksSinceChaseEscape must be null or a non-negative integer",
    );
  }
  if (signals.threat === "safe" && signals.chaseTicks !== 0) {
    throw new Error("Safe director signals cannot report active chase ticks");
  }
  if (
    signals.threat === "chased"
    && (signals.safeTicks !== 0 || signals.chaseTicks === 0)
  ) {
    throw new Error(
      "Chased director signals require a positive chase streak and no safe streak",
    );
  }
  if (
    signals.threat === "suspicious"
    && (signals.safeTicks !== 0 || signals.chaseTicks !== 0)
  ) {
    throw new Error("Suspicious director signals must reset safe and chase streaks");
  }
  for (const [name, value] of [
    ["missionProgressPermille", signals.missionProgressPermille],
    ["resourcesRemainingPermille", signals.resourcesRemainingPermille],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 1_000) {
      throw new Error(`${name} must be an integer from 0 to 1000`);
    }
  }
  if (!Array.isArray(signals.legalRouteIds)) {
    throw new Error("Tension director legalRouteIds must be an array");
  }
  const duplicates = duplicateValues(signals.legalRouteIds);
  if (duplicates.length > 0) {
    throw new Error(`Tension director legal routes contain duplicates: ${duplicates.join(", ")}`);
  }
  const knownRoutes = new Set(definition.routeIds);
  const unknownRoutes = signals.legalRouteIds
    .filter((routeId) => !knownRoutes.has(routeId));
  if (unknownRoutes.length > 0) {
    throw new Error(
      `Tension director received unknown legal routes: ${unknownRoutes.join(", ")}`,
    );
  }
}

function validateState(
  definition: Readonly<TensionDirectorDefinition>,
  state: Readonly<TensionDirectorState>,
) {
  if (
    state.version !== TENSION_DIRECTOR_VERSION
    || state.definitionId !== definition.id
    || !isNonNegativeInteger(state.currentTick)
    || !["rest", "watchful", "heightened"].includes(state.tier)
    || !Number.isInteger(state.score)
    || state.score < 0
    || state.score > 1_000
  ) {
    throw new Error("Tension director state does not match its definition");
  }
  if (state.cooldowns.length !== definition.events.length) {
    throw new Error("Tension director state has an invalid cooldown table");
  }
  for (const [index, cooldown] of state.cooldowns.entries()) {
    if (
      cooldown.eventId !== definition.events[index].id
      || !isNonNegativeInteger(cooldown.readyAtTick)
    ) {
      throw new Error("Tension director cooldown table is not canonical");
    }
  }
  if (
    !isNonNegativeInteger(state.globalReadyAtTick)
    || !isNonNegativeInteger(state.breatherUntilTick)
    || !isNonNegativeInteger(state.selectionCursor)
    || state.selectionCursor >= definition.events.length
    || !Number.isInteger(state.nextSequence)
    || state.nextSequence < 1
    || !isNonNegativeInteger(state.completedEventCount)
  ) {
    throw new Error("Tension director state counters are invalid");
  }
  if (state.activeEvent) {
    const suggestion = state.activeEvent.suggestion;
    const event = definition.events.find(({ id }) => id === suggestion.eventId);
    if (
      !event
      || !["warning", "active"].includes(state.activeEvent.phase)
      || suggestion.startsAtTick - suggestion.announcedAtTick !== event.warningTicks
      || suggestion.endsAtTick - suggestion.startsAtTick !== event.durationTicks
      || suggestion.announcedAtTick > state.currentTick
      || suggestion.endsAtTick <= state.currentTick
      || (
        state.activeEvent.phase === "warning"
        && state.currentTick >= suggestion.startsAtTick
      )
      || (
        state.activeEvent.phase === "active"
        && state.currentTick < suggestion.startsAtTick
      )
    ) {
      throw new Error("Tension director active event schedule is invalid");
    }
  }
}

export function createInitialTensionDirectorState(
  definition: Readonly<TensionDirectorDefinition>,
): TensionDirectorState {
  validateTensionDirectorDefinition(definition);
  return Object.freeze({
    version: TENSION_DIRECTOR_VERSION,
    definitionId: definition.id,
    currentTick: 0,
    tier: "rest",
    score: 0,
    activeEvent: null,
    cooldowns: Object.freeze(definition.events.map(({ id }) => Object.freeze({
      eventId: id,
      readyAtTick: 0,
    }))),
    globalReadyAtTick: 0,
    breatherUntilTick: 0,
    selectionCursor: 0,
    nextSequence: 1,
    lastEventId: null,
    completedEventCount: 0,
  });
}

function scaledScore(
  value: number,
  start: number,
  end: number,
  maximum: number,
): number {
  if (value <= start) return 0;
  if (value >= end) return maximum;
  return Math.floor(((value - start) * maximum) / (end - start));
}

export function tensionDirectorScore(
  policy: Readonly<TensionDirectorPolicy>,
  signals: Pick<
    TensionDirectorSignals,
    "safeTicks" | "missionProgressPermille" | "resourcesRemainingPermille"
  >,
): number {
  const safeScore = scaledScore(
    signals.safeTicks,
    policy.safeRampStartTicks,
    policy.safeRampEndTicks,
    policy.safeScoreMaximum,
  );
  const missionScore = Math.floor(
    (signals.missionProgressPermille * policy.missionScoreMaximum) / 1_000,
  );
  const resourceScore = Math.floor(
    (signals.resourcesRemainingPermille * policy.resourceScoreMaximum) / 1_000,
  );
  return clamp(safeScore + missionScore + resourceScore, 0, 1_000);
}

export function tensionTierWithHysteresis(
  previousTier: TensionTier,
  score: number,
  resourcesRemainingPermille: number,
  policy: Readonly<TensionDirectorPolicy>,
): TensionTier {
  if (resourcesRemainingPermille <= policy.criticalResourcePermille) return "rest";
  const heightenedAllowed = resourcesRemainingPermille
    >= policy.heightenedResourceFloorPermille;
  if (previousTier === "heightened") {
    if (heightenedAllowed && score > policy.heightenedExitScore) {
      return "heightened";
    }
    return score > policy.watchfulExitScore ? "watchful" : "rest";
  }
  if (
    heightenedAllowed
    && score >= policy.heightenedEnterScore
  ) {
    return "heightened";
  }
  if (previousTier === "watchful") {
    return score > policy.watchfulExitScore ? "watchful" : "rest";
  }
  return score >= policy.watchfulEnterScore ? "watchful" : "rest";
}

function recentEscapeTicksRemaining(
  policy: Readonly<TensionDirectorPolicy>,
  signals: Readonly<TensionDirectorSignals>,
): number {
  if (signals.ticksSinceChaseEscape === null) return 0;
  return Math.max(
    0,
    policy.escapeBreatherTicks - signals.ticksSinceChaseEscape,
  );
}

function protectionReason(
  definition: Readonly<TensionDirectorDefinition>,
  signals: Readonly<TensionDirectorSignals>,
): Exclude<TensionDirectorTerminationReason, "completed" | "route-protection">
| null {
  if (signals.runPhase !== "playing") return "run-inactive";
  if (signals.threat !== "safe") return "danger-protection";
  if (recentEscapeTicksRemaining(definition.policy, signals) > 0) {
    return "recent-escape-protection";
  }
  if (
    signals.resourcesRemainingPermille
    <= definition.policy.criticalResourcePermille
  ) {
    return "resource-protection";
  }
  return null;
}

function withCooldown(
  cooldowns: readonly TensionDirectorCooldown[],
  eventId: string,
  readyAtTick: number,
): readonly TensionDirectorCooldown[] {
  return Object.freeze(cooldowns.map((cooldown) => Object.freeze(
    cooldown.eventId === eventId
      ? { ...cooldown, readyAtTick }
      : { ...cooldown },
  )));
}

function freezeSuggestion(
  suggestion: TensionDirectorSuggestion,
): TensionDirectorSuggestion {
  return Object.freeze({
    ...suggestion,
    blockedRouteIds: Object.freeze([...suggestion.blockedRouteIds]),
    safety: Object.freeze({
      ...suggestion.safety,
      legalRouteIdsAtSuggestion: Object.freeze([
        ...suggestion.safety.legalRouteIdsAtSuggestion,
      ]),
      preservedLegalRouteIds: Object.freeze([
        ...suggestion.safety.preservedLegalRouteIds,
      ]),
    }),
  });
}

function makeSuggestion(
  definition: Readonly<TensionDirectorDefinition>,
  event: Readonly<TensionDirectorEventDefinition>,
  state: Readonly<TensionDirectorState>,
  signals: Readonly<TensionDirectorSignals>,
): TensionDirectorSuggestion {
  const legalRoutes = canonicalLegalRouteIds(definition, signals.legalRouteIds);
  const preservedRoutes = preservedRouteIds(
    definition,
    event,
    signals.legalRouteIds,
  );
  const startsAtTick = signals.tick + event.warningTicks;
  return freezeSuggestion({
    suggestionId: `${definition.id}:${state.nextSequence}:${event.id}`,
    sequence: state.nextSequence,
    eventId: event.id,
    label: event.label,
    kind: event.kind,
    publicChannelId: event.publicChannelId,
    intensityPermille: event.intensityPermille,
    blockedRouteIds: event.blockedRouteIds,
    announcedAtTick: signals.tick,
    startsAtTick,
    endsAtTick: startsAtTick + event.durationTicks,
    safety: {
      sourcePolicy: "public-aggregate-signals-only",
      warningTicks: event.warningTicks,
      durationTicks: event.durationTicks,
      legalRouteIdsAtSuggestion: legalRoutes,
      preservedLegalRouteIds: preservedRoutes,
      minimumLegalRouteCount: definition.minimumLegalRouteCount,
      routeGuarantee: true,
    },
  });
}

function eligibleEvents(
  definition: Readonly<TensionDirectorDefinition>,
  state: Readonly<TensionDirectorState>,
  signals: Readonly<TensionDirectorSignals>,
  tier: TensionTier,
): readonly {
  readonly definitionIndex: number;
  readonly event: TensionDirectorEventDefinition;
}[] {
  return definition.events.flatMap((event, definitionIndex) => {
    const cooldown = state.cooldowns[definitionIndex];
    if (TIER_RANK[tier] < TIER_RANK[event.minimumTier]) return [];
    if (cooldown.readyAtTick > signals.tick) return [];
    if (!routeIsSafe(definition, event, signals.legalRouteIds)) return [];
    return [{ definitionIndex, event }];
  });
}

function chooseEvent(
  definition: Readonly<TensionDirectorDefinition>,
  eligible: readonly {
    readonly definitionIndex: number;
    readonly event: TensionDirectorEventDefinition;
  }[],
  selectionCursor: number,
): {
  readonly definitionIndex: number;
  readonly event: TensionDirectorEventDefinition;
} | null {
  if (eligible.length === 0) return null;
  const eligibleByIndex = new Map(
    eligible.map((candidate) => [candidate.definitionIndex, candidate]),
  );
  for (let offset = 0; offset < definition.events.length; offset += 1) {
    const index = (selectionCursor + offset) % definition.events.length;
    const candidate = eligibleByIndex.get(index);
    if (candidate) return candidate;
  }
  return null;
}

function suppressionReasons(
  definition: Readonly<TensionDirectorDefinition>,
  state: Readonly<TensionDirectorState>,
  signals: Readonly<TensionDirectorSignals>,
  tier: TensionTier,
): readonly TensionDirectorSuppressionReason[] {
  const reasons: TensionDirectorSuppressionReason[] = [];
  if (state.activeEvent) reasons.push("event-in-flight");
  if (signals.runPhase !== "playing") reasons.push("run-inactive");
  if (signals.threat !== "safe") reasons.push("danger-present");
  if (recentEscapeTicksRemaining(definition.policy, signals) > 0) {
    reasons.push("recent-escape");
  }
  if (signals.tick < state.breatherUntilTick) reasons.push("breathing-window");
  if (
    signals.safeTicks
    < definition.policy.minimumSafeTicksBeforePressure
  ) {
    reasons.push("minimum-safe-window");
  }
  if (signals.tick < state.globalReadyAtTick) reasons.push("global-calm-window");
  if (
    signals.resourcesRemainingPermille
    <= definition.policy.criticalResourcePermille
  ) {
    reasons.push("critical-resources");
  }
  if (tier === "rest") reasons.push("low-tension");
  if (signals.legalRouteIds.length < definition.minimumLegalRouteCount) {
    reasons.push("no-legal-route");
  }
  if (reasons.length > 0) return Object.freeze(reasons);

  const tierEligible = definition.events.filter((event) => (
    TIER_RANK[tier] >= TIER_RANK[event.minimumTier]
  ));
  if (tierEligible.length === 0) {
    return Object.freeze(["no-tier-eligible-event"]);
  }
  const cooldownEligible = tierEligible.filter((event) => (
    state.cooldowns.find(({ eventId }) => eventId === event.id)!.readyAtTick
      <= signals.tick
  ));
  if (cooldownEligible.length === 0) {
    return Object.freeze(["all-eligible-events-cooling-down"]);
  }
  if (
    !cooldownEligible.some((event) => (
      routeIsSafe(definition, event, signals.legalRouteIds)
    ))
  ) {
    return Object.freeze(["no-route-safe-event"]);
  }
  return Object.freeze([]);
}

function updatedBreatherUntilTick(
  definition: Readonly<TensionDirectorDefinition>,
  state: Readonly<TensionDirectorState>,
  signals: Readonly<TensionDirectorSignals>,
): number {
  let until = state.breatherUntilTick;
  if (signals.runPhase !== "playing") {
    until = Math.max(
      until,
      signals.tick + definition.policy.minimumSafeTicksBeforePressure,
    );
  }
  if (signals.threat === "suspicious") {
    until = Math.max(
      until,
      signals.tick + definition.policy.suspiciousBreatherTicks,
    );
  }
  if (signals.threat === "chased") {
    // A long chase earns proportionally more recovery, capped at one extra
    // base breather. This consumes only the public chase-duration aggregate.
    const longChaseRecoveryTicks = Math.min(
      definition.policy.chaseBreatherTicks,
      signals.chaseTicks,
    );
    until = Math.max(
      until,
      signals.tick
        + definition.policy.chaseBreatherTicks
        + longChaseRecoveryTicks,
    );
  }
  const escapeRemaining = recentEscapeTicksRemaining(definition.policy, signals);
  if (escapeRemaining > 0) {
    until = Math.max(until, signals.tick + escapeRemaining);
  }
  if (
    signals.resourcesRemainingPermille
    <= definition.policy.criticalResourcePermille
  ) {
    until = Math.max(
      until,
      signals.tick + definition.policy.resourceRecoveryBreatherTicks,
    );
  }
  return until;
}

function finishActiveEvent(
  definition: Readonly<TensionDirectorDefinition>,
  activeEvent: Readonly<TensionDirectorActiveEvent>,
  cooldowns: readonly TensionDirectorCooldown[],
  tick: number,
  reason: TensionDirectorTerminationReason,
): {
  readonly cooldowns: readonly TensionDirectorCooldown[];
  readonly lifecycleEvent: TensionDirectorLifecycleEvent;
  readonly completedIncrement: number;
} {
  const event = definition.events.find(
    ({ id }) => id === activeEvent.suggestion.eventId,
  )!;
  const eventType = activeEvent.phase === "warning"
    ? "event-cancelled"
    : "event-ended";
  const lifecycleEvent = Object.freeze({
    type: eventType,
    atTick: tick,
    suggestionId: activeEvent.suggestion.suggestionId,
    eventId: event.id,
    reason,
  }) as TensionDirectorLifecycleEvent;
  return Object.freeze({
    cooldowns: withCooldown(cooldowns, event.id, tick + event.cooldownTicks),
    lifecycleEvent,
    completedIncrement: reason === "completed" ? 1 : 0,
  });
}

export function stepTensionDirector(
  definition: Readonly<TensionDirectorDefinition>,
  state: Readonly<TensionDirectorState>,
  signals: Readonly<TensionDirectorSignals>,
): TensionDirectorStep {
  validateTensionDirectorDefinition(definition);
  validateState(definition, state);
  validateSignals(definition, state, signals);

  const score = tensionDirectorScore(definition.policy, signals);
  const tier = tensionTierWithHysteresis(
    state.tier,
    score,
    signals.resourcesRemainingPermille,
    definition.policy,
  );
  const lifecycleEvents: TensionDirectorLifecycleEvent[] = [];
  if (tier !== state.tier) {
    lifecycleEvents.push(Object.freeze({
      type: "tier-changed",
      atTick: signals.tick,
      from: state.tier,
      to: tier,
      score,
    }));
  }

  let activeEvent = state.activeEvent;
  let cooldowns = state.cooldowns;
  let globalReadyAtTick = state.globalReadyAtTick;
  let completedEventCount = state.completedEventCount;
  const breatherUntilTick = updatedBreatherUntilTick(
    definition,
    state,
    signals,
  );

  if (activeEvent) {
    const activeDefinition = definition.events.find(
      ({ id }) => id === activeEvent!.suggestion.eventId,
    )!;
    let termination: TensionDirectorTerminationReason | null = null;
    if (signals.tick >= activeEvent.suggestion.endsAtTick) {
      termination = "completed";
    } else if (
      !routeIsSafe(definition, activeDefinition, signals.legalRouteIds)
    ) {
      termination = "route-protection";
    } else {
      termination = protectionReason(definition, signals);
    }

    if (termination) {
      const finished = finishActiveEvent(
        definition,
        activeEvent,
        cooldowns,
        signals.tick,
        termination,
      );
      cooldowns = finished.cooldowns;
      completedEventCount += finished.completedIncrement;
      globalReadyAtTick = Math.max(
        globalReadyAtTick,
        signals.tick + definition.policy.minimumCalmTicksAfterEvent,
      );
      lifecycleEvents.push(finished.lifecycleEvent);
      activeEvent = null;
    } else if (
      activeEvent.phase === "warning"
      && signals.tick >= activeEvent.suggestion.startsAtTick
    ) {
      activeEvent = Object.freeze({
        phase: "active",
        suggestion: activeEvent.suggestion,
      });
      lifecycleEvents.push(Object.freeze({
        type: "event-activated",
        atTick: signals.tick,
        suggestionId: activeEvent.suggestion.suggestionId,
        eventId: activeEvent.suggestion.eventId,
      }));
    }
  }

  const intermediateState: TensionDirectorState = Object.freeze({
    ...state,
    currentTick: signals.tick,
    tier,
    score,
    activeEvent,
    cooldowns,
    globalReadyAtTick,
    breatherUntilTick,
    completedEventCount,
  });
  const reasons = suppressionReasons(
    definition,
    intermediateState,
    signals,
    tier,
  );

  let suggestion: TensionDirectorSuggestion | null = null;
  let nextState = intermediateState;
  if (reasons.length === 0) {
    const chosen = chooseEvent(
      definition,
      eligibleEvents(definition, intermediateState, signals, tier),
      state.selectionCursor,
    );
    if (chosen) {
      suggestion = makeSuggestion(
        definition,
        chosen.event,
        intermediateState,
        signals,
      );
      const scheduled = Object.freeze({
        phase: "warning" as const,
        suggestion,
      });
      nextState = Object.freeze({
        ...intermediateState,
        activeEvent: scheduled,
        selectionCursor: (chosen.definitionIndex + 1) % definition.events.length,
        nextSequence: state.nextSequence + 1,
        lastEventId: chosen.event.id,
      });
      lifecycleEvents.push(Object.freeze({
        type: "event-suggested",
        atTick: signals.tick,
        suggestion,
      }));
    }
  }

  return Object.freeze({
    state: nextState,
    score,
    tier,
    lifecycleEvents: Object.freeze(lifecycleEvents),
    suggestion,
    suppressionReasons: suggestion
      ? Object.freeze([])
      : reasons,
  });
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function replayTensionDirector(
  definition: Readonly<TensionDirectorDefinition>,
  signals: readonly Readonly<TensionDirectorSignals>[],
  initialState = createInitialTensionDirectorState(definition),
): TensionDirectorReplay {
  let state = initialState;
  const lifecycleEvents: TensionDirectorLifecycleEvent[] = [];
  for (const tickSignals of signals) {
    const step = stepTensionDirector(definition, state, tickSignals);
    state = step.state;
    lifecycleEvents.push(...step.lifecycleEvents);
  }
  const frozenEvents = Object.freeze(lifecycleEvents);
  return Object.freeze({
    state,
    lifecycleEvents: frozenEvents,
    fingerprint: stableHash(JSON.stringify({ state, lifecycleEvents: frozenEvents })),
  });
}

/**
 * Executes an authored aggregate-signal trace and independently verifies the
 * warning, duration, cooldown, no-overlap, and route-preservation certificates.
 */
export function auditTensionDirectorSafety(
  definition: Readonly<TensionDirectorDefinition>,
  signalTrace: readonly Readonly<TensionDirectorSignals>[] = [],
  initialState?: Readonly<TensionDirectorState>,
): TensionDirectorSafetyAudit {
  const definitionAudit = auditTensionDirectorDefinition(definition);
  const failures = [...definitionAudit.failures];
  if (!definitionAudit.passed) {
    return Object.freeze({
      passed: false,
      failures: Object.freeze(failures),
      definition: definitionAudit,
      processedTicks: 0,
      suggestionsAudited: 0,
      activationsAudited: 0,
      minimumPreservedRouteCount: null,
      finalState: null,
    });
  }

  let state = initialState ?? createInitialTensionDirectorState(definition);
  let processedTicks = 0;
  let suggestionsAudited = 0;
  let activationsAudited = 0;
  let minimumPreservedRouteCount: number | null = null;
  let inFlightSuggestionId = state.activeEvent?.suggestion.suggestionId ?? null;
  const lastReadyTickByEvent = new Map(
    state.cooldowns.map(({ eventId, readyAtTick }) => [eventId, readyAtTick]),
  );

  for (const signals of signalTrace) {
    const priorState = state;
    let step: TensionDirectorStep;
    try {
      step = stepTensionDirector(definition, state, signals);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`Trace tick ${String(signals.tick)} rejected: ${message}`);
      break;
    }
    processedTicks += 1;
    state = step.state;
    for (const lifecycle of step.lifecycleEvents) {
      if (lifecycle.type === "event-suggested") {
        suggestionsAudited += 1;
        const suggestion = lifecycle.suggestion;
        const event = definition.events.find(({ id }) => id === suggestion.eventId)!;
        if (inFlightSuggestionId !== null) {
          failures.push(
            `Tick ${signals.tick} overlapped suggestion ${suggestion.suggestionId}`,
          );
        }
        inFlightSuggestionId = suggestion.suggestionId;
        if (
          suggestion.startsAtTick - suggestion.announcedAtTick
          < definition.policy.minimumWarningTicks
        ) {
          failures.push(`${suggestion.suggestionId} violated warning minimum`);
        }
        if (
          suggestion.endsAtTick - suggestion.startsAtTick <= 0
          || suggestion.endsAtTick - suggestion.startsAtTick
            > definition.policy.maximumEventDurationTicks
        ) {
          failures.push(`${suggestion.suggestionId} violated duration bounds`);
        }
        if (
          suggestion.safety.preservedLegalRouteIds.length
          < definition.minimumLegalRouteCount
        ) {
          failures.push(`${suggestion.suggestionId} did not preserve a legal route`);
        }
        minimumPreservedRouteCount = minimumPreservedRouteCount === null
          ? suggestion.safety.preservedLegalRouteIds.length
          : Math.min(
              minimumPreservedRouteCount,
              suggestion.safety.preservedLegalRouteIds.length,
            );
        if (
          lifecycle.atTick
          < (lastReadyTickByEvent.get(event.id) ?? 0)
        ) {
          failures.push(`${suggestion.suggestionId} violated its event cooldown`);
        }
        if (
          signals.runPhase !== "playing"
          || signals.threat !== "safe"
          || recentEscapeTicksRemaining(definition.policy, signals) > 0
          || signals.resourcesRemainingPermille
            <= definition.policy.criticalResourcePermille
        ) {
          failures.push(`${suggestion.suggestionId} was proposed during protection`);
        }
        if (
          lifecycle.atTick < priorState.globalReadyAtTick
          || lifecycle.atTick < priorState.breatherUntilTick
        ) {
          failures.push(`${suggestion.suggestionId} violated a global safe window`);
        }
      } else if (lifecycle.type === "event-activated") {
        activationsAudited += 1;
        const active = state.activeEvent;
        if (
          !active
          || active.phase !== "active"
          || lifecycle.atTick !== active.suggestion.startsAtTick
        ) {
          failures.push(`${lifecycle.suggestionId} activated off schedule`);
        }
      } else if (
        lifecycle.type === "event-ended"
        || lifecycle.type === "event-cancelled"
      ) {
        if (inFlightSuggestionId !== lifecycle.suggestionId) {
          failures.push(`${lifecycle.suggestionId} ended without matching ownership`);
        }
        inFlightSuggestionId = null;
        const event = definition.events.find(({ id }) => id === lifecycle.eventId)!;
        lastReadyTickByEvent.set(
          event.id,
          lifecycle.atTick + event.cooldownTicks,
        );
      }
    }
  }

  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    definition: definitionAudit,
    processedTicks,
    suggestionsAudited,
    activationsAudited,
    minimumPreservedRouteCount,
    finalState: state,
  });
}
