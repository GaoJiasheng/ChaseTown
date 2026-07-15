import assert from "node:assert/strict";
import test from "node:test";

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
  assert.match(html, /<title>Chasing · 逃出校园<\/title>/i);
  assert.match(html, /逃出校园/);
  assert.match(html, /3D 追逐模式/);
  assert.match(html, /正在载入项目美术资产/);
  assert.match(html, /WASD/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/);
});
