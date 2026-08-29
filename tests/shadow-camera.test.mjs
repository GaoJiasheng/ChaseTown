import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createDirectionalShadowTexelSnapper } from "../app/game/shadow-camera.ts";

test("directional shadow target stays on integer light-space texels while following", () => {
  const snapper = createDirectionalShadowTexelSnapper(new THREE.Vector3(14, 28, 18));
  const target = new THREE.Vector3();
  let previous = null;
  let heldSamples = 0;
  for (let index = 0; index < 120; index += 1) {
    const anchor = new THREE.Vector3(index * 0.003, 0, index * 0.002);
    const snapshot = snapper.snap(anchor, target, 18, 2048);
    assert.ok(Math.abs(snapshot.residualTexelsX) < 1e-10);
    assert.ok(Math.abs(snapshot.residualTexelsY) < 1e-10);
    assert.equal(snapshot.texelWorldSize, 36 / 2048);
    const current = `${snapshot.texelIndexX}/${snapshot.texelIndexY}`;
    if (current === previous) heldSamples += 1;
    previous = current;
  }
  assert.ok(heldSamples > 0, "sub-texel movement should hold the shadow target");
});

test("texel world size follows the active quality map without changing coverage", () => {
  const snapper = createDirectionalShadowTexelSnapper(new THREE.Vector3(14, 28, 18));
  const anchor = new THREE.Vector3(7.13, 0, -4.27);
  const target = new THREE.Vector3();
  const high = { ...snapper.snap(anchor, target, 18, 2048) };
  const balanced = { ...snapper.snap(anchor, target, 18, 1024) };
  assert.equal(high.texelWorldSize, 36 / 2048);
  assert.equal(balanced.texelWorldSize, 36 / 1024);
  assert.ok(Math.abs(high.residualTexelsX) < 1e-10);
  assert.ok(Math.abs(balanced.residualTexelsY) < 1e-10);
});
