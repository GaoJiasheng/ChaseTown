import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceFixedStepHostFrame,
  createFixedStepHost,
  EMPTY_FIXED_STEP_HOST_EDGES,
  resetFixedStepHost,
} from "../app/game/fixed-step-host.ts";
import { libraryMissionCommitmentWindow } from "../app/game/library-branching-mission.ts";
import {
  acknowledgePortableDecoySound,
  createPortableDecoyState,
  deployPortableDecoy,
  stepPortableDecoy,
} from "../app/game/portable-decoy.ts";
import { tensionDirectorModifiers } from "../app/game/stealth-expansion.ts";
import {
  createInitialTensionDirectorState,
  DEFAULT_TENSION_DIRECTOR_POLICY,
  stepTensionDirector,
  TENSION_DIRECTOR_VERSION,
} from "../app/game/tension-director.ts";
import {
  createMechanicInstance,
  createThemeMechanicDefinition,
  mechanicRequiresMovementCommitment,
  stepMechanicInstance,
} from "../app/game/theme-mechanics.ts";

const ALL_EDGES = Object.freeze({
  interactionPressed: true,
  portableDecoyPressed: true,
  stealthToolPressed: true,
  evidenceErasePressed: true,
});

test("144Hz zero-tick frames retain every action until one authoritative tick", () => {
  let state = createFixedStepHost();
  const first = advanceFixedStepHostFrame(state, 1 / 144, ALL_EDGES);
  state = first.state;
  assert.equal(first.ticks.length, 0);
  assert.deepEqual(state.pendingEdges, ALL_EDGES);

  const second = advanceFixedStepHostFrame(
    state,
    1 / 144,
    EMPTY_FIXED_STEP_HOST_EDGES,
  );
  state = second.state;
  assert.equal(second.ticks.length, 0);
  assert.deepEqual(state.pendingEdges, ALL_EDGES);

  const third = advanceFixedStepHostFrame(
    state,
    1 / 144,
    EMPTY_FIXED_STEP_HOST_EDGES,
  );
  assert.deepEqual(third.ticks, [{ tick: 1, edges: ALL_EDGES }]);
  assert.deepEqual(
    third.state.pendingEdges,
    EMPTY_FIXED_STEP_HOST_EDGES,
  );
});

test("a multi-tick render frame delivers latched edges to its first tick only", () => {
  const frame = advanceFixedStepHostFrame(
    createFixedStepHost(),
    1 / 30,
    ALL_EDGES,
  );

  assert.deepEqual(frame.ticks, [
    { tick: 1, edges: ALL_EDGES },
    { tick: 2, edges: EMPTY_FIXED_STEP_HOST_EDGES },
  ]);
});

test("reset clears accumulated time and unconsumed edges", () => {
  const pending = advanceFixedStepHostFrame(
    createFixedStepHost(),
    1 / 144,
    ALL_EDGES,
  ).state;
  const reset = resetFixedStepHost(pending, 37);

  assert.equal(reset.clock.tick, 37);
  assert.equal(reset.clock.remainderSeconds, 0);
  assert.deepEqual(reset.pendingEdges, EMPTY_FIXED_STEP_HOST_EDGES);
});

const FIXED_STEP_SECONDS = 1 / 60;

const corridor = Object.freeze({
  id: "fixed-host-corridor",
  width: 7,
  height: 3,
  walkable: Object.freeze([
    Object.freeze([false, false, false, false, false, false, false]),
    Object.freeze([false, true, true, true, true, true, false]),
    Object.freeze([false, false, false, false, false, false, false]),
  ]),
  playerStart: Object.freeze({ x: 1, y: 1 }),
  chaserStart: Object.freeze({ x: 5, y: 1 }),
  chaserStartHeading: Object.freeze({ x: -1, y: 0 }),
  exit: Object.freeze({ x: 5, y: 1 }),
  hideSpots: Object.freeze([]),
  patrol: Object.freeze([{ x: 5, y: 1 }]),
});

const decoyDefinition = Object.freeze({
  id: "fixed-host-decoy",
  capacity: 1,
  placementRange: 4,
  fuseSeconds: FIXED_STEP_SECONDS * 2,
  activeLifetimeSeconds: 1,
  cooldownSeconds: 0,
  soundStrength: 0.8,
  soundConfidence: 0.8,
  soundDecayPerSecond: 0.1,
  repeatConfidenceMultiplier: 0.7,
});

