import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "app", "game", "art", "visual-polish.ts");
const source = await readFile(SOURCE_PATH, "utf8");
const temporaryRoot = await mkdtemp(path.join(ROOT, "tests", `.compiled-p4-visual-${process.pid}-`));
const compiledPath = path.join(temporaryRoot, "visual-polish.mjs");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: SOURCE_PATH,
}).outputText;
await writeFile(compiledPath, compiled);
const polish = await import(`${pathToFileURL(compiledPath).href}?test=${Date.now()}`);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

test("P4-1 shadow follow snaps in light space and preserves the light offset", () => {
  const offset = new THREE.Vector3(-16, 26, -12);
  const runtime = polish.createShadowFollowRuntime({
    lightOffset: offset,
    halfExtent: 16,
    mapSize: 1024,
  });
  const focus = new THREE.Vector3(3.017, 1.02, -8.044);
  const originalFocus = focus.clone();
  const lightPosition = new THREE.Vector3();
  const targetPosition = new THREE.Vector3();
  const returned = polish.updateShadowFollow(runtime, focus, lightPosition, targetPosition);

  assert.strictEqual(returned, runtime);
  assert.equal(runtime.worldUnitsPerTexel, 0.03125);
  assert.deepEqual(focus.toArray(), originalFocus.toArray(), "the requested camera focus is read-only");
  assert.ok(targetPosition.distanceTo(runtime.snappedFocus) < 1e-12);
  assert.ok(lightPosition.clone().sub(targetPosition).distanceTo(offset) < 1e-12);
  assert.ok(Math.abs(runtime.rightAxis.dot(runtime.upAxis)) < 1e-12);
  assert.ok(Math.abs(runtime.rightAxis.dot(runtime.depthAxis)) < 1e-12);
  assert.ok(Math.abs(runtime.upAxis.dot(runtime.depthAxis)) < 1e-12);

  for (const axis of [runtime.rightAxis, runtime.upAxis]) {
    const texelCoordinate = targetPosition.dot(axis) / runtime.worldUnitsPerTexel;
    assert.ok(Math.abs(texelCoordinate - Math.round(texelCoordinate)) < 1e-10);
  }
  assert.ok(
    Math.abs(targetPosition.dot(runtime.depthAxis) - focus.dot(runtime.depthAxis)) < 1e-10,
    "snapping must not move the shadow centre along the light depth axis",
  );
});

test("P4-1 hot updates reuse every runtime and output vector", () => {
  const runtime = polish.createShadowFollowRuntime({
    lightOffset: new THREE.Vector3(-16, 26, -12),
  });
  const lightPosition = new THREE.Vector3();
  const targetPosition = new THREE.Vector3();
  const references = {
    lightOffset: runtime.lightOffset,
    depthAxis: runtime.depthAxis,
    rightAxis: runtime.rightAxis,
    upAxis: runtime.upAxis,
    requestedFocus: runtime.requestedFocus,
    snappedFocus: runtime.snappedFocus,
    lightPosition,
    targetPosition,
  };

  for (let index = 0; index < 240; index += 1) {
    polish.updateShadowFollow(
      runtime,
      new THREE.Vector3(index * 0.013, 1.02, -index * 0.017),
      lightPosition,
      targetPosition,
    );
  }

  assert.equal(runtime.updateCount, 240);
  for (const [name, reference] of Object.entries(references)) {
    const current = name === "lightPosition"
      ? lightPosition
      : name === "targetPosition"
        ? targetPosition
        : runtime[name];
    assert.strictEqual(current, reference, `${name} must be reused`);
  }
  const updateSource = source.slice(
    source.indexOf("export function updateShadowFollow"),
    source.indexOf("export type TextureAnisotropyReport"),
  );
  assert.doesNotMatch(updateSource, /\bnew\s+(?:THREE\.)?(?:Vector|Array|Object|Set|Map)/u);
});

