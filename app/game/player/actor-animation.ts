import * as THREE from "three";

import { EXIT, P0_TUNING, P1_TUNING } from "../config/index.js";
import type { ActorMotionRuntime, ActorName, Point } from "../core/types.js";
import { shortestAngle } from "../camera/index.js";
import { distance, hasLineOfSight } from "../level/maze.js";

export const ACTOR_CLIP_NAMES = [
  "Idle",
  "Run",
  "Walk",
  "TurnLeft",
  "TurnRight",
  "LookAround",
  "ScaredCaught",
  "Celebrate",
  "PointAlert",
] as const;

export type ActorClipName = typeof ACTOR_CLIP_NAMES[number];

export type ActorAnimationPlan = Readonly<{
  base: "Idle" | "Run" | "Walk";
  special: Exclude<ActorClipName, "Idle" | "Run" | "Walk"> | null;
  reason: string;
}>;

export type ActorAnimationContext = Readonly<{
  role: ActorName;
  moving: boolean;
  gaitWeight: number;
  caught: boolean;
  won: boolean;
  reducedMotion: boolean;
  seesPlayer: boolean;
  searchHolding: boolean;
  turnDelta: number;
}>;

export type ActorAnimationQa = {
  source: "embedded-gltf";
  availableClips: ActorClipName[];
  missingClips: ActorClipName[];
  currentClip: ActorClipName;
  activeClips: ActorClipName[];
  weights: Record<ActorClipName, number>;
  clipTimes: Record<ActorClipName, number>;
  timeScales: Record<ActorClipName, number>;
  transitionSeconds: number;
  reason: string;
  reducedMotion: boolean;
  captureLatched: boolean;
  mixerUpdates: number;
  batchMeshes: number | null;
  shadowProxyCreated: boolean;
  shadowSkeletonShared: boolean;
  cleanupBound: boolean;
  gameplayStarted: boolean;
  auditionClip: ActorClipName | null;
};

type MotionWithAnimationQa = ActorMotionRuntime & { animation?: ActorAnimationQa };

export type ActorAnimationRuntime = {
  role: ActorName;
  mixer: THREE.AnimationMixer;
  actions: Record<ActorClipName, THREE.AnimationAction>;
  clips: Record<ActorClipName, THREE.AnimationClip>;
  weights: Record<ActorClipName, number>;
  special: ActorAnimationPlan["special"];
  specialWeight: number;
  locomotion: "Run" | "Walk";
  locomotionWeights: { Run: number; Walk: number };
  searchHolding: boolean;
  captureLatched: boolean;
  scaredCaughtTimeScale: number;
  lastTargetHeading: number;
  getPlayer: () => Point;
  session: { started: boolean };
  context: MutableActorAnimationContext;
  auditionClip: ActorClipName | null;
  qa: ActorAnimationQa;
  qaMotionTarget: MotionWithAnimationQa | null;
};

type MutableActorAnimationContext = {
  -readonly [Key in keyof ActorAnimationContext]: ActorAnimationContext[Key];
};

const LOOPING_CLIPS = new Set<ActorClipName>(["Idle", "Run", "Walk", "LookAround"]);
const EXIT_ANIMATION_RADIUS = 0.62;
const SEARCH_HEADING_EPSILON = 0.0005;
const ANIMATION_SESSIONS = new WeakMap<() => Point, { started: boolean }>();

export function captureClipTimeScale(durationSeconds: number) {
  const visibleSeconds = P0_TUNING.captureFreezeMs / 1000;
  return Math.max(0.001, durationSeconds) / Math.max(0.001, visibleSeconds);
}

const PLANS = Object.freeze({
  idle: Object.freeze({ base: "Idle", special: null, reason: "idle" }),
  reducedIdle: Object.freeze({ base: "Idle", special: null, reason: "reduced-idle" }),
  playerRun: Object.freeze({ base: "Run", special: null, reason: "player-run" }),
  villainWalk: Object.freeze({ base: "Walk", special: null, reason: "patrol-or-search-walk" }),
  chaseRun: Object.freeze({ base: "Run", special: null, reason: "chase-run" }),
  capture: Object.freeze({ base: "Idle", special: "ScaredCaught", reason: "capture" }),
  celebrate: Object.freeze({ base: "Idle", special: "Celebrate", reason: "victory-celebrate" }),
  point: Object.freeze({ base: "Idle", special: "PointAlert", reason: "victory-point" }),
  victoryGuard: Object.freeze({ base: "Idle", special: null, reason: "victory-guard-exit" }),
  search: Object.freeze({ base: "Idle", special: "LookAround", reason: "search-hold" }),
} satisfies Record<string, ActorAnimationPlan>);

