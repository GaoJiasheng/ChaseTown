#!/usr/bin/env node

/**
 * Repackages the standalone environment library around two shared KTX2
 * atlases. Geometry, animation accessors and node hierarchies are copied
 * byte-for-byte; only glTF image/texture indirection and texture transforms
 * change. BaseColor keeps the original 512px tile atlas. Normal reuses the
 * theme-bootstrap 256px tile atlas whose normalized 4x3 mapping is exactly
 * equivalent.
 *
 * The source PNGs intentionally remain the reproducible art input. They are
 * never requested by the runtime GLBs after this pass.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PUBLIC_ROOT = path.join(ROOT, "public");
const DEFAULT_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "environment-bootstrap-ktx2.json",
);
const THEME_BOOTSTRAP_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "theme-bootstrap.json",
);
const FORMAT_VERSION = 1;
const PIPELINE_CONTRACT_KEY = "chasing_environment_bootstrap";
const SHARED_DIRECTORY = "SharedTexturesBootstrapKTX2";
const SOURCE_TEXTURE_DIRECTORY = path.posix.join("models", "SharedTextures");
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const TARGETS = Object.freeze([
  "backpack.glb",
  "basketball.glb",
  "bench.glb",
  "blackboard.glb",
  "books.glb",
  "bulletin.glb",
  "ceiling-light.glb",
  "classroom-door.glb",
  "desk-chair.glb",
  "exit.glb",
  "extinguisher.glb",
  "front-gate.glb",
  "locker.glb",
  "podium.glb",
  "police-car.glb",
  "shrub.glb",
  "station.glb",
  "trash.glb",
  "tree.glb",
]);
const LEVEL_ONE_FIRST_PLAYABLE = Object.freeze([
  "front-gate.glb",
  "exit.glb",
  "locker.glb",
  "bench.glb",
  "tree.glb",
  "shrub.glb",
  "police-car.glb",
  "basketball.glb",
  "desk-chair.glb",
  "podium.glb",
]);
const TEXTURE_FAMILIES = Object.freeze([
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
const ATLAS_COLUMNS = 4;
const ATLAS_ROWS = 3;
const SOURCE_SIZE = 512;
const GUTTER = 8;
const TILE_STRIDE = SOURCE_SIZE + GUTTER * 2;
const ATLAS_WIDTH = ATLAS_COLUMNS * TILE_STRIDE;
const ATLAS_HEIGHT = ATLAS_ROWS * TILE_STRIDE;
const COMPACT_NORMAL_SIZE = 256;
const COMPACT_NORMAL_GUTTER = 4;
const COMPACT_NORMAL_STRIDE = COMPACT_NORMAL_SIZE + COMPACT_NORMAL_GUTTER * 2;
const COMPACT_NORMAL_WIDTH = ATLAS_COLUMNS * COMPACT_NORMAL_STRIDE;
const COMPACT_NORMAL_HEIGHT = ATLAS_ROWS * COMPACT_NORMAL_STRIDE;
const GLTFPACK_ARGUMENTS = Object.freeze([
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-noq",
  "-tc",
  "color",
  "-tu",
  "normal,attrib",
  "-tq",
  "color",
  "10",
  "-tq",
  "normal,attrib",
  "10",
  "-tj",
  "4",
]);

function parseArguments(argv) {
  const result = {
    publicRoot: DEFAULT_PUBLIC_ROOT,
    report: DEFAULT_REPORT,
    gltfpack: process.env.GLTFPACK_KTX2
      ? path.resolve(process.env.GLTFPACK_KTX2)
      : null,
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      result.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} needs a value`);
    if (argument === "--public-root") result.publicRoot = path.resolve(value);
    else if (argument === "--report") result.report = path.resolve(value);
    else if (argument === "--gltfpack") result.gltfpack = path.resolve(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!result.check && !result.gltfpack) {
    throw new Error(
      "Atlas encoding needs native gltfpack 1.2: pass --gltfpack PATH or set GLTFPACK_KTX2.",
    );
  }
  return result;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function extensionList(values, remove, add) {
  const result = (values ?? []).filter((value) => !remove.has(value));
  for (const value of add) if (!result.includes(value)) result.push(value);
  return result.length ? result : undefined;
}

function readGlb(buffer, filename) {
  assert.ok(buffer.length >= 20, `${filename} is too short to be a GLB`);
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
  assert.equal(buffer.readUInt32LE(4), 2, `${filename} must use glTF 2.0`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} has a wrong declared size`);
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
  assert.ok(json && binary, `${filename} needs JSON and BIN chunks`);
  const embeddedBufferIndex = json.buffers?.findIndex(
    (candidate) => candidate.uri === undefined
      && !candidate.extensions?.EXT_meshopt_compression?.fallback,
  );
  assert.ok(embeddedBufferIndex >= 0, `${filename} has no physical embedded buffer`);
  const logicalLength = json.buffers[embeddedBufferIndex].byteLength;
  assert.ok(logicalLength <= binary.length, `${filename} declares an oversized BIN payload`);
  return {
    buffer,
    json,
    binary: binary.subarray(0, logicalLength),
    embeddedBufferIndex,
    filename,
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

function textureInfoSourceUri(json, textureInfo, label) {
  assert.ok(textureInfo && Number.isInteger(textureInfo.index), `${label} has no texture index`);
  const texture = json.textures?.[textureInfo.index];
  assert.ok(texture, `${label} references missing texture ${textureInfo.index}`);
  const source = textureSource(texture);
  assert.ok(Number.isInteger(source), `${label} has no image source`);
  const image = json.images?.[source];
  assert.ok(image, `${label} references missing image ${source}`);
  assert.ok(image.uri?.endsWith(".png"), `${label} source must be a PNG before first conversion`);
  return image.uri;
}

function originalTextureSlots(asset) {
  const existing = asset.json.asset?.extras?.[PIPELINE_CONTRACT_KEY];
  if (existing) {
    assert.equal(existing.version, FORMAT_VERSION, `${asset.filename} has an old bootstrap contract`);
    assert.ok(Array.isArray(existing.slots), `${asset.filename} has no preserved texture slots`);
    return structuredClone(existing);
  }

  const slots = [];
  for (const [materialIndex, material] of (asset.json.materials ?? []).entries()) {
    const baseColorTexture = material.pbrMetallicRoughness?.baseColorTexture;
    if (baseColorTexture) {
      slots.push({
        materialIndex,
        slot: "baseColor",
        sourceUri: textureInfoSourceUri(
          asset.json,
          baseColorTexture,
          `${asset.filename} material ${materialIndex} baseColor`,
        ),
        textureInfo: structuredClone(baseColorTexture),
      });
    }
    if (material.normalTexture) {
      slots.push({
        materialIndex,
        slot: "normal",
        sourceUri: textureInfoSourceUri(
          asset.json,
          material.normalTexture,
          `${asset.filename} material ${materialIndex} normal`,
        ),
        textureInfo: structuredClone(material.normalTexture),
      });
    }
  }
  assert.ok(slots.length > 0, `${asset.filename} has no PBR texture slots`);
  return {
    version: FORMAT_VERSION,
    originalGlbBytes: asset.buffer.length,
    originalGlbSha256: sha256(asset.buffer),
    geometryBinarySha256: sha256(asset.binary),
    slots,
  };
}

function sourceBasename(sourceUri, expectedSuffix) {
  const basename = path.posix.basename(decodeURIComponent(sourceUri));
  assert.match(
    basename,
    new RegExp(`^Env_[A-Za-z]+_${expectedSuffix}_2K\\.png$`, "u"),
    `Unexpected source texture ${sourceUri}`,
  );
  return basename;
}

function familyFromBasename(basename, suffix) {
  return basename.slice("Env_".length, -`_${suffix}_2K.png`.length);
}

function atlasTransform(family) {
  const index = TEXTURE_FAMILIES.indexOf(family);
  assert.notEqual(index, -1, `Texture family ${family} is not assigned to the atlas`);
  const column = index % ATLAS_COLUMNS;
  const row = Math.floor(index / ATLAS_COLUMNS);
  return {
    offset: [
      (column * TILE_STRIDE + GUTTER) / ATLAS_WIDTH,
      (row * TILE_STRIDE + GUTTER) / ATLAS_HEIGHT,
    ],
    scale: [SOURCE_SIZE / ATLAS_WIDTH, SOURCE_SIZE / ATLAS_HEIGHT],
  };
}

function compactNormalAtlasTransform(family) {
  const index = TEXTURE_FAMILIES.indexOf(family);
  assert.notEqual(index, -1, `Texture family ${family} is not assigned to the compact atlas`);
  const column = index % ATLAS_COLUMNS;
  const row = Math.floor(index / ATLAS_COLUMNS);
  return {
    offset: [
      (column * COMPACT_NORMAL_STRIDE + COMPACT_NORMAL_GUTTER) / COMPACT_NORMAL_WIDTH,
      (row * COMPACT_NORMAL_STRIDE + COMPACT_NORMAL_GUTTER) / COMPACT_NORMAL_HEIGHT,
    ],
    scale: [
      COMPACT_NORMAL_SIZE / COMPACT_NORMAL_WIDTH,
      COMPACT_NORMAL_SIZE / COMPACT_NORMAL_HEIGHT,
    ],
  };
}

function normalizedLayoutMaxDelta() {
  let maximum = 0;
  for (const family of TEXTURE_FAMILIES) {
    const original = atlasTransform(family);
    const compact = compactNormalAtlasTransform(family);
    for (const [left, right] of [
      ...original.offset.map((value, index) => [value, compact.offset[index]]),
      ...original.scale.map((value, index) => [value, compact.scale[index]]),
    ]) {
      maximum = Math.max(maximum, Math.abs(left - right));
    }
  }
  return maximum;
}

function composeTextureTransform(original, atlas) {
  assert.equal(original?.rotation ?? 0, 0, "Rotated source texture transforms are not supported");
  const originalOffset = original?.offset ?? [0, 0];
  const originalScale = original?.scale ?? [1, 1];
  return {
    offset: [
      atlas.offset[0] + originalOffset[0] * atlas.scale[0],
      atlas.offset[1] + originalOffset[1] * atlas.scale[1],
    ],
    scale: [
      originalScale[0] * atlas.scale[0],
      originalScale[1] * atlas.scale[1],
    ],
  };
}

function atlasTextureInfo(contract, atlasTextureIndex) {
  const result = structuredClone(contract.textureInfo);
  result.index = atlasTextureIndex;
  result.extensions ??= {};
  result.extensions.KHR_texture_transform = composeTextureTransform(
    result.extensions.KHR_texture_transform,
    atlasTransform(
      familyFromBasename(
        sourceBasename(
          contract.sourceUri,
          contract.slot === "baseColor" ? "BaseColor" : "Normal",
        ),
        contract.slot === "baseColor" ? "BaseColor" : "Normal",
      ),
    ),
  );
  return result;
}

function rewriteWithAtlases(asset, atlasUris) {
  const contract = originalTextureSlots(asset);
  assert.equal(
    sha256(asset.binary),
    contract.geometryBinarySha256,
    `${asset.filename} geometry or animation binary drifted before atlas rewrite`,
  );
  const json = structuredClone(asset.json);
  json.asset.extras ??= {};
  json.asset.extras[PIPELINE_CONTRACT_KEY] = contract;
  for (const slot of contract.slots) {
    const material = json.materials?.[slot.materialIndex];
    assert.ok(material, `${asset.filename} lost material ${slot.materialIndex}`);
    if (slot.slot === "baseColor") {
      material.pbrMetallicRoughness ??= {};
      material.pbrMetallicRoughness.baseColorTexture = atlasTextureInfo(slot, 0);
    } else {
      material.normalTexture = atlasTextureInfo(slot, 1);
    }
  }
  json.images = [
    {
      name: "EnvironmentBootstrapBaseColorAtlas",
      uri: atlasUris.baseColor,
      extras: {
        chasing_atlas_class: "baseColor",
        chasing_source_resolution_preserved: true,
        chasing_tile_resolution: SOURCE_SIZE,
      },
    },
    {
      name: "EnvironmentBootstrapNormalAtlas",
      uri: atlasUris.normal,
      extras: {
        chasing_atlas_class: "normal",
        chasing_source_resolution_preserved: false,
        chasing_tile_resolution: COMPACT_NORMAL_SIZE,
        chasing_normalized_uv_layout_equivalent: true,
      },
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
      name: "EnvironmentBootstrapBaseColorAtlas",
      sampler: 0,
      extensions: { KHR_texture_basisu: { source: 0 } },
    },
    {
      name: "EnvironmentBootstrapNormalAtlas",
      sampler: 0,
      extensions: { KHR_texture_basisu: { source: 1 } },
    },
  ];
  const remove = new Set(["EXT_texture_webp"]);
  json.extensionsUsed = extensionList(
    json.extensionsUsed,
    remove,
    ["KHR_texture_basisu", "KHR_texture_transform"],
  );
  json.extensionsRequired = extensionList(
    json.extensionsRequired,
    remove,
    ["KHR_texture_basisu", "KHR_texture_transform"],
  );
  return {
    buffer: encodeGlb(json, asset.binary, asset.embeddedBufferIndex),
    contract,
  };
}

async function verifyTool(gltfpack) {
  await access(gltfpack);
  const result = spawnSync(gltfpack, ["-v"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "gltfpack -v failed");
  const version = result.stdout.trim();
  assert.equal(version, "gltfpack 1.2", `Expected native gltfpack 1.2, received ${version}`);
  return version;
}

async function textureSourceMetadata(publicRoot) {
  const entries = [];
  for (const family of TEXTURE_FAMILIES) {
    for (const textureClass of ["BaseColor", "Normal"]) {
      const basename = `Env_${family}_${textureClass}_2K.png`;
      const filename = path.join(publicRoot, SOURCE_TEXTURE_DIRECTORY, basename);
      const payload = await readFile(filename);
      const metadata = await sharp(payload).metadata();
      assert.equal(metadata.width, SOURCE_SIZE, `${basename} width drifted`);
      assert.equal(metadata.height, SOURCE_SIZE, `${basename} height drifted`);
      entries.push({
        family,
        textureClass,
        basename,
        path: path.relative(ROOT, filename).split(path.sep).join("/"),
        bytes: payload.length,
        sha256: sha256(payload),
        width: metadata.width,
        height: metadata.height,
      });
    }
  }
  return entries;
}

async function buildAtlasPng(publicRoot, sourceEntries, textureClass, output) {
  const background = textureClass === "BaseColor"
    ? { r: 127, g: 127, b: 127, alpha: 1 }
    : { r: 128, g: 128, b: 255, alpha: 1 };
  const composites = [];
  for (const entry of sourceEntries.filter((candidate) => candidate.textureClass === textureClass)) {
    const index = TEXTURE_FAMILIES.indexOf(entry.family);
    const tile = await sharp(path.join(ROOT, entry.path))
      .extend({
        top: GUTTER,
        bottom: GUTTER,
        left: GUTTER,
        right: GUTTER,
        extendWith: "copy",
      })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    composites.push({
      input: tile,
      left: (index % ATLAS_COLUMNS) * TILE_STRIDE,
      top: Math.floor(index / ATLAS_COLUMNS) * TILE_STRIDE,
    });
  }
  await sharp({
    create: {
      width: ATLAS_WIDTH,
      height: ATLAS_HEIGHT,
      channels: 3,
      background,
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(output);
}

function makeSyntheticAtlasGltf(baseColorBasename, normalBasename) {
  const binary = Buffer.alloc(104);
  const positions = [
    -1, -1, 0,
    1, -1, 0,
    0, 1, 0,
  ];
  const normals = [
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ];
  const uvs = [0, 0, 1, 0, 0.5, 1];
  positions.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  normals.forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
  uvs.forEach((value, index) => binary.writeFloatLE(value, 72 + index * 4));
  [0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 96 + index * 2));
  return {
    binary,
    json: {
      asset: { version: "2.0", generator: "Chasing environment bootstrap atlas encoder" },
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
        { name: "EnvironmentBootstrapBaseColorAtlas", uri: baseColorBasename },
        { name: "EnvironmentBootstrapNormalAtlas", uri: normalBasename },
      ],
      samplers: [{}],
      textures: [
        { sampler: 0, source: 0 },
        { sampler: 0, source: 1 },
      ],
      materials: [{
        name: "M_AtlasEncoder",
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        normalTexture: { index: 1 },
      }],
      meshes: [{
        name: "AtlasEncoderTriangle",
        primitives: [{
          attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
          indices: 3,
          material: 0,
        }],
      }],
      nodes: [{ name: "AtlasEncoderTriangle", mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    },
  };
}

function imagePayload(asset, image) {
  assert.notEqual(image.bufferView, undefined, `${asset.filename} image has no payload`);
  const view = asset.json.bufferViews[image.bufferView];
  assert.equal(view.buffer, asset.embeddedBufferIndex);
  const start = view.byteOffset ?? 0;
  return asset.binary.subarray(start, start + view.byteLength);
}

function ktx2Metadata(payload, label) {
  assert.ok(payload.length >= 80, `${label} is too small to be KTX2`);
  assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE), `${label} has a wrong KTX2 signature`);
  assert.equal(payload.readUInt32LE(12), 0, `${label} must use Basis Universal`);
  const scheme = payload.readUInt32LE(44);
  const mode = scheme === 1 ? "ETC1S" : scheme === 2 ? "UASTC" : `unknown-${scheme}`;
  assert.notEqual(mode.startsWith("unknown-"), true, `${label} has unsupported supercompression`);
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

async function encodeAtlases(gltfpack, temporaryRoot, publicRoot) {
  const sourceEntries = await textureSourceMetadata(publicRoot);
  const baseColorPng = path.join(temporaryRoot, "environment-base-color-atlas.png");
  const normalPng = path.join(temporaryRoot, "environment-normal-atlas.png");
  await buildAtlasPng(publicRoot, sourceEntries, "BaseColor", baseColorPng);
  await buildAtlasPng(publicRoot, sourceEntries, "Normal", normalPng);

  const synthetic = makeSyntheticAtlasGltf(
    path.basename(baseColorPng),
    path.basename(normalPng),
  );
  const input = path.join(temporaryRoot, "atlas.gltf");
  const encoded = path.join(temporaryRoot, "atlas.glb");
  await writeFile(path.join(temporaryRoot, "atlas.bin"), synthetic.binary);
  await writeFile(input, `${JSON.stringify(synthetic.json)}\n`);
  const args = ["-i", input, "-o", encoded, ...GLTFPACK_ARGUMENTS];
  const result = spawnSync(gltfpack, args, {
    cwd: temporaryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Atlas gltfpack encoding failed");
  }
  const asset = await loadGlb(encoded);
  const atlases = {};
  for (const image of asset.json.images ?? []) {
    const payload = Buffer.from(imagePayload(asset, image));
    if (image.name === "EnvironmentBootstrapBaseColorAtlas") {
      atlases.baseColor = {
        textureClass: "baseColor",
        expectedMode: "ETC1S",
        payload,
        ...ktx2Metadata(payload, image.name),
      };
    } else if (image.name === "EnvironmentBootstrapNormalAtlas") {
      atlases.normal = {
        textureClass: "normal",
        expectedMode: "UASTC",
        payload,
        ...ktx2Metadata(payload, image.name),
      };
    }
  }
  assert.ok(atlases.baseColor && atlases.normal, "gltfpack dropped an atlas image");
  assert.equal(atlases.baseColor.mode, atlases.baseColor.expectedMode);
  assert.equal(atlases.normal.mode, atlases.normal.expectedMode);
  for (const atlas of [atlases.baseColor, atlases.normal]) {
    assert.equal(atlas.width, ATLAS_WIDTH, `${atlas.textureClass} atlas width drifted`);
    assert.equal(atlas.height, ATLAS_HEIGHT, `${atlas.textureClass} atlas height drifted`);
    assert.ok(atlas.levels >= 11, `${atlas.textureClass} atlas has no full mip chain`);
  }
  const compactNormal = await loadCompactThemeNormalAtlas(publicRoot, sourceEntries);
  return {
    atlases: {
      baseColor: {
        ...atlases.baseColor,
        sourceTileWidth: SOURCE_SIZE,
        sourceTileHeight: SOURCE_SIZE,
        gutterPixels: GUTTER,
        reusedFromThemeBootstrap: false,
        normalizedTransformMaxDelta: 0,
      },
      normal: compactNormal,
    },
    sourceEntries,
    supersededNormalAtlas: {
      bytes: atlases.normal.bytes,
      sha256: atlases.normal.sha256,
      width: atlases.normal.width,
      height: atlases.normal.height,
    },
  };
}

async function loadCompactThemeNormalAtlas(publicRoot, sourceEntries) {
  const report = JSON.parse(await readFile(THEME_BOOTSTRAP_REPORT, "utf8"));
  assert.equal(report.formatVersion, FORMAT_VERSION);
  assert.equal(report.atlasLayout.columns, ATLAS_COLUMNS);
  assert.equal(report.atlasLayout.rows, ATLAS_ROWS);
  assert.equal(report.atlasLayout.detailTilePixels, COMPACT_NORMAL_SIZE);
  assert.equal(report.atlasLayout.detailGutterPixels, COMPACT_NORMAL_GUTTER);
  assert.equal(report.atlasLayout.detailWidth, COMPACT_NORMAL_WIDTH);
  assert.equal(report.atlasLayout.detailHeight, COMPACT_NORMAL_HEIGHT);
  assert.deepEqual(report.atlasLayout.textureFamilies, TEXTURE_FAMILIES);
  const entry = report.atlases.find(({ textureClass }) => textureClass === "normal");
  assert.ok(entry, "Theme bootstrap report has no compact Normal atlas");
  const filename = path.join(ROOT, entry.path);
  assert.ok(filename.startsWith(publicRoot), "Compact Normal atlas is outside public root");
  const payload = await readFile(filename);
  assert.equal(payload.length, entry.bytes);
  assert.equal(sha256(payload), entry.sha256);
  const metadata = ktx2Metadata(payload, filename);
  assert.equal(metadata.mode, "UASTC");
  assert.equal(metadata.width, COMPACT_NORMAL_WIDTH);
  assert.equal(metadata.height, COMPACT_NORMAL_HEIGHT);
  assert.ok(metadata.levels >= 10);

  const themeSources = new Map(
    report.sourceTextures
      .filter(({ textureClass }) => textureClass === "normal")
      .map((source) => [source.family, source]),
  );
  for (const source of sourceEntries.filter(({ textureClass }) => textureClass === "Normal")) {
    const themeSource = themeSources.get(source.family);
    assert.ok(themeSource, `Theme compact atlas lost ${source.family} Normal source`);
    assert.equal(themeSource.sha256, source.sha256, `${source.family} Normal source hash drifted`);
    assert.equal(themeSource.width, source.width);
    assert.equal(themeSource.height, source.height);
  }
  const layoutDelta = normalizedLayoutMaxDelta();
  assert.equal(layoutDelta, 0, "Compact Normal atlas changed normalized UV mapping");
  return {
    textureClass: "normal",
    expectedMode: "UASTC",
    payload,
    ...metadata,
    sourceTileWidth: COMPACT_NORMAL_SIZE,
    sourceTileHeight: COMPACT_NORMAL_SIZE,
    gutterPixels: COMPACT_NORMAL_GUTTER,
    reusedFromThemeBootstrap: true,
    normalizedTransformMaxDelta: layoutDelta,
  };
}

async function protectedSharedAtlasBasenames() {
  const protectedNames = new Set();
  try {
    const report = JSON.parse(await readFile(THEME_BOOTSTRAP_REPORT, "utf8"));
    for (const atlas of report.atlases ?? []) {
      if (path.dirname(atlas.path).endsWith(SHARED_DIRECTORY)) {
        protectedNames.add(path.basename(atlas.path));
      }
    }
  } catch {
    // The standalone pipeline remains usable before optional theme derivatives exist.
  }
  return protectedNames;
}

function structureSnapshot(json) {
  const signature = (values) => ({
    count: values.length,
    sha256: sha256(Buffer.from(JSON.stringify(values))),
  });
  return {
    nodes: signature((json.nodes ?? []).map((node) => node.name ?? null)),
    meshes: signature((json.meshes ?? []).map((mesh) => mesh.name ?? null)),
    materials: signature((json.materials ?? []).map((material) => material.name ?? null)),
    animations: signature((json.animations ?? []).map((animation) => animation.name ?? null)),
    accessors: signature((json.accessors ?? []).map((accessor) => ({
      componentType: accessor.componentType,
      count: accessor.count,
      type: accessor.type,
      min: accessor.min,
      max: accessor.max,
    }))),
    skins: signature((json.skins ?? []).map((skin) => skin.joints)),
  };
}

function relativeReportPath(filename) {
  return path.relative(ROOT, filename).split(path.sep).join("/");
}

function atlasUri(atlas) {
  return path.posix.join(SHARED_DIRECTORY, `${atlas.sha256}.ktx2`);
}

function uniqueSourceUris(contracts) {
  return new Set(contracts.flatMap((contract) => contract.slots.map((slot) => slot.sourceUri)));
}

async function build(options) {
  const toolVersion = await verifyTool(options.gltfpack);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "chasing-environment-bootstrap-"));
  const environmentRoot = path.join(options.publicRoot, "models", "environment");
  const sharedRoot = path.join(environmentRoot, SHARED_DIRECTORY);
  const stagedOutputs = [];
  try {
    const { atlases, sourceEntries, supersededNormalAtlas } = await encodeAtlases(
      options.gltfpack,
      temporaryRoot,
      options.publicRoot,
    );
    const atlasUris = {
      baseColor: atlasUri(atlases.baseColor),
      normal: atlasUri(atlases.normal),
    };
    const entries = [];
    const contracts = [];
    for (const [targetIndex, target] of TARGETS.entries()) {
      const filename = path.join(environmentRoot, target);
      const source = await loadGlb(filename);
      const beforeStructure = structureSnapshot(source.json);
      const { buffer, contract } = rewriteWithAtlases(source, atlasUris);
      const finalAsset = readGlb(buffer, filename);
      assert.deepEqual(
        structureSnapshot(finalAsset.json),
        beforeStructure,
        `${target} hierarchy, accessor or animation contract changed`,
      );
      assert.equal(
        sha256(finalAsset.binary),
        contract.geometryBinarySha256,
        `${target} geometry/animation BIN changed`,
      );
      assert.equal(finalAsset.json.images.length, 2);
      assert.equal(finalAsset.json.textures.length, 2);
      assert.ok(finalAsset.json.extensionsRequired?.includes("KHR_texture_basisu"));
      assert.ok(finalAsset.json.extensionsRequired?.includes("KHR_texture_transform"));
      const staged = path.join(
        environmentRoot,
        `.${target}.bootstrap-${process.pid}-${targetIndex}`,
      );
      await writeFile(staged, buffer);
      stagedOutputs.push({ staged, output: filename });
      contracts.push(contract);
      entries.push({
        path: relativeReportPath(filename),
        original: {
          bytes: contract.originalGlbBytes,
          sha256: contract.originalGlbSha256,
          externalPngRequests: new Set(contract.slots.map((slot) => slot.sourceUri)).size,
        },
        output: {
          bytes: buffer.length,
          sha256: sha256(buffer),
          atlasRequests: 2,
        },
        geometryBinarySha256: contract.geometryBinarySha256,
        structure: structureSnapshot(finalAsset.json),
        nodes: finalAsset.json.nodes?.length ?? 0,
        meshes: finalAsset.json.meshes?.length ?? 0,
        materials: finalAsset.json.materials?.length ?? 0,
        animations: (finalAsset.json.animations ?? []).map((animation) => animation.name),
        sourceSlots: contract.slots.map((slot) => ({
          materialIndex: slot.materialIndex,
          slot: slot.slot,
          sourceUri: slot.sourceUri,
        })),
      });
    }

    await mkdir(sharedRoot, { recursive: true });
    const atlasEntries = [];
    for (const atlas of [atlases.baseColor, atlases.normal]) {
      const basename = `${atlas.sha256}.ktx2`;
      const output = path.join(sharedRoot, basename);
      const staged = path.join(sharedRoot, `.${basename}.bootstrap-${process.pid}`);
      await writeFile(staged, atlas.payload);
      stagedOutputs.push({ staged, output });
      atlasEntries.push({
        textureClass: atlas.textureClass,
        expectedMode: atlas.expectedMode,
        path: relativeReportPath(output),
        bytes: atlas.bytes,
        sha256: atlas.sha256,
        width: atlas.width,
        height: atlas.height,
        levels: atlas.levels,
        supercompressionScheme: atlas.supercompressionScheme,
        sourceTileWidth: atlas.sourceTileWidth,
        sourceTileHeight: atlas.sourceTileHeight,
        gutterPixels: atlas.gutterPixels,
        reusedFromThemeBootstrap: atlas.reusedFromThemeBootstrap,
        normalizedTransformMaxDelta: atlas.normalizedTransformMaxDelta,
      });
    }

    const sourceTextureBytes = sourceEntries.reduce((total, entry) => total + entry.bytes, 0);
    const originalGlbBytes = entries.reduce((total, entry) => total + entry.original.bytes, 0);
    const outputGlbBytes = entries.reduce((total, entry) => total + entry.output.bytes, 0);
    const atlasBytes = atlasEntries.reduce((total, entry) => total + entry.bytes, 0);
    const allSourceUris = uniqueSourceUris(contracts);
    assert.equal(allSourceUris.size, sourceEntries.length);
    const levelOneEntries = entries.filter((entry) => (
      LEVEL_ONE_FIRST_PLAYABLE.includes(path.basename(entry.path))
    ));
    assert.equal(levelOneEntries.length, LEVEL_ONE_FIRST_PLAYABLE.length);
    const levelOneSourceUris = new Set(
      levelOneEntries.flatMap((entry) => entry.sourceSlots.map((slot) => slot.sourceUri)),
    );
    const sourceByRelativeUri = new Map(sourceEntries.map((entry) => [
      `../SharedTextures/${entry.basename}`,
      entry,
    ]));
    const levelOneSourceTextureBytes = [...levelOneSourceUris].reduce((total, uri) => {
      const source = sourceByRelativeUri.get(uri);
      assert.ok(source, `Level one references an unknown source texture ${uri}`);
      return total + source.bytes;
    }, 0);
    const levelOneOriginalGlbBytes = levelOneEntries.reduce(
      (total, entry) => total + entry.original.bytes,
      0,
    );
    const levelOneOutputGlbBytes = levelOneEntries.reduce(
      (total, entry) => total + entry.output.bytes,
      0,
    );
    const report = {
      formatVersion: FORMAT_VERSION,
      policy: {
        geometryAndAnimationBinaryByteStable: true,
        sourceResolution: "BaseColor retains 512px tiles; Normal uses a reviewed 256px first-paint derivative.",
        atlasLayout: "BaseColor 512px+8px and Normal 256px+4px share an exactly equivalent normalized 4x3 layout.",
        baseColor: "ETC1S quality 10 with BasisLZ supercompression",
        normal: "Reuse theme-bootstrap 256px/tile UASTC quality 10 atlas with Zstandard supercompression",
        normalAtlasNormalizedUvEquivalent: true,
        normalAtlasSourceHashesExact: true,
        fallbackImages: false,
        applicationUrlChangesRequired: false,
      },
      tool: {
        name: "gltfpack",
        version: toolVersion,
        arguments: GLTFPACK_ARGUMENTS,
        nativeBinaryCommitted: false,
      },
      atlas: {
        columns: ATLAS_COLUMNS,
        rows: ATLAS_ROWS,
        textureFamilies: TEXTURE_FAMILIES,
        normalizedUvLayoutEquivalent: true,
        normalizedTransformMaxDelta: normalizedLayoutMaxDelta(),
        baseColor: {
          sourceTileWidth: SOURCE_SIZE,
          sourceTileHeight: SOURCE_SIZE,
          gutterPixels: GUTTER,
          width: ATLAS_WIDTH,
          height: ATLAS_HEIGHT,
        },
        normal: {
          sourceTileWidth: COMPACT_NORMAL_SIZE,
          sourceTileHeight: COMPACT_NORMAL_SIZE,
          gutterPixels: COMPACT_NORMAL_GUTTER,
          width: COMPACT_NORMAL_WIDTH,
          height: COMPACT_NORMAL_HEIGHT,
        },
      },
      totals: {
        originalGlbBytes,
        sourceTextureBytes,
        originalRuntimeBytes: originalGlbBytes + sourceTextureBytes,
        originalRuntimeRequests: TARGETS.length + sourceEntries.length,
        outputGlbBytes,
        atlasBytes,
        outputRuntimeBytes: outputGlbBytes + atlasBytes,
        outputRuntimeRequests: TARGETS.length + atlasEntries.length,
        savedBytes: originalGlbBytes + sourceTextureBytes - outputGlbBytes - atlasBytes,
        savedPercent: Number(
          (
            (1 - (outputGlbBytes + atlasBytes) / (originalGlbBytes + sourceTextureBytes))
            * 100
          ).toFixed(3),
        ),
        requestsSaved: sourceEntries.length - atlasEntries.length,
        supersededNormalAtlasBytes: supersededNormalAtlas.bytes,
        compactNormalAtlasBytes: atlases.normal.bytes,
        normalAtlasBytesSaved: supersededNormalAtlas.bytes - atlases.normal.bytes,
      },
      levelOneFirstPlayable: {
        assets: LEVEL_ONE_FIRST_PLAYABLE,
        originalGlbBytes: levelOneOriginalGlbBytes,
        sourceTextureBytes: levelOneSourceTextureBytes,
        originalRuntimeBytes: levelOneOriginalGlbBytes + levelOneSourceTextureBytes,
        originalRuntimeRequests: LEVEL_ONE_FIRST_PLAYABLE.length + levelOneSourceUris.size,
        outputGlbBytes: levelOneOutputGlbBytes,
        atlasBytes,
        outputRuntimeBytes: levelOneOutputGlbBytes + atlasBytes,
        outputRuntimeRequests: LEVEL_ONE_FIRST_PLAYABLE.length + atlasEntries.length,
        savedBytes: (
          levelOneOriginalGlbBytes
          + levelOneSourceTextureBytes
          - levelOneOutputGlbBytes
          - atlasBytes
        ),
        requestsSaved: levelOneSourceUris.size - atlasEntries.length,
      },
      sourceTextures: sourceEntries,
      atlases: atlasEntries,
      assets: entries,
    };
    assert.ok(
      report.levelOneFirstPlayable.outputRuntimeBytes <= 8 * 1024 * 1024,
      `Level-one environment bootstrap exceeds 8 MiB: ${report.levelOneFirstPlayable.outputRuntimeBytes}`,
    );
    assert.ok(
      report.totals.outputRuntimeBytes <= 8 * 1024 * 1024,
      `Standalone environment library exceeds 8 MiB: ${report.totals.outputRuntimeBytes}`,
    );
    assert.ok(report.totals.requestsSaved >= 20, "Atlas request reduction regressed");

    await mkdir(path.dirname(options.report), { recursive: true });
    const stagedReport = `${options.report}.bootstrap-${process.pid}`;
    await writeFile(stagedReport, `${JSON.stringify(report, null, 2)}\n`);
    stagedOutputs.push({ staged: stagedReport, output: options.report });

    for (const { staged, output } of stagedOutputs) await rename(staged, output);

    const retained = new Set(atlasEntries.map((entry) => path.basename(entry.path)));
    for (const basename of await protectedSharedAtlasBasenames()) retained.add(basename);
    for (const entry of await readdir(sharedRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ktx2") && !retained.has(entry.name)) {
        await rm(path.join(sharedRoot, entry.name));
      }
    }
    console.log(JSON.stringify({
      totals: report.totals,
      levelOneFirstPlayable: report.levelOneFirstPlayable,
      atlas: report.atlases,
    }, null, 2));
  } catch (error) {
    await Promise.all(stagedOutputs.map(({ staged }) => rm(staged, { force: true })));
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function check(options) {
  const report = JSON.parse(await readFile(options.report, "utf8"));
  assert.equal(report.formatVersion, FORMAT_VERSION);
  assert.deepEqual(report.assets.map((entry) => path.basename(entry.path)), TARGETS);
  assert.deepEqual(report.levelOneFirstPlayable.assets, LEVEL_ONE_FIRST_PLAYABLE);
  assert.deepEqual(report.atlas.textureFamilies, TEXTURE_FAMILIES);
  assert.equal(report.atlas.normalizedUvLayoutEquivalent, true);
  assert.equal(report.atlas.normalizedTransformMaxDelta, 0);
  assert.deepEqual(report.atlas.baseColor, {
    sourceTileWidth: SOURCE_SIZE,
    sourceTileHeight: SOURCE_SIZE,
    gutterPixels: GUTTER,
    width: ATLAS_WIDTH,
    height: ATLAS_HEIGHT,
  });
  assert.deepEqual(report.atlas.normal, {
    sourceTileWidth: COMPACT_NORMAL_SIZE,
    sourceTileHeight: COMPACT_NORMAL_SIZE,
    gutterPixels: COMPACT_NORMAL_GUTTER,
    width: COMPACT_NORMAL_WIDTH,
    height: COMPACT_NORMAL_HEIGHT,
  });
  assert.equal(report.atlases.length, 2);
  const environmentRoot = path.join(options.publicRoot, "models", "environment");
  const expectedUris = new Set(report.atlases.map((atlas) => (
    path.posix.join(SHARED_DIRECTORY, path.basename(atlas.path))
  )));
  for (const entry of report.assets) {
    const filename = path.join(ROOT, entry.path);
    const buffer = await readFile(filename);
    assert.equal(buffer.length, entry.output.bytes, `${entry.path} byte count drifted`);
    assert.equal(sha256(buffer), entry.output.sha256, `${entry.path} SHA-256 drifted`);
    const asset = readGlb(buffer, filename);
    assert.equal(sha256(asset.binary), entry.geometryBinarySha256);
    assert.deepEqual(structureSnapshot(asset.json), entry.structure);
    assert.ok(asset.json.extensionsRequired?.includes("KHR_texture_basisu"));
    assert.ok(asset.json.extensionsRequired?.includes("KHR_texture_transform"));
    assert.equal(asset.json.images.length, 2);
    assert.equal(asset.json.textures.length, 2);
    assert.deepEqual(new Set(asset.json.images.map((image) => image.uri)), expectedUris);
    assert.ok(asset.json.textures.every((texture) => (
      texture.source === undefined
      && Number.isInteger(texture.extensions?.KHR_texture_basisu?.source)
    )));
    const contract = asset.json.asset?.extras?.[PIPELINE_CONTRACT_KEY];
    assert.equal(contract.geometryBinarySha256, entry.geometryBinarySha256);
    assert.equal(contract.slots.length, entry.sourceSlots.length);
  }
  const sharedRoot = path.join(environmentRoot, SHARED_DIRECTORY);
  const shipped = (await readdir(sharedRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ktx2"))
    .map((entry) => entry.name)
    .sort();
  const expectedShared = new Set(
    report.atlases.map((entry) => path.basename(entry.path)),
  );
  for (const basename of await protectedSharedAtlasBasenames()) {
    expectedShared.add(basename);
  }
  assert.deepEqual(shipped, [...expectedShared].sort());
  for (const atlas of report.atlases) {
    const payload = await readFile(path.join(ROOT, atlas.path));
    assert.equal(payload.length, atlas.bytes);
    assert.equal(sha256(payload), atlas.sha256);
    const metadata = ktx2Metadata(payload, atlas.path);
    assert.equal(metadata.width, atlas.width);
    assert.equal(metadata.height, atlas.height);
    assert.equal(metadata.levels, atlas.levels);
    assert.equal(metadata.mode, atlas.expectedMode);
  }
  const sourceEntries = await textureSourceMetadata(options.publicRoot);
  assert.deepEqual(sourceEntries, report.sourceTextures);
  const originalGlbBytes = report.assets.reduce(
    (total, entry) => total + entry.original.bytes,
    0,
  );
  const outputGlbBytes = report.assets.reduce(
    (total, entry) => total + entry.output.bytes,
    0,
  );
  const sourceTextureBytes = report.sourceTextures.reduce(
    (total, entry) => total + entry.bytes,
    0,
  );
  const atlasBytes = report.atlases.reduce((total, entry) => total + entry.bytes, 0);
  assert.equal(report.totals.originalGlbBytes, originalGlbBytes);
  assert.equal(report.totals.outputGlbBytes, outputGlbBytes);
  assert.equal(report.totals.sourceTextureBytes, sourceTextureBytes);
  assert.equal(report.totals.atlasBytes, atlasBytes);
  assert.equal(report.totals.outputRuntimeBytes, outputGlbBytes + atlasBytes);
  assert.equal(report.totals.outputRuntimeRequests, TARGETS.length + 2);
  assert.equal(
    report.totals.normalAtlasBytesSaved,
    report.totals.supersededNormalAtlasBytes - report.totals.compactNormalAtlasBytes,
  );
  assert.ok(report.totals.normalAtlasBytesSaved >= 1_600_000);
  assert.ok(report.levelOneFirstPlayable.outputRuntimeBytes <= 8 * 1024 * 1024);
  assert.ok(report.totals.outputRuntimeBytes <= 8 * 1024 * 1024);
  assert.ok(report.totals.requestsSaved >= 20);
  console.log(
    `Validated ${report.assets.length} byte-stable environment GLBs and ${report.atlases.length} shared KTX2 atlases.`,
  );
}

const options = parseArguments(process.argv.slice(2));
if (options.check) await check(options);
else await build(options);
