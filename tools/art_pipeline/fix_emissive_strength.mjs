#!/usr/bin/env node

/**
 * Converts legacy over-range emissiveFactor values to the glTF-compliant
 * KHR_materials_emissive_strength representation without changing appearance.
 * Usage: node tools/art_pipeline/fix_emissive_strength.mjs file.glb [...]
 */
import { readFile, writeFile } from "node:fs/promises";

const JSON_CHUNK = 0x4e4f534a;

function pad4(buffer, value) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, value)]) : buffer;
}

function parseGlb(buffer, filename) {
  if (buffer.subarray(0, 4).toString("ascii") !== "glTF" || buffer.readUInt32LE(4) !== 2) {
    throw new Error(`${filename}: expected a glTF 2.0 GLB`);
  }
  const chunks = [];
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error(`${filename}: truncated chunk`);
    chunks.push({ type, data });
    offset += 8 + length;
  }
  const jsonChunk = chunks.find((chunk) => chunk.type === JSON_CHUNK);
  if (!jsonChunk) throw new Error(`${filename}: missing JSON chunk`);
  const json = JSON.parse(jsonChunk.data.toString("utf8").replace(/[\u0000 ]+$/u, ""));
  return { json, chunks };
}

function encodeGlb(json, chunks) {
  const jsonData = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const encodedChunks = chunks.map((chunk) => {
    const data = chunk.type === JSON_CHUNK ? jsonData : chunk.data;
    const header = Buffer.alloc(8);
    header.writeUInt32LE(data.length, 0);
    header.writeUInt32LE(chunk.type, 4);
    return Buffer.concat([header, data]);
  });
  const length = 12 + encodedChunks.reduce((total, chunk) => total + chunk.length, 0);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(length, 8);
  return Buffer.concat([header, ...encodedChunks]);
}

async function repair(filename) {
  const source = await readFile(filename);
  const { json, chunks } = parseGlb(source, filename);
  let repaired = 0;
  for (const material of json.materials ?? []) {
    const factor = material.emissiveFactor;
    if (!Array.isArray(factor) || factor.length !== 3 || factor.every((value) => value <= 1)) continue;
    const strength = Math.max(...factor);
    material.emissiveFactor = factor.map((value) => value / strength);
    material.extensions ??= {};
    material.extensions.KHR_materials_emissive_strength = { emissiveStrength: strength };
    repaired += 1;
  }
  if (!repaired) {
    console.log(`${filename}: no over-range emissive factors`);
    return;
  }
  json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "KHR_materials_emissive_strength"])];
  const output = encodeGlb(json, chunks);
  await writeFile(filename, output);
  console.log(`${filename}: repaired ${repaired} material(s), ${source.length} -> ${output.length} bytes`);
}

if (!process.argv.slice(2).length) throw new Error("Provide at least one GLB path");
for (const filename of process.argv.slice(2)) await repair(filename);
