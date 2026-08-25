"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Point = { x: number; y: number };
type Phase = "ready" | "playing" | "caught" | "won" | "lost";
type ActorName = "kid" | "villain" | "police";
type AiState = "delay" | "chase" | "search" | "patrol";
type AiMemory = {
  state: AiState;
  lastKnown: Point | null;
  searchArrivedAt: number | null;
};
type ActorMotionRuntime = {
  gaitWeight: number;
  gaitPhase: number;
  actualSpeed: number;
  heading: number;
  targetHeading: number;
  visualY: number;
  baseVisualY: number;
};
type GridPathCache = {
  signature: string;
  route: Point[];
  cursor: number;
  activeWaypoint: Point | null;
  recomputes: number;
  cacheHits: number;
  lastInvalidationReason: string;
};
type GpuMemorySnapshot = {
  geometries: number;
  textures: number;
  programs: number;
};
type ResourceDisposalReport = {
  reason: string;
  geometries: number;
  materials: number;
  textures: number;
  skeletons: number;
  externalTargets: number;
  before: GpuMemorySnapshot;
  after: GpuMemorySnapshot;
  completedAt: number;
  alreadyDisposed: boolean;
  contextLost: boolean;
};

export const P0_TUNING = Object.freeze({
  playerSpeed: 3.7,
  villainSpeed: 3.4,
  perceptionRadius: 5.5,
  startDelayMs: 1500,
  searchHoldMs: 2500,
  villainTurnSpeed: 3.2,
  sharpTurnSpeedMultiplier: 0.45,
  playerCollisionMargin: 0.18,
  captureFreezeMs: 600,
  lineOfSightSampleStep: 0.25,
});

export const P1_TUNING = Object.freeze({
  villainCollisionMargin: 0.14,
  gaitBlendSeconds: 0.15,
  gaitRadiansPerGridUnit: 3.5,
  playerTurnDamping: 12,
  policeTurnDamping: 7,
  markerDelayMs: 4000,
  markerFadeDamping: 8,
  policeTrackingDistance: 4,
  environmentIntensity: 1,
  exposure: 1,
  hemisphereIntensity: 2.2,
  sunIntensity: 2.9,
  rimIntensity: 1.36,
  sunShadowBias: -0.0005,
  sunShadowNormalBias: 0.02,
});

export const P2_TUNING = Object.freeze({
  threatNearDistance: 4.5,
  threatFarDistance: 9,
  unawareStateFactor: 0.25,
  vignetteDeadzone: 0.25,
  vignetteUiIntervalMs: 120,
  heartbeatSlowSeconds: 1.05,
  heartbeatFastSeconds: 0.5,
  heartbeatQuietGain: 0.018,
  heartbeatLoudGain: 0.078,
  footstepPhaseRadians: Math.PI,
  pathWaypointTolerance: 0.34,
  pathTurnMinimumMultiplier: 0.08,
});

const SIZE = 25;
const CELL = 2;
const START = { x: 1, y: 1 };
const EXIT = { x: 23, y: 23 };
const VILLAIN_START = { x: 7, y: 1 };
const POLICE_POINT = { x: 23, y: 22.25 };
const PATROL = [
  { x: 7, y: 7 },
  { x: 15, y: 3 },
  { x: 21, y: 10 },
  { x: 17, y: 19 },
  { x: 9, y: 20 },
];

const ACTOR_SPECS = [
  { name: "kid" as const, url: "/models/characters/kid.glb?v=21", height: 2.12, color: 0x4d9fff, label: "你" },
  { name: "villain" as const, url: "/models/characters/villain.glb?v=21", height: 2.28, color: 0xff4f5e, label: "追捕者" },
  { name: "police" as const, url: "/models/characters/police.glb?v=21", height: 2.18, color: 0x35e5f2, label: "警察" },
] as const;
const BLOCKING_ACTOR_SPECS = ACTOR_SPECS.filter((spec) => spec.name !== "police");

const CORE_ASSETS = {
  wall: "/models/environment/wall.glb",
  wallCorner: "/models/environment/wall-corner.glb",
  wallEnd: "/models/environment/wall-end.glb",
  floor: "/models/environment/floor.glb",
  exit: "/models/environment/exit.glb",
  frontGate: "/models/environment/front-gate.glb",
  classroomFloor: "/models/environment/classroom-floor.glb",
  playgroundFloor: "/models/environment/playground-floor.glb",
  grassFloor: "/models/environment/grass-floor.glb",
} as const;

const DETAIL_ASSETS = {
  locker: "/models/environment/locker.glb",
  bench: "/models/environment/bench.glb",
  car: "/models/environment/police-car.glb",
  tree: "/models/environment/tree.glb",
  classroomDoor: "/models/environment/classroom-door.glb",
  ceilingLight: "/models/environment/ceiling-light.glb",
  basketball: "/models/environment/basketball.glb",
  deskChair: "/models/environment/desk-chair.glb",
  blackboard: "/models/environment/blackboard.glb",
  bulletin: "/models/environment/bulletin.glb",
  podium: "/models/environment/podium.glb",
  extinguisher: "/models/environment/extinguisher.glb",
  trash: "/models/environment/trash.glb",
  books: "/models/environment/books.glb",
  backpack: "/models/environment/backpack.glb",
  shrub: "/models/environment/shrub.glb",
  station: "/models/environment/station.glb",
} as const;
export const P1_SHADOW_CASTERS = ["car", "tree", "station", "locker", "basketball", "bench", "blackboard", "podium"] as const;
const largeShadowProps = new Set<keyof typeof DETAIL_ASSETS>(P1_SHADOW_CASTERS);

function carve(grid: boolean[][], points: Point[]) {
  for (let i = 1; i < points.length; i += 1) {
    let { x, y } = points[i - 1];
    const target = points[i];
    while (x !== target.x || y !== target.y) {
      grid[y][x] = true;
      if (x !== target.x) x += Math.sign(target.x - x);
      else y += Math.sign(target.y - y);
    }
    grid[y][x] = true;
  }
}

function makeMaze() {
  const grid = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  carve(grid, [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 7 }, { x: 11, y: 7 }, { x: 11, y: 13 }, { x: 17, y: 13 }, { x: 17, y: 19 }, { x: 23, y: 19 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 1, y: 1 }, { x: 1, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 16 }, { x: 13, y: 16 }, { x: 13, y: 23 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 7, y: 7 }, { x: 7, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 10 }, { x: 21, y: 10 }, { x: 21, y: 23 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 3, y: 10 }, { x: 3, y: 14 }]);
  carve(grid, [{ x: 9, y: 13 }, { x: 9, y: 20 }]);
  carve(grid, [{ x: 15, y: 3 }, { x: 20, y: 3 }]);
  carve(grid, [{ x: 17, y: 16 }, { x: 22, y: 16 }]);
  carve(grid, [{ x: 11, y: 7 }, { x: 14, y: 7 }]);
  return grid;
}

const MAZE = makeMaze();
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const pointKey = (point: Point) => `${point.x},${point.y}`;
const canWalk = (x: number, y: number) => MAZE[Math.round(y)]?.[Math.round(x)] ?? false;
const world = (point: Point) => new THREE.Vector3((point.x - (SIZE - 1) / 2) * CELL, 0, (point.y - (SIZE - 1) / 2) * CELL);
const CAMERA_DIRECTION = Object.freeze({ x: 0.446, y: 0.668, z: 0.595 });
const cameraGroundLength = Math.hypot(CAMERA_DIRECTION.x, CAMERA_DIRECTION.z);
const SCREEN_UP = Object.freeze({
  x: -CAMERA_DIRECTION.x / cameraGroundLength,
  y: -CAMERA_DIRECTION.z / cameraGroundLength,
});
const SCREEN_RIGHT = Object.freeze({ x: -SCREEN_UP.y, y: SCREEN_UP.x });

export function threatStateFactor(state: AiState) {
  return state === "chase" || state === "search" ? 1 : P2_TUNING.unawareStateFactor;
}

export function proximityThreat(enemyDistance: number) {
  const span = P2_TUNING.threatFarDistance - P2_TUNING.threatNearDistance;
  const ratio = THREE.MathUtils.clamp((enemyDistance - P2_TUNING.threatNearDistance) / span, 0, 1);
  const smooth = ratio * ratio * (3 - 2 * ratio);
  return 1 - smooth;
}

export function finalThreat(enemyDistance: number, state: AiState, phase: Phase = "playing") {
  if (phase !== "playing") return 0;
  return proximityThreat(enemyDistance) * threatStateFactor(state);
}

export function vignetteStrength(threat: number) {
  return THREE.MathUtils.clamp(
    (threat - P2_TUNING.vignetteDeadzone) / (1 - P2_TUNING.vignetteDeadzone),
    0,
    1,
  );
}

export function hasLineOfSight(a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const span = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(span / P0_TUNING.lineOfSightSampleStep));
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    if (!canWalk(a.x + dx * progress, a.y + dy * progress)) return false;
  }
  return true;
}

export function canPlayerOccupy(x: number, y: number, margin = P0_TUNING.playerCollisionMargin) {
  return [
    { x: x - margin, y: y - margin },
    { x: x + margin, y: y - margin },
    { x: x - margin, y: y + margin },
    { x: x + margin, y: y + margin },
  ].every((sample) => canWalk(sample.x, sample.y));
}

export function screenAlignedMove(dx: number, dy: number) {
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  const inputX = dx / length;
  const inputY = dy / length;
  return {
    x: SCREEN_RIGHT.x * inputX + SCREEN_UP.x * -inputY,
    y: SCREEN_RIGHT.y * inputX + SCREEN_UP.y * -inputY,
  };
}

function shortestAngle(from: number, to: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function dampAngle(from: number, to: number, damping: number, delta: number) {
  return from + shortestAngle(from, to) * (1 - Math.exp(-damping * Math.max(0, delta)));
}

export function advanceGaitWeight(current: number, moving: boolean, delta: number) {
  const target = moving ? 1 : 0;
  const step = Math.max(0, delta) / P1_TUNING.gaitBlendSeconds;
  return current + THREE.MathUtils.clamp(target - current, -step, step);
}

export function advanceGaitPhase(phase: number, actualGridSpeed: number, delta: number) {
  if (actualGridSpeed <= 0 || delta <= 0) return phase;
  return phase + actualGridSpeed * P1_TUNING.gaitRadiansPerGridUnit * delta;
}

export function markerTargetOpacity(phase: Phase, playingElapsedMs: number, threat: number, villainMarker: boolean) {
  if (phase !== "playing") return 1;
  if (villainMarker && threat > 0.6) return 1;
  return playingElapsedMs < P1_TUNING.markerDelayMs ? 1 : 0;
}

export function gridQuarterTurn(x: number, y: number, salt = 0) {
  let hash = (Math.imul(x + 101, 374761393) ^ Math.imul(y + 211, 668265263) ^ Math.imul(salt + 17, 2246822519)) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) & 3;
}

