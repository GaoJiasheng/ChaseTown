import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const evidenceUrl = new URL(
  "../docs/porting/m3/evidence/render-after-m3-1.json",
  import.meta.url,
);

test("M3-1 browser evidence reconciles every sampled scene exactly", async () => {
  const report = JSON.parse(await readFile(evidenceUrl, "utf8"));
  assert.equal(report.results.length, 6);
  for (const result of report.results) {
    const { breakdown } = result.render;
    assert.ok(breakdown, `missing breakdown for level ${result.level}`);
    assert.equal(breakdown.reconciliation.exact, true);
    assert.equal(breakdown.reconciliation.callsError, 0);
    assert.equal(breakdown.reconciliation.trianglesError, 0);
    assert.equal(breakdown.reconciliation.fallbackCalls, 0);
    assert.deepEqual(breakdown.total, {
      calls: result.render.calls,
      triangles: result.render.triangles,
    });
    const categories = ["actor", "maze-walls", "props-dressing", "shadow-pass"];
    assert.equal(
      categories.reduce((total, category) => total + breakdown[category].calls, 0),
      result.render.calls,
    );
    assert.equal(
      categories.reduce((total, category) => total + breakdown[category].triangles, 0),
      result.render.triangles,
    );
  }
});
