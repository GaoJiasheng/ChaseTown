import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const DEFAULT_MATRIX_EPSILON = 1e-7;
export const ACTOR_SHADOW_LAYER = 1;

export type ActorBatchFallback = Readonly<{
  mesh: string;
  reason: "hidden" | "multi-material" | "morph-target" | "missing-skin-attributes" | "animated-parent" | "merge-failed";
}>;

export type ActorBatchBudget = Readonly<{
  beforeMeshes: number;
  afterMeshes: number;
  mergedGroups: number;
  mergedSourceMeshes: number;
  singletonGroups: number;
  trianglesBefore: number;
  trianglesAfter: number;
  disposedGeometries: number;
  fallbacks: readonly ActorBatchFallback[];
}>;

export type ActorBatchResult = Readonly<{
  meshes: readonly THREE.SkinnedMesh[];
  budget: ActorBatchBudget;
}>;

export type ActorBatchOptions = Readonly<{
  matrixEpsilon?: number;
}>;

export type ActorShadowProxyBudget = Readonly<{
  created: boolean;
  sourceMeshes: number;
  proxyMeshes: number;
  proxyTriangles: number;
  segments: number;
  shadowLayer: number;
  fallbackReason?: string;
}>;

export type ActorShadowProxyResult = Readonly<{
  proxy?: THREE.SkinnedMesh;
  budget: ActorShadowProxyBudget;
}>;

export type ActorShadowProxyOptions = Readonly<{
  layer?: number;
  radialSegments?: number;
  maxTriangles?: number;
  material?: THREE.Material;
  name?: string;
}>;

type Candidate = Readonly<{
  mesh: THREE.SkinnedMesh;
  key: string;
}>;

const matrixSignature = (matrix: THREE.Matrix4, epsilon: number) => (
  matrix.elements.map((value) => Math.round(value / epsilon)).join(",")
);

