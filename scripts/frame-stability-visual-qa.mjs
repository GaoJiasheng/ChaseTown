#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { collectQaSourceProvenance } from "./qa-source-provenance.mjs";

const BASE_URL = process.env.CHASING_QA_URL ?? "http://127.0.0.1:3000/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-frame-stability-visual-qa",
);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRE_DIST_PROVENANCE =
  process.env.CHASING_STABILITY_REQUIRE_DIST === "1";
const SAMPLE_COUNT = Math.max(
  20,
  Math.min(30, Number(process.env.CHASING_STABILITY_SAMPLES ?? 24)),
);
const VIEWPORT = Object.freeze({
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
const ANALYSIS_WIDTH = 384;
const FRAME_MILLISECONDS = 1_000 / 60;
const ALL_THEMES = Object.freeze([
  Object.freeze({ id: "campus", levelIndex: 0 }),
  Object.freeze({ id: "hospital", levelIndex: 3 }),
]);
const REQUESTED_THEME_IDS = new Set(
  String(process.env.CHASING_STABILITY_THEMES ?? "campus,hospital")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const THEMES = Object.freeze(
  ALL_THEMES.filter(({ id }) => REQUESTED_THEME_IDS.has(id)),
);
assert.ok(THEMES.length, "CHASING_STABILITY_THEMES selected no supported theme");
const VARIANTS = Object.freeze([
  Object.freeze({ id: "default", cutoutDisabled: false }),
  Object.freeze({ id: "no-camera-cutout", cutoutDisabled: true }),
]);
const MOVE_DIRECTIONS = Object.freeze([
  Object.freeze({ key: "w", code: "KeyW", virtualKeyCode: 87, x: -0.505719, y: 0.862698 }),
  Object.freeze({ key: "s", code: "KeyS", virtualKeyCode: 83, x: 0.505719, y: -0.862698 }),
  Object.freeze({ key: "a", code: "KeyA", virtualKeyCode: 65, x: 0.862698, y: 0.505719 }),
  Object.freeze({ key: "d", code: "KeyD", virtualKeyCode: 68, x: -0.862698, y: -0.505719 }),
]);
const DYNAMIC_SCENE_NAME =
  /(?:character|kid|villain|police|ghost|actor|atmosphere|particle|sight-obscurer|stealth-evidence|footprint|portable-decoy|stealth-tool)/iu;
const HIGH_QUALITY_LIGHT_CAPACITY = 5;
const SHADOW_FRUSTUM_METERS = 36;
const SHADOW_FOLLOW_OFFSET = Object.freeze({ x: 14, y: 28, z: 18 });
const FLASH_FRAME_THRESHOLDS = Object.freeze({
  wholeFrameStrongRatio: 0.52,
  wholeFrameAffectedTileRatio: 0.75,
  wholeFrameMeanDifference: 8,
  coherentBrightnessMeanDelta: 6,
  coherentBrightnessModerateRatio: 0.65,
  coherentBrightnessRatio: 0.62,
  coherentBrightnessDirectionality: 0.82,
});
const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

/*
 * Browser time is automatic while assets load, then becomes manually stepped
 * for the probe. This preserves the real renderer and shader stack while
 * making every sampled gameplay frame one exact 60 Hz advance.
 */
const QA_FRAME_DRIVER_SOURCE = `(() => {
  if (!new URLSearchParams(location.search).has("qa")) return;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  const callbacks = new Map();
  const timers = new Map();
  let nextId = 1;
  let automatic = true;
  let clock = performance.now();
  const frameMilliseconds = ${FRAME_MILLISECONDS};

  const invoke = (id) => {
    const callback = callbacks.get(id);
    if (!callback) return;
    callbacks.delete(id);
    const timer = timers.get(id);
    if (timer !== undefined) nativeClearTimeout(timer);
    timers.delete(id);
    clock += frameMilliseconds;
    callback(clock);
  };
  const schedule = (id) => {
    if (!automatic || timers.has(id) || !callbacks.has(id)) return;
    timers.set(id, nativeSetTimeout(() => invoke(id), 16));
  };
  window.requestAnimationFrame = (callback) => {
    const id = nextId++;
    callbacks.set(id, callback);
    schedule(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    callbacks.delete(id);
    const timer = timers.get(id);
    if (timer !== undefined) nativeClearTimeout(timer);
    timers.delete(id);
  };
  Object.defineProperty(window, "__CHASING_QA_FRAME_DRIVER__", {
    configurable: true,
    value: "manual-60hz-capable",
  });
  Object.defineProperty(window, "__CHASING_QA_FRAME_CONTROL__", {
    configurable: true,
    value: Object.freeze({
      pause() {
        automatic = false;
        for (const timer of timers.values()) nativeClearTimeout(timer);
        timers.clear();
        return { automatic, pending: callbacks.size, clock };
      },
      resume() {
        automatic = true;
        for (const id of callbacks.keys()) schedule(id);
        return { automatic, pending: callbacks.size, clock };
      },
      step(count = 1) {
        if (automatic) throw new Error("pause the QA frame driver before stepping");
        const bounded = Math.max(1, Math.min(240, Math.floor(count)));
        for (let frame = 0; frame < bounded; frame += 1) {
          const frameCallbacks = [...callbacks.entries()];
          callbacks.clear();
          clock += frameMilliseconds;
          for (const [id, callback] of frameCallbacks) {
            const timer = timers.get(id);
            if (timer !== undefined) nativeClearTimeout(timer);
            timers.delete(id);
            callback(clock);
          }
        }
        return { automatic, pending: callbacks.size, clock };
      },
      status() {
        return { automatic, pending: callbacks.size, clock };
      },
    }),
  });

  const settleCssMotion = () => {
    const style = document.createElement("style");
    style.dataset.chasingQaCssMotion = "settled";
    style.textContent =
      "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}";
    document.documentElement.append(style);
  };
  if (document.documentElement) settleCssMotion();
  else window.addEventListener("DOMContentLoaded", settleCssMotion, { once: true });
})();`;

function rounded(value, places = 4) {
  const scale = 10 ** places;
  return Math.round(Number(value) * scale) / scale;
}

function materialSignature(object) {
  return [...(object.materials ?? [])].map(String).sort().join(",");
}

function isDynamicSceneObject(object) {
  return DYNAMIC_SCENE_NAME.test(`${object.name ?? ""} ${object.parent ?? ""}`);
}

function sceneObjectSignature(object) {
  return [
    object.name ?? "",
    object.parent ?? "",
    materialSignature(object),
    rounded(object.center?.x),
    rounded(object.center?.y),
    rounded(object.center?.z),
    rounded(object.size?.x),
    rounded(object.size?.y),
    rounded(object.size?.z),
  ].join("|");
}

export function staticSceneSignature(objects) {
  return objects
    .filter((object) => !isDynamicSceneObject(object))
    .map(sceneObjectSignature)
    .sort();
}

function intervalOverlap(firstCenter, firstSize, secondCenter, secondSize) {
  const firstMinimum = firstCenter - firstSize / 2;
  const firstMaximum = firstCenter + firstSize / 2;
  const secondMinimum = secondCenter - secondSize / 2;
  const secondMaximum = secondCenter + secondSize / 2;
  return Math.max(
    0,
    Math.min(firstMaximum, secondMaximum)
      - Math.max(firstMinimum, secondMinimum),
  );
}

export function detectLikelyCoplanarDuplicates(objects) {
  const staticObjects = objects.filter((object) => !isDynamicSceneObject(object));
  const exactGroups = new Map();
  for (const object of staticObjects) {
    const signature = sceneObjectSignature(object);
    const group = exactGroups.get(signature) ?? [];
    group.push(object);
    exactGroups.set(signature, group);
  }
  const exact = [...exactGroups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([signature, group]) => ({
      signature,
      count: group.length,
      name: group[0].name ?? "",
      parent: group[0].parent ?? "",
      materials: group[0].materials ?? [],
      center: group[0].center,
      size: group[0].size,
    }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 24);

  const planar = [];
  const axes = ["x", "y", "z"];
  for (let firstIndex = 0; firstIndex < staticObjects.length; firstIndex += 1) {
    const first = staticObjects[firstIndex];
    const firstSizes = axes.map((axis) => Number(first.size?.[axis] ?? Number.POSITIVE_INFINITY));
    const firstThinAxis = firstSizes.indexOf(Math.min(...firstSizes));
    if (firstSizes[firstThinAxis] > 0.06) continue;
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < staticObjects.length;
      secondIndex += 1
    ) {
      const second = staticObjects[secondIndex];
      if (materialSignature(first) !== materialSignature(second)) continue;
      const secondSizes = axes.map((axis) => Number(second.size?.[axis] ?? Number.POSITIVE_INFINITY));
      const secondThinAxis = secondSizes.indexOf(Math.min(...secondSizes));
      if (firstThinAxis !== secondThinAxis || secondSizes[secondThinAxis] > 0.06) continue;
      const thinAxis = axes[firstThinAxis];
      if (
        Math.abs(Number(first.center?.[thinAxis]) - Number(second.center?.[thinAxis]))
          > 0.006
      ) continue;
      const surfaceAxes = axes.filter((axis) => axis !== thinAxis);
      const overlapA = intervalOverlap(
        Number(first.center?.[surfaceAxes[0]]),
        Number(first.size?.[surfaceAxes[0]]),
        Number(second.center?.[surfaceAxes[0]]),
        Number(second.size?.[surfaceAxes[0]]),
      );
      const overlapB = intervalOverlap(
        Number(first.center?.[surfaceAxes[1]]),
        Number(first.size?.[surfaceAxes[1]]),
        Number(second.center?.[surfaceAxes[1]]),
        Number(second.size?.[surfaceAxes[1]]),
      );
      const smallerSurface = Math.min(
        Number(first.size?.[surfaceAxes[0]]) * Number(first.size?.[surfaceAxes[1]]),
        Number(second.size?.[surfaceAxes[0]]) * Number(second.size?.[surfaceAxes[1]]),
      );
      const overlapRatio = smallerSurface > 1e-8
        ? (overlapA * overlapB) / smallerSurface
        : 0;
      if (overlapRatio < 0.94) continue;
      planar.push({
        thinAxis,
        overlapRatio: rounded(overlapRatio),
        first: {
          name: first.name ?? "",
          parent: first.parent ?? "",
          center: first.center,
          size: first.size,
        },
        second: {
          name: second.name ?? "",
          parent: second.parent ?? "",
          center: second.center,
          size: second.size,
        },
        materials: first.materials ?? [],
      });
      if (planar.length >= 24) break;
    }
    if (planar.length >= 24) break;
  }
  return { exact, planar };
}

function actorMasks(previousState, currentState) {
  const masks = [];
  for (const state of [previousState, currentState]) {
    for (const actor of ["kid", "villain", "police"]) {
      const sample = state?.visibility?.[actor]?.viewport;
      if (!sample?.centerInFrustum) continue;
      masks.push({
        x: Number(sample.x),
        y: Number(sample.y),
        radiusX: actor === "kid" ? 0.055 : 0.065,
        radiusY: actor === "kid" ? 0.13 : 0.15,
      });
    }
  }
  return masks;
}

function isMasked(x, y, width, height, masks) {
  const normalizedX = x / width;
  const normalizedY = y / height;
  return masks.some((mask) => {
    const dx = (normalizedX - mask.x) / mask.radiusX;
    const dy = (normalizedY - mask.y) / mask.radiusY;
    return dx * dx + dy * dy <= 1;
  });
}

function candidateShiftError(previous, current, width, height, dx, dy, masks) {
  let error = 0;
  let count = 0;
  for (let y = 2; y < height - 2; y += 2) {
    const shiftedY = y + dy;
    if (shiftedY < 0 || shiftedY >= height) continue;
    for (let x = 2; x < width - 2; x += 2) {
      const shiftedX = x + dx;
      if (shiftedX < 0 || shiftedX >= width) continue;
      if (isMasked(x, y, width, height, masks)) continue;
      error += Math.abs(
        previous[y * width + x] - current[shiftedY * width + shiftedX],
      );
      count += 1;
    }
  }
  return count ? error / count : Number.POSITIVE_INFINITY;
}

export function analyzeFramePair(previous, current, options = {}) {
  const { width, height } = previous;
  assert.equal(current.width, width, "analysis frame width changed");
  assert.equal(current.height, height, "analysis frame height changed");
  const masks = options.masks ?? [];
  let best = { dx: 0, dy: 0, error: Number.POSITIVE_INFINITY };
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const error = candidateShiftError(
        previous.pixels,
        current.pixels,
        width,
        height,
        dx,
        dy,
        masks,
      );
      const shiftMagnitude = Math.abs(dx) + Math.abs(dy);
      const bestMagnitude = Math.abs(best.dx) + Math.abs(best.dy);
      if (
        error < best.error - 1e-9
        || (Math.abs(error - best.error) <= 1e-9 && shiftMagnitude < bestMagnitude)
      ) best = { dx, dy, error };
    }
  }

  const tileColumns = 12;
  const tileRows = 8;
  const tileChanged = new Uint32Array(tileColumns * tileRows);
  const tileSamples = new Uint32Array(tileColumns * tileRows);
  const residual = Buffer.alloc(width * height);
  let samples = 0;
  let absolute = 0;
  let signedLuma = 0;
  let moderate = 0;
  let positiveModerate = 0;
  let negativeModerate = 0;
  let strong = 0;
  let severe = 0;
  const hasColor = (
    previous.colorPixels?.length === width * height * 3
    && current.colorPixels?.length === width * height * 3
  );
  for (let y = 0; y < height; y += 1) {
    const shiftedY = y + best.dy;
    if (shiftedY < 0 || shiftedY >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const shiftedX = x + best.dx;
      if (shiftedX < 0 || shiftedX >= width) continue;
      if (isMasked(x, y, width, height, masks)) continue;
      const previousIndex = y * width + x;
      const currentIndex = shiftedY * width + shiftedX;
      const lumaDifference =
        current.pixels[currentIndex] - previous.pixels[previousIndex];
      let difference = Math.abs(lumaDifference);
      if (hasColor) {
        const previousColorIndex = previousIndex * 3;
        const currentColorIndex = currentIndex * 3;
        difference = Math.max(
          Math.abs(
            previous.colorPixels[previousColorIndex]
              - current.colorPixels[currentColorIndex],
          ),
          Math.abs(
            previous.colorPixels[previousColorIndex + 1]
              - current.colorPixels[currentColorIndex + 1],
          ),
          Math.abs(
            previous.colorPixels[previousColorIndex + 2]
              - current.colorPixels[currentColorIndex + 2],
          ),
        );
      }
      residual[y * width + x] = difference;
      absolute += difference;
      signedLuma += lumaDifference;
      samples += 1;
      const tileX = Math.min(tileColumns - 1, Math.floor(x / width * tileColumns));
      const tileY = Math.min(tileRows - 1, Math.floor(y / height * tileRows));
      const tileIndex = tileY * tileColumns + tileX;
      tileSamples[tileIndex] += 1;
      if (lumaDifference >= 8) {
        moderate += 1;
        positiveModerate += 1;
      } else if (lumaDifference <= -8) {
        moderate += 1;
        negativeModerate += 1;
      }
      if (difference >= 18) {
        strong += 1;
        tileChanged[tileIndex] += 1;
      }
      if (difference >= 42) severe += 1;
    }
  }
  let affectedTiles = 0;
  for (let index = 0; index < tileChanged.length; index += 1) {
    if (tileSamples[index] && tileChanged[index] / tileSamples[index] >= 0.08) {
      affectedTiles += 1;
    }
  }
  return {
    shift: { dx: best.dx, dy: best.dy },
    alignmentError: rounded(best.error, 5),
    meanAbsoluteDifference: rounded(samples ? absolute / samples : 0, 5),
    meanSignedLumaDifference: rounded(samples ? signedLuma / samples : 0, 5),
    moderateChangedRatio: rounded(samples ? moderate / samples : 0, 6),
    coherentModerateRatio: rounded(
      samples ? Math.max(positiveModerate, negativeModerate) / samples : 0,
      6,
    ),
    directionalModerateCoherence: rounded(
      moderate ? Math.max(positiveModerate, negativeModerate) / moderate : 0,
      6,
    ),
    strongChangedRatio: rounded(samples ? strong / samples : 0, 6),
    severeChangedRatio: rounded(samples ? severe / samples : 0, 6),
    affectedTileRatio: rounded(affectedTiles / tileChanged.length, 6),
    residual,
  };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * ratio)),
  )];
}

