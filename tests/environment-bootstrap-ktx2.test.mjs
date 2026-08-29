import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "environment-bootstrap-ktx2.json",
);
const VISUAL_REPORT = path.join(
  ROOT,
  "art-source",
  "reports",
  "m2-environment-visual-fidelity.json",
);
const SCRIPT = path.join(
  ROOT,
  "tools",
  "art_pipeline",
  "optimize_environment_bootstrap_ktx2.mjs",
);
const KTX2_SIGNATURE = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PINNED_GLTFPACK_SHA256 =
  "037336fafa46f342fe118ce8d17877fecb3deb1cd6dd8f62ee2a95bfaf2b79df";
const TARGETS = [
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
];
const LOCKER_CLIPS = [
  "Locker_Door_Check_Close",
  "Locker_Door_Check_Open",
  "Locker_Door_Close_Enter",
  "Locker_Door_Close_Exit",
  "Locker_Door_Open_Enter",
  "Locker_Door_Open_Exit",
];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function readGlb(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a GLB`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} has a wrong declared size`);
  let json;
  let binary;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      json = JSON.parse(
        buffer.subarray(start, start + length).toString("utf8").replace(/[\0 ]+$/u, "").trim(),
      );
    } else if (type === 0x004e4942) {
      binary = buffer.subarray(start, start + length);
    }
    offset = start + length;
  }
  assert.ok(json && binary, `${filename} has no JSON or BIN chunk`);
  const physicalBuffer = json.buffers.find(
    (candidate) => candidate.uri === undefined
      && !candidate.extensions?.EXT_meshopt_compression?.fallback,
  );
  return { json, binary: binary.subarray(0, physicalBuffer.byteLength) };
}

async function decodeMeshoptBufferViews(glb, filename) {
  await MeshoptDecoder.ready;
  assert.equal(
    MeshoptDecoder.supported,
    true,
    "the project Meshopt decoder must support compressed environment assets",
  );
  const decoded = new Map();
  for (const [index, view] of glb.json.bufferViews.entries()) {
    const compression = view.extensions?.EXT_meshopt_compression;
    if (!compression) continue;
    const target = new Uint8Array(compression.count * compression.byteStride);
    const source = new Uint8Array(
      glb.binary.buffer,
      glb.binary.byteOffset + (compression.byteOffset ?? 0),
      compression.byteLength,
    );
    MeshoptDecoder.decodeGltfBuffer(
      target,
      compression.count,
      compression.byteStride,
      source,
      compression.mode,
      compression.filter,
    );
    assert.equal(
      target.byteLength,
      view.byteLength,
      `${filename} bufferView ${index} decoded to the wrong size`,
    );
    decoded.set(index, Buffer.from(target.buffer, target.byteOffset, target.byteLength));
  }
  return decoded;
}

function uvBounds(glb, decoded, accessorIndex, filename) {
  const accessor = glb.json.accessors[accessorIndex];
  assert.equal(accessor.type, "VEC2", `${filename} atlas UV accessor must be VEC2`);
  assert.equal(accessor.sparse, undefined, `${filename} atlas UVs cannot be sparse`);
  const view = glb.json.bufferViews[accessor.bufferView];
  const payload = decoded.get(accessor.bufferView);
  assert.ok(payload, `${filename} atlas UV bufferView must be Meshopt compressed`);
  const componentBytes = new Map([
    [5121, 1],
    [5123, 2],
    [5126, 4],
  ]).get(accessor.componentType);
  assert.ok(componentBytes, `${filename} has an unsupported atlas UV component type`);
  const readComponent = {
    5121: (offset) => payload.readUInt8(offset),
    5123: (offset) => payload.readUInt16LE(offset),
    5126: (offset) => payload.readFloatLE(offset),
  }[accessor.componentType];
  const normalize = {
    5121: (value) => value / 255,
    5123: (value) => value / 65535,
    5126: (value) => value,
  }[accessor.componentType];
  const stride = view.byteStride ?? componentBytes * 2;
  const start = accessor.byteOffset ?? 0;
  const minimum = [Infinity, Infinity];
  const maximum = [-Infinity, -Infinity];
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < 2; component += 1) {
      const raw = readComponent(start + item * stride + component * componentBytes);
      const value = accessor.normalized ? normalize(raw) : raw;
      minimum[component] = Math.min(minimum[component], value);
      maximum[component] = Math.max(maximum[component], value);
    }
  }
  return { minimum, maximum };
}

