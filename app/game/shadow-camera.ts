import * as THREE from "three";

export type DirectionalShadowSnapSnapshot = Readonly<{
  texelWorldSize: number;
  sourceLightSpaceX: number;
  sourceLightSpaceY: number;
  lightSpaceX: number;
  lightSpaceY: number;
  texelIndexX: number;
  texelIndexY: number;
  preSnapResidualTexelsX: number;
  preSnapResidualTexelsY: number;
  snappedToTexelGridX: boolean;
  snappedToTexelGridY: boolean;
}>;

export function createDirectionalShadowTexelSnapper(
  lightOffset: Readonly<THREE.Vector3>,
) {
  const forward = new THREE.Vector3(
    -lightOffset.x,
    -lightOffset.y,
    -lightOffset.z,
  ).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  else right.normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const snapshot = {
    texelWorldSize: 0,
    sourceLightSpaceX: 0,
    sourceLightSpaceY: 0,
    lightSpaceX: 0,
    lightSpaceY: 0,
    texelIndexX: 0,
    texelIndexY: 0,
    preSnapResidualTexelsX: 0,
    preSnapResidualTexelsY: 0,
    snappedToTexelGridX: false,
    snappedToTexelGridY: false,
  };

  return {
    snap(
      anchor: Readonly<THREE.Vector3>,
      target: THREE.Vector3,
      halfExtent: number,
      mapSize: number,
    ): DirectionalShadowSnapSnapshot {
      const texelWorldSize = (halfExtent * 2) / Math.max(1, mapSize);
      const sourceX = anchor.x * right.x + anchor.y * right.y + anchor.z * right.z;
      const sourceY = anchor.x * up.x + anchor.y * up.y + anchor.z * up.z;
      const texelIndexX = Math.round(sourceX / texelWorldSize);
      const texelIndexY = Math.round(sourceY / texelWorldSize);
      const lightSpaceX = texelIndexX * texelWorldSize;
      const lightSpaceY = texelIndexY * texelWorldSize;
      const deltaX = lightSpaceX - sourceX;
      const deltaY = lightSpaceY - sourceY;
      target.set(
        anchor.x + right.x * deltaX + up.x * deltaY,
        anchor.y + right.y * deltaX + up.y * deltaY,
        anchor.z + right.z * deltaX + up.z * deltaY,
      );
      snapshot.texelWorldSize = texelWorldSize;
      snapshot.sourceLightSpaceX = sourceX;
      snapshot.sourceLightSpaceY = sourceY;
      snapshot.lightSpaceX = lightSpaceX;
      snapshot.lightSpaceY = lightSpaceY;
      snapshot.texelIndexX = texelIndexX;
      snapshot.texelIndexY = texelIndexY;
      snapshot.preSnapResidualTexelsX = sourceX / texelWorldSize - texelIndexX;
      snapshot.preSnapResidualTexelsY = sourceY / texelWorldSize - texelIndexY;
      snapshot.snappedToTexelGridX = Math.abs(
        lightSpaceX / texelWorldSize - texelIndexX,
      ) < 1e-10;
      snapshot.snappedToTexelGridY = Math.abs(
        lightSpaceY / texelWorldSize - texelIndexY,
      ) < 1e-10;
      return snapshot;
    },
    basis: Object.freeze({
      right: Object.freeze({ x: right.x, y: right.y, z: right.z }),
      up: Object.freeze({ x: up.x, y: up.y, z: up.z }),
    }),
  };
}
