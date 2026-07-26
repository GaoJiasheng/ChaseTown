import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS, getCampaignGameplayConfig } from "../app/game/campaign.ts";
import { assistedGameplayConfig } from "../app/game/gameplay-preferences.ts";
import { createLevel } from "../app/game/level.ts";
import {
  applyRunEvents,
  applyRunTelemetryFrame,
  auditOrderedMasteryMissionRoute,
  createRunTelemetry,
  evaluateRunMastery,
  getMasteryProfile,
  LEGACY_MASTERY_PROFILE,
  masteryTargetPlan,
  masteryTargetSeconds,
  mergeStoredMastery,
  personalBestDelta,
  previewRunMastery,
  SAFE_HIDE_EXIT_SECONDS,
} from "../app/game/mastery.ts";
import {
  LIBRARY_BRANCHING_MISSION,
  LIBRARY_BRANCHING_MISSION_TOPOLOGY,
} from "../app/game/library-branching-mission.ts";
import {
  certifiedRemixContractsForLevel,
  remixReplayLevelId,
  resolveCertifiedRemix,
} from "../app/game/remix-contracts.ts";

test("telemetry counts authored stealth beats without double-counting lost-sight recovery", () => {
  const telemetry = applyRunEvents(createRunTelemetry(), [
    { type: "chaser-mode-changed", from: "patrol", to: "chase" },
    { type: "chaser-mode-changed", from: "chase", to: "lost-sight" },
    { type: "chaser-mode-changed", from: "lost-sight", to: "chase" },
    { type: "player-mode-changed", from: "free", to: "entering-hide" },
    { type: "player-mode-changed", from: "exiting-hide", to: "free" },
    { type: "hide-check-completed", hideSpotId: "locker", occupied: false },
  ]);

  assert.equal(telemetry.detections, 1);
  assert.equal(telemetry.hideEntries, 1);
  assert.equal(telemetry.hideExits, 1);
  assert.equal(telemetry.safeHideExits, 1);
  assert.equal(telemetry.lockerSearches, 1);
  assert.equal(telemetry.threatReacquisitions, 1);
});

test("telemetry preserves optional campaign mastery context through event reduction", () => {
  const context = { levelId: "school-maze-v1", theme: "campus" };
  const telemetry = applyRunEvents(createRunTelemetry(context), [
    { type: "player-mode-changed", from: "exiting-hide", to: "free" },
  ]);
  assert.deepEqual(telemetry.masteryContext, context);
  assert.equal(Object.isFrozen(telemetry.masteryContext), true);
  assert.equal(telemetry.safeHideExits, 1);
});

test("strict telemetry proves 2.5 calm seconds before counting a safe locker exit", () => {
  let telemetry = applyRunTelemetryFrame(createRunTelemetry(), {
    deltaSeconds: 1 / 60,
    events: [{ type: "player-mode-changed", from: "exiting-hide", to: "free" }],
    phase: "playing",
    playerMode: "free",
    threat: "calm",
  });
  assert.equal(telemetry.hideExits, 1);
  assert.equal(telemetry.safeHideExits, 0);

  for (let elapsed = 0; elapsed < SAFE_HIDE_EXIT_SECONDS; elapsed += 0.5) {
    telemetry = applyRunTelemetryFrame(telemetry, {
      deltaSeconds: 0.5,
      events: [],
      phase: "playing",
      playerMode: "free",
      threat: "calm",
    });
  }
  assert.equal(telemetry.safeHideExits, 1);
  assert.equal(telemetry.pendingSafeHideExitSeconds, null);

  let unsafe = applyRunTelemetryFrame(createRunTelemetry(), {
    deltaSeconds: 0,
    events: [{ type: "player-mode-changed", from: "exiting-hide", to: "free" }],
    phase: "playing",
    playerMode: "free",
    threat: "calm",
  });
  unsafe = applyRunTelemetryFrame(unsafe, {
    deltaSeconds: 2,
    events: [{ type: "chaser-mode-changed", from: "lost-sight", to: "chase" }],
    phase: "playing",
    playerMode: "free",
    threat: "active",
  });
  assert.equal(unsafe.safeHideExits, 0);
  assert.equal(unsafe.pendingSafeHideExitSeconds, null);
  assert.equal(unsafe.threatReacquisitions, 1);
});

