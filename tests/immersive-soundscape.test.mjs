import assert from "node:assert/strict";
import test from "node:test";

import {
  ImmersiveSoundscapeController,
  soundPanForWorldPoints,
  themeSoundProfile,
} from "../app/game/audio/immersive-soundscape.ts";

test("soundscape construction is DOM-free and unsupported unlock fails safely", async () => {
  const controller = new ImmersiveSoundscapeController("campus", () => null);
  assert.equal(await controller.unlock(), false);
  await controller.dispose();
});

test("theme sound profiles provide distinct material and ambience palettes", () => {
  const campus = themeSoundProfile("campus");
  const hospital = themeSoundProfile("hospital");
  const fire = themeSoundProfile("fire-station");
  const factory = themeSoundProfile("factory");
  assert.notEqual(campus.stepNoiseColorHertz, hospital.stepNoiseColorHertz);
  assert.ok(factory.machineryGain > campus.machineryGain);
  assert.ok(fire.playerStepHertz > factory.playerStepHertz);
});

test("directional footsteps agree with the immutable screen-right axis", () => {
  const listener = { x: 10, y: 10 };
  const screenRight = soundPanForWorldPoints(listener, { x: 12, y: 8 });
  const screenLeft = soundPanForWorldPoints(listener, { x: 8, y: 12 });
  assert.ok(screenRight > 0.8);
  assert.ok(screenLeft < -0.8);
  assert.equal(soundPanForWorldPoints(listener, listener), 0);
});
