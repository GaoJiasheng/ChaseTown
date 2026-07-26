import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS } from "../app/game/campaign.ts";
import { GhostRuleProgressTracker } from "../app/game/ghost-race.ts";
import {
  adaptLibraryMissionToThemeMissionState,
  adaptLibraryMissionTransitionToThemeMission,
  auditLibraryMissionSoftlocks,
  availableLibraryExitIds,
  availableLibraryObjectiveIds,
  createInitialLibraryMissionState,
  libraryMissionCommitmentWindow,
  LIBRARY_BRANCHING_MISSION,
  LIBRARY_BRANCHING_MISSION_TOPOLOGY,
  LIBRARY_MISSION_INTERACTION_EXCLUSION_CELLS,
  replayLibraryMission,
  stepLibraryBranchingMission,
  validateLibraryBranchingMissionDefinition,
} from "../app/game/library-branching-mission.ts";
import {
  availableThemeObjectiveIds,
  THEME_MISSION_DEFINITIONS,
} from "../app/game/theme-objectives.ts";

const definition = LIBRARY_BRANCHING_MISSION;
const libraryLevel = CAMPAIGN_LEVELS.find(({ id }) => id === definition.levelId);

function selectPlan(state, planId) {
  return stepLibraryBranchingMission(definition, state, {
    type: "select-plan",
    planId,
  });
}

function completeObjective(state, objectiveId) {
  return stepLibraryBranchingMission(definition, state, {
    type: "attempt-objective",
    objectiveId,
    outcome: "completed",
  });
}

function completePlan(state, planId) {
  let step = state.activePlanId === planId
    ? {
        state,
        events: [],
        availableObjectiveIds: availableLibraryObjectiveIds(definition, state),
        availableExitIds: availableLibraryExitIds(definition, state),
      }
    : selectPlan(state, planId);
  const events = [...step.events];
  while (!step.state.unlockedExitIds.includes(
    definition.plans.find(({ id }) => id === planId).exitId,
  )) {
    assert.equal(step.availableObjectiveIds.length, 1);
    step = completeObjective(step.state, step.availableObjectiveIds[0]);
    events.push(...step.events);
  }
  return { ...step, events };
}

test("library G2 contract has two distinct preparation paths and independently owned exits", () => {
  assert.doesNotThrow(() => validateLibraryBranchingMissionDefinition(definition));
  assert.equal(definition.levelId, "campus-library-lockdown");
  assert.equal(definition.plans.length, 2);
  assert.equal(definition.exits.length, 2);

  const [access, fire] = definition.plans;
  assert.notDeepEqual(access.preparationObjectiveIds, fire.preparationObjectiveIds);
  assert.equal(
    access.preparationObjectiveIds.some((id) => fire.preparationObjectiveIds.includes(id)),
    false,
  );
  assert.notEqual(access.exitId, fire.exitId);
  for (const plan of definition.plans) {
    const exit = definition.exits.find(({ id }) => id === plan.exitId);
    const unlock = definition.objectives.find(({ id }) => id === plan.unlockObjectiveId);
    assert.equal(exit.planId, plan.id);
    assert.equal(exit.unlockObjectiveId, plan.unlockObjectiveId);
    assert.equal(unlock.planId, plan.id);
    assert.equal(unlock.unlocksExitId, exit.id);
    assert.equal(unlock.kind, "exit-unlock");
    assert.deepEqual(unlock.safety, {
      retryable: true,
      consumesRequiredResource: false,
      closesRequiredRoute: false,
    });
  }
});

test("each plan can finish alone and unlocks only its own exit", () => {
  for (const plan of definition.plans) {
    const otherExit = definition.exits.find(({ id }) => id !== plan.exitId);
    const completed = completePlan(createInitialLibraryMissionState(), plan.id);

    assert.equal(completed.state.status, "exit-ready");
    assert.deepEqual(completed.state.unlockedExitIds, [plan.exitId]);
    assert.deepEqual(completed.availableExitIds, [plan.exitId]);
    assert.equal(completed.state.completedObjectiveIds.length, plan.objectiveIds.length);
    assert.ok(plan.objectiveIds.every((id) => completed.state.completedObjectiveIds.includes(id)));
    assert.equal(
      completed.events.some((event) => (
        event.type === "exit-unlocked"
        && event.exitId === plan.exitId
      )),
      true,
    );

    const locked = stepLibraryBranchingMission(definition, completed.state, {
      type: "escape",
      exitId: otherExit.id,
    });
    assert.equal(locked.state, completed.state);
    assert.equal(locked.events[0].type, "command-rejected");
    assert.equal(locked.events[0].reason, "exit-locked");
    assert.deepEqual(locked.availableExitIds, [plan.exitId]);

    const escaped = stepLibraryBranchingMission(definition, completed.state, {
      type: "escape",
      exitId: plan.exitId,
    });
    assert.equal(escaped.state.status, "escaped");
    assert.equal(escaped.state.escapedViaExitId, plan.exitId);
    assert.deepEqual(escaped.availableExitIds, []);
    assert.equal(escaped.events[0].type, "mission-completed");
    assert.equal(escaped.events[0].planId, plan.id);
  }
});

