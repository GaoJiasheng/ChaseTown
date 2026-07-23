import type { CampaignTheme } from "./campaign.ts";
import type { Point } from "./contracts.ts";
import type { SoundStimulus } from "./perception.ts";

export type ThemeMechanicKind = "campus-bell" | "hospital-screen" | "fire-smoke" | "factory-machinery";

export interface ThemeMechanicProfile {
  readonly theme: CampaignTheme;
  readonly kind: ThemeMechanicKind;
  readonly cycleSeconds: number;
  readonly activeStartSeconds: number;
  readonly activeDurationSeconds: number;
  readonly label: string;
  readonly hudHint: string;
  /** Maximum mix of the authored event over normal threat audio. */
  readonly maximumSoundMasking: number;
  /** Lowest legal sight multiplier at the event's visual peak. */
  readonly minimumVisionRangeMultiplier: number;
}

export interface ThemeMechanicSample {
  readonly active: boolean;
  /** Normalized position through the active window; zero while inactive. */
  readonly progress: number;
  readonly label: string;
  readonly hudHint: string;
  /** 0..1, deliberately broad rather than a positional audio cue. */
  readonly soundMasking: number;
  /** Multiplier for perception range; never lower than the authored profile floor. */
  readonly visionRangeMultiplier: number;
}

export type MechanicPhase = "ready" | "warning" | "active" | "cooldown";
export type MechanicActivationCostKind = "noise" | "exposure" | "time";

export interface MechanicActivationCost {
  readonly kind: MechanicActivationCostKind;
  /** Normalized authored severity. The owning game system decides presentation. */
  readonly amount: number;
  readonly label: string;
}

export interface MechanicSoundSource {
  readonly sourceId: string;
  readonly sourceType: "environment-decoy" | "environment-hazard";
  readonly strength: number;
  readonly confidence: number;
  readonly decayPerSecond: number;
}

/**
 * Authoring contract for one placed, player-triggered theme mechanism.
 * Everything the AI may learn is explicit here; no hidden player state is
 * accepted or retained by the mechanism.
 */
export interface MechanicInstanceDefinition {
  readonly id: string;
  readonly theme: CampaignTheme;
  readonly kind: ThemeMechanicKind;
  readonly position: Point;
  readonly interactionRadius: number;
  readonly warningSeconds: number;
  readonly activeDurationSeconds: number;
  readonly effectRadius: number;
  readonly cooldownSeconds: number;
  readonly label: string;
  readonly warningHint: string;
  readonly activeHint: string;
  readonly maximumSoundMasking: number;
  readonly minimumVisionRangeMultiplier: number;
  readonly soundSource: MechanicSoundSource;
  readonly activationCost: MechanicActivationCost;
}

export interface MechanicInstance {
  readonly definition: MechanicInstanceDefinition;
  readonly phase: MechanicPhase;
  readonly phaseElapsedSeconds: number;
  readonly activationCount: number;
  readonly lastActivatedAtSeconds: number | null;
}

export interface MechanicInstanceInput {
  readonly deltaSeconds: number;
  readonly nowSeconds: number;
  readonly activationRequested?: boolean;
  readonly actorPosition?: Point;
}

export type MechanicInstanceEvent =
  | { readonly type: "warning-started"; readonly mechanicId: string }
  | {
      readonly type: "activation-cost-applied";
      readonly mechanicId: string;
      readonly cost: MechanicActivationCost;
    }
  | { readonly type: "activated"; readonly mechanicId: string }
  | { readonly type: "cooldown-started"; readonly mechanicId: string }
  | { readonly type: "ready"; readonly mechanicId: string };

export interface MechanicInstanceSample {
  readonly phase: MechanicPhase;
  readonly progress: number;
  readonly canActivate: boolean;
  readonly inEffectArea: boolean;
  readonly label: string;
  readonly hudHint: string;
  readonly soundMasking: number;
  readonly visionRangeMultiplier: number;
}

export interface MechanicInstanceStep {
  readonly instance: MechanicInstance;
  readonly sample: MechanicInstanceSample;
  readonly events: readonly MechanicInstanceEvent[];
  /**
   * Emitted exactly once when warning transitions to active. Feed this into
   * sampleSoundPerception(); never pass it straight to ChaserBrain.
   */
  readonly emittedSoundStimulus: SoundStimulus | null;
}

const profile = (value: ThemeMechanicProfile) => Object.freeze(value);

