import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FILE = path.join(ROOT, "app", "chasing-game.tsx");
const CSS_FILE = path.join(ROOT, "app", "globals.css");
const COMPILED_FILE = path.join(ROOT, "tests", `.p2-hardening-${process.pid}.mjs`);
const [source, css] = await Promise.all([
  readFile(SOURCE_FILE, "utf8"),
  readFile(CSS_FILE, "utf8"),
]);
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

test("P2-1 threat uses the approved state factors and keeps unaware vignette at zero", () => {
  assert.equal(game.P2_TUNING.threatNearDistance, 4.5);
  assert.equal(game.P2_TUNING.threatFarDistance, 9);
  assert.equal(game.P2_TUNING.unawareStateFactor, 0.25);
  assert.equal(game.P2_TUNING.vignetteDeadzone, 0.25);
  assert.equal(game.P2_TUNING.vignetteUiIntervalMs, 120);

  assert.deepEqual(
    Object.fromEntries(["delay", "chase", "search", "patrol"].map((state) => [state, game.threatStateFactor(state)])),
    { delay: 0.25, chase: 1, search: 1, patrol: 0.25 },
  );
  assert.equal(game.proximityThreat(4.5), 1);
  assert.equal(game.proximityThreat(9), 0);
  assert.ok(game.proximityThreat(6) > game.proximityThreat(7));

  for (const state of ["patrol", "delay"]) {
    const maximumUnawareThreat = game.finalThreat(0, state);
    assert.equal(maximumUnawareThreat, 0.25);
    assert.equal(
      game.vignetteStrength(maximumUnawareThreat),
      0,
      `${state} must not paint a red vignette even at maximum proximity`,
    );
  }
  for (const state of ["chase", "search"]) {
    assert.equal(game.finalThreat(0, state), 1);
    assert.equal(game.vignetteStrength(game.finalThreat(0, state)), 1);
  }
  for (const phase of ["ready", "caught", "won", "lost"]) {
    assert.equal(game.finalThreat(0, "chase", phase), 0);
  }
});

test("P2-5/P2-6 grid paths are deterministic and report step distance rather than node count", () => {
  const start = { x: 1, y: 1 };
  const exit = { x: 23, y: 23 };
  const first = game.findGridPath(start, exit);
  const second = game.findGridPath(start, exit);

  assert.deepEqual(first, second);
  assert.equal(first.length, 45);
  assert.deepEqual(first[0], start);
  assert.deepEqual(first.at(-1), exit);
  assert.equal(game.gridPathDistanceMeters(start, exit), 88);
  assert.equal(game.gridPathDistanceMeters(exit, exit), 0);
  assert.equal(game.gridPathDistanceMeters({ x: 23, y: 22 }, exit), 2);
  assert.equal(game.gridPathDistanceMeters({ x: 1, y: 7 }, { x: 5, y: 10 }), 14);
});

test("P2-5 path cache invalidates only for AI state, villain cell, or target cell changes", () => {
  const base = game.pathCacheSignature("chase", { x: 7.1, y: 1.1 }, { x: 1.1, y: 6.1 });
  const sameCells = game.pathCacheSignature("chase", { x: 7.49, y: 1.49 }, { x: 1.49, y: 6.49 });
  assert.equal(sameCells, base);
  assert.equal(game.pathCacheInvalidationReason(base, sameCells), null);

  const stateChanged = game.pathCacheSignature("search", { x: 7.1, y: 1.1 }, { x: 1.1, y: 6.1 });
  assert.equal(game.pathCacheInvalidationReason(base, stateChanged), "ai-state");

  const villainCellChanged = game.pathCacheSignature("chase", { x: 7.51, y: 1.1 }, { x: 1.1, y: 6.1 });
  assert.equal(game.pathCacheInvalidationReason(base, villainCellChanged), "villain-cell");

  const targetCellChanged = game.pathCacheSignature("chase", { x: 7.1, y: 1.1 }, { x: 1.51, y: 6.1 });
  assert.equal(game.pathCacheInvalidationReason(base, targetCellChanged), "target-cell");
  assert.equal(game.pathCacheInvalidationReason("", base), "empty-cache");
});

test("P2-4 disposal releases shared geometry, material, and texture exactly once", () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map: texture });
  const disposeCounts = { geometry: 0, material: 0, texture: 0 };
  geometry.dispose = () => { disposeCounts.geometry += 1; };
  material.dispose = () => { disposeCounts.material += 1; };
  texture.dispose = () => { disposeCounts.texture += 1; };

  const firstRoot = new THREE.Group();
  const secondRoot = new THREE.Group();
  firstRoot.add(new THREE.Mesh(geometry, material));
  secondRoot.add(new THREE.Mesh(geometry, [material, material]));

  const report = game.disposeObjectResources([firstRoot, secondRoot]);
  assert.deepEqual(report, {
    geometries: 1,
    materials: 1,
    textures: 1,
    skeletons: 0,
  });
  assert.deepEqual(disposeCounts, { geometry: 1, material: 1, texture: 1 });
});

test("P2 source contract wires hardening feedback and exposes independent QA evidence", () => {
  assert.match(source, /addEventListener\("blur", clearOnBlur\)/u);
  assert.match(source, /const visibilityEvent = \["visibility", "change"\]\.join\(""\)/u);
  assert.match(source, /document\.addEventListener\(visibilityEvent, clearWhenHidden\)/u);
  assert.match(source, /if \(document\.hidden\) clearKeys\("document-hidden"\)/u);

  assert.match(source, /host\.style\.setProperty\("--danger-level", threatRuntime\.cssValue\)/u);
  assert.match(css, /--danger-level\s*:\s*0/u);
  assert.match(css, /\.three-mount::after[\s\S]*pointer-events\s*:\s*none[\s\S]*radial-gradient/u);

  assert.match(source, /const unlockAudio = \(\) => \{ void audioRuntime\.unlock\(\); \}/u);
  assert.match(source, /addEventListener\("pointerdown", unlockAudio\)/u);
  assert.match(source, /addEventListener\("keydown", unlockAudio\)/u);
  assert.match(source, /const contextKey = \["Audio", "Context"\]\.join\(""\)/u);
  assert.doesNotMatch(source, /new\s+(?:window\.)?AudioContext\s*\(/u);

  assert.match(source, /threat:\s*\{\s*\.\.\.threatRuntime/u);
  assert.match(source, /pathfinding:\s*\{/u);
  assert.match(source, /disposal:\s*\{/u);
  assert.match(source, /render:\s*\{[\s\S]*breakdown:\s*structuredClone\(qaRenderBreakdown\)/u);
  assert.match(source, /reconciliation:\s*\{ \.\.\.qaRenderReconciliation \}/u);
});
