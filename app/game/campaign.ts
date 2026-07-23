import type { GameConfig, HideSpotDefinition, LevelDefinition, Point } from "./contracts.ts";
import { createDefaultLevel, createLevel, DEFAULT_GAME_CONFIG } from "./level.ts";

export type CampaignTheme = "campus" | "hospital" | "fire-station" | "factory";
export type CampaignDifficulty = 1 | 2 | 3 | 4 | 5;

export interface CampaignPaletteTokens {
  readonly floor: string;
  readonly wall: string;
  readonly trim: string;
  readonly accent: string;
  readonly emissive: string;
  readonly fog: string;
  readonly sky: string;
}

export interface CampaignAtmosphereTokens {
  readonly mood: string;
  readonly lighting: string;
  readonly weather: string;
  readonly ambience: string;
  readonly score: string;
  readonly propSet: string;
}

export interface CampaignMetadata {
  /** One-based position shown to players. */
  readonly levelNumber: number;
  readonly name: string;
  readonly subtitle: string;
  readonly theme: CampaignTheme;
  readonly themeLabel: string;
  readonly difficulty: CampaignDifficulty;
  readonly difficultyLabel: string;
  readonly briefing: string;
  readonly palette: CampaignPaletteTokens;
  readonly atmosphere: CampaignAtmosphereTokens;
  readonly landmarks: readonly string[];
}

/** A campaign level remains directly consumable anywhere a LevelDefinition is accepted. */
export interface CampaignLevelDefinition extends LevelDefinition {
  readonly campaign: CampaignMetadata;
}

interface AuthoredLevelSpec {
  readonly id: string;
  readonly width?: number;
  readonly height?: number;
  readonly routes: readonly (readonly Point[])[];
  /** Cells removed after every route is carved, allowing authored doglegs to replace straight runs. */
  readonly sealedCells?: readonly Point[];
  readonly playerStart: Point;
  readonly exit: Point;
  readonly chaserStart: Point;
  readonly chaserStartHeading: Point;
  readonly patrol: readonly Point[];
  readonly hideSpots: readonly HideSpotDefinition[];
  readonly visionOnlyBlockers?: readonly Point[];
}

const point = (x: number, y: number): Point => ({ x, y });

function carveRoute(grid: boolean[][], route: readonly Point[]) {
  if (route.length === 0) return;
  let { x, y } = route[0];
  grid[y][x] = true;
  for (const target of route.slice(1)) {
    while (x !== target.x || y !== target.y) {
      if (x !== target.x) x += Math.sign(target.x - x);
      else y += Math.sign(target.y - y);
      grid[y][x] = true;
    }
  }
}

function authoredLevel(spec: AuthoredLevelSpec): LevelDefinition {
  const width = spec.width ?? 25;
  const height = spec.height ?? 25;
  const walkable = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
  for (const route of spec.routes) carveRoute(walkable, route);
  for (const cell of spec.sealedCells ?? []) walkable[cell.y][cell.x] = false;
  return createLevel({
    id: spec.id,
    width,
    height,
    walkable,
    playerStart: spec.playerStart,
    exit: spec.exit,
    chaserStart: spec.chaserStart,
    chaserStartHeading: spec.chaserStartHeading,
    patrol: spec.patrol,
    hideSpots: spec.hideSpots,
    visionOnlyBlockers: spec.visionOnlyBlockers,
  });
}

function freezePoint(value: Point): Point {
  return Object.freeze({ ...value });
}

function campaignLevel(level: LevelDefinition, metadata: CampaignMetadata): CampaignLevelDefinition {
  return Object.freeze({
    ...level,
    walkable: Object.freeze(level.walkable.map((row) => Object.freeze([...row]))),
    playerStart: freezePoint(level.playerStart),
    exit: freezePoint(level.exit),
    chaserStart: freezePoint(level.chaserStart),
    chaserStartHeading: freezePoint(level.chaserStartHeading),
    patrol: Object.freeze(level.patrol.map(freezePoint)),
    hideSpots: Object.freeze(level.hideSpots.map((spot) => Object.freeze({
      ...spot,
      approach: freezePoint(spot.approach),
      concealed: freezePoint(spot.concealed),
      facing: freezePoint(spot.facing),
    }))),
    movementBlockers: level.movementBlockers
      ? Object.freeze(level.movementBlockers.map(freezePoint))
      : undefined,
    visionOnlyBlockers: level.visionOnlyBlockers
      ? Object.freeze(level.visionOnlyBlockers.map(freezePoint))
      : undefined,
    campaign: Object.freeze({
      ...metadata,
      palette: Object.freeze({ ...metadata.palette }),
      atmosphere: Object.freeze({ ...metadata.atmosphere }),
      landmarks: Object.freeze([...metadata.landmarks]),
    }),
  });
}

