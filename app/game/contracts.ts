import type {
  ChaserArchetypeAction,
  ChaserArchetypeKind,
  ChaserArchetypeRule,
} from "./chaser-archetypes.ts";

export type Point = { x: number; y: number };

export type GamePhase = "ready" | "playing" | "won" | "lost";

export type PlayerMode =
  | "free"
  | "aligning-hide"
  | "entering-hide"
  | "hidden"
  | "entering-peek"
  | "peeking"
  | "exiting-peek"
  | "exiting-hide"
  | "caught"
  | "escaped";

export type ChaserMode =
  | "spawn-delay"
  | "patrol"
  | "suspicious"
  | "chase"
  | "lost-sight"
  | "go-to-last-known"
  | "scan-last-known"
  | "search"
  | "check-hide";

export type MoveIntent = { x: number; y: number };

export type HideArchetypeKind = "hard-locker" | "soft-cover" | "traversal-hide";
export type HideExitKind = "origin" | "alternate";
export type HideExitStyle = "standard" | "quick" | "careful";
export type HideDisturbanceLevel = 0 | 1 | 2 | 3;

export interface SimulationInput {
  move?: MoveIntent;
  interactPressed?: boolean;
  peekHeld?: boolean;
  /** Quiet movement modifier while free; the same control peeks in a locker. */
  sneakHeld?: boolean;
  /**
   * Broad 0..1 environmental masking supplied by an authored theme event.
   * This scales newly generated player sound before it enters AI perception.
   */
  environmentSoundMasking?: number;
  /**
   * Authored environmental visibility multiplier. It affects only the
   * chaser's legal visual sample and never changes collision or catch range.
   */
  visionRangeMultiplier?: number;
  /**
   * Public, physical traversal modifier supplied by a bounded world effect
   * such as a door wedge or a telegraphed pressure window. The runtime clamps
   * it to [0, 1.25]. It affects translation only; AI decisions, catch range,
   * player collision and navigation topology remain unchanged.
   */
  chaserSpeedMultiplier?: number;
  /**
   * Public objective gate supplied by the mission layer. It defaults to true
   * for legacy and sandbox levels, changes no collision or AI knowledge, and
   * only prevents the exit trigger from resolving before authored objectives.
   */
  exitEnabled?: boolean;
  /**
   * Player-selected side for a traversal hide. The selection persists while
   * the player remains in the active hide spot and defaults to the origin.
   * Unsupported alternate requests safely resolve to the origin exit.
   */
  hideExitChoice?: HideExitKind;
  /**
   * Exit commitment selected by the player. Quick exits shorten the authored
   * transition but make more noise and disturbance; careful exits do the
   * inverse. Omission preserves the original standard exit exactly.
   */
  hideExitStyle?: HideExitStyle;
}

export interface HideSpotDefinition {
  id: string;
  /** Cell or point at which the interaction prompt becomes available. */
  approach: Point;
  /** Logical point occupied while hidden. It is never exposed to ChaserBrain. */
  concealed: Point;
  facing: Point;
  /**
   * Omitted spots retain the original hard-locker behavior. The declaration
   * is public authored geometry; runtime occupancy and the player's selected
   * traversal exit remain private simulation state.
   */
  archetype?: HideArchetypeKind;
  /** Public, walkable destination available only to traversal hides. */
  alternateExit?: Point;
}

export interface LevelDefinition {
  id: string;
  width: number;
  height: number;
  walkable: readonly (readonly boolean[])[];
  playerStart: Point;
  exit: Point;
  chaserStart: Point;
  chaserStartHeading: Point;
  patrol: readonly Point[];
  hideSpots: readonly HideSpotDefinition[];
  /** Cells occupied by solid authored props; floors remain rendered there. */
  movementBlockers?: readonly Point[];
  /** Additional cells which permit movement but block perception. */
  visionOnlyBlockers?: readonly Point[];
}

