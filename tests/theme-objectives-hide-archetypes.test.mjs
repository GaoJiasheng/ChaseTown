import assert from "node:assert/strict";
import test from "node:test";

import {
  auditHideArchetypeBindings,
  HIDE_AI_FAIRNESS_CONTRACT,
  HIDE_ARCHETYPE_PROFILES,
  hideExitOptions,
  hideTransitionEvidence,
  queryLegalHideCandidates,
  resolveHideSpotArchetype,
} from "../app/game/hide-archetypes.ts";
import { createLevel } from "../app/game/level.ts";
import {
  auditThemeMissionSoftlock,
  availableThemeObjectiveIds,
  createInitialThemeMissionState,
  stepThemeMission,
  THEME_MISSION_DEFINITIONS,
  validateThemeMissionDefinition,
} from "../app/game/theme-objectives.ts";

const openLevel = createLevel({
  id: "mission-and-hide-contract",
  width: 9,
  height: 5,
  walkable: Array.from({ length: 5 }, () => Array(9).fill(true)),
  playerStart: { x: 0, y: 2 },
  exit: { x: 8, y: 2 },
  chaserStart: { x: 4, y: 0 },
  chaserStartHeading: { x: 0, y: 1 },
  patrol: [{ x: 4, y: 0 }],
  hideSpots: [
    {
      id: "legacy-locker",
      approach: { x: 1, y: 1 },
      concealed: { x: 0.7, y: 1 },
      facing: { x: 1, y: 0 },
    },
    {
      id: "curtain-cover",
      approach: { x: 4, y: 2 },
      concealed: { x: 4, y: 1.7 },
      facing: { x: 0, y: 1 },
    },
    {
      id: "service-passage",
      approach: { x: 6, y: 3 },
      concealed: { x: 6.3, y: 3 },
      facing: { x: -1, y: 0 },
    },
  ],
});

const hideBindings = Object.freeze([
  { hideSpotId: "curtain-cover", archetype: "soft-cover" },
  {
    hideSpotId: "service-passage",
    archetype: "traversal-hide",
    alternateExit: { x: 7, y: 3 },
  },
]);

test("four themes expose distinct two-stage objective verbs under the softlock-safe contract", () => {
  const themes = ["campus", "hospital", "fire-station", "factory"];
  const allVerbs = [];
  for (const theme of themes) {
    const definition = THEME_MISSION_DEFINITIONS[theme];
    assert.doesNotThrow(() => validateThemeMissionDefinition(definition));
    assert.equal(definition.theme, theme);
    assert.equal(definition.objectives.filter((item) => item.stage === "preparation").length, 2);
    assert.equal(definition.objectives.filter((item) => item.unlocksExit).length, 1);
    for (const item of definition.objectives) {
      assert.deepEqual(item.safety, {
        retryable: true,
        consumesRequiredResource: false,
        closesRequiredRoute: false,
      });
      assert.ok(item.label && item.interactionPrompt && item.completionHint);
      allVerbs.push(item.verb);
    }
  }
  assert.equal(new Set(allVerbs).size, allVerbs.length, "themes reused the same objective verb");
});

test("either preparation order unlocks stage two while an early final interaction is rejected", () => {
  for (const definition of Object.values(THEME_MISSION_DEFINITIONS)) {
    const preparation = definition.objectives.filter((item) => item.stage === "preparation");
    const finish = definition.exitObjectiveId;
    const run = (order) => {
      let state = createInitialThemeMissionState(definition);
      assert.deepEqual(new Set(availableThemeObjectiveIds(definition, state)), new Set(order));
      const blocked = stepThemeMission(definition, state, finish);
      assert.equal(blocked.events[0].type, "objective-rejected");
      assert.equal(blocked.events[0].reason, "prerequisite-missing");
      assert.equal(blocked.state, state);
      for (const objectiveId of order) state = stepThemeMission(definition, state, objectiveId).state;
      assert.equal(state.stage, "escape-unlock");
      assert.deepEqual(availableThemeObjectiveIds(definition, state), [finish]);
      const completed = stepThemeMission(definition, state, finish);
      assert.equal(completed.state.stage, "complete");
      assert.equal(completed.state.exitUnlocked, true);
      assert.equal(completed.events.some((event) => event.type === "exit-unlocked"), true);
      return completed.state;
    };
    const forward = run(preparation.map((item) => item.id));
    const reverse = run(preparation.map((item) => item.id).reverse());
    assert.deepEqual(
      new Set(forward.completedObjectiveIds),
      new Set(reverse.completedObjectiveIds),
      `${definition.id} is order-dependent`,
    );
  }
});

