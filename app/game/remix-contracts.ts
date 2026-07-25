import { CAMPAIGN_LEVELS, type CampaignLevelDefinition } from "./campaign.ts";
import type { HideSpotDefinition, LevelDefinition, Point } from "./contracts.ts";
import { createLevel } from "./level.ts";
import { distanceBetween, findPath, isWalkable, neighbors, pointKey } from "./navigation.ts";

export const REMIX_CONTRACT_VERSION = 1;
export const CERTIFIED_VARIANTS_PER_LEVEL = 3;
// Mission v2 moves the objective chain onto audited detour anchors and adds
// real interaction commitments. Keep it storage-isolated from faster v1
// ghosts and records while the replay parser remains backward compatible.
export const CERTIFIED_REMIX_MISSION_VERSION = "mission-v2";
export const CERTIFIED_REMIX_DEPTH_CONTRACT = Object.freeze({
  minimumToggledPassages: 2,
  maximumToggledPassages: 4,
  maximumSourceRouteEdgeOverlap: 0.7,
  minimumNovelRoutesPerLevel: 2,
  minimumRouteLengthRatio: 0.78,
  maximumRouteLengthRatio: 1.5,
});

export type RemixRulesetLane = "standard" | "assisted";

export interface CertifiedRemixContract {
  readonly version: typeof REMIX_CONTRACT_VERSION;
  readonly id: string;
  readonly levelId: string;
  readonly variantIndex: 0 | 1 | 2;
  readonly seed: number;
  readonly patrolGroup: readonly Point[];
  readonly mechanicPlacementGroup: readonly Point[];
  /** Optional authored connector cells kept open in this variant. */
  readonly openPassageCells: readonly Point[];
  /** Optional authored connector cells sealed in this variant. */
  readonly closedPassageCells: readonly Point[];
  readonly hideSupplyIds: readonly string[];
}

export interface ResolvedRemixContract {
  /** The exact original object when contract is null. */
  readonly level: LevelDefinition;
  readonly contract: CertifiedRemixContract | null;
  readonly mechanicPlacementGroup: readonly Point[];
  readonly runIdentity: string | null;
}

export interface RemixContractAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly reachableAnchorCount: number;
  readonly toggledPassageCount: number;
  readonly sourceShortestPathEdgeCount: number;
  readonly remixedShortestPathEdgeCount: number;
  readonly sharedShortestPathEdgeCount: number;
  /** Fraction of the source route's edges retained by the remixed route. */
  readonly sourceRouteEdgeOverlap: number;
  readonly routeLengthRatio: number;
}

export interface RemixContractSetAudit {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly novelRouteCount: number;
  readonly distinctRouteCount: number;
  readonly distinctFirstEncounterCount: number;
  readonly distinctMissionPlacementCount: number;
  readonly distinctHideSupplyCount: number;
}

const remixSeeds = (
  first: number,
  second: number,
  third: number,
): readonly [number, number, number] => Object.freeze([first, second, third]);

/**
 * Explicit whitelist: arbitrary user seeds are never promoted to certified
 * runs. Values stay stable across builds so records and ghosts remain valid.
 */
export const CERTIFIED_REMIX_SEEDS: Readonly<Record<string, readonly [number, number, number]>> = Object.freeze({
  "school-maze-v1": remixSeeds(0x11c0a101, 0x11c0a202, 0x11c0a303),
  "campus-library-lockdown": remixSeeds(0x12c0b101, 0x12c0b202, 0x12c0b303),
  "campus-science-wing": remixSeeds(0x13c0c101, 0x13c0c202, 0x13c0c303),
  "hospital-outpatient-afterhours": remixSeeds(0x24d0a101, 0x24d0a202, 0x24d0a303),
  "hospital-isolation-basement": remixSeeds(0x25d0b101, 0x25d0b202, 0x25d0b303),
  "fire-station-engine-bay": remixSeeds(0x36e0a101, 0x36e0a202, 0x36e0a303),
  "fire-station-training-tower": remixSeeds(0x37e0b101, 0x37e0b202, 0x37e0b303),
  "factory-assembly-nightshift": remixSeeds(0x48f0a101, 0x48f0a202, 0x48f0a303),
  "factory-turbine-hall": remixSeeds(0x49f0b101, 0x49f0b202, 0x49f0b303),
  "factory-foundry-final-run": remixSeeds(0x4af0c101, 0x4af0c202, 0x4af0c303),
});

