import {
  MASTERY_CHALLENGE_IDS,
  mergeStoredMastery,
  type MasteryRank,
  type RunMasteryResult,
  type RunRuleset,
  type StoredMastery,
} from "./mastery.ts";

export const CAMPAIGN_PROGRESS_VERSION = 2;

export interface CampaignProgress {
  unlockedThrough: number;
  /** Standard-only records retained at their legacy keys for UI compatibility. */
  bestSeconds: Record<string, number>;
  mastery: Record<string, StoredMastery>;
  /** Assisted records never overwrite or unlock Standard records. */
  assistedBestSeconds?: Record<string, number>;
  assistedMastery?: Record<string, StoredMastery>;
  progressVersion?: typeof CAMPAIGN_PROGRESS_VERSION;
}

export interface CampaignRunRecord {
  readonly bestSeconds: number | undefined;
  readonly mastery: StoredMastery | undefined;
}

const MASTERY_RANKS: readonly MasteryRank[] = ["bronze", "silver", "gold"];

export function createCampaignProgress(): CampaignProgress {
  return {
    unlockedThrough: 1,
    bestSeconds: {},
    mastery: {},
    assistedBestSeconds: {},
    assistedMastery: {},
    progressVersion: CAMPAIGN_PROGRESS_VERSION,
  };
}

function sanitizeBestSeconds(
  value: unknown,
  knownIds: ReadonlySet<string>,
): Record<string, number> {
  return Object.fromEntries(
    value && typeof value === "object"
      ? Object.entries(value).filter(([id, seconds]) => (
          knownIds.has(id)
          && typeof seconds === "number"
          && Number.isFinite(seconds)
          && seconds > 0
        ))
      : [],
  ) as Record<string, number>;
}

function sanitizeMastery(
  value: unknown,
  knownIds: ReadonlySet<string>,
): Record<string, StoredMastery> {
  return Object.fromEntries(
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([id, candidate]) => {
          if (!knownIds.has(id) || !candidate || typeof candidate !== "object") return [];
          const rank = (candidate as { rank?: unknown }).rank;
          if (!MASTERY_RANKS.includes(rank as MasteryRank)) return [];
          const rawChallengeIds = (candidate as { challengeIds?: unknown }).challengeIds;
          const challengeIds = MASTERY_CHALLENGE_IDS.filter((challengeId) => (
            Array.isArray(rawChallengeIds) && rawChallengeIds.includes(challengeId)
          ));
          const profileId = (candidate as { profileId?: unknown }).profileId;
          return [[id, {
            rank: rank as MasteryRank,
            challengeIds,
            ...(typeof profileId === "string" && profileId.length > 0 && profileId.length <= 120
              ? { profileId }
              : {}),
          }]];
        })
      : [],
  ) as Record<string, StoredMastery>;
}

/** Migrates legacy time-only/Standard-only JSON and rejects foreign data. */
export function sanitizeCampaignProgress(
  value: unknown,
  levelIds: readonly string[],
): CampaignProgress {
  const fallback = createCampaignProgress();
  if (!value || typeof value !== "object" || levelIds.length === 0) return fallback;
  const stored = value as {
    unlockedThrough?: unknown;
    bestSeconds?: unknown;
    mastery?: unknown;
    assistedBestSeconds?: unknown;
    assistedMastery?: unknown;
  };
  const unlockedCandidate = Number.isInteger(stored.unlockedThrough)
    ? Number(stored.unlockedThrough)
    : 1;
  const unlockedThrough = Math.min(levelIds.length, Math.max(1, unlockedCandidate));
  const knownIds = new Set(levelIds);
  return {
    unlockedThrough,
    bestSeconds: sanitizeBestSeconds(stored.bestSeconds, knownIds),
    mastery: sanitizeMastery(stored.mastery, knownIds),
    assistedBestSeconds: sanitizeBestSeconds(stored.assistedBestSeconds, knownIds),
    assistedMastery: sanitizeMastery(stored.assistedMastery, knownIds),
    progressVersion: CAMPAIGN_PROGRESS_VERSION,
  };
}

export function getCampaignRunRecord(
  progress: Readonly<CampaignProgress>,
  levelId: string,
  ruleset: RunRuleset = "standard",
): CampaignRunRecord {
  if (ruleset === "assisted") {
    return Object.freeze({
      bestSeconds: progress.assistedBestSeconds?.[levelId],
      mastery: progress.assistedMastery?.[levelId],
    });
  }
  return Object.freeze({
    bestSeconds: progress.bestSeconds[levelId],
    mastery: progress.mastery[levelId],
  });
}

/**
 * Records a completed run in its own ruleset lane. Only Standard clears may
 * advance campaign unlocks; assisted progress remains a valid personal record.
 */
export function recordCampaignCompletion(
  progress: Readonly<CampaignProgress>,
  levelId: string,
  completedSeconds: number,
  masteryResult: RunMasteryResult,
  unlockThroughOnStandardClear = progress.unlockedThrough,
): CampaignProgress {
  if (!Number.isFinite(completedSeconds) || completedSeconds <= 0) {
    throw new Error("Completed seconds must be a finite positive number");
  }

  const assistedBestSeconds = { ...(progress.assistedBestSeconds ?? {}) };
  const assistedMastery = { ...(progress.assistedMastery ?? {}) };
  const bestSeconds = { ...progress.bestSeconds };
  const mastery = { ...progress.mastery };

  if (masteryResult.ruleset === "assisted") {
    const previousBest = assistedBestSeconds[levelId];
    assistedBestSeconds[levelId] = previousBest
      ? Math.min(previousBest, completedSeconds)
      : completedSeconds;
    assistedMastery[levelId] = mergeStoredMastery(
      assistedMastery[levelId],
      masteryResult,
    );
  } else {
    const previousBest = bestSeconds[levelId];
    bestSeconds[levelId] = previousBest
      ? Math.min(previousBest, completedSeconds)
      : completedSeconds;
    mastery[levelId] = mergeStoredMastery(mastery[levelId], masteryResult);
  }

  return {
    unlockedThrough: masteryResult.ruleset === "standard"
      ? Math.max(progress.unlockedThrough, unlockThroughOnStandardClear)
      : progress.unlockedThrough,
    bestSeconds,
    mastery,
    assistedBestSeconds,
    assistedMastery,
    progressVersion: CAMPAIGN_PROGRESS_VERSION,
  };
}
