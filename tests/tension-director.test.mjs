import assert from "node:assert/strict";
import test from "node:test";

import {
  auditTensionDirectorDefinition,
  auditTensionDirectorSafety,
  createInitialTensionDirectorState,
  DEFAULT_TENSION_DIRECTOR_POLICY,
  replayTensionDirector,
  stepTensionDirector,
  tensionDirectorScore,
  tensionTierWithHysteresis,
  TENSION_DIRECTOR_VERSION,
} from "../app/game/tension-director.ts";

const fastPolicy = Object.freeze({
  ...DEFAULT_TENSION_DIRECTOR_POLICY,
  minimumWarningTicks: 2,
  maximumEventDurationTicks: 5,
  minimumEventCooldownTicks: 4,
  minimumSafeTicksBeforePressure: 3,
  minimumCalmTicksAfterEvent: 3,
  suspiciousBreatherTicks: 4,
  chaseBreatherTicks: 6,
  escapeBreatherTicks: 6,
  resourceRecoveryBreatherTicks: 4,
  criticalResourcePermille: 100,
  heightenedResourceFloorPermille: 300,
  safeRampStartTicks: 0,
  safeRampEndTicks: 10,
  safeScoreMaximum: 600,
  missionScoreMaximum: 300,
  resourceScoreMaximum: 100,
  watchfulEnterScore: 300,
  watchfulExitScore: 200,
  heightenedEnterScore: 700,
  heightenedExitScore: 500,
});

const routes = Object.freeze(["main-exit", "service-exit", "roof-exit"]);

const eventDefinitions = Object.freeze([
  Object.freeze({
    id: "public-address",
    label: "广播巡检通知",
    kind: "broadcast",
    minimumTier: "watchful",
    warningTicks: 2,
    durationTicks: 3,
    cooldownTicks: 4,
    publicChannelId: "library-speaker-bank",
    blockedRouteIds: Object.freeze([]),
    intensityPermille: 760,
  }),
  Object.freeze({
    id: "patrol-focus",
    label: "巡逻压力上调",
    kind: "patrol-pressure",
    minimumTier: "heightened",
    warningTicks: 3,
    durationTicks: 4,
    cooldownTicks: 5,
    publicChannelId: null,
    blockedRouteIds: Object.freeze([]),
    intensityPermille: 200,
  }),
  Object.freeze({
    id: "reading-room-lights",
    label: "阅览区照明降级",
    kind: "blackout",
    minimumTier: "heightened",
    warningTicks: 2,
    durationTicks: 5,
    cooldownTicks: 6,
    publicChannelId: "reading-room-lighting-circuit",
    blockedRouteIds: Object.freeze([]),
    intensityPermille: 600,
  }),
  Object.freeze({
    id: "service-fire-door",
    label: "服务通道防火门轮转",
    kind: "door-cycle",
    minimumTier: "heightened",
    warningTicks: 3,
    durationTicks: 4,
    cooldownTicks: 6,
    publicChannelId: "service-fire-door-group",
    blockedRouteIds: Object.freeze(["service-exit"]),
    intensityPermille: 900,
  }),
]);

const definition = Object.freeze({
  version: TENSION_DIRECTOR_VERSION,
  id: "library-fair-tension-director",
  routeIds: routes,
  minimumLegalRouteCount: 1,
  policy: fastPolicy,
  events: eventDefinitions,
});

function signals(tick, overrides = {}) {
  const threat = overrides.threat ?? "safe";
  return {
    tick,
    runPhase: "playing",
    threat,
    safeTicks: threat === "safe" ? tick : 0,
    chaseTicks: threat === "chased" ? 1 : 0,
    ticksSinceChaseEscape: null,
    missionProgressPermille: 1_000,
    resourcesRemainingPermille: 1_000,
    legalRouteIds: routes,
    ...overrides,
  };
}

function stepRange(
  startingState,
  firstTick,
  lastTick,
  signalForTick = (tick) => signals(tick),
) {
  let state = startingState;
  const steps = [];
  for (let tick = firstTick; tick <= lastTick; tick += 1) {
    const step = stepTensionDirector(
      definition,
      state,
      signalForTick(tick),
    );
    state = step.state;
    steps.push(step);
  }
  return { state, steps };
}