test("failed interactions are retryable and preserve all mission progress", () => {
  const plan = definition.plans[0];
  let step = selectPlan(createInitialLibraryMissionState(), plan.id);
  const objectiveId = step.availableObjectiveIds[0];
  const beforeFailure = step.state;

  step = stepLibraryBranchingMission(definition, step.state, {
    type: "attempt-objective",
    objectiveId,
    outcome: "interrupted",
  });
  assert.deepEqual(step.state.completedObjectiveIds, beforeFailure.completedObjectiveIds);
  assert.deepEqual(step.state.unlockedExitIds, beforeFailure.unlockedExitIds);
  assert.deepEqual(step.state.failedAttempts, [{ objectiveId, count: 1 }]);
  assert.deepEqual(step.availableObjectiveIds, [objectiveId]);
  assert.deepEqual(step.events[0], {
    type: "objective-attempt-failed",
    objectiveId,
    planId: plan.id,
    reason: "interrupted",
    retryable: true,
  });

  step = stepLibraryBranchingMission(definition, step.state, {
    type: "attempt-objective",
    objectiveId,
    outcome: "cancelled",
  });
  assert.deepEqual(step.state.failedAttempts, [{ objectiveId, count: 2 }]);
  assert.deepEqual(step.availableObjectiveIds, [objectiveId]);

  step = completeObjective(step.state, objectiveId);
  assert.ok(step.state.completedObjectiveIds.includes(objectiveId));
  assert.deepEqual(step.state.failedAttempts, [{ objectiveId, count: 2 }]);
  assert.equal(step.events[0].type, "objective-completed");
});

test("switching plans retains partial progress and can ultimately unlock both exits", () => {
  const [access, fire] = definition.plans;
  let step = selectPlan(createInitialLibraryMissionState(), access.id);
  step = completeObjective(step.state, access.objectiveIds[0]);
  const retainedAccessObjective = access.objectiveIds[0];

  const inactive = completeObjective(step.state, fire.objectiveIds[0]);
  assert.equal(inactive.state, step.state);
  assert.equal(inactive.events[0].type, "command-rejected");
  assert.equal(inactive.events[0].reason, "inactive-plan");
  assert.deepEqual(inactive.availableObjectiveIds, [access.objectiveIds[1]]);

  step = selectPlan(step.state, fire.id);
  assert.equal(step.events[0].type, "plan-switched");
  assert.deepEqual(step.events[0].retainedObjectiveIds, [retainedAccessObjective]);
  assert.ok(step.state.completedObjectiveIds.includes(retainedAccessObjective));

  step = completePlan(step.state, fire.id);
  assert.deepEqual(step.state.unlockedExitIds, [fire.exitId]);
  assert.ok(step.state.completedObjectiveIds.includes(retainedAccessObjective));

  step = selectPlan(step.state, access.id);
  assert.deepEqual(step.events[0].retainedExitIds, [fire.exitId]);
  step = completePlan(step.state, access.id);
  assert.deepEqual(
    new Set(step.state.unlockedExitIds),
    new Set([access.exitId, fire.exitId]),
  );
  assert.equal(step.state.completedObjectiveIds.length, definition.objectives.length);
});

