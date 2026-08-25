import * as THREE from "three";

export type RenderCategory = "actors" | "maze" | "props" | "fx" | "other";
export type RenderCategoryBudget = {
  mainCalls: number;
  mainTriangles: number;
  shadowCalls: number;
  shadowTriangles: number;
};
export type RenderBreakdown = Record<RenderCategory, RenderCategoryBudget>;

export const makeRenderBreakdown = () => ({
  actors: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  maze: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  props: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  fx: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  other: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
} satisfies RenderBreakdown);

export const drawnTriangles = (
  object: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  group?: unknown,
) => {
  const renderGroup = group as { start: number; count: number } | null | undefined;
  const available = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
  const drawStart = Math.max(geometry.drawRange.start, renderGroup?.start ?? 0);
  const drawEnd = Math.min(
    Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.start + geometry.drawRange.count : available,
    renderGroup ? renderGroup.start + renderGroup.count : available,
  );
  const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
  return Math.max(0, drawEnd - drawStart) / 3 * instances;
};

export const trackRenderCategory = (
  root: THREE.Object3D,
  category: RenderCategory,
  getActiveBreakdown: () => RenderBreakdown,
) => {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Sprite)) return;
    object.userData.renderCategory = category;
    object.onBeforeRender = (_renderer, _scene, _camera, geometry, _material, group) => {
      const bucket = getActiveBreakdown()[category];
      bucket.mainCalls += 1;
      bucket.mainTriangles += drawnTriangles(object, geometry, group);
    };
    object.onBeforeShadow = (_renderer, _scene, _camera, _shadowCamera, geometry, _material, group) => {
      const bucket = getActiveBreakdown()[category];
      bucket.shadowCalls += 1;
      bucket.shadowTriangles += drawnTriangles(object, geometry, group);
    };
  });
};
