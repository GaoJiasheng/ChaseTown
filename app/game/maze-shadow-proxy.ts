import * as THREE from "three";

export type MazeShadowPlacement = Readonly<{
  position: THREE.Vector3;
  rotation: number;
}>;

export type MazeShadowPlacementBatches = Readonly<{
  a: readonly MazeShadowPlacement[];
  b: readonly MazeShadowPlacement[];
  c: readonly MazeShadowPlacement[];
  wide: readonly MazeShadowPlacement[];
  end: readonly MazeShadowPlacement[];
  corner: readonly MazeShadowPlacement[];
  doorway: readonly MazeShadowPlacement[];
  junction: readonly MazeShadowPlacement[];
}>;

export type MazeShadowProxyStats = Readonly<{
  boxes: number;
  triangles: number;
  sourceModules: number;
}>;

type ProxyBox = Readonly<{
  position: THREE.Vector3;
  rotation: number;
  size: THREE.Vector3;
}>;

const UP = new THREE.Vector3(0, 1, 0);

function moduleBox(
  placement: MazeShadowPlacement,
  localX: number,
  localY: number,
  localZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): ProxyBox {
  const localOffset = new THREE.Vector3(localX, localY, localZ)
    .applyAxisAngle(UP, placement.rotation);
  return {
    position: placement.position.clone().add(localOffset),
    rotation: placement.rotation,
    size: new THREE.Vector3(sizeX, sizeY, sizeZ),
  };
}

export function mazeShadowProxyBoxes(
  batches: MazeShadowPlacementBatches,
  cell: number,
  wallHeight: number,
): readonly ProxyBox[] {
  const boxes: ProxyBox[] = [];
  const wallDepth = 0.28;
  const addWall = (placement: MazeShadowPlacement, width: number) => {
    boxes.push(moduleBox(
      placement,
      0,
      wallHeight / 2,
      0,
      width,
      wallHeight,
      wallDepth,
    ));
  };
  for (const role of ["a", "b", "c", "end"] as const) {
    for (const placement of batches[role]) addWall(placement, cell + 0.06);
  }
  for (const placement of batches.wide) addWall(placement, cell * 2 + 0.06);
  for (const placement of batches.corner) {
    boxes.push(moduleBox(placement, 0, wallHeight / 2, 0, 0.38, wallHeight, 0.38));
  }
  for (const placement of batches.doorway) {
    const postWidth = Math.max(0.24, cell * 0.18);
    const openingHalfWidth = cell * 0.34;
    const lintelHeight = Math.max(0.28, wallHeight * 0.18);
    const postHeight = wallHeight - lintelHeight;
    boxes.push(
      moduleBox(
        placement,
        -openingHalfWidth - postWidth / 2,
        postHeight / 2,
        0,
        postWidth,
        postHeight,
        wallDepth,
      ),
      moduleBox(
        placement,
        openingHalfWidth + postWidth / 2,
        postHeight / 2,
        0,
        postWidth,
        postHeight,
        wallDepth,
      ),
      moduleBox(
        placement,
        0,
        wallHeight - lintelHeight / 2,
        0,
        cell + 0.06,
        lintelHeight,
        wallDepth,
      ),
    );
  }
  // Junction landmarks vary by theme. Four posts plus two overhead beams keep
  // their legible cross/portal shadow without filling a traversable cell with
  // the opaque box that a raw bounding-volume proxy would create.
  for (const placement of batches.junction) {
    const inset = cell * 0.34;
    const post = 0.22;
    const beamHeight = 0.24;
    const postHeight = wallHeight - beamHeight;
    for (const localX of [-inset, inset]) {
      for (const localZ of [-inset, inset]) {
        boxes.push(moduleBox(
          placement,
          localX,
          postHeight / 2,
          localZ,
          post,
          postHeight,
          post,
        ));
      }
    }
    boxes.push(
      moduleBox(placement, 0, wallHeight - beamHeight / 2, -inset, cell * 0.86, beamHeight, post),
      moduleBox(placement, -inset, wallHeight - beamHeight / 2, 0, post, beamHeight, cell * 0.86),
    );
  }
  return boxes;
}

export function createMazeShadowProxy(
  batches: MazeShadowPlacementBatches,
  cell: number,
  wallHeight: number,
  name: string,
) {
  const boxes = mazeShadowProxyBoxes(batches, cell, wallHeight);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0x000000 });
  // The same object is submitted to the main camera so Three.js will admit it
  // to the shadow traversal. It writes neither colour nor depth in that pass;
  // the light pass substitutes MeshDepthMaterial and therefore still receives
  // the proxy silhouette.
  material.colorWrite = false;
  material.depthWrite = false;
  material.toneMapped = false;
  const proxy = new THREE.InstancedMesh(geometry, material, boxes.length);
  proxy.name = name;
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  proxy.renderOrder = -10_000;
  const rotation = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  boxes.forEach((box, index) => {
    rotation.setFromAxisAngle(UP, box.rotation);
    proxy.setMatrixAt(index, matrix.compose(box.position, rotation, box.size));
  });
  proxy.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  proxy.instanceMatrix.needsUpdate = true;
  proxy.computeBoundingBox();
  proxy.computeBoundingSphere();
  const sourceModules = Object.values(batches)
    .reduce((total, placements) => total + placements.length, 0);
  const stats: MazeShadowProxyStats = Object.freeze({
    boxes: boxes.length,
    triangles: boxes.length * 12,
    sourceModules,
  });
  proxy.userData.mazeShadowProxyStats = stats;
  return { proxy, stats };
}
