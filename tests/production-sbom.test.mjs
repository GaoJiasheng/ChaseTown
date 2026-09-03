import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (relativePath) => JSON.parse(
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
);

// The committed SBOM is the starting point for a pre-release license review, so
// it must not silently fall behind the lockfile.
test("production SBOM matches the committed lockfile", () => {
  const result = spawnSync(
    "node",
    ["scripts/generate-production-sbom.mjs", "--check"],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `production SBOM is stale; run npm run sbom:production\n${result.stdout}${result.stderr}`,
  );
});

test("production SBOM resolves every declared dependency name", async () => {
  const sbom = await readJson("docs/licenses/PRODUCTION_SBOM.json");
  assert.deepEqual(
    sbom.unresolvedNames,
    [],
    "the lockfile walk failed to resolve some dependency names, so the inventory is incomplete",
  );
  assert.ok(sbom.packageCount > 0);
  assert.deepEqual(
    sbom.undeclaredLicenses,
    [],
    "a production-reachable package declares no license and needs manual review",
  );
});
