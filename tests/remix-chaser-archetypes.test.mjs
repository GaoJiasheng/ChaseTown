import assert from "node:assert/strict";
import test from "node:test";

import {
  CHASER_ARCHETYPE_FAIRNESS_CONTRACT,
  CHASER_ARCHETYPE_PROFILES,
  chaserArchetypePublicFingerprint,
  createInitialChaserArchetypeState,
  enabledChaserArchetype,
  stepChaserArchetype,
} from "../app/game/chaser-archetypes.ts";
import { CAMPAIGN_LEVELS } from "../app/game/campaign.ts";
import { buildEnvironmentCompositionPlan } from "../app/game/environment-composition.ts";
import { GhostInputRecorder, parseGhostRecording, serializeGhostRecording } from "../app/game/ghost-replay.ts";
import { queryLegalHideCandidates } from "../app/game/hide-archetypes.ts";
import { createLevel } from "../app/game/level.ts";
import { findPath, isWalkable, pointKey } from "../app/game/navigation.ts";
import {
  ALL_CERTIFIED_REMIX_CONTRACTS,
  CERTIFIED_REMIX_MISSION_VERSION,
  auditCertifiedRemixContract,
  certifiedRemixContract,
  certifiedRemixContractsForLevel,
  remixGhostStorageKey,
  remixRecordStorageKey,
  remixReplayLevelId,
  remixRunIdentity,
  resolveCertifiedRemix,
} from "../app/game/remix-contracts.ts";
import {
  auditThemeMissionSoftlock,
  themeMissionDefinition,
} from "../app/game/theme-objectives.ts";

test("every campaign level exposes exactly three deterministic certified seed contracts", () => {
  assert.equal(ALL_CERTIFIED_REMIX_CONTRACTS.length, CAMPAIGN_LEVELS.length * 3);
  const allIds = new Set();
  const allLevelSeeds = new Set();
  for (const level of CAMPAIGN_LEVELS) {
    const first = certifiedRemixContractsForLevel(level);
    const second = certifiedRemixContractsForLevel(level.id);
    assert.equal(first, second, "certified contracts should be cached immutable authoring data");
    assert.equal(first.length, 3);
    assert.equal(new Set(first.map((contract) => contract.seed)).size, 3);
    assert.equal(new Set(first.map((contract) => pointKey(contract.closedPassageCells[0]))).size, 3);
    assert.ok(new Set(first.map((contract) => contract.hideSupplyIds.join("|"))).size >= 2);
    assert.ok(first.every((contract) => (
      contract.hideSupplyIds.length === Math.max(1, level.hideSpots.length - 1)
    )), "every certified layout should reduce the original hide supply");
    assert.ok(new Set(first.map((contract) => (
      contract.mechanicPlacementGroup.map(pointKey).join("|")
    ))).size >= 2);
    for (const contract of first) {
      assert.equal(Object.isFrozen(contract), true);
      assert.equal(contract.levelId, level.id);
      assert.equal(certifiedRemixContract(level.id, contract.seed), contract);
      assert.equal(auditCertifiedRemixContract(level, contract).passed, true);
      assert.equal(allIds.has(contract.id), false);
      assert.equal(allLevelSeeds.has(`${contract.levelId}:${contract.seed}`), false);
      allIds.add(contract.id);
      allLevelSeeds.add(`${contract.levelId}:${contract.seed}`);
    }
  }
});

