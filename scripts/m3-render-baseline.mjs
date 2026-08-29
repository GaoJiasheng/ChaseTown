#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:3000/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT
    ?? path.join(ROOT, "docs", "porting", "m3", "evidence", "render-baseline-m2.json"),
);
const SOURCE_COMMIT = process.env.CHASING_QA_SOURCE ?? "9619494";
const QUALITY = process.env.CHASING_QA_QUALITY ?? "high";
const REQUESTED_LEVELS = new Set(
  (process.env.CHASING_QA_LEVELS ?? "1,5,10")
    .split(",")
    .map(Number),
);
const POLICE_STATES = process.env.CHASING_QA_POLICE === "unloaded"
  ? [false]
  : process.env.CHASING_QA_POLICE === "loaded"
    ? [true]
    : [false, true];
const VIEWPORT = Object.freeze({
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false,
});
const CASES = Object.freeze([
  { level: 1, player: { x: 9, y: 15 }, chaser: { x: 21, y: 10 } },
  { level: 5, player: { x: 7, y: 9 }, chaser: { x: 11, y: 13 } },
  { level: 10, player: { x: 5, y: 10 }, chaser: { x: 9, y: 13 } },
]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connect() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  } catch (error) {
    throw new Error(
      `Chrome DevTools is unavailable on port ${DEBUG_PORT}; launch Chrome with --remote-debugging-port=${DEBUG_PORT}`,
      { cause: error },
    );
  }
  const target = targets.find((entry) => entry.type === "page" && entry.url === "about:blank")
    ?? targets.find((entry) => entry.type === "page" && entry.url.startsWith(BASE_URL))
    ?? targets.find((entry) => entry.type === "page" && !entry.url.startsWith("chrome://"));
  assert.ok(target, "Chrome has no inspectable page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      events.push(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await Promise.all([
    send("Runtime.enable"),
    send("Page.enable"),
    send("Network.enable"),
    send("Log.enable"),
  ]);
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text,
      );
    }
    return response.result.value;
  };
  const waitFor = async (expression, timeoutMilliseconds = 45_000) => {
    const started = Date.now();
    let value;
    while (Date.now() - started <= timeoutMilliseconds) {
      value = await evaluate(expression);
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(value)}`);
  };
  const navigate = async (url) => {
    await send("Page.navigate", { url });
    await waitFor("document.readyState === 'complete'", 20_000);
  };
  return { socket, events, send, evaluate, waitFor, navigate };
}

function sampleSummary(samples) {
  assert.ok(samples.length >= 20, `Expected at least 20 rAF samples, received ${samples.length}`);
  const totals = samples.map(({ calls, triangles }) => `${calls}/${triangles}`);
  const uniqueTotals = [...new Set(totals)];
  const frequencies = new Map();
  for (const total of totals) frequencies.set(total, (frequencies.get(total) ?? 0) + 1);
  const [modalTotal, modalSampleCount] = [...frequencies].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];
  const selected = [...samples].reverse().find(
    ({ calls, triangles }) => `${calls}/${triangles}` === modalTotal,
  );
  assert.ok(selected, "rAF sample set is empty");
  const durationMilliseconds = samples.at(-1).at - samples[0].at;
  assert.ok(durationMilliseconds >= 950, `rAF window was too short: ${durationMilliseconds}ms`);
  return {
    sampleCount: samples.length,
    durationMilliseconds: Number(durationMilliseconds.toFixed(3)),
    uniqueTotals,
    modalTotal,
    modalSampleCount,
    observedRanges: {
      calls: {
        minimum: Math.min(...samples.map(({ calls }) => calls)),
        maximum: Math.max(...samples.map(({ calls }) => calls)),
      },
      triangles: {
        minimum: Math.min(...samples.map(({ triangles }) => triangles)),
        maximum: Math.max(...samples.map(({ triangles }) => triangles)),
      },
    },
    render: selected.render,
  };
}

await mkdir(path.dirname(OUTPUT), { recursive: true });
const cdp = await connect();
const results = [];

try {
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  for (const policeLoaded of POLICE_STATES) {
    for (const entry of CASES.filter(({ level }) => REQUESTED_LEVELS.has(level))) {
      const url = new URL(BASE_URL);
      url.searchParams.set("qa", "m3-baseline");
      url.searchParams.set("qaQuality", QUALITY);
      url.searchParams.set("qaCleanFrame", "1");
      url.searchParams.set("qaLevel", String(entry.level));
      url.searchParams.set("qaPlayer", `${entry.player.x},${entry.player.y}`);
      url.searchParams.set("qaChaser", `${entry.chaser.x},${entry.chaser.y}`);
      url.searchParams.set("qaSpawnDelay", "60");
      url.searchParams.set("autostart", "1");
      if (policeLoaded) url.searchParams.set("qaPoliceClip", "idle");
      await cdp.navigate(url.href);
      await cdp.waitFor(`(() => {
        const state = window.__CHASING_QA__?.getState();
        return state?.ready === true
          && state.campaign?.number === ${entry.level}
          && state.game?.phase === "playing"
          && state.assets?.decorativeReady === true
          && state.assets?.deferredDressingSettled === true
          && state.assets?.qaDecorativeSceneCompiled === true
          && state.assets?.qaDecorativeSceneCompileCount === 1
          && state.assets?.qaTransientArtPrewarmCount === 1
          && state.assets?.policeLoaded === ${policeLoaded};
      })()`);
      await sleep(350);
      const samples = await cdp.evaluate(`new Promise((resolve) => {
        const samples = [];
        let startedAt;
        const frame = (now) => {
          if (startedAt === undefined) startedAt = now;
          const state = window.__CHASING_QA__.getState();
          samples.push({
            at: now,
            calls: state.render.calls,
            triangles: state.render.triangles,
            render: state.render,
          });
          if (now - startedAt >= 1_000) resolve(samples);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      })`);
      const state = await cdp.evaluate("window.__CHASING_QA__.getState()");
      assert.equal(state.render.qualityTier, QUALITY);
      assert.equal(state.render.qualityLock.enabled, true);
      assert.equal(state.render.pixelRatio, 1);
      assert.equal(state.assets.policeLoaded, policeLoaded);
      if (state.render.breakdown) {
        assert.equal(state.render.breakdown.reconciliation.exact, true);
        assert.equal(state.render.breakdown.reconciliation.callsError, 0);
        assert.equal(state.render.breakdown.reconciliation.trianglesError, 0);
        assert.equal(state.render.breakdown.total.calls, state.render.calls);
        assert.equal(state.render.breakdown.total.triangles, state.render.triangles);
      }
      results.push({
        level: entry.level,
        scenario: { player: entry.player, chaser: entry.chaser, spawnDelaySeconds: 60 },
        policeLoaded,
        readiness: {
          ready: state.ready,
          decorativeReady: state.assets.decorativeReady,
          deferredDressingSettled: state.assets.deferredDressingSettled,
          compiled: state.assets.qaDecorativeSceneCompiled,
          compileCount: state.assets.qaDecorativeSceneCompileCount,
          prewarmCount: state.assets.qaTransientArtPrewarmCount,
        },
        policeLoadedIdentity: state.assets.policeLoadedIdentity,
        ...sampleSummary(samples),
      });
    }
  }

  const diagnostics = cdp.events.flatMap((event) => {
    if (event.method === "Runtime.exceptionThrown") {
      return [{ type: "exception", detail: event.params.exceptionDetails.text }];
    }
    if (
      event.method === "Runtime.consoleAPICalled"
      && ["error", "warning"].includes(event.params.type)
    ) {
      return [{
        type: `console-${event.params.type}`,
        args: event.params.args.map((argument) => argument.value ?? argument.description),
      }];
    }
    if (
      event.method === "Log.entryAdded"
      && ["error", "warning"].includes(event.params.entry.level)
    ) {
      return [{
        type: "log",
        level: event.params.entry.level,
        text: event.params.entry.text,
      }];
    }
    return [];
  });
  const fatalDiagnostics = diagnostics.filter((entry) => (
    entry.type === "exception"
    || entry.type === "console-error"
    || (entry.type === "log" && entry.level === "error")
  ));
  assert.deepEqual(fatalDiagnostics, []);
  const report = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceCommit: SOURCE_COMMIT,
    method: `1280x720, DPR1, ${QUALITY} locked before renderer creation; ready + decorative settled + compiled once + prewarmed once; fixed scenario; one continuous second of main-world requestAnimationFrame samples.`,
    viewport: VIEWPORT,
    diagnostics,
    results,
  };
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: path.relative(ROOT, OUTPUT), results }, null, 2)}\n`);
} finally {
  cdp.socket.close();
}