test("definition audit enforces authored public channels, bounded effects, and route safety", () => {
  const audit = auditTensionDirectorDefinition(definition);
  assert.deepEqual(audit, {
    passed: true,
    failures: [],
    routeCount: 3,
    eventCount: 4,
  });

  const routeLock = {
    ...definition,
    events: definition.events.map((event, index) => index === 3
      ? {
          ...event,
          blockedRouteIds: [...definition.routeIds],
        }
      : event),
  };
  const routeLockAudit = auditTensionDirectorDefinition(routeLock);
  assert.equal(routeLockAudit.passed, false);
  assert.ok(routeLockAudit.failures.some((failure) => (
    failure.includes("can close every required legal route")
  )));

  const overpoweredPatrol = {
    ...definition,
    events: definition.events.map((event, index) => index === 1
      ? { ...event, intensityPermille: 251 }
      : event),
  };
  assert.ok(
    auditTensionDirectorDefinition(overpoweredPatrol).failures
      .some((failure) => failure.includes("fairness cap")),
  );

  const collapsedBreather = {
    ...definition,
    policy: {
      ...definition.policy,
      minimumCalmTicksAfterEvent: 0,
    },
  };
  assert.ok(
    auditTensionDirectorDefinition(collapsedBreather).failures
      .some((failure) => failure.includes("safe window cannot collapse")),
  );
});

test("the strict signal boundary rejects private targeting and non-consecutive time", () => {
  const initial = createInitialTensionDirectorState(definition);
  assert.throws(
    () => stepTensionDirector(definition, initial, {
      ...signals(1),
      playerPosition: { x: 7, y: 17 },
    }),
    /unsupported fields: playerPosition/,
  );
  assert.throws(
    () => stepTensionDirector(definition, initial, {
      ...signals(1),
      nearestPlayerRouteId: "main-exit",
    }),
    /unsupported fields: nearestPlayerRouteId/,
  );
  assert.throws(
    () => stepTensionDirector(definition, initial, signals(2)),
    /consecutive fixed ticks; expected 1/,
  );

  const spatialTarget = {
    ...definition,
    events: definition.events.map((event, index) => index === 0
      ? {
          ...event,
          targetPosition: { x: 7, y: 17 },
        }
      : event),
  };
  const audit = auditTensionDirectorDefinition(spatialTarget);
  assert.equal(audit.passed, false);
  assert.ok(audit.failures.some((failure) => (
    failure.includes("unsupported fields: targetPosition")
  )));
});

test("an event is announced, activates, ends, and opens a global calm window on exact ticks", () => {
  const { state, steps } = stepRange(
    createInitialTensionDirectorState(definition),
    1,
    11,
  );
  const lifecycle = steps.flatMap(({ lifecycleEvents }) => lifecycleEvents);
  const suggested = lifecycle.find(({ type }) => type === "event-suggested");
  assert.ok(suggested);
  assert.equal(suggested.atTick, 3);
  assert.equal(suggested.suggestion.eventId, "public-address");
  assert.equal(suggested.suggestion.startsAtTick, 5);
  assert.equal(suggested.suggestion.endsAtTick, 8);
  assert.deepEqual(suggested.suggestion.safety, {
    sourcePolicy: "public-aggregate-signals-only",
    warningTicks: 2,
    durationTicks: 3,
    legalRouteIdsAtSuggestion: routes,
    preservedLegalRouteIds: routes,
    minimumLegalRouteCount: 1,
    routeGuarantee: true,
  });

  const activated = lifecycle.find(({ type }) => type === "event-activated");
  assert.deepEqual(activated, {
    type: "event-activated",
    atTick: 5,
    suggestionId: suggested.suggestion.suggestionId,
    eventId: "public-address",
  });
  const ended = lifecycle.find((event) => (
    event.type === "event-ended" && event.eventId === "public-address"
  ));
  assert.deepEqual(ended, {
    type: "event-ended",
    atTick: 8,
    suggestionId: suggested.suggestion.suggestionId,
    eventId: "public-address",
    reason: "completed",
  });

  assert.equal(
    steps[8].lifecycleEvents.some(({ type }) => type === "event-suggested"),
    false,
    "a second event was suggested before the global calm window ended",
  );
  const secondSuggestion = steps[10].suggestion;
  assert.ok(secondSuggestion);
  assert.equal(secondSuggestion.eventId, "patrol-focus");
  assert.equal(secondSuggestion.announcedAtTick, 11);
  assert.equal(state.completedEventCount, 1);
});