type CertifiedPassageSwap = Readonly<{
  open: Point;
  closed: Point;
}>;

const passageSwaps = (
  first: CertifiedPassageSwap,
  second: CertifiedPassageSwap,
  third: CertifiedPassageSwap,
): readonly [CertifiedPassageSwap, CertifiedPassageSwap, CertifiedPassageSwap] => Object.freeze([
  Object.freeze({ open: Object.freeze(first.open), closed: Object.freeze(first.closed) }),
  Object.freeze({ open: Object.freeze(second.open), closed: Object.freeze(second.closed) }),
  Object.freeze({ open: Object.freeze(third.open), closed: Object.freeze(third.closed) }),
]);

/**
 * Authored from an exhaustive offline search, then committed as certification
 * data so importing the game never performs a combinatorial topology search.
 * Every swap opens a wall used by the new shortest route and seals an edge of
 * the source shortest route. `auditCertifiedRemixContractSet` deliberately
 * fails if future campaign edits invalidate any of those facts.
 */
const CERTIFIED_REMIX_PASSAGE_SWAPS: Readonly<
  Record<string, readonly [CertifiedPassageSwap, CertifiedPassageSwap, CertifiedPassageSwap]>
> = Object.freeze({
  "school-maze-v1": passageSwaps(
    { open: { x: 12, y: 12 }, closed: { x: 21, y: 17 } },
    { open: { x: 22, y: 18 }, closed: { x: 6, y: 1 } },
    { open: { x: 22, y: 21 }, closed: { x: 7, y: 3 } },
  ),
  "campus-library-lockdown": passageSwaps(
    { open: { x: 4, y: 22 }, closed: { x: 18, y: 9 } },
    { open: { x: 2, y: 18 }, closed: { x: 8, y: 10 } },
    { open: { x: 21, y: 7 }, closed: { x: 5, y: 14 } },
  ),
  "campus-science-wing": passageSwaps(
    { open: { x: 22, y: 21 }, closed: { x: 2, y: 5 } },
    { open: { x: 20, y: 23 }, closed: { x: 21, y: 22 } },
    { open: { x: 3, y: 8 }, closed: { x: 7, y: 16 } },
  ),
  "hospital-outpatient-afterhours": passageSwaps(
    { open: { x: 15, y: 14 }, closed: { x: 22, y: 4 } },
    { open: { x: 12, y: 14 }, closed: { x: 14, y: 10 } },
    { open: { x: 12, y: 16 }, closed: { x: 5, y: 10 } },
  ),
  "hospital-isolation-basement": passageSwaps(
    { open: { x: 19, y: 21 }, closed: { x: 9, y: 11 } },
    { open: { x: 21, y: 23 }, closed: { x: 17, y: 22 } },
    { open: { x: 16, y: 12 }, closed: { x: 19, y: 22 } },
  ),
  "fire-station-engine-bay": passageSwaps(
    { open: { x: 14, y: 19 }, closed: { x: 16, y: 5 } },
    { open: { x: 12, y: 13 }, closed: { x: 18, y: 11 } },
    { open: { x: 10, y: 19 }, closed: { x: 14, y: 17 } },
  ),
  "fire-station-training-tower": passageSwaps(
    { open: { x: 6, y: 16 }, closed: { x: 16, y: 12 } },
    { open: { x: 14, y: 12 }, closed: { x: 6, y: 15 } },
    { open: { x: 17, y: 12 }, closed: { x: 4, y: 16 } },
  ),
  "factory-assembly-nightshift": passageSwaps(
    { open: { x: 23, y: 16 }, closed: { x: 5, y: 5 } },
    { open: { x: 21, y: 14 }, closed: { x: 23, y: 19 } },
    { open: { x: 17, y: 16 }, closed: { x: 18, y: 15 } },
  ),
  "factory-turbine-hall": passageSwaps(
    { open: { x: 10, y: 15 }, closed: { x: 9, y: 20 } },
    { open: { x: 20, y: 16 }, closed: { x: 17, y: 10 } },
    { open: { x: 9, y: 21 }, closed: { x: 17, y: 7 } },
  ),
  "factory-foundry-final-run": passageSwaps(
    { open: { x: 23, y: 3 }, closed: { x: 8, y: 17 } },
    { open: { x: 18, y: 5 }, closed: { x: 12, y: 13 } },
    { open: { x: 14, y: 9 }, closed: { x: 4, y: 23 } },
  ),
});

