#!/usr/bin/env node

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
  stat,
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
  "docs",
  "art_production",
  "reports",
  "runtime-ktx2.json",
);
const FORMAT_VERSION = 1;
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const BASE_ARGUMENTS = Object.freeze([
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-noq",
  "-af",
  "0",
  "-at",
  "24",
  "-ar",
  "16",
  "-as",
  "24",
]);
const UASTC_ARGUMENTS = Object.freeze([
  ...BASE_ARGUMENTS,
  "-tu",
  "-tq",
  "10",
  "-tj",
  "4",
]);
const THEME_ARGUMENTS = Object.freeze([
  ...BASE_ARGUMENTS,
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
const TARGETS = Object.freeze([
  { relative: "models/characters/kid.glb", policy: "uastc" },
  { relative: "models/characters/villain.glb", policy: "uastc" },
  { relative: "models/characters/police.glb", policy: "uastc" },
  { relative: "models/environment/themes/campus-kit.glb", policy: "theme-mixed" },
  { relative: "models/environment/themes/hospital-kit.glb", policy: "theme-mixed" },
  { relative: "models/environment/themes/fire-station-kit.glb", policy: "theme-mixed" },
  { relative: "models/environment/themes/factory-kit.glb", policy: "theme-mixed" },
]);

function parseArguments(argv) {
  const result = {
    sourceRoot: DEFAULT_PUBLIC_ROOT,
    outputRoot: DEFAULT_PUBLIC_ROOT,
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
    if (argument === "--source-root") result.sourceRoot = path.resolve(value);
    else if (argument === "--output-root") result.outputRoot = path.resolve(value);
    else if (argument === "--report") result.report = path.resolve(value);
    else if (argument === "--gltfpack") result.gltfpack = path.resolve(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!result.check && !result.gltfpack) {
    throw new Error(
      "KTX2 encoding needs the native gltfpack 1.2 binary: pass --gltfpack PATH or set GLTFPACK_KTX2.",
    );
  }
  return result;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
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

function extensionList(values, remove, add) {
  const result = (values ?? []).filter((value) => !remove.has(value));
  for (const value of add) if (!result.includes(value)) result.push(value);
  return result.length ? result : undefined;
}

function imagePayload(asset, image) {
  assert.equal(image.uri, undefined, `${asset.filename} external image must be resolved first`);
  assert.notEqual(image.bufferView, undefined, `${asset.filename} image has no payload`);
  const view = asset.json.bufferViews[image.bufferView];
  assert.equal(
    view.buffer,
    asset.embeddedBufferIndex,
    `${asset.filename} image is not in the physical GLB buffer`,
  );
  const start = view.byteOffset ?? 0;
  const end = start + view.byteLength;
  assert.ok(end <= asset.binary.length, `${asset.filename} image exceeds the BIN payload`);
  return asset.binary.subarray(start, end);
}

function rangeOverlaps(left, right) {
  return left.start < right.end && right.start < left.end;
}

function shiftedOffset(offset, removedRanges, label) {
  let removedBytes = 0;
  for (const range of removedRanges) {
    if (offset >= range.end) {
      removedBytes += range.end - range.start;
      continue;
    }
    assert.ok(offset <= range.start, `${label} starts inside a removed image payload`);
    break;
  }
  return offset - removedBytes;
}

function rewriteEmbeddedImages(asset, payloads, mimeType, externalUris = null) {
  assert.equal(payloads.length, asset.json.images?.length ?? 0);
  if (externalUris) assert.equal(externalUris.length, payloads.length);
  const json = structuredClone(asset.json);
  const imageViewIndexes = new Set();
  const removedRanges = [];

  for (const image of json.images ?? []) {
    if (image.bufferView === undefined) continue;
    assert.equal(
      imageViewIndexes.has(image.bufferView),
      false,
      `${asset.filename} shares one embedded image view across multiple images`,
    );
    imageViewIndexes.add(image.bufferView);
    const view = json.bufferViews[image.bufferView];
    assert.equal(
      view.buffer,
      asset.embeddedBufferIndex,
      `${asset.filename} has an image outside its physical buffer`,
    );
    removedRanges.push({
      start: view.byteOffset ?? 0,
      end: (view.byteOffset ?? 0) + view.byteLength,
      viewIndex: image.bufferView,
    });
  }
  removedRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < removedRanges.length; index += 1) {
    assert.ok(
      removedRanges[index - 1].end <= removedRanges[index].start,
      `${asset.filename} has overlapping image payloads`,
    );
  }

  for (const [viewIndex, view] of json.bufferViews.entries()) {
    if (view.buffer === asset.embeddedBufferIndex && !imageViewIndexes.has(viewIndex)) {
      const range = {
        start: view.byteOffset ?? 0,
        end: (view.byteOffset ?? 0) + view.byteLength,
      };
      assert.equal(
        removedRanges.some((removed) => rangeOverlaps(range, removed)),
        false,
        `${asset.filename} image payload overlaps bufferView ${viewIndex}`,
      );
    }
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression?.buffer === asset.embeddedBufferIndex) {
      const range = {
        start: compression.byteOffset ?? 0,
        end: (compression.byteOffset ?? 0) + compression.byteLength,
      };
      assert.equal(
        removedRanges.some((removed) => rangeOverlaps(range, removed)),
        false,
        `${asset.filename} image payload overlaps Meshopt bufferView ${viewIndex}`,
      );
    }
  }

  const compactParts = [];
  let cursor = 0;
  for (const range of removedRanges) {
    compactParts.push(asset.binary.subarray(cursor, range.start));
    cursor = range.end;
  }
  compactParts.push(asset.binary.subarray(cursor));
  let binary = Buffer.concat(compactParts);

  for (const [viewIndex, view] of json.bufferViews.entries()) {
    if (view.buffer === asset.embeddedBufferIndex && !imageViewIndexes.has(viewIndex)) {
      view.byteOffset = shiftedOffset(
        view.byteOffset ?? 0,
        removedRanges,
        `${asset.filename} bufferView ${viewIndex}`,
      );
    }
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression?.buffer === asset.embeddedBufferIndex) {
      compression.byteOffset = shiftedOffset(
        compression.byteOffset ?? 0,
        removedRanges,
        `${asset.filename} Meshopt bufferView ${viewIndex}`,
      );
    }
  }

  if (externalUris) {
    for (const [imageIndex, image] of json.images.entries()) {
      delete image.bufferView;
      delete image.mimeType;
      delete image.uri;
      image.uri = externalUris[imageIndex];
    }
    const remappedIndexes = new Map();
    let nextViewIndex = 0;
    for (let oldViewIndex = 0; oldViewIndex < json.bufferViews.length; oldViewIndex += 1) {
      if (imageViewIndexes.has(oldViewIndex)) continue;
      remappedIndexes.set(oldViewIndex, nextViewIndex);
      nextViewIndex += 1;
    }
    const remapReferences = (value, label = "glTF") => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => remapReferences(entry, `${label}/${index}`));
        return;
      }
      for (const [key, entry] of Object.entries(value)) {
        if (key === "bufferView" && Number.isInteger(entry)) {
          assert.ok(
            remappedIndexes.has(entry),
            `${asset.filename} ${label}/bufferView still references removed image data`,
          );
          value[key] = remappedIndexes.get(entry);
        } else {
          remapReferences(entry, `${label}/${key}`);
        }
      }
    };
    json.bufferViews = json.bufferViews.filter((_, viewIndex) => !imageViewIndexes.has(viewIndex));
    remapReferences(json);
    return { json, binary };
  }

  for (const [imageIndex, payload] of payloads.entries()) {
    const padding = (4 - (binary.length % 4)) % 4;
    if (padding) binary = Buffer.concat([binary, Buffer.alloc(padding)]);
    const byteOffset = binary.length;
    binary = Buffer.concat([binary, payload]);
    let viewIndex = json.images[imageIndex].bufferView;
    if (viewIndex === undefined) {
      viewIndex = json.bufferViews.length;
      json.bufferViews.push({});
    }
    json.bufferViews[viewIndex] = {
      buffer: asset.embeddedBufferIndex,
      byteOffset,
      byteLength: payload.length,
    };
    const metadata = { ...json.images[imageIndex] };
    delete metadata.uri;
    delete metadata.mimeType;
    delete metadata.bufferView;
    json.images[imageIndex] = {
      ...metadata,
      bufferView: viewIndex,
      mimeType,
    };
  }

  return { json, binary };
}

