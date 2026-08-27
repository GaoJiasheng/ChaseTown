import * as THREE from "three";

export const P4_MAX_TEXTURE_ANISOTROPY = 8;

export const P4_SURFACE_TEXTURE_SLOTS = [
  "map",
  "lightMap",
  "aoMap",
  "emissiveMap",
  "bumpMap",
  "normalMap",
  "displacementMap",
  "roughnessMap",
  "metalnessMap",
  "alphaMap",
  "envMap",
  "anisotropyMap",
  "clearcoatMap",
  "clearcoatRoughnessMap",
  "clearcoatNormalMap",
  "iridescenceMap",
  "iridescenceThicknessMap",
  "sheenColorMap",
  "sheenRoughnessMap",
  "transmissionMap",
  "thicknessMap",
  "specularIntensityMap",
  "specularColorMap",
] as const;

export type SurfaceTextureSlot = typeof P4_SURFACE_TEXTURE_SLOTS[number];

export type ShadowFollowRuntime = {
  readonly lightOffset: THREE.Vector3;
  readonly depthAxis: THREE.Vector3;
  readonly rightAxis: THREE.Vector3;
  readonly upAxis: THREE.Vector3;
  readonly requestedFocus: THREE.Vector3;
  readonly snappedFocus: THREE.Vector3;
  readonly halfExtent: number;
  readonly mapSize: number;
  readonly worldUnitsPerTexel: number;
  updateCount: number;
};

export type ShadowFollowOptions = {
  lightOffset: THREE.Vector3;
  halfExtent?: number;
  mapSize?: number;
};

/**
 * Allocates the immutable basis and diagnostic vectors once. The returned
 * runtime is intended to be reused for the lifetime of the directional light.
 */
export function createShadowFollowRuntime({
  lightOffset,
  halfExtent = 16,
  mapSize = 1024,
}: ShadowFollowOptions): ShadowFollowRuntime {
  if (!Number.isFinite(halfExtent) || halfExtent <= 0) {
    throw new RangeError("shadow halfExtent must be a positive finite number");
  }
  if (!Number.isFinite(mapSize) || mapSize <= 0) {
    throw new RangeError("shadow mapSize must be a positive finite number");
  }
  if (lightOffset.lengthSq() <= Number.EPSILON) {
    throw new RangeError("shadow lightOffset must have a non-zero length");
  }

  const stableOffset = lightOffset.clone();
  const depthAxis = stableOffset.clone().normalize();
  const rightAxis = new THREE.Vector3().crossVectors(THREE.Object3D.DEFAULT_UP, depthAxis);
  if (rightAxis.lengthSq() <= Number.EPSILON) rightAxis.set(1, 0, 0);
  else rightAxis.normalize();
  const upAxis = new THREE.Vector3().crossVectors(depthAxis, rightAxis).normalize();
  const normalizedMapSize = Math.max(1, Math.floor(mapSize));

  return {
    lightOffset: stableOffset,
    depthAxis,
    rightAxis,
    upAxis,
    requestedFocus: new THREE.Vector3(),
    snappedFocus: new THREE.Vector3(),
    halfExtent,
    mapSize: normalizedMapSize,
    worldUnitsPerTexel: (halfExtent * 2) / normalizedMapSize,
    updateCount: 0,
  };
}

/**
 * Snaps the shadow centre in the light camera's two screen-space axes, while
 * preserving its depth component. All vectors are reused; the hot path makes
 * no Vector3, array, or object allocations.
 */
export function updateShadowFollow(
  runtime: ShadowFollowRuntime,
  focus: THREE.Vector3,
  lightPositionOut: THREE.Vector3,
  targetPositionOut: THREE.Vector3,
) {
  runtime.requestedFocus.copy(focus);
  const texel = runtime.worldUnitsPerTexel;
  const right = Math.round(focus.dot(runtime.rightAxis) / texel) * texel;
  const up = Math.round(focus.dot(runtime.upAxis) / texel) * texel;
  const depth = focus.dot(runtime.depthAxis);

  runtime.snappedFocus
    .copy(runtime.rightAxis)
    .multiplyScalar(right)
    .addScaledVector(runtime.upAxis, up)
    .addScaledVector(runtime.depthAxis, depth);
  targetPositionOut.copy(runtime.snappedFocus);
  lightPositionOut.copy(runtime.snappedFocus).add(runtime.lightOffset);
  runtime.updateCount += 1;
  return runtime;
}

export type TextureAnisotropyReport = {
  capability: number;
  requested: number;
  limit: number;
  effective: number;
  materials: number;
  slotReferences: number;
  uniqueTextures: number;
  changedTextures: number;
  minApplied: number;
  maxApplied: number;
  slotCounts: Partial<Record<SurfaceTextureSlot, number>>;
};

function positiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

export function cappedTextureAnisotropy(capability: number, requested = P4_MAX_TEXTURE_ANISOTROPY) {
  return Math.min(
    P4_MAX_TEXTURE_ANISOTROPY,
    positiveInteger(capability, 1),
    positiveInteger(requested, P4_MAX_TEXTURE_ANISOTROPY),
  );
}

/**
 * Applies anisotropic filtering to every texture slot used by Standard and
 * Physical materials below the supplied floor/wall roots. Shared materials and
 * shared textures are visited once, so a texture version is bumped at most once.
 */
export function applySurfaceTextureAnisotropy(
  rootOrRoots: THREE.Object3D | readonly THREE.Object3D[],
  capability: number,
  requested = P4_MAX_TEXTURE_ANISOTROPY,
): TextureAnisotropyReport {
  const roots: readonly THREE.Object3D[] = Array.isArray(rootOrRoots)
    ? rootOrRoots
    : [rootOrRoots as THREE.Object3D];
  const normalizedCapability = positiveInteger(capability, 1);
  const normalizedRequested = positiveInteger(requested, P4_MAX_TEXTURE_ANISOTROPY);
  const effective = cappedTextureAnisotropy(normalizedCapability, normalizedRequested);
  const materials = new Set<THREE.MeshStandardMaterial>();
  const textures = new Set<THREE.Texture>();
  const slotCounts: Partial<Record<SurfaceTextureSlot, number>> = {};
  let slotReferences = 0;

  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const candidates = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of candidates) {
        if (material instanceof THREE.MeshStandardMaterial) materials.add(material);
      }
    });
  }

  for (const material of materials) {
    const materialRecord = material as unknown as Record<string, unknown>;
    for (const slot of P4_SURFACE_TEXTURE_SLOTS) {
      const texture = materialRecord[slot];
      if (!(texture instanceof THREE.Texture)) continue;
      slotReferences += 1;
      slotCounts[slot] = (slotCounts[slot] ?? 0) + 1;
      textures.add(texture);
    }
  }

  let changedTextures = 0;
  let minApplied = Number.POSITIVE_INFINITY;
  let maxApplied = 0;
  for (const texture of textures) {
    if (texture.anisotropy !== effective) {
      texture.anisotropy = effective;
      texture.needsUpdate = true;
      changedTextures += 1;
    }
    minApplied = Math.min(minApplied, texture.anisotropy);
    maxApplied = Math.max(maxApplied, texture.anisotropy);
  }

  return {
    capability: normalizedCapability,
    requested: normalizedRequested,
    limit: P4_MAX_TEXTURE_ANISOTROPY,
    effective,
    materials: materials.size,
    slotReferences,
    uniqueTextures: textures.size,
    changedTextures,
    minApplied: textures.size ? minApplied : 0,
    maxApplied: textures.size ? maxApplied : 0,
    slotCounts,
  };
}