export function summarizePairMetrics(metrics) {
  const strongRatios = metrics.map(({ strongChangedRatio }) => strongChangedRatio);
  const severeRatios = metrics.map(({ severeChangedRatio }) => severeChangedRatio);
  const affectedTiles = metrics.map(({ affectedTileRatio }) => affectedTileRatio);
  const meanDifferences = metrics.map(({ meanAbsoluteDifference }) => meanAbsoluteDifference);
  const signedLumaDifferences = metrics.map(
    ({ meanSignedLumaDifference = 0 }) => Math.abs(meanSignedLumaDifference),
  );
  const moderateRatios = metrics.map(
    ({ moderateChangedRatio = 0 }) => moderateChangedRatio,
  );
  const coherentRatios = metrics.map(
    ({ coherentModerateRatio = 0 }) => coherentModerateRatio,
  );
  const directionalCoherences = metrics.map(
    ({ directionalModerateCoherence = 0 }) => directionalModerateCoherence,
  );
  const strongMedian = percentile(strongRatios, 0.5);
  const strongMaximum = Math.max(0, ...strongRatios);
  return {
    pairCount: metrics.length,
    meanDifferenceMedian: rounded(percentile(meanDifferences, 0.5), 6),
    meanDifferenceP95: rounded(percentile(meanDifferences, 0.95), 6),
    absoluteMeanSignedLumaDifferenceP95: rounded(
      percentile(signedLumaDifferences, 0.95),
      6,
    ),
    moderateChangedRatioP95: rounded(percentile(moderateRatios, 0.95), 6),
    coherentModerateRatioP95: rounded(percentile(coherentRatios, 0.95), 6),
    directionalModerateCoherenceP95: rounded(
      percentile(directionalCoherences, 0.95),
      6,
    ),
    strongChangedRatioMedian: rounded(strongMedian, 6),
    strongChangedRatioP95: rounded(percentile(strongRatios, 0.95), 6),
    strongChangedRatioMaximum: rounded(strongMaximum, 6),
    severeChangedRatioP95: rounded(percentile(severeRatios, 0.95), 6),
    affectedTileRatioP95: rounded(percentile(affectedTiles, 0.95), 6),
    temporalSpikeRatio: rounded(
      strongMedian > 1e-6
        ? strongMaximum / strongMedian
        : strongMaximum >= 0.001
          ? 999
          : 1,
      4,
    ),
  };
}