function removeTextureExtension(texture, extension) {
  if (!texture.extensions?.[extension]) return;
  delete texture.extensions[extension];
  if (!Object.keys(texture.extensions).length) delete texture.extensions;
}

async function sourceImagePayload(asset, image) {
  let payload;
  let mimeType = image.mimeType;
  if (image.bufferView !== undefined) {
    payload = imagePayload(asset, image);
  } else {
    assert.ok(image.uri, `${asset.filename} image has no URI or bufferView`);
    if (image.uri.startsWith("data:")) {
      const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/u.exec(image.uri);
      assert.ok(match, `${asset.filename} has an invalid image data URI`);
      mimeType ??= match[1];
      payload = Buffer.from(match[2], image.uri.includes(";base64,") ? "base64" : "utf8");
    } else {
      const external = path.resolve(
        path.dirname(asset.filename),
        decodeURIComponent(image.uri.split("?")[0]),
      );
      payload = await readFile(external);
    }
  }
  if (!mimeType) {
    if (payload.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      mimeType = "image/png";
    } else if (
      payload.subarray(0, 4).toString("ascii") === "RIFF"
      && payload.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
      mimeType = "image/webp";
    }
  }
  assert.ok(["image/png", "image/webp", "image/jpeg"].includes(mimeType), `${asset.filename} uses unsupported ${mimeType}`);
  return { payload, mimeType };
}

