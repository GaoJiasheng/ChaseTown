import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  ACTOR_SHADOW_LAYER,
  batchCompatibleActorSkins,
  createActorShadowProxy,
  enableActorShadowLayer,
} from "../app/game/player/actor-batching.ts";

const triangleGeometry = (offset = 0) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    offset, 0, 0, offset + 0.4, 0, 0, offset, 0.4, 0,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
  ], 4));
  geometry.setIndex([0, 1, 2]);
  return geometry;
};

test("guarded actor batching merges only equivalent shared-material skins", () => {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = "Hips";
  root.add(bone);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([bone]);
  skeleton.calculateInverses();
  const material = new THREE.MeshStandardMaterial();
  for (let index = 0; index < 2; index += 1) {
    const wrapper = new THREE.Group();
    const mesh = new THREE.SkinnedMesh(triangleGeometry(index), material);
    mesh.castShadow = true;
    wrapper.add(mesh);
    root.add(wrapper);
    const meshSkeleton = new THREE.Skeleton([bone], skeleton.boneInverses.map((inverse) => inverse.clone()));
    mesh.bind(meshSkeleton, new THREE.Matrix4());
  }
  root.updateMatrixWorld(true);
  const result = batchCompatibleActorSkins(root);
  assert.equal(result.budget.beforeMeshes, 2);
  assert.equal(result.budget.afterMeshes, 1);
  assert.equal(result.budget.trianglesBefore, 2);
  assert.equal(result.budget.trianglesAfter, 2);
  assert.equal(result.budget.fallbacks.length, 0);
  assert.equal(result.meshes[0].skeleton.bones[0], bone);
  assert.equal(result.meshes[0].geometry.boundingBox.min.x, 0);
  assert.ok(Math.abs(result.meshes[0].geometry.boundingBox.max.x - 1.4) < 1e-5);
});

const addBone = (parent, name, position) => {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.copy(position);
  parent.add(bone);
  return bone;
};

function humanoidFixture() {
  const root = new THREE.Group();
  const hips = addBone(root, "Hips", new THREE.Vector3(0, 0.9, 0));
  const chest = addBone(hips, "Chest", new THREE.Vector3(0, 0.45, 0));
  const neck = addBone(chest, "Neck", new THREE.Vector3(0, 0.28, 0));
  addBone(neck, "Head", new THREE.Vector3(0, 0.18, 0));
  const leftUpperArm = addBone(chest, "LeftUpperArm", new THREE.Vector3(-0.28, 0.18, 0));
  const leftLowerArm = addBone(leftUpperArm, "LeftLowerArm", new THREE.Vector3(-0.34, 0, 0));
  addBone(leftLowerArm, "LeftHand", new THREE.Vector3(-0.28, 0, 0));
  const rightUpperArm = addBone(chest, "RightUpperArm", new THREE.Vector3(0.28, 0.18, 0));
  const rightLowerArm = addBone(rightUpperArm, "RightLowerArm", new THREE.Vector3(0.34, 0, 0));
  addBone(rightLowerArm, "RightHand", new THREE.Vector3(0.28, 0, 0));
  const leftUpperLeg = addBone(hips, "LeftUpperLeg", new THREE.Vector3(-0.14, -0.08, 0));
  const leftLowerLeg = addBone(leftUpperLeg, "LeftLowerLeg", new THREE.Vector3(0, -0.5, 0));
  const leftFoot = addBone(leftLowerLeg, "LeftFoot", new THREE.Vector3(0, -0.45, 0.05));
  addBone(leftFoot, "LeftToes", new THREE.Vector3(0, 0, 0.28));
  const rightUpperLeg = addBone(hips, "RightUpperLeg", new THREE.Vector3(0.14, -0.08, 0));
  const rightLowerLeg = addBone(rightUpperLeg, "RightLowerLeg", new THREE.Vector3(0, -0.5, 0));
  const rightFoot = addBone(rightLowerLeg, "RightFoot", new THREE.Vector3(0, -0.45, 0.05));
  addBone(rightFoot, "RightToes", new THREE.Vector3(0, 0, 0.28));
  root.updateMatrixWorld(true);
  const bones = [];
  root.traverse((object) => { if (object instanceof THREE.Bone) bones.push(object); });
  const skeleton = new THREE.Skeleton(bones);
  skeleton.calculateInverses();
  const mesh = new THREE.SkinnedMesh(triangleGeometry(), new THREE.MeshStandardMaterial());
  root.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());
  mesh.castShadow = true;
  root.updateMatrixWorld(true);
  return { root, mesh, leftUpperArm };
}

test("jointed shadow proxy follows the shared skeleton under 1k triangles", () => {
  const fixture = humanoidFixture();
  const result = createActorShadowProxy(fixture.root, { height: 2, maxTriangles: 1_000 });
  assert.equal(result.budget.created, true);
  assert.equal(result.budget.proxyMeshes, 1);
  assert.ok(result.budget.proxyTriangles <= 1_000);
  assert.equal(result.budget.shadowLayer, ACTOR_SHADOW_LAYER);
  assert.equal(fixture.mesh.castShadow, false);
  assert.ok(result.proxy instanceof THREE.SkinnedMesh);
  assert.equal(result.proxy.skeleton, fixture.mesh.skeleton);
  assert.equal(result.proxy.material, fixture.mesh.material);
  assert.equal(fixture.mesh.material.colorWrite, true);
  assert.equal(fixture.mesh.material.depthWrite, true);
  const camera = new THREE.PerspectiveCamera();
  assert.equal(camera.layers.test(result.proxy.layers), false);
  enableActorShadowLayer(camera);
  assert.equal(camera.layers.test(result.proxy.layers), true);
  fixture.leftUpperArm.rotation.z = 0.65;
  fixture.root.updateMatrixWorld(true);
  assert.equal(result.proxy.skeleton.bones.includes(fixture.leftUpperArm), true);
});