test("causal telemetry rejects decorative searches and credits deployed decoys/mechanics once", () => {
  let telemetry = applyRunTelemetryFrame(createRunTelemetry({
    levelId: "campus-science-wing",
    theme: "campus",
  }), {
    deltaSeconds: 0.1,
    events: [{ type: "hide-check-completed", hideSpotId: "empty", occupied: false }],
    phase: "playing",
    playerMode: "free",
    threat: "caution",
    causalEvents: [
      { type: "investigation-completed", evidenceId: "not-ours", source: "decoy" },
      { type: "theme-mechanic-advantage", mechanicId: "bell", advantage: "diverted-pursuer" },
    ],
  });
  assert.equal(telemetry.decoyInvestigations, 0);
  assert.equal(telemetry.themeMechanicAdvantages, 0);

  telemetry = applyRunTelemetryFrame(telemetry, {
    deltaSeconds: 0.1,
    events: [],
    phase: "playing",
    playerMode: "free",
    threat: "caution",
    causalEvents: [
      { type: "decoy-deployed", decoyId: "coin-1" },
      { type: "decoy-deployed", decoyId: "coin-1" },
      { type: "theme-mechanic-used", mechanicId: "bell" },
      { type: "investigation-completed", evidenceId: "coin-1", source: "theme-mechanic" },
      { type: "investigation-completed", evidenceId: "coin-1", source: "theme-mechanic" },
      { type: "theme-mechanic-advantage", mechanicId: "bell", advantage: "diverted-pursuer" },
      { type: "route-selected", routeId: "east" },
      { type: "route-replanned", fromRouteId: "east", toRouteId: "west", reason: "threat" },
    ],
  });
  assert.equal(telemetry.decoysDeployed, 1);
  assert.equal(telemetry.decoyInvestigations, 1);
  assert.equal(telemetry.themeMechanicUses, 1);
  assert.equal(telemetry.themeMechanicAdvantages, 1);
  assert.equal(telemetry.routeReplans, 1);

  const mastery = evaluateRunMastery(1, 90, telemetry);
  assert.equal(
    mastery.challenges.find(({ id }) => id === "decoy-search").completed,
    true,
  );
});

function libraryOrderedMasteryCase(planId, ruleset = "standard") {
  const source = CAMPAIGN_LEVELS.find(
    ({ id }) => id === LIBRARY_BRANCHING_MISSION.levelId,
  );
  const plan = LIBRARY_BRANCHING_MISSION.plans.find(({ id }) => id === planId);
  assert.ok(source);
  assert.ok(plan);
  const exit = LIBRARY_BRANCHING_MISSION_TOPOLOGY.exitPlacements
    .find(({ exitId }) => exitId === plan.exitId)?.position;
  assert.ok(exit);
  const level = Object.freeze({
    ...source,
    exit: Object.freeze({ ...exit }),
  });
  const objectives = plan.objectiveIds.map((objectiveId) => {
    const definition = LIBRARY_BRANCHING_MISSION.objectives
      .find(({ id }) => id === objectiveId);
    const placement = LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements
      .find((candidate) => candidate.objectiveId === objectiveId);
    assert.ok(definition);
    assert.ok(placement);
    return {
      id: objectiveId,
      position: placement.position,
      commitmentSeconds: definition.commitmentSeconds,
    };
  });
  const options = {
    context: {
      levelId: source.id,
      theme: source.campaign.theme,
      ruleset,
    },
    mission: {
      kind: "ordered",
      id: `${LIBRARY_BRANCHING_MISSION.id}:${plan.id}`,
      objectives,
    },
  };
  return { source, level, plan, options };
}

