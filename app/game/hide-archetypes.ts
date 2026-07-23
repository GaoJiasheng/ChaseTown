import type {
  HideArchetypeKind as ContractHideArchetypeKind,
  HideExitKind as ContractHideExitKind,
  HideSpotDefinition,
  LevelDefinition,
  PerceptionEvidence,
  Point,
} from "./contracts.ts";
import { findPath, isWalkable, pointKey } from "./navigation.ts";
import type { SoundStimulus } from "./perception.ts";

export type HideArchetypeKind = ContractHideArchetypeKind;
export type HideRiskBand = "low" | "medium" | "high";
export type HideExitKind = ContractHideExitKind;
export type HideTransitionKind = "enter" | "exit-origin" | "exit-alternate" | "peek";

export interface HideArchetypeRisk {
  readonly entry: HideRiskBand;
  readonly waiting: HideRiskBand;
  readonly search: HideRiskBand;
  readonly exit: HideRiskBand;
}

export interface HideArchetypeCapabilities {
  readonly concealment: "full" | "partial";
  readonly canPeek: boolean;
  readonly canExitOrigin: true;
  readonly canExitAlternate: boolean;
  readonly requiresAlternateExit: boolean;
}

export interface HideArchetypeEvidenceProfile {
  readonly entrySoundStrength: number;
  readonly exitSoundStrength: number;
  readonly peekSoundStrength: number;
  /** Public visual disturbance while occupied; zero means a fully shut volume. */
  readonly occupiedVisualDisturbance: number;
  /** Public geometry prior used only to rank an unwitnessed, plausible check. */
  readonly publicSearchAppeal: number;
  /** Exact identity remains illegal unless perception explicitly saw entry. */
  readonly exactCheckRequiresWitnessedEntry: true;
}

export interface HideArchetypeTiming {
  /** Multipliers over the current authored locker timings. */
  readonly enterDurationMultiplier: number;
  readonly exitDurationMultiplier: number;
  readonly peekDurationMultiplier: number;
}

export interface HideArchetypeProfile {
  readonly kind: HideArchetypeKind;
  readonly label: string;
  readonly playerHint: string;
  readonly risk: HideArchetypeRisk;
  readonly capabilities: HideArchetypeCapabilities;
  readonly evidence: HideArchetypeEvidenceProfile;
  readonly timing: HideArchetypeTiming;
}

export interface HideSpotArchetypeBinding {
  readonly hideSpotId: string;
  readonly archetype: HideArchetypeKind;
  /** Required only for traversal-hide; must be public, walkable geometry. */
  readonly alternateExit?: Point;
}

export interface ResolvedHideSpotArchetype {
  readonly hideSpotId: string;
  readonly archetype: HideArchetypeKind;
  readonly profile: HideArchetypeProfile;
  readonly approach: Point;
  readonly concealed: Point;
  readonly facing: Point;
  readonly alternateExit: Point | null;
  /** True when an existing unannotated locker uses the compatibility default. */
  readonly legacyDefault: boolean;
}

export interface HideExitOption {
  readonly kind: HideExitKind;
  readonly position: Point;
}

export interface HideTransitionEvidence {
  readonly hideSpotId: string;
  readonly transition: HideTransitionKind;
  readonly sound: SoundStimulus | null;
  readonly visualExposureMultiplier: number;
  readonly publicClue: "door-motion" | "cover-disturbance" | "passage-motion";
  /**
   * This module never grants an exact AI check. Only hide-entry-visible from
   * the visual perception boundary may do so.
   */
  readonly exactHideSpotIdLegallyExposed: false;
}

export interface HideArchetypeAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly resolved: readonly ResolvedHideSpotArchetype[];
}

export interface HideArchetypeSafetyPolicy {
  readonly requireHardLocker?: boolean;
  readonly requireSoftCover?: boolean;
  readonly requireTraversalHide?: boolean;
}

