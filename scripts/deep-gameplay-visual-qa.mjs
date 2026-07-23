#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://localhost:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-deep-gameplay-visual-qa",
);
const DESKTOP = Object.freeze({
  width: 1512,
  height: 982,
  deviceScaleFactor: 1,
  mobile: false,
});
const MOBILE = Object.freeze({
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
const REPRESENTATIVE_LEVELS = Object.freeze([
  { index: 0, theme: "campus" },
  { index: 3, theme: "hospital" },
  { index: 5, theme: "fire-station" },
  { index: 7, theme: "factory" },
]);
const SCREENSHOT_MINIMUM = Object.freeze({
  desktop: 100_000,
  mobile: 35_000,
});
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function pointDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function fartherAnchor(anchor, state) {
  const candidates = [
    state.campaign.playerStart,
    state.campaign.exit,
    state.campaign.chaserStart,
    ...state.campaign.hideSpots.map((spot) => spot.approach),
  ];
  return candidates.reduce((farthest, point) => (
    pointDistance(anchor, point) > pointDistance(anchor, farthest) ? point : farthest
  ), candidates[0]);
}

function assertActorViewport(actor, label, { inset = 0.025 } = {}) {
  assert.ok(actor, `${label} has no viewport sample`);
  assert.equal(actor.centerInFrustum, true, `${label} is outside the camera frustum`);
  assert.ok(
    actor.x >= inset && actor.x <= 1 - inset,
    `${label} horizontal viewport coordinate ${actor.x} is not readable`,
  );
  assert.ok(
    actor.y >= inset && actor.y <= 1 - inset,
    `${label} vertical viewport coordinate ${actor.y} is not readable`,
  );
  assert.ok(
    actor.depth >= -1 && actor.depth <= 1,
    `${label} depth ${actor.depth} is outside clip space`,
  );
  assert.ok(actor.worldHeight > 0.75, `${label} model has implausible world height`);
}

function candidateActorPairs(state) {
  const authoredCorridorPairs = state.campaign.hideSpots.map((spot) => ({
    player: spot.approach,
    chaser: {
      x: spot.approach.x + spot.facing.x * 2.4,
      y: spot.approach.y + spot.facing.y * 2.4,
    },
    distance: 2.4,
  }));
  const points = [
    state.campaign.playerStart,
    state.campaign.exit,
    state.campaign.chaserStart,
    ...state.campaign.hideSpots.flatMap((spot) => [
      spot.approach,
      ...(spot.alternateExit ? [spot.alternateExit] : []),
    ]),
  ];
  const unique = points.filter((point, index) => (
    points.findIndex((candidate) => (
      candidate.x === point.x && candidate.y === point.y
    )) === index
  ));
  const pairs = [];
  for (let playerIndex = 0; playerIndex < unique.length; playerIndex += 1) {
    for (let chaserIndex = 0; chaserIndex < unique.length; chaserIndex += 1) {
      if (playerIndex === chaserIndex) continue;
      const distance = pointDistance(unique[playerIndex], unique[chaserIndex]);
      if (distance < 3.5 || distance > 10) continue;
      pairs.push({
        player: unique[playerIndex],
        chaser: unique[chaserIndex],
        distance,
      });
    }
  }
  return [
    ...authoredCorridorPairs,
    ...pairs.sort((first, second) => (
    Math.abs(first.distance - 5.8) - Math.abs(second.distance - 5.8)
    )),
  ];
}

async function connect() {
  let targets;
  try {
    const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    assert.equal(response.ok, true, `Chrome target endpoint returned ${response.status}`);
    targets = await response.json();
  } catch (error) {
    throw new Error(
      `Chrome DevTools is unavailable on port ${DEBUG_PORT}; launch Chrome with --remote-debugging-port=${DEBUG_PORT}`,
      { cause: error },
    );
  }
  const target = targets.find((entry) => (
    entry.type === "page"
    && (entry.url === "about:blank" || entry.url.startsWith(BASE_URL))
  )) ?? targets.find((entry) => (
    entry.type === "page" && !entry.url.startsWith("chrome://")
  ));
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
    send("Page.bringToFront"),
  ]);

  let closed = false;
  const foregroundTimer = setInterval(() => {
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    void send("Page.bringToFront").catch(() => {});
  }, 650);
  foregroundTimer.unref?.();

  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? `Runtime evaluation failed: ${expression}`,
      );
    }
    return response.result.value;
  }

  async function waitFor(expression, timeout = 30_000, interval = 80) {
    const started = Date.now();
    let lastValue = false;
    let lastError = null;
    while (Date.now() - started <= timeout) {
      try {
        lastValue = await evaluate(expression);
        lastError = null;
      } catch (error) {
        // React recreates the renderer and QA bridge while changing a level or
        // a certified layout. That short hand-off is a polling miss.
        lastValue = false;
        lastError = error;
      }
      if (lastValue) return lastValue;
      await sleep(interval);
    }
    const suffix = lastError instanceof Error ? `; lastError=${lastError.message}` : "";
    throw new Error(
      `Timed out waiting for ${expression}; last=${JSON.stringify(lastValue)}${suffix}`,
    );
  }

  async function setViewport(viewport) {
    await Promise.all([
      send("Emulation.setDeviceMetricsOverride", viewport),
      send("Emulation.setTouchEmulationEnabled", {
        enabled: viewport.mobile,
        maxTouchPoints: viewport.mobile ? 5 : 1,
      }),
      send("Page.bringToFront"),
    ]);
    await sleep(140);
  }

  async function screenshot(file, viewport) {
    await send("Page.bringToFront");
    const blockers = await evaluate(`(() => ({
      loadingCards: document.querySelectorAll('.loading-card, .loading-shell').length,
      errorCards: document.querySelectorAll('.error-card, .load-error').length,
      canvasCount: document.querySelectorAll('.playfield canvas').length,
    }))()`);
    assert.equal(blockers.loadingCards, 0, `${file} still contains a loading UI`);
    assert.equal(blockers.errorCards, 0, `${file} contains a load error UI`);
    assert.equal(blockers.canvasCount, 1, `${file} has no unique game canvas`);
    const result = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    const minimum = viewport.mobile
      ? SCREENSHOT_MINIMUM.mobile
      : SCREENSHOT_MINIMUM.desktop;
    assert.ok(bytes.length >= minimum, `${file} is suspiciously small (${bytes.length} bytes)`);
    await writeFile(file, bytes);
    return bytes.length;
  }

  async function dispatchKey(key, code, virtualKeyCode, type = "keyDown") {
    await send("Page.bringToFront");
    await send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    });
  }

  function close() {
    closed = true;
    clearInterval(foregroundTimer);
    socket.close();
  }

  return {
    events,
    send,
    evaluate,
    waitFor,
    setViewport,
    screenshot,
    dispatchKey,
    close,
  };
}

