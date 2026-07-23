"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  ActorAnimator,
  type AnimationState,
  type ClipAliases,
} from "./game/animation/actor-runtime.ts";
import { AdaptiveScoreController, prewarmAdaptiveScoreAssets } from "./game/audio/adaptive-score.ts";
import { ImmersiveSoundscapeController } from "./game/audio/immersive-soundscape.ts";
import { runtimeAtmosphereForLevel } from "./game/atmosphere.ts";
import {
  CAMPAIGN_LEVELS,
  getCampaignGameplayConfig,
  getCampaignHideGuidancePolicy,
  type CampaignTheme,
} from "./game/campaign.ts";
import type { CaptureReason, ChaserMode, GameConfig, GamePhase, GameState, HideSpotDefinition, LevelDefinition, PlayerMode, Point } from "./game/contracts.ts";
import { failureFeedback } from "./game/failure-feedback.ts";
import {
  recommendHideSpot,
  type HideGuidanceRisk,
  type PlayerKnownChaserEvidence,
} from "./game/hide-guidance.ts";
import { pairedHidePresentationPoint } from "./game/hide-performance.ts";
import {
  FIXED_CAMERA_GROUND_DIRECTION,
  screenMoveToWorld,
  shouldIgnoreFocusedControlKey,
} from "./game/input.ts";
import { distanceBetween, GridPathPlanner, hasLineOfSight } from "./game/navigation.ts";
import { isPlayerVisuallyExposed } from "./game/perception.ts";
import {
  nextRenderQuality,
  RENDER_QUALITY_PROFILES,
  selectInitialRenderQuality,
  type RenderQualityProfile,
  type RenderQualityTier,
} from "./game/quality.ts";
import {
  authoredRoomFloorRegions,
  enclosedRoomFloorRegions,
  roomFloorBoundaryTrimPlacement,
  roomFloorSupportForFootprint,
} from "./game/room-floor.ts";
import {
  baseCameraDistanceForAspect,
  boundedFrameDeltaSeconds,
  cameraFocusForSafeViewport,
  cameraSafeViewportFromInsets,
  cameraDistanceScaleForPlayerMode,
  cameraFocusForEdgeHide,
  canChaserTakeLockerDoor,
  chaserAnimationForMode,
  fixedCameraCompositionConstraints,
  gameplayCameraInsetsForViewport,
  lockerVisionMix,
  shouldFrameChaser,
  shouldRenderChaserModel,
  smoothOcclusionStrength,
} from "./game/presentation.ts";
import { GameSimulation, type HideInteraction } from "./game/simulation.ts";

type ActorName = "kid" | "villain" | "police";
type StructureAssetName = keyof typeof STRUCTURE_ASSETS;
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
const HIDE_PROP_FORWARD_OFFSET_CELLS = 0.18;

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

const STRUCTURE_ASSETS = {
  frontGate: "/models/environment/front-gate.glb?v=4",
  exit: "/models/environment/exit.glb?v=4",
} as const;

const DETAIL_ASSETS = {
  locker: "/models/environment/locker.glb?v=31",
  bench: "/models/environment/bench.glb?v=4",
  car: "/models/environment/police-car.glb?v=4",
  tree: "/models/environment/tree.glb?v=4",
  classroomDoor: "/models/environment/classroom-door.glb?v=4",
  ceilingLight: "/models/environment/ceiling-light.glb?v=4",
  basketball: "/models/environment/basketball.glb?v=4",
  deskChair: "/models/environment/desk-chair.glb?v=4",
  blackboard: "/models/environment/blackboard.glb?v=4",
  bulletin: "/models/environment/bulletin.glb?v=4",
  podium: "/models/environment/podium.glb?v=4",
  extinguisher: "/models/environment/extinguisher.glb?v=4",
  trash: "/models/environment/trash.glb?v=4",
  books: "/models/environment/books.glb?v=4",
  backpack: "/models/environment/backpack.glb?v=4",
  shrub: "/models/environment/shrub.glb?v=4",
  station: "/models/environment/station.glb?v=4",
} as const;

const THEME_KIT_ASSETS: Readonly<Record<CampaignTheme, string>> = {
  campus: "/models/environment/themes/campus-kit.glb?v=5",
  hospital: "/models/environment/themes/hospital-kit.glb?v=5",
  "fire-station": "/models/environment/themes/fire-station-kit.glb?v=5",
  factory: "/models/environment/themes/factory-kit.glb?v=5",
};

type ThemePropSpec = { node: string; height: number };

type StandaloneAnchorRole = "interior-1" | "interior-2" | "interior-3" | "arrival" | "exit";

type StandalonePropPlacement = {
  readonly asset: DetailAssetName;
  readonly height: number;
  readonly role: StandaloneAnchorRole;
  readonly tangent: number;
  readonly depth?: number;
  readonly elevation?: number;
  readonly rotationOffset?: number;
};

type ThemeFloorRole = "primary" | "secondary" | "service";

type LevelArtLayout = {
  readonly key: string;
  readonly wallVariantSalt: number;
  readonly floorCycle: readonly ThemeFloorRole[];
  readonly landmarkNodes: readonly string[];
  readonly hideDressingNodes: readonly string[];
  readonly arrivalNodes: readonly string[];
  readonly exitNodes: readonly string[];
  readonly lightIntensity: number;
  readonly warmLightMix: number;
};

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

const MOVEMENT_PROP_CONTRACT: readonly (readonly [DetailAssetName, number, number])[] = [
  ["bench", 1.05, 0],
  ["tree", 3.9, 0.35],
  ["shrub", 0.9, -0.2],
  ["car", 1.55, Math.PI / 2],
  ["basketball", 2.65, 0],
  ["deskChair", 1.2, 0.58],
  ["podium", 1.1, -0.25],
];

const THEME_SHARED_PROPS: Readonly<Record<CampaignTheme, readonly (readonly [DetailAssetName, number])[]>> = {
  campus: [["bulletin", 1.25], ["trash", 0.75], ["tree", 3.9]],
  hospital: [["bulletin", 1.2], ["trash", 0.72]],
  "fire-station": [["extinguisher", 0.86], ["trash", 0.72]],
  factory: [["extinguisher", 0.86], ["trash", 0.76]],
};

// Shared props are deliberately bound to authored narrative roles. This keeps
// recognizable classroom assets out of unrelated hospital/industrial scenes
// and makes the ten-level art contract deterministic enough for automated QA.
const PROP_SET_STANDALONE_PROPS: Readonly<Record<string, readonly StandalonePropPlacement[]>> = {
  "campus-classic": [
    { asset: "classroomDoor", height: 2.2, role: "interior-1", tangent: -1.38, depth: -0.12 },
    { asset: "blackboard", height: 1.5, role: "interior-2", tangent: 1.2, depth: -0.16 },
    { asset: "backpack", height: 0.52, role: "arrival", tangent: -1.85, depth: -0.3 },
    { asset: "station", height: 3.25, role: "exit", tangent: 2.15, depth: -0.72 },
  ],
  "campus-library": [
    { asset: "books", height: 0.22, role: "interior-1", tangent: 1.08, depth: -0.12, elevation: 0.03 },
    { asset: "backpack", height: 0.5, role: "interior-2", tangent: -1.05, depth: -0.2 },
  ],
  "campus-science": [
    { asset: "classroomDoor", height: 2.2, role: "interior-1", tangent: -1.32, depth: -0.12 },
    { asset: "blackboard", height: 1.48, role: "interior-2", tangent: 1.18, depth: -0.16 },
    { asset: "books", height: 0.2, role: "interior-3", tangent: -0.95, depth: -0.12, elevation: 0.03 },
  ],
};

type FeaturedThemeProps = {
  readonly interior: readonly string[];
  readonly arrival: readonly string[];
};

const PROP_SET_FEATURED_THEME_PROPS: Readonly<Record<string, FeaturedThemeProps>> = {
  "hospital-outpatient": {
    interior: ["HospitalIVStation", "HospitalCrashCart"],
    arrival: ["HospitalWheelchair", "HospitalWayfinding"],
  },
  "hospital-isolation": {
    interior: ["HospitalIVStation", "HospitalPrivacyScreen"],
    arrival: ["HospitalWayfinding"],
  },
  "fire-engine-bay": {
    interior: ["FireGearRack", "FireHoseReel"],
    arrival: ["FireEngine", "FireStationWayfinding", "FireSafetyCones"],
  },
  "fire-training": {
    interior: ["FireGearRack", "FireHoseReel"],
    arrival: ["FireStationWayfinding", "FireSafetyCones", "FireHydrant"],
  },
};

const THEME_WALL_NODES: Readonly<Record<CampaignTheme, string>> = {
  campus: "CampusArchitectureWall",
  hospital: "HospitalArchitectureWall",
  "fire-station": "FireArchitectureWall",
  factory: "FactoryArchitectureWall",
};

const THEME_NODE_PREFIXES: Readonly<Record<CampaignTheme, readonly string[]>> = {
  campus: ["Campus"],
  hospital: ["Hospital"],
  "fire-station": ["FireStation", "Fire"],
  factory: ["Factory"],
};

// These profiles turn campaign art-direction metadata into concrete scene
// choices. Every optional named cluster has a deterministic generic fallback,
// so a partially exported theme kit remains playable while the source-art pass
// is being rolled out one prop set at a time.
const PROP_SET_ART_LAYOUTS: Readonly<Record<string, LevelArtLayout>> = {
  "campus-classic": {
    key: "CampusClassic",
    wallVariantSalt: 11,
    floorCycle: ["primary", "secondary", "primary", "primary", "service"],
    landmarkNodes: ["CampusClassroomCluster", "CampusCourtyardCluster", "CampusClassicLandmark"],
    hideDressingNodes: ["CampusClassicHideDressing", "CampusHideDressing"],
    arrivalNodes: ["CampusClassicArrivalCluster", "CampusArrivalCluster"],
    exitNodes: ["CampusGateDressing", "CampusExitCluster"],
    lightIntensity: 4.25,
    warmLightMix: 0.62,
  },
  "campus-library": {
    key: "CampusLibrary",
    wallVariantSalt: 23,
    floorCycle: ["secondary", "secondary", "primary", "service"],
    landmarkNodes: ["CampusLibraryShelves", "CampusReadingCluster", "CampusArchiveCluster"],
    hideDressingNodes: ["CampusLibraryHideDressing", "CampusHideDressing"],
    arrivalNodes: ["CampusLibraryArrivalCluster", "CampusArrivalCluster"],
    exitNodes: ["CampusLibraryExitCluster", "CampusExitCluster"],
    lightIntensity: 3.75,
    warmLightMix: 0.78,
  },
  "campus-science": {
    key: "CampusScience",
    wallVariantSalt: 37,
    floorCycle: ["service", "primary", "service", "secondary"],
    landmarkNodes: ["CampusLabBenchCluster", "CampusFumeHoodCluster", "CampusGreenhouseCluster"],
    hideDressingNodes: ["CampusScienceHideDressing", "CampusHideDressing"],
    arrivalNodes: ["CampusScienceArrivalCluster", "CampusArrivalCluster"],
    exitNodes: ["CampusScienceExitCluster", "CampusExitCluster"],
    lightIntensity: 4.8,
    warmLightMix: 0.26,
  },
  "hospital-outpatient": {
    key: "HospitalOutpatient",
    wallVariantSalt: 41,
    floorCycle: ["primary", "primary", "secondary", "service"],
    landmarkNodes: ["HospitalTriageCluster", "HospitalWaitingCluster", "HospitalPharmacyCluster"],
    hideDressingNodes: ["HospitalOutpatientHideDressing", "HospitalHideDressing"],
    arrivalNodes: ["HospitalOutpatientArrivalCluster", "HospitalArrivalCluster"],
    exitNodes: ["HospitalOutpatientExitCluster", "HospitalExitCluster"],
    lightIntensity: 4.9,
    warmLightMix: 0.18,
  },
  "hospital-isolation": {
    key: "HospitalIsolation",
    wallVariantSalt: 53,
    floorCycle: ["service", "primary", "service", "primary", "secondary"],
    landmarkNodes: ["HospitalDeconCluster", "HospitalIsolationWardCluster", "HospitalAirlockCluster"],
    hideDressingNodes: ["HospitalIsolationHideDressing", "HospitalHideDressing"],
    arrivalNodes: ["HospitalIsolationArrivalCluster", "HospitalArrivalCluster"],
    exitNodes: ["HospitalIsolationExitCluster", "HospitalExitCluster"],
    lightIntensity: 4.25,
    warmLightMix: 0.12,
  },
  "fire-engine-bay": {
    key: "FireEngineBay",
    wallVariantSalt: 67,
    floorCycle: ["service", "primary", "service", "secondary"],
    landmarkNodes: ["FireStationEngineBayCluster", "FireStationTurnoutCluster", "FireStationHoseServiceCluster"],
    hideDressingNodes: ["FireStationEngineBayHideDressing", "FireStationHideDressing", "FireHideDressing"],
    arrivalNodes: ["FireStationEngineBayArrivalCluster", "FireStationArrivalCluster", "FireArrivalCluster"],
    exitNodes: ["FireStationEngineBayExitCluster", "FireStationExitCluster", "FireExitCluster"],
    lightIntensity: 4.7,
    warmLightMix: 0.83,
  },
  "fire-training": {
    key: "FireTraining",
    wallVariantSalt: 79,
    floorCycle: ["service", "service", "primary", "secondary"],
    landmarkNodes: ["FireStationTrainingCluster", "FireStationRopeRescueCluster", "FireStationBreathingGearCluster"],
    hideDressingNodes: ["FireStationTrainingHideDressing", "FireStationHideDressing", "FireHideDressing"],
    arrivalNodes: ["FireStationTrainingArrivalCluster", "FireStationArrivalCluster", "FireArrivalCluster"],
    exitNodes: ["FireStationTrainingExitCluster", "FireStationExitCluster", "FireExitCluster"],
    lightIntensity: 4.35,
    warmLightMix: 0.9,
  },
  "factory-assembly": {
    key: "FactoryAssembly",
    wallVariantSalt: 83,
    floorCycle: ["primary", "service", "primary", "secondary"],
    landmarkNodes: ["FactoryAssemblyLineCluster", "FactoryRobotCellCluster", "FactoryInspectionCluster"],
    hideDressingNodes: ["FactoryAssemblyHideDressing", "FactoryHideDressing"],
    arrivalNodes: ["FactoryAssemblyArrivalCluster", "FactoryArrivalCluster"],
    exitNodes: ["FactoryAssemblyExitCluster", "FactoryExitCluster"],
    lightIntensity: 4.25,
    warmLightMix: 0.52,
  },
  "factory-turbine": {
    key: "FactoryTurbine",
    wallVariantSalt: 97,
    floorCycle: ["service", "primary", "service", "service", "secondary"],
    landmarkNodes: ["FactoryTurbineCluster", "FactoryHighPressurePipeCluster", "FactoryBreakerCluster"],
    hideDressingNodes: ["FactoryTurbineHideDressing", "FactoryHideDressing"],
    arrivalNodes: ["FactoryTurbineArrivalCluster", "FactoryArrivalCluster"],
    exitNodes: ["FactoryTurbineExitCluster", "FactoryExitCluster"],
    lightIntensity: 4.65,
    warmLightMix: 0.36,
  },
  "factory-foundry": {
    key: "FactoryFoundry",
    wallVariantSalt: 109,
    floorCycle: ["service", "service", "primary", "secondary"],
    landmarkNodes: ["FactoryFurnaceCluster", "FactoryCastingCluster", "FactoryCoolingCluster"],
    hideDressingNodes: ["FactoryFoundryHideDressing", "FactoryHideDressing"],
    arrivalNodes: ["FactoryFoundryArrivalCluster", "FactoryArrivalCluster"],
    exitNodes: ["FactoryFoundryExitCluster", "FactoryExitCluster"],
    lightIntensity: 4.85,
    warmLightMix: 0.94,
  },
};

