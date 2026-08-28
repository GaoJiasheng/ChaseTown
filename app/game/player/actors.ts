import * as THREE from "three";

import { CELL, EXIT, P0_TUNING, P1_TUNING } from "../config/index.js";
import type { ActorMotionRuntime, Point } from "../core/types.js";
import { dampAngle, shortestAngle } from "../camera/index.js";
import { distance, world } from "../level/maze.js";
import { tuneMeshes } from "../art/props.js";
import { batchCompatibleActorSkins, createActorShadowProxy } from "./actor-batching.js";
import {
  hasActorAnimations,
  inferActorAnimationContext,
  resetActorAnimations,
  updateActorAnimations,
} from "./actor-animation.js";

export {
  ACTOR_CLIP_NAMES,
  advanceAnimationBlend,
  attachActorAnimations,
  canonicalActorClipName,
  captureClipTimeScale,
  disposeActorAnimations,
  indexActorClips,
  inferActorAnimationContext,
  resetActorAnimations,
  selectActorAnimationPlan,
  updateActorAnimations,
} from "./actor-animation.js";

const RIG_AXIS = new THREE.Vector3(1, 0, 0);
const RIG_DELTA = new THREE.Quaternion();
const ACTOR_WORLD_TARGET = new THREE.Vector3();
type ActorRig = Record<string, { bone: THREE.Object3D; rest: THREE.Quaternion }>;

function applyRigRotation(rig: ActorRig, name: string, angle: number) {
  const joint = rig[name];
  if (!joint) return;
  joint.bone.quaternion.copy(joint.rest).multiply(RIG_DELTA.setFromAxisAngle(RIG_AXIS, angle));
}

export function advanceGaitWeight(current: number, moving: boolean, delta: number) {
  const target = moving ? 1 : 0;
  const step = Math.max(0, delta) / P1_TUNING.gaitBlendSeconds;
  return current + THREE.MathUtils.clamp(target - current, -step, step);
}

export function advanceGaitPhase(phase: number, actualGridSpeed: number, delta: number) {
  if (actualGridSpeed <= 0 || delta <= 0) return phase;
  return phase + actualGridSpeed * P1_TUNING.gaitRadiansPerGridUnit * delta;
}



export function shouldPoliceTrack(playerPoint: Point) {
  return distance(playerPoint, EXIT) < P1_TUNING.policeTrackingDistance;
}

export function victoryAwayHeading(villainPoint: Point, exitPoint: Point = EXIT) {
  return Math.atan2(villainPoint.x - exitPoint.x, villainPoint.y - exitPoint.y);
}


export function fitActor(source: THREE.Object3D, height: number, hideNodes: string[] = []) {
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
  const actorBatch = batchCompatibleActorSkins(source);
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
  const shadowProxy = createActorShadowProxy(actor);
  actor.userData.actorBatch = actorBatch.budget;
  actor.userData.shadowBudget = shadowProxy.budget;
  return actor;
}



export function makeLabel(text: string, color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.Sprite();
  const paint = (nextText: string, nextColor: string) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(5, 12, 9, .88)";
    context.fillRect(8, 12, 368, 104);
    context.strokeStyle = nextColor;
    context.lineWidth = 6;
    context.strokeRect(8, 12, 368, 104);
    context.fillStyle = nextColor;
    context.font = '800 48px Arial, "PingFang SC", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(nextText, 192, 66);
  };
  paint(text, color);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.3, 0.43, 1);
  sprite.renderOrder = 999;
  sprite.userData.labelText = text;
  sprite.userData.labelColor = color;
  sprite.userData.setLabel = (nextText: string, nextColor: string) => {
    if (sprite.userData.labelText === nextText && sprite.userData.labelColor === nextColor) return;
    paint(nextText, nextColor);
    sprite.userData.labelText = nextText;
    sprite.userData.labelColor = nextColor;
    texture.needsUpdate = true;
  };
  return sprite;
}

export function setActorLabel(actor: THREE.Object3D | undefined, text: string, color: string) {
  const badge = actor?.userData.badge as THREE.Sprite | undefined;
  const update = badge?.userData.setLabel as ((nextText: string, nextColor: string) => void) | undefined;
  update?.(text, color);
}

export function setActorMarkerOpacity(actor: THREE.Object3D | undefined, opacity: number) {
  if (!actor) return;
  const badge = actor.userData.badge as THREE.Sprite | undefined;
  const ring = actor.userData.ring as THREE.Mesh | undefined;
  const badgeMaterial = badge?.material as THREE.SpriteMaterial | undefined;
  const ringMaterial = ring?.material as THREE.MeshBasicMaterial | undefined;
  if (badgeMaterial) badgeMaterial.opacity = opacity;
  if (ringMaterial) ringMaterial.opacity = opacity * 0.95;
  actor.userData.markerOpacity = opacity;
}

