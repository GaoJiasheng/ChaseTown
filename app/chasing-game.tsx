"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import {
  BLOCKING_ACTOR_SPECS,
  CORE_ASSETS,
  DETAIL_ASSETS,
  EXIT,
  P0_TUNING,
  P1_SHADOW_CASTERS,
  P1_TUNING,
  P2_TUNING,
  PATROL,
  POLICE_POINT,
  START,
  VILLAIN_START,
} from "./game/config/index.js";
import type {
  ActorMotionRuntime,
  ActorName,
  AiMemory,
  GpuMemorySnapshot,
  GridPathCache,
  Phase,
  Point,
  ResourceDisposalReport,
} from "./game/core/types.js";
import {
  canPlayerOccupy,
  canWalk,
  distance,
  findGridPath,
  gridPathDistanceMeters,
  hasLineOfSight,
  roundedCell,
  world,
} from "./game/level/maze.js";
import {
  CAMERA_DIRECTION,
  SCREEN_RIGHT,
  SCREEN_UP,
  finalThreat,
  proximityThreat,
  threatStateFactor,
  vignetteStrength,
} from "./game/camera/index.js";
import { screenAlignedMove } from "./game/input/index.js";
import {
  pathCacheInvalidationReason,
  pathCacheSignature,
  planVillainAi,
  stepVillainToward,
} from "./game/ai/index.js";
import {
  poseRig,
  setActorLabel,
  setActorMarkerOpacity,
  shouldPoliceTrack,
  syncActor,
} from "./game/player/actors.js";
import { makeSynthAudioRuntime } from "./game/audio/index.js";
import { disposeObjectResources } from "./game/core/resources.js";
import { createSceneArtRuntime } from "./game/art/scene-runtime.js";
import { markerTargetOpacity } from "./game/ui/feedback.js";
import {
  makeRenderBreakdown,
  trackRenderCategory,
  type RenderCategory,
} from "./game/ui/render-fx.js";

export {
  P0_TUNING,
  P1_SHADOW_CASTERS,
  P1_TUNING,
  P2_TUNING,
  advanceGaitPhase,
  advanceGaitWeight,
  canPlayerOccupy,
  dampAngle,
  disposeObjectResources,
  finalThreat,
  findGridPath,
  gridPathDistanceMeters,
  gridQuarterTurn,
  hasLineOfSight,
  markerTargetOpacity,
  pathCacheInvalidationReason,
  pathCacheSignature,
  planVillainAi,
  proximityThreat,
  screenAlignedMove,
  shouldPoliceTrack,
  stepVillainToward,
  threatStateFactor,
  vignetteStrength,
} from "./game/index.js";