test("G2 mastery follows each selected plan's exact objective order and physical exit", () => {
  const expected = new Map([
    ["access-authorization", {
      routeDistanceCells: 57,
      objectiveSeconds: 3.4,
      targetSeconds: 31,
    }],
    ["fire-release", {
      routeDistanceCells: 48,
      objectiveSeconds: 3.6,
      targetSeconds: 27,
    }],
  ]);

  for (const [planId, authored] of expected) {
    const { source, level, plan, options } = libraryOrderedMasteryCase(planId);
    const config = getCampaignGameplayConfig(source);
    const audit = auditOrderedMasteryMissionRoute(level, options.mission);
    assert.equal(audit.passed, true, audit.failures.join("; "));
    assert.deepEqual(audit.objectiveIds, plan.objectiveIds);
    assert.deepEqual(
      audit.legs.map(({ fromId, toId }) => [fromId, toId]),
      [
        ["spawn", plan.objectiveIds[0]],
        [plan.objectiveIds[0], plan.objectiveIds[1]],
        [plan.objectiveIds[1], plan.objectiveIds[2]],
        [plan.objectiveIds[2], "exit"],
      ],
    );
    assert.equal(audit.routeDistanceCells, authored.routeDistanceCells);
    assert.ok(Math.abs(audit.objectiveSeconds - authored.objectiveSeconds) < 1e-9);

    const targetPlan = masteryTargetPlan(level, config, options);
    assert.equal(targetPlan.mission.kind, "ordered");
    assert.deepEqual(
      targetPlan.mission.objectives.map(({ id }) => id),
      plan.objectiveIds,
    );
    assert.equal(Object.isFrozen(targetPlan.mission.objectives), true);
    assert.equal(Object.isFrozen(targetPlan.mission.objectives[0].position), true);
    assert.equal(
      targetPlan.missionRouteDistanceCells,
      authored.routeDistanceCells,
    );
    assert.ok(
      Math.abs(targetPlan.missionObjectiveSeconds - authored.objectiveSeconds) < 1e-9,
    );
    assert.equal(targetPlan.targetSeconds, authored.targetSeconds);

    const preview = previewRunMastery(level, config, options);
    const resultTarget = masteryTargetSeconds(level, config, options);
    const result = evaluateRunMastery(
      preview.targetSeconds,
      resultTarget,
      createRunTelemetry(options.context),
    );
    assert.equal(preview.targetSeconds, resultTarget);
    assert.equal(result.targetSeconds, preview.targetSeconds);
    assert.equal(result.profileId, preview.profileId);
    assert.deepEqual(
      result.challenges.map(({ id }) => id),
      preview.objectives.map(({ id }) => id),
    );
  }
});

test("ordered mastery audit rejects malformed or unreachable route legs", () => {
  const disconnected = createLevel({
    id: "ordered-mastery-disconnected",
    width: 5,
    height: 1,
    walkable: [[true, true, false, true, true]],
    playerStart: { x: 0, y: 0 },
    exit: { x: 1, y: 0 },
    chaserStart: { x: 4, y: 0 },
    chaserStartHeading: { x: -1, y: 0 },
    patrol: [{ x: 4, y: 0 }],
    hideSpots: [],
  });
  const unreachable = {
    kind: "ordered",
    id: "unreachable-route",
    objectives: [{
      id: "isolated-control",
      position: { x: 3, y: 0 },
      commitmentSeconds: 1.25,
    }],
  };
  const unreachableAudit = auditOrderedMasteryMissionRoute(
    disconnected,
    unreachable,
  );
  assert.equal(unreachableAudit.passed, false);
  assert.equal(unreachableAudit.routeDistanceCells, null);
  assert.deepEqual(unreachableAudit.legs, [{
    fromId: "spawn",
    toId: "isolated-control",
    reachable: false,
    distanceCells: null,
  }]);
  assert.match(unreachableAudit.failures.join("; "), /spawn -> isolated-control/u);
  assert.throws(
    () => masteryTargetPlan(disconnected, {}, { mission: unreachable }),
    /Mastery ordered mission route is invalid/u,
  );

  const { level, options } = libraryOrderedMasteryCase("access-authorization");
  const malformed = {
    ...options.mission,
    objectives: [
      options.mission.objectives[0],
      {
        ...options.mission.objectives[0],
        commitmentSeconds: Number.NaN,
      },
    ],
  };
  const malformedAudit = auditOrderedMasteryMissionRoute(level, malformed);
  assert.equal(malformedAudit.passed, false);
  assert.equal(malformedAudit.routeDistanceCells, null);
  assert.match(
    malformedAudit.failures.join("; "),
    /Duplicate ordered mastery objective|invalid commitment time/u,
  );
});