export function auditProbePixelStability(pairMetrics, { moving = false } = {}) {
  const summary = summarizePairMetrics(pairMetrics);
  const flashFrames = pairMetrics.flatMap((metric, index) => {
    const findings = [];
    if (
      metric.strongChangedRatio >= FLASH_FRAME_THRESHOLDS.wholeFrameStrongRatio
      && metric.affectedTileRatio
        >= FLASH_FRAME_THRESHOLDS.wholeFrameAffectedTileRatio
      && metric.meanAbsoluteDifference
        >= FLASH_FRAME_THRESHOLDS.wholeFrameMeanDifference
    ) {
      findings.push("whole-frame-material-flash");
    }
    if (
      Math.abs(metric.meanSignedLumaDifference ?? 0)
        >= FLASH_FRAME_THRESHOLDS.coherentBrightnessMeanDelta
      && (metric.moderateChangedRatio ?? 0)
        >= FLASH_FRAME_THRESHOLDS.coherentBrightnessModerateRatio
      && (metric.coherentModerateRatio ?? 0)
        >= FLASH_FRAME_THRESHOLDS.coherentBrightnessRatio
      && (metric.directionalModerateCoherence ?? 0)
        >= FLASH_FRAME_THRESHOLDS.coherentBrightnessDirectionality
    ) {
      findings.push("coherent-full-frame-brightness-flash");
    }
    return findings.length
      ? [{
          frame: metric.frame ?? index + 2,
          findings,
          metric: serializablePairMetric(metric),
        }]
      : [];
  });
  const staticFlashFrames = moving ? [] : flashFrames;
  const staticUnexpected = !moving && (
    summary.strongChangedRatioP95 > 0.018
    || (
      summary.affectedTileRatioP95 > 0.22
      && summary.strongChangedRatioP95 > 0.006
    )
    // P95 intentionally characterizes sustained shimmer, but with 23 frame
    // pairs it can discard one or two isolated flashes. A single whole-frame
    // material or coherent brightness discontinuity is still a release
    // failure in a stationary probe.
    || staticFlashFrames.length > 0
  );
  const movingFlashFrames = moving ? flashFrames : [];
  return {
    summary,
    staticUnexpected,
    staticFlashFrames,
    movingUnexpected: movingFlashFrames.length > 0,
    movingFlashFrames,
  };
}

