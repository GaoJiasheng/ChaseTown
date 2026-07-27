import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeFramePair,
  auditLightingStability,
  auditProbePixelStability,
  detectLikelyCoplanarDuplicates,
  evaluateFrameStabilityResults,
  staticSceneSignature,
  summarizePairMetrics,
} from "../scripts/frame-stability-visual-qa.mjs";

function analysisFrame(width, height, sample) {
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = sample(x, y);
    }
  }
  return { width, height, pixels };
}

function colorAnalysisFrame(width, height, sample) {
  const colorPixels = Buffer.alloc(width * height * 3);
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const [red, green, blue] = sample(x, y);
      colorPixels[index * 3] = red;
      colorPixels[index * 3 + 1] = green;
      colorPixels[index * 3 + 2] = blue;
      pixels[index] = (77 * red + 150 * green + 29 * blue) >> 8;
    }
  }
  return { width, height, pixels, colorPixels };
}

test("aligned stationary frames have zero temporal residual", () => {
  const frame = analysisFrame(24, 18, (x, y) => (x * 17 + y * 9) % 255);
  const metric = analyzeFramePair(frame, frame);
  assert.deepEqual(metric.shift, { dx: 0, dy: 0 });
  assert.equal(metric.meanAbsoluteDifference, 0);
  assert.equal(metric.strongChangedRatio, 0);
  assert.equal(metric.affectedTileRatio, 0);
});

test("global one-pixel camera motion is aligned before flicker scoring", () => {
  const first = analysisFrame(40, 24, (x, y) => (x * 13 + y * 23) % 251);
  const second = analysisFrame(40, 24, (x, y) => (
    x === 0 ? 0 : first.pixels[y * first.width + x - 1]
  ));
  const metric = analyzeFramePair(first, second);
  assert.deepEqual(metric.shift, { dx: 1, dy: 0 });
  assert.equal(metric.meanAbsoluteDifference, 0);
  assert.equal(metric.strongChangedRatio, 0);
});

test("localized parallax during normal camera motion is not a moving flash", () => {
  const background = (x, y) => (x * 13 + y * 23) % 211;
  const first = analysisFrame(72, 48, (x, y) => (
    x >= 18 && x < 25 && y >= 12 && y < 34 ? 245 : background(x, y)
  ));
  const second = analysisFrame(72, 48, (x, y) => {
    if (x >= 20 && x < 27 && y >= 12 && y < 34) return 245;
    return x === 0 ? 0 : background(x - 1, y);
  });
  const metric = analyzeFramePair(first, second);
  const audit = auditProbePixelStability([metric], { moving: true });
  assert.deepEqual(metric.shift, { dx: 1, dy: 0 });
  assert.equal(audit.movingUnexpected, false);
  assert.deepEqual(audit.movingFlashFrames, []);
});

test("whole-frame material flashes remain visible after alignment", () => {
  const dark = analysisFrame(36, 24, () => 32);
  const bright = analysisFrame(36, 24, () => 160);
  const metric = analyzeFramePair(dark, bright);
  const summary = summarizePairMetrics([metric]);
  const audit = auditProbePixelStability([metric], { moving: true });
  assert.equal(metric.strongChangedRatio, 1);
  assert.equal(metric.affectedTileRatio, 1);
  assert.equal(summary.strongChangedRatioP95, 1);
  assert.equal(audit.movingUnexpected, true);
  assert.deepEqual(audit.movingFlashFrames[0].findings, [
    "whole-frame-material-flash",
    "coherent-full-frame-brightness-flash",
  ]);
});

test("one isolated full-frame flash fails a 23-pair stationary probe", () => {
  const stableMetric = {
    meanAbsoluteDifference: 0,
    meanSignedLumaDifference: 0,
    moderateChangedRatio: 0,
    coherentModerateRatio: 0,
    directionalModerateCoherence: 0,
    strongChangedRatio: 0,
    severeChangedRatio: 0,
    affectedTileRatio: 0,
  };
  const isolatedFlash = {
    ...stableMetric,
    frame: 14,
    meanAbsoluteDifference: 128,
    meanSignedLumaDifference: 128,
    moderateChangedRatio: 1,
    coherentModerateRatio: 1,
    directionalModerateCoherence: 1,
    strongChangedRatio: 1,
    severeChangedRatio: 1,
    affectedTileRatio: 1,
  };
  const metrics = Array.from(
    { length: 23 },
    (_, index) => (index === 12 ? isolatedFlash : stableMetric),
  );
  const audit = auditProbePixelStability(metrics);
  assert.equal(audit.summary.strongChangedRatioP95, 0);
  assert.equal(audit.summary.strongChangedRatioMaximum, 1);
  assert.equal(audit.staticUnexpected, true);
  assert.deepEqual(audit.staticFlashFrames, [{
    frame: 14,
    findings: [
      "whole-frame-material-flash",
      "coherent-full-frame-brightness-flash",
    ],
    metric: {
      frame: 14,
      shift: undefined,
      alignmentError: undefined,
      meanAbsoluteDifference: 128,
      meanSignedLumaDifference: 128,
      moderateChangedRatio: 1,
      coherentModerateRatio: 1,
      directionalModerateCoherence: 1,
      strongChangedRatio: 1,
      severeChangedRatio: 1,
      affectedTileRatio: 1,
    },
  }]);
});