async function waitForReady(browser, levelIndex, layoutNumber, timeout = 90_000) {
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return Boolean(
      state?.ready
      && state?.campaign?.index === ${levelIndex}
      && state?.game?.phase === 'ready'
      && state?.certifiedRemix?.layoutNumber === ${JSON.stringify(layoutNumber)}
      && state?.assets?.decorativeReady === true
      && !document.querySelector('.loading-card, .loading-shell, .error-card, .load-error')
    );
  })()`, timeout, 120);
}

async function navigateFresh(browser, viewport, suffix) {
  await browser.setViewport(viewport);
  const separator = BASE_URL.includes("?") ? "&" : "?";
  await browser.send("Page.navigate", {
    url: `${BASE_URL}${separator}qa=deep-gameplay-visual-${suffix}`,
  });
  await browser.waitFor("document.readyState === 'complete'", 25_000);
  await waitForReady(browser, 0, null);
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");
}

async function selectReadyLevel(browser, index, layoutNumber = null) {
  const current = await browser.evaluate("window.__CHASING_QA__?.getState()");
  if (current?.campaign?.index === index && current?.game?.phase !== "ready") {
    const detour = index === 0 ? 1 : 0;
    await browser.evaluate(`window.__CHASING_QA__.selectLevel(${detour})`);
    await waitForReady(browser, detour, null);
  }
  const afterDetour = await browser.evaluate("window.__CHASING_QA__?.getState()");
  if (afterDetour?.campaign?.index !== index) {
    await browser.evaluate(`window.__CHASING_QA__.selectLevel(${index})`);
    await waitForReady(browser, index, null);
  }
  const selected = await browser.evaluate("window.__CHASING_QA__?.getState()");
  if (selected?.certifiedRemix?.layoutNumber !== layoutNumber) {
    await browser.evaluate(`window.__CHASING_QA__.selectLayout(${JSON.stringify(layoutNumber)})`);
    await waitForReady(browser, index, layoutNumber);
  }
  return browser.evaluate("window.__CHASING_QA__.getState()");
}

async function findVisibleActorScenario(browser, opening) {
  const pairs = candidateActorPairs(opening);
  assert.ok(pairs.length > 0, `${opening.campaign.id} has no safe actor staging pair`);
  for (const pair of pairs.slice(0, 14)) {
    await browser.evaluate(
      `window.__CHASING_QA__.setScenario(${JSON.stringify(pair)})`,
    );
    await sleep(120);
    const state = await browser.evaluate("window.__CHASING_QA__.getState()");
    const kid = state?.visibility?.kid;
    const villain = state?.visibility?.villain;
    const readable = state?.game?.phase === "playing"
      && kid?.rootVisible
      && villain?.rootVisible
      && villain?.worldRendered
      && kid?.viewport?.centerInFrustum
      && villain?.viewport?.centerInFrustum
      && kid.viewport.x >= 0.025
      && kid.viewport.x <= 0.975
      && villain.viewport.x >= 0.025
      && villain.viewport.x <= 0.975
      && kid.viewport.y >= 0.025
      && kid.viewport.y <= 0.975
      && villain.viewport.y >= 0.025
      && villain.viewport.y <= 0.975;
    if (readable) return { pair, state };
  }
  throw new Error(`${opening.campaign.id} could not stage both authored actors in the viewport`);
}

async function resumeIfPaused(browser) {
  const paused = await browser.evaluate(
    "Boolean(window.__CHASING_QA__?.getState()?.paused)",
  );
  if (!paused) return;
  await browser.evaluate("document.querySelector('.pause-actions .primary')?.click()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.paused === false",
    4_000,
  );
}

async function exerciseHardLocker(browser, viewport, screenshotEvidence) {
  const opening = await selectReadyLevel(browser, 0, null);
  const hardSpot = opening.campaign.hideSpots.find(
    (spot) => (spot.archetype ?? "hard-locker") === "hard-locker",
  );
  assert.ok(hardSpot, "Level 1 has no hard locker");
  const chaser = fartherAnchor(hardSpot.approach, opening);
  await browser.evaluate(
    `window.__CHASING_QA__.setScenario(${JSON.stringify({
      player: hardSpot.approach,
      chaser,
    })})`,
  );
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.interaction?.kind === 'enter'
      && state?.interaction?.hideSpotId === ${JSON.stringify(hardSpot.id)};
  })()`, 8_000);
  const approachFile = path.join(OUTPUT, "desktop-level-01-hard-locker-approach.png");
  screenshotEvidence.push({
    file: path.basename(approachFile),
    bytes: await browser.screenshot(approachFile, viewport),
    stage: "hard-locker-approach",
  });

  await browser.evaluate("window.__CHASING_QA__.interact()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'entering-hide'",
    4_000,
  );
  const entering = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(entering.activeHideArchetype?.archetype, "hard-locker");
  assert.equal(entering.game.player.hideSpotId, hardSpot.id);
  assert.equal(entering.lockers[hardSpot.id].owner, "player");

  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'",
    8_000,
  );
  const hidden = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(hidden.interaction?.kind, "exit", "hard locker cannot be exited");
  assert.equal(hidden.visibility.kid.rootVisible, false, "hard locker must fully conceal the player");
  const hiddenFile = path.join(OUTPUT, "desktop-level-01-hard-locker-hidden.png");
  screenshotEvidence.push({
    file: path.basename(hiddenFile),
    bytes: await browser.screenshot(hiddenFile, viewport),
    stage: "hard-locker-hidden",
  });

  await browser.dispatchKey("q", "KeyQ", 81, "keyDown");
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.game?.player?.mode === 'peeking'
      && state?.camera?.occlusion?.maxStrength < 0.03;
  })()`, 12_000);
  const peek = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(peek.activeHideArchetype?.archetype, "hard-locker");
  assert.equal(peek.lockers[hardSpot.id].peeking, true);
  const peekFile = path.join(OUTPUT, "desktop-level-01-hard-locker-peek.png");
  screenshotEvidence.push({
    file: path.basename(peekFile),
    bytes: await browser.screenshot(peekFile, viewport),
    stage: "hard-locker-peek",
  });
  await browser.dispatchKey("q", "KeyQ", 81, "keyUp");
  await resumeIfPaused(browser);
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'",
    6_000,
  );

  await browser.evaluate("window.__CHASING_QA__.interact()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'exiting-hide'",
    4_000,
  );
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'free'",
    8_000,
  );
  const exited = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.ok(
    pointDistance(exited.game.player.position, hardSpot.approach) <= 0.35,
    "hard locker returned the player to the wrong point",
  );
  assert.equal(exited.game.phase, "playing");
  return {
    level: 1,
    hideSpotId: hardSpot.id,
    modes: ["entering-hide", "hidden", "peeking", "hidden", "exiting-hide", "free"],
    finalPosition: exited.game.player.position,
    approach: hardSpot.approach,
    passed: true,
  };
}

async function locateHideArchetype(browser, archetype) {
  let current = await browser.evaluate("window.__CHASING_QA__?.getState()");
  const currentSpot = current?.campaign?.hideSpots?.find(
    (candidate) => (candidate.archetype ?? "hard-locker") === archetype,
  );
  if (currentSpot && current.game?.phase === "playing") {
    return { index: current.campaign.index, state: current, spot: currentSpot };
  }
  // A real player only changes chapters from the ready/results UI. Rebuild a
  // clean ready scene before searching another chapter instead of forcing a
  // QA-only mid-chase scene replacement through an asset-abort boundary.
  if (current?.game?.phase !== "ready") {
    await navigateFresh(browser, DESKTOP, `hide-${archetype}`);
    current = await browser.evaluate("window.__CHASING_QA__?.getState()");
  }
  const remainingIndices = Array.from({ length: 10 }, (_, index) => index)
    .filter((index) => index !== current?.campaign?.index);
  for (const index of remainingIndices) {
    const state = await selectReadyLevel(browser, index, null);
    const spot = state.campaign.hideSpots.find(
      (candidate) => (candidate.archetype ?? "hard-locker") === archetype,
    );
    if (spot) return { index, state, spot };
  }
  throw new Error(`No campaign level exposes ${archetype} through the QA bridge`);
}

async function exerciseAlternativeHide(
  browser,
  viewport,
  archetype,
  screenshotEvidence,
) {
  const located = await locateHideArchetype(browser, archetype);
  const { state: opening, spot } = located;
  const chaser = fartherAnchor(spot.approach, opening);
  await browser.evaluate(
    `window.__CHASING_QA__.setScenario(${JSON.stringify({
      player: spot.approach,
      chaser,
    })})`,
  );
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.interaction?.kind === 'enter'
      && state?.interaction?.hideSpotId === ${JSON.stringify(spot.id)};
  })()`, 8_000);
  await browser.evaluate("window.__CHASING_QA__.interact()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'entering-hide'",
    4_000,
  );
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'",
    8_000,
  );
  let hidden = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(hidden.activeHideArchetype?.archetype, archetype);
  assert.equal(hidden.game.player.hideSpotId, spot.id);
  assert.equal(hidden.interaction?.kind, "exit");
  if (archetype === "soft-cover") {
    assert.equal(hidden.visibility.kid.rootVisible, true, "soft cover should retain a readable silhouette");
    assert.ok(
      hidden.visibility.kid.alpha > 0 && hidden.visibility.kid.alpha < 0.9,
      "soft cover should visibly attenuate, not erase, the player",
    );
  }

  const hiddenFile = path.join(
    OUTPUT,
    `desktop-level-${String(located.index + 1).padStart(2, "0")}-${archetype}-hidden.png`,
  );
  screenshotEvidence.push({
    file: path.basename(hiddenFile),
    bytes: await browser.screenshot(hiddenFile, viewport),
    stage: `${archetype}-hidden`,
  });

  let selectedExit = "origin";
  if (archetype === "traversal-hide") {
    assert.ok(spot.alternateExit, `${spot.id} has no authored alternate exit`);
    assert.ok(
      hidden.hideExitSelection?.options.some((option) => option.kind === "alternate"),
      `${spot.id} does not expose its alternate exit`,
    );
    await browser.waitFor(
      "Boolean(document.querySelector('.hide-exit-selector'))",
      3_000,
    );
    await browser.dispatchKey("x", "KeyX", 88, "keyDown");
    await browser.dispatchKey("x", "KeyX", 88, "keyUp");
    await browser.waitFor(
      "window.__CHASING_QA__?.getState()?.hideExitSelection?.selected === 'alternate'",
      3_000,
    );
    hidden = await browser.evaluate("window.__CHASING_QA__.getState()");
    selectedExit = hidden.hideExitSelection.selected;
    await browser.waitFor(
      "document.querySelector('.hide-exit-selector button[aria-pressed=\"true\"]')?.textContent.includes('另一侧')",
      3_000,
    );
    const alternateFile = path.join(
      OUTPUT,
      `desktop-level-${String(located.index + 1).padStart(2, "0")}-traversal-alternate-selected.png`,
    );
    screenshotEvidence.push({
      file: path.basename(alternateFile),
      bytes: await browser.screenshot(alternateFile, viewport),
      stage: "traversal-alternate-selected",
    });
  }

  await browser.evaluate("window.__CHASING_QA__.interact()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'exiting-hide'",
    4_000,
  );
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'free'",
    8_000,
  );
  const exited = await browser.evaluate("window.__CHASING_QA__.getState()");
  const expectedExit = archetype === "traversal-hide" ? spot.alternateExit : spot.approach;
  assert.ok(
    pointDistance(exited.game.player.position, expectedExit) <= 0.35,
    `${archetype} exited at ${JSON.stringify(exited.game.player.position)} instead of ${JSON.stringify(expectedExit)}`,
  );
  assert.equal(exited.game.phase, "playing");
  return {
    level: located.index + 1,
    hideSpotId: spot.id,
    archetype,
    selectedExit,
    expectedExit,
    finalPosition: exited.game.player.position,
    passed: true,
  };
}

