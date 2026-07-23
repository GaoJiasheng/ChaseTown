import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditBootstrapPair,
  CHARACTER_BOOTSTRAP_CONTRACTS,
  COMBINED_MAX_BYTES,
  FORMAT_VERSION,
  GLTFPACK_ARGUMENTS,
} from "../tools/art_pipeline/build_character_bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTER_DIRECTORY = path.join(ROOT, "public", "models", "characters");
const REPORT = path.join(ROOT, "art-source", "reports", "character-bootstrap.json");
const VISUAL_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "character-bootstrap-visual-qa.json",
);

test("bootstrap actors retain exact reference geometry, skeleton and animation transport", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.formatVersion, FORMAT_VERSION);
  assert.deepEqual(report.tool.arguments, GLTFPACK_ARGUMENTS);
  assert.deepEqual(report.policy, {
    derivativeOnly: true,
    highModelsUnmodified: true,
    lod1ModelsUnmodified: true,
    declaredReferenceModelsUnmodified: true,
    geometrySimplification: false,
    geometrySkinAnimationTransport: "Byte-identical to each declared reference model.",
    referenceVariant: {
      kid: "lod1",
      villain: "lod1",
      police: "original",
    },
    baseColor: {
      kid: "512px UASTC quality 10",
      villain: "1024px ETC1S quality 10",
      police: "skin 1024px; uniform and trouser 512px; ETC1S quality 10",
    },
    normalAndOrm: "512px UASTC quality 10",
    intendedUse: "First-paint actors; promote to their declared reference when runtime budget permits.",
  });

  const audited = [];
  for (const [role, contract] of Object.entries(CHARACTER_BOOTSTRAP_CONTRACTS)) {
    const referenceBasename = contract.referenceVariant === "lod1"
      ? `${role}-lod1.glb`
      : `${role}.glb`;
    const entry = await auditBootstrapPair(
      role,
      path.join(CHARACTER_DIRECTORY, referenceBasename),
      path.join(CHARACTER_DIRECTORY, `${role}-bootstrap.glb`),
    );
    audited.push(entry);
    assert.deepEqual(
      entry,
      report.characters.find((candidate) => candidate.role === role),
      `${role} bootstrap or LOD1 source drifted from the audited report`,
    );
    assert.ok(entry.bootstrap.bytes <= contract.maxBytes);
    assert.equal(entry.bootstrap.triangleRatio, 1);
    assert.equal(entry.quality.joints, 21);
    assert.deepEqual(entry.quality.clips, [...contract.clips].sort());
    assert.equal(entry.quality.textures.length, contract.textureCount);
    for (const texture of entry.quality.textures) {
      assert.equal(
        texture.width,
        contract.textureSizeOverrides?.[texture.name]
          ?? (texture.textureClass === "baseColor" ? contract.baseColorSize : 512),
      );
      assert.equal(
        texture.mode,
        texture.textureClass === "baseColor" ? contract.baseColorMode : "UASTC",
      );
    }
    assert.ok(entry.quality.nonImageTransport.entries > 0);
  }

  const referenceBytes = audited.reduce(
    (total, entry) => total + entry.reference.bytes,
    0,
  );
  const bootstrapBytes = audited.reduce(
    (total, entry) => total + entry.bootstrap.bytes,
    0,
  );
  assert.deepEqual(report.totals, {
    referenceBytes,
    bootstrapBytes,
    savedBytes: referenceBytes - bootstrapBytes,
    savedPercent: Number(((1 - bootstrapBytes / referenceBytes) * 100).toFixed(3)),
  });
  assert.ok(bootstrapBytes <= COMBINED_MAX_BYTES);
  assert.ok(report.totals.savedPercent >= 50);
  assert.ok(
    audited.find(({ role }) => role === "police").bootstrap.bytes <= 2 * 1024 * 1024,
  );
});

test("bootstrap actors pass the checked-in real-browser visual comparison", async () => {
  const [assetReport, visualReport] = await Promise.all([
    readFile(REPORT, "utf8").then(JSON.parse),
    readFile(VISUAL_REPORT, "utf8").then(JSON.parse),
  ]);
  assert.equal(visualReport.formatVersion, 1);
  assert.match(visualReport.method, /actual Three\.js Meshopt and KTX2 decode/u);
  assert.deepEqual(visualReport.gates, {
    minimumSilhouetteIou: 0.9999,
    maximumRgbMeanAbsoluteError: 1,
  });
  assert.match(visualReport.screenshotSha256, /^[a-f0-9]{64}$/u);
  for (const role of Object.keys(CHARACTER_BOOTSTRAP_CONTRACTS)) {
    const asset = assetReport.characters.find((candidate) => candidate.role === role);
    assert.deepEqual(visualReport.assets[role].reference, {
      path: asset.reference.path,
      bytes: asset.reference.bytes,
      sha256: asset.reference.sha256,
    });
    assert.deepEqual(visualReport.assets[role].bootstrap, {
      path: asset.bootstrap.path,
      bytes: asset.bootstrap.bytes,
      sha256: asset.bootstrap.sha256,
    });
    assert.ok(
      visualReport.result[role].silhouetteIou
        >= visualReport.gates.minimumSilhouetteIou,
    );
    assert.ok(
      visualReport.result[role].rgbMeanAbsoluteError
        <= visualReport.gates.maximumRgbMeanAbsoluteError,
    );
  }
});
