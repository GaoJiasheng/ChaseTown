import type { RunRuleset } from "./mastery.ts";
import {
  ghostDurationSeconds,
  type GhostRecording,
} from "./ghost-replay.ts";

export const DEFAULT_GHOST_RACE_SPLITS = Object.freeze([
  Object.freeze({ id: "opening", label: "前段", progress: 0.25 }),
  Object.freeze({ id: "midpoint", label: "中段", progress: 0.5 }),
  Object.freeze({ id: "final", label: "终段", progress: 0.75 }),
]) as readonly GhostRaceSplitDefinition[];

export interface GhostRaceSplitDefinition {
  readonly id: string;
  readonly label: string;
  /** Normalized route progress in (0, 1). */
  readonly progress: number;
}

export interface GhostRaceEligibilityInput {
  readonly recording: Readonly<GhostRecording> | null;
  readonly levelId: string;
  readonly fixedStepSeconds: number;
  readonly ruleset: RunRuleset;
}

export interface GhostRaceFrame {
  readonly elapsedSeconds: number;
  readonly playerRemainingMeters: number;
  readonly ghostRemainingMeters: number;
}

export interface GhostRaceSplitResult {
  readonly id: string;
  readonly label: string;
  /** Negative means the player crossed first. */
  readonly deltaSeconds: number;
}

export interface GhostRaceSnapshot {
  /** Positive means the player is spatially ahead. */
  readonly playerLeadMeters: number;
  readonly leader: "player" | "ghost" | "tied";
  readonly referenceSeconds: number;
  readonly latestSplit: GhostRaceSplitResult | null;
  readonly completedSplitIds: readonly string[];
}

interface MutableSplit {
  readonly definition: GhostRaceSplitDefinition;
  readonly thresholdRemainingMeters: number;
  playerSeconds: number | null;
  ghostSeconds: number | null;
  emitted: boolean;
}

const finiteNonNegative = (value: number) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

export function canRacePersonalGhost(input: GhostRaceEligibilityInput): boolean {
  const { recording } = input;
  return Boolean(
    recording
    && input.ruleset === "standard"
    && recording.levelId === input.levelId
    && Math.abs(recording.fixedStepSeconds - input.fixedStepSeconds) <= 1e-9
    && recording.durationTicks > 0,
  );
}

export class GhostRaceTracker {
  private readonly referenceSeconds: number;
  private readonly splits: MutableSplit[];
  private latestSplit: GhostRaceSplitResult | null = null;
  private previousPlayerRemaining: number;
  private previousGhostRemaining: number;

  constructor(
    recording: Readonly<GhostRecording>,
    initialRouteDistanceMeters: number,
    definitions: readonly GhostRaceSplitDefinition[] = DEFAULT_GHOST_RACE_SPLITS,
  ) {
    const initialDistance = finiteNonNegative(initialRouteDistanceMeters);
    if (initialDistance <= 0) {
      throw new Error("Ghost race requires a positive initial route distance");
    }
    const seen = new Set<string>();
    this.splits = definitions.map((definition) => {
      if (
        !definition.id
        || seen.has(definition.id)
        || !Number.isFinite(definition.progress)
        || definition.progress <= 0
        || definition.progress >= 1
      ) {
        throw new Error("Ghost race splits require unique IDs and progress in (0, 1)");
      }
      seen.add(definition.id);
      return {
        definition: Object.freeze({ ...definition }),
        thresholdRemainingMeters: initialDistance * (1 - definition.progress),
        playerSeconds: null,
        ghostSeconds: null,
        emitted: false,
      };
    });
    this.referenceSeconds = ghostDurationSeconds(recording);
    this.previousPlayerRemaining = initialDistance;
    this.previousGhostRemaining = initialDistance;
  }

  reset(initialRouteDistanceMeters: number): void {
    const initialDistance = finiteNonNegative(initialRouteDistanceMeters);
    if (initialDistance <= 0) {
      throw new Error("Ghost race requires a positive initial route distance");
    }
    for (const split of this.splits) {
      split.playerSeconds = null;
      split.ghostSeconds = null;
      split.emitted = false;
    }
    this.latestSplit = null;
    this.previousPlayerRemaining = initialDistance;
    this.previousGhostRemaining = initialDistance;
  }

  update(frame: Readonly<GhostRaceFrame>): GhostRaceSnapshot {
    const elapsedSeconds = finiteNonNegative(frame.elapsedSeconds);
    const playerRemaining = finiteNonNegative(frame.playerRemainingMeters);
    const ghostRemaining = finiteNonNegative(frame.ghostRemainingMeters);
    for (const split of this.splits) {
      if (
        split.playerSeconds === null
        && this.previousPlayerRemaining > split.thresholdRemainingMeters
        && playerRemaining <= split.thresholdRemainingMeters
      ) {
        split.playerSeconds = elapsedSeconds;
      }
      if (
        split.ghostSeconds === null
        && this.previousGhostRemaining > split.thresholdRemainingMeters
        && ghostRemaining <= split.thresholdRemainingMeters
      ) {
        split.ghostSeconds = elapsedSeconds;
      }
      if (
        !split.emitted
        && split.playerSeconds !== null
        && split.ghostSeconds !== null
      ) {
        split.emitted = true;
        this.latestSplit = Object.freeze({
          id: split.definition.id,
          label: split.definition.label,
          deltaSeconds: split.playerSeconds - split.ghostSeconds,
        });
      }
    }
    this.previousPlayerRemaining = playerRemaining;
    this.previousGhostRemaining = ghostRemaining;
    const playerLeadMeters = ghostRemaining - playerRemaining;
    return Object.freeze({
      playerLeadMeters,
      leader: Math.abs(playerLeadMeters) < 0.05
        ? "tied"
        : playerLeadMeters > 0 ? "player" : "ghost",
      referenceSeconds: this.referenceSeconds,
      latestSplit: this.latestSplit,
      completedSplitIds: Object.freeze(
        this.splits.filter((split) => split.emitted).map((split) => split.definition.id),
      ),
    });
  }
}