function stableHash(value: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function freezePoint(value: Point): Point {
  return Object.freeze({ ...value });
}

function seededOrder<T>(
  values: readonly T[],
  seed: number,
  key: (value: T) => string,
): readonly T[] {
  return Object.freeze([...values].sort((left, right) => (
    stableHash(key(left), seed) - stableHash(key(right), seed)
    || key(left).localeCompare(key(right))
  )));
}

function levelWithPassages(
  level: LevelDefinition,
  openCells: readonly Point[],
  closedCells: readonly Point[],
  patrol: readonly Point[] = level.patrol,
  hideSpots: readonly HideSpotDefinition[] = level.hideSpots,
): LevelDefinition {
  const walkable = level.walkable.map((row) => [...row]);
  for (const point of openCells) {
    if (walkable[Math.round(point.y)]?.[Math.round(point.x)] !== undefined) {
      walkable[Math.round(point.y)][Math.round(point.x)] = true;
    }
  }
  for (const point of closedCells) {
    if (walkable[Math.round(point.y)]?.[Math.round(point.x)] !== undefined) {
      walkable[Math.round(point.y)][Math.round(point.x)] = false;
    }
  }
  return {
    ...level,
    walkable,
    patrol,
    hideSpots,
  };
}

function hideSupplyForVariant(
  level: LevelDefinition,
  variantIndex: 0 | 1 | 2,
): readonly string[] {
  const ids = level.hideSpots.map((spot) => spot.id);
  if (ids.length === 0) throw new Error(`${level.id} has no hide supply`);
  if (ids.length === 1) return Object.freeze(ids);
  // A two-hide level has only two distinct one-removed subsets. Keep both in
  // the third layout so all three variants still present a different resource
  // decision without inventing or renaming authored lockers.
  if (ids.length === 2 && variantIndex === 2) return Object.freeze(ids);
  const removedIndex = variantIndex % ids.length;
  return Object.freeze(ids.filter((_, index) => index !== removedIndex));
}

function patrolForVariant(
  level: LevelDefinition,
  seed: number,
  variantIndex: 0 | 1 | 2,
  reservedFirstEncounterKeys: ReadonlySet<string>,
): readonly Point[] {
  const ordered = seededOrder(level.patrol, seed, pointKey).map(freezePoint);
  const shaped = variantIndex === 0
    ? [...ordered]
    : variantIndex === 1
      ? [...ordered].reverse()
      : ordered.length <= 1
        ? [...ordered]
        : [
            ...ordered.slice(Math.max(1, Math.floor(ordered.length / 2))),
            ...ordered.slice(0, Math.max(1, Math.floor(ordered.length / 2))),
          ];
  const first = shaped.find((candidate) => !reservedFirstEncounterKeys.has(pointKey(candidate)));
  if (!first) throw new Error(`${level.id} cannot author three distinct first encounters`);
  return Object.freeze([
    first,
    ...shaped.filter((candidate) => pointKey(candidate) !== pointKey(first)),
  ]);
}

function mechanicPlacements(
  level: LevelDefinition,
  seed: number,
  reservedFingerprints: ReadonlySet<string>,
): readonly Point[] {
  const protectedAnchors = [
    level.playerStart,
    level.exit,
    ...level.hideSpots.map((spot) => spot.approach),
    ...level.hideSpots.flatMap((spot) => spot.alternateExit ? [spot.alternateExit] : []),
  ];
  const junctions: Point[] = [];
  const fallback: Point[] = [];
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const point = { x, y };
      if (!isWalkable(level, point)) continue;
      if (protectedAnchors.some((anchor) => distanceBetween(point, anchor) < 2)) continue;
      if (!findPath(level, level.playerStart, point).length) continue;
      if (neighbors(level, point).length >= 3) junctions.push(point);
      else fallback.push(point);
    }
  }
  const candidates = junctions.length >= 2 ? junctions : [...junctions, ...fallback];
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const attemptSeed = attempt === 0
      ? seed
      : stableHash(`${level.id}:mission-placement:${attempt}`, seed);
    const ordered = seededOrder(candidates, attemptSeed, pointKey);
    const selected: Point[] = [];
    for (const candidate of ordered) {
      if (selected.every((point) => findPath(level, point, candidate).length >= 4)) {
        selected.push(freezePoint(candidate));
      }
      if (selected.length === 2) break;
    }
    if (selected.length < 2) {
      for (const candidate of ordered) {
        if (selected.some((point) => pointKey(point) === pointKey(candidate))) continue;
        selected.push(freezePoint(candidate));
        if (selected.length === 2) break;
      }
    }
    if (selected.length < 2) break;
    const fingerprint = selected.map(pointKey).join("|");
    if (!reservedFingerprints.has(fingerprint)) {
      return Object.freeze(selected);
    }
  }
  throw new Error(`${level.id} cannot place three distinct certified mission groups`);
}

