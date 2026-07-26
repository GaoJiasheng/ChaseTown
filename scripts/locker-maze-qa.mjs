#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isThreeLoaderAssetFailure } from "./qa-protocol-diagnostics.mjs";
import { collectQaSourceProvenance } from "./qa-source-provenance.mjs";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://localhost:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(process.env.CHASING_QA_OUT ?? "/tmp/chasing-locker-maze-qa");
const VIEWPORT = {
  width: Number(process.env.CHASING_QA_WIDTH ?? 1512),
  height: Number(process.env.CHASING_QA_HEIGHT ?? 982),
  deviceScaleFactor: Number(process.env.CHASING_QA_DPR ?? 1),
  mobile: process.env.CHASING_QA_MOBILE === "true",
};
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
  url.searchParams.set("qa", "locker-maze-regression");
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
  const screenshotProvenance = [];
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
  const setup = [
    send("Runtime.enable"),
    send("Page.enable"),
    send("Network.enable"),
    send("Log.enable"),
    send("Emulation.setDeviceMetricsOverride", VIEWPORT),
    send("Page.bringToFront"),
  ];
  if (VIEWPORT.mobile) {
    setup.push(send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    }));
  }
  await Promise.all(setup);
  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  async function waitFor(expression, timeout = 30_000, interval = 100) {
    const started = Date.now();
    let lastForegroundAt = 0;
    let value;
    let lastError;
    while (Date.now() - started <= timeout) {
      try {
        if (Date.now() - lastForegroundAt >= 750) {
          await send("Page.bringToFront");
          lastForegroundAt = Date.now();
        }
        value = await evaluate(expression);
        lastError = undefined;
      } catch (error) {
        // React recreates the Three scene and its QA bridge while switching
        // campaign levels. Treat that brief hand-off as a polling miss instead
        // of turning a healthy level transition into a flaky test failure.
        value = false;
        lastError = error;
      }
      if (value) return value;
      await sleep(interval);
    }
    const errorSuffix = lastError instanceof Error ? `; lastError=${lastError.message}` : "";
    throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(value)}${errorSuffix}`);
  }
  async function screenshot(file) {
    const blockers = await evaluate(`({
      loading: document.querySelectorAll(".loading-card, .loading-shell").length,
      errors: document.querySelectorAll(".loading-card.error, .error-card, .load-error").length,
      canvases: document.querySelectorAll(".playfield canvas").length
    })`);
    assert.equal(blockers.loading, 0, `${file} still has loading UI`);
    assert.equal(blockers.errors, 0, `${file} contains load error UI`);
    assert.equal(blockers.canvases, 1, `${file} must contain exactly one game canvas`);
    const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const bytes = Buffer.from(result.data, "base64");
    const minimumEvidenceBytes = VIEWPORT.mobile ? 25_000 : 100_000;
    assert.ok(bytes.length >= minimumEvidenceBytes, `${file} is suspiciously small`);
    await writeFile(file, bytes);
    const evidence = {
      file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      captureBackend: "headless-shell-surface",
      viewport: VIEWPORT,
    };
    screenshotProvenance.push(evidence);
    return evidence;
  }
  return {
    socket,
    events,
    send,
    evaluate,
    waitFor,
    screenshot,
    screenshotProvenance,
  };
}

function fartherAnchor(approach, first, second) {
  const distance = (point) => Math.hypot(point.x - approach.x, point.y - approach.y);
  return distance(first) >= distance(second) ? first : second;
}

async function resumeIfBrowserFocusPaused(browser) {
  const paused = await browser.evaluate(
    "Boolean(window.__CHASING_QA__?.getState()?.paused)",
  );
  if (!paused) return;
  await browser.evaluate(
    "document.querySelector('.pause-actions .primary')?.click()",
  );
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.paused === false",
    3_000,
  );
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
  for (let index = 0; index < 10; index += 1) {
    if (index > 0) {
      await browser.evaluate(`window.__CHASING_QA__.selectLevel(${index})`);
      await browser.waitFor(
        `(() => {
          const state = window.__CHASING_QA__?.getState();
          return state?.campaign?.number === ${index + 1}
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
      `level ${index + 1} did not isolate the Director`,
    );
    await browser.evaluate("window.__CHASING_QA__.start()");
    await browser.waitFor("window.__CHASING_QA__?.getState()?.game?.phase === 'playing'", 10_000);
    // The simulation is playable slightly before the throttled presentation
    // pass publishes its first locker beacon sample on very fast bootstraps.
    await browser.waitFor(
      "Object.values(window.__CHASING_QA__?.getState()?.lockers ?? {}).some((locker) => locker.beaconVisible)",
      5_000,
    );

    const opening = await browser.evaluate("window.__CHASING_QA__.getState()");
    if (VIEWPORT.mobile) {
      const mobileLayout = await browser.evaluate(`(() => {
        const visible = (selector) => {
          const element = document.querySelector(selector);
          return Boolean(element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0);
        };
        const playfield = document.querySelector('.playfield')?.getBoundingClientRect();
        return {
          innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          stickVisible: visible('.virtual-stick'),
          actionsVisible: visible('.action-controls'),
          playfieldWidth: playfield?.width ?? 0,
          playfieldRight: playfield?.right ?? Infinity,
        };
      })()`);
      assert.ok(
        mobileLayout.scrollWidth <= mobileLayout.innerWidth + 1,
        `${opening.campaign.id} mobile layout overflows horizontally`,
      );
      assert.equal(mobileLayout.stickVisible, true, `${opening.campaign.id} has no mobile stick`);
      assert.equal(mobileLayout.actionsVisible, true, `${opening.campaign.id} has no mobile actions`);
      assert.ok(
        mobileLayout.playfieldWidth > 0 && mobileLayout.playfieldRight <= mobileLayout.innerWidth + 1,
        `${opening.campaign.id} mobile playfield is clipped`,
      );
    }
    const lockerEntries = Object.entries(opening.lockers);
    assert.equal(lockerEntries.length, opening.campaign.hideSpots.length, `${opening.campaign.id} locker count drifted`);
    const activeMarkerEntry = lockerEntries.find(([, locker]) => locker.beaconVisible);
    assert.ok(activeMarkerEntry, `${opening.campaign.id} has no active in-world hide marker`);
    const [, activeMarkerLocker] = activeMarkerEntry;
    const guide = await browser.evaluate("Boolean(document.querySelector('.hide-guide, .interaction-prompt'))");
    assert.equal(guide, true, `${opening.campaign.id} has no discoverability UI`);
    const edgeGuideVisible = await browser.evaluate("Boolean(document.querySelector('.hide-edge-marker'))");
    assert.equal(
      activeMarkerLocker.beaconViewport.centerInFrustum || edgeGuideVisible,
      true,
      `${opening.campaign.id} marker is offscreen without a direction guide`,
    );

    // Discoverability is allowed to recommend the safest currently relevant
    // hide archetype. Test the authored hard locker independently so a valid
    // soft-cover/traversal recommendation cannot mask cabinet regressions.
    const hardLockerEntry = lockerEntries.find(([, locker]) => locker.archetype === "hard-locker");
    assert.ok(hardLockerEntry, `${opening.campaign.id} has no hard-locker presentation`);
    const [lockerId, hardLocker] = hardLockerEntry;
    const chaser = fartherAnchor(hardLocker.approach, opening.campaign.playerStart, opening.campaign.exit);
    await browser.evaluate(`window.__CHASING_QA__.setScenario(${JSON.stringify({ player: hardLocker.approach, chaser })})`);
    await browser.waitFor(`window.__CHASING_QA__?.getState()?.interaction?.kind === 'enter' && window.__CHASING_QA__?.getState()?.interaction?.hideSpotId === ${JSON.stringify(lockerId)}`, 8_000);
    await browser.waitFor("document.querySelector('.interaction-prompt')?.textContent.includes('进入硬质藏柜')", 5_000);
    await sleep(260);
    const screenshotBytes = await browser.screenshot(path.join(OUTPUT, `level-${String(index + 1).padStart(2, "0")}-locker-ready.png`));

    await browser.evaluate("window.__CHASING_QA__.interact()");
    await browser.waitFor("window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'", 8_000);
    const hidden = await browser.evaluate("window.__CHASING_QA__.getState()");
    assert.equal(hidden.game.player.hideSpotId, lockerId, `${opening.campaign.id} entered the wrong locker`);
    assert.equal(hidden.interaction?.kind, "exit", `${opening.campaign.id} cannot leave the locker`);
    assert.equal(hidden.lockers[lockerId].beaconVisible, false, `${opening.campaign.id} marker should clear while hidden`);
    if ([0, 3, 6, 9].includes(index)) {
      await resumeIfBrowserFocusPaused(browser);
      await browser.waitFor(
        "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'",
        5_000,
      );
      await sleep(220);
      await browser.screenshot(path.join(OUTPUT, `level-${String(index + 1).padStart(2, "0")}-hidden.png`));
      let observeButtonCenter = null;
      if (VIEWPORT.mobile) {
        observeButtonCenter = await browser.evaluate(`(() => {
          const buttons = [...document.querySelectorAll('.action-controls button')];
          const button = buttons.at(-1);
          const bounds = button?.getBoundingClientRect();
          return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : null;
        })()`);
        assert.ok(observeButtonCenter, `${opening.campaign.id} has no touch observation button`);
        await browser.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{
            x: observeButtonCenter.x,
            y: observeButtonCenter.y,
            radiusX: 2,
            radiusY: 2,
            force: 1,
            id: 42,
          }],
        });
      } else {
        await browser.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "q",
          code: "KeyQ",
          windowsVirtualKeyCode: 81,
          nativeVirtualKeyCode: 81,
        });
      }
      await browser.waitFor(
        "['entering-peek', 'peeking'].includes(window.__CHASING_QA__?.getState()?.game?.player?.mode)",
        5_000,
      );
      await sleep(220);
      // A browser-level focus interruption clears held controls by design.
      // Re-establish the observation hold before capturing the evidence frame.
      const observationInterrupted = await browser.evaluate(`(() => {
        const state = window.__CHASING_QA__?.getState();
        return Boolean(
          state?.paused
          || !['entering-peek', 'peeking'].includes(state?.game?.player?.mode)
        );
      })()`);
      if (observationInterrupted) {
        await resumeIfBrowserFocusPaused(browser);
        await browser.waitFor(
          "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'",
          5_000,
        );
        if (VIEWPORT.mobile) {
          await browser.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [{
              x: observeButtonCenter.x,
              y: observeButtonCenter.y,
              radiusX: 2,
              radiusY: 2,
              force: 1,
              id: 42,
            }],
          });
        } else {
          await browser.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "q",
            code: "KeyQ",
            windowsVirtualKeyCode: 81,
            nativeVirtualKeyCode: 81,
          });
        }
        await browser.waitFor(
          "['entering-peek', 'peeking'].includes(window.__CHASING_QA__?.getState()?.game?.player?.mode)",
          5_000,
        );
      }
      await browser.waitFor(
        "(() => { const state = window.__CHASING_QA__?.getState(); return state?.game?.player?.mode === 'peeking' && state?.camera?.occlusion?.maxStrength < 0.01; })()",
        12_000,
      );
      await sleep(120);
      await browser.screenshot(path.join(OUTPUT, `level-${String(index + 1).padStart(2, "0")}-peek.png`));
      if (VIEWPORT.mobile) {
        await browser.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        await browser.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "q",
          code: "KeyQ",
          windowsVirtualKeyCode: 81,
          nativeVirtualKeyCode: 81,
        });
      }
      // Desktop Chrome can briefly foreground its updater tab during a long
      // headless run. The game correctly auto-pauses and clears held input;
      // resume through the real pause UI so the peek-exit transition can
      // complete instead of reporting a false gameplay failure.
      await resumeIfBrowserFocusPaused(browser);
      await browser.waitFor(
        "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'",
        5_000,
      );
    }

    await browser.evaluate("window.__CHASING_QA__.interact()");
    await browser.waitFor("window.__CHASING_QA__?.getState()?.game?.player?.mode === 'free'", 8_000);
    const exited = await browser.evaluate("window.__CHASING_QA__.getState()");
    assert.equal(exited.game.phase, "playing", `${opening.campaign.id} did not survive the hide/exit loop`);
    report.push({
      level: index + 1,
      id: opening.campaign.id,
      lockerId,
      lockerCount: lockerEntries.length,
      openingMarkerInFrustum: activeMarkerLocker.beaconViewport.centerInFrustum,
      openingEdgeGuideVisible: edgeGuideVisible,
      readyScreenshotBytes: screenshotBytes.bytes,
      readyScreenshot: screenshotBytes,
      hideExitLoop: "passed",
    });
  }

  const exceptions = browser.events.filter((event) => event.method === "Runtime.exceptionThrown");
  const severeLogs = browser.events.filter((event) => event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params?.entry?.level));
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
  const threeLoaderAssetFailures = browser.events.filter(
    isThreeLoaderAssetFailure,
  );
  assert.deepEqual(exceptions, [], "browser runtime emitted an exception");
  assert.deepEqual(consoleErrors, [], "browser console emitted an error/assertion");
  assert.deepEqual(severeLogs, [], "browser emitted warning/error log entries");
  assert.deepEqual(httpErrors, [], "browser received an HTTP error response");
  assert.deepEqual(networkFailures, [], "browser emitted a network loading failure");
  assert.deepEqual(
    threeLoaderAssetFailures,
    [],
    "THREE loader emitted a texture/model loading or decode failure",
  );
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    qaUrl: qaUrl(),
    frameDriver,
    cssMotion,
    sourceProvenance,
    screenshotProvenance: browser.screenshotProvenance,
    diagnostics: {
      runtimeExceptions: exceptions.length,
      consoleErrors: consoleErrors.length,
      severeLogs: severeLogs.length,
      httpErrors: httpErrors.length,
      networkFailures: networkFailures.length,
      threeLoaderAssetFailures: threeLoaderAssetFailures.length,
    },
    viewport: VIEWPORT,
    levels: report,
    allLevelsPassed: report.length === 10,
    allOpeningMarkersActionable: report.every((entry) => entry.openingMarkerInFrustum || entry.openingEdgeGuideVisible),
  };
  await writeFile(path.join(OUTPUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  browser.socket.close();
}
