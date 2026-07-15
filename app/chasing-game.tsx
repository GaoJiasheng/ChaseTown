"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Point = { x: number; y: number };
type Phase = "ready" | "playing" | "won" | "lost";
type ActorName = "kid" | "villain" | "police";

const SIZE = 25;
const CELL = 2;
const START = { x: 1, y: 1 };
const EXIT = { x: 23, y: 23 };
const VILLAIN_START = { x: 1, y: 7 };
const PATROL = [
  { x: 7, y: 7 },
  { x: 15, y: 3 },
  { x: 21, y: 10 },
  { x: 17, y: 19 },
  { x: 9, y: 20 },
];

const ACTOR_SPECS = [
  { name: "kid" as const, url: "/models/characters/kid.glb?v=21", height: 2.12, color: 0x4d9fff, label: "你" },
  { name: "villain" as const, url: "/models/characters/villain.glb?v=21", height: 2.28, color: 0xff4f5e, label: "追捕者" },
  { name: "police" as const, url: "/models/characters/police.glb?v=21", height: 2.18, color: 0x35e5f2, label: "警察" },
] as const;
const BLOCKING_ACTOR_SPECS = ACTOR_SPECS.filter((spec) => spec.name !== "police");

const CORE_ASSETS = {
  wall: "/models/environment/wall.glb",
  wallCorner: "/models/environment/wall-corner.glb",
  wallEnd: "/models/environment/wall-end.glb",
  floor: "/models/environment/floor.glb",
  exit: "/models/environment/exit.glb",
  frontGate: "/models/environment/front-gate.glb",
  classroomFloor: "/models/environment/classroom-floor.glb",
  playgroundFloor: "/models/environment/playground-floor.glb",
  grassFloor: "/models/environment/grass-floor.glb",
} as const;

const DETAIL_ASSETS = {
  locker: "/models/environment/locker.glb",
  bench: "/models/environment/bench.glb",
  car: "/models/environment/police-car.glb",
  tree: "/models/environment/tree.glb",
  classroomDoor: "/models/environment/classroom-door.glb",
  ceilingLight: "/models/environment/ceiling-light.glb",
  basketball: "/models/environment/basketball.glb",
  deskChair: "/models/environment/desk-chair.glb",
  blackboard: "/models/environment/blackboard.glb",
  bulletin: "/models/environment/bulletin.glb",
  podium: "/models/environment/podium.glb",
  extinguisher: "/models/environment/extinguisher.glb",
  trash: "/models/environment/trash.glb",
  books: "/models/environment/books.glb",
  backpack: "/models/environment/backpack.glb",
  shrub: "/models/environment/shrub.glb",
  station: "/models/environment/station.glb",
} as const;

function carve(grid: boolean[][], points: Point[]) {
  for (let i = 1; i < points.length; i += 1) {
    let { x, y } = points[i - 1];
    const target = points[i];
    while (x !== target.x || y !== target.y) {
      grid[y][x] = true;
      if (x !== target.x) x += Math.sign(target.x - x);
      else y += Math.sign(target.y - y);
    }
    grid[y][x] = true;
  }
}

function makeMaze() {
  const grid = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false));
  carve(grid, [{ x: 1, y: 1 }, { x: 7, y: 1 }, { x: 7, y: 7 }, { x: 11, y: 7 }, { x: 11, y: 13 }, { x: 17, y: 13 }, { x: 17, y: 19 }, { x: 23, y: 19 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 1, y: 1 }, { x: 1, y: 10 }, { x: 5, y: 10 }, { x: 5, y: 16 }, { x: 13, y: 16 }, { x: 13, y: 23 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 7, y: 7 }, { x: 7, y: 3 }, { x: 15, y: 3 }, { x: 15, y: 10 }, { x: 21, y: 10 }, { x: 21, y: 23 }, { x: 23, y: 23 }]);
  carve(grid, [{ x: 3, y: 10 }, { x: 3, y: 14 }]);
  carve(grid, [{ x: 9, y: 13 }, { x: 9, y: 20 }]);
  carve(grid, [{ x: 15, y: 3 }, { x: 20, y: 3 }]);
  carve(grid, [{ x: 17, y: 16 }, { x: 22, y: 16 }]);
  carve(grid, [{ x: 11, y: 7 }, { x: 14, y: 7 }]);
  return grid;
}

const MAZE = makeMaze();
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const pointKey = (point: Point) => `${point.x},${point.y}`;
const canWalk = (x: number, y: number) => MAZE[Math.round(y)]?.[Math.round(x)] ?? false;
const world = (point: Point) => new THREE.Vector3((point.x - (SIZE - 1) / 2) * CELL, 0, (point.y - (SIZE - 1) / 2) * CELL);

