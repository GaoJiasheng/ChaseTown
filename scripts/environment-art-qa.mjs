#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(process.env.CHASING_QA_OUT ?? "/tmp/chasing-environment-art-qa");
const VIEWPORT = { width: 1512, height: 982, deviceScaleFactor: 1, mobile: false };

const LEVELS = [
  {
    number: 1,
    theme: "campus",
    id: "school-maze-v1",
    propSet: "campus-classic",
    beauty: "far",
    beautyScenario: { player: { x: 9, y: 15 }, chaser: { x: 21, y: 10 } },
    landmarks: ["CampusClassroomCluster", "CampusCourtyardCluster", "CampusClassicLandmark"],
    arrival: "CampusClassicArrivalCluster",
    exit: "CampusGateDressing",
    hideDressing: "CampusClassicHideDressing",
    semanticAssets: ["detail:classroomDoor", "detail:blackboard", "detail:backpack", "detail:station"],
    representative: {
      hide: { id: "locker-south", player: { x: 13, y: 19 }, chaser: { x: 1, y: 2 } },
      chase: { player: { x: 6, y: 1 }, chaser: { x: 1, y: 1 } },
    },
  },
  {
    number: 2,
    theme: "campus",
    id: "campus-library-lockdown",
    propSet: "campus-library",
    beauty: "default",
    beautyScenario: { player: { x: 18, y: 2 }, chaser: { x: 18, y: 18 } },
    landmarks: ["CampusLibraryShelves", "CampusReadingCluster", "CampusArchiveCluster"],
    arrival: "CampusLibraryArrivalCluster",
    exit: "CampusLibraryExitCluster",
    hideDressing: "CampusLibraryHideDressing",
    semanticAssets: ["detail:books", "detail:backpack"],
  },
  {
    number: 3,
    theme: "campus",
    id: "campus-science-wing",
    propSet: "campus-science",
    beauty: "default",
    beautyScenario: { player: { x: 8, y: 8 }, chaser: { x: 19, y: 12 } },
    landmarks: ["CampusLabBenchCluster", "CampusFumeHoodCluster", "CampusGreenhouseCluster"],
    arrival: "CampusScienceArrivalCluster",
    exit: "CampusScienceExitCluster",
    hideDressing: "CampusScienceHideDressing",
    semanticAssets: ["detail:classroomDoor", "detail:blackboard", "detail:books"],
  },
  {
    number: 4,
    theme: "hospital",
    id: "hospital-outpatient-afterhours",
    propSet: "hospital-outpatient",
    beauty: "far",
    beautyScenario: { player: { x: 9, y: 5 }, chaser: { x: 19, y: 8 } },
    landmarks: ["HospitalTriageCluster", "HospitalWaitingCluster", "HospitalPharmacyCluster"],
    arrival: "HospitalOutpatientArrivalCluster",
    exit: "HospitalOutpatientExitCluster",
    hideDressing: "HospitalOutpatientHideDressing",
    semanticAssets: ["theme-node:HospitalIVStation", "theme-node:HospitalCrashCart", "theme-node:HospitalWheelchair", "theme-node:HospitalWayfinding"],
    representative: {
      hide: { id: "hospital-pharmacy-store", player: { x: 2, y: 18 }, chaser: { x: 23, y: 12 } },
      chase: { player: { x: 12, y: 7 }, chaser: { x: 12, y: 2 } },
    },
  },
  {
    number: 5,
    theme: "hospital",
    id: "hospital-isolation-basement",
    propSet: "hospital-isolation",
    beauty: "default",
    beautyScenario: { player: { x: 7, y: 9 }, chaser: { x: 11, y: 13 } },
    landmarks: ["HospitalDeconCluster", "HospitalIsolationWardCluster", "HospitalAirlockCluster"],
    arrival: "HospitalIsolationArrivalCluster",
    exit: "HospitalIsolationExitCluster",
    hideDressing: "HospitalIsolationHideDressing",
    semanticAssets: ["theme-node:HospitalIVStation", "theme-node:HospitalPrivacyScreen", "theme-node:HospitalWayfinding"],
  },
  {
    number: 6,
    theme: "fire-station",
    id: "fire-station-engine-bay",
    propSet: "fire-engine-bay",
    beauty: "far",
    beautyScenario: { player: { x: 10, y: 10 }, chaser: { x: 21, y: 7 } },
    landmarks: ["FireStationEngineBayCluster", "FireStationTurnoutCluster", "FireStationHoseServiceCluster"],
    arrival: "FireStationEngineBayArrivalCluster",
    exit: "FireStationEngineBayExitCluster",
    hideDressing: "FireStationEngineBayHideDressing",
    semanticAssets: ["theme-node:FireGearRack", "theme-node:FireHoseReel", "theme-node:FireEngine", "theme-node:FireStationWayfinding", "theme-node:FireSafetyCones"],
    representative: {
      hide: { id: "fire-turnout-locker", player: { x: 10, y: 3 }, chaser: { x: 12, y: 23 } },
      chase: { player: { x: 9, y: 1 }, chaser: { x: 4, y: 1 } },
    },
  },
  {
    number: 7,
    theme: "fire-station",
    id: "fire-station-training-tower",
    propSet: "fire-training",
    beauty: "default",
    beautyScenario: { player: { x: 17, y: 2 }, chaser: { x: 10, y: 11 } },
    landmarks: ["FireStationTrainingCluster", "FireStationRopeRescueCluster", "FireStationBreathingGearCluster"],
    arrival: "FireStationTrainingArrivalCluster",
    exit: "FireStationTrainingExitCluster",
    hideDressing: "FireStationTrainingHideDressing",
    semanticAssets: ["theme-node:FireGearRack", "theme-node:FireHoseReel", "theme-node:FireStationWayfinding", "theme-node:FireSafetyCones", "theme-node:FireHydrant"],
  },
  {
    number: 8,
    theme: "factory",
    id: "factory-assembly-nightshift",
    propSet: "factory-assembly",
    beauty: "far",
    beautyScenario: { player: { x: 14, y: 20 }, chaser: { x: 18, y: 9 } },
    landmarks: ["FactoryAssemblyLineCluster", "FactoryRobotCellCluster", "FactoryInspectionCluster"],
    arrival: "FactoryAssemblyArrivalCluster",
    exit: "FactoryAssemblyExitCluster",
    hideDressing: "FactoryAssemblyHideDressing",
    semanticAssets: ["theme-node:FactoryConveyor", "theme-node:FactoryPipeAssembly", "theme-node:FactorySafetyBarrier", "theme-node:FactoryCrateStack"],
  },
  {
    number: 9,
    theme: "factory",
    id: "factory-turbine-hall",
    propSet: "factory-turbine",
    beauty: "default",
    beautyScenario: { player: { x: 9, y: 6 }, chaser: { x: 19, y: 7 } },
    landmarks: ["FactoryTurbineCluster", "FactoryHighPressurePipeCluster", "FactoryBreakerCluster"],
    arrival: "FactoryTurbineArrivalCluster",
    exit: "FactoryTurbineExitCluster",
    hideDressing: "FactoryTurbineHideDressing",
    semanticAssets: ["theme-node:FactoryPipeAssembly", "theme-node:FactoryStorageTank", "theme-node:FactorySafetyBarrier", "theme-node:FactoryCrateStack"],
  },
  {
    number: 10,
    theme: "factory",
    id: "factory-foundry-final-run",
    propSet: "factory-foundry",
    beauty: "far",
    beautyScenario: { player: { x: 5, y: 10 }, chaser: { x: 9, y: 13 } },
    landmarks: ["FactoryFurnaceCluster", "FactoryCastingCluster", "FactoryCoolingCluster"],
    arrival: "FactoryFoundryArrivalCluster",
    exit: "FactoryFoundryExitCluster",
    hideDressing: "FactoryFoundryHideDressing",
    semanticAssets: ["theme-node:FactoryStorageTank", "theme-node:FactoryControlConsole", "theme-node:FactorySafetyBarrier", "theme-node:FactoryCrateStack"],
    representative: {
      hide: { id: "foundry-slag-shield", player: { x: 2, y: 7 }, chaser: { x: 23, y: 1 } },
      chase: { player: { x: 9, y: 4 }, chaser: { x: 5, y: 4 } },
    },
  },
];

