import assert from "node:assert/strict";
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
import { gunzipSync } from "node:zlib";

import {
  assertFirstPlayableBudget,
  createFirstPlayableBudget,
  deduplicateBasisTranscoder,
  encodeRuntimeGlbTransports,
} from "../build/release-integrity.ts";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "chasing-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = path.join(root, "dist", "client");
  await mkdir(path.join(client, "assets"), { recursive: true });
  await mkdir(path.join(client, "basis"), { recursive: true });
  return { root, client };
}

function validGlb(byteLength = 4_096) {
  const bytes = Buffer.alloc(Math.max(12, byteLength), 7);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.byteLength, 8);
  return bytes;
}

test("release budgeting measures emitted text and every declared runtime preload", async (t) => {
  const { client } = await fixture(t);
  await writeFile(path.join(client, "assets", "app.js"), "export default 'game';\n");
  await writeFile(path.join(client, "assets", "app.css"), ".game { display: block; }\n");
  await mkdir(path.join(client, "models"), { recursive: true });
  await writeFile(path.join(client, "models", "kid.glb"), Buffer.alloc(256, 1));
  await writeFile(path.join(client, "basis", "basis_transcoder.wasm"), Buffer.alloc(512, 2));

  const budget = await createFirstPlayableBudget(client, [
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
  assert.ok(budget.assets.some((asset) => asset.path === "/assets/app.js"));
  assert.ok(budget.assets.some((asset) => asset.path === "/assets/app.css"));
  assert.ok(budget.assets.some((asset) => asset.path === "/models/kid.glb"));
  assert.ok(budget.assets.some((asset) => asset.kind === "html"));
});

test("runtime GLB envelopes are deterministic, idempotent and budgeted by encoded bytes", async (t) => {
  const { client } = await fixture(t);
  await writeFile(path.join(client, "assets", "app.js"), "export default 'game';\n");
  await writeFile(path.join(client, "assets", "app.css"), ".game { display: block; }\n");
  const modelDirectory = path.join(client, "models", "environment");
  await mkdir(modelDirectory, { recursive: true });
  const modelPath = path.join(modelDirectory, "locker.glb");
  const source = validGlb();
  await writeFile(modelPath, source);

  const first = await encodeRuntimeGlbTransports(client);
  const firstEncoded = await readFile(modelPath);
  assert.deepEqual(gunzipSync(firstEncoded), source);
  assert.deepEqual(
    [...firstEncoded.subarray(4, 8)],
    [0, 0, 0, 0],
    "gzip transport MTIME must be platform-independent",
  );
  assert.equal(
    firstEncoded[9],
    0xff,
    "gzip transport OS byte must not vary between macOS and Linux",
  );
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], {
    path: "/models/environment/locker.glb",
    encoding: "gzip-envelope",
    decodedBytes: source.byteLength,
    encodedBytes: firstEncoded.byteLength,
    decodedSha256: first[0].decodedSha256,
    encodedSha256: first[0].encodedSha256,
  });
  assert.ok(first[0].encodedBytes < first[0].decodedBytes);

  const second = await encodeRuntimeGlbTransports(client);
  const secondEncoded = await readFile(modelPath);
  assert.deepEqual(second, first);
  assert.deepEqual(secondEncoded, firstEncoded);

  const budget = await createFirstPlayableBudget(client, [{
    href: "/models/environment/locker.glb?v=1",
    type: "model/gltf-binary",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  }]);
  const record = budget.assets.find(
    (asset) => asset.path === "/models/environment/locker.glb",
  );
  assert.equal(record?.rawBytes, firstEncoded.byteLength);
  assert.equal(record?.estimatedTransferBytes, firstEncoded.byteLength);
  assert.equal(record?.transferEncoding, "gzip-envelope");
});

