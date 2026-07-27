import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS } from "../app/game/campaign.ts";
import { GhostRuleProgressTracker } from "../app/game/ghost-race.ts";
import {
  auditOrderedMasteryMissionRoute,
} from "../app/game/mastery.ts";
import {
  adaptHospitalMissionToThemeMissionState,
  adaptHospitalMissionTransitionToThemeMission,
  auditHospitalMissionEntityTopology,
  availableHospitalExitIds,
  availableHospitalObjectiveIds,
  createHospitalToolLoadoutSelection,
  createInitialHospitalMissionState,
  hospitalMissionCommitmentWindow,
  hospitalMissionExposureActiveAtTick,
  hospitalMissionExposureWindow,
  hospitalMissionEventsToGhostRuleEvents,
  hospitalMissionLevelForPlan,
  hospitalMissionMasteryRoute,
  HOSPITAL_BRANCHING_MISSION,
  HOSPITAL_BRANCHING_MISSION_TOPOLOGY,
  HOSPITAL_MISSION_INTERACTION_EXCLUSION_CELLS,
  HOSPITAL_MISSION_MINIMUM_ROUTE_ADVANTAGE_CELLS,
  HOSPITAL_TOOL_LOADOUT,
  replayHospitalMission,
  stepHospitalBranchingMission,
  summarizeHospitalMissionPlanCosts,
  validateHospitalBranchingMissionDefinition,
  validateHospitalToolLoadoutContract,
} from "../app/game/hospital-branching-mission.ts";
import {
  availableThemeObjectiveIds,
  THEME_MISSION_DEFINITIONS,
} from "../app/game/theme-objectives.ts";

const definition = HOSPITAL_BRANCHING_MISSION;
const hospitalLevel = CAMPAIGN_LEVELS.find(
  ({ id }) => id === definition.levelId,
);

function selectPlan(state, planId) {
  return stepHospitalBranchingMission(definition, state, {
    type: "select-plan",
    planId,
  });
}

function completeObjective(state, objectiveId) {
  return stepHospitalBranchingMission(definition, state, {
    type: "attempt-objective",
    objectiveId,
    outcome: "completed",
  });
}

function completePlan(state, planId) {
  const plan = definition.plans.find(({ id }) => id === planId);
  let step = state.activePlanId === planId
    ? {
        state,
        events: [],
        availableObjectiveIds: availableHospitalObjectiveIds(definition, state),
        availableExitIds: availableHospitalExitIds(definition, state),
      }
    : selectPlan(state, planId);
  const events = [...step.events];
  while (!step.state.unlockedExitIds.includes(plan.exitId)) {
    assert.deepEqual(
      step.availableObjectiveIds,
      [plan.objectiveIds.find(
        (id) => !step.state.completedObjectiveIds.includes(id),
      )],
    );
    step = completeObjective(step.state, step.availableObjectiveIds[0]);
    events.push(...step.events);
  }
  return { ...step, events };
}

test("midnight outpatient contract authors two genuinely different plans and exits", () => {
  assert.doesNotThrow(
    () => validateHospitalBranchingMissionDefinition(definition),
  );
  assert.equal(definition.levelId, "hospital-outpatient-afterhours");
  assert.equal(definition.plans.length, 2);
  assert.equal(definition.exits.length, 2);

  const quiet = definition.plans.find(
    ({ routeProfile }) => routeProfile === "quiet-long",
  );
  const risky = definition.plans.find(
    ({ routeProfile }) => routeProfile === "high-risk-short",
  );
  assert.ok(quiet);
  assert.ok(risky);
  assert.equal(quiet.id, "pharmacy-authorization");
  assert.equal(risky.id, "emergency-maintenance");
  assert.notEqual(quiet.exitId, risky.exitId);
  assert.equal(
    quiet.objectiveIds.some((id) => risky.objectiveIds.includes(id)),
    false,
  );

  for (const plan of definition.plans) {
    assert.ok(plan.objectiveIds.length >= 2 && plan.objectiveIds.length <= 3);
    const exit = definition.exits.find(({ id }) => id === plan.exitId);
    const unlock = definition.objectives.find(
      ({ id }) => id === plan.unlockObjectiveId,
    );
    assert.equal(exit.planId, plan.id);
    assert.equal(exit.unlockObjectiveId, plan.unlockObjectiveId);
    assert.equal(unlock.planId, plan.id);
    assert.equal(unlock.unlocksExitId, plan.exitId);
    assert.deepEqual(unlock.safety, {
      retryable: true,
      consumesRequiredResource: false,
      closesRequiredRoute: false,
    });
  }

  const quietCost = summarizeHospitalMissionPlanCosts(definition, quiet.id);
  const riskyCost = summarizeHospitalMissionPlanCosts(definition, risky.id);
  assert.ok(quietCost.commitmentSeconds > riskyCost.commitmentSeconds);
  assert.ok(quietCost.noiseStrength < riskyCost.noiseStrength);
  assert.ok(quietCost.exposureSeconds < riskyCost.exposureSeconds);
  assert.deepEqual(quiet.promise, {
    commitment: "longer",
    noise: "low",
    exposure: "low",
  });
  assert.deepEqual(risky.promise, {
    commitment: "shorter",
    noise: "high",
    exposure: "high",
  });
});

