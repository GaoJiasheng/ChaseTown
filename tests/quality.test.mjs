import assert from "node:assert/strict";
import test from "node:test";

import {
  EMERGENCY_RENDER_POLICIES,
  INITIAL_EMERGENCY_DEGRADATION_STATE,
  nextRenderQuality,
  RENDER_QUALITY_PROFILES,
  renderBudgetUtilization,
  renderWorkloadFitsProfile,
  selectInitialRenderQuality,
  updateEmergencyDegradation,
} from "../app/game/quality.ts";

test("initial render quality protects constrained touch devices", () => {
  assert.equal(selectInitialRenderQuality({
    viewportWidth: 390,
    viewportHeight: 844,
    devicePixelRatio: 3,
    coarsePointer: true,
    deviceMemoryGb: 4,
    hardwareConcurrency: 4,
  }), "mobile");
  assert.equal(selectInitialRenderQuality({
    viewportWidth: 1024,
    viewportHeight: 1366,
    devicePixelRatio: 2,
    coarsePointer: true,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
  }), "balanced");
  assert.equal(selectInitialRenderQuality({
    viewportWidth: 1728,
    viewportHeight: 1117,
    devicePixelRatio: 2,
    coarsePointer: false,
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
  }), "high");
});

test("quality governor downgrades quickly and upgrades only with durable headroom", () => {
  assert.equal(nextRenderQuality("high", 24, 2.4), "high");
  assert.equal(nextRenderQuality("high", 24, 2.5), "balanced");
  assert.equal(nextRenderQuality("balanced", 31, 3), "mobile");
  assert.equal(nextRenderQuality("mobile", 14, 11.9), "mobile");
  assert.equal(nextRenderQuality("mobile", 14, 12), "balanced");
  assert.equal(nextRenderQuality("high", 50, 8), "balanced");
});

test("quality profiles preserve premium high settings while reducing pixel work on mobile", () => {
  assert.equal(RENDER_QUALITY_PROFILES.high.shadowMapSize, 2048);
  assert.equal(RENDER_QUALITY_PROFILES.mobile.shadowMapSize, 1024);
  assert.ok(RENDER_QUALITY_PROFILES.mobile.maximumPixelRatio < RENDER_QUALITY_PROFILES.high.maximumPixelRatio);
  assert.ok(RENDER_QUALITY_PROFILES.mobile.atmosphericParticleScale < RENDER_QUALITY_PROFILES.high.atmosphericParticleScale);
});

test("quality profiles expose monotonically constrained geometry and shadow budgets", () => {
  const { high, balanced, mobile } = RENDER_QUALITY_PROFILES;
  assert.ok(high.maximumVisibleTriangles > balanced.maximumVisibleTriangles);
  assert.ok(balanced.maximumVisibleTriangles > mobile.maximumVisibleTriangles);
  assert.ok(high.maximumDrawCalls > balanced.maximumDrawCalls);
  assert.ok(balanced.maximumDrawCalls > mobile.maximumDrawCalls);
  assert.ok(high.maximumShadowTriangles > balanced.maximumShadowTriangles);
  assert.ok(balanced.maximumShadowTriangles >= mobile.maximumShadowTriangles);
  assert.ok(high.maximumShadowDrawCalls > balanced.maximumShadowDrawCalls);
  assert.ok(balanced.maximumShadowDrawCalls > mobile.maximumShadowDrawCalls);
  assert.equal(high.staticEnvironmentShadows, true);
  assert.equal(balanced.staticEnvironmentShadows, false);
  assert.equal(mobile.staticEnvironmentShadows, false);
  assert.ok(high.decorativeDistanceMeters > balanced.decorativeDistanceMeters);
  assert.ok(balanced.decorativeDistanceMeters > mobile.decorativeDistanceMeters);
});

test("workload budget rejects invalid and over-budget renderer counters", () => {
  const profile = RENDER_QUALITY_PROFILES.mobile;
  assert.equal(renderWorkloadFitsProfile(profile, {
    visibleTriangles: profile.maximumVisibleTriangles,
    drawCalls: profile.maximumDrawCalls,
    shadowTriangles: profile.maximumShadowTriangles,
    shadowDrawCalls: profile.maximumShadowDrawCalls,
  }), true);
  assert.equal(renderWorkloadFitsProfile(profile, {
    visibleTriangles: profile.maximumVisibleTriangles + 1,
    drawCalls: profile.maximumDrawCalls,
  }), false);
  assert.equal(renderWorkloadFitsProfile(profile, {
    visibleTriangles: 1,
    drawCalls: Number.NaN,
  }), false);
  assert.equal(renderWorkloadFitsProfile(profile, {
    visibleTriangles: 1,
    drawCalls: 1,
    shadowTriangles: profile.maximumShadowTriangles + 1,
  }), false);
});

