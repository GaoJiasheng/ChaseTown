import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditThemeBootstrap,
  ATLAS_ARGUMENTS,
  COLD_START_MAX_BYTES,
  FORMAT_VERSION,
  GEOMETRY_ARGUMENTS,
  TEXTURE_FAMILIES,
  THEME_BOOTSTRAP_CONTRACTS,
} from "../tools/art_pipeline/build_theme_bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEME_DIRECTORY = path.join(ROOT, "public", "models", "environment", "themes");
const REPORT = path.join(ROOT, "art-source", "reports", "theme-bootstrap.json");
const VISUAL_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "theme-bootstrap-visual-qa.json",
);

test("theme bootstrap kits preserve authored runtime contracts within 2.2 MiB", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.formatVersion, FORMAT_VERSION);
  assert.deepEqual(report.tool.geometryArguments, GEOMETRY_ARGUMENTS);
  assert.deepEqual(report.tool.atlasArguments, ATLAS_ARGUMENTS);
  assert.equal(report.budget.perThemeColdStartBytes, COLD_START_MAX_BYTES);
  assert.deepEqual(report.atlasLayout.textureFamilies, TEXTURE_FAMILIES);
  assert.deepEqual(
    report.atlases.map(({ textureClass }) => textureClass),
    ["baseColor", "normal", "orm"],
  );
  assert.equal(report.atlases[0].reusedExisting, true);
  assert.equal(report.atlases[1].mode, "UASTC");
  assert.equal(report.atlases[2].mode, "ETC1S");

  const audited = [];
  for (const [theme, contract] of Object.entries(THEME_BOOTSTRAP_CONTRACTS)) {
    const entry = await auditThemeBootstrap(
      theme,
      path.join(THEME_DIRECTORY, contract.basename),
      path.join(
        THEME_DIRECTORY,
        contract.basename.replace(/\.glb$/u, "-bootstrap.glb"),
      ),
    );
    audited.push(entry);
    assert.deepEqual(
      entry,
      report.themes.find((candidate) => candidate.theme === theme),
      `${theme} source or bootstrap drifted from its report`,
    );
    assert.ok(entry.requestGraph.coldStartBytes <= COLD_START_MAX_BYTES);
    assert.equal(entry.requestGraph.requests, 4);
    assert.equal(entry.quality.namedNodeSetExact, true);
    assert.equal(entry.quality.triangleRatio, 1);
    assert.equal(entry.quality.materialIdentitySetExact, true);
    assert.equal(entry.quality.materialSemanticSetExact, true);
    assert.ok(entry.quality.sceneBoundsMaxDeltaMeters <= 0.001);
    assert.equal(entry.bootstrap.atlasRequests, 3);
    assert.ok(entry.bootstrap.savedGlbPercent >= 40);
  }
  assert.equal(audited.length, 4);
  assert.equal(
    report.totals.maximumColdStartBytes,
    Math.max(...audited.map((entry) => entry.requestGraph.coldStartBytes)),
  );
  assert.ok(report.totals.maximumColdStartBytes <= COLD_START_MAX_BYTES);
});

test("theme bootstraps pass the checked-in browser PBR and silhouette comparison", async () => {
  const [assetReport, visualReport] = await Promise.all([
    readFile(REPORT, "utf8").then(JSON.parse),
    readFile(VISUAL_REPORT, "utf8").then(JSON.parse),
  ]);
  assert.equal(visualReport.formatVersion, 1);
  assert.match(visualReport.method, /actual Three\.js Meshopt and KTX2 decode/u);
  assert.deepEqual(visualReport.gates, {
    minimumSilhouetteIou: 0.9995,
    maximumRgbMeanAbsoluteError: 3,
  });
  assert.match(visualReport.screenshotSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(visualReport.atlases, assetReport.atlases);
  for (const theme of Object.keys(THEME_BOOTSTRAP_CONTRACTS)) {
    const asset = assetReport.themes.find((entry) => entry.theme === theme);
    assert.deepEqual(visualReport.assets[theme], {
      source: asset.source,
      bootstrap: asset.bootstrap,
    });
    assert.ok(
      visualReport.result[theme].silhouetteIou
        >= visualReport.gates.minimumSilhouetteIou,
    );
    assert.ok(
      visualReport.result[theme].rgbMeanAbsoluteError
        <= visualReport.gates.maximumRgbMeanAbsoluteError,
    );
  }
});
