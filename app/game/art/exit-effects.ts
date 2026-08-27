import * as THREE from "three";

export const EXIT_EFFECT_ATTRIBUTE = "p4ExitEffect";
export const EXIT_EFFECT_PERIOD_MS = 1600;

export const EXIT_EFFECT_MASK = Object.freeze({
  none: 0,
  blue: 1,
  red: 2,
  warm: 3,
});

type ExitEffectMask = typeof EXIT_EFFECT_MASK[keyof typeof EXIT_EFFECT_MASK];
type EffectName = keyof typeof EXIT_EFFECT_MASK;
type EffectCounts = Record<EffectName, number>;

const MASK_NAMES: readonly EffectName[] = ["none", "blue", "red", "warm"];
const MATERIAL_PATCH_KEY = "__p4ExitEffectsBinding";
const MATERIAL_PROGRAM_KEY = "p4-exit-effects-v1";

function emptyEffectCounts(): EffectCounts {
  return { none: 0, blue: 0, red: 0, warm: 0 };
}

function effectName(mask: ExitEffectMask): EffectName {
  return MASK_NAMES[mask] ?? "none";
}

export function exitEffectMaskForObject(object: THREE.Object3D): ExitEffectMask {
  let current: THREE.Object3D | null = object;
  while (current) {
    const name = current.name.toLowerCase();
    if (name.includes("blue_lightbar")) return EXIT_EFFECT_MASK.blue;
    if (name.includes("red_lightbar")) return EXIT_EFFECT_MASK.red;
    if (name.includes("warm_wall_lamp")) return EXIT_EFFECT_MASK.warm;
    current = current.parent;
  }
  return EXIT_EFFECT_MASK.none;
}

export type ExitEffectAttributeReport = {
  attribute: string;
  schema: string;
  allMeshesAttributed: boolean;
  meshes: number;
  sourceGeometries: number;
  attributedGeometries: number;
  conflictingSharedGeometries: number;
  clonedGeometries: number;
  disposedOrphanGeometries: number;
  createdAttributes: number;
  reusedAttributes: number;
  maskMeshes: EffectCounts;
  maskVertices: EffectCounts;
};

type MeshUsage = {
  mesh: THREE.Mesh;
  mask: ExitEffectMask;
};

function hasUniformEffectAttribute(
  geometry: THREE.BufferGeometry,
  mask: ExitEffectMask,
  count: number,
) {
  const attribute = geometry.getAttribute(EXIT_EFFECT_ATTRIBUTE);
  if (
    !(attribute instanceof THREE.BufferAttribute)
    || !(attribute.array instanceof Float32Array)
    || attribute.itemSize !== 1
    || attribute.normalized
    || attribute.count !== count
  ) return false;
  for (let index = 0; index < attribute.count; index += 1) {
    if (attribute.getX(index) !== mask) return false;
  }
  return true;
}

function setUniformEffectAttribute(
  geometry: THREE.BufferGeometry,
  mask: ExitEffectMask,
) {
  const count = geometry.getAttribute("position")?.count ?? 0;
  if (hasUniformEffectAttribute(geometry, mask, count)) return false;
  const values = new Float32Array(count);
  if (mask !== EXIT_EFFECT_MASK.none) values.fill(mask);
  geometry.setAttribute(EXIT_EFFECT_ATTRIBUTE, new THREE.Float32BufferAttribute(values, 1));
  return true;
}

/**
 * Adds the same Float32 scalar attribute schema to every detail-prop mesh.
 * If one owned geometry is shared by differently tagged nodes, each mask gets
 * an independent clone and the now-orphaned source geometry is disposed.
 */
