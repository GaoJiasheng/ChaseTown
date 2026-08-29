import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  createMazeShadowProxy,
  mazeShadowProxyBoxes,
} from "../app/game/maze-shadow-proxy.ts";

const placement = (x, z, rotation = 0) => ({
  position: new THREE.Vector3(x, 0, z),
  rotation,
});

test("maze shadow proxy preserves openings and keeps a deterministic low-poly budget", () => {
  const batches = {
    a: [placement(0, 0)],
    b: [placement(2, 0)],
    c: [placement(4, 0)],
    wide: [placement(7, 0)],
    end: [placement(10, 0)],
    corner: [placement(12, 0)],
    doorway: [placement(14, 0, Math.PI / 2)],
    junction: [placement(18, 0)],
  };
  const boxes = mazeShadowProxyBoxes(batches, 2, 2.1);
  // 5 wall slabs + corner + 3 doorway members + 6 junction members.
  assert.equal(boxes.length, 15);
  const doorway = boxes.slice(6, 9);
  assert.equal(doorway.length, 3);
  assert.ok(doorway[0].position.z > 0);
  assert.ok(doorway[1].position.z < 0);
  assert.ok(doorway[2].position.y > doorway[0].position.y);

  const { proxy, stats } = createMazeShadowProxy(batches, 2, 2.1, "qa-proxy");
  assert.equal(proxy.count, 15);
  assert.equal(proxy.castShadow, true);
  assert.equal(proxy.receiveShadow, false);
  assert.equal(proxy.material.colorWrite, false);
  assert.equal(proxy.material.depthWrite, false);
  assert.deepEqual(stats, { boxes: 15, triangles: 180, sourceModules: 8 });
  proxy.geometry.dispose();
  proxy.material.dispose();
});
