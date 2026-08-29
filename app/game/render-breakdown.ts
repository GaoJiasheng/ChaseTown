import * as THREE from "three";

export type QaMainRenderCategory = "actor" | "maze-walls" | "props-dressing";
export type QaRenderCategory = QaMainRenderCategory | "shadow-pass";

export type QaRenderWorkload = Readonly<{
  calls: number;
  triangles: number;
}>;

export type QaRenderBreakdown = Readonly<{
  actor: QaRenderWorkload;
  "maze-walls": QaRenderWorkload;
  "props-dressing": QaRenderWorkload;
  "shadow-pass": QaRenderWorkload;
  total: QaRenderWorkload;
  reconciliation: Readonly<{
    exact: boolean;
    callsError: number;
    trianglesError: number;
    fallbackCalls: number;
    fallbackTriangles: number;
    note: string;
  }>;
}>;

type MutableWorkload = { calls: number; triangles: number };
type RendererInfoWithUpdate = THREE.WebGLRenderer["info"] & {
  update: (count: number, mode: number, instanceCount: number) => void;
};

const CATEGORY_KEY = "chasingQaRenderCategory";
const ZERO = (): MutableWorkload => ({ calls: 0, triangles: 0 });

export function tagQaRenderCategory(
  object: THREE.Object3D,
  category: QaMainRenderCategory,
) {
  object.userData[CATEGORY_KEY] = category;
}

function categoryFor(object: THREE.Object3D): QaMainRenderCategory {
  let cursor: THREE.Object3D | null = object;
  while (cursor) {
    const category = cursor.userData[CATEGORY_KEY];
    if (category === "actor" || category === "maze-walls" || category === "props-dressing") {
      return category;
    }
    cursor = cursor.parent;
  }
  return "props-dressing";
}

export function createQaRenderBreakdownTracker(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
) {
  const info = renderer.info as RendererInfoWithUpdate;
  const originalUpdate = info.update.bind(info);
  const instrumented = new WeakSet<THREE.Object3D>();
  let active = false;
  let shadowDepth = 0;
  let currentCategory: QaRenderCategory | null = null;
  let fallbackCalls = 0;
  let fallbackTriangles = 0;
  let workloads: Record<QaRenderCategory, MutableWorkload> = {
    actor: ZERO(),
    "maze-walls": ZERO(),
    "props-dressing": ZERO(),
    "shadow-pass": ZERO(),
  };
  let latest: QaRenderBreakdown = {
    actor: ZERO(),
    "maze-walls": ZERO(),
    "props-dressing": ZERO(),
    "shadow-pass": ZERO(),
    total: ZERO(),
    reconciliation: {
      exact: true,
      callsError: 0,
      trianglesError: 0,
      fallbackCalls: 0,
      fallbackTriangles: 0,
      note: "No rendered QA frame has been sampled yet.",
    },
  };

  info.update = (count, mode, instanceCount) => {
    const beforeCalls = info.render.calls;
    const beforeTriangles = info.render.triangles;
    originalUpdate(count, mode, instanceCount);
    if (!active) return;
    const calls = info.render.calls - beforeCalls;
    const triangles = info.render.triangles - beforeTriangles;
    const category = currentCategory ?? "props-dressing";
    workloads[category].calls += calls;
    workloads[category].triangles += triangles;
    if (currentCategory === null) {
      fallbackCalls += calls;
      fallbackTriangles += triangles;
    }
  };

  const instrumentObject = (object: THREE.Object3D) => {
    if (instrumented.has(object)) return;
    instrumented.add(object);
    const originalBeforeRender = object.onBeforeRender;
    const originalAfterRender = object.onAfterRender;
    const originalBeforeShadow = object.onBeforeShadow;
    const originalAfterShadow = object.onAfterShadow;
    object.onBeforeRender = function (...args) {
      originalBeforeRender.apply(this, args);
      if (active && shadowDepth === 0) currentCategory = categoryFor(this);
    };
    object.onAfterRender = function (...args) {
      originalAfterRender.apply(this, args);
      if (active && shadowDepth === 0) currentCategory = null;
    };
    object.onBeforeShadow = function (...args) {
      shadowDepth += 1;
      originalBeforeShadow.apply(this, args);
      if (active) currentCategory = "shadow-pass";
    };
    object.onAfterShadow = function (...args) {
      originalAfterShadow.apply(this, args);
      if (active) currentCategory = null;
      shadowDepth = Math.max(0, shadowDepth - 1);
    };
  };

  const instrumentScene = () => scene.traverse(instrumentObject);

  return {
    beginFrame() {
      instrumentScene();
      workloads = {
        actor: ZERO(),
        "maze-walls": ZERO(),
        "props-dressing": ZERO(),
        "shadow-pass": ZERO(),
      };
      fallbackCalls = 0;
      fallbackTriangles = 0;
      shadowDepth = 0;
      currentCategory = null;
      active = true;
    },
    endFrame(): QaRenderBreakdown {
      active = false;
      currentCategory = null;
      shadowDepth = 0;
      const total = {
        calls: info.render.calls,
        triangles: info.render.triangles,
      };
      const accounted = Object.values(workloads).reduce(
        (sum, workload) => ({
          calls: sum.calls + workload.calls,
          triangles: sum.triangles + workload.triangles,
        }),
        ZERO(),
      );
      const callsError = accounted.calls - total.calls;
      const trianglesError = accounted.triangles - total.triangles;
      latest = {
        actor: { ...workloads.actor },
        "maze-walls": { ...workloads["maze-walls"] },
        "props-dressing": { ...workloads["props-dressing"] },
        "shadow-pass": { ...workloads["shadow-pass"] },
        total,
        reconciliation: {
          exact: callsError === 0 && trianglesError === 0,
          callsError,
          trianglesError,
          fallbackCalls,
          fallbackTriangles,
          note: fallbackCalls === 0
            ? "Every renderer.info.update call was attributed by an object render callback."
            : "Renderer-managed draws without an object callback are conservatively included in props-dressing.",
        },
      };
      return latest;
    },
    snapshot: () => latest,
    dispose() {
      active = false;
      info.update = originalUpdate;
    },
  };
}