const LOCKER_CLIPS = [
  "Locker_Door_Open_Enter",
  "Locker_Door_Close_Enter",
  "Locker_Door_Open_Exit",
  "Locker_Door_Close_Exit",
  "Locker_Door_Check_Open",
  "Locker_Door_Check_Close",
] as const;

// Kid, villain and the active theme are the only core bootstrap payloads.
// The police resolution actor is streamed after play becomes available.
const BOOTSTRAP_ASSET_COUNT = 3;

function world(point: Point, level: LevelDefinition) {
  return new THREE.Vector3(
    (point.x - (level.width - 1) / 2) * CELL,
    0,
    (point.y - (level.height - 1) / 2) * CELL,
  );
}

function levelArtLayout(theme: CampaignTheme, propSet: string): LevelArtLayout {
  const authored = PROP_SET_ART_LAYOUTS[propSet];
  if (authored) return authored;
  const prefix = THEME_NODE_PREFIXES[theme][0];
  return {
    key: `${prefix}Default`,
    wallVariantSalt: 17,
    floorCycle: ["primary", "secondary", "primary", "service"],
    landmarkNodes: [`${prefix}LandmarkCluster`],
    hideDressingNodes: [`${prefix}HideDressing`],
    arrivalNodes: [`${prefix}ArrivalCluster`],
    exitNodes: [`${prefix}ExitCluster`],
    lightIntensity: 4.25,
    warmLightMix: 0.5,
  };
}

function resolveThemeNode(
  root: THREE.Object3D,
  theme: CampaignTheme,
  candidates: readonly string[],
): THREE.Object3D | undefined {
  for (const candidate of candidates) {
    const direct = root.getObjectByName(candidate);
    if (direct) return direct;
    for (const prefix of THEME_NODE_PREFIXES[theme]) {
      if (candidate.startsWith(prefix)) continue;
      const prefixed = root.getObjectByName(`${prefix}${candidate}`);
      if (prefixed) return prefixed;
    }
  }
  return undefined;
}