function serializablePairMetric(metric) {
  return {
    frame: metric.frame,
    shift: metric.shift,
    alignmentError: metric.alignmentError,
    meanAbsoluteDifference: metric.meanAbsoluteDifference,
    meanSignedLumaDifference: metric.meanSignedLumaDifference,
    moderateChangedRatio: metric.moderateChangedRatio,
    coherentModerateRatio: metric.coherentModerateRatio,
    directionalModerateCoherence: metric.directionalModerateCoherence,
    strongChangedRatio: metric.strongChangedRatio,
    severeChangedRatio: metric.severeChangedRatio,
    affectedTileRatio: metric.affectedTileRatio,
  };
}

function qaUrl(theme, variant) {
  const url = new URL(BASE_URL);
  url.searchParams.set("qa", `frame-stability-${theme.id}-${variant.id}`);
  url.searchParams.set("qaQuality", "high");
  if (variant.cutoutDisabled) url.searchParams.set("no-camera-cutout", "1");
  return url.href;
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
  const pageTargets = targets.filter((entry) => (
    entry.type === "page" && !entry.url.startsWith("chrome://")
  ));
  assert.equal(
    pageTargets.length,
    1,
    `frame-stability QA requires one dedicated page target; found ${pageTargets.length}`,
  );
  const [target] = pageTargets;
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
      if (message.method === "Runtime.consoleAPICalled") {
        const type = message.params.type;
        if (type === "error" || type === "warning") {
          diagnostics.push({
            kind: `console-${type}`,
            text: message.params.args.map((argument) => (
              argument.value
              ?? argument.description
              ?? argument.unserializableValue
              ?? argument.type
            )).join(" "),
          });
        }
      } else if (message.method === "Runtime.exceptionThrown") {
        diagnostics.push({
          kind: "runtime",
          text: message.params.exceptionDetails?.exception?.description
            ?? message.params.exceptionDetails?.text
            ?? "runtime exception",
        });
      } else if (message.method === "Log.entryAdded") {
        const entry = message.params.entry;
        if (entry.level === "error") {
          diagnostics.push({ kind: "log", text: entry.text, url: entry.url });
        }
      } else if (message.method === "Network.loadingFailed") {
        diagnostics.push({
          kind: "network",
          text: message.params.errorText,
          requestId: message.params.requestId,
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

  async function waitFor(expression, timeout = 60_000, interval = 80) {
    const started = Date.now();
    let lastValue = false;
    let lastError = null;
    while (Date.now() - started <= timeout) {
      try {
        lastValue = await evaluate(expression);
        lastError = null;
      } catch (error) {
        lastValue = false;
        lastError = error;
      }
      if (lastValue) return lastValue;
      await sleep(interval);
    }
    const detail = lastError instanceof Error ? `; ${lastError.message}` : "";
    throw new Error(
      `Timed out waiting for ${expression}; last=${JSON.stringify(lastValue)}${detail}`,
    );
  }

  async function setViewport() {
    await Promise.all([
      send("Emulation.setDeviceMetricsOverride", VIEWPORT),
      send("Emulation.setTouchEmulationEnabled", {
        enabled: false,
        maxTouchPoints: 1,
      }),
      send("Page.bringToFront"),
    ]);
    await sleep(100);
  }

  async function dispatchKey(direction, type) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: direction.key,
      code: direction.code,
      windowsVirtualKeyCode: direction.virtualKeyCode,
      nativeVirtualKeyCode: direction.virtualKeyCode,
    });
  }

  async function captureCanvas() {
    const clip = await evaluate(`(() => {
      const canvas = document.querySelector(".playfield canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const bounds = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, bounds.left),
        y: Math.max(0, bounds.top),
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height),
        scale: 1,
      };
    })()`);
    assert.ok(clip, "game canvas is unavailable");
    const result = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip,
    });
    return Buffer.from(result.data, "base64");
  }

  return {
    diagnostics,
    send,
    evaluate,
    waitFor,
    setViewport,
    dispatchKey,
    captureCanvas,
    clearDiagnostics() {
      diagnostics.length = 0;
    },
    close() {
      socket.close();
    },
  };
}