const level2 = authoredLevel({
  id: "campus-library-lockdown",
  routes: [
    [point(1, 22), point(1, 17), point(5, 17), point(5, 10), point(11, 10), point(11, 4), point(18, 4), point(18, 1), point(23, 1)],
    [point(1, 22), point(7, 22), point(7, 14), point(15, 14), point(15, 7), point(23, 7), point(23, 1)],
    [point(5, 10), point(5, 5), point(11, 5)],
    [point(11, 10), point(18, 10), point(18, 4)],
    [point(7, 18), point(18, 18), point(18, 10)],
    [point(5, 5), point(2, 5)],
    [point(15, 14), point(20, 14)],
    [point(20, 14), point(20, 10), point(18, 10)],
    [point(11, 7), point(15, 7)],
    [point(3, 22), point(3, 20), point(5, 20), point(5, 22)],
    [point(11, 18), point(11, 20), point(13, 20), point(13, 18)],
    [point(18, 15), point(20, 15), point(20, 17), point(18, 17)],
    [point(20, 7), point(20, 5), point(22, 5), point(22, 7)],
  ],
  sealedCells: [point(4, 22), point(12, 18), point(18, 16), point(21, 7)],
  playerStart: point(1, 22),
  exit: point(23, 1),
  // The doglegged escape spine now approaches from the north-west; staging
  // the pursuer in the upper stacks preserves the authored first encounter.
  chaserStart: point(12, 4),
  chaserStartHeading: point(0, 1),
  patrol: [point(14, 18), point(11, 10), point(11, 4), point(23, 7), point(15, 14), point(18, 18)],
  hideSpots: [
    { id: "library-archive", approach: point(2, 5), concealed: point(1.65, 5), facing: point(1, 0) },
    { id: "library-map-case", approach: point(14, 14), concealed: point(14, 13.65), facing: point(0, 1) },
    { id: "library-return-locker", approach: point(7, 20), concealed: point(6.65, 20), facing: point(1, 0) },
  ],
  visionOnlyBlockers: [point(5, 16), point(15, 9), point(20, 12)],
});

const level3 = authoredLevel({
  id: "campus-science-wing",
  routes: [
    [point(2, 1), point(8, 1), point(8, 6), point(14, 6), point(14, 12), point(21, 12), point(21, 23), point(23, 23)],
    [point(2, 1), point(2, 9), point(6, 9), point(6, 16), point(13, 16), point(13, 22), point(23, 22)],
    [point(8, 6), point(8, 12), point(14, 12)],
    [point(6, 16), point(6, 20), point(13, 20)],
    [point(14, 6), point(19, 6), point(19, 3)],
    [point(6, 12), point(4, 12)],
    [point(14, 9), point(18, 9)],
    [point(13, 19), point(17, 19)],
    [point(8, 3), point(19, 3)],
    [point(6, 12), point(8, 12)],
    [point(13, 17), point(16, 17), point(16, 15), point(21, 15)],
    [point(4, 1), point(4, 3), point(6, 3), point(6, 1)],
    [point(10, 6), point(10, 8), point(12, 8), point(12, 6)],
    [point(14, 9), point(12, 9), point(12, 11), point(14, 11)],
    [point(16, 12), point(16, 10), point(18, 10), point(18, 12)],
    [point(21, 17), point(19, 17), point(19, 19), point(21, 19)],
    [point(16, 19), point(21, 19)],
  ],
  sealedCells: [point(5, 1), point(11, 6), point(14, 10), point(17, 12), point(21, 18)],
  playerStart: point(2, 1),
  exit: point(23, 23),
  chaserStart: point(10, 20),
  chaserStartHeading: point(0, -1),
  patrol: [point(15, 12), point(19, 6), point(14, 12), point(13, 16), point(21, 12), point(8, 6)],
  hideSpots: [
    { id: "science-chemical-cabinet", approach: point(4, 12), concealed: point(3.65, 12), facing: point(1, 0) },
    { id: "science-specimen-store", approach: point(18, 9), concealed: point(18.35, 9), facing: point(-1, 0) },
    { id: "science-cleaning-locker", approach: point(17, 19), concealed: point(17, 19.35), facing: point(0, -1) },
  ],
  visionOnlyBlockers: [point(8, 8), point(13, 20), point(20, 12), point(13, 3), point(16, 16)],
});

