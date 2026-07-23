import type { CampaignTheme } from "./campaign.ts";
import type { PerceptionEvidence, Point } from "./contracts.ts";
import type { LegalHideCandidate } from "./hide-archetypes.ts";
import { findPath, neighbors, normalizeVector, pointKey } from "./navigation.ts";
import type { LevelDefinition } from "./contracts.ts";

export type ChaserArchetypeKind =
  | "campus-patroller"
  | "hospital-inspector"
  | "fire-sound-tracker"
  | "factory-interceptor";

export type ChaserArchetypeRule =
  | "scan-public-junction"
  | "inspect-public-hide-clue"
  | "focus-perceived-sound"
  | "intercept-public-exit-route";

export interface ChaserArchetypeProfile {
  readonly theme: CampaignTheme;
  readonly kind: ChaserArchetypeKind;
  /** Exactly one new rule per archetype. */
  readonly rule: ChaserArchetypeRule;
  readonly label: string;
  readonly readableRule: string;
  readonly warningSeconds: number;
  readonly cueLabel: string;
  readonly cueAudioToken: string;
  readonly cueAnimationToken: string;
}

export type ChaserArchetypeStimulus =
  | {
      readonly kind: "patrol-arrival";
      /** Public event identity; the same arrival cannot retrigger every tick. */
      readonly id: string;
      readonly position: Point;
    }
  | {
      readonly kind: "perception";
      /** Public perception event identity. */
      readonly id: string;
      readonly evidence: Exclude<PerceptionEvidence, { kind: "none" }>;
    };

export type ChaserArchetypeAction =
  | {
      readonly type: "scan-public-junction";
      readonly origin: Point;
      readonly branchHeadings: readonly Point[];
    }
  | {
      readonly type: "inspect-public-hide-clue";
      readonly hideSpotId: string;
      readonly approach: Point;
      readonly exact: boolean;
    }
  | {
      readonly type: "focus-perceived-sound";
      readonly evidence: Extract<PerceptionEvidence, { kind: "sound" }>;
    }
  | {
      readonly type: "intercept-public-exit-route";
      readonly lastSeenPosition: Point;
      readonly interceptTarget: Point;
    };

export interface ChaserArchetypeState {
  readonly phase: "idle" | "telegraph";
  readonly telegraphElapsedSeconds: number;
  readonly pendingAction: ChaserArchetypeAction | null;
  readonly lastTriggerId: string | null;
}

export type ChaserArchetypeEvent =
  | {
      readonly type: "telegraph-started";
      readonly archetype: ChaserArchetypeKind;
      readonly triggerId: string;
      readonly warningSeconds: number;
      readonly cueLabel: string;
      readonly cueAudioToken: string;
      readonly cueAnimationToken: string;
    }
  | {
      readonly type: "action-ready";
      readonly archetype: ChaserArchetypeKind;
      readonly triggerId: string;
      readonly action: ChaserArchetypeAction;
    };

export interface ChaserArchetypeInput {
  readonly deltaSeconds: number;
  readonly level: LevelDefinition;
  readonly stimulus?: ChaserArchetypeStimulus | null;
  /**
   * Must come directly from queryLegalHideCandidates(). It contains no
   * occupancy, concealed point or traversal exit choice.
   */
  readonly legalHideCandidates?: readonly LegalHideCandidate[];
}

export interface ChaserArchetypeStep {
  readonly state: ChaserArchetypeState;
  readonly events: readonly ChaserArchetypeEvent[];
  /** Non-null only after the complete readable warning duration. */
  readonly action: ChaserArchetypeAction | null;
  readonly cueProgress: number;
}

const archetype = (value: ChaserArchetypeProfile): ChaserArchetypeProfile => {
  if (!Number.isFinite(value.warningSeconds) || value.warningSeconds < 0.5) {
    throw new Error(`${value.kind} warning must be at least 0.5 seconds`);
  }
  return Object.freeze({ ...value });
};