function freezeContract(value: CertifiedRemixContract): CertifiedRemixContract {
  return Object.freeze({
    ...value,
    patrolGroup: Object.freeze(value.patrolGroup.map(freezePoint)),
    mechanicPlacementGroup: Object.freeze(value.mechanicPlacementGroup.map(freezePoint)),
    openPassageCells: Object.freeze(value.openPassageCells.map(freezePoint)),
    closedPassageCells: Object.freeze(value.closedPassageCells.map(freezePoint)),
    hideSupplyIds: Object.freeze([...value.hideSupplyIds]),
  });
}

function buildContracts(level: CampaignLevelDefinition): readonly CertifiedRemixContract[] {
  const seeds = CERTIFIED_REMIX_SEEDS[level.id];
  if (!seeds) throw new Error(`Missing certified remix seeds for ${level.id}`);
  const passageSwapsForLevel = CERTIFIED_REMIX_PASSAGE_SWAPS[level.id];
  if (!passageSwapsForLevel) throw new Error(`Missing certified remix passages for ${level.id}`);
  const firstEncounterKeys = new Set<string>();
  const missionPlacementFingerprints = new Set<string>();
  const contracts = seeds.map((seed, rawIndex) => {
    const variantIndex = rawIndex as 0 | 1 | 2;
    const passageSwap = passageSwapsForLevel[variantIndex];
    const closedPassageCells = Object.freeze([passageSwap.closed]);
    const openPassageCells = Object.freeze([passageSwap.open]);
    const patrolGroup = patrolForVariant(level, seed, variantIndex, firstEncounterKeys);
    const hideSupplyIds = hideSupplyForVariant(level, variantIndex);
    const preliminary = levelWithPassages(
      level,
      openPassageCells,
      closedPassageCells,
      patrolGroup,
      level.hideSpots.filter((spot) => hideSupplyIds.includes(spot.id)),
    );
    const mechanicPlacementGroup = mechanicPlacements(
      preliminary,
      seed,
      missionPlacementFingerprints,
    );
    const contract = freezeContract({
      version: REMIX_CONTRACT_VERSION,
      id: `${level.id}:certified-${variantIndex + 1}:${seed.toString(16).padStart(8, "0")}`,
      levelId: level.id,
      variantIndex,
      seed,
      patrolGroup,
      mechanicPlacementGroup,
      openPassageCells,
      closedPassageCells,
      hideSupplyIds,
    });
    const audit = auditCertifiedRemixContract(level, contract);
    if (!audit.passed) throw new Error(`Invalid certified remix ${contract.id}: ${audit.failures.join("; ")}`);
    firstEncounterKeys.add(pointKey(contract.patrolGroup[0]));
    missionPlacementFingerprints.add(contract.mechanicPlacementGroup.map(pointKey).join("|"));
    return contract;
  });
  const setAudit = auditCertifiedRemixContractSet(level, contracts);
  if (!setAudit.passed) {
    throw new Error(`Invalid certified remix set ${level.id}: ${setAudit.failures.join("; ")}`);
  }
  return Object.freeze(contracts);
}