test("each plan completes alone, reports explicit costs, and unlocks only its own exit", () => {
  for (const plan of definition.plans) {
    const otherExit = definition.exits.find(({ id }) => id !== plan.exitId);
    const completed = completePlan(createInitialHospitalMissionState(), plan.id);

    assert.equal(completed.state.status, "exit-ready");
    assert.deepEqual(completed.state.unlockedExitIds, [plan.exitId]);
    assert.deepEqual(completed.availableExitIds, [plan.exitId]);
    assert.equal(
      completed.state.completedObjectiveIds.length,
      plan.objectiveIds.length,
    );
    const objectiveEvents = completed.events.filter(
      ({ type }) => type === "objective-completed",
    );
    assert.equal(objectiveEvents.length, plan.objectiveIds.length);
    for (const event of objectiveEvents) {
      const objective = definition.objectives.find(
        ({ id }) => id === event.objectiveId,
      );
      assert.deepEqual(event.cost, objective.cost);
    }

    const locked = stepHospitalBranchingMission(
      definition,
      completed.state,
      { type: "escape", exitId: otherExit.id },
    );
    assert.equal(locked.state, completed.state);
    assert.equal(locked.events[0].type, "command-rejected");
    assert.equal(locked.events[0].reason, "exit-locked");

    const escaped = stepHospitalBranchingMission(
      definition,
      completed.state,
      { type: "escape", exitId: plan.exitId },
    );
    assert.equal(escaped.state.status, "escaped");
    assert.equal(escaped.state.escapedViaExitId, plan.exitId);
    assert.deepEqual(escaped.availableExitIds, []);
    assert.deepEqual(escaped.events[0], {
      type: "mission-completed",
      exitId: plan.exitId,
      planId: plan.id,
    });
  }
});

test("interruptions are retryable and switching never deletes progress or unlocked exits", () => {
  const [quiet, risky] = definition.plans;
  let step = selectPlan(createInitialHospitalMissionState(), quiet.id);
  const firstQuietObjective = step.availableObjectiveIds[0];
  step = stepHospitalBranchingMission(definition, step.state, {
    type: "attempt-objective",
    objectiveId: firstQuietObjective,
    outcome: "interrupted",
  });
  assert.deepEqual(step.state.completedObjectiveIds, []);
  assert.deepEqual(
    step.state.failedAttempts,
    [{ objectiveId: firstQuietObjective, count: 1 }],
  );
  assert.deepEqual(step.availableObjectiveIds, [firstQuietObjective]);
  assert.equal(step.events[0].retryable, true);
  assert.deepEqual(
    step.events[0].cost,
    definition.objectives.find(({ id }) => id === firstQuietObjective).cost,
  );

  step = completeObjective(step.state, firstQuietObjective);
  step = selectPlan(step.state, risky.id);
  assert.equal(step.events[0].type, "plan-switched");
  assert.deepEqual(step.events[0].retainedObjectiveIds, [firstQuietObjective]);

  step = completePlan(step.state, risky.id);
  assert.deepEqual(step.state.unlockedExitIds, [risky.exitId]);
  assert.ok(step.state.completedObjectiveIds.includes(firstQuietObjective));

  step = selectPlan(step.state, quiet.id);
  assert.deepEqual(step.events[0].retainedExitIds, [risky.exitId]);
  step = completePlan(step.state, quiet.id);
  assert.deepEqual(
    new Set(step.state.unlockedExitIds),
    new Set([quiet.exitId, risky.exitId]),
  );
  assert.equal(
    step.state.completedObjectiveIds.length,
    definition.objectives.length,
  );
});