const emptyClipRecord = <Value>(factory: (name: ActorClipName) => Value) => Object.fromEntries(
  ACTOR_CLIP_NAMES.map((name) => [name, factory(name)]),
) as Record<ActorClipName, Value>;

export function canonicalActorClipName(name: string): ActorClipName | null {
  const leaf = name.split(/[|/]/u).at(-1) ?? name;
  const normalized = leaf
    .replace(/^Anim_/iu, "")
    .replace(/\.\d+$/u, "")
    .replace(/[^a-z]/giu, "")
    .toLowerCase();
  return ACTOR_CLIP_NAMES.find((candidate) => (
    candidate.replace(/[^a-z]/giu, "").toLowerCase() === normalized
  )) ?? null;
}

export function indexActorClips(clips: readonly THREE.AnimationClip[]) {
  const indexed = {} as Partial<Record<ActorClipName, THREE.AnimationClip>>;
  for (const clip of clips) {
    const canonical = canonicalActorClipName(clip.name);
    if (canonical && !indexed[canonical]) indexed[canonical] = clip;
  }
  const missing = ACTOR_CLIP_NAMES.filter((name) => !indexed[name]);
  return { indexed, missing };
}

export function selectActorAnimationPlan(context: ActorAnimationContext): ActorAnimationPlan {
  const {
    role,
    moving,
    caught,
    won,
    reducedMotion,
    seesPlayer,
    searchHolding,
  } = context;
  if (caught && role === "kid") return PLANS.capture;
  if (won && !reducedMotion) {
    if (role === "kid") return PLANS.celebrate;
    if (role === "police") return PLANS.point;
    return PLANS.victoryGuard;
  }
  if (role === "villain" && searchHolding && !reducedMotion) return PLANS.search;
  if (!moving) return reducedMotion ? PLANS.reducedIdle : PLANS.idle;
  if (role === "villain" && !seesPlayer) return PLANS.villainWalk;
  return role === "villain" ? PLANS.chaseRun : PLANS.playerRun;
}

export function advanceAnimationBlend(current: number, target: number, delta: number) {
  const step = Math.max(0, delta) / P1_TUNING.gaitBlendSeconds;
  return current + THREE.MathUtils.clamp(target - current, -step, step);
}

const actorSkeletonCompatibility = (actor: THREE.Object3D) => {
  let sourceSkeleton: THREE.Skeleton | null = null;
  let shadowSkeleton: THREE.Skeleton | null = null;
  actor.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return;
    if (object.userData.actorShadowProxy) shadowSkeleton = object.skeleton;
    else sourceSkeleton ??= object.skeleton;
  });
  return {
    shadowProxyCreated: Boolean(shadowSkeleton),
    shadowSkeletonShared: Boolean(sourceSkeleton && shadowSkeleton && sourceSkeleton === shadowSkeleton),
  };
};

const snapshotAnimationQa = (qa: ActorAnimationQa): ActorAnimationQa => ({
  ...qa,
  availableClips: [...qa.availableClips],
  missingClips: [...qa.missingClips],
  activeClips: [...qa.activeClips],
  weights: { ...qa.weights },
  clipTimes: { ...qa.clipTimes },
  timeScales: { ...qa.timeScales },
});

const bindAnimationQaView = (
  runtime: ActorAnimationRuntime,
  motion: MotionWithAnimationQa,
) => {
  if (runtime.qaMotionTarget === motion) return;
  Object.defineProperty(motion, "animation", {
    configurable: true,
    enumerable: true,
    get: () => snapshotAnimationQa(runtime.qa),
  });
  runtime.qaMotionTarget = motion;
};

