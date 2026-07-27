#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isThreeLoaderAssetFailure,
  protocolDiagnosticText,
} from "./qa-protocol-diagnostics.mjs";
import { collectQaSourceProvenance } from "./qa-source-provenance.mjs";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:3000/?qa=1";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-hospital-gold-visual-qa",
);
const COMPLETED_OBJECTIVE_LIGHT_COLOR = 0x5ae0a0;
const RECOMMENDED_LOADOUT = Object.freeze([
  "corner-mirror",
  "temporary-blackout",
]);
const ALL_LOADOUT_TOOLS = Object.freeze([
  "door-wedge",
  "corner-mirror",
  "temporary-blackout",
  "evidence-erasure",
]);
const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

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

const HOSPITAL_PLAN_EXPECTATIONS = Object.freeze({
  "pharmacy-authorization": Object.freeze({
    planId: "pharmacy-authorization",
    objectiveIds: Object.freeze([
      "hospital:recover-pharmacy-authorization",
      "hospital:write-ambulance-egress-permit",
      "hospital:release-ambulance-entrance",
    ]),
    exitId: "ambulance-entrance",
    exit: Object.freeze({ x: 23, y: 12 }),
    secondaryExitId: "maintenance-passage",
    alternatePlanLabel: /应急供电/u,
  }),
  "emergency-maintenance": Object.freeze({
    planId: "emergency-maintenance",
    objectiveIds: Object.freeze([
      "hospital:restore-emergency-power",
      "hospital:bypass-maintenance-interlock",
      "hospital:release-maintenance-passage",
    ]),
    exitId: "maintenance-passage",
    exit: Object.freeze({ x: 23, y: 21 }),
    secondaryExitId: "ambulance-entrance",
    alternatePlanLabel: /药房授权/u,
  }),
});

function qaUrl() {
  const url = new URL(BASE_URL);
  url.searchParams.set("qa", "hospital-gold-visual");
  url.searchParams.set("qaQuality", "high");
  return url.href;
}

function completedPlanWaitExpression(expected) {
  const objectiveIds = JSON.stringify(expected.objectiveIds);
  return `(() => {
    const state = window.__CHASING_QA__?.getState();
    const expectedObjectiveIds = ${objectiveIds};
    const sameIds = (actual) => Array.isArray(actual)
      && actual.length === expectedObjectiveIds.length
      && actual.every((id, index) => id === expectedObjectiveIds[index]);
    return state?.themeMission?.hospital?.state?.activePlanId
        === ${JSON.stringify(expected.planId)}
      && state.themeMission.hospital.state.status === "exit-ready"
      && sameIds(state.themeMission.hospital.state.completedObjectiveIds)
      && state.themeMission.hospital.state.unlockedExitIds?.length === 1
      && state.themeMission.hospital.state.unlockedExitIds[0]
        === ${JSON.stringify(expected.exitId)}
      && state.themeMission.state?.exitUnlocked === true
      && sameIds(state.themeMission.playerRuleProgress?.completedObjectiveIds)
      && state.themeMission.playerRuleProgress?.exitUnlocked === true
      && state.themeMission.views?.length === expectedObjectiveIds.length
      && state.themeMission.views.every((view) =>
        expectedObjectiveIds.includes(view.id)
        && view.lightColor === ${COMPLETED_OBJECTIVE_LIGHT_COLOR}
        && view.lightIntensity > 0
      );
  })()`;
}

function assertPlanReady(snapshot, expected) {
  const hospital = snapshot.themeMission.hospital;
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.campaign.id, "hospital-outpatient-afterhours");
  assert.equal(snapshot.campaign.number, 4);
  assert.equal(snapshot.campaign.theme, "hospital");
  assert.deepEqual(snapshot.campaign.exit, expected.exit);
  assert.equal(snapshot.themeMission.audit.passed, true);
  assert.equal(hospital.state.activePlanId, expected.planId);
  assert.equal(hospital.selectedPlan.id, expected.planId);
  assert.deepEqual(
    snapshot.themeMission.runtimeObjectives.map(({ id }) => id),
    expected.objectiveIds,
  );
  assert.deepEqual(hospital.selectedPlan.objectiveIds, expected.objectiveIds);
  assert.deepEqual(
    snapshot.themeMission.views.map(({ id }) => id),
    expected.objectiveIds,
  );
  assert.deepEqual(
    snapshot.themeMission.placements.map(({ objectiveId }) => objectiveId),
    expected.objectiveIds,
  );
  assert.equal(snapshot.themeMission.views.length, 3);
  assert.equal(snapshot.themeMission.placements.length, 3);
  for (const objectiveId of expected.objectiveIds) {
    assert.ok(
      snapshot.assets.placedAssetIds.includes(
        `gameplay:mission-objective:${objectiveId}`,
      ),
      `${objectiveId} has no formal mission view asset`,
    );
  }
  assert.ok(
    snapshot.assets.placedAssetIds.includes(
      `gameplay:hospital-secondary-exit:${expected.secondaryExitId}`,
    ),
    `${expected.planId} has no formal secondary-exit asset`,
  );
  assert.equal(snapshot.firstPlayableBudget.fits, true);
}

