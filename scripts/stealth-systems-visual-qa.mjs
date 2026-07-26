#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isThreeLoaderAssetFailure,
  protocolDiagnosticText,
} from "./qa-protocol-diagnostics.mjs";
import {
  CAPTURE_HOLD_COMMAND_TIMEOUT_MILLISECONDS,
  CAPTURE_HOLD_LEASE_MILLISECONDS,
  createRenewableCaptureHoldController,
} from "./qa-capture-hold.mjs";
import { collectQaSourceProvenance } from "./qa-source-provenance.mjs";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:3000/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-stealth-systems-visual-qa",
);
const DESKTOP_VIEWPORT = Object.freeze({
  width: 1512,
  height: 982,
  deviceScaleFactor: 1,
  mobile: false,
});
const MOBILE_VIEWPORTS = Object.freeze([
  Object.freeze({
    width: 320,
    height: 720,
    deviceScaleFactor: 1,
    mobile: true,
  }),
  Object.freeze({
    width: 360,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  }),
  Object.freeze({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  }),
]);
const TOOL_KINDS = Object.freeze([
  "door-wedge",
  "corner-mirror",
  "temporary-blackout",
]);
const TOOL_EVIDENCE_KINDS = Object.freeze({
  "door-wedge": "door-state",
  "corner-mirror": "moved-object",
  "temporary-blackout": "power-change",
});
const REPRESENTATIVE_THEME_LEVELS = Object.freeze([
  Object.freeze({ theme: "campus", levelIndex: 0 }),
  Object.freeze({ theme: "hospital", levelIndex: 3 }),
  Object.freeze({ theme: "fire-station", levelIndex: 5 }),
  Object.freeze({ theme: "factory", levelIndex: 7 }),
]);
const RESOURCE_STRESS_CYCLES = 4;
const MINIMUM_TOOL_PROJECTION_PIXELS = Object.freeze({
  width: 18,
  height: 18,
});
const MINIMUM_CORNER_MIRROR_PROJECTION_PIXELS = Object.freeze({
  width: 60,
  height: 85,
});
const MINIMUM_FOOTPRINT_PROJECTION_PIXELS = Object.freeze({
  width: 8,
  height: 6,
});
const minimumToolProjectionPixels = (tool) => (
  tool === "corner-mirror"
    ? MINIMUM_CORNER_MIRROR_PROJECTION_PIXELS
    : MINIMUM_TOOL_PROJECTION_PIXELS
);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function qaUrl() {
  const url = new URL(BASE_URL);
  url.searchParams.set("qa", "stealth-systems-visual");
  url.searchParams.set("qaQuality", "high");
  return url.href;
}

function distance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function rectanglesOverlap(left, right) {
  if (!left || !right) return false;
  return (
    Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0.5
    && Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 0.5
  );
}

function normalizedRectanglesOverlap(left, right) {
  if (!left || !right) return false;
  return (
    Math.min(left.right, right.right) > Math.max(left.left, right.left)
    && Math.min(left.bottom, right.bottom) > Math.max(left.top, right.top)
  );
}

function normalizedIntersectionRatio(left, right) {
  if (!normalizedRectanglesOverlap(left, right)) return 0;
  const intersectionWidth =
    Math.min(left.right, right.right) - Math.max(left.left, right.left);
  const intersectionHeight =
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
  const leftArea = (left.right - left.left) * (left.bottom - left.top);
  const rightArea = (right.right - right.left) * (right.bottom - right.top);
  return intersectionWidth * intersectionHeight
    / Math.max(1e-6, Math.min(leftArea, rightArea));
}

function assertMeaningfulWorldProjection(projection, label, minimumPixels) {
  assert.ok(projection, `${label} has no projected world bounds`);
  assert.equal(
    projection.centerInFrustum,
    true,
    `${label} is outside the camera frustum`,
  );
  assert.ok(
    projection.x >= 0.02
      && projection.x <= 0.98
      && projection.y >= 0.02
      && projection.y <= 0.98,
    `${label} is too close to the viewport edge to inspect`,
  );
  assert.ok(
    projection.pixelWidth >= minimumPixels.width,
    `${label} is only ${projection.pixelWidth}px wide`,
  );
  assert.ok(
    projection.pixelHeight >= minimumPixels.height,
    `${label} is only ${projection.pixelHeight}px tall`,
  );
}

function assertNonNegativeInteger(value, label) {
  assert.equal(Number.isInteger(value), true, `${label} is not an integer`);
  assert.ok(value >= 0, `${label} cannot be negative`);
}

function assertStealthArtSemantics(view, label, options) {
  assert.ok(view, `${label} has no authored 3D world view`);
  assertNonNegativeInteger(view.meshCount, `${label} meshCount`);
  assertNonNegativeInteger(view.materialCount, `${label} materialCount`);
  assertNonNegativeInteger(
    view.texturedMaterialCount,
    `${label} texturedMaterialCount`,
  );
  assert.ok(Array.isArray(view.semanticNames), `${label} has no semanticNames`);
  assert.ok(view.meshCount >= 1, `${label} contains no real mesh`);
  assert.ok(view.materialCount >= 1, `${label} contains no real material`);
  const semanticChildren = [...new Set(
    view.semanticNames.filter((name) => (
      typeof name === "string"
      && name.trim().length > 0
      && name !== view.rootName
    )),
  )];
  assert.ok(
    semanticChildren.length >= 1,
    `${label} only repeats its root name and has no semantic child`,
  );
  if (options.kind === "footprint") {
    assert.ok(
      view.texturedMaterialCount >= 1,
      `${label} is not backed by a textured material`,
    );
    assert.ok(
      semanticChildren.includes("shared-premium-footprint-pair"),
      `${label} is missing the authored paired-shoe semantic mesh`,
    );
    return;
  }
  assert.ok(
    Array.isArray(view.authoredSources),
    `${label} has no authored source provenance`,
  );
  assert.equal(
    view.authoredSources.length,
    1,
    `${label} must resolve to exactly one formal source subassembly`,
  );
  const [source] = view.authoredSources;
  assert.equal(source.fallbackUsed, false, `${label} used fallback geometry`);
  assert.ok(source.node?.trim(), `${label} has no source node`);
  assert.ok(source.label?.trim(), `${label} has no authored art label`);
  assert.ok(source.assetId?.trim(), `${label} has no source asset id`);
  assert.ok(
    typeof source.sourceUrl === "string"
      && new URL(source.sourceUrl, BASE_URL).pathname.endsWith(".glb"),
    `${label} has no formal GLB source URL`,
  );
  assert.ok(
    source.geometrySignature?.trim(),
    `${label} has no source geometry signature`,
  );
  assert.ok(
    view.texturedMaterialCount >= 1,
    `${label} is not backed by a textured PBR material`,
  );
  const authoredDeviceName = `authored-${options.tool}-device`;
  assert.ok(
    semanticChildren.includes(authoredDeviceName),
    `${label} is missing semantic child ${authoredDeviceName}`,
  );
  if (options.tool === "door-wedge") {
    assert.ok(
      semanticChildren.includes("authored-door-wedge-contact-indicator"),
      `${label} is missing its contact-state indicator`,
    );
  }
  if (options.tool === "corner-mirror") {
    const requiredParts = [
      "polished-corner-mirror-face",
      "authored-corner-mirror-rim",
      "corner-mirror-wall-plate",
      "corner-mirror-articulated-arm",
      "corner-mirror-fasteners",
      "corner-mirror-status-led",
    ];
    for (const part of requiredParts) {
      assert.ok(
        semanticChildren.includes(part),
        `${label} is missing authored hard-surface part ${part}`,
      );
    }
    assert.equal(
      source.assetId,
      "stealth-kit:corner-mirrors",
      `${label} is not sourced from the dedicated mirror kit`,
    );
    assert.equal(
      new URL(source.sourceUrl, BASE_URL).pathname,
      "/models/environment/stealth-corner-mirrors.glb",
      `${label} source is not the formal stealth mirror GLB`,
    );
    assert.match(
      source.node,
      /^(?:Campus|Hospital|FireStation|Factory)CornerMirror$/u,
      `${label} does not use a theme-specific mirror assembly`,
    );
    const partByName = new Map(
      (view.parts ?? []).map((part) => [part.name, part]),
    );
    for (const part of requiredParts) {
      assert.ok(
        partByName.has(part),
        `${label} has no QA projection/material telemetry for ${part}`,
      );
    }
    const face = partByName.get("polished-corner-mirror-face");
    const rim = partByName.get("authored-corner-mirror-rim");
    assert.ok(
      (face?.effectiveEmissive ?? Number.POSITIVE_INFINITY) <= 0.001,
      `${label} mirror face is faking readability with permanent emissive`,
    );
    assert.ok(
      (rim?.effectiveEmissive ?? Number.POSITIVE_INFINITY) <= 0.001,
      `${label} mirror rim is faking readability with permanent emissive`,
    );
    assert.ok(
      face?.metalness?.some((value) => value >= 0.82),
      `${label} mirror face lacks a physical reflective metal response`,
    );
    assert.ok(
      face?.roughness?.some((value) => value >= 0.05 && value <= 0.18),
      `${label} mirror face roughness is outside the polished-convex range`,
    );
  }
  if (options.tool === "temporary-blackout") {
    assert.ok(
      semanticChildren.includes("authored-blackout-status-lens"),
      `${label} is missing its emissive breaker status lens`,
    );
  }
}

