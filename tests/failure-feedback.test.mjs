import assert from "node:assert/strict";
import test from "node:test";

import { failureFeedback } from "../app/game/failure-feedback.ts";

test("every capture class produces one concise, actionable correction", () => {
  for (const reason of [
    "direct-contact",
    "exposed-hide-entry",
    "unsafe-hide-exit",
    "witnessed-hide-check",
    "search-hide-check",
  ]) {
    const feedback = failureFeedback(reason);
    assert.ok(feedback.title.length >= 4);
    assert.ok(feedback.explanation.endsWith("。"));
    assert.ok(feedback.hint.endsWith("。"));
    assert.ok(feedback.hint.length < 42);
  }
});

test("legacy states without an explicit reason retain a useful fallback", () => {
  assert.equal(failureFeedback(null).title, "在走廊里被追上");
});

test("witnessed locker feedback matches the cancellable and committed entry phases", () => {
  const hint = failureFeedback("witnessed-hide-check").hint;
  assert.match(hint, /对齐柜门时可移动取消/);
  assert.match(hint, /开门动作开始后就无法反悔/);
});
