import assert from "node:assert/strict";
import test from "node:test";

import {
  authoredRoomFloorRegions,
  enclosedRoomFloorRegions,
  roomFloorBoundaryTrimPlacement,
  roomFloorSupportForFootprint,
} from "../app/game/room-floor.ts";

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
  assert.deepEqual(regions[0].bounds, { minX: 1.5, minY: 1.5, maxX: 4.5, maxY: 4.5 });
  assert.equal(regions[0].boundaryEdges.length, 12, "a 3x3 room needs a twelve-cell skirting perimeter");
  assert.ok(
    regions[0].boundaryEdges.every(({ adjacent }) => enclosedRoomLevel().walkable[adjacent.y][adjacent.x]),
    "every emitted trim edge must close against a real corridor cell",
  );
});

test("room floors reject space connected to the exterior void", () => {
  const regions = authoredRoomFloorRegions(enclosedRoomLevel(true), [{ x: 3, y: 3 }]);
  assert.deepEqual(regions, []);
});

test("topology generation is anchor-independent and never leaks through an open boundary", () => {
  const enclosed = enclosedRoomFloorRegions(enclosedRoomLevel());
  assert.equal(enclosed.length, 1);
  assert.equal(enclosed[0].id, "2,2:9");

  const open = enclosedRoomFloorRegions(enclosedRoomLevel(true));
  assert.deepEqual(open, []);
});

test("invalid and out-of-grid anchors are ignored without indexing outside the level", () => {
  const regions = authoredRoomFloorRegions(enclosedRoomLevel(), [
    { x: -1, y: 3 },
    { x: 3, y: 99 },
    { x: 2.5, y: 2 },
    { x: Number.NaN, y: 2 },
    { x: 3, y: 3 },
  ]);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].anchorIndex, 4);
});

test("boundary trim placement offsets into the room instead of outside the wall", () => {
  const [room] = enclosedRoomFloorRegions(enclosedRoomLevel());
  const north = room.boundaryEdges.find(({ cell, side }) => cell.x === 2 && cell.y === 2 && side === "north");
  const east = room.boundaryEdges.find(({ cell, side }) => cell.x === 4 && cell.y === 3 && side === "east");
  assert.ok(north);
  assert.ok(east);

  assert.deepEqual(roomFloorBoundaryTrimPlacement(north, 0.05), {
    position: { x: 2, y: 1.55 },
    rotationRadians: 0,
    lengthCells: 1,
  });
  assert.deepEqual(roomFloorBoundaryTrimPlacement(east, 0.05), {
    position: { x: 4.45, y: 3 },
    rotationRadians: Math.PI / 2,
    lengthCells: 1,
  });
});

test("prop support checks the complete rotated footprint, not only its center", () => {
  const level = enclosedRoomLevel();
  const rooms = authoredRoomFloorRegions(level, [{ x: 3, y: 3 }]);
  const supported = roomFloorSupportForFootprint(level, rooms, {
    center: { x: 3, y: 3 },
    halfWidth: 0.8,
    halfDepth: 0.55,
    rotationRadians: Math.PI / 4,
  });
  assert.equal(supported.supported, true);
  assert.equal(supported.roomId, rooms[0].id);
  assert.equal(supported.anchorIndex, 0);
  assert.equal(supported.samples.length, 9);
  assert.deepEqual(supported.unsupportedSamples, []);

  const wallLeak = roomFloorSupportForFootprint(level, rooms, {
    center: { x: 2.05, y: 3 },
    halfWidth: 0.7,
    halfDepth: 0.45,
  });
  assert.equal(wallLeak.supported, false);
  assert.ok(wallLeak.unsupportedSamples.length > 0, "a footprint crossing the corridor wall must be rejected");
  assert.deepEqual(wallLeak.outOfBoundsSamples, []);
});

test("support reports footprints beyond the authored grid separately", () => {
  const level = enclosedRoomLevel();
  const rooms = enclosedRoomFloorRegions(level);
  const result = roomFloorSupportForFootprint(level, rooms, {
    center: { x: -0.25, y: 3 },
    halfWidth: 0.6,
    halfDepth: 0.4,
  });
  assert.equal(result.supported, false);
  assert.ok(result.outOfBoundsSamples.length > 0);
  assert.ok(result.unsupportedSamples.length >= result.outOfBoundsSamples.length);
});
