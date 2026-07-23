#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((entry) => (
    entry.type === "page"
    && (entry.url === "about:blank" || entry.url.startsWith(BASE_URL))
  )) ?? targets.find((entry) => entry.type === "page");
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
    const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    const bytes = Buffer.from(result.data, "base64");
    const minimumEvidenceBytes = VIEWPORT.mobile ? 25_000 : 100_000;
    assert.ok(bytes.length >= minimumEvidenceBytes, `${file} is suspiciously small`);
    await writeFile(file, bytes);
    return bytes.length;
  }
  return { socket, events, send, evaluate, waitFor, screenshot };
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
const browser = await connect();
try {
  await browser.send("Page.navigate", { url: `${BASE_URL}?qa=locker-maze-regression` });
  await browser.waitFor("document.readyState === 'complete'", 20_000);
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.ready && !document.querySelector('.loading-card')",
    60_000,
  );
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");

  const report = [];
  for (let index = 0; index < 10; index += 1) {
    if (index > 0) {
      await browser.evaluate(`window.__CHASING_QA__.selectLevel(${index})`);
      await browser.waitFor(
        `window.__CHASING_QA__?.getState()?.campaign?.number === ${index + 1} && window.__CHASING_QA__?.getState()?.ready && !document.querySelector('.loading-card')`,
        60_000,
      );
    }
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
    const visibleEntry = lockerEntries.find(([, locker]) => (
      locker.archetype === "hard-locker" && locker.beaconVisible
    )) ?? lockerEntries.find(([, locker]) => locker.archetype === "hard-locker");
    assert.ok(visibleEntry, `${opening.campaign.id} has no locker presentation`);
    const [lockerId, visibleLocker] = visibleEntry;
    assert.equal(visibleLocker.beaconVisible, true, `${opening.campaign.id} has no active in-world hide marker`);
    const guide = await browser.evaluate("Boolean(document.querySelector('.hide-guide, .interaction-prompt'))");
    assert.equal(guide, true, `${opening.campaign.id} has no discoverability UI`);
    const edgeGuideVisible = await browser.evaluate("Boolean(document.querySelector('.hide-edge-marker'))");
    assert.equal(visibleLocker.beaconViewport.centerInFrustum || edgeGuideVisible, true, `${opening.campaign.id} marker is offscreen without a direction guide`);

    const chaser = fartherAnchor(visibleLocker.approach, opening.campaign.playerStart, opening.campaign.exit);
    await browser.evaluate(`window.__CHASING_QA__.setScenario(${JSON.stringify({ player: visibleLocker.approach, chaser })})`);
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
      openingMarkerInFrustum: visibleLocker.beaconViewport.centerInFrustum,
      openingEdgeGuideVisible: edgeGuideVisible,
      readyScreenshotBytes: screenshotBytes,
      hideExitLoop: "passed",
    });
  }

  const exceptions = browser.events.filter((event) => event.method === "Runtime.exceptionThrown");
  const severeLogs = browser.events.filter((event) => event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params?.entry?.level));
  assert.deepEqual(exceptions, [], "browser runtime emitted an exception");
  assert.deepEqual(severeLogs, [], "browser emitted warning/error log entries");
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
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
