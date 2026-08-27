import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "app", "game", "art", "exit-effects.ts");
const source = await readFile(SOURCE_PATH, "utf8");
const temporaryRoot = await mkdtemp(path.join(ROOT, "tests", `.compiled-p4-exit-${process.pid}-`));
const compiledPath = path.join(temporaryRoot, "exit-effects.mjs");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: SOURCE_PATH,
}).outputText;
await writeFile(compiledPath, compiled);
const effects = await import(`${pathToFileURL(compiledPath).href}?test=${Date.now()}`);

test.after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function namedMesh(name, geometry, material = new THREE.MeshStandardMaterial()) {
  const parent = new THREE.Group();
  parent.name = name;
  const mesh = new THREE.Mesh(geometry, material);
  parent.add(mesh);
  return { parent, mesh, material };
}

test("P4-4 assigns one Float32 mask schema and safely splits conflicting shared geometry", () => {
  const root = new THREE.Group();
  const shared = new THREE.BoxGeometry();
  const redGeometry = new THREE.BoxGeometry();
  const warmGeometry = new THREE.BoxGeometry();
  const plainGeometry = new THREE.BoxGeometry();
  let sharedDisposeEvents = 0;
  shared.addEventListener("dispose", () => { sharedDisposeEvents += 1; });
  const blue = namedMesh("blue_lightbar", shared);
  const body = namedMesh("car_body", shared);
  const red = namedMesh("red_lightbar", redGeometry);
  const warm = namedMesh("warm_wall_lamp.001", warmGeometry);
  const plain = namedMesh("bench", plainGeometry);
  root.add(blue.parent, body.parent, red.parent, warm.parent, plain.parent);

  const report = effects.applyExitEffectAttributes(root);

  assert.equal(report.attribute, "p4ExitEffect");
  assert.equal(report.schema, "p4ExitEffect:1:false:Float32Array");
  assert.equal(report.allMeshesAttributed, true);
  assert.equal(report.meshes, 5);
  assert.equal(report.sourceGeometries, 4);
  assert.equal(report.attributedGeometries, 5);
  assert.equal(report.conflictingSharedGeometries, 1);
  assert.equal(report.clonedGeometries, 2);
  assert.equal(report.disposedOrphanGeometries, 1);
  assert.equal(sharedDisposeEvents, 1);
  assert.notStrictEqual(blue.mesh.geometry, body.mesh.geometry);
  assert.notStrictEqual(blue.mesh.geometry, shared);
  assert.notStrictEqual(body.mesh.geometry, shared);
  assert.deepEqual(report.maskMeshes, { none: 2, blue: 1, red: 1, warm: 1 });

  const expectedMasks = new Map([
    [blue.mesh, effects.EXIT_EFFECT_MASK.blue],
    [body.mesh, effects.EXIT_EFFECT_MASK.none],
    [red.mesh, effects.EXIT_EFFECT_MASK.red],
    [warm.mesh, effects.EXIT_EFFECT_MASK.warm],
    [plain.mesh, effects.EXIT_EFFECT_MASK.none],
  ]);
  for (const [mesh, expected] of expectedMasks) {
    const attribute = mesh.geometry.getAttribute(effects.EXIT_EFFECT_ATTRIBUTE);
    assert.ok(attribute.array instanceof Float32Array);
    assert.equal(attribute.itemSize, 1);
    assert.equal(attribute.normalized, false);
    assert.ok(Array.from(attribute.array).every((value) => value === expected));
  }

  const geometries = new Set([...expectedMasks.keys()].map((mesh) => mesh.geometry));
  for (const geometry of geometries) geometry.dispose();
  for (const { material } of [blue, body, red, warm, plain]) material.dispose();
});

test("P4-4 keeps same-mask shared geometry shared and is idempotent", () => {
  const root = new THREE.Group();
  const shared = new THREE.PlaneGeometry();
  let disposeEvents = 0;
  shared.addEventListener("dispose", () => { disposeEvents += 1; });
  const lightbar = new THREE.Group();
  lightbar.name = "blue_lightbar";
  const first = new THREE.Mesh(shared, new THREE.MeshStandardMaterial());
  const second = new THREE.Mesh(shared, new THREE.MeshStandardMaterial());
  lightbar.add(first, second);
  root.add(lightbar);

  const firstReport = effects.applyExitEffectAttributes(root);
  const secondReport = effects.applyExitEffectAttributes(root);

  assert.strictEqual(first.geometry, shared);
  assert.strictEqual(second.geometry, shared);
  assert.equal(firstReport.clonedGeometries, 0);
  assert.equal(firstReport.disposedOrphanGeometries, 0);
  assert.equal(firstReport.createdAttributes, 1);
  assert.equal(secondReport.createdAttributes, 0);
  assert.equal(secondReport.reusedAttributes, 1);
  assert.equal(disposeEvents, 0);

  shared.dispose();
  first.material.dispose();
  second.material.dispose();
});

