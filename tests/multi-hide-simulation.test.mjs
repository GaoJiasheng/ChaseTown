import assert from "node:assert/strict";
import test from "node:test";

import {
  auditCampaignHideArchetypeSafety,
  CAMPAIGN_HIDE_ARCHETYPE_REPRESENTATIVES,
  CAMPAIGN_LEVELS,
} from "../app/game/campaign.ts";
import {
  auditHideArchetypeBindings,
  HIDE_AI_FAIRNESS_CONTRACT,
  HIDE_ARCHETYPE_PROFILES,
} from "../app/game/hide-archetypes.ts";
import { createLevel } from "../app/game/level.ts";
import { findPath } from "../app/game/navigation.ts";
import { GameSimulation } from "../app/game/simulation.ts";

const STEP = 0.01;

function openHideLevel({
  id = "multi-hide-test",
  archetype,
  approachX = 2,
  alternateExit,
  chaserX = 8,
  chaserHeading = { x: -1, y: 0 },
}) {
  const spot = {
    id: `${id}-spot`,
    approach: { x: approachX, y: 0 },
    concealed: { x: approachX, y: -0.35 },
    facing: { x: 1, y: 0 },
    ...(archetype ? { archetype } : {}),
    ...(alternateExit ? { alternateExit } : {}),
  };
  return {
    spot,
    level: createLevel({
      id,
      width: 10,
      height: 1,
      walkable: [Array(10).fill(true)],
      playerStart: { ...spot.approach },
      exit: { x: 9, y: 0 },
      chaserStart: { x: chaserX, y: 0 },
      chaserStartHeading: chaserHeading,
      patrol: [{ x: chaserX, y: 0 }],
      hideSpots: [spot],
    }),
  };
}

function simulationFor(level, spot, config = {}, options = {}) {
  return new GameSimulation({
    level,
    autoStart: true,
    initialPlayerHeading: spot.facing,
    ...options,
    config: {
      fixedStepSeconds: STEP,
      maxFrameDeltaSeconds: 2,
      aiTickSeconds: 0.05,
      spawnDelaySeconds: 100,
      chaserSpeed: 0,
      hideEnterSeconds: 1,
      hideExitSeconds: 1,
      hideInteractRange: 0.2,
      catchRange: 0.05,
      ...config,
    },
  });
}

function enterHide(simulation) {
  simulation.advance(STEP, { interactPressed: true });
  const entering = simulation.advance(STEP);
  assert.equal(entering.player.mode, "entering-hide");
  return entering;
}

function runFor(simulation, seconds, input = {}) {
  let remaining = seconds;
  while (remaining > 1e-10) {
    const delta = Math.min(STEP, remaining);
    simulation.advance(delta, input);
    remaining -= delta;
  }
  return simulation.getState();
}

test("all three archetypes drive their authored enter/exit timing and peek capability", () => {
  const results = new Map();
  for (const archetype of ["hard-locker", "soft-cover", "traversal-hide"]) {
    const { level, spot } = openHideLevel({
      id: `timing-${archetype}`,
      archetype,
      alternateExit: archetype === "traversal-hide" ? { x: 7, y: 0 } : undefined,
    });
    const simulation = simulationFor(level, spot);
    const descriptor = simulation.getHideSpotArchetype(spot.id);
    assert.equal(descriptor.archetype, archetype);
    const entering = enterHide(simulation);
    const expectedEnter = HIDE_ARCHETYPE_PROFILES[archetype].timing.enterDurationMultiplier;
    assert.ok(Math.abs(entering.player.transitionRemainingSeconds - expectedEnter) < 1e-9);

    let state = runFor(simulation, expectedEnter + STEP);
    assert.equal(state.player.mode, "hidden");
    state = simulation.advance(STEP, { peekHeld: true });
    assert.equal(
      state.player.mode,
      archetype === "hard-locker" ? "entering-peek" : "hidden",
      `${archetype} exposed an unsupported peek`,
    );
    if (state.player.mode !== "hidden") {
      state = runFor(simulation, 0.3, { peekHeld: false });
      assert.equal(state.player.mode, "hidden");
    }

    state = simulation.advance(STEP, { interactPressed: true });
    const expectedExit = HIDE_ARCHETYPE_PROFILES[archetype].timing.exitDurationMultiplier;
    assert.equal(state.player.mode, "exiting-hide");
    assert.ok(Math.abs(state.player.transitionRemainingSeconds - expectedExit) < 1e-9);
    results.set(archetype, { enter: expectedEnter, exit: expectedExit });
  }

  assert.ok(results.get("soft-cover").enter < results.get("hard-locker").enter);
  assert.ok(results.get("soft-cover").exit < results.get("hard-locker").exit);
  assert.ok(results.get("traversal-hide").enter < results.get("hard-locker").enter);
  assert.ok(results.get("traversal-hide").exit < results.get("hard-locker").exit);
});

