import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_ROOT = path.join(ROOT, "public", "models");
const VILLAIN_FILE = path.join(MODELS_ROOT, "characters", "villain.glb");
const MAX_VILLAIN_BYTES = 2_500_000;
const MAX_PUBLIC_MODELS_BYTES = 12_000_000;
const MIN_VILLAIN_TRIANGLES = 20_000;
const MAX_VILLAIN_TRIANGLES = 32_000;
const MAX_MAIN_MATERIALS = 2;
const MAX_ZERO_WEIGHT_RATIO = 0.02;

const CANONICAL_BONES = [
  "Hips", "Spine", "Chest", "Neck", "Head",
  "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
  "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
  "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
  "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
];

const CANONICAL_PARENT = {
  Hips: null,
  Spine: "Hips",
  Chest: "Spine",
  Neck: "Chest",
  Head: "Neck",
  LeftShoulder: "Chest",
  LeftUpperArm: "LeftShoulder",
  LeftLowerArm: "LeftUpperArm",
  LeftHand: "LeftLowerArm",
  RightShoulder: "Chest",
  RightUpperArm: "RightShoulder",
  RightLowerArm: "RightUpperArm",
  RightHand: "RightLowerArm",
  LeftUpperLeg: "Hips",
  LeftLowerLeg: "LeftUpperLeg",
  LeftFoot: "LeftLowerLeg",
  LeftToes: "LeftFoot",
  RightUpperLeg: "Hips",
  RightLowerLeg: "RightUpperLeg",
  RightFoot: "RightLowerLeg",
  RightToes: "RightFoot",
};

const EXPECTED_CLIPS = [
  "Idle",
  "Run",
  "Walk",
  "TurnLeft",
  "TurnRight",
  "LookAround",
  "ScaredCaught",
  "Celebrate",
  "PointAlert",
];

if (!("self" in globalThis)) globalThis.self = globalThis;
if (!("ProgressEvent" in globalThis)) {
  globalThis.ProgressEvent = class ProgressEvent {
    constructor(type, values = {}) {
      this.type = type;
      Object.assign(this, values);
    }
  };
}

const decodedImageTypes = new Set();
globalThis.createImageBitmap = async (blob) => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  decodedImageTypes.add(blob.type);
  if (blob.type === "image/webp") {
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", "decoded WebP RIFF signature");
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", "decoded WebP format signature");
  } else if (blob.type === "image/png") {
    assert.ok(
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      "decoded PNG signature",
    );
  } else {
    assert.fail(`unexpected runtime character image type ${blob.type || "<empty>"}`);
  }
  return { width: 1, height: 1, close() {} };
};

function parseGlb(payload) {
  assert.equal(payload.subarray(0, 4).toString("ascii"), "glTF", "villain must be a binary GLB");
  assert.equal(payload.readUInt32LE(4), 2, "villain must use glTF 2.0");
  assert.equal(payload.readUInt32LE(8), payload.length, "villain GLB declared length");

  let document = null;
  let binary = Buffer.alloc(0);
  for (let offset = 12; offset + 8 <= payload.length;) {
    const length = payload.readUInt32LE(offset);
    const type = payload.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    assert.ok(end <= payload.length, "villain GLB chunks must not be truncated");
    if (type === 0x4e4f534a) {
      document = JSON.parse(payload.subarray(start, end).toString("utf8").replace(/\0+$/u, "").trim());
    } else if (type === 0x004e4942) {
      binary = payload.subarray(start, end);
    }
    offset = end;
  }
  assert.ok(document, "villain GLB JSON chunk");
  return { document, binary };
}

async function directoryBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(absolute) : (await readFile(absolute)).byteLength;
  }
  return total;
}

function imageBytes(asset, imageIndex) {
  const image = asset.document.images?.[imageIndex];
  assert.ok(image, `runtime texture image ${imageIndex}`);
  if (Number.isInteger(image.bufferView)) {
    const view = asset.document.bufferViews[image.bufferView];
    const start = view.byteOffset ?? 0;
    return asset.binary.subarray(start, start + view.byteLength);
  }
  assert.ok(image.uri && !image.uri.startsWith("data:"), `image ${imageIndex} must be embedded or relative`);
  const filename = path.resolve(path.dirname(VILLAIN_FILE), decodeURIComponent(image.uri.split("?")[0]));
  const relative = path.relative(MODELS_ROOT, filename);
  assert.ok(!relative.startsWith("..") && !path.isAbsolute(relative), `image ${imageIndex} stays in public/models`);
  return readFileSync(filename);
}

