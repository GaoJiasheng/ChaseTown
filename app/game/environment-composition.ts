import type {
  CampaignLevelDefinition,
  CampaignPaletteTokens,
  CampaignTheme,
} from "./campaign.ts";
import type { Point } from "./contracts.ts";
import { findPath, neighbors } from "./navigation.ts";
import type { MechanicPhase } from "./theme-mechanics.ts";
import type { RenderQualityTier } from "./quality.ts";

/**
 * Pure authoring and sampling layer for the environment presentation pass.
 *
 * The module intentionally owns no URLs, Three.js objects or React state. It
 * only references semantic nodes already present in the four production theme
 * kits, so adopting it cannot add a first-playable request or duplicate a GLB.
 */

export type EnvironmentPaletteToken = keyof CampaignPaletteTokens;
export type LandmarkBeatRole = "establish" | "pressure" | "payoff";
export type CompositionSurfaceRole = "wall" | "floor" | "trim" | "landmark";
export type ProceduralDecalPattern =
  | "wayfinding-band"
  | "threshold-dash"
  | "hazard-stripe"
  | "service-chevron";
export type EnvironmentParticleKind = "none" | "dust" | "steam" | "smoke" | "sparks";
export type MechanicFeedbackStage = "warning" | "active" | "recover";
export type MechanicPartMotionKind = "swing" | "slide-opposed" | "spin" | "vibrate";
export type CartesianAxis = "x" | "y" | "z";

export interface EnvironmentCompositionBudget {
  readonly tier: RenderQualityTier;
  /** Configuration is atlasless and only references the already active kit. */
  readonly additionalNetworkRequests: 0;
  readonly additionalNetworkBytes: 0;
  readonly additionalTextureFiles: 0;
  /** One lazily generated 64×64 RGBA marking shared by the active theme. */
  readonly maximumRuntimeTextureBytes: number;
  /** One batched edge skirt and one batched marking layer. */
  readonly maximumAdditionalDrawCalls: number;
  readonly maximumAdditionalTriangles: number;
  /** These lights never cast a shadow and must use the runtime light pool. */
  readonly maximumLocalLightPools: number;
  readonly maximumProceduralDecals: number;
  /** Particles reuse the existing atmosphere point buffer. */
  readonly maximumMechanicParticles: number;
  readonly maximumMaterialVariantsPerSurface: number;
}

export const ENVIRONMENT_COMPOSITION_BUDGETS: Readonly<
  Record<RenderQualityTier, EnvironmentCompositionBudget>
> = deepFreeze({
  high: {
    tier: "high",
    additionalNetworkRequests: 0,
    additionalNetworkBytes: 0,
    additionalTextureFiles: 0,
    maximumRuntimeTextureBytes: 64 * 64 * 4,
    maximumAdditionalDrawCalls: 2,
    maximumAdditionalTriangles: 256,
    maximumLocalLightPools: 2,
    maximumProceduralDecals: 24,
    maximumMechanicParticles: 48,
    maximumMaterialVariantsPerSurface: 3,
  },
  balanced: {
    tier: "balanced",
    additionalNetworkRequests: 0,
    additionalNetworkBytes: 0,
    additionalTextureFiles: 0,
    maximumRuntimeTextureBytes: 64 * 64 * 4,
    maximumAdditionalDrawCalls: 2,
    maximumAdditionalTriangles: 192,
    maximumLocalLightPools: 2,
    maximumProceduralDecals: 16,
    maximumMechanicParticles: 32,
    maximumMaterialVariantsPerSurface: 3,
  },
  mobile: {
    tier: "mobile",
    additionalNetworkRequests: 0,
    additionalNetworkBytes: 0,
    additionalTextureFiles: 0,
    maximumRuntimeTextureBytes: 64 * 64 * 4,
    maximumAdditionalDrawCalls: 2,
    maximumAdditionalTriangles: 128,
    maximumLocalLightPools: 1,
    maximumProceduralDecals: 8,
    maximumMechanicParticles: 18,
    maximumMaterialVariantsPerSurface: 3,
  },
});

export interface ArchitectureNodeContract {
  readonly wallVariants: readonly string[];
  readonly wallEnd: readonly string[];
  readonly corner: readonly string[];
  readonly floorPrimary: readonly string[];
  readonly floorSecondary: readonly string[];
  readonly floorService: readonly string[];
  readonly exteriorGround: readonly string[];
}

export interface LocalLightPoolStyle {
  readonly id: string;
  readonly colorToken: EnvironmentPaletteToken;
  readonly intensity: number;
  readonly rangeMeters: number;
  readonly heightMeters: number;
  readonly priority: 1 | 2 | 3;
  readonly castShadow: false;
}

export interface MaterialVariationSpec {
  /** Stable cache key: placements select from this finite set only. */
  readonly id: string;
  readonly tintToken: EnvironmentPaletteToken;
  readonly colorMix: number;
  readonly roughnessDelta: number;
  readonly metalnessDelta: number;
  readonly sharedMaterialSlot: 0 | 1 | 2;
}

export interface ProceduralDecalProgram {
  readonly id: string;
  readonly pattern: ProceduralDecalPattern;
  readonly foregroundToken: EnvironmentPaletteToken;
  readonly secondaryToken: EnvironmentPaletteToken;
  readonly opacity: number;
  readonly repeatCount: number;
  readonly strokeFraction: number;
  readonly maximumInstances: number;
  readonly batchKey: "environment-composition-markings";
  readonly generatedResolution: 64;
}

export interface MaterialVariationLanguage {
  readonly wall: readonly MaterialVariationSpec[];
  readonly floor: readonly MaterialVariationSpec[];
  readonly trim: readonly MaterialVariationSpec[];
  readonly landmark: readonly MaterialVariationSpec[];
  readonly decal: ProceduralDecalProgram;
}

export interface SceneEdgeClosureStyle {
  readonly capNodeCandidates: readonly string[];
  readonly wallEndNodeCandidates: readonly string[];
  readonly cornerNodeCandidates: readonly string[];
  /** Visible authored ground ends close to the maze instead of filling frame. */
  readonly groundMarginCells: number;
  readonly skirtDepthMeters: number;
  readonly fogColorToken: EnvironmentPaletteToken;
  readonly fogOpacity: number;
  readonly geometryMode: "single-batched-skirt";
  readonly castShadow: false;
  readonly receiveShadow: false;
}

export interface MechanicPartMotion {
  readonly kind: MechanicPartMotionKind;
  readonly axis: CartesianAxis;
  readonly targetNodeCandidates: readonly string[];
}