async function makePngEncoderInput(asset) {
  const pngPayloads = [];
  for (const image of asset.json.images ?? []) {
    const { payload, mimeType } = await sourceImagePayload(asset, image);
    pngPayloads.push(
      mimeType === "image/png"
        ? payload
        : await sharp(payload).png({ compressionLevel: 9 }).toBuffer(),
    );
  }
  const rewritten = rewriteEmbeddedImages(asset, pngPayloads, "image/png");
  for (const [textureIndex, texture] of rewritten.json.textures.entries()) {
    const source = textureSource(texture);
    assert.ok(Number.isInteger(source), `${asset.filename} texture ${textureIndex} has no source`);
    texture.source = source;
    removeTextureExtension(texture, "EXT_texture_webp");
    removeTextureExtension(texture, "KHR_texture_basisu");
  }
  const remove = new Set(["EXT_texture_webp", "KHR_texture_basisu"]);
  rewritten.json.extensionsUsed = extensionList(rewritten.json.extensionsUsed, remove, []);
  rewritten.json.extensionsRequired = extensionList(rewritten.json.extensionsRequired, remove, []);
  return encodeGlb(rewritten.json, rewritten.binary, asset.embeddedBufferIndex);
}

function ktx2Metadata(payload, label) {
  assert.ok(payload.length >= 80, `${label} is too small to be KTX2`);
  assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE), `${label} has a wrong KTX2 signature`);
  assert.equal(payload.readUInt32LE(12), 0, `${label} must use a Basis Universal payload`);
  const supercompressionScheme = payload.readUInt32LE(44);
  const mode = supercompressionScheme === 1
    ? "ETC1S"
    : supercompressionScheme === 2
      ? "UASTC"
      : `unknown-${supercompressionScheme}`;
  assert.notEqual(mode.startsWith("unknown-"), true, `${label} uses unsupported KTX2 supercompression`);
  return {
    bytes: payload.length,
    width: payload.readUInt32LE(20),
    height: payload.readUInt32LE(24),
    levels: payload.readUInt32LE(40),
    supercompressionScheme,
    mode,
    sha256: sha256(payload),
  };
}

function expectedImageModes(json, policy) {
  if (policy === "uastc") return (json.images ?? []).map(() => "UASTC");
  const classes = (json.images ?? []).map(() => new Set());
  const add = (slot, textureClass) => {
    if (!slot) return;
    const texture = json.textures?.[slot.index];
    assert.ok(texture, `texture slot ${slot.index} is invalid`);
    const source = textureSource(texture);
    assert.ok(Number.isInteger(source), `texture slot ${slot.index} has no image source`);
    classes[source].add(textureClass);
  };
  for (const material of json.materials ?? []) {
    add(material.pbrMetallicRoughness?.baseColorTexture, "color");
    add(material.emissiveTexture, "color");
    add(material.normalTexture, "normal");
    add(material.pbrMetallicRoughness?.metallicRoughnessTexture, "attrib");
    add(material.occlusionTexture, "attrib");
  }
  return classes.map((imageClasses, imageIndex) => {
    assert.ok(imageClasses.size > 0, `theme image ${imageIndex} is not used by any PBR slot`);
    return imageClasses.has("normal") || imageClasses.has("attrib") ? "UASTC" : "ETC1S";
  });
}

