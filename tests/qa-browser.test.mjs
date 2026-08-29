import assert from "node:assert/strict";
import test from "node:test";

import {
  parseQaDelaySeconds,
  parseQaFlag,
  parseQaKidAnimation,
  parseQaKidAssetVariant,
  parseQaLevel,
  parseQaNormalizedTime,
  parseQaPoliceAssetVariant,
  parseQaPoliceAnimation,
  parseQaPoint,
  summarizeQaGltfDocument,
} from "../app/game/qa-browser.ts";

test("QA browser scenario points accept finite in-bounds coordinates", () => {
  assert.deepEqual(parseQaPoint("6,1"), { x: 6, y: 1 });
  assert.deepEqual(parseQaPoint(" 12.5, 7 "), { x: 12.5, y: 7 });
});

test("QA browser scenario points fail closed", () => {
  for (const value of [null, "", "1", "1,2,3", "x,2", "-1,2", "2,256"]) {
    assert.equal(parseQaPoint(value), null);
  }
});

test("QA browser level selection is one-based and bounded", () => {
  for (const level of [1, 5, 10]) assert.equal(parseQaLevel(String(level)), level);
  for (const value of [null, "", "0", "11", "1.5", "campus"]) {
    assert.equal(parseQaLevel(value), null);
  }
  assert.equal(parseQaLevel("4", 3), null);
});

test("QA browser spawn delay is finite and bounded", () => {
  assert.equal(parseQaDelaySeconds("12.5"), 12.5);
  assert.equal(parseQaDelaySeconds("60"), 60);
  for (const value of [null, "", "-1", "61", "later"]) {
    assert.equal(parseQaDelaySeconds(value), 0);
  }
});

test("QA browser flag accepts only the explicit one token", () => {
  assert.equal(parseQaFlag("1"), true);
  for (const value of [null, "", "0", "true", "yes", " 1 "]) {
    assert.equal(parseQaFlag(value), false);
  }
});

test("QA normalized animation samples are finite and bounded", () => {
  assert.equal(parseQaNormalizedTime("0"), 0);
  assert.equal(parseQaNormalizedTime("0.18"), 0.18);
  assert.equal(parseQaNormalizedTime("1"), 1);
  for (const value of [null, "", " ", "-0.01", "1.01", "NaN", "Infinity"]) {
    assert.equal(parseQaNormalizedTime(value), null);
  }
});

test("QA Police clip fixture maps only the five authoritative clips", () => {
  assert.deepEqual(
    ["Idle", "Run", "Alert", "Interact", "Resolve"].map(parseQaPoliceAnimation),
    ["idle", "run", "alert", "point", "protect"],
  );
  for (const value of [null, "", "Walk", "Caught", "Idle.extra"]) {
    assert.equal(parseQaPoliceAnimation(value), null);
  }
});

test("QA Police asset fixture accepts only explicit runtime variants", () => {
  assert.equal(parseQaPoliceAssetVariant("bootstrap"), "bootstrap");
  assert.equal(parseQaPoliceAssetVariant("high"), "high");
  for (const value of [null, "", "HIGH", "lod1", "source"]) {
    assert.equal(parseQaPoliceAssetVariant(value), null);
  }
});

test("QA Kid clip fixture maps exactly the twelve authoritative clips", () => {
  assert.deepEqual(
    [
      "Idle", "Walk", "Run", "TurnLeft", "TurnRight", "HideEnter",
      "HideIdle", "HidePeek", "HideExit", "Caught", "EscapeCelebrate", "Interact",
    ].map(parseQaKidAnimation),
    [
      "idle", "walk", "run", "turnLeft", "turnRight", "enterHide",
      "hideIdle", "peekLeft", "exitHide", "caught", "celebrate", "point",
    ],
  );
  for (const value of [null, "", "Crouch", "Search", "Resolve"]) {
    assert.equal(parseQaKidAnimation(value), null);
  }
});

test("QA Kid asset fixture accepts exactly the three production tiers", () => {
  assert.equal(parseQaKidAssetVariant("bootstrap"), "bootstrap");
  assert.equal(parseQaKidAssetVariant("lod1"), "lod1");
  assert.equal(parseQaKidAssetVariant("high"), "high");
  for (const value of [null, "", "HIGH", "webp", "source"]) {
    assert.equal(parseQaKidAssetVariant(value), null);
  }
});

test("QA glTF identity summarizes source topology and triangle modes", () => {
  const summary = summarizeQaGltfDocument({
    accessors: [
      { count: 12 },
      { count: 9 },
      { count: 6 },
      { count: 5 },
      { count: 4 },
    ],
    nodes: [
      { name: "Root" },
      { name: "LeftHand" },
      { name: "RightHand" },
    ],
    meshes: [
      {
        primitives: [
          { indices: 0 },
          { attributes: { POSITION: 1 } },
          { indices: 2, mode: 5 },
          { indices: 3, mode: 6 },
          { indices: 4, mode: 1 },
        ],
      },
    ],
    materials: [{}, {}],
    textures: [{}],
    skins: [{ joints: [1, 2] }, { joints: [2] }],
  });
  assert.deepEqual(summary, {
    nodes: 3,
    meshes: 1,
    primitives: 5,
    triangles: 14,
    materials: 2,
    textures: 1,
    skins: 2,
    joints: 2,
    jointNames: ["LeftHand", "RightHand"],
  });
});

test("QA glTF identity fails closed for missing source fields", () => {
  assert.deepEqual(summarizeQaGltfDocument(undefined), {
    nodes: 0,
    meshes: 0,
    primitives: 0,
    triangles: 0,
    materials: 0,
    textures: 0,
    skins: 0,
    joints: 0,
    jointNames: [],
  });
});
