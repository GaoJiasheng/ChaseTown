import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixedBearingCameraPlan,
  DEFAULT_FIXED_BEARING_CAMERA_POLICY,
  FIXED_BEARING_CAMERA_POLICY_BOUNDS,
  fixedBearingCameraPolicyForTheme,
  HOSPITAL_FIXED_BEARING_CAMERA_POLICY,
  selectNarrativeRoomAnchors,
} from "../app/game/hospital-cinematic-composition.ts";

const beat = (id, x, y, routeIndex, overrides = {}) => ({
  id,
  focusCell: { x, y },
  routeTangent: { x: 1, y: 0 },
  lateralBias: 1,
  routeIndex,
  ...overrides,
});

const anchor = (x, y, rotation = 0) => ({
  cell: { x, y },
  point: { x, y },
  rotation,
});

test("narrative room anchor selection is deterministic, route ordered and input-order independent", () => {
  const beats = [
    beat("triage", 0, 0, 4),
    beat("waiting", 10, 0, 12),
    beat("pharmacy", 20, 0, 21),
  ];
  const candidates = [
    anchor(20, -1),
    anchor(0, -1),
    anchor(10, -1),
    anchor(16, 4, Math.PI),
    anchor(5, 5, Math.PI),
  ];

  const first = selectNarrativeRoomAnchors(beats, candidates);
  const second = selectNarrativeRoomAnchors(beats, [...candidates].reverse());

  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ beatId }) => beatId), ["triage", "waiting", "pharmacy"]);
  assert.deepEqual(first.map(({ routeIndex }) => routeIndex), [4, 12, 21]);
  assert.deepEqual(
    first.map(({ anchor: selected }) => selected?.point),
    [{ x: 0, y: -1 }, { x: 10, y: -1 }, { x: 20, y: -1 }],
  );
  assert.ok(first.every(({ matched }) => matched));
  assert.equal(new Set(first.map(({ candidateKey }) => candidateKey)).size, 3);
});

test("selection prefers the nearest unique anchors while preserving minimum spacing globally", () => {
  const beats = [
    beat("establish", 0, 0, 2),
    beat("pressure", 1, 0, 5),
    beat("payoff", 8, 0, 9),
  ];
  const duplicateNearest = anchor(0, -1);
  const selections = selectNarrativeRoomAnchors(
    beats,
    [
      duplicateNearest,
      { ...duplicateNearest, cell: { ...duplicateNearest.cell } },
      anchor(1, -1),
      anchor(3, -1),
      anchor(8, -1),
    ],
    { minimumSpacingCells: 2.5 },
  );

  assert.equal(selections.filter(({ matched }) => matched).length, 3);
  assert.equal(new Set(selections.map(({ candidateKey }) => candidateKey)).size, 3);
  const selectedPoints = selections.map(({ anchor: selected }) => selected.point);
  for (let index = 0; index < selectedPoints.length; index += 1) {
    for (let other = index + 1; other < selectedPoints.length; other += 1) {
      assert.ok(
        Math.hypot(
          selectedPoints[index].x - selectedPoints[other].x,
          selectedPoints[index].y - selectedPoints[other].y,
        ) >= 2.5 - 1e-9,
      );
    }
  }
  assert.deepEqual(selectedPoints[2], { x: 8, y: -1 });
});

test("route-side and authored-facing alignment resolve equidistant room anchors", () => {
  const aligned = anchor(0, -2, 0);
  const wrongSide = anchor(0, 2, Math.PI);
  const wrongFacing = anchor(0, -2, Math.PI);
  const selection = selectNarrativeRoomAnchors(
    [beat("pharmacy", 0, 0, 6)],
    [wrongSide, wrongFacing, aligned],
  )[0];

  assert.deepEqual(selection.anchor?.point, { x: 0, y: -2 });
  assert.equal(selection.anchor?.rotation, 0);
  assert.equal(selection.routeSideAlignment, 1);
  assert.equal(selection.facingAlignment, 1);
  assert.equal(selection.distanceCells, 2);
});

