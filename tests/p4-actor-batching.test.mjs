import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(ROOT, "tests", `.compiled-p4-actor-${process.pid}-`));
const sourceFile = path.join(ROOT, "app", "game", "player", "actor-batching.ts");
const outputFile = path.join(temporaryRoot, "actor-batching.mjs");
const source = await readFile(sourceFile, "utf8");
await writeFile(outputFile, ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourceFile,
}).outputText);
const batching = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);
await rm(temporaryRoot, { recursive: true, force: true });

const makeTriangleGeometry = (offset = 0) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    offset, 0, 0,
    offset + 0.4, 0, 0,
    offset, 0.4, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.setIndex([0, 1, 2]);
  return geometry;
};

const makeSharedSkinFixture = () => {
  const root = new THREE.Group();
  const rigRoot = new THREE.Group();
  root.add(rigRoot);
  const bone = new THREE.Bone();
  bone.name = "Hips";
  rigRoot.add(bone);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([bone]);
  skeleton.calculateInverses();
  const material = new THREE.MeshStandardMaterial({ color: 0x8899aa });
  const wrappers = [new THREE.Group(), new THREE.Group()];
  const meshes = wrappers.map((wrapper, index) => {
    rigRoot.add(wrapper);
    const mesh = new THREE.SkinnedMesh(makeTriangleGeometry(index), material);
    mesh.name = `piece-${index}`;
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    wrapper.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    return mesh;
  });
  root.updateMatrixWorld(true);
  return { root, bone, skeleton, material, meshes };
};

const skinnedWorldPosition = (mesh, index) => {
  const position = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), index);
  return mesh.localToWorld(mesh.applyBoneTransform(index, position));
};

test("P4-3 guarded skin batching preserves bind and posed vertices while disposing only source geometry", () => {
  const fixture = makeSharedSkinFixture();
  const originals = [...fixture.meshes];
  const disposeCounts = new Map();
  for (const mesh of originals) {
    disposeCounts.set(mesh.geometry, 0);
    mesh.geometry.dispose = () => disposeCounts.set(mesh.geometry, disposeCounts.get(mesh.geometry) + 1);
  }
  let materialDisposals = 0;
  let skeletonDisposals = 0;
  fixture.material.dispose = () => { materialDisposals += 1; };
  fixture.skeleton.dispose = () => { skeletonDisposals += 1; };

  const bindExpected = originals.flatMap((mesh) => [0, 1, 2].map((index) => skinnedWorldPosition(mesh, index)));
  const result = batching.batchCompatibleActorSkins(fixture.root);
  assert.deepEqual(result.budget, {
    beforeMeshes: 2,
    afterMeshes: 1,
    mergedGroups: 1,
    mergedSourceMeshes: 2,
    singletonGroups: 0,
    trianglesBefore: 2,
    trianglesAfter: 2,
    disposedGeometries: 2,
    fallbacks: [],
  });
  assert.equal(result.meshes[0].skeleton, fixture.skeleton);
  assert.equal(result.meshes[0].castShadow, true, "high-poly fallback remains until proxy creation succeeds");
  assert.equal(materialDisposals, 0);
  assert.equal(skeletonDisposals, 0);
  assert.deepEqual([...disposeCounts.values()], [1, 1]);

  const bindActual = Array.from({ length: 6 }, (_, index) => skinnedWorldPosition(result.meshes[0], index));
  bindExpected.forEach((expected, index) => assert.ok(bindActual[index].distanceTo(expected) < 1e-7));

  fixture.bone.rotation.z = Math.PI / 4;
  fixture.root.updateMatrixWorld(true);
  const posedExpected = originals.flatMap((mesh) => [0, 1, 2].map((index) => skinnedWorldPosition(mesh, index)));
  const posedActual = Array.from({ length: 6 }, (_, index) => skinnedWorldPosition(result.meshes[0], index));
  posedExpected.forEach((expected, index) => assert.ok(posedActual[index].distanceTo(expected) < 1e-7));

  result.meshes[0].geometry.dispose();
  fixture.material.dispose();
});

test("P4-3 guard leaves incompatible morph, multi-material, hidden, and animated-parent meshes untouched", () => {
  const fixture = makeSharedSkinFixture();
  const morph = fixture.meshes[0];
  morph.geometry.morphAttributes.position = [morph.geometry.getAttribute("position").clone()];
  morph.updateMorphTargets();
  const multi = fixture.meshes[1];
  multi.material = [fixture.material, fixture.material];

  const hiddenWrapper = new THREE.Group();
  hiddenWrapper.visible = false;
  fixture.root.add(hiddenWrapper);
  const hidden = new THREE.SkinnedMesh(makeTriangleGeometry(2), fixture.material);
  hiddenWrapper.add(hidden);
  hidden.bind(fixture.skeleton, new THREE.Matrix4());

  const animatedBone = new THREE.Bone();
  fixture.root.add(animatedBone);
  const animated = new THREE.SkinnedMesh(makeTriangleGeometry(3), fixture.material);
  animatedBone.add(animated);
  animated.bind(fixture.skeleton, new THREE.Matrix4());
  fixture.root.updateMatrixWorld(true);

  const result = batching.batchCompatibleActorSkins(fixture.root);
  assert.equal(result.budget.beforeMeshes, 4);
  assert.equal(result.budget.afterMeshes, 4);
  assert.equal(result.budget.mergedGroups, 0);
  assert.deepEqual(
    result.budget.fallbacks.map(({ reason }) => reason).sort(),
    ["animated-parent", "hidden", "morph-target", "multi-material"].sort(),
  );
});

