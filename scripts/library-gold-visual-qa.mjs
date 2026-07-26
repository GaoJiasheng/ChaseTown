#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectQaSourceProvenance } from "./qa-source-provenance.mjs";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:3000/?qa=1";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-library-gold-visual-qa",
);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const COMPLETED_OBJECTIVE_LIGHT_COLOR = 0x5ae0a0;
const LIBRARY_PLAN_EXPECTATIONS = Object.freeze({
  "access-authorization": Object.freeze({
    planId: "access-authorization",
    objectiveIds: Object.freeze([
      "library:retrieve-temporary-pass",
      "library:write-front-gate-authorization",
      "library:release-front-gate",
    ]),
    exitId: "front-gate",
    exit: Object.freeze({ x: 23, y: 1 }),
  }),
  "fire-release": Object.freeze({
    planId: "fire-release",
    objectiveIds: Object.freeze([
      "library:restore-egress-circuit",
      "library:prime-fire-door-linkage",
      "library:release-loading-fire-door",
    ]),
    exitId: "loading-fire-exit",
    exit: Object.freeze({ x: 2, y: 5 }),
  }),
});

function assertCompletedLibraryPlan(snapshot, expected) {
  const runtimeObjectiveIds = snapshot.themeMission.runtimeObjectives.map(({ id }) => id);
  const viewIds = snapshot.themeMission.views.map(({ id }) => id);
  assert.equal(snapshot.themeMission.library.state.activePlanId, expected.planId);
  assert.deepEqual(snapshot.campaign.exit, expected.exit);
  assert.deepEqual(runtimeObjectiveIds, expected.objectiveIds);
  assert.deepEqual(
    snapshot.themeMission.library.selectedPlan.objectiveIds,
    expected.objectiveIds,
  );
  assert.deepEqual(
    snapshot.themeMission.library.state.completedObjectiveIds,
    expected.objectiveIds,
  );
  assert.deepEqual(
    snapshot.themeMission.library.state.unlockedExitIds,
    [expected.exitId],
    `${expected.planId} unlocked more than its one authored exit`,
  );
  assert.equal(snapshot.themeMission.library.state.status, "exit-ready");
  assert.equal(snapshot.themeMission.state.exitUnlocked, true);
  assert.deepEqual(snapshot.themeMission.availableObjectiveIds, []);
  assert.deepEqual(
    snapshot.themeMission.playerRuleProgress.completedObjectiveIds,
    expected.objectiveIds,
  );
  assert.equal(snapshot.themeMission.playerRuleProgress.exitUnlocked, true);
  assert.equal(snapshot.themeMission.playerRuleProgress.stage, "escape");
  assert.deepEqual(viewIds, expected.objectiveIds);
  for (const view of snapshot.themeMission.views) {
    assert.equal(
      view.lightColor,
      COMPLETED_OBJECTIVE_LIGHT_COLOR,
      `${view.id} did not retain the authored green completion light`,
    );
    assert.ok(view.lightIntensity > 0, `${view.id} completion light is dark`);
  }
}

