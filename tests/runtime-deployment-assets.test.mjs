import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
  ASSET_VERSION,
  FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS,
  FIRST_CAMPAIGN_PRELOAD_ASSETS,
  MAX_DEPLOYED_CLIENT_BYTES,
  RUNTIME_ASSET_MANIFEST_VERSION,
} from "../app/game/runtime-assets.ts";
import {
  assertFirstPlayableBudget,
  isGeneratedBasisTranscoderAsset,
  MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES,
  MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES,
  SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
} from "../build/release-integrity.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const CLIENT_OUTPUT = path.join(ROOT, "dist", "client");
const STEALTH_CORNER_MIRROR_PRELOAD =
  `/models/environment/stealth-corner-mirrors.glb?v=${ASSET_VERSION}`;

async function treeBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await treeBytes(target) : (await stat(target)).size;
  }
  return total;
}

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesBelow(target));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files.sort();
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
  assert.ok(
    hrefs.includes(STEALTH_CORNER_MIRROR_PRELOAD),
    "the navigation-critical corner mirror must start before hydration",
  );
  for (const [role, href] of Object.entries(FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS)) {
    const preload = FIRST_CAMPAIGN_PRELOAD_ASSETS.find((asset) => asset.href === href);
    assert.ok(
      preload,
      `${role} blocks first playable but is missing from preload accounting`,
    );
    assert.equal(
      preload.blocksFirstPlayable,
      true,
      `${role} must be budgeted by control-unlock authority`,
    );
  }
  for (const asset of FIRST_CAMPAIGN_PRELOAD_ASSETS) {
    assert.equal(asset.href.startsWith("/"), true);
    assert.equal(["high", "auto"].includes(asset.fetchPriority), true);
    assert.equal(typeof asset.blocksFirstPlayable, "boolean");
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
  assert.equal(manifest.releaseIntegrityVersion, 1);
  assert.equal(manifest.maximumClientBytes, MAX_DEPLOYED_CLIENT_BYTES);
  assert.deepEqual(manifest.firstCampaignPreloads, FIRST_CAMPAIGN_PRELOAD_ASSETS);
  assert.equal(
    manifest.firstPlayableBudget.maximumCriticalBytes,
    MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES,
  );
  assert.equal(
    manifest.firstPlayableBudget.maximumEagerBytes,
    MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES,
  );
  assert.equal(
    manifest.firstPlayableBudget.dynamicHtmlReserveBytes,
    SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
  );
  assertFirstPlayableBudget(manifest.firstPlayableBudget);
  assert.deepEqual(manifest.basisTranscoder, {
    canonicalAssets: [
      "/basis/basis_transcoder.js",
      "/basis/basis_transcoder.wasm",
    ],
    duplicateBundlerOutputs: 0,
  });
  assert.deepEqual(
    manifest.sourceAssetsExcludedFromDeployment,
    DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
  );
  assert.ok(
    await treeBytes(CLIENT_OUTPUT) <= MAX_DEPLOYED_CLIENT_BYTES,
    "dist/client exceeds the 22 MiB release budget",
  );
});

test("first-playable accounting includes every preload plus HTML, JS, CSS, WASM and models", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(CLIENT_OUTPUT, "runtime-asset-manifest.json"), "utf8"),
  );
  const records = manifest.firstPlayableBudget.assets;
  const recordByPath = new Map(records.map((asset) => [asset.path, asset]));
  for (const preload of FIRST_CAMPAIGN_PRELOAD_ASSETS) {
    const pathname = new URL(preload.href, "https://runtime.invalid").pathname;
    const record = recordByPath.get(pathname);
    assert.ok(record, `${pathname} is absent from the transfer budget`);
    assert.equal(
      record.rawBytes,
      (await stat(path.join(CLIENT_OUTPUT, pathname.replace(/^\/+/u, "")))).size,
    );
    assert.equal(
      record.phase,
      preload.blocksFirstPlayable ? "critical" : "eager",
    );
  }
  const mirrorPath = new URL(
    STEALTH_CORNER_MIRROR_PRELOAD,
    "https://runtime.invalid",
  ).pathname;
  assert.equal(
    recordByPath.get(mirrorPath)?.kind,
    "model",
    "the preloaded mirror must remain inside the release transfer budget",
  );
  for (const kind of ["html", "javascript", "css", "wasm", "model"]) {
    assert.ok(records.some((asset) => asset.kind === kind), `${kind} is unaccounted`);
  }
  assert.equal(
    records.filter((asset) => asset.kind === "html").length,
    1,
    "the dynamic document must have one explicit transfer reserve",
  );
  assert.equal(
    manifest.firstPlayableBudget.criticalBytes,
    manifest.firstPlayableBudget.eagerBytes,
    "every current preload gates control unlock and must be counted as critical",
  );
});

test("the built artifact ships one canonical Basis transcoder without stale preload references", async () => {
  const emittedFiles = await filesBelow(CLIENT_OUTPUT);
  assert.deepEqual(
    emittedFiles
      .map((pathname) => path.relative(CLIENT_OUTPUT, pathname))
      .filter(isGeneratedBasisTranscoderAsset),
    [],
  );
  for (const basename of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
    await access(path.join(CLIENT_OUTPUT, "basis", basename));
  }

  const viteManifest = await readFile(
    path.join(CLIENT_OUTPUT, ".vite", "manifest.json"),
    "utf8",
  );
  const serverEntry = await readFile(path.join(ROOT, "dist", "server", "index.js"), "utf8");
  assert.doesNotMatch(
    viteManifest,
    /(?:^|\/)basis_transcoder[.-][^/"]+\.(?:js|wasm)/u,
  );
  assert.doesNotMatch(
    serverEntry.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*\[[^;]*\]/u)?.[0] ?? "",
    /(?:^|\/)basis_transcoder[.-][^/"]+\.(?:js|wasm)/u,
  );

  const manifest = JSON.parse(
    await readFile(path.join(CLIENT_OUTPUT, "runtime-asset-manifest.json"), "utf8"),
  );
  const gameChunk = manifest.firstPlayableBudget.assets.find((asset) => (
    asset.kind === "javascript" && /\/chasing-game-[^/]+\.js$/u.test(asset.path)
  ));
  assert.ok(gameChunk, "the production game chunk is missing from release accounting");
  const gameSource = await readFile(
    path.join(CLIENT_OUTPUT, gameChunk.path.replace(/^\/+/, "")),
    "utf8",
  );
  assert.match(gameSource, /\/basis\/basis_transcoder\.wasm/u);
  assert.match(gameSource, /\/basis\/basis_transcoder\.js/u);
});