function webpSourceForTexture(asset, textureIndex, label) {
  const texture = asset.document.textures?.[textureIndex];
  assert.ok(texture, `${label} texture ${textureIndex}`);
  const webp = texture.extensions?.EXT_texture_webp;
  assert.ok(webp && Number.isInteger(webp.source), `${label} must use EXT_texture_webp`);
  const image = asset.document.images?.[webp.source];
  assert.equal(image?.mimeType, "image/webp", `${label} runtime source MIME`);
  const bytes = imageBytes(asset, webp.source);
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", `${label} WebP RIFF signature`);
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", `${label} WebP format signature`);
  return webp.source;
}

function primitiveTriangles(document, primitive) {
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  const count = document.accessors?.[accessorIndex]?.count ?? 0;
  return count / 3;
}

function dominantMaterial(asset) {
  const trianglesByMaterial = new Map();
  for (const mesh of asset.document.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      assert.ok(Number.isInteger(primitive.material), "every villain primitive needs an authored material");
      const triangles = primitiveTriangles(asset.document, primitive);
      trianglesByMaterial.set(
        primitive.material,
        (trianglesByMaterial.get(primitive.material) ?? 0) + triangles,
      );
    }
  }
  const [index, triangles] = [...trianglesByMaterial.entries()].sort((left, right) => right[1] - left[1])[0] ?? [];
  assert.ok(Number.isInteger(index) && triangles > 0, "villain dominant material");
  return { index, triangles };
}

function component(attribute, index, componentIndex) {
  if (componentIndex === 0) return attribute.getX(index);
  if (componentIndex === 1) return attribute.getY(index);
  if (componentIndex === 2) return attribute.getZ(index);
  return attribute.getW(index);
}

function dynamicBounds(root) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  root.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    object.skeleton.update();
    object.computeBoundingBox();
    bounds.union(object.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  assert.equal(bounds.isEmpty(), false, "villain dynamic rest bounds");
  return bounds;
}

async function loadVillain() {
  const payload = await readFile(VILLAIN_FILE);
  const asset = { payload, ...parseGlb(payload) };
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith("file:")) return url;
    const filename = fileURLToPath(url);
    const bytes = readFileSync(filename);
    const extension = path.extname(filename).toLowerCase();
    const mime = extension === ".webp" ? "image/webp" : extension === ".png" ? "image/png" : "application/octet-stream";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  });
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const data = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  const resourcePath = `${pathToFileURL(path.dirname(VILLAIN_FILE)).href}/`;
  asset.gltf = await new Promise((resolve, reject) => loader.parse(data, resourcePath, resolve, reject));
  return asset;
}

const villainAsset = loadVillain();

test("A2 villain stays inside its GLB, repository, Meshopt, triangle, and material budgets", async () => {
  const asset = await villainAsset;
  const extensionsRequired = new Set(asset.document.extensionsRequired ?? []);
  assert.ok(extensionsRequired.has("EXT_meshopt_compression"), "villain requires Meshopt decoding");
  assert.ok(
    (asset.document.bufferViews ?? []).some((view) => view.extensions?.EXT_meshopt_compression),
    "villain contains Meshopt-compressed buffer views",
  );

  const meshes = [];
  const materialNames = new Set();
  asset.gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    meshes.push(object);
    assert.ok(object.geometry.getAttribute("color"), `${object.name} keeps the authored A2Tint COLOR_0 stream`);
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      materialNames.add(material.name);
      assert.equal(material.vertexColors, true, `${material.name} consumes A2Tint vertex colors`);
    });
  });
  const triangles = meshes.reduce(
    (total, mesh) => total + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position").count) / 3,
    0,
  );
  const publicModelsBytes = await directoryBytes(MODELS_ROOT);
  assert.deepEqual(
    {
      villainBytesWithinBudget: asset.payload.byteLength <= MAX_VILLAIN_BYTES,
      publicModelsWithinBudget: publicModelsBytes <= MAX_PUBLIC_MODELS_BYTES,
      trianglesWithinBudget: triangles >= MIN_VILLAIN_TRIANGLES && triangles <= MAX_VILLAIN_TRIANGLES,
      rawMaterialsWithinBudget: (asset.document.materials?.length ?? 0) <= MAX_MAIN_MATERIALS,
      runtimeMaterialsWithinBudget: materialNames.size <= MAX_MAIN_MATERIALS,
    },
    {
      villainBytesWithinBudget: true,
      publicModelsWithinBudget: true,
      trianglesWithinBudget: true,
      rawMaterialsWithinBudget: true,
      runtimeMaterialsWithinBudget: true,
    },
    `villain bytes=${asset.payload.byteLength}, public/models=${publicModelsBytes}, tris=${triangles}, raw/runtime materials=${asset.document.materials?.length ?? 0}/${materialNames.size}`,
  );
});

