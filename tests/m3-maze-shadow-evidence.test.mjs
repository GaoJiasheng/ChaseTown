import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (relativePath) => JSON.parse(await readFile(
  new URL(relativePath, import.meta.url),
  "utf8",
));

test("M3-2 replaces authored maze shadow geometry with a <=5k triangle proxy", async () => {
  const before = await readJson("../docs/porting/m3/evidence/shadow-before/report.json");
  const after = await readJson("../docs/porting/m3/evidence/shadow-after/report.json");
  assert.deepEqual(after.results.map(({ level }) => level), [1, 2, 4, 6, 8, 10]);
  for (const result of after.results) {
    const baseline = before.results.find(({ level }) => level === result.level);
    assert.ok(baseline, `missing level ${result.level} baseline`);
    const [proxy] = result.render.mazeShadowProxy;
    assert.ok(proxy.triangles > 0 && proxy.triangles < 5_000);
    assert.equal(proxy.visible, true);
    assert.equal(proxy.castShadow, true);
    assert.ok(
      result.render.breakdown["shadow-pass"].triangles
        < baseline.render.breakdown["shadow-pass"].triangles,
      `level ${result.level} shadow triangles did not decrease`,
    );
    assert.ok(result.comparison.rgbMae <= 6);
    assert.ok(result.comparison.darkSilhouetteIoU >= 0.9);
  }
});

test("balanced and mobile disable maze static shadow proxies", async () => {
  for (const filename of ["render-balanced-m3-2.json", "render-mobile-m3-2.json"]) {
    const report = await readJson(`../docs/porting/m3/evidence/${filename}`);
    const [result] = report.results;
    const [proxy] = result.render.mazeShadowProxy;
    assert.equal(proxy.visible, false, filename);
    assert.equal(proxy.castShadow, false, filename);
    assert.equal(result.render.breakdown["maze-walls"].calls, 33, filename);
  }
});
