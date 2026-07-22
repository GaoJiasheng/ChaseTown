#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://localhost:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(process.env.CHASING_QA_OUT ?? "/tmp/chasing-locker-maze-qa");
const VIEWPORT = { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page");
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
    send("Emulation.setDeviceMetricsOverride", VIEWPORT),
  ]);
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
  async function waitFor(expression, timeout = 30_000, interval = 35) {
    const started = Date.now();
    let value;
    let lastError;
    while (Date.now() - started <= timeout) {
      try {
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
    assert.ok(bytes.length >= 100_000, `${file} is suspiciously small`);
    await writeFile(file, bytes);
    return bytes.length;
  }
  return { socket, events, send, evaluate, waitFor, screenshot };
}

function fartherAnchor(approach, first, second) {
  const distance = (point) => Math.hypot(point.x - approach.x, point.y - approach.y);
  return distance(first) >= distance(second) ? first : second;
}

await mkdir(OUTPUT, { recursive: true });
const browser = await connect();
try {
  await browser.send("Page.navigate", { url: `${BASE_URL}?qa=locker-maze-regression` });
  await browser.waitFor("document.readyState === 'complete'", 20_000);
  await browser.waitFor("window.__CHASING_QA__?.getState()?.ready", 30_000);
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");

  const report = [];
  for (let index = 0; index < 10; index += 1) {
    if (index > 0) {
      await browser.evaluate(`window.__CHASING_QA__.selectLevel(${index})`);
      await browser.waitFor(`window.__CHASING_QA__?.getState()?.campaign?.number === ${index + 1} && window.__CHASING_QA__?.getState()?.ready`, 30_000);
    }
    await browser.evaluate("window.__CHASING_QA__.start()");
    await browser.waitFor("window.__CHASING_QA__?.getState()?.game?.phase === 'playing'", 10_000);
    await sleep(320);

    const opening = await browser.evaluate("window.__CHASING_QA__.getState()");
    const lockerEntries = Object.entries(opening.lockers);
    assert.equal(lockerEntries.length, opening.campaign.hideSpots.length, `${opening.campaign.id} locker count drifted`);
    const visibleEntry = lockerEntries.find(([, locker]) => locker.beaconVisible) ?? lockerEntries[0];
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
    await browser.waitFor("document.querySelector('.interaction-prompt')?.textContent.includes('躲进储物柜')", 5_000);
    await sleep(260);
    const screenshotBytes = await browser.screenshot(path.join(OUTPUT, `level-${String(index + 1).padStart(2, "0")}-locker-ready.png`));

    await browser.evaluate("window.__CHASING_QA__.interact()");
    await browser.waitFor("window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'", 8_000);
    const hidden = await browser.evaluate("window.__CHASING_QA__.getState()");
    assert.equal(hidden.game.player.hideSpotId, lockerId, `${opening.campaign.id} entered the wrong locker`);
    assert.equal(hidden.interaction?.kind, "exit", `${opening.campaign.id} cannot leave the locker`);
    assert.equal(hidden.lockers[lockerId].beaconVisible, false, `${opening.campaign.id} marker should clear while hidden`);
    if ([0, 3, 6, 9].includes(index)) {
      await sleep(220);
      await browser.screenshot(path.join(OUTPUT, `level-${String(index + 1).padStart(2, "0")}-hidden.png`));
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
