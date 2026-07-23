import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("large immutable runtime assets ship with an explicit browser cache policy", async () => {
  const headers = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
  for (const route of ["/models/*", "/audio/foley/*", "/audio/*.m4a", "/basis/*"]) {
    assert.match(headers, new RegExp(`${route.replaceAll("*", "\\*")}[\\s\\S]*?max-age=31536000[\\s\\S]*?immutable`));
  }
  assert.match(headers, /chasing-environment-key-art\.jpg[\s\S]*?stale-while-revalidate=86400/);
});