export interface MechanicFeedbackStageSpec {
  readonly stage: MechanicFeedbackStage;
  readonly colorToken: EnvironmentPaletteToken;
  readonly pulseCycles: number;
  readonly peakEmissiveIntensity: number;
  readonly peakLightIntensity: number;
  readonly lightRangeMeters: number;
  readonly rootScaleAmplitude: number;
  /**
   * Radians for swing/spin; metres for slide/vibrate. The sampled amount is
   * signed and returns to zero at every phase boundary.
   */
  readonly partMotionAmplitude: number;
  readonly particleKind: EnvironmentParticleKind;
  readonly maximumParticles: number;
  readonly effectOpacity: number;
}

export interface MechanicWorldFeedbackProfile {
  readonly sourceNodeCandidates: readonly string[];
  readonly partMotion: MechanicPartMotion;
  readonly stages: Readonly<Record<MechanicFeedbackStage, MechanicFeedbackStageSpec>>;
  /** Reuse a composition light instead of creating an unbudgeted point light. */
  readonly usesPooledLocalLight: true;
  /** Feed the current atmosphere points rather than allocate another system. */
  readonly usesAtmosphereParticleBuffer: true;
}

export interface ThemeEnvironmentComposition {
  readonly theme: CampaignTheme;
  readonly architecture: ArchitectureNodeContract;
  /** Three authored pools exist; runtime activates at most the tier budget. */
  readonly lightPools: readonly [
    LocalLightPoolStyle,
    LocalLightPoolStyle,
    LocalLightPoolStyle,
  ];
  readonly materialVariation: MaterialVariationLanguage;
  readonly edgeClosure: SceneEdgeClosureStyle;
  readonly mechanicFeedback: MechanicWorldFeedbackProfile;
}

export interface LandmarkSegmentSpec {
  readonly id: string;
  readonly role: LandmarkBeatRole;
  readonly nodeCandidates: readonly string[];
  /** Intended point on the critical route, before junction-aware adjustment. */
  readonly routeFraction: number;
  /** Which side of the route an authored-room placement should prefer. */
  readonly lateralBias: -1 | 1;
}

export interface LevelEnvironmentCompositionProfile {
  readonly levelId: string;
  readonly propSet: string;
  readonly theme: CampaignTheme;
  readonly materialSalt: number;
  readonly landmarkSegments: readonly [
    LandmarkSegmentSpec,
    LandmarkSegmentSpec,
    LandmarkSegmentSpec,
  ];
  readonly arrivalNodeCandidates: readonly string[];
  readonly hideDressingNodeCandidates: readonly string[];
  readonly exitNodeCandidates: readonly string[];
  /**
   * Landmark roots are visual focus anchors. They remain outside navigation
   * and use the runtime's supported authored-room placement path.
   */
  readonly placementPolicy: "nearest-authored-room-anchor";
}

export interface LandmarkBeatPlan extends LandmarkSegmentSpec {
  readonly label: string;
  readonly routeIndex: number;
  readonly resolvedRouteFraction: number;
  readonly focusCell: Point;
  readonly routeTangent: Point;
  readonly junctionDegree: number;
  readonly decisionStrength: number;
}

export interface LocalLightPoolPlan extends LocalLightPoolStyle {
  readonly segmentId: string;
  readonly position: Point;
  readonly color: string;
}

export type SceneEdgeSide = "north" | "east" | "south" | "west";

export interface SceneEdgeClosureSegment {
  readonly side: SceneEdgeSide;
  readonly center: Point;
  readonly outward: Point;
  readonly lengthCells: number;
}

export interface SceneEdgeClosurePlan extends SceneEdgeClosureStyle {
  readonly segments: readonly SceneEdgeClosureSegment[];
  readonly fogColor: string;
  readonly proceduralTriangles: 8;
  readonly additionalDrawCalls: 1;
}

export interface EnvironmentCompositionPlan {
  readonly profile: LevelEnvironmentCompositionProfile;
  readonly theme: ThemeEnvironmentComposition;
  readonly budget: EnvironmentCompositionBudget;
  readonly criticalRoute: readonly Point[];
  readonly landmarkBeats: readonly LandmarkBeatPlan[];
  readonly activeLightPools: readonly LocalLightPoolPlan[];
  readonly edgeClosure: SceneEdgeClosurePlan;
  readonly materialVariation: MaterialVariationLanguage;
  readonly decalInstanceLimit: number;
}

export interface EnvironmentCompositionPlanOptions {
  readonly qualityTier?: RenderQualityTier;
  readonly playerPosition?: Point;
  /**
   * Pass only the slots left after characters and gameplay-critical lights.
   * The module never assumes it owns the renderer's complete light budget.
   */
  readonly availableDynamicLightSlots?: number;
}

export interface ProceduralDecalPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly byteLength: number;
  readonly networkBytes: 0;
  readonly colorSpace: "srgb";
}

export interface MechanicWorldFeedbackInput {
  readonly phase: MechanicPhase;
  readonly progress: number;
  readonly qualityTier?: RenderQualityTier;
  readonly reducedMotion?: boolean;
}