test("danger cancels a warning and the recent-escape breather cannot be skipped", () => {
  let state = createInitialTensionDirectorState(definition);
  state = stepRange(state, 1, 3).state;
  const warningId = state.activeEvent.suggestion.suggestionId;

  let step = stepTensionDirector(
    definition,
    state,
    signals(4, {
      threat: "chased",
      safeTicks: 0,
      chaseTicks: 1,
    }),
  );
  state = step.state;
  assert.deepEqual(
    step.lifecycleEvents.find(({ type }) => type === "event-cancelled"),
    {
      type: "event-cancelled",
      atTick: 4,
      suggestionId: warningId,
      eventId: "public-address",
      reason: "danger-protection",
    },
  );
  assert.equal(state.activeEvent, null);

  for (let tick = 5; tick <= 10; tick += 1) {
    step = stepTensionDirector(
      definition,
      state,
      signals(tick, {
        safeTicks: tick - 4,
        ticksSinceChaseEscape: tick - 5,
      }),
    );
    state = step.state;
    assert.equal(step.suggestion, null, `breather leaked at tick ${tick}`);
    assert.ok(
      step.suppressionReasons.includes("recent-escape")
        || step.suppressionReasons.includes("breathing-window"),
    );
  }

  step = stepTensionDirector(
    definition,
    state,
    signals(11, {
      safeTicks: 7,
      ticksSinceChaseEscape: 6,
    }),
  );
  assert.ok(step.suggestion);
  assert.equal(step.suggestion.announcedAtTick, 11);
});

test("an active effect ends on chase entry and chase duration extends recovery deterministically", () => {
  let state = stepRange(
    createInitialTensionDirectorState(definition),
    1,
    5,
  ).state;
  assert.equal(state.activeEvent.phase, "active");
  const activeSuggestionId = state.activeEvent.suggestion.suggestionId;

  let step = stepTensionDirector(
    definition,
    state,
    signals(6, {
      threat: "chased",
      safeTicks: 0,
      chaseTicks: 3,
    }),
  );
  state = step.state;
  assert.deepEqual(
    step.lifecycleEvents.find(({ type }) => type === "event-ended"),
    {
      type: "event-ended",
      atTick: 6,
      suggestionId: activeSuggestionId,
      eventId: "public-address",
      reason: "danger-protection",
    },
  );
  assert.equal(state.breatherUntilTick, 15);

  for (let tick = 7; tick < 15; tick += 1) {
    step = stepTensionDirector(
      definition,
      state,
      signals(tick, { safeTicks: tick - 6 }),
    );
    state = step.state;
    assert.equal(step.suggestion, null);
    assert.ok(step.suppressionReasons.includes("breathing-window"));
  }
  step = stepTensionDirector(
    definition,
    state,
    signals(15, { safeTicks: 9 }),
  );
  assert.ok(step.suggestion);
});

test("route loss cancels a warning or ends an active door event before it can softlock", () => {
  const doorOnly = Object.freeze({
    ...definition,
    id: "door-only-director",
    routeIds: Object.freeze(["main-exit", "service-exit"]),
    events: Object.freeze([eventDefinitions[3]]),
  });
  const doorSignals = (tick, legalRouteIds) => ({
    ...signals(tick),
    legalRouteIds,
  });

  let state = createInitialTensionDirectorState(doorOnly);
  for (let tick = 1; tick <= 5; tick += 1) {
    state = stepTensionDirector(
      doorOnly,
      state,
      doorSignals(tick, doorOnly.routeIds),
    ).state;
  }
  assert.equal(state.activeEvent.phase, "warning");
  let step = stepTensionDirector(
    doorOnly,
    state,
    doorSignals(6, ["service-exit"]),
  );
  assert.equal(step.state.activeEvent, null);
  assert.equal(step.lifecycleEvents[0].type, "event-cancelled");
  assert.equal(step.lifecycleEvents[0].reason, "route-protection");

  state = createInitialTensionDirectorState(doorOnly);
  for (let tick = 1; tick <= 8; tick += 1) {
    state = stepTensionDirector(
      doorOnly,
      state,
      doorSignals(tick, doorOnly.routeIds),
    ).state;
  }
  assert.equal(state.activeEvent.phase, "active");
  step = stepTensionDirector(
    doorOnly,
    state,
    doorSignals(9, ["service-exit"]),
  );
  assert.equal(step.state.activeEvent, null);
  assert.equal(step.lifecycleEvents[0].type, "event-ended");
  assert.equal(step.lifecycleEvents[0].reason, "route-protection");
});