function extractKtxPayloads(encodedAsset, sourceAsset, policy) {
  assert.equal(
    encodedAsset.json.images?.length,
    sourceAsset.json.images?.length,
    `${sourceAsset.filename} image count changed during KTX2 encoding`,
  );
  assert.equal(
    encodedAsset.json.textures?.length,
    sourceAsset.json.textures?.length,
    `${sourceAsset.filename} texture count changed during KTX2 encoding`,
  );
  const expectedModes = expectedImageModes(sourceAsset.json, policy);
  const byName = new Map();
  for (const [imageIndex, image] of encodedAsset.json.images.entries()) {
    assert.ok(image.name, `${sourceAsset.filename} encoded image ${imageIndex} lost its name`);
    assert.equal(byName.has(image.name), false, `${sourceAsset.filename} has duplicate image name ${image.name}`);
    assert.equal(image.mimeType, "image/ktx2", `${sourceAsset.filename} ${image.name} was not encoded to KTX2`);
    const payload = Buffer.from(imagePayload(encodedAsset, image));
    byName.set(image.name, payload);
  }
  const payloads = [];
  const metadata = [];
  for (const [imageIndex, image] of sourceAsset.json.images.entries()) {
    assert.ok(image.name, `${sourceAsset.filename} source image ${imageIndex} has no stable name`);
    const payload = byName.get(image.name);
    assert.ok(payload, `${sourceAsset.filename} encoded output lost ${image.name}`);
    const details = ktx2Metadata(payload, `${sourceAsset.filename} ${image.name}`);
    assert.equal(
      details.mode,
      expectedModes[imageIndex],
      `${sourceAsset.filename} ${image.name} used the wrong Basis mode`,
    );
    payloads.push(payload);
    metadata.push({
      name: image.name,
      expectedMode: expectedModes[imageIndex],
      ...details,
    });
  }
  for (const [textureIndex, texture] of encodedAsset.json.textures.entries()) {
    assert.ok(
      Number.isInteger(texture.extensions?.KHR_texture_basisu?.source),
      `${sourceAsset.filename} encoded texture ${textureIndex} has no KHR_texture_basisu source`,
    );
  }
  return { payloads, metadata };
}

function makeFinalKtxAsset(sourceAsset, payloads, externalUris = null) {
  const rewritten = rewriteEmbeddedImages(
    sourceAsset,
    payloads,
    "image/ktx2",
    externalUris,
  );
  for (const [textureIndex, texture] of rewritten.json.textures.entries()) {
    const source = textureSource(texture);
    assert.ok(Number.isInteger(source), `${sourceAsset.filename} texture ${textureIndex} has no source`);
    delete texture.source;
    removeTextureExtension(texture, "EXT_texture_webp");
    texture.extensions ??= {};
    texture.extensions.KHR_texture_basisu = { source };
  }
  const remove = new Set(["EXT_texture_webp"]);
  rewritten.json.extensionsUsed = extensionList(
    rewritten.json.extensionsUsed,
    remove,
    ["KHR_texture_basisu"],
  );
  rewritten.json.extensionsRequired = extensionList(
    rewritten.json.extensionsRequired,
    remove,
    ["KHR_texture_basisu"],
  );
  return encodeGlb(rewritten.json, rewritten.binary, sourceAsset.embeddedBufferIndex);
}

function invariantSnapshot(json) {
  const invariantJson = structuredClone(json);
  delete invariantJson.asset;
  delete invariantJson.buffers;
  delete invariantJson.bufferViews;
  delete invariantJson.images;
  delete invariantJson.textures;
  delete invariantJson.extensionsUsed;
  delete invariantJson.extensionsRequired;
  for (const accessor of invariantJson.accessors ?? []) {
    // BufferView indexes and byte offsets describe binary packing, not the
    // authored accessor contract. Externalizing embedded theme images
    // necessarily renumbers those views while count/type/bounds stay exact.
    delete accessor.bufferView;
    delete accessor.byteOffset;
  }
  const signature = (values) => ({
    count: values.length,
    sha256: sha256(Buffer.from(JSON.stringify(values))),
  });
  return {
    nodes: signature((json.nodes ?? []).map((node) => node.name ?? null)),
    meshes: signature((json.meshes ?? []).map((mesh) => mesh.name ?? null)),
    materials: signature((json.materials ?? []).map((material) => material.name ?? null)),
    animations: signature((json.animations ?? []).map((animation) => animation.name ?? null)),
    skinJoints: signature((json.skins ?? []).map((skin) => (
      skin.joints.map((nodeIndex) => json.nodes[nodeIndex]?.name ?? `#${nodeIndex}`)
    ))),
    semanticJsonSha256: sha256(Buffer.from(JSON.stringify(invariantJson))),
  };
}

