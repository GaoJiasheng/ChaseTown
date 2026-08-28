import type { Point } from "./contracts.ts";

/**
 * Parses an opt-in QA scenario coordinate without widening normal gameplay
 * input. The browser evidence harness uses this only when `?qa=...` is present.
 */
export function parseQaPoint(value: string | null): Point | null {
  if (!value) return null;
  const coordinates = value.split(",").map((part) => Number(part.trim()));
  if (
    coordinates.length !== 2
    || coordinates.some((coordinate) => !Number.isFinite(coordinate))
    || coordinates.some((coordinate) => coordinate < 0 || coordinate > 255)
  ) return null;
  return { x: coordinates[0], y: coordinates[1] };
}

/** Returns a one-based campaign level for deterministic browser evidence. */
export function parseQaLevel(value: string | null, levelCount = 10): number | null {
  if (!value) return null;
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1 || level > levelCount) return null;
  return level;
}

/** Bounds opt-in spawn delay used to hold a stable formal-camera art frame. */
export function parseQaDelaySeconds(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) return 0;
  return seconds;
}

/** Strict opt-in switch for browser-only evidence scenarios. */
export function parseQaFlag(value: string | null): boolean {
  return value === "1";
}

/** Accepts an explicit normalized animation sample in the closed [0, 1] range. */
export function parseQaNormalizedTime(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const normalizedTime = Number(value);
  return Number.isFinite(normalizedTime) && normalizedTime >= 0 && normalizedTime <= 1
    ? normalizedTime
    : null;
}

export type QaPoliceAnimationState = "idle" | "run" | "alert" | "point" | "protect";
export type QaPoliceAssetVariant = "bootstrap" | "high";

export type QaGltfDocument = {
  accessors?: Array<{ count?: number }>;
  nodes?: Array<{ name?: string }>;
  meshes?: Array<{
    primitives?: Array<{
      attributes?: { POSITION?: number };
      indices?: number;
      mode?: number;
    }>;
  }>;
  materials?: unknown[];
  textures?: unknown[];
  skins?: Array<{ joints?: number[] }>;
};

export type QaGltfDocumentSummary = Readonly<{
  nodes: number;
  meshes: number;
  primitives: number;
  triangles: number;
  materials: number;
  textures: number;
  skins: number;
  joints: number;
  jointNames: readonly string[];
}>;

function primitiveTriangleCount(
  primitive: NonNullable<NonNullable<QaGltfDocument["meshes"]>[number]["primitives"]>[number],
  accessors: NonNullable<QaGltfDocument["accessors"]>,
): number {
  const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
  const elementCount = accessorIndex === undefined
    ? 0
    : Math.max(0, Math.floor(accessors[accessorIndex]?.count ?? 0));
  switch (primitive.mode ?? 4) {
    case 4: return Math.floor(elementCount / 3);
    case 5:
    case 6: return Math.max(0, elementCount - 2);
    default: return 0;
  }
}

/**
 * Summarizes the actual JSON parsed by GLTFLoader. This is intentionally
 * independent of filesystem reports so browser evidence cannot stamp a new
 * disk hash over a stale cache entry.
 */
export function summarizeQaGltfDocument(
  document: QaGltfDocument | null | undefined,
): QaGltfDocumentSummary {
  const accessors = document?.accessors ?? [];
  const meshes = document?.meshes ?? [];
  const primitives = meshes.flatMap((mesh) => mesh.primitives ?? []);
  const jointIndices = new Set((document?.skins ?? []).flatMap((skin) => skin.joints ?? []));
  const jointNames = [...jointIndices]
    .map((index) => document?.nodes?.[index]?.name ?? `node-${index}`)
    .sort();
  return Object.freeze({
    nodes: document?.nodes?.length ?? 0,
    meshes: meshes.length,
    primitives: primitives.length,
    triangles: primitives.reduce(
      (total, primitive) => total + primitiveTriangleCount(primitive, accessors),
      0,
    ),
    materials: document?.materials?.length ?? 0,
    textures: document?.textures?.length ?? 0,
    skins: document?.skins?.length ?? 0,
    joints: jointIndices.size,
    jointNames: Object.freeze(jointNames),
  });
}

/** Maps the five authoritative Police GLB clips onto runtime animation states. */
export function parseQaPoliceAnimation(
  value: string | null,
): QaPoliceAnimationState | null {
  switch (value?.trim().toLowerCase()) {
    case "idle": return "idle";
    case "run": return "run";
    case "alert": return "alert";
    case "interact": return "point";
    case "resolve": return "protect";
    default: return null;
  }
}

/** Keeps high-detail Police loading an explicit QA-only opt-in. */
export function parseQaPoliceAssetVariant(
  value: string | null,
): QaPoliceAssetVariant | null {
  return value === "bootstrap" || value === "high" ? value : null;
}
