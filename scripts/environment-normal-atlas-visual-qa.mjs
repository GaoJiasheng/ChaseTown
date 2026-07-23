#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.CHASING_QA_URL ?? "http://localhost:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-environment-normal-visual-qa",
);
const CANONICAL_REPORT = process.env.CHASING_QA_REPORT
  ? path.resolve(process.env.CHASING_QA_REPORT)
  : null;
const REFERENCE_ATLAS = path.resolve(
  process.env.CHASING_NORMAL_REFERENCE
    ?? "/private/tmp/chasing-environment-normal-atlas-512-reference.ktx2",
);
const VIEWPORT = { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false };
const ASSETS = ["locker", "tree", "desk-chair", "police-car"];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (payload) => createHash("sha256").update(payload).digest("hex");

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page");
  assert.ok(target, "Chrome has no inspectable page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await Promise.all([send("Runtime.enable"), send("Page.enable"), send("Network.enable")]);
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    }
    return response.result.value;
  };
  const waitFor = async (expression, timeout = 90_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  return { socket, send, evaluate, waitFor };
}

function referenceServer(payload) {
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/normal-reference.ktx2") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "image/ktx2");
      response.end(payload);
      return;
    }
    response.statusCode = 404;
    response.end("Not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/normal-reference.ktx2`,
      });
    });
  });
}

const cards = ASSETS.map((asset) => `
  <section>
    <h2>${asset}</h2>
    <article><canvas id="${asset}-reference" width="280" height="280"></canvas><label>512px/tile 参考</label></article>
    <article><canvas id="${asset}-compact" width="280" height="280"></canvas><label>256px/tile 首帧</label></article>
    <div id="${asset}-metric" class="metric">待测</div>
  </section>
`).join("");