const level4 = authoredLevel({
  id: "hospital-outpatient-afterhours",
  routes: [
    [point(1, 12), point(5, 12), point(5, 5), point(12, 5), point(12, 10), point(19, 10), point(19, 4), point(23, 4), point(23, 12)],
    [point(1, 12), point(5, 12), point(5, 20), point(11, 20), point(11, 15), point(18, 15), point(18, 21), point(23, 21), point(23, 12)],
    [point(5, 8), point(12, 8)],
    [point(11, 15), point(11, 10), point(19, 10)],
    [point(12, 5), point(12, 2)],
    [point(5, 18), point(2, 18)],
    [point(18, 15), point(21, 15)],
    [point(8, 5), point(8, 10), point(11, 10)],
    [point(14, 10), point(14, 15)],
    [point(18, 18), point(23, 18)],
  ],
  playerStart: point(1, 12),
  exit: point(23, 12),
  chaserStart: point(19, 8),
  chaserStartHeading: point(0, 1),
  patrol: [point(17, 10), point(12, 5), point(8, 8), point(19, 10), point(14, 12), point(18, 15), point(23, 18), point(11, 20), point(5, 12)],
  hideSpots: [
    { id: "hospital-linen-north", approach: point(5, 8), concealed: point(4.65, 8), facing: point(1, 0) },
    { id: "hospital-pharmacy-store", approach: point(2, 18), concealed: point(1.65, 18), facing: point(1, 0) },
    { id: "hospital-supply-east", approach: point(21, 15), concealed: point(21.35, 15), facing: point(-1, 0) },
  ],
  visionOnlyBlockers: [point(8, 5), point(16, 10), point(18, 18), point(14, 12)],
});

const level5 = authoredLevel({
  id: "hospital-isolation-basement",
  routes: [
    [point(1, 1), point(1, 7), point(7, 7), point(7, 13), point(13, 13), point(13, 19), point(19, 19), point(19, 23), point(23, 23)],
    [point(1, 1), point(9, 1), point(9, 5), point(16, 5), point(16, 11), point(22, 11), point(22, 18), point(19, 18)],
    [point(7, 7), point(7, 3), point(16, 3)],
    [point(7, 13), point(3, 13), point(3, 18)],
    [point(13, 13), point(18, 13), point(18, 19)],
    [point(9, 5), point(12, 5), point(12, 9)],
    [point(3, 16), point(1, 16)],
    [point(16, 8), point(19, 8)],
    [point(4, 7), point(4, 3), point(7, 3)],
    [point(12, 8), point(16, 8)],
    [point(18, 16), point(22, 16)],
    [point(3, 16), point(10, 16), point(10, 13)],
    [point(4, 7), point(4, 9), point(6, 9), point(6, 7)],
    [point(7, 9), point(9, 9), point(9, 11), point(7, 11)],
    [point(14, 13), point(14, 15), point(16, 15), point(16, 13)],
    [point(18, 14), point(16, 14), point(16, 16), point(18, 16)],
    [point(19, 20), point(17, 20), point(17, 22), point(19, 22)],
    [point(20, 23), point(20, 21), point(22, 21), point(22, 23)],
    [point(10, 5), point(10, 9), point(12, 9)],
    [point(13, 19), point(13, 23), point(19, 23)],
  ],
  sealedCells: [
    point(5, 7), point(7, 10), point(15, 13),
    point(18, 15), point(19, 21), point(21, 23),
  ],
  playerStart: point(1, 1),
  exit: point(23, 23),
  chaserStart: point(11, 13),
  chaserStartHeading: point(-1, 0),
  patrol: [point(7, 13), point(4, 5), point(16, 5), point(14, 8), point(22, 11), point(20, 16), point(18, 13), point(10, 16), point(19, 19)],
  hideSpots: [
    { id: "isolation-decon-cabinet", approach: point(12, 9), concealed: point(12, 9.35), facing: point(0, -1) },
    { id: "isolation-morgue-locker", approach: point(1, 16), concealed: point(0.65, 16), facing: point(1, 0) },
    { id: "isolation-oxygen-store", approach: point(19, 8), concealed: point(19.35, 8), facing: point(-1, 0) },
  ],
  visionOnlyBlockers: [point(8, 1), point(13, 3), point(18, 13), point(21, 11), point(4, 5), point(14, 8), point(20, 16), point(7, 16)],
});

const level6 = authoredLevel({
  id: "fire-station-engine-bay",
  routes: [
    [point(12, 23), point(12, 18), point(5, 18), point(5, 12), point(10, 12), point(10, 6), point(4, 6), point(4, 1), point(12, 1)],
    [point(12, 23), point(19, 23), point(19, 17), point(14, 17), point(14, 11), point(21, 11), point(21, 5), point(12, 5), point(12, 1)],
    [point(5, 12), point(5, 9), point(14, 9), point(14, 11)],
    [point(12, 18), point(19, 18)],
    [point(10, 6), point(10, 3)],
    [point(19, 20), point(22, 20)],
    [point(21, 8), point(23, 8)],
    [point(10, 12), point(14, 12)],
    [point(12, 20), point(19, 20)],
    [point(21, 8), point(18, 8), point(18, 11)],
    [point(12, 22), point(10, 22), point(10, 20), point(12, 20)],
    [point(14, 16), point(12, 16), point(12, 14), point(14, 14)],
    [point(17, 11), point(17, 13), point(19, 13), point(19, 11)],
    [point(21, 10), point(23, 10), point(23, 8), point(21, 8)],
    [point(18, 5), point(18, 3), point(16, 3), point(16, 5)],
    [point(12, 4), point(14, 4), point(14, 2), point(12, 2)],
  ],
  playerStart: point(12, 23),
  exit: point(12, 1),
  chaserStart: point(21, 7),
  chaserStartHeading: point(0, 1),
  patrol: [point(21, 11), point(18, 8), point(14, 12), point(5, 9), point(5, 18), point(12, 20), point(19, 18), point(12, 5)],
  hideSpots: [
    { id: "fire-turnout-locker", approach: point(10, 3), concealed: point(9.65, 3), facing: point(1, 0) },
    { id: "fire-hose-cabinet", approach: point(22, 20), concealed: point(22.35, 20), facing: point(-1, 0) },
    { id: "fire-breathing-gear", approach: point(23, 8), concealed: point(23.35, 8), facing: point(-1, 0) },
  ],
  visionOnlyBlockers: [point(8, 9), point(16, 18), point(21, 7), point(12, 12), point(15, 20), point(18, 9)],
});

