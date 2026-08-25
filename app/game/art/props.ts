import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { P1_TUNING } from "../config/index.js";
export function tuneMeshes(root: THREE.Object3D, disableCulling = false, castShadow = true) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = castShadow;
    object.receiveShadow = true;
    if (disableCulling) object.frustumCulled = false;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = P1_TUNING.environmentIntensity;
        material.roughness = Math.min(material.roughness, 0.9);
      }
    }
  });
}

export function flattenStatic(root: THREE.Object3D, castShadow = false) {
  let hasSkinnedMesh = false;
  root.traverse((object) => { if (object instanceof THREE.SkinnedMesh) hasSkinnedMesh = true; });
  if (hasSkinnedMesh) return root;
  root.updateMatrixWorld(true);
  const flat = new THREE.Group();
  const flatMeshes: THREE.Mesh[] = [];
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Array.isArray(object.material) || Object.keys(object.geometry.morphAttributes).length) {
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      const mesh = new THREE.Mesh(geometry, object.material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      flat.add(mesh);
      flatMeshes.push(mesh);
      return;
    }
    const attributes = (Object.entries(object.geometry.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][])
      .map(([name, attribute]) => {
        const array = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
        return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}`;
      })
      .sort()
      .join("|");
    const signature = `${object.material.uuid}:${object.geometry.index ? "indexed" : "plain"}:${attributes}`;
    const bucket = buckets.get(signature) ?? { material: object.material, geometries: [] as THREE.BufferGeometry[] };
    bucket.geometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
    buckets.set(signature, bucket);
  });
  for (const { material, geometries } of buckets.values()) {
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!geometry) {
      for (const sourceGeometry of geometries) sourceGeometry.dispose();
      continue;
    }
    if (geometries.length > 1) {
      for (const sourceGeometry of geometries) sourceGeometry.dispose();
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    flat.add(mesh);
    flatMeshes.push(mesh);
  }
  if (castShadow && flatMeshes.length) {
    const shadowScore = (mesh: THREE.Mesh) => {
      mesh.geometry.computeBoundingBox();
      const size = mesh.geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3();
      return size.x * size.y + size.x * size.z + size.y * size.z;
    };
    [...flatMeshes]
      .sort((left, right) => shadowScore(right) - shadowScore(left))
      .slice(0, 2)
      .forEach((mesh) => { mesh.castShadow = true; });
  }
  return flat;
}

export function geometrySchema(geometry: THREE.BufferGeometry) {
  return (Object.entries(geometry.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][])
    .map(([name, attribute]) => {
      const array = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
      return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}`;
    })
    .sort()
    .join("|");
}

export function textureSourceKey(texture: THREE.Texture | null) {
  if (!texture) return "none";
  const source = texture.source.data as { currentSrc?: string; src?: string } | undefined;
  return [
    source?.currentSrc ?? source?.src ?? texture.name ?? "embedded",
    texture.wrapS,
    texture.wrapT,
    texture.repeat.x,
    texture.repeat.y,
    texture.offset.x,
    texture.offset.y,
    texture.rotation,
    texture.colorSpace,
  ].join(":");
}

export function semanticMaterialKey(material: THREE.Material) {
  const standard = material instanceof THREE.MeshStandardMaterial ? material : null;
  const basic = material instanceof THREE.MeshBasicMaterial ? material : null;
  const normalizedName = material.name.replace(/[._-]?\d+$/u, "").toLowerCase();
  return [
    material.type,
    normalizedName,
    material.side,
    material.transparent,
    material.opacity,
    material.alphaTest,
    material.depthTest,
    material.depthWrite,
    standard?.color.getHexString() ?? basic?.color.getHexString() ?? "none",
    standard?.emissive.getHexString() ?? "none",
    standard?.emissiveIntensity ?? 0,
    standard?.roughness ?? 0,
    standard?.metalness ?? 0,
    textureSourceKey(standard?.map ?? basic?.map ?? null),
    textureSourceKey(standard?.normalMap ?? null),
    textureSourceKey(standard?.roughnessMap ?? null),
    textureSourceKey(standard?.metalnessMap ?? null),
    textureSourceKey(standard?.emissiveMap ?? null),
    textureSourceKey(standard?.aoMap ?? null),
  ].join("|");
}