test("equal-luminance whole-frame material swaps fail moving QA", () => {
  const red = colorAnalysisFrame(36, 24, () => [255, 0, 0]);
  const green = colorAnalysisFrame(36, 24, () => [0, 131, 0]);
  const metric = analyzeFramePair(red, green);
  const audit = auditProbePixelStability([metric], { moving: true });
  assert.equal(metric.meanSignedLumaDifference, 0);
  assert.equal(metric.strongChangedRatio, 1);
  assert.equal(audit.movingUnexpected, true);
  assert.deepEqual(audit.movingFlashFrames[0].findings, [
    "whole-frame-material-flash",
  ]);
});

test("scene audit flags exact and same-plane duplicate meshes", () => {
  const shared = {
    name: "WallPanel",
    parent: "HospitalWing",
    materials: ["hospital-wall"],
    center: { x: 4, y: 1.5, z: 8 },
    size: { x: 2, y: 3, z: 0.02 },
  };
  const objects = [
    shared,
    structuredClone(shared),
    {
      ...structuredClone(shared),
      name: "WallPanelOverlay",
      size: { x: 1.96, y: 2.96, z: 0.02 },
    },
    {
      ...structuredClone(shared),
      name: "production-character",
      parent: "kid-character",
    },
  ];
  const duplicates = detectLikelyCoplanarDuplicates(objects);
  assert.equal(duplicates.exact.length, 1);
  assert.equal(duplicates.exact[0].count, 2);
  assert.ok(duplicates.planar.length >= 1);
  assert.equal(staticSceneSignature(objects).length, 3);
});

function lightingFrame({
  target = { x: 3, y: 0, z: 7 },
  selected = ["hero-1"],
  visibleCount = 1,
  gain = 1,
} = {}) {
  return {
    state: {
      render: { shadowMapSize: 2048 },
      lightingStability: {
        globalBounceMode: "steady",
        selectedPerformanceLightIds: selected,
        visiblePerformanceLightCount: visibleCount,
        performanceLights: [{
          id: "hero-1",
          sourceIntensity: 2,
          appliedIntensity: 2 * gain,
          gain,
          visible: gain > 0,
        }],
        shadowTarget: target,
      },
    },
  };
}

test("lighting contract accepts a stationary finite high-quality budget", () => {
  const audit = auditLightingStability([
    lightingFrame(),
    lightingFrame(),
    lightingFrame(),
  ], false);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.capacity, 5);
});

test("lighting contract rejects budget overflow and fractional shadow texel motion", () => {
  const audit = auditLightingStability([
    lightingFrame({ visibleCount: 6 }),
    lightingFrame({
      target: { x: 3.001, y: 0, z: 7 },
      visibleCount: 6,
      gain: Number.NaN,
    }),
  ], true);
  assert.ok(audit.problems.some(({ kind }) => kind === "visible-light-capacity"));
  assert.ok(audit.problems.some(({ kind }) => kind === "invalid-light-state"));
  assert.ok(audit.problems.some(({ kind }) => kind === "fractional-shadow-texel-step"));
});

function stableProbe() {
  return {
    hardInstability: false,
    staticUnexpected: false,
    movingUnexpected: false,
    scene: {
      likelyCoplanarDuplicates: {
        exact: [],
        planar: [],
      },
    },
  };
}

function verdictFixture() {
  const stationary = () => stableProbe();
  const moving = () => stableProbe();
  return {
    themes: [{ id: "campus" }],
    results: {
      campus: {
        default: {
          stationary: stationary(),
          moving: moving(),
        },
        "no-camera-cutout": {
          stationary: stationary(),
          moving: moving(),
        },
        comparison: {
          cutoutSuspect: false,
        },
      },
    },
  };
}

test("full verdict accepts stable stationary and moving probes", () => {
  const { themes, results } = verdictFixture();
  const evaluation = evaluateFrameStabilityResults(themes, results);
  assert.equal(evaluation.verdict.stable, true);
  assert.deepEqual(evaluation.verdict.hardProblems, []);
  assert.deepEqual(evaluation.verdict.staticFlicker, []);
  assert.deepEqual(evaluation.verdict.movingFlicker, []);
  assert.deepEqual(evaluation.verdict.cutoutSuspects, []);
});

test("full verdict rejects moving-only full-screen flashes", () => {
  const { themes, results } = verdictFixture();
  results.campus.default.moving.movingUnexpected = true;
  const evaluation = evaluateFrameStabilityResults(themes, results);
  assert.equal(evaluation.verdict.stable, false);
  assert.deepEqual(evaluation.verdict.movingFlicker, [
    "campus/default/moving",
  ]);
});

test("full verdict rejects camera-cutout flicker suspects", () => {
  const { themes, results } = verdictFixture();
  results.campus.comparison.cutoutSuspect = true;
  const evaluation = evaluateFrameStabilityResults(themes, results);
  assert.equal(evaluation.verdict.stable, false);
  assert.deepEqual(evaluation.verdict.cutoutSuspects, ["campus"]);
});

test("full verdict reports hard, static, and coplanar findings", () => {
  const { themes, results } = verdictFixture();
  results.campus.default.stationary.hardInstability = true;
  results.campus.default.stationary.staticUnexpected = true;
  results.campus.default.stationary.scene.likelyCoplanarDuplicates.exact = [{
    count: 2,
  }];
  const evaluation = evaluateFrameStabilityResults(themes, results);
  assert.equal(evaluation.verdict.stable, false);
  assert.deepEqual(evaluation.verdict.hardProblems, [
    "campus/default/stationary",
  ]);
  assert.deepEqual(evaluation.verdict.staticFlicker, [
    "campus/default/stationary",
  ]);
  assert.equal(evaluation.verdict.coplanarWarningCount, 1);
});