test("prerequisites and active-plan ownership reject illegal objective shortcuts", () => {
  const [quiet, risky] = definition.plans;
  const initial = createInitialHospitalMissionState();

  const noPlan = completeObjective(initial, quiet.objectiveIds[0]);
  assert.equal(noPlan.events[0].reason, "plan-not-selected");
  assert.equal(noPlan.state, initial);

  let step = selectPlan(initial, quiet.id);
  const premature = completeObjective(step.state, quiet.objectiveIds[1]);
  assert.equal(premature.events[0].reason, "prerequisite-missing");
  assert.deepEqual(premature.availableObjectiveIds, [quiet.objectiveIds[0]]);

  const inactive = completeObjective(step.state, risky.objectiveIds[0]);
  assert.equal(inactive.events[0].reason, "inactive-plan");
  assert.equal(inactive.state, step.state);
});

test("entity topology proves every anchor, route, switch, and the advertised shortcut", () => {
  assert.ok(hospitalLevel);
  const audit = auditHospitalMissionEntityTopology(hospitalLevel);
  assert.equal(audit.passed, true, audit.failures.join("; "));
  assert.equal(audit.plans.length, 2);
  assert.ok(audit.plans.every(
    ({ reachable, routeDistanceCells }) => reachable && routeDistanceCells > 0,
  ));
  assert.equal(
    audit.switches.length,
    definition.plans.reduce(
      (total, plan) => total + plan.objectiveIds.length + 1,
      0,
    ),
  );
  assert.ok(audit.switches.every(({ reachable }) => reachable));
  assert.equal(audit.routePromise.passed, true);
  assert.ok(
    audit.routePromise.riskyRouteAdvantageCells
      >= HOSPITAL_MISSION_MINIMUM_ROUTE_ADVANTAGE_CELLS,
  );

  const allAnchors = [
    ...HOSPITAL_BRANCHING_MISSION_TOPOLOGY.objectivePlacements,
    ...HOSPITAL_BRANCHING_MISSION_TOPOLOGY.exitPlacements,
  ];
  assert.equal(
    new Set(allAnchors.map(({ position }) => `${position.x},${position.y}`)).size,
    allAnchors.length,
  );
  for (const { position } of allAnchors) {
    for (const hideSpot of hospitalLevel.hideSpots) {
      assert.ok(
        Math.hypot(
          position.x - hideSpot.approach.x,
          position.y - hideSpot.approach.y,
        ) >= HOSPITAL_MISSION_INTERACTION_EXCLUSION_CELLS,
      );
    }
  }
});

test("topology audit rejects blocked, overlapping, and hide-conflicting entities", () => {
  const firstObjective =
    HOSPITAL_BRANCHING_MISSION_TOPOLOGY.objectivePlacements[0];
  const blockedLevel = {
    ...hospitalLevel,
    walkable: hospitalLevel.walkable.map((row, y) => row.map((cell, x) => (
      x === firstObjective.position.x && y === firstObjective.position.y
        ? false
        : cell
    ))),
  };
  const blocked = auditHospitalMissionEntityTopology(blockedLevel);
  assert.equal(blocked.passed, false);
  assert.ok(blocked.failures.some((failure) => (
    failure.includes("not on a walkable cell")
    || failure.includes("Unreachable leg")
  )));

  const overlapTopology = {
    ...HOSPITAL_BRANCHING_MISSION_TOPOLOGY,
    exitPlacements: HOSPITAL_BRANCHING_MISSION_TOPOLOGY.exitPlacements.map(
      (placement, index) => index === 0
        ? { ...placement, position: { ...firstObjective.position } }
        : placement,
    ),
  };
  const overlap = auditHospitalMissionEntityTopology(
    hospitalLevel,
    definition,
    overlapTopology,
  );
  assert.equal(overlap.passed, false);
  assert.ok(overlap.failures.some(
    (failure) => failure.includes("Mission anchors overlap"),
  ));

  const hideTopology = {
    ...HOSPITAL_BRANCHING_MISSION_TOPOLOGY,
    objectivePlacements:
      HOSPITAL_BRANCHING_MISSION_TOPOLOGY.objectivePlacements.map(
        (placement, index) => index === 0
          ? {
              ...placement,
              position: { ...hospitalLevel.hideSpots[0].approach },
            }
          : placement,
      ),
  };
  const hideConflict = auditHospitalMissionEntityTopology(
    hospitalLevel,
    definition,
    hideTopology,
  );
  assert.equal(hideConflict.passed, false);
  assert.ok(hideConflict.failures.some(
    (failure) => failure.includes("overlaps hide interaction"),
  ));
});

