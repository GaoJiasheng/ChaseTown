import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  accessorRows,
  auditLodPair,
  loadGlb,
} from "../tools/art_pipeline/build_character_lod1.mjs";
import {
  auditBootstrapPair,
  CHARACTER_BOOTSTRAP_CONTRACTS,
  decodedKtx2Rgba,
} from "../tools/art_pipeline/build_character_bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORY = path.join(ROOT, "public/models/characters");
const VARIANTS = Object.freeze([
  "kid.glb",
  "kid-lod1.glb",
  "kid-bootstrap.glb",
]);
const CLIPS = Object.freeze([
  "Caught", "EscapeCelebrate", "HideEnter", "HideExit", "HideIdle",
  "HidePeek", "Idle", "Interact", "Run", "TurnLeft", "TurnRight", "Walk",
].sort());
const PARENTS = Object.freeze({
  Hips: "Rig_Humanoid_Shared",
  Spine: "Hips",
  Chest: "Spine",
  Neck: "Chest",
  Head: "Neck",
  LeftShoulder: "Chest",
  LeftUpperArm: "LeftShoulder",
  LeftLowerArm: "LeftUpperArm",
  LeftHand: "LeftLowerArm",
  RightShoulder: "Chest",
  RightUpperArm: "RightShoulder",
  RightLowerArm: "RightUpperArm",
  RightHand: "RightLowerArm",
  LeftUpperLeg: "Hips",
  LeftLowerLeg: "LeftUpperLeg",
  LeftFoot: "LeftLowerLeg",
  LeftToes: "LeftFoot",
  RightUpperLeg: "Hips",
  RightLowerLeg: "RightUpperLeg",
  RightFoot: "RightLowerLeg",
  RightToes: "RightFoot",
});
const JOINTS = Object.freeze(Object.keys(PARENTS).sort());
const WEIGHT_EPSILON = 1e-6;

function embeddedImagePayload(asset, image) {
  assert.notEqual(image.bufferView, undefined, `${asset.filename}/${image.name} has no payload`);
  const view = asset.json.bufferViews[image.bufferView];
  const start = view.byteOffset ?? 0;
  return asset.binary.subarray(start, start + view.byteLength);
}

function decodedRgbStatistics(data) {
  const sums = [0, 0, 0];
  const squares = [0, 0, 0];
  const pixels = data.length / 4;
  for (let offset = 0; offset < data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = data[offset + channel];
      sums[channel] += value;
      squares[channel] += value * value;
    }
  }
  const channelStddev = sums.map((sum, channel) => {
    const mean = sum / pixels;
    return Math.sqrt(Math.max(0, squares[channel] / pixels - mean * mean));
  });
  const mean = sums.reduce((total, value) => total + value, 0) / (pixels * 3);
  const sumSquares = squares.reduce((total, value) => total + value, 0);
  return {
    stddev: Math.sqrt(Math.max(0, sumSquares / (pixels * 3) - mean * mean)),
    channelStddev,
  };
}

function validateSkeleton(asset) {
  assert.equal(asset.json.skins?.length, 1, `${asset.filename} must have one skin`);
  const skin = asset.json.skins[0];
  const names = skin.joints.map((index) => asset.json.nodes[index].name);
  assert.deepEqual([...names].sort(), JOINTS, `${asset.filename} joint contract drifted`);
  for (const joint of JOINTS) {
    assert.equal(
      asset.json.nodes.filter((node) => node.name === joint).length,
      1,
      `${asset.filename} must contain ${joint} exactly once`,
    );
    const index = asset.json.nodes.findIndex((node) => node.name === joint);
    const expectedParent = PARENTS[joint];
    const actualParentIndex = asset.json.nodes.findIndex((node) => node.children?.includes(index));
    const actualParent = actualParentIndex >= 0 ? asset.json.nodes[actualParentIndex].name : null;
    assert.equal(actualParent, expectedParent, `${asset.filename}/${joint} parent drifted`);
  }
}