function assertCompletedPlan(snapshot, expected) {
  assertPlanReady(snapshot, expected);
  const hospitalState = snapshot.themeMission.hospital.state;
  assert.equal(hospitalState.status, "exit-ready");
  assert.deepEqual(hospitalState.completedObjectiveIds, expected.objectiveIds);
  assert.deepEqual(hospitalState.unlockedExitIds, [expected.exitId]);
  assert.equal(snapshot.themeMission.state.exitUnlocked, true);
  assert.deepEqual(
    snapshot.themeMission.playerRuleProgress.completedObjectiveIds,
    expected.objectiveIds,
  );
  assert.equal(snapshot.themeMission.playerRuleProgress.exitUnlocked, true);
  assert.equal(snapshot.themeMission.playerRuleProgress.stage, "escape");
  assert.deepEqual(snapshot.themeMission.availableObjectiveIds, []);
  for (const view of snapshot.themeMission.views) {
    assert.equal(
      view.lightColor,
      COMPLETED_OBJECTIVE_LIGHT_COLOR,
      `${view.id} did not retain its completion light`,
    );
    assert.ok(view.lightIntensity > 0, `${view.id} completion light is dark`);
  }
}

async function completePlanThroughPlayerInteractions(browser, expected) {
  const observations = [];
  for (const objectiveId of expected.objectiveIds) {
    const ready = await browser.evaluate(
      "window.__CHASING_QA__.getState()",
    );
    const placement = ready.themeMission.placements.find(
      (candidate) => candidate.objectiveId === objectiveId,
    );
    const objective = ready.themeMission.runtimeObjectives.find(
      (candidate) => candidate.id === objectiveId,
    );
    assert.ok(placement, `${objectiveId} has no runtime interaction placement`);
    assert.ok(objective, `${objectiveId} has no runtime objective contract`);

    await browser.evaluate(`window.__CHASING_QA__.setScenario({
      player: ${JSON.stringify(placement.position)},
      chaser: { x: 3, y: 20 },
      spawnDelaySeconds: 99,
      preserveMissionProgress: true
    })`);
    await browser.waitFor(`(() => {
      const state = window.__CHASING_QA__?.getState();
      return state?.game?.phase === "playing"
        && state.themeMission?.availableObjectiveIds?.[0]
          === ${JSON.stringify(objectiveId)}
        && state.themeMission?.commitment === null;
    })()`);
    const acceptedBefore = await browser.evaluate(
      "window.__CHASING_QA__.getState().themeMission.hospital.worldSoundDelivery.acceptedCount",
    );
    await browser.evaluate("window.__CHASING_QA__.interact()");
    await browser.waitFor(`(() => {
      const state = window.__CHASING_QA__?.getState();
      return state?.themeMission?.commitment?.objectiveId
          === ${JSON.stringify(objectiveId)}
        && state.themeMission.exposureWindow?.durationSeconds > 0;
    })()`);

    const commitmentStart = await browser.evaluate(
      "window.__CHASING_QA__.getState()",
    );
    const playerBeforeMove = commitmentStart.game.player.position;
    await browser.evaluate(`window.dispatchEvent(new KeyboardEvent(
      "keydown",
      { key: "w", bubbles: true }
    ))`);
    await sleep(120);
    await browser.evaluate(`window.dispatchEvent(new KeyboardEvent(
      "keyup",
      { key: "w", bubbles: true }
    ))`);
    const playerAfterMove = await browser.evaluate(
      "window.__CHASING_QA__.getState().game.player.position",
    );
    assert.ok(
      Math.hypot(
        playerAfterMove.x - playerBeforeMove.x,
        playerAfterMove.y - playerBeforeMove.y,
      ) < 0.01,
      `${objectiveId} did not lock movement during its commitment`,
    );
    const exposure = commitmentStart.themeMission.exposureWindow;
    assert.ok(
      exposure.durationSeconds >= objective.exposureSeconds - 1e-9,
      `${objectiveId} underpaid authored exposure`,
    );
    assert.ok(
      exposure.durationSeconds - objective.exposureSeconds <= 1 / 60 + 1e-9,
      `${objectiveId} exposure exceeded one fixed tick of rounding`,
    );
    if (objective.exposureSeconds > objective.commitmentSeconds) {
      assert.equal(
        exposure.active,
        true,
        `${objectiveId} should expose immediately`,
      );
    } else {
      await browser.waitFor(
        'document.querySelector(".playfield")?.classList.contains("hospital-mission-exposed") === true',
        4_000,
      );
    }
    await browser.waitFor(`window.__CHASING_QA__
      ?.getState()
      ?.themeMission
      ?.hospital
      ?.state
      ?.completedObjectiveIds
      ?.includes(${JSON.stringify(objectiveId)})`, 5_000);
    const completed = await browser.evaluate(
      "window.__CHASING_QA__.getState()",
    );
    assert.equal(
      completed.themeMission.hospital.worldSoundDelivery.acceptedCount,
      acceptedBefore + 1,
      `${objectiveId} did not emit its authored public sound`,
    );
    if (objective.exposureSeconds > objective.commitmentSeconds) {
      assert.equal(
        completed.themeMission.exposureWindow.active,
        true,
        `${objectiveId} did not retain post-interaction exposure`,
      );
    }
    observations.push({
      objectiveId,
      commitmentSeconds: objective.commitmentSeconds,
      exposureSeconds: objective.exposureSeconds,
      exposureWindow: commitmentStart.themeMission.exposureWindow,
      publicSoundAcceptedDelta:
        completed.themeMission.hospital.worldSoundDelivery.acceptedCount
        - acceptedBefore,
      movementLocked: true,
    });
  }
  return observations;
}

