import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetLoadError,
  assetRetryDelayMilliseconds,
  classifyAssetHttpStatus,
  createSceneAssetLoader,
  externalAssetUrisFromGlb,
} from "../app/game/asset-loading.ts";

const bytes = (...values) => new Uint8Array(values).buffer;
const ok = (...values) => new Response(bytes(...values), { status: 200 });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function glbWithDocument(document) {
  const encoded = new TextEncoder().encode(JSON.stringify(document));
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const buffer = new ArrayBuffer(20 + paddedLength);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, paddedLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, encoded.length).set(encoded);
  new Uint8Array(buffer, 20 + encoded.length).fill(0x20);
  return buffer;
}

test("binary glTF dependencies are discoverable before Three.js parsing", () => {
  const glb = glbWithDocument({
    buffers: [{ byteLength: 12 }, { uri: "geometry.bin" }],
    images: [
      { uri: "../textures/wall.ktx2" },
      { uri: "data:image/png;base64,AA==" },
      { uri: "../textures/wall.ktx2" },
      { uri: "locker.png" },
    ],
  });
  assert.deepEqual(
    externalAssetUrisFromGlb(glb),
    ["geometry.bin", "../textures/wall.ktx2", "locker.png"],
  );
  assert.deepEqual(externalAssetUrisFromGlb(new ArrayBuffer(8)), []);
});

test("HTTP retry classification is explicit and conservative", () => {
  assert.deepEqual(classifyAssetHttpStatus(408), { retryable: true, category: "timeout" });
  assert.deepEqual(classifyAssetHttpStatus(429), { retryable: true, category: "throttled" });
  assert.deepEqual(classifyAssetHttpStatus(503), { retryable: true, category: "server" });
  assert.deepEqual(classifyAssetHttpStatus(404), { retryable: false, category: "client" });
  assert.deepEqual(classifyAssetHttpStatus(302), { retryable: false, category: "redirect" });
});

test("exponential retry delay is capped and symmetrically jittered", () => {
  const policy = {
    maximumAttempts: 5,
    baseDelayMilliseconds: 100,
    maximumDelayMilliseconds: 500,
    jitterRatio: 0.2,
  };
  assert.equal(assetRetryDelayMilliseconds(1, policy, 0.5), 100);
  assert.equal(assetRetryDelayMilliseconds(2, policy, 0.5), 200);
  assert.equal(assetRetryDelayMilliseconds(3, policy, 0), 320);
  assert.equal(assetRetryDelayMilliseconds(3, policy, 1), 480);
  assert.equal(assetRetryDelayMilliseconds(5, policy, 1), 500);
});

test("successful load returns an ArrayBuffer and forwards safe request init", async () => {
  let observedInit;
  const loader = createSceneAssetLoader({
    fetcher: async (_input, init) => {
      observedInit = init;
      return ok(3, 1, 4);
    },
  });
  const result = await loader.fetchArrayBuffer("/models/hero.glb", {
    requestInit: { cache: "force-cache", credentials: "same-origin" },
  });
  assert.deepEqual([...new Uint8Array(result)], [3, 1, 4]);
  assert.equal(observedInit.cache, "force-cache");
  assert.equal(observedInit.credentials, "same-origin");
  assert.ok(observedInit.signal instanceof AbortSignal);
  assert.deepEqual(loader.getSnapshot(), {
    activeRequests: 0,
    queuedRequests: 0,
    aborted: false,
  });
  loader.abort();
});

test("retryable HTTP failures back off before succeeding", async () => {
  let attempts = 0;
  const delays = [];
  const loader = createSceneAssetLoader({
    fetcher: async () => {
      attempts += 1;
      return attempts < 3 ? new Response(null, { status: 503 }) : ok(8);
    },
    retry: {
      maximumAttempts: 3,
      baseDelayMilliseconds: 100,
      maximumDelayMilliseconds: 1_000,
      jitterRatio: 0.2,
    },
    random: () => 0.5,
    sleeper: async (delay) => {
      delays.push(delay);
    },
  });
  const result = await loader.fetchArrayBuffer("/recover.glb");
  assert.deepEqual([...new Uint8Array(result)], [8]);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
  loader.abort();
});