test("geometry overload uses the same downgrade hysteresis as slow frames", () => {
  const high = RENDER_QUALITY_PROFILES.high;
  const overBudget = {
    visibleTriangles: high.maximumVisibleTriangles + 1,
    drawCalls: high.maximumDrawCalls,
    shadowTriangles: high.maximumShadowTriangles,
    shadowDrawCalls: high.maximumShadowDrawCalls,
  };
  assert.equal(nextRenderQuality("high", 12, 2.49, overBudget), "high");
  assert.equal(nextRenderQuality("high", 12, 2.5, overBudget), "balanced");
});

test("upgrade waits for durable frame headroom and an in-budget workload", () => {
  const mobile = RENDER_QUALITY_PROFILES.mobile;
  const withinBudget = {
    visibleTriangles: mobile.maximumVisibleTriangles,
    drawCalls: mobile.maximumDrawCalls,
  };
  const overBudget = {
    visibleTriangles: mobile.maximumVisibleTriangles,
    drawCalls: mobile.maximumDrawCalls + 1,
  };
  assert.equal(nextRenderQuality("mobile", 14, 11.99, withinBudget), "mobile");
  assert.equal(nextRenderQuality("mobile", 14, 12, withinBudget), "balanced");
  assert.equal(nextRenderQuality("mobile", 14, 30, overBudget), "mobile");
});

test("budget utilization exposes colour and shadow overload reasons separately", () => {
  const profile = RENDER_QUALITY_PROFILES.mobile;
  const utilization = renderBudgetUtilization(profile, {
    visibleTriangles: profile.maximumVisibleTriangles * 0.8,
    drawCalls: profile.maximumDrawCalls * 0.75,
    shadowTriangles: profile.maximumShadowTriangles * 1.01,
    shadowDrawCalls: profile.maximumShadowDrawCalls * 1.2,
  });
  assert.equal(utilization.visibleTriangles, 0.8);
  assert.equal(utilization.drawCalls, 0.75);
  assert.equal(utilization.shadowTriangles, 1.01);
  assert.equal(utilization.shadowDrawCalls, 1.2);
  assert.equal(utilization.peak, 1.2);
  assert.deepEqual(utilization.exceeded, ["shadowTriangles", "shadowDrawCalls"]);
});

test("mobile overload escalates emergency degradation and durable headroom recovers it", () => {
  const mobile = RENDER_QUALITY_PROFILES.mobile;
  const overShadowBudget = {
    visibleTriangles: mobile.maximumVisibleTriangles * 0.7,
    drawCalls: mobile.maximumDrawCalls * 0.7,
    shadowTriangles: mobile.maximumShadowTriangles + 1,
    shadowDrawCalls: mobile.maximumShadowDrawCalls,
  };
  let state = updateEmergencyDegradation(INITIAL_EMERGENCY_DEGRADATION_STATE, {
    tier: "mobile",
    p95FrameMilliseconds: 22,
    elapsedSeconds: 1.49,
    workload: overShadowBudget,
  });
  assert.equal(state.level, 0);
  state = updateEmergencyDegradation(state, {
    tier: "mobile",
    p95FrameMilliseconds: 22,
    elapsedSeconds: 0.01,
    workload: overShadowBudget,
  });
  assert.equal(state.level, 1);

  state = updateEmergencyDegradation(state, {
    tier: "mobile",
    p95FrameMilliseconds: 38,
    elapsedSeconds: 2.5,
    workload: overShadowBudget,
  });
  assert.equal(state.level, 2);

  const headroom = {
    visibleTriangles: mobile.maximumVisibleTriangles * 0.6,
    drawCalls: mobile.maximumDrawCalls * 0.6,
    shadowTriangles: mobile.maximumShadowTriangles * 0.6,
    shadowDrawCalls: mobile.maximumShadowDrawCalls * 0.6,
  };
  state = updateEmergencyDegradation(state, {
    tier: "mobile",
    p95FrameMilliseconds: 20,
    elapsedSeconds: 9.99,
    workload: headroom,
  });
  assert.equal(state.level, 2);
  state = updateEmergencyDegradation(state, {
    tier: "mobile",
    p95FrameMilliseconds: 20,
    elapsedSeconds: 0.01,
    workload: headroom,
  });
  assert.equal(state.level, 1);
});

test("emergency rendering removes optional work monotonically", () => {
  assert.deepEqual(
    Object.values(EMERGENCY_RENDER_POLICIES).map((policy) => policy.decorativeLodBias),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    Object.values(EMERGENCY_RENDER_POLICIES).map((policy) => policy.shadowCasterMode),
    ["profile", "critical-and-near", "critical-only", "characters-only"],
  );
  assert.equal(EMERGENCY_RENDER_POLICIES[3].hideOptionalDecorations, true);
});