function planReport(snapshot) {
  return {
    planId: snapshot.themeMission.hospital.state.activePlanId,
    objectiveIds: snapshot.themeMission.runtimeObjectives.map(({ id }) => id),
    completedObjectiveIds:
      snapshot.themeMission.hospital.state.completedObjectiveIds,
    unlockedExitIds: snapshot.themeMission.hospital.state.unlockedExitIds,
    playerRuleProgress: snapshot.themeMission.playerRuleProgress,
    loadout: snapshot.themeMission.hospital.loadout,
    views: snapshot.themeMission.views,
    placements: snapshot.themeMission.placements,
    exit: snapshot.campaign.exit,
  };
}

async function connect() {
  const targetResponse = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/list`,
  );
  assert.equal(
    targetResponse.ok,
    true,
    `Chrome target endpoint returned ${targetResponse.status}`,
  );
  const targets = await targetResponse.json();
  const pageTargets = targets.filter(
    (entry) => entry.type === "page" && !entry.url.startsWith("chrome://"),
  );
  assert.equal(
    pageTargets.length,
    1,
    `QA requires exactly one dedicated page target; found ${pageTargets.length}`,
  );

  const socket = new WebSocket(pageTargets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let requestId = 0;
  const pending = new Map();
  const diagnostics = [];
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
      if (message.method === "Runtime.exceptionThrown") {
        diagnostics.push({
          kind: "runtime-exception",
          text: message.params.exceptionDetails.exception?.description
            ?? message.params.exceptionDetails.text,
        });
      } else if (isThreeLoaderAssetFailure(message)) {
        diagnostics.push({
          kind: "three-loader-asset-failure",
          text: protocolDiagnosticText(message),
        });
      } else if (
        message.method === "Runtime.consoleAPICalled"
        && ["error", "assert"].includes(message.params.type)
      ) {
        diagnostics.push({
          kind: "console-error",
          text: message.params.args
            .map((argument) => argument.value ?? argument.description ?? "")
            .join(" "),
        });
      } else if (
        message.method === "Log.entryAdded"
        && message.params.entry.level === "error"
      ) {
        diagnostics.push({
          kind: "log-error",
          text: message.params.entry.text,
        });
      } else if (
        message.method === "Network.responseReceived"
        && message.params.response.status >= 400
      ) {
        diagnostics.push({
          kind: "http-error",
          text: `${message.params.response.status} ${message.params.response.url}`,
        });
      } else if (
        message.method === "Network.loadingFailed"
        && message.params.canceled !== true
      ) {
        diagnostics.push({
          kind: "network-loading-failed",
          text: `${message.params.type}: ${message.params.errorText}`,
        });
      }
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
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? `Runtime evaluation failed: ${expression}`,
      );
    }
    return response.result.value;
  };
  const waitFor = async (expression, timeout = 30_000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started <= timeout) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch {
        // React intentionally replaces the bridge while rebuilding a route.
      }
      await sleep(80);
    }
    throw new Error(
      `Timed out waiting for ${expression}; last=${JSON.stringify(last)}`,
    );
  };
  const viewport = async (width, height, mobile = false) => {
    await Promise.all([
      send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile,
      }),
      send("Emulation.setTouchEmulationEnabled", {
        enabled: mobile,
        maxTouchPoints: mobile ? 5 : 1,
      }),
      send("Page.bringToFront"),
    ]);
    await sleep(180);
  };
  const screenshot = async (name) => {
    const blockers = await evaluate(`({
      loading: document.querySelectorAll(".loading-card, .loading-shell").length,
      errors: document.querySelectorAll(".loading-card.error, .error-card, .load-error").length,
      canvases: document.querySelectorAll(".playfield canvas").length
    })`);
    assert.equal(blockers.loading, 0, `${name} still has loading UI`);
    assert.equal(blockers.errors, 0, `${name} has load errors`);
    assert.equal(blockers.canvases, 1, `${name} must contain one WebGL canvas`);
    const result = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    assert.ok(bytes.length > 45_000, `${name} is suspiciously small`);
    const file = path.join(OUTPUT, name);
    await writeFile(file, bytes);
    return {
      file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      captureBackend: "cdp-browser-surface",
    };
  };

  return {
    diagnostics,
    evaluate,
    screenshot,
    send,
    socket,
    viewport,
    waitFor,
  };
}

async function auditTouchLayout(browser, stage) {
  return browser.evaluate(`(() => {
    const stage = ${JSON.stringify(stage)};
    const selectorsByStage = {
      chapter: [
        '.pre-run-body[data-step="chapter"] .level-grid button',
        ".pre-run-footer button"
      ],
      strategy: [
        '.pre-run-body[data-step="strategy"] .preference-settings button',
        '.pre-run-body[data-step="strategy"] .hospital-plan-selector button',
        '.pre-run-body[data-step="strategy"] .hospital-loadout-selector button',
        '.pre-run-body[data-step="strategy"] .pre-run-disclosure > summary',
        ".pre-run-footer button"
      ],
      briefing: [
        '.pre-run-body[data-step="briefing"] .pre-run-disclosure > summary',
        ".pre-run-footer button"
      ],
      running: [
        ".view-controls button",
        ".action-controls button",
        ".stealth-tool-row button",
        ".controls"
      ]
    };
    const selectors = selectorsByStage[stage] ?? [];
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      let current = element;
      while (current instanceof HTMLElement) {
        const style = getComputedStyle(current);
        if (
          style.display === "none"
          || style.visibility === "hidden"
          || Number(style.opacity) <= 0
        ) return false;
        current = current.parentElement;
      }
      const bounds = element.getBoundingClientRect();
      if (!(bounds.width > 0
        && bounds.height > 0
        && bounds.right > 0
        && bounds.bottom > 0
        && bounds.left < innerWidth
        && bounds.top < innerHeight)) return false;
      // getBoundingClientRect still reports descendants scrolled behind a
      // clipped header. Exclude controls whose centre is outside any overflow
      // ancestor before treating elementFromPoint as an occlusion failure.
      let clipAncestor = element.parentElement;
      while (clipAncestor instanceof HTMLElement) {
        const clipStyle = getComputedStyle(clipAncestor);
        const clipsX = /(auto|scroll|hidden|clip)/.test(clipStyle.overflowX);
        const clipsY = /(auto|scroll|hidden|clip)/.test(clipStyle.overflowY);
        if (clipsX || clipsY) {
          const clipBounds = clipAncestor.getBoundingClientRect();
          if (
            (
              clipsX
              && (
                bounds.left < clipBounds.left - 0.5
                || bounds.right > clipBounds.right + 0.5
              )
            )
            || (
              clipsY
              && (
                bounds.top < clipBounds.top - 0.5
                || bounds.bottom > clipBounds.bottom + 0.5
              )
            )
          ) return false;
        }
        clipAncestor = clipAncestor.parentElement;
      }
      return true;
    };
    const nodes = [...new Set(
      selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
    )].filter(isVisible);
    const targets = nodes.map((element, index) => {
      const bounds = element.getBoundingClientRect();
      const centerX = Math.min(
        innerWidth - 1,
        Math.max(0, bounds.left + bounds.width / 2),
      );
      const centerY = Math.min(
        innerHeight - 1,
        Math.max(0, bounds.top + bounds.height / 2),
      );
      const hit = document.elementFromPoint(centerX, centerY);
      return {
        index,
        label: element.getAttribute("aria-label")
          || element.textContent?.replace(/\\s+/g, " ").trim()
          || String(element.className),
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
        hitTestable: Boolean(hit && element.contains(hit))
      };
    });
    const overlaps = [];
    for (let first = 0; first < targets.length; first += 1) {
      for (let second = first + 1; second < targets.length; second += 1) {
        const a = targets[first];
        const b = targets[second];
        if (
          a.left < b.right
          && a.right > b.left
          && a.top < b.bottom
          && a.bottom > b.top
        ) {
          overlaps.push([a.label, b.label]);
        }
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      stage,
      horizontalOverflow:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      targetCount: targets.length,
      targets,
      overlaps,
      coveredTargets: targets.filter(({ hitTestable }) => !hitTestable),
      undersizedTargets: targets.filter(
        ({ width, height }) => width < 43.5 || height < 43.5
      )
    };
  })()`);
}

function assertTouchLayout(layout, stage) {
  assert.equal(layout.viewport.width, 390);
  assert.equal(layout.viewport.height, 844);
  assert.equal(layout.horizontalOverflow, false, `${stage} overflows horizontally`);
  const minimumTargetCount = layout.stage === "briefing" ? 2 : 3;
  assert.ok(
    layout.targetCount >= minimumTargetCount,
    `${stage} exposes too few touch targets: ${JSON.stringify(layout.targets)}`,
  );
  assert.deepEqual(
    layout.overlaps,
    [],
    `${stage} touch targets overlap`,
  );
  assert.deepEqual(
    layout.coveredTargets,
    [],
    `${stage} has covered touch targets`,
  );
  assert.deepEqual(
    layout.undersizedTargets,
    [],
    `${stage} has touch targets below 44px`,
  );
}

async function waitForPreRunStep(browser, step) {
  await browser.waitFor(`(() => {
    const body = document.querySelector(".pre-run-body");
    const current = document.querySelector(
      '.pre-run-progress [aria-current="step"] b'
    )?.textContent?.trim();
    return window.__CHASING_QA__?.getState()?.game?.phase === "ready"
      && body?.getAttribute("data-step") === ${JSON.stringify(step)}
      && Boolean(current);
  })()`);
}

async function advancePreRunStep(browser, from, to) {
  await waitForPreRunStep(browser, from);
  await browser.evaluate(`(() => {
    const button = document.querySelector(".pre-run-footer .primary");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("pre-run primary action is unavailable");
    }
    button.click();
  })()`);
  if (to === "playing") {
    await browser.waitFor(
      "window.__CHASING_QA__?.getState()?.game?.phase === 'playing'",
    );
    return;
  }
  await waitForPreRunStep(browser, to);
}

async function capturePreRunEvidence(browser, prefix, step) {
  await waitForPreRunStep(browser, step);
  await browser.viewport(1512, 982, false);
  await browser.evaluate(`(() => {
    const body = document.querySelector(".pre-run-body");
    if (body instanceof HTMLElement) body.scrollTop = 0;
  })()`);
  await sleep(120);
  const desktop = await browser.screenshot(`${prefix}-desktop-${step}.png`);

  await browser.viewport(390, 844, true);
  if (step === "strategy") {
    await browser.evaluate(`(() => {
      document.querySelector(".hospital-plan-selector")?.scrollIntoView({
        block: "start",
        inline: "nearest"
      });
    })()`);
  } else {
    await browser.evaluate(`(() => {
      const body = document.querySelector(".pre-run-body");
      if (body instanceof HTMLElement) body.scrollTop = 0;
    })()`);
  }
  await sleep(160);
  const layout = await auditTouchLayout(browser, step);
  const mobile = await browser.screenshot(`${prefix}-mobile-${step}.png`);
  assertTouchLayout(layout, `${prefix} mobile ${step}`);
  const progress = await browser.evaluate(`(() => ({
    step: document.querySelector(".pre-run-body")?.getAttribute("data-step"),
    current: document.querySelector(
      '.pre-run-progress [aria-current="step"] b'
    )?.textContent?.trim(),
    completeCount: document.querySelectorAll(
      '.pre-run-progress [data-complete="true"]'
    ).length
  }))()`);
  assert.equal(progress.step, step);
  assert.equal(
    progress.completeCount,
    step === "chapter" ? 0 : step === "strategy" ? 1 : 2,
  );
  return { step, desktop, mobile, layout, progress };
}

async function captureRunningEvidence(browser, prefix) {
  await browser.viewport(1512, 982, false);
  await sleep(120);
  const desktop = await browser.screenshot(`${prefix}-desktop-running.png`);

  await browser.viewport(390, 844, true);
  await sleep(180);
  const layout = await auditTouchLayout(browser, "running");
  const mobile = await browser.screenshot(`${prefix}-mobile-running.png`);
  assertTouchLayout(layout, `${prefix} mobile running`);
  return { desktop, mobile, layout };
}

await mkdir(OUTPUT, { recursive: true });
const sourceProvenance = collectQaSourceProvenance();
const browser = await connect();
try {
  await browser.viewport(1512, 982, false);
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: QA_BOOTSTRAP_SOURCE,
  });
  await browser.send("Storage.clearDataForOrigin", {
    origin: new URL(qaUrl()).origin,
    storageTypes: "local_storage",
  });
  await browser.send("Page.navigate", { url: qaUrl() });
  await browser.waitFor(
    "document.readyState === 'complete' && Boolean(window.__CHASING_QA__?.getState()?.ready)",
    45_000,
  );
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");
  await browser.evaluate("window.__CHASING_QA__.selectLevel(3)");
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready
      && state.campaign?.id === "hospital-outpatient-afterhours"
      && state.campaign?.number === 4
      && state.themeMission?.hospital?.selectedPlan?.id
        === "pharmacy-authorization"
      && state.assets?.decorativeReady === true
      && state.assets?.deferredDressingSettled === true
      && state.assets?.qaDecorativeSceneCompiled === true
      && state.assets?.qaDecorativeSceneCompileCount === 1
      && state.assets?.qaTransientArtPrewarmCount === 1
      && !document.querySelector(
        ".loading-card, .loading-shell, .error-card, .load-error"
      );
  })()`, 60_000);

  const frameDriver = await browser.evaluate(
    "window.__CHASING_QA_FRAME_DRIVER__",
  );
  const cssMotion = await browser.evaluate(
    "window.__CHASING_QA_CSS_MOTION__",
  );
  assert.equal(frameDriver, "timer-60hz");
  assert.equal(cssMotion, "settled");
  await browser.evaluate("window.__CHASING_QA__.setDirectorEnabled(false)");
  assert.equal(
    await browser.evaluate(
      "window.__CHASING_QA__.getStealthProbe().director.enabled",
    ),
    false,
  );

  const pharmacyExpected =
    HOSPITAL_PLAN_EXPECTATIONS["pharmacy-authorization"];
  const pharmacyReadyState = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assertPlanReady(pharmacyReadyState, pharmacyExpected);
  assert.deepEqual(
    pharmacyReadyState.themeMission.hospital.loadout.selectedToolIds,
    RECOMMENDED_LOADOUT,
  );
  assert.equal(
    pharmacyReadyState.themeMission.hospital.loadout.usesRecommendedLoadout,
    true,
  );
  assert.deepEqual(
    pharmacyReadyState.themeMission.hospital.definition.plans.map(
      ({ id }) => id,
    ),
    ["pharmacy-authorization", "emergency-maintenance"],
  );
  assert.deepEqual(
    pharmacyReadyState.themeMission.hospital.definition.exits.map(
      ({ id }) => id,
    ),
    ["ambulance-entrance", "maintenance-passage"],
  );
  assert.deepEqual(
    pharmacyReadyState.themeMission.hospital.definition.objectives
      .filter(({ planId }) => planId === pharmacyExpected.planId)
      .map(({ id }) => id),
    pharmacyExpected.objectiveIds,
  );
  const pharmacyChapterEvidence = await capturePreRunEvidence(
    browser,
    "01-hospital-pharmacy",
    "chapter",
  );
  await advancePreRunStep(browser, "chapter", "strategy");
  const loadoutUi = await browser.evaluate(`(() => ({
    step: document.querySelector(".pre-run-body")?.getAttribute("data-step"),
    planLabels: [...document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-plan-selector button'
    )].map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
    selectedPlanCount: document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-plan-selector button[aria-pressed="true"]'
    ).length,
    ids: [...document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-loadout-selector button'
    )]
      .map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
    selectedCount: document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-loadout-selector button[aria-pressed="true"]'
    ).length
  }))()`);
  assert.equal(loadoutUi.step, "strategy");
  assert.equal(loadoutUi.planLabels.length, 2);
  assert.equal(loadoutUi.selectedPlanCount, 1);
  assert.equal(loadoutUi.ids.length, 4);
  assert.equal(loadoutUi.selectedCount, 2);

  // Exercise the public four-choice/two-slot bridge, then restore the authored
  // recommendation before taking evidence or starting the run.
  await browser.evaluate(
    `window.__CHASING_QA__.selectHospitalLoadout(${JSON.stringify([
      "door-wedge",
      "evidence-erasure",
    ])})`,
  );
  await browser.waitFor(`(() => {
    const selected = window.__CHASING_QA__?.getState()
      ?.themeMission?.hospital?.loadout?.selectedToolIds;
    return JSON.stringify(selected) === JSON.stringify([
      "door-wedge",
      "evidence-erasure"
    ]);
  })()`);
  await browser.evaluate(
    `window.__CHASING_QA__.selectHospitalLoadout(${JSON.stringify(
      RECOMMENDED_LOADOUT,
    )})`,
  );
  await browser.waitFor(`(() => {
    const selected = window.__CHASING_QA__?.getState()
      ?.themeMission?.hospital?.loadout?.selectedToolIds;
    return JSON.stringify(selected) === JSON.stringify(${JSON.stringify(
      RECOMMENDED_LOADOUT,
    )});
  })()`);
  const pharmacyStrategyEvidence = await capturePreRunEvidence(
    browser,
    "01-hospital-pharmacy",
    "strategy",
  );
  await advancePreRunStep(browser, "strategy", "briefing");
  const pharmacyBriefingEvidence = await capturePreRunEvidence(
    browser,
    "01-hospital-pharmacy",
    "briefing",
  );

  await advancePreRunStep(browser, "briefing", "playing");
  const pharmacyInteractionObservations =
    await completePlanThroughPlayerInteractions(
      browser,
      pharmacyExpected,
    );
  await browser.waitFor(
    completedPlanWaitExpression(pharmacyExpected),
    6_000,
  );
  const pharmacyCompleted = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assertCompletedPlan(pharmacyCompleted, pharmacyExpected);
  const pharmacyRunningEvidence = await captureRunningEvidence(
    browser,
    "02-hospital-pharmacy-complete",
  );

  await browser.viewport(1512, 982, false);
  await browser.evaluate(`(() => {
    window.__CHASING_QA__.setScenario({
      player: ${JSON.stringify(pharmacyExpected.exit)},
      chaser: { x: 3, y: 20 },
      preserveMissionProgress: true
    });
  })()`);
  await browser.waitFor(
    `window.__CHASING_QA__?.getState()?.game?.phase === "won"
      && Boolean(document.querySelector(".library-plan-switch"))`,
    8_000,
  );
  const resultSwitchLabel = await browser.evaluate(
    'document.querySelector(".library-plan-switch")?.textContent?.replace(/\\s+/g, " ").trim()',
  );
  assert.match(resultSwitchLabel, pharmacyExpected.alternatePlanLabel);
  const pharmacyResult = await browser.screenshot(
    "03-hospital-pharmacy-result-route-switch.png",
  );

  // Use the player-facing result action, not the QA-only plan setter, to prove
  // the replay loop rebuilds the alternate route and its independent exit.
  await browser.evaluate(
    'document.querySelector(".library-plan-switch").click()',
  );
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready
      && state.themeMission?.hospital?.selectedPlan?.id
        === "emergency-maintenance"
      && state.campaign?.exit?.x === 23
      && state.campaign?.exit?.y === 21
      && state.assets?.decorativeReady === true
      && state.assets?.deferredDressingSettled === true
      && state.assets?.qaDecorativeSceneCompiled === true
      && state.assets?.qaDecorativeSceneCompileCount === 1
      && state.assets?.qaTransientArtPrewarmCount === 1
      && !document.querySelector(
        ".loading-card, .loading-shell, .error-card, .load-error"
      );
  })()`, 60_000);

  const emergencyExpected =
    HOSPITAL_PLAN_EXPECTATIONS["emergency-maintenance"];
  const emergencyReadyState = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assertPlanReady(emergencyReadyState, emergencyExpected);
  assert.deepEqual(
    emergencyReadyState.themeMission.hospital.loadout.selectedToolIds,
    RECOMMENDED_LOADOUT,
  );
  assert.deepEqual(
    emergencyReadyState.themeMission.hospital.definition.objectives
      .filter(({ planId }) => planId === emergencyExpected.planId)
      .map(({ id }) => id),
    emergencyExpected.objectiveIds,
  );
  // The result-page route switch intentionally returns to the strategy step:
  // the chapter is already known, while the alternate route and retained
  // two-slot loadout still need a player-facing review before the briefing.
  await waitForPreRunStep(browser, "strategy");
  const emergencyStrategyUi = await browser.evaluate(`(() => ({
    step: document.querySelector(".pre-run-body")?.getAttribute("data-step"),
    planLabels: [...document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-plan-selector button'
    )].map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
    selectedPlanCount: document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-plan-selector button[aria-pressed="true"]'
    ).length,
    loadoutLabels: [...document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-loadout-selector button'
    )].map((button) => button.textContent?.replace(/\\s+/g, " ").trim()),
    selectedLoadoutCount: document.querySelectorAll(
      '.pre-run-body[data-step="strategy"] .hospital-loadout-selector button[aria-pressed="true"]'
    ).length
  }))()`);
  assert.equal(emergencyStrategyUi.step, "strategy");
  assert.equal(emergencyStrategyUi.planLabels.length, 2);
  assert.equal(emergencyStrategyUi.selectedPlanCount, 1);
  assert.equal(emergencyStrategyUi.loadoutLabels.length, 4);
  assert.equal(emergencyStrategyUi.selectedLoadoutCount, 2);
  const emergencyStrategyEvidence = await capturePreRunEvidence(
    browser,
    "04-hospital-emergency",
    "strategy",
  );
  await advancePreRunStep(browser, "strategy", "briefing");
  const emergencyBriefingEvidence = await capturePreRunEvidence(
    browser,
    "04-hospital-emergency",
    "briefing",
  );

  await advancePreRunStep(browser, "briefing", "playing");
  const emergencyInteractionObservations =
    await completePlanThroughPlayerInteractions(
      browser,
      emergencyExpected,
    );
  await browser.waitFor(
    completedPlanWaitExpression(emergencyExpected),
    6_000,
  );
  const emergencyCompleted = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assertCompletedPlan(emergencyCompleted, emergencyExpected);
  const emergencyRunningEvidence = await captureRunningEvidence(
    browser,
    "05-hospital-emergency-complete",
  );

  const formalMissionMeshes = await browser.evaluate(`window.__CHASING_QA__
    .inspectScene()
    .filter((object) =>
      String(object.parent).includes("mission")
      || String(object.name).includes("Mission")
    )`);
  assert.ok(
    formalMissionMeshes.length >= 3,
    "hospital objectives are state-only and lack formal scene assets",
  );

  assert.deepEqual(
    browser.diagnostics,
    [],
    "hospital visual QA produced console, runtime, asset, or network errors",
  );
  const report = {
    baseUrl: BASE_URL,
    qaUrl: qaUrl(),
    frameDriver,
    cssMotion,
    sourceProvenance,
    diagnostics: browser.diagnostics,
    contract: {
      plans: Object.keys(HOSPITAL_PLAN_EXPECTATIONS),
      exits: Object.values(HOSPITAL_PLAN_EXPECTATIONS)
        .map(({ exitId }) => exitId),
      allLoadoutTools: ALL_LOADOUT_TOOLS,
      recommendedLoadout: RECOMMENDED_LOADOUT,
    },
    loadoutUi,
    resultRouteSwitch: {
      from: pharmacyExpected.planId,
      to: emergencyExpected.planId,
      label: resultSwitchLabel,
      usedPlayerFacingButton: true,
    },
    preRunFlow: {
      orderedSteps: ["chapter", "strategy", "briefing"],
      pharmacy: {
        chapter: pharmacyChapterEvidence.progress,
        strategy: pharmacyStrategyEvidence.progress,
        briefing: pharmacyBriefingEvidence.progress,
      },
      emergencyResultReplay: {
        entryStep: emergencyStrategyEvidence.step,
        strategy: emergencyStrategyEvidence.progress,
        briefing: emergencyBriefingEvidence.progress,
      },
    },
    missions: {
      pharmacy: {
        ...planReport(pharmacyCompleted),
        playerInteractionObservations: pharmacyInteractionObservations,
      },
      emergency: {
        ...planReport(emergencyCompleted),
        playerInteractionObservations: emergencyInteractionObservations,
      },
    },
    formalMissionMeshes,
    secondaryExitAssets: {
      pharmacy:
        `gameplay:hospital-secondary-exit:${pharmacyExpected.secondaryExitId}`,
      emergency:
        `gameplay:hospital-secondary-exit:${emergencyExpected.secondaryExitId}`,
    },
    mobileLayouts: {
      pharmacyChapter: pharmacyChapterEvidence.layout,
      pharmacyStrategy: pharmacyStrategyEvidence.layout,
      pharmacyBriefing: pharmacyBriefingEvidence.layout,
      pharmacyRunning: pharmacyRunningEvidence.layout,
      emergencyStrategy: emergencyStrategyEvidence.layout,
      emergencyBriefing: emergencyBriefingEvidence.layout,
      emergencyRunning: emergencyRunningEvidence.layout,
    },
    screenshots: [
      pharmacyChapterEvidence.desktop,
      pharmacyChapterEvidence.mobile,
      pharmacyStrategyEvidence.desktop,
      pharmacyStrategyEvidence.mobile,
      pharmacyBriefingEvidence.desktop,
      pharmacyBriefingEvidence.mobile,
      pharmacyRunningEvidence.desktop,
      pharmacyRunningEvidence.mobile,
      pharmacyResult,
      emergencyStrategyEvidence.desktop,
      emergencyStrategyEvidence.mobile,
      emergencyBriefingEvidence.desktop,
      emergencyBriefingEvidence.mobile,
      emergencyRunningEvidence.desktop,
      emergencyRunningEvidence.mobile,
    ],
  };
  await writeFile(
    path.join(OUTPUT, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  browser.socket.close();
}