const bindAnimationCleanup = (actor: THREE.Object3D) => {
  const ring = actor.userData.ring as THREE.Mesh | undefined;
  const geometry = ring?.geometry;
  if (!(geometry instanceof THREE.BufferGeometry)) return false;
  const originalDispose = geometry.dispose;
  geometry.dispose = function disposeActorAnimationWithMarker() {
    geometry.dispose = originalDispose;
    disposeActorAnimations(actor);
    originalDispose.call(geometry);
  };
  return true;
};

export function attachActorAnimations(
  actor: THREE.Object3D,
  role: ActorName,
  sourceClips: readonly THREE.AnimationClip[],
  getPlayer: () => Point,
  options: { auditionClip?: ActorClipName | null } = {},
) {
  const { indexed, missing } = indexActorClips(sourceClips);
  if (missing.length) {
    throw new Error(`${role} animation library is missing clips: ${missing.join(", ")}`);
  }
  const clips = indexed as Record<ActorClipName, THREE.AnimationClip>;
  const scaredCaughtTimeScale = role === "kid" ? captureClipTimeScale(clips.ScaredCaught.duration) : 1;
  const mixer = new THREE.AnimationMixer(actor);
  const actions = emptyClipRecord((name) => {
    const action = mixer.clipAction(clips[name], actor);
    if (LOOPING_CLIPS.has(name)) action.setLoop(THREE.LoopRepeat, Infinity);
    else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    action.enabled = true;
    action.setEffectiveWeight(name === "Idle" ? 1 : 0);
    action.setEffectiveTimeScale(name === "ScaredCaught" ? scaredCaughtTimeScale : 1);
    action.play();
    return action;
  });
  const weights = emptyClipRecord((name) => name === "Idle" ? 1 : 0);
  const compatibility = actorSkeletonCompatibility(actor);
  const session = ANIMATION_SESSIONS.get(getPlayer) ?? { started: false };
  ANIMATION_SESSIONS.set(getPlayer, session);
  const query = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const queryRole = query?.get("qaActor");
  const queryClip = canonicalActorClipName(query?.get("qaClip") ?? "");
  const auditionClip = options.auditionClip ?? (queryRole === role ? queryClip : null);
  const qa: ActorAnimationQa = {
    source: "embedded-gltf",
    availableClips: [...ACTOR_CLIP_NAMES],
    missingClips: [],
    currentClip: "Idle",
    activeClips: ["Idle"],
    weights: { ...weights },
    clipTimes: emptyClipRecord(() => 0),
    timeScales: emptyClipRecord((name) => name === "ScaredCaught" ? scaredCaughtTimeScale : 1),
    transitionSeconds: P1_TUNING.gaitBlendSeconds,
    reason: "idle",
    reducedMotion: false,
    captureLatched: false,
    mixerUpdates: 0,
    batchMeshes: (actor.userData.actorBatch as { afterMeshes?: number } | undefined)?.afterMeshes ?? null,
    ...compatibility,
    cleanupBound: false,
    gameplayStarted: session.started,
    auditionClip,
  };
  const runtime: ActorAnimationRuntime = {
    role,
    mixer,
    actions,
    clips,
    weights,
    special: null,
    specialWeight: 0,
    locomotion: role === "villain" ? "Walk" : "Run",
    locomotionWeights: { Run: 0, Walk: 0 },
    searchHolding: false,
    captureLatched: false,
    scaredCaughtTimeScale,
    lastTargetHeading: actor.rotation.y,
    getPlayer,
    session,
    context: {
      role,
      moving: false,
      gaitWeight: 0,
      caught: false,
      won: false,
      reducedMotion: false,
      seesPlayer: false,
      searchHolding: false,
      turnDelta: 0,
    },
    auditionClip,
    qa,
    qaMotionTarget: null,
  };
  actor.userData.actorName = role;
  actor.userData.animationRuntime = runtime;
  const motion = actor.userData.motion as MotionWithAnimationQa | undefined;
  if (motion) bindAnimationQaView(runtime, motion);
  qa.cleanupBound = bindAnimationCleanup(actor);
  mixer.update(0);
  return runtime;
}

