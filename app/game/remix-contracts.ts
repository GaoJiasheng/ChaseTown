import { CAMPAIGN_LEVELS, type CampaignLevelDefinition } from "./campaign.ts";
import type { HideSpotDefinition, LevelDefinition, Point } from "./contracts.ts";
import { createLevel } from "./level.ts";
import { distanceBetween, findPath, isWalkable, neighbors, pointKey } from "./navigation.ts";

export const REMIX_CONTRACT_VERSION = 1;
export const CERTIFIED_VARIANTS_PER_LEVEL = 3;
export const CERTIFIED_REMIX_MISSION_VERSION = "mission-v1";

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

function requiredAnchors(level: LevelDefinition): readonly Point[] {
  return Object.freeze([
    level.playerStart,
    level.exit,
    level.chaserStart,
    ...level.patrol,
    ...level.hideSpots.map((spot) => spot.approach),
    ...level.hideSpots.flatMap((spot) => spot.alternateExit ? [spot.alternateExit] : []),
  ]);
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

function anchorsRemainConnected(
  level: LevelDefinition,
  anchors: readonly Point[],
): boolean {
  return anchors.every((anchor) => findPath(level, level.playerStart, anchor).length > 0);
}

/**
 * Finds three topology-authored optional connector cells whose simultaneous
 * closure preserves every existing gameplay anchor. This is run only for the
 * fixed campaign whitelist; the result is certified, not exposed as an
 * arbitrary procedural-seed API.
 */
function discoverOptionalPassagePool(level: LevelDefinition): readonly Point[] {
  const anchors = requiredAnchors(level);
  const protectedKeys = new Set(anchors.map(pointKey));
  const candidates: Array<{ point: Point; degree: number; score: number }> = [];
  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const point = { x, y };
      if (!isWalkable(level, point) || protectedKeys.has(pointKey(point))) continue;
      if (anchors.some((anchor) => distanceBetween(point, anchor) < 1.5)) continue;
      const degree = neighbors(level, point).length;
      if (degree < 2) continue;
      candidates.push({
        point,
        degree,
        score: stableHash(`${level.id}:${x},${y}`, 0x5f3759df),
      });
    }
  }
  candidates.sort((left, right) => (
    right.degree - left.degree
    || left.score - right.score
    || pointKey(left.point).localeCompare(pointKey(right.point))
  ));

  const selected: Point[] = [];
  for (const candidate of candidates) {
    const trial = [...selected, candidate.point];
    const trialLevel = levelWithPassages(level, [], trial);
    if (!anchorsRemainConnected(trialLevel, anchors)) continue;
    selected.push(freezePoint(candidate.point));
    if (selected.length === CERTIFIED_VARIANTS_PER_LEVEL) break;
  }
  if (selected.length < CERTIFIED_VARIANTS_PER_LEVEL) {
    throw new Error(`${level.id} has fewer than three certifiable optional passage cells`);
  }
  return Object.freeze(selected);
}

function hideSupplyForVariant(
  level: LevelDefinition,
  variantIndex: 0 | 1 | 2,
): readonly string[] {
  const ids = level.hideSpots.map((spot) => spot.id);
  if (ids.length === 0) throw new Error(`${level.id} has no hide supply`);
  if (ids.length === 1) return Object.freeze(ids);
  const removedIndex = variantIndex % ids.length;
  return Object.freeze(ids.filter((_, index) => index !== removedIndex));
}

function patrolForVariant(
  level: LevelDefinition,
  seed: number,
  variantIndex: 0 | 1 | 2,
): readonly Point[] {
  const ordered = seededOrder(level.patrol, seed, pointKey).map(freezePoint);
  if (variantIndex === 0) return Object.freeze(ordered);
  if (variantIndex === 1) return Object.freeze([...ordered].reverse());
  if (ordered.length <= 1) return Object.freeze(ordered);
  const pivot = Math.max(1, Math.floor(ordered.length / 2));
  return Object.freeze([...ordered.slice(pivot), ...ordered.slice(0, pivot)]);
}

function mechanicPlacements(
  level: LevelDefinition,
  seed: number,
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
  const ordered = seededOrder(
    junctions.length >= 2 ? junctions : [...junctions, ...fallback],
    seed,
    pointKey,
  );
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
  if (selected.length < 2) throw new Error(`${level.id} cannot place two certified mechanisms`);
  return Object.freeze(selected);
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
  const passagePool = discoverOptionalPassagePool(level);
  const contracts = seeds.map((seed, rawIndex) => {
    const variantIndex = rawIndex as 0 | 1 | 2;
    const closedPassageCells = Object.freeze([passagePool[variantIndex]]);
    const openPassageCells = Object.freeze(
      passagePool.filter((_, index) => index !== variantIndex),
    );
    const patrolGroup = patrolForVariant(level, seed, variantIndex);
    const hideSupplyIds = hideSupplyForVariant(level, variantIndex);
    const preliminary = levelWithPassages(
      level,
      openPassageCells,
      closedPassageCells,
      patrolGroup,
      level.hideSpots.filter((spot) => hideSupplyIds.includes(spot.id)),
    );
    const contract = freezeContract({
      version: REMIX_CONTRACT_VERSION,
      id: `${level.id}:certified-${variantIndex + 1}:${seed.toString(16).padStart(8, "0")}`,
      levelId: level.id,
      variantIndex,
      seed,
      patrolGroup,
      mechanicPlacementGroup: mechanicPlacements(preliminary, seed),
      openPassageCells,
      closedPassageCells,
      hideSupplyIds,
    });
    const audit = auditCertifiedRemixContract(level, contract);
    if (!audit.passed) throw new Error(`Invalid certified remix ${contract.id}: ${audit.failures.join("; ")}`);
    return contract;
  });
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
  if ([...openKeys].some((key) => closedKeys.has(key))) failures.push("A passage cannot be open and closed");

  let resolved: LevelDefinition | null = null;
  try {
    resolved = immutableRemixedLevel(sourceLevel, contract);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "Remixed level failed validation");
  }
  let reachableAnchorCount = 0;
  if (resolved) {
    const anchors = [
      resolved.exit,
      resolved.chaserStart,
      ...resolved.patrol,
      ...resolved.hideSpots.map((spot) => spot.approach),
      ...contract.mechanicPlacementGroup,
    ];
    for (const anchor of anchors) {
      if (findPath(resolved, resolved.playerStart, anchor).length > 0) reachableAnchorCount += 1;
      else failures.push(`Unreachable remixed anchor ${pointKey(anchor)}`);
    }
    for (const point of contract.mechanicPlacementGroup) {
      if (!isWalkable(resolved, point)) failures.push(`Mechanic placement ${pointKey(point)} is blocked`);
    }
  }
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    reachableAnchorCount,
  });
}

export const ALL_CERTIFIED_REMIX_CONTRACTS: readonly CertifiedRemixContract[] = Object.freeze(
  CAMPAIGN_LEVELS.flatMap((level) => certifiedRemixContractsForLevel(level)),
);