test("empty, invalid and degenerate narrative inputs fail closed without unstable scores", () => {
  assert.deepEqual(selectNarrativeRoomAnchors([], [anchor(0, 0)]), []);

  const noCandidates = selectNarrativeRoomAnchors(
    [beat("empty", 2, 2, 1)],
    [],
  );
  assert.deepEqual(noCandidates, [{
    beatId: "empty",
    beatIndex: 0,
    routeIndex: 1,
    matched: false,
    candidateKey: null,
    anchor: null,
    distanceCells: null,
    routeSideAlignment: null,
    facingAlignment: null,
    score: null,
  }]);

  const invalid = selectNarrativeRoomAnchors(
    [
      beat("invalid", Number.NaN, 0, 0),
      beat("zero-tangent", 4, 4, 1, { routeTangent: { x: 0, y: 0 } }),
    ],
    [
      anchor(Number.POSITIVE_INFINITY, 0),
      anchor(4, 3),
      { ...anchor(4, 5), rotation: Number.NaN },
    ],
    {
      minimumSpacingCells: Number.NaN,
      maximumBeatDistanceCells: Number.POSITIVE_INFINITY,
    },
  );
  assert.equal(invalid[0].matched, false);
  assert.equal(invalid[1].matched, true);
  assert.deepEqual(invalid[1].anchor?.point, { x: 4, y: 3 });
  assert.equal(invalid[1].routeSideAlignment, 0.5);
  assert.ok(Number.isFinite(invalid[1].score));
});

test("hospital camera policy is stronger while non-hospital and future themes retain defaults", () => {
  const hospital = fixedBearingCameraPolicyForTheme("hospital");
  const campus = fixedBearingCameraPolicyForTheme("campus");
  const future = fixedBearingCameraPolicyForTheme("future-theme");

  assert.deepEqual(hospital, HOSPITAL_FIXED_BEARING_CAMERA_POLICY);
  assert.deepEqual(campus, DEFAULT_FIXED_BEARING_CAMERA_POLICY);
  assert.deepEqual(future, DEFAULT_FIXED_BEARING_CAMERA_POLICY);
  assert.ok(hospital.edgeInsetWorldUnits > campus.edgeInsetWorldUnits);
  assert.ok(
    hospital.maximumFocusShiftWorldUnits
      > campus.maximumFocusShiftWorldUnits,
  );
  assert.ok(hospital.maximumDarkExteriorFraction < campus.maximumDarkExteriorFraction);
  assert.equal(hospital.allowsBearingRotation, false);
});

test("camera policy clamps overrides and substitutes defaults for non-finite values", () => {
  const policy = fixedBearingCameraPolicyForTheme("hospital", {
    edgeInsetWorldUnits: 999,
    maximumFocusShiftWorldUnits: -20,
    safeHorizontalNdc: 2,
    safeVerticalNdc: Number.NaN,
    maximumDarkExteriorFraction: 0,
  });

  assert.equal(
    policy.edgeInsetWorldUnits,
    FIXED_BEARING_CAMERA_POLICY_BOUNDS.edgeInsetWorldUnits.maximum,
  );
  assert.equal(
    policy.maximumFocusShiftWorldUnits,
    FIXED_BEARING_CAMERA_POLICY_BOUNDS.maximumFocusShiftWorldUnits.minimum,
  );
  assert.equal(
    policy.safeHorizontalNdc,
    FIXED_BEARING_CAMERA_POLICY_BOUNDS.safeHorizontalNdc.maximum,
  );
  assert.equal(
    policy.safeVerticalNdc,
    HOSPITAL_FIXED_BEARING_CAMERA_POLICY.safeVerticalNdc,
  );
  assert.equal(
    policy.maximumDarkExteriorFraction,
    FIXED_BEARING_CAMERA_POLICY_BOUNDS.maximumDarkExteriorFraction.minimum,
  );
});

test("hospital cinematic policy preserves the exact fixed camera bearing", () => {
  const bearing = Object.freeze({ x: 0.62, y: 0.71, z: 0.33 });
  const snapshot = { ...bearing };
  const plan = createFixedBearingCameraPlan("hospital", bearing);

  assert.deepEqual(plan.bearing, snapshot);
  assert.notStrictEqual(plan.bearing, bearing);
  assert.deepEqual(bearing, snapshot);
  assert.equal(plan.policy.bearingMode, "fixed");
  assert.equal(plan.policy.allowsBearingRotation, false);
  assert.throws(
    () => createFixedBearingCameraPlan(
      "hospital",
      { x: Number.NaN, y: 1, z: 0 },
    ),
    /finite x\/y\/z/,
  );
});