const contractCache = new Map<string, readonly CertifiedRemixContract[]>();

export function certifiedRemixContractsForLevel(
  levelOrId: CampaignLevelDefinition | string,
): readonly CertifiedRemixContract[] {
  const level = typeof levelOrId === "string"
    ? CAMPAIGN_LEVELS.find((candidate) => candidate.id === levelOrId)
    : levelOrId;
  if (!level) throw new Error(`Unknown campaign level ${String(levelOrId)}`);
  const cached = contractCache.get(level.id);
  if (cached) return cached;
  const contracts = buildContracts(level);
  contractCache.set(level.id, contracts);
  return contracts;
}

export function certifiedRemixContract(
  levelId: string,
  seed: number,
): CertifiedRemixContract | null {
  if (!Number.isInteger(seed) || seed < 0) return null;
  return certifiedRemixContractsForLevel(levelId)
    .find((contract) => contract.seed === seed)
    ?? null;
}

function immutableRemixedLevel(
  level: LevelDefinition,
  contract: CertifiedRemixContract,
): LevelDefinition {
  const hideById = new Map(level.hideSpots.map((spot) => [spot.id, spot]));
  const hideSpots = contract.hideSupplyIds
    .map((id) => hideById.get(id))
    .filter((spot): spot is HideSpotDefinition => Boolean(spot));
  const remixed = levelWithPassages(
    level,
    contract.openPassageCells,
    contract.closedPassageCells,
    contract.patrolGroup,
    hideSpots,
  );
  createLevel(remixed);
  return Object.freeze({
    ...remixed,
    walkable: Object.freeze(remixed.walkable.map((row) => Object.freeze([...row]))),
    patrol: Object.freeze(remixed.patrol.map(freezePoint)),
    hideSpots: Object.freeze(remixed.hideSpots.map((spot) => Object.freeze({
      ...spot,
      approach: freezePoint(spot.approach),
      concealed: freezePoint(spot.concealed),
      facing: freezePoint(spot.facing),
      alternateExit: spot.alternateExit ? freezePoint(spot.alternateExit) : undefined,
    }))),
  });
}

export function remixRunIdentity(
  contract: CertifiedRemixContract,
  lane: RemixRulesetLane,
  missionVersion = CERTIFIED_REMIX_MISSION_VERSION,
): string {
  if (!/^mission-v\d+$/.test(missionVersion)) {
    throw new Error("Remix mission version is invalid");
  }
  return [
    `remix-v${REMIX_CONTRACT_VERSION}`,
    encodeURIComponent(contract.levelId),
    contract.seed.toString(16).padStart(8, "0"),
    lane,
    missionVersion,
  ].join(":");
}

export function remixReplayLevelId(
  contract: CertifiedRemixContract,
  lane: RemixRulesetLane,
  missionVersion = CERTIFIED_REMIX_MISSION_VERSION,
): string {
  return `${contract.levelId}#${remixRunIdentity(contract, lane, missionVersion)}`;
}

export function remixGhostStorageKey(
  contract: CertifiedRemixContract,
  lane: RemixRulesetLane,
  missionVersion = CERTIFIED_REMIX_MISSION_VERSION,
): string {
  return `chasing.personal-ghost.${remixRunIdentity(contract, lane, missionVersion)}`;
}