function html(referenceAtlasUrl) {
  return String.raw`
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/"
      }
    }
  </script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #f1f8fc;
      background: radial-gradient(circle at 50% 0%, #17354a, #07111a 55%);
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    header { padding: 20px 32px 12px; }
    h1 { margin: 0; font-size: 24px; }
    header p { margin: 7px 0 0; color: #a5bbca; font-size: 13px; }
    main {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 13px;
      padding: 0 32px 24px;
    }
    section {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
      padding: 11px;
      border: 1px solid rgba(137, 190, 219, .24);
      border-radius: 15px;
      background: rgba(12, 27, 39, .78);
    }
    h2 { grid-column: 1 / -1; margin: 0 2px; font-size: 14px; text-transform: uppercase; }
    article {
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, .08);
      border-radius: 10px;
      background: radial-gradient(circle at 50% 45%, #294658, #09141d 68%);
    }
    canvas { display: block; width: 100%; height: 280px; }
    label { display: block; padding: 6px 9px 8px; color: #b6cbd8; font-size: 11px; }
    .metric {
      grid-column: 1 / -1;
      padding: 8px 10px;
      border-radius: 9px;
      color: #82e0b9;
      background: rgba(64, 132, 168, .14);
      font-size: 11px;
    }
  </style>
</head>
<body>
  <header>
    <h1>Standalone 法线图集回归</h1>
    <p>仅替换 Normal atlas · 相同几何/BaseColor/UV · 实际 Meshopt + KTX2 WebGL2 解码</p>
  </header>
  <main>${cards}</main>
  <script type="module">
    import * as THREE from "three";
    import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
    import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
    import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

    const assets = ${JSON.stringify(ASSETS)};
    const referenceAtlasUrl = ${JSON.stringify(referenceAtlasUrl)};
    const captures = new Map();

    function patchedReferenceGlb(buffer, assetUrl) {
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      const chunks = [];
      for (let offset = 12; offset + 8 <= bytes.length;) {
        const length = view.getUint32(offset, true);
        const type = view.getUint32(offset + 4, true);
        chunks.push({ type, payload: bytes.slice(offset + 8, offset + 8 + length) });
        offset += 8 + length;
      }
      const jsonChunk = chunks.find((chunk) => chunk.type === 0x4e4f534a);
      const json = JSON.parse(new TextDecoder().decode(jsonChunk.payload).replace(/[\u0000 ]+$/u, ""));
      for (const image of json.images ?? []) {
        const textureClass = image.extras?.chasing_atlas_class;
        if (textureClass === "normal") image.uri = referenceAtlasUrl;
        else image.uri = new URL(image.uri, assetUrl).href;
      }
      let jsonPayload = new TextEncoder().encode(JSON.stringify(json));
      const jsonPadding = (4 - jsonPayload.length % 4) % 4;
      if (jsonPadding) {
        const padded = new Uint8Array(jsonPayload.length + jsonPadding);
        padded.set(jsonPayload);
        padded.fill(0x20, jsonPayload.length);
        jsonPayload = padded;
      }
      const outputChunks = [{ type: 0x4e4f534a, payload: jsonPayload }, ...chunks.filter(
        (chunk) => chunk.type !== 0x4e4f534a
      )];
      const total = 12 + outputChunks.reduce((sum, chunk) => sum + 8 + chunk.payload.length, 0);
      const output = new Uint8Array(total);
      const header = new DataView(output.buffer);
      output.set(new TextEncoder().encode("glTF"), 0);
      header.setUint32(4, 2, true);
      header.setUint32(8, total, true);
      let offset = 12;
      for (const chunk of outputChunks) {
        header.setUint32(offset, chunk.payload.length, true);
        header.setUint32(offset + 4, chunk.type, true);
        output.set(chunk.payload, offset + 8);
        offset += 8 + chunk.payload.length;
      }
      return URL.createObjectURL(new Blob([output], { type: "model/gltf-binary" }));
    }

    async function render(asset, variant) {
      const canvas = document.getElementById(asset + "-" + variant);
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance"
      });
      renderer.setPixelRatio(1);
      renderer.setSize(280, 280, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.setClearColor(0, 0);
      const ktx2 = new KTX2Loader()
        .setTranscoderPath("https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/libs/basis/")
        .detectSupport(renderer);
      const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      const assetUrl = new URL("/models/environment/" + asset + ".glb", location.href).href;
      let url = assetUrl;
      if (variant === "reference") {
        const source = await (await fetch(assetUrl, { cache: "no-store" })).arrayBuffer();
        url = patchedReferenceGlb(source, assetUrl);
      }
      const gltf = await loader.loadAsync(url);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xc9e8ff, 0x1f2931, 1.65));
      const key = new THREE.DirectionalLight(0xffddb7, 5.8);
      key.position.set(4.5, 6.5, 5.2);
      scene.add(key);
      const rake = new THREE.DirectionalLight(0x72bfff, 3.8);
      rake.position.set(-5.5, 2.2, -3.8);
      scene.add(rake);
      scene.add(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
      const span = Math.max(size.x, size.y, size.z, 0.5);
      camera.position.set(center.x + span * .85, center.y + span * .45, center.z + span * 1.5);
      camera.lookAt(center);
      renderer.render(scene, camera);
      const context = renderer.getContext();
      const data = new Uint8Array(280 * 280 * 4);
      context.readPixels(0, 0, 280, 280, context.RGBA, context.UNSIGNED_BYTE, data);
      captures.set(asset + "-" + variant, data);
      ktx2.dispose();
      if (variant === "reference") URL.revokeObjectURL(url);
    }

    function compare(asset) {
      const reference = captures.get(asset + "-reference");
      const compact = captures.get(asset + "-compact");
      let intersection = 0;
      let union = 0;
      let error = 0;
      let samples = 0;
      for (let index = 0; index < reference.length; index += 4) {
        const a = reference[index + 3] > 8;
        const b = compact[index + 3] > 8;
        if (a || b) union += 1;
        if (a && b) {
          intersection += 1;
          error += Math.abs(reference[index] - compact[index]);
          error += Math.abs(reference[index + 1] - compact[index + 1]);
          error += Math.abs(reference[index + 2] - compact[index + 2]);
          samples += 3;
        }
      }
      return {
        silhouetteIou: union ? intersection / union : 0,
        rgbMeanAbsoluteError: samples ? error / samples : 255
      };
    }

    try {
      for (const asset of assets) {
        await render(asset, "reference");
        await render(asset, "compact");
      }
      const result = Object.fromEntries(assets.map((asset) => [asset, compare(asset)]));
      for (const [asset, metric] of Object.entries(result)) {
        document.getElementById(asset + "-metric").textContent =
          "silhouette IoU " + metric.silhouetteIou.toFixed(5)
          + " · RGB MAE " + metric.rgbMeanAbsoluteError.toFixed(3);
      }
      window.__normalAtlasQa = result;
      window.__normalAtlasReady = true;
    } catch (error) {
      window.__normalAtlasError = String(error?.stack || error);
      window.__normalAtlasReady = true;
    }
  </script>
</body>
</html>`;
}

