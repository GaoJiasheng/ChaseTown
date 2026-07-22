import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production renderer does not revive prototype character art", async () => {
  const source = await readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8");
  const forbidden = [
    ["poseRig", "runtime sine-bone posing"],
    ["decorateActor", "actor rings, labels, and follow lights"],
    ["makeLabel", "world-space debug nameplates"],
    ["new THREE.RingGeometry", "visible actor ring geometry"],
    ["new THREE.SkeletonHelper", "production skeleton helper"],
  ];

  for (const [needle, description] of forbidden) {
    assert.ok(!source.includes(needle), `${description} must not exist in the production renderer`);
  }
});

test("missing production assets cannot silently fall back to primitive actors", async () => {
  const source = await readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8");
  assert.doesNotMatch(
    source,
    /catch\s*\([^)]*\)\s*\{[^}]{0,1200}(?:BoxGeometry|SphereGeometry|CapsuleGeometry|CylinderGeometry)/su,
    "asset failures must stop with a diagnostic instead of rendering primitive substitutes",
  );
});

test("traditional browser fallback favicon is a real icon asset", async () => {
  const favicon = await readFile(path.join(ROOT, "public", "favicon.ico"));
  assert.ok(favicon.length > 1_000);
  assert.deepEqual([...favicon.subarray(0, 4)], [0, 0, 1, 0]);
});
