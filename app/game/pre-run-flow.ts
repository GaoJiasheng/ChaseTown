import type { CampaignProgress } from "./campaign-progress.ts";
import { getCampaignUnlockedThrough } from "./campaign-progress.ts";
import {
  HOSPITAL_BRANCHING_MISSION,
  HOSPITAL_TOOL_LOADOUT,
  type HospitalLoadoutToolId,
  type HospitalMissionPlanId,
} from "./hospital-branching-mission.ts";
import {
  LIBRARY_BRANCHING_MISSION,
  type LibraryMissionPlanId,
} from "./library-branching-mission.ts";
import type { RunRuleset } from "./mastery.ts";

export const PRE_RUN_STEPS = [
  "chapter",
  "strategy",
  "briefing",
] as const;

export type PreRunStep = (typeof PRE_RUN_STEPS)[number];

export interface PreRunFlowState {
  readonly step: PreRunStep;
}

export type PreRunFlowAction =
  | { readonly type: "next" }
  | { readonly type: "back" }
  | { readonly type: "reset" };

export function isPreRunStep(value: unknown): value is PreRunStep {
  return typeof value === "string"
    && PRE_RUN_STEPS.includes(value as PreRunStep);
}

export function isPreRunFlowState(value: unknown): value is PreRunFlowState {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && isPreRunStep((value as { step?: unknown }).step),
  );
}

export function createPreRunFlowState(
  step: unknown = "chapter",
): PreRunFlowState {
  return Object.freeze({
    step: isPreRunStep(step) ? step : "chapter",
  });
}

export function canAdvancePreRunFlow(
  state: Readonly<PreRunFlowState>,
): boolean {
  return state.step !== "briefing";
}

export function canGoBackPreRunFlow(
  state: Readonly<PreRunFlowState>,
): boolean {
  return state.step !== "chapter";
}

/**
 * Keeps the UI sequence deterministic. Boundary actions are deliberate no-ops
 * so key repeat and duplicate pointer delivery can never skip a preparation
 * step or accidentally start gameplay.
 */
export function preRunFlowReducer(
  state: Readonly<PreRunFlowState>,
  action: Readonly<PreRunFlowAction>,
): PreRunFlowState {
  if (!isPreRunFlowState(state)) return createPreRunFlowState();
  if (action.type === "reset") return createPreRunFlowState();
  const index = PRE_RUN_STEPS.indexOf(state.step);
  if (action.type === "next") {
    return index >= PRE_RUN_STEPS.length - 1
      ? state
      : createPreRunFlowState(PRE_RUN_STEPS[index + 1]);
  }
  if (action.type === "back") {
    return index <= 0
      ? state
      : createPreRunFlowState(PRE_RUN_STEPS[index - 1]);
  }
  return state;
}

export const LAST_RUN_SETUP_VERSION = 1;
export const LAST_RUN_SETUP_KEY = "chasing.last-run-setup.v1";

export type CertifiedRemixVariant = 0 | 1 | 2 | null;

export interface LastRunSetup {
  readonly version: typeof LAST_RUN_SETUP_VERSION;
  readonly levelId: string;
  readonly remixVariant: CertifiedRemixVariant;
  readonly ruleset: RunRuleset;
  readonly libraryPlanId: LibraryMissionPlanId;
  readonly hospitalPlanId: HospitalMissionPlanId;
  readonly hospitalToolIds: readonly [
    HospitalLoadoutToolId,
    HospitalLoadoutToolId,
  ];
}

export interface LastRunSetupValidationContext {
  readonly levelIds: readonly string[];
  readonly progress: Readonly<CampaignProgress>;
}

export interface LastRunSetupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const libraryPlanIds = new Set<LibraryMissionPlanId>(
  LIBRARY_BRANCHING_MISSION.plans.map(({ id }) => id),
);
const hospitalPlanIds = new Set<HospitalMissionPlanId>(
  HOSPITAL_BRANCHING_MISSION.plans.map(({ id }) => id),
);
const hospitalToolIds = new Set<HospitalLoadoutToolId>(
  HOSPITAL_TOOL_LOADOUT.tools.map(({ id }) => id),
);

function isRemixVariant(value: unknown): value is CertifiedRemixVariant {
  return value === null || value === 0 || value === 1 || value === 2;
}

