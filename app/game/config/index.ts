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

export const P3_TUNING = Object.freeze({
  retryDelaysMs: [500, 1500] as const,
  searchLookAmplitude: 0.24,
  searchLookPeriodMs: 1250,
  victoryFreezeMs: 600,
});

export const P4_TUNING = Object.freeze({
  shadowHalfExtent: 16,
  shadowMapSize: 1024,
  maxTextureAnisotropy: 8,
  exitPulsePeriodMs: 1600,
  victoryTurnDamping: 6,
  readyCameraDistanceAmplitude: 0.34,
  readyCameraLateralAmplitude: 0.18,
  readyCameraPeriodMs: 9000,
  readyCameraBlendDamping: 2.6,
  reducedIdleBreathScale: 0.5,
});

export const ASSET_VERSION = "22";

export function versionAssetUrl(url: string, version = ASSET_VERSION) {
  if (/^(?:data|blob):/u.test(url)) return url;
  const hashIndex = url.indexOf("#");
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "");
  params.set("v", version);
  return `${pathname}?${params.toString()}${hash}`;
}

export function runtimeAssetUrl(url: string, version = ASSET_VERSION) {
  const webpUrl = url.replace(
    /(\/models\/)(?:[^/?#]+\/\.\.\/)*(SharedTextures\/[^?#]+)\.png(?=[?#]|$)/u,
    "$1$2.webp",
  );
  return versionAssetUrl(webpUrl, version);
}

export const SIZE = 25;
export const CELL = 2;
export const START = { x: 1, y: 1 };
export const EXIT = { x: 23, y: 23 };
export const VILLAIN_START = { x: 7, y: 1 };
export const POLICE_POINT = { x: 23, y: 22.25 };
export const PATROL = [
  { x: 21, y: 21.5 },
  { x: 21, y: 16 },
  { x: 9, y: 20 },
  { x: 7, y: 7 },
  { x: 15, y: 3 },
  { x: 21, y: 10 },
  { x: 23, y: 22 },
  { x: 17, y: 19 },
];

export const ACTOR_SPECS = [
  { name: "kid" as const, url: versionAssetUrl("/models/characters/kid.glb"), height: 2.12, color: 0x4d9fff, label: "你" },
  { name: "villain" as const, url: versionAssetUrl("/models/characters/villain.glb"), height: 2.28, color: 0xff4f5e, label: "追捕者" },
  { name: "police" as const, url: versionAssetUrl("/models/characters/police.glb"), height: 2.18, color: 0x35e5f2, label: "警察" },
] as const;
export const BLOCKING_ACTOR_SPECS = ACTOR_SPECS.filter((spec) => spec.name !== "police");

export const CORE_ASSETS = {
  wall: versionAssetUrl("/models/environment/wall.glb"),
  wallCorner: versionAssetUrl("/models/environment/wall-corner.glb"),
  wallEnd: versionAssetUrl("/models/environment/wall-end.glb"),
  floor: versionAssetUrl("/models/environment/floor.glb"),
  exit: versionAssetUrl("/models/environment/exit.glb"),
  frontGate: versionAssetUrl("/models/environment/front-gate.glb"),
  classroomFloor: versionAssetUrl("/models/environment/classroom-floor.glb"),
  playgroundFloor: versionAssetUrl("/models/environment/playground-floor.glb"),
  grassFloor: versionAssetUrl("/models/environment/grass-floor.glb"),
} as const;

export const DETAIL_ASSETS = {
  locker: versionAssetUrl("/models/environment/locker.glb"),
  bench: versionAssetUrl("/models/environment/bench.glb"),
  car: versionAssetUrl("/models/environment/police-car.glb"),
  tree: versionAssetUrl("/models/environment/tree.glb"),
  classroomDoor: versionAssetUrl("/models/environment/classroom-door.glb"),
  ceilingLight: versionAssetUrl("/models/environment/ceiling-light.glb"),
  basketball: versionAssetUrl("/models/environment/basketball.glb"),
  deskChair: versionAssetUrl("/models/environment/desk-chair.glb"),
  blackboard: versionAssetUrl("/models/environment/blackboard.glb"),
  bulletin: versionAssetUrl("/models/environment/bulletin.glb"),
  podium: versionAssetUrl("/models/environment/podium.glb"),
  extinguisher: versionAssetUrl("/models/environment/extinguisher.glb"),
  trash: versionAssetUrl("/models/environment/trash.glb"),
  books: versionAssetUrl("/models/environment/books.glb"),
  backpack: versionAssetUrl("/models/environment/backpack.glb"),
  shrub: versionAssetUrl("/models/environment/shrub.glb"),
  station: versionAssetUrl("/models/environment/station.glb"),
} as const;
export const P1_SHADOW_CASTERS = ["car", "tree", "station", "locker", "basketball", "bench", "blackboard", "podium"] as const;
export const largeShadowProps = new Set<keyof typeof DETAIL_ASSETS>(P1_SHADOW_CASTERS);
