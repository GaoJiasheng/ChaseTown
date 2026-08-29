import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createDirectionalShadowTexelSnapper } from "../app/game/shadow-camera.ts";

test("directional shadow target stays on integer light-space texels while following", () => {
  const snapper = createDirectionalShadowTexelSnapper(new THREE.Vector3(14, 28, 18));
  const target = new THREE.Vector3();
  let previous = null;
  let heldSamples = 0;
  let nonZeroPreSnapSamples = 0;
  for (let index = 0; index < 120; index += 1) {
    const anchor = new THREE.Vector3(index * 0.003, 0, index * 0.002);
    const snapshot = snapper.snap(anchor, target, 18, 2048);
    assert.equal(snapshot.texelWorldSize, 36 / 2048);
    assert.ok(Math.abs(snapshot.preSnapResidualTexelsX) <= 0.5);
    assert.ok(Math.abs(snapshot.preSnapResidualTexelsY) <= 0.5);
    if (
      Math.abs(snapshot.preSnapResidualTexelsX) > 0.01
      || Math.abs(snapshot.preSnapResidualTexelsY) > 0.01
    ) nonZeroPreSnapSamples += 1;
    assert.equal(snapshot.snappedToTexelGridX, true);
    assert.equal(snapshot.snappedToTexelGridY, true);
    const targetLightSpaceX = target.dot(new THREE.Vector3(
      snapper.basis.right.x,
      snapper.basis.right.y,
      snapper.basis.right.z,
    ));
    const targetLightSpaceY = target.dot(new THREE.Vector3(
      snapper.basis.up.x,
      snapper.basis.up.y,
      snapper.basis.up.z,
    ));
    assert.ok(Math.abs(targetLightSpaceX / snapshot.texelWorldSize - snapshot.texelIndexX) < 1e-9);
    assert.ok(Math.abs(targetLightSpaceY / snapshot.texelWorldSize - snapshot.texelIndexY) < 1e-9);
    const current = `${snapshot.texelIndexX}/${snapshot.texelIndexY}`;
    if (current === previous) heldSamples += 1;
    previous = current;
  }
  assert.ok(heldSamples > 0, "sub-texel movement should hold the shadow target");
  assert.ok(nonZeroPreSnapSamples > 100, "pre-snap residual must reveal real sub-texel movement");
});

test("texel world size follows the active quality map without changing coverage", () => {
  const snapper = createDirectionalShadowTexelSnapper(new THREE.Vector3(14, 28, 18));
  const anchor = new THREE.Vector3(7.13, 0, -4.27);
  const target = new THREE.Vector3();
  const high = { ...snapper.snap(anchor, target, 18, 2048) };
  const balanced = { ...snapper.snap(anchor, target, 18, 1024) };
  assert.equal(high.texelWorldSize, 36 / 2048);
  assert.equal(balanced.texelWorldSize, 36 / 1024);
  assert.notEqual(high.preSnapResidualTexelsX, 0);
  assert.notEqual(balanced.preSnapResidualTexelsY, 0);
  assert.equal(high.snappedToTexelGridX, true);
  assert.equal(balanced.snappedToTexelGridY, true);
});
