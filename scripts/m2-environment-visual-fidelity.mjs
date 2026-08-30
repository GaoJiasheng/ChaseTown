#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "docs", "porting", "m2", "evidence", "visual");
const OUTPUT = path.join(
  ROOT,
  "art-source",
  "reports",
  "m2-environment-visual-fidelity.json",
);
const ENVIRONMENT_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "environment-bootstrap-ktx2.json",
);
const THEME_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "theme-bootstrap.json",
);
const GATES = Object.freeze({
  minimumSilhouetteIou: 0.9999,
  maximumRgbMeanAbsoluteError: 1,
});
const CASES = Object.freeze([
  { level: 1, theme: "campus", geometry: "quantized-first-playable" },
  { level: 4, theme: "hospital", geometry: "byte-identical-theme" },
  { level: 5, theme: "hospital", geometry: "byte-identical-theme" },
  { level: 6, theme: "fire-station", geometry: "byte-identical-theme" },
  { level: 8, theme: "factory", geometry: "byte-identical-theme" },
  { level: 10, theme: "factory", geometry: "byte-identical-theme" },
]);

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function round(value) {
  return Number(value.toFixed(6));
}

function glbBinarySha256(payload, label) {
  assert.equal(payload.subarray(0, 4).toString("ascii"), "glTF", `${label} is not a GLB`);
  for (let offset = 12; offset + 8 <= payload.length;) {
    const length = payload.readUInt32LE(offset);
    const type = payload.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 0x004e4942) return sha256(payload.subarray(start, start + length));
    offset = start + length;
  }
  assert.fail(`${label} has no GLB BIN chunk`);
}

function baselineThemeGlb(relativePath) {
  const result = spawnSync("git", ["show", `HEAD:${relativePath}`], {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString() || `Cannot read ${relativePath}`);
  return result.stdout;
}

async function screenshotPair(level) {
  const beforePath = path.join(EVIDENCE, "before", `level-${level}.png`);
  const afterPath = path.join(EVIDENCE, "after", `level-${level}.png`);
  const [beforeFile, afterFile, before, after] = await Promise.all([
    readFile(beforePath),
    readFile(afterPath),
    sharp(beforePath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(afterPath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  assert.deepEqual(before.info, after.info, `Level ${level} screenshot dimensions drifted`);
  let absoluteError = 0;
  let maskIntersection = 0;
  let maskUnion = 0;
  for (let offset = 0; offset < before.data.length; offset += 3) {
    const beforeLuminance = (
      before.data[offset]
      + before.data[offset + 1]
      + before.data[offset + 2]
    ) / 3;
    const afterLuminance = (
      after.data[offset]
      + after.data[offset + 1]
      + after.data[offset + 2]
    ) / 3;
    const beforeMask = beforeLuminance > 24;
    const afterMask = afterLuminance > 24;
    if (beforeMask && afterMask) maskIntersection += 1;
    if (beforeMask || afterMask) maskUnion += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      absoluteError += Math.abs(
        before.data[offset + channel] - after.data[offset + channel],
      );
    }
  }
  return {
    before: {
      path: path.relative(ROOT, beforePath).split(path.sep).join("/"),
      bytes: beforeFile.length,
      sha256: sha256(beforeFile),
    },
    after: {
      path: path.relative(ROOT, afterPath).split(path.sep).join("/"),
      bytes: afterFile.length,
      sha256: sha256(afterFile),
    },
    screenshotMaskIou: round(maskIntersection / maskUnion),
    rgbMeanAbsoluteError: round(absoluteError / before.data.length),
  };
}

const [environment, themes] = await Promise.all([
  readFile(ENVIRONMENT_REPORT, "utf8").then(JSON.parse),
  readFile(THEME_REPORT, "utf8").then(JSON.parse),
]);
const geometryProof = {};
for (const theme of ["campus", "hospital", "fire-station", "factory"]) {
  const currentEntry = themes.themes.find((entry) => entry.theme === theme);
  assert.ok(currentEntry, `Missing ${theme} theme report entry`);
  const relativePath = currentEntry.bootstrap.path;
  const [baselineGlb, currentGlb] = await Promise.all([
    Promise.resolve(baselineThemeGlb(relativePath)),
    readFile(path.join(ROOT, relativePath)),
  ]);
  const baselineGeometrySha256 = glbBinarySha256(baselineGlb, `${theme} M1`);
  const currentGeometrySha256 = glbBinarySha256(currentGlb, `${theme} M2`);
  assert.equal(
    currentGeometrySha256,
    baselineGeometrySha256,
    `${theme} geometry BIN changed during texture-only tiering`,
  );
  geometryProof[theme] = {
    baselineGlbSha256: sha256(baselineGlb),
    currentGlbSha256: sha256(currentGlb),
    baselineGeometrySha256,
    currentGeometrySha256,
  };
}

const results = [];
for (const entry of CASES) {
  const pair = await screenshotPair(entry.level);
  const silhouetteIou = entry.geometry === "byte-identical-theme"
    ? 1
    : pair.screenshotMaskIou;
  assert.ok(
    silhouetteIou >= GATES.minimumSilhouetteIou,
    `Level ${entry.level} silhouette IoU ${silhouetteIou} failed`,
  );
  assert.ok(
    pair.rgbMeanAbsoluteError <= GATES.maximumRgbMeanAbsoluteError,
    `Level ${entry.level} RGB MAE ${pair.rgbMeanAbsoluteError} failed`,
  );
  results.push({
    ...entry,
    ...pair,
    silhouetteIou,
    silhouetteMethod: entry.geometry === "byte-identical-theme"
      ? "M1 and M2 theme bootstrap BIN geometry SHA-256 are identical; JSON texture URIs and external KTX2 payloads changed."
      : "Formal-camera luminance silhouette mask; this frame contains the repacked locker and corner mirror.",
  });
}

const report = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  method: "Paired 1280x720 production-camera captures from M1 HEAD and the M2 candidate, qaCleanFrame/high quality, plus byte-identity proof for unchanged theme geometry.",
  gates: GATES,
  sourceTexturePolicy: {
    authoringPixels: 512,
    firstPlayableBaseColorPixelsPerTile: 256,
    firstPlayableNormalPixelsPerTile: 128,
    firstPlayableOrmPixelsPerTile: 128,
  },
  atlases: themes.atlases,
  environmentAssets: Object.fromEntries(
    ["locker.glb", "tree.glb", "desk-chair.glb", "police-car.glb"].map((name) => {
      const asset = environment.assets.find((candidate) => path.basename(candidate.path) === name);
      assert.ok(asset, `Missing environment report entry ${name}`);
      return [name, { path: asset.path, bytes: asset.output.bytes, sha256: asset.output.sha256 }];
    }),
  ),
  themeAssets: Object.fromEntries(
    themes.themes.map((entry) => [entry.theme, {
      source: entry.source,
      bootstrap: entry.bootstrap,
    }]),
  ),
  geometryProof,
  results,
};

await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output: path.relative(ROOT, OUTPUT), results }, null, 2)}\n`);