test("P4-1 validates invalid shadow configurations", () => {
  assert.throws(
    () => polish.createShadowFollowRuntime({ lightOffset: new THREE.Vector3(), halfExtent: 16, mapSize: 1024 }),
    /non-zero length/u,
  );
  assert.throws(
    () => polish.createShadowFollowRuntime({ lightOffset: new THREE.Vector3(1, 2, 3), halfExtent: 0 }),
    /halfExtent/u,
  );
  assert.throws(
    () => polish.createShadowFollowRuntime({ lightOffset: new THREE.Vector3(1, 2, 3), mapSize: Number.NaN }),
    /mapSize/u,
  );
});

test("P4-2 anisotropy covers all Standard and Physical texture slots with cap eight", () => {
  const shared = new THREE.Texture();
  const roughness = new THREE.Texture();
  const transmission = new THREE.Texture();
  const ignoredBasicTexture = new THREE.Texture();
  const standard = new THREE.MeshStandardMaterial({ map: shared, normalMap: shared, roughnessMap: roughness });
  const physical = new THREE.MeshPhysicalMaterial({ clearcoatMap: shared, transmissionMap: transmission });
  const basic = new THREE.MeshBasicMaterial({ map: ignoredBasicTexture });
  const group = new THREE.Group();
  const firstGeometry = new THREE.BoxGeometry();
  const secondGeometry = new THREE.BoxGeometry();
  const thirdGeometry = new THREE.BoxGeometry();
  group.add(
    new THREE.Mesh(firstGeometry, standard),
    new THREE.Mesh(secondGeometry, standard),
    new THREE.Mesh(thirdGeometry, [standard, physical, basic]),
  );
  const versionsBefore = [shared.version, roughness.version, transmission.version];

  const report = polish.applySurfaceTextureAnisotropy(group, 16, 32);

  assert.deepEqual(report, {
    capability: 16,
    requested: 32,
    limit: 8,
    effective: 8,
    materials: 2,
    slotReferences: 5,
    uniqueTextures: 3,
    changedTextures: 3,
    minApplied: 8,
    maxApplied: 8,
    slotCounts: {
      map: 1,
      normalMap: 1,
      roughnessMap: 1,
      clearcoatMap: 1,
      transmissionMap: 1,
    },
  });
  assert.equal(shared.anisotropy, 8);
  assert.equal(roughness.anisotropy, 8);
  assert.equal(transmission.anisotropy, 8);
  assert.equal(ignoredBasicTexture.anisotropy, 1, "non-surface Basic materials stay untouched");
  assert.deepEqual(
    [shared.version, roughness.version, transmission.version],
    versionsBefore.map((version) => version + 1),
    "each shared texture is invalidated exactly once",
  );

  group.clear();
  firstGeometry.dispose();
  secondGeometry.dispose();
  thirdGeometry.dispose();
  standard.dispose();
  physical.dispose();
  basic.dispose();
  shared.dispose();
  roughness.dispose();
  transmission.dispose();
  ignoredBasicTexture.dispose();
});

test("P4-2 anisotropy respects weaker devices and handles empty roots", () => {
  assert.equal(polish.P4_MAX_TEXTURE_ANISOTROPY, 8);
  assert.equal(polish.cappedTextureAnisotropy(4, 8), 4);
  assert.equal(polish.cappedTextureAnisotropy(16, 2), 2);
  assert.equal(polish.cappedTextureAnisotropy(Number.NaN, 8), 1);

  const empty = polish.applySurfaceTextureAnisotropy([new THREE.Group(), new THREE.Group()], 4);
  assert.deepEqual(empty, {
    capability: 4,
    requested: 8,
    limit: 8,
    effective: 4,
    materials: 0,
    slotReferences: 0,
    uniqueTextures: 0,
    changedTextures: 0,
    minApplied: 0,
    maxApplied: 0,
    slotCounts: {},
  });
});
