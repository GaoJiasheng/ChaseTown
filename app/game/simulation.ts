import type {
  GameConfig,
  GamePhase,
  GameState,
  ChaserMode,
  HideSpotDefinition,
  LevelDefinition,
  MoveIntent,
  PlayerMode,
  PlayerState,
  Point,
  SimulationEvent,
  SimulationInput,
} from "./contracts.ts";
import { getChaserTarget, hasReachedChaserTarget, createInitialChaser, stepChaserBrain } from "./chaser-fsm.ts";
import { createDefaultLevel, DEFAULT_GAME_CONFIG } from "./level.ts";
import {
  distanceBetween,
  GridPathPlanner,
  hasLineOfSight,
  moveAlongGridPath,
  moveWithCollision,
  normalizeVector,
} from "./navigation.ts";
import { isPlayerVisuallyExposed, samplePlayerPerception } from "./perception.ts";

export interface GameSimulationOptions {
  level?: LevelDefinition;
  config?: Partial<GameConfig>;
  autoStart?: boolean;
  initialPlayerPosition?: Point;
  initialPlayerHeading?: Point;
  initialChaserPosition?: Point;
  initialChaserHeading?: Point;
}

export type HideInteraction =
  | { kind: "enter"; hideSpotId: string }
  | { kind: "exit"; hideSpotId: string };

const ZERO_INTENT: MoveIntent = Object.freeze({ x: 0, y: 0 });
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Movement cadence is part of the gameplay/animation contract. Chase keeps
 * the authored top speed, patrol and locker approach use a deliberate walk,
 * and the lost-sight beat stops translation so its authored reaction cannot
 * visibly foot-slide. Search moves slowly between nearby evidence points.
 */
