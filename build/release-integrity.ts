import { createHash } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

import type { RuntimePreloadAsset } from "../app/game/runtime-assets";

export const MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES = 6 * 1024 * 1024;
export const MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES = 6 * 1024 * 1024;
export const SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES = 32 * 1024;

const BASIS_TRANSCODER_OUTPUT =
  /^assets\/basis_transcoder-[^/]+\.(?:js|wasm)$/u;
const CLIENT_TEXT_ASSET = /\.(?:css|js)$/u;

export type ReleaseAssetKind =
  | "css"
  | "html"
  | "javascript"
  | "model"
  | "texture"
  | "wasm";

export type ReleaseAssetRecord = Readonly<{
  path: string;
  kind: ReleaseAssetKind;
  phase: "critical" | "eager";
  rawBytes: number;
  estimatedTransferBytes: number;
  transferEncoding: "already-compressed" | "gzip" | "identity" | "reserved";
  sha256: string | null;
}>;

export type FirstPlayableBudget = Readonly<{
  measurement: "encoded-transfer-bytes";
  dynamicHtmlReserveBytes: number;
  maximumCriticalBytes: number;
  maximumEagerBytes: number;
  criticalBytes: number;
  eagerBytes: number;
  remainingCriticalBytes: number;
  remainingEagerBytes: number;
  assets: readonly ReleaseAssetRecord[];
}>;

function toPosixPath(pathname: string): string {
  return pathname.split(sep).join("/");
}

async function exists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function filesBelow(directory: string): Promise<string[]> {
  if (!(await exists(directory))) return [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await filesBelow(pathname));
    } else if (entry.isFile()) {
      files.push(pathname);
    }
  }
  return files.sort();
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimePath(href: string): string {
  return new URL(href, "https://runtime.invalid")
    .pathname
    .replace(/^\/+/u, "");
}

function runtimeKind(asset: RuntimePreloadAsset): ReleaseAssetKind {
  if (asset.type === "application/wasm") return "wasm";
  if (asset.type === "text/javascript") return "javascript";
  if (asset.type === "image/ktx2") return "texture";
  return "model";
}

function isTextAsset(pathname: string): boolean {
  return CLIENT_TEXT_ASSET.test(pathname);
}

async function fileRecord(
  pathname: string,
  publicPath: string,
  kind: ReleaseAssetKind,
  phase: ReleaseAssetRecord["phase"],
): Promise<ReleaseAssetRecord> {
  const bytes = await readFile(pathname);
  const gzip = isTextAsset(pathname);
  return Object.freeze({
    path: publicPath,
    kind,
    phase,
    rawBytes: bytes.byteLength,
    estimatedTransferBytes: gzip
      ? gzipSync(bytes, { level: 9 }).byteLength
      : bytes.byteLength,
    transferEncoding: gzip ? "gzip" : "already-compressed",
    sha256: digest(bytes),
  });
}

/**
 * Builds a conservative cold-start transfer budget. Every emitted client JS
 * and CSS file is counted, not only the entry chunk. `blocksFirstPlayable` is
 * the phase authority; fetch priority remains only a browser scheduling hint.
 * The HTML route is rendered dynamically by vinext, so a hard 32 KiB
 * identity-encoded reserve makes that cost explicit and fails closed if the
 * document later grows.
 */
export async function createFirstPlayableBudget(
  clientOutputDirectory: string,
  preloads: readonly RuntimePreloadAsset[],
): Promise<FirstPlayableBudget> {
  const records: ReleaseAssetRecord[] = [
    Object.freeze({
      path: "/",
      kind: "html",
      phase: "critical",
      rawBytes: SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
      estimatedTransferBytes: SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
      transferEncoding: "reserved",
      sha256: null,
    }),
  ];

  const emittedTextFiles = (await filesBelow(resolve(clientOutputDirectory, "assets")))
    .filter(isTextAsset);
  for (const pathname of emittedTextFiles) {
    const extension = extname(pathname);
    records.push(await fileRecord(
      pathname,
      `/${toPosixPath(relative(clientOutputDirectory, pathname))}`,
      extension === ".css" ? "css" : "javascript",
      "critical",
    ));
  }

  const seenRuntimePaths = new Set<string>();
  for (const preload of preloads) {
    const relativePath = runtimePath(preload.href);
    if (seenRuntimePaths.has(relativePath)) {
      throw new Error(`Duplicate first-campaign preload: /${relativePath}`);
    }
    seenRuntimePaths.add(relativePath);
    const pathname = resolve(clientOutputDirectory, relativePath);
    if (!(await exists(pathname))) {
      throw new Error(`First-campaign preload was not emitted: /${relativePath}`);
    }
    records.push(await fileRecord(
      pathname,
      `/${relativePath}`,
      runtimeKind(preload),
      preload.blocksFirstPlayable ? "critical" : "eager",
    ));
  }

  records.sort((left, right) => left.path.localeCompare(right.path));
  const criticalBytes = records
    .filter((asset) => asset.phase === "critical")
    .reduce((total, asset) => total + asset.estimatedTransferBytes, 0);
  const eagerBytes = records.reduce(
    (total, asset) => total + asset.estimatedTransferBytes,
    0,
  );

  if (criticalBytes > MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES) {
    throw new Error(
      `Critical first-playable transfer ${criticalBytes} exceeds `
      + `${MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES} bytes`,
    );
  }
  if (eagerBytes > MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES) {
    throw new Error(
      `Eager first-campaign transfer ${eagerBytes} exceeds `
      + `${MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES} bytes`,
    );
  }

  return Object.freeze({
    measurement: "encoded-transfer-bytes",
    dynamicHtmlReserveBytes: SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
    maximumCriticalBytes: MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES,
    maximumEagerBytes: MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES,
    criticalBytes,
    eagerBytes,
    remainingCriticalBytes:
      MAX_CRITICAL_FIRST_PLAYABLE_TRANSFER_BYTES - criticalBytes,
    remainingEagerBytes:
      MAX_EAGER_FIRST_CAMPAIGN_TRANSFER_BYTES - eagerBytes,
    assets: Object.freeze(records),
  });
}

