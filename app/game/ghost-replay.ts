import type { Point, SimulationInput } from "./contracts.ts";

export const GHOST_REPLAY_VERSION = 1;
export const GHOST_MOVE_QUANTIZATION = 127;
export const GHOST_REPLAY_MAX_BYTES = 64 * 1024;
export const GHOST_LIBRARY_MAX_BYTES = 512 * 1024;
export const GHOST_POSITION_ERROR_BUDGET_CELLS = 0.1;

const FLAG_PEEK = 1;
const FLAG_SNEAK = 2;
const FLAG_INTERACT = 4;
const HELD_FLAGS = FLAG_PEEK | FLAG_SNEAK;

/** [tick, signed move x, signed move y, input flags]. */
export type GhostKeyframe = readonly [
  tick: number,
  moveX: number,
  moveY: number,
  flags: number,
];

export interface GhostReplayPayload {
  readonly version: typeof GHOST_REPLAY_VERSION;
  readonly levelId: string;
  readonly fixedStepSeconds: number;
  readonly durationTicks: number;
  readonly keyframes: readonly GhostKeyframe[];
}

export interface GhostRecording extends GhostReplayPayload {
  readonly checksum: string;
}

export interface GhostPositionSample {
  readonly tick: number;
  readonly position: Point;
}

export interface GhostReplayAccuracy {
  readonly comparedSamples: number;
  readonly maximumPositionErrorCells: number;
  readonly meanPositionErrorCells: number;
  readonly withinBudget: boolean;
}

export interface GhostRecorderOptions {
  readonly maximumBytes?: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const clampMove = (value: number | undefined) => (
  Number.isFinite(value) ? Math.min(1, Math.max(-1, Number(value))) : 0
);

const quantizeMove = (value: number | undefined) => (
  Math.round(clampMove(value) * GHOST_MOVE_QUANTIZATION)
);

const decodeMove = (value: number) => value / GHOST_MOVE_QUANTIZATION;

function inputFlags(input: Readonly<SimulationInput>): number {
  return (input.peekHeld ? FLAG_PEEK : 0)
    | (input.sneakHeld ? FLAG_SNEAK : 0)
    | (input.interactPressed ? FLAG_INTERACT : 0);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stableChecksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function payloadFrom(recording: Readonly<GhostReplayPayload>): GhostReplayPayload {
  return {
    version: GHOST_REPLAY_VERSION,
    levelId: recording.levelId,
    fixedStepSeconds: recording.fixedStepSeconds,
    durationTicks: recording.durationTicks,
    keyframes: recording.keyframes,
  };
}

function checksumPayload(payload: Readonly<GhostReplayPayload>): string {
  return stableChecksum(JSON.stringify(payload));
}

function validKeyframe(value: unknown, previousTick: number, durationTicks: number): value is GhostKeyframe {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [tick, moveX, moveY, flags] = value;
  return Number.isInteger(tick)
    && tick > previousTick
    && tick >= 0
    && tick <= durationTicks
    && Number.isInteger(moveX)
    && moveX >= -GHOST_MOVE_QUANTIZATION
    && moveX <= GHOST_MOVE_QUANTIZATION
    && Number.isInteger(moveY)
    && moveY >= -GHOST_MOVE_QUANTIZATION
    && moveY <= GHOST_MOVE_QUANTIZATION
    && Number.isInteger(flags)
    && flags >= 0
    && flags <= (HELD_FLAGS | FLAG_INTERACT);
}

function validatePayload(value: unknown): GhostReplayPayload | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GhostReplayPayload>;
  if (
    candidate.version !== GHOST_REPLAY_VERSION
    || typeof candidate.levelId !== "string"
    || candidate.levelId.length === 0
    || candidate.levelId.length > 120
    || typeof candidate.fixedStepSeconds !== "number"
    || !Number.isFinite(candidate.fixedStepSeconds)
    || candidate.fixedStepSeconds <= 0
    || candidate.fixedStepSeconds > 0.25
    || !Number.isInteger(candidate.durationTicks)
    || Number(candidate.durationTicks) < 0
    || !Array.isArray(candidate.keyframes)
    || candidate.keyframes.length === 0
  ) {
    return null;
  }

  let previousTick = -1;
  for (const frame of candidate.keyframes) {
    if (!validKeyframe(frame, previousTick, Number(candidate.durationTicks))) return null;
    previousTick = frame[0];
  }
  if (candidate.keyframes[0][0] !== 0) return null;
  return {
    version: GHOST_REPLAY_VERSION,
    levelId: candidate.levelId,
    fixedStepSeconds: candidate.fixedStepSeconds,
    durationTicks: Number(candidate.durationTicks),
    keyframes: candidate.keyframes.map((frame) => Object.freeze([...frame]) as GhostKeyframe),
  };
}

export class GhostInputRecorder {
  readonly levelId: string;
  readonly fixedStepSeconds: number;
  readonly maximumBytes: number;

