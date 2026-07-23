export const BALANCE_STRATEGY_IDS = [
  "novice",
  "standard",
  "skilled",
  "speedrun",
] as const;

export type BalanceStrategyId = (typeof BALANCE_STRATEGY_IDS)[number];
export type BalanceOutcome = "escaped" | "captured" | "timeout";

export interface BalanceStrategyProfile {
  readonly id: BalanceStrategyId;
  readonly label: string;
  readonly reactionSeconds: number;
  readonly routeErrorChance: number;
  readonly usesHiding: boolean;
  readonly usesThemeMechanics: boolean;
  readonly sneakWhenUnseen: boolean;
  readonly objective: "survive" | "balanced" | "stealth" | "fastest-route";
}

export const BALANCE_STRATEGIES: Readonly<Record<BalanceStrategyId, BalanceStrategyProfile>> = Object.freeze({
  novice: Object.freeze({
    id: "novice",
    label: "新手",
    reactionSeconds: 0.85,
    routeErrorChance: 0.2,
    usesHiding: true,
    usesThemeMechanics: false,
    sneakWhenUnseen: false,
    objective: "survive",
  }),
  standard: Object.freeze({
    id: "standard",
    label: "普通",
    reactionSeconds: 0.4,
    routeErrorChance: 0.08,
    usesHiding: true,
    usesThemeMechanics: true,
    sneakWhenUnseen: false,
    objective: "balanced",
  }),
  skilled: Object.freeze({
    id: "skilled",
    label: "熟练",
    reactionSeconds: 0.18,
    routeErrorChance: 0.02,
    usesHiding: true,
    usesThemeMechanics: true,
    sneakWhenUnseen: true,
    objective: "stealth",
  }),
  speedrun: Object.freeze({
    id: "speedrun",
    label: "速通",
    reactionSeconds: 0.12,
    routeErrorChance: 0,
    usesHiding: false,
    usesThemeMechanics: true,
    sneakWhenUnseen: false,
    objective: "fastest-route",
  }),
});

export interface BalanceLevelDescriptor {
  readonly id: string;
  readonly levelNumber: number;
}

export interface BalanceScenario {
  readonly id: string;
  readonly levelId: string;
  readonly levelNumber: number;
  readonly strategyId: BalanceStrategyId;
  readonly sampleIndex: number;
  readonly seed: number;
}

export interface BalanceAttempt {
  readonly scenarioId: string;
  readonly levelId: string;
  readonly levelNumber: number;
  readonly strategyId: BalanceStrategyId;
  readonly seed: number;
  readonly outcome: BalanceOutcome;
  readonly elapsedSeconds: number;
  readonly detections?: number;
  readonly hideEntries?: number;
  readonly mechanicUses?: number;
  readonly captureReason?: string | null;
}

export interface StrategyBalanceSummary {
  readonly strategyId: BalanceStrategyId;
  readonly attempts: number;
  readonly escapes: number;
  readonly clearRate: number;
  readonly medianClearSeconds: number | null;
  readonly p90ClearSeconds: number | null;
  readonly meanDetections: number;
  readonly meanHideEntries: number;
  readonly meanMechanicUses: number;
}

export interface LevelBalanceSummary {
  readonly levelId: string;
  readonly levelNumber: number;
  /** Weighted novice/standard/skilled result; speedrun remains a risk probe. */
  readonly coreClearRate: number;
  readonly strategies: Readonly<Record<BalanceStrategyId, StrategyBalanceSummary>>;
}

export type BalanceGateCode =
  | "coverage"
  | "strategy-order"
  | "adjacent-cliff"
  | "adjacent-easier"
  | "late-campaign-easier";

export interface BalanceGateFailure {
  readonly code: BalanceGateCode;
  readonly levelId?: string;
  readonly previousLevelId?: string;
  readonly strategyId?: BalanceStrategyId;
  readonly actual: number;
  readonly limit: number;
  readonly message: string;
}

export interface BalanceRecommendation {
  readonly levelId: string;
  readonly direction: "ease" | "tighten" | "collect-more";
  readonly suggestedConfigKeys: readonly string[];
  readonly reason: string;
}

