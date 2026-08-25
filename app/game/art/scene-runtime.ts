import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import {
  ACTOR_SPECS,
  BLOCKING_ACTOR_SPECS,
  CELL,
  CORE_ASSETS,
  DETAIL_ASSETS,
  EXIT,
  largeShadowProps,
  POLICE_POINT,
  SIZE,
  START,
} from "../config/index.js";
import type { ActorName, Point } from "../core/types.js";
import { disposeObjectResources } from "../core/resources.js";
import { gridQuarterTurn, MAZE, world } from "../level/maze.js";
import { decorateActor, fitActor, makeLabel } from "../player/actors.js";
import {
  addInstancedModules,
  fitModule,
  fitProp,
  flattenStatic,
  mergePlacedProps,
  type ModulePlacement,
} from "./props.js";
import type { RenderCategory } from "../ui/render-fx.js";

type SceneArtOptions = {
  scene: THREE.Scene;
  actors: Partial<Record<ActorName, THREE.Object3D>>;
  getPlayer: () => Point;
  getVillain: () => Point;
  isDisposed: () => boolean;
  onLoadProgress: (progress: { done: number; total: number; message: string }) => void;
  onDetailProgress: (loaded: number) => void;
  onReady: () => void;
  onLoadError: (message: string) => void;
  trackRenderCategory: (root: THREE.Object3D, category: RenderCategory) => void;
};

