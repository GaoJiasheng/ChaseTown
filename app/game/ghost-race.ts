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

export const GHOST_RULE_PROGRESS_VERSION = 1;

export type GhostRuleProgressStage =
  | "preparation"
  | "escape-unlock"
  | "escape"
  | "complete";

export type GhostRuleEventInput =
  | { readonly type: "objective-completed"; readonly objectiveId: string }
  | { readonly type: "mechanic-committed"; readonly mechanicId: string }
  | { readonly type: "exit-unlocked"; readonly objectiveId: string }
  | { readonly type: "run-completed" };

export type GhostRuleEvent = GhostRuleEventInput & {
  readonly tick: number;
  readonly sequence: number;
};

export interface GhostRuleProgressFrame {
  readonly tick: number;
  /**
   * Progress through the currently legal exit route. It is ignored until the
   * exit is unlocked and clamped monotonically thereafter.
   */
  readonly routeProgress: number;
  readonly events?: readonly GhostRuleEventInput[];
}

/**
 * Optional v1 sidecar state. It deliberately does not alter GhostRecording,
 * its checksum, or the v1 storage key, so every existing personal ghost
 * remains loadable while new integrations can replay mission semantics.
 */
export interface GhostRuleProgressSnapshot {
  readonly version: typeof GHOST_RULE_PROGRESS_VERSION;
  readonly tick: number;
  readonly stage: GhostRuleProgressStage;
  readonly normalizedProgress: number;
  readonly routeProgress: number;
  readonly completedObjectiveIds: readonly string[];
  readonly committedMechanicIds: readonly string[];
  readonly exitUnlocked: boolean;
  readonly runCompleted: boolean;
  readonly events: readonly GhostRuleEvent[];
}

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
  /** Supplying both sidecars makes splits mission-faithful instead of spatial-only. */
  readonly playerRuleProgress?: Readonly<GhostRuleProgressSnapshot>;
  readonly ghostRuleProgress?: Readonly<GhostRuleProgressSnapshot>;
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
  /** Monotonic normalized progress used for split crossings. */
  readonly playerProgress: number;
  readonly ghostProgress: number;
  /** Positive means the player leads on the complete mission timeline. */
  readonly playerLeadProgress: number;
}

interface MutableSplit {
  readonly definition: GhostRaceSplitDefinition;
  playerSeconds: number | null;
  ghostSeconds: number | null;
  emitted: boolean;
}

const finiteNonNegative = (value: number) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

const normalized = (value: number) => (
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
);

const frozenStrings = (values: Iterable<string>): readonly string[] => (
  Object.freeze([...values])
);

export class GhostRuleProgressTracker {
  private readonly requiredObjectiveIds: readonly string[];
  private readonly requiredObjectiveIdSet: ReadonlySet<string>;
  private readonly completedObjectiveIds = new Set<string>();
  private readonly committedMechanicIds = new Set<string>();
  private readonly events: GhostRuleEvent[] = [];
  private previousTick = -1;
  private exitUnlocked = false;
  private runCompleted = false;
  private escapeRouteProgress = 0;
  private normalizedProgress = 0;

  constructor(requiredObjectiveIds: readonly string[]) {
    const ids = requiredObjectiveIds.map((id) => id.trim());
    if (
      ids.length === 0
      || ids.some((id) => !id)
      || new Set(ids).size !== ids.length
    ) {
      throw new Error("Ghost rule progress requires unique objective IDs");
    }
    this.requiredObjectiveIds = Object.freeze(ids);
    this.requiredObjectiveIdSet = new Set(ids);
  }