test("resolved remixes deterministically apply patrol, mechanisms, passages, and hide supply without mutating source", () => {
  for (const level of CAMPAIGN_LEVELS) {
    const originalWalkable = level.walkable.map((row) => [...row]);
    const originalHideIds = level.hideSpots.map((spot) => spot.id);
    const compatibility = resolveCertifiedRemix(level, null);
    assert.equal(compatibility.level, level);
    assert.equal(compatibility.runIdentity, null);

    for (const contract of certifiedRemixContractsForLevel(level)) {
      const first = resolveCertifiedRemix(level, contract);
      const second = resolveCertifiedRemix(level, contract);
      assert.deepEqual(first, second);
      assert.notEqual(first.level, level);
      assert.deepEqual(first.level.patrol, contract.patrolGroup);
      assert.deepEqual(first.level.hideSpots.map((spot) => spot.id), contract.hideSupplyIds);
      assert.deepEqual(first.mechanicPlacementGroup, contract.mechanicPlacementGroup);
      for (const point of contract.closedPassageCells) {
        assert.equal(first.level.walkable[point.y][point.x], false);
      }
      for (const point of contract.openPassageCells) {
        assert.equal(first.level.walkable[point.y][point.x], true);
      }
      for (const point of contract.mechanicPlacementGroup) {
        assert.equal(isWalkable(first.level, point), true);
        assert.ok(findPath(first.level, first.level.playerStart, point).length > 0);
      }
      assert.ok(findPath(first.level, first.level.playerStart, first.level.exit).length > 0);
    }
    assert.deepEqual(level.walkable, originalWalkable);
    assert.deepEqual(level.hideSpots.map((spot) => spot.id), originalHideIds);
  }
});

test("all thirty certified layouts keep the runtime mission placement chain softlock-free", () => {
  for (const sourceLevel of CAMPAIGN_LEVELS) {
    for (const contract of certifiedRemixContractsForLevel(sourceLevel)) {
      const remix = resolveCertifiedRemix(sourceLevel, contract);
      const composition = buildEnvironmentCompositionPlan(remix.level);
      const mission = themeMissionDefinition(sourceLevel.campaign.theme);
      const placements = mission.objectives.map((objective, index) => ({
        objectiveId: objective.id,
        position: remix.mechanicPlacementGroup[index]
          ?? composition.landmarkBeats[
            Math.min(index, composition.landmarkBeats.length - 1)
          ].focusCell,
      }));
      const audit = auditThemeMissionSoftlock(remix.level, mission, placements);
      assert.equal(
        audit.passed,
        true,
        `${contract.id} failed runtime mission audit: ${audit.failures.join("; ")}`,
      );
    }
  }
});

test("arbitrary seeds and cross-level contracts are rejected", () => {
  const firstLevel = CAMPAIGN_LEVELS[0];
  const secondLevel = CAMPAIGN_LEVELS[1];
  assert.equal(certifiedRemixContract(firstLevel.id, 123456789), null);
  assert.equal(certifiedRemixContract(firstLevel.id, Number.NaN), null);
  assert.throws(
    () => resolveCertifiedRemix(secondLevel, certifiedRemixContractsForLevel(firstLevel)[0]),
    /another level/,
  );
});

test("record, ghost, replay level, seed, and ruleset identities cannot collide", () => {
  const keys = new Set();
  for (const contract of ALL_CERTIFIED_REMIX_CONTRACTS) {
    for (const lane of ["standard", "assisted"]) {
      for (const key of [
        remixGhostStorageKey(contract, lane),
        remixRecordStorageKey(contract, lane),
        remixReplayLevelId(contract, lane),
      ]) {
        assert.equal(keys.has(key), false, `duplicate remix identity ${key}`);
        keys.add(key);
      }
      const runIdentity = remixRunIdentity(contract, lane);
      assert.match(runIdentity, new RegExp(`${lane}:${CERTIFIED_REMIX_MISSION_VERSION}$`));
      assert.notEqual(
        remixReplayLevelId(contract, lane),
        `${contract.levelId}#${CERTIFIED_REMIX_MISSION_VERSION}`,
        "certified layout replay identity collided with the original layout",
      );
    }
  }
  assert.equal(keys.size, ALL_CERTIFIED_REMIX_CONTRACTS.length * 2 * 3);

  const [first, second] = certifiedRemixContractsForLevel(CAMPAIGN_LEVELS[0]);
  const replayId = remixReplayLevelId(first, "standard");
  const recorder = new GhostInputRecorder(replayId, 1 / 60);
  recorder.record(0, { move: { x: 1, y: 0 } });
  const recording = recorder.finish(30);
  const serialized = serializeGhostRecording(recording);
  assert.ok(parseGhostRecording(serialized, new Set([replayId])));
  assert.equal(
    parseGhostRecording(serialized, new Set([remixReplayLevelId(second, "standard")])),
    null,
    "ghost from one certified seed loaded into another",
  );
  assert.throws(
    () => remixRunIdentity(first, "standard", "unversioned-mission"),
    /mission version/,
  );
});