function removeBasisAssetReferences(
  value: unknown,
  removed: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => (
        typeof entry !== "string"
        || (!removed.has(entry) && !BASIS_TRANSCODER_OUTPUT.test(entry))
      ))
      .map((entry) => removeBasisAssetReferences(entry, removed));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (removed.has(key) || BASIS_TRANSCODER_OUTPUT.test(key)) continue;
      if (
        entry
        && typeof entry === "object"
        && "file" in entry
        && typeof entry.file === "string"
        && BASIS_TRANSCODER_OUTPUT.test(entry.file)
      ) {
        continue;
      }
      result[key] = removeBasisAssetReferences(entry, removed);
    }
    return result;
  }
  return value;
}

async function pruneServerLazyChunkReferences(
  serverEntry: string,
  removed: ReadonlySet<string>,
): Promise<void> {
  if (!(await exists(serverEntry))) return;
  const source = await readFile(serverEntry, "utf8");
  const assignment =
    /globalThis\.__VINEXT_LAZY_CHUNKS__\s*=\s*(\[[^;]*\]);/u;
  const match = source.match(assignment);
  if (!match) return;
  const chunks = JSON.parse(match[1]) as unknown;
  if (!Array.isArray(chunks) || !chunks.every((chunk) => typeof chunk === "string")) {
    throw new Error("vinext lazy-chunk manifest is not a string array");
  }
  const retained = chunks.filter((chunk) => (
    !removed.has(chunk) && !BASIS_TRANSCODER_OUTPUT.test(chunk)
  ));
  if (retained.length === chunks.length) return;
  await writeFile(
    serverEntry,
    source.replace(assignment, `globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(retained)};`),
  );
}

/**
 * Vite emits Three.js' fallback Basis binaries even though the app pins
 * KTX2Loader to `/basis/`. `renderBuiltUrl` rewrites those fallback URLs to the
 * canonical public copies before chunk hashing; this pass then removes only
 * byte-identical redundant files and their generated manifest references.
 */
export async function deduplicateBasisTranscoder(
  clientOutputDirectory: string,
  serverEntry: string,
): Promise<readonly string[]> {
  const assetsDirectory = resolve(clientOutputDirectory, "assets");
  const candidates = (await filesBelow(assetsDirectory))
    .map((pathname) => ({
      pathname,
      relativePath: toPosixPath(relative(clientOutputDirectory, pathname)),
    }))
    .filter(({ relativePath }) => BASIS_TRANSCODER_OUTPUT.test(relativePath));
  const removed = new Set<string>();
  for (const candidate of candidates) {
    const extension = extname(candidate.pathname);
    const canonical = resolve(
      clientOutputDirectory,
      "basis",
      `basis_transcoder${extension}`,
    );
    const [candidateBytes, canonicalBytes] = await Promise.all([
      readFile(candidate.pathname),
      readFile(canonical),
    ]);
    if (!candidateBytes.equals(canonicalBytes)) {
      throw new Error(
        `${candidate.relativePath} differs from basis/basis_transcoder${extension}`,
      );
    }
    removed.add(candidate.relativePath);
    await rm(candidate.pathname);
  }

  const viteManifest = resolve(clientOutputDirectory, ".vite", "manifest.json");
  if (await exists(viteManifest)) {
    const manifest = JSON.parse(await readFile(viteManifest, "utf8")) as unknown;
    const pruned = removeBasisAssetReferences(manifest, removed);
    await writeFile(viteManifest, `${JSON.stringify(pruned, null, 2)}\n`);
  }
  await pruneServerLazyChunkReferences(serverEntry, removed);
  return Object.freeze([...removed].sort());
}

export function assertFirstPlayableBudget(
  budget: FirstPlayableBudget,
): void {
  if (budget.measurement !== "encoded-transfer-bytes") {
    throw new Error("First-playable budget has an unsupported measurement");
  }
  if (budget.criticalBytes > budget.maximumCriticalBytes) {
    throw new Error("Critical first-playable transfer exceeds its budget");
  }
  if (budget.eagerBytes > budget.maximumEagerBytes) {
    throw new Error("Eager first-campaign transfer exceeds its budget");
  }
  for (const requiredKind of [
    "html",
    "javascript",
    "css",
    "wasm",
    "model",
  ] satisfies ReleaseAssetKind[]) {
    if (!budget.assets.some((asset) => asset.kind === requiredKind)) {
      throw new Error(`First-playable budget omits ${requiredKind}`);
    }
  }
}