  update(frame: Readonly<GhostRuleProgressFrame>): GhostRuleProgressSnapshot {
    if (!Number.isInteger(frame.tick) || frame.tick < 0 || frame.tick < this.previousTick) {
      throw new Error("Ghost rule progress ticks must be monotonic non-negative integers");
    }
    const append = (event: GhostRuleEventInput) => {
      this.events.push(Object.freeze({
        ...event,
        tick: frame.tick,
        sequence: this.events.length,
      }) as GhostRuleEvent);
    };

    for (const event of frame.events ?? []) {
      switch (event.type) {
        case "objective-completed":
          if (!this.requiredObjectiveIdSet.has(event.objectiveId)) {
            throw new Error(`Unknown ghost objective ${event.objectiveId}`);
          }
          if (!this.completedObjectiveIds.has(event.objectiveId)) {
            this.completedObjectiveIds.add(event.objectiveId);
            append(event);
          }
          break;
        case "mechanic-committed":
          if (!event.mechanicId.trim()) throw new Error("Ghost mechanic ID must not be empty");
          if (!this.committedMechanicIds.has(event.mechanicId)) {
            this.committedMechanicIds.add(event.mechanicId);
            append(event);
          }
          break;
        case "exit-unlocked":
          if (!this.requiredObjectiveIdSet.has(event.objectiveId)) {
            throw new Error(`Unknown exit objective ${event.objectiveId}`);
          }
          if (this.completedObjectiveIds.size !== this.requiredObjectiveIds.length) {
            throw new Error("Ghost exit cannot unlock before every objective completes");
          }
          if (!this.exitUnlocked) {
            this.exitUnlocked = true;
            append(event);
          }
          break;
        case "run-completed":
          if (!this.exitUnlocked) {
            throw new Error("Ghost run cannot complete before the mission unlocks the exit");
          }
          if (!this.runCompleted) {
            this.runCompleted = true;
            this.escapeRouteProgress = 1;
            append(event);
          }
          break;
      }
    }

    if (this.exitUnlocked && !this.runCompleted) {
      this.escapeRouteProgress = Math.max(
        this.escapeRouteProgress,
        normalized(frame.routeProgress),
      );
    }
    const objectiveProgress = this.completedObjectiveIds.size
      / this.requiredObjectiveIds.length;
    let stage: GhostRuleProgressStage;
    let candidateProgress: number;
    if (this.runCompleted) {
      stage = "complete";
      candidateProgress = 1;
    } else if (this.exitUnlocked) {
      stage = "escape";
      candidateProgress = 0.72 + this.escapeRouteProgress * 0.27;
    } else if (this.completedObjectiveIds.size === this.requiredObjectiveIds.length) {
      stage = "escape-unlock";
      candidateProgress = 0.68;
    } else {
      stage = "preparation";
      candidateProgress = objectiveProgress * 0.64;
    }
    this.normalizedProgress = Math.max(
      this.normalizedProgress,
      normalized(candidateProgress),
    );
    this.previousTick = frame.tick;
    return Object.freeze({
      version: GHOST_RULE_PROGRESS_VERSION,
      tick: frame.tick,
      stage,
      normalizedProgress: this.normalizedProgress,
      routeProgress: this.escapeRouteProgress,
      completedObjectiveIds: frozenStrings(
        this.requiredObjectiveIds.filter((id) => this.completedObjectiveIds.has(id)),
      ),
      committedMechanicIds: frozenStrings(this.committedMechanicIds),
      exitUnlocked: this.exitUnlocked,
      runCompleted: this.runCompleted,
      events: Object.freeze([...this.events]),
    });
  }
}

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
  private initialRouteDistanceMeters: number;
  private previousPlayerProgress = 0;
  private previousGhostProgress = 0;

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
        playerSeconds: null,
        ghostSeconds: null,
        emitted: false,
      };
    });
    this.referenceSeconds = ghostDurationSeconds(recording);
    this.initialRouteDistanceMeters = initialDistance;
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
    this.initialRouteDistanceMeters = initialDistance;
    this.previousPlayerProgress = 0;
    this.previousGhostProgress = 0;
  }

  update(frame: Readonly<GhostRaceFrame>): GhostRaceSnapshot {
    const elapsedSeconds = finiteNonNegative(frame.elapsedSeconds);
    const playerRemaining = finiteNonNegative(frame.playerRemainingMeters);
    const ghostRemaining = finiteNonNegative(frame.ghostRemainingMeters);
    const usesRuleProgress = Boolean(frame.playerRuleProgress && frame.ghostRuleProgress);
    const rawPlayerProgress = usesRuleProgress
      ? normalized(frame.playerRuleProgress!.normalizedProgress)
      : normalized(1 - playerRemaining / this.initialRouteDistanceMeters);
    const rawGhostProgress = usesRuleProgress
      ? normalized(frame.ghostRuleProgress!.normalizedProgress)
      : normalized(1 - ghostRemaining / this.initialRouteDistanceMeters);
    const playerProgress = Math.max(this.previousPlayerProgress, rawPlayerProgress);
    const ghostProgress = Math.max(this.previousGhostProgress, rawGhostProgress);
    for (const split of this.splits) {
      if (
        split.playerSeconds === null
        && this.previousPlayerProgress < split.definition.progress
        && playerProgress >= split.definition.progress
      ) {
        split.playerSeconds = elapsedSeconds;
      }
      if (
        split.ghostSeconds === null
        && this.previousGhostProgress < split.definition.progress
        && ghostProgress >= split.definition.progress
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
    this.previousPlayerProgress = playerProgress;
    this.previousGhostProgress = ghostProgress;
    const playerLeadMeters = ghostRemaining - playerRemaining;
    const playerLeadProgress = playerProgress - ghostProgress;
    return Object.freeze({
      playerLeadMeters,
      leader: usesRuleProgress
        ? Math.abs(playerLeadProgress) < 1e-4
          ? "tied"
          : playerLeadProgress > 0 ? "player" : "ghost"
        : (
          Math.abs(playerLeadMeters) < 0.05
            ? "tied"
            : playerLeadMeters > 0 ? "player" : "ghost"
        ),
      referenceSeconds: this.referenceSeconds,
      latestSplit: this.latestSplit,
      completedSplitIds: Object.freeze(
        this.splits.filter((split) => split.emitted).map((split) => split.definition.id),
      ),
      playerProgress,
      ghostProgress,
      playerLeadProgress,
    });
  }
}
