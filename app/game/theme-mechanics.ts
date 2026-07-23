import type { CampaignTheme } from "./campaign.ts";

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
