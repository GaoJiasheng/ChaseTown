import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("M3 freezes a reproducible post-M2 render baseline before optimization", async () => {
  const report = JSON.parse(await readFile(
    path.join(ROOT, "docs", "porting", "m3", "evidence", "render-baseline-m2.json"),
    "utf8",
  ));
  assert.equal(report.sourceCommit, "9619494");
  assert.deepEqual(report.viewport, {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(report.results.length, 6);
  assert.deepEqual(
    report.results.map(({ level, policeLoaded }) => [level, policeLoaded]),
    [
      [1, false], [5, false], [10, false],
      [1, true], [5, true], [10, true],
    ],
  );
  for (const entry of report.results) {
    assert.ok(entry.sampleCount >= 20);
    assert.ok(entry.durationMilliseconds >= 950);
    assert.ok(entry.modalSampleCount >= 1);
    assert.equal(entry.readiness.ready, true);
    assert.equal(entry.readiness.decorativeReady, true);
    assert.equal(entry.readiness.deferredDressingSettled, true);
    assert.equal(entry.readiness.compiled, true);
    assert.equal(entry.readiness.compileCount, 1);
    assert.equal(entry.readiness.prewarmCount, 1);
    assert.equal(entry.render.qualityTier, "high");
    assert.equal(entry.render.qualityLock.enabled, true);
    assert.equal(entry.render.pixelRatio, 1);
    assert.ok(entry.render.calls > 0);
    assert.ok(entry.render.triangles > 0);
    assert.ok(entry.render.shadow.shadowDrawCalls > 0);
    assert.ok(entry.render.shadow.shadowTriangles > 0);
    assert.ok(entry.render.memory.geometries > 0);
    assert.ok(entry.render.memory.textures > 0);
    assert.ok(entry.render.programs > 0);
  }
  const expectedMainDelta = new Map([
    [1, { calls: 51, triangles: 100_216 }],
    [5, { calls: 52, triangles: 101_600 }],
    [10, { calls: 52, triangles: 101_600 }],
  ]);
  for (const level of [1, 5, 10]) {
    const unloaded = report.results.find((entry) => entry.level === level && !entry.policeLoaded);
    const loaded = report.results.find((entry) => entry.level === level && entry.policeLoaded);
    assert.ok(unloaded && loaded);
    assert.equal(
      loaded.render.calls - unloaded.render.calls,
      expectedMainDelta.get(level).calls,
    );
    assert.equal(
      loaded.render.triangles - unloaded.render.triangles,
      expectedMainDelta.get(level).triangles,
    );
    assert.equal(
      loaded.render.shadow.shadowDrawCalls - unloaded.render.shadow.shadowDrawCalls,
      26,
    );
    assert.equal(
      loaded.render.shadow.shadowTriangles - unloaded.render.shadow.shadowTriangles,
      50_800,
    );
  }
});

test("QA schema keeps theoretical caster estimates separate from measured shadow-pass work", async () => {
  const [source, report] = await Promise.all([
    readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8"),
    readFile(path.join(ROOT, "docs", "22_M3_择优渲染优化报告.md"), "utf8"),
  ]);
  assert.match(source, /breakdown: qaRenderBreakdownTracker\?\.snapshot\(\)/u);
  assert.match(source, /shadow: estimateShadowWorkload\(\)/u);
  assert.match(report, /render\.breakdown\["shadow-pass"\].*实际进入阴影 pass 的 GPU 工作量/u);
  assert.match(report, /render\.shadow.*场景遍历得到的理论可投影清单估算/u);
});
