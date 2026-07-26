import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS } from "../app/game/campaign.ts";
import { createLevel } from "../app/game/level.ts";
import {
  aiEvidenceCandidateToPerception,
  canCornerMirrorObservePoint,
  createCampaignTensionDirectorDefinition,
  isDoorWedgeTraversalAttempt,
  resolveStealthToolTarget,
  tensionDirectorModifiers,
} from "../app/game/stealth-expansion.ts";
import {
  auditTensionDirectorDefinition,
  auditTensionDirectorSafety,
} from "../app/game/tension-director.ts";

function levelFromRows({
  id = "stealth-expansion-fixture",
  rows,
  hideSpots = [],
  visionOnlyBlockers = [],
}) {
  const walkable = rows.map((row) => [...row].map((entry) => entry !== "#"));
  const points = [];
  for (let y = 0; y < walkable.length; y += 1) {
    for (let x = 0; x < walkable[y].length; x += 1) {
      if (walkable[y][x]) points.push({ x, y });
    }
  }
  return createLevel({
    id,
    width: walkable[0].length,
    height: walkable.length,
    walkable,
    playerStart: points[0],
    exit: points.at(-1),
    chaserStart: points[Math.min(1, points.length - 1)],
    chaserStartHeading: { x: 1, y: 0 },
    patrol: [points[Math.min(1, points.length - 1)]],
    hideSpots,
    visionOnlyBlockers,
  });
}

const topologyLevel = levelFromRows({
  rows: [
    "#######",
    "###.###",
    "###.###",
    "#.....#",
    "#.....#",
    "###.###",
    "#######",
  ],
  hideSpots: [{
    id: "north-locker",
    approach: { x: 3, y: 1 },
    concealed: { x: 3, y: 0.7 },
    facing: { x: 0, y: 1 },
  }],
});

test("door-wedge and mirror anchors resolve deterministically from public static topology", () => {
  const door = resolveStealthToolTarget(
    "door-wedge",
    topologyLevel,
    { x: 3.1, y: 2.1 },
    { x: 0, y: 1 },
    { x: 3, y: 5 },
  );
  assert.deepEqual(door, {
    kind: "door",
    id: `${topologyLevel.id}:threshold:3:2`,
    interactionPoint: { x: 3, y: 2 },
    routeSafetyAuditId: `${topologyLevel.id}:player-route-remains-open:v1`,
    traversalAxis: "vertical",
    playerPassageRemainsAvailable: true,
    autoReleaseTicks: 300,
  });

  const mirror = resolveStealthToolTarget(
    "corner-mirror",
    topologyLevel,
    { x: 2.1, y: 3 },
    { x: 0, y: 1 },
    { x: 3, y: 5 },
  );
  assert.deepEqual(mirror, {
    kind: "corner",
    id: `${topologyLevel.id}:corner:1:3`,
    interactionPoint: { x: 1, y: 3 },
    hasOpaqueCorner: true,
    outwardHeading: { x: 0, y: 1 },
  });
  assert.equal(Object.isFrozen(door), true);
  assert.equal(Object.isFrozen(mirror), true);
});

test("door wedge triggers only on an authored threshold traversal attempt", () => {
  const receipt = {
    tool: "door-wedge",
    riskEvidence: { position: { x: 3, y: 2 } },
    effect: { traversalAxis: "vertical" },
  };
  assert.equal(
    isDoorWedgeTraversalAttempt(receipt, { x: 3.05, y: 2.8 }, { x: 0, y: -1 }),
    true,
  );
  assert.equal(
    isDoorWedgeTraversalAttempt(receipt, { x: 3.05, y: 2.8 }, { x: 1, y: 0 }),
    false,
    "parallel wall movement is not a door attempt",
  );
  assert.equal(
    isDoorWedgeTraversalAttempt(receipt, { x: 3.05, y: 2.8 }, { x: 0, y: 1 }),
    false,
    "moving away from the threshold is not a door attempt",
  );
  assert.equal(
    isDoorWedgeTraversalAttempt(receipt, { x: 3.5, y: 2.3 }, { x: 0, y: -1 }),
    false,
    "an adjacent wall lane cannot trigger the wedge",
  );
});