const archetypeLevel = createLevel({
  id: "archetype-public-evidence",
  width: 9,
  height: 5,
  walkable: [
    [false, false, false, false, true, false, false, false, false],
    [false, false, false, false, true, false, false, false, false],
    [true, true, true, true, true, true, true, true, true],
    [false, false, false, false, true, false, false, false, false],
    [false, false, false, false, true, false, false, false, false],
  ],
  playerStart: { x: 0, y: 2 },
  exit: { x: 8, y: 2 },
  chaserStart: { x: 4, y: 0 },
  chaserStartHeading: { x: 0, y: 1 },
  patrol: [{ x: 4, y: 2 }],
  hideSpots: [{
    id: "public-locker",
    approach: { x: 6, y: 2 },
    concealed: { x: 6, y: 1.7 },
    facing: { x: 0, y: 1 },
  }],
});

function beginAndComplete(profile, input) {
  const initial = createInitialChaserArchetypeState();
  const begun = stepChaserArchetype(profile, initial, { ...input, deltaSeconds: 0 });
  assert.equal(begun.state.phase, "telegraph");
  assert.equal(begun.action, null);
  assert.equal(begun.events[0].type, "telegraph-started");
  const premature = stepChaserArchetype(profile, begun.state, {
    ...input,
    stimulus: null,
    deltaSeconds: profile.warningSeconds - 0.01,
  });
  assert.equal(premature.action, null);
  const completed = stepChaserArchetype(profile, premature.state, {
    ...input,
    stimulus: null,
    deltaSeconds: 0.01,
  });
  assert.ok(completed.action);
  assert.equal(completed.events[0].type, "action-ready");
  return { begun, completed };
}

test("four themed pursuers each expose one distinct rule and at least a 0.5 second cue", () => {
  const profiles = Object.values(CHASER_ARCHETYPE_PROFILES);
  assert.equal(new Set(profiles.map((profile) => profile.kind)).size, 4);
  assert.equal(new Set(profiles.map((profile) => profile.rule)).size, 4);
  for (const profile of profiles) {
    assert.ok(profile.warningSeconds >= 0.5);
    assert.ok(profile.readableRule && profile.cueLabel && profile.cueAudioToken && profile.cueAnimationToken);
    assert.equal(enabledChaserArchetype(profile.theme), null);
    assert.equal(enabledChaserArchetype(profile.theme, true), profile);
  }
  assert.equal(CHASER_ARCHETYPE_FAIRNESS_CONTRACT.warningMinimumSeconds, 0.5);
  assert.deepEqual(CHASER_ARCHETYPE_FAIRNESS_CONTRACT.forbiddenInputs, [
    "player-state",
    "hidden-player-position",
    "hide-occupancy",
    "chosen-traversal-exit",
  ]);
});

test("campus patroller telegraphs then scans only a public patrol junction", () => {
  const profile = CHASER_ARCHETYPE_PROFILES.campus;
  const stimulus = { kind: "patrol-arrival", id: "arrival:1", position: { x: 4, y: 2 } };
  const { completed } = beginAndComplete(profile, {
    level: archetypeLevel,
    stimulus,
  });
  assert.equal(completed.action.type, "scan-public-junction");
  assert.equal(completed.action.branchHeadings.length, 4);

  const repeated = stepChaserArchetype(profile, completed.state, {
    level: archetypeLevel,
    stimulus,
    deltaSeconds: 1,
  });
  assert.equal(repeated.state.phase, "idle", "same public arrival retriggered every frame");
  assert.equal(repeated.events.length, 0);
});