  private readonly frames: GhostKeyframe[] = [];
  private lastTick = -1;
  private lastMoveX = 0;
  private lastMoveY = 0;
  private lastHeldFlags = 0;
  private exceededBudget = false;

  constructor(
    levelId: string,
    fixedStepSeconds: number,
    options: Readonly<GhostRecorderOptions> = {},
  ) {
    if (!levelId || levelId.length > 120) throw new Error("Ghost level ID is invalid");
    if (
      !Number.isFinite(fixedStepSeconds)
      || fixedStepSeconds <= 0
      || fixedStepSeconds > 0.25
    ) {
      throw new Error("Ghost fixed step must be in (0, 0.25]");
    }
    const maximumBytes = options.maximumBytes ?? GHOST_REPLAY_MAX_BYTES;
    if (!Number.isInteger(maximumBytes) || maximumBytes < 256) {
      throw new Error("Ghost storage budget must be at least 256 bytes");
    }
    this.levelId = levelId;
    this.fixedStepSeconds = fixedStepSeconds;
    this.maximumBytes = maximumBytes;
  }

  get overflowed(): boolean {
    return this.exceededBudget;
  }

  record(tick: number, input: Readonly<SimulationInput>): boolean {
    if (!Number.isInteger(tick) || tick < 0 || tick <= this.lastTick) {
      throw new Error("Ghost ticks must be strictly increasing non-negative integers");
    }
    if (this.exceededBudget) return false;

    if (this.frames.length === 0 && tick !== 0) {
      this.frames.push(Object.freeze([0, 0, 0, 0]));
    }

    const moveX = quantizeMove(input.move?.x);
    const moveY = quantizeMove(input.move?.y);
    const flags = inputFlags(input);
    const heldFlags = flags & HELD_FLAGS;
    const changed = moveX !== this.lastMoveX
      || moveY !== this.lastMoveY
      || heldFlags !== this.lastHeldFlags;
    if (this.frames.length === 0 || changed || (flags & FLAG_INTERACT) !== 0) {
      this.frames.push(Object.freeze([tick, moveX, moveY, flags]));
      this.lastMoveX = moveX;
      this.lastMoveY = moveY;
      this.lastHeldFlags = heldFlags;
    }
    this.lastTick = tick;

    // A compact tuple generally costs 12–24 bytes in JSON. This conservative
    // guard prevents unbounded memory before finish() performs the exact check.
    if (this.frames.length * 28 > this.maximumBytes) {
      this.exceededBudget = true;
      return false;
    }
    return true;
  }

  finish(durationTicks: number): GhostRecording | null {
    if (
      this.exceededBudget
      || !Number.isInteger(durationTicks)
      || durationTicks < Math.max(0, this.lastTick)
    ) {
      return null;
    }
    if (this.frames.length === 0) {
      this.frames.push(Object.freeze([0, 0, 0, 0]));
    }
    const payload: GhostReplayPayload = {
      version: GHOST_REPLAY_VERSION,
      levelId: this.levelId,
      fixedStepSeconds: this.fixedStepSeconds,
      durationTicks,
      keyframes: Object.freeze([...this.frames]),
    };
    const recording: GhostRecording = Object.freeze({
      ...payload,
      checksum: checksumPayload(payload),
    });
    if (estimateGhostStorageBytes(recording) > this.maximumBytes) {
      this.exceededBudget = true;
      return null;
    }
    return recording;
  }
}

function decodeFrame(frame: GhostKeyframe, requestedTick: number): SimulationInput {
  return {
    move: {
      x: decodeMove(frame[1]),
      y: decodeMove(frame[2]),
    },
    peekHeld: Boolean(frame[3] & FLAG_PEEK),
    sneakHeld: Boolean(frame[3] & FLAG_SNEAK),
    interactPressed: frame[0] === requestedTick && Boolean(frame[3] & FLAG_INTERACT),
  };
}

export function sampleGhostInput(
  recording: Readonly<GhostRecording>,
  tick: number,
): SimulationInput {
  if (!Number.isInteger(tick) || tick < 0) {
    throw new Error("Ghost replay tick must be a non-negative integer");
  }
  let low = 0;
  let high = recording.keyframes.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (recording.keyframes[middle][0] <= tick) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return decodeFrame(recording.keyframes[found], tick);
}

/** Allocation-light sequential reader for the 60 Hz runtime path. */
export class GhostReplayCursor {
  private index = 0;
  private previousTick = -1;
  private readonly recording: Readonly<GhostRecording>;