function completedPlanWaitExpression(expected) {
  const objectiveIds = JSON.stringify(expected.objectiveIds);
  return `(() => {
    const state = window.__CHASING_QA__?.getState();
    const expectedObjectiveIds = ${objectiveIds};
    const sameIds = (actual) => Array.isArray(actual)
      && actual.length === expectedObjectiveIds.length
      && actual.every((id, index) => id === expectedObjectiveIds[index]);
    return state?.themeMission?.library?.state?.activePlanId === ${JSON.stringify(expected.planId)}
      && state.themeMission.library.state.status === "exit-ready"
      && sameIds(state.themeMission.library.state.completedObjectiveIds)
      && state.themeMission.library.state.unlockedExitIds?.length === 1
      && state.themeMission.library.state.unlockedExitIds[0] === ${JSON.stringify(expected.exitId)}
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

function missionReport(snapshot) {
  return {
    planId: snapshot.themeMission.library.state.activePlanId,
    objectiveIds: snapshot.themeMission.runtimeObjectives.map(({ id }) => id),
    completedObjectiveIds: snapshot.themeMission.library.state.completedObjectiveIds,
    unlockedExitIds: snapshot.themeMission.library.state.unlockedExitIds,
    playerRuleProgress: snapshot.themeMission.playerRuleProgress,
    views: snapshot.themeMission.views,
    exit: snapshot.campaign.exit,
  };
}

async function connect() {
  const targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
    .then((response) => {
      assert.equal(response.ok, true, `Chrome target endpoint returned ${response.status}`);
      return response.json();
    });
  const target = targets.find((entry) => entry.type === "page" && entry.url === "about:blank")
    ?? targets.find((entry) => entry.type === "page" && !entry.url.startsWith("chrome://"));
  assert.ok(target, "Chrome has no inspectable page target");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  const diagnostics = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      if (message.method === "Runtime.exceptionThrown") {
        diagnostics.push(
          message.params.exceptionDetails.exception?.description
            ?? message.params.exceptionDetails.text,
        );
      }
      if (
        message.method === "Log.entryAdded"
        && message.params.entry.level === "error"
      ) diagnostics.push(message.params.entry.text);
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

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? `Runtime evaluation failed: ${expression}`,
      );
    }
    return result.result.value;
  };
  const waitFor = async (expression, timeout = 30_000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started <= timeout) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch {
        // React intentionally replaces the QA bridge during a level/plan rebuild.
      }
      await sleep(80);
    }
    throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(last)}`);
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
    const file = path.join(OUTPUT, name);
    const blockers = await evaluate(`({
      loading: document.querySelectorAll(".loading-card").length,
      errors: document.querySelectorAll(".loading-card.error").length,
      canvases: document.querySelectorAll(".playfield canvas").length
    })`);
    assert.equal(blockers.loading, 0, `${name} still has loading UI`);
    assert.equal(blockers.errors, 0, `${name} has load errors`);
    assert.equal(blockers.canvases, 1, `${name} must contain exactly one WebGL canvas`);
    const result = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(result.data, "base64");
    assert.ok(bytes.length > 45_000, `${name} is suspiciously small (${bytes.length})`);
    await writeFile(file, bytes);
    return { file, bytes: bytes.length };
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

async function auditMobileControlLayout(browser) {
  return browser.evaluate(`(() => {
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
      return bounds.width > 0 && bounds.height > 0;
    };
    const describe = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return {
        selector,
        visible: isVisible(element),
        display: getComputedStyle(element).display,
        opacity: Number(getComputedStyle(element).opacity),
        pointerEvents: getComputedStyle(element).pointerEvents,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height
      };
    };
    const overlaps = (first, second) => Boolean(
      first?.visible
      && second?.visible
      && first.left < second.right
      && first.right > second.left
      && first.top < second.bottom
      && first.bottom > second.top
    );
    const viewControls = describe(".view-controls");
    const actionControls = describe(".action-controls");
    const movementControls = describe(".controls");
    const interactionPrompt = describe(".interaction-prompt");
    const targets = [
      ...document.querySelectorAll(".view-controls button, .action-controls button, .controls")
    ].filter(isVisible).map((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.min(innerWidth - 1, Math.max(0, bounds.left + bounds.width / 2)),
        Math.min(innerHeight - 1, Math.max(0, bounds.top + bounds.height / 2)),
      );
      return {
        label: element.getAttribute("aria-label")
          || element.textContent?.replace(/\\s+/g, " ").trim()
          || element.className,
        width: bounds.width,
        height: bounds.height,
        hitTestable: Boolean(hit && element.contains(hit))
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      actionControlsDisplay: actionControls?.display ?? null,
      decoyButton: Boolean(document.querySelector(".action-controls .decoy-action")),
      desktopCard: getComputedStyle(document.querySelector(".portable-decoy-status")).display,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rects: { viewControls, actionControls, movementControls, interactionPrompt },
      overlaps: {
        viewAndAction: overlaps(viewControls, actionControls),
        viewAndMovement: overlaps(viewControls, movementControls),
        actionAndMovement: overlaps(actionControls, movementControls),
        promptAndView: overlaps(interactionPrompt, viewControls),
        promptAndAction: overlaps(interactionPrompt, actionControls),
        promptAndMovement: overlaps(interactionPrompt, movementControls)
      },
      coveredTargets: targets.filter((target) => !target.hitTestable),
      undersizedTargets: targets.filter(
        (target) => target.width < 43.5 || target.height < 43.5
      )
    };
  })()`);
}

