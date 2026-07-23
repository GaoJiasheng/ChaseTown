import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

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

const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BINARY_CHUNK = 0x004e4942;
const COMPONENT_BYTES = new Map([
  [5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4],
]);
const TYPE_COMPONENTS = new Map([
  ["SCALAR", 1], ["VEC2", 2], ["VEC3", 3], ["VEC4", 4],
  ["MAT2", 4], ["MAT3", 9], ["MAT4", 16],
]);

function readGlb(buffer, filename) {
  assert.ok(buffer.length >= 20, `${filename} is too short to contain a valid GLB`);
  assert.equal(buffer.subarray(0, 4).toString("ascii"), "glTF", `${filename} is not a binary GLB`);
  assert.equal(buffer.readUInt32LE(4), 2, `${filename} must use glTF 2.0`);
  assert.equal(buffer.readUInt32LE(8), buffer.length, `${filename} has an invalid declared length`);
  let offset = 12;
  const chunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    assert.ok(end <= buffer.length, `${filename} contains a truncated GLB chunk`);
    assert.equal(length % 4, 0, `${filename} chunk payloads must be four-byte aligned`);
    chunks.push({ type, start, end, length });
    offset = end;
  }
  assert.equal(offset, buffer.length, `${filename} has trailing bytes outside its GLB chunks`);
  assert.equal(chunks[0]?.type, GLB_JSON_CHUNK, `${filename} must start with a JSON chunk`);
  assert.equal(chunks.filter(({ type }) => type === GLB_JSON_CHUNK).length, 1, `${filename} must contain exactly one JSON chunk`);
  assert.ok(chunks.every(({ type }) => type === GLB_JSON_CHUNK || type === GLB_BINARY_CHUNK), `${filename} contains an unsupported GLB chunk`);
  assert.ok(chunks.filter(({ type }) => type === GLB_BINARY_CHUNK).length <= 1, `${filename} contains multiple binary chunks`);
  const jsonChunk = chunks[0];
  const json = JSON.parse(buffer.subarray(jsonChunk.start, jsonChunk.end).toString("utf8").replace(/[\0 ]+$/u, "").trim());
  const binaryChunk = chunks.find(({ type }) => type === GLB_BINARY_CHUNK);
  return { json, binary: binaryChunk ? buffer.subarray(binaryChunk.start, binaryChunk.end) : null };
}

function assertIndex(index, length, message) {
  assert.ok(Number.isInteger(index) && index >= 0 && index < length, message);
}

function assertFiniteArray(values, expectedLength, message) {
  assert.equal(values.length, expectedLength, `${message} has the wrong component count`);
  assert.ok(values.every(Number.isFinite), `${message} contains a non-finite component`);
}

