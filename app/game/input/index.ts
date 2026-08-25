import { SCREEN_RIGHT, SCREEN_UP } from "../camera/index.js";
export function screenAlignedMove(dx: number, dy: number) {
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  const inputX = dx / length;
  const inputY = dy / length;
  return {
    x: SCREEN_RIGHT.x * inputX + SCREEN_UP.x * -inputY,
    y: SCREEN_RIGHT.y * inputX + SCREEN_UP.y * -inputY,
  };
}