export function inferActorAnimationContext(
  actor: THREE.Object3D,
  point: Point,
  moving: boolean,
  gaitWeight: number,
  targetHeading: number,
  options: {
    dampHeading?: boolean;
    freezePose?: boolean;
    idleBreathScale?: number;
  },
  actorTurnDelta = shortestAngle(actor.rotation.y, targetHeading),
): ActorAnimationContext | null {
  const runtime = actor.userData.animationRuntime as ActorAnimationRuntime | undefined;
  if (!runtime) return null;
  const player = runtime.getPlayer();
  const reducedMotion = (options.idleBreathScale ?? 1) < 0.999;
  const won = runtime.session.started && distance(player, EXIT) < EXIT_ANIMATION_RADIUS;
  const targetHeadingDelta = shortestAngle(runtime.lastTargetHeading, targetHeading);
  const seesPlayer = runtime.role === "villain"
    && distance(point, player) < P0_TUNING.perceptionRadius
    && hasLineOfSight(point, player);
  if (runtime.role === "villain") {
    if (moving || seesPlayer || won || options.freezePose) runtime.searchHolding = false;
    else if (!options.dampHeading && Math.abs(targetHeadingDelta) >= SEARCH_HEADING_EPSILON) runtime.searchHolding = true;
  }
  runtime.lastTargetHeading = targetHeading;
  const context = runtime.context;
  context.role = runtime.role;
  context.moving = moving;
  context.gaitWeight = gaitWeight;
  context.caught = Boolean(options.freezePose);
  context.won = won;
  context.reducedMotion = reducedMotion;
  context.seesPlayer = seesPlayer;
  context.searchHolding = runtime.searchHolding;
  context.turnDelta = actorTurnDelta;
  return context;
}

const setActionWeights = (
  runtime: ActorAnimationRuntime,
  plan: ActorAnimationPlan,
  gaitWeight: number,
  delta: number,
) => {
  if (plan.base !== "Idle") runtime.locomotion = plan.base;
  const runTarget = runtime.locomotion === "Run" ? gaitWeight : 0;
  const walkTarget = runtime.locomotion === "Walk" ? gaitWeight : 0;
  runtime.locomotionWeights.Run = advanceAnimationBlend(runtime.locomotionWeights.Run, runTarget, delta);
  runtime.locomotionWeights.Walk = advanceAnimationBlend(runtime.locomotionWeights.Walk, walkTarget, delta);
  if (plan.special && plan.special !== runtime.special) {
    runtime.special = plan.special;
    runtime.specialWeight = 0;
    runtime.actions[plan.special].reset().play();
  }
  runtime.specialWeight = advanceAnimationBlend(runtime.specialWeight, plan.special ? 1 : 0, delta);
  const baseScale = 1 - runtime.specialWeight;
  for (const name of ACTOR_CLIP_NAMES) runtime.weights[name] = 0;
  const locomotionWeight = THREE.MathUtils.clamp(
    runtime.locomotionWeights.Run + runtime.locomotionWeights.Walk,
    0,
    1,
  );
  runtime.weights.Idle = (1 - locomotionWeight) * baseScale;
  runtime.weights.Run = runtime.locomotionWeights.Run * baseScale;
  runtime.weights.Walk = runtime.locomotionWeights.Walk * baseScale;
  if (runtime.special) runtime.weights[runtime.special] = runtime.specialWeight;
  for (const name of ACTOR_CLIP_NAMES) {
    runtime.actions[name].enabled = runtime.weights[name] > 0.0001;
    runtime.actions[name].setEffectiveWeight(runtime.weights[name]);
  }
  if (!plan.special && runtime.specialWeight <= 0) runtime.special = null;
};

