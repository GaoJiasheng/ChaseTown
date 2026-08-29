import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (relativePath) => JSON.parse(await readFile(
  new URL(relativePath, import.meta.url),
  "utf8",
));

test("M3-3 moving sequence stays exactly aligned to directional shadow texels", async () => {
  const before = await readJson("../docs/porting/m3/evidence/shadow-stability-before/report.json");
  const after = await readJson("../docs/porting/m3/evidence/shadow-stability-after/report.json");
  assert.ok(before.movementCells >= 4);
  assert.ok(after.movementCells >= 4);
  assert.ok(before.maximumUnsnappedResidualTexels.x >= 0.45);
  assert.ok(before.maximumUnsnappedResidualTexels.y >= 0.45);
  assert.equal(after.frames.length, 10);
  for (const frame of after.frames) {
    assert.equal(frame.snapped.halfExtent, 18);
    assert.equal(frame.snapped.texelWorldSize, 36 / 2048);
    assert.ok(Math.abs(frame.snapped.residualTexelsX) < 1e-9);
    assert.ok(Math.abs(frame.snapped.residualTexelsY) < 1e-9);
  }
  const edge = after.coverage.find(({ kind }) => kind === "level-edge");
  const victory = after.coverage.find(({ kind }) => kind === "victory");
  assert.equal(edge.phase, "playing");
  assert.equal(victory.phase, "won");
  assert.equal(edge.shadowCamera.halfExtent, 18);
  assert.equal(victory.shadowCamera.halfExtent, 18);
});

test("M3-3 preserves M3-2 render workload while exposing snapped QA state", async () => {
  const before = await readJson("../docs/porting/m3/evidence/render-after-m3-2.json");
  const after = await readJson("../docs/porting/m3/evidence/render-after-m3-3.json");
  for (const result of after.results) {
    const baseline = before.results.find((entry) => (
      entry.level === result.level && entry.policeLoaded === result.policeLoaded
    ));
    assert.ok(baseline);
    // Level 1 has a documented one-draw visibility boundary; triangles differ
    // by the corresponding 1,384-triangle prop batch, not by shadow snapping.
    if (result.level !== 1) assert.equal(result.modalTotal, baseline.modalTotal);
    assert.equal(result.render.shadowCamera.halfExtent, 18);
    assert.equal(result.render.shadowCamera.texelWorldSize, 36 / 2048);
    assert.equal(result.render.shadowCamera.residualTexelsX, 0);
    assert.equal(result.render.shadowCamera.residualTexelsY, 0);
  }
});
