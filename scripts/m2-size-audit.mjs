#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(ROOT, "art-source", "reports", "m2-size-audit.json");
const BASELINE = Object.freeze({
  publicModels: { bytes: 47_451_053, files: 83 },
  distClientModels: { bytes: 11_098_861, files: 30 },
  distClient: { bytes: 15_990_869, files: null },
  criticalEncodedTransfer: { bytes: 7_716_893 },
});
const TARGETS = Object.freeze({
  publicModelsBytes: 24_631_610,
  distClientBytes: 12 * 1024 * 1024,
  criticalEncodedTransferBytes: 6 * 1024 * 1024,
});

async function tree(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await tree(filename);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      bytes += (await stat(filename)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

const [publicModels, distClientModels, distClient, manifest] = await Promise.all([
  tree(path.join(ROOT, "public", "models")),
  tree(path.join(ROOT, "dist", "client", "models")),
  tree(path.join(ROOT, "dist", "client")),
  readFile(path.join(ROOT, "dist", "client", "runtime-asset-manifest.json"), "utf8").then(JSON.parse),
]);
const criticalEncodedTransfer = {
  bytes: manifest.firstPlayableBudget.criticalBytes,
  remainingToTarget: TARGETS.criticalEncodedTransferBytes
    - manifest.firstPlayableBudget.criticalBytes,
};
const current = { publicModels, distClientModels, distClient, criticalEncodedTransfer };
const deltas = Object.fromEntries(
  Object.entries(current).map(([key, value]) => [
    key,
    {
      bytes: value.bytes - BASELINE[key].bytes,
      percent: Number(((value.bytes / BASELINE[key].bytes - 1) * 100).toFixed(3)),
    },
  ]),
);
const categories = {};
for (const [name, relativePath] of Object.entries({
  characters: "characters",
  sourceThemeKits: "environment/themes",
  fullSharedKtx2: "environment/SharedTexturesKTX2",
  bootstrapSharedKtx2: "environment/SharedTexturesBootstrapKTX2",
})) {
  categories[name] = await tree(path.join(ROOT, "public", "models", relativePath));
}
const report = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  measurement: "raw filesystem bytes except manifest criticalEncodedTransfer, which is encoded-transfer bytes",
  baseline: BASELINE,
  targets: TARGETS,
  current,
  deltas,
  targetResults: {
    publicModels: {
      passed: publicModels.bytes <= TARGETS.publicModelsBytes,
      overBy: Math.max(0, publicModels.bytes - TARGETS.publicModelsBytes),
    },
    distClient: {
      passed: distClient.bytes <= TARGETS.distClientBytes,
      overBy: Math.max(0, distClient.bytes - TARGETS.distClientBytes),
    },
    criticalEncodedTransfer: {
      passed: criticalEncodedTransfer.bytes <= TARGETS.criticalEncodedTransferBytes,
      overBy: Math.max(0, criticalEncodedTransfer.bytes - TARGETS.criticalEncodedTransferBytes),
    },
  },
  publicModelCategories: categories,
};
const canonical = (value) => {
  const clone = structuredClone(value);
  delete clone.generatedAt;
  return clone;
};
if (process.argv.includes("--check")) {
  const expected = JSON.parse(await readFile(REPORT, "utf8"));
  assert.deepEqual(canonical(report), canonical(expected), "M2 size report drifted");
  process.stdout.write(`M2 size report verified: first playable ${criticalEncodedTransfer.bytes} bytes.\n`);
} else {
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
