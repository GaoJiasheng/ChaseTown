import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const deepQa = await readFile(
  new URL("../scripts/deep-gameplay-visual-qa.mjs", import.meta.url),
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
});

test("deep visual QA measures viewport visibility and both narrow phone sizes", () => {
  assert.match(deepQa, /const MOBILE_COMPACT = Object\.freeze\(\{\s*width:\s*360,\s*height:\s*800,/s);
  assert.match(deepQa, /const MOBILE = Object\.freeze\(\{\s*width:\s*390,\s*height:\s*844,/s);
  assert.match(deepQa, /const clippedRect = \(element\) =>/);
  assert.match(deepQa, /readyCta\.viewportCoverage >= 0\.99/);
  assert.match(deepQa, /hudCoverageRatio <= 0\.18/);
  assert.match(deepQa, /playerCore\.occlusionRatio <= 0\.12/);
});