function validateGlbStructure({ json: gltf, binary }, filename) {
  assert.equal(gltf.asset?.version, "2.0", `${filename} must declare glTF 2.0`);
  assert.ok((gltf.scenes?.length ?? 0) > 0, `${filename} must contain a scene`);
  assertIndex(gltf.scene ?? 0, gltf.scenes.length, `${filename} has an invalid default scene`);
  const buffers = gltf.buffers ?? [];
  const physicalBuffers = buffers.filter((buffer) => !buffer.extensions?.EXT_meshopt_compression?.fallback);
  const fallbackBuffers = buffers.filter((buffer) => buffer.extensions?.EXT_meshopt_compression?.fallback);
  assert.ok(physicalBuffers.length <= 1, `${filename} GLB must use one embedded physical geometry buffer`);
  assert.ok(fallbackBuffers.length <= 1, `${filename} has multiple Meshopt fallback buffers`);
  if (fallbackBuffers.length) {
    assert.ok(gltf.extensionsRequired?.includes("EXT_meshopt_compression"), `${filename} must require its Meshopt fallback contract`);
  }
  if (physicalBuffers.length) {
    const physicalBuffer = physicalBuffers[0];
    assert.equal(physicalBuffer.uri, undefined, `${filename} geometry must remain embedded in the GLB`);
    assert.ok(binary, `${filename} declares an embedded buffer without a BIN chunk`);
    assert.ok(physicalBuffer.byteLength <= binary.length, `${filename} BIN chunk is shorter than its declared buffer`);
    assert.ok(binary.length - physicalBuffer.byteLength <= 3, `${filename} BIN chunk contains excessive alignment padding`);
  }

  for (const [index, view] of (gltf.bufferViews ?? []).entries()) {
    assertIndex(view.buffer, gltf.buffers?.length ?? 0, `${filename} bufferView ${index} references an invalid buffer`);
    const byteOffset = view.byteOffset ?? 0;
    assert.ok(Number.isInteger(byteOffset) && byteOffset >= 0, `${filename} bufferView ${index} has an invalid byteOffset`);
    assert.ok(Number.isInteger(view.byteLength) && view.byteLength >= 0, `${filename} bufferView ${index} has an invalid byteLength`);
    assert.ok(byteOffset + view.byteLength <= gltf.buffers[view.buffer].byteLength, `${filename} bufferView ${index} exceeds its buffer`);
    if (view.byteStride !== undefined) {
      assert.ok(Number.isInteger(view.byteStride) && view.byteStride >= 4 && view.byteStride <= 252 && view.byteStride % 4 === 0, `${filename} bufferView ${index} has an invalid byteStride`);
    }
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression) {
      assert.ok(gltf.extensionsRequired?.includes("EXT_meshopt_compression"), `${filename} bufferView ${index} does not declare Meshopt`);
      assertIndex(compression.buffer, gltf.buffers?.length ?? 0, `${filename} bufferView ${index} Meshopt source is invalid`);
      assert.ok(Number.isInteger(compression.byteOffset ?? 0) && (compression.byteOffset ?? 0) >= 0, `${filename} bufferView ${index} has an invalid Meshopt byteOffset`);
      assert.ok(Number.isInteger(compression.byteLength) && compression.byteLength > 0, `${filename} bufferView ${index} has an invalid Meshopt byteLength`);
      assert.ok((compression.byteOffset ?? 0) + compression.byteLength <= gltf.buffers[compression.buffer].byteLength, `${filename} bufferView ${index} exceeds its Meshopt source buffer`);
      assert.ok(Number.isInteger(compression.byteStride) && compression.byteStride > 0 && compression.byteStride <= 256, `${filename} bufferView ${index} has an invalid Meshopt byteStride`);
      assert.ok(Number.isInteger(compression.count) && compression.count > 0, `${filename} bufferView ${index} has an invalid Meshopt count`);
      assert.ok(["ATTRIBUTES", "TRIANGLES", "INDICES"].includes(compression.mode), `${filename} bufferView ${index} has an invalid Meshopt mode`);
    }
  }

  for (const [index, accessor] of (gltf.accessors ?? []).entries()) {
    const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
    const componentCount = TYPE_COMPONENTS.get(accessor.type);
    assert.ok(componentBytes, `${filename} accessor ${index} has an invalid componentType`);
    assert.ok(componentCount, `${filename} accessor ${index} has an invalid type`);
    assert.ok(Number.isInteger(accessor.count) && accessor.count >= 0, `${filename} accessor ${index} has an invalid count`);
    const elementBytes = componentBytes * componentCount;
    if (accessor.bufferView !== undefined) {
      assertIndex(accessor.bufferView, gltf.bufferViews?.length ?? 0, `${filename} accessor ${index} references an invalid bufferView`);
      const view = gltf.bufferViews[accessor.bufferView];
      const accessorOffset = accessor.byteOffset ?? 0;
      const stride = view.byteStride ?? elementBytes;
      const requiredBytes = accessor.count === 0 ? accessorOffset : accessorOffset + (accessor.count - 1) * stride + elementBytes;
      assert.ok(requiredBytes <= view.byteLength, `${filename} accessor ${index} exceeds its bufferView`);
    } else {
      assert.ok(accessor.sparse, `${filename} accessor ${index} needs a bufferView or sparse payload`);
    }
    for (const [label, values] of [["min", accessor.min], ["max", accessor.max]]) {
      if (!values) continue;
      assertFiniteArray(values, componentCount, `${filename} accessor ${index} ${label}`);
    }
    if (accessor.min && accessor.max) {
      assert.ok(accessor.min.every((value, component) => value <= accessor.max[component]), `${filename} accessor ${index} has inverted bounds`);
    }
  }

  for (const [index, mesh] of (gltf.meshes ?? []).entries()) {
    assert.ok(mesh.primitives?.length > 0, `${filename} mesh ${index} has no primitives`);
    for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
      assert.ok(primitive.attributes && primitive.attributes.POSITION !== undefined, `${filename} mesh ${index}/${primitiveIndex} has no POSITION attribute`);
      for (const [semantic, accessorIndex] of Object.entries(primitive.attributes)) {
        assertIndex(accessorIndex, gltf.accessors?.length ?? 0, `${filename} mesh ${index}/${primitiveIndex} ${semantic} references an invalid accessor`);
      }
      if (primitive.indices !== undefined) {
        assertIndex(primitive.indices, gltf.accessors?.length ?? 0, `${filename} mesh ${index}/${primitiveIndex} has invalid indices`);
        assert.equal(gltf.accessors[primitive.indices].type, "SCALAR", `${filename} mesh ${index}/${primitiveIndex} indices must be scalar`);
      }
      if (primitive.material !== undefined) assertIndex(primitive.material, gltf.materials?.length ?? 0, `${filename} mesh ${index}/${primitiveIndex} has an invalid material`);
    }
  }

  for (const [index, node] of (gltf.nodes ?? []).entries()) {
    if (node.mesh !== undefined) assertIndex(node.mesh, gltf.meshes?.length ?? 0, `${filename} node ${index} has an invalid mesh`);
    if (node.skin !== undefined) assertIndex(node.skin, gltf.skins?.length ?? 0, `${filename} node ${index} has an invalid skin`);
    for (const child of node.children ?? []) assertIndex(child, gltf.nodes.length, `${filename} node ${index} has an invalid child`);
    if (node.matrix) assertFiniteArray(node.matrix, 16, `${filename} node ${index} matrix`);
    if (node.translation) assertFiniteArray(node.translation, 3, `${filename} node ${index} translation`);
    if (node.rotation) assertFiniteArray(node.rotation, 4, `${filename} node ${index} rotation`);
    if (node.scale) {
      assertFiniteArray(node.scale, 3, `${filename} node ${index} scale`);
      assert.ok(node.scale.every((value) => Math.abs(value) >= 1e-5 && Math.abs(value) <= 100), `${filename} node ${index} has a degenerate or extreme scale`);
    }
  }
  for (const [index, scene] of gltf.scenes.entries()) {
    for (const node of scene.nodes ?? []) assertIndex(node, gltf.nodes?.length ?? 0, `${filename} scene ${index} has an invalid root node`);
  }

  for (const [index, image] of (gltf.images ?? []).entries()) {
    assert.ok(image.uri || image.bufferView !== undefined, `${filename} image ${index} has no payload`);
    if (image.bufferView !== undefined) assertIndex(image.bufferView, gltf.bufferViews?.length ?? 0, `${filename} image ${index} has an invalid bufferView`);
  }
  for (const [index, texture] of (gltf.textures ?? []).entries()) {
    if (texture.source !== undefined) assertIndex(texture.source, gltf.images?.length ?? 0, `${filename} texture ${index} has an invalid image source`);
    if (texture.sampler !== undefined) assertIndex(texture.sampler, gltf.samplers?.length ?? 0, `${filename} texture ${index} has an invalid sampler`);
  }

  const textureSlots = (material) => [
    material.pbrMetallicRoughness?.baseColorTexture,
    material.pbrMetallicRoughness?.metallicRoughnessTexture,
    material.normalTexture,
    material.occlusionTexture,
    material.emissiveTexture,
  ].filter(Boolean);
  for (const [index, material] of (gltf.materials ?? []).entries()) {
    for (const slot of textureSlots(material)) assertIndex(slot.index, gltf.textures?.length ?? 0, `${filename} material ${index} has an invalid texture`);
    const pbr = material.pbrMetallicRoughness ?? {};
    if (pbr.baseColorFactor) {
      assertFiniteArray(pbr.baseColorFactor, 4, `${filename} material ${index} baseColorFactor`);
      assert.ok(pbr.baseColorFactor.every((value) => value >= 0 && value <= 1), `${filename} material ${index} baseColorFactor is out of range`);
    }
    for (const [label, value] of [["metallicFactor", pbr.metallicFactor], ["roughnessFactor", pbr.roughnessFactor]]) {
      if (value !== undefined) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${filename} material ${index} ${label} is out of range`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (nodeIndex) => {
    assert.equal(visiting.has(nodeIndex), false, `${filename} node hierarchy contains a cycle at ${nodeIndex}`);
    if (visited.has(nodeIndex)) return;
    visiting.add(nodeIndex);
    for (const child of gltf.nodes[nodeIndex].children ?? []) visit(child);
    visiting.delete(nodeIndex);
    visited.add(nodeIndex);
  };
  for (const scene of gltf.scenes) for (const root of scene.nodes ?? []) visit(root);
}

function localNodeMatrix(node, includeTranslation = true) {
  if (node.matrix) {
    const matrix = new THREE.Matrix4().fromArray(node.matrix);
    if (!includeTranslation) matrix.setPosition(0, 0, 0);
    return matrix;
  }
  return new THREE.Matrix4().compose(
    includeTranslation ? new THREE.Vector3(...(node.translation ?? [0, 0, 0])) : new THREE.Vector3(),
    new THREE.Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(node.scale ?? [1, 1, 1])),
  );
}

function meshBounds(gltf, meshIndex, label) {
  const box = new THREE.Box3();
  for (const primitive of gltf.meshes[meshIndex].primitives) {
    const accessor = gltf.accessors[primitive.attributes.POSITION];
    assert.ok(accessor.min && accessor.max, `${label} POSITION accessor must expose bounds`);
    assertFiniteArray(accessor.min, 3, `${label} POSITION min`);
    assertFiniteArray(accessor.max, 3, `${label} POSITION max`);
    box.union(new THREE.Box3(new THREE.Vector3(...accessor.min), new THREE.Vector3(...accessor.max)));
  }
  return box;
}

function subtreeBounds(gltf, rootIndex, includeRootTransform = false) {
  const result = new THREE.Box3();
  const walkNode = (nodeIndex, parentMatrix, root = false) => {
    const node = gltf.nodes[nodeIndex];
    const matrix = parentMatrix.clone().multiply(localNodeMatrix(node, !root || includeRootTransform));
    if (node.mesh !== undefined) result.union(meshBounds(gltf, node.mesh, node.name || `node ${nodeIndex}`).applyMatrix4(matrix));
    for (const child of node.children ?? []) walkNode(child, matrix, false);
  };
  walkNode(rootIndex, new THREE.Matrix4(), true);
  return result;
}

function sceneBounds(gltf) {
  const result = new THREE.Box3();
  for (const root of gltf.scenes[gltf.scene ?? 0].nodes ?? []) result.union(subtreeBounds(gltf, root, true));
  return result;
}

function boxMetrics(box, label) {
  assert.equal(box.isEmpty(), false, `${label} has no renderable geometry`);
  const size = box.getSize(new THREE.Vector3());
  assert.ok([size.x, size.y, size.z].every(Number.isFinite), `${label} has non-finite bounds`);
  return { box, size, volume: size.x * size.y * size.z };
}

function triangleCount(gltf) {
  return (gltf.meshes ?? []).reduce((total, mesh) => total + mesh.primitives.reduce((meshTotal, primitive) => {
    const accessorIndex = primitive.indices ?? primitive.attributes.POSITION;
    const vertices = gltf.accessors?.[accessorIndex]?.count ?? 0;
    return meshTotal + vertices / 3;
  }, 0), 0);
}

function subtreeTriangleCount(gltf, rootIndex) {
  let total = 0;
  const visit = (nodeIndex) => {
    const node = gltf.nodes[nodeIndex];
    // Count rendered instances, not only unique mesh buffers. Meshopt safely
    // deduplicates repeated authored pieces (bolts, rails, trophy cups), while
    // every node instance still contributes to the visible silhouette.
    if (node.mesh !== undefined) {
      total += gltf.meshes[node.mesh].primitives.reduce((sum, primitive) => {
        const accessorIndex = primitive.indices ?? primitive.attributes.POSITION;
        return sum + (gltf.accessors[accessorIndex]?.count ?? 0) / 3;
      }, 0);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(rootIndex);
  return total;
}

function subtreeNodeIndexes(gltf, rootIndex) {
  const result = [];
  const visit = (nodeIndex) => {
    result.push(nodeIndex);
    for (const child of gltf.nodes[nodeIndex].children ?? []) visit(child);
  };
  visit(rootIndex);
  return result;
}

function subtreeMeshIndexes(gltf, rootIndex) {
  return new Set(
    subtreeNodeIndexes(gltf, rootIndex)
      .map((nodeIndex) => gltf.nodes[nodeIndex].mesh)
      .filter((meshIndex) => meshIndex !== undefined),
  );
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

  assert.equal(shipped.length, 26, "the compact shared 22-model set plus four campaign theme kits must be retained");
  assert.deepEqual([...shipped].sort(), [...referenced].sort(), "runtime code and shipped GLBs must stay in sync");
  const referencedImages = new Set();

  for (const publicPath of shipped) {
    const filename = path.join(ROOT, "public", publicPath.slice(1));
    const info = await stat(filename);
    assert.ok(info.size > 1024, `${publicPath} looks empty or like pointer text`);

    const buffer = await readFile(filename);
    assert.doesNotMatch(buffer.subarray(0, 160).toString("utf8"), /git-lfs/iu, `${publicPath} must not be an LFS pointer`);
    const glb = readGlb(buffer, publicPath);
    validateGlbStructure(glb, publicPath);
    const gltf = glb.json;

    if (publicPath.includes("/environment/")) {
      assert.ok(
        gltf.extensionsRequired?.includes("EXT_meshopt_compression"),
        `${publicPath} must use the pinned lossless Meshopt transport`,
      );
      for (const [meshIndex, mesh] of (gltf.meshes ?? []).entries()) {
        for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
          const material = primitive.material === undefined ? undefined : gltf.materials?.[primitive.material];
          if (!material?.normalTexture) continue;
          assert.notEqual(
            primitive.attributes.TANGENT,
            undefined,
            `${publicPath} mesh ${meshIndex}/${primitiveIndex} must ship explicit tangent frames`,
          );
        }
      }
    }

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
      assert.ok(
        gltf.extensionsRequired?.includes("EXT_meshopt_compression"),
        `${publicPath} must use the pinned character Meshopt transport`,
      );
      assert.equal(
        gltf.extensionsRequired?.includes("KHR_mesh_quantization"),
        false,
        `${publicPath} must retain authored floating-point geometry`,
      );
    }
  }

  const shippedImages = files.filter((filename) => filename.endsWith(".png"));
  assert.deepEqual(
    shippedImages.sort(),
    [...referencedImages].sort(),
    "public/models must not contain unreferenced texture exports",
  );
});

const THEME_KIT_CONTRACTS = [
  {
    basename: "campus-kit.glb",
    maxBytes: 2_850_000,
    prefixes: ["Campus"],
    heroFamilies: [
      ["CampusTrophyCase"], ["CampusVendingMachine"], ["CampusWaterFountain"],
      ["CampusBikeRack"], ["CampusWayfinding"],
    ],
    storySets: [
      {
        propSet: "campus-classic",
        landmarks: ["CampusClassroomCluster", "CampusCourtyardCluster", "CampusClassicLandmark"],
        arrival: "CampusClassicArrivalCluster",
        exit: "CampusGateDressing",
        hide: "CampusClassicHideDressing",
      },
      {
        propSet: "campus-library",
        landmarks: ["CampusLibraryShelves", "CampusReadingCluster", "CampusArchiveCluster"],
        arrival: "CampusLibraryArrivalCluster",
        exit: "CampusLibraryExitCluster",
        hide: "CampusLibraryHideDressing",
      },
      {
        propSet: "campus-science",
        landmarks: ["CampusLabBenchCluster", "CampusFumeHoodCluster", "CampusGreenhouseCluster"],
        arrival: "CampusScienceArrivalCluster",
        exit: "CampusScienceExitCluster",
        hide: "CampusScienceHideDressing",
      },
    ],
  },
  {
    basename: "hospital-kit.glb",
    maxBytes: 2_000_000,
    prefixes: ["Hospital"],
    heroFamilies: [
      ["HospitalBed"], ["HospitalCrashCart"], ["HospitalIVStation"],
      ["HospitalWheelchair"], ["HospitalPrivacyScreen"], ["HospitalWayfinding"],
    ],
    storySets: [
      {
        propSet: "hospital-outpatient",
        landmarks: ["HospitalTriageCluster", "HospitalWaitingCluster", "HospitalPharmacyCluster"],
        arrival: "HospitalOutpatientArrivalCluster",
        exit: "HospitalOutpatientExitCluster",
        hide: "HospitalOutpatientHideDressing",
        reuse: "HospitalIVStation",
      },
      {
        propSet: "hospital-isolation",
        landmarks: ["HospitalDeconCluster", "HospitalIsolationWardCluster", "HospitalAirlockCluster"],
        arrival: "HospitalIsolationArrivalCluster",
        exit: "HospitalIsolationExitCluster",
        hide: "HospitalIsolationHideDressing",
      },
    ],
  },
  {
    basename: "fire-station-kit.glb",
    maxBytes: 2_500_000,
    prefixes: ["FireStation", "Fire"],
    heroFamilies: [
      ["FireStationEngine", "FireEngine"], ["FireStationGearRack", "FireGearRack"],
      ["FireStationHoseReel", "FireHoseReel"], ["FireStationHydrant", "FireHydrant"],
      ["FireStationWayfinding", "FireWayfinding"], ["FireStationSafetyCones", "FireSafetyCones"],
    ],
    storySets: [
      {
        propSet: "fire-engine-bay",
        landmarks: ["FireStationEngineBayCluster", "FireStationTurnoutCluster", "FireStationHoseServiceCluster"],
        arrival: "FireStationEngineBayArrivalCluster",
        exit: "FireStationEngineBayExitCluster",
        hide: "FireStationEngineBayHideDressing",
        reuse: "FireStationWayfinding",
      },
      {
        propSet: "fire-training",
        landmarks: ["FireStationTrainingCluster", "FireStationRopeRescueCluster", "FireStationBreathingGearCluster"],
        arrival: "FireStationTrainingArrivalCluster",
        exit: "FireStationTrainingExitCluster",
        hide: "FireStationTrainingHideDressing",
        reuse: "FireSafetyCones",
      },
    ],
  },
  {
    basename: "factory-kit.glb",
    maxBytes: 2_950_000,
    prefixes: ["Factory"],
    heroFamilies: [
      ["FactoryPipeAssembly"], ["FactoryStorageTank"], ["FactoryControlConsole"],
      ["FactoryConveyor"], ["FactorySafetyBarrier"], ["FactoryCrateStack"],
    ],
    storySets: [
      {
        propSet: "factory-assembly",
        landmarks: ["FactoryAssemblyLineCluster", "FactoryRobotCellCluster", "FactoryInspectionCluster"],
        arrival: "FactoryAssemblyArrivalCluster",
        exit: "FactoryAssemblyExitCluster",
        hide: "FactoryAssemblyHideDressing",
      },
      {
        propSet: "factory-turbine",
        landmarks: ["FactoryTurbineCluster", "FactoryHighPressurePipeCluster", "FactoryBreakerCluster"],
        arrival: "FactoryTurbineArrivalCluster",
        exit: "FactoryTurbineExitCluster",
        hide: "FactoryTurbineHideDressing",
      },
      {
        propSet: "factory-foundry",
        landmarks: ["FactoryFurnaceCluster", "FactoryCastingCluster", "FactoryCoolingCluster"],
        arrival: "FactoryFoundryArrivalCluster",
        exit: "FactoryFoundryExitCluster",
        hide: "FactoryFoundryHideDressing",
      },
    ],
  },
];

const expandNames = (prefixes, suffixes) => prefixes.flatMap((prefix) => suffixes.map((suffix) => `${prefix}${suffix}`));

function requiredNodeIndex(gltf, compatibleNames, label) {
  const index = gltf.nodes.findIndex((node) => compatibleNames.includes(node.name));
  assert.notEqual(index, -1, `${label} is missing; accepted names: ${compatibleNames.join(", ")}`);
  return index;
}

function assertCanonicalRootTransform(gltf, nodeIndex, label) {
  const node = gltf.nodes[nodeIndex];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  const scale = node.scale ?? [1, 1, 1];
  assert.equal(node.extras?.authored_scale_meters, true, `${label} must declare authored metre scale`);
  assert.ok(typeof node.extras?.chasing_semantic === "string" && node.extras.chasing_semantic.length > 0, `${label} must declare a semantic role`);
  assert.ok(rotation.every((value, index) => Math.abs(value - [0, 0, 0, 1][index]) <= 1e-5), `${label} must use the shared +Z-facing root orientation`);
  assert.ok(scale.every((value) => Math.abs(value - 1) <= 1e-5), `${label} must apply real dimensions instead of root scale compensation`);
}

function assertWallModule(gltf, nodeIndex, label) {
  assertCanonicalRootTransform(gltf, nodeIndex, label);
  const { box, size, volume } = boxMetrics(subtreeBounds(gltf, nodeIndex), label);
  assert.ok(size.x >= 1.75 && size.x <= 2.45, `${label} must remain a two-metre wall module; width=${size.x}`);
  assert.ok(size.y >= 1.6 && size.y <= 3.5, `${label} has an implausible wall height ${size.y}`);
  assert.ok(size.z >= 0.06 && size.z <= 1.2, `${label} has an implausible wall depth ${size.z}`);
  assert.ok(box.max.z > Math.abs(box.min.z) + 0.005, `${label} detail must project toward local +Z (the corridor face)`);
  assert.ok(volume <= 10, `${label} exceeds the wall-module volume budget`);
}

function assertFloorModule(gltf, nodeIndex, label) {
  assertCanonicalRootTransform(gltf, nodeIndex, label);
  const { size, volume } = boxMetrics(subtreeBounds(gltf, nodeIndex), label);
  assert.ok(size.x >= 1.8 && size.x <= 2.2, `${label} must remain a two-metre floor tile; width=${size.x}`);
  assert.ok(size.z >= 1.8 && size.z <= 2.2, `${label} must remain a two-metre floor tile; depth=${size.z}`);
  assert.ok(size.y >= 0.015 && size.y <= 0.5, `${label} has an implausible floor thickness ${size.y}`);
  assert.ok(volume <= 2.2, `${label} exceeds the floor-module volume budget`);
}

for (const contract of THEME_KIT_CONTRACTS) {
  test(`campaign theme kit ${contract.basename} satisfies the production module, PBR and budget contracts`, async () => {
    const { basename, prefixes } = contract;
    const filename = path.join(MODELS_ROOT, "environment", "themes", basename);
    const buffer = await readFile(filename);
    const glb = readGlb(buffer, basename);
    validateGlbStructure(glb, basename);
    const gltf = glb.json;
    const nodeNames = (gltf.nodes ?? []).map((node) => node.name).filter(Boolean);
    assert.equal(new Set(nodeNames).size, nodeNames.length, `${basename} node names must be unique for runtime lookup`);

    for (const [index, family] of contract.heroFamilies.entries()) {
      const nodeIndex = requiredNodeIndex(gltf, family, `${basename} hero prop ${index + 1}`);
      const { size, volume } = boxMetrics(subtreeBounds(gltf, nodeIndex), `${basename} ${gltf.nodes[nodeIndex].name}`);
      const heroTriangles = subtreeTriangleCount(gltf, nodeIndex);
      assert.ok(Math.max(size.x, size.y, size.z) >= 0.25, `${basename} ${gltf.nodes[nodeIndex].name} is placeholder-sized`);
      assert.ok(Math.max(size.x, size.y, size.z) <= 8, `${basename} ${gltf.nodes[nodeIndex].name} exceeds the hero-prop size budget`);
      assert.ok(volume <= 160, `${basename} ${gltf.nodes[nodeIndex].name} exceeds the hero-prop volume budget`);
      assert.ok(heroTriangles >= (index < 2 ? 1_000 : 150), `${basename} ${gltf.nodes[nodeIndex].name} lacks production silhouette detail`);
    }

    const wallFamilies = [
      ["ArchitectureWallA", "ArchitectureWall"],
      ["ArchitectureWallB"],
      ["ArchitectureWallC"],
      ["ArchitectureWallEnd"],
      ["ArchitectureDoorway", "ArchitectureDoorBay"],
    ];
    const wallHeights = [];
    for (const suffixes of wallFamilies) {
      const names = expandNames(prefixes, suffixes);
      const nodeIndex = requiredNodeIndex(gltf, names, `${basename} ${suffixes[0]}`);
      assertWallModule(gltf, nodeIndex, `${basename} ${gltf.nodes[nodeIndex].name}`);
      const triangleMinimum = suffixes[0] === "ArchitectureWallB" || suffixes[0] === "ArchitectureWallC" ? 260 : 100;
      assert.ok(subtreeTriangleCount(gltf, nodeIndex) >= triangleMinimum, `${basename} ${gltf.nodes[nodeIndex].name} is placeholder wall geometry`);
      if (suffixes[0].startsWith("ArchitectureWall") && suffixes[0] !== "ArchitectureWallEnd") {
        wallHeights.push(boxMetrics(subtreeBounds(gltf, nodeIndex), `${basename} ${gltf.nodes[nodeIndex].name}`).size.y);
      }
    }
    assert.ok(Math.max(...wallHeights) - Math.min(...wallHeights) >= 0.08, `${basename} A/B/C walls need visibly different skyline profiles`);

    const wideWallIndex = requiredNodeIndex(gltf, expandNames(prefixes, ["ArchitectureWallWide"]), `${basename} ArchitectureWallWide`);
    assertCanonicalRootTransform(gltf, wideWallIndex, `${basename} ArchitectureWallWide`);
    const wideWall = boxMetrics(subtreeBounds(gltf, wideWallIndex), `${basename} ArchitectureWallWide`);
    assert.ok(wideWall.size.x >= 3.9 && wideWall.size.x <= 4.2, `${basename} ArchitectureWallWide must cover exactly two grid bays`);
    assert.ok(wideWall.size.z >= 0.18 && wideWall.size.z <= 0.5, `${basename} ArchitectureWallWide has an invalid depth`);
    assert.ok(wideWall.size.y >= 2.3 && wideWall.size.y <= 2.8, `${basename} ArchitectureWallWide has an invalid skyline`);
    const wideWallTriangles = subtreeTriangleCount(gltf, wideWallIndex);
    assert.ok(wideWallTriangles >= 400, `${basename} ArchitectureWallWide lacks continuous authored detail (${wideWallTriangles} tris)`);
    assert.equal(gltf.nodes[wideWallIndex].extras?.chasing_continuous_span_meters, 4, `${basename} ArchitectureWallWide must declare its four-metre span`);

    const cornerIndex = requiredNodeIndex(gltf, expandNames(prefixes, ["ArchitectureCorner"]), `${basename} ArchitectureCorner`);
    assertCanonicalRootTransform(gltf, cornerIndex, `${basename} ArchitectureCorner`);
    const corner = boxMetrics(subtreeBounds(gltf, cornerIndex), `${basename} ArchitectureCorner`);
    assert.ok(corner.size.x >= 0.4 && corner.size.x <= 2.6, `${basename} ArchitectureCorner has an invalid X footprint`);
    assert.ok(corner.size.z >= 0.4 && corner.size.z <= 2.6, `${basename} ArchitectureCorner has an invalid Z footprint`);
    assert.ok(corner.size.y >= 1.6 && corner.size.y <= 3.5, `${basename} ArchitectureCorner has an invalid height`);
    assert.ok(corner.volume <= 24, `${basename} ArchitectureCorner exceeds its volume budget`);
    assert.ok(subtreeTriangleCount(gltf, cornerIndex) >= 120, `${basename} ArchitectureCorner is placeholder geometry`);

    const junctionIndex = requiredNodeIndex(gltf, expandNames(prefixes, ["ArchitectureJunction"]), `${basename} ArchitectureJunction`);
    assertCanonicalRootTransform(gltf, junctionIndex, `${basename} ArchitectureJunction`);
    const junction = boxMetrics(subtreeBounds(gltf, junctionIndex), `${basename} ArchitectureJunction`);
    assert.ok(junction.size.x >= 1.65 && junction.size.x <= 2.4, `${basename} ArchitectureJunction has an invalid X footprint`);
    assert.ok(junction.size.z >= 1.65 && junction.size.z <= 2.4, `${basename} ArchitectureJunction has an invalid Z footprint`);
    assert.ok(junction.box.min.y >= 1.5, `${basename} ArchitectureJunction must preserve player head clearance`);
    assert.ok(junction.box.max.y >= 2.45 && junction.box.max.y <= 3.1, `${basename} ArchitectureJunction has an invalid crown height`);
    assert.ok(junction.size.y >= 0.8 && junction.size.y <= 1.4, `${basename} ArchitectureJunction overhead structure is too thin or bulky`);
    assert.ok(subtreeTriangleCount(gltf, junctionIndex) >= 300, `${basename} ArchitectureJunction lacks authored curved silhouette detail`);
    assert.equal(gltf.nodes[junctionIndex].extras?.chasing_choice_landmark, true, `${basename} ArchitectureJunction must declare its gameplay landmark role`);

    const floorFamilies = [
      ["FloorPrimary", "FloorA"],
      ["FloorSecondary", "FloorB"],
      ["FloorService", "FloorC"],
      ["ExteriorGround", "GroundExterior"],
    ];
    for (const suffixes of floorFamilies) {
      const names = expandNames(prefixes, suffixes);
      const nodeIndex = requiredNodeIndex(gltf, names, `${basename} ${suffixes[0]}`);
      assertFloorModule(gltf, nodeIndex, `${basename} ${gltf.nodes[nodeIndex].name}`);
      assert.ok(subtreeTriangleCount(gltf, nodeIndex) >= 50, `${basename} ${gltf.nodes[nodeIndex].name} lacks authored floor dressing`);
    }

    const dressingFamilies = [
      ["DecorClusterA", "DressingClusterA"],
      ["DecorClusterB", "DressingClusterB"],
      ["DecorClusterC", "DressingClusterC"],
      ["HideDressing", "HideSpotDressing"],
    ];
    for (const [dressingIndex, suffixes] of dressingFamilies.entries()) {
      const names = expandNames(prefixes, suffixes);
      const nodeIndex = requiredNodeIndex(gltf, names, `${basename} ${suffixes[0]}`);
      assertCanonicalRootTransform(gltf, nodeIndex, `${basename} ${gltf.nodes[nodeIndex].name}`);
      const { size, volume } = boxMetrics(subtreeBounds(gltf, nodeIndex), `${basename} ${gltf.nodes[nodeIndex].name}`);
      assert.ok(Math.max(size.x, size.y, size.z) <= 12, `${basename} ${gltf.nodes[nodeIndex].name} exceeds the dressing footprint budget`);
      assert.ok(volume <= 500, `${basename} ${gltf.nodes[nodeIndex].name} exceeds the dressing volume budget`);
      assert.ok(subtreeTriangleCount(gltf, nodeIndex) >= (dressingIndex === 3 ? 200 : 180), `${basename} ${gltf.nodes[nodeIndex].name} is placeholder dressing`);
    }

    const topLevelRoots = new Set(gltf.scenes[gltf.scene ?? 0].nodes ?? []);
    const storyMeshSignatures = [];
    for (const storySet of contract.storySets) {
      const expectedRoots = [
        ...storySet.landmarks.map((name) => ({ name, role: "landmark" })),
        { name: storySet.arrival, role: "arrival" },
        { name: storySet.exit, role: "exit" },
        { name: storySet.hide, role: "hide-dressing" },
      ];
      for (const expected of expectedRoots) {
        const nodeIndex = requiredNodeIndex(gltf, [expected.name], `${basename} ${storySet.propSet} ${expected.role}`);
        const label = `${basename} ${expected.name}`;
        assert.ok(topLevelRoots.has(nodeIndex), `${label} must export as an independently cloneable scene root`);
        assertCanonicalRootTransform(gltf, nodeIndex, label);
        assert.equal(gltf.nodes[nodeIndex].extras?.chasing_prop_set, storySet.propSet, `${label} has the wrong propSet provenance`);
        assert.equal(gltf.nodes[nodeIndex].extras?.chasing_story_role, expected.role, `${label} has the wrong story role`);
        assert.equal(gltf.nodes[nodeIndex].extras?.chasing_unique_signature, expected.name, `${label} must carry a unique authored signature`);
        const { size, volume } = boxMetrics(subtreeBounds(gltf, nodeIndex), label);
        assert.ok(Math.max(size.x, size.y, size.z) <= 8.5, `${label} exceeds the story-cluster footprint budget`);
        assert.ok(volume <= 220, `${label} exceeds the story-cluster volume budget`);
        const meshIndexes = subtreeMeshIndexes(gltf, nodeIndex);
        assert.ok(meshIndexes.size >= 1, `${label} has no renderable authored assembly`);
        assert.ok(gltf.nodes[nodeIndex].extras?.chasing_story_part_count >= 4, `${label} is a sparse placeholder rather than a complete vignette`);
        assert.equal(gltf.nodes[nodeIndex].extras?.chasing_story_batched, true, `${label} must batch its static authored parts for Web rendering`);
        assert.ok(subtreeTriangleCount(gltf, nodeIndex) >= 48, `${label} lacks readable production silhouette detail`);
        storyMeshSignatures.push({
          label,
          signature: [...meshIndexes].sort((a, b) => a - b).join(","),
        });
      }

      if (storySet.reuse) {
        const arrivalIndex = requiredNodeIndex(gltf, [storySet.arrival], `${basename} ${storySet.propSet} arrival reuse`);
        const reusedNodes = subtreeNodeIndexes(gltf, arrivalIndex)
          .map((nodeIndex) => gltf.nodes[nodeIndex])
          .filter((node) => node.extras?.chasing_reused_from === storySet.reuse);
        assert.ok(reusedNodes.length >= 3, `${basename} ${storySet.arrival} must visibly recompose ${storySet.reuse}`);
        assert.equal(gltf.nodes[arrivalIndex].extras?.chasing_reuses, storySet.reuse, `${basename} ${storySet.arrival} must declare its reused hero source`);
      }
    }
    assert.equal(
      new Set(storyMeshSignatures.map(({ signature }) => signature)).size,
      storyMeshSignatures.length,
      `${basename} propSet story roots must not be same-mesh aliases`,
    );

    const triangles = triangleCount(gltf);
    assert.ok(triangles >= 15_000, `${basename} must retain detailed production geometry across its semantic modules`);
    assert.ok(triangles <= 100_000, `${basename} exceeds the 100k triangle web budget`);
    assert.ok((gltf.nodes?.length ?? 0) <= 750, `${basename} exceeds the node budget`);
    assert.ok((gltf.meshes?.length ?? 0) <= 650, `${basename} exceeds the mesh budget`);
    assert.ok((gltf.materials?.length ?? 0) >= 10, `${basename} needs a real semantic PBR material set`);
    assert.ok(gltf.materials.length <= 32, `${basename} exceeds the material/draw-call budget`);
    assert.equal(new Set(gltf.materials.map((material) => material.name)).size, gltf.materials.length, `${basename} material names must be unique`);
    assert.ok((gltf.images?.length ?? 0) >= 8, `${basename} must embed real PBR color/normal surface maps`);
    assert.ok(gltf.images.length <= 24, `${basename} exceeds the image budget`);
    assert.ok(gltf.images.every((image) => image.mimeType === "image/webp" && image.bufferView !== undefined && !image.uri), `${basename} PBR maps must be embedded WebP payloads`);
    assert.ok(gltf.extensionsRequired?.includes("EXT_texture_webp"), `${basename} must declare its WebP texture contract`);
    assert.ok(buffer.length < contract.maxBytes, `${basename} exceeds its chapter-count-adjusted Web theme-kit budget`);
    for (const [imageIndex, image] of gltf.images.entries()) {
      const view = gltf.bufferViews[image.bufferView];
      const start = view.byteOffset ?? 0;
      const payload = glb.binary.subarray(start, start + view.byteLength);
      assert.ok(payload.length >= 1_024, `${basename} image ${imageIndex} is placeholder-sized`);
      assert.equal(payload.subarray(0, 4).toString("ascii"), "RIFF", `${basename} image ${imageIndex} is not a real WebP RIFF`);
      assert.equal(payload.subarray(8, 12).toString("ascii"), "WEBP", `${basename} image ${imageIndex} has an invalid WebP signature`);
      assert.ok(payload.readUInt32LE(4) + 8 <= payload.length, `${basename} image ${imageIndex} contains a truncated WebP payload`);
    }

    for (const [materialIndex, material] of gltf.materials.entries()) {
      const pbr = material.pbrMetallicRoughness;
      if (pbr?.baseColorTexture) {
        assert.ok(material.normalTexture, `${basename} textured material ${materialIndex} must include a normal map`);
      }
      if (pbr?.baseColorTexture && material.normalTexture) {
        assert.ok(pbr.metallicRoughnessTexture, `${basename} textured material ${materialIndex} must include packed roughness/metallic`);
        assert.ok(material.occlusionTexture, `${basename} textured material ${materialIndex} must include ambient occlusion`);
        assert.equal(
          pbr.metallicRoughnessTexture.index,
          material.occlusionTexture.index,
          `${basename} textured material ${materialIndex} must share one compact ORM texture`,
        );
      }
    }
    for (const [meshIndex, mesh] of gltf.meshes.entries()) {
      for (const [primitiveIndex, primitive] of mesh.primitives.entries()) {
        assert.ok(primitive.mode === undefined || primitive.mode === 4, `${basename} mesh ${meshIndex}/${primitiveIndex} must remain triangle geometry`);
        const material = primitive.material === undefined ? undefined : gltf.materials[primitive.material];
        if (material?.pbrMetallicRoughness?.baseColorTexture || material?.normalTexture) {
          assert.ok(primitive.attributes.NORMAL !== undefined, `${basename} mesh ${meshIndex}/${primitiveIndex} textured surface needs normals`);
          assert.ok(primitive.attributes.TEXCOORD_0 !== undefined, `${basename} mesh ${meshIndex}/${primitiveIndex} textured surface needs UV0`);
        }
      }
    }

    const scene = boxMetrics(sceneBounds(gltf), `${basename} scene`);
    assert.ok(Math.max(scene.size.x, scene.size.y, scene.size.z) <= 180, `${basename} scene library exceeds the authored bounds budget`);
    assert.ok(scene.volume <= 250_000, `${basename} scene library exceeds the total volume budget`);
  });
}

test("runtime PNG textures are real deployable images, not LFS pointers", async () => {
  const files = (await walk(MODELS_ROOT)).filter((filename) => filename.endsWith(".png"));
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  assert.equal(files.length, 22, "all 22 referenced runtime textures must be retained");
  for (const filename of files) {
    const buffer = await readFile(filename);
    assert.ok(buffer.subarray(0, 8).equals(pngSignature), `${path.relative(ROOT, filename)} is not a real PNG`);
  }
});

test("social preview is a compact 1200 x 630 production JPEG", async () => {
  const filename = path.join(ROOT, "public", "chasing-environment-key-art.jpg");
  const buffer = await readFile(filename);
  assert.ok(buffer.length >= 100_000 && buffer.length <= 500_000, "social preview must retain detail within its web budget");
  assert.ok(buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), "social preview is not a real JPEG");

  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let dimensions;
  while (offset + 4 <= buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    assert.ok(segmentLength >= 2 && offset + segmentLength <= buffer.length, "social preview contains a truncated JPEG segment");
    if (startOfFrameMarkers.has(marker)) {
      dimensions = {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
      break;
    }
    offset += segmentLength;
  }

  assert.deepEqual(dimensions, { width: 1200, height: 630 });
});
