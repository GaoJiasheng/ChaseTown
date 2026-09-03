import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = path.join(ROOT, "art-source", "_Source", "MakeHuman", "AuditedInputs");

const EXPECTED = new Map([
  ["base/skins/textures/young_lightskinned_male_diffuse2.png", [3595270, "03efe1f6b0ae52429649dcefc9dcaef6058032f874a251169cc3e2ed473c3874"]],
  ["base/hair/short01/short01_diffuse.png", [2354146, "f34a0957184e3d1e911ed59245f874f8d4843f61ee44ff49f43edb4be0196949"]],
  ["base/clothes/male_casualsuit03/male_casualsuit03_normal.png", [9610278, "412c4610d3b2ea1cb04aa3c0715e747a7c9f61d865133b7d69f70eaa738cf99b"]],
  ["base/eyebrows/eyebrow001/eyebrow001.png", [89619, "9940f7d0b1b223709a19b05156ba6f6e9e4dbdbced02d7574f4d51d72c58967b"]],
  ["base/eyelashes/eyelashes01/eyelashes01.png", [91600, "4b69c0fff2648874460e9caf80c31413c444218a5c50afebc425aeaa65484a35"]],
  ["base/eyes/high-poly/high-poly.obj", [100882, "da2493215b708a344c33dc72f2a9a5b8fa985dcc5a70ad3b208995cf871da8e1"]],
  ["base/eyes/materials/brown_eye.png", [610817, "4659691c7295ad6206c78b003e5fd0e5f91dcd53032fa914a229bb48cabe424b"]],
]);

test("Police MakeHuman audited inputs remain complete and byte-identical", async () => {
  const manifest = JSON.parse(await readFile(path.join(ARCHIVE, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.license, "CC0-1.0");
  assert.equal(manifest.inputs.length, EXPECTED.size, "the archive must contain exactly seven audited inputs");
  assert.equal(new Set(manifest.inputs.map(({ archivePath }) => archivePath)).size, EXPECTED.size);
  assert.equal(new Set(manifest.inputs.map(({ originalSubmodulePath }) => originalSubmodulePath)).size, EXPECTED.size);

  for (const input of manifest.inputs) {
    const expected = EXPECTED.get(input.archivePath);
    assert.ok(expected, `${input.archivePath} is not part of the frozen Police input set`);
    assert.equal(input.originalSubmodulePath, input.archivePath);
    assert.equal(input.bytes, expected[0], `${input.archivePath} manifest byte count drifted`);
    assert.equal(input.sha256, expected[1], `${input.archivePath} manifest SHA-256 drifted`);

    const filename = path.join(ARCHIVE, input.archivePath);
    const info = await stat(filename);
    const buffer = await readFile(filename);
    assert.equal(info.size, input.bytes, `${input.archivePath} archive byte count drifted`);
    assert.equal(
      createHash("sha256").update(buffer).digest("hex"),
      input.sha256,
      `${input.archivePath} archive SHA-256 drifted`,
    );
  }
});