test("simulation emits the quieter soft-cover entry through legal sound perception", () => {
  const runEntry = (archetype) => {
    const { level, spot } = openHideLevel({
      id: `sound-${archetype}`,
      archetype,
      approachX: 4,
      chaserX: 0,
      chaserHeading: { x: -1, y: 0 },
    });
    const simulation = simulationFor(level, spot, {
      spawnDelaySeconds: 0,
      hideEnterSeconds: 0.4,
      visionRange: 10,
      visionConeDegrees: 20,
      hearingRange: 10,
      soundUncertaintyCells: 1,
    });
    enterHide(simulation);
    return runFor(simulation, 0.15);
  };

  const hard = runEntry("hard-locker");
  const soft = runEntry("soft-cover");
  assert.equal(hard.chaser.memory.lastKnownEvidence, "sound");
  assert.equal(hard.chaser.memory.evidenceTrail[0].sourceType, "hide-interaction");
  assert.equal(hard.chaser.memory.evidenceTrail[0].sourceId.includes("sound-hard-locker-spot"), false);
  assert.equal(soft.chaser.memory.lastKnownEvidence, null);
});

test("soft cover exposes a bounded nearby disturbance while hard cover stays fully shut", () => {
  const runHidden = (archetype, approachX) => {
    const { level, spot } = openHideLevel({
      id: `visibility-${archetype}-${approachX}`,
      archetype,
      approachX,
      chaserX: 0,
      chaserHeading: { x: 1, y: 0 },
    });
    const simulation = simulationFor(level, spot, {
      spawnDelaySeconds: 0.3,
      hideEnterSeconds: 0.1,
      visionRange: 10,
      visionConeDegrees: 80,
      hearingRange: 0.1,
      suspiciousSeconds: 0.2,
    });
    enterHide(simulation);
    const state = runFor(simulation, 0.5);
    assert.equal(state.player.mode, "hidden");
    return { simulation, state };
  };

  const hardNear = runHidden("hard-locker", 2);
  const softNear = runHidden("soft-cover", 2);
  const softFar = runHidden("soft-cover", 3);
  assert.equal(hardNear.state.chaser.memory.lastKnownEvidence, null);
  assert.equal(softNear.state.chaser.memory.lastKnownEvidence, "visual");
  assert.equal(softFar.state.chaser.memory.lastKnownEvidence, null);
  assert.equal(
    softNear.simulation.getActiveHideSpotArchetype().profile.evidence.occupiedVisualDisturbance,
    0.24,
  );
});

test("traversal hide publishes exit options and moves to the selected alternate route", () => {
  const { level, spot } = openHideLevel({
    id: "alternate-route",
    archetype: "traversal-hide",
    alternateExit: { x: 7, y: 0 },
  });
  const simulation = simulationFor(level, spot, {
    hideEnterSeconds: 0.1,
    hideExitSeconds: 0.2,
  });
  enterHide(simulation);
  runFor(simulation, 0.2);

  assert.deepEqual(
    simulation.getHideExitSelection().options.map((option) => option.kind),
    ["origin", "alternate"],
  );
  assert.equal(simulation.getHideExitSelection().selected, "origin");
  simulation.advance(STEP, { hideExitChoice: "alternate" });
  assert.equal(simulation.getHideExitSelection().selected, "alternate");
  let state = simulation.advance(STEP, {
    hideExitChoice: "alternate",
    interactPressed: true,
  });
  assert.equal(state.player.mode, "exiting-hide");
  assert.ok(Math.abs(state.player.transitionRemainingSeconds - 0.2 * 0.76) < 1e-9);
  state = runFor(simulation, 0.2);
  assert.equal(state.player.mode, "free");
  assert.deepEqual(state.player.position, spot.alternateExit);
  assert.equal(simulation.getHideExitSelection(), null);
  assert.ok(
    findPath(level, state.player.position, level.exit).length
      < findPath(level, spot.approach, level.exit).length,
    "alternate exit did not materially change the remaining route",
  );
});