test("non-retryable HTTP errors preserve status and attempt diagnostics", async () => {
  let attempts = 0;
  const loader = createSceneAssetLoader({
    fetcher: async () => {
      attempts += 1;
      return new Response(null, { status: 404 });
    },
  });
  await assert.rejects(
    loader.fetchArrayBuffer("/missing.glb"),
    (error) => {
      assert.ok(error instanceof AssetLoadError);
      assert.equal(error.code, "ASSET_HTTP");
      assert.equal(error.status, 404);
      assert.equal(error.attempt, 1);
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(attempts, 1);
  loader.abort();
});

test("network failures are retried and retain the final cause classification", async () => {
  let attempts = 0;
  const loader = createSceneAssetLoader({
    fetcher: async () => {
      attempts += 1;
      throw new TypeError("connection reset");
    },
    retry: {
      maximumAttempts: 2,
      baseDelayMilliseconds: 0,
      maximumDelayMilliseconds: 0,
      jitterRatio: 0,
    },
    sleeper: async () => {},
  });
  await assert.rejects(
    loader.fetchArrayBuffer("/network.glb"),
    (error) => {
      assert.ok(error instanceof AssetLoadError);
      assert.equal(error.code, "ASSET_NETWORK");
      assert.equal(error.attempt, 2);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(attempts, 2);
  loader.abort();
});

test("per-attempt deadline produces a retryable timeout error", async () => {
  const scheduled = [];
  const loader = createSceneAssetLoader({
    maximumConcurrentRequests: 1,
    timeoutMilliseconds: 25,
    retry: { maximumAttempts: 1 },
    scheduleTimeout: (callback, delay) => {
      scheduled.push({ callback, delay, cancelled: false });
      return scheduled.length - 1;
    },
    cancelTimeout: (index) => {
      scheduled[index].cancelled = true;
    },
    fetcher: (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  const pending = loader.fetchArrayBuffer("/slow.glb");
  await flush();
  assert.equal(scheduled[0].delay, 25);
  scheduled[0].callback();
  await assert.rejects(
    pending,
    (error) => {
      assert.ok(error instanceof AssetLoadError);
      assert.equal(error.code, "ASSET_TIMEOUT");
      assert.equal(error.attempt, 1);
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(scheduled[0].cancelled, true);
  loader.abort();
});

test("scene abort cancels an active request with a non-retryable error", async () => {
  const loader = createSceneAssetLoader({
    fetcher: (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  const pending = loader.fetchArrayBuffer("/active.glb");
  await flush();
  loader.abort(new Error("chapter changed"));
  await assert.rejects(
    pending,
    (error) => {
      assert.ok(error instanceof AssetLoadError);
      assert.equal(error.code, "ASSET_ABORTED");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(loader.getSnapshot().aborted, true);
});

test("concurrency limiter releases slots between completed fetch attempts", async () => {
  let active = 0;
  let peak = 0;
  const pendingFetches = [];
  const loader = createSceneAssetLoader({
    maximumConcurrentRequests: 2,
    fetcher: (input) => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      pendingFetches.push({
        url: String(input),
        resolve: (...payload) => {
          active -= 1;
          resolve(ok(...payload));
        },
      });
    }),
  });
  const first = loader.fetchArrayBuffer("/one.glb");
  const second = loader.fetchArrayBuffer("/two.glb");
  const third = loader.fetchArrayBuffer("/three.glb");
  await flush();
  assert.equal(pendingFetches.length, 2);
  assert.equal(loader.getSnapshot().activeRequests, 2);
  assert.equal(loader.getSnapshot().queuedRequests, 1);
  pendingFetches[0].resolve(1);
  await flush();
  assert.equal(pendingFetches.length, 3);
  pendingFetches[1].resolve(2);
  pendingFetches[2].resolve(3);
  assert.deepEqual(
    await Promise.all([first, second, third]).then((results) => results.map((value) => [...new Uint8Array(value)])),
    [[1], [2], [3]],
  );
  assert.equal(peak, 2);
  loader.abort();
});

test("request abort removes a queued fetch before it consumes a slot", async () => {
  let starts = 0;
  let resolveActive;
  const loader = createSceneAssetLoader({
    maximumConcurrentRequests: 1,
    fetcher: async () => {
      starts += 1;
      if (starts === 1) {
        await new Promise((resolve) => {
          resolveActive = resolve;
        });
      }
      return ok(starts);
    },
  });
  const first = loader.fetchArrayBuffer("/first.glb");
  const queuedController = new AbortController();
  const second = loader.fetchArrayBuffer("/queued.glb", { signal: queuedController.signal });
  await flush();
  assert.equal(starts, 1);
  assert.equal(loader.getSnapshot().queuedRequests, 1);
  queuedController.abort(new Error("no longer needed"));
  await assert.rejects(second, (error) => {
    assert.ok(error instanceof AssetLoadError);
    assert.equal(error.code, "ASSET_ABORTED");
    return true;
  });
  assert.equal(loader.getSnapshot().queuedRequests, 0);
  resolveActive();
  await first;
  assert.equal(starts, 1);
  loader.abort();
});

test("invalid loader policies fail before starting network work", () => {
  assert.throws(
    () => createSceneAssetLoader({ maximumConcurrentRequests: 0 }),
    /maximumConcurrentRequests must be a positive integer/,
  );
  assert.throws(
    () => createSceneAssetLoader({ retry: { jitterRatio: 1.1 } }),
    /jitterRatio must not exceed 1/,
  );
  assert.throws(
    () => createSceneAssetLoader({
      retry: { baseDelayMilliseconds: 500, maximumDelayMilliseconds: 100 },
    }),
    /maximumDelayMilliseconds must be at least baseDelayMilliseconds/,
  );
});
