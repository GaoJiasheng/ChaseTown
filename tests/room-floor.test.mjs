import assert from "node:assert/strict";
import test from "node:test";

import { authoredRoomFloorRegions } from "../app/game/room-floor.ts";

function enclosedRoomLevel(openToExterior = false) {
  const width = 7;
  const height = 7;
  const walkable = Array.from({ length: height }, () => Array(width).fill(false));
  for (let x = 1; x <= 5; x += 1) {
    walkable[1][x] = true;
    walkable[5][x] = true;
  }
  for (let y = 1; y <= 5; y += 1) {
    walkable[y][1] = true;
    walkable[y][5] = true;
  }
  if (openToExterior) walkable[3][1] = false;
  return { width, height, walkable };
}

test("room floors cover a complete enclosed room once", () => {
  const regions = authoredRoomFloorRegions(enclosedRoomLevel(), [
    { x: 2, y: 2 },
    { x: 4, y: 4 },
    { x: 0, y: 3 },
  ]);

  assert.equal(regions.length, 1);
  assert.equal(regions[0].anchorIndex, 0);
  assert.equal(regions[0].cells.length, 9);
  assert.deepEqual(
    new Set(regions[0].cells.map(({ x, y }) => `${x},${y}`)),
    new Set(["2,2", "2,3", "2,4", "3,2", "3,3", "3,4", "4,2", "4,3", "4,4"]),
  );
});

test("room floors reject space connected to the exterior void", () => {
  const regions = authoredRoomFloorRegions(enclosedRoomLevel(true), [{ x: 3, y: 3 }]);
  assert.deepEqual(regions, []);
});
