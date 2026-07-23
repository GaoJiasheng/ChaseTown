import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
  FIRST_CAMPAIGN_PRELOAD_ASSETS,
  MAX_DEPLOYED_CLIENT_BYTES,
  RUNTIME_ASSET_MANIFEST_VERSION,
} from "../app/game/runtime-assets.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const CLIENT_OUTPUT = path.join(ROOT, "dist", "client");

async function treeBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await treeBytes(target) : (await stat(target)).size;
  }
  return total;
}

function publicPathForHref(href) {
  return path.join(
    PUBLIC,
    new URL(href, "https://runtime.invalid").pathname.replace(/^\/+/u, ""),
  );
}

test("first-campaign preloads are unique runtime files retained in public", async () => {
  const hrefs = FIRST_CAMPAIGN_PRELOAD_ASSETS.map(({ href }) => href);
  assert.equal(new Set(hrefs).size, hrefs.length);
  for (const asset of FIRST_CAMPAIGN_PRELOAD_ASSETS) {
    assert.equal(asset.href.startsWith("/"), true);
    assert.equal(["high", "auto"].includes(asset.fetchPriority), true);
    await access(publicPathForHref(asset.href));
    assert.equal(
      DEPLOYMENT_SOURCE_ASSET_EXCLUDES.some((excluded) => (
        new URL(asset.href, "https://runtime.invalid").pathname
          .startsWith(`/${excluded}`)
      )),
      false,
      `${asset.href} must not be pruned from deployment`,
    );
  }
});

test("authoring models remain in the repository but are pruned from the built client", async () => {
  for (const relativePath of DEPLOYMENT_SOURCE_ASSET_EXCLUDES) {
    await access(path.join(PUBLIC, relativePath));
    await assert.rejects(
      access(path.join(CLIENT_OUTPUT, relativePath)),
      (error) => error?.code === "ENOENT",
      `${relativePath} unexpectedly shipped in dist/client`,
    );
  }
});

test("built runtime manifest and deployment size match the release contract", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(CLIENT_OUTPUT, "runtime-asset-manifest.json"), "utf8"),
  );
  assert.equal(manifest.formatVersion, RUNTIME_ASSET_MANIFEST_VERSION);
  assert.equal(manifest.maximumClientBytes, MAX_DEPLOYED_CLIENT_BYTES);
  assert.deepEqual(manifest.firstCampaignPreloads, FIRST_CAMPAIGN_PRELOAD_ASSETS);
  assert.deepEqual(
    manifest.sourceAssetsExcludedFromDeployment,
    DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
  );
  assert.ok(
    await treeBytes(CLIENT_OUTPUT) <= MAX_DEPLOYED_CLIENT_BYTES,
    "dist/client exceeds the 22 MiB release budget",
  );
});