test("mission placement audit proves every legal order reaches the final control and exit", () => {
  const definition = THEME_MISSION_DEFINITIONS.campus;
  const placements = definition.objectives.map((item, index) => ({
    objectiveId: item.id,
    position: { x: 2 + index * 2, y: 2 },
  }));
  const audit = auditThemeMissionSoftlock(openLevel, definition, placements);
  assert.equal(audit.passed, true);
  assert.equal(audit.orders.length, 2);
  assert.ok(audit.orders.every((order) => order.reachable));

  const blockedLevel = createLevel({
    ...openLevel,
    id: "mission-blocked",
    walkable: openLevel.walkable.map((row, y) => row.map((cell, x) => (
      x === 2 && y === 2 ? false : cell
    ))),
  });
  const failed = auditThemeMissionSoftlock(blockedLevel, definition, placements);
  assert.equal(failed.passed, false);
  assert.ok(failed.failures.some((failure) => failure.includes("not on a walkable cell")));
});

test("mission definitions reject one-shot resources, route-closing objectives, and cycles", () => {
  const valid = THEME_MISSION_DEFINITIONS.campus;
  const unsafe = {
    ...valid,
    id: "unsafe-mission",
    objectives: valid.objectives.map((item, index) => index === 0
      ? {
          ...item,
          safety: {
            retryable: true,
            consumesRequiredResource: true,
            closesRequiredRoute: false,
          },
        }
      : item),
  };
  assert.throws(() => validateThemeMissionDefinition(unsafe), /softlock contract/);

  const cyclic = {
    ...valid,
    id: "cyclic-mission",
    objectives: valid.objectives.map((item, index) => index === 0
      ? { ...item, prerequisites: [valid.exitObjectiveId] }
      : item),
  };
  assert.throws(() => validateThemeMissionDefinition(cyclic), /Preparation stage|cycle/);
});

test("legacy hide spots remain hard lockers while explicit bindings expose three distinct risk profiles", () => {
  const legacy = resolveHideSpotArchetype(openLevel.hideSpots[0]);
  assert.equal(legacy.archetype, "hard-locker");
  assert.equal(legacy.legacyDefault, true);
  assert.equal(legacy.profile.timing.enterDurationMultiplier, 1);
  assert.equal(legacy.profile.capabilities.canPeek, true);

  const audit = auditHideArchetypeBindings(openLevel, hideBindings);
  assert.equal(audit.passed, true);
  assert.deepEqual(
    new Set(audit.resolved.map((spot) => spot.archetype)),
    new Set(["hard-locker", "soft-cover", "traversal-hide"]),
  );
  assert.equal(new Set(Object.values(HIDE_ARCHETYPE_PROFILES).map((item) => (
    `${item.risk.entry}:${item.risk.waiting}:${item.risk.search}:${item.risk.exit}`
  ))).size, 3);

  const traversal = audit.resolved.find((spot) => spot.archetype === "traversal-hide");
  assert.deepEqual(hideExitOptions(traversal).map((option) => option.kind), ["origin", "alternate"]);
  const invalid = auditHideArchetypeBindings(openLevel, [{
    hideSpotId: "service-passage",
    archetype: "traversal-hide",
  }]);
  assert.equal(invalid.passed, false);
  assert.ok(invalid.failures.some((failure) => failure.includes("requires an alternate exit")));
});