export function remixRecordStorageKey(
  contract: CertifiedRemixContract,
  lane: RemixRulesetLane,
  missionVersion = CERTIFIED_REMIX_MISSION_VERSION,
): string {
  return `chasing.personal-record.${remixRunIdentity(contract, lane, missionVersion)}`;
}

/**
 * Null is the compatibility path: no clone, no topology change and no new
 * identity. Existing campaign behavior is therefore untouched until opt-in.
 */
export function resolveCertifiedRemix(
  level: LevelDefinition,
  contract: CertifiedRemixContract | null,
  lane: RemixRulesetLane = "standard",
): ResolvedRemixContract {
  if (!contract) {
    return Object.freeze({
      level,
      contract: null,
      mechanicPlacementGroup: Object.freeze([]),
      runIdentity: null,
    });
  }
  if (contract.levelId !== level.id) throw new Error("Remix contract belongs to another level");
  const whitelisted = certifiedRemixContract(level.id, contract.seed);
  if (!whitelisted || whitelisted.id !== contract.id) throw new Error("Remix contract is not certified");
  const remixed = immutableRemixedLevel(level, contract);
  return Object.freeze({
    level: remixed,
    contract,
    mechanicPlacementGroup: contract.mechanicPlacementGroup,
    runIdentity: remixRunIdentity(contract, lane),
  });
}