test("all ten campaign chapters expose real narrow thresholds and opaque corners", () => {
  for (const level of CAMPAIGN_LEVELS) {
    const walkableCells = [];
    for (let y = 0; y < level.height; y += 1) {
      for (let x = 0; x < level.width; x += 1) {
        if (level.walkable[y]?.[x]) walkableCells.push({ x, y });
      }
    }
    const door = walkableCells
      .map((position) => resolveStealthToolTarget(
        "door-wedge",
        level,
        position,
        { x: 0, y: 1 },
        level.exit,
      ))
      .find(Boolean);
    const mirror = walkableCells
      .map((position) => resolveStealthToolTarget(
        "corner-mirror",
        level,
        position,
        { x: 0, y: 1 },
        level.exit,
      ))
      .find(Boolean);
    assert.ok(door, `${level.id} has no authored narrow threshold`);
    assert.ok(mirror, `${level.id} has no perpendicular opaque corner`);
  }
});

test("a generic wall edge cannot masquerade as a door or opaque corner", () => {
  const wallEdge = levelFromRows({
    id: "wall-edge-only",
    rows: [
      "#######",
      "#.....#",
      "#.....#",
      "#######",
    ],
  });
  for (const tool of ["door-wedge", "corner-mirror"]) {
    assert.equal(
      resolveStealthToolTarget(
        tool,
        wallEdge,
        { x: 3, y: 1 },
        { x: 1, y: 0 },
        { x: 3, y: 2 },
      ),
      null,
      `${tool} accepted a non-semantic wall edge`,
    );
  }
});

test("occupancy metamorphic: hide/runtime-only changes cannot retarget any stealth tool", () => {
  const occupancyVariant = {
    ...topologyLevel,
    hideSpots: [{
      id: "south-locker-runtime-variant",
      approach: { x: 3, y: 5 },
      concealed: { x: 3, y: 5.35 },
      facing: { x: 0, y: -1 },
      occupiedByPlayer: true,
    }],
    hideSpotRuntimeStates: [
      { id: "north-locker", occupiedByPlayer: false },
      { id: "south-locker-runtime-variant", occupiedByPlayer: true },
    ],
    activeHideSpotId: "south-locker-runtime-variant",
    hiddenPlayerPosition: { x: 99, y: 99 },
  };
  const actorByTool = {
    "door-wedge": { position: { x: 3.1, y: 2.1 }, heading: { x: 0, y: 1 } },
    "corner-mirror": { position: { x: 2.1, y: 3 }, heading: { x: 0, y: 1 } },
    "temporary-blackout": {
      position: { x: 3, y: 5 },
      heading: { x: -1, y: 0 },
    },
  };
  const powerCircuitPosition = { x: 3, y: 5 };

  for (const tool of [
    "door-wedge",
    "corner-mirror",
    "temporary-blackout",
  ]) {
    const actor = actorByTool[tool];
    assert.deepEqual(
      resolveStealthToolTarget(
        tool,
        occupancyVariant,
        actor.position,
        actor.heading,
        powerCircuitPosition,
      ),
      resolveStealthToolTarget(
        tool,
        topologyLevel,
        actor.position,
        actor.heading,
        powerCircuitPosition,
      ),
      `${tool} consulted hide occupancy/runtime state`,
    );
  }
});

test("blackout binds to the passed authored control console and never invents a player-relative target", () => {
  const consolePosition = { x: 3.25, y: 4.75 };
  const target = resolveStealthToolTarget(
    "temporary-blackout",
    topologyLevel,
    { x: 1, y: 3 },
    { x: -1, y: 0 },
    consolePosition,
  );
  assert.deepEqual(target, {
    kind: "power-circuit",
    id: `${topologyLevel.id}:primary-lighting-circuit`,
    interactionPoint: consolePosition,
    autoRestoreTicks: 360,
    emergencyVisibilityFloor: 0.35,
  });
  assert.notEqual(target.interactionPoint, consolePosition);

  const fromAnotherActorState = resolveStealthToolTarget(
    "temporary-blackout",
    topologyLevel,
    { x: 4, y: 3 },
    { x: 0, y: -1 },
    consolePosition,
  );
  assert.deepEqual(fromAnotherActorState, target);
});

function mirrorReceipt(effectOverrides = {}) {
  return {
    receiptId: "mirror-receipt:1",
    useId: "mirror-use:1",
    toolbeltId: "gold-stealth-toolbelt",
    tool: "corner-mirror",
    targetId: "test-corner",
    issuedAtTick: 0,
    expiresAtTick: 100,
    riskEvidence: {
      sourceId: "mirror-risk:1",
      sourceType: "stealth-tool-risk",
      tool: "corner-mirror",
      channel: "visual",
      position: { x: 2, y: 3 },
      strength: 0.14,
      confidence: 0.58,
      emittedAtTick: 0,
      expiresAtTick: 100,
    },
    effect: {
      kind: "public-corner-observation",
      cornerId: "test-corner",
      origin: { x: 2, y: 3 },
      heading: { x: 1, y: 0 },
      rangeCells: 5,
      coneDegrees: 60,
      observationEndsAtTick: 100,
      ...effectOverrides,
    },
  };
}

