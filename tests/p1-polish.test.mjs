import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE = path.join(ROOT, "app", "chasing-game.tsx");
const COMPILED_FILE = path.join(ROOT, "tests", `.p1-polish-${process.pid}.mjs`);
const source = await readFile(SOURCE_FILE, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: SOURCE_FILE,
}).outputText;

await writeFile(COMPILED_FILE, compiled);
let game;
try {
  game = await import(`${pathToFileURL(COMPILED_FILE).href}?test=${Date.now()}`);
} finally {
  await unlink(COMPILED_FILE).catch(() => {});
}

test("P1 tuning remains inside the approved polish envelope", () => {
  assert.deepEqual(game.P1_TUNING, {
    villainCollisionMargin: 0.14,
    gaitBlendSeconds: 0.15,
    gaitRadiansPerGridUnit: 3.5,
    playerTurnDamping: 12,
    policeTurnDamping: 7,
    markerDelayMs: 4000,
    markerFadeDamping: 8,
    policeTrackingDistance: 4,
    environmentIntensity: 1,
    exposure: 1,
    hemisphereIntensity: 2.2,
    sunIntensity: 2.9,
    rimIntensity: 1.36,
    sunShadowBias: -0.0005,
    sunShadowNormalBias: 0.02,
  });
  assert.deepEqual(game.P1_SHADOW_CASTERS, [
    "car", "tree", "station", "locker", "basketball", "bench", "blackboard", "podium",
  ]);
});

test("P1-3 gait weight fades linearly over 150ms in both directions", () => {
  let weight = 0;
  const rising = [];
  for (let frame = 0; frame < 9; frame += 1) {
    weight = game.advanceGaitWeight(weight, true, 1 / 60);
    rising.push(weight);
  }
  assert.ok(rising.every((value, index) => index === 0 || value > rising[index - 1]));
  assert.ok(Math.abs(weight - 1) < 1e-12);

  const falling = [];
  for (let frame = 0; frame < 9; frame += 1) {
    weight = game.advanceGaitWeight(weight, false, 1 / 60);
    falling.push(weight);
  }
  assert.ok(falling.every((value, index) => index === 0 || value < falling[index - 1]));
  assert.ok(Math.abs(weight) < 1e-12);
});

test("P1-3 gait phase is distance-driven and freezes at zero speed", () => {
  assert.equal(game.advanceGaitPhase(2.5, 0, 1), 2.5);
  const oneSecond = game.advanceGaitPhase(0, 3.7, 1);
  const splitFrames = Array.from({ length: 60 }).reduce(
    (phase) => game.advanceGaitPhase(phase, 3.7, 1 / 60),
    0,
  );
  assert.ok(Math.abs(oneSecond - splitFrames) < 1e-10);
  assert.ok(game.advanceGaitPhase(0, 3.7, 0.1) > game.advanceGaitPhase(0, 1.8, 0.1));
});

test("P1-3 heading damping takes the short arc without a one-frame snap", () => {
  const start = Math.PI - 0.1;
  const target = -Math.PI + 0.1;
  const first = game.dampAngle(start, target, game.P1_TUNING.playerTurnDamping, 1 / 60);
  assert.ok(first > start, "the shortest arc crosses +PI rather than rotating the long way back");
  assert.ok(Math.abs(first - start) < 0.2);
  let angle = first;
  let previousError = Math.abs(Math.atan2(Math.sin(target - angle), Math.cos(target - angle)));
  for (let frame = 0; frame < 20; frame += 1) {
    angle = game.dampAngle(angle, target, game.P1_TUNING.playerTurnDamping, 1 / 60);
    const error = Math.abs(Math.atan2(Math.sin(target - angle), Math.cos(target - angle)));
    assert.ok(error < previousError);
    previousError = error;
  }
});

test("P1-3b villain keeps the 0.14 margin over long routes without changing turn tuning", () => {
  let point = { x: 7, y: 1 };
  let heading = Math.PI / 2;
  const targets = [
    { x: 7, y: 7 },
    { x: 15, y: 3 },
    { x: 21, y: 10 },
    { x: 17, y: 19 },
    { x: 9, y: 20 },
  ];
  for (const target of targets) {
    for (let frame = 0; frame < 900 && Math.hypot(point.x - target.x, point.y - target.y) >= 0.2; frame += 1) {
      const step = game.stepVillainToward(point, target, heading, game.P0_TUNING.villainSpeed, 1 / 60);
      point = step.point;
      heading = step.heading;
      assert.equal(game.canPlayerOccupy(point.x, point.y, game.P1_TUNING.villainCollisionMargin), true);
    }
    assert.ok(Math.hypot(point.x - target.x, point.y - target.y) < 0.25, `villain failed to reach ${target.x},${target.y}`);
  }
  assert.equal(game.P0_TUNING.villainTurnSpeed, 3.2);
  assert.equal(game.P0_TUNING.sharpTurnSpeedMultiplier, 0.45);
});

test("P1-4 marker targets follow the four-second and threat rules", () => {
  assert.equal(game.markerTargetOpacity("playing", 3999, 0, false), 1);
  assert.equal(game.markerTargetOpacity("playing", 4000, 0, false), 0);
  assert.equal(game.markerTargetOpacity("playing", 5000, 0.59, true), 0);
  assert.equal(game.markerTargetOpacity("playing", 5000, 0.61, true), 1);
  for (const phase of ["ready", "caught", "won", "lost"]) {
    assert.equal(game.markerTargetOpacity(phase, 10000, 0, false), 1);
  }
});

test("P1-5 grid rotation is deterministic and covers four quarter turns", () => {
  const first = [];
  const second = [];
  for (let y = 0; y < 25; y += 1) {
    for (let x = 0; x < 25; x += 1) {
      first.push(game.gridQuarterTurn(x, y, 23));
      second.push(game.gridQuarterTurn(x, y, 23));
    }
  }
  assert.deepEqual(first, second);
  assert.deepEqual([...new Set(first)].sort(), [0, 1, 2, 3]);
  assert.doesNotMatch(source, /Math\.random\s*\(/u);
});

test("P1-6 police tracking uses the strict four-grid exit radius", () => {
  assert.equal(game.shouldPoliceTrack({ x: 23, y: 19.01 }), true);
  assert.equal(game.shouldPoliceTrack({ x: 23, y: 18.99 }), false);
});

test("P1 source contract keeps PMREM cleanup, cached render stats, shadow whitelist and P2 exclusions", () => {
  assert.match(source, /renderer\.info\.autoReset = false/u);
  assert.match(source, /renderer\.info\.reset\(\);\s*renderer\.render\(scene, camera\);\s*qaRenderSnapshot\.calls/u);
  assert.match(source, /const environmentTarget = pmremGenerator\.fromScene/u);
  assert.match(source, /scene\.environment = null;\s*environmentTarget\.dispose\(\);/u);
  assert.match(source, /two-largest-bounds-per-prop/u);
  assert.match(source, /addProp\(model, point, height, rotation, offset, castShadow, castShadow \? name : undefined\)/u);
  assert.match(source, /candidate instanceof THREE\.Mesh && candidate\.castShadow/u);
  assert.match(source, /const finishingDampedTurn = options\.dampHeading/u);
  assert.match(source, /actor\.position\.copy\(world\(resetPoint\)\)/u);
  assert.match(source, /poseRig\(actor, 0, 0\)/u);
  assert.doesNotMatch(source, /--threat|AudioContext|visibilitychange/u);
});