function chooseStraightRun(state) {
  const walkable = state.campaign.walkable;
  let best = null;
  const candidateIsWalkable = (x, y) => (
    Boolean(walkable[Math.round(y)]?.[Math.round(x)])
  );
  for (let y = 1; y < walkable.length - 1; y += 1) {
    for (let x = 1; x < (walkable[y]?.length ?? 0) - 1; x += 1) {
      if (!candidateIsWalkable(x, y)) continue;
      for (const direction of MOVE_DIRECTIONS) {
        let distance = 0;
        for (let step = 0.25; step <= 4; step += 0.25) {
          if (!candidateIsWalkable(
            x + direction.x * step,
            y + direction.y * step,
          )) break;
          distance = step;
        }
        const localClearance = [
          candidateIsWalkable(x - 1, y),
          candidateIsWalkable(x + 1, y),
          candidateIsWalkable(x, y - 1),
          candidateIsWalkable(x, y + 1),
        ].filter(Boolean).length;
        const score = distance * 10 + localClearance;
        if (!best || score > best.score) {
          best = {
            score,
            distance,
            player: { x, y },
            direction,
          };
        }
      }
    }
  }
  assert.ok(best?.distance >= 2.5, `${state.campaign.id} has no straight QA run`);
  let chaser = state.campaign.chaserStart;
  let farthestDistance = -1;
  for (let y = 0; y < walkable.length; y += 1) {
    for (let x = 0; x < (walkable[y]?.length ?? 0); x += 1) {
      if (!walkable[y][x]) continue;
      const distance = Math.hypot(x - best.player.x, y - best.player.y);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        chaser = { x, y };
      }
    }
  }
  return {
    player: best.player,
    chaser,
    direction: best.direction,
    availableDistanceCells: best.distance,
  };
}