export function decorateActor(actor: THREE.Object3D, height: number, color: number, label: string) {
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
  actor.userData.badge = badge;
  actor.userData.ring = ring;
  actor.userData.markerOpacity = 1;
  actor.userData.markerTargetOpacity = 1;
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

export function poseRig(actor: THREE.Object3D, gaitWave: number, gaitWeight: number) {
  if (hasActorAnimations(actor)) {
    if (gaitWave === 0 && gaitWeight === 0) resetActorAnimations(actor);
    return;
  }
  const rig = actor.userData.rig as ActorRig | undefined;
  if (!rig) return;
  const gait = gaitWave * gaitWeight;
  applyRigRotation(rig, "LeftUpperLeg", gait * 0.52);
  applyRigRotation(rig, "RightUpperLeg", -gait * 0.52);
  applyRigRotation(rig, "LeftLowerLeg", Math.max(0, -gait) * 0.38);
  applyRigRotation(rig, "RightLowerLeg", Math.max(0, gait) * 0.38);
  applyRigRotation(rig, "LeftUpperArm", -gait * 0.38);
  applyRigRotation(rig, "RightUpperArm", gait * 0.38);
  applyRigRotation(rig, "LeftLowerArm", (-0.12 - Math.max(0, gaitWave) * 0.16) * gaitWeight);
  applyRigRotation(rig, "RightLowerArm", (-0.12 - Math.max(0, -gaitWave) * 0.16) * gaitWeight);
}



export const syncActor = (
  actor: THREE.Object3D | undefined,
  point: Point,
  phaseOffset: number,
  delta: number,
  options: {
    authoredHeading?: number;
    dampHeading?: boolean;
    headingDamping?: number;
    freezePose?: boolean;
    idleBreathScale?: number;
  } = {},
) => {
  if (!actor) return;
  const target = world(point, ACTOR_WORLD_TARGET);
  const dx = target.x - actor.position.x;
  const dz = target.z - actor.position.z;
  const moving = dx * dx + dz * dz > 0.00001;
  actor.position.x = target.x;
  actor.position.z = target.z;
  actor.position.y = 0;
  const visual = actor.userData.visual as THREE.Group | undefined;
  const baseVisualY = visual?.userData.baseY as number | undefined;
  const motion = (actor.userData.motion as ActorMotionRuntime | undefined) ?? {
    gaitWeight: 0,
    gaitPhase: 0,
    actualSpeed: 0,
    heading: actor.rotation.y,
    targetHeading: actor.rotation.y,
    visualY: 0,
    baseVisualY: baseVisualY ?? 0,
  };
  actor.userData.motion = motion;
  const desiredHeading = options.authoredHeading ?? (moving ? Math.atan2(dx, dz) : motion.targetHeading);
  const animationTurnDelta = shortestAngle(motion.heading, desiredHeading);
  motion.targetHeading = desiredHeading;
  const finishingDampedTurn = options.dampHeading && Math.abs(shortestAngle(motion.heading, desiredHeading)) > 0.001;
  if (options.authoredHeading !== undefined || moving || finishingDampedTurn) {
    motion.heading = options.dampHeading
      ? dampAngle(motion.heading, desiredHeading, options.headingDamping ?? P1_TUNING.playerTurnDamping, delta)
      : desiredHeading;
    actor.rotation.y = motion.heading;
  }
  if (options.freezePose) {
    const animationContext = inferActorAnimationContext(
      actor,
      point,
      moving,
      motion.gaitWeight,
      desiredHeading,
      options,
      animationTurnDelta,
    );
    if (animationContext) updateActorAnimations(actor, delta, motion.gaitPhase + phaseOffset, animationContext);
    return;
  }
  const motionTime = performance.now();
  const actualGridSpeed = moving ? Math.hypot(dx, dz) / (CELL * Math.max(delta, 0.001)) : 0;
  motion.actualSpeed = actualGridSpeed;
  motion.gaitWeight = advanceGaitWeight(motion.gaitWeight, moving, delta);
  motion.gaitPhase = advanceGaitPhase(
    motion.gaitPhase,
    Math.min(actualGridSpeed, P0_TUNING.playerSpeed * 1.25),
    delta,
  );
  const gaitWave = Math.sin(motion.gaitPhase + phaseOffset);
  if (visual && hasActorAnimations(actor)) {
    const baseY = visual.userData.baseY as number;
    visual.position.y = baseY;
    visual.rotation.set(0, 0, 0);
    motion.baseVisualY = baseY;
    motion.visualY = 0;
  } else if (visual) {
    const baseY = visual.userData.baseY as number;
    const idleBreath = Math.sin(motionTime * 0.003 + phaseOffset)
      * 0.018
      * (options.idleBreathScale ?? 1)
      * (1 - motion.gaitWeight);
    visual.position.y = baseY + Math.abs(gaitWave) * 0.07 * motion.gaitWeight + idleBreath;
    visual.rotation.z = gaitWave * 0.035 * motion.gaitWeight;
    visual.rotation.x = -0.035 * motion.gaitWeight;
    motion.baseVisualY = baseY;
    motion.visualY = visual.position.y - baseY;
  }
  const animationContext = inferActorAnimationContext(
    actor,
    point,
    moving,
    motion.gaitWeight,
    desiredHeading,
    options,
    animationTurnDelta,
  );
  if (animationContext) updateActorAnimations(actor, delta, motion.gaitPhase + phaseOffset, animationContext);
  else poseRig(actor, gaitWave, motion.gaitWeight);
};
