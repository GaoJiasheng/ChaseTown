"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  ActorAnimator,
  type AnimationState,
  type ClipAliases,
} from "./game/animation/actor-runtime.ts";
import { AdaptiveScoreController, prewarmAdaptiveScoreAssets } from "./game/audio/adaptive-score.ts";
import type { ChaserMode, GamePhase, GameState, PlayerMode, Point } from "./game/contracts.ts";
import { createDefaultLevel, DEFAULT_GAME_CONFIG } from "./game/level.ts";
import {
  FIXED_CAMERA_GROUND_DIRECTION,
  screenMoveToWorld,
  shouldIgnoreFocusedControlKey,
} from "./game/input.ts";
import { distanceBetween, GridPathPlanner, hasLineOfSight } from "./game/navigation.ts";
import { isPlayerVisuallyExposed } from "./game/perception.ts";
import {
  boundedFrameDeltaSeconds,
  canChaserTakeLockerDoor,
  lockerVisionMix,
  requiredCameraDistanceForFraming,
  shouldFrameChaser,
  shouldRenderChaserModel,
  smoothOcclusionStrength,
} from "./game/presentation.ts";
import { GameSimulation, type HideInteraction } from "./game/simulation.ts";

type ActorName = "kid" | "villain" | "police";
type CoreAssetName = keyof typeof CORE_ASSETS;
type DetailAssetName = keyof typeof DETAIL_ASSETS;

const CELL = 2;
const LEVEL = createDefaultLevel();
const FRONT_GATE_POINT: Point = { x: 1, y: 1 };
const OBJECTIVE_PATHS = new GridPathPlanner(LEVEL);
const HIDE_ENTER_SECONDS = DEFAULT_GAME_CONFIG.hideEnterSeconds;
const HIDE_EXIT_SECONDS = DEFAULT_GAME_CONFIG.hideExitSeconds;
const HIDE_CHECK_SECONDS = DEFAULT_GAME_CONFIG.checkHideSeconds;
const PLAYER_OBSERVATION_RANGE = 9;
const CAPTURE_STAGING_SECONDS = 0.26;
const MAX_CAMERA_DISTANCE = 44;

const ACTOR_SPECS = {
  kid: {
    url: "/models/characters/kid.glb?v=31",
    height: 1.52,
    aliases: {
      idle: "Idle",
      walk: "Walk",
      run: "Run",
      turnLeft: "TurnLeft",
      turnRight: "TurnRight",
      enterHide: "HideEnter",
      hideIdle: "HideIdle",
      peekLeft: "HidePeek",
      exitHide: "HideExit",
      caught: "Caught",
      celebrate: "EscapeCelebrate",
      point: "Interact",
    },
    required: ["idle", "walk", "run", "turnLeft", "turnRight", "enterHide", "hideIdle", "peekLeft", "exitHide", "caught", "celebrate"] as AnimationState[],
  },
  villain: {
    url: "/models/characters/villain.glb?v=31",
    height: 1.88,
    aliases: {
      idle: "Idle",
      walk: "PatrolWalk",
      run: "Run",
      alert: "Alert",
      loseSight: "LostSight",
      search: "Search",
      checkLocker: "CheckHide",
      catch: "Catch",
    },
    required: ["idle", "walk", "run", "alert", "loseSight", "search", "checkLocker", "catch"] as AnimationState[],
  },
  police: {
    url: "/models/characters/police.glb?v=31",
    height: 1.82,
    aliases: {
      idle: "Idle",
      run: "Run",
      point: "Interact",
      protect: "Resolve",
      alert: "Alert",
    },
    required: ["idle", "run", "point", "protect"] as AnimationState[],
  },
} as const;

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
  locker: "/models/environment/locker.glb?v=30",
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

const LOCKER_CLIPS = [
  "Locker_Door_Open_Enter",
  "Locker_Door_Close_Enter",
  "Locker_Door_Open_Exit",
  "Locker_Door_Close_Exit",
  "Locker_Door_Check_Open",
  "Locker_Door_Check_Close",
] as const;

const TOTAL_ASSETS = Object.keys(ACTOR_SPECS).length + Object.keys(CORE_ASSETS).length + Object.keys(DETAIL_ASSETS).length;

function world(point: Point) {
  return new THREE.Vector3(
    (point.x - (LEVEL.width - 1) / 2) * CELL,
    0,
    (point.y - (LEVEL.height - 1) / 2) * CELL,
  );
}

function createFixedCameraDirection() {
  // A restrained shoulder offset preserves depth without rotating the control
  // axes. This vector is immutable for the entire run; only focus and distance
  // are allowed to move.
  return new THREE.Vector3(
    FIXED_CAMERA_GROUND_DIRECTION.x,
    0.82,
    FIXED_CAMERA_GROUND_DIRECTION.y,
  ).normalize();
}

function objectiveDistanceMeters(point: Point) {
  const route = OBJECTIVE_PATHS.path(point, LEVEL.exit);
  if (!route.length) return 0;
  return Math.round(Math.max(0, route.length - 1) * CELL);
}

function tuneMeshes(root: THREE.Object3D, options: { culling?: boolean; castShadow?: boolean } = {}) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = options.castShadow ?? true;
    object.receiveShadow = true;
    object.frustumCulled = options.culling ?? true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.envMapIntensity = Math.max(material.envMapIntensity, 1.05);
      material.roughness = THREE.MathUtils.clamp(material.roughness, 0.22, 0.92);
    }
  });
}

function flattenStatic(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const flat = new THREE.Group();
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    if (Array.isArray(object.material) || Object.keys(object.geometry.morphAttributes).length > 0) {
      const mesh = new THREE.Mesh(object.geometry.clone().applyMatrix4(object.matrixWorld), object.material);
      mesh.receiveShadow = true;
      flat.add(mesh);
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
    const bucket: { material: THREE.Material; geometries: THREE.BufferGeometry[] } = buckets.get(signature) ?? {
      material: object.material,
      geometries: [],
    };
    bucket.geometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
    buckets.set(signature, bucket);
  });
  for (const { material, geometries } of buckets.values()) {
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    flat.add(mesh);
  }
  return flat;
}

function fitActor(source: THREE.Object3D, height: number) {
  const cloned = SkeletonUtils.clone(source);
  const clonedMaterials = new Map<string, THREE.Material>();
  cloned.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const cloneMaterial = (material: THREE.Material) => {
      const existing = clonedMaterials.get(material.uuid);
      if (existing) return existing;
      const result = material.clone();
      clonedMaterials.set(material.uuid, result);
      return result;
    };
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneMaterial)
      : cloneMaterial(object.material);
  });
  tuneMeshes(cloned, { culling: false, castShadow: true });
  const visual = new THREE.Group();
  visual.name = "character-visual";
  visual.add(cloned);
  const initial = new THREE.Box3().setFromObject(visual);
  const initialSize = initial.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(initialSize.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  const actor = new THREE.Group();
  actor.name = "production-character";
  actor.add(visual);
  return actor;
}

function fitProp(source: THREE.Object3D, height: number) {
  const model = source.clone(true);
  tuneMeshes(model, { castShadow: false });
  const visual = new THREE.Group();
  visual.add(model);
  const initial = new THREE.Box3().setFromObject(visual);
  const size = initial.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(size.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  return flattenStatic(visual);
}

function fitInteractiveProp(source: THREE.Object3D, height: number) {
  const model = source.clone(true);
  tuneMeshes(model, { castShadow: true });
  const visual = new THREE.Group();
  visual.add(model);
  const initial = new THREE.Box3().setFromObject(visual);
  const size = initial.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(size.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  const root = new THREE.Group();
  root.add(visual);
  return root;
}

function fitModule(source: THREE.Object3D, size: THREE.Vector3) {
  const root = source.clone(true);
  tuneMeshes(root, { castShadow: true });
  const bounds = new THREE.Box3().setFromObject(root);
  const current = bounds.getSize(new THREE.Vector3());
  root.scale.set(
    size.x / Math.max(current.x, 0.001),
    size.y / Math.max(current.y, 0.001),
    size.z / Math.max(current.z, 0.001),
  );
  const fitted = new THREE.Box3().setFromObject(root);
  root.position.sub(fitted.getCenter(new THREE.Vector3()));
  root.position.y += size.y / 2;
  return root;
}

type ModulePlacement = { position: THREE.Vector3; rotation: number };

function addInstancedModules(
  source: THREE.Object3D,
  size: THREE.Vector3,
  placements: readonly ModulePlacement[],
  parent: THREE.Object3D,
  castShadow: boolean,
) {
  const created: THREE.InstancedMesh[] = [];
  if (!placements.length) return created;
  const template = fitModule(source, size);
  template.updateMatrixWorld(true);
  const placementMatrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    const instances = new THREE.InstancedMesh(object.geometry, object.material, placements.length);
    instances.name = `campus-${object.name || "module"}`;
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
    created.push(instances);
  });
  return created;
}

type ActorView = {
  root: THREE.Group;
  animator: ActorAnimator;
  durationByState: Partial<Record<AnimationState, number>>;
  lastPoint: Point;
  lastTick: number;
  sampledSpeed: number;
  lastRequested: AnimationState | null;
  lastTurnCycle: number;
  visibilityAlpha: number;
  visibilityMaterials: Array<{
    material: THREE.Material;
    baseOpacity: number;
    baseTransparent: boolean;
    baseDepthWrite: boolean;
  }>;
};

type LockerView = {
  id: string;
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  clips: ReadonlyMap<string, THREE.AnimationClip>;
  queue: string[];
  action: THREE.AnimationAction | null;
  actionName: string | null;
  peeking: boolean;
  peekClosing: boolean;
  holdFinal: boolean;
  delayRemaining: number;
  owner: "idle" | "player" | "chaser";
};

type CameraOccluder = {
  name: string;
  meshes: THREE.Mesh[];
  overlays: THREE.Mesh[];
  strength: { value: number };
  obscured: boolean;
};

type GameCommands = {
  begin: () => void;
  restart: () => void;
  interact: () => void;
  toggleMute: () => void;
  adjustZoom: (factor: number) => void;
  resetZoom: () => void;
};

