#!/usr/bin/env node

/**
 * Builds the first-paint character derivatives without touching their
 * approved reference models. Geometry, skinning and animation transport are
 * copied byte-for-byte from each role's declared reference; only embedded
 * KTX2 surfaces are replaced.
 *
 * The identity-bearing player base colour uses block-accurate UASTC at
 * 512 px; lower-entropy colour surfaces use ETC1S after passing the browser
 * pixel gate. Tangent-space normal and packed ORM remain block-accurate UASTC
 * at 512 px. This is deliberately a camera-scale texture derivative, not a
 * replacement art master.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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
import vm from "node:vm";
import sharp from "sharp";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FORMAT_VERSION = 2;
export const DEFAULT_CHARACTER_DIRECTORY = path.join(
  ROOT,
  "public",
  "models",
  "characters",
);
export const DEFAULT_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "character-bootstrap.json",
);
export const DETAIL_SIZE = 512;
export const COMBINED_MAX_BYTES = 5 * 1024 * 1024;

const GLTFPACK_BASE_ARGUMENTS = Object.freeze([
  "-c",
  "-kn",
  "-km",
  "-ke",
  "-si",
  "1",
  "-af",
  "0",
  "-at",
  "24",
  "-ar",
  "16",
  "-as",
  "24",
]);

export const CHARACTER_BOOTSTRAP_CONTRACTS = Object.freeze({
  kid: Object.freeze({
    label: "Kid",
    referenceVariant: "lod1",
    textureSource: "artSourcePng",
    baseColorSize: 512,
    baseColorMode: "UASTC",
    baseColorPolicy: "512px UASTC quality 10",
    textureCount: 3,
    maxBytes: Math.floor(1.6 * 1024 * 1024),
    clips: Object.freeze([
      "Caught",
      "EscapeCelebrate",
      "HideEnter",
      "HideExit",
      "HideIdle",
      "HidePeek",
      "Idle",
      "Interact",
      "Run",
      "TurnLeft",
      "TurnRight",
      "Walk",
    ]),
  }),
  villain: Object.freeze({
    label: "Villain",
    referenceVariant: "lod1",
    textureSource: "artSourcePng",
    baseColorSize: 1024,
    baseColorMode: "ETC1S",
    baseColorPolicy: "1024px ETC1S quality 10",
    textureCount: 3,
    maxBytes: Math.floor(1.6 * 1024 * 1024),
    clips: Object.freeze([
      "Alert",
      "Catch",
      "CheckHide",
      "Idle",
      "LostSight",
      "PatrolWalk",
      "Run",
      "Search",
    ]),
  }),
  police: Object.freeze({
    label: "Police",
    referenceVariant: "original",
    textureSource: "embeddedKtx2",
    baseColorSize: 1024,
    baseColorMode: "ETC1S",
    baseColorPolicy: "skin 1024px; uniform and trouser 512px; ETC1S quality 10",
    textureCount: 7,
    textureSizeOverrides: Object.freeze({
      Police_v22_Uniform_BaseColor_768: 512,
      Police_v22_Trouser_BaseColor_768: 512,
    }),
    maxBytes: 2 * 1024 * 1024,
    clips: Object.freeze([
      "Alert",
      "Idle",
      "Interact",
      "Resolve",
      "Run",
    ]),
  }),
});

export const GLTFPACK_ARGUMENTS = Object.freeze(
  Object.fromEntries(
    Object.entries(CHARACTER_BOOTSTRAP_CONTRACTS).map(([role, contract]) => [
      role,
      Object.freeze([
        ...GLTFPACK_BASE_ARGUMENTS,
        ...(contract.baseColorMode === "UASTC"
          ? ["-tu", "color,normal,attrib", "-tq", "color,normal,attrib", "10"]
          : [
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
          ]),
        "-tj",
        "4",
      ]),
    ]),
  ),
);

const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const BASIS_DIRECTORY = path.join(
  ROOT,
  "node_modules",
  "three",
  "examples",
  "jsm",
  "libs",
  "basis",
);
const BASIS_RGBA32 = 13;
const require = createRequire(import.meta.url);
let basisModulePromise;

function parseArguments(argv) {
  const options = {
    check: false,
    sourceDirectory: DEFAULT_CHARACTER_DIRECTORY,
    outputDirectory: DEFAULT_CHARACTER_DIRECTORY,
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
    if (argument === "--source-dir") options.sourceDirectory = path.resolve(value);
    else if (argument === "--output-dir") options.outputDirectory = path.resolve(value);
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

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function relativePath(filename) {
  return path.relative(ROOT, filename).split(path.sep).join("/");
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
    assert.ok(end <= buffer.length, `${filename} has a truncated GLB chunk`);
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
  assert.ok(embeddedBufferIndex >= 0, `${filename} has no embedded physical buffer`);
  const logicalLength = json.buffers[embeddedBufferIndex].byteLength;
  assert.ok(logicalLength <= binary.length, `${filename} declares an oversized BIN payload`);
  return {
    filename,
    buffer,
    json,
    binary: binary.subarray(0, logicalLength),
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

function textureClasses(asset) {
  const classes = new Map();
  const mark = (textureInfo, textureClass) => {
    if (!Number.isInteger(textureInfo?.index)) return;
    const texture = asset.json.textures?.[textureInfo.index];
    assert.ok(texture, `${asset.filename} references missing texture ${textureInfo.index}`);
    const imageIndex = textureSource(texture);
    assert.ok(Number.isInteger(imageIndex), `${asset.filename} texture has no image source`);
    const existing = classes.get(imageIndex);
    assert.ok(
      existing === undefined || existing === textureClass,
      `${asset.filename} image ${imageIndex} is shared by ${existing} and ${textureClass}`,
    );
    classes.set(imageIndex, textureClass);
  };
  for (const material of asset.json.materials ?? []) {
    mark(material.pbrMetallicRoughness?.baseColorTexture, "baseColor");
    mark(material.normalTexture, "normal");
    mark(material.occlusionTexture, "orm");
    mark(material.pbrMetallicRoughness?.metallicRoughnessTexture, "orm");
  }
  for (const imageIndex of (asset.json.images ?? []).keys()) {
    assert.ok(classes.has(imageIndex), `${asset.filename} image ${imageIndex} has no PBR role`);
  }
  return classes;
}

function expectedTextureSize(role, imageName, textureClass) {
  const contract = CHARACTER_BOOTSTRAP_CONTRACTS[role];
  return contract.textureSizeOverrides?.[imageName]
    ?? (textureClass === "baseColor" ? contract.baseColorSize : DETAIL_SIZE);
}

async function loadBasisModule() {
  if (!basisModulePromise) {
    basisModulePromise = (async () => {
      const sourceFilename = path.join(BASIS_DIRECTORY, "basis_transcoder.js");
      const wasmFilename = path.join(BASIS_DIRECTORY, "basis_transcoder.wasm");
      const [source, wasmBinary] = await Promise.all([
        readFile(sourceFilename, "utf8"),
        readFile(wasmFilename),
      ]);
      const commonJsModule = { exports: {} };
      vm.runInNewContext(
        source,
        {
          module: commonJsModule,
          exports: commonJsModule.exports,
          require,
          __dirname: BASIS_DIRECTORY,
          __filename: sourceFilename,
          process,
          console,
          WebAssembly,
          Promise,
          Buffer,
          Uint8Array,
          Uint16Array,
          Uint32Array,
          Int8Array,
          Int16Array,
          Int32Array,
          Float32Array,
          Float64Array,
          ArrayBuffer,
          TextDecoder,
          URL,
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval,
        },
        { filename: sourceFilename },
      );
      const basis = await commonJsModule.exports({ wasmBinary });
      basis.initializeBasis();
      assert.ok(basis.KTX2File, "Three.js Basis transcoder has no KTX2File support");
      return basis;
    })();
  }
  return basisModulePromise;
}

async function decodedKtx2Png(payload, size, label) {
  const basis = await loadBasisModule();
  const ktx2 = new basis.KTX2File(new Uint8Array(payload));
  try {
    assert.ok(ktx2.isValid(), `${label} is not a valid Basis KTX2 image`);
    assert.ok(ktx2.getWidth() > 0 && ktx2.getHeight() > 0, `${label} has no pixels`);
    assert.ok(ktx2.startTranscoding(), `${label} could not start Basis transcoding`);
    const rgba = new Uint8Array(
      ktx2.getImageTranscodedSizeInBytes(0, 0, 0, BASIS_RGBA32),
    );
    assert.equal(
      ktx2.transcodeImage(rgba, 0, 0, 0, BASIS_RGBA32, 0, -1, -1),
      1,
      `${label} could not transcode to RGBA32`,
    );
    assert.equal(
      rgba.length,
      ktx2.getWidth() * ktx2.getHeight() * 4,
      `${label} RGBA32 payload has the wrong size`,
    );
    return sharp(Buffer.from(rgba), {
      raw: {
        width: ktx2.getWidth(),
        height: ktx2.getHeight(),
        channels: 4,
      },
    })
      .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } finally {
    ktx2.close();
    ktx2.delete();
  }
}

function imagePayload(asset, image) {
  assert.equal(image.uri, undefined, `${asset.filename} must embed character surfaces`);
  assert.notEqual(image.bufferView, undefined, `${asset.filename} image has no payload`);
  const view = asset.json.bufferViews[image.bufferView];
  assert.equal(
    view.buffer,
    asset.embeddedBufferIndex,
    `${asset.filename} image is not in the physical buffer`,
  );
  const start = view.byteOffset ?? 0;
  const end = start + view.byteLength;
  assert.ok(end <= asset.binary.length, `${asset.filename} image exceeds BIN`);
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
    assert.ok(offset <= range.start, `${label} starts inside a removed image`);
    break;
  }
  return offset - removedBytes;
}

function rewriteEmbeddedImages(asset, payloads, mimeType) {
  assert.equal(payloads.length, asset.json.images?.length ?? 0);
  const json = structuredClone(asset.json);
  const imageViewIndexes = new Set();
  const removedRanges = [];
  for (const image of json.images ?? []) {
    assert.notEqual(image.bufferView, undefined, `${asset.filename} image must be embedded`);
    assert.equal(
      imageViewIndexes.has(image.bufferView),
      false,
      `${asset.filename} shares one bufferView across character images`,
    );
    imageViewIndexes.add(image.bufferView);
    const view = json.bufferViews[image.bufferView];
    assert.equal(view.buffer, asset.embeddedBufferIndex);
    removedRanges.push({
      start: view.byteOffset ?? 0,
      end: (view.byteOffset ?? 0) + view.byteLength,
    });
  }
  removedRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < removedRanges.length; index += 1) {
    assert.ok(removedRanges[index - 1].end <= removedRanges[index].start);
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
        `${asset.filename} image overlaps bufferView ${viewIndex}`,
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
        `${asset.filename} image overlaps Meshopt view ${viewIndex}`,
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
        `${asset.filename}/bufferView/${viewIndex}`,
      );
    }
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression?.buffer === asset.embeddedBufferIndex) {
      compression.byteOffset = shiftedOffset(
        compression.byteOffset ?? 0,
        removedRanges,
        `${asset.filename}/meshopt/${viewIndex}`,
      );
    }
  }
  for (const [imageIndex, payload] of payloads.entries()) {
    const padding = (4 - (binary.length % 4)) % 4;
    if (padding) binary = Buffer.concat([binary, Buffer.alloc(padding)]);
    const byteOffset = binary.length;
    binary = Buffer.concat([binary, payload]);
    const viewIndex = json.images[imageIndex].bufferView;
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

function makePngEncoderInput(asset, pngPayloads) {
  const rewritten = rewriteEmbeddedImages(asset, pngPayloads, "image/png");
  for (const [textureIndex, texture] of rewritten.json.textures.entries()) {
    const source = textureSource(texture);
    assert.ok(Number.isInteger(source), `${asset.filename} texture ${textureIndex} has no source`);
    texture.source = source;
    removeTextureExtension(texture, "KHR_texture_basisu");
    removeTextureExtension(texture, "EXT_texture_webp");
  }
  const remove = new Set(["KHR_texture_basisu", "EXT_texture_webp"]);
  rewritten.json.extensionsUsed = extensionList(rewritten.json.extensionsUsed, remove, []);
  rewritten.json.extensionsRequired = extensionList(rewritten.json.extensionsRequired, remove, []);
  return encodeGlb(rewritten.json, rewritten.binary, asset.embeddedBufferIndex);
}

function makeFinalAsset(asset, payloads) {
  const rewritten = rewriteEmbeddedImages(asset, payloads, "image/ktx2");
  return encodeGlb(rewritten.json, rewritten.binary, asset.embeddedBufferIndex);
}

function roleTexturePaths(role) {
  const { label } = CHARACTER_BOOTSTRAP_CONTRACTS[role];
  const root = path.join(
    ROOT,
    "art-source",
    "Characters",
    label,
    "ReferenceStandard",
    "PrecisionRemodel_2026_07_13_v21",
  );
  const directory = path.join(root, "Textures");
  const prefix = `Char_${label}_PrecisionRemodel_v21`;
  return {
    baseColor: path.join(root, "Rigged", "Textures", `${prefix}_BaseColor_2K.png`),
    normal: path.join(directory, `${prefix}_Normal_2K.png`),
    ao: path.join(directory, `${prefix}_AO_2K.png`),
    metallicSmoothness: path.join(directory, `${prefix}_MetallicSmoothness_2K.png`),
  };
}

function referenceFilename(role, directory) {
  const { referenceVariant } = CHARACTER_BOOTSTRAP_CONTRACTS[role];
  assert.ok(
    referenceVariant === "lod1" || referenceVariant === "original",
    `${role} has an unsupported reference variant ${referenceVariant}`,
  );
  return path.join(
    directory,
    referenceVariant === "lod1" ? `${role}-lod1.glb` : `${role}.glb`,
  );
}

async function resizedPng(filename, size) {
  return sharp(filename)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function buildOrmPng(aoFilename, metallicSmoothnessFilename, size) {
  const [
    { data: ao, info: aoInfo },
    { data: metallicSmoothness, info: msInfo },
  ] = await Promise.all([
    sharp(aoFilename)
      .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(metallicSmoothnessFilename)
      .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  assert.deepEqual(
    [aoInfo.width, aoInfo.height, aoInfo.channels],
    [size, size, 4],
  );
  assert.deepEqual(
    [msInfo.width, msInfo.height, msInfo.channels],
    [size, size, 4],
  );
  const orm = Buffer.alloc(size * size * 4);
  for (let pixel = 0; pixel < size * size; pixel += 1) {
    const offset = pixel * 4;
    orm[offset] = ao[offset];
    orm[offset + 1] = Math.max(10, 255 - metallicSmoothness[offset + 3]);
    orm[offset + 2] = metallicSmoothness[offset];
    orm[offset + 3] = 255;
  }
  return sharp(orm, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}

async function artSourceTextureDerivatives(role, asset) {
  const sourcePaths = roleTexturePaths(role);
  const sourceBuffers = Object.fromEntries(
    await Promise.all(
      Object.entries(sourcePaths).map(async ([name, filename]) => [
        name,
        await readFile(filename),
      ]),
    ),
  );
  const [baseColor, normal, orm] = await Promise.all([
    resizedPng(
      sourcePaths.baseColor,
      CHARACTER_BOOTSTRAP_CONTRACTS[role].baseColorSize,
    ),
    resizedPng(sourcePaths.normal, DETAIL_SIZE),
    buildOrmPng(sourcePaths.ao, sourcePaths.metallicSmoothness, DETAIL_SIZE),
  ]);
  const payloadByClass = { baseColor, normal, orm };
  const payloads = [];
  const derivatives = [];
  const classes = textureClasses(asset);
  for (const [imageIndex, image] of (asset.json.images ?? []).entries()) {
    assert.ok(image.name, `${asset.filename} image has no stable name`);
    const textureClass = classes.get(imageIndex);
    const payload = payloadByClass[textureClass];
    assert.ok(payload, `${asset.filename} has an unexpected image ${image.name}`);
    payloads.push(payload);
    const metadata = await sharp(payload).metadata();
    derivatives.push({
      name: image.name,
      textureClass,
      width: metadata.width,
      height: metadata.height,
      pngBytes: payload.length,
      pngSha256: sha256(payload),
    });
  }
  return {
    payloads,
    derivatives,
    sources: Object.entries(sourcePaths).map(([name, filename]) => ({
      name,
      path: relativePath(filename),
      bytes: sourceBuffers[name].length,
      sha256: sha256(sourceBuffers[name]),
    })),
  };
}

async function embeddedTextureDerivatives(role, asset) {
  const classes = textureClasses(asset);
  const payloads = [];
  const derivatives = [];
  const sources = [];
  for (const [imageIndex, image] of (asset.json.images ?? []).entries()) {
    assert.ok(image.name, `${asset.filename} image has no stable name`);
    const textureClass = classes.get(imageIndex);
    const size = expectedTextureSize(role, image.name, textureClass);
    const sourcePayload = Buffer.from(imagePayload(asset, image));
    const sourceMetadata = ktx2Metadata(
      sourcePayload,
      `${asset.filename}/${image.name}`,
    );
    const payload = await decodedKtx2Png(
      sourcePayload,
      size,
      `${asset.filename}/${image.name}`,
    );
    const metadata = await sharp(payload).metadata();
    payloads.push(payload);
    derivatives.push({
      name: image.name,
      textureClass,
      width: metadata.width,
      height: metadata.height,
      pngBytes: payload.length,
      pngSha256: sha256(payload),
    });
    sources.push({
      name: image.name,
      path: `${relativePath(asset.filename)}#image=${encodeURIComponent(image.name)}`,
      bytes: sourcePayload.length,
      sha256: sha256(sourcePayload),
      width: sourceMetadata.width,
      height: sourceMetadata.height,
      levels: sourceMetadata.levels,
      mode: sourceMetadata.mode,
    });
  }
  return { payloads, derivatives, sources };
}

async function textureDerivatives(role, asset) {
  const contract = CHARACTER_BOOTSTRAP_CONTRACTS[role];
  if (contract.textureSource === "embeddedKtx2") {
    return embeddedTextureDerivatives(role, asset);
  }
  assert.equal(contract.textureSource, "artSourcePng");
  return artSourceTextureDerivatives(role, asset);
}

function ktx2Metadata(payload, label) {
  assert.ok(payload.length >= 80, `${label} is too small to be KTX2`);
  assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE), `${label} is not KTX2`);
  assert.equal(payload.readUInt32LE(12), 0, `${label} must use Basis Universal`);
  const supercompressionScheme = payload.readUInt32LE(44);
  const mode = supercompressionScheme === 1
    ? "ETC1S"
    : supercompressionScheme === 2
      ? "UASTC"
      : `unknown-${supercompressionScheme}`;
  assert.ok(mode === "ETC1S" || mode === "UASTC", `${label} uses ${mode}`);
  return {
    bytes: payload.length,
    sha256: sha256(payload),
    width: payload.readUInt32LE(20),
    height: payload.readUInt32LE(24),
    levels: payload.readUInt32LE(40),
    mode,
    supercompressionScheme,
  };
}

function extractEncodedTextures(role, encodedAsset, sourceAsset) {
  const contract = CHARACTER_BOOTSTRAP_CONTRACTS[role];
  const byName = new Map();
  for (const image of encodedAsset.json.images ?? []) {
    assert.ok(image.name, `${encodedAsset.filename} encoded image lost its name`);
    byName.set(image.name, Buffer.from(imagePayload(encodedAsset, image)));
  }
  const payloads = [];
  const textures = [];
  const classes = textureClasses(sourceAsset);
  for (const [imageIndex, image] of (sourceAsset.json.images ?? []).entries()) {
    const payload = byName.get(image.name);
    assert.ok(payload, `${encodedAsset.filename} lost ${image.name}`);
    const metadata = ktx2Metadata(payload, `${encodedAsset.filename}/${image.name}`);
    const textureClass = classes.get(imageIndex);
    assert.equal(
      metadata.mode,
      textureClass === "baseColor" ? contract.baseColorMode : "UASTC",
    );
    assert.equal(
      metadata.width,
      expectedTextureSize(role, image.name, textureClass),
    );
    assert.equal(metadata.height, metadata.width);
    assert.ok(metadata.levels >= 10);
    payloads.push(payload);
    textures.push({ name: image.name, textureClass, ...metadata });
  }
  return { payloads, textures };
}

function imageViewIndexes(asset) {
  return new Set((asset.json.images ?? []).map((image) => image.bufferView));
}

function transportSnapshot(asset) {
  const images = imageViewIndexes(asset);
  const entries = [];
  for (const [viewIndex, view] of asset.json.bufferViews.entries()) {
    if (images.has(viewIndex)) continue;
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression?.buffer === asset.embeddedBufferIndex) {
      const start = compression.byteOffset ?? 0;
      const payload = asset.binary.subarray(start, start + compression.byteLength);
      entries.push({
        viewIndex,
        kind: "meshopt",
        bytes: payload.length,
        sha256: sha256(payload),
      });
    } else if (view.buffer === asset.embeddedBufferIndex) {
      const start = view.byteOffset ?? 0;
      const payload = asset.binary.subarray(start, start + view.byteLength);
      entries.push({
        viewIndex,
        kind: "physical",
        bytes: payload.length,
        sha256: sha256(payload),
      });
    }
  }
  return {
    entries: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256(Buffer.from(JSON.stringify(entries))),
  };
}

function semanticSnapshot(json) {
  const invariant = structuredClone(json);
  delete invariant.buffers;
  delete invariant.bufferViews;
  delete invariant.images;
  return sha256(Buffer.from(JSON.stringify(invariant)));
}

function triangleCount(asset) {
  return (asset.json.meshes ?? []).reduce((total, mesh) => (
    total + mesh.primitives.reduce((meshTotal, primitive) => {
      const accessor = asset.json.accessors[
        primitive.indices ?? primitive.attributes.POSITION
      ];
      return meshTotal + accessor.count / 3;
    }, 0)
  ), 0);
}

function skeleton(asset) {
  return (asset.json.skins ?? []).map((skin) => (
    skin.joints.map((nodeIndex) => asset.json.nodes[nodeIndex].name)
  ));
}

function silhouetteContract(asset) {
  const positions = [];
  for (const mesh of asset.json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const accessor = asset.json.accessors[primitive.attributes.POSITION];
      positions.push({
        count: accessor.count,
        componentType: accessor.componentType,
        type: accessor.type,
        min: accessor.min,
        max: accessor.max,
      });
    }
  }
  return {
    primitiveCount: positions.length,
    sha256: sha256(Buffer.from(JSON.stringify(positions))),
  };
}

function animationContract(asset) {
  const clips = (asset.json.animations ?? []).map((animation) => ({
    name: animation.name,
    channels: animation.channels.map((channel) => ({
      node: asset.json.nodes[channel.target.node].name,
      path: channel.target.path,
      sampler: channel.sampler,
    })),
    samplers: animation.samplers.map((sampler) => {
      const input = asset.json.accessors[sampler.input];
      const output = asset.json.accessors[sampler.output];
      return {
        interpolation: sampler.interpolation ?? "LINEAR",
        inputCount: input.count,
        durationSeconds: input.max?.[0],
        outputCount: output.count,
        outputType: output.type,
      };
    }),
  }));
  return {
    clips: clips.map(({ name }) => name).sort(),
    sha256: sha256(Buffer.from(JSON.stringify(clips))),
  };
}

export async function auditBootstrapPair(role, referenceFilename, bootstrapFilename) {
  const contract = CHARACTER_BOOTSTRAP_CONTRACTS[role];
  assert.ok(contract, `No bootstrap contract exists for ${role}`);
  const [reference, bootstrap] = await Promise.all([
    loadGlb(referenceFilename),
    loadGlb(bootstrapFilename),
  ]);
  assert.ok(reference.json.extensionsRequired?.includes("EXT_meshopt_compression"));
  assert.ok(bootstrap.json.extensionsRequired?.includes("EXT_meshopt_compression"));
  assert.ok(bootstrap.json.extensionsRequired?.includes("KHR_texture_basisu"));
  assert.equal(
    bootstrap.json.extensionsRequired?.includes("KHR_mesh_quantization") ?? false,
    reference.json.extensionsRequired?.includes("KHR_mesh_quantization") ?? false,
    `${role} mesh quantization contract drifted`,
  );

  const namedNodes = (asset) => sortedUnique(
    asset.json.nodes.map((node) => node.name).filter(Boolean),
  );
  assert.deepEqual(namedNodes(bootstrap), namedNodes(reference), `${role} named nodes drifted`);
  assert.deepEqual(skeleton(bootstrap), skeleton(reference), `${role} skeleton drifted`);
  assert.equal(skeleton(bootstrap)[0].length, 21, `${role} must retain 21 joints`);
  assert.equal(
    semanticSnapshot(bootstrap.json),
    semanticSnapshot(reference.json),
    `${role} material, mesh, skin or animation semantics drifted`,
  );
  assert.deepEqual(
    transportSnapshot(bootstrap),
    transportSnapshot(reference),
    `${role} geometry/skin/animation transport is not byte-identical`,
  );
  assert.equal(
    triangleCount(bootstrap),
    triangleCount(reference),
    `${role} topology drifted`,
  );
  assert.deepEqual(
    silhouetteContract(bootstrap),
    silhouetteContract(reference),
    `${role} silhouette bounds drifted`,
  );
  const animations = animationContract(bootstrap);
  assert.deepEqual(animations, animationContract(reference), `${role} animations drifted`);
  assert.deepEqual(animations.clips, [...contract.clips].sort(), `${role} clip set drifted`);

  const classes = textureClasses(bootstrap);
  const textures = (bootstrap.json.images ?? []).map((image, imageIndex) => {
    const details = ktx2Metadata(
      imagePayload(bootstrap, image),
      `${bootstrapFilename}/${image.name}`,
    );
    const textureClass = classes.get(imageIndex);
    assert.equal(
      details.mode,
      textureClass === "baseColor" ? contract.baseColorMode : "UASTC",
    );
    assert.equal(
      details.width,
      expectedTextureSize(role, image.name, textureClass),
    );
    assert.equal(details.height, details.width);
    return { name: image.name, textureClass, ...details };
  });
  const bytes = bootstrap.buffer.length;
  assert.ok(
    bytes <= contract.maxBytes,
    `${bootstrapFilename} exceeds ${round(contract.maxBytes / 1024 / 1024, 2)} MiB`,
  );
  const referenceBytes = reference.buffer.length;
  const derivatives = await textureDerivatives(role, reference);
  return {
    role,
    reference: {
      variant: contract.referenceVariant,
      path: relativePath(referenceFilename),
      bytes: referenceBytes,
      sha256: sha256(reference.buffer),
      triangles: triangleCount(reference),
    },
    bootstrap: {
      path: relativePath(bootstrapFilename),
      bytes,
      sha256: sha256(bootstrap.buffer),
      savedBytes: referenceBytes - bytes,
      savedPercent: round((1 - bytes / referenceBytes) * 100, 3),
      triangles: triangleCount(bootstrap),
      triangleRatio: 1,
    },
    quality: {
      namedNodes: namedNodes(bootstrap).length,
      joints: skeleton(bootstrap)[0].length,
      clips: animations.clips,
      animationContractSha256: animations.sha256,
      silhouetteContract: silhouetteContract(bootstrap),
      nonImageTransport: transportSnapshot(bootstrap),
      semanticJsonSha256: semanticSnapshot(bootstrap.json),
      textures,
      derivativePngs: derivatives.derivatives,
      sourceTextures: derivatives.sources,
    },
  };
}

function reportFor(entries, toolVersion, generatedAt) {
  const referenceBytes = entries.reduce(
    (total, entry) => total + entry.reference.bytes,
    0,
  );
  const bootstrapBytes = entries.reduce(
    (total, entry) => total + entry.bootstrap.bytes,
    0,
  );
  return {
    formatVersion: FORMAT_VERSION,
    generatedAt,
    policy: {
      derivativeOnly: true,
      highModelsUnmodified: true,
      lod1ModelsUnmodified: true,
      declaredReferenceModelsUnmodified: true,
      geometrySimplification: false,
      geometrySkinAnimationTransport: "Byte-identical to each declared reference model.",
      referenceVariant: Object.fromEntries(
        Object.entries(CHARACTER_BOOTSTRAP_CONTRACTS).map(([role, contract]) => [
          role,
          contract.referenceVariant,
        ]),
      ),
      baseColor: Object.fromEntries(
        Object.entries(CHARACTER_BOOTSTRAP_CONTRACTS).map(([role, contract]) => [
          role,
          contract.baseColorPolicy,
        ]),
      ),
      normalAndOrm: `${DETAIL_SIZE}px UASTC quality 10`,
      intendedUse: "First-paint actors; promote to their declared reference when runtime budget permits.",
    },
    tool: {
      name: "gltfpack",
      version: toolVersion,
      arguments: GLTFPACK_ARGUMENTS,
    },
    budgets: {
      perCharacterBytes: Object.fromEntries(
        Object.entries(CHARACTER_BOOTSTRAP_CONTRACTS).map(([role, contract]) => [
          role,
          contract.maxBytes,
        ]),
      ),
      combinedBytes: COMBINED_MAX_BYTES,
    },
    totals: {
      referenceBytes,
      bootstrapBytes,
      savedBytes: referenceBytes - bootstrapBytes,
      savedPercent: round((1 - bootstrapBytes / referenceBytes) * 100, 3),
    },
    characters: entries,
  };
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
      const version = spawnSync(candidate, ["-v"], { encoding: "utf8" });
      if (version.status === 0) {
        return { executable: candidate, version: version.stdout.trim() };
      }
    } catch {
      // Try the next pinned/local tool.
    }
  }
  throw new Error("Native gltfpack 1.2 is required; pass --gltfpack or GLTFPACK_NATIVE.");
}

function encodeTextures(role, gltfpack, input, output) {
  const result = spawnSync(
    gltfpack,
    ["-i", input, "-o", output, ...GLTFPACK_ARGUMENTS[role]],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `gltfpack failed for ${input}`);
  }
}

async function build(options) {
  const encoder = await resolveGltfpack(options.gltfpack);
  assert.match(encoder.version, /^gltfpack 1\.2(?:\b|$)/u);
  await mkdir(options.outputDirectory, { recursive: true });
  await mkdir(path.dirname(options.report), { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(tmpdir(), "chasing-character-bootstrap-"));
  const staged = [];
  try {
    for (const role of Object.keys(CHARACTER_BOOTSTRAP_CONTRACTS)) {
      const sourceFilename = referenceFilename(role, options.sourceDirectory);
      const reference = await loadGlb(sourceFilename);
      const derivatives = await textureDerivatives(role, reference);
      const encoderInput = path.join(stagingDirectory, `${role}-png-input.glb`);
      const encoderOutput = path.join(stagingDirectory, `${role}-encoded.glb`);
      await writeFile(
        encoderInput,
        makePngEncoderInput(reference, derivatives.payloads),
      );
      encodeTextures(role, encoder.executable, encoderInput, encoderOutput);
      const encoded = await loadGlb(encoderOutput);
      const { payloads } = extractEncodedTextures(role, encoded, reference);
      const finalBuffer = makeFinalAsset(reference, payloads);
      const stagedFilename = path.join(stagingDirectory, `${role}-bootstrap.glb`);
      const outputFilename = path.join(options.outputDirectory, `${role}-bootstrap.glb`);
      await writeFile(stagedFilename, finalBuffer);
      const entry = await auditBootstrapPair(role, sourceFilename, stagedFilename);
      entry.bootstrap.path = relativePath(outputFilename);
      staged.push({ role, stagedFilename, outputFilename, entry });
    }
    const report = reportFor(
      staged.map(({ entry }) => entry),
      encoder.version,
      new Date().toISOString(),
    );
    assert.ok(
      report.totals.bootstrapBytes <= COMBINED_MAX_BYTES,
      `Combined bootstrap actors exceed ${COMBINED_MAX_BYTES / 1024 / 1024} MiB`,
    );
    const stagedReport = path.join(stagingDirectory, "character-bootstrap.json");
    await writeFile(stagedReport, `${JSON.stringify(report, null, 2)}\n`);
    for (const asset of staged) {
      await rename(asset.stagedFilename, asset.outputFilename);
    }
    await rename(stagedReport, options.report);
    return report;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function check(options) {
  const existing = JSON.parse(await readFile(options.report, "utf8"));
  assert.equal(existing.formatVersion, FORMAT_VERSION);
  assert.deepEqual(existing.tool.arguments, GLTFPACK_ARGUMENTS);
  const entries = [];
  for (const role of Object.keys(CHARACTER_BOOTSTRAP_CONTRACTS)) {
    entries.push(await auditBootstrapPair(
      role,
      referenceFilename(role, options.sourceDirectory),
      path.join(options.outputDirectory, `${role}-bootstrap.glb`),
    ));
  }
  const current = reportFor(entries, existing.tool.version, existing.generatedAt);
  assert.deepEqual(current, existing, `${options.report} does not match shipped bootstraps`);
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