export function shouldPoliceTrack(playerPoint: Point) {
  return distance(playerPoint, EXIT) < P1_TUNING.policeTrackingDistance;
}

function neighbors(point: Point) {
  return [
    { x: point.x + 1, y: point.y },
    { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x, y: point.y - 1 },
  ].filter((candidate) => canWalk(candidate.x, candidate.y));
}

export function findGridPath(from: Point, to: Point) {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const goal = { x: Math.round(to.x), y: Math.round(to.y) };
  const queue = [start];
  const cameFrom = new Map<string, Point | null>([[pointKey(start), null]]);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    if (pointKey(current) === pointKey(goal)) break;
    for (const next of neighbors(current)) {
      if (!cameFrom.has(pointKey(next))) {
        cameFrom.set(pointKey(next), current);
        queue.push(next);
      }
    }
  }
  if (!cameFrom.has(pointKey(goal))) return [];
  const route: Point[] = [];
  let current: Point | null = goal;
  while (current) {
    route.push(current);
    current = cameFrom.get(pointKey(current)) ?? null;
  }
  return route.reverse();
}

const roundedCell = (point: Point) => ({ x: Math.round(point.x), y: Math.round(point.y) });

export function pathCacheSignature(state: AiState, from: Point, target: Point) {
  const start = roundedCell(from);
  const goal = roundedCell(target);
  return `${state}:${start.x},${start.y}>${goal.x},${goal.y}`;
}

export function pathCacheInvalidationReason(previousSignature: string, nextSignature: string) {
  if (!previousSignature) return "empty-cache";
  if (previousSignature === nextSignature) return null;
  const [previousState, previousCells] = previousSignature.split(":");
  const [nextState, nextCells] = nextSignature.split(":");
  if (previousState !== nextState) return "ai-state";
  const [previousFrom, previousTarget] = previousCells.split(">");
  const [nextFrom, nextTarget] = nextCells.split(">");
  if (previousFrom !== nextFrom) return "villain-cell";
  if (previousTarget !== nextTarget) return "target-cell";
  return "signature";
}

export function gridPathDistanceMeters(from: Point, to: Point) {
  const route = findGridPath(from, to);
  return route.length ? (route.length - 1) * CELL : null;
}

export function stepVillainToward(
  entity: Point,
  target: Point,
  heading: number,
  speed: number,
  delta: number,
  cachedRoute?: readonly Point[],
) {
  const route = cachedRoute ?? findGridPath(entity, target);
  const next = route[1] ?? target;
  if (!route.length) {
    return { point: entity, heading, turnError: 0, speedMultiplier: 1 };
  }
  const dx = next.x - entity.x;
  const dy = next.y - entity.y;
  const length = Math.hypot(dx, dy) || 1;
  const desiredHeading = Math.atan2(dx, dy);
  const turnError = shortestAngle(heading, desiredHeading);
  const turn = THREE.MathUtils.clamp(
    turnError,
    -P0_TUNING.villainTurnSpeed * delta,
    P0_TUNING.villainTurnSpeed * delta,
  );
  const nextHeading = heading + turn;
  const sharpTurnMultiplier = Math.abs(turnError) > Math.PI / 2
    ? P0_TUNING.sharpTurnSpeedMultiplier
    : 1;
  const pathAlignmentMultiplier = cachedRoute === undefined
    ? 1
    : THREE.MathUtils.clamp(Math.cos(Math.abs(turnError)), P2_TUNING.pathTurnMinimumMultiplier, 1);
  const speedMultiplier = sharpTurnMultiplier * pathAlignmentMultiplier;
  const step = Math.min(speed * speedMultiplier * delta, length);
  const candidateX = entity.x + Math.sin(nextHeading) * step;
  const candidateY = entity.y + Math.cos(nextHeading) * step;
  const point = { ...entity };
  if (canPlayerOccupy(candidateX, point.y, P1_TUNING.villainCollisionMargin)) point.x = candidateX;
  if (canPlayerOccupy(point.x, candidateY, P1_TUNING.villainCollisionMargin)) point.y = candidateY;
  return { point, heading: nextHeading, turnError, speedMultiplier };
}

export function planVillainAi(
  memory: AiMemory,
  villainPoint: Point,
  playerPoint: Point,
  now: number,
  startTime: number,
) {
  if (now - startTime < P0_TUNING.startDelayMs) {
    return {
      memory: { state: "delay" as const, lastKnown: null, searchArrivedAt: null },
      target: null,
      seesPlayer: false,
    };
  }

  const seesPlayer = distance(villainPoint, playerPoint) < P0_TUNING.perceptionRadius
    && hasLineOfSight(villainPoint, playerPoint);
  if (seesPlayer) {
    return {
      memory: { state: "chase" as const, lastKnown: { ...playerPoint }, searchArrivedAt: null },
      target: { ...playerPoint },
      seesPlayer: true,
    };
  }

  if (memory.state === "chase" && memory.lastKnown) {
    return {
      memory: { state: "search" as const, lastKnown: { ...memory.lastKnown }, searchArrivedAt: null },
      target: { ...memory.lastKnown },
      seesPlayer: false,
    };
  }

  if (memory.state === "search" && memory.lastKnown) {
    if (distance(villainPoint, memory.lastKnown) >= 0.2) {
      return {
        memory: { ...memory, searchArrivedAt: null },
        target: { ...memory.lastKnown },
        seesPlayer: false,
      };
    }
    const arrivedAt = memory.searchArrivedAt ?? now;
    if (now - arrivedAt < P0_TUNING.searchHoldMs) {
      return {
        memory: { ...memory, searchArrivedAt: arrivedAt },
        target: null,
        seesPlayer: false,
      };
    }
  }

  return {
    memory: { state: "patrol" as const, lastKnown: null, searchArrivedAt: null },
    target: null,
    seesPlayer: false,
  };
}

