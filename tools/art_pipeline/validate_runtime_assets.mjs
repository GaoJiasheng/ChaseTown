#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBytes, version as validatorVersion } from "gltf-validator";
import { decodedKtx2Rgba } from "./build_character_bootstrap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MODELS_ROOT = path.join(ROOT, "public", "models");
const REPORT = path.join(ROOT, "art-source", "reports", "runtime-asset-gate.json");
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const THRESHOLDS = Object.freeze({
  baseColorRgbStddev: 8,
  normalRgbStddev: 4,
  ormAoRedStddev: 3,
});

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function relative(filename) {
  return path.relative(ROOT, filename).split(path.sep).join("/");
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(filename));
    else result.push(filename);
  }
  return result;
}

function parseGlb(payload, filename) {
  assert.equal(payload.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
  assert.equal(payload.readUInt32LE(8), payload.length, `${filename} declares the wrong byte length`);
  let json;
  let binary;
  for (let offset = 12; offset + 8 <= payload.length;) {
    const length = payload.readUInt32LE(offset);
    const type = payload.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      json = JSON.parse(payload.subarray(start, start + length).toString("utf8").replace(/[\0 ]+$/u, ""));
    } else if (type === 0x004e4942) {
      binary = payload.subarray(start, start + length);
    }
    offset = start + length;
  }
  assert.ok(json && binary, `${filename} is missing a JSON or BIN chunk`);
  return { json, binary };
}

function textureImageIndex(json, textureInfo) {
  if (!textureInfo) return undefined;
  const texture = json.textures?.[textureInfo.index];
  return texture?.extensions?.KHR_texture_basisu?.source ?? texture?.source;
}

function rolesByImage(json) {
  const roles = new Map();
  const mark = (textureInfo, role) => {
    const imageIndex = textureImageIndex(json, textureInfo);
    if (imageIndex === undefined) return;
    if (!roles.has(imageIndex)) roles.set(imageIndex, new Set());
    roles.get(imageIndex).add(role);
  };
  for (const material of json.materials ?? []) {
    mark(material.pbrMetallicRoughness?.baseColorTexture, "baseColor");
    mark(material.normalTexture, "normal");
    mark(material.pbrMetallicRoughness?.metallicRoughnessTexture, "metallicRoughness");
    mark(material.occlusionTexture, "ao");
    mark(material.emissiveTexture, "emissive");
    mark(material.extensions?.KHR_materials_clearcoat?.clearcoatTexture, "attrib");
    mark(material.extensions?.KHR_materials_clearcoat?.clearcoatRoughnessTexture, "attrib");
    mark(material.extensions?.KHR_materials_clearcoat?.clearcoatNormalTexture, "normal");
  }
  return roles;
}

function embeddedImagePayload(asset, image, filename) {
  assert.notEqual(image.bufferView, undefined, `${filename} embedded image has no bufferView`);
  const view = asset.json.bufferViews?.[image.bufferView];
  assert.ok(view, `${filename} embedded image references a missing bufferView`);
  const start = view.byteOffset ?? 0;
  const end = start + view.byteLength;
  assert.ok(end <= asset.binary.length, `${filename} embedded image exceeds the GLB BIN chunk`);
  return asset.binary.subarray(start, end);
}

function decodedStatistics(decoded) {
  const sums = [0, 0, 0];
  const sumSquares = [0, 0, 0];
  const pixels = decoded.width * decoded.height;
  for (let offset = 0; offset < decoded.data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = decoded.data[offset + channel];
      sums[channel] += value;
      sumSquares[channel] += value * value;
    }
  }
  const channelStddev = sums.map((sum, channel) => {
    const mean = sum / pixels;
    return Math.sqrt(Math.max(0, sumSquares[channel] / pixels - mean * mean));
  });
  const combinedSum = sums.reduce((sum, value) => sum + value, 0);
  const combinedSquares = sumSquares.reduce((sum, value) => sum + value, 0);
  const samples = pixels * 3;
  const combinedMean = combinedSum / samples;
  return {
    rgbStddev: Number(Math.sqrt(Math.max(0, combinedSquares / samples - combinedMean ** 2)).toFixed(4)),
    channelStddev: channelStddev.map((value) => Number(value.toFixed(4))),
  };
}

function qualityGate(roles, statistics) {
  const checks = [];
  if (roles.includes("baseColor")) {
    checks.push({ metric: "rgbStddev", minimum: THRESHOLDS.baseColorRgbStddev, value: statistics.rgbStddev });
  }
  if (roles.includes("normal")) {
    checks.push({ metric: "rgbStddev", minimum: THRESHOLDS.normalRgbStddev, value: statistics.rgbStddev });
  }
  if (roles.includes("ao")) {
    checks.push({ metric: "aoRedStddev", minimum: THRESHOLDS.ormAoRedStddev, value: statistics.channelStddev[0] });
  }
  if (checks.length === 0) {
    checks.push({ metric: "rgbStddev", minimum: 0.01, value: statistics.rgbStddev });
  }
  return checks.map((check) => ({ ...check, passed: check.value >= check.minimum }));
}

