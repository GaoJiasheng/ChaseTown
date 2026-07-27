import type {
  CaptureReason,
  Point,
  PublicEvidenceMemory,
  SimulationEvent,
} from "./contracts.ts";
import { failureFeedback } from "./failure-feedback.ts";

export const FAILURE_CAUSAL_REPLAY_DEFAULT_WINDOW_SECONDS = 10;
export const FAILURE_CAUSAL_REPLAY_MIN_WINDOW_SECONDS = 8;
export const FAILURE_CAUSAL_REPLAY_MAX_WINDOW_SECONDS = 12;
export const FAILURE_CAUSAL_REPLAY_MAX_TIMELINE_ENTRIES = 6;
export const FAILURE_CAUSAL_REPLAY_MAX_TRACK_SAMPLES = 48;

export type FailureReplayIconToken =
  | "capture"
  | "eye"
  | "footsteps"
  | "hide"
  | "door"
  | "peek"
  | "search"
  | "alert"
  | "decoy"
  | "mechanic"
  | "route"
  | "action"
  | "advice";

export type FailureTimelineKind =
  | "player-action"
  | "public-evidence"
  | "threat-feedback"
  | "hide-check"
  | "capture";

/**
 * A SimulationEvent plus its public run-clock time. The wrapper adds ordering
 * metadata only; it must not carry a GameState, chaser target, or occupancy
 * snapshot.
 */
export interface TimedPublicSimulationEvent {
  readonly atSeconds: number;
  readonly event: Readonly<SimulationEvent>;
}

export type FailurePlayerActionKind =
  | "move"
  | "sprint"
  | "sneak"
  | "hide-enter"
  | "hide-exit"
  | "peek"
  | "interact"
  | "decoy-deploy"
  | "theme-mechanic"
  | "route-replan";

/**
 * Player-owned semantic input. Optional positions are the player's own
 * trajectory samples and are never combined with a pursuer position.
 */
export interface FailurePlayerAction {
  readonly atSeconds: number;
  readonly action: FailurePlayerActionKind;
  readonly position?: Point;
}

export interface FailureCausalReplayInput {
  readonly capturedAtSeconds: number;
  readonly publicEvents: readonly TimedPublicSimulationEvent[];
  readonly publicEvidence?: readonly Readonly<PublicEvidenceMemory>[];
  readonly playerActions?: readonly FailurePlayerAction[];
  /**
   * Compatibility bridge for runs saved before player-captured events were
   * retained. Unknown strings are deliberately collapsed to direct-contact.
   */
  readonly legacyCaptureReason?: CaptureReason | string | null;
  /** Requested lookback, clamped to the product contract's eight–twelve seconds. */
  readonly windowSeconds?: number;
  readonly includeSemanticTrack?: boolean;
}

export interface FailureTimelineEntry {
  readonly id: string;
  readonly kind: FailureTimelineKind;
  readonly atSeconds: number;
  readonly secondsBeforeCapture: number;
  readonly label: string;
  readonly detail: string;
  readonly iconToken: FailureReplayIconToken;
}

export interface FailurePrimaryCause {
  readonly code: CaptureReason;
  readonly label: string;
  readonly detail: string;
  readonly iconToken: FailureReplayIconToken;
}

export interface FailureActionableAdvice {
  readonly label: "下次这样做";
  readonly detail: string;
  readonly iconToken: "advice";
}

export interface FailureSemanticTrackSample {
  readonly atSeconds: number;
  readonly secondsBeforeCapture: number;
  readonly position: Readonly<Point>;
  readonly action: FailurePlayerActionKind;
  readonly iconToken: FailureReplayIconToken;
}

export interface FailureSemanticTrackSlice {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly samples: readonly FailureSemanticTrackSample[];
}

export interface FailureCausalReplay {
  readonly captureReason: CaptureReason;
  readonly window: Readonly<{
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
  }>;
  readonly timeline: readonly FailureTimelineEntry[];
  readonly primaryCause: FailurePrimaryCause;
  readonly advice: FailureActionableAdvice;
  readonly semanticTrack?: FailureSemanticTrackSlice;
}

interface TimelineCandidate {
  readonly kind: FailureTimelineKind;
  readonly atSeconds: number;
  readonly label: string;
  readonly detail: string;
  readonly iconToken: FailureReplayIconToken;
  readonly dedupeGroup: string;
  readonly priority: number;
}