const NOOP_COMMANDS: GameCommands = {
  begin() {},
  restart() {},
  interact() {},
  toggleMute() {},
  adjustZoom() {},
  resetZoom() {},
};

function startLockerAction(view: LockerView, name: string, timeScale = 1) {
  const clip = view.clips.get(name);
  if (!clip) throw new Error(`Hero locker ${view.id} is missing required clip ${name}`);
  const previous = view.action;
  const action = view.mixer.clipAction(clip, view.root);
  action.reset();
  action.enabled = true;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.timeScale = timeScale;
  action.play();
  // Evaluate the matching first pose before releasing the clamped preceding
  // action. stopAllAction() here would restore the bind pose for one rendered
  // frame, producing a closed-door flash between Open and Close clips.
  view.mixer.update(0);
  if (previous && previous !== action) previous.stop();
  view.action = action;
  view.actionName = name;
  return action;
}

function playLockerSequence(
  view: LockerView,
  names: readonly string[],
  owner: LockerView["owner"] = "player",
) {
  view.queue = [...names];
  view.owner = owner;
  view.peeking = false;
  view.holdFinal = false;
  view.delayRemaining = 0;
  // When exit is requested during a peek, finish closing the partially-open
  // door before starting the authored exit performance. Starting Open_Exit at
  // time zero here would visibly snap the door back to its closed pose.
  if (view.peekClosing) return;
  view.peekClosing = false;
  const first = view.queue.shift();
  if (first) startLockerAction(view, first);
}

function closeCheckedLocker(view: LockerView) {
  if (view.owner === "player" && (view.action || view.queue.length || view.peeking || view.peekClosing)) return;
  view.owner = "chaser";
  view.peeking = false;
  view.peekClosing = false;
  view.holdFinal = false;
  view.delayRemaining = 0;
  if (view.actionName === "Locker_Door_Check_Open" && view.action?.isRunning()) {
    // Finish the authored opening before closing. Jumping straight into the
    // fully-open first pose of Check_Close would pop a half-open door.
    view.action.paused = false;
    view.action.timeScale = 1;
    view.queue = ["Locker_Door_Check_Close"];
    return;
  }
  playLockerSequence(view, ["Locker_Door_Check_Close"], "chaser");
}

function holdLockerAction(view: LockerView, name: string, delaySeconds = 0) {
  if (!canChaserTakeLockerDoor({
    owner: view.owner,
    hasAction: Boolean(view.action),
    actionRunning: Boolean(view.action?.isRunning()),
    queuedActions: view.queue.length,
    peeking: view.peeking,
    peekClosing: view.peekClosing,
  })) return false;
  view.queue = delaySeconds > 0 ? [name] : [];
  view.owner = "chaser";
  view.peeking = false;
  view.peekClosing = false;
  view.holdFinal = true;
  view.delayRemaining = Math.max(0, delaySeconds);
  if (delaySeconds > 0) {
    view.mixer.stopAllAction();
    view.action = null;
    view.actionName = null;
  } else startLockerAction(view, name);
  return true;
}

function setLockerPeek(view: LockerView, active: boolean) {
  if (active === view.peeking && !view.peekClosing) return;
  if (active && view.holdFinal && view.actionName === "Locker_Door_Check_Open" && view.action) {
    // A checker is already opening this exact door. Keep that authored motion
    // instead of snapping to the peek clip; the AI transition will reverse it
    // if the newly exposed player breaks the inspection.
    view.owner = "player";
    view.peeking = true;
    return;
  }
  view.owner = "player";
  view.peeking = active;
  view.queue = [];
  if (active) {
    view.delayRemaining = 0;
    view.holdFinal = false;
    if (view.actionName === "Locker_Door_Open_Enter" && view.action) {
      view.action.paused = false;
      view.action.timeScale = 1;
      view.peekClosing = false;
      return;
    }
    view.peekClosing = false;
    startLockerAction(view, "Locker_Door_Open_Enter");
    return;
  }
  if (view.actionName === "Locker_Door_Open_Enter" && view.action) {
    view.action.paused = false;
    view.action.timeScale = -1;
    view.peekClosing = true;
  }
}

function updateLocker(view: LockerView, delta: number) {
  if (view.delayRemaining > 0) {
    view.delayRemaining = Math.max(0, view.delayRemaining - delta);
    if (view.delayRemaining > 0) return;
    const delayed = view.queue.shift();
    if (delayed) startLockerAction(view, delayed);
  }
  view.mixer.update(delta);
  const action = view.action;
  if (!action) return;
  if (view.peeking && view.actionName === "Locker_Door_Open_Enter") {
    const stopAt = action.getClip().duration * 0.17;
    if (action.time >= stopAt) {
      action.time = stopAt;
      action.paused = true;
    }
    return;
  }
  if (view.peekClosing && action.time <= 0.01) {
    action.stop();
    view.action = null;
    view.actionName = null;
    view.peekClosing = false;
    const next = view.queue.shift();
    if (next) startLockerAction(view, next);
    else view.owner = "idle";
    return;
  }
  if (action.isRunning()) return;
  if (view.holdFinal) return;
  const next = view.queue.shift();
  if (next) startLockerAction(view, next);
  else {
    action.stop();
    view.action = null;
    view.actionName = null;
    view.owner = "idle";
  }
}

function requestAnimation(
  view: ActorView,
  state: AnimationState,
  options: { fade?: number; timeScale?: number; duration?: number; restart?: boolean; loop?: boolean } = {},
) {
  if (view.lastRequested === state && !options.restart) return;
  const timeScale = options.duration
    ? (view.durationByState[state] ?? options.duration) / options.duration
    : options.timeScale;
  view.animator.play(state, {
    fade: options.fade,
    timeScale,
    restart: options.restart ?? false,
    loop: options.loop,
  });
  view.lastRequested = state;
}

function sampleActorSpeed(view: ActorView, point: Point, tick: number, fixedStepSeconds: number) {
  if (tick < view.lastTick) {
    view.lastPoint = { ...point };
    view.lastTick = tick;
    view.sampledSpeed = 0;
    return 0;
  }
  const elapsedTicks = tick - view.lastTick;
  if (elapsedTicks === 0) return view.sampledSpeed;
  view.sampledSpeed = distanceBetween(view.lastPoint, point) * CELL / (elapsedTicks * fixedStepSeconds);
  view.lastPoint = { ...point };
  view.lastTick = tick;
  return view.sampledSpeed;
}

function updateActorVisibility(view: ActorView, visible: boolean, delta: number, immediate = false) {
  const target = visible ? 1 : 0;
  view.visibilityAlpha = immediate
    ? target
    : THREE.MathUtils.damp(view.visibilityAlpha, target, 18, delta);
  if (Math.abs(view.visibilityAlpha - target) < 0.006) view.visibilityAlpha = target;
  if (visible) view.root.visible = true;
  const fading = view.visibilityAlpha < 0.999;
  for (const entry of view.visibilityMaterials) {
    const transparent = entry.baseTransparent || fading;
    const depthWrite = entry.baseDepthWrite && view.visibilityAlpha > 0.96;
    if (entry.material.transparent !== transparent || entry.material.depthWrite !== depthWrite) {
      entry.material.transparent = transparent;
      entry.material.depthWrite = depthWrite;
      entry.material.needsUpdate = true;
    }
    entry.material.opacity = entry.baseOpacity * view.visibilityAlpha;
  }
  if (!visible && view.visibilityAlpha === 0) view.root.visible = false;
}

function disposeObjectResources(roots: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (!geometries.has(object.geometry)) {
        object.geometry.dispose();
        geometries.add(object.geometry);
      }
      if (object instanceof THREE.SkinnedMesh && !skeletons.has(object.skeleton)) {
        object.skeleton.dispose();
        skeletons.add(object.skeleton);
      }
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (materials.has(material)) continue;
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture && !textures.has(value)) {
            value.dispose();
            textures.add(value);
          }
        }
        material.dispose();
        materials.add(material);
      }
    });
  }
}

function threatForMode(mode: ChaserMode) {
  switch (mode) {
    case "suspicious": return 0.28;
    case "chase": return 1;
    case "lost-sight": return 0.72;
    case "go-to-last-known": return 0.58;
    case "search": return 0.42;
    case "check-hide": return 0.82;
    case "spawn-delay":
    case "patrol": return 0;
  }
}

function chaserStatus(mode: ChaserMode) {
  switch (mode) {
    case "spawn-delay": return "安全准备";
    case "patrol": return "巡逻中";
    case "suspicious": return "听见动静";
    case "chase": return "正在追捕";
    case "lost-sight": return "视线已断";
    case "go-to-last-known": return "追查最后位置";
    case "search": return "附近搜索";
    case "check-hide": return "正在检查藏身处";
  }
}

function playerPresentationPoint(state: GameState) {
  const spot = state.player.hideSpotId
    ? LEVEL.hideSpots.find((candidate) => candidate.id === state.player.hideSpotId)
    : undefined;
  if (!spot) return state.player.position;
  if (state.player.mode === "aligning-hide") return state.player.position;
  if (state.player.mode === "entering-hide") {
    const progress = 1 - state.player.transitionRemainingSeconds / HIDE_ENTER_SECONDS;
    const travel = THREE.MathUtils.smoothstep(progress, 0.2, 0.72);
    return {
      x: THREE.MathUtils.lerp(spot.approach.x, spot.concealed.x, travel),
      y: THREE.MathUtils.lerp(spot.approach.y, spot.concealed.y, travel),
    };
  }
  if (state.player.mode === "exiting-hide") {
    const progress = 1 - state.player.transitionRemainingSeconds / HIDE_EXIT_SECONDS;
    const travel = THREE.MathUtils.smoothstep(progress, 0.2, 0.75);
    return {
      x: THREE.MathUtils.lerp(spot.concealed.x, spot.approach.x, travel),
      y: THREE.MathUtils.lerp(spot.concealed.y, spot.approach.y, travel),
    };
  }
  if (["hidden", "entering-peek", "peeking", "exiting-peek"].includes(state.player.mode)) return spot.concealed;
  return state.player.position;
}