export interface MechanicWorldFeedbackSample {
  readonly stage: MechanicFeedbackStage | null;
  readonly stageProgress: number;
  readonly envelope: number;
  readonly colorToken: EnvironmentPaletteToken;
  readonly emissiveIntensity: number;
  readonly lightIntensity: number;
  readonly lightRangeMeters: number;
  readonly scaleMultiplier: number;
  readonly partMotionKind: MechanicPartMotionKind;
  readonly partMotionAxis: CartesianAxis;
  readonly partMotionAmount: number;
  readonly targetNodeCandidates: readonly string[];
  readonly sourceNodeCandidates: readonly string[];
  readonly particleKind: EnvironmentParticleKind;
  readonly particleCount: number;
  readonly effectOpacity: number;
  readonly usesPooledLocalLight: true;
  readonly usesAtmosphereParticleBuffer: true;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

const variation = (
  id: string,
  tintToken: EnvironmentPaletteToken,
  colorMix: number,
  roughnessDelta: number,
  metalnessDelta: number,
  sharedMaterialSlot: 0 | 1 | 2,
): MaterialVariationSpec => ({
  id,
  tintToken,
  colorMix,
  roughnessDelta,
  metalnessDelta,
  sharedMaterialSlot,
});

const stage = (
  selectedStage: MechanicFeedbackStage,
  colorToken: EnvironmentPaletteToken,
  pulseCycles: number,
  peakEmissiveIntensity: number,
  peakLightIntensity: number,
  lightRangeMeters: number,
  rootScaleAmplitude: number,
  partMotionAmplitude: number,
  particleKind: EnvironmentParticleKind,
  maximumParticles: number,
  effectOpacity: number,
): MechanicFeedbackStageSpec => ({
  stage: selectedStage,
  colorToken,
  pulseCycles,
  peakEmissiveIntensity,
  peakLightIntensity,
  lightRangeMeters,
  rootScaleAmplitude,
  partMotionAmplitude,
  particleKind,
  maximumParticles,
  effectOpacity,
});

export const THEME_ENVIRONMENT_COMPOSITIONS: Readonly<
  Record<CampaignTheme, ThemeEnvironmentComposition>
> = deepFreeze({
  campus: {
    theme: "campus",
    architecture: {
      wallVariants: [
        "CampusArchitectureWallA",
        "CampusArchitectureWallB",
        "CampusArchitectureWallC",
      ],
      wallEnd: ["CampusArchitectureWallEnd"],
      corner: ["CampusArchitectureCorner"],
      floorPrimary: ["CampusFloorPrimary"],
      floorSecondary: ["CampusFloorSecondary"],
      floorService: ["CampusFloorService"],
      exteriorGround: ["CampusExteriorGround"],
    },
    lightPools: [
      {
        id: "campus-window-warmth",
        colorToken: "accent",
        intensity: 1.7,
        rangeMeters: 5.2,
        heightMeters: 2.55,
        priority: 3,
        castShadow: false,
      },
      {
        id: "campus-study-pool",
        colorToken: "emissive",
        intensity: 1.35,
        rangeMeters: 4.4,
        heightMeters: 2.35,
        priority: 2,
        castShadow: false,
      },
      {
        id: "campus-exit-warmth",
        colorToken: "trim",
        intensity: 1.85,
        rangeMeters: 5.4,
        heightMeters: 2.6,
        priority: 3,
        castShadow: false,
      },
    ],
    materialVariation: {
      wall: [
        variation("campus-wall-clean", "wall", 0.015, 0.02, 0, 0),
        variation("campus-wall-handled", "trim", 0.055, 0.09, 0, 1),
        variation("campus-wall-aged", "accent", 0.035, 0.14, -0.01, 2),
      ],
      floor: [
        variation("campus-floor-dry", "floor", 0.01, 0.02, 0, 0),
        variation("campus-floor-worn", "trim", 0.045, 0.11, 0, 1),
        variation("campus-floor-window", "accent", 0.035, -0.04, 0, 2),
      ],
      trim: [
        variation("campus-trim-base", "trim", 0.02, 0.03, 0, 0),
        variation("campus-trim-handled", "accent", 0.07, 0.1, -0.02, 1),
      ],
      landmark: [
        variation("campus-hero-neutral", "wall", 0.015, 0, 0, 0),
        variation("campus-hero-warm", "accent", 0.08, -0.05, 0, 1),
      ],
      decal: {
        id: "campus-wayfinding-band",
        pattern: "wayfinding-band",
        foregroundToken: "accent",
        secondaryToken: "trim",
        opacity: 0.66,
        repeatCount: 4,
        strokeFraction: 0.1,
        maximumInstances: 24,
        batchKey: "environment-composition-markings",
        generatedResolution: 64,
      },
    },
    edgeClosure: {
      capNodeCandidates: ["CampusExteriorGround"],
      wallEndNodeCandidates: ["CampusArchitectureWallEnd"],
      cornerNodeCandidates: ["CampusArchitectureCorner"],
      groundMarginCells: 1.25,
      skirtDepthMeters: 3.1,
      fogColorToken: "fog",
      fogOpacity: 0.9,
      geometryMode: "single-batched-skirt",
      castShadow: false,
      receiveShadow: false,
    },
    mechanicFeedback: {
      sourceNodeCandidates: ["CampusWayfinding"],
      partMotion: {
        kind: "swing",
        axis: "y",
        targetNodeCandidates: ["CampusLetters", "CampusSignFace", "CampusSignFrame"],
      },
      stages: {
        warning: stage("warning", "accent", 2, 0.92, 2.1, 5.2, 0.014, 0.045, "dust", 16, 0.18),
        active: stage("active", "accent", 4, 0.92, 2.1, 5.2, 0.014, 0.045, "dust", 16, 0.18),
        recover: stage("recover", "accent", 1, 0.92, 2.1, 5.2, 0.014, 0.045, "dust", 16, 0.18),
      },
      usesPooledLocalLight: true,
      usesAtmosphereParticleBuffer: true,
    },
  },
  hospital: {
    theme: "hospital",
    architecture: {
      wallVariants: [
        "HospitalArchitectureWallA",
        "HospitalArchitectureWallB",
        "HospitalArchitectureWallC",
      ],
      wallEnd: ["HospitalArchitectureWallEnd"],
      corner: ["HospitalArchitectureCorner"],
      floorPrimary: ["HospitalFloorPrimary"],
      floorSecondary: ["HospitalFloorSecondary"],
      floorService: ["HospitalFloorService"],
      exteriorGround: ["HospitalExteriorGround"],
    },
    lightPools: [
      {
        id: "hospital-triage-cool",
        colorToken: "emissive",
        intensity: 1.55,
        rangeMeters: 4.8,
        heightMeters: 2.45,
        priority: 3,
        castShadow: false,
      },
      {
        id: "hospital-emergency-green",
        colorToken: "accent",
        intensity: 1.3,
        rangeMeters: 4.1,
        heightMeters: 2.3,
        priority: 2,
        castShadow: false,
      },
      {
        id: "hospital-exit-panel",
        colorToken: "trim",
        intensity: 1.7,
        rangeMeters: 4.9,
        heightMeters: 2.5,
        priority: 3,
        castShadow: false,
      },
    ],
    materialVariation: {
      wall: [
        variation("hospital-wall-clean", "wall", 0.01, -0.02, 0, 0),
        variation("hospital-wall-sanitized", "emissive", 0.035, -0.08, 0, 1),
        variation("hospital-wall-service", "trim", 0.055, 0.1, 0.01, 2),
      ],
      floor: [
        variation("hospital-floor-dry", "floor", 0.01, -0.02, 0, 0),
        variation("hospital-floor-cleaned", "emissive", 0.04, -0.13, 0, 1),
        variation("hospital-floor-service", "trim", 0.045, 0.08, 0.01, 2),
      ],
      trim: [
        variation("hospital-trim-base", "trim", 0.015, -0.02, 0.02, 0),
        variation("hospital-trim-emergency", "accent", 0.075, 0.04, 0, 1),
      ],
      landmark: [
        variation("hospital-hero-clinical", "wall", 0.01, -0.04, 0, 0),
        variation("hospital-hero-emergency", "emissive", 0.07, -0.08, 0, 1),
      ],
      decal: {
        id: "hospital-threshold-dash",
        pattern: "threshold-dash",
        foregroundToken: "accent",
        secondaryToken: "emissive",
        opacity: 0.62,
        repeatCount: 6,
        strokeFraction: 0.09,
        maximumInstances: 20,
        batchKey: "environment-composition-markings",
        generatedResolution: 64,
      },
    },
    edgeClosure: {
      capNodeCandidates: ["HospitalExteriorGround"],
      wallEndNodeCandidates: ["HospitalArchitectureWallEnd"],
      cornerNodeCandidates: ["HospitalArchitectureCorner"],
      groundMarginCells: 1.1,
      skirtDepthMeters: 3.4,
      fogColorToken: "fog",
      fogOpacity: 0.94,
      geometryMode: "single-batched-skirt",
      castShadow: false,
      receiveShadow: false,
    },
    mechanicFeedback: {
      sourceNodeCandidates: [
        "HospitalArchitectureDoorway",
        "HospitalPrivacyScreen",
        "HospitalWayfinding",
      ],
      partMotion: {
        kind: "slide-opposed",
        axis: "x",
        targetNodeCandidates: [
          "SlidingDoor_-0.4",
          "SlidingDoor_0.4",
          "ScreenPanel_-1",
          "ScreenPanel_0",
          "ScreenPanel_1",
        ],
      },
      stages: {
        warning: stage("warning", "emissive", 2, 1.02, 1.85, 4.7, 0.01, 0.4, "steam", 14, 0.22),
        active: stage("active", "emissive", 3, 1.02, 1.85, 4.7, 0.01, 0.4, "steam", 14, 0.22),
        recover: stage("recover", "emissive", 1, 1.02, 1.85, 4.7, 0.01, 0.4, "steam", 14, 0.22),
      },
      usesPooledLocalLight: true,
      usesAtmosphereParticleBuffer: true,
    },
  },
  "fire-station": {
    theme: "fire-station",
    architecture: {
      wallVariants: [
        "FireStationArchitectureWallA",
        "FireStationArchitectureWallB",
        "FireStationArchitectureWallC",
      ],
      wallEnd: ["FireStationArchitectureWallEnd"],
      corner: ["FireStationArchitectureCorner"],
      floorPrimary: ["FireStationFloorPrimary"],
      floorSecondary: ["FireStationFloorSecondary"],
      floorService: ["FireStationFloorService"],
      exteriorGround: ["FireStationExteriorGround"],
    },
    lightPools: [
      {
        id: "fire-engine-amber",
        colorToken: "accent",
        intensity: 2.05,
        rangeMeters: 5.7,
        heightMeters: 2.65,
        priority: 3,
        castShadow: false,
      },
      {
        id: "fire-smoke-red",
        colorToken: "emissive",
        intensity: 1.7,
        rangeMeters: 4.8,
        heightMeters: 2.35,
        priority: 2,
        castShadow: false,
      },
      {
        id: "fire-exit-amber",
        colorToken: "trim",
        intensity: 2.2,
        rangeMeters: 5.9,
        heightMeters: 2.65,
        priority: 3,
        castShadow: false,
      },
    ],
    materialVariation: {
      wall: [
        variation("fire-wall-sealed", "wall", 0.015, 0.04, 0.01, 0),
        variation("fire-wall-soot", "fog", 0.075, 0.16, -0.02, 1),
        variation("fire-wall-beacon", "accent", 0.055, 0.08, 0, 2),
      ],
      floor: [
        variation("fire-floor-clean", "floor", 0.01, 0.02, 0.01, 0),
        variation("fire-floor-wet", "trim", 0.05, -0.15, 0.04, 1),
        variation("fire-floor-soot", "fog", 0.08, 0.14, -0.02, 2),
      ],
      trim: [
        variation("fire-trim-base", "trim", 0.02, 0.02, 0.04, 0),
        variation("fire-trim-warning", "accent", 0.09, 0.07, 0, 1),
      ],
      landmark: [
        variation("fire-hero-neutral", "wall", 0.015, 0.02, 0.02, 0),
        variation("fire-hero-beacon", "accent", 0.095, -0.04, 0.01, 1),
      ],
      decal: {
        id: "fire-hazard-stripe",
        pattern: "hazard-stripe",
        foregroundToken: "accent",
        secondaryToken: "fog",
        opacity: 0.72,
        repeatCount: 5,
        strokeFraction: 0.12,
        maximumInstances: 24,
        batchKey: "environment-composition-markings",
        generatedResolution: 64,
      },
    },
    edgeClosure: {
      capNodeCandidates: ["FireStationExteriorGround"],
      wallEndNodeCandidates: ["FireStationArchitectureWallEnd"],
      cornerNodeCandidates: ["FireStationArchitectureCorner"],
      groundMarginCells: 1.35,
      skirtDepthMeters: 3.6,
      fogColorToken: "fog",
      fogOpacity: 0.93,
      geometryMode: "single-batched-skirt",
      castShadow: false,
      receiveShadow: false,
    },
    mechanicFeedback: {
      sourceNodeCandidates: ["FireHoseReel"],
      partMotion: {
        kind: "spin",
        axis: "z",
        targetNodeCandidates: [
          "ReelHub",
          "HoseCoil_0.23",
          "HoseCoil_0.31",
          "HoseCoil_0.39",
          "HoseCoil_0.47",
        ],
      },
      stages: {
        warning: stage("warning", "accent", 3, 1.38, 2.75, 6.1, 0.018, 0.3, "smoke", 48, 0.42),
        active: stage("active", "accent", 5, 1.38, 2.75, 6.1, 0.018, 0.3, "smoke", 48, 0.42),
        recover: stage("recover", "accent", 1, 1.38, 2.75, 6.1, 0.018, 0.3, "smoke", 48, 0.42),
      },
      usesPooledLocalLight: true,
      usesAtmosphereParticleBuffer: true,
    },
  },
  factory: {
    theme: "factory",
    architecture: {
      wallVariants: [
        "FactoryArchitectureWallA",
        "FactoryArchitectureWallB",
        "FactoryArchitectureWallC",
      ],
      wallEnd: ["FactoryArchitectureWallEnd"],
      corner: ["FactoryArchitectureCorner"],
      floorPrimary: ["FactoryFloorPrimary"],
      floorSecondary: ["FactoryFloorSecondary"],
      floorService: ["FactoryFloorService"],
      exteriorGround: ["FactoryExteriorGround"],
    },
    lightPools: [
      {
        id: "factory-inspection-cyan",
        colorToken: "emissive",
        intensity: 1.8,
        rangeMeters: 5.2,
        heightMeters: 2.55,
        priority: 3,
        castShadow: false,
      },
      {
        id: "factory-service-orange",
        colorToken: "accent",
        intensity: 1.65,
        rangeMeters: 4.7,
        heightMeters: 2.35,
        priority: 2,
        castShadow: false,
      },
      {
        id: "factory-exit-cyan",
        colorToken: "trim",
        intensity: 2.05,
        rangeMeters: 5.6,
        heightMeters: 2.6,
        priority: 3,
        castShadow: false,
      },
    ],
    materialVariation: {
      wall: [
        variation("factory-wall-painted", "wall", 0.015, 0.05, 0.02, 0),
        variation("factory-wall-oily", "trim", 0.055, -0.1, 0.05, 1),
        variation("factory-wall-heat", "accent", 0.065, 0.12, -0.01, 2),
      ],
      floor: [
        variation("factory-floor-dry", "floor", 0.01, 0.04, 0.03, 0),
        variation("factory-floor-oily", "trim", 0.06, -0.17, 0.08, 1),
        variation("factory-floor-heat", "accent", 0.055, 0.1, 0, 2),
      ],
      trim: [
        variation("factory-trim-base", "trim", 0.02, 0.03, 0.06, 0),
        variation("factory-trim-service", "accent", 0.09, 0.08, 0.01, 1),
      ],
      landmark: [
        variation("factory-hero-neutral", "wall", 0.015, 0.02, 0.03, 0),
        variation("factory-hero-powered", "emissive", 0.085, -0.07, 0.02, 1),
      ],
      decal: {
        id: "factory-service-chevron",
        pattern: "service-chevron",
        foregroundToken: "accent",
        secondaryToken: "emissive",
        opacity: 0.7,
        repeatCount: 4,
        strokeFraction: 0.1,
        maximumInstances: 24,
        batchKey: "environment-composition-markings",
        generatedResolution: 64,
      },
    },
    edgeClosure: {
      capNodeCandidates: ["FactoryExteriorGround"],
      wallEndNodeCandidates: ["FactoryArchitectureWallEnd"],
      cornerNodeCandidates: ["FactoryArchitectureCorner"],
      groundMarginCells: 1.35,
      skirtDepthMeters: 3.8,
      fogColorToken: "fog",
      fogOpacity: 0.95,
      geometryMode: "single-batched-skirt",
      castShadow: false,
      receiveShadow: false,
    },
    mechanicFeedback: {
      sourceNodeCandidates: ["FactoryControlConsole"],
      partMotion: {
        kind: "vibrate",
        axis: "x",
        targetNodeCandidates: [
          "ConsoleScreen_-1",
          "ConsoleScreen_0",
          "ConsoleScreen_1",
          "ConsoleEmergencyButton",
        ],
      },
      stages: {
        warning: stage("warning", "emissive", 2, 1.24, 2.45, 5.5, 0.012, 0.017, "sparks", 32, 0.28),
        active: stage("active", "emissive", 6, 1.24, 2.45, 5.5, 0.012, 0.017, "sparks", 32, 0.28),
        recover: stage("recover", "emissive", 1, 1.24, 2.45, 5.5, 0.012, 0.017, "sparks", 32, 0.28),
      },
      usesPooledLocalLight: true,
      usesAtmosphereParticleBuffer: true,
    },
  },
});

interface LevelProfileSource {
  readonly levelId: string;
  readonly propSet: string;
  readonly theme: CampaignTheme;
  readonly materialSalt: number;
  readonly landmarkNodes: readonly [string, string, string];
  readonly routeFractions: readonly [number, number, number];
  readonly arrivalNode: string;
  readonly hideDressingNode: string;
  readonly exitNode: string;
}

function defineLevelProfile(source: LevelProfileSource): LevelEnvironmentCompositionProfile {
  const roles: readonly LandmarkBeatRole[] = ["establish", "pressure", "payoff"];
  const landmarkSegments = source.landmarkNodes.map((node, index) => ({
    id: `${source.propSet}-${roles[index]}`,
    role: roles[index],
    nodeCandidates: [node],
    routeFraction: source.routeFractions[index],
    lateralBias: (index % 2 === 0 ? -1 : 1) as -1 | 1,
  })) as unknown as LevelEnvironmentCompositionProfile["landmarkSegments"];
  return deepFreeze({
    levelId: source.levelId,
    propSet: source.propSet,
    theme: source.theme,
    materialSalt: source.materialSalt,
    landmarkSegments,
    arrivalNodeCandidates: [source.arrivalNode],
    hideDressingNodeCandidates: [source.hideDressingNode],
    exitNodeCandidates: [source.exitNode],
    placementPolicy: "nearest-authored-room-anchor",
  });
}

const LEVEL_PROFILE_SOURCES: readonly LevelProfileSource[] = [
  {
    levelId: "school-maze-v1",
    propSet: "campus-classic",
    theme: "campus",
    materialSalt: 11,
    landmarkNodes: ["CampusClassroomCluster", "CampusCourtyardCluster", "CampusClassicLandmark"],
    routeFractions: [0.18, 0.5, 0.8],
    arrivalNode: "CampusClassicArrivalCluster",
    hideDressingNode: "CampusClassicHideDressing",
    exitNode: "CampusGateDressing",
  },
  {
    levelId: "campus-library-lockdown",
    propSet: "campus-library",
    theme: "campus",
    materialSalt: 23,
    landmarkNodes: ["CampusLibraryShelves", "CampusReadingCluster", "CampusArchiveCluster"],
    routeFractions: [0.2, 0.53, 0.82],
    arrivalNode: "CampusLibraryArrivalCluster",
    hideDressingNode: "CampusLibraryHideDressing",
    exitNode: "CampusLibraryExitCluster",
  },
  {
    levelId: "campus-science-wing",
    propSet: "campus-science",
    theme: "campus",
    materialSalt: 37,
    landmarkNodes: ["CampusLabBenchCluster", "CampusFumeHoodCluster", "CampusGreenhouseCluster"],
    routeFractions: [0.16, 0.48, 0.78],
    arrivalNode: "CampusScienceArrivalCluster",
    hideDressingNode: "CampusScienceHideDressing",
    exitNode: "CampusScienceExitCluster",
  },
  {
    levelId: "hospital-outpatient-afterhours",
    propSet: "hospital-outpatient",
    theme: "hospital",
    materialSalt: 41,
    landmarkNodes: ["HospitalTriageCluster", "HospitalWaitingCluster", "HospitalPharmacyCluster"],
    routeFractions: [0.17, 0.51, 0.81],
    arrivalNode: "HospitalOutpatientArrivalCluster",
    hideDressingNode: "HospitalOutpatientHideDressing",
    exitNode: "HospitalOutpatientExitCluster",
  },
  {
    levelId: "hospital-isolation-basement",
    propSet: "hospital-isolation",
    theme: "hospital",
    materialSalt: 53,
    landmarkNodes: ["HospitalDeconCluster", "HospitalIsolationWardCluster", "HospitalAirlockCluster"],
    routeFractions: [0.2, 0.55, 0.84],
    arrivalNode: "HospitalIsolationArrivalCluster",
    hideDressingNode: "HospitalIsolationHideDressing",
    exitNode: "HospitalIsolationExitCluster",
  },
  {
    levelId: "fire-station-engine-bay",
    propSet: "fire-engine-bay",
    theme: "fire-station",
    materialSalt: 67,
    landmarkNodes: [
      "FireStationEngineBayCluster",
      "FireStationTurnoutCluster",
      "FireStationHoseServiceCluster",
    ],
    routeFractions: [0.18, 0.47, 0.79],
    arrivalNode: "FireStationEngineBayArrivalCluster",
    hideDressingNode: "FireStationEngineBayHideDressing",
    exitNode: "FireStationEngineBayExitCluster",
  },
  {
    levelId: "fire-station-training-tower",
    propSet: "fire-training",
    theme: "fire-station",
    materialSalt: 79,
    landmarkNodes: [
      "FireStationTrainingCluster",
      "FireStationRopeRescueCluster",
      "FireStationBreathingGearCluster",
    ],
    routeFractions: [0.15, 0.5, 0.83],
    arrivalNode: "FireStationTrainingArrivalCluster",
    hideDressingNode: "FireStationTrainingHideDressing",
    exitNode: "FireStationTrainingExitCluster",
  },
  {
    levelId: "factory-assembly-nightshift",
    propSet: "factory-assembly",
    theme: "factory",
    materialSalt: 83,
    landmarkNodes: ["FactoryAssemblyLineCluster", "FactoryRobotCellCluster", "FactoryInspectionCluster"],
    routeFractions: [0.19, 0.52, 0.81],
    arrivalNode: "FactoryAssemblyArrivalCluster",
    hideDressingNode: "FactoryAssemblyHideDressing",
    exitNode: "FactoryAssemblyExitCluster",
  },
  {
    levelId: "factory-turbine-hall",
    propSet: "factory-turbine",
    theme: "factory",
    materialSalt: 97,
    landmarkNodes: ["FactoryTurbineCluster", "FactoryHighPressurePipeCluster", "FactoryBreakerCluster"],
    routeFractions: [0.16, 0.49, 0.8],
    arrivalNode: "FactoryTurbineArrivalCluster",
    hideDressingNode: "FactoryTurbineHideDressing",
    exitNode: "FactoryTurbineExitCluster",
  },
  {
    levelId: "factory-foundry-final-run",
    propSet: "factory-foundry",
    theme: "factory",
    materialSalt: 109,
    landmarkNodes: ["FactoryFurnaceCluster", "FactoryCastingCluster", "FactoryCoolingCluster"],
    routeFractions: [0.14, 0.46, 0.77],
    arrivalNode: "FactoryFoundryArrivalCluster",
    hideDressingNode: "FactoryFoundryHideDressing",
    exitNode: "FactoryFoundryExitCluster",
  },
];

export const LEVEL_ENVIRONMENT_COMPOSITIONS: Readonly<
  Record<string, LevelEnvironmentCompositionProfile>
> = deepFreeze(Object.fromEntries(
  LEVEL_PROFILE_SOURCES.map((source) => [source.propSet, defineLevelProfile(source)]),
));

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smoothstep = (value: number) => {
  const selected = clamp01(value);
  return selected * selected * (3 - 2 * selected);
};

function finiteProgress(value: number): number {
  return Number.isFinite(value) ? clamp01(value) : 0;
}

function themeForLevel(level: Pick<CampaignLevelDefinition, "campaign">) {
  return THEME_ENVIRONMENT_COMPOSITIONS[level.campaign.theme];
}

export function environmentCompositionProfileForLevel(
  level: Pick<CampaignLevelDefinition, "id" | "campaign">,
): LevelEnvironmentCompositionProfile {
  const propSet = level.campaign.atmosphere.propSet;
  const selected = LEVEL_ENVIRONMENT_COMPOSITIONS[propSet];
  if (!selected) throw new Error(`No production environment composition for prop set ${propSet}`);
  if (selected.levelId !== level.id || selected.theme !== level.campaign.theme) {
    throw new Error(
      `Environment composition mismatch for ${level.id}: expected ${selected.levelId}/${selected.theme}`,
    );
  }
  return selected;
}

function isCorner(route: readonly Point[], index: number): boolean {
  const previous = route[Math.max(0, index - 1)];
  const current = route[index];
  const next = route[Math.min(route.length - 1, index + 1)];
  const incoming = { x: current.x - previous.x, y: current.y - previous.y };
  const outgoing = { x: next.x - current.x, y: next.y - current.y };
  return incoming.x !== outgoing.x || incoming.y !== outgoing.y;
}

function routeTangent(route: readonly Point[], index: number): Point {
  const previous = route[Math.max(0, index - 1)];
  const next = route[Math.min(route.length - 1, index + 1)];
  const x = next.x - previous.x;
  const y = next.y - previous.y;
  const length = Math.hypot(x, y);
  return length > 1e-9
    ? Object.freeze({ x: x / length, y: y / length })
    : Object.freeze({ x: 0, y: 1 });
}

/**
 * Sequences the three hero roots along the actual critical route. Fractions
 * remain authored, but nearby real junctions/corners win so a landmark helps
 * the player make a decision instead of decorating an arbitrary empty room.
 */
export function landmarkBeatPlanForLevel(
  level: CampaignLevelDefinition,
): readonly LandmarkBeatPlan[] {
  const profile = environmentCompositionProfileForLevel(level);
  const route = findPath(level, level.playerStart, level.exit);
  if (route.length < 7) throw new Error(`Critical route for ${level.id} is too short for three landmarks`);
  const minimumSpacing = Math.max(2, Math.floor(route.length * 0.075));
  const scanRadius = Math.max(2, Math.round(route.length * 0.1));
  const selectedIndices: number[] = [];
  const beats: LandmarkBeatPlan[] = [];

  for (const [segmentIndex, segment] of profile.landmarkSegments.entries()) {
    const targetIndex = Math.round(segment.routeFraction * (route.length - 1));
    const remainingSegments = profile.landmarkSegments.length - segmentIndex - 1;
    const minimumIndex = Math.max(1, (selectedIndices.at(-1) ?? 0) + minimumSpacing);
    const maximumIndex = Math.min(
      route.length - 2,
      route.length - 2 - remainingSegments * minimumSpacing,
    );
    let selectedIndex = Math.max(minimumIndex, Math.min(maximumIndex, targetIndex));
    let selectedScore = Number.POSITIVE_INFINITY;
    const start = Math.max(minimumIndex, targetIndex - scanRadius);
    const end = Math.min(maximumIndex, targetIndex + scanRadius);
    for (let candidateIndex = start; candidateIndex <= end; candidateIndex += 1) {
      const cell = route[candidateIndex];
      const junctionDegree = neighbors(level, cell).length;
      const decisionBonus = Math.max(0, junctionDegree - 2) * 3.2;
      const cornerBonus = isCorner(route, candidateIndex) ? 0.8 : 0;
      const score = Math.abs(candidateIndex - targetIndex) - decisionBonus - cornerBonus;
      if (score < selectedScore - 1e-9) {
        selectedScore = score;
        selectedIndex = candidateIndex;
      }
    }
    selectedIndices.push(selectedIndex);
    const focusCell = route[selectedIndex];
    const junctionDegree = neighbors(level, focusCell).length;
    beats.push(Object.freeze({
      ...segment,
      label: level.campaign.landmarks[segmentIndex] ?? segment.id,
      routeIndex: selectedIndex,
      resolvedRouteFraction: selectedIndex / (route.length - 1),
      focusCell: Object.freeze({ ...focusCell }),
      routeTangent: routeTangent(route, selectedIndex),
      junctionDegree,
      decisionStrength: clamp01((junctionDegree - 2) / 2 + (isCorner(route, selectedIndex) ? 0.2 : 0)),
    }));
  }
  return Object.freeze(beats);
}

function lightDistance(light: LocalLightPoolPlan, player?: Point) {
  return player
    ? Math.hypot(light.position.x - player.x, light.position.y - player.y)
    : 0;
}

export function localLightPoolPlanForLevel(
  level: CampaignLevelDefinition,
  options: EnvironmentCompositionPlanOptions = {},
): readonly LocalLightPoolPlan[] {
  const tier = options.qualityTier ?? "high";
  const budget = ENVIRONMENT_COMPOSITION_BUDGETS[tier];
  const available = Number.isFinite(options.availableDynamicLightSlots)
    ? Math.max(0, Math.floor(options.availableDynamicLightSlots ?? 0))
    : budget.maximumLocalLightPools;
  const limit = Math.min(budget.maximumLocalLightPools, available);
  if (limit <= 0) return Object.freeze([]);
  const theme = themeForLevel(level);
  const beats = landmarkBeatPlanForLevel(level);
  const candidates = beats.map((beat, index) => {
    const style = theme.lightPools[index];
    return Object.freeze({
      ...style,
      segmentId: beat.id,
      position: Object.freeze({ ...beat.focusCell }),
      color: level.campaign.palette[style.colorToken],
    });
  });
  return Object.freeze(candidates
    .map((light, index) => ({ light, index }))
    .sort((left, right) => (
      lightDistance(left.light, options.playerPosition)
      - lightDistance(right.light, options.playerPosition)
      || right.light.priority - left.light.priority
      || left.index - right.index
    ))
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map(({ light }) => light));
}

function integerHash(x: number, y: number, salt: number, role: CompositionSurfaceRole) {
  const roleSalt: Readonly<Record<CompositionSurfaceRole, number>> = {
    wall: 17,
    floor: 31,
    trim: 47,
    landmark: 61,
  };
  let hash = (
    Math.round(x * 16) * 374761393
    + Math.round(y * 16) * 668265263
    + salt * 2246822519
    + roleSalt[role]
  ) | 0;
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Returns one shared variant from a finite theme set. Runtime should cache by
 * `id`; never clone a material per cell.
 */
export function compositionMaterialVariantForCell(
  level: Pick<CampaignLevelDefinition, "id" | "campaign">,
  role: CompositionSurfaceRole,
  cell: Point,
): MaterialVariationSpec {
  const profile = environmentCompositionProfileForLevel(level);
  const variants = themeForLevel(level).materialVariation[role];
  const index = integerHash(cell.x, cell.y, profile.materialSalt, role) % variants.length;
  return variants[index];
}

export function sceneEdgeClosurePlanForLevel(
  level: CampaignLevelDefinition,
): SceneEdgeClosurePlan {
  const style = themeForLevel(level).edgeClosure;
  const horizontalCenter = (level.width - 1) / 2;
  const verticalCenter = (level.height - 1) / 2;
  const segments: readonly SceneEdgeClosureSegment[] = Object.freeze([
    Object.freeze({
      side: "north",
      center: Object.freeze({ x: horizontalCenter, y: -0.5 }),
      outward: Object.freeze({ x: 0, y: -1 }),
      lengthCells: level.width,
    }),
    Object.freeze({
      side: "east",
      center: Object.freeze({ x: level.width - 0.5, y: verticalCenter }),
      outward: Object.freeze({ x: 1, y: 0 }),
      lengthCells: level.height,
    }),
    Object.freeze({
      side: "south",
      center: Object.freeze({ x: horizontalCenter, y: level.height - 0.5 }),
      outward: Object.freeze({ x: 0, y: 1 }),
      lengthCells: level.width,
    }),
    Object.freeze({
      side: "west",
      center: Object.freeze({ x: -0.5, y: verticalCenter }),
      outward: Object.freeze({ x: -1, y: 0 }),
      lengthCells: level.height,
    }),
  ]);
  return deepFreeze({
    ...style,
    segments,
    fogColor: level.campaign.palette[style.fogColorToken],
    proceduralTriangles: 8,
    additionalDrawCalls: 1,
  });
}

function parseHexColor(value: string): readonly [number, number, number] {
  const normalized = value.trim().replace(/^#/, "");
  const expanded = normalized.length === 3
    ? normalized.split("").map((digit) => `${digit}${digit}`).join("")
    : normalized;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) return [255, 255, 255];
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function decalPixel(
  pattern: ProceduralDecalPattern,
  u: number,
  v: number,
  repeatCount: number,
  stroke: number,
): 0 | 1 | 2 {
  const repeatedX = (u * repeatCount) % 1;
  switch (pattern) {
    case "wayfinding-band": {
      const band = Math.abs(v - 0.5) <= stroke;
      const tick = Math.abs(v - 0.5) <= stroke * 2.2 && repeatedX <= stroke * 1.8;
      return tick ? 2 : band ? 1 : 0;
    }
    case "threshold-dash":
      return Math.abs(v - 0.5) <= stroke && repeatedX <= 0.58 ? 1 : 0;
    case "hazard-stripe":
      return ((u + v) * repeatCount) % 1 < 0.5 ? 1 : 2;
    case "service-chevron": {
      const local = Math.abs(repeatedX - 0.5) * 2;
      const upper = 0.5 - local * 0.34;
      const lower = 0.5 + local * 0.34;
      return Math.min(Math.abs(v - upper), Math.abs(v - lower)) <= stroke ? 1 : 0;
    }
  }
}

/**
 * Generates the active theme's only composition marking. This is a runtime
 * 64×64 byte array, not a shipped texture, and all instances share it.
 */
export function createCompositionDecalPixels(
  theme: CampaignTheme,
  palette: CampaignPaletteTokens,
): ProceduralDecalPixels {
  const program = THEME_ENVIRONMENT_COMPOSITIONS[theme].materialVariation.decal;
  const resolution = program.generatedResolution;
  const foreground = parseHexColor(palette[program.foregroundToken]);
  const secondary = parseHexColor(palette[program.secondaryToken]);
  const data = new Uint8Array(resolution * resolution * 4);
  const alpha = Math.round(clamp01(program.opacity) * 255);
  for (let y = 0; y < resolution; y += 1) {
    for (let x = 0; x < resolution; x += 1) {
      const selected = decalPixel(
        program.pattern,
        (x + 0.5) / resolution,
        (y + 0.5) / resolution,
        program.repeatCount,
        program.strokeFraction,
      );
      const offset = (y * resolution + x) * 4;
      if (selected === 0) continue;
      const color = selected === 1 ? foreground : secondary;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = alpha;
    }
  }
  return Object.freeze({
    width: resolution,
    height: resolution,
    data,
    byteLength: data.byteLength,
    networkBytes: 0,
    colorSpace: "srgb",
  });
}

function feedbackStage(phase: MechanicPhase): MechanicFeedbackStage | null {
  if (phase === "warning") return "warning";
  if (phase === "active") return "active";
  if (phase === "cooldown") return "recover";
  return null;
}

/**
 * Phase envelopes join exactly at warning→active and active→recover:
 * warning ends at 0.82, active starts at 0.82, and active/recover meet at 1.
 */
function feedbackEnvelope(stageName: MechanicFeedbackStage, progress: number) {
  if (stageName === "warning") return 0.82 * smoothstep(progress);
  if (stageName === "active") return 0.82 + 0.18 * smoothstep(progress / 0.12);
  return 1 - smoothstep(progress);
}

export function sampleMechanicWorldFeedback(
  theme: CampaignTheme,
  input: MechanicWorldFeedbackInput,
): MechanicWorldFeedbackSample {
  const profile = THEME_ENVIRONMENT_COMPOSITIONS[theme].mechanicFeedback;
  const selectedStage = feedbackStage(input.phase);
  const progress = finiteProgress(input.progress);
  const tier = input.qualityTier ?? "high";
  const budget = ENVIRONMENT_COMPOSITION_BUDGETS[tier];
  const defaultStage = profile.stages.recover;
  if (!selectedStage) {
    return Object.freeze({
      stage: null,
      stageProgress: 0,
      envelope: 0,
      colorToken: defaultStage.colorToken,
      emissiveIntensity: 0,
      lightIntensity: 0,
      lightRangeMeters: defaultStage.lightRangeMeters,
      scaleMultiplier: 1,
      partMotionKind: profile.partMotion.kind,
      partMotionAxis: profile.partMotion.axis,
      partMotionAmount: 0,
      targetNodeCandidates: profile.partMotion.targetNodeCandidates,
      sourceNodeCandidates: profile.sourceNodeCandidates,
      particleKind: "none",
      particleCount: 0,
      effectOpacity: 0,
      usesPooledLocalLight: true,
      usesAtmosphereParticleBuffer: true,
    });
  }
  const selected = profile.stages[selectedStage];
  const envelope = feedbackEnvelope(selectedStage, progress);
  const pulsePhase = progress * selected.pulseCycles * Math.PI * 2;
  const signedPulse = Math.sin(pulsePhase);
  const lightPulse = input.reducedMotion ? 0.5 : 0.5 + 0.5 * signedPulse;
  const pulseGain = 0.86 + lightPulse * 0.14;
  const motionScale = input.reducedMotion ? 0 : 1;
  const maximumParticles = Math.min(
    selected.maximumParticles,
    budget.maximumMechanicParticles,
  );
  return Object.freeze({
    stage: selectedStage,
    stageProgress: progress,
    envelope,
    colorToken: selected.colorToken,
    emissiveIntensity: selected.peakEmissiveIntensity * envelope * pulseGain,
    lightIntensity: selected.peakLightIntensity * envelope * pulseGain,
    lightRangeMeters: selected.lightRangeMeters,
    scaleMultiplier: 1 + selected.rootScaleAmplitude * envelope * lightPulse * motionScale,
    partMotionKind: profile.partMotion.kind,
    partMotionAxis: profile.partMotion.axis,
    partMotionAmount: motionScale === 0
      ? 0
      : selected.partMotionAmplitude * envelope * signedPulse,
    targetNodeCandidates: profile.partMotion.targetNodeCandidates,
    sourceNodeCandidates: profile.sourceNodeCandidates,
    particleKind: selected.particleKind,
    particleCount: Math.round(maximumParticles * envelope),
    effectOpacity: selected.effectOpacity * envelope,
    usesPooledLocalLight: true,
    usesAtmosphereParticleBuffer: true,
  });
}

export function buildEnvironmentCompositionPlan(
  level: CampaignLevelDefinition,
  options: EnvironmentCompositionPlanOptions = {},
): EnvironmentCompositionPlan {
  const profile = environmentCompositionProfileForLevel(level);
  const qualityTier = options.qualityTier ?? "high";
  const budget = ENVIRONMENT_COMPOSITION_BUDGETS[qualityTier];
  const theme = themeForLevel(level);
  const criticalRoute = Object.freeze(findPath(level, level.playerStart, level.exit)
    .map((point) => Object.freeze({ ...point })));
  if (criticalRoute.length === 0) throw new Error(`Level ${level.id} has no critical route`);
  return Object.freeze({
    profile,
    theme,
    budget,
    criticalRoute,
    landmarkBeats: landmarkBeatPlanForLevel(level),
    activeLightPools: localLightPoolPlanForLevel(level, options),
    edgeClosure: sceneEdgeClosurePlanForLevel(level),
    materialVariation: theme.materialVariation,
    decalInstanceLimit: Math.min(
      theme.materialVariation.decal.maximumInstances,
      budget.maximumProceduralDecals,
    ),
  });
}
