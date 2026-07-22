import * as THREE from "three";

export type AnimationState =
  | "idle"
  | "walk"
  | "runStart"
  | "run"
  | "runStop"
  | "turnLeft"
  | "turnRight"
  | "alert"
  | "loseSight"
  | "search"
  | "enterHide"
  | "hideIdle"
  | "peekLeft"
  | "peekRight"
  | "exitHide"
  | "checkLocker"
  | "checkMiss"
  | "checkFind"
  | "caught"
  | "catch"
  | "point"
  | "protect"
  | "celebrate";

export type ClipAliases = Partial<Record<AnimationState, string | readonly string[]>>;

export type AnimationMarker = {
  name: string;
  normalizedTime: number;
};

export type MarkerManifest = Partial<Record<AnimationState, readonly AnimationMarker[]>>;

type PlayOptions = {
  fade?: number;
  loop?: boolean;
  clampWhenFinished?: boolean;
  timeScale?: number;
  restart?: boolean;
};

export type ActorAnimationSnapshot = {
  state: AnimationState | null;
  clip: string | null;
  clipDuration: number;
  timeScale: number;
  normalizedTime: number;
  playing: boolean;
};

const LOOP_STATES = new Set<AnimationState>([
  "idle",
  "walk",
  "run",
  "loseSight",
  "search",
  "hideIdle",
  "peekLeft",
  "peekRight",
]);

function resolveClip(
  clips: ReadonlyMap<string, THREE.AnimationClip>,
  alias: string | readonly string[] | undefined,
) {
  if (!alias) return undefined;
  const candidates = typeof alias === "string" ? [alias] : alias;
  for (const candidate of candidates) {
    const exact = clips.get(candidate);
    if (exact) return exact;
    const lower = candidate.toLowerCase();
    const insensitive = [...clips.values()].find((clip) => clip.name.toLowerCase() === lower);
    if (insensitive) return insensitive;
  }
  return undefined;
}

export class ActorAnimator {
  readonly mixer: THREE.AnimationMixer;
  readonly root: THREE.Object3D;

  private readonly clips: ReadonlyMap<string, THREE.AnimationClip>;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly aliases: ClipAliases;
  private readonly markers: MarkerManifest;
  private currentAction: THREE.AnimationAction | null = null;
  private currentClip: THREE.AnimationClip | null = null;
  private currentState: AnimationState | null = null;
  private previousTime = 0;
  private markerListener?: (state: AnimationState, marker: AnimationMarker) => void;

  constructor(
    root: THREE.Object3D,
    sourceClips: readonly THREE.AnimationClip[],
    aliases: ClipAliases,
    markers: MarkerManifest = {},
  ) {
    this.root = root;
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = new Map(sourceClips.map((clip) => [clip.name, clip]));
    this.aliases = aliases;
    this.markers = markers;
  }

  setMarkerListener(listener: ((state: AnimationState, marker: AnimationMarker) => void) | undefined) {
    this.markerListener = listener;
  }

  has(state: AnimationState) {
    return Boolean(resolveClip(this.clips, this.aliases[state]));
  }

  require(states: readonly AnimationState[]) {
    const missing = states.filter((state) => !this.has(state));
    if (missing.length) {
      const available = [...this.clips.keys()].sort().join(", ") || "none";
      throw new Error(`Missing production animation states: ${missing.join(", ")}. Available clips: ${available}`);
    }
  }

  play(state: AnimationState, options: PlayOptions = {}) {
    const clip = resolveClip(this.clips, this.aliases[state]);
    if (!clip) throw new Error(`Animation state ${state} has no approved clip`);
    const restart = options.restart ?? false;
    if (this.currentState === state && !restart) {
      if (this.currentAction) this.currentAction.timeScale = options.timeScale ?? this.currentAction.timeScale;
      return this.currentAction;
    }

    let action = this.actions.get(clip.uuid);
    if (!action) {
      action = this.mixer.clipAction(clip);
      this.actions.set(clip.uuid, action);
    }

    const loop = options.loop ?? LOOP_STATES.has(state);
    action.enabled = true;
    action.clampWhenFinished = options.clampWhenFinished ?? !loop;
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.timeScale = options.timeScale ?? 1;
    if (restart || action.time >= clip.duration) action.reset();

    const previous = this.currentAction;
    const fade = THREE.MathUtils.clamp(options.fade ?? 0.16, 0, 0.4);
    if (previous && previous !== action) {
      action.play();
      if (fade > 0) action.crossFadeFrom(previous, fade, true);
      else previous.stop();
    } else {
      action.play();
    }

    this.currentAction = action;
    this.currentClip = clip;
    this.currentState = state;
    this.previousTime = action.time;
    return action;
  }

  setLocomotionRate(worldSpeed: number, authoredSpeed: number) {
    if (!this.currentAction || !this.currentState || !["walk", "run"].includes(this.currentState)) return;
    this.currentAction.timeScale = THREE.MathUtils.clamp(worldSpeed / Math.max(authoredSpeed, 0.01), 0.72, 1.35);
  }

  update(delta: number) {
    const action = this.currentAction;
    const clip = this.currentClip;
    const state = this.currentState;
    if (!action || !clip || !state) {
      this.mixer.update(delta);
      return;
    }

    const before = action.time;
    this.mixer.update(delta);
    const after = action.time;
    const duration = Math.max(clip.duration, 0.001);
    const wrapped = after + 1e-5 < before && action.loop === THREE.LoopRepeat;
    const stateMarkers = this.markers[state] ?? [];

    for (const marker of stateMarkers) {
      const markerTime = THREE.MathUtils.clamp(marker.normalizedTime, 0, 1) * duration;
      const crossed = wrapped
        ? markerTime > before || markerTime <= after
        : markerTime > this.previousTime && markerTime <= after;
      if (crossed) this.markerListener?.(state, marker);
    }
    this.previousTime = after;
  }

  snapshot(): ActorAnimationSnapshot {
    const duration = Math.max(this.currentClip?.duration ?? 0, 0.001);
    return {
      state: this.currentState,
      clip: this.currentClip?.name ?? null,
      clipDuration: this.currentClip?.duration ?? 0,
      timeScale: this.currentAction?.timeScale ?? 0,
      normalizedTime: THREE.MathUtils.clamp((this.currentAction?.time ?? 0) / duration, 0, 1),
      playing: Boolean(this.currentAction?.isRunning()),
    };
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    this.actions.clear();
    this.currentAction = null;
    this.currentClip = null;
    this.currentState = null;
    this.markerListener = undefined;
  }
}