const level7 = authoredLevel({
  id: "fire-station-training-tower",
  routes: [
    [point(2, 22), point(2, 2), point(22, 2), point(22, 22), point(6, 22), point(6, 6), point(18, 6), point(18, 18), point(10, 18), point(10, 10), point(14, 10), point(14, 14)],
    [point(2, 14), point(6, 14)],
    [point(10, 6), point(10, 2)],
    [point(18, 12), point(22, 12)],
    [point(10, 14), point(7, 14)],
    [point(14, 10), point(14, 7)],
    [point(2, 18), point(6, 18)],
    [point(6, 10), point(10, 10)],
    [point(14, 14), point(18, 14)],
    [point(18, 10), point(22, 10)],
    [point(4, 18), point(4, 20), point(6, 20), point(6, 18)],
    [point(6, 17), point(4, 17), point(4, 15), point(6, 15)],
    [point(10, 13), point(12, 13), point(12, 11), point(10, 11)],
    [point(14, 13), point(16, 13), point(16, 11), point(14, 11)],
    [point(2, 18), point(4, 18), point(4, 16), point(2, 16)],
    [point(4, 14), point(4, 12), point(6, 12), point(6, 14)],
  ],
  sealedCells: [
    point(5, 18), point(6, 16), point(10, 12),
    point(14, 12), point(2, 17), point(5, 14),
  ],
  playerStart: point(2, 22),
  exit: point(14, 14),
  chaserStart: point(10, 11),
  chaserStartHeading: point(0, 1),
  patrol: [point(9, 14), point(8, 10), point(6, 18), point(18, 18), point(18, 14), point(20, 10), point(18, 6), point(14, 10)],
  hideSpots: [
    { id: "training-rescue-cage", approach: point(7, 14), concealed: point(7, 14.35), facing: point(0, -1) },
    { id: "training-mask-locker", approach: point(14, 7), concealed: point(13.65, 7), facing: point(1, 0) },
    { id: "training-landing-cabinet", approach: point(10, 2), concealed: point(10, 1.65), facing: point(0, 1) },
  ],
  visionOnlyBlockers: [point(2, 9), point(15, 6), point(18, 15), point(13, 10), point(4, 18), point(8, 10), point(16, 14), point(20, 10)],
});

const level8 = authoredLevel({
  id: "factory-assembly-nightshift",
  routes: [
    [point(1, 3), point(6, 3), point(6, 9), point(12, 9), point(12, 4), point(19, 4), point(19, 11), point(23, 11), point(23, 21)],
    [point(1, 3), point(1, 15), point(7, 15), point(7, 21), point(14, 21), point(14, 15), point(23, 15)],
    [point(6, 9), point(6, 12), point(14, 12), point(14, 15)],
    [point(12, 9), point(18, 9), point(18, 15)],
    [point(7, 18), point(3, 18)],
    [point(19, 7), point(22, 7)],
    [point(14, 21), point(17, 21)],
    [point(1, 9), point(6, 9)],
    [point(14, 12), point(18, 12)],
    [point(7, 18), point(14, 18)],
    [point(22, 7), point(23, 7), point(23, 11)],
    [point(3, 3), point(3, 5), point(5, 5), point(5, 3)],
    [point(6, 5), point(8, 5), point(8, 7), point(6, 7)],
    [point(8, 9), point(8, 7), point(10, 7), point(10, 9)],
    [point(20, 11), point(20, 13), point(22, 13), point(22, 11)],
    [point(23, 15), point(21, 15), point(21, 17), point(23, 17)],
    [point(18, 15), point(18, 18), point(21, 18), point(21, 20), point(23, 20)],
  ],
  sealedCells: [point(4, 3), point(6, 6), point(9, 9), point(21, 11), point(23, 16)],
  playerStart: point(1, 3),
  exit: point(23, 21),
  chaserStart: point(18, 9),
  chaserStartHeading: point(-1, 0),
  patrol: [point(14, 9), point(6, 9), point(3, 9), point(7, 15), point(10, 18), point(14, 15), point(16, 12), point(19, 11), point(23, 7), point(18, 9)],
  hideSpots: [
    { id: "assembly-tool-crate", approach: point(3, 15), concealed: point(3, 14.65), facing: point(0, 1) },
    { id: "assembly-control-cabinet", approach: point(22, 7), concealed: point(22, 6.65), facing: point(0, 1) },
    { id: "assembly-parts-locker", approach: point(17, 21), concealed: point(17.35, 21), facing: point(-1, 0) },
  ],
  visionOnlyBlockers: [point(5, 15), point(15, 9), point(20, 15), point(3, 9), point(16, 12), point(10, 18), point(23, 9)],
});

