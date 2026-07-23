import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAMPAIGN_LEVELS } from "../app/game/campaign.ts";
import {
  buildEnvironmentCompositionPlan,
  compositionMaterialVariantForCell,
  createCompositionDecalPixels,
  ENVIRONMENT_COMPOSITION_BUDGETS,
  environmentCompositionProfileForLevel,
  landmarkBeatPlanForLevel,
  LEVEL_ENVIRONMENT_COMPOSITIONS,
  localLightPoolPlanForLevel,
  sampleMechanicWorldFeedback,
  sceneEdgeClosurePlanForLevel,
  THEME_ENVIRONMENT_COMPOSITIONS,
} from "../app/game/environment-composition.ts";
import { isWalkable } from "../app/game/navigation.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THEMES = ["campus", "hospital", "fire-station", "factory"];
const KIT_PATHS = {
  campus: "public/models/environment/themes/campus-kit-bootstrap.glb",
  hospital: "public/models/environment/themes/hospital-kit-bootstrap.glb",
  "fire-station": "public/models/environment/themes/fire-station-kit-bootstrap.glb",
  factory: "public/models/environment/themes/factory-kit-bootstrap.glb",
};

async function glbNodeNames(relativePath) {
  const bytes = await readFile(path.join(ROOT, relativePath));
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "glTF");
  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.subarray(16, 20).toString("ascii");
  assert.equal(jsonType, "JSON");
  const gltf = JSON.parse(
    bytes.subarray(20, 20 + jsonLength).toString("utf8").replace(/\0+$/, ""),
  );
  return new Set(gltf.nodes.map((node) => node.name).filter(Boolean));
}

test("all ten chapters resolve to ordered landmark beats and a bounded composition plan", () => {
  assert.equal(CAMPAIGN_LEVELS.length, 10);
  assert.equal(Object.keys(LEVEL_ENVIRONMENT_COMPOSITIONS).length, 10);

  for (const level of CAMPAIGN_LEVELS) {
    const profile = environmentCompositionProfileForLevel(level);
    const plan = buildEnvironmentCompositionPlan(level, {
      qualityTier: "high",
      playerPosition: level.playerStart,
      availableDynamicLightSlots: 4,
    });
    assert.equal(profile.levelId, level.id);
    assert.equal(profile.propSet, level.campaign.atmosphere.propSet);
    assert.equal(profile.theme, level.campaign.theme);
    assert.equal(profile.landmarkSegments.length, 3);
    assert.equal(plan.landmarkBeats.length, 3);
    assert.ok(plan.criticalRoute.length >= 7);
    assert.deepEqual(
      plan.landmarkBeats.map(({ role }) => role),
      ["establish", "pressure", "payoff"],
    );
    assert.deepEqual(
      plan.landmarkBeats.map(({ label }) => label),
      [...level.campaign.landmarks],
    );
    assert.ok(plan.landmarkBeats.every(({ focusCell }) => isWalkable(level, focusCell)));
    assert.ok(
      plan.landmarkBeats.every((beat, index, beats) => (
        index === 0 || beat.routeIndex > beats[index - 1].routeIndex
      )),
      `${level.id} landmark beats must advance along the critical route`,
    );
    assert.equal(new Set(plan.landmarkBeats.map(({ nodeCandidates }) => nodeCandidates[0])).size, 3);
    assert.ok(plan.landmarkBeats.every(({ resolvedRouteFraction }) => (
      resolvedRouteFraction > 0 && resolvedRouteFraction < 1
    )));
    assert.ok(plan.activeLightPools.length <= ENVIRONMENT_COMPOSITION_BUDGETS.high.maximumLocalLightPools);
    assert.ok(plan.activeLightPools.every(({ castShadow }) => castShadow === false));
    assert.equal(plan.edgeClosure.additionalDrawCalls, 1);
    assert.equal(plan.edgeClosure.proceduralTriangles, 8);
    assert.ok(plan.decalInstanceLimit <= ENVIRONMENT_COMPOSITION_BUDGETS.high.maximumProceduralDecals);
  }
});