export interface BalanceCurvePolicy {
  readonly minimumAttemptsPerStrategy: number;
  readonly maximumAdjacentClearRateDrop: number;
  readonly maximumAdjacentClearRateIncrease: number;
  readonly maximumLateCampaignEase: number;
  readonly strategyOrderTolerance: number;
  readonly coreStrategyWeights: Readonly<Record<"novice" | "standard" | "skilled", number>>;
}

export const BALANCE_CURVE_POLICY: Readonly<BalanceCurvePolicy> = Object.freeze({
  minimumAttemptsPerStrategy: 12,
  maximumAdjacentClearRateDrop: 0.15,
  maximumAdjacentClearRateIncrease: 0.1,
  maximumLateCampaignEase: 0.1,
  strategyOrderTolerance: 0.05,
  coreStrategyWeights: Object.freeze({
    novice: 0.25,
    standard: 0.5,
    skilled: 0.25,
  }),
});

export const BALANCE_TUNING_KEYS = Object.freeze({
  ease: Object.freeze([
    "spawnDelaySeconds",
    "suspiciousSeconds",
    "visionRange",
    "hearingRange",
    "searchHideCheckBudget",
    "chaserSpeed",
  ]),
  tighten: Object.freeze([
    "chaserSpeed",
    "visionRange",
    "hearingRange",
    "searchSeconds",
    "searchHideCheckBudget",
    "soundUncertaintyCells",
  ]),
});

export interface CampaignBalanceReport {
  readonly generatedFromAttempts: number;
  readonly levels: readonly LevelBalanceSummary[];
  readonly passed: boolean;
  readonly failures: readonly BalanceGateFailure[];
  readonly recommendations: readonly BalanceRecommendation[];
}

export interface RunBalanceAuditOptions {
  readonly samplesPerStrategy?: number;
  readonly policy?: Readonly<BalanceCurvePolicy>;
}

export type BalanceScenarioRunner = (
  scenario: Readonly<BalanceScenario>,
  strategy: Readonly<BalanceStrategyProfile>,
) => Omit<BalanceAttempt, "scenarioId" | "levelId" | "levelNumber" | "strategyId" | "seed">;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function balanceScenarioSeed(
  levelId: string,
  strategyId: BalanceStrategyId,
  sampleIndex: number,
): number {
  if (!Number.isInteger(sampleIndex) || sampleIndex < 0) {
    throw new Error("Balance sample index must be a non-negative integer");
  }
  return stableHash(`${levelId}\u0000${strategyId}\u0000${sampleIndex}`);
}

export function createBalanceScenarios(
  levels: readonly BalanceLevelDescriptor[],
  samplesPerStrategy = BALANCE_CURVE_POLICY.minimumAttemptsPerStrategy,
): readonly BalanceScenario[] {
  if (!Number.isInteger(samplesPerStrategy) || samplesPerStrategy <= 0) {
    throw new Error("Balance samples per strategy must be a positive integer");
  }
  const seenLevelIds = new Set<string>();
  const seenNumbers = new Set<number>();
  for (const level of levels) {
    if (
      !level.id
      || !Number.isInteger(level.levelNumber)
      || level.levelNumber <= 0
      || seenLevelIds.has(level.id)
      || seenNumbers.has(level.levelNumber)
    ) {
      throw new Error("Balance levels require unique IDs and positive level numbers");
    }
    seenLevelIds.add(level.id);
    seenNumbers.add(level.levelNumber);
  }

  return Object.freeze(
    [...levels]
      .sort((left, right) => left.levelNumber - right.levelNumber)
      .flatMap((level) => BALANCE_STRATEGY_IDS.flatMap((strategyId) => (
        Array.from({ length: samplesPerStrategy }, (_, sampleIndex) => {
          const seed = balanceScenarioSeed(level.id, strategyId, sampleIndex);
          return Object.freeze({
            id: `${level.id}:${strategyId}:${sampleIndex}:${seed.toString(16).padStart(8, "0")}`,
            levelId: level.id,
            levelNumber: level.levelNumber,
            strategyId,
            sampleIndex,
            seed,
          });
        })
      ))),
  );
}