export function createSceneArtRuntime(options: SceneArtOptions) {
  const {
    scene,
    actors,
    getPlayer,
    getVillain,
    isDisposed,
    onLoadProgress,
    onDetailProgress,
    onReady,
    onLoadError,
    trackRenderCategory,
  } = options;
  const loadedAssetRoots = new Set<THREE.Object3D>();
  const propTemplates = new Map<string, THREE.Object3D>();
  const propsRoot = new THREE.Group();
  propsRoot.name = "environment-props";
  scene.add(propsRoot);
  const shadowCasterCounts: Partial<Record<keyof typeof DETAIL_ASSETS, number>> = {};
  const shadowCasterMeshCounts: Partial<Record<keyof typeof DETAIL_ASSETS, number>> = {};
  const floorRotationEvidence = {
    samples: [] as { x: number; y: number; floor: string; quarterTurn: number }[],
    histogram: [0, 0, 0, 0],
    checksum: 2166136261 >>> 0,
    wallRandomized: false,
  };
  const propMergeRuntime = { beforeMeshes: 0, afterMeshes: 0, materialBuckets: 0, complete: false };
  const runtime = {
    loadedAssetRoots,
    propTemplates,
    propsRoot,
    shadowCasterCounts,
    shadowCasterMeshCounts,
    floorRotationEvidence,
    propMergeRuntime,
    detailsLoaded: 0,
    detailTotal: Object.keys(DETAIL_ASSETS).length + 1,
    beacon: undefined as THREE.Group | undefined,
  };

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshStandardMaterial({ color: 0x496b4f, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.08;
  ground.receiveShadow = true;
  trackRenderCategory(ground, "maze");
  scene.add(ground);
  const mazeRoot = new THREE.Group();
  scene.add(mazeRoot);

  const loader = new GLTFLoader();
  const load = async (url: string) => {
    const root = (await loader.loadAsync(url)).scene;
    loadedAssetRoots.add(root);
    if (isDisposed()) disposeObjectResources([root]);
    return root;
  };
  const totalBlocking = BLOCKING_ACTOR_SPECS.length + Object.keys(CORE_ASSETS).length;
  let loadedBlocking = 0;
  const markBlockingLoaded = (kind: string) => {
    loadedBlocking += 1;
    if (!isDisposed()) onLoadProgress({
      done: loadedBlocking,
      total: totalBlocking,
      message: `正在载入项目美术资产：${kind} ${loadedBlocking}/${totalBlocking}`,
    });
  };

  const placeActor = (name: ActorName, model: THREE.Object3D) => {
    const spec = ACTOR_SPECS.find((candidate) => candidate.name === name)!;
    const hideNodes = name === "police" ? ["shoulderepaulet", "epauletbutton", "sleevepatch", "sleevepatchinset"] : [];
    const actor = fitActor(model, spec.height, hideNodes);
    decorateActor(actor, spec.height, spec.color, spec.label);
    trackRenderCategory(actor, "actors");
    actors[name] = actor;
    if (name === "kid") actor.position.copy(world(getPlayer()));
    if (name === "villain") actor.position.copy(world(getVillain()));
    if (name === "police") {
      actor.position.copy(world(POLICE_POINT));
      actor.rotation.y = Math.PI;
    }
    scene.add(actor);
  };

  const buildCore = (assets: Record<keyof typeof CORE_ASSETS, THREE.Object3D>) => {
    const floorSalt: Record<"floor" | "grassFloor" | "classroomFloor" | "playgroundFloor", number> = {
      floor: 0,
      grassFloor: 11,
      classroomFloor: 23,
      playgroundFloor: 37,
    };
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
          const quarterTurn = gridQuarterTurn(x, y, floorSalt[floorName]);
          batches[floorName].push({ position, rotation: quarterTurn * Math.PI / 2 });
          floorRotationEvidence.histogram[quarterTurn] += 1;
          floorRotationEvidence.checksum = Math.imul(
            floorRotationEvidence.checksum ^ (x + 1) ^ Math.imul(y + 1, 31) ^ Math.imul(quarterTurn + 1, 131),
            16777619,
          ) >>> 0;
          if (floorRotationEvidence.samples.length < 24) {
            floorRotationEvidence.samples.push({ x, y, floor: floorName, quarterTurn });
          }
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
    const exitDoor = flattenStatic(fitModule(assets.exit, new THREE.Vector3(1.8, 2.5, 0.55)), false);
    exitDoor.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
    exitDoor.position.add(world(EXIT)).add(new THREE.Vector3(0, 0, CELL * 0.45));
    mazeRoot.add(exitDoor);
    trackRenderCategory(exitDoor, "maze");
    const gate = flattenStatic(fitModule(assets.frontGate, new THREE.Vector3(1.8, 2.4, 0.55)), false);
    gate.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
    gate.position.add(world(START)).add(new THREE.Vector3(0, 0, -CELL * 0.45));
    mazeRoot.add(gate);
    trackRenderCategory(gate, "maze");
    trackRenderCategory(mazeRoot, "maze");

    runtime.beacon = new THREE.Group();
    runtime.beacon.position.copy(world(EXIT));
    const beaconPad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.65, 0.65, 0.1, 40),
      new THREE.MeshStandardMaterial({ color: 0x41f28d, emissive: 0x18aa5c, emissiveIntensity: 3 }),
    );
    beaconPad.position.y = 0.08;
    runtime.beacon.add(beaconPad);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.7, 4.5, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x66ffad, transparent: true, opacity: 0.17, depthWrite: false, side: THREE.DoubleSide }),
    );
    beam.position.y = 2.25;
    runtime.beacon.add(beam);
    const exitLabel = makeLabel("出口", "#63ffad");
    exitLabel.position.y = 3.25;
    runtime.beacon.add(exitLabel);
    const exitLight = new THREE.PointLight(0x53f59e, 3.2, 9, 2);
    exitLight.position.y = 1.7;
    runtime.beacon.add(exitLight);
    trackRenderCategory(runtime.beacon, "fx");
    scene.add(runtime.beacon);
  };

  const addProp = (
    model: THREE.Object3D,
    point: Point,
    height: number,
    rotation = 0,
    offset = new THREE.Vector3(),
    castShadow = false,
    shadowName?: keyof typeof DETAIL_ASSETS,
  ) => {
    const cacheKey = `${model.uuid}:${height}:${castShadow ? "shadow" : "no-shadow"}`;
    const template = propTemplates.get(cacheKey) ?? fitProp(model, height, castShadow);
    propTemplates.set(cacheKey, template);
    const object = template.clone(true);
    object.position.add(world(point)).add(offset);
    object.rotation.y = rotation;
    if (shadowName) {
      let meshCount = 0;
      object.traverse((candidate) => {
        if (candidate instanceof THREE.Mesh && candidate.castShadow) meshCount += 1;
      });
      shadowCasterMeshCounts[shadowName] = (shadowCasterMeshCounts[shadowName] ?? 0) + meshCount;
    }
    trackRenderCategory(object, "props");
    propsRoot.add(object);
  };

  const placeDetail = (name: keyof typeof DETAIL_ASSETS, model: THREE.Object3D) => {
    const castShadow = largeShadowProps.has(name);
    const addDetailProp = (point: Point, height: number, rotation = 0, offset = new THREE.Vector3()) => {
      addProp(model, point, height, rotation, offset, castShadow, castShadow ? name : undefined);
      if (castShadow) shadowCasterCounts[name] = (shadowCasterCounts[name] ?? 0) + 1;
    };
    switch (name) {
      case "locker":
        addDetailProp({ x: 7, y: 5 }, 1.8, Math.PI / 2);
        addDetailProp({ x: 13, y: 19 }, 1.8, -Math.PI / 2);
        break;
      case "bench": addDetailProp({ x: 18, y: 16 }, 1.05, Math.PI / 2); break;
      case "tree": addDetailProp({ x: 3, y: 14 }, 3.5); break;
      case "shrub": addDetailProp({ x: 3, y: 12 }, 0.9); break;
      case "car": addDetailProp({ x: 22, y: 23 }, 1.6, Math.PI / 2, new THREE.Vector3(CELL * 0.75, 0, CELL * 0.75)); break;
      case "station": addDetailProp({ x: 23, y: 23 }, 3.2, Math.PI, new THREE.Vector3(0, 0, CELL * 1.6)); break;
      case "basketball": addDetailProp({ x: 20, y: 3 }, 2.6, -Math.PI / 2); break;
      case "classroomDoor": addDetailProp({ x: 9, y: 17 }, 2.2, Math.PI / 2, new THREE.Vector3(-CELL * 0.44, 0, 0)); break;
      case "deskChair": addDetailProp({ x: 9, y: 18 }, 1.2); break;
      case "blackboard": addDetailProp({ x: 9, y: 20 }, 1.5, Math.PI); break;
      case "podium": addDetailProp({ x: 9, y: 19 }, 1.1, Math.PI); break;
      case "bulletin": addDetailProp({ x: 11, y: 11 }, 1.25, -Math.PI / 2); break;
      case "extinguisher": addDetailProp({ x: 11, y: 10 }, 0.8, -Math.PI / 2); break;
      case "trash": addDetailProp({ x: 11, y: 12 }, 0.75, -Math.PI / 2); break;
      case "books": addDetailProp({ x: 11, y: 13 }, 0.18); break;
      case "backpack": addDetailProp({ x: 13, y: 16 }, 0.5); break;
      case "ceilingLight":
        for (const point of [{ x: 7, y: 4 }, { x: 15, y: 5 }, { x: 21, y: 12 }, { x: 17, y: 17 }]) {
          addDetailProp(point, 0.16, 0, new THREE.Vector3(0, 2.25, 0));
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
        if (!isDisposed()) placeActor(spec.name, model);
        markBlockingLoaded(spec.label);
      }));
      const core = {} as Partial<Record<keyof typeof CORE_ASSETS, THREE.Object3D>>;
      const coreTask = Promise.all((Object.entries(CORE_ASSETS) as [keyof typeof CORE_ASSETS, string][]).map(async ([name, url]) => {
        core[name] = await load(url);
        markBlockingLoaded("校园结构");
      }));
      await Promise.all([actorTask, coreTask]);
      if (isDisposed()) return;
      buildCore(core as Record<keyof typeof CORE_ASSETS, THREE.Object3D>);
      onReady();

      const policeTask = (async () => {
        try {
          const police = ACTOR_SPECS.find((spec) => spec.name === "police")!;
          const model = await load(police.url);
          if (!isDisposed()) placeActor("police", model);
        } catch (error) {
          console.warn("Exit police asset failed", error);
        } finally {
          runtime.detailsLoaded += 1;
          if (!isDisposed()) onDetailProgress(runtime.detailsLoaded);
        }
      })();
      const detailTasks = (Object.entries(DETAIL_ASSETS) as [keyof typeof DETAIL_ASSETS, string][]).map(async ([name, url]) => {
        try {
          const model = await load(url);
          if (!isDisposed()) placeDetail(name, model);
        } catch (error) {
          console.warn(`Optional environment asset failed: ${name}`, error);
        } finally {
          runtime.detailsLoaded += 1;
          if (!isDisposed()) onDetailProgress(runtime.detailsLoaded);
        }
      });
      await Promise.all([policeTask, ...detailTasks]);
      if (!isDisposed()) {
        const mergedProps = mergePlacedProps(propsRoot);
        propsRoot.clear();
        propsRoot.add(mergedProps.root);
        propTemplates.clear();
        Object.assign(propMergeRuntime, {
          beforeMeshes: mergedProps.beforeMeshes,
          afterMeshes: mergedProps.afterMeshes,
          materialBuckets: mergedProps.materialBuckets,
          complete: true,
        });
        trackRenderCategory(mergedProps.root, "props");
      }
    } catch (error) {
      console.error("Failed to load required 3D assets", error);
      if (!isDisposed()) onLoadError("角色或校园模型载入失败，请刷新后重试。控制台已记录具体素材。");
    }
  };

  return Object.assign(runtime, { setup });
}
