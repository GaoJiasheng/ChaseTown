import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { cleanBuildOutputs, ROOT } from "./clean-output.mjs";

const CLIENT_OUTPUT = path.join(ROOT, "dist", "client");
const RELEASE_MANIFEST = path.join(
  CLIENT_OUTPUT,
  "runtime-asset-manifest.json",
);

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesBelow(pathname));
    } else if (entry.isFile()) {
      files.push(pathname);
    }
  }
  return files.sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateManifest(manifest) {
  assert.equal(manifest.releaseIntegrityVersion, 1);
  assert.equal(
    manifest.firstPlayableBudget.measurement,
    "encoded-transfer-bytes",
  );
  assert.ok(
    manifest.firstPlayableBudget.criticalBytes
      <= manifest.firstPlayableBudget.maximumCriticalBytes,
    "critical first-playable budget exceeded",
  );
  assert.ok(
    manifest.firstPlayableBudget.eagerBytes
      <= manifest.firstPlayableBudget.maximumEagerBytes,
    "eager first-campaign budget exceeded",
  );
  const kinds = new Set(
    manifest.firstPlayableBudget.assets.map((asset) => asset.kind),
  );
  for (const required of ["html", "javascript", "css", "wasm", "model"]) {
    assert.ok(kinds.has(required), `release budget omits ${required}`);
  }
  assert.equal(manifest.basisTranscoder.duplicateBundlerOutputs, 0);
}

async function snapshotClient() {
  const manifestBytes = await readFile(RELEASE_MANIFEST);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  validateManifest(manifest);

  const files = await filesBelow(CLIENT_OUTPUT);
  const inventory = [];
  for (const pathname of files) {
    const bytes = await readFile(pathname);
    inventory.push({
      path: path.relative(CLIENT_OUTPUT, pathname).split(path.sep).join("/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return {
    manifestSha256: sha256(manifestBytes),
    inventory,
  };
}

async function cleanBuild() {
  await cleanBuildOutputs();
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", "build"], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return snapshotClient();
}

const first = await cleanBuild();
const second = await cleanBuild();
assert.deepEqual(
  second,
  first,
  "two clean builds produced different client artifacts or release manifests",
);
console.log(
  `Release verification passed: ${second.inventory.length} deterministic client files, `
  + `manifest ${second.manifestSha256.slice(0, 12)}.`,
);
