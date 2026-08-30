#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = path.join(
  ROOT,
  "art-source",
  "Environment",
  "SharedTextures",
  "Env_PaintedWall_BaseColor_2K.png",
);
const SOURCE_SHA256 = "d170145aeceef25f0d495e5c9b7a014409ec1b59611e152f4e064fb076d4f055";
const OUTPUT_SHA256 = "ad0af798f874ba39a46148d23cf107980311c35f5921d6ff7e24b32d5bbcd18b";
const CONTRAST = 1.62;

const sha256 = (payload) => createHash("sha256").update(payload).digest("hex");

function statistics(data) {
  let sum = 0;
  let squares = 0;
  for (const value of data) {
    sum += value;
    squares += value * value;
  }
  const mean = sum / data.length;
  return {
    mean,
    stddev: Math.sqrt(Math.max(0, squares / data.length - mean * mean)),
  };
}

const source = await readFile(TARGET);
const currentSha256 = sha256(source);
if (currentSha256 === OUTPUT_SHA256) {
  process.stdout.write(`Environment gate source already frozen: ${OUTPUT_SHA256}\n`);
  process.exit(0);
}
assert.equal(currentSha256, SOURCE_SHA256, "PaintedWall authoring source drifted before gate retune");
const decoded = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const output = Buffer.from(decoded.data);
const means = [0, 0, 0];
const pixels = decoded.info.width * decoded.info.height;
for (let offset = 0; offset < output.length; offset += 3) {
  for (let channel = 0; channel < 3; channel += 1) means[channel] += output[offset + channel];
}
means.forEach((_, channel) => { means[channel] /= pixels; });
for (let offset = 0; offset < output.length; offset += 3) {
  for (let channel = 0; channel < 3; channel += 1) {
    output[offset + channel] = Math.max(
      0,
      Math.min(255, Math.round(means[channel] + (output[offset + channel] - means[channel]) * CONTRAST)),
    );
  }
}
const encoded = await sharp(output, {
  raw: { width: decoded.info.width, height: decoded.info.height, channels: 3 },
}).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
const outputSha256 = sha256(encoded);
const before = statistics(decoded.data);
const after = statistics(output);
assert.ok(after.stddev >= 8, `PaintedWall retune did not reach BaseColor stddev 8: ${after.stddev}`);
await writeFile(TARGET, encoded);
process.stdout.write(`${JSON.stringify({
  target: path.relative(ROOT, TARGET),
  contrast: CONTRAST,
  sourceSha256: currentSha256,
  outputSha256,
  beforeStddev: Number(before.stddev.toFixed(4)),
  afterStddev: Number(after.stddev.toFixed(4)),
}, null, 2)}\n`);
