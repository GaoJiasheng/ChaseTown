#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.CHASING_QA_URL ?? "http://localhost:4173/";
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9223);
const OUTPUT = path.resolve(
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-character-bootstrap-visual-qa",
);
const CANONICAL_REPORT = process.env.CHASING_QA_REPORT
  ? path.resolve(process.env.CHASING_QA_REPORT)
  : null;
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (payload) => createHash("sha256").update(payload).digest("hex");

async function connect() {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  } catch (error) {
    throw new Error(
      `Chrome DevTools is unavailable on ${DEBUG_PORT}; launch Chrome with --remote-debugging-port`,
      { cause: error },
    );
  }
  const target = targets.find((entry) => entry.type === "page");
  assert.ok(target, "Chrome has no page target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) {
      events.push(message);
      return;
    }
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
  await Promise.all([
    send("Runtime.enable"),
    send("Page.enable"),
    send("Network.enable"),
    send("Log.enable"),
  ]);
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
  const waitFor = async (expression, timeout = 60_000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const value = await evaluate(expression);
      if (value) return value;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  return { socket, events, send, evaluate, waitFor };
}

const documentHtml = String.raw`
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
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
      min-height: 100vh;
      color: #f4f8ff;
      background:
        radial-gradient(circle at 50% 0%, rgba(44, 94, 138, .28), transparent 52%),
        linear-gradient(145deg, #071019, #111a25);
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    header { padding: 24px 34px 14px; }
    h1 { margin: 0; font-size: 25px; letter-spacing: .02em; }
    p { margin: 8px 0 0; color: #9fb4c8; font-size: 13px; }
    main {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 16px;
      padding: 0 34px 28px;
    }
    section {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      padding: 13px;
      border: 1px solid rgba(132, 183, 222, .25);
      border-radius: 16px;
      background: rgba(14, 27, 40, .72);
      box-shadow: 0 18px 45px rgba(0, 0, 0, .23);
    }
    section h2 {
      grid-column: 1 / -1;
      margin: 0 2px 2px;
      font-size: 14px;
      color: #dbeeff;
    }
    article {
      overflow: hidden;
      border-radius: 11px;
      border: 1px solid rgba(255, 255, 255, .08);
      background:
        radial-gradient(circle at 50% 35%, rgba(97, 139, 169, .23), transparent 56%),
        #09131d;
    }
    canvas { display: block; width: 100%; aspect-ratio: 1; }
    label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px 10px;
      font-size: 12px;
      color: #aac0d2;
    }
    label strong { color: #ecf7ff; font-weight: 650; }
    #metrics {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px;
      margin-top: 1px;
    }
    #metrics div {
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(75, 134, 177, .12);
      font-size: 12px;
      color: #afc7d9;
    }
    #metrics strong { color: #7ee0bb; }
  </style>
</head>
<body>
  <header>
    <h1>首帧角色视觉回归</h1>
    <p>同一 Idle 动画时刻 · 同一相机与灯光 · 实际 Meshopt + KTX2 浏览器解码</p>
  </header>
  <main>
    <section data-role="kid">
      <h2>玩家角色</h2>
      <article><canvas id="kid-reference" width="320" height="320"></canvas><label><strong>LOD1</strong><span>参考</span></label></article>
      <article><canvas id="kid-bootstrap" width="320" height="320"></canvas><label><strong>Bootstrap</strong><span>首帧</span></label></article>
    </section>
    <section data-role="villain">
      <h2>追逐者</h2>
      <article><canvas id="villain-reference" width="320" height="320"></canvas><label><strong>LOD1</strong><span>参考</span></label></article>
      <article><canvas id="villain-bootstrap" width="320" height="320"></canvas><label><strong>Bootstrap</strong><span>首帧</span></label></article>
    </section>
    <section data-role="police">
      <h2>警察角色</h2>
      <article><canvas id="police-reference" width="320" height="320"></canvas><label><strong>Original</strong><span>参考</span></label></article>
      <article><canvas id="police-bootstrap" width="320" height="320"></canvas><label><strong>Bootstrap</strong><span>首帧</span></label></article>
    </section>
    <div id="metrics"></div>
  </main>
  <script type="module">
    import * as THREE from "three";
    import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
    import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
    import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

    const base = new URL("/", location.href);
    const specifications = [
      { id: "kid-reference", role: "kid", variant: "reference", file: "kid-lod1.glb" },
      { id: "kid-bootstrap", role: "kid", variant: "bootstrap", file: "kid-bootstrap.glb" },
      { id: "villain-reference", role: "villain", variant: "reference", file: "villain-lod1.glb" },
      { id: "villain-bootstrap", role: "villain", variant: "bootstrap", file: "villain-bootstrap.glb" },
      { id: "police-reference", role: "police", variant: "reference", file: "police.glb" },
      { id: "police-bootstrap", role: "police", variant: "bootstrap", file: "police-bootstrap.glb" }
    ];
    const pixels = new Map();

    async function render(specification) {
      const canvas = document.getElementById(specification.id);
      if (!canvas) throw new Error("Missing QA canvas: " + specification.id);
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance"
      });
      renderer.setPixelRatio(1);
      renderer.setSize(320, 320, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.setClearColor(0x000000, 0);

      const ktx2 = new KTX2Loader()
        .setTranscoderPath("https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/libs/basis/")
        .detectSupport(renderer);
      const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      const url = new URL("/models/characters/" + specification.file, base);
      const gltf = await loader.loadAsync(url.href);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xb9ddff, 0x202531, 2.15));
      const key = new THREE.DirectionalLight(0xffe2c1, 4.4);
      key.position.set(3.5, 5.5, 4.5);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x62a9ff, 2.5);
      rim.position.set(-4, 3, -4);
      scene.add(rim);
      scene.add(gltf.scene);

      const idle = gltf.animations.find((clip) => clip.name === "Idle");
      if (idle) {
        const mixer = new THREE.AnimationMixer(gltf.scene);
        mixer.clipAction(idle).play();
        mixer.setTime(idle.duration * 0.37);
      }
      gltf.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(gltf.scene);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 100);
      const distance = Math.max(size.y * 2.15, size.x * 3.2, 3);
      camera.position.set(center.x + distance * 0.2, center.y + size.y * 0.04, center.z + distance);
      camera.lookAt(center.x, center.y + size.y * 0.025, center.z);
      renderer.render(scene, camera);
      pixels.set(specification.id, renderer.getContext().readPixels
        ? (() => {
            const data = new Uint8Array(320 * 320 * 4);
            renderer.getContext().readPixels(
              0, 0, 320, 320,
              renderer.getContext().RGBA,
              renderer.getContext().UNSIGNED_BYTE,
              data
            );
            return data;
          })()
        : null);
      ktx2.dispose();
    }

    function compare(referenceId, candidateId) {
      const reference = pixels.get(referenceId);
      const candidate = pixels.get(candidateId);
      let intersection = 0;
      let union = 0;
      let absoluteError = 0;
      let colourSamples = 0;
      for (let index = 0; index < reference.length; index += 4) {
        const referenceVisible = reference[index + 3] > 8;
        const candidateVisible = candidate[index + 3] > 8;
        if (referenceVisible || candidateVisible) union += 1;
        if (referenceVisible && candidateVisible) intersection += 1;
        if (referenceVisible && candidateVisible) {
          absoluteError += Math.abs(reference[index] - candidate[index]);
          absoluteError += Math.abs(reference[index + 1] - candidate[index + 1]);
          absoluteError += Math.abs(reference[index + 2] - candidate[index + 2]);
          colourSamples += 3;
        }
      }
      return {
        silhouetteIou: union ? intersection / union : 0,
        rgbMeanAbsoluteError: colourSamples ? absoluteError / colourSamples : 255
      };
    }

    try {
      for (const specification of specifications) await render(specification);
      const result = {
        kid: compare("kid-reference", "kid-bootstrap"),
        villain: compare("villain-reference", "villain-bootstrap"),
        police: compare("police-reference", "police-bootstrap")
      };
      const metrics = document.getElementById("metrics");
      metrics.innerHTML = Object.entries(result).map(([role, values]) =>
        "<div><strong>" + role + "</strong> · silhouette IoU "
        + values.silhouetteIou.toFixed(5)
        + " · RGB MAE " + values.rgbMeanAbsoluteError.toFixed(3) + "</div>"
      ).join("");
      window.__characterBootstrapQa = result;
      window.__characterBootstrapReady = true;
    } catch (error) {
      window.__characterBootstrapError = String(error?.stack || error);
      window.__characterBootstrapReady = true;
    }
  </script>
</body>
</html>`;

