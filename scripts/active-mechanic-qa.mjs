#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectQaSourceProvenance } from "./qa-source-provenance.mjs";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://localhost:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(process.env.CHASING_QA_OUT ?? "/tmp/chasing-active-mechanic-qa");
const VIEWPORT = { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false };
const REPRESENTATIVE_LEVELS = [0, 3, 5, 9];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const QA_BOOTSTRAP_SOURCE = `(() => {
  if (!new URLSearchParams(location.search).has("qa")) return;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const handles = new Map();
  let nextFrameId = 1;
  Object.defineProperty(window, "__CHASING_QA_FRAME_DRIVER__", { value: "timer-60hz" });
  window.requestAnimationFrame = (callback) => {
    const frameId = nextFrameId++;
    handles.set(frameId, nativeSetTimeout(() => {
      handles.delete(frameId);
      callback(performance.now());
    }, 16));
    return frameId;
  };
  window.cancelAnimationFrame = (frameId) => {
    const handle = handles.get(frameId);
    if (handle === undefined) return;
    handles.delete(frameId);
    nativeClearTimeout(handle);
  };
  Object.defineProperty(window, "__CHASING_QA_CSS_MOTION__", { value: "settled" });
  const settle = () => {
    const style = document.createElement("style");
    style.dataset.chasingQaCssMotion = "settled";
    style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}";
    document.documentElement.append(style);
  };
  if (document.documentElement) settle();
  else window.addEventListener("DOMContentLoaded", settle, { once: true });
})();`;

function qaUrl() {
  const url = new URL(BASE_URL);
  url.searchParams.set("qa", "active-mechanic-regression");
  url.searchParams.set("qaQuality", "high");
  return url.href;
}

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const pageTargets = targets.filter(
    (entry) => entry.type === "page" && !entry.url.startsWith("chrome://"),
  );
  assert.equal(
    pageTargets.length,
    1,
    `QA requires exactly one dedicated page target; found ${pageTargets.length}`,
  );
  const [target] = pageTargets;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let requestId = 0;
  const pending = new Map();
  const events = [];
  const rejectPending = (reason) => {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(reason);
    }
    pending.clear();
  };
  socket.addEventListener("close", () => {
    rejectPending(new Error("Chrome DevTools socket closed with commands pending"));
  });
  socket.addEventListener("error", () => {
    rejectPending(new Error("Chrome DevTools socket failed with commands pending"));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      events.push(message);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timeout);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out after 30000ms`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await Promise.all([
    send("Runtime.enable"),
    send("Page.enable"),
    send("Network.enable"),
    send("Log.enable"),
    send("Emulation.setDeviceMetricsOverride", VIEWPORT),
    send("Page.bringToFront"),
  ]);
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  };
  const waitFor = async (expression, timeout = 30_000, interval = 40) => {
    const started = Date.now();
    let lastForegroundAt = 0;
    let last = false;
    while (Date.now() - started <= timeout) {
      try {
        if (Date.now() - lastForegroundAt >= 750) {
          await send("Page.bringToFront");
          lastForegroundAt = Date.now();
        }
        last = await evaluate(expression);
      } catch {
        last = false;
      }
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(last)}`);
  };
  const screenshot = async (file) => {
    const blockers = await evaluate(`({
      loading: document.querySelectorAll(".loading-card, .loading-shell").length,
      errors: document.querySelectorAll(".loading-card.error, .error-card, .load-error").length,
      canvases: document.querySelectorAll(".playfield canvas").length
    })`);
    assert.equal(blockers.loading, 0, `${file} still has loading UI`);
    assert.equal(blockers.errors, 0, `${file} contains load error UI`);
    assert.equal(blockers.canvases, 1, `${file} must contain exactly one game canvas`);
    const result = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    assert.ok(bytes.length >= 100_000, `${file} is suspiciously small`);
    await writeFile(file, bytes);
    return {
      file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      captureBackend: "headless-shell-surface",
    };
  };
  return { socket, events, send, evaluate, waitFor, screenshot };
}

