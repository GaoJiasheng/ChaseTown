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
