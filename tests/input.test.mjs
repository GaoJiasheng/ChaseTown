import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
  FIXED_CAMERA_GROUND_DIRECTION,
  fixedCameraGroundBasis,
  screenMoveToWorld,
  shouldIgnoreFocusedControlKey,
} from "../app/game/input.ts";

test("focused controls own Space and Enter without duplicate global commands", () => {
  assert.equal(shouldIgnoreFocusedControlKey(" ", true), true);
  assert.equal(shouldIgnoreFocusedControlKey("enter", true), true);
  assert.equal(shouldIgnoreFocusedControlKey("e", true), false);
  assert.equal(shouldIgnoreFocusedControlKey(" ", false), false);
  assert.equal(shouldIgnoreFocusedControlKey("enter", false), false);
});

test("fixed-camera controls resolve exactly along the labelled screen axes", () => {
  const { cameraBack: screenDown, screenRight } = fixedCameraGroundBasis();
  const dot = (left, right) => left.x * right.x + left.y * right.y;

  const up = screenMoveToWorld({ x: 0, y: -1 });
  const down = screenMoveToWorld({ x: 0, y: 1 });
  const left = screenMoveToWorld({ x: -1, y: 0 });
  const right = screenMoveToWorld({ x: 1, y: 0 });

  assert.ok(Math.abs(dot(up, screenDown) + 1) < 1e-12);
  assert.ok(Math.abs(dot(down, screenDown) - 1) < 1e-12);
  assert.ok(Math.abs(dot(left, screenRight) + 1) < 1e-12);
  assert.ok(Math.abs(dot(right, screenRight) - 1) < 1e-12);
  assert.ok(Math.abs(dot(up, screenRight)) < 1e-12);
  assert.ok(Math.abs(dot(right, screenDown)) < 1e-12);
});

test("shared fixed-camera basis is immutable and retains the authored non-45-degree azimuth", () => {
  const basis = fixedCameraGroundBasis();
  assert.ok(Object.isFrozen(basis));
  assert.ok(Object.isFrozen(basis.screenRight));
  assert.ok(Math.abs(basis.screenRight.x - Math.SQRT1_2) > 0.1);
  assert.ok(Math.abs(Math.hypot(basis.cameraBack.x, basis.cameraBack.y) - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(basis.screenRight.x, basis.screenRight.y) - 1) < 1e-12);
});

test("screen-space diagonals stay normalized and opposing input stays neutral", () => {
  const diagonal = screenMoveToWorld({ x: 1, y: -1 });
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-12);
  assert.deepEqual(screenMoveToWorld({ x: 0, y: 0 }), { x: 0, y: 0 });
});

test("fixed-camera input projects W/S/A/D to the matching viewport direction", () => {
  const focus = new THREE.Vector3();
  const bearing = new THREE.Vector3(
    FIXED_CAMERA_GROUND_DIRECTION.x,
    0.82,
    FIXED_CAMERA_GROUND_DIRECTION.y,
  ).normalize();
  const camera = new THREE.PerspectiveCamera(56, 16 / 9, 0.08, 150);
  camera.position.copy(focus).addScaledVector(bearing, 16.25);
  camera.lookAt(focus);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const base = focus.clone().project(camera);

  for (const [key, input, axis, sign] of [
    ["W", { x: 0, y: -1 }, "y", 1],
    ["S", { x: 0, y: 1 }, "y", -1],
    ["A", { x: -1, y: 0 }, "x", -1],
    ["D", { x: 1, y: 0 }, "x", 1],
  ]) {
    const move = screenMoveToWorld(input);
    const projected = new THREE.Vector3(move.x, 0, move.y).project(camera).sub(base);
    assert.ok(sign * projected[axis] > 1e-10, `${key} projected to the wrong viewport direction`);
    assert.ok(Math.abs(projected[axis === "x" ? "y" : "x"]) < 1e-10, `${key} drifted off-axis`);
  }
});