export const THEME_MECHANIC_PROFILES: Readonly<Record<CampaignTheme, ThemeMechanicProfile>> = Object.freeze({
  campus: profile({
    theme: "campus",
    kind: "campus-bell",
    cycleSeconds: 22,
    activeStartSeconds: 4,
    activeDurationSeconds: 3.2,
    label: "走廊铃声",
    hudHint: "铃声掩盖脚步，趁现在穿过走廊",
    maximumSoundMasking: 0.42,
    minimumVisionRangeMultiplier: 0.96,
  }),
  hospital: profile({
    theme: "hospital",
    kind: "hospital-screen",
    cycleSeconds: 18,
    activeStartSeconds: 6,
    activeDurationSeconds: 3.6,
    label: "自动门与帘幕",
    hudHint: "门帘移动，视线短暂受扰",
    maximumSoundMasking: 0.18,
    minimumVisionRangeMultiplier: 0.82,
  }),
  "fire-station": profile({
    theme: "fire-station",
    kind: "fire-smoke",
    cycleSeconds: 16,
    activeStartSeconds: 2,
    activeDurationSeconds: 4.8,
    label: "训练烟幕",
    hudHint: "烟幕升起，利用遮蔽切断视线",
    maximumSoundMasking: 0.3,
    minimumVisionRangeMultiplier: 0.68,
  }),
  factory: profile({
    theme: "factory",
    kind: "factory-machinery",
    cycleSeconds: 14,
    activeStartSeconds: 0,
    activeDurationSeconds: 5.4,
    label: "机器轰鸣",
    hudHint: "机器轰鸣，行动声更难分辨",
    maximumSoundMasking: 0.58,
    minimumVisionRangeMultiplier: 0.93,
  }),
});

export function themeMechanicProfile(theme: CampaignTheme): ThemeMechanicProfile {
  return THEME_MECHANIC_PROFILES[theme];
}

const finiteElapsed = (elapsedSeconds: number) => (
  Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0
);

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Samples one deterministic authored event window. The sine envelope reaches
 * zero cleanly at either edge, so adjacent frame samples cannot pop masking
 * or vision values when an event starts or ends.
 */
export function sampleThemeMechanic(
  theme: CampaignTheme,
  elapsedSeconds: number,
): ThemeMechanicSample {
  const selected = themeMechanicProfile(theme);
  const cyclePosition = finiteElapsed(elapsedSeconds) % selected.cycleSeconds;
  const activeEnd = selected.activeStartSeconds + selected.activeDurationSeconds;
  const active = cyclePosition >= selected.activeStartSeconds && cyclePosition < activeEnd;
  const progress = active
    ? clamp01((cyclePosition - selected.activeStartSeconds) / selected.activeDurationSeconds)
    : 0;
  const envelope = active ? Math.sin(progress * Math.PI) : 0;
  return Object.freeze({
    active,
    progress,
    label: selected.label,
    hudHint: selected.hudHint,
    soundMasking: selected.maximumSoundMasking * envelope,
    visionRangeMultiplier: 1 - (1 - selected.minimumVisionRangeMultiplier) * envelope,
  });
}

const finiteNonNegative = (value: number) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

const mechanicPhaseDuration = (
  definition: MechanicInstanceDefinition,
  phase: Exclude<MechanicPhase, "ready">,
) => {
  switch (phase) {
    case "warning": return definition.warningSeconds;
    case "active": return definition.activeDurationSeconds;
    case "cooldown": return definition.cooldownSeconds;
  }
};

