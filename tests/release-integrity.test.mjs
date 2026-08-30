import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertFirstPlayableBudget,
  createFirstPlayableBudget,
  deduplicateBasisTranscoder,
  MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES,
} from "../build/release-integrity.ts";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "chasing-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = path.join(root, "dist", "client");
  const clientAssets = path.join(client, "_next", "static");
  await mkdir(clientAssets, { recursive: true });
  await mkdir(path.join(client, "basis"), { recursive: true });
  return { root, client, clientAssets };
}

test("release budgeting measures emitted text and every declared runtime preload", async (t) => {
  const { client, clientAssets } = await fixture(t);
  await writeFile(path.join(clientAssets, "app.js"), "export default 'game';\n");
  await writeFile(path.join(clientAssets, "app.css"), ".game { display: block; }\n");
  await mkdir(path.join(client, "models"), { recursive: true });
  await writeFile(path.join(client, "models", "kid.glb"), Buffer.alloc(256, 1));
  await writeFile(path.join(client, "basis", "basis_transcoder.wasm"), Buffer.alloc(512, 2));

  const budget = await createFirstPlayableBudget(client, clientAssets, [
    {
      href: "/models/kid.glb?v=1",
      type: "model/gltf-binary",
      fetchPriority: "auto",
      blocksFirstPlayable: true,
    },
    {
      href: "/basis/basis_transcoder.wasm",
      type: "application/wasm",
      fetchPriority: "high",
      blocksFirstPlayable: true,
    },
  ]);
  assertFirstPlayableBudget(budget);
  assert.ok(budget.criticalBytes > 0);
  assert.equal(budget.criticalBytes, budget.eagerBytes);
  assert.ok(budget.assets.some((asset) => asset.path === "/_next/static/app.js"));
  assert.ok(budget.assets.some((asset) => asset.path === "/_next/static/app.css"));
  assert.ok(budget.assets.some((asset) => asset.path === "/models/kid.glb"));
  assert.ok(budget.assets.some((asset) => asset.kind === "html"));
});

test("release budgeting rejects duplicate or missing runtime preloads", async (t) => {
  const { client, clientAssets } = await fixture(t);
  await writeFile(path.join(clientAssets, "app.js"), "export {};\n");
  await writeFile(path.join(clientAssets, "app.css"), ".app{}\n");
  await mkdir(path.join(client, "models"), { recursive: true });
  await writeFile(path.join(client, "models", "kid.glb"), Buffer.alloc(32));
  const asset = {
    href: "/models/kid.glb?v=1",
    type: "model/gltf-binary",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  };

  await assert.rejects(
    createFirstPlayableBudget(client, clientAssets, [
      asset,
      { ...asset, href: "/models/kid.glb?v=2" },
    ]),
    /Duplicate first-campaign preload/u,
  );
  await assert.rejects(
    createFirstPlayableBudget(client, clientAssets, [{
      ...asset,
      href: "/models/missing.glb",
    }]),
    /was not emitted/u,
  );
});

test("release budgeting fails closed when the resolved client asset directory is absent", async (t) => {
  const { client } = await fixture(t);
  await assert.rejects(
    createFirstPlayableBudget(
      client,
      path.join(client, "framework-output-that-does-not-exist"),
      [],
    ),
    /Client asset output directory was not emitted/u,
  );
});

test("release budgeting still rejects a missing emitted text category", async (t) => {
  const { client, clientAssets } = await fixture(t);
  await writeFile(path.join(clientAssets, "app.js"), "export {};\n");
  await mkdir(path.join(client, "models"), { recursive: true });
  await writeFile(path.join(client, "models", "kid.glb"), Buffer.alloc(32));
  await writeFile(
    path.join(client, "basis", "basis_transcoder.wasm"),
    Buffer.alloc(32),
  );
  const budget = await createFirstPlayableBudget(client, clientAssets, [
    {
      href: "/models/kid.glb",
      type: "model/gltf-binary",
      fetchPriority: "high",
      blocksFirstPlayable: true,
    },
    {
      href: "/basis/basis_transcoder.wasm",
      type: "application/wasm",
      fetchPriority: "high",
      blocksFirstPlayable: true,
    },
  ]);
  assert.throws(
    () => assertFirstPlayableBudget(budget),
    /First-playable budget omits css/u,
  );
});