const directorDefinition = Object.freeze({
  version: TENSION_DIRECTOR_VERSION,
  id: "fixed-host-director",
  routeIds: Object.freeze(["main-exit"]),
  minimumLegalRouteCount: 1,
  policy: Object.freeze({
    ...DEFAULT_TENSION_DIRECTOR_POLICY,
    minimumWarningTicks: 2,
    maximumEventDurationTicks: 5,
    minimumEventCooldownTicks: 3,
    minimumSafeTicksBeforePressure: 3,
    minimumCalmTicksAfterEvent: 3,
    suspiciousBreatherTicks: 3,
    chaseBreatherTicks: 4,
    escapeBreatherTicks: 4,
    resourceRecoveryBreatherTicks: 3,
    criticalResourcePermille: 100,
    heightenedResourceFloorPermille: 250,
    safeRampStartTicks: 0,
    safeRampEndTicks: 10,
    safeScoreMaximum: 600,
    missionScoreMaximum: 300,
    resourceScoreMaximum: 100,
    watchfulEnterScore: 300,
    watchfulExitScore: 200,
    heightenedEnterScore: 700,
    heightenedExitScore: 500,
  }),
  events: Object.freeze([
    Object.freeze({
      id: "public-address",
      label: "广播巡检通知",
      kind: "broadcast",
      minimumTier: "watchful",
      warningTicks: 2,
      durationTicks: 5,
      cooldownTicks: 3,
      publicChannelId: "corridor-speaker-bank",
      blockedRouteIds: Object.freeze([]),
      intensityPermille: 760,
    }),
  ]),
});

