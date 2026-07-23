import assert from "node:assert/strict";
import test from "node:test";

import { GameSimulation } from "../app/game/simulation.ts";

const corridor = {
  id: "sound-stealth-corridor",
  width: 9,
  height: 3,
  walkable: [
    [false, false, false, false, false, false, false, false, false],
    [false, true, true, true, true, true, true, true, false],
    [false, false, false, false, false, false, false, false, false],
  ],
  playerStart: { x: 1, y: 1 },
  exit: { x: 7, y: 1 },
  chaserStart: { x: 5, y: 1 },
  chaserStartHeading: { x: 1, y: 0 },
  patrol: [{ x: 5, y: 1 }],
  hideSpots: [{
    id: "test-locker",
    approach: { x: 1, y: 1 },
    concealed: { x: 0.65, y: 1 },
    facing: { x: 1, y: 0 },
  }],
};

const createSimulation = () => new GameSimulation({
  level: corridor,
  autoStart: true,
  config: {
    spawnDelaySeconds: 0,
    visionRange: 0.1,
    hearingRange: 10,
    catchRange: 0.1,
  },
});

test("running creates imprecise audible evidence while Q light-step stays quiet", () => {
  const running = createSimulation();
  const runState = running.advance(0.2, { move: { x: 1, y: 0 } });
  assert.equal(runState.chaser.memory.lastKnownEvidence, "sound");
  assert.notDeepEqual(runState.chaser.memory.lastKnownPosition, runState.player.position);

  const sneaking = createSimulation();
  const sneakState = sneaking.advance(0.2, {
    move: { x: 1, y: 0 },
    sneakHeld: true,
  });
  assert.equal(sneakState.chaser.memory.lastKnownEvidence, null);
  assert.ok(
    sneakState.player.position.x - corridor.playerStart.x
    < runState.player.position.x - corridor.playerStart.x,
  );
});

test("locker door edges produce one fair sound stimulus", () => {
  const simulation = createSimulation();
  let state = simulation.advance(1 / 60, { interactPressed: true });
  for (let frame = 0; frame < 60 && state.chaser.memory.lastKnownEvidence !== "sound"; frame += 1) {
    state = simulation.advance(1 / 60);
  }
  assert.equal(state.player.mode, "entering-hide");
  assert.equal(state.chaser.memory.lastKnownEvidence, "sound");
  const evidenceTime = state.chaser.memory.lastHeardAtSeconds;
  state = simulation.advance(0.2);
  assert.equal(state.chaser.memory.lastHeardAtSeconds, evidenceTime);
});
