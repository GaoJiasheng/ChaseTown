#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:3000/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(process.env.CHASING_QA_OUT ?? "docs/porting/m3/evidence/shadow-stability-after");
const SOURCE = process.env.CHASING_QA_SOURCE ?? "working-tree";
const EXPECT_SNAPPED = process.env.CHASING_QA_EXPECT_SNAPPED === "1";
const VIEWPORT = { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false };
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

async function rawRgb(filename) {
  return sharp(filename).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function adjacentRgbMae(leftPath, rightPath) {
  const left = await rawRgb(leftPath);
  const right = await rawRgb(rightPath);
  assert.deepEqual(left.info, right.info);
  let error = 0;
  for (let index = 0; index < left.data.length; index += 1) {
    error += Math.abs(left.data[index] - right.data[index]);
  }
  return Number((error / left.data.length).toFixed(4));
}

function unsnappedResidual(state) {
  const offset = { x: 14, y: 28, z: 18 };
  const forwardLength = Math.hypot(offset.x, offset.y, offset.z);
  const forward = { x: -offset.x / forwardLength, y: -offset.y / forwardLength, z: -offset.z / forwardLength };
  const rightLength = Math.hypot(-forward.z, forward.x);
  const right = { x: -forward.z / rightLength, y: 0, z: forward.x / rightLength };
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  const point = state.game.player.position;
  const anchor = {
    x: (point.x - (state.campaign.walkable[0].length - 1) / 2) * 2,
    y: 0,
    z: (point.y - (state.campaign.walkable.length - 1) / 2) * 2,
  };
  const texel = 36 / state.render.shadowMapSize;
  const x = anchor.x * right.x + anchor.y * right.y + anchor.z * right.z;
  const y = anchor.x * up.x + anchor.y * up.y + anchor.z * up.z;
  return {
    x: Number(Math.abs(x / texel - Math.round(x / texel)).toFixed(8)),
    y: Number(Math.abs(y / texel - Math.round(y / texel)).toFixed(8)),
  };
}

await mkdir(OUTPUT, { recursive: true });
const cdp = await connect();
try {
  await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
  const url = new URL(BASE_URL);
  for (const [key, value] of Object.entries({
    qa: "m3-shadow-stability",
    qaQuality: "high",
    qaCleanFrame: "1",
    qaLevel: "1",
    qaPlayer: "9,15",
    qaChaser: "21,10",
    qaSpawnDelay: "60",
    autostart: "1",
  })) url.searchParams.set(key, value);
  await cdp.send("Page.navigate", { url: url.href });
  await cdp.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready && state.game?.phase === "playing"
      && state.assets?.deferredDressingSettled === true
      && state.assets?.qaDecorativeSceneCompiled === true
      && state.assets?.qaTransientArtPrewarmCount === 1;
  })()`);
  await sleep(300);
  const clip = await cdp.evaluate(`(() => {
    const rect = document.querySelector('.playfield')?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  })()`);
  assert.ok(clip?.width > 900 && clip?.height > 500);
  const startState = await cdp.evaluate("window.__CHASING_QA__.getState()");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "w", code: "KeyW" });
  const frames = [];
  for (let index = 0; index < 10; index += 1) {
    await sleep(90);
    const state = await cdp.evaluate("window.__CHASING_QA__.getState()");
    const capture = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...clip, scale: 1 },
    });
    const filename = `move-${String(index).padStart(2, "0")}.png`;
    await writeFile(path.join(OUTPUT, filename), Buffer.from(capture.data, "base64"));
    frames.push({
      index,
      screenshot: filename,
      player: state.game.player.position,
      snapped: state.render.shadowCamera ?? null,
      unsnappedResidualTexels: unsnappedResidual(state),
    });
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "w", code: "KeyW" });
  const endState = await cdp.evaluate("window.__CHASING_QA__.getState()");
  const movement = Math.hypot(
    endState.game.player.position.x - startState.game.player.position.x,
    endState.game.player.position.y - startState.game.player.position.y,
  );
  assert.ok(movement >= 0.5, `movement sequence was blocked: ${movement}`);
  if (EXPECT_SNAPPED) {
    assert.ok(frames.every(({ snapped }) => snapped), "runtime did not expose snapped shadow state");
    assert.ok(frames.every(({ snapped }) => (
      Math.abs(snapped.residualTexelsX) < 1e-9
      && Math.abs(snapped.residualTexelsY) < 1e-9
    )), "moving shadow target left the texel grid");
  }
  const frameDiffs = [];
  for (let index = 1; index < frames.length; index += 1) {
    frameDiffs.push(await adjacentRgbMae(
      path.join(OUTPUT, frames[index - 1].screenshot),
      path.join(OUTPUT, frames[index].screenshot),
    ));
  }
  const captureCoverage = async (filename) => {
    const currentClip = await cdp.evaluate(`(() => {
      const rect = document.querySelector('.playfield')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    })()`);
    const capture = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...currentClip, scale: 1 },
    });
    await writeFile(path.join(OUTPUT, filename), Buffer.from(capture.data, "base64"));
    const state = await cdp.evaluate("window.__CHASING_QA__.getState()");
    if (EXPECT_SNAPPED) {
      assert.ok(Math.abs(state.render.shadowCamera.residualTexelsX) < 1e-9);
      assert.ok(Math.abs(state.render.shadowCamera.residualTexelsY) < 1e-9);
    }
    return {
      screenshot: filename,
      campaign: state.campaign.number,
      phase: state.game.phase,
      player: state.game.player.position,
      shadowCamera: state.render.shadowCamera ?? null,
    };
  };
  const coverage = [];
  const edgeResult = await cdp.evaluate(`window.__CHASING_QA__.setScenario({
    player: window.__CHASING_QA__.getState().campaign.playerStart,
    chaser: window.__CHASING_QA__.getState().campaign.chaserStart,
    spawnDelaySeconds: 60
  })`);
  assert.equal(edgeResult.ok, true);
  await sleep(700);
  coverage.push({ kind: "level-edge", ...await captureCoverage("level-01-edge.png") });

  const victoryUrl = new URL(BASE_URL);
  for (const [key, value] of Object.entries({
    qa: "m3-shadow-victory",
    qaQuality: "high",
    qaCleanFrame: "1",
    qaLevel: "10",
    qaResolution: "1",
    qaSpawnDelay: "60",
    autostart: "1",
  })) victoryUrl.searchParams.set(key, value);
  await cdp.send("Page.navigate", { url: victoryUrl.href });
  await cdp.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready && state.campaign?.number === 10
      && state.game?.phase === "won"
      && state.assets?.deferredDressingSettled === true
      && state.assets?.qaDecorativeSceneCompiled === true;
  })()`);
  await cdp.waitFor("window.__CHASING_QA__?.getState()?.game?.phase === 'won'", 5_000);
  await sleep(700);
  coverage.push({ kind: "victory", ...await captureCoverage("level-10-victory.png") });
  const diagnostics = cdp.events.filter((event) => (
    event.method === "Runtime.exceptionThrown"
    || (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
    || (event.method === "Log.entryAdded" && event.params.entry.level === "error")
  ));
  assert.deepEqual(diagnostics, []);
  const report = {
    source: SOURCE,
    expectedSnapped: EXPECT_SNAPPED,
    method: "1280x720 DPR1 high formal camera; authentic W-key movement; ten sequential 90ms captures",
    movementCells: Number(movement.toFixed(5)),
    frames,
    coverage,
    adjacentRgbMae: frameDiffs,
    maximumUnsnappedResidualTexels: {
      x: Math.max(...frames.map((frame) => frame.unsnappedResidualTexels.x)),
      y: Math.max(...frames.map((frame) => frame.unsnappedResidualTexels.y)),
    },
  };
  await writeFile(path.join(OUTPUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  cdp.socket.close();
}
