import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditLodPair,
  CHARACTER_LOD_CONTRACTS,
  FORMAT_VERSION,
  GLTFPACK_ARGUMENTS,
} from "../tools/art_pipeline/build_character_lod1.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTER_DIRECTORY = path.join(ROOT, "public", "models", "characters");
const REPORT = path.join(ROOT, "art-source", "reports", "character-lod1.json");

test("first-frame character LODs preserve the approved art and animation contracts", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.formatVersion, FORMAT_VERSION);
  assert.deepEqual(report.tool, {
    name: "gltfpack",
    version: "gltfpack 1.2",
    arguments: GLTFPACK_ARGUMENTS,
  });
  assert.deepEqual(report.policy, {
    derivativeOnly: true,
    sourceAssetsUnmodified: true,
    intendedUse: "First-frame and constrained-device render; retain the high model for later promotion.",
    targetTriangleRatio: 0.65,
    maximumSimplificationError: 0.002,
    geometryQuantization: true,
    animationResampling: false,
    textures: "Byte-identical embedded KTX2 surfaces retained from the approved high model.",
  });
  assert.deepEqual(
    report.characters.map(({ role }) => role),
    Object.keys(CHARACTER_LOD_CONTRACTS),
  );

  const audited = [];
  for (const [role, contract] of Object.entries(CHARACTER_LOD_CONTRACTS)) {
    const entry = await auditLodPair(
      role,
      path.join(CHARACTER_DIRECTORY, `${role}.glb`),
      path.join(CHARACTER_DIRECTORY, `${role}-lod1.glb`),
    );
    audited.push(entry);
    assert.deepEqual(
      entry,
      report.characters.find((character) => character.role === role),
      `${role} LOD or its source high model drifted from the audited report`,
    );
    assert.ok(entry.lod.bytes <= contract.maxBytes);
    assert.ok(entry.lod.savedPercent >= 30);
    assert.equal(entry.quality.joints, 21);
    assert.deepEqual(entry.quality.clips, [...contract.clips].sort());
    assert.ok(entry.quality.textures.every((texture) => texture.width >= 768));
    assert.ok(entry.quality.textures.every((texture) => texture.levels >= 10));
    assert.ok(entry.quality.animationDeviation.maxRotationDegrees <= 0.01);
    for (const clip of Object.values(entry.quality.animations)) {
      assert.ok(clip.animatedJointChannels >= 20);
      assert.ok(clip.rotationTravelDegrees > 1);
    }
  }

  const sourceBytes = audited.reduce((total, entry) => total + entry.source.bytes, 0);
  const lodBytes = audited.reduce((total, entry) => total + entry.lod.bytes, 0);
  assert.deepEqual(report.totals, {
    sourceBytes,
    lodBytes,
    savedBytes: sourceBytes - lodBytes,
    savedPercent: Number(((1 - lodBytes / sourceBytes) * 100).toFixed(3)),
  });
  assert.ok(lodBytes <= 5_750_000, "the two visible first-frame actors exceed 5.75 MB");
  assert.ok(report.totals.savedPercent >= 35, "combined first-frame actor savings fell below 35%");
});