function mipTexelCount({ width, height, levels }) {
  let total = 0;
  for (let level = 0; level < levels; level += 1) {
    total += Math.max(1, width >> level) * Math.max(1, height >> level);
  }
  return total;
}

function validateFinal(sourceAsset, finalAsset, policy, payloads, externalUris = null) {
  assert.deepEqual(
    invariantSnapshot(finalAsset.json),
    invariantSnapshot(sourceAsset.json),
    `${sourceAsset.filename} semantic hierarchy changed during texture transcode`,
  );
  assert.ok(finalAsset.json.extensionsUsed?.includes("KHR_texture_basisu"));
  assert.ok(finalAsset.json.extensionsRequired?.includes("KHR_texture_basisu"));
  assert.equal(finalAsset.json.extensionsUsed?.includes("EXT_texture_webp"), false);
  assert.equal(finalAsset.json.extensionsRequired?.includes("EXT_texture_webp"), false);
  const expectedModes = expectedImageModes(sourceAsset.json, policy);
  assert.equal(finalAsset.json.images.length, expectedModes.length);
  for (const [imageIndex, image] of finalAsset.json.images.entries()) {
    if (externalUris) {
      assert.equal(image.mimeType, undefined);
      assert.equal(image.bufferView, undefined);
      assert.equal(image.uri, externalUris[imageIndex]);
    } else {
      assert.equal(image.mimeType, "image/ktx2");
      assert.equal(image.uri, undefined);
      assert.notEqual(image.bufferView, undefined);
    }
    const details = ktx2Metadata(payloads[imageIndex], `${sourceAsset.filename} final image ${imageIndex}`);
    assert.equal(details.mode, expectedModes[imageIndex]);
  }
  for (const [textureIndex, texture] of finalAsset.json.textures.entries()) {
    assert.equal(texture.source, undefined);
    const source = texture.extensions?.KHR_texture_basisu?.source;
    assert.ok(Number.isInteger(source), `${sourceAsset.filename} texture ${textureIndex} lost KTX2`);
    assert.ok(source >= 0 && source < finalAsset.json.images.length);
  }
}

async function verifyTool(gltfpack) {
  await access(gltfpack);
  const result = spawnSync(gltfpack, ["-v"], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "gltfpack -v failed");
  const version = result.stdout.trim();
  assert.equal(version, "gltfpack 1.2", `Expected native gltfpack 1.2, received ${version}`);
  return version;
}

function runGltfpack(gltfpack, input, output, policy) {
  const args = ["-i", input, "-o", output, ...(policy === "uastc" ? UASTC_ARGUMENTS : THEME_ARGUMENTS)];
  const result = spawnSync(gltfpack, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `gltfpack failed for ${input}`);
  }
}

function relativeReportPath(filename) {
  return path.relative(ROOT, filename).split(path.sep).join("/");
}

function sharedThemeTexturePath(textureSha256) {
  assert.match(textureSha256, /^[a-f0-9]{64}$/u, `Unsafe shared texture hash: ${textureSha256}`);
  return path.posix.join(
    "models",
    "environment",
    "SharedTexturesKTX2",
    `${textureSha256}.ktx2`,
  );
}