async function completeMissionInOrder(browser, viewport, screenshotEvidence) {
  const before = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(before.game.phase, "playing");
  assert.equal(before.themeMission.state.exitUnlocked, false);
  await browser.evaluate("window.__CHASING_QA__.completeMission()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.themeMission?.state?.exitUnlocked === true",
    3_000,
  );
  const completed = await browser.evaluate("window.__CHASING_QA__.getState()");
  const expectedOrder = completed.themeMission.definition.objectives.map(
    (objective) => objective.id,
  );
  assert.deepEqual(
    completed.themeMission.state.completedObjectiveIds,
    expectedOrder,
    "theme objectives were not completed in their authored order",
  );
  assert.deepEqual(completed.themeMission.availableObjectiveIds, []);
  assert.equal(completed.themeMission.audit.passed, true);
  const file = path.join(
    OUTPUT,
    `desktop-level-${String(completed.campaign.number).padStart(2, "0")}-mission-exit-unlocked.png`,
  );
  screenshotEvidence.push({
    file: path.basename(file),
    bytes: await browser.screenshot(file, viewport),
    stage: "mission-exit-unlocked",
  });
  return {
    level: completed.campaign.number,
    theme: completed.campaign.theme,
    objectiveOrder: expectedOrder,
    completedObjectiveIds: completed.themeMission.state.completedObjectiveIds,
    exitUnlocked: completed.themeMission.state.exitUnlocked,
    softlockAuditPassed: completed.themeMission.audit.passed,
  };
}

