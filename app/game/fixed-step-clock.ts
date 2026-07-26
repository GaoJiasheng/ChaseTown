/**
 * Pure render-time adapter for deterministic fixed-step systems.
 *
 * The clock owns no wall-clock source. Callers supply a render delta, receive
 * an inclusive range of consecutive fixed ticks, and keep the returned state.
 */

export const FIXED_STEP_CLOCK_HZ = 60;
export const DEFAULT_FIXED_STEP_SECONDS = 1 / FIXED_STEP_CLOCK_HZ;
export const DEFAULT_MAX_FRAME_DELTA_SECONDS = 0.25;

const STEP_BOUNDARY_EPSILON_MULTIPLIER = 64;

export interface FixedStepClockOptions {
  readonly fixedStepSeconds?: number;
  readonly maxFrameDeltaSeconds?: number;
  readonly initialTick?: number;
}

export interface FixedStepClockState {
  readonly fixedStepSeconds: number;
  readonly maxFrameDeltaSeconds: number;
  readonly tick: number;
  readonly remainderSeconds: number;
}

export interface FixedStepClockAdvance {
  readonly state: FixedStepClockState;
  /** Number of fixed ticks produced by this render frame. */
  readonly tickCount: number;
  /** First produced tick, or null when the bounded delta did not fill a step. */
  readonly firstTick: number | null;
  /** Latest completed fixed tick after this render frame. */
  readonly lastTick: number;
  /** Render delta actually admitted to the fixed-step accumulator. */
  readonly boundedDeltaSeconds: number;
  /** Render time intentionally discarded by the long-frame safety clamp. */
  readonly droppedDeltaSeconds: number;
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite and greater than zero`);
  }
}

function assertTick(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertClockConfiguration(
  fixedStepSeconds: number,
  maxFrameDeltaSeconds: number,
): void {
  assertPositiveFinite(fixedStepSeconds, "fixedStepSeconds");
  assertPositiveFinite(maxFrameDeltaSeconds, "maxFrameDeltaSeconds");

  const maximumTicksPerFrame = maxFrameDeltaSeconds / fixedStepSeconds;
  if (
    !Number.isFinite(maximumTicksPerFrame)
    || maximumTicksPerFrame > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      "maxFrameDeltaSeconds / fixedStepSeconds must fit in a safe integer range",
    );
  }
}

function assertClockState(state: FixedStepClockState): void {
  assertClockConfiguration(
    state.fixedStepSeconds,
    state.maxFrameDeltaSeconds,
  );
  assertTick(state.tick, "tick");

  if (
    !Number.isFinite(state.remainderSeconds)
    || state.remainderSeconds < 0
    || state.remainderSeconds >= state.fixedStepSeconds
  ) {
    throw new Error(
      "remainderSeconds must be finite and in [0, fixedStepSeconds)",
    );
  }
}

function freezeState(
  fixedStepSeconds: number,
  maxFrameDeltaSeconds: number,
  tick: number,
  remainderSeconds: number,
): FixedStepClockState {
  return Object.freeze({
    fixedStepSeconds,
    maxFrameDeltaSeconds,
    tick,
    remainderSeconds: remainderSeconds === 0 ? 0 : remainderSeconds,
  });
}

export function createFixedStepClock(
  options: FixedStepClockOptions = {},
): FixedStepClockState {
  const fixedStepSeconds = options.fixedStepSeconds
    ?? DEFAULT_FIXED_STEP_SECONDS;
  const maxFrameDeltaSeconds = options.maxFrameDeltaSeconds
    ?? DEFAULT_MAX_FRAME_DELTA_SECONDS;
  const initialTick = options.initialTick ?? 0;

  assertClockConfiguration(fixedStepSeconds, maxFrameDeltaSeconds);
  assertTick(initialTick, "initialTick");

  return freezeState(
    fixedStepSeconds,
    maxFrameDeltaSeconds,
    initialTick,
    0,
  );
}

export function resetFixedStepClock(
  state: FixedStepClockState,
  initialTick = 0,
): FixedStepClockState {
  assertClockState(state);
  assertTick(initialTick, "initialTick");

  return freezeState(
    state.fixedStepSeconds,
    state.maxFrameDeltaSeconds,
    initialTick,
    0,
  );
}

export function advanceFixedStepClock(
  state: FixedStepClockState,
  renderDeltaSeconds: number,
): FixedStepClockAdvance {
  assertClockState(state);
  if (!Number.isFinite(renderDeltaSeconds) || renderDeltaSeconds < 0) {
    throw new Error("renderDeltaSeconds must be finite and non-negative");
  }

  const boundedDeltaSeconds = Math.min(
    renderDeltaSeconds,
    state.maxFrameDeltaSeconds,
  );
  // Divide before adding so two individually finite durations cannot overflow
  // when a caller intentionally uses very large time units.
  const rawStepCount = (
    state.remainderSeconds / state.fixedStepSeconds
    + boundedDeltaSeconds / state.fixedStepSeconds
  );

  // Ratios such as (1 / 144) / (1 / 60) are not exactly representable. Snap
  // only values within floating-point error of an integer step boundary.
  const nearestIntegerStepCount = Math.round(rawStepCount);
  const boundaryTolerance = (
    STEP_BOUNDARY_EPSILON_MULTIPLIER
    * Number.EPSILON
    * Math.max(1, Math.abs(rawStepCount))
  );
  const normalizedStepCount = (
    Math.abs(rawStepCount - nearestIntegerStepCount) <= boundaryTolerance
      ? nearestIntegerStepCount
      : rawStepCount
  );

  const tickCount = Math.floor(normalizedStepCount);
  const lastTick = state.tick + tickCount;
  assertTick(lastTick, "next tick");

  const remainderInSteps = normalizedStepCount - tickCount;
  const remainderSeconds = remainderInSteps <= boundaryTolerance
    ? 0
    : remainderInSteps * state.fixedStepSeconds;
  const nextState = freezeState(
    state.fixedStepSeconds,
    state.maxFrameDeltaSeconds,
    lastTick,
    remainderSeconds,
  );

  return Object.freeze({
    state: nextState,
    tickCount,
    firstTick: tickCount > 0 ? state.tick + 1 : null,
    lastTick,
    boundedDeltaSeconds,
    droppedDeltaSeconds: renderDeltaSeconds - boundedDeltaSeconds,
  });
}