export function runDeterministicBalanceAudit(
  levels: readonly BalanceLevelDescriptor[],
  runner: BalanceScenarioRunner,
  options: Readonly<RunBalanceAuditOptions> = {},
): CampaignBalanceReport {
  const policy = options.policy ?? BALANCE_CURVE_POLICY;
  const scenarios = createBalanceScenarios(
    levels,
    options.samplesPerStrategy ?? policy.minimumAttemptsPerStrategy,
  );
  const attempts = scenarios.map((scenario): BalanceAttempt => {
    const result = runner(scenario, BALANCE_STRATEGIES[scenario.strategyId]);
    return Object.freeze({
      ...result,
      scenarioId: scenario.id,
      levelId: scenario.levelId,
      levelNumber: scenario.levelNumber,
      strategyId: scenario.strategyId,
      seed: scenario.seed,
    });
  });
  return buildCampaignBalanceReport(levels, attempts, policy);
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(clamp01(fraction) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function mean(attempts: readonly BalanceAttempt[], selector: (attempt: BalanceAttempt) => number): number {
  if (attempts.length === 0) return 0;
  return attempts.reduce((sum, attempt) => sum + selector(attempt), 0) / attempts.length;
}

function summarizeStrategy(
  strategyId: BalanceStrategyId,
  attempts: readonly BalanceAttempt[],
): StrategyBalanceSummary {
  const clearTimes = attempts
    .filter((attempt) => attempt.outcome === "escaped")
    .map((attempt) => attempt.elapsedSeconds);
  return Object.freeze({
    strategyId,
    attempts: attempts.length,
    escapes: clearTimes.length,
    clearRate: attempts.length > 0 ? clearTimes.length / attempts.length : 0,
    medianClearSeconds: percentile(clearTimes, 0.5),
    p90ClearSeconds: percentile(clearTimes, 0.9),
    meanDetections: mean(attempts, (attempt) => attempt.detections ?? 0),
    meanHideEntries: mean(attempts, (attempt) => attempt.hideEntries ?? 0),
    meanMechanicUses: mean(attempts, (attempt) => attempt.mechanicUses ?? 0),
  });
}

function recommendationFor(
  failure: Readonly<BalanceGateFailure>,
  fallbackLevelId: string,
): BalanceRecommendation {
  const levelId = failure.levelId ?? fallbackLevelId;
  if (failure.code === "coverage") {
    return Object.freeze({
      levelId,
      direction: "collect-more",
      suggestedConfigKeys: Object.freeze([]),
      reason: failure.message,
    });
  }
  const direction = failure.code === "adjacent-cliff" ? "ease" : "tighten";
  return Object.freeze({
    levelId,
    direction,
    suggestedConfigKeys: BALANCE_TUNING_KEYS[direction],
    reason: failure.message,
  });
}

export function buildCampaignBalanceReport(
  descriptors: readonly BalanceLevelDescriptor[],
  attempts: readonly BalanceAttempt[],
  policy: Readonly<BalanceCurvePolicy> = BALANCE_CURVE_POLICY,
): CampaignBalanceReport {
  const levels = [...descriptors].sort((left, right) => left.levelNumber - right.levelNumber);
  const descriptorById = new Map(levels.map((level) => [level.id, level]));
  for (const attempt of attempts) {
    const descriptor = descriptorById.get(attempt.levelId);
    if (
      !descriptor
      || descriptor.levelNumber !== attempt.levelNumber
      || !BALANCE_STRATEGY_IDS.includes(attempt.strategyId)
      || !Number.isFinite(attempt.elapsedSeconds)
      || attempt.elapsedSeconds < 0
    ) {
      throw new Error(`Invalid balance attempt ${attempt.scenarioId}`);
    }
  }

  const summaries = levels.map((level): LevelBalanceSummary => {
    const strategies = Object.fromEntries(BALANCE_STRATEGY_IDS.map((strategyId) => {
      const matching = attempts.filter((attempt) => (
        attempt.levelId === level.id && attempt.strategyId === strategyId
      ));
      return [strategyId, summarizeStrategy(strategyId, matching)];
    })) as unknown as Readonly<Record<BalanceStrategyId, StrategyBalanceSummary>>;
    const coreClearRate = (
      strategies.novice.clearRate * policy.coreStrategyWeights.novice
      + strategies.standard.clearRate * policy.coreStrategyWeights.standard
      + strategies.skilled.clearRate * policy.coreStrategyWeights.skilled
    );
    return Object.freeze({
      levelId: level.id,
      levelNumber: level.levelNumber,
      coreClearRate,
      strategies: Object.freeze(strategies),
    });
  });

  const failures: BalanceGateFailure[] = [];
  for (const level of summaries) {
    for (const strategyId of BALANCE_STRATEGY_IDS) {
      const actual = level.strategies[strategyId].attempts;
      if (actual < policy.minimumAttemptsPerStrategy) {
        failures.push(Object.freeze({
          code: "coverage",
          levelId: level.levelId,
          strategyId,
          actual,
          limit: policy.minimumAttemptsPerStrategy,
          message: `${level.levelId}/${strategyId} 仅有 ${actual} 次结果样本`,
        }));
      }
    }
    const ordered = ["novice", "standard", "skilled"] as const;
    for (let index = 1; index < ordered.length; index += 1) {
      const weaker = level.strategies[ordered[index - 1]];
      const stronger = level.strategies[ordered[index]];
      const inversion = weaker.clearRate - stronger.clearRate;
      if (inversion > policy.strategyOrderTolerance) {
        failures.push(Object.freeze({
          code: "strategy-order",
          levelId: level.levelId,
          strategyId: stronger.strategyId,
          actual: inversion,
          limit: policy.strategyOrderTolerance,
          message: `${level.levelId} 的 ${stronger.strategyId} 生存率反而低于 ${weaker.strategyId}`,
        }));
      }
    }
  }

  for (let index = 1; index < summaries.length; index += 1) {
    const previous = summaries[index - 1];
    const current = summaries[index];
    const drop = previous.coreClearRate - current.coreClearRate;
    const increase = current.coreClearRate - previous.coreClearRate;
    if (drop > policy.maximumAdjacentClearRateDrop) {
      failures.push(Object.freeze({
        code: "adjacent-cliff",
        levelId: current.levelId,
        previousLevelId: previous.levelId,
        actual: drop,
        limit: policy.maximumAdjacentClearRateDrop,
        message: `${previous.levelId} → ${current.levelId} 生存率骤降 ${(drop * 100).toFixed(1)}%`,
      }));
    }
    if (increase > policy.maximumAdjacentClearRateIncrease) {
      failures.push(Object.freeze({
        code: "adjacent-easier",
        levelId: current.levelId,
        previousLevelId: previous.levelId,
        actual: increase,
        limit: policy.maximumAdjacentClearRateIncrease,
        message: `${current.levelId} 比前一关轻松 ${(increase * 100).toFixed(1)}%`,
      }));
    }
  }

  if (summaries.length >= 4) {
    const split = Math.max(1, summaries.length - 4);
    const early = summaries.slice(0, split);
    const late = summaries.slice(split);
    const earlyMean = early.reduce((sum, level) => sum + level.coreClearRate, 0) / early.length;
    const lateMean = late.reduce((sum, level) => sum + level.coreClearRate, 0) / late.length;
    const ease = lateMean - earlyMean;
    if (ease > policy.maximumLateCampaignEase) {
      failures.push(Object.freeze({
        code: "late-campaign-easier",
        levelId: late[0].levelId,
        actual: ease,
        limit: policy.maximumLateCampaignEase,
        message: `最终四关平均生存率反而高出前段 ${(ease * 100).toFixed(1)}%`,
      }));
    }
  }

  const recommendations = failures.map((failure) => (
    recommendationFor(failure, summaries[0]?.levelId ?? "campaign")
  ));
  return Object.freeze({
    generatedFromAttempts: attempts.length,
    levels: Object.freeze(summaries),
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    recommendations: Object.freeze(recommendations),
  });
}
