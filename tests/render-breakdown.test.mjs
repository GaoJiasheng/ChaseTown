import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  createQaRenderBreakdownTracker,
  tagQaRenderCategory,
} from "../app/game/render-breakdown.ts";

function fakeRenderer() {
  const TRIANGLES = 4;
  const info = {
    render: { calls: 0, triangles: 0 },
    update(count, mode, instanceCount) {
      this.render.calls += 1;
      if (mode === TRIANGLES) this.render.triangles += instanceCount * count / 3;
    },
  };
  return { renderer: { info }, info, TRIANGLES };
}

function drawMain(object, renderer, scene, count, instances = 1) {
  object.onBeforeRender(renderer, scene, {}, object.geometry, object.material, null);
  renderer.info.update(count, 4, instances);
  object.onAfterRender(renderer, scene, {}, object.geometry, object.material, null);
}

function drawShadow(object, renderer, scene, count, instances = 1) {
  object.onBeforeShadow(renderer, object, {}, {}, object.geometry, object.material, null);
  renderer.info.update(count, 4, instances);
  object.onAfterShadow(renderer, object, {}, {}, object.geometry, object.material, null);
}

test("QA render breakdown accounts Mesh, SkinnedMesh, InstancedMesh and BatchedMesh exactly", () => {
  const scene = new THREE.Scene();
  const actorRoot = new THREE.Group();
  tagQaRenderCategory(actorRoot, "actor");
  const skinned = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  actorRoot.add(skinned);
  scene.add(actorRoot);

  const wall = new THREE.InstancedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
    8,
  );
  tagQaRenderCategory(wall, "maze-walls");
  scene.add(wall);

  const prop = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  scene.add(prop);

  const batched = new THREE.BatchedMesh(4, 12, 12, new THREE.MeshBasicMaterial());
  // The unit harness drives renderer callbacks directly rather than asking a
  // WebGL camera to populate BatchedMesh's private multi-draw ranges.
  batched.onBeforeRender = () => {};
  batched.onBeforeShadow = () => {};
  scene.add(batched);

  const { renderer, info, TRIANGLES } = fakeRenderer();
  const tracker = createQaRenderBreakdownTracker(renderer, scene);
  tracker.beginFrame();
  drawMain(skinned, renderer, scene, 300);
  drawMain(wall, renderer, scene, 60, 8);
  drawMain(prop, renderer, scene, 90);
  drawMain(batched, renderer, scene, 120);
  drawShadow(skinned, renderer, scene, 300);
  drawShadow(wall, renderer, scene, 60, 8);
  const breakdown = tracker.endFrame();

  assert.equal(TRIANGLES, 4);
  assert.deepEqual(breakdown.actor, { calls: 1, triangles: 100 });
  assert.deepEqual(breakdown["maze-walls"], { calls: 1, triangles: 160 });
  assert.deepEqual(breakdown["props-dressing"], { calls: 2, triangles: 70 });
  assert.deepEqual(breakdown["shadow-pass"], { calls: 2, triangles: 260 });
  assert.deepEqual(breakdown.shadowSources, {
    actor: { calls: 1, triangles: 100 },
    "maze-walls": { calls: 1, triangles: 160 },
    "props-dressing": { calls: 0, triangles: 0 },
  });
  assert.deepEqual(breakdown.total, { calls: 6, triangles: 590 });
  assert.equal(breakdown.reconciliation.exact, true);
  assert.equal(breakdown.reconciliation.fallbackCalls, 0);
  assert.equal(info.render.calls, 6);
  tracker.dispose();
});

test("renderer-managed fallback draws are disclosed and assigned to props-dressing", () => {
  const scene = new THREE.Scene();
  const { renderer, info } = fakeRenderer();
  const tracker = createQaRenderBreakdownTracker(renderer, scene);
  tracker.beginFrame();
  info.update(12, 4, 1);
  const breakdown = tracker.endFrame();
  assert.deepEqual(breakdown["props-dressing"], { calls: 1, triangles: 4 });
  assert.equal(breakdown.reconciliation.exact, true);
  assert.equal(breakdown.reconciliation.fallbackCalls, 1);
  assert.equal(breakdown.reconciliation.fallbackTriangles, 4);
  tracker.dispose();
});
