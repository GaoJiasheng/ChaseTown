import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(
  ROOT,
  "docs",
  "art_production",
  "reports",
  "character-runtime-meshopt.json",
);
const EXPECTED_ARGUMENTS = [
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-noq",
  "-af",
  "0",
  "-at",
  "24",
  "-ar",
  "16",
  "-as",
  "24",
];
const ROLE_BUDGETS = new Map([
  ["kid", 5_100_000],
  ["villain", 4_850_000],
  ["police", 8_850_000],
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function glbJson(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not GLB`);
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) {
      return JSON.parse(
        buffer
          .subarray(offset + 8, offset + 8 + length)
          .toString("utf8")
          .replace(/[\0 ]+$/u, "")
          .trim(),
      );
    }
    offset += 8 + length;
  }
  throw new Error(`${filename} has no JSON chunk`);
}

test("character runtime optimization report and shipped GLBs stay reproducible", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.formatVersion, 1);
  assert.deepEqual(report.tool.arguments, EXPECTED_ARGUMENTS);
  assert.deepEqual(report.policy, {
    geometryQuantization: false,
    textureTranscode: false,
    textureReason: "Pinned Node gltfpack has no WebP encoder; KTX2 needs a separately validated Safari-capable runtime path.",
    cumulativeRepacking: false,
  });
  assert.equal(report.characters.length, ROLE_BUDGETS.size);
  assert.deepEqual(
    report.characters.map(({ role }) => role).sort(),
    [...ROLE_BUDGETS.keys()].sort(),
  );

  let sourceBytes = 0;
  let optimizedBytes = 0;
  let savedBytes = 0;
  for (const entry of report.characters) {
    const filename = path.join(ROOT, "public", "models", "characters", `${entry.role}.glb`);
    const buffer = await readFile(filename);
    const gltf = glbJson(buffer, filename);
    sourceBytes += entry.source.bytes;
    optimizedBytes += entry.optimized.bytes;
    savedBytes += entry.optimized.savedBytes;

    assert.equal(buffer.length, entry.optimized.bytes, `${entry.role} byte count drifted`);
    assert.equal(sha256(buffer), entry.optimized.sha256, `${entry.role} hash drifted`);
    assert.ok(buffer.length <= ROLE_BUDGETS.get(entry.role), `${entry.role} exceeds its runtime budget`);
    assert.ok(gltf.extensionsRequired?.includes("EXT_meshopt_compression"), `${entry.role} lost Meshopt`);
    assert.equal(
      gltf.extensionsRequired?.includes("KHR_mesh_quantization"),
      false,
      `${entry.role} unexpectedly quantized authored geometry`,
    );
    assert.equal(entry.quality.joints, 21, `${entry.role} changed its approved web rig`);
    assert.ok(entry.quality.nodes >= 34, `${entry.role} lost its authored hierarchy`);
    assert.ok(entry.quality.materials >= 6, `${entry.role} lost its authored materials`);
    assert.ok(entry.quality.clips.length >= 5, `${entry.role} lost production animation clips`);
    assert.ok(entry.quality.textures.length >= 3, `${entry.role} lost embedded surface maps`);
    assert.ok(entry.quality.boundsMaxDeltaMeters <= 1e-7, `${entry.role} bounds drifted`);
    assert.ok(entry.quality.animationDeviation.maxRotationDegrees <= 0.005, `${entry.role} rotation drifted`);
    assert.ok(entry.quality.animationDeviation.maxTranslationMeters <= 1e-6, `${entry.role} translation drifted`);
    assert.ok(entry.quality.animationDeviation.maxScaleDelta <= 5e-6, `${entry.role} scale drifted`);
    assert.ok(
      entry.quality.removedDegenerateTriangles / entry.quality.sourceTriangles <= 0.001,
      `${entry.role} lost visible geometry`,
    );
  }

  assert.equal(report.totals.sourceBytes, sourceBytes);
  assert.equal(report.totals.optimizedBytes, optimizedBytes);
  assert.equal(report.totals.savedBytes, savedBytes);
  assert.equal(report.totals.savedBytes, sourceBytes - optimizedBytes);
  assert.ok(report.totals.optimizedBytes <= 18_500_000, "character runtime payload exceeds 18.5 MB");
  assert.ok(report.totals.savedPercent >= 40, "character runtime compression regressed below 40%");
});