export function applyExitEffectAttributes(root: THREE.Object3D): ExitEffectAttributeReport {
  const usageByGeometry = new Map<THREE.BufferGeometry, Map<ExitEffectMask, THREE.Mesh[]>>();
  const usages: MeshUsage[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const mask = exitEffectMaskForObject(object);
    usages.push({ mesh: object, mask });
    const byMask = usageByGeometry.get(object.geometry) ?? new Map<ExitEffectMask, THREE.Mesh[]>();
    const meshes = byMask.get(mask) ?? [];
    meshes.push(object);
    byMask.set(mask, meshes);
    usageByGeometry.set(object.geometry, byMask);
  });

  let conflictingSharedGeometries = 0;
  let clonedGeometries = 0;
  let disposedOrphanGeometries = 0;
  let createdAttributes = 0;
  let reusedAttributes = 0;

  for (const [sourceGeometry, byMask] of usageByGeometry) {
    if (byMask.size === 1) {
      const [mask] = byMask.keys();
      if (setUniformEffectAttribute(sourceGeometry, mask)) createdAttributes += 1;
      else reusedAttributes += 1;
      continue;
    }

    conflictingSharedGeometries += 1;
    for (const [mask, meshes] of byMask) {
      const geometry = sourceGeometry.clone();
      clonedGeometries += 1;
      if (setUniformEffectAttribute(geometry, mask)) createdAttributes += 1;
      else reusedAttributes += 1;
      for (const mesh of meshes) mesh.geometry = geometry;
    }
    sourceGeometry.dispose();
    disposedOrphanGeometries += 1;
  }

  const finalGeometries = new Set<THREE.BufferGeometry>();
  const maskMeshes = emptyEffectCounts();
  const maskVertices = emptyEffectCounts();
  let allMeshesAttributed = true;
  for (const { mesh, mask } of usages) {
    finalGeometries.add(mesh.geometry);
    const name = effectName(mask);
    maskMeshes[name] += 1;
    maskVertices[name] += mesh.geometry.getAttribute("position")?.count ?? 0;
    if (!hasUniformEffectAttribute(
      mesh.geometry,
      mask,
      mesh.geometry.getAttribute("position")?.count ?? 0,
    )) allMeshesAttributed = false;
  }

  return {
    attribute: EXIT_EFFECT_ATTRIBUTE,
    schema: `${EXIT_EFFECT_ATTRIBUTE}:1:false:Float32Array`,
    allMeshesAttributed,
    meshes: usages.length,
    sourceGeometries: usageByGeometry.size,
    attributedGeometries: finalGeometries.size,
    conflictingSharedGeometries,
    clonedGeometries,
    disposedOrphanGeometries,
    createdAttributes,
    reusedAttributes,
    maskMeshes,
    maskVertices,
  };
}

export type ExitEffectRuntime = {
  readonly periodMs: number;
  readonly uniforms: {
    readonly blue: { value: number };
    readonly red: { value: number };
    readonly warm: { value: number };
  };
  phase: number;
  blueIntensity: number;
  redIntensity: number;
  warmIntensity: number;
  beaconScale: number;
  reducedMotion: boolean;
  updatedAt: number;
};

export function createExitEffectRuntime(periodMs = EXIT_EFFECT_PERIOD_MS): ExitEffectRuntime {
  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    throw new RangeError("exit effect periodMs must be a positive finite number");
  }
  return {
    periodMs,
    uniforms: {
      blue: { value: 0.76 },
      red: { value: 0.76 },
      warm: { value: 0.9 },
    },
    phase: 0,
    blueIntensity: 0.76,
    redIntensity: 0.76,
    warmIntensity: 0.9,
    beaconScale: 1,
    reducedMotion: false,
    updatedAt: 0,
  };
}

/** Updates scalar uniforms in place and performs no per-frame allocation. */
export function updateExitEffectPulse(
  runtime: ExitEffectRuntime,
  nowMs: number,
  reducedMotion: boolean,
) {
  runtime.updatedAt = nowMs;
  runtime.reducedMotion = reducedMotion;
  if (reducedMotion) {
    runtime.phase = 0;
    runtime.blueIntensity = 0.76;
    runtime.redIntensity = 0.76;
    runtime.warmIntensity = 0.9;
    runtime.beaconScale = 1;
  } else {
    const wrappedTime = ((nowMs % runtime.periodMs) + runtime.periodMs) % runtime.periodMs;
    runtime.phase = (wrappedTime / runtime.periodMs) * Math.PI * 2;
    const wave = Math.sin(runtime.phase);
    runtime.blueIntensity = 0.76 + wave * 0.58;
    runtime.redIntensity = 0.76 - wave * 0.58;
    runtime.warmIntensity = 0.9 + Math.sin(runtime.phase * 0.5) * 0.08;
    runtime.beaconScale = 1 + wave * 0.05;
  }
  runtime.uniforms.blue.value = runtime.blueIntensity;
  runtime.uniforms.red.value = runtime.redIntensity;
  runtime.uniforms.warm.value = runtime.warmIntensity;
  return runtime;
}

type ExitEffectMaterialBinding = {
  runtime: ExitEffectRuntime;
};

function geometryHasExitEffect(geometry: THREE.BufferGeometry) {
  const attribute = geometry.getAttribute(EXIT_EFFECT_ATTRIBUTE);
  if (
    !(attribute instanceof THREE.BufferAttribute)
    || !(attribute.array instanceof Float32Array)
    || attribute.itemSize !== 1
  ) return false;
  for (let index = 0; index < attribute.count; index += 1) {
    if (attribute.getX(index) !== EXIT_EFFECT_MASK.none) return true;
  }
  return false;
}

