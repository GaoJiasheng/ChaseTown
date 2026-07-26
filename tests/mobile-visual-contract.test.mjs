import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const deepQa = await readFile(
  new URL("../scripts/deep-gameplay-visual-qa.mjs", import.meta.url),
  "utf8",
);
const libraryGoldQa = await readFile(
  new URL("../scripts/library-gold-visual-qa.mjs", import.meta.url),
  "utf8",
);

test("mobile ready screen keeps its primary action ahead of optional setup", () => {
  assert.match(css, /\.overlay\.ready \.overlay-actions\s*\{[^}]*order:\s*4;/s);
  assert.match(css, /\.overlay\.ready \.preference-settings\s*\{\s*order:\s*5;/s);
  assert.match(
    css,
    /\.overlay\.ready \.overlay-actions \.primary\s*\{[^}]*min-height:\s*52px;/s,
  );
  assert.match(css, /\.preference-settings > p\s*\{\s*display:\s*none;/s);
});

test("mobile secondary guidance uses corner instruments instead of text rows", () => {
  assert.match(
    css,
    /\.hide-guide,\s*\.objective-route-guide\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s,
  );
  assert.match(
    css,
    /\.hide-guide > div,\s*\.objective-route-guide > div\s*\{\s*display:\s*none;/s,
  );
  assert.match(css, /\.hide-edge-marker\.onscreen\s*\{[^}]*translateY\(-66px\)/s);
});

test("narrow-screen action lane clears the centered camera-control strip", () => {
  assert.match(
    css,
    /\.action-controls\s*\{\s*right:\s*10px;\s*bottom:\s*66px;\s*\}/s,
  );
  assert.match(
    css,
    /\.view-controls\s*\{\s*right:\s*50%;\s*bottom:\s*168px;\s*padding:\s*3px;\s*\}/s,
  );
  assert.match(
    css,
    /\.playfield:has\(\.interaction-prompt\) \.view-controls,\s*\.playfield\.mission-commitment-active \.view-controls\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s,
  );
  assert.match(css, /\.interaction-prompt\s*\{\s*display:\s*none;\s*\}/s);
});

test("hard locker mask cannot leak into soft and traversal cover", () => {
  assert.match(
    css,
    /\.cinematic-vignette::before\s*\{[^}]*opacity:\s*var\(--hard-locker-cover\)/s,
  );
  assert.match(
    css,
    /\.cinematic-vignette::after\s*\{[^}]*opacity:\s*var\(--hard-locker-peek\)/s,
  );
  assert.match(
    css,
    /\.hide-soft-cover \.cinematic-vignette::before\s*\{[^}]*var\(--locker-cover\)\s*\*\s*\.42/s,
  );
  assert.match(
    css,
    /\.hide-traversal-hide \.cinematic-vignette::before\s*\{[^}]*var\(--locker-cover\)\s*\*\s*\.52/s,
  );
  assert.match(
    css,
    /\.cinematic-vignette::after\s*\{[\s\S]*transparent 43%[\s\S]*rgba\(0,\s*1,\s*2,\s*\.82\) 100%/,
    "open locker peek must retain a broad, readable observation aperture",
  );
});

test("deep visual QA measures viewport visibility and both narrow phone sizes", () => {
  assert.match(deepQa, /const MOBILE_COMPACT = Object\.freeze\(\{\s*width:\s*360,\s*height:\s*800,/s);
  assert.match(deepQa, /const MOBILE = Object\.freeze\(\{\s*width:\s*390,\s*height:\s*844,/s);
  assert.match(deepQa, /const clippedRect = \(element\) =>/);
  assert.match(deepQa, /readyCta\.viewportCoverage >= 0\.99/);
  assert.match(
    deepQa,
    /coveredTargets:\s*targets\.filter\([\s\S]*target\.viewportCoverage\s*>=\s*0\.99\s*&&\s*!target\.hitTestable/,
  );
  assert.match(deepQa, /hudCoverageRatio <= 0\.18/);
  assert.match(deepQa, /playerCore\.occlusionRatio <= 0\.12/);
  assert.match(deepQa, /function hardLockerPeekStaging/);
  assert.match(deepQa, /peek\.knowledge\.chaserObservable/);
  assert.match(deepQa, /hard-locker peek pursuer/);
});

test("library Gold QA covers 360/390 interaction-ready and mid-commit layouts", () => {
  assert.match(
    libraryGoldQa,
    /\{\s*width:\s*360,\s*height:\s*800\s*\},\s*\{\s*width:\s*390,\s*height:\s*844\s*\}/s,
  );
  assert.match(libraryGoldQa, /mission interaction ready/);
  assert.match(libraryGoldQa, /mission commitment/);
  assert.match(libraryGoldQa, /promptAndAction:\s*overlaps\(interactionPrompt,\s*actionControls\)/);
  assert.match(libraryGoldQa, /coveredTargets/);
});
