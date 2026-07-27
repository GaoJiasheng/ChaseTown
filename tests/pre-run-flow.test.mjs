import assert from "node:assert/strict";
import test from "node:test";

import { createCampaignProgress } from "../app/game/campaign-progress.ts";
import {
  LAST_RUN_SETUP_KEY,
  LAST_RUN_SETUP_VERSION,
  PRE_RUN_STEPS,
  canAdvancePreRunFlow,
  canGoBackPreRunFlow,
  createPreRunFlowState,
  isPreRunFlowState,
  isPreRunStep,
  loadLastRunSetup,
  preRunFlowReducer,
  sanitizeLastRunSetup,
  saveLastRunSetup,
} from "../app/game/pre-run-flow.ts";

const LEVEL_IDS = Object.freeze([
  "campus-opening",
  "campus-library",
  "hospital-outpatient",
  "factory-final",
]);

function progress({
  standard = 1,
  assisted = 1,
} = {}) {
  return {
    ...createCampaignProgress(),
    unlockedThrough: standard,
    assistedUnlockedThrough: assisted,
  };
}

function context({
  standard = 4,
  assisted = 4,
  levelIds = LEVEL_IDS,
} = {}) {
  return {
    levelIds,
    progress: progress({ standard, assisted }),
  };
}

function validSetup(overrides = {}) {
  return {
    version: LAST_RUN_SETUP_VERSION,
    levelId: LEVEL_IDS[2],
    remixVariant: null,
    ruleset: "standard",
    libraryPlanId: "access-authorization",
    hospitalPlanId: "pharmacy-authorization",
    hospitalToolIds: ["corner-mirror", "temporary-blackout"],
    ...overrides,
  };
}

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

test("pre-run reducer advances chapter to strategy to briefing without skipping", () => {
  assert.deepEqual(PRE_RUN_STEPS, ["chapter", "strategy", "briefing"]);
  let state = createPreRunFlowState();
  assert.equal(state.step, "chapter");
  assert.equal(canAdvancePreRunFlow(state), true);
  assert.equal(canGoBackPreRunFlow(state), false);
  assert.equal(Object.isFrozen(state), true);

  state = preRunFlowReducer(state, { type: "next" });
  assert.equal(state.step, "strategy");
  assert.equal(canAdvancePreRunFlow(state), true);
  assert.equal(canGoBackPreRunFlow(state), true);

  state = preRunFlowReducer(state, { type: "next" });
  assert.equal(state.step, "briefing");
  assert.equal(canAdvancePreRunFlow(state), false);
  assert.equal(canGoBackPreRunFlow(state), true);

  const boundary = preRunFlowReducer(state, { type: "next" });
  assert.equal(boundary, state, "duplicate NEXT must be an identity no-op");
});

test("BACK walks one step at a time and reset always returns to chapter", () => {
  let state = createPreRunFlowState("briefing");
  state = preRunFlowReducer(state, { type: "back" });
  assert.equal(state.step, "strategy");
  state = preRunFlowReducer(state, { type: "back" });
  assert.equal(state.step, "chapter");
  assert.equal(
    preRunFlowReducer(state, { type: "back" }),
    state,
    "duplicate BACK must be an identity no-op",
  );

  state = createPreRunFlowState("briefing");
  state = preRunFlowReducer(state, { type: "reset" });
  assert.equal(state.step, "chapter");
});

test("flow guards reject foreign states and reducer safely repairs them", () => {
  for (const step of PRE_RUN_STEPS) {
    assert.equal(isPreRunStep(step), true);
    assert.equal(isPreRunFlowState({ step }), true);
  }
  assert.equal(isPreRunStep("playing"), false);
  assert.equal(isPreRunFlowState(null), false);
  assert.equal(isPreRunFlowState({ step: "playing" }), false);
  assert.equal(isPreRunFlowState([]), false);
  assert.deepEqual(createPreRunFlowState("playing"), { step: "chapter" });
  assert.deepEqual(
    preRunFlowReducer({ step: "foreign" }, { type: "next" }),
    createPreRunFlowState(),
  );
});

test("last-run setup accepts every certified remix and both rulesets", () => {
  for (const remixVariant of [null, 0, 1, 2]) {
    for (const ruleset of ["standard", "assisted"]) {
      const sanitized = sanitizeLastRunSetup(
        validSetup({ remixVariant, ruleset }),
        context(),
      );
      assert.ok(sanitized);
      assert.equal(sanitized.remixVariant, remixVariant);
      assert.equal(sanitized.ruleset, ruleset);
      assert.equal(Object.isFrozen(sanitized), true);
      assert.equal(Object.isFrozen(sanitized.hospitalToolIds), true);
    }
  }
});