test("resource protection suppresses pressure and preserves a recovery window after refill", () => {
  let state = createInitialTensionDirectorState(definition);
  let step;
  for (let tick = 1; tick <= 5; tick += 1) {
    step = stepTensionDirector(
      definition,
      state,
      signals(tick, { resourcesRemainingPermille: 100 }),
    );
    state = step.state;
    assert.equal(step.tier, "rest");
    assert.equal(step.suggestion, null);
    assert.ok(step.suppressionReasons.includes("critical-resources"));
  }
  for (let tick = 6; tick <= 8; tick += 1) {
    step = stepTensionDirector(
      definition,
      state,
      signals(tick, { resourcesRemainingPermille: 1_000 }),
    );
    state = step.state;
    assert.equal(step.suggestion, null);
    assert.ok(step.suppressionReasons.includes("breathing-window"));
  }
  step = stepTensionDirector(
    definition,
    state,
    signals(9, { resourcesRemainingPermille: 1_000 }),
  );
  assert.ok(step.suggestion, "director did not recover after its bounded resource breather");
});

test("a single event cannot recur before both its cooldown and the global calm window", () => {
  const singleEventDefinition = Object.freeze({
    ...definition,
    id: "single-event-cooldown-director",
    events: Object.freeze([eventDefinitions[0]]),
  });
  let state = createInitialTensionDirectorState(singleEventDefinition);
  const suggestions = [];
  const endings = [];
  for (let tick = 1; tick <= 12; tick += 1) {
    const step = stepTensionDirector(
      singleEventDefinition,
      state,
      signals(tick),
    );
    state = step.state;
    suggestions.push(...step.lifecycleEvents.filter(({ type }) => (
      type === "event-suggested"
    )));
    endings.push(...step.lifecycleEvents.filter(({ type }) => (
      type === "event-ended"
    )));
  }
  assert.deepEqual(suggestions.map(({ atTick }) => atTick), [3, 12]);
  assert.deepEqual(endings.map(({ atTick }) => atTick), [8]);
  assert.equal(
    suggestions[1].atTick,
    endings[0].atTick + eventDefinitions[0].cooldownTicks,
  );
});

test("score bands use explicit hysteresis and low resources cap heightened pressure", () => {
  assert.equal(
    tensionDirectorScore(fastPolicy, {
      safeTicks: 5,
      missionProgressPermille: 500,
      resourcesRemainingPermille: 500,
    }),
    500,
  );
  let tier = tensionTierWithHysteresis("rest", 300, 1_000, fastPolicy);
  assert.equal(tier, "watchful");
  tier = tensionTierWithHysteresis(tier, 250, 1_000, fastPolicy);
  assert.equal(tier, "watchful", "watchful tier chattered inside its hysteresis band");
  tier = tensionTierWithHysteresis(tier, 200, 1_000, fastPolicy);
  assert.equal(tier, "rest");

  tier = tensionTierWithHysteresis("rest", 700, 1_000, fastPolicy);
  assert.equal(tier, "heightened");
  tier = tensionTierWithHysteresis(tier, 550, 1_000, fastPolicy);
  assert.equal(tier, "heightened", "heightened tier chattered inside its hysteresis band");
  tier = tensionTierWithHysteresis(tier, 500, 1_000, fastPolicy);
  assert.equal(tier, "watchful");
  assert.equal(
    tensionTierWithHysteresis("heightened", 900, 299, fastPolicy),
    "watchful",
  );
  assert.equal(
    tensionTierWithHysteresis("heightened", 900, 100, fastPolicy),
    "rest",
  );
});

