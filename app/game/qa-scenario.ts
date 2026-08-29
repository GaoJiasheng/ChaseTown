import type { Point } from "./contracts.ts";

export type QaScenarioInput = Readonly<{
  player?: unknown;
  chaser?: unknown;
  chaserHeading?: unknown;
  spawnDelaySeconds?: unknown;
}>;

export type ValidQaScenario = Readonly<{
  player: Point;
  chaser: Point;
  chaserHeading?: Point;
  spawnDelaySeconds: number;
}>;

export type QaScenarioValidation =
  | Readonly<{ ok: true; value: ValidQaScenario }>
  | Readonly<{ ok: false; error: string }>;

const finitePoint = (value: unknown): value is Point => {
  if (value === null || typeof value !== "object") return false;
  const point = value as Partial<Point>;
  return Number.isFinite(point.x) && Number.isFinite(point.y);
};

/** Fail closed before malformed console/automation input reaches simulation. */
export const validateQaScenario = (input: QaScenarioInput): QaScenarioValidation => {
  if (!finitePoint(input.player)) {
    return { ok: false, error: "QA scenario player must be a finite { x, y } point." };
  }
  if (!finitePoint(input.chaser)) {
    return { ok: false, error: "QA scenario chaser must be a finite { x, y } point." };
  }
  if (input.chaserHeading !== undefined && !finitePoint(input.chaserHeading)) {
    return { ok: false, error: "QA scenario chaserHeading must be a finite { x, y } point." };
  }
  const spawnDelaySeconds = input.spawnDelaySeconds ?? 0;
  if (!Number.isFinite(spawnDelaySeconds) || Number(spawnDelaySeconds) < 0) {
    return { ok: false, error: "QA scenario spawnDelaySeconds must be a finite non-negative number." };
  }
  return {
    ok: true,
    value: {
      player: input.player,
      chaser: input.chaser,
      ...(input.chaserHeading === undefined ? {} : { chaserHeading: input.chaserHeading }),
      spawnDelaySeconds: Number(spawnDelaySeconds),
    },
  };
};
