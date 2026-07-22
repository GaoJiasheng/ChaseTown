import assert from "node:assert/strict";
import test from "node:test";

import { shouldIgnoreFocusedControlKey } from "../app/game/input.ts";

test("focused controls own Space and Enter without duplicate global commands", () => {
  assert.equal(shouldIgnoreFocusedControlKey(" ", true), true);
  assert.equal(shouldIgnoreFocusedControlKey("enter", true), true);
  assert.equal(shouldIgnoreFocusedControlKey("e", true), false);
  assert.equal(shouldIgnoreFocusedControlKey(" ", false), false);
  assert.equal(shouldIgnoreFocusedControlKey("enter", false), false);
});