test("last-run setup enforces unlocks independently in Standard and Assisted", () => {
  const laneContext = context({ standard: 2, assisted: 3 });
  assert.equal(
    sanitizeLastRunSetup(
      validSetup({ levelId: LEVEL_IDS[2], ruleset: "standard" }),
      laneContext,
    ),
    null,
  );
  assert.ok(sanitizeLastRunSetup(
    validSetup({ levelId: LEVEL_IDS[2], ruleset: "assisted" }),
    laneContext,
  ));
  assert.equal(
    sanitizeLastRunSetup(
      validSetup({ levelId: "foreign-level" }),
      context(),
    ),
    null,
  );
  assert.equal(
    sanitizeLastRunSetup(validSetup(), context({ levelIds: [] })),
    null,
  );
});

test("last-run setup accepts both authored library and hospital plans", () => {
  for (const libraryPlanId of ["access-authorization", "fire-release"]) {
    for (const hospitalPlanId of [
      "pharmacy-authorization",
      "emergency-maintenance",
    ]) {
      const sanitized = sanitizeLastRunSetup(
        validSetup({ libraryPlanId, hospitalPlanId }),
        context(),
      );
      assert.ok(sanitized);
      assert.equal(sanitized.libraryPlanId, libraryPlanId);
      assert.equal(sanitized.hospitalPlanId, hospitalPlanId);
    }
  }
  assert.equal(
    sanitizeLastRunSetup(
      validSetup({ libraryPlanId: "shortcut" }),
      context(),
    ),
    null,
  );
  assert.equal(
    sanitizeLastRunSetup(
      validSetup({ hospitalPlanId: "shortcut" }),
      context(),
    ),
    null,
  );
});

test("every distinct two-of-four hospital loadout is legal and order survives", () => {
  const tools = [
    "door-wedge",
    "corner-mirror",
    "temporary-blackout",
    "evidence-erasure",
  ];
  let legalPairs = 0;
  for (let first = 0; first < tools.length; first += 1) {
    for (let second = first + 1; second < tools.length; second += 1) {
      const hospitalToolIds = [tools[second], tools[first]];
      const sanitized = sanitizeLastRunSetup(
        validSetup({ hospitalToolIds }),
        context(),
      );
      assert.ok(sanitized);
      assert.deepEqual(sanitized.hospitalToolIds, hospitalToolIds);
      legalPairs += 1;
    }
  }
  assert.equal(legalPairs, 6);

  for (const hospitalToolIds of [
    ["door-wedge"],
    ["door-wedge", "door-wedge"],
    ["door-wedge", "corner-mirror", "temporary-blackout"],
    ["door-wedge", "foreign-tool"],
    "door-wedge,corner-mirror",
  ]) {
    assert.equal(
      sanitizeLastRunSetup(validSetup({ hospitalToolIds }), context()),
      null,
    );
  }
});

test("version, remix, ruleset, and required fields reject dirty records", () => {
  for (const setup of [
    null,
    [],
    {},
    validSetup({ version: 0 }),
    validSetup({ remixVariant: -1 }),
    validSetup({ remixVariant: 3 }),
    validSetup({ remixVariant: "1" }),
    validSetup({ ruleset: "ranked" }),
    { ...validSetup(), remixVariant: undefined },
  ]) {
    assert.equal(sanitizeLastRunSetup(setup, context()), null);
  }
});

test("load and save round-trip one canonical versioned setup", () => {
  const storage = new MemoryStorage();
  const setup = {
    ...validSetup({ remixVariant: 2 }),
    ignoredForeignField: "not persisted",
  };
  assert.equal(saveLastRunSetup(storage, setup, context()), true);
  const serialized = storage.getItem(LAST_RUN_SETUP_KEY);
  assert.ok(serialized);
  assert.equal(JSON.parse(serialized).ignoredForeignField, undefined);

  const loaded = loadLastRunSetup(storage, context());
  assert.deepEqual(loaded, validSetup({ remixVariant: 2 }));
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.hospitalToolIds), true);
});

test("unavailable, throwing, malformed, and locked storage fail closed", () => {
  assert.equal(loadLastRunSetup(null, context()), null);
  assert.equal(saveLastRunSetup(undefined, validSetup(), context()), false);

  const throwingStorage = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("storage disabled");
    },
  };
  assert.equal(loadLastRunSetup(throwingStorage, context()), null);
  assert.equal(
    saveLastRunSetup(throwingStorage, validSetup(), context()),
    false,
  );

  const malformedStorage = new MemoryStorage();
  malformedStorage.setItem(LAST_RUN_SETUP_KEY, "{not-json");
  assert.equal(loadLastRunSetup(malformedStorage, context()), null);

  const dirtyStorage = new MemoryStorage();
  dirtyStorage.setItem(
    LAST_RUN_SETUP_KEY,
    JSON.stringify(validSetup({ hospitalToolIds: ["door-wedge", "door-wedge"] })),
  );
  assert.equal(loadLastRunSetup(dirtyStorage, context()), null);

  const lockedStorage = new MemoryStorage();
  assert.equal(
    saveLastRunSetup(
      lockedStorage,
      validSetup({ levelId: LEVEL_IDS[3] }),
      context({ standard: 3 }),
    ),
    false,
  );
  assert.equal(lockedStorage.getItem(LAST_RUN_SETUP_KEY), null);
});