async function auditMobileLayout(browser, stage) {
  const audit = await browser.evaluate(`(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0
        && rect.width > 0
        && rect.height > 0;
    };
    const targets = [...document.querySelectorAll('button, .virtual-stick')]
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label: element.getAttribute('aria-label')
            || element.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80)
            || element.className,
          width: rect.width,
          height: rect.height,
        };
      });
    const playfield = document.querySelector('.playfield')?.getBoundingClientRect();
    const canvas = document.querySelector('.playfield canvas')?.getBoundingClientRect();
    return {
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      playfield: playfield
        ? { left: playfield.left, right: playfield.right, width: playfield.width }
        : null,
      canvas: canvas
        ? { width: canvas.width, height: canvas.height, left: canvas.left, right: canvas.right }
        : null,
      targets,
      // Layout transforms and device-pixel rounding can report a CSS 44px
      // target as 43.996px. Keep a half-pixel tolerance while still catching
      // materially undersized controls (the former Pause button was 36px).
      undersized: targets.filter((target) => target.width < 43.5 || target.height < 43.5),
      loadingVisible: Boolean(document.querySelector('.loading-card, .loading-shell')),
    };
  })()`);
  assert.ok(audit.playfield, `${stage} has no playfield`);
  assert.ok(audit.canvas, `${stage} has no game canvas`);
  assert.ok(
    audit.scrollWidth <= audit.innerWidth + 1 && audit.bodyScrollWidth <= audit.innerWidth + 1,
    `${stage} overflows horizontally: ${audit.scrollWidth}/${audit.bodyScrollWidth} > ${audit.innerWidth}`,
  );
  assert.ok(
    audit.playfield.left >= -1 && audit.playfield.right <= audit.innerWidth + 1,
    `${stage} playfield is clipped horizontally`,
  );
  assert.ok(
    audit.canvas.left >= -1 && audit.canvas.right <= audit.innerWidth + 1,
    `${stage} canvas is clipped horizontally`,
  );
  assert.ok(audit.targets.length > 0, `${stage} has no visible touch controls`);
  assert.deepEqual(
    audit.undersized,
    [],
    `${stage} has touch targets smaller than 44x44`,
  );
  assert.equal(audit.loadingVisible, false);
  return audit;
}

