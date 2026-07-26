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

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

const PRIMITIVE_BODY = /new\s+THREE\.(?:BoxGeometry|PlaneGeometry|Line(?:Segments|Loop)?)\b/u;

test("G2 runtime objective IDs are the IDs consumed by both Ghost trackers", () => {
  const missionSetup = sliceBetween(
    GAME,
    "const selectedLibraryPlanDefinition = libraryGoldEnabled",
    "const mechanicPosition = themeMechanicPlacement",
  );
  assert.match(
    missionSetup,
    /selectedLibraryPlanDefinition\.objectiveIds\.map\(\(objectiveId\)\s*=>\s*\{/u,
  );
  assert.match(
    GAME,
    /const\s+missionObjectiveIds\s*=\s*runtimeMissionObjectives\.map\(\s*\(objective\)\s*=>\s*objective\.id,\s*\);/u,
  );
  const ghostTrackerBindings = [
    ...GAME.matchAll(/new\s+GhostRuleProgressTracker\(\s*missionObjectiveIds\s*,?\s*\)/gu),
  ];
  assert.ok(
    ghostTrackerBindings.length >= 4,
    "player/replay Ghost trackers must use runtime route objective IDs on initial load and restart",
  );
  const runtimeCompletion = sliceBetween(
    GAME,
    "if (completedMissionObjective) {",
    "playHapticCue(",
  );
  const missionGhostRecorder = sliceBetween(
    GAME,
    "const recordLibraryMissionRuleEvents = (",
    "let ghostRaceTracker =",
  );
  assert.match(
    runtimeCompletion,
    /const\s+libraryStep\s*=\s*stepLibraryBranchingMission\([\s\S]*?libraryMissionState\s*=\s*libraryStep\.state/u,
    "runtime completion must retain the G2 transition events that own actual route objective IDs",
  );
  assert.match(
    missionGhostRecorder,
    /for\s*\(const\s+event\s+of\s+events\)[\s\S]*?objectiveId:\s*event\.objectiveId/u,
    "Ghost recording must consume the selected route's G2 objective IDs",
  );
  assert.match(
    runtimeCompletion,
    /recordLibraryMissionRuleEvents\(libraryStep\.events,\s*ruleEventTick\)/u,
    "the physical objective completion path must send actual G2 transition events to Ghost recording",
  );
  assert.doesNotMatch(
    runtimeCompletion,
    /for\s*\(const\s+event\s+of\s+compatibilityStep\.ghostEvents\)/u,
    "legacy campus projection IDs cannot be fed to G2 Ghost trackers",
  );
  const runIdentity = sliceBetween(
    GAME,
    "function libraryG2RunIdentity(",
    "const LIBRARY_G2_RECORD_IDS =",
  );
  assert.match(
    runIdentity,
    /library-g2-v\$\{\s*LIBRARY_BRANCHING_MISSION_VERSION\s*\}:\$\{planId\}/u,
    "route identity must remain part of the replay and record IDs",
  );
  assert.match(
    GAME,
    /libraryGoldEnabled\s*\?\s*libraryG2RunIdentity\(campaignLevel\.id,\s*selectedLibraryPlan\)/u,
  );
  assert.match(
    GAME,
    /const\s+runRecordLevelId[\s\S]{0,180}libraryGoldEnabled\s*\?\s*runReplayLevelId/u,
    "different G2 plans cannot overwrite one another's personal best",
  );
});

test("G2 mission art reads completion from the G2 state domain", () => {
  const missionViews = sliceBetween(
    GAME,
    "const updateThemeMissionViews = (",
    "const updateThemeMechanicView = (",
  );
  assert.match(
    missionViews,
    /libraryMissionState\?\.completedObjectiveIds\s*\?\?\s*missionState\.completedObjectiveIds/u,
    "completed library objectives must retain their authored green completion treatment",
  );
});

test("Ghost recording commits buffered input at the authoritative pre-step tick", () => {
  assert.match(GAME, /const\s+ruleEventTick\s*=\s*latestState\.tick;/u);
  assert.match(GAME, /const\s+currentGhostTick\s*=\s*latestState\.tick;/u);
  assert.match(GAME, /const\s+completedTick\s*=\s*latestState\.tick;/u);
  assert.match(
    GAME,
    /const\s+recordingTick\s*=\s*latestState\.tick;\s*ghostInputBuffer\.stage\(recordingTick,\s*simulationInput\);\s*latestState\s*=\s*simulation\.advance/u,
    "the render input must be staged before the fixed simulation advances",
  );
  assert.match(
    GAME,
    /ghostRecorder\.record\(\s*committedGhostInput\.tick,\s*committedGhostInput\.input,\s*\)/u,
  );
  assert.doesNotMatch(
    GAME,
    /ghostRecorder\.record\(\s*currentGhostTick/u,
    "post-step recording delays every keyframe and loses sub-frame interaction edges",
  );
  assert.doesNotMatch(
    GAME,
    /Math\.floor\(latestState\.elapsedSeconds\s*\/\s*simulation\.config\.fixedStepSeconds\)/u,
    "floating-point elapsed time can drop a one-tick interaction edge",
  );
});

test("mastery preview and result share the selected G2 ordered route object", () => {
  const setup = sliceBetween(
    GAME,
    "const masteryTargetOptions = useMemo",
    "const [campaignProgress, setCampaignProgress]",
  );
  assert.match(setup, /kind:\s*"ordered"\s+as\s+const/u);
  assert.match(
    setup,
    /objectives:\s*Object\.freeze\(objectives\)/u,
  );
  assert.match(
    setup,
    /previewRunMastery\(\s*campaignLevel,\s*gameplayConfig,\s*masteryTargetOptions/u,
  );
  const result = sliceBetween(
    GAME,
    "const masteryResult = evaluateRunMastery(",
    "const previousRunRecord = getCampaignRunRecord(",
  );
  assert.match(
    result,
    /masteryTargetSeconds\(\s*campaignLevel,\s*simulation\.config,\s*masteryTargetOptions/u,
  );
  assert.doesNotMatch(result, /legacyMissionPlacements/u);
});

test("G2 mission commitments own an authored interaction performance", () => {
  const animation = sliceBetween(
    GAME,
    "const syncAnimations = (state: GameState, delta: number) =>",
    "const advanceAndSyncGhost = (delta: number) =>",
  );
  assert.match(
    animation,
    /state\.player\.mode\s*===\s*"free"\s*&&\s*missionCommitment[\s\S]*requestAnimation\(kid,\s*"point"/u,
  );
  assert.match(
    GAME,
    /libraryMissionCommitmentWindow\(\s*latestState\.tick,\s*activeMissionObjective\.objective\.commitmentSeconds,\s*simulation\.config\.fixedStepSeconds/u,
    "commitment duration must come from the fixed-step timing contract",
  );
  assert.doesNotMatch(
    GAME,
    /missionCommitment\.remainingSeconds\s*-\s*delta/u,
    "render delta cannot own mission completion",
  );
  assert.match(
    animation,
    /duration:\s*missionCommitment\.totalSeconds/u,
  );
  assert.match(
    animation,
    /restart,\s*\}\);\s*missionPerformanceObjectiveId\s*=\s*missionCommitment\.objectiveId/u,
    "each objective must restart once without restarting its clip every frame",
  );
  assert.match(
    animation,
    /committedMissionView\.root\.getWorldPosition\(missionPerformanceTarget\)[\s\S]*headingLength/u,
    "exact-anchor interactions must face the offset authored model rather than the logical cell",
  );
});

test("mission HUD and runtime share the exact authoritative interaction radius", () => {
  const hud = sliceBetween(
    GAME,
    "const hudMissionObjective = missionObjectiveForPlayer(",
    "setPortableDecoy(",
  );
  assert.match(
    hud,
    /canInteract:\s*Boolean\([\s\S]*distanceBetween\(\s*latestState\.player\.position,\s*hudMissionObjective\.position,\s*\)\s*<=\s*1\.35/u,
  );
  assert.match(
    GAME,
    /const\s+missionCanInteract\s*=\s*Boolean\(\s*activeMissionObjective\s*&&\s*themeMission\?\.canInteract/u,
  );
  assert.doesNotMatch(
    GAME,
    /activeDistanceMeters\s*\?\?\s*Number\.POSITIVE_INFINITY\)\s*<=\s*3/u,
  );
});

test("G2 result page can rebuild the alternate route without a page reload", () => {
  const switchHandler = sliceBetween(
    GAME,
    "const switchLibraryPlanAfterRun = useCallback(() => {",
    "useEffect(() => {\n    chooseLevelRef.current",
  );
  assert.match(
    switchHandler,
    /\(phase\s*!==\s*"won"\s*&&\s*phase\s*!==\s*"lost"\)/u,
  );
  assert.match(
    switchHandler,
    /LIBRARY_BRANCHING_MISSION\.plans\.find\(\s*\(plan\)\s*=>\s*plan\.id\s*!==\s*selectedLibraryPlan/u,
  );
  assert.match(switchHandler, /setPhase\("ready"\)/u);
  assert.match(switchHandler, /setLoading\(true\)/u);
  assert.match(switchHandler, /setSelectedLibraryPlan\(nextPlan\.id\)/u);

  const actions = sliceBetween(
    GAME,
    '<div className="overlay-actions">',
    '<div className="view-controls"',
  );
  assert.match(
    actions,
    /className="secondary library-plan-switch"[\s\S]*onClick=\{switchLibraryPlanAfterRun\}/u,
  );
});

test("portable decoy UI and keyboard feedback agree near hide interactions", () => {
  assert.match(
    GAME,
    /const\s+portableDecoyActionAvailable[\s\S]{0,320}&&\s*!interaction/u,
  );
  const edge = sliceBetween(
    GAME,
    "const portableDecoyEdge = portableDecoyPressed.current;",
    "let completedMissionObjective:",
  );
  assert.match(edge, /if\s*\(hideInteractionBeforeStep\)/u);
  assert.match(edge, /先离开藏点交互范围，再投掷精装笔记本/u);
  assert.match(GAME, /interaction\s*\?\s*"离开藏点后投掷"/u);
});

test("G2 first-clear guidance and legacy records survive route identity migration", () => {
  const guidance = sliceBetween(
    GAME,
    "const updateHideGuideProjection =",
    "const animate = (now: number) =>",
  );
  assert.match(
    guidance,
    /getCampaignRunRecord\(\s*campaignProgressRef\.current,\s*runRecordLevelId,\s*preferences\.ruleset/u,
  );
  assert.match(guidance, /legacyLibraryRecord/u);
  assert.doesNotMatch(
    guidance,
    /campaignProgressRef\.current\.bestSeconds\[campaignLevel\.id\]/u,
  );
  assert.match(GAME, /旧版基线/u);
});

test("the first or improved personal best becomes the next in-memory ghost", () => {
  assert.match(
    GAME,
    /let\s+ghostRecording:\s*GhostRecording\s*\|\s*null/u,
  );
  assert.match(
    GAME,
    /if\s*\(ghost\s*&&\s*ghostSave\?\.saved\)\s*\{[\s\S]{0,360}ghostRecording\s*=\s*ghost;/u,
  );
  const placement = sliceBetween(
    GAME,
    "const placePersonalGhost =",
    "const consumeEvents =",
  );
  assert.match(placement, /!preferences\.personalGhostEnabled\s*\|\|\s*!asset\s*\|\|\s*ghostActor/u);
  assert.doesNotMatch(placement, /!ghostRecording\s*\|\|/u);
});

test("G2 mechanic and inactive exit art cannot masquerade as active objectives", () => {
  const placement = sliceBetween(
    GAME,
    "const mechanicPosition = themeMechanicPlacement(",
    "const mechanicDefinition = createThemeMechanicDefinition(",
  );
  assert.match(placement, /LIBRARY_BRANCHING_MISSION_TOPOLOGY\.objectivePlacements/u);
  assert.match(placement, /LIBRARY_BRANCHING_MISSION_TOPOLOGY\.exitPlacements/u);
  assert.match(GAME, /非当前路线/u);
  assert.match(GAME, /0x6f7d88,\s*0\.72/u);
});

test("both library exits own doorway anchors, authored exit doors, and formal theme clusters", () => {
  const doorwaySetup = sliceBetween(
    GAME,
    "const exitDoorwayAnchors = libraryGoldEnabled",
    "// Every authored wall faces local +Z.",
  );
  assert.match(
    doorwaySetup,
    /LIBRARY_BRANCHING_MISSION_TOPOLOGY\.exitPlacements\.map\(\(placement\)\s*=>\s*\(\{/u,
    "doorway anchors must include the complete two-exit topology, not only the selected exit",
  );
  const doorwaySelection = sliceBetween(
    GAME,
    "const isAnchorEdge =",
    "// Replace pairs along continuous boundaries",
  );
  assert.match(
    doorwaySelection,
    /exitDoorwayAnchors\.some\(\(\{\s*point,\s*outward\s*\}\)\s*=>/u,
  );
  assert.match(doorwaySelection, /wallBatches\.doorway\.push\(placement\)/u);

  const exitDoors = sliceBetween(
    GAME,
    "const authoredExit = resolveThemeNode(",
    "const buildDetails = (",
  );
  assert.match(
    exitDoors,
    /const\s+secondaryDoor\s*=\s*authoredExit\s*\?\s*anchorAuthoredModule\(authoredExit\)\s*:\s*fitModule\(requireStructure\("exit"\)/u,
    "the second exit must reuse the same formal exit asset path as the primary door",
  );
  assert.match(
    exitDoors,
    /secondaryDoor\.name\s*=\s*`library-secondary-exit-\$\{secondaryExit\.exitId\}`/u,
  );

  const exitClusters = sliceBetween(
    GAME,
    "const exitClusterAnchor = exteriorAnchor",
    "const arrivalPropNodes =",
  );
  assert.match(
    exitClusters,
    /secondaryExitClusterAnchors\s*=\s*libraryGoldEnabled[\s\S]*LIBRARY_BRANCHING_MISSION_TOPOLOGY\.exitPlacements/u,
  );
  assert.match(
    exitClusters,
    /for\s*\(const\s+\{\s*exitId,\s*anchor\s*\}\s+of\s+secondaryExitClusterAnchors\)[\s\S]*addAuthoredCluster\(\s*\[\.\.\.artLayout\.exitNodes,\s*"DressingClusterA"\][\s\S]*secondary-exit-cluster-\$\{exitId\}/u,
    "the second doorway must receive the same authored theme exit cluster family",
  );
});

test("portable decoys are extracted only from the named books.glb notebook assembly", () => {
  assert.match(GAME, /books:\s*"\/models\/environment\/books\.glb\?v=\d+"/u);
  assert.match(
    GAME,
    /const\s+booksAsset\s*=\s*detailAssets\.books;[\s\S]{0,240}buildPortableDecoyTemplate\(booksAsset\);/u,
  );

  const extractor = sliceBetween(
    GAME,
    "function fitNamedStaticProp(",
    "function anchorAuthoredStatic(",
  );
  assert.match(extractor, /object\.name\.startsWith\(namePrefix\)/u);
  assert.match(extractor, /throw\s+new\s+Error\(`正式美术资产缺少命名子组件\s+\$\{namePrefix\}`\)/u);

  const template = sliceBetween(
    GAME,
    "const buildPortableDecoyTemplate = (booksAsset: GLTF) =>",
    "const createPortableDecoyView = (",
  );
  assert.match(
    template,
    /fitNamedStaticProp\(\s*booksAsset\.scene,\s*"Dropped_Notebook_",\s*0\.32,\s*true,\s*\)/u,
  );
  assert.doesNotMatch(template, /(?:booksAsset\.scene\.clone|fitProp\(\s*booksAsset\.scene)/u);

  const view = sliceBetween(
    GAME,
    "const createPortableDecoyView = (",
    "const updatePortableDecoyViews = (",
  );
  assert.match(view, /portableDecoyTemplate\.clone\(true\)/u);
  assert.doesNotMatch(view, PRIMITIVE_BODY);
});

test("F key, touch controls, and the QA bridge all deploy the same portable decoy action", () => {
  assert.match(
    GAME,
    /else\s+if\s*\(key\s*===\s*"f"\s*&&\s*phase\s*===\s*"playing"\)\s*commands\.current\.deployDecoy\(\)/u,
  );
  assert.match(
    GAME,
    /className=\{`portable-decoy-status[\s\S]{0,700}onClick=\{deployDecoy\}[\s\S]{0,700}<kbd\s+className="desktop-key">F<\/kbd>/u,
  );
  assert.match(
    GAME,
    /className=\{`decoy-action\$\{portableDecoyActionAvailable[\s\S]{0,280}onClick=\{deployDecoy\}/u,
    "mobile action controls must expose a real touch deploy button",
  );

  const qaBridge = sliceBetween(
    GAME,
    "const qaWindow = window as typeof window &",
    "if (qaWindow.__CHASING_QA__) delete qaWindow.__CHASING_QA__",
  );
  assert.match(qaBridge, /deployDecoy:\s*\(\)\s*=>\s*void/u);
  assert.match(
    qaBridge,
    /deployDecoy:\s*\(\)\s*=>\s*\{\s*portableDecoyPressed\.current\s*=\s*true;\s*\}/u,
  );
  assert.match(qaBridge, /portableDecoy:\s*portableDecoyState/u);
  assert.match(qaBridge, /formalTemplateReady:\s*Boolean\(portableDecoyTemplate\)/u);
});

test("portable world sound enters GameSimulation and telemetry preserves portable source identity", () => {
  assert.match(
    GAME,
    /portableDecoySourceIds\.add\(deployment\.sourceId\)/u,
    "accepted physical deployments must register their public evidence source",
  );
  const decoyTick = sliceBetween(
    GAME,
    "const decoyStep = stepPortableDecoy(",
    "const mechanicMovementCommitted =",
  );
  assert.match(
    GAME,
    /simulation\.scheduleWorldSound\([\s\S]{0,120}portableDecoySoundStimulus\([\s\S]{0,180}deployment[\s\S]{0,180}deployment\.soundAtSeconds/u,
    "accepted physical deployments must pre-schedule the public sound on the deterministic tick timeline",
  );
  assert.match(
    decoyTick,
    /const pendingDecoySound = decoyStep\.pendingSoundStimulus;[\s\S]{0,1800}acknowledgePortableDecoySound\([\s\S]{0,500}if \(acknowledgement\.acknowledged\)/u,
    "a delivery proposal must become emitted only after the simulation accepted it",
  );
  assert.doesNotMatch(
    decoyTick,
    /decoyStep\.emittedSoundStimulus/u,
    "runtime integration must not use the deprecated one-phase alias",
  );

  const telemetry = sliceBetween(
    GAME,
    "const consumeEvents = (",
    "const snapActorTransform =",
  );
  assert.match(
    telemetry,
    /event\.sourceType\s*===\s*"environment-decoy"/u,
  );
  assert.match(
    telemetry,
    /source:\s*portableDecoySourceIds\.has\(event\.evidenceId\)\s*\?\s*"decoy"\s*:\s*"theme-mechanic"/u,
  );
  assert.match(
    telemetry,
    /causalEvents:\s*\[\.\.\.causalEvents,\s*\.\.\.completedInvestigations\]/u,
    "portable investigation classification must reach run telemetry",
  );
});

test("decoy and exit-door bodies cannot regress to primitive geometry", () => {
  const decoyBody = sliceBetween(
    GAME,
    "const buildPortableDecoyTemplate = (booksAsset: GLTF) =>",
    "const updatePortableDecoyViews = (",
  );
  const doorBody = sliceBetween(
    GAME,
    "const authoredExit = resolveThemeNode(",
    "const buildDetails = (",
  );
  assert.doesNotMatch(decoyBody, PRIMITIVE_BODY);
  assert.doesNotMatch(doorBody, PRIMITIVE_BODY);

  assert.match(
    GAME,
    /const\s+propContactGeometry\s*=\s*new\s+THREE\.PlaneGeometry\(/u,
    "the scoped guard must continue allowing the existing contact-shadow plane",
  );
});

test("library plan selector has distinct desktop and coarse-pointer/mobile layouts", () => {
  const desktop = sliceBetween(
    CSS,
    ".mission-briefing > .library-plan-selector {",
    ".run-summary {",
  );
  assert.match(desktop, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u);
  assert.match(desktop, /\.library-plan-selector button\[aria-pressed="true"\]\s*\{/u);

  const mobile = sliceBetween(
    CSS,
    "@media (max-width: 900px), (pointer: coarse) {",
    "@media (max-height: 480px) and (orientation: landscape) {",
  );
  assert.match(mobile, /\.action-controls\s*\{\s*display:\s*flex;\s*\}/u);
  assert.match(
    mobile,
    /\.mission-briefing\s*>\s*\.library-plan-selector\s*\{[\s\S]*?flex-basis:\s*min\(94%,\s*360px\);[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/u,
  );
  assert.match(
    mobile,
    /\.library-plan-selector small\s*\{[\s\S]*?white-space:\s*normal;/u,
  );
});

test("portable-decoy tutorial copy is scoped to the one route that owns it", () => {
  assert.match(
    GAME,
    /libraryGoldEnabled\s*\?\s*"按 F 投掷精装笔记本诱饵，趁调查与左右巡视时改线"\s*:\s*"利用本关主题机关制造公开线索，趁追捕者调查时改线"/u,
  );
  assert.match(
    GAME,
    /libraryGoldEnabled\s*\?\s*"F 投掷诱饵 · "\s*:\s*""/u,
    "other chapters must not advertise an inert F action",
  );
});