test("mastery contracts use the selected plan's exact order, commitment, and physical exit", () => {
  const topologyAudit = auditHospitalMissionEntityTopology(hospitalLevel);
  for (const plan of definition.plans) {
    const route = hospitalMissionMasteryRoute(plan.id);
    const activeLevel = hospitalMissionLevelForPlan(hospitalLevel, plan.id);
    const audit = auditOrderedMasteryMissionRoute(activeLevel, route);
    const topologyPlan = topologyAudit.plans.find(
      ({ planId }) => planId === plan.id,
    );
    const exitPlacement =
      HOSPITAL_BRANCHING_MISSION_TOPOLOGY.exitPlacements.find(
        ({ exitId }) => exitId === plan.exitId,
      );

    assert.equal(audit.passed, true, audit.failures.join("; "));
    assert.deepEqual(audit.objectiveIds, plan.objectiveIds);
    assert.equal(audit.routeDistanceCells, topologyPlan.routeDistanceCells);
    assert.deepEqual(activeLevel.exit, exitPlacement.position);
    assert.deepEqual(
      route.objectives.map(({ commitmentSeconds }) => commitmentSeconds),
      plan.objectiveIds.map((id) => (
        definition.objectives.find((objective) => objective.id === id)
          .cost.commitmentSeconds
      )),
    );
  }
});

test("direct G2 events drive ghost progress with actual objective and exit identity", () => {
  for (const plan of definition.plans) {
    let state = selectPlan(createInitialHospitalMissionState(), plan.id).state;
    const ghost = new GhostRuleProgressTracker(plan.objectiveIds);
    let snapshot = ghost.update({ tick: 0, routeProgress: 0 });

    for (const [index, objectiveId] of plan.objectiveIds.entries()) {
      const missionStep = completeObjective(state, objectiveId);
      state = missionStep.state;
      snapshot = ghost.update({
        tick: index + 1,
        routeProgress: 0,
        events: hospitalMissionEventsToGhostRuleEvents(missionStep.events),
      });
    }
    assert.deepEqual(snapshot.completedObjectiveIds, plan.objectiveIds);
    assert.equal(snapshot.exitUnlocked, true);

    const escaped = stepHospitalBranchingMission(definition, state, {
      type: "escape",
      exitId: plan.exitId,
    });
    snapshot = ghost.update({
      tick: plan.objectiveIds.length + 1,
      routeProgress: 1,
      events: hospitalMissionEventsToGhostRuleEvents(escaped.events),
    });
    assert.equal(snapshot.runCompleted, true);
  }
});

test("legacy hospital mission and ghost projection stay monotonic across switching", () => {
  const legacy = THEME_MISSION_DEFINITIONS.hospital;
  const ghost = new GhostRuleProgressTracker(
    legacy.objectives.map(({ id }) => id),
  );
  const [quiet, risky] = definition.plans;
  let state = createInitialHospitalMissionState();
  let legacyState = adaptHospitalMissionToThemeMissionState(state);
  assert.deepEqual(legacyState, {
    definitionId: legacy.id,
    stage: "preparation",
    completedObjectiveIds: [],
    exitUnlocked: false,
  });
  assert.deepEqual(
    availableThemeObjectiveIds(legacy, legacyState),
    legacy.objectives.slice(0, 2).map(({ id }) => id),
  );

  let tick = 0;
  const apply = (command) => {
    const previous = state;
    state = stepHospitalBranchingMission(definition, state, command).state;
    const projection = adaptHospitalMissionTransitionToThemeMission(
      previous,
      state,
    );
    legacyState = projection.state;
    const snapshot = ghost.update({
      tick: tick++,
      routeProgress: 0,
      events: projection.ghostEvents,
    });
    return { projection, snapshot };
  };

  apply({ type: "select-plan", planId: quiet.id });
  apply({
    type: "attempt-objective",
    objectiveId: quiet.objectiveIds[0],
    outcome: "completed",
  });
  assert.deepEqual(
    legacyState.completedObjectiveIds,
    [legacy.objectives[0].id],
  );

  apply({ type: "select-plan", planId: risky.id });
  const duplicateGuard = apply({
    type: "attempt-objective",
    objectiveId: risky.objectiveIds[0],
    outcome: "completed",
  });
  assert.deepEqual(duplicateGuard.projection.events, []);

  apply({
    type: "attempt-objective",
    objectiveId: risky.objectiveIds[1],
    outcome: "completed",
  });
  assert.equal(legacyState.stage, "escape-unlock");

  const completed = apply({
    type: "attempt-objective",
    objectiveId: risky.objectiveIds[2],
    outcome: "completed",
  });
  assert.equal(legacyState.stage, "complete");
  assert.equal(legacyState.exitUnlocked, true);
  assert.deepEqual(
    completed.projection.events.map(({ type }) => type),
    ["objective-completed", "exit-unlocked", "stage-changed"],
  );
  assert.equal(completed.snapshot.exitUnlocked, true);
});

