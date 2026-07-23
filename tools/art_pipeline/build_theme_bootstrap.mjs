#!/usr/bin/env node

/**
 * Produces quantized first-paint derivatives of the four authored theme kits.
 *
 * The approved theme GLBs remain untouched. Named runtime nodes, triangle
 * topology, material identities and PBR slot semantics are retained. Texture
 * requests collapse to three content-addressed atlases:
 *   - the existing 512px/tile ETC1S BaseColor bootstrap atlas (reused exactly)
 *   - a 256px/tile UASTC Normal derivative using the same normalized layout
 *   - a 256px/tile ETC1S ORM derivative using the same normalized layout
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as THREE from "three";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FORMAT_VERSION = 1;
export const DEFAULT_PUBLIC_ROOT = path.join(ROOT, "public");
export const DEFAULT_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "theme-bootstrap.json",
);
export const COLD_START_MAX_BYTES = Math.floor(2.2 * 1024 * 1024);

export const THEME_BOOTSTRAP_CONTRACTS = Object.freeze({
  campus: Object.freeze({ basename: "campus-kit.glb" }),
  hospital: Object.freeze({ basename: "hospital-kit.glb" }),
  "fire-station": Object.freeze({ basename: "fire-station-kit.glb" }),
  factory: Object.freeze({ basename: "factory-kit.glb" }),
});

export const GEOMETRY_ARGUMENTS = Object.freeze([
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-si",
  "1",
  "-se",
  "0.001",
  "-tr",
  "-af",
  "0",
  "-at",
  "24",
  "-ar",
  "16",
  "-as",
  "24",
]);

export const ATLAS_ARGUMENTS = Object.freeze([
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-noq",
  "-tu",
  "normal",
  "-tc",
  "attrib",
  "-tq",
  "normal,attrib",
  "10",
  "-tj",
  "4",
]);

const EXISTING_BOOTSTRAP_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "environment-bootstrap-ktx2.json",
);
const SHARED_DIRECTORY = "SharedTexturesBootstrapKTX2";
const SOURCE_TEXTURE_DIRECTORY = path.join("models", "SharedTextures");
const ORM_DIRECTORY = path.join(ROOT, "work", "art_pipeline", "environment-orm");
const CONTRACT_KEY = "chasing_theme_bootstrap";
const ATLAS_COLUMNS = 4;
const ATLAS_ROWS = 3;
const SOURCE_SIZE = 512;
const DETAIL_SIZE = 256;
const DETAIL_GUTTER = 4;
const DETAIL_STRIDE = DETAIL_SIZE + DETAIL_GUTTER * 2;
const DETAIL_ATLAS_WIDTH = DETAIL_STRIDE * ATLAS_COLUMNS;
const DETAIL_ATLAS_HEIGHT = DETAIL_STRIDE * ATLAS_ROWS;
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export const TEXTURE_FAMILIES = Object.freeze([
  "Blackboard",
  "BluePaintedMetal",
  "GlassBlue",
  "Grass",
  "HallwayTile",
  "PaintedWall",
  "Paper",
  "RedPaintedMetal",
  "RubberBlack",
  "WoodTrim",
  "WornMetal",
]);

const THEME_TEXTURE_FAMILIES = new Set([
  "BluePaintedMetal",
  "Grass",
  "PaintedWall",
  "Paper",
  "RedPaintedMetal",
  "RubberBlack",
  "WoodTrim",
  "WornMetal",
]);

function parseArguments(argv) {
  const options = {
    check: false,
    publicRoot: DEFAULT_PUBLIC_ROOT,
    report: DEFAULT_REPORT,
    gltfpack: process.env.GLTFPACK_NATIVE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} needs a value`);
    if (argument === "--public-root") options.publicRoot = path.resolve(value);
    else if (argument === "--report") options.report = path.resolve(value);
    else if (argument === "--gltfpack") options.gltfpack = path.resolve(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return options;
}

function sha256(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function relativePath(filename) {
  return path.relative(ROOT, filename).split(path.sep).join("/");
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function extensionList(values, remove, add) {
  const result = (values ?? []).filter((value) => !remove.has(value));
  for (const value of add) if (!result.includes(value)) result.push(value);
  return result.length ? result : undefined;
}

function readGlb(buffer, filename) {
  assert.ok(buffer.length >= 20, `${filename} is too small to be a GLB`);
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
  assert.equal(buffer.readUInt32LE(4), 2, `${filename} must use glTF 2.0`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} declares the wrong size`);
  let json;
  let binary;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    assert.ok(end <= buffer.length, `${filename} has a truncated chunk`);
    if (type === 0x4e4f534a) {
      json = JSON.parse(
        buffer.subarray(start, end).toString("utf8").replace(/[\0 ]+$/u, "").trim(),
      );
    } else if (type === 0x004e4942) {
      binary = buffer.subarray(start, end);
    }
    offset = end;
  }
  assert.ok(json && binary, `${filename} must contain JSON and BIN chunks`);
  const embeddedBufferIndex = json.buffers?.findIndex(
    (candidate) => candidate.uri === undefined
      && !candidate.extensions?.EXT_meshopt_compression?.fallback,
  );
  assert.ok(embeddedBufferIndex >= 0, `${filename} has no physical embedded buffer`);
  const length = json.buffers[embeddedBufferIndex].byteLength;
  assert.ok(length <= binary.length, `${filename} declares an oversized BIN`);
  return {
    filename,
    buffer,
    json,
    binary: binary.subarray(0, length),
    embeddedBufferIndex,
  };
}

async function loadGlb(filename) {
  return readGlb(await readFile(filename), filename);
}

function encodeGlb(json, binary, embeddedBufferIndex) {
  json.buffers[embeddedBufferIndex].byteLength = binary.length;
  const jsonPayload = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadding = (4 - (jsonPayload.length % 4)) % 4;
  const paddedJson = jsonPadding
    ? Buffer.concat([jsonPayload, Buffer.alloc(jsonPadding, 0x20)])
    : jsonPayload;
  const binaryPadding = (4 - (binary.length % 4)) % 4;
  const paddedBinary = binaryPadding
    ? Buffer.concat([binary, Buffer.alloc(binaryPadding)])
    : binary;
  const totalLength = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(paddedJson.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(paddedBinary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, paddedBinary]);
}

function textureSource(texture) {
  return texture.source
    ?? texture.extensions?.KHR_texture_basisu?.source
    ?? texture.extensions?.EXT_texture_webp?.source;
}

function textureInfoImage(json, textureInfo, label) {
  assert.ok(textureInfo && Number.isInteger(textureInfo.index), `${label} has no texture index`);
  const texture = json.textures?.[textureInfo.index];
  assert.ok(texture, `${label} references missing texture`);
  const source = textureSource(texture);
  assert.ok(Number.isInteger(source), `${label} has no image source`);
  const image = json.images?.[source];
  assert.ok(image?.name, `${label} image has no stable name`);
  return image;
}

function familyFromImageName(name, expectedClass) {
  const match = /^Env_([A-Za-z]+)_(Normal|ORM|BaseColor)_(?:2K|512)$/u.exec(name);
  assert.ok(match, `Unexpected theme image name ${name}`);
  assert.equal(match[2], expectedClass, `${name} is not a ${expectedClass} surface`);
  assert.ok(TEXTURE_FAMILIES.includes(match[1]), `${name} family is not atlas-assigned`);
  return match[1];
}

function sourceSlotContract(json) {
  const slots = [];
  const add = (materialIndex, slot, textureInfo, expectedClass) => {
    if (!textureInfo) return;
    const image = textureInfoImage(
      json,
      textureInfo,
      `material ${materialIndex}/${slot}`,
    );
    slots.push({
      materialIndex,
      materialName: json.materials[materialIndex].name,
      slot,
      family: familyFromImageName(image.name, expectedClass),
      sourceImage: image.name,
      sourceUri: image.uri,
      textureInfo: structuredClone(textureInfo),
    });
  };
  for (const [materialIndex, material] of (json.materials ?? []).entries()) {
    add(
      materialIndex,
      "baseColor",
      material.pbrMetallicRoughness?.baseColorTexture,
      "BaseColor",
    );
    add(materialIndex, "normal", material.normalTexture, "Normal");
    add(
      materialIndex,
      "metallicRoughness",
      material.pbrMetallicRoughness?.metallicRoughnessTexture,
      "ORM",
    );
    add(materialIndex, "occlusion", material.occlusionTexture, "ORM");
  }
  assert.ok(slots.length > 0, "Theme kit has no PBR texture slots");
  assert.ok(slots.every(({ family }) => THEME_TEXTURE_FAMILIES.has(family)));
  return slots;
}

function atlasTransform(family) {
  const index = TEXTURE_FAMILIES.indexOf(family);
  assert.notEqual(index, -1);
  const column = index % ATLAS_COLUMNS;
  const row = Math.floor(index / ATLAS_COLUMNS);
  return {
    offset: [
      (column * DETAIL_STRIDE + DETAIL_GUTTER) / DETAIL_ATLAS_WIDTH,
      (row * DETAIL_STRIDE + DETAIL_GUTTER) / DETAIL_ATLAS_HEIGHT,
    ],
    scale: [
      DETAIL_SIZE / DETAIL_ATLAS_WIDTH,
      DETAIL_SIZE / DETAIL_ATLAS_HEIGHT,
    ],
  };
}

function composeTextureTransform(original, atlas) {
  assert.equal(original?.rotation ?? 0, 0, "Rotated theme texture transforms need review");
  const offset = original?.offset ?? [0, 0];
  const scale = original?.scale ?? [1, 1];
  return {
    offset: [
      atlas.offset[0] + offset[0] * atlas.scale[0],
      atlas.offset[1] + offset[1] * atlas.scale[1],
    ],
    scale: [
      scale[0] * atlas.scale[0],
      scale[1] * atlas.scale[1],
    ],
  };
}

function atlasTextureInfo(slot, textureIndex) {
  const result = structuredClone(slot.textureInfo);
  result.index = textureIndex;
  result.extensions ??= {};
  result.extensions.KHR_texture_transform = composeTextureTransform(
    result.extensions.KHR_texture_transform,
    atlasTransform(slot.family),
  );
  return result;
}

function rewriteThemeWithAtlases(asset, atlasUris, sourceHash) {
  const json = structuredClone(asset.json);
  const slots = sourceSlotContract(json);
  for (const slot of slots) {
    const material = json.materials[slot.materialIndex];
    if (slot.slot === "baseColor") {
      material.pbrMetallicRoughness.baseColorTexture = atlasTextureInfo(slot, 0);
    } else if (slot.slot === "normal") {
      material.normalTexture = atlasTextureInfo(slot, 1);
    } else if (slot.slot === "metallicRoughness") {
      material.pbrMetallicRoughness.metallicRoughnessTexture = atlasTextureInfo(slot, 2);
    } else {
      material.occlusionTexture = atlasTextureInfo(slot, 2);
    }
  }
  json.asset.extras ??= {};
  json.asset.extras[CONTRACT_KEY] = {
    version: FORMAT_VERSION,
    sourceGlbSha256: sourceHash,
    sourceSlots: slots.map((slot) => ({
      materialIndex: slot.materialIndex,
      materialName: slot.materialName,
      slot: slot.slot,
      family: slot.family,
      sourceImage: slot.sourceImage,
      sourceUri: slot.sourceUri,
    })),
  };
  json.images = [
    {
      name: "ThemeBootstrapBaseColorAtlas",
      uri: atlasUris.baseColor,
      extras: { chasing_atlas_class: "baseColor", chasing_reused_existing_atlas: true },
    },
    {
      name: "ThemeBootstrapNormalAtlas",
      uri: atlasUris.normal,
      extras: { chasing_atlas_class: "normal", chasing_tile_resolution: DETAIL_SIZE },
    },
    {
      name: "ThemeBootstrapOrmAtlas",
      uri: atlasUris.orm,
      extras: { chasing_atlas_class: "orm", chasing_tile_resolution: DETAIL_SIZE },
    },
  ];
  json.samplers = [{
    magFilter: 9729,
    minFilter: 9987,
    wrapS: 10497,
    wrapT: 10497,
  }];
  json.textures = [
    {
      name: "ThemeBootstrapBaseColorAtlas",
      sampler: 0,
      extensions: { KHR_texture_basisu: { source: 0 } },
    },
    {
      name: "ThemeBootstrapNormalAtlas",
      sampler: 0,
      extensions: { KHR_texture_basisu: { source: 1 } },
    },
    {
      name: "ThemeBootstrapOrmAtlas",
      sampler: 0,
      extensions: { KHR_texture_basisu: { source: 2 } },
    },
  ];
  json.extensionsUsed = extensionList(
    json.extensionsUsed,
    new Set(["EXT_texture_webp"]),
    ["KHR_texture_basisu", "KHR_texture_transform"],
  );
  json.extensionsRequired = extensionList(
    json.extensionsRequired,
    new Set(["EXT_texture_webp"]),
    ["KHR_texture_basisu", "KHR_texture_transform"],
  );
  return {
    buffer: encodeGlb(json, asset.binary, asset.embeddedBufferIndex),
    slots,
  };
}

function ktx2Metadata(payload, label) {
  assert.ok(payload.length >= 80, `${label} is too small to be KTX2`);
  assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE), `${label} is not KTX2`);
  assert.equal(payload.readUInt32LE(12), 0, `${label} must use Basis Universal`);
  const scheme = payload.readUInt32LE(44);
  const mode = scheme === 1 ? "ETC1S" : scheme === 2 ? "UASTC" : `unknown-${scheme}`;
  assert.ok(mode === "ETC1S" || mode === "UASTC", `${label} uses ${mode}`);
  return {
    bytes: payload.length,
    sha256: sha256(payload),
    width: payload.readUInt32LE(20),
    height: payload.readUInt32LE(24),
    levels: payload.readUInt32LE(40),
    supercompressionScheme: scheme,
    mode,
  };
}

function imagePayload(asset, image) {
  assert.notEqual(image.bufferView, undefined, `${asset.filename} image has no payload`);
  const view = asset.json.bufferViews[image.bufferView];
  assert.equal(view.buffer, asset.embeddedBufferIndex);
  const start = view.byteOffset ?? 0;
  return asset.binary.subarray(start, start + view.byteLength);
}

async function existingBaseColorAtlas(publicRoot) {
  const report = JSON.parse(await readFile(EXISTING_BOOTSTRAP_REPORT, "utf8"));
  const entry = report.atlases.find(({ textureClass }) => textureClass === "baseColor");
  assert.ok(entry, "Existing environment bootstrap report has no BaseColor atlas");
  const filename = path.join(ROOT, entry.path);
  const payload = await readFile(filename);
  assert.equal(sha256(payload), entry.sha256, "Existing BaseColor atlas drifted");
  const metadata = ktx2Metadata(payload, filename);
  assert.equal(metadata.mode, "ETC1S");
  assert.equal(metadata.width, 2112);
  assert.equal(metadata.height, 1584);
  assert.ok(filename.startsWith(publicRoot), "Existing atlas is outside the selected public root");
  return {
    textureClass: "baseColor",
    reusedExisting: true,
    path: filename,
    ...metadata,
  };
}

async function sourceTextureEntries(publicRoot) {
  const entries = [];
  for (const family of TEXTURE_FAMILIES) {
    const normalFilename = path.join(
      publicRoot,
      SOURCE_TEXTURE_DIRECTORY,
      `Env_${family}_Normal_2K.png`,
    );
    const normalPayload = await readFile(normalFilename);
    const normalMetadata = await sharp(normalPayload).metadata();
    assert.equal(normalMetadata.width, SOURCE_SIZE);
    assert.equal(normalMetadata.height, SOURCE_SIZE);
    entries.push({
      family,
      textureClass: "normal",
      filename: normalFilename,
      path: relativePath(normalFilename),
      bytes: normalPayload.length,
      sha256: sha256(normalPayload),
      width: SOURCE_SIZE,
      height: SOURCE_SIZE,
    });
    if (THEME_TEXTURE_FAMILIES.has(family)) {
      const ormFilename = path.join(ORM_DIRECTORY, `Env_${family}_ORM_512.png`);
      const ormPayload = await readFile(ormFilename);
      const ormMetadata = await sharp(ormPayload).metadata();
      assert.equal(ormMetadata.width, SOURCE_SIZE);
      assert.equal(ormMetadata.height, SOURCE_SIZE);
      entries.push({
        family,
        textureClass: "orm",
        filename: ormFilename,
        path: relativePath(ormFilename),
        bytes: ormPayload.length,
        sha256: sha256(ormPayload),
        width: SOURCE_SIZE,
        height: SOURCE_SIZE,
      });
    }
  }
  return entries;
}

async function buildDetailAtlasPng(entries, textureClass, output) {
  const background = textureClass === "normal"
    ? { r: 128, g: 128, b: 255, alpha: 1 }
    : { r: 255, g: 210, b: 0, alpha: 1 };
  const composites = [];
  for (const entry of entries.filter((candidate) => candidate.textureClass === textureClass)) {
    const index = TEXTURE_FAMILIES.indexOf(entry.family);
    const tile = await sharp(entry.filename)
      .resize(DETAIL_SIZE, DETAIL_SIZE, {
        fit: "fill",
        kernel: sharp.kernel.lanczos3,
      })
      .extend({
        top: DETAIL_GUTTER,
        bottom: DETAIL_GUTTER,
        left: DETAIL_GUTTER,
        right: DETAIL_GUTTER,
        extendWith: "copy",
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    composites.push({
      input: tile,
      left: (index % ATLAS_COLUMNS) * DETAIL_STRIDE,
      top: Math.floor(index / ATLAS_COLUMNS) * DETAIL_STRIDE,
    });
  }
  await sharp({
    create: {
      width: DETAIL_ATLAS_WIDTH,
      height: DETAIL_ATLAS_HEIGHT,
      channels: 3,
      background,
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(output);
}

function syntheticAtlasGltf(normalBasename, ormBasename) {
  const binary = Buffer.alloc(104);
  [
    -1, -1, 0, 1, -1, 0, 0, 1, 0,
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 0.5, 1,
  ].forEach((value, index) => binary.writeFloatLE(value, index * 4));
  [0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 96 + index * 2));
  return {
    binary,
    json: {
      asset: { version: "2.0", generator: "Chasing theme bootstrap atlas encoder" },
      buffers: [{ uri: "atlas.bin", byteLength: 102 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
        { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 },
        { buffer: 0, byteOffset: 72, byteLength: 24, target: 34962 },
        { buffer: 0, byteOffset: 96, byteLength: 6, target: 34963 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [-1, -1, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
        { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
      ],
      images: [
        { name: "ThemeBootstrapNormalAtlas", uri: normalBasename },
        { name: "ThemeBootstrapOrmAtlas", uri: ormBasename },
      ],
      samplers: [{}],
      textures: [{ sampler: 0, source: 0 }, { sampler: 0, source: 1 }],
      materials: [{
        name: "M_ThemeAtlasEncoder",
        pbrMetallicRoughness: { metallicRoughnessTexture: { index: 1 } },
        normalTexture: { index: 0 },
        occlusionTexture: { index: 1 },
      }],
      meshes: [{
        primitives: [{
          attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
          indices: 3,
          material: 0,
        }],
      }],
      nodes: [{ name: "ThemeAtlasEncoder", mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
  };
}

async function encodeDetailAtlases(gltfpack, temporaryRoot, publicRoot) {
  const sources = await sourceTextureEntries(publicRoot);
  const normalPng = path.join(temporaryRoot, "theme-normal-atlas.png");
  const ormPng = path.join(temporaryRoot, "theme-orm-atlas.png");
  await Promise.all([
    buildDetailAtlasPng(sources, "normal", normalPng),
    buildDetailAtlasPng(sources, "orm", ormPng),
  ]);
  const synthetic = syntheticAtlasGltf(path.basename(normalPng), path.basename(ormPng));
  await writeFile(path.join(temporaryRoot, "atlas.bin"), synthetic.binary);
  const input = path.join(temporaryRoot, "atlas.gltf");
  const output = path.join(temporaryRoot, "atlas.glb");
  await writeFile(input, `${JSON.stringify(synthetic.json)}\n`);
  const result = spawnSync(
    gltfpack,
    ["-i", input, "-o", output, ...ATLAS_ARGUMENTS],
    { cwd: temporaryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Theme atlas encoding failed");
  }
  const encoded = await loadGlb(output);
  const atlases = {};
  for (const image of encoded.json.images ?? []) {
    const payload = Buffer.from(imagePayload(encoded, image));
    if (image.name === "ThemeBootstrapNormalAtlas") {
      atlases.normal = {
        textureClass: "normal",
        reusedExisting: false,
        payload,
        ...ktx2Metadata(payload, image.name),
      };
    } else if (image.name === "ThemeBootstrapOrmAtlas") {
      atlases.orm = {
        textureClass: "orm",
        reusedExisting: false,
        payload,
        ...ktx2Metadata(payload, image.name),
      };
    }
  }
  assert.equal(atlases.normal?.mode, "UASTC");
  assert.equal(atlases.orm?.mode, "ETC1S");
  for (const atlas of [atlases.normal, atlases.orm]) {
    assert.equal(atlas.width, DETAIL_ATLAS_WIDTH);
    assert.equal(atlas.height, DETAIL_ATLAS_HEIGHT);
    assert.ok(atlas.levels >= 10);
  }
  return { atlases, sources };
}

async function resolveGltfpack(explicit) {
  const candidates = [
    explicit,
    "/private/tmp/gltfpack-macos-v1.2/gltfpack",
    "/opt/homebrew/bin/gltfpack",
    path.join(ROOT, "node_modules", ".bin", "gltfpack"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const result = spawnSync(candidate, ["-v"], { encoding: "utf8" });
      if (result.status === 0) {
        return { executable: candidate, version: result.stdout.trim() };
      }
    } catch {
      // Continue through pinned/local candidates.
    }
  }
  throw new Error("Native gltfpack 1.2 is required; pass --gltfpack or GLTFPACK_NATIVE.");
}

function quantizeTheme(gltfpack, input, output) {
  const result = spawnSync(
    gltfpack,
    ["-i", input, "-o", output, ...GEOMETRY_ARGUMENTS],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `gltfpack failed for ${input}`);
  }
}

function triangleCount(asset) {
  return (asset.json.meshes ?? []).reduce((total, mesh) => (
    total + mesh.primitives.reduce((subtotal, primitive) => {
      const accessor = asset.json.accessors[
        primitive.indices ?? primitive.attributes.POSITION
      ];
      return subtotal + accessor.count / 3;
    }, 0)
  ), 0);
}

function primitiveCount(asset) {
  return (asset.json.meshes ?? []).reduce(
    (total, mesh) => total + mesh.primitives.length,
    0,
  );
}

function localNodeMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(node.translation ?? [0, 0, 0])),
    new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
  );
}

function sceneBounds(asset) {
  const bounds = new THREE.Box3();
  const visit = (nodeIndex, parent) => {
    const node = asset.json.nodes[nodeIndex];
    const world = parent.clone().multiply(localNodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of asset.json.meshes[node.mesh].primitives) {
        const accessor = asset.json.accessors[primitive.attributes.POSITION];
        assert.ok(accessor.min && accessor.max, `${asset.filename} POSITION needs bounds`);
        bounds.union(
          new THREE.Box3(
            new THREE.Vector3(...accessor.min),
            new THREE.Vector3(...accessor.max),
          ).applyMatrix4(world),
        );
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const node of asset.json.scenes[asset.json.scene ?? 0].nodes ?? []) {
    visit(node, new THREE.Matrix4());
  }
  assert.equal(bounds.isEmpty(), false);
  return bounds;
}

function maximumBoundsDelta(left, right) {
  return Math.max(
    ...left.min.toArray().map((value, index) => Math.abs(value - right.min.toArray()[index])),
    ...left.max.toArray().map((value, index) => Math.abs(value - right.max.toArray()[index])),
  );
}

function materialSemantics(json) {
  return sortedUnique(
    (json.materials ?? []).map((material) => {
      const clone = structuredClone(material);
      delete clone.normalTexture;
      delete clone.occlusionTexture;
      delete clone.emissiveTexture;
      if (clone.pbrMetallicRoughness) {
        delete clone.pbrMetallicRoughness.baseColorTexture;
        delete clone.pbrMetallicRoughness.metallicRoughnessTexture;
      }
      return JSON.stringify(clone);
    }),
  );
}

function sourceSlotSummary(json) {
  return sourceSlotContract(json)
    .map(({ materialName, slot, family }) => ({ materialName, slot, family }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function dependencyEntries(asset, bootstrapFilename) {
  const unique = new Map();
  for (const image of asset.json.images ?? []) {
    assert.ok(image.uri, `${bootstrapFilename} atlas image must remain external`);
    const filename = path.resolve(path.dirname(bootstrapFilename), decodeURIComponent(image.uri));
    const payload = await readFile(filename);
    unique.set(filename, {
      textureClass: image.extras?.chasing_atlas_class,
      path: relativePath(filename),
      bytes: payload.length,
      sha256: sha256(payload),
      ...ktx2Metadata(payload, filename),
    });
  }
  return [...unique.values()];
}

export async function auditThemeBootstrap(
  theme,
  sourceFilename,
  bootstrapFilename,
) {
  const contract = THEME_BOOTSTRAP_CONTRACTS[theme];
  assert.ok(contract, `No theme bootstrap contract exists for ${theme}`);
  const [source, bootstrap] = await Promise.all([
    loadGlb(sourceFilename),
    loadGlb(bootstrapFilename),
  ]);
  assert.ok(bootstrap.json.extensionsRequired?.includes("EXT_meshopt_compression"));
  assert.ok(bootstrap.json.extensionsRequired?.includes("KHR_mesh_quantization"));
  assert.ok(bootstrap.json.extensionsRequired?.includes("KHR_texture_basisu"));
  assert.ok(bootstrap.json.extensionsRequired?.includes("KHR_texture_transform"));

  const sourceNames = sortedUnique(source.json.nodes.map((node) => node.name).filter(Boolean));
  const bootstrapNames = sortedUnique(
    bootstrap.json.nodes.map((node) => node.name).filter(Boolean),
  );
  assert.deepEqual(bootstrapNames, sourceNames, `${theme} named runtime nodes drifted`);
  assert.deepEqual(
    sortedUnique((bootstrap.json.materials ?? []).map(({ name }) => name)),
    sortedUnique((source.json.materials ?? []).map(({ name }) => name)),
    `${theme} material identities drifted`,
  );
  assert.deepEqual(
    materialSemantics(bootstrap.json),
    materialSemantics(source.json),
    `${theme} non-texture material response drifted`,
  );
  assert.equal(triangleCount(bootstrap), triangleCount(source), `${theme} triangle count drifted`);
  assert.equal(primitiveCount(bootstrap), primitiveCount(source), `${theme} primitives drifted`);
  assert.equal(bootstrap.json.images?.length, 3);
  assert.equal(bootstrap.json.textures?.length, 3);
  assert.equal(bootstrap.json.samplers?.length, 1);

  const contractExtras = bootstrap.json.asset?.extras?.[CONTRACT_KEY];
  assert.equal(contractExtras?.version, FORMAT_VERSION);
  assert.equal(contractExtras.sourceGlbSha256, sha256(source.buffer));
  const expectedSlots = sourceSlotSummary(source.json);
  const shippedSlots = contractExtras.sourceSlots
    .map(({ materialName, slot, family }) => ({ materialName, slot, family }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  assert.deepEqual(shippedSlots, expectedSlots, `${theme} PBR slot semantics drifted`);

  const boundsDeltaMeters = maximumBoundsDelta(sceneBounds(source), sceneBounds(bootstrap));
  assert.ok(boundsDeltaMeters <= 0.001, `${theme} bounds drifted ${boundsDeltaMeters}m`);
  const dependencies = await dependencyEntries(bootstrap, bootstrapFilename);
  assert.deepEqual(
    dependencies.map(({ textureClass }) => textureClass).sort(),
    ["baseColor", "normal", "orm"],
  );
  const base = dependencies.find(({ textureClass }) => textureClass === "baseColor");
  const normal = dependencies.find(({ textureClass }) => textureClass === "normal");
  const orm = dependencies.find(({ textureClass }) => textureClass === "orm");
  assert.equal(base.mode, "ETC1S");
  assert.deepEqual([base.width, base.height], [2112, 1584]);
  assert.equal(normal.mode, "UASTC");
  assert.deepEqual([normal.width, normal.height], [
    DETAIL_ATLAS_WIDTH,
    DETAIL_ATLAS_HEIGHT,
  ]);
  assert.equal(orm.mode, "ETC1S");
  assert.deepEqual([orm.width, orm.height], [
    DETAIL_ATLAS_WIDTH,
    DETAIL_ATLAS_HEIGHT,
  ]);

  const coldStartBytes = bootstrap.buffer.length
    + dependencies.reduce((total, entry) => total + entry.bytes, 0);
  assert.ok(
    coldStartBytes <= COLD_START_MAX_BYTES,
    `${theme} cold start ${coldStartBytes} exceeds 2.2 MiB`,
  );
  return {
    theme,
    source: {
      path: relativePath(sourceFilename),
      bytes: source.buffer.length,
      sha256: sha256(source.buffer),
      nodes: source.json.nodes?.length ?? 0,
      namedNodes: sourceNames.length,
      meshes: source.json.meshes?.length ?? 0,
      primitives: primitiveCount(source),
      triangles: triangleCount(source),
      materials: source.json.materials?.length ?? 0,
      externalTextureRequests: new Set(
        (source.json.images ?? []).map(({ uri }) => uri),
      ).size,
    },
    bootstrap: {
      path: relativePath(bootstrapFilename),
      bytes: bootstrap.buffer.length,
      sha256: sha256(bootstrap.buffer),
      savedGlbBytes: source.buffer.length - bootstrap.buffer.length,
      savedGlbPercent: round((1 - bootstrap.buffer.length / source.buffer.length) * 100, 3),
      nodes: bootstrap.json.nodes?.length ?? 0,
      namedNodes: bootstrapNames.length,
      meshes: bootstrap.json.meshes?.length ?? 0,
      primitives: primitiveCount(bootstrap),
      triangles: triangleCount(bootstrap),
      materials: bootstrap.json.materials?.length ?? 0,
      atlasRequests: dependencies.length,
    },
    quality: {
      namedNodeSetExact: true,
      triangleRatio: 1,
      materialIdentitySetExact: true,
      materialSemanticSetExact: true,
      pbrSlotContractSha256: sha256(Buffer.from(JSON.stringify(expectedSlots))),
      sceneBoundsMaxDeltaMeters: round(boundsDeltaMeters, 9),
    },
    requestGraph: {
      requests: 1 + dependencies.length,
      glbBytes: bootstrap.buffer.length,
      dependencyBytes: dependencies.reduce((total, entry) => total + entry.bytes, 0),
      coldStartBytes,
      coldStartMiB: round(coldStartBytes / 1024 / 1024, 3),
      maxBytes: COLD_START_MAX_BYTES,
      dependencies,
    },
  };
}

function reportFor(entries, atlases, sources, toolVersion, generatedAt) {
  return {
    formatVersion: FORMAT_VERSION,
    generatedAt,
    policy: {
      derivativeOnly: true,
      sourceThemeKitsUnmodified: true,
      namedRuntimeNodesExact: true,
      topologySimplification: false,
      geometryTransport: "Meshopt with default 14-bit position quantization and 0.1% error ceiling.",
      baseColor: "Reuse existing 512px/tile ETC1S environment bootstrap atlas byte-for-byte.",
      normal: "256px/tile UASTC quality 10; same normalized 4x3 atlas layout.",
      orm: "256px/tile ETC1S quality 10; same normalized 4x3 atlas layout.",
      coldStartDefinition: "One theme GLB plus its three unique external atlas dependencies, empty cache.",
    },
    tool: {
      name: "gltfpack",
      version: toolVersion,
      geometryArguments: GEOMETRY_ARGUMENTS,
      atlasArguments: ATLAS_ARGUMENTS,
    },
    budget: {
      perThemeColdStartBytes: COLD_START_MAX_BYTES,
      perThemeColdStartMiB: 2.2,
    },
    atlasLayout: {
      columns: ATLAS_COLUMNS,
      rows: ATLAS_ROWS,
      baseColorTilePixels: SOURCE_SIZE,
      detailTilePixels: DETAIL_SIZE,
      detailGutterPixels: DETAIL_GUTTER,
      detailWidth: DETAIL_ATLAS_WIDTH,
      detailHeight: DETAIL_ATLAS_HEIGHT,
      textureFamilies: TEXTURE_FAMILIES,
      themeTextureFamilies: [...THEME_TEXTURE_FAMILIES].sort(),
    },
    atlases,
    sourceTextures: sources.map((entry) => ({
      family: entry.family,
      textureClass: entry.textureClass,
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      width: entry.width,
      height: entry.height,
    })),
    themes: entries,
    totals: {
      sourceGlbBytes: entries.reduce((total, entry) => total + entry.source.bytes, 0),
      bootstrapGlbBytes: entries.reduce(
        (total, entry) => total + entry.bootstrap.bytes,
        0,
      ),
      maximumColdStartBytes: Math.max(
        ...entries.map((entry) => entry.requestGraph.coldStartBytes),
      ),
      maximumColdStartMiB: Math.max(
        ...entries.map((entry) => entry.requestGraph.coldStartMiB),
      ),
    },
  };
}

async function atlasReportEntry(atlas) {
  return {
    textureClass: atlas.textureClass,
    reusedExisting: atlas.reusedExisting,
    path: relativePath(atlas.path),
    bytes: atlas.bytes,
    sha256: atlas.sha256,
    width: atlas.width,
    height: atlas.height,
    levels: atlas.levels,
    mode: atlas.mode,
    supercompressionScheme: atlas.supercompressionScheme,
  };
}

async function build(options) {
  const encoder = await resolveGltfpack(options.gltfpack);
  assert.match(encoder.version, /^gltfpack 1\.2(?:\b|$)/u);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "chasing-theme-bootstrap-"));
  const environmentRoot = path.join(options.publicRoot, "models", "environment");
  const themeRoot = path.join(environmentRoot, "themes");
  const sharedRoot = path.join(environmentRoot, SHARED_DIRECTORY);
  await mkdir(themeRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await mkdir(path.dirname(options.report), { recursive: true });
  const stagedThemes = [];
  try {
    const baseColor = await existingBaseColorAtlas(options.publicRoot);
    const { atlases: generatedAtlases, sources } = await encodeDetailAtlases(
      encoder.executable,
      temporaryRoot,
      options.publicRoot,
    );
    const atlasObjects = [baseColor];
    for (const atlas of [generatedAtlases.normal, generatedAtlases.orm]) {
      const filename = path.join(sharedRoot, `${atlas.sha256}.ktx2`);
      const staged = path.join(sharedRoot, `.${atlas.sha256}.theme-bootstrap-${process.pid}`);
      await writeFile(staged, atlas.payload);
      await rename(staged, filename);
      atlas.path = filename;
      atlasObjects.push(atlas);
    }
    const atlasUris = Object.fromEntries(
      atlasObjects.map((atlas) => [
        atlas.textureClass,
        path.posix.join("..", SHARED_DIRECTORY, path.basename(atlas.path)),
      ]),
    );
    const entries = [];
    for (const [theme, contract] of Object.entries(THEME_BOOTSTRAP_CONTRACTS)) {
      const sourceFilename = path.join(themeRoot, contract.basename);
      const outputFilename = path.join(
        themeRoot,
        contract.basename.replace(/\.glb$/u, "-bootstrap.glb"),
      );
      const quantizedFilename = path.join(temporaryRoot, `${theme}-quantized.glb`);
      quantizeTheme(encoder.executable, sourceFilename, quantizedFilename);
      const [source, quantized] = await Promise.all([
        loadGlb(sourceFilename),
        loadGlb(quantizedFilename),
      ]);
      const rewritten = rewriteThemeWithAtlases(
        quantized,
        atlasUris,
        sha256(source.buffer),
      );
      const staged = path.join(
        themeRoot,
        `.${path.basename(outputFilename)}.theme-bootstrap-${process.pid}`,
      );
      await writeFile(staged, rewritten.buffer);
      const entry = await auditThemeBootstrap(theme, sourceFilename, staged);
      entry.bootstrap.path = relativePath(outputFilename);
      stagedThemes.push({ staged, outputFilename });
      entries.push(entry);
    }
    const atlasEntries = await Promise.all(atlasObjects.map(atlasReportEntry));
    const report = reportFor(
      entries,
      atlasEntries,
      sources,
      encoder.version,
      new Date().toISOString(),
    );
    const stagedReport = path.join(temporaryRoot, "theme-bootstrap.json");
    await writeFile(stagedReport, `${JSON.stringify(report, null, 2)}\n`);
    for (const theme of stagedThemes) await rename(theme.staged, theme.outputFilename);
    await rename(stagedReport, options.report);
    return report;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function check(options) {
  const existing = JSON.parse(await readFile(options.report, "utf8"));
  assert.equal(existing.formatVersion, FORMAT_VERSION);
  assert.deepEqual(existing.tool.geometryArguments, GEOMETRY_ARGUMENTS);
  assert.deepEqual(existing.tool.atlasArguments, ATLAS_ARGUMENTS);
  const environmentRoot = path.join(options.publicRoot, "models", "environment");
  const themeRoot = path.join(environmentRoot, "themes");
  const entries = [];
  for (const [theme, contract] of Object.entries(THEME_BOOTSTRAP_CONTRACTS)) {
    entries.push(await auditThemeBootstrap(
      theme,
      path.join(themeRoot, contract.basename),
      path.join(themeRoot, contract.basename.replace(/\.glb$/u, "-bootstrap.glb")),
    ));
  }
  const sourceEntries = await sourceTextureEntries(options.publicRoot);
  const current = reportFor(
    entries,
    existing.atlases,
    sourceEntries,
    existing.tool.version,
    existing.generatedAt,
  );
  assert.deepEqual(current, existing, `${options.report} does not match shipped theme bootstraps`);
  for (const atlas of existing.atlases) {
    const payload = await readFile(path.join(ROOT, atlas.path));
    assert.equal(payload.length, atlas.bytes);
    assert.equal(sha256(payload), atlas.sha256);
  }
  return current;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = options.check ? await check(options) : await build(options);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
