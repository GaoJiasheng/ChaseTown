import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BEFORE_PATH = new URL(
  "../docs/porting/m3/evidence/render-m3-4-evaluation.json",
  import.meta.url,
);
const AFTER_PATH = new URL(
  "../docs/porting/m3/evidence/render-after-m3-4.json",
  import.meta.url,
);
const VISUAL_PATH = new URL(
  "../docs/porting/m3/evidence/actor-after/report.json",
  import.meta.url,
);
const ANIMATION_DIRECTORY = new URL(
  "../docs/porting/m3/evidence/actor-animation/",
  import.meta.url,
);

const readJson = async (url) => JSON.parse(await readFile(url, "utf8"));
const key = (entry) => `${entry.level}:${entry.policeLoaded ? "loaded" : "unloaded"}`;

test("M3 actor optimization preserves geometry while reducing exact actor work", async () => {
  const [before, after] = await Promise.all([readJson(BEFORE_PATH), readJson(AFTER_PATH)]);
  const beforeByKey = new Map(before.results.map((entry) => [key(entry), entry]));

  assert.equal(after.results.length, 6);
  for (const entry of after.results) {
    const baseline = beforeByKey.get(key(entry));
    assert.ok(baseline, `missing M3-4 baseline for ${key(entry)}`);
    assert.equal(entry.render.breakdown.reconciliation.exact, true);
    assert.equal(entry.render.breakdown.reconciliation.callsError, 0);
    assert.equal(entry.render.breakdown.reconciliation.trianglesError, 0);
    assert.ok(entry.render.calls < baseline.render.calls);
    assert.ok(entry.render.triangles < baseline.render.triangles);

    const actors = entry.actorOptimization;
    const expectedRoles = entry.policeLoaded
      ? ["kid", "villain", "police"]
      : ["kid", "villain"];
    assert.deepEqual(Object.keys(actors), expectedRoles);
    for (const role of expectedRoles) {
      const optimization = actors[role];
      assert.deepEqual(optimization.batch.fallbacks, []);
      assert.ok(optimization.batch.afterMeshes < optimization.batch.beforeMeshes);
      assert.equal(optimization.batch.trianglesAfter, optimization.batch.trianglesBefore);
      assert.equal(optimization.shadow.created, true);
      assert.equal(optimization.shadow.proxyMeshes, 1);
      assert.equal(optimization.shadow.proxyTriangles, 344);
      assert.ok(optimization.shadow.proxyTriangles <= 1_000);
      assert.ok(Math.abs(
        optimization.fit.batchedHeight - optimization.fit.requestedHeight,
      ) < 1e-6);
    }

    const expectedMain = entry.policeLoaded
      ? { calls: 35, triangles: 170_111 }
      : { calls: 20, triangles: 118_967 };
    const expectedShadow = entry.policeLoaded
      ? { calls: 3, triangles: 1_032 }
      : { calls: 2, triangles: 688 };
    assert.deepEqual(entry.render.breakdown.actor, expectedMain);
    assert.deepEqual(entry.render.breakdown.shadowSources.actor, expectedShadow);
  }
});

test("M3 actor batching keeps authored chase and hide clips alive in four themes", async () => {
  const representatives = [
    "01-campus-classic",
    "04-hospital-outpatient",
    "06-fire-engine-bay",
    "10-factory-foundry",
  ];
  for (const representative of representatives) {
    const [chase, hide] = await Promise.all([
      readJson(new URL(`${representative}-chase-probe.json`, ANIMATION_DIRECTORY)),
      readJson(new URL(`${representative}-hide.json`, ANIMATION_DIRECTORY)),
    ]);
    assert.equal(chase.state.game.phase, "playing");
    assert.equal(chase.state.animations.villain.state, "run");
    assert.equal(chase.state.animations.villain.clip, "Run");
    assert.equal(chase.state.animations.villain.playing, true);
    assert.equal(hide.game.player.mode, "entering-hide");
    assert.equal(hide.animations.kid.state, "enterHide");
    assert.equal(hide.animations.kid.clip, "HideEnter");
    assert.equal(hide.animations.kid.playing, true);
    assert.ok(hide.animations.kid.normalizedTime >= 0.3);
    assert.ok(hide.animations.kid.normalizedTime <= 0.7);
    assert.equal(hide.actorOptimization.kid.batch.afterMeshes, 12);
    assert.equal(hide.actorOptimization.kid.shadow.proxyTriangles, 344);
  }
});

test("M3 actor formal-camera A/B remains inside the visual fidelity gate", async () => {
  const report = await readJson(VISUAL_PATH);
  assert.equal(report.results.length, 6);
  for (const result of report.results) {
    assert.ok(result.comparison.rgbMae <= 6, `level ${result.level} RGB MAE regressed`);
    assert.ok(
      result.comparison.darkSilhouetteIoU >= 0.9,
      `level ${result.level} dark silhouette regressed`,
    );
    assert.equal(result.render.breakdown.reconciliation.exact, true);
  }
});
