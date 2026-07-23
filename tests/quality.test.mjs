import assert from "node:assert/strict";
import test from "node:test";

import {
  nextRenderQuality,
  RENDER_QUALITY_PROFILES,
  selectInitialRenderQuality,
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
