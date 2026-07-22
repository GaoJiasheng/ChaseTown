#!/usr/bin/env node

/**
 * Build compact, deterministic glTF ORM maps for the shipped environment kit.
 *
 * The source library already contains authored colour and tangent-normal detail.
 * This pass derives contact occlusion and material breakup from those two maps,
 * then packs glTF channels as R=AO, G=roughness, B=metallic. Keeping one packed
 * 512px image per surface family preserves the Web download budget while giving
 * every architectural material a complete PBR response.
 */

import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEXTURES = path.join(ROOT, "public/models/SharedTextures");
const OUTPUT = path.join(ROOT, "work/art_pipeline/environment-orm");
const REPORT = path.join(ROOT, "docs/art_production/environment-runtime-orm-report.json");

const FAMILIES = {
  Env_PaintedWall: { roughness: 0.78, variation: 0.13, metallic: 0.0, cavity: 0.2 },
  Env_BluePaintedMetal: { roughness: 0.39, variation: 0.19, metallic: 0.68, cavity: 0.3 },
  Env_RedPaintedMetal: { roughness: 0.35, variation: 0.2, metallic: 0.62, cavity: 0.31 },
  Env_WoodTrim: { roughness: 0.64, variation: 0.2, metallic: 0.0, cavity: 0.25 },
  Env_WornMetal: { roughness: 0.34, variation: 0.24, metallic: 0.91, cavity: 0.36 },
  Env_RubberBlack: { roughness: 0.86, variation: 0.12, metallic: 0.0, cavity: 0.32 },
  Env_Grass: { roughness: 0.91, variation: 0.08, metallic: 0.0, cavity: 0.42 },
  Env_Paper: { roughness: 0.84, variation: 0.1, metallic: 0.0, cavity: 0.16 },
};

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

async function rawRgb(filename) {
  const image = sharp(await readFile(filename)).removeAlpha().toColourspace("srgb");
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 512 || info.height !== 512 || info.channels !== 3) {
    throw new Error(`${filename} must be a 512x512 RGB texture`);
  }
  return { data, width: info.width, height: info.height };
}

function hashNoise(x, y, seed) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 19.191) * 43758.5453;
  return value - Math.floor(value);
}

async function buildFamily(stem, spec, index) {
  const base = await rawRgb(path.join(TEXTURES, `${stem}_BaseColor_2K.png`));
  const normal = await rawRgb(path.join(TEXTURES, `${stem}_Normal_2K.png`));
  const packed = Buffer.alloc(base.width * base.height * 3);
  let minimumAo = 1;
  let maximumAo = 0;
  let minimumRoughness = 1;
  let maximumRoughness = 0;

  for (let y = 0; y < base.height; y += 1) {
    for (let x = 0; x < base.width; x += 1) {
      const offset = (y * base.width + x) * 3;
      const luminance = (
        base.data[offset] * 0.2126
        + base.data[offset + 1] * 0.7152
        + base.data[offset + 2] * 0.0722
      ) / 255;
      const normalZ = normal.data[offset + 2] / 255;
      const normalSlope = clamp((0.98 - normalZ) * 2.25, 0, 1);
      const broadGrain = (
        Math.sin((x + index * 31) * 0.031)
        + Math.cos((y - index * 17) * 0.027)
        + Math.sin((x + y) * 0.014)
      ) / 6;
      const fineGrain = hashNoise(x >> 1, y >> 1, index + 1) - 0.5;
      const cavity = clamp(normalSlope * 0.72 + (1 - luminance) * 0.28, 0, 1);
      const ao = clamp(0.985 - cavity * spec.cavity - Math.max(0, broadGrain) * 0.08, 0.55, 1);
      const roughness = clamp(
        spec.roughness
          + (0.5 - luminance) * spec.variation
          + broadGrain * spec.variation
          + fineGrain * spec.variation * 0.2,
        0.12,
        0.98,
      );
      // Scraped highlights in painted metal expose a small amount of substrate;
      // dielectric families stay exactly non-metallic.
      const metallic = spec.metallic === 0
        ? 0
        : clamp(spec.metallic + (luminance - 0.5) * 0.09 - cavity * 0.04, 0, 1);

      packed[offset] = Math.round(ao * 255);
      packed[offset + 1] = Math.round(roughness * 255);
      packed[offset + 2] = Math.round(metallic * 255);
      minimumAo = Math.min(minimumAo, ao);
      maximumAo = Math.max(maximumAo, ao);
      minimumRoughness = Math.min(minimumRoughness, roughness);
      maximumRoughness = Math.max(maximumRoughness, roughness);
    }
  }

  const output = path.join(OUTPUT, `${stem}_ORM_512.png`);
  await sharp(packed, { raw: { width: base.width, height: base.height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(output);
  return {
    family: stem,
    output: path.relative(ROOT, output),
    channels: "R=AO, G=roughness, B=metallic",
    resolution: [base.width, base.height],
    aoRange: [Number(minimumAo.toFixed(3)), Number(maximumAo.toFixed(3))],
    roughnessRange: [Number(minimumRoughness.toFixed(3)), Number(maximumRoughness.toFixed(3))],
    metallicBase: spec.metallic,
  };
}

await mkdir(path.dirname(REPORT), { recursive: true });
await mkdir(OUTPUT, { recursive: true });
const generated = [];
for (const [index, [stem, spec]] of Object.entries(FAMILIES).entries()) {
  generated.push(await buildFamily(stem, spec, index));
}
await writeFile(REPORT, `${JSON.stringify({ generated, familyCount: generated.length }, null, 2)}\n`);
console.log(`Generated ${generated.length} compact glTF ORM maps in ${OUTPUT}`);