async function build(options) {
  const toolVersion = await verifyTool(options.gltfpack);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "chasing-runtime-ktx2-"));
  const stagedOutputs = [];
  const entries = [];
  const sharedTextures = new Map();
  try {
    for (const [targetIndex, target] of TARGETS.entries()) {
      const sourceFilename = path.join(options.sourceRoot, target.relative);
      const outputFilename = path.join(options.outputRoot, target.relative);
      const sourceAsset = await loadGlb(sourceFilename);
      assert.equal(
        sourceAsset.json.extensionsRequired?.includes("KHR_texture_basisu"),
        false,
        `${sourceFilename} is already KTX2; use --check or supply a pristine source root`,
      );
      const sourceInfo = await stat(sourceFilename);
      const encoderInput = path.join(temporaryRoot, `${targetIndex}-source.glb`);
      const encoderOutput = path.join(temporaryRoot, `${targetIndex}-encoded.glb`);
      await writeFile(encoderInput, await makePngEncoderInput(sourceAsset));
      runGltfpack(options.gltfpack, encoderInput, encoderOutput, target.policy);
      const encodedAsset = await loadGlb(encoderOutput);
      const { payloads, metadata } = extractKtxPayloads(encodedAsset, sourceAsset, target.policy);
      const externalUris = target.policy === "theme-mixed"
        ? metadata.map((texture, imageIndex) => {
          const relativeTexturePath = sharedThemeTexturePath(texture.sha256);
          const existing = sharedTextures.get(relativeTexturePath);
          if (existing) {
            assert.equal(existing.metadata.sha256, texture.sha256, `${texture.name} content drifted across themes`);
            assert.equal(existing.metadata.expectedMode, texture.expectedMode, `${texture.name} mode drifted across themes`);
            existing.sourceNames.add(texture.name);
          } else {
            sharedTextures.set(relativeTexturePath, {
              payload: payloads[imageIndex],
              metadata: texture,
              sourceNames: new Set([texture.name]),
            });
          }
          const uri = path.posix.relative(path.posix.dirname(target.relative), relativeTexturePath);
          texture.uri = uri;
          return uri;
        })
        : null;
      const finalBuffer = makeFinalKtxAsset(sourceAsset, payloads, externalUris);
      const finalAsset = readGlb(finalBuffer, outputFilename);
      validateFinal(sourceAsset, finalAsset, target.policy, payloads, externalUris);
      const outputDirectory = path.dirname(outputFilename);
      await mkdir(outputDirectory, { recursive: true });
      const stagedFilename = path.join(
        outputDirectory,
        `.${path.basename(outputFilename)}.ktx2-${process.pid}-${targetIndex}`,
      );
      await writeFile(stagedFilename, finalBuffer);
      stagedOutputs.push({ stagedFilename, outputFilename });
      const sourceImageBytes = (sourceAsset.json.images ?? []).reduce((total, image) => (
        total + (image.bufferView === undefined
          ? 0
          : sourceAsset.json.bufferViews[image.bufferView].byteLength)
      ), 0);
      const outputImageBytes = metadata.reduce((total, image) => total + image.bytes, 0);
      const decodedGpuBytesBefore = metadata.reduce(
        (total, image) => total + mipTexelCount(image) * 4,
        0,
      );
      const estimatedGpuBytesAfter = metadata.reduce(
        (total, image) => total + mipTexelCount(image),
        0,
      );
      entries.push({
        path: relativeReportPath(outputFilename),
        policy: target.policy,
        arguments: target.policy === "uastc" ? UASTC_ARGUMENTS : THEME_ARGUMENTS,
        source: {
          bytes: sourceInfo.size,
          sha256: sha256(sourceAsset.buffer),
          embeddedImageBytes: sourceImageBytes,
        },
        output: {
          bytes: finalBuffer.length,
          sha256: sha256(finalBuffer),
          embeddedImageBytes: externalUris ? 0 : outputImageBytes,
          externalTextureBytes: externalUris ? outputImageBytes : 0,
          uncachedFirstLoadBytes: finalBuffer.length + (externalUris ? outputImageBytes : 0),
          savedBytes: sourceInfo.size - finalBuffer.length,
          savedPercent: Number(((1 - finalBuffer.length / sourceInfo.size) * 100).toFixed(3)),
        },
        gpuUploadEstimate: {
          decodedRgbaBytesBefore: decodedGpuBytesBefore,
          blockCompressedBytesAfter: estimatedGpuBytesAfter,
          savedBytes: decodedGpuBytesBefore - estimatedGpuBytesAfter,
          savedPercent: 75,
        },
        structure: invariantSnapshot(sourceAsset.json),
        textures: metadata,
      });
    }

    const sharedTextureEntries = [];
    for (const [relativeTexturePath, texture] of [...sharedTextures.entries()].sort()) {
      const outputFilename = path.join(options.outputRoot, relativeTexturePath);
      await mkdir(path.dirname(outputFilename), { recursive: true });
      const stagedFilename = path.join(
        path.dirname(outputFilename),
        `.${path.basename(outputFilename)}.ktx2-${process.pid}`,
      );
      await writeFile(stagedFilename, texture.payload);
      stagedOutputs.push({ stagedFilename, outputFilename });
      sharedTextureEntries.push({
        path: relativeReportPath(outputFilename),
        sourceNames: [...texture.sourceNames].sort(),
        bytes: texture.payload.length,
        sha256: texture.metadata.sha256,
        mode: texture.metadata.expectedMode,
        width: texture.metadata.width,
        height: texture.metadata.height,
        levels: texture.metadata.levels,
      });
    }

    const sourceAssetBytes = entries.reduce((total, entry) => total + entry.source.bytes, 0);
    const outputAssetBytes = entries.reduce((total, entry) => total + entry.output.bytes, 0);
    const sharedTextureBytes = sharedTextureEntries.reduce((total, entry) => total + entry.bytes, 0);
    const uncachedAllThemesBytes = entries.reduce(
      (total, entry) => total + entry.output.uncachedFirstLoadBytes,
      0,
    );
    const deploymentBytes = outputAssetBytes + sharedTextureBytes;
    const report = {
      formatVersion: FORMAT_VERSION,
      generatedAt: new Date().toISOString(),
      policy: {
        geometryRepacked: false,
        semanticHierarchyByteStable: true,
        characterTextures: "UASTC quality 10 with Zstandard supercompression",
        themeColorTextures: "ETC1S quality 10 with BasisLZ supercompression",
        themeNormalAndAttributeTextures: "UASTC quality 10 with Zstandard supercompression",
        themeTextureStorage: "External SHA-256-addressed KTX2 payloads shared across all four theme packages.",
        lockerTextures: "Retain the existing shared external PNG contract; no duplicate KTX2 payload.",
        sourceTextureFallbacks: false,
        cumulativeRepacking: false,
      },
      tool: {
        name: "gltfpack",
        version: toolVersion,
        nativeBinaryCommitted: false,
        encoderInput: "Pinned Sharp 0.35.0 converts legacy WebP sources to temporary PNG only.",
      },
      totals: {
        sourceAssetBytes,
        outputAssetBytes,
        sharedTextureBytes,
        deploymentBytes,
        uncachedAllThemesBytes,
        deduplicatedBytes: uncachedAllThemesBytes - deploymentBytes,
        savedBytes: sourceAssetBytes - deploymentBytes,
        savedPercent: Number(((1 - deploymentBytes / sourceAssetBytes) * 100).toFixed(3)),
      },
      sharedTextures: sharedTextureEntries,
      assets: entries,
    };
    await mkdir(path.dirname(options.report), { recursive: true });
    const stagedReport = `${options.report}.ktx2-${process.pid}`;
    await writeFile(stagedReport, `${JSON.stringify(report, null, 2)}\n`);
    stagedOutputs.push({ stagedFilename: stagedReport, outputFilename: options.report });

    // Every target has passed structural and texture-mode validation before
    // any production path is replaced.
    for (const { stagedFilename, outputFilename } of stagedOutputs) {
      await rename(stagedFilename, outputFilename);
    }
    const sharedDirectory = path.join(
      options.outputRoot,
      "models",
      "environment",
      "SharedTexturesKTX2",
    );
    const retainedSharedFiles = new Set(
      sharedTextureEntries.map((entry) => path.basename(entry.path)),
    );
    for (const directoryEntry of await readdir(sharedDirectory, { withFileTypes: true })) {
      if (
        directoryEntry.isFile()
        && directoryEntry.name.endsWith(".ktx2")
        && !retainedSharedFiles.has(directoryEntry.name)
      ) {
        await rm(path.join(sharedDirectory, directoryEntry.name));
      }
    }
    console.log(JSON.stringify({
      totals: report.totals,
      assets: report.assets.map((entry) => ({
        path: entry.path,
        sourceBytes: entry.source.bytes,
        outputBytes: entry.output.bytes,
        gpuSavedPercent: entry.gpuUploadEstimate.savedPercent,
      })),
    }, null, 2));
  } catch (error) {
    await Promise.all(stagedOutputs.map(({ stagedFilename }) => rm(stagedFilename, { force: true })));
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function check(options) {
  const report = JSON.parse(await readFile(options.report, "utf8"));
  assert.equal(report.formatVersion, FORMAT_VERSION);
  assert.equal(report.assets.length, TARGETS.length);
  assert.deepEqual(
    report.assets.map((entry) => entry.path),
    TARGETS.map((target) => relativeReportPath(path.join(options.outputRoot, target.relative))),
  );
  const referencedSharedTextures = new Set();
  for (const [targetIndex, target] of TARGETS.entries()) {
    const entry = report.assets[targetIndex];
    const filename = path.join(options.outputRoot, target.relative);
    const buffer = await readFile(filename);
    assert.equal(buffer.length, entry.output.bytes, `${entry.path} byte count drifted`);
    assert.equal(sha256(buffer), entry.output.sha256, `${entry.path} SHA-256 drifted`);
    const asset = readGlb(buffer, filename);
    assert.deepEqual(invariantSnapshot(asset.json), entry.structure, `${entry.path} structure drifted`);
    assert.ok(asset.json.extensionsRequired?.includes("KHR_texture_basisu"));
    for (const [imageIndex, image] of asset.json.images.entries()) {
      let payload;
      if (image.bufferView !== undefined) {
        assert.equal(image.uri, undefined);
        payload = imagePayload(asset, image);
      } else {
        assert.ok(image.uri?.endsWith(".ktx2"), `${entry.path} image ${imageIndex} has no KTX2 URI`);
        const resolved = path.resolve(path.dirname(filename), decodeURIComponent(image.uri));
        const relative = path.relative(options.outputRoot, resolved);
        assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
        payload = await readFile(resolved);
        referencedSharedTextures.add(relativeReportPath(resolved));
      }
      const metadata = ktx2Metadata(payload, `${entry.path} image ${imageIndex}`);
      assert.equal(metadata.mode, entry.textures[imageIndex].expectedMode);
      assert.equal(metadata.sha256, entry.textures[imageIndex].sha256);
      assert.equal(metadata.bytes, entry.textures[imageIndex].bytes);
    }
  }
  assert.deepEqual(
    [...referencedSharedTextures].sort(),
    report.sharedTextures.map((entry) => entry.path).sort(),
    "shared KTX2 report and theme URIs drifted",
  );
  for (const texture of report.sharedTextures) {
    const buffer = await readFile(path.join(ROOT, texture.path));
    assert.equal(buffer.length, texture.bytes);
    assert.equal(sha256(buffer), texture.sha256);
  }
  const sharedDirectory = path.join(
    options.outputRoot,
    "models",
    "environment",
    "SharedTexturesKTX2",
  );
  const shippedSharedTextures = (await readdir(sharedDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ktx2"))
    .map((entry) => relativeReportPath(path.join(sharedDirectory, entry.name)))
    .sort();
  assert.deepEqual(
    shippedSharedTextures,
    report.sharedTextures.map((entry) => entry.path).sort(),
    "shared texture directory contains stale immutable payloads",
  );
  const sourceAssetBytes = report.assets.reduce((total, entry) => total + entry.source.bytes, 0);
  const outputAssetBytes = report.assets.reduce((total, entry) => total + entry.output.bytes, 0);
  const sharedTextureBytes = report.sharedTextures.reduce((total, entry) => total + entry.bytes, 0);
  const uncachedAllThemesBytes = report.assets.reduce(
    (total, entry) => total + entry.output.uncachedFirstLoadBytes,
    0,
  );
  assert.equal(report.totals.sourceAssetBytes, sourceAssetBytes);
  assert.equal(report.totals.outputAssetBytes, outputAssetBytes);
  assert.equal(report.totals.sharedTextureBytes, sharedTextureBytes);
  assert.equal(report.totals.deploymentBytes, outputAssetBytes + sharedTextureBytes);
  assert.equal(report.totals.uncachedAllThemesBytes, uncachedAllThemesBytes);
  assert.equal(
    report.totals.deduplicatedBytes,
    uncachedAllThemesBytes - report.totals.deploymentBytes,
  );
  assert.equal(report.totals.savedBytes, sourceAssetBytes - report.totals.deploymentBytes);
  console.log(
    `Validated ${report.assets.length} KTX2 runtime assets and ${report.sharedTextures.length} shared textures.`,
  );
}

const options = parseArguments(process.argv.slice(2));
if (options.check) await check(options);
else await build(options);
