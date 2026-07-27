import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../app/chasing-game.tsx", import.meta.url),
  "utf8",
);
const css = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

test("ready presentation is a non-skippable three-stage dialog", () => {
  assert.match(source, /useReducer\(\s*preRunFlowReducer/u);
  assert.match(source, /preRunFlow\.step === "chapter"/u);
  assert.match(source, /preRunFlow\.step === "strategy"/u);
  assert.match(source, /preRunFlow\.step === "briefing"/u);
  assert.match(source, /className="pre-run-body" data-step=\{preRunFlow\.step\}/u);
  assert.match(source, /className="overlay-actions pre-run-footer"/u);
  assert.match(source, /下一步：计划与装备/u);
  assert.match(source, /下一步：确认行动简报/u);
});

test("ready keyboard and focus handling cannot bypass or escape the dialog", () => {
  assert.match(
    source,
    /keyboardPresentationRef\.current\.phase === "ready"[\s\S]*?preRunBackActionRef\.current\(\);[\s\S]*?commands\.current\.togglePause\(\)/u,
  );
  assert.match(
    source,
    /keyboardPresentation\.phase === "ready"[\s\S]*?preRunAdvanceActionRef\.current\(\)/u,
  );
  assert.match(source, /preRunStepTitle\.current\?\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(source, /details > summary/u);
  assert.match(source, /closest\(\s*"button, summary,/u);
  assert.match(source, /shouldIgnoreFocusedControlKey\(key, focusedControl\)/u);
  assert.match(
    source,
    /key === "r"[\s\S]*?keyboardPresentationRef\.current\.phase !== "ready"[\s\S]*?commands\.current\.restart\(\)/u,
  );
  assert.doesNotMatch(source, /get\("autostart"\)/u);
  assert.match(
    source,
    /const advancePreRunFlow = useCallback\(\(\) => \{[\s\S]*?selectedLevelIndex \+ 1 > unlockedThrough\) return;/u,
  );
});

test("only the ready body scrolls and the mobile action remains a full hit target", () => {
  assert.match(
    css,
    /\.overlay\.ready \.pre-run-card\s*\{[\s\S]*?grid-template-rows:[\s\S]*?minmax\(0,\s*1fr\)[\s\S]*?overflow:\s*hidden/u,
  );
  assert.match(
    css,
    /\.pre-run-body\s*\{[\s\S]*?overflow-y:\s*auto/u,
  );
  assert.match(
    css,
    /\.pre-run-footer \.primary\s*\{[\s\S]*?min-height:\s*54px/u,
  );
  assert.match(
    css,
    /@media \(max-width: 610px\)[\s\S]*?\.overlay\.ready \.pre-run-card\s*\{[\s\S]*?height:\s*calc\(100% - 20px\)[\s\S]*?overflow:\s*hidden/u,
  );
  assert.match(
    css,
    /\.pre-run-footer\s*\{[\s\S]*?grid-template-columns:\s*82px minmax\(0,\s*1fr\)/u,
  );
});

test("last-run setup is restored defensively and saved only on actual start", () => {
  assert.match(source, /loadLastRunSetup\(localStorage/u);
  assert.match(
    source,
    /const beginPreparedRun = useCallback\(\(\) => \{[\s\S]*?saveLastRunSetup\(localStorage[\s\S]*?begin\(\);/u,
  );
  assert.match(
    source,
    /selectedLevelIndex \+ 1 > unlockedThrough[\s\S]*?dispatchPreRunFlow\(\{ type: "reset" \}\)[\s\S]*?return;/u,
  );
  assert.match(source, /disabled=\{!selectedLevelUnlockedForRuleset\}/u);
  assert.match(source, /setSelectedHospitalLoadout\(restoredSetup\.hospitalToolIds\)/u);
  assert.match(
    source,
    /Object\.entries\(assistedGameplayConfig\(baseGameplayConfig\)\)[\s\S]*?filter\(\(\[, value\]\) => value !== undefined\)/u,
  );
});
