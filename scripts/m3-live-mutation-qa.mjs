import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = resolve(ROOT, "docs/porting/m3/evidence/m3-5-mutation-report.json");
const TEST_FILE = "tests/m3-live-render-contract.test.mjs";

const mutations = [
  {
    id: "actor-shadow-radial-segments",
    file: "app/game/player/actor-batching.ts",
    original: "options.radialSegments ?? 6",
    replacement: "options.radialSegments ?? 8",
    testName: "M3 live actor shadow proxy derives",
    assertionMarker: "live default actor shadow proxy must remain 344 triangles",
  },
  {
    id: "actor-batching-drops-source-mesh",
    file: "app/game/player/actor-batching.ts",
    original: "const temporary = meshes.map((mesh) => mesh.geometry.clone());",
    replacement: "const temporary = meshes.slice(0, -1).map((mesh) => mesh.geometry.clone());",
    testName: "M3 live batching conserves",
    assertionMarker: "batching dropped or duplicated source triangles",
  },
  {
    id: "actor-batching-ignores-bone-inverses",
    file: "app/game/player/actor-batching.ts",
    original: "object.skeleton.boneInverses.map((inverse) => matrixSignature(inverse, epsilon)).join(\";\"),",
    replacement: "\"mutation-ignores-bone-inverses\",",
    testName: "M3 live batching keeps compatible",
    assertionMarker: "bone/inverse guard changed the live batch partition",
  },
  {
    id: "maze-proxy-duplicates-doorways",
    file: "app/game/maze-shadow-proxy.ts",
    original: "for (const placement of batches.doorway) {",
    replacement: "for (const placement of [...batches.doorway, ...batches.doorway]) {",
    testName: "M3 live maze proxy keeps",
    assertionMarker: "live maze proxy box density or closure rule drifted",
  },
];

// Captured test output carries per-run timings and absolute paths. Both are
// environment noise: they make every re-run rewrite this committed evidence
// file even when nothing about the mutations changed. Strip them so an
// unchanged run produces byte-identical evidence.
const normalizeOutput = (output) => output
  .trim()
  .replaceAll(`file://${ROOT}/`, "")
  .replaceAll(ROOT + "/", "")
  .replace(/ \(\d+(?:\.\d+)?ms\)/gu, "")
  .replace(/\bduration_ms [\d.]+/gu, "duration_ms <elapsed>");

const run = (command, args) => spawnSync(command, args, {
  cwd: ROOT,
  encoding: "utf8",
  env: process.env,
});

const report = {
  generatedAt: new Date().toISOString(),
  testFile: TEST_FILE,
  mutations: [],
};

for (const mutation of mutations) {
  const path = resolve(ROOT, mutation.file);
  const before = readFileSync(path, "utf8");
  assert.equal(
    before.split(mutation.original).length - 1,
    1,
    `${mutation.id}: mutation anchor must occur exactly once`,
  );
  const mutated = before.replace(mutation.original, mutation.replacement);
  const command = [
    "node",
    "--experimental-strip-types",
    "--test",
    `--test-name-pattern=${mutation.testName}`,
    TEST_FILE,
  ];

  let result;
  let restored;
  try {
    writeFileSync(path, mutated);
    result = run(command[0], command.slice(1));
  } finally {
    writeFileSync(path, before);
    restored = run("git", ["diff", "--quiet", "--", mutation.file]);
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, `${mutation.id}: live-code mutation unexpectedly survived`);
  assert.match(output, new RegExp(mutation.assertionMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(
    restored.status,
    0,
    `${mutation.id}: source was not restored; git diff --quiet -- ${mutation.file} failed`,
  );

  report.mutations.push({
    id: mutation.id,
    file: mutation.file,
    change: `${mutation.original} -> ${mutation.replacement}`,
    command: command.join(" "),
    exitCode: result.status,
    assertionMarker: mutation.assertionMarker,
    failureOutput: normalizeOutput(output).split("\n").slice(-30),
    restoreCheck: `git diff --quiet -- ${mutation.file}`,
    restoredDiffQuiet: true,
  });
}

// Preserve the previous timestamp when nothing else changed, so re-running this
// verification does not dirty the working tree with a timestamp-only diff.
const withoutTimestamp = (value) => {
  const { generatedAt, ...rest } = value;
  return rest;
};
try {
  const previous = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  if (
    JSON.stringify(withoutTimestamp(previous))
    === JSON.stringify(withoutTimestamp(report))
  ) {
    report.generatedAt = previous.generatedAt;
  }
} catch {
  // No previous report to compare against; keep the fresh timestamp.
}

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