const referencePayload = await readFile(REFERENCE_ATLAS);
assert.equal(
  sha256(referencePayload),
  "af1ba34484dd71b92ab7df43bfdc5c6b665659c18a6a111b1007106553327d66",
);
await mkdir(OUTPUT, { recursive: true });
const served = await referenceServer(referencePayload);
const browser = await connect();
try {
  await browser.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await browser.send("Page.navigate", { url: BASE_URL });
  await browser.waitFor("document.readyState === 'complete'", 30_000);
  const frameTree = await browser.send("Page.getFrameTree");
  await browser.send("Page.setDocumentContent", {
    frameId: frameTree.frameTree.frame.id,
    html: html(served.url),
  });
  await browser.waitFor("window.__normalAtlasReady === true");
  const error = await browser.evaluate("window.__normalAtlasError || null");
  assert.equal(error, null, error);
  const result = await browser.evaluate("window.__normalAtlasQa");
  console.log(JSON.stringify({ result }, null, 2));
  const screenshot = await browser.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const screenshotPayload = Buffer.from(screenshot.data, "base64");
  const screenshotPath = path.join(OUTPUT, "environment-normal-atlas-comparison.png");
  await writeFile(screenshotPath, screenshotPayload);
  const gates = { minimumSilhouetteIou: 0.9999, maximumRgbMeanAbsoluteError: 1 };
  for (const [asset, metrics] of Object.entries(result)) {
    assert.ok(metrics.silhouetteIou >= gates.minimumSilhouetteIou, `${asset} silhouette drifted`);
    assert.ok(
      metrics.rgbMeanAbsoluteError <= gates.maximumRgbMeanAbsoluteError,
      `${asset} Normal detail delta is too high`,
    );
  }
  const assetReport = JSON.parse(
    await readFile(
      path.join(ROOT, "art-source", "reports", "environment-bootstrap-ktx2.json"),
      "utf8",
    ),
  );
  const compactAtlas = assetReport.atlases.find(
    ({ textureClass }) => textureClass === "normal",
  );
  const report = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    method: "Chromium WebGL2; same GLB/BaseColor/UV with only the external Normal atlas URI changed.",
    url: BASE_URL,
    viewport: VIEWPORT,
    referenceAtlas: {
      bytes: referencePayload.length,
      sha256: sha256(referencePayload),
      width: 2112,
      height: 1584,
      tilePixels: 512,
      gutterPixels: 8,
    },
    compactAtlas,
    assets: Object.fromEntries(
      ASSETS.map((asset) => {
        const entry = assetReport.assets.find(
          ({ path: assetPath }) => path.basename(assetPath) === `${asset}.glb`,
        );
        return [asset, { path: entry.path, bytes: entry.output.bytes, sha256: entry.output.sha256 }];
      }),
    ),
    result,
    gates,
    screenshotSha256: sha256(screenshotPayload),
    screenshot: screenshotPath,
  };
  await writeFile(
    path.join(OUTPUT, "environment-normal-atlas-visual-qa.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (CANONICAL_REPORT) {
    await mkdir(path.dirname(CANONICAL_REPORT), { recursive: true });
    await writeFile(CANONICAL_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  browser.socket.close();
  await new Promise((resolve) => served.server.close(resolve));
}
