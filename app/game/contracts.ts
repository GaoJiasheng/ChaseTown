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
}

export interface HideSpotDefinition {
  id: string;
  /** Cell or point at which the interaction prompt becomes available. */
  approach: Point;
  /** Logical point occupied while hidden. It is never exposed to ChaserBrain. */
  concealed: Point;
  facing: Point;
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
}

export interface ChaserMemory {
  /** Updated only from explicit perception evidence. */
  lastKnownPosition: Point | null;
  lastSeenAtSeconds: number | null;
  lastHeardAtSeconds: number | null;
  lastKnownEvidence: "visual" | "sound" | null;
  /**
   * A secondary, imprecise sound sample remembered while stronger visual
   * evidence is still being pursued. It never contains hidden player state.
   */
  deferredSoundEvidence: {
    position: Point;
    strength: number;
    observedAtSeconds: number;
  } | null;
  /** Set only when the chaser actually witnesses a hide-entry transition. */
  witnessedHideSpotId: string | null;
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
}

export type PerceptionEvidence =
  | {
      kind: "player-visible";
      position: Point;
      observedAtSeconds: number;
    }
  | {
      kind: "hide-entry-visible";
      hideSpotId: string;
      position: Point;
      observedAtSeconds: number;
    }
  | {
      kind: "sound";
      position: Point;
      strength: number;
      observedAtSeconds: number;
    }
  | { kind: "none"; observedAtSeconds: number };

export type SimulationEvent =
  | { type: "player-mode-changed"; from: PlayerMode; to: PlayerMode }
  | { type: "chaser-mode-changed"; from: ChaserMode; to: ChaserMode }
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