await mkdir(OUTPUT, { recursive: true });
const browser = await connect();
try {
  await browser.send("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await browser.send("Page.navigate", { url: BASE_URL });
  await browser.waitFor("document.readyState === 'complete'", 30_000);
  const frameTree = await browser.send("Page.getFrameTree");
  await browser.send("Page.setDocumentContent", {
    frameId: frameTree.frameTree.frame.id,
    html: documentHtml,
  });
  await browser.waitFor("window.__characterBootstrapReady === true", 90_000);
  const error = await browser.evaluate("window.__characterBootstrapError || null");
  assert.equal(error, null, error);
  const result = await browser.evaluate("window.__characterBootstrapQa");
  console.log(JSON.stringify({ result }, null, 2));
  const screenshot = await browser.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const screenshotPath = path.join(OUTPUT, "character-bootstrap-comparison.png");
  const screenshotPayload = Buffer.from(screenshot.data, "base64");
  await writeFile(screenshotPath, screenshotPayload);
  for (const [role, metrics] of Object.entries(result)) {
    assert.ok(metrics.silhouetteIou >= 0.9999, `${role} silhouette IoU regressed`);
    assert.ok(metrics.rgbMeanAbsoluteError <= 1, `${role} colour delta is too high`);
  }
  const assets = {};
  const referenceFiles = {
    kid: "kid-lod1.glb",
    villain: "villain-lod1.glb",
    police: "police.glb",
  };
  for (const role of Object.keys(referenceFiles)) {
    assets[role] = {};
    for (const variant of ["reference", "bootstrap"]) {
      const basename = variant === "reference"
        ? referenceFiles[role]
        : `${role}-bootstrap.glb`;
      const relative = `public/models/characters/${basename}`;
      const payload = await readFile(path.join(ROOT, relative));
      assets[role][variant] = {
        path: relative,
        bytes: payload.length,
        sha256: sha256(payload),
      };
    }
  }
  const report = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    method: "Chromium WebGL2; actual Three.js Meshopt and KTX2 decode; matched Idle pose, camera, lights and exposure.",
    url: BASE_URL,
    viewport: VIEWPORT,
    assets,
    result,
    gates: { minimumSilhouetteIou: 0.9999, maximumRgbMeanAbsoluteError: 1 },
    screenshotSha256: sha256(screenshotPayload),
    screenshot: screenshotPath,
  };
  await writeFile(
    path.join(OUTPUT, "character-bootstrap-visual-qa.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (CANONICAL_REPORT) {
    await mkdir(path.dirname(CANONICAL_REPORT), { recursive: true });
    await writeFile(CANONICAL_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  browser.socket.close();
}