test("A2 villain dominant material exposes actual WebP BaseColor, Normal, Occlusion, and MR slots", async () => {
  const asset = await villainAsset;
  assert.ok((asset.document.extensionsUsed ?? []).includes("EXT_texture_webp"), "villain declares EXT_texture_webp");
  const dominant = dominantMaterial(asset);
  const material = asset.document.materials[dominant.index];
  const pbr = material.pbrMetallicRoughness ?? {};
  const slots = {
    BaseColor: pbr.baseColorTexture?.index,
    Normal: material.normalTexture?.index,
    Occlusion: material.occlusionTexture?.index,
    MetallicRoughness: pbr.metallicRoughnessTexture?.index,
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(slots).map(([name, index]) => [name, Number.isInteger(index)])),
    { BaseColor: true, Normal: true, Occlusion: true, MetallicRoughness: true },
    `dominant villain material ${material.name} must expose all runtime PBR slots`,
  );
  Object.entries(slots).forEach(([name, index]) => webpSourceForTexture(asset, index, name));

  const loadedByName = new Map();
  asset.gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const candidate of Array.isArray(object.material) ? object.material : [object.material]) {
      loadedByName.set(candidate.name, candidate);
    }
  });
  const runtimeMaterial = loadedByName.get(material.name);
  assert.ok(runtimeMaterial instanceof THREE.MeshStandardMaterial, "dominant material loads through GLTFLoader");
  assert.ok(runtimeMaterial.map, "runtime BaseColor map");
  assert.ok(runtimeMaterial.normalMap, "runtime Normal map");
  assert.ok(runtimeMaterial.aoMap, "runtime Occlusion map");
  assert.ok(runtimeMaterial.roughnessMap, "runtime Roughness map");
  assert.ok(runtimeMaterial.metalnessMap, "runtime Metallic map");
  assert.ok(decodedImageTypes.has("image/webp"), "GLTFLoader actually requests and decodes WebP image blobs");
});