test("hospital inspector consumes only legal public hide candidates", () => {
  const profile = CHASER_ARCHETYPE_PROFILES.hospital;
  const evidence = {
    kind: "sound",
    position: { x: 5, y: 2 },
    strength: 0.6,
    sourceType: "hide-interaction",
    sourceId: "opaque-door-sound",
    observedAtSeconds: 2,
  };
  const legalHideCandidates = queryLegalHideCandidates(
    archetypeLevel,
    [],
    evidence,
    { maximumRouteDistance: 4 },
  );
  const { completed } = beginAndComplete(profile, {
    level: archetypeLevel,
    stimulus: { kind: "perception", id: "heard-door:2", evidence },
    legalHideCandidates,
  });
  assert.equal(completed.action.type, "inspect-public-hide-clue");
  assert.equal(completed.action.hideSpotId, "public-locker");
  assert.equal(completed.action.exact, false);
  assert.equal(Object.hasOwn(completed.action, "occupiedByPlayer"), false);
  assert.equal(Object.hasOwn(completed.action, "concealed"), false);
});

test("fire sound tracker focuses the same uncertain perceived point only after its cue", () => {
  const profile = CHASER_ARCHETYPE_PROFILES["fire-station"];
  const evidence = {
    kind: "sound",
    position: { x: 3, y: 2 },
    strength: 0.7,
    confidence: 0.55,
    sourceType: "player-movement",
    observedAtSeconds: 4,
  };
  const { completed } = beginAndComplete(profile, {
    level: archetypeLevel,
    stimulus: { kind: "perception", id: "heard-step:4", evidence },
  });
  assert.equal(completed.action.type, "focus-perceived-sound");
  assert.deepEqual(completed.action.evidence.position, evidence.position);
  assert.ok(completed.action.evidence.confidence > evidence.confidence);

  const ignored = stepChaserArchetype(profile, createInitialChaserArchetypeState(), {
    level: archetypeLevel,
    stimulus: {
      kind: "perception",
      id: "too-quiet",
      evidence: { ...evidence, strength: 0.1, confidence: 0.1 },
    },
    deltaSeconds: 1,
  });
  assert.equal(ignored.events.length, 0);
});

test("factory interceptor predicts only from the public sighting and known exit route", () => {
  const profile = CHASER_ARCHETYPE_PROFILES.factory;
  const evidence = {
    kind: "player-visible",
    position: { x: 1, y: 2 },
    observedAtSeconds: 5,
  };
  const input = {
    level: archetypeLevel,
    stimulus: { kind: "perception", id: "sighting:5", evidence },
  };
  const first = beginAndComplete(profile, input).completed;
  const second = beginAndComplete(profile, structuredClone(input)).completed;
  assert.deepEqual(first, second, "same public input produced a different intercept");
  assert.equal(first.action.type, "intercept-public-exit-route");
  const publicRoute = findPath(archetypeLevel, evidence.position, archetypeLevel.exit);
  assert.ok(publicRoute.some((point) => pointKey(point) === pointKey(first.action.interceptTarget)));
  assert.notDeepEqual(first.action.interceptTarget, evidence.position);
  assert.equal(Object.hasOwn(first.action, "playerPosition"), false);
  assert.equal(
    chaserArchetypePublicFingerprint(profile, input.stimulus),
    chaserArchetypePublicFingerprint(profile, structuredClone(input.stimulus)),
  );
});

test("disabled archetype controller is a no-op and preserves the old AI path", () => {
  const state = createInitialChaserArchetypeState();
  const result = stepChaserArchetype(null, state, {
    level: archetypeLevel,
    stimulus: {
      kind: "perception",
      id: "visible-but-disabled",
      evidence: {
        kind: "player-visible",
        position: { x: 1, y: 2 },
        observedAtSeconds: 1,
      },
    },
    deltaSeconds: 10,
  });
  assert.equal(result.state, state);
  assert.equal(result.action, null);
  assert.deepEqual(result.events, []);
});