export const CHASER_ARCHETYPE_PROFILES: Readonly<Record<CampaignTheme, ChaserArchetypeProfile>> = Object.freeze({
  campus: archetype({
    theme: "campus",
    kind: "campus-patroller",
    rule: "scan-public-junction",
    label: "校园巡视者",
    readableRule: "抵达公开巡逻岔路后先用手电逐支路扫视，再继续巡逻。",
    warningSeconds: 0.55,
    cueLabel: "巡视者举起手电，准备扫视岔路",
    cueAudioToken: "campus-flashlight-click",
    cueAnimationToken: "PatrolRaiseFlashlight",
  }),
  hospital: archetype({
    theme: "hospital",
    kind: "hospital-inspector",
    rule: "inspect-public-hide-clue",
    label: "医院检查者",
    readableRule: "看到进柜或听到藏具动静后，会预告并检查公开证据附近最合理的藏点。",
    warningSeconds: 0.65,
    cueLabel: "检查者戴上手套，准备检查藏点",
    cueAudioToken: "hospital-glove-snap",
    cueAnimationToken: "InspectorPrepare",
  }),
  "fire-station": archetype({
    theme: "fire-station",
    kind: "fire-sound-tracker",
    rule: "focus-perceived-sound",
    label: "消防听觉追踪者",
    readableRule: "听到足够明确的公开声音后会停步侧耳，再提高这条已感知声音的追踪优先级。",
    warningSeconds: 0.55,
    cueLabel: "追踪者侧身倾听，声音即将被锁定",
    cueAudioToken: "fire-breath-hold",
    cueAnimationToken: "ListenFocus",
  }),
  factory: archetype({
    theme: "factory",
    kind: "factory-interceptor",
    rule: "intercept-public-exit-route",
    label: "工厂截路者",
    readableRule: "目击玩家后会亮起路径指示并尝试截住最后目击点通往公开出口的前方节点。",
    warningSeconds: 0.6,
    cueLabel: "截路者看向出口，准备切入前方通道",
    cueAudioToken: "factory-route-relay",
    cueAnimationToken: "InterceptorPoint",
  }),
});

export const CHASER_ARCHETYPE_FAIRNESS_CONTRACT = Object.freeze({
  warningMinimumSeconds: 0.5,
  allowedInputs: Object.freeze([
    "public-level-geometry",
    "public-patrol-arrival",
    "perception-evidence",
    "legal-hide-candidates",
  ] as const),
  forbiddenInputs: Object.freeze([
    "player-state",
    "hidden-player-position",
    "hide-occupancy",
    "chosen-traversal-exit",
  ] as const),
});

export function chaserArchetypeProfile(theme: CampaignTheme): ChaserArchetypeProfile {
  return CHASER_ARCHETYPE_PROFILES[theme];
}

/**
 * Explicit opt-in keeps the current campaign AI byte-for-byte unchanged until
 * a level is certified for its themed behavior.
 */
export function enabledChaserArchetype(
  theme: CampaignTheme,
  enabled = false,
): ChaserArchetypeProfile | null {
  return enabled ? chaserArchetypeProfile(theme) : null;
}

export function createInitialChaserArchetypeState(): ChaserArchetypeState {
  return Object.freeze({
    phase: "idle",
    telegraphElapsedSeconds: 0,
    pendingAction: null,
    lastTriggerId: null,
  });
}

function perceptionTriggerKey(stimulus: ChaserArchetypeStimulus): string {
  return `${stimulus.kind}:${stimulus.id}`;
}

function campusAction(
  level: LevelDefinition,
  stimulus: ChaserArchetypeStimulus,
): ChaserArchetypeAction | null {
  if (stimulus.kind !== "patrol-arrival") return null;
  const branches = neighbors(level, stimulus.position);
  if (branches.length < 3) return null;
  return Object.freeze({
    type: "scan-public-junction",
    origin: Object.freeze({ ...stimulus.position }),
    branchHeadings: Object.freeze(branches.map((branch) => Object.freeze(normalizeVector({
      x: branch.x - stimulus.position.x,
      y: branch.y - stimulus.position.y,
    })))),
  });
}

function hospitalAction(
  stimulus: ChaserArchetypeStimulus,
  legalHideCandidates: readonly LegalHideCandidate[],
): ChaserArchetypeAction | null {
  if (stimulus.kind !== "perception") return null;
  const evidence = stimulus.evidence;
  const legalTrigger = evidence.kind === "hide-entry-visible"
    || (evidence.kind === "sound" && evidence.sourceType === "hide-interaction");
  if (!legalTrigger) return null;
  const candidate = legalHideCandidates[0];
  if (!candidate) return null;
  return Object.freeze({
    type: "inspect-public-hide-clue",
    hideSpotId: candidate.hideSpotId,
    approach: Object.freeze({ ...candidate.approach }),
    exact: candidate.exact,
  });
}

function fireAction(
  stimulus: ChaserArchetypeStimulus,
): ChaserArchetypeAction | null {
  if (stimulus.kind !== "perception" || stimulus.evidence.kind !== "sound") return null;
  const evidence = stimulus.evidence;
  const confidence = Math.min(1, Math.max(0, evidence.confidence ?? evidence.strength));
  if (evidence.strength < 0.3 || confidence < 0.35) return null;
  return Object.freeze({
    type: "focus-perceived-sound",
    evidence: Object.freeze({
      ...evidence,
      position: Object.freeze({ ...evidence.position }),
      // Focus improves priority only for the already perceived, uncertain
      // point. It never replaces that point with the real sound source.
      confidence: Math.min(1, confidence * 1.18),
    }),
  });
}