test("commitment windows resolve on the same authoritative tick at common frame rates", () => {
  const fixedStepSeconds = 1 / 60;
  for (const objective of definition.objectives) {
    const window = hospitalMissionCommitmentWindow(
      7,
      objective.cost.commitmentSeconds,
      fixedStepSeconds,
    );
    assert.equal(window.durationTicks % 2, 0);
    assert.ok(
      window.durationSeconds >= objective.cost.commitmentSeconds - 1e-9,
    );
    assert.ok(
      window.durationSeconds - objective.cost.commitmentSeconds
        <= 1 / 30 + 1e-9,
    );
    for (const renderRate of [30, 60, 120, 144]) {
      let accumulatorSeconds = 0;
      let tick = 7;
      let observedCompletionTick = null;
      for (let frame = 0; frame < 2_000; frame += 1) {
        if (tick >= window.completesAtTick) {
          observedCompletionTick = tick;
          break;
        }
        accumulatorSeconds += 1 / renderRate;
        while (accumulatorSeconds + 1e-12 >= fixedStepSeconds) {
          tick += 1;
          accumulatorSeconds -= fixedStepSeconds;
        }
      }
      assert.equal(observedCompletionTick, window.completesAtTick);
    }
  }
});

test("authored exposure is an exact end-weighted fixed-step window", () => {
  const fixedStepSeconds = 1 / 60;
  for (const objective of definition.objectives) {
    const commitment = hospitalMissionCommitmentWindow(
      120,
      objective.cost.commitmentSeconds,
      fixedStepSeconds,
    );
    const exposure = hospitalMissionExposureWindow(
      commitment,
      objective.cost.exposureSeconds,
      fixedStepSeconds,
    );
    assert.ok(exposure);
    assert.ok(exposure.startsAtTick >= commitment.startedAtTick);
    assert.ok(exposure.endsAtTick >= commitment.completesAtTick);
    assert.equal(
      exposure.durationTicks,
      Math.ceil(
        (objective.cost.exposureSeconds - 1e-9) / fixedStepSeconds,
      ),
    );
    assert.ok(
      exposure.durationSeconds >= objective.cost.exposureSeconds - 1e-9,
    );
    const activeTicks = Array.from(
      { length: exposure.durationTicks + 2 },
      (_, index) => exposure.startsAtTick + index,
    ).filter((tick) => hospitalMissionExposureActiveAtTick(exposure, tick));
    assert.equal(activeTicks.length, exposure.durationTicks);
    assert.equal(activeTicks[0], exposure.startsAtTick + 1);
    assert.equal(activeTicks.at(-1), exposure.endsAtTick);
    if (
      objective.cost.exposureSeconds
      <= objective.cost.commitmentSeconds
    ) {
      assert.equal(exposure.endsAtTick, commitment.completesAtTick);
    } else {
      assert.equal(exposure.startsAtTick, commitment.startedAtTick);
      assert.ok(exposure.endsAtTick > commitment.completesAtTick);
    }
  }
  const commitment = hospitalMissionCommitmentWindow(0, 1, fixedStepSeconds);
  assert.equal(
    hospitalMissionExposureWindow(commitment, 0, fixedStepSeconds),
    null,
  );
  assert.throws(
    () => hospitalMissionExposureActiveAtTick(
      {
        startsAtTick: 0,
        durationTicks: 1,
        endsAtTick: 1,
        durationSeconds: fixedStepSeconds,
      },
      -1,
    ),
    /non-negative integer/u,
  );
  assert.throws(
    () => hospitalMissionExposureWindow(
      commitment,
      Number.NaN,
      fixedStepSeconds,
    ),
    /finite and non-negative/,
  );
});