export interface LegalHideQueryOptions {
  readonly maximumRouteDistance: number;
  readonly maximumCandidates?: number;
  readonly inspectedHideSpotIds?: readonly string[];
}

export interface LegalHideCandidate {
  readonly hideSpotId: string;
  readonly archetype: HideArchetypeKind;
  readonly approach: Point;
  readonly routeDistance: number;
  readonly confidence: number;
  readonly reason: "witnessed-entry" | "public-geometry";
  readonly exact: boolean;
}

const profile = (value: HideArchetypeProfile): HideArchetypeProfile => Object.freeze({
  ...value,
  risk: Object.freeze({ ...value.risk }),
  capabilities: Object.freeze({ ...value.capabilities }),
  evidence: Object.freeze({ ...value.evidence }),
  timing: Object.freeze({ ...value.timing }),
});

export const HIDE_ARCHETYPE_PROFILES: Readonly<Record<HideArchetypeKind, HideArchetypeProfile>> = Object.freeze({
  "hard-locker": profile({
    kind: "hard-locker",
    label: "硬质藏柜",
    playerHint: "进入较慢且柜门有声；关严后完全遮蔽，但追捕者可能检查柜门。",
    risk: { entry: "medium", waiting: "low", search: "high", exit: "medium" },
    capabilities: {
      concealment: "full",
      canPeek: true,
      canExitOrigin: true,
      canExitAlternate: false,
      requiresAlternateExit: false,
    },
    evidence: {
      entrySoundStrength: 0.5,
      exitSoundStrength: 0.28,
      peekSoundStrength: 0.12,
      occupiedVisualDisturbance: 0,
      publicSearchAppeal: 0.82,
      exactCheckRequiresWitnessedEntry: true,
    },
    timing: {
      enterDurationMultiplier: 1,
      exitDurationMultiplier: 1,
      peekDurationMultiplier: 1,
    },
  }),
  "soft-cover": profile({
    kind: "soft-cover",
    label: "软质遮挡",
    playerHint: "钻入很快、声音较轻，但布帘或桌下仍会留下轻微视觉扰动。",
    risk: { entry: "low", waiting: "medium", search: "medium", exit: "low" },
    capabilities: {
      concealment: "partial",
      canPeek: false,
      canExitOrigin: true,
      canExitAlternate: false,
      requiresAlternateExit: false,
    },
    evidence: {
      entrySoundStrength: 0.2,
      exitSoundStrength: 0.16,
      peekSoundStrength: 0,
      occupiedVisualDisturbance: 0.24,
      publicSearchAppeal: 0.38,
      exactCheckRequiresWitnessedEntry: true,
    },
    timing: {
      enterDurationMultiplier: 0.58,
      exitDurationMultiplier: 0.62,
      peekDurationMultiplier: 0,
    },
  }),
  "traversal-hide": profile({
    kind: "traversal-hide",
    label: "穿越式藏点",
    playerHint: "可从另一侧离开并改变路线；穿行会制造更明显的两端动静。",
    risk: { entry: "medium", waiting: "low", search: "medium", exit: "high" },
    capabilities: {
      concealment: "full",
      canPeek: false,
      canExitOrigin: true,
      canExitAlternate: true,
      requiresAlternateExit: true,
    },
    evidence: {
      entrySoundStrength: 0.36,
      exitSoundStrength: 0.46,
      peekSoundStrength: 0,
      occupiedVisualDisturbance: 0,
      publicSearchAppeal: 0.58,
      exactCheckRequiresWitnessedEntry: true,
    },
    timing: {
      enterDurationMultiplier: 0.82,
      exitDurationMultiplier: 0.76,
      peekDurationMultiplier: 0,
    },
  }),
});

export const HIDE_AI_FAIRNESS_CONTRACT = Object.freeze({
  exactCheckEvidenceKind: "hide-entry-visible" as const,
  occupancyReadable: false as const,
  concealedPositionReadable: false as const,
  alternateExitChoiceReadable: false as const,
  unwitnessedRankingInputs: Object.freeze([
    "perceived-evidence-position",
    "public-navigation-distance",
    "public-archetype",
    "already-inspected-ids",
  ] as const),
});