test("every campaign level receives a finite, achievable-looking mastery target", () => {
  const plans = CAMPAIGN_LEVELS.map((level) => (
    masteryTargetPlan(level, getCampaignGameplayConfig(level))
  ));
  const targets = plans.map(({ targetSeconds }) => targetSeconds);
  assert.ok(targets.every((seconds) => Number.isInteger(seconds) && seconds >= 20 && seconds <= 90));
  assert.ok(new Set(targets).size >= 5, "authored maze lengths should not collapse to one target");
  for (const [index, plan] of plans.entries()) {
    assert.ok(
      plan.missionRouteDistanceCells > plan.directRouteDistanceCells,
      `${CAMPAIGN_LEVELS[index].id} ignored mandatory mission routing`,
    );
    assert.ok(
      plan.targetSeconds >= Math.ceil(plan.theoreticalMinimumSeconds + plan.executionMarginSeconds),
      `${CAMPAIGN_LEVELS[index].id} target undercut its proven lower bound`,
    );
    assert.ok(plan.executionMarginRatio >= 0.18);
  }
});

test("mastery lower bound includes profile-forced hide time and gives Assisted a wider lane", () => {
  const level = CAMPAIGN_LEVELS.find(({ id }) => id === "fire-station-training-tower");
  assert.ok(level);
  const config = getCampaignGameplayConfig(level);
  const standard = masteryTargetPlan(level, config, {
    context: {
      levelId: level.id,
      theme: level.campaign.theme,
      ruleset: "standard",
    },
  });
  const assisted = masteryTargetPlan(level, config, {
    context: {
      levelId: level.id,
      theme: level.campaign.theme,
      ruleset: "assisted",
    },
  });

  assert.ok(standard.challengeForcedSeconds >= 7, "double-slip transitions were omitted");
  assert.ok(standard.missionObjectiveSeconds >= 3, "mission commitments were omitted");
  assert.ok(standard.targetSeconds > standard.theoreticalMinimumSeconds);
  assert.ok(assisted.targetSeconds > standard.targetSeconds);
  assert.equal(assisted.ruleset, "assisted");
});

test("all thirty certified layouts keep feasible Standard and Assisted mastery clocks", () => {
  let difficultRemix = null;
  for (const source of CAMPAIGN_LEVELS) {
    for (const contract of certifiedRemixContractsForLevel(source)) {
      const remixed = resolveCertifiedRemix(source, contract, "standard").level;
      const baseConfig = getCampaignGameplayConfig(source);
      const plans = ["standard", "assisted"].map((ruleset) => masteryTargetPlan(
        remixed,
        ruleset === "assisted" ? assistedGameplayConfig(baseConfig) : baseConfig,
        {
          context: {
            levelId: source.id,
            theme: source.campaign.theme,
            ruleset,
          },
        },
      ));
      for (const plan of plans) {
        assert.ok(
          plan.targetSeconds >= Math.ceil(
            plan.theoreticalMinimumSeconds + plan.executionMarginSeconds,
          ),
          `${contract.id}/${plan.ruleset} has an impossible clock`,
        );
        assert.ok(plan.missionRouteDistanceCells >= plan.directRouteDistanceCells);
      }
      assert.ok(
        plans[1].targetSeconds >= plans[0].targetSeconds,
        `${contract.id} made Assisted timing stricter`,
      );
      if (
        source.id === "fire-station-training-tower"
        && contract.variantIndex === 2
      ) difficultRemix = plans[0];
    }
  }
  assert.ok(difficultRemix);
  assert.ok(difficultRemix.targetSeconds >= 42);
  assert.ok(difficultRemix.targetSeconds > difficultRemix.theoreticalMinimumSeconds);
});

