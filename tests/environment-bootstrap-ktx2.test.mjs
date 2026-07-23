import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "environment-bootstrap-ktx2.json",
);
const VISUAL_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "environment-normal-atlas-visual-qa.json",
);
const SCRIPT = path.join(
  ROOT,
  "tools",
  "art_pipeline",
  "optimize_environment_bootstrap_ktx2.mjs",
);
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const TARGETS = [
  "backpack.glb",
  "basketball.glb",
  "bench.glb",
  "blackboard.glb",
  "books.glb",
  "bulletin.glb",
  "ceiling-light.glb",
  "classroom-door.glb",
  "desk-chair.glb",
  "exit.glb",
  "extinguisher.glb",
  "front-gate.glb",
  "locker.glb",
  "podium.glb",
  "police-car.glb",
  "shrub.glb",
  "station.glb",
  "trash.glb",
  "tree.glb",
];
const LOCKER_CLIPS = [
  "Locker_Door_Check_Close",
  "Locker_Door_Check_Open",
  "Locker_Door_Close_Enter",
  "Locker_Door_Close_Exit",
  "Locker_Door_Open_Enter",
  "Locker_Door_Open_Exit",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readGlb(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} has a wrong declared size`);
  let json;
  let binary;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      json = JSON.parse(
        buffer.subarray(start, start + length).toString("utf8").replace(/[\0 ]+$/u, "").trim(),
      );
    } else if (type === 0x004e4942) {
      binary = buffer.subarray(start, start + length);
    }
    offset = start + length;
  }
  assert.ok(json && binary, `${filename} has no JSON or BIN chunk`);
  const physicalBuffer = json.buffers.find(
    (candidate) => candidate.uri === undefined
      && !candidate.extensions?.EXT_meshopt_compression?.fallback,
  );
  return { json, binary: binary.subarray(0, physicalBuffer.byteLength) };
}

test("standalone environment GLBs use exactly two immutable atlas requests and preserve their binary art", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.formatVersion, 1);
  assert.deepEqual(report.assets.map((entry) => path.basename(entry.path)), TARGETS);
  assert.deepEqual(report.policy, {
    geometryAndAnimationBinaryByteStable: true,
    sourceResolution: "BaseColor retains 512px tiles; Normal uses a reviewed 256px first-paint derivative.",
    atlasLayout: "BaseColor 512px+8px and Normal 256px+4px share an exactly equivalent normalized 4x3 layout.",
    baseColor: "ETC1S quality 10 with BasisLZ supercompression",
    normal: "Reuse theme-bootstrap 256px/tile UASTC quality 10 atlas with Zstandard supercompression",
    normalAtlasNormalizedUvEquivalent: true,
    normalAtlasSourceHashesExact: true,
    fallbackImages: false,
    applicationUrlChangesRequired: false,
  });
  assert.equal(report.atlases.length, 2);
  const expectedUris = new Set(
    report.atlases.map((atlas) => (
      `SharedTexturesBootstrapKTX2/${path.basename(atlas.path)}`
    )),
  );

  for (const entry of report.assets) {
    const filename = path.join(ROOT, entry.path);
    const buffer = await readFile(filename);
    const glb = readGlb(buffer, filename);
    assert.equal(buffer.length, entry.output.bytes, `${entry.path} bytes drifted`);
    assert.equal(sha256(buffer), entry.output.sha256, `${entry.path} hash drifted`);
    assert.equal(sha256(glb.binary), entry.geometryBinarySha256, `${entry.path} art BIN drifted`);
    assert.ok(glb.json.extensionsRequired?.includes("EXT_meshopt_compression"));
    assert.ok(glb.json.extensionsRequired?.includes("KHR_texture_basisu"));
    assert.ok(glb.json.extensionsRequired?.includes("KHR_texture_transform"));
    assert.equal(glb.json.images.length, 2);
    assert.equal(glb.json.textures.length, 2);
    assert.deepEqual(new Set(glb.json.images.map((image) => image.uri)), expectedUris);
    assert.ok(
      glb.json.images.every(
        (image) => image.bufferView === undefined
          && image.mimeType === undefined
          && image.uri.endsWith(".ktx2"),
      ),
    );
    assert.ok(
      glb.json.textures.every(
        (texture) => texture.source === undefined
          && Number.isInteger(texture.extensions?.KHR_texture_basisu?.source),
      ),
    );
    for (const material of glb.json.materials ?? []) {
      for (const textureInfo of [
        material.pbrMetallicRoughness?.baseColorTexture,
        material.normalTexture,
      ]) {
        if (!textureInfo) continue;
        const transform = textureInfo.extensions?.KHR_texture_transform;
        assert.ok(transform, `${entry.path} lost an atlas texture transform`);
        assert.ok(transform.offset.every((value) => value >= 0 && value < 1));
        // The hero locker intentionally tiles its 0..0.25 authored UV island
        // four times, so its composed Y scale can exceed one while still
        // remaining completely inside a single atlas tile.
        assert.ok(transform.scale.every((value) => value > 0 && value <= 2));
      }
    }
    const contract = glb.json.asset.extras.chasing_environment_bootstrap;
    assert.equal(contract.version, 1);
    assert.equal(contract.geometryBinarySha256, entry.geometryBinarySha256);
    assert.equal(contract.slots.length, entry.sourceSlots.length);
  }
});

test("atlas payloads retain pinned source hashes and an exactly equivalent normalized layout", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.sourceTextures.length, 22);
  assert.deepEqual(report.atlas.baseColor, {
    sourceTileWidth: 512,
    sourceTileHeight: 512,
    gutterPixels: 8,
    width: 2112,
    height: 1584,
  });
  assert.deepEqual(report.atlas.normal, {
    sourceTileWidth: 256,
    sourceTileHeight: 256,
    gutterPixels: 4,
    width: 1056,
    height: 792,
  });
  assert.equal(report.atlas.normalizedUvLayoutEquivalent, true);
  assert.equal(report.atlas.normalizedTransformMaxDelta, 0);
  assert.equal(new Set(report.atlas.textureFamilies).size, 11);

  for (const source of report.sourceTextures) {
    const buffer = await readFile(path.join(ROOT, source.path));
    const metadata = await sharp(buffer).metadata();
    assert.equal(buffer.length, source.bytes);
    assert.equal(sha256(buffer), source.sha256);
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 512);
  }

  for (const atlas of report.atlases) {
    const payload = await readFile(path.join(ROOT, atlas.path));
    assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE));
    assert.equal(payload.length, atlas.bytes);
    assert.equal(sha256(payload), atlas.sha256);
    assert.equal(path.basename(atlas.path, ".ktx2"), atlas.sha256);
    assert.equal(payload.readUInt32LE(20), atlas.width);
    assert.equal(payload.readUInt32LE(24), atlas.height);
    assert.equal(payload.readUInt32LE(40), atlas.levels);
    assert.ok(atlas.levels >= 11);
    assert.equal(
      payload.readUInt32LE(44),
      atlas.expectedMode === "ETC1S" ? 1 : 2,
    );
    assert.equal(
      atlas.expectedMode,
      atlas.textureClass === "baseColor" ? "ETC1S" : "UASTC",
    );
    assert.equal(
      atlas.sourceTileWidth / atlas.width,
      atlas.textureClass === "baseColor" ? 512 / 2112 : 256 / 1056,
    );
    assert.equal(
      atlas.gutterPixels / atlas.width,
      atlas.textureClass === "baseColor" ? 8 / 2112 : 4 / 1056,
    );
  }
  const normal = report.atlases.find(({ textureClass }) => textureClass === "normal");
  assert.equal(normal.reusedFromThemeBootstrap, true);
  assert.equal(normal.normalizedTransformMaxDelta, 0);
});

test("worst-case first playable environment is below 8 MiB and removes fourteen requests", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.totals.originalRuntimeRequests, 41);
  assert.equal(report.totals.outputRuntimeRequests, 21);
  assert.equal(report.totals.requestsSaved, 20);
  assert.ok(report.totals.outputRuntimeBytes <= 8 * 1024 * 1024);
  assert.ok(report.totals.savedPercent >= 60);
  assert.ok(report.totals.normalAtlasBytesSaved >= 1_600_000);
  assert.equal(report.levelOneFirstPlayable.originalRuntimeRequests, 26);
  assert.equal(report.levelOneFirstPlayable.outputRuntimeRequests, 12);
  assert.equal(report.levelOneFirstPlayable.requestsSaved, 14);
  assert.ok(report.levelOneFirstPlayable.outputRuntimeBytes <= 8 * 1024 * 1024);
  assert.ok(report.levelOneFirstPlayable.savedBytes >= 4_500_000);
});

test("hero locker keeps its authored hierarchy and all six animation performances", async () => {
  const filename = path.join(ROOT, "public", "models", "environment", "locker.glb");
  const glb = readGlb(await readFile(filename), filename);
  const names = new Set(glb.json.nodes.map((node) => node.name));
  for (const required of [
    "DoorPivot",
    "HideAnchor",
    "HandIK",
    "PeekAnchor",
    "CameraAnchor",
    "SearchAnchor",
  ]) {
    assert.ok(names.has(required), `hero locker lost ${required}`);
  }
  assert.deepEqual(
    glb.json.animations.map((animation) => animation.name).sort(),
    [...LOCKER_CLIPS].sort(),
  );
});

test("compact Normal atlas passes checked-in WebGL2 representative-object regression", async () => {
  const [assetReport, visualReport] = await Promise.all([
    readFile(REPORT, "utf8").then(JSON.parse),
    readFile(VISUAL_REPORT, "utf8").then(JSON.parse),
  ]);
  assert.equal(visualReport.formatVersion, 1);
  assert.match(visualReport.method, /only the external Normal atlas URI changed/u);
  assert.deepEqual(visualReport.gates, {
    minimumSilhouetteIou: 0.9999,
    maximumRgbMeanAbsoluteError: 1,
  });
  assert.equal(
    visualReport.referenceAtlas.sha256,
    "af1ba34484dd71b92ab7df43bfdc5c6b665659c18a6a111b1007106553327d66",
  );
  assert.deepEqual(
    visualReport.compactAtlas,
    assetReport.atlases.find(({ textureClass }) => textureClass === "normal"),
  );
  for (const asset of ["locker", "tree", "desk-chair", "police-car"]) {
    const entry = assetReport.assets.find(
      ({ path: assetPath }) => path.basename(assetPath) === `${asset}.glb`,
    );
    assert.deepEqual(visualReport.assets[asset], {
      path: entry.path,
      bytes: entry.output.bytes,
      sha256: entry.output.sha256,
    });
    assert.ok(
      visualReport.result[asset].silhouetteIou
        >= visualReport.gates.minimumSilhouetteIou,
    );
    assert.ok(
      visualReport.result[asset].rgbMeanAbsoluteError
        <= visualReport.gates.maximumRgbMeanAbsoluteError,
    );
  }
});

test("environment atlas pipeline check is self-contained and preserves active application GLB URLs", async () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Validated 19 byte-stable environment GLBs and 2 shared KTX2 atlases/u);

  const gameSource = await readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8");
  for (const basename of TARGETS.filter(
    (candidate) => !["front-gate.glb", "exit.glb"].includes(candidate),
  )) {
    assert.match(
      gameSource,
      new RegExp(`/models/environment/${basename.replaceAll(".", "\\.")}(?:\\?v=\\d+)?`, "u"),
      `${basename} no longer uses its established application URL`,
    );
  }
  for (const basename of [
    "campus-kit-bootstrap.glb",
    "hospital-kit-bootstrap.glb",
    "fire-station-kit-bootstrap.glb",
    "factory-kit-bootstrap.glb",
  ]) {
    assert.match(
      gameSource,
      new RegExp(`/models/environment/themes/${basename.replaceAll(".", "\\.")}(?:\\?v=\\d+)?`, "u"),
      `${basename} no longer supplies authored entrance/exit structures`,
    );
  }
  const pipelineFiles = await readdir(path.join(ROOT, "tools", "art_pipeline"));
  assert.equal(
    pipelineFiles.some((filename) => /^gltfpack(?:-macos)?(?:\.\w+)?$/u.test(filename)),
    false,
  );
});