test("uncommitted traversal-exit choice is private and cannot alter chaser decisions", () => {
  const { level, spot } = openHideLevel({
    id: "private-exit-choice",
    archetype: "traversal-hide",
    approachX: 4,
    alternateExit: { x: 7, y: 0 },
    chaserX: 0,
    chaserHeading: { x: -1, y: 0 },
  });
  const makeSimulation = () => simulationFor(level, spot, {
    spawnDelaySeconds: 0,
    hideEnterSeconds: 0.1,
    visionRange: 10,
    visionConeDegrees: 20,
    hearingRange: 0.1,
  });
  const origin = makeSimulation();
  const alternate = makeSimulation();
  enterHide(origin);
  enterHide(alternate);
  runFor(origin, 0.2);
  runFor(alternate, 0.2);

  origin.advance(STEP, { hideExitChoice: "origin" });
  alternate.advance(STEP, { hideExitChoice: "alternate" });
  assert.equal(origin.getHideExitSelection().selected, "origin");
  assert.equal(alternate.getHideExitSelection().selected, "alternate");
  assert.deepEqual(origin.getState().chaser, alternate.getState().chaser);
  assert.equal(Object.hasOwn(origin.getState().chaser, "occupiedByPlayer"), false);
  assert.equal(Object.hasOwn(origin.getState().chaser, "selectedHideExit"), false);
  assert.deepEqual(HIDE_AI_FAIRNESS_CONTRACT, {
    exactCheckEvidenceKind: "hide-entry-visible",
    occupancyReadable: false,
    concealedPositionReadable: false,
    alternateExitChoiceReadable: false,
    unwitnessedRankingInputs: [
      "perceived-evidence-position",
      "public-navigation-distance",
      "public-archetype",
      "already-inspected-ids",
    ],
  });
});

test("legacy levels and external bindings remain compatible with the simulation query API", () => {
  const { level, spot } = openHideLevel({ id: "legacy-adapter" });
  const legacy = simulationFor(level, spot);
  assert.equal(legacy.getHideSpotArchetype(spot.id).archetype, "hard-locker");
  assert.equal(legacy.getHideSpotArchetype(spot.id).legacyDefault, true);

  const adapted = simulationFor(level, spot, {}, {
    hideArchetypeBindings: [{
      hideSpotId: spot.id,
      archetype: "soft-cover",
    }],
  });
  assert.equal(adapted.getHideSpotArchetype(spot.id).archetype, "soft-cover");
  assert.equal(adapted.getHideSpotArchetype(spot.id).legacyDefault, false);
});

test("campaign safety audit keeps a hard locker in all ten levels and all three types in theme representatives", () => {
  const audit = auditCampaignHideArchetypeSafety();
  assert.equal(audit.passed, true, audit.failures.join("; "));
  assert.equal(audit.levelAudits.length, 10);
  for (const level of CAMPAIGN_LEVELS) {
    const levelAudit = auditHideArchetypeBindings(level);
    assert.equal(levelAudit.passed, true, `${level.id}: ${levelAudit.failures.join("; ")}`);
    assert.ok(levelAudit.resolved.some((spot) => spot.archetype === "hard-locker"));
  }
  for (const representativeId of Object.values(CAMPAIGN_HIDE_ARCHETYPE_REPRESENTATIVES)) {
    const representative = audit.levelAudits.find((item) => item.levelId === representativeId);
    assert.equal(representative.representative, true);
    assert.deepEqual(
      new Set(representative.audit.resolved.map((spot) => spot.archetype)),
      new Set(["hard-locker", "soft-cover", "traversal-hide"]),
    );
  }

  const campusRepresentative = CAMPAIGN_HIDE_ARCHETYPE_REPRESENTATIVES.campus;
  const unsafe = CAMPAIGN_LEVELS.map((level) => level.id !== campusRepresentative
    ? level
    : {
        ...level,
        hideSpots: level.hideSpots.map((spot) => ({
          ...spot,
          archetype: "hard-locker",
          alternateExit: undefined,
        })),
      });
  const failed = auditCampaignHideArchetypeSafety(unsafe);
  assert.equal(failed.passed, false);
  assert.ok(failed.failures.some((failure) => failure.includes("soft-cover")));
  assert.ok(failed.failures.some((failure) => failure.includes("traversal-hide")));
});
