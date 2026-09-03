import * as THREE from "three";

import { canChaserTakeLockerDoor } from "./presentation.ts";
import type { HideArchetypeKind, Point } from "./contracts.ts";

// Hero locker doors play slightly faster than authored so the interaction
// reads as brisk at the production camera distance.
export const LOCKER_PLAYBACK_RATE = 1.2;

export type LockerView = {
  id: string;
  archetype: HideArchetypeKind;
  root: THREE.Group;
  basePosition: THREE.Vector3;
  baseRotationY: number;
  baseScale: THREE.Vector3;
  alternateExit: Point | null;
  approach: Point;
  cameraAnchor: THREE.Object3D;
  peekAnchor: THREE.Object3D;
  beacon: THREE.Sprite;
  beaconLight: THREE.PointLight;
  mixer: THREE.AnimationMixer;
  clips: ReadonlyMap<string, THREE.AnimationClip>;
  queue: string[];
  action: THREE.AnimationAction | null;
  actionName: string | null;
  peeking: boolean;
  peekClosing: boolean;
  holdFinal: boolean;
  delayRemaining: number;
  playbackRate: number;
  owner: "idle" | "player" | "chaser";
};

export function startLockerAction(view: LockerView, name: string, timeScale = 1) {
  const clip = view.clips.get(name);
  if (!clip) throw new Error(`Hero locker ${view.id} is missing required clip ${name}`);
  const previous = view.action;
  const action = view.mixer.clipAction(clip, view.root);
  action.reset();
  action.enabled = true;
  action.clampWhenFinished = true;
  action.setLoop(THREE.LoopOnce, 1);
  action.timeScale = timeScale;
  action.play();
  // Evaluate the matching first pose before releasing the clamped preceding
  // action. stopAllAction() here would restore the bind pose for one rendered
  // frame, producing a closed-door flash between Open and Close clips.
  view.mixer.update(0);
  if (previous && previous !== action) previous.stop();
  view.action = action;
  view.actionName = name;
  return action;
}

export function playLockerSequence(
  view: LockerView,
  names: readonly string[],
  owner: LockerView["owner"] = "player",
  playbackRate = LOCKER_PLAYBACK_RATE,
) {
  view.queue = [...names];
  view.owner = owner;
  view.playbackRate = playbackRate;
  view.peeking = false;
  view.holdFinal = false;
  view.delayRemaining = 0;
  // When exit is requested during a peek, finish closing the partially-open
  // door before starting the authored exit performance. Starting Open_Exit at
  // time zero here would visibly snap the door back to its closed pose.
  if (view.peekClosing) return;
  view.peekClosing = false;
  const first = view.queue.shift();
  if (first) startLockerAction(view, first, view.playbackRate);
}

export function closeCheckedLocker(view: LockerView) {
  if (view.owner === "player" && (view.action || view.queue.length || view.peeking || view.peekClosing)) return;
  view.owner = "chaser";
  view.peeking = false;
  view.peekClosing = false;
  view.holdFinal = false;
  view.delayRemaining = 0;
  if (view.actionName === "Locker_Door_Check_Open" && view.action?.isRunning()) {
    // Finish the authored opening before closing. Jumping straight into the
    // fully-open first pose of Check_Close would pop a half-open door.
    view.action.paused = false;
    view.action.timeScale = 1;
    view.queue = ["Locker_Door_Check_Close"];
    return;
  }
  playLockerSequence(view, ["Locker_Door_Check_Close"], "chaser", 1);
}

export function holdLockerAction(view: LockerView, name: string, delaySeconds = 0) {
  if (!canChaserTakeLockerDoor({
    owner: view.owner,
    hasAction: Boolean(view.action),
    actionRunning: Boolean(view.action?.isRunning()),
    queuedActions: view.queue.length,
    peeking: view.peeking,
    peekClosing: view.peekClosing,
  })) return false;
  view.queue = delaySeconds > 0 ? [name] : [];
  view.owner = "chaser";
  view.playbackRate = 1;
  view.peeking = false;
  view.peekClosing = false;
  view.holdFinal = true;
  view.delayRemaining = Math.max(0, delaySeconds);
  if (delaySeconds > 0) {
    view.mixer.stopAllAction();
    view.action = null;
    view.actionName = null;
  } else startLockerAction(view, name, 1);
  return true;
}

export function setLockerPeek(view: LockerView, active: boolean) {
  if (active === view.peeking && !view.peekClosing) return;
  if (active && view.holdFinal && view.actionName === "Locker_Door_Check_Open" && view.action) {
    // A checker is already opening this exact door. Keep that authored motion
    // instead of snapping to the peek clip; the AI transition will reverse it
    // if the newly exposed player breaks the inspection.
    view.owner = "player";
    view.peeking = true;
    return;
  }
  view.owner = "player";
  view.playbackRate = LOCKER_PLAYBACK_RATE;
  view.peeking = active;
  view.queue = [];
  if (active) {
    view.delayRemaining = 0;
    view.holdFinal = false;
    if (view.actionName === "Locker_Door_Open_Enter" && view.action) {
      view.action.paused = false;
      view.action.timeScale = LOCKER_PLAYBACK_RATE;
      view.peekClosing = false;
      return;
    }
    view.peekClosing = false;
    startLockerAction(view, "Locker_Door_Open_Enter", LOCKER_PLAYBACK_RATE);
    return;
  }
  if (view.actionName === "Locker_Door_Open_Enter" && view.action) {
    view.action.paused = false;
    view.action.timeScale = -LOCKER_PLAYBACK_RATE;
    view.peekClosing = true;
  }
}

export function updateLocker(view: LockerView, delta: number) {
  if (view.delayRemaining > 0) {
    view.delayRemaining = Math.max(0, view.delayRemaining - delta);
    if (view.delayRemaining > 0) return;
    const delayed = view.queue.shift();
    if (delayed) startLockerAction(view, delayed, view.playbackRate);
  }
  view.mixer.update(delta);
  const action = view.action;
  if (!action) return;
  if (view.peeking && view.actionName === "Locker_Door_Open_Enter") {
    const stopAt = action.getClip().duration * 0.17;
    if (action.time >= stopAt) {
      action.time = stopAt;
      action.paused = true;
    }
    return;
  }
  if (view.peekClosing && action.time <= 0.01) {
    action.stop();
    view.action = null;
    view.actionName = null;
    view.peekClosing = false;
    const next = view.queue.shift();
    if (next) startLockerAction(view, next, view.playbackRate);
    else view.owner = "idle";
    return;
  }
  if (action.isRunning()) return;
  if (view.holdFinal) return;
  const next = view.queue.shift();
  if (next) startLockerAction(view, next, view.playbackRate);
  else {
    action.stop();
    view.action = null;
    view.actionName = null;
    view.owner = "idle";
  }
}