const level9 = authoredLevel({
  id: "factory-turbine-hall",
  routes: [
    [point(23, 2), point(17, 2), point(17, 7), point(22, 7), point(22, 13), point(16, 13), point(16, 19), point(22, 19), point(22, 23), point(12, 23)],
    [point(23, 2), point(10, 2), point(10, 6), point(4, 6), point(4, 12), point(10, 12), point(10, 17), point(4, 17), point(4, 23), point(12, 23)],
    [point(10, 6), point(17, 6)],
    [point(10, 12), point(16, 12)],
    [point(10, 17), point(16, 17)],
    [point(4, 9), point(1, 9)],
    [point(16, 15), point(19, 15)],
    [point(4, 20), point(1, 20)],
    [point(10, 4), point(17, 4)],
    [point(16, 12), point(16, 10), point(22, 10)],
    [point(4, 9), point(10, 9), point(10, 12)],
    [point(4, 20), point(10, 20), point(10, 17)],
    [point(19, 15), point(22, 15)],
    [point(19, 7), point(19, 9), point(21, 9), point(21, 7)],
    [point(19, 19), point(19, 17), point(21, 17), point(21, 19)],
    [point(16, 23), point(16, 21), point(18, 21), point(18, 23)],
    [point(10, 14), point(12, 14), point(12, 16), point(10, 16)],
    [point(6, 17), point(6, 16), point(8, 16), point(8, 17)],
    [point(7, 23), point(7, 22), point(9, 22), point(9, 23)],
  ],
  sealedCells: [
    point(20, 7), point(20, 19), point(17, 23),
    point(10, 15), point(7, 17), point(8, 23),
  ],
  playerStart: point(23, 2),
  exit: point(12, 23),
  chaserStart: point(19, 7),
  chaserStartHeading: point(-1, 0),
  patrol: [point(17, 5), point(13, 4), point(19, 10), point(16, 12), point(22, 15), point(16, 19), point(7, 20), point(10, 17), point(7, 9), point(4, 12)],
  hideSpots: [
    { id: "turbine-breaker-cabinet", approach: point(1, 9), concealed: point(0.65, 9), facing: point(1, 0) },
    { id: "turbine-service-locker", approach: point(19, 15), concealed: point(19, 14.65), facing: point(0, 1) },
    { id: "turbine-oil-store", approach: point(1, 20), concealed: point(0.65, 20), facing: point(1, 0) },
  ],
  visionOnlyBlockers: [point(13, 2), point(13, 12), point(13, 17), point(19, 19), point(13, 4), point(19, 10), point(7, 9), point(7, 20), point(21, 15)],
});

const level10 = authoredLevel({
  id: "factory-foundry-final-run",
  routes: [
    [point(1, 23), point(1, 18), point(6, 18), point(6, 22), point(12, 22), point(12, 16), point(18, 16), point(18, 21), point(23, 21), point(23, 1)],
    [point(1, 23), point(1, 10), point(5, 10), point(5, 4), point(11, 4), point(11, 9), point(17, 9), point(17, 4), point(23, 4)],
    [point(6, 18), point(6, 13), point(12, 13), point(12, 16)],
    [point(11, 9), point(11, 13)],
    [point(17, 9), point(21, 9), point(21, 16), point(18, 16)],
    [point(5, 7), point(2, 7)],
    [point(12, 19), point(15, 19)],
    [point(21, 12), point(23, 12)],
    [point(17, 6), point(14, 6)],
    [point(1, 21), point(6, 21)],
    [point(6, 15), point(12, 15), point(12, 16)],
    [point(5, 7), point(11, 7)],
    [point(17, 6), point(23, 6)],
    [point(15, 19), point(18, 19)],
    [point(2, 21), point(2, 23), point(4, 23), point(4, 21)],
    [point(6, 18), point(8, 18), point(8, 16), point(6, 16)],
    [point(7, 13), point(7, 11), point(9, 11), point(9, 13)],
    [point(11, 12), point(13, 12), point(13, 10), point(11, 10)],
    [point(13, 9), point(13, 7), point(15, 7), point(15, 9)],
    [point(20, 6), point(20, 8), point(22, 8), point(22, 6)],
    [point(23, 4), point(21, 4), point(21, 2), point(23, 2)],
  ],
  sealedCells: [
    point(3, 21), point(6, 17), point(8, 13), point(11, 11),
    point(14, 9), point(21, 6), point(23, 3),
  ],
  playerStart: point(1, 23),
  exit: point(23, 1),
  chaserStart: point(6, 14),
  chaserStartHeading: point(1, 0),
  patrol: [point(6, 14), point(9, 15), point(4, 21), point(6, 18), point(12, 16), point(18, 19), point(21, 16), point(20, 6), point(17, 9), point(8, 7), point(11, 4)],
  hideSpots: [
    { id: "foundry-slag-shield", approach: point(2, 7), concealed: point(1.65, 7), facing: point(1, 0) },
    { id: "foundry-maintenance-locker", approach: point(15, 19), concealed: point(15, 18.65), facing: point(0, 1) },
    { id: "foundry-coolant-cabinet", approach: point(23, 12), concealed: point(23.35, 12), facing: point(-1, 0) },
    { id: "foundry-control-bay", approach: point(14, 6), concealed: point(13.65, 6), facing: point(1, 0) },
  ],
  visionOnlyBlockers: [point(1, 14), point(9, 13), point(18, 9), point(21, 14), point(23, 8), point(4, 21), point(9, 15), point(8, 7), point(20, 6), point(17, 19)],
});