const addBone = (parent, name, position) => {
  const bone = new THREE.Bone();
  bone.name = name;
  bone.position.copy(position);
  parent.add(bone);
  return bone;
};

const makeHumanoidShadowFixture = () => {
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
  const material = new THREE.MeshStandardMaterial();
  const wrapper = new THREE.Group();
  root.add(wrapper);
  const reference = new THREE.SkinnedMesh(makeTriangleGeometry(), material);
  wrapper.add(reference);
  reference.bind(skeleton, new THREE.Matrix4());
  reference.castShadow = true;
  root.updateMatrixWorld(true);
  return { root, reference, leftUpperArm };
};

test("P4-3 builds one articulated shadow-only proxy under budget and follows the arm bone", () => {
  const fixture = makeHumanoidShadowFixture();
  const result = batching.createActorShadowProxy(fixture.root, { maxTriangles: 1000 });
  assert.equal(result.budget.created, true);
  assert.equal(result.budget.sourceMeshes, 1);
  assert.equal(result.budget.proxyMeshes, 1);
  assert.ok(result.budget.proxyTriangles > 0);
  assert.ok(result.budget.proxyTriangles <= 1000);
  assert.equal(result.budget.shadowLayer, batching.ACTOR_SHADOW_LAYER);
  assert.ok(result.proxy instanceof THREE.SkinnedMesh);
  assert.equal(result.proxy.castShadow, true);
  assert.equal(result.proxy.receiveShadow, false);
  assert.equal(fixture.reference.castShadow, false);
  assert.equal(result.proxy.material.colorWrite, false);
  assert.equal(result.proxy.material.depthWrite, false);

  const mainCamera = new THREE.PerspectiveCamera();
  assert.equal(mainCamera.layers.test(result.proxy.layers), false);
  batching.enableActorShadowLayer(mainCamera);
  assert.equal(mainCamera.layers.test(result.proxy.layers), true);
  assert.equal(result.proxy.material.colorWrite, false, "the proxy remains invisible in the main pass");

  const armIndex = result.proxy.skeleton.bones.indexOf(fixture.leftUpperArm);
  const skinIndex = result.proxy.geometry.getAttribute("skinIndex");
  let armVertex = -1;
  for (let index = 0; index < skinIndex.count; index += 1) {
    if (skinIndex.getX(index) === armIndex) {
      armVertex = index;
      break;
    }
  }
  assert.ok(armVertex >= 0);
  const before = skinnedWorldPosition(result.proxy, armVertex);
  fixture.leftUpperArm.rotation.z = 0.65;
  fixture.root.updateMatrixWorld(true);
  const after = skinnedWorldPosition(result.proxy, armVertex);
  assert.ok(after.distanceTo(before) > 0.01, "the proxy arm must follow the existing programmatic bone pose");

  result.proxy.geometry.dispose();
  result.proxy.material.dispose();
  fixture.reference.geometry.dispose();
  fixture.reference.material.dispose();
});

test("P4-3 real compressed actors meet the 30-batch and low-poly shadow budgets", async () => {
  if (!("self" in globalThis)) globalThis.self = globalThis;
  if (!("ProgressEvent" in globalThis)) {
    globalThis.ProgressEvent = class ProgressEvent {
      constructor(type, values = {}) {
        this.type = type;
        Object.assign(this, values);
      }
    };
  }
  if (!("createImageBitmap" in globalThis)) {
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  }

  const expected = {
    kid: { before: 35, after: 13, triangles: 140252 },
    villain: { before: 1, after: 1, triangles: 28939 },
    police: { before: 22, after: 11, triangles: 130400 },
  };
  let combinedAfter = 0;
  let combinedTriangles = 0;
  let combinedShadowTriangles = 0;

  for (const [name, budget] of Object.entries(expected)) {
    const bytes = await readFile(path.join(ROOT, "public", "models", "characters", `${name}.glb`));
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await new Promise((resolve, reject) => loader.parse(data, "", resolve, reject));
    const result = batching.batchCompatibleActorSkins(gltf.scene);
    assert.equal(result.budget.beforeMeshes, budget.before, `${name} source mesh count`);
    assert.equal(result.budget.afterMeshes, budget.after, `${name} batch count`);
    assert.equal(result.budget.trianglesBefore, budget.triangles, `${name} source triangles`);
    assert.equal(result.budget.trianglesAfter, budget.triangles, `${name} batching preserves triangles`);
    assert.deepEqual(result.budget.fallbacks, [], `${name} must not silently fall back`);

    const shadow = batching.createActorShadowProxy(gltf.scene, { maxTriangles: 1000 });
    assert.equal(shadow.budget.created, true, `${name} shadow proxy`);
    assert.ok(shadow.budget.proxyTriangles <= 1000, `${name} shadow triangle budget`);
    combinedAfter += result.budget.afterMeshes;
    combinedTriangles += result.budget.trianglesAfter;
    combinedShadowTriangles += shadow.budget.proxyTriangles;

    const geometries = new Set();
    const materials = new Set();
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    result.meshes[0]?.skeleton.dispose();
  }

  assert.equal(combinedAfter, 25);
  assert.equal(combinedTriangles, 299591);
  assert.ok(combinedShadowTriangles <= 3000);
});