export function mergePlacedProps(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const buckets = new Map<string, {
    material: THREE.Material;
    castShadow: boolean;
    geometries: THREE.BufferGeometry[];
  }>();
  const oldGeometries = new Set<THREE.BufferGeometry>();
  let beforeMeshes = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    beforeMeshes += 1;
    oldGeometries.add(object.geometry);
    const material = Array.isArray(object.material) ? null : object.material;
    const materialKey = material ? semanticMaterialKey(material) : object.uuid;
    const signature = [
      materialKey,
      geometrySchema(object.geometry),
      object.geometry.index ? "indexed" : "plain",
      object.castShadow ? "shadow" : "no-shadow",
    ].join("|");
    const bucket = buckets.get(signature) ?? {
      material: material ?? (object.material as THREE.Material[])[0],
      castShadow: object.castShadow,
      geometries: [] as THREE.BufferGeometry[],
    };
    bucket.geometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
    buckets.set(signature, bucket);
  });
  const merged = new THREE.Group();
  merged.name = "merged-environment-props";
  for (const bucket of buckets.values()) {
    const geometry = bucket.geometries.length === 1
      ? bucket.geometries[0]
      : mergeGeometries(bucket.geometries, false);
    if (!geometry) {
      for (const sourceGeometry of bucket.geometries) sourceGeometry.dispose();
      continue;
    }
    if (bucket.geometries.length > 1) {
      for (const sourceGeometry of bucket.geometries) sourceGeometry.dispose();
    }
    const mesh = new THREE.Mesh(geometry, bucket.material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = true;
    merged.add(mesh);
  }
  for (const geometry of oldGeometries) geometry.dispose();
  return {
    root: merged,
    beforeMeshes,
    afterMeshes: merged.children.length,
    materialBuckets: buckets.size,
  };
}

export function retainLargestActorShadowMeshes(root: THREE.Object3D, limit = 3) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = false;
    meshes.push(object);
  });
  const triangleCount = (mesh: THREE.Mesh) => (
    (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0) / 3
  );
  const retained = [...meshes].sort((left, right) => triangleCount(right) - triangleCount(left)).slice(0, limit);
  for (const mesh of retained) mesh.castShadow = true;
  return { before: meshes.length, after: retained.length };
}


export function fitProp(source: THREE.Object3D, height: number, castShadow = false) {
  const model = source.clone(true);
  tuneMeshes(model, false, castShadow);
  const visual = new THREE.Group();
  visual.add(model);
  const original = new THREE.Box3().setFromObject(visual);
  const size = original.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(size.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  return flattenStatic(visual, castShadow);
}

export function fitModule(source: THREE.Object3D, size: THREE.Vector3) {
  const root = source.clone(true);
  tuneMeshes(root);
  const box = new THREE.Box3().setFromObject(root);
  const current = box.getSize(new THREE.Vector3());
  root.scale.set(size.x / Math.max(current.x, 0.001), size.y / Math.max(current.y, 0.001), size.z / Math.max(current.z, 0.001));
  const fitted = new THREE.Box3().setFromObject(root);
  root.position.sub(fitted.getCenter(new THREE.Vector3()));
  root.position.y += size.y / 2;
  return root;
}

export type ModulePlacement = { position: THREE.Vector3; rotation: number };

export function addInstancedModules(
  source: THREE.Object3D,
  size: THREE.Vector3,
  placements: ModulePlacement[],
  parent: THREE.Object3D,
  castShadow: boolean,
) {
  if (!placements.length) return;
  const template = flattenStatic(fitModule(source, size), false);
  template.updateMatrixWorld(true);
  const placementMatrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    const instances = new THREE.InstancedMesh(object.geometry, object.material, placements.length);
    instances.name = `instanced-${object.name || "module"}`;
    placements.forEach((placement, index) => {
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotation);
      placementMatrix.compose(placement.position, rotation, scale);
      instances.setMatrixAt(index, placementMatrix.clone().multiply(object.matrixWorld));
    });
    instances.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    instances.instanceMatrix.needsUpdate = true;
    instances.castShadow = castShadow;
    instances.receiveShadow = true;
    instances.computeBoundingBox();
    instances.computeBoundingSphere();
    parent.add(instances);
  });
}