function validateMechanicDefinition(definition: MechanicInstanceDefinition) {
  if (!definition.id.trim()) throw new Error("Mechanic id must not be empty");
  for (const [name, value] of [
    ["interactionRadius", definition.interactionRadius],
    ["warningSeconds", definition.warningSeconds],
    ["activeDurationSeconds", definition.activeDurationSeconds],
    ["effectRadius", definition.effectRadius],
    ["cooldownSeconds", definition.cooldownSeconds],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  }
  if (definition.interactionRadius <= 0 || definition.activeDurationSeconds <= 0 || definition.effectRadius <= 0) {
    throw new Error("Mechanic interaction radius, active duration and effect radius must be greater than zero");
  }
  if (
    !Number.isFinite(definition.maximumSoundMasking)
    || definition.maximumSoundMasking < 0
    || definition.maximumSoundMasking > 1
  ) throw new Error("maximumSoundMasking must be in [0, 1]");
  if (
    !Number.isFinite(definition.minimumVisionRangeMultiplier)
    || definition.minimumVisionRangeMultiplier < 0.5
    || definition.minimumVisionRangeMultiplier > 1
  ) throw new Error("minimumVisionRangeMultiplier must be in [0.5, 1]");
  if (!definition.soundSource.sourceId.trim()) throw new Error("Mechanic sound source id must not be empty");
  for (const [name, value] of [
    ["sound strength", definition.soundSource.strength],
    ["sound confidence", definition.soundSource.confidence],
    ["activation cost", definition.activationCost.amount],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0, 1]`);
  }
  if (!Number.isFinite(definition.soundSource.decayPerSecond) || definition.soundSource.decayPerSecond < 0) {
    throw new Error("sound decay must be finite and non-negative");
  }
}

export function createMechanicInstance(definition: MechanicInstanceDefinition): MechanicInstance {
  validateMechanicDefinition(definition);
  return Object.freeze({
    definition: Object.freeze({
      ...definition,
      position: Object.freeze({ ...definition.position }),
      soundSource: Object.freeze({ ...definition.soundSource }),
      activationCost: Object.freeze({ ...definition.activationCost }),
    }),
    phase: "ready",
    phaseElapsedSeconds: 0,
    activationCount: 0,
    lastActivatedAtSeconds: null,
  });
}

function mechanicDistance(instance: MechanicInstance, position?: Point): number {
  if (!position) return Number.POSITIVE_INFINITY;
  return Math.hypot(
    position.x - instance.definition.position.x,
    position.y - instance.definition.position.y,
  );
}

/**
 * Spatial sample for presentation and simulation input. Effects use a soft
 * radial falloff and a sine time envelope, so neither crossing the area edge
 * nor changing phase produces a full-strength pop.
 */
export function sampleMechanicInstance(
  instance: MechanicInstance,
  actorPosition?: Point,
): MechanicInstanceSample {
  const { definition } = instance;
  const distance = mechanicDistance(instance, actorPosition);
  const canActivate = instance.phase === "ready" && distance <= definition.interactionRadius;
  const inEffectArea = distance <= definition.effectRadius;
  const duration = instance.phase === "ready" ? 0 : mechanicPhaseDuration(definition, instance.phase);
  const progress = instance.phase === "ready"
    ? 0
    : clamp01(instance.phaseElapsedSeconds / Math.max(duration, 1e-6));
  const temporalEnvelope = instance.phase === "active" ? Math.sin(progress * Math.PI) : 0;
  const spatialEnvelope = inEffectArea
    ? 1 - 0.35 * clamp01(distance / Math.max(definition.effectRadius, 1e-6))
    : 0;
  const envelope = temporalEnvelope * spatialEnvelope;
  return Object.freeze({
    phase: instance.phase,
    progress,
    canActivate,
    inEffectArea,
    label: definition.label,
    hudHint: instance.phase === "warning"
      ? definition.warningHint
      : instance.phase === "active"
        ? definition.activeHint
        : instance.phase === "cooldown"
          ? "机关正在复位"
          : canActivate
            ? `启动${definition.label}`
            : definition.label,
    soundMasking: definition.maximumSoundMasking * envelope,
    visionRangeMultiplier: 1 - (1 - definition.minimumVisionRangeMultiplier) * envelope,
  });
}

/**
 * Deterministic placed-mechanic state machine. It accepts only public time,
 * an interaction edge and the activating actor position.
 */
export function stepMechanicInstance(
  source: MechanicInstance,
  input: MechanicInstanceInput,
): MechanicInstanceStep {
  let instance: MechanicInstance = {
    ...source,
    phaseElapsedSeconds: finiteNonNegative(source.phaseElapsedSeconds),
  };
  const events: MechanicInstanceEvent[] = [];
  let emittedSoundStimulus: SoundStimulus | null = null;
  let remaining = finiteNonNegative(input.deltaSeconds);

  if (
    instance.phase === "ready"
    && input.activationRequested
    && mechanicDistance(instance, input.actorPosition) <= instance.definition.interactionRadius
  ) {
    instance = {
      ...instance,
      phase: "warning",
      phaseElapsedSeconds: 0,
      activationCount: instance.activationCount + 1,
    };
    events.push({ type: "warning-started", mechanicId: instance.definition.id });
    events.push({
      type: "activation-cost-applied",
      mechanicId: instance.definition.id,
      cost: instance.definition.activationCost,
    });
  }

  // A bounded loop handles zero-duration warning/cooldown and large fixed
  // steps without skipping the one-shot sound emission.
  for (let transition = 0; transition < 4 && instance.phase !== "ready"; transition += 1) {
    const duration = mechanicPhaseDuration(instance.definition, instance.phase);
    const phaseRemaining = Math.max(0, duration - instance.phaseElapsedSeconds);
    if (remaining + 1e-12 < phaseRemaining) {
      instance = { ...instance, phaseElapsedSeconds: instance.phaseElapsedSeconds + remaining };
      remaining = 0;
      break;
    }
    remaining = Math.max(0, remaining - phaseRemaining);
    if (instance.phase === "warning") {
      const activatedAt = Number.isFinite(input.nowSeconds)
        ? Math.max(0, input.nowSeconds - remaining)
        : 0;
      instance = {
        ...instance,
        phase: "active",
        phaseElapsedSeconds: 0,
        lastActivatedAtSeconds: activatedAt,
      };
      events.push({ type: "activated", mechanicId: instance.definition.id });
      emittedSoundStimulus = Object.freeze({
        position: { ...instance.definition.position },
        strength: instance.definition.soundSource.strength,
        sourceType: instance.definition.soundSource.sourceType,
        sourceId: instance.definition.soundSource.sourceId,
        confidence: instance.definition.soundSource.confidence,
        decayPerSecond: instance.definition.soundSource.decayPerSecond,
      });
    } else if (instance.phase === "active") {
      instance = { ...instance, phase: "cooldown", phaseElapsedSeconds: 0 };
      events.push({ type: "cooldown-started", mechanicId: instance.definition.id });
    } else {
      instance = { ...instance, phase: "ready", phaseElapsedSeconds: 0 };
      events.push({ type: "ready", mechanicId: instance.definition.id });
    }
    if (remaining <= 1e-12 && instance.phase !== "warning") break;
  }

  instance = Object.freeze(instance);
  return Object.freeze({
    instance,
    sample: sampleMechanicInstance(instance, input.actorPosition),
    events: Object.freeze(events),
    emittedSoundStimulus,
  });
}

const DEFAULT_INSTANCE_COSTS: Readonly<Record<CampaignTheme, MechanicActivationCost>> = Object.freeze({
  campus: Object.freeze({ kind: "noise", amount: 0.35, label: "启动提示音会暴露机关位置" }),
  hospital: Object.freeze({ kind: "exposure", amount: 0.3, label: "操作面板时短暂暴露" }),
  "fire-station": Object.freeze({ kind: "time", amount: 0.4, label: "排烟阀需要预热" }),
  factory: Object.freeze({ kind: "noise", amount: 0.55, label: "阀门启动会制造高置信噪声" }),
});

/** Convenience authoring bridge from the legacy periodic theme profile. */
export function createThemeMechanicDefinition(
  theme: CampaignTheme,
  id: string,
  position: Point,
  overrides: Partial<MechanicInstanceDefinition> = {},
): MechanicInstanceDefinition {
  const selected = themeMechanicProfile(theme);
  const base: MechanicInstanceDefinition = {
    id,
    theme,
    kind: selected.kind,
    position: { ...position },
    interactionRadius: 1.15,
    warningSeconds: theme === "fire-station" ? 1.2 : 0.65,
    activeDurationSeconds: selected.activeDurationSeconds,
    effectRadius: theme === "factory" ? 8 : 6,
    cooldownSeconds: Math.max(6, selected.cycleSeconds - selected.activeDurationSeconds),
    label: selected.label,
    warningHint: `${selected.label}即将启动，离开操作点`,
    activeHint: selected.hudHint,
    maximumSoundMasking: selected.maximumSoundMasking,
    minimumVisionRangeMultiplier: selected.minimumVisionRangeMultiplier,
    soundSource: {
      sourceId: `${id}:emitter`,
      sourceType: theme === "fire-station" ? "environment-hazard" : "environment-decoy",
      strength: theme === "factory" ? 1 : 0.82,
      confidence: theme === "hospital" ? 0.62 : 0.78,
      decayPerSecond: 0.12,
    },
    activationCost: DEFAULT_INSTANCE_COSTS[theme],
  };
  return {
    ...base,
    ...overrides,
    position: { ...(overrides.position ?? base.position) },
    soundSource: { ...base.soundSource, ...(overrides.soundSource ?? {}) },
    activationCost: { ...base.activationCost, ...(overrides.activationCost ?? {}) },
  };
}