function assertLockedRenderQuality(state, label) {
  const render = state.render;
  assert.ok(render, `${label} has no renderer telemetry`);
  assert.deepEqual(
    render.qualityLock,
    {
      enabled: true,
      requestedTier: "high",
      appliedBeforeRendererCreation: true,
    },
    `${label} did not retain the pre-renderer QA quality lock`,
  );
  assert.equal(render.qualityTier, "high", `${label} left high quality`);
  assert.equal(
    render.qualityTransitionCount,
    0,
    `${label} changed adaptive quality during isolated lifecycle QA`,
  );
  assert.equal(
    render.emergencyTransitionCount,
    0,
    `${label} entered emergency degradation during isolated lifecycle QA`,
  );
  assert.equal(
    render.emergencyDegradation.level,
    0,
    `${label} is not at emergency degradation level zero`,
  );
  assert.equal(render.shadowMapSize, 2048, `${label} changed shadow-map size`);
  assert.ok(render.pixelRatio > 0, `${label} has an invalid renderer pixel ratio`);
}

function stealthResourceSnapshot(state, label) {
  assertLockedRenderQuality(state, label);
  const resources = state.stealth?.resources;
  assert.ok(resources, `${label} is missing stealth resource telemetry`);
  assertNonNegativeInteger(
    resources.registeredLights,
    `${label} registeredLights`,
  );
  assertNonNegativeInteger(resources.sceneRoots, `${label} sceneRoots`);
  assert.ok(
    Array.isArray(resources.transientPlacedAssetIds),
    `${label} transientPlacedAssetIds is not an array`,
  );
  const snapshot = {
    renderer: {
      geometries: state.render.memory.geometries,
      textures: state.render.memory.textures,
      programs: state.render.programs,
      sceneTextures: state.render.sceneTextures,
    },
    quality: {
      tier: state.render.qualityTier,
      transitionCount: state.render.qualityTransitionCount,
      emergencyTransitionCount: state.render.emergencyTransitionCount,
      emergencyLevel: state.render.emergencyDegradation.level,
      pixelRatio: state.render.pixelRatio,
      shadowMapSize: state.render.shadowMapSize,
    },
    evidenceViews: state.stealth.evidence.views.length,
    toolViews: state.stealth.toolbelt.views.length,
    registeredLights: resources.registeredLights,
    sceneRoots: resources.sceneRoots,
    transientPlacedAssetIds: [
      ...resources.transientPlacedAssetIds,
    ].sort(),
  };
  for (const [name, count] of Object.entries(snapshot.renderer)) {
    assertNonNegativeInteger(count, `${label} renderer.${name}`);
  }
  return snapshot;
}

function assertResourcesReturnedToBaseline(baseline, current, label) {
  assert.equal(
    current.evidenceViews,
    baseline.evidenceViews,
    `${label} leaked an evidence view`,
  );
  assert.equal(
    current.toolViews,
    baseline.toolViews,
    `${label} leaked a tool view`,
  );
  assert.equal(
    current.registeredLights,
    baseline.registeredLights,
    `${label} leaked a registered light`,
  );
  assert.equal(
    current.sceneRoots,
    baseline.sceneRoots,
    `${label} leaked a transient scene root`,
  );
  assert.deepEqual(
    current.transientPlacedAssetIds,
    baseline.transientPlacedAssetIds,
    `${label} leaked a transient placed-asset id`,
  );
  assert.deepEqual(
    current.renderer,
    baseline.renderer,
    `${label} did not return renderer resources exactly to baseline`,
  );
  assert.deepEqual(
    current.quality,
    baseline.quality,
    `${label} changed quality while measuring resource lifecycle`,
  );
}

function farthestPoint(origin, candidates) {
  return [...candidates]
    .filter(Boolean)
    .sort((left, right) => distance(right, origin) - distance(left, origin))[0];
}

function publicCampaignPoints(state) {
  return [
    state.campaign.playerStart,
    state.campaign.exit,
    state.campaign.chaserStart,
    ...state.campaign.hideSpots.flatMap((spot) => [
      spot.approach,
      ...(spot.alternateExit ? [spot.alternateExit] : []),
    ]),
  ];
}

function compactToolSnapshot(state, tool) {
  const active = state.stealth.toolbelt.state.activeEffects[tool];
  const receipt = active?.receipt
    ?? [...state.stealth.toolbelt.state.receiptLedger]
      .reverse()
      .find((candidate) => candidate.tool === tool);
  return {
    tick: state.game.tick,
    tool,
    sample: state.stealth.toolbelt.sample.tools[tool],
    receipt,
    view: state.stealth.toolbelt.views.find((candidate) => candidate.tool === tool),
    playerViewport: state.visibility.kid.viewport,
    evidence: state.stealth.evidence.records.find(
      (candidate) => candidate.kind === TOOL_EVIDENCE_KINDS[tool],
    ),
  };
}

