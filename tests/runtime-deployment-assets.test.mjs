import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import {
  DEPLOYMENT_SOURCE_ASSET_EXCLUDES,
  FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS,
  FIRST_CAMPAIGN_PRELOAD_ASSETS,
  MAX_DEPLOYED_CLIENT_BYTES,
  RUNTIME_ASSET_MANIFEST_VERSION,
} from "../app/game/runtime-assets.ts";
import {
  assertFirstPlayableBudget,
  MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES,
  MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES,
  SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
} from "../build/release-integrity.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const CLIENT_OUTPUT = path.join(ROOT, "dist", "client");
const STEALTH_CORNER_MIRROR_PRELOAD =
  "/models/environment/stealth-corner-mirrors.glb?v=2";

async function treeBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await treeBytes(target) : (await stat(target)).size;
  }
  return total;
}

async function treeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await treeFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files.sort();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  assert.equal(manifest.runtimeGlbTransports.formatVersion, 1);
  assert.equal(manifest.runtimeGlbTransports.encoding, "gzip-envelope");
  assert.ok(manifest.runtimeGlbTransports.assets.length > 0);
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

test("every deployed GLB is a byte-exact audited gzip transport envelope", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(CLIENT_OUTPUT, "runtime-asset-manifest.json"), "utf8"),
  );
  const records = manifest.runtimeGlbTransports.assets;
  const deployedGlbs = (await treeFiles(path.join(CLIENT_OUTPUT, "models")))
    .filter((pathname) => pathname.endsWith(".glb"))
    .map((pathname) => (
      `/${path.relative(CLIENT_OUTPUT, pathname).split(path.sep).join("/")}`
    ));
  assert.deepEqual(
    records.map(({ path: publicPath }) => publicPath),
    deployedGlbs,
    "the transport audit must cover every deployed GLB exactly once",
  );

  for (const record of records) {
    assert.equal(record.encoding, "gzip-envelope");
    const relativePath = record.path.replace(/^\/+/u, "");
    const encoded = await readFile(path.join(CLIENT_OUTPUT, relativePath));
    assert.equal(encoded[0], 0x1f);
    assert.equal(encoded[1], 0x8b);
    assert.equal(record.encodedBytes, encoded.byteLength);
    assert.equal(record.encodedSha256, sha256(encoded));

    const decoded = gunzipSync(encoded);
    const source = await readFile(path.join(PUBLIC, relativePath));
    assert.deepEqual(
      decoded,
      source,
      `${record.path} does not decode to its source GLB byte-for-byte`,
    );
    assert.equal(record.decodedBytes, decoded.byteLength);
    assert.equal(record.decodedSha256, sha256(decoded));
    assert.equal(decoded.readUInt32LE(0), 0x46546c67);
    assert.equal(decoded.readUInt32LE(4), 2);
    assert.equal(decoded.readUInt32LE(8), decoded.byteLength);
  }
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
    if (record.kind === "model") {
      assert.equal(
        record.transferEncoding,
        "gzip-envelope",
        `${pathname} must be measured by its deployed envelope bytes`,
      );
    }
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
  const assets = await readdir(path.join(CLIENT_OUTPUT, "assets"));
  assert.deepEqual(
    assets.filter((filename) => /^basis_transcoder-.+\.(?:js|wasm)$/u.test(filename)),
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
  assert.doesNotMatch(viteManifest, /assets\/basis_transcoder-[^"]+/u);
  assert.doesNotMatch(
    serverEntry.match(/globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*\[[^;]*\]/u)?.[0] ?? "",
    /assets\/basis_transcoder-/u,
  );

  const gameChunk = assets.find((filename) => /^chasing-game-.+\.js$/u.test(filename));
  assert.ok(gameChunk, "the production game chunk is missing");
  const gameSource = await readFile(path.join(CLIENT_OUTPUT, "assets", gameChunk), "utf8");
  assert.match(gameSource, /\/basis\/basis_transcoder\.wasm/u);
  assert.match(gameSource, /\/basis\/basis_transcoder\.js/u);
});

test("the SSR game chunk never evaluates the browser-only KTX2 URL bootstrap", async () => {
  const serverAssets = path.join(ROOT, "dist", "server", "ssr", "assets");
  const assets = await readdir(serverAssets);
  const gameChunk = assets.find((filename) => /^chasing-game-.+\.js$/u.test(filename));
  const ktx2Chunk = assets.find((filename) => /^KTX2Loader-.+\.js$/u.test(filename));
  assert.ok(gameChunk, "the SSR game chunk is missing");
  assert.ok(ktx2Chunk, "the browser-only SSR KTX2 split chunk is missing");

  const [gameSource, ktx2Source] = await Promise.all([
    readFile(path.join(serverAssets, gameChunk), "utf8"),
    readFile(path.join(serverAssets, ktx2Chunk), "utf8"),
  ]);
  assert.doesNotMatch(
    gameSource,
    /WASM_BIN_URL|new URL\("\.\.\/libs\/basis\/basis_transcoder/u,
    "Cloudflare SSR must not evaluate KTX2Loader's import.meta.url bootstrap",
  );
  assert.match(
    gameSource,
    /typeof window === "undefined" \|\| typeof document === "undefined".+import\("\.\/KTX2Loader-/u,
    "the KTX2 split chunk must start only during browser module evaluation",
  );
  assert.match(
    ktx2Source,
    /new URL\("\.\.\/libs\/basis\/basis_transcoder\.wasm", import\.meta\.url\)/u,
    "the browser split chunk must retain Three.js's canonical KTX2 bootstrap",
  );
});