const REPRESENTATIVES = LEVELS.filter(({ representative }) => representative);

assert.equal(LEVELS.length, 10);
assert.deepEqual(LEVELS.map(({ number }) => number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.equal(new Set(LEVELS.map(({ propSet }) => propSet)).size, 10);
assert.ok(LEVELS.every(({ landmarks }) => landmarks.length >= 3));
assert.equal(REPRESENTATIVES.length, 4);
assert.deepEqual(new Set(REPRESENTATIVES.map(({ theme }) => theme)), new Set(["campus", "hospital", "fire-station", "factory"]));

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connect() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  } catch (error) {
    throw new Error(`Chrome DevTools is unavailable on port ${DEBUG_PORT}; launch Chrome with --remote-debugging-port=${DEBUG_PORT}`, { cause: error });
  }
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
  await Promise.all([send("Runtime.enable"), send("Page.enable"), send("Network.enable"), send("Log.enable")]);

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
  async function waitFor(expression, timeout = 30_000, interval = 25) {
    const started = Date.now();
    let value;
    while (Date.now() - started <= timeout) {
      value = await evaluate(expression);
      if (value) return value;
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(value)}`);
  }
  async function navigate(url) {
    await send("Page.navigate", { url });
    await waitFor("document.readyState === 'complete'", 20_000, 50);
  }
  return { socket, events, send, evaluate, waitFor, navigate };
}

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? 0;
}

async function imageMetrics(buffer, expectedWidth, expectedHeight, label) {
  assert.ok(buffer.length >= 15_000, `${label} screenshot is suspiciously small`);
  const image = sharp(buffer);
  const metadata = await image.metadata();
  assert.equal(metadata.format, "png", `${label} must be captured losslessly`);
  assert.equal(metadata.width, expectedWidth, `${label} has the wrong width`);
  assert.equal(metadata.height, expectedHeight, `${label} has the wrong height`);
  const stats = await image.stats();
  const visibleChannels = stats.channels.slice(0, 3);
  const averageDeviation = visibleChannels.reduce((total, channel) => total + channel.stdev, 0) / visibleChannels.length;
  assert.ok(stats.entropy >= 3, `${label} lacks enough visual information; entropy=${stats.entropy}`);
  assert.ok(averageDeviation >= 18, `${label} is too visually flat; deviation=${averageDeviation}`);
  const fingerprint = await sharp(buffer).resize(32, 32, { fit: "fill" }).removeAlpha().raw().toBuffer();
  return {
    bytes: buffer.length,
    width: metadata.width,
    height: metadata.height,
    entropy: stats.entropy,
    sharpness: stats.sharpness,
    averageDeviation,
    dominant: stats.dominant,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    fingerprint: [...fingerprint],
  };
}

function perceptualDistance(left, right) {
  assert.equal(left.length, right.length);
  return left.reduce((total, value, index) => total + Math.abs(value - right[index]), 0) / left.length;
}

function assertRuntimeIntegrity(state, level, { fallback = false } = {}) {
  assert.equal(state.ready, true);
  assert.equal(state.campaign.number, level.number);
  assert.equal(state.campaign.id, level.id);
  assert.equal(state.campaign.theme, level.theme);
  assert.equal(state.campaign.propSet, level.propSet);
  assert.equal(state.sceneIntegrity.renderedMovementBlockers, state.sceneIntegrity.expectedMovementBlockers);
  assert.equal(state.sceneIntegrity.renderedVisionObscurers, state.sceneIntegrity.expectedVisionObscurers);
  assert.deepEqual(state.render.invalidSceneTextures, []);
  assert.ok(state.render.calls <= 520, `${level.id} draw calls exceeded 520: ${state.render.calls}`);
  assert.ok(state.render.triangles <= 3_000_000, `${level.id} exceeded 3M rendered triangles: ${state.render.triangles}`);
  assert.ok(state.render.memory.geometries <= 300, `${level.id} geometry count exceeded 300`);
  // The complete BaseColor/Normal/ORM material chain adds one compact packed
  // texture per surface family. Keep the live-scene limit at 80 below and a
  // hard renderer-memory ceiling of 256 so the PBR upgrade remains bounded.
  assert.ok(state.render.memory.textures <= 256, `${level.id} texture count exceeded 256`);
  // Rich PBR surfaces, depth/shadow variants, camera-occlusion passes and the
  // depth-honest actor readability rim share a strict, cross-theme ceiling.
  // All ten production chapters currently peak at 49; 56 leaves modest driver
  // variance while still failing the measured 78-program duplicate-light bug.
  assert.ok(state.render.programs <= 56, `${level.id} shader program count exceeded 56`);
  assert.ok(state.render.sceneTextures <= 80, `${level.id} live scene texture count exceeded 80`);
  if (fallback) assert.equal(state.render.batching, "instanced-mesh", `${level.id} did not enter the no-multi-draw fallback`);
}

function assertSemanticCoverage(state, level) {
  assert.ok(state.assets, `${level.id} did not expose runtime asset provenance`);
  assert.deepEqual(state.assets.unusedLoadedAssetIds, [], `${level.id} loaded assets that never reached the scene`);
  const placed = new Set(state.assets.placedAssetIds);
  assert.ok(placed.has(`theme:${level.theme}`), `${level.id} did not place its ${level.theme} kit`);
  for (const runtimeAsset of [
    "runtime:ambient-room-clusters",
    "runtime:authored-room-floors",
    "runtime:prop-contact-shadows",
    "runtime:wall-contact-shadows",
  ]) {
    assert.ok(placed.has(runtimeAsset), `${level.id} did not place ${runtimeAsset}`);
  }
  assert.ok(
    [...placed].some((asset) => asset.startsWith("theme-node:") && asset.includes("ArchitectureWallWide")),
    `${level.id} did not place a continuous four-metre wall elevation`,
  );
  assert.ok(
    [...placed].some((asset) => asset.startsWith("theme-node:") && asset.includes("ArchitectureJunction")),
    `${level.id} did not place a choice-landmark junction`,
  );

  const storyNodes = [...level.landmarks, level.arrival, level.exit, level.hideDressing];
  assert.equal(new Set(storyNodes).size, storyNodes.length, `${level.id} story-role nodes must be exclusive`);
  assert.ok(level.landmarks.length >= 3, `${level.id} needs at least three prop-set-specific landmarks`);
  for (const node of storyNodes) {
    assert.ok(placed.has(`theme-node:${node}`), `${level.id} did not place semantic story node ${node}`);
  }
  for (const assetId of level.semanticAssets) {
    assert.ok(placed.has(assetId), `${level.id} did not place required semantic asset ${assetId}`);
  }
  return {
    storyNodes,
    semanticAssets: [...level.semanticAssets],
    loadedAssetCount: state.assets.loadedAssetIds.length,
    placedAssetCount: state.assets.placedAssetIds.length,
  };
}

await mkdir(OUTPUT, { recursive: true });
const cdp = await connect();
const report = { baseUrl: BASE_URL, viewport: VIEWPORT, levels: [], representatives: [], fallback: [], diagnostics: [] };

try {
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  const url = new URL(BASE_URL);
  url.searchParams.set("qa", "environment-art");
  await cdp.navigate(url.href);
  await cdp.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready === true && state.assets?.decorativeReady === true;
  })()`);

  const clickByLabel = async (label) => {
    const clicked = await cdp.evaluate(`(() => {
      const button = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true, `missing button: ${label}`);
  };
  const state = () => cdp.evaluate("window.__CHASING_QA__?.getState()");
  const setZoom = async (target, buttonLabel) => {
    await clickByLabel("重置动态视野");
    for (let index = 0; index < 12; index += 1) {
      const current = await state();
      if (Math.abs(current.camera.zoom - target) <= 0.002) break;
      await clickByLabel(buttonLabel);
      await sleep(20);
    }
    await sleep(180);
    const current = await state();
    assert.ok(Math.abs(current.camera.zoom - target) <= 0.002, `camera zoom did not reach ${target}: ${current.camera.zoom}`);
    return current;
  };
  const capturePlayfield = async (basename) => {
    const clip = await cdp.evaluate(`(() => {
      const rect = document.querySelector('.playfield')?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    })()`);
    assert.ok(clip && clip.width >= 700 && clip.height >= 450, `${basename} playfield is missing or clipped`);
    const response = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { ...clip, scale: 1 },
    });
    const buffer = Buffer.from(response.data, "base64");
    const filename = path.join(OUTPUT, `${basename}.png`);
    await writeFile(filename, buffer);
    return imageMetrics(buffer, Math.round(clip.width), Math.round(clip.height), basename);
  };
  const saveState = async (basename, snapshot) => {
    await writeFile(path.join(OUTPUT, `${basename}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  };
  const sampleFrames = () => cdp.evaluate(`new Promise((resolve) => {
    const values = [];
    let start;
    let previous;
    function frame(now) {
      if (start === undefined) { start = now; previous = now; }
      else { values.push(now - previous); previous = now; }
      if (now - start >= 1000) resolve(values);
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })`);
  const selectAndStart = async (level) => {
    await cdp.evaluate(`window.__CHASING_QA__.selectLevel(${level.number - 1})`);
    await cdp.waitFor(`(() => {
      const state=window.__CHASING_QA__?.getState();
      return state?.ready
        && state.assets?.decorativeReady
        && state.campaign.number===${level.number}
        && state.campaign.propSet===${JSON.stringify(level.propSet)};
    })()`);
    await sleep(250);
    assert.equal(await cdp.evaluate("document.querySelectorAll('.playfield canvas').length"), 1, `${level.id} must render exactly one canvas`);
    await cdp.evaluate("window.__CHASING_QA__.start()");
    await cdp.waitFor("window.__CHASING_QA__?.getState()?.game?.phase === 'playing'", 3_000, 10);
    await sleep(120);
  };

  const beautyFingerprints = new Map();
  for (const level of LEVELS) {
    await selectAndStart(level);
    await cdp.evaluate(`window.__CHASING_QA__.setScenario(${JSON.stringify(level.beautyScenario)})`);
    await cdp.waitFor(`(() => {
      const position=window.__CHASING_QA__?.getState()?.game?.player?.position;
      return Math.abs(position?.x-${level.beautyScenario.player.x}) < 0.01
        && Math.abs(position?.y-${level.beautyScenario.player.y}) < 0.01;
    })()`, 2_000, 10);
    await sleep(420);

    const beautyZoom = level.beauty === "far" ? 1.65 : 1;
    const beautyState = await setZoom(beautyZoom, "缩小视野");
    const beautyName = `${String(level.number).padStart(2, "0")}-${level.propSet}-${level.beauty}`;
    const beautyImage = await capturePlayfield(beautyName);
    await saveState(beautyName, beautyState);
    assertRuntimeIntegrity(beautyState, level);
    const semantics = assertSemanticCoverage(beautyState, level);
    assert.equal(beautyState.visibility.kid.viewport.centerInFrustum, true, `${level.id} beauty framing lost the player anchor`);
    beautyFingerprints.set(level.number, beautyImage.fingerprint);
    report.levels.push({
      number: level.number,
      id: level.id,
      theme: level.theme,
      propSet: level.propSet,
      screenshot: { file: `${beautyName}.png`, view: level.beauty, ...beautyImage, fingerprint: undefined },
      semantics,
      render: beautyState.render,
    });

    if (!level.representative) continue;
    assert.equal(level.beauty, "far", `${level.id} representative coverage expects its beauty shot to be the far reference`);

    const near = await setZoom(0.72, "放大视野");
    const nearName = `${String(level.number).padStart(2, "0")}-${level.propSet}-near`;
    const nearImage = await capturePlayfield(nearName);
    await saveState(nearName, near);
    assertRuntimeIntegrity(near, level);
    assert.ok(perceptualDistance(beautyImage.fingerprint, nearImage.fingerprint) >= 2.5, `${level.id} near/far views are not visually distinct`);

    await cdp.evaluate(`window.__CHASING_QA__.setScenario(${JSON.stringify(level.representative.chase)})`);
    await cdp.waitFor("window.__CHASING_QA__?.getState()?.game?.chaser?.mode === 'chase'", 4_000, 10);
    await sleep(180);
    const intervals = await sampleFrames();
    const framePerformance = {
      frames: intervals.length,
      medianMs: percentile(intervals, 0.5),
      p95Ms: percentile(intervals, 0.95),
      p99Ms: percentile(intervals, 0.99),
      over33MsRatio: intervals.filter((value) => value > 33.4).length / Math.max(1, intervals.length),
    };
    assert.ok(framePerformance.p95Ms <= 25, `${level.id} chase p95 exceeded 25ms`);
    assert.ok(framePerformance.p99Ms <= 40, `${level.id} chase p99 exceeded 40ms`);
    assert.ok(framePerformance.over33MsRatio <= 0.02, `${level.id} has too many frames below 30 FPS`);
    const chaseState = await state();
    assertRuntimeIntegrity(chaseState, level);
    assert.equal(chaseState.visibility.kid.viewport.centerInFrustum, true);
    assert.equal(chaseState.visibility.villain.viewport.centerInFrustum, true);
    assert.equal(chaseState.visibility.villain.worldRendered, true);
    assert.ok(
      chaseState.visibility.kid.viewport.worldHeight >= 1.35
        && chaseState.visibility.kid.viewport.worldHeight <= 1.65,
      `${level.id} player model lost its authored 1.52m scale: ${chaseState.visibility.kid.viewport.worldHeight}`,
    );
    assert.ok(
      chaseState.visibility.villain.viewport.worldHeight >= 1.7
        && chaseState.visibility.villain.viewport.worldHeight <= 2.05,
      `${level.id} chaser model lost its authored 1.88m scale: ${chaseState.visibility.villain.viewport.worldHeight}`,
    );
    const chaseName = `${String(level.number).padStart(2, "0")}-${level.propSet}-chase`;
    const chaseImage = await capturePlayfield(chaseName);
    await saveState(chaseName, chaseState);

    await clickByLabel("重置动态视野");
    await cdp.evaluate(`window.__CHASING_QA__.setScenario(${JSON.stringify({ player: level.representative.hide.player, chaser: level.representative.hide.chaser })})`);
    await cdp.waitFor(`window.__CHASING_QA__?.getState()?.interaction?.hideSpotId === ${JSON.stringify(level.representative.hide.id)}`, 3_000, 10);
    await cdp.evaluate("window.__CHASING_QA__.interact()");
    await cdp.waitFor("window.__CHASING_QA__?.getState()?.game?.player?.mode === 'entering-hide'", 5_000, 10);
    await cdp.waitFor(`(() => {
      const locker=window.__CHASING_QA__?.getState()?.lockers?.[${JSON.stringify(level.representative.hide.id)}];
      return locker?.action === 'Locker_Door_Open_Enter' && locker.normalizedTime >= 0.3 && locker.normalizedTime <= 0.7;
    })()`, 5_000, 8);
    const hiding = await state();
    const hideName = `${String(level.number).padStart(2, "0")}-${level.propSet}-hide`;
    const hideImage = await capturePlayfield(hideName);
    await saveState(hideName, hiding);
    assertRuntimeIntegrity(hiding, level);
    assert.equal(hiding.game.player.mode, "entering-hide");
    assert.equal(hiding.animations.kid.state, "enterHide");
    assert.equal(hiding.lockers[level.representative.hide.id].timeScale, 1.2);
    assert.ok(hiding.lockers[level.representative.hide.id].normalizedTime >= 0.3 && hiding.lockers[level.representative.hide.id].normalizedTime <= 0.7);
    assert.equal(hiding.visibility.kid.rootVisible, true);
    assert.equal(hiding.visibility.kid.viewport.centerInFrustum, true);

    report.representatives.push({
      number: level.number,
      id: level.id,
      theme: level.theme,
      propSet: level.propSet,
      screenshots: {
        far: { file: `${beautyName}.png`, ...beautyImage, fingerprint: undefined },
        near: { file: `${nearName}.png`, ...nearImage, fingerprint: undefined },
        chase: { file: `${chaseName}.png`, ...chaseImage, fingerprint: undefined },
        hide: { file: `${hideName}.png`, ...hideImage, fingerprint: undefined },
      },
      framePerformance,
      render: chaseState.render,
    });
  }

  for (let left = 0; left < REPRESENTATIVES.length; left += 1) {
    for (let right = left + 1; right < REPRESENTATIVES.length; right += 1) {
      const leftLevel = REPRESENTATIVES[left];
      const rightLevel = REPRESENTATIVES[right];
      assert.ok(
        perceptualDistance(beautyFingerprints.get(leftLevel.number), beautyFingerprints.get(rightLevel.number)) >= 3,
        `${leftLevel.theme} and ${rightLevel.theme} far views are not visually differentiated`,
      );
    }
  }

  const fallbackUrl = new URL(BASE_URL);
  fallbackUrl.searchParams.set("qa", "environment-art-fallback");
  fallbackUrl.searchParams.set("no-multi-draw", "1");
  await cdp.navigate(fallbackUrl.href);
  await cdp.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready === true && state.assets?.decorativeReady === true;
  })()`);
  for (const level of REPRESENTATIVES) {
    await selectAndStart(level);
    const fallbackState = await setZoom(1, "缩小视野");
    assertRuntimeIntegrity(fallbackState, level, { fallback: true });
    const semantics = assertSemanticCoverage(fallbackState, level);
    const fallbackName = `fallback-${String(level.number).padStart(2, "0")}-${level.propSet}`;
    const fallbackImage = await capturePlayfield(fallbackName);
    await saveState(fallbackName, fallbackState);
    report.fallback.push({
      number: level.number,
      id: level.id,
      theme: level.theme,
      propSet: level.propSet,
      batching: fallbackState.render.batching,
      screenshot: { file: `${fallbackName}.png`, ...fallbackImage, fingerprint: undefined },
      semantics,
      render: fallbackState.render,
    });
  }
  assert.equal(report.fallback.length, 4);
  assert.deepEqual(new Set(report.fallback.map(({ theme }) => theme)), new Set(["campus", "hospital", "fire-station", "factory"]));

  const requests = new Map();
  for (const event of cdp.events) {
    if (event.method === "Network.requestWillBeSent") requests.set(event.params.requestId, event.params.request.url);
  }
  report.diagnostics = cdp.events.flatMap((event) => {
    if (event.method === "Runtime.exceptionThrown") return [{ type: "exception", detail: event.params.exceptionDetails }];
    if (event.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(event.params.type)) {
      return [{ type: `console-${event.params.type}`, args: event.params.args.map((argument) => argument.value ?? argument.description) }];
    }
    if (event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params.entry.level)) return [{ type: "log", entry: event.params.entry }];
    if (event.method === "Network.responseReceived" && event.params.response.status >= 400) return [{ type: "http", status: event.params.response.status, url: event.params.response.url }];
    if (event.method === "Network.loadingFailed" && !event.params.canceled) {
      return [{ type: "network-failed", url: requests.get(event.params.requestId), error: event.params.errorText }];
    }
    return [];
  });
  assert.deepEqual(report.diagnostics, []);
  await writeFile(path.join(OUTPUT, "environment-art-summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: OUTPUT,
    levels: report.levels.map(({ number, id, theme, propSet, screenshot, semantics, render }) => ({ number, id, theme, propSet, screenshot: screenshot.file, semantics, render })),
    representatives: report.representatives.map(({ number, theme, framePerformance, render }) => ({ number, theme, framePerformance, render })),
    fallback: report.fallback.map(({ number, theme, batching, render }) => ({ number, theme, batching, render })),
  }, null, 2)}\n`);
} finally {
  cdp.socket.close();
}