function warningCounts(messages) {
  const counts = {};
  for (const message of messages) counts[message.code] = (counts[message.code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function canonical(report) {
  const clone = structuredClone(report);
  delete clone.generatedAt;
  return clone;
}

async function audit() {
  const files = await walk(MODELS_ROOT);
  const glbFiles = files.filter((filename) => filename.endsWith(".glb")).sort();
  const standaloneKtx2 = files.filter((filename) => filename.endsWith(".ktx2")).sort();
  const textures = new Map();
  const validators = [];

  const recordTexture = (payload, reference, roles) => {
    assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE), `${reference} is not KTX2`);
    const hash = sha256(payload);
    const existing = textures.get(hash) ?? { payload, roles: new Set(), references: new Set() };
    roles.forEach((role) => existing.roles.add(role));
    existing.references.add(reference);
    textures.set(hash, existing);
  };

  for (const filename of standaloneKtx2) {
    recordTexture(await readFile(filename), relative(filename), []);
  }

  for (const filename of glbFiles) {
    const payload = await readFile(filename);
    const asset = parseGlb(payload, filename);
    const roles = rolesByImage(asset.json);
    for (const [index, image] of (asset.json.images ?? []).entries()) {
      const label = `${relative(filename)}#image-${index}:${image.name ?? "unnamed"}`;
      let imagePayload;
      if (image.uri) {
        const imageFilename = path.resolve(path.dirname(filename), decodeURIComponent(image.uri.split("?")[0]));
        if (!imageFilename.endsWith(".ktx2")) continue;
        imagePayload = await readFile(imageFilename);
      } else if (image.mimeType === "image/ktx2") {
        imagePayload = embeddedImagePayload(asset, image, filename);
      } else {
        continue;
      }
      recordTexture(imagePayload, label, [...(roles.get(index) ?? [])]);
    }

    const validation = await validateBytes(new Uint8Array(payload), {
      uri: relative(filename),
      externalResourceFunction: async (uri) => new Uint8Array(
        await readFile(path.resolve(path.dirname(filename), decodeURIComponent(uri))),
      ),
    });
    assert.equal(validation.issues.numErrors, 0, `${relative(filename)} has Validator errors`);
    validators.push({
      path: relative(filename),
      bytes: payload.length,
      sha256: sha256(payload),
      errors: validation.issues.numErrors,
      warnings: validation.issues.numWarnings,
      infos: validation.issues.numInfos,
      hints: validation.issues.numHints,
      messagesByCode: warningCounts(validation.issues.messages),
      triangles: validation.info.totalTriangleCount ?? 0,
      drawCalls: validation.info.drawCallCount ?? 0,
    });
  }

  const textureEntries = [];
  for (const [hash, texture] of [...textures.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const decoded = await decodedKtx2Rgba(texture.payload, `runtime texture ${hash}`);
    const statistics = decodedStatistics(decoded);
    const roles = [...texture.roles].sort();
    const gates = qualityGate(roles, statistics);
    textureEntries.push({
      sha256: hash,
      bytes: texture.payload.length,
      width: decoded.width,
      height: decoded.height,
      roles,
      decodedRgb: statistics,
      gates,
      references: [...texture.references].sort(),
    });
  }

  assert.equal(
    textureEntries.filter((entry) => entry.references.some((reference) => reference.endsWith(".ktx2"))).length,
    standaloneKtx2.length,
    "every standalone KTX2 must have a unique frozen payload entry",
  );
  const failedTextureEntries = textureEntries.filter(
    (entry) => entry.gates.some((gate) => !gate.passed),
  );
  assert.equal(
    failedTextureEntries.length,
    0,
    `runtime KTX2 stddev gates failed: ${JSON.stringify(failedTextureEntries.map((entry) => ({ sha256: entry.sha256, roles: entry.roles, decodedRgb: entry.decodedRgb, gates: entry.gates, references: entry.references })))}`,
  );
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    validator: `gltf-validator ${validatorVersion()}`,
    thresholds: THRESHOLDS,
    totals: {
      glbFiles: validators.length,
      validatorErrors: validators.reduce((sum, entry) => sum + entry.errors, 0),
      standaloneKtx2Files: standaloneKtx2.length,
      uniqueKtx2Payloads: textureEntries.length,
      decodedKtx2Failures: 0,
      stddevFailures: 0,
    },
    glbs: validators,
    ktx2: textureEntries,
  };
}

const check = process.argv.includes("--check");
const report = await audit();
if (check) {
  const expected = JSON.parse(await readFile(REPORT, "utf8"));
  assert.deepEqual(canonical(report), canonical(expected), "runtime asset gate report drifted; regenerate it intentionally");
  process.stdout.write(`Validated ${report.totals.glbFiles} GLBs and ${report.totals.uniqueKtx2Payloads} unique KTX2 payloads; Validator errors=0, stddev failures=0.\n`);
} else {
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Wrote ${relative(REPORT)} for ${report.totals.glbFiles} GLBs and ${report.totals.uniqueKtx2Payloads} unique KTX2 payloads.\n`);
}
