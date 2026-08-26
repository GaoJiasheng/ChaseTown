import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [css, layout] = await Promise.all([
  readFile(path.join(ROOT, "app", "globals.css"), "utf8"),
  readFile(path.join(ROOT, "app", "layout.tsx"), "utf8"),
]);

test("P3-3 playfield owns touch gestures without allowing page overscroll", () => {
  for (const selector of [".playfield", ".three-mount"]) {
    const escaped = selector.replace(".", "\\.");
    assert.match(
      css,
      new RegExp(`${escaped}\\s*\\{[^}]*touch-action\\s*:\\s*none[^}]*overscroll-behavior\\s*:\\s*none`, "u"),
      `${selector} must suppress browser pan, pinch, and overscroll gestures`,
    );
  }
});

test("P3-3 desktop and mobile shell padding respect all safe-area insets", () => {
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.equal(
      css.match(new RegExp(`env\\(safe-area-inset-${side},0px\\)`, "gu"))?.length,
      2,
      `${side} inset must be present in both base and mobile padding declarations`,
    );
  }
  assert.match(css, /@media \(max-width:800px\),\(pointer:coarse\)[\s\S]*\.game-shell\s*\{[^}]*safe-area-inset-top/u);
});

test("P3-3 enables edge-to-edge iOS layout without disabling user scaling", () => {
  assert.match(layout, /export const viewport:\s*Viewport\s*=\s*\{[\s\S]*viewportFit:\s*"cover"/u);
  assert.match(layout, /width:\s*"device-width"/u);
  assert.match(layout, /initialScale:\s*1/u);
  assert.doesNotMatch(layout, /maximumScale|minimumScale|userScalable/u);
});

test("P3-3 exposes a QA-only notch simulation for reproducible screenshots", () => {
  assert.match(css, /\.game-shell\[data-qa-safe-area="true"\][^{]*\{[^}]*--qa-safe-area-top\s*:\s*28px[^}]*--qa-safe-area-bottom\s*:\s*20px/u);
  assert.match(css, /var\(--qa-safe-area-top,0px\)/u);
});
