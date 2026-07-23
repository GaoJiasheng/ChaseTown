import type { GameConfig, LevelDefinition, Point } from "./contracts.ts";

const SIZE = 25;

function carve(grid: boolean[][], points: readonly Point[]) {
  for (let index = 1; index < points.length; index += 1) {
    let { x, y } = points[index - 1];
    const target = points[index];
    while (x !== target.x || y !== target.y) {
      grid[y][x] = true;
      if (x !== target.x) x += Math.sign(target.x - x);
      else y += Math.sign(target.y - y);
    }
    grid[y][x] = true;
  }
}

export const DEFAULT_GAME_CONFIG: Readonly<GameConfig> = Object.freeze({
  fixedStepSeconds: 1 / 60,
  maxFrameDeltaSeconds: 0.25,
  aiTickSeconds: 0.1,
  // Campaign pace pass: locomotion is intentionally 20% faster than the
  // original vertical slice. Grid cells are 2 m in presentation space, so
  // these map to 5.28 m/s and 4.44 m/s and drive 1.2x clip playback.
  playerSpeed: 2.64,
  chaserSpeed: 2.22,
  spawnDelaySeconds: 1.5,
  suspiciousSeconds: 0.2,
  lostSightGraceSeconds: 0.35,
  // Once the pursuer reaches the exact final sighting, one authored Search
  // performance sweeps left, right, then centre before wider search begins.
  lastKnownScanSeconds: 1.5,
  searchSeconds: 4.5,
  searchWaypointSeconds: 0.75,
  // The reusable vertical-slice default remains conservative. Campaign
  // chapters opt into evidence-ranked locker checks explicitly.
  searchHideCheckBudget: 0,
  searchHideRadiusCells: 3,
  checkHideSeconds: 2.35,
  hearingRange: 7,
  soundUncertaintyCells: 1,
  visionRange: 7,
  visionConeDegrees: 110,
  proximitySenseRange: 0.85,
  catchRange: 0.58,
  exitRange: 0.62,
  // Slightly generous reach keeps the premium locker easy to operate from a
  // mobile stick or an oblique corridor approach without allowing remote use.
  hideInteractRange: 1.05,
  hideAlignSpeed: 1.32,
  // One 90° pivot now lasts exactly 0.5 s; the simulation applies the same
  // smootherstep yaw curve as the authored heel/toe Turn clips.
  hideAlignTurnSpeed: (Math.PI / 2) / 0.5,
  hideEnterSeconds: 2.27 / 1.2,
  hideEnterExposureSeconds: 1.78 / 1.2,
  hideExitSeconds: 1.94 / 1.2,
  hideExitExposureSeconds: 0.38 / 1.2,
  peekEnterSeconds: 0.18 / 1.2,
  peekExitSeconds: 0.18 / 1.2,
});

export function createDefaultLevel(): LevelDefinition {
  const walkable = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  carve(walkable, [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 7 }, { x: 11, y: 7 }, { x: 11, y: 13 }, { x: 17, y: 13 }, { x: 17, y: 19 }, { x: 23, y: 19 }, { x: 23, y: 23 }]);
  carve(walkable, [{ x: 1, y: 1 }, { x: 1, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 16 }, { x: 13, y: 16 }, { x: 13, y: 23 }, { x: 23, y: 23 }]);
  carve(walkable, [{ x: 7, y: 7 }, { x: 7, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 10 }, { x: 21, y: 10 }, { x: 21, y: 23 }, { x: 23, y: 23 }]);
  carve(walkable, [{ x: 3, y: 10 }, { x: 3, y: 14 }]);
  carve(walkable, [{ x: 9, y: 13 }, { x: 9, y: 20 }]);
  carve(walkable, [{ x: 9, y: 13 }, { x: 11, y: 13 }]);
  carve(walkable, [{ x: 15, y: 3 }, { x: 20, y: 3 }]);
  carve(walkable, [{ x: 17, y: 16 }, { x: 22, y: 16 }]);
  carve(walkable, [{ x: 11, y: 7 }, { x: 14, y: 7 }]);
  // A short blind alcove makes the north locker a real post-chase refuge:
  // the player must round the corner before committing to the long entry.
  carve(walkable, [{ x: 7, y: 5 }, { x: 9, y: 5 }]);
  // Four readable secondary branches turn the opening chapter into a real
  // maze: each adds a decision or loop without shortening the certified
  // north-locker escape route into a trivial straight line.
  carve(walkable, [{ x: 9, y: 20 }, { x: 13, y: 20 }]);
  carve(walkable, [{ x: 11, y: 9 }, { x: 13, y: 9 }]);
  carve(walkable, [{ x: 15, y: 5 }, { x: 17, y: 5 }]);
  carve(walkable, [{ x: 17, y: 14 }, { x: 19, y: 14 }]);

  // Replace the lower straight crossbar with a longer dogleg. Sealing happens
  // after all carving so a future route cannot accidentally reopen the wall.
  carve(walkable, [{ x: 9, y: 20 }, { x: 9, y: 22 }, { x: 13, y: 22 }, { x: 13, y: 20 }]);
  for (const cell of [{ x: 10, y: 20 }, { x: 11, y: 20 }, { x: 12, y: 20 }]) {
    walkable[cell.y][cell.x] = false;
  }

  return createLevel({
    id: "school-maze-v1",
    width: SIZE,
    height: SIZE,
    walkable,
    // Start one cell inside the gate so the hero silhouette is not hidden by
    // the door frame in the first playable camera shot.
    playerStart: { x: 1, y: 2 },
    exit: { x: 23, y: 23 },
    chaserStart: { x: 21, y: 10 },
    chaserStartHeading: { x: -1, y: 0 },
    patrol: [
      { x: 15, y: 10 },
      { x: 15, y: 3 },
      { x: 7, y: 7 },
      { x: 17, y: 19 },
      { x: 21, y: 10 },
    ],
    hideSpots: [
      {
        id: "locker-north",
        approach: { x: 9, y: 5 },
        concealed: { x: 9, y: 4.65 },
        facing: { x: 0, y: 1 },
        archetype: "hard-locker",
      },
      {
        id: "locker-south",
        approach: { x: 13, y: 19 },
        concealed: { x: 12.65, y: 19 },
        facing: { x: 1, y: 0 },
        archetype: "soft-cover",
      },
    ],
    // These cells contain large authored scene props. They retain their floor
    // module but are excluded from movement/pathing and block perception, so
    // neither player nor chaser can ghost through the visible meshes.
    movementBlockers: [
      { x: 22, y: 16 }, // bench
      { x: 3, y: 14 }, // tree
      { x: 19, y: 14 }, // shrub
      { x: 22, y: 23 }, // police car
      { x: 20, y: 3 }, // basketball hoop
      { x: 13, y: 9 }, // desk/chair set
      { x: 17, y: 5 }, // teacher podium
    ],
    visionOnlyBlockers: [{ x: 18, y: 16 }],
  });
}