function injectExitEffectShader(
  shader: THREE.WebGLProgramParametersWithUniforms,
  runtime: ExitEffectRuntime,
) {
  shader.uniforms.p4ExitBlue = runtime.uniforms.blue;
  shader.uniforms.p4ExitRed = runtime.uniforms.red;
  shader.uniforms.p4ExitWarm = runtime.uniforms.warm;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\nattribute float p4ExitEffect;\nvarying float vP4ExitEffect;",
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvP4ExitEffect = p4ExitEffect;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      [
        "#include <common>",
        "uniform float p4ExitBlue;",
        "uniform float p4ExitRed;",
        "uniform float p4ExitWarm;",
        "varying float vP4ExitEffect;",
      ].join("\n"),
    )
    .replace(
      "#include <emissivemap_fragment>",
      [
        "#include <emissivemap_fragment>",
        "float p4BlueMask = 1.0 - step(0.25, abs(vP4ExitEffect - 1.0));",
        "float p4RedMask = 1.0 - step(0.25, abs(vP4ExitEffect - 2.0));",
        "float p4WarmMask = 1.0 - step(0.25, abs(vP4ExitEffect - 3.0));",
        "totalEmissiveRadiance += vec3(0.08, 0.34, 1.0) * p4BlueMask * p4ExitBlue;",
        "totalEmissiveRadiance += vec3(1.0, 0.06, 0.035) * p4RedMask * p4ExitRed;",
        "totalEmissiveRadiance += vec3(1.0, 0.56, 0.18) * p4WarmMask * p4ExitWarm;",
      ].join("\n"),
    );
}

export type ExitEffectShaderReport = {
  programKey: string;
  standardMaterials: number;
  effectMaterials: number;
  patchedMaterials: number;
  alreadyPatchedMaterials: number;
  unsupportedEffectMaterials: number;
  drawCallSafe: boolean;
};

/**
 * Patches only materials whose geometry contains a non-zero mask. Materials
 * remain attached to the same meshes, so this adds no render item or draw call.
 */
export function patchExitEffectMaterials(
  root: THREE.Object3D,
  runtime: ExitEffectRuntime,
): ExitEffectShaderReport {
  const standardMaterials = new Set<THREE.MeshStandardMaterial>();
  const effectMaterials = new Set<THREE.MeshStandardMaterial>();
  const unsupportedEffectMaterials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const hasEffect = geometryHasExitEffect(object.geometry);
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        standardMaterials.add(material);
        if (hasEffect) effectMaterials.add(material);
      } else if (hasEffect) {
        unsupportedEffectMaterials.add(material);
      }
    }
  });

  let patchedMaterials = 0;
  let alreadyPatchedMaterials = 0;
  for (const material of effectMaterials) {
    const userData = material.userData as Record<string, unknown>;
    const existing = userData[MATERIAL_PATCH_KEY] as ExitEffectMaterialBinding | undefined;
    if (existing) {
      existing.runtime = runtime;
      material.needsUpdate = true;
      alreadyPatchedMaterials += 1;
      continue;
    }
    const binding: ExitEffectMaterialBinding = { runtime };
    const previousCompile = material.onBeforeCompile;
    const previousProgramKey = material.customProgramCacheKey;
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer);
      injectExitEffectShader(shader, binding.runtime);
    };
    material.customProgramCacheKey = () => (
      `${previousProgramKey.call(material)}|${MATERIAL_PROGRAM_KEY}`
    );
    userData[MATERIAL_PATCH_KEY] = binding;
    material.needsUpdate = true;
    patchedMaterials += 1;
  }

  return {
    programKey: MATERIAL_PROGRAM_KEY,
    standardMaterials: standardMaterials.size,
    effectMaterials: effectMaterials.size,
    patchedMaterials,
    alreadyPatchedMaterials,
    unsupportedEffectMaterials: unsupportedEffectMaterials.size,
    drawCallSafe: true,
  };
}

export function getExitEffectQaReport(
  runtime: ExitEffectRuntime,
  attributes: ExitEffectAttributeReport | null,
  shaders: ExitEffectShaderReport | null,
) {
  return {
    periodMs: runtime.periodMs,
    phase: runtime.phase,
    reducedMotion: runtime.reducedMotion,
    updatedAt: runtime.updatedAt,
    intensities: {
      blue: runtime.blueIntensity,
      red: runtime.redIntensity,
      warm: runtime.warmIntensity,
      beaconScale: runtime.beaconScale,
    },
    attributes,
    shaders,
  };
}
