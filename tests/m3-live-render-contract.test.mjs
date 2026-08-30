import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  batchCompatibleActorSkins,
  createActorShadowProxy,
} from "../app/game/player/actor-batching.ts";
import {
  createMazeShadowProxy,
  mazeShadowProxyBoxes,
} from "../app/game/maze-shadow-proxy.ts";

const triangles = (geometry) => (
  (geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0) / 3
);

const triangleGeometry = (offset = 0) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    offset, 0, 0,
    offset + 0.4, 0, 0,
    offset, 0.4, 0,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.setIndex([0, 1, 2]);
  return geometry;
};

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
  return { root };
}

test("M3 live actor shadow proxy derives the frozen 344-triangle budget from six radial segments", () => {
  const radialSegments = 6;
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, radialSegments, 1, false);
  const head = new THREE.SphereGeometry(1, Math.max(8, radialSegments), 6);
  const independentlyDerivedTriangles = 11 * triangles(cylinder) + triangles(head);
  cylinder.dispose();
  head.dispose();
  assert.equal(
    independentlyDerivedTriangles,
    344,
    "independent Three.js geometry formula for 11 limbs plus one head drifted",
  );

  const result = createActorShadowProxy(humanoidFixture().root, { height: 2 });
  assert.equal(result.budget.created, true);
  assert.equal(
    result.budget.proxyTriangles,
    independentlyDerivedTriangles,
    "live default actor shadow proxy must remain 344 triangles",
  );
});

function sharedSkinFixture(inverseOffsets) {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = "Hips";
  root.add(bone);
  root.updateMatrixWorld(true);
  const base = new THREE.Skeleton([bone]);
  base.calculateInverses();
  const material = new THREE.MeshStandardMaterial();
  for (const [index, inverseOffset] of inverseOffsets.entries()) {
    const wrapper = new THREE.Group();
    const mesh = new THREE.SkinnedMesh(triangleGeometry(index), material);
    wrapper.add(mesh);
    root.add(wrapper);
    const inverse = base.boneInverses[0].clone();
    inverse.elements[12] += inverseOffset;
    mesh.bind(new THREE.Skeleton([bone], [inverse]), new THREE.Matrix4());
  }
  root.updateMatrixWorld(true);
  return root;
}

test("M3 live batching conserves every source triangle", () => {
  const root = sharedSkinFixture([0, 0, 0, 0]);
  const result = batchCompatibleActorSkins(root);
  assert.equal(result.budget.beforeMeshes, 4);
  assert.equal(result.budget.afterMeshes, 1);
  assert.equal(result.budget.trianglesBefore, 4);
  assert.equal(
    result.budget.trianglesAfter,
    result.budget.trianglesBefore,
    "live actor batching dropped or duplicated source triangles",
  );
});

test("M3 live batching keeps compatible skeleton containers together and inverse mismatches separate", () => {
  const root = sharedSkinFixture([0, 0, 0.25]);
  const result = batchCompatibleActorSkins(root);
  assert.equal(result.budget.beforeMeshes, 3);
  assert.equal(result.budget.afterMeshes, 2, "bone/inverse guard changed the live batch partition");
  assert.equal(result.budget.mergedGroups, 1, "compatible skins must form exactly one merged group");
  assert.equal(result.budget.mergedSourceMeshes, 2);
  assert.equal(result.budget.singletonGroups, 1, "inverse mismatch must remain a singleton");
  assert.deepEqual(result.budget.fallbacks, [], "valid production-style skins must not fall back");
});

const placements = (count, row) => Array.from({ length: count }, (_, index) => ({
  position: new THREE.Vector3(index % 25, 0, row + Math.floor(index / 25)),
  rotation: 0,
}));

test("M3 live maze proxy keeps box count and triangle count below the five-thousand-triangle cap", () => {
  const batches = {
    a: placements(100, 0),
    b: placements(80, 10),
    c: placements(60, 20),
    end: placements(50, 30),
    wide: placements(30, 40),
    corner: placements(20, 50),
    doorway: placements(15, 60),
    junction: placements(5, 70),
  };
  const expectedBoxes = (
    batches.a.length
    + batches.b.length
    + batches.c.length
    + batches.end.length
    + batches.wide.length
    + batches.corner.length
    + batches.doorway.length * 3
    + batches.junction.length * 6
  );
  assert.equal(expectedBoxes, 415);
  const boxes = mazeShadowProxyBoxes(batches, 2, 2.1);
  assert.equal(boxes.length, expectedBoxes, "live maze proxy box density or closure rule drifted");
  const { proxy, stats } = createMazeShadowProxy(batches, 2, 2.1, "mutation-budget-proxy");
  const trianglesPerBox = triangles(new THREE.BoxGeometry(1, 1, 1));
  assert.equal(trianglesPerBox, 12);
  assert.equal(stats.boxes, expectedBoxes);
  assert.equal(stats.triangles, expectedBoxes * trianglesPerBox);
  assert.ok(stats.boxes <= Math.floor(5_000 / trianglesPerBox), "live maze proxy exceeded its box cap");
  assert.ok(stats.triangles < 5_000, "live maze proxy exceeded 5,000 triangles");
  proxy.geometry.dispose();
  proxy.material.dispose();
});