export function ChasingGame() {
  const mount = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>());
  const player = useRef<Point>({ ...START });
  const villain = useRef<Point>({ ...VILLAIN_START });
  const patrol = useRef(0);
  const aiMemory = useRef<AiMemory>({ state: "delay", lastKnown: null, searchArrivedAt: null });
  const villainHeading = useRef(Math.PI / 2);
  const villainTarget = useRef<Point | null>(null);
  const villainSeesPlayer = useRef(false);
  const villainTurn = useRef({ error: 0, speedMultiplier: 1 });
  const villainPathCache = useRef<GridPathCache>({
    signature: "",
    route: [],
    cursor: 0,
    activeWaypoint: null,
    recomputes: 0,
    cacheHits: 0,
    lastInvalidationReason: "empty-cache",
  });
  const lastInputIntent = useRef<Point>({ x: 0, y: 0 });
  const lastPlayerDelta = useRef<Point>({ x: 0, y: 0 });
  const inputSafety = useRef({ clearCount: 0, lastClearReason: null as string | null });
  const caughtAt = useRef<number | null>(null);
  const started = useRef(0);
  const readyRef = useRef(false);
  const phaseRef = useRef<Phase>("ready");
  const cameraZoom = useRef(1);
  const actors = useRef<Partial<Record<ActorName, THREE.Object3D>>>({});
  const objectiveDistanceRuntime = useRef(gridPathDistanceMeters(START, EXIT) ?? 0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [elapsed, setElapsed] = useState(0);
  const [objectiveDistance, setObjectiveDistance] = useState(gridPathDistanceMeters(START, EXIT) ?? 0);
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
    aiMemory.current = { state: "delay", lastKnown: null, searchArrivedAt: null };
    villainHeading.current = Math.PI / 2;
    villainTarget.current = null;
    villainSeesPlayer.current = false;
    villainTurn.current = { error: 0, speedMultiplier: 1 };
    villainPathCache.current = {
      signature: "",
      route: [],
      cursor: 0,
      activeWaypoint: null,
      recomputes: 0,
      cacheHits: 0,
      lastInvalidationReason: "empty-cache",
    };
    lastInputIntent.current = { x: 0, y: 0 };
    lastPlayerDelta.current = { x: 0, y: 0 };
    caughtAt.current = null;
    started.current = performance.now();
    for (const [name, actor] of Object.entries(actors.current)) {
      if (!actor) continue;
      const resetPoint = name === "kid" ? START : name === "villain" ? VILLAIN_START : POLICE_POINT;
      const resetHeading = name === "villain" ? Math.PI / 2 : name === "police" ? Math.PI : 0;
      actor.position.copy(world(resetPoint));
      actor.rotation.y = resetHeading;
      const motion = actor?.userData.motion as ActorMotionRuntime | undefined;
      if (motion) {
        motion.gaitWeight = 0;
        motion.gaitPhase = 0;
        motion.actualSpeed = 0;
        motion.heading = resetHeading;
        motion.targetHeading = motion.heading;
      }
      const visual = actor.userData.visual as THREE.Group | undefined;
      if (visual) {
        const baseY = visual.userData.baseY as number;
        visual.position.y = baseY;
        visual.rotation.set(0, 0, 0);
      }
      poseRig(actor, 0, 0);
      actor.userData.markerTargetOpacity = 1;
      setActorMarkerOpacity(actor, 1);
    }
    setElapsed(0);
    objectiveDistanceRuntime.current = gridPathDistanceMeters(START, EXIT) ?? 0;
    setObjectiveDistance(objectiveDistanceRuntime.current);
    changePhase("playing");
  }, [changePhase]);

  useEffect(() => {
    const clearKeys = (reason: string) => {
      keys.current.clear();
      inputSafety.current.clearCount += 1;
      inputSafety.current.lastClearReason = reason;
    };
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
    const clearOnBlur = () => clearKeys("window-blur");
    const visibilityEvent = ["visibility", "change"].join("");
    const clearWhenHidden = () => {
      if (document.hidden) clearKeys("document-hidden");
    };
    addEventListener("keydown", keyDown);
    addEventListener("keyup", keyUp);
    addEventListener("blur", clearOnBlur);
    document.addEventListener(visibilityEvent, clearWhenHidden);
    return () => {
      removeEventListener("keydown", keyDown);
      removeEventListener("keyup", keyUp);
      removeEventListener("blur", clearOnBlur);
      document.removeEventListener(visibilityEvent, clearWhenHidden);
      clearKeys("input-effect-cleanup");
    };
  }, [reset]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;
    let last = performance.now();
    let lastHudUpdate = 0;
    let lastVignetteUpdate = 0;
    let observer: ResizeObserver | null = null;
    readyRef.current = false;
    actors.current = {};
    const audioRuntime = makeSynthAudioRuntime(window);
    const unlockAudio = () => { void audioRuntime.unlock(); };
    const audioVisibilityEvent = ["visibility", "change"].join("");
    const suspendAudioWhenHidden = () => { if (document.hidden) void audioRuntime.suspend(); };
    addEventListener("pointerdown", unlockAudio);
    addEventListener("keydown", unlockAudio);
    document.addEventListener(audioVisibilityEvent, suspendAudioWhenHidden);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x91aa99);
    scene.fog = new THREE.Fog(0x91aa99, 25, 62);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 130);
    const cameraDirection = new THREE.Vector3(CAMERA_DIRECTION.x, CAMERA_DIRECTION.y, CAMERA_DIRECTION.z).normalize();
    const cameraRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), cameraDirection).normalize();
    const cameraUp = new THREE.Vector3().crossVectors(cameraDirection, cameraRight).normalize();
    const cameraFocus = world(START).add(new THREE.Vector3(0, 1.02, 0));
    let cameraDistance = 15.6;
    const cameraRuntime = { threat: 0, targetDistance: cameraDistance };
    const threatRuntime = {
      distance: distance(player.current, villain.current),
      proximity: 0,
      stateFactor: P2_TUNING.unawareStateFactor as number,
      final: 0,
      vignette: 0,
      cssValue: "0.000",
    };
    camera.position.copy(cameraFocus).addScaledVector(cameraDirection, cameraDistance);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = P1_TUNING.exposure;
    host.appendChild(renderer.domElement);
    const gpuMemory = (): GpuMemorySnapshot => ({
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    });
    const roomEnvironment = new RoomEnvironment();
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const environmentTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
    scene.environment = environmentTarget.texture;
    roomEnvironment.dispose();
    pmremGenerator.dispose();
    const hemisphere = new THREE.HemisphereLight(0xe4f7ff, 0x405846, P1_TUNING.hemisphereIntensity);
    const sun = new THREE.DirectionalLight(0xffefd0, P1_TUNING.sunIntensity);
    const rim = new THREE.DirectionalLight(0x9bc8ff, P1_TUNING.rimIntensity);
    let gpuReleased = false;
    let lastDisposal: ResourceDisposalReport | null = null;
    const readPreviousDisposal = () => {
      try {
        const raw = sessionStorage.getItem("chasing-last-disposal");
        return raw ? JSON.parse(raw) as ResourceDisposalReport : null;
      } catch {
        return null;
      }
    };
    const releaseGpuResources = (reason: string): ResourceDisposalReport => {
      if (gpuReleased && lastDisposal) return { ...lastDisposal, reason, alreadyDisposed: true };
      const before = gpuMemory();
      const disposedResources = disposeObjectResources([
        scene,
        ...artRuntime.loadedAssetRoots,
        ...artRuntime.propTemplates.values(),
      ]);
      scene.environment = null;
      environmentTarget.dispose();
      const shadowMap = sun.shadow.map;
      const shadowMapPass = sun.shadow.mapPass;
      sun.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      const after = gpuMemory();
      gpuReleased = true;
      lastDisposal = {
        reason,
        ...disposedResources,
        externalTargets: 1 + (shadowMap ? 1 : 0) + (shadowMapPass ? 1 : 0),
        before,
        after,
        completedAt: performance.now(),
        alreadyDisposed: false,
        contextLost: true,
      };
      try {
        const serialized = JSON.stringify(lastDisposal);
        sessionStorage.setItem("chasing-last-disposal", serialized);
        document.documentElement.dataset.chasingLastDisposal = serialized;
      } catch {
        // A disposal report is diagnostic only; cleanup must still complete.
      }
      return lastDisposal;
    };
    const policeRuntime = {
      trackingPlayer: false,
      distanceToExit: distance(player.current, EXIT),
      targetHeading: Math.PI,
    };
    const qaWindow = window as typeof window & {
      __CHASING_QA__?: {
        getState: () => unknown;
        setPositions: (next: { player?: Point; villain?: Point }) => void;
        dispose: () => ResourceDisposalReport;
      };
    };
    let qaApi: typeof qaWindow.__CHASING_QA__;
    let qaLastSnapshotUpdate = 0;
    const qaRenderSnapshot = {
      calls: 0,
      triangles: 0,
      frame: 0,
      capturedAt: 0,
      memory: gpuMemory(),
    };
    let activeRenderBreakdown = makeRenderBreakdown();
    let qaRenderBreakdown = makeRenderBreakdown();
    let qaRenderReconciliation = {
      rawUnclassifiedCalls: 0,
      rawUnclassifiedTriangles: 0,
      callsDelta: 0,
      trianglesDelta: 0,
    };
    const trackSceneRenderCategory = (root: THREE.Object3D, category: RenderCategory) => {
      trackRenderCategory(root, category, () => activeRenderBreakdown);
    };
    const qaMotionSamples: { at: number; weight: number; phase: number; speed: number; heading: number; targetHeading: number }[] = [];
    const qaPathSamples: {
      at: number;
      signature: string;
      recomputes: number;
      cacheHits: number;
      activeWaypoint: Point | null;
      villain: Point;
    }[] = [];
    let qaLastPathSample = 0;
    let qaInput: HTMLInputElement | undefined;
    let qaButton: HTMLButtonElement | undefined;
    const getQaState = () => {
      const snapshotNow = performance.now();
      const lastKnown = aiMemory.current.lastKnown;
      const badge = actors.current.villain?.userData.badge as THREE.Sprite | undefined;
      const motion = Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => {
        const state = actor?.userData.motion as ActorMotionRuntime | undefined;
        return [name, state ? { ...state } : null];
      }));
      const markers = Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => {
        const actorBadge = actor?.userData.badge as THREE.Sprite | undefined;
        const actorRing = actor?.userData.ring as THREE.Mesh | undefined;
        const badgeMaterial = actorBadge?.material as THREE.SpriteMaterial | undefined;
        const ringMaterial = actorRing?.material as THREE.MeshBasicMaterial | undefined;
        return [name, {
          targetOpacity: actor?.userData.markerTargetOpacity ?? null,
          opacity: actor?.userData.markerOpacity ?? null,
          badgeOpacity: badgeMaterial?.opacity ?? null,
          ringOpacity: ringMaterial?.opacity ?? null,
        }];
      }));
      const villainMargin = P1_TUNING.villainCollisionMargin;
      return {
        phase: phaseRef.current,
        player: { ...player.current },
        villain: { ...villain.current },
        distance: distance(player.current, villain.current),
        lineOfSight: hasLineOfSight(villain.current, player.current),
        aiState: aiMemory.current.state,
        lastKnown: lastKnown ? { ...lastKnown } : null,
        ai: {
          state: aiMemory.current.state,
          lastKnown: lastKnown ? { ...lastKnown } : null,
          seesPlayer: villainSeesPlayer.current,
          target: villainTarget.current ? { ...villainTarget.current } : null,
          heading: villainHeading.current,
          turnError: villainTurn.current.error,
          speedMultiplier: villainTurn.current.speedMultiplier,
          searchElapsedMs: aiMemory.current.searchArrivedAt === null
            ? null
            : snapshotNow - aiMemory.current.searchArrivedAt,
        },
        ready: readyRef.current,
        startedElapsedMs: started.current === 0 ? 0 : snapshotNow - started.current,
        delayRemainingMs: Math.max(0, P0_TUNING.startDelayMs - (snapshotNow - started.current)),
        villainLabel: badge?.userData.labelText ?? null,
        input: {
          screenUp: { ...SCREEN_UP },
          screenRight: { ...SCREEN_RIGHT },
          intent: { ...lastInputIntent.current },
          playerDelta: { ...lastPlayerDelta.current },
          activeKeys: [...keys.current].sort(),
          clearCount: inputSafety.current.clearCount,
          lastClearReason: inputSafety.current.lastClearReason,
        },
        collision: {
          margin: P0_TUNING.playerCollisionMargin,
          villainMargin,
          villainOccupancy: canPlayerOccupy(villain.current.x, villain.current.y, villainMargin),
          villainCornerSamples: [
            { x: villain.current.x - villainMargin, y: villain.current.y - villainMargin },
            { x: villain.current.x + villainMargin, y: villain.current.y - villainMargin },
            { x: villain.current.x - villainMargin, y: villain.current.y + villainMargin },
            { x: villain.current.x + villainMargin, y: villain.current.y + villainMargin },
          ],
        },
        capture: {
          startedAt: caughtAt.current,
          elapsedMs: caughtAt.current === null ? null : snapshotNow - caughtAt.current,
          freezeMs: P0_TUNING.captureFreezeMs,
        },
        tuning: { ...P0_TUNING },
        polishTuning: { ...P1_TUNING },
        hardeningTuning: { ...P2_TUNING },
        threat: {
          ...threatRuntime,
          aiState: aiMemory.current.state,
        },
        pathfinding: {
          ...villainPathCache.current,
          route: villainPathCache.current.route.map((point) => ({ ...point })),
          activeWaypoint: villainPathCache.current.activeWaypoint
            ? { ...villainPathCache.current.activeWaypoint }
            : null,
          samples: qaPathSamples.slice(-80),
          hudDistanceMeters: objectiveDistanceRuntime.current,
        },
        audio: audioRuntime.getSnapshot(),
        assets: {
          detailsLoaded: artRuntime.detailsLoaded,
          detailTotal: artRuntime.detailTotal,
          detailsComplete: artRuntime.detailsLoaded === artRuntime.detailTotal,
        },
        actors: Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => [name, actor?.position.toArray()])),
        motion,
        motionSamples: qaMotionSamples.slice(-60),
        markers,
        environment: {
          enabled: scene.environment === environmentTarget.texture,
          mapping: environmentTarget.texture.mapping,
          envMapIntensity: P1_TUNING.environmentIntensity,
        },
        lighting: {
          exposure: renderer.toneMappingExposure,
          hemisphereIntensity: hemisphere.intensity,
          sunIntensity: sun.intensity,
          rimIntensity: rim.intensity,
          sunShadowBias: sun.shadow.bias,
          sunShadowNormalBias: sun.shadow.normalBias,
          sunShadowMapSize: sun.shadow.mapSize.toArray(),
          shadowCasterNames: [...P1_SHADOW_CASTERS],
          shadowCasterInstances: { ...artRuntime.shadowCasterCounts },
          shadowCasterMeshes: { ...artRuntime.shadowCasterMeshCounts },
          shadowCasterStrategy: "two-largest-bounds-per-prop",
        },
        layout: {
          floorRotationSamples: artRuntime.floorRotationEvidence.samples,
          quarterTurnHistogram: [...artRuntime.floorRotationEvidence.histogram],
          floorRotationChecksum: artRuntime.floorRotationEvidence.checksum,
          wallRandomized: artRuntime.floorRotationEvidence.wallRandomized,
        },
        police: {
          ...policeRuntime,
          heading: actors.current.police?.rotation.y ?? null,
          visualYOffset: (actors.current.police?.userData.motion as ActorMotionRuntime | undefined)?.visualY ?? null,
        },
        render: { calls: qaRenderSnapshot.calls,
          triangles: qaRenderSnapshot.triangles,
          frame: qaRenderSnapshot.frame,
          capturedAt: qaRenderSnapshot.capturedAt,
          memory: { ...qaRenderSnapshot.memory },
          breakdown: structuredClone(qaRenderBreakdown),
          reconciliation: { ...qaRenderReconciliation },
          optimization: {
            propMerge: { ...artRuntime.propMergeRuntime },
            actorShadowStrategy: "three-largest-triangle-meshes-per-actor",
            actorShadowBudgets: Object.fromEntries(Object.entries(actors.current).map(([name, actor]) => [name, actor?.userData.shadowBudget ?? null])),
          },
        },
        disposal: {
          released: gpuReleased,
          current: lastDisposal,
          previous: readPreviousDisposal(),
          activeMemory: gpuMemory(),
        },
        camera: {
          position: camera.position.toArray(),
          direction: cameraDirection.toArray(),
          fov: camera.fov,
          zoom: cameraZoom.current,
          threat: cameraRuntime.threat,
          targetDistance: cameraRuntime.targetDistance,
        },
      };
    };
    const setQaPositions = (next: { player?: Point; villain?: Point }) => {
      if (next.player && Number.isFinite(next.player.x) && Number.isFinite(next.player.y) && canWalk(next.player.x, next.player.y)) {
        player.current = { ...next.player };
      }
      if (next.villain && Number.isFinite(next.villain.x) && Number.isFinite(next.villain.y) && canWalk(next.villain.x, next.villain.y)) {
        villain.current = { ...next.villain };
      }
    };
    if (new URLSearchParams(window.location.search).has("qa")) {
      qaApi = {
        getState: getQaState,
        setPositions: setQaPositions,
        dispose: () => {
          disposed = true;
          readyRef.current = false;
          cancelAnimationFrame(frame);
          void audioRuntime.dispose();
          return releaseGpuResources("qa-command");
        },
      };
      qaWindow.__CHASING_QA__ = qaApi;
      host.dataset.qaEnabled = "true";
      qaInput = document.createElement("input");
      qaInput.className = "qa-position-input";
      qaInput.setAttribute("aria-label", "QA 坐标命令");
      qaInput.autocomplete = "off";
      qaButton = document.createElement("button");
      qaButton.className = "qa-position-apply";
      qaButton.type = "button";
      qaButton.setAttribute("aria-label", "执行 QA 坐标");
      qaButton.textContent = "QA";
      qaButton.addEventListener("click", () => {
        try {
          const command = JSON.parse(qaInput?.value ?? "{}") as { player?: Point; villain?: Point; dispose?: boolean };
          if (command.dispose) qaApi?.dispose();
          else qaApi?.setPositions(command);
          host.dataset.qaPlacementState = JSON.stringify(qaApi?.getState());
        } catch {
          // Invalid test input is ignored just like an invalid setPositions payload.
        }
      });
      host.append(qaInput, qaButton);
    }

    scene.add(hemisphere);
    sun.position.set(-16, 26, -12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.bias = P1_TUNING.sunShadowBias;
    sun.shadow.normalBias = P1_TUNING.sunShadowNormalBias;
    scene.add(sun);
    rim.position.set(18, 16, 22);
    scene.add(rim);

    const artRuntime = createSceneArtRuntime({
      scene,
      actors: actors.current,
      getPlayer: () => player.current,
      getVillain: () => villain.current,
      isDisposed: () => disposed,
      onLoadProgress: setLoadProgress,
      onDetailProgress: setDetailProgress,
      onReady: () => {
        readyRef.current = true;
        setLoading(false);
        if (new URLSearchParams(window.location.search).get("autostart") === "1") reset();
      },
      onLoadError: setLoadError,
      trackRenderCategory: trackSceneRenderCategory,
    });
    void artRuntime.setup();

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.4));
      renderer.setSize(bounds.width, bounds.height, false);
      camera.aspect = bounds.width / Math.max(bounds.height, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(host);
    const adjustZoom = (event: WheelEvent) => {
      event.preventDefault();
      cameraZoom.current = THREE.MathUtils.clamp(cameraZoom.current * Math.exp(event.deltaY * 0.0007), 0.78, 1.55);
    };
    host.addEventListener("wheel", adjustZoom, { passive: false });

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
        const move = screenAlignedMove(dx, dy);
        lastInputIntent.current = { ...move };
        const current = player.current;
        const previous = { ...current };
        const nextX = current.x + move.x * P0_TUNING.playerSpeed * delta;
        const nextY = current.y + move.y * P0_TUNING.playerSpeed * delta;
        if (canPlayerOccupy(nextX, current.y)) current.x = nextX;
        if (canPlayerOccupy(current.x, nextY)) current.y = nextY;
        lastPlayerDelta.current = { x: current.x - previous.x, y: current.y - previous.y };

        const decision = planVillainAi(aiMemory.current, villain.current, current, now, started.current);
        aiMemory.current = decision.memory;
        villainSeesPlayer.current = decision.seesPlayer;
        let target = decision.target;
        if (aiMemory.current.state === "patrol") target = PATROL[patrol.current];
        villainTarget.current = target ? { ...target } : null;
        if (target) {
          const signature = pathCacheSignature(aiMemory.current.state, villain.current, target);
          const invalidationReason = pathCacheInvalidationReason(villainPathCache.current.signature, signature);
          if (invalidationReason) {
            const route = findGridPath(villain.current, target);
            const startsAtCenter = route[0]
              ? distance(villain.current, route[0]) <= P2_TUNING.pathWaypointTolerance
              : false;
            villainPathCache.current.signature = signature;
            villainPathCache.current.route = route;
            villainPathCache.current.cursor = startsAtCenter ? 1 : 0;
            villainPathCache.current.recomputes += 1;
            villainPathCache.current.lastInvalidationReason = invalidationReason;
          } else {
            villainPathCache.current.cacheHits += 1;
          }
          const cachedWaypoint = villainPathCache.current.route[villainPathCache.current.cursor];
          if (cachedWaypoint && distance(villain.current, cachedWaypoint) <= P2_TUNING.pathWaypointTolerance) {
            villainPathCache.current.cursor += 1;
          }
          villainPathCache.current.activeWaypoint = villainPathCache.current.route[villainPathCache.current.cursor]
            ?? target;
          const step = stepVillainToward(
            villain.current,
            target,
            villainHeading.current,
            P0_TUNING.villainSpeed,
            delta,
            villainPathCache.current.route.length
              ? [roundedCell(villain.current), villainPathCache.current.activeWaypoint]
              : [],
          );
          villain.current = step.point;
          villainHeading.current = step.heading;
          villainTurn.current = { error: step.turnError, speedMultiplier: step.speedMultiplier };
          if (aiMemory.current.state === "patrol" && distance(villain.current, target) < 0.25) {
            patrol.current = (patrol.current + 1) % PATROL.length;
          }
          if (qaApi && (invalidationReason || now - qaLastPathSample >= 100)) {
            qaLastPathSample = now;
            qaPathSamples.push({
              at: now,
              signature: villainPathCache.current.signature,
              recomputes: villainPathCache.current.recomputes,
              cacheHits: villainPathCache.current.cacheHits,
              activeWaypoint: villainPathCache.current.activeWaypoint
                ? { ...villainPathCache.current.activeWaypoint }
                : null,
              villain: { ...villain.current },
            });
            if (qaPathSamples.length > 80) qaPathSamples.shift();
          }
        } else {
          villainTurn.current = { error: 0, speedMultiplier: 1 };
          villainPathCache.current.activeWaypoint = null;
        }

        if (distance(current, villain.current) < 0.58) {
          caughtAt.current = now;
          changePhase("caught");
        } else if (distance(current, EXIT) < 0.62) {
          const seconds = Math.max(0, Math.floor((now - started.current) / 1000));
          setElapsed(seconds);
          changePhase("won");
        }
        if (now - lastHudUpdate > 180) {
          const seconds = Math.max(0, Math.floor((now - started.current) / 1000));
          setElapsed((value) => value === seconds ? value : seconds);
          objectiveDistanceRuntime.current = gridPathDistanceMeters(current, EXIT) ?? 0;
          setObjectiveDistance(objectiveDistanceRuntime.current);
          lastHudUpdate = now;
        }
      } else if (
        phaseRef.current === "caught"
        && caughtAt.current !== null
        && now - caughtAt.current >= P0_TUNING.captureFreezeMs
      ) {
        changePhase("lost");
      }

      const delayRemaining = P0_TUNING.startDelayMs - (now - started.current);
      if (phaseRef.current === "playing" && delayRemaining > 0) {
        const tenths = Math.max(1, Math.ceil(delayRemaining / 100));
        setActorLabel(actors.current.villain, `${(tenths / 10).toFixed(1)}s`, "#f6c965");
      } else {
        setActorLabel(actors.current.villain, "追捕者", "#ff4f5e");
      }
      const freezeCapturedPose = phaseRef.current === "caught";
      syncActor(actors.current.kid, player.current, 0, delta, {
        dampHeading: true,
        headingDamping: P1_TUNING.playerTurnDamping,
        freezePose: freezeCapturedPose,
      });
      syncActor(actors.current.villain, villain.current, 2, delta, {
        authoredHeading: villainHeading.current,
        freezePose: freezeCapturedPose,
      });
      policeRuntime.distanceToExit = distance(player.current, EXIT);
      policeRuntime.trackingPlayer = shouldPoliceTrack(player.current);
      if (policeRuntime.trackingPlayer) {
        policeRuntime.targetHeading = Math.atan2(
          player.current.x - POLICE_POINT.x,
          player.current.y - POLICE_POINT.y,
        );
      }
      syncActor(actors.current.police, POLICE_POINT, 4, delta, {
        authoredHeading: policeRuntime.trackingPlayer ? policeRuntime.targetHeading : undefined,
        dampHeading: true,
        headingDamping: P1_TUNING.policeTurnDamping,
        freezePose: freezeCapturedPose,
      });
      const kidMotion = actors.current.kid?.userData.motion as ActorMotionRuntime | undefined;
      if (qaApi && kidMotion) {
        qaMotionSamples.push({
          at: now,
          weight: kidMotion.gaitWeight,
          phase: kidMotion.gaitPhase,
          speed: kidMotion.actualSpeed,
          heading: kidMotion.heading,
          targetHeading: kidMotion.targetHeading,
        });
        if (qaMotionSamples.length > 60) qaMotionSamples.shift();
      }
      const enemyDistance = distance(player.current, villain.current);
      const proximity = proximityThreat(enemyDistance);
      const stateFactor = threatStateFactor(aiMemory.current.state);
      const currentThreat = finalThreat(enemyDistance, aiMemory.current.state, phaseRef.current);
      const currentVignette = vignetteStrength(currentThreat);
      threatRuntime.distance = enemyDistance;
      threatRuntime.proximity = proximity;
      threatRuntime.stateFactor = stateFactor;
      threatRuntime.final = currentThreat;
      threatRuntime.vignette = currentVignette;
      cameraRuntime.threat = currentThreat;
      audioRuntime.onPhase(phaseRef.current);
      audioRuntime.update(currentThreat, kidMotion);
      if (now - lastVignetteUpdate >= P2_TUNING.vignetteUiIntervalMs) {
        threatRuntime.cssValue = currentVignette.toFixed(3);
        host.style.setProperty("--danger-level", threatRuntime.cssValue);
        lastVignetteUpdate = now;
      }
      if (phaseRef.current !== "caught") {
        const playerAnchor = world(player.current).add(new THREE.Vector3(0, 1.02, 0));
        const villainAnchor = world(villain.current).add(new THREE.Vector3(0, 1.02, 0));
        const threat = currentThreat;
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
        cameraRuntime.targetDistance = targetDistance;
        cameraDistance = THREE.MathUtils.lerp(cameraDistance, targetDistance, 1 - Math.exp(-3.2 * delta));
        const desired = cameraFocus.clone().addScaledVector(cameraDirection, cameraDistance);
        camera.position.lerp(desired, 1 - Math.exp(-6 * delta));
        camera.lookAt(cameraFocus);
      }
      const markerElapsedMs = started.current === 0 ? 0 : now - started.current;
      for (const [name, actor] of Object.entries(actors.current)) {
        if (!actor) continue;
        const targetOpacity = markerTargetOpacity(
          phaseRef.current,
          markerElapsedMs,
          cameraRuntime.threat,
          name === "villain",
        );
        const currentOpacity = actor.userData.markerOpacity as number ?? 1;
        const opacity = currentOpacity + (targetOpacity - currentOpacity) * (1 - Math.exp(-P1_TUNING.markerFadeDamping * delta));
        actor.userData.markerTargetOpacity = targetOpacity;
        setActorMarkerOpacity(actor, opacity);
      }
      if (artRuntime.beacon) {
        artRuntime.beacon.rotation.y += delta * 0.45;
        const pulse = 1 + Math.sin(now * 0.004) * 0.08;
        artRuntime.beacon.scale.setScalar(pulse);
      }
      activeRenderBreakdown = makeRenderBreakdown();
      renderer.info.reset();
      renderer.render(scene, camera);
      qaRenderSnapshot.calls = renderer.info.render.calls;
      qaRenderSnapshot.triangles = renderer.info.render.triangles;
      qaRenderSnapshot.frame += 1;
      qaRenderSnapshot.capturedAt = now;
      qaRenderSnapshot.memory = gpuMemory();
      const classifiedCalls = Object.values(activeRenderBreakdown).reduce(
        (total, budget) => total + budget.mainCalls + budget.shadowCalls,
        0,
      );
      const classifiedTriangles = Object.values(activeRenderBreakdown).reduce(
        (total, budget) => total + budget.mainTriangles + budget.shadowTriangles,
        0,
      );
      const unclassifiedCalls = renderer.info.render.calls - classifiedCalls;
      const unclassifiedTriangles = renderer.info.render.triangles - classifiedTriangles;
      activeRenderBreakdown.other.mainCalls += unclassifiedCalls;
      activeRenderBreakdown.other.mainTriangles += unclassifiedTriangles;
      qaRenderBreakdown = structuredClone(activeRenderBreakdown);
      qaRenderReconciliation = {
        rawUnclassifiedCalls: unclassifiedCalls,
        rawUnclassifiedTriangles: unclassifiedTriangles,
        callsDelta: renderer.info.render.calls - Object.values(qaRenderBreakdown).reduce(
          (total, budget) => total + budget.mainCalls + budget.shadowCalls,
          0,
        ),
        trianglesDelta: renderer.info.render.triangles - Object.values(qaRenderBreakdown).reduce(
          (total, budget) => total + budget.mainTriangles + budget.shadowTriangles,
          0,
        ),
      };
      if (qaApi && now - qaLastSnapshotUpdate >= 50) {
        qaLastSnapshotUpdate = now;
        host.dataset.qaState = JSON.stringify(qaApi.getState());
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      readyRef.current = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      host.removeEventListener("wheel", adjustZoom);
      removeEventListener("pointerdown", unlockAudio);
      removeEventListener("keydown", unlockAudio);
      document.removeEventListener(audioVisibilityEvent, suspendAudioWhenHidden);
      void audioRuntime.dispose();
      releaseGpuResources("react-cleanup");
      host.style.removeProperty("--danger-level");
      if (qaWindow.__CHASING_QA__ === qaApi) delete qaWindow.__CHASING_QA__;
      if (qaApi) {
        delete host.dataset.qaEnabled;
        delete host.dataset.qaPlacementState;
        delete host.dataset.qaState;
        qaInput?.remove();
        qaButton?.remove();
      }
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
        <div className={`capture-transition${phase === "caught" ? " active" : ""}`} aria-hidden="true" />
        {phase !== "playing" && phase !== "caught" && !loading && (
          <div className={`overlay ${phase}`}>
            <div className="overlay-card">
              <span className={`result ${phase}`}>{phase === "won" ? "成功逃脱" : phase === "lost" ? "被抓住了" : "3D 逃生演练"}</span>
              <h2>{phase === "won" ? `警察在出口等到了你 · 用时 ${elapsed}s` : phase === "lost" ? "别停，换条路线再试一次" : "躲开追捕者，跑到绿色出口"}</h2>
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
