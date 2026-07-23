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
  assert.match(SOURCE, /externalAssetUrisFromGlb\(bytes\)[\s\S]*fetchControlledDependency/);
  assert.match(SOURCE, /loadingManager\.setURLModifier/);
  assert.match(SOURCE, /loader\.parseAsync\(bytes/);
  assert.match(SOURCE, /import\("three\/examples\/jsm\/loaders\/KTX2Loader\.js"\)[\s\S]*new KTX2Loader\(loadingManager\)[\s\S]*setTranscoderPath\("\/basis\/"\)[\s\S]*detectSupport\(renderer\)/);
  assert.doesNotMatch(SOURCE, /^import \{ KTX2Loader \}/m);
  assert.match(SOURCE, /sceneAssets\.abort\(new DOMException\("Scene disposed"/);
  assert.match(SOURCE, /ktx2Loader\?\.dispose\(\)/);
});

test("mobile controls, pause and theme mechanics drive the real simulation", () => {
  assert.match(SOURCE, /sampleVirtualStick\(/);
  assert.match(SOURCE, /combineScreenMove\(/);
  assert.match(SOURCE, /if \(joystickPointerId\.current !== null\) return/);
  assert.match(SOURCE, /className="stick-ring" aria-hidden="true" ref=\{joystickBase\}/);
  assert.match(SOURCE, /touchInteractAvailable = Boolean\(interaction\) \|\| playerMode === "aligning-hide"/);
  assert.match(SOURCE, /setPointerCapture\(event\.pointerId\)/);
  assert.match(SOURCE, /ready && !pausedRef\.current/);
  assert.match(SOURCE, /environmentSoundMasking: environment\.soundMasking/);
  assert.match(SOURCE, /visionRangeMultiplier: environment\.visionRangeMultiplier/);
  assert.match(SOURCE, /triggerAnimationFootstep\(/);
  assert.match(SOURCE, /setThemeMechanicActivity\(environmentActivity\)/);
});

test("player HUD receives only release-smoothed public threat while a chaser is unobservable", () => {
  assert.match(SOURCE, /let playerKnowledge = createPlayerKnowledge\(\)/);
  assert.match(SOURCE, /playerKnowledge = updatePlayerKnowledge\(/);
  assert.match(SOURCE, /const danger = chaserObservable[\s\S]*publicThreat === "active" \? 0\.52 : publicThreat === "caution" \? 0\.28 : 0/);
  assert.match(SOURCE, /setPublicThreat\(playerKnowledge\.threat\)/);
  assert.match(SOURCE, /interaction\?\.kind === "exit" && publicThreat !== "calm"/);
  assert.match(SOURCE, /const urgentHideMarker = playerKnowledge\.threat !== "calm"/);
  assert.match(SOURCE, /const publicCameraThreat = chaserKnowledgeObservable[\s\S]*playerKnowledge\.threat === "active"/);
  assert.doesNotMatch(SOURCE, /className=\{`playfield[^`]*threat-\$\{chaserMode\}/);
  assert.match(SOURCE, /chaserPosition: chaserKnowledgeObservable[\s\S]*playerKnownChaser\?\.position/);
});
