import * as THREE from "three";
export function disposeObjectResources(roots: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  const collectTexture = (value: unknown) => {
    if (value instanceof THREE.Texture) textures.add(value);
  };
  for (const root of roots) {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Sprite || object instanceof THREE.Points || object instanceof THREE.Line) {
        if ("geometry" in object && object.geometry instanceof THREE.BufferGeometry) geometries.add(object.geometry);
        const objectMaterial = "material" in object ? object.material : undefined;
        const objectMaterials = Array.isArray(objectMaterial) ? objectMaterial : objectMaterial ? [objectMaterial] : [];
        for (const material of objectMaterials) {
          if (!(material instanceof THREE.Material)) continue;
          materials.add(material);
          for (const value of Object.values(material)) collectTexture(value);
          if (material instanceof THREE.ShaderMaterial) {
            for (const uniform of Object.values(material.uniforms)) collectTexture(uniform.value);
          }
        }
      }
      if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  return {
    geometries: geometries.size,
    materials: materials.size,
    textures: textures.size,
    skeletons: skeletons.size,
  };
}