await mkdir(OUTPUT, { recursive: true });
const browser = await connect();
const screenshotEvidence = [];
try {
  await navigateFresh(browser, DESKTOP, "desktop");

  const originalReady = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(originalReady.campaign.number, 1);
  assert.equal(originalReady.certifiedRemix.selected, false);
  assert.equal(originalReady.certifiedRemix.layoutNumber, null);
  const originalFile = path.join(OUTPUT, "desktop-level-01-ready-original.png");
  screenshotEvidence.push({
    file: path.basename(originalFile),
    bytes: await browser.screenshot(originalFile, DESKTOP),
    stage: "level-01-ready-original",
  });

  await browser.evaluate("window.__CHASING_QA__.selectLayout(2)");
  await waitForReady(browser, 0, 2);
  const layoutTwoReady = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(layoutTwoReady.certifiedRemix.selected, true);
  assert.equal(layoutTwoReady.certifiedRemix.layoutNumber, 2);
  assert.equal(layoutTwoReady.certifiedRemix.contract.variantIndex, 1);
  assert.ok(Number.isInteger(layoutTwoReady.certifiedRemix.seed));
  assert.ok(layoutTwoReady.certifiedRemix.runIdentity.includes("remix-v"));
  const layoutFile = path.join(OUTPUT, "desktop-level-01-ready-certified-layout-02.png");
  screenshotEvidence.push({
    file: path.basename(layoutFile),
    bytes: await browser.screenshot(layoutFile, DESKTOP),
    stage: "level-01-ready-certified-layout-02",
  });

  await browser.evaluate("window.__CHASING_QA__.selectLayout(null)");
  await waitForReady(browser, 0, null);

  const themeFrames = [];
  let themedActionObserved = null;
  for (const representative of REPRESENTATIVE_LEVELS) {
    const opening = await selectReadyLevel(browser, representative.index, null);
    assert.equal(opening.campaign.theme, representative.theme);
    await browser.evaluate("window.__CHASING_QA__.start()");
    await browser.waitFor(
      "window.__CHASING_QA__?.getState()?.game?.phase === 'playing'",
      8_000,
    );
    const playing = await browser.evaluate("window.__CHASING_QA__.getState()");
    const staged = await findVisibleActorScenario(browser, playing);
    const state = staged.state;
    assert.equal(state.chaserArchetype.runtime.enabled, true);
    assert.equal(state.chaserArchetype.profile.theme, representative.theme);
    assert.equal(
      state.chaserArchetype.runtime.archetype,
      state.chaserArchetype.profile.kind,
    );
    assert.equal(
      state.chaserArchetype.runtime.rule,
      state.chaserArchetype.profile.rule,
    );
    assert.equal(state.visibility.kid.rootVisible, true);
    assert.equal(state.visibility.villain.rootVisible, true);
    assert.equal(state.visibility.villain.worldRendered, true);
    assertActorViewport(state.visibility.kid.viewport, `${representative.theme} player`);
    assertActorViewport(state.visibility.villain.viewport, `${representative.theme} chaser`);

    const file = path.join(
      OUTPUT,
      `desktop-level-${String(representative.index + 1).padStart(2, "0")}-${representative.theme}-playing.png`,
    );
    const bytes = await browser.screenshot(file, DESKTOP);
    screenshotEvidence.push({
      file: path.basename(file),
      bytes,
      stage: `${representative.theme}-playing`,
    });
    themeFrames.push({
      level: representative.index + 1,
      id: state.campaign.id,
      theme: representative.theme,
      scenario: staged.pair,
      playerViewport: state.visibility.kid.viewport,
      chaserViewport: state.visibility.villain.viewport,
      chaserArchetype: {
        profile: state.chaserArchetype.profile,
        runtime: state.chaserArchetype.runtime,
      },
      screenshotBytes: bytes,
    });

    if (!themedActionObserved) {
      try {
        await browser.waitFor(`(() => {
          const runtime = window.__CHASING_QA__?.getState()?.chaserArchetype?.runtime;
          return runtime?.phase === 'telegraph' || runtime?.phase === 'acting';
        })()`, representative.theme === "factory" ? 3_500 : 1_100, 45);
        const actionState = await browser.evaluate("window.__CHASING_QA__.getState()");
        themedActionObserved = {
          level: representative.index + 1,
          theme: representative.theme,
          phase: actionState.chaserArchetype.runtime.phase,
          action: actionState.chaserArchetype.runtime.action,
          cueLabel: actionState.chaserArchetype.runtime.cueLabel,
        };
      } catch {
        // Every representative still validates the enabled, public runtime
        // contract. Some authored stimuli intentionally require a longer,
        // player-caused beat than a deterministic beauty shot supplies.
      }
    }
  }

  const hardLocker = await exerciseHardLocker(browser, DESKTOP, screenshotEvidence);
  const softCover = await exerciseAlternativeHide(
    browser,
    DESKTOP,
    "soft-cover",
    screenshotEvidence,
  );
  const traversalHide = await exerciseAlternativeHide(
    browser,
    DESKTOP,
    "traversal-hide",
    screenshotEvidence,
  );
  const mission = await completeMissionInOrder(browser, DESKTOP, screenshotEvidence);

  await navigateFresh(browser, MOBILE, "mobile");
  const mobileReadyAudit = await auditMobileLayout(browser, "mobile-ready");
  const mobileReadyFile = path.join(OUTPUT, "mobile-level-01-ready.png");
  screenshotEvidence.push({
    file: path.basename(mobileReadyFile),
    bytes: await browser.screenshot(mobileReadyFile, MOBILE),
    stage: "mobile-ready",
  });

  await browser.evaluate("window.__CHASING_QA__.start()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.phase === 'playing'",
    8_000,
  );
  const mobileOpening = await browser.evaluate("window.__CHASING_QA__.getState()");
  const mobileStaged = await findVisibleActorScenario(browser, mobileOpening);
  assertActorViewport(
    mobileStaged.state.visibility.kid.viewport,
    "mobile player",
    { inset: 0.015 },
  );
  assertActorViewport(
    mobileStaged.state.visibility.villain.viewport,
    "mobile chaser",
    { inset: 0.015 },
  );
  const mobilePlayingAudit = await auditMobileLayout(browser, "mobile-playing");
  const mobilePlayingFile = path.join(OUTPUT, "mobile-level-01-playing.png");
  screenshotEvidence.push({
    file: path.basename(mobilePlayingFile),
    bytes: await browser.screenshot(mobilePlayingFile, MOBILE),
    stage: "mobile-playing",
  });

  const mobileHardSpot = mobileStaged.state.campaign.hideSpots.find(
    (spot) => (spot.archetype ?? "hard-locker") === "hard-locker",
  );
  assert.ok(mobileHardSpot, "mobile level 1 has no hard locker");
  await browser.evaluate(
    `window.__CHASING_QA__.setScenario(${JSON.stringify({
      player: mobileHardSpot.approach,
      chaser: fartherAnchor(mobileHardSpot.approach, mobileStaged.state),
    })})`,
  );
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.interaction?.kind === 'enter'
      && state?.interaction?.hideSpotId === ${JSON.stringify(mobileHardSpot.id)};
  })()`, 8_000);
  await browser.evaluate("window.__CHASING_QA__.interact()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.player?.mode === 'hidden'",
    8_000,
  );
  const mobileHiddenState = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(mobileHiddenState.activeHideArchetype?.archetype, "hard-locker");
  assert.equal(mobileHiddenState.interaction?.kind, "exit");
  const mobileHiddenAudit = await auditMobileLayout(browser, "mobile-hidden");
  const mobileHiddenFile = path.join(OUTPUT, "mobile-level-01-hard-locker-hidden.png");
  screenshotEvidence.push({
    file: path.basename(mobileHiddenFile),
    bytes: await browser.screenshot(mobileHiddenFile, MOBILE),
    stage: "mobile-hard-locker-hidden",
  });

  const runtimeExceptions = browser.events.filter(
    (event) => event.method === "Runtime.exceptionThrown",
  );
  const consoleErrors = browser.events.filter(
    (event) => event.method === "Runtime.consoleAPICalled"
      && ["error", "assert"].includes(event.params?.type),
  );
  const severeLogs = browser.events.filter(
    (event) => event.method === "Log.entryAdded"
      && event.params?.entry?.level === "error",
  );
  assert.deepEqual(runtimeExceptions, [], "browser runtime emitted an exception");
  assert.deepEqual(consoleErrors, [], "browser console emitted an error/assertion");
  assert.deepEqual(severeLogs, [], "browser emitted an error log entry");

  const summary = {
    generatedAt: new Date().toISOString(),
    target: "final-production-build",
    baseUrl: BASE_URL,
    chromeDebugPort: DEBUG_PORT,
    viewports: {
      desktop: DESKTOP,
      mobile: MOBILE,
    },
    readyLayouts: {
      original: {
        level: originalReady.campaign.number,
        selected: originalReady.certifiedRemix.selected,
        layoutNumber: originalReady.certifiedRemix.layoutNumber,
      },
      certifiedLayout02: {
        level: layoutTwoReady.campaign.number,
        selected: layoutTwoReady.certifiedRemix.selected,
        layoutNumber: layoutTwoReady.certifiedRemix.layoutNumber,
        seed: layoutTwoReady.certifiedRemix.seed,
        runIdentity: layoutTwoReady.certifiedRemix.runIdentity,
      },
    },
    themeFrames,
    hardLocker,
    alternativeHides: {
      softCover,
      traversalHide,
    },
    mission,
    chaserArchetypes: {
      enabledProfiles: themeFrames.map((frame) => ({
        level: frame.level,
        theme: frame.theme,
        kind: frame.chaserArchetype.profile.kind,
        rule: frame.chaserArchetype.profile.rule,
        runtimeEnabled: frame.chaserArchetype.runtime.enabled,
      })),
      actionObserved: themedActionObserved,
      runtimeStructurePassed: themeFrames.every((frame) => (
        frame.chaserArchetype.runtime.enabled
        && frame.chaserArchetype.runtime.archetype === frame.chaserArchetype.profile.kind
        && frame.chaserArchetype.runtime.rule === frame.chaserArchetype.profile.rule
      )),
    },
    mobile: {
      ready: mobileReadyAudit,
      playing: mobilePlayingAudit,
      hidden: mobileHiddenAudit,
      playerViewport: mobileStaged.state.visibility.kid.viewport,
      chaserViewport: mobileStaged.state.visibility.villain.viewport,
      hardLockerHidden: mobileHiddenState.game.player.hideSpotId,
    },
    screenshots: screenshotEvidence,
    screenshotThresholds: SCREENSHOT_MINIMUM,
    diagnostics: {
      runtimeExceptions: runtimeExceptions.length,
      consoleErrors: consoleErrors.length,
      severeLogEntries: severeLogs.length,
    },
    allPassed: true,
  };
  await writeFile(
    path.join(OUTPUT, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary, null, 2));
} finally {
  browser.close();
}