test("prerequisites, explicit route selection, and post-escape completion are enforced", () => {
  const access = definition.plans[0];
  const initial = createInitialLibraryMissionState();
  const noPlan = completeObjective(initial, access.objectiveIds[0]);
  assert.equal(noPlan.events[0].reason, "plan-not-selected");
  assert.equal(noPlan.state, initial);

  let step = selectPlan(initial, access.id);
  const premature = completeObjective(step.state, access.objectiveIds[1]);
  assert.equal(premature.events[0].reason, "prerequisite-missing");
  assert.equal(premature.state, step.state);
  assert.deepEqual(premature.availableObjectiveIds, [access.objectiveIds[0]]);

  step = completePlan(step.state, access.id);
  step = stepLibraryBranchingMission(definition, step.state, {
    type: "escape",
    exitId: access.exitId,
  });
  const afterEscape = selectPlan(step.state, definition.plans[1].id);
  assert.equal(afterEscape.state, step.state);
  assert.equal(afterEscape.events[0].reason, "mission-complete");
});

test("softlock audit proves both routes and every switch prefix on the authored maze", () => {
  assert.ok(libraryLevel);
  const audit = auditLibraryMissionSoftlocks(libraryLevel);
  assert.equal(audit.passed, true, audit.failures.join("; "));
  assert.equal(audit.plans.length, 2);
  assert.ok(audit.plans.every(({ reachable, routeDistanceCells }) => (
    reachable && routeDistanceCells > 0
  )));
  assert.equal(
    audit.switches.length,
    definition.plans.reduce((total, plan) => total + plan.objectiveIds.length + 1, 0),
  );
  assert.ok(audit.switches.every(({ reachable }) => reachable));
  assert.ok(audit.switches.some(({ completedPrefixLength }) => completedPrefixLength === 3));
  for (const placement of LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements) {
    for (const hideSpot of libraryLevel.hideSpots) {
      assert.ok(
        Math.hypot(
          placement.position.x - hideSpot.approach.x,
          placement.position.y - hideSpot.approach.y,
        ) >= LIBRARY_MISSION_INTERACTION_EXCLUSION_CELLS,
        `${placement.objectiveId} overlaps ${hideSpot.id}`,
      );
    }
  }
});

test("mission commitments resolve on the same authoritative tick at 30/60/120/144 Hz", () => {
  const fixedStepSeconds = 1 / 60;
  for (const objective of definition.objectives) {
    const window = libraryMissionCommitmentWindow(
      0,
      objective.commitmentSeconds,
      fixedStepSeconds,
    );
    assert.equal(window.durationTicks % 2, 0);
    assert.ok(window.durationSeconds >= objective.commitmentSeconds - 1e-9);
    assert.ok(
      window.durationSeconds - objective.commitmentSeconds
        <= 1 / 30 + 1e-9,
    );

    for (const renderRate of [30, 60, 120, 144]) {
      let accumulatorSeconds = 0;
      let tick = 0;
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
      assert.equal(
        observedCompletionTick,
        window.completesAtTick,
        `${objective.id} completed on a different tick at ${renderRate} Hz`,
      );
    }
  }
});

test("softlock audit rejects unsafe objectives and blocked authoring anchors", () => {
  const unsafe = {
    ...definition,
    objectives: definition.objectives.map((item, index) => index === 0
      ? {
          ...item,
          safety: {
            retryable: true,
            consumesRequiredResource: false,
            closesRequiredRoute: true,
          },
        }
      : item),
  };
  assert.throws(
    () => validateLibraryBranchingMissionDefinition(unsafe),
    /softlock safety contract/,
  );
  const unsafeAudit = auditLibraryMissionSoftlocks(
    libraryLevel,
    unsafe,
    LIBRARY_BRANCHING_MISSION_TOPOLOGY,
  );
  assert.equal(unsafeAudit.passed, false);
  assert.ok(unsafeAudit.failures.some((failure) => failure.includes("softlock safety")));

  const blocked = {
    ...libraryLevel,
    walkable: libraryLevel.walkable.map((row, y) => row.map((cell, x) => (
      x === LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements[0].position.x
        && y === LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements[0].position.y
        ? false
        : cell
    ))),
  };
  const blockedAudit = auditLibraryMissionSoftlocks(blocked);
  assert.equal(blockedAudit.passed, false);
  assert.ok(blockedAudit.failures.some((failure) => (
    failure.includes("not on a walkable cell")
    || failure.includes("Unreachable leg")
  )));

  const overlapping = {
    ...LIBRARY_BRANCHING_MISSION_TOPOLOGY,
    objectivePlacements: LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements.map(
      (placement, index) => index === 0
        ? {
            ...placement,
            position: { ...libraryLevel.hideSpots[1].approach },
          }
        : placement,
    ),
  };
  const overlappingAudit = auditLibraryMissionSoftlocks(
    libraryLevel,
    definition,
    overlapping,
  );
  assert.equal(overlappingAudit.passed, false);
  assert.ok(overlappingAudit.failures.some((failure) => (
    failure.includes("overlaps hide interaction")
  )));
});