export function hideArchetypeProfile(kind: HideArchetypeKind): HideArchetypeProfile {
  return HIDE_ARCHETYPE_PROFILES[kind];
}

function bindingMap(
  bindings: readonly HideSpotArchetypeBinding[],
): ReadonlyMap<string, HideSpotArchetypeBinding> {
  const result = new Map<string, HideSpotArchetypeBinding>();
  for (const binding of bindings) {
    if (!binding.hideSpotId.trim()) throw new Error("Hide archetype binding id must not be empty");
    if (!Object.hasOwn(HIDE_ARCHETYPE_PROFILES, binding.archetype)) {
      throw new Error(`Unknown hide archetype: ${String(binding.archetype)}`);
    }
    if (result.has(binding.hideSpotId)) throw new Error(`Duplicate hide archetype binding: ${binding.hideSpotId}`);
    result.set(binding.hideSpotId, binding);
  }
  return result;
}

/**
 * Compatibility adapter. Every existing HideSpotDefinition remains a fully
 * functional hard locker until a level explicitly supplies a binding.
 */
export function resolveHideSpotArchetype(
  spot: HideSpotDefinition,
  binding?: HideSpotArchetypeBinding,
): ResolvedHideSpotArchetype {
  if (binding && binding.hideSpotId !== spot.id) {
    throw new Error(`Hide binding ${binding.hideSpotId} does not match ${spot.id}`);
  }
  const archetype = binding?.archetype ?? spot.archetype ?? "hard-locker";
  if (!Object.hasOwn(HIDE_ARCHETYPE_PROFILES, archetype)) {
    throw new Error(`Unknown hide archetype: ${String(archetype)}`);
  }
  const alternateExit = binding?.alternateExit ?? spot.alternateExit;
  const selected = hideArchetypeProfile(archetype);
  return Object.freeze({
    hideSpotId: spot.id,
    archetype,
    profile: selected,
    approach: Object.freeze({ ...spot.approach }),
    concealed: Object.freeze({ ...spot.concealed }),
    facing: Object.freeze({ ...spot.facing }),
    alternateExit: alternateExit
      ? Object.freeze({ ...alternateExit })
      : null,
    legacyDefault: binding === undefined && spot.archetype === undefined,
  });
}

export function auditHideArchetypeBindings(
  level: LevelDefinition,
  bindings: readonly HideSpotArchetypeBinding[] = [],
): HideArchetypeAudit {
  const failures: string[] = [];
  let byId: ReadonlyMap<string, HideSpotArchetypeBinding>;
  try {
    byId = bindingMap(bindings);
  } catch (error) {
    return Object.freeze({
      passed: false,
      failures: Object.freeze([error instanceof Error ? error.message : "Invalid hide bindings"]),
      resolved: Object.freeze([]),
    });
  }
  const knownIds = new Set(level.hideSpots.map((spot) => spot.id));
  for (const binding of bindings) {
    if (!knownIds.has(binding.hideSpotId)) failures.push(`Unknown hide spot ${binding.hideSpotId}`);
  }
  const resolved = level.hideSpots.map((spot) => {
    const item = resolveHideSpotArchetype(spot, byId.get(spot.id));
    const requiresAlternate = item.profile.capabilities.requiresAlternateExit;
    if (requiresAlternate && !item.alternateExit) {
      failures.push(`Traversal hide ${spot.id} requires an alternate exit`);
    }
    if (!requiresAlternate && item.alternateExit) {
      failures.push(`${item.archetype} ${spot.id} cannot declare an alternate exit`);
    }
    if (item.alternateExit) {
      if (!isWalkable(level, item.alternateExit)) {
        failures.push(`Alternate exit for ${spot.id} is not walkable`);
      } else {
        const route = findPath(level, item.approach, item.alternateExit);
        if (route.length < 2) failures.push(`Alternate exit for ${spot.id} must be a distinct reachable cell`);
      }
    }
    return item;
  });
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    resolved: Object.freeze(resolved),
  });
}

