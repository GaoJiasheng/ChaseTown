#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:3000/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(process.env.CHASING_QA_OUT ?? "docs/porting/m3/evidence/shadow-after");
const REFERENCE = process.env.CHASING_QA_REFERENCE
  ? path.resolve(process.env.CHASING_QA_REFERENCE)
  : null;
const SOURCE = process.env.CHASING_QA_SOURCE ?? "working-tree";
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false };
const CASES = [
  { level: 1, player: { x: 9, y: 15 }, chaser: { x: 21, y: 10 } },
  { level: 2, player: { x: 18, y: 2 }, chaser: { x: 18, y: 18 } },
  { level: 4, player: { x: 9, y: 5 }, chaser: { x: 19, y: 8 } },
  { level: 6, player: { x: 10, y: 10 }, chaser: { x: 21, y: 7 } },
  { level: 8, player: { x: 10, y: 9 }, chaser: { x: 18, y: 17 } },
  { level: 10, player: { x: 5, y: 10 }, chaser: { x: 9, y: 13 } },
];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page" && entry.url === "about:blank")
    ?? targets.find((entry) => entry.type === "page" && !entry.url.startsWith("chrome://"));
  assert.ok(target, "Chrome has no inspectable page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
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
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  await Promise.all([send("Runtime.enable"), send("Page.enable"), send("Log.enable")]);
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, timeout = 45_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  return { socket, events, send, evaluate, waitFor };
}

async function compareImages(currentPath, referencePath) {
  const current = await sharp(currentPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const reference = await sharp(referencePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(current.info, reference.info, "paired screenshot dimensions/channels changed");
  let error = 0;
  let changedPixels = 0;
  let darkIntersection = 0;
  let darkUnion = 0;
  const pixels = current.info.width * current.info.height;
  for (let offset = 0; offset < current.data.length; offset += 3) {
    let maximumDifference = 0;
    let currentLuma = 0;
    let referenceLuma = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(current.data[offset + channel] - reference.data[offset + channel]);
      error += difference;
      maximumDifference = Math.max(maximumDifference, difference);
      const weight = channel === 1 ? 0.7152 : channel === 0 ? 0.2126 : 0.0722;
      currentLuma += current.data[offset + channel] * weight;
      referenceLuma += reference.data[offset + channel] * weight;
    }
    if (maximumDifference > 12) changedPixels += 1;
    const currentDark = currentLuma < 92;
    const referenceDark = referenceLuma < 92;
    if (currentDark || referenceDark) darkUnion += 1;
    if (currentDark && referenceDark) darkIntersection += 1;
  }
  return {
    rgbMae: Number((error / current.data.length).toFixed(4)),
    changedPixelRatio: Number((changedPixels / pixels).toFixed(5)),
    darkSilhouetteIoU: Number((darkIntersection / Math.max(1, darkUnion)).toFixed(5)),
  };
}

await mkdir(OUTPUT, { recursive: true });
const cdp = await connect();
const results = [];
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
  for (const entry of CASES) {
    const url = new URL(BASE_URL);
    url.searchParams.set("qa", "m3-shadow-visual");
    url.searchParams.set("qaQuality", "high");
    url.searchParams.set("qaCleanFrame", "1");
    url.searchParams.set("qaLevel", String(entry.level));
    url.searchParams.set("qaPlayer", `${entry.player.x},${entry.player.y}`);
    url.searchParams.set("qaChaser", `${entry.chaser.x},${entry.chaser.y}`);
    url.searchParams.set("qaSpawnDelay", "60");
    url.searchParams.set("autostart", "1");
    await cdp.send("Page.navigate", { url: url.href });
    await cdp.waitFor("document.readyState === 'complete'");
    await cdp.waitFor(`(() => {
      const state = window.__CHASING_QA__?.getState();
      return state?.ready === true
        && state.campaign?.number === ${entry.level}
        && state.game?.phase === "playing"
        && state.assets?.deferredDressingSettled === true
        && state.assets?.qaDecorativeSceneCompiled === true
        && state.assets?.qaTransientArtPrewarmCount === 1;
    })()`);
    await sleep(450);
    const clip = await cdp.evaluate(`(() => {
      const rect = document.querySelector('.playfield')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    })()`);
    assert.ok(clip?.width > 900 && clip?.height > 500, "formal game playfield is clipped");
    const capture = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...clip, scale: 1 },
    });
    const filename = `level-${String(entry.level).padStart(2, "0")}.png`;
    const screenshotPath = path.join(OUTPUT, filename);
    await writeFile(screenshotPath, Buffer.from(capture.data, "base64"));
    const state = await cdp.evaluate("window.__CHASING_QA__.getState()");
    const comparison = REFERENCE
      ? await compareImages(screenshotPath, path.join(REFERENCE, filename))
      : null;
    if (comparison) {
      assert.ok(comparison.rgbMae <= 6, `level ${entry.level} RGB MAE ${comparison.rgbMae} > 6`);
      assert.ok(comparison.darkSilhouetteIoU >= 0.9, `level ${entry.level} dark IoU ${comparison.darkSilhouetteIoU} < 0.9`);
    }
    results.push({
      level: entry.level,
      screenshot: filename,
      render: state.render,
      comparison,
    });
  }
  const diagnostics = cdp.events.filter((event) => (
    event.method === "Runtime.exceptionThrown"
    || (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
    || (event.method === "Log.entryAdded" && event.params.entry.level === "error")
  ));
  assert.deepEqual(diagnostics, []);
  await writeFile(path.join(OUTPUT, "report.json"), `${JSON.stringify({
    source: SOURCE,
    reference: REFERENCE ? path.relative(process.cwd(), REFERENCE) : null,
    method: "1280x720 DPR1 high, formal game camera/playfield, fixed scenario, ready+settled+compiled+prewarmed, 450ms settle",
    thresholds: REFERENCE ? { rgbMaeMaximum: 6, darkSilhouetteIoUMinimum: 0.9 } : null,
    viewport: VIEWPORT,
    results,
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} finally {
  cdp.socket.close();
}