  constructor(recording: Readonly<GhostRecording>) {
    this.recording = recording;
  }

  reset(): void {
    this.index = 0;
    this.previousTick = -1;
  }

  sample(tick: number): SimulationInput {
    if (!Number.isInteger(tick) || tick < 0) {
      throw new Error("Ghost replay tick must be a non-negative integer");
    }
    if (tick < this.previousTick) this.reset();
    while (
      this.index + 1 < this.recording.keyframes.length
      && this.recording.keyframes[this.index + 1][0] <= tick
    ) {
      this.index += 1;
    }
    this.previousTick = tick;
    return decodeFrame(this.recording.keyframes[this.index], tick);
  }
}

export function serializeGhostRecording(recording: Readonly<GhostRecording>): string {
  const payload = payloadFrom(recording);
  if (checksumPayload(payload) !== recording.checksum) {
    throw new Error("Cannot serialize a ghost with an invalid checksum");
  }
  return JSON.stringify({ ...payload, checksum: recording.checksum });
}

export function parseGhostRecording(
  serialized: string,
  allowedLevelIds?: ReadonlySet<string>,
  maximumBytes = GHOST_REPLAY_MAX_BYTES,
): GhostRecording | null {
  if (utf8Bytes(serialized) > maximumBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const payload = validatePayload(raw);
  const checksum = (raw as { checksum?: unknown }).checksum;
  if (
    !payload
    || typeof checksum !== "string"
    || checksum !== checksumPayload(payload)
    || (allowedLevelIds && !allowedLevelIds.has(payload.levelId))
  ) {
    return null;
  }
  return Object.freeze({ ...payload, checksum });
}

export function estimateGhostStorageBytes(recording: Readonly<GhostRecording>): number {
  return utf8Bytes(JSON.stringify(recording));
}

export function ghostStorageKey(levelId: string): string {
  return `chasing.personal-ghost.v1:${encodeURIComponent(levelId)}`;
}

export function savePersonalGhost(
  storage: KeyValueStorage,
  recording: Readonly<GhostRecording>,
): boolean {
  const serialized = serializeGhostRecording(recording);
  if (utf8Bytes(serialized) > GHOST_REPLAY_MAX_BYTES) return false;
  try {
    storage.setItem(ghostStorageKey(recording.levelId), serialized);
    return true;
  } catch {
    return false;
  }
}

export function loadPersonalGhost(
  storage: KeyValueStorage,
  levelId: string,
): GhostRecording | null {
  try {
    const serialized = storage.getItem(ghostStorageKey(levelId));
    return serialized
      ? parseGhostRecording(serialized, new Set([levelId]))
      : null;
  } catch {
    return null;
  }
}

export function measureGhostReplayAccuracy(
  reference: readonly GhostPositionSample[],
  replayed: readonly GhostPositionSample[],
): GhostReplayAccuracy {
  const replayByTick = new Map(replayed.map((sample) => [sample.tick, sample.position]));
  let comparedSamples = 0;
  let maximumPositionErrorCells = 0;
  let errorSum = 0;
  for (const sample of reference) {
    const replayPosition = replayByTick.get(sample.tick);
    if (!replayPosition) continue;
    const error = Math.hypot(
      sample.position.x - replayPosition.x,
      sample.position.y - replayPosition.y,
    );
    comparedSamples += 1;
    errorSum += error;
    maximumPositionErrorCells = Math.max(maximumPositionErrorCells, error);
  }
  const meanPositionErrorCells = comparedSamples > 0 ? errorSum / comparedSamples : 0;
  return Object.freeze({
    comparedSamples,
    maximumPositionErrorCells,
    meanPositionErrorCells,
    withinBudget: comparedSamples > 0
      && maximumPositionErrorCells <= GHOST_POSITION_ERROR_BUDGET_CELLS,
  });
}