test("standalone environment GLBs use exactly two immutable atlas requests and preserve their binary art", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.formatVersion, 1);
  assert.deepEqual(report.assets.map((entry) => path.basename(entry.path)), TARGETS);
  assert.deepEqual(report.policy, {
    geometryAndAnimationBinaryByteStable: true,
    sourceResolution: "Authoring textures remain 512px; first-paint BaseColor uses reviewed 256px tiles and Normal uses 128px tiles.",
    atlasLayout: "BaseColor 256px+4px and Normal 128px+2px share an exactly equivalent normalized 4x3 layout.",
    baseColor: "ETC1S quality 10 with BasisLZ supercompression",
    normal: "128px/tile UASTC quality 10 with Zstandard supercompression",
    normalAtlasNormalizedUvEquivalent: true,
    normalAtlasSourceHashesExact: true,
    fallbackImages: false,
    applicationUrlChangesRequired: false,
  });
  assert.equal(report.tool.version, "gltfpack 1.2");
  assert.equal(report.tool.binarySha256, PINNED_GLTFPACK_SHA256);
  assert.equal(report.tool.nativeBinaryCommitted, false);
  assert.equal(report.atlases.length, 2);
  const expectedUris = new Set(
    report.atlases.map((atlas) => (
      `SharedTexturesBootstrapKTX2/${path.basename(atlas.path)}`
    )),
  );

  for (const entry of report.assets) {
    const filename = path.join(ROOT, entry.path);
    const buffer = await readFile(filename);
    const glb = readGlb(buffer, filename);
    assert.equal(buffer.length, entry.output.bytes, `${entry.path} bytes drifted`);
    assert.equal(sha256(buffer), entry.output.sha256, `${entry.path} hash drifted`);
    assert.equal(sha256(glb.binary), entry.geometryBinarySha256, `${entry.path} art BIN drifted`);
    assert.ok(glb.json.extensionsRequired?.includes("EXT_meshopt_compression"));
    assert.ok(glb.json.extensionsRequired?.includes("KHR_texture_basisu"));
    assert.ok(glb.json.extensionsRequired?.includes("KHR_texture_transform"));
    assert.equal(glb.json.images.length, 2);
    assert.equal(glb.json.textures.length, 2);
    assert.deepEqual(new Set(glb.json.images.map((image) => image.uri)), expectedUris);
    assert.ok(
      glb.json.images.every(
        (image) => image.bufferView === undefined
          && image.mimeType === undefined
          && image.uri.endsWith(".ktx2"),
      ),
    );
    assert.ok(
      glb.json.textures.every(
        (texture) => texture.source === undefined
          && Number.isInteger(texture.extensions?.KHR_texture_basisu?.source),
      ),
    );
    const contract = glb.json.asset.extras.chasing_environment_bootstrap;
    assert.equal(contract.version, 1);
    assert.equal(contract.geometryBinarySha256, entry.geometryBinarySha256);
    assert.equal(contract.slots.length, entry.sourceSlots.length);
    const decoded = await decodeMeshoptBufferViews(glb, entry.path);
    for (const slot of contract.slots) {
      const material = glb.json.materials[slot.materialIndex];
      const textureInfo = slot.slot === "baseColor"
        ? material.pbrMetallicRoughness?.baseColorTexture
        : material.normalTexture;
      const transform = textureInfo?.extensions?.KHR_texture_transform;
      assert.ok(transform, `${entry.path} lost an atlas texture transform`);
      assert.ok(transform.offset.every(Number.isFinite));
      assert.ok(transform.scale.every((value) => Number.isFinite(value) && value > 0));

      const family = path.basename(slot.sourceUri)
        .replace(/^Env_/u, "")
        .replace(/_(?:BaseColor|Normal)_2K\.png$/u, "");
      const familyIndex = report.atlas.textureFamilies.indexOf(family);
      assert.notEqual(familyIndex, -1, `${entry.path} references unknown atlas family ${family}`);
      const atlas = slot.slot === "baseColor" ? report.atlas.baseColor : report.atlas.normal;
      const column = familyIndex % 4;
      const row = Math.floor(familyIndex / 4);
      const strideX = atlas.sourceTileWidth + atlas.gutterPixels * 2;
      const strideY = atlas.sourceTileHeight + atlas.gutterPixels * 2;
      const tileMinimum = [
        (column * strideX + atlas.gutterPixels) / atlas.width,
        (row * strideY + atlas.gutterPixels) / atlas.height,
      ];
      const tileMaximum = [
        tileMinimum[0] + atlas.sourceTileWidth / atlas.width,
        tileMinimum[1] + atlas.sourceTileHeight / atlas.height,
      ];
      const tileGuardMinimum = [
        column * strideX / atlas.width,
        row * strideY / atlas.height,
      ];
      const tileGuardMaximum = [
        (column + 1) * strideX / atlas.width,
        (row + 1) * strideY / atlas.height,
      ];
      assert.ok(
        tileMinimum.every((value, component) => (
          value > tileGuardMinimum[component]
            && tileMaximum[component] < tileGuardMaximum[component]
        )),
        `${entry.path} atlas tile lost its quantization gutter`,
      );
      const texCoord = transform.texCoord ?? textureInfo.texCoord ?? 0;
      const primitives = glb.json.meshes.flatMap((mesh) => mesh.primitives)
        .filter((primitive) => primitive.material === slot.materialIndex);
      assert.ok(primitives.length > 0, `${entry.path} atlas material is not used by geometry`);
      for (const primitive of primitives) {
        const accessorIndex = primitive.attributes[`TEXCOORD_${texCoord}`];
        assert.notEqual(
          accessorIndex,
          undefined,
          `${entry.path} atlas material lost TEXCOORD_${texCoord}`,
        );
        const bounds = uvBounds(glb, decoded, accessorIndex, entry.path);
        const mappedMinimum = bounds.minimum.map(
          (value, component) => transform.offset[component] + value * transform.scale[component],
        );
        const mappedMaximum = bounds.maximum.map(
          (value, component) => transform.offset[component] + value * transform.scale[component],
        );
        for (let component = 0; component < 2; component += 1) {
          // Linear sampling at the outer gutter edge can blend the adjacent
          // tile. Keep every decoded UV at least half a texel inside instead
          // of accepting a coordinate that is merely numerically in range.
          const halfTexel = 0.5 / (component === 0 ? atlas.width : atlas.height);
          const epsilon = 1e-9;
          assert.ok(
            mappedMinimum[component] >= tileGuardMinimum[component] + halfTexel - epsilon
              && mappedMaximum[component] <= tileGuardMaximum[component] - halfTexel + epsilon,
            `${entry.path} transformed UVs leave the filter-safe ${family} atlas gutter`,
          );
        }
      }
    }
  }
});