test("composition references only semantic nodes already present in bootstrap theme kits", async () => {
  for (const theme of THEMES) {
    const names = await glbNodeNames(KIT_PATHS[theme]);
    const style = THEME_ENVIRONMENT_COMPOSITIONS[theme];
    const required = [
      ...Object.values(style.architecture).flat(),
      ...style.edgeClosure.capNodeCandidates,
      ...style.edgeClosure.wallEndNodeCandidates,
      ...style.edgeClosure.cornerNodeCandidates,
      ...style.mechanicFeedback.sourceNodeCandidates,
      ...style.mechanicFeedback.partMotion.targetNodeCandidates,
      ...Object.values(LEVEL_ENVIRONMENT_COMPOSITIONS)
        .filter((profile) => profile.theme === theme)
        .flatMap((profile) => [
          ...profile.landmarkSegments.flatMap(({ nodeCandidates }) => nodeCandidates),
          ...profile.arrivalNodeCandidates,
          ...profile.hideDressingNodeCandidates,
          ...profile.exitNodeCandidates,
        ]),
    ];
    for (const node of new Set(required)) {
      assert.ok(names.has(node), `${theme} bootstrap kit is missing composition node ${node}`);
    }
  }

  const serialized = JSON.stringify({
    themes: THEME_ENVIRONMENT_COMPOSITIONS,
    levels: LEVEL_ENVIRONMENT_COMPOSITIONS,
  });
  assert.doesNotMatch(serialized, /\/models\/|\.glb|\.ktx2|\.png|\.jpe?g/i);
  for (const budget of Object.values(ENVIRONMENT_COMPOSITION_BUDGETS)) {
    assert.equal(budget.additionalNetworkRequests, 0);
    assert.equal(budget.additionalNetworkBytes, 0);
    assert.equal(budget.additionalTextureFiles, 0);
    assert.ok(budget.maximumAdditionalDrawCalls <= 2);
    assert.ok(budget.maximumAdditionalTriangles <= 256);
  }
});

test("material variation is deterministic, finite and cacheable instead of per-cell material growth", () => {
  for (const level of CAMPAIGN_LEVELS) {
    for (const role of ["wall", "floor", "trim", "landmark"]) {
      const selections = [];
      for (let y = 0; y < level.height; y += 1) {
        for (let x = 0; x < level.width; x += 1) {
          if (!isWalkable(level, { x, y })) continue;
          const first = compositionMaterialVariantForCell(level, role, { x, y });
          const second = compositionMaterialVariantForCell(level, role, { x, y });
          assert.strictEqual(first, second);
          assert.ok(first.sharedMaterialSlot >= 0 && first.sharedMaterialSlot <= 2);
          assert.ok(first.colorMix >= 0 && first.colorMix <= 0.1);
          assert.ok(Math.abs(first.roughnessDelta) <= 0.2);
          assert.ok(Math.abs(first.metalnessDelta) <= 0.1);
          selections.push(first.id);
        }
      }
      const unique = new Set(selections);
      assert.ok(unique.size >= 2, `${level.id}/${role} should visibly break repetition`);
      assert.ok(
        unique.size <= ENVIRONMENT_COMPOSITION_BUDGETS.high.maximumMaterialVariantsPerSurface,
        `${level.id}/${role} exceeds the shared material variant budget`,
      );
    }
  }
});

test("one deterministic in-memory marking per theme supplies decal variation with zero network bytes", () => {
  const hashes = new Set();
  for (const theme of THEMES) {
    const level = CAMPAIGN_LEVELS.find((candidate) => candidate.campaign.theme === theme);
    assert.ok(level);
    const first = createCompositionDecalPixels(theme, level.campaign.palette);
    const second = createCompositionDecalPixels(theme, level.campaign.palette);
    assert.equal(first.width, 64);
    assert.equal(first.height, 64);
    assert.equal(first.byteLength, 64 * 64 * 4);
    assert.equal(first.networkBytes, 0);
    assert.ok(first.byteLength <= ENVIRONMENT_COMPOSITION_BUDGETS.mobile.maximumRuntimeTextureBytes);
    assert.deepEqual(first.data, second.data);
    assert.ok(
      first.data.some((value, index) => index % 4 === 3 && value > 0),
      `${theme} marking must contain visible authored pixels`,
    );
    hashes.add(createHash("sha256").update(first.data).digest("hex"));
  }
  assert.equal(hashes.size, 4, "each theme should retain a distinct marking language");
});