export function auditCertifiedRemixContract(
  sourceLevel: LevelDefinition,
  contract: CertifiedRemixContract,
): RemixContractAudit {
  const failures: string[] = [];
  if (contract.version !== REMIX_CONTRACT_VERSION) failures.push("Unsupported remix contract version");
  if (contract.levelId !== sourceLevel.id) failures.push("Contract level id does not match source");
  if (!Number.isInteger(contract.seed) || contract.seed < 0) failures.push("Contract seed is invalid");
  if (contract.patrolGroup.length === 0) failures.push("Patrol group is empty");
  if (contract.mechanicPlacementGroup.length < 2) failures.push("Mechanic placement group needs two anchors");
  if (contract.hideSupplyIds.length === 0) failures.push("Hide supply is empty");
  if (new Set(contract.hideSupplyIds).size !== contract.hideSupplyIds.length) failures.push("Hide supply contains duplicates");
  const knownHideIds = new Set(sourceLevel.hideSpots.map((spot) => spot.id));
  if (contract.hideSupplyIds.some((id) => !knownHideIds.has(id))) failures.push("Hide supply contains an unknown id");
  const openKeys = new Set(contract.openPassageCells.map(pointKey));
  const closedKeys = new Set(contract.closedPassageCells.map(pointKey));
  if (openKeys.size !== contract.openPassageCells.length) failures.push("Open passage cells contain duplicates");
  if (closedKeys.size !== contract.closedPassageCells.length) failures.push("Closed passage cells contain duplicates");
  if ([...openKeys].some((key) => closedKeys.has(key))) failures.push("A passage cannot be open and closed");
  const toggledPassageCount = openKeys.size + closedKeys.size;
  if (
    toggledPassageCount < CERTIFIED_REMIX_DEPTH_CONTRACT.minimumToggledPassages
    || toggledPassageCount > CERTIFIED_REMIX_DEPTH_CONTRACT.maximumToggledPassages
  ) {
    failures.push(
      `Topology must toggle ${CERTIFIED_REMIX_DEPTH_CONTRACT.minimumToggledPassages}`
      + `-${CERTIFIED_REMIX_DEPTH_CONTRACT.maximumToggledPassages} passages`,
    );
  }
  const pointIsInBounds = (point: Point) => (
    Number.isInteger(point.x)
    && Number.isInteger(point.y)
    && point.x >= 0
    && point.y >= 0
    && point.x < sourceLevel.width
    && point.y < sourceLevel.height
  );
  for (const point of contract.openPassageCells) {
    if (!pointIsInBounds(point)) failures.push(`Open passage ${pointKey(point)} is outside the grid`);
    else if (sourceLevel.walkable[point.y][point.x]) {
      failures.push(`Open passage ${pointKey(point)} was already open in the source`);
    }
  }
  for (const point of contract.closedPassageCells) {
    if (!pointIsInBounds(point)) failures.push(`Closed passage ${pointKey(point)} is outside the grid`);
    else if (!isWalkable(sourceLevel, point)) {
      failures.push(`Closed passage ${pointKey(point)} was not navigable in the source`);
    }
  }

  let resolved: LevelDefinition | null = null;
  try {
    resolved = immutableRemixedLevel(sourceLevel, contract);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Remixed level failed validation");
  }
  let reachableAnchorCount = 0;
  const sourceShortestPath = findPath(sourceLevel, sourceLevel.playerStart, sourceLevel.exit);
  const sourceShortestPathKeys = new Set(sourceShortestPath.map(pointKey));
  const sourceEdges = routeEdgeKeys(sourceShortestPath);
  let remixedEdges: ReadonlySet<string> = new Set();
  let sharedShortestPathEdgeCount = 0;
  let sourceRouteEdgeOverlap = 1;
  let routeLengthRatio = 1;
  if (resolved) {
    const anchors = [
      resolved.exit,
      resolved.chaserStart,
      ...resolved.patrol,
      ...resolved.hideSpots.map((spot) => spot.approach),
      ...resolved.hideSpots.flatMap((spot) => spot.alternateExit ? [spot.alternateExit] : []),
      ...contract.mechanicPlacementGroup,
    ];
    for (const anchor of anchors) {
      if (findPath(resolved, resolved.playerStart, anchor).length > 0) reachableAnchorCount += 1;
      else failures.push(`Unreachable remixed anchor ${pointKey(anchor)}`);
    }
    for (const point of contract.mechanicPlacementGroup) {
      if (!isWalkable(resolved, point)) failures.push(`Mechanic placement ${pointKey(point)} is blocked`);
    }
    for (const point of contract.openPassageCells) {
      if (!isWalkable(resolved, point)) failures.push(`Open passage ${pointKey(point)} did not open`);
      else if (neighbors(resolved, point).length < 2) {
        failures.push(`Open passage ${pointKey(point)} does not connect two navigable cells`);
      }
    }
    for (const point of contract.closedPassageCells) {
      if (isWalkable(resolved, point)) failures.push(`Closed passage ${pointKey(point)} did not close`);
    }

    const remixedShortestPath = findPath(resolved, resolved.playerStart, resolved.exit);
    remixedEdges = routeEdgeKeys(remixedShortestPath);
    sharedShortestPathEdgeCount = [...sourceEdges]
      .filter((edge) => remixedEdges.has(edge))
      .length;
    sourceRouteEdgeOverlap = sourceEdges.size > 0
      ? sharedShortestPathEdgeCount / sourceEdges.size
      : 1;
    routeLengthRatio = sourceEdges.size > 0
      ? remixedEdges.size / sourceEdges.size
      : 1;
    if (!contract.openPassageCells.some((point) => (
      remixedShortestPath.some((step) => pointKey(step) === pointKey(point))
    ))) {
      failures.push("Remixed shortest route does not use an opened passage");
    }
    if (!contract.closedPassageCells.some((point) => sourceShortestPathKeys.has(pointKey(point)))) {
      failures.push("No closed passage alters the source shortest route");
    }
    if (
      routeLengthRatio < CERTIFIED_REMIX_DEPTH_CONTRACT.minimumRouteLengthRatio
      || routeLengthRatio > CERTIFIED_REMIX_DEPTH_CONTRACT.maximumRouteLengthRatio
    ) {
      failures.push(
        `Remixed route length ratio ${routeLengthRatio.toFixed(3)} is outside`
        + ` ${CERTIFIED_REMIX_DEPTH_CONTRACT.minimumRouteLengthRatio}`
        + `-${CERTIFIED_REMIX_DEPTH_CONTRACT.maximumRouteLengthRatio}`,
      );
    }
  }
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    reachableAnchorCount,
    toggledPassageCount,
    sourceShortestPathEdgeCount: sourceEdges.size,
    remixedShortestPathEdgeCount: remixedEdges.size,
    sharedShortestPathEdgeCount,
    sourceRouteEdgeOverlap,
    routeLengthRatio,
  });
}

