import { SCREEN_RIGHT, SCREEN_UP } from "../camera/index.js";
import type { Point } from "../core/types.js";

export function screenAlignedMove(dx: number, dy: number, out: Point = { x: 0, y: 0 }) {
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const inputX = dx / length;
  const inputY = dy / length;
  out.x = SCREEN_RIGHT.x * inputX + SCREEN_UP.x * -inputY;
  out.y = SCREEN_RIGHT.y * inputX + SCREEN_UP.y * -inputY;
  return out;
}