const openMirrorLevel = levelFromRows({
  id: "open-mirror-fixture",
  rows: Array.from({ length: 7 }, () => ".".repeat(12)),
});

test("corner mirror observation obeys inclusive range, finite cone, and rear exclusion", () => {
  const receipt = mirrorReceipt();
  assert.equal(
    canCornerMirrorObservePoint(receipt, { x: 7, y: 3 }, openMirrorLevel),
    true,
    "the exact authored range edge should remain observable",
  );
  assert.equal(
    canCornerMirrorObservePoint(
      receipt,
      { x: 7 + 1e-6, y: 3 },
      openMirrorLevel,
    ),
    false,
    "points beyond the authored range must not leak through",
  );

  const boundaryRadians = 30 * Math.PI / 180;
  assert.equal(
    canCornerMirrorObservePoint(
      receipt,
      {
        x: 2 + Math.cos(boundaryRadians) * 4,
        y: 3 + Math.sin(boundaryRadians) * 4,
      },
      openMirrorLevel,
    ),
    true,
    "the exact half-cone edge should be inclusive",
  );
  const outsideRadians = 31 * Math.PI / 180;
  assert.equal(
    canCornerMirrorObservePoint(
      receipt,
      {
        x: 2 + Math.cos(outsideRadians) * 4,
        y: 3 + Math.sin(outsideRadians) * 4,
      },
      openMirrorLevel,
    ),
    false,
  );
  assert.equal(
    canCornerMirrorObservePoint(receipt, { x: 1, y: 3 }, openMirrorLevel),
    false,
    "the mirror is an aperture, not omnidirectional actor tracking",
  );
});

test("corner mirror never bypasses authored line-of-sight blockers", () => {
  const blockedLevel = levelFromRows({
    id: "blocked-mirror-fixture",
    rows: Array.from({ length: 7 }, () => ".".repeat(12)),
    visionOnlyBlockers: [{ x: 4, y: 3 }],
  });
  assert.equal(
    canCornerMirrorObservePoint(
      mirrorReceipt(),
      { x: 7, y: 3 },
      blockedLevel,
    ),
    false,
  );
  assert.equal(
    canCornerMirrorObservePoint(
      mirrorReceipt(),
      { x: 3, y: 3 },
      blockedLevel,
    ),
    true,
    "a blocker beyond the target must not suppress a legal observation",
  );
});

function evidenceCandidate(kind, overrides = {}) {
  return {
    evidence: {
      id: `evidence:${kind}`,
      kind,
      position: { x: 4, y: 2 },
      source: {
        publicId: "public-source",
        kind: "surface",
        publicity: "world-observable",
      },
      detail: { direction: { x: 1, y: 0 } },
      createdAtTick: 20,
      ageTicks: 5,
      expiresAtTick: 200,
      confidence: 0.84,
      authenticity: "forged",
      origin: { actorId: "private-player", command: "forge" },
      hiddenPlayerPosition: { x: 9, y: 9 },
    },
    distance: 3.2,
    headingAlignment: 0.9,
    investigationScore: 0.71,
    nearestHideOccupancy: true,
    ...overrides,
  };
}

test("AI evidence adapter emits an exact public world-clue DTO whitelist", () => {
  const perception = aiEvidenceCandidateToPerception(
    evidenceCandidate("footprint"),
    12.5,
  );
  assert.deepEqual(perception, {
    kind: "world-clue",
    clueId: "evidence:footprint",
    position: { x: 4, y: 2 },
    observedAtSeconds: 12.5,
    confidence: 0.84,
    sourceType: "footprint",
    decayPerSecond: 0.055,
  });
  assert.deepEqual(Object.keys(perception).sort(), [
    "clueId",
    "confidence",
    "decayPerSecond",
    "kind",
    "observedAtSeconds",
    "position",
    "sourceType",
  ]);
  const serialized = JSON.stringify(perception);
  const serializedKeys = [];
  JSON.parse(serialized, (key, value) => {
    if (key) serializedKeys.push(key);
    return value;
  });
  for (const privateField of [
    "authenticity",
    "origin",
    "actorId",
    "hiddenPlayerPosition",
    "nearestHideOccupancy",
    "investigationScore",
    "detail",
    "source",
  ]) {
    assert.equal(serializedKeys.includes(privateField), false);
  }
  assert.equal(Object.isFrozen(perception), true);
  assert.equal(Object.isFrozen(perception.position), true);
});