function routeEdgeKeys(route: readonly Point[]): ReadonlySet<string> {
  const edges = new Set<string>();
  for (let index = 1; index < route.length; index += 1) {
    const endpoints = [pointKey(route[index - 1]), pointKey(route[index])].sort();
    edges.add(`${endpoints[0]}>${endpoints[1]}`);
  }
  return edges;
}

export function auditCertifiedRemixContractSet(
  sourceLevel: LevelDefinition,
  contracts: readonly CertifiedRemixContract[],
): RemixContractSetAudit {
  const failures: string[] = [];
  if (contracts.length !== CERTIFIED_VARIANTS_PER_LEVEL) {
    failures.push(`Expected ${CERTIFIED_VARIANTS_PER_LEVEL} certified variants`);
  }
  const audits = contracts.map((contract) => auditCertifiedRemixContract(sourceLevel, contract));
  audits.forEach((audit, index) => {
    if (!audit.passed) {
      failures.push(`Variant ${index + 1} failed: ${audit.failures.join("; ")}`);
    }
  });
  const novelRouteCount = audits.filter((audit) => (
    audit.sourceRouteEdgeOverlap <= CERTIFIED_REMIX_DEPTH_CONTRACT.maximumSourceRouteEdgeOverlap
  )).length;
  if (novelRouteCount < CERTIFIED_REMIX_DEPTH_CONTRACT.minimumNovelRoutesPerLevel) {
    failures.push(
      `Only ${novelRouteCount} variants retain at most`
      + ` ${Math.round(CERTIFIED_REMIX_DEPTH_CONTRACT.maximumSourceRouteEdgeOverlap * 100)}%`
      + ` of the source route; ${CERTIFIED_REMIX_DEPTH_CONTRACT.minimumNovelRoutesPerLevel} required`,
    );
  }

  const routeFingerprints = contracts.map((contract) => {
    try {
      const level = immutableRemixedLevel(sourceLevel, contract);
      return findPath(level, level.playerStart, level.exit).map(pointKey).join("|");
    } catch {
      return `invalid:${contract.id}`;
    }
  });
  const distinctRouteCount = new Set(routeFingerprints).size;
  const distinctFirstEncounterCount = new Set(
    contracts.map((contract) => pointKey(contract.patrolGroup[0])),
  ).size;
  const distinctMissionPlacementCount = new Set(
    contracts.map((contract) => contract.mechanicPlacementGroup.map(pointKey).join("|")),
  ).size;
  const distinctHideSupplyCount = new Set(
    contracts.map((contract) => [...contract.hideSupplyIds].sort().join("|")),
  ).size;
  const distinctTopologyCount = new Set(contracts.map((contract) => [
    contract.openPassageCells.map(pointKey).sort().join(","),
    contract.closedPassageCells.map(pointKey).sort().join(","),
  ].join(">"))).size;

  if (distinctRouteCount !== contracts.length) failures.push("Certified variants reuse a shortest route");
  if (distinctTopologyCount !== contracts.length) failures.push("Certified variants reuse a topology swap");
  if (distinctFirstEncounterCount !== contracts.length) failures.push("First patrol encounters are not distinct");
  if (distinctMissionPlacementCount !== contracts.length) failures.push("Mission placement groups are not distinct");
  if (distinctHideSupplyCount !== contracts.length) failures.push("Hide supply profiles are not distinct");

  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    novelRouteCount,
    distinctRouteCount,
    distinctFirstEncounterCount,
    distinctMissionPlacementCount,
    distinctHideSupplyCount,
  });
}

export const ALL_CERTIFIED_REMIX_CONTRACTS: readonly CertifiedRemixContract[] = Object.freeze(
  CAMPAIGN_LEVELS.flatMap((level) => certifiedRemixContractsForLevel(level)),
);