async function connect() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  assert.equal(
    response.ok,
    true,
    `Chrome target endpoint returned ${response.status}; start Chrome with --remote-debugging-port=${DEBUG_PORT}`,
  );
  const targets = await response.json();
  const pageTargets = targets.filter((entry) => (
    entry.type === "page" && !entry.url.startsWith("chrome://")
  ));
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
  let viewportState = DESKTOP_VIEWPORT;
  const pending = new Map();
  const diagnostics = [];
  const protocolEvents = [];
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
      protocolEvents.push(message);
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

  const send = (
    method,
    params = {},
    timeoutMilliseconds = 30_000,
  ) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(
        `CDP ${method} timed out after ${timeoutMilliseconds}ms`,
      ));
    }, timeoutMilliseconds);
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
    const responseValue = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (responseValue.exceptionDetails) {
      throw new Error(
        responseValue.exceptionDetails.exception?.description
          ?? responseValue.exceptionDetails.text
          ?? `Runtime evaluation failed: ${expression}`,
      );
    }
    return responseValue.result.value;
  };

  const setBrowserCaptureHold = async (
    held,
    leaseMilliseconds = CAPTURE_HOLD_LEASE_MILLISECONDS,
  ) => {
    const expression = held
      ? `(() => {
          const qa = window.__CHASING_QA__;
          const before = qa?.getStealthProbe();
          if (!qa || !before) return null;
          qa.setCaptureHold(true, ${JSON.stringify(leaseMilliseconds)});
          const after = qa.getStealthProbe();
          return {
            tick: before.tick,
            renderedFrameCount: before.captureHold.renderedFrameCount,
            leaseRemainingMilliseconds:
              after.captureHold.leaseRemainingMilliseconds
          };
        })()`
      : `(() => {
          const qa = window.__CHASING_QA__;
          if (!qa) return false;
          qa.setCaptureHold(false);
          return true;
        })()`;
    const responseValue = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, CAPTURE_HOLD_COMMAND_TIMEOUT_MILLISECONDS);
    if (responseValue.exceptionDetails) {
      throw new Error(
        responseValue.exceptionDetails.exception?.description
          ?? responseValue.exceptionDetails.text
          ?? "Capture-hold evaluation failed",
      );
    }
    const value = responseValue.result.value;
    if (held && !value) {
      throw new Error("QA capture-hold bridge is unavailable");
    }
    return value;
  };

  const waitFor = async (expression, timeout = 30_000, interval = 50) => {
    const startedAt = Date.now();
    let lastForegroundAt = 0;
    let last = null;
    while (Date.now() - startedAt <= timeout) {
      try {
        if (Date.now() - lastForegroundAt >= 500) {
          await send("Page.bringToFront");
          lastForegroundAt = Date.now();
        }
        last = await evaluate(expression);
        if (last) return last;
      } catch (error) {
        if (
          error instanceof Error
          && /^(?:CDP .+ timed out|Chrome DevTools socket)/u.test(error.message)
        ) {
          throw error;
        }
        // React intentionally replaces runtime state during scenario resets.
      }
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(last)}`);
  };

  const viewport = async (nextViewport) => {
    viewportState = nextViewport;
    await Promise.all([
      send("Emulation.setDeviceMetricsOverride", nextViewport),
      send("Emulation.setTouchEmulationEnabled", {
        enabled: nextViewport.mobile,
        maxTouchPoints: nextViewport.mobile ? 5 : 1,
      }),
      send("Page.bringToFront"),
    ]);
    await sleep(180);
  };

  const screenshot = async (name) => {
    await waitFor(`(() => {
      const assets = window.__CHASING_QA__?.getStealthProbe()?.assets;
      return assets?.decorativeReady === true
        && assets?.deferredDressingSettled === true
        && assets?.qaDecorativeSceneCompiled === true
        && assets?.qaDecorativeSceneCompileCount === 1
        && assets?.qaTransientArtPrewarmCount === 1;
    })()`, 60_000);
    const blockers = await evaluate(`({
      loadingCards: document.querySelectorAll(".loading-card, .loading-shell").length,
      loadingErrors: document.querySelectorAll(".loading-card.error, .error-card, .load-error").length,
      canvases: document.querySelectorAll(".playfield canvas").length,
      phase: window.__CHASING_QA__?.getStealthProbe()?.phase
    })`);
    assert.equal(blockers.loadingCards, 0, `${name} still has loading UI`);
    assert.equal(blockers.loadingErrors, 0, `${name} contains load error UI`);
    assert.equal(blockers.canvases, 1, `${name} must contain exactly one WebGL canvas`);
    assert.equal(blockers.phase, "playing", `${name} was not captured during real play`);
    await send("Page.bringToFront");
    const captureHold = createRenewableCaptureHoldController({
      renew: (leaseMilliseconds) => (
        setBrowserCaptureHold(true, leaseMilliseconds)
      ),
      release: () => setBrowserCaptureHold(false),
    });
    let preCapture = null;
    let result = null;
    let gpuFence = null;
    let captureError = null;
    try {
      preCapture = await captureHold.start();
      assert.ok(preCapture, `${name} has no QA capture-hold bridge`);
      await waitFor(`(() => {
        const hold = window.__CHASING_QA__?.getStealthProbe()?.captureHold;
        return hold?.requested === true
          && hold?.acknowledged === true
          && hold?.leaseRemainingMilliseconds > 0;
      })()`, 3_000);
      gpuFence = await evaluate(`new Promise((resolve) => {
        const canvas = document.querySelector(".playfield canvas");
        const gl = canvas?.getContext("webgl2");
        if (
          !gl
          || typeof gl.fenceSync !== "function"
          || typeof gl.clientWaitSync !== "function"
        ) {
          resolve({
            ready: false,
            reason: "WebGL2 sync primitives unavailable",
            waitMs: 0,
            polls: 0
          });
          return;
        }
        if (gl.isContextLost()) {
          resolve({
            ready: false,
            reason: "WebGL2 context lost before fence",
            waitMs: 0,
            polls: 0
          });
          return;
        }
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        const startedAt = performance.now();
        let settled = false;
        let polls = 0;
        const finish = (ready, reason) => {
          if (settled) return;
          settled = true;
          try {
            gl.deleteSync(sync);
          } catch {
            // Context replacement is reported by the returned readiness state.
          }
          resolve({
            ready,
            reason,
            waitMs: performance.now() - startedAt,
            polls
          });
        };
        gl.flush();
        const poll = () => {
          if (settled) return;
          polls += 1;
          if (gl.isContextLost()) {
            finish(false, "WebGL2 context lost while waiting for fence");
            return;
          }
          let status = gl.WAIT_FAILED;
          try {
            status = gl.clientWaitSync(sync, 0, 0);
          } catch {
            finish(false, "WebGL2 clientWaitSync threw");
            return;
          }
          if (
            status === gl.ALREADY_SIGNALED
            || status === gl.CONDITION_SATISFIED
          ) {
            finish(true, "signaled");
            return;
          }
          if (status === gl.WAIT_FAILED) {
            finish(false, "WebGL2 fence wait failed");
            return;
          }
          if (performance.now() - startedAt >= 1_000) {
            finish(false, "WebGL2 fence timed out");
            return;
          }
          setTimeout(poll, 16);
        };
        setTimeout(poll, 0);
      })`);
      assert.equal(
        gpuFence.ready,
        true,
        `${name} GPU fence did not settle before capture: ${JSON.stringify(gpuFence)}`,
      );
      const frozen = await evaluate(`(() => {
        const probe = window.__CHASING_QA__?.getStealthProbe();
        return probe ? {
          phase: probe.phase,
          tick: probe.tick,
          captureHold: probe.captureHold
        } : null;
      })()`);
      assert.ok(frozen, `${name} lost its QA probe while capture-held`);
      assert.equal(frozen.phase, "playing", `${name} left play before capture`);
      assert.equal(frozen.tick, preCapture.tick, `${name} simulation advanced during capture hold`);
      assert.equal(
        frozen.captureHold.renderedFrameCount,
        preCapture.renderedFrameCount,
        `${name} rendered a new WebGL frame during capture hold`,
      );
      assert.ok(
        frozen.captureHold.leaseRemainingMilliseconds > 0,
        `${name} capture hold lost its browser-side lease`,
      );
      captureHold.assertHealthy();
      result = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      }, 90_000);
      captureHold.assertHealthy();
      // Keep the presentation loop held until the full-resolution readback
      // and fast lossless PNG encoding have both returned to the client.
      await sleep(650);
      captureHold.assertHealthy();
    } catch (error) {
      captureError = error;
    }
    try {
      await captureHold.stop();
    } catch (error) {
      if (!captureError) captureError = error;
    }
    if (captureError) throw captureError;
    assert.ok(result, `${name} did not return screenshot data`);
    const liveness = await waitFor(`(() => {
      const probe = window.__CHASING_QA__?.getStealthProbe();
      if (
        !probe
        || probe.captureHold.requested
        || probe.captureHold.acknowledged
        || probe.captureHold.renderedFrameCount
          <= ${JSON.stringify(preCapture.renderedFrameCount)}
        || probe.tick <= ${JSON.stringify(preCapture.tick)}
      ) return null;
      return {
        phase: probe.phase,
        tick: probe.tick,
        renderedFrameCount: probe.captureHold.renderedFrameCount,
        canvasCount: document.querySelectorAll(".playfield canvas").length
      };
    })()`, 5_000);
    assert.equal(liveness.phase, "playing", `${name} renderer stopped after capture`);
    assert.equal(liveness.canvasCount, 1, `${name} lost its WebGL surface after capture`);
    const bytes = Buffer.from(result.data, "base64");
    const minimumBytes = viewportState.mobile ? 35_000 : 90_000;
    assert.ok(bytes.length >= minimumBytes, `${name} is suspiciously small`);
    const file = path.join(OUTPUT, name);
    await writeFile(file, bytes);
    return {
      file,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      viewport: viewportState,
      captureBackend: "cdp-browser-surface",
      gpuFence,
      resume: liveness,
    };
  };

  const dispatchKey = async (key, pressed) => {
    const upper = key.toUpperCase();
    const virtualKeyCode = upper.charCodeAt(0);
    const code = /^[0-9]$/u.test(key)
      ? `Digit${key}`
      : `Key${upper}`;
    await send("Input.dispatchKeyEvent", {
      type: pressed ? "rawKeyDown" : "keyUp",
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
    });
  };

  const tap = async (selector) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        style.display === "none"
        || style.visibility === "hidden"
        || Number(style.opacity) === 0
        || bounds.width <= 0
        || bounds.height <= 0
      ) return null;
      return {
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2
      };
    })()`);
    assert.ok(point, `cannot tap hidden or missing element ${selector}`);
    await send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{
        x: point.x,
        y: point.y,
        radiusX: 2,
        radiusY: 2,
        force: 1,
        id: 1,
      }],
    });
    await sleep(35);
    await send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };

  return {
    diagnostics,
    evaluate,
    protocolEvents,
    screenshot,
    send,
    socket,
    viewport,
    waitFor,
    dispatchKey,
    tap,
  };
}