export function chaserSpeedForMode(mode: ChaserMode, topSpeed: number): number {
  switch (mode) {
    case "patrol": return topSpeed * 0.45;
    case "chase": return topSpeed;
    case "go-to-last-known": return topSpeed * 0.88;
    case "search": return topSpeed * 0.35;
    case "check-hide": return topSpeed * 0.45;
    case "spawn-delay":
    case "suspicious":
    case "lost-sight": return 0;
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
  private readonly initialPlayerPosition: Point;
  private readonly initialPlayerHeading: Point;
  private readonly initialChaserPosition: Point;
  private readonly initialChaserHeading: Point;
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
    this.hideTurnPlan = null;
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
    this.pendingInteract ||= input.interactPressed ?? false;
    this.accumulatorSeconds += Math.min(realDeltaSeconds, this.config.maxFrameDeltaSeconds);
    const frameEvents: SimulationEvent[] = [];

    while (this.accumulatorSeconds + 1e-12 >= this.config.fixedStepSeconds) {
      frameEvents.push(...this.fixedStep({
        move: this.heldMove,
        peekHeld: this.heldPeek,
        interactPressed: this.pendingInteract,
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

  getState(): GameState {
    return {
      ...this.state,
      player: copyPlayer(this.state.player),
      chaser: {
        ...this.state.chaser,
        position: copyPoint(this.state.chaser.position),
        heading: copyPoint(this.state.chaser.heading),
        memory: {
          ...this.state.chaser.memory,
          lastKnownPosition: this.state.chaser.memory.lastKnownPosition
            ? copyPoint(this.state.chaser.memory.lastKnownPosition)
            : null,
        },
      },
      hideSpots: Object.fromEntries(Object.entries(this.state.hideSpots).map(([id, spot]) => [id, { ...spot }])),
      events: this.state.events.map((event) => ({ ...event })),
    };
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
    ] as const;
    for (const name of positive) {
      if (!(this.config[name] > 0)) throw new Error(`${name} must be greater than zero`);
    }
    if (this.config.visionConeDegrees <= 0 || this.config.visionConeDegrees > 360) {
      throw new Error("visionConeDegrees must be in (0, 360]");
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

  private fixedStep(input: Required<Pick<SimulationInput, "move" | "peekHeld" | "interactPressed">>): SimulationEvent[] {
    const events: SimulationEvent[] = [];
    if (this.state.phase !== "playing") return events;

    const delta = this.config.fixedStepSeconds;
    this.state.elapsedSeconds += delta;
    this.state.tick += 1;
    this.updatePlayer(input, delta, events);
    this.updateChaserBrain(delta, events);
    this.moveChaser(delta);

    if (this.resolveNormalCapture()) {
      this.capturePlayer(events);
      return events;
    }
    if (this.state.player.mode === "free" && distanceBetween(this.state.player.position, this.level.exit) <= this.config.exitRange) {
      setPlayerMode(this.state, "escaped", events);
      setPhase(this.state, "won", events);
    }
    return events;
  }

  private updatePlayer(
    input: Required<Pick<SimulationInput, "move" | "peekHeld" | "interactPressed">>,
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
            setPlayerMode(this.state, "aligning-hide", events);
            return;
          }
        }
        const before = player.position;
        const movement = moveWithCollision(this.level, before, input.move, this.config.playerSpeed, delta);
        player.position = movement.position;
        if (
          distanceBetween(before, movement.position) > 1e-9
          && Math.hypot(movement.heading.x, movement.heading.y) > 1e-9
        ) player.heading = movement.heading;
        break;
      }
      case "aligning-hide": {
        const spot = player.hideSpotId
          ? this.level.hideSpots.find((candidate) => candidate.id === player.hideSpotId)
          : null;
        if (!spot) {
          player.hideSpotId = null;
          this.hideTurnPlan = null;
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
              player.transitionRemainingSeconds = this.config.hideEnterSeconds;
              this.state.hideSpots[spot.id].occupiedByPlayer = true;
              setPlayerMode(this.state, "entering-hide", events);
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
            player.transitionRemainingSeconds = this.config.hideEnterSeconds;
            this.state.hideSpots[spot.id].occupiedByPlayer = true;
            player.hideTurnDirection = 0;
            player.hideTurnCycle = -1;
            player.hideTurnSegmentDurationSeconds = 0;
            this.hideTurnPlan = null;
            setPlayerMode(this.state, "entering-hide", events);
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
      case "hidden":
        if (input.interactPressed) {
          player.transitionRemainingSeconds = this.config.hideExitSeconds;
          setPlayerMode(this.state, "exiting-hide", events);
        } else if (input.peekHeld) {
          player.transitionRemainingSeconds = this.config.peekEnterSeconds;
          setPlayerMode(this.state, "entering-peek", events);
        }
        break;
      case "entering-peek": {
        if (!input.peekHeld) {
          const openFraction = 1 - player.transitionRemainingSeconds / this.config.peekEnterSeconds;
          player.transitionRemainingSeconds = this.config.peekExitSeconds * clamp01(openFraction);
          setPlayerMode(this.state, "exiting-peek", events);
          break;
        }
        player.transitionRemainingSeconds = Math.max(0, player.transitionRemainingSeconds - delta);
        if (player.transitionRemainingSeconds <= 1e-9) setPlayerMode(this.state, "peeking", events);
        break;
      }
      case "peeking":
        if (!input.peekHeld) {
          player.transitionRemainingSeconds = this.config.peekExitSeconds;
          setPlayerMode(this.state, "exiting-peek", events);
        }
        break;
      case "exiting-peek": {
        if (input.peekHeld) {
          const openFraction = player.transitionRemainingSeconds / this.config.peekExitSeconds;
          player.transitionRemainingSeconds = this.config.peekEnterSeconds * (1 - clamp01(openFraction));
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
          if (player.hideSpotId && this.state.hideSpots[player.hideSpotId]) {
            this.state.hideSpots[player.hideSpotId].occupiedByPlayer = false;
          }
          player.hideSpotId = null;
          setPlayerMode(this.state, "free", events);
        }
        break;
      case "caught":
      case "escaped":
        break;
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

  private updateChaserBrain(delta: number, events: SimulationEvent[]) {
    this.state.aiAccumulatorSeconds += delta;
    while (this.state.aiAccumulatorSeconds + 1e-12 >= this.config.aiTickSeconds) {
      this.state.aiAccumulatorSeconds -= this.config.aiTickSeconds;
      const evidence = samplePlayerPerception(
        this.level,
        this.state.chaser,
        {
          position: this.state.player.position,
          mode: this.state.player.mode,
          hideSpotId: this.state.player.hideSpotId,
          transitionRemainingSeconds: this.state.player.transitionRemainingSeconds,
        },
        this.config,
        this.state.elapsedSeconds,
      );
      const previousMode = this.state.chaser.mode;
      const result = stepChaserBrain(this.state.chaser, this.level, this.config, {
        evidence,
        reachedTarget: hasReachedChaserTarget(this.state.chaser, this.level),
        nowSeconds: this.state.elapsedSeconds,
        deltaSeconds: this.config.aiTickSeconds,
      });
      this.state.chaser = result.state;
      if (previousMode !== result.state.mode) {
        events.push({ type: "chaser-mode-changed", from: previousMode, to: result.state.mode });
      }
      if (result.completedHideCheckId) {
        const occupied = Boolean(this.state.hideSpots[result.completedHideCheckId]?.occupiedByPlayer);
        events.push({ type: "hide-check-completed", hideSpotId: result.completedHideCheckId, occupied });
        if (occupied) {
          this.capturePlayer(events);
          return;
        }
      }
    }
  }

  private moveChaser(delta: number) {
    if (this.state.phase !== "playing") return;
    const target = getChaserTarget(this.state.chaser, this.level);
    const speed = chaserSpeedForMode(this.state.chaser.mode, this.config.chaserSpeed);
    if (!target || speed <= 0) return;
    const movement = moveAlongGridPath(this.planner, this.state.chaser.position, target, speed, delta);
    this.state.chaser.position = movement.position;
    if (Math.hypot(movement.heading.x, movement.heading.y) > 1e-9) this.state.chaser.heading = movement.heading;
  }

  private resolveNormalCapture(): boolean {
    if (this.state.phase !== "playing" || this.state.chaser.mode === "spawn-delay") return false;
    if (!isPlayerVisuallyExposed(this.state.player, this.config)) return false;
    if (distanceBetween(this.state.player.position, this.state.chaser.position) > this.config.catchRange) return false;
    return hasLineOfSight(this.level, this.state.chaser.position, this.state.player.position);
  }

  private capturePlayer(events: SimulationEvent[]) {
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
    setPlayerMode(this.state, "caught", events);
    setPhase(this.state, "lost", events);
  }
}

export function createGameSimulation(options: GameSimulationOptions = {}) {
  return new GameSimulation(options);
}