function validateWeights(asset) {
  const skin = asset.json.skins[0];
  const jointNames = skin.joints.map((index) => asset.json.nodes[index].name);
  const handSlots = new Map([
    ["LeftHand", jointNames.indexOf("LeftHand")],
    ["RightHand", jointNames.indexOf("RightHand")],
  ]);
  const hands = new Map([["LeftHand", 0], ["RightHand", 0]]);
  let vertices = 0;
  let zeroWeightVertices = 0;
  for (const mesh of asset.json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.attributes.JOINTS_0 === undefined) continue;
      const positionCount = asset.json.accessors[primitive.attributes.POSITION].count;
      const sets = [];
      for (let set = 0; primitive.attributes[`JOINTS_${set}`] !== undefined; set += 1) {
        const joints = accessorRows(asset, primitive.attributes[`JOINTS_${set}`]);
        const weights = accessorRows(asset, primitive.attributes[`WEIGHTS_${set}`]);
        assert.equal(joints.length, positionCount);
        assert.equal(weights.length, positionCount);
        sets.push({ joints, weights });
      }
      for (let vertex = 0; vertex < positionCount; vertex += 1) {
        vertices += 1;
        let weightSum = 0;
        const influenced = new Set();
        for (const set of sets) {
          for (let influence = 0; influence < set.weights[vertex].length; influence += 1) {
            const weight = set.weights[vertex][influence];
            const joint = set.joints[vertex][influence];
            assert.ok(Number.isFinite(weight) && weight >= 0);
            weightSum += weight;
            for (const [hand, slot] of handSlots) {
              if (joint === slot && weight > WEIGHT_EPSILON) influenced.add(hand);
            }
          }
        }
        if (weightSum <= WEIGHT_EPSILON) zeroWeightVertices += 1;
        for (const hand of influenced) hands.set(hand, hands.get(hand) + 1);
      }
    }
  }
  assert.ok(vertices > 0, `${asset.filename} has no skinned vertices`);
  assert.ok(zeroWeightVertices / vertices < 0.02, `${asset.filename} has too many zero-weight vertices`);
  assert.ok(hands.get("LeftHand") > 0, `${asset.filename} lost LeftHand weights`);
  assert.ok(hands.get("RightHand") > 0, `${asset.filename} lost RightHand weights`);
  return { vertices, zeroWeightVertices, hands: Object.fromEntries(hands) };
}

test("M1 Kid high/lod1/bootstrap preserve exact skeleton, weights, clips and compression", async () => {
  for (const basename of VARIANTS) {
    const filename = path.join(DIRECTORY, basename);
    const asset = await loadGlb(filename);
    validateSkeleton(asset);
    const weights = validateWeights(asset);
    assert.ok(weights.hands.LeftHand > 0 && weights.hands.RightHand > 0);
    assert.deepEqual(
      (asset.json.animations ?? []).map((animation) => animation.name).sort(),
      CLIPS,
      `${basename} clip contract drifted`,
    );
    assert.ok(asset.json.extensionsRequired?.includes("EXT_meshopt_compression"));
    assert.ok(asset.json.extensionsRequired?.includes("KHR_texture_basisu"));
    for (const image of asset.json.images ?? []) {
      assert.equal(image.mimeType, "image/ktx2", `${basename}/${image.name} is not KTX2`);
    }
  }
});

test("M1 Kid three-tier byte budgets and derivation contracts remain hard gates", async () => {
  const [high, lod1, bootstrap] = await Promise.all(
    VARIANTS.map((basename) => stat(path.join(DIRECTORY, basename))),
  );
  assert.ok(high.size <= 4_600_000, `Kid high is ${high.size} bytes`);
  assert.ok(lod1.size <= 3_050_000, `Kid lod1 is ${lod1.size} bytes`);
  assert.ok(
    bootstrap.size <= CHARACTER_BOOTSTRAP_CONTRACTS.kid.maxBytes,
    `Kid bootstrap is ${bootstrap.size} bytes`,
  );
  await auditLodPair(
    "kid",
    path.join(DIRECTORY, "kid.glb"),
    path.join(DIRECTORY, "kid-lod1.glb"),
  );
  await auditBootstrapPair(
    "kid",
    path.join(DIRECTORY, "kid-lod1.glb"),
    path.join(DIRECTORY, "kid-bootstrap.glb"),
  );
});