test("edge closure is a four-side batched skirt with authored cap nodes and no shadow work", () => {
  for (const level of CAMPAIGN_LEVELS) {
    const closure = sceneEdgeClosurePlanForLevel(level);
    assert.deepEqual(closure.segments.map(({ side }) => side), ["north", "east", "south", "west"]);
    assert.deepEqual(closure.segments[0].center, { x: (level.width - 1) / 2, y: -0.5 });
    assert.deepEqual(closure.segments[1].center, { x: level.width - 0.5, y: (level.height - 1) / 2 });
    assert.equal(closure.geometryMode, "single-batched-skirt");
    assert.equal(closure.castShadow, false);
    assert.equal(closure.receiveShadow, false);
    assert.equal(closure.additionalDrawCalls, 1);
    assert.equal(closure.proceduralTriangles, 8);
    assert.ok(closure.groundMarginCells >= 1 && closure.groundMarginCells <= 1.5);
    assert.match(closure.fogColor, /^#[0-9a-f]{6}$/i);
  }
});

test("light selection respects quality and the renderer's remaining dynamic-light slots", () => {
  for (const level of CAMPAIGN_LEVELS) {
    const beats = landmarkBeatPlanForLevel(level);
    const high = localLightPoolPlanForLevel(level, {
      qualityTier: "high",
      playerPosition: beats[0].focusCell,
      availableDynamicLightSlots: 5,
    });
    const mobile = localLightPoolPlanForLevel(level, {
      qualityTier: "mobile",
      playerPosition: beats[0].focusCell,
      availableDynamicLightSlots: 5,
    });
    const unavailable = localLightPoolPlanForLevel(level, {
      qualityTier: "high",
      availableDynamicLightSlots: 0,
    });
    assert.equal(high.length, 2);
    assert.ok(high.some(({ segmentId }) => segmentId === beats[0].id));
    assert.equal(mobile.length, 1);
    assert.equal(unavailable.length, 0);
    assert.ok([...high, ...mobile].every(({ castShadow }) => castShadow === false));
  }
});

test("mechanic world feedback has continuous warning, active and recovery stages under tier budgets", () => {
  for (const theme of THEMES) {
    assert.deepEqual(
      Object.keys(THEME_ENVIRONMENT_COMPOSITIONS[theme].mechanicFeedback.stages),
      ["warning", "active", "recover"],
    );
    const idle = sampleMechanicWorldFeedback(theme, {
      phase: "ready",
      progress: 0,
    });
    const warningStart = sampleMechanicWorldFeedback(theme, {
      phase: "warning",
      progress: 0,
    });
    const warningEnd = sampleMechanicWorldFeedback(theme, {
      phase: "warning",
      progress: 1,
    });
    const activeStart = sampleMechanicWorldFeedback(theme, {
      phase: "active",
      progress: 0,
    });
    const activeEnd = sampleMechanicWorldFeedback(theme, {
      phase: "active",
      progress: 1,
    });
    const recoverStart = sampleMechanicWorldFeedback(theme, {
      phase: "cooldown",
      progress: 0,
    });
    const recoverEnd = sampleMechanicWorldFeedback(theme, {
      phase: "cooldown",
      progress: 1,
    });
    const mobilePeak = sampleMechanicWorldFeedback(theme, {
      phase: "active",
      progress: 0.5,
      qualityTier: "mobile",
    });
    const reducedMotion = sampleMechanicWorldFeedback(theme, {
      phase: "active",
      progress: 0.42,
      reducedMotion: true,
    });

    assert.equal(idle.stage, null);
    assert.equal(idle.lightIntensity, 0);
    assert.equal(idle.particleCount, 0);
    assert.equal(warningStart.stage, "warning");
    assert.equal(warningStart.envelope, 0);
    assert.equal(activeStart.stage, "active");
    assert.ok(activeStart.envelope > 0.8);
    assert.equal(recoverStart.stage, "recover");
    assert.equal(recoverStart.envelope, 1);
    assert.ok(Math.abs(warningEnd.lightIntensity - activeStart.lightIntensity) < 1e-10);
    assert.ok(Math.abs(activeEnd.lightIntensity - recoverStart.lightIntensity) < 1e-10);
    assert.ok(Math.abs(warningEnd.partMotionAmount) < 1e-10);
    assert.ok(Math.abs(activeStart.partMotionAmount) < 1e-10);
    assert.equal(recoverEnd.lightIntensity, 0);
    assert.equal(recoverEnd.particleCount, 0);
    assert.ok(mobilePeak.particleCount <= ENVIRONMENT_COMPOSITION_BUDGETS.mobile.maximumMechanicParticles);
    assert.equal(reducedMotion.scaleMultiplier, 1);
    assert.equal(reducedMotion.partMotionAmount, 0);
    assert.equal(reducedMotion.usesPooledLocalLight, true);
    assert.equal(reducedMotion.usesAtmosphereParticleBuffer, true);
  }
});
