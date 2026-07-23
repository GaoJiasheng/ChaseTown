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
  process.env.CHASING_QA_OUT ?? "/tmp/chasing-theme-bootstrap-visual-qa",
);
const CANONICAL_REPORT = process.env.CHASING_QA_REPORT
  ? path.resolve(process.env.CHASING_QA_REPORT)
  : null;
const VIEWPORT = { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false };
const THEMES = ["campus", "hospital", "fire-station", "factory"];
const CAMPUS_REPRESENTATIVE = process.env.CHASING_QA_CAMPUS_NODE ?? "CampusVendingMachine";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (payload) => createHash("sha256").update(payload).digest("hex");

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page");
  assert.ok(target, "Chrome has no inspectable page target");
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

const cards = THEMES.map((theme) => `
  <section>
    <h2>${theme}</h2>
    <article><canvas id="${theme}-source" width="260" height="260"></canvas><label>原主题</label></article>
    <article><canvas id="${theme}-bootstrap" width="260" height="260"></canvas><label>首帧</label></article>
    <div class="metric" id="${theme}-metric">待测</div>
  </section>
`).join("");

const documentHtml = String.raw`
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
      color: #f0f7fb;
      background:
        radial-gradient(circle at 50% 0%, rgba(46, 91, 119, .3), transparent 48%),
        #07111a;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    header { padding: 20px 32px 13px; }
    h1 { margin: 0; font-size: 24px; }
    header p { margin: 7px 0 0; color: #9fb6c7; font-size: 13px; }
    main {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 13px;
      padding: 0 32px 26px;
    }
    section {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 9px;
      padding: 11px;
      border: 1px solid rgba(135, 187, 215, .24);
      border-radius: 15px;
      background: rgba(13, 27, 39, .75);
    }
    h2 { grid-column: 1 / -1; margin: 0 2px; font-size: 14px; text-transform: uppercase; }
    article {
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, .08);
      border-radius: 10px;
      background: radial-gradient(circle at 50% 46%, #1e3442, #09141d 67%);
    }
    canvas { display: block; width: 100%; height: 260px; }
    label { display: block; padding: 6px 9px 8px; color: #b5cad8; font-size: 11px; }
    .metric {
      grid-column: 1 / -1;
      padding: 8px 10px;
      border-radius: 9px;
      color: #87e2bd;
      background: rgba(63, 127, 164, .13);
      font-size: 11px;
    }
  </style>
</head>
<body>
  <header>
    <h1>主题首帧视觉回归</h1>
    <p>实际 Meshopt + KTX2 解码 · 同一相机/灯光 · 验证图集 UV、PBR 与量化轮廓</p>
  </header>
  <main>${cards}</main>
  <script type="module">
    import * as THREE from "three";
    import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
    import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
    import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

    const themes = ${JSON.stringify(THEMES)};
    const representatives = {
      campus: ${JSON.stringify(CAMPUS_REPRESENTATIVE)},
      hospital: "HospitalBed",
      "fire-station": "FireEngine",
      factory: "FactoryControlConsole"
    };
    const captures = new Map();

    async function render(theme, variant) {
      const canvas = document.getElementById(theme + "-" + variant);
      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
        powerPreference: "high-performance"
      });
      renderer.setPixelRatio(1);
      renderer.setSize(260, 260, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      renderer.setClearColor(0, 0);
      const ktx2 = new KTX2Loader()
        .setTranscoderPath("https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/libs/basis/")
        .detectSupport(renderer);
      const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      const suffix = variant === "source" ? "-kit.glb" : "-kit-bootstrap.glb";
      const gltf = await loader.loadAsync("/models/environment/themes/" + theme + suffix);
      const scene = new THREE.Scene();
      const hemi = new THREE.HemisphereLight(0xc6e6ff, 0x24313a, 2.3);
      scene.add(hemi);
      const key = new THREE.DirectionalLight(0xffddb5, 4.5);
      key.position.set(5, 7, 6);
      scene.add(key);
      const rim = new THREE.DirectionalLight(0x65b8ff, 2.2);
      rim.position.set(-5, 4, -4);
      scene.add(rim);
      const authored = gltf.scene.getObjectByName(representatives[theme]);
      if (!authored) throw new Error(theme + " lost " + representatives[theme]);
      const model = authored.clone(true);
      model.position.set(0, 0, 0);
      model.rotation.set(0, 0, 0);
      model.scale.copy(authored.scale);
      scene.add(model);
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 1000);
      const span = Math.max(size.x, size.y, size.z, 1);
      camera.position.set(
        center.x + span * 1.15,
        center.y + span * 0.72,
        center.z + span * 1.35
      );
      camera.lookAt(center);
      renderer.render(scene, camera);
      const data = new Uint8Array(260 * 260 * 4);
      const context = renderer.getContext();
      context.readPixels(0, 0, 260, 260, context.RGBA, context.UNSIGNED_BYTE, data);
      captures.set(theme + "-" + variant, data);
      ktx2.dispose();
    }

    function compare(theme) {
      const reference = captures.get(theme + "-source");
      const candidate = captures.get(theme + "-bootstrap");
      let intersection = 0;
      let union = 0;
      let error = 0;
      let samples = 0;
      for (let index = 0; index < reference.length; index += 4) {
        const a = reference[index + 3] > 8;
        const b = candidate[index + 3] > 8;
        if (a || b) union += 1;
        if (a && b) {
          intersection += 1;
          error += Math.abs(reference[index] - candidate[index]);
          error += Math.abs(reference[index + 1] - candidate[index + 1]);
          error += Math.abs(reference[index + 2] - candidate[index + 2]);
          samples += 3;
        }
      }
      return {
        silhouetteIou: union ? intersection / union : 0,
        rgbMeanAbsoluteError: samples ? error / samples : 255
      };
    }

    try {
      for (const theme of themes) {
        await render(theme, "source");
        await render(theme, "bootstrap");
      }
      const result = Object.fromEntries(themes.map((theme) => [theme, compare(theme)]));
      for (const [theme, metric] of Object.entries(result)) {
        document.getElementById(theme + "-metric").textContent =
          "silhouette IoU " + metric.silhouetteIou.toFixed(5)
          + " · RGB MAE " + metric.rgbMeanAbsoluteError.toFixed(3);
      }
      window.__themeBootstrapQa = result;
      window.__themeBootstrapReady = true;
    } catch (error) {
      window.__themeBootstrapError = String(error?.stack || error);
      window.__themeBootstrapReady = true;
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
  await browser.waitFor("window.__themeBootstrapReady === true");
  const error = await browser.evaluate("window.__themeBootstrapError || null");
  assert.equal(error, null, error);
  const result = await browser.evaluate("window.__themeBootstrapQa");
  console.log(JSON.stringify({ result }, null, 2));
  const screenshot = await browser.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const screenshotPayload = Buffer.from(screenshot.data, "base64");
  const screenshotPath = path.join(OUTPUT, "theme-bootstrap-comparison.png");
  await writeFile(screenshotPath, screenshotPayload);
  const gates = { minimumSilhouetteIou: 0.9995, maximumRgbMeanAbsoluteError: 3 };
  for (const [theme, metrics] of Object.entries(result)) {
    assert.ok(metrics.silhouetteIou >= gates.minimumSilhouetteIou, `${theme} silhouette drifted`);
    assert.ok(
      metrics.rgbMeanAbsoluteError <= gates.maximumRgbMeanAbsoluteError,
      `${theme} PBR colour delta is too high`,
    );
  }
  const assetReport = JSON.parse(
    await readFile(path.join(ROOT, "art-source", "reports", "theme-bootstrap.json"), "utf8"),
  );
  const assets = Object.fromEntries(
    assetReport.themes.map((entry) => [
      entry.theme,
      { source: entry.source, bootstrap: entry.bootstrap },
    ]),
  );
  const report = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    method: "Chromium WebGL2; actual Three.js Meshopt and KTX2 decode; matched camera, lights and exposure.",
    url: BASE_URL,
    viewport: VIEWPORT,
    assets,
    atlases: assetReport.atlases,
    result,
    gates,
    screenshotSha256: sha256(screenshotPayload),
    screenshot: screenshotPath,
  };
  await writeFile(
    path.join(OUTPUT, "theme-bootstrap-visual-qa.json"),
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
