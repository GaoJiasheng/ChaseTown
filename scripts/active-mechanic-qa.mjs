#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://localhost:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(process.env.CHASING_QA_OUT ?? "/tmp/chasing-active-mechanic-qa");
const VIEWPORT = { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false };
const REPRESENTATIVE_LEVELS = [0, 3, 5, 9];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((entry) => (
    entry.type === "page"
    && (entry.url === "about:blank" || entry.url.startsWith(BASE_URL))
  )) ?? targets.find((entry) => entry.type === "page" && !entry.url.startsWith("chrome://"));
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
    const result = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    assert.ok(bytes.length >= 100_000, `${file} is suspiciously small`);
    await writeFile(file, bytes);
    return bytes.length;
  };
  return { socket, events, send, evaluate, waitFor, screenshot };
}

function fartherAnchor(point, first, second) {
  const distance = (candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y);
  return distance(first) >= distance(second) ? first : second;
}

await mkdir(OUTPUT, { recursive: true });
const browser = await connect();
try {
  await browser.send("Page.navigate", { url: `${BASE_URL}?qa=active-mechanic-regression` });
  await browser.waitFor("document.readyState === 'complete'", 20_000);
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.ready && !document.querySelector('.loading-card')",
    60_000,
  );
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");

  const report = [];
  for (const levelIndex of REPRESENTATIVE_LEVELS) {
    if (levelIndex > 0) {
      await browser.evaluate(`window.__CHASING_QA__.selectLevel(${levelIndex})`);
      await browser.waitFor(
        `window.__CHASING_QA__?.getState()?.campaign?.number === ${levelIndex + 1} && window.__CHASING_QA__?.getState()?.ready && !document.querySelector('.loading-card')`,
        60_000,
      );
    }
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
      readyScreenshotBytes: readyBytes,
      activeScreenshotBytes: activeBytes,
    });
  }

  const exceptions = browser.events.filter((event) => event.method === "Runtime.exceptionThrown");
  const severeLogs = browser.events.filter(
    (event) => event.method === "Log.entryAdded"
      && ["error", "warning"].includes(event.params?.entry?.level),
  );
  assert.deepEqual(exceptions, [], "browser runtime emitted an exception");
  assert.deepEqual(severeLogs, [], "browser emitted warning/error log entries");
  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
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
