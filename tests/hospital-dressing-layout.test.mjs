import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS } from "../app/game/campaign.ts";
import { buildEnvironmentCompositionPlan } from "../app/game/environment-composition.ts";
import { selectNarrativeRoomAnchors } from "../app/game/hospital-cinematic-composition.ts";
import {
  HOSPITAL_DRESSING_FOOTPRINTS,
  HOSPITAL_DRESSING_MINIMUM_CLEARANCE_CELLS,
  hospitalDressingFootprintAt,
  hospitalDressingFootprintsOverlap,
  planHospitalDressingLayout,
} from "../app/game/hospital-dressing-layout.ts";
import {
  HOSPITAL_BRANCHING_MISSION,
  hospitalMissionLevelForPlan,
} from "../app/game/hospital-branching-mission.ts";
import { distanceBetween } from "../app/game/navigation.ts";
import {
  certifiedRemixContractsForLevel,
  resolveCertifiedRemix,
} from "../app/game/remix-contracts.ts";
import {
  enclosedRoomFloorRegions,
  roomFloorSupportForFootprint,
} from "../app/game/room-floor.ts";

const HOSPITAL_FEATURED_NODES = Object.freeze({
  "hospital-outpatient": Object.freeze([
    "HospitalBed",
    "HospitalIVStation",
    "HospitalCrashCart",
    "HospitalPrivacyScreen",
  ]),
  "hospital-isolation": Object.freeze([
    "HospitalPrivacyScreen",
    "HospitalBed",
    "HospitalIVStation",
    "HospitalCrashCart",
  ]),
});

const WALL_VARIANT_SALT = Object.freeze({
  "hospital-outpatient": 41,
  "hospital-isolation": 53,
});

function runtimeRoomSafeDecorAnchors(level) {
  const occupiedAnchors = [
    level.playerStart,
    level.chaserStart,
    level.exit,
    ...level.hideSpots.flatMap((spot) => [spot.approach, spot.concealed]),
  ];
  const candidates = [];
  for (let y = 1; y < level.height - 1; y += 1) {
    for (let x = 1; x < level.width - 1; x += 1) {
      if (level.walkable[y][x]) continue;
      const towardPath = { x: 0, y: 0 };
      for (const direction of [
        { x: -1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: -1 },
        { x: 0, y: 1 },
      ]) {
        if (!level.walkable[y + direction.y]?.[x + direction.x]) continue;
        towardPath.x += direction.x;
        towardPath.y += direction.y;
      }
      if (Math.hypot(towardPath.x, towardPath.y) < 0.1) continue;
      const cell = { x, y };
      if (occupiedAnchors.some((anchor) => distanceBetween(anchor, cell) < 1.35)) {
        continue;
      }
      const length = Math.hypot(towardPath.x, towardPath.y);
      const direction = {
        x: towardPath.x / length,
        y: towardPath.y / length,
      };
      candidates.push({
        cell,
        point: {
          x: x - direction.x * 0.72,
          y: y - direction.y * 0.72,
        },
        rotation: Math.atan2(direction.x, direction.y),
      });
    }
  }
  const propSet = level.campaign.atmosphere.propSet;
  const wallVariantSalt = WALL_VARIANT_SALT[propSet];
  assert.ok(Number.isFinite(wallVariantSalt), `${propSet} has no wall salt`);
  candidates.sort((left, right) => {
    const hash = (anchor) => (
      anchor.cell.x * 37
      + anchor.cell.y * 61
      + level.campaign.levelNumber * 17
      + wallVariantSalt
    ) % 101;
    return hash(left) - hash(right);
  });
  const decorAnchors = [];
  for (const candidate of candidates) {
    if (
      decorAnchors.every(
        (existing) => distanceBetween(existing.cell, candidate.cell) >= 3.4,
      )
    ) decorAnchors.push(candidate);
    if (decorAnchors.length >= 14) break;
  }
  const roomTopology = enclosedRoomFloorRegions(level);
  return {
    roomTopology,
    anchors: decorAnchors.filter((anchor) => roomFloorSupportForFootprint(
      level,
      roomTopology,
      {
        center: anchor.point,
        halfWidth: 0.34,
        halfDepth: 0.34,
        rotationRadians: anchor.rotation,
      },
    ).supported),
  };
}

function hospitalRuntimeCases() {
  const cases = [];
  for (const source of CAMPAIGN_LEVELS.filter(
    ({ campaign }) => campaign.theme === "hospital",
  )) {
    if (source.id === HOSPITAL_BRANCHING_MISSION.levelId) {
      for (const plan of HOSPITAL_BRANCHING_MISSION.plans) {
        cases.push({
          id: `${source.id}:base:${plan.id}`,
          level: hospitalMissionLevelForPlan(source, plan.id),
        });
      }
    } else {
      cases.push({ id: `${source.id}:base`, level: source });
    }
    for (const contract of certifiedRemixContractsForLevel(source)) {
      cases.push({
        id: contract.id,
        level: resolveCertifiedRemix(source, contract).level,
      });
    }
  }
  return cases;
}