async function decodeForAnalysis(png) {
  const metadata = await sharp(png).metadata();
  const width = ANALYSIS_WIDTH;
  const height = Math.max(
    1,
    Math.round(Number(metadata.height) / Number(metadata.width) * width),
  );
  const colorPixels = await sharp(png)
    .resize(width, height, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer();
  const pixels = Buffer.alloc(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    const colorIndex = index * 3;
    pixels[index] = (
      77 * colorPixels[colorIndex]
      + 150 * colorPixels[colorIndex + 1]
      + 29 * colorPixels[colorIndex + 2]
    ) >> 8;
  }
  return { width, height, pixels, colorPixels };
}

function stateProbeExpression(stepCount = 1) {
  return `(() => {
    window.__CHASING_QA_FRAME_CONTROL__.step(${stepCount});
    const state = window.__CHASING_QA__.getState();
    return {
      state: {
        tick: state.game.tick,
        elapsedSeconds: state.game.elapsedSeconds,
        phase: state.game.phase,
        player: state.game.player,
        chaser: state.game.chaser,
        visibility: state.visibility,
        camera: state.camera,
        render: state.render,
        lightingStability: state.lightingStability,
        assets: {
          decorativeReady: state.assets.decorativeReady,
          deferredDressingSettled: state.assets.deferredDressingSettled,
        },
      },
      scene: window.__CHASING_QA__.inspectScene(),
      frameControl: window.__CHASING_QA_FRAME_CONTROL__.status(),
    };
  })()`;
}

function normalizedVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function cross(left, right) {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function shadowLightBasis() {
  const offset = normalizedVector(SHADOW_FOLLOW_OFFSET);
  const forward = { x: -offset.x, y: -offset.y, z: -offset.z };
  const right = normalizedVector(cross(forward, { x: 0, y: 1, z: 0 }));
  const up = normalizedVector(cross(right, forward));
  return { right, up };
}

function finiteLightingValue(value) {
  return Number.isFinite(value);
}

export function auditLightingStability(frames, moving) {
  const problems = [];
  const basis = shadowLightBasis();
  const shadowMapSize = frames[0].state.render.shadowMapSize;
  const texelWorldSize = SHADOW_FRUSTUM_METERS / shadowMapSize;
  const selectionSignatures = [];
  const projections = [];
  for (const [index, frame] of frames.entries()) {
    const lighting = frame.state.lightingStability;
    if (!lighting) {
      problems.push({ frame: index + 1, kind: "missing-lighting-telemetry" });
      continue;
    }
    if (lighting.globalBounceMode !== "steady") {
      problems.push({
        frame: index + 1,
        kind: "global-bounce-mode",
        value: lighting.globalBounceMode,
      });
    }
    if (lighting.visiblePerformanceLightCount > HIGH_QUALITY_LIGHT_CAPACITY) {
      problems.push({
        frame: index + 1,
        kind: "visible-light-capacity",
        value: lighting.visiblePerformanceLightCount,
        capacity: HIGH_QUALITY_LIGHT_CAPACITY,
      });
    }
    for (const light of lighting.performanceLights ?? []) {
      if (
        !finiteLightingValue(light.sourceIntensity)
        || !finiteLightingValue(light.appliedIntensity)
        || !finiteLightingValue(light.gain)
        || light.gain < -1e-9
        || light.gain > 1 + 1e-9
      ) {
        problems.push({
          frame: index + 1,
          kind: "invalid-light-state",
          light,
        });
      }
    }
    const selected = [...(lighting.selectedPerformanceLightIds ?? [])].sort();
    if (new Set(selected).size !== selected.length) {
      problems.push({
        frame: index + 1,
        kind: "duplicate-selected-light",
        selected,
      });
    }
    selectionSignatures.push(selected.join("|"));
    const target = lighting.shadowTarget;
    if (
      !target
      || !finiteLightingValue(target.x)
      || !finiteLightingValue(target.y)
      || !finiteLightingValue(target.z)
    ) {
      problems.push({
        frame: index + 1,
        kind: "invalid-shadow-target",
        target,
      });
      continue;
    }
    projections.push({
      frame: index + 1,
      target,
      x: dot(target, basis.right),
      y: dot(target, basis.up),
    });
  }

  const compactSelections = selectionSignatures.filter(
    (value, index) => index === 0 || value !== selectionSignatures[index - 1],
  );
  if (new Set(compactSelections).size !== compactSelections.length) {
    problems.push({
      kind: "selected-light-oscillation",
      sequence: compactSelections,
    });
  }
  if (!moving && compactSelections.length > 1) {
    problems.push({
      kind: "stationary-selected-light-change",
      sequence: compactSelections,
    });
  }

  if (projections.length) {
    const first = projections[0];
    if (!moving) {
      for (const current of projections.slice(1)) {
        if (
          Math.abs(current.target.x - first.target.x) > 1e-9
          || Math.abs(current.target.y - first.target.y) > 1e-9
          || Math.abs(current.target.z - first.target.z) > 1e-9
        ) {
          problems.push({
            frame: current.frame,
            kind: "stationary-shadow-target-change",
            first: first.target,
            current: current.target,
          });
          break;
        }
      }
    } else {
      for (let index = 1; index < projections.length; index += 1) {
        const previous = projections[index - 1];
        const current = projections[index];
        const xSteps = (current.x - previous.x) / texelWorldSize;
        const ySteps = (current.y - previous.y) / texelWorldSize;
        if (
          Math.abs(xSteps - Math.round(xSteps)) > 1e-5
          || Math.abs(ySteps - Math.round(ySteps)) > 1e-5
        ) {
          problems.push({
            frame: current.frame,
            kind: "fractional-shadow-texel-step",
            xSteps,
            ySteps,
            texelWorldSize,
          });
        }
      }
    }
  }
  return {
    problems,
    capacity: HIGH_QUALITY_LIGHT_CAPACITY,
    texelWorldSize,
    selectionSequence: compactSelections,
    shadowProjectionRange: projections.length
      ? {
          first: projections[0],
          last: projections.at(-1),
        }
      : null,
  };
}

async function captureProbe(
  browser,
  {
    directory,
    label,
    scenario,
    moving,
  },
) {
  await browser.evaluate(`window.__CHASING_QA__.setScenario(${JSON.stringify({
    player: scenario.player,
    chaser: scenario.chaser,
    spawnDelaySeconds: 99,
  })})`);
  await browser.evaluate(stateProbeExpression(moving ? 36 : 72));
  if (moving) {
    await browser.dispatchKey(scenario.direction, "keyDown");
  }

  const frames = [];
  try {
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const probe = await browser.evaluate(stateProbeExpression(1));
      const png = await browser.captureCanvas();
      const file = path.join(
        directory,
        `${label}-${String(index + 1).padStart(2, "0")}.png`,
      );
      await writeFile(file, png);
      frames.push({
        file,
        bytes: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        png,
        analysis: await decodeForAnalysis(png),
        ...probe,
      });
    }
  } finally {
    if (moving) {
      await browser.dispatchKey(scenario.direction, "keyUp");
    }
  }

  const pairMetrics = [];
  for (let index = 1; index < frames.length; index += 1) {
    const metric = analyzeFramePair(
      frames[index - 1].analysis,
      frames[index].analysis,
      {
        masks: actorMasks(frames[index - 1].state, frames[index].state),
      },
    );
    pairMetrics.push({
      frame: index + 1,
      ...metric,
    });
  }
  const pixelAudit = auditProbePixelStability(pairMetrics, { moving });
  const { summary } = pixelAudit;
  const worst = pairMetrics.reduce((current, candidate) => (
    !current || candidate.strongChangedRatio > current.strongChangedRatio
      ? candidate
      : current
  ), null);
  if (worst) {
    const source = frames[worst.frame - 1].analysis;
    const heatmap = Buffer.alloc(source.width * source.height * 3);
    for (let index = 0; index < worst.residual.length; index += 1) {
      const value = worst.residual[index];
      heatmap[index * 3] = Math.min(255, value * 6);
      heatmap[index * 3 + 1] = Math.min(110, value);
      heatmap[index * 3 + 2] = Math.min(80, Math.floor(value / 2));
    }
    await sharp(heatmap, {
      raw: {
        width: source.width,
        height: source.height,
        channels: 3,
      },
    })
      .resize(source.width * 2, source.height * 2, { kernel: "nearest" })
      .png()
      .toFile(path.join(directory, `${label}-worst-difference.png`));
  }

  const firstSceneSignature = staticSceneSignature(frames[0].scene);
  const sceneInstability = frames.slice(1).flatMap((frame, index) => {
    const signature = staticSceneSignature(frame.scene);
    if (
      signature.length === firstSceneSignature.length
      && signature.every((value, itemIndex) => value === firstSceneSignature[itemIndex])
    ) return [];
    const before = new Set(firstSceneSignature);
    const after = new Set(signature);
    return [{
      frame: index + 2,
      missing: [...before].filter((value) => !after.has(value)).slice(0, 12),
      added: [...after].filter((value) => !before.has(value)).slice(0, 12),
      baselineCount: firstSceneSignature.length,
      currentCount: signature.length,
    }];
  });
  const visibilityInstability = [];
  for (const actor of ["kid", "villain", "police"]) {
    const samples = frames.map((frame) => {
      const visibility = frame.state.visibility?.[actor];
      return visibility
        ? `${visibility.rootVisible}|${rounded(visibility.alpha, 3)}|${visibility.worldRendered ?? ""}`
        : "missing";
    });
    const unique = [...new Set(samples)];
    if (unique.length > 1) visibilityInstability.push({ actor, samples: unique });
  }
  const shadowMapSizes = [
    ...new Set(frames.map((frame) => frame.state.render.shadowMapSize)),
  ];
  const qualityTiers = [
    ...new Set(frames.map((frame) => frame.state.render.qualityTier)),
  ];
  const qualityTransitions = frames.map(
    (frame) => frame.state.render.qualityTransitionCount,
  );
  const emergencyTransitions = frames.map(
    (frame) => frame.state.render.emergencyTransitionCount,
  );
  const coplanar = detectLikelyCoplanarDuplicates(frames[0].scene);
  const lightingAudit = auditLightingStability(frames, moving);
  const hardInstability = (
    sceneInstability.length > 0
    || visibilityInstability.length > 0
    || shadowMapSizes.length !== 1
    || qualityTiers.length !== 1
    || Math.max(...qualityTransitions) !== Math.min(...qualityTransitions)
    || Math.max(...emergencyTransitions) !== Math.min(...emergencyTransitions)
    || lightingAudit.problems.length > 0
    || pixelAudit.movingUnexpected
  );

  return {
    label,
    moving,
    sampleCount: frames.length,
    summary,
    staticUnexpected: pixelAudit.staticUnexpected,
    movingUnexpected: pixelAudit.movingUnexpected,
    movingFlashFrames: pixelAudit.movingFlashFrames,
    hardInstability,
    scenario: {
      player: scenario.player,
      chaser: scenario.chaser,
      direction: scenario.direction.key,
      availableDistanceCells: scenario.availableDistanceCells,
    },
    stateRange: {
      firstTick: frames[0].state.tick,
      lastTick: frames.at(-1).state.tick,
      firstPlayer: frames[0].state.player.position,
      lastPlayer: frames.at(-1).state.player.position,
      cameraStart: frames[0].state.camera,
      cameraEnd: frames.at(-1).state.camera,
      occlusionStrengths: frames.map((frame) => rounded(
        frame.state.camera.occlusion.maxStrength,
        4,
      )),
      obscuredGroups: [
        ...new Set(frames.flatMap((frame) => frame.state.camera.occlusion.obscured)),
      ],
      shadowMapSizes,
      qualityTiers,
      qualityTransitions: [...new Set(qualityTransitions)],
      emergencyTransitions: [...new Set(emergencyTransitions)],
      renderCalls: [
        Math.min(...frames.map((frame) => frame.state.render.calls)),
        Math.max(...frames.map((frame) => frame.state.render.calls)),
      ],
      triangles: [
        Math.min(...frames.map((frame) => frame.state.render.triangles)),
        Math.max(...frames.map((frame) => frame.state.render.triangles)),
      ],
    },
    scene: {
      baselineVisibleStaticMeshCount: firstSceneSignature.length,
      instability: sceneInstability,
      likelyCoplanarDuplicates: coplanar,
    },
    visibilityInstability,
    lightingStability: lightingAudit,
    frames: frames.map((frame) => ({
      file: frame.file,
      bytes: frame.bytes,
      sha256: frame.sha256,
      tick: frame.state.tick,
      elapsedSeconds: rounded(frame.state.elapsedSeconds, 5),
      player: frame.state.player.position,
      cameraPosition: frame.state.camera.position,
      cameraFocus: frame.state.camera.focus,
      occlusion: frame.state.camera.occlusion,
      lightingStability: frame.state.lightingStability,
      render: {
        qualityTier: frame.state.render.qualityTier,
        qualityTransitionCount: frame.state.render.qualityTransitionCount,
        emergencyTransitionCount: frame.state.render.emergencyTransitionCount,
        shadowMapSize: frame.state.render.shadowMapSize,
        calls: frame.state.render.calls,
        triangles: frame.state.render.triangles,
      },
    })),
    pairs: pairMetrics.map(serializablePairMetric),
  };
}

function compareCutoutVariants(themeResult) {
  const withCutout = themeResult.default.moving.summary;
  const withoutCutout = themeResult["no-camera-cutout"].moving.summary;
  const cutoutPeak = Math.max(
    ...themeResult.default.moving.stateRange.occlusionStrengths,
  );
  const residualDelta =
    withCutout.strongChangedRatioP95 - withoutCutout.strongChangedRatioP95;
  const cutoutSuspect = (
    cutoutPeak > 0.04
    && withCutout.strongChangedRatioP95
      > withoutCutout.strongChangedRatioP95 * 1.35 + 0.003
  );
  const bothWholeScene = (
    withCutout.affectedTileRatioP95 > 0.45
    && withoutCutout.affectedTileRatioP95 > 0.45
  );
  const lightingStable = (
    themeResult.default.moving.lightingStability.problems.length === 0
    && themeResult["no-camera-cutout"].moving.lightingStability.problems.length === 0
  );
  return {
    cutoutPeak,
    residualDelta: rounded(residualDelta, 6),
    cutoutSuspect,
    bothWholeScene,
    lightingStable,
    withCutout,
    withoutCutout,
    interpretation: cutoutSuspect
      ? "camera-cutout materially increases aligned temporal residuals"
      : bothWholeScene && lightingStable
        ? "whole-scene residual matches deterministic camera follow in both variants; cutout and lighting contracts remain stable"
        : bothWholeScene
          ? "movement residual is whole-scene in both variants; inspect shadow/camera temporal stability"
        : "camera-cutout is not the dominant temporal difference",
  };
}

export function evaluateFrameStabilityResults(themes, results) {
  const hardProblems = [];
  const staticFlicker = [];
  const movingFlicker = [];
  const cutoutSuspects = [];
  const coplanarWarnings = [];
  for (const theme of themes) {
    const themeResult = results[theme.id];
    for (const variant of VARIANTS) {
      for (const probeName of ["stationary", "moving"]) {
        const probe = themeResult[variant.id][probeName];
        const probeId = `${theme.id}/${variant.id}/${probeName}`;
        if (probe.hardInstability) hardProblems.push(probeId);
        if (probe.staticUnexpected) staticFlicker.push(probeId);
        if (probe.movingUnexpected) movingFlicker.push(probeId);
      }
      const duplicates =
        themeResult[variant.id].stationary.scene.likelyCoplanarDuplicates;
      if (duplicates.exact.length || duplicates.planar.length) {
        coplanarWarnings.push({
          probe: `${theme.id}/${variant.id}`,
          exact: duplicates.exact,
          planar: duplicates.planar,
        });
      }
    }
    if (themeResult.comparison.cutoutSuspect) cutoutSuspects.push(theme.id);
  }
  return {
    verdict: {
      stable: (
        hardProblems.length === 0
        && staticFlicker.length === 0
        && movingFlicker.length === 0
        && cutoutSuspects.length === 0
      ),
      hardProblems,
      staticFlicker,
      movingFlicker,
      cutoutSuspects,
      coplanarWarningCount: coplanarWarnings.length,
    },
    coplanarWarnings,
  };
}

async function localRuntimeFileProvenance(resourceUrls) {
  const resources = [];
  for (const resourceUrl of resourceUrls) {
    const url = new URL(resourceUrl);
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
    const file = path.resolve(ROOT, "dist/client", relativePath);
    if (!file.startsWith(path.resolve(ROOT, "dist/client") + path.sep)) continue;
    try {
      const [payload, metadata] = await Promise.all([readFile(file), stat(file)]);
      resources.push({
        url: resourceUrl,
        file,
        bytes: payload.length,
        sha256: createHash("sha256").update(payload).digest("hex"),
        modifiedAt: metadata.mtime.toISOString(),
      });
    } catch {
      resources.push({ url: resourceUrl, file, missing: true });
    }
  }
  let runtimeManifest = null;
  const manifestFile = path.resolve(
    ROOT,
    "dist/client/runtime-asset-manifest.json",
  );
  try {
    const [payload, metadata] = await Promise.all([
      readFile(manifestFile),
      stat(manifestFile),
    ]);
    runtimeManifest = {
      file: manifestFile,
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
      modifiedAt: metadata.mtime.toISOString(),
    };
  } catch {
    runtimeManifest = { file: manifestFile, missing: true };
  }
  if (REQUIRE_DIST_PROVENANCE) {
    assert.ok(
      resources.length > 0,
      "formal frame-stability QA did not observe a served runtime script",
    );
    assert.equal(
      resources.some(({ missing }) => missing),
      false,
      "served runtime scripts do not match the local dist/client build",
    );
    assert.equal(
      runtimeManifest.missing,
      undefined,
      "formal frame-stability QA has no runtime asset manifest",
    );
  }
  return { resources, runtimeManifest };
}

async function prepareTheme(browser, theme, variant, clearStorage) {
  const url = qaUrl(theme, variant);
  browser.clearDiagnostics();
  if (clearStorage) {
    await browser.send("Storage.clearDataForOrigin", {
      origin: new URL(url).origin,
      storageTypes: "local_storage",
    });
  }
  await browser.send("Page.navigate", { url });
  await browser.waitFor(
    `document.readyState === "complete"
      && (
        Boolean(window.__CHASING_QA__?.getState()?.ready)
        || Boolean(document.querySelector(".loading-card.error"))
      )`,
    45_000,
  );
  const initialLoadFailure = await browser.evaluate(
    'document.querySelector(".loading-card.error strong")?.textContent ?? null',
  );
  if (initialLoadFailure) {
    throw new Error(
      `${theme.id}/${variant.id} failed scene initialization: ${initialLoadFailure}; diagnostics=${JSON.stringify(browser.diagnostics)}`,
    );
  }
  await browser.evaluate("window.__CHASING_QA__.setUnlockedThrough(10)");
  if (theme.levelIndex !== 0) {
    await browser.evaluate(`window.__CHASING_QA__.selectLevel(${theme.levelIndex})`);
  }
  await browser.waitFor(`(() => {
    const state = window.__CHASING_QA__?.getState();
    return Boolean(
      state?.ready
      && state?.campaign?.index === ${theme.levelIndex}
      && state?.game?.phase === "ready"
      && state?.assets?.decorativeReady === true
      && state?.assets?.deferredDressingSettled === true
      && state?.assets?.qaDecorativeSceneCompiled === true
      && state?.assets?.qaDecorativeSceneCompileCount === 1
      && state?.assets?.qaTransientArtPrewarmCount === 1
      && !document.querySelector(".loading-card, .loading-shell, .error-card, .load-error")
    );
  })()`, 90_000, 100);
  await browser.evaluate(`(() => {
    window.__CHASING_QA__.lockRenderQuality();
    window.__CHASING_QA__.setDirectorEnabled(false);
    window.__CHASING_QA__.start();
  })()`);
  await browser.waitFor(
    'window.__CHASING_QA__?.getState()?.game?.phase === "playing"',
    10_000,
  );
  const frameControl = await browser.evaluate(
    "window.__CHASING_QA_FRAME_CONTROL__.pause()",
  );
  assert.equal(frameControl.automatic, false);
  assert.ok(frameControl.pending >= 1, "manual frame driver has no render callback");
  await browser.evaluate(stateProbeExpression(3));
  const opening = await browser.evaluate("window.__CHASING_QA__.getState()");
  assert.equal(opening.render.qualityTier, "high");
  assert.equal(opening.render.qualityLock.enabled, true);
  assert.equal(
    await browser.evaluate(
      "window.__CHASING_QA__.getStealthProbe().director.enabled",
    ),
    false,
  );
  assert.equal(
    opening.camera.occlusion.groups === 0,
    variant.cutoutDisabled,
    `${variant.id} did not apply the requested camera-cutout policy`,
  );
  const servedRuntime = await browser.evaluate(`(() => ({
    location: location.href,
    resources: performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) =>
        /\\/assets\\/(?:chasing-game|index)-[^/]+\\.js(?:\\?|$)/u.test(name)
        || /\\/@vite\\/client(?:\\?|$)/u.test(name)
      )
      .sort()
  }))()`);
  return {
    url,
    opening,
    scenario: chooseStraightRun(opening),
    diagnostics: [...browser.diagnostics],
    servedRuntime: {
      ...servedRuntime,
      localDist: await localRuntimeFileProvenance(servedRuntime.resources),
    },
  };
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const browser = await connect();
  const sourceProvenance = collectQaSourceProvenance();
  const results = {};
  const runDiagnostics = [];
  let clearStorage = true;
  try {
    await browser.setViewport();
    await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: QA_FRAME_DRIVER_SOURCE,
    });
    for (const theme of THEMES) {
      results[theme.id] = {};
      for (const variant of VARIANTS) {
        const directory = path.join(OUTPUT, theme.id, variant.id);
        await mkdir(directory, { recursive: true });
        const prepared = await prepareTheme(
          browser,
          theme,
          variant,
          clearStorage,
        );
        runDiagnostics.push(...prepared.diagnostics.map((diagnostic) => ({
          theme: theme.id,
          variant: variant.id,
          ...diagnostic,
        })));
        clearStorage = false;
        const stationary = await captureProbe(browser, {
          directory,
          label: "stationary",
          scenario: prepared.scenario,
          moving: false,
        });
        const moving = await captureProbe(browser, {
          directory,
          label: "straight-run",
          scenario: prepared.scenario,
          moving: true,
        });
        results[theme.id][variant.id] = {
          url: prepared.url,
          servedRuntime: prepared.servedRuntime,
          stationary,
          moving,
        };
      }
      results[theme.id].comparison = compareCutoutVariants(results[theme.id]);
    }
  } finally {
    browser.close();
  }

  const evaluation = evaluateFrameStabilityResults(THEMES, results);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    viewport: VIEWPORT,
    sampleCountPerProbe: SAMPLE_COUNT,
    frameDriver: "manual-60hz-capable",
    sourceProvenance,
    diagnostics: runDiagnostics,
    verdict: evaluation.verdict,
    coplanarWarnings: evaluation.coplanarWarnings,
    themes: results,
  };
  const reportFile = path.join(OUTPUT, "frame-stability-report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    report: reportFile,
    verdict: report.verdict,
    comparisons: Object.fromEntries(
      THEMES.map((theme) => [theme.id, results[theme.id].comparison]),
    ),
  }, null, 2)}\n`);
  if (!report.verdict.stable) process.exitCode = 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
