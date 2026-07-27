import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
} from "../build/release-integrity.ts";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the Chasing game shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(
    Buffer.byteLength(html) <= SERVER_RENDERED_HTML_TRANSFER_RESERVE_BYTES,
    "server-rendered HTML exceeds the release manifest's transfer reserve",
  );
  assert.match(html, /<title>Chasing · 3D 主题逃生战役<\/title>/i);
  assert.match(html, /10 关电影化 3D 潜逃战役/);
  assert.match(html, /chasing-social-card-v3\.jpg/);
  assert.match(
    html,
    /玩家从精细建模的午夜医院储物柜中探身，避开正在最后目击点巡视的追捕者/,
  );
  assert.match(html, /3D 追逐模式/);
  assert.match(html, /正在载入项目美术资产/);
  assert.match(html, /WASD/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/);
});
