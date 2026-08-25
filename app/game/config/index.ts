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

export const SIZE = 25;
export const CELL = 2;
export const START = { x: 1, y: 1 };
export const EXIT = { x: 23, y: 23 };
export const VILLAIN_START = { x: 7, y: 1 };
export const POLICE_POINT = { x: 23, y: 22.25 };
export const PATROL = [
  { x: 7, y: 7 },
  { x: 15, y: 3 },
  { x: 21, y: 10 },
  { x: 17, y: 19 },
  { x: 9, y: 20 },
];

export const ACTOR_SPECS = [
  { name: "kid" as const, url: "/models/characters/kid.glb?v=21", height: 2.12, color: 0x4d9fff, label: "你" },
  { name: "villain" as const, url: "/models/characters/villain.glb?v=21", height: 2.28, color: 0xff4f5e, label: "追捕者" },
  { name: "police" as const, url: "/models/characters/police.glb?v=21", height: 2.18, color: 0x35e5f2, label: "警察" },
] as const;
export const BLOCKING_ACTOR_SPECS = ACTOR_SPECS.filter((spec) => spec.name !== "police");

export const CORE_ASSETS = {
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

export const DETAIL_ASSETS = {
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
export const largeShadowProps = new Set<keyof typeof DETAIL_ASSETS>(P1_SHADOW_CASTERS);
