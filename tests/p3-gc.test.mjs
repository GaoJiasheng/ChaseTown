import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { loadGameModule } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = await loadGameModule(ROOT, "p3-gc");

test("P3-5 vector helpers preserve values and reuse caller-provided outputs", () => {
  const worldOut = new THREE.Vector3(99, 99, 99);
  assert.equal(game.world({ x: 12, y: 12 }, worldOut), worldOut);
  assert.deepEqual(worldOut.toArray(), [0, 0, 0]);
  assert.deepEqual(game.world({ x: 1, y: 1 }).toArray(), [-22, 0, -22]);

  const moveOut = { x: 99, y: 99 };
  assert.equal(game.screenAlignedMove(0, -1, moveOut), moveOut);
  assert.deepEqual(moveOut, game.screenAlignedMove(0, -1));
  assert.equal(game.screenAlignedMove(0, 0, moveOut), moveOut);
  assert.deepEqual(moveOut, { x: 0, y: 0 });
});

test("P3-5 collision sampling keeps the established four-corner result", () => {
  assert.equal(game.canPlayerOccupy(1, 1), true);
  assert.equal(game.canPlayerOccupy(0.6, 1), false);
  assert.equal(game.canPlayerOccupy(7, 1, 0.14), true);
  assert.equal(game.canPlayerOccupy(7.55, 1, 0.14), false);
});

test("P3-5 render accounting resets, copies and sums in place", () => {
  const source = game.makeRenderBreakdown();
  source.actors.mainCalls = 2;
  source.actors.mainTriangles = 120;
  source.maze.shadowCalls = 3;
  source.maze.shadowTriangles = 480;

  const copy = game.makeRenderBreakdown();
  assert.equal(game.copyRenderBreakdown(copy, source), copy);
  assert.deepEqual(copy, source);

  const totals = game.makeRenderTotals();
  assert.equal(game.sumRenderBreakdown(copy, totals), totals);
  assert.deepEqual(totals, { calls: 5, triangles: 600 });

  assert.equal(game.resetRenderBreakdown(copy), copy);
  assert.deepEqual(game.sumRenderBreakdown(copy, totals), { calls: 0, triangles: 0 });
});

test("P3-5 actor hot paths use module scratch math objects", async () => {
  const source = await readFile(path.join(ROOT, "app", "game", "player", "actors.ts"), "utf8");
  const poseBody = source.slice(source.indexOf("export function poseRig"), source.indexOf("export const syncActor"));
  const syncBody = source.slice(source.indexOf("export const syncActor"));
  assert.doesNotMatch(poseBody, /new THREE\.(?:Vector3|Quaternion)\(/u);
  assert.match(syncBody, /world\(point, ACTOR_WORLD_TARGET\)/u);
});

test("P3-5 component frame loop reuses camera, input, actor options, and render accounting", async () => {
  const source = await readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8");
  const animateBody = source.slice(source.indexOf("const animate ="), source.indexOf("frame = requestAnimationFrame(animate);", source.indexOf("const animate =")));
  assert.doesNotMatch(animateBody, /new THREE\.|\.clone\(\)|Object\.entries\(actors\.current\)/u);
  assert.match(animateBody, /screenAlignedMove\(dx, dy, inputMove\)/u);
  assert.match(animateBody, /world\(player\.current, playerAnchor\)/u);
  assert.match(animateBody, /syncActor\(actors\.current\.villain,[\s\S]*villainSyncOptions\)/u);
  assert.match(animateBody, /resetRenderBreakdown\(activeRenderBreakdown\)/u);
});

test("P3-1 quantized static positions are dequantized before world transforms", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Uint16Array([
    0, 0, 0,
    10000, 0, 0,
    0, 10000, 0,
  ]), 3));
  geometry.setIndex([0, 1, 2]);
  const transformed = game.cloneGeometryForWorldTransform(geometry);
  const mesh = new THREE.Mesh(transformed, new THREE.MeshBasicMaterial());
  mesh.scale.setScalar(0.0001);
  mesh.updateMatrixWorld(true);
  transformed.applyMatrix4(mesh.matrixWorld);

  const position = transformed.getAttribute("position");
  assert.ok(position.array instanceof Float32Array);
  assert.deepEqual(
    Array.from(position.array, (value) => Math.round(value * 1000) / 1000),
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
  );
  geometry.dispose();
  transformed.dispose();
  mesh.material.dispose();
});