function neighbors(point: Point) {
  return [
    { x: point.x + 1, y: point.y },
    { x: point.x - 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x, y: point.y - 1 },
  ].filter((candidate) => canWalk(candidate.x, candidate.y));
}

function path(from: Point, to: Point) {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const goal = { x: Math.round(to.x), y: Math.round(to.y) };
  const queue = [start];
  const cameFrom = new Map<string, Point | null>([[pointKey(start), null]]);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    if (pointKey(current) === pointKey(goal)) break;
    for (const next of neighbors(current)) {
      if (!cameFrom.has(pointKey(next))) {
        cameFrom.set(pointKey(next), current);
        queue.push(next);
      }
    }
  }
  if (!cameFrom.has(pointKey(goal))) return [];
  const route: Point[] = [];
  let current: Point | null = goal;
  while (current) {
    route.push(current);
    current = cameFrom.get(pointKey(current)) ?? null;
  }
  return route.reverse();
}

function moveAlong(entity: Point, target: Point, speed: number, delta: number) {
  const route = path(entity, target);
  const next = route[1] ?? route[0];
  if (!next) return entity;
  const dx = next.x - entity.x;
  const dy = next.y - entity.y;
  const length = Math.hypot(dx, dy) || 1;
  const step = Math.min(speed * delta, length);
  return { x: entity.x + (dx / length) * step, y: entity.y + (dy / length) * step };
}

function tuneMeshes(root: THREE.Object3D, disableCulling = false, castShadow = true) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = castShadow;
    object.receiveShadow = true;
    if (disableCulling) object.frustumCulled = false;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = 1.25;
        material.roughness = Math.min(material.roughness, 0.9);
      }
    }
  });
}

function flattenStatic(root: THREE.Object3D) {
  let hasSkinnedMesh = false;
  root.traverse((object) => { if (object instanceof THREE.SkinnedMesh) hasSkinnedMesh = true; });
  if (hasSkinnedMesh) return root;
  root.updateMatrixWorld(true);
  const flat = new THREE.Group();
  const buckets = new Map<string, { material: THREE.Material; geometries: THREE.BufferGeometry[] }>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (Array.isArray(object.material) || Object.keys(object.geometry.morphAttributes).length) {
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      const mesh = new THREE.Mesh(geometry, object.material);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      flat.add(mesh);
      return;
    }
    const attributes = (Object.entries(object.geometry.attributes) as [string, THREE.BufferAttribute | THREE.InterleavedBufferAttribute][])
      .map(([name, attribute]) => {
        const array = attribute instanceof THREE.InterleavedBufferAttribute ? attribute.data.array : attribute.array;
        return `${name}:${attribute.itemSize}:${attribute.normalized}:${array.constructor.name}`;
      })
      .sort()
      .join("|");
    const signature = `${object.material.uuid}:${object.geometry.index ? "indexed" : "plain"}:${attributes}`;
    const bucket = buckets.get(signature) ?? { material: object.material, geometries: [] };
    bucket.geometries.push(object.geometry.clone().applyMatrix4(object.matrixWorld));
    buckets.set(signature, bucket);
  });
  for (const { material, geometries } of buckets.values()) {
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    flat.add(mesh);
  }
  return flat;
}

function fitActor(source: THREE.Object3D, height: number, hideNodes: string[] = []) {
  const visual = new THREE.Group();
  visual.name = "fitted-character";
  visual.add(source);
  if (hideNodes.length) {
    source.traverse((object) => {
      const name = object.name.toLowerCase();
      if (hideNodes.some((needle) => name.includes(needle))) object.visible = false;
    });
  }
  tuneMeshes(source, true);
  const original = new THREE.Box3().setFromObject(visual);
  const originalSize = original.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(originalSize.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  visual.userData.baseY = visual.position.y;
  const actor = new THREE.Group();
  actor.add(visual);
  actor.userData.visual = visual;
  return actor;
}

function fitProp(source: THREE.Object3D, height: number) {
  const model = source.clone(true);
  tuneMeshes(model, false, false);
  const visual = new THREE.Group();
  visual.add(model);
  const original = new THREE.Box3().setFromObject(visual);
  const size = original.getSize(new THREE.Vector3());
  visual.scale.setScalar(height / Math.max(size.y, 0.001));
  const fitted = new THREE.Box3().setFromObject(visual);
  const center = fitted.getCenter(new THREE.Vector3());
  visual.position.set(-center.x, -fitted.min.y, -center.z);
  return flattenStatic(visual);
}

function fitModule(source: THREE.Object3D, size: THREE.Vector3) {
  const root = source.clone(true);
  tuneMeshes(root);
  const box = new THREE.Box3().setFromObject(root);
  const current = box.getSize(new THREE.Vector3());
  root.scale.set(size.x / Math.max(current.x, 0.001), size.y / Math.max(current.y, 0.001), size.z / Math.max(current.z, 0.001));
  const fitted = new THREE.Box3().setFromObject(root);
  root.position.sub(fitted.getCenter(new THREE.Vector3()));
  root.position.y += size.y / 2;
  return root;
}

type ModulePlacement = { position: THREE.Vector3; rotation: number };

function addInstancedModules(
  source: THREE.Object3D,
  size: THREE.Vector3,
  placements: ModulePlacement[],
  parent: THREE.Object3D,
  castShadow: boolean,
) {
  if (!placements.length) return;
  const template = fitModule(source, size);
  template.updateMatrixWorld(true);
  const placementMatrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  template.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.SkinnedMesh) return;
    const instances = new THREE.InstancedMesh(object.geometry, object.material, placements.length);
    instances.name = `instanced-${object.name || "module"}`;
    placements.forEach((placement, index) => {
      rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotation);
      placementMatrix.compose(placement.position, rotation, scale);
      instances.setMatrixAt(index, placementMatrix.clone().multiply(object.matrixWorld));
    });
    instances.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    instances.instanceMatrix.needsUpdate = true;
    instances.castShadow = castShadow;
    instances.receiveShadow = true;
    instances.computeBoundingBox();
    instances.computeBoundingSphere();
    parent.add(instances);
  });
}