function wallVariantIndex(x: number, y: number, dx: number, dy: number, salt: number) {
  const tangentCoordinate = dy !== 0 ? x : y;
  const laneCoordinate = dy !== 0 ? y : x;
  const orientation = dx !== 0 ? 1 : dy > 0 ? 2 : 0;
  // Adjacent bays along one straight boundary always advance A→B→C, while
  // the lane/orientation salt prevents distant corridors sharing a pattern.
  // This guarantees that the new skyline profiles never repeat three times.
  return Math.abs(tangentCoordinate + laneCoordinate * 2 + orientation + salt) % 3;
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

function createAtmosphereParticleTexture(kind: "dust" | "rain" | "embers" | "steam" | "none") {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建关卡氛围粒子纹理");
  context.clearRect(0, 0, 64, 64);
  if (kind === "rain") {
    const gradient = context.createLinearGradient(32, 4, 32, 60);
    gradient.addColorStop(0, "rgba(255,255,255,0)");
    gradient.addColorStop(0.28, "rgba(255,255,255,.32)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.strokeStyle = gradient;
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(37, 5);
    context.lineTo(26, 59);
    context.stroke();
  } else {
    const radius = kind === "steam" ? 28 : kind === "dust" ? 12 : 9;
    const gradient = context.createRadialGradient(32, 32, 1, 32, 32, radius);
    gradient.addColorStop(0, kind === "embers" ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.58)");
    gradient.addColorStop(0.35, kind === "steam" ? "rgba(255,255,255,.18)" : "rgba(255,255,255,.32)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `Atmosphere_${kind}`;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function createContactShadowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 48;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建接触阴影纹理");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const gradient = context.createRadialGradient(48, 24, 1, 48, 24, 46);
  gradient.addColorStop(0, "rgba(0,0,0,.92)");
  gradient.addColorStop(0.38, "rgba(0,0,0,.52)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createHideBeaconTexture(accent: THREE.ColorRepresentation) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建藏身点引导纹理");

  const color = new THREE.Color(accent);
  const red = Math.round(color.r * 255);
  const green = Math.round(color.g * 255);
  const blue = Math.round(color.b * 255);
  const glow = `rgb(${red} ${green} ${blue})`;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.shadowColor = glow;
  context.shadowBlur = 28;
  context.fillStyle = "rgba(4, 15, 18, 0.9)";
  context.strokeStyle = `rgba(${red}, ${green}, ${blue}, 0.92)`;
  context.lineWidth = 5;
  context.beginPath();
  context.roundRect(18, 22, 348, 142, 34);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.18)`;
  context.strokeStyle = glow;
  context.lineWidth = 6;
  context.beginPath();
  context.roundRect(42, 47, 70, 94, 10);
  context.fill();
  context.stroke();
  context.beginPath();
  context.arc(94, 95, 5, 0, Math.PI * 2);
  context.fillStyle = glow;
  context.fill();
  context.font = '800 40px Inter, "PingFang SC", sans-serif';
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = "#f4fff9";
  context.fillText("藏身处", 137, 83);
  context.font = '700 20px Inter, "PingFang SC", sans-serif';
  context.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.95)`;
  context.fillText("靠近后按 E", 139, 123);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "Authored_Hide_Beacon";
  texture.colorSpace = THREE.SRGBColorSpace;
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
    0.72,
    FIXED_CAMERA_GROUND_DIRECTION.y,
  ).normalize();
}

function objectiveDistanceMeters(point: Point, level: LevelDefinition, paths: GridPathPlanner) {
  const route = paths.path(point, level.exit);
  if (!route.length) return 0;
  return Math.round(Math.max(0, route.length - 1) * CELL);
}

function nearestHideDistanceMeters(point: Point, level: LevelDefinition, paths: GridPathPlanner) {
  let nearest = Number.POSITIVE_INFINITY;
  for (const spot of level.hideSpots) {
    const route = paths.path(point, spot.approach);
    if (route.length) nearest = Math.min(nearest, Math.max(0, route.length - 1) * CELL);
  }
  return Number.isFinite(nearest) ? Math.round(nearest) : 0;
}

function visualHidePoint(spot: HideSpotDefinition): Point {
  return {
    x: spot.concealed.x + spot.facing.x * HIDE_PROP_FORWARD_OFFSET_CELLS,
    y: spot.concealed.y + spot.facing.y * HIDE_PROP_FORWARD_OFFSET_CELLS,
  };
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

function anchorAuthoredStatic(source: THREE.Object3D, castShadow = false) {
  const model = source.clone(true);
  tuneMeshes(model, { castShadow });
  const visual = new THREE.Group();
  visual.add(model);
  visual.updateMatrixWorld(true);
  const authoredAnchor = visual.getObjectByName("PlacementAnchor");
  if (authoredAnchor) {
    visual.position.sub(authoredAnchor.getWorldPosition(new THREE.Vector3()));
    return flattenStatic(visual, castShadow);
  }
  const bounds = new THREE.Box3().setFromObject(visual);
  const center = bounds.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -bounds.min.y, -center.z);
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


function anchorAuthoredModule(source: THREE.Object3D) {
  const root = source.clone(true);
  tuneMeshes(root, { castShadow: true });
  root.updateMatrixWorld(true);
  const authoredAnchor = root.getObjectByName("ModuleAnchor") ?? root.getObjectByName("PlacementAnchor");
  if (authoredAnchor) {
    root.position.sub(authoredAnchor.getWorldPosition(new THREE.Vector3()));
    return root;
  }
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.y -= bounds.min.y;
  root.position.z -= center.z;
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
      material.color.lerp(tintColor, options.blend ?? 0.16);
      material.roughness = THREE.MathUtils.clamp(material.roughness + (options.roughnessShift ?? 0), 0.16, 0.96);
      material.envMapIntensity = 1.2;
      if (material.normalMap) material.normalScale.multiplyScalar(1.04);
      if (options.emissive) {
        material.emissive.lerp(new THREE.Color(options.emissive), 0.08);
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
  options: { preserveAuthoredScale?: boolean; namePrefix?: string } = {},
) {
  const created: THREE.InstancedMesh[] = [];
  if (!placements.length) return created;
  // Authored modules often contain many material-labelled child meshes. Merge
  // children that share a material before instancing so richer architecture
  // does not multiply draw calls for every bevel, trim and bolt.
  const template = flattenStatic(
    options.preserveAuthoredScale ? anchorAuthoredModule(source) : fitModule(source, size),
    castShadow,
  );
  template.updateMatrixWorld(true);
  const placementMatrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    const instances = new THREE.InstancedMesh(object.geometry, object.material, placements.length);
    instances.name = `${options.namePrefix ?? "environment"}-${object.name || "module"}`;
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

type InstancedModuleBatch = {
  source: THREE.Object3D;
  placements: readonly ModulePlacement[];
  preserveAuthoredScale?: boolean;
};

function addInstancedModuleBatches(
  batches: readonly InstancedModuleBatch[],
  size: THREE.Vector3,
  parent: THREE.Object3D,
  castShadow: boolean,
  namePrefix: string,
  useMultiDraw = false,
) {
  const grouped = new Map<string, { source: THREE.Object3D; placements: ModulePlacement[]; preserveAuthoredScale: boolean }>();
  for (const batch of batches) {
    if (!batch.placements.length) continue;
    const preserveAuthoredScale = batch.preserveAuthoredScale ?? false;
    const key = `${batch.source.uuid}:${preserveAuthoredScale}`;
    const entry = grouped.get(key) ?? { source: batch.source, placements: [], preserveAuthoredScale };
    entry.placements.push(...batch.placements);
    grouped.set(key, entry);
  }
  if (useMultiDraw) {
    type GeometryBatch = {
      material: THREE.Material;
      geometries: Array<{ geometry: THREE.BufferGeometry; placements: readonly ModulePlacement[] }>;
    };
    const geometryBatches = new Map<string, GeometryBatch>();
    for (const [sourceKey, entry] of grouped) {
      const template = flattenStatic(
        entry.preserveAuthoredScale ? anchorAuthoredModule(entry.source) : fitModule(entry.source, size),
        castShadow,
      );
      template.updateMatrixWorld(true);
      template.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh || Array.isArray(object.material)) return;
        const attributes = (Object.entries(object.geometry.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][])
          .map(([name, attribute]) => {
            const array = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
            return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}`;
          })
          .sort()
          .join("|");
        const signature = `${object.material.uuid}:${object.geometry.index ? "indexed" : "plain"}:${attributes}`;
        const bucket: GeometryBatch = geometryBatches.get(signature) ?? {
          material: object.material,
          geometries: [],
        };
        bucket.geometries.push({
          geometry: object.geometry.clone().applyMatrix4(object.matrixWorld),
          placements: entry.placements,
        });
        geometryBatches.set(signature, bucket);
      });
      // Keep the source identity in the debugger without splitting a shared
      // material batch back into one draw per wall/floor variant.
      template.userData.sourceKey = sourceKey;
    }

    const created: THREE.BatchedMesh[] = [];
    for (const [signature, batch] of geometryBatches) {
      const maxInstanceCount = batch.geometries.reduce((total, item) => total + item.placements.length, 0);
      const maxVertexCount = batch.geometries.reduce(
        (total, item) => total + (item.geometry.getAttribute("position")?.count ?? 0),
        0,
      );
      const maxIndexCount = batch.geometries.reduce(
        (total, item) => total + (item.geometry.index?.count ?? 0),
        0,
      );
      if (!maxInstanceCount || !maxVertexCount) continue;
      const batched = new THREE.BatchedMesh(
        maxInstanceCount,
        maxVertexCount,
        Math.max(maxIndexCount, maxVertexCount),
        batch.material,
      );
      batched.name = `${namePrefix}-batch-${signature.slice(0, 8)}`;
      batched.castShadow = castShadow;
      batched.receiveShadow = true;
      for (const item of batch.geometries) {
        const geometryId = batched.addGeometry(item.geometry);
        for (const placement of item.placements) {
          const instanceId = batched.addInstance(geometryId);
          const rotation = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            placement.rotation,
          );
          batched.setMatrixAt(
            instanceId,
            new THREE.Matrix4().compose(placement.position, rotation, new THREE.Vector3(1, 1, 1)),
          );
        }
      }
      batched.computeBoundingBox();
      batched.computeBoundingSphere();
      parent.add(batched);
      created.push(batched);
    }
    return created;
  }
  return [...grouped.values()].flatMap((entry) => addInstancedModules(
    entry.source,
    size,
    entry.placements,
    parent,
    castShadow,
    { preserveAuthoredScale: entry.preserveAuthoredScale, namePrefix },
  ));
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
  approach: Point;
  beacon: THREE.Sprite;
  beaconLight: THREE.PointLight;
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

type LoadedAsset = { id: string; asset: GLTF };

function configureAssetTextures(assets: Iterable<LoadedAsset>, renderer: THREE.WebGLRenderer) {
  const textures = new Set<THREE.Texture>();
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const { asset } of assets) {
    asset.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (!(value instanceof THREE.Texture) || textures.has(value)) continue;
          textures.add(value);
          value.anisotropy = anisotropy;
          value.needsUpdate = true;
        }
      }
    });
  }
}

function deduplicateAssetTextures(assets: Iterable<LoadedAsset>): TextureDeduplication {
  const canonical = new Map<string, THREE.Texture>();
  const sourceTextures = new Set<THREE.Texture>();
  let assignmentsShared = 0;

  for (const { id: assetId, asset } of assets) {
    asset.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const record = material as unknown as Record<string, unknown>;
        for (const [slot, value] of Object.entries(record)) {
          if (!(value instanceof THREE.Texture)) continue;
          sourceTextures.add(value);
          const image = value.image as { width?: number; height?: number; src?: string; currentSrc?: string } | undefined;
          const externalSource = image?.currentSrc || image?.src;
          const textureName = value.name.trim();
          // ImageBitmap deliberately omits a URL. GLTFLoader still assigns
          // the source filename to Texture.name. Only the explicitly shared
          // Env_* library may cross an asset boundary by name; generic embedded
          // names such as BaseColor are scoped to their owning GLB so unrelated
          // high-resolution art can never be merged accidentally.
          const explicitlyShared = /(?:^|\/)Env_[A-Za-z0-9_-]+(?:\.(?:png|webp|ktx2))?$/u.test(textureName)
            || textureName.includes("/SharedTextures/");
          const sourceIdentity = externalSource
            ? `url:${externalSource}`
            : explicitlyShared
              ? `shared:${textureName}`
              : textureName
                ? `asset:${assetId}:${textureName}`
                : "";
          if (!sourceIdentity) continue;
          const key = [
            slot,
            sourceIdentity,
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
            value.minFilter,
            value.magFilter,
            value.anisotropy,
            value.generateMipmaps,
            value.premultiplyAlpha,
            value.unpackAlignment,
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
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line || object instanceof THREE.Sprite)) return;
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
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line || object instanceof THREE.Sprite)) return;
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
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line || object instanceof THREE.Sprite)) return;
      if (!(object instanceof THREE.Sprite)) {
        if (object instanceof THREE.BatchedMesh) {
          // BatchedMesh owns GPU data textures in addition to its combined
          // geometry. Mesh/geometry disposal alone leaves those allocations
          // alive across repeated campaign switches.
          object.dispose();
          geometries.add(object.geometry);
        } else if (!geometries.has(object.geometry)) {
          object.geometry.dispose();
          geometries.add(object.geometry);
        }
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
    case "lost-sight": return 0.9;
    case "go-to-last-known": return 0.78;
    case "scan-last-known": return 0.68;
    case "search": return 0.52;
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
    case "lost-sight": return "视线中断 · 继续追踪";
    case "go-to-last-known": return "赶往最后目击点";
    case "scan-last-known": return "抵达目击点 · 左右巡视";
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
  // Simulation keeps its concealed point as the AI/perception contract. The
  // premium locker and the rendered actor sit slightly nearer the threshold,
  // so the closed door remains visible in the corridor instead of sinking
  // into the surrounding wall module after the art-polish pass.
  const lockerAnchor = visualHidePoint(spot);
  if (state.player.mode === "aligning-hide") return state.player.position;
  return pairedHidePresentationPoint({
    mode: state.player.mode,
    playerPosition: state.player.position,
    approach: spot.approach,
    lockerAnchor,
    facing: spot.facing,
    transitionRemainingSeconds: state.player.transitionRemainingSeconds,
    transitionDurationSeconds: state.player.mode === "exiting-hide"
      ? config.hideExitSeconds
      : config.hideEnterSeconds,
  });
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
  const hideGuidancePolicy = useMemo(() => getCampaignHideGuidancePolicy(campaignLevel), [campaignLevel]);
  const atmosphere = useMemo(() => runtimeAtmosphereForLevel(campaignLevel), [campaignLevel]);
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
  const [hideDistance, setHideDistance] = useState(
    nearestHideDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths),
  );
  const [hideGuideProjection, setHideGuideProjection] = useState<{
    xPercent: number;
    yPercent: number;
    angleDegrees: number;
    offscreen: boolean;
  } | null>(null);
  const [hideGuideRisk, setHideGuideRisk] = useState<HideGuidanceRisk>("medium");
  const [hideGuideSelection, setHideGuideSelection] = useState<"tutorial" | "nearest">("nearest");
  const [interaction, setInteraction] = useState<HideInteraction | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: BOOTSTRAP_ASSET_COUNT, message: "正在载入项目美术资产：角色、校园与互动道具…" });
  const [resultVisible, setResultVisible] = useState(true);
  const [musicMuted, setMusicMuted] = useState(false);
  const [lastCaptureReason, setLastCaptureReason] = useState<CaptureReason | null>(null);

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
    setLoadProgress({ done: 0, total: BOOTSTRAP_ASSET_COUNT, message: "正在切换主题关卡与高精度环境…" });
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
      total: BOOTSTRAP_ASSET_COUNT,
      message: `正在载入第 ${campaignLevel.campaign.levelNumber} 关 · ${campaignLevel.campaign.themeLabel}高精度场景…`,
    });
    setPhase("ready");
    setPlayerMode("free");
    setChaserMode("spawn-delay");
    setElapsed(0);
    setLastCaptureReason(null);
    setObjectiveDistance(objectiveDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths));
    setHideDistance(nearestHideDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths));
    setHideGuideProjection(null);
    setHideGuideRisk("medium");
    setHideGuideSelection("nearest");

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
    let guidedLockerId: string | null = null;
    let guidedLockerRisk: HideGuidanceRisk = "medium";
    let playerKnownChaser: PlayerKnownChaserEvidence | null = null;
    let lastScoreThreat = Number.NaN;
    let captureStageRemaining = 0;
    let capturePerformanceStarted = false;
    const artLayout = levelArtLayout(
      campaignLevel.campaign.theme,
      campaignLevel.campaign.atmosphere.propSet,
    );
    let simulation = new GameSimulation({ level: campaignLevel, config: gameplayConfig });
    let latestState = simulation.getState();
    const resetFrameClock = () => {
      if (document.visibilityState === "visible") last = performance.now();
    };
    const cameraZoom = { value: 1 };
    const actors: Partial<Record<ActorName, ActorView>> = {};
    const lockers = new Map<string, LockerView>();
    const sightObscurers: THREE.Points[] = [];
    const loadedAssetIds = new Set<string>();
    const placedAssetIds = new Set<string>();
    let renderedMovementBlockers = 0;
    const deviceNavigator = navigator as Navigator & { deviceMemory?: number };
    const initialBounds = host.getBoundingClientRect();
    const coarsePointer = matchMedia("(pointer: coarse)").matches;
    let cameraViewportWidth = Math.max(1, Math.round(initialBounds.width));
    let cameraViewportHeight = Math.max(1, Math.round(initialBounds.height));
    let cameraSafeViewport = cameraSafeViewportFromInsets(
      cameraViewportWidth,
      cameraViewportHeight,
      gameplayCameraInsetsForViewport(cameraViewportWidth, cameraViewportHeight, coarsePointer),
    );
    let renderQualityTier: RenderQualityTier = selectInitialRenderQuality({
      viewportWidth: Math.max(1, initialBounds.width),
      viewportHeight: Math.max(1, initialBounds.height),
      devicePixelRatio,
      coarsePointer,
      deviceMemoryGb: deviceNavigator.deviceMemory,
      hardwareConcurrency: navigator.hardwareConcurrency,
    });
    let renderQualityProfile: RenderQualityProfile = RENDER_QUALITY_PROFILES[renderQualityTier];
    let qualitySamples: number[] = [];
    let qualityEvaluationSeconds = 0;
    let qualityDecisionSeconds = 0;
    let qualityCandidate: RenderQualityTier = renderQualityTier;
    const score = new AdaptiveScoreController();
    const soundscape = new ImmersiveSoundscapeController(campaignLevel.campaign.theme);
    try {
      const storedMuted = localStorage.getItem("chasing.music-muted.v1") === "true";
      score.setMuted(storedMuted);
      soundscape.setMuted(storedMuted);
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
      atmosphere.fogDensity,
    );
    const camera = new THREE.PerspectiveCamera(56, 1, 0.08, 150);
    const cameraDirection = createFixedCameraDirection();
    const cameraFocus = world(campaignLevel.playerStart, campaignLevel).add(new THREE.Vector3(0, 0.92, 0));
    const cameraPlayfieldBounds = {
      minX: -((campaignLevel.width - 1) / 2) * CELL,
      maxX: ((campaignLevel.width - 1) / 2) * CELL,
      minZ: -((campaignLevel.height - 1) / 2) * CELL,
      maxZ: ((campaignLevel.height - 1) / 2) * CELL,
    };
    camera.position.copy(cameraFocus).addScaledVector(cameraDirection, cameraDistance);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: renderQualityTier !== "mobile",
        alpha: false,
        powerPreference: "high-performance",
      });
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
    renderer.toneMappingExposure = atmosphere.exposure;
    const supportsMultiDraw = renderer.extensions.has("WEBGL_multi_draw")
      && !new URLSearchParams(location.search).has("no-multi-draw");
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
    scene.environmentIntensity = atmosphere.environmentIntensity;
    roomEnvironment.dispose();
    pmrem.dispose();

    const hemisphere = new THREE.HemisphereLight(
      new THREE.Color(campaignLevel.campaign.palette.sky).offsetHSL(0, 0, 0.25),
      new THREE.Color(campaignLevel.campaign.palette.floor).multiplyScalar(0.34),
      atmosphere.hemisphereIntensity,
    );
    scene.add(hemisphere);
    const moon = new THREE.DirectionalLight(
      campaignLevel.campaign.theme === "factory" ? 0x91dced : 0xb9d7ff,
      atmosphere.keyIntensity,
    );
    moon.position.set(14, 28, 18);
    moon.castShadow = true;
    moon.shadow.mapSize.set(renderQualityProfile.shadowMapSize, renderQualityProfile.shadowMapSize);
    moon.shadow.camera.left = -32;
    moon.shadow.camera.right = 32;
    moon.shadow.camera.top = 32;
    moon.shadow.camera.bottom = -32;
    moon.shadow.bias = -0.00025;
    moon.shadow.normalBias = 0.018;
    scene.add(moon);
    const warmBounceColor = new THREE.Color(campaignLevel.campaign.palette.emissive).lerp(
      new THREE.Color(campaignLevel.campaign.palette.accent),
      artLayout.warmLightMix * 0.32,
    );
    const warmBounce = new THREE.DirectionalLight(
      warmBounceColor,
      atmosphere.bounceIntensity * (0.72 + artLayout.warmLightMix * 0.28),
    );
    warmBounce.position.set(-18, 12, -14);
    scene.add(warmBounce);

    const atmosphereParticleCount = atmosphere.particleKind === "none" ? 0 : atmosphere.particleCount;
    const atmospherePositions = new Float32Array(atmosphereParticleCount * 3);
    const atmosphereSeeds = new Float32Array(atmosphereParticleCount);
    let atmosphereRandomState = (campaignLevel.campaign.levelNumber * 0x9e3779b1) >>> 0;
    const atmosphereRandom = () => {
      atmosphereRandomState ^= atmosphereRandomState << 13;
      atmosphereRandomState ^= atmosphereRandomState >>> 17;
      atmosphereRandomState ^= atmosphereRandomState << 5;
      return (atmosphereRandomState >>> 0) / 0x1_0000_0000;
    };
    const atmosphereWidth = campaignLevel.width * CELL + 12;
    const atmosphereDepth = campaignLevel.height * CELL + 12;
    for (let index = 0; index < atmosphereParticleCount; index += 1) {
      atmospherePositions[index * 3] = (atmosphereRandom() - 0.5) * atmosphereWidth;
      atmospherePositions[index * 3 + 1] = 0.35 + atmosphereRandom() * 5.8;
      atmospherePositions[index * 3 + 2] = (atmosphereRandom() - 0.5) * atmosphereDepth;
      atmosphereSeeds[index] = atmosphereRandom();
    }
    const atmosphereGeometry = new THREE.BufferGeometry();
    atmosphereGeometry.setAttribute("position", new THREE.BufferAttribute(atmospherePositions, 3));
    atmosphereGeometry.setDrawRange(
      0,
      Math.floor(atmosphereParticleCount * renderQualityProfile.atmosphericParticleScale),
    );
    const atmosphereTexture = createAtmosphereParticleTexture(atmosphere.particleKind);
    const atmosphereMaterial = new THREE.PointsMaterial({
      map: atmosphereTexture,
      color: atmosphere.particleColor,
      transparent: true,
      opacity: atmosphere.particleKind === "steam" ? 0.14 : atmosphere.particleKind === "rain" ? 0.24 : 0.32,
      depthWrite: false,
      alphaTest: 0.008,
      size: atmosphere.particleKind === "steam" ? 1.15 : atmosphere.particleKind === "rain" ? 0.34 : 0.18,
      sizeAttenuation: true,
      blending: atmosphere.particleKind === "embers" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const atmosphereField = new THREE.Points(atmosphereGeometry, atmosphereMaterial);
    atmosphereField.name = `level-atmosphere-${atmosphere.particleKind}`;
    atmosphereField.frustumCulled = false;
    atmosphereField.renderOrder = 1;
    scene.add(atmosphereField);

    const applyRenderQuality = (tier: RenderQualityTier) => {
      renderQualityTier = tier;
      renderQualityProfile = RENDER_QUALITY_PROFILES[tier];
      const bounds = host.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(devicePixelRatio, renderQualityProfile.maximumPixelRatio));
      renderer.setSize(
        Math.max(1, Math.round(bounds.width)),
        Math.max(1, Math.round(bounds.height)),
        false,
      );
      if (moon.shadow.mapSize.x !== renderQualityProfile.shadowMapSize) {
        moon.shadow.mapSize.set(renderQualityProfile.shadowMapSize, renderQualityProfile.shadowMapSize);
        moon.shadow.map?.dispose();
        moon.shadow.map = null;
        moon.shadow.needsUpdate = true;
      }
      atmosphereGeometry.setDrawRange(
        0,
        Math.floor(atmosphereParticleCount * renderQualityProfile.atmosphericParticleScale),
      );
      document.documentElement.dataset.chasingQuality = tier;
    };
    applyRenderQuality(renderQualityTier);

    const contactTexture = createContactShadowTexture();
    const campus = new THREE.Group();
    campus.name = "authored-campus";
    scene.add(campus);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const cameraOcclusionOrigin = { value: new THREE.Vector3() };
    const cameraOcclusionTarget = { value: new THREE.Vector3() };
    const cameraOcclusionTargetB = { value: new THREE.Vector3() };
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
        shader.uniforms.cameraOcclusionTargetB = cameraOcclusionTargetB;
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
uniform vec3 cameraOcclusionTargetB;
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
vec3 cameraOcclusionSegmentB = cameraOcclusionTargetB - cameraOcclusionOrigin;
float cameraOcclusionLengthSquaredB = max( dot( cameraOcclusionSegmentB, cameraOcclusionSegmentB ), 0.0001 );
float cameraOcclusionAlongB = clamp(
  dot( vCameraOccluderWorldPosition - cameraOcclusionOrigin, cameraOcclusionSegmentB ) / cameraOcclusionLengthSquaredB,
  0.0,
  1.0
);
vec3 cameraOcclusionClosestB = cameraOcclusionOrigin + cameraOcclusionSegmentB * cameraOcclusionAlongB;
float cameraOcclusionDistanceB = distance( vCameraOccluderWorldPosition, cameraOcclusionClosestB );
float cameraOcclusionCorridorB = 1.0 - smoothstep( 0.58, 1.08, cameraOcclusionDistanceB );
float cameraOcclusionEndsB = smoothstep( 0.035, 0.12, cameraOcclusionAlongB )
  * ( 1.0 - smoothstep( 0.985, 1.0, cameraOcclusionAlongB ) );
float cameraOcclusionFade = cameraOcclusionStrength * max(
  cameraOcclusionCorridor * cameraOcclusionEnds,
  cameraOcclusionCorridorB * cameraOcclusionEndsB
);
${pass === "opaque-cutout"
    ? "if ( cameraOcclusionFade > 0.002 ) discard;"
    : `if ( cameraOcclusionFade <= 0.002 ) discard;
diffuseColor.a *= mix( 1.0, 0.12, cameraOcclusionFade );`}
#include <alphahash_fragment>`,
          );
      };
      material.customProgramCacheKey = () => `${previousProgramKey}|camera-occlusion-v3-${pass}`;
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

    const updateCameraOcclusion = (readableAnchors: readonly THREE.Vector3[], delta: number) => {
      const primaryAnchor = readableAnchors[0];
      if (!primaryAnchor) return;
      cameraOcclusionOrigin.value.copy(camera.position);
      cameraOcclusionTarget.value.copy(primaryAnchor);
      cameraOcclusionTargetB.value.copy(readableAnchors[1] ?? primaryAnchor);
      occlusionRaycastRemaining -= delta;
      if (occlusionRaycastRemaining <= 0) {
        occlusionRaycastRemaining = 0.075;
        for (const occluder of cameraOccluders) occluder.obscured = false;
        if (occlusionMeshes.length) {
          // One torso ray is not enough for an elevated camera: it can clear a
          // wall cap while the same wall still hides the player's legs. Sample
          // the full readable silhouette, including both shoulders.
          occlusionScreenRight.set(cameraDirection.z, 0, -cameraDirection.x).normalize();
          for (const anchor of readableAnchors.slice(0, 2)) {
            occlusionSamplePoints[0].copy(anchor);
            occlusionSamplePoints[1].copy(anchor).y -= 0.72;
            occlusionSamplePoints[2].copy(anchor).y += 0.54;
            occlusionSamplePoints[3].copy(anchor).addScaledVector(occlusionScreenRight, 0.3);
            occlusionSamplePoints[4].copy(anchor).addScaledVector(occlusionScreenRight, -0.3);
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
      guidedLockerId = null;
      guidedLockerRisk = "medium";
      playerKnownChaser = null;
      setHideGuideRisk("medium");
      setHideGuideSelection("nearest");
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
      setLastCaptureReason(state.captureReason);
      setObjectiveDistance(objectiveDistanceMeters(state.player.position, campaignLevel, objectivePaths));
      setHideDistance(nearestHideDistanceMeters(state.player.position, campaignLevel, objectivePaths));
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
        locker.beacon.visible = false;
        locker.beaconLight.intensity = 0;
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
      void soundscape.unlock();
    };

    commands.current = {
      begin: beginGame,
      restart: beginGame,
      interact() {
        if (!ready) return;
        void score.unlock();
        void soundscape.unlock();
        interactPressed.current = true;
      },
      toggleMute() {
        setMusicMuted((current) => {
          score.setMuted(!current);
          soundscape.setMuted(!current);
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

    const loadGlbWithRetry = async (url: string) => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await loader.loadAsync(url);
        } catch (error) {
          lastError = error;
          if (attempt < 2) {
            await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 280 : 760));
          }
        }
      }
      throw lastError;
    };

    const loadAll = async () => {
      let done = 0;
      const requiredDetailNames = new Set<DetailAssetName>(["locker", "ceilingLight"]);
      for (const [name] of THEME_SHARED_PROPS[campaignLevel.campaign.theme]) requiredDetailNames.add(name);
      for (const placement of PROP_SET_STANDALONE_PROPS[campaignLevel.campaign.atmosphere.propSet] ?? []) {
        requiredDetailNames.add(placement.asset);
      }
      for (let index = 0; index < (campaignLevel.movementBlockers?.length ?? 0); index += 1) {
        const contract = MOVEMENT_PROP_CONTRACT[index];
        if (!contract) throw new Error(`${campaignLevel.id} 缺少第 ${index + 1} 个实体障碍美术契约`);
        requiredDetailNames.add(contract[0]);
      }
      const structureEntries = Object.entries(STRUCTURE_ASSETS) as [StructureAssetName, string][];
      const detailEntries = [...requiredDetailNames].map((name) => [name, DETAIL_ASSETS[name]] as const);
      const essentialActorEntries = (Object.entries(ACTOR_SPECS) as [ActorName, (typeof ACTOR_SPECS)[ActorName]][])
        .filter(([name]) => name !== "police");
      const total = BOOTSTRAP_ASSET_COUNT + structureEntries.length + detailEntries.length;
      const mark = (message: string) => {
        done += 1;
        if (!disposed) setLoadProgress({ done, total, message: `正在载入首局所需素材：${message} ${done}/${total}` });
      };
      const actorAssets: Partial<Record<ActorName, GLTF>> = {};
      const structureAssets: Partial<Record<StructureAssetName, GLTF>> = {};
      const detailAssets: Partial<Record<DetailAssetName, GLTF>> = {};
      const loadedAssets: LoadedAsset[] = [];
      let themeKitAsset: GLTF | undefined;
      if (!disposed) {
        setLoadProgress({
          done,
          total,
          message: `正在并行载入主角、追捕者与${campaignLevel.campaign.themeLabel}主题场景…`,
        });
      }

      // Eliminate the former two-stage waterfall: every visible first-play
      // asset starts together, while the large exit-only police actor no
      // longer gates control.
      const initialLoads = [
        ...essentialActorEntries.map(async ([name, spec]) => {
          const asset = await loadGlbWithRetry(spec.url);
          actorAssets[name] = asset;
          const id = `actor:${name}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          mark(name === "kid" ? "主角动作集" : "追捕者动作集");
        }),
        (async () => {
          const asset = await loadGlbWithRetry(THEME_KIT_ASSETS[campaignLevel.campaign.theme]);
          themeKitAsset = asset;
          const id = `theme:${campaignLevel.campaign.theme}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          mark(`${campaignLevel.campaign.themeLabel}高精度主题模型`);
        })(),
        ...structureEntries.map(async ([name, url]) => {
          const asset = await loadGlbWithRetry(url);
          structureAssets[name] = asset;
          const id = `structure:${name}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          mark(name === "frontGate" ? "入口建筑模型" : "出口建筑模型");
        }),
        ...detailEntries.map(async ([name, url]) => {
          const asset = await loadGlbWithRetry(url);
          detailAssets[name] = asset;
          const id = `detail:${name}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          mark(name === "locker" ? "英雄储物柜与门动画" : "关卡叙事物件");
        }),
      ];
      const settled = await Promise.allSettled(initialLoads);
      const rejection = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (disposed || rejection) {
        disposeObjectResources(loadedAssets.map(({ asset }) => asset.scene));
        if (rejection) throw rejection.reason;
        return;
      }
      if (!themeKitAsset) throw new Error(`${campaignLevel.campaign.themeLabel}主题模型未载入`);

      configureAssetTextures(loadedAssets, renderer);
      textureDeduplication = deduplicateAssetTextures(loadedAssets);
      buildCampus(structureAssets, themeKitAsset, campus);
      buildDetails(detailAssets, themeKitAsset, campus, scene, lockers);
      placeActors(actorAssets, actors, scene, ["kid", "villain"]);
      ready = true;
      setLoading(false);
      setLoadError("");
      document.documentElement.dataset.chasingReady = "true";
      if (new URLSearchParams(location.search).get("autostart") === "1") beginGame();

      // Stream the resolution actor only after control is available. A load
      // failure cannot invalidate the playable chase; retries happen at asset
      // level and a later chapter rebuild gets another clean attempt.
      void (async () => {
        try {
          const policeAsset = await loadGlbWithRetry(ACTOR_SPECS.police.url);
          if (disposed) {
            disposeObjectResources([policeAsset.scene]);
            return;
          }
          actorAssets.police = policeAsset;
          const loadedPolice = { id: "actor:police", asset: policeAsset };
          loadedAssets.push(loadedPolice);
          loadedAssetIds.add(loadedPolice.id);
          configureAssetTextures([loadedPolice], renderer);
          textureDeduplication = deduplicateAssetTextures(loadedAssets);
          placeActors(actorAssets, actors, scene, ["police"]);
          if (latestState.phase === "won" && actors.police) {
            requestAnimation(actors.police, "protect", { fade: 0.08 });
          }
        } catch (error) {
          console.warn("Exit resolution actor will retry on the next scene load", error);
        }
      })();
    };

    const buildCampus = (
      structureAssets: Partial<Record<StructureAssetName, GLTF>>,
      themeKit: GLTF,
      parent: THREE.Group,
    ) => {
      const { palette, theme } = campaignLevel.campaign;
      placedAssetIds.add(`theme:${theme}`);
      const requireStructure = (name: StructureAssetName) => {
        const asset = structureAssets[name];
        if (!asset) throw new Error(`${campaignLevel.campaign.themeLabel}缺少结构资产 ${name}`);
        return asset.scene;
      };
      const requireThemeModule = (candidates: readonly string[], label: string) => {
        const themeModule = resolveThemeNode(themeKit.scene, theme, candidates);
        if (!themeModule) {
          throw new Error(`${campaignLevel.campaign.themeLabel}主题套件缺少${label}模块`);
        }
        return themeModule;
      };

      const floorBatches: Record<ThemeFloorRole, ModulePlacement[]> = {
        primary: [], secondary: [], service: [],
      };
      const wallBatches: Record<"a" | "b" | "c" | "wide" | "end" | "corner" | "doorway" | "junction", ModulePlacement[]> = {
        a: [], b: [], c: [], wide: [], end: [], corner: [], doorway: [], junction: [],
      };
      const junctionCandidates: Array<ModulePlacement & { degree: number; hash: number }> = [];
      const groundMarginCells = 2;
      const entranceDirection = nearestExteriorDirection(campaignLevel.playerStart, campaignLevel);
      const exitDirection = nearestExteriorDirection(campaignLevel.exit, campaignLevel);
      // Every authored wall faces local +Z. Opposite maze edges therefore need
      // opposite rotations; the previous axis-only rotation showed the back of
      // roughly half of every asymmetric wall kit.
      const directions = [
        { dx: 0, dy: -1, ox: 0, oz: -CELL / 2, rotation: 0, tx: 1, ty: 0 },
        { dx: 0, dy: 1, ox: 0, oz: CELL / 2, rotation: Math.PI, tx: 1, ty: 0 },
        { dx: -1, dy: 0, ox: -CELL / 2, oz: 0, rotation: Math.PI / 2, tx: 0, ty: 1 },
        { dx: 1, dy: 0, ox: CELL / 2, oz: 0, rotation: -Math.PI / 2, tx: 0, ty: 1 },
      ] as const;
      const cornerKeys = new Set<string>();
      const isAnchorEdge = (x: number, y: number, dx: number, dy: number, anchor: Point, outward: Point) => (
        Math.round(anchor.x) === x
        && Math.round(anchor.y) === y
        && dx === outward.x
        && dy === outward.y
      );
      for (let y = 0; y < campaignLevel.height; y += 1) {
        for (let x = 0; x < campaignLevel.width; x += 1) {
          if (!campaignLevel.walkable[y][x]) continue;
          const position = world({ x, y }, campaignLevel);
          const band = Math.abs(
            Math.floor(x / 5)
            + Math.floor(y / 5) * 3
            + campaignLevel.campaign.levelNumber
            + artLayout.wallVariantSalt,
          );
          const floorRole = artLayout.floorCycle[band % artLayout.floorCycle.length];
          floorBatches[floorRole].push({ position, rotation: 0 });

          const degree = directions.reduce(
            (count, { dx, dy }) => count + (campaignLevel.walkable[y + dy]?.[x + dx] ? 1 : 0),
            0,
          );
          if (degree >= 3) {
            junctionCandidates.push({
              position: position.clone(),
              rotation: ((x * 17 + y * 29 + artLayout.wallVariantSalt) % 4) * Math.PI / 2,
              degree,
              hash: (x * 73 + y * 101 + artLayout.wallVariantSalt) % 257,
            });
          }

          const blocked = directions.filter(({ dx, dy }) => !campaignLevel.walkable[y + dy]?.[x + dx]);
          for (const edge of blocked) {
            const placement = {
              position: position.clone().add(new THREE.Vector3(edge.ox, 0, edge.oz)),
              rotation: edge.rotation,
            };
            if (
              isAnchorEdge(x, y, edge.dx, edge.dy, campaignLevel.playerStart, entranceDirection)
              || isAnchorEdge(x, y, edge.dx, edge.dy, campaignLevel.exit, exitDirection)
            ) {
              wallBatches.doorway.push(placement);
              continue;
            }
            const boundaryContinues = (sign: -1 | 1) => {
              const adjacentX = x + edge.tx * sign;
              const adjacentY = y + edge.ty * sign;
              return Boolean(campaignLevel.walkable[adjacentY]?.[adjacentX])
                && !campaignLevel.walkable[adjacentY + edge.dy]?.[adjacentX + edge.dx];
            };
            const continuesBefore = boundaryContinues(-1);
            const continuesAfter = boundaryContinues(1);
            if (!continuesBefore || !continuesAfter) {
              wallBatches.end.push(placement);
            } else {
              const variant = wallVariantIndex(x, y, edge.dx, edge.dy, artLayout.wallVariantSalt);
              wallBatches[variant === 0 ? "a" : variant === 1 ? "b" : "c"].push(placement);
            }
          }
          if (blocked.length >= 2) {
            for (let a = 0; a < blocked.length; a += 1) {
              for (let b = a + 1; b < blocked.length; b += 1) {
                if (blocked[a].dx === -blocked[b].dx && blocked[a].dy === -blocked[b].dy) continue;
                const cornerPosition = position.clone().add(new THREE.Vector3(
                  blocked[a].ox + blocked[b].ox,
                  0,
                  blocked[a].oz + blocked[b].oz,
                ));
                const key = `${Math.round(cornerPosition.x * 100)},${Math.round(cornerPosition.z * 100)}`;
                if (cornerKeys.has(key)) continue;
                cornerKeys.add(key);
                wallBatches.corner.push({
                  position: cornerPosition,
                  rotation: Math.atan2(
                    -(blocked[a].dx + blocked[b].dx),
                    -(blocked[a].dy + blocked[b].dy),
                  ),
                });
              }
            }
          }
        }
      }

      // Replace pairs along continuous boundaries with an authored four-metre
      // elevation. Besides reducing the picket-fence rhythm, this removes the
      // fake structural post that used to appear at every two-metre cell.
      const consumedStraightWalls = new Set<ModulePlacement>();
      const straightWallLanes = new Map<string, Array<{ placement: ModulePlacement; tangent: number }>>();
      for (const variant of ["a", "b", "c"] as const) {
        for (const placement of wallBatches[variant]) {
          const normalizedRotation = ((placement.rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          const tangentUsesX = Math.abs(Math.cos(normalizedRotation)) > 0.5;
          const lane = tangentUsesX ? placement.position.z : placement.position.x;
          const tangent = tangentUsesX ? placement.position.x : placement.position.z;
          const key = `${Math.round(normalizedRotation * 1_000)}:${Math.round(lane * 100)}`;
          const entries = straightWallLanes.get(key) ?? [];
          entries.push({ placement, tangent });
          straightWallLanes.set(key, entries);
        }
      }
      for (const entries of straightWallLanes.values()) {
        entries.sort((left, right) => left.tangent - right.tangent);
        for (let index = 0; index + 1 < entries.length;) {
          const left = entries[index];
          const right = entries[index + 1];
          if (Math.abs(right.tangent - left.tangent - CELL) <= 0.02) {
            wallBatches.wide.push({
              position: left.placement.position.clone().lerp(right.placement.position, 0.5),
              rotation: left.placement.rotation,
            });
            consumedStraightWalls.add(left.placement);
            consumedStraightWalls.add(right.placement);
            index += 2;
          } else {
            index += 1;
          }
        }
      }
      for (const variant of ["a", "b", "c"] as const) {
        wallBatches[variant] = wallBatches[variant].filter((placement) => !consumedStraightWalls.has(placement));
      }

      // Choice landmarks turn abstract maze nodes into readable places. Keep
      // them far enough apart that each one marks a genuine route decision,
      // rather than creating another repeated module rhythm.
      junctionCandidates.sort((a, b) => b.degree - a.degree || a.hash - b.hash);
      const junctionLimit = Math.min(8, 3 + Math.ceil(campaignLevel.campaign.difficulty));
      for (const candidate of junctionCandidates) {
        if (wallBatches.junction.every(({ position }) => position.distanceTo(candidate.position) >= CELL * 3.25)) {
          wallBatches.junction.push({ position: candidate.position, rotation: candidate.rotation });
        }
        if (wallBatches.junction.length >= junctionLimit) break;
      }

      const wallHeight = theme === "hospital" ? 2.2 : theme === "factory" ? 2.16 : 2.1;
      const authoredArchitectureWall = themeKit.scene.getObjectByName(THEME_WALL_NODES[theme])
        ?? resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallA", "ArchitectureWall_A", "WallA"]);
      if (!authoredArchitectureWall) throw new Error(`${campaignLevel.campaign.themeLabel}主题套件缺少建筑墙体模块`);
      const architectureWall = authoredArchitectureWall;
      const wallA = resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallA", "ArchitectureWall_A", "WallA"]) ?? architectureWall;
      const wallB = resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallB", "ArchitectureWall_B", "WallB"]) ?? architectureWall;
      const wallC = resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallC", "ArchitectureWall_C", "WallC"]) ?? architectureWall;
      const wallEnd = resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallEnd", "ArchitectureEndWall", "WallEnd"]) ?? architectureWall;
      const wallCorner = requireThemeModule(["ArchitectureCorner", "ArchitectureCornerPost", "CornerPost"], "墙角");
      const wallDoorway = requireThemeModule(["ArchitectureDoorway", "ArchitectureDoorFrame", "Doorway"], "门洞");
      const wallWide = requireThemeModule(["ArchitectureWallWide", "ArchitectureWideWall", "WallWide"], "四米连续墙");
      const wallJunction = requireThemeModule(["ArchitectureJunction", "JunctionPortal", "ChoiceLandmark"], "路口地标");
      // Long boundaries keep their premium continuous module everywhere. On
      // browsers without multi-draw, the few unpaired one-cell remainders use
      // A so quality remains authored while avoiding two entire material sets.
      const runtimeWallB = supportsMultiDraw ? wallB : wallA;
      const runtimeWallC = supportsMultiDraw ? wallC : wallA;
      for (const [source, placements] of [
        [wallA, wallBatches.a],
        [runtimeWallB, wallBatches.b],
        [runtimeWallC, wallBatches.c],
        [wallWide, wallBatches.wide],
        [wallEnd, wallBatches.end],
        [wallDoorway, wallBatches.doorway],
      ] as const) {
        if (placements.length) placedAssetIds.add(`theme-node:${source.name}`);
      }
      if (wallBatches.corner.length) placedAssetIds.add(`theme-node:${wallCorner.name}`);
      if (wallBatches.junction.length) placedAssetIds.add(`theme-node:${wallJunction.name}`);
      const wallMeshes = [
        ...addInstancedModuleBatches([
          { source: wallA, placements: wallBatches.a, preserveAuthoredScale: true },
          { source: runtimeWallB, placements: wallBatches.b, preserveAuthoredScale: true },
          { source: runtimeWallC, placements: wallBatches.c, preserveAuthoredScale: true },
          { source: wallWide, placements: wallBatches.wide, preserveAuthoredScale: true },
          { source: wallEnd, placements: wallBatches.end, preserveAuthoredScale: true },
          { source: wallDoorway, placements: wallBatches.doorway, preserveAuthoredScale: true },
        ], new THREE.Vector3(CELL + 0.08, wallHeight, 0.23), parent, true, `${theme}-wall`, supportsMultiDraw),
        ...addInstancedModuleBatches([
          { source: wallCorner, placements: wallBatches.corner, preserveAuthoredScale: true },
        ], new THREE.Vector3(0.32, wallHeight, 0.32), parent, true, `${theme}-corner`, supportsMultiDraw),
        ...addInstancedModuleBatches([
          { source: wallJunction, placements: wallBatches.junction, preserveAuthoredScale: true },
        ], new THREE.Vector3(CELL, 2.7, CELL), parent, true, `${theme}-junction`, supportsMultiDraw),
      ];
      registerCameraOccluder(`${theme}-walls`, wallMeshes);

      const wallContactGeometry = new THREE.PlaneGeometry(CELL + 0.12, 0.48);
      wallContactGeometry.rotateX(-Math.PI / 2);
      const wallContactMaterial = new THREE.MeshBasicMaterial({
        color: theme === "hospital" ? 0x26383b : 0x11171b,
        map: contactTexture,
        transparent: true,
        opacity: theme === "hospital" ? 0.28 : 0.34,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        side: THREE.DoubleSide,
      });
      const wallContactPlacements = [
        ...wallBatches.a,
        ...wallBatches.b,
        ...wallBatches.c,
        ...wallBatches.wide.flatMap((placement) => {
          const tangent = new THREE.Vector3(Math.cos(placement.rotation), 0, -Math.sin(placement.rotation));
          return [
            { position: placement.position.clone().addScaledVector(tangent, -CELL / 2), rotation: placement.rotation },
            { position: placement.position.clone().addScaledVector(tangent, CELL / 2), rotation: placement.rotation },
          ];
        }),
        ...wallBatches.end,
        ...wallBatches.doorway,
      ];
      const wallContacts = new THREE.InstancedMesh(
        wallContactGeometry,
        wallContactMaterial,
        wallContactPlacements.length,
      );
      const contactScale = new THREE.Vector3(1, 1, 1);
      wallContactPlacements.forEach((placement, index) => {
        const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotation);
        const offset = new THREE.Vector3(Math.sin(placement.rotation) * 0.1, 0.112, Math.cos(placement.rotation) * 0.1);
        wallContacts.setMatrixAt(
          index,
          new THREE.Matrix4().compose(placement.position.clone().add(offset), rotation, contactScale),
        );
      });
      wallContacts.instanceMatrix.needsUpdate = true;
      wallContacts.name = `${theme}-wall-contact-shadows`;
      wallContacts.renderOrder = 1;
      parent.add(wallContacts);
      placedAssetIds.add("runtime:wall-contact-shadows");

      const authoredFloorPrimary = requireThemeModule(
        [`${artLayout.key}FloorPrimary`, "FloorPrimary", "ArchitectureFloorPrimary"],
        "主地面",
      );
      const authoredFloorSecondary = requireThemeModule(
        [`${artLayout.key}FloorSecondary`, "FloorSecondary", "ArchitectureFloorSecondary"],
        "辅地面",
      );
      const authoredFloorService = requireThemeModule(
        [`${artLayout.key}FloorService`, "FloorService", "ArchitectureFloorService"],
        "功能地面",
      );
      const floorSources: Record<ThemeFloorRole, THREE.Object3D> = {
        primary: authoredFloorPrimary,
        secondary: authoredFloorSecondary,
        service: authoredFloorService,
      };
      for (const role of ["primary", "secondary", "service"] as const) {
        if (!floorBatches[role].length) continue;
        const source = floorSources[role];
        placedAssetIds.add(`theme-node:${source.name}`);
      }
      addInstancedModuleBatches([
        { source: floorSources.primary, placements: floorBatches.primary, preserveAuthoredScale: true },
        { source: floorSources.secondary, placements: floorBatches.secondary, preserveAuthoredScale: true },
        { source: floorSources.service, placements: floorBatches.service, preserveAuthoredScale: true },
      ], new THREE.Vector3(CELL, 0.12, CELL), parent, false, `${theme}-floor`, supportsMultiDraw);

      const authoredGround = requireThemeModule(
        [`${artLayout.key}ExteriorGround`, "ExteriorGround", "GroundPrimary"],
        "外部地面",
      );
      const groundAsset = authoredGround;
      let groundMaterial: THREE.MeshStandardMaterial | undefined;
      groundAsset.traverse((object) => {
        if (groundMaterial || !(object instanceof THREE.Mesh)) return;
        const source = Array.isArray(object.material) ? object.material[0] : object.material;
        if (source instanceof THREE.MeshStandardMaterial) groundMaterial = source.clone();
      });
      if (!groundMaterial) throw new Error(`${campaignLevel.campaign.themeLabel}地表材质缺失`);
      const exteriorTone: Readonly<Record<CampaignTheme, THREE.ColorRepresentation>> = {
        campus: 0x18382d,
        hospital: 0x31434b,
        "fire-station": 0x202426,
        factory: 0x22292e,
      };
      // Preserve the authored maps and normal response, but use an explicit
      // albedo factor: retaining a bright source factor lets the key light turn
      // charcoal asphalt into a beige/white exhibition slab.
      groundMaterial.color.set(exteriorTone[theme]);
      groundMaterial.roughness = theme === "fire-station" ? 0.9 : theme === "campus" ? 0.88 : 0.84;
      groundMaterial.metalness = Math.min(groundMaterial.metalness, 0.04);
      groundMaterial.emissive.set(0x000000);
      groundMaterial.emissiveIntensity = 0;
      groundMaterial.emissiveMap = null;

      // A giant rectangular plane made the maze read like a model sitting on
      // an empty white exhibition table. Build a two-cell, maze-shaped
      // exterior patch instead: it follows the navigable silhouette, leaves
      // no enormous unused slab in concave voids, and costs only two instanced
      // draws (main paving plus a darker perimeter transition).
      const groundPatch: Array<{ point: Point }> = [];
      const plazaCenters = [
        {
          x: campaignLevel.playerStart.x + entranceDirection.x * 3.15,
          y: campaignLevel.playerStart.y + entranceDirection.y * 3.15,
        },
        {
          x: campaignLevel.exit.x + exitDirection.x * 3.05,
          y: campaignLevel.exit.y + exitDirection.y * 3.05,
        },
      ];
      const plazaDirections = [entranceDirection, exitDirection];
      const authoredPlazaPlacements = plazaCenters.map((center, index) => {
        const position = world(center, campaignLevel);
        // The authored slab includes its own curb, cracks and markings. Sink
        // its structural base into the continuous courtyard patch so the
        // detailed top surface meets the route without a visible step.
        position.y = -0.115;
        return {
          position,
          rotation: Math.atan2(-plazaDirections[index].x, -plazaDirections[index].y),
        };
      });
      addInstancedModuleBatches([
        { source: authoredGround, placements: authoredPlazaPlacements, preserveAuthoredScale: true },
      ], new THREE.Vector3(CELL * 2, 0.18, CELL * 2), parent, false, `${theme}-authored-plaza`, supportsMultiDraw);
      placedAssetIds.add(`theme-node:${authoredGround.name}:entrance-plaza`);
      placedAssetIds.add(`theme-node:${authoredGround.name}:exit-plaza`);
      const groundSearchMargin = 7;
      for (let y = -groundSearchMargin; y < campaignLevel.height + groundSearchMargin; y += 1) {
        for (let x = -groundSearchMargin; x < campaignLevel.width + groundSearchMargin; x += 1) {
          if (campaignLevel.walkable[y]?.[x]) continue;
          let nearest = groundMarginCells + 1;
          for (let oy = -groundMarginCells; oy <= groundMarginCells; oy += 1) {
            for (let ox = -groundMarginCells; ox <= groundMarginCells; ox += 1) {
              if (!campaignLevel.walkable[y + oy]?.[x + ox]) continue;
              nearest = Math.min(nearest, Math.max(Math.abs(ox), Math.abs(oy)));
            }
          }
          const plazaDistance = Math.min(...plazaCenters.map((center) => Math.hypot(x - center.x, y - center.y)));
          const inPlaza = plazaDistance <= 3.25;
          if (nearest <= groundMarginCells || inPlaza) {
            groundPatch.push({ point: { x, y } });
          }
        }
      }
      const groundGeometry = new THREE.PlaneGeometry(CELL * 1.035, CELL * 1.035);
      const groundRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
      const ground = new THREE.InstancedMesh(groundGeometry, groundMaterial.clone(), groundPatch.length);
      ground.name = `${theme}-courtyard-ground-patch`;
      groundPatch.forEach((patch, index) => {
        const position = world(patch.point, campaignLevel);
        position.y = -0.125;
        ground.setMatrixAt(index, new THREE.Matrix4().compose(position, groundRotation, new THREE.Vector3(1, 1, 1)));
      });
      ground.instanceMatrix.needsUpdate = true;
      ground.receiveShadow = true;
      ground.computeBoundingBox();
      ground.computeBoundingSphere();
      parent.add(ground);

      // The local tile patch supplies readable courtyard/service detail. A
      // separate, very dark repeated ground field continues beneath the fog so
      // an ultrawide or zoomed-out camera never reveals a blue void or a hard
      // rectangular edge. Its low-saturation theme tone stays background, not
      // a brightly lit exhibition table.
      const horizonMaterial = groundMaterial.clone();
      const horizonTone: Readonly<Record<CampaignTheme, THREE.ColorRepresentation>> = {
        campus: 0x162b26,
        hospital: 0x202a2d,
        "fire-station": 0x25292b,
        factory: 0x22282c,
      };
      horizonMaterial.color
        .set(horizonTone[theme])
        .lerp(new THREE.Color(campaignLevel.campaign.palette.sky), 0.22);
      horizonMaterial.roughness = 0.94;
      horizonMaterial.metalness = 0.02;
      horizonMaterial.emissive.set(0x000000);
      horizonMaterial.emissiveIntensity = 0;
      horizonMaterial.emissiveMap = null;
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"] as const) {
        const texture = horizonMaterial[key];
        if (!texture) continue;
        const repeated = texture.clone();
        repeated.wrapS = THREE.RepeatWrapping;
        repeated.wrapT = THREE.RepeatWrapping;
        repeated.repeat.set(56, 56);
        repeated.needsUpdate = true;
        horizonMaterial[key] = repeated;
      }
      const horizonGround = new THREE.Mesh(new THREE.PlaneGeometry(224, 224), horizonMaterial);
      horizonGround.name = `${theme}-fog-horizon-ground`;
      horizonGround.rotation.x = -Math.PI / 2;
      horizonGround.position.y = -0.16;
      horizonGround.receiveShadow = true;
      parent.add(horizonGround);

      const authoredGate = resolveThemeNode(
        themeKit.scene,
        theme,
        [`${artLayout.key}EntranceGate`, "EntranceGate", "ArchitectureEntranceGate"],
      );
      const gate = authoredGate
        ? anchorAuthoredModule(authoredGate)
        : fitModule(requireStructure("frontGate"), new THREE.Vector3(1.9, 2.55, 0.42));
      if (!authoredGate) {
        applyThemeSurface(gate, palette.accent, { blend: 0.12, emissive: palette.emissive, emissiveIntensity: 0.06 });
      }
      gate.rotation.y = Math.atan2(-entranceDirection.x, -entranceDirection.y);
      gate.position.add(world(campaignLevel.playerStart, campaignLevel)).add(new THREE.Vector3(
        entranceDirection.x * CELL * 0.5,
        0,
        entranceDirection.y * CELL * 0.5,
      ));
      parent.add(gate);
      placedAssetIds.add(authoredGate ? `theme-node:${authoredGate.name}` : "structure:frontGate");
      registerCameraOccluder("front-gate", [gate]);

      const authoredExit = resolveThemeNode(
        themeKit.scene,
        theme,
        [`${artLayout.key}ExitDoor`, "ExitDoor", "ArchitectureExitDoor"],
      );
      const exitDoor = authoredExit
        ? anchorAuthoredModule(authoredExit)
        : fitModule(requireStructure("exit"), new THREE.Vector3(1.9, 2.55, 0.42));
      exitDoor.rotation.y = Math.atan2(-exitDirection.x, -exitDirection.y);
      exitDoor.position.add(world(campaignLevel.exit, campaignLevel)).add(new THREE.Vector3(
        exitDirection.x * CELL * 0.5,
        0,
        exitDirection.y * CELL * 0.5,
      ));
      if (!authoredExit) {
        exitDoor.traverse((object) => {
          if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
          object.material = object.material.clone();
          object.material.emissive.lerp(new THREE.Color(palette.emissive), 0.18);
          object.material.emissiveIntensity = Math.max(object.material.emissiveIntensity, 0.24);
        });
      }
      parent.add(exitDoor);
      placedAssetIds.add(authoredExit ? `theme-node:${authoredExit.name}` : "structure:exit");
      registerCameraOccluder("exit-door", [exitDoor]);
      const exitLight = new THREE.SpotLight(palette.emissive, 18, 10, Math.PI / 5.4, 0.58, 1.7);
      exitLight.position.copy(world(campaignLevel.exit, campaignLevel)).add(new THREE.Vector3(0, 4.8, 0));
      exitLight.target.position.copy(world(campaignLevel.exit, campaignLevel));
      parent.add(exitLight, exitLight.target);
    };

    const buildDetails = (
      assets: Partial<Record<DetailAssetName, GLTF>>,
      themeKit: GLTF,
      parent: THREE.Group,
      targetScene: THREE.Scene,
      lockerViews: Map<string, LockerView>,
    ) => {
      const requireDetail = (name: DetailAssetName) => {
        const asset = assets[name];
        if (!asset) throw new Error(`本关需要叙事物件 detail:${name}，但资源清单未载入它`);
        return asset;
      };
      const propTemplates = new Map<string, THREE.Object3D>();
      const themeDressing = new THREE.Group();
      themeDressing.name = `${campaignLevel.campaign.theme}-authored-dressing-source`;
      const theme = campaignLevel.campaign.theme;
      const detailFloorModule = (role: "Primary" | "Secondary" | "Service") => {
        const source = resolveThemeNode(themeKit.scene, theme, [
          `${artLayout.key}Floor${role}`,
          `Floor${role}`,
          `ArchitectureFloor${role}`,
        ]);
        if (!source) throw new Error(`${campaignLevel.campaign.themeLabel}主题套件缺少${role}房间地面`);
        return source;
      };
      const detailFloorSources = {
        secondary: detailFloorModule("Secondary"),
        service: detailFloorModule("Service"),
      };
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
        const template = propTemplates.get(key) ?? fitProp(requireDetail(name).scene, height);
        propTemplates.set(key, template);
        const object = template.clone(true);
        object.position.add(world(point, campaignLevel)).add(offset);
        object.rotation.y = rotation;
        parent.add(object);
        placedAssetIds.add(`detail:${name}`);
        if (cameraOccludingProps.has(name)) {
          registerCameraOccluder(`${name}-${point.x}-${point.y}`, [object]);
        }
        return object;
      };
      const addThemeProp = (spec: ThemePropSpec, point: Point, rotation = 0) => {
        const source = resolveThemeNode(themeKit.scene, campaignLevel.campaign.theme, [spec.node]);
        if (!source) throw new Error(`${campaignLevel.campaign.themeLabel}主题模型缺少节点 ${spec.node}`);
        const key = `theme:${spec.node}:${spec.height}`;
        const template = propTemplates.get(key) ?? fitProp(source, spec.height, true);
        propTemplates.set(key, template);
        const object = template.clone(true);
        object.name = `theme-prop-${spec.node}`;
        object.position.add(world(point, campaignLevel));
        object.rotation.y = rotation;
        themeDressing.add(object);
        placedAssetIds.add(`theme-node:${source.name || spec.node}`);
        return object;
      };
      const addAuthoredCluster = (
        candidates: readonly string[],
        point: Point,
        rotation: number,
        name: string,
      ) => {
        const source = resolveThemeNode(themeKit.scene, campaignLevel.campaign.theme, candidates);
        if (!source) return false;
        const key = `authored-cluster:${source.uuid}`;
        const template = propTemplates.get(key) ?? anchorAuthoredStatic(source, true);
        propTemplates.set(key, template);
        const object = template.clone(true);
        object.name = name;
        object.position.copy(world(point, campaignLevel));
        object.rotation.y = rotation;
        themeDressing.add(object);
        placedAssetIds.add(`theme-node:${source.name || candidates[0]}`);
        return true;
      };

      const lockerSource = requireDetail("locker");
      const clipMap = new Map(lockerSource.animations.map((clip) => [clip.name, clip]));
      const missingLockerClips = LOCKER_CLIPS.filter((name) => !clipMap.has(name));
      if (missingLockerClips.length) throw new Error(`Hero locker animation contract failed: ${missingLockerClips.join(", ")}`);
      const hideDressingSource = resolveThemeNode(
        themeKit.scene,
        campaignLevel.campaign.theme,
        artLayout.hideDressingNodes,
      );
      const hideDressingPlacements: ModulePlacement[] = [];
      const hideBeaconTexture = createHideBeaconTexture("#5ae0a0");
      for (const spot of campaignLevel.hideSpots) {
        const visualPoint = visualHidePoint(spot);
        const root = fitInteractiveProp(lockerSource.scene, 2.12);
        applyThemeSurface(root, campaignLevel.campaign.palette.accent, {
          blend: 0.08,
          emissive: campaignLevel.campaign.palette.emissive,
          emissiveIntensity: 0.035,
        });
        root.name = `hero-locker-${spot.id}`;
        root.rotation.y = Math.atan2(spot.facing.x, spot.facing.y);
        root.position.copy(world(visualPoint, campaignLevel));
        root.updateMatrixWorld(true);
        const anchor = root.getObjectByName("HideAnchor");
        const pivot = root.getObjectByName("DoorPivot");
        if (!anchor || !pivot) throw new Error("Hero locker is missing HideAnchor or DoorPivot; refusing an art fallback");
        const anchorWorld = anchor.getWorldPosition(new THREE.Vector3());
        root.position.add(world(visualPoint, campaignLevel).sub(anchorWorld));
        const beaconMaterial = new THREE.SpriteMaterial({
          map: hideBeaconTexture,
          transparent: true,
          opacity: 0.72,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        });
        const beacon = new THREE.Sprite(beaconMaterial);
        beacon.name = `hide-beacon-${spot.id}`;
        beacon.center.set(0.5, 0);
        beacon.position.set(0, 2.43, 0);
        beacon.scale.set(1.58, 0.79, 1);
        beacon.renderOrder = 18;
        beacon.visible = false;
        root.add(beacon);
        const beaconLight = new THREE.PointLight(
          new THREE.Color("#5ae0a0"),
          0,
          5.2,
          2.25,
        );
        beaconLight.name = `hide-beacon-light-${spot.id}`;
        beaconLight.position.set(0, 1.85, -0.32);
        root.add(beaconLight);
        parent.add(root);
        placedAssetIds.add("detail:locker");
        const view: LockerView = {
          id: spot.id,
          root,
          approach: spot.approach,
          beacon,
          beaconLight,
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
        if (hideDressingSource) {
          hideDressingPlacements.push({
            position: world(visualPoint, campaignLevel),
            rotation: Math.atan2(spot.facing.x, spot.facing.y),
          });
        }
      }
      if (hideDressingSource && hideDressingPlacements.length) {
        addInstancedModuleBatches([
          { source: hideDressingSource, placements: hideDressingPlacements, preserveAuthoredScale: true },
        ], new THREE.Vector3(1.5, 2.3, 0.8), parent, true, `${campaignLevel.campaign.theme}-hide-dressing`, supportsMultiDraw);
        // The surround is a landmark, not a wall. Keeping it opaque and crisp
        // prevents the camera-occlusion shader from turning the cabinet into a
        // translucent blur exactly when the player reaches it.
        placedAssetIds.add(`theme-node:${hideDressingSource.name}`);
      }

      // The original school layout deliberately reserves seven path cells for
      // solid hero props. Keep presentation and collision authored from the
      // same ordered contract so the player never hits an invisible blocker.
      for (const [index, point] of (campaignLevel.movementBlockers ?? []).entries()) {
        const spec = MOVEMENT_PROP_CONTRACT[index];
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
        placedAssetIds.add("runtime:vision-obscurer-vfx");
      }

      const occupiedAnchors = [
        campaignLevel.playerStart,
        campaignLevel.chaserStart,
        campaignLevel.exit,
        ...campaignLevel.hideSpots.flatMap((spot) => [spot.approach, spot.concealed]),
      ];
      type SceneryAnchor = { cell: Point; point: Point; rotation: number };
      const decorCandidates: SceneryAnchor[] = [];
      for (let y = 1; y < campaignLevel.height - 1; y += 1) {
        for (let x = 1; x < campaignLevel.width - 1; x += 1) {
          if (campaignLevel.walkable[y][x]) continue;
          const towardPath = { x: 0, y: 0 };
          for (const direction of [{ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 }]) {
            if (!campaignLevel.walkable[y + direction.y]?.[x + direction.x]) continue;
            towardPath.x += direction.x;
            towardPath.y += direction.y;
          }
          if (Math.hypot(towardPath.x, towardPath.y) < 0.1) continue;
          const candidate = { x, y };
          if (occupiedAnchors.some((anchor) => distanceBetween(anchor, candidate) < 1.35)) continue;
          const length = Math.hypot(towardPath.x, towardPath.y);
          const direction = { x: towardPath.x / length, y: towardPath.y / length };
          decorCandidates.push({
            cell: candidate,
            // Pull the model footprint away from the navigation boundary while
            // keeping its authored +Z front aimed at the adjacent corridor.
            point: { x: x - direction.x * 0.72, y: y - direction.y * 0.72 },
            rotation: Math.atan2(direction.x, direction.y),
          });
        }
      }
      decorCandidates.sort((a, b) => {
        const hash = (anchor: SceneryAnchor) => (
          anchor.cell.x * 37
          + anchor.cell.y * 61
          + campaignLevel.campaign.levelNumber * 17
          + artLayout.wallVariantSalt
        ) % 101;
        return hash(a) - hash(b);
      });
      const decorAnchors: SceneryAnchor[] = [];
      for (const candidate of decorCandidates) {
        if (decorAnchors.every((existing) => distanceBetween(existing.cell, candidate.cell) >= 3.4)) decorAnchors.push(candidate);
        if (decorAnchors.length >= 14) break;
      }

      const exteriorAnchor = (anchor: Point, distance: number, side: number): SceneryAnchor => {
        const direction = nearestExteriorDirection(anchor, campaignLevel);
        const perpendicular = { x: -direction.y, y: direction.x };
        const point = {
          x: anchor.x + direction.x * distance + perpendicular.x * side,
          y: anchor.y + direction.y * distance + perpendicular.y * side,
        };
        return {
          cell: point,
          point,
          rotation: Math.atan2(-direction.x, -direction.y),
        };
      };
      const themeSpecs = THEME_PROP_SPECS[campaignLevel.campaign.theme];
      const offsetAnchor = (anchor: SceneryAnchor, tangent: number, depth = 0): SceneryAnchor => {
        const facing = { x: Math.sin(anchor.rotation), y: Math.cos(anchor.rotation) };
        const side = { x: Math.cos(anchor.rotation), y: -Math.sin(anchor.rotation) };
        const point = {
          x: anchor.point.x + side.x * tangent + facing.x * depth,
          y: anchor.point.y + side.y * tangent + facing.y * depth,
        };
        return { cell: point, point, rotation: anchor.rotation };
      };
      const roomTopology = enclosedRoomFloorRegions(campaignLevel);
      const roomSafeDecorAnchors = decorAnchors.filter((anchor) => roomFloorSupportForFootprint(
        campaignLevel,
        roomTopology,
        {
          center: anchor.point,
          halfWidth: 0.34,
          halfDepth: 0.34,
          rotationRadians: anchor.rotation,
        },
      ).supported);
      const interiorNarrativeAnchors = artLayout.landmarkNodes.map((_, index) => (
        roomSafeDecorAnchors[index]
        ?? offsetAnchor(
          exteriorAnchor(campaignLevel.playerStart, 2.8, 0),
          (index - (artLayout.landmarkNodes.length - 1) / 2) * 2.45,
          -1.2,
        )
      ));
      const roomAnchors = roomSafeDecorAnchors.slice(0, Math.min(roomSafeDecorAnchors.length, 9));
      const roomFloorPlacements: Record<"secondary" | "service", ModulePlacement[]> = {
        secondary: [],
        service: [],
      };
      const roomBoundaryTrimPlacements: ModulePlacement[] = [];
      const occupiedRoomFloorCells = new Set<string>();
      const furnishedRooms = authoredRoomFloorRegions(campaignLevel, roomAnchors.map(({ cell }) => cell));
      for (const [furnishedRoomIndex, { anchorIndex, boundaryEdges, cells }] of furnishedRooms.entries()) {
        // Service floors carry strong hazard bands and anchors. Reserve that
        // visual language for compact utility closets; large classrooms,
        // wards and work bays use the calmer secondary finish so repetition
        // does not turn the whole room into a warning mat.
        const role = cells.length <= 12 && furnishedRoomIndex % 2 === 1 ? "service" : "secondary";
        for (const cell of cells) {
          const key = `${cell.x},${cell.y}`;
          if (occupiedRoomFloorCells.has(key)) continue;
          occupiedRoomFloorCells.add(key);
          roomFloorPlacements[role].push({
            position: world(cell, campaignLevel).add(new THREE.Vector3(0, -0.025, 0)),
            rotation: (anchorIndex % 4) * Math.PI / 2,
          });
        }
        for (const edge of boundaryEdges) {
          const trim = roomFloorBoundaryTrimPlacement(edge);
          roomBoundaryTrimPlacements.push({
            position: world(trim.position, campaignLevel).add(new THREE.Vector3(0, -0.012, 0)),
            rotation: trim.rotationRadians,
          });
        }
      }
      addInstancedModuleBatches([
        {
          source: detailFloorSources.secondary,
          placements: roomFloorPlacements.secondary,
          preserveAuthoredScale: true,
        },
        {
          source: detailFloorSources.service,
          placements: roomFloorPlacements.service,
          preserveAuthoredScale: true,
        },
      ], new THREE.Vector3(CELL, 0.12, CELL), parent, false, `${theme}-room-floor`, supportsMultiDraw);
      let roomBoundaryTrimSource: THREE.Object3D | undefined;
      themeKit.scene.traverse((object) => {
        if (!roomBoundaryTrimSource && /^FloorSeamX_/u.test(object.name)) roomBoundaryTrimSource = object;
      });
      if (roomBoundaryTrimSource && roomBoundaryTrimPlacements.length) {
        addInstancedModuleBatches([
          {
            source: roomBoundaryTrimSource,
            placements: roomBoundaryTrimPlacements,
            preserveAuthoredScale: true,
          },
        ], new THREE.Vector3(CELL, 0.03, 0.05), parent, false, `${theme}-room-floor-trim`, supportsMultiDraw);
        placedAssetIds.add(`theme-node:${roomBoundaryTrimSource.name}`);
      }
      if (occupiedRoomFloorCells.size > 0) placedAssetIds.add("runtime:authored-room-floors");
      for (const [index, node] of artLayout.landmarkNodes.entries()) {
        const anchor = interiorNarrativeAnchors[index];
        const genericVariant = ["DressingClusterA", "DressingClusterC", "DressingClusterB"][index % 3];
        // The cluster remains a complete authored vignette; runtime never
        // breaks its books, seating, tools or medical kit into loose props.
        addAuthoredCluster([node, genericVariant], anchor.point, anchor.rotation, `landmark-${artLayout.key}-${index + 1}`);
      }
      const ambientClusterCount = Math.min(
        Math.max(0, roomSafeDecorAnchors.length - artLayout.landmarkNodes.length),
        3 + Math.ceil(campaignLevel.campaign.difficulty / 2),
      );
      for (let index = 0; index < ambientClusterCount; index += 1) {
        const anchor = roomSafeDecorAnchors[artLayout.landmarkNodes.length + index];
        const genericVariant = ["DressingClusterB", "DressingClusterA", "DressingClusterC"][
          (index + campaignLevel.campaign.levelNumber) % 3
        ];
        addAuthoredCluster(
          [genericVariant],
          anchor.point,
          anchor.rotation,
          `ambient-room-${artLayout.key}-${index + 1}`,
        );
      }
      if (ambientClusterCount > 0) placedAssetIds.add("runtime:ambient-room-clusters");
      const arrivalAnchor = exteriorAnchor(campaignLevel.playerStart, 3.05, 0);
      const exitClusterAnchor = exteriorAnchor(campaignLevel.exit, 3.1, 0);
      const propContactGeometry = new THREE.PlaneGeometry(2.45, 1.65);
      propContactGeometry.rotateX(-Math.PI / 2);
      const propContactMaterial = new THREE.MeshBasicMaterial({
        color: 0x111416,
        map: contactTexture,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        side: THREE.DoubleSide,
      });
      const propContactAnchors = [
        ...roomAnchors,
        arrivalAnchor,
        exitClusterAnchor,
      ];
      const propContacts = new THREE.InstancedMesh(
        propContactGeometry,
        propContactMaterial,
        propContactAnchors.length,
      );
      propContactAnchors.forEach((anchor, index) => {
        const position = world(anchor.point, campaignLevel);
        position.y = 0.116;
        const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), anchor.rotation);
        propContacts.setMatrixAt(index, new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1)));
      });
      propContacts.instanceMatrix.needsUpdate = true;
      propContacts.name = `${theme}-prop-contact-shadows`;
      propContacts.renderOrder = 1;
      parent.add(propContacts);
      placedAssetIds.add("runtime:prop-contact-shadows");
      addAuthoredCluster(
        [...artLayout.arrivalNodes, "DressingClusterB"],
        arrivalAnchor.point,
        arrivalAnchor.rotation,
        `${artLayout.key}-arrival-cluster`,
      );
      addAuthoredCluster(
        [...artLayout.exitNodes, "DressingClusterA"],
        exitClusterAnchor.point,
        exitClusterAnchor.rotation,
        `${artLayout.key}-exit-cluster`,
      );
      const arrivalPropNodes = new Set<string>(campaignLevel.campaign.theme === "campus"
        ? ["CampusBikeRack", "CampusWayfinding"]
        : campaignLevel.campaign.theme === "hospital"
          ? ["HospitalWheelchair", "HospitalWayfinding"]
          : campaignLevel.campaign.theme === "fire-station"
            ? ["FireEngine", "FireHydrant", "FireStationWayfinding", "FireSafetyCones"]
            : ["FactorySafetyBarrier", "FactoryCrateStack"]);
      const wallThemeSpecs = themeSpecs.filter((spec) => !arrivalPropNodes.has(spec.node));
      const arrivalThemeSpecs = themeSpecs.filter((spec) => arrivalPropNodes.has(spec.node));
      const wallSelectionOffset = (campaignLevel.campaign.levelNumber - 1) % Math.max(1, wallThemeSpecs.length);
      const featuredThemeProps = PROP_SET_FEATURED_THEME_PROPS[campaignLevel.campaign.atmosphere.propSet];
      const requireThemeSpec = (node: string) => {
        const spec = themeSpecs.find((candidate) => candidate.node === node);
        if (!spec) throw new Error(`${campaignLevel.campaign.atmosphere.propSet} 未定义主题物件 ${node}`);
        return spec;
      };
      const selectedWallSpecs = featuredThemeProps
        ? featuredThemeProps.interior.map(requireThemeSpec)
        : [...wallThemeSpecs, ...wallThemeSpecs]
          .slice(wallSelectionOffset, wallSelectionOffset + Math.min(2, wallThemeSpecs.length));
      const selectedArrivalSpecs = featuredThemeProps
        ? featuredThemeProps.arrival.map(requireThemeSpec)
        : arrivalThemeSpecs.slice(0, 2);
      selectedWallSpecs.forEach((spec, index) => {
        const narrativeAnchor = interiorNarrativeAnchors[index % Math.max(1, interiorNarrativeAnchors.length)]
          ?? exteriorAnchor(campaignLevel.playerStart, 2.8, -2.2);
        const anchor = offsetAnchor(narrativeAnchor, index % 2 === 0 ? 1.2 : -1.2);
        addThemeProp(spec, anchor.point, anchor.rotation);
      });
      selectedArrivalSpecs.forEach((spec, index) => {
        const tangent = selectedArrivalSpecs.length === 1
          ? 0
          : (index - (selectedArrivalSpecs.length - 1) / 2) * (selectedArrivalSpecs.length > 2 ? 2.15 : 2.9);
        const anchor = offsetAnchor(arrivalAnchor, tangent, -0.62);
        addThemeProp(spec, anchor.point, anchor.rotation);
      });

      const standaloneRoleAnchor = (role: StandaloneAnchorRole) => {
        if (role === "arrival") return arrivalAnchor;
        if (role === "exit") return exitClusterAnchor;
        const index = Number(role.slice(-1)) - 1;
        return interiorNarrativeAnchors[index] ?? interiorNarrativeAnchors[0] ?? arrivalAnchor;
      };
      for (const placement of PROP_SET_STANDALONE_PROPS[campaignLevel.campaign.atmosphere.propSet] ?? []) {
        const anchor = offsetAnchor(
          standaloneRoleAnchor(placement.role),
          placement.tangent,
          placement.depth ?? 0,
        );
        const object = addProp(
          placement.asset,
          anchor.point,
          placement.height,
          anchor.rotation + (placement.rotationOffset ?? 0),
          new THREE.Vector3(0, placement.elevation ?? 0, 0),
        );
        object.name = `semantic-${campaignLevel.campaign.atmosphere.propSet}-${placement.asset}`;
      }

      // Theme-kit props and complete A/B/C clusters share a compact material
      // library. Collapse the whole non-interactive authored dressing pass by
      // material after semantic placement; the visual result is unchanged but
      // avoids paying a fresh draw for every trophy, planter and service cart.
      if (themeDressing.children.length) {
        if (new URLSearchParams(location.search).has("debug-art-nodes")) {
          parent.add(themeDressing);
        } else {
          const flattenedThemeDressing = flattenStatic(themeDressing, true);
          flattenedThemeDressing.name = `${campaignLevel.campaign.theme}-authored-dressing`;
          parent.add(flattenedThemeDressing);
        }
      }

      if (["fire-station", "factory"].includes(campaignLevel.campaign.theme)) {
        const industrialTheme = campaignLevel.campaign.theme;
        const entranceDirection = nearestExteriorDirection(campaignLevel.playerStart, campaignLevel);
        const entranceSide = { x: -entranceDirection.y, y: entranceDirection.x };
        const yardCenter = world({
          x: campaignLevel.playerStart.x + entranceDirection.x * 3.35,
          y: campaignLevel.playerStart.y + entranceDirection.y * 3.35,
        }, campaignLevel);
        const markingMaterial = new THREE.MeshStandardMaterial({
          color: industrialTheme === "fire-station" ? 0xf2e3bd : 0xf1b927,
          emissive: industrialTheme === "fire-station" ? 0x6c241e : 0x4a3200,
          emissiveIntensity: 0.05,
          roughness: 0.62,
          metalness: 0.02,
          transparent: true,
          opacity: industrialTheme === "fire-station" ? 0.58 : 0.72,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        });
        const stripeGeometry = new THREE.BoxGeometry(
          industrialTheme === "fire-station" ? 0.11 : 0.18,
          0.022,
          CELL * (industrialTheme === "fire-station" ? 1.42 : 1.05),
        );
        const stripeCount = industrialTheme === "fire-station" ? 5 : 4;
        const yardStripes = new THREE.InstancedMesh(stripeGeometry, markingMaterial, stripeCount);
        const stripeRotation = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          Math.atan2(entranceDirection.x, entranceDirection.y) + (industrialTheme === "factory" ? Math.PI / 4 : 0),
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
        placedAssetIds.add("runtime:arrival-bay-markings");
      }

      THEME_SHARED_PROPS[campaignLevel.campaign.theme].forEach(([name, height]) => {
        const anchor = name === "trash"
          ? offsetAnchor(arrivalAnchor, -2.35, -0.35)
          : name === "tree"
            ? offsetAnchor(arrivalAnchor, 2.65, -0.75)
            : offsetAnchor(interiorNarrativeAnchors[0] ?? arrivalAnchor, -1.25);
        addProp(name, anchor.point, height, anchor.rotation);
      });

      const lightPoints = [campaignLevel.playerStart, ...campaignLevel.patrol.filter((_, index) => index % 2 === 0), campaignLevel.exit]
        .slice(0, 4);
      for (const point of lightPoints) {
        addProp("ceilingLight", point, 0.16, 0, new THREE.Vector3(0, 2.35, 0));
        const lampColor = new THREE.Color(campaignLevel.campaign.palette.emissive).lerp(
          new THREE.Color(campaignLevel.campaign.palette.accent),
          artLayout.warmLightMix * 0.22,
        );
        const lamp = new THREE.PointLight(lampColor, artLayout.lightIntensity, 7.6, 2);
        lamp.position.copy(world(point, campaignLevel)).add(new THREE.Vector3(0, 2.2, 0));
        targetScene.add(lamp);
      }
    };

    const placeActors = (
      assets: Partial<Record<ActorName, GLTF>>,
      actorViews: Partial<Record<ActorName, ActorView>>,
      targetScene: THREE.Scene,
      names: readonly ActorName[] = Object.keys(ACTOR_SPECS) as ActorName[],
    ) => {
      for (const name of names) {
        const asset = assets[name];
        if (!asset) throw new Error(`缺少正式角色资产 actor:${name}`);
        const spec = ACTOR_SPECS[name];
        const root = fitActor(asset.scene, spec.height);
        root.name = `actor-${name}`;
        const animator = new ActorAnimator(root, asset.animations, spec.aliases as ClipAliases);
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
        placedAssetIds.add(`actor:${name}`);
        const durationByState: Partial<Record<AnimationState, number>> = {};
        const clipsByName = new Map(asset.animations.map((clip) => [clip.name.toLowerCase(), clip]));
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
          if (!event.occupied) soundscape.trigger("locker-close");
          continue;
        }
        if (event.type === "player-captured") {
          setLastCaptureReason(event.reason);
          continue;
        }
        if (event.type === "chaser-mode-changed") {
          if (event.to === "check-hide") soundscape.trigger("locker-check");
          continue;
        }
        if (event.type === "phase-changed") {
          updatePhasePresentation(event.to);
          if (event.to === "lost") {
            soundscape.trigger("caught");
            captureStageRemaining = CAPTURE_STAGING_SECONDS;
            capturePerformanceStarted = false;
            requestAnimation(actors.kid!, "idle", { fade: 0.08 });
            requestAnimation(actors.villain!, "alert", { fade: 0.08 });
          } else if (event.to === "won") {
            soundscape.trigger("escaped");
            requestAnimation(actors.kid!, "celebrate", { fade: 0.18 });
            if (actors.police) requestAnimation(actors.police, "protect", { fade: 0.14 });
          }
          continue;
        }
        if (event.type !== "player-mode-changed") continue;
        setPlayerMode(event.to);
        setInteraction(simulation.getHideInteraction());
        const spotId = state.player.hideSpotId;
        const locker = spotId ? lockers.get(spotId) : undefined;
        if (event.to === "entering-hide" && locker) {
          soundscape.trigger("locker-open");
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
          soundscape.trigger("locker-close");
          requestAnimation(actors.kid!, "hideIdle", { fade: 0.18 });
        } else if (event.to === "exiting-hide" && locker) {
          soundscape.trigger("locker-open");
          setLockerPeek(locker, false);
          playLockerSequence(locker, ["Locker_Door_Open_Exit", "Locker_Door_Close_Exit"]);
          requestAnimation(actors.kid!, "exitHide", { fade: 0.1, duration: simulation.config.hideExitSeconds });
        } else if (event.from === "exiting-hide" && event.to === "free") {
          soundscape.trigger("locker-close");
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
      if (!kid || !villain) return;
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
        const checkId = state.chaser.searchHideSpotId ?? state.chaser.memory.witnessedHideSpotId;
        const checkSpot = checkId ? campaignLevel.hideSpots.find((spot) => spot.id === checkId) : undefined;
        const atCheckSpot = Boolean(checkSpot && distanceBetween(checkSpot.approach, state.chaser.position) < 0.18);
        const villainAnimation = chaserAnimationForMode(state.chaser.mode, villainSpeed, atCheckSpot);
        requestAnimation(villain, villainAnimation, {
          fade: 0.17,
          duration: villainAnimation === "checkLocker"
            ? simulation.config.checkHideSeconds
            : state.chaser.mode === "scan-last-known"
              ? simulation.config.lastKnownScanSeconds
              : undefined,
          loop: state.chaser.mode === "scan-last-known" ? false : undefined,
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
      police?.animator.update(delta);
      let nearestLockerId: string | null = null;
      let nearestLockerDistance = Number.POSITIVE_INFINITY;
      for (const locker of lockers.values()) {
        const distance = distanceBetween(state.player.position, locker.approach);
        if (distance < nearestLockerDistance) {
          nearestLockerDistance = distance;
          nearestLockerId = locker.id;
        }
      }
      const hideMarkerAllowed = state.phase === "playing"
        && ["free", "aligning-hide"].includes(state.player.mode);
      const urgentHideMarker = ["suspicious", "chase", "lost-sight", "go-to-last-known", "scan-last-known", "search"].includes(state.chaser.mode);
      const markerPulse = 0.5 + Math.sin(state.elapsedSeconds * 4.6) * 0.5;
      const guidedLightColor = guidedLockerRisk === "low"
        ? 0x5ae0a0
        : guidedLockerRisk === "medium"
          ? 0xe8bd68
          : 0xff6b72;
      for (const locker of lockers.values()) {
        updateLocker(locker, delta);
        const distance = distanceBetween(state.player.position, locker.approach);
        const isNearest = locker.id === (guidedLockerId ?? nearestLockerId);
        const isInteractable = distance <= simulation.config.hideInteractRange;
        locker.beacon.visible = hideMarkerAllowed && (isNearest || isInteractable);
        const beaconMaterial = locker.beacon.material as THREE.SpriteMaterial;
        beaconMaterial.opacity = isInteractable
          ? 0.94
          : urgentHideMarker ? 0.76 + markerPulse * 0.16 : 0.5 + markerPulse * 0.1;
        const markerScale = isInteractable ? 1.12 + markerPulse * 0.06 : 1;
        locker.beacon.scale.set(1.58 * markerScale, 0.79 * markerScale, 1);
        locker.beaconLight.color.setHex(isNearest ? guidedLightColor : 0x5ae0a0);
        locker.beaconLight.intensity = locker.beacon.visible
          ? isInteractable ? 2.3 + markerPulse * 0.7 : urgentHideMarker ? 1.35 + markerPulse * 0.4 : 0.72
          : 0;
      }
    };

    const updateHideGuideProjection = (state: GameState) => {
      if (state.phase !== "playing" || state.player.mode !== "free" || lockers.size === 0) {
        setHideGuideProjection(null);
        return;
      }
      const firstClear = !campaignProgressRef.current.bestSeconds[campaignLevel.id];
      const guidance = recommendHideSpot(campaignLevel, {
        playerPosition: state.player.position,
        nowSeconds: state.elapsedSeconds,
        playerSpeed: simulation.config.playerSpeed,
        chaserSpeed: simulation.config.chaserSpeed,
        hideEnterExposureSeconds: simulation.config.hideEnterExposureSeconds,
        knownChaser: playerKnownChaser,
        tutorialHideSpotId: firstClear ? hideGuidancePolicy.tutorialHideSpotId : null,
      });
      const guidedLocker = guidance ? lockers.get(guidance.recommended.hideSpotId) : undefined;
      if (!guidance || !guidedLocker) {
        guidedLockerId = null;
        setHideGuideProjection(null);
        return;
      }
      guidedLockerId = guidedLocker.id;
      guidedLockerRisk = guidance.recommended.risk;
      setHideGuideRisk(guidance.recommended.risk);
      setHideGuideSelection(guidance.selection);
      setHideDistance(Math.round(guidance.recommended.routeDistanceCells * CELL));
      const projected = guidedLocker.beacon.getWorldPosition(new THREE.Vector3()).project(camera);
      const viewportX = (projected.x + 1) / 2;
      const viewportY = (1 - projected.y) / 2;
      const inFrustum = Math.abs(projected.x) <= 0.92
        && Math.abs(projected.y) <= 0.86
        && projected.z >= -1
        && projected.z <= 1;
      setHideGuideProjection({
        xPercent: THREE.MathUtils.clamp(viewportX * 100, 7, 93),
        yPercent: THREE.MathUtils.clamp(viewportY * 100, 11, 86),
        angleDegrees: THREE.MathUtils.radToDeg(Math.atan2(viewportY - 0.5, viewportX - 0.5)),
        offscreen: !inFrustum,
      });
    };

    const animate = (now: number) => {
      const delta = boundedFrameDeltaSeconds(last, now, simulation.config.maxFrameDeltaSeconds);
      last = now;
      if (ready) {
        qualitySamples.push(delta * 1_000);
        qualityEvaluationSeconds += delta;
        if (qualityEvaluationSeconds >= 1 && qualitySamples.length >= 20) {
          const sortedSamples = [...qualitySamples].sort((left, right) => left - right);
          const p95 = sortedSamples[Math.min(
            sortedSamples.length - 1,
            Math.floor(sortedSamples.length * 0.95),
          )];
          const candidate = nextRenderQuality(renderQualityTier, p95, 999);
          if (candidate !== renderQualityTier) {
            if (candidate === qualityCandidate) qualityDecisionSeconds += qualityEvaluationSeconds;
            else {
              qualityCandidate = candidate;
              qualityDecisionSeconds = qualityEvaluationSeconds;
            }
            const resolved = nextRenderQuality(renderQualityTier, p95, qualityDecisionSeconds);
            if (resolved !== renderQualityTier) {
              applyRenderQuality(resolved);
              qualityCandidate = resolved;
              qualityDecisionSeconds = 0;
            }
          } else {
            qualityCandidate = renderQualityTier;
            qualityDecisionSeconds = 0;
          }
          qualitySamples = [];
          qualityEvaluationSeconds = 0;
        }

        const atmospherePulse = atmosphere.pulseHertz > 0
          ? Math.sin(now * 0.001 * atmosphere.pulseHertz * Math.PI * 2)
          : 0;
        warmBounce.intensity = atmosphere.bounceIntensity
          * (0.72 + artLayout.warmLightMix * 0.28)
          * (1 + atmospherePulse * atmosphere.pulseDepth);
        const atmosphereAttribute = atmosphereGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let index = 0; index < atmosphereParticleCount; index += 1) {
          const base = index * 3;
          const seed = atmosphereSeeds[index];
          if (atmosphere.particleKind === "rain") {
            atmospherePositions[base] += delta * (0.16 + seed * 0.12);
            atmospherePositions[base + 1] -= delta * atmosphere.particleSpeed * (4.8 + seed * 2.1);
            if (atmospherePositions[base + 1] < 0.15) atmospherePositions[base + 1] = 6.1;
          } else if (atmosphere.particleKind === "embers") {
            atmospherePositions[base] += Math.sin(now * 0.0012 + seed * 31) * delta * 0.2;
            atmospherePositions[base + 1] += delta * atmosphere.particleSpeed * (0.72 + seed);
            if (atmospherePositions[base + 1] > 6.2) atmospherePositions[base + 1] = 0.18;
          } else if (atmosphere.particleKind === "steam") {
            atmospherePositions[base] += Math.sin(now * 0.00055 + seed * 19) * delta * 0.1;
            atmospherePositions[base + 1] += delta * atmosphere.particleSpeed * (0.28 + seed * 0.48);
            if (atmospherePositions[base + 1] > 5.8) atmospherePositions[base + 1] = 0.25;
          } else if (atmosphere.particleKind === "dust") {
            atmospherePositions[base] += Math.sin(now * 0.00032 + seed * 23) * delta * 0.035;
            atmospherePositions[base + 1] += Math.cos(now * 0.00027 + seed * 17) * delta * 0.018;
          }
        }
        atmosphereAttribute.needsUpdate = atmosphereParticleCount > 0;

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
          sneakHeld: held("q"),
        });
        interactPressed.current = false;
        consumeEvents(latestState);
        updateLockerVisionStyle(latestState);
        const playerActuallyVisible = latestState.phase !== "playing"
          || isPlayerVisuallyExposed(latestState.player, simulation.config);
        const chaserKnowledgeObservable = canPlayerObserveChaser(latestState, campaignLevel, simulation.config);
        if (latestState.phase === "playing" && chaserKnowledgeObservable) {
          playerKnownChaser = {
            position: { ...latestState.chaser.position },
            observedAtSeconds: latestState.elapsedSeconds,
          };
        }
        const chaserWorldRendered = shouldRenderChaserModel(latestState.phase, playerActuallyVisible);
        syncAnimations(latestState, delta);
        soundscape.update({
          elapsedSeconds: latestState.elapsedSeconds,
          playerPosition: latestState.player.position,
          chaserPosition: latestState.chaser.position,
          playerSpeed: actors.kid?.sampledSpeed ?? 0,
          chaserSpeed: actors.villain?.sampledSpeed ?? 0,
          chaserMode: latestState.chaser.mode,
        });
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
        const baseTargetFocus = latestState.phase === "won"
          ? playerAnchor.clone().lerp(policeAnchor, 0.34)
          : latestState.phase === "lost"
            ? playerAnchor.clone().lerp(chaserAnchor, 0.3)
            : playerAnchor.clone().lerp(chaserAnchor, chaseFocus);
        const baseDistance = baseCameraDistanceForAspect(camera.aspect);
        const dynamicDistance = baseDistance * cameraDistanceScaleForPlayerMode(latestState.player.mode)
          + threatForMode(latestState.chaser.mode) * 0.9;
        const preferredDistance = THREE.MathUtils.clamp(
          dynamicDistance * cameraZoom.value,
          11.6,
          MAX_CAMERA_DISTANCE,
        );
        const edgeFocus = framingThreat
          ? baseTargetFocus
          : cameraFocusForEdgeHide({
              focus: baseTargetFocus,
              bounds: cameraPlayfieldBounds,
              mode: latestState.player.mode,
              cameraDirection,
              cameraDistance: preferredDistance,
              verticalFovDegrees: camera.fov,
              aspect: camera.aspect,
            });
        const safeFocus = cameraFocusForSafeViewport({
          focus: edgeFocus,
          cameraDirection,
          cameraDistance: preferredDistance,
          verticalFovDegrees: camera.fov,
          aspect: camera.aspect,
          safeViewport: cameraSafeViewport,
        });
        const targetFocus = safeFocus instanceof THREE.Vector3
          ? safeFocus
          : new THREE.Vector3(safeFocus.x, safeFocus.y, safeFocus.z);
        cameraFocus.lerp(targetFocus, 1 - Math.exp(-(framingThreat ? 12 : 6.5) * delta));
        const compositionActors = [
          { center: playerAnchor, height: ACTOR_SPECS.kid.height },
          ...(latestState.phase === "won" && actors.police
            ? [{ center: policeAnchor, height: ACTOR_SPECS.police.height }]
            : framingThreat
              ? [{ center: chaserAnchor, height: ACTOR_SPECS.villain.height }]
              : []),
        ];
        const composition = fixedCameraCompositionConstraints({
          focus: cameraFocus,
          actors: compositionActors,
          cameraDirection,
          verticalFovDegrees: camera.fov,
          aspect: camera.aspect,
          horizontalMargin: camera.aspect < 0.72 ? 0.38 : 0.9,
          verticalMargin: camera.aspect < 0.72 ? 0.92 : 1.05,
          safeViewport: cameraSafeViewport,
          viewportHeightPixels: cameraViewportHeight,
          minimumActorScreenHeightPixels: THREE.MathUtils.clamp(
            cameraViewportHeight * (coarsePointer ? 0.066 : 0.055),
            coarsePointer ? 34 : 30,
            coarsePointer ? 48 : 44,
          ),
          preferredDistance,
          minimumDistance: 11.6,
          maximumDistance: MAX_CAMERA_DISTANCE,
        });
        const targetDistance = THREE.MathUtils.clamp(composition.distance, 11.6, MAX_CAMERA_DISTANCE);
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
        const readableOcclusionAnchors = [playerAnchor];
        if (latestState.phase === "won" && actors.police) readableOcclusionAnchors.push(policeAnchor);
        else if (
          chaserWorldRendered
          && (chaserKnowledgeObservable || latestState.phase === "lost")
        ) readableOcclusionAnchors.push(chaserAnchor);
        updateCameraOcclusion(readableOcclusionAnchors, delta);

        if (now - lastHudUpdate > 120) {
          setPhase(latestState.phase);
          setPlayerMode(latestState.player.mode);
          setChaserMode(latestState.chaser.mode);
          setChaserConfirming(latestState.chaser.visualConfirmationSeconds !== null);
          setChaserObservable(chaserKnowledgeObservable);
          setElapsed(Math.floor(latestState.elapsedSeconds));
          setObjectiveDistance(objectiveDistanceMeters(latestState.player.position, campaignLevel, objectivePaths));
          setInteraction(simulation.getHideInteraction());
          updateHideGuideProjection(latestState);
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
      cameraViewportWidth = width;
      cameraViewportHeight = height;
      cameraSafeViewport = cameraSafeViewportFromInsets(
        width,
        height,
        gameplayCameraInsetsForViewport(width, height, coarsePointer),
      );
      renderer.setPixelRatio(Math.min(devicePixelRatio, renderQualityProfile.maximumPixelRatio));
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
        inspectScene: () => unknown;
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
            propSet: campaignLevel.campaign.atmosphere.propSet,
            config: simulation.config,
            progress: campaignProgressRef.current,
            themeAsset: THEME_KIT_ASSETS[campaignLevel.campaign.theme],
            playerStart: campaignLevel.playerStart,
            exit: campaignLevel.exit,
            chaserStart: campaignLevel.chaserStart,
            hideSpots: campaignLevel.hideSpots,
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
          assets: {
            loadedAssetIds: [...loadedAssetIds].sort(),
            placedAssetIds: [...placedAssetIds].sort(),
            unusedLoadedAssetIds: [...loadedAssetIds].filter((id) => !placedAssetIds.has(id)).sort(),
          },
          lockers: Object.fromEntries([...lockers].map(([id, view]) => [id, {
            approach: view.approach,
            rootPosition: { x: view.root.position.x, y: view.root.position.y, z: view.root.position.z },
            beaconVisible: view.beacon.visible,
            beaconOpacity: (view.beacon.material as THREE.SpriteMaterial).opacity,
            beaconViewport: (() => {
              const projected = view.beacon.getWorldPosition(new THREE.Vector3()).project(camera);
              return {
                x: (projected.x + 1) / 2,
                y: (1 - projected.y) / 2,
                depth: projected.z,
                centerInFrustum: Math.abs(projected.x) <= 1
                  && Math.abs(projected.y) <= 1
                  && projected.z >= -1
                  && projected.z <= 1,
              };
            })(),
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
            batching: supportsMultiDraw ? "multi-draw" : "instanced-mesh",
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
        inspectScene: () => {
          camera.updateMatrixWorld();
          const objects: Array<Record<string, unknown>> = [];
          scene.traverse((object) => {
            if (!(object instanceof THREE.Mesh) || !object.visible) return;
            const bounds = new THREE.Box3().setFromObject(object);
            if (bounds.isEmpty()) return;
            const center = bounds.getCenter(new THREE.Vector3());
            const size = bounds.getSize(new THREE.Vector3());
            const projected = center.clone().project(camera);
            const materials = (Array.isArray(object.material) ? object.material : [object.material])
              .map((material) => material.name);
            objects.push({
              name: object.name,
              parent: object.parent?.name ?? "",
              materials,
              center: { x: center.x, y: center.y, z: center.z },
              size: { x: size.x, y: size.y, z: size.z },
              viewport: { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2, depth: projected.z },
            });
          });
          return objects;
        },
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
      delete document.documentElement.dataset.chasingQuality;
      if (qaWindow.__CHASING_QA__) delete qaWindow.__CHASING_QA__;
      for (const actor of Object.values(actors)) actor?.animator.dispose();
      for (const locker of lockers.values()) locker.mixer.stopAllAction();
      void score.dispose();
      void soundscape.dispose();
      environmentTarget.dispose();
      disposeObjectResources([scene]);
      renderer.renderLists.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [
    atmosphere,
    campaignLevel,
    gameplayConfig,
    hideGuidancePolicy.tutorialHideSpotId,
    objectivePaths,
  ]);

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
  const hideRiskLabel = hideGuideRisk === "low" ? "低风险" : hideGuideRisk === "medium" ? "风险未知" : "高风险";
  const captureFeedback = failureFeedback(lastCaptureReason);

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
          <button type="button" aria-label={musicMuted ? "打开声音" : "静音"} onClick={() => commands.current.toggleMute()}>{musicMuted ? "声音关" : "声音开"}</button>
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

        {!loading && phase === "playing" && playerMode === "free" && !interaction && (
          <div
            className={`hide-guide risk-${hideGuideRisk}${danger >= 0.45 ? " urgent" : ""}`}
            aria-label={`${hideGuideSelection === "tutorial" ? "教学安全藏身柜" : "最近藏身柜"}距离 ${hideDistance} 米，${hideRiskLabel}`}
          >
            <span aria-hidden="true" />
            <div>
              <small>{hideGuideSelection === "tutorial" ? "教学安全藏身柜" : `最近藏身柜 · ${hideRiskLabel}`}</small>
              <strong>{hideDistance}m · {hideGuideRisk === "high" ? "先切断视线再接近" : "按可见标记前进"}</strong>
            </div>
          </div>
        )}

        {!loading && phase === "playing" && playerMode === "free" && !interaction && hideGuideProjection?.offscreen && (
          <div
            className={`hide-edge-marker risk-${hideGuideRisk}`}
            aria-hidden="true"
            style={{
              left: `${hideGuideProjection.xPercent}%`,
              top: `${hideGuideProjection.yPercent}%`,
              "--hide-direction": `${hideGuideProjection.angleDegrees}deg`,
            } as React.CSSProperties}
          >
            <i /><b>{hideDistance}m</b>
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
              <h2>{phase === "won" ? `你完成了「${campaignLevel.campaign.name}」` : phase === "lost" ? captureFeedback.title : campaignLevel.campaign.subtitle}</h2>
              <p>
                {phase === "ready"
                  ? campaignLevel.campaign.briefing
                  : phase === "lost"
                    ? captureFeedback.explanation
                    : "追捕者只会依据真实目击、声音与最后位置追踪。你成功利用遮挡和藏身点完成了逃脱。"}
              </p>
              {phase === "lost" && (
                <div className="failure-advice"><small>下一次这样做</small><strong>{captureFeedback.hint}</strong></div>
              )}

              {phase === "ready" && (
                <div className="hide-loop" aria-label="躲柜玩法流程">
                  <span><b>1</b>绕墙切断视线</span>
                  <span><b>2</b>识别藏柜风险标记</span>
                  <span><b>3</b>按 E 藏好，等搜索结束</span>
                </div>
              )}

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
              <button type="button" className={interaction ? "available" : ""} disabled={!interaction} onClick={interact}>
                {interaction?.kind === "enter" ? "躲进藏柜" : interaction?.kind === "exit" ? "离开藏柜" : `藏柜 ${hideDistance}m`}
              </button>
              <button
                type="button"
                onPointerDown={() => touch("q", true)}
                onPointerUp={() => touch("q", false)}
                onPointerLeave={() => touch("q", false)}
                onPointerCancel={() => touch("q", false)}
              >
                {["hidden", "entering-peek", "peeking", "exiting-peek"].includes(playerMode) ? "按住观察" : "按住轻步"}
              </button>
            </div>
          </>
        )}
      </section>

      <footer>
        <span><i className="kid" />玩家</span>
        <span><i className="villain" />追捕者</span>
        <span><i className="safe" />可藏主题柜</span>
        <small>WASD / 方向键移动 · E 躲藏或离开 · Q 轻步 / 柜内观察 · 滚轮动态调视野 · M 声音 · R 重开</small>
      </footer>
    </main>
  );
}