function assertMobileControlLayout(layout, stage) {
  assert.equal(layout.actionControlsDisplay, "flex", `${stage} action lane is missing`);
  assert.equal(layout.decoyButton, true, `${stage} lost the portable-decoy control`);
  assert.equal(layout.desktopCard, "none", `${stage} leaked the desktop decoy card`);
  assert.equal(layout.horizontalOverflow, false, `${stage} overflows horizontally`);
  assert.deepEqual(
    layout.overlaps,
    {
      viewAndAction: false,
      viewAndMovement: false,
      actionAndMovement: false,
      promptAndView: false,
      promptAndAction: false,
      promptAndMovement: false,
    },
    `${stage} touch targets overlap: ${JSON.stringify(layout.rects)}`,
  );
  assert.deepEqual(
    layout.coveredTargets,
    [],
    `${stage} has visually present but covered targets`,
  );
  assert.deepEqual(
    layout.undersizedTargets,
    [],
    `${stage} has touch targets below 44px`,
  );
}

await mkdir(OUTPUT, { recursive: true });
const sourceProvenance = collectQaSourceProvenance();
const browser = await connect();
try {
  await browser.viewport(1512, 982, false);
  await browser.send("Page.navigate", { url: BASE_URL });
  await browser.waitFor("document.readyState === 'complete'", 45_000);
  await browser.evaluate("localStorage.clear()");
  await browser.send("Page.navigate", { url: BASE_URL });
  await browser.waitFor(
    "document.readyState === 'complete' && Boolean(window.__CHASING_QA__?.getState()?.ready)",
    45_000,
  );
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");
  await browser.evaluate("window.__CHASING_QA__.selectLevel(1)");
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready
      && state.campaign?.id === "campus-library-lockdown"
      && state.themeMission?.library?.selectedPlan?.id === "access-authorization"
      && !document.querySelector(".loading-card");
  })()`, 45_000);

  const accessExpected = LIBRARY_PLAN_EXPECTATIONS["access-authorization"];
  const access = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.deepEqual(access.campaign.exit, accessExpected.exit);
  assert.equal(access.themeMission.audit.passed, true);
  assert.deepEqual(
    access.themeMission.runtimeObjectives.map(({ id }) => id),
    accessExpected.objectiveIds,
  );
  assert.equal(access.firstPlayableBudget.fits, true);
  assert.ok(access.assets.placedAssetIds.includes("gameplay:library-secondary-exit:loading-fire-exit"));
  const accessReady = await browser.screenshot("01-library-access-plan-ready.png");

  await browser.evaluate("window.__CHASING_QA__.start()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.phase === 'playing'",
  );
  await browser.evaluate("window.__CHASING_QA__.completeMission()");
  await browser.waitFor(completedPlanWaitExpression(accessExpected), 5_000);
  const accessCompleted = await browser.evaluate("window.__CHASING_QA__.getState()");
  assertCompletedLibraryPlan(accessCompleted, accessExpected);
  const accessComplete = await browser.screenshot("02-library-access-plan-complete.png");

  // Complete a real escape, then use the player-facing result button to
  // rebuild the alternate branch. This closes the route-replay loop without
  // relying on a page refresh or a QA-only plan setter.
  await browser.evaluate(`(() => {
    window.__CHASING_QA__.setScenario({
      player: { x: 23, y: 1 },
      chaser: { x: 6, y: 10 }
    });
    window.__CHASING_QA__.completeMission();
  })()`);
  await browser.waitFor(
    `window.__CHASING_QA__?.getState()?.game?.phase === "won"
      && Boolean(document.querySelector(".library-plan-switch"))`,
    6_000,
  );
  const resultSwitchLabel = await browser.evaluate(
    'document.querySelector(".library-plan-switch")?.textContent?.replace(/\\s+/g, " ").trim()',
  );
  assert.match(resultSwitchLabel, /消防释放/u);
  await browser.evaluate(
    'document.querySelector(".library-plan-switch").click()',
  );
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.ready
      && state.themeMission?.library?.selectedPlan?.id === "fire-release"
      && state.campaign?.exit?.x === 2
      && state.campaign?.exit?.y === 5
      && !document.querySelector(".loading-card");
  })()`, 45_000);
  const fireExpected = LIBRARY_PLAN_EXPECTATIONS["fire-release"];
  const fire = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.deepEqual(fire.campaign.exit, fireExpected.exit);
  assert.equal(fire.themeMission.audit.passed, true);
  assert.deepEqual(
    fire.themeMission.runtimeObjectives.map(({ id }) => id),
    fireExpected.objectiveIds,
  );
  assert.equal(fire.portableDecoy.formalTemplateReady, true);
  assert.equal(fire.portableDecoy.sample.inventoryRemaining, 2);
  assert.ok(fire.assets.loadedAssetIds.includes("detail:books"));
  assert.ok(
    fire.themeMission.placements.every(({ position }) => (
      Math.hypot(
        position.x - fire.themeMechanic.definition.position.x,
        position.y - fire.themeMechanic.definition.position.y,
      ) >= 2.25
    )),
    "theme mechanic still overlaps a G2 objective anchor",
  );
  const fireReady = await browser.screenshot("03-library-fire-plan-ready.png");

  // The first fire objective must pass through the real proximity,
  // interaction-edge, commitment, mission, Ghost and completion-light path.
  await browser.evaluate("window.__CHASING_QA__.start()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.phase === 'playing'",
  );
  await browser.evaluate(`window.__CHASING_QA__.setScenario({
    player: { x: 7, y: 17 },
    chaser: { x: 6, y: 10 }
  })`);
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return state?.game?.phase === "playing"
      && state.themeMission?.library?.state?.activePlanId === "fire-release"
      && state.themeMission.library.state.completedObjectiveIds.length === 0
      && state.themeMission.availableObjectiveIds?.[0] === "library:restore-egress-circuit";
  })()`);
  await browser.evaluate("window.__CHASING_QA__.interact()");
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    const animation = state?.animations?.kid;
    return state?.themeMission?.commitment?.objectiveId
        === "library:restore-egress-circuit"
      && animation?.state === "point"
      && animation.playing === true
      && animation.normalizedTime >= 0.18
      && animation.normalizedTime <= 0.72;
  })()`, 4_000);
  const fireObjectivePerformance = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assert.equal(fireObjectivePerformance.animations.kid.state, "point");
  assert.ok(fireObjectivePerformance.animations.kid.timeScale > 0);
  const firePerformance = await browser.screenshot(
    "04-library-fire-objective-performance.png",
  );
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    const completed = state?.themeMission?.library?.state?.completedObjectiveIds;
    const progress = state?.themeMission?.playerRuleProgress?.completedObjectiveIds;
    const firstView = state?.themeMission?.views?.find(
      ({ id }) => id === "library:restore-egress-circuit"
    );
    return completed?.length === 1
      && completed[0] === "library:restore-egress-circuit"
      && progress?.length === 1
      && progress[0] === "library:restore-egress-circuit"
      && firstView?.lightColor === ${COMPLETED_OBJECTIVE_LIGHT_COLOR}
      && firstView?.lightIntensity > 0;
  })()`, 6_000);
  const fireFirstInteraction = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assert.deepEqual(
    fireFirstInteraction.themeMission.library.state.completedObjectiveIds,
    [fireExpected.objectiveIds[0]],
  );
  assert.deepEqual(
    fireFirstInteraction.themeMission.library.state.unlockedExitIds,
    [],
  );
  assert.deepEqual(
    fireFirstInteraction.themeMission.playerRuleProgress.completedObjectiveIds,
    [fireExpected.objectiveIds[0]],
  );
  assert.equal(
    fireFirstInteraction.themeMission.views.find(
      ({ id }) => id === fireExpected.objectiveIds[0],
    )?.lightColor,
    COMPLETED_OBJECTIVE_LIGHT_COLOR,
  );
  const fireFirst = await browser.screenshot(
    "05-library-fire-first-objective-interacted.png",
  );

  await browser.evaluate("window.__CHASING_QA__.completeMission()");
  await browser.waitFor(completedPlanWaitExpression(fireExpected), 5_000);
  const fireCompleted = await browser.evaluate("window.__CHASING_QA__.getState()");
  assertCompletedLibraryPlan(fireCompleted, fireExpected);
  const fireComplete = await browser.screenshot("06-library-fire-plan-complete.png");

  await browser.evaluate("window.__CHASING_QA__.start()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.game?.phase === 'playing'",
  );
  await browser.evaluate(`window.__CHASING_QA__.setScenario({
    player: { x: 5, y: 5 },
    chaser: { x: 6, y: 10 }
  })`);
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.portableDecoy?.sample?.canDeploy === true",
  );
  await browser.evaluate("window.__CHASING_QA__.deployDecoy()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.portableDecoy?.views?.length === 1",
  );
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.portableDecoy?.views?.[0]?.settled === true",
    8_000,
  );
  const deployed = await browser.evaluate("window.__CHASING_QA__.getState()");
  const decoyMeshes = await browser.evaluate(
    `window.__CHASING_QA__.inspectScene().filter((object) =>
      String(object.parent).includes("portable-decoy-authored-notebook")
      || String(object.name).startsWith("Dropped_Notebook_")
    )`,
  );
  assert.equal(deployed.portableDecoy.sample.inventoryRemaining, 1);
  assert.match(
    deployed.portableDecoy.views[0].modelName,
    /portable-decoy-authored-notebook/u,
  );
  assert.equal(deployed.telemetry.decoysDeployed, 1);
  assert.equal(deployed.portableDecoy.lifecycle.thrownCount, 1);
  assert.equal(deployed.portableDecoy.lifecycle.publicSoundAcceptedCount, 1);
  assert.equal(
    deployed.portableDecoy.worldSoundDelivery.acceptedCount,
    1,
    "the deterministic simulation queue did not accept the portable source",
  );
  assert.ok(deployed.portableDecoy.sourceIds.includes(
    deployed.portableDecoy.views[0].sourceId,
  ));
  assert.ok(
    deployed.portableDecoy.sample.phase === "awaiting-investigation"
      || deployed.portableDecoy.sample.phase === "depleted",
  );
  assert.ok(decoyMeshes.length > 0, "authored notebook mesh is not render-visible");
  const authoredNotebookMaximumDimension = Math.max(
    ...decoyMeshes.map(({ size }) => Math.max(size.x, size.y, size.z)),
  );
  assert.ok(
    authoredNotebookMaximumDimension >= 0.28,
    "authored notebook is too small to read at the gameplay camera scale",
  );
  assert.ok(
    authoredNotebookMaximumDimension <= 0.45,
    "authored notebook exceeds a believable hardcover-book scale",
  );
  assert.equal(deployed.portableDecoy.views[0].viewport.centerInFrustum, true);
  assert.ok(
    Math.max(
      deployed.portableDecoy.views[0].viewport.pixelWidth,
      deployed.portableDecoy.views[0].viewport.pixelHeight,
    ) >= 8,
    "authored notebook is physically present but unreadable at gameplay resolution",
  );
  const decoy = await browser.screenshot("07-library-authored-decoy-live.png");

  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return ["go-to-last-known", "scan-last-known", "search"].includes(state?.game?.chaser?.mode)
      || (state?.telemetry?.decoyInvestigations ?? 0) >= 1;
  })()`, 8_000);
  const chase = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.ok(
    ["go-to-last-known", "scan-last-known", "search"].includes(chase.game.chaser.mode)
      || chase.telemetry.decoyInvestigations >= 1,
    "The real chaser never entered the public decoy investigation chain",
  );

  await browser.viewport(390, 844, true);
  await sleep(250);
  const mobileUi = await auditMobileControlLayout(browser);
  assertMobileControlLayout(mobileUi, "390px free movement");
  const mobile = await browser.screenshot("08-library-mobile-gameplay.png");

  await browser.viewport(1512, 982, false);
  await browser.evaluate(`window.__CHASING_QA__.setScenario({
    player: { x: 5, y: 5 },
    chaser: { x: 6, y: 10 }
  })`);
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.portableDecoy?.views?.length === 0",
  );
  await sleep(180);
  const resourceBaseline = await browser.evaluate(`(() => {
    const state = window.__CHASING_QA__.getState();
    return {
      resources: state.portableDecoy.resources,
      memory: state.render.memory,
      programs: state.render.programs
    };
  })()`);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const expectedCreated = resourceBaseline.resources.viewCreatedCount + iteration + 1;
    await browser.waitFor(
      "window.__CHASING_QA__?.getState()?.portableDecoy?.sample?.canDeploy === true",
    );
    await browser.evaluate("window.__CHASING_QA__.deployDecoy()");
    await browser.waitFor(
      `window.__CHASING_QA__?.getState()?.portableDecoy?.resources?.viewCreatedCount === ${expectedCreated}`,
    );
    await sleep(50);
    await browser.evaluate("window.__CHASING_QA__.start()");
    await browser.waitFor(`(() => {
      const decoy = window.__CHASING_QA__?.getState()?.portableDecoy;
      const resource = decoy?.resources;
      return resource?.viewDisposedCount === ${expectedCreated}
        && resource?.beaconTextureDisposedCount === ${expectedCreated}
        && resource?.beaconMaterialDisposedCount === ${expectedCreated}
        && resource?.registeredLights === 0
        && resource?.ownedBeaconMaterials === 0
        && resource?.sceneRoots === 0
        && resource?.transientPlacedAssetIds?.length === 0
        && decoy?.views?.length === 0
        && decoy?.scheduledSourceIds?.length === 0
        && decoy?.worldSoundDelivery?.authoredPending?.length === 0;
    })()`);
    await sleep(50);
  }
  await sleep(250);
  const resourceStress = await browser.evaluate(`(() => {
    const state = window.__CHASING_QA__.getState();
    return {
      resources: state.portableDecoy.resources,
      memory: state.render.memory,
      programs: state.render.programs
    };
  })()`);
  assert.equal(
    resourceStress.resources.viewCreatedCount,
    resourceStress.resources.viewDisposedCount,
  );
  assert.equal(
    resourceStress.resources.beaconTextureCreatedCount,
    resourceStress.resources.beaconTextureDisposedCount,
  );
  assert.equal(
    resourceStress.resources.beaconMaterialDisposedCount,
    resourceStress.resources.viewCreatedCount,
  );
  assert.equal(
    resourceStress.resources.resetCount,
    resourceBaseline.resources.resetCount + 20,
  );
  assert.ok(
    resourceStress.memory.textures <= resourceBaseline.memory.textures,
    `portable reset leaked textures (${resourceBaseline.memory.textures} -> ${resourceStress.memory.textures})`,
  );
  assert.ok(
    resourceStress.memory.geometries <= resourceBaseline.memory.geometries,
    `portable reset leaked geometry (${resourceBaseline.memory.geometries} -> ${resourceStress.memory.geometries})`,
  );
  assert.ok(
    resourceStress.programs <= resourceBaseline.programs,
    `portable reset leaked shader programs (${resourceBaseline.programs} -> ${resourceStress.programs})`,
  );

  const contextualMobileLayouts = [];
  let compactInteractionReady = null;
  let compactCommitment = null;
  for (const mobileViewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await browser.viewport(mobileViewport.width, mobileViewport.height, true);
    await browser.evaluate("window.__CHASING_QA__.start()");
    await browser.waitFor(
      'window.__CHASING_QA__?.getState()?.game?.phase === "playing"',
    );
    await browser.evaluate(`window.__CHASING_QA__.setScenario({
      player: { x: 7, y: 17 },
      chaser: { x: 6, y: 10 }
    })`);
    await browser.waitFor(`(() => {
      const state = window.__CHASING_QA__?.getState();
      const action = document.querySelector(".action-controls button:first-child");
      return state?.themeMission?.availableObjectiveIds
          ?.includes("library:restore-egress-circuit")
        && action?.classList.contains("available")
        && action.textContent?.includes("恢复疏散回路");
    })()`);
    const readyLayout = await auditMobileControlLayout(browser);
    assertMobileControlLayout(
      readyLayout,
      `${mobileViewport.width}px mission interaction ready`,
    );
    assert.equal(
      readyLayout.rects.interactionPrompt?.visible,
      false,
      `${mobileViewport.width}px duplicates the action verb in a center prompt`,
    );
    assert.equal(
      readyLayout.rects.viewControls?.visible,
      false,
      `${mobileViewport.width}px camera strip did not retire for interaction`,
    );
    if (mobileViewport.width === 360) {
      compactInteractionReady = await browser.screenshot(
        "09-library-mobile-compact-interaction-ready.png",
      );
    }

    await browser.evaluate("window.__CHASING_QA__.interact()");
    await browser.waitFor(`window.__CHASING_QA__?.getState()
      ?.themeMission?.commitment?.objectiveId === "library:restore-egress-circuit"`);
    const commitmentLayout = await auditMobileControlLayout(browser);
    assertMobileControlLayout(
      commitmentLayout,
      `${mobileViewport.width}px mission commitment`,
    );
    assert.equal(
      commitmentLayout.rects.viewControls?.visible,
      false,
      `${mobileViewport.width}px camera strip returned during commitment`,
    );
    assert.notEqual(
      commitmentLayout.rects.interactionPrompt?.visible,
      true,
      `${mobileViewport.width}px commitment restored the duplicate prompt`,
    );
    if (mobileViewport.width === 360) {
      compactCommitment = await browser.screenshot(
        "10-library-mobile-compact-commitment.png",
      );
    }
    contextualMobileLayouts.push({
      viewport: mobileViewport,
      ready: readyLayout,
      commitment: commitmentLayout,
    });
  }
  assert.ok(compactInteractionReady && compactCommitment);

  assert.deepEqual(browser.diagnostics, []);
  const report = {
    baseUrl: BASE_URL,
    sourceProvenance,
    screenshots: [
      accessReady,
      accessComplete,
      fireReady,
      firePerformance,
      fireFirst,
      fireComplete,
      decoy,
      mobile,
      compactInteractionReady,
      compactCommitment,
    ],
    accessPlanExit: access.campaign.exit,
    firePlanExit: fire.campaign.exit,
    firstPlayable: fire.firstPlayableBudget,
    resultRouteSwitch: {
      from: "access-authorization",
      to: "fire-release",
      label: resultSwitchLabel,
      usedPlayerFacingButton: true,
    },
    missions: {
      access: missionReport(accessCompleted),
      fireObjectivePerformance: {
        commitment: fireObjectivePerformance.themeMission.commitment,
        animation: fireObjectivePerformance.animations.kid,
      },
      fireFirstInteraction: missionReport(fireFirstInteraction),
      fire: missionReport(fireCompleted),
    },
    decoy: {
      sample: deployed.portableDecoy.sample,
      view: deployed.portableDecoy.views[0],
      meshes: decoyMeshes,
      chaserMode: chase.game.chaser.mode,
      telemetry: {
        decoysDeployed: chase.telemetry.decoysDeployed,
        decoyInvestigations: chase.telemetry.decoyInvestigations,
      },
    },
    render: deployed.render,
    mobileUi,
    contextualMobileLayouts,
    resourceStress: {
      baseline: resourceBaseline,
      afterTwentyResets: resourceStress,
    },
  };
  await writeFile(
    path.join(OUTPUT, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  browser.socket.close();
}
