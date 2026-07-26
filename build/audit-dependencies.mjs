import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ROOT } from "./clean-output.mjs";

const mode = process.argv[2];
if (mode !== "production" && mode !== "tooling") {
  throw new Error("Usage: node build/audit-dependencies.mjs <production|tooling>");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["audit", "--json"];
if (mode === "production") args.push("--omit=dev");
const result = spawnSync(npm, args, {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (result.error) throw result.error;

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stderr || result.stdout);
  throw new Error("npm audit did not return a valid JSON report");
}

const vulnerabilities = Object.entries(report.vulnerabilities ?? {}).map(
  ([name, vulnerability]) => ({
    name,
    severity: vulnerability.severity,
    direct: vulnerability.isDirect === true,
  }),
);
const severityRank = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

if (mode === "production") {
  const blockers = vulnerabilities.filter(
    ({ severity }) => severityRank[severity] >= severityRank.high,
  );
  if (blockers.length > 0) {
    throw new Error(
      `Production dependency audit failed: ${blockers
        .map(({ name, severity }) => `${name} (${severity})`)
        .join(", ")}`,
    );
  }
  console.log("Production dependency audit passed: no high or critical vulnerabilities.");
  process.exit(0);
}

const policyPath = path.join(ROOT, "build", "tooling-audit-allowlist.json");
const policy = JSON.parse(await readFile(policyPath, "utf8"));
if (policy.formatVersion !== 1 || !Array.isArray(policy.exceptions)) {
  throw new Error("Tooling audit allowlist has an unsupported format");
}
const exceptions = new Map(policy.exceptions.map((entry) => [entry.package, entry]));
const currentDate = new Date().toISOString().slice(0, 10);
const blockers = [];
const activeHigh = new Set();
for (const vulnerability of vulnerabilities) {
  if (severityRank[vulnerability.severity] >= severityRank.critical) {
    blockers.push(`${vulnerability.name} (${vulnerability.severity})`);
    continue;
  }
  if (vulnerability.severity !== "high") continue;
  activeHigh.add(vulnerability.name);
  const exception = exceptions.get(vulnerability.name);
  if (!exception) {
    blockers.push(`${vulnerability.name} (unapproved high)`);
  } else if (
    typeof exception.expiresOn !== "string"
    || exception.expiresOn < currentDate
  ) {
    blockers.push(`${vulnerability.name} (exception expired ${exception.expiresOn})`);
  } else if (
    typeof exception.reason !== "string"
    || exception.reason.trim().length < 24
  ) {
    blockers.push(`${vulnerability.name} (exception has no actionable rationale)`);
  }
}
for (const packageName of exceptions.keys()) {
  if (!activeHigh.has(packageName)) {
    blockers.push(`${packageName} (stale exception; vulnerability is no longer high)`);
  }
}
if (blockers.length > 0) {
  throw new Error(`Tooling dependency audit failed: ${blockers.join(", ")}`);
}
if (activeHigh.size === 0) {
  console.log("Tooling dependency audit passed: no high or critical vulnerabilities.");
} else {
  console.log(
    `Tooling dependency audit passed: no critical vulnerabilities; `
    + `${activeHigh.size} reviewed high-severity exceptions expire by `
    + `${policy.exceptions.map(({ expiresOn }) => expiresOn).sort()[0]}.`,
  );
}
