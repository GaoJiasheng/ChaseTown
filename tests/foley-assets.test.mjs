import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

import { FOLEY_ASSET_URLS } from "../app/game/audio/immersive-soundscape.ts";

test("every declared production Foley sample exists and is attributed as CC0", async () => {
  const declared = Object.values(FOLEY_ASSET_URLS).flat();
  assert.ok(declared.length >= 20, "the production bank should contain variant coverage");
  for (const url of declared) {
    const file = new URL(`../public${url}`, import.meta.url);
    await access(file);
    assert.ok((await stat(file)).size > 256, `${url} is unexpectedly empty`);
  }
  const manifest = JSON.parse(await readFile(
    new URL("../public/audio/foley/manifest.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.license, "CC0-1.0");
  const license = await readFile(
    new URL("../docs/licenses/KENNEY_AUDIO_CC0.md", import.meta.url),
    "utf8",
  );
  assert.match(license, /Kenney/i);
  assert.match(license, /CC0/i);
});
