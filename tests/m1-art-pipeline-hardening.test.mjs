import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PIPELINES = Object.freeze([
  {
    name: "character bootstrap",
    script: "tools/art_pipeline/build_character_bootstrap.mjs",
    report: "art-source/reports/character-bootstrap.json",
    checkArguments: ["--check", "--role", "villain"],
    outputArgument: "--output-dir",
    tamper(report) {
      report.policy.intendedUse = "tampered";
    },
  },
  {
    name: "character LOD1",
    script: "tools/art_pipeline/build_character_lod1.mjs",
    report: "art-source/reports/character-lod1.json",
    checkArguments: ["--check", "--role", "villain"],
    outputArgument: "--output-dir",
    tamper(report) {
      report.totals.savedBytes += 1;
    },
  },
  {
    name: "character Meshopt",
    script: "tools/art_pipeline/optimize_character_runtime.mjs",
    report: "docs/art_production/reports/character-runtime-meshopt.json",
    checkArguments: ["--check", "--role", "villain"],
    outputArgument: "--output-dir",
    tamper(report) {
      report.policy.geometryQuantization = true;
    },
  },
  {
    name: "runtime KTX2",
    script: "tools/art_pipeline/optimize_runtime_ktx2.mjs",
    report: "docs/art_production/reports/runtime-ktx2.json",
    checkArguments: ["--check", "--only-character", "villain"],
    outputArgument: "--output-root",
    buildArguments: ["--gltfpack", process.execPath],
    tamper(report) {
      report.policy.cumulativeRepacking = true;
    },
  },
]);

function runPipeline(pipeline, arguments_) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, pipeline.script), ...arguments_],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  );
}

test("M1 role-scoped pipeline checks reject policy and aggregate report tampering", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "m1-pipeline-report-"));
  try {
    for (const pipeline of PIPELINES) {
      await t.test(pipeline.name, async () => {
        const report = JSON.parse(await readFile(path.join(ROOT, pipeline.report), "utf8"));
        pipeline.tamper(report);
        const tamperedReport = path.join(
          temporaryDirectory,
          `${path.basename(pipeline.report, ".json")}-tampered.json`,
        );
        await writeFile(tamperedReport, `${JSON.stringify(report, null, 2)}\n`);
        const result = runPipeline(pipeline, [
          ...pipeline.checkArguments,
          "--report",
          tamperedReport,
        ]);
        assert.notEqual(
          result.status,
          0,
          `${pipeline.name} accepted a tampered report:\n${result.stdout}`,
        );
      });
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("M1 pipelines cannot couple staging output to a canonical report", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "m1-pipeline-output-"));
  try {
    for (const pipeline of PIPELINES) {
      await t.test(pipeline.name, () => {
        const result = runPipeline(pipeline, [
          pipeline.outputArgument,
          path.join(temporaryDirectory, pipeline.name.replaceAll(" ", "-")),
          ...(pipeline.buildArguments ?? []),
        ]);
        assert.notEqual(result.status, 0, `${pipeline.name} accepted an unsafe output/report pair`);
        assert.match(
          `${result.stderr}\n${result.stdout}`,
          /non-default .* requires an explicit non-default --report path/u,
        );
      });
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