export interface GameConfig {
  fixedStepSeconds: number;
  maxFrameDeltaSeconds: number;
  aiTickSeconds: number;
  playerSpeed: number;
  chaserSpeed: number;
  spawnDelaySeconds: number;
  suspiciousSeconds: number;
  lostSightGraceSeconds: number;
  /** Deliberate left/right inspection after reaching the final visual evidence. */
  lastKnownScanSeconds: number;
  searchSeconds: number;
  searchWaypointSeconds: number;
  /** Maximum evidence-ranked, unwitnessed lockers inspected during one search. */
  searchHideCheckBudget: number;
  /** Navigable distance from the final evidence within which a locker is plausible. */
  searchHideRadiusCells: number;
  checkHideSeconds: number;
  /** Maximum navigable distance at which a full-strength sound can be heard. */
  hearingRange: number;
  /** Minimum positional uncertainty retained by heard, non-visual evidence. */
  soundUncertaintyCells: number;
  visionRange: number;
  visionConeDegrees: number;
  proximitySenseRange: number;
  catchRange: number;
  exitRange: number;
  hideInteractRange: number;
  hideAlignSpeed: number;
  /** Maximum turn speed while settling onto a hide anchor, in radians/second. */
  hideAlignTurnSpeed: number;
  hideEnterSeconds: number;
  hideEnterExposureSeconds: number;
  hideExitSeconds: number;
  hideExitExposureSeconds: number;
  peekEnterSeconds: number;
  peekExitSeconds: number;
}

export interface PlayerState {
  position: Point;
  heading: Point;
  mode: PlayerMode;
  hideSpotId: string | null;
  transitionRemainingSeconds: number;
  /** Signed authored pivot direction while settling on a locker anchor. */
  hideTurnDirection: -1 | 0 | 1;
  /** Zero-based 90° pivot segment; a 180° turn contains two segments. */
  hideTurnCycle: number;
  /** Duration used to time-scale the authored 90° pivot for this segment. */
  hideTurnSegmentDurationSeconds: number;
  /** Committed exit style while exiting; null outside that transition. */
  hideExitStyle: HideExitStyle | null;
}

export interface PublicRegionSuspicion {
  /** Stable navigation-region id derived only from public level geometry. */
  readonly regionId: string;
  /** Public junction/corridor anchor used to order search and patrol routes. */
  readonly anchor: Point;
  /** Current decayed suspicion in [0, 1]. */
  readonly confidence: number;
  readonly updatedAtSeconds: number;
  readonly decayPerSecond: number;
}

export interface ChaserMemory {
  /** Updated only from explicit perception evidence. */
  lastKnownPosition: Point | null;
  /** Last public travel direction; never sampled from a concealed player. */
  lastKnownDirection: Point | null;
  lastSeenAtSeconds: number | null;
  lastHeardAtSeconds: number | null;
  lastClueAtSeconds: number | null;
  lastKnownEvidence: "visual" | "sound" | "world-clue" | null;
  /**
   * A secondary, imprecise sound sample remembered while stronger visual
   * evidence is still being pursued. It never contains hidden player state.
   */
  deferredSoundEvidence: {
    position: Point;
    direction?: Point;
    strength: number;
    observedAtSeconds: number;
    sourceType?: SoundEvidenceSourceType;
    sourceId?: string;
    confidence?: number;
    decayPerSecond?: number;
  } | null;
  /** Set only when the chaser actually witnesses a hide-entry transition. */
  witnessedHideSpotId: string | null;
  /**
   * At most three facts the brain was legally given by perception. This is a
   * bounded public-evidence ledger, never a copy of player or locker state.
   */
  evidenceTrail?: readonly PublicEvidenceMemory[];
  /**
   * At most four decaying public navigation regions. These may only order
   * search hypotheses and patrol points; they never become a chase target.
   */
  regionSuspicion: readonly PublicRegionSuspicion[];
}

export interface ChaserState {
  position: Point;
  heading: Point;
  mode: ChaserMode;
  modeElapsedSeconds: number;
  /**
   * Consecutive visible time while an existing pursuit/search mode confirms a
   * reacquisition. `null` means no confirmation is active. The underlying
   * mode keeps moving and aging, so short peeks cannot stun or reset the AI.
   */
  visualConfirmationSeconds: number | null;
  patrolIndex: number;
  /** Arrival heading used as the neutral direction for the last-known sweep. */
  scanOriginHeading: Point;
  /** Deterministic per-encounter shuffle; derived only from observed evidence. */
  searchSeed: number;
  /**
   * Frozen public-geometry route captured once when search begins. Suspicion may
   * continue to decay, but it cannot reorder an in-progress search or make
   * movement-frame target reads rebuild the navigation graph.
   */
  searchPlan: readonly Point[];
  searchIndex: number;
  searchWaypointElapsedSeconds: number;
  /** Public-evidence candidate selected without consulting locker occupancy. */
  searchHideSpotId: string | null;
  hideCheckSource: "witnessed" | "search" | null;
  searchHideChecksCompleted: number;
  inspectedHideSpotIds: readonly string[];
  memory: ChaserMemory;
}