const geometrySignature = (geometry: THREE.BufferGeometry) => {
  const attributes = Object.entries(geometry.attributes)
    .map(([name, attribute]) => {
      const array = attribute instanceof THREE.InterleavedBufferAttribute
        ? attribute.data.array
        : attribute.array;
      return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}`;
    })
    .sort()
    .join("|");
  const index = geometry.index;
  return `${index ? index.array.constructor.name : "non-indexed"}|${attributes}`;
};

export const actorMeshTriangles = (mesh: THREE.Mesh) => (
  (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0) / 3
);

const isEffectivelyVisible = (object: THREE.Object3D, root: THREE.Object3D) => {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
};

const hasAnimatedParent = (mesh: THREE.SkinnedMesh, root: THREE.Object3D) => {
  let current = mesh.parent;
  while (current && current !== root) {
    if (current instanceof THREE.Bone) return true;
    current = current.parent;
  }
  return false;
};

const countGeometryReferences = (root: THREE.Object3D) => {
  const references = new Map<THREE.BufferGeometry, number>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    references.set(object.geometry, (references.get(object.geometry) ?? 0) + 1);
  });
  return references;
};

const copyMeshTransform = (target: THREE.Object3D, source: THREE.Object3D) => {
  target.matrixAutoUpdate = source.matrixAutoUpdate;
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.scale.copy(source.scale);
  target.matrix.copy(source.matrix);
  target.matrixWorld.copy(source.matrixWorld);
};

/**
 * Merges only demonstrably equivalent skinned meshes. Geometry remains in its
 * authored skin frame; applying world transforms here would corrupt skinning.
 */
export function batchCompatibleActorSkins(
  root: THREE.Object3D,
  options: ActorBatchOptions = {},
): ActorBatchResult {
  const epsilon = options.matrixEpsilon ?? DEFAULT_MATRIX_EPSILON;
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) {
    throw new RangeError("matrixEpsilon must be a finite positive number.");
  }

  root.updateMatrixWorld(true);
  const skeletonIds = new Map<THREE.Skeleton, number>();
  const anchorIds = new Map<THREE.Object3D, number>();
  const fallbacks: ActorBatchFallback[] = [];
  const allMeshes: THREE.SkinnedMesh[] = [];
  const candidates: Candidate[] = [];
  let nextSkeletonId = 1;
  let nextAnchorId = 1;

  root.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh) || object.userData.actorShadowProxy) return;
    allMeshes.push(object);
    const meshName = object.name || object.parent?.name || object.uuid;
    if (!isEffectivelyVisible(object, root)) {
      fallbacks.push({ mesh: meshName, reason: "hidden" });
      return;
    }
    if (Array.isArray(object.material)) {
      fallbacks.push({ mesh: meshName, reason: "multi-material" });
      return;
    }
    if (Object.keys(object.geometry.morphAttributes).length > 0 || object.morphTargetInfluences) {
      fallbacks.push({ mesh: meshName, reason: "morph-target" });
      return;
    }
    if (
      !object.geometry.getAttribute("position")
      || !object.geometry.getAttribute("skinIndex")
      || !object.geometry.getAttribute("skinWeight")
    ) {
      fallbacks.push({ mesh: meshName, reason: "missing-skin-attributes" });
      return;
    }
    if (hasAnimatedParent(object, root)) {
      fallbacks.push({ mesh: meshName, reason: "animated-parent" });
      return;
    }

    const skeletonId = skeletonIds.get(object.skeleton) ?? nextSkeletonId++;
    skeletonIds.set(object.skeleton, skeletonId);
    const anchor = object.parent ?? root;
    const anchorId = anchorIds.get(anchor) ?? nextAnchorId++;
    anchorIds.set(anchor, anchorId);
    const key = [
      object.material.uuid,
      geometrySignature(object.geometry),
      skeletonId,
      object.skeleton.bones.map((bone) => bone.uuid).join(","),
      object.bindMode,
      matrixSignature(object.bindMatrix, epsilon),
      matrixSignature(object.matrixWorld, epsilon),
      matrixSignature(object.matrix, epsilon),
      // Different static wrappers are allowed only when their world/local frames
      // match. The anchor id is intentionally omitted after those guards.
      anchorId > 0 ? "static-anchor" : "root-anchor",
    ].join("#");
    candidates.push({ mesh: object, key });
  });

  const buckets = new Map<string, THREE.SkinnedMesh[]>();
  for (const candidate of candidates) {
    const bucket = buckets.get(candidate.key) ?? [];
    bucket.push(candidate.mesh);
    buckets.set(candidate.key, bucket);
  }

  const geometryReferences = countGeometryReferences(root);
  const disposed = new Set<THREE.BufferGeometry>();
  let mergedGroups = 0;
  let mergedSourceMeshes = 0;
  let singletonGroups = 0;

  for (const meshes of buckets.values()) {
    if (meshes.length < 2) {
      singletonGroups += 1;
      continue;
    }
    const first = meshes[0];
    const temporary = meshes.map((mesh) => mesh.geometry.clone());
    const mergedGeometry = mergeGeometries(temporary, false);
    for (const geometry of temporary) geometry.dispose();
    if (!mergedGeometry) {
      for (const mesh of meshes) {
        fallbacks.push({ mesh: mesh.name || mesh.parent?.name || mesh.uuid, reason: "merge-failed" });
      }
      continue;
    }

    const material = first.material as THREE.Material;
    const mergedMesh = new THREE.SkinnedMesh(mergedGeometry, material);
    mergedMesh.name = `actor-batch-${material.name || mergedGroups + 1}`;
    copyMeshTransform(mergedMesh, first);
    mergedMesh.bindMode = first.bindMode;
    mergedMesh.bind(first.skeleton, first.bindMatrix);
    // Preserve the authored fallback until a shadow proxy is successfully
    // installed. createActorShadowProxy disables every high-poly caster only
    // after its replacement has passed the triangle and skeleton guards.
    mergedMesh.castShadow = meshes.some((mesh) => mesh.castShadow);
    mergedMesh.receiveShadow = meshes.some((mesh) => mesh.receiveShadow);
    mergedMesh.frustumCulled = meshes.every((mesh) => mesh.frustumCulled);
    mergedMesh.renderOrder = first.renderOrder;
    mergedMesh.layers.mask = first.layers.mask;
    first.parent?.add(mergedMesh);

    for (const mesh of meshes) {
      mesh.removeFromParent();
      const remaining = (geometryReferences.get(mesh.geometry) ?? 1) - 1;
      geometryReferences.set(mesh.geometry, remaining);
      if (remaining === 0 && !disposed.has(mesh.geometry)) {
        mesh.geometry.dispose();
        disposed.add(mesh.geometry);
      }
    }
    mergedGroups += 1;
    mergedSourceMeshes += meshes.length;
  }

  root.updateMatrixWorld(true);
  const outputMeshes: THREE.SkinnedMesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh && !object.userData.actorShadowProxy) outputMeshes.push(object);
  });
  const budget: ActorBatchBudget = {
    beforeMeshes: allMeshes.length,
    afterMeshes: outputMeshes.length,
    mergedGroups,
    mergedSourceMeshes,
    singletonGroups,
    trianglesBefore: allMeshes.reduce((total, mesh) => total + actorMeshTriangles(mesh), 0),
    trianglesAfter: outputMeshes.reduce((total, mesh) => total + actorMeshTriangles(mesh), 0),
    disposedGeometries: disposed.size,
    fallbacks,
  };
  return { meshes: outputMeshes, budget };
}

const setRigidSkinAttributes = (
  geometry: THREE.BufferGeometry,
  boneIndex: number,
) => {
  const vertexCount = geometry.getAttribute("position").count;
  const indices = new Uint16Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    indices[vertex * 4] = boneIndex;
    weights[vertex * 4] = 1;
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
  return geometry;
};

const segmentGeometry = (
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  radialSegments: number,
  boneIndex: number,
  worldToReference: THREE.Matrix4,
) => {
  const direction = new THREE.Vector3().subVectors(end, start);
  const length = direction.length();
  if (length < 1e-5) return null;
  const geometry = new THREE.CylinderGeometry(radius, radius, length, radialSegments, 1, false);
  const rotation = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.multiplyScalar(1 / length),
  );
  const transform = new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5),
    rotation,
    new THREE.Vector3(1, 1, 1),
  );
  geometry.applyMatrix4(transform);
  geometry.applyMatrix4(worldToReference);
  return setRigidSkinAttributes(geometry, boneIndex);
};

const failedShadowBudget = (
  sourceMeshes: number,
  layer: number,
  fallbackReason: string,
): ActorShadowProxyBudget => ({
  created: false,
  sourceMeshes,
  proxyMeshes: 0,
  proxyTriangles: 0,
  segments: 0,
  shadowLayer: layer,
  fallbackReason,
});

/**
 * Builds one articulated, low-poly shadow-only SkinnedMesh. Each primitive is
 * rigidly weighted to its named bone, so the existing procedural gait also
 * drives the shadow silhouette without drawing the high-poly actor in shadow.
 */
export function createActorShadowProxy(
  root: THREE.Object3D,
  options: ActorShadowProxyOptions = {},
): ActorShadowProxyResult {
  const layer = options.layer ?? ACTOR_SHADOW_LAYER;
  const radialSegments = THREE.MathUtils.clamp(Math.floor(options.radialSegments ?? 6), 6, 12);
  const maxTriangles = options.maxTriangles ?? 1000;
  if (!Number.isInteger(layer) || layer < 0 || layer > 31) {
    throw new RangeError("Actor shadow layer must be an integer from 0 through 31.");
  }
  if (!(maxTriangles > 0) || !Number.isFinite(maxTriangles)) {
    throw new RangeError("Actor shadow maxTriangles must be a finite positive number.");
  }

  root.updateMatrixWorld(true);
  const sourceMeshes: THREE.SkinnedMesh[] = [];
  root.traverse((object) => {
    if (object instanceof THREE.SkinnedMesh && !object.userData.actorShadowProxy) sourceMeshes.push(object);
  });
  const reference = sourceMeshes.find((mesh) => isEffectivelyVisible(mesh, root));
  if (!reference || !reference.parent) {
    return { budget: failedShadowBudget(sourceMeshes.length, layer, "missing-reference-skinned-mesh") };
  }

  const skeleton = reference.skeleton;
  if (sourceMeshes.some((mesh) => mesh.skeleton !== skeleton)) {
    return { budget: failedShadowBudget(sourceMeshes.length, layer, "multiple-skeletons") };
  }
  const boneIndex = new Map(skeleton.bones.map((bone, index) => [bone.name, index]));
  const requiredBones = [
    "Hips", "Neck", "Head",
    "LeftUpperArm", "LeftLowerArm", "LeftHand",
    "RightUpperArm", "RightLowerArm", "RightHand",
    "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
    "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
  ];
  const missing = requiredBones.filter((name) => !boneIndex.has(name));
  if (missing.length) {
    return { budget: failedShadowBudget(sourceMeshes.length, layer, `missing-bones:${missing.join(",")}`) };
  }

  const bounds = new THREE.Box3().setFromObject(root);
  const height = Math.max(bounds.getSize(new THREE.Vector3()).y, 1);
  const worldToReference = reference.matrixWorld.clone().invert();
  const position = (name: string) => skeleton.bones[boneIndex.get(name)!].getWorldPosition(new THREE.Vector3());
  const specifications = [
    ["Hips", "Neck", height * 0.115],
    ["LeftUpperArm", "LeftLowerArm", height * 0.04],
    ["LeftLowerArm", "LeftHand", height * 0.035],
    ["RightUpperArm", "RightLowerArm", height * 0.04],
    ["RightLowerArm", "RightHand", height * 0.035],
    ["LeftUpperLeg", "LeftLowerLeg", height * 0.055],
    ["LeftLowerLeg", "LeftFoot", height * 0.045],
    ["LeftFoot", "LeftToes", height * 0.05],
    ["RightUpperLeg", "RightLowerLeg", height * 0.055],
    ["RightLowerLeg", "RightFoot", height * 0.045],
    ["RightFoot", "RightToes", height * 0.05],
  ] as const;
  const pieces: THREE.BufferGeometry[] = [];
  for (const [startName, endName, radius] of specifications) {
    const piece = segmentGeometry(
      position(startName),
      position(endName),
      radius,
      radialSegments,
      boneIndex.get(startName)!,
      worldToReference,
    );
    if (piece) pieces.push(piece);
  }
  const head = new THREE.SphereGeometry(height * 0.095, Math.max(8, radialSegments), 6);
  head.translate(...position("Head").toArray());
  head.applyMatrix4(worldToReference);
  pieces.push(setRigidSkinAttributes(head, boneIndex.get("Head")!));

  const merged = mergeGeometries(pieces, false);
  for (const piece of pieces) piece.dispose();
  if (!merged) {
    return { budget: failedShadowBudget(sourceMeshes.length, layer, "proxy-geometry-merge-failed") };
  }
  const proxyTriangles = (merged.index?.count ?? merged.getAttribute("position")?.count ?? 0) / 3;
  if (proxyTriangles > maxTriangles) {
    merged.dispose();
    return { budget: failedShadowBudget(sourceMeshes.length, layer, `proxy-budget-exceeded:${proxyTriangles}`) };
  }

  const material = options.material ?? new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthWrite: false,
  });
  const proxy = new THREE.SkinnedMesh(merged, material);
  proxy.name = options.name ?? "actor-shadow-proxy";
  copyMeshTransform(proxy, reference);
  proxy.bindMode = reference.bindMode;
  proxy.bind(skeleton, reference.bindMatrix);
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  proxy.frustumCulled = false;
  proxy.layers.set(layer);
  reference.parent.add(proxy);
  for (const mesh of sourceMeshes) mesh.castShadow = false;

  const budget: ActorShadowProxyBudget = {
    created: true,
    sourceMeshes: sourceMeshes.length,
    proxyMeshes: 1,
    proxyTriangles,
    segments: pieces.length,
    shadowLayer: layer,
  };
  proxy.userData.actorShadowProxy = budget;
  root.updateMatrixWorld(true);
  return { proxy, budget };
}

export function enableActorShadowLayer(camera: THREE.Camera, layer = ACTOR_SHADOW_LAYER) {
  if (!Number.isInteger(layer) || layer < 0 || layer > 31) {
    throw new RangeError("Actor shadow layer must be an integer from 0 through 31.");
  }
  camera.layers.enable(layer);
  return camera.layers.mask;
}