function tuneMeshes(root: THREE.Object3D, disableCulling = false, castShadow = true) {
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

function flattenStatic(root: THREE.Object3D, castShadow = false) {
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
    const bucket = buckets.get(signature) ?? { material: object.material, geometries: [] };
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

function geometrySchema(geometry: THREE.BufferGeometry) {
  return (Object.entries(geometry.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][])
    .map(([name, attribute]) => {
      const array = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
      return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}`;
    })
    .sort()
    .join("|");
}

function textureSourceKey(texture: THREE.Texture | null) {
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

function semanticMaterialKey(material: THREE.Material) {
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

function mergePlacedProps(root: THREE.Object3D) {
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
      material: material ?? object.material[0],
      castShadow: object.castShadow,
      geometries: [],
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

function retainLargestActorShadowMeshes(root: THREE.Object3D, limit = 3) {
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

function fitActor(source: THREE.Object3D, height: number, hideNodes: string[] = []) {
  const visual = new THREE.Group();
  visual.name = "fitted-character";
  visual.add(source);
  if (hideNodes.length) {
    source.traverse((object) => {
      const name = object.name.toLowerCase();
      if (hideNodes.some((needle) => name.includes(needle))) object.visible = false;
    });
  }
  tuneMeshes(source, true);
  const original = new THREE.Box3().setFromObject(visual);
  const originalSize = original.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(originalSize.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  visual.userData.baseY = visual.position.y;
  const actor = new THREE.Group();
  actor.add(visual);
  actor.userData.visual = visual;
  actor.userData.shadowBudget = retainLargestActorShadowMeshes(actor, 3);
  return actor;
}

function fitProp(source: THREE.Object3D, height: number, castShadow = false) {
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

function fitModule(source: THREE.Object3D, size: THREE.Vector3) {
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

type ModulePlacement = { position: THREE.Vector3; rotation: number };

function addInstancedModules(
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

function makeLabel(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.Sprite();
  const paint = (nextText: string, nextColor: string) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(5, 12, 9, .88)";
    context.fillRect(8, 12, 368, 104);
    context.strokeStyle = nextColor;
    context.lineWidth = 6;
    context.strokeRect(8, 12, 368, 104);
    context.fillStyle = nextColor;
    context.font = '800 48px Arial, "PingFang SC", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(nextText, 192, 66);
  };
  paint(text, color);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.3, 0.43, 1);
  sprite.renderOrder = 999;
  sprite.userData.labelText = text;
  sprite.userData.labelColor = color;
  sprite.userData.setLabel = (nextText: string, nextColor: string) => {
    if (sprite.userData.labelText === nextText && sprite.userData.labelColor === nextColor) return;
    paint(nextText, nextColor);
    sprite.userData.labelText = nextText;
    sprite.userData.labelColor = nextColor;
    texture.needsUpdate = true;
  };
  return sprite;
}

function setActorLabel(actor: THREE.Object3D | undefined, text: string, color: string) {
  const badge = actor?.userData.badge as THREE.Sprite | undefined;
  const update = badge?.userData.setLabel as ((nextText: string, nextColor: string) => void) | undefined;
  update?.(text, color);
}

function setActorMarkerOpacity(actor: THREE.Object3D | undefined, opacity: number) {
  if (!actor) return;
  const badge = actor.userData.badge as THREE.Sprite | undefined;
  const ring = actor.userData.ring as THREE.Mesh | undefined;
  const badgeMaterial = badge?.material as THREE.SpriteMaterial | undefined;
  const ringMaterial = ring?.material as THREE.MeshBasicMaterial | undefined;
  if (badgeMaterial) badgeMaterial.opacity = opacity;
  if (ringMaterial) ringMaterial.opacity = opacity * 0.95;
  actor.userData.markerOpacity = opacity;
}

function decorateActor(actor: THREE.Object3D, height: number, color: number, label: string) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.7, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.035;
  ring.renderOrder = 998;
  actor.add(ring);
  const badge = makeLabel(label, `#${color.toString(16).padStart(6, "0")}`);
  badge.position.y = height + 0.58;
  actor.add(badge);
  actor.userData.badge = badge;
  actor.userData.ring = ring;
  actor.userData.markerOpacity = 1;
  actor.userData.markerTargetOpacity = 1;
  const fill = new THREE.PointLight(label === "追捕者" ? 0xffcfc7 : 0xffeadc, label === "追捕者" ? 1.55 : 1.2, 5.5, 2);
  fill.position.y = 1.45;
  actor.add(fill);
  const rig: Record<string, { bone: THREE.Object3D; rest: THREE.Quaternion }> = {};
  const animatedBones = new Set(["LeftUpperArm", "RightUpperArm", "LeftLowerArm", "RightLowerArm", "LeftUpperLeg", "RightUpperLeg", "LeftLowerLeg", "RightLowerLeg"]);
  actor.traverse((object) => {
    if (animatedBones.has(object.name)) rig[object.name] = { bone: object, rest: object.quaternion.clone() };
  });
  actor.userData.rig = rig;
}

function poseRig(actor: THREE.Object3D, gaitWave: number, gaitWeight: number) {
  const rig = actor.userData.rig as Record<string, { bone: THREE.Object3D; rest: THREE.Quaternion }> | undefined;
  if (!rig) return;
  const axis = new THREE.Vector3(1, 0, 0);
  const delta = new THREE.Quaternion();
  const apply = (name: string, angle: number) => {
    const joint = rig[name];
    if (!joint) return;
    joint.bone.quaternion.copy(joint.rest).multiply(delta.setFromAxisAngle(axis, angle));
  };
  const gait = gaitWave * gaitWeight;
  apply("LeftUpperLeg", gait * 0.52);
  apply("RightUpperLeg", -gait * 0.52);
  apply("LeftLowerLeg", Math.max(0, -gait) * 0.38);
  apply("RightLowerLeg", Math.max(0, gait) * 0.38);
  apply("LeftUpperArm", -gait * 0.38);
  apply("RightUpperArm", gait * 0.38);
  apply("LeftLowerArm", (-0.12 - Math.max(0, gaitWave) * 0.16) * gaitWeight);
  apply("RightLowerArm", (-0.12 - Math.max(0, -gaitWave) * 0.16) * gaitWeight);
}

type SynthContext = {
  currentTime: number;
  state: "closed" | "running" | "suspended" | "interrupted";
  destination: AudioDestinationNode;
  createOscillator: () => OscillatorNode;
  createGain: () => GainNode;
  resume: () => Promise<void>;
  suspend: () => Promise<void>;
  close: () => Promise<void>;
};
type SynthConstructor = new () => SynthContext;

function makeSynthAudioRuntime(target: Window) {
  let context: SynthContext | null = null;
  let nextHeartbeatAt = 0;
  let lastStepIndex = 0;
  let lastPhase: Phase = "ready";
  const sources = new Set<OscillatorNode>();
  const snapshot = {
    created: false,
    state: "not-created",
    unlocks: 0,
    heartbeats: 0,
    footsteps: 0,
    winStingers: 0,
    lossStingers: 0,
    activeSources: 0,
    heartbeatIntervalSeconds: P2_TUNING.heartbeatSlowSeconds,
    lastThreat: 0,
  };
  const syncSnapshot = () => {
    snapshot.state = context?.state ?? "not-created";
    snapshot.activeSources = sources.size;
  };
  const tone = (frequency: number, gainValue: number, duration: number, delay = 0, wave: OscillatorType = "sine") => {
    if (!context || context.state !== "running") return;
    const startsAt = context.currentTime + delay;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = wave;
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, gainValue), startsAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    sources.add(oscillator);
    oscillator.onended = () => {
      sources.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
      syncSnapshot();
    };
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration + 0.015);
    syncSnapshot();
  };
  const stopSources = () => {
    for (const source of [...sources]) {
      source.onended = null;
      try { source.stop(); } catch { /* The node may already have ended. */ }
      source.disconnect();
      sources.delete(source);
    }
    syncSnapshot();
  };
  const unlock = async () => {
    if (!context) {
      const contextKey = ["Audio", "Context"].join("");
      const constructor = (target as unknown as Record<string, unknown>)[contextKey] as SynthConstructor | undefined;
      if (!constructor) return;
      context = new constructor();
      snapshot.created = true;
      nextHeartbeatAt = context.currentTime + 0.12;
    }
    if (context.state === "suspended" || context.state === "interrupted") await context.resume();
    snapshot.unlocks += 1;
    syncSnapshot();
  };
  const update = (threat: number, motion: ActorMotionRuntime | undefined) => {
    snapshot.lastThreat = threat;
    if (!context || context.state !== "running" || lastPhase !== "playing") return;
    const heartbeatInterval = THREE.MathUtils.lerp(
      P2_TUNING.heartbeatSlowSeconds,
      P2_TUNING.heartbeatFastSeconds,
      threat,
    );
    snapshot.heartbeatIntervalSeconds = heartbeatInterval;
    if (threat > 0.08 && context.currentTime >= nextHeartbeatAt) {
      const gain = THREE.MathUtils.lerp(P2_TUNING.heartbeatQuietGain, P2_TUNING.heartbeatLoudGain, threat);
      tone(68 + threat * 12, gain, 0.09, 0, "sine");
      tone(52 + threat * 8, gain * 0.72, 0.1, 0.12, "sine");
      snapshot.heartbeats += 1;
      nextHeartbeatAt = context.currentTime + heartbeatInterval;
    }
    if (motion && motion.gaitWeight > 0.3 && motion.actualSpeed > 0.2) {
      const stepIndex = Math.floor(motion.gaitPhase / P2_TUNING.footstepPhaseRadians);
      if (stepIndex !== lastStepIndex) {
        lastStepIndex = stepIndex;
        tone(92 + (stepIndex & 1) * 12, 0.025 * motion.gaitWeight, 0.045, 0, "triangle");
        snapshot.footsteps += 1;
      }
    } else if (motion) {
      lastStepIndex = Math.floor(motion.gaitPhase / P2_TUNING.footstepPhaseRadians);
    }
    syncSnapshot();
  };
  const onPhase = (next: Phase) => {
    if (next === lastPhase) return;
    lastPhase = next;
    if (next !== "playing") stopSources();
    if (next === "won") {
      tone(392, 0.055, 0.16, 0, "triangle");
      tone(523.25, 0.06, 0.2, 0.14, "triangle");
      tone(659.25, 0.065, 0.32, 0.3, "triangle");
      snapshot.winStingers += 1;
    } else if (next === "lost") {
      tone(196, 0.065, 0.2, 0, "sawtooth");
      tone(146.83, 0.055, 0.38, 0.17, "sawtooth");
      snapshot.lossStingers += 1;
    }
    syncSnapshot();
  };
  const suspend = async () => {
    stopSources();
    if (context?.state === "running") await context.suspend();
    syncSnapshot();
  };
  const dispose = async () => {
    stopSources();
    if (context && context.state !== "closed") await context.close();
    syncSnapshot();
  };
  return { unlock, update, onPhase, suspend, dispose, getSnapshot: () => ({ ...snapshot }) };
}

export function ChasingGame() {
  const mount = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>());
  const player = useRef<Point>({ ...START });
  const villain = useRef<Point>({ ...VILLAIN_START });
  const patrol = useRef(0);
  const aiMemory = useRef<AiMemory>({ state: "delay", lastKnown: null, searchArrivedAt: null });
  const villainHeading = useRef(Math.PI / 2);
  const villainTarget = useRef<Point | null>(null);
  const villainSeesPlayer = useRef(false);
  const villainTurn = useRef({ error: 0, speedMultiplier: 1 });
  const villainPathCache = useRef<GridPathCache>({
    signature: "",
    route: [],
    cursor: 0,
    activeWaypoint: null,
    recomputes: 0,
    cacheHits: 0,
    lastInvalidationReason: "empty-cache",
  });
  const lastInputIntent = useRef<Point>({ x: 0, y: 0 });
  const lastPlayerDelta = useRef<Point>({ x: 0, y: 0 });
  const inputSafety = useRef({ clearCount: 0, lastClearReason: null as string | null });
  const caughtAt = useRef<number | null>(null);
  const started = useRef(0);
  const readyRef = useRef(false);
  const phaseRef = useRef<Phase>("ready");
  const cameraZoom = useRef(1);
  const actors = useRef<Partial<Record<ActorName, THREE.Object3D>>>({});
  const objectiveDistanceRuntime = useRef(gridPathDistanceMeters(START, EXIT) ?? 0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [elapsed, setElapsed] = useState(0);
  const [objectiveDistance, setObjectiveDistance] = useState(gridPathDistanceMeters(START, EXIT) ?? 0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: BLOCKING_ACTOR_SPECS.length + Object.keys(CORE_ASSETS).length, message: "正在载入项目美术资产：人物与校园…" });
  const [detailProgress, setDetailProgress] = useState(0);

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const reset = useCallback(() => {
    if (!readyRef.current) return;
    player.current = { ...START };
    villain.current = { ...VILLAIN_START };
    patrol.current = 0;
    aiMemory.current = { state: "delay", lastKnown: null, searchArrivedAt: null };
    villainHeading.current = Math.PI / 2;
    villainTarget.current = null;
    villainSeesPlayer.current = false;
    villainTurn.current = { error: 0, speedMultiplier: 1 };
    villainPathCache.current = {
      signature: "",
      route: [],
      cursor: 0,
      activeWaypoint: null,
      recomputes: 0,
      cacheHits: 0,
      lastInvalidationReason: "empty-cache",
    };
    lastInputIntent.current = { x: 0, y: 0 };
    lastPlayerDelta.current = { x: 0, y: 0 };
    caughtAt.current = null;
    started.current = performance.now();
    for (const [name, actor] of Object.entries(actors.current)) {
      if (!actor) continue;
      const resetPoint = name === "kid" ? START : name === "villain" ? VILLAIN_START : POLICE_POINT;
      const resetHeading = name === "villain" ? Math.PI / 2 : name === "police" ? Math.PI : 0;
      actor.position.copy(world(resetPoint));
      actor.rotation.y = resetHeading;
      const motion = actor?.userData.motion as ActorMotionRuntime | undefined;
      if (motion) {
        motion.gaitWeight = 0;
        motion.gaitPhase = 0;
        motion.actualSpeed = 0;
        motion.heading = resetHeading;
        motion.targetHeading = motion.heading;
      }
      const visual = actor.userData.visual as THREE.Group | undefined;
      if (visual) {
        const baseY = visual.userData.baseY as number;
        visual.position.y = baseY;
        visual.rotation.set(0, 0, 0);
      }
      poseRig(actor, 0, 0);
      actor.userData.markerTargetOpacity = 1;
      setActorMarkerOpacity(actor, 1);
    }
    setElapsed(0);
    objectiveDistanceRuntime.current = gridPathDistanceMeters(START, EXIT) ?? 0;
    setObjectiveDistance(objectiveDistanceRuntime.current);
    changePhase("playing");
  }, [changePhase]);

  useEffect(() => {
    const clearKeys = (reason: string) => {
      keys.current.clear();
      inputSafety.current.clearCount += 1;
      inputSafety.current.lastClearReason = reason;
    };
    const keyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
      keys.current.add(event.key.toLowerCase());
      if (event.key.toLowerCase() === "r") reset();
      if (event.key === "0") cameraZoom.current = 1;
      if (event.key === "-" || event.key === "_") cameraZoom.current = THREE.MathUtils.clamp(cameraZoom.current * 1.12, 0.78, 1.55);
      if (event.key === "+" || event.key === "=") cameraZoom.current = THREE.MathUtils.clamp(cameraZoom.current / 1.12, 0.78, 1.55);
      if ((event.key === " " || event.key === "Enter") && phaseRef.current !== "playing") reset();
    };
    const keyUp = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase());
    const clearOnBlur = () => clearKeys("window-blur");
    const visibilityEvent = ["visibility", "change"].join("");
    const clearWhenHidden = () => {
      if (document.hidden) clearKeys("document-hidden");
    };
    addEventListener("keydown", keyDown);
    addEventListener("keyup", keyUp);
    addEventListener("blur", clearOnBlur);
    document.addEventListener(visibilityEvent, clearWhenHidden);
    return () => {
      removeEventListener("keydown", keyDown);
      removeEventListener("keyup", keyUp);
      removeEventListener("blur", clearOnBlur);
      document.removeEventListener(visibilityEvent, clearWhenHidden);
      clearKeys("input-effect-cleanup");
    };
  }, [reset]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;
    let last = performance.now();
    let lastHudUpdate = 0;
    let lastVignetteUpdate = 0;
    let beacon: THREE.Group | undefined;
    let observer: ResizeObserver | null = null;
    readyRef.current = false;
    actors.current = {};
    const audioRuntime = makeSynthAudioRuntime(window);
    const unlockAudio = () => { void audioRuntime.unlock(); };
    const audioVisibilityEvent = ["visibility", "change"].join("");
    const suspendAudioWhenHidden = () => { if (document.hidden) void audioRuntime.suspend(); };
    addEventListener("pointerdown", unlockAudio);
    addEventListener("keydown", unlockAudio);
    document.addEventListener(audioVisibilityEvent, suspendAudioWhenHidden);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x91aa99);
    scene.fog = new THREE.Fog(0x91aa99, 25, 62);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 130);
    const cameraDirection = new THREE.Vector3(CAMERA_DIRECTION.x, CAMERA_DIRECTION.y, CAMERA_DIRECTION.z).normalize();
    const cameraRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), cameraDirection).normalize();
    const cameraUp = new THREE.Vector3().crossVectors(cameraDirection, cameraRight).normalize();
    const cameraFocus = world(START).add(new THREE.Vector3(0, 1.02, 0));
    let cameraDistance = 15.6;
    const cameraRuntime = { threat: 0, targetDistance: cameraDistance };
    const threatRuntime = {
      distance: distance(player.current, villain.current),
      proximity: 0,
      stateFactor: P2_TUNING.unawareStateFactor,
      final: 0,
      vignette: 0,
      cssValue: "0.000",
    };
    camera.position.copy(cameraFocus).addScaledVector(cameraDirection, cameraDistance);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = P1_TUNING.exposure;
    host.appendChild(renderer.domElement);
    const gpuMemory = (): GpuMemorySnapshot => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    });
    const roomEnvironment = new RoomEnvironment();
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const environmentTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
    scene.environment = environmentTarget.texture;
    roomEnvironment.dispose();
    pmremGenerator.dispose();
    const hemisphere = new THREE.HemisphereLight(0xe4f7ff, 0x405846, P1_TUNING.hemisphereIntensity);
    const sun = new THREE.DirectionalLight(0xffefd0, P1_TUNING.sunIntensity);
    const rim = new THREE.DirectionalLight(0x9bc8ff, P1_TUNING.rimIntensity);
    const loadedAssetRoots = new Set<THREE.Object3D>();
    const propTemplates = new Map<string, THREE.Object3D>();
    const propsRoot = new THREE.Group();
    propsRoot.name = "environment-props";
    scene.add(propsRoot);
    let gpuReleased = false;
    let lastDisposal: ResourceDisposalReport | null = null;
    const readPreviousDisposal = () => {
      try {
        const raw = sessionStorage.getItem("chasing-last-disposal");
        return raw ? JSON.parse(raw) as ResourceDisposalReport : null;
      } catch {
        return null;
      }
    };
    const releaseGpuResources = (reason: string): ResourceDisposalReport => {
      if (gpuReleased && lastDisposal) return { ...lastDisposal, reason, alreadyDisposed: true };
      const before = gpuMemory();
      const disposedResources = disposeObjectResources([
        scene,
        ...loadedAssetRoots,
        ...propTemplates.values(),
      ]);
      scene.environment = null;
      environmentTarget.dispose();
      const shadowMap = sun.shadow.map;
      const shadowMapPass = sun.shadow.mapPass;
      sun.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      const after = gpuMemory();
      gpuReleased = true;
      lastDisposal = {
        reason,
        ...disposedResources,
        externalTargets: 1 + (shadowMap ? 1 : 0) + (shadowMapPass ? 1 : 0),
        before,
        after,
        completedAt: performance.now(),
        alreadyDisposed: false,
        contextLost: true,
      };
      try {
        const serialized = JSON.stringify(lastDisposal);
        sessionStorage.setItem("chasing-last-disposal", serialized);
        document.documentElement.dataset.chasingLastDisposal = serialized;
      } catch {
        // A disposal report is diagnostic only; cleanup must still complete.
      }
      return lastDisposal;
    };
    const shadowCasterCounts: Partial<Record<keyof typeof DETAIL_ASSETS, number>> = {};
    const shadowCasterMeshCounts: Partial<Record<keyof typeof DETAIL_ASSETS, number>> = {};
    const floorRotationEvidence = {
      samples: [] as { x: number; y: number; floor: string; quarterTurn: number }[],
      histogram: [0, 0, 0, 0],
      checksum: 2166136261 >>> 0,
      wallRandomized: false,
    };
    const policeRuntime = {
      trackingPlayer: false,
      distanceToExit: distance(player.current, EXIT),
      targetHeading: Math.PI,
    };
    let detailsLoaded = 0;
    const detailTotal = Object.keys(DETAIL_ASSETS).length + 1;
    const qaWindow = window as typeof window & {
      __CHASING_QA__?: {
        getState: () => unknown;
        setPositions: (next: { player?: Point; villain?: Point }) => void;
        dispose: () => ResourceDisposalReport;
      };
    };
    let qaApi: typeof qaWindow.__CHASING_QA__;
    let qaLastSnapshotUpdate = 0;
    const qaRenderSnapshot = {
      calls: 0,
      triangles: 0,
      frame: 0,
      capturedAt: 0,
      memory: gpuMemory(),
    };
    type RenderCategory = "actors" | "maze" | "props" | "fx" | "other";
    type RenderCategoryBudget = { mainCalls: number; mainTriangles: number; shadowCalls: number; shadowTriangles: number };
    const makeRenderBreakdown = () => ({
      actors: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
      maze: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
      props: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
      fx: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
      other: { mainCalls: 0, mainTriangles: 0, shadowCalls: 0, shadowTriangles: 0 },
    } satisfies Record<RenderCategory, RenderCategoryBudget>);
    let activeRenderBreakdown = makeRenderBreakdown();
    let qaRenderBreakdown = makeRenderBreakdown();
    let qaRenderReconciliation = {
      rawUnclassifiedCalls: 0,
      rawUnclassifiedTriangles: 0,
      callsDelta: 0,
      trianglesDelta: 0,
    };
    const propMergeRuntime = { beforeMeshes: 0, afterMeshes: 0, materialBuckets: 0, complete: false };
    const drawnTriangles = (object: THREE.Object3D, geometry: THREE.BufferGeometry, group?: THREE.Group | null) => {
      const available = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
      const drawStart = Math.max(geometry.drawRange.start, group?.start ?? 0);
      const drawEnd = Math.min(
        Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.start + geometry.drawRange.count : available,
        group ? group.start + group.count : available,
      );
      const instances = object instanceof THREE.InstancedMesh ? object.count : 1;
      return Math.max(0, drawEnd - drawStart) / 3 * instances;
    };
    const trackRenderCategory = (root: THREE.Object3D, category: RenderCategory) => {
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Sprite)) return;
        object.userData.renderCategory = category;
        object.onBeforeRender = (_renderer, _scene, _camera, geometry, _material, group) => {
          const bucket = activeRenderBreakdown[category];
          bucket.mainCalls += 1;
          bucket.mainTriangles += drawnTriangles(object, geometry, group);
        };
        object.onBeforeShadow = (_renderer, _scene, _camera, _shadowCamera, geometry, _material, group) => {
          const bucket = activeRenderBreakdown[category];
          bucket.shadowCalls += 1;
          bucket.shadowTriangles += drawnTriangles(object, geometry, group);
        };
      });
    };
    const qaMotionSamples: { at: number; weight: number; phase: number; speed: number; heading: number; targetHeading: number }[] = [];
    const qaPathSamples: {
      at: number;
      signature: string;
      recomputes: number;
      cacheHits: number;
      activeWaypoint: Point | null;
      villain: Point;
    }[] = [];
    let qaLastPathSample = 0;
    let qaInput: HTMLInputElement | undefined;
    let qaButton: HTMLButtonElement | undefined;
    const getQaState = () => {
      const snapshotNow = performance.now();
      const lastKnown = aiMemory.current.lastKnown;
      const badge = actors.current.villain?.userData.badge as THREE.Sprite | undefined;
      const motion = Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => {
        const state = actor?.userData.motion as ActorMotionRuntime | undefined;
        return [name, state ? { ...state } : null];
      }));
      const markers = Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => {
        const actorBadge = actor?.userData.badge as THREE.Sprite | undefined;
        const actorRing = actor?.userData.ring as THREE.Mesh | undefined;
        const badgeMaterial = actorBadge?.material as THREE.SpriteMaterial | undefined;
        const ringMaterial = actorRing?.material as THREE.MeshBasicMaterial | undefined;
        return [name, {
          targetOpacity: actor?.userData.markerTargetOpacity ?? null,
          opacity: actor?.userData.markerOpacity ?? null,
          badgeOpacity: badgeMaterial?.opacity ?? null,
          ringOpacity: ringMaterial?.opacity ?? null,
        }];
      }));
      const villainMargin = P1_TUNING.villainCollisionMargin;
      return {
        phase: phaseRef.current,
        player: { ...player.current },
        villain: { ...villain.current },
        distance: distance(player.current, villain.current),
        lineOfSight: hasLineOfSight(villain.current, player.current),
        aiState: aiMemory.current.state,
        lastKnown: lastKnown ? { ...lastKnown } : null,
        ai: {
          state: aiMemory.current.state,
          lastKnown: lastKnown ? { ...lastKnown } : null,
          seesPlayer: villainSeesPlayer.current,
          target: villainTarget.current ? { ...villainTarget.current } : null,
          heading: villainHeading.current,
          turnError: villainTurn.current.error,
          speedMultiplier: villainTurn.current.speedMultiplier,
          searchElapsedMs: aiMemory.current.searchArrivedAt === null
            ? null
            : snapshotNow - aiMemory.current.searchArrivedAt,
        },
        ready: readyRef.current,
        startedElapsedMs: started.current === 0 ? 0 : snapshotNow - started.current,
        delayRemainingMs: Math.max(0, P0_TUNING.startDelayMs - (snapshotNow - started.current)),
        villainLabel: badge?.userData.labelText ?? null,
        input: {
          screenUp: { ...SCREEN_UP },
          screenRight: { ...SCREEN_RIGHT },
          intent: { ...lastInputIntent.current },
          playerDelta: { ...lastPlayerDelta.current },
          activeKeys: [...keys.current].sort(),
          clearCount: inputSafety.current.clearCount,
          lastClearReason: inputSafety.current.lastClearReason,
        },
        collision: {
          margin: P0_TUNING.playerCollisionMargin,
          villainMargin,
          villainOccupancy: canPlayerOccupy(villain.current.x, villain.current.y, villainMargin),
          villainCornerSamples: [
            { x: villain.current.x - villainMargin, y: villain.current.y - villainMargin },
            { x: villain.current.x + villainMargin, y: villain.current.y - villainMargin },
            { x: villain.current.x - villainMargin, y: villain.current.y + villainMargin },
            { x: villain.current.x + villainMargin, y: villain.current.y + villainMargin },
          ],
        },
        capture: {
          startedAt: caughtAt.current,
          elapsedMs: caughtAt.current === null ? null : snapshotNow - caughtAt.current,
          freezeMs: P0_TUNING.captureFreezeMs,
        },
        tuning: { ...P0_TUNING },
        polishTuning: { ...P1_TUNING },
        hardeningTuning: { ...P2_TUNING },
        threat: {
          ...threatRuntime,
          aiState: aiMemory.current.state,
        },
        pathfinding: {
          ...villainPathCache.current,
          route: villainPathCache.current.route.map((point) => ({ ...point })),
          activeWaypoint: villainPathCache.current.activeWaypoint
            ? { ...villainPathCache.current.activeWaypoint }
            : null,
          samples: qaPathSamples.slice(-80),
          hudDistanceMeters: objectiveDistanceRuntime.current,
        },
        audio: audioRuntime.getSnapshot(),
        assets: {
          detailsLoaded,
          detailTotal,
          detailsComplete: detailsLoaded === detailTotal,
        },
        actors: Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => [name, actor?.position.toArray()])),
        motion,
        motionSamples: qaMotionSamples.slice(-60),
        markers,
        environment: {
          enabled: scene.environment === environmentTarget.texture,
          mapping: environmentTarget.texture.mapping,
          envMapIntensity: P1_TUNING.environmentIntensity,
        },
        lighting: {
          exposure: renderer.toneMappingExposure,
          hemisphereIntensity: hemisphere.intensity,
          sunIntensity: sun.intensity,
          rimIntensity: rim.intensity,
          sunShadowBias: sun.shadow.bias,
          sunShadowNormalBias: sun.shadow.normalBias,
          sunShadowMapSize: sun.shadow.mapSize.toArray(),
          shadowCasterNames: [...P1_SHADOW_CASTERS],
          shadowCasterInstances: { ...shadowCasterCounts },
          shadowCasterMeshes: { ...shadowCasterMeshCounts },
          shadowCasterStrategy: "two-largest-bounds-per-prop",
        },
        layout: {
          floorRotationSamples: floorRotationEvidence.samples,
          quarterTurnHistogram: [...floorRotationEvidence.histogram],
          floorRotationChecksum: floorRotationEvidence.checksum,
          wallRandomized: floorRotationEvidence.wallRandomized,
        },
        police: {
          ...policeRuntime,
          heading: actors.current.police?.rotation.y ?? null,
          visualYOffset: (actors.current.police?.userData.motion as ActorMotionRuntime | undefined)?.visualY ?? null,
        },
        render: { calls: qaRenderSnapshot.calls,
          triangles: qaRenderSnapshot.triangles,
          frame: qaRenderSnapshot.frame,
          capturedAt: qaRenderSnapshot.capturedAt,
          memory: { ...qaRenderSnapshot.memory },
          breakdown: structuredClone(qaRenderBreakdown),
          reconciliation: { ...qaRenderReconciliation },
          optimization: {
            propMerge: { ...propMergeRuntime },
            actorShadowStrategy: "three-largest-triangle-meshes-per-actor",
            actorShadowBudgets: Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => [name, actor?.userData.shadowBudget ?? null])),
          },
        },
        disposal: {
          released: gpuReleased,
          current: lastDisposal,
          previous: readPreviousDisposal(),
          activeMemory: gpuMemory(),
        },
        camera: {
          position: camera.position.toArray(),
          direction: cameraDirection.toArray(),
          fov: camera.fov,
          zoom: cameraZoom.current,
          threat: cameraRuntime.threat,
          targetDistance: cameraRuntime.targetDistance,
        },
      };
    };
    const setQaPositions = (next: { player?: Point; villain?: Point }) => {
      if (next.player && Number.isFinite(next.player.x) && Number.isFinite(next.player.y) && canWalk(next.player.x, next.player.y)) {
        player.current = { ...next.player };
      }
      if (next.villain && Number.isFinite(next.villain.x) && Number.isFinite(next.villain.y) && canWalk(next.villain.x, next.villain.y)) {
        villain.current = { ...next.villain };
      }
    };
    if (new URLSearchParams(window.location.search).has("qa")) {
      qaApi = {
        getState: getQaState,
        setPositions: setQaPositions,
        dispose: () => {
          disposed = true;
          readyRef.current = false;
          cancelAnimationFrame(frame);
          void audioRuntime.dispose();
          return releaseGpuResources("qa-command");
        },
      };
      qaWindow.__CHASING_QA__ = qaApi;
      host.dataset.qaEnabled = "true";
      qaInput = document.createElement("input");
      qaInput.className = "qa-position-input";
      qaInput.setAttribute("aria-label", "QA 坐标命令");
      qaInput.autocomplete = "off";
      qaButton = document.createElement("button");
      qaButton.className = "qa-position-apply";
      qaButton.type = "button";
      qaButton.setAttribute("aria-label", "执行 QA 坐标");
      qaButton.textContent = "QA";
      qaButton.addEventListener("click", () => {
        try {
          const command = JSON.parse(qaInput?.value ?? "{}") as { player?: Point; villain?: Point; dispose?: boolean };
          if (command.dispose) qaApi?.dispose();
          else qaApi?.setPositions(command);
          host.dataset.qaPlacementState = JSON.stringify(qaApi?.getState());
        } catch {
          // Invalid test input is ignored just like an invalid setPositions payload.
        }
      });
      host.append(qaInput, qaButton);
    }

    scene.add(hemisphere);
    sun.position.set(-16, 26, -12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.bias = P1_TUNING.sunShadowBias;
    sun.shadow.normalBias = P1_TUNING.sunShadowNormalBias;
    scene.add(sun);
    rim.position.set(18, 16, 22);
    scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x496b4f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    trackRenderCategory(ground, "maze");
    scene.add(ground);
    const mazeRoot = new THREE.Group();
    scene.add(mazeRoot);

    const loader = new GLTFLoader();
    const load = async (url: string) => {
      const root = (await loader.loadAsync(url)).scene;
      loadedAssetRoots.add(root);
      if (disposed) disposeObjectResources([root]);
      return root;
    };
    const totalBlocking = BLOCKING_ACTOR_SPECS.length + Object.keys(CORE_ASSETS).length;
    let loadedBlocking = 0;
    const markBlockingLoaded = (kind: string) => {
      loadedBlocking += 1;
      if (!disposed) setLoadProgress({ done: loadedBlocking, total: totalBlocking, message: `正在载入项目美术资产：${kind} ${loadedBlocking}/${totalBlocking}` });
    };

    const placeActor = (name: ActorName, model: THREE.Object3D) => {
      const spec = ACTOR_SPECS.find((candidate) => candidate.name === name)!;
      const hideNodes = name === "police" ? ["shoulderepaulet", "epauletbutton", "sleevepatch", "sleevepatchinset"] : [];
      const actor = fitActor(model, spec.height, hideNodes);
      decorateActor(actor, spec.height, spec.color, spec.label);
      trackRenderCategory(actor, "actors");
      actors.current[name] = actor;
      if (name === "kid") actor.position.copy(world(player.current));
      if (name === "villain") actor.position.copy(world(villain.current));
      if (name === "police") {
        actor.position.copy(world(POLICE_POINT));
        actor.rotation.y = Math.PI;
      }
      scene.add(actor);
    };

    const buildCore = (assets: Record<keyof typeof CORE_ASSETS, THREE.Object3D>) => {
      const floorSalt: Record<"floor" | "grassFloor" | "classroomFloor" | "playgroundFloor", number> = {
        floor: 0,
        grassFloor: 11,
        classroomFloor: 23,
        playgroundFloor: 37,
      };
      const batches: Record<"wall" | "wallCorner" | "wallEnd" | "floor" | "grassFloor" | "classroomFloor" | "playgroundFloor", ModulePlacement[]> = {
        wall: [], wallCorner: [], wallEnd: [], floor: [], grassFloor: [], classroomFloor: [], playgroundFloor: [],
      };
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const position = world({ x, y });
          if (MAZE[y][x]) {
            const floorName = x <= 4 && y >= 10 && y <= 14
              ? "grassFloor"
              : x >= 8 && x <= 10 && y >= 17
                ? "classroomFloor"
                : x >= 16 && x <= 20 && y <= 4
                  ? "playgroundFloor"
                  : "floor";
            const quarterTurn = gridQuarterTurn(x, y, floorSalt[floorName]);
            batches[floorName].push({ position, rotation: quarterTurn * Math.PI / 2 });
            floorRotationEvidence.histogram[quarterTurn] += 1;
            floorRotationEvidence.checksum = Math.imul(
              floorRotationEvidence.checksum ^ (x + 1) ^ Math.imul(y + 1, 31) ^ Math.imul(quarterTurn + 1, 131),
              16777619,
            ) >>> 0;
            if (floorRotationEvidence.samples.length < 24) {
              floorRotationEvidence.samples.push({ x, y, floor: floorName, quarterTurn });
            }
          } else {
            const up = Boolean(MAZE[y - 1]?.[x]);
            const down = Boolean(MAZE[y + 1]?.[x]);
            const left = Boolean(MAZE[y]?.[x - 1]);
            const right = Boolean(MAZE[y]?.[x + 1]);
            const openings = [up, down, left, right].filter(Boolean).length;
            let wallName: "wall" | "wallCorner" | "wallEnd" = "wall";
            let wallRotation = 0;
            if (openings === 1) {
              wallName = "wallEnd";
              wallRotation = down ? 0 : right ? Math.PI / 2 : up ? Math.PI : -Math.PI / 2;
            } else if (openings === 2 && !((up && down) || (left && right))) {
              wallName = "wallCorner";
              wallRotation = down && right ? 0 : right && up ? Math.PI / 2 : up && left ? Math.PI : -Math.PI / 2;
            } else if (left && right) {
              wallRotation = Math.PI / 2;
            }
            batches[wallName].push({ position, rotation: wallRotation });
          }
        }
      }
      addInstancedModules(assets.wall, new THREE.Vector3(CELL, 1.12, CELL), batches.wall, mazeRoot, true);
      addInstancedModules(assets.wallCorner, new THREE.Vector3(CELL, 1.12, CELL), batches.wallCorner, mazeRoot, true);
      addInstancedModules(assets.wallEnd, new THREE.Vector3(CELL, 1.12, CELL), batches.wallEnd, mazeRoot, true);
      addInstancedModules(assets.floor, new THREE.Vector3(CELL, 0.12, CELL), batches.floor, mazeRoot, false);
      addInstancedModules(assets.grassFloor, new THREE.Vector3(CELL, 0.12, CELL), batches.grassFloor, mazeRoot, false);
      addInstancedModules(assets.classroomFloor, new THREE.Vector3(CELL, 0.12, CELL), batches.classroomFloor, mazeRoot, false);
      addInstancedModules(assets.playgroundFloor, new THREE.Vector3(CELL, 0.12, CELL), batches.playgroundFloor, mazeRoot, false);
      const exitDoor = flattenStatic(fitModule(assets.exit, new THREE.Vector3(1.8, 2.5, 0.55)), false);
      exitDoor.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
      exitDoor.position.add(world(EXIT)).add(new THREE.Vector3(0, 0, CELL * 0.45));
      mazeRoot.add(exitDoor);
      trackRenderCategory(exitDoor, "maze");
      const gate = flattenStatic(fitModule(assets.frontGate, new THREE.Vector3(1.8, 2.4, 0.55)), false);
      gate.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
      gate.position.add(world(START)).add(new THREE.Vector3(0, 0, -CELL * 0.45));
      mazeRoot.add(gate);
      trackRenderCategory(gate, "maze");
      trackRenderCategory(mazeRoot, "maze");

      beacon = new THREE.Group();
      beacon.position.copy(world(EXIT));
      const beaconPad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.65, 0.65, 0.1, 40),
        new THREE.MeshStandardMaterial({ color: 0x41f28d, emissive: 0x18aa5c, emissiveIntensity: 3 }),
      );
      beaconPad.position.y = 0.08;
      beacon.add(beaconPad);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.7, 4.5, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x66ffad, transparent: true, opacity: 0.17, depthWrite: false, side: THREE.DoubleSide }),
      );
      beam.position.y = 2.25;
      beacon.add(beam);
      const exitLabel = makeLabel("出口", "#63ffad");
      exitLabel.position.y = 3.25;
      beacon.add(exitLabel);
      const exitLight = new THREE.PointLight(0x53f59e, 3.2, 9, 2);
      exitLight.position.y = 1.7;
      beacon.add(exitLight);
      trackRenderCategory(beacon, "fx");
      scene.add(beacon);
    };

    const addProp = (
      model: THREE.Object3D,
      point: Point,
      height: number,
      rotation = 0,
      offset = new THREE.Vector3(),
      castShadow = false,
      shadowName?: keyof typeof DETAIL_ASSETS,
    ) => {
      const cacheKey = `${model.uuid}:${height}:${castShadow ? "shadow" : "no-shadow"}`;
      const template = propTemplates.get(cacheKey) ?? fitProp(model, height, castShadow);
      propTemplates.set(cacheKey, template);
      const object = template.clone(true);
      object.position.add(world(point)).add(offset);
      object.rotation.y = rotation;
      if (shadowName) {
        let meshCount = 0;
        object.traverse((candidate) => {
          if (candidate instanceof THREE.Mesh && candidate.castShadow) meshCount += 1;
        });
        shadowCasterMeshCounts[shadowName] = (shadowCasterMeshCounts[shadowName] ?? 0) + meshCount;
      }
      trackRenderCategory(object, "props");
      propsRoot.add(object);
    };

    const placeDetail = (name: keyof typeof DETAIL_ASSETS, model: THREE.Object3D) => {
      const castShadow = largeShadowProps.has(name);
      const addDetailProp = (point: Point, height: number, rotation = 0, offset = new THREE.Vector3()) => {
        addProp(model, point, height, rotation, offset, castShadow, castShadow ? name : undefined);
        if (castShadow) shadowCasterCounts[name] = (shadowCasterCounts[name] ?? 0) + 1;
      };
      switch (name) {
        case "locker":
          addDetailProp({ x: 7, y: 5 }, 1.8, Math.PI / 2);
          addDetailProp({ x: 13, y: 19 }, 1.8, -Math.PI / 2);
          break;
        case "bench": addDetailProp({ x: 18, y: 16 }, 1.05, Math.PI / 2); break;
        case "tree": addDetailProp({ x: 3, y: 14 }, 3.5); break;
        case "shrub": addDetailProp({ x: 3, y: 12 }, 0.9); break;
        case "car": addDetailProp({ x: 22, y: 23 }, 1.6, Math.PI / 2, new THREE.Vector3(CELL * 0.75, 0, CELL * 0.75)); break;
        case "station": addDetailProp({ x: 23, y: 23 }, 3.2, Math.PI, new THREE.Vector3(0, 0, CELL * 1.6)); break;
        case "basketball": addDetailProp({ x: 20, y: 3 }, 2.6, -Math.PI / 2); break;
        case "classroomDoor": addDetailProp({ x: 9, y: 17 }, 2.2, Math.PI / 2, new THREE.Vector3(-CELL * 0.44, 0, 0)); break;
        case "deskChair": addDetailProp({ x: 9, y: 18 }, 1.2); break;
        case "blackboard": addDetailProp({ x: 9, y: 20 }, 1.5, Math.PI); break;
        case "podium": addDetailProp({ x: 9, y: 19 }, 1.1, Math.PI); break;
        case "bulletin": addDetailProp({ x: 11, y: 11 }, 1.25, -Math.PI / 2); break;
        case "extinguisher": addDetailProp({ x: 11, y: 10 }, 0.8, -Math.PI / 2); break;
        case "trash": addDetailProp({ x: 11, y: 12 }, 0.75, -Math.PI / 2); break;
        case "books": addDetailProp({ x: 11, y: 13 }, 0.18); break;
        case "backpack": addDetailProp({ x: 13, y: 16 }, 0.5); break;
        case "ceilingLight":
          for (const point of [{ x: 7, y: 4 }, { x: 15, y: 5 }, { x: 21, y: 12 }, { x: 17, y: 17 }]) {
            addDetailProp(point, 0.16, 0, new THREE.Vector3(0, 2.25, 0));
            const lamp = new THREE.PointLight(0xffe5b0, 1.2, 8, 2);
            lamp.position.copy(world(point)).add(new THREE.Vector3(0, 2.1, 0));
            mazeRoot.add(lamp);
          }
          break;
      }
    };

    const setup = async () => {
      try {
        const actorTask = Promise.all(BLOCKING_ACTOR_SPECS.map(async (spec) => {
          const model = await load(spec.url);
          if (!disposed) placeActor(spec.name, model);
          markBlockingLoaded(spec.label);
        }));
        const core = {} as Partial<Record<keyof typeof CORE_ASSETS, THREE.Object3D>>;
        const coreTask = Promise.all((Object.entries(CORE_ASSETS) as [keyof typeof CORE_ASSETS, string][]).map(async ([name, url]) => {
          core[name] = await load(url);
          markBlockingLoaded("校园结构");
        }));
        await Promise.all([actorTask, coreTask]);
        if (disposed) return;
        buildCore(core as Record<keyof typeof CORE_ASSETS, THREE.Object3D>);
        readyRef.current = true;
        setLoading(false);
        if (new URLSearchParams(window.location.search).get("autostart") === "1") reset();

        const policeTask = (async () => {
          try {
            const police = ACTOR_SPECS.find((spec) => spec.name === "police")!;
            const model = await load(police.url);
            if (!disposed) placeActor("police", model);
          } catch (error) {
            console.warn("Exit police asset failed", error);
          } finally {
            detailsLoaded += 1;
            if (!disposed) setDetailProgress(detailsLoaded);
          }
        })();
        const detailTasks = (Object.entries(DETAIL_ASSETS) as [keyof typeof DETAIL_ASSETS, string][]).map(async ([name, url]) => {
          try {
            const model = await load(url);
            if (!disposed) placeDetail(name, model);
          } catch (error) {
            console.warn(`Optional environment asset failed: ${name}`, error);
          } finally {
            detailsLoaded += 1;
            if (!disposed) setDetailProgress(detailsLoaded);
          }
        });
        await Promise.all([policeTask, ...detailTasks]);
        if (!disposed) {
          const mergedProps = mergePlacedProps(propsRoot);
          propsRoot.clear();
          propsRoot.add(mergedProps.root);
          propTemplates.clear();
          Object.assign(propMergeRuntime, {
            beforeMeshes: mergedProps.beforeMeshes,
            afterMeshes: mergedProps.afterMeshes,
            materialBuckets: mergedProps.materialBuckets,
            complete: true,
          });
          trackRenderCategory(mergedProps.root, "props");
        }
      } catch (error) {
        console.error("Failed to load required 3D assets", error);
        if (!disposed) setLoadError("角色或校园模型载入失败，请刷新后重试。控制台已记录具体素材。");
      }
    };
    void setup();

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.4));
      renderer.setSize(bounds.width, bounds.height, false);
      camera.aspect = bounds.width / Math.max(bounds.height, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(host);
    const adjustZoom = (event: WheelEvent) => {
      event.preventDefault();
      cameraZoom.current = THREE.MathUtils.clamp(cameraZoom.current * Math.exp(event.deltaY * 0.0007), 0.78, 1.55);
    };
    host.addEventListener("wheel", adjustZoom, { passive: false });

    const syncActor = (
      actor: THREE.Object3D | undefined,
      point: Point,
      phaseOffset: number,
      delta: number,
      options: {
        authoredHeading?: number;
        dampHeading?: boolean;
        headingDamping?: number;
        freezePose?: boolean;
      } = {},
    ) => {
      if (!actor) return;
      const target = world(point);
      const dx = target.x - actor.position.x;
      const dz = target.z - actor.position.z;
      const moving = dx * dx + dz * dz > 0.00001;
      actor.position.x = target.x;
      actor.position.z = target.z;
      actor.position.y = 0;
      const visual = actor.userData.visual as THREE.Group | undefined;
      const baseVisualY = visual?.userData.baseY as number | undefined;
      const motion = (actor.userData.motion as ActorMotionRuntime | undefined) ?? {
        gaitWeight: 0,
        gaitPhase: 0,
        actualSpeed: 0,
        heading: actor.rotation.y,
        targetHeading: actor.rotation.y,
        visualY: 0,
        baseVisualY: baseVisualY ?? 0,
      };
      actor.userData.motion = motion;
      const desiredHeading = options.authoredHeading ?? (moving ? Math.atan2(dx, dz) : motion.targetHeading);
      motion.targetHeading = desiredHeading;
      const finishingDampedTurn = options.dampHeading && Math.abs(shortestAngle(motion.heading, desiredHeading)) > 0.001;
      if (options.authoredHeading !== undefined || moving || finishingDampedTurn) {
        motion.heading = options.dampHeading
          ? dampAngle(motion.heading, desiredHeading, options.headingDamping ?? P1_TUNING.playerTurnDamping, delta)
          : desiredHeading;
        actor.rotation.y = motion.heading;
      }
      if (options.freezePose) return;
      const motionTime = performance.now();
      const actualGridSpeed = moving ? Math.hypot(dx, dz) / (CELL * Math.max(delta, 0.001)) : 0;
      motion.actualSpeed = actualGridSpeed;
      motion.gaitWeight = advanceGaitWeight(motion.gaitWeight, moving, delta);
      motion.gaitPhase = advanceGaitPhase(
        motion.gaitPhase,
        Math.min(actualGridSpeed, P0_TUNING.playerSpeed * 1.25),
        delta,
      );
      const gaitWave = Math.sin(motion.gaitPhase + phaseOffset);
      if (visual) {
        const baseY = visual.userData.baseY as number;
        const idleBreath = Math.sin(motionTime * 0.003 + phaseOffset) * 0.018 * (1 - motion.gaitWeight);
        visual.position.y = baseY + Math.abs(gaitWave) * 0.07 * motion.gaitWeight + idleBreath;
        visual.rotation.z = gaitWave * 0.035 * motion.gaitWeight;
        visual.rotation.x = -0.035 * motion.gaitWeight;
        motion.baseVisualY = baseY;
        motion.visualY = visual.position.y - baseY;
      }
      poseRig(actor, gaitWave, motion.gaitWeight);
    };

    const animate = (now: number) => {
      const delta = Math.min((now - last) / 1000, 0.04);
      last = now;
      if (phaseRef.current === "playing") {
        let dx = 0;
        let dy = 0;
        if (keys.current.has("a") || keys.current.has("arrowleft")) dx -= 1;
        if (keys.current.has("d") || keys.current.has("arrowright")) dx += 1;
        if (keys.current.has("w") || keys.current.has("arrowup")) dy -= 1;
        if (keys.current.has("s") || keys.current.has("arrowdown")) dy += 1;
        const move = screenAlignedMove(dx, dy);
        lastInputIntent.current = { ...move };
        const current = player.current;
        const previous = { ...current };
        const nextX = current.x + move.x * P0_TUNING.playerSpeed * delta;
        const nextY = current.y + move.y * P0_TUNING.playerSpeed * delta;
        if (canPlayerOccupy(nextX, current.y)) current.x = nextX;
        if (canPlayerOccupy(current.x, nextY)) current.y = nextY;
        lastPlayerDelta.current = { x: current.x - previous.x, y: current.y - previous.y };

        const decision = planVillainAi(aiMemory.current, villain.current, current, now, started.current);
        aiMemory.current = decision.memory;
        villainSeesPlayer.current = decision.seesPlayer;
        let target = decision.target;
        if (aiMemory.current.state === "patrol") target = PATROL[patrol.current];
        villainTarget.current = target ? { ...target } : null;
        if (target) {
          const signature = pathCacheSignature(aiMemory.current.state, villain.current, target);
          const invalidationReason = pathCacheInvalidationReason(villainPathCache.current.signature, signature);
          if (invalidationReason) {
            const route = findGridPath(villain.current, target);
            const startsAtCenter = route[0]
              ? distance(villain.current, route[0]) <= P2_TUNING.pathWaypointTolerance
              : false;
            villainPathCache.current.signature = signature;
            villainPathCache.current.route = route;
            villainPathCache.current.cursor = startsAtCenter ? 1 : 0;
            villainPathCache.current.recomputes += 1;
            villainPathCache.current.lastInvalidationReason = invalidationReason;
          } else {
            villainPathCache.current.cacheHits += 1;
          }
          const cachedWaypoint = villainPathCache.current.route[villainPathCache.current.cursor];
          if (cachedWaypoint && distance(villain.current, cachedWaypoint) <= P2_TUNING.pathWaypointTolerance) {
            villainPathCache.current.cursor += 1;
          }
          villainPathCache.current.activeWaypoint = villainPathCache.current.route[villainPathCache.current.cursor]
            ?? target;
          const step = stepVillainToward(
            villain.current,
            target,
            villainHeading.current,
            P0_TUNING.villainSpeed,
            delta,
            villainPathCache.current.route.length
              ? [roundedCell(villain.current), villainPathCache.current.activeWaypoint]
              : [],
          );
          villain.current = step.point;
          villainHeading.current = step.heading;
          villainTurn.current = { error: step.turnError, speedMultiplier: step.speedMultiplier };
          if (aiMemory.current.state === "patrol" && distance(villain.current, target) < 0.25) {
            patrol.current = (patrol.current + 1) % PATROL.length;
          }
          if (qaApi && (invalidationReason || now - qaLastPathSample >= 100)) {
            qaLastPathSample = now;
            qaPathSamples.push({
              at: now,
              signature: villainPathCache.current.signature,
              recomputes: villainPathCache.current.recomputes,
              cacheHits: villainPathCache.current.cacheHits,
              activeWaypoint: villainPathCache.current.activeWaypoint
                ? { ...villainPathCache.current.activeWaypoint }
                : null,
              villain: { ...villain.current },
            });
            if (qaPathSamples.length > 80) qaPathSamples.shift();
          }
        } else {
          villainTurn.current = { error: 0, speedMultiplier: 1 };
          villainPathCache.current.activeWaypoint = null;
        }

        if (distance(current, villain.current) < 0.58) {
          caughtAt.current = now;
          changePhase("caught");
        } else if (distance(current, EXIT) < 0.62) {
          const seconds = Math.max(0, Math.floor((now - started.current) / 1000));
          setElapsed(seconds);
          changePhase("won");
        }
        if (now - lastHudUpdate > 180) {
          const seconds = Math.max(0, Math.floor((now - started.current) / 1000));
          setElapsed((value) => value === seconds ? value : seconds);
          objectiveDistanceRuntime.current = gridPathDistanceMeters(current, EXIT) ?? 0;
          setObjectiveDistance(objectiveDistanceRuntime.current);
          lastHudUpdate = now;
        }
      } else if (
        phaseRef.current === "caught"
        && caughtAt.current !== null
        && now - caughtAt.current >= P0_TUNING.captureFreezeMs
      ) {
        changePhase("lost");
      }

      const delayRemaining = P0_TUNING.startDelayMs - (now - started.current);
      if (phaseRef.current === "playing" && delayRemaining > 0) {
        const tenths = Math.max(1, Math.ceil(delayRemaining / 100));
        setActorLabel(actors.current.villain, `${(tenths / 10).toFixed(1)}s`, "#f6c965");
      } else {
        setActorLabel(actors.current.villain, "追捕者", "#ff4f5e");
      }
      const freezeCapturedPose = phaseRef.current === "caught";
      syncActor(actors.current.kid, player.current, 0, delta, {
        dampHeading: true,
        headingDamping: P1_TUNING.playerTurnDamping,
        freezePose: freezeCapturedPose,
      });
      syncActor(actors.current.villain, villain.current, 2, delta, {
        authoredHeading: villainHeading.current,
        freezePose: freezeCapturedPose,
      });
      policeRuntime.distanceToExit = distance(player.current, EXIT);
      policeRuntime.trackingPlayer = shouldPoliceTrack(player.current);
      if (policeRuntime.trackingPlayer) {
        policeRuntime.targetHeading = Math.atan2(
          player.current.x - POLICE_POINT.x,
          player.current.y - POLICE_POINT.y,
        );
      }
      syncActor(actors.current.police, POLICE_POINT, 4, delta, {
        authoredHeading: policeRuntime.trackingPlayer ? policeRuntime.targetHeading : undefined,
        dampHeading: true,
        headingDamping: P1_TUNING.policeTurnDamping,
        freezePose: freezeCapturedPose,
      });
      const kidMotion = actors.current.kid?.userData.motion as ActorMotionRuntime | undefined;
      if (qaApi && kidMotion) {
        qaMotionSamples.push({
          at: now,
          weight: kidMotion.gaitWeight,
          phase: kidMotion.gaitPhase,
          speed: kidMotion.actualSpeed,
          heading: kidMotion.heading,
          targetHeading: kidMotion.targetHeading,
        });
        if (qaMotionSamples.length > 60) qaMotionSamples.shift();
      }
      const enemyDistance = distance(player.current, villain.current);
      const proximity = proximityThreat(enemyDistance);
      const stateFactor = threatStateFactor(aiMemory.current.state);
      const currentThreat = finalThreat(enemyDistance, aiMemory.current.state, phaseRef.current);
      const currentVignette = vignetteStrength(currentThreat);
      threatRuntime.distance = enemyDistance;
      threatRuntime.proximity = proximity;
      threatRuntime.stateFactor = stateFactor;
      threatRuntime.final = currentThreat;
      threatRuntime.vignette = currentVignette;
      cameraRuntime.threat = currentThreat;
      audioRuntime.onPhase(phaseRef.current);
      audioRuntime.update(currentThreat, kidMotion);
      if (now - lastVignetteUpdate >= P2_TUNING.vignetteUiIntervalMs) {
        threatRuntime.cssValue = currentVignette.toFixed(3);
        host.style.setProperty("--danger-level", threatRuntime.cssValue);
        lastVignetteUpdate = now;
      }
      if (phaseRef.current !== "caught") {
        const playerAnchor = world(player.current).add(new THREE.Vector3(0, 1.02, 0));
        const villainAnchor = world(villain.current).add(new THREE.Vector3(0, 1.02, 0));
        const threat = currentThreat;
        const targetFocus = playerAnchor.clone().lerp(villainAnchor, threat * 0.42);
        const focusAlpha = 1 - Math.exp(-7 * delta);
        cameraFocus.lerp(targetFocus, focusAlpha);

        const verticalTangent = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
        const horizontalTangent = verticalTangent * Math.max(camera.aspect, 0.4);
        const aspectDistance = 5 / Math.max(horizontalTangent, 0.01);
        const baseDistance = THREE.MathUtils.clamp(Math.max(15.6, aspectDistance), 15.6, 26);
        let fitDistance = baseDistance;
        for (const anchor of [playerAnchor, villainAnchor]) {
          const relative = anchor.clone().sub(targetFocus);
          const depthShift = relative.dot(cameraDirection);
          fitDistance = Math.max(
            fitDistance,
            depthShift + (Math.abs(relative.dot(cameraRight)) + 1.2) / Math.max(horizontalTangent, 0.01),
            depthShift + (Math.abs(relative.dot(cameraUp)) + 1.8) / Math.max(verticalTangent, 0.01),
          );
        }
        const automaticDistance = Math.max(baseDistance + threat * 2.8, THREE.MathUtils.lerp(baseDistance, fitDistance, threat));
        const targetDistance = THREE.MathUtils.clamp(automaticDistance * cameraZoom.current, 12.2, 34);
        cameraRuntime.targetDistance = targetDistance;
        cameraDistance = THREE.MathUtils.lerp(cameraDistance, targetDistance, 1 - Math.exp(-3.2 * delta));
        const desired = cameraFocus.clone().addScaledVector(cameraDirection, cameraDistance);
        camera.position.lerp(desired, 1 - Math.exp(-6 * delta));
        camera.lookAt(cameraFocus);
      }
      const markerElapsedMs = started.current === 0 ? 0 : now - started.current;
      for (const [name, actor] of Object.entries(actors.current)) {
        if (!actor) continue;
        const targetOpacity = markerTargetOpacity(
          phaseRef.current,
          markerElapsedMs,
          cameraRuntime.threat,
          name === "villain",
        );
        const currentOpacity = actor.userData.markerOpacity as number ?? 1;
        const opacity = currentOpacity + (targetOpacity - currentOpacity) * (1 - Math.exp(-P1_TUNING.markerFadeDamping * delta));
        actor.userData.markerTargetOpacity = targetOpacity;
        setActorMarkerOpacity(actor, opacity);
      }
      if (beacon) {
        beacon.rotation.y += delta * 0.45;
        const pulse = 1 + Math.sin(now * 0.004) * 0.08;
        beacon.scale.setScalar(pulse);
      }
      activeRenderBreakdown = makeRenderBreakdown();
      renderer.info.reset();
      renderer.render(scene, camera);
      qaRenderSnapshot.calls = renderer.info.render.calls;
      qaRenderSnapshot.triangles = renderer.info.render.triangles;
      qaRenderSnapshot.frame += 1;
      qaRenderSnapshot.capturedAt = now;
      qaRenderSnapshot.memory = gpuMemory();
      const classifiedCalls = Object.values(activeRenderBreakdown).reduce(
        (total, budget) => total + budget.mainCalls + budget.shadowCalls,
        0,
      );
      const classifiedTriangles = Object.values(activeRenderBreakdown).reduce(
        (total, budget) => total + budget.mainTriangles + budget.shadowTriangles,
        0,
      );
      const unclassifiedCalls = renderer.info.render.calls - classifiedCalls;
      const unclassifiedTriangles = renderer.info.render.triangles - classifiedTriangles;
      activeRenderBreakdown.other.mainCalls += unclassifiedCalls;
      activeRenderBreakdown.other.mainTriangles += unclassifiedTriangles;
      qaRenderBreakdown = structuredClone(activeRenderBreakdown);
      qaRenderReconciliation = {
        rawUnclassifiedCalls: unclassifiedCalls,
        rawUnclassifiedTriangles: unclassifiedTriangles,
        callsDelta: renderer.info.render.calls - Object.values(qaRenderBreakdown).reduce(
          (total, budget) => total + budget.mainCalls + budget.shadowCalls,
          0,
        ),
        trianglesDelta: renderer.info.render.triangles - Object.values(qaRenderBreakdown).reduce(
          (total, budget) => total + budget.mainTriangles + budget.shadowTriangles,
          0,
        ),
      };
      if (qaApi && now - qaLastSnapshotUpdate >= 50) {
        qaLastSnapshotUpdate = now;
        host.dataset.qaState = JSON.stringify(qaApi.getState());
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      readyRef.current = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      host.removeEventListener("wheel", adjustZoom);
      removeEventListener("pointerdown", unlockAudio);
      removeEventListener("keydown", unlockAudio);
      document.removeEventListener(audioVisibilityEvent, suspendAudioWhenHidden);
      void audioRuntime.dispose();
      releaseGpuResources("react-cleanup");
      host.style.removeProperty("--danger-level");
      if (qaWindow.__CHASING_QA__ === qaApi) delete qaWindow.__CHASING_QA__;
      if (qaApi) {
        delete host.dataset.qaEnabled;
        delete host.dataset.qaPlacementState;
        delete host.dataset.qaState;
        qaInput?.remove();
        qaButton?.remove();
      }
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [changePhase, reset]);

  const touch = (key: string, active: boolean) => {
    if (active) keys.current.add(key);
    else keys.current.delete(key);
  };
  const loadPercent = Math.round((loadProgress.done / loadProgress.total) * 100);

  return (
    <main className="game-shell">
      <header className="hud">
        <div>
          <span className="eyebrow">CHASING · WEBGL</span>
          <h1>逃出校园</h1>
        </div>
        <div className="stats">
          <span>用时 <b>{elapsed}s</b></span>
          <span className="objective">出口 <b>{objectiveDistance}m</b></span>
          <span className="status"><i />3D 追逐模式</span>
          <button type="button" disabled={loading} onClick={reset}>重新开始</button>
        </div>
      </header>
      <section className="playfield">
        <div className="three-mount" ref={mount} />
        {loading && (
          <div className={`loading-card${loadError ? " error" : ""}`} role="status">
            <span className="loader-dot" />
            <div>
              <strong>{loadError || loadProgress.message}</strong>
              {!loadError && <div className="load-bar"><i style={{ width: `${loadPercent}%` }} /></div>}
              {!loadError && <small>高精角色正在直接加入场景 · {loadPercent}%</small>}
              {loadError && <button type="button" onClick={() => window.location.reload()}>刷新重试</button>}
            </div>
          </div>
        )}
        {!loading && detailProgress < Object.keys(DETAIL_ASSETS).length + 1 && (
          <div className="detail-loading">校园细节与出口角色 {detailProgress}/{Object.keys(DETAIL_ASSETS).length + 1}</div>
        )}
        <div className={`capture-transition${phase === "caught" ? " active" : ""}`} aria-hidden="true" />
        {phase !== "playing" && phase !== "caught" && !loading && (
          <div className={`overlay ${phase}`}>
            <div className="overlay-card">
              <span className={`result ${phase}`}>{phase === "won" ? "成功逃脱" : phase === "lost" ? "被抓住了" : "3D 逃生演练"}</span>
              <h2>{phase === "won" ? `警察在出口等到了你 · 用时 ${elapsed}s` : phase === "lost" ? "别停，换条路线再试一次" : "躲开追捕者，跑到绿色出口"}</h2>
              <p>蓝色标记是你，红色是追捕者。镜头会在追逐时自动拉远，也可用滚轮调节视野。</p>
              <button className="primary" type="button" onClick={reset}>{phase === "ready" ? "开始逃跑" : "再来一次"}<kbd>Enter</kbd></button>
            </div>
          </div>
        )}
        <div className="controls" aria-label="移动控制">
          <button type="button" aria-label="向上" onPointerDown={() => touch("w", true)} onPointerUp={() => touch("w", false)} onPointerCancel={() => touch("w", false)}>↑</button>
          <button type="button" aria-label="向左" onPointerDown={() => touch("a", true)} onPointerUp={() => touch("a", false)} onPointerCancel={() => touch("a", false)}>←</button>
          <button type="button" aria-label="向下" onPointerDown={() => touch("s", true)} onPointerUp={() => touch("s", false)} onPointerCancel={() => touch("s", false)}>↓</button>
          <button type="button" aria-label="向右" onPointerDown={() => touch("d", true)} onPointerUp={() => touch("d", false)} onPointerCancel={() => touch("d", false)}>→</button>
        </div>
      </section>
      <footer>
        <span><i className="kid" />玩家</span>
        <span><i className="villain" />追捕者</span>
        <span><i className="police" />警察 / 出口</span>
        <small>WASD / 方向键移动 · 滚轮调视野 · 0 重置镜头 · R 重新开始</small>
      </footer>
    </main>
  );
}
