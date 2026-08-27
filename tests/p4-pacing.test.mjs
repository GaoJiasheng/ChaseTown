import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadGameModule } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = await loadGameModule(ROOT, "p4-pacing");

const FRAME_RATES = [30, 45, 60, 90, 120];
const CAPTURE_DISTANCE = 0.58;
const EXIT_DISTANCE = 0.62;
const WAYPOINT_TOLERANCE = 0.04;
const MAX_RUN_SECONDS = 60;

const point = (value) => ({ x: value.x, y: value.y });

function routeVia(waypoints) {
  const route = [];
  for (let index = 1; index < waypoints.length; index += 1) {
    const segment = game.findGridPath(waypoints[index - 1], waypoints[index]);
    assert.ok(segment.length > 0, `route segment ${index - 1}->${index} must be reachable`);
    route.push(...segment.slice(route.length > 0 ? 1 : 0));
  }
  return route;
}

const OPTIMAL_SAFE_ROUTE = routeVia([
  game.START,
  { x: 1, y: 10 },
  { x: 5, y: 10 },
  { x: 5, y: 16 },
  { x: 13, y: 16 },
  { x: 13, y: 23 },
  game.EXIT,
]);

const ONE_DETOUR_ROUTE = routeVia([
  game.START,
  { x: 1, y: 10 },
  { x: 3, y: 10 },
  { x: 3, y: 14 },
  { x: 3, y: 10 },
  { x: 5, y: 10 },
  { x: 5, y: 16 },
  { x: 13, y: 16 },
  { x: 13, y: 23 },
  game.EXIT,
]);

function simulateStrategy({ route, stationary = false, framesPerSecond }) {
  const delta = 1 / framesPerSecond;
  let player = point(game.START);
  let villain = point(game.VILLAIN_START);
  let villainHeading = Math.PI / 2;
  let memory = { state: "delay", lastKnown: null, searchArrivedAt: null };
  let patrolIndex = 0;
  let playerWaypointIndex = 1;
  let minimumDistance = game.distance(player, villain);
  let chaseSeconds = 0;
  const pathCache = { signature: "", route: [], cursor: 0 };

  for (let tick = 0; tick <= MAX_RUN_SECONDS * framesPerSecond; tick += 1) {
    const elapsedSeconds = tick * delta;

    if (!stationary && playerWaypointIndex < route.length) {
      let target = route[playerWaypointIndex];
      let dx = target.x - player.x;
      let dy = target.y - player.y;
      let length = Math.hypot(dx, dy);
      if (length <= WAYPOINT_TOLERANCE) {
        playerWaypointIndex += 1;
        target = route[playerWaypointIndex];
        if (target) {
          dx = target.x - player.x;
          dy = target.y - player.y;
          length = Math.hypot(dx, dy);
        }
      }
      if (target) {
        const step = Math.min(game.P0_TUNING.playerSpeed * delta, length);
        const nextX = player.x + (dx / length) * step;
        const nextY = player.y + (dy / length) * step;
        if (game.canPlayerOccupy(nextX, player.y)) player.x = nextX;
        if (game.canPlayerOccupy(player.x, nextY)) player.y = nextY;
      }
    }

    const decision = game.planVillainAi(memory, villain, player, elapsedSeconds * 1000, 0);
    memory = decision.memory;
    let villainTarget = decision.target;
    if (memory.state === "patrol") villainTarget = game.PATROL[patrolIndex];
    if (memory.state === "chase") chaseSeconds += delta;

    if (villainTarget) {
      const signature = game.pathCacheSignature(memory.state, villain, villainTarget);
      if (game.pathCacheInvalidationReason(pathCache.signature, signature)) {
        const nextRoute = game.findGridPath(villain, villainTarget);
        const startsAtCenter = nextRoute[0]
          ? game.distance(villain, nextRoute[0]) <= game.P2_TUNING.pathWaypointTolerance
          : false;
        pathCache.signature = signature;
        pathCache.route = nextRoute;
        pathCache.cursor = startsAtCenter ? 1 : 0;
      }
      const waypoint = pathCache.route[pathCache.cursor];
      if (waypoint && game.distance(villain, waypoint) <= game.P2_TUNING.pathWaypointTolerance) {
        pathCache.cursor += 1;
      }
      const activeWaypoint = pathCache.route[pathCache.cursor] ?? villainTarget;
      const cachedRoute = pathCache.route.length > 0
        ? [{ x: Math.round(villain.x), y: Math.round(villain.y) }, activeWaypoint]
        : [];
      const step = game.stepVillainToward(
        villain,
        villainTarget,
        villainHeading,
        game.P0_TUNING.villainSpeed,
        delta,
        cachedRoute,
      );
      villain = step.point;
      villainHeading = step.heading;
      if (memory.state === "patrol" && game.distance(villain, villainTarget) < 0.25) {
        patrolIndex = (patrolIndex + 1) % game.PATROL.length;
      }
    }

    const separation = game.distance(player, villain);
    minimumDistance = Math.min(minimumDistance, separation);
    if (separation < CAPTURE_DISTANCE) {
      return { outcome: "lost", elapsedSeconds, minimumDistance, chaseSeconds };
    }
    if (game.distance(player, game.EXIT) < EXIT_DISTANCE) {
      return { outcome: "won", elapsedSeconds, minimumDistance, chaseSeconds };
    }
  }

  return { outcome: "timeout", elapsedSeconds: MAX_RUN_SECONDS, minimumDistance, chaseSeconds };
}

