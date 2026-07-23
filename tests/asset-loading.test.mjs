import assert from "node:assert/strict";
import test from "node:test";

import {
  AssetLoadError,
  assetLoadRecoveryMessage,
  auditFirstPlayableAssetBudget,
  assetRetryDelayMilliseconds,
  classifyAssetHttpStatus,
  createQaAssetFaultInjector,
  createSceneAssetLoader,
  externalAssetUrisFromGlb,
  FIRST_PLAYABLE_BUDGET_TARGET,
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

test("QA fault injection is inert without the explicit qa flag", async () => {
  let requests = 0;
  const injector = createQaAssetFaultInjector(
    "?asset-fault=http&asset-fault-count=3",
    async () => {
      requests += 1;
      return ok(7);
    },
  );
  assert.equal(injector.plan.enabled, false);
  const response = await injector.fetcher("/models/characters/kid-bootstrap.glb");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [7]);
  assert.equal(requests, 1);
  assert.equal(injector.remainingFailures(), 0);
});

test("QA HTTP fault budget is retained and then permits an in-place retry", async () => {
  let realRequests = 0;
  const injector = createQaAssetFaultInjector(
    "?qa=1&asset-fault=http&asset-fault-count=3&asset-fault-status=503",
    async () => {
      realRequests += 1;
      return ok(9);
    },
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await injector.fetcher("/models/characters/kid-bootstrap.glb?v=1");
    assert.equal(response.status, 503);
  }
  assert.equal(injector.remainingFailures(), 0);
  const recovered = await injector.fetcher("/models/characters/kid-bootstrap.glb?v=1");
  assert.deepEqual([...new Uint8Array(await recovered.arrayBuffer())], [9]);
  assert.equal(realRequests, 1);
});

