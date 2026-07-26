import {
  advanceFixedStepClock,
  createFixedStepClock,
  resetFixedStepClock,
  type FixedStepClockOptions,
  type FixedStepClockState,
} from "./fixed-step-clock.ts";

/**
 * One-shot gameplay actions sampled from a render frame. The host latches
 * every edge until an authoritative fixed tick can consume it, so displays
 * faster than the simulation cannot silently drop input on a zero-tick frame.
 */
export interface FixedStepHostEdges {
  readonly interactionPressed: boolean;
  readonly portableDecoyPressed: boolean;
  readonly stealthToolPressed: boolean;
  readonly evidenceErasePressed: boolean;
}

export interface FixedStepHostState {
  readonly clock: FixedStepClockState;
  readonly pendingEdges: FixedStepHostEdges;
}

export interface FixedStepHostTick {
  readonly tick: number;
  /**
   * Latched edges are delivered to exactly the first emitted tick. Later ticks
   * in the same render frame receive an empty edge set.
   */
  readonly edges: FixedStepHostEdges;
}

export interface FixedStepHostFrame {
  readonly state: FixedStepHostState;
  readonly ticks: readonly FixedStepHostTick[];
  readonly boundedDeltaSeconds: number;
  readonly droppedDeltaSeconds: number;
}

export const EMPTY_FIXED_STEP_HOST_EDGES: FixedStepHostEdges = Object.freeze({
  interactionPressed: false,
  portableDecoyPressed: false,
  stealthToolPressed: false,
  evidenceErasePressed: false,
});

function freezeEdges(edges: FixedStepHostEdges): FixedStepHostEdges {
  if (
    !edges.interactionPressed
    && !edges.portableDecoyPressed
    && !edges.stealthToolPressed
    && !edges.evidenceErasePressed
  ) {
    return EMPTY_FIXED_STEP_HOST_EDGES;
  }
  return Object.freeze({ ...edges });
}

function mergeEdges(
  pending: FixedStepHostEdges,
  incoming: FixedStepHostEdges,
): FixedStepHostEdges {
  return freezeEdges({
    interactionPressed:
      pending.interactionPressed || incoming.interactionPressed,
    portableDecoyPressed:
      pending.portableDecoyPressed || incoming.portableDecoyPressed,
    stealthToolPressed:
      pending.stealthToolPressed || incoming.stealthToolPressed,
    evidenceErasePressed:
      pending.evidenceErasePressed || incoming.evidenceErasePressed,
  });
}

function freezeState(
  clock: FixedStepClockState,
  pendingEdges: FixedStepHostEdges,
): FixedStepHostState {
  return Object.freeze({ clock, pendingEdges });
}

export function createFixedStepHost(
  options: FixedStepClockOptions = {},
): FixedStepHostState {
  return freezeState(
    createFixedStepClock(options),
    EMPTY_FIXED_STEP_HOST_EDGES,
  );
}

export function resetFixedStepHost(
  state: FixedStepHostState,
  initialTick = 0,
): FixedStepHostState {
  return freezeState(
    resetFixedStepClock(state.clock, initialTick),
    EMPTY_FIXED_STEP_HOST_EDGES,
  );
}

export function advanceFixedStepHostFrame(
  state: FixedStepHostState,
  renderDeltaSeconds: number,
  incomingEdges: FixedStepHostEdges = EMPTY_FIXED_STEP_HOST_EDGES,
): FixedStepHostFrame {
  const latchedEdges = mergeEdges(state.pendingEdges, incomingEdges);
  const clockFrame = advanceFixedStepClock(
    state.clock,
    renderDeltaSeconds,
  );
  const ticks: FixedStepHostTick[] = [];

  for (let index = 0; index < clockFrame.tickCount; index += 1) {
    ticks.push(Object.freeze({
      tick: (clockFrame.firstTick ?? clockFrame.lastTick) + index,
      edges: index === 0
        ? latchedEdges
        : EMPTY_FIXED_STEP_HOST_EDGES,
    }));
  }

  return Object.freeze({
    state: freezeState(
      clockFrame.state,
      ticks.length > 0 ? EMPTY_FIXED_STEP_HOST_EDGES : latchedEdges,
    ),
    ticks: Object.freeze(ticks),
    boundedDeltaSeconds: clockFrame.boundedDeltaSeconds,
    droppedDeltaSeconds: clockFrame.droppedDeltaSeconds,
  });
}