test("atlas payloads retain pinned source hashes and an exactly equivalent normalized layout", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.sourceTextures.length, 22);
  assert.deepEqual(report.atlas.baseColor, {
    sourceTileWidth: 256,
    sourceTileHeight: 256,
    gutterPixels: 4,
    width: 1056,
    height: 792,
  });
  assert.deepEqual(report.atlas.normal, {
    sourceTileWidth: 128,
    sourceTileHeight: 128,
    gutterPixels: 2,
    width: 528,
    height: 396,
  });
  assert.equal(report.atlas.normalizedUvLayoutEquivalent, true);
  assert.equal(report.atlas.normalizedTransformMaxDelta, 0);
  assert.equal(new Set(report.atlas.textureFamilies).size, 11);

  for (const source of report.sourceTextures) {
    const buffer = await readFile(path.join(ROOT, source.path));
    const metadata = await sharp(buffer).metadata();
    assert.equal(buffer.length, source.bytes);
    assert.equal(sha256(buffer), source.sha256);
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 512);
  }

  for (const atlas of report.atlases) {
    const payload = await readFile(path.join(ROOT, atlas.path));
    assert.ok(payload.subarray(0, 12).equals(KTX2_SIGNATURE));
    assert.equal(payload.length, atlas.bytes);
    assert.equal(sha256(payload), atlas.sha256);
    assert.equal(path.basename(atlas.path, ".ktx2"), atlas.sha256);
    assert.equal(payload.readUInt32LE(20), atlas.width);
    assert.equal(payload.readUInt32LE(24), atlas.height);
    assert.equal(payload.readUInt32LE(40), atlas.levels);
    assert.ok(atlas.levels >= (atlas.textureClass === "baseColor" ? 10 : 9));
    assert.equal(
      payload.readUInt32LE(44),
      atlas.expectedMode === "ETC1S" ? 1 : 2,
    );
    assert.equal(
      atlas.expectedMode,
      atlas.textureClass === "baseColor" ? "ETC1S" : "UASTC",
    );
    assert.equal(
      atlas.sourceTileWidth / atlas.width,
      atlas.textureClass === "baseColor" ? 256 / 1056 : 128 / 528,
    );
    assert.equal(
      atlas.gutterPixels / atlas.width,
      atlas.textureClass === "baseColor" ? 4 / 1056 : 2 / 528,
    );
  }
  const normal = report.atlases.find(({ textureClass }) => textureClass === "normal");
  assert.equal(normal.reusedFromThemeBootstrap, false);
  assert.equal(normal.normalizedTransformMaxDelta, 0);
});

