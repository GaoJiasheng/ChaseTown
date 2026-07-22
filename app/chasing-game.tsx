"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  CAMPAIGN_LEVELS,
  getCampaignGameplayConfig,
  type CampaignTheme,
} from "./game/campaign.ts";
import type { ChaserMode, GameConfig, GamePhase, GameState, LevelDefinition, PlayerMode, Point } from "./game/contracts.ts";
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
// ImageBitmap entries cannot safely outlive a disposed WebGL scene across
// campaign switches. Keep Three's global object cache disabled; the browser's
// HTTP cache still prevents retransfers and the scene pass below shares GPU
// texture references without retaining closed bitmap objects.
THREE.Cache.enabled = false;
THREE.Cache.clear();
const PLAYER_OBSERVATION_RANGE = 9;
const CAPTURE_STAGING_SECONDS = 0.26;
const MAX_CAMERA_DISTANCE = 44;
const LOCKER_PLAYBACK_RATE = 1.2;

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

const THEME_KIT_ASSETS: Readonly<Record<CampaignTheme, string>> = {
  campus: "/models/environment/themes/campus-kit.glb",
  hospital: "/models/environment/themes/hospital-kit.glb",
  "fire-station": "/models/environment/themes/fire-station-kit.glb",
  factory: "/models/environment/themes/factory-kit.glb",
};

type ThemePropSpec = { node: string; height: number };

const THEME_PROP_SPECS: Readonly<Record<CampaignTheme, readonly ThemePropSpec[]>> = {
  campus: [
    { node: "CampusTrophyCase", height: 1.9 },
    { node: "CampusVendingMachine", height: 1.95 },
    { node: "CampusWaterFountain", height: 1.18 },
    { node: "CampusBikeRack", height: 0.95 },
    { node: "CampusWayfinding", height: 2.25 },
  ],
  hospital: [
    { node: "HospitalBed", height: 1.15 },
    { node: "HospitalCrashCart", height: 1.65 },
    { node: "HospitalIVStation", height: 2.05 },
    { node: "HospitalWheelchair", height: 1.45 },
    { node: "HospitalPrivacyScreen", height: 1.9 },
    { node: "HospitalWayfinding", height: 2.25 },
  ],
  "fire-station": [
    { node: "FireEngine", height: 2.3 },
    { node: "FireGearRack", height: 2.15 },
    { node: "FireHoseReel", height: 1.8 },
    { node: "FireHydrant", height: 1.3 },
    { node: "FireStationWayfinding", height: 2.35 },
    { node: "FireSafetyCones", height: 0.82 },
  ],
  factory: [
    { node: "FactoryPipeAssembly", height: 2.25 },
    { node: "FactoryStorageTank", height: 2.55 },
    { node: "FactoryControlConsole", height: 1.55 },
    { node: "FactoryConveyor", height: 1.55 },
    { node: "FactorySafetyBarrier", height: 1.45 },
    { node: "FactoryCrateStack", height: 1.65 },
  ],
};

const THEME_WALL_NODES: Readonly<Record<CampaignTheme, string>> = {
  campus: "CampusArchitectureWall",
  hospital: "HospitalArchitectureWall",
  "fire-station": "FireArchitectureWall",
  factory: "FactoryArchitectureWall",
};

const LOCKER_CLIPS = [
  "Locker_Door_Open_Enter",
  "Locker_Door_Close_Enter",
  "Locker_Door_Open_Exit",
  "Locker_Door_Close_Exit",
  "Locker_Door_Check_Open",
  "Locker_Door_Check_Close",
] as const;

const TOTAL_ASSETS = Object.keys(ACTOR_SPECS).length + Object.keys(CORE_ASSETS).length + Object.keys(DETAIL_ASSETS).length + 1;

function world(point: Point, level: LevelDefinition) {
  return new THREE.Vector3(
    (point.x - (level.width - 1) / 2) * CELL,
    0,
    (point.y - (level.height - 1) / 2) * CELL,
  );
}

function createSightHazeTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建视线遮挡特效纹理");
  context.clearRect(0, 0, 128, 128);
  // Layered soft puffs keep the obstruction readable without looking like a
  // flat gameplay marker. The texture is shared by every authored haze cell.
  for (let index = 0; index < 9; index += 1) {
    const angle = index * 2.39996;
    const radius = index === 0 ? 0 : 9 + (index % 3) * 5;
    const x = 64 + Math.cos(angle) * radius;
    const y = 64 + Math.sin(angle) * radius * 0.72;
    const size = 35 - (index % 4) * 3;
    const gradient = context.createRadialGradient(x, y, 2, x, y, size);
    gradient.addColorStop(0, "rgba(255,255,255,0.34)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.16)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "Authored_Sight_Haze_Mask";
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
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

function objectiveDistanceMeters(point: Point, level: LevelDefinition, paths: GridPathPlanner) {
  const route = paths.path(point, level.exit);
  if (!route.length) return 0;
  return Math.round(Math.max(0, route.length - 1) * CELL);
}

function policeGuardPoint(level: LevelDefinition, paths: GridPathPlanner): Point {
  const route = paths.path(level.playerStart, level.exit);
  const inside = route[Math.max(0, route.length - 2)] ?? level.playerStart;
  return {
    x: THREE.MathUtils.lerp(level.exit.x, inside.x, 0.68),
    y: THREE.MathUtils.lerp(level.exit.y, inside.y, 0.68),
  };
}

function nearestExteriorDirection(point: Point, level: LevelDefinition): Point {
  const choices = [
    { distance: point.x, direction: { x: -1, y: 0 } },
    { distance: level.width - 1 - point.x, direction: { x: 1, y: 0 } },
    { distance: point.y, direction: { x: 0, y: -1 } },
    { distance: level.height - 1 - point.y, direction: { x: 0, y: 1 } },
  ];
  return choices.sort((a, b) => a.distance - b.distance)[0].direction;
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

function flattenStatic(root: THREE.Object3D, castShadow = false) {
  root.updateMatrixWorld(true);
  const flat = new THREE.Group();
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    if (Array.isArray(object.material) || Object.keys(object.geometry.morphAttributes).length > 0) {
      const mesh = new THREE.Mesh(object.geometry.clone().applyMatrix4(object.matrixWorld), object.material);
      mesh.castShadow = castShadow;
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
    mesh.castShadow = castShadow;
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

function fitProp(source: THREE.Object3D, height: number, castShadow = false) {
  const model = source.clone(true);
  tuneMeshes(model, { castShadow });
  const visual = new THREE.Group();
  visual.add(model);
  const initial = new THREE.Box3().setFromObject(visual);
  const size = initial.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(size.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  return flattenStatic(visual, castShadow);
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

function applyThemeSurface(
  root: THREE.Object3D,
  tint: THREE.ColorRepresentation,
  options: { blend?: number; emissive?: THREE.ColorRepresentation; emissiveIntensity?: number; roughnessShift?: number } = {},
) {
  const replacements = new Map<string, THREE.Material>();
  const tintColor = new THREE.Color(tint);
  const cloneMaterial = (source: THREE.Material) => {
    const existing = replacements.get(source.uuid);
    if (existing) return existing;
    const material = source.clone();
    if (material instanceof THREE.MeshStandardMaterial) {
      material.color.lerp(tintColor, options.blend ?? 0.58);
      material.roughness = THREE.MathUtils.clamp(material.roughness + (options.roughnessShift ?? 0), 0.16, 0.96);
      material.envMapIntensity = 1.2;
      if (material.normalMap) material.normalScale.multiplyScalar(1.18);
      if (options.emissive) {
        material.emissive.lerp(new THREE.Color(options.emissive), 0.24);
        material.emissiveIntensity = Math.max(material.emissiveIntensity, options.emissiveIntensity ?? 0.08);
      }
      material.needsUpdate = true;
    }
    replacements.set(source.uuid, material);
    return material;
  };
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneMaterial)
      : cloneMaterial(object.material);
  });
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
  // Authored modules often contain many material-labelled child meshes. Merge
  // children that share a material before instancing so richer architecture
  // does not multiply draw calls for every bevel, trim and bolt.
  const template = flattenStatic(fitModule(source, size), castShadow);
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
  playbackRate: number;
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

type CampaignProgress = {
  unlockedThrough: number;
  bestSeconds: Record<string, number>;
};

const CAMPAIGN_PROGRESS_KEY = "chasing.campaign-progress.v1";

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
  playbackRate = LOCKER_PLAYBACK_RATE,
) {
  view.queue = [...names];
  view.owner = owner;
  view.playbackRate = playbackRate;
  view.peeking = false;
  view.holdFinal = false;
  view.delayRemaining = 0;
  // When exit is requested during a peek, finish closing the partially-open
  // door before starting the authored exit performance. Starting Open_Exit at
  // time zero here would visibly snap the door back to its closed pose.
  if (view.peekClosing) return;
  view.peekClosing = false;
  const first = view.queue.shift();
  if (first) startLockerAction(view, first, view.playbackRate);
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
  playLockerSequence(view, ["Locker_Door_Check_Close"], "chaser", 1);
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
  view.playbackRate = 1;
  view.peeking = false;
  view.peekClosing = false;
  view.holdFinal = true;
  view.delayRemaining = Math.max(0, delaySeconds);
  if (delaySeconds > 0) {
    view.mixer.stopAllAction();
    view.action = null;
    view.actionName = null;
  } else startLockerAction(view, name, 1);
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
  view.playbackRate = LOCKER_PLAYBACK_RATE;
  view.peeking = active;
  view.queue = [];
  if (active) {
    view.delayRemaining = 0;
    view.holdFinal = false;
    if (view.actionName === "Locker_Door_Open_Enter" && view.action) {
      view.action.paused = false;
      view.action.timeScale = LOCKER_PLAYBACK_RATE;
      view.peekClosing = false;
      return;
    }
    view.peekClosing = false;
    startLockerAction(view, "Locker_Door_Open_Enter", LOCKER_PLAYBACK_RATE);
    return;
  }
  if (view.actionName === "Locker_Door_Open_Enter" && view.action) {
    view.action.paused = false;
    view.action.timeScale = -LOCKER_PLAYBACK_RATE;
    view.peekClosing = true;
  }
}

function updateLocker(view: LockerView, delta: number) {
  if (view.delayRemaining > 0) {
    view.delayRemaining = Math.max(0, view.delayRemaining - delta);
    if (view.delayRemaining > 0) return;
    const delayed = view.queue.shift();
    if (delayed) startLockerAction(view, delayed, view.playbackRate);
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
    if (next) startLockerAction(view, next, view.playbackRate);
    else view.owner = "idle";
    return;
  }
  if (action.isRunning()) return;
  if (view.holdFinal) return;
  const next = view.queue.shift();
  if (next) startLockerAction(view, next, view.playbackRate);
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

type TextureDeduplication = {
  sourceTextures: number;
  canonicalTextures: number;
  assignmentsShared: number;
};

function deduplicateAssetTextures(assets: Iterable<GLTF>): TextureDeduplication {
  const canonical = new Map<string, THREE.Texture>();
  const sourceTextures = new Set<THREE.Texture>();
  let assignmentsShared = 0;

  for (const asset of assets) {
    asset.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const record = material as unknown as Record<string, unknown>;
        for (const [slot, value] of Object.entries(record)) {
          if (!(value instanceof THREE.Texture)) continue;
          sourceTextures.add(value);
          const image = value.image as { width?: number; height?: number; src?: string; currentSrc?: string } | undefined;
          const sourceName = value.name || image?.currentSrc || image?.src;
          // ImageBitmap deliberately omits a URL. GLTFLoader still assigns
          // the source filename to Texture.name; skip unnamed procedural maps
          // rather than risk merging unrelated art.
          if (!sourceName) continue;
          const key = [
            slot,
            sourceName,
            image?.width ?? 0,
            image?.height ?? 0,
            value.colorSpace,
            value.channel,
            value.mapping,
            value.wrapS,
            value.wrapT,
            value.flipY,
            value.repeat.x,
            value.repeat.y,
            value.offset.x,
            value.offset.y,
            value.center.x,
            value.center.y,
            value.rotation,
          ].join("|");
          const shared = canonical.get(key);
          if (!shared) {
            canonical.set(key, value);
            continue;
          }
          if (shared === value) continue;
          record[slot] = shared;
          assignmentsShared += 1;
        }
      }
    });
  }

  return {
    sourceTextures: sourceTextures.size,
    canonicalTextures: canonical.size,
    assignmentsShared,
  };
}

function countSceneTextures(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  return textures.size;
}

function findInvalidSceneTextures(root: THREE.Object3D) {
  const invalid = new Map<string, { texture: string; slot: string; material: string }>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const [slot, value] of Object.entries(material)) {
        if (!(value instanceof THREE.Texture) || value.image) continue;
        invalid.set(value.uuid, { texture: value.name || value.uuid, slot, material: material.name || material.type });
      }
    }
  });
  return [...invalid.values()];
}

function disposeObjectResources(roots: Iterable<THREE.Object3D>) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line)) return;
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

function playerPresentationPoint(
  state: GameState,
  level: LevelDefinition,
  config: Pick<GameConfig, "hideEnterSeconds" | "hideExitSeconds">,
) {
  const spot = state.player.hideSpotId
    ? level.hideSpots.find((candidate) => candidate.id === state.player.hideSpotId)
    : undefined;
  if (!spot) return state.player.position;
  if (state.player.mode === "aligning-hide") return state.player.position;
  if (state.player.mode === "entering-hide") {
    const progress = 1 - state.player.transitionRemainingSeconds / config.hideEnterSeconds;
    const travel = THREE.MathUtils.smoothstep(progress, 0.2, 0.72);
    return {
      x: THREE.MathUtils.lerp(spot.approach.x, spot.concealed.x, travel),
      y: THREE.MathUtils.lerp(spot.approach.y, spot.concealed.y, travel),
    };
  }
  if (state.player.mode === "exiting-hide") {
    const progress = 1 - state.player.transitionRemainingSeconds / config.hideExitSeconds;
    const travel = THREE.MathUtils.smoothstep(progress, 0.2, 0.75);
    return {
      x: THREE.MathUtils.lerp(spot.concealed.x, spot.approach.x, travel),
      y: THREE.MathUtils.lerp(spot.concealed.y, spot.approach.y, travel),
    };
  }
  if (["hidden", "entering-peek", "peeking", "exiting-peek"].includes(state.player.mode)) return spot.concealed;
  return state.player.position;
}