test("certified Remix storage identity never changes its authored mastery profile", () => {
  for (const source of CAMPAIGN_LEVELS) {
    for (const contract of certifiedRemixContractsForLevel(source)) {
      const remixed = resolveCertifiedRemix(source, contract, "standard").level;
      const context = {
        levelId: source.id,
        theme: source.campaign.theme,
        ruleset: "standard",
      };
      const preview = previewRunMastery(
        remixed,
        getCampaignGameplayConfig(source),
        context,
      );
      const result = evaluateRunMastery(
        preview.targetSeconds + 1,
        preview.targetSeconds,
        createRunTelemetry(context),
      );
      assert.equal(result.profileId, preview.profileId, contract.id);
      assert.deepEqual(
        result.challenges.map(({ id }) => id),
        preview.objectives.map(({ id }) => id),
        `${contract.id} preview/result challenges diverged`,
      );

      const recordIdentity = remixReplayLevelId(contract, "standard");
      assert.notEqual(recordIdentity, context.levelId);
      assert.equal(
        getMasteryProfile(context).id,
        `level:${source.id}:v2`,
        `${contract.id} stopped using its source chapter mastery`,
      );
    }
  }
});

test("run evaluation awards readable bronze, silver and gold mastery", () => {
  const base = { hideEntries: 1, lockerSearches: 0 };
  const bronze = evaluateRunMastery(50, 30, {
    ...base,
    safeHideExits: 0,
    detections: 3,
  });
  const silver = evaluateRunMastery(50, 30, {
    ...base,
    safeHideExits: 1,
    detections: 1,
  });
  const gold = evaluateRunMastery(29.994, 30, {
    ...base,
    safeHideExits: 1,
    detections: 1,
  });

  assert.equal(bronze.rank, "bronze");
  assert.equal(silver.rank, "silver");
  assert.equal(gold.rank, "gold");
  assert.equal(gold.completedSeconds, 29.99);
  assert.deepEqual(gold.challenges.map(({ completed }) => completed), [true, true, true]);
  assert.equal(gold.profileId, LEGACY_MASTERY_PROFILE.id);
});

test("campaign mastery profiles override theme defaults and remain internally achievable", () => {
  const combinations = new Set();
  for (const level of CAMPAIGN_LEVELS) {
    const context = { levelId: level.id, theme: level.campaign.theme };
    const masteryProfile = getMasteryProfile(context);
    assert.equal(masteryProfile.id, `level:${level.id}:v2`);
    assert.equal(masteryProfile.challengeIds.length, 3);
    assert.equal(new Set(masteryProfile.challengeIds).size, 3);
    assert.equal(Object.isFrozen(masteryProfile), true);
    assert.equal(Object.isFrozen(masteryProfile.challengeIds), true);
    combinations.add(masteryProfile.challengeIds.join("|"));

    const ids = new Set(masteryProfile.challengeIds);
    const hideCount = ids.has("double-slip") ? 2 : ids.has("hide-and-slip") ? 1 : 0;
    const result = evaluateRunMastery(1, 90, {
      ...createRunTelemetry(context),
      detections: 0,
      hideEntries: hideCount,
      safeHideExits: hideCount,
      lockerSearches: ids.has("decoy-search") ? 1 : 0,
      decoyInvestigations: ids.has("decoy-search") ? 1 : 0,
    });
    assert.equal(result.rank, "gold", `${level.id} profile cannot be completed`);
  }
  assert.ok(combinations.size >= 8, "campaign profiles collapsed to generic theme checklists");

  assert.equal(
    getMasteryProfile({ levelId: "unknown-campus", theme: "campus" }).id,
    "theme:campus:v2",
  );
  assert.equal(getMasteryProfile({ levelId: "unknown" }).id, LEGACY_MASTERY_PROFILE.id);
});

