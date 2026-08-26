import * as THREE from "three";

export type BlockedGridRectangle = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type BlockedGridShadowProxyOptions = Readonly<{
  cellSize: number;
  wallHeight: number;
  baseY?: number;
  centerGridX?: number;
  centerGridY?: number;
  name?: string;
}>;

/**
 * Covers every false (blocked) cell exactly once with deterministic rectangles.
 * The row-major, width-first rule is deliberately stable so the same maze always
 * produces the same instance order and shadow geometry.
 */
export function greedyBlockedGridRectangles(
  walkableGrid: readonly (readonly boolean[])[],
): BlockedGridRectangle[] {
  const claimed = walkableGrid.map((row) => row.map(() => false));
  const rectangles: BlockedGridRectangle[] = [];

  for (let y = 0; y < walkableGrid.length; y += 1) {
    for (let x = 0; x < walkableGrid[y].length; x += 1) {
      if (walkableGrid[y][x] !== false || claimed[y][x]) continue;

      let width = 0;
      while (
        x + width < walkableGrid[y].length
        && walkableGrid[y][x + width] === false
        && !claimed[y][x + width]
      ) {
        width += 1;
      }

      let height = 1;
      while (
        y + height < walkableGrid.length
        && Array.from({ length: width }, (_, offset) => (
          walkableGrid[y + height][x + offset] === false
          && !claimed[y + height][x + offset]
        )).every(Boolean)
      ) {
        height += 1;
      }

      for (let coveredY = y; coveredY < y + height; coveredY += 1) {
        for (let coveredX = x; coveredX < x + width; coveredX += 1) {
          claimed[coveredY][coveredX] = true;
        }
      }
      rectangles.push({ x, y, width, height });
    }
  }

  return rectangles;
}

/** Builds one main-pass-invisible InstancedMesh that still participates in shadows. */
export function createBlockedGridShadowProxy(
  walkableGrid: readonly (readonly boolean[])[],
  options: BlockedGridShadowProxyOptions,
) {
  if (!(options.cellSize > 0) || !(options.wallHeight > 0)) {
    throw new RangeError("Shadow proxy cellSize and wallHeight must be positive.");
  }

  const rectangles = greedyBlockedGridRectangles(walkableGrid);
  const gridWidth = walkableGrid.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const centerGridX = options.centerGridX ?? (gridWidth - 1) / 2;
  const centerGridY = options.centerGridY ?? (walkableGrid.length - 1) / 2;
  const baseY = options.baseY ?? 0;
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthWrite: false,
  });
  const proxy = new THREE.InstancedMesh(geometry, material, rectangles.length);
  proxy.name = options.name ?? "blocked-grid-shadow-proxy";
  proxy.castShadow = true;
  proxy.receiveShadow = false;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  rectangles.forEach((rectangle, index) => {
    position.set(
      (rectangle.x + (rectangle.width - 1) / 2 - centerGridX) * options.cellSize,
      baseY + options.wallHeight / 2,
      (rectangle.y + (rectangle.height - 1) / 2 - centerGridY) * options.cellSize,
    );
    scale.set(
      rectangle.width * options.cellSize,
      options.wallHeight,
      rectangle.height * options.cellSize,
    );
    matrix.compose(position, rotation, scale);
    proxy.setMatrixAt(index, matrix);
  });
  proxy.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  proxy.instanceMatrix.needsUpdate = true;
  proxy.computeBoundingBox();
  proxy.computeBoundingSphere();
  proxy.userData.shadowProxy = {
    rectangles: rectangles.length,
    blockedCells: rectangles.reduce((total, rectangle) => total + rectangle.width * rectangle.height, 0),
    shadowTriangles: rectangles.length * 12,
  };

  return proxy;
}