test("release budgeting retains the critical transfer ceiling", async (t) => {
  const { client, clientAssets } = await fixture(t);
  await writeFile(path.join(clientAssets, "app.js"), "export {};\n");
  await writeFile(path.join(clientAssets, "app.css"), ".app{}\n");
  await writeFile(
    path.join(client, "basis", "basis_transcoder.wasm"),
    randomBytes(MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES),
  );
  await assert.rejects(
    createFirstPlayableBudget(client, clientAssets, [{
      href: "/basis/basis_transcoder.wasm",
      type: "application/wasm",
      fetchPriority: "high",
      blocksFirstPlayable: true,
    }]),
    /Critical first-playable transfer .* exceeds/u,
  );
});

test("Basis deduplication removes only byte-identical generated copies and their manifests", async (t) => {
  const { root, client, clientAssets } = await fixture(t);
  const basisJs = Buffer.from("canonical-transcoder-js");
  const basisWasm = Buffer.from("canonical-transcoder-wasm");
  await writeFile(path.join(client, "basis", "basis_transcoder.js"), basisJs);
  await writeFile(path.join(client, "basis", "basis_transcoder.wasm"), basisWasm);
  const media = path.join(clientAssets, "media");
  await mkdir(media, { recursive: true });
  await writeFile(path.join(media, "basis_transcoder.hash.js"), basisJs);
  await writeFile(path.join(media, "basis_transcoder.hash.wasm"), basisWasm);
  await mkdir(path.join(client, ".vite"), { recursive: true });
  await writeFile(
    path.join(client, ".vite", "manifest.json"),
    `${JSON.stringify({
      game: {
        file: "_next/static/game.js",
        assets: [
          "_next/static/media/basis_transcoder.hash.js",
          "_next/static/media/basis_transcoder.hash.wasm",
        ],
      },
      basis: {
        file: "_next/static/media/basis_transcoder.hash.js",
      },
    })}\n`,
  );
  const serverEntry = path.join(root, "dist", "server", "index.js");
  await mkdir(path.dirname(serverEntry), { recursive: true });
  await writeFile(
    serverEntry,
    "globalThis.__VINEXT_LAZY_CHUNKS__ = [\"_next/static/game.js\",\"_next/static/media/basis_transcoder.hash.js\"];\n",
  );

  const removed = await deduplicateBasisTranscoder(
    client,
    clientAssets,
    serverEntry,
  );
  assert.deepEqual(removed, [
    "_next/static/media/basis_transcoder.hash.js",
    "_next/static/media/basis_transcoder.hash.wasm",
  ]);
  await assert.rejects(
    access(path.join(media, "basis_transcoder.hash.js")),
    (error) => error?.code === "ENOENT",
  );
  assert.doesNotMatch(
    await readFile(path.join(client, ".vite", "manifest.json"), "utf8"),
    /basis_transcoder\.hash/u,
  );
  assert.doesNotMatch(
    await readFile(serverEntry, "utf8"),
    /basis_transcoder\.hash/u,
  );
});

test("Basis deduplication fails closed when generated bytes differ", async (t) => {
  const { root, client, clientAssets } = await fixture(t);
  await writeFile(path.join(client, "basis", "basis_transcoder.js"), "canonical");
  await writeFile(path.join(clientAssets, "basis_transcoder.hash.js"), "different");
  await assert.rejects(
    deduplicateBasisTranscoder(
      client,
      clientAssets,
      path.join(root, "dist", "server", "index.js"),
    ),
    /differs from basis\/basis_transcoder\.js/u,
  );
});
