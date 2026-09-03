import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (relativePath) => JSON.parse(
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
);

// The M3 shadow QA scripts default their output directory to these committed
// paths. Running them without a reference (or without the snapping expectation)
// produces a weaker artifact that carries no comparison baseline. That degraded
// shape must never be what ships as acceptance evidence.
test("committed M3 shadow evidence keeps its comparison baseline", async () => {
  const report = await readJson("docs/porting/m3/evidence/shadow-after/report.json");
  assert.ok(report.reference, "shadow-after evidence lost its reference directory");
  assert.ok(report.thresholds, "shadow-after evidence lost its thresholds");
  assert.equal(report.thresholds.rgbMaeMaximum, 6);
  assert.equal(report.thresholds.darkSilhouetteIoUMinimum, 0.9);
  assert.ok(Array.isArray(report.results) && report.results.length > 0);
  for (const entry of report.results) {
    assert.ok(
      entry.comparison,
      `level ${entry.level} lost its paired comparison`,
    );
    assert.ok(entry.comparison.rgbMae <= report.thresholds.rgbMaeMaximum);
    assert.ok(
      entry.comparison.darkSilhouetteIoU >= report.thresholds.darkSilhouetteIoUMinimum,
    );
  }
});

test("committed M3 shadow-stability evidence keeps its snapping expectation", async () => {
  const report = await readJson(
    "docs/porting/m3/evidence/shadow-stability-after/report.json",
  );
  assert.equal(
    report.expectedSnapped,
    true,
    "shadow-stability evidence was regenerated without CHASING_QA_EXPECT_SNAPPED=1",
  );
  assert.ok(report.frames.length > 0);
  assert.ok(
    report.nonZeroPreSnapFrameCount > 0,
    "pre-snap residuals are all zero, so the sampling proves nothing about snapping",
  );
  for (const frame of report.frames) {
    assert.equal(frame.shadowCamera.snappedToTexelGridX, true);
    assert.equal(frame.shadowCamera.snappedToTexelGridY, true);
    assert.equal(frame.postSnapFractionalTexels.x, 0);
    assert.equal(frame.postSnapFractionalTexels.y, 0);
  }
});
