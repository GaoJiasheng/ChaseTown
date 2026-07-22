import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_ROOT = path.join(ROOT, "public", "models");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }

  return files;
}

function readGlbJson(buffer, filename) {
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a binary GLB`);
  assert.equal(buffer.readUInt32LE(4), 2, `${filename} must use glTF 2.0`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} has an invalid declared length`);

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    assert.ok(chunkEnd <= buffer.length, `${filename} contains a truncated GLB chunk`);

    if (chunkType === 0x4e4f534a) {
      return JSON.parse(buffer.subarray(chunkStart, chunkEnd).toString("utf8").replace(/\0+$/u, "").trim());
    }
    offset = chunkEnd;
  }

  assert.fail(`${filename} is missing its JSON chunk`);
}

test("every shipped GLB is referenced, valid, and has all external textures", async () => {
  const gameSource = await readFile(path.join(ROOT, "app", "chasing-game.tsx"), "utf8");
  const referenced = new Set(
    [...gameSource.matchAll(/["'](\/models\/[^"'?]+\.glb)(?:\?[^"']*)?["']/gu)]
      .map((match) => match[1]),
  );
  const files = await walk(MODELS_ROOT);
  const shipped = files
    .filter((filename) => filename.endsWith(".glb"))
    .map((filename) => `/${path.relative(path.join(ROOT, "public"), filename).split(path.sep).join("/")}`);

  assert.equal(shipped.length, 33, "the shared 29-model set plus four campaign theme kits must be retained");
  assert.deepEqual([...shipped].sort(), [...referenced].sort(), "runtime code and shipped GLBs must stay in sync");
  const referencedImages = new Set();

  for (const publicPath of shipped) {
    const filename = path.join(ROOT, "public", publicPath.slice(1));
    const info = await stat(filename);
    assert.ok(info.size > 1024, `${publicPath} looks empty or like pointer text`);

    const buffer = await readFile(filename);
    assert.doesNotMatch(buffer.subarray(0, 160).toString("utf8"), /git-lfs/iu, `${publicPath} must not be an LFS pointer`);
    const gltf = readGlbJson(buffer, publicPath);

    for (const [materialIndex, material] of (gltf.materials ?? []).entries()) {
      for (const value of material.emissiveFactor ?? []) {
        assert.ok(
          Number.isFinite(value) && value >= 0 && value <= 1,
          `${publicPath} material ${materialIndex} has an invalid emissiveFactor component`,
        );
      }
      const emissiveStrength = material.extensions?.KHR_materials_emissive_strength?.emissiveStrength;
      if (emissiveStrength !== undefined) {
        assert.ok(
          Number.isFinite(emissiveStrength) && emissiveStrength >= 0,
          `${publicPath} material ${materialIndex} has an invalid emissive strength`,
        );
        assert.ok(
          gltf.extensionsUsed?.includes("KHR_materials_emissive_strength"),
          `${publicPath} must declare KHR_materials_emissive_strength`,
        );
      }
    }

    for (const image of gltf.images ?? []) {
      if (!image.uri || image.uri.startsWith("data:")) continue;
      const imagePath = path.resolve(path.dirname(filename), decodeURIComponent(image.uri.split("?")[0]));
      const relative = path.relative(MODELS_ROOT, imagePath);
      assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `${publicPath} references an image outside public/models`);
      assert.ok((await stat(imagePath)).isFile(), `${publicPath} is missing ${image.uri}`);
      referencedImages.add(imagePath);
    }

    if (publicPath.includes("/characters/")) {
      assert.ok((gltf.skins?.length ?? 0) > 0, `${publicPath} must retain its character rig`);
    }
  }

  const shippedImages = files.filter((filename) => filename.endsWith(".png"));
  assert.deepEqual(
    shippedImages.sort(),
    [...referencedImages].sort(),
    "public/models must not contain unreferenced texture exports",
  );
});

test("campaign theme kits expose detailed named hero props and PBR materials", async () => {
  const contracts = new Map([
    ["campus-kit.glb", ["CampusTrophyCase", "CampusVendingMachine", "CampusWaterFountain", "CampusBikeRack", "CampusWayfinding", "CampusArchitectureWall"]],
    ["hospital-kit.glb", ["HospitalBed", "HospitalCrashCart", "HospitalIVStation", "HospitalWheelchair", "HospitalPrivacyScreen", "HospitalWayfinding", "HospitalArchitectureWall"]],
    ["fire-station-kit.glb", ["FireEngine", "FireGearRack", "FireHoseReel", "FireHydrant", "FireStationWayfinding", "FireSafetyCones", "FireArchitectureWall"]],
    ["factory-kit.glb", ["FactoryPipeAssembly", "FactoryStorageTank", "FactoryControlConsole", "FactoryConveyor", "FactorySafetyBarrier", "FactoryCrateStack", "FactoryArchitectureWall"]],
  ]);

  for (const [basename, requiredNodes] of contracts) {
    const filename = path.join(MODELS_ROOT, "environment", "themes", basename);
    const buffer = await readFile(filename);
    const gltf = readGlbJson(buffer, basename);
    const nodeNames = new Set((gltf.nodes ?? []).map((node) => node.name));
    for (const name of requiredNodes) assert.ok(nodeNames.has(name), `${basename} is missing ${name}`);
    const triangles = (gltf.meshes ?? []).reduce((total, mesh) => total + mesh.primitives.reduce((meshTotal, primitive) => {
      return meshTotal + ((gltf.accessors?.[primitive.indices]?.count ?? 0) / 3);
    }, 0), 0);
    assert.ok(triangles >= 30_000, `${basename} must retain its detailed beveled production geometry`);
    assert.ok((gltf.materials?.length ?? 0) >= 10, `${basename} needs a real semantic PBR material set`);
    assert.ok((gltf.images?.length ?? 0) >= 8, `${basename} must embed real PBR color/normal surface maps`);
    assert.ok(gltf.images.every((image) => image.mimeType === "image/webp"), `${basename} PBR maps must use compact WebP payloads`);
    assert.ok(gltf.extensionsRequired?.includes("EXT_texture_webp"), `${basename} must declare its WebP texture contract`);
    assert.ok(buffer.length < 2.5 * 1024 * 1024, `${basename} exceeds the compact web theme-kit budget`);
  }
});

test("runtime PNG files are real deployable images, not LFS pointers", async () => {
  const files = [
    ...(await walk(MODELS_ROOT)).filter((filename) => filename.endsWith(".png")),
    path.join(ROOT, "public", "og.png"),
  ];
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  assert.equal(files.length, 27, "26 referenced runtime textures plus the social card must be retained");
  for (const filename of files) {
    const buffer = await readFile(filename);
    assert.ok(buffer.subarray(0, 8).equals(pngSignature), `${path.relative(ROOT, filename)} is not a real PNG`);
  }
});