function authoredTrace(lastTick, reverseRouteOrder = false) {
  return Array.from({ length: lastTick }, (_, index) => {
    const tick = index + 1;
    let threat = "safe";
    let safeTicks = tick;
    let chaseTicks = 0;
    let ticksSinceChaseEscape = null;
    if (tick >= 21 && tick <= 25) {
      threat = "suspicious";
      safeTicks = 0;
    } else if (tick >= 26 && tick <= 35) {
      threat = "chased";
      safeTicks = 0;
      chaseTicks = tick - 25;
    } else if (tick >= 36 && tick <= 41) {
      safeTicks = tick - 35;
      ticksSinceChaseEscape = tick - 36;
    } else if (tick > 41) {
      safeTicks = tick - 35;
    }
    const legalRouteIds = tick >= 130 && tick <= 140
      ? ["service-exit"]
      : reverseRouteOrder
        ? [...routes].reverse()
        : routes;
    return signals(tick, {
      threat,
      safeTicks,
      chaseTicks,
      ticksSinceChaseEscape,
      missionProgressPermille: Math.min(1_000, tick * 10),
      resourcesRemainingPermille: tick >= 100 && tick <= 105 ? 100 : 800,
      legalRouteIds,
    });
  });
}

test("identical fixed ticks are byte-stable across 30/60/120/144 Hz render pacing", () => {
  const trace = authoredTrace(180);
  function atRenderRate(renderRate) {
    let state = createInitialTensionDirectorState(definition);
    const lifecycleEvents = [];
    let accumulator = 0;
    for (
      let frame = 0;
      state.currentTick < trace.length && frame < 10_000;
      frame += 1
    ) {
      accumulator += 1 / renderRate;
      while (
        accumulator + 1e-12 >= definition.policy.fixedStepSeconds
        && state.currentTick < trace.length
      ) {
        accumulator -= definition.policy.fixedStepSeconds;
        const step = stepTensionDirector(
          definition,
          state,
          trace[state.currentTick],
        );
        state = step.state;
        lifecycleEvents.push(...step.lifecycleEvents);
      }
    }
    return { state, lifecycleEvents };
  }

  const baseline = atRenderRate(60);
  for (const renderRate of [30, 120, 144]) {
    assert.deepEqual(
      atRenderRate(renderRate),
      baseline,
      `director drifted under ${renderRate} Hz render pacing`,
    );
  }
});

test("route input order cannot perturb round-robin selection or replay fingerprint", () => {
  const canonical = replayTensionDirector(definition, authoredTrace(180));
  const reversed = replayTensionDirector(definition, authoredTrace(180, true));
  assert.deepEqual(reversed, canonical);
  assert.match(canonical.fingerprint, /^[0-9a-f]{8}$/);
  assert.ok(canonical.lifecycleEvents.some(({ type }) => type === "event-suggested"));
});

test("trace safety audit proves warnings, finite lifetimes, cooldowns, and route certificates", () => {
  const audit = auditTensionDirectorSafety(definition, authoredTrace(240));
  assert.equal(audit.passed, true, audit.failures.join("; "));
  assert.equal(audit.processedTicks, 240);
  assert.ok(audit.suggestionsAudited >= 4);
  assert.ok(audit.activationsAudited >= 2);
  assert.ok(audit.minimumPreservedRouteCount >= definition.minimumLegalRouteCount);
  assert.equal(audit.finalState.currentTick, 240);

  const invalidTrace = auditTensionDirectorSafety(
    definition,
    [signals(2)],
  );
  assert.equal(invalidTrace.passed, false);
  assert.equal(invalidTrace.processedTicks, 0);
  assert.ok(invalidTrace.failures.some((failure) => (
    failure.includes("expected 1")
  )));
});

test("state, suggestions, lifecycle output, and safety arrays are immutable snapshots", () => {
  let state = createInitialTensionDirectorState(definition);
  let suggestedStep = null;
  for (let tick = 1; tick <= 3; tick += 1) {
    suggestedStep = stepTensionDirector(definition, state, signals(tick));
    state = suggestedStep.state;
  }
  assert.ok(suggestedStep.suggestion);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.cooldowns), true);
  assert.equal(Object.isFrozen(suggestedStep), true);
  assert.equal(Object.isFrozen(suggestedStep.lifecycleEvents), true);
  assert.equal(Object.isFrozen(suggestedStep.suggestion), true);
  assert.equal(Object.isFrozen(suggestedStep.suggestion.blockedRouteIds), true);
  assert.equal(Object.isFrozen(suggestedStep.suggestion.safety), true);
  assert.equal(
    Object.isFrozen(suggestedStep.suggestion.safety.preservedLegalRouteIds),
    true,
  );
});