/**
 * Authored-level safety audit layered over the compatibility audit. It keeps
 * the generic binding validator reusable while allowing campaign policy to
 * require a real hard locker and representative soft/traversal choices.
 */
export function auditHideArchetypeLevelSafety(
  level: LevelDefinition,
  policy: HideArchetypeSafetyPolicy = { requireHardLocker: true },
  bindings: readonly HideSpotArchetypeBinding[] = [],
): HideArchetypeAudit {
  const audit = auditHideArchetypeBindings(level, bindings);
  const failures = [...audit.failures];
  const archetypes = new Set(audit.resolved.map((spot) => spot.archetype));
  const requirements: readonly [keyof HideArchetypeSafetyPolicy, HideArchetypeKind][] = [
    ["requireHardLocker", "hard-locker"],
    ["requireSoftCover", "soft-cover"],
    ["requireTraversalHide", "traversal-hide"],
  ];
  for (const [flag, archetype] of requirements) {
    if (policy[flag] && !archetypes.has(archetype)) {
      failures.push(`${level.id} requires at least one ${archetype}`);
    }
  }
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    resolved: audit.resolved,
  });
}

export function hideExitOptions(
  resolved: ResolvedHideSpotArchetype,
): readonly HideExitOption[] {
  const options: HideExitOption[] = [{
    kind: "origin",
    position: Object.freeze({ ...resolved.approach }),
  }];
  if (resolved.profile.capabilities.canExitAlternate && resolved.alternateExit) {
    options.push({
      kind: "alternate",
      position: Object.freeze({ ...resolved.alternateExit }),
    });
  }
  return Object.freeze(options.map((option) => Object.freeze(option)));
}