function isRuleset(value: unknown): value is RunRuleset {
  return value === "standard" || value === "assisted";
}

function validUnlockedLevel(
  levelId: unknown,
  ruleset: RunRuleset,
  context: Readonly<LastRunSetupValidationContext>,
): levelId is string {
  if (typeof levelId !== "string" || levelId.length === 0) return false;
  const levelIndex = context.levelIds.indexOf(levelId);
  if (levelIndex < 0) return false;
  const rawUnlockedThrough = getCampaignUnlockedThrough(
    context.progress,
    ruleset,
  );
  const unlockedThrough = Number.isFinite(rawUnlockedThrough)
    ? Math.min(
        context.levelIds.length,
        Math.max(1, Math.floor(rawUnlockedThrough)),
      )
    : 1;
  return levelIndex < unlockedThrough;
}

/**
 * Returns a frozen canonical setup or null. Unknown fields are ignored, while
 * every gameplay-affecting field must be present and legal for the active
 * progress lane.
 */
export function sanitizeLastRunSetup(
  value: unknown,
  context: Readonly<LastRunSetupValidationContext>,
): LastRunSetup | null {
  try {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || context.levelIds.length === 0
    ) {
      return null;
    }
    const candidate = value as {
      readonly version?: unknown;
      readonly levelId?: unknown;
      readonly remixVariant?: unknown;
      readonly ruleset?: unknown;
      readonly libraryPlanId?: unknown;
      readonly hospitalPlanId?: unknown;
      readonly hospitalToolIds?: unknown;
    };
    if (
      candidate.version !== LAST_RUN_SETUP_VERSION
      || !isRemixVariant(candidate.remixVariant)
      || !isRuleset(candidate.ruleset)
      || !validUnlockedLevel(
        candidate.levelId,
        candidate.ruleset,
        context,
      )
      || !libraryPlanIds.has(
        candidate.libraryPlanId as LibraryMissionPlanId,
      )
      || !hospitalPlanIds.has(
        candidate.hospitalPlanId as HospitalMissionPlanId,
      )
      || !Array.isArray(candidate.hospitalToolIds)
      || candidate.hospitalToolIds.length
        !== HOSPITAL_TOOL_LOADOUT.slotCount
    ) {
      return null;
    }
    const [firstTool, secondTool] = candidate.hospitalToolIds;
    if (
      !hospitalToolIds.has(firstTool as HospitalLoadoutToolId)
      || !hospitalToolIds.has(secondTool as HospitalLoadoutToolId)
      || firstTool === secondTool
    ) {
      return null;
    }
    const canonicalTools = Object.freeze([
      firstTool as HospitalLoadoutToolId,
      secondTool as HospitalLoadoutToolId,
    ]) as readonly [HospitalLoadoutToolId, HospitalLoadoutToolId];
    return Object.freeze({
      version: LAST_RUN_SETUP_VERSION,
      levelId: candidate.levelId,
      remixVariant: candidate.remixVariant,
      ruleset: candidate.ruleset,
      libraryPlanId: candidate.libraryPlanId as LibraryMissionPlanId,
      hospitalPlanId: candidate.hospitalPlanId as HospitalMissionPlanId,
      hospitalToolIds: canonicalTools,
    });
  } catch {
    return null;
  }
}

export function loadLastRunSetup(
  storage: LastRunSetupStorage | null | undefined,
  context: Readonly<LastRunSetupValidationContext>,
): LastRunSetup | null {
  if (!storage) return null;
  try {
    const serialized = storage.getItem(LAST_RUN_SETUP_KEY);
    return serialized
      ? sanitizeLastRunSetup(JSON.parse(serialized), context)
      : null;
  } catch {
    return null;
  }
}

export function saveLastRunSetup(
  storage: LastRunSetupStorage | null | undefined,
  setup: unknown,
  context: Readonly<LastRunSetupValidationContext>,
): boolean {
  if (!storage) return false;
  const canonical = sanitizeLastRunSetup(setup, context);
  if (!canonical) return false;
  try {
    storage.setItem(LAST_RUN_SETUP_KEY, JSON.stringify(canonical));
    return true;
  } catch {
    return false;
  }
}