test("worst-case first playable environment is below 8 MiB and removes fourteen requests", async () => {
  const report = JSON.parse(await readFile(REPORT, "utf8"));
  assert.equal(report.totals.originalRuntimeRequests, 41);
  assert.equal(report.totals.outputRuntimeRequests, 21);
  assert.equal(report.totals.requestsSaved, 20);
  assert.ok(report.totals.outputRuntimeBytes <= 8 * 1024 * 1024);
  assert.ok(report.totals.savedPercent >= 60);
  assert.ok(report.totals.atlasBytes <= 320_000);
  assert.equal(report.levelOneFirstPlayable.originalRuntimeRequests, 26);
  assert.equal(report.levelOneFirstPlayable.outputRuntimeRequests, 12);
  assert.equal(report.levelOneFirstPlayable.requestsSaved, 14);
  assert.ok(report.levelOneFirstPlayable.outputRuntimeBytes <= 8 * 1024 * 1024);
  assert.ok(report.levelOneFirstPlayable.savedBytes >= 4_500_000);
});

test("hero locker keeps its authored hierarchy and all six animation performances", async () => {
  const filename = path.join(ROOT, "public", "models", "environment", "locker.glb");
  const glb = readGlb(await readFile(filename), filename);
  const names = new Set(glb.json.nodes.map((node) => node.name));
  for (const required of [
    "DoorPivot",
    "HideAnchor",
    "HandIK",
    "PeekAnchor",
    "CameraAnchor",
    "SearchAnchor",
  ]) {
    assert.ok(names.has(required), `hero locker lost ${required}`);
  }
  const heroRoot = glb.json.nodes.find((node) => node.name === "Locker_Hero");
  assert.equal(heroRoot?.extras?.gltfpackVersion, "gltfpack 1.2");
  assert.equal(heroRoot?.extras?.gltfpackBinarySha256, PINNED_GLTFPACK_SHA256);
  assert.deepEqual(
    glb.json.animations.map((animation) => animation.name).sort(),
    [...LOCKER_CLIPS].sort(),
  );
});

test("premium common environment report pins the native geometry encoder", async () => {
  const report = JSON.parse(await readFile(
    path.join(ROOT, "docs", "art_production", "PREMIUM_COMMON_ENVIRONMENT_REPORT.json"),
    "utf8",
  ));
  assert.deepEqual(report.tool, {
    name: "gltfpack",
    version: "gltfpack 1.2",
    binarySha256: PINNED_GLTFPACK_SHA256,
    arguments: [
      "-cc", "-gt", "-kn", "-km", "-ke", "-tr",
      "-vp", "14", "-vn", "10", "-vt", "12",
      "-ar", "16", "-af", "0", "-kv",
    ],
  });
});