export function updateActorAnimations(
  actor: THREE.Object3D,
  delta: number,
  gaitPhase: number,
  context: ActorAnimationContext,
) {
  const runtime = actor.userData.animationRuntime as ActorAnimationRuntime | undefined;
  if (!runtime) return null;
  if (runtime.role === "kid" && context.caught) runtime.captureLatched = true;
  const plan = runtime.role === "kid" && runtime.captureLatched
    ? PLANS.capture
    : selectActorAnimationPlan(context);
  if (runtime.auditionClip) {
    for (const name of ACTOR_CLIP_NAMES) {
      runtime.weights[name] = name === runtime.auditionClip ? 1 : 0;
      runtime.actions[name].enabled = runtime.weights[name] > 0;
      runtime.actions[name].setEffectiveWeight(runtime.weights[name]);
    }
  } else {
    setActionWeights(runtime, plan, THREE.MathUtils.clamp(context.gaitWeight, 0, 1), delta);
  }
  runtime.mixer.update(Math.max(0, delta));

  if (!runtime.auditionClip) {
    const normalizedPhase = THREE.MathUtils.euclideanModulo(gaitPhase, Math.PI * 2) / (Math.PI * 2);
    for (const name of ["Run", "Walk"] as const) {
      runtime.actions[name].time = normalizedPhase * runtime.clips[name].duration;
    }
    runtime.mixer.update(0);
  }

  const qa = runtime.qa;
  qa.currentClip = runtime.auditionClip ?? plan.special ?? plan.base;
  qa.activeClips.length = 0;
  for (const name of ACTOR_CLIP_NAMES) {
    if (runtime.weights[name] > 0.001) qa.activeClips.push(name);
  }
  qa.reason = runtime.auditionClip ? "qa-audition" : plan.reason;
  qa.reducedMotion = context.reducedMotion;
  qa.captureLatched = runtime.captureLatched;
  qa.gameplayStarted = runtime.session.started;
  qa.mixerUpdates += 1;
  for (const name of ACTOR_CLIP_NAMES) {
    qa.weights[name] = runtime.weights[name];
    qa.clipTimes[name] = runtime.actions[name].time;
    qa.timeScales[name] = runtime.actions[name].timeScale;
  }
  const motion = actor.userData.motion as MotionWithAnimationQa | undefined;
  if (motion) bindAnimationQaView(runtime, motion);
  return qa;
}

export function hasActorAnimations(actor: THREE.Object3D) {
  return Boolean(actor.userData.animationRuntime);
}

export function resetActorAnimations(actor: THREE.Object3D) {
  const runtime = actor.userData.animationRuntime as ActorAnimationRuntime | undefined;
  if (!runtime) return false;
  runtime.session.started = true;
  runtime.special = null;
  runtime.specialWeight = 0;
  runtime.locomotion = runtime.role === "villain" ? "Walk" : "Run";
  runtime.locomotionWeights.Run = 0;
  runtime.locomotionWeights.Walk = 0;
  runtime.searchHolding = false;
  runtime.captureLatched = false;
  runtime.lastTargetHeading = actor.rotation.y;
  runtime.mixer.stopAllAction();
  for (const name of ACTOR_CLIP_NAMES) {
    const action = runtime.actions[name];
    action.reset();
    action.enabled = name === "Idle";
    action.setEffectiveWeight(name === "Idle" ? 1 : 0);
    action.setEffectiveTimeScale(name === "ScaredCaught" ? runtime.scaredCaughtTimeScale : 1);
    action.play();
    runtime.weights[name] = name === "Idle" ? 1 : 0;
    runtime.qa.weights[name] = runtime.weights[name];
    runtime.qa.clipTimes[name] = 0;
  }
  runtime.qa.currentClip = "Idle";
  runtime.qa.activeClips.length = 1;
  runtime.qa.activeClips[0] = "Idle";
  runtime.qa.reason = "reset";
  runtime.qa.reducedMotion = false;
  runtime.qa.captureLatched = false;
  runtime.qa.gameplayStarted = true;
  runtime.mixer.update(0);
  return true;
}

export function disposeActorAnimations(actor: THREE.Object3D) {
  const runtime = actor.userData.animationRuntime as ActorAnimationRuntime | undefined;
  if (!runtime) return false;
  runtime.mixer.stopAllAction();
  for (const clip of Object.values(runtime.clips)) runtime.mixer.uncacheClip(clip);
  runtime.mixer.uncacheRoot(actor);
  delete actor.userData.animationRuntime;
  const motion = actor.userData.motion as MotionWithAnimationQa | undefined;
  if (motion) delete motion.animation;
  runtime.qaMotionTarget = null;
  return true;
}
