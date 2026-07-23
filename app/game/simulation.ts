import type {
  CaptureReason,
  GameConfig,
  GamePhase,
  GameState,
  ChaserMode,
  HideExitKind,
  HideSpotDefinition,
  LevelDefinition,
  MoveIntent,
  PlayerMode,
  PlayerState,
  PerceptionEvidence,
  Point,
  SimulationEvent,
  SimulationInput,
} from "./contracts.ts";
import {
  createInitialChaserArchetypeState,
  stepChaserArchetype,
  type ChaserArchetypeAction,
  type ChaserArchetypeProfile,
  type ChaserArchetypeState,
  type ChaserArchetypeStimulus,
} from "./chaser-archetypes.ts";
import { getChaserTarget, hasReachedChaserTarget, createInitialChaser, lastKnownScanHeading, stepChaserBrain } from "./chaser-fsm.ts";
import {
  auditHideArchetypeBindings,
  hideExitOptions,
  hideTransitionEvidence,
  queryLegalHideCandidates,
  type HideExitOption,
  type HideSpotArchetypeBinding,
  type ResolvedHideSpotArchetype,
} from "./hide-archetypes.ts";
import { createDefaultLevel, DEFAULT_GAME_CONFIG } from "./level.ts";
import {
  distanceBetween,
  GridPathPlanner,
  hasLineOfSight,
  moveAlongGridPath,
  moveWithCollision,
  normalizeVector,
} from "./navigation.ts";
import {
  isPlayerVisuallyExposed,
  samplePlayerPerception,
  sampleSoundPerception,
  type SoundStimulus,
} from "./perception.ts";

export interface GameSimulationOptions {
  level?: LevelDefinition;
  config?: Partial<GameConfig>;
  autoStart?: boolean;
  initialPlayerPosition?: Point;
  initialPlayerHeading?: Point;
  initialChaserPosition?: Point;
  initialChaserHeading?: Point;
  /** Optional adapter for legacy level data that cannot carry inline metadata. */
  hideArchetypeBindings?: readonly HideSpotArchetypeBinding[];
  /**
   * Explicit opt-in for one certified themed pursuer rule. Omitted and null
   * both preserve the original FSM exactly.
   */
  chaserArchetypeProfile?: ChaserArchetypeProfile | null;
}

export type HideInteraction =
  | { kind: "enter"; hideSpotId: string }
  | { kind: "exit"; hideSpotId: string };

export interface HideExitSelection {
  readonly hideSpotId: string;
  readonly selected: HideExitKind;
  readonly options: readonly HideExitOption[];
}

export interface ChaserArchetypeRuntimeView {
  readonly enabled: boolean;
  readonly archetype: ChaserArchetypeProfile["kind"] | null;
  readonly rule: ChaserArchetypeProfile["rule"] | null;
  readonly phase: "idle" | "telegraph" | "acting";
  readonly warningSeconds: number;
  readonly cueProgress: number;
  readonly cueLabel: string | null;
  readonly cueAudioToken: string | null;
  readonly cueAnimationToken: string | null;
  readonly action: ChaserArchetypeAction["type"] | null;
  /** Public navigation intent only; never a concealed or live player point. */
  readonly navigationTarget: Point | null;
  readonly speedMultiplier: number;
}

interface ActiveChaserArchetypeAction {
  readonly action: ChaserArchetypeAction;
  readonly startHeading: Point;
  elapsedSeconds: number;
  reachedSeconds: number;
}

const ZERO_INTENT: MoveIntent = Object.freeze({ x: 0, y: 0 });
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Movement cadence is part of the gameplay/animation contract. Chase keeps
 * the authored top speed, patrol and locker approach use a deliberate walk,
 * lost-sight preserves momentum toward frozen evidence, while the explicit
 * arrival scan stops translation for its authored left/right performance.
 * Search moves slowly between nearby points only after that sweep completes.
 */
export function chaserSpeedForMode(mode: ChaserMode, topSpeed: number): number {
  switch (mode) {
    case "patrol": return topSpeed * 0.45;
    case "chase": return topSpeed;
    case "lost-sight":
    case "go-to-last-known": return topSpeed * 0.88;
    case "search": return topSpeed * 0.35;
    case "check-hide": return topSpeed * 0.45;
    case "spawn-delay":
    case "suspicious":
    case "scan-last-known": return 0;
  }
}

function copyPoint(point: Point): Point {
  return { x: point.x, y: point.y };
}

