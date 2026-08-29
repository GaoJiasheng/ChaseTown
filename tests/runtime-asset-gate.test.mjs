import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(ROOT, "art-source", "reports", "runtime-asset-gate.json");

test("all shipped GLBs and KTX2 payloads pass the frozen post-conversion gate", async () => {
  const result = spawnSync(
    process.execPath,
    ["tools/art_pipeline/validate_runtime_assets.mjs", "--check"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Validator errors=0, stddev failures=0/u);

  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.validator, "gltf-validator 2.0.0-dev.3.10");
  assert.deepEqual(report.thresholds, {
    baseColorRgbStddev: 8,
    normalRgbStddev: 4,
    ormAoRedStddev: 3,
  });
  assert.equal(report.totals.glbFiles, 36);
  assert.equal(report.totals.validatorErrors, 0);
  assert.equal(report.totals.decodedKtx2Failures, 0);
  assert.equal(report.totals.stddevFailures, 0);
  assert.ok(report.totals.standaloneKtx2Files >= 20);
  assert.ok(report.totals.uniqueKtx2Payloads >= report.totals.standaloneKtx2Files);
  assert.ok(report.glbs.every((entry) => entry.errors === 0));
  assert.ok(report.ktx2.every((entry) => entry.gates.every((gate) => gate.passed)));
});
