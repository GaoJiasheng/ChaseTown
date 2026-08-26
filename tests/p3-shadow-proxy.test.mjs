import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import { loadGameModule } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = await loadGameModule(ROOT, "p3-shadow-proxy");

test("P3-2 greedy shadow cover is deterministic and covers only the 482 blocked cells", () => {
  const original = game.MAZE.map((row) => [...row]);
  const first = game.greedyBlockedGridRectangles(game.MAZE);
  const second = game.greedyBlockedGridRectangles(game.MAZE);

  assert.deepEqual(first, second);
  assert.deepEqual(game.MAZE, original, "the pure cover helper must not mutate the maze");
  assert.equal(game.MAZE.flat().filter((walkable) => !walkable).length, 482);
  assert.equal(first.length, 30);

  const coverage = game.MAZE.map((row) => row.map(() => 0));
  for (const rectangle of first) {
    assert.ok(rectangle.width > 0);
    assert.ok(rectangle.height > 0);
    for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
      for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
        assert.equal(game.MAZE[y][x], false, `rectangle leaked into walkable cell ${x},${y}`);
        coverage[y][x] += 1;
      }
    }
  }

  for (let y = 0; y < game.MAZE.length; y += 1) {
    for (let x = 0; x < game.MAZE[y].length; x += 1) {
      assert.equal(
        coverage[y][x],
        game.MAZE[y][x] ? 0 : 1,
        `${x},${y} must be covered exactly ${game.MAZE[y][x] ? "zero" : "one"} time(s)`,
      );
    }
  }
});

test("P3-2 builds one invisible 360-triangle instanced proxy under the 5000-triangle maze budget", () => {
  const proxy = game.createBlockedGridShadowProxy(game.MAZE, {
    cellSize: game.CELL,
    wallHeight: 1.12,
    name: "maze-shadow-proxy",
  });

  assert.ok(proxy instanceof THREE.InstancedMesh);
  assert.equal(proxy.name, "maze-shadow-proxy");
  assert.equal(proxy.count, 30);
  assert.equal(proxy.castShadow, true);
  assert.equal(proxy.receiveShadow, false);
  assert.ok(proxy.material instanceof THREE.MeshBasicMaterial);
  assert.equal(proxy.material.colorWrite, false);
  assert.equal(proxy.material.depthWrite, false);
  assert.equal(proxy.instanceMatrix.usage, THREE.StaticDrawUsage);

  const boxTriangles = (proxy.geometry.index?.count ?? proxy.geometry.getAttribute("position").count) / 3;
  const proxyShadowTriangles = boxTriangles * proxy.count;
  assert.equal(boxTriangles, 12);
  assert.equal(proxyShadowTriangles, 360);
  assert.deepEqual(proxy.userData.shadowProxy, {
    rectangles: 30,
    blockedCells: 482,
    shadowTriangles: 360,
  });

  const exitShadowTriangles = 844;
  const gateShadowTriangles = 976;
  const mazeShadowTriangles = proxyShadowTriangles + exitShadowTriangles + gateShadowTriangles;
  assert.equal(mazeShadowTriangles, 2180);
  assert.ok(mazeShadowTriangles < 5000);

  proxy.dispose();
  proxy.geometry.dispose();
  proxy.material.dispose();
});
