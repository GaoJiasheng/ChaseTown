import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = await readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8");

test("first playable frame gates only on navigation-critical scene assets", () => {
  assert.match(SOURCE, /type DetailBuildPhase = "essential" \| "decorative"/);
  assert.match(SOURCE, /const essentialDetailEntries = \[\.\.\.essentialDetailNames\]/);
  assert.match(SOURCE, /const decorativeDetailEntries = \[\.\.\.requiredDetailNames\]/);
  assert.match(SOURCE, /const initialLoads = \[[\s\S]*\.\.\.essentialDetailEntries\.map/);
  assert.doesNotMatch(
    SOURCE.match(/const initialLoads = \[[\s\S]*?\n      \];/)?.[0] ?? "",
    /decorativeDetailEntries/,
  );
  assert.match(SOURCE, /Promise\.allSettled\(\s*decorativeDetailEntries\.map/);
  assert.match(SOURCE, /startDeferredDressingFade\(deferredDressing\)/);
  assert.match(SOURCE, /decorativeReady: decorativeAssetsReady/);
});

test("resolution actor streams near the exit and retains an immediate victory fallback", () => {
  assert.equal(
    SOURCE.match(/loadGlbWithRetry\(ACTOR_SPECS\.police\.url\)/g)?.length,
    1,
    "Police should have one memoized on-demand load path",
  );
  assert.match(SOURCE, /distanceBetween\(latestState\.player\.position, campaignLevel\.exit\)[\s\S]*POLICE_PREFETCH_DISTANCE_CELLS/);
  assert.match(SOURCE, /event\.to === "won"[\s\S]*requestAnimation\(actors\.kid!, "celebrate"/);
  assert.match(SOURCE, /event\.to === "won"[\s\S]*void requestPoliceAsset\?\.\(\)/);
});

test("runtime quality profiles control real rendering work", () => {
  assert.match(SOURCE, /renderQualityProfile\.occlusionProbeSeconds/);
  assert.match(SOURCE, /slice\(0, renderQualityProfile\.maximumDynamicLights\)/);
  assert.match(SOURCE, /renderQualityTier !== "mobile"/);
  assert.match(SOURCE, /renderedAtmosphereParticles = Math\.min/);
  assert.match(SOURCE, /for \(let index = 0; index < renderedAtmosphereParticles; index \+= 1\)/);
  assert.match(SOURCE, /atmosphereAttribute\.addUpdateRange\(0, renderedAtmosphereParticles \* 3\)/);
});
