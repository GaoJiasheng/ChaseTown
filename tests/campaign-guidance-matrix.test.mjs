import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMPAIGN_LEVELS,
  getCampaignGameplayConfig,
  getCampaignHideGuidancePolicy,
} from "../app/game/campaign.ts";
import {
  planHideGuidance,
  stabilizeHideGuidance,
} from "../app/game/hide-guidance.ts";
import { distanceBetween, findPath, hasLineOfSight } from "../app/game/navigation.ts";
import { isPlayerVisuallyExposed } from "../app/game/perception.ts";
import { GameSimulation } from "../app/game/simulation.ts";

const FRAME_SECONDS = 1 / 60;
const OBSERVATION_RANGE = 9;
const REACTION_DELAYS = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
const PACES = Object.freeze(["sprint", "light-step"]);
const THREAT_MODES = new Set(["suspicious", "chase", "lost-sight", "go-to-last-known"]);

function routeIntent(level, position, target) {
  const route = findPath(level, position, target);
  assert.ok(route.length > 0, `${level.id} has no route to (${target.x}, ${target.y})`);
  const waypoint = route[1] ?? target;
  const offset = { x: waypoint.x - position.x, y: waypoint.y - position.y };
  const length = Math.hypot(offset.x, offset.y);
  return length > 1e-9 ? { x: offset.x / length, y: offset.y / length } : { x: 0, y: 0 };
}

function canPlayerObserveChaser(state, level, config) {
  return isPlayerVisuallyExposed(state.player, config)
    && distanceBetween(state.player.position, state.chaser.position) <= OBSERVATION_RANGE
    && hasLineOfSight(level, state.player.position, state.chaser.position);
}

function runLockerAttempt(level, hideSpotId, reactionDelaySeconds, pace) {
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: getCampaignGameplayConfig(level),
  });
  const hideSpot = level.hideSpots.find((spot) => spot.id === hideSpotId);
  assert.ok(hideSpot);
  let stage = "draw-attention";
  let reactionRemaining = reactionDelaySeconds;
  let lastHeardAtSeconds = null;
  let heardEvidenceChanges = 0;
  let firstThreatTick = null;
  const modes = [];

  for (let frame = 0; frame < 2_400; frame += 1) {
    const state = simulation.getState();
    if (modes.at(-1) !== state.chaser.mode) modes.push(state.chaser.mode);
    if (
      state.chaser.memory.lastHeardAtSeconds !== null
      && state.chaser.memory.lastHeardAtSeconds !== lastHeardAtSeconds
    ) {
      heardEvidenceChanges += 1;
      lastHeardAtSeconds = state.chaser.memory.lastHeardAtSeconds;
    }
    if (state.phase !== "playing" || state.player.mode === "hidden") {
      return Object.freeze({
        outcome: state.player.mode === "hidden" ? "hidden" : state.phase,
        captureReason: state.captureReason,
        firstThreatTick,
        finishTick: state.tick,
        heardEvidenceChanges,
        modes: Object.freeze(modes),
      });
    }

    const input = {};
    if (stage === "draw-attention" && THREAT_MODES.has(state.chaser.mode)) {
      firstThreatTick = state.tick;
      stage = reactionRemaining > 0 ? "reaction-delay" : "reach-locker";
    }
    if (stage === "draw-attention" || stage === "reaction-delay") {
      input.move = routeIntent(level, state.player.position, level.exit);
      if (stage === "reaction-delay") {
        reactionRemaining -= FRAME_SECONDS;
        if (reactionRemaining <= 1e-9) stage = "reach-locker";
      }
    } else if (stage === "reach-locker") {
      if (distanceBetween(state.player.position, hideSpot.approach) <= 0.72) {
        input.interactPressed = true;
      } else {
        input.move = routeIntent(level, state.player.position, hideSpot.approach);
      }
      if (pace === "light-step") input.sneakHeld = true;
    }
    simulation.advance(FRAME_SECONDS, input);
  }
  return Object.freeze({
    outcome: "timeout",
    captureReason: null,
    firstThreatTick,
    finishTick: simulation.getState().tick,
    heardEvidenceChanges,
    modes: Object.freeze(modes),
  });
}