/** Validates externally-authored/test levels at the pure logic boundary. */
export function createLevel(level: LevelDefinition): LevelDefinition {
  if (!Number.isInteger(level.width) || !Number.isInteger(level.height) || level.width <= 0 || level.height <= 0) {
    throw new Error("Level dimensions must be positive integers");
  }
  if (level.walkable.length !== level.height || level.walkable.some((row) => row.length !== level.width)) {
    throw new Error("Level walkable grid dimensions do not match width/height");
  }
  const requiredPoints = [
    level.playerStart,
    level.exit,
    level.chaserStart,
    ...level.patrol,
    ...level.hideSpots.flatMap((spot) => (
      spot.alternateExit ? [spot.approach, spot.alternateExit] : [spot.approach]
    )),
  ];
  for (const point of requiredPoints) {
    if (!level.walkable[Math.round(point.y)]?.[Math.round(point.x)]) {
      throw new Error(`Required level point (${point.x}, ${point.y}) is not walkable`);
    }
  }
  const ids = new Set<string>();
  for (const spot of level.hideSpots) {
    if (ids.has(spot.id)) throw new Error(`Duplicate hide spot id: ${spot.id}`);
    ids.add(spot.id);
    const archetype = spot.archetype ?? "hard-locker";
    if (!["hard-locker", "soft-cover", "traversal-hide"].includes(archetype)) {
      throw new Error(`Unknown hide archetype: ${String(archetype)}`);
    }
    if (archetype === "traversal-hide" && !spot.alternateExit) {
      throw new Error(`Traversal hide ${spot.id} requires an alternate exit`);
    }
    if (archetype !== "traversal-hide" && spot.alternateExit) {
      throw new Error(`${archetype} ${spot.id} cannot declare an alternate exit`);
    }
    if (
      spot.alternateExit
      && Math.round(spot.alternateExit.x) === Math.round(spot.approach.x)
      && Math.round(spot.alternateExit.y) === Math.round(spot.approach.y)
    ) {
      throw new Error(`Alternate exit for ${spot.id} must be a distinct walkable cell`);
    }
  }
  const blockerKeys = new Set<string>();
  for (const blocker of level.movementBlockers ?? []) {
    const key = `${Math.round(blocker.x)},${Math.round(blocker.y)}`;
    if (!level.walkable[Math.round(blocker.y)]?.[Math.round(blocker.x)]) {
      throw new Error(`Movement blocker (${blocker.x}, ${blocker.y}) must sit on a rendered floor cell`);
    }
    if (blockerKeys.has(key)) throw new Error(`Duplicate movement blocker: ${key}`);
    blockerKeys.add(key);
  }
  for (const point of requiredPoints) {
    const key = `${Math.round(point.x)},${Math.round(point.y)}`;
    if (blockerKeys.has(key)) throw new Error(`Required level point (${point.x}, ${point.y}) is blocked by a solid prop`);
  }
  return level;
}
