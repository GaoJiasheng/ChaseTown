import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(
  ROOT,
  "docs",
  "art_production",
  "reports",
  "runtime-ktx2.json",
);
const SCRIPT = path.join(ROOT, "tools", "art_pipeline", "optimize_runtime_ktx2.mjs");
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const TARGETS = [
  "public/models/characters/kid.glb",
  "public/models/characters/villain.glb",
  "public/models/characters/police.glb",
  "public/models/environment/themes/campus-kit.glb",
  "public/models/environment/themes/hospital-kit.glb",
  "public/models/environment/themes/fire-station-kit.glb",
  "public/models/environment/themes/factory-kit.glb",
];
const UASTC_ARGUMENTS = [
  "-c", "-kn", "-km", "-ke", "-noq", "-af", "0", "-at", "24", "-ar", "16", "-as", "24",
  "-tu", "-tq", "10", "-tj", "4",
];
const THEME_ARGUMENTS = [
  "-c", "-kn", "-km", "-ke", "-noq", "-af", "0", "-at", "24", "-ar", "16", "-as", "24",
  "-tc", "color", "-tu", "normal,attrib", "-tq", "color", "10",
  "-tq", "normal,attrib", "10", "-tj", "4",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readGlb(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
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
  return { json, binary };
}

async function ktx2Image(glb, image, filename, label) {
  if (image.bufferView !== undefined) {
    assert.equal(image.mimeType, "image/ktx2", `${label} is not embedded KTX2`);
    assert.equal(image.uri, undefined);
    const view = glb.json.bufferViews[image.bufferView];
    const start = view.byteOffset ?? 0;
    return glb.binary.subarray(start, start + view.byteLength);
  }
  assert.equal(image.mimeType, undefined);
  assert.ok(image.uri?.endsWith(".ktx2"), `${label} has no shared KTX2 URI`);
  return readFile(path.resolve(path.dirname(filename), image.uri));
}

test("runtime KTX2 report pins every approved asset, texture mode, and structure signature", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.formatVersion, 1);
  assert.deepEqual(report.policy, {
    geometryRepacked: false,
    semanticHierarchyByteStable: true,
    characterTextures: "UASTC quality 10 with Zstandard supercompression",
    themeColorTextures: "ETC1S quality 10 with BasisLZ supercompression",
    themeNormalAndAttributeTextures: "UASTC quality 10 with Zstandard supercompression",
    themeTextureStorage: "External SHA-256-addressed KTX2 payloads shared across all four theme packages.",
    lockerTextures: "Retain the existing shared external PNG contract; no duplicate KTX2 payload.",
    sourceTextureFallbacks: false,
    cumulativeRepacking: false,
  });
  assert.deepEqual(report.tool, {
    name: "gltfpack",
    version: "gltfpack 1.2",
    nativeBinaryCommitted: false,
    encoderInput: "Pinned Sharp 0.35.0 converts legacy WebP sources to temporary PNG only.",
  });
  assert.deepEqual(report.assets.map((entry) => entry.path), TARGETS);

  let sourceBytes = 0;
  let outputBytes = 0;
  const referencedSharedTextures = new Set();
  for (const entry of report.assets) {
    const filename = path.join(ROOT, entry.path);
    const buffer = await readFile(filename);
    const glb = readGlb(buffer, filename);
    sourceBytes += entry.source.bytes;
    outputBytes += entry.output.bytes;

    assert.equal(buffer.length, entry.output.bytes, `${entry.path} byte count drifted`);
    assert.equal(sha256(buffer), entry.output.sha256, `${entry.path} SHA-256 drifted`);
    assert.ok(glb.json.extensionsRequired?.includes("EXT_meshopt_compression"), `${entry.path} lost Meshopt`);
    assert.ok(glb.json.extensionsRequired?.includes("KHR_texture_basisu"), `${entry.path} lost KTX2`);
    assert.equal(glb.json.extensionsRequired?.includes("EXT_texture_webp"), false, `${entry.path} kept a duplicate WebP fallback`);
    assert.equal(entry.structure.nodes.count, glb.json.nodes.length);
    assert.equal(entry.structure.materials.count, glb.json.materials.length);
    assert.equal(entry.structure.animations.count, glb.json.animations?.length ?? 0);
    assert.equal(entry.textures.length, glb.json.images.length);
    assert.equal(entry.gpuUploadEstimate.savedPercent, 75);
    assert.ok(entry.gpuUploadEstimate.savedBytes > 0);

    const isTheme = entry.policy === "theme-mixed";
    assert.deepEqual(entry.arguments, isTheme ? THEME_ARGUMENTS : UASTC_ARGUMENTS);
    for (const [imageIndex, image] of glb.json.images.entries()) {
      const payload = await ktx2Image(glb, image, filename, `${entry.path} image ${imageIndex}`);
      const textureReport = entry.textures[imageIndex];
      if (isTheme) {
        assert.equal(image.uri, textureReport.uri);
        referencedSharedTextures.add(
          path.relative(ROOT, path.resolve(path.dirname(filename), image.uri)).split(path.sep).join("/"),
        );
      }
      assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE));
      assert.equal(payload.length, textureReport.bytes);
      assert.equal(sha256(payload), textureReport.sha256);
      assert.equal(payload.readUInt32LE(20), textureReport.width);
      assert.equal(payload.readUInt32LE(24), textureReport.height);
      assert.equal(payload.readUInt32LE(40), textureReport.levels);
      assert.equal(
        payload.readUInt32LE(44),
        textureReport.expectedMode === "ETC1S" ? 1 : 2,
      );
      assert.equal(
        textureReport.expectedMode,
        isTheme && image.name.includes("_BaseColor_") ? "ETC1S" : "UASTC",
      );
    }
    for (const [textureIndex, texture] of glb.json.textures.entries()) {
      assert.equal(texture.source, undefined, `${entry.path} texture ${textureIndex} kept a PNG/WebP source`);
      const source = texture.extensions?.KHR_texture_basisu?.source;
      assert.ok(Number.isInteger(source) && source >= 0 && source < glb.json.images.length);
    }
  }

  assert.deepEqual(
    [...referencedSharedTextures].sort(),
    report.sharedTextures.map((entry) => entry.path).sort(),
  );
  const sharedTextureBytes = report.sharedTextures.reduce((total, entry) => total + entry.bytes, 0);
  assert.equal(report.sharedTextures.length, 22);
  assert.equal(report.totals.sourceAssetBytes, sourceBytes);
  assert.equal(report.totals.outputAssetBytes, outputBytes);
  assert.equal(report.totals.sharedTextureBytes, sharedTextureBytes);
  assert.equal(report.totals.deploymentBytes, outputBytes + sharedTextureBytes);
  assert.equal(report.totals.savedBytes, sourceBytes - report.totals.deploymentBytes);
  assert.ok(report.totals.deploymentBytes <= 24_000_000, "KTX2 deployment exceeds its 24 MB ceiling");
  assert.ok(report.totals.deduplicatedBytes >= 6_000_000, "cross-theme texture dedupe regressed");

  for (const texture of report.sharedTextures) {
    assert.match(
      texture.path,
      /^public\/models\/environment\/SharedTexturesKTX2\/[a-f0-9]{64}\.ktx2$/u,
    );
    assert.equal(path.basename(texture.path, ".ktx2"), texture.sha256);
    assert.ok(texture.sourceNames.length >= 1);
    const buffer = await readFile(path.join(ROOT, texture.path));
    assert.equal(buffer.length, texture.bytes);
    assert.equal(sha256(buffer), texture.sha256);
    assert.ok(buffer.subarray(0, 12).equals(KTX2_SIGNATURE));
  }
});