function factoryAction(
  level: LevelDefinition,
  stimulus: ChaserArchetypeStimulus,
): ChaserArchetypeAction | null {
  if (stimulus.kind !== "perception" || stimulus.evidence.kind !== "player-visible") return null;
  const lastSeenPosition = stimulus.evidence.position;
  const route = findPath(level, lastSeenPosition, level.exit);
  if (route.length < 2) return null;
  const forward = route.slice(1, Math.min(route.length, 7));
  const target = forward.find((point, index) => (
    index >= 1 && neighbors(level, point).length >= 3
  )) ?? forward[Math.min(3, forward.length - 1)];
  return Object.freeze({
    type: "intercept-public-exit-route",
    lastSeenPosition: Object.freeze({ ...lastSeenPosition }),
    interceptTarget: Object.freeze({ ...target }),
  });
}

function actionFor(
  profile: ChaserArchetypeProfile,
  input: ChaserArchetypeInput,
): ChaserArchetypeAction | null {
  const stimulus = input.stimulus;
  if (!stimulus || !stimulus.id.trim()) return null;
  switch (profile.rule) {
    case "scan-public-junction":
      return campusAction(input.level, stimulus);
    case "inspect-public-hide-clue":
      return hospitalAction(stimulus, input.legalHideCandidates ?? []);
    case "focus-perceived-sound":
      return fireAction(stimulus);
    case "intercept-public-exit-route":
      return factoryAction(input.level, stimulus);
  }
}

function frozenState(
  phase: ChaserArchetypeState["phase"],
  elapsed: number,
  pendingAction: ChaserArchetypeAction | null,
  lastTriggerId: string | null,
): ChaserArchetypeState {
  return Object.freeze({
    phase,
    telegraphElapsedSeconds: elapsed,
    pendingAction,
    lastTriggerId,
  });
}

export function stepChaserArchetype(
  profile: ChaserArchetypeProfile | null,
  state: ChaserArchetypeState,
  input: ChaserArchetypeInput,
): ChaserArchetypeStep {
  if (!Number.isFinite(input.deltaSeconds) || input.deltaSeconds < 0) {
    throw new Error("Archetype delta must be a finite non-negative number");
  }
  if (!profile) {
    return Object.freeze({
      state,
      events: Object.freeze([]),
      action: null,
      cueProgress: 0,
    });
  }
  const events: ChaserArchetypeEvent[] = [];
  let action: ChaserArchetypeAction | null = null;

  if (state.phase === "telegraph" && state.pendingAction) {
    const elapsed = state.telegraphElapsedSeconds + input.deltaSeconds;
    if (elapsed + 1e-9 >= profile.warningSeconds) {
      action = state.pendingAction;
      const triggerId = state.lastTriggerId ?? "public-trigger";
      events.push({
        type: "action-ready",
        archetype: profile.kind,
        triggerId,
        action,
      });
      state = frozenState("idle", 0, null, state.lastTriggerId);
    } else {
      state = frozenState("telegraph", elapsed, state.pendingAction, state.lastTriggerId);
    }
  } else if (input.stimulus) {
    const triggerId = perceptionTriggerKey(input.stimulus);
    if (triggerId !== state.lastTriggerId) {
      const pendingAction = actionFor(profile, input);
      if (pendingAction) {
        state = frozenState("telegraph", 0, pendingAction, triggerId);
        events.push({
          type: "telegraph-started",
          archetype: profile.kind,
          triggerId,
          warningSeconds: profile.warningSeconds,
          cueLabel: profile.cueLabel,
          cueAudioToken: profile.cueAudioToken,
          cueAnimationToken: profile.cueAnimationToken,
        });
      }
    }
  }

  const cueProgress = state.phase === "telegraph"
    ? Math.min(1, state.telegraphElapsedSeconds / profile.warningSeconds)
    : 0;
  return Object.freeze({
    state,
    events: Object.freeze(events),
    action,
    cueProgress,
  });
}

export function chaserArchetypePublicFingerprint(
  profile: ChaserArchetypeProfile,
  stimulus: ChaserArchetypeStimulus,
): string {
  const evidence = stimulus.kind === "perception"
    ? `${stimulus.evidence.kind}:${pointKey(stimulus.evidence.position)}:${stimulus.evidence.observedAtSeconds.toFixed(3)}`
    : `patrol:${pointKey(stimulus.position)}`;
  return `${profile.kind}:${profile.rule}:${stimulus.id}:${evidence}`;
}