test("hide transition evidence exposes authored risk but never grants an exact AI locker identity", () => {
  const audit = auditHideArchetypeBindings(openLevel, hideBindings);
  const hard = audit.resolved.find((spot) => spot.archetype === "hard-locker");
  const soft = audit.resolved.find((spot) => spot.archetype === "soft-cover");
  const traversal = audit.resolved.find((spot) => spot.archetype === "traversal-hide");
  const hardEntry = hideTransitionEvidence(hard, "enter");
  const softEntry = hideTransitionEvidence(soft, "enter");
  const alternateExit = hideTransitionEvidence(traversal, "exit-alternate");

  assert.ok(hardEntry.sound.strength > softEntry.sound.strength);
  assert.equal(hardEntry.exactHideSpotIdLegallyExposed, false);
  assert.equal(softEntry.exactHideSpotIdLegallyExposed, false);
  assert.equal(hardEntry.sound.sourceId.includes(hard.hideSpotId), false);
  assert.deepEqual(alternateExit.sound.position, traversal.alternateExit);
  assert.throws(() => hideTransitionEvidence(soft, "peek"), /does not support peeking/);
  assert.deepEqual(HIDE_AI_FAIRNESS_CONTRACT.unwitnessedRankingInputs, [
    "perceived-evidence-position",
    "public-navigation-distance",
    "public-archetype",
    "already-inspected-ids",
  ]);
});

test("AI hide queries use only public evidence and reserve exact checks for witnessed entry", () => {
  const sound = {
    kind: "sound",
    position: { x: 4, y: 2 },
    strength: 0.7,
    confidence: 0.64,
    sourceType: "hide-interaction",
    sourceId: "opaque-public-source",
    observedAtSeconds: 2,
  };
  const options = { maximumRouteDistance: 6, maximumCandidates: 3 };
  const first = queryLegalHideCandidates(openLevel, hideBindings, sound, options);
  const second = queryLegalHideCandidates(openLevel, hideBindings, sound, options);
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  assert.ok(first.every((candidate) => candidate.reason === "public-geometry" && !candidate.exact));
  assert.ok(first.every((candidate) => !Object.hasOwn(candidate, "concealed")));
  assert.ok(first.every((candidate) => !Object.hasOwn(candidate, "occupiedByPlayer")));
  assert.ok(first.every((candidate) => !Object.hasOwn(candidate, "alternateExit")));

  const witnessed = queryLegalHideCandidates(openLevel, hideBindings, {
    kind: "hide-entry-visible",
    hideSpotId: "service-passage",
    position: { x: 6, y: 3 },
    observedAtSeconds: 3,
  }, options);
  assert.equal(witnessed.length, 1);
  assert.equal(witnessed[0].hideSpotId, "service-passage");
  assert.equal(witnessed[0].reason, "witnessed-entry");
  assert.equal(witnessed[0].exact, true);
  const witnessedAgain = queryLegalHideCandidates(openLevel, hideBindings, {
    kind: "hide-entry-visible",
    hideSpotId: "service-passage",
    position: { x: 6, y: 3 },
    observedAtSeconds: 3.1,
  }, {
    ...options,
    inspectedHideSpotIds: ["service-passage"],
  });
  assert.equal(witnessedAgain[0].hideSpotId, "service-passage", "fresh witnessed entry lost to stale inspected memory");

  const inspected = queryLegalHideCandidates(openLevel, hideBindings, sound, {
    ...options,
    inspectedHideSpotIds: first.map((candidate) => candidate.hideSpotId),
  });
  assert.ok(inspected.every((candidate) => !first.some((done) => done.hideSpotId === candidate.hideSpotId)));
  assert.deepEqual(
    queryLegalHideCandidates(openLevel, hideBindings, { kind: "none", observedAtSeconds: 4 }, options),
    [],
  );
});

test("runtime-only occupancy metadata cannot influence the legal AI query", () => {
  const sound = {
    kind: "sound",
    position: { x: 4, y: 2 },
    strength: 0.8,
    observedAtSeconds: 1,
  };
  const withRuntimeSecrets = {
    ...openLevel,
    hideSpots: openLevel.hideSpots.map((spot, index) => ({
      ...spot,
      occupiedByPlayer: index === 1,
      chosenTraversalExit: index === 2 ? "alternate" : "origin",
    })),
  };
  const options = { maximumRouteDistance: 9 };
  assert.deepEqual(
    queryLegalHideCandidates(openLevel, hideBindings, sound, options),
    queryLegalHideCandidates(withRuntimeSecrets, hideBindings, sound, options),
  );
  assert.equal(queryLegalHideCandidates.length, 4);
});