function makeLabel(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.Sprite();
  context.fillStyle = "rgba(5, 12, 9, .88)";
  context.fillRect(8, 12, 368, 104);
  context.strokeStyle = color;
  context.lineWidth = 6;
  context.strokeRect(8, 12, 368, 104);
  context.fillStyle = color;
  context.font = '800 48px Arial, "PingFang SC", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 192, 66);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.3, 0.43, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function decorateActor(actor: THREE.Object3D, height: number, color: number, label: string) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.7, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.035;
  ring.renderOrder = 998;
  actor.add(ring);
  const badge = makeLabel(label, `#${color.toString(16).padStart(6, "0")}`);
  badge.position.y = height + 0.58;
  actor.add(badge);
  const fill = new THREE.PointLight(label === "追捕者" ? 0xffcfc7 : 0xffeadc, label === "追捕者" ? 1.55 : 1.2, 5.5, 2);
  fill.position.y = 1.45;
  actor.add(fill);
  const rig: Record<string, { bone: THREE.Object3D; rest: THREE.Quaternion }> = {};
  const animatedBones = new Set(["LeftUpperArm", "RightUpperArm", "LeftLowerArm", "RightLowerArm", "LeftUpperLeg", "RightUpperLeg", "LeftLowerLeg", "RightLowerLeg"]);
  actor.traverse((object) => {
    if (animatedBones.has(object.name)) rig[object.name] = { bone: object, rest: object.quaternion.clone() };
  });
  actor.userData.rig = rig;
}

function poseRig(actor: THREE.Object3D, gait: number, moving: boolean) {
  const rig = actor.userData.rig as Record<string, { bone: THREE.Object3D; rest: THREE.Quaternion }> | undefined;
  if (!rig) return;
  const axis = new THREE.Vector3(1, 0, 0);
  const delta = new THREE.Quaternion();
  const apply = (name: string, angle: number) => {
    const joint = rig[name];
    if (!joint) return;
    joint.bone.quaternion.copy(joint.rest).multiply(delta.setFromAxisAngle(axis, moving ? angle : 0));
  };
  apply("LeftUpperLeg", gait * 0.52);
  apply("RightUpperLeg", -gait * 0.52);
  apply("LeftLowerLeg", Math.max(0, -gait) * 0.38);
  apply("RightLowerLeg", Math.max(0, gait) * 0.38);
  apply("LeftUpperArm", -gait * 0.38);
  apply("RightUpperArm", gait * 0.38);
  apply("LeftLowerArm", -0.12 - Math.max(0, gait) * 0.16);
  apply("RightLowerArm", -0.12 - Math.max(0, -gait) * 0.16);
}

