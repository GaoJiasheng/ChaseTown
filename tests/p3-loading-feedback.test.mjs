import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadGameModule, readGameSource } from "./helpers/game-module-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const game = await loadGameModule(ROOT, "p3-loading-feedback");
const source = await readGameSource(ROOT);

test("P3-4 retry runs the initial request plus two approved backoff attempts", async () => {
  const attempts = [];
  const delays = [];
  const result = await game.retryWithBackoff(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error(`offline-${attempt}`);
      return "recovered";
    },
    game.P3_TUNING.retryDelaysMs,
    async (delay) => { delays.push(delay); },
  );

  assert.equal(result, "recovered");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [500, 1500]);
});

test("P3-4 retry rethrows only after all three attempts are exhausted", async () => {
  const attempts = [];
  await assert.rejects(
    game.retryWithBackoff(
      async (attempt) => {
        attempts.push(attempt);
        throw new Error("still-offline");
      },
      game.P3_TUNING.retryDelaysMs,
      async () => {},
    ),
    /still-offline/u,
  );
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("P3-4 byte aggregator sums known totals and falls back to file counts", () => {
  const aggregate = game.createByteProgressAggregator(["kid.glb", "maze.glb"]);
  assert.deepEqual(aggregate.snapshot(), {
    done: 0,
    total: 2,
    loadedBytes: 0,
    totalBytes: null,
    mode: "files",
    ratio: 0,
  });

  assert.equal(aggregate.update("kid.glb", { loaded: 100, total: 200 }).mode, "files");
  const byteSnapshot = aggregate.update("maze.glb", { loaded: 50, total: 100 });
  assert.deepEqual(byteSnapshot, {
    done: 0,
    total: 2,
    loadedBytes: 150,
    totalBytes: 300,
    mode: "bytes",
    ratio: 0.5,
  });
  assert.equal(aggregate.complete("kid.glb").ratio, 250 / 300);
  assert.deepEqual(aggregate.complete("maze.glb"), {
    done: 2,
    total: 2,
    loadedBytes: 300,
    totalBytes: 300,
    mode: "bytes",
    ratio: 1,
  });

  const unknown = game.createByteProgressAggregator(["unknown.glb"]);
  unknown.update("unknown.glb", { loaded: 321 });
  assert.deepEqual(unknown.complete("unknown.glb"), {
    done: 1,
    total: 1,
    loadedBytes: 321,
    totalBytes: null,
    mode: "files",
    ratio: 1,
  });
});

test("P3-7 one version constant covers every model and redirects shared PNGs to WebP", () => {
  assert.equal(game.ASSET_VERSION, "22");
  assert.equal(game.versionAssetUrl("/models/a.glb"), "/models/a.glb?v=22");
  assert.equal(game.versionAssetUrl("/models/a.glb?variant=night#mesh"), "/models/a.glb?variant=night&v=22#mesh");
  assert.equal(game.versionAssetUrl("/models/a.glb?v=old"), "/models/a.glb?v=22");
  assert.equal(game.versionAssetUrl("data:model/gltf-binary;base64,AAAA"), "data:model/gltf-binary;base64,AAAA");
  assert.equal(
    game.runtimeAssetUrl("/models/SharedTextures/Env_Paper_BaseColor_2K.png"),
    "/models/SharedTextures/Env_Paper_BaseColor_2K.webp?v=22",
  );
  assert.equal(
    game.runtimeAssetUrl("/models/environment/../SharedTextures/Env_Paper_Normal_2K.png?v=legacy"),
    "/models/SharedTextures/Env_Paper_Normal_2K.webp?v=22",
  );

  const modelUrls = [
    ...game.ACTOR_SPECS.map((spec) => spec.url),
    ...Object.values(game.CORE_ASSETS),
    ...Object.values(game.DETAIL_ASSETS),
  ];
  assert.equal(modelUrls.length, 29);
  assert.ok(modelUrls.every((url) => new URL(url, "https://game.test").searchParams.get("v") === "22"));
});

test("P3-6 search look is visual-only, bounded, periodic, and inactive while approaching", () => {
  const amplitude = game.P3_TUNING.searchLookAmplitude;
  const period = game.P3_TUNING.searchLookPeriodMs;
  assert.equal(game.searchLookOffset("search", null, 5000), 0);
  assert.equal(game.searchLookOffset("chase", 1000, 5000), 0);
  assert.ok(Math.abs(game.searchLookOffset("search", 1000, 1000 + period / 4) - amplitude) < 1e-12);
  assert.ok(Math.abs(game.searchLookOffset("search", 1000, 1000 + period / 2)) < 1e-12);
  assert.ok(Math.abs(game.searchLookOffset("search", 1000, 1000 + period * 3 / 4) + amplitude) < 1e-12);
  assert.ok(Math.abs(game.searchLookOffset("search", 1000, 1000 + period)) < 1e-12);
});

test("P3 source contract keeps retries, degraded textures, victory freeze, and reusable hot-path math", () => {
  assert.match(source, /retryWithBackoff\(task, P3_TUNING\.retryDelaysMs\)/u);
  assert.match(source, /degradedTextures\.add\(runtimeUrl\)/u);
  assert.match(source, /loader\.setMeshoptDecoder\(MeshoptDecoder\)/u);
  assert.match(source, /now - wonAt\.current >= P3_TUNING\.victoryFreezeMs/u);
  assert.match(source, /villainSyncOptions\.authoredHeading = searchLookRuntime\.visualHeading/u);
  assert.match(source, /world\(player\.current, playerAnchor\)/u);
  assert.match(source, /resetRenderBreakdown\(activeRenderBreakdown\)/u);
  assert.doesNotMatch(source, /world\(player\.current\)\.add\(new THREE\.Vector3/u);
});