test("quantized book semantics retain renderable portable-decoy descendants", async () => {
  const filename = path.join(ROOT, "public", "models", "environment", "books.glb");
  const glb = readGlb(await readFile(filename), filename);
  const semanticRoots = glb.json.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.name?.startsWith("Dropped_Notebook_"));
  assert.equal(semanticRoots.length, 5);
  const descendantMeshes = (rootIndex) => {
    const meshes = new Set();
    const visit = (nodeIndex) => {
      const node = glb.json.nodes[nodeIndex];
      if (node.mesh !== undefined) meshes.add(node.mesh);
      for (const child of node.children ?? []) visit(child);
    };
    visit(rootIndex);
    return meshes;
  };
  for (const { node, index } of semanticRoots) {
    assert.ok(
      descendantMeshes(index).size > 0,
      `${node.name} lost its renderable mesh below the gltfpack decode node`,
    );
  }
});

test("M2 environment textures pass the paired production-camera regression", async () => {
  const [assetReport, visualReport] = await Promise.all([
    readFile(REPORT, "utf8").then(JSON.parse),
    readFile(VISUAL_REPORT, "utf8").then(JSON.parse),
  ]);
  assert.equal(visualReport.formatVersion, 1);
  assert.match(visualReport.method, /Paired 1280x720 production-camera captures/u);
  assert.deepEqual(visualReport.gates, {
    minimumSilhouetteIou: 0.9999,
    maximumRgbMeanAbsoluteError: 1,
  });
  const currentNormal = assetReport.atlases.find(({ textureClass }) => textureClass === "normal");
  const visualNormal = visualReport.atlases.find(({ textureClass }) => textureClass === "normal");
  for (const key of ["path", "bytes", "sha256", "width", "height", "levels"]) {
    assert.equal(visualNormal[key], currentNormal[key]);
  }
  for (const asset of ["locker", "tree", "desk-chair", "police-car"]) {
    const entry = assetReport.assets.find(
      ({ path: assetPath }) => path.basename(assetPath) === `${asset}.glb`,
    );
    assert.deepEqual(visualReport.environmentAssets[`${asset}.glb`], {
      path: entry.path,
      bytes: entry.output.bytes,
      sha256: entry.output.sha256,
    });
  }
  for (const result of visualReport.results) {
    assert.ok(result.silhouetteIou >= visualReport.gates.minimumSilhouetteIou);
    assert.ok(result.rgbMeanAbsoluteError <= visualReport.gates.maximumRgbMeanAbsoluteError);
  }
});

test("environment atlas pipeline check is self-contained and preserves active application GLB URLs", async () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Validated 19 byte-stable environment GLBs and 2 shared KTX2 atlases/u);

  const gameSource = await Promise.all([
    path.join(ROOT, "app", "chasing-game.tsx"),
    path.join(ROOT, "app", "game", "runtime-assets.ts"),
  ].map((filename) => readFile(filename, "utf8"))).then((sources) => sources.join("\n"));
  for (const basename of TARGETS.filter(
    (candidate) => !["front-gate.glb", "exit.glb"].includes(candidate),
  )) {
    assert.match(
      gameSource,
      new RegExp(`/models/environment/${basename.replaceAll(".", "\\.")}(?:\\?v=\\d+)?`, "u"),
      `${basename} no longer uses its established application URL`,
    );
  }
  for (const basename of [
    "campus-kit-bootstrap.glb",
    "hospital-kit-bootstrap.glb",
    "fire-station-kit-bootstrap.glb",
    "factory-kit-bootstrap.glb",
  ]) {
    assert.match(
      gameSource,
      new RegExp(`/models/environment/themes/${basename.replaceAll(".", "\\.")}(?:\\?v=\\d+)?`, "u"),
      `${basename} no longer supplies authored entrance/exit structures`,
    );
  }
  const pipelineFiles = await readdir(path.join(ROOT, "tools", "art_pipeline"));
  assert.equal(
    pipelineFiles.some((filename) => /^gltfpack(?:-macos)?(?:\.\w+)?$/u.test(filename)),
    false,
  );
});