const CAPTURE_REASONS: readonly CaptureReason[] = Object.freeze([
  "direct-contact",
  "exposed-hide-entry",
  "unsafe-hide-exit",
  "witnessed-hide-check",
  "search-hide-check",
]);

const CAPTURE_REASON_SET = new Set<string>(CAPTURE_REASONS);

const LEGACY_CAPTURE_REASON_ALIASES: Readonly<Record<string, CaptureReason>> = Object.freeze({
  caught: "direct-contact",
  contact: "direct-contact",
  "caught-in-open": "direct-contact",
  "exposed-entry": "exposed-hide-entry",
  "hide-entry-visible": "exposed-hide-entry",
  "unsafe-exit": "unsafe-hide-exit",
  "locker-witnessed": "witnessed-hide-check",
  "witnessed-locker-check": "witnessed-hide-check",
  "locker-search": "search-hide-check",
  "search-check": "search-hide-check",
});

const CAPTURE_ICON: Readonly<Record<CaptureReason, FailureReplayIconToken>> = Object.freeze({
  "direct-contact": "capture",
  "exposed-hide-entry": "eye",
  "unsafe-hide-exit": "door",
  "witnessed-hide-check": "hide",
  "search-hide-check": "search",
});

const roundMillis = (value: number) => Math.round(value * 1_000) / 1_000;

const finiteTime = (value: number) => Number.isFinite(value) && value >= 0;

const inWindow = (value: number, start: number, end: number) => (
  finiteTime(value) && value + 1e-9 >= start && value <= end + 1e-9
);

