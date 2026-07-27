import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = await readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8");
const RUNTIME_ASSETS_SOURCE = await readFile(
  path.join(ROOT, "app", "game", "runtime-assets.ts"),
  "utf8",
);
const INTEGRATION = await readFile(
  path.join(ROOT, "app", "game", "INTEGRATION.md"),
  "utf8",
);

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
  assert.match(
    SOURCE,
    /police:\s*\{\s*url: "\/models\/characters\/police-bootstrap\.glb\?v=1"/,
  );
  assert.equal(
    SOURCE.match(/loadGlbWithRetry\(ACTOR_SPECS\.police\.url\)/g)?.length,
    1,
    "Police should have one memoized on-demand load path",
  );
  assert.match(SOURCE, /distanceBetween\(latestState\.player\.position, campaignLevel\.exit\)[\s\S]*POLICE_PREFETCH_DISTANCE_CELLS/);
  assert.match(SOURCE, /event\.to === "won"[\s\S]*requestAnimation\(actors\.kid!, "celebrate"/);
  assert.match(SOURCE, /event\.to === "won"[\s\S]*void requestPoliceAsset\?\.\(\)/);
});

test("quantized authored geometry expands before CPU world-matrix baking", () => {
  assert.match(
    SOURCE,
    /function cloneGeometryForStaticBake\([\s\S]*new Float32Array\([\s\S]*return geometry\.applyMatrix4\(matrixWorld\)/,
  );
  assert.equal(
    SOURCE.match(/cloneGeometryForStaticBake\(object\.geometry, object\.matrixWorld\)/g)?.length,
    2,
    "Both static flattening paths must decode compact attributes before matrix baking",
  );
});

test("quantized skinned actors calibrate against GPU-decoded geometry bounds", () => {
  assert.match(
    SOURCE,
    /function staticMeshBounds\([\s\S]*geometry\.boundingBox\.clone\(\)\.applyMatrix4\(object\.matrixWorld\)/,
  );
  const fitActorSource = SOURCE.match(/function fitActor\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(fitActorSource, /const initial = staticMeshBounds\(visual\)/);
  assert.match(fitActorSource, /const fitted = staticMeshBounds\(visual\)/);
  assert.doesNotMatch(fitActorSource, /setFromObject/);
  assert.match(SOURCE, /worldHeight: size\.y/);
});

test("runtime quality profiles control real rendering work", () => {
  assert.match(SOURCE, /renderQualityProfile\.occlusionProbeSeconds/);
  assert.match(
    SOURCE,
    /renderQualityProfile\.maximumDynamicLights[\s\S]*emergencyPolicy\.dynamicLightScale/,
  );
  assert.match(SOURCE, /active[\s\S]*\.slice\([\s\S]*Math\.floor\(/);
  assert.match(SOURCE, /resolveRuntimeObjectPolicy\(\{/);
  assert.match(SOURCE, /renderQualityProfile\.staticEnvironmentShadows/);
  assert.match(SOURCE, /visibleTriangles: renderer\.info\.render\.triangles/);
  assert.match(SOURCE, /drawCalls: renderer\.info\.render\.calls/);
  assert.match(SOURCE, /nextRenderQuality\([\s\S]*workload/);
  assert.match(SOURCE, /renderedAtmosphereParticles = Math\.min/);
  assert.match(SOURCE, /for \(let index = 0; index < renderedAtmosphereParticles; index \+= 1\)/);
  assert.match(SOURCE, /atmosphereAttribute\.addUpdateRange\(0, renderedAtmosphereParticles \* 3\)/);
});

test("scene loading is cancellable, retryable, concurrency-limited and KTX2 aware", () => {
  assert.match(SOURCE, /createSceneAssetLoader\(\{[\s\S]*maximumConcurrentRequests: 3/);
  assert.match(SOURCE, /sceneAssets\.fetchArrayBuffer\(absoluteUrl/);
  assert.match(
    SOURCE,
    /for \(let decodeAttempt = 1; decodeAttempt <= 2; decodeAttempt \+= 1\)[\s\S]*?cache: decodeAttempt === 1 \? "force-cache" : "reload"/u,
  );
  assert.match(
    SOURCE,
    /error instanceof AssetLoadError[\s\S]*?error\.code === "ASSET_DECODE"[\s\S]*?decodeAttempt < 2/u,
  );
  assert.match(SOURCE, /externalAssetUrisFromGlb\(bytes\)[\s\S]*fetchControlledDependency/);
  assert.match(SOURCE, /loadingManager\.setURLModifier/);
  assert.match(SOURCE, /loader\.parseAsync\(bytes/);
  assert.match(
    SOURCE,
    /^import \{ KTX2Loader \} from "three\/examples\/jsm\/loaders\/KTX2Loader\.js";[\s\S]*new KTX2Loader\(loadingManager\)[\s\S]*setTranscoderPath\("\/basis\/"\)[\s\S]*detectSupport\(renderer\)/m,
  );
  assert.doesNotMatch(
    SOURCE,
    /import\("three\/examples\/jsm\/loaders\/KTX2Loader\.js"\)/,
    "KTX2 support must not add a post-bootstrap dynamic-import waterfall",
  );
  assert.match(SOURCE, /const playableTextures = collectObjectTextures\([\s\S]*disposeObjectResources\([\s\S]*playableTextures/);
  assert.match(SOURCE, /sceneAssets\.abort\(new DOMException\("Scene disposed"/);
  assert.match(SOURCE, /ktx2Loader\?\.dispose\(\)/);
  assert.match(
    SOURCE,
    /pendingGlbLoadCount \+= 1;[\s\S]*finally \{[\s\S]*pendingGlbLoadCount = Math\.max\(0, pendingGlbLoadCount - 1\);[\s\S]*releaseControlledDependencyResourcesWhenSettled\(\);/u,
    "every GLB parse must hold its external blob URLs until its texture work settles",
  );
  assert.match(
    SOURCE,
    /const releaseControlledDependencyResourcesWhenSettled = \(\) => \{[\s\S]*disposed[\s\S]*pendingGlbLoadCount === 0[\s\S]*dependencyLoadingManagerIdle[\s\S]*releaseControlledDependencyResources\(\);/u,
  );
  assert.match(
    SOURCE,
    /loadingManager\.onStart = \(\) => \{\s*dependencyLoadingManagerIdle = false;[\s\S]*loadingManager\.onLoad = \(\) => \{\s*dependencyLoadingManagerIdle = true;\s*releaseControlledDependencyResourcesWhenSettled\(\);/u,
    "external image decoding must participate in the blob URL disposal barrier",
  );
  assert.match(
    SOURCE,
    /return \(\) => \{\s*disposed = true;\s*sceneAssets\.abort\([\s\S]*releaseControlledDependencyResourcesWhenSettled\(\);\s*renderer\.renderLists\.dispose\(\);/u,
    "chapter cleanup must abort first and defer URL/KTX2 disposal until pending GLB parses settle",
  );
});

test("scene disposal closes each owned ImageBitmap exactly once", () => {
  const disposal = SOURCE.match(
    /function disposeObjectResources\([\s\S]*?\n\}/u,
  )?.[0] ?? "";
  assert.ok(disposal, "the scene-resource disposal boundary is missing");
  assert.match(
    disposal,
    /const imageBitmaps = new Set<ImageBitmap>\(\)/u,
    "decoded bitmaps must be deduplicated before native cleanup",
  );
  assert.match(disposal, /const preservedImageBitmaps = new Set<ImageBitmap>\(\)/u);
  assert.match(
    disposal,
    /collectImageBitmaps\([^,]+,\s*imageBitmaps\)/u,
    "owned decoded sources must flow into the unique bitmap set",
  );
  assert.match(
    disposal,
    /for \(const imageBitmap of imageBitmaps\)[\s\S]*!preservedImageBitmaps\.has\(imageBitmap\)[\s\S]*imageBitmap\.close\(\)/u,
    "only unique, non-preserved ImageBitmaps may be closed",
  );
});

test("mobile controls, pause and theme mechanics drive the real simulation", () => {
  assert.match(SOURCE, /sampleVirtualStick\(/);
  assert.match(SOURCE, /combineScreenMove\(/);
  assert.match(SOURCE, /if \(joystickPointerId\.current !== null\) return/);
  assert.match(SOURCE, /className="stick-ring" aria-hidden="true" ref=\{joystickBase\}/);
  assert.match(SOURCE, /const joystickGeometry = useRef<\{/);
  assert.match(
    SOURCE,
    /const bounds = base\.getBoundingClientRect\(\);[\s\S]*joystickGeometry\.current = \{[\s\S]*centerX:[\s\S]*centerY:[\s\S]*radius:/,
  );
  assert.match(
    SOURCE,
    /joystickThumb\.current\.style\.transform =[\s\S]*translate3d\(\$\{sample\.thumbX\}px, \$\{sample\.thumbY\}px, 0\)/,
  );
  assert.doesNotMatch(SOURCE, /setJoystickThumb/);
  assert.match(
    SOURCE,
    /touchInteractAvailable = Boolean\(interaction\)[\s\S]*Boolean\(themeMechanic\?\.canActivate && !stealthBlackoutActive\)[\s\S]*playerMode === "aligning-hide"/,
  );
  assert.match(SOURCE, /setPointerCapture\(event\.pointerId\)/);
  assert.match(SOURCE, /ready && !pausedRef\.current/);
  assert.match(SOURCE, /environmentSoundMasking: environment\.soundMasking/);
  assert.match(SOURCE, /visionRangeMultiplier: environment\.visionRangeMultiplier/);
  assert.match(SOURCE, /triggerAnimationFootstep\(/);
  assert.match(SOURCE, /stepMechanicInstance\(/);
  assert.match(SOURCE, /simulation\.emitWorldSound\(/);
  assert.match(
    SOURCE,
    /emittedMechanicSound\?\.sourceType === "environment-decoy"[\s\S]*type: "decoy-deployed"/,
  );
  assert.match(
    SOURCE,
    /event\.type === "evidence-investigation-completed"[\s\S]*source: portableDecoySourceIds\.has\(event\.evidenceId\)[\s\S]*\? "decoy"[\s\S]*: "theme-mechanic"/,
  );
  assert.match(
    SOURCE,
    /event\.evidenceId === mechanicDefinition\.soundSource\.sourceId[\s\S]*type: "theme-mechanic-advantage"/,
  );
});

test("gameplay hotkeys defer phase authority to the current simulation command", () => {
  assert.match(SOURCE, /key === "g"\) commands\.current\.useStealthTool\(\)/u);
  assert.match(SOURCE, /key === "c"\) commands\.current\.eraseEvidence\(\)/u);
  assert.match(SOURCE, /key === "f"\) commands\.current\.deployDecoy\(\)/u);
  assert.doesNotMatch(SOURCE, /key === "g" && phase === "playing"/u);
  assert.match(
    SOURCE,
    /useEffect\(\(\) => \{\s*keyboardPresentationRef\.current\s*=\s*\{\s*phase,\s*selectedLevelIndex,\s*hideExitSelection,\s*\};\s*\}, \[hideExitSelection, phase, selectedLevelIndex\]\);/u,
  );
  assert.match(
    SOURCE,
    /addEventListener\("keydown", keyDown\)[\s\S]*\}, \[resetAnalogueMove, updateTouchQuietMode\]\);/u,
  );
  assert.doesNotMatch(
    SOURCE,
    /\}, \[chooseLevel, hideExitSelection, phase, resetAnalogueMove, selectedLevelIndex\]\);/u,
  );
});

test("render frames latch actions while every gameplay domain advances on fixed ticks", () => {
  assert.match(SOURCE, /advanceFixedStepHostFrame\(/);
  assert.match(
    SOURCE,
    /simulationAcceptsFixedTicks\s*=\s*latestState\.phase\s*===\s*"playing"[\s\S]*resetFixedStepHost\(\s*fixedStepHost,\s*latestState\.tick/u,
  );
  assert.doesNotMatch(SOURCE, /pendingSimulationInteract/);

  const loopStart = SOURCE.indexOf(
    "fixedStepIndex < fixedStepTicks.length;",
  );
  const loopEnd = SOURCE.indexOf(
    "latestState = {\n          ...latestState,\n          events: simulationFrameEvents,",
    loopStart,
  );
  assert.ok(loopStart >= 0, "fixed-step host loop is missing");
  assert.ok(loopEnd > loopStart, "fixed-step host loop has no state boundary");
  const fixedTickLoop = SOURCE.slice(loopStart, loopEnd);

  assert.match(
    fixedTickLoop,
    /latestState\.tick\s*>=\s*missionCommitment\.completesAtTick/u,
    "mission completion must be evaluated for each authoritative tick",
  );
  assert.match(
    fixedTickLoop,
    /stepMechanicInstance\(mechanicInstance,\s*\{\s*deltaSeconds:\s*fixedStepSeconds,\s*nowSeconds:\s*latestState\.elapsedSeconds\s*\+\s*fixedStepSeconds/u,
    "theme mechanics must not advance on render delta",
  );
  assert.match(fixedTickLoop, /stepPortableDecoy\(portableDecoyState/u);

  const directorIndex = fixedTickLoop.indexOf(
    "advanceDirectorForSimulationTick(",
  );
  const inputBuilderIndex = fixedTickLoop.indexOf(
    "const buildSimulationInput =",
  );
  const simulationIndex = fixedTickLoop.indexOf("simulation.advance(");
  assert.ok(directorIndex >= 0, "Director fixed-tick boundary is missing");
  assert.ok(
    inputBuilderIndex > directorIndex,
    "Director must activate/cancel before SimulationInput is built",
  );
  assert.ok(
    simulationIndex > inputBuilderIndex,
    "gameplay domains must settle before simulation.advance",
  );
  assert.match(
    SOURCE,
    /for \(const effect of presentationEffects\) effect\(\);/,
    "one-shot presentation effects must flush after the fixed-tick loop",
  );
});

test("stealth presentation keeps cabinets readable and gives Director blackouts the emergency treatment", () => {
  assert.match(
    SOURCE,
    /registerCameraOccluder\(`hero-locker-\$\{spot\.id\}`, \[root\]\)/,
    "hero lockers must participate in the local actor/tool camera cutout",
  );
  assert.match(
    SOURCE,
    /registerCameraOccluder\(\s*`\$\{campaignLevel\.campaign\.theme\}-hide-dressing`,\s*hideDressingBatches/u,
    "authored locker surrounds must not remain as a second opaque blocker",
  );
  assert.match(
    SOURCE,
    /directorBlackoutActive[\s\S]*activeDirectorEvent\.suggestion\.kind === "blackout"[\s\S]*\|\| directorBlackoutActive/u,
    "the frame-authoritative class path must include Director lighting events",
  );
  assert.match(
    SOURCE,
    /const stealthBlackoutActive = Boolean\([\s\S]*tensionDirector\.kind === "blackout"[\s\S]*stealthBlackoutActive \? " stealth-blackout-active"/u,
    "React reconciliation must preserve the same Director blackout class",
  );
});

test("stealth tools use distinct formal themed subassemblies with auditable provenance", () => {
  const manifest = SOURCE.match(
    /const THEME_STEALTH_TOOL_ART:[\s\S]*?\n\};\n\ntype HideArchetypeArtSpec/u,
  )?.[0] ?? "";
  assert.ok(manifest, "formal stealth-tool art manifest is missing");
  const sourceNodes = [...manifest.matchAll(/node: "([^"]+)"/gu)]
    .map((match) => match[1]);
  assert.equal(sourceNodes.length, 12, "four themes must bind three formal tool models");
  assert.equal(
    new Set(sourceNodes).size,
    12,
    "a formal source subassembly is reused across theme/tool bindings",
  );
  assert.match(SOURCE, /for \(const tool of STEALTH_TOOL_KINDS\)/u);
  assert.match(
    SOURCE,
    /const toolAsset = tool === "corner-mirror"[\s\S]*\? cornerMirrorKit[\s\S]*: themeKit/u,
  );
  assert.match(SOURCE, /resolveThemeNode\([\s\S]*toolAsset\.scene[\s\S]*\[toolSpec\.node\]/u);
  assert.match(SOURCE, /authoredGeometrySignature\(toolSource\)/u);
  assert.match(SOURCE, /authoredToolFallbackUsed = false/u);
  assert.match(
    SOURCE,
    /const STEALTH_CORNER_MIRROR_ASSET\s*=\s*[\s\S]*FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS\.cornerMirror/u,
  );
  assert.match(
    RUNTIME_ASSETS_SOURCE,
    /cornerMirror:\s*"\/models\/environment\/stealth-corner-mirrors\.glb\?v=2"/u,
  );
  assert.match(SOURCE, /const template = stealthToolModelTemplates\[receipt\.tool\]/u);
  assert.match(SOURCE, /authored-blackout-status-lens/u);
  assert.match(SOURCE, /polished-corner-mirror-face/u);
  assert.match(
    SOURCE,
    /const authoredMirrorPartNames = \[[\s\S]*object\.name\.startsWith\(`\$\{name\}_`\)[\s\S]*object\.name = authoredPartName/u,
    "theme clones must restore GLTFLoader-uniquified mirror part roles",
  );
  const mirrorPlacement = SOURCE.match(
    /\} else if \(receipt\.tool === "corner-mirror"\) \{[\s\S]*?\n      \} else \{/u,
  )?.[0] ?? "";
  assert.ok(mirrorPlacement, "dedicated corner-mirror placement is missing");
  assert.match(mirrorPlacement, /const solidDirections =/u);
  assert.match(
    mirrorPlacement,
    /const orthogonalSolidPairs =/u,
    "mirror mounting must select a real corner pair",
  );
  assert.match(
    mirrorPlacement,
    /left\.x \* right\.x \+ left\.y \* right\.y === 0/u,
    "opposite walls must never collapse the mirror mount bisector",
  );
  assert.doesNotMatch(
    mirrorPlacement,
    /solidDirections\.slice\(0,\s*2\)/u,
    "array order must not choose an opposite pair at a three-sided dead end",
  );
  assert.match(mirrorPlacement, /mountDirection\.x \* CELL \* 0\.88/u);
  assert.match(mirrorPlacement, /wallTangent\.x \* 0\.32/u);
  assert.match(mirrorPlacement, /authoredToolRuntimeScale/u);
  assert.doesNotMatch(
    mirrorPlacement,
    /new THREE\.(?:CircleGeometry|TorusGeometry|BoxGeometry|CylinderGeometry)/u,
    "the formal mirror must not regress to runtime primitive geometry",
  );
  assert.doesNotMatch(
    SOURCE,
    /\bstealthToolModelTemplate\b/u,
    "tools must not regress to one shared silhouette",
  );
});

test("resource QA locks render quality before renderer creation and compiles one settled scene", () => {
  const qualityLockIndex = SOURCE.indexOf("const qaRequestedRenderQuality");
  const rendererIndex = SOURCE.indexOf("new THREE.WebGLRenderer");
  assert.ok(qualityLockIndex >= 0, "QA quality request is not parsed");
  assert.ok(
    rendererIndex > qualityLockIndex,
    "QA quality must be selected before WebGLRenderer construction",
  );
  assert.match(
    SOURCE,
    /let qaRenderQualityLocked = qaRequestedRenderQuality !== null/u,
  );
  assert.match(
    SOURCE,
    /if \(\s*!qaRenderQualityLocked\s*&& qualityEvaluationSeconds/u,
  );
  assert.match(
    SOURCE,
    /const compileSettledQaScene = \(\) => \{[\s\S]*qaDecorativeSceneCompiled[\s\S]*!decorativeAssetsReady[\s\S]*deferredDressingFade !== null[\s\S]*!qaRenderQualityLocked[\s\S]*!prewarmTransientArtResources\(\)/u,
  );
  assert.match(
    SOURCE,
    /renderer\.render\(scene, camera\);\s*qaRenderedFrameCount \+= 1;\s*compileSettledQaScene\(\);/u,
  );
  assert.match(SOURCE, /let qaCaptureHoldDeadline = 0/u);
  assert.match(
    SOURCE,
    /if \(\s*qaCaptureHoldRequested\s*&& now >= qaCaptureHoldDeadline\s*\) \{[\s\S]*qaCaptureHoldRequested = false;[\s\S]*qaCaptureHoldDeadline = 0;[\s\S]*\}[\s\S]*if \(qaCaptureHoldRequested\) \{/u,
    "an abandoned CDP capture must release its browser-side render hold",
  );
  assert.match(
    SOURCE,
    /setCaptureHold:\s*\(\s*held,\s*leaseMilliseconds = QA_CAPTURE_HOLD_DEFAULT_LEASE_MS,\s*\) => \{/u,
    "the QA controller must expose a renewable finite lease",
  );
  assert.match(
    SOURCE,
    /if \(held\) \{[\s\S]*qaCaptureHoldRequested = true;[\s\S]*qaCaptureHoldDeadline = performance\.now\(\) \+ boundedLease;[\s\S]*\} else \{[\s\S]*qaCaptureHoldRequested = false;[\s\S]*qaCaptureHoldDeadline = 0;/u,
    "every capture hold request must renew or clear its finite lease",
  );
  assert.match(SOURCE, /qaDecorativeSceneCompileCount \+= 1/u);
  assert.match(SOURCE, /const prewarmTransientArtResources = \(\) =>/u);
  assert.match(SOURCE, /new THREE\.WebGLRenderTarget\(8, 8/u);
  assert.match(SOURCE, /qaTransientArtPrewarmCount \+= 1/u);
  assert.match(SOURCE, /if \(!qaDirectorEnabled\) return/u);
  assert.match(SOURCE, /setDirectorEnabled: \(enabled\) =>/u);
  assert.match(SOURCE, /currentTick: latestState\.tick/u);
  assert.match(SOURCE, /qualityTransitionCount: renderQualityTransitionCount/u);
  assert.match(SOURCE, /emergencyTransitionCount: emergencyQualityTransitionCount/u);
});

test("integration guide documents the authoritative render-host fixed-step contract", () => {
  assert.match(INTEGRATION, /advanceFixedStepHostFrame\(\)/);
  assert.match(
    INTEGRATION,
    /逐个 emitted tick 调用一次\s*`simulation\.advance\(fixedStepSeconds, input\)`/u,
  );
  assert.match(
    INTEGRATION,
    /非 `playing`、暂停、重开、切关[\s\S]*原子 `resetFixedStepHost/u,
  );
  assert.doesNotMatch(
    INTEGRATION,
    /不要自行按 60 Hz 循环/u,
    "the guide must not reintroduce the old render-delta-owned host contract",
  );
});

test("player HUD receives only release-smoothed public threat while a chaser is unobservable", () => {
  assert.match(SOURCE, /let playerKnowledge = createPlayerKnowledge\(\)/);
  assert.match(SOURCE, /playerKnowledge = updatePlayerKnowledge\(/);
  assert.match(SOURCE, /const danger = chaserObservable[\s\S]*publicThreat === "active" \? 0\.52 : publicThreat === "caution" \? 0\.28 : 0/);
  assert.match(SOURCE, /setPublicThreat\(playerKnowledge\.threat\)/);
  assert.match(SOURCE, /interaction\?\.kind === "exit" && publicThreat !== "calm"/);
  assert.match(SOURCE, /const urgentHideMarker = playerKnowledge\.threat !== "calm"/);
  assert.match(SOURCE, /const publicCameraThreat = chaserKnowledgeObservable[\s\S]*playerKnowledge\.threat === "active"/);
  assert.match(
    SOURCE,
    /chaserKnowledgeObservable !== renderedChaserObservable[\s\S]*setChaserObservable\(chaserKnowledgeObservable\)/u,
  );
  assert.doesNotMatch(SOURCE, /className=\{`playfield[^`]*threat-\$\{chaserMode\}/);
  assert.match(SOURCE, /chaserPosition: chaserKnowledgeObservable[\s\S]*playerKnownChaser\?\.position/);
});

test("player action commitments arbitrate every cross-system fixed-tick entry point", () => {
  const commitmentGuard = SOURCE.match(
    /const hasPlayerActionCommitment = \(\) => Boolean\([\s\S]*?\n    \);/u,
  )?.[0] ?? "";
  assert.ok(commitmentGuard, "the shared player-action commitment guard is missing");
  assert.match(commitmentGuard, /missionCommitment/u);
  assert.match(
    commitmentGuard,
    /mechanicRequiresMovementCommitment\(mechanicInstance\)/u,
  );
  assert.match(commitmentGuard, /portableDecoyThrowRemainingSeconds > 0/u);
  assert.match(commitmentGuard, /stealthToolbeltState\.commitment/u);
  assert.match(
    commitmentGuard,
    /stealthEvidenceState\.tick[\s\S]*stealthEvidenceState\.countermeasureBusyUntilTick/u,
  );

  const portableAttempt = SOURCE.match(
    /const attemptPortableDecoyDeployment = \([\s\S]*?\n    \};/u,
  )?.[0] ?? "";
  const toolAttempt = SOURCE.match(
    /const attemptStealthToolUse = \(\) => \{[\s\S]*?\n    \};/u,
  )?.[0] ?? "";
  const evidenceAttempt = SOURCE.match(
    /const attemptEvidenceErase = \(\) => \{[\s\S]*?\n    \};/u,
  )?.[0] ?? "";
  assert.match(portableAttempt, /\|\| hasPlayerActionCommitment\(\)/u);
  assert.match(toolAttempt, /\|\| hasPlayerActionCommitment\(\)/u);
  assert.match(evidenceAttempt, /\|\| hasPlayerActionCommitment\(\)/u);
  assert.match(
    SOURCE,
    /const missionCanActivate = Boolean\([\s\S]*?&& !hasPlayerActionCommitment\(\)[\s\S]*?\n        \);/u,
  );
  assert.match(
    SOURCE,
    /const mechanicConsumesInteraction = beforeMechanic\.canActivate[\s\S]*?&& !hasPlayerActionCommitment\(\);/u,
  );
  const mechanicActivation = SOURCE.match(
    /const mechanicConsumesInteraction = beforeMechanic\.canActivate[\s\S]*?;/u,
  )?.[0] ?? "";
  assert.match(
    SOURCE,
    /const activeBlackoutReceipt =\s*stealthToolbeltState\.activeEffects\["temporary-blackout"\]\?\.receipt;[\s\S]*const stealthBlackoutInteractionLocked =\s*toolBlackoutInteractionLocked\s*\|\| directorBlackoutInteractionLocked;/u,
    "the fixed-step host must derive blackout authority from the toolbelt receipt",
  );
  assert.match(
    mechanicActivation,
    /&& !stealthBlackoutInteractionLocked/u,
    "temporary blackout must block authoritative theme-mechanic activation",
  );
});

test("temporary blackout suppresses every React theme-mechanic affordance", () => {
  const blackoutDeclaration = SOURCE.indexOf(
    "const stealthBlackoutActive = Boolean(",
  );
  const themeVisibility = SOURCE.match(
    /const themeEventVisible = Boolean\([\s\S]*?\n  \);/u,
  )?.[0] ?? "";
  const interactionText = SOURCE.match(
    /const interactionText =[\s\S]*?\n          : null;/u,
  )?.[0] ?? "";
  const touchAvailability = SOURCE.match(
    /const touchInteractAvailable =[\s\S]*?;/u,
  )?.[0] ?? "";
  assert.ok(blackoutDeclaration >= 0, "the React blackout state is missing");
  assert.ok(
    blackoutDeclaration < SOURCE.indexOf("const themeEventVisible = Boolean("),
    "blackout state must be available before mechanic HUD derivation",
  );
  assert.match(
    themeVisibility,
    /!stealthBlackoutActive/u,
    "ready mechanic HUD must disappear during blackout",
  );
  assert.match(
    interactionText,
    /themeMechanic\?\.canActivate\s*&& !stealthBlackoutActive/u,
    "keyboard interaction copy must not advertise a blocked mechanic",
  );
  assert.match(
    touchAvailability,
    /themeMechanic\?\.canActivate\s*&& !stealthBlackoutActive/u,
    "touch interaction must not expose a blocked mechanic",
  );
});

test("the loaded corner-mirror kit is represented in placed-asset telemetry", () => {
  assert.match(
    SOURCE,
    /buildThemeMechanicView\(themeKitAsset, cornerMirrorAsset\);[\s\S]{0,400}placedAssetIds\.add\("stealth:corner-mirrors"\);/u,
    "the formal mirror kit must not be reported as loaded-but-unused",
  );
});

test("transient stealth art releases its unique placed-asset receipt on disposal", () => {
  assert.match(
    SOURCE,
    /`gameplay:stealth-evidence:\$\{evidence\.kind\}:\$\{evidence\.id\}`/u,
  );
  assert.match(
    SOURCE,
    /`gameplay:stealth-tool:\$\{receipt\.tool\}:\$\{receipt\.receiptId\}`/u,
  );

  const evidenceDisposal = SOURCE.match(
    /const disposeStealthEvidenceView = \(view: StealthEvidenceView\) => \{[\s\S]*?\n    \};/u,
  )?.[0] ?? "";
  const toolDisposal = SOURCE.match(
    /const disposeStealthToolWorldView = \(view: StealthToolWorldView\) => \{[\s\S]*?\n    \};/u,
  )?.[0] ?? "";
  assert.match(evidenceDisposal, /placedAssetIds\.delete\(view\.placedAssetId\)/u);
  assert.match(toolDisposal, /placedAssetIds\.delete\(view\.placedAssetId\)/u);
});