function rounded(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function runBoundaryTrace(refreshRateHz) {
  let host = createFixedStepHost();
  const missionWindow = libraryMissionCommitmentWindow(
    0,
    FIXED_STEP_SECONDS * 1.5,
    FIXED_STEP_SECONDS,
  );
  let missionCommitment = missionWindow;
  let missionCompletedAtTick = null;
  const mechanicDefinition = createThemeMechanicDefinition(
    "campus",
    "fixed-host-mechanic",
    { x: 1, y: 1 },
  );
  let mechanic = createMechanicInstance(mechanicDefinition);
  let decoy = createPortableDecoyState(decoyDefinition);
  let director = createInitialTensionDirectorState(directorDefinition);
  const trace = [];

  for (let frameIndex = 0; frameIndex < refreshRateHz; frameIndex += 1) {
    const incomingEdges = frameIndex === 0
      ? {
        ...EMPTY_FIXED_STEP_HOST_EDGES,
        interactionPressed: true,
        portableDecoyPressed: true,
      }
      : EMPTY_FIXED_STEP_HOST_EDGES;
    const frame = advanceFixedStepHostFrame(
      host,
      1 / refreshRateHz,
      incomingEdges,
    );
    host = frame.state;

    for (const hostTick of frame.ticks) {
      const currentTick = hostTick.tick - 1;
      const currentSeconds = currentTick * FIXED_STEP_SECONDS;
      if (
        missionCommitment
        && currentTick >= missionCommitment.completesAtTick
      ) {
        missionCompletedAtTick = currentTick;
        missionCommitment = null;
      }

      if (hostTick.edges.portableDecoyPressed) {
        const deployment = deployPortableDecoy(decoy, corridor, {
          nowSeconds: currentSeconds,
          actorPosition: corridor.playerStart,
          landingPosition: { x: 3, y: 1 },
        });
        assert.equal(deployment.accepted, true);
        decoy = deployment.state;
      }
      const decoyStep = stepPortableDecoy(decoy, {
        nowSeconds: currentSeconds,
        deltaSeconds: Math.max(0, currentSeconds - decoy.updatedAtSeconds),
      });
      decoy = decoyStep.state;
      let decoySoundAcknowledged = false;
      if (decoyStep.pendingSoundStimulus?.sourceId) {
        const acknowledgement = acknowledgePortableDecoySound(decoy, {
          nowSeconds: currentSeconds,
          sourceId: decoyStep.pendingSoundStimulus.sourceId,
        });
        decoy = acknowledgement.state;
        decoySoundAcknowledged = acknowledgement.acknowledged;
      }

      const mechanicStep = stepMechanicInstance(mechanic, {
        deltaSeconds: FIXED_STEP_SECONDS,
        nowSeconds: hostTick.tick * FIXED_STEP_SECONDS,
        activationRequested: hostTick.edges.interactionPressed,
        actorPosition: corridor.playerStart,
      });
      mechanic = mechanicStep.instance;

      const threat = hostTick.tick === 6 ? "chased" : "safe";
      const directorStep = stepTensionDirector(
        directorDefinition,
        director,
        {
          tick: hostTick.tick,
          runPhase: "playing",
          threat,
          safeTicks: threat === "safe" ? hostTick.tick : 0,
          chaseTicks: threat === "chased" ? 1 : 0,
          ticksSinceChaseEscape: null,
          missionProgressPermille: 1_000,
          resourcesRemainingPermille: 1_000,
          legalRouteIds: directorDefinition.routeIds,
        },
      );
      director = directorStep.state;
      const activeSuggestion = director.activeEvent?.suggestion ?? null;
      const modifiers = tensionDirectorModifiers(
        activeSuggestion,
        director.activeEvent?.phase === "active",
      );
      const decoyThrowCommitted = Boolean(
        decoy.activeDeployment
        && currentSeconds < decoy.activeDeployment.soundAtSeconds,
      );

      trace.push({
        tick: hostTick.tick,
        edges: hostTick.edges,
        missionMovementCommitted: missionCommitment !== null,
        missionCompletedAtTick,
        mechanicPhase: mechanicStep.sample.phase,
        mechanicProgress: rounded(mechanicStep.sample.progress),
        mechanicMovementCommitted:
          mechanicRequiresMovementCommitment(mechanic),
        decoyPhase: decoyStep.sample.phase,
        decoyThrowCommitted,
        decoySoundAcknowledged,
        directorPhase: director.activeEvent?.phase ?? "idle",
        directorLifecycle: directorStep.lifecycleEvents.map(
          (event) => event.type,
        ),
        directorSpeedMultiplier: modifiers.chaserSpeedMultiplier,
        directorSoundMasking: modifiers.soundMasking,
        threat,
      });
    }
  }

  return trace;
}

test("mission, mechanic, decoy, and Director boundaries are byte-stable at 30/60/120/144Hz", () => {
  const traces = [30, 60, 120, 144].map((refreshRateHz) => ({
    refreshRateHz,
    trace: runBoundaryTrace(refreshRateHz),
  }));
  const baseline = traces[0].trace;

  for (const { refreshRateHz, trace } of traces) {
    assert.deepEqual(
      trace,
      baseline,
      `${refreshRateHz}Hz host-domain trace diverged`,
    );
    assert.equal(trace.length, 60);
  }

  assert.equal(baseline[0].edges.interactionPressed, true);
  assert.equal(baseline[0].edges.portableDecoyPressed, true);
  assert.equal(
    baseline.slice(1).some(({ edges }) => (
      edges.interactionPressed || edges.portableDecoyPressed
    )),
    false,
  );
  assert.deepEqual(
    baseline.slice(0, 4).map((tick) => tick.missionMovementCommitted),
    [true, true, false, false],
  );
  assert.deepEqual(
    baseline.slice(0, 4).map((tick) => tick.decoyThrowCommitted),
    [true, true, false, false],
  );
  assert.equal(baseline[2].decoySoundAcknowledged, true);

  const activation = baseline.find((tick) => (
    tick.directorLifecycle.includes("event-activated")
  ));
  assert.ok(activation, "Director warning never became active");
  assert.ok(
    activation.directorSoundMasking > 0,
    "active Director modifier did not reach SimulationInput boundary",
  );
  const dangerTick = baseline.find((tick) => tick.threat === "chased");
  assert.ok(dangerTick, "danger cancellation tick was not traced");
  assert.ok(
    dangerTick.directorLifecycle.includes("event-ended")
      || dangerTick.directorLifecycle.includes("event-cancelled"),
    "danger did not cancel the Director event before input construction",
  );
  assert.equal(
    dangerTick.directorSpeedMultiplier,
    1,
    "Director boosted a tick after chase became public",
  );
  assert.equal(
    dangerTick.directorSoundMasking,
    0,
    "Director masked a tick after chase became public",
  );
});