test("same command stream produces byte-stable state, events, and fingerprint", () => {
  const access = definition.plans[0];
  const commands = [
    { type: "select-plan", planId: access.id },
    {
      type: "attempt-objective",
      objectiveId: access.objectiveIds[0],
      outcome: "interrupted",
    },
    ...access.objectiveIds.map((objectiveId) => ({
      type: "attempt-objective",
      objectiveId,
      outcome: "completed",
    })),
    { type: "escape", exitId: access.exitId },
  ];
  const first = replayLibraryMission(commands);
  const second = replayLibraryMission(commands.map((command) => ({ ...command })));
  assert.deepEqual(first, second);
  assert.match(first.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(first.state.status, "escaped");
});

test("each G2 route feeds its actual objective IDs to the runtime Ghost tracker", () => {
  for (const plan of definition.plans) {
    let state = selectPlan(createInitialLibraryMissionState(), plan.id).state;
    const ghost = new GhostRuleProgressTracker(plan.objectiveIds);
    let snapshot = ghost.update({
      tick: 0,
      routeProgress: 0,
    });

    for (const [index, objectiveId] of plan.objectiveIds.entries()) {
      const missionStep = completeObjective(state, objectiveId);
      state = missionStep.state;
      const ghostEvents = missionStep.events.flatMap((event) => (
        event.type === "objective-completed" || event.type === "exit-unlocked"
          ? [{
              type: event.type,
              objectiveId: event.objectiveId,
            }]
          : []
      ));
      snapshot = ghost.update({
        tick: index + 1,
        routeProgress: 0,
        events: ghostEvents,
      });
    }

    assert.deepEqual(snapshot.completedObjectiveIds, plan.objectiveIds);
    assert.equal(snapshot.exitUnlocked, true);
  }
});

test("legacy ThemeMissionState and ghost projection stay monotonic across switches", () => {
  const legacy = THEME_MISSION_DEFINITIONS.campus;
  const ghost = new GhostRuleProgressTracker(legacy.objectives.map(({ id }) => id));
  const [access, fire] = definition.plans;
  let state = createInitialLibraryMissionState();
  let legacyState = adaptLibraryMissionToThemeMissionState(state);
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
    state = stepLibraryBranchingMission(definition, state, command).state;
    const projection = adaptLibraryMissionTransitionToThemeMission(previous, state);
    legacyState = projection.state;
    const snapshot = ghost.update({
      tick: tick++,
      routeProgress: 0,
      events: projection.ghostEvents,
    });
    return { projection, snapshot };
  };

  apply({ type: "select-plan", planId: access.id });
  let result = apply({
    type: "attempt-objective",
    objectiveId: access.objectiveIds[0],
    outcome: "completed",
  });
  assert.equal(result.projection.events[0].type, "objective-completed");
  assert.deepEqual(
    legacyState.completedObjectiveIds,
    [legacy.objectives[0].id],
  );

  apply({ type: "select-plan", planId: fire.id });
  result = apply({
    type: "attempt-objective",
    objectiveId: fire.objectiveIds[0],
    outcome: "completed",
  });
  assert.deepEqual(result.projection.events, [], "switch duplicated a legacy milestone");
  result = apply({
    type: "attempt-objective",
    objectiveId: fire.objectiveIds[1],
    outcome: "completed",
  });
  assert.equal(legacyState.stage, "escape-unlock");
  assert.deepEqual(
    legacyState.completedObjectiveIds,
    legacy.objectives.slice(0, 2).map(({ id }) => id),
  );

  result = apply({
    type: "attempt-objective",
    objectiveId: fire.objectiveIds[2],
    outcome: "completed",
  });
  assert.equal(legacyState.stage, "complete");
  assert.equal(legacyState.exitUnlocked, true);
  assert.deepEqual(
    result.projection.events.map(({ type }) => type),
    ["objective-completed", "exit-unlocked", "stage-changed"],
  );
  assert.equal(result.snapshot.exitUnlocked, true);
  assert.deepEqual(
    result.snapshot.completedObjectiveIds,
    legacy.objectives.map(({ id }) => id),
  );
});