test("same hospital command stream has stable state, events, and replay fingerprint", () => {
  const plan = definition.plans[0];
  const commands = [
    { type: "select-plan", planId: plan.id },
    {
      type: "attempt-objective",
      objectiveId: plan.objectiveIds[0],
      outcome: "cancelled",
    },
    ...plan.objectiveIds.map((objectiveId) => ({
      type: "attempt-objective",
      objectiveId,
      outcome: "completed",
    })),
    { type: "escape", exitId: plan.exitId },
  ];
  const first = replayHospitalMission(commands);
  const second = replayHospitalMission(
    commands.map((command) => ({ ...command })),
  );
  assert.deepEqual(first, second);
  assert.match(first.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(first.state.status, "escaped");
});

test("definition validation rejects unsafe objectives and dishonest cost promises", () => {
  const unsafe = {
    ...definition,
    objectives: definition.objectives.map((objective, index) => index === 0
      ? {
          ...objective,
          safety: {
            retryable: true,
            consumesRequiredResource: false,
            closesRequiredRoute: true,
          },
        }
      : objective),
  };
  assert.throws(
    () => validateHospitalBranchingMissionDefinition(unsafe),
    /softlock safety contract/,
  );

  const noisyQuietRoute = {
    ...definition,
    objectives: definition.objectives.map((objective) => (
      objective.planId === "pharmacy-authorization"
      ? {
          ...objective,
          cost: { ...objective.cost, noiseStrength: 1 },
        }
      : objective
    )),
  };
  assert.throws(
    () => validateHospitalBranchingMissionDefinition(noisyQuietRoute),
    /less total public noise/,
  );
});

test("hospital loadout offers four optional tools and defaults to mirror plus blackout", () => {
  assert.doesNotThrow(
    () => validateHospitalToolLoadoutContract(HOSPITAL_TOOL_LOADOUT),
  );
  assert.equal(HOSPITAL_TOOL_LOADOUT.selectionPhase, "pre-run");
  assert.equal(HOSPITAL_TOOL_LOADOUT.slotCount, 2);
  assert.deepEqual(
    HOSPITAL_TOOL_LOADOUT.tools.map(({ id }) => id),
    [
      "door-wedge",
      "corner-mirror",
      "temporary-blackout",
      "evidence-erasure",
    ],
  );
  assert.ok(
    HOSPITAL_TOOL_LOADOUT.tools.every(
      ({ missionCritical }) => missionCritical === false,
    ),
  );
  assert.deepEqual(
    HOSPITAL_TOOL_LOADOUT.tools.find(
      ({ id }) => id === "evidence-erasure",
    ).runtimeBinding,
    { system: "stealth-evidence", command: "erase" },
  );

  const defaults = createHospitalToolLoadoutSelection();
  assert.deepEqual(
    defaults.selectedToolIds,
    ["corner-mirror", "temporary-blackout"],
  );
  assert.equal(defaults.usesRecommendedLoadout, true);
});

test("every distinct two-of-four hospital loadout is legal; malformed picks are rejected", () => {
  const ids = HOSPITAL_TOOL_LOADOUT.tools.map(({ id }) => id);
  let combinations = 0;
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const selection = createHospitalToolLoadoutSelection([
        ids[left],
        ids[right],
      ]);
      assert.deepEqual(selection.selectedToolIds, [ids[left], ids[right]]);
      combinations += 1;
    }
  }
  assert.equal(combinations, 6);
  assert.throws(
    () => createHospitalToolLoadoutSelection(["corner-mirror"]),
    /exactly two/,
  );
  assert.throws(
    () => createHospitalToolLoadoutSelection([
      "corner-mirror",
      "corner-mirror",
    ]),
    /distinct/,
  );
  assert.throws(
    () => createHospitalToolLoadoutSelection([
      "corner-mirror",
      "unknown-tool",
    ]),
    /unknown tool/,
  );
  assert.throws(
    () => createHospitalToolLoadoutSelection([
      "door-wedge",
      "corner-mirror",
      "temporary-blackout",
    ]),
    /exactly two/,
  );
});