test("pre-run objectives are readable and assisted runs are explicitly unranked", () => {
  const level = CAMPAIGN_LEVELS[0];
  const preview = previewRunMastery(level, getCampaignGameplayConfig(level), {
    levelId: level.id,
    theme: level.campaign.theme,
    ruleset: "assisted",
  });
  assert.equal(preview.ruleset, "assisted");
  assert.equal(preview.ranked, false);
  assert.equal(preview.objectives.length, 3);
  assert.ok(preview.objectives.every(({ label, description }) => label && description));

  const result = evaluateRunMastery(1, preview.targetSeconds, {
    ...createRunTelemetry({
      levelId: level.id,
      theme: level.campaign.theme,
      ruleset: "assisted",
    }),
    detections: 0,
    hideEntries: 1,
    safeHideExits: 1,
  });
  assert.equal(result.ruleset, "assisted");
  assert.equal(result.ranked, false);
});

test("standard guided telemetry no longer grants automatic Gold across the campaign", () => {
  const guided = [
    { seconds: 30.63, detections: 1, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
    { seconds: 28.62, detections: 0, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
    { seconds: 29.08, detections: 0, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
    { seconds: 51.72, detections: 2, hideEntries: 2, safeHideExits: 2, lockerSearches: 1 },
    { seconds: 29.58, detections: 0, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
    { seconds: 54.93, detections: 1, hideEntries: 2, safeHideExits: 2, lockerSearches: 0 },
    { seconds: 23.33, detections: 1, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
    { seconds: 29.62, detections: 0, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
    { seconds: 31.22, detections: 1, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
    { seconds: 30.43, detections: 1, hideEntries: 1, safeHideExits: 1, lockerSearches: 0 },
  ];
  const ranks = CAMPAIGN_LEVELS.map((level, index) => evaluateRunMastery(
    guided[index].seconds,
    masteryTargetSeconds(level, getCampaignGameplayConfig(level)),
    {
      ...guided[index],
      masteryContext: { levelId: level.id, theme: level.campaign.theme },
    },
  ).rank);
  assert.equal(ranks.filter((rank) => rank === "gold").length, 0);
  assert.deepEqual(new Set(ranks), new Set(["silver"]));
});

test("stored mastery keeps the best rank and unions objectives across runs", () => {
  const first = evaluateRunMastery(24, 30, {
    detections: 4,
    hideEntries: 0,
    safeHideExits: 0,
    lockerSearches: 0,
  });
  const second = evaluateRunMastery(44, 30, {
    detections: 1,
    hideEntries: 1,
    safeHideExits: 1,
    lockerSearches: 0,
  });
  const afterFirst = mergeStoredMastery(undefined, first);
  const afterSecond = mergeStoredMastery(afterFirst, second);

  assert.equal(afterSecond.rank, "silver");
  assert.deepEqual(afterSecond.challengeIds, [
    "hide-and-slip",
    "single-sighting",
    "beat-target",
  ]);
});

test("a legacy Gold is capped at Silver when the level adopts a new profile", () => {
  const result = evaluateRunMastery(50, 30, {
    ...createRunTelemetry({ levelId: "school-maze-v1", theme: "campus" }),
    detections: 2,
    hideEntries: 1,
    safeHideExits: 1,
    lockerSearches: 0,
  });
  const migrated = mergeStoredMastery({
    rank: "gold",
    challengeIds: ["hide-and-slip", "single-sighting", "beat-target"],
  }, result);
  assert.equal(migrated.rank, "silver");
  assert.equal(migrated.profileId, "level:school-maze-v1:v2");
  assert.ok(migrated.challengeIds.includes("hide-and-slip"));
});

test("personal best feedback preserves hundredths and reports the correct direction", () => {
  assert.deepEqual(personalBestDelta(undefined, 35.25), {
    isPersonalBest: true,
    deltaSeconds: null,
  });
  assert.deepEqual(personalBestDelta(35.25, 34.8), {
    isPersonalBest: true,
    deltaSeconds: -0.45,
  });
  assert.deepEqual(personalBestDelta(35.25, 36.1), {
    isPersonalBest: false,
    deltaSeconds: 0.85,
  });
});
