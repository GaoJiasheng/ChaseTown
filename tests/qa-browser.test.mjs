import assert from "node:assert/strict";
import test from "node:test";

import {
  parseQaDelaySeconds,
  parseQaLevel,
  parseQaPoint,
} from "../app/game/qa-browser.ts";

test("QA browser scenario points accept finite in-bounds coordinates", () => {
  assert.deepEqual(parseQaPoint("6,1"), { x: 6, y: 1 });
  assert.deepEqual(parseQaPoint(" 12.5, 7 "), { x: 12.5, y: 7 });
});

test("QA browser scenario points fail closed", () => {
  for (const value of [null, "", "1", "1,2,3", "x,2", "-1,2", "2,256"]) {
    assert.equal(parseQaPoint(value), null);
  }
});

test("QA browser level selection is one-based and bounded", () => {
  for (const level of [1, 5, 10]) assert.equal(parseQaLevel(String(level)), level);
  for (const value of [null, "", "0", "11", "1.5", "campus"]) {
    assert.equal(parseQaLevel(value), null);
  }
  assert.equal(parseQaLevel("4", 3), null);
});

test("QA browser spawn delay is finite and bounded", () => {
  assert.equal(parseQaDelaySeconds("12.5"), 12.5);
  assert.equal(parseQaDelaySeconds("60"), 60);
  for (const value of [null, "", "-1", "61", "later"]) {
    assert.equal(parseQaDelaySeconds(value), 0);
  }
});