function fartherAnchor(point, first, second) {
  const distance = (candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y);
  return distance(first) >= distance(second) ? first : second;
}

await mkdir(OUTPUT, { recursive: true });
const sourceProvenance = collectQaSourceProvenance();
const browser = await connect();
try {
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: QA_BOOTSTRAP_SOURCE,
  });
  await browser.send("Page.navigate", { url: qaUrl() });
  await browser.waitFor("document.readyState === 'complete'", 20_000);
  await browser.waitFor(
    `(() => {
      const state = window.__CHASING_QA__?.getState();
      return state?.ready
        && state.assets?.decorativeReady === true
        && state.assets?.deferredDressingSettled === true
        && state.assets?.qaDecorativeSceneCompiled === true
        && state.assets?.qaDecorativeSceneCompileCount === 1
        && state.assets?.qaTransientArtPrewarmCount === 1
        && !document.querySelector('.loading-card, .loading-shell, .error-card, .load-error');
    })()`,
    60_000,
  );
  const frameDriver = await browser.evaluate("window.__CHASING_QA_FRAME_DRIVER__");
  const cssMotion = await browser.evaluate("window.__CHASING_QA_CSS_MOTION__");
  assert.equal(frameDriver, "timer-60hz");
  assert.equal(cssMotion, "settled");
  await browser.evaluate("window.__CHASING_QA__.setDirectorEnabled(false)");
  assert.equal(
    await browser.evaluate("window.__CHASING_QA__.getStealthProbe().director.enabled"),
    false,
  );
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");

  const report = [];
  for (const levelIndex of REPRESENTATIVE_LEVELS) {
    if (levelIndex > 0) {
      await browser.evaluate(`window.__CHASING_QA__.selectLevel(${levelIndex})`);
      await browser.waitFor(
        `(() => {
          const state = window.__CHASING_QA__?.getState();
          return state?.campaign?.number === ${levelIndex + 1}
            && state.ready
            && state.assets?.decorativeReady === true
            && state.assets?.deferredDressingSettled === true
            && state.assets?.qaDecorativeSceneCompiled === true
            && state.assets?.qaDecorativeSceneCompileCount === 1
            && state.assets?.qaTransientArtPrewarmCount === 1
            && !document.querySelector('.loading-card, .loading-shell, .error-card, .load-error');
        })()`,
        60_000,
      );
    }
    await browser.evaluate("window.__CHASING_QA__.setDirectorEnabled(false)");
    assert.equal(
      await browser.evaluate("window.__CHASING_QA__.getStealthProbe().director.enabled"),
      false,
      `level ${levelIndex + 1} did not isolate the Director`,
    );
    await browser.evaluate("window.__CHASING_QA__.start()");
    await browser.waitFor("window.__CHASING_QA__?.getState()?.game?.phase === 'playing'", 10_000);
    const opening = await browser.evaluate("window.__CHASING_QA__.getState()");
    const definition = opening.themeMechanic.definition;
    const chaser = fartherAnchor(
      definition.position,
      opening.campaign.playerStart,
      opening.campaign.exit,
    );
    await browser.evaluate(
      `window.__CHASING_QA__.setScenario(${JSON.stringify({
        player: definition.position,
        chaser,
      })})`,
    );
    // setScenario deliberately reconstructs all run state, including the
    // mission. Clear it afterwards so this focused regression measures the
    // reusable mechanic rather than mission interaction priority.
    await browser.evaluate("window.__CHASING_QA__.completeMission()");
    await browser.waitFor("window.__CHASING_QA__?.getState()?.themeMechanic?.sample?.canActivate", 8_000);
    await browser.waitFor("document.querySelector('.interaction-prompt')?.textContent.includes('启动')", 5_000);
    await sleep(260);
    const prefix = `${String(levelIndex + 1).padStart(2, "0")}-${opening.campaign.theme}`;
    const readyBytes = await browser.screenshot(path.join(OUTPUT, `${prefix}-ready.png`));

    await browser.evaluate("window.__CHASING_QA__.interact()");
    await browser.waitFor(
      "window.__CHASING_QA__?.getState()?.themeMechanic?.state?.phase === 'warning'",
      5_000,
    );
    await browser.waitFor(
      "Boolean(document.querySelector('.theme-mechanic.phase-warning'))",
      2_000,
    );
    await browser.waitFor(
      "window.__CHASING_QA__?.getState()?.themeMechanic?.state?.phase === 'active'",
      5_000,
    );
    await sleep(180);
    const active = await browser.evaluate("window.__CHASING_QA__.getState()");
    assert.equal(active.game.phase, "playing", `${opening.campaign.id} interrupted play`);
    assert.equal(active.themeMechanic.sample.inEffectArea, true);
    assert.equal(active.telemetry.themeMechanicUses, 1);
    const isDecoy = definition.soundSource.sourceType === "environment-decoy";
    assert.equal(
      active.telemetry.decoysDeployed,
      isDecoy ? 1 : 0,
      `${opening.campaign.id} did not causally register its authored sound source`,
    );
    await browser.waitFor(
      "Boolean(document.querySelector('.playfield.theme-event-active, .theme-mechanic.phase-active'))",
      2_000,
    );
    const activeBytes = await browser.screenshot(path.join(OUTPUT, `${prefix}-active.png`));
    report.push({
      level: levelIndex + 1,
      id: opening.campaign.id,
      theme: opening.campaign.theme,
      kind: definition.kind,
      warningSeconds: definition.warningSeconds,
      activeDurationSeconds: definition.activeDurationSeconds,
      soundMasking: active.themeMechanic.sample.soundMasking,
      visionRangeMultiplier: active.themeMechanic.sample.visionRangeMultiplier,
      activationCount: active.themeMechanic.state.activationCount,
      decoysDeployed: active.telemetry.decoysDeployed,
      readyScreenshotBytes: readyBytes.bytes,
      activeScreenshotBytes: activeBytes.bytes,
      screenshots: { ready: readyBytes, active: activeBytes },
    });
  }

  const exceptions = browser.events.filter((event) => event.method === "Runtime.exceptionThrown");
  const severeLogs = browser.events.filter(
    (event) => event.method === "Log.entryAdded"
      && ["error", "warning"].includes(event.params?.entry?.level),
  );
  const consoleErrors = browser.events.filter(
    (event) => event.method === "Runtime.consoleAPICalled"
      && ["error", "assert"].includes(event.params?.type),
  );
  const httpErrors = browser.events.filter(
    (event) => event.method === "Network.responseReceived"
      && event.params?.response?.status >= 400,
  );
  const networkFailures = browser.events.filter(
    (event) => event.method === "Network.loadingFailed"
      && event.params?.canceled !== true,
  );
  assert.deepEqual(exceptions, [], "browser runtime emitted an exception");
  assert.deepEqual(consoleErrors, [], "browser console emitted an error/assertion");
  assert.deepEqual(severeLogs, [], "browser emitted warning/error log entries");
  assert.deepEqual(httpErrors, [], "browser received an HTTP error response");
  assert.deepEqual(networkFailures, [], "browser emitted a network loading failure");
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    qaUrl: qaUrl(),
    frameDriver,
    cssMotion,
    sourceProvenance,
    diagnostics: {
      runtimeExceptions: exceptions.length,
      consoleErrors: consoleErrors.length,
      severeLogs: severeLogs.length,
      httpErrors: httpErrors.length,
      networkFailures: networkFailures.length,
    },
    viewport: VIEWPORT,
    representatives: report,
    allMechanicsPassed: report.length === REPRESENTATIVE_LEVELS.length
      && report.every((entry) => entry.activationCount === 1),
  };
  await writeFile(path.join(OUTPUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  browser.socket.close();
}