function stableSourceId(hideSpotId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < hideSpotId.length; index += 1) {
    hash ^= hideSpotId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // The opaque id supports evidence habituation without encoding the locker id
  // into the public sound event.
  return `hide-source:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function hideTransitionEvidence(
  resolved: ResolvedHideSpotArchetype,
  transition: HideTransitionKind,
): HideTransitionEvidence {
  if (transition === "peek" && !resolved.profile.capabilities.canPeek) {
    throw new Error(`${resolved.archetype} does not support peeking`);
  }
  if (transition === "exit-alternate" && !resolved.profile.capabilities.canExitAlternate) {
    throw new Error(`${resolved.archetype} does not support an alternate exit`);
  }
  const strength = transition === "enter"
    ? resolved.profile.evidence.entrySoundStrength
    : transition === "peek"
      ? resolved.profile.evidence.peekSoundStrength
      : resolved.profile.evidence.exitSoundStrength;
  const position = transition === "exit-alternate" && resolved.alternateExit
    ? resolved.alternateExit
    : resolved.approach;
  const sound: SoundStimulus | null = strength > 0
    ? Object.freeze({
        position: Object.freeze({ ...position }),
        strength,
        sourceType: "hide-interaction",
        sourceId: stableSourceId(resolved.hideSpotId),
        confidence: resolved.archetype === "soft-cover" ? 0.58 : 0.82,
        decayPerSecond: resolved.archetype === "traversal-hide" ? 0.2 : 0.16,
      })
    : null;
  return Object.freeze({
    hideSpotId: resolved.hideSpotId,
    transition,
    sound,
    visualExposureMultiplier: transition === "enter"
      ? resolved.archetype === "soft-cover" ? 0.56 : 1
      : transition === "peek"
        ? 0.72
        : 1,
    publicClue: resolved.archetype === "hard-locker"
      ? "door-motion"
      : resolved.archetype === "soft-cover"
        ? "cover-disturbance"
        : "passage-motion",
    exactHideSpotIdLegallyExposed: false,
  });
}

function evidenceConfidence(evidence: Exclude<PerceptionEvidence, { kind: "none" }>): number {
  if (evidence.kind !== "sound") return 1;
  return Math.min(1, Math.max(0, evidence.confidence ?? evidence.strength));
}

function stableTieBreak(id: string, evidence: Exclude<PerceptionEvidence, { kind: "none" }>): number {
  const source = evidence.kind === "sound" ? evidence.sourceId ?? "anonymous" : evidence.kind;
  let hash = 0x811c9dc5;
  for (const character of `${source}:${evidence.observedAtSeconds.toFixed(3)}:${id}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * AI-facing legal query. The signature deliberately has no GameState,
 * HideSpotRuntimeState, concealed position or chosen traversal exit.
 */
export function queryLegalHideCandidates(
  level: LevelDefinition,
  bindings: readonly HideSpotArchetypeBinding[],
  evidence: PerceptionEvidence,
  options: LegalHideQueryOptions,
): readonly LegalHideCandidate[] {
  if (evidence.kind === "none") return Object.freeze([]);
  if (!Number.isFinite(options.maximumRouteDistance) || options.maximumRouteDistance < 0) {
    throw new Error("maximumRouteDistance must be a finite non-negative number");
  }
  if (
    options.maximumCandidates !== undefined
    && (!Number.isInteger(options.maximumCandidates) || options.maximumCandidates < 0)
  ) throw new Error("maximumCandidates must be a non-negative integer");
  const audit = auditHideArchetypeBindings(level, bindings);
  if (!audit.passed) throw new Error(`Invalid hide archetype bindings: ${audit.failures.join("; ")}`);
  const inspected = new Set(options.inspectedHideSpotIds ?? []);
  const maximum = Math.max(0, Math.floor(options.maximumCandidates ?? 3));

  if (evidence.kind === "hide-entry-visible") {
    const exact = audit.resolved.find((spot) => spot.hideSpotId === evidence.hideSpotId);
    if (!exact || maximum === 0) return Object.freeze([]);
    const exactRoute = findPath(level, evidence.position, exact.approach);
    if (!exactRoute.length) return Object.freeze([]);
    return Object.freeze([Object.freeze({
      hideSpotId: exact.hideSpotId,
      archetype: exact.archetype,
      approach: Object.freeze({ ...exact.approach }),
      routeDistance: exactRoute.length - 1,
      confidence: 1,
      reason: "witnessed-entry",
      exact: true,
    })]);
  }

  const confidence = evidenceConfidence(evidence);
  return Object.freeze(audit.resolved
    .filter((spot) => !inspected.has(spot.hideSpotId))
    .map((spot) => {
      const route = findPath(level, evidence.position, spot.approach);
      return {
        spot,
        routeDistance: route.length - 1,
        score: route.length
          ? route.length - 1 - spot.profile.evidence.publicSearchAppeal * 0.75
          : Number.POSITIVE_INFINITY,
        tieBreak: stableTieBreak(spot.hideSpotId, evidence),
      };
    })
    .filter(({ routeDistance }) => (
      routeDistance >= 0 && routeDistance <= options.maximumRouteDistance
    ))
    .sort((left, right) => (
      left.score - right.score
      || left.tieBreak - right.tieBreak
      || left.spot.hideSpotId.localeCompare(right.spot.hideSpotId)
    ))
    .slice(0, maximum)
    .map(({ spot, routeDistance }) => Object.freeze({
      hideSpotId: spot.hideSpotId,
      archetype: spot.archetype,
      approach: Object.freeze({ ...spot.approach }),
      routeDistance,
      confidence,
      reason: "public-geometry",
      exact: false,
    })));
}

export function hideArchetypeBindingKey(binding: HideSpotArchetypeBinding): string {
  return `${binding.hideSpotId}:${binding.archetype}:${binding.alternateExit ? pointKey(binding.alternateExit) : "-"}`;
}