const smootherstep = (value: number) => {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

function copyPlayer(player: PlayerState): PlayerState {
  return { ...player, position: copyPoint(player.position), heading: copyPoint(player.heading) };
}

function setPlayerMode(state: GameState, mode: PlayerMode, events: SimulationEvent[]) {
  if (state.player.mode === mode) return;
  const from = state.player.mode;
  state.player.mode = mode;
  events.push({ type: "player-mode-changed", from, to: mode });
}

function setPhase(state: GameState, phase: GamePhase, events: SimulationEvent[]) {
  if (state.phase === phase) return;
  const from = state.phase;
  state.phase = phase;
  events.push({ type: "phase-changed", from, to: phase });
}

export class GameSimulation {
  readonly level: LevelDefinition;
  readonly config: GameConfig;

  private state: GameState;
  private readonly planner: GridPathPlanner;
  private accumulatorSeconds = 0;
  private pendingInteract = false;
  private heldMove: MoveIntent = { ...ZERO_INTENT };
  private heldPeek = false;
  private heldSneak = false;
  private heldEnvironmentSoundMasking = 0;
  private heldVisionRangeMultiplier = 1;
  private heldExitEnabled = true;
  private heldHideExitChoice: HideExitKind = "origin";
  private pendingSound: SoundStimulus | null = null;
  private playerSoundCooldownSeconds = 0;
  private readonly initialPlayerPosition: Point;
  private readonly initialPlayerHeading: Point;
  private readonly initialChaserPosition: Point;
  private readonly initialChaserHeading: Point;
  private readonly hideArchetypeBindings: readonly HideSpotArchetypeBinding[];
  private readonly resolvedHideSpots: ReadonlyMap<string, ResolvedHideSpotArchetype>;
  private readonly chaserArchetypeProfile: ChaserArchetypeProfile | null;
  private chaserArchetypeState: ChaserArchetypeState = createInitialChaserArchetypeState();
  private activeChaserArchetypeAction: ActiveChaserArchetypeAction | null = null;
  private campusPatrolArrivalArmed = true;
  private campusPatrolArrivalSequence = 0;
  private selectedHideExit: HideExitKind | null = null;
  private hideTurnPlan: {
    startYaw: number;
    segmentRadians: number;
    segmentDurationSeconds: number;
    cycleCount: number;
    elapsedSeconds: number;
  } | null = null;

  constructor(options: GameSimulationOptions = {}) {
    this.level = options.level ?? createDefaultLevel();
    this.config = { ...DEFAULT_GAME_CONFIG, ...options.config };
    if (options.config?.hideEnterSeconds !== undefined && options.config.hideEnterExposureSeconds === undefined) {
      this.config.hideEnterExposureSeconds = options.config.hideEnterSeconds
        * (DEFAULT_GAME_CONFIG.hideEnterExposureSeconds / DEFAULT_GAME_CONFIG.hideEnterSeconds);
    }
    if (options.config?.hideExitSeconds !== undefined && options.config.hideExitExposureSeconds === undefined) {
      this.config.hideExitExposureSeconds = options.config.hideExitSeconds
        * (DEFAULT_GAME_CONFIG.hideExitExposureSeconds / DEFAULT_GAME_CONFIG.hideExitSeconds);
    }
    this.validateConfig();
    const hideAudit = auditHideArchetypeBindings(this.level, options.hideArchetypeBindings ?? []);
    if (!hideAudit.passed) {
      throw new Error(`Invalid hide archetype configuration: ${hideAudit.failures.join("; ")}`);
    }
    this.hideArchetypeBindings = Object.freeze([...(options.hideArchetypeBindings ?? [])]);
    this.resolvedHideSpots = new Map(hideAudit.resolved.map((spot) => [spot.hideSpotId, spot]));
    this.chaserArchetypeProfile = options.chaserArchetypeProfile ?? null;
    if (
      this.chaserArchetypeProfile
      && (
        !Number.isFinite(this.chaserArchetypeProfile.warningSeconds)
        || this.chaserArchetypeProfile.warningSeconds < 0.5
      )
    ) throw new Error("Chaser archetype warning must be at least 0.5 seconds");
    this.initialPlayerPosition = copyPoint(options.initialPlayerPosition ?? this.level.playerStart);
    this.initialPlayerHeading = normalizeVector(options.initialPlayerHeading ?? { x: 0, y: 1 });
    this.initialChaserPosition = copyPoint(options.initialChaserPosition ?? this.level.chaserStart);
    this.initialChaserHeading = normalizeVector(options.initialChaserHeading ?? this.level.chaserStartHeading);
    this.planner = new GridPathPlanner(this.level);
    this.state = this.makeInitialState(options.autoStart ? "playing" : "ready");
  }

  start() {
    this.state = this.makeInitialState("playing");
    this.accumulatorSeconds = 0;
    this.pendingInteract = false;
    this.heldMove = { ...ZERO_INTENT };
    this.heldPeek = false;
    this.heldSneak = false;
    this.heldEnvironmentSoundMasking = 0;
    this.heldVisionRangeMultiplier = 1;
    this.heldExitEnabled = true;
    this.heldHideExitChoice = "origin";
    this.pendingSound = null;
    this.playerSoundCooldownSeconds = 0;
    this.selectedHideExit = null;
    this.hideTurnPlan = null;
    this.chaserArchetypeState = createInitialChaserArchetypeState();
    this.activeChaserArchetypeAction = null;
    this.campusPatrolArrivalArmed = true;
    this.campusPatrolArrivalSequence = 0;
    this.planner.clear();
    return this.getState();
  }

  reset() {
    return this.start();
  }

  /**
   * Advances arbitrary render-frame time through a deterministic fixed-step
   * accumulator. Edge-triggered interaction input is retained until consumed.
   */
  advance(realDeltaSeconds: number, input: SimulationInput = {}): GameState {
    if (!Number.isFinite(realDeltaSeconds) || realDeltaSeconds < 0) throw new Error("Delta time must be a finite non-negative number");
    this.heldMove = copyPoint(input.move ?? ZERO_INTENT);
    this.heldPeek = input.peekHeld ?? false;
    this.heldSneak = input.sneakHeld ?? false;
    this.heldEnvironmentSoundMasking = Number.isFinite(input.environmentSoundMasking)
      ? clamp01(input.environmentSoundMasking ?? 0)
      : 0;
    this.heldVisionRangeMultiplier = Number.isFinite(input.visionRangeMultiplier)
      ? Math.min(1, Math.max(0.5, input.visionRangeMultiplier ?? 1))
      : 1;
    this.heldExitEnabled = input.exitEnabled !== false;
    if (input.hideExitChoice !== undefined) {
      if (input.hideExitChoice !== "origin" && input.hideExitChoice !== "alternate") {
        throw new Error(`Unknown hide exit choice: ${String(input.hideExitChoice)}`);
      }
      this.heldHideExitChoice = input.hideExitChoice;
    }
    this.pendingInteract ||= input.interactPressed ?? false;
    this.accumulatorSeconds += Math.min(realDeltaSeconds, this.config.maxFrameDeltaSeconds);
    const frameEvents: SimulationEvent[] = [];

    while (this.accumulatorSeconds + 1e-12 >= this.config.fixedStepSeconds) {
      frameEvents.push(...this.fixedStep({
        move: this.heldMove,
        peekHeld: this.heldPeek,
        sneakHeld: this.heldSneak,
        interactPressed: this.pendingInteract,
        exitEnabled: this.heldExitEnabled,
        hideExitChoice: this.heldHideExitChoice,
      }));
      this.pendingInteract = false;
      this.accumulatorSeconds -= this.config.fixedStepSeconds;
    }
    this.state.events = frameEvents;
    return this.getState();
  }

  /** UI-only interaction hint. ChaserBrain never receives this result. */
  getHideInteraction(): HideInteraction | null {
    if (this.state.player.mode === "hidden" && this.state.player.hideSpotId) {
      return { kind: "exit", hideSpotId: this.state.player.hideSpotId };
    }
    if (this.state.player.mode !== "free") return null;
    const spot = this.nearestAvailableHideSpot();
    return spot ? { kind: "enter", hideSpotId: spot.id } : null;
  }

  /** Public authored descriptor for UI/render; never includes runtime occupancy. */
  getHideSpotArchetype(hideSpotId: string): ResolvedHideSpotArchetype | null {
    return this.resolvedHideSpots.get(hideSpotId) ?? null;
  }

  /** Descriptor for the spot currently being aligned with, occupied, or exited. */
  getActiveHideSpotArchetype(): ResolvedHideSpotArchetype | null {
    const hideSpotId = this.state.player.hideSpotId;
    return hideSpotId ? this.getHideSpotArchetype(hideSpotId) : null;
  }

  /** Public selection/options for traversal-exit affordances in the renderer. */
  getHideExitSelection(): HideExitSelection | null {
    const active = this.getActiveHideSpotArchetype();
    if (!active) return null;
    return Object.freeze({
      hideSpotId: active.hideSpotId,
      selected: this.selectedHideExit ?? "origin",
      options: hideExitOptions(active),
    });
  }

  /**
   * Presentation-only themed rule state. Every target in this view is derived
   * from public level geometry or sampled perception evidence.
   */
  getChaserArchetypeRuntime(): ChaserArchetypeRuntimeView {
    const profile = this.chaserArchetypeProfile;
    if (!profile) {
      return Object.freeze({
        enabled: false,
        archetype: null,
        rule: null,
        phase: "idle",
        warningSeconds: 0,
        cueProgress: 0,
        cueLabel: null,
        cueAudioToken: null,
        cueAnimationToken: null,
        action: null,
        navigationTarget: null,
        speedMultiplier: 1,
      });
    }
    const active = this.activeChaserArchetypeAction;
    return Object.freeze({
      enabled: true,
      archetype: profile.kind,
      rule: profile.rule,
      phase: this.chaserArchetypeState.phase === "telegraph"
        ? "telegraph"
        : active
          ? "acting"
          : "idle",
      warningSeconds: profile.warningSeconds,
      cueProgress: this.chaserArchetypeState.phase === "telegraph"
        ? Math.min(
            1,
            this.chaserArchetypeState.telegraphElapsedSeconds / profile.warningSeconds,
          )
        : 0,
      cueLabel: this.chaserArchetypeState.phase === "telegraph" ? profile.cueLabel : null,
      cueAudioToken: this.chaserArchetypeState.phase === "telegraph"
        ? profile.cueAudioToken
        : null,
      cueAnimationToken: this.chaserArchetypeState.phase === "telegraph"
        ? profile.cueAnimationToken
        : null,
      action: active?.action.type ?? null,
      navigationTarget: active ? this.archetypeActionTarget(active.action) : null,
      speedMultiplier: active ? this.archetypeActionSpeedMultiplier(active.action) : 1,
    });
  }

  getState(): GameState {
    return {
      ...this.state,
      player: copyPlayer(this.state.player),
      chaser: {
        ...this.state.chaser,
        position: copyPoint(this.state.chaser.position),
        heading: copyPoint(this.state.chaser.heading),
        scanOriginHeading: copyPoint(this.state.chaser.scanOriginHeading),
        inspectedHideSpotIds: [...this.state.chaser.inspectedHideSpotIds],
        memory: {
          ...this.state.chaser.memory,
          lastKnownPosition: this.state.chaser.memory.lastKnownPosition
            ? copyPoint(this.state.chaser.memory.lastKnownPosition)
            : null,
          deferredSoundEvidence: this.state.chaser.memory.deferredSoundEvidence
            ? {
                ...this.state.chaser.memory.deferredSoundEvidence,
                position: copyPoint(this.state.chaser.memory.deferredSoundEvidence.position),
              }
            : null,
          evidenceTrail: this.state.chaser.memory.evidenceTrail?.map((entry) => ({
            ...entry,
            position: copyPoint(entry.position),
          })),
        },
      },
      hideSpots: Object.fromEntries(Object.entries(this.state.hideSpots).map(([id, spot]) => [id, { ...spot }])),
      events: this.state.events.map((event) => ({ ...event })),
    };
  }

  /**
   * Queues one authored world sound for the next perception tick. This is the
   * integration point for MechanicInstanceStep.emittedSoundStimulus; the
   * stimulus still goes through navigable distance and uncertainty sampling.
   */
  emitWorldSound(stimulus: SoundStimulus): boolean {
    if (
      !Number.isFinite(stimulus.position.x)
      || !Number.isFinite(stimulus.position.y)
      || !Number.isFinite(stimulus.strength)
      || stimulus.strength <= 0
    ) return false;
    const normalized: SoundStimulus = {
      ...stimulus,
      position: copyPoint(stimulus.position),
      strength: clamp01(stimulus.strength),
    };
    if (this.pendingSound && this.pendingSound.strength >= normalized.strength) return false;
    this.pendingSound = normalized;
    return true;
  }

  private validateConfig() {
    const positive = [
      "fixedStepSeconds",
      "maxFrameDeltaSeconds",
      "aiTickSeconds",
      "visionRange",
      "catchRange",
      "hideInteractRange",
      "hideAlignSpeed",
      "hideAlignTurnSpeed",
      "hideEnterSeconds",
      "hideEnterExposureSeconds",
      "hideExitSeconds",
      "hideExitExposureSeconds",
      "peekEnterSeconds",
      "peekExitSeconds",
      "lastKnownScanSeconds",
      "suspiciousSeconds",
      "lostSightGraceSeconds",
      "searchSeconds",
      "searchWaypointSeconds",
      "checkHideSeconds",
      "hearingRange",
    ] as const;
    for (const name of positive) {
      if (!(this.config[name] > 0)) throw new Error(`${name} must be greater than zero`);
    }
    if (this.config.visionConeDegrees <= 0 || this.config.visionConeDegrees > 360) {
      throw new Error("visionConeDegrees must be in (0, 360]");
    }
    if (!Number.isInteger(this.config.searchHideCheckBudget) || this.config.searchHideCheckBudget < 0) {
      throw new Error("searchHideCheckBudget must be a non-negative integer");
    }
    if (this.config.searchHideRadiusCells < 0 || !Number.isFinite(this.config.searchHideRadiusCells)) {
      throw new Error("searchHideRadiusCells must be a finite non-negative number");
    }
    if (this.config.soundUncertaintyCells < 0 || !Number.isFinite(this.config.soundUncertaintyCells)) {
      throw new Error("soundUncertaintyCells must be a finite non-negative number");
    }
    if (this.config.hideExitExposureSeconds >= this.config.hideExitSeconds) {
      throw new Error("hideExitExposureSeconds must be shorter than hideExitSeconds");
    }
    if (this.config.hideEnterExposureSeconds >= this.config.hideEnterSeconds) {
      throw new Error("hideEnterExposureSeconds must be shorter than hideEnterSeconds");
    }
  }

  private makeInitialState(phase: GamePhase): GameState {
    return {
      phase,
      captureReason: null,
      elapsedSeconds: 0,
      tick: 0,
      player: {
        position: copyPoint(this.initialPlayerPosition),
        heading: copyPoint(this.initialPlayerHeading),
        mode: "free",
        hideSpotId: null,
        transitionRemainingSeconds: 0,
        hideTurnDirection: 0,
        hideTurnCycle: -1,
        hideTurnSegmentDurationSeconds: 0,
      },
      chaser: createInitialChaser(this.level, this.config, this.initialChaserPosition, this.initialChaserHeading),
      hideSpots: Object.fromEntries(this.level.hideSpots.map((spot) => [spot.id, { id: spot.id, occupiedByPlayer: false }])),
      aiAccumulatorSeconds: 0,
      events: [],
    };
  }

  private fixedStep(
    input: Required<Pick<
      SimulationInput,
      "move" | "peekHeld" | "sneakHeld" | "interactPressed" | "exitEnabled" | "hideExitChoice"
    >>,
  ): SimulationEvent[] {
    const events: SimulationEvent[] = [];
    if (this.state.phase !== "playing") return events;

    const delta = this.config.fixedStepSeconds;
    this.state.elapsedSeconds += delta;
    this.state.tick += 1;
    this.playerSoundCooldownSeconds = Math.max(0, this.playerSoundCooldownSeconds - delta);
    const playerBefore = copyPoint(this.state.player.position);
    const modeBefore = this.state.player.mode;
    this.updatePlayer(input, delta, events);
    this.updatePlayerSound(playerBefore, modeBefore, input, delta);
    this.updateActiveChaserArchetypeAction(delta, events);
    this.updateChaserBrain(delta, events);
    this.moveChaser(delta);

    if (this.resolveNormalCapture()) {
      this.capturePlayer(events, this.normalCaptureReason());
      return events;
    }
    if (
      input.exitEnabled
      && this.state.player.mode === "free"
      && distanceBetween(this.state.player.position, this.level.exit) <= this.config.exitRange
    ) {
      setPlayerMode(this.state, "escaped", events);
      setPhase(this.state, "won", events);
    }
    return events;
  }

  private hideTiming(resolved: ResolvedHideSpotArchetype) {
    const timing = resolved.profile.timing;
    return {
      enterSeconds: this.config.hideEnterSeconds * timing.enterDurationMultiplier,
      enterExposureSeconds: this.config.hideEnterExposureSeconds * timing.enterDurationMultiplier,
      exitSeconds: this.config.hideExitSeconds * timing.exitDurationMultiplier,
      exitExposureSeconds: this.config.hideExitExposureSeconds * timing.exitDurationMultiplier,
      peekEnterSeconds: this.config.peekEnterSeconds * timing.peekDurationMultiplier,
      peekExitSeconds: this.config.peekExitSeconds * timing.peekDurationMultiplier,
    };
  }

  private activePerceptionConfig(resolved: ResolvedHideSpotArchetype | null): GameConfig {
    if (!resolved) return this.config;
    const timing = this.hideTiming(resolved);
    return {
      ...this.config,
      hideEnterSeconds: timing.enterSeconds,
      hideEnterExposureSeconds: timing.enterExposureSeconds,
      hideExitSeconds: timing.exitSeconds,
      hideExitExposureSeconds: timing.exitExposureSeconds,
      peekEnterSeconds: timing.peekEnterSeconds || this.config.peekEnterSeconds,
      peekExitSeconds: timing.peekExitSeconds || this.config.peekExitSeconds,
    };
  }

  private activeVisualExposureMultiplier(resolved: ResolvedHideSpotArchetype | null): number {
    if (!resolved) return 1;
    switch (this.state.player.mode) {
      case "hidden":
        return resolved.profile.evidence.occupiedVisualDisturbance;
      case "entering-hide":
        return hideTransitionEvidence(resolved, "enter").visualExposureMultiplier;
      case "entering-peek":
      case "peeking":
      case "exiting-peek":
        return resolved.profile.capabilities.canPeek
          ? hideTransitionEvidence(resolved, "peek").visualExposureMultiplier
          : 0;
      case "free":
      case "aligning-hide":
      case "exiting-hide":
      case "caught":
      case "escaped":
        return 1;
    }
  }

  private selectedExitFor(
    resolved: ResolvedHideSpotArchetype,
    requested: HideExitKind,
  ): HideExitKind {
    return requested === "alternate"
      && resolved.profile.capabilities.canExitAlternate
      && resolved.alternateExit
      ? "alternate"
      : "origin";
  }

  private beginHideEntry(
    spot: HideSpotDefinition,
    events: SimulationEvent[],
  ) {
    const resolved = this.resolvedHideSpots.get(spot.id);
    if (!resolved) throw new Error(`Missing resolved hide spot ${spot.id}`);
    this.state.player.transitionRemainingSeconds = this.hideTiming(resolved).enterSeconds;
    this.state.hideSpots[spot.id].occupiedByPlayer = true;
    this.selectedHideExit = "origin";
    this.heldHideExitChoice = "origin";
    setPlayerMode(this.state, "entering-hide", events);
  }

  private updatePlayer(
    input: Required<Pick<
      SimulationInput,
      "move" | "peekHeld" | "sneakHeld" | "interactPressed" | "hideExitChoice"
    >>,
    delta: number,
    events: SimulationEvent[],
  ) {
    const player = this.state.player;
    switch (player.mode) {
      case "free": {
        if (input.interactPressed) {
          const spot = this.nearestAvailableHideSpot();
          if (spot) {
            player.hideSpotId = spot.id;
            player.transitionRemainingSeconds = 0;
            player.hideTurnDirection = 0;
            player.hideTurnCycle = -1;
            player.hideTurnSegmentDurationSeconds = 0;
            this.hideTurnPlan = null;
            this.selectedHideExit = "origin";
            this.heldHideExitChoice = "origin";
            setPlayerMode(this.state, "aligning-hide", events);
            return;
          }
        }
        const before = player.position;
        const movement = moveWithCollision(
          this.level,
          before,
          input.move,
          this.config.playerSpeed * (input.sneakHeld ? 0.58 : 1),
          delta,
        );
        player.position = movement.position;
        if (
          distanceBetween(before, movement.position) > 1e-9
          && Math.hypot(movement.heading.x, movement.heading.y) > 1e-9
        ) player.heading = movement.heading;
        break;
      }
      case "aligning-hide": {
        if (input.interactPressed || Math.hypot(input.move.x, input.move.y) > 0.1) {
          player.hideSpotId = null;
          player.transitionRemainingSeconds = 0;
          player.hideTurnDirection = 0;
          player.hideTurnCycle = -1;
          player.hideTurnSegmentDurationSeconds = 0;
          this.hideTurnPlan = null;
          this.selectedHideExit = null;
          this.heldHideExitChoice = "origin";
          setPlayerMode(this.state, "free", events);
          break;
        }
        const spot = player.hideSpotId
          ? this.level.hideSpots.find((candidate) => candidate.id === player.hideSpotId)
          : null;
        if (!spot) {
          player.hideSpotId = null;
          this.hideTurnPlan = null;
          this.selectedHideExit = null;
          this.heldHideExitChoice = "origin";
          setPlayerMode(this.state, "free", events);
          break;
        }
        const offset = { x: spot.approach.x - player.position.x, y: spot.approach.y - player.position.y };
        const distance = Math.hypot(offset.x, offset.y);
        const step = this.config.hideAlignSpeed * delta;
        if (distance <= step + 1e-9) {
          player.position = copyPoint(spot.approach);
          const targetHeading = normalizeVector(spot.facing);
          if (!this.hideTurnPlan) {
            const startYaw = Math.atan2(player.heading.x, player.heading.y);
            const targetYaw = Math.atan2(targetHeading.x, targetHeading.y);
            const signedRadians = Math.atan2(
              Math.sin(targetYaw - startYaw),
              Math.cos(targetYaw - startYaw),
            );
            if (Math.abs(signedRadians) <= 1e-5) {
              player.heading = targetHeading;
              this.beginHideEntry(spot, events);
              break;
            }
            const cycleCount = Math.abs(signedRadians) > Math.PI * 0.75 ? 2 : 1;
            const segmentRadians = signedRadians / cycleCount;
            const segmentDurationSeconds = Math.abs(segmentRadians) / this.config.hideAlignTurnSpeed;
            this.hideTurnPlan = {
              startYaw,
              segmentRadians,
              segmentDurationSeconds,
              cycleCount,
              elapsedSeconds: 0,
            };
            player.hideTurnDirection = Math.sign(signedRadians) as -1 | 1;
            player.hideTurnCycle = 0;
            player.hideTurnSegmentDurationSeconds = segmentDurationSeconds;
          }

          const turn = this.hideTurnPlan;
          turn.elapsedSeconds = Math.min(
            turn.elapsedSeconds + delta,
            turn.segmentDurationSeconds * turn.cycleCount,
          );
          const cycle = Math.min(
            turn.cycleCount - 1,
            Math.floor((turn.elapsedSeconds + 1e-9) / turn.segmentDurationSeconds),
          );
          const cycleElapsed = turn.elapsedSeconds - cycle * turn.segmentDurationSeconds;
          const cycleProgress = clamp01(cycleElapsed / turn.segmentDurationSeconds);
          const yaw = turn.startYaw + turn.segmentRadians * (cycle + smootherstep(cycleProgress));
          player.heading = { x: Math.sin(yaw), y: Math.cos(yaw) };
          player.hideTurnCycle = cycle;
          if (turn.elapsedSeconds >= turn.segmentDurationSeconds * turn.cycleCount - 1e-9) {
            player.heading = targetHeading;
            player.hideTurnDirection = 0;
            player.hideTurnCycle = -1;
            player.hideTurnSegmentDurationSeconds = 0;
            this.hideTurnPlan = null;
            this.beginHideEntry(spot, events);
          }
        } else {
          const heading = normalizeVector(offset);
          player.position = { x: player.position.x + heading.x * step, y: player.position.y + heading.y * step };
          player.heading = heading;
          player.hideTurnDirection = 0;
          player.hideTurnCycle = -1;
          player.hideTurnSegmentDurationSeconds = 0;
          this.hideTurnPlan = null;
        }
        break;
      }
      case "entering-hide":
        player.transitionRemainingSeconds = Math.max(0, player.transitionRemainingSeconds - delta);
        if (player.transitionRemainingSeconds <= 1e-9) setPlayerMode(this.state, "hidden", events);
        break;
      case "hidden": {
        const resolved = player.hideSpotId
          ? this.resolvedHideSpots.get(player.hideSpotId) ?? null
          : null;
        if (!resolved) {
          player.hideSpotId = null;
          this.selectedHideExit = null;
          this.heldHideExitChoice = "origin";
          setPlayerMode(this.state, "free", events);
          break;
        }
        this.selectedHideExit = this.selectedExitFor(resolved, input.hideExitChoice);
        if (input.interactPressed) {
          player.transitionRemainingSeconds = this.hideTiming(resolved).exitSeconds;
          setPlayerMode(this.state, "exiting-hide", events);
        } else if (input.peekHeld && resolved.profile.capabilities.canPeek) {
          player.transitionRemainingSeconds = this.hideTiming(resolved).peekEnterSeconds;
          setPlayerMode(this.state, "entering-peek", events);
        }
        break;
      }
      case "entering-peek": {
        const resolved = player.hideSpotId
          ? this.resolvedHideSpots.get(player.hideSpotId) ?? null
          : null;
        const timing = resolved ? this.hideTiming(resolved) : null;
        if (!input.peekHeld) {
          const enterSeconds = timing?.peekEnterSeconds || this.config.peekEnterSeconds;
          const exitSeconds = timing?.peekExitSeconds || this.config.peekExitSeconds;
          const openFraction = 1 - player.transitionRemainingSeconds / enterSeconds;
          player.transitionRemainingSeconds = exitSeconds * clamp01(openFraction);
          setPlayerMode(this.state, "exiting-peek", events);
          break;
        }
        player.transitionRemainingSeconds = Math.max(0, player.transitionRemainingSeconds - delta);
        if (player.transitionRemainingSeconds <= 1e-9) setPlayerMode(this.state, "peeking", events);
        break;
      }
      case "peeking":
        if (!input.peekHeld) {
          const resolved = player.hideSpotId
            ? this.resolvedHideSpots.get(player.hideSpotId) ?? null
            : null;
          player.transitionRemainingSeconds = resolved
            ? this.hideTiming(resolved).peekExitSeconds
            : this.config.peekExitSeconds;
          setPlayerMode(this.state, "exiting-peek", events);
        }
        break;
      case "exiting-peek": {
        const resolved = player.hideSpotId
          ? this.resolvedHideSpots.get(player.hideSpotId) ?? null
          : null;
        const timing = resolved ? this.hideTiming(resolved) : null;
        if (input.peekHeld) {
          const exitSeconds = timing?.peekExitSeconds || this.config.peekExitSeconds;
          const enterSeconds = timing?.peekEnterSeconds || this.config.peekEnterSeconds;
          const openFraction = player.transitionRemainingSeconds / exitSeconds;
          player.transitionRemainingSeconds = enterSeconds * (1 - clamp01(openFraction));
          setPlayerMode(this.state, "entering-peek", events);
          break;
        }
        player.transitionRemainingSeconds = Math.max(0, player.transitionRemainingSeconds - delta);
        if (player.transitionRemainingSeconds <= 1e-9) setPlayerMode(this.state, "hidden", events);
        break;
      }
      case "exiting-hide":
        player.transitionRemainingSeconds = Math.max(0, player.transitionRemainingSeconds - delta);
        if (player.transitionRemainingSeconds <= 1e-9) {
          const resolved = player.hideSpotId
            ? this.resolvedHideSpots.get(player.hideSpotId) ?? null
            : null;
          const selectedExit = resolved
            ? hideExitOptions(resolved).find((option) => (
                option.kind === (this.selectedHideExit ?? "origin")
              ))
            : null;
          if (selectedExit) {
            const offset = {
              x: selectedExit.position.x - player.position.x,
              y: selectedExit.position.y - player.position.y,
            };
            player.position = copyPoint(selectedExit.position);
            if (Math.hypot(offset.x, offset.y) > 1e-9) {
              player.heading = normalizeVector(offset, player.heading);
            }
          }
          if (player.hideSpotId && this.state.hideSpots[player.hideSpotId]) {
            this.state.hideSpots[player.hideSpotId].occupiedByPlayer = false;
          }
          player.hideSpotId = null;
          this.selectedHideExit = null;
          this.heldHideExitChoice = "origin";
          setPlayerMode(this.state, "free", events);
        }
        break;
      case "caught":
      case "escaped":
        break;
    }
  }

  private queuePlayerSound(
    position: Point,
    strength: number,
    sourceType: "player-movement" | "hide-interaction" = "player-movement",
    sourceId?: string,
    confidence?: number,
    decayPerSecond?: number,
  ) {
    const normalized = Math.min(
      1,
      Math.max(0, strength * (1 - this.heldEnvironmentSoundMasking)),
    );
    if (normalized <= 0) return;
    if (this.pendingSound && this.pendingSound.strength >= normalized) return;
    this.pendingSound = {
      position: copyPoint(position),
      strength: normalized,
      sourceType,
      ...(sourceId ? { sourceId } : {}),
      confidence: confidence ?? (sourceType === "hide-interaction" ? 0.85 : 0.72),
      decayPerSecond: decayPerSecond ?? (sourceType === "hide-interaction" ? 0.16 : 0.2),
    };
  }

  private queueHideTransitionSound(
    resolved: ResolvedHideSpotArchetype,
    transition: "enter" | "exit-origin" | "exit-alternate" | "peek",
  ) {
    const sound = hideTransitionEvidence(resolved, transition).sound;
    if (!sound) return;
    this.queuePlayerSound(
      sound.position,
      sound.strength,
      "hide-interaction",
      sound.sourceId,
      sound.confidence,
      sound.decayPerSecond,
    );
  }

  private updatePlayerSound(
    before: Point,
    modeBefore: PlayerMode,
    input: Required<Pick<SimulationInput, "move" | "peekHeld" | "sneakHeld" | "interactPressed">>,
    delta: number,
  ) {
    const moved = distanceBetween(before, this.state.player.position);
    const requestedMovement = Math.hypot(input.move.x, input.move.y) > 0.1;
    const movementMode = modeBefore === "free" || modeBefore === "aligning-hide";
    if (movementMode && moved > delta * 0.05 && this.playerSoundCooldownSeconds <= 1e-9) {
      this.queuePlayerSound(
        this.state.player.position,
        modeBefore === "aligning-hide" ? 0.24 : input.sneakHeld ? 0.1 : 0.46,
      );
      this.playerSoundCooldownSeconds = modeBefore === "free" && input.sneakHeld ? 0.56 : 0.32;
    } else if (
      modeBefore === "free"
      && requestedMovement
      && moved <= delta * 0.05
      && this.playerSoundCooldownSeconds <= 1e-9
    ) {
      // A full-speed collision is a readable mistake, not a perfect sonar
      // ping: sampleSoundPerception still applies path distance and error.
      this.queuePlayerSound(this.state.player.position, input.sneakHeld ? 0.08 : 0.32);
      this.playerSoundCooldownSeconds = 0.48;
    }

    const modeAfter = this.state.player.mode;
    if (modeAfter !== modeBefore) {
      const resolved = this.state.player.hideSpotId
        ? this.resolvedHideSpots.get(this.state.player.hideSpotId) ?? null
        : null;
      if (modeAfter === "entering-hide") {
        if (resolved) this.queueHideTransitionSound(resolved, "enter");
        this.playerSoundCooldownSeconds = Math.max(this.playerSoundCooldownSeconds, 0.42);
      } else if (modeAfter === "exiting-hide") {
        if (resolved) {
          this.queueHideTransitionSound(
            resolved,
            this.selectedHideExit === "alternate" ? "exit-alternate" : "exit-origin",
          );
        }
        this.playerSoundCooldownSeconds = Math.max(this.playerSoundCooldownSeconds, 0.42);
      } else if (modeAfter === "entering-peek" || modeAfter === "exiting-peek") {
        if (resolved?.profile.capabilities.canPeek) {
          this.queueHideTransitionSound(resolved, "peek");
        }
      }
    }
  }

  private nearestAvailableHideSpot(): HideSpotDefinition | null {
    let nearest: HideSpotDefinition | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const spot of this.level.hideSpots) {
      if (this.state.hideSpots[spot.id]?.occupiedByPlayer) continue;
      const distance = distanceBetween(this.state.player.position, spot.approach);
      if (distance <= this.config.hideInteractRange && distance < nearestDistance) {
        nearest = spot;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private archetypeActionTarget(action: ChaserArchetypeAction): Point | null {
    switch (action.type) {
      case "scan-public-junction":
        return null;
      case "inspect-public-hide-clue":
        return copyPoint(action.approach);
      case "focus-perceived-sound":
        return copyPoint(action.evidence.position);
      case "intercept-public-exit-route":
        return copyPoint(action.interceptTarget);
    }
  }

  private archetypeActionSpeedMultiplier(action: ChaserArchetypeAction): number {
    switch (action.type) {
      case "focus-perceived-sound": return 1.16;
      case "intercept-public-exit-route": return 1.08;
      case "scan-public-junction":
      case "inspect-public-hide-clue":
        return 1;
    }
  }

  private finishChaserArchetypeAction(
    events: SimulationEvent[],
    outcome: "completed" | "interrupted",
  ) {
    const active = this.activeChaserArchetypeAction;
    const profile = this.chaserArchetypeProfile;
    if (!active || !profile) return;
    events.push({
      type: "chaser-archetype-action-finished",
      archetype: profile.kind,
      rule: profile.rule,
      action: active.action.type,
      outcome,
    });
    this.activeChaserArchetypeAction = null;
  }

  private beginChaserArchetypeAction(
    action: ChaserArchetypeAction,
    events: SimulationEvent[],
  ) {
    const profile = this.chaserArchetypeProfile;
    if (!profile) return;
    this.activeChaserArchetypeAction = {
      action,
      startHeading: copyPoint(this.state.chaser.heading),
      elapsedSeconds: 0,
      reachedSeconds: 0,
    };
    if (action.type === "inspect-public-hide-clue") {
      const source = action.exact ? "witnessed" : "search";
      const previousMode = this.state.chaser.mode;
      this.state.chaser = {
        ...this.state.chaser,
        mode: "check-hide",
        modeElapsedSeconds: 0,
        visualConfirmationSeconds: null,
        searchHideSpotId: action.hideSpotId,
        hideCheckSource: source,
        memory: {
          ...this.state.chaser.memory,
          witnessedHideSpotId: action.exact
            ? action.hideSpotId
            : this.state.chaser.memory.witnessedHideSpotId,
        },
      };
      if (previousMode !== "check-hide") {
        events.push({ type: "chaser-mode-changed", from: previousMode, to: "check-hide" });
      }
    }
    events.push({
      type: "chaser-archetype-action-started",
      archetype: profile.kind,
      rule: profile.rule,
      action: action.type,
    });
  }

  private updateActiveChaserArchetypeAction(
    delta: number,
    events: SimulationEvent[],
  ) {
    const active = this.activeChaserArchetypeAction;
    if (!active) return;
    active.elapsedSeconds += delta;
    switch (active.action.type) {
      case "scan-public-junction": {
        const headings = active.action.branchHeadings;
        const segmentSeconds = 0.24;
        const totalSeconds = Math.max(0.72, headings.length * segmentSeconds);
        if (headings.length) {
          const scaled = Math.min(
            headings.length - Number.EPSILON,
            active.elapsedSeconds / totalSeconds * headings.length,
          );
          const index = Math.min(headings.length - 1, Math.floor(scaled));
          const segmentProgress = smootherstep(scaled - index);
          const from = index === 0 ? active.startHeading : headings[index - 1];
          const to = headings[index];
          this.state.chaser.heading = normalizeVector({
            x: from.x + (to.x - from.x) * segmentProgress,
            y: from.y + (to.y - from.y) * segmentProgress,
          }, to);
        }
        if (active.elapsedSeconds + 1e-9 >= totalSeconds) {
          this.finishChaserArchetypeAction(events, "completed");
        }
        break;
      }
      case "focus-perceived-sound":
      case "intercept-public-exit-route": {
        const target = this.archetypeActionTarget(active.action);
        const reached = Boolean(
          target && distanceBetween(this.state.chaser.position, target) <= 0.12,
        );
        active.reachedSeconds = reached ? active.reachedSeconds + delta : 0;
        if (active.reachedSeconds + 1e-9 >= 0.35) {
          this.finishChaserArchetypeAction(events, "completed");
        } else if (active.elapsedSeconds >= 10) {
          // Targets are generated from a valid public path. This guard keeps a
          // future malformed level from pinning the rule forever.
          this.finishChaserArchetypeAction(events, "interrupted");
        }
        break;
      }
      case "inspect-public-hide-clue":
        if (active.elapsedSeconds >= 12) {
          this.finishChaserArchetypeAction(events, "interrupted");
        }
        break;
    }
  }

  private perceptionStimulusId(
    evidence: Exclude<PerceptionEvidence, { kind: "none" }>,
  ): string {
    const point = `${evidence.position.x.toFixed(3)},${evidence.position.y.toFixed(3)}`;
    if (evidence.kind === "hide-entry-visible") {
      return `hide-entry:${evidence.hideSpotId}:${point}:${evidence.observedAtSeconds.toFixed(3)}`;
    }
    if (evidence.kind === "sound") {
      return `sound:${evidence.sourceType ?? "unknown"}:${evidence.sourceId ?? "anonymous"}:${point}:${evidence.observedAtSeconds.toFixed(3)}`;
    }
    return `visual:${point}:${evidence.observedAtSeconds.toFixed(3)}`;
  }

  private publicChaserArchetypeStimulus(
    evidence: PerceptionEvidence,
    reachedPublicTarget: boolean,
  ): ChaserArchetypeStimulus | null {
    const profile = this.chaserArchetypeProfile;
    if (!profile || this.activeChaserArchetypeAction) return null;
    if (profile.rule === "scan-public-junction") {
      if (this.state.chaser.mode !== "patrol") {
        this.campusPatrolArrivalArmed = true;
        return null;
      }
      if (!reachedPublicTarget) {
        this.campusPatrolArrivalArmed = true;
        return null;
      }
      if (!this.campusPatrolArrivalArmed) return null;
      const target = getChaserTarget(this.state.chaser, this.level);
      if (!target) return null;
      this.campusPatrolArrivalArmed = false;
      this.campusPatrolArrivalSequence += 1;
      return Object.freeze({
        kind: "patrol-arrival",
        id: `patrol-arrival:${this.state.chaser.patrolIndex}:${this.campusPatrolArrivalSequence}`,
        position: Object.freeze(copyPoint(target)),
      });
    }
    if (evidence.kind === "none") return null;
    return Object.freeze({
      kind: "perception",
      id: this.perceptionStimulusId(evidence),
      evidence,
    });
  }

  private stepChaserArchetypeController(
    evidence: PerceptionEvidence,
    reachedPublicTarget: boolean,
    events: SimulationEvent[],
  ): PerceptionEvidence {
    const profile = this.chaserArchetypeProfile;
    if (!profile) return evidence;
    const stimulus = this.publicChaserArchetypeStimulus(evidence, reachedPublicTarget);
    const legalHideCandidates = profile.rule === "inspect-public-hide-clue"
      && stimulus?.kind === "perception"
      ? queryLegalHideCandidates(
          this.level,
          this.hideArchetypeBindings,
          stimulus.evidence,
          {
            maximumRouteDistance: Math.max(4, this.config.searchHideRadiusCells),
            maximumCandidates: 3,
            inspectedHideSpotIds: this.state.chaser.inspectedHideSpotIds,
          },
        )
      : undefined;
    const step = stepChaserArchetype(profile, this.chaserArchetypeState, {
      deltaSeconds: this.config.aiTickSeconds,
      level: this.level,
      stimulus,
      ...(legalHideCandidates ? { legalHideCandidates } : {}),
    });
    this.chaserArchetypeState = step.state;
    for (const event of step.events) {
      if (event.type !== "telegraph-started") continue;
      events.push({
        type: "chaser-archetype-telegraph-started",
        archetype: event.archetype,
        rule: profile.rule,
        warningSeconds: event.warningSeconds,
        cueLabel: event.cueLabel,
        cueAudioToken: event.cueAudioToken,
        cueAnimationToken: event.cueAnimationToken,
      });
    }
    if (!step.action) return evidence;
    this.beginChaserArchetypeAction(step.action, events);
    // The fire rule's active target and speed multiplier are the behavior
    // change. Do not feed the same sample through the evidence ledger twice:
    // a stable public emitter must retain its ordinary habituation count.
    return evidence;
  }

  private updateChaserBrain(delta: number, events: SimulationEvent[]) {
    this.state.aiAccumulatorSeconds += delta;
    if (this.state.chaser.mode === "scan-last-known") {
      // Presentation and perception read the same 60 Hz heading. The lower-
      // frequency brain still owns decisions, while this deterministic pose
      // sampler prevents the vision cone from jumping ahead of the 3D actor.
      this.state.chaser.heading = lastKnownScanHeading(
        this.state.chaser.scanOriginHeading,
        this.state.chaser.modeElapsedSeconds + this.state.aiAccumulatorSeconds,
        this.config.lastKnownScanSeconds,
      );
    }
    while (this.state.aiAccumulatorSeconds + 1e-12 >= this.config.aiTickSeconds) {
      this.state.aiAccumulatorSeconds -= this.config.aiTickSeconds;
      const activeHide = this.getActiveHideSpotArchetype();
      const perceptionConfig = this.activePerceptionConfig(activeHide);
      let evidence = samplePlayerPerception(
        this.level,
        this.state.chaser,
        {
          position: this.state.player.position,
          mode: this.state.player.mode,
          hideSpotId: this.state.player.hideSpotId,
          transitionRemainingSeconds: this.state.player.transitionRemainingSeconds,
          visualExposureMultiplier: this.activeVisualExposureMultiplier(activeHide),
        },
        this.heldVisionRangeMultiplier >= 0.999
          ? perceptionConfig
          : {
              ...perceptionConfig,
              visionRange: perceptionConfig.visionRange * this.heldVisionRangeMultiplier,
            },
        this.state.elapsedSeconds,
      );
      const sampledSound = this.pendingSound
        ? sampleSoundPerception(
          this.level,
          this.state.chaser,
          this.pendingSound,
          this.config,
          this.state.elapsedSeconds,
        )
        : null;
      const secondarySoundEvidence = evidence.kind !== "none" && sampledSound?.kind === "sound"
        ? sampledSound
        : undefined;
      if (evidence.kind === "none" && sampledSound) evidence = sampledSound;
      // A step or door edge is a transient. Consuming it once prevents a
      // single sound from resetting the search timer on every AI tick.
      this.pendingSound = null;
      const reachedPublicTarget = hasReachedChaserTarget(this.state.chaser, this.level);
      evidence = this.stepChaserArchetypeController(
        evidence,
        reachedPublicTarget,
        events,
      );
      const previousMode = this.state.chaser.mode;
      const activeAction = this.activeChaserArchetypeAction?.action ?? null;
      const blocksBaseTargetResolution = this.chaserArchetypeState.phase === "telegraph"
        || Boolean(activeAction && activeAction.type !== "inspect-public-hide-clue");
      const result = stepChaserBrain(this.state.chaser, this.level, this.config, {
        evidence,
        ...(secondarySoundEvidence ? { secondarySoundEvidence } : {}),
        reachedTarget: blocksBaseTargetResolution
          ? false
          : hasReachedChaserTarget(this.state.chaser, this.level),
        nowSeconds: this.state.elapsedSeconds,
        deltaSeconds: this.config.aiTickSeconds,
      });
      this.state.chaser = result.state;
      if (previousMode !== result.state.mode) {
        events.push({ type: "chaser-mode-changed", from: previousMode, to: result.state.mode });
      }
      if (result.completedSoundInvestigation) {
        events.push({
          type: "evidence-investigation-completed",
          evidenceId: result.completedSoundInvestigation.sourceId,
          sourceType: result.completedSoundInvestigation.sourceType,
        });
      }
      if (result.completedHideCheckId) {
        if (
          this.activeChaserArchetypeAction?.action.type === "inspect-public-hide-clue"
          && this.activeChaserArchetypeAction.action.hideSpotId === result.completedHideCheckId
        ) this.finishChaserArchetypeAction(events, "completed");
        const occupied = Boolean(this.state.hideSpots[result.completedHideCheckId]?.occupiedByPlayer);
        events.push({ type: "hide-check-completed", hideSpotId: result.completedHideCheckId, occupied });
        if (occupied) {
          this.capturePlayer(
            events,
            result.completedHideCheckSource === "search"
              ? "search-hide-check"
              : "witnessed-hide-check",
          );
          return;
        }
      }
      const stillActive = this.activeChaserArchetypeAction?.action;
      const publicVisualOverride = evidence.kind === "player-visible"
        || evidence.kind === "hide-entry-visible";
      if (
        stillActive?.type === "focus-perceived-sound"
        && publicVisualOverride
      ) {
        this.finishChaserArchetypeAction(events, "interrupted");
      } else if (
        stillActive?.type === "inspect-public-hide-clue"
        && result.state.mode === "chase"
      ) {
        this.finishChaserArchetypeAction(events, "interrupted");
      } else if (
        stillActive?.type === "intercept-public-exit-route"
        && evidence.kind === "hide-entry-visible"
      ) {
        this.finishChaserArchetypeAction(events, "interrupted");
      }
    }
  }

  private moveChaser(delta: number) {
    if (this.state.phase !== "playing") return;
    if (
      this.chaserArchetypeState.phase === "telegraph"
      || this.activeChaserArchetypeAction?.action.type === "scan-public-junction"
    ) return;
    const activeAction = this.activeChaserArchetypeAction?.action ?? null;
    const target = activeAction
      ? this.archetypeActionTarget(activeAction)
      : getChaserTarget(this.state.chaser, this.level);
    const speed = chaserSpeedForMode(this.state.chaser.mode, this.config.chaserSpeed)
      * (activeAction ? this.archetypeActionSpeedMultiplier(activeAction) : 1);
    if (!target || speed <= 0) return;
    const movement = moveAlongGridPath(this.planner, this.state.chaser.position, target, speed, delta);
    this.state.chaser.position = movement.position;
    if (Math.hypot(movement.heading.x, movement.heading.y) > 1e-9) this.state.chaser.heading = movement.heading;
  }

  private resolveNormalCapture(): boolean {
    if (this.state.phase !== "playing" || this.state.chaser.mode === "spawn-delay") return false;
    const activeHide = this.getActiveHideSpotArchetype();
    if (!isPlayerVisuallyExposed(
      {
        ...this.state.player,
        visualExposureMultiplier: this.activeVisualExposureMultiplier(activeHide),
      },
      this.activePerceptionConfig(activeHide),
    )) return false;
    if (distanceBetween(this.state.player.position, this.state.chaser.position) > this.config.catchRange) return false;
    return hasLineOfSight(this.level, this.state.chaser.position, this.state.player.position);
  }

  private normalCaptureReason(): CaptureReason {
    if (["aligning-hide", "entering-hide"].includes(this.state.player.mode)) {
      return "exposed-hide-entry";
    }
    if (["entering-peek", "peeking", "exiting-peek", "exiting-hide"].includes(this.state.player.mode)) {
      return "unsafe-hide-exit";
    }
    return "direct-contact";
  }

  private capturePlayer(events: SimulationEvent[], reason: CaptureReason) {
    if (this.state.phase !== "playing") return;
    const toPlayer = {
      x: this.state.player.position.x - this.state.chaser.position.x,
      y: this.state.player.position.y - this.state.chaser.position.y,
    };
    const chaserFacing = normalizeVector(toPlayer, this.state.chaser.heading);
    this.state.chaser.heading = chaserFacing;
    this.state.player.heading = { x: -chaserFacing.x, y: -chaserFacing.y };
    const hideSpotId = this.state.player.hideSpotId;
    if (hideSpotId && this.state.hideSpots[hideSpotId]) {
      this.state.hideSpots[hideSpotId].occupiedByPlayer = false;
    }
    this.state.player.hideSpotId = null;
    this.state.player.transitionRemainingSeconds = 0;
    this.state.player.hideTurnDirection = 0;
    this.state.player.hideTurnCycle = -1;
    this.state.player.hideTurnSegmentDurationSeconds = 0;
    this.hideTurnPlan = null;
    this.selectedHideExit = null;
    this.heldHideExitChoice = "origin";
    this.state.captureReason = reason;
    events.push({ type: "player-captured", reason });
    setPlayerMode(this.state, "caught", events);
    setPhase(this.state, "lost", events);
  }
}

export function createGameSimulation(options: GameSimulationOptions = {}) {
  return new GameSimulation(options);
}