test("all public evidence kinds map to bounded world-clue source categories", () => {
  const expected = {
    footprint: "footprint",
    "door-state": "door-disturbance",
    "moved-object": "disturbed-prop",
    "power-change": "infrastructure-anomaly",
    "decoy-residue": "disturbed-prop",
  };
  for (const [kind, sourceType] of Object.entries(expected)) {
    assert.equal(
      aiEvidenceCandidateToPerception(
        evidenceCandidate(kind),
        1,
      ).sourceType,
      sourceType,
    );
  }
});

function suggestion(kind, intensityPermille) {
  return {
    suggestionId: `${kind}:1`,
    sequence: 1,
    eventId: `${kind}:event`,
    label: kind,
    kind,
    publicChannelId: kind === "patrol-pressure" ? null : `${kind}:channel`,
    intensityPermille,
    blockedRouteIds: [],
    announcedAtTick: 10,
    startsAtTick: 20,
    endsAtTick: 30,
    safety: {
      sourcePolicy: "public-aggregate-signals-only",
      warningTicks: 10,
      durationTicks: 10,
      legalRouteIdsAtSuggestion: ["route-a", "route-b"],
      preservedLegalRouteIds: ["route-a", "route-b"],
      minimumLegalRouteCount: 1,
      routeGuarantee: true,
    },
  };
}

test("campaign director definition is deduplicated, bounded, announced, and route-safe", () => {
  const definition = createCampaignTensionDirectorDefinition(
    "hospital-ward",
    ["route-b", "route-a", "route-b"],
    1 / 120,
  );
  assert.deepEqual(definition.routeIds, ["route-b", "route-a"]);
  assert.equal(definition.policy.fixedStepSeconds, 1 / 120);
  assert.equal(definition.minimumLegalRouteCount, 1);
  assert.deepEqual(
    definition.events.map(({ kind }) => kind),
    ["broadcast", "patrol-pressure", "blackout"],
  );
  assert.ok(definition.events.every(({ blockedRouteIds }) => (
    blockedRouteIds.length === 0
  )));
  assert.ok(definition.events.every(({ warningTicks }) => warningTicks >= 120));
  assert.deepEqual(auditTensionDirectorDefinition(definition), {
    passed: true,
    failures: [],
    routeCount: 2,
    eventCount: 3,
  });
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.routeIds), true);
  assert.equal(Object.isFrozen(definition.events), true);

  const fallback = createCampaignTensionDirectorDefinition(
    "hospital-ward",
    [],
    1 / 60,
  );
  assert.deepEqual(fallback.routeIds, ["hospital-ward:primary-route"]);
  assert.equal(auditTensionDirectorDefinition(fallback).passed, true);

  const trace = Array.from({ length: 1_200 }, (_, index) => {
    const tick = index + 1;
    return {
      tick,
      runPhase: "playing",
      threat: "safe",
      safeTicks: tick,
      chaseTicks: 0,
      ticksSinceChaseEscape: null,
      missionProgressPermille: 1_000,
      resourcesRemainingPermille: 1_000,
      legalRouteIds: ["route-a", "route-b"],
    };
  });
  const safety = auditTensionDirectorSafety(definition, trace);
  assert.equal(safety.passed, true, safety.failures.join("\n"));
  assert.ok(safety.suggestionsAudited > 0);
  assert.equal(safety.minimumPreservedRouteCount, 2);
});

test("director modifiers remain inactive during warnings and clamp each active channel", () => {
  const baseline = {
    chaserSpeedMultiplier: 1,
    visionRangeMultiplier: 1,
    soundMasking: 0,
  };
  assert.deepEqual(tensionDirectorModifiers(null, true), baseline);
  assert.deepEqual(
    tensionDirectorModifiers(suggestion("patrol-pressure", 250), false),
    baseline,
    "warning phase must remain presentation-only",
  );
  assert.deepEqual(
    tensionDirectorModifiers(suggestion("patrol-pressure", 250), true),
    {
      chaserSpeedMultiplier: 1.25,
      visionRangeMultiplier: 1,
      soundMasking: 0,
    },
  );
  assert.deepEqual(
    tensionDirectorModifiers(suggestion("blackout", 650), true),
    {
      chaserSpeedMultiplier: 1,
      visionRangeMultiplier: 0.5,
      soundMasking: 0,
    },
  );
  assert.deepEqual(
    tensionDirectorModifiers(suggestion("broadcast", 1_000), true),
    {
      chaserSpeedMultiplier: 1,
      visionRangeMultiplier: 1,
      soundMasking: 0.42,
    },
  );
  assert.deepEqual(
    tensionDirectorModifiers(suggestion("door-cycle", 1_000), true),
    baseline,
    "the adapter cannot silently turn a topology suggestion into a stat buff",
  );
});
