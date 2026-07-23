import {
  MASTERY_CHALLENGE_IDS,
  type MasteryRank,
  type StoredMastery,
} from "./mastery.ts";

export interface CampaignProgress {
  unlockedThrough: number;
  bestSeconds: Record<string, number>;
  mastery: Record<string, StoredMastery>;
}

const MASTERY_RANKS: readonly MasteryRank[] = ["bronze", "silver", "gold"];

export function createCampaignProgress(): CampaignProgress {
  return {
    unlockedThrough: 1,
    bestSeconds: {},
    mastery: {},
  };
}

/** Migrates legacy time-only JSON and rejects corrupt or foreign level data. */
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
  };
  const unlockedCandidate = Number.isInteger(stored.unlockedThrough)
    ? Number(stored.unlockedThrough)
    : 1;
  const unlockedThrough = Math.min(levelIds.length, Math.max(1, unlockedCandidate));
  const knownIds = new Set(levelIds);
  const bestSeconds = Object.fromEntries(
    stored.bestSeconds && typeof stored.bestSeconds === "object"
      ? Object.entries(stored.bestSeconds).filter(([id, seconds]) => (
          knownIds.has(id)
          && typeof seconds === "number"
          && Number.isFinite(seconds)
          && seconds > 0
        ))
      : [],
  ) as Record<string, number>;
  const mastery = Object.fromEntries(
    stored.mastery && typeof stored.mastery === "object"
      ? Object.entries(stored.mastery).flatMap(([id, candidate]) => {
          if (!knownIds.has(id) || !candidate || typeof candidate !== "object") return [];
          const rank = (candidate as { rank?: unknown }).rank;
          if (!MASTERY_RANKS.includes(rank as MasteryRank)) return [];
          const rawChallengeIds = (candidate as { challengeIds?: unknown }).challengeIds;
          const challengeIds = MASTERY_CHALLENGE_IDS.filter((challengeId) => (
            Array.isArray(rawChallengeIds) && rawChallengeIds.includes(challengeId)
          ));
          return [[id, { rank: rank as MasteryRank, challengeIds }]];
        })
      : [],
  ) as Record<string, StoredMastery>;
  return { unlockedThrough, bestSeconds, mastery };
}
