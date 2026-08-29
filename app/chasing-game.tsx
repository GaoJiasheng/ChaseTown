"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import {
  ActorAnimator,
  isFootstepAnimationMarker,
  type AnimationState,
  type ClipAliases,
  type MarkerManifest,
} from "./game/animation/actor-runtime.ts";
import { AdaptiveScoreController, prewarmAdaptiveScoreAssets } from "./game/audio/adaptive-score.ts";
import {
  ImmersiveSoundscapeController,
  THEME_MECHANIC_AUDIO_PROFILES,
  soundPanForWorldPoints,
} from "./game/audio/immersive-soundscape.ts";
import {
  assetLoadRecoveryMessage,
  auditFirstPlayableAssetBudget,
  createQaAssetFaultInjector,
  createSceneAssetLoader,
  externalAssetUrisFromGlb,
  type AssetBudgetManifestEntry,
  type FirstPlayableAssetCategory,
  type QaAssetFaultInjector,
} from "./game/asset-loading.ts";
import { runtimeAtmosphereForLevel } from "./game/atmosphere.ts";
import { FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS } from "./game/runtime-assets.ts";
import {
  CAMPAIGN_LEVELS,
  createPlayerKnowledge,
  getCampaignGameplayConfig,
  getCampaignHideGuidancePolicy,
  publicThreatStrengthForMode,
  updatePlayerKnowledge,
  type CampaignLevelDefinition,
  type CampaignTheme,
  type PublicThreatLevel,
} from "./game/campaign.ts";
import {
  createCampaignProgress,
  getCampaignRunRecord,
  getCampaignUnlockedThrough,
  recordCampaignCompletion,
  sanitizeCampaignProgress,
  type CampaignProgress,
} from "./game/campaign-progress.ts";
import type {
  CaptureReason,
  ChaserMode,
  GameConfig,
  GamePhase,
  GameState,
  HideArchetypeKind,
  HideExitKind,
  HideSpotDefinition,
  LevelDefinition,
  PlayerMode,
  Point,
  SimulationInput,
} from "./game/contracts.ts";
import { failureFeedback } from "./game/failure-feedback.ts";
import {
  advanceFixedStepHostFrame,
  createFixedStepHost,
  resetFixedStepHost,
  type FixedStepHostEdges,
  type FixedStepHostTick,
} from "./game/fixed-step-host.ts";
import {
  planHideGuidance,
  stabilizeHideGuidance,
  type HideGuidanceRisk,
  type HideGuidanceSelection,
  type HideGuidanceTargetState,
  type PlayerKnownChaserEvidence,
} from "./game/hide-guidance.ts";
import { pairedHidePresentationPoint } from "./game/hide-performance.ts";
import {
  FIXED_CAMERA_GROUND_DIRECTION,
  screenMoveToWorld,
  shouldIgnoreFocusedControlKey,
} from "./game/input.ts";
import {
  parseQaDelaySeconds,
  parseQaFlag,
  parseQaKidAnimation,
  parseQaKidAssetVariant,
  parseQaLevel,
  parseQaNormalizedTime,
  parseQaPoliceAssetVariant,
  parseQaPoliceAnimation,
  parseQaPoint,
  summarizeQaGltfDocument,
  type QaGltfDocument,
} from "./game/qa-browser.ts";
import {
  MASTERY_CHALLENGE_IDS,
  applyRunTelemetryFrame,
  createRunTelemetry,
  evaluateRunMastery,
  masteryTargetSeconds,
  mergeStoredMastery,
  personalBestDelta,
  previewRunMastery,
  type RunCausalEvent,
  type MasteryTargetOptions,
  type MasteryRank,
  type RunMasteryResult,
  type StoredMastery,
} from "./game/mastery.ts";
import {
  GhostFixedStepInputBuffer,
  GhostReplayCursor,
  GhostInputRecorder,
  loadPersonalGhost,
  savePersonalBestGhost,
  type GhostRecording,
  type GhostRuleReplayEvent,
} from "./game/ghost-replay.ts";
import {
  canRacePersonalGhost,
  GhostRaceTracker,
  GhostRuleProgressTracker,
  type GhostRuleEventInput,
  type GhostRuleProgressSnapshot,
  type GhostRaceSnapshot,
} from "./game/ghost-race.ts";
import {
  assistedGameplayConfig,
  DEFAULT_GAMEPLAY_PREFERENCES,
  loadGameplayPreferences,
  playHapticCue,
  saveGameplayPreferences,
  type GameplayPreferences,
} from "./game/gameplay-preferences.ts";
import {
  CHASER_ARCHETYPE_PROFILES,
  type ChaserArchetypeProfile,
} from "./game/chaser-archetypes.ts";
import {
  buildEnvironmentCompositionPlan,
  compositionMaterialVariantForCell,
  createCompositionDecalPixels,
  sampleMechanicWorldFeedback,
} from "./game/environment-composition.ts";
import {
  CERTIFIED_REMIX_MISSION_VERSION,
  certifiedRemixContractsForLevel,
  remixRecordStorageKey,
  remixReplayLevelId,
  resolveCertifiedRemix,
  type CertifiedRemixContract,
} from "./game/remix-contracts.ts";
import { distanceBetween, GridPathPlanner, hasLineOfSight } from "./game/navigation.ts";
import {
  createObjectiveGuidanceState,
  deriveRouteGuidanceGeometry,
  updateObjectiveGuidance,
} from "./game/navigation-guidance.ts";
import {
  LIBRARY_BRANCHING_MISSION,
  LIBRARY_BRANCHING_MISSION_TOPOLOGY,
  LIBRARY_BRANCHING_MISSION_VERSION,
  adaptLibraryMissionToThemeMissionState,
  adaptLibraryMissionTransitionToThemeMission,
  auditLibraryMissionSoftlocks,
  availableLibraryObjectiveIds,
  createInitialLibraryMissionState,
  libraryMissionCommitmentWindow,
  stepLibraryBranchingMission,
  type LibraryMissionEvent,
  type LibraryMissionPlanId,
  type LibraryMissionState,
} from "./game/library-branching-mission.ts";
import {
  LIBRARY_PORTABLE_DECOY_DEFINITION,
  acknowledgePortableDecoySound,
  createPortableDecoyState,
  deployPortableDecoy,
  portableDecoySoundStimulus,
  samplePortableDecoy,
  stepPortableDecoy,
  type PortableDecoySample,
  type PortableDecoyState,
} from "./game/portable-decoy.ts";
import {
  createStealthEvidenceState,
  queryStealthEvidenceForAi,
  stepStealthEvidence,
  type AiEvidenceView,
  type PublicEvidenceObservation,
  type StealthEvidenceState,
} from "./game/stealth-evidence.ts";
import {
  STEALTH_TOOL_KINDS,
  advanceStealthToolbelt,
  beginStealthToolUse,
  createStealthToolbeltState,
  sampleStealthToolbelt,
  type StealthToolKind,
  type StealthToolReceipt,
  type StealthToolbeltSample,
  type StealthToolbeltState,
} from "./game/stealth-toolbelt.ts";
import {
  aiEvidenceCandidateToPerception,
  canCornerMirrorObservePoint,
  createCampaignTensionDirectorDefinition,
  isDoorWedgeTraversalAttempt,
  resolveStealthToolTarget,
  tensionDirectorModifiers,
} from "./game/stealth-expansion.ts";
import {
  createInitialTensionDirectorState,
  stepTensionDirector,
  type TensionDirectorEventKind,
  type TensionDirectorState,
  type TensionTier,
} from "./game/tension-director.ts";
import {
  isPlayerVisuallyExposed,
  playerVisualObservationPosition,
} from "./game/perception.ts";
import {
  EMERGENCY_RENDER_POLICIES,
  INITIAL_EMERGENCY_DEGRADATION_STATE,
  nextRenderQuality,
  RENDER_QUALITY_PROFILES,
  selectInitialRenderQuality,
  updateEmergencyDegradation,
  type EmergencyDegradationState,
  type RenderQualityProfile,
  type RenderQualityTier,
} from "./game/quality.ts";
import { resolveRuntimeObjectPolicy } from "./game/runtime-visibility.ts";
import {
  authoredRoomFloorRegions,
  enclosedRoomFloorRegions,
  roomFloorBoundaryTrimPlacement,
  roomFloorSupportForFootprint,
} from "./game/room-floor.ts";
import {
  actorReadabilityRimStrength,
  baseCameraDistanceForAspect,
  boundedFrameDeltaSeconds,
  cameraFocusForTraversalEdge,
  cameraFocusForSafeViewport,
  cameraSafeViewportFromInsets,
  cameraDistanceScaleForPlayerMode,
  cameraFocusForEdgeHide,
  canChaserTakeLockerDoor,
  chaserAnimationForMode,
  fixedCameraCompositionConstraints,
  gameplayCameraInsetsForViewport,
  lockerCameraPoseBlend,
  lockerObservationExposureMultiplier,
  lockerVisionMix,
  minimumActorScreenHeightPixelsForViewport,
  shouldFrameChaser,
  shouldRenderChaserModel,
  createFixedCameraFollowState,
  smoothOcclusionStrength,
  stepFixedCameraFollow,
  type FixedCameraFollowState,
} from "./game/presentation.ts";
import {
  GameSimulation,
  type ChaserArchetypeRuntimeView,
  type HideExitSelection,
  type HideInteraction,
} from "./game/simulation.ts";
import {
  createMechanicInstance,
  createThemeMechanicDefinition,
  mechanicActivationNoiseStimulus,
  mechanicRequiresMovementCommitment,
  sampleMechanicInstance,
  stepMechanicInstance,
  type MechanicInstance,
  type MechanicInstanceSample,
} from "./game/theme-mechanics.ts";
import {
  auditThemeMissionSoftlock,
  availableThemeObjectiveIds,
  createInitialThemeMissionState,
  planThemeMissionPlacements,
  stepThemeMission,
  themeMissionDefinition,
  type MissionObjectivePlacement,
  type ThemeMissionState,
  type ThemeObjectiveDefinition,
} from "./game/theme-objectives.ts";
import { combineScreenMove, sampleVirtualStick } from "./game/virtual-stick.ts";

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
const POLICE_PREFETCH_DISTANCE_CELLS = 7.5;
const DEFERRED_DRESSING_FADE_SECONDS = 0.48;
const PORTABLE_DECOY_RELEASE_FRACTION = 0.32;

const LOCOMOTION_MARKERS: MarkerManifest = Object.freeze({
  walk: Object.freeze([
    Object.freeze({ name: "footLContact", normalizedTime: 0.18 }),
    Object.freeze({ name: "footRContact", normalizedTime: 0.68 }),
  ]),
  run: Object.freeze([
    Object.freeze({ name: "footLContact", normalizedTime: 0.12 }),
    Object.freeze({ name: "footRContact", normalizedTime: 0.62 }),
  ]),
});

const KID_ASSET_CACHE_VERSION = "3";
const POLICE_ASSET_CACHE_VERSION = "4";
const POLICE_BOOTSTRAP_MODEL_HREF = "/models/characters/police-bootstrap.glb";

const ACTOR_SPECS = {
  kid: {
    bootstrapUrl: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.player,
    // The authored child is intentionally shorter than both adults. At the
    // production camera this keeps the player inside the audited 34--58 px
    // desktop / 42--68 px touch silhouette bands without changing collision,
    // navigation, camera tuning or any gameplay coordinate.
    height: 1.12,
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
    required: ["idle", "walk", "run", "turnLeft", "turnRight", "enterHide", "hideIdle", "peekLeft", "exitHide", "caught", "celebrate", "point"] as AnimationState[],
  },
  villain: {
    bootstrapUrl: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.threat,
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
  // Police stays deferred, but the A2 asset needs a cache key distinct from
  // the pre-remodel bootstrap shipped by the remote trunk.
  police: {
    url: `${POLICE_BOOTSTRAP_MODEL_HREF}?v=${POLICE_ASSET_CACHE_VERSION}`,
    height: 1.82,
    aliases: {
      idle: "Idle",
      run: "Run",
      point: "Interact",
      protect: "Resolve",
      alert: "Alert",
    },
    required: ["idle", "run", "point", "protect", "alert"] as AnimationState[],
  },
} as const;

const STRUCTURE_ASSETS = {
  frontGate: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.frontGate,
  exit: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.exit,
} as const;

const DETAIL_ASSETS = {
  locker: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.locker,
  bench: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.bench,
  car: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.policeCar,
  tree: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.tree,
  classroomDoor: "/models/environment/classroom-door.glb?v=5",
  ceilingLight: "/models/environment/ceiling-light.glb?v=5",
  basketball: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.basketball,
  deskChair: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.deskChair,
  blackboard: "/models/environment/blackboard.glb?v=5",
  bulletin: "/models/environment/bulletin.glb?v=5",
  podium: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.podium,
  extinguisher: "/models/environment/extinguisher.glb?v=5",
  trash: "/models/environment/trash.glb?v=5",
  books: "/models/environment/books.glb?v=5",
  backpack: "/models/environment/backpack.glb?v=5",
  shrub: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.shrub,
  station: "/models/environment/station.glb?v=5",
} as const;

const THEME_KIT_ASSETS: Readonly<Record<CampaignTheme, string>> = {
  campus: FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.theme,
  hospital: "/models/environment/themes/hospital-kit-bootstrap.glb?v=1",
  "fire-station": "/models/environment/themes/fire-station-kit-bootstrap.glb?v=1",
  factory: "/models/environment/themes/factory-kit-bootstrap.glb?v=1",
};

const STEALTH_CORNER_MIRROR_ASSET =
  FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS.cornerMirror;
// Screenshot controllers renew this deliberately short browser-owned lease.
// If the controller is killed or its CDP socket drops, animation resumes
// without waiting for the controller's much longer screenshot timeout.
const QA_CAPTURE_HOLD_DEFAULT_LEASE_MS = 5_000;
const QA_CAPTURE_HOLD_MAX_LEASE_MS = 8_000;

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
    { asset: "books", height: 0.21, role: "interior-3", tangent: 0.82, depth: -0.08, elevation: 0.76 },
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

type ThemeMechanicArtSpec = {
  readonly node: string;
  readonly height: number;
  readonly label: string;
};

const THEME_MECHANIC_ART: Readonly<Record<CampaignTheme, ThemeMechanicArtSpec>> = {
  campus: {
    node: "CampusWayfinding",
    height: 2.05,
    label: "走廊总铃控制台",
  },
  hospital: {
    node: "HospitalWayfinding",
    height: 2.05,
    label: "门帘呼叫控制站",
  },
  "fire-station": {
    node: "FireHoseReel",
    height: 1.8,
    label: "训练排烟阀",
  },
  factory: {
    node: "FactoryControlConsole",
    height: 1.62,
    label: "设备旁路控制台",
  },
};

type StealthToolArtSpec = {
  readonly node: string;
  readonly height: number;
  readonly label: string;
  readonly indicatorAnchor?: readonly [number, number, number];
  readonly wallOffsetCells?: number;
  readonly runtimeScale?: number;
};

const THEME_STEALTH_TOOL_ART: Readonly<
  Record<CampaignTheme, Readonly<Record<StealthToolKind, StealthToolArtSpec>>>
> = {
  campus: {
    "door-wedge": {
      node: "CampusBikeRack",
      height: 0.48,
      label: "走廊门楔锁",
      indicatorAnchor: [0, 0.27, 0.11],
    },
    "corner-mirror": {
      node: "CampusCornerMirror",
      height: 1.72,
      label: "校园墙角凸面观察镜",
      // Campus opens on the widest exploration camera of the four themes.
      // Preserve an inspection-readable silhouette at its far deployment.
      runtimeScale: 1.1,
    },
    "temporary-blackout": {
      node: "CampusWayfinding",
      height: 0.82,
      label: "走廊断电控制牌",
      indicatorAnchor: [0, 0.64, 0.055],
      wallOffsetCells: 0.46,
    },
  },
  hospital: {
    "door-wedge": {
      node: "HospitalCrashCart",
      height: 0.68,
      label: "急救车门楔锁",
      indicatorAnchor: [0, 0.45, 0.16],
    },
    "corner-mirror": {
      node: "HospitalCornerMirror",
      height: 1.72,
      label: "病区墙角凸面观察镜",
      runtimeScale: 1.02,
    },
    "temporary-blackout": {
      node: "HospitalWayfinding",
      height: 0.82,
      label: "病区应急控制牌",
      indicatorAnchor: [0, 0.64, 0.055],
      wallOffsetCells: 0.46,
    },
  },
  "fire-station": {
    "door-wedge": {
      node: "FireSafetyCones",
      height: 0.5,
      label: "训练区门楔锁",
      indicatorAnchor: [0, 0.28, 0.22],
    },
    "corner-mirror": {
      node: "FireStationCornerMirror",
      height: 1.72,
      label: "消防站墙角凸面观察镜",
      runtimeScale: 1.08,
    },
    "temporary-blackout": {
      node: "FireStationWayfinding",
      height: 0.84,
      label: "消防站断电控制牌",
      indicatorAnchor: [0, 0.63, 0.06],
      wallOffsetCells: 0.46,
    },
  },
  factory: {
    "door-wedge": {
      node: "FactorySafetyBarrier",
      height: 0.52,
      label: "安全栅门楔锁",
      indicatorAnchor: [0, 0.32, 0.13],
    },
    "corner-mirror": {
      node: "FactoryCornerMirror",
      height: 1.72,
      label: "工厂墙角凸面观察镜",
      // The factory's wider surveillance camera framing needs the physically
      // larger industrial mirror variant to preserve the same HUD-safe read.
      runtimeScale: 1.3,
    },
    "temporary-blackout": {
      node: "FactoryControlConsole",
      height: 0.78,
      label: "设备断电控制台",
      indicatorAnchor: [0, 0.64, 0.24],
      wallOffsetCells: 0.36,
    },
  },
};

type HideArchetypeArtSpec = {
  readonly nodes: readonly string[];
  readonly height: number;
  readonly label: string;
};

const HIDE_ARCHETYPE_ART: Readonly<
  Record<CampaignTheme, Readonly<Record<Exclude<HideArchetypeKind, "hard-locker">, HideArchetypeArtSpec>>>
> = {
  campus: {
    "soft-cover": {
      nodes: ["CampusLibraryShelves", "CampusReadingCluster", "CampusTrophyCase"],
      height: 1.82,
      label: "书架遮挡",
    },
    "traversal-hide": {
      nodes: ["CampusArchiveCluster", "CampusLibraryHideDressing", "CampusHideDressing"],
      height: 2.08,
      label: "档案穿行道",
    },
  },
  hospital: {
    "soft-cover": {
      nodes: ["HospitalPrivacyScreen", "HospitalIsolationWardCluster", "HospitalBed"],
      height: 1.9,
      label: "医用隔帘",
    },
    "traversal-hide": {
      nodes: ["HospitalAirlockCluster", "HospitalOutpatientHideDressing", "HospitalHideDressing"],
      height: 2.08,
      label: "双向隔离舱",
    },
  },
  "fire-station": {
    "soft-cover": {
      nodes: ["FireGearRack", "FireStationBreathingGearCluster", "FireStationTurnoutCluster"],
      height: 2.05,
      label: "消防服架",
    },
    "traversal-hide": {
      nodes: ["FireStationTurnoutCluster", "FireStationEngineBayHideDressing", "FireStationHideDressing"],
      height: 2.12,
      label: "装备穿行架",
    },
  },
  factory: {
    "soft-cover": {
      nodes: ["FactorySafetyBarrier", "FactoryCrateStack", "FactoryControlConsole"],
      height: 1.52,
      label: "工位遮挡",
    },
    "traversal-hide": {
      nodes: ["FactoryPipeAssembly", "FactoryAssemblyHideDressing", "FactoryHideDressing"],
      height: 2.12,
      label: "检修穿行道",
    },
  },
};

const PROP_SET_FEATURED_THEME_PROPS: Readonly<Record<string, FeaturedThemeProps>> = {
  "campus-classic": {
    interior: ["CampusTrophyCase", "CampusWaterFountain", "CampusVendingMachine"],
    arrival: ["CampusBikeRack", "CampusWayfinding"],
  },
  "campus-library": {
    interior: ["CampusTrophyCase", "CampusVendingMachine", "CampusWaterFountain"],
    arrival: ["CampusWayfinding", "CampusBikeRack"],
  },
  "campus-science": {
    interior: ["CampusVendingMachine", "CampusWaterFountain", "CampusTrophyCase"],
    arrival: ["CampusWayfinding", "CampusBikeRack"],
  },
  "hospital-outpatient": {
    interior: ["HospitalBed", "HospitalIVStation", "HospitalCrashCart", "HospitalPrivacyScreen"],
    arrival: ["HospitalWheelchair", "HospitalWayfinding"],
  },
  "hospital-isolation": {
    interior: ["HospitalPrivacyScreen", "HospitalBed", "HospitalIVStation", "HospitalCrashCart"],
    arrival: ["HospitalWayfinding", "HospitalWheelchair"],
  },
  "fire-engine-bay": {
    interior: ["FireGearRack", "FireHoseReel", "FireHydrant"],
    arrival: ["FireEngine", "FireStationWayfinding", "FireSafetyCones"],
  },
  "fire-training": {
    interior: ["FireGearRack", "FireHoseReel", "FireHydrant"],
    arrival: ["FireStationWayfinding", "FireSafetyCones", "FireHydrant"],
  },
  "factory-assembly": {
    interior: ["FactoryConveyor", "FactoryControlConsole", "FactoryPipeAssembly", "FactoryStorageTank"],
    arrival: ["FactorySafetyBarrier", "FactoryCrateStack"],
  },
  "factory-turbine": {
    interior: ["FactoryPipeAssembly", "FactoryStorageTank", "FactoryControlConsole", "FactoryConveyor"],
    arrival: ["FactorySafetyBarrier", "FactoryCrateStack"],
  },
  "factory-foundry": {
    interior: ["FactoryStorageTank", "FactoryPipeAssembly", "FactorySafetyBarrier", "FactoryCrateStack"],
    arrival: ["FactorySafetyBarrier", "FactoryCrateStack"],
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

// Kid, villain, the active theme and the compact four-theme stealth mirror
// kit are the only core bootstrap payloads. The police resolution actor is
// streamed after play becomes available.
const BOOTSTRAP_ASSET_COUNT = 4;

function world(point: Point, level: LevelDefinition) {
  return new THREE.Vector3(
    (point.x - (level.width - 1) / 2) * CELL,
    0,
    (point.y - (level.height - 1) / 2) * CELL,
  );
}

function lockerSightDirection(
  spot: HideSpotDefinition,
  level: LevelDefinition,
): Point {
  const origin = {
    x: Math.round(spot.approach.x),
    y: Math.round(spot.approach.y),
  };
  const candidates: readonly Point[] = [
    { x: 0, y: 1 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: -1, y: 0 },
  ];
  let best = spot.facing;
  let bestScore = -Infinity;
  for (const direction of candidates) {
    const facingPreference = direction.x * spot.facing.x + direction.y * spot.facing.y;
    // Looking back through the cabinet body can score well when the corridor
    // continues behind a wall-mounted prop, but it produces a useless close-up
    // of the door. Peeking may turn left or right, never 180° through the model.
    if (facingPreference < -0.1) continue;
    let visibleCells = 0;
    for (let step = 1; step <= 8; step += 1) {
      const x = origin.x + direction.x * step;
      const y = origin.y + direction.y * step;
      if (!level.walkable[y]?.[x]) break;
      visibleCells += 1;
    }
    const score = visibleCells * 10 + facingPreference;
    if (score > bestScore) {
      best = direction;
      bestScore = score;
    }
  }
  return best;
}

function themeMechanicPlacement(
  level: LevelDefinition,
  reservedAnchors: readonly Point[] = [],
): Point {
  const route = new GridPathPlanner(level).path(level.playerStart, level.exit);
  const routeCandidates = route.slice(
    Math.max(1, Math.floor(route.length * 0.24)),
    Math.max(2, Math.ceil(route.length * 0.72)),
  );
  const occupied = [
    level.playerStart,
    level.exit,
    ...level.hideSpots.flatMap((spot) => [spot.approach, spot.concealed]),
    ...reservedAnchors,
  ];
  const junctionScore = (point: Point) => {
    const exits = [
      { x: point.x - 1, y: point.y },
      { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y - 1 },
      { x: point.x, y: point.y + 1 },
    ].filter((candidate) => level.walkable[candidate.y]?.[candidate.x]).length;
    const clearance = Math.min(...occupied.map((anchor) => distanceBetween(point, anchor)));
    return exits * 10 + Math.min(8, clearance);
  };
  const eligible = routeCandidates.filter((point) => (
    occupied.every((anchor) => distanceBetween(point, anchor) >= 2.25)
  ));
  return { ...(
    eligible.sort((left, right) => junctionScore(right) - junctionScore(left))[0]
    ?? routeCandidates[Math.floor(routeCandidates.length / 2)]
    ?? level.patrol[Math.floor(level.patrol.length / 2)]
    ?? level.playerStart
  ) };
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
  canvas.width = 320;
  canvas.height = 144;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建藏身点引导纹理");

  const color = new THREE.Color(accent);
  const red = Math.round(color.r * 255);
  const green = Math.round(color.g * 255);
  const blue = Math.round(color.b * 255);
  const glow = `rgb(${red} ${green} ${blue})`;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.shadowColor = glow;
  context.shadowBlur = 20;
  const panel = context.createLinearGradient(18, 18, 302, 126);
  panel.addColorStop(0, "rgba(4, 15, 18, .94)");
  panel.addColorStop(1, "rgba(4, 18, 20, .78)");
  context.fillStyle = panel;
  context.strokeStyle = `rgba(${red}, ${green}, ${blue}, 0.88)`;
  context.lineWidth = 4;
  context.beginPath();
  context.roundRect(18, 18, 284, 108, 30);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.18)`;
  context.strokeStyle = glow;
  context.lineWidth = 5;
  context.beginPath();
  context.roundRect(40, 39, 58, 66, 12);
  context.fill();
  context.stroke();
  context.beginPath();
  context.arc(82, 72, 4, 0, Math.PI * 2);
  context.fillStyle = glow;
  context.fill();
  context.font = '800 32px Inter, "PingFang SC", sans-serif';
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillStyle = "#f4fff9";
  context.fillText("藏身", 122, 62);
  context.font = '750 16px Inter, "PingFang SC", sans-serif';
  context.fillStyle = `rgba(${red}, ${green}, ${blue}, 0.95)`;
  context.fillText("靠近后交互", 123, 94);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "Authored_Hide_Beacon";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

function createMechanicBeaconTexture(
  accent: THREE.ColorRepresentation,
  label: string,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 192;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建主题机关引导纹理");
  const color = new THREE.Color(accent);
  const red = Math.round(color.r * 255);
  const green = Math.round(color.g * 255);
  const blue = Math.round(color.b * 255);
  const glow = `rgb(${red} ${green} ${blue})`;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const panel = context.createLinearGradient(30, 22, 482, 170);
  panel.addColorStop(0, "rgba(4, 12, 17, .96)");
  panel.addColorStop(1, `rgba(${red}, ${green}, ${blue}, .18)`);
  context.shadowColor = glow;
  context.shadowBlur = 24;
  context.fillStyle = panel;
  context.strokeStyle = `rgba(${red}, ${green}, ${blue}, .92)`;
  context.lineWidth = 5;
  context.beginPath();
  context.roundRect(20, 24, 472, 144, 32);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = `rgba(${red}, ${green}, ${blue}, .2)`;
  context.beginPath();
  context.arc(84, 96, 42, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = glow;
  context.lineWidth = 7;
  context.beginPath();
  context.arc(84, 96, 25, -Math.PI * 0.78, Math.PI * 0.78);
  context.stroke();
  context.beginPath();
  context.moveTo(84, 65);
  context.lineTo(84, 100);
  context.stroke();
  context.fillStyle = "#f5fbfa";
  context.font = '800 34px Inter, "PingFang SC", sans-serif';
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(label, 146, 79);
  context.font = '700 21px Inter, "PingFang SC", sans-serif';
  context.fillStyle = glow;
  context.fillText("靠近后按 E 启动 · 可误导追捕者", 148, 124);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "Authored_Theme_Mechanic_Beacon";
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

function fixedScreenArrowForWorldDirection(direction: Point) {
  const cameraLength = Math.hypot(
    FIXED_CAMERA_GROUND_DIRECTION.x,
    FIXED_CAMERA_GROUND_DIRECTION.y,
  ) || 1;
  const cameraBack = {
    x: FIXED_CAMERA_GROUND_DIRECTION.x / cameraLength,
    y: FIXED_CAMERA_GROUND_DIRECTION.y / cameraLength,
  };
  const screenRight = { x: cameraBack.y, y: -cameraBack.x };
  const screenX = direction.x * screenRight.x + direction.y * screenRight.y;
  const screenY = direction.x * cameraBack.x + direction.y * cameraBack.y;
  return Math.abs(screenX) > Math.abs(screenY)
    ? screenX >= 0 ? "→" : "←"
    : screenY >= 0 ? "↓" : "↑";
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

function stripTransparentArchitecture(source: THREE.Object3D) {
  const root = source.clone(true);
  const removable: THREE.Object3D[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material.transparent || material.opacity < 0.98)) {
      removable.push(object);
    }
  });
  for (const object of removable) object.parent?.remove(object);
  return root;
}

function cloneGeometryForStaticBake(
  source: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
) {
  const geometry = source.clone();
  // gltfpack keeps POSITION/NORMAL/TANGENT in compact integer accessors and
  // reconstructs their authored range with a node transform. BufferGeometry's
  // CPU transform methods write back through the original attribute type:
  // writing a fitted 0..2.1 m wall into Uint16 rounds it to just 0/1/2 and
  // collapses many triangles. The isolated GLB renders correctly because the
  // GPU applies that transform without rewriting the accessor. Decode only the
  // attributes touched by applyMatrix4 before baking the hierarchy to preserve
  // both the compact asset on disk and continuous runtime geometry.
  for (const name of ["position", "normal", "tangent"] as const) {
    const attribute = geometry.getAttribute(name);
    if (
      !attribute
      || (
        attribute instanceof THREE.BufferAttribute
        && attribute.array instanceof Float32Array
      )
    ) {
      continue;
    }
    const values = new Float32Array(attribute.count * attribute.itemSize);
    for (let index = 0; index < attribute.count; index += 1) {
      const offset = index * attribute.itemSize;
      values[offset] = attribute.getX(index);
      if (attribute.itemSize > 1) values[offset + 1] = attribute.getY(index);
      if (attribute.itemSize > 2) values[offset + 2] = attribute.getZ(index);
      if (attribute.itemSize > 3) values[offset + 3] = attribute.getW(index);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize));
  }
  return geometry.applyMatrix4(matrixWorld);
}

function flattenStatic(root: THREE.Object3D, castShadow = false) {
  root.updateMatrixWorld(true);
  const flat = new THREE.Group();
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    if (Array.isArray(object.material) || Object.keys(object.geometry.morphAttributes).length > 0) {
      const mesh = new THREE.Mesh(
        cloneGeometryForStaticBake(object.geometry, object.matrixWorld),
        object.material,
      );
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      flat.add(mesh);
      return;
    }
    const attributes = (Object.entries(object.geometry.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][])
      .map(([name, attribute]) => {
        const array = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
        const gpuType = attribute instanceof THREE.InterleavedBufferAttribute
          ? "interleaved"
          : attribute.gpuType;
        return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}:${gpuType}`;
      })
      .sort()
      .join("|");
    const signature = `${object.material.uuid}:${object.geometry.index ? "indexed" : "plain"}:${attributes}`;
    const bucket: { material: THREE.Material; geometries: THREE.BufferGeometry[] } = buckets.get(signature) ?? {
      material: object.material,
      geometries: [],
    };
    bucket.geometries.push(cloneGeometryForStaticBake(object.geometry, object.matrixWorld));
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

function staticMeshBounds(root: THREE.Object3D) {
  // gltfpack represents quantized POSITION data with a decode transform on the
  // mesh node. SkinnedMesh.computeBoundingBox()/getVertexPosition() can apply
  // that transform at the wrong stage, so both Three.js generic Box3 paths are
  // unreliable for absolute character scale. Geometry bounds transformed by
  // each mesh's matrixWorld match the actual GPU decode path for compressed and
  // uncompressed actors alike.
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    if (!object.geometry.boundingBox) return;
    bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  return bounds;
}

function authoredGeometrySignature(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const parts: string[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const bounds = object.geometry.boundingBox;
    const size = bounds?.getSize(new THREE.Vector3()) ?? new THREE.Vector3();
    const position = object.geometry.getAttribute("position");
    parts.push([
      position?.count ?? 0,
      object.geometry.index?.count ?? 0,
      size.x.toFixed(4),
      size.y.toFixed(4),
      size.z.toFixed(4),
    ].join(":"));
  });
  return parts.sort().join("|");
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
  const initial = staticMeshBounds(visual);
  const initialSize = initial.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(initialSize.y, 0.001));
  const fitted = staticMeshBounds(visual);
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

/**
 * Extract one authored static subassembly from a larger GLB without replacing
 * it with runtime primitives. World transforms are baked so Blender-authored
 * hierarchy and gltfpack decode transforms remain intact.
 */
function fitNamedStaticProp(
  source: THREE.Object3D,
  namePrefix: string,
  maximumDimension: number,
  castShadow = false,
) {
  source.updateMatrixWorld(true);
  const selected = new THREE.Group();
  selected.name = `${namePrefix}-authored-source`;
  const collectedMeshes = new Set<THREE.Mesh>();
  source.traverse((semanticRoot) => {
    if (!semanticRoot.name.startsWith(namePrefix)) return;
    semanticRoot.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || collectedMeshes.has(object)) return;
      collectedMeshes.add(object);
      const mesh = new THREE.Mesh(
        object.geometry,
        Array.isArray(object.material) ? [...object.material] : object.material,
      );
      mesh.name = object.name || `${semanticRoot.name}-mesh`;
      object.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
      selected.add(mesh);
    });
  });
  if (!selected.children.length) {
    throw new Error(`正式美术资产缺少命名子组件 ${namePrefix}`);
  }
  const fitted = fitProp(selected, 1, castShadow);
  const size = new THREE.Box3()
    .setFromObject(fitted)
    .getSize(new THREE.Vector3());
  fitted.scale.multiplyScalar(
    maximumDimension / Math.max(size.x, size.y, size.z, 0.001),
  );
  fitted.name = `${namePrefix}-authored-prop`;
  return fitted;
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
            const gpuType = attribute instanceof THREE.InterleavedBufferAttribute
              ? "interleaved"
              : attribute.gpuType;
            return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}:${gpuType}`;
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
      // BatchedMesh converts non-indexed geometry to indexed draw ranges
      // internally. A batch can contain both forms, so taking the larger of
      // the aggregate index and vertex counts under-allocates whenever both
      // are present. That overflow presents as giant stray triangles across
      // the maze rather than a clean WebGL error. Reserve every geometry's
      // actual draw count instead.
      const maxIndexCount = batch.geometries.reduce(
        (total, item) => total + (item.geometry.index?.count
          ?? item.geometry.getAttribute("position")?.count
          ?? 0),
        0,
      );
      if (!maxInstanceCount || !maxVertexCount) continue;
      const batched = new THREE.BatchedMesh(
        maxInstanceCount,
        maxVertexCount,
        maxIndexCount,
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
  readabilityRim: { value: number };
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

type QaLoadedGlbIdentity = Readonly<{
  requestedUrl: string;
  resolvedUrl: string;
  transferBytes: number;
  sha256: string;
  nodes: number;
  meshes: number;
  primitives: number;
  triangles: number;
  materials: number;
  textures: number;
  skins: number;
  joints: number;
  jointNames: readonly string[];
  runtimeMeshObjects: number;
  runtimeSkinnedMeshes: number;
  runtimeSkeletons: number;
  runtimeBones: number;
  clips: readonly Readonly<{
    name: string;
    durationSeconds: number;
    tracks: number;
  }>[];
}>;

function inspectQaLoadedGlbIdentity(
  asset: GLTF,
  requestedUrl: string,
  resolvedUrl: string,
  transferBytes: number,
  sha256: string,
): QaLoadedGlbIdentity {
  const json = (asset.parser as unknown as { json?: QaGltfDocument }).json;
  const source = summarizeQaGltfDocument(json);
  let runtimeMeshObjects = 0;
  let runtimeSkinnedMeshes = 0;
  let runtimeBones = 0;
  const runtimeSkeletons = new Set<string>();
  asset.scene.traverse((object) => {
    if (object instanceof THREE.Mesh) runtimeMeshObjects += 1;
    if (object instanceof THREE.SkinnedMesh) {
      runtimeSkinnedMeshes += 1;
      runtimeSkeletons.add(object.skeleton.uuid);
    }
    if (object instanceof THREE.Bone) runtimeBones += 1;
  });
  return Object.freeze({
    requestedUrl,
    resolvedUrl,
    transferBytes,
    sha256,
    ...source,
    runtimeMeshObjects,
    runtimeSkinnedMeshes,
    runtimeSkeletons: runtimeSkeletons.size,
    runtimeBones,
    clips: Object.freeze(asset.animations
      .map((clip) => Object.freeze({
        name: clip.name,
        durationSeconds: Number(clip.duration.toFixed(6)),
        tracks: clip.tracks.length,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))),
  });
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function installActorReadabilityRim(
  root: THREE.Object3D,
  color: THREE.ColorRepresentation,
): { value: number } {
  const strength = { value: 0 };
  const rimColor = new THREE.Color(color);
  const configured = new Set<string>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial) || configured.has(material.uuid)) continue;
      configured.add(material.uuid);
      const previousCompile = material.onBeforeCompile.bind(material);
      const previousCacheKey = material.customProgramCacheKey.bind(material);
      material.onBeforeCompile = (shader, renderer) => {
        previousCompile(shader, renderer);
        shader.uniforms.actorReadabilityRimColor = { value: rimColor };
        shader.uniforms.actorReadabilityRimStrength = strength;
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
float actorReadabilityFresnel = pow(
  1.0 - saturate(dot(normalize(normal), normalize(vViewPosition))),
  2.35
);
totalEmissiveRadiance += actorReadabilityRimColor
  * actorReadabilityFresnel
  * actorReadabilityRimStrength;`,
        ).replace(
          "#include <common>",
          `#include <common>
uniform vec3 actorReadabilityRimColor;
uniform float actorReadabilityRimStrength;`,
        );
      };
      material.customProgramCacheKey = () => `${previousCacheKey()}:actor-readability-rim-v1`;
      material.needsUpdate = true;
    }
  });
  return strength;
}

type LockerView = {
  id: string;
  archetype: HideArchetypeKind;
  root: THREE.Group;
  basePosition: THREE.Vector3;
  baseRotationY: number;
  baseScale: THREE.Vector3;
  alternateExit: Point | null;
  approach: Point;
  cameraAnchor: THREE.Object3D;
  peekAnchor: THREE.Object3D;
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

type MechanicView = {
  root: THREE.Group;
  beacon: THREE.Sprite;
  light: THREE.PointLight;
  position: Point;
  baseScale: THREE.Vector3;
};

type MissionObjectiveView = {
  id: string;
  root: THREE.Group;
  beacon: THREE.Sprite;
  light: THREE.PointLight;
  position: Point;
  baseScale: THREE.Vector3;
};

type PortableDecoyView = {
  deploymentId: string;
  sourceId: string;
  root: THREE.Group;
  beacon: THREE.Sprite;
  light: THREE.PointLight;
  start: THREE.Vector3;
  landing: THREE.Vector3;
  deployedAtSeconds: number;
  releaseAtSeconds: number;
  soundAtSeconds: number;
  expiresAtSeconds: number;
  settled: boolean;
  lightRegistered: boolean;
  released: boolean;
  disposed: boolean;
};

type StealthEvidenceView = {
  readonly id: string;
  readonly placedAssetId: string;
  readonly root: THREE.Group;
  readonly light: THREE.PointLight | null;
  readonly createdAtTick: number;
  readonly expiresAtTick: number;
};

type StealthToolWorldView = {
  readonly receiptId: string;
  readonly placedAssetId: string;
  readonly tool: StealthToolKind;
  readonly root: THREE.Group;
  readonly light: THREE.PointLight | null;
  readonly createdAtTick: number;
  readonly expiresAtTick: number;
  readonly basePosition: THREE.Vector3;
  readonly baseScale: THREE.Vector3;
  readonly baseRotation: THREE.Euler;
  readonly ownedGeometries: ReadonlySet<THREE.BufferGeometry>;
  readonly ownedMaterials: ReadonlySet<THREE.Material>;
  disposed: boolean;
};

type StealthSystemsUiState = {
  readonly toolbelt: StealthToolbeltSample;
  readonly selectedTool: StealthToolKind;
  readonly evidenceCount: number;
  readonly countermeasureBudget: number;
  readonly countermeasureBusy: boolean;
  readonly notice: string | null;
  readonly mirrorThreatVisible: boolean;
};

type TensionDirectorUiState = {
  readonly tier: TensionTier;
  readonly score: number;
  readonly phase: "idle" | "warning" | "active";
  readonly kind: TensionDirectorEventKind | null;
  readonly label: string;
  readonly progress: number;
};

type ThemeMechanicUiState = MechanicInstanceSample & {
  readonly distanceMeters: number;
  readonly activationCostLabel: string;
  readonly movementCommitted: boolean;
};

type ThemeMissionUiState = {
  readonly state: ThemeMissionState;
  readonly activeObjective: RuntimeMissionObjective | null;
  readonly activeDistanceMeters: number | null;
  readonly canInteract: boolean;
  readonly commitmentProgress: number | null;
  readonly commitmentRemainingSeconds: number | null;
  readonly completedCount: number;
  readonly totalCount: number;
};

type RuntimeMissionObjective = Pick<
  ThemeObjectiveDefinition,
  "id" | "label" | "interactionPrompt" | "completionHint" | "commitmentSeconds"
> & {
  readonly unlocksExit: boolean;
  readonly planId?: LibraryMissionPlanId;
};

type GhostRaceUiState = GhostRaceSnapshot & {
  readonly visible: boolean;
  readonly ruleFaithful: boolean;
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
  deployDecoy: () => void;
  selectStealthTool: (tool: StealthToolKind) => void;
  useStealthTool: () => void;
  eraseEvidence: () => void;
  toggleMute: () => void;
  togglePause: () => void;
  adjustZoom: (factor: number) => void;
  resetZoom: () => void;
};

type LastRunSummary = RunMasteryResult & {
  isPersonalBest: boolean;
  deltaSeconds: number | null;
  ghostSaveStatus?: "saved-first" | "saved-faster" | "kept-faster" | "rejected-assisted" | "storage-error";
};

const CAMPAIGN_PROGRESS_KEY = "chasing.campaign-progress.v1";
const CERTIFIED_REMIX_RECORD_VERSION = 1;

function libraryG2RunIdentity(
  levelId: string,
  planId: LibraryMissionPlanId,
): string {
  return `${levelId}#${CERTIFIED_REMIX_MISSION_VERSION}:library-g2-v${
    LIBRARY_BRANCHING_MISSION_VERSION
  }:${planId}`;
}

const LIBRARY_G2_RECORD_IDS = Object.freeze(
  LIBRARY_BRANCHING_MISSION.plans.map((plan) => (
    libraryG2RunIdentity(LIBRARY_BRANCHING_MISSION.levelId, plan.id)
  )),
);

type CertifiedRemixBestRecord = {
  readonly version: typeof CERTIFIED_REMIX_RECORD_VERSION;
  readonly replayLevelId: string;
  readonly seed: number;
  readonly ruleset: GameplayPreferences["ruleset"];
  readonly missionVersion: typeof CERTIFIED_REMIX_MISSION_VERSION;
  readonly bestSeconds: number;
  readonly mastery?: StoredMastery;
};

function sanitizeCertifiedRemixMastery(value: unknown): StoredMastery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<StoredMastery>;
  if (!["bronze", "silver", "gold"].includes(candidate.rank ?? "")) return undefined;
  const challengeIds = MASTERY_CHALLENGE_IDS.filter((id) => (
    Array.isArray(candidate.challengeIds) && candidate.challengeIds.includes(id)
  ));
  return Object.freeze({
    rank: candidate.rank as MasteryRank,
    challengeIds: Object.freeze(challengeIds),
    ...(typeof candidate.profileId === "string"
      && candidate.profileId.length > 0
      && candidate.profileId.length <= 120
      ? { profileId: candidate.profileId }
      : {}),
  });
}

function loadCertifiedRemixRecord(
  storage: Storage,
  contract: CertifiedRemixContract,
  ruleset: GameplayPreferences["ruleset"],
): CertifiedRemixBestRecord | null {
  try {
    const value = JSON.parse(
      storage.getItem(remixRecordStorageKey(contract, ruleset)) ?? "null",
    ) as Partial<CertifiedRemixBestRecord> | null;
    const replayLevelId = remixReplayLevelId(contract, ruleset);
    if (!(value?.version === CERTIFIED_REMIX_RECORD_VERSION
      && value.replayLevelId === replayLevelId
      && value.seed === contract.seed
      && value.ruleset === ruleset
      && value.missionVersion === CERTIFIED_REMIX_MISSION_VERSION
      && typeof value.bestSeconds === "number"
      && Number.isFinite(value.bestSeconds)
      && value.bestSeconds > 0)) return null;
    const mastery = sanitizeCertifiedRemixMastery(value.mastery);
    return Object.freeze({
      version: CERTIFIED_REMIX_RECORD_VERSION,
      replayLevelId,
      seed: contract.seed,
      ruleset,
      missionVersion: CERTIFIED_REMIX_MISSION_VERSION,
      bestSeconds: value.bestSeconds,
      ...(mastery ? { mastery } : {}),
    });
  } catch {
    return null;
  }
}

function saveCertifiedRemixRecord(
  storage: Storage,
  contract: CertifiedRemixContract,
  ruleset: GameplayPreferences["ruleset"],
  completedSeconds: number,
  masteryResult: RunMasteryResult,
): CertifiedRemixBestRecord {
  const previous = loadCertifiedRemixRecord(storage, contract, ruleset);
  const bestSeconds = Math.min(
    previous?.bestSeconds ?? Number.POSITIVE_INFINITY,
    completedSeconds,
  );
  const record: CertifiedRemixBestRecord = Object.freeze({
    version: CERTIFIED_REMIX_RECORD_VERSION,
    replayLevelId: remixReplayLevelId(contract, ruleset),
    seed: contract.seed,
    ruleset,
    missionVersion: CERTIFIED_REMIX_MISSION_VERSION,
    bestSeconds,
    mastery: mergeStoredMastery(previous?.mastery, masteryResult),
  });
  try {
    storage.setItem(remixRecordStorageKey(contract, ruleset), JSON.stringify(record));
  } catch {
    // The completed run remains visible in session when storage is unavailable.
  }
  return record;
}

const MASTERY_RANK_LABEL: Readonly<Record<MasteryRank, string>> = Object.freeze({
  bronze: "铜章",
  silver: "银章",
  gold: "金章",
});

const STEALTH_TOOL_UI: Readonly<Record<StealthToolKind, {
  readonly label: string;
  readonly shortLabel: string;
  readonly glyph: string;
  readonly hint: string;
}>> = Object.freeze({
  "door-wedge": Object.freeze({
    label: "门楔",
    shortLabel: "楔",
    glyph: "◢",
    hint: "在窄门布置，只延迟追捕者",
  }),
  "corner-mirror": Object.freeze({
    label: "拐角镜",
    shortLabel: "镜",
    glyph: "◉",
    hint: "从公开观察锥确认拐角威胁",
  }),
  "temporary-blackout": Object.freeze({
    label: "临时断电",
    shortLabel: "电",
    glyph: "ϟ",
    hint: "在主题控制台制造有限暗区",
  }),
});

const NOOP_COMMANDS: GameCommands = {
  begin() {},
  restart() {},
  interact() {},
  deployDecoy() {},
  selectStealthTool() {},
  useStealthTool() {},
  eraseEvidence() {},
  toggleMute() {},
  togglePause() {},
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

function updateActorVisibility(view: ActorView, visible: boolean | number, delta: number, immediate = false) {
  const target = typeof visible === "number"
    ? THREE.MathUtils.clamp(visible, 0, 1)
    : visible ? 1 : 0;
  view.visibilityAlpha = immediate
    ? target
    : THREE.MathUtils.damp(view.visibilityAlpha, target, 18, delta);
  if (Math.abs(view.visibilityAlpha - target) < 0.006) view.visibilityAlpha = target;
  if (target > 0) view.root.visible = true;
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
  if (target === 0 && view.visibilityAlpha === 0) view.root.visible = false;
}

type TextureDeduplication = {
  sourceTextures: number;
  canonicalTextures: number;
  assignmentsShared: number;
  sourcesShared: number;
};

type LoadedAsset = { id: string; asset: GLTF };
type DetailBuildPhase = "essential" | "decorative";

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
  const canonicalSources = new Map<string, THREE.Texture["source"]>();
  const sourceTextures = new Set<THREE.Texture>();
  let assignmentsShared = 0;
  let sourcesShared = 0;

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
          const bootstrapAtlasClass = textureName.match(
            /^(?:Environment|Theme)Bootstrap(BaseColor|Normal|Orm)Atlas$/u,
          )?.[1];
          const normalizedSharedTextureName = bootstrapAtlasClass
            ? `Bootstrap${bootstrapAtlasClass}Atlas`
            : textureName;
          // ImageBitmap deliberately omits a URL. GLTFLoader still assigns
          // the source filename to Texture.name. Only the explicitly shared
          // Env_* library may cross an asset boundary by name; generic embedded
          // names such as BaseColor are scoped to their owning GLB so unrelated
          // high-resolution art can never be merged accidentally.
          const explicitlyShared = /(?:^|\/)Env_[A-Za-z0-9_-]+(?:\.(?:png|webp|ktx2))?$/u.test(textureName)
            || textureName.includes("/SharedTextures/")
            || textureName.includes("/SharedTexturesBootstrapKTX2/")
            || Boolean(bootstrapAtlasClass);
          const sourceIdentity = externalSource
            ? `url:${externalSource}`
            : explicitlyShared
              ? `shared:${normalizedSharedTextureName}`
              : textureName
                ? `asset:${assetId}:${textureName}`
                : "";
          if (!sourceIdentity) continue;
          if (externalSource || explicitlyShared) {
            const sourceKey = [
              sourceIdentity,
              image?.width ?? 0,
              image?.height ?? 0,
              value.colorSpace,
            ].join("|");
            const sharedSource = canonicalSources.get(sourceKey);
            if (!sharedSource) {
              canonicalSources.set(sourceKey, value.source);
            } else if (sharedSource !== value.source) {
              // Texture transforms live on Texture, while decoded image data
              // lives on Source. Sharing only Source therefore preserves every
              // atlas offset/repeat while collapsing repeated KTX2 uploads.
              value.source = sharedSource;
              value.needsUpdate = true;
              sourcesShared += 1;
            }
          }
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
    sourcesShared,
  };
}

function collectObjectTextures(roots: Iterable<THREE.Object3D>) {
  const textures = new Set<THREE.Texture>();
  for (const root of roots) {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line || object instanceof THREE.Sprite)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
  }
  return textures;
}

function countSceneTextures(root: THREE.Object3D) {
  return new Set(
    [...collectObjectTextures([root])].map((texture) => texture.source),
  ).size;
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

function disposeObjectResources(
  roots: Iterable<THREE.Object3D>,
  preservedTextures: ReadonlySet<THREE.Texture> = new Set(),
) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  const imageBitmaps = new Set<ImageBitmap>();
  const preservedImageBitmaps = new Set<ImageBitmap>();
  const collectImageBitmaps = (
    value: unknown,
    target: Set<ImageBitmap>,
  ) => {
    if (typeof ImageBitmap === "undefined") return;
    if (value instanceof ImageBitmap) {
      target.add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => collectImageBitmaps(entry, target));
    }
  };
  for (const texture of preservedTextures) {
    collectImageBitmaps(texture.source?.data, preservedImageBitmaps);
  }
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
            if (!preservedTextures.has(value)) {
              collectImageBitmaps(value.source?.data, imageBitmaps);
              value.dispose();
            }
            textures.add(value);
          }
        }
        material.dispose();
        materials.add(material);
      }
    });
  }
  // GLTFLoader uses ImageBitmapLoader in Chromium. Texture.dispose() releases
  // GPU state but deliberately does not close the decoded native bitmap.
  // Close each unique owned source only after the complete shared-material
  // graph has been traversed, while protecting sources retained by callers.
  for (const imageBitmap of imageBitmaps) {
    if (!preservedImageBitmaps.has(imageBitmap)) imageBitmap.close();
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

function chaserArchetypeActionStatus(
  action: ChaserArchetypeRuntimeView["action"],
): string | null {
  switch (action) {
    case "scan-public-junction": return "正在逐支路扫描";
    case "inspect-public-hide-clue": return "正在检查公开藏点线索";
    case "focus-perceived-sound": return "正在锁定已听见的声源";
    case "intercept-public-exit-route": return "正在切入出口前方通道";
    case null: return null;
  }
}

interface PlayerPresentationPose {
  readonly point: Point;
  readonly heading: Point;
}

function interpolatePoint(from: Point, to: Point, amount: number): Point {
  const clamped = Math.min(1, Math.max(0, amount));
  const eased = clamped * clamped * (3 - 2 * clamped);
  return {
    x: from.x + (to.x - from.x) * eased,
    y: from.y + (to.y - from.y) * eased,
  };
}

function headingToward(from: Point, to: Point, fallback: Point): Point {
  const offset = { x: to.x - from.x, y: to.y - from.y };
  const magnitude = Math.hypot(offset.x, offset.y);
  return magnitude > 1e-5
    ? { x: offset.x / magnitude, y: offset.y / magnitude }
    : fallback;
}

function playerPresentationPose(
  state: GameState,
  level: LevelDefinition,
  simulation: GameSimulation,
): PlayerPresentationPose {
  const config = simulation.config;
  const spot = state.player.hideSpotId
    ? level.hideSpots.find((candidate) => candidate.id === state.player.hideSpotId)
    : undefined;
  const resolved = simulation.getActiveHideSpotArchetype();
  if (!spot || !resolved || resolved.hideSpotId !== spot.id) {
    return { point: state.player.position, heading: state.player.heading };
  }
  if (resolved.archetype !== "hard-locker") {
    if (state.player.mode === "aligning-hide") {
      return { point: state.player.position, heading: state.player.heading };
    }
    const concealed = resolved.concealed;
    if (state.player.mode === "entering-hide") {
      const duration = config.hideEnterSeconds * resolved.profile.timing.enterDurationMultiplier;
      const progress = 1 - state.player.transitionRemainingSeconds / Math.max(duration, 1e-6);
      return {
        point: interpolatePoint(resolved.approach, concealed, progress),
        heading: headingToward(resolved.approach, concealed, state.player.heading),
      };
    }
    if (state.player.mode === "exiting-hide") {
      const selection = simulation.getHideExitSelection()?.selected ?? "origin";
      const destination = selection === "alternate" && resolved.alternateExit
        ? resolved.alternateExit
        : resolved.approach;
      const duration = config.hideExitSeconds * resolved.profile.timing.exitDurationMultiplier;
      const progress = 1 - state.player.transitionRemainingSeconds / Math.max(duration, 1e-6);
      return {
        point: interpolatePoint(concealed, destination, progress),
        heading: headingToward(concealed, destination, state.player.heading),
      };
    }
    if (["hidden", "entering-peek", "peeking", "exiting-peek"].includes(state.player.mode)) {
      return { point: concealed, heading: state.player.heading };
    }
    return { point: state.player.position, heading: state.player.heading };
  }
  // Simulation keeps its concealed point as the AI/perception contract. The
  // premium locker and the rendered actor sit slightly nearer the threshold,
  // so the closed door remains visible in the corridor instead of sinking
  // into the surrounding wall module after the art-polish pass.
  const lockerAnchor = visualHidePoint(spot);
  if (state.player.mode === "aligning-hide") {
    return { point: state.player.position, heading: state.player.heading };
  }
  return {
    point: pairedHidePresentationPoint({
      mode: state.player.mode,
      playerPosition: state.player.position,
      approach: spot.approach,
      lockerAnchor,
      facing: spot.facing,
      transitionRemainingSeconds: state.player.transitionRemainingSeconds,
      transitionDurationSeconds: state.player.mode === "exiting-hide"
        ? config.hideExitSeconds
        : config.hideEnterSeconds,
    }),
    heading: state.player.heading,
  };
}

function canPlayerObserveChaser(state: GameState, level: LevelDefinition, config: GameConfig) {
  if (state.phase === "won") return false;
  if (state.phase === "lost" || state.phase === "ready") return true;
  if (!isPlayerVisuallyExposed(state.player, config)) return false;
  const hideSpot = state.player.hideSpotId
    ? level.hideSpots.find((spot) => spot.id === state.player.hideSpotId)
    : undefined;
  const observationPosition = playerVisualObservationPosition({
    ...state.player,
    peekPosition: hideSpot?.approach,
  });
  return distanceBetween(observationPosition, state.chaser.position) <= PLAYER_OBSERVATION_RANGE
    && hasLineOfSight(level, observationPosition, state.chaser.position);
}

export function ChasingGame() {
  const mount = useRef<HTMLDivElement>(null);
  const keyboardKeys = useRef(new Set<string>());
  const touchKeys = useRef(new Set<string>());
  const analogueMove = useRef({ x: 0, y: 0 });
  const joystickControl = useRef<HTMLDivElement>(null);
  const joystickBase = useRef<HTMLDivElement>(null);
  const joystickThumb = useRef<HTMLSpanElement>(null);
  const joystickPointerId = useRef<number | null>(null);
  const joystickGeometry = useRef<{
    readonly centerX: number;
    readonly centerY: number;
    readonly radius: number;
  } | null>(null);
  const interactPressed = useRef(false);
  const portableDecoyPressed = useRef(false);
  const stealthToolPressed = useRef(false);
  const evidenceErasePressed = useRef(false);
  const selectedStealthToolRef = useRef<StealthToolKind>("door-wedge");
  const preferredHideExit = useRef<HideExitKind>("origin");
  const pausedRef = useRef(false);
  const resumeButton = useRef<HTMLButtonElement>(null);
  const pauseReturnFocus = useRef<HTMLElement | null>(null);
  const commands = useRef<GameCommands>(NOOP_COMMANDS);
  const qaAssetFaultInjector = useRef<QaAssetFaultInjector | null>(null);
  const [selectedLevelIndex, setSelectedLevelIndex] = useState(0);
  const [selectedRemixVariant, setSelectedRemixVariant] = useState<0 | 1 | 2 | null>(null);
  const [selectedLibraryPlan, setSelectedLibraryPlan] =
    useState<LibraryMissionPlanId>("access-authorization");
  const [sceneRevision, setSceneRevision] = useState(0);
  const [preferences, setPreferences] = useState<GameplayPreferences>(
    () => DEFAULT_GAMEPLAY_PREFERENCES,
  );
  const preferencesRef = useRef(preferences);
  const sourceCampaignLevel = CAMPAIGN_LEVELS[selectedLevelIndex];
  const remixContracts = useMemo(
    () => certifiedRemixContractsForLevel(sourceCampaignLevel),
    [sourceCampaignLevel],
  );
  const selectedRemixContract = selectedRemixVariant === null
    ? null
    : remixContracts[selectedRemixVariant];
  const resolvedRemix = useMemo(
    () => resolveCertifiedRemix(
      sourceCampaignLevel,
      selectedRemixContract,
      preferences.ruleset,
    ),
    [preferences.ruleset, selectedRemixContract, sourceCampaignLevel],
  );
  const libraryGoldEnabled = sourceCampaignLevel.id === LIBRARY_BRANCHING_MISSION.levelId
    && selectedRemixContract === null;
  // The original library layout is the G2 gold slice. Certified remixes retain
  // their frozen v1 mission identity until they receive separately certified
  // branching anchors; this avoids silently changing recorded seed topology.
  const campaignLevel = useMemo(() => {
    const resolvedLevel = resolvedRemix.level as CampaignLevelDefinition;
    if (!libraryGoldEnabled) return resolvedLevel;
    const selectedExitId = LIBRARY_BRANCHING_MISSION.plans
      .find((plan) => plan.id === selectedLibraryPlan)?.exitId;
    const selectedExit = LIBRARY_BRANCHING_MISSION_TOPOLOGY.exitPlacements
      .find((placement) => placement.exitId === selectedExitId)?.position;
    if (!selectedExit) throw new Error(`图书楼路线 ${selectedLibraryPlan} 缺少出口锚点`);
    // The original archive soft cover occupied the new fire-exit threshold.
    // Move that same authored shelf cover to the eastern reading branch so
    // both premium objects keep clean silhouettes and all three hide
    // archetypes remain available.
    const hideSpots = resolvedLevel.hideSpots.map((spot) => (
      spot.id === "library-archive"
        ? Object.freeze({
            ...spot,
            approach: Object.freeze({ x: 20, y: 14 }),
            concealed: Object.freeze({ x: 20, y: 13.65 }),
            facing: Object.freeze({ x: 0, y: 1 }),
          })
        : spot
    ));
    return Object.freeze({
      ...resolvedLevel,
      exit: Object.freeze({ ...selectedExit }),
      hideSpots: Object.freeze(hideSpots),
    });
  }, [libraryGoldEnabled, resolvedRemix.level, selectedLibraryPlan]);
  const chaserArchetypeProfile: ChaserArchetypeProfile =
    CHASER_ARCHETYPE_PROFILES[campaignLevel.campaign.theme];
  const runReplayLevelId = selectedRemixContract
    ? remixReplayLevelId(selectedRemixContract, preferences.ruleset)
    : libraryGoldEnabled
      ? libraryG2RunIdentity(campaignLevel.id, selectedLibraryPlan)
      : `${campaignLevel.id}#${CERTIFIED_REMIX_MISSION_VERSION}`;
  const runRecordLevelId = selectedRemixContract
    ? runReplayLevelId
    : libraryGoldEnabled
      ? runReplayLevelId
      : campaignLevel.id;
  const remixRecord = selectedRemixContract && typeof window !== "undefined"
    ? loadCertifiedRemixRecord(localStorage, selectedRemixContract, preferences.ruleset)
    : null;
  const objectivePaths = useMemo(() => new GridPathPlanner(campaignLevel), [campaignLevel]);
  const baseGameplayConfig = useMemo(
    () => getCampaignGameplayConfig(campaignLevel),
    [campaignLevel],
  );
  const gameplayConfig = useMemo(
    () => preferences.ruleset === "assisted"
      ? { ...baseGameplayConfig, ...assistedGameplayConfig(baseGameplayConfig) }
      : baseGameplayConfig,
    [baseGameplayConfig, preferences.ruleset],
  );
  const hideGuidancePolicy = useMemo(() => getCampaignHideGuidancePolicy(campaignLevel), [campaignLevel]);
  const atmosphere = useMemo(() => runtimeAtmosphereForLevel(campaignLevel), [campaignLevel]);
  const masteryTargetOptions = useMemo<MasteryTargetOptions>(() => {
    const context = Object.freeze({
      // Replay/record identity is versioned separately. The profile itself is
      // still authored for the source chapter and active rules lane.
      levelId: campaignLevel.id,
      theme: campaignLevel.campaign.theme,
      ruleset: preferences.ruleset,
    });
    if (!libraryGoldEnabled) return Object.freeze({ context });
    const plan = LIBRARY_BRANCHING_MISSION.plans.find(
      (candidate) => candidate.id === selectedLibraryPlan,
    );
    if (!plan) throw new Error(`图书楼路线 ${selectedLibraryPlan} 缺少精通计时定义`);
    const objectives = plan.objectiveIds.map((objectiveId) => {
      const definition = LIBRARY_BRANCHING_MISSION.objectives.find(
        (candidate) => candidate.id === objectiveId,
      );
      const placement = LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements.find(
        (candidate) => candidate.objectiveId === objectiveId,
      );
      if (!definition || !placement) {
        throw new Error(`图书楼路线 ${selectedLibraryPlan} 缺少精通目标 ${objectiveId}`);
      }
      return Object.freeze({
        id: objectiveId,
        position: Object.freeze({ ...placement.position }),
        commitmentSeconds: definition.commitmentSeconds,
      });
    });
    return Object.freeze({
      context,
      mission: Object.freeze({
        kind: "ordered" as const,
        id: `${LIBRARY_BRANCHING_MISSION.id}:${selectedLibraryPlan}`,
        objectives: Object.freeze(objectives),
      }),
    });
  }, [
    campaignLevel.campaign.theme,
    campaignLevel.id,
    libraryGoldEnabled,
    preferences.ruleset,
    selectedLibraryPlan,
  ]);
  const masteryPreview = useMemo(() => previewRunMastery(
    campaignLevel,
    gameplayConfig,
    masteryTargetOptions,
  ), [campaignLevel, gameplayConfig, masteryTargetOptions]);
  const [campaignProgress, setCampaignProgress] = useState<CampaignProgress>(
    createCampaignProgress,
  );
  const campaignProgressRef = useRef(campaignProgress);
  const chooseLevelRef = useRef<(index: number) => void>(() => {});
  const [phase, setPhase] = useState<GamePhase>("ready");
  const [playerMode, setPlayerMode] = useState<PlayerMode>("free");
  const [chaserMode, setChaserMode] = useState<ChaserMode>("spawn-delay");
  const [chaserConfirming, setChaserConfirming] = useState(false);
  const [chaserObservable, setChaserObservable] = useState(true);
  const [chaserArchetypeRuntime, setChaserArchetypeRuntime] =
    useState<ChaserArchetypeRuntimeView | null>(null);
  const [publicThreat, setPublicThreat] = useState<PublicThreatLevel>("calm");
  const [elapsed, setElapsed] = useState(0);
  const [objectiveDistance, setObjectiveDistance] = useState(
    objectiveDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths),
  );
  const [objectiveTurnHint, setObjectiveTurnHint] = useState<{
    arrow: string;
    distanceMeters: number;
  } | null>(null);
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
  const [hideGuideSelection, setHideGuideSelection] = useState<HideGuidanceSelection>("survivability");
  const [hideGuideStrategy, setHideGuideStrategy] = useState<"hide" | "break-line-of-sight">("hide");
  const [interaction, setInteraction] = useState<HideInteraction | null>(null);
  const [activeHideArchetype, setActiveHideArchetype] = useState<HideArchetypeKind | null>(null);
  const [hideExitSelection, setHideExitSelection] = useState<HideExitSelection | null>(null);
  const keyboardPresentationRef = useRef({
    phase,
    selectedLevelIndex,
    hideExitSelection,
  });
  useEffect(() => {
    keyboardPresentationRef.current = {
      phase,
      selectedLevelIndex,
      hideExitSelection,
    };
  }, [hideExitSelection, phase, selectedLevelIndex]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: BOOTSTRAP_ASSET_COUNT, message: "正在载入项目美术资产：角色、校园与互动道具…" });
  const [resultVisible, setResultVisible] = useState(true);
  const [musicMuted, setMusicMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [themeMechanic, setThemeMechanic] = useState<ThemeMechanicUiState | null>(null);
  const [themeMission, setThemeMission] = useState<ThemeMissionUiState | null>(null);
  const [portableDecoy, setPortableDecoy] = useState<PortableDecoySample | null>(null);
  const [portableDecoyNotice, setPortableDecoyNotice] = useState<string | null>(null);
  const [selectedStealthTool, setSelectedStealthTool] =
    useState<StealthToolKind>("door-wedge");
  const [stealthSystems, setStealthSystems] =
    useState<StealthSystemsUiState | null>(null);
  const [tensionDirector, setTensionDirector] =
    useState<TensionDirectorUiState | null>(null);
  const [ghostRace, setGhostRace] = useState<GhostRaceUiState | null>(null);
  const [lastCaptureReason, setLastCaptureReason] = useState<CaptureReason | null>(null);
  const [lastRunSummary, setLastRunSummary] = useState<LastRunSummary | null>(null);

  useEffect(() => {
    let active = true;
    const loaded = loadGameplayPreferences(localStorage);
    queueMicrotask(() => {
      if (active) setPreferences(loaded);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    preferencesRef.current = preferences;
    saveGameplayPreferences(localStorage, preferences);
  }, [preferences]);

  useEffect(() => {
    let active = true;
    try {
      const stored = JSON.parse(localStorage.getItem(CAMPAIGN_PROGRESS_KEY) ?? "null") as unknown;
      if (!stored) return;
      const sanitized = sanitizeCampaignProgress(
        stored,
        CAMPAIGN_LEVELS.map((level) => level.id),
        [
          ...CAMPAIGN_LEVELS.map((level) => level.id),
          ...LIBRARY_G2_RECORD_IDS,
        ],
      );
      queueMicrotask(() => {
        if (active) setCampaignProgress(sanitized);
      });
    } catch {
      // A corrupt or unavailable store must never block the first chapter.
    }
    return () => { active = false; };
  }, []);

  useEffect(() => {
    campaignProgressRef.current = campaignProgress;
  }, [campaignProgress]);

  const updatePreferences = useCallback((
    patch: Partial<Omit<GameplayPreferences, "version">>,
  ) => {
    setPreferences((current) => ({
      ...current,
      ...patch,
      version: current.version,
    }));
  }, []);

  const begin = useCallback(() => commands.current.begin(), []);
  const restart = useCallback(() => commands.current.restart(), []);
  const interact = useCallback(() => commands.current.interact(), []);
  const deployDecoy = useCallback(() => commands.current.deployDecoy(), []);
  const chooseStealthTool = useCallback((tool: StealthToolKind) => {
    commands.current.selectStealthTool(tool);
  }, []);
  const deployStealthTool = useCallback(
    () => commands.current.useStealthTool(),
    [],
  );
  const eraseEvidence = useCallback(() => commands.current.eraseEvidence(), []);
  const retryScene = useCallback(() => {
    setLoading(true);
    setLoadError("");
    setLoadProgress({
      done: 0,
      total: BOOTSTRAP_ASSET_COUNT,
      message: "正在原地重建 3D 场景并恢复素材…",
    });
    setSceneRevision((revision) => revision + 1);
  }, []);
  const resetAnalogueMove = useCallback(() => {
    analogueMove.current = { x: 0, y: 0 };
    joystickPointerId.current = null;
    joystickGeometry.current = null;
    if (joystickThumb.current) {
      joystickThumb.current.style.transform = "translate3d(0px, 0px, 0)";
    }
    joystickControl.current?.classList.remove("active");
  }, []);
  const sampleJoystickPointer = useCallback((clientX: number, clientY: number) => {
    const geometry = joystickGeometry.current;
    if (!geometry) return;
    const sample = sampleVirtualStick(
      { x: geometry.centerX, y: geometry.centerY },
      { x: clientX, y: clientY },
      geometry.radius,
    );
    analogueMove.current = { x: sample.x, y: sample.y };
    if (joystickThumb.current) {
      joystickThumb.current.style.transform =
        `translate3d(${sample.thumbX}px, ${sample.thumbY}px, 0)`;
    }
    joystickControl.current?.classList.toggle("active", sample.strength > 0);
  }, []);
  const joystickPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (pausedRef.current) return;
    if (joystickPointerId.current !== null) return;
    const base = joystickBase.current;
    if (!base) return;
    event.preventDefault();
    const bounds = base.getBoundingClientRect();
    joystickGeometry.current = {
      centerX: bounds.left + bounds.width / 2,
      centerY: bounds.top + bounds.height / 2,
      radius: Math.max(26, Math.min(bounds.width, bounds.height) * 0.28),
    };
    joystickPointerId.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    sampleJoystickPointer(event.clientX, event.clientY);
  }, [sampleJoystickPointer]);
  const joystickPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerId.current !== event.pointerId) return;
    event.preventDefault();
    sampleJoystickPointer(event.clientX, event.clientY);
  }, [sampleJoystickPointer]);
  const joystickPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerId.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resetAnalogueMove();
  }, [resetAnalogueMove]);
  const chooseLevel = useCallback((index: number) => {
    if (index < 0 || index >= CAMPAIGN_LEVELS.length) return;
    const qaBypass = typeof location !== "undefined" && new URLSearchParams(location.search).has("qa");
    if (
      !qaBypass
      && index + 1 > getCampaignUnlockedThrough(campaignProgress, preferences.ruleset)
    ) return;
    // Re-selecting the active chapter must be a no-op. Setting loading here
    // without changing selectedLevelIndex would leave the overlay stuck,
    // because the scene effect correctly has nothing to rebuild.
    if (index === selectedLevelIndex) return;
    setLoading(true);
    setLoadError("");
    setLoadProgress({ done: 0, total: BOOTSTRAP_ASSET_COUNT, message: "正在切换主题关卡与高精度环境…" });
    setSelectedRemixVariant(null);
    setSelectedLevelIndex(index);
  }, [campaignProgress, preferences.ruleset, selectedLevelIndex]);

  const chooseRemixVariant = useCallback((variant: 0 | 1 | 2 | null) => {
    if (variant === selectedRemixVariant) return;
    setLoading(true);
    setLoadError("");
    setLoadProgress({
      done: 0,
      total: BOOTSTRAP_ASSET_COUNT,
      message: variant === null
        ? "正在恢复本关原版布局…"
        : `正在装配认证布局 ${(variant + 1).toString().padStart(2, "0")}…`,
    });
    setSelectedRemixVariant(variant);
  }, [selectedRemixVariant]);

  const chooseLibraryPlan = useCallback((planId: LibraryMissionPlanId) => {
    if (planId === selectedLibraryPlan || phase !== "ready") return;
    setLoading(true);
    setLoadError("");
    setLoadProgress({
      done: 0,
      total: BOOTSTRAP_ASSET_COUNT,
      message: planId === "access-authorization"
        ? "正在布置安静的正门授权路线…"
        : "正在布置高风险的消防释放路线…",
    });
    setSelectedLibraryPlan(planId);
  }, [phase, selectedLibraryPlan]);

  const switchLibraryPlanAfterRun = useCallback(() => {
    if (
      !libraryGoldEnabled
      || (phase !== "won" && phase !== "lost")
      || loading
    ) return;
    const nextPlan = LIBRARY_BRANCHING_MISSION.plans.find(
      (plan) => plan.id !== selectedLibraryPlan,
    );
    if (!nextPlan) return;
    setResultVisible(true);
    setPhase("ready");
    setLoading(true);
    setLoadError("");
    setLoadProgress({
      done: 0,
      total: BOOTSTRAP_ASSET_COUNT,
      message: nextPlan.id === "access-authorization"
        ? "正在从结算页改走安静的正门授权路线…"
        : "正在从结算页改走高风险的消防释放路线…",
    });
    setSelectedLibraryPlan(nextPlan.id);
  }, [libraryGoldEnabled, loading, phase, selectedLibraryPlan]);

  useEffect(() => {
    chooseLevelRef.current = chooseLevel;
  }, [chooseLevel]);

  useEffect(() => {
    if (!paused) return;
    pauseReturnFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = requestAnimationFrame(() => resumeButton.current?.focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const card = resumeButton.current?.closest(".pause-card");
      if (!card) return;
      const focusable = [...card.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
      )];
      if (!focusable.length) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
        : currentIndex < 0 || currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1;
      event.preventDefault();
      focusable[nextIndex].focus();
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trapFocus);
      const returnFocus = pauseReturnFocus.current;
      pauseReturnFocus.current = null;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [paused]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const target = event.target instanceof Element ? event.target : null;
      const focusedControl = Boolean(target?.closest("button, input, select, textarea, a[href], [contenteditable='true']"));
      if (shouldIgnoreFocusedControlKey(key, focusedControl)) return;
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(key)) event.preventDefault();
      if (key === "escape") {
        event.preventDefault();
        commands.current.togglePause();
        return;
      }
      if (pausedRef.current) {
        if (key === "m") commands.current.toggleMute();
        else if (key === "r") commands.current.restart();
        return;
      }
      keyboardKeys.current.add(key);
      if (event.repeat) return;
      if (key === "r") commands.current.restart();
      else if (key === "m") commands.current.toggleMute();
      else if (key === "0") commands.current.resetZoom();
      else if (key === "-" || key === "_") commands.current.adjustZoom(1.12);
      else if (key === "+" || key === "=") commands.current.adjustZoom(1 / 1.12);
      else if (key === "1") commands.current.selectStealthTool("door-wedge");
      else if (key === "2") commands.current.selectStealthTool("corner-mirror");
      else if (key === "3") commands.current.selectStealthTool("temporary-blackout");
      // Gameplay commands validate against the authoritative simulation state.
      // React's presentation phase can trail a freshly loaded/set QA scenario
      // by one commit; gating here made the first real key press disappear.
      else if (key === "g") commands.current.useStealthTool();
      else if (key === "c") commands.current.eraseEvidence();
      else if (
        key === "x"
        && keyboardPresentationRef.current.hideExitSelection?.options.some(
          (option) => option.kind === "alternate",
        )
      ) {
        const nextHideExit = preferredHideExit.current === "alternate"
          ? "origin"
          : "alternate";
        preferredHideExit.current = nextHideExit;
        setHideExitSelection((current) => current
          ? { ...current, selected: nextHideExit }
          : current);
      }
      else if (
        (key === "enter" || key === " ")
        && keyboardPresentationRef.current.phase !== "playing"
      ) {
        const keyboardPresentation = keyboardPresentationRef.current;
        if (
          keyboardPresentation.phase === "won"
          && keyboardPresentation.selectedLevelIndex < CAMPAIGN_LEVELS.length - 1
        ) {
          chooseLevelRef.current(keyboardPresentation.selectedLevelIndex + 1);
        }
        else commands.current.begin();
      }
      else if (
        key === "e"
        || (key === " " && keyboardPresentationRef.current.phase === "playing")
      ) commands.current.interact();
      else if (key === "f") commands.current.deployDecoy();
    };
    const keyUp = (event: KeyboardEvent) => keyboardKeys.current.delete(event.key.toLowerCase());
    const clearInput = () => {
      keyboardKeys.current.clear();
      touchKeys.current.clear();
      interactPressed.current = false;
      portableDecoyPressed.current = false;
      stealthToolPressed.current = false;
      evidenceErasePressed.current = false;
      preferredHideExit.current = "origin";
      resetAnalogueMove();
    };
    const qaRun = new URLSearchParams(location.search).has("qa");
    const clearBlurInput = () => {
      if (!qaRun) clearInput();
    };
    const clearHiddenInput = () => {
      if (document.visibilityState !== "visible" && !qaRun) {
        clearInput();
        // Production play still pauses immediately when the tab is hidden.
        // Visual regression runs use a dedicated `qa` query and may briefly
        // lose foreground focus to the host browser's updater; suppressing the
        // overlay there keeps evidence frames deterministic without changing
        // player-facing behaviour.
        if (
          keyboardPresentationRef.current.phase === "playing"
          && !pausedRef.current
        ) {
          commands.current.togglePause();
        }
      }
    };
    addEventListener("keydown", keyDown);
    addEventListener("keyup", keyUp);
    addEventListener("blur", clearBlurInput);
    document.addEventListener("visibilitychange", clearHiddenInput);
    return () => {
      removeEventListener("keydown", keyDown);
      removeEventListener("keyup", keyUp);
      removeEventListener("blur", clearBlurInput);
      document.removeEventListener("visibilitychange", clearHiddenInput);
    };
  }, [resetAnalogueMove]);

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
    setChaserArchetypeRuntime(null);
    setPublicThreat("calm");
    pausedRef.current = false;
    setPaused(false);
    resetAnalogueMove();
    setThemeMechanic(null);
    setThemeMission(null);
    setPortableDecoy(null);
    setPortableDecoyNotice(null);
    setGhostRace(null);
    setElapsed(0);
    setLastCaptureReason(null);
    setLastRunSummary(null);
    setObjectiveDistance(objectiveDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths));
    setObjectiveTurnHint(null);
    setHideDistance(nearestHideDistanceMeters(campaignLevel.playerStart, campaignLevel, objectivePaths));
    setHideGuideProjection(null);
    setHideGuideRisk("medium");
    setHideGuideSelection("survivability");
    setHideGuideStrategy("hide");
    setActiveHideArchetype(null);
    setHideExitSelection(null);
    preferredHideExit.current = "origin";

    const scorePrewarmAbort = new AbortController();
    let scorePrewarmStarted = false;
    const startScorePrewarm = () => {
      if (scorePrewarmStarted || scorePrewarmAbort.signal.aborted) return;
      scorePrewarmStarted = true;
      void prewarmAdaptiveScoreAssets(undefined, scorePrewarmAbort.signal);
    };
    let disposed = false;
    let frame = 0;
    let last = performance.now();
    let lastHudUpdate = 0;
    let ready = false;
    let decorativeAssetsReady = false;
    let qaDecorativeSceneCompiled = false;
    let qaDecorativeSceneCompileCount = 0;
    let qaTransientArtPrewarmCount = 0;
    let qaDirectorEnabled = true;
    let qaCaptureHoldRequested = false;
    let qaCaptureHoldAcknowledged = false;
    let qaCaptureHoldDeadline = 0;
    let qaRenderedFrameCount = 0;
    let textureDeduplication: TextureDeduplication = {
      sourceTextures: 0,
      canonicalTextures: 0,
      assignmentsShared: 0,
      sourcesShared: 0,
    };
    let cameraDistance = baseCameraDistanceForAspect(16 / 9);
    let lockerCameraBlend = 0;
    const lockerCameraPosition = new THREE.Vector3();
    const lockerCameraTarget = new THREE.Vector3();
    const lockerPeekPosition = new THREE.Vector3();
    const missionPerformanceTarget = new THREE.Vector3();
    const missionPerformanceOrigin = new THREE.Vector3();
    let resultTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCheckSpot: string | null = null;
    let renderedHideArchetype: HideArchetypeKind | null = null;
    let guidedLockerId: string | null = null;
    let guidedLockerRisk: HideGuidanceRisk = "medium";
    let guidedTargetState: HideGuidanceTargetState | null = null;
    let guidedBreakSight = false;
    let playerKnownChaser: PlayerKnownChaserEvidence | null = null;
    let lastScoreThreat = Number.NaN;
    let captureStageRemaining = 0;
    let capturePerformanceStarted = false;
    const artLayout = levelArtLayout(
      campaignLevel.campaign.theme,
      campaignLevel.campaign.atmosphere.propSet,
    );
    const environmentComposition = buildEnvironmentCompositionPlan(campaignLevel);
    const missionDefinition = themeMissionDefinition(campaignLevel.campaign.theme);
    const legacyMissionPlacementPlan = planThemeMissionPlacements(
      campaignLevel,
      missionDefinition,
    );
    const legacyMissionPlacements: readonly MissionObjectivePlacement[] =
      legacyMissionPlacementPlan.placements;
    const selectedLibraryPlanDefinition = libraryGoldEnabled
      ? LIBRARY_BRANCHING_MISSION.plans.find((plan) => plan.id === selectedLibraryPlan) ?? null
      : null;
    const runtimeMissionObjectives: readonly RuntimeMissionObjective[] =
      selectedLibraryPlanDefinition
        ? selectedLibraryPlanDefinition.objectiveIds.map((objectiveId) => {
            const objective = LIBRARY_BRANCHING_MISSION.objectives
              .find((candidate) => candidate.id === objectiveId);
            if (!objective) throw new Error(`图书楼路线缺少任务 ${objectiveId}`);
            return Object.freeze({
              id: objective.id,
              label: objective.label,
              interactionPrompt: objective.interactionPrompt,
              completionHint: objective.completionHint,
              commitmentSeconds: objective.commitmentSeconds,
              unlocksExit: objective.unlocksExitId !== null,
              planId: objective.planId,
            });
          })
        : missionDefinition.objectives;
    const missionPlacements: readonly MissionObjectivePlacement[] =
      selectedLibraryPlanDefinition
        ? selectedLibraryPlanDefinition.objectiveIds.map((objectiveId) => {
            const placement = LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements
              .find((candidate) => candidate.objectiveId === objectiveId);
            if (!placement) throw new Error(`图书楼路线缺少任务锚点 ${objectiveId}`);
            return Object.freeze({
              objectiveId,
              position: Object.freeze({ ...placement.position }),
            });
          })
        : legacyMissionPlacements;
    const missionAudit = libraryGoldEnabled
      ? auditLibraryMissionSoftlocks(campaignLevel)
      : auditThemeMissionSoftlock(
          campaignLevel,
          missionDefinition,
          missionPlacements,
        );
    if (!missionAudit.passed) {
      throw new Error(`主题任务链未通过软锁审计：${missionAudit.failures.join("；")}`);
    }
    const certifiedDirectorRouteIds = Object.freeze(
      "plans" in missionAudit
        ? missionAudit.plans
            .filter((route) => route.reachable)
            .map((route) => (
              `${campaignLevel.id}:mission-route:${route.planId}:${route.exitId}`
            ))
        : missionAudit.orders
            .filter((route) => route.reachable)
            .map((route, index) => (
              `${campaignLevel.id}:mission-route:${index + 1}:${
                route.objectiveIds.join(">")
              }`
            )),
    );
    if (certifiedDirectorRouteIds.length === 0) {
      throw new Error("公平节奏导演缺少通过拓扑软锁审计的完成路线");
    }
    const missionPlacementById = new Map(
      missionPlacements.map((placement) => [placement.objectiveId, placement.position]),
    );
    const initialLibraryMissionState = libraryGoldEnabled
      ? stepLibraryBranchingMission(
          LIBRARY_BRANCHING_MISSION,
          createInitialLibraryMissionState(),
          { type: "select-plan", planId: selectedLibraryPlan },
        ).state
      : null;
    let libraryMissionState: LibraryMissionState | null = initialLibraryMissionState;
    let missionState = libraryMissionState
      ? adaptLibraryMissionToThemeMissionState(libraryMissionState)
      : createInitialThemeMissionState(missionDefinition);
    const availableRuntimeMissionObjectiveIds = () => (
      libraryMissionState
        ? availableLibraryObjectiveIds(
            LIBRARY_BRANCHING_MISSION,
            libraryMissionState,
          )
        : availableThemeObjectiveIds(missionDefinition, missionState)
    );
    let missionCommitment: {
      objectiveId: string;
      startedAtTick: number;
      durationTicks: number;
      completesAtTick: number;
      remainingSeconds: number;
      totalSeconds: number;
    } | null = null;
    let missionPerformanceObjectiveId: string | null = null;
    const missionViews = new Map<string, MissionObjectiveView>();
    const ghostRunLevelId = runReplayLevelId;
    const mechanicPosition = themeMechanicPlacement(
      campaignLevel,
      libraryGoldEnabled
        ? [
            ...LIBRARY_BRANCHING_MISSION_TOPOLOGY.objectivePlacements.map(
              (placement) => placement.position,
            ),
            ...LIBRARY_BRANCHING_MISSION_TOPOLOGY.exitPlacements.map(
              (placement) => placement.position,
            ),
          ]
        : [],
    );
    const mechanicDefinition = createThemeMechanicDefinition(
      campaignLevel.campaign.theme,
      `${campaignLevel.id}:primary-mechanic`,
      mechanicPosition,
      { interactionRadius: 1.35 },
    );
    let mechanicInstance: MechanicInstance = createMechanicInstance(mechanicDefinition);
    let mechanicView: MechanicView | null = null;
    let simulation = new GameSimulation({
      level: campaignLevel,
      config: gameplayConfig,
      chaserArchetypeProfile,
    });
    let latestState = simulation.getState();
    let fixedStepHost = createFixedStepHost({
      fixedStepSeconds: simulation.config.fixedStepSeconds,
      maxFrameDeltaSeconds: simulation.config.maxFrameDeltaSeconds,
      initialTick: latestState.tick,
    });
    let stealthEvidenceState: StealthEvidenceState = createStealthEvidenceState();
    let stealthToolbeltState: StealthToolbeltState = createStealthToolbeltState();
    const tensionDirectorDefinition = createCampaignTensionDirectorDefinition(
      campaignLevel.id,
      certifiedDirectorRouteIds,
      simulation.config.fixedStepSeconds,
    );
    let tensionDirectorState: TensionDirectorState =
      createInitialTensionDirectorState(tensionDirectorDefinition);
    let directorSafeTicks = 0;
    let directorChaseTicks = 0;
    let directorTicksSinceChaseEscape: number | null = null;
    let directorWasChased = false;
    let lastStealthAuxiliaryTick = 0;
    let lastFootprintTick = Number.NEGATIVE_INFINITY;
    let lastFootprintPosition = { ...campaignLevel.playerStart };
    let stealthNotice: string | null = null;
    let stealthNoticeUntilTick = 0;
    let mirrorThreatVisible = false;
    const deliveredEvidenceIds = new Set<string>();
    const investigatedEvidenceIds = new Set<string>();
    const triggeredDoorWedges = new Map<string, number>();
    let activeWedgeHoldUntilTick = 0;
    const stealthEvidenceViews = new Map<string, StealthEvidenceView>();
    const stealthToolWorldViews = new Map<string, StealthToolWorldView>();
    const stealthToolModelTemplates: Partial<Record<StealthToolKind, THREE.Group>> = {};
    let runTelemetry = createRunTelemetry({
      levelId: campaignLevel.id,
      theme: campaignLevel.campaign.theme,
      ruleset: preferences.ruleset,
    });
    let ghostRecorder = new GhostInputRecorder(
      ghostRunLevelId,
      simulation.config.fixedStepSeconds,
    );
    const ghostInputBuffer = new GhostFixedStepInputBuffer();
    const initialQaSearchParams = new URLSearchParams(location.search);
    const qaSessionRequested = initialQaSearchParams.has("qa");
    const suppressGhostForQaResolution = qaSessionRequested
      && parseQaFlag(initialQaSearchParams.get("qaResolution"));
    // QA evidence must be deterministic and independent of a browser profile's
    // previously recorded personal-best ghost. Normal player sessions keep the
    // saved-ghost path unchanged.
    const storedGhost = preferences.personalGhostEnabled && !qaSessionRequested
      ? loadPersonalGhost(localStorage, ghostRunLevelId)
      : null;
    const ghostEligible = canRacePersonalGhost({
      recording: storedGhost,
      levelId: ghostRunLevelId,
      fixedStepSeconds: simulation.config.fixedStepSeconds,
      ruleset: preferences.ruleset,
    });
    let ghostRecording: GhostRecording | null = ghostEligible ? storedGhost : null;
    let ghostSimulation: GameSimulation | null = ghostRecording
      ? new GameSimulation({
          level: campaignLevel,
          autoStart: true,
          config: {
            ...gameplayConfig,
            spawnDelaySeconds: 999,
          },
        })
      : null;
    let ghostState = ghostSimulation?.getState() ?? null;
    let ghostCursor = ghostRecording ? new GhostReplayCursor(ghostRecording) : null;
    let ghostActor: ActorView | null = null;
    let ghostAccumulatorSeconds = 0;
    const missionObjectiveIds = runtimeMissionObjectives.map(
      (objective) => objective.id,
    );
    let portableDecoyState: PortableDecoyState | null = libraryGoldEnabled
      ? createPortableDecoyState(LIBRARY_PORTABLE_DECOY_DEFINITION)
      : null;
    let portableDecoyTemplate: THREE.Group | null = null;
    const portableDecoyViews = new Map<string, PortableDecoyView>();
    const portableDecoySourceIds = new Set<string>();
    const scheduledPortableDecoySourceIds = new Set<string>();
    let portableDecoyFeedback: string | null = libraryGoldEnabled
      ? "F 投掷精装笔记本，制造一次可追查的公开声源"
      : null;
    let portableDecoyFeedbackUntilSeconds = libraryGoldEnabled ? 4 : 0;
    let portableDecoyThrowRemainingSeconds = 0;
    let portableDecoyThrownCount = 0;
    let portableDecoyPublicSoundAcceptedCount = 0;
    let portableDecoyInvestigationCompletedCount = 0;
    let portableDecoyLastLifecycleEvent: string | null = null;
    let portableDecoyViewCreatedCount = 0;
    let portableDecoyViewDisposedCount = 0;
    let portableDecoyBeaconTextureCreatedCount = 0;
    let portableDecoyBeaconTextureDisposedCount = 0;
    let portableDecoyBeaconMaterialDisposedCount = 0;
    let portableDecoyResetCount = 0;
    let pendingRouteSelectionTelemetry = libraryGoldEnabled;
    const initialExitRouteDistanceMeters = objectiveDistanceMeters(
      campaignLevel.playerStart,
      campaignLevel,
      objectivePaths,
    );
    const exitRouteProgressForPosition = (position: Point) => {
      const route = objectivePaths.path(position, campaignLevel.exit);
      const remainingMeters = route.length > 0
        ? Math.max(0, route.length - 1) * CELL
        : initialExitRouteDistanceMeters;
      return Math.min(
        1,
        Math.max(
          0,
          1 - remainingMeters / Math.max(0.001, initialExitRouteDistanceMeters),
        ),
      );
    };
    let playerRuleProgressTracker = new GhostRuleProgressTracker(
      missionObjectiveIds,
    );
    let playerRuleProgress = playerRuleProgressTracker.update({
      tick: 0,
      routeProgress: 0,
    });
    let pendingPlayerRuleEvents: GhostRuleEventInput[] = [];
    let ghostRuleEventCursor = 0;
    let ghostRuleProgressTracker = ghostRecording?.ruleEvents?.length
      ? new GhostRuleProgressTracker(missionObjectiveIds)
      : null;
    let ghostRuleProgress: GhostRuleProgressSnapshot | null =
      ghostRuleProgressTracker?.update({
        tick: 0,
        routeProgress: 0,
      }) ?? null;
    const ghostRuleInput = (
      event: Readonly<GhostRuleReplayEvent>,
    ): GhostRuleEventInput | null => {
      switch (event.type) {
        case "objective-completed":
        case "exit-unlocked":
          return {
            type: event.type,
            objectiveId: event.objectiveId,
          };
        case "mechanic-committed":
          return {
            type: event.type,
            mechanicId: event.mechanicId,
          };
        case "run-completed":
          return { type: event.type };
        case "portable-decoy-thrown":
          return null;
      }
    };
    const consumeGhostRuleEventsThrough = (
      tick: number,
    ): readonly GhostRuleEventInput[] => {
      if (!ghostRecording?.ruleEvents) return [];
      const events: GhostRuleEventInput[] = [];
      while (
        ghostRuleEventCursor < ghostRecording.ruleEvents.length
        && ghostRecording.ruleEvents[ghostRuleEventCursor].tick <= tick
      ) {
        const input = ghostRuleInput(
          ghostRecording.ruleEvents[ghostRuleEventCursor],
        );
        if (input) events.push(input);
        ghostRuleEventCursor += 1;
      }
      return events;
    };
    const recordPlayerRuleEvent = (event: GhostRuleReplayEvent) => {
      ghostRecorder.recordRuleEvent(event);
      const input = ghostRuleInput(event);
      if (input) pendingPlayerRuleEvents.push(input);
    };
    const recordLibraryMissionRuleEvents = (
      events: readonly LibraryMissionEvent[],
      tick: number,
    ) => {
      for (const event of events) {
        if (event.type === "objective-completed" || event.type === "exit-unlocked") {
          recordPlayerRuleEvent({
            tick,
            type: event.type,
            objectiveId: event.objectiveId,
          });
        }
      }
    };
    let ghostRaceTracker = ghostRecording
      ? new GhostRaceTracker(
          ghostRecording,
          initialExitRouteDistanceMeters,
        )
      : null;
    let latestGhostRace: GhostRaceSnapshot | null = null;
    let playerKnowledge = createPlayerKnowledge();
    let objectiveGuidanceState = createObjectiveGuidanceState();
    let lastObjectiveGuidanceSeconds = latestState.elapsedSeconds;
    const resetFrameClock = () => {
      if (document.visibilityState === "visible") last = performance.now();
    };
    const cameraZoom = { value: 1 };
    const actors: Partial<Record<ActorName, ActorView>> = {};
    const lockers = new Map<string, LockerView>();
    const sightObscurers: THREE.Points[] = [];
    const loadedAssetIds = new Set<string>();
    const loadedAssetRoots = new Set<THREE.Object3D>();
    const placedAssetIds = new Set<string>();
    const performanceLights: Array<{ light: THREE.Light; priority: number }> = [];
    let exitMissionLight: THREE.SpotLight | null = null;
    const nonCriticalShadowCasters: Array<{ object: THREE.Object3D; castShadow: boolean }> = [];
    let requestPoliceAsset: (() => Promise<void>) | null = null;
    let deferredDressingFade: {
      elapsedSeconds: number;
      materials: Array<{
        material: THREE.Material;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }>;
      lights: Array<{ light: THREE.Light; intensity: number }>;
    } | null = null;
    let renderedMovementBlockers = 0;
    const deviceNavigator = navigator as Navigator & { deviceMemory?: number };
    const initialBounds = host.getBoundingClientRect();
    const touchLayoutMedia = matchMedia("(max-width: 900px), (pointer: coarse)");
    let cameraViewportWidth = Math.max(1, Math.round(initialBounds.width));
    let cameraViewportHeight = Math.max(1, Math.round(initialBounds.height));
    let cameraSafeViewport = cameraSafeViewportFromInsets(
      cameraViewportWidth,
      cameraViewportHeight,
      gameplayCameraInsetsForViewport(cameraViewportWidth, cameraViewportHeight, touchLayoutMedia.matches),
    );
    const qaSearchParams = new URLSearchParams(location.search);
    const qaPlayerScenario = qaSearchParams.has("qa")
      ? parseQaPoint(qaSearchParams.get("qaPlayer"))
      : null;
    const qaChaserScenario = qaSearchParams.has("qa")
      ? parseQaPoint(qaSearchParams.get("qaChaser"))
      : null;
    const qaLevelScenario = qaSearchParams.has("qa")
      ? parseQaLevel(qaSearchParams.get("qaLevel"), CAMPAIGN_LEVELS.length)
      : null;
    const qaSpawnDelaySeconds = qaSearchParams.has("qa")
      ? parseQaDelaySeconds(qaSearchParams.get("qaSpawnDelay"))
      : 0;
    const qaCleanFrameRequested = qaSearchParams.has("qa")
      && parseQaFlag(qaSearchParams.get("qaCleanFrame"));
    if (qaCleanFrameRequested) {
      document.documentElement.dataset.chasingQaCleanFrame = "true";
    }
    const qaResolutionScenario = suppressGhostForQaResolution;
    const qaKidAnimationScenario = qaSearchParams.has("qa")
      ? parseQaKidAnimation(qaSearchParams.get("qaKidClip"))
      : null;
    const qaKidAnimationTime = qaKidAnimationScenario
      ? parseQaNormalizedTime(qaSearchParams.get("qaKidTime"))
      : null;
    const qaKidAssetVariant = qaSearchParams.has("qa")
      ? parseQaKidAssetVariant(qaSearchParams.get("qaKidAsset"))
      : null;
    const qaKidAssetUrl = qaKidAssetVariant === "high"
      ? `/models/characters/kid.glb?v=${KID_ASSET_CACHE_VERSION}`
      : qaKidAssetVariant === "lod1"
        ? `/models/characters/kid-lod1.glb?v=${KID_ASSET_CACHE_VERSION}`
        : ACTOR_SPECS.kid.bootstrapUrl;
    const qaPoliceAnimationScenario = qaSearchParams.has("qa")
      ? parseQaPoliceAnimation(qaSearchParams.get("qaPoliceClip"))
      : null;
    const qaPoliceAnimationTime = qaPoliceAnimationScenario
      ? parseQaNormalizedTime(qaSearchParams.get("qaPoliceTime"))
      : null;
    const qaPoliceAssetVariant = qaSearchParams.has("qa")
      ? parseQaPoliceAssetVariant(qaSearchParams.get("qaPoliceAsset"))
      : null;
    const qaPoliceAssetUrl = qaPoliceAssetVariant === "high"
      ? `/models/characters/police.glb?v=${POLICE_ASSET_CACHE_VERSION}`
      : ACTOR_SPECS.police.url;
    let qaLoadedKidAssetIdentity: QaLoadedGlbIdentity | null = null;
    let qaLoadedPoliceAssetIdentity: QaLoadedGlbIdentity | null = null;
    const qaLoadedGlbIdentities = new WeakMap<THREE.Object3D, QaLoadedGlbIdentity>();
    let qaDomSnapshotTimer: ReturnType<typeof setInterval> | null = null;
    let qaLevelSelectionTimer: ReturnType<typeof setTimeout> | null = null;
    let qaKidAnimationTimer: ReturnType<typeof setTimeout> | null = null;
    let qaKidFrameSnapshotTimer: ReturnType<typeof setInterval> | null = null;
    let qaPoliceAnimationTimer: ReturnType<typeof setTimeout> | null = null;
    let qaPoliceFrameSnapshotTimer: ReturnType<typeof setInterval> | null = null;
    const qaQualityValue = qaSearchParams.has("qa")
      ? qaSearchParams.get("qaQuality")
      : null;
    const qaRequestedRenderQuality: RenderQualityTier | null =
      qaQualityValue === "high"
      || qaQualityValue === "balanced"
      || qaQualityValue === "mobile"
        ? qaQualityValue
        : null;
    let renderQualityTier: RenderQualityTier = qaRequestedRenderQuality
      ?? selectInitialRenderQuality({
        viewportWidth: Math.max(1, initialBounds.width),
        viewportHeight: Math.max(1, initialBounds.height),
        devicePixelRatio,
        coarsePointer: touchLayoutMedia.matches,
        deviceMemoryGb: deviceNavigator.deviceMemory,
        hardwareConcurrency: navigator.hardwareConcurrency,
      });
    let renderQualityProfile: RenderQualityProfile = RENDER_QUALITY_PROFILES[renderQualityTier];
    let emergencyDegradation: EmergencyDegradationState = INITIAL_EMERGENCY_DEGRADATION_STATE;
    let qualitySamples: number[] = [];
    let qualityEvaluationSeconds = 0;
    let qualityDecisionSeconds = 0;
    let qualityCandidate: RenderQualityTier = renderQualityTier;
    let qaRenderQualityLocked = qaRequestedRenderQuality !== null;
    const qaQualityAppliedBeforeRendererCreation = qaRenderQualityLocked;
    let renderQualityTransitionCount = 0;
    let emergencyQualityTransitionCount = 0;
    let deferredDressingRoot: THREE.Group | null = null;
    let latestFirstPlayableAudit: ReturnType<typeof auditFirstPlayableAssetBudget> | null = null;
    const loadedTransferBytes = new Map<string, number>();
    const assetDependencyUrls = new Map<string, readonly string[]>();
    const firstPlayableManifest: AssetBudgetManifestEntry[] = [];
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
    let cameraFollowState: FixedCameraFollowState = createFixedCameraFollowState(cameraFocus);
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
    renderer.info.autoReset = false;
    const supportsMultiDraw = renderer.extensions.has("WEBGL_multi_draw")
      && !new URLSearchParams(location.search).has("no-multi-draw");
    host.appendChild(renderer.domElement);
    document.addEventListener("visibilitychange", resetFrameClock);
    addEventListener("pageshow", resetFrameClock);
    let sceneRecoveryRequested = false;
    const requestSceneRecovery = () => {
      if (disposed || sceneRecoveryRequested) return;
      sceneRecoveryRequested = true;
      queueMicrotask(() => {
        if (!disposed) setSceneRevision((revision) => revision + 1);
      });
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      ready = false;
      delete document.documentElement.dataset.chasingReady;
      keyboardKeys.current.clear();
      touchKeys.current.clear();
      interactPressed.current = false;
      preferredHideExit.current = "origin";
      if (!disposed) {
        setLoading(true);
        setLoadError("3D 渲染上下文已中断；恢复后将在当前关卡原地重建。");
      }
    };
    const handleContextRestored = () => {
      requestSceneRecovery();
    };
    renderer.domElement.addEventListener("webglcontextlost", handleContextLost);
    renderer.domElement.addEventListener("webglcontextrestored", handleContextRestored);

    let environmentTarget: THREE.WebGLRenderTarget | null = null;
    let environmentScheduleHandle: number | null = null;
    let environmentScheduledWithIdleCallback = false;
    scene.environmentIntensity = atmosphere.environmentIntensity;
    const scheduleEnvironmentLighting = () => {
      if (disposed || environmentTarget || environmentScheduleHandle !== null) return;
      const installEnvironment = () => {
        environmentScheduleHandle = null;
        if (disposed || environmentTarget) return;
        const pmrem = new THREE.PMREMGenerator(renderer);
        const roomEnvironment = new RoomEnvironment();
        try {
          environmentTarget = pmrem.fromScene(roomEnvironment, 0.04);
          scene.environment = environmentTarget.texture;
        } catch (error) {
          console.warn("Deferred reflection environment is unavailable; authored lights remain active", error);
        } finally {
          roomEnvironment.dispose();
          pmrem.dispose();
        }
      };
      const idleWindow = window as Window & {
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout: number },
        ) => number;
      };
      if (idleWindow.requestIdleCallback) {
        environmentScheduledWithIdleCallback = true;
        environmentScheduleHandle = idleWindow.requestIdleCallback(
          installEnvironment,
          { timeout: 1_200 },
        );
      } else {
        environmentScheduleHandle = window.setTimeout(installEnvironment, 900);
      }
    };

    const hemisphere = new THREE.HemisphereLight(
      new THREE.Color(campaignLevel.campaign.palette.sky).offsetHSL(0, 0, 0.25),
      new THREE.Color(campaignLevel.campaign.palette.floor).multiplyScalar(0.34),
      atmosphere.hemisphereIntensity,
    );
    hemisphere.layers.enable(1);
    scene.add(hemisphere);
    const moon = new THREE.DirectionalLight(
      campaignLevel.campaign.theme === "factory" ? 0x91dced : 0xb9d7ff,
      atmosphere.keyIntensity,
    );
    moon.position.set(14, 28, 18);
    moon.castShadow = true;
    moon.target.position.copy(cameraFocus);
    moon.layers.enable(1);
    scene.add(moon.target);
    moon.shadow.mapSize.set(renderQualityProfile.shadowMapSize, renderQualityProfile.shadowMapSize);
    moon.shadow.camera.left = -18;
    moon.shadow.camera.right = 18;
    moon.shadow.camera.top = 18;
    moon.shadow.camera.bottom = -18;
    moon.shadow.camera.near = 1;
    moon.shadow.camera.far = 68;
    // Dense bevelled wall kits otherwise self-shadow at sub-pixel depth and
    // produce diagonal acne from the elevated camera. A slightly larger
    // receiver offset keeps contact shadows intact while stabilising the
    // architectural faces across desktop and mobile DPRs.
    moon.shadow.bias = -0.00055;
    moon.shadow.normalBias = 0.045;
    scene.add(moon);
    const warmBounceColor = new THREE.Color(campaignLevel.campaign.palette.emissive).lerp(
      new THREE.Color(campaignLevel.campaign.palette.accent),
      artLayout.warmLightMix * 0.32,
    );
    const warmBounce = new THREE.DirectionalLight(
      warmBounceColor,
      atmosphere.bounceIntensity * (0.72 + artLayout.warmLightMix * 0.28),
    );
    warmBounce.layers.enable(1);
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
    let occlusionRaycastRemaining = 0;

    const registerPerformanceLight = (light: THREE.Light, priority: number) => {
      light.layers.enable(1);
      performanceLights.push({ light, priority });
    };
    const unregisterPerformanceLight = (light: THREE.Light) => {
      const index = performanceLights.findIndex((entry) => entry.light === light);
      if (index >= 0) performanceLights.splice(index, 1);
      light.intensity = 0;
      light.visible = false;
    };
    const buildThemeMechanicView = (
      themeKit: GLTF,
      cornerMirrorKit: GLTF,
    ): MechanicView => {
      const art = THEME_MECHANIC_ART[campaignLevel.campaign.theme];
      const source = resolveThemeNode(
        themeKit.scene,
        campaignLevel.campaign.theme,
        [art.node],
      );
      if (!source) {
        throw new Error(`${campaignLevel.campaign.themeLabel}主题模型缺少主动机关节点 ${art.node}`);
      }
      const toolArt = THEME_STEALTH_TOOL_ART[campaignLevel.campaign.theme];
      for (const tool of STEALTH_TOOL_KINDS) {
        const toolSpec = toolArt[tool];
        const toolAsset = tool === "corner-mirror"
          ? cornerMirrorKit
          : themeKit;
        const toolSource = resolveThemeNode(
          toolAsset.scene,
          campaignLevel.campaign.theme,
          [toolSpec.node],
        );
        if (!toolSource) {
          throw new Error(
            `${campaignLevel.campaign.themeLabel}主题模型缺少${toolSpec.label}节点 ${toolSpec.node}`,
          );
        }
        // Isolate the tool finish before fitProp tunes PBR values. Geometry
        // and texture images remain shared, while source-kit materials cannot
        // be mutated by a transient gameplay presentation.
        const styledToolSource = toolSource.clone(true);
        if (tool !== "corner-mirror") {
          applyThemeSurface(
            styledToolSource,
            campaignLevel.campaign.palette.accent,
            {
              blend: tool === "temporary-blackout" ? 0.16 : 0.08,
              emissive: campaignLevel.campaign.palette.emissive,
              emissiveIntensity: tool === "temporary-blackout" ? 0.36 : 0.2,
              roughnessShift: -0.06,
            },
          );
        }
        // The dedicated mirror kit is authored at true metric scale with its
        // lens, rim, articulated arm and wall plate proportioned separately.
        // Do not fit or tint the complete assembly as one prop: that was the
        // source of the oversized glowing-halo silhouette in the first pass.
        const template = tool === "corner-mirror"
          ? (() => {
              const authoredAssembly = new THREE.Group();
              authoredAssembly.add(styledToolSource);
              return authoredAssembly;
            })()
          : fitProp(styledToolSource, toolSpec.height, true);
        if (tool === "corner-mirror") {
          const authoredMirrorPartNames = [
            "polished-corner-mirror-face",
            "authored-corner-mirror-rim",
            "corner-mirror-wall-plate",
            "corner-mirror-articulated-arm",
            "corner-mirror-fasteners",
            "corner-mirror-status-led",
          ] as const;
          template.traverse((object) => {
            // GLTFLoader uniquifies repeated node names across the four
            // assemblies (`…_1`, `…_2`, and so on). Restore the formal role
            // name inside this isolated theme clone so runtime telemetry and
            // accessibility/debug tooling retain stable semantic identities.
            const authoredPartName = authoredMirrorPartNames.find(
              (name) => (
                object.name === name
                || object.name.startsWith(`${name}_`)
                || object.name.startsWith(`${name}.`)
              ),
            );
            if (authoredPartName) object.name = authoredPartName;
            if (!(object instanceof THREE.Mesh)) return;
            object.castShadow =
              object.name !== "polished-corner-mirror-face";
            object.receiveShadow = true;
            object.frustumCulled = true;
            const materials = Array.isArray(object.material)
              ? object.material
              : [object.material];
            for (const material of materials) {
              if (material instanceof THREE.MeshStandardMaterial) {
                material.envMapIntensity = Math.max(
                  material.envMapIntensity,
                  1.35,
                );
              }
            }
          });
        } else {
          tuneMeshes(template);
        }
        template.name = `${campaignLevel.campaign.theme}-authored-${tool}-template`;
        template.userData.authoredToolSource = toolSpec.node;
        template.userData.authoredToolLabel = toolSpec.label;
        template.userData.authoredToolAssetId = tool === "corner-mirror"
          ? "stealth-kit:corner-mirrors"
          : `theme-kit:${campaignLevel.campaign.theme}`;
        template.userData.authoredToolSourceUrl = tool === "corner-mirror"
          ? STEALTH_CORNER_MIRROR_ASSET
          : THEME_KIT_ASSETS[campaignLevel.campaign.theme];
        template.userData.authoredToolGeometrySignature =
          authoredGeometrySignature(toolSource);
        template.userData.authoredToolFallbackUsed = false;
        template.userData.authoredToolIndicatorAnchor =
          toolSpec.indicatorAnchor ? [...toolSpec.indicatorAnchor] : null;
        template.userData.authoredToolWallOffsetCells =
          toolSpec.wallOffsetCells ?? null;
        template.userData.authoredToolRuntimeScale =
          toolSpec.runtimeScale ?? 1;
        stealthToolModelTemplates[tool] = template;
      }
      const root = fitProp(source, art.height, true);
      root.name = `active-theme-mechanic-${mechanicDefinition.id}`;
      const adjacentWallDirection = [
        { x: -1, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: -1 },
        { x: 0, y: 1 },
      ].find((direction) => (
        !campaignLevel.walkable[mechanicPosition.y + direction.y]?.[mechanicPosition.x + direction.x]
      )) ?? nearestExteriorDirection(mechanicPosition, campaignLevel);
      root.position.copy(world(mechanicPosition, campaignLevel)).add(new THREE.Vector3(
        adjacentWallDirection.x * CELL * 0.62,
        0,
        adjacentWallDirection.y * CELL * 0.62,
      ));
      root.rotation.y = Math.atan2(-adjacentWallDirection.x, -adjacentWallDirection.y);
      applyThemeSurface(root, campaignLevel.campaign.palette.accent, {
        blend: 0.08,
        emissive: campaignLevel.campaign.palette.emissive,
        emissiveIntensity: 0.11,
        roughnessShift: -0.04,
      });
      const beaconMaterial = new THREE.SpriteMaterial({
        map: createMechanicBeaconTexture(
          campaignLevel.campaign.palette.emissive,
          art.label,
        ),
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const beacon = new THREE.Sprite(beaconMaterial);
      beacon.name = `theme-mechanic-beacon-${mechanicDefinition.id}`;
      beacon.center.set(0.5, 0);
      beacon.position.set(0, art.height + 0.22, 0);
      beacon.scale.set(2.8, 1.05, 1);
      beacon.renderOrder = 19;
      beacon.visible = false;
      root.add(beacon);
      const light = new THREE.PointLight(
        campaignLevel.campaign.palette.emissive,
        0.6,
        7.5,
        2,
      );
      light.position.set(0, Math.max(1.05, art.height * 0.67), -0.12);
      root.add(light);
      registerPerformanceLight(light, 2);
      campus.add(root);
      placedAssetIds.add(`theme-node:${source.name || art.node}`);
      placedAssetIds.add(`gameplay:theme-mechanic:${mechanicDefinition.id}`);
      const view: MechanicView = {
        root,
        beacon,
        light,
        position: mechanicPosition,
        baseScale: root.scale.clone(),
      };
      mechanicView = view;
      return view;
    };
    const buildThemeMissionViews = (themeKit: GLTF) => {
      const libraryObjectiveArt: Readonly<Record<string, readonly string[]>> = {
        "library:retrieve-temporary-pass": ["CampusArchiveCluster"],
        "library:write-front-gate-authorization": ["CampusWayfinding"],
        "library:release-front-gate": ["CampusLibraryExitCluster"],
        "library:restore-egress-circuit": ["CampusWayfinding"],
        "library:prime-fire-door-linkage": ["CampusLibraryHideDressing"],
        "library:release-loading-fire-door": ["CampusLibraryExitCluster"],
      };
      for (const [index, objective] of runtimeMissionObjectives.entries()) {
        const beat = environmentComposition.landmarkBeats[
          Math.min(index, environmentComposition.landmarkBeats.length - 1)
        ];
        const position = missionPlacementById.get(objective.id);
        if (!position) throw new Error(`主题任务 ${objective.id} 缺少运行态位置`);
        const candidates = libraryObjectiveArt[objective.id]
          ?? (objective.unlocksExit
            ? [
                ...environmentComposition.profile.exitNodeCandidates,
                ...beat.nodeCandidates,
              ]
            : beat.nodeCandidates);
        const source = resolveThemeNode(
          themeKit.scene,
          campaignLevel.campaign.theme,
          candidates,
        );
        if (!source) {
          throw new Error(
            `${campaignLevel.campaign.themeLabel}主题模型缺少任务地标 ${candidates.join("/")}`,
          );
        }
        const root = fitProp(source, objective.unlocksExit ? 1.95 : 1.68, true);
        root.name = `mission-objective-${objective.id}`;
        const blockedDirection = [
          { x: -1, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: -1 },
          { x: 0, y: 1 },
        ].find((direction) => (
          !campaignLevel.walkable[position.y + direction.y]?.[position.x + direction.x]
        ));
        const routeSide = blockedDirection ?? {
          x: beat.routeTangent.y * beat.lateralBias,
          y: -beat.routeTangent.x * beat.lateralBias,
        };
        root.position.copy(world(position, campaignLevel)).add(new THREE.Vector3(
          routeSide.x * CELL * 0.72,
          0,
          routeSide.y * CELL * 0.72,
        ));
        root.rotation.y = Math.atan2(-routeSide.x, -routeSide.y);
        applyThemeSurface(root, campaignLevel.campaign.palette.accent, {
          blend: objective.unlocksExit ? 0.14 : 0.07,
          emissive: campaignLevel.campaign.palette.emissive,
          emissiveIntensity: objective.unlocksExit ? 0.16 : 0.08,
          roughnessShift: -0.035,
        });
        const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
          map: createMechanicBeaconTexture(
            campaignLevel.campaign.palette.emissive,
            objective.label,
          ),
          transparent: true,
          opacity: 0,
          depthTest: true,
          depthWrite: false,
          toneMapped: false,
        }));
        beacon.name = `mission-beacon-${objective.id}`;
        beacon.center.set(0.5, 0);
        beacon.position.set(0, objective.unlocksExit ? 2.55 : 2.3, 0);
        beacon.scale.set(1.82, 0.68, 1);
        beacon.renderOrder = 7;
        root.add(beacon);
        const light = new THREE.PointLight(
          campaignLevel.campaign.palette.emissive,
          0,
          objective.unlocksExit ? 6.8 : 5.6,
          2,
        );
        light.name = `mission-light-${objective.id}`;
        light.position.set(0, objective.unlocksExit ? 1.42 : 1.16, 0);
        root.add(light);
        registerPerformanceLight(light, objective.unlocksExit ? 4 : 3);
        campus.add(root);
        placedAssetIds.add(`theme-node:${source.name || candidates[0]}`);
        placedAssetIds.add(`gameplay:mission-objective:${objective.id}`);
        missionViews.set(objective.id, {
          id: objective.id,
          root,
          beacon,
          light,
          position,
          baseScale: root.scale.clone(),
        });
      }
    };
    const buildPortableDecoyTemplate = (booksAsset: GLTF) => {
      const template = fitNamedStaticProp(
        booksAsset.scene,
        "Dropped_Notebook_",
        0.32,
        true,
      );
      template.name = "portable-decoy-authored-notebook-template";
      portableDecoyTemplate = template;
      placedAssetIds.add("detail:books:Dropped_Notebook");
    };
    const portableDecoyHandAnchor = () => {
      const heading = latestState.player.heading;
      const length = Math.max(1e-6, Math.hypot(heading.x, heading.y));
      const forward = { x: heading.x / length, y: heading.y / length };
      const right = { x: forward.y, y: -forward.x };
      const base = actors.kid?.root.position
        ?? world(latestState.player.position, campaignLevel);
      return base.clone().add(new THREE.Vector3(
        right.x * 0.24 + forward.x * 0.16,
        1.04,
        right.y * 0.24 + forward.y * 0.16,
      ));
    };
    const createPortableDecoyView = (
      deployment: NonNullable<PortableDecoyState["activeDeployment"]>,
    ) => {
      if (!portableDecoyTemplate) {
        throw new Error("图书楼可携式诱饵缺少正式精装笔记本模型");
      }
      const root = new THREE.Group();
      root.name = `portable-decoy-${deployment.deploymentId}`;
      root.userData.portableDecoyRoot = true;
      const notebook = portableDecoyTemplate.clone(true);
      notebook.name = "portable-decoy-authored-notebook";
      root.add(notebook);
      const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: createMechanicBeaconTexture("#ffc976", "诱饵声源"),
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      }));
      beacon.name = `portable-decoy-beacon-${deployment.deploymentId}`;
      beacon.position.set(0, 0.64, 0);
      beacon.scale.set(1.22, 0.46, 1);
      beacon.renderOrder = 7;
      root.add(beacon);
      const light = new THREE.PointLight(0xffbd67, 0, 3.8, 2);
      light.name = `portable-decoy-light-${deployment.deploymentId}`;
      light.position.set(0, 0.26, 0);
      root.add(light);
      registerPerformanceLight(light, 2);
      const start = portableDecoyHandAnchor();
      const landing = world(deployment.position, campaignLevel)
        .add(new THREE.Vector3(0, 0.012, 0));
      root.position.copy(start);
      campus.add(root);
      const view: PortableDecoyView = {
        deploymentId: deployment.deploymentId,
        sourceId: deployment.sourceId,
        root,
        beacon,
        light,
        start,
        landing,
        deployedAtSeconds: deployment.deployedAtSeconds,
        releaseAtSeconds: deployment.deployedAtSeconds
          + (deployment.soundAtSeconds - deployment.deployedAtSeconds)
            * PORTABLE_DECOY_RELEASE_FRACTION,
        soundAtSeconds: deployment.soundAtSeconds,
        expiresAtSeconds: deployment.expiresAtSeconds,
        settled: false,
        lightRegistered: true,
        released: false,
        disposed: false,
      };
      portableDecoyViewCreatedCount += 1;
      portableDecoyBeaconTextureCreatedCount += 1;
      portableDecoyViews.set(deployment.deploymentId, view);
      placedAssetIds.add(`gameplay:portable-decoy:${deployment.deploymentId}`);
      return view;
    };
    const disposePortableDecoyView = (view: PortableDecoyView) => {
      if (view.disposed) return;
      view.disposed = true;
      if (view.lightRegistered) {
        unregisterPerformanceLight(view.light);
        view.lightRegistered = false;
      }
      const material = view.beacon.material as THREE.SpriteMaterial;
      const texture = material.map;
      material.map = null;
      texture?.dispose();
      if (texture) portableDecoyBeaconTextureDisposedCount += 1;
      material.dispose();
      portableDecoyBeaconMaterialDisposedCount += 1;
      view.root.removeFromParent();
      portableDecoyViewDisposedCount += 1;
      placedAssetIds.delete(`gameplay:portable-decoy:${view.deploymentId}`);
    };
    const updatePortableDecoyViews = (nowSeconds: number) => {
      for (const view of portableDecoyViews.values()) {
        if (latestState.phase !== "playing") {
          // A terminal phase freezes simulation time. Resolve any in-hand or
          // airborne notebook to its authored landing pose so the result
          // performance never shows a prop suspended through the actor.
          view.root.position.copy(view.landing);
          view.root.rotation.set(0, Math.PI * 0.18, 0.035);
          view.released = true;
          view.settled = true;
          view.beacon.visible = false;
          (view.beacon.material as THREE.SpriteMaterial).opacity = 0;
          view.light.intensity = 0;
          if (view.lightRegistered) {
            unregisterPerformanceLight(view.light);
            view.lightRegistered = false;
          }
          continue;
        }
        if (nowSeconds < view.releaseAtSeconds) {
          view.start.copy(portableDecoyHandAnchor());
          view.root.position.copy(view.start);
          view.root.rotation.set(-0.12, Math.PI * 0.1, 0.08);
          continue;
        }
        if (!view.released) {
          view.released = true;
          soundscape.triggerWorldSound({
            listenerPosition: latestState.player.position,
            sourcePosition: latestState.player.position,
            kind: "theme-event",
            maxDistance: 6,
            baseGain: 0.18,
            occlusion: 0,
            foleySet: "cloth",
            playbackRate: 1.08,
          });
        }
        const flightDuration = Math.max(
          0.001,
          view.soundAtSeconds - view.releaseAtSeconds,
        );
        const flightProgress = THREE.MathUtils.clamp(
          (nowSeconds - view.releaseAtSeconds) / flightDuration,
          0,
          1,
        );
        if (flightProgress < 1) {
          const eased = 1 - (1 - flightProgress) ** 3;
          view.root.position.lerpVectors(view.start, view.landing, eased);
          view.root.position.y += Math.sin(flightProgress * Math.PI)
            * (preferencesRef.current.reducedMotion ? 0.34 : 0.92);
          view.root.rotation.set(
            Math.sin(flightProgress * Math.PI)
              * (preferencesRef.current.reducedMotion ? 0.16 : 0.5),
            flightProgress * Math.PI
              * (preferencesRef.current.reducedMotion ? 0.65 : 2.25),
            Math.sin(flightProgress * Math.PI)
              * (preferencesRef.current.reducedMotion ? 0.06 : 0.2),
          );
        } else if (!view.settled) {
          view.root.position.copy(view.landing);
          view.root.rotation.set(0, Math.PI * 0.18, 0.035);
          view.settled = true;
        }
        const active = portableDecoyState?.activeDeployment?.deploymentId
          === view.deploymentId;
        const justLanded = nowSeconds - view.soundAtSeconds;
        const pulse = active && justLanded >= 0
          ? 0.7 + Math.sin(justLanded * Math.PI * 4) * 0.3
          : 0;
        (view.beacon.material as THREE.SpriteMaterial).opacity = active
          ? THREE.MathUtils.clamp(0.42 + pulse * 0.34, 0, 0.82)
          : 0;
        view.beacon.visible = active;
        view.light.intensity = active ? 1.6 + pulse * 1.9 : 0;
        if (!active && view.lightRegistered) {
          unregisterPerformanceLight(view.light);
          view.lightRegistered = false;
        }
      }
    };
    const createFootprintEvidenceTexture = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建足迹证据纹理");
      const paintSole = (
        x: number,
        y: number,
        rotation: number,
        mirrored: boolean,
      ) => {
        context.save();
        context.translate(x, y);
        context.rotate(rotation);
        context.scale(mirrored ? -1 : 1, 1);
        const gradient = context.createLinearGradient(-20, -66, 20, 66);
        gradient.addColorStop(0, "rgba(231,248,239,.96)");
        gradient.addColorStop(0.38, "rgba(142,181,160,.88)");
        gradient.addColorStop(0.72, "rgba(87,119,102,.7)");
        gradient.addColorStop(1, "rgba(43,62,52,.35)");
        context.fillStyle = gradient;
        context.shadowColor = "rgba(126,231,190,.32)";
        context.shadowBlur = 8;
        context.beginPath();
        context.moveTo(-4, -63);
        context.bezierCurveTo(-24, -61, -30, -43, -25, -24);
        context.bezierCurveTo(-21, -9, -12, -2, -14, 15);
        context.bezierCurveTo(-17, 34, -20, 54, -12, 64);
        context.bezierCurveTo(-4, 72, 12, 70, 17, 60);
        context.bezierCurveTo(22, 48, 15, 30, 15, 15);
        context.bezierCurveTo(15, -1, 29, -15, 29, -34);
        context.bezierCurveTo(29, -53, 15, -65, -4, -63);
        context.closePath();
        context.fill();
        context.shadowBlur = 0;

        // Carve the arch and worn tread gaps from a continuous, recognizable
        // shoe silhouette. Fixed lug placement keeps the generated texture
        // deterministic across runs and screenshots.
        context.globalCompositeOperation = "destination-out";
        context.fillStyle = "rgba(0,0,0,.86)";
        context.beginPath();
        context.ellipse(-13, 6, 8, 19, -0.18, 0, Math.PI * 2);
        context.fill();
        for (let row = -48; row <= 52; row += 17) {
          for (const column of [-10, 5, 18]) {
            context.save();
            context.translate(column, row);
            context.rotate((row / 17) % 2 ? 0.3 : -0.3);
            context.beginPath();
            context.roundRect(-5, -2.3, 10, 4.6, 1.6);
            context.fill();
            context.restore();
          }
        }
        context.save();
        context.rotate(-0.22);
        context.fillRect(-23, -4, 46, 5);
        context.restore();

        context.globalCompositeOperation = "source-over";
        context.strokeStyle = "rgba(226,251,239,.84)";
        context.lineWidth = 2.2;
        context.beginPath();
        context.moveTo(-4, -63);
        context.bezierCurveTo(-24, -61, -30, -43, -25, -24);
        context.bezierCurveTo(-21, -9, -12, -2, -14, 15);
        context.bezierCurveTo(-17, 34, -20, 54, -12, 64);
        context.bezierCurveTo(-4, 72, 12, 70, 17, 60);
        context.bezierCurveTo(22, 48, 15, 30, 15, 15);
        context.bezierCurveTo(15, -1, 29, -15, 29, -34);
        context.bezierCurveTo(29, -53, 15, -65, -4, -63);
        context.stroke();

        context.fillStyle = "rgba(205,239,220,.44)";
        for (const [speckX, speckY, radius] of [
          [-20, -56, 2.1],
          [23, -40, 1.5],
          [-15, 29, 1.8],
          [14, 50, 1.2],
          [3, -25, 1.4],
        ] as const) {
          context.beginPath();
          context.arc(speckX, speckY, radius, 0, Math.PI * 2);
          context.fill();
        }
        context.restore();
      };
      paintSole(81, 126, -0.12, false);
      paintSole(177, 119, 0.12, true);
      const texture = new THREE.CanvasTexture(canvas);
      texture.name = "shared-premium-footprint-evidence";
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = Math.min(
        8,
        renderer.capabilities.getMaxAnisotropy(),
      );
      return texture;
    };
    const footprintEvidenceTexture = createFootprintEvidenceTexture();
    const footprintEvidenceGeometry = new THREE.PlaneGeometry(
      CELL * 0.76,
      CELL * 0.58,
    );
    const footprintEvidenceMaterial = new THREE.MeshStandardMaterial({
      name: "shared-premium-footprint-evidence-material",
      map: footprintEvidenceTexture,
      emissiveMap: footprintEvidenceTexture,
      transparent: true,
      opacity: 0.82,
      alphaTest: 0.055,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
      roughness: 0.78,
      metalness: 0.02,
      emissive: new THREE.Color(0x8ee5bc),
      emissiveIntensity: 0.18,
      side: THREE.DoubleSide,
    });
    const prewarmTransientArtResources = () => {
      if (qaTransientArtPrewarmCount > 0) return true;
      const templates = STEALTH_TOOL_KINDS.map(
        (tool) => stealthToolModelTemplates[tool],
      );
      if (templates.some((template) => !template)) return false;

      // The resource lifecycle gate must start after every shared authored
      // geometry has reached WebGL once. A normal compile only prepares shader
      // programs; a small offscreen draw also uploads geometry that happens to
      // be outside the live camera on the first tool deployment. This keeps
      // the baseline deterministic without weakening exact leak assertions.
      const prewarmScene = new THREE.Scene();
      const prewarmCamera = new THREE.OrthographicCamera(-2.6, 2.6, 1.8, -1.8, 0.1, 20);
      prewarmCamera.position.set(0, 0.72, 8);
      prewarmCamera.lookAt(0, 0.45, 0);
      const clones = templates.map((template, index) => {
        const clone = template!.clone(true);
        clone.position.set((index - 1) * 1.55, 0, 0);
        clone.traverse((object) => {
          object.visible = true;
          if (object instanceof THREE.Mesh) object.frustumCulled = false;
        });
        prewarmScene.add(clone);
        return clone;
      });
      const footprint = new THREE.Mesh(
        footprintEvidenceGeometry,
        footprintEvidenceMaterial,
      );
      footprint.position.set(2.2, 0.35, 0);
      footprint.frustumCulled = false;
      prewarmScene.add(footprint);
      const overrideMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
      });
      prewarmScene.overrideMaterial = overrideMaterial;
      const target = new THREE.WebGLRenderTarget(8, 8, {
        depthBuffer: false,
        stencilBuffer: false,
      });
      const previousTarget = renderer.getRenderTarget();
      const previousAutoClear = renderer.autoClear;
      try {
        renderer.setRenderTarget(target);
        renderer.autoClear = true;
        renderer.clear();
        renderer.render(prewarmScene, prewarmCamera);
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
        prewarmScene.overrideMaterial = null;
        clones.forEach((clone) => clone.removeFromParent());
        footprint.removeFromParent();
        target.dispose();
        overrideMaterial.dispose();
      }
      qaTransientArtPrewarmCount += 1;
      return true;
    };
    const compileSettledQaScene = () => {
      if (
        qaDecorativeSceneCompiled
        || !decorativeAssetsReady
        || deferredDressingFade !== null
        || !qaRenderQualityLocked
        || !prewarmTransientArtResources()
      ) return false;
      scene.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      renderer.compile(scene, camera);
      qaDecorativeSceneCompiled = true;
      qaDecorativeSceneCompileCount += 1;
      return true;
    };
    const createStealthEvidenceView = (evidence: AiEvidenceView) => {
      if (stealthEvidenceViews.has(evidence.id)) return;
      const placedAssetId =
        `gameplay:stealth-evidence:${evidence.kind}:${evidence.id}`;
      const root = new THREE.Group();
      root.name = `stealth-evidence-${evidence.id}`;
      root.userData.transientStealthRoot = true;
      root.position.copy(world(evidence.position, campaignLevel));
      if (evidence.kind === "footprint") {
        const tread = new THREE.Mesh(
          footprintEvidenceGeometry,
          footprintEvidenceMaterial,
        );
        tread.name = "shared-premium-footprint-pair";
        tread.rotation.x = -Math.PI / 2;
        const direction = "direction" in evidence.detail
          ? evidence.detail.direction
          : { x: 0, y: 1 };
        tread.rotation.z = -Math.atan2(direction.x, direction.y);
        // Route markings sit at y=.072. Keep the evidence clearly above them
        // while remaining visually bonded to the floor.
        tread.position.y = 0.092;
        tread.renderOrder = 4;
        root.add(tread);
      } else {
        const evidenceTool: StealthToolKind = evidence.kind === "door-state"
          ? "door-wedge"
          : evidence.kind === "power-change"
            ? "temporary-blackout"
            : "corner-mirror";
        const evidenceTemplate = stealthToolModelTemplates[evidenceTool];
        if (!evidenceTemplate) return;
        const authoredClue = evidenceTemplate.clone(true);
        authoredClue.name = `authored-${evidence.kind}-evidence`;
        authoredClue.scale.multiplyScalar(evidence.kind === "power-change" ? 0.8 : 0.62);
        authoredClue.rotation.y = (evidence.createdAtTick % 7) * 0.17;
        root.add(authoredClue);
      }
      // Evidence shares authored/emissive surfaces instead of changing the
      // renderer's global point-light count for every transient clue. That
      // avoids compiling a new shader family across the entire environment.
      const light = null;
      campus.add(root);
      stealthEvidenceViews.set(evidence.id, {
        id: evidence.id,
        placedAssetId,
        root,
        light,
        createdAtTick: evidence.createdAtTick,
        expiresAtTick: evidence.expiresAtTick,
      });
      placedAssetIds.add(placedAssetId);
    };
    const disposeStealthEvidenceView = (view: StealthEvidenceView) => {
      if (view.light) unregisterPerformanceLight(view.light);
      view.root.removeFromParent();
      view.root.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.userData.transientStealthOwned) return;
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach((material) => {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          material.dispose();
        });
      });
      stealthEvidenceViews.delete(view.id);
      placedAssetIds.delete(view.placedAssetId);
    };
    const createStealthToolWorldView = (
      receipt: StealthToolReceipt,
    ) => {
      const template = stealthToolModelTemplates[receipt.tool];
      if (!template || stealthToolWorldViews.has(receipt.receiptId)) return;
      const placedAssetId =
        `gameplay:stealth-tool:${receipt.tool}:${receipt.receiptId}`;
      const root = new THREE.Group();
      const ownedGeometries = new Set<THREE.BufferGeometry>();
      const ownedMaterials = new Set<THREE.Material>();
      root.name = `stealth-tool-${receipt.tool}-${receipt.receiptId}`;
      root.userData.transientStealthRoot = true;
      for (const key of [
        "authoredToolSource",
        "authoredToolLabel",
        "authoredToolAssetId",
        "authoredToolSourceUrl",
        "authoredToolGeometrySignature",
        "authoredToolFallbackUsed",
        "authoredToolIndicatorAnchor",
        "authoredToolWallOffsetCells",
        "authoredToolRuntimeScale",
      ]) {
        root.userData[key] = template.userData[key];
      }
      const authoredDevice = template.clone(true);
      authoredDevice.name = `authored-${receipt.tool}-device`;
      root.add(authoredDevice);
      const authoredIndicatorAnchor =
        Array.isArray(template.userData.authoredToolIndicatorAnchor)
        && template.userData.authoredToolIndicatorAnchor.length === 3
          ? template.userData.authoredToolIndicatorAnchor as [number, number, number]
          : null;
      const addOwnedStatusLens = (
        name: string,
        anchor: readonly [number, number, number],
        radius: number,
        emissiveIntensity: number,
      ) => {
        const material = new THREE.MeshStandardMaterial({
          color: 0xffef9b,
          metalness: 0.36,
          roughness: 0.24,
          emissive: campaignLevel.campaign.palette.emissive,
          emissiveIntensity,
          side: THREE.DoubleSide,
        });
        const lens = new THREE.Mesh(
          new THREE.CircleGeometry(radius, 32),
          material,
        );
        lens.name = name;
        lens.position.fromArray(anchor);
        lens.position.z += 0.008;
        lens.userData.transientStealthOwned = true;
        ownedGeometries.add(lens.geometry);
        ownedMaterials.add(material);
        root.add(lens);
      };
      const position = receipt.riskEvidence.position;
      root.position.copy(world(position, campaignLevel));
      if (receipt.tool === "door-wedge") {
        const thresholdOffset = receipt.effect.traversalAxis === "horizontal"
          ? new THREE.Vector3(0.18, 0, 0)
          : new THREE.Vector3(0, 0, 0.18);
        root.position.add(thresholdOffset);
        root.position.y = 0.025;
        root.scale.setScalar(1);
        root.rotation.y =
          receipt.effect.traversalAxis === "horizontal" ? Math.PI / 2 : 0;
        addOwnedStatusLens(
          "authored-door-wedge-contact-indicator",
          authoredIndicatorAnchor ?? [0, 0.28, 0.11],
          0.06,
          0.82,
        );
      } else if (receipt.tool === "corner-mirror") {
        const corner = receipt.effect.origin;
        const solidDirections = [
          { x: -1, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: -1 },
          { x: 0, y: 1 },
        ].filter((direction) => (
          !campaignLevel.walkable[corner.y + direction.y]?.[
            corner.x + direction.x
          ]
        ));
        const toPlayer = {
          x: latestState.player.position.x - corner.x,
          y: latestState.player.position.y - corner.y,
        };
        const toPlayerLength = Math.hypot(toPlayer.x, toPlayer.y);
        const mountSelectionApproach = toPlayerLength > 0.1
          ? {
              x: toPlayer.x / toPlayerLength,
              y: toPlayer.y / toPlayerLength,
            }
          : receipt.effect.heading;
        const orthogonalSolidPairs = solidDirections.flatMap(
          (left, leftIndex) => solidDirections
            .slice(leftIndex + 1)
            .filter((right) => (
              left.x * right.x + left.y * right.y === 0
            ))
            .map((right) => [left, right] as const),
        );
        const mountPairScore = (
          pair: readonly [Point, Point],
        ) => {
          const length = Math.SQRT2;
          const bisector = {
            x: (pair[0].x + pair[1].x) / length,
            y: (pair[0].y + pair[1].y) / length,
          };
          // Prefer the opaque corner behind the approach, then break
          // dead-end ties away from the corridor the mirror is observing.
          return (
            bisector.x * -mountSelectionApproach.x
            + bisector.y * -mountSelectionApproach.y
            + (
              bisector.x * -receipt.effect.heading.x
              + bisector.y * -receipt.effect.heading.y
            ) * 0.35
          );
        };
        const mountPair = orthogonalSolidPairs.reduce<
          readonly [Point, Point] | null
        >(
          (best, candidate) => (
            !best || mountPairScore(candidate) > mountPairScore(best)
              ? candidate
              : best
          ),
          null,
        );
        const fallbackSolidDirection = solidDirections.reduce<Point | null>(
          (best, candidate) => {
            if (!best) return candidate;
            const candidateScore =
              candidate.x * -mountSelectionApproach.x
              + candidate.y * -mountSelectionApproach.y;
            const bestScore =
              best.x * -mountSelectionApproach.x
              + best.y * -mountSelectionApproach.y;
            return candidateScore > bestScore ? candidate : best;
          },
          null,
        ) ?? nearestExteriorDirection(corner, campaignLevel);
        const summedSolid = mountPair
          ? {
              x: mountPair[0].x + mountPair[1].x,
              y: mountPair[0].y + mountPair[1].y,
            }
          : fallbackSolidDirection;
        const solidLength = Math.hypot(summedSolid.x, summedSolid.y);
        const mountDirection = {
          x: summedSolid.x / Math.max(solidLength, 1),
          y: summedSolid.y / Math.max(solidLength, 1),
        };
        const approachDirection = toPlayerLength > 0.1
          ? mountSelectionApproach
          : {
              x: -mountDirection.x,
              y: -mountDirection.y,
            };
        // A convex observation mirror faces the optical bisector between the
        // player's approach and the corridor it reveals. This keeps the full
        // lens readable to the player while the public observation cone still
        // points around the authored corner.
        const faceBisector = {
          x: approachDirection.x + receipt.effect.heading.x,
          y: approachDirection.y + receipt.effect.heading.y,
        };
        const faceBisectorLength = Math.hypot(
          faceBisector.x,
          faceBisector.y,
        );
        const faceDirection = faceBisectorLength > 0.1
          ? {
              x: faceBisector.x / faceBisectorLength,
              y: faceBisector.y / faceBisectorLength,
            }
          : approachDirection;
        // Mount the authored wall plate into the real opaque corner. Its lens
        // and articulated arm protrude back into the open diagonal, keeping
        // the player capsule and the prop bounds physically separated.
        root.position.add(new THREE.Vector3(
          mountDirection.x * CELL * 0.88,
          0,
          mountDirection.y * CELL * 0.88,
        ));
        let wallTangent = {
          x: -mountDirection.y,
          y: mountDirection.x,
        };
        const awayFromPlayer = {
          x: -approachDirection.x,
          y: -approachDirection.y,
        };
        if (
          wallTangent.x * awayFromPlayer.x
            + wallTangent.y * awayFromPlayer.y
          < 0
        ) {
          wallTangent = {
            x: -wallTangent.x,
            y: -wallTangent.y,
          };
        }
        // Slide along the wall—not out into the route—so the lens and player
        // silhouettes retain a clean visual gap at the fixed gameplay bearing.
        root.position.add(new THREE.Vector3(
          wallTangent.x * 0.32,
          0,
          wallTangent.y * 0.32,
        ));
        root.position.y = 0;
        // Preserve a release-safe 85 px inspection silhouette across the
        // small projection differences between themes and camera layouts.
        root.scale.setScalar(
          typeof template.userData.authoredToolRuntimeScale === "number"
            ? template.userData.authoredToolRuntimeScale
            : 1,
        );
        root.rotation.y = Math.atan2(faceDirection.x, faceDirection.y);
      } else {
        const adjacentWallDirection = [
          { x: -1, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: -1 },
          { x: 0, y: 1 },
        ].find((direction) => (
          !campaignLevel.walkable[position.y + direction.y]?.[position.x + direction.x]
        )) ?? nearestExteriorDirection(position, campaignLevel);
        const wallOffsetCells =
          typeof template.userData.authoredToolWallOffsetCells === "number"
            ? template.userData.authoredToolWallOffsetCells
            : 0.42;
        root.position.add(new THREE.Vector3(
          adjacentWallDirection.x * CELL * wallOffsetCells,
          0,
          adjacentWallDirection.y * CELL * wallOffsetCells,
        ));
        root.position.y = 0.05;
        root.scale.setScalar(1);
        root.rotation.y = Math.atan2(
          -adjacentWallDirection.x,
          -adjacentWallDirection.y,
        );
        addOwnedStatusLens(
          "authored-blackout-status-lens",
          authoredIndicatorAnchor ?? [0, 0.64, 0.08],
          0.075,
          1.35,
        );
      }
      const basePosition = root.position.clone();
      const baseScale = root.scale.clone();
      const baseRotation = root.rotation.clone();
      root.position.y += 0.14;
      root.scale.multiplyScalar(0.74);
      root.rotation.y += 0.16;
      // The fitted authored mesh already carries a readable emissive response.
      // Avoid a transient PointLight here: adding/removing it changes the
      // global light-count shader key for every PBR material in view.
      const light = null;
      campus.add(root);
      stealthToolWorldViews.set(receipt.receiptId, {
        receiptId: receipt.receiptId,
        placedAssetId,
        tool: receipt.tool,
        root,
        light,
        createdAtTick: receipt.issuedAtTick,
        expiresAtTick: receipt.expiresAtTick,
        basePosition,
        baseScale,
        baseRotation,
        ownedGeometries,
        ownedMaterials,
        disposed: false,
      });
      placedAssetIds.add(placedAssetId);
    };
    const disposeStealthToolWorldView = (view: StealthToolWorldView) => {
      if (view.disposed) return;
      view.disposed = true;
      if (view.light) unregisterPerformanceLight(view.light);
      for (const geometry of view.ownedGeometries) geometry.dispose();
      for (const material of view.ownedMaterials) material.dispose();
      view.root.removeFromParent();
      stealthToolWorldViews.delete(view.receiptId);
      placedAssetIds.delete(view.placedAssetId);
    };
    const updateStealthWorldViews = (tick: number) => {
      for (const view of [...stealthEvidenceViews.values()]) {
        const record = stealthEvidenceState.records.find(({ id }) => id === view.id);
        if (!record || tick >= view.expiresAtTick) {
          disposeStealthEvidenceView(view);
          continue;
        }
        const lifetime = Math.max(1, view.expiresAtTick - view.createdAtTick);
        const age = Math.max(0, tick - view.createdAtTick);
        const fade = THREE.MathUtils.clamp(1 - age / lifetime, 0, 1);
        view.root.visible = fade > 0.04;
        if (view.light) view.light.intensity = 0.2 + fade * 0.72;
      }
      for (const view of [...stealthToolWorldViews.values()]) {
        if (tick >= view.expiresAtTick) {
          disposeStealthToolWorldView(view);
          continue;
        }
        const deployProgress = THREE.MathUtils.clamp(
          (tick - view.createdAtTick) / 10,
          0,
          1,
        );
        const eased = 1 - Math.pow(1 - deployProgress, 3);
        const settle = Math.sin(deployProgress * Math.PI) * 0.045;
        view.root.position.copy(view.basePosition);
        view.root.position.y += (1 - eased) * 0.14 + settle;
        view.root.scale.copy(view.baseScale).multiplyScalar(
          0.74 + eased * 0.26 + settle,
        );
        view.root.rotation.copy(view.baseRotation);
        view.root.rotation.y += (1 - eased) * 0.16;
        if (view.light) {
          const pulse = 0.5 + Math.sin(tick * 0.09 + view.createdAtTick) * 0.5;
          view.light.intensity = 0.7 + pulse * 1.25;
        }
      }
    };
    const updateThemeMissionViews = (nowMilliseconds: number) => {
      const available = new Set(
        availableRuntimeMissionObjectiveIds(),
      );
      const completed = new Set(
        libraryMissionState?.completedObjectiveIds
          ?? missionState.completedObjectiveIds,
      );
      for (const [id, view] of missionViews) {
        const isAvailable = available.has(id);
        const isCompleted = completed.has(id);
        const distance = distanceBetween(latestState.player.position, view.position);
        const nearby = distance <= 5.5;
        const pulse = 0.5 + Math.sin(nowMilliseconds * 0.006 + id.length) * 0.5;
        view.beacon.visible = latestState.phase === "playing"
          && isAvailable
          && nearby
          && distance > 1.05;
        const beaconMaterial = view.beacon.material as THREE.SpriteMaterial;
        beaconMaterial.opacity = view.beacon.visible
          ? distance <= 1.75 ? 0.7 : 0.48 + pulse * 0.2
          : 0;
        view.light.color.set(
          isCompleted
            ? 0x5ae0a0
            : isAvailable
              ? campaignLevel.campaign.palette.emissive
              : 0x51606a,
        );
        view.light.intensity = isCompleted
          ? 0.22
          : isAvailable && nearby
            ? distance <= 1.35 ? 3.4 + pulse * 0.6 : 1.1 + pulse * 0.35
            : 0.08;
        const scale = isAvailable && distance <= 1.35 ? 1 + pulse * 0.015 : 1;
        view.root.scale.copy(view.baseScale).multiplyScalar(scale);
      }
      if (exitMissionLight) {
        exitMissionLight.color.set(missionState.exitUnlocked ? 0x64f0a7 : 0xff5b62);
        exitMissionLight.intensity = missionState.exitUnlocked ? 18 : 6.5;
        exitMissionLight.angle = missionState.exitUnlocked ? Math.PI / 5.4 : Math.PI / 7.2;
      }
    };
    const updateThemeMechanicView = (
      view: MechanicView,
      sample: MechanicInstanceSample,
      nowMilliseconds: number,
    ) => {
      const beaconMaterial = view.beacon.material as THREE.SpriteMaterial;
      const blackoutReceipt =
        stealthToolbeltState.activeEffects["temporary-blackout"]?.receipt;
      const stealthBlackoutActive =
        blackoutReceipt?.tool === "temporary-blackout"
        && latestState.tick < blackoutReceipt.expiresAtTick;
      // A deployed stealth blackout already owns the local interaction and
      // status lanes. Suppress the nearby theme-console prompt until it ends
      // so two unrelated calls to action never stack over the actor.
      const promptVisible =
        sample.phase === "ready"
        && sample.canActivate
        && !stealthBlackoutActive;
      const worldFeedback = sampleMechanicWorldFeedback(
        campaignLevel.campaign.theme,
        {
          phase: sample.phase,
          progress: sample.progress,
          qualityTier: renderQualityTier,
          reducedMotion: preferencesRef.current.reducedMotion,
        },
      );
      view.beacon.visible = promptVisible || sample.phase === "warning";
      beaconMaterial.opacity = sample.phase === "warning"
        ? 0.72 + Math.sin(nowMilliseconds * 0.018) * 0.18
        : promptVisible ? 0.88 : 0;
      const phaseIntensity = Math.max(
        worldFeedback.lightIntensity,
        promptVisible ? 1.5 : sample.phase === "cooldown" ? 0.28 : 0.58,
      );
      view.light.intensity = Math.max(0, phaseIntensity);
      view.light.color.set(
        sample.phase === "warning"
          ? 0xffa44d
          : sample.phase === "active"
            ? campaignLevel.campaign.palette.emissive
            : promptVisible
              ? 0x5ae0a0
              : campaignLevel.campaign.palette.accent,
      );
      view.light.distance = worldFeedback.lightRangeMeters;
      view.root.scale.copy(view.baseScale).multiplyScalar(
        worldFeedback.stage ? worldFeedback.scaleMultiplier : 1,
      );
    };
    let performanceLightingBuilt = false;
    const buildPerformanceLighting = () => {
      if (performanceLightingBuilt) return;
      performanceLightingBuilt = true;
      for (const pool of environmentComposition.activeLightPools) {
        const lamp = new THREE.PointLight(
          pool.color,
          pool.intensity,
          pool.rangeMeters,
          2,
        );
        lamp.name = `composition-light-${pool.id}`;
        lamp.position.copy(world(pool.position, campaignLevel)).add(
          new THREE.Vector3(0, pool.heightMeters, 0),
        );
        lamp.castShadow = false;
        scene.add(lamp);
        registerPerformanceLight(lamp, pool.priority);
        placedAssetIds.add(`runtime:composition-light:${pool.id}`);
      }
    };
    const lightWorldPosition = new THREE.Vector3();
    const updatePerformanceLightBudget = (focus: THREE.Vector3) => {
      const emergencyPolicy = EMERGENCY_RENDER_POLICIES[emergencyDegradation.level];
      const active = performanceLights
        .filter(({ light }) => light.intensity > 1e-4)
        .map((entry) => ({
          ...entry,
          score: entry.priority * 10_000
            - entry.light.getWorldPosition(lightWorldPosition).distanceToSquared(focus),
        }))
        .sort((left, right) => right.score - left.score);
      const selected = new Set(
        active
          .slice(
            0,
            Math.max(
              1,
              Math.floor(
                renderQualityProfile.maximumDynamicLights
                * emergencyPolicy.dynamicLightScale,
              ),
            ),
          )
          .map(({ light }) => light),
      );
      for (const { light } of performanceLights) {
        light.visible = light.intensity > 1e-4 && selected.has(light);
      }
    };
    const applyNonCriticalShadowPolicy = () => {
      for (const entry of nonCriticalShadowCasters) {
        entry.object.castShadow = resolveRuntimeObjectPolicy({
          role: "decoration",
          baseVisible: entry.object.visible,
          baseCastShadow: renderQualityProfile.staticEnvironmentShadows && entry.castShadow,
          nearShadowCaster: false,
          emergencyLevel: emergencyDegradation.level,
        }).castShadow;
      }
    };
    const registerNonCriticalShadowCasters = (root: THREE.Object3D) => {
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !object.castShadow) return;
        nonCriticalShadowCasters.push({ object, castShadow: object.castShadow });
      });
      applyNonCriticalShadowPolicy();
    };
    const estimateShadowWorkload = () => {
      let shadowTriangles = 0;
      let shadowDrawCalls = 0;
      scene.traverseVisible((object) => {
        if (!(object instanceof THREE.Mesh) || !object.castShadow) return;
        const geometry = object.geometry;
        const primitiveTriangles = geometry.index
          ? geometry.index.count / 3
          : (geometry.getAttribute("position")?.count ?? 0) / 3;
        const instances = object instanceof THREE.InstancedMesh
          ? Math.max(1, object.count)
          : 1;
        shadowTriangles += Math.ceil(primitiveTriangles * instances);
        shadowDrawCalls += Array.isArray(object.material)
          ? Math.max(1, object.material.length)
          : 1;
      });
      return { shadowTriangles, shadowDrawCalls };
    };
    const startDeferredDressingFade = (root: THREE.Object3D) => {
      const clonedMaterials = new Map<string, THREE.Material>();
      const materialState = new Map<string, {
        material: THREE.Material;
        opacity: number;
        transparent: boolean;
        depthWrite: boolean;
      }>();
      const lights: Array<{ light: THREE.Light; intensity: number }> = [];
      const cloneMaterial = (source: THREE.Material) => {
        const existing = clonedMaterials.get(source.uuid);
        if (existing) return existing;
        const cloned = source.clone();
        clonedMaterials.set(source.uuid, cloned);
        materialState.set(cloned.uuid, {
          material: cloned,
          opacity: cloned.opacity,
          transparent: cloned.transparent,
          depthWrite: cloned.depthWrite,
        });
        cloned.transparent = true;
        cloned.depthWrite = false;
        cloned.opacity = 0;
        cloned.needsUpdate = true;
        return cloned;
      };
      root.traverse((object) => {
        if (
          object instanceof THREE.Mesh
          || object instanceof THREE.Points
          || object instanceof THREE.Line
          || object instanceof THREE.Sprite
        ) {
          object.material = Array.isArray(object.material)
            ? object.material.map(cloneMaterial)
            : cloneMaterial(object.material);
        }
        if (object instanceof THREE.Light) {
          lights.push({ light: object, intensity: object.intensity });
          object.intensity = 0;
        }
      });
      deferredDressingFade = {
        elapsedSeconds: 0,
        materials: [...materialState.values()],
        lights,
      };
    };
    const updateDeferredDressingFade = (delta: number) => {
      const fade = deferredDressingFade;
      if (!fade) return;
      fade.elapsedSeconds += delta;
      const progress = THREE.MathUtils.clamp(
        fade.elapsedSeconds / DEFERRED_DRESSING_FADE_SECONDS,
        0,
        1,
      );
      const eased = progress * progress * (3 - 2 * progress);
      for (const entry of fade.materials) entry.material.opacity = entry.opacity * eased;
      for (const entry of fade.lights) entry.light.intensity = entry.intensity * eased;
      if (progress < 1) return;
      for (const entry of fade.materials) {
        entry.material.opacity = entry.opacity;
        entry.material.transparent = entry.transparent;
        entry.material.depthWrite = entry.depthWrite;
        entry.material.needsUpdate = true;
      }
      for (const entry of fade.lights) entry.light.intensity = entry.intensity;
      deferredDressingFade = null;
    };

    const applyRenderQuality = (tier: RenderQualityTier) => {
      if (tier !== renderQualityTier) renderQualityTransitionCount += 1;
      renderQualityTier = tier;
      renderQualityProfile = RENDER_QUALITY_PROFILES[tier];
      const emergencyPolicy = EMERGENCY_RENDER_POLICIES[emergencyDegradation.level];
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
        Math.floor(
          atmosphereParticleCount
          * renderQualityProfile.atmosphericParticleScale
          * emergencyPolicy.atmosphericParticleScale,
        ),
      );
      occlusionRaycastRemaining = Math.min(
        occlusionRaycastRemaining,
        renderQualityProfile.occlusionProbeSeconds,
      );
      applyNonCriticalShadowPolicy();
      if (deferredDressingRoot) {
        deferredDressingRoot.visible = resolveRuntimeObjectPolicy({
          role: "decoration",
          baseVisible: true,
          baseCastShadow: false,
          emergencyLevel: emergencyDegradation.level,
        }).visible;
      }
      document.documentElement.dataset.chasingQuality = tier;
      document.documentElement.dataset.chasingEmergency = String(emergencyDegradation.level);
    };
    applyRenderQuality(renderQualityTier);

    const contactTexture = createContactShadowTexture();
    const campus = new THREE.Group();
    campus.name = "authored-campus";
    scene.add(campus);
    qaAssetFaultInjector.current ??= createQaAssetFaultInjector(location.search);
    const assetFaultInjector = qaAssetFaultInjector.current;
    const sceneAssets = createSceneAssetLoader({
      maximumConcurrentRequests: 3,
      timeoutMilliseconds: assetFaultInjector.plan.timeoutMilliseconds ?? 20_000,
      fetcher: assetFaultInjector.fetcher,
    });
    const controlledDependencyUrls = new Map<string, string>();
    const controlledDependencyLoads = new Map<string, Promise<string>>();
    const loadingManager = new THREE.LoadingManager();
    loadingManager.setURLModifier((url) => (
      controlledDependencyUrls.get(new URL(url, location.href).href) ?? url
    ));
    let dependencyLoadingManagerIdle = true;
    let ktx2Loader: KTX2Loader | null = null;
    let gltfLoaderPromise: Promise<GLTFLoader> | null = null;
    let pendingGlbLoadCount = 0;
    let controlledDependencyResourcesReleased = false;
    const releaseControlledDependencyResources = () => {
      if (controlledDependencyResourcesReleased) return;
      controlledDependencyResourcesReleased = true;
      ktx2Loader?.dispose();
      ktx2Loader = null;
      for (const objectUrl of controlledDependencyUrls.values()) {
        URL.revokeObjectURL(objectUrl);
      }
      controlledDependencyUrls.clear();
      controlledDependencyLoads.clear();
    };
    const releaseControlledDependencyResourcesWhenSettled = () => {
      if (
        disposed
        && pendingGlbLoadCount === 0
        && dependencyLoadingManagerIdle
      ) {
        releaseControlledDependencyResources();
      }
    };
    loadingManager.onStart = () => {
      dependencyLoadingManagerIdle = false;
    };
    loadingManager.onLoad = () => {
      dependencyLoadingManagerIdle = true;
      releaseControlledDependencyResourcesWhenSettled();
    };
    const getGlbLoader = () => {
      if (gltfLoaderPromise) return gltfLoaderPromise;
      gltfLoaderPromise = Promise.resolve()
        .then(() => {
          if (disposed) throw new DOMException("Scene disposed", "AbortError");
          ktx2Loader = new KTX2Loader(loadingManager)
            .setTranscoderPath("/basis/")
            .detectSupport(renderer);
          const gltfLoader = new GLTFLoader(loadingManager);
          gltfLoader.setMeshoptDecoder(MeshoptDecoder);
          gltfLoader.setKTX2Loader(ktx2Loader);
          return gltfLoader;
        })
        .catch((error) => {
          gltfLoaderPromise = null;
          throw error;
        });
      return gltfLoaderPromise;
    };
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
// Only open architecture in the final part of the camera-to-actor ray. A
// constant-width world-space corridor close to the camera projects across most
// of the screen and makes every repeated wall look diagonally shredded.
float cameraOcclusionEnds = smoothstep( 0.76, 0.84, cameraOcclusionAlong )
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
float cameraOcclusionEndsB = smoothstep( 0.76, 0.84, cameraOcclusionAlongB )
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
      if (new URLSearchParams(location.search).has("no-camera-cutout")) return;
      const meshes: THREE.Mesh[] = [];
      for (const root of roots) {
        root.traverse((object) => {
          if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) meshes.push(object);
        });
      }
      if (!meshes.length) return;
      const strength = { value: 0 };
      const baseMaterials = new Map<string, THREE.Material>();
      const cloneBaseMaterial = (material: THREE.Material) => {
        const existing = baseMaterials.get(material.uuid);
        if (existing) return existing;
        const cloned = patchOccludingMaterial(material, strength, "opaque-cutout");
        baseMaterials.set(material.uuid, cloned);
        return cloned;
      };
      const overlays: THREE.Mesh[] = [];
      for (const mesh of meshes) {
        const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.material = Array.isArray(mesh.material)
          ? sourceMaterials.map(cloneBaseMaterial)
          : cloneBaseMaterial(sourceMaterials[0]);
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
      if (!primaryAnchor) {
        for (const occluder of cameraOccluders) {
          occluder.obscured = false;
          occluder.strength.value = smoothOcclusionStrength(
            occluder.strength.value,
            false,
            delta,
          );
          const overlayVisible = occluder.strength.value > 0.002;
          for (const overlay of occluder.overlays) overlay.visible = overlayVisible;
        }
        return;
      }
      cameraOcclusionOrigin.value.copy(camera.position);
      cameraOcclusionTarget.value.copy(primaryAnchor);
      cameraOcclusionTargetB.value.copy(readableAnchors[1] ?? primaryAnchor);
      occlusionRaycastRemaining -= delta;
      if (occlusionRaycastRemaining <= 0) {
        occlusionRaycastRemaining = renderQualityProfile.occlusionProbeSeconds;
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
      const nextHideArchetype = simulation.getActiveHideSpotArchetype()?.archetype ?? null;
      if (playfield) {
        const expectedModeClass = `mode-${state.player.mode}`;
        const expectedHideClass = nextHideArchetype
          ? `hide-${nextHideArchetype}`
          : null;
        const classList = [...playfield.classList];
        const classMismatch = !playfield.classList.contains(expectedModeClass)
          || (expectedHideClass
            ? !playfield.classList.contains(expectedHideClass)
            : classList.some((className) => className.startsWith("hide-")));
        if (classMismatch) {
          for (const className of classList) {
            if (
              className.startsWith("mode-")
              || className.startsWith("hide-")
            ) playfield.classList.remove(className);
          }
          playfield.classList.add(expectedModeClass);
          if (expectedHideClass) playfield.classList.add(expectedHideClass);
        }
        playfield.classList.toggle(
          "locker-interior",
          nextHideArchetype === "hard-locker"
            && [
              "hidden",
              "entering-peek",
              "peeking",
              "exiting-peek",
            ].includes(state.player.mode),
        );
      }
      playfield?.style.setProperty("--locker-cover", mix.cover.toFixed(4));
      playfield?.style.setProperty("--locker-peek", mix.peek.toFixed(4));
      playfield?.style.setProperty(
        "--hard-locker-cover",
        (nextHideArchetype === "hard-locker" ? mix.cover : 0).toFixed(4),
      );
      playfield?.style.setProperty(
        "--hard-locker-peek",
        (nextHideArchetype === "hard-locker" ? mix.peek : 0).toFixed(4),
      );
      if (nextHideArchetype !== renderedHideArchetype) {
        renderedHideArchetype = nextHideArchetype;
        setActiveHideArchetype(nextHideArchetype);
      }
      renderer.toneMappingExposure = atmosphere.exposure
        * lockerObservationExposureMultiplier(mix);
    };

    const updatePhasePresentation = (next: GamePhase) => {
      setPhase(next);
      if (next === "won") {
        if (libraryMissionState && selectedLibraryPlanDefinition) {
          libraryMissionState = stepLibraryBranchingMission(
            LIBRARY_BRANCHING_MISSION,
            libraryMissionState,
            {
              type: "escape",
              exitId: selectedLibraryPlanDefinition.exitId,
            },
          ).state;
          missionState = adaptLibraryMissionToThemeMissionState(
            libraryMissionState,
          );
        }
        const completedSeconds = Math.max(
          0.01,
          Math.round(latestState.elapsedSeconds * 100) / 100,
        );
        const masteryResult = evaluateRunMastery(
          completedSeconds,
          masteryTargetSeconds(
            campaignLevel,
            simulation.config,
            masteryTargetOptions,
          ),
          runTelemetry,
        );
        const previousRunRecord = getCampaignRunRecord(
          campaignProgressRef.current,
          runRecordLevelId,
          preferences.ruleset,
        );
        const bestDelta = personalBestDelta(
          selectedRemixContract
            ? (
                loadCertifiedRemixRecord(
                  localStorage,
                  selectedRemixContract,
                  preferences.ruleset,
                )?.bestSeconds
                ?? previousRunRecord.bestSeconds
              )
            : previousRunRecord.bestSeconds,
          completedSeconds,
        );
        const completedTick = latestState.tick;
        recordPlayerRuleEvent({
          tick: completedTick,
          type: "run-completed",
        });
        const ghost = ghostRecorder.finish(completedTick);
        const ghostSave = ghost && !qaResolutionScenario
          ? savePersonalBestGhost(localStorage, ghost, preferences.ruleset)
          : null;
        if (ghost && ghostSave?.saved) {
          // Keep the newly saved PB in this mounted runtime. The next restart
          // must race the just-finished run, including the first PB of a fresh
          // profile, rather than the recording that existed when the scene
          // effect was originally created.
          ghostRecording = ghost;
        }
        if (selectedRemixContract && !qaResolutionScenario) {
          saveCertifiedRemixRecord(
            localStorage,
            selectedRemixContract,
            preferences.ruleset,
            completedSeconds,
            masteryResult,
          );
        }
        setLastRunSummary({
          ...masteryResult,
          ...bestDelta,
          ...(ghostSave ? { ghostSaveStatus: ghostSave.status } : {}),
        });
        setCampaignProgress((current) => {
          const updated = recordCampaignCompletion(
            current,
            runRecordLevelId,
            completedSeconds,
            masteryResult,
            Math.min(
              CAMPAIGN_LEVELS.length,
              campaignLevel.campaign.levelNumber + 1,
            ),
          );
          if (!qaResolutionScenario) {
            try {
              localStorage.setItem(CAMPAIGN_PROGRESS_KEY, JSON.stringify(updated));
            } catch {
              // Progress still works for this session if persistence is denied.
            }
          }
          return updated;
        });
      }
      if (next === "won" || next === "lost") {
        touchKeys.current.clear();
        interactPressed.current = false;
        portableDecoyPressed.current = false;
        setResultVisible(false);
        if (resultTimer) clearTimeout(resultTimer);
        // Include the face-to-face staging beat, then let the full authored
        // resolution performance read before UI covers the actors.
        resultTimer = setTimeout(() => setResultVisible(true), 1_700);
      }
    };

    const resetPresentation = (state: GameState) => {
      portableDecoyResetCount += 1;
      if (resultTimer) {
        clearTimeout(resultTimer);
        resultTimer = null;
      }
      keyboardKeys.current.clear();
      touchKeys.current.clear();
      interactPressed.current = false;
      portableDecoyPressed.current = false;
      stealthToolPressed.current = false;
      evidenceErasePressed.current = false;
      preferredHideExit.current = "origin";
      resetAnalogueMove();
      lastCheckSpot = null;
      guidedLockerId = null;
      guidedLockerRisk = "medium";
      guidedTargetState = null;
      guidedBreakSight = false;
      playerKnownChaser = null;
      setHideGuideRisk("medium");
      setHideGuideSelection("survivability");
      setHideGuideStrategy("hide");
      runTelemetry = createRunTelemetry({
        levelId: campaignLevel.id,
        theme: campaignLevel.campaign.theme,
        ruleset: preferences.ruleset,
      });
      ghostRecorder = new GhostInputRecorder(
        ghostRunLevelId,
        simulation.config.fixedStepSeconds,
      );
      ghostInputBuffer.reset();
      fixedStepHost = resetFixedStepHost(fixedStepHost, state.tick);
      libraryMissionState = libraryGoldEnabled
        ? stepLibraryBranchingMission(
            LIBRARY_BRANCHING_MISSION,
            createInitialLibraryMissionState(),
            { type: "select-plan", planId: selectedLibraryPlan },
          ).state
        : null;
      missionState = libraryMissionState
        ? adaptLibraryMissionToThemeMissionState(libraryMissionState)
        : createInitialThemeMissionState(missionDefinition);
      missionCommitment = null;
      missionPerformanceObjectiveId = null;
      for (const view of portableDecoyViews.values()) {
        disposePortableDecoyView(view);
      }
      portableDecoyViews.clear();
      portableDecoySourceIds.clear();
      scheduledPortableDecoySourceIds.clear();
      portableDecoyState = libraryGoldEnabled
        ? createPortableDecoyState(LIBRARY_PORTABLE_DECOY_DEFINITION)
        : null;
      portableDecoyThrowRemainingSeconds = 0;
      portableDecoyThrownCount = 0;
      portableDecoyPublicSoundAcceptedCount = 0;
      portableDecoyInvestigationCompletedCount = 0;
      portableDecoyLastLifecycleEvent = null;
      portableDecoyFeedback = libraryGoldEnabled
        ? "F 投掷精装笔记本，制造一次可追查的公开声源"
        : null;
      portableDecoyFeedbackUntilSeconds = libraryGoldEnabled ? 4 : 0;
      pendingRouteSelectionTelemetry = libraryGoldEnabled;
      setPortableDecoy(portableDecoyState
        ? samplePortableDecoy(portableDecoyState, 0)
        : null);
      setPortableDecoyNotice(portableDecoyFeedback);
      stealthEvidenceState = createStealthEvidenceState();
      stealthToolbeltState = createStealthToolbeltState();
      tensionDirectorState =
        createInitialTensionDirectorState(tensionDirectorDefinition);
      directorSafeTicks = 0;
      directorChaseTicks = 0;
      directorTicksSinceChaseEscape = null;
      directorWasChased = false;
      lastStealthAuxiliaryTick = 0;
      lastFootprintTick = Number.NEGATIVE_INFINITY;
      lastFootprintPosition = { ...state.player.position };
      stealthNotice = STEALTH_TOOL_UI[selectedStealthToolRef.current].hint;
      stealthNoticeUntilTick = 240;
      mirrorThreatVisible = false;
      deliveredEvidenceIds.clear();
      investigatedEvidenceIds.clear();
      triggeredDoorWedges.clear();
      activeWedgeHoldUntilTick = 0;
      for (const view of [...stealthEvidenceViews.values()]) {
        disposeStealthEvidenceView(view);
      }
      for (const view of [...stealthToolWorldViews.values()]) {
        disposeStealthToolWorldView(view);
      }
      setStealthSystems({
        toolbelt: sampleStealthToolbelt(stealthToolbeltState),
        selectedTool: selectedStealthToolRef.current,
        evidenceCount: 0,
        countermeasureBudget: stealthEvidenceState.countermeasureBudgetRemaining,
        countermeasureBusy: false,
        notice: stealthNotice,
        mirrorThreatVisible: false,
      });
      setTensionDirector({
        tier: "rest",
        score: 0,
        phase: "idle",
        kind: null,
        label: "公平节奏导演待机",
        progress: 0,
      });
      playerRuleProgressTracker = new GhostRuleProgressTracker(
        missionObjectiveIds,
      );
      playerRuleProgress = playerRuleProgressTracker.update({
        tick: 0,
        routeProgress: 0,
      });
      pendingPlayerRuleEvents = [];
      ghostRuleEventCursor = 0;
      ghostRuleProgressTracker = ghostRecording?.ruleEvents?.length
        ? new GhostRuleProgressTracker(missionObjectiveIds)
        : null;
      ghostRuleProgress = ghostRuleProgressTracker?.update({
        tick: 0,
        routeProgress: 0,
      }) ?? null;
      setThemeMission({
        state: missionState,
        activeObjective: runtimeMissionObjectives[0] ?? null,
        activeDistanceMeters: runtimeMissionObjectives[0]
          ? Math.round(
              distanceBetween(
                state.player.position,
                missionPlacementById.get(runtimeMissionObjectives[0].id)
                  ?? campaignLevel.exit,
              ) * CELL,
            )
          : null,
        commitmentProgress: null,
        commitmentRemainingSeconds: null,
        canInteract: false,
        completedCount: 0,
        totalCount: runtimeMissionObjectives.length,
      });
      if (ghostRecording) {
        ghostSimulation = new GameSimulation({
          level: campaignLevel,
          autoStart: true,
          config: {
            ...gameplayConfig,
            spawnDelaySeconds: 999,
          },
        });
        ghostState = ghostSimulation.getState();
        ghostCursor = new GhostReplayCursor(ghostRecording);
        ghostAccumulatorSeconds = 0;
        ghostRaceTracker = new GhostRaceTracker(
          ghostRecording,
          initialExitRouteDistanceMeters,
        );
        latestGhostRace = null;
        setGhostRace(null);
      }
      mechanicInstance = createMechanicInstance(mechanicDefinition);
      if (mechanicView) {
        updateThemeMechanicView(
          mechanicView,
          sampleMechanicInstance(mechanicInstance, state.player.position),
          performance.now(),
        );
      }
      playerKnowledge = createPlayerKnowledge();
      setPublicThreat("calm");
      setThemeMechanic(null);
      objectiveGuidanceState = createObjectiveGuidanceState();
      lastObjectiveGuidanceSeconds = state.elapsedSeconds;
      setLastRunSummary(null);
      setObjectiveTurnHint(null);
      lastScoreThreat = Number.NaN;
      captureStageRemaining = 0;
      capturePerformanceStarted = false;
      lastHudUpdate = 0;
      cameraZoom.value = 1;
      lockerCameraBlend = 0;
      camera.fov = 56;
      camera.updateProjectionMatrix();
      setResultVisible(false);
      setPhase(state.phase);
      setPlayerMode(state.player.mode);
      setChaserMode(state.chaser.mode);
      setChaserConfirming(state.chaser.visualConfirmationSeconds !== null);
      setChaserObservable(canPlayerObserveChaser(state, campaignLevel, simulation.config));
      setChaserArchetypeRuntime(simulation.getChaserArchetypeRuntime());
      setElapsed(Math.floor(state.elapsedSeconds));
      setLastCaptureReason(state.captureReason);
      setObjectiveDistance(objectiveDistanceMeters(state.player.position, campaignLevel, objectivePaths));
      setHideDistance(nearestHideDistanceMeters(state.player.position, campaignLevel, objectivePaths));
      setInteraction(simulation.getHideInteraction());
      renderedHideArchetype = simulation.getActiveHideSpotArchetype()?.archetype ?? null;
      setActiveHideArchetype(renderedHideArchetype);
      setHideExitSelection(simulation.getHideExitSelection());
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
      resetActor(ghostActor ?? undefined, campaignLevel.playerStart, { x: 0, y: 1 });
      if (ghostActor) {
        ghostActor.root.visible = Boolean(ghostRecording);
        ghostActor.visibilityAlpha = ghostRecording ? 0.58 : 0;
      }

      cameraFocus.copy(world(state.player.position, campaignLevel)).add(new THREE.Vector3(0, 0.92, 0));
      cameraFollowState = createFixedCameraFollowState(cameraFocus);
      cameraDirection.copy(createFixedCameraDirection());
      cameraDistance = baseCameraDistanceForAspect(camera.aspect);
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
        locker.root.position.copy(locker.basePosition);
        locker.root.rotation.set(0, locker.baseRotationY, 0);
        locker.root.scale.copy(locker.baseScale);
        locker.beacon.visible = false;
        locker.beaconLight.intensity = 0;
        locker.root.getObjectByName("DoorPivot")?.quaternion.identity();
      }
    };

    const hasPlayerActionCommitment = () => Boolean(
      missionCommitment
      || mechanicRequiresMovementCommitment(mechanicInstance)
      || portableDecoyThrowRemainingSeconds > 0
      || stealthToolbeltState.commitment
      || stealthEvidenceState.tick
        < stealthEvidenceState.countermeasureBusyUntilTick
    );

    const attemptPortableDecoyDeployment = (
      presentationEffects: Array<() => void>,
    ) => {
      if (
        !portableDecoyState
        || !portableDecoyTemplate
        || latestState.phase !== "playing"
        || latestState.player.mode !== "free"
        || hasPlayerActionCommitment()
      ) return false;
      const headingLength = Math.hypot(
        latestState.player.heading.x,
        latestState.player.heading.y,
      );
      const baseHeading = headingLength > 1e-6
        ? {
            x: latestState.player.heading.x / headingLength,
            y: latestState.player.heading.y / headingLength,
          }
        : { x: 0, y: 1 };
      const candidateAngles = [0, Math.PI / 7, -Math.PI / 7];
      const candidateDistances = [4, 3, 2, 1] as const;
      const attempted = new Set<string>();
      let accepted: ReturnType<typeof deployPortableDecoy> | null = null;
      for (const distance of candidateDistances) {
        for (const angle of candidateAngles) {
          const cosine = Math.cos(angle);
          const sine = Math.sin(angle);
          const direction = {
            x: baseHeading.x * cosine - baseHeading.y * sine,
            y: baseHeading.x * sine + baseHeading.y * cosine,
          };
          const landing = {
            x: Math.round(latestState.player.position.x + direction.x * distance),
            y: Math.round(latestState.player.position.y + direction.y * distance),
          };
          const key = `${landing.x},${landing.y}`;
          if (attempted.has(key)) continue;
          attempted.add(key);
          const result = deployPortableDecoy(
            portableDecoyState,
            campaignLevel,
            {
              nowSeconds: Math.max(
                latestState.elapsedSeconds,
                portableDecoyState.updatedAtSeconds,
              ),
              actorPosition: latestState.player.position,
              landingPosition: landing,
            },
          );
          if (!result.accepted) continue;
          accepted = result;
          break;
        }
        if (accepted) break;
      }
      if (!accepted?.state.activeDeployment) {
        portableDecoyFeedback = portableDecoyState.activeDeployment
          ? "上一枚诱饵仍在引导调查"
          : portableDecoyState.inventoryRemaining <= 0
            ? "本局精装笔记本已经用完"
            : "前方没有无遮挡落点；转向开阔走廊后再投掷";
        portableDecoyFeedbackUntilSeconds = latestState.elapsedSeconds + 2.4;
        const notice = portableDecoyFeedback;
        presentationEffects.push(() => setPortableDecoyNotice(notice));
        return false;
      }
      const deployment = accepted.state.activeDeployment;
      if (!deployment) return false;
      const soundScheduled = simulation.scheduleWorldSound(
        portableDecoySoundStimulus(
          LIBRARY_PORTABLE_DECOY_DEFINITION,
          deployment,
        ),
        deployment.soundAtSeconds,
      );
      if (!soundScheduled) {
        portableDecoyFeedback = "当前声场过于拥挤；诱饵没有消耗，请稍后重试";
        portableDecoyFeedbackUntilSeconds = latestState.elapsedSeconds + 2.4;
        const notice = portableDecoyFeedback;
        presentationEffects.push(() => setPortableDecoyNotice(notice));
        return false;
      }
      portableDecoyState = accepted.state;
      portableDecoySourceIds.add(deployment.sourceId);
      scheduledPortableDecoySourceIds.add(deployment.sourceId);
      portableDecoyThrowRemainingSeconds =
        LIBRARY_PORTABLE_DECOY_DEFINITION.fuseSeconds;
      portableDecoyThrownCount += 1;
      portableDecoyPublicSoundAcceptedCount += 1;
      portableDecoyLastLifecycleEvent = "thrown-and-scheduled";
      recordPlayerRuleEvent({
        tick: latestState.tick,
        type: "portable-decoy-thrown",
        deploymentId: deployment.deploymentId,
        sourceId: deployment.sourceId,
        landing: deployment.position,
      });
      portableDecoyFeedback = `诱饵已投出 · 剩余 ${portableDecoyState.inventoryRemaining}`;
      portableDecoyFeedbackUntilSeconds = latestState.elapsedSeconds + 2.1;
      const portableDecoySample = samplePortableDecoy(
        portableDecoyState,
        portableDecoyState.updatedAtSeconds,
      );
      const notice = portableDecoyFeedback;
      presentationEffects.push(() => {
        createPortableDecoyView(deployment);
        setPortableDecoy(portableDecoySample);
        setPortableDecoyNotice(notice);
        playHapticCue(
          "theme-warning",
          preferencesRef.current.hapticsEnabled,
          navigator.vibrate?.bind(navigator),
        );
      });
      return true;
    };

    const applyStealthEvidenceCommand = (
      command: unknown,
      emitCountermeasureNoise = true,
    ) => {
      const step = stepStealthEvidence(stealthEvidenceState, command);
      stealthEvidenceState = step.state;
      for (const event of step.events) {
        if (event.type === "evidence-recorded" || event.type === "evidence-forged") {
          createStealthEvidenceView(event.evidence);
        } else if (
          event.type === "evidence-erased"
          || event.type === "evidence-expired"
          || event.type === "evidence-evicted"
          || event.type === "evidence-superseded"
        ) {
          const view = stealthEvidenceViews.get(event.evidenceId);
          if (view) disposeStealthEvidenceView(view);
          deliveredEvidenceIds.delete(event.evidenceId);
          investigatedEvidenceIds.delete(event.evidenceId);
        } else if (
          event.type === "countermeasure-cost-paid"
          && emitCountermeasureNoise
          && event.publicNoiseStrength > 0
        ) {
          simulation.emitWorldSound({
            position: { ...latestState.player.position },
            strength: event.publicNoiseStrength,
            sourceType: "player-movement",
            sourceId: `${campaignLevel.id}:countermeasure:${latestState.tick}`,
            confidence: 0.7,
            decayPerSecond: 0.22,
          });
        }
      }
      if (step.events.length > 0) {
        const evidenceCount = step.state.records.length;
        const countermeasureBudget =
          step.state.countermeasureBudgetRemaining;
        const runtimePlayfield = host.parentElement;
        runtimePlayfield?.querySelectorAll<HTMLElement>(
          "[data-stealth-evidence-summary]",
        ).forEach((element) => {
          element.textContent =
            element.dataset.stealthEvidenceSummary === "compact"
              ? `线索 ${evidenceCount} · 反侦察 ${countermeasureBudget}`
              : `TACTICAL STEALTH · 线索 ${evidenceCount} · 反侦察 ${
                  countermeasureBudget
                }`;
        });
        setStealthSystems((current) => current
          ? {
              ...current,
              evidenceCount,
              countermeasureBudget,
              countermeasureBusy:
                step.state.tick < step.state.countermeasureBusyUntilTick,
            }
          : current);
      }
      return step;
    };

    const publishStealthNotice = (
      message: string,
      durationTicks: number,
    ) => {
      stealthNotice = message;
      stealthNoticeUntilTick = latestState.tick + durationTicks;
      const runtimePlayfield = host.parentElement;
      runtimePlayfield?.querySelectorAll<HTMLElement>(
        "[data-stealth-runtime-message], [data-stealth-mobile-message]",
      ).forEach((element) => {
        element.textContent = message;
      });
      setStealthSystems((current) => current
        ? { ...current, notice: message }
        : current);
    };

    const qaStealthToolPlacementAnchor = (tool: StealthToolKind) => {
      const preferred = campaignLevel.hideSpots[0]?.approach
        ?? campaignLevel.playerStart;
      const candidates: Point[] = [];
      for (let y = 0; y < campaignLevel.height; y += 1) {
        for (let x = 0; x < campaignLevel.width; x += 1) {
          if (!campaignLevel.walkable[y]?.[x]) continue;
          candidates.push({ x, y });
        }
      }
      candidates.sort((left, right) => (
        distanceBetween(left, preferred) - distanceBetween(right, preferred)
        || left.y - right.y
        || left.x - right.x
      ));
      if (tool === "temporary-blackout") {
        const player = { ...mechanicPosition };
        return Object.freeze({
          player: Object.freeze(player),
          target: resolveStealthToolTarget(
            tool,
            campaignLevel,
            player,
            { x: 0, y: 1 },
            mechanicPosition,
          ),
        });
      }
      for (const player of candidates) {
        const target = resolveStealthToolTarget(
          tool,
          campaignLevel,
          player,
          { x: 0, y: 1 },
          mechanicPosition,
        );
        if (!target) continue;
        return Object.freeze({
          player: Object.freeze({ ...player }),
          target,
        });
      }
      return null;
    };
    const qaStealthToolPlacementAnchors = Object.freeze({
      "door-wedge": qaStealthToolPlacementAnchor("door-wedge"),
      "corner-mirror": qaStealthToolPlacementAnchor("corner-mirror"),
      "temporary-blackout": qaStealthToolPlacementAnchor(
        "temporary-blackout",
      ),
    });

    const attemptStealthToolUse = () => {
      const selected = selectedStealthToolRef.current;
      if (
        latestState.phase !== "playing"
        || latestState.player.mode !== "free"
        || hasPlayerActionCommitment()
      ) {
        publishStealthNotice("先完成当前动作，再使用潜行工具", 150);
        return false;
      }
      const target = resolveStealthToolTarget(
        selected,
        campaignLevel,
        latestState.player.position,
        latestState.player.heading,
        mechanicPosition,
      );
      if (!target) {
        const message = selected === "corner-mirror"
          ? "靠近有遮挡的拐角后再架镜"
          : selected === "temporary-blackout"
            ? "靠近带闪电标识的配电控制台后再切断照明"
            : "靠近窄门或墙边阈值后再放置门楔";
        publishStealthNotice(message, 180);
        return false;
      }
      const result = beginStealthToolUse(
        stealthToolbeltState,
        campaignLevel,
        {
          tick: stealthToolbeltState.tick,
          tool: selected,
          actorPosition: latestState.player.position,
          target,
        },
      );
      if (!result.accepted) {
        const rejectionCopy: Partial<Record<NonNullable<typeof result.rejection>, string>> = {
          "inventory-empty": "本局库存已用完",
          "cooldown-active": "工具正在冷却",
          "effect-active": "该工具效果仍在生效",
          "out-of-range": selected === "temporary-blackout"
            ? "需要到主题控制台旁操作断电"
            : "目标距离过远",
          "interaction-blocked": "目标被实体遮挡",
          "commitment-active": "上一项工具动作尚未完成",
        };
        const message = result.rejection
          ? rejectionCopy[result.rejection] ?? "当前无法安全使用该工具"
          : "当前无法安全使用该工具";
        publishStealthNotice(message, 180);
        return false;
      }
      stealthToolbeltState = result.state;
      const seconds = (
        result.state.commitment
          ? result.state.commitment.completesAtTick - result.state.tick
          : 0
      ) * simulation.config.fixedStepSeconds;
      publishStealthNotice(
        `${STEALTH_TOOL_UI[selected].label}部署中 · ${seconds.toFixed(1)}s`,
        180,
      );
      playHapticCue(
        "theme-warning",
        preferencesRef.current.hapticsEnabled,
        navigator.vibrate?.bind(navigator),
      );
      return true;
    };

    const attemptEvidenceErase = () => {
      if (
        latestState.player.mode !== "free"
        || hasPlayerActionCommitment()
      ) {
        publishStealthNotice("先结束当前动作，再处理地面线索", 150);
        return false;
      }
      const nearest = stealthEvidenceState.records
        .filter((record) => record.source.publicity === "world-observable")
        .map((record) => ({
          record,
          distance: distanceBetween(record.position, latestState.player.position),
        }))
        .filter(({ distance }) => distance <= 1.35)
        .sort((left, right) => left.distance - right.distance)[0]?.record;
      if (!nearest) {
        publishStealthNotice("附近没有可抹除的公开痕迹", 150);
        return false;
      }
      const step = applyStealthEvidenceCommand({
        type: "erase",
        tick: stealthEvidenceState.tick,
        evidenceId: nearest.id,
      });
      if (!step.accepted) {
        const message = step.rejection === "insufficient-countermeasure-budget"
          ? "反侦察资源不足"
          : step.rejection === "countermeasure-busy"
            ? "反侦察动作尚未完成"
            : "这条公开线索无法被抹除";
        publishStealthNotice(message, 180);
        return false;
      }
      publishStealthNotice(
        `已抹除${nearest.kind === "footprint" ? "足迹" : "环境痕迹"} · 资源 ${
          stealthEvidenceState.countermeasureBudgetRemaining
        }`,
        180,
      );
      soundscape.triggerWorldSound({
        listenerPosition: latestState.player.position,
        sourcePosition: latestState.player.position,
        kind: "theme-event",
        maxDistance: 5,
        baseGain: 0.13,
        occlusion: 0,
        foleySet: "cloth",
        playbackRate: 1.16,
      });
      return true;
    };

    const canRuntimeObserveChaser = (state: GameState) => {
      if (canPlayerObserveChaser(state, campaignLevel, simulation.config)) return true;
      const mirrorReceipt = stealthToolbeltState.activeEffects["corner-mirror"]
        ?.receipt;
      return Boolean(
        mirrorReceipt?.tool === "corner-mirror"
        && canCornerMirrorObservePoint(
          mirrorReceipt,
          state.chaser.position,
          campaignLevel,
        ),
      );
    };

    const setPauseState = (nextPaused: boolean) => {
      if (nextPaused === pausedRef.current) return;
      pausedRef.current = nextPaused;
      setPaused(nextPaused);
      keyboardKeys.current.clear();
      touchKeys.current.clear();
      interactPressed.current = false;
      portableDecoyPressed.current = false;
      stealthToolPressed.current = false;
      evidenceErasePressed.current = false;
      fixedStepHost = resetFixedStepHost(
        fixedStepHost,
        latestState.tick,
      );
      resetAnalogueMove();
      last = performance.now();
      score.setThreat(nextPaused ? 0 : threatForMode(latestState.chaser.mode));
      lastScoreThreat = nextPaused ? 0 : threatForMode(latestState.chaser.mode);
    };

    const beginGame = () => {
      if (!ready) return;
      setPauseState(false);
      latestState = simulation.start();
      soundscape.setThemeMechanicActivity(0);
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
      deployDecoy() {
        if (!ready || latestState.phase !== "playing") return;
        void score.unlock();
        void soundscape.unlock();
        portableDecoyPressed.current = true;
      },
      selectStealthTool(tool) {
        selectedStealthToolRef.current = tool;
        setSelectedStealthTool(tool);
        setStealthSystems((current) => current
          ? { ...current, selectedTool: tool, notice: STEALTH_TOOL_UI[tool].hint }
          : current);
      },
      useStealthTool() {
        if (!ready || latestState.phase !== "playing") return;
        void score.unlock();
        void soundscape.unlock();
        stealthToolPressed.current = true;
      },
      eraseEvidence() {
        if (!ready || latestState.phase !== "playing") return;
        evidenceErasePressed.current = true;
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
      togglePause() {
        if (!ready || latestState.phase !== "playing") return;
        setPauseState(!pausedRef.current);
      },
      adjustZoom(factor) {
        cameraZoom.value = THREE.MathUtils.clamp(cameraZoom.value * factor, 0.72, 1.65);
      },
      resetZoom() {
        cameraZoom.value = 1;
      },
    };

    const fetchControlledDependency = (dependencyUrl: URL): Promise<string> => {
      const key = dependencyUrl.href;
      const existingUrl = controlledDependencyUrls.get(key);
      if (existingUrl) return Promise.resolve(existingUrl);
      const existingLoad = controlledDependencyLoads.get(key);
      if (existingLoad) return existingLoad;
      const load = sceneAssets.fetchArrayBuffer(dependencyUrl, {
        requestInit: { cache: "force-cache" },
      }).then((dependencyBytes) => {
        if (disposed) throw new DOMException("Scene disposed", "AbortError");
        loadedTransferBytes.set(key, dependencyBytes.byteLength);
        const extension = dependencyUrl.pathname.split(".").pop()?.toLowerCase();
        const mimeType = extension === "ktx2"
          ? "image/ktx2"
          : extension === "png"
            ? "image/png"
            : extension === "webp"
              ? "image/webp"
              : "application/octet-stream";
        const objectUrl = URL.createObjectURL(new Blob([dependencyBytes], { type: mimeType }));
        controlledDependencyUrls.set(key, objectUrl);
        return objectUrl;
      }).catch((error) => {
        controlledDependencyLoads.delete(key);
        throw error;
      });
      controlledDependencyLoads.set(key, load);
      return load;
    };

    const loadGlbWithRetry = async (
      url: string,
      options: { captureQaIdentity?: boolean } = {},
    ) => {
      if (disposed) throw new DOMException("Scene disposed", "AbortError");
      pendingGlbLoadCount += 1;
      try {
        const absoluteUrl = new URL(url, location.href);
        const parser = getGlbLoader();
        const bytes = await sceneAssets.fetchArrayBuffer(absoluteUrl, {
          requestInit: { cache: "force-cache" },
        });
        loadedTransferBytes.set(absoluteUrl.href, bytes.byteLength);
        const assetBaseUrl = new URL(".", absoluteUrl);
        const dependencies = externalAssetUrisFromGlb(bytes)
          .map((dependency) => new URL(dependency, assetBaseUrl));
        await Promise.all(
          dependencies.map(fetchControlledDependency),
        );
        assetDependencyUrls.set(
          absoluteUrl.href,
          Object.freeze(dependencies.map((dependency) => dependency.href)),
        );
        const loader = await parser;
        const asset = await loader.parseAsync(bytes, assetBaseUrl.href);
        if (options.captureQaIdentity) {
          qaLoadedGlbIdentities.set(
            asset.scene,
            inspectQaLoadedGlbIdentity(
              asset,
              url,
              absoluteUrl.href,
              bytes.byteLength,
              await sha256Hex(bytes),
            ),
          );
        }
        if (disposed) {
          disposeObjectResources([asset.scene]);
          throw new DOMException("Scene disposed", "AbortError");
        }
        loadedAssetRoots.add(asset.scene);
        return asset;
      } finally {
        pendingGlbLoadCount = Math.max(0, pendingGlbLoadCount - 1);
        releaseControlledDependencyResourcesWhenSettled();
      }
    };
    const registerFirstPlayableAsset = (
      id: string,
      url: string,
      category: FirstPlayableAssetCategory,
    ) => {
      const absolute = new URL(url, location.href).href;
      const urls = [absolute, ...(assetDependencyUrls.get(absolute) ?? [])];
      urls.forEach((entryUrl, index) => {
        firstPlayableManifest.push({
          id: index === 0 ? id : `${id}:dependency:${index}`,
          url: entryUrl,
          transferBytes: loadedTransferBytes.get(entryUrl) ?? 0,
          phase: "first-playable",
          category,
        });
      });
    };

    const loadAll = async () => {
      let done = 0;
      const essentialDetailNames = new Set<DetailAssetName>(["locker"]);
      if (libraryGoldEnabled) essentialDetailNames.add("books");
      const requiredDetailNames = new Set<DetailAssetName>(["locker", "ceilingLight"]);
      for (const [name] of THEME_SHARED_PROPS[campaignLevel.campaign.theme]) requiredDetailNames.add(name);
      for (const placement of PROP_SET_STANDALONE_PROPS[campaignLevel.campaign.atmosphere.propSet] ?? []) {
        requiredDetailNames.add(placement.asset);
      }
      for (let index = 0; index < (campaignLevel.movementBlockers?.length ?? 0); index += 1) {
        const contract = MOVEMENT_PROP_CONTRACT[index];
        if (!contract) throw new Error(`${campaignLevel.id} 缺少第 ${index + 1} 个实体障碍美术契约`);
        requiredDetailNames.add(contract[0]);
        essentialDetailNames.add(contract[0]);
      }
      const structureEntries = Object.entries(STRUCTURE_ASSETS) as [StructureAssetName, string][];
      const essentialDetailEntries = [...essentialDetailNames]
        .map((name) => [name, DETAIL_ASSETS[name]] as const);
      const decorativeDetailEntries = [...requiredDetailNames]
        .filter((name) => !essentialDetailNames.has(name))
        .map((name) => [name, DETAIL_ASSETS[name]] as const);
      const essentialActorEntries = (Object.entries(ACTOR_SPECS) as [ActorName, (typeof ACTOR_SPECS)[ActorName]][])
        .filter(([name]) => name !== "police");
      if (campaignLevel.campaign.levelNumber === 1) {
        const expectedBlockingUrls = [...new Set(
          Object.values(FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS),
        )].sort();
        const actualBlockingUrls = [...new Set([
          ...essentialActorEntries.map(([, spec]) => (
            "bootstrapUrl" in spec ? spec.bootstrapUrl : spec.url
          )),
          THEME_KIT_ASSETS[campaignLevel.campaign.theme],
          STEALTH_CORNER_MIRROR_ASSET,
          ...structureEntries.map(([, url]) => url),
          ...essentialDetailEntries.map(([, url]) => url),
        ])].sort();
        if (
          expectedBlockingUrls.length !== actualBlockingUrls.length
          || expectedBlockingUrls.some((url, index) => url !== actualBlockingUrls[index])
        ) {
          throw new Error(
            "首关阻塞素材与服务端预载预算不一致；请同步 FIRST_CAMPAIGN_BLOCKING_MODEL_HREFS",
          );
        }
      }
      const total = BOOTSTRAP_ASSET_COUNT + structureEntries.length + essentialDetailEntries.length;
      const mark = (message: string) => {
        done += 1;
        if (!disposed) setLoadProgress({ done, total, message: `正在载入首局所需素材：${message} ${done}/${total}` });
      };
      const actorAssets: Partial<Record<ActorName, GLTF>> = {};
      const structureAssets: Partial<Record<StructureAssetName, GLTF>> = {};
      const detailAssets: Partial<Record<DetailAssetName, GLTF>> = {};
      const loadedAssets: LoadedAsset[] = [];
      let themeKitAsset: GLTF | undefined;
      let cornerMirrorAsset: GLTF | undefined;
      if (!disposed) {
        setLoadProgress({
          done,
          total,
          message: `正在并行载入主角、追捕者与${campaignLevel.campaign.themeLabel}主题场景…`,
        });
      }

      // Only assets that affect navigation, hiding or the immediate chase gate
      // control. Pure dressing starts after ready so slow texture downloads can
      // never postpone the first playable frame.
      const initialLoads = [
        ...essentialActorEntries.map(async ([name, spec]) => {
          const defaultUrl = "bootstrapUrl" in spec ? spec.bootstrapUrl : spec.url;
          const bootstrapUrl = name === "kid" ? qaKidAssetUrl : defaultUrl;
          const asset = await loadGlbWithRetry(bootstrapUrl, {
            captureQaIdentity: qaSearchParams.has("qa") && name === "kid",
          });
          actorAssets[name] = asset;
          if (name === "kid") {
            qaLoadedKidAssetIdentity = qaLoadedGlbIdentities.get(asset.scene) ?? null;
          }
          const id = `actor:${name}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          registerFirstPlayableAsset(
            id,
            bootstrapUrl,
            name === "kid" ? "player" : "threat",
          );
          mark(name === "kid" ? "主角动作集" : "追捕者动作集");
        }),
        (async () => {
          const themeUrl = THEME_KIT_ASSETS[campaignLevel.campaign.theme];
          const asset = await loadGlbWithRetry(themeUrl);
          themeKitAsset = asset;
          const id = `theme:${campaignLevel.campaign.theme}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          registerFirstPlayableAsset(id, themeUrl, "theme");
          mark(`${campaignLevel.campaign.themeLabel}高精度主题模型`);
        })(),
        (async () => {
          const asset = await loadGlbWithRetry(STEALTH_CORNER_MIRROR_ASSET);
          cornerMirrorAsset = asset;
          const id = "stealth:corner-mirrors";
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          registerFirstPlayableAsset(
            id,
            STEALTH_CORNER_MIRROR_ASSET,
            "theme",
          );
          mark("四主题墙角凸面观察镜");
        })(),
        ...structureEntries.map(async ([name, url]) => {
          const asset = await loadGlbWithRetry(url);
          structureAssets[name] = asset;
          const id = `structure:${name}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          registerFirstPlayableAsset(id, url, name === "exit" ? "navigation" : "shell");
          mark(name === "frontGate" ? "入口建筑模型" : "出口建筑模型");
        }),
        ...essentialDetailEntries.map(async ([name, url]) => {
          const asset = await loadGlbWithRetry(url);
          detailAssets[name] = asset;
          const id = `detail:${name}`;
          loadedAssets.push({ id, asset });
          loadedAssetIds.add(id);
          registerFirstPlayableAsset(
            id,
            url,
            name === "locker" ? "hide-spot" : "navigation",
          );
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
      if (!cornerMirrorAsset) throw new Error("四主题墙角观察镜模型未载入");
      latestFirstPlayableAudit = auditFirstPlayableAssetBudget(firstPlayableManifest);

      configureAssetTextures(loadedAssets, renderer);
      textureDeduplication = deduplicateAssetTextures(loadedAssets);
      buildCampus(structureAssets, themeKitAsset, campus);
      buildPerformanceLighting();
      buildThemeMechanicView(themeKitAsset, cornerMirrorAsset);
      // The formal mirror kit is converted into the active theme's authored
      // corner-mirror template and prewarmed before play. Register the loaded
      // source itself so provenance distinguishes it from transient receipts.
      placedAssetIds.add("stealth:corner-mirrors");
      buildThemeMissionViews(themeKitAsset);
      if (libraryGoldEnabled) {
        const booksAsset = detailAssets.books;
        if (!booksAsset) throw new Error("图书楼可携式诱饵的正式 books.glb 未载入");
        buildPortableDecoyTemplate(booksAsset);
      }
      buildDetails(detailAssets, themeKitAsset, campus, lockers, "essential");
      placeActors(actorAssets, actors, scene, ["kid", "villain"]);
      placePersonalGhost(actorAssets.kid, scene);

      let policeLoadPromise: Promise<void> | null = null;
      let policeRetryAfterMilliseconds = 0;
      requestPoliceAsset = () => {
        if (disposed || actors.police) return Promise.resolve();
        if (policeLoadPromise) return policeLoadPromise;
        if (performance.now() < policeRetryAfterMilliseconds) return Promise.resolve();
        policeLoadPromise = (async () => {
          try {
            const policeAsset = await loadGlbWithRetry(qaPoliceAssetUrl, {
              captureQaIdentity: qaSearchParams.has("qa"),
            });
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
            qaLoadedPoliceAssetIdentity = qaLoadedGlbIdentities.get(policeAsset.scene) ?? null;
            if (latestState.phase === "won" && actors.police) {
              requestAnimation(
                actors.police,
                preferencesRef.current.reducedMotion ? "idle" : "protect",
                { fade: 0.08 },
              );
            }
          } catch (error) {
            policeRetryAfterMilliseconds = performance.now() + 5_000;
            console.warn("Exit resolution actor is unavailable; the kid celebration remains active", error);
          } finally {
            policeLoadPromise = null;
          }
        })();
        return policeLoadPromise;
      };

      ready = true;
      setLoading(false);
      setLoadError("");
      document.documentElement.dataset.chasingReady = "true";
      scheduleEnvironmentLighting();
      startScorePrewarm();
      if (new URLSearchParams(location.search).get("autostart") === "1") beginGame();

      // Load and build non-collision dressing only after control is available.
      // The complete group is attached at opacity zero, then eased in together,
      // avoiding one-prop-at-a-time visual popping on slow connections.
      void (async () => {
        if (!decorativeDetailEntries.length) {
          decorativeAssetsReady = true;
          return;
        }
        const idleWindow = window as Window & {
          requestIdleCallback?: (
            callback: () => void,
            options?: { timeout: number },
          ) => number;
        };
        await new Promise<void>((resolve) => {
          if (idleWindow.requestIdleCallback) {
            idleWindow.requestIdleCallback(resolve, { timeout: 700 });
          } else {
            setTimeout(resolve, 0);
          }
        });
        const settledDecorations = await Promise.allSettled(
          decorativeDetailEntries.map(async ([name, url]) => ({
            name,
            asset: await loadGlbWithRetry(url),
          })),
        );
        const loadedDecorations = settledDecorations
          .filter((result): result is PromiseFulfilledResult<{
            name: DetailAssetName;
            asset: GLTF;
          }> => result.status === "fulfilled")
          .map(({ value }) => value);
        const decorationFailures = settledDecorations.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (disposed) {
          disposeObjectResources(loadedDecorations.map(({ asset }) => asset.scene));
          return;
        }
        for (const failure of decorationFailures) {
          console.warn("One optional scene dressing asset is unavailable; keeping successful decorations", failure.reason);
        }
        if (!loadedDecorations.length) {
          decorativeAssetsReady = true;
          return;
        }
        const deferredDressing = new THREE.Group();
        deferredDressing.name = `${campaignLevel.id}-deferred-dressing`;
        deferredDressingRoot = deferredDressing;
        const deferredAssets = loadedDecorations.map(({ name, asset }) => ({
          id: `detail:${name}`,
          asset,
        }));
        try {
          for (const { name, asset } of loadedDecorations) {
            detailAssets[name] = asset;
          }
          configureAssetTextures(deferredAssets, renderer);
          textureDeduplication = deduplicateAssetTextures([...loadedAssets, ...deferredAssets]);
          buildDetails(
            detailAssets,
            themeKitAsset,
            deferredDressing,
            lockers,
            "decorative",
          );
          registerNonCriticalShadowCasters(deferredDressing);
          startDeferredDressingFade(deferredDressing);
          campus.add(deferredDressing);
          applyRenderQuality(renderQualityTier);
          loadedAssets.push(...deferredAssets);
          for (const { id } of deferredAssets) loadedAssetIds.add(id);
          decorativeAssetsReady = true;
        } catch (error) {
          deferredDressingRoot = null;
          for (const { name } of loadedDecorations) delete detailAssets[name];
          // Dedupe runs before assembly so optional props share the already
          // playable scene's canonical textures. A failed optional build must
          // dispose its geometry/materials without invalidating those shared
          // texture objects underneath the live essential scene.
          const playableTextures = collectObjectTextures(
            loadedAssets.map(({ asset }) => asset.scene),
          );
          disposeObjectResources(
            [deferredDressing, ...loadedDecorations.map(({ asset }) => asset.scene)],
            playableTextures,
          );
          decorativeAssetsReady = true;
          console.warn("Optional scene dressing failed to assemble; gameplay remains available", error);
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
      const groundMarginCells = libraryGoldEnabled ? 3 : 2;
      const entranceDirection = nearestExteriorDirection(campaignLevel.playerStart, campaignLevel);
      const exitDirection = nearestExteriorDirection(campaignLevel.exit, campaignLevel);
      const exitDoorwayAnchors = libraryGoldEnabled
        ? LIBRARY_BRANCHING_MISSION_TOPOLOGY.exitPlacements.map((placement) => ({
            point: placement.position,
            outward: nearestExteriorDirection(placement.position, campaignLevel),
          }))
        : [{ point: campaignLevel.exit, outward: exitDirection }];
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
              || exitDoorwayAnchors.some(({ point, outward }) => (
                isAnchorEdge(x, y, edge.dx, edge.dy, point, outward)
              ))
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
      // Campus modules include showcase glass intended for isolated hero
      // displays. Repeating those alpha-blended panes across a dense maze
      // produces severe overlap moiré from an elevated camera, so the runtime
      // wall kit keeps the authored opaque shell/trim and reserves glass for
      // dedicated landmark props.
      const runtimeArchitecture = (source: THREE.Object3D) => (
        theme === "campus" ? stripTransparentArchitecture(source) : source
      );
      const wallA = runtimeArchitecture(
        resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallA", "ArchitectureWall_A", "WallA"]) ?? authoredArchitectureWall,
      );
      const wallB = runtimeArchitecture(
        resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallB", "ArchitectureWall_B", "WallB"]) ?? authoredArchitectureWall,
      );
      const wallC = runtimeArchitecture(
        resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallC", "ArchitectureWall_C", "WallC"]) ?? authoredArchitectureWall,
      );
      const wallEnd = runtimeArchitecture(
        resolveThemeNode(themeKit.scene, theme, ["ArchitectureWallEnd", "ArchitectureEndWall", "WallEnd"]) ?? authoredArchitectureWall,
      );
      const wallCorner = requireThemeModule(["ArchitectureCorner", "ArchitectureCornerPost", "CornerPost"], "墙角");
      const wallDoorway = runtimeArchitecture(
        requireThemeModule(["ArchitectureDoorway", "ArchitectureDoorFrame", "Doorway"], "门洞"),
      );
      const wallWide = runtimeArchitecture(
        requireThemeModule(["ArchitectureWallWide", "ArchitectureWideWall", "WallWide"], "四米连续墙"),
      );
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
      const preserveAuthoredWallScale = theme !== "campus";
      const wallMeshes = [
        ...addInstancedModuleBatches([
          { source: wallA, placements: wallBatches.a, preserveAuthoredScale: preserveAuthoredWallScale },
          { source: runtimeWallB, placements: wallBatches.b, preserveAuthoredScale: preserveAuthoredWallScale },
          { source: runtimeWallC, placements: wallBatches.c, preserveAuthoredScale: preserveAuthoredWallScale },
          { source: wallEnd, placements: wallBatches.end, preserveAuthoredScale: preserveAuthoredWallScale },
          { source: wallDoorway, placements: wallBatches.doorway, preserveAuthoredScale: preserveAuthoredWallScale },
        ], new THREE.Vector3(CELL, wallHeight, 0.23), parent, true, `${theme}-wall`, supportsMultiDraw),
        ...addInstancedModuleBatches([
          { source: wallWide, placements: wallBatches.wide, preserveAuthoredScale: preserveAuthoredWallScale },
        ], new THREE.Vector3(CELL * 2, wallHeight, 0.23), parent, true, `${theme}-wall-wide`, supportsMultiDraw),
        ...addInstancedModuleBatches([
          { source: wallCorner, placements: wallBatches.corner, preserveAuthoredScale: preserveAuthoredWallScale },
        ], new THREE.Vector3(0.32, wallHeight, 0.32), parent, true, `${theme}-corner`, supportsMultiDraw),
        ...addInstancedModuleBatches([
          { source: wallJunction, placements: wallBatches.junction, preserveAuthoredScale: preserveAuthoredWallScale },
        ], new THREE.Vector3(CELL, 2.7, CELL), parent, true, `${theme}-junction`, supportsMultiDraw),
      ];
      // Walls still cast grounded shadows onto floors and props. They do not
      // need to receive the same directional map themselves: the dense,
      // double-sided bevel shells sit within a few millimetres of one another
      // and otherwise exhibit visible self-shadow acne at the game camera.
      for (const wallMesh of wallMeshes) wallMesh.receiveShadow = false;
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
      // an empty white exhibition table. Build a compact, maze-shaped
      // exterior patch instead: it follows the navigable silhouette, leaves
      // no enormous unused slab in concave voids, and costs only two instanced
      // draws (main paving plus a darker perimeter transition).
      const groundPatch: Array<{ point: Point }> = [];
      const plazaCenters = [
        {
          x: campaignLevel.playerStart.x + entranceDirection.x * 3.15,
          y: campaignLevel.playerStart.y + entranceDirection.y * 3.15,
        },
        ...exitDoorwayAnchors.map(({ point, outward }) => ({
          x: point.x + outward.x * 3.05,
          y: point.y + outward.y * 3.05,
        })),
      ];
      const plazaDirections = [
        entranceDirection,
        ...exitDoorwayAnchors.map(({ outward }) => outward),
      ];
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
      if (exitDoorwayAnchors.length > 1) {
        placedAssetIds.add(
          `theme-node:${authoredGround.name}:exit-plazas:${exitDoorwayAnchors.length}`,
        );
      }
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
        const variation = compositionMaterialVariantForCell(
          campaignLevel,
          "floor",
          patch.point,
        );
        const instanceColor = groundMaterial!.color.clone().lerp(
          new THREE.Color(campaignLevel.campaign.palette[variation.tintToken]),
          variation.colorMix,
        );
        ground.setColorAt(index, instanceColor);
      });
      ground.instanceMatrix.needsUpdate = true;
      if (ground.instanceColor) ground.instanceColor.needsUpdate = true;
      ground.receiveShadow = true;
      ground.computeBoundingBox();
      ground.computeBoundingSphere();
      parent.add(ground);

      const decalPixels = createCompositionDecalPixels(
        campaignLevel.campaign.theme,
        campaignLevel.campaign.palette,
      );
      const decalTexture = new THREE.DataTexture(
        decalPixels.data,
        decalPixels.width,
        decalPixels.height,
        THREE.RGBAFormat,
      );
      decalTexture.colorSpace = THREE.SRGBColorSpace;
      decalTexture.magFilter = THREE.LinearFilter;
      decalTexture.minFilter = THREE.LinearMipmapLinearFilter;
      decalTexture.generateMipmaps = true;
      decalTexture.needsUpdate = true;
      const markingMaterial = new THREE.MeshBasicMaterial({
        map: decalTexture,
        color: 0xffffff,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const markingRoute = environmentComposition.criticalRoute;
      const markingStride = Math.max(
        1,
        Math.ceil(markingRoute.length / environmentComposition.decalInstanceLimit),
      );
      const markingCells = markingRoute.filter((_, index) => (
        index > 0
        && index < markingRoute.length - 1
        && index % markingStride === 0
      )).slice(0, environmentComposition.decalInstanceLimit);
      const markingGeometry = new THREE.PlaneGeometry(CELL * 0.82, CELL * 0.42);
      markingGeometry.rotateX(-Math.PI / 2);
      const markings = new THREE.InstancedMesh(
        markingGeometry,
        markingMaterial,
        markingCells.length,
      );
      markingCells.forEach((cell, index) => {
        const next = markingRoute[Math.min(markingRoute.length - 1, markingRoute.indexOf(cell) + 1)]
          ?? cell;
        const heading = { x: next.x - cell.x, y: next.y - cell.y };
        const position = world(cell, campaignLevel);
        position.y = 0.072;
        const rotation = new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          Math.atan2(heading.x, heading.y),
        );
        markings.setMatrixAt(
          index,
          new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1)),
        );
      });
      markings.instanceMatrix.needsUpdate = true;
      markings.name = environmentComposition.materialVariation.decal.batchKey;
      markings.renderOrder = 2;
      parent.add(markings);
      placedAssetIds.add(`runtime:${environmentComposition.materialVariation.decal.id}`);

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
      // Keep only distant albedo detail. Normal/ORM response cannot be read
      // beneath the fog, but cloning those four maps inflated live texture
      // memory and created another heavyweight PBR shader permutation.
      const horizonSourceMap = horizonMaterial.map;
      horizonMaterial.normalMap = null;
      horizonMaterial.roughnessMap = null;
      horizonMaterial.metalnessMap = null;
      horizonMaterial.aoMap = null;
      if (horizonSourceMap) {
        const repeated = horizonSourceMap.clone();
        repeated.wrapS = THREE.RepeatWrapping;
        repeated.wrapT = THREE.RepeatWrapping;
        repeated.repeat.set(56, 56);
        repeated.needsUpdate = true;
        horizonMaterial.map = repeated;
      }
      const horizonGround = new THREE.Mesh(new THREE.PlaneGeometry(224, 224), horizonMaterial);
      horizonGround.name = `${theme}-fog-horizon-ground`;
      horizonGround.rotation.x = -Math.PI / 2;
      horizonGround.position.y = -0.16;
      // A 224 m background plane must not receive local wall shadows: those
      // read as giant cross-shaped stains where the detailed courtyard ends.
      horizonGround.receiveShadow = false;
      parent.add(horizonGround);

      const edgePlan = environmentComposition.edgeClosure;
      const edgeGeometry = new THREE.BoxGeometry(1, 1, 1);
      const edgeMaterial = new THREE.MeshBasicMaterial({
        color: edgePlan.fogColor,
        transparent: true,
        opacity: edgePlan.fogOpacity,
        depthWrite: false,
        fog: true,
      });
      const edgeSkirt = new THREE.InstancedMesh(
        edgeGeometry,
        edgeMaterial,
        edgePlan.segments.length,
      );
      edgePlan.segments.forEach((segment, index) => {
        const position = world(segment.center, campaignLevel);
        position.y = -edgePlan.skirtDepthMeters * 0.5 - 0.08;
        const horizontal = segment.side === "north" || segment.side === "south";
        const scale = new THREE.Vector3(
          horizontal ? segment.lengthCells * CELL : 0.42,
          edgePlan.skirtDepthMeters,
          horizontal ? 0.42 : segment.lengthCells * CELL,
        );
        edgeSkirt.setMatrixAt(
          index,
          new THREE.Matrix4().compose(
            position,
            new THREE.Quaternion(),
            scale,
          ),
        );
      });
      edgeSkirt.instanceMatrix.needsUpdate = true;
      edgeSkirt.name = `${theme}-composition-edge-skirt`;
      edgeSkirt.frustumCulled = false;
      parent.add(edgeSkirt);
      placedAssetIds.add("runtime:composition-edge-closure");

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
      registerPerformanceLight(exitLight, 1);
      exitMissionLight = exitLight;
      exitLight.color.set(0xff5b62);
      exitLight.intensity = 6.5;
      if (libraryGoldEnabled) {
        const secondaryExit = LIBRARY_BRANCHING_MISSION_TOPOLOGY.exitPlacements
          .find((placement) => (
            Math.abs(placement.position.x - campaignLevel.exit.x) > 1e-6
            || Math.abs(placement.position.y - campaignLevel.exit.y) > 1e-6
          ));
        if (!secondaryExit) throw new Error("图书楼双路线缺少第二个实体出口");
        const secondaryDirection = nearestExteriorDirection(
          secondaryExit.position,
          campaignLevel,
        );
        const secondaryDoor = authoredExit
          ? anchorAuthoredModule(authoredExit)
          : fitModule(requireStructure("exit"), new THREE.Vector3(1.9, 2.55, 0.42));
        secondaryDoor.name = `library-secondary-exit-${secondaryExit.exitId}`;
        secondaryDoor.rotation.y = Math.atan2(
          -secondaryDirection.x,
          -secondaryDirection.y,
        );
        secondaryDoor.position.add(world(secondaryExit.position, campaignLevel)).add(
          new THREE.Vector3(
            secondaryDirection.x * CELL * 0.5,
            0,
            secondaryDirection.y * CELL * 0.5,
          ),
        );
        if (!authoredExit) {
          applyThemeSurface(secondaryDoor, palette.accent, {
            blend: 0.08,
            emissive: 0xffad68,
            emissiveIntensity: 0.12,
          });
        }
        const secondaryExitDefinition = LIBRARY_BRANCHING_MISSION.exits
          .find((exit) => exit.id === secondaryExit.exitId);
        const routeBeacon = new THREE.Sprite(new THREE.SpriteMaterial({
          map: createMechanicBeaconTexture(
            "#75818b",
            `${secondaryExitDefinition?.label ?? "备用出口"} · 非当前路线`,
          ),
          transparent: true,
          opacity: 0.3,
          depthTest: true,
          depthWrite: false,
          toneMapped: false,
        }));
        routeBeacon.position.set(0, 2.85, 0);
        routeBeacon.scale.set(2.15, 0.8, 1);
        secondaryDoor.add(routeBeacon);
        parent.add(secondaryDoor);
        placedAssetIds.add(`gameplay:library-secondary-exit:${secondaryExit.exitId}`);
        registerCameraOccluder(
          `library-secondary-exit-${secondaryExit.exitId}`,
          [secondaryDoor],
        );
        const secondaryLight = new THREE.SpotLight(
          0x6f7d88,
          0.72,
          8,
          Math.PI / 7.5,
          0.64,
          1.8,
        );
        secondaryLight.position.copy(world(secondaryExit.position, campaignLevel))
          .add(new THREE.Vector3(0, 4.4, 0));
        secondaryLight.target.position.copy(world(secondaryExit.position, campaignLevel));
        parent.add(secondaryLight, secondaryLight.target);
        registerPerformanceLight(secondaryLight, 1);
      }
    };

    const buildDetails = (
      assets: Partial<Record<DetailAssetName, GLTF>>,
      themeKit: GLTF,
      parent: THREE.Group,
      lockerViews: Map<string, LockerView>,
      phase: DetailBuildPhase,
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
        if (!assets[name] && phase === "decorative") {
          console.warn(`Optional scene dressing detail:${name} is unavailable; keeping the remaining authored props`);
          return null;
        }
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

      if (phase === "essential") {
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
        const archetype = spot.archetype ?? "hard-locker";
        const visualPoint = visualHidePoint(spot);
        let root: THREE.Group;
        let cameraAnchor: THREE.Object3D;
        let peekAnchor: THREE.Object3D;
        let viewClips: ReadonlyMap<string, THREE.AnimationClip> = clipMap;
        if (archetype === "hard-locker") {
          root = fitInteractiveProp(lockerSource.scene, 2.12);
          root.name = `hero-locker-${spot.id}`;
          root.rotation.y = Math.atan2(spot.facing.x, spot.facing.y);
          root.position.copy(world(visualPoint, campaignLevel));
          root.updateMatrixWorld(true);
          const anchor = root.getObjectByName("HideAnchor");
          const authoredCameraAnchor = root.getObjectByName("CameraAnchor");
          const authoredPeekAnchor = root.getObjectByName("PeekAnchor");
          const pivot = root.getObjectByName("DoorPivot");
          if (!anchor || !authoredCameraAnchor || !authoredPeekAnchor || !pivot) {
            throw new Error("Hero locker is missing HideAnchor, CameraAnchor, PeekAnchor or DoorPivot; refusing an art fallback");
          }
          const anchorWorld = anchor.getWorldPosition(new THREE.Vector3());
          root.position.add(world(visualPoint, campaignLevel).sub(anchorWorld));
          cameraAnchor = authoredCameraAnchor;
          peekAnchor = authoredPeekAnchor;
          placedAssetIds.add("detail:locker");
        } else {
          const art = HIDE_ARCHETYPE_ART[campaignLevel.campaign.theme][archetype];
          const source = resolveThemeNode(
            themeKit.scene,
            campaignLevel.campaign.theme,
            [...art.nodes, ...artLayout.hideDressingNodes],
          );
          if (!source) {
            throw new Error(
              `${campaignLevel.campaign.themeLabel}主题模型缺少${art.label}原型，拒绝几何占位降级`,
            );
          }
          root = new THREE.Group();
          root.name = `hero-${archetype}-${spot.id}`;
          const authoredVisual = fitProp(source, art.height, true);
          authoredVisual.name = `${archetype}-authored-visual`;
          root.add(authoredVisual);
          root.rotation.y = Math.atan2(spot.facing.x, spot.facing.y);
          root.position.copy(world(visualPoint, campaignLevel));
          cameraAnchor = new THREE.Object3D();
          cameraAnchor.name = "CameraAnchor";
          cameraAnchor.position.set(0, Math.max(1.18, art.height * 0.68), 0.28);
          peekAnchor = new THREE.Object3D();
          peekAnchor.name = "PeekAnchor";
          peekAnchor.position.set(0, Math.max(1.22, art.height * 0.7), 0.62);
          root.add(cameraAnchor, peekAnchor);
          viewClips = new Map();
          placedAssetIds.add(`theme-node:${source.name || art.nodes[0]}`);
          placedAssetIds.add(`gameplay:hide-archetype:${archetype}`);
          if (archetype === "traversal-hide" && spot.alternateExit) {
            const companion = new THREE.Group();
            companion.name = `traversal-hide-exit-${spot.id}`;
            const companionVisual = fitProp(source, art.height, true);
            companionVisual.rotation.y = Math.PI;
            companion.add(companionVisual);
            companion.position.copy(world(spot.alternateExit, campaignLevel)).add(
              new THREE.Vector3(
                -spot.facing.y * CELL * 0.54,
                0,
                spot.facing.x * CELL * 0.54,
              ),
            );
            companion.rotation.y = Math.atan2(-spot.facing.x, -spot.facing.y);
            parent.add(companion);
          }
        }
        applyThemeSurface(root, campaignLevel.campaign.palette.accent, {
          blend: archetype === "hard-locker" ? 0.08 : 0.045,
          emissive: campaignLevel.campaign.palette.emissive,
          emissiveIntensity: archetype === "hard-locker" ? 0.035 : 0.075,
        });
        const beaconMaterial = new THREE.SpriteMaterial({
          map: archetype === "hard-locker"
            ? hideBeaconTexture
            : createMechanicBeaconTexture(
                archetype === "soft-cover" ? "#e8bd68" : "#77d6ff",
                HIDE_ARCHETYPE_ART[campaignLevel.campaign.theme][archetype].label,
              ),
          transparent: true,
          opacity: 0.72,
          depthTest: true,
          depthWrite: false,
          toneMapped: false,
        });
        const beacon = new THREE.Sprite(beaconMaterial);
        beacon.name = `hide-beacon-${spot.id}`;
        beacon.center.set(0.5, 0);
        beacon.position.set(0, archetype === "hard-locker" ? 2.62 : 2.48, 0);
        beacon.scale.set(archetype === "hard-locker" ? 1.3 : 1.52, archetype === "hard-locker" ? 0.56 : 0.6, 1);
        beacon.renderOrder = 7;
        beacon.visible = false;
        root.add(beacon);
        const beaconLight = new THREE.PointLight(
          new THREE.Color("#5ae0a0"),
          0,
          5.2,
          2.25,
        );
        beaconLight.name = `hide-beacon-light-${spot.id}`;
        beaconLight.position.set(0, archetype === "hard-locker" ? 1.85 : 1.48, -0.32);
        root.add(beaconLight);
        registerPerformanceLight(beaconLight, 3);
        parent.add(root);
        if (archetype === "hard-locker") {
          // A hero cabinet may sit directly between the fixed camera and both
          // the player and a newly placed tool. Treat its authored shell like
          // the maze architecture so the local silhouette cutout can reveal
          // gameplay, while hidden/peek cameras still restore full opacity.
          registerCameraOccluder(`hero-locker-${spot.id}`, [root]);
        }
        const view: LockerView = {
          id: spot.id,
          archetype,
          root,
          basePosition: root.position.clone(),
          baseRotationY: root.rotation.y,
          baseScale: root.scale.clone(),
          alternateExit: spot.alternateExit ? { ...spot.alternateExit } : null,
          approach: spot.approach,
          cameraAnchor,
          peekAnchor,
          beacon,
          beaconLight,
          mixer: new THREE.AnimationMixer(root),
          clips: viewClips,
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
        if (hideDressingSource && archetype === "hard-locker") {
          hideDressingPlacements.push({
            position: world(visualPoint, campaignLevel),
            rotation: Math.atan2(spot.facing.x, spot.facing.y),
          });
        }
      }
      if (hideDressingSource && hideDressingPlacements.length) {
        const hideDressingBatches = addInstancedModuleBatches([
          { source: hideDressingSource, placements: hideDressingPlacements, preserveAuthoredScale: true },
        ], new THREE.Vector3(1.5, 2.3, 0.8), parent, true, `${campaignLevel.campaign.theme}-hide-dressing`, supportsMultiDraw);
        registerCameraOccluder(
          `${campaignLevel.campaign.theme}-hide-dressing`,
          hideDressingBatches,
        );
        // The shader opens only the narrow camera-to-actor corridor. Away from
        // that corridor the authored landmark stays opaque and crisp.
        placedAssetIds.add(`theme-node:${hideDressingSource.name}`);
      }

      // The original school layout deliberately reserves seven path cells for
      // solid hero props. Keep presentation and collision authored from the
      // same ordered contract so the player never hits an invisible blocker.
      for (const [index, point] of (campaignLevel.movementBlockers ?? []).entries()) {
        const spec = MOVEMENT_PROP_CONTRACT[index];
        if (!spec) throw new Error(`${campaignLevel.id} 缺少第 ${index + 1} 个实体障碍美术契约`);
        const object = addProp(spec[0], point, spec[1], spec[2]);
        if (!object) throw new Error(`实体障碍 detail:${spec[0]} 不允许降级`);
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
      return;
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
      const secondaryExitClusterAnchors = libraryGoldEnabled
        ? LIBRARY_BRANCHING_MISSION_TOPOLOGY.exitPlacements
            .filter((placement) => (
              Math.abs(placement.position.x - campaignLevel.exit.x) > 1e-6
              || Math.abs(placement.position.y - campaignLevel.exit.y) > 1e-6
            ))
            .map((placement) => ({
              exitId: placement.exitId,
              anchor: exteriorAnchor(placement.position, 3.1, 0),
            }))
        : [];
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
        ...secondaryExitClusterAnchors.map(({ anchor }) => anchor),
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
      for (const { exitId, anchor } of secondaryExitClusterAnchors) {
        addAuthoredCluster(
          [...artLayout.exitNodes, "DressingClusterA"],
          anchor.point,
          anchor.rotation,
          `${artLayout.key}-secondary-exit-cluster-${exitId}`,
        );
      }
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
        if (object) {
          object.name = `semantic-${campaignLevel.campaign.atmosphere.propSet}-${placement.asset}`;
        }
      }

      if (campaignLevel.campaign.atmosphere.propSet === "campus-classic") {
        const classroomOffsets = [
          { tangent: -0.72, depth: -0.12 },
          { tangent: 0.72, depth: -0.12 },
          { tangent: -0.72, depth: 0.72 },
          { tangent: 0.72, depth: 0.72 },
        ];
        interiorNarrativeAnchors.slice(0, 2).forEach((roomAnchor, roomIndex) => {
          classroomOffsets.forEach((offset, deskIndex) => {
            const anchor = offsetAnchor(roomAnchor, offset.tangent, offset.depth);
            const supported = roomFloorSupportForFootprint(
              campaignLevel,
              roomTopology,
              {
                center: anchor.point,
                halfWidth: 0.3,
                halfDepth: 0.36,
                rotationRadians: anchor.rotation,
              },
            ).supported;
            if (!supported) return;
            const desk = addProp(
              "deskChair",
              anchor.point,
              1.05,
              anchor.rotation + (roomIndex % 2 === 0 ? 0 : Math.PI),
            );
            if (!desk) return;
            desk.name = `classroom-desk-${roomIndex + 1}-${deskIndex + 1}`;
            if (deskIndex % 2 === 0) {
              const books = addProp(
                "books",
                anchor.point,
                0.18,
                anchor.rotation + (deskIndex === 0 ? 0.08 : -0.12),
                new THREE.Vector3(0, 0.74, 0),
              );
              if (books) {
                books.name = `classroom-desk-books-${roomIndex + 1}-${deskIndex + 1}`;
              }
            }
          });
        });
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

      const lightRoute = objectivePaths.path(campaignLevel.playerStart, campaignLevel.exit);
      const lightPoints = [
        campaignLevel.playerStart,
        lightRoute[Math.floor(lightRoute.length * 0.28)],
        lightRoute[Math.floor(lightRoute.length * 0.58)],
        campaignLevel.exit,
      ].filter((point): point is Point => Boolean(point));
      for (const point of lightPoints) {
        addProp("ceilingLight", point, 0.16, 0, new THREE.Vector3(0, 2.35, 0));
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
        const animator = new ActorAnimator(
          root,
          asset.animations,
          spec.aliases as ClipAliases,
          LOCOMOTION_MARKERS,
        );
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
        if (name === "kid") {
          root.traverse((object) => object.layers.enable(1));
        }
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
        const readabilityRim = installActorReadabilityRim(
          root,
          name === "villain" ? 0xff3654 : name === "kid" ? 0x70cfff : 0x8eb8ff,
        );
        const view: ActorView = {
          root,
          animator,
          readabilityRim,
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
        animator.setMarkerListener((_state, marker) => {
          if (!isFootstepAnimationMarker(marker)) return;
          if (name === "kid") {
            soundscape.triggerAnimationFootstep({
              actor: "player",
              elapsedSeconds: latestState.elapsedSeconds,
              worldSpeed: view.sampledSpeed,
            });
            return;
          }
          if (
            name !== "villain"
            || latestState.phase !== "playing"
            || !canRuntimeObserveChaser(latestState)
          ) return;
          const visibleDistance = distanceBetween(
            latestState.player.position,
            latestState.chaser.position,
          );
          soundscape.triggerAnimationFootstep({
            actor: "chaser",
            elapsedSeconds: latestState.elapsedSeconds,
            worldSpeed: view.sampledSpeed,
            audibility: visibleDistance <= 3 ? 1 : visibleDistance <= 6 ? 2 / 3 : 1 / 3,
            pan: soundPanForWorldPoints(
              latestState.player.position,
              latestState.chaser.position,
            ),
          });
        });
        requestAnimation(view, "idle", { fade: 0 });
      }
    };

    const placePersonalGhost = (asset: GLTF | undefined, targetScene: THREE.Scene) => {
      if (!preferences.personalGhostEnabled || !asset || ghostActor) return;
      const spec = ACTOR_SPECS.kid;
      const root = fitActor(asset.scene, spec.height);
      root.name = "actor-personal-best-ghost";
      const uniqueMaterials = new Map<string, THREE.Material>();
      root.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;
        const tuneGhostMaterial = (material: THREE.Material) => {
          const existing = uniqueMaterials.get(material.uuid);
          if (existing) return existing;
          const ghostMaterial = material.clone();
          ghostMaterial.transparent = true;
          ghostMaterial.opacity = Math.min(0.42, Math.max(0.24, material.opacity * 0.42));
          ghostMaterial.depthWrite = false;
          ghostMaterial.blending = THREE.AdditiveBlending;
          if (ghostMaterial instanceof THREE.MeshStandardMaterial) {
            ghostMaterial.color.lerp(new THREE.Color(0x5ee7ff), 0.58);
            ghostMaterial.emissive.set(0x159fc6);
            ghostMaterial.emissiveIntensity = 0.72;
            ghostMaterial.roughness = Math.max(0.28, ghostMaterial.roughness);
          }
          ghostMaterial.needsUpdate = true;
          uniqueMaterials.set(material.uuid, ghostMaterial);
          return ghostMaterial;
        };
        object.material = Array.isArray(object.material)
          ? object.material.map(tuneGhostMaterial)
          : tuneGhostMaterial(object.material);
      });
      const animator = new ActorAnimator(
        root,
        asset.animations,
        spec.aliases as ClipAliases,
        LOCOMOTION_MARKERS,
      );
      animator.require(["idle", "walk", "run"]);
      const durationByState: Partial<Record<AnimationState, number>> = {};
      const clipsByName = new Map(asset.animations.map((clip) => [clip.name.toLowerCase(), clip]));
      for (const [state, alias] of Object.entries(spec.aliases) as [AnimationState, string | readonly string[]][]) {
        const candidates = typeof alias === "string" ? [alias] : alias;
        const clip = candidates.map((candidate) => clipsByName.get(candidate.toLowerCase())).find(Boolean);
        if (clip) durationByState[state] = clip.duration;
      }
      root.position.copy(world(campaignLevel.playerStart, campaignLevel));
      root.renderOrder = 4;
      root.visible = false;
      root.traverse((object) => object.layers.enable(1));
      targetScene.add(root);
      const readabilityRim = installActorReadabilityRim(root, 0x84f4ff);
      readabilityRim.value = 0.48;
      ghostActor = {
        root,
        animator,
        readabilityRim,
        durationByState,
        lastPoint: { ...campaignLevel.playerStart },
        lastTick: 0,
        sampledSpeed: 0,
        lastRequested: null,
        lastTurnCycle: -1,
        visibilityAlpha: 0.42,
        visibilityMaterials: [...uniqueMaterials.values()].map((material) => ({
          material,
          baseOpacity: material.opacity,
          baseTransparent: true,
          baseDepthWrite: false,
        })),
      };
      requestAnimation(ghostActor, "idle", { fade: 0 });
      placedAssetIds.add("runtime:personal-best-ghost");
    };

    const consumeEvents = (
      state: GameState,
      deltaSeconds: number,
      causalEvents: readonly RunCausalEvent[] = [],
    ) => {
      const telemetryThreatStrength = publicThreatStrengthForMode(state.chaser.mode);
      const completedInvestigations: RunCausalEvent[] = [];
      for (const event of state.events) {
        if (
          event.type === "evidence-investigation-completed"
          && event.sourceType === "environment-decoy"
        ) {
          completedInvestigations.push({
            type: "investigation-completed",
            evidenceId: event.evidenceId,
            source: portableDecoySourceIds.has(event.evidenceId)
              ? "decoy"
              : "theme-mechanic",
          });
          if (event.evidenceId === mechanicDefinition.soundSource.sourceId) {
            completedInvestigations.push({
              type: "theme-mechanic-advantage",
              mechanicId: mechanicDefinition.id,
              advantage: "diverted-pursuer",
            });
          }
        }
      }
      runTelemetry = applyRunTelemetryFrame(runTelemetry, {
        deltaSeconds,
        events: state.events,
        phase: state.phase,
        playerMode: state.player.mode,
        threat: telemetryThreatStrength >= 0.7
          ? "active"
          : telemetryThreatStrength >= 0.2
            ? "caution"
            : "calm",
        causalEvents: [...causalEvents, ...completedInvestigations],
      });
      for (const event of state.events) {
        if (event.type === "hide-check-completed") {
          const locker = lockers.get(event.hideSpotId);
          if (locker) {
            if (locker.archetype === "hard-locker") {
              if (event.occupied) locker.holdFinal = true;
              else closeCheckedLocker(locker);
            } else {
              locker.owner = event.occupied ? "chaser" : "idle";
              locker.holdFinal = event.occupied;
            }
          }
          if (!event.occupied) soundscape.trigger("locker-close");
          continue;
        }
        if (event.type === "player-captured") {
          setLastCaptureReason(event.reason);
          continue;
        }
        if (event.type === "chaser-archetype-telegraph-started") {
          soundscape.trigger("alert");
          playHapticCue(
            "theme-warning",
            preferencesRef.current.hapticsEnabled,
            navigator.vibrate?.bind(navigator),
          );
          if (actors.villain) {
            requestAnimation(actors.villain, "alert", {
              fade: 0.1,
              duration: event.warningSeconds,
              loop: false,
              restart: true,
            });
          }
          continue;
        }
        if (event.type === "chaser-archetype-action-started") {
          if (actors.villain) {
            const performance: AnimationState = event.action === "inspect-public-hide-clue"
              ? "checkLocker"
              : event.action === "intercept-public-exit-route"
                ? "run"
                : event.action === "scan-public-junction"
                  ? "search"
                  : "alert";
            requestAnimation(actors.villain, performance, {
              fade: 0.12,
              restart: true,
            });
          }
          continue;
        }
        if (event.type === "chaser-archetype-action-finished") {
          setChaserArchetypeRuntime(simulation.getChaserArchetypeRuntime());
          continue;
        }
        if (event.type === "chaser-mode-changed") {
          if (event.to === "check-hide") soundscape.trigger("locker-check");
          if (event.to === "chase" && event.from !== "lost-sight") {
            playHapticCue(
              "detected",
              preferencesRef.current.hapticsEnabled,
              navigator.vibrate?.bind(navigator),
            );
          }
          continue;
        }
        if (event.type === "phase-changed") {
          updatePhasePresentation(event.to);
          if (event.to === "lost") {
            soundscape.trigger("caught");
            playHapticCue(
              "captured",
              preferencesRef.current.hapticsEnabled,
              navigator.vibrate?.bind(navigator),
            );
            captureStageRemaining = CAPTURE_STAGING_SECONDS;
            capturePerformanceStarted = false;
            requestAnimation(actors.kid!, "idle", { fade: 0.08 });
            requestAnimation(actors.villain!, "alert", { fade: 0.08 });
          } else if (event.to === "won") {
            soundscape.trigger("escaped");
            playHapticCue(
              "escaped",
              preferencesRef.current.hapticsEnabled,
              navigator.vibrate?.bind(navigator),
            );
            if (preferencesRef.current.reducedMotion) {
              requestAnimation(actors.kid!, "idle", { fade: 0.18 });
            } else {
              requestAnimation(actors.kid!, "celebrate", { fade: 0.18 });
            }
            // The authored kid celebration is the reliable immediate fallback.
            // Police joins as soon as its on-demand stream completes.
            void requestPoliceAsset?.();
            if (actors.police) {
              requestAnimation(
                actors.police,
                preferencesRef.current.reducedMotion ? "idle" : "protect",
                { fade: 0.14 },
              );
            }
          }
          continue;
        }
        if (event.type !== "player-mode-changed") continue;
        setPlayerMode(event.to);
        setInteraction(simulation.getHideInteraction());
        const spotId = state.player.hideSpotId;
        const locker = spotId ? lockers.get(spotId) : undefined;
        const resolvedHide = simulation.getActiveHideSpotArchetype();
        if (event.to === "entering-hide" && locker) {
          soundscape.trigger("locker-open");
          if (locker.archetype === "hard-locker") {
            playLockerSequence(locker, ["Locker_Door_Open_Enter", "Locker_Door_Close_Enter"]);
          } else {
            locker.owner = "player";
          }
          requestAnimation(actors.kid!, "enterHide", {
            fade: 0.1,
            duration: simulation.config.hideEnterSeconds
              * (resolvedHide?.profile.timing.enterDurationMultiplier ?? 1),
          });
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
          playHapticCue(
            "hide-latched",
            preferencesRef.current.hapticsEnabled,
            navigator.vibrate?.bind(navigator),
          );
          requestAnimation(actors.kid!, "hideIdle", { fade: 0.18 });
        } else if (event.to === "exiting-hide" && locker) {
          soundscape.trigger("locker-open");
          if (locker.archetype === "hard-locker") {
            setLockerPeek(locker, false);
            playLockerSequence(locker, ["Locker_Door_Open_Exit", "Locker_Door_Close_Exit"]);
          } else {
            locker.owner = "player";
          }
          requestAnimation(actors.kid!, "exitHide", {
            fade: 0.1,
            duration: simulation.config.hideExitSeconds
              * (resolvedHide?.profile.timing.exitDurationMultiplier ?? 1),
          });
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
      let kidPose = playerPresentationPose(state, campaignLevel, simulation);
      const committedMissionView = missionCommitment
        ? missionViews.get(missionCommitment.objectiveId)
        : null;
      const activeStealthCommitment = stealthToolbeltState.commitment;
      if (activeStealthCommitment) {
        const target = activeStealthCommitment.target.interactionPoint;
        missionPerformanceTarget.copy(world(target, campaignLevel));
        kid.root.getWorldPosition(missionPerformanceOrigin);
        const heading = {
          x: missionPerformanceTarget.x - missionPerformanceOrigin.x,
          y: missionPerformanceTarget.z - missionPerformanceOrigin.z,
        };
        const headingLength = Math.hypot(heading.x, heading.y);
        if (headingLength > 1e-5) {
          kidPose = {
            point: kidPose.point,
            heading: {
              x: heading.x / headingLength,
              y: heading.y / headingLength,
            },
          };
        }
      } else if (committedMissionView) {
        committedMissionView.root.getWorldPosition(missionPerformanceTarget);
        kid.root.getWorldPosition(missionPerformanceOrigin);
        const heading = {
          x: missionPerformanceTarget.x - missionPerformanceOrigin.x,
          y: missionPerformanceTarget.z - missionPerformanceOrigin.z,
        };
        const headingLength = Math.hypot(heading.x, heading.y);
        if (headingLength > 1e-5) {
          kidPose = {
            point: kidPose.point,
            heading: {
              x: heading.x / headingLength,
              y: heading.y / headingLength,
            },
          };
        }
      }
      const kidSpeed = sampleActorSpeed(kid, state.player.position, state.tick, simulation.config.fixedStepSeconds);
      const villainSpeed = sampleActorSpeed(villain, state.chaser.position, state.tick, simulation.config.fixedStepSeconds);
      const captureStaging = state.phase === "lost" && !capturePerformanceStarted;
      syncActorTransform(
        kid,
        kidPose.point,
        kidPose.heading,
        delta,
        captureStaging ? 34 : 18,
        captureStaging ? 15 : 9.5,
        state.player.mode === "aligning-hide" && state.player.hideTurnDirection !== 0,
      );
      syncActorTransform(villain, state.chaser.position, state.chaser.heading, delta, captureStaging ? 34 : 18, captureStaging ? 15 : 9.5);

      if (state.phase === "playing") {
        if (
          !qaKidAnimationScenario
          && (state.player.mode === "free" || state.player.mode === "aligning-hide")
        ) {
          const kidTurn: AnimationState | null = state.player.hideTurnDirection > 0
            ? "turnLeft"
            : state.player.hideTurnDirection < 0
              ? "turnRight"
              : null;
          if (state.player.mode === "free" && activeStealthCommitment) {
            const performanceId =
              `stealth-tool:${activeStealthCommitment.useId}`;
            const restart = missionPerformanceObjectiveId !== performanceId;
            requestAnimation(kid, "point", {
              fade: 0.08,
              duration: Math.max(
                simulation.config.fixedStepSeconds,
                (
                  activeStealthCommitment.completesAtTick
                  - activeStealthCommitment.startedAtTick
                ) * simulation.config.fixedStepSeconds,
              ),
              loop: false,
              restart,
            });
            missionPerformanceObjectiveId = performanceId;
          } else if (
            state.player.mode === "free"
            && state.tick < stealthEvidenceState.countermeasureBusyUntilTick
          ) {
            const performanceId =
              `stealth-evidence:${stealthEvidenceState.countermeasureBusyUntilTick}`;
            const restart = missionPerformanceObjectiveId !== performanceId;
            requestAnimation(kid, "point", {
              fade: 0.08,
              duration: Math.max(
                simulation.config.fixedStepSeconds,
                (
                  stealthEvidenceState.countermeasureBusyUntilTick
                  - state.tick
                ) * simulation.config.fixedStepSeconds,
              ),
              loop: false,
              restart,
            });
            missionPerformanceObjectiveId = performanceId;
          } else if (state.player.mode === "free" && missionCommitment) {
            const restart = missionPerformanceObjectiveId
              !== missionCommitment.objectiveId;
            requestAnimation(kid, "point", {
              fade: 0.08,
              duration: missionCommitment.totalSeconds,
              loop: false,
              restart,
            });
            missionPerformanceObjectiveId = missionCommitment.objectiveId;
          } else if (
            state.player.mode === "free"
            && portableDecoyThrowRemainingSeconds > 0
          ) {
            requestAnimation(kid, "point", {
              fade: 0.06,
              duration: LIBRARY_PORTABLE_DECOY_DEFINITION.fuseSeconds,
              loop: false,
            });
            missionPerformanceObjectiveId = null;
          } else if (state.player.mode === "aligning-hide" && kidSpeed <= 0.12 && kidTurn) {
            missionPerformanceObjectiveId = null;
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
            missionPerformanceObjectiveId = null;
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
        const archetypeRuntime = simulation.getChaserArchetypeRuntime();
        const villainAnimation: AnimationState = archetypeRuntime.phase === "telegraph"
          ? "alert"
          : archetypeRuntime.phase === "acting"
            ? archetypeRuntime.action === "inspect-public-hide-clue"
              ? "checkLocker"
              : archetypeRuntime.action === "intercept-public-exit-route"
                ? "run"
                : archetypeRuntime.action === "scan-public-junction"
                  ? "search"
                  : "alert"
            : chaserAnimationForMode(state.chaser.mode, villainSpeed, atCheckSpot);
        requestAnimation(villain, villainAnimation, {
          fade: 0.17,
          duration: villainAnimation === "checkLocker"
            ? simulation.config.checkHideSeconds
            : archetypeRuntime.phase === "telegraph"
              ? archetypeRuntime.warningSeconds
            : state.chaser.mode === "scan-last-known"
              ? simulation.config.lastKnownScanSeconds
              : undefined,
          loop: state.chaser.mode === "scan-last-known"
            || archetypeRuntime.phase === "telegraph"
            ? false
            : undefined,
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
            if (locker.archetype !== "hard-locker") {
              locker.owner = "chaser";
              lastCheckSpot = checkId;
            } else {
              const openDuration = locker.clips.get("Locker_Door_Check_Open")?.duration ?? 0;
              const remainingCheck = Math.max(0, simulation.config.checkHideSeconds - state.chaser.modeElapsedSeconds);
              if (holdLockerAction(locker, "Locker_Door_Check_Open", Math.max(0, remainingCheck - openDuration))) {
                lastCheckSpot = checkId;
              }
            }
          }
        } else if (state.chaser.mode !== "check-hide") {
          if (state.phase === "playing" && lastCheckSpot) {
            const interrupted = lockers.get(lastCheckSpot);
            if (interrupted && interrupted.archetype !== "hard-locker") {
              interrupted.owner = "idle";
              interrupted.holdFinal = false;
            } else if (interrupted?.holdFinal && interrupted.delayRemaining > 0) {
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
          snapActorTransform(kid, kidPose.point, kidPose.heading);
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
      const urgentHideMarker = playerKnowledge.threat !== "calm";
      const markerPulse = 0.5 + Math.sin(state.elapsedSeconds * 4.6) * 0.5;
      const guidedLightColor = guidedLockerRisk === "low"
        ? 0x5ae0a0
        : guidedLockerRisk === "medium"
          ? 0xe8bd68
          : 0xff6b72;
      const hideExitSelection = simulation.getHideExitSelection();
      for (const locker of lockers.values()) {
        updateLocker(locker, delta);
        if (locker.archetype !== "hard-locker") {
          const active = state.player.hideSpotId === locker.id;
          const playerOccupying = active && !["free", "escaped", "caught"].includes(state.player.mode);
          const chaserInspecting = locker.owner === "chaser";
          const motionGain = playerOccupying ? 1 : chaserInspecting ? 0.72 : 0;
          const pulse = preferencesRef.current.reducedMotion
            ? 0
            : Math.sin(state.elapsedSeconds * (locker.archetype === "soft-cover" ? 2.1 : 3.4));
          const targetScale = locker.baseScale.clone();
          if (locker.archetype === "soft-cover") {
            targetScale.multiply(new THREE.Vector3(
              1 + motionGain * 0.012,
              1 - motionGain * 0.022,
              1 + motionGain * 0.008,
            ));
          } else {
            targetScale.multiplyScalar(1 + motionGain * 0.009);
          }
          locker.root.scale.lerp(
            targetScale,
            1 - Math.exp(-10 * delta),
          );
          const exitSide = hideExitSelection?.hideSpotId === locker.id
            && hideExitSelection.selected === "alternate"
            ? -1
            : 1;
          const motionOffset = locker.archetype === "traversal-hide"
            ? new THREE.Vector3(
                -Math.cos(locker.baseRotationY) * motionGain * 0.055 * exitSide,
                0,
                Math.sin(locker.baseRotationY) * motionGain * 0.055 * exitSide,
              )
            : new THREE.Vector3(0, 0, 0);
          locker.root.position.lerp(
            locker.basePosition.clone().add(motionOffset),
            1 - Math.exp(-11 * delta),
          );
          const checkShake = chaserInspecting ? pulse * 0.024 : 0;
          const coverSway = locker.archetype === "soft-cover"
            ? pulse * motionGain * 0.008
            : 0;
          locker.root.rotation.y = THREE.MathUtils.damp(
            locker.root.rotation.y,
            locker.baseRotationY + checkShake + coverSway,
            13,
            delta,
          );
        }
        const distance = distanceBetween(state.player.position, locker.approach);
        const isSuggested = guidedLockerId
          ? locker.id === guidedLockerId
          : !guidedBreakSight && locker.id === nearestLockerId;
        const isInteractable = distance <= simulation.config.hideInteractRange;
        // The close-range interaction prompt owns the final metre. Retiring
        // the world beacon there keeps it from sitting on top of the player's
        // silhouette on portrait screens.
        locker.beacon.visible = hideMarkerAllowed
          && (isSuggested || isInteractable)
          && distance > simulation.config.hideInteractRange * 0.82;
        const beaconMaterial = locker.beacon.material as THREE.SpriteMaterial;
        beaconMaterial.opacity = isInteractable
          ? 0
          : urgentHideMarker ? 0.76 + markerPulse * 0.16 : 0.5 + markerPulse * 0.1;
        const markerScale = urgentHideMarker ? 1.03 + markerPulse * 0.035 : 1;
        const baseBeaconWidth = locker.archetype === "hard-locker" ? 1.3 : 1.52;
        const baseBeaconHeight = locker.archetype === "hard-locker" ? 0.56 : 0.6;
        locker.beacon.scale.set(
          baseBeaconWidth * markerScale,
          baseBeaconHeight * markerScale,
          1,
        );
        locker.beaconLight.color.setHex(isSuggested ? guidedLightColor : 0x5ae0a0);
        locker.beaconLight.intensity = locker.beacon.visible
          ? isInteractable ? 2.3 + markerPulse * 0.7 : urgentHideMarker ? 1.35 + markerPulse * 0.4 : 0.72
          : 0;
      }
    };

    const advanceAndSyncGhost = (delta: number) => {
      if (!ghostSimulation || !ghostCursor || !ghostState || !ghostActor || !ghostRecording) {
        if (ghostActor) ghostActor.root.visible = false;
        return;
      }
      ghostActor.root.visible = latestState.phase === "playing";
      if (latestState.phase !== "playing") {
        ghostActor.animator.update(delta);
        return;
      }
      ghostAccumulatorSeconds += delta;
      const fixedStep = ghostRecording.fixedStepSeconds;
      while (
        ghostAccumulatorSeconds + 1e-9 >= fixedStep
        && ghostState.tick < ghostRecording.durationTicks
        && ghostState.phase === "playing"
      ) {
        if (ghostRuleProgressTracker) {
          ghostRuleProgress = ghostRuleProgressTracker.update({
            tick: ghostState.tick,
            routeProgress: exitRouteProgressForPosition(
              ghostState.player.position,
            ),
            events: consumeGhostRuleEventsThrough(ghostState.tick),
          });
        }
        ghostState = ghostSimulation.advance(
          fixedStep,
          {
            ...ghostCursor.sample(ghostState.tick),
            exitEnabled: ghostRuleProgress?.exitUnlocked ?? true,
          },
        );
        ghostAccumulatorSeconds -= fixedStep;
      }
      if (ghostRuleProgressTracker) {
        ghostRuleProgress = ghostRuleProgressTracker.update({
          tick: ghostState.tick,
          routeProgress: exitRouteProgressForPosition(
            ghostState.player.position,
          ),
          events: consumeGhostRuleEventsThrough(ghostState.tick),
        });
      }
      const ghostSpeed = sampleActorSpeed(
        ghostActor,
        ghostState.player.position,
        ghostState.tick,
        ghostRecording.fixedStepSeconds,
      );
      const ghostPose = playerPresentationPose(ghostState, campaignLevel, ghostSimulation);
      syncActorTransform(
        ghostActor,
        ghostPose.point,
        ghostPose.heading,
        delta,
        22,
        11,
      );
      const ghostAnimation: AnimationState = ghostState.player.mode === "free"
        ? ghostSpeed > 2.35 ? "run" : ghostSpeed > 0.12 ? "walk" : "idle"
        : ghostState.player.mode === "aligning-hide"
          ? "walk"
          : "idle";
      requestAnimation(ghostActor, ghostAnimation, { fade: 0.13 });
      ghostActor.animator.setLocomotionRate(
        ghostSpeed,
        ghostAnimation === "run" ? 4.4 : 2,
      );
      ghostActor.animator.update(delta);

      if (ghostRaceTracker) {
        const playerRemaining = objectivePaths.path(
          latestState.player.position,
          campaignLevel.exit,
        );
        const ghostRemaining = objectivePaths.path(
          ghostState.player.position,
          campaignLevel.exit,
        );
        latestGhostRace = ghostRaceTracker.update({
          elapsedSeconds: latestState.elapsedSeconds,
          playerRemainingMeters: Math.max(0, playerRemaining.length - 1) * CELL,
          ghostRemainingMeters: Math.max(0, ghostRemaining.length - 1) * CELL,
          ...(ghostRuleProgress
            ? {
                playerRuleProgress,
                ghostRuleProgress,
              }
            : {}),
        });
      }
    };

    const missionObjectiveForPlayer = (
      position: Point,
    ): { objective: RuntimeMissionObjective; position: Point; routeCells: number } | null => {
      const available = new Set(
        availableRuntimeMissionObjectiveIds(),
      );
      const candidates = runtimeMissionObjectives.flatMap((objective) => {
        if (!available.has(objective.id)) return [];
        const objectivePosition = missionPlacementById.get(objective.id);
        if (!objectivePosition) return [];
        const route = objectivePaths.path(position, objectivePosition);
        if (!route.length) return [];
        return [{
          objective,
          position: objectivePosition,
          routeCells: Math.max(0, route.length - 1),
        }];
      });
      return candidates.sort((left, right) => (
        left.routeCells - right.routeCells
        || left.objective.id.localeCompare(right.objective.id)
      ))[0] ?? null;
    };

    const updateHideGuideProjection = (state: GameState, lightStepHeld: boolean) => {
      if (state.phase !== "playing" || state.player.mode !== "free" || lockers.size === 0) {
        setHideGuideProjection(null);
        return;
      }
      const routeRecord = getCampaignRunRecord(
        campaignProgressRef.current,
        runRecordLevelId,
        preferences.ruleset,
      );
      const legacyLibraryRecord = libraryGoldEnabled
        ? getCampaignRunRecord(
            campaignProgressRef.current,
            campaignLevel.id,
            preferences.ruleset,
          )
        : null;
      const firstClear = !routeRecord.bestSeconds
        && !legacyLibraryRecord?.bestSeconds;
      const guidance = planHideGuidance(campaignLevel, {
        playerPosition: state.player.position,
        nowSeconds: state.elapsedSeconds,
        playerSpeed: simulation.config.playerSpeed * (lightStepHeld ? 0.58 : 1),
        chaserSpeed: simulation.config.chaserSpeed,
        hideEnterExposureSeconds: simulation.config.hideEnterExposureSeconds,
        knownChaser: playerKnownChaser,
        tutorialHideSpotId: firstClear ? hideGuidancePolicy.tutorialHideSpotId : null,
        searchHideCheckBudget: simulation.config.searchHideCheckBudget,
        searchHideRadiusCells: simulation.config.searchHideRadiusCells,
      });
      const stabilized = stabilizeHideGuidance(
        guidance,
        guidedTargetState,
        state.elapsedSeconds,
        { playerPosition: state.player.position },
      );
      guidedTargetState = stabilized.targetState;
      const stablePlan = stabilized.plan;
      if (!stablePlan) {
        guidedLockerId = null;
        guidedBreakSight = false;
        setHideGuideProjection(null);
        return;
      }
      let targetWorld: THREE.Vector3;
      if (stablePlan.strategy === "hide") {
        const guidedLocker = lockers.get(stablePlan.recommended.hideSpotId);
        if (!guidedLocker) {
          guidedLockerId = null;
          setHideGuideProjection(null);
          return;
        }
        guidedLockerId = guidedLocker.id;
        guidedBreakSight = false;
        guidedLockerRisk = stablePlan.recommended.risk;
        setHideGuideStrategy("hide");
        setHideGuideRisk(stablePlan.recommended.risk);
        setHideGuideSelection(stablePlan.selection);
        setHideDistance(Math.round(stablePlan.recommended.routeDistanceCells * CELL));
        targetWorld = guidedLocker.beacon.getWorldPosition(new THREE.Vector3());
      } else {
        guidedLockerId = null;
        guidedBreakSight = true;
        guidedLockerRisk = "high";
        setHideGuideStrategy("break-line-of-sight");
        setHideGuideRisk("high");
        setHideGuideSelection("held");
        const waypoint = stablePlan.waypoint;
        if (!waypoint) {
          setHideDistance(0);
          setHideGuideProjection(null);
          return;
        }
        const waypointRoute = objectivePaths.path(state.player.position, waypoint);
        setHideDistance(Math.round(Math.max(0, waypointRoute.length - 1) * CELL));
        targetWorld = world(waypoint, campaignLevel).add(new THREE.Vector3(0, 1.15, 0));
      }
      const projected = targetWorld.project(camera);
      const viewportX = (projected.x + 1) / 2;
      const viewportY = (1 - projected.y) / 2;
      const inFrustum = Math.abs(projected.x) <= 0.92
        && Math.abs(projected.y) <= 0.86
        && projected.z >= -1
        && projected.z <= 1;
      const markerMarginX = 2_800 / cameraViewportWidth;
      const markerMarginY = 2_800 / cameraViewportHeight;
      const safeLeft = THREE.MathUtils.clamp(
        ((cameraSafeViewport.minX + 1) / 2) * 100 + markerMarginX,
        7,
        46,
      );
      const safeRight = THREE.MathUtils.clamp(
        ((cameraSafeViewport.maxX + 1) / 2) * 100 - markerMarginX,
        54,
        93,
      );
      const safeTop = THREE.MathUtils.clamp(
        ((1 - cameraSafeViewport.maxY) / 2) * 100 + markerMarginY,
        11,
        46,
      );
      const safeBottom = THREE.MathUtils.clamp(
        ((1 - cameraSafeViewport.minY) / 2) * 100 - markerMarginY,
        54,
        86,
      );
      setHideGuideProjection({
        xPercent: THREE.MathUtils.clamp(viewportX * 100, safeLeft, safeRight),
        yPercent: THREE.MathUtils.clamp(viewportY * 100, safeTop, safeBottom),
        angleDegrees: THREE.MathUtils.radToDeg(Math.atan2(viewportY - 0.5, viewportX - 0.5)),
        offscreen: !inFrustum,
      });
    };

    /**
     * Advance/cancel the advisory director before the simulation input for
     * `nextTick` is built. It samples only the current public threat state, so
     * a chase cancels modifiers at the boundary instead of leaking a boosted
     * movement tick into the chase.
     */
    const advanceDirectorForSimulationTick = (
      state: GameState,
      nextTick: number,
      presentationEffects: Array<() => void>,
    ) => {
      if (nextTick !== state.tick + 1) {
        throw new Error(
          `Director boundary drift: expected ${state.tick + 1}, received ${
            nextTick
          }`,
        );
      }
      if (!qaDirectorEnabled) return;
      const chased = state.chaser.mode === "chase"
        || state.chaser.mode === "lost-sight";
      const suspicious = !chased && [
        "suspicious",
        "go-to-last-known",
        "scan-last-known",
        "search",
        "check-hide",
      ].includes(state.chaser.mode);
      if (chased) {
        directorChaseTicks += 1;
        directorSafeTicks = 0;
        directorTicksSinceChaseEscape = null;
      } else if (suspicious) {
        if (directorWasChased) directorTicksSinceChaseEscape = 0;
        else if (directorTicksSinceChaseEscape !== null) {
          directorTicksSinceChaseEscape += 1;
        }
        directorSafeTicks = 0;
        directorChaseTicks = 0;
      } else {
        if (directorWasChased) directorTicksSinceChaseEscape = 0;
        else if (directorTicksSinceChaseEscape !== null) {
          directorTicksSinceChaseEscape += 1;
        }
        directorSafeTicks += 1;
        directorChaseTicks = 0;
      }
      directorWasChased = chased;
      const toolInventory = Object.values(stealthToolbeltState.tools)
        .reduce((sum, runtime) => sum + runtime.inventoryRemaining, 0);
      const resourcePermille = Math.round(
        (toolInventory / 7 * 0.72
          + stealthEvidenceState.countermeasureBudgetRemaining / 10 * 0.28)
          * 1_000,
      );
      const directorStep = stepTensionDirector(
        tensionDirectorDefinition,
        tensionDirectorState,
        {
          tick: nextTick,
          runPhase: state.phase === "playing"
            ? "playing"
            : state.phase === "ready"
              ? "paused"
              : "complete",
          threat: chased ? "chased" : suspicious ? "suspicious" : "safe",
          safeTicks: directorSafeTicks,
          chaseTicks: directorChaseTicks,
          ticksSinceChaseEscape: directorTicksSinceChaseEscape,
          missionProgressPermille: Math.round(
            missionState.completedObjectiveIds.length
              / Math.max(1, runtimeMissionObjectives.length)
              * 1_000,
          ),
          resourcesRemainingPermille: THREE.MathUtils.clamp(
            resourcePermille,
            0,
            1_000,
          ),
          legalRouteIds: tensionDirectorDefinition.routeIds,
        },
      );
      tensionDirectorState = directorStep.state;
      for (const event of directorStep.lifecycleEvents) {
        if (event.type === "event-suggested") {
          stealthNotice = `环境预告 · ${event.suggestion.label} ${
            (event.suggestion.safety.warningTicks
              * simulation.config.fixedStepSeconds).toFixed(1)
          }s 后开始`;
          stealthNoticeUntilTick = nextTick
            + event.suggestion.safety.warningTicks;
        } else if (event.type === "event-activated") {
          const suggestion = tensionDirectorState.activeEvent?.suggestion;
          if (suggestion) {
            const playerPosition = { ...state.player.position };
            const profile =
              THEME_MECHANIC_AUDIO_PROFILES[campaignLevel.campaign.theme];
            presentationEffects.push(() => {
              soundscape.triggerWorldSound({
                listenerPosition: playerPosition,
                sourcePosition: mechanicPosition,
                kind: "theme-event",
                maxDistance: 18,
                baseGain: suggestion.kind === "broadcast"
                  ? 0.16
                  : suggestion.kind === "blackout"
                    ? 0.13
                    : 0.1,
                occlusion: hasLineOfSight(
                  campaignLevel,
                  playerPosition,
                  mechanicPosition,
                ) ? 0 : 0.38,
                foleySet: profile.foleySet,
                playbackRate: suggestion.kind === "blackout"
                  ? profile.playbackRate * 0.72
                  : profile.playbackRate,
              });
              playHapticCue(
                "theme-warning",
                preferencesRef.current.hapticsEnabled,
                navigator.vibrate?.bind(navigator),
              );
            });
          }
          if (suggestion?.kind === "broadcast") {
            simulation.emitWorldSound({
              position: mechanicPosition,
              strength: 0.66,
              sourceType: "environment-hazard",
              sourceId: suggestion.suggestionId,
              confidence: 0.86,
              decayPerSecond: 0.12,
            });
          } else if (suggestion?.kind === "blackout") {
            applyStealthEvidenceCommand({
              type: "record",
              tick: nextTick,
              observation: {
                kind: "power-change",
                position: mechanicPosition,
                source: {
                  publicId: suggestion.publicChannelId
                    ?? `${campaignLevel.id}:lighting-grid`,
                  kind: "power-grid",
                  publicity: "publicly-announced",
                },
                detail: { state: "unstable" },
                confidenceScale: 0.92,
              },
            }, false);
          }
          stealthNotice = suggestion
            ? `环境事件 · ${suggestion.label}已开始`
            : "环境事件已开始";
          stealthNoticeUntilTick = nextTick + 180;
        } else if (
          event.type === "event-ended"
          || event.type === "event-cancelled"
        ) {
          stealthNotice = event.reason === "completed"
            ? "环境压力窗口结束 · 进入喘息期"
            : "环境事件已按公平保护规则撤销";
          stealthNoticeUntilTick = nextTick + 150;
        }
      }
      if (directorStep.lifecycleEvents.length > 0) {
        const activeDirectorEvent = tensionDirectorState.activeEvent;
        const uiState: TensionDirectorUiState = {
          tier: tensionDirectorState.tier,
          score: tensionDirectorState.score,
          phase: activeDirectorEvent?.phase ?? "idle",
          kind: activeDirectorEvent?.suggestion.kind ?? null,
          label: activeDirectorEvent?.suggestion.label
            ?? (tensionDirectorState.tier === "rest"
              ? "公平节奏导演待机"
              : "环境压力正在评估"),
          progress: 0,
        };
        presentationEffects.push(() => setTensionDirector(uiState));
      }
    };

    /**
     * Runs once, and only once, after each authoritative 60 Hz simulation
     * step. Evidence/tool progression consumes the resulting public world
     * state; the director already advanced before input construction.
     */
    const processStealthFixedStep = (
      state: GameState,
      simulationInput: SimulationInput,
    ) => {
      const auxiliaryTick = state.tick;
      if (auxiliaryTick !== lastStealthAuxiliaryTick + 1) {
        throw new Error(
          `Stealth fixed-step sequence gap: expected ${
            lastStealthAuxiliaryTick + 1
          }, received ${auxiliaryTick}`,
        );
      }

      applyStealthEvidenceCommand({
        type: "advance",
        tick: auxiliaryTick,
      }, false);
      const toolStep = advanceStealthToolbelt(
        stealthToolbeltState,
        auxiliaryTick,
      );
      stealthToolbeltState = toolStep.state;
      for (const event of toolStep.events) {
        if (event.type === "tool-commitment-completed") {
          createStealthToolWorldView(event.receipt);
          let observation: PublicEvidenceObservation;
          if (event.receipt.tool === "door-wedge") {
            observation = {
              kind: "door-state",
              position: event.receipt.riskEvidence.position,
              source: {
                publicId: event.receipt.effect.doorId,
                kind: "door",
                publicity: "world-observable",
              },
              detail: { state: "forced" },
              confidenceScale: event.receipt.riskEvidence.confidence,
            };
          } else if (event.receipt.tool === "corner-mirror") {
            observation = {
              kind: "moved-object",
              position: event.receipt.riskEvidence.position,
              source: {
                publicId: event.receipt.effect.cornerId,
                kind: "object",
                publicity: "world-observable",
              },
              detail: { state: "moved" },
              confidenceScale: event.receipt.riskEvidence.confidence,
            };
          } else {
            observation = {
              kind: "power-change",
              position: event.receipt.riskEvidence.position,
              source: {
                publicId: event.receipt.effect.circuitId,
                kind: "power-grid",
                publicity: "publicly-announced",
              },
              detail: { state: "offline" },
              confidenceScale: event.receipt.riskEvidence.confidence,
            };
          }
          applyStealthEvidenceCommand({
            type: "record",
            tick: auxiliaryTick,
            observation,
          }, false);
          soundscape.triggerWorldSound({
            listenerPosition: state.player.position,
            sourcePosition: event.receipt.riskEvidence.position,
            kind: "theme-event",
            maxDistance: event.tool === "temporary-blackout" ? 15 : 8,
            baseGain: event.tool === "temporary-blackout"
              ? 0.18
              : event.tool === "door-wedge"
                ? 0.14
                : 0.08,
            occlusion: hasLineOfSight(
              campaignLevel,
              state.player.position,
              event.receipt.riskEvidence.position,
            ) ? 0 : 0.45,
            foleySet: event.tool === "corner-mirror"
              ? "cloth"
              : "metal-hit",
            playbackRate: event.tool === "temporary-blackout"
              ? 0.66
              : event.tool === "door-wedge"
                ? 1.22
                : 1.08,
          });
          stealthNotice = `${STEALTH_TOOL_UI[event.tool].label}已生效 · 风险线索已留在现场`;
          stealthNoticeUntilTick = auxiliaryTick + 210;
        } else if (event.type === "tool-risk-emitted") {
          if (event.evidence.channel !== "visual") {
            simulation.emitWorldSound({
              position: event.evidence.position,
              strength: event.evidence.strength,
              sourceType: event.evidence.channel === "infrastructure"
                ? "environment-hazard"
                : "player-movement",
              sourceId: event.evidence.sourceId,
              confidence: event.evidence.confidence,
              decayPerSecond: 0.16,
            });
          }
        } else if (event.type === "tool-effect-ended") {
          const view = stealthToolWorldViews.get(event.receiptId);
          if (view) disposeStealthToolWorldView(view);
        }
      }

      const moveIntent = simulationInput.move ?? { x: 0, y: 0 };
      const playerMovedSinceFootprint = distanceBetween(
        state.player.position,
        lastFootprintPosition,
      );
      if (
        state.phase === "playing"
        && state.player.mode === "free"
        && Math.hypot(moveIntent.x, moveIntent.y) > 0.4
        && !simulationInput.sneakHeld
        && playerMovedSinceFootprint >= 0.72
        && auxiliaryTick - lastFootprintTick >= 34
      ) {
        applyStealthEvidenceCommand({
          type: "record",
          tick: auxiliaryTick,
          observation: {
            kind: "footprint",
            position: { ...state.player.position },
            source: {
              publicId: `${campaignLevel.id}:floor:${auxiliaryTick}`,
              kind: "surface",
              publicity: "world-observable",
            },
            detail: { direction: { ...state.player.heading } },
          },
        }, false);
        lastFootprintTick = auxiliaryTick;
        lastFootprintPosition = { ...state.player.position };
      }

      for (const event of state.events) {
        if (
          event.type === "player-mode-changed"
          && (event.to === "entering-hide" || event.to === "exiting-hide")
        ) {
          const spot = state.player.hideSpotId
            ? campaignLevel.hideSpots.find(
                ({ id }) => id === state.player.hideSpotId,
              )
            : null;
          if (spot) {
            applyStealthEvidenceCommand({
              type: "record",
              tick: auxiliaryTick,
              observation: {
                kind: "door-state",
                position: spot.approach,
                source: {
                  publicId: `${campaignLevel.id}:hide-door:${spot.id}`,
                  kind: "door",
                  publicity: "world-observable",
                },
                detail: {
                  state: event.to === "entering-hide" ? "closed" : "open",
                },
              },
            }, false);
          }
        }
        if (
          event.type === "evidence-investigation-completed"
          && stealthEvidenceState.records.some(
            ({ id }) => id === event.evidenceId,
          )
        ) {
          investigatedEvidenceIds.add(event.evidenceId);
          stealthNotice = "追捕者已检查公开线索，正在左右巡视";
          stealthNoticeUntilTick = auxiliaryTick + 180;
        }
      }

      const aiObservationIntervalTicks = Math.max(
        1,
        Math.round(
          simulation.config.aiTickSeconds
            / simulation.config.fixedStepSeconds,
        ),
      );
      const observedEvidence = auxiliaryTick % aiObservationIntervalTicks === 0
        ? queryStealthEvidenceForAi(
          stealthEvidenceState,
          {
            atTick: auxiliaryTick,
            observer: {
              position: state.chaser.position,
              heading: state.chaser.heading,
            },
            maximumDistance:
              simulation.config.visionRange
              * (simulationInput.visionRangeMultiplier ?? 1),
            fieldOfViewDegrees: Math.min(
              180,
              simulation.config.visionConeDegrees + 24,
            ),
            minimumConfidence: 0.16,
          },
          {
            isVisible: (observerPosition, evidencePosition) => (
              hasLineOfSight(
                campaignLevel,
                observerPosition,
                evidencePosition,
              )
            ),
          },
        ).find(({ evidence }) => !deliveredEvidenceIds.has(evidence.id))
        : undefined;
      if (observedEvidence) {
        const accepted = simulation.emitWorldClue(
          aiEvidenceCandidateToPerception(
            observedEvidence,
            state.elapsedSeconds,
          ),
        );
        if (accepted) deliveredEvidenceIds.add(observedEvidence.evidence.id);
      }
      lastStealthAuxiliaryTick = auxiliaryTick;
    };

    const animate = (now: number) => {
      const delta = boundedFrameDeltaSeconds(last, now, simulation.config.maxFrameDeltaSeconds);
      last = now;
      if (
        qaCaptureHoldRequested
        && now >= qaCaptureHoldDeadline
      ) {
        // A browser-side lease keeps an interrupted CDP harness from leaving
        // the QA page permanently frozen after the controller disconnects.
        qaCaptureHoldRequested = false;
        qaCaptureHoldAcknowledged = false;
        qaCaptureHoldDeadline = 0;
      }
      if (qaCaptureHoldRequested) {
        qaCaptureHoldAcknowledged = true;
        frame = requestAnimationFrame(animate);
        return;
      }
      qaCaptureHoldAcknowledged = false;
      if (ready && !pausedRef.current) {
        if (!qaRenderQualityLocked) {
          qualitySamples.push(delta * 1_000);
          qualityEvaluationSeconds += delta;
        }
        if (
          !qaRenderQualityLocked
          && qualityEvaluationSeconds >= 1
          && qualitySamples.length >= 20
        ) {
          const sampleWindowSeconds = qualityEvaluationSeconds;
          const sortedSamples = [...qualitySamples].sort((left, right) => left - right);
          const p95 = sortedSamples[Math.min(
            sortedSamples.length - 1,
            Math.floor(sortedSamples.length * 0.95),
          )];
          const workload = {
            visibleTriangles: renderer.info.render.triangles,
            drawCalls: renderer.info.render.calls,
            ...estimateShadowWorkload(),
          };
          const candidate = nextRenderQuality(renderQualityTier, p95, 999, workload);
          if (candidate !== renderQualityTier) {
            if (candidate === qualityCandidate) qualityDecisionSeconds += qualityEvaluationSeconds;
            else {
              qualityCandidate = candidate;
              qualityDecisionSeconds = qualityEvaluationSeconds;
            }
            const resolved = nextRenderQuality(
              renderQualityTier,
              p95,
              qualityDecisionSeconds,
              workload,
            );
            if (resolved !== renderQualityTier) {
              applyRenderQuality(resolved);
              qualityCandidate = resolved;
              qualityDecisionSeconds = 0;
            }
          } else {
            qualityCandidate = renderQualityTier;
            qualityDecisionSeconds = 0;
          }
          const nextEmergency = updateEmergencyDegradation(
            emergencyDegradation,
            {
              tier: renderQualityTier,
              p95FrameMilliseconds: p95,
              elapsedSeconds: sampleWindowSeconds,
              workload,
            },
          );
          if (nextEmergency.level !== emergencyDegradation.level) {
            emergencyQualityTransitionCount += 1;
            emergencyDegradation = nextEmergency;
            applyRenderQuality(renderQualityTier);
          } else {
            emergencyDegradation = nextEmergency;
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
        const renderedAtmosphereParticles = Math.min(
          atmosphereParticleCount,
          Math.max(0, atmosphereGeometry.drawRange.count),
        );
        for (let index = 0; index < renderedAtmosphereParticles; index += 1) {
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
        atmosphereAttribute.clearUpdateRanges();
        if (renderedAtmosphereParticles > 0) {
          atmosphereAttribute.addUpdateRange(0, renderedAtmosphereParticles * 3);
          atmosphereAttribute.needsUpdate = true;
        }
        updateDeferredDressingFade(delta);

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
        const screenMove = combineScreenMove(
          { x: dx / length, y: dy / length },
          analogueMove.current,
        );
        const move = screenMoveToWorld(screenMove);
        const frameEdges: FixedStepHostEdges = {
          interactionPressed: interactPressed.current,
          portableDecoyPressed: portableDecoyPressed.current,
          stealthToolPressed: stealthToolPressed.current,
          evidenceErasePressed: evidenceErasePressed.current,
        };
        interactPressed.current = false;
        portableDecoyPressed.current = false;
        stealthToolPressed.current = false;
        evidenceErasePressed.current = false;
        const simulationAcceptsFixedTicks = latestState.phase === "playing";
        let fixedStepTicks: readonly FixedStepHostTick[] = [];
        if (simulationAcceptsFixedTicks) {
          const fixedStepFrame = advanceFixedStepHostFrame(
            fixedStepHost,
            delta,
            frameEdges,
          );
          fixedStepHost = fixedStepFrame.state;
          fixedStepTicks = fixedStepFrame.ticks;
        } else if (
          fixedStepHost.clock.tick !== latestState.tick
          || fixedStepHost.clock.remainderSeconds !== 0
          || fixedStepHost.pendingEdges.interactionPressed
          || fixedStepHost.pendingEdges.portableDecoyPressed
          || fixedStepHost.pendingEdges.stealthToolPressed
          || fixedStepHost.pendingEdges.evidenceErasePressed
        ) {
          fixedStepHost = resetFixedStepHost(fixedStepHost, latestState.tick);
        }
        const simulationFrameEvents: GameState["events"] = [];
        const fixedStepSeconds = simulation.config.fixedStepSeconds;
        const causalEvents: RunCausalEvent[] = [];
        const presentationEffects: Array<() => void> = [];
        if (pendingRouteSelectionTelemetry && selectedLibraryPlanDefinition) {
          causalEvents.push({
            type: "route-selected",
            routeId: selectedLibraryPlanDefinition.id,
          });
          pendingRouteSelectionTelemetry = false;
        }
        let environment = sampleMechanicInstance(
          mechanicInstance,
          latestState.player.position,
        );
        for (
          let fixedStepIndex = 0;
          fixedStepIndex < fixedStepTicks.length;
          fixedStepIndex += 1
        ) {
          const hostTick = fixedStepTicks[fixedStepIndex];
          if (latestState.phase !== "playing") {
            fixedStepHost = resetFixedStepHost(
              fixedStepHost,
              latestState.tick,
            );
            break;
          }
          const interactionEdge = hostTick.edges.interactionPressed;
        const beforeMechanic = sampleMechanicInstance(
          mechanicInstance,
          latestState.player.position,
        );
        const hideInteractionBeforeStep = simulation.getHideInteraction();
        const activeMissionObjective = missionObjectiveForPlayer(
          latestState.player.position,
        );
        const ruleEventTick = latestState.tick;
        if (
          missionCommitment
          && (
            latestState.phase !== "playing"
            || activeMissionObjective?.objective.id !== missionCommitment.objectiveId
            || distanceBetween(
              latestState.player.position,
              activeMissionObjective.position,
            ) > 1.55
          )
        ) {
          missionCommitment = null;
        }
        portableDecoyThrowRemainingSeconds = Math.max(
          0,
          (portableDecoyState?.activeDeployment?.soundAtSeconds ?? 0)
            - latestState.elapsedSeconds,
        );
        const portableDecoyEdge = hostTick.edges.portableDecoyPressed;
        if (
          portableDecoyEdge
          && !interactionEdge
        ) {
          if (hideInteractionBeforeStep) {
            portableDecoyFeedback = "先离开藏点交互范围，再投掷精装笔记本";
            portableDecoyFeedbackUntilSeconds = latestState.elapsedSeconds + 2.4;
            const notice = portableDecoyFeedback;
            presentationEffects.push(() => setPortableDecoyNotice(notice));
          } else {
            attemptPortableDecoyDeployment(presentationEffects);
          }
        }
        const stealthToolEdge = hostTick.edges.stealthToolPressed;
        const evidenceEraseEdge = hostTick.edges.evidenceErasePressed;
        if (stealthToolEdge && !interactionEdge && !portableDecoyEdge) {
          attemptStealthToolUse();
        }
        if (
          evidenceEraseEdge
          && !interactionEdge
          && !portableDecoyEdge
          && !stealthToolEdge
        ) {
          attemptEvidenceErase();
        }
        let completedMissionObjective: typeof activeMissionObjective = null;
        if (missionCommitment && activeMissionObjective) {
          missionCommitment.remainingSeconds = Math.max(
            0,
            (missionCommitment.completesAtTick - latestState.tick)
              * simulation.config.fixedStepSeconds,
          );
          if (latestState.tick >= missionCommitment.completesAtTick) {
            completedMissionObjective = activeMissionObjective;
            missionCommitment = null;
          }
        }
        const missionCanActivate = Boolean(
          activeMissionObjective
          && latestState.phase === "playing"
          && !hasPlayerActionCommitment()
          && distanceBetween(
            latestState.player.position,
            activeMissionObjective.position,
          ) <= 1.35,
        );
        const missionInteractionReserved = missionCanActivate
          || missionCommitment !== null;
        const activeBlackoutReceipt =
          stealthToolbeltState.activeEffects["temporary-blackout"]?.receipt;
        const toolBlackoutInteractionLocked =
          activeBlackoutReceipt?.tool === "temporary-blackout"
          && latestState.tick < activeBlackoutReceipt.expiresAtTick;
        const activeDirectorInteractionEvent =
          tensionDirectorState.activeEvent;
        const directorBlackoutInteractionLocked = Boolean(
          activeDirectorInteractionEvent?.phase === "active"
          && activeDirectorInteractionEvent.suggestion.kind === "blackout"
          && latestState.tick
            < activeDirectorInteractionEvent.suggestion.endsAtTick,
        );
        const stealthBlackoutInteractionLocked =
          toolBlackoutInteractionLocked
          || directorBlackoutInteractionLocked;
        const mechanicConsumesInteraction = beforeMechanic.canActivate
          && hideInteractionBeforeStep === null
          && !missionInteractionReserved
          && !stealthBlackoutInteractionLocked
          && !hasPlayerActionCommitment();
        const missionConsumesInteraction = interactionEdge
          && hideInteractionBeforeStep === null
          && missionInteractionReserved;
        if (
          missionConsumesInteraction
          && missionCanActivate
          && activeMissionObjective
        ) {
          const commitmentWindow = libraryMissionCommitmentWindow(
            latestState.tick,
            activeMissionObjective.objective.commitmentSeconds,
            simulation.config.fixedStepSeconds,
          );
          missionCommitment = {
            objectiveId: activeMissionObjective.objective.id,
            startedAtTick: commitmentWindow.startedAtTick,
            durationTicks: commitmentWindow.durationTicks,
            completesAtTick: commitmentWindow.completesAtTick,
            remainingSeconds: commitmentWindow.durationSeconds,
            totalSeconds: commitmentWindow.durationSeconds,
          };
          presentationEffects.push(() => {
            playHapticCue(
              "theme-warning",
              preferencesRef.current.hapticsEnabled,
              navigator.vibrate?.bind(navigator),
            );
          });
        }
        if (completedMissionObjective) {
          if (libraryMissionState) {
            const previousLibraryState = libraryMissionState;
            const libraryStep = stepLibraryBranchingMission(
              LIBRARY_BRANCHING_MISSION,
              libraryMissionState,
              {
                type: "attempt-objective",
                objectiveId: completedMissionObjective.objective.id,
                outcome: "completed",
              },
            );
            libraryMissionState = libraryStep.state;
            const compatibilityStep = adaptLibraryMissionTransitionToThemeMission(
              previousLibraryState,
              libraryMissionState,
            );
            missionState = compatibilityStep.state;
            recordLibraryMissionRuleEvents(libraryStep.events, ruleEventTick);
            if (completedMissionObjective.objective.planId === "fire-release") {
              const fireReleaseNoise = {
                position: completedMissionObjective.position,
                strength: completedMissionObjective.objective.unlocksExit ? 0.92 : 0.76,
                sourceType: "environment-hazard" as const,
                sourceId: `library-fire-route:${completedMissionObjective.objective.id}`,
                confidence: 0.94,
                decayPerSecond: 0.1,
              };
              simulation.emitWorldSound(fireReleaseNoise);
              const listenerPosition = { ...latestState.player.position };
              const objectivePosition = { ...completedMissionObjective.position };
              const unlocksExit =
                completedMissionObjective.objective.unlocksExit;
              presentationEffects.push(() => {
                soundscape.triggerWorldSound({
                  listenerPosition,
                  sourcePosition: objectivePosition,
                  kind: "objective",
                  maxDistance: Math.max(
                    12,
                    simulation.config.hearingRange * 1.6,
                  ),
                  baseGain: unlocksExit ? 0.48 : 0.36,
                  occlusion: hasLineOfSight(
                    campaignLevel,
                    listenerPosition,
                    objectivePosition,
                  ) ? 0 : 0.52,
                  foleySet: "metal-hit",
                  playbackRate: unlocksExit ? 0.82 : 1.08,
                });
              });
            }
          } else {
            const missionStep = stepThemeMission(
              missionDefinition,
              missionState,
              completedMissionObjective.objective.id,
            );
            missionState = missionStep.state;
            recordPlayerRuleEvent({
              tick: ruleEventTick,
              type: "objective-completed",
              objectiveId: completedMissionObjective.objective.id,
            });
            if (missionState.exitUnlocked) {
              recordPlayerRuleEvent({
                tick: ruleEventTick,
                type: "exit-unlocked",
                objectiveId: completedMissionObjective.objective.id,
              });
            }
          }
          const missionExitUnlocked = missionState.exitUnlocked;
          const listenerPosition = { ...latestState.player.position };
          const objectivePosition = { ...completedMissionObjective.position };
          presentationEffects.push(() => {
            playHapticCue(
              missionExitUnlocked ? "escaped" : "hide-latched",
              preferencesRef.current.hapticsEnabled,
              navigator.vibrate?.bind(navigator),
            );
            soundscape.triggerWorldSound({
              listenerPosition,
              sourcePosition: objectivePosition,
              kind: "theme-event",
              maxDistance: 12,
              baseGain: missionExitUnlocked ? 0.5 : 0.34,
              occlusion: 0,
              foleySet: campaignLevel.campaign.theme === "factory"
                ? "metal-hit"
                : campaignLevel.campaign.theme === "fire-station"
                  ? "cloth"
                  : "locker-latch",
              playbackRate: missionExitUnlocked ? 1.12 : 0.94,
            });
          });
        }
        const mechanicStep = stepMechanicInstance(mechanicInstance, {
          deltaSeconds: fixedStepSeconds,
          nowSeconds: latestState.elapsedSeconds + fixedStepSeconds,
          activationRequested: interactionEdge
            && mechanicConsumesInteraction
            && !missionConsumesInteraction,
          actorPosition: latestState.player.position,
        });
        mechanicInstance = mechanicStep.instance;
        environment = mechanicStep.sample;
        const environmentPlaying = latestState.phase === "playing";
        const activationCostApplied = mechanicStep.events.some(
          (event) => event.type === "activation-cost-applied",
        );
        if (environmentPlaying && activationCostApplied) {
          recordPlayerRuleEvent({
            tick: ruleEventTick,
            type: "mechanic-committed",
            mechanicId: mechanicDefinition.id,
          });
          const activationNoise = mechanicActivationNoiseStimulus(mechanicDefinition);
          if (activationNoise) {
            simulation.emitWorldSound(activationNoise);
            const listenerPosition = { ...latestState.player.position };
            presentationEffects.push(() => {
              soundscape.triggerWorldSound({
                listenerPosition,
                sourcePosition: activationNoise.position,
                kind: "theme-event",
                maxDistance: Math.max(
                  9,
                  simulation.config.hearingRange * 1.5,
                ),
                baseGain:
                  0.28 + mechanicDefinition.activationCost.amount * 0.18,
                occlusion: 0,
                foleySet: campaignLevel.campaign.theme === "factory"
                  ? "metal-hit"
                  : "locker-latch",
                playbackRate: campaignLevel.campaign.theme === "campus"
                  ? 1.14
                  : 0.9,
              });
            });
          }
        }
        if (mechanicStep.events.some((event) => event.type === "activated")) {
          causalEvents.push({
            type: "theme-mechanic-used",
            mechanicId: mechanicDefinition.id,
          });
          presentationEffects.push(() => {
            playHapticCue(
              "theme-warning",
              preferencesRef.current.hapticsEnabled,
              navigator.vibrate?.bind(navigator),
            );
          });
        }
        const emittedMechanicSound = mechanicStep.emittedSoundStimulus;
        if (
          emittedMechanicSound?.sourceType === "environment-decoy"
          && emittedMechanicSound.sourceId
        ) {
          causalEvents.push({
            type: "decoy-deployed",
            decoyId: emittedMechanicSound.sourceId,
          });
        }
        if (environmentPlaying && emittedMechanicSound) {
          simulation.emitWorldSound(emittedMechanicSound);
          const listenerPosition = { ...latestState.player.position };
          presentationEffects.push(() => {
            soundscape.triggerWorldSound({
              listenerPosition,
              sourcePosition: emittedMechanicSound.position,
              kind: "theme-event",
              maxDistance: Math.max(10, mechanicDefinition.effectRadius * 2),
              baseGain: 0.32,
              occlusion: hasLineOfSight(
                campaignLevel,
                listenerPosition,
                emittedMechanicSound.position,
              ) ? 0 : 0.58,
              foleySet: campaignLevel.campaign.theme === "factory"
                ? "metal-hit"
                : campaignLevel.campaign.theme === "fire-station"
                  ? "cloth"
                  : "locker-latch",
              playbackRate: campaignLevel.campaign.theme === "hospital"
                ? 1.18
                : 0.92,
            });
          });
        }
        if (environmentPlaying && portableDecoyState) {
          const activeSourceId = portableDecoyState.activeDeployment?.sourceId;
          const investigation = activeSourceId
            ? latestState.events.find((event) => (
                event.type === "evidence-investigation-completed"
                && event.sourceType === "environment-decoy"
                && event.evidenceId === activeSourceId
              ))
            : null;
          const completedInvestigation = investigation?.type
            === "evidence-investigation-completed"
              ? {
                sourceId: investigation.evidenceId,
                sourceType: "environment-decoy" as const,
                completedAtSeconds: investigation.completedAtSeconds,
              }
            : null;
          const decoyNowSeconds = Math.max(
            portableDecoyState.updatedAtSeconds,
            latestState.elapsedSeconds,
          );
          const decoyStep = stepPortableDecoy(portableDecoyState, {
            nowSeconds: decoyNowSeconds,
            deltaSeconds: Math.max(
              0,
              decoyNowSeconds - portableDecoyState.updatedAtSeconds,
            ),
            ...(completedInvestigation
              ? { completedInvestigation }
              : {}),
          });
          portableDecoyState = decoyStep.state;
          const pendingDecoySound = decoyStep.pendingSoundStimulus;
          let soundAcknowledged = false;
          if (pendingDecoySound?.sourceId) {
            const alreadyScheduled = scheduledPortableDecoySourceIds.has(
              pendingDecoySound.sourceId,
            );
            const acceptedBySimulation = alreadyScheduled
              || simulation.scheduleWorldSound(
                pendingDecoySound,
                portableDecoyState.activeDeployment?.soundAtSeconds
                  ?? decoyNowSeconds,
              );
            if (acceptedBySimulation) {
              if (!alreadyScheduled) {
                scheduledPortableDecoySourceIds.add(pendingDecoySound.sourceId);
                portableDecoyPublicSoundAcceptedCount += 1;
              }
              const acknowledgement = acknowledgePortableDecoySound(
                portableDecoyState,
                {
                  nowSeconds: decoyNowSeconds,
                  sourceId: pendingDecoySound.sourceId,
                },
              );
              if (acknowledgement.acknowledged) {
                portableDecoyState = acknowledgement.state;
                scheduledPortableDecoySourceIds.delete(
                  pendingDecoySound.sourceId,
                );
                soundAcknowledged = true;
                portableDecoyLastLifecycleEvent = "public-sound-acknowledged";
                causalEvents.push({
                  type: "decoy-deployed",
                  decoyId: pendingDecoySound.sourceId,
                });
              }
            }
          }
          if (soundAcknowledged && pendingDecoySound) {
            const listenerPosition = { ...latestState.player.position };
            presentationEffects.push(() => {
              const occlusion = hasLineOfSight(
                campaignLevel,
                listenerPosition,
                pendingDecoySound.position,
              ) ? 0 : 0.55;
              soundscape.triggerWorldSound({
                listenerPosition,
                sourcePosition: pendingDecoySound.position,
                kind: "theme-event",
                maxDistance: Math.max(
                  11,
                  simulation.config.hearingRange * 1.55,
                ),
                baseGain: 0.38,
                occlusion,
                foleySet: "cloth",
                playbackRate: 0.9,
              });
              soundscape.triggerWorldSound({
                listenerPosition,
                sourcePosition: pendingDecoySound.position,
                kind: "objective",
                maxDistance: Math.max(
                  11,
                  simulation.config.hearingRange * 1.55,
                ),
                baseGain: 0.16,
                occlusion,
                foleySet: "metal-hit",
                playbackRate: 1.26,
              });
            });
            portableDecoyFeedback = "笔记本已落地 · 追捕者只能依据公开声源调查";
            portableDecoyFeedbackUntilSeconds = latestState.elapsedSeconds + 2.8;
          }
          if (decoyStep.events.some((event) => event.type === "investigation-completed")) {
            portableDecoyInvestigationCompletedCount += 1;
            portableDecoyLastLifecycleEvent = "investigation-completed";
            portableDecoyFeedback = "声源调查结束 · 追捕者重新进入搜索";
            portableDecoyFeedbackUntilSeconds = latestState.elapsedSeconds + 3;
          } else if (decoyStep.events.some((event) => event.type === "expired")) {
            if (activeSourceId) {
              scheduledPortableDecoySourceIds.delete(activeSourceId);
            }
            portableDecoyLastLifecycleEvent = "expired";
            portableDecoyFeedback = portableDecoyState.inventoryRemaining > 0
              ? "诱饵调查窗口结束 · 下一枚已经可用"
              : "诱饵调查窗口结束";
            portableDecoyFeedbackUntilSeconds = latestState.elapsedSeconds + 2.2;
          }
        }
        const mechanicMovementCommitted = environmentPlaying
          && mechanicRequiresMovementCommitment(mechanicInstance);
        const missionMovementCommitted = environmentPlaying
          && missionCommitment !== null;
        const portableDecoyMovementCommitted = environmentPlaying
          && portableDecoyThrowRemainingSeconds > 0;
        const stealthInteractionBlocked = environmentPlaying
          && (
            stealthToolbeltState.commitment !== null
            || latestState.tick
              < stealthEvidenceState.countermeasureBusyUntilTick
          );
        const simulationInteract = interactionEdge
          && !mechanicConsumesInteraction
          && !missionConsumesInteraction
          && !portableDecoyMovementCommitted
          && !stealthInteractionBlocked;
        advanceDirectorForSimulationTick(
          latestState,
          hostTick.tick,
          presentationEffects,
        );

        const buildSimulationInput = (
          interactPressedForStep: boolean,
        ): SimulationInput => {
          const nextTick = latestState.tick + 1;
          const stealthToolMovementCommitted = environmentPlaying
            && stealthToolbeltState.commitment !== null;
          const countermeasureMovementCommitted = environmentPlaying
            && nextTick <= stealthEvidenceState.countermeasureBusyUntilTick;
          const movementCommitted = mechanicMovementCommitted
            || missionMovementCommitted
            || portableDecoyMovementCommitted
            || stealthToolMovementCommitted
            || countermeasureMovementCommitted;
          const directorSuggestion =
            tensionDirectorState.activeEvent?.suggestion ?? null;
          const directorEventActive =
            tensionDirectorState.activeEvent?.phase === "active"
            && Boolean(
              directorSuggestion
              && nextTick < directorSuggestion.endsAtTick,
            );
          const directorModifiers = tensionDirectorModifiers(
            directorSuggestion,
            directorEventActive,
          );
          const activeBlackout =
            stealthToolbeltState.activeEffects["temporary-blackout"]?.receipt;
          const blackoutIsActive =
            activeBlackout?.tool === "temporary-blackout"
            && nextTick < activeBlackout.expiresAtTick;
          const blackoutVisionMultiplier = blackoutIsActive
            ? activeBlackout.effect.visionRangeMultiplier
            : 1;
          const blackoutSoundMasking = blackoutIsActive
            ? activeBlackout.effect.ambientSoundMasking
            : 0;
          const activeDoorWedge =
            stealthToolbeltState.activeEffects["door-wedge"]?.receipt;
          let wedgeSpeedMultiplier = 1;
          if (
            activeDoorWedge?.tool === "door-wedge"
            && nextTick < activeDoorWedge.expiresAtTick
            && isDoorWedgeTraversalAttempt(
              activeDoorWedge,
              latestState.chaser.position,
              latestState.chaser.heading,
            )
          ) {
            const previousHold = triggeredDoorWedges.get(
              activeDoorWedge.receiptId,
            );
            if (previousHold === undefined) {
              activeWedgeHoldUntilTick = nextTick
                + activeDoorWedge.effect.delayTicksPerAttempt;
              triggeredDoorWedges.set(
                activeDoorWedge.receiptId,
                activeWedgeHoldUntilTick,
              );
              stealthNotice = "门楔咬合 · 追捕者正在强行推门";
              stealthNoticeUntilTick = nextTick + 150;
              const listenerPosition = { ...latestState.player.position };
              presentationEffects.push(() => {
                soundscape.triggerWorldSound({
                  listenerPosition,
                  sourcePosition: activeDoorWedge.riskEvidence.position,
                  kind: "theme-event",
                  maxDistance: 11,
                  baseGain: 0.34,
                  occlusion: hasLineOfSight(
                    campaignLevel,
                    listenerPosition,
                    activeDoorWedge.riskEvidence.position,
                  ) ? 0 : 0.5,
                  foleySet: "metal-hit",
                  playbackRate: 0.84,
                });
              });
            } else {
              activeWedgeHoldUntilTick = previousHold;
            }
            if (nextTick < activeWedgeHoldUntilTick) {
              wedgeSpeedMultiplier = 0;
            }
          }
          const combinedSoundMasking = 1 - (
            (1 - environment.soundMasking)
            * (1 - blackoutSoundMasking)
            * (1 - directorModifiers.soundMasking)
          );
          const baselinePerceptionEnvironment = {
            environmentSoundMasking: environment.soundMasking,
            visionRangeMultiplier: environment.visionRangeMultiplier,
          };
          return {
            // Keep the authored environment as the explicit baseline contract;
            // temporary effects may only tighten these values.
            ...baselinePerceptionEnvironment,
            environmentSoundMasking: combinedSoundMasking,
            visionRangeMultiplier: Math.min(
              environment.visionRangeMultiplier,
              blackoutVisionMultiplier,
              directorModifiers.visionRangeMultiplier,
            ),
            chaserSpeedMultiplier:
              wedgeSpeedMultiplier * directorModifiers.chaserSpeedMultiplier,
            move: movementCommitted ? { x: 0, y: 0 } : move,
            interactPressed: interactPressedForStep && !movementCommitted,
            peekHeld: held("q"),
            sneakHeld: movementCommitted ? false : held("q"),
            exitEnabled: missionState.exitUnlocked,
            hideExitChoice: preferredHideExit.current,
          };
        };

          const recordingTick = latestState.tick;
          const simulationInput = buildSimulationInput(
            simulationInteract,
          );
          if (latestState.phase === "playing") {
            ghostInputBuffer.stage(recordingTick, simulationInput);
          }
          const previousTick = latestState.tick;
          latestState = simulation.advance(
            fixedStepSeconds,
            simulationInput,
          );
          if (latestState.tick > previousTick) {
            const expectedTick = hostTick.tick;
            if (latestState.tick !== expectedTick) {
              throw new Error(
                `Simulation fixed-step drift: expected ${expectedTick}, received ${
                  latestState.tick
                }`,
              );
            }
            simulationFrameEvents.push(...latestState.events);
            processStealthFixedStep(latestState, simulationInput);
            const committedGhostInput = ghostInputBuffer.consumeIfAdvanced(
              latestState.tick,
            );
            if (committedGhostInput) {
              ghostRecorder.record(
                committedGhostInput.tick,
                committedGhostInput.input,
              );
            }
          }
        }
        for (const effect of presentationEffects) effect();
        const environmentActivity =
          latestState.phase === "playing" && environment.phase === "active"
            ? Math.sin(environment.progress * Math.PI)
            : 0;
        const stealthSoundscapeActivity =
          stealthToolbeltState.activeEffects["temporary-blackout"]
            ? 0.72
            : tensionDirectorState.activeEvent?.phase === "active"
              ? 0.54
              : tensionDirectorState.activeEvent?.phase === "warning"
                ? 0.22
                : 0;
        soundscape.setThemeMechanicActivity(
          Math.max(environmentActivity, stealthSoundscapeActivity),
        );
        latestState = {
          ...latestState,
          events: simulationFrameEvents,
        };
        if (missionCommitment) {
          missionCommitment.remainingSeconds = Math.max(
            0,
            (missionCommitment.completesAtTick - latestState.tick)
              * simulation.config.fixedStepSeconds,
          );
        }
        portableDecoyThrowRemainingSeconds = Math.max(
          0,
          (portableDecoyState?.activeDeployment?.soundAtSeconds ?? 0)
            - latestState.elapsedSeconds,
        );
        updatePortableDecoyViews(latestState.elapsedSeconds);
        const activeMirrorReceipt =
          stealthToolbeltState.activeEffects["corner-mirror"]?.receipt;
        mirrorThreatVisible = Boolean(
          activeMirrorReceipt?.tool === "corner-mirror"
          && canCornerMirrorObservePoint(
            activeMirrorReceipt,
            latestState.chaser.position,
            campaignLevel,
          ),
        );
        // Critical perception cues follow the authoritative runtime every
        // frame; the heavier React HUD snapshot may remain throttled.
        const runtimePlayfield = host.parentElement;
        if (runtimePlayfield?.classList.contains("playfield")) {
          const blackoutReceipt =
            stealthToolbeltState.activeEffects["temporary-blackout"]?.receipt;
          const activeDirectorEvent = tensionDirectorState.activeEvent;
          const directorBlackoutActive = Boolean(
            activeDirectorEvent?.phase === "active"
            && activeDirectorEvent.suggestion.kind === "blackout"
            && latestState.tick < activeDirectorEvent.suggestion.endsAtTick,
          );
          runtimePlayfield.classList.toggle(
            "stealth-blackout-active",
            (
              blackoutReceipt?.tool === "temporary-blackout"
              && latestState.tick < blackoutReceipt.expiresAtTick
            ) || directorBlackoutActive,
          );
          runtimePlayfield.classList.toggle(
            "mirror-threat-visible",
            mirrorThreatVisible,
          );
          runtimePlayfield.classList.toggle(
            "director-warning",
            activeDirectorEvent?.phase === "warning",
          );
          runtimePlayfield.classList.toggle(
            "director-active",
            activeDirectorEvent?.phase === "active",
          );
          const directorProgress = activeDirectorEvent
            ? activeDirectorEvent.phase === "warning"
              ? THREE.MathUtils.clamp(
                  (latestState.tick
                    - activeDirectorEvent.suggestion.announcedAtTick)
                    / Math.max(
                      1,
                      activeDirectorEvent.suggestion.startsAtTick
                        - activeDirectorEvent.suggestion.announcedAtTick,
                    ),
                  0,
                  1,
                )
              : THREE.MathUtils.clamp(
                  (latestState.tick
                    - activeDirectorEvent.suggestion.startsAtTick)
                    / Math.max(
                      1,
                      activeDirectorEvent.suggestion.endsAtTick
                        - activeDirectorEvent.suggestion.startsAtTick,
                    ),
                  0,
                  1,
                )
            : 0;
          runtimePlayfield.style.setProperty(
            "--director-progress",
            directorProgress.toFixed(4),
          );
          const runtimeStealthMessage = runtimePlayfield.querySelector<HTMLElement>(
            "[data-stealth-runtime-message]",
          );
          if (runtimeStealthMessage && activeDirectorEvent) {
            runtimeStealthMessage.dataset.runtimeDirectorPhase =
              activeDirectorEvent.phase;
            runtimeStealthMessage.dataset.runtimeDirectorKind =
              activeDirectorEvent.suggestion.kind;
            runtimeStealthMessage.textContent = activeDirectorEvent.phase === "warning"
              ? `环境预告 · ${activeDirectorEvent.suggestion.label}`
              : `环境事件 · ${activeDirectorEvent.suggestion.label}`;
          } else if (
            runtimeStealthMessage?.dataset.runtimeDirectorPhase
          ) {
            delete runtimeStealthMessage.dataset.runtimeDirectorPhase;
            delete runtimeStealthMessage.dataset.runtimeDirectorKind;
            runtimeStealthMessage.textContent =
              stealthNotice && latestState.tick <= stealthNoticeUntilTick
                ? stealthNotice
                : STEALTH_TOOL_UI[selectedStealthToolRef.current].hint;
          }
        }
        updateStealthWorldViews(latestState.tick);
        const currentGhostTick = latestState.tick;
        if (
          latestState.phase === "won"
          || distanceBetween(latestState.player.position, campaignLevel.exit)
            <= POLICE_PREFETCH_DISTANCE_CELLS
        ) {
          void requestPoliceAsset?.();
        }
        interactPressed.current = false;
        consumeEvents(latestState, delta, causalEvents);
        playerRuleProgress = playerRuleProgressTracker.update({
          tick: currentGhostTick,
          routeProgress: exitRouteProgressForPosition(
            latestState.player.position,
          ),
          events: pendingPlayerRuleEvents,
        });
        pendingPlayerRuleEvents = [];
        if (mechanicView) updateThemeMechanicView(mechanicView, environment, now);
        updateThemeMissionViews(now);
        updateLockerVisionStyle(latestState);
        const activeHideArchetype = simulation.getActiveHideSpotArchetype();
        const playerBaseExposed = latestState.phase !== "playing"
          || isPlayerVisuallyExposed(latestState.player, simulation.config);
        const playerPresentationAlpha = playerBaseExposed
          ? 1
          : activeHideArchetype?.archetype === "soft-cover"
            && latestState.player.mode === "hidden"
            ? Math.max(
                0.34,
                activeHideArchetype.profile.evidence.occupiedVisualDisturbance,
              )
            : 0;
        const playerActuallyVisible = playerPresentationAlpha > 0.01;
        const chaserKnowledgeObservable = canRuntimeObserveChaser(latestState);
        if (latestState.phase === "playing" && chaserKnowledgeObservable) {
          playerKnownChaser = {
            position: { ...latestState.chaser.position },
            observedAtSeconds: latestState.elapsedSeconds,
            playerPositionAtObservation: { ...latestState.player.position },
          };
        }
        const chaserWorldRendered = shouldRenderChaserModel(latestState.phase, playerActuallyVisible);
        const scoreThreat = latestState.phase === "playing"
          ? publicThreatStrengthForMode(latestState.chaser.mode)
          : 0;
        playerKnowledge = updatePlayerKnowledge(playerKnowledge, {
          audioThreat: scoreThreat,
          visibleThreat: chaserKnowledgeObservable && scoreThreat >= 0.2,
        }, delta);
        if (scoreThreat !== lastScoreThreat) {
          score.setThreat(scoreThreat);
          lastScoreThreat = scoreThreat;
        }
        syncAnimations(latestState, delta);
        advanceAndSyncGhost(delta);
        const lockerListening = lockerVisionMix(latestState.player, simulation.config);
        const insideHideSpot = activeHideArchetype?.archetype === "hard-locker"
          && !["free", "aligning-hide", "exiting-hide"].includes(
            latestState.player.mode,
          );
        soundscape.update({
          elapsedSeconds: latestState.elapsedSeconds,
          playerPosition: latestState.player.position,
          chaserPosition: chaserKnowledgeObservable
            ? latestState.chaser.position
            : playerKnownChaser?.position ?? latestState.player.position,
          playerSpeed: actors.kid?.sampledSpeed ?? 0,
          chaserSpeed: actors.villain?.sampledSpeed ?? 0,
          chaserMode: latestState.chaser.mode,
          chaserAudibility: chaserKnowledgeObservable
            ? distanceBetween(latestState.player.position, latestState.chaser.position) <= 3
              ? 1
              : distanceBetween(latestState.player.position, latestState.chaser.position) <= 6
                ? 2 / 3
                : 1 / 3
            : 0,
          chaserPan: chaserKnowledgeObservable
            ? soundPanForWorldPoints(latestState.player.position, latestState.chaser.position)
            : 0,
          listenerAcoustics: {
            insideHideSpot,
            doorOpenness: insideHideSpot
              ? THREE.MathUtils.clamp(
                lockerListening.peek + (1 - lockerListening.cover) * 0.42,
                0,
                1,
              )
              : 1,
            roomOcclusion: insideHideSpot ? 0.72 : 0.08,
            breathIntensity: insideHideSpot
              ? THREE.MathUtils.clamp(0.22 + scoreThreat * 0.72, 0, 1)
              : 0,
          },
        });
        if (actors.kid) {
          updateActorVisibility(
            actors.kid,
            lockerCameraBlend >= 0.65 ? 0 : playerPresentationAlpha,
            delta,
            latestState.phase !== "playing",
          );
          actors.kid.readabilityRim.value = actorReadabilityRimStrength(
            "player",
            latestState.chaser.mode,
            playerActuallyVisible && lockerCameraBlend < 0.65,
          );
        }
        if (actors.villain) {
          updateActorVisibility(
            actors.villain,
            chaserWorldRendered,
            delta,
            true,
          );
          actors.villain.readabilityRim.value = actorReadabilityRimStrength(
            "chaser",
            latestState.chaser.mode,
            chaserWorldRendered,
          );
        }
        if (actors.police) {
          actors.police.readabilityRim.value = actorReadabilityRimStrength(
            "ally",
            latestState.chaser.mode,
            actors.police.root.visible,
          );
        }

        const playerAnchor = world(
          playerPresentationPose(latestState, campaignLevel, simulation).point,
          campaignLevel,
        ).add(new THREE.Vector3(0, 0.92, 0));
        moon.target.position.copy(playerAnchor).setY(0);
        moon.position.copy(moon.target.position).add(new THREE.Vector3(14, 28, 18));
        moon.target.updateMatrixWorld();
        updatePerformanceLightBudget(playerAnchor);
        const chaserAnchor = world(latestState.chaser.position, campaignLevel).add(new THREE.Vector3(0, 1.05, 0));
        const policeAnchor = actors.police?.root.position.clone().add(new THREE.Vector3(0, 1.05, 0)) ?? playerAnchor;
        const framingThreat = shouldFrameChaser(
          latestState.phase,
          latestState.chaser.mode,
          chaserKnowledgeObservable,
        );
        if (latestState.phase === "playing") {
          cameraFollowState = stepFixedCameraFollow(cameraFollowState, {
            playerFocus: playerAnchor,
            observableThreatFocus: framingThreat ? chaserAnchor : null,
            deltaSeconds: delta,
            deadZoneRadius: latestState.player.mode === "free" ? 1.15 : 0.42,
            threatHoldSeconds: 0.55,
            maximumFocusSpeed: framingThreat ? 22 : 10,
          });
        }
        const followFocus = new THREE.Vector3(
          cameraFollowState.focus.x,
          cameraFollowState.focus.y,
          cameraFollowState.focus.z,
        );
        const threatFocusActive = framingThreat || cameraFollowState.heldThreatFocus !== null;
        const baseTargetFocus = latestState.phase === "won"
          ? playerAnchor.clone().lerp(policeAnchor, 0.34)
          : latestState.phase === "lost"
            ? playerAnchor.clone().lerp(chaserAnchor, 0.3)
            : followFocus;
        const baseDistance = baseCameraDistanceForAspect(camera.aspect);
        const publicCameraThreat = chaserKnowledgeObservable
          ? threatForMode(latestState.chaser.mode)
          : playerKnowledge.threat === "active"
            ? 0.52
            : playerKnowledge.threat === "caution"
              ? 0.28
              : 0;
        const dynamicDistance = baseDistance * cameraDistanceScaleForPlayerMode(latestState.player.mode)
          + publicCameraThreat * 0.9;
        const preferredDistance = THREE.MathUtils.clamp(
          dynamicDistance * cameraZoom.value,
          11.6,
          MAX_CAMERA_DISTANCE,
        );
        const edgeFocus = threatFocusActive
          ? baseTargetFocus
          : latestState.player.mode === "free"
            ? cameraFocusForTraversalEdge({
                focus: baseTargetFocus,
                bounds: cameraPlayfieldBounds,
                cameraDirection,
                cameraDistance: preferredDistance,
                verticalFovDegrees: camera.fov,
                aspect: camera.aspect,
              })
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
        cameraFocus.lerp(targetFocus, 1 - Math.exp(-(threatFocusActive ? 12 : 7.5) * delta));
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
          minimumActorScreenHeightPixels: minimumActorScreenHeightPixelsForViewport(
            cameraViewportHeight,
            touchLayoutMedia.matches,
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
        const activeLocker = latestState.player.hideSpotId
          ? lockers.get(latestState.player.hideSpotId)
          : undefined;
        const desiredLockerCameraBlend = activeLocker?.archetype === "hard-locker"
          ? THREE.MathUtils.clamp(
            Math.max(lockerListening.cover, lockerListening.peek),
            0,
            1,
          )
          : 0;
        lockerCameraBlend = THREE.MathUtils.damp(
          lockerCameraBlend,
          desiredLockerCameraBlend,
          desiredLockerCameraBlend > lockerCameraBlend ? 7.8 : 9.5,
          delta,
        );
        const lockerPoseBlend = lockerCameraPoseBlend(lockerCameraBlend);
        if (activeLocker?.archetype === "hard-locker" && lockerCameraBlend > 0.002) {
          activeLocker.cameraAnchor.getWorldPosition(lockerCameraPosition);
          activeLocker.peekAnchor.getWorldPosition(lockerPeekPosition);
          const hideSpot = campaignLevel.hideSpots.find(
            (spot) => spot.id === activeLocker.id,
          );
          const outward = hideSpot?.facing ?? { x: 0, y: 1 };
          const sightDirection = hideSpot
            ? lockerSightDirection(hideSpot, campaignLevel)
            : outward;
          // The authored anchors sit physically inside the cabinet. A closed,
          // double-sided hero door quite correctly blocks that camera, but an
          // entirely black screen is not a useful hiding view. Move the render
          // eye just beyond the door skin and let the diegetic slat mask below
          // restore the feeling of looking through the locker vents.
          lockerCameraPosition.add(new THREE.Vector3(
            outward.x * 0.38,
            0.04,
            outward.y * 0.38,
          ));
          lockerCameraPosition.y = Math.max(lockerCameraPosition.y, 1.5);
          if (hideSpot) {
            // Authored locker anchors are ideal for the door animation but can
            // sit centimetres behind a neighbouring wall once a cabinet is
            // rotated into a maze alcove. A fully-open peek therefore moves to
            // the centre of the certified walkable approach cell, then leans a
            // little into the longest visible corridor. This keeps every
            // cabinet useful without detaching the covered view from its model.
            const approachCamera = world(hideSpot.approach, campaignLevel);
            approachCamera.y = Math.max(lockerPeekPosition.y + 0.06, 1.62);
            approachCamera.add(new THREE.Vector3(
              outward.x * 0.24 + sightDirection.x * 0.1,
              0,
              outward.y * 0.24 + sightDirection.y * 0.1,
            ));
            lockerPeekPosition.copy(approachCamera);
          } else {
            lockerPeekPosition.add(new THREE.Vector3(
              outward.x * 0.54,
              0.06,
              outward.y * 0.54,
            ));
          }
          lockerCameraPosition.lerp(
            lockerPeekPosition,
            THREE.MathUtils.clamp(lockerListening.peek, 0, 1),
          );
          lockerCameraTarget.copy(lockerCameraPosition).add(new THREE.Vector3(
            sightDirection.x * CELL * 5,
            -0.03,
            sightDirection.y * CELL * 5,
          ));
          camera.position.lerp(lockerCameraPosition, lockerPoseBlend);
          const blendedLookTarget = cameraFocus.clone().lerp(
            lockerCameraTarget,
            lockerPoseBlend,
          );
          camera.lookAt(blendedLookTarget);
        }
        const targetFov = THREE.MathUtils.lerp(56, 67, lockerPoseBlend);
        if (Math.abs(camera.fov - targetFov) > 0.01) {
          camera.fov = targetFov;
          camera.updateProjectionMatrix();
        }
        const readableOcclusionAnchors = [playerAnchor];
        if (latestState.phase === "won" && actors.police) readableOcclusionAnchors.push(policeAnchor);
        else if (
          chaserWorldRendered
          && (chaserKnowledgeObservable || latestState.phase === "lost")
        ) readableOcclusionAnchors.push(chaserAnchor);
        // Inside a hide spot the camera is the player's eye, not an overhead
        // readability camera. Fading maze walls toward the concealed avatar
        // creates layered transparent bands across the vent view, so settle
        // every occluder back to its authored opaque material while hidden.
        updateCameraOcclusion(
          lockerCameraBlend > 0.12 ? [] : readableOcclusionAnchors,
          delta,
        );

        if (now - lastHudUpdate > 120) {
          setPhase(latestState.phase);
          setPlayerMode(latestState.player.mode);
          setChaserMode(latestState.chaser.mode);
          setChaserConfirming(latestState.chaser.visualConfirmationSeconds !== null);
          setChaserObservable(chaserKnowledgeObservable);
          setChaserArchetypeRuntime(simulation.getChaserArchetypeRuntime());
          setPublicThreat(playerKnowledge.threat);
          setElapsed(Math.floor(latestState.elapsedSeconds));
          setThemeMechanic({
            ...environment,
            distanceMeters: Math.round(
              distanceBetween(latestState.player.position, mechanicPosition) * CELL,
            ),
            activationCostLabel: mechanicDefinition.activationCost.label,
            movementCommitted: mechanicRequiresMovementCommitment(mechanicInstance),
          });
          const hudMissionObjective = missionObjectiveForPlayer(
            latestState.player.position,
          );
          const objectiveTarget = hudMissionObjective?.position ?? campaignLevel.exit;
          const objectiveRoute = objectivePaths.path(
            latestState.player.position,
            objectiveTarget,
          );
          const routeGeometry = deriveRouteGuidanceGeometry(objectiveRoute, CELL);
          setObjectiveDistance(Math.round(routeGeometry.routeDistanceMeters));
          setThemeMission({
            state: missionState,
            activeObjective: hudMissionObjective?.objective ?? null,
            activeDistanceMeters: hudMissionObjective
              ? Math.round(hudMissionObjective.routeCells * CELL)
              : null,
            canInteract: Boolean(
              hudMissionObjective
              && latestState.phase === "playing"
              && latestState.player.mode === "free"
              && missionCommitment === null
              && simulation.getHideInteraction() === null
              && distanceBetween(
                latestState.player.position,
                hudMissionObjective.position,
              ) <= 1.35
            ),
            commitmentProgress: missionCommitment
              ? 1 - missionCommitment.remainingSeconds
                / Math.max(0.001, missionCommitment.totalSeconds)
              : null,
            commitmentRemainingSeconds: missionCommitment
              ? missionCommitment.remainingSeconds
              : null,
            completedCount: missionState.completedObjectiveIds.length,
            totalCount: runtimeMissionObjectives.length,
          });
          setPortableDecoy(portableDecoyState
            ? samplePortableDecoy(
                portableDecoyState,
                Math.max(
                  portableDecoyState.updatedAtSeconds,
                  latestState.elapsedSeconds,
                ),
              )
            : null);
          setPortableDecoyNotice(
            portableDecoyFeedback
              && latestState.elapsedSeconds <= portableDecoyFeedbackUntilSeconds
              ? portableDecoyFeedback
              : null,
          );
          const activeDirectorEvent = tensionDirectorState.activeEvent;
          const directorPhase = activeDirectorEvent?.phase ?? "idle";
          const directorProgress = activeDirectorEvent
            ? directorPhase === "warning"
              ? THREE.MathUtils.clamp(
                  (latestState.tick
                    - activeDirectorEvent.suggestion.announcedAtTick)
                    / Math.max(
                      1,
                      activeDirectorEvent.suggestion.startsAtTick
                        - activeDirectorEvent.suggestion.announcedAtTick,
                    ),
                  0,
                  1,
                )
              : THREE.MathUtils.clamp(
                  (latestState.tick
                    - activeDirectorEvent.suggestion.startsAtTick)
                    / Math.max(
                      1,
                      activeDirectorEvent.suggestion.endsAtTick
                        - activeDirectorEvent.suggestion.startsAtTick,
                    ),
                  0,
                  1,
                )
            : 0;
          setTensionDirector({
            tier: tensionDirectorState.tier,
            score: tensionDirectorState.score,
            phase: directorPhase,
            kind: activeDirectorEvent?.suggestion.kind ?? null,
            label: activeDirectorEvent?.suggestion.label
              ?? (tensionDirectorState.tier === "rest"
                ? "公平节奏导演待机"
                : "环境压力正在评估"),
            progress: directorProgress,
          });
          setStealthSystems({
            toolbelt: sampleStealthToolbelt(stealthToolbeltState),
            selectedTool: selectedStealthToolRef.current,
            evidenceCount: stealthEvidenceState.records.length,
            countermeasureBudget:
              stealthEvidenceState.countermeasureBudgetRemaining,
            countermeasureBusy:
              latestState.tick
                < stealthEvidenceState.countermeasureBusyUntilTick,
            notice: stealthNotice
              && latestState.tick <= stealthNoticeUntilTick
              ? stealthNotice
              : null,
            mirrorThreatVisible,
          });
          setGhostRace(latestGhostRace
            ? {
                ...latestGhostRace,
                visible: Boolean(ghostActor?.root.visible),
                ruleFaithful: Boolean(ghostRecording?.ruleEvents?.length),
              }
            : null);
          if (latestState.phase === "playing" && latestState.player.mode === "free") {
            const guidance = updateObjectiveGuidance(objectiveGuidanceState, {
              deltaSeconds: Math.max(0, latestState.elapsedSeconds - lastObjectiveGuidanceSeconds),
              routeDistanceMeters: routeGeometry.routeDistanceMeters,
              movement: { x: move.x * CELL, y: move.y * CELL },
              routeDirection: routeGeometry.routeDirection,
              nextTurn: routeGeometry.nextTurn,
            });
            objectiveGuidanceState = guidance.state;
            setObjectiveTurnHint(guidance.nextTurn ? {
              arrow: fixedScreenArrowForWorldDirection(guidance.nextTurn.direction),
              distanceMeters: Math.round(guidance.nextTurn.distanceMeters),
            } : null);
          } else {
            setObjectiveTurnHint(null);
          }
          lastObjectiveGuidanceSeconds = latestState.elapsedSeconds;
          setInteraction(simulation.getHideInteraction());
          setHideExitSelection(simulation.getHideExitSelection());
          updateHideGuideProjection(latestState, held("q"));
          lastHudUpdate = now;
        }
      }
      // Do not compile an incomplete zero-light material graph behind the
      // loading card. The first real render happens after all fixed-budget
      // gameplay lights have been registered, avoiding a duplicate PBR
      // shader set when deferred dressing arrives.
      if (ready) {
        renderer.autoClear = false;
        renderer.info.reset();
        camera.layers.set(0);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
        qaRenderedFrameCount += 1;
        compileSettledQaScene();
      }
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
        gameplayCameraInsetsForViewport(width, height, touchLayoutMedia.matches),
      );
      renderer.setPixelRatio(Math.min(devicePixelRatio, renderQualityProfile.maximumPixelRatio));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    touchLayoutMedia.addEventListener("change", resize);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      commands.current.adjustZoom(Math.exp(event.deltaY * 0.00065));
    };
    host.addEventListener("wheel", wheel, { passive: false });

    const projectActorToViewport = (view: ActorView | undefined) => {
      if (!view) return null;
      camera.updateMatrixWorld();
      const bounds = staticMeshBounds(view.root);
      const size = bounds.getSize(new THREE.Vector3());
      const actorCenter = bounds.isEmpty()
        ? view.root.position.clone().add(new THREE.Vector3(0, 0.92, 0))
        : bounds.getCenter(new THREE.Vector3());
      const projected = actorCenter.project(camera);
      const projectedCorners = bounds.isEmpty()
        ? []
        : [
            new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
            new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
            new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
            new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
            new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
            new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
            new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
            new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
          ].map((corner) => corner.project(camera));
      const minimumX = projectedCorners.length
        ? Math.min(...projectedCorners.map(({ x }) => x))
        : projected.x;
      const maximumX = projectedCorners.length
        ? Math.max(...projectedCorners.map(({ x }) => x))
        : projected.x;
      const minimumY = projectedCorners.length
        ? Math.min(...projectedCorners.map(({ y }) => y))
        : projected.y;
      const maximumY = projectedCorners.length
        ? Math.max(...projectedCorners.map(({ y }) => y))
        : projected.y;
      return {
        x: (projected.x + 1) / 2,
        y: (1 - projected.y) / 2,
        depth: projected.z,
        worldHeight: size.y,
        pixelWidth: (maximumX - minimumX) * cameraViewportWidth / 2,
        pixelHeight: (maximumY - minimumY) * cameraViewportHeight / 2,
        bounds: {
          left: (minimumX + 1) / 2,
          right: (maximumX + 1) / 2,
          top: (1 - maximumY) / 2,
          bottom: (1 - minimumY) / 2,
        },
        centerInFrustum: Math.abs(projected.x) <= 1
          && Math.abs(projected.y) <= 1
          && projected.z >= -1
          && projected.z <= 1,
      };
    };
    const projectObjectToViewport = (object: THREE.Object3D) => {
      camera.updateMatrixWorld();
      object.updateWorldMatrix(true, true);
      const bounds = staticMeshBounds(object);
      if (bounds.isEmpty()) return null;
      const corners = [
        new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
        new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.max.z),
        new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.min.z),
        new THREE.Vector3(bounds.min.x, bounds.max.y, bounds.max.z),
        new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.min.z),
        new THREE.Vector3(bounds.max.x, bounds.min.y, bounds.max.z),
        new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.min.z),
        new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
      ].map((corner) => corner.project(camera));
      const minimumX = Math.min(...corners.map(({ x }) => x));
      const maximumX = Math.max(...corners.map(({ x }) => x));
      const minimumY = Math.min(...corners.map(({ y }) => y));
      const maximumY = Math.max(...corners.map(({ y }) => y));
      const center = bounds.getCenter(new THREE.Vector3()).project(camera);
      return {
        x: (center.x + 1) / 2,
        y: (1 - center.y) / 2,
        depth: center.z,
        pixelWidth: (maximumX - minimumX) * cameraViewportWidth / 2,
        pixelHeight: (maximumY - minimumY) * cameraViewportHeight / 2,
        bounds: {
          left: (minimumX + 1) / 2,
          right: (maximumX + 1) / 2,
          top: (1 - maximumY) / 2,
          bottom: (1 - minimumY) / 2,
        },
        centerInFrustum: Math.abs(center.x) <= 1
          && Math.abs(center.y) <= 1
          && center.z >= -1
          && center.z <= 1,
      };
    };
    const inspectActorCameraClearance = (view: ActorView | undefined) => {
      if (!view) return null;
      camera.updateMatrixWorld();
      view.root.updateWorldMatrix(true, true);
      const bounds = staticMeshBounds(view.root);
      if (bounds.isEmpty()) return null;
      const center = bounds.getCenter(new THREE.Vector3());
      const height = Math.max(0.1, bounds.max.y - bounds.min.y);
      const screenRight = new THREE.Vector3();
      camera.getWorldDirection(screenRight);
      screenRight.cross(camera.up).normalize();
      const samples = [
        { label: "head", point: center.clone().setY(bounds.max.y - height * 0.1) },
        { label: "torso", point: center.clone().setY(bounds.min.y + height * 0.62) },
        { label: "hips", point: center.clone().setY(bounds.min.y + height * 0.34) },
        {
          label: "left-shoulder",
          point: center.clone()
            .setY(bounds.min.y + height * 0.7)
            .addScaledVector(screenRight, -0.22),
        },
        {
          label: "right-shoulder",
          point: center.clone()
            .setY(bounds.min.y + height * 0.7)
            .addScaledVector(screenRight, 0.22),
        },
      ].map(({ label, point }) => {
        const direction = point.clone().sub(camera.position);
        const distance = direction.length();
        direction.multiplyScalar(1 / Math.max(distance, 1e-6));
        occlusionRaycaster.set(camera.position, direction);
        occlusionRaycaster.near = 0.12;
        occlusionRaycaster.far = Math.max(0.13, distance - 0.12);
        const hit = occlusionRaycaster.intersectObjects(occlusionMeshes, false)[0];
        return {
          label,
          clear: !hit,
          hit: hit?.object.name || hit?.object.parent?.name || null,
          hitDistance: hit?.distance ?? null,
        };
      });
      const clearCount = samples.filter(({ clear }) => clear).length;
      return {
        headClear: samples.find(({ label }) => label === "head")?.clear ?? false,
        torsoClear: samples.find(({ label }) => label === "torso")?.clear ?? false,
        visibleSampleRatio: clearCount / samples.length,
        samples,
      };
    };
    const inspectStealthArtSemantics = (root: THREE.Object3D) => {
      let meshCount = 0;
      const materials = new Map<string, THREE.Material>();
      const semanticNames: string[] = [];
      const semanticPartObjects: THREE.Object3D[] = [];
      const auditedPartNames = new Set([
        "polished-corner-mirror-face",
        "authored-corner-mirror-rim",
        "corner-mirror-wall-plate",
        "corner-mirror-articulated-arm",
        "corner-mirror-fasteners",
        "corner-mirror-status-led",
      ]);
      const authoredSources = new Map<string, {
        readonly node: string;
        readonly label: string | null;
        readonly assetId: string | null;
        readonly sourceUrl: string | null;
        readonly geometrySignature: string | null;
        readonly fallbackUsed: boolean;
      }>();
      root.traverse((object) => {
        if (object.name.trim()) semanticNames.push(object.name);
        if (auditedPartNames.has(object.name)) {
          semanticPartObjects.push(object);
        }
        if (typeof object.userData.authoredToolSource === "string") {
          const node = object.userData.authoredToolSource;
          authoredSources.set(node, {
            node,
            label: typeof object.userData.authoredToolLabel === "string"
              ? object.userData.authoredToolLabel
              : null,
            assetId: typeof object.userData.authoredToolAssetId === "string"
              ? object.userData.authoredToolAssetId
              : null,
            sourceUrl: typeof object.userData.authoredToolSourceUrl === "string"
              ? object.userData.authoredToolSourceUrl
              : null,
            geometrySignature:
              typeof object.userData.authoredToolGeometrySignature === "string"
                ? object.userData.authoredToolGeometrySignature
                : null,
            fallbackUsed: object.userData.authoredToolFallbackUsed === true,
          });
        }
        if (!(object instanceof THREE.Mesh)) return;
        meshCount += 1;
        const meshMaterials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of meshMaterials) {
          materials.set(material.uuid, material);
        }
      });
      const texturedMaterialCount = [...materials.values()].filter(
        (material) => Object.values(material).some(
          (value) => value instanceof THREE.Texture,
        ),
      ).length;
      const parts = semanticPartObjects.map((object) => {
        const worldPosition = object.getWorldPosition(new THREE.Vector3());
        const objectMaterials: THREE.Material[] = [];
        object.traverse((descendant) => {
          if (!(descendant instanceof THREE.Mesh)) return;
          objectMaterials.push(
            ...(Array.isArray(descendant.material)
              ? descendant.material
              : [descendant.material]),
          );
        });
        const standardMaterials = objectMaterials.filter(
          (material): material is THREE.MeshStandardMaterial => (
            material instanceof THREE.MeshStandardMaterial
          ),
        );
        return {
          name: object.name,
          worldPosition: {
            x: worldPosition.x,
            y: worldPosition.y,
            z: worldPosition.z,
          },
          viewport: projectObjectToViewport(object),
          emissiveIntensity: standardMaterials.reduce(
            (maximum, material) => Math.max(
              maximum,
              material.emissiveIntensity,
            ),
            0,
          ),
          effectiveEmissive: standardMaterials.reduce(
            (maximum, material) => Math.max(
              maximum,
              Math.max(
                material.emissive.r,
                material.emissive.g,
                material.emissive.b,
              ) * material.emissiveIntensity,
            ),
            0,
          ),
          roughness: standardMaterials.map((material) => material.roughness),
          metalness: standardMaterials.map((material) => material.metalness),
        };
      });
      return {
        meshCount,
        materialCount: materials.size,
        texturedMaterialCount,
        semanticNames,
        parts,
        authoredSources: [...authoredSources.values()].sort(
          (left, right) => left.node.localeCompare(right.node),
        ),
      };
    };

    const qaWindow = window as typeof window & {
      __CHASING_QA__?: {
        getState: () => unknown;
        getStealthProbe: () => unknown;
        start: () => void;
        interact: () => void;
        deployDecoy: () => void;
        selectStealthTool: (tool: StealthToolKind) => void;
        useStealthTool: () => void;
        eraseEvidence: () => void;
        togglePause: () => void;
        setCaptureHold: (
          held: boolean,
          leaseMilliseconds?: number,
        ) => void;
        inspectScene: () => unknown;
        setScenario: (positions: {
          player: Point;
          chaser: Point;
          chaserHeading?: Point;
          spawnDelaySeconds?: number;
        }) => void;
        completeMission: () => void;
        selectLevel: (level: number | string) => void;
        selectLayout: (layoutNumber: number | null) => void;
        selectLibraryPlan: (planId: LibraryMissionPlanId) => void;
        setUnlockedThrough: (levelNumber: number) => void;
        lockRenderQuality: () => void;
        setDirectorEnabled: (enabled: boolean) => void;
      };
    };
    let installedQaHook: NonNullable<typeof qaWindow.__CHASING_QA__> | null = null;
    if (new URLSearchParams(location.search).has("qa")) {
      installedQaHook = {
        getStealthProbe: () => ({
          ready,
          phase: latestState.phase,
          tick: latestState.tick,
          playerPosition: latestState.player.position,
          campaign: {
            index: campaignLevel.campaign.levelNumber - 1,
            number: campaignLevel.campaign.levelNumber,
            theme: campaignLevel.campaign.theme,
          },
          selectedTool: selectedStealthToolRef.current,
          activeTools: Object.keys(stealthToolbeltState.activeEffects),
          toolViews: [...stealthToolWorldViews.values()].map((view) => ({
            receiptId: view.receiptId,
            tool: view.tool,
            createdAtTick: view.createdAtTick,
            expiresAtTick: view.expiresAtTick,
          })),
          evidenceKinds: stealthEvidenceState.records.map(({ kind }) => kind),
          evidenceViewCount: stealthEvidenceViews.size,
          registeredStealthLights: performanceLights.filter(
            ({ light }) => light.userData.transientStealthLight === true,
          ).length,
          assets: {
            decorativeReady: decorativeAssetsReady,
            deferredDressingSettled:
              decorativeAssetsReady && deferredDressingFade === null,
            qaDecorativeSceneCompiled,
            qaDecorativeSceneCompileCount,
            qaTransientArtPrewarmCount,
          },
          render: {
            qualityTier: renderQualityTier,
            qualityLocked: qaRenderQualityLocked,
            qualityTransitionCount: renderQualityTransitionCount,
            emergencyTransitionCount: emergencyQualityTransitionCount,
            emergencyLevel: emergencyDegradation.level,
          },
          director: {
            enabled: qaDirectorEnabled,
            state: tensionDirectorState,
            safeTicks: directorSafeTicks,
          },
          captureHold: {
            requested: qaCaptureHoldRequested,
            acknowledged: qaCaptureHoldAcknowledged,
            leaseRemainingMilliseconds: qaCaptureHoldRequested
              ? Math.max(0, qaCaptureHoldDeadline - performance.now())
              : 0,
            renderedFrameCount: qaRenderedFrameCount,
          },
        }),
        getState: () => ({
          ready,
          paused: pausedRef.current,
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
            walkable: campaignLevel.walkable,
            hideSpots: campaignLevel.hideSpots,
          },
          certifiedRemix: {
            selected: Boolean(selectedRemixContract),
            layoutNumber: selectedRemixContract
              ? selectedRemixContract.variantIndex + 1
              : null,
            missionVersion: CERTIFIED_REMIX_MISSION_VERSION,
            seed: selectedRemixContract?.seed ?? null,
            contract: selectedRemixContract,
            runIdentity: resolvedRemix.runIdentity,
            replayLevelId: runReplayLevelId,
            recordStorageKey: selectedRemixContract
              ? remixRecordStorageKey(selectedRemixContract, preferences.ruleset)
              : null,
            record: selectedRemixContract
              ? loadCertifiedRemixRecord(
                  localStorage,
                  selectedRemixContract,
                  preferences.ruleset,
                )
              : null,
          },
          game: latestState,
          interaction: simulation.getHideInteraction(),
          activeHideArchetype: simulation.getActiveHideSpotArchetype(),
          hideExitSelection: simulation.getHideExitSelection(),
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
            cameraClearance: inspectActorCameraClearance(view),
          }])),
          knowledge: {
            chaserObservable: canRuntimeObserveChaser(latestState),
            publicThreat: playerKnowledge,
          },
          chaserArchetype: {
            profile: chaserArchetypeProfile,
            runtime: simulation.getChaserArchetypeRuntime(),
          },
          themeMechanic: {
            definition: mechanicDefinition,
            state: mechanicInstance,
            sample: sampleMechanicInstance(
              mechanicInstance,
              latestState.player.position,
            ),
            view: mechanicView
              ? {
                  beaconVisible: mechanicView.beacon.visible,
                  beaconOpacity: (
                    mechanicView.beacon.material as THREE.SpriteMaterial
                  ).opacity,
                  viewport: projectObjectToViewport(mechanicView.root),
                }
              : null,
          },
          themeMission: {
            definition: missionDefinition,
            runtimeObjectives: runtimeMissionObjectives,
            state: missionState,
            playerRuleProgress,
            views: [...missionViews.values()].map((view) => ({
              id: view.id,
              position: view.position,
              lightColor: view.light.color.getHex(),
              lightIntensity: view.light.intensity,
            })),
            commitment: missionCommitment
              ? { ...missionCommitment }
              : null,
            library: libraryMissionState
              ? {
                  definition: LIBRARY_BRANCHING_MISSION,
                  state: libraryMissionState,
                  selectedPlan: selectedLibraryPlanDefinition,
                }
              : null,
            placements: missionPlacements,
            availableObjectiveIds: availableRuntimeMissionObjectiveIds(),
            audit: missionAudit,
          },
          portableDecoy: portableDecoyState
            ? {
                definition: LIBRARY_PORTABLE_DECOY_DEFINITION,
                state: portableDecoyState,
                sample: samplePortableDecoy(
                  portableDecoyState,
                  Math.max(
                    portableDecoyState.updatedAtSeconds,
                    latestState.elapsedSeconds,
                  ),
                ),
                formalTemplateReady: Boolean(portableDecoyTemplate),
                sourceIds: [...portableDecoySourceIds],
                scheduledSourceIds: [...scheduledPortableDecoySourceIds],
                lifecycle: {
                  thrownCount: portableDecoyThrownCount,
                  publicSoundAcceptedCount:
                    portableDecoyPublicSoundAcceptedCount,
                  investigationCompletedCount:
                    portableDecoyInvestigationCompletedCount,
                  lastEvent: portableDecoyLastLifecycleEvent,
                  throwCommitmentRemainingSeconds:
                    portableDecoyThrowRemainingSeconds,
                },
                worldSoundDelivery: simulation.getWorldSoundQueueSnapshot(),
                resources: {
                  registeredLights: performanceLights.filter(({ light }) => (
                    light.name.startsWith("portable-decoy-light-")
                  )).length,
                  ownedBeaconMaterials: portableDecoyViews.size,
                  viewCreatedCount: portableDecoyViewCreatedCount,
                  viewDisposedCount: portableDecoyViewDisposedCount,
                  beaconTextureCreatedCount:
                    portableDecoyBeaconTextureCreatedCount,
                  beaconTextureDisposedCount:
                    portableDecoyBeaconTextureDisposedCount,
                  beaconMaterialDisposedCount:
                    portableDecoyBeaconMaterialDisposedCount,
                  resetCount: portableDecoyResetCount,
                  sceneRoots: (() => {
                    let count = 0;
                    scene.traverse((object) => {
                      if (object.userData.portableDecoyRoot === true) count += 1;
                    });
                    return count;
                  })(),
                  transientPlacedAssetIds: [...placedAssetIds].filter((id) => (
                    id.startsWith("gameplay:portable-decoy:")
                  )),
                },
                views: [...portableDecoyViews.values()].map((view) => ({
                  deploymentId: view.deploymentId,
                  sourceId: view.sourceId,
                  settled: view.settled,
                  released: view.released,
                  releaseAtSeconds: view.releaseAtSeconds,
                  rootName: view.root.name,
                  modelName: view.root.children[0]?.name ?? null,
                  position: {
                    x: view.root.position.x,
                    y: view.root.position.y,
                    z: view.root.position.z,
                  },
                  beaconVisible: view.beacon.visible,
                  lightRegistered: view.lightRegistered,
                  viewport: projectObjectToViewport(view.root),
                })),
              }
            : null,
          stealth: {
            selectedTool: selectedStealthToolRef.current,
            evidence: {
              tick: stealthEvidenceState.tick,
              countermeasureBudgetRemaining:
                stealthEvidenceState.countermeasureBudgetRemaining,
              countermeasureBudgetSpent:
                stealthEvidenceState.countermeasureBudgetSpent,
              countermeasureBusyUntilTick:
                stealthEvidenceState.countermeasureBusyUntilTick,
              erasedEvidenceCount: stealthEvidenceState.erasedEvidenceCount,
              forgedEvidenceCount: stealthEvidenceState.forgedEvidenceCount,
              records: stealthEvidenceState.records.map((record) => ({
                id: record.id,
                kind: record.kind,
                position: record.position,
                source: record.source,
                detail: record.detail,
                createdAtTick: record.createdAtTick,
                expiresAtTick: record.expiresAtTick,
              })),
              deliveredIds: [...deliveredEvidenceIds],
              investigatedIds: [...investigatedEvidenceIds],
              worldClueDelivery: simulation.getWorldClueQueueSnapshot(),
              views: [...stealthEvidenceViews.values()].map((view) => ({
                id: view.id,
                rootName: view.root.name,
                createdAtTick: view.createdAtTick,
                expiresAtTick: view.expiresAtTick,
                worldPosition: {
                  x: view.root.position.x,
                  y: view.root.position.y,
                  z: view.root.position.z,
                },
                ...inspectStealthArtSemantics(view.root),
                viewport: projectObjectToViewport(view.root),
              })),
            },
            toolbelt: {
              state: stealthToolbeltState,
              sample: sampleStealthToolbelt(stealthToolbeltState),
              qaPlacementAnchors: qaStealthToolPlacementAnchors,
              views: [...stealthToolWorldViews.values()].map((view) => ({
                receiptId: view.receiptId,
                tool: view.tool,
                rootName: view.root.name,
                createdAtTick: view.createdAtTick,
                expiresAtTick: view.expiresAtTick,
                ...inspectStealthArtSemantics(view.root),
                viewport: projectObjectToViewport(view.root),
              })),
              mirrorThreatVisible,
              activeWedgeHoldUntilTick,
            },
            resources: {
              registeredLights: performanceLights.filter(
                ({ light }) => light.userData.transientStealthLight === true,
              ).length,
              sceneRoots: (() => {
                let count = 0;
                scene.traverse((object) => {
                  if (object.userData.transientStealthRoot === true) count += 1;
                });
                return count;
              })(),
              transientPlacedAssetIds: [
                ...[...stealthEvidenceViews.values()]
                  .map(({ root }) => root.name),
                ...[...stealthToolWorldViews.values()]
                  .map(({ root }) => root.name),
              ],
            },
            director: {
              definition: tensionDirectorDefinition,
              state: tensionDirectorState,
              safeTicks: directorSafeTicks,
              chaseTicks: directorChaseTicks,
              ticksSinceChaseEscape: directorTicksSinceChaseEscape,
            },
          },
          ghost: {
            eligible: ghostEligible,
            recording: ghostRecording
              ? {
                  levelId: ghostRecording.levelId,
                  durationTicks: ghostRecording.durationTicks,
                  fixedStepSeconds: ghostRecording.fixedStepSeconds,
                }
              : null,
            state: ghostState,
            race: latestGhostRace,
            viewport: projectActorToViewport(ghostActor ?? undefined),
          },
          preferences: preferencesRef.current,
          environmentComposition,
          telemetry: runTelemetry,
          sceneIntegrity: {
            expectedMovementBlockers: campaignLevel.movementBlockers?.length ?? 0,
            renderedMovementBlockers,
            expectedVisionObscurers: campaignLevel.visionOnlyBlockers?.length ?? 0,
            renderedVisionObscurers: sightObscurers.length,
          },
          assets: {
            decorativeReady: decorativeAssetsReady,
            deferredDressingSettled:
              decorativeAssetsReady && deferredDressingFade === null,
            qaDecorativeSceneCompiled,
            qaDecorativeSceneCompileCount,
            qaTransientArtPrewarmCount,
            qaCleanFrame: qaCleanFrameRequested,
            kidAssetUrl: qaKidAssetUrl,
            kidLoadedIdentity: qaLoadedKidAssetIdentity,
            policeAssetUrl: qaPoliceAssetUrl,
            policeLoaded: Boolean(actors.police),
            policeLoadedIdentity: qaLoadedPoliceAssetIdentity,
            loadedAssetIds: [...loadedAssetIds].sort(),
            placedAssetIds: [...placedAssetIds].sort(),
            unusedLoadedAssetIds: [...loadedAssetIds].filter((id) => !placedAssetIds.has(id)).sort(),
          },
          lockers: Object.fromEntries([...lockers].map(([id, view]) => [id, {
            archetype: view.archetype,
            alternateExit: view.alternateExit,
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
            qualityTier: renderQualityTier,
            qualityLock: {
              enabled: qaRenderQualityLocked,
              requestedTier: qaRequestedRenderQuality,
              appliedBeforeRendererCreation: qaQualityAppliedBeforeRendererCreation,
            },
            qualityTransitionCount: renderQualityTransitionCount,
            emergencyTransitionCount: emergencyQualityTransitionCount,
            pixelRatio: renderer.getPixelRatio(),
            shadowMapSize: moon.shadow.mapSize.x,
            emergencyDegradation,
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            shadow: estimateShadowWorkload(),
            memory: renderer.info.memory,
            programs: renderer.info.programs?.length ?? 0,
            sceneTextures: countSceneTextures(scene),
            invalidSceneTextures: findInvalidSceneTextures(scene),
            textureDeduplication,
          },
          firstPlayableBudget: latestFirstPlayableAudit,
        }),
        start: beginGame,
        interact: () => { interactPressed.current = true; },
        deployDecoy: () => { portableDecoyPressed.current = true; },
        selectStealthTool: (tool) => commands.current.selectStealthTool(tool),
        useStealthTool: () => commands.current.useStealthTool(),
        eraseEvidence: () => commands.current.eraseEvidence(),
        togglePause: () => commands.current.togglePause(),
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
        selectLayout: (layoutNumber) => {
          if (layoutNumber === null) {
            chooseRemixVariant(null);
            return;
          }
          if (!Number.isInteger(layoutNumber) || layoutNumber < 1 || layoutNumber > 3) {
            throw new Error("QA layout number must be 1, 2, 3, or null for original");
          }
          chooseRemixVariant((layoutNumber - 1) as 0 | 1 | 2);
        },
        selectLibraryPlan: (planId) => {
          if (
            latestState.phase !== "ready"
            || planId === selectedLibraryPlan
            || !LIBRARY_BRANCHING_MISSION.plans.some((plan) => plan.id === planId)
          ) return;
          setLoading(true);
          setLoadError("");
          setSelectedLibraryPlan(planId);
        },
        setUnlockedThrough: (levelNumber) => {
          setCampaignProgress((current) => ({
            ...current,
            unlockedThrough: THREE.MathUtils.clamp(Math.floor(levelNumber), 1, CAMPAIGN_LEVELS.length),
            assistedUnlockedThrough: THREE.MathUtils.clamp(
              Math.floor(levelNumber),
              1,
              CAMPAIGN_LEVELS.length,
            ),
          }));
        },
        lockRenderQuality: () => {
          qaRenderQualityLocked = true;
          qualitySamples = [];
          qualityEvaluationSeconds = 0;
          qualityDecisionSeconds = 0;
          qualityCandidate = renderQualityTier;
        },
        setDirectorEnabled: (enabled) => {
          qaDirectorEnabled = enabled;
          tensionDirectorState = {
            ...createInitialTensionDirectorState(tensionDirectorDefinition),
            currentTick: latestState.tick,
          };
          directorSafeTicks = 0;
          directorChaseTicks = 0;
          directorTicksSinceChaseEscape = null;
          directorWasChased = false;
          setTensionDirector({
            tier: "rest",
            score: 0,
            phase: "idle",
            kind: null,
            label: "公平节奏导演待机",
            progress: 0,
          });
        },
        setCaptureHold: (
          held,
          leaseMilliseconds = QA_CAPTURE_HOLD_DEFAULT_LEASE_MS,
        ) => {
          if (held) {
            const requestedLease = Number.isFinite(leaseMilliseconds)
              ? leaseMilliseconds
              : QA_CAPTURE_HOLD_DEFAULT_LEASE_MS;
            const boundedLease = THREE.MathUtils.clamp(
              requestedLease,
              250,
              QA_CAPTURE_HOLD_MAX_LEASE_MS,
            );
            qaCaptureHoldRequested = true;
            qaCaptureHoldDeadline = performance.now() + boundedLease;
          } else {
            qaCaptureHoldRequested = false;
            qaCaptureHoldAcknowledged = false;
            qaCaptureHoldDeadline = 0;
          }
        },
        completeMission: () => {
          if (libraryMissionState) {
            for (const objective of runtimeMissionObjectives) {
              const previous = libraryMissionState;
              const libraryStep = stepLibraryBranchingMission(
                LIBRARY_BRANCHING_MISSION,
                libraryMissionState,
                {
                  type: "attempt-objective",
                  objectiveId: objective.id,
                  outcome: "completed",
                },
              );
              libraryMissionState = libraryStep.state;
              recordLibraryMissionRuleEvents(
                libraryStep.events,
                latestState.tick,
              );
              missionState = adaptLibraryMissionTransitionToThemeMission(
                previous,
                libraryMissionState,
              ).state;
            }
          } else {
            for (const objective of missionDefinition.objectives) {
              if (missionState.completedObjectiveIds.includes(objective.id)) continue;
              missionState = stepThemeMission(
                missionDefinition,
                missionState,
                objective.id,
              ).state;
              recordPlayerRuleEvent({
                tick: latestState.tick,
                type: "objective-completed",
                objectiveId: objective.id,
              });
              if (missionState.exitUnlocked) {
                recordPlayerRuleEvent({
                  tick: latestState.tick,
                  type: "exit-unlocked",
                  objectiveId: objective.id,
                });
              }
            }
          }
          updateThemeMissionViews(performance.now());
        },
        setScenario: ({
          player,
          chaser,
          chaserHeading,
          spawnDelaySeconds = 0,
        }) => {
          simulation = new GameSimulation({
            level: campaignLevel,
            autoStart: true,
            initialPlayerPosition: player,
            initialChaserPosition: chaser,
            initialChaserHeading: chaserHeading,
            config: { ...gameplayConfig, spawnDelaySeconds },
            chaserArchetypeProfile,
          });
          latestState = simulation.getState();
          fixedStepHost = resetFixedStepHost(
            fixedStepHost,
            latestState.tick,
          );
          resetPresentation(latestState);
          // Idempotent: a settled QA scene compiles exactly once, whether the
          // harness waits at the briefing or immediately installs a scenario.
          compileSettledQaScene();
        },
      };
      qaWindow.__CHASING_QA__ = installedQaHook;
      if (
        qaLevelScenario !== null
        && qaLevelScenario !== campaignLevel.campaign.levelNumber
      ) {
        const selectQaLevelAfterCurrentSceneSettles = () => {
          if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
          if (
            !ready
            || !decorativeAssetsReady
            || deferredDressingFade !== null
            || pendingGlbLoadCount !== 0
            || !dependencyLoadingManagerIdle
          ) {
            qaLevelSelectionTimer = setTimeout(selectQaLevelAfterCurrentSceneSettles, 100);
            return;
          }
          installedQaHook.setUnlockedThrough(qaLevelScenario);
          installedQaHook.selectLevel(qaLevelScenario - 1);
        };
        qaLevelSelectionTimer = setTimeout(selectQaLevelAfterCurrentSceneSettles, 0);
      } else if (qaResolutionScenario) {
        const resolveQaMissionAfterSceneSettles = () => {
          if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
          if (
            !ready
            || !decorativeAssetsReady
            || deferredDressingFade !== null
            || pendingGlbLoadCount !== 0
            || !dependencyLoadingManagerIdle
          ) {
            qaLevelSelectionTimer = setTimeout(resolveQaMissionAfterSceneSettles, 100);
            return;
          }
          installedQaHook.setScenario({
            player: campaignLevel.exit,
            chaser: campaignLevel.chaserStart,
            chaserHeading: campaignLevel.chaserStartHeading,
            spawnDelaySeconds: 60,
          });
          ghostSimulation = null;
          ghostCursor = null;
          ghostState = null;
          ghostRecording = null;
          ghostRuleProgressTracker = null;
          ghostRuleProgress = null;
          if (ghostActor) ghostActor.root.visible = false;
          installedQaHook.completeMission();
        };
        qaLevelSelectionTimer = setTimeout(resolveQaMissionAfterSceneSettles, 0);
      } else if (qaPlayerScenario && qaChaserScenario) {
        queueMicrotask(() => {
          if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
          installedQaHook.setScenario({
            player: qaPlayerScenario,
            chaser: qaChaserScenario,
            spawnDelaySeconds: qaSpawnDelaySeconds,
          });
        });
      }
      if (qaPoliceAnimationScenario) {
        const applyQaPoliceAnimationWhenReady = () => {
          if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
          if (!ready) {
            qaPoliceAnimationTimer = setTimeout(applyQaPoliceAnimationWhenReady, 100);
            return;
          }
          if (!actors.police) {
            void requestPoliceAsset?.();
            qaPoliceAnimationTimer = setTimeout(applyQaPoliceAnimationWhenReady, 100);
            return;
          }
          const action = actors.police.animator.play(
            qaPoliceAnimationScenario as AnimationState,
            {
              fade: 0,
              restart: true,
              loop: qaPoliceAnimationScenario === "idle"
                || qaPoliceAnimationScenario === "run"
                || qaPoliceAnimationScenario === "alert",
            },
          );
          if (!action) return;
          actors.police.lastRequested = qaPoliceAnimationScenario as AnimationState;
          if (qaPoliceAnimationTime !== null) {
            action.time = action.getClip().duration * qaPoliceAnimationTime;
            action.paused = true;
            actors.police.animator.mixer.update(0);
          }
        };
        qaPoliceAnimationTimer = setTimeout(applyQaPoliceAnimationWhenReady, 0);
        const mirrorQaPoliceAnimationFrame = () => {
          if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
          document.documentElement.dataset.chasingQaPoliceAnimationSnapshot = JSON.stringify({
            capturedAtMilliseconds: performance.now(),
            animation: actors.police?.animator.snapshot() ?? null,
          });
        };
        mirrorQaPoliceAnimationFrame();
        qaPoliceFrameSnapshotTimer = setInterval(mirrorQaPoliceAnimationFrame, 16);
      }
      if (qaKidAnimationScenario) {
        const applyQaKidAnimationWhenReady = () => {
          if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
          if (!ready || !actors.kid) {
            qaKidAnimationTimer = setTimeout(applyQaKidAnimationWhenReady, 100);
            return;
          }
          const action = actors.kid.animator.play(
            qaKidAnimationScenario as AnimationState,
            {
              fade: 0,
              restart: true,
              loop: qaKidAnimationScenario === "idle"
                || qaKidAnimationScenario === "walk"
                || qaKidAnimationScenario === "run"
                || qaKidAnimationScenario === "hideIdle",
            },
          );
          if (!action) return;
          actors.kid.lastRequested = qaKidAnimationScenario as AnimationState;
          if (qaKidAnimationTime !== null) {
            action.time = action.getClip().duration * qaKidAnimationTime;
            action.paused = true;
            actors.kid.animator.mixer.update(0);
          }
        };
        qaKidAnimationTimer = setTimeout(applyQaKidAnimationWhenReady, 0);
        const mirrorQaKidAnimationFrame = () => {
          if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
          document.documentElement.dataset.chasingQaKidAnimationSnapshot = JSON.stringify({
            capturedAtMilliseconds: performance.now(),
            animation: actors.kid?.animator.snapshot() ?? null,
          });
        };
        mirrorQaKidAnimationFrame();
        qaKidFrameSnapshotTimer = setInterval(mirrorQaKidAnimationFrame, 16);
      }
      const mirrorQaSnapshot = () => {
        if (disposed || qaWindow.__CHASING_QA__ !== installedQaHook) return;
        const snapshot = installedQaHook.getState() as {
          ready?: boolean;
          campaign?: unknown;
          game?: {
            phase?: unknown;
            player?: unknown;
            chaser?: unknown;
          };
          animations?: { kid?: unknown; villain?: unknown; police?: unknown };
          visibility?: { kid?: unknown; villain?: unknown; police?: unknown };
          assets?: unknown;
          preferences?: unknown;
          themeMission?: unknown;
          sceneIntegrity?: unknown;
          camera?: unknown;
          render?: unknown;
          firstPlayableBudget?: unknown;
        } | undefined;
        if (!snapshot) return;
        document.documentElement.dataset.chasingQaSnapshot = JSON.stringify({
          ready: snapshot.ready,
          campaign: snapshot.campaign,
          game: {
            phase: snapshot.game?.phase,
            player: snapshot.game?.player,
            chaser: snapshot.game?.chaser,
          },
          animations: {
            kid: snapshot.animations?.kid,
            villain: snapshot.animations?.villain,
            police: snapshot.animations?.police,
          },
          visibility: {
            kid: snapshot.visibility?.kid,
            villain: snapshot.visibility?.villain,
            police: snapshot.visibility?.police,
          },
          assets: snapshot.assets,
          preferences: snapshot.preferences,
          themeMission: snapshot.themeMission,
          sceneIntegrity: snapshot.sceneIntegrity,
          camera: snapshot.camera,
          render: snapshot.render,
          firstPlayableBudget: snapshot.firstPlayableBudget,
        });
      };
      mirrorQaSnapshot();
      qaDomSnapshotTimer = setInterval(mirrorQaSnapshot, 180);
    }

    void loadAll().catch((error: unknown) => {
      // A level switch/unmount intentionally aborts in-flight loads. Reporting
      // that expected cancellation as a production failure creates false
      // console errors and obscures genuine asset faults.
      if (disposed) return;
      console.error("Production asset load failed", error);
      setLoadError(assetLoadRecoveryMessage(error, navigator.onLine));
    });
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      sceneAssets.abort(new DOMException("Scene disposed", "AbortError"));
      scorePrewarmAbort.abort();
      ready = false;
      requestPoliceAsset = null;
      commands.current = NOOP_COMMANDS;
      if (resultTimer) clearTimeout(resultTimer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      touchLayoutMedia.removeEventListener("change", resize);
      host.removeEventListener("wheel", wheel);
      document.removeEventListener("visibilitychange", resetFrameClock);
      removeEventListener("pageshow", resetFrameClock);
      renderer.domElement.removeEventListener("webglcontextlost", handleContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", handleContextRestored);
      const ownsQaHook = installedQaHook === null || qaWindow.__CHASING_QA__ === installedQaHook;
      if (ownsQaHook) {
        delete document.documentElement.dataset.chasingReady;
        delete document.documentElement.dataset.chasingQuality;
        delete document.documentElement.dataset.chasingEmergency;
        delete document.documentElement.dataset.chasingQaSnapshot;
        delete document.documentElement.dataset.chasingQaKidAnimationSnapshot;
        delete document.documentElement.dataset.chasingQaPoliceAnimationSnapshot;
        delete document.documentElement.dataset.chasingQaCleanFrame;
      }
      if (qaDomSnapshotTimer !== null) clearInterval(qaDomSnapshotTimer);
      if (qaLevelSelectionTimer !== null) clearTimeout(qaLevelSelectionTimer);
      if (qaKidAnimationTimer !== null) clearTimeout(qaKidAnimationTimer);
      if (qaKidFrameSnapshotTimer !== null) clearInterval(qaKidFrameSnapshotTimer);
      if (qaPoliceAnimationTimer !== null) clearTimeout(qaPoliceAnimationTimer);
      if (qaPoliceFrameSnapshotTimer !== null) clearInterval(qaPoliceFrameSnapshotTimer);
      const runtimePlayfield = host.parentElement;
      if (runtimePlayfield?.classList.contains("playfield")) {
        runtimePlayfield.classList.remove(
          "stealth-blackout-active",
          "mirror-threat-visible",
          "director-warning",
          "director-active",
        );
        runtimePlayfield.style.removeProperty("--director-progress");
      }
      if (installedQaHook && qaWindow.__CHASING_QA__ === installedQaHook) {
        if (qaWindow.__CHASING_QA__) delete qaWindow.__CHASING_QA__;
      }
      for (const actor of Object.values(actors)) actor?.animator.dispose();
      ghostActor?.animator.dispose();
      for (const locker of lockers.values()) locker.mixer.stopAllAction();
      void score.dispose();
      void soundscape.dispose();
      if (environmentScheduleHandle !== null) {
        if (environmentScheduledWithIdleCallback) {
          (window as Window & { cancelIdleCallback?: (handle: number) => void })
            .cancelIdleCallback?.(environmentScheduleHandle);
        } else {
          clearTimeout(environmentScheduleHandle);
        }
        environmentScheduleHandle = null;
      }
      environmentTarget?.dispose();
      for (const view of portableDecoyViews.values()) {
        disposePortableDecoyView(view);
      }
      portableDecoyViews.clear();
      for (const view of [...stealthEvidenceViews.values()]) {
        disposeStealthEvidenceView(view);
      }
      footprintEvidenceGeometry.dispose();
      footprintEvidenceMaterial.dispose();
      footprintEvidenceTexture.dispose();
      for (const view of [...stealthToolWorldViews.values()]) {
        disposeStealthToolWorldView(view);
      }
      disposeObjectResources([
        scene,
        ...loadedAssetRoots,
        ...(portableDecoyTemplate ? [portableDecoyTemplate] : []),
        ...Object.values(stealthToolModelTemplates),
      ]);
      // GLTFLoader may still be decoding an image from one of these blob URLs
      // after React has requested a level switch. Revoke only after every
      // parse settles; the disposed branch above immediately destroys any
      // late scene, so this retains neither render objects nor long-lived URLs.
      releaseControlledDependencyResourcesWhenSettled();
      renderer.renderLists.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [
    atmosphere,
    campaignLevel,
    chaserArchetypeProfile,
    chooseRemixVariant,
    gameplayConfig,
    hideGuidancePolicy.tutorialHideSpotId,
    libraryGoldEnabled,
    masteryTargetOptions,
    objectivePaths,
    preferences.personalGhostEnabled,
    preferences.ruleset,
    resetAnalogueMove,
    resolvedRemix.mechanicPlacementGroup,
    resolvedRemix.runIdentity,
    runRecordLevelId,
    runReplayLevelId,
    sceneRevision,
    selectedLibraryPlan,
    selectedRemixContract,
  ]);

  const touch = (key: string, active: boolean) => {
    if (active) touchKeys.current.add(key);
    else touchKeys.current.delete(key);
  };
  const loadPercent = Math.round((loadProgress.done / loadProgress.total) * 100);
  const danger = chaserObservable
    ? threatForMode(chaserMode)
    : publicThreat === "active" ? 0.52 : publicThreat === "caution" ? 0.28 : 0;
  const stealthBlackoutActive = Boolean(
    stealthSystems?.toolbelt.tools["temporary-blackout"].phase === "active"
    || (
      tensionDirector?.phase === "active"
      && tensionDirector.kind === "blackout"
    ),
  );
  const themeEventActivity = themeMechanic?.phase === "active"
    ? Math.sin(themeMechanic.progress * Math.PI)
    : 0;
  const themeEventVisible = Boolean(
    themeMechanic
    && (
      themeMechanic.phase !== "ready"
      || (
        !stealthBlackoutActive
        && (
          themeMechanic.canActivate
          || themeMechanic.distanceMeters <= 10
        )
      )
    ),
  );
  const activeMissionObjective = themeMission?.activeObjective ?? null;
  const missionCanInteract = Boolean(
    activeMissionObjective
    && themeMission?.canInteract,
  );
  const missionInteractionInProgress = themeMission?.commitmentProgress !== null
    && themeMission?.commitmentProgress !== undefined;
  const storedCurrentRunRecord = getCampaignRunRecord(
    campaignProgress,
    runRecordLevelId,
    preferences.ruleset,
  );
  const legacyLibraryRunRecord = libraryGoldEnabled
    ? getCampaignRunRecord(
        campaignProgress,
        campaignLevel.id,
        preferences.ruleset,
      )
    : null;
  const branchRecordOrLegacy = libraryGoldEnabled
    && !storedCurrentRunRecord.bestSeconds
    && !storedCurrentRunRecord.mastery
    && legacyLibraryRunRecord
    ? legacyLibraryRunRecord
    : storedCurrentRunRecord;
  const currentRunRecord = selectedRemixContract
    ? {
        ...storedCurrentRunRecord,
        bestSeconds: remixRecord?.bestSeconds ?? storedCurrentRunRecord.bestSeconds,
        mastery: remixRecord?.mastery ?? storedCurrentRunRecord.mastery,
      }
    : branchRecordOrLegacy;
  const unlockedThrough = getCampaignUnlockedThrough(
    campaignProgress,
    preferences.ruleset,
  );
  const layoutLabel = selectedRemixVariant === null
    ? "原版布局"
    : `认证布局 ${(selectedRemixVariant + 1).toString().padStart(2, "0")}`;
  const observableArchetypeStatus = chaserObservable
    ? chaserArchetypeRuntime?.phase === "telegraph"
      ? chaserArchetypeRuntime.cueLabel
      : chaserArchetypeRuntime?.phase === "acting"
        ? chaserArchetypeActionStatus(chaserArchetypeRuntime.action)
        : null
    : null;
  const displayedChaserStatus = chaserObservable
    ? observableArchetypeStatus
      ?? (chaserConfirming ? "重新确认目标" : chaserStatus(chaserMode))
    : publicThreat === "active"
      ? "位置未确认 · 威胁声活跃"
      : publicThreat === "caution"
        ? "位置未确认 · 仍在附近搜索"
        : "位置未确认 · 环境已安静";
  const selectedLibraryPlanDefinition = libraryGoldEnabled
    ? LIBRARY_BRANCHING_MISSION.plans
      .find((plan) => plan.id === selectedLibraryPlan) ?? null
    : null;
  const displayedMissionObjectives = selectedLibraryPlanDefinition
    ? selectedLibraryPlanDefinition.objectiveIds.map((objectiveId) => {
        const objective = LIBRARY_BRANCHING_MISSION.objectives
          .find((candidate) => candidate.id === objectiveId);
        if (!objective) throw new Error(`图书楼任务简报缺少 ${objectiveId}`);
        return objective;
      })
    : themeMissionDefinition(campaignLevel.campaign.theme).objectives;
  const displayedMissionTitle = selectedLibraryPlanDefinition
    ? `${LIBRARY_BRANCHING_MISSION.title} · ${selectedLibraryPlanDefinition.label}`
    : themeMissionDefinition(campaignLevel.campaign.theme).title;
  const readyCampaignBriefing = selectedRemixContract
    ? `${campaignLevel.campaign.briefing} ${layoutLabel}已按固定认证方案重编路线连通、巡逻顺序、任务位置与藏点组合；它不是临场随机生成，每次挑战都可学习、可复盘。`
    : `${campaignLevel.campaign.briefing}${
        selectedLibraryPlanDefinition
          ? ` 本次采用「${selectedLibraryPlanDefinition.label}」：${selectedLibraryPlanDefinition.strategy}`
          : ""
      }`;
  const readyBriefing = `${readyCampaignBriefing} 本关追捕者为「${chaserArchetypeProfile.label}」：${chaserArchetypeProfile.readableRule}`;
  const showResult = phase === "ready" || ((phase === "won" || phase === "lost") && resultVisible);
  const interactionSpot = interaction
    ? campaignLevel.hideSpots.find((spot) => spot.id === interaction.hideSpotId)
    : null;
  const interactionArchetype = interactionSpot?.archetype ?? "hard-locker";
  const hideArchetypeLabel = interactionArchetype === "soft-cover"
    ? "软质遮挡"
    : interactionArchetype === "traversal-hide"
      ? "穿行藏点"
      : "硬质藏柜";
  const interactionText = interaction?.kind === "enter"
    ? `进入${hideArchetypeLabel}`
    : interaction?.kind === "exit"
      ? interactionArchetype === "traversal-hide"
        ? `${hideExitSelection?.selected === "alternate" ? "从另一侧" : "从原入口"}离开`
        : publicThreat === "calm" ? `离开${hideArchetypeLabel}` : `冒险离开${hideArchetypeLabel}`
      : missionCanInteract && activeMissionObjective
        ? missionInteractionInProgress
          ? `操作中 ${Math.ceil((themeMission?.commitmentRemainingSeconds ?? 0) * 10) / 10}s`
          : activeMissionObjective.interactionPrompt
      : themeMechanic?.canActivate && !stealthBlackoutActive
        ? `启动${themeMechanic.label}`
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
  const touchInteractAvailable = Boolean(interaction)
    || missionCanInteract
    || missionInteractionInProgress
    || Boolean(themeMechanic?.canActivate && !stealthBlackoutActive)
    || playerMode === "aligning-hide";
  const portableDecoyActionAvailable = Boolean(
    libraryGoldEnabled
    && portableDecoy?.canDeploy
    && phase === "playing"
    && !paused
    && playerMode === "free"
    && !interaction
    && !missionInteractionInProgress
    && !themeMechanic?.movementCommitted,
  );
  const portableDecoyPhaseLabel = interaction
    ? "离开藏点后投掷"
    : portableDecoy?.phase === "arming"
    ? "投掷中"
    : portableDecoy?.phase === "awaiting-delivery"
      ? "声源接入中"
    : portableDecoy?.phase === "awaiting-investigation"
      ? "声源待调查"
      : portableDecoy?.phase === "cooldown"
        ? `冷却 ${portableDecoy.cooldownRemainingSeconds.toFixed(1)}s`
        : portableDecoy?.phase === "depleted"
          ? "本局已用完"
          : "可投掷";
  const selectedToolMeta = STEALTH_TOOL_UI[selectedStealthTool];
  const selectedToolSample =
    stealthSystems?.toolbelt.tools[selectedStealthTool] ?? null;
  const stealthToolActionAvailable = Boolean(
    selectedToolSample?.canUse
    && phase === "playing"
    && !paused
    && playerMode === "free"
    && !missionInteractionInProgress
    && !themeMechanic?.movementCommitted
    && !stealthSystems?.countermeasureBusy,
  );
  const selectedToolPhaseLabel = selectedToolSample?.phase === "commitment"
    ? `部署 ${
        (selectedToolSample.commitmentRemainingTicks / 60).toFixed(1)
      }s`
    : selectedToolSample?.phase === "active"
      ? `生效 ${
          (selectedToolSample.effectRemainingTicks / 60).toFixed(1)
        }s`
      : selectedToolSample?.phase === "cooldown"
        ? `冷却 ${
            (selectedToolSample.cooldownRemainingTicks / 60).toFixed(1)
          }s`
        : selectedToolSample?.phase === "depleted"
          ? "已耗尽"
          : "可部署";
  const evidenceEraseAvailable = Boolean(
    stealthSystems
    && stealthSystems.evidenceCount > 0
    && stealthSystems.countermeasureBudget > 0
    && !stealthSystems.countermeasureBusy
    && phase === "playing"
    && playerMode === "free",
  );
  const stealthRuntimeMessage = tensionDirector?.phase === "warning"
    ? `环境预告 · ${tensionDirector.label}`
    : tensionDirector?.phase === "active"
      ? `环境事件 · ${tensionDirector.label}`
      : stealthSystems?.notice
        ?? (stealthSystems?.mirrorThreatVisible
          ? "镜面已捕捉追捕者 · 可安全判断出柜时机"
          : `${selectedToolMeta.label} · ${selectedToolPhaseLabel}`);
  const primaryAction = phase === "won" && hasNextLevel
    ? () => chooseLevel(selectedLevelIndex + 1)
    : begin;
  const hideRiskLabel = hideGuideRisk === "low" ? "低风险" : hideGuideRisk === "medium" ? "风险未知" : "高风险";
  const hideGuideTitle = hideGuideStrategy === "break-line-of-sight"
    ? "暂无线安全藏柜"
    : hideGuideSelection === "tutorial"
      ? "教学安全藏身柜"
      : hideGuideSelection === "held"
        ? "保持当前安全路线"
        : "生存优先藏身柜";
  const showHideGuidance = !currentRunRecord.bestSeconds
    || danger >= 0.28
    || hideGuideStrategy === "break-line-of-sight"
    || hideDistance <= 6;
  const captureFeedback = failureFeedback(lastCaptureReason);

  return (
    <main
      className={`game-shell hud-${preferences.hudDensity}${preferences.highContrast ? " high-contrast" : ""}${preferences.reducedMotion ? " reduced-motion" : ""}`}
      data-ruleset={preferences.ruleset}
    >
      <header className="hud">
        <div className="title-lockup">
          <span className="eyebrow">CHASING · 3D 追逐模式 · 第 {campaignLevel.campaign.levelNumber.toString().padStart(2, "0")} 关 · {campaignLevel.campaign.themeLabel} · {layoutLabel}</span>
          <h1>{campaignLevel.campaign.name}</h1>
        </div>
        <div className="stats">
          <span className="chapter">关卡 <b>{campaignLevel.campaign.levelNumber}/10</b></span>
          <span>用时 <b>{elapsed}s</b></span>
          <span className="objective">
            {themeMission?.state.exitUnlocked ? "出口" : "当前任务"} <b>{objectiveDistance}m</b>
          </span>
          <span className={`status danger-${Math.round(danger * 10)}`}><i />{displayedChaserStatus}</span>
          <button type="button" aria-label={musicMuted ? "打开声音" : "静音"} onClick={() => commands.current.toggleMute()}>{musicMuted ? "声音关" : "声音开"}</button>
          <button type="button" disabled={loading || phase !== "playing"} onClick={() => commands.current.togglePause()}>暂停</button>
          <button type="button" disabled={loading} onClick={restart}>重新开始</button>
        </div>
      </header>

      <section
        className={`playfield theme-${campaignLevel.campaign.theme} threat-${chaserObservable ? "visible" : `public-${publicThreat}`} mode-${playerMode}${activeHideArchetype ? ` hide-${activeHideArchetype}` : ""}${themeMechanic?.phase === "active" ? " theme-event-active" : ""}${missionInteractionInProgress ? " mission-commitment-active" : ""}${activeHideArchetype === "hard-locker" && ["hidden", "entering-peek", "peeking", "exiting-peek"].includes(playerMode) ? " locker-interior" : ""}${ghostRace?.visible ? " ghost-race-active" : ""}${stealthBlackoutActive ? " stealth-blackout-active" : ""}${stealthSystems?.mirrorThreatVisible ? " mirror-threat-visible" : ""}${tensionDirector?.phase === "warning" ? " director-warning" : tensionDirector?.phase === "active" ? " director-active" : ""}`}
        style={{
          "--threat": danger,
          "--theme-event": themeEventActivity,
          "--director-progress": tensionDirector?.progress ?? 0,
          "--theme-accent": campaignLevel.campaign.palette.accent,
          "--theme-glow": campaignLevel.campaign.palette.emissive,
        } as React.CSSProperties}
      >
        <div className="three-mount" ref={mount} />
        <div className="cinematic-vignette" aria-hidden="true" />
        <div className="theme-event-wash" aria-hidden="true" />
        <div className="stealth-blackout-wash" aria-hidden="true" />
        <div className="director-cue-frame" aria-hidden="true" />

        {loading && (
          <div className={`loading-card${loadError ? " error" : ""}`} role="status">
            <span className="loader-dot" />
            <div>
              <strong>{loadError || loadProgress.message}</strong>
              {!loadError && <div className="load-bar"><i style={{ width: `${loadPercent}%` }} /></div>}
              {!loadError && <small>{campaignLevel.campaign.themeLabel}主题高模、角色动作、动态灯光与互动资产 · {loadPercent}%</small>}
              {loadError && <button type="button" onClick={retryScene}>原地重试</button>}
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
          <div className={`awareness awareness-unknown public-${publicThreat}`} role="status">
            <span />
            <div>
              <small>追捕者情报</small>
              <strong>
                {publicThreat === "active"
                  ? "位置未确认 · 威胁声仍活跃"
                  : publicThreat === "caution"
                    ? "位置未确认 · 搜索声正在减弱"
                    : "位置未确认 · 已连续安静"}
              </strong>
            </div>
          </div>
        )}

        {!loading && !paused && phase === "playing" && themeMission && (
          <div
            className={`mission-status stage-${themeMission.state.stage}`}
            role="group"
            aria-label={`主题任务，已完成 ${themeMission.completedCount} 项，共 ${themeMission.totalCount} 项`}
          >
            <span aria-hidden="true" />
            <div>
              <small>
                {displayedMissionTitle} · {themeMission.completedCount}/{themeMission.totalCount}
              </small>
              <strong>
                {themeMission.state.exitUnlocked
                  ? "出口已解锁 · 立即撤离"
                  : missionInteractionInProgress
                    ? `正在执行 · ${themeMission.activeObjective?.label ?? "任务操作"}`
                    : themeMission.activeObjective?.label ?? "确认撤离路线"}
              </strong>
              {!themeMission.state.exitUnlocked && themeMission.activeDistanceMeters !== null && (
                <em>
                  {missionInteractionInProgress
                    ? `保持位置 ${Math.max(0, themeMission.commitmentRemainingSeconds ?? 0).toFixed(1)}s`
                    : libraryGoldEnabled
                      ? `${themeMission.activeDistanceMeters}m · 按所选计划依次完成目标`
                      : `${themeMission.activeDistanceMeters}m · 可按任意顺序完成准备目标`}
                </em>
              )}
            </div>
          </div>
        )}

        {!loading && !paused && phase === "playing" && ghostRace?.visible && (
          <div
            className={`ghost-race leader-${ghostRace.leader}`}
            role="group"
            aria-label="个人最佳幽灵竞速"
          >
            <span aria-hidden="true" />
            <div>
              <small>PERSONAL GHOST · 参考 {ghostRace.referenceSeconds.toFixed(2)}s</small>
              <strong>
                {ghostRace.leader === "tied"
                  ? ghostRace.ruleFaithful
                    ? "与最佳任务进度并行"
                    : "与最佳路线并行"
                  : ghostRace.leader === "player"
                    ? ghostRace.ruleFaithful
                      ? `领先任务进度 ${Math.abs(ghostRace.playerLeadProgress * 100).toFixed(0)}%`
                      : `领先 ${Math.abs(ghostRace.playerLeadMeters).toFixed(1)}m`
                    : ghostRace.ruleFaithful
                      ? `落后任务进度 ${Math.abs(ghostRace.playerLeadProgress * 100).toFixed(0)}%`
                      : `落后 ${Math.abs(ghostRace.playerLeadMeters).toFixed(1)}m`}
              </strong>
              {ghostRace.latestSplit && (
                <em>
                  {ghostRace.latestSplit.label} {
                    ghostRace.latestSplit.deltaSeconds <= 0 ? "快" : "慢"
                  } {Math.abs(ghostRace.latestSplit.deltaSeconds).toFixed(2)}s
                </em>
              )}
            </div>
          </div>
        )}

        {!loading && !paused && phase === "playing" && themeEventVisible && themeMechanic && (
          <div className={`theme-mechanic phase-${themeMechanic.phase}`} role="status" aria-live="polite">
            <span aria-hidden="true" />
            <div>
              <small>
                主动机关 · {themeMechanic.distanceMeters}m · {
                  themeMechanic.phase === "ready"
                    ? themeMechanic.canActivate ? "可启动" : "未启动"
                    : themeMechanic.phase === "warning"
                      ? "预警"
                      : themeMechanic.phase === "active"
                        ? "生效中"
                        : "冷却中"
                }
              </small>
              <strong>{themeMechanic.hudHint}</strong>
              {themeMechanic.canActivate
                && !stealthBlackoutActive
                && <em>{themeMechanic.activationCostLabel}</em>}
            </div>
          </div>
        )}

        {!loading && !paused && phase === "playing" && libraryGoldEnabled && portableDecoy && (
          <div
            className={`portable-decoy-status phase-${portableDecoy.phase}`}
            role="status"
            aria-live="polite"
          >
            <button
              type="button"
              disabled={!portableDecoyActionAvailable}
              onClick={deployDecoy}
              aria-label={`投掷精装笔记本诱饵，剩余 ${portableDecoy.inventoryRemaining} 枚`}
            >
              <span aria-hidden="true">▰</span>
              <div>
                <small>可携式诱饵 · 剩余 {portableDecoy.inventoryRemaining}/{
                  LIBRARY_PORTABLE_DECOY_DEFINITION.capacity
                }</small>
                <strong>{portableDecoyNotice ?? portableDecoyPhaseLabel}</strong>
              </div>
              <kbd className="desktop-key">F</kbd>
            </button>
            <i
              style={{
                "--decoy-progress": `${Math.round(portableDecoy.progress * 100)}%`,
              } as React.CSSProperties}
            />
          </div>
        )}

        {!loading && !paused && phase === "playing" && stealthSystems && (
          <div
            className={`stealth-toolbelt-status${libraryGoldEnabled ? " with-decoy" : ""} director-${tensionDirector?.phase ?? "idle"}`}
            role="group"
            aria-label="潜行工具、公开线索与公平节奏导演"
          >
            <div className="stealth-system-readout">
              <span
                className={`director-orb tier-${tensionDirector?.tier ?? "rest"}`}
                aria-hidden="true"
              />
              <div>
                <small data-stealth-evidence-summary="desktop">
                  TACTICAL STEALTH · 线索 {stealthSystems.evidenceCount} · 反侦察 {
                    stealthSystems.countermeasureBudget
                  }
                </small>
                <strong
                  data-stealth-runtime-message
                  data-runtime-director-phase={
                    tensionDirector?.phase !== "idle"
                      ? tensionDirector?.phase
                      : undefined
                  }
                  data-runtime-director-kind={tensionDirector?.kind ?? undefined}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {stealthRuntimeMessage}
                </strong>
              </div>
              <button
                type="button"
                className="erase-evidence"
                disabled={phase !== "playing" || paused || playerMode !== "free"}
                data-evidence-ready={evidenceEraseAvailable ? "true" : "false"}
                onClick={eraseEvidence}
                aria-label={`抹除附近公开线索，反侦察次数剩余 ${stealthSystems.countermeasureBudget}`}
              >
                抹迹 <kbd className="desktop-key">C</kbd>
              </button>
            </div>
            <div
              className="stealth-mobile-notice"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <strong data-stealth-mobile-message>{stealthRuntimeMessage}</strong>
              <small data-stealth-evidence-summary="compact">
                线索 {stealthSystems.evidenceCount} · 反侦察 {
                  stealthSystems.countermeasureBudget
                }
              </small>
            </div>
            <div className="stealth-tool-row">
              <button
                type="button"
                className="erase-evidence-mobile"
                disabled={phase !== "playing" || paused || playerMode !== "free"}
                data-evidence-ready={evidenceEraseAvailable ? "true" : "false"}
                onClick={eraseEvidence}
                aria-label={`抹除附近公开线索，反侦察次数剩余 ${stealthSystems.countermeasureBudget}`}
                title="抹除附近公开线索"
              >
                <i aria-hidden="true">抹</i>
                <span>
                  <b>抹迹</b>
                  <small>{stealthSystems.countermeasureBudget} 次</small>
                </span>
              </button>
              {([
                "door-wedge",
                "corner-mirror",
                "temporary-blackout",
              ] as const).map((tool, index) => {
                const sample = stealthSystems.toolbelt.tools[tool];
                const selected = selectedStealthTool === tool;
                return (
                  <button
                    type="button"
                    key={tool}
                    data-stealth-tool={tool}
                    className={`${selected ? "selected" : ""} phase-${sample.phase}`}
                    aria-pressed={selected}
                    disabled={selected && !stealthToolActionAvailable}
                    onClick={() => {
                      if (selected) deployStealthTool();
                      else chooseStealthTool(tool);
                    }}
                    title={`${STEALTH_TOOL_UI[tool].hint}；按 ${index + 1} 选择，G 使用`}
                  >
                    <i aria-hidden="true">{STEALTH_TOOL_UI[tool].glyph}</i>
                    <span>
                      <b>{STEALTH_TOOL_UI[tool].label}</b>
                      <small>{sample.inventoryRemaining} 剩余</small>
                    </span>
                    <kbd className="desktop-key">{index + 1}</kbd>
                  </button>
                );
              })}
            </div>
            <i
              className="director-progress"
              style={{
                transform: "scaleX(var(--director-progress, 0))",
              }}
            />
          </div>
        )}

        {!loading && phase === "playing" && objectiveTurnHint && (
          <div className="objective-route-guide" role="group" aria-label={`路线提示，${objectiveTurnHint.distanceMeters} 米后转向`}>
            <span aria-hidden="true">{objectiveTurnHint.arrow}</span>
            <div>
              <small>迷路辅助 · 路径转向</small>
              <strong>{objectiveTurnHint.distanceMeters}m 后按箭头转向</strong>
            </div>
          </div>
        )}

        {!loading && !paused && phase === "playing" && playerMode === "free" && !interaction && showHideGuidance && (
          <div
            className={`hide-guide risk-${hideGuideRisk}${hideGuideStrategy === "break-line-of-sight" ? " strategy-break" : ""}${danger >= 0.45 ? " urgent" : ""}`}
            aria-label={`${hideGuideTitle}，距离 ${hideDistance} 米${hideGuideStrategy === "hide" ? `，${hideRiskLabel}` : ""}`}
          >
            <span aria-hidden="true" />
            <div>
              <small>{hideGuideTitle}{hideGuideStrategy === "hide" ? ` · ${hideRiskLabel}` : ""}</small>
              <strong>
                {hideDistance}m · {hideGuideStrategy === "break-line-of-sight"
                  ? "先到遮挡点，切断视线再找柜"
                  : hideGuideRisk === "high"
                    ? "先切断视线再接近"
                    : "按可见标记前进"}
              </strong>
            </div>
          </div>
        )}

        {!loading
          && phase === "playing"
          && !paused
          && playerMode === "free"
          && !interaction
          && hideGuideProjection
          && (hideGuideProjection.offscreen || hideGuideStrategy === "break-line-of-sight") && (
          <div
            className={`hide-edge-marker risk-${hideGuideRisk}${hideGuideProjection.offscreen ? " offscreen" : " onscreen"}${hideGuideStrategy === "break-line-of-sight" ? " cover-waypoint" : ""}`}
            aria-hidden="true"
            style={{
              left: `${hideGuideProjection.xPercent}%`,
              top: `${hideGuideProjection.yPercent}%`,
              "--hide-direction": `${hideGuideProjection.angleDegrees}deg`,
            } as React.CSSProperties}
          >
            <i /><b>{hideGuideStrategy === "break-line-of-sight" ? "遮挡" : `${hideDistance}m`}</b>
          </div>
        )}

        {interactionText && phase === "playing" && !paused && (
          <div className="interaction-prompt">
            <kbd className="desktop-key">E</kbd>
            <kbd className="touch-key">互动</kbd>
            <strong>{interactionText}</strong>
            {missionCanInteract && activeMissionObjective && (
              <small>{activeMissionObjective.completionHint}</small>
            )}
            {themeMechanic?.canActivate
              && !stealthBlackoutActive
              && !interaction
              && !missionCanInteract && (
              <small>{themeMechanic.activationCostLabel}；预警结束后效果才会生效</small>
            )}
            {playerMode === "aligning-hide" && <small>移动或再次互动可立即取消</small>}
            {interaction?.kind === "exit" && publicThreat !== "calm" && (
              <small>外面仍有威胁声；建议等提示恢复绿色后再离柜</small>
            )}
            {activeHideArchetype === "hard-locker"
              && (playerMode === "hidden" || playerMode === "entering-peek" || playerMode === "peeking" || playerMode === "exiting-peek")
              && <small>按住 Q 从门缝观察，会重新暴露；松开后再离柜</small>}
            {activeHideArchetype === "soft-cover" && playerMode === "hidden" && (
              <small>遮挡并不完全；追捕者靠近并正面观察时仍可能发现你</small>
            )}
            {activeHideArchetype === "traversal-hide" && playerMode === "hidden" && (
              <small>可先切换出口，再互动离开；另一侧更快改线，但会制造更明显动静</small>
            )}
          </div>
        )}

        {phase === "playing"
          && !paused
          && activeHideArchetype === "traversal-hide"
          && hideExitSelection?.options.some((option) => option.kind === "alternate")
          && (
            <div className="hide-exit-selector" role="group" aria-label="选择穿行藏点出口">
              <button
                type="button"
                aria-pressed={hideExitSelection.selected === "origin"}
                onClick={() => {
                  preferredHideExit.current = "origin";
                  setHideExitSelection((current) => current
                    ? { ...current, selected: "origin" }
                    : current);
                }}
              >
                原入口
              </button>
              <button
                type="button"
                aria-pressed={hideExitSelection.selected === "alternate"}
                onClick={() => {
                  preferredHideExit.current = "alternate";
                  setHideExitSelection((current) => current
                    ? { ...current, selected: "alternate" }
                    : current);
                }}
              >
                另一侧 <kbd>X</kbd>
              </button>
            </div>
          )}

        {paused && !loading && phase === "playing" && (
          <div className="pause-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title">
            <div className="pause-card">
              <span className="result">游戏已暂停</span>
              <h2 id="pause-title">先看清路线，再继续逃跑</h2>
              <p>暂停期间关卡、追捕者、计时与主题事件全部冻结。</p>
              <div className="pause-settings" aria-label="快速设置">
                <button type="button" onClick={() => commands.current.toggleMute()}>
                  {musicMuted ? "打开声音" : "静音"}
                </button>
                <button type="button" onClick={() => commands.current.adjustZoom(1.12)}>缩小视野</button>
                <button type="button" onClick={() => commands.current.adjustZoom(1 / 1.12)}>放大视野</button>
                <button type="button" onClick={() => commands.current.resetZoom()}>重置视野</button>
                <button
                  type="button"
                  aria-pressed={preferences.hudDensity === "full"}
                  onClick={() => updatePreferences({
                    hudDensity: preferences.hudDensity === "full" ? "cinematic" : "full",
                  })}
                >
                  {preferences.hudDensity === "full" ? "切到电影 HUD" : "切到完整 HUD"}
                </button>
                <button
                  type="button"
                  aria-pressed={preferences.highContrast}
                  onClick={() => updatePreferences({ highContrast: !preferences.highContrast })}
                >
                  {preferences.highContrast ? "关闭高对比" : "开启高对比"}
                </button>
                <button
                  type="button"
                  aria-pressed={preferences.reducedMotion}
                  onClick={() => updatePreferences({ reducedMotion: !preferences.reducedMotion })}
                >
                  {preferences.reducedMotion ? "恢复动态" : "减少动态"}
                </button>
              </div>
              <div className="pause-actions">
                <button
                  className="primary"
                  type="button"
                  ref={resumeButton}
                  onClick={() => commands.current.togglePause()}
                >
                  继续游戏 <kbd>Esc</kbd>
                </button>
                <button className="secondary" type="button" onClick={restart}>重新开始本关</button>
              </div>
            </div>
          </div>
        )}

        {showResult && !loading && (
          <div className={`overlay ${phase}`}>
            <div className="overlay-card">
              <span className={`result ${phase}`}>{phase === "won" ? "成功逃脱" : phase === "lost" ? "被抓住了" : `${campaignLevel.campaign.themeLabel}篇 · ${campaignLevel.campaign.difficultyLabel}`}</span>
              <h2>{phase === "won" ? `你完成了「${campaignLevel.campaign.name}」` : phase === "lost" ? captureFeedback.title : campaignLevel.campaign.subtitle}</h2>
              <p>
                {phase === "ready"
                  ? readyBriefing
                  : phase === "lost"
                    ? captureFeedback.explanation
                    : "追捕者只会依据真实目击、声音与最后位置追踪。你成功利用遮挡和藏身点完成了逃脱。"}
              </p>
              {phase === "won" && lastRunSummary && (
                <>
                  <div className="run-summary" aria-label="本局成绩">
                    <span>
                      <small>本次用时</small>
                      <strong>{lastRunSummary.completedSeconds.toFixed(2)}s</strong>
                    </span>
                    <span>
                      <small>个人最佳</small>
                      <strong>
                        {lastRunSummary.deltaSeconds === null
                          ? "首次记录"
                          : lastRunSummary.deltaSeconds === 0
                            ? "追平最佳"
                            : lastRunSummary.isPersonalBest
                              ? `快 ${Math.abs(lastRunSummary.deltaSeconds).toFixed(2)}s`
                              : `慢 ${lastRunSummary.deltaSeconds.toFixed(2)}s`}
                      </strong>
                    </span>
                    <span className={`mastery-rank rank-${lastRunSummary.rank}`}>
                      <small>本局评价</small>
                      <strong>{MASTERY_RANK_LABEL[lastRunSummary.rank]}</strong>
                    </span>
                  </div>
                  <div className="mastery-challenges" aria-label="本局精通目标">
                    {lastRunSummary.challenges.map((challenge) => (
                      <span
                        className={challenge.completed ? "completed" : ""}
                        key={challenge.id}
                        title={challenge.description}
                      >
                        <i aria-hidden="true">{challenge.completed ? "✓" : "○"}</i>
                        <b>{challenge.label}</b>
                        <small>{challenge.description}</small>
                      </span>
                    ))}
                  </div>
                  <div className="ghost-save-note" role="status">
                    <small>
                      {lastRunSummary.ruleset === "assisted"
                        ? selectedRemixContract
                          ? `${layoutLabel}辅助成绩已写入该认证种子的独立记录；不会覆盖原版或标准个人幽灵。`
                          : "辅助模式成绩已写入独立进度；不会覆盖标准个人幽灵。"
                        : lastRunSummary.ghostSaveStatus === "saved-faster"
                          ? `新的${selectedRemixContract ? `${layoutLabel}专属` : ""}个人最佳幽灵已保存，下局将与你同场竞速。`
                          : lastRunSummary.ghostSaveStatus === "saved-first"
                            ? `首个${selectedRemixContract ? `${layoutLabel}专属` : "标准"}个人幽灵已保存。`
                            : lastRunSummary.ghostSaveStatus === "kept-faster"
                              ? `保留了更快的${selectedRemixContract ? `${layoutLabel}专属` : ""}个人最佳幽灵。`
                              : `${selectedRemixContract ? `${layoutLabel}标准` : "标准"}成绩已记录。`}
                    </small>
                  </div>
                </>
              )}
              {phase === "lost" && (
                <div className="failure-advice"><small>下一次这样做</small><strong>{captureFeedback.hint}</strong></div>
              )}

              {phase === "ready" && (
                <div className="preference-settings" aria-label="游戏模式与辅助设置">
                  <div className="preference-group">
                    <small>规则模式</small>
                    <button
                      type="button"
                      aria-pressed={preferences.ruleset === "standard"}
                      onClick={() => updatePreferences({ ruleset: "standard" })}
                    >
                      标准 · 排名
                    </button>
                    <button
                      type="button"
                      aria-pressed={preferences.ruleset === "assisted"}
                      onClick={() => updatePreferences({ ruleset: "assisted" })}
                    >
                      辅助 · 独立进度
                    </button>
                  </div>
                  <div className="preference-group compact" aria-label="选择固定认证布局">
                    <small>关卡布局 · 固定认证（非随机）</small>
                    <button
                      type="button"
                      aria-pressed={selectedRemixVariant === null}
                      onClick={() => chooseRemixVariant(null)}
                    >
                      原版
                    </button>
                    {remixContracts.map((contract) => (
                      <button
                        type="button"
                        key={contract.id}
                        aria-pressed={selectedRemixVariant === contract.variantIndex}
                        onClick={() => chooseRemixVariant(contract.variantIndex)}
                      >
                        布局 {(contract.variantIndex + 1).toString().padStart(2, "0")}
                      </button>
                    ))}
                  </div>
                  <div className="preference-group compact">
                    <button
                      type="button"
                      aria-pressed={preferences.personalGhostEnabled}
                      onClick={() => updatePreferences({
                        personalGhostEnabled: !preferences.personalGhostEnabled,
                      })}
                    >
                      个人幽灵
                    </button>
                    <button
                      type="button"
                      aria-pressed={preferences.hudDensity === "full"}
                      onClick={() => updatePreferences({
                        hudDensity: preferences.hudDensity === "full" ? "cinematic" : "full",
                      })}
                    >
                      {preferences.hudDensity === "full" ? "完整 HUD" : "电影 HUD"}
                    </button>
                    <button
                      type="button"
                      aria-pressed={preferences.highContrast}
                      onClick={() => updatePreferences({ highContrast: !preferences.highContrast })}
                    >
                      高对比
                    </button>
                    <button
                      type="button"
                      aria-pressed={preferences.reducedMotion}
                      onClick={() => updatePreferences({ reducedMotion: !preferences.reducedMotion })}
                    >
                      减少动态
                    </button>
                  </div>
                  <p>
                    {(preferences.ruleset === "standard"
                      ? "标准规则记录排行榜资格与个人最佳幽灵。"
                      : "辅助规则降低追捕压力、扩大互动范围，并使用独立进度，不覆盖标准成绩。")
                    + (selectedRemixContract
                      ? ` ${layoutLabel}使用固定种子，成绩与幽灵均按布局、规则模式和任务版本独立保存。`
                      : "")}
                  </p>
                </div>
              )}

              {phase === "ready" && (
                <div className="mission-briefing" aria-label="本关主题任务">
                  <div>
                    <small>本关任务链 · {layoutLabel}</small>
                    <strong>{displayedMissionTitle}</strong>
                  </div>
                  {libraryGoldEnabled && (
                    <div className="library-plan-selector" role="group" aria-label="选择图书楼脱身计划">
                      {LIBRARY_BRANCHING_MISSION.plans.map((plan) => (
                        <button
                          type="button"
                          key={plan.id}
                          aria-pressed={selectedLibraryPlan === plan.id}
                          onClick={() => chooseLibraryPlan(plan.id)}
                        >
                          <b>{plan.label}</b>
                          <small>{plan.strategy}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedRemixContract && (
                    <span>
                      <i aria-hidden="true">↻</i>
                      <b>认证重编挑战</b>
                      <small>通路、巡逻、任务锚点与藏点供应均已重编；布局编号固定，可重复练习。</small>
                    </span>
                  )}
                  {displayedMissionObjectives.map((objective, index) => (
                    <span key={objective.id}>
                      <i aria-hidden="true">{index + 1}</i>
                      <b>{objective.label}</b>
                      <small>{objective.interactionPrompt}</small>
                    </span>
                  ))}
                </div>
              )}

              {phase === "ready" && (
                <div className="hide-loop" aria-label="躲柜玩法流程">
                  <span><b>1</b>绕墙切断视线</span>
                  <span><b>2</b>按风险选择硬柜、软遮挡或穿行藏点</span>
                  <span>
                    <b>3</b>
                    {libraryGoldEnabled
                      ? "按 F 投掷精装笔记本诱饵，趁调查与左右巡视时改线"
                      : "利用本关主题机关制造公开线索，趁追捕者调查时改线"}
                  </span>
                  <span>
                    <b>4</b>
                    1–3 选战术工具，G 部署门楔、转角镜或局部断电；C 抹除近处足迹
                  </span>
                </div>
              )}

              {phase === "ready" && (
                <div className="mastery-preview" aria-label="本关精通目标">
                  <div>
                    <small>{preferences.ruleset === "standard" ? "STANDARD · 排名精通" : "ASSISTED · 独立精通"}</small>
                    <strong>目标时间 {masteryPreview.targetSeconds.toFixed(1)}s</strong>
                  </div>
                  {masteryPreview.objectives.map((objective) => (
                    <span key={objective.id} title={objective.description}>
                      <i aria-hidden="true">◇</i>
                      <b>{objective.label}</b>
                      <small>{objective.description}</small>
                    </span>
                  ))}
                </div>
              )}

              {phase === "ready" && (
                <div className="level-grid" aria-label="选择关卡">
                  {CAMPAIGN_LEVELS.map((level, index) => {
                    const locked = index + 1 > unlockedThrough;
                    const active = index === selectedLevelIndex;
                    const levelRecordId = level.id === LIBRARY_BRANCHING_MISSION.levelId
                      ? libraryG2RunIdentity(level.id, selectedLibraryPlan)
                      : level.id;
                    const branchRunRecord = getCampaignRunRecord(
                      campaignProgress,
                      levelRecordId,
                      preferences.ruleset,
                    );
                    const legacyRunRecord = level.id === LIBRARY_BRANCHING_MISSION.levelId
                      ? getCampaignRunRecord(
                          campaignProgress,
                          level.id,
                          preferences.ruleset,
                        )
                      : null;
                    const showingLegacyBaseline = Boolean(
                      legacyRunRecord?.bestSeconds
                      && !branchRunRecord.bestSeconds
                      && !branchRunRecord.mastery,
                    );
                    const runRecord = showingLegacyBaseline && legacyRunRecord
                      ? legacyRunRecord
                      : branchRunRecord;
                    const best = runRecord.bestSeconds;
                    const mastery = runRecord.mastery;
                    return (
                      <button
                        className={`level-card${active ? " active" : ""}${locked ? " locked" : ""}${mastery ? ` rank-${mastery.rank}` : ""}`}
                        type="button"
                        key={level.id}
                        disabled={locked || loading}
                        onClick={() => chooseLevel(index)}
                        aria-current={active ? "step" : undefined}
                      >
                        <span>{level.campaign.levelNumber.toString().padStart(2, "0")}</span>
                        <strong>{locked ? "未解锁" : level.campaign.name}</strong>
                        <small>
                          {locked
                            ? "完成上一关"
                            : best
                              ? `最佳 ${best.toFixed(2)}s${mastery ? ` · ${MASTERY_RANK_LABEL[mastery.rank]}` : ""}${showingLegacyBaseline ? " · 旧版基线" : ""}`
                              : level.campaign.themeLabel}
                        </small>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="overlay-actions">
                <button className="primary" type="button" onClick={primaryAction}>
                  {phase === "ready"
                    ? `开始第 ${campaignLevel.campaign.levelNumber} 关 · ${layoutLabel}`
                    : phase === "won" && hasNextLevel ? "进入下一关" : "再来一次"}
                  <kbd>Enter</kbd>
                </button>
                {phase === "won" && <button className="secondary" type="button" onClick={begin}>重玩本关</button>}
                {libraryGoldEnabled && phase !== "ready" && (
                  <button
                    className="secondary library-plan-switch"
                    type="button"
                    onClick={switchLibraryPlanAfterRun}
                  >
                    改走{
                      LIBRARY_BRANCHING_MISSION.plans.find(
                        (plan) => plan.id !== selectedLibraryPlan,
                      )?.label
                    }
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="view-controls" aria-label="视野控制">
          <button type="button" onClick={() => commands.current.adjustZoom(1.12)} aria-label="缩小视野">−</button>
          <button type="button" onClick={() => commands.current.resetZoom()} aria-label="重置动态视野">视野</button>
          <button type="button" onClick={() => commands.current.adjustZoom(1 / 1.12)} aria-label="放大视野">＋</button>
        </div>

        {phase === "playing" && !paused && (
          <>
            <div
              className="controls virtual-stick"
              ref={joystickControl}
              role="group"
              aria-label="移动控制，拖动摇杆；也可使用方向键或 WASD"
              tabIndex={0}
              onPointerDown={joystickPointerDown}
              onPointerMove={joystickPointerMove}
              onPointerUp={joystickPointerEnd}
              onPointerCancel={joystickPointerEnd}
              onLostPointerCapture={resetAnalogueMove}
            >
              <div className="stick-ring" aria-hidden="true" ref={joystickBase}>
                <span className="stick-thumb" ref={joystickThumb}>
                  <i />
                </span>
              </div>
              <small>拖动移动</small>
            </div>
            <div className="action-controls">
              <button type="button" className={touchInteractAvailable ? "available" : ""} disabled={!touchInteractAvailable} onClick={interact}>
                {playerMode === "aligning-hide"
                  ? "取消躲藏"
                  : missionInteractionInProgress
                    ? `执行中 ${Math.max(0, themeMission?.commitmentRemainingSeconds ?? 0).toFixed(1)}s`
                  : missionCanInteract && activeMissionObjective
                    ? activeMissionObjective.label
                  : themeMechanic?.canActivate
                    && !stealthBlackoutActive
                    && !interaction
                    ? "启动机关"
                  : interaction?.kind === "enter"
                    ? `进入${hideArchetypeLabel}`
                    : interaction?.kind === "exit"
                      ? interactionText ?? `离开${hideArchetypeLabel}`
                      : `藏点 ${hideDistance}m`}
              </button>
              {libraryGoldEnabled && portableDecoy && (
                <button
                  type="button"
                  className={`decoy-action${portableDecoyActionAvailable ? " available" : ""}`}
                  disabled={!portableDecoyActionAvailable}
                  onClick={deployDecoy}
                >
                  诱饵 {portableDecoy.inventoryRemaining} · {portableDecoyPhaseLabel}
                </button>
              )}
              <button
                type="button"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  touch("q", true);
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                  touch("q", false);
                }}
                onPointerCancel={() => touch("q", false)}
                onLostPointerCapture={() => touch("q", false)}
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
        <span><i className="safe" />主题藏点</span>
        <small>
          {`WASD / 方向键移动 · E 躲藏或离开 · ${
            libraryGoldEnabled ? "F 投掷诱饵 · " : ""
          }1–3 选工具 / G 部署 · C 抹迹 · Q 轻步 / 柜内观察 · X 切换穿行出口 · 滚轮动态调视野 · Esc 暂停 · M 声音 · R 重开`}
        </small>
      </footer>
    </main>
  );
}