test("checked-in Basis transcoder is byte-identical to the pinned Three.js runtime", async () => {
  for (const basename of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
    const source = await readFile(
      path.join(ROOT, "node_modules", "three", "examples", "jsm", "libs", "basis", basename),
    );
    const shipped = await readFile(path.join(ROOT, "public", "basis", basename));
    assert.ok(shipped.length > 50_000, `${basename} looks truncated`);
    assert.ok(shipped.equals(source), `${basename} drifted from the pinned Three.js copy`);
  }
});

test("hero locker consumes the shared two-atlas bootstrap without duplicating texture payloads", async () => {
  const filename = path.join(ROOT, "public", "models", "environment", "locker.glb");
  const glb = readGlb(await readFile(filename), filename);
  assert.ok(glb.json.extensionsRequired?.includes("KHR_texture_basisu"));
  assert.ok(glb.json.extensionsRequired?.includes("KHR_texture_transform"));
  assert.equal(glb.json.images.length, 2);
  assert.equal(glb.json.textures.length, 2);
  assert.ok(
    glb.json.images.every(
      (image) => image.bufferView === undefined
        && image.uri?.startsWith("SharedTexturesBootstrapKTX2/")
        && image.uri.endsWith(".ktx2"),
    ),
  );
  assert.ok(
    glb.json.textures.every(
      (texture) => texture.source === undefined
        && Number.isInteger(texture.extensions?.KHR_texture_basisu?.source),
    ),
  );
});

test("KTX2 pipeline check is self-contained and no native encoder binary is committed", async () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Validated 7 KTX2 runtime assets and 22 shared textures/u);

  const pipelineFiles = await readdir(path.join(ROOT, "tools", "art_pipeline"));
  assert.equal(
    pipelineFiles.some((filename) => /^gltfpack(?:-macos)?(?:\.\w+)?$/u.test(filename)),
    false,
    "native gltfpack must remain an external build prerequisite",
  );
});