function canPlayerObserveChaser(state: GameState, level: LevelDefinition, config: GameConfig) {
  if (state.phase === "won") return false;
  if (state.phase === "lost" || state.phase === "ready") return true;
  if (!isPlayerVisuallyExposed(state.player, config)) return false;
  return distanceBetween(state.player.position, state.chaser.position) <= PLAYER_OBSERVATION_RANGE
    && hasLineOfSight(level, state.player.position, state.chaser.position);
}

export function ChasingGame() {
  const mount = useRef<HTMLDivElement>(null);
  const keyboardKeys = useRef(new Set<string>());
  const touchKeys = useRef(new Set<string>());
  const interactPressed = useRef(false);
  const commands = useRef<GameCommands>(NOOP_COMMANDS);
  const [selectedLevelIndex, setSelectedLevelIndex] = useState(0);
  const campaignLevel = CAMPAIGN_LEVELS[selectedLevelIndex];
  const objectivePaths = useMemo(() => new GridPathPlanner(campaignLevel), [campaignLevel]);
  const gameplayConfig = useMemo(() => getCampaignGameplayConfig(campaignLevel), [campaignLevel]);
  const [campaignProgress, setCampaignProgress] = useState<CampaignProgress>({
    unlockedThrough: 1,
    bestSeconds: {},
  });
  const campaignProgressRef = useRef(campaignProgress);
  const chooseLevelRef = useRef<(index: number) => void>(() => {});
  const [phase, setPhase] = useState<GamePhase>("ready");
  const [playerMode, setPlayerMode] = useState<PlayerMode>("free");
  const [chaserMode, setChaserMode] = useState<ChaserMode>("spawn-delay");
  const [chaserConfirming, setChaserConfirming] = useState(false);
  const [chaserObservable, setChaserObservable] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [objectiveDistance, setObjectiveDistance] = useState(
    objectiveDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths),
  );
  const [interaction, setInteraction] = useState<HideInteraction | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: TOTAL_ASSETS, message: "正在载入项目美术资产：角色、校园与互动道具…" });
  const [resultVisible, setResultVisible] = useState(true);
  const [musicMuted, setMusicMuted] = useState(false);

  useEffect(() => {
    let active = true;
    try {
      const stored = JSON.parse(localStorage.getItem(CAMPAIGN_PROGRESS_KEY) ?? "null") as Partial<CampaignProgress> | null;
      if (!stored) return;
      const unlockedThrough = THREE.MathUtils.clamp(
        Number.isInteger(stored.unlockedThrough) ? stored.unlockedThrough! : 1,
        1,
        CAMPAIGN_LEVELS.length,
      );
      const bestSeconds = Object.fromEntries(
        Object.entries(stored.bestSeconds ?? {}).filter(([id, value]) => (
          CAMPAIGN_LEVELS.some((level) => level.id === id)
          && Number.isFinite(value)
          && value > 0
        )),
      ) as Record<string, number>;
      queueMicrotask(() => {
        if (active) setCampaignProgress({ unlockedThrough, bestSeconds });
      });
    } catch {
      // A corrupt or unavailable store must never block the first chapter.
    }
    return () => { active = false; };
  }, []);

  useEffect(() => {
    campaignProgressRef.current = campaignProgress;
  }, [campaignProgress]);

  const begin = useCallback(() => commands.current.begin(), []);
  const restart = useCallback(() => commands.current.restart(), []);
  const interact = useCallback(() => commands.current.interact(), []);
  const chooseLevel = useCallback((index: number) => {
    if (index < 0 || index >= CAMPAIGN_LEVELS.length) return;
    const qaBypass = typeof location !== "undefined" && new URLSearchParams(location.search).has("qa");
    if (!qaBypass && index + 1 > campaignProgress.unlockedThrough) return;
    // Re-selecting the active chapter must be a no-op. Setting loading here
    // without changing selectedLevelIndex would leave the overlay stuck,
    // because the scene effect correctly has nothing to rebuild.
    if (index === selectedLevelIndex) return;
    setLoading(true);
    setLoadError("");
    setLoadProgress({ done: 0, total: TOTAL_ASSETS, message: "正在切换主题关卡与高精度环境…" });
    setSelectedLevelIndex(index);
  }, [campaignProgress.unlockedThrough, selectedLevelIndex]);

  useEffect(() => {
    chooseLevelRef.current = chooseLevel;
  }, [chooseLevel]);

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
      else if ((key === "enter" || key === " ") && phase !== "playing") {
        if (phase === "won" && selectedLevelIndex < CAMPAIGN_LEVELS.length - 1) chooseLevel(selectedLevelIndex + 1);
        else commands.current.begin();
      }
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
  }, [chooseLevel, phase, selectedLevelIndex]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;

    setLoading(true);
    setLoadError("");
    setLoadProgress({
      done: 0,
      total: TOTAL_ASSETS,
      message: `正在载入第 ${campaignLevel.campaign.levelNumber} 关 · ${campaignLevel.campaign.themeLabel}高精度场景…`,
    });
    setPhase("ready");
    setPlayerMode("free");
    setChaserMode("spawn-delay");
    setElapsed(0);
    setObjectiveDistance(objectiveDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths));

    const scorePrewarmAbort = new AbortController();
    void prewarmAdaptiveScoreAssets(undefined, scorePrewarmAbort.signal);
    let disposed = false;
    let frame = 0;
    let last = performance.now();
    let lastHudUpdate = 0;
    let ready = false;
    let textureDeduplication: TextureDeduplication = {
      sourceTextures: 0,
      canonicalTextures: 0,
      assignmentsShared: 0,
    };
    let cameraDistance = 16.25;
    let resultTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCheckSpot: string | null = null;
    let lastScoreThreat = Number.NaN;
    let captureStageRemaining = 0;
    let capturePerformanceStarted = false;
    let simulation = new GameSimulation({ level: campaignLevel, config: gameplayConfig });
    let latestState = simulation.getState();
    const resetFrameClock = () => {
      if (document.visibilityState === "visible") last = performance.now();
    };
    const cameraZoom = { value: 1 };
    const actors: Partial<Record<ActorName, ActorView>> = {};
    const lockers = new Map<string, LockerView>();
    const sightObscurers: THREE.Points[] = [];
    let renderedMovementBlockers = 0;
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
    scene.background = new THREE.Color(campaignLevel.campaign.palette.sky);
    scene.fog = new THREE.FogExp2(
      campaignLevel.campaign.palette.fog,
      campaignLevel.campaign.theme === "fire-station" ? 0.022 : campaignLevel.campaign.theme === "factory" ? 0.02 : 0.0165,
    );
    const camera = new THREE.PerspectiveCamera(56, 1, 0.08, 150);
    const cameraDirection = createFixedCameraDirection();
    const cameraFocus = world(campaignLevel.playerStart, campaignLevel).add(new THREE.Vector3(0, 0.92, 0));
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
    renderer.toneMappingExposure = campaignLevel.campaign.theme === "hospital" ? 1.06 : campaignLevel.campaign.theme === "factory" ? 0.98 : 1.02;
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

    scene.add(new THREE.HemisphereLight(
      new THREE.Color(campaignLevel.campaign.palette.sky).offsetHSL(0, 0, 0.25),
      new THREE.Color(campaignLevel.campaign.palette.floor).multiplyScalar(0.34),
      campaignLevel.campaign.theme === "hospital" ? 0.92 : 0.76,
    ));
    const moon = new THREE.DirectionalLight(
      campaignLevel.campaign.theme === "factory" ? 0x91dced : 0xb9d7ff,
      campaignLevel.campaign.theme === "hospital" ? 2.8 : 2.58,
    );
    moon.position.set(14, 28, 18);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -32;
    moon.shadow.camera.right = 32;
    moon.shadow.camera.top = 32;
    moon.shadow.camera.bottom = -32;
    moon.shadow.bias = -0.00025;
    scene.add(moon);
    const warmBounce = new THREE.DirectionalLight(campaignLevel.campaign.palette.emissive, 0.62);
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
      if (next === "won") {
        setCampaignProgress((current) => {
          const previousBest = current.bestSeconds[campaignLevel.id];
          const completedSeconds = Math.max(1, Math.floor(latestState.elapsedSeconds));
          const updated: CampaignProgress = {
            unlockedThrough: Math.max(
              current.unlockedThrough,
              Math.min(CAMPAIGN_LEVELS.length, campaignLevel.campaign.levelNumber + 1),
            ),
            bestSeconds: {
              ...current.bestSeconds,
              [campaignLevel.id]: previousBest ? Math.min(previousBest, completedSeconds) : completedSeconds,
            },
          };
          try {
            localStorage.setItem(CAMPAIGN_PROGRESS_KEY, JSON.stringify(updated));
          } catch {
            // Progress still works for this session if persistence is denied.
          }
          return updated;
        });
      }
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
      setChaserObservable(canPlayerObserveChaser(state, campaignLevel, simulation.config));
      setElapsed(Math.floor(state.elapsedSeconds));
      setObjectiveDistance(objectiveDistanceMeters(state.player.position, campaignLevel, objectivePaths));
      setInteraction(simulation.getHideInteraction());
      updateLockerVisionStyle(state);

      const resetActor = (view: ActorView | undefined, point: Point, heading: Point) => {
        if (!view) return;
        view.root.position.copy(world(point, campaignLevel));
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
      resetActor(actors.police, policeGuardPoint(campaignLevel, objectivePaths), nearestExteriorDirection(campaignLevel.exit, campaignLevel));

      cameraFocus.copy(world(state.player.position, campaignLevel)).add(new THREE.Vector3(0, 0.92, 0));
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
        locker.playbackRate = LOCKER_PLAYBACK_RATE;
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
      let themeKitAsset: GLTF | undefined;
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
          mark(name === "locker" ? "英雄储物柜与门动画" : "共享场景细节");
        }),
        (async () => {
          themeKitAsset = await loader.loadAsync(THEME_KIT_ASSETS[campaignLevel.campaign.theme]);
          mark(`${campaignLevel.campaign.themeLabel}高精度主题模型`);
        })(),
      ];
      const settled = await Promise.allSettled(loads);
      const loadedAssets = [
        ...Object.values(actorAssets),
        ...Object.values(coreAssets),
        ...Object.values(detailAssets),
        ...(themeKitAsset ? [themeKitAsset] : []),
      ];
      const rejection = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (disposed || rejection) {
        disposeObjectResources(loadedAssets.map((asset) => asset.scene));
        if (rejection) throw rejection.reason;
        return;
      }

      if (!themeKitAsset) throw new Error(`${campaignLevel.campaign.themeLabel}主题模型未载入`);
      textureDeduplication = deduplicateAssetTextures(loadedAssets);
      buildCampus(coreAssets, themeKitAsset, campus);
      buildDetails(detailAssets, themeKitAsset, campus, scene, lockers);
      placeActors(actorAssets, actors, scene);
      ready = true;
      setLoading(false);
      setLoadError("");
      document.documentElement.dataset.chasingReady = "true";
      if (new URLSearchParams(location.search).get("autostart") === "1") beginGame();
    };

    const buildCampus = (assets: Record<CoreAssetName, GLTF>, themeKit: GLTF, parent: THREE.Group) => {
      const { palette, theme } = campaignLevel.campaign;
      applyThemeSurface(assets.wall.scene, palette.wall, { blend: 0.34, emissive: palette.emissive, emissiveIntensity: 0.035 });
      applyThemeSurface(assets.wallCorner.scene, palette.wall, { blend: 0.34, emissive: palette.emissive, emissiveIntensity: 0.035 });
      applyThemeSurface(assets.wallEnd.scene, palette.trim, { blend: 0.46, emissive: palette.emissive, emissiveIntensity: 0.045 });
      applyThemeSurface(assets.floor.scene, palette.floor, { blend: 0.54, roughnessShift: theme === "hospital" ? -0.12 : 0.02 });
      applyThemeSurface(assets.classroomFloor.scene, palette.floor, { blend: 0.42, roughnessShift: theme === "hospital" ? -0.1 : 0 });
      applyThemeSurface(assets.playgroundFloor.scene, palette.trim, { blend: 0.44, roughnessShift: 0.04 });
      applyThemeSurface(assets.grassFloor.scene, theme === "campus" ? palette.floor : palette.trim, { blend: 0.45, roughnessShift: 0.08 });
      const floorBatches: Record<"floor" | "grassFloor" | "classroomFloor" | "playgroundFloor", ModulePlacement[]> = {
        floor: [], grassFloor: [], classroomFloor: [], playgroundFloor: [],
      };
      const wallBatches: Record<"wall" | "wallCorner" | "wallEnd", ModulePlacement[]> = {
        wall: [], wallCorner: [], wallEnd: [],
      };
      const groundMarginCells = 7;
      const directions = [
        { dx: 0, dy: -1, ox: 0, oz: -CELL / 2, rotation: 0 },
        { dx: 0, dy: 1, ox: 0, oz: CELL / 2, rotation: 0 },
        { dx: -1, dy: 0, ox: -CELL / 2, oz: 0, rotation: Math.PI / 2 },
        { dx: 1, dy: 0, ox: CELL / 2, oz: 0, rotation: Math.PI / 2 },
      ] as const;
      for (let y = 0; y < campaignLevel.height; y += 1) {
        for (let x = 0; x < campaignLevel.width; x += 1) {
          const position = world({ x, y }, campaignLevel);
          if (!campaignLevel.walkable[y][x]) {
            continue;
          }
          // Material changes happen in authored-looking room bands, not on
          // individual cells; this keeps corridors continuous and avoids a
          // procedural checkerboard in the elevated gameplay camera.
          const pattern = (
            Math.floor(x / 6)
            + Math.floor(y / 6) * 3
            + campaignLevel.campaign.levelNumber
          ) % 9;
          const floorName = theme === "campus"
            ? pattern <= 1 ? "classroomFloor" : pattern === 2 ? "playgroundFloor" : "floor"
            : theme === "hospital"
              ? "floor"
              : theme === "fire-station"
                ? pattern <= 3 ? "playgroundFloor" : "floor"
                : pattern <= 4 ? "playgroundFloor" : pattern === 5 ? "classroomFloor" : "floor";
          floorBatches[floorName].push({ position, rotation: 0 });
          const blocked = directions.filter(({ dx, dy }) => !campaignLevel.walkable[y + dy]?.[x + dx]);
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
      const wallHeight = theme === "hospital" ? 2.2 : theme === "factory" ? 2.16 : 2.1;
      const architectureWall = themeKit.scene.getObjectByName(THEME_WALL_NODES[theme]);
      if (!architectureWall) throw new Error(`${campaignLevel.campaign.themeLabel}建筑墙体模型缺失`);
      const wallMeshes = [
        ...addInstancedModules(architectureWall, new THREE.Vector3(CELL + 0.08, wallHeight, 0.23), wallBatches.wall, parent, true),
        ...addInstancedModules(architectureWall, new THREE.Vector3(CELL + 0.08, wallHeight, 0.23), wallBatches.wallEnd, parent, true),
        ...addInstancedModules(assets.wallCorner.scene, new THREE.Vector3(0.32, wallHeight, 0.32), wallBatches.wallCorner, parent, true),
      ];
      registerCameraOccluder("campus-walls", wallMeshes);
      addInstancedModules(assets.floor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.floor, parent, false);
      addInstancedModules(assets.grassFloor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.grassFloor, parent, false);
      addInstancedModules(assets.classroomFloor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.classroomFloor, parent, false);
      addInstancedModules(assets.playgroundFloor.scene, new THREE.Vector3(CELL, 0.12, CELL), floorBatches.playgroundFloor, parent, false);
      const groundAsset = theme === "campus" ? assets.grassFloor : theme === "hospital" ? assets.floor : assets.playgroundFloor;
      let groundMaterial: THREE.MeshStandardMaterial | undefined;
      groundAsset.scene.traverse((object) => {
        if (groundMaterial || !(object instanceof THREE.Mesh)) return;
        const source = Array.isArray(object.material) ? object.material[0] : object.material;
        if (source instanceof THREE.MeshStandardMaterial) groundMaterial = source.clone();
      });
      if (!groundMaterial) throw new Error(`${campaignLevel.campaign.themeLabel}地表材质缺失`);
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"] as const) {
        const texture = groundMaterial[key];
        if (!texture) continue;
        const repeated = texture.clone();
        repeated.wrapS = THREE.RepeatWrapping;
        repeated.wrapT = THREE.RepeatWrapping;
        repeated.repeat.set(campaignLevel.width + groundMarginCells * 2, campaignLevel.height + groundMarginCells * 2);
        repeated.needsUpdate = true;
        groundMaterial[key] = repeated;
      }
      groundMaterial.roughness = theme === "hospital" ? 0.34 : theme === "campus" ? 0.78 : 0.62;
      const groundGeometry = new THREE.PlaneGeometry(
        (campaignLevel.width + groundMarginCells * 2) * CELL,
        (campaignLevel.height + groundMarginCells * 2) * CELL,
      );
      const ground = new THREE.Mesh(groundGeometry, groundMaterial);
      ground.name = `${theme}-continuous-ground`;
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.13;
      ground.receiveShadow = true;
      parent.add(ground);

      const gate = fitModule(assets.frontGate.scene, new THREE.Vector3(1.9, 2.55, 0.42));
      applyThemeSurface(gate, palette.accent, { blend: 0.48, emissive: palette.emissive, emissiveIntensity: 0.09 });
      const entranceDirection = nearestExteriorDirection(campaignLevel.playerStart, campaignLevel);
      gate.rotation.y = Math.abs(entranceDirection.x) > 0 ? Math.PI / 2 : 0;
      gate.position.add(world(campaignLevel.playerStart, campaignLevel)).add(new THREE.Vector3(
        entranceDirection.x * CELL * 0.5,
        0,
        entranceDirection.y * CELL * 0.5,
      ));
      parent.add(gate);
      registerCameraOccluder("front-gate", [gate]);
      const exitDoor = fitModule(assets.exit.scene, new THREE.Vector3(1.9, 2.55, 0.42));
      const exitDirection = nearestExteriorDirection(campaignLevel.exit, campaignLevel);
      exitDoor.rotation.y = Math.abs(exitDirection.x) > 0 ? Math.PI / 2 : 0;
      exitDoor.position.add(world(campaignLevel.exit, campaignLevel)).add(new THREE.Vector3(
        exitDirection.x * CELL * 0.5,
        0,
        exitDirection.y * CELL * 0.5,
      ));
      exitDoor.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
        object.material = object.material.clone();
        object.material.emissive.set(0x1f8a63);
        object.material.emissiveIntensity = 0.45;
      });
      parent.add(exitDoor);
      registerCameraOccluder("exit-door", [exitDoor]);
      const exitLight = new THREE.SpotLight(0x83ffc0, 28, 11, Math.PI / 5, 0.52, 1.6);
      exitLight.color.set(palette.emissive);
      exitLight.position.copy(world(campaignLevel.exit, campaignLevel)).add(new THREE.Vector3(0, 5.2, 0));
      exitLight.target.position.copy(world(campaignLevel.exit, campaignLevel));
      parent.add(exitLight, exitLight.target);
    };

    const buildDetails = (
      assets: Record<DetailAssetName, GLTF>,
      themeKit: GLTF,
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
        object.position.add(world(point, campaignLevel)).add(offset);
        object.rotation.y = rotation;
        parent.add(object);
        if (cameraOccludingProps.has(name)) {
          registerCameraOccluder(`${name}-${point.x}-${point.y}`, [object]);
        }
        return object;
      };
      const addThemeProp = (spec: ThemePropSpec, point: Point, rotation = 0) => {
        const source = themeKit.scene.getObjectByName(spec.node);
        if (!source) throw new Error(`${campaignLevel.campaign.themeLabel}主题模型缺少节点 ${spec.node}`);
        const key = `theme:${spec.node}:${spec.height}`;
        const template = propTemplates.get(key) ?? fitProp(source, spec.height, true);
        propTemplates.set(key, template);
        const object = template.clone(true);
        object.name = `theme-prop-${spec.node}`;
        object.position.add(world(point, campaignLevel));
        object.rotation.y = rotation;
        parent.add(object);
        registerCameraOccluder(`${spec.node}-${point.x}-${point.y}`, [object]);
      };

      const lockerSource = assets.locker;
      const clipMap = new Map(lockerSource.animations.map((clip) => [clip.name, clip]));
      const missingLockerClips = LOCKER_CLIPS.filter((name) => !clipMap.has(name));
      if (missingLockerClips.length) throw new Error(`Hero locker animation contract failed: ${missingLockerClips.join(", ")}`);
      for (const spot of campaignLevel.hideSpots) {
        const root = fitInteractiveProp(lockerSource.scene, 2.12);
        applyThemeSurface(root, campaignLevel.campaign.palette.accent, {
          blend: 0.22,
          emissive: campaignLevel.campaign.palette.emissive,
          emissiveIntensity: 0.055,
        });
        root.name = `hero-locker-${spot.id}`;
        root.rotation.y = Math.atan2(spot.facing.x, spot.facing.y);
        root.position.copy(world(spot.concealed, campaignLevel));
        root.updateMatrixWorld(true);
        const anchor = root.getObjectByName("HideAnchor");
        const pivot = root.getObjectByName("DoorPivot");
        if (!anchor || !pivot) throw new Error("Hero locker is missing HideAnchor or DoorPivot; refusing an art fallback");
        const anchorWorld = anchor.getWorldPosition(new THREE.Vector3());
        root.position.add(world(spot.concealed, campaignLevel).sub(anchorWorld));
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
          playbackRate: LOCKER_PLAYBACK_RATE,
          owner: "idle",
        };
        lockerViews.set(spot.id, view);
      }

      // The original school layout deliberately reserves seven path cells for
      // solid hero props. Keep presentation and collision authored from the
      // same ordered contract so the player never hits an invisible blocker.
      const movementPropContract: readonly [DetailAssetName, number, number][] = [
        ["bench", 1.05, 0],
        ["tree", 3.9, 0.35],
        ["shrub", 0.9, -0.2],
        ["car", 1.55, Math.PI / 2],
        ["basketball", 2.65, 0],
        ["deskChair", 1.2, 0.58],
        ["podium", 1.1, -0.25],
      ];
      for (const [index, point] of (campaignLevel.movementBlockers ?? []).entries()) {
        const spec = movementPropContract[index];
        if (!spec) throw new Error(`${campaignLevel.id} 缺少第 ${index + 1} 个实体障碍美术契约`);
        const object = addProp(spec[0], point, spec[1], spec[2]);
        object.name = `movement-blocker-${index + 1}-${spec[0]}`;
        renderedMovementBlockers += 1;
      }

      // Vision-only cells represent permeable dust/steam/smoke rather than a
      // physical wall. A player can cross them, but both the level logic and
      // the rendered VFX now communicate why the pursuer loses sight.
      const hazePoints = campaignLevel.visionOnlyBlockers ?? [];
      if (hazePoints.length) {
        const hazeTexture = createSightHazeTexture();
        const hazeMaterial = new THREE.PointsMaterial({
          map: hazeTexture,
          color: new THREE.Color(campaignLevel.campaign.palette.fog).lerp(
            new THREE.Color(campaignLevel.campaign.palette.emissive),
            campaignLevel.campaign.theme === "fire-station" ? 0.18 : 0.34,
          ),
          transparent: true,
          opacity: campaignLevel.campaign.theme === "factory" ? 0.42 : 0.34,
          depthWrite: false,
          alphaTest: 0.012,
          size: campaignLevel.campaign.theme === "fire-station" ? 1.46 : 1.28,
          sizeAttenuation: true,
        });
        hazePoints.forEach((point, blockerIndex) => {
          const positions: number[] = [];
          for (let particle = 0; particle < 34; particle += 1) {
            const seed = blockerIndex * 43 + particle + campaignLevel.campaign.levelNumber * 97;
            const angle = seed * 2.39996;
            const radius = 0.14 + ((seed * 37) % 19) / 19 * 0.78;
            positions.push(
              Math.cos(angle) * radius,
              0.28 + ((seed * 17) % 31) / 31 * 1.92,
              Math.sin(angle) * radius,
            );
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
          geometry.computeBoundingSphere();
          const cloud = new THREE.Points(geometry, hazeMaterial);
          cloud.name = `vision-obscurer-${blockerIndex + 1}`;
          cloud.position.copy(world(point, campaignLevel));
          cloud.userData.baseY = cloud.position.y;
          cloud.userData.phase = blockerIndex * 1.73;
          cloud.renderOrder = 2;
          parent.add(cloud);
          sightObscurers.push(cloud);
        });
      }

      const occupiedAnchors = [
        campaignLevel.playerStart,
        campaignLevel.chaserStart,
        campaignLevel.exit,
        ...campaignLevel.hideSpots.flatMap((spot) => [spot.approach, spot.concealed]),
      ];
      const decorCandidates: Point[] = [];
      for (let y = 1; y < campaignLevel.height - 1; y += 1) {
        for (let x = 1; x < campaignLevel.width - 1; x += 1) {
          if (campaignLevel.walkable[y][x]) continue;
          const adjacentPath = [
            campaignLevel.walkable[y - 1]?.[x],
            campaignLevel.walkable[y + 1]?.[x],
            campaignLevel.walkable[y]?.[x - 1],
            campaignLevel.walkable[y]?.[x + 1],
          ].filter(Boolean).length;
          if (!adjacentPath) continue;
          const candidate = { x, y };
          if (occupiedAnchors.some((anchor) => distanceBetween(anchor, candidate) < 1.35)) continue;
          decorCandidates.push(candidate);
        }
      }
      decorCandidates.sort((a, b) => {
        const hash = (point: Point) => (point.x * 37 + point.y * 61 + campaignLevel.campaign.levelNumber * 17) % 101;
        return hash(a) - hash(b);
      });
      const decorPoints: Point[] = [];
      for (const candidate of decorCandidates) {
        if (decorPoints.every((existing) => distanceBetween(existing, candidate) >= 3.2)) decorPoints.push(candidate);
        if (decorPoints.length >= 14) break;
      }

      const exteriorPoint = (anchor: Point, distance: number, side: number): Point => {
        const direction = nearestExteriorDirection(anchor, campaignLevel);
        const perpendicular = { x: -direction.y, y: direction.x };
        return {
          x: anchor.x + direction.x * distance + perpendicular.x * side,
          y: anchor.y + direction.y * distance + perpendicular.y * side,
        };
      };
      const pushIntoScenery = (candidate: Point): Point => {
        let x = 0;
        let y = 0;
        for (const direction of [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }]) {
          if (campaignLevel.walkable[Math.round(candidate.y + direction.y)]?.[Math.round(candidate.x + direction.x)]) {
            x -= direction.x;
            y -= direction.y;
          }
        }
        const length = Math.hypot(x, y) || 1;
        return { x: candidate.x + x / length * 0.72, y: candidate.y + y / length * 0.72 };
      };
      const themeSpecs = THEME_PROP_SPECS[campaignLevel.campaign.theme];
      themeSpecs.forEach((spec, index) => {
        const point = index === 0
          ? exteriorPoint(campaignLevel.playerStart, 2.35, 2.15)
          : index === 1
            ? exteriorPoint(campaignLevel.exit, 2.5, -1.8)
            : decorPoints[index - 2]
              ? pushIntoScenery(decorPoints[index - 2])
              : exteriorPoint(campaignLevel.playerStart, 3 + index, index - 2);
        addThemeProp(spec, point, (campaignLevel.campaign.levelNumber * 0.47 + index * 1.23) % (Math.PI * 2));
      });

      // Build a compact authored arrival vignette instead of leaving the
      // exterior camera side as an empty texture plane. Reusing two secondary
      // hero props keeps each theme unmistakable without bloating downloads.
      themeSpecs.slice(2, 4).forEach((spec, index) => {
        const point = exteriorPoint(
          campaignLevel.playerStart,
          3.15 + index * 0.9,
          -2.25 + index * 3.6,
        );
        addThemeProp(spec, point, (campaignLevel.campaign.levelNumber * 0.31 + index * 1.71 + Math.PI) % (Math.PI * 2));
      });

      const entranceDirection = nearestExteriorDirection(campaignLevel.playerStart, campaignLevel);
      const entranceSide = { x: -entranceDirection.y, y: entranceDirection.x };
      const yardCenter = world({
        x: campaignLevel.playerStart.x + entranceDirection.x * 3.35,
        y: campaignLevel.playerStart.y + entranceDirection.y * 3.35,
      }, campaignLevel);
      const markingMaterial = new THREE.MeshStandardMaterial({
        color: campaignLevel.campaign.palette.accent,
        emissive: campaignLevel.campaign.palette.emissive,
        emissiveIntensity: 0.08,
        roughness: 0.58,
        metalness: 0.04,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      });
      const stripeGeometry = new THREE.BoxGeometry(0.11, 0.022, CELL * 1.32);
      const stripeCount = 7;
      const yardStripes = new THREE.InstancedMesh(stripeGeometry, markingMaterial, stripeCount);
      const stripeRotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.atan2(entranceDirection.x, entranceDirection.y),
      );
      for (let index = 0; index < stripeCount; index += 1) {
        const side = (index - (stripeCount - 1) / 2) * 0.72;
        const position = yardCenter.clone().add(new THREE.Vector3(
          entranceSide.x * side * CELL,
          0.076,
          entranceSide.y * side * CELL,
        ));
        yardStripes.setMatrixAt(index, new THREE.Matrix4().compose(position, stripeRotation, new THREE.Vector3(1, 1, 1)));
      }
      yardStripes.instanceMatrix.needsUpdate = true;
      yardStripes.name = `${campaignLevel.campaign.theme}-arrival-bay-markings`;
      yardStripes.receiveShadow = true;
      parent.add(yardStripes);

      const emblemMaterial = markingMaterial.clone();
      emblemMaterial.opacity = 0.18;
      const yardEmblem = new THREE.Mesh(
        new THREE.CircleGeometry(0.9, 40),
        emblemMaterial,
      );
      yardEmblem.name = `${campaignLevel.campaign.theme}-arrival-bay-emblem`;
      yardEmblem.rotation.x = -Math.PI / 2;
      yardEmblem.position.copy(yardCenter).add(new THREE.Vector3(0, 0.09, 0));
      parent.add(yardEmblem);

      const sharedSet: readonly [DetailAssetName, number][] = campaignLevel.campaign.theme === "campus"
        ? [
            ["classroomDoor", 2.2], ["blackboard", 1.5],
            ["bulletin", 1.25], ["extinguisher", 0.8], ["trash", 0.75], ["books", 0.18], ["backpack", 0.5],
          ]
        : campaignLevel.campaign.theme === "hospital"
          ? [["bench", 1.0], ["bulletin", 1.2], ["extinguisher", 0.82], ["trash", 0.72], ["books", 0.16]]
          : campaignLevel.campaign.theme === "fire-station"
            ? [["bench", 1.0], ["extinguisher", 0.86], ["trash", 0.72], ["bulletin", 1.15]]
            : [["bench", 1.0], ["extinguisher", 0.86], ["trash", 0.76], ["backpack", 0.5]];
      sharedSet.forEach(([name, height], index) => {
        const rawPoint = decorPoints[themeSpecs.length - 2 + index] ?? exteriorPoint(campaignLevel.playerStart, 4 + index, -2);
        const point = decorPoints.includes(rawPoint) ? pushIntoScenery(rawPoint) : rawPoint;
        addProp(name, point, height, (index * 1.37 + campaignLevel.campaign.levelNumber) % (Math.PI * 2));
      });

      const exitDirection = nearestExteriorDirection(campaignLevel.exit, campaignLevel);
      const exitSide = { x: -exitDirection.y, y: exitDirection.x };
      addProp("station", {
        x: campaignLevel.exit.x + exitDirection.x * 3.9 + exitSide.x * 2.2,
        y: campaignLevel.exit.y + exitDirection.y * 3.9 + exitSide.y * 2.2,
      }, 3.25, Math.atan2(-exitDirection.x, -exitDirection.y));
      addProp("car", {
        x: campaignLevel.exit.x + exitDirection.x * 2.4 - exitSide.x * 2.3,
        y: campaignLevel.exit.y + exitDirection.y * 2.4 - exitSide.y * 2.3,
      }, 1.55, Math.atan2(exitSide.x, exitSide.y));

      const lightPoints = [campaignLevel.playerStart, ...campaignLevel.patrol.filter((_, index) => index % 2 === 0), campaignLevel.exit]
        .slice(0, 6);
      for (const point of lightPoints) {
        addProp("ceilingLight", point, 0.16, 0, new THREE.Vector3(0, 2.35, 0));
        const lamp = new THREE.PointLight(campaignLevel.campaign.palette.emissive, 5.2, 8.5, 2);
        lamp.position.copy(world(point, campaignLevel)).add(new THREE.Vector3(0, 2.2, 0));
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
        const initialPoint = name === "kid"
          ? campaignLevel.playerStart
          : name === "villain"
            ? campaignLevel.chaserStart
            : policeGuardPoint(campaignLevel, objectivePaths);
        const initialHeading = name === "kid"
          ? { x: 0, y: 1 }
          : name === "villain"
            ? campaignLevel.chaserStartHeading
            : nearestExteriorDirection(campaignLevel.exit, campaignLevel);
        root.position.copy(world(initialPoint, campaignLevel));
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
          requestAnimation(actors.kid!, "enterHide", { fade: 0.1, duration: simulation.config.hideEnterSeconds });
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
          requestAnimation(actors.kid!, "exitHide", { fade: 0.1, duration: simulation.config.hideExitSeconds });
        }
      }
    };

    const snapActorTransform = (view: ActorView, point: Point, heading: Point) => {
      view.root.position.copy(world(point, campaignLevel));
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
      const target = world(point, campaignLevel);
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
      const kidPoint = playerPresentationPoint(state, campaignLevel, simulation.config);
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
            const locomotion: AnimationState = state.player.mode === "aligning-hide"
              ? kidSpeed > 0.12 ? "walk" : "idle"
              : kidSpeed > 2.35 ? "run" : kidSpeed > 0.12 ? "walk" : "idle";
            requestAnimation(kid, locomotion, { fade: 0.17 });
            kid.animator.setLocomotionRate(kidSpeed, locomotion === "run" ? 4.4 : 2.0);
          }
        }
        const checkId = state.chaser.memory.witnessedHideSpotId;
        const checkSpot = checkId ? campaignLevel.hideSpots.find((spot) => spot.id === checkId) : undefined;
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
          duration: villainAnimation === "checkLocker" ? simulation.config.checkHideSeconds : undefined,
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
            const remainingCheck = Math.max(0, simulation.config.checkHideSeconds - state.chaser.modeElapsedSeconds);
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
        for (const [index, cloud] of sightObscurers.entries()) {
          cloud.rotation.y += delta * (0.12 + index * 0.013);
          cloud.position.y = Number(cloud.userData.baseY ?? 0)
            + Math.sin(now * 0.00042 + Number(cloud.userData.phase ?? 0)) * 0.055;
        }
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
        const chaserKnowledgeObservable = canPlayerObserveChaser(latestState, campaignLevel, simulation.config);
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

        const playerAnchor = world(
          playerPresentationPoint(latestState, campaignLevel, simulation.config),
          campaignLevel,
        ).add(new THREE.Vector3(0, 0.92, 0));
        const chaserAnchor = world(latestState.chaser.position, campaignLevel).add(new THREE.Vector3(0, 1.05, 0));
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
          setObjectiveDistance(objectiveDistanceMeters(latestState.player.position, campaignLevel, objectivePaths));
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
        selectLevel: (level: number | string) => void;
        setUnlockedThrough: (levelNumber: number) => void;
      };
    };
    if (new URLSearchParams(location.search).has("qa")) {
      qaWindow.__CHASING_QA__ = {
        getState: () => ({
          ready,
          campaign: {
            id: campaignLevel.id,
            index: campaignLevel.campaign.levelNumber - 1,
            number: campaignLevel.campaign.levelNumber,
            name: campaignLevel.campaign.name,
            theme: campaignLevel.campaign.theme,
            config: simulation.config,
            progress: campaignProgressRef.current,
            themeAsset: THEME_KIT_ASSETS[campaignLevel.campaign.theme],
          },
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
          knowledge: { chaserObservable: canPlayerObserveChaser(latestState, campaignLevel, simulation.config) },
          sceneIntegrity: {
            expectedMovementBlockers: campaignLevel.movementBlockers?.length ?? 0,
            renderedMovementBlockers,
            expectedVisionObscurers: campaignLevel.visionOnlyBlockers?.length ?? 0,
            renderedVisionObscurers: sightObscurers.length,
          },
          lockers: Object.fromEntries([...lockers].map(([id, view]) => [id, {
            action: view.actionName,
            peeking: view.peeking,
            peekClosing: view.peekClosing,
            holdFinal: view.holdFinal,
            delayRemaining: view.delayRemaining,
            normalizedTime: view.action
              ? view.action.time / Math.max(0.001, view.action.getClip().duration)
              : 0,
            timeScale: view.action?.timeScale ?? 0,
            doorQuaternion: (() => {
              const door = view.root.getObjectByName("DoorPivot");
              return door ? { x: door.quaternion.x, y: door.quaternion.y, z: door.quaternion.z, w: door.quaternion.w } : null;
            })(),
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
          render: {
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            memory: renderer.info.memory,
            programs: renderer.info.programs?.length ?? 0,
            sceneTextures: countSceneTextures(scene),
            invalidSceneTextures: findInvalidSceneTextures(scene),
            textureDeduplication,
          },
        }),
        start: beginGame,
        interact: () => { interactPressed.current = true; },
        selectLevel: (requested) => {
          const index = typeof requested === "number"
            ? requested
            : CAMPAIGN_LEVELS.findIndex((level) => level.id === requested);
          chooseLevelRef.current(index);
        },
        setUnlockedThrough: (levelNumber) => {
          setCampaignProgress((current) => ({
            ...current,
            unlockedThrough: THREE.MathUtils.clamp(Math.floor(levelNumber), 1, CAMPAIGN_LEVELS.length),
          }));
        },
        setScenario: ({ player, chaser }) => {
          simulation = new GameSimulation({
            level: campaignLevel,
            autoStart: true,
            initialPlayerPosition: player,
            initialChaserPosition: chaser,
            config: { ...gameplayConfig, spawnDelaySeconds: 0 },
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
  }, [campaignLevel, gameplayConfig, objectivePaths]);

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
  const hasNextLevel = selectedLevelIndex < CAMPAIGN_LEVELS.length - 1;
  const primaryAction = phase === "won" && hasNextLevel
    ? () => chooseLevel(selectedLevelIndex + 1)
    : begin;

  return (
    <main className="game-shell">
      <header className="hud">
        <div className="title-lockup">
          <span className="eyebrow">CHASING · 3D 追逐模式 · 第 {campaignLevel.campaign.levelNumber.toString().padStart(2, "0")} 关 · {campaignLevel.campaign.themeLabel}</span>
          <h1>{campaignLevel.campaign.name}</h1>
        </div>
        <div className="stats">
          <span className="chapter">关卡 <b>{campaignLevel.campaign.levelNumber}/10</b></span>
          <span>用时 <b>{elapsed}s</b></span>
          <span className="objective">出口 <b>{objectiveDistance}m</b></span>
          <span className={`status danger-${Math.round(danger * 10)}`}><i />{displayedChaserStatus}</span>
          <button type="button" aria-label={musicMuted ? "打开音乐" : "静音"} onClick={() => commands.current.toggleMute()}>{musicMuted ? "音乐关" : "音乐开"}</button>
          <button type="button" disabled={loading} onClick={restart}>重新开始</button>
        </div>
      </header>

      <section
        className={`playfield theme-${campaignLevel.campaign.theme} threat-${chaserMode} mode-${playerMode}`}
        style={{
          "--threat": danger,
          "--theme-accent": campaignLevel.campaign.palette.accent,
          "--theme-glow": campaignLevel.campaign.palette.emissive,
        } as React.CSSProperties}
      >
        <div className="three-mount" ref={mount} />
        <div className="cinematic-vignette" aria-hidden="true" />

        {loading && (
          <div className={`loading-card${loadError ? " error" : ""}`} role="status">
            <span className="loader-dot" />
            <div>
              <strong>{loadError || loadProgress.message}</strong>
              {!loadError && <div className="load-bar"><i style={{ width: `${loadPercent}%` }} /></div>}
              {!loadError && <small>{campaignLevel.campaign.themeLabel}主题高模、角色动作、动态灯光与互动资产 · {loadPercent}%</small>}
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
              <span className={`result ${phase}`}>{phase === "won" ? "成功逃脱" : phase === "lost" ? "被抓住了" : `${campaignLevel.campaign.themeLabel}篇 · ${campaignLevel.campaign.difficultyLabel}`}</span>
              <h2>{phase === "won" ? `你完成了「${campaignLevel.campaign.name}」` : phase === "lost" ? "切断视线，利用主题藏柜重新布局" : campaignLevel.campaign.subtitle}</h2>
              <p>{phase === "ready" ? campaignLevel.campaign.briefing : "追捕者只会依据真实目击与最后位置追踪。绕过遮挡、藏好，等他进入盲目搜索后再继续逃跑。"}</p>

              {phase === "ready" && (
                <div className="level-grid" aria-label="选择关卡">
                  {CAMPAIGN_LEVELS.map((level, index) => {
                    const locked = index + 1 > campaignProgress.unlockedThrough;
                    const active = index === selectedLevelIndex;
                    const best = campaignProgress.bestSeconds[level.id];
                    return (
                      <button
                        className={`level-card${active ? " active" : ""}${locked ? " locked" : ""}`}
                        type="button"
                        key={level.id}
                        disabled={locked || loading}
                        onClick={() => chooseLevel(index)}
                        aria-current={active ? "step" : undefined}
                      >
                        <span>{level.campaign.levelNumber.toString().padStart(2, "0")}</span>
                        <strong>{locked ? "未解锁" : level.campaign.name}</strong>
                        <small>{locked ? "完成上一关" : best ? `最佳 ${best}s` : level.campaign.themeLabel}</small>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="overlay-actions">
                <button className="primary" type="button" onClick={primaryAction}>
                  {phase === "ready" ? `开始第 ${campaignLevel.campaign.levelNumber} 关` : phase === "won" && hasNextLevel ? "进入下一关" : "再来一次"}
                  <kbd>Enter</kbd>
                </button>
                {phase === "won" && <button className="secondary" type="button" onClick={begin}>重玩本关</button>}
              </div>
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
        <span><i className="safe" />可藏主题柜</span>
        <small>WASD / 方向键移动 · E 躲藏或离开 · Q 按住观察 · 滚轮动态调视野 · M 音乐 · R 重开</small>
      </footer>
    </main>
  );
}