const rawLevels: readonly [LevelDefinition, Omit<CampaignMetadata, "levelNumber">][] = [
  [createDefaultLevel(), {
    name: "暮色放学路",
    subtitle: "从教学楼穿过封锁操场",
    theme: "campus",
    themeLabel: "校园",
    difficulty: 1,
    difficultyLabel: "入门",
    briefing: "利用教学楼转角与储物柜摆脱第一次追捕，抵达校门。",
    palette: { floor: "#6f6759", wall: "#d6c4a1", trim: "#31556d", accent: "#e9ad3d", emissive: "#ffd782", fog: "#607484", sky: "#2f4555" },
    atmosphere: { mood: "after-school-dusk", lighting: "long-window-shadows", weather: "humid-overcast", ambience: "campus-evening", score: "first-bell-pursuit", propSet: "campus-classic" },
    landmarks: ["教学楼长廊", "篮球场", "门卫岗亭"],
  }],
  [level2, {
    name: "封馆图书楼",
    subtitle: "穿过书库与静音阅览区",
    theme: "campus",
    themeLabel: "校园",
    difficulty: 1,
    difficultyLabel: "入门+",
    briefing: "高书架会切断双方视野，选择阅览区或档案室路线绕行。",
    palette: { floor: "#5b4434", wall: "#bca98c", trim: "#263a43", accent: "#8eb6a1", emissive: "#e7cf8a", fog: "#4a5354", sky: "#202c31" },
    atmosphere: { mood: "locked-library", lighting: "dusty-reading-lamps", weather: "still-night", ambience: "library-hum", score: "shelved-footsteps", propSet: "campus-library" },
    landmarks: ["双层书库", "借阅台", "地图档案柜"],
  }],
  [level3, {
    name: "夜间实验翼",
    subtitle: "警报灯下的理化实验楼",
    theme: "campus",
    themeLabel: "校园",
    difficulty: 2,
    difficultyLabel: "普通",
    briefing: "实验室玻璃形成长视线，借助准备间和设备柜制造断点。",
    palette: { floor: "#47565c", wall: "#b9c8c4", trim: "#263b42", accent: "#43c0b3", emissive: "#f0695f", fog: "#46606a", sky: "#172b34" },
    atmosphere: { mood: "alarm-lit-laboratory", lighting: "cyan-fluorescent-red-alarm", weather: "electrical-storm", ambience: "lab-ventilation", score: "volatile-compounds", propSet: "campus-science" },
    landmarks: ["化学实验室", "标本准备间", "连廊温室"],
  }],
  [level4, {
    name: "午夜门诊",
    subtitle: "停诊后的急诊与药房通道",
    theme: "hospital",
    themeLabel: "医院",
    difficulty: 2,
    difficultyLabel: "普通+",
    briefing: "门诊环廊有两条主路线，布帘与推床提供短暂的视觉切断。",
    palette: { floor: "#71827e", wall: "#d9e1d8", trim: "#47726f", accent: "#62bda9", emissive: "#a9e6d1", fog: "#879c98", sky: "#344b52" },
    atmosphere: { mood: "afterhours-clinic", lighting: "cold-emergency-panels", weather: "rain-on-glass", ambience: "hospital-night", score: "pulse-in-the-corridor", propSet: "hospital-outpatient" },
    landmarks: ["急诊分诊台", "住院药房", "输液大厅"],
  }],
  [level5, {
    name: "隔离层",
    subtitle: "负压病区地下连廊",
    theme: "hospital",
    themeLabel: "医院",
    difficulty: 3,
    difficultyLabel: "困难",
    briefing: "隔离门把空间切成连续短廊，必须连续判断下一处藏身点。",
    palette: { floor: "#394a4d", wall: "#aebdc0", trim: "#5b6e70", accent: "#e1c654", emissive: "#ee6659", fog: "#66787a", sky: "#26383d" },
    atmosphere: { mood: "sealed-isolation", lighting: "failing-negative-pressure", weather: "subterranean", ambience: "isolation-machinery", score: "quarantine-breach", propSet: "hospital-isolation" },
    landmarks: ["消杀舱", "负压病房", "地下运送通道"],
  }],
  [level6, {
    name: "空置车库",
    subtitle: "消防车位与整备间",
    theme: "fire-station",
    themeLabel: "消防站",
    difficulty: 3,
    difficultyLabel: "困难+",
    briefing: "消防车位开阔且危险，沿器材间侧翼移动才能稳定断开视线。",
    palette: { floor: "#4f4b48", wall: "#c2b8aa", trim: "#2b3033", accent: "#c93d31", emissive: "#ffb23f", fog: "#5f5650", sky: "#2d2725" },
    atmosphere: { mood: "empty-engine-bay", lighting: "amber-beacons", weather: "smoky-drizzle", ambience: "station-apparatus", score: "rolling-shutter", propSet: "fire-engine-bay" },
    landmarks: ["消防车库", "战斗服整备墙", "水带维护区"],
  }],
  [level7, {
    name: "烟训塔",
    subtitle: "层层收紧的实战训练塔",
    theme: "fire-station",
    themeLabel: "消防站",
    difficulty: 4,
    difficultyLabel: "专家",
    briefing: "螺旋式回路会反复靠近追捕者，依靠烟幕断视线并及时换层。",
    palette: { floor: "#3d3b39", wall: "#77736d", trim: "#242829", accent: "#e34c2f", emissive: "#ff7e35", fog: "#736b63", sky: "#211f1e" },
    atmosphere: { mood: "smoke-training", lighting: "strobing-fire-simulators", weather: "dense-training-smoke", ambience: "breathing-apparatus", score: "tower-heat", propSet: "fire-training" },
    landmarks: ["烟热训练室", "绳索平台", "狭窄楼梯井"],
  }],
  [level8, {
    name: "停线车间",
    subtitle: "夜班结束后的装配流水线",
    theme: "factory",
    themeLabel: "工厂",
    difficulty: 4,
    difficultyLabel: "专家+",
    briefing: "传送带形成平行追逐通道，控制柜和零件仓是仅有的安全停顿。",
    palette: { floor: "#3f4544", wall: "#7b817c", trim: "#202727", accent: "#d89c30", emissive: "#78d7d1", fog: "#53615e", sky: "#202827" },
    atmosphere: { mood: "silent-assembly-line", lighting: "sodium-cyan-industrial", weather: "oil-mist", ambience: "conveyor-cooldown", score: "shift-change-hunt", propSet: "factory-assembly" },
    landmarks: ["总装线", "机械臂工位", "质检控制室"],
  }],
  [level9, {
    name: "涡轮机厅",
    subtitle: "高噪声动力核心",
    theme: "factory",
    themeLabel: "工厂",
    difficulty: 5,
    difficultyLabel: "噩梦",
    briefing: "巨型机组遮挡瞬息变化，长直通道会让一次误判付出代价。",
    palette: { floor: "#343b3e", wall: "#69747a", trim: "#1d2428", accent: "#de7d2d", emissive: "#54c9ed", fog: "#48565e", sky: "#172127" },
    atmosphere: { mood: "turbine-overload", lighting: "blue-arc-orange-service", weather: "steam-plumes", ambience: "turbine-thrum", score: "rotor-pressure", propSet: "factory-turbine" },
    landmarks: ["主涡轮", "高压管廊", "断路器平台"],
  }],
  [level10, {
    name: "熔炉终逃",
    subtitle: "高温铸造区最终封锁",
    theme: "factory",
    themeLabel: "工厂",
    difficulty: 5,
    difficultyLabel: "终局",
    briefing: "四处藏身点分布在危险环路上，读懂热雾节奏完成最后逃脱。",
    palette: { floor: "#332f2c", wall: "#64584f", trim: "#1d1b1a", accent: "#e94725", emissive: "#ff9a32", fog: "#6f3f2f", sky: "#1f1714" },
    atmosphere: { mood: "foundry-lockdown", lighting: "molten-bounce-emergency-red", weather: "heat-haze-and-sparks", ambience: "foundry-roar", score: "final-pour", propSet: "factory-foundry" },
    landmarks: ["熔炼炉", "浇铸平台", "冷却水环廊"],
  }],
];

