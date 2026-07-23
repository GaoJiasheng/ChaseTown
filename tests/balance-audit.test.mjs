import assert from "node:assert/strict";
import test from "node:test";

import {
  BALANCE_CURVE_POLICY,
  BALANCE_STRATEGY_IDS,
  balanceScenarioSeed,
  buildCampaignBalanceReport,
  createBalanceScenarios,
  runDeterministicBalanceAudit,
} from "../app/game/balance-audit.ts";

const levels = Array.from({ length: 10 }, (_, index) => ({
  id: `level-${index + 1}`,
  levelNumber: index + 1,
}));

const clearCounts = {
  novice: [9, 9, 8, 8, 7, 7, 6, 6, 5, 5],
  standard: [11, 11, 10, 10, 9, 9, 8, 8, 7, 7],
  skilled: [12, 12, 11, 11, 10, 10, 9, 9, 8, 8],
  speedrun: [9, 9, 9, 8, 8, 8, 7, 7, 7, 6],
};

test("four strategy scenario matrix is stable, complete, and seed-addressable", () => {
  const first = createBalanceScenarios(levels, 12);
  const second = createBalanceScenarios([...levels].reverse(), 12);
  assert.deepEqual(second, first);
  assert.equal(first.length, 10 * 4 * 12);
  assert.deepEqual(new Set(first.map(({ strategyId }) => strategyId)), new Set(BALANCE_STRATEGY_IDS));
  assert.equal(
    first[0].seed,
    balanceScenarioSeed(first[0].levelId, first[0].strategyId, first[0].sampleIndex),
  );
  assert.equal(new Set(first.map(({ id }) => id)).size, first.length);
});

test("outcome audit accepts a smooth curve and is deterministic across runs", () => {
  const runner = (scenario, strategy) => {
    const escaped = scenario.sampleIndex < clearCounts[strategy.id][scenario.levelNumber - 1];
    return {
      outcome: escaped ? "escaped" : "captured",
      elapsedSeconds: 25 + scenario.levelNumber * 2 + scenario.sampleIndex / 10,
      detections: strategy.id === "skilled" ? 0 : 1,
      hideEntries: strategy.usesHiding ? 1 : 0,
      mechanicUses: strategy.usesThemeMechanics ? 1 : 0,
      captureReason: escaped ? null : "direct-contact",
    };
  };
  const first = runDeterministicBalanceAudit(levels, runner);
  const second = runDeterministicBalanceAudit(levels, runner);
  assert.deepEqual(second, first);
  assert.equal(first.generatedFromAttempts, 480);
  assert.equal(first.passed, true);
  assert.equal(first.failures.length, 0);
  assert.ok(first.levels[0].coreClearRate > first.levels[9].coreClearRate);
  assert.equal(first.levels[0].strategies.standard.attempts, 12);
});

test("curve gates report adjacent cliffs, easier late chapters, and suggested tuning keys", () => {
  const scenarios = createBalanceScenarios(levels, 12);
  const attempts = scenarios.map((scenario) => {
    const clearLimit = scenario.levelNumber === 1
      ? 12
      : scenario.levelNumber === 2
        ? 1
        : 12;
    return {
      scenarioId: scenario.id,
      levelId: scenario.levelId,
      levelNumber: scenario.levelNumber,
      strategyId: scenario.strategyId,
      seed: scenario.seed,
      outcome: scenario.sampleIndex < clearLimit ? "escaped" : "captured",
      elapsedSeconds: 30,
    };
  });
  const report = buildCampaignBalanceReport(levels, attempts);
  assert.equal(report.passed, false);
  assert.ok(report.failures.some(({ code, levelId }) => (
    code === "adjacent-cliff" && levelId === "level-2"
  )));
  assert.ok(report.failures.some(({ code }) => code === "late-campaign-easier"));
  const easing = report.recommendations.find(({ direction }) => direction === "ease");
  assert.ok(easing.suggestedConfigKeys.includes("spawnDelaySeconds"));
  assert.ok(easing.suggestedConfigKeys.includes("chaserSpeed"));
});

test("coverage is a hard gate instead of silently extrapolating sparse playtests", () => {
  const report = buildCampaignBalanceReport(
    levels.slice(0, 1),
    [],
    { ...BALANCE_CURVE_POLICY, minimumAttemptsPerStrategy: 3 },
  );
  assert.equal(report.passed, false);
  assert.equal(report.failures.filter(({ code }) => code === "coverage").length, 4);
  assert.ok(report.recommendations.every(({ direction }) => direction === "collect-more"));
});