export interface HideSpotRuntimeState {
  id: string;
  occupiedByPlayer: boolean;
  /** Public scene disturbance; AI receives it only after a legal LOS sample. */
  disturbanceLevel: HideDisturbanceLevel;
  disturbanceRevision: number;
  disturbanceUpdatedAtTick: number;
  useCount: number;
  peekCount: number;
}

export type PerceptionEvidence =
  | {
      kind: "player-visible";
      position: Point;
      /** Optional public motion direction captured by the perception adapter. */
      direction?: Point;
      observedAtSeconds: number;
    }
  | {
      kind: "hide-entry-visible";
      hideSpotId: string;
      position: Point;
      direction?: Point;
      observedAtSeconds: number;
    }
  | {
      kind: "sound";
      position: Point;
      direction?: Point;
      strength: number;
      observedAtSeconds: number;
      /** Explicit provenance lets authored decoys remain auditable and fair. */
      sourceType?: SoundEvidenceSourceType;
      /** Stable authored emitter id. Omit for one-off or anonymous sounds. */
      sourceId?: string;
      /** Perception certainty before age decay. Defaults to perceived strength. */
      confidence?: number;
      /** Linear certainty loss per second. */
      decayPerSecond?: number;
    }
  | {
      /**
       * A public, spatial clue that the chaser has physically observed. The
       * payload deliberately excludes authenticity and actor identity, so a
       * forged trace and a genuine trace are indistinguishable to the brain.
       */
      kind: "world-clue";
      clueId: string;
      position: Point;
      direction?: Point;
      observedAtSeconds: number;
      confidence: number;
      sourceType: WorldClueSourceType;
      decayPerSecond?: number;
    }
  | { kind: "none"; observedAtSeconds: number };

export type WorldClueSourceType =
  | "footprint"
  | "disturbed-prop"
  | "door-disturbance"
  | "infrastructure-anomaly";

export type SoundEvidenceSourceType =
  | "player-movement"
  | "hide-interaction"
  | "environment-decoy"
  | "environment-hazard"
  | "ambient"
  | "unknown";

export interface PublicEvidenceMemory {
  readonly kind: "visual" | "hide-entry-visible" | "sound" | "world-clue";
  readonly position: Point;
  readonly direction: Point | null;
  readonly observedAtSeconds: number;
  readonly confidence: number;
  readonly decayPerSecond: number;
  readonly sourceType: SoundEvidenceSourceType | WorldClueSourceType | "player";
  readonly sourceId: string | null;
  /** Consecutive uses of the same stable environmental emitter. */
  readonly repeatCount: number;
  readonly hideSpotId: string | null;
  readonly strength: number;
}

export type SimulationEvent =
  | { type: "player-mode-changed"; from: PlayerMode; to: PlayerMode }
  | { type: "chaser-mode-changed"; from: ChaserMode; to: ChaserMode }
  | {
      type: "chaser-archetype-telegraph-started";
      archetype: ChaserArchetypeKind;
      rule: ChaserArchetypeRule;
      warningSeconds: number;
      cueLabel: string;
      cueAudioToken: string;
      cueAnimationToken: string;
    }
  | {
      type: "chaser-archetype-action-started";
      archetype: ChaserArchetypeKind;
      rule: ChaserArchetypeRule;
      action: ChaserArchetypeAction["type"];
    }
  | {
      type: "chaser-archetype-action-finished";
      archetype: ChaserArchetypeKind;
      rule: ChaserArchetypeRule;
      action: ChaserArchetypeAction["type"];
      outcome: "completed" | "interrupted";
    }
  | {
      type: "evidence-investigation-completed";
      evidenceId: string;
      sourceType: SoundEvidenceSourceType | WorldClueSourceType;
      completedAtSeconds: number;
      completedAtTick: number;
    }
  | { type: "hide-check-completed"; hideSpotId: string; occupied: boolean }
  | { type: "player-captured"; reason: CaptureReason }
  | { type: "phase-changed"; from: GamePhase; to: GamePhase };

export type CaptureReason =
  | "direct-contact"
  | "exposed-hide-entry"
  | "unsafe-hide-exit"
  | "witnessed-hide-check"
  | "search-hide-check";

export interface GameState {
  phase: GamePhase;
  captureReason: CaptureReason | null;
  elapsedSeconds: number;
  tick: number;
  player: PlayerState;
  chaser: ChaserState;
  hideSpots: Record<string, HideSpotRuntimeState>;
  /** Time accumulated toward the next lower-frequency AI/perception update. */
  aiAccumulatorSeconds: number;
  /** Events emitted by the most recent fixed simulation step. */
  events: SimulationEvent[];
}