test("runtime GLB envelope generation fails closed on invalid magic and declared length", async (t) => {
  const { client } = await fixture(t);
  const modelDirectory = path.join(client, "models");
  await mkdir(modelDirectory, { recursive: true });
  const invalidMagicPath = path.join(modelDirectory, "invalid-magic.glb");
  await writeFile(invalidMagicPath, Buffer.alloc(12));
  await assert.rejects(
    encodeRuntimeGlbTransports(client),
    /does not contain binary glTF magic/u,
  );

  await rm(invalidMagicPath);
  const invalidLength = validGlb(64);
  invalidLength.writeUInt32LE(63, 8);
  await writeFile(path.join(modelDirectory, "invalid-length.glb"), invalidLength);
  await assert.rejects(
    encodeRuntimeGlbTransports(client),
    /declares 63 bytes but contains 64/u,
  );
});

test("release budgeting rejects duplicate or missing runtime preloads", async (t) => {
  const { client } = await fixture(t);
  await writeFile(path.join(client, "assets", "app.js"), "export {};\n");
  await writeFile(path.join(client, "assets", "app.css"), ".app{}\n");
  await mkdir(path.join(client, "models"), { recursive: true });
  await writeFile(path.join(client, "models", "kid.glb"), Buffer.alloc(32));
  const asset = {
    href: "/models/kid.glb?v=1",
    type: "model/gltf-binary",
    fetchPriority: "high",
    blocksFirstPlayable: true,
  };

  await assert.rejects(
    createFirstPlayableBudget(client, [asset, { ...asset, href: "/models/kid.glb?v=2" }]),
    /Duplicate first-campaign preload/u,
  );
  await assert.rejects(
    createFirstPlayableBudget(client, [{
      ...asset,
      href: "/models/missing.glb",
    }]),
    /was not emitted/u,
  );
});

test("Basis deduplication removes only byte-identical generated copies and their manifests", async (t) => {
  const { root, client } = await fixture(t);
  const basisJs = Buffer.from("canonical-transcoder-js");
  const basisWasm = Buffer.from("canonical-transcoder-wasm");
  await writeFile(path.join(client, "basis", "basis_transcoder.js"), basisJs);
  await writeFile(path.join(client, "basis", "basis_transcoder.wasm"), basisWasm);
  await writeFile(path.join(client, "assets", "basis_transcoder-hash.js"), basisJs);
  await writeFile(path.join(client, "assets", "basis_transcoder-hash.wasm"), basisWasm);
  await mkdir(path.join(client, ".vite"), { recursive: true });
  await writeFile(
    path.join(client, ".vite", "manifest.json"),
    `${JSON.stringify({
      game: {
        file: "assets/game.js",
        assets: [
          "assets/basis_transcoder-hash.js",
          "assets/basis_transcoder-hash.wasm",
        ],
      },
      basis: {
        file: "assets/basis_transcoder-hash.js",
      },
    })}\n`,
  );
  const serverEntry = path.join(root, "dist", "server", "index.js");
  await mkdir(path.dirname(serverEntry), { recursive: true });
  await writeFile(
    serverEntry,
    "globalThis.__VINEXT_LAZY_CHUNKS__ = [\"assets/game.js\",\"assets/basis_transcoder-hash.js\"];\n",
  );

  const removed = await deduplicateBasisTranscoder(client, serverEntry);
  assert.deepEqual(removed, [
    "assets/basis_transcoder-hash.js",
    "assets/basis_transcoder-hash.wasm",
  ]);
  await assert.rejects(
    access(path.join(client, "assets", "basis_transcoder-hash.js")),
    (error) => error?.code === "ENOENT",
  );
  assert.doesNotMatch(
    await readFile(path.join(client, ".vite", "manifest.json"), "utf8"),
    /basis_transcoder-hash/u,
  );
  assert.doesNotMatch(
    await readFile(serverEntry, "utf8"),
    /basis_transcoder-hash/u,
  );
});

test("Basis deduplication fails closed when generated bytes differ", async (t) => {
  const { root, client } = await fixture(t);
  await writeFile(path.join(client, "basis", "basis_transcoder.js"), "canonical");
  await writeFile(path.join(client, "assets", "basis_transcoder-hash.js"), "different");
  await assert.rejects(
    deduplicateBasisTranscoder(client, path.join(root, "dist", "server", "index.js")),
    /differs from basis\/basis_transcoder\.js/u,
  );
});