test("A2 villain retains exactly one canonical 21-joint hierarchy and complete hand weighting", async () => {
  const asset = await villainAsset;
  assert.equal(asset.document.skins?.length, 1, "villain has one shared glTF skin");
  const skin = asset.document.skins[0];
  const jointNames = skin.joints.map((index) => asset.document.nodes[index]?.name);
  assert.equal(jointNames.length, CANONICAL_BONES.length, "villain canonical joint count");
  assert.deepEqual([...jointNames].sort(), [...CANONICAL_BONES].sort(), "villain canonical joint names");

  for (const boneName of CANONICAL_BONES) {
    assert.equal(
      asset.document.nodes.filter((node) => node.name === boneName).length,
      1,
      `${boneName} appears exactly once in the GLB node table`,
    );
  }
  const parentByNode = new Map();
  asset.document.nodes.forEach((node, parentIndex) => {
    (node.children ?? []).forEach((childIndex) => parentByNode.set(childIndex, parentIndex));
  });
  const joints = new Set(skin.joints);
  const actualParents = {};
  skin.joints.forEach((jointIndex) => {
    const parentIndex = parentByNode.get(jointIndex);
    actualParents[asset.document.nodes[jointIndex].name] = joints.has(parentIndex)
      ? asset.document.nodes[parentIndex].name
      : null;
  });
  assert.deepEqual(actualParents, CANONICAL_PARENT, "villain canonical parent hierarchy");

  const meshes = [];
  asset.gltf.scene.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  assert.ok(meshes.length > 0, "villain visible mesh count");
  assert.ok(meshes.every((mesh) => mesh instanceof THREE.SkinnedMesh), "every villain mesh uses the shared skin");
  const skeletons = new Set(meshes.map((mesh) => mesh.skeleton));
  assert.equal(skeletons.size, 1, "all villain meshes share one Three.js Skeleton instance");
  const skeleton = meshes[0].skeleton;
  assert.deepEqual(
    skeleton.bones.map((bone) => bone.name).sort(),
    [...CANONICAL_BONES].sort(),
    "Three.js skeleton bone names",
  );

  let vertexCount = 0;
  let zeroWeightVertices = 0;
  let maximumWeightError = 0;
  const handVertices = { LeftHand: 0, RightHand: 0 };
  for (const mesh of meshes) {
    const weights = mesh.geometry.getAttribute("skinWeight");
    const jointsAttribute = mesh.geometry.getAttribute("skinIndex");
    assert.ok(weights && jointsAttribute && weights.count === jointsAttribute.count, `${mesh.name} skin attributes`);
    const handIndices = {
      LeftHand: mesh.skeleton.bones.findIndex((bone) => bone.name === "LeftHand"),
      RightHand: mesh.skeleton.bones.findIndex((bone) => bone.name === "RightHand"),
    };
    assert.ok(handIndices.LeftHand >= 0 && handIndices.RightHand >= 0, `${mesh.name} hand joints`);
    for (let vertex = 0; vertex < weights.count; vertex += 1) {
      vertexCount += 1;
      const weightValues = Array.from({ length: 4 }, (_, componentIndex) => component(weights, vertex, componentIndex));
      const jointValues = Array.from({ length: 4 }, (_, componentIndex) => component(jointsAttribute, vertex, componentIndex));
      const sum = weightValues.reduce((total, value) => total + value, 0);
      if (sum <= 1e-8) zeroWeightVertices += 1;
      maximumWeightError = Math.max(maximumWeightError, Math.abs(sum - 1));
      for (const handName of Object.keys(handVertices)) {
        if (weightValues.some((weight, index) => weight > 1e-8 && jointValues[index] === handIndices[handName])) {
          handVertices[handName] += 1;
        }
      }
    }
  }
  const zeroWeightRatio = zeroWeightVertices / vertexCount;
  assert.ok(
    zeroWeightRatio < MAX_ZERO_WEIGHT_RATIO,
    `zero-weight vertices ${zeroWeightVertices}/${vertexCount} (${(zeroWeightRatio * 100).toFixed(4)}%)`,
  );
  assert.ok(handVertices.LeftHand > 0, `LeftHand influenced vertices=${handVertices.LeftHand}`);
  assert.ok(handVertices.RightHand > 0, `RightHand influenced vertices=${handVertices.RightHand}`);
  assert.ok(maximumWeightError <= 1e-3, `maximum skin-weight normalization error=${maximumWeightError}`);
});

test("A2 villain is scale-one, feet-on-ground, +Z-facing, and retains all nine A1 clips", async () => {
  const asset = await villainAsset;
  assert.ok(asset.gltf.scene.scale.distanceTo(new THREE.Vector3(1, 1, 1)) <= 1e-7, "villain GLB scene scale=1");
  const rigRoot = asset.gltf.scene.getObjectByName("Rig_Humanoid_Shared");
  assert.ok(rigRoot, "villain shared rig root");
  assert.ok(rigRoot.scale.distanceTo(new THREE.Vector3(1, 1, 1)) <= 1e-7, "villain authored rig scale=1");

  const bounds = dynamicBounds(asset.gltf.scene);
  assert.ok(Math.abs(bounds.min.y) <= 1e-3, `villain foot plane Y=${bounds.min.y}`);
  asset.gltf.scene.updateMatrixWorld(true);
  for (const side of ["Left", "Right"]) {
    const foot = asset.gltf.scene.getObjectByName(`${side}Foot`);
    const toes = asset.gltf.scene.getObjectByName(`${side}Toes`);
    assert.ok(foot && toes, `${side} foot direction bones`);
    const footPosition = foot.getWorldPosition(new THREE.Vector3());
    const toesPosition = toes.getWorldPosition(new THREE.Vector3());
    assert.ok(
      toesPosition.z - footPosition.z > 0.05,
      `${side} toes extend toward canonical +Z; delta=${toesPosition.z - footPosition.z}`,
    );
  }

  assert.deepEqual(asset.gltf.animations.map((clip) => clip.name), EXPECTED_CLIPS, "villain A1 clip names/order");
  for (const clip of asset.gltf.animations) {
    assert.ok(clip.duration > 0, `${clip.name} duration`);
    assert.ok(clip.tracks.length > 0, `${clip.name} animated tracks`);
  }
});