test("QA offline fault uses the same recoverable network classification", async () => {
  const injector = createQaAssetFaultInjector(
    "?qa=1&asset-fault=offline&asset-fault-count=1",
    async () => ok(1),
  );
  const loader = createSceneAssetLoader({
    fetcher: injector.fetcher,
    retry: { maximumAttempts: 1 },
  });
  await assert.rejects(
    loader.fetchArrayBuffer("/models/characters/kid-bootstrap.glb?v=1"),
    (error) => {
      assert.ok(error instanceof AssetLoadError);
      assert.equal(error.code, "ASSET_NETWORK");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  loader.abort();
});

test("QA timeout fault reaches the normal loader timeout classification", async () => {
  const injector = createQaAssetFaultInjector(
    "?qa=1&asset-fault=timeout&asset-fault-count=1&asset-fault-timeout-ms=10",
    async () => ok(1),
  );
  const loader = createSceneAssetLoader({
    fetcher: injector.fetcher,
    timeoutMilliseconds: injector.plan.timeoutMilliseconds,
    retry: { maximumAttempts: 1 },
  });
  await assert.rejects(
    loader.fetchArrayBuffer("/models/characters/kid-bootstrap.glb?v=1"),
    (error) => {
      assert.ok(error instanceof AssetLoadError);
      assert.equal(error.code, "ASSET_TIMEOUT");
      return true;
    },
  );
  loader.abort();
});

test("recovery copy distinguishes offline, timeout and HTTP failures", () => {
  const timeout = new AssetLoadError("timeout", {
    code: "ASSET_TIMEOUT",
    url: "/slow.glb",
    attempt: 3,
    retryable: true,
  });
  const unavailable = new AssetLoadError("unavailable", {
    code: "ASSET_HTTP",
    url: "/down.glb",
    attempt: 3,
    retryable: true,
    status: 503,
  });
  assert.match(assetLoadRecoveryMessage(timeout), /超时.*原地重试/u);
  assert.match(assetLoadRecoveryMessage(unavailable), /HTTP 503.*原地重试/u);
  assert.match(assetLoadRecoveryMessage(timeout, false), /网络已断开.*原地重试/u);
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

test("10 Mbps first-playable manifest fits the eight-second release gate", () => {
  const mebibyte = 1024 * 1024;
  const manifest = [
    { id: "app-shell", url: "/app.js?v=1", transferBytes: 1 * mebibyte, phase: "shell", category: "shell" },
    { id: "collision", url: "/levels/01.nav", transferBytes: 0.4 * mebibyte, phase: "first-playable", category: "navigation" },
    { id: "kid-lod1", url: "/actors/kid-lod1.glb", transferBytes: 2 * mebibyte, phase: "first-playable", category: "player" },
    { id: "villain-lod1", url: "/actors/villain-lod1.glb", transferBytes: 1.5 * mebibyte, phase: "first-playable", category: "threat" },
    { id: "locker-core", url: "/props/locker-core.glb", transferBytes: 0.6 * mebibyte, phase: "first-playable", category: "hide-spot" },
    { id: "campus-core", url: "/themes/campus-core.glb", transferBytes: 1.25 * mebibyte, phase: "first-playable", category: "theme" },
    { id: "campus-dressing", url: "/themes/campus-dressing.glb", transferBytes: 12 * mebibyte, phase: "deferred", category: "theme" },
  ].map((entry) => ({ ...entry, transferBytes: Math.round(entry.transferBytes) }));
  const audit = auditFirstPlayableAssetBudget(manifest);
  assert.equal(audit.fits, true);
  assert.equal(audit.criticalTransferBytes, Math.round(6.75 * mebibyte));
  assert.equal(audit.deferredTransferBytes, 12 * mebibyte);
  assert.ok(audit.estimatedSeconds < FIRST_PLAYABLE_BUDGET_TARGET.maximumSeconds);
  assert.deepEqual(audit.exceededCategories, []);
});

test("duplicate assets transfer once and are promoted to the earliest gate", () => {
  const audit = auditFirstPlayableAssetBudget([
    {
      id: "locker-deferred",
      url: "/locker.glb?v=1",
      transferBytes: 700_000,
      phase: "deferred",
      category: "hide-spot",
    },
    {
      id: "locker-critical",
      url: "/locker.glb?v=1",
      transferBytes: 720_000,
      phase: "first-playable",
      category: "hide-spot",
    },
  ]);
  assert.equal(audit.criticalRequestCount, 1);
  assert.equal(audit.criticalTransferBytes, 720_000);
  assert.equal(audit.deferredTransferBytes, 0);
  assert.deepEqual(audit.duplicateUrls, ["/locker.glb?v=1"]);
});

test("unoptimised first-playable actors fail with actionable category and savings data", () => {
  const audit = auditFirstPlayableAssetBudget([
    { id: "kid-hi", url: "/kid.glb", transferBytes: 4_492_164, phase: "first-playable", category: "player" },
    { id: "villain-hi", url: "/villain.glb", transferBytes: 4_225_956, phase: "first-playable", category: "threat" },
    { id: "locker-hi", url: "/locker.glb", transferBytes: 2_102_276, phase: "first-playable", category: "hide-spot" },
    { id: "campus-hi", url: "/campus.glb", transferBytes: 1_585_960, phase: "first-playable", category: "theme" },
  ]);
  assert.equal(audit.fits, false);
  assert.equal(audit.fitsTransferBudget, false);
  assert.equal(audit.fitsTimeBudget, false);
  assert.ok(audit.requiredSavingsBytes > 3_000_000);
  assert.deepEqual(
    audit.exceededCategories,
    ["player", "threat", "hide-spot", "theme"],
  );
});

test("invalid manifest rows fail the audit instead of silently becoming zero-byte assets", () => {
  const audit = auditFirstPlayableAssetBudget([
    {
      id: "broken",
      url: "/broken.glb",
      transferBytes: -1,
      phase: "first-playable",
      category: "theme",
    },
  ]);
  assert.equal(audit.fits, false);
  assert.deepEqual(audit.invalidEntryIds, ["broken"]);
});