export const CAMPAIGN_LEVELS: readonly CampaignLevelDefinition[] = Object.freeze(
  rawLevels.map(([level, metadata], index) => campaignLevel(level, { ...metadata, levelNumber: index + 1 })),
);

export const CAMPAIGN_LEVEL_COUNT = CAMPAIGN_LEVELS.length;

const levelsById = new Map(CAMPAIGN_LEVELS.map((level) => [level.id, level]));

export interface CampaignHideGuidancePolicy {
  /**
   * First-clear teaching may prefer this authored, regression-certified
   * locker instead of presenting the geometrically nearest locker as safe.
   */
  readonly tutorialHideSpotId: string | null;
}

const TUTORIAL_HIDE_SPOT_IDS = Object.freeze([
  "locker-north",
  "library-map-case",
  "science-chemical-cabinet",
] as const);

export function getCampaignLevelById(id: string): CampaignLevelDefinition | undefined {
  return levelsById.get(id);
}

/** Zero-based lookup, matching array and carousel indexes. */
export function getCampaignLevelByIndex(index: number): CampaignLevelDefinition | undefined {
  return Number.isInteger(index) ? CAMPAIGN_LEVELS[index] : undefined;
}

/** One-based lookup, matching the level number shown in the UI. */
export function getCampaignLevelByNumber(levelNumber: number): CampaignLevelDefinition | undefined {
  return getCampaignLevelByIndex(levelNumber - 1);
}

