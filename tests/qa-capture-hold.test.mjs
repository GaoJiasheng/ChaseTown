import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPTURE_HOLD_COMMAND_TIMEOUT_MILLISECONDS,
  CAPTURE_HOLD_LEASE_MILLISECONDS,
  CAPTURE_HOLD_RENEW_INTERVAL_MILLISECONDS,
  createRenewableCaptureHoldController,
} from "../scripts/qa-capture-hold.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_SOURCE = await readFile(
  path.join(ROOT, "app", "chasing-game.tsx"),
  "utf8",
);
const QA_SOURCE = await readFile(
  path.join(ROOT, "scripts", "stealth-systems-visual-qa.mjs"),
  "utf8",
);

function numericConstant(source, name) {
  const match = source.match(
    new RegExp(`const ${name} = ([0-9_]+);`, "u"),
  );
  assert.ok(match, `${name} is missing`);
  return Number(match[1].replaceAll("_", ""));
}

function manualInterval() {
  const state = {
    callback: null,
    delay: null,
    cancelled: false,
    unrefCalled: false,
  };
  return {
    state,
    schedule(callback, delay) {
      state.callback = callback;
      state.delay = delay;
      return {
        unref() {
          state.unrefCalled = true;
        },
      };
    },
    cancel() {
      state.cancelled = true;
    },
  };
}

test("capture controller renews a short lease and releases exactly once", async () => {
  const interval = manualInterval();
  const renewals = [];
  let releases = 0;
  const controller = createRenewableCaptureHoldController({
    renew: async (leaseMilliseconds) => {
      renewals.push(leaseMilliseconds);
      return { renewal: renewals.length };
    },
    release: async () => {
      releases += 1;
    },
    scheduleInterval: interval.schedule,
    cancelInterval: interval.cancel,
  });

  assert.deepEqual(await controller.start(), { renewal: 1 });
  assert.deepEqual(renewals, [CAPTURE_HOLD_LEASE_MILLISECONDS]);
  assert.equal(
    interval.state.delay,
    CAPTURE_HOLD_RENEW_INTERVAL_MILLISECONDS,
  );
  assert.equal(interval.state.unrefCalled, true);

  interval.state.callback();
  await controller.waitForIdle();
  assert.deepEqual(renewals, [
    CAPTURE_HOLD_LEASE_MILLISECONDS,
    CAPTURE_HOLD_LEASE_MILLISECONDS,
  ]);
  controller.assertHealthy();

  await controller.stop();
  await controller.stop();
  assert.equal(releases, 1);
  assert.equal(interval.state.cancelled, true);
  assert.deepEqual(controller.status, {
    started: true,
    stopped: true,
    released: true,
    renewalCount: 2,
    renewalFailed: false,
  });

  interval.state.callback();
  await controller.waitForIdle();
  assert.equal(renewals.length, 2, "a stopped controller renewed its lease");
});

test("renewal failure is retained but cannot skip browser release", async () => {
  const interval = manualInterval();
  let renewals = 0;
  let releases = 0;
  const controller = createRenewableCaptureHoldController({
    renew: async () => {
      renewals += 1;
      if (renewals > 1) throw new Error("CDP disconnected");
      return true;
    },
    release: async () => {
      releases += 1;
    },
    scheduleInterval: interval.schedule,
    cancelInterval: interval.cancel,
  });

  await controller.start();
  interval.state.callback();
  await controller.waitForIdle();
  assert.throws(
    () => controller.assertHealthy(),
    /capture hold lease renewal failed: CDP disconnected/u,
  );
  await assert.rejects(
    controller.stop(),
    /capture hold lease renewal failed: CDP disconnected/u,
  );
  assert.equal(releases, 1);
  assert.equal(controller.status.released, true);
});

test("browser lease remains short and expires without controller renewal", () => {
  const runtimeDefault = numericConstant(
    APP_SOURCE,
    "QA_CAPTURE_HOLD_DEFAULT_LEASE_MS",
  );
  const runtimeMaximum = numericConstant(
    APP_SOURCE,
    "QA_CAPTURE_HOLD_MAX_LEASE_MS",
  );
  assert.equal(runtimeDefault, CAPTURE_HOLD_LEASE_MILLISECONDS);
  assert.ok(runtimeMaximum >= runtimeDefault);
  assert.ok(runtimeMaximum <= 10_000, "browser capture lease is no longer short");
  assert.ok(
    CAPTURE_HOLD_RENEW_INTERVAL_MILLISECONDS * 2
      < CAPTURE_HOLD_LEASE_MILLISECONDS,
    "controller does not have multiple renewal opportunities",
  );
  assert.ok(
    CAPTURE_HOLD_COMMAND_TIMEOUT_MILLISECONDS
      < CAPTURE_HOLD_LEASE_MILLISECONDS,
    "a stalled renewal command can outlive the browser lease",
  );
  assert.match(
    APP_SOURCE,
    /qaCaptureHoldDeadline = performance\.now\(\) \+ boundedLease;/u,
  );
  assert.match(
    APP_SOURCE,
    /qaCaptureHoldRequested[\s\S]*now >= qaCaptureHoldDeadline[\s\S]*qaCaptureHoldRequested = false;/u,
  );
});

test("stealth screenshot helper renews throughout capture instead of taking a long lease", () => {
  const screenshot = QA_SOURCE.match(
    /const screenshot = async \(name\) => \{[\s\S]*?\n  \};\n\n  const dispatchKey/u,
  )?.[0] ?? "";
  assert.ok(screenshot, "stealth screenshot helper is missing");
  assert.match(
    QA_SOURCE,
    /createRenewableCaptureHoldController/u,
  );
  assert.match(screenshot, /const captureHold = createRenewableCaptureHoldController/u);
  const startIndex = screenshot.indexOf("await captureHold.start()");
  const captureIndex = screenshot.indexOf('send("Page.captureScreenshot"');
  const stopIndex = screenshot.indexOf("await captureHold.stop()");
  assert.ok(startIndex >= 0, "capture hold never starts");
  assert.ok(captureIndex > startIndex, "screenshot starts before capture hold");
  assert.ok(stopIndex > captureIndex, "capture hold is not released after screenshot");
  assert.match(screenshot, /captureHold\.assertHealthy\(\)/u);
  assert.doesNotMatch(
    QA_SOURCE,
    /setCaptureHold\(true,\s*(?:12_000|90_000)\)/u,
    "controller regressed to one long browser freeze",
  );
});