function runGuidedRecovery(level) {
  const simulation = new GameSimulation({
    level,
    autoStart: true,
    config: getCampaignGameplayConfig(level),
  });
  const config = simulation.config;
  const tutorialHideSpotId = getCampaignHideGuidancePolicy(level).tutorialHideSpotId;
  let stage = "draw-attention";
  let knownChaser = null;
  let targetState = null;
  let patrolSeconds = 0;
  let quietEscapeSeconds = 0;
  let hideCount = 0;
  let breakSightCount = 0;

  for (let frame = 0; frame < 6_000 && simulation.getState().phase === "playing"; frame += 1) {
    const state = simulation.getState();
    const input = {};
    if (canPlayerObserveChaser(state, level, config)) {
      knownChaser = Object.freeze({
        position: { ...state.chaser.position },
        playerPositionAtObservation: { ...state.player.position },
        observedAtSeconds: state.elapsedSeconds,
      });
    }
    const threat = THREAT_MODES.has(state.chaser.mode);
    if (stage === "draw-attention" && threat) stage = "seek-cover";
    if (stage === "escape" && threat) {
      stage = "seek-cover";
      targetState = null;
    }

    if (stage === "draw-attention") {
      input.move = routeIntent(level, state.player.position, level.exit);
    } else if (stage === "seek-cover") {
      const rawPlan = planHideGuidance(level, {
        playerPosition: state.player.position,
        nowSeconds: state.elapsedSeconds,
        playerSpeed: config.playerSpeed,
        chaserSpeed: config.chaserSpeed,
        hideEnterExposureSeconds: config.hideEnterExposureSeconds,
        knownChaser,
        tutorialHideSpotId,
        searchHideCheckBudget: config.searchHideCheckBudget,
        searchHideRadiusCells: config.searchHideRadiusCells,
      });
      const stable = stabilizeHideGuidance(
        rawPlan,
        targetState,
        state.elapsedSeconds,
        { playerPosition: state.player.position },
      );
      targetState = stable.targetState;
      const plan = stable.plan;
      if (!plan) {
        input.move = routeIntent(level, state.player.position, level.exit);
      } else if (plan.strategy === "break-line-of-sight") {
        breakSightCount += 1;
        input.move = routeIntent(level, state.player.position, plan.waypoint ?? level.exit);
      } else {
        const spot = level.hideSpots.find((candidate) => (
          candidate.id === plan.recommended.hideSpotId
        ));
        assert.ok(spot);
        if (distanceBetween(state.player.position, spot.approach) <= 0.72) {
          input.interactPressed = true;
          stage = "enter-locker";
          targetState = null;
        } else {
          input.move = routeIntent(level, state.player.position, spot.approach);
        }
      }
    } else if (stage === "enter-locker" && state.player.mode === "hidden") {
      hideCount += 1;
      patrolSeconds = 0;
      stage = "wait-until-clear";
    } else if (stage === "wait-until-clear") {
      patrolSeconds = state.chaser.mode === "patrol"
        ? patrolSeconds + FRAME_SECONDS
        : 0;
      if (patrolSeconds >= 1) {
        input.interactPressed = true;
        stage = "exit-locker";
      }
    } else if (stage === "exit-locker" && state.player.mode === "free") {
      quietEscapeSeconds = 1.5;
      stage = "escape";
    } else if (stage === "escape") {
      input.move = routeIntent(level, state.player.position, level.exit);
      if (quietEscapeSeconds > 0) {
        input.sneakHeld = true;
        quietEscapeSeconds -= FRAME_SECONDS;
      }
    }
    simulation.advance(FRAME_SECONDS, input);
  }

  return Object.freeze({
    state: simulation.getState(),
    hideCount,
    breakSightCount,
  });
}

test("campaign reaction/locker/pace matrix is complete, deterministic, and bounded", () => {
  const signatures = [];
  const lockerIds = new Set();
  for (const level of CAMPAIGN_LEVELS) {
    for (const spot of level.hideSpots) {
      lockerIds.add(spot.id);
      for (const delay of REACTION_DELAYS) {
        for (const pace of PACES) {
          const first = runLockerAttempt(level, spot.id, delay, pace);
          const second = runLockerAttempt(level, spot.id, delay, pace);
          assert.deepEqual(second, first, `${level.id}/${spot.id}/${delay}/${pace} drifted`);
          assert.notEqual(first.outcome, "timeout", `${level.id}/${spot.id}/${delay}/${pace} timed out`);
          if (first.outcome === "lost") assert.ok(first.captureReason);
          signatures.push({ level: level.id, locker: spot.id, delay, pace, ...first });
        }
      }
    }
  }

  assert.equal(lockerIds.size, 30);
  assert.equal(signatures.length, 300);
  for (const level of CAMPAIGN_LEVELS) {
    assert.ok(
      signatures.some((entry) => entry.level === level.id && entry.outcome === "hidden"),
      `${level.id} has no survivable locker matrix entry`,
    );
  }
  const hiddenAtZeroDelay = signatures.filter((entry) => (
    entry.delay === 0 && entry.outcome === "hidden"
  )).length;
  const hiddenAtOneSecond = signatures.filter((entry) => (
    entry.delay === 1 && entry.outcome === "hidden"
  )).length;
  assert.ok(hiddenAtZeroDelay > hiddenAtOneSecond);

  const sprint = signatures.filter((entry) => entry.pace === "sprint");
  const lightStep = signatures.filter((entry) => entry.pace === "light-step");
  assert.ok(
    sprint.filter((entry) => entry.outcome === "hidden").length
      > lightStep.filter((entry) => entry.outcome === "hidden").length,
    "light-step must not masquerade as a faster chase escape",
  );
  assert.ok(
    lightStep.reduce((sum, entry) => sum + entry.heardEvidenceChanges, 0)
      <= sprint.reduce((sum, entry) => sum + entry.heardEvidenceChanges, 0),
    "light-step must not create more heard evidence than sprint",
  );
});

test("survivability guidance repairs the former 4/10 follow-HUD route", async (t) => {
  for (const level of CAMPAIGN_LEVELS) {
    await t.test(`${level.campaign.levelNumber}. ${level.id}`, () => {
      const result = runGuidedRecovery(level);
      assert.equal(result.state.phase, "won", `${level.id} guidance ended ${result.state.captureReason}`);
      assert.ok(result.hideCount >= 1, `${level.id} never completed the taught hide loop`);
      assert.ok(result.hideCount <= 3, `${level.id} guidance loops excessively`);
    });
  }
});