export function getCampaignLevelsByTheme(theme: CampaignTheme): readonly CampaignLevelDefinition[] {
  return CAMPAIGN_LEVELS.filter((level) => level.campaign.theme === theme);
}

export function getCampaignHideGuidancePolicy(level: CampaignLevelDefinition): CampaignHideGuidancePolicy {
  const tutorialHideSpotId = TUTORIAL_HIDE_SPOT_IDS[level.campaign.levelNumber - 1] ?? null;
  if (tutorialHideSpotId && !level.hideSpots.some((spot) => spot.id === tutorialHideSpotId)) {
    throw new Error(`${level.id} is missing configured tutorial hide spot ${tutorialHideSpotId}`);
  }
  return Object.freeze({ tutorialHideSpotId });
}

/**
 * Applies the requested 20% pace baseline to every chapter, then introduces a
 * restrained, continuous pursuit curve. The player stays consistent across
 * the campaign; later chapters tighten confirmation, vision, spawn lead and
 * evidence-backed search instead of changing the controls underneath them.
 */
export function getCampaignGameplayConfig(level: CampaignLevelDefinition): Partial<GameConfig> {
  const index = level.campaign.levelNumber - 1;
  const chaserMultipliers = [1, 1, 1.02, 1.02, 1.04, 1.04, 1.06, 1.06, 1.08, 1.1] as const;
  const spawnDelays = [1.5, 1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4] as const;
  const visionRanges = [7, 7, 7.4, 7.6, 7.8, 8, 8.2, 8.4, 8.6, 9] as const;
  // L3's glass-wing sightline needs the original two-tick confirmation to
  // preserve its authored interception. Later values continue tightening.
  const suspiciousSeconds = [0.3, 0.28, 0.2, 0.2, 0.19, 0.18, 0.17, 0.16, 0.15, 0.14] as const;
  const searchSeconds = [4.5, 4.7, 4.9, 5.2, 5.5, 5.8, 6.1, 6.5, 6.8, 7.2] as const;
  const searchWaypointSeconds = [0.8, 0.78, 0.76, 0.74, 0.72, 0.7, 0.68, 0.66, 0.64, 0.62] as const;
  const searchHideCheckBudgets = [0, 0, 0, 1, 1, 1, 1, 2, 2, 2] as const;
  const searchHideRadiusCells = [2, 2.2, 2.4, 2.6, 3, 3.4, 3.8, 4.2, 4.8, 5.4] as const;
  const checkHideSeconds = [2.5, 2.46, 2.42, 2.38, 2.34, 2.3, 2.26, 2.22, 2.16, 2.1] as const;
  const hearingRanges = [6, 6.2, 6.4, 6.6, 6.8, 7, 7.3, 7.6, 7.9, 8.2] as const;
  const soundUncertaintyCells = [1.5, 1.45, 1.4, 1.35, 1.3, 1.25, 1.2, 1.1, 1, 0.9] as const;
  return Object.freeze({
    // Campaign perception runs at 20 Hz so sub-second confirmation values
    // remain meaningful rather than collapsing into 100 ms quantization.
    aiTickSeconds: 0.05,
    playerSpeed: DEFAULT_GAME_CONFIG.playerSpeed,
    chaserSpeed: Number((DEFAULT_GAME_CONFIG.chaserSpeed * chaserMultipliers[index]).toFixed(3)),
    spawnDelaySeconds: spawnDelays[index],
    suspiciousSeconds: suspiciousSeconds[index],
    searchSeconds: searchSeconds[index],
    searchWaypointSeconds: searchWaypointSeconds[index],
    searchHideCheckBudget: searchHideCheckBudgets[index],
    searchHideRadiusCells: searchHideRadiusCells[index],
    checkHideSeconds: checkHideSeconds[index],
    hearingRange: hearingRanges[index],
    soundUncertaintyCells: soundUncertaintyCells[index],
    visionRange: visionRanges[index],
  });
}