export function ChasingGame() {
  const mount = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>());
  const player = useRef<Point>({ ...START });
  const villain = useRef<Point>({ ...VILLAIN_START });
  const patrol = useRef(0);
  const started = useRef(0);
  const readyRef = useRef(false);
  const phaseRef = useRef<Phase>("ready");
  const cameraZoom = useRef(1);
  const actors = useRef<Partial<Record<ActorName, THREE.Object3D>>>({});
  const [phase, setPhase] = useState<Phase>("ready");
  const [elapsed, setElapsed] = useState(0);
  const [objectiveDistance, setObjectiveDistance] = useState(Math.round(distance(START, EXIT) * CELL));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: BLOCKING_ACTOR_SPECS.length + Object.keys(CORE_ASSETS).length, message: "正在载入项目美术资产：人物与校园…" });
  const [detailProgress, setDetailProgress] = useState(0);

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const reset = useCallback(() => {
    if (!readyRef.current) return;
    player.current = { ...START };
    villain.current = { ...VILLAIN_START };
    patrol.current = 0;
    started.current = performance.now();
    setElapsed(0);
    setObjectiveDistance(Math.round(distance(START, EXIT) * CELL));
    changePhase("playing");
  }, [changePhase]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
      keys.current.add(event.key.toLowerCase());
      if (event.key.toLowerCase() === "r") reset();
      if (event.key === "0") cameraZoom.current = 1;
      if (event.key === "-" || event.key === "_") cameraZoom.current = THREE.MathUtils.clamp(cameraZoom.current * 1.12, 0.78, 1.55);
      if (event.key === "+" || event.key === "=") cameraZoom.current = THREE.MathUtils.clamp(cameraZoom.current / 1.12, 0.78, 1.55);
      if ((event.key === " " || event.key === "Enter") && phaseRef.current !== "playing") reset();
    };
    const keyUp = (event: KeyboardEvent) => keys.current.delete(event.key.toLowerCase());
    addEventListener("keydown", keyDown);
    addEventListener("keyup", keyUp);
    return () => {
      removeEventListener("keydown", keyDown);
      removeEventListener("keyup", keyUp);
    };
  }, [reset]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;
    let last = performance.now();
    let lastHudUpdate = 0;
    let beacon: THREE.Group | undefined;
    readyRef.current = false;
    actors.current = {};

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x91aa99);
    scene.fog = new THREE.Fog(0x91aa99, 25, 62);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 130);
    const cameraDirection = new THREE.Vector3(0.446, 0.668, 0.595).normalize();
    const cameraRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), cameraDirection).normalize();
    const cameraUp = new THREE.Vector3().crossVectors(cameraDirection, cameraRight).normalize();
    const cameraFocus = world(START).add(new THREE.Vector3(0, 1.02, 0));
    let cameraDistance = 15.6;
    const cameraRuntime = { threat: 0, targetDistance: cameraDistance };
    camera.position.copy(cameraFocus).addScaledVector(cameraDirection, cameraDistance);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.28;
    host.appendChild(renderer.domElement);
    const qaWindow = window as typeof window & { __CHASING_QA__?: { getState: () => unknown; setPositions: (next: { player?: Point; villain?: Point }) => void } };
    if (new URLSearchParams(window.location.search).has("qa")) {
      qaWindow.__CHASING_QA__ = {
        getState: () => ({
          phase: phaseRef.current,
          player: { ...player.current },
          villain: { ...villain.current },
          ready: readyRef.current,
          actors: Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => [name, actor?.position.toArray()])),
          render: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
          camera: { position: camera.position.toArray(), fov: camera.fov, zoom: cameraZoom.current, threat: cameraRuntime.threat, targetDistance: cameraRuntime.targetDistance },
        }),
        setPositions: (next) => {
          if (next.player && canWalk(next.player.x, next.player.y)) player.current = { ...next.player };
          if (next.villain && canWalk(next.villain.x, next.villain.y)) villain.current = { ...next.villain };
        },
      };
    }

    scene.add(new THREE.HemisphereLight(0xe4f7ff, 0x405846, 2.75));
    const sun = new THREE.DirectionalLight(0xffefd0, 3.5);
    sun.position.set(-16, 26, -12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    scene.add(sun);
    const rim = new THREE.DirectionalLight(0x9bc8ff, 1.7);
    rim.position.set(18, 16, 22);
    scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x496b4f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    scene.add(ground);
    const mazeRoot = new THREE.Group();
    scene.add(mazeRoot);

    const loader = new GLTFLoader();
    const load = (url: string) => loader.loadAsync(url).then((gltf) => gltf.scene);
    const totalBlocking = BLOCKING_ACTOR_SPECS.length + Object.keys(CORE_ASSETS).length;
    let loadedBlocking = 0;
    const markBlockingLoaded = (kind: string) => {
      loadedBlocking += 1;
      if (!disposed) setLoadProgress({ done: loadedBlocking, total: totalBlocking, message: `正在载入项目美术资产：${kind} ${loadedBlocking}/${totalBlocking}` });
    };

    const placeActor = (name: ActorName, model: THREE.Object3D) => {
      const spec = ACTOR_SPECS.find((candidate) => candidate.name === name)!;
      const hideNodes = name === "police" ? ["shoulderepaulet", "epauletbutton", "sleevepatch", "sleevepatchinset"] : [];
      const actor = fitActor(model, spec.height, hideNodes);
      decorateActor(actor, spec.height, spec.color, spec.label);
      actors.current[name] = actor;
      if (name === "kid") actor.position.copy(world(player.current));
      if (name === "villain") actor.position.copy(world(villain.current));
      if (name === "police") {
        actor.position.copy(world({ x: 23, y: 22.25 }));
        actor.rotation.y = Math.PI;
      }
      scene.add(actor);
    };

    const buildCore = (assets: Record<keyof typeof CORE_ASSETS, THREE.Object3D>) => {
      const batches: Record<"wall" | "wallCorner" | "wallEnd" | "floor" | "grassFloor" | "classroomFloor" | "playgroundFloor", ModulePlacement[]> = {
        wall: [], wallCorner: [], wallEnd: [], floor: [], grassFloor: [], classroomFloor: [], playgroundFloor: [],
      };
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const position = world({ x, y });
          if (MAZE[y][x]) {
            const floorName = x <= 4 && y >= 10 && y <= 14
              ? "grassFloor"
              : x >= 8 && x <= 10 && y >= 17
                ? "classroomFloor"
                : x >= 16 && x <= 20 && y <= 4
                  ? "playgroundFloor"
                  : "floor";
            batches[floorName].push({ position, rotation: 0 });
          } else {
            const up = Boolean(MAZE[y - 1]?.[x]);
            const down = Boolean(MAZE[y + 1]?.[x]);
            const left = Boolean(MAZE[y]?.[x - 1]);
            const right = Boolean(MAZE[y]?.[x + 1]);
            const openings = [up, down, left, right].filter(Boolean).length;
            let wallName: "wall" | "wallCorner" | "wallEnd" = "wall";
            let wallRotation = 0;
            if (openings === 1) {
              wallName = "wallEnd";
              wallRotation = down ? 0 : right ? Math.PI / 2 : up ? Math.PI : -Math.PI / 2;
            } else if (openings === 2 && !((up && down) || (left && right))) {
              wallName = "wallCorner";
              wallRotation = down && right ? 0 : right && up ? Math.PI / 2 : up && left ? Math.PI : -Math.PI / 2;
            } else if (left && right) {
              wallRotation = Math.PI / 2;
            }
            batches[wallName].push({ position, rotation: wallRotation });
          }
        }
      }
      addInstancedModules(assets.wall, new THREE.Vector3(CELL, 1.12, CELL), batches.wall, mazeRoot, true);
      addInstancedModules(assets.wallCorner, new THREE.Vector3(CELL, 1.12, CELL), batches.wallCorner, mazeRoot, true);
      addInstancedModules(assets.wallEnd, new THREE.Vector3(CELL, 1.12, CELL), batches.wallEnd, mazeRoot, true);
      addInstancedModules(assets.floor, new THREE.Vector3(CELL, 0.12, CELL), batches.floor, mazeRoot, false);
      addInstancedModules(assets.grassFloor, new THREE.Vector3(CELL, 0.12, CELL), batches.grassFloor, mazeRoot, false);
      addInstancedModules(assets.classroomFloor, new THREE.Vector3(CELL, 0.12, CELL), batches.classroomFloor, mazeRoot, false);
      addInstancedModules(assets.playgroundFloor, new THREE.Vector3(CELL, 0.12, CELL), batches.playgroundFloor, mazeRoot, false);
      const exitDoor = fitModule(assets.exit, new THREE.Vector3(1.8, 2.5, 0.55));
      exitDoor.position.add(world(EXIT)).add(new THREE.Vector3(0, 0, CELL * 0.45));
      mazeRoot.add(exitDoor);
      const gate = fitModule(assets.frontGate, new THREE.Vector3(1.8, 2.4, 0.55));
      gate.position.add(world(START)).add(new THREE.Vector3(0, 0, -CELL * 0.45));
      mazeRoot.add(gate);

      beacon = new THREE.Group();
      beacon.position.copy(world(EXIT));
      const beaconPad = new THREE.Mesh(
        new THREE.CylinderGeometry(0.65, 0.65, 0.1, 40),
        new THREE.MeshStandardMaterial({ color: 0x41f28d, emissive: 0x18aa5c, emissiveIntensity: 3 }),
      );
      beaconPad.position.y = 0.08;
      beacon.add(beaconPad);
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.7, 4.5, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x66ffad, transparent: true, opacity: 0.17, depthWrite: false, side: THREE.DoubleSide }),
      );
      beam.position.y = 2.25;
      beacon.add(beam);
      const exitLabel = makeLabel("出口", "#63ffad");
      exitLabel.position.y = 3.25;
      beacon.add(exitLabel);
      const exitLight = new THREE.PointLight(0x53f59e, 3.2, 9, 2);
      exitLight.position.y = 1.7;
      beacon.add(exitLight);
      scene.add(beacon);
    };

    const propTemplates = new Map<string, THREE.Object3D>();
    const addProp = (model: THREE.Object3D, point: Point, height: number, rotation = 0, offset = new THREE.Vector3()) => {
      const cacheKey = `${model.uuid}:${height}`;
      const template = propTemplates.get(cacheKey) ?? fitProp(model, height);
      propTemplates.set(cacheKey, template);
      const object = template.clone(true);
      object.position.add(world(point)).add(offset);
      object.rotation.y = rotation;
      mazeRoot.add(object);
    };

    const placeDetail = (name: keyof typeof DETAIL_ASSETS, model: THREE.Object3D) => {
      switch (name) {
        case "locker":
          addProp(model, { x: 7, y: 5 }, 1.8, Math.PI / 2);
          addProp(model, { x: 13, y: 19 }, 1.8, -Math.PI / 2);
          break;
        case "bench": addProp(model, { x: 18, y: 16 }, 1.05, Math.PI / 2); break;
        case "tree": addProp(model, { x: 3, y: 14 }, 3.5); break;
        case "shrub": addProp(model, { x: 3, y: 12 }, 0.9); break;
        case "car": addProp(model, { x: 22, y: 23 }, 1.6, Math.PI / 2, new THREE.Vector3(CELL * 0.75, 0, CELL * 0.75)); break;
        case "station": addProp(model, { x: 23, y: 23 }, 3.2, Math.PI, new THREE.Vector3(0, 0, CELL * 1.6)); break;
        case "basketball": addProp(model, { x: 20, y: 3 }, 2.6, -Math.PI / 2); break;
        case "classroomDoor": addProp(model, { x: 9, y: 17 }, 2.2, Math.PI / 2, new THREE.Vector3(-CELL * 0.44, 0, 0)); break;
        case "deskChair": addProp(model, { x: 9, y: 18 }, 1.2); break;
        case "blackboard": addProp(model, { x: 9, y: 20 }, 1.5, Math.PI); break;
        case "podium": addProp(model, { x: 9, y: 19 }, 1.1, Math.PI); break;
        case "bulletin": addProp(model, { x: 11, y: 11 }, 1.25, -Math.PI / 2); break;
        case "extinguisher": addProp(model, { x: 11, y: 10 }, 0.8, -Math.PI / 2); break;
        case "trash": addProp(model, { x: 11, y: 12 }, 0.75, -Math.PI / 2); break;
        case "books": addProp(model, { x: 11, y: 13 }, 0.18); break;
        case "backpack": addProp(model, { x: 13, y: 16 }, 0.5); break;
        case "ceilingLight":
          for (const point of [{ x: 7, y: 4 }, { x: 15, y: 5 }, { x: 21, y: 12 }, { x: 17, y: 17 }]) {
            addProp(model, point, 0.16, 0, new THREE.Vector3(0, 2.25, 0));
            const lamp = new THREE.PointLight(0xffe5b0, 1.2, 8, 2);
            lamp.position.copy(world(point)).add(new THREE.Vector3(0, 2.1, 0));
            mazeRoot.add(lamp);
          }
          break;
      }
    };

    const setup = async () => {
      try {
        const actorTask = Promise.all(BLOCKING_ACTOR_SPECS.map(async (spec) => {
          const model = await load(spec.url);
          if (!disposed) placeActor(spec.name, model);
          markBlockingLoaded(spec.label);
        }));
        const core = {} as Partial<Record<keyof typeof CORE_ASSETS, THREE.Object3D>>;
        const coreTask = Promise.all((Object.entries(CORE_ASSETS) as [keyof typeof CORE_ASSETS, string][]).map(async ([name, url]) => {
          core[name] = await load(url);
          markBlockingLoaded("校园结构");
        }));
        await Promise.all([actorTask, coreTask]);
        if (disposed) return;
        buildCore(core as Record<keyof typeof CORE_ASSETS, THREE.Object3D>);
        readyRef.current = true;
        setLoading(false);
        if (new URLSearchParams(window.location.search).get("autostart") === "1") reset();

        let detailsLoaded = 0;
        const policeTask = (async () => {
          try {
            const police = ACTOR_SPECS.find((spec) => spec.name === "police")!;
            const model = await load(police.url);
            if (!disposed) placeActor("police", model);
          } catch (error) {
            console.warn("Exit police asset failed", error);
          } finally {
            detailsLoaded += 1;
            if (!disposed) setDetailProgress(detailsLoaded);
          }
        })();
        const detailTasks = (Object.entries(DETAIL_ASSETS) as [keyof typeof DETAIL_ASSETS, string][]).map(async ([name, url]) => {
          try {
            const model = await load(url);
            if (!disposed) placeDetail(name, model);
          } catch (error) {
            console.warn(`Optional environment asset failed: ${name}`, error);
          } finally {
            detailsLoaded += 1;
            if (!disposed) setDetailProgress(detailsLoaded);
          }
        });
        await Promise.all([policeTask, ...detailTasks]);
      } catch (error) {
        console.error("Failed to load required 3D assets", error);
        if (!disposed) setLoadError("角色或校园模型载入失败，请刷新后重试。控制台已记录具体素材。");
      }
    };
    void setup();

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.4));
      renderer.setSize(bounds.width, bounds.height, false);
      camera.aspect = bounds.width / Math.max(bounds.height, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const adjustZoom = (event: WheelEvent) => {
      event.preventDefault();
      cameraZoom.current = THREE.MathUtils.clamp(cameraZoom.current * Math.exp(event.deltaY * 0.0007), 0.78, 1.55);
    };
    host.addEventListener("wheel", adjustZoom, { passive: false });

    const syncActor = (actor: THREE.Object3D | undefined, point: Point, phaseOffset: number) => {
      if (!actor) return;
      const target = world(point);
      const dx = target.x - actor.position.x;
      const dz = target.z - actor.position.z;
      const moving = dx * dx + dz * dz > 0.00001;
      actor.position.x = target.x;
      actor.position.z = target.z;
      actor.position.y = 0;
      if (moving) actor.rotation.y = Math.atan2(dx, dz);
      const motionTime = performance.now();
      const gait = Math.sin(motionTime * 0.013 + phaseOffset);
      const visual = actor.userData.visual as THREE.Group | undefined;
      if (visual) {
        const baseY = visual.userData.baseY as number;
        visual.position.y = baseY + (moving ? Math.abs(gait) * 0.07 : Math.sin(motionTime * 0.003 + phaseOffset) * 0.018);
        visual.rotation.z = moving ? gait * 0.035 : 0;
        visual.rotation.x = moving ? -0.035 : 0;
      }
      poseRig(actor, gait, moving);
    };

    const animate = (now: number) => {
      const delta = Math.min((now - last) / 1000, 0.04);
      last = now;
      if (phaseRef.current === "playing") {
        let dx = 0;
        let dy = 0;
        if (keys.current.has("a") || keys.current.has("arrowleft")) dx -= 1;
        if (keys.current.has("d") || keys.current.has("arrowright")) dx += 1;
        if (keys.current.has("w") || keys.current.has("arrowup")) dy -= 1;
        if (keys.current.has("s") || keys.current.has("arrowdown")) dy += 1;
        const length = Math.hypot(dx, dy) || 1;
        const current = player.current;
        const nextX = current.x + (dx / length) * 3.7 * delta;
        const nextY = current.y + (dy / length) * 3.7 * delta;
        if (canWalk(nextX, current.y)) current.x = nextX;
        if (canWalk(current.x, nextY)) current.y = nextY;
        if (now - started.current > 1500) {
          const seesPlayer = distance(current, villain.current) < 7;
          const target = seesPlayer ? current : PATROL[patrol.current];
          villain.current = moveAlong(villain.current, target, 3.4, delta);
          if (!seesPlayer && distance(villain.current, target) < 0.25) patrol.current = (patrol.current + 1) % PATROL.length;
        }
        if (distance(current, villain.current) < 0.58) changePhase("lost");
        else if (distance(current, EXIT) < 0.62) changePhase("won");
        if (now - lastHudUpdate > 180) {
          const seconds = Math.max(0, Math.floor((now - started.current) / 1000));
          setElapsed((value) => value === seconds ? value : seconds);
          setObjectiveDistance(Math.round(distance(current, EXIT) * CELL));
          lastHudUpdate = now;
        }
      }
      syncActor(actors.current.kid, player.current, 0);
      syncActor(actors.current.villain, villain.current, 2);
      const playerAnchor = world(player.current).add(new THREE.Vector3(0, 1.02, 0));
      const villainAnchor = world(villain.current).add(new THREE.Vector3(0, 1.02, 0));
      const enemyDistance = distance(player.current, villain.current);
      const threat = phaseRef.current === "playing" ? 1 - THREE.MathUtils.smoothstep(enemyDistance, 4.5, 9) : 0;
      const targetFocus = playerAnchor.clone().lerp(villainAnchor, threat * 0.42);
      const focusAlpha = 1 - Math.exp(-7 * delta);
      cameraFocus.lerp(targetFocus, focusAlpha);

      const verticalTangent = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
      const horizontalTangent = verticalTangent * Math.max(camera.aspect, 0.4);
      const aspectDistance = 5 / Math.max(horizontalTangent, 0.01);
      const baseDistance = THREE.MathUtils.clamp(Math.max(15.6, aspectDistance), 15.6, 26);
      let fitDistance = baseDistance;
      for (const anchor of [playerAnchor, villainAnchor]) {
        const relative = anchor.clone().sub(targetFocus);
        const depthShift = relative.dot(cameraDirection);
        fitDistance = Math.max(
          fitDistance,
          depthShift + (Math.abs(relative.dot(cameraRight)) + 1.2) / Math.max(horizontalTangent, 0.01),
          depthShift + (Math.abs(relative.dot(cameraUp)) + 1.8) / Math.max(verticalTangent, 0.01),
        );
      }
      const automaticDistance = Math.max(baseDistance + threat * 2.8, THREE.MathUtils.lerp(baseDistance, fitDistance, threat));
      const targetDistance = THREE.MathUtils.clamp(automaticDistance * cameraZoom.current, 12.2, 34);
      cameraRuntime.threat = threat;
      cameraRuntime.targetDistance = targetDistance;
      cameraDistance = THREE.MathUtils.lerp(cameraDistance, targetDistance, 1 - Math.exp(-3.2 * delta));
      const desired = cameraFocus.clone().addScaledVector(cameraDirection, cameraDistance);
      camera.position.lerp(desired, 1 - Math.exp(-6 * delta));
      camera.lookAt(cameraFocus);
      if (beacon) {
        beacon.rotation.y += delta * 0.45;
        const pulse = 1 + Math.sin(now * 0.004) * 0.08;
        beacon.scale.setScalar(pulse);
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      readyRef.current = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      host.removeEventListener("wheel", adjustZoom);
      renderer.dispose();
      if (qaWindow.__CHASING_QA__) delete qaWindow.__CHASING_QA__;
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [changePhase, reset]);

  const touch = (key: string, active: boolean) => {
    if (active) keys.current.add(key);
    else keys.current.delete(key);
  };
  const loadPercent = Math.round((loadProgress.done / loadProgress.total) * 100);

  return (
    <main className="game-shell">
      <header className="hud">
        <div>
          <span className="eyebrow">CHASING · WEBGL</span>
          <h1>逃出校园</h1>
        </div>
        <div className="stats">
          <span>用时 <b>{elapsed}s</b></span>
          <span className="objective">出口 <b>{objectiveDistance}m</b></span>
          <span className="status"><i />3D 追逐模式</span>
          <button type="button" disabled={loading} onClick={reset}>重新开始</button>
        </div>
      </header>
      <section className="playfield">
        <div className="three-mount" ref={mount} />
        {loading && (
          <div className={`loading-card${loadError ? " error" : ""}`} role="status">
            <span className="loader-dot" />
            <div>
              <strong>{loadError || loadProgress.message}</strong>
              {!loadError && <div className="load-bar"><i style={{ width: `${loadPercent}%` }} /></div>}
              {!loadError && <small>高精角色正在直接加入场景 · {loadPercent}%</small>}
              {loadError && <button type="button" onClick={() => window.location.reload()}>刷新重试</button>}
            </div>
          </div>
        )}
        {!loading && detailProgress < Object.keys(DETAIL_ASSETS).length + 1 && (
          <div className="detail-loading">校园细节与出口角色 {detailProgress}/{Object.keys(DETAIL_ASSETS).length + 1}</div>
        )}
        {phase !== "playing" && !loading && (
          <div className={`overlay ${phase}`}>
            <div className="overlay-card">
              <span className={`result ${phase}`}>{phase === "won" ? "成功逃脱" : phase === "lost" ? "被抓住了" : "3D 逃生演练"}</span>
              <h2>{phase === "won" ? "警察在出口等到了你" : phase === "lost" ? "别停，换条路线再试一次" : "躲开追捕者，跑到绿色出口"}</h2>
              <p>蓝色标记是你，红色是追捕者。镜头会在追逐时自动拉远，也可用滚轮调节视野。</p>
              <button className="primary" type="button" onClick={reset}>{phase === "ready" ? "开始逃跑" : "再来一次"}<kbd>Enter</kbd></button>
            </div>
          </div>
        )}
        <div className="controls" aria-label="移动控制">
          <button type="button" aria-label="向上" onPointerDown={() => touch("w", true)} onPointerUp={() => touch("w", false)} onPointerCancel={() => touch("w", false)}>↑</button>
          <button type="button" aria-label="向左" onPointerDown={() => touch("a", true)} onPointerUp={() => touch("a", false)} onPointerCancel={() => touch("a", false)}>←</button>
          <button type="button" aria-label="向下" onPointerDown={() => touch("s", true)} onPointerUp={() => touch("s", false)} onPointerCancel={() => touch("s", false)}>↓</button>
          <button type="button" aria-label="向右" onPointerDown={() => touch("d", true)} onPointerUp={() => touch("d", false)} onPointerCancel={() => touch("d", false)}>→</button>
        </div>
      </section>
      <footer>
        <span><i className="kid" />玩家</span>
        <span><i className="villain" />追捕者</span>
        <span><i className="police" />警察 / 出口</span>
        <small>WASD / 方向键移动 · 滚轮调视野 · 0 重置镜头 · R 重新开始</small>
      </footer>
    </main>
  );
}
