import assert from "node:assert/strict";
import test from "node:test";

import { RENDER_QUALITY_PROFILES } from "../app/game/quality.ts";
import {
  decideRuntimeVisibility,
  decorationLodThresholds,
  nextDecorationLod,
  resolveRuntimeObjectPolicy,
} from "../app/game/runtime-visibility.ts";

test("distance LOD uses hysteresis instead of chattering at a boundary", () => {
  const profile = RENDER_QUALITY_PROFILES.mobile;
  const thresholds = decorationLodThresholds(profile);
  assert.equal(
    nextDecorationLod(thresholds.fullDistanceMeters + 0.1, "full", profile),
    "full",
  );
  assert.equal(
    nextDecorationLod(
      thresholds.fullDistanceMeters + thresholds.hysteresisMeters + 0.01,
      "full",
      profile,
    ),
    "reduced",
  );
  assert.equal(
    nextDecorationLod(thresholds.fullDistanceMeters - 0.1, "reduced", profile),
    "reduced",
  );
  assert.equal(
    nextDecorationLod(
      thresholds.fullDistanceMeters - thresholds.hysteresisMeters - 0.01,
      "reduced",
      profile,
    ),
    "full",
  );
});

test("room culling retains one transition room only for previously visible objects", () => {
  const profile = RENDER_QUALITY_PROFILES.balanced;
  const retained = decideRuntimeVisibility({
    role: "decoration",
    roomId: "ward-a",
    distanceMeters: 8,
    previousVisible: true,
    previousLod: "full",
  }, {
    visibleRoomIds: ["ward-b"],
    retainedRoomIds: ["ward-a"],
  }, profile);
  assert.equal(retained.visible, true);

  const fresh = decideRuntimeVisibility({
    role: "decoration",
    roomId: "ward-a",
    distanceMeters: 8,
    previousVisible: false,
  }, {
    visibleRoomIds: ["ward-b"],
    retainedRoomIds: ["ward-a"],
  }, profile);
  assert.equal(fresh.visible, false);
  assert.equal(fresh.reason, "outside-room-set");
});

test("critical characters, lockers, navigation and objectives bypass manual culling", () => {
  const profile = RENDER_QUALITY_PROFILES.mobile;
  for (const role of ["player", "chaser", "locker", "objective", "navigation"]) {
    const decision = decideRuntimeVisibility({
      role,
      roomId: "offscreen-room",
      distanceMeters: 10_000,
      inCameraFrustum: false,
    }, {
      visibleRoomIds: ["current-room"],
    }, profile, 3);
    assert.equal(decision.visible, true, `${role} must remain visible`);
    assert.equal(decision.lod, "full");
    assert.equal(decision.protectedFromEmergency, true);
  }
});

test("maximum emergency culls optional decorations but preserves critical silhouettes", () => {
  const decoration = resolveRuntimeObjectPolicy({
    role: "decoration",
    baseVisible: true,
    baseCastShadow: true,
    baseLod: "full",
    emergencyLevel: 3,
  });
  assert.equal(decoration.visible, false);
  assert.equal(decoration.castShadow, false);

  const player = resolveRuntimeObjectPolicy({
    role: "player",
    baseVisible: true,
    baseCastShadow: true,
    emergencyLevel: 3,
  });
  assert.equal(player.visible, true);
  assert.equal(player.castShadow, true);

  const locker = resolveRuntimeObjectPolicy({
    role: "locker",
    baseVisible: true,
    baseCastShadow: true,
    emergencyLevel: 3,
  });
  assert.equal(locker.visible, true);
  assert.equal(locker.castShadow, false);
  assert.equal(locker.protectedFromEmergency, true);
});

test("architecture is room-culled but never distance-culled", () => {
  const profile = RENDER_QUALITY_PROFILES.mobile;
  assert.equal(decideRuntimeVisibility({
    role: "architecture",
    roomId: "factory-floor",
    distanceMeters: 10_000,
  }, {
    visibleRoomIds: ["factory-floor"],
  }, profile).visible, true);
  assert.equal(decideRuntimeVisibility({
    role: "architecture",
    roomId: "boiler-room",
    distanceMeters: 1,
  }, {
    visibleRoomIds: ["factory-floor"],
  }, profile).visible, false);
});