function normalizeCaptureReason(value: unknown): CaptureReason | null {
  if (typeof value !== "string") return null;
  if (CAPTURE_REASON_SET.has(value)) return value as CaptureReason;
  return LEGACY_CAPTURE_REASON_ALIASES[value] ?? null;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableStringOrdering(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function actionPresentation(action: FailurePlayerActionKind): Readonly<{
  label: string;
  detail: string;
  iconToken: FailureReplayIconToken;
  priority: number;
}> {
  switch (action) {
    case "move":
      return { label: "你继续移动", detail: "移动轨迹进入了这段失败复盘。", iconToken: "action", priority: 18 };
    case "sprint":
      return { label: "你快速奔跑", detail: "高速移动更容易留下连续脚步与直线路径。", iconToken: "footsteps", priority: 46 };
    case "sneak":
      return { label: "你放慢脚步", detail: "轻步移动降低了当时的声音风险。", iconToken: "footsteps", priority: 25 };
    case "hide-enter":
      return { label: "你尝试进入藏点", detail: "进藏点动作会在完成遮蔽前保留暴露窗口。", iconToken: "hide", priority: 58 };
    case "hide-exit":
      return { label: "你选择离开藏点", detail: "离开动作重新打开了视觉与接触风险。", iconToken: "door", priority: 62 };
    case "peek":
      return { label: "你从藏点窥视", detail: "窥视短暂恢复观察，也可能重新暴露身影。", iconToken: "peek", priority: 52 };
    case "interact":
      return { label: "你执行场景交互", detail: "这次公开交互进入了失败前的行动记录。", iconToken: "action", priority: 22 };
    case "decoy-deploy":
      return { label: "你部署了诱饵", detail: "诱饵制造了可被调查的公开声源。", iconToken: "decoy", priority: 34 };
    case "theme-mechanic":
      return { label: "你启用了场景机关", detail: "机关改变了当时可公开观察的环境状态。", iconToken: "mechanic", priority: 32 };
    case "route-replan":
      return { label: "你改变了行动路线", detail: "路线调整发生在失败前的因果窗口内。", iconToken: "route", priority: 30 };
  }
}

function playerModeCandidate(
  sample: TimedPublicSimulationEvent,
): TimelineCandidate | null {
  if (sample.event.type !== "player-mode-changed") return null;
  const common = {
    kind: "player-action" as const,
    atSeconds: sample.atSeconds,
  };
  switch (sample.event.to) {
    case "aligning-hide":
    case "entering-hide":
      return {
        ...common,
        label: "你开始进入藏点",
        detail: "角色尚未完成遮蔽，进入动作仍可能被看见。",
        iconToken: "hide",
        dedupeGroup: "hide-enter",
        priority: sample.event.to === "entering-hide" ? 64 : 55,
      };
    case "hidden":
      if (sample.event.from === "exiting-peek") {
        return {
          ...common,
          label: "你结束窥视",
          detail: "藏点重新回到关闭状态。",
          iconToken: "peek",
          dedupeGroup: "peek-close",
          priority: 28,
        };
      }
      return {
        ...common,
        label: "你完成隐藏",
        detail: "角色完成了这次藏点进入动作。",
        iconToken: "hide",
        dedupeGroup: "hide-commit",
        priority: 38,
      };
    case "entering-peek":
    case "peeking":
      return {
        ...common,
        label: "你从藏点窥视",
        detail: "窥视恢复观察的同时，也重新打开了暴露窗口。",
        iconToken: "peek",
        dedupeGroup: "peek",
        priority: sample.event.to === "peeking" ? 55 : 48,
      };
    case "exiting-hide":
      return {
        ...common,
        label: "你打开藏点离开",
        detail: "离开动作重新产生视觉与接触风险。",
        iconToken: "door",
        dedupeGroup: "hide-exit",
        priority: 68,
      };
    case "free":
      if (sample.event.from !== "exiting-hide") return null;
      return {
        ...common,
        label: "你回到公开区域",
        detail: "角色完成离开并恢复常规移动。",
        iconToken: "door",
        dedupeGroup: "hide-exit-complete",
        priority: 30,
      };
    case "caught":
    case "escaped":
    case "exiting-peek":
      return null;
  }
}

function investigationPresentation(
  sourceType: Extract<SimulationEvent, { type: "evidence-investigation-completed" }>["sourceType"],
): Readonly<{ label: string; detail: string; iconToken: FailureReplayIconToken }> {
  switch (sourceType) {
    case "player-movement":
      return { label: "脚步声被调查", detail: "公开移动声把调查引向了你经过的区域。", iconToken: "footsteps" };
    case "hide-interaction":
      return { label: "藏点动静被调查", detail: "进出或窥视产生的公开声音引发了调查。", iconToken: "door" };
    case "footprint":
      return { label: "脚印被调查", detail: "地面上的公开痕迹推动了后续搜索。", iconToken: "footsteps" };
    case "door-disturbance":
      return { label: "门体扰动被调查", detail: "可见的门体变化推动了后续搜索。", iconToken: "door" };
    case "disturbed-prop":
      return { label: "场景扰动被调查", detail: "可见物件变化成为了公开调查线索。", iconToken: "search" };
    case "environment-decoy":
      return { label: "诱饵声源被调查", detail: "追捕者完成了对公开诱饵声源的调查。", iconToken: "decoy" };
    case "environment-hazard":
    case "infrastructure-anomaly":
      return { label: "环境异常被调查", detail: "公开环境变化吸引了调查。", iconToken: "mechanic" };
    case "ambient":
    case "unknown":
      return { label: "公开声源被调查", detail: "一个可听见的公开声源进入了调查。", iconToken: "search" };
  }
}

function simulationEventCandidate(
  sample: TimedPublicSimulationEvent,
): TimelineCandidate | null {
  const playerMode = playerModeCandidate(sample);
  if (playerMode) return playerMode;
  const { event } = sample;
  switch (event.type) {
    case "chaser-mode-changed":
      switch (event.to) {
        case "suspicious":
          return {
            kind: "threat-feedback",
            atSeconds: sample.atSeconds,
            label: "追捕者产生警觉",
            detail: "公开反馈显示附近动静已经引起注意。",
            iconToken: "alert",
            dedupeGroup: "threat-alert",
            priority: 50,
          };
        case "chase":
          return {
            kind: "threat-feedback",
            atSeconds: sample.atSeconds,
            label: "追逐压力重新升高",
            detail: "公开警觉反馈进入了直接追逐阶段。",
            iconToken: "alert",
            dedupeGroup: "threat-chase",
            priority: 72,
          };
        case "lost-sight":
          return {
            kind: "threat-feedback",
            atSeconds: sample.atSeconds,
            label: "你暂时切断视线",
            detail: "追捕者失去持续视觉，但仍会调查最后公开线索。",
            iconToken: "eye",
            dedupeGroup: "threat-lost-sight",
            priority: 35,
          };
        case "go-to-last-known":
        case "scan-last-known":
        case "search":
          return {
            kind: "threat-feedback",
            atSeconds: sample.atSeconds,
            label: "追捕者继续搜索",
            detail: "调查仍围绕已经公开的证据展开。",
            iconToken: "search",
            dedupeGroup: "threat-search",
            priority: 45,
          };
        case "check-hide":
          return {
            kind: "threat-feedback",
            atSeconds: sample.atSeconds,
            label: "藏点进入检查阶段",
            detail: "追捕者开始执行一次可观察的藏点检查。",
            iconToken: "hide",
            dedupeGroup: "threat-hide-check",
            priority: 76,
          };
        case "spawn-delay":
        case "patrol":
          return null;
      }
    case "evidence-investigation-completed": {
      const presentation = investigationPresentation(event.sourceType);
      return {
        kind: "public-evidence",
        atSeconds: sample.atSeconds,
        ...presentation,
        dedupeGroup: `investigation:${event.sourceType}`,
        priority: 56,
      };
    }
    case "hide-check-completed":
      return {
        kind: "hide-check",
        atSeconds: sample.atSeconds,
        label: "一次藏点检查完成",
        detail: "可观察的检查动作表明该区域已经进入高风险搜索。",
        iconToken: "hide",
        dedupeGroup: "hide-check-completed",
        priority: 66,
      };
    case "player-captured":
    case "phase-changed":
    case "player-mode-changed":
    case "chaser-archetype-telegraph-started":
    case "chaser-archetype-action-started":
    case "chaser-archetype-action-finished":
      // Capture is synthesized from the normalized reason below. Authored cue
      // labels and action tokens are intentionally ignored because a future
      // profile could place hidden target information in those strings.
      return null;
  }
}

function evidencePresentation(
  evidence: Readonly<PublicEvidenceMemory>,
): Readonly<{
  label: string;
  detail: string;
  iconToken: FailureReplayIconToken;
  dedupeGroup: string;
  priority: number;
}> {
  switch (evidence.kind) {
    case "visual":
      return {
        label: "你的身影成为视觉证据",
        detail: "追捕者获得了一个当时可见的位置样本。",
        iconToken: "eye",
        dedupeGroup: "evidence-visual",
        priority: 74,
      };
    case "hide-entry-visible":
      return {
        label: "进入藏点的动作被看见",
        detail: "这次目击足以让追捕者检查对应的公开藏点。",
        iconToken: "hide",
        dedupeGroup: "evidence-hide-entry",
        priority: 88,
      };
    case "sound":
      switch (evidence.sourceType) {
        case "player-movement":
          return {
            label: "移动声形成公开线索",
            detail: "脚步声给出了一个带误差的调查区域。",
            iconToken: "footsteps",
            dedupeGroup: "evidence-movement-sound",
            priority: 58,
          };
        case "hide-interaction":
          return {
            label: "藏点动静形成公开线索",
            detail: "进出或窥视声音给出了一个带误差的调查区域。",
            iconToken: "door",
            dedupeGroup: "evidence-hide-sound",
            priority: 64,
          };
        case "environment-decoy":
          return {
            label: "诱饵制造公开声源",
            detail: "诱饵给出了一个可被调查、但不保证真实的区域。",
            iconToken: "decoy",
            dedupeGroup: "evidence-decoy-sound",
            priority: 38,
          };
        case "environment-hazard":
        case "ambient":
        case "unknown":
        case "player":
        case "footprint":
        case "disturbed-prop":
        case "door-disturbance":
        case "infrastructure-anomaly":
          return {
            label: "公开声源进入调查",
            detail: "可听见的环境声给出了一个带误差的区域。",
            iconToken: "search",
            dedupeGroup: "evidence-public-sound",
            priority: 42,
          };
      }
    case "world-clue":
      switch (evidence.sourceType) {
        case "footprint":
          return {
            label: "脚印形成公开线索",
            detail: "地面痕迹指向了你经过的区域。",
            iconToken: "footsteps",
            dedupeGroup: "evidence-footprint",
            priority: 62,
          };
        case "door-disturbance":
          return {
            label: "门体留下公开扰动",
            detail: "可见的门体状态变化提高了附近的搜索风险。",
            iconToken: "door",
            dedupeGroup: "evidence-door",
            priority: 64,
          };
        case "disturbed-prop":
          return {
            label: "物件留下公开扰动",
            detail: "可见的物件变化提高了附近的搜索风险。",
            iconToken: "search",
            dedupeGroup: "evidence-prop",
            priority: 60,
          };
        case "infrastructure-anomaly":
          return {
            label: "设施异常形成公开线索",
            detail: "公开设施状态变化吸引了调查。",
            iconToken: "mechanic",
            dedupeGroup: "evidence-infrastructure",
            priority: 45,
          };
        case "player-movement":
        case "hide-interaction":
        case "environment-decoy":
        case "environment-hazard":
        case "ambient":
        case "unknown":
        case "player":
          return {
            label: "场景痕迹形成公开线索",
            detail: "一个可见的场景变化吸引了调查。",
            iconToken: "search",
            dedupeGroup: "evidence-world",
            priority: 50,
          };
      }
  }
}

function playerActionCandidate(action: FailurePlayerAction): TimelineCandidate {
  const presentation = actionPresentation(action.action);
  const dedupeGroup =
    action.action === "hide-enter"
      ? "hide-enter"
      : action.action === "hide-exit"
        ? "hide-exit"
        : action.action === "peek"
          ? "peek"
          : `player-action:${action.action}`;

  return {
    kind: "player-action",
    atSeconds: action.atSeconds,
    ...presentation,
    dedupeGroup,
  };
}

function candidateOrdering(left: TimelineCandidate, right: TimelineCandidate): number {
  return left.atSeconds - right.atSeconds
    || right.priority - left.priority
    || stableStringOrdering(left.kind, right.kind)
    || stableStringOrdering(left.label, right.label)
    || stableStringOrdering(left.detail, right.detail);
}

function betterCandidate(left: TimelineCandidate, right: TimelineCandidate): TimelineCandidate {
  if (left.priority !== right.priority) return left.priority > right.priority ? left : right;
  if (left.atSeconds !== right.atSeconds) return left.atSeconds > right.atSeconds ? left : right;
  return candidateOrdering(left, right) <= 0 ? left : right;
}

function dedupeCandidates(candidates: readonly TimelineCandidate[]): readonly TimelineCandidate[] {
  const exact = new Map<string, TimelineCandidate>();
  for (const candidate of candidates) {
    const fingerprint = [
      candidate.dedupeGroup,
      roundMillis(candidate.atSeconds).toFixed(3),
      candidate.kind,
      candidate.label,
      candidate.detail,
      candidate.iconToken,
    ].join("|");
    const previous = exact.get(fingerprint);
    exact.set(fingerprint, previous ? betterCandidate(previous, candidate) : candidate);
  }

  const ordered = [...exact.values()].sort(candidateOrdering);
  const clusters = new Map<string, TimelineCandidate>();
  const clusterLastTime = new Map<string, number>();
  const retained: TimelineCandidate[] = [];
  for (const candidate of ordered) {
    const previous = clusters.get(candidate.dedupeGroup);
    const previousTime = clusterLastTime.get(candidate.dedupeGroup);
    if (
      previous
      && previousTime !== undefined
      && candidate.atSeconds - previousTime <= 0.65 + 1e-9
    ) {
      const replacement = betterCandidate(previous, candidate);
      const index = retained.indexOf(previous);
      if (index >= 0) retained[index] = replacement;
      clusters.set(candidate.dedupeGroup, replacement);
      clusterLastTime.set(candidate.dedupeGroup, candidate.atSeconds);
      continue;
    }
    retained.push(candidate);
    clusters.set(candidate.dedupeGroup, candidate);
    clusterLastTime.set(candidate.dedupeGroup, candidate.atSeconds);
  }
  return Object.freeze(retained.sort(candidateOrdering));
}

function latestCaptureReasonFromEvents(
  samples: readonly TimedPublicSimulationEvent[],
  capturedAtSeconds: number,
): CaptureReason | null {
  const candidates = samples
    .filter((sample) => (
      finiteTime(sample.atSeconds)
      && sample.atSeconds <= capturedAtSeconds + 1e-9
      && sample.event.type === "player-captured"
    ))
    .map((sample) => ({
      atSeconds: sample.atSeconds,
      reason: normalizeCaptureReason(
        (sample.event as Extract<SimulationEvent, { type: "player-captured" }>).reason,
      ),
    }))
    .filter((sample): sample is { atSeconds: number; reason: CaptureReason } => (
      sample.reason !== null
    ))
    .sort((left, right) => (
      right.atSeconds - left.atSeconds
      || CAPTURE_REASONS.indexOf(left.reason) - CAPTURE_REASONS.indexOf(right.reason)
    ));
  return candidates[0]?.reason ?? null;
}

function inferCaptureReason(
  input: FailureCausalReplayInput,
  startSeconds: number,
): CaptureReason {
  const completedHideCheck = input.publicEvents.some((sample) => (
    inWindow(sample.atSeconds, startSeconds, input.capturedAtSeconds)
    && sample.event.type === "hide-check-completed"
  ));
  const witnessedEntry = (input.publicEvidence ?? []).some((entry) => (
    inWindow(entry.observedAtSeconds, startSeconds, input.capturedAtSeconds)
    && entry.kind === "hide-entry-visible"
  ));
  if (completedHideCheck) {
    return witnessedEntry ? "witnessed-hide-check" : "search-hide-check";
  }
  const exitedHide = input.publicEvents.some((sample) => (
    inWindow(sample.atSeconds, startSeconds, input.capturedAtSeconds)
    && sample.event.type === "player-mode-changed"
    && sample.event.to === "exiting-hide"
  )) || (input.playerActions ?? []).some((action) => (
    inWindow(action.atSeconds, startSeconds, input.capturedAtSeconds)
    && action.action === "hide-exit"
  ));
  if (exitedHide) return "unsafe-hide-exit";
  if (witnessedEntry) return "exposed-hide-entry";
  return "direct-contact";
}

function resolvedCaptureReason(
  input: FailureCausalReplayInput,
  startSeconds: number,
): CaptureReason {
  return latestCaptureReasonFromEvents(input.publicEvents, input.capturedAtSeconds)
    ?? normalizeCaptureReason(input.legacyCaptureReason)
    ?? inferCaptureReason(input, startSeconds);
}

function selectedTimeline(
  candidates: readonly TimelineCandidate[],
  capturedAtSeconds: number,
): readonly FailureTimelineEntry[] {
  const selected = [...dedupeCandidates(candidates)]
    .sort((left, right) => (
      right.priority - left.priority
      || right.atSeconds - left.atSeconds
      || candidateOrdering(left, right)
    ))
    .slice(0, FAILURE_CAUSAL_REPLAY_MAX_TIMELINE_ENTRIES)
    .sort((left, right) => (
      left.atSeconds - right.atSeconds
      || (left.kind === "capture" ? 1 : 0) - (right.kind === "capture" ? 1 : 0)
      || candidateOrdering(left, right)
    ));
  return Object.freeze(selected.map((candidate) => {
    const atSeconds = roundMillis(candidate.atSeconds);
    const id = `failure-${stableHash([
      candidate.kind,
      atSeconds.toFixed(3),
      candidate.label,
      candidate.iconToken,
    ].join("|"))}`;
    return Object.freeze({
      id,
      kind: candidate.kind,
      atSeconds,
      secondsBeforeCapture: roundMillis(Math.max(0, capturedAtSeconds - candidate.atSeconds)),
      label: candidate.label,
      detail: candidate.detail,
      iconToken: candidate.iconToken,
    });
  }));
}

function validPlayerPosition(position: Point | undefined): position is Point {
  return Boolean(
    position
    && Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Math.abs(position.x) <= 1_000_000
    && Math.abs(position.y) <= 1_000_000,
  );
}

function semanticTrackSlice(
  actions: readonly FailurePlayerAction[],
  startSeconds: number,
  capturedAtSeconds: number,
): FailureSemanticTrackSlice | undefined {
  const unique = new Map<string, FailureSemanticTrackSample>();
  const ordered = actions
    .filter((action) => (
      inWindow(action.atSeconds, startSeconds, capturedAtSeconds)
      && validPlayerPosition(action.position)
    ))
    .sort((left, right) => (
      left.atSeconds - right.atSeconds
      || stableStringOrdering(left.action, right.action)
      || left.position!.x - right.position!.x
      || left.position!.y - right.position!.y
    ));
  for (const action of ordered) {
    const atSeconds = roundMillis(action.atSeconds);
    const position = action.position!;
    const fingerprint = [
      atSeconds.toFixed(3),
      action.action,
      roundMillis(position.x).toFixed(3),
      roundMillis(position.y).toFixed(3),
    ].join("|");
    if (unique.has(fingerprint)) continue;
    unique.set(fingerprint, Object.freeze({
      atSeconds,
      secondsBeforeCapture: roundMillis(Math.max(0, capturedAtSeconds - action.atSeconds)),
      position: Object.freeze({
        x: roundMillis(position.x),
        y: roundMillis(position.y),
      }),
      action: action.action,
      iconToken: actionPresentation(action.action).iconToken,
    }));
  }
  const samples = [...unique.values()].slice(-FAILURE_CAUSAL_REPLAY_MAX_TRACK_SAMPLES);
  if (!samples.length) return undefined;
  return Object.freeze({
    startSeconds: samples[0].atSeconds,
    endSeconds: samples[samples.length - 1].atSeconds,
    samples: Object.freeze(samples),
  });
}

/**
 * Produces a bounded, deterministic player-facing explanation. The projection
 * intentionally has no field for chaser coordinates, private occupancy,
 * evidence identity, authenticity, or internal memory.
 */
export function buildFailureCausalReplay(
  input: FailureCausalReplayInput,
): FailureCausalReplay {
  if (!finiteTime(input.capturedAtSeconds)) {
    throw new Error("capturedAtSeconds must be a finite non-negative number");
  }
  const requestedWindow = Number.isFinite(input.windowSeconds)
    ? Number(input.windowSeconds)
    : FAILURE_CAUSAL_REPLAY_DEFAULT_WINDOW_SECONDS;
  const windowSeconds = Math.min(
    FAILURE_CAUSAL_REPLAY_MAX_WINDOW_SECONDS,
    Math.max(FAILURE_CAUSAL_REPLAY_MIN_WINDOW_SECONDS, requestedWindow),
  );
  const startSeconds = Math.max(0, input.capturedAtSeconds - windowSeconds);
  const captureReason = resolvedCaptureReason(input, startSeconds);
  const feedback = failureFeedback(captureReason);

  const candidates: TimelineCandidate[] = [];
  for (const sample of input.publicEvents) {
    if (!inWindow(sample.atSeconds, startSeconds, input.capturedAtSeconds)) continue;
    const candidate = simulationEventCandidate(sample);
    if (candidate) candidates.push(candidate);
  }
  for (const evidence of input.publicEvidence ?? []) {
    if (!inWindow(evidence.observedAtSeconds, startSeconds, input.capturedAtSeconds)) continue;
    const presentation = evidencePresentation(evidence);
    const confidence = Number.isFinite(evidence.confidence)
      ? Math.min(1, Math.max(0, evidence.confidence))
      : 0;
    candidates.push({
      kind: "public-evidence",
      atSeconds: evidence.observedAtSeconds,
      ...presentation,
      priority: presentation.priority + Math.round(confidence * 5),
    });
  }
  for (const action of input.playerActions ?? []) {
    if (!inWindow(action.atSeconds, startSeconds, input.capturedAtSeconds)) continue;
    candidates.push(playerActionCandidate(action));
  }
  if (candidates.length === 0) {
    candidates.push({
      kind: "threat-feedback",
      atSeconds: Math.max(startSeconds, input.capturedAtSeconds - 1.5),
      label: "捕获前风险已经升高",
      detail: "公开记录不足以还原更早动作；下次先减速观察，并预留一条转角撤离路线。",
      iconToken: "alert",
      dedupeGroup: "capture-risk-fallback",
      priority: 60,
    });
  }
  candidates.push({
    kind: "capture",
    atSeconds: input.capturedAtSeconds,
    label: `失败：${feedback.title}`,
    detail: feedback.explanation,
    iconToken: CAPTURE_ICON[captureReason],
    dedupeGroup: "capture",
    priority: 100,
  });

  const track = input.includeSemanticTrack
    ? semanticTrackSlice(
        input.playerActions ?? [],
        startSeconds,
        input.capturedAtSeconds,
      )
    : undefined;
  return Object.freeze({
    captureReason,
    window: Object.freeze({
      startSeconds: roundMillis(startSeconds),
      endSeconds: roundMillis(input.capturedAtSeconds),
      durationSeconds: roundMillis(input.capturedAtSeconds - startSeconds),
    }),
    timeline: selectedTimeline(candidates, input.capturedAtSeconds),
    primaryCause: Object.freeze({
      code: captureReason,
      label: feedback.title,
      detail: feedback.explanation,
      iconToken: CAPTURE_ICON[captureReason],
    }),
    advice: Object.freeze({
      label: "下次这样做",
      detail: feedback.hint,
      iconToken: "advice",
    }),
    ...(track ? { semanticTrack: track } : {}),
  });
}
