import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_LEVEL_COUNT,
  CAMPAIGN_LEVELS,
  getCampaignLevelById,
  getCampaignLevelByIndex,
  getCampaignLevelByNumber,
  getCampaignLevelsByTheme,
} from "../app/game/campaign.ts";
import { createLevel } from "../app/game/level.ts";
import { distanceBetween, findPath, isWalkable, neighbors } from "../app/game/navigation.ts";

const CARDINAL_DIRECTIONS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const gridKey = (point) => `${point.x},${point.y}`;

function graphDistances(level, origin) {
  const distances = new Map([[gridKey(origin), 0]]);
  const queue = [origin];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const distance = distances.get(gridKey(current));
    for (const neighbor of neighbors(level, current)) {
      const key = gridKey(neighbor);
      if (distances.has(key)) continue;
      distances.set(key, distance + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

/** Tie-independent shape metrics across the complete shortest-path DAG. */
function shortestRouteShape(level) {
  const fromStart = graphDistances(level, level.playerStart);
  const fromExit = graphDistances(level, level.exit);
  const shortestEdges = fromStart.get(gridKey(level.exit));
  assert.notEqual(shortestEdges, undefined, `${level.id} has no escape route`);

  const dagCells = [];
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const key = gridKey({ x, y });
      const startDistance = fromStart.get(key);
      const exitDistance = fromExit.get(key);
      if (startDistance !== undefined && exitDistance !== undefined && startDistance + exitDistance === shortestEdges) {
        dagCells.push({ x, y, startDistance });
      }
    }
  }
  dagCells.sort((left, right) => left.startDistance - right.startDistance);

  // Direction -1 is the start sentinel.  Turns and straight runs deliberately
  // use separate dynamic programs so a high-turn route cannot hide a longer
  // straight sprint lane that has the same endpoints.
  const minimumTurns = new Map([[gridKey(level.playerStart), new Map([[-1, 0]])]]);
  const longestCurrentRuns = new Map([[gridKey(level.playerStart), new Map([[-1, 0]])]]);
  let maximumStraightRun = 0;

  for (const cell of dagCells) {
    const cellKey = gridKey(cell);
    const turnsAtCell = minimumTurns.get(cellKey);
    const runsAtCell = longestCurrentRuns.get(cellKey);
    for (const [nextDirection, direction] of CARDINAL_DIRECTIONS.entries()) {
      const next = { x: cell.x + direction.x, y: cell.y + direction.y };
      const nextKey = gridKey(next);
      if (fromStart.get(nextKey) !== cell.startDistance + 1) continue;
      if (cell.startDistance + 1 + fromExit.get(nextKey) !== shortestEdges) continue;

      for (const [previousDirection, turnCount] of turnsAtCell ?? []) {
        const nextTurns = turnCount + Number(previousDirection !== -1 && previousDirection !== nextDirection);
        const turnsAtNext = minimumTurns.get(nextKey) ?? new Map();
        const previousBest = turnsAtNext.get(nextDirection);
        if (previousBest === undefined || nextTurns < previousBest) turnsAtNext.set(nextDirection, nextTurns);
        minimumTurns.set(nextKey, turnsAtNext);
      }

      for (const [previousDirection, runLength] of runsAtCell ?? []) {
        const nextRun = previousDirection === nextDirection ? runLength + 1 : 1;
        maximumStraightRun = Math.max(maximumStraightRun, nextRun);
        const runsAtNext = longestCurrentRuns.get(nextKey) ?? new Map();
        const previousLongest = runsAtNext.get(nextDirection);
        if (previousLongest === undefined || nextRun > previousLongest) runsAtNext.set(nextDirection, nextRun);
        longestCurrentRuns.set(nextKey, runsAtNext);
      }
    }
  }

  const exitTurns = minimumTurns.get(gridKey(level.exit));
  assert.ok(exitTurns?.size, `${level.id} shortest-path DAG did not reach the exit`);
  return { minimumTurns: Math.min(...exitTurns.values()), maximumStraightRun };
}

test("campaign exposes ten ordered, immutable and directly compatible levels", () => {
  assert.equal(CAMPAIGN_LEVEL_COUNT, 10);
  assert.equal(CAMPAIGN_LEVELS.length, 10);
  assert.equal(Object.isFrozen(CAMPAIGN_LEVELS), true);

  for (const [index, level] of CAMPAIGN_LEVELS.entries()) {
    assert.equal(level.campaign.levelNumber, index + 1);
    assert.equal(createLevel(level), level, `${level.id} must satisfy the LevelDefinition validation boundary`);
    assert.equal(Object.isFrozen(level), true);
    assert.equal(Object.isFrozen(level.walkable), true);
    assert.equal(Object.isFrozen(level.campaign), true);
  }
});

test("campaign identity, presentation metadata and atmosphere tokens are authored per level", () => {
  const ids = new Set();
  const names = new Set();
  const subtitles = new Set();
  const palettes = new Set();
  const scores = new Set();
  const propSets = new Set();
  const colorToken = /^#[0-9a-f]{6}$/i;

  for (const level of CAMPAIGN_LEVELS) {
    const { campaign } = level;
    ids.add(level.id);
    names.add(campaign.name);
    subtitles.add(campaign.subtitle);
    palettes.add(Object.values(campaign.palette).join("/"));
    scores.add(campaign.atmosphere.score);
    propSets.add(campaign.atmosphere.propSet);
    assert.ok(campaign.briefing.length >= 20, `${level.id} needs a useful player briefing`);
    assert.ok(campaign.landmarks.length >= 3, `${level.id} needs enough authored landmarks`);
    assert.ok(Object.values(campaign.palette).every((token) => colorToken.test(token)));
    assert.ok(Object.values(campaign.atmosphere).every(Boolean));
  }

  assert.equal(ids.size, CAMPAIGN_LEVEL_COUNT);
  assert.equal(names.size, CAMPAIGN_LEVEL_COUNT);
  assert.equal(subtitles.size, CAMPAIGN_LEVEL_COUNT);
  assert.equal(palettes.size, CAMPAIGN_LEVEL_COUNT);
  assert.equal(scores.size, CAMPAIGN_LEVEL_COUNT);
  assert.equal(propSets.size, CAMPAIGN_LEVEL_COUNT);
});

test("campaign covers all requested themes with a progressive difficulty curve", () => {
  const expectedThemeCounts = new Map([
    ["campus", 3],
    ["hospital", 2],
    ["fire-station", 2],
    ["factory", 3],
  ]);
  const difficulties = CAMPAIGN_LEVELS.map((level) => level.campaign.difficulty);

  for (const [theme, expectedCount] of expectedThemeCounts) {
    const themedLevels = getCampaignLevelsByTheme(theme);
    assert.equal(themedLevels.length, expectedCount);
    assert.ok(themedLevels.every((level) => level.campaign.theme === theme));
  }
  assert.deepEqual([...difficulties].sort((a, b) => a - b), difficulties);
  assert.equal(difficulties[0], 1);
  assert.equal(difficulties.at(-1), 5);
});

test("campaign lookup supports ids, zero-based indexes and player-facing numbers", () => {
  for (const [index, level] of CAMPAIGN_LEVELS.entries()) {
    assert.equal(getCampaignLevelById(level.id), level);
    assert.equal(getCampaignLevelByIndex(index), level);
    assert.equal(getCampaignLevelByNumber(index + 1), level);
  }
  assert.equal(getCampaignLevelById("missing"), undefined);
  assert.equal(getCampaignLevelByIndex(-1), undefined);
  assert.equal(getCampaignLevelByIndex(CAMPAIGN_LEVEL_COUNT), undefined);
  assert.equal(getCampaignLevelByIndex(1.5), undefined);
  assert.equal(getCampaignLevelByNumber(0), undefined);
  assert.equal(getCampaignLevelByNumber(CAMPAIGN_LEVEL_COUNT + 1), undefined);
});

test("every campaign layout has a meaningful, connected maze and reachable gameplay anchors", () => {
  for (const level of CAMPAIGN_LEVELS) {
    const escapeRoute = findPath(level, level.playerStart, level.exit);
    assert.ok(escapeRoute.length >= 20, `${level.id} needs a substantial escape route`);
    assert.ok(findPath(level, level.chaserStart, level.playerStart).length > 0, `${level.id} must use one connected play space`);
    assert.ok(level.patrol.length >= 5, `${level.id} needs a real patrol circuit`);
    assert.ok(level.hideSpots.length >= 2, `${level.id} needs multiple hiding choices`);

    for (const waypoint of level.patrol) {
      assert.ok(findPath(level, level.chaserStart, waypoint).length > 0, `${level.id} patrol point is unreachable`);
    }
    for (const hideSpot of level.hideSpots) {
      assert.ok(findPath(level, level.playerStart, hideSpot.approach).length > 0, `${hideSpot.id} is unreachable`);
      const concealOffset = distanceBetween(hideSpot.approach, hideSpot.concealed);
      assert.ok(concealOffset >= 0.25 && concealOffset <= 0.5, `${hideSpot.id} conceal anchor is not aligned to its approach`);
      assert.ok(Math.abs(Math.hypot(hideSpot.facing.x, hideSpot.facing.y) - 1) < 1e-9, `${hideSpot.id} facing must be normalized`);
      const backingCell = {
        x: Math.round(hideSpot.approach.x - hideSpot.facing.x),
        y: Math.round(hideSpot.approach.y - hideSpot.facing.y),
      };
      assert.equal(isWalkable(level, backingCell), false, `${hideSpot.id} must be wall-backed rather than floating in a corridor`);
    }
    for (const blocker of level.visionOnlyBlockers ?? []) {
      assert.equal(isWalkable(level, blocker), true, `${level.id} sight blocker must preserve movement`);
    }

    let junctionCount = 0;
    for (let y = 0; y < level.height; y += 1) {
      for (let x = 0; x < level.width; x += 1) {
        if (isWalkable(level, { x, y }) && neighbors(level, { x, y }).length >= 3) junctionCount += 1;
      }
    }
    assert.ok(junctionCount >= 4, `${level.id} needs branching route choices rather than a single corridor`);
  }
});

test("all ten polished layouts meet the authored maze-complexity contract", () => {
  const minimumCycleRanks = [6, 13, 15, 7, 22, 20, 15, 17, 15, 23];
  const minimumJunctions = [15, 21, 27, 15, 43, 36, 29, 31, 27, 44];
  const minimumEscapePathNodes = [46, 44, 44, 43, 51, 41, 33, 41, 55, 45];

  for (const [index, level] of CAMPAIGN_LEVELS.entries()) {
    const nodes = [];
    let edgeDegreeSum = 0;
    let junctions = 0;
    let isolated = 0;
    for (let y = 0; y < level.height; y += 1) {
      for (let x = 0; x < level.width; x += 1) {
        const cell = { x, y };
        if (!isWalkable(level, cell)) continue;
        nodes.push(cell);
        const degree = neighbors(level, cell).length;
        edgeDegreeSum += degree;
        if (degree >= 3) junctions += 1;
        if (degree === 0) isolated += 1;
      }
    }

    const visited = new Set();
    let components = 0;
    for (const origin of nodes) {
      const key = `${origin.x},${origin.y}`;
      if (visited.has(key)) continue;
      components += 1;
      visited.add(key);
      const queue = [origin];
      while (queue.length) {
        for (const neighbor of neighbors(level, queue.shift())) {
          const neighborKey = `${neighbor.x},${neighbor.y}`;
          if (visited.has(neighborKey)) continue;
          visited.add(neighborKey);
          queue.push(neighbor);
        }
      }
    }

    const edges = edgeDegreeSum / 2;
    const cycleRank = edges - nodes.length + components;
    const escapePathNodes = findPath(level, level.playerStart, level.exit).length;
    assert.equal(components, 1, `${level.id} must remain one connected maze`);
    assert.equal(isolated, 0, `${level.id} cannot ship isolated decorative floor cells`);
    assert.ok(cycleRank >= minimumCycleRanks[index], `${level.id} needs more meaningful route loops`);
    assert.ok(junctions >= minimumJunctions[index], `${level.id} needs more route decisions`);
    assert.ok(escapePathNodes >= minimumEscapePathNodes[index], `${level.id} escape route became too short`);
  }
});

test("every shortest escape option preserves authored turn density and rejects long sprint lanes", () => {
  const minimumTurns = [8, 5, 6, 7, 15, 6, 9, 8, 14, 14];
  const maximumStraightRuns = [9, 13, 11, 11, 6, 9, 8, 12, 7, 7];

  for (const [index, level] of CAMPAIGN_LEVELS.entries()) {
    const shape = shortestRouteShape(level);
    assert.ok(
      shape.minimumTurns >= minimumTurns[index],
      `${level.id} exposes a shortest route with only ${shape.minimumTurns} turns`,
    );
    assert.ok(
      shape.maximumStraightRun <= maximumStraightRuns[index],
      `${level.id} exposes a ${shape.maximumStraightRun}-cell straight sprint lane`,
    );
  }
});
