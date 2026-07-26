import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PACKAGE = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const WORKFLOW = await readFile(
  new URL("../.github/workflows/release-integrity.yml", import.meta.url),
  "utf8",
);

test("package scripts expose clean, reproducible and security release gates", () => {
  assert.equal(PACKAGE.scripts.clean, "node build/clean-output.mjs");
  assert.equal(PACKAGE.scripts["build:clean"], "npm run clean && npm run build");
  assert.equal(PACKAGE.scripts["verify:release"], "node build/verify-clean-build.mjs");
  assert.equal(
    PACKAGE.scripts["audit:production"],
    "node build/audit-dependencies.mjs production",
  );
  assert.equal(
    PACKAGE.scripts["audit:tooling"],
    "node build/audit-dependencies.mjs tooling",
  );
  assert.match(PACKAGE.scripts.test, /npm run build:clean/u);
});

test("CI runs quality, deterministic build, tests and both audit policies", () => {
  for (const command of [
    "npm ci",
    "npm run audit:production",
    "npm run audit:tooling",
    "npm run typecheck",
    "npm run lint",
    "npm run verify:release",
    "npm run test:unit",
  ]) {
    assert.match(WORKFLOW, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
  assert.match(WORKFLOW, /lfs: true/u);
  assert.match(WORKFLOW, /permissions:\s*\n\s+contents: read/u);
  assert.match(WORKFLOW, /uses: actions\/checkout@v7/u);
  assert.match(WORKFLOW, /uses: actions\/setup-node@v6/u);
  assert.doesNotMatch(WORKFLOW, /actions\/(?:checkout|setup-node)@v4/u);
});

test("tooling exceptions are empty when clean, or uniquely justified and expiring", async () => {
  const policy = JSON.parse(
    await readFile(
      new URL("../build/tooling-audit-allowlist.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(policy.formatVersion, 1);
  assert.ok(Array.isArray(policy.exceptions));
  assert.equal(
    new Set(policy.exceptions.map((entry) => entry.package)).size,
    policy.exceptions.length,
  );
  for (const exception of policy.exceptions) {
    assert.match(exception.package, /\S/u);
    assert.match(exception.expiresOn, /^\d{4}-\d{2}-\d{2}$/u);
    assert.ok(exception.reason.length >= 24);
  }
});
