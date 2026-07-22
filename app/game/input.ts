/**
 * Space/Enter already activate the focused HTML control. The global game
 * handler must stand down or one key press can both click a button and issue
 * a second gameplay command.
 */
export function shouldIgnoreFocusedControlKey(key: string, focusedControl: boolean): boolean {
  return focusedControl && (key === " " || key === "enter");
}