test("M1 Kid decoded runtime textures retain semantic and PBR variation", async () => {
  for (const basename of VARIANTS) {
    const asset = await loadGlb(path.join(DIRECTORY, basename));
    for (const image of asset.json.images ?? []) {
      const decoded = await decodedKtx2Rgba(
        embeddedImagePayload(asset, image),
        `${basename}/${image.name}`,
      );
      const statistics = decodedRgbStatistics(decoded.data);
      if (image.name.includes("BaseColor")) {
        assert.ok(statistics.stddev >= 8, `${basename}/${image.name} is visually flat`);
      } else if (image.name.includes("Normal")) {
        assert.ok(statistics.channelStddev[0] >= 4, `${basename}/${image.name} lacks normal R detail`);
        assert.ok(statistics.channelStddev[1] >= 4, `${basename}/${image.name} lacks normal G detail`);
      } else if (image.name.includes("ORM")) {
        assert.ok(statistics.channelStddev[0] >= 3, `${basename}/${image.name} lacks AO detail`);
      } else {
        assert.fail(`${basename} has an unknown Kid texture ${image.name}`);
      }
    }
  }
});

test("M1 Kid pipeline and source record pin the A2 semantic material lineage", async () => {
  const [animation, pbr, bootstrap, sourceRecord, notice] = await Promise.all([
    readFile(path.join(ROOT, "tools/art_pipeline/build_web_character_animation_sets.py"), "utf8"),
    readFile(path.join(ROOT, "tools/art_pipeline/apply_character_pbr.py"), "utf8"),
    readFile(path.join(ROOT, "tools/art_pipeline/build_character_bootstrap.mjs"), "utf8"),
    readFile(path.join(
      ROOT,
      "art-source/Characters/Kid/ReferenceStandard/PrecisionRemodel_2026_07_13_v21/SOURCE_AND_LICENSES.md",
    ), "utf8"),
    readFile(path.join(ROOT, "public/THIRD_PARTY_NOTICES.txt"), "utf8"),
  ]);
  assert.match(animation, /Kid_A2_VisualRework_v22_Rigged\.blend/);
  assert.match(pbr, /Char_Kid_A2_Semantic_BaseColor_2K\.png/);
  assert.match(bootstrap, /Char_Kid_A2_Semantic_BaseColor_2K\.png/);
  assert.match(sourceRecord, /Tencent Hunyuan3D-2/);
  assert.match(sourceRecord, /Quaternius Universal Animation\s+Library 2\.0 Standard/);
  assert.match(sourceRecord, /PUBLIC RELEASE REVIEW REQUIRED — CONCEPT 01 PROVENANCE UNCONFIRMED/);
  assert.match(notice, /generated Kid and Villain geometry/);
  assert.match(notice, /PUBLIC RELEASE BLOCKED PENDING PRODUCT LEGAL REVIEW/);
});

test("M1 Kid victory gesture honors the reduced-motion preference", async () => {
  const source = await readFile(path.join(ROOT, "app/chasing-game.tsx"), "utf8");
  assert.match(
    source,
    /if \(preferencesRef\.current\.reducedMotion\) \{\s*requestAnimation\(actors\.kid!, "idle", \{ fade: 0\.18 \}\);\s*\} else \{\s*requestAnimation\(actors\.kid!, "celebrate", \{ fade: 0\.18 \}\);\s*\}/u,
  );
});

test("M1 Kid QA clip fixture is not overwritten by locomotion", async () => {
  const source = await readFile(path.join(ROOT, "app/chasing-game.tsx"), "utf8");
  assert.match(
    source,
    /if \(\s*!qaKidAnimationScenario\s*&& \(state\.player\.mode === "free" \|\| state\.player\.mode === "aligning-hide"\)\s*\) \{/u,
  );
});
