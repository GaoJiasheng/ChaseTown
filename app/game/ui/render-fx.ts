import * as THREE from "three";

export type RenderCategory = "actors" | "maze" | "props" | "fx" | "other";
export type RenderCategoryBudget = {
  mainCalls: number;
  mainTriangles: number;
  shadowCalls: number;
  shadowTriangles: number;
};
export type RenderBreakdown = Record<RenderCategory, RenderCategoryBudget>;
export type RenderTotals = {
  calls: number;
  triangles: number;
};

const RENDER_CATEGORIES: RenderCategory[] = ["actors", "maze", "props", "fx", "other"];

export const makeRenderBreakdown = () => ({
  actors: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  maze: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  props: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  fx: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
  other: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
} satisfies RenderBreakdown);

export const makeRenderTotals = (): RenderTotals => ({ calls: 0, triangles: 0 });

export function resetRenderBreakdown(target: RenderBreakdown) {
  for (const category of RENDER_CATEGORIES) {
    const budget = target[category];
    budget.mainCalls = 0;
    budget.mainTriangles = 0;
    budget.shadowCalls = 0;
    budget.shadowTriangles = 0;
  }
  return target;
}

export function copyRenderBreakdown(target: RenderBreakdown, source: RenderBreakdown) {
  for (const category of RENDER_CATEGORIES) {
    const targetBudget = target[category];
    const sourceBudget = source[category];
    targetBudget.mainCalls = sourceBudget.mainCalls;
    targetBudget.mainTriangles = sourceBudget.mainTriangles;
    targetBudget.shadowCalls = sourceBudget.shadowCalls;
    targetBudget.shadowTriangles = sourceBudget.shadowTriangles;
  }
  return target;
}

export function sumRenderBreakdown(source: RenderBreakdown, target: RenderTotals = makeRenderTotals()) {
  target.calls = 0;
  target.triangles = 0;
  for (const category of RENDER_CATEGORIES) {
    const budget = source[category];
    target.calls += budget.mainCalls + budget.shadowCalls;
    target.triangles += budget.mainTriangles + budget.shadowTriangles;
  }
  return target;
}

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