await mkdir(OUTPUT, { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  status: "running",
  baseUrl: BASE_URL,
  qaUrl: qaUrl(),
  debugPort: DEBUG_PORT,
  output: OUTPUT,
  frameDriver: null,
  cssMotion: null,
  provenance: null,
  screenshots: [],
  scenarios: {},
  diagnostics: [],
};

let browser;
try {
  report.provenance = collectQaSourceProvenance();
  browser = await connect();
  await browser.viewport(DESKTOP_VIEWPORT);
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      if (!new URLSearchParams(location.search).has("qa")) return;
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeClearTimeout = window.clearTimeout.bind(window);
      const handles = new Map();
      let nextFrameId = 1;
      Object.defineProperty(window, "__CHASING_QA_FRAME_DRIVER__", {
        value: "timer-60hz",
        enumerable: false,
        configurable: false,
        writable: false
      });
      window.requestAnimationFrame = (callback) => {
        const frameId = nextFrameId;
        nextFrameId += 1;
        const handle = nativeSetTimeout(() => {
          handles.delete(frameId);
          callback(performance.now());
        }, 16);
        handles.set(frameId, handle);
        return frameId;
      };
      window.cancelAnimationFrame = (frameId) => {
        const handle = handles.get(frameId);
        if (handle === undefined) return;
        handles.delete(frameId);
        nativeClearTimeout(handle);
      };
      Object.defineProperty(window, "__CHASING_QA_CSS_MOTION__", {
        value: "settled",
        enumerable: false,
        configurable: false,
        writable: false
      });
      const settleCssMotion = () => {
        const style = document.createElement("style");
        style.dataset.chasingQaCssMotion = "settled";
        style.textContent = [
          "*, *::before, *::after {",
          "  animation: none !important;",
          "  transition: none !important;",
          "  scroll-behavior: auto !important;",
          "}"
        ].join("\\n");
        document.documentElement.append(style);
      };
      if (document.documentElement) settleCssMotion();
      else window.addEventListener("DOMContentLoaded", settleCssMotion, {
        once: true
      });
    })();`,
  });
  await browser.send("Page.navigate", { url: qaUrl() });
  await browser.waitFor("document.readyState === 'complete'", 20_000);
  await browser.waitFor(
    "window.__CHASING_QA__?.getStealthProbe()?.ready && !document.querySelector('.loading-card')",
    60_000,
  );
  report.frameDriver = await browser.evaluate(
    "window.__CHASING_QA_FRAME_DRIVER__ ?? 'native-raf'",
  );
  report.cssMotion = await browser.evaluate(
    "window.__CHASING_QA_CSS_MOTION__ ?? 'native'",
  );
  assert.equal(
    report.frameDriver,
    "timer-60hz",
    "deterministic QA frame driver was not installed before application boot",
  );
  assert.equal(
    report.cssMotion,
    "settled",
    "deterministic CSS motion settling was not installed before application boot",
  );
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");
  const firstReady = await browser.evaluate("window.__CHASING_QA__.getState()");
  if (firstReady.campaign.number !== 1) {
    await browser.evaluate("window.__CHASING_QA__.selectLevel(0)");
    await browser.waitFor(
      "window.__CHASING_QA__?.getStealthProbe()?.campaign?.number === 1 && window.__CHASING_QA__?.getStealthProbe()?.ready",
      60_000,
    );
  }
  await browser.waitFor(
    `(() => {
      const assets = window.__CHASING_QA__?.getStealthProbe()?.assets;
      return assets?.decorativeReady === true
        && assets.deferredDressingSettled === true
        && assets.qaDecorativeSceneCompiled === true
        && assets.qaDecorativeSceneCompileCount === 1
        && assets.qaTransientArtPrewarmCount === 1;
    })()`,
    60_000,
  );
  const initial = await browser.evaluate("window.__CHASING_QA__.getState()");
  await browser.evaluate("window.__CHASING_QA__.lockRenderQuality()");
  assertLockedRenderQuality(initial, "initial runtime");
  assert.ok(initial.stealth, "QA bridge does not expose the stealth systems");
  assert.deepEqual(
    Object.keys(initial.stealth.toolbelt.sample.tools).sort(),
    [...TOOL_KINDS].sort(),
    "QA bridge does not expose all three stealth tools",
  );
  const campaignPoints = publicCampaignPoints(initial);
  const hideAnchor = initial.campaign.hideSpots[0]?.approach
    ?? initial.campaign.playerStart;
  const hideFarChaser = farthestPoint(hideAnchor, campaignPoints);
  const startFarChaser = farthestPoint(initial.campaign.playerStart, campaignPoints);
  const mechanicAnchor = initial.themeMechanic.definition.position;
  const mechanicFarChaser = farthestPoint(mechanicAnchor, campaignPoints);

  const setScenario = async (player, chaser) => {
    await browser.evaluate(
      `window.__CHASING_QA__.setScenario(${JSON.stringify({ player, chaser })})`,
    );
    await browser.waitFor(
      `(() => {
        const state = window.__CHASING_QA__?.getStealthProbe();
        return state?.phase === "playing"
          && Math.hypot(
            state.playerPosition.x - ${player.x},
            state.playerPosition.y - ${player.y}
          ) < 0.08
          && state.tick >= 1
          && Boolean(document.querySelector(".stealth-toolbelt-status"));
      })()`,
      8_000,
    );
  };

  const waitForStealthHud = async (expectedEvidenceCount, expectedBudget) => {
    await browser.waitFor(
      `(() => {
        const text = document.querySelector(
          ".stealth-system-readout small"
        )?.textContent ?? "";
        const evidence = Number(text.match(/线索\\s*(\\d+)/u)?.[1] ?? -1);
        const budget = Number(text.match(/反侦察\\s*(\\d+)/u)?.[1] ?? -1);
        return evidence === ${expectedEvidenceCount}
          && budget === ${expectedBudget};
      })()`,
      3_000,
    );
    const snapshot = await browser.evaluate(`(() => {
      const text = document.querySelector(
        ".stealth-system-readout small"
      )?.textContent ?? "";
      return {
        text: text.trim(),
        evidenceCount: Number(text.match(/线索\\s*(\\d+)/u)?.[1] ?? -1),
        countermeasureBudget:
          Number(text.match(/反侦察\\s*(\\d+)/u)?.[1] ?? -1)
      };
    })()`);
    assert.equal(snapshot.evidenceCount, expectedEvidenceCount);
    assert.equal(snapshot.countermeasureBudget, expectedBudget);
    return snapshot;
  };

  const deployToolViaKeyboard = async (tool) => {
    const selectionKey = String(TOOL_KINDS.indexOf(tool) + 1);
    await browser.dispatchKey(selectionKey, true);
    await browser.dispatchKey(selectionKey, false);
    await browser.waitFor(
      `window.__CHASING_QA__?.getStealthProbe()?.selectedTool === ${JSON.stringify(tool)}`,
      2_000,
    );
    // Observe the authoritative conjunction inside the page. Repeated CDP
    // round-trips can outlive the 90-tick mirror on a fully decorated high
    // quality scene even though the actual runtime frames are correct. Arm
    // the observer before dispatching the real keyboard event.
    const observation = browser.send("Runtime.evaluate", {
      expression: `new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const inspect = () => {
        const qa = window.__CHASING_QA__;
        const state = qa?.getStealthProbe();
        const active = state?.activeTools?.includes(${JSON.stringify(tool)});
        const view = state?.toolViews?.find(
          (candidate) => candidate.tool === ${JSON.stringify(tool)}
        );
        if (
          active
          && view
          && state.evidenceKinds.includes(
            ${JSON.stringify(TOOL_EVIDENCE_KINDS[tool])}
          )
        ) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            resolve(qa.getState());
          }));
          return;
        }
        if (performance.now() - startedAt > 8_000) {
          const fullState = qa?.getState();
          reject(new Error(
            ${JSON.stringify(`${tool} did not produce one active effect, formal view, and public evidence snapshot`)}
            + ": " + JSON.stringify({
              phase: state?.phase ?? null,
              tick: state?.tick ?? null,
              playerPosition: state?.playerPosition ?? null,
              selectedTool: state?.selectedTool ?? null,
              activeTools: state?.activeTools ?? [],
              toolViews: state?.toolViews ?? [],
              evidenceKinds: state?.evidenceKinds ?? [],
              toolSample:
                fullState?.stealth?.toolbelt?.sample?.tools?.[
                  ${JSON.stringify(tool)}
                ] ?? null,
              playerMode: fullState?.game?.player?.mode ?? null,
              chaserMode: fullState?.game?.chaser?.mode ?? null,
              notice: document.querySelector(
                "[data-stealth-runtime-message]"
              )?.textContent?.trim() ?? null
            })
          ));
          return;
        }
        requestAnimationFrame(inspect);
      };
      inspect();
    })`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const observed = observation.then((value) => ({ value }));
    let result = null;
    for (let attempt = 1; attempt <= 3 && !result; attempt += 1) {
      await browser.dispatchKey("g", true);
      await browser.dispatchKey("g", false);
      const settled = await Promise.race([
        observed,
        sleep(350).then(() => null),
      ]);
      if (settled) result = settled.value;
    }
    if (!result) result = await observation;
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? `${tool} observer failed`,
      );
    }
    return result.result.value;
  };

  const createFootprintViaKeyboard = async () => {
    const movementDirections = ["s", "d", "w", "a"];
    let state = null;
    for (const key of movementDirections) {
      await browser.dispatchKey(key, true);
      await sleep(900);
      await browser.dispatchKey(key, false);
      await sleep(120);
      state = await browser.evaluate("window.__CHASING_QA__.getState()");
      if (
        state.stealth.evidence.records.some(
          (record) => record.kind === "footprint",
        )
      ) break;
    }
    const footprintRecords = state?.stealth.evidence.records.filter(
      (record) => record.kind === "footprint",
    ) ?? [];
    assert.ok(
      footprintRecords.length > 0,
      "real keyboard movement did not create any footprint evidence",
    );
    const nearest = [...footprintRecords].sort((left, right) => (
      distance(left.position, state.game.player.position)
        - distance(right.position, state.game.player.position)
    ))[0];
    const view = state.stealth.evidence.views.find(
      ({ id }) => id === nearest.id,
    );
    assert.ok(
      distance(nearest.position, state.game.player.position) <= 1.35,
      "movement stopped too far from the nearest erasable footprint",
    );
    assertStealthArtSemantics(
      view,
      "nearest footprint evidence view",
      { kind: "footprint" },
    );
    assertMeaningfulWorldProjection(
      view?.viewport,
      "nearest footprint evidence view",
      MINIMUM_FOOTPRINT_PROJECTION_PIXELS,
    );
    return { state, records: footprintRecords, nearest, view };
  };

  const exerciseTool = async (tool, player, chaser, screenshotName) => {
    await setScenario(player, chaser);
    const before = await browser.evaluate("window.__CHASING_QA__.getState()");
    const beforeInventory =
      before.stealth.toolbelt.sample.tools[tool].inventoryRemaining;
    const deployed = await deployToolViaKeyboard(tool);
    if (tool === "temporary-blackout") {
      await browser.waitFor(
        "document.querySelector('.playfield')?.classList.contains('stealth-blackout-active')",
        2_000,
      );
    }
    const active = tool === "temporary-blackout"
      ? await browser.evaluate("window.__CHASING_QA__.getState()")
      : deployed;
    const compact = compactToolSnapshot(active, tool);
    assert.equal(compact.sample.phase, "active", `${tool} never became active`);
    assert.equal(
      compact.sample.inventoryRemaining,
      beforeInventory - 1,
      `${tool} did not consume exactly one inventory unit`,
    );
    assert.equal(compact.receipt.tool, tool, `${tool} receipt is missing`);
    assert.equal(
      compact.receipt.riskEvidence.sourceType,
      "stealth-tool-risk",
      `${tool} did not emit public risk evidence`,
    );
    assert.equal(
      compact.evidence.kind,
      TOOL_EVIDENCE_KINDS[tool],
      `${tool} did not leave the expected world-observable trace`,
    );
    assert.ok(compact.view, `${tool} has no authored 3D world view`);
    assert.ok(compact.view.rootName, `${tool} has no named authored 3D world view`);
    assertStealthArtSemantics(
      compact.view,
      `${tool} authored 3D world view`,
      { kind: "tool", tool },
    );
    assertMeaningfulWorldProjection(
      compact.view.viewport,
      `${tool} authored 3D world view`,
      minimumToolProjectionPixels(tool),
    );
    const ui = await browser.evaluate(`(() => {
      const root = document.querySelector(".stealth-toolbelt-status");
      const buttons = [...document.querySelectorAll(
        ".stealth-tool-row button[data-stealth-tool]"
      )];
      return {
        rootVisible: Boolean(root && getComputedStyle(root).opacity !== "0"),
        buttonCount: buttons.length,
        selectedCount: buttons.filter((button) => button.getAttribute("aria-pressed") === "true").length,
        selectedTitle: buttons.find((button) => button.getAttribute("aria-pressed") === "true")?.title ?? null,
        blackoutClass: document.querySelector(".playfield")?.classList.contains("stealth-blackout-active") ?? false,
        themeMechanicHudVisible: Boolean(document.querySelector(".theme-mechanic")),
        interactionPromptText: document.querySelector(".interaction-prompt")?.textContent?.trim() ?? "",
        touchInteractionText: document.querySelector(".action-controls > button")?.textContent?.trim() ?? ""
      };
    })()`);
    assert.equal(ui.rootVisible, true, `${tool} toolbelt UI is hidden`);
    assert.equal(ui.buttonCount, 3, `${tool} toolbelt does not render all tools`);
    assert.equal(ui.selectedCount, 1, `${tool} tool selection is ambiguous`);
    if (tool === "temporary-blackout") {
      assert.equal(ui.blackoutClass, true, "temporary blackout has no runtime visual treatment");
      await browser.waitFor(
        "window.__CHASING_QA__?.getState()?.themeMechanic?.view?.beaconVisible === false",
        2_000,
      );
      const blackoutMechanicView = await browser.evaluate(
        "window.__CHASING_QA__.getState().themeMechanic.view",
      );
      assert.equal(
        blackoutMechanicView?.beaconVisible,
        false,
        "temporary blackout leaves the unrelated theme-console world prompt visible",
      );
      assert.equal(
        blackoutMechanicView?.beaconOpacity,
        0,
        "temporary blackout leaves a latent theme-console prompt opacity",
      );
      assert.equal(
        ui.themeMechanicHudVisible,
        false,
        "temporary blackout leaves the ready theme-console HUD visible",
      );
      assert.equal(
        ui.interactionPromptText.includes("启动"),
        false,
        "temporary blackout leaves the keyboard theme-console prompt visible",
      );
      assert.equal(
        ui.touchInteractionText.includes("启动机关"),
        false,
        "temporary blackout leaves the touch theme-console prompt visible",
      );
      const beforeBlockedInteraction = await browser.evaluate(
        "window.__CHASING_QA__.getState()",
      );
      assert.equal(
        beforeBlockedInteraction.themeMechanic.sample.phase,
        "ready",
        "blackout interaction arbitration requires a ready mechanic",
      );
      await browser.evaluate("window.__CHASING_QA__.interact()");
      await browser.waitFor(
        `window.__CHASING_QA__.getState().game.tick
          > ${beforeBlockedInteraction.game.tick + 1}`,
        2_000,
      );
      const afterBlockedInteraction = await browser.evaluate(
        "window.__CHASING_QA__.getState()",
      );
      assert.equal(
        afterBlockedInteraction.themeMechanic.sample.phase,
        "ready",
        "temporary blackout allowed the theme mechanic to activate",
      );
    }
    const screenshot = await browser.screenshot(screenshotName);
    report.screenshots.push(screenshot);
    if (tool === "corner-mirror") {
      const face = compact.view.parts.find(
        (part) => part.name === "polished-corner-mirror-face",
      );
      assertMeaningfulWorldProjection(
        face?.viewport,
        "corner mirror lens",
        { width: 40, height: 58 },
      );
      const actorOverlapRatio = normalizedIntersectionRatio(
        face?.viewport?.bounds,
        compact.playerViewport?.bounds,
      );
      // Axis-aligned boxes conservatively include the transparent corners of
      // both the circular lens and the human silhouette. Permit no more than
      // the tiny diagonal-corner contact verified by the visual review.
      assert.ok(
        actorOverlapRatio <= 0.05,
        `corner mirror lens overlap ratio ${actorOverlapRatio} is too high: ${JSON.stringify({
          mirror: face?.viewport?.bounds,
          player: compact.playerViewport?.bounds,
        })}`,
      );
      const lensCenterSeparationPixels = Math.hypot(
        (face.viewport.x - compact.playerViewport.x) * 1512,
        (face.viewport.y - compact.playerViewport.y) * 982,
      );
      assert.ok(
        lensCenterSeparationPixels >= 44,
        `corner mirror lens and player centers are only ${lensCenterSeparationPixels}px apart`,
      );
      const centerSeparationPixels = Math.hypot(
        (
          compact.view.viewport.x - compact.playerViewport.x
        ) * 1512,
        (
          compact.view.viewport.y - compact.playerViewport.y
        ) * 982,
      );
      assert.ok(
        centerSeparationPixels >= 48,
        `corner mirror and player centers are only ${centerSeparationPixels}px apart`,
      );
    }
    return {
      ...compact,
      ui,
      screenshot,
    };
  };

  report.scenarios.doorWedge = await exerciseTool(
    "door-wedge",
    hideAnchor,
    hideFarChaser,
    "desktop-door-wedge-active.png",
  );
  report.scenarios.cornerMirror = await exerciseTool(
    "corner-mirror",
    hideAnchor,
    hideFarChaser,
    "desktop-corner-mirror-active.png",
  );
  report.scenarios.temporaryBlackout = await exerciseTool(
    "temporary-blackout",
    mechanicAnchor,
    mechanicFarChaser,
    "desktop-temporary-blackout-active.png",
  );
  const toolArtSources = [
    report.scenarios.doorWedge,
    report.scenarios.cornerMirror,
    report.scenarios.temporaryBlackout,
  ].map((scenario) => scenario.view.authoredSources[0]);
  assert.equal(
    new Set(toolArtSources.map(({ node }) => node)).size,
    TOOL_KINDS.length,
    "the three stealth tools reuse one authored source node",
  );
  assert.equal(
    new Set(toolArtSources.map(({ geometrySignature }) => geometrySignature)).size,
    TOOL_KINDS.length,
    "the three stealth tools reuse one primary geometry signature",
  );
  report.scenarios.toolArtDistinctness = {
    sourceNodes: toolArtSources.map(({ node }) => node),
    geometrySignatures: toolArtSources.map(({ geometrySignature }) => geometrySignature),
    fallbackUsed: toolArtSources.map(({ fallbackUsed }) => fallbackUsed),
  };

  await setScenario(initial.campaign.playerStart, startFarChaser);
  const footprintSetup = await createFootprintViaKeyboard();
  const footprintState = footprintSetup.state;
  const footprintRecords = footprintSetup.records;
  const nearestFootprint = footprintSetup.nearest;
  const nearestFootprintView = footprintSetup.view;
  const beforeEraseHud = await waitForStealthHud(
    footprintRecords.length,
    footprintState.stealth.evidence.countermeasureBudgetRemaining,
  );
  const beforeEraseScreenshot = await browser.screenshot(
    "desktop-footprints-before-erase.png",
  );
  report.screenshots.push(beforeEraseScreenshot);
  const beforeErase = {
    tick: footprintState.game.tick,
    playerPosition: footprintState.game.player.position,
    recordCount: footprintRecords.length,
    recordIds: footprintRecords.map(({ id }) => id),
    nearest: nearestFootprint,
    budget: footprintState.stealth.evidence.countermeasureBudgetRemaining,
    view: nearestFootprintView,
    hud: beforeEraseHud,
    screenshot: beforeEraseScreenshot,
  };
  await browser.evaluate("window.__CHASING_QA__.eraseEvidence()");
  await browser.waitFor(
    `window.__CHASING_QA__?.getState()?.stealth?.evidence?.erasedEvidenceCount >= ${
      footprintState.stealth.evidence.erasedEvidenceCount + 1
    }`,
    3_000,
  );
  const erased = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(
    erased.stealth.evidence.records.some(({ id }) => id === nearestFootprint.id),
    false,
    "erase command left the nearest footprint in the authoritative ledger",
  );
  assert.equal(
    erased.stealth.evidence.views.some(({ id }) => id === nearestFootprint.id),
    false,
    "erase command left the nearest footprint's 3D view in the scene",
  );
  assert.ok(
    erased.stealth.evidence.countermeasureBudgetRemaining
      < footprintState.stealth.evidence.countermeasureBudgetRemaining,
    "erase command did not pay its bounded countermeasure cost",
  );
  const afterEraseHud = await waitForStealthHud(
    erased.stealth.evidence.records.length,
    erased.stealth.evidence.countermeasureBudgetRemaining,
  );
  const afterEraseScreenshot = await browser.screenshot(
    "desktop-footprints-after-erase.png",
  );
  report.screenshots.push(afterEraseScreenshot);
  report.scenarios.footprintErase = {
    before: beforeErase,
    after: {
      tick: erased.game.tick,
      erasedEvidenceCount: erased.stealth.evidence.erasedEvidenceCount,
      remainingRecordIds: erased.stealth.evidence.records.map(({ id }) => id),
      budget: erased.stealth.evidence.countermeasureBudgetRemaining,
      busyUntilTick: erased.stealth.evidence.countermeasureBusyUntilTick,
      hud: afterEraseHud,
      screenshot: afterEraseScreenshot,
    },
  };

  // The desktop tool/evidence scenarios above intentionally warm every
  // transient art/material path before the leak baseline is captured.
  await browser.waitFor(
    `(() => {
      const assets = window.__CHASING_QA__?.getStealthProbe()?.assets;
      return assets?.decorativeReady === true
        && assets.deferredDressingSettled === true
        && assets.qaDecorativeSceneCompiled === true
        && assets.qaDecorativeSceneCompileCount === 1
        && assets.qaTransientArtPrewarmCount === 1;
    })()`,
    60_000,
  );
  const waitForStealthResourceQuiescence = async () => {
    await browser.waitFor(
      `(() => {
        const probe = window.__CHASING_QA__?.getStealthProbe();
        return Boolean(probe)
          && probe.evidenceViewCount === 0
          && probe.toolViews.length === 0
          && probe.registeredStealthLights === 0;
      })()`,
      5_000,
    );
    await sleep(360);
    return browser.evaluate("window.__CHASING_QA__.getState()");
  };
  const waitForStableQuiescentResources = async (label) => {
    let previousFingerprint = null;
    let stableSamples = 0;
    let latest = null;
    let latestSnapshot = null;
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      latest = await waitForStealthResourceQuiescence();
      latestSnapshot = stealthResourceSnapshot(
        latest,
        `${label} stability sample ${attempt}`,
      );
      const fingerprint = JSON.stringify(latestSnapshot);
      if (fingerprint === previousFingerprint) stableSamples += 1;
      else {
        previousFingerprint = fingerprint;
        stableSamples = 1;
      }
      if (stableSamples >= 3) {
        return { state: latest, snapshot: latestSnapshot };
      }
      await browser.evaluate(
        "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))",
      );
    }
    throw new Error(`${label} did not produce three consecutive stable resource snapshots`);
  };
  await browser.evaluate("window.__CHASING_QA__.setDirectorEnabled(false)");
  await setScenario(initial.campaign.playerStart, startFarChaser);
  assert.equal(
    await browser.evaluate(
      "window.__CHASING_QA__.getStealthProbe().director.enabled",
    ),
    false,
    "resource lifecycle isolation did not suspend unrelated Director evidence",
  );
  const stableResourceBaseline = await waitForStableQuiescentResources(
    "warm resource baseline",
  );
  const resourceBaselineState = stableResourceBaseline.state;
  assert.equal(
    resourceBaselineState.assets.qaDecorativeSceneCompiled,
    true,
    "resource baseline was captured before the complete decorative scene compiled",
  );
  assert.equal(
    resourceBaselineState.assets.qaDecorativeSceneCompileCount,
    1,
    "resource baseline requires exactly one complete-scene compile",
  );
  assert.equal(
    resourceBaselineState.assets.qaTransientArtPrewarmCount,
    1,
    "resource baseline requires exactly one offscreen authored-art prewarm",
  );
  const resourceBaseline = stableResourceBaseline.snapshot;
  assert.deepEqual(
    {
      evidenceViews: resourceBaseline.evidenceViews,
      toolViews: resourceBaseline.toolViews,
      registeredLights: resourceBaseline.registeredLights,
      sceneRoots: resourceBaseline.sceneRoots,
      transientPlacedAssetIds: resourceBaseline.transientPlacedAssetIds,
    },
    {
      evidenceViews: 0,
      toolViews: 0,
      registeredLights: 0,
      sceneRoots: 0,
      transientPlacedAssetIds: [],
    },
    "warm resource baseline is not quiescent",
  );
  const resourceCycles = [];
  const resourceToolSetups = Object.freeze({
    "door-wedge": Object.freeze({
      player: hideAnchor,
      chaser: hideFarChaser,
    }),
    "corner-mirror": Object.freeze({
      player: hideAnchor,
      chaser: hideFarChaser,
    }),
    "temporary-blackout": Object.freeze({
      player: mechanicAnchor,
      chaser: mechanicFarChaser,
    }),
  });
  for (let cycle = 1; cycle <= RESOURCE_STRESS_CYCLES; cycle += 1) {
    const activeSnapshots = [];
    for (const tool of TOOL_KINDS) {
      const setup = resourceToolSetups[tool];
      await setScenario(setup.player, setup.chaser);
      const activeState = await deployToolViaKeyboard(tool);
      const activeView = activeState.stealth.toolbelt.views.find(
        (view) => view.tool === tool,
      );
      assertStealthArtSemantics(
        activeView,
        `resource cycle ${cycle} ${tool}`,
        { kind: "tool", tool },
      );
      activeSnapshots.push({
        tool,
        resources: stealthResourceSnapshot(
          activeState,
          `resource cycle ${cycle} ${tool} active`,
        ),
      });
      await setScenario(initial.campaign.playerStart, startFarChaser);
      await waitForStealthResourceQuiescence();
    }

    await setScenario(initial.campaign.playerStart, startFarChaser);
    const footprintCycle = await createFootprintViaKeyboard();
    await browser.evaluate("window.__CHASING_QA__.eraseEvidence()");
    await browser.waitFor(
      `window.__CHASING_QA__?.getState()
        ?.stealth?.evidence?.records?.every(
          (record) => record.id !== ${JSON.stringify(footprintCycle.nearest.id)}
        )`,
      3_000,
    );
    await setScenario(initial.campaign.playerStart, startFarChaser);
    const stableSettled = await waitForStableQuiescentResources(
      `resource cycle ${cycle} settled`,
    );
    const settled = stableSettled.snapshot;
    assertResourcesReturnedToBaseline(
      resourceBaseline,
      settled,
      `resource cycle ${cycle}`,
    );
    resourceCycles.push({
      cycle,
      active: activeSnapshots,
      erasedFootprintId: footprintCycle.nearest.id,
      settled,
    });
  }
  report.scenarios.resourceLifecycle = {
    warmup: {
      toolKinds: [...TOOL_KINDS],
      evidenceKinds: ["footprint", ...Object.values(TOOL_EVIDENCE_KINDS)],
    },
    cycles: RESOURCE_STRESS_CYCLES,
    threshold: {
      rendererGeometryGrowth: 0,
      rendererTextureGrowth: 0,
      rendererProgramGrowth: 0,
      sceneTextureGrowth: 0,
      transientViewGrowth: 0,
      registeredLightGrowth: 0,
      transientAssetGrowth: 0,
    },
    baseline: resourceBaseline,
    samples: resourceCycles,
  };

  await browser.evaluate("window.__CHASING_QA__.setDirectorEnabled(true)");
  await setScenario(initial.campaign.playerStart, startFarChaser);
  assert.equal(
    await browser.evaluate(
      "window.__CHASING_QA__.getStealthProbe().director.enabled",
    ),
    true,
    "Director was not restored after isolated resource lifecycle QA",
  );
  await browser.evaluate("window.__CHASING_QA__.completeMission()");
  await browser.waitFor(
    "window.__CHASING_QA__?.getState()?.themeMission?.state?.exitUnlocked === true",
    3_000,
  );
  await browser.waitFor(
    "window.__CHASING_QA__?.getStealthProbe()?.director?.state?.activeEvent?.phase === 'warning'",
    20_000,
    35,
  );
  const warning = await browser.evaluate(`(() => {
    const probe = window.__CHASING_QA__.getStealthProbe();
    return {
      game: { tick: probe.tick },
      stealth: { director: probe.director }
    };
  })()`);
  const warningEvent = warning.stealth.director.state.activeEvent;
  await browser.waitFor(
    `document.querySelector("[data-stealth-runtime-message]")
      ?.textContent?.trim() === ${JSON.stringify(`环境预告 · ${warningEvent.suggestion.label}`)}
      && document.querySelector("[data-stealth-runtime-message]")
        ?.dataset?.runtimeDirectorPhase === "warning"
      && document.querySelector(".playfield")?.classList.contains("director-warning")`,
    2_000,
  );
  assert.equal(warningEvent.phase, "warning");
  assert.equal(
    warningEvent.suggestion.safety.sourcePolicy,
    "public-aggregate-signals-only",
  );
  assert.equal(warningEvent.suggestion.safety.routeGuarantee, true);
  assert.ok(
    warningEvent.suggestion.safety.preservedLegalRouteIds.length
      >= warningEvent.suggestion.safety.minimumLegalRouteCount,
    "director warning did not preserve a certified completion route",
  );
  const warningScreenshot = await browser.screenshot(
    "desktop-director-warning.png",
  );
  report.screenshots.push(warningScreenshot);
  const activeObservation = await browser.send("Runtime.evaluate", {
    expression: `new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const inspect = () => {
        const probe = window.__CHASING_QA__?.getStealthProbe();
        const activeEvent = probe?.director?.state?.activeEvent;
        const runtimeMessage = document.querySelector(
          "[data-stealth-runtime-message]"
        );
        if (
          activeEvent?.phase === "active"
          && runtimeMessage?.dataset?.runtimeDirectorPhase === "active"
          && runtimeMessage.textContent?.trim()
            === \`环境事件 · \${activeEvent.suggestion.label}\`
          && document.querySelector(".playfield")?.classList.contains(
            "director-active"
          )
        ) {
          resolve({
            game: { tick: probe.tick },
            stealth: { director: probe.director }
          });
          return;
        }
        if (performance.now() - startedAt > 8_000) {
          reject(new Error(
            "director active phase and rendered warning contract did not overlap"
          ));
          return;
        }
        requestAnimationFrame(inspect);
      };
      inspect();
    })`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (activeObservation.exceptionDetails) {
    throw new Error(
      activeObservation.exceptionDetails.exception?.description
        ?? activeObservation.exceptionDetails.text
        ?? "director active observer failed",
    );
  }
  const directorActive = activeObservation.result.value;
  const activeDirectorEvent = directorActive.stealth.director.state.activeEvent;
  assert.ok(activeDirectorEvent, "director active observer returned no active event");
  assert.equal(activeDirectorEvent.suggestion.suggestionId, warningEvent.suggestion.suggestionId);
  const activeDirectorScreenshot = await browser.screenshot(
    "desktop-director-active.png",
  );
  report.screenshots.push(activeDirectorScreenshot);
  report.scenarios.director = {
    warning: {
      tick: warning.game.tick,
      tier: warning.stealth.director.state.tier,
      score: warning.stealth.director.state.score,
      activeEvent: warningEvent,
      safeTicks: warning.stealth.director.safeTicks,
      screenshot: warningScreenshot,
    },
    active: {
      tick: directorActive.game.tick,
      tier: directorActive.stealth.director.state.tier,
      score: directorActive.stealth.director.state.score,
      activeEvent: activeDirectorEvent,
      screenshot: activeDirectorScreenshot,
    },
  };

  const selectRepresentativeLevel = async ({ theme, levelIndex }) => {
    await browser.evaluate(
      `window.__CHASING_QA__.selectLevel(${levelIndex})`,
    );
    await browser.waitFor(
      `(() => {
        const state = window.__CHASING_QA__?.getStealthProbe();
        return state?.ready === true
          && state.campaign.index === ${levelIndex}
          && state.campaign.theme === ${JSON.stringify(theme)}
          && !document.querySelector(".loading-card");
      })()`,
      90_000,
    );
    await browser.waitFor(
      `(() => {
        const assets = window.__CHASING_QA__?.getStealthProbe()?.assets;
        return assets?.decorativeReady === true
          && assets.deferredDressingSettled === true
          && assets.qaDecorativeSceneCompiled === true
          && assets.qaDecorativeSceneCompileCount === 1
          && assets.qaTransientArtPrewarmCount === 1;
      })()`,
      60_000,
    );
    return browser.evaluate("window.__CHASING_QA__.getState()");
  };
  const themeVisualMatrix = [];
  for (const representative of REPRESENTATIVE_THEME_LEVELS) {
    const themeInitial = await selectRepresentativeLevel(representative);
    const themePoints = publicCampaignPoints(themeInitial);
    const themeToolViews = [];
    for (const tool of TOOL_KINDS) {
      const placement =
        themeInitial.stealth.toolbelt.qaPlacementAnchors?.[tool] ?? null;
      assert.ok(
        placement?.player && placement?.target,
        `${representative.theme} has no valid authored placement for ${tool}`,
      );
      const player = placement.player;
      const chaser = farthestPoint(player, themePoints);
      await setScenario(player, chaser);
      const toolState = await deployToolViaKeyboard(tool);
      const view = toolState.stealth.toolbelt.views.find(
        (candidate) => candidate.tool === tool,
      );
      assertStealthArtSemantics(
        view,
        `${representative.theme} ${tool} art`,
        { kind: "tool", tool },
      );
      assertMeaningfulWorldProjection(
        view?.viewport,
        `${representative.theme} ${tool} art`,
        minimumToolProjectionPixels(tool),
      );
      themeToolViews.push(view);
    }
    const themeSources = themeToolViews.map((view) => view.authoredSources[0]);
    assert.equal(
      new Set(themeSources.map(({ node }) => node)).size,
      TOOL_KINDS.length,
      `${representative.theme} reuses one authored source node across tools`,
    );
    assert.equal(
      new Set(themeSources.map(({ geometrySignature }) => geometrySignature)).size,
      TOOL_KINDS.length,
      `${representative.theme} reuses one primary geometry signature across tools`,
    );
    const footprint = await createFootprintViaKeyboard();
    const combined = footprint.state;
    const themeBlackoutActive =
      combined.stealth.toolbelt.sample.tools["temporary-blackout"].phase
      === "active";
    const toolView = combined.stealth.toolbelt.views.find(
      (view) => view.tool === "temporary-blackout",
    );
    assertStealthArtSemantics(
      toolView,
      `${representative.theme} blackout art`,
      { kind: "tool", tool: "temporary-blackout" },
    );
    assertMeaningfulWorldProjection(
      toolView?.viewport,
      `${representative.theme} blackout art`,
      MINIMUM_TOOL_PROJECTION_PIXELS,
    );
    assertStealthArtSemantics(
      footprint.view,
      `${representative.theme} footprint art`,
      { kind: "footprint" },
    );
    const themeUi = await browser.evaluate(`(() => {
      const visible = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0
          && bounds.width > 0
          && bounds.height > 0;
      };
      return {
        themeClass: document.querySelector(".playfield")
          ?.classList.contains(${JSON.stringify(`theme-${representative.theme}`)})
          ?? false,
        themeMechanicVisible: visible(".theme-mechanic"),
        stealthNoticeVisible: visible("[data-stealth-runtime-message]")
      };
    })()`);
    assert.equal(
      themeUi.themeClass,
      true,
      `${representative.theme} playfield lacks its theme class`,
    );
    assert.equal(
      themeUi.themeMechanicVisible,
      !themeBlackoutActive,
      `${representative.theme} mechanic HUD did not follow blackout arbitration`,
    );
    assert.equal(
      themeUi.stealthNoticeVisible,
      true,
      `${representative.theme} stealth notice is not visible`,
    );
    const screenshot = await browser.screenshot(
      `desktop-theme-${representative.theme}-stealth-art.png`,
    );
    report.screenshots.push(screenshot);
    themeVisualMatrix.push({
      ...representative,
      levelId: combined.campaign.id,
      levelName: combined.campaign.name,
      toolView,
      toolViews: themeToolViews,
      sourceNodes: themeSources.map(({ node }) => node),
      geometrySignatures: themeSources.map(({ geometrySignature }) => geometrySignature),
      footprintView: footprint.view,
      themeBlackoutActive,
      ui: themeUi,
      screenshot,
    });
  }
  report.scenarios.themeVisualMatrix = {
    coverage: themeVisualMatrix,
    themes: themeVisualMatrix.map(({ theme }) => theme),
  };
  report.scenarios.mobileThemeGhostNoticeCoverage = {
    status: "gap-public-qa-controls-missing",
    coveredIndividuallyByLayoutGate: [
      "theme-mechanic",
      "ghost-race-when-present",
      "stealth-mobile-notice",
    ],
    missingStableControls: [
      "install-or-select-a-ghost-recording",
      "force-simultaneous-theme-ghost-notice-state",
    ],
    reason:
      "The public QA bridge can select levels but cannot create a deterministic "
      + "ghost recording or force the three HUD states simultaneously. The QA "
      + "does not mutate localStorage or private React/runtime state.",
  };

  await selectRepresentativeLevel(REPRESENTATIVE_THEME_LEVELS[0]);
  await browser.viewport(MOBILE_VIEWPORTS.at(-1));
  await setScenario(hideAnchor, hideFarChaser);
  const beforeMobileTool = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  const beforeMobileDoorWedgeInventory =
    beforeMobileTool.stealth.toolbelt.sample.tools["door-wedge"]
      .inventoryRemaining;
  const mobileDoorWedgeSelector =
    '.stealth-tool-row button[data-stealth-tool="door-wedge"]';
  await browser.tap(mobileDoorWedgeSelector);
  await browser.waitFor(
    `window.__CHASING_QA__?.getStealthProbe()?.selectedTool === "door-wedge"
      && document.querySelector(
        ${JSON.stringify(mobileDoorWedgeSelector)}
      )?.getAttribute("aria-pressed") === "true"`,
    2_000,
  );
  await browser.waitFor(
    `document.querySelector(
      ${JSON.stringify(mobileDoorWedgeSelector)}
    )?.disabled === false`,
    2_000,
  );
  await browser.tap(mobileDoorWedgeSelector);
  await browser.waitFor(
    `window.__CHASING_QA__?.getStealthProbe()
      ?.activeTools?.includes("door-wedge") === true`,
    5_000,
  );
  const afterMobileTool = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assert.equal(
    afterMobileTool.stealth.toolbelt.sample.tools["door-wedge"]
      .inventoryRemaining,
    beforeMobileDoorWedgeInventory - 1,
    "real mobile tool taps did not deploy one door wedge",
  );
  const mobileDoorWedgeView = afterMobileTool.stealth.toolbelt.views.find(
    (view) => view.tool === "door-wedge",
  );
  assertStealthArtSemantics(
    mobileDoorWedgeView,
    "mobile door-wedge authored 3D world view",
    { kind: "tool", tool: "door-wedge" },
  );
  assertMeaningfulWorldProjection(
    mobileDoorWedgeView?.viewport,
    "mobile door-wedge authored 3D world view",
    MINIMUM_TOOL_PROJECTION_PIXELS,
  );
  report.scenarios.mobileToolTouch = {
    tool: "door-wedge",
    selectedTool: afterMobileTool.stealth.selectedTool,
    beforeInventory: beforeMobileDoorWedgeInventory,
    afterInventory:
      afterMobileTool.stealth.toolbelt.sample.tools["door-wedge"]
        .inventoryRemaining,
    receipt: afterMobileTool.stealth.toolbelt.state.activeEffects["door-wedge"]
      .receipt,
    view: mobileDoorWedgeView,
  };

  await setScenario(initial.campaign.playerStart, startFarChaser);
  const mobileFootprintSetup = await createFootprintViaKeyboard();
  const mobileFootprintState = mobileFootprintSetup.state;
  const mobileNearestFootprint = mobileFootprintSetup.nearest;
  const mobileNearestFootprintView = mobileFootprintSetup.view;
  const mobileLayouts = [];
  for (const viewport of MOBILE_VIEWPORTS) {
    await browser.viewport(viewport);
    const mobileUi = await browser.evaluate(`(() => {
      const visibleRect = (element) => {
        if (!element) return null;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        if (
          style.display === "none"
          || style.visibility === "hidden"
          || Number(style.opacity) === 0
          || bounds.width <= 0
          || bounds.height <= 0
        ) return null;
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height
        };
      };
      const rootElement = document.querySelector(".stealth-toolbelt-status");
      const toolElements = [...document.querySelectorAll(
        ".stealth-tool-row button[data-stealth-tool]"
      )];
      const commandElements = [...document.querySelectorAll(
        ".stealth-tool-row > button"
      )];
      const eraseElement = document.querySelector(
        ".stealth-tool-row > .erase-evidence-mobile"
      );
      const playfieldBounds = visibleRect(document.querySelector(".playfield"));
      const qaState = window.__CHASING_QA__?.getState();
      const playerViewport = qaState?.visibility?.kid?.viewport;
      const playerSafeFrame = (
        playfieldBounds
        && playerViewport?.centerInFrustum
      ) ? (() => {
        const centerX = playfieldBounds.left
          + playerViewport.x * playfieldBounds.width;
        const centerY = playfieldBounds.top
          + playerViewport.y * playfieldBounds.height;
        const halfWidth = Math.max(28, innerWidth * 0.09);
        const halfHeight = Math.max(46, innerHeight * 0.07);
        return {
          left: centerX - halfWidth,
          right: centerX + halfWidth,
          top: centerY - halfHeight,
          bottom: centerY + halfHeight,
          width: halfWidth * 2,
          height: halfHeight * 2
        };
      })() : null;
      const topHudCards = [
        ...document.querySelectorAll(
          ".awareness, .mission-status, .theme-mechanic, "
            + ".portable-decoy-status, .ghost-race"
        )
      ].map((element) => ({
        label: element.className,
        bounds: visibleRect(element)
      })).filter(({ bounds }) => bounds);
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        root: visibleRect(rootElement),
        joystick: visibleRect(document.querySelector(".virtual-stick")),
        actionLane: visibleRect(document.querySelector(".action-controls")),
        interactionPrompt: visibleRect(
          document.querySelector(".interaction-prompt")
        ),
        mobileNotice: visibleRect(
          document.querySelector(".stealth-mobile-notice")
        ),
        topHudCards,
        playerSafeFrame,
        toolButtonCount: toolElements.length,
        commandButtonCount: commandElements.length,
        tools: toolElements.map((button) => ({
          tool: button.dataset.stealthTool,
          bounds: visibleRect(button)
        })),
        commands: commandElements.map((button) => ({
          label: button.getAttribute("aria-label") ?? button.title,
          bounds: visibleRect(button)
        })),
        erase: {
          bounds: visibleRect(eraseElement),
          disabled: eraseElement?.disabled ?? null,
          ariaLabel: eraseElement?.getAttribute("aria-label") ?? null
        },
        readoutDisplay: getComputedStyle(
          document.querySelector(".stealth-system-readout")
        ).display,
        canvasCount: document.querySelectorAll(".playfield canvas").length,
        selectedToolTitle: document.querySelector(
          ".stealth-tool-row button[aria-pressed='true']"
        )?.title ?? null
      };
    })()`);
    assert.ok(mobileUi.root, `${viewport.width}px mobile toolbelt is missing`);
    assert.equal(
      mobileUi.toolButtonCount,
      3,
      `${viewport.width}px mobile toolbelt does not expose all tools`,
    );
    assert.equal(
      mobileUi.commandButtonCount,
      4,
      `${viewport.width}px mobile toolbelt does not expose independent erase`,
    );
    assert.equal(
      mobileUi.readoutDisplay,
      "none",
      `${viewport.width}px compact layout unexpectedly exposes desktop readout`,
    );
    assert.ok(
      mobileUi.erase.bounds,
      `${viewport.width}px pure-touch layout hides the erase command`,
    );
    assert.ok(
      mobileUi.mobileNotice,
      `${viewport.width}px pure-touch layout hides the stealth notice`,
    );
    assert.match(
      mobileUi.erase.ariaLabel ?? "",
      /抹除附近公开线索/,
      `${viewport.width}px erase command has no accessible name`,
    );
    assert.equal(
      mobileUi.erase.disabled,
      false,
      `${viewport.width}px pure-touch erase command is not actionable near evidence`,
    );
    assert.ok(
      mobileUi.root.left >= -1
        && mobileUi.root.right <= mobileUi.viewport.width + 1,
      `${viewport.width}px mobile toolbelt overflows horizontally`,
    );
    assert.ok(
      mobileUi.root.top >= -1
        && mobileUi.root.bottom <= mobileUi.viewport.height + 1,
      `${viewport.width}px mobile toolbelt overflows vertically`,
    );
    assert.ok(
      mobileUi.documentWidth <= mobileUi.viewport.width + 1,
      `${viewport.width}px mobile game creates horizontal page scrolling`,
    );
    assert.ok(
      mobileUi.commands.every(({ bounds }) => (
        bounds && bounds.width >= 44 && bounds.height >= 44
      )),
      `${viewport.width}px stealth command misses the 44px touch target`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.root, mobileUi.joystick),
      false,
      `${viewport.width}px toolbelt overlaps the left joystick`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.root, mobileUi.actionLane),
      false,
      `${viewport.width}px toolbelt overlaps the right action lane`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.root, mobileUi.interactionPrompt),
      false,
      `${viewport.width}px toolbelt overlaps the interaction prompt`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.root, mobileUi.playerSafeFrame),
      false,
      `${viewport.width}px toolbelt overlaps the player safety frame`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.mobileNotice, mobileUi.joystick),
      false,
      `${viewport.width}px stealth notice overlaps the left joystick`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.mobileNotice, mobileUi.actionLane),
      false,
      `${viewport.width}px stealth notice overlaps the right action lane`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.mobileNotice, mobileUi.interactionPrompt),
      false,
      `${viewport.width}px stealth notice overlaps the interaction prompt`,
    );
    assert.equal(
      rectanglesOverlap(mobileUi.mobileNotice, mobileUi.playerSafeFrame),
      false,
      `${viewport.width}px stealth notice overlaps the player safety frame`,
    );
    for (const card of mobileUi.topHudCards) {
      assert.equal(
        rectanglesOverlap(mobileUi.root, card.bounds),
        false,
        `${viewport.width}px toolbelt overlaps top HUD card ${card.label}`,
      );
      assert.equal(
        rectanglesOverlap(mobileUi.mobileNotice, card.bounds),
        false,
        `${viewport.width}px stealth notice overlaps top HUD card ${card.label}`,
      );
    }
    const screenshot = await browser.screenshot(
      `mobile-stealth-toolbelt-${viewport.width}.png`,
    );
    report.screenshots.push(screenshot);
    mobileLayouts.push({ viewport, ui: mobileUi, screenshot });
  }
  await browser.tap(".erase-evidence-mobile");
  await browser.waitFor(
    `window.__CHASING_QA__?.getState()?.stealth?.evidence?.erasedEvidenceCount >= ${
      mobileFootprintState.stealth.evidence.erasedEvidenceCount + 1
    }`,
    3_000,
  );
  const mobileErasedState = await browser.evaluate(
    "window.__CHASING_QA__.getState()",
  );
  assert.equal(
    mobileErasedState.stealth.evidence.records.some(
      ({ id }) => id === mobileNearestFootprint.id,
    ),
    false,
    "pure-touch erase left its nearby footprint in the authoritative ledger",
  );
  report.scenarios.mobile = {
    layouts: mobileLayouts,
    touchErase: {
      evidenceId: mobileNearestFootprint.id,
      evidenceView: mobileNearestFootprintView,
      beforeCount: mobileFootprintState.stealth.evidence.records.length,
      afterCount: mobileErasedState.stealth.evidence.records.length,
      erasedEvidenceCount:
        mobileErasedState.stealth.evidence.erasedEvidenceCount,
    },
    stealth: compactToolSnapshot(
      mobileErasedState,
      "door-wedge",
    ),
  };

  await sleep(250);
  report.diagnostics = browser.diagnostics;
  assert.deepEqual(
    report.diagnostics,
    [],
    "browser emitted a runtime exception or console/log error",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
  if (browser) report.diagnostics = browser.diagnostics;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(OUTPUT, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (browser) browser.socket.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
