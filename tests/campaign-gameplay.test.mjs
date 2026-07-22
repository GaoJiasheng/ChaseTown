import assert from "node:assert/strict";
import test from "node:test";

import { CAMPAIGN_LEVELS, getCampaignGameplayConfig } from "../app/game/campaign.ts";
import { distanceBetween, findPath } from "../app/game/navigation.ts";
import { GameSimulation } from "../app/game/simulation.ts";

const FRAME_SECONDS = 1 / 60;
const DIRECT_ROUTE_TIMEOUT_SECONDS = 20;
const SAFE_ROUTE_TIMEOUT_SECONDS = 60;

const CERTIFIED_HIDE_SPOTS = Object.freeze({
  "school-maze-v1": "locker-north",
  "campus-library-lockdown": "library-map-case",
  "campus-science-wing": "science-chemical-cabinet",
  "hospital-outpatient-afterhours": "hospital-pharmacy-store",
  "hospital-isolation-basement": "isolation-decon-cabinet",
  "fire-station-engine-bay": "fire-turnout-locker",
  "fire-station-training-tower": "training-landing-cabinet",
  "factory-assembly-nightshift": "assembly-tool-crate",
  "factory-turbine-hall": "turbine-breaker-cabinet",
  "factory-foundry-final-run": "foundry-slag-shield",
});

function routeIntent(level, position, target) {
  const route = findPath(level, position, target);
  assert.ok(route.length > 0, `${level.id} has no route to (${target.x}, ${target.y})`);
  const waypoint = route[1] ?? target;
  const offset = { x: waypoint.x - position.x, y: waypoint.y - position.y };
  const length = Math.hypot(offset.x, offset.y);
  return length > 1e-9 ? { x: offset.x / length, y: offset.y / length } : { x: 0, y: 0 };
}

function runDirectRoute(level) {
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: getCampaignGameplayConfig(level),
  });
  const seenModes = new Set();
  const maxFrames = DIRECT_ROUTE_TIMEOUT_SECONDS / FRAME_SECONDS;

  for (let frame = 0; frame < maxFrames && simulation.getState().phase === "playing"; frame += 1) {
    const state = simulation.getState();
    seenModes.add(state.chaser.mode);
    const next = simulation.advance(FRAME_SECONDS, {
      move: routeIntent(level, state.player.position, level.exit),
    });
    seenModes.add(next.chaser.mode);
  }

  return { state: simulation.getState(), seenModes };
}

function runCertifiedHideRoute(level, hideSpotId) {
  const hideSpot = level.hideSpots.find((spot) => spot.id === hideSpotId);
  assert.ok(hideSpot, `${level.id} is missing certified hide spot ${hideSpotId}`);

  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: getCampaignGameplayConfig(level),
  });
  const seenModes = new Set();
  let stage = "draw-attention";
  let hiddenSeconds = 0;
  let patrolSeconds = 0;
  let reachedHidden = false;
  const maxFrames = SAFE_ROUTE_TIMEOUT_SECONDS / FRAME_SECONDS;

  for (let frame = 0; frame < maxFrames && simulation.getState().phase === "playing"; frame += 1) {
    const state = simulation.getState();
    const input = {};
    seenModes.add(state.chaser.mode);

    if (stage === "draw-attention" && ["suspicious", "chase", "lost-sight"].includes(state.chaser.mode)) {
      stage = "reach-hide-spot";
    }

    if (stage === "draw-attention") {
      input.move = routeIntent(level, state.player.position, level.exit);
    } else if (stage === "reach-hide-spot") {
      if (distanceBetween(state.player.position, hideSpot.approach) <= 0.72) {
        input.interactPressed = true;
        stage = "enter-hide-spot";
      } else {
        input.move = routeIntent(level, state.player.position, hideSpot.approach);
      }
    } else if (stage === "enter-hide-spot" && state.player.mode === "hidden") {
      reachedHidden = true;
      stage = "wait-until-clear";
    } else if (stage === "wait-until-clear") {
      hiddenSeconds += FRAME_SECONDS;
      patrolSeconds = state.chaser.mode === "patrol" ? patrolSeconds + FRAME_SECONDS : 0;
      if (patrolSeconds >= 1 || hiddenSeconds >= 9) {
        input.interactPressed = true;
        stage = "exit-hide-spot";
      }
    } else if (stage === "exit-hide-spot" && state.player.mode === "free") {
      stage = "escape";
    } else if (stage === "escape") {
      input.move = routeIntent(level, state.player.position, level.exit);
    }

    const next = simulation.advance(FRAME_SECONDS, input);
    seenModes.add(next.chaser.mode);
  }

  return { state: simulation.getState(), seenModes, reachedHidden, stage };
}

test("all ten campaign levels punish a shortest-path sprint with chase and capture at 60 Hz", async (t) => {
  assert.equal(CAMPAIGN_LEVELS.length, 10);

  for (const level of CAMPAIGN_LEVELS) {
    await t.test(`${level.campaign.levelNumber}. ${level.id}`, () => {
      const result = runDirectRoute(level);
      assert.equal(result.seenModes.has("suspicious"), true, `${level.id} never warns the player`);
      assert.equal(result.seenModes.has("chase"), true, `${level.id} never establishes a chase`);
      assert.equal(result.state.phase, "lost", `${level.id} shortest route escaped or timed out`);
      assert.equal(result.state.player.mode, "caught", `${level.id} must end through capture`);
    });
  }
});

test("all ten certified hide routes break pursuit and reach the exit at 60 Hz", async (t) => {
  assert.deepEqual(Object.keys(CERTIFIED_HIDE_SPOTS), CAMPAIGN_LEVELS.map((level) => level.id));

  for (const level of CAMPAIGN_LEVELS) {
    await t.test(`${level.campaign.levelNumber}. ${level.id}`, () => {
      const result = runCertifiedHideRoute(level, CERTIFIED_HIDE_SPOTS[level.id]);
      assert.equal(result.seenModes.has("suspicious") || result.seenModes.has("chase"), true, `${level.id} route never draws attention`);
      assert.equal(result.reachedHidden, true, `${level.id} never completes its hide transition`);
      assert.equal(result.state.phase, "won", `${level.id} safe route ended at ${result.stage}`);
      assert.equal(result.state.player.mode, "escaped", `${level.id} must finish at the exit`);
    });
  }
});