function planRuntimeHospitalDressing(level) {
  const { anchors: roomSafeDecorAnchors, roomTopology } =
    runtimeRoomSafeDecorAnchors(level);
  const selections = selectNarrativeRoomAnchors(
    buildEnvironmentCompositionPlan(level).landmarkBeats,
    roomSafeDecorAnchors,
  );
  assert.equal(
    selections.filter(({ matched }) => matched).length,
    3,
    `${level.id} must retain three narrative anchors`,
  );
  const narrativeAnchors = selections.map(({ anchor }) => anchor);
  const narrativeKeys = new Set(
    narrativeAnchors.map(({ point }) => (
      `${point.x.toFixed(5)}:${point.y.toFixed(5)}`
    )),
  );
  const bays = roomSafeDecorAnchors.filter(({ point }) => (
    !narrativeKeys.has(`${point.x.toFixed(5)}:${point.y.toFixed(5)}`)
  ));
  const featuredNodes =
    HOSPITAL_FEATURED_NODES[level.campaign.atmosphere.propSet];
  assert.ok(featuredNodes, `${level.id} must use a known hospital prop set`);
  const ambientTarget = Math.max(
    1,
    Math.min(
      bays.length,
      3 + Math.ceil(level.campaign.difficulty / 2),
    ),
  );
  const requests = [
    ...featuredNodes.map((node) => ({
      id: `featured:${node}`,
      category: "featured",
      footprint: HOSPITAL_DRESSING_FOOTPRINTS[node],
    })),
    {
      id: "shared:bulletin",
      category: "shared",
      footprint: HOSPITAL_DRESSING_FOOTPRINTS.bulletin,
    },
    ...Array.from({ length: ambientTarget }, (_, index) => ({
      id: `ambient:${index + 1}`,
      category: "ambient",
      footprint: HOSPITAL_DRESSING_FOOTPRINTS.ambientCluster,
    })),
  ];
  const reservations = narrativeAnchors.map((anchor, index) => ({
    id: `narrative:${index + 1}`,
    category: "narrative",
    footprint: hospitalDressingFootprintAt(
      anchor,
      HOSPITAL_DRESSING_FOOTPRINTS.narrativeCluster,
    ),
  }));
  const layout = planHospitalDressingLayout(
    bays,
    requests,
    reservations,
    {
      supportsFootprint: (footprint) => roomFloorSupportForFootprint(
        level,
        roomTopology,
        footprint,
      ).supported,
    },
  );
  return {
    ambientTarget,
    featuredNodes,
    layout,
    roomTopology,
  };
}

test("every real hospital base/branch/certified layout places complete disjoint dressing", () => {
  const cases = hospitalRuntimeCases();
  assert.equal(cases.length, 9);

  for (const { id, level } of cases) {
    const {
      ambientTarget,
      featuredNodes,
      layout,
      roomTopology,
    } = planRuntimeHospitalDressing(level);
    assert.deepEqual(layout.unplacedIds, [], `${id} starved hospital dressing`);

    const placementIds = new Set(layout.placements.map(({ id: value }) => value));
    assert.ok(placementIds.has("shared:bulletin"), `${id} omitted HospitalBulletin`);
    for (const node of featuredNodes) {
      assert.ok(placementIds.has(`featured:${node}`), `${id} omitted ${node}`);
    }
    if (level.campaign.atmosphere.propSet === "hospital-outpatient") {
      assert.ok(placementIds.has("featured:HospitalIVStation"));
      assert.ok(placementIds.has("featured:HospitalCrashCart"));
    } else {
      assert.ok(placementIds.has("featured:HospitalIVStation"));
      assert.ok(placementIds.has("featured:HospitalPrivacyScreen"));
    }
    assert.equal(
      layout.placements.filter(({ category }) => category === "ambient").length,
      ambientTarget,
      `${id} omitted an ambient room cluster`,
    );
    assert.ok(ambientTarget >= 1, `${id} must render an ambient room cluster`);

    for (const placement of layout.placements) {
      assert.equal(
        roomFloorSupportForFootprint(
          level,
          roomTopology,
          placement.footprint,
        ).supported,
        true,
        `${id} placed ${placement.id} outside its enclosed room floor`,
      );
    }
    const occupancies = [
      ...layout.reservations.map(({ id: value, footprint }) => ({
        id: value,
        footprint,
      })),
      ...layout.placements.map(({ id: value, footprint }) => ({
        id: value,
        footprint,
      })),
    ];
    for (let index = 0; index < occupancies.length; index += 1) {
      for (let other = index + 1; other < occupancies.length; other += 1) {
        assert.equal(
          hospitalDressingFootprintsOverlap(
            occupancies[index].footprint,
            occupancies[other].footprint,
            HOSPITAL_DRESSING_MINIMUM_CLEARANCE_CELLS,
          ),
          false,
          `${id} overlaps ${occupancies[index].id} and ${occupancies[other].id}`,
        );
      }
    }
  }
});

test("oriented footprint separation and starvation reporting fail closed", () => {
  const horizontal = {
    center: { x: 0, y: 0 },
    halfWidth: 0.7,
    halfDepth: 0.1,
    rotationRadians: 0,
  };
  const crossing = {
    center: { x: 0.25, y: 0 },
    halfWidth: 0.7,
    halfDepth: 0.1,
    rotationRadians: Math.PI / 2,
  };
  const separated = {
    ...crossing,
    center: { x: 1.1, y: 0 },
  };
  assert.equal(hospitalDressingFootprintsOverlap(horizontal, crossing), true);
  assert.equal(hospitalDressingFootprintsOverlap(horizontal, separated), false);

  const impossible = planHospitalDressingLayout(
    [],
    [{
      id: "shared:bulletin",
      category: "shared",
      footprint: HOSPITAL_DRESSING_FOOTPRINTS.bulletin,
    }],
    [],
  );
  assert.deepEqual(impossible.placements, []);
  assert.deepEqual(impossible.unplacedIds, ["shared:bulletin"]);
});