test("P4-5 patrol data covers the terminal corridor while preserving the start-area sweep", () => {
  assert.deepEqual(game.PATROL, [
    { x: 21, y: 21.5 },
    { x: 21, y: 16 },
    { x: 9, y: 20 },
    { x: 7, y: 7 },
    { x: 15, y: 3 },
    { x: 21, y: 10 },
    { x: 23, y: 22 },
    { x: 17, y: 19 },
  ]);
  assert.equal(OPTIMAL_SAFE_ROUTE.length - 1, game.findGridPath(game.START, game.EXIT).length - 1);
  assert.equal(OPTIMAL_SAFE_ROUTE.length - 1, 44);
  assert.equal(ONE_DETOUR_ROUTE.length - 1, 52);
});

test("P4-5 minimum-length safe strategy reaches the exit across deterministic frame rates", () => {
  for (const framesPerSecond of FRAME_RATES) {
    const result = simulateStrategy({ route: OPTIMAL_SAFE_ROUTE, framesPerSecond });
    assert.equal(result.outcome, "won", `${framesPerSecond}Hz optimal run must remain winnable`);
    assert.ok(result.elapsedSeconds < 15, `${framesPerSecond}Hz optimal run exceeded the measured envelope`);
  }
});

test("P4-5 stationary strategy is always caught", () => {
  for (const framesPerSecond of FRAME_RATES) {
    const result = simulateStrategy({
      route: OPTIMAL_SAFE_ROUTE,
      stationary: true,
      framesPerSecond,
    });
    assert.equal(result.outcome, "lost", `${framesPerSecond}Hz stationary run must be caught`);
    assert.ok(result.elapsedSeconds < MAX_RUN_SECONDS, `${framesPerSecond}Hz stationary capture timed out`);
  }
});

test("P4-5 one deliberate detour remains a narrow but repeatable win", () => {
  for (const framesPerSecond of FRAME_RATES) {
    const result = simulateStrategy({ route: ONE_DETOUR_ROUTE, framesPerSecond });
    assert.equal(result.outcome, "won", `${framesPerSecond}Hz detour run must remain winnable`);
    assert.ok(
      result.minimumDistance > CAPTURE_DISTANCE && result.minimumDistance < 2,
      `${framesPerSecond}Hz detour separation ${result.minimumDistance} must stay in the narrow-win window`,
    );
    assert.ok(result.chaseSeconds >= 0.4, `${framesPerSecond}Hz detour must trigger a meaningful late chase`);
  }
});