test("P4-4 shader patch binds shared uniforms only to materials with non-zero masks", () => {
  const runtime = effects.createExitEffectRuntime();
  const root = new THREE.Group();
  const effectGeometry = new THREE.BufferGeometry();
  effectGeometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  effectGeometry.setAttribute(effects.EXIT_EFFECT_ATTRIBUTE, new THREE.Float32BufferAttribute([1, 1, 1], 1));
  const defaultGeometry = effectGeometry.clone();
  defaultGeometry.setAttribute(effects.EXIT_EFFECT_ATTRIBUTE, new THREE.Float32BufferAttribute([0, 0, 0], 1));
  const standard = new THREE.MeshStandardMaterial();
  const physical = new THREE.MeshPhysicalMaterial();
  const untouched = new THREE.MeshStandardMaterial();
  const unsupported = new THREE.MeshBasicMaterial();
  root.add(
    new THREE.Mesh(effectGeometry, [standard, physical, unsupported]),
    new THREE.Mesh(defaultGeometry, untouched),
  );
  const childCount = root.children.length;
  const materialsBefore = root.children.map((child) => child.material);

  const report = effects.patchExitEffectMaterials(root, runtime);

  assert.deepEqual(report, {
    programKey: "p4-exit-effects-v1",
    standardMaterials: 3,
    effectMaterials: 2,
    patchedMaterials: 2,
    alreadyPatchedMaterials: 0,
    unsupportedEffectMaterials: 1,
    drawCallSafe: true,
  });
  assert.equal(root.children.length, childCount);
  assert.deepEqual(root.children.map((child) => child.material), materialsBefore);
  const shader = {
    uniforms: {},
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <emissivemap_fragment>",
  };
  standard.onBeforeCompile(shader, {});
  assert.strictEqual(shader.uniforms.p4ExitBlue, runtime.uniforms.blue);
  assert.strictEqual(shader.uniforms.p4ExitRed, runtime.uniforms.red);
  assert.strictEqual(shader.uniforms.p4ExitWarm, runtime.uniforms.warm);
  assert.match(shader.vertexShader, /attribute float p4ExitEffect/u);
  assert.match(shader.vertexShader, /vP4ExitEffect = p4ExitEffect/u);
  assert.match(shader.fragmentShader, /totalEmissiveRadiance \+= vec3\(0\.08, 0\.34, 1\.0\)/u);
  assert.match(standard.customProgramCacheKey(), /p4-exit-effects-v1/u);
  assert.equal(untouched.customProgramCacheKey().includes("p4-exit-effects-v1"), false);

  const repeated = effects.patchExitEffectMaterials(root, runtime);
  assert.equal(repeated.patchedMaterials, 0);
  assert.equal(repeated.alreadyPatchedMaterials, 2);

  effectGeometry.dispose();
  defaultGeometry.dispose();
  standard.dispose();
  physical.dispose();
  untouched.dispose();
  unsupported.dispose();
});

test("P4-4 pulse alternates red and blue without allocation and reduced motion is static", () => {
  const runtime = effects.createExitEffectRuntime(1600);
  const references = {
    runtime,
    uniforms: runtime.uniforms,
    blue: runtime.uniforms.blue,
    red: runtime.uniforms.red,
    warm: runtime.uniforms.warm,
  };

  const first = effects.updateExitEffectPulse(runtime, 400, false);
  const quarter = { blue: runtime.blueIntensity, red: runtime.redIntensity };
  const second = effects.updateExitEffectPulse(runtime, 1200, false);
  const threeQuarter = { blue: runtime.blueIntensity, red: runtime.redIntensity };
  assert.strictEqual(first, references.runtime);
  assert.strictEqual(second, references.runtime);
  assert.ok(quarter.blue > quarter.red);
  assert.ok(threeQuarter.red > threeQuarter.blue);
  assert.ok(Math.abs(quarter.blue - threeQuarter.red) < 1e-12);
  assert.ok(Math.abs(quarter.red - threeQuarter.blue) < 1e-12);
  assert.strictEqual(runtime.uniforms, references.uniforms);
  assert.strictEqual(runtime.uniforms.blue, references.blue);
  assert.strictEqual(runtime.uniforms.red, references.red);
  assert.strictEqual(runtime.uniforms.warm, references.warm);

  effects.updateExitEffectPulse(runtime, 17, true);
  const reducedFirst = effects.getExitEffectQaReport(runtime, null, null);
  effects.updateExitEffectPulse(runtime, 99999, true);
  const reducedSecond = effects.getExitEffectQaReport(runtime, null, null);
  assert.deepEqual(reducedFirst.intensities, reducedSecond.intensities);
  assert.equal(reducedSecond.phase, 0);
  assert.equal(reducedSecond.reducedMotion, true);

  const updateSource = source.slice(
    source.indexOf("export function updateExitEffectPulse"),
    source.indexOf("type ExitEffectMaterialBinding"),
  );
  assert.doesNotMatch(updateSource, /\bnew\s+(?:THREE\.)?(?:Vector|Array|Object|Set|Map)/u);
});

test("P4-4 QA report is plain, serializable, and includes mask and shader evidence", () => {
  const runtime = effects.createExitEffectRuntime();
  effects.updateExitEffectPulse(runtime, 250, false);
  const attributes = {
    attribute: "p4ExitEffect",
    schema: "p4ExitEffect:1:false:Float32Array",
    allMeshesAttributed: true,
    meshes: 2,
    sourceGeometries: 2,
    attributedGeometries: 2,
    conflictingSharedGeometries: 0,
    clonedGeometries: 0,
    disposedOrphanGeometries: 0,
    createdAttributes: 2,
    reusedAttributes: 0,
    maskMeshes: { none: 1, blue: 1, red: 0, warm: 0 },
    maskVertices: { none: 24, blue: 24, red: 0, warm: 0 },
  };
  const shaders = {
    programKey: "p4-exit-effects-v1",
    standardMaterials: 2,
    effectMaterials: 1,
    patchedMaterials: 1,
    alreadyPatchedMaterials: 0,
    unsupportedEffectMaterials: 0,
    drawCallSafe: true,
  };
  const report = effects.getExitEffectQaReport(runtime, attributes, shaders);

  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.strictEqual(report.attributes, attributes);
  assert.strictEqual(report.shaders, shaders);
  assert.equal(report.periodMs, effects.EXIT_EFFECT_PERIOD_MS);
});
