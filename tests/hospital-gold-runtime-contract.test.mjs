import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GAME = await readFile(
  new URL("../app/chasing-game.tsx", import.meta.url),
  "utf8",
);
const CSS = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const VISUAL_QA = await readFile(
  new URL("../scripts/hospital-gold-visual-qa.mjs", import.meta.url),
  "utf8",
);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test("hospital exposure cost controls the legal fixed-step visibility window", () => {
  assert.match(
    GAME,
    /hospitalMissionExposureWindow\(\s*commitmentWindow,\s*activeMissionObjective\.objective\.exposureSeconds/u,
  );
  const simulationInput = sliceBetween(
    GAME,
    "const buildSimulationInput = (",
    "const simulationInput = buildSimulationInput(",
  );
  assert.match(
    simulationInput,
    /hospitalExposureActiveAtTick\(nextTick\)[\s\S]*?\?\s*1[\s\S]*?:\s*0\.64/u,
  );
  assert.match(
    simulationInput,
    /visionRangeMultiplier:\s*Math\.min\([\s\S]*?hospitalInteractionVisibilityMultiplier/u,
  );
  assert.match(
    GAME,
    /classList\.toggle\(\s*"hospital-mission-exposed",[\s\S]*?hospitalExposureActiveAtTick\(latestState\.tick\)/u,
  );
  assert.match(CSS, /\.hospital-mission-exposed \.mission-status/u);
});

test("failure replay records public events per fixed tick without AI memory", () => {
  const fixedStep = sliceBetween(
    GAME,
    "latestState = simulation.advance(",
    "const committedGhostInput = ghostInputBuffer.consumeIfAdvanced(",
  );
  assert.match(
    fixedStep,
    /recordFailurePublicEvents\(latestState\);[\s\S]*?simulationFrameEvents\.push/u,
  );
  assert.doesNotMatch(
    GAME,
    /publicEvidence:\s*latestState\.chaser\.memory/u,
  );
  assert.match(GAME, /includeSemanticTrack:\s*true/u);
  assert.match(
    GAME,
    /case\s+"hide-check-completed":[\s\S]*?return canRuntimeObserveChaser\(state\)/u,
  );
});

test("hide disturbance has a formal persistent scene treatment", () => {
  assert.match(
    GAME,
    /const\s+disturbanceState\s*=\s*state\.hideSpots\[locker\.id\]/u,
  );
  assert.match(GAME, /hideDisturbanceLevel\s*=\s*disturbanceLevel/u);
  assert.match(GAME, /getObjectByName\("DoorPivot"\)[\s\S]*?disturbanceRatio/u);
  assert.match(GAME, /material\.emissive[\s\S]*?hideDisturbanceEmissive/u);
  assert.match(GAME, /disturbanceRatio\s*\*\s*0\.09/u);
});

test("browser QA pays real task costs instead of using the completion bypass", () => {
  assert.doesNotMatch(VISUAL_QA, /__CHASING_QA__\.completeMission\(\)/u);
  assert.match(
    VISUAL_QA,
    /completePlanThroughPlayerInteractions\([\s\S]*?__CHASING_QA__\.interact\(\)/u,
  );
  assert.match(
    VISUAL_QA,
    /setScenario\(\{[\s\S]*?preserveMissionProgress:\s*true/u,
  );
  assert.match(
    GAME,
    /preserveMissionProgress[\s\S]*?resetPresentation\(latestState,\s*retainedMission\)/u,
  );
  assert.match(
    GAME,
    /const completed = new Set\(\s*hospitalMissionState\?\.completedObjectiveIds\s*\?\?\s*libraryMissionState\?\.completedObjectiveIds/u,
  );
  assert.match(VISUAL_QA, /did not lock movement during its commitment/u);
  assert.match(VISUAL_QA, /did not emit its authored public sound/u);
  assert.match(VISUAL_QA, /did not retain post-interaction exposure/u);
});

test("mobile and high-contrast controls preserve selection and hit targets", () => {
  assert.match(
    GAME,
    /aria-label=\{`\$\{STEALTH_TOOL_UI\[tool\]\.label\}，库存/u,
  );
  assert.match(
    GAME,
    /快速 · 高扰动 <kbd className="desktop-key">Z<\/kbd>/u,
  );
  assert.match(
    CSS,
    /\.high-contrast \.library-plan-selector button\[aria-pressed="true"\]/u,
  );
  assert.match(
    CSS,
    /@media \(max-width: 610px\)[\s\S]*?\.hide-exit-selector\s*\{[\s\S]*?bottom:\s*176px/u,
  );
  assert.match(
    CSS,
    /\.mission-briefing:has\(> \.hospital-plan-selector\)\s*>\s*\.hospital-loadout-selector\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/u,
  );
});

test("hide-check presentation cannot leak a remote or empty-locker side channel", () => {
  const consumeEvents = sliceBetween(
    GAME,
    "const consumeEvents = (",
    "const snapActorTransform = (",
  );
  const completedCheck = sliceBetween(
    consumeEvents,
    'if (event.type === "hide-check-completed")',
    'if (event.type === "player-captured")',
  );
  assert.match(completedCheck, /canRuntimeObserveChaser\(state\)/u);
  assert.doesNotMatch(
    completedCheck,
    /if\s*\(\s*!event\.occupied\s*\)\s*soundscape\.trigger/u,
  );
  const modeChange = sliceBetween(
    consumeEvents,
    'if (event.type === "chaser-mode-changed")',
    'if (event.type === "phase-changed")',
  );
  assert.match(
    modeChange,
    /event\.to === "check-hide"\s*&&\s*canRuntimeObserveChaser\(state\)/u,
  );
});

test("terminal results and touch hold controls retain accessible equivalents", () => {
  assert.match(
    GAME,
    /className=\{`overlay \$\{phase\}`\}[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby="game-overlay-title"/u,
  );
  assert.match(
    GAME,
    /terminalResultVisible[\s\S]*?resultPrimaryButton\.current\?\.focus\(\)/u,
  );
  assert.match(
    GAME,
    /aria-pressed=\{touchQuietModeLatched\}[\s\S]*?event\.detail !== 0[\s\S]*?updateTouchQuietMode/u,
  );
  assert.match(
    GAME,
    /libraryGoldEnabled \|\| hospitalGoldEnabled[\s\S]*?按所选计划依次完成目标/u,
  );
  assert.match(
    GAME,
    /医院任务高风险操作已开始；本次操作包含公开暴露窗口。/u,
  );
});