function canPlayerObserveChaser(state: GameState) {
  if (state.phase === "won") return false;
  if (state.phase === "lost" || state.phase === "ready") return true;
  if (!isPlayerVisuallyExposed(state.player, DEFAULT_GAME_CONFIG)) return false;
  return distanceBetween(state.player.position, state.chaser.position) <= PLAYER_OBSERVATION_RANGE
    && hasLineOfSight(LEVEL, state.player.position, state.chaser.position);
}

export function ChasingGame() {
  const mount = useRef<HTMLDivElement>(null);
  const keyboardKeys = useRef(new Set<string>());
  const touchKeys = useRef(new Set<string>());
  const interactPressed = useRef(false);
  const commands = useRef<GameCommands>(NOOP_COMMANDS);
  const [phase, setPhase] = useState<GamePhase>("ready");
  const [playerMode, setPlayerMode] = useState<PlayerMode>("free");
  const [chaserMode, setChaserMode] = useState<ChaserMode>("spawn-delay");
  const [chaserConfirming, setChaserConfirming] = useState(false);
  const [chaserObservable, setChaserObservable] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [objectiveDistance, setObjectiveDistance] = useState(objectiveDistanceMeters(LEVEL.playerStart));
  const [interaction, setInteraction] = useState<HideInteraction | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: TOTAL_ASSETS, message: "正在载入项目美术资产：角色、校园与互动道具…" });
  const [resultVisible, setResultVisible] = useState(true);
  const [musicMuted, setMusicMuted] = useState(false);

  const begin = useCallback(() => commands.current.begin(), []);
  const restart = useCallback(() => commands.current.restart(), []);
  const interact = useCallback(() => commands.current.interact(), []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const target = event.target instanceof Element ? event.target : null;
      const focusedControl = Boolean(target?.closest("button, input, select, textarea, a[href], [contenteditable='true']"));
      if (shouldIgnoreFocusedControlKey(key, focusedControl)) return;
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) event.preventDefault();
      keyboardKeys.current.add(key);
      if (event.repeat) return;
      if (key === "r") commands.current.restart();
      else if (key === "m") commands.current.toggleMute();
      else if (key === "0") commands.current.resetZoom();
      else if (key === "-" || key === "_") commands.current.adjustZoom(1.12);
      else if (key === "+" || key === "=") commands.current.adjustZoom(1 / 1.12);
      else if ((key === "enter" || key === " ") && phase !== "playing") commands.current.begin();
      else if (key === "e" || (key === " " && phase === "playing")) commands.current.interact();
    };
    const keyUp = (event: KeyboardEvent) => keyboardKeys.current.delete(event.key.toLowerCase());
    const clearInput = () => {
      keyboardKeys.current.clear();
      touchKeys.current.clear();
      interactPressed.current = false;
    };
    const clearHiddenInput = () => {
      if (document.visibilityState !== "visible") clearInput();
    };
    addEventListener("keydown", keyDown);
    addEventListener("keyup", keyUp);
    addEventListener("blur", clearInput);
    document.addEventListener("visibilitychange", clearHiddenInput);
    return () => {
      removeEventListener("keydown", keyDown);
      removeEventListener("keyup", keyUp);
      removeEventListener("blur", clearInput);
      document.removeEventListener("visibilitychange", clearHiddenInput);
    };
  }, [phase]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;

    const scorePrewarmAbort = new AbortController();
    void prewarmAdaptiveScoreAssets(undefined, scorePrewarmAbort.signal);
    let disposed = false;
    let frame = 0;
    let last = performance.now();
    let lastHudUpdate = 0;
    let ready = false;
    let cameraDistance = 16.25;
    let resultTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCheckSpot: string | null = null;
    let lastScoreThreat = Number.NaN;
    let captureStageRemaining = 0;
    let capturePerformanceStarted = false;
    let simulation = new GameSimulation({
      config: { hideEnterSeconds: HIDE_ENTER_SECONDS, hideExitSeconds: HIDE_EXIT_SECONDS, checkHideSeconds: HIDE_CHECK_SECONDS },
    });
    let latestState = simulation.getState();
    const resetFrameClock = () => {
      if (document.visibilityState === "visible") last = performance.now();
    };
    const cameraZoom = { value: 1 };
    const actors: Partial<Record<ActorName, ActorView>> = {};
    const lockers = new Map<string, LockerView>();
    const score = new AdaptiveScoreController();
    try {
      const storedMuted = localStorage.getItem("chasing.music-muted.v1") === "true";
      score.setMuted(storedMuted);
      queueMicrotask(() => {
        if (!disposed) setMusicMuted(storedMuted);
      });
    } catch {
      // Storage may be unavailable in hardened/private contexts; audio itself
      // remains fully usable for the current session.
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101a24);
    scene.fog = new THREE.FogExp2(0x101a24, 0.0175);
    const camera = new THREE.PerspectiveCamera(56, 1, 0.08, 150);
    const cameraDirection = createFixedCameraDirection();
    const cameraFocus = world(LEVEL.playerStart).add(new THREE.Vector3(0, 0.92, 0));
    camera.position.copy(cameraFocus).addScaledVector(cameraDirection, cameraDistance);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      queueMicrotask(() => {
        if (!disposed) setLoadError(`无法创建 3D 渲染环境：${message}`);
      });
      return () => { disposed = true; };
    }
    renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in current Three.js. PCF keeps the
    // production console clean and remains stable across WebGL implementations.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    host.appendChild(renderer.domElement);
    document.addEventListener("visibilitychange", resetFrameClock);
    addEventListener("pageshow", resetFrameClock);
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      ready = false;
      delete document.documentElement.dataset.chasingReady;
      keyboardKeys.current.clear();
      touchKeys.current.clear();
      interactPressed.current = false;
      if (!disposed) {
        setLoading(true);
        setLoadError("3D 渲染上下文已中断；恢复后将自动重新载入游戏。");
      }
    };
    const handleContextRestored = () => {
      if (!disposed) location.reload();
    };
    renderer.domElement.addEventListener("webglcontextlost", handleContextLost);
    renderer.domElement.addEventListener("webglcontextrestored", handleContextRestored);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const roomEnvironment = new RoomEnvironment();
    const environmentTarget = pmrem.fromScene(roomEnvironment, 0.04);
    scene.environment = environmentTarget.texture;
    roomEnvironment.dispose();
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0x8dbbe0, 0x253023, 1.35));
    const moon = new THREE.DirectionalLight(0xb9d7ff, 2.35);
    moon.position.set(14, 28, 18);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -32;
    moon.shadow.camera.right = 32;
    moon.shadow.camera.top = 32;
    moon.shadow.camera.bottom = -32;
    moon.shadow.bias = -0.00025;
    scene.add(moon);
    const warmBounce = new THREE.DirectionalLight(0xffc98a, 1.1);
    warmBounce.position.set(-18, 12, -14);
    scene.add(warmBounce);

    const campus = new THREE.Group();
    campus.name = "authored-campus";
    scene.add(campus);
    const loader = new GLTFLoader();
    const cameraOcclusionOrigin = { value: new THREE.Vector3() };
    const cameraOcclusionTarget = { value: new THREE.Vector3() };
    const cameraOccluders: CameraOccluder[] = [];
    const occluderByMesh = new Map<THREE.Object3D, CameraOccluder>();
    const occlusionMeshes: THREE.Mesh[] = [];
    const occlusionRaycaster = new THREE.Raycaster();
    const occlusionRayDirection = new THREE.Vector3();
    const occlusionScreenRight = new THREE.Vector3();
    const occlusionSamplePoints = Array.from({ length: 5 }, () => new THREE.Vector3());
    let occlusionRaycastRemaining = 0;

    const patchOccludingMaterial = (
      source: THREE.Material,
      strength: { value: number },
      pass: "opaque-cutout" | "transparent-overlay",
    ) => {
      const material = source.clone();
      // Preserve intentionally transparent surfaces such as car windows. Their
      // opaque sibling meshes still participate in the same occluder group.
      if (material.transparent || material.opacity < 0.98) return material;
      const previousOnBeforeCompile = material.onBeforeCompile;
      const previousProgramKey = material.customProgramCacheKey();
      material.alphaHash = false;
      material.transparent = pass === "transparent-overlay";
      material.depthWrite = pass === "opaque-cutout";
      material.onBeforeCompile = (shader, rendererContext) => {
        previousOnBeforeCompile.call(material, shader, rendererContext);
        shader.uniforms.cameraOcclusionOrigin = cameraOcclusionOrigin;
        shader.uniforms.cameraOcclusionTarget = cameraOcclusionTarget;
        shader.uniforms.cameraOcclusionStrength = strength;
        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            "#include <common>\nvarying vec3 vCameraOccluderWorldPosition;",
          )
          .replace(
            "#include <project_vertex>",
            `#include <project_vertex>
vec4 cameraOccluderWorldPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  cameraOccluderWorldPosition = batchingMatrix * cameraOccluderWorldPosition;
#endif
#ifdef USE_INSTANCING
  cameraOccluderWorldPosition = instanceMatrix * cameraOccluderWorldPosition;
#endif
vCameraOccluderWorldPosition = ( modelMatrix * cameraOccluderWorldPosition ).xyz;`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
uniform vec3 cameraOcclusionOrigin;
uniform vec3 cameraOcclusionTarget;
uniform float cameraOcclusionStrength;
varying vec3 vCameraOccluderWorldPosition;`,
          )
          .replace(
            "#include <alphahash_fragment>",
            `vec3 cameraOcclusionSegment = cameraOcclusionTarget - cameraOcclusionOrigin;
float cameraOcclusionLengthSquared = max( dot( cameraOcclusionSegment, cameraOcclusionSegment ), 0.0001 );
float cameraOcclusionAlong = clamp(
  dot( vCameraOccluderWorldPosition - cameraOcclusionOrigin, cameraOcclusionSegment ) / cameraOcclusionLengthSquared,
  0.0,
  1.0
);
vec3 cameraOcclusionClosest = cameraOcclusionOrigin + cameraOcclusionSegment * cameraOcclusionAlong;
float cameraOcclusionDistance = distance( vCameraOccluderWorldPosition, cameraOcclusionClosest );
float cameraOcclusionCorridor = 1.0 - smoothstep( 0.58, 1.08, cameraOcclusionDistance );
float cameraOcclusionEnds = smoothstep( 0.035, 0.12, cameraOcclusionAlong )
  * ( 1.0 - smoothstep( 0.985, 1.0, cameraOcclusionAlong ) );
float cameraOcclusionFade = cameraOcclusionStrength * cameraOcclusionCorridor * cameraOcclusionEnds;
${pass === "opaque-cutout"
    ? "if ( cameraOcclusionFade > 0.002 ) discard;"
    : `if ( cameraOcclusionFade <= 0.002 ) discard;
diffuseColor.a *= mix( 1.0, 0.12, cameraOcclusionFade );`}
#include <alphahash_fragment>`,
          );
      };
      material.customProgramCacheKey = () => `${previousProgramKey}|camera-occlusion-v2-${pass}`;
      material.needsUpdate = true;
      return material;
    };

    const registerCameraOccluder = (name: string, roots: readonly THREE.Object3D[]) => {
      const meshes: THREE.Mesh[] = [];
      for (const root of roots) {
        root.traverse((object) => {
          if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) meshes.push(object);
        });
      }
      if (!meshes.length) return;
      const strength = { value: 0 };
      const baseMaterials = new Map<string, THREE.Material>();
      const overlayMaterials = new Map<string, THREE.Material>();
      const cloneBaseMaterial = (material: THREE.Material) => {
        const existing = baseMaterials.get(material.uuid);
        if (existing) return existing;
        const cloned = patchOccludingMaterial(material, strength, "opaque-cutout");
        baseMaterials.set(material.uuid, cloned);
        return cloned;
      };
      const cloneOverlayMaterial = (material: THREE.Material) => {
        const existing = overlayMaterials.get(material.uuid);
        if (existing) return existing;
        const cloned = patchOccludingMaterial(material, strength, "transparent-overlay");
        if (material.transparent || material.opacity < 0.98) cloned.visible = false;
        overlayMaterials.set(material.uuid, cloned);
        return cloned;
      };
      const overlays: THREE.Mesh[] = [];
      for (const mesh of meshes) {
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = Array.isArray(mesh.material)
          ? sourceMaterials.map(cloneBaseMaterial)
          : cloneBaseMaterial(sourceMaterials[0]);
        if (sourceMaterials.some((material) => !material.transparent && material.opacity >= 0.98)) {
          const overlay = mesh.clone(false) as THREE.Mesh;
          overlay.name = `${mesh.name}-camera-occlusion-overlay`;
          overlay.material = Array.isArray(mesh.material)
            ? sourceMaterials.map(cloneOverlayMaterial)
            : cloneOverlayMaterial(sourceMaterials[0]);
          overlay.castShadow = false;
          overlay.receiveShadow = true;
          overlay.renderOrder = mesh.renderOrder + 1;
          overlay.visible = false;
          mesh.parent?.add(overlay);
          overlays.push(overlay);
        }
      }
      const occluder: CameraOccluder = { name, meshes, overlays, strength, obscured: false };
      cameraOccluders.push(occluder);
      for (const mesh of meshes) {
        occluderByMesh.set(mesh, occluder);
        occlusionMeshes.push(mesh);
      }
    };

    const updateCameraOcclusion = (playerAnchor: THREE.Vector3, delta: number) => {
      cameraOcclusionOrigin.value.copy(camera.position);
      cameraOcclusionTarget.value.copy(playerAnchor);
      occlusionRaycastRemaining -= delta;
      if (occlusionRaycastRemaining <= 0) {
        occlusionRaycastRemaining = 0.075;
        for (const occluder of cameraOccluders) occluder.obscured = false;
        if (occlusionMeshes.length) {
          // One torso ray is not enough for an elevated camera: it can clear a
          // wall cap while the same wall still hides the player's legs. Sample
          // the full readable silhouette, including both shoulders.
          occlusionScreenRight.set(cameraDirection.z, 0, -cameraDirection.x).normalize();
          occlusionSamplePoints[0].copy(playerAnchor);
          occlusionSamplePoints[1].copy(playerAnchor).y -= 0.72;
          occlusionSamplePoints[2].copy(playerAnchor).y += 0.54;
          occlusionSamplePoints[3].copy(playerAnchor).addScaledVector(occlusionScreenRight, 0.3);
          occlusionSamplePoints[4].copy(playerAnchor).addScaledVector(occlusionScreenRight, -0.3);
          for (const sample of occlusionSamplePoints) {
            occlusionRayDirection.subVectors(sample, camera.position);
            const sampleDistance = occlusionRayDirection.length();
            if (sampleDistance <= 0.4) continue;
            occlusionRayDirection.multiplyScalar(1 / sampleDistance);
            occlusionRaycaster.set(camera.position, occlusionRayDirection);
            occlusionRaycaster.near = 0.18;
            occlusionRaycaster.far = Math.max(0.2, sampleDistance - 0.18);
            for (const hit of occlusionRaycaster.intersectObjects(occlusionMeshes, false)) {
              occluderByMesh.get(hit.object)!.obscured = true;
            }
          }
        }
      }
      for (const occluder of cameraOccluders) {
        occluder.strength.value = smoothOcclusionStrength(
          occluder.strength.value,
          occluder.obscured,
          delta,
        );
        const overlayVisible = occluder.strength.value > 0.002;
        for (const overlay of occluder.overlays) overlay.visible = overlayVisible;
      }
    };

    const updateLockerVisionStyle = (state: GameState) => {
      const mix = lockerVisionMix(state.player, simulation.config);
      const playfield = host.parentElement;
      playfield?.style.setProperty("--locker-cover", mix.cover.toFixed(4));
      playfield?.style.setProperty("--locker-peek", mix.peek.toFixed(4));
    };

    const updatePhasePresentation = (next: GamePhase) => {
      setPhase(next);
      if (next === "won" || next === "lost") {
        touchKeys.current.clear();
        interactPressed.current = false;
        setResultVisible(false);
        if (resultTimer) clearTimeout(resultTimer);
        // Include the face-to-face staging beat, then let the full authored
        // resolution performance read before UI covers the actors.
        resultTimer = setTimeout(() => setResultVisible(true), 1_700);
      }
    };

    const resetPresentation = (state: GameState) => {
      if (resultTimer) {
        clearTimeout(resultTimer);
        resultTimer = null;
      }
      keyboardKeys.current.clear();
      touchKeys.current.clear();
      interactPressed.current = false;
      lastCheckSpot = null;
      lastScoreThreat = Number.NaN;
      captureStageRemaining = 0;
      capturePerformanceStarted = false;
      lastHudUpdate = 0;
      cameraZoom.value = 1;
      setResultVisible(false);
      setPhase(state.phase);
      setPlayerMode(state.player.mode);
      setChaserMode(state.chaser.mode);
      setChaserConfirming(state.chaser.visualConfirmationSeconds !== null);
      setChaserObservable(canPlayerObserveChaser(state));
      setElapsed(Math.floor(state.elapsedSeconds));
      setObjectiveDistance(objectiveDistanceMeters(state.player.position));
      setInteraction(simulation.getHideInteraction());
      updateLockerVisionStyle(state);

      const resetActor = (view: ActorView | undefined, point: Point, heading: Point) => {
        if (!view) return;
        view.root.position.copy(world(point));
        view.root.rotation.set(0, Math.atan2(heading.x, heading.y), 0);
        view.lastPoint = { ...point };
        view.lastTick = state.tick;
        view.sampledSpeed = 0;
        view.lastRequested = null;
        view.lastTurnCycle = -1;
        updateActorVisibility(view, true, 0, true);
        requestAnimation(view, "idle", { fade: 0, restart: true });
      };
      resetActor(actors.kid, state.player.position, state.player.heading);
      resetActor(actors.villain, state.chaser.position, state.chaser.heading);
      resetActor(actors.police, { x: 23, y: 22.15 }, { x: 0, y: -1 });

      cameraFocus.copy(world(state.player.position)).add(new THREE.Vector3(0, 0.92, 0));
      cameraDirection.copy(createFixedCameraDirection());
      cameraDistance = 16.25;
      camera.position.copy(cameraFocus).addScaledVector(cameraDirection, cameraDistance);
      camera.lookAt(cameraFocus);
      occlusionRaycastRemaining = 0;
      for (const occluder of cameraOccluders) {
        occluder.obscured = false;
        occluder.strength.value = 0;
        for (const overlay of occluder.overlays) overlay.visible = false;
      }

      for (const locker of lockers.values()) {
        locker.mixer.stopAllAction();
        locker.queue = [];
        locker.action = null;
        locker.actionName = null;
        locker.peeking = false;
        locker.peekClosing = false;
        locker.holdFinal = false;
        locker.delayRemaining = 0;
        locker.owner = "idle";
        locker.root.getObjectByName("DoorPivot")?.quaternion.identity();
      }
    };

    const beginGame = () => {
      if (!ready) return;
      latestState = simulation.start();
      resetPresentation(latestState);
      void score.unlock().then((result) => {
        if (!result.ok) console.warn("Adaptive score could not start", result.error);
      });
    };

    commands.current = {
      begin: beginGame,
      restart: beginGame,
      interact() {
        if (!ready) return;
        void score.unlock();
        interactPressed.current = true;
      },
      toggleMute() {
        setMusicMuted((current) => {
          score.setMuted(!current);
          try {
            localStorage.setItem("chasing.music-muted.v1", String(!current));
          } catch {
            // Muting still applies even when persistence is unavailable.
          }
          return !current;
        });
      },
      adjustZoom(factor) {
        cameraZoom.value = THREE.MathUtils.clamp(cameraZoom.value * factor, 0.72, 1.65);
      },
      resetZoom() {
        cameraZoom.value = 1;
      },
    };

    const loadAll = async () => {
      let done = 0;
      const mark = (message: string) => {
        done += 1;
        if (!disposed) setLoadProgress({ done, total: TOTAL_ASSETS, message: `正在载入项目美术资产：${message} ${done}/${TOTAL_ASSETS}` });
      };
      const actorEntries = Object.entries(ACTOR_SPECS) as [ActorName, (typeof ACTOR_SPECS)[ActorName]][];
      const coreEntries = Object.entries(CORE_ASSETS) as [CoreAssetName, string][];
      const detailEntries = Object.entries(DETAIL_ASSETS) as [DetailAssetName, string][];
      const actorAssets = {} as Record<ActorName, GLTF>;
      const coreAssets = {} as Record<CoreAssetName, GLTF>;
      const detailAssets = {} as Record<DetailAssetName, GLTF>;
      const loads = [
        ...actorEntries.map(async ([name, spec]) => {
          actorAssets[name] = await loader.loadAsync(spec.url);
          mark(name === "kid" ? "主角动作集" : name === "villain" ? "追捕者动作集" : "出口警察动作集");
        }),
        ...coreEntries.map(async ([name, url]) => {
          coreAssets[name] = await loader.loadAsync(url);
          mark("校园结构");
        }),
        ...detailEntries.map(async ([name, url]) => {
          detailAssets[name] = await loader.loadAsync(url);
          mark(name === "locker" ? "英雄储物柜与门动画" : "校园美术细节");
        }),
      ];
      const settled = await Promise.allSettled(loads);
      const loadedAssets = [
        ...Object.values(actorAssets),
        ...Object.values(coreAssets),
        ...Object.values(detailAssets),
      ];
      const rejection = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (disposed || rejection) {
        disposeObjectResources(loadedAssets.map((asset) => asset.scene));
        if (rejection) throw rejection.reason;
        return;
      }

      buildCampus(coreAssets, campus);
      buildDetails(detailAssets, campus, scene, lockers);
      placeActors(actorAssets, actors, scene);
      ready = true;
      setLoading(false);
      setLoadError("");
      document.documentElement.dataset.chasingReady = "true";
      if (new URLSearchParams(location.search).get("autostart") === "1") beginGame();
    };

    const buildCampus = (assets: Record<CoreAssetName, GLTF>, parent: THREE.Group) => {
      const floorBatches: Record<"floor" | "grassFloor" | "classroomFloor" | "playgroundFloor", ModulePlacement[]> = {
        floor: [], grassFloor: [], classroomFloor: [], playgroundFloor: [],
      };
      const wallBatches: Record<"wall" | "wallCorner" | "wallEnd", ModulePlacement[]> = {
        wall: [], wallCorner: [], wallEnd: [],
      };
      const campusGroundChunks = new Map<string, ModulePlacement[]>();
      const groundChunkSize = 15;
      const addCampusGround = (x: number, y: number) => {
        const key = `${Math.floor(x / groundChunkSize)},${Math.floor(y / groundChunkSize)}`;
        const placements = campusGroundChunks.get(key) ?? [];
        placements.push({
          position: world({ x, y }).add(new THREE.Vector3(0, -0.1, 0)),
          rotation: 0,
        });
        campusGroundChunks.set(key, placements);
      };
      const groundMarginCells = 10;
      for (let y = -groundMarginCells; y < LEVEL.height + groundMarginCells; y += 1) {
        for (let x = -groundMarginCells; x < LEVEL.width + groundMarginCells; x += 1) {
          if (x >= 0 && x < LEVEL.width && y >= 0 && y < LEVEL.height) continue;
          addCampusGround(x, y);
        }
      }
      const directions = [
        { dx: 0, dy: -1, ox: 0, oz: -CELL / 2, rotation: 0 },
        { dx: 0, dy: 1, ox: 0, oz: CELL / 2, rotation: 0 },
        { dx: -1, dy: 0, ox: -CELL / 2, oz: 0, rotation: Math.PI / 2 },
        { dx: 1, dy: 0, ox: CELL / 2, oz: 0, rotation: Math.PI / 2 },
      ] as const;
      for (let y = 0; y < LEVEL.height; y += 1) {
        for (let x = 0; x < LEVEL.width; x += 1) {
          const position = world({ x, y });
          if (!LEVEL.walkable[y][x]) {
            // The maze is embedded in an authored campus lawn rather than
            // floating over a black void. Walls still make this ground
            // inaccessible, so collision and route readability stay exact.
            addCampusGround(x, y);
            continue;
          }
          const floorName = x <= 4 && y >= 10 && y <= 14
            ? "grassFloor"
            : x >= 8 && x <= 10 && y >= 17
              ? "classroomFloor"
              : x >= 16 && x <= 20 && y <= 4
                ? "playgroundFloor"
                : "floor";
          floorBatches[floorName].push({ position, rotation: 0 });
          const blocked = directions.filter(({ dx, dy }) => !LEVEL.walkable[y + dy]?.[x + dx]);
          for (const edge of blocked) {
            const name = blocked.length === 1 ? "wallEnd" : "wall";
            wallBatches[name].push({
              position: position.clone().add(new THREE.Vector3(edge.ox, 0, edge.oz)),
              rotation: edge.rotation,
            });
          }
          if (blocked.length >= 2) {
            for (let a = 0; a < blocked.length; a += 1) {
              for (let b = a + 1; b < blocked.length; b += 1) {
                if (blocked[a].dx === -blocked[b].dx && blocked[a].dy === -blocked[b].dy) continue;
                wallBatches.wallCorner.push({
                  position: position.clone().add(new THREE.Vector3((blocked[a].ox + blocked[b].ox), 0, (blocked[a].oz + blocked[b].oz))),
                  rotation: 0,
                });
              }
            }
          }
        }
      }
      const wallMeshes = [
        ...addInstancedModules(assets.wall.scene, new THREE.Vector3(CELL + 0.08, 1.58, 0.18), wallBatches.wall, parent, true),
        ...addInstancedModules(assets.wallEnd.scene, new THREE.Vector3(CELL + 0.08, 1.58, 0.2), wallBatches.wallEnd, parent, true),
        ...addInstancedModules(assets.wallCorner.scene, new THREE.Vector3(0.3, 1.58, 0.3), wallBatches.wallCorner, parent, true),
      ];
      registerCameraOccluder("campus-walls", wallMeshes);
      addInstancedModules(assets.floor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.floor, parent, false);
      addInstancedModules(assets.grassFloor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.grassFloor, parent, false);
      addInstancedModules(assets.classroomFloor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.classroomFloor, parent, false);
      addInstancedModules(assets.playgroundFloor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.playgroundFloor, parent, false);
      for (const placements of campusGroundChunks.values()) {
        addInstancedModules(assets.grassFloor.scene, new THREE.Vector3(CELL, 0.1, CELL), placements, parent, false);
      }

      const gate = fitModule(assets.frontGate.scene, new THREE.Vector3(1.9, 2.55, 0.42));
      gate.position.add(world(FRONT_GATE_POINT)).add(new THREE.Vector3(0, 0, -CELL * 0.5));
      parent.add(gate);
      registerCameraOccluder("front-gate", [gate]);
      const exitDoor = fitModule(assets.exit.scene, new THREE.Vector3(1.9, 2.55, 0.42));
      exitDoor.position.add(world(LEVEL.exit)).add(new THREE.Vector3(0, 0, CELL * 0.5));
      exitDoor.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
        object.material = object.material.clone();
        object.material.emissive.set(0x1f8a63);
        object.material.emissiveIntensity = 0.45;
      });
      parent.add(exitDoor);
      registerCameraOccluder("exit-door", [exitDoor]);
      const exitLight = new THREE.SpotLight(0x83ffc0, 28, 11, Math.PI / 5, 0.52, 1.6);
      exitLight.position.copy(world(LEVEL.exit)).add(new THREE.Vector3(0, 5.2, 0));
      exitLight.target.position.copy(world(LEVEL.exit));
      parent.add(exitLight, exitLight.target);
    };

    const buildDetails = (
      assets: Record<DetailAssetName, GLTF>,
      parent: THREE.Group,
      targetScene: THREE.Scene,
      lockerViews: Map<string, LockerView>,
    ) => {
      const propTemplates = new Map<string, THREE.Object3D>();
      const cameraOccludingProps = new Set<DetailAssetName>([
        "bench",
        "car",
        "tree",
        "basketball",
        "classroomDoor",
        "deskChair",
        "podium",
        "shrub",
        "station",
      ]);
      const addProp = (name: DetailAssetName, point: Point, height: number, rotation = 0, offset = new THREE.Vector3()) => {
        const key = `${name}:${height}`;
        const template = propTemplates.get(key) ?? fitProp(assets[name].scene, height);
        propTemplates.set(key, template);
        const object = template.clone(true);
        object.position.add(world(point)).add(offset);
        object.rotation.y = rotation;
        parent.add(object);
        if (cameraOccludingProps.has(name)) {
          registerCameraOccluder(`${name}-${point.x}-${point.y}`, [object]);
        }
      };

      const lockerSource = assets.locker;
      const clipMap = new Map(lockerSource.animations.map((clip) => [clip.name, clip]));
      const missingLockerClips = LOCKER_CLIPS.filter((name) => !clipMap.has(name));
      if (missingLockerClips.length) throw new Error(`Hero locker animation contract failed: ${missingLockerClips.join(", ")}`);
      for (const spot of LEVEL.hideSpots) {
        const root = fitInteractiveProp(lockerSource.scene, 2.12);
        root.name = `hero-locker-${spot.id}`;
        root.rotation.y = Math.atan2(spot.facing.x, spot.facing.y);
        root.position.copy(world(spot.concealed));
        root.updateMatrixWorld(true);
        const anchor = root.getObjectByName("HideAnchor");
        const pivot = root.getObjectByName("DoorPivot");
        if (!anchor || !pivot) throw new Error("Hero locker is missing HideAnchor or DoorPivot; refusing an art fallback");
        const anchorWorld = anchor.getWorldPosition(new THREE.Vector3());
        root.position.add(world(spot.concealed).sub(anchorWorld));
        parent.add(root);
        const view: LockerView = {
          id: spot.id,
          root,
          mixer: new THREE.AnimationMixer(root),
          clips: clipMap,
          queue: [],
          action: null,
          actionName: null,
          peeking: false,
          peekClosing: false,
          holdFinal: false,
          delayRemaining: 0,
          owner: "idle",
        };
        lockerViews.set(spot.id, view);
      }

      addProp("bench", { x: 18, y: 16 }, 1.05, Math.PI / 2);
      addProp("tree", { x: 3, y: 14 }, 3.8);
      addProp("shrub", { x: 3, y: 12 }, 0.95);
      for (const [point, height, rotation] of [
        [{ x: 4, y: 4 }, 3.6, 0.3],
        [{ x: 12, y: 4 }, 4.15, -0.45],
        [{ x: 18, y: 7 }, 3.85, 0.72],
        [{ x: 3, y: 19 }, 4.35, -0.2],
        [{ x: 15, y: 21 }, 3.7, 0.5],
        [{ x: 22, y: 7 }, 4.05, -0.72],
      ] as const) addProp("tree", point, height, rotation);
      for (const [point, height, rotation] of [
        [{ x: 6, y: 13 }, 0.72, 0.2],
        [{ x: 12, y: 11 }, 0.9, -0.4],
        [{ x: 19, y: 5 }, 0.82, 0.6],
        [{ x: 20, y: 15 }, 0.76, -0.7],
        [{ x: 15, y: 22 }, 0.88, 0.1],
      ] as const) addProp("shrub", point, height, rotation);
      addProp("car", { x: 22, y: 23 }, 1.55, Math.PI / 2, new THREE.Vector3(CELL * 0.76, 0, CELL * 0.72));
      addProp("station", LEVEL.exit, 3.25, Math.PI, new THREE.Vector3(0, 0, CELL * 1.7));
      addProp("basketball", { x: 20, y: 3 }, 2.65, -Math.PI / 2);
      addProp("classroomDoor", { x: 9, y: 17 }, 2.2, Math.PI / 2, new THREE.Vector3(-CELL * 0.44, 0, 0));
      addProp("deskChair", { x: 9, y: 18 }, 1.2);
      addProp("blackboard", { x: 9, y: 20 }, 1.5, Math.PI, new THREE.Vector3(0, 0, CELL * 0.43));
      addProp("podium", { x: 9, y: 19 }, 1.1, Math.PI);
      addProp("bulletin", { x: 11, y: 11 }, 1.25, -Math.PI / 2, new THREE.Vector3(CELL * 0.43, 0, 0));
      addProp("extinguisher", { x: 11, y: 10 }, 0.8, -Math.PI / 2, new THREE.Vector3(CELL * 0.38, 0, 0));
      addProp("trash", { x: 11, y: 12 }, 0.75, -Math.PI / 2, new THREE.Vector3(CELL * 0.33, 0, 0));
      addProp("books", { x: 11, y: 13 }, 0.18, 0, new THREE.Vector3(CELL * 0.3, 0, 0));
      addProp("backpack", { x: 13, y: 16 }, 0.5, 0, new THREE.Vector3(0, 0, CELL * 0.34));
      for (const point of [{ x: 7, y: 4 }, { x: 15, y: 5 }, { x: 21, y: 12 }, { x: 17, y: 17 }]) {
        addProp("ceilingLight", point, 0.16, 0, new THREE.Vector3(0, 2.35, 0));
        const lamp = new THREE.PointLight(0xffcf93, 5.2, 8.5, 2);
        lamp.position.copy(world(point)).add(new THREE.Vector3(0, 2.2, 0));
        targetScene.add(lamp);
      }
    };

    const placeActors = (
      assets: Record<ActorName, GLTF>,
      actorViews: Partial<Record<ActorName, ActorView>>,
      targetScene: THREE.Scene,
    ) => {
      for (const name of Object.keys(ACTOR_SPECS) as ActorName[]) {
        const spec = ACTOR_SPECS[name];
        const root = fitActor(assets[name].scene, spec.height);
        root.name = `actor-${name}`;
        const animator = new ActorAnimator(root, assets[name].animations, spec.aliases as ClipAliases);
        animator.require(spec.required);
        const initialPoint = name === "kid" ? LEVEL.playerStart : name === "villain" ? LEVEL.chaserStart : { x: 23, y: 22.15 };
        const initialHeading = name === "kid"
          ? { x: 0, y: 1 }
          : name === "villain"
            ? LEVEL.chaserStartHeading
            : { x: 0, y: -1 };
        root.position.copy(world(initialPoint));
        root.rotation.y = Math.atan2(initialHeading.x, initialHeading.y);
        targetScene.add(root);
        const durationByState: Partial<Record<AnimationState, number>> = {};
        const clipsByName = new Map(assets[name].animations.map((clip) => [clip.name.toLowerCase(), clip]));
        for (const [state, alias] of Object.entries(spec.aliases) as [AnimationState, string | readonly string[]][]) {
          const candidates = typeof alias === "string" ? [alias] : alias;
          const clip = candidates.map((candidate) => clipsByName.get(candidate.toLowerCase())).find(Boolean);
          if (clip) durationByState[state] = clip.duration;
        }
        const uniqueMaterials = new Map<string, THREE.Material>();
        root.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) uniqueMaterials.set(material.uuid, material);
        });
        const view: ActorView = {
          root,
          animator,
          durationByState,
          lastPoint: { ...initialPoint },
          lastTick: 0,
          sampledSpeed: 0,
          lastRequested: null,
          lastTurnCycle: -1,
          visibilityAlpha: 1,
          visibilityMaterials: [...uniqueMaterials.values()].map((material) => ({
            material,
            baseOpacity: material.opacity,
            baseTransparent: material.transparent,
            baseDepthWrite: material.depthWrite,
          })),
        };
        actorViews[name] = view;
        requestAnimation(view, "idle", { fade: 0 });
      }
    };

    const consumeEvents = (state: GameState) => {
      for (const event of state.events) {
        if (event.type === "hide-check-completed") {
          const locker = lockers.get(event.hideSpotId);
          if (locker) {
            if (event.occupied) locker.holdFinal = true;
            else closeCheckedLocker(locker);
          }
          continue;
        }
        if (event.type === "phase-changed") {
          updatePhasePresentation(event.to);
          if (event.to === "lost") {
            captureStageRemaining = CAPTURE_STAGING_SECONDS;
            capturePerformanceStarted = false;
            requestAnimation(actors.kid!, "idle", { fade: 0.08 });
            requestAnimation(actors.villain!, "alert", { fade: 0.08 });
          } else if (event.to === "won") {
            requestAnimation(actors.kid!, "celebrate", { fade: 0.18 });
            requestAnimation(actors.police!, "protect", { fade: 0.14 });
          }
        }
        if (event.type !== "player-mode-changed") continue;
        setPlayerMode(event.to);
        setInteraction(simulation.getHideInteraction());
        const spotId = state.player.hideSpotId;
        const locker = spotId ? lockers.get(spotId) : undefined;
        if (event.to === "entering-hide" && locker) {
          playLockerSequence(locker, ["Locker_Door_Open_Enter", "Locker_Door_Close_Enter"]);
          requestAnimation(actors.kid!, "enterHide", { fade: 0.1, duration: HIDE_ENTER_SECONDS });
        } else if (event.to === "aligning-hide") {
          requestAnimation(actors.kid!, "walk", { fade: 0.12 });
        } else if (event.to === "entering-peek" && locker) {
          setLockerPeek(locker, true);
          requestAnimation(actors.kid!, "peekLeft", { fade: 0.15 });
        } else if (event.to === "exiting-peek" && locker) {
          setLockerPeek(locker, false);
        } else if (event.from === "exiting-peek" && event.to === "hidden" && locker) {
          requestAnimation(actors.kid!, "hideIdle", { fade: 0.15 });
        } else if (event.to === "hidden") {
          requestAnimation(actors.kid!, "hideIdle", { fade: 0.18 });
        } else if (event.to === "exiting-hide" && locker) {
          setLockerPeek(locker, false);
          playLockerSequence(locker, ["Locker_Door_Open_Exit", "Locker_Door_Close_Exit"]);
          requestAnimation(actors.kid!, "exitHide", { fade: 0.1, duration: HIDE_EXIT_SECONDS });
        }
      }
    };

    const snapActorTransform = (view: ActorView, point: Point, heading: Point) => {
      view.root.position.copy(world(point));
      view.root.rotation.set(0, Math.atan2(heading.x, heading.y), 0);
    };

    const syncActorTransform = (
      view: ActorView,
      point: Point,
      heading: Point,
      delta: number,
      positionResponse = 18,
      turnSpeed = 9.5,
      snapHeading = false,
    ) => {
      const target = world(point);
      view.root.position.lerp(target, 1 - Math.exp(-positionResponse * delta));
      if (Math.hypot(heading.x, heading.y) > 1e-4) {
        const desired = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(heading.x, heading.y));
        if (snapHeading) view.root.quaternion.copy(desired);
        else view.root.quaternion.rotateTowards(desired, delta * turnSpeed);
      }
    };

    const syncAnimations = (state: GameState, delta: number) => {
      const kid = actors.kid;
      const villain = actors.villain;
      const police = actors.police;
      if (!kid || !villain || !police) return;
      const kidPoint = playerPresentationPoint(state);
      const kidSpeed = sampleActorSpeed(kid, state.player.position, state.tick, simulation.config.fixedStepSeconds);
      const villainSpeed = sampleActorSpeed(villain, state.chaser.position, state.tick, simulation.config.fixedStepSeconds);
      const captureStaging = state.phase === "lost" && !capturePerformanceStarted;
      syncActorTransform(
        kid,
        kidPoint,
        state.player.heading,
        delta,
        captureStaging ? 34 : 18,
        captureStaging ? 15 : 9.5,
        state.player.mode === "aligning-hide" && state.player.hideTurnDirection !== 0,
      );
      syncActorTransform(villain, state.chaser.position, state.chaser.heading, delta, captureStaging ? 34 : 18, captureStaging ? 15 : 9.5);

      if (state.phase === "playing") {
        if (state.player.mode === "free" || state.player.mode === "aligning-hide") {
          const kidTurn: AnimationState | null = state.player.hideTurnDirection > 0
            ? "turnLeft"
            : state.player.hideTurnDirection < 0
              ? "turnRight"
              : null;
          if (state.player.mode === "aligning-hide" && kidSpeed <= 0.12 && kidTurn) {
            const restart = kid.lastTurnCycle !== state.player.hideTurnCycle;
            // Simulation yaw and clip normalized time share the same segment
            // duration. A 180° pivot explicitly restarts at the 90° seam.
            requestAnimation(kid, kidTurn, {
              fade: restart && kid.lastTurnCycle >= 0 ? 0 : 0.08,
              loop: false,
              restart,
              duration: state.player.hideTurnSegmentDurationSeconds,
            });
            kid.lastTurnCycle = state.player.hideTurnCycle;
          } else {
            kid.lastTurnCycle = -1;
            const locomotion: AnimationState = kidSpeed > 2.35 ? "run" : kidSpeed > 0.12 ? "walk" : "idle";
            requestAnimation(kid, locomotion, { fade: 0.17 });
            kid.animator.setLocomotionRate(kidSpeed, locomotion === "run" ? 4.4 : 2.0);
          }
        }
        const checkId = state.chaser.memory.witnessedHideSpotId;
        const checkSpot = checkId ? LEVEL.hideSpots.find((spot) => spot.id === checkId) : undefined;
        const atCheckSpot = Boolean(checkSpot && distanceBetween(checkSpot.approach, state.chaser.position) < 0.18);
        let villainAnimation: AnimationState;
        switch (state.chaser.mode) {
          case "spawn-delay": villainAnimation = "idle"; break;
          case "patrol": villainAnimation = villainSpeed > 0.1 ? "walk" : "idle"; break;
          case "suspicious": villainAnimation = "alert"; break;
          case "chase": villainAnimation = "run"; break;
          case "lost-sight": villainAnimation = "loseSight"; break;
          case "go-to-last-known": villainAnimation = villainSpeed > 0.1 ? "run" : "loseSight"; break;
          case "search": villainAnimation = villainSpeed > 0.1 ? "walk" : "search"; break;
          case "check-hide": villainAnimation = atCheckSpot ? "checkLocker" : "walk"; break;
        }
        requestAnimation(villain, villainAnimation, {
          fade: 0.17,
          duration: villainAnimation === "checkLocker" ? HIDE_CHECK_SECONDS : undefined,
        });
        villain.animator.setLocomotionRate(villainSpeed, villainAnimation === "run" ? 3.7 : 1.65);
        const checkingLocker = checkId ? lockers.get(checkId) : undefined;
        if (
          state.chaser.mode === "check-hide"
          && checkId
          && atCheckSpot
          && (lastCheckSpot !== checkId || checkingLocker?.owner !== "chaser")
        ) {
          const locker = lockers.get(checkId);
          if (locker) {
            const openDuration = locker.clips.get("Locker_Door_Check_Open")?.duration ?? 0;
            const remainingCheck = Math.max(0, HIDE_CHECK_SECONDS - state.chaser.modeElapsedSeconds);
            if (holdLockerAction(locker, "Locker_Door_Check_Open", Math.max(0, remainingCheck - openDuration))) {
              lastCheckSpot = checkId;
            }
          }
        } else if (state.chaser.mode !== "check-hide") {
          if (state.phase === "playing" && lastCheckSpot) {
            const interrupted = lockers.get(lastCheckSpot);
            if (interrupted?.holdFinal && interrupted.delayRemaining > 0) {
              interrupted.queue = [];
              interrupted.delayRemaining = 0;
              interrupted.holdFinal = false;
              interrupted.owner = "idle";
            } else if (interrupted?.holdFinal && interrupted.actionName === "Locker_Door_Check_Open") {
              interrupted.holdFinal = false;
              if (interrupted.action) {
                interrupted.action.paused = false;
                interrupted.action.timeScale = -1;
                interrupted.peekClosing = true;
              }
            }
          }
          lastCheckSpot = null;
        }
      } else if (state.phase === "lost" && !capturePerformanceStarted) {
        captureStageRemaining = Math.max(0, captureStageRemaining - delta);
        if (captureStageRemaining <= 1e-9) {
          // Paired performances start only from exact authored anchors. This
          // absorbs render interpolation even when capture happens from behind.
          snapActorTransform(kid, kidPoint, state.player.heading);
          snapActorTransform(villain, state.chaser.position, state.chaser.heading);
          requestAnimation(kid, "caught", { fade: 0.08 });
          requestAnimation(villain, "catch", { fade: 0.08 });
          capturePerformanceStarted = true;
        }
      }
      kid.animator.update(delta);
      villain.animator.update(delta);
      police.animator.update(delta);
      for (const locker of lockers.values()) updateLocker(locker, delta);
    };

    const animate = (now: number) => {
      const delta = boundedFrameDeltaSeconds(last, now, simulation.config.maxFrameDeltaSeconds);
      last = now;
      if (ready) {
        const held = (key: string) => keyboardKeys.current.has(key) || touchKeys.current.has(key);
        let dx = 0;
        let dy = 0;
        if (held("a") || held("arrowleft")) dx -= 1;
        if (held("d") || held("arrowright")) dx += 1;
        if (held("w") || held("arrowup")) dy -= 1;
        if (held("s") || held("arrowdown")) dy += 1;
        const length = Math.hypot(dx, dy) || 1;
        const move = screenMoveToWorld({ x: dx / length, y: dy / length });
        latestState = simulation.advance(delta, {
          move,
          interactPressed: interactPressed.current,
          peekHeld: held("q"),
        });
        interactPressed.current = false;
        consumeEvents(latestState);
        updateLockerVisionStyle(latestState);
        const playerActuallyVisible = latestState.phase !== "playing"
          || isPlayerVisuallyExposed(latestState.player, simulation.config);
        const chaserKnowledgeObservable = canPlayerObserveChaser(latestState);
        const chaserWorldRendered = shouldRenderChaserModel(latestState.phase, playerActuallyVisible);
        syncAnimations(latestState, delta);
        if (actors.kid) {
          updateActorVisibility(
            actors.kid,
            playerActuallyVisible,
            delta,
            latestState.phase !== "playing",
          );
        }
        if (actors.villain) {
          updateActorVisibility(
            actors.villain,
            chaserWorldRendered,
            delta,
            true,
          );
        }
        const scoreThreat = latestState.phase === "playing" ? threatForMode(latestState.chaser.mode) : 0;
        if (scoreThreat !== lastScoreThreat) {
          score.setThreat(scoreThreat);
          lastScoreThreat = scoreThreat;
        }

        const playerAnchor = world(playerPresentationPoint(latestState)).add(new THREE.Vector3(0, 0.92, 0));
        const chaserAnchor = world(latestState.chaser.position).add(new THREE.Vector3(0, 1.05, 0));
        const policeAnchor = actors.police?.root.position.clone().add(new THREE.Vector3(0, 1.05, 0)) ?? playerAnchor;
        const framingThreat = shouldFrameChaser(
          latestState.phase,
          latestState.chaser.mode,
          chaserKnowledgeObservable,
        );
        const chaseFocus = framingThreat ? 0.5 : 0;
        const targetFocus = latestState.phase === "won"
          ? playerAnchor.clone().lerp(policeAnchor, 0.34)
          : latestState.phase === "lost"
            ? playerAnchor.clone().lerp(chaserAnchor, 0.3)
            : playerAnchor.clone().lerp(chaserAnchor, chaseFocus);
        cameraFocus.lerp(targetFocus, 1 - Math.exp(-(framingThreat ? 12 : 6.5) * delta));
        const baseDistance = THREE.MathUtils.clamp(16.25 + Math.max(0, 1.15 - camera.aspect) * 6, 16.25, 24);
        const chaseSeparation = framingThreat
          ? distanceBetween(latestState.player.position, latestState.chaser.position) * CELL
          : 0;
        const chaseFramingDistance = framingThreat
          ? THREE.MathUtils.clamp(chaseSeparation * 0.42, 3.4, 8.5)
          : 0;
        const dynamicDistance = baseDistance
          + threatForMode(latestState.chaser.mode) * 1.8
          + chaseFramingDistance;
        const framingRequest = () => ({
          focus: cameraFocus,
          points: [playerAnchor, chaserAnchor],
          cameraDirection,
          verticalFovDegrees: camera.fov,
          aspect: camera.aspect,
        });
        const requiredFramingDistance = framingThreat
          ? requiredCameraDistanceForFraming(framingRequest())
          : 0;
        const targetDistance = THREE.MathUtils.clamp(
          Math.max(dynamicDistance * cameraZoom.value, requiredFramingDistance),
          13.5,
          MAX_CAMERA_DISTANCE,
        );
        const cameraDistanceResponse = targetDistance > cameraDistance ? 8 : 3.2;
        const dampedCameraDistance = THREE.MathUtils.lerp(
          cameraDistance,
          targetDistance,
          1 - Math.exp(-cameraDistanceResponse * delta),
        );
        const maximumDistanceStep = (targetDistance > cameraDistance ? 60 : 28) * delta;
        cameraDistance += THREE.MathUtils.clamp(
          dampedCameraDistance - cameraDistance,
          -maximumDistanceStep,
          maximumDistanceStep,
        );
        camera.position.copy(cameraFocus).addScaledVector(cameraDirection, cameraDistance);
        camera.lookAt(cameraFocus);
        updateCameraOcclusion(playerAnchor, delta);

        if (now - lastHudUpdate > 120) {
          setPhase(latestState.phase);
          setPlayerMode(latestState.player.mode);
          setChaserMode(latestState.chaser.mode);
          setChaserConfirming(latestState.chaser.visualConfirmationSeconds !== null);
          setChaserObservable(chaserKnowledgeObservable);
          setElapsed(Math.floor(latestState.elapsedSeconds));
          setObjectiveDistance(objectiveDistanceMeters(latestState.player.position));
          setInteraction(simulation.getHideInteraction());
          lastHudUpdate = now;
        }
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      commands.current.adjustZoom(Math.exp(event.deltaY * 0.00065));
    };
    host.addEventListener("wheel", wheel, { passive: false });

    const projectActorToViewport = (view: ActorView | undefined) => {
      if (!view) return null;
      camera.updateMatrixWorld();
      const projected = view.root.position.clone().add(new THREE.Vector3(0, 0.92, 0)).project(camera);
      return {
        x: (projected.x + 1) / 2,
        y: (1 - projected.y) / 2,
        depth: projected.z,
        centerInFrustum: Math.abs(projected.x) <= 1
          && Math.abs(projected.y) <= 1
          && projected.z >= -1
          && projected.z <= 1,
      };
    };

    const qaWindow = window as typeof window & {
      __CHASING_QA__?: {
        getState: () => unknown;
        start: () => void;
        interact: () => void;
        setScenario: (positions: { player: Point; chaser: Point }) => void;
      };
    };
    if (new URLSearchParams(location.search).has("qa")) {
      qaWindow.__CHASING_QA__ = {
        getState: () => ({
          ready,
          game: latestState,
          interaction: simulation.getHideInteraction(),
          animations: Object.fromEntries(Object.entries(actors).map(([name, view]) => [name, view?.animator.snapshot()])),
          visibility: Object.fromEntries(Object.entries(actors).map(([name, view]) => [name, {
            rootVisible: view?.root.visible ?? false,
            alpha: view?.visibilityAlpha ?? 0,
            worldRendered: name === "villain"
              ? shouldRenderChaserModel(
                latestState.phase,
                latestState.phase !== "playing"
                  || isPlayerVisuallyExposed(latestState.player, simulation.config),
              )
              : undefined,
            viewport: projectActorToViewport(view),
          }])),
          knowledge: { chaserObservable: canPlayerObserveChaser(latestState) },
          lockers: Object.fromEntries([...lockers].map(([id, view]) => [id, {
            action: view.actionName,
            peeking: view.peeking,
            peekClosing: view.peekClosing,
            holdFinal: view.holdFinal,
            delayRemaining: view.delayRemaining,
            owner: view.owner,
          }])),
          audio: score.getSnapshot(),
          camera: {
            fov: camera.fov,
            aspect: camera.aspect,
            distance: cameraDistance,
            zoom: cameraZoom.value,
            position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
            focus: { x: cameraFocus.x, y: cameraFocus.y, z: cameraFocus.z },
            direction: { x: cameraDirection.x, y: cameraDirection.y, z: cameraDirection.z },
            azimuthDegrees: THREE.MathUtils.radToDeg(Math.atan2(cameraDirection.x, cameraDirection.z)),
            occlusion: {
              groups: cameraOccluders.length,
              obscured: cameraOccluders.filter((occluder) => occluder.obscured).map((occluder) => occluder.name),
              maxStrength: Math.max(0, ...cameraOccluders.map((occluder) => occluder.strength.value)),
            },
          },
          render: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
        }),
        start: beginGame,
        interact: () => { interactPressed.current = true; },
        setScenario: ({ player, chaser }) => {
          simulation = new GameSimulation({
            autoStart: true,
            initialPlayerPosition: player,
            initialChaserPosition: chaser,
            config: { spawnDelaySeconds: 0, hideEnterSeconds: HIDE_ENTER_SECONDS, hideExitSeconds: HIDE_EXIT_SECONDS, checkHideSeconds: HIDE_CHECK_SECONDS },
          });
          latestState = simulation.getState();
          resetPresentation(latestState);
        },
      };
    }

    void loadAll().catch((error: unknown) => {
      console.error("Production asset load failed", error);
      if (!disposed) {
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(`正式素材载入失败：${message}`);
      }
    });
    frame = requestAnimationFrame(animate);

    return () => {
      scorePrewarmAbort.abort();
      disposed = true;
      ready = false;
      commands.current = NOOP_COMMANDS;
      if (resultTimer) clearTimeout(resultTimer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", resetFrameClock);
      removeEventListener("pageshow", resetFrameClock);
      renderer.domElement.removeEventListener("webglcontextlost", handleContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", handleContextRestored);
      delete document.documentElement.dataset.chasingReady;
      if (qaWindow.__CHASING_QA__) delete qaWindow.__CHASING_QA__;
      for (const actor of Object.values(actors)) actor?.animator.dispose();
      for (const locker of lockers.values()) locker.mixer.stopAllAction();
      void score.dispose();
      environmentTarget.dispose();
      disposeObjectResources([scene]);
      renderer.renderLists.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, []);

  const touch = (key: string, active: boolean) => {
    if (active) touchKeys.current.add(key);
    else touchKeys.current.delete(key);
  };
  const loadPercent = Math.round((loadProgress.done / loadProgress.total) * 100);
  const danger = threatForMode(chaserMode);
  const displayedChaserStatus = chaserObservable
    ? chaserConfirming ? "重新确认目标" : chaserStatus(chaserMode)
    : "位置未确认";
  const showResult = phase === "ready" || ((phase === "won" || phase === "lost") && resultVisible);
  const interactionText = interaction?.kind === "enter"
    ? "躲进储物柜"
    : interaction?.kind === "exit"
      ? "离开储物柜"
      : playerMode === "entering-hide"
        ? "正在藏好…"
        : playerMode === "aligning-hide"
          ? "正在对齐柜门…"
        : playerMode === "entering-peek"
          ? "正在打开观察缝…"
          : playerMode === "exiting-peek"
            ? "正在关好柜门…"
        : playerMode === "exiting-hide"
          ? "正在离开…"
          : null;

  return (
    <main className="game-shell">
      <header className="hud">
        <div className="title-lockup">
          <span className="eyebrow">CHASING · 3D 追逐模式 · CINEMATIC WEB</span>
          <h1>逃出校园</h1>
        </div>
        <div className="stats">
          <span>用时 <b>{elapsed}s</b></span>
          <span className="objective">出口 <b>{objectiveDistance}m</b></span>
          <span className={`status danger-${Math.round(danger * 10)}`}><i />{displayedChaserStatus}</span>
          <button type="button" aria-label={musicMuted ? "打开音乐" : "静音"} onClick={() => commands.current.toggleMute()}>{musicMuted ? "音乐关" : "音乐开"}</button>
          <button type="button" disabled={loading} onClick={restart}>重新开始</button>
        </div>
      </header>

      <section className={`playfield threat-${chaserMode} mode-${playerMode}`} style={{ "--threat": danger } as React.CSSProperties}>
        <div className="three-mount" ref={mount} />
        <div className="cinematic-vignette" aria-hidden="true" />

        {loading && (
          <div className={`loading-card${loadError ? " error" : ""}`} role="status">
            <span className="loader-dot" />
            <div>
              <strong>{loadError || loadProgress.message}</strong>
              {!loadError && <div className="load-bar"><i style={{ width: `${loadPercent}%` }} /></div>}
              {!loadError && <small>正式高模、动作、灯光与互动资产 · {loadPercent}%</small>}
              {loadError && <button type="button" onClick={() => location.reload()}>刷新重试</button>}
            </div>
          </div>
        )}

        {!loading && phase === "playing" && chaserObservable && (
          <div className={`awareness awareness-${chaserMode}`} role="status">
            <span />
            <div><small>追捕者情报</small><strong>{displayedChaserStatus}</strong></div>
          </div>
        )}

        {!loading && phase === "playing" && !chaserObservable && (
          <div className="awareness awareness-unknown" role="status">
            <span />
            <div><small>追捕者情报</small><strong>位置未确认 · 留意音乐变化</strong></div>
          </div>
        )}

        {interactionText && phase === "playing" && (
          <div className="interaction-prompt">
            <kbd>E</kbd><strong>{interactionText}</strong>
            {(playerMode === "hidden" || playerMode === "entering-peek" || playerMode === "peeking" || playerMode === "exiting-peek") && <small>按住 Q 从门缝观察，会重新暴露；松开后再离柜</small>}
          </div>
        )}

        {showResult && !loading && (
          <div className={`overlay ${phase}`}>
            <div className="overlay-card">
              <span className={`result ${phase}`}>{phase === "won" ? "成功逃脱" : phase === "lost" ? "被抓住了" : "3D 潜逃演练"}</span>
              <h2>{phase === "won" ? "你抵达了有警察守护的出口" : phase === "lost" ? "利用遮挡和储物柜甩开追捕者" : "断开视线，藏好，再寻找逃生窗口"}</h2>
              <p>{phase === "ready" ? "追捕者只会追踪亲眼见到的位置。靠近蓝色储物柜按 E 躲藏；没被目击进柜时，他会失去视野并盲目搜索。" : "每次失败都可以换路线、切断视线或提前选择藏身处。"}</p>
              <button className="primary" type="button" onClick={begin}>{phase === "ready" ? "开始逃跑" : "再来一次"}<kbd>Enter</kbd></button>
            </div>
          </div>
        )}

        <div className="view-controls" aria-label="视野控制">
          <button type="button" onClick={() => commands.current.adjustZoom(1.12)} aria-label="缩小视野">−</button>
          <button type="button" onClick={() => commands.current.resetZoom()} aria-label="重置动态视野">视野</button>
          <button type="button" onClick={() => commands.current.adjustZoom(1 / 1.12)} aria-label="放大视野">＋</button>
        </div>

        {phase === "playing" && (
          <>
            <div className="controls" aria-label="移动控制">
              <button type="button" aria-label="向上" onPointerDown={() => touch("w", true)} onPointerUp={() => touch("w", false)} onPointerLeave={() => touch("w", false)} onPointerCancel={() => touch("w", false)}>↑</button>
              <button type="button" aria-label="向左" onPointerDown={() => touch("a", true)} onPointerUp={() => touch("a", false)} onPointerLeave={() => touch("a", false)} onPointerCancel={() => touch("a", false)}>←</button>
              <button type="button" aria-label="向下" onPointerDown={() => touch("s", true)} onPointerUp={() => touch("s", false)} onPointerLeave={() => touch("s", false)} onPointerCancel={() => touch("s", false)}>↓</button>
              <button type="button" aria-label="向右" onPointerDown={() => touch("d", true)} onPointerUp={() => touch("d", false)} onPointerLeave={() => touch("d", false)} onPointerCancel={() => touch("d", false)}>→</button>
            </div>
            <div className="action-controls">
              <button type="button" onClick={interact}>躲藏 / 离开</button>
              <button type="button" onPointerDown={() => touch("q", true)} onPointerUp={() => touch("q", false)} onPointerLeave={() => touch("q", false)} onPointerCancel={() => touch("q", false)}>按住观察</button>
            </div>
          </>
        )}
      </section>

      <footer>
        <span><i className="kid" />玩家</span>
        <span><i className="villain" />追捕者</span>
        <span><i className="safe" />可藏储物柜</span>
        <small>WASD / 方向键移动 · E 躲藏或离开 · Q 按住观察 · 滚轮动态调视野 · M 音乐 · R 重开</small>
      </footer>
    </main>
  );
}
