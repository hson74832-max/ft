// Animation system: catalogue-driven procedural mocap proxy,
// 2D blend space, crossfade + layers, IK + ball-contact snap, root motion.
import * as THREE from "three";
import { ANIMATION_CATALOGUE, ClipMeta, CONFIG } from "./config";
import { Pose, emptyPose, blendPoses } from "./skeleton";
import { FieldMotionClip, getBoundFieldMotionClip, getFieldMotionCatalogue, getFieldMotionClip, registerFieldMotionClip, sampleFieldMotion } from "./motion";

export function getClip(id: string): ClipMeta {
  // A clip bound to this slot contributes its own timing (duration, contact frame,
  // interrupt window), so a produced 0.52 s pass does not play at 0.45 s.
  const bound = getBoundFieldMotionClip(id)?.meta;
  const c = bound ?? ANIMATION_CATALOGUE.find((c) => c.id === id) ?? getFieldMotionClip(id)?.meta;
  if (!c) throw new Error(`clip not found: ${id}`);
  return c;
}
export function clipExists(id: string) { return ANIMATION_CATALOGUE.some((c) => c.id === id) || !!getFieldMotionClip(id); }
export function getAnimationCatalogue(): ClipMeta[] { return [...ANIMATION_CATALOGUE, ...getFieldMotionCatalogue()]; }

/**
 * Imported clips bound to a locomotion slot replace the procedural cycle for that
 * speed band. Bands are blended by the same speed weights the procedural blend
 * space uses, so a generated walk/jog/sprint set blends in without a recompile.
 */
const LOCOMOTION_SLOTS = ["idle", "walk", "jog", "sprint", "jockey"] as const;
type LocomotionSlot = typeof LOCOMOTION_SLOTS[number];

export function hasBoundLocomotion(): boolean {
  return LOCOMOTION_SLOTS.some((slot) => getBoundFieldMotionClip(slot));
}

function locomotionWeights(speed: number, jockey: boolean): Record<LocomotionSlot, number> {
  const idle = THREE.MathUtils.clamp(1 - speed / 1.0, 0, 1);
  const walk = THREE.MathUtils.clamp(1 - Math.abs(speed - 1.4) / 1.6, 0, 1);
  const jog = THREE.MathUtils.clamp(1 - Math.abs(speed - 4.0) / 1.6, 0, 1);
  const sprint = THREE.MathUtils.clamp((speed - 5.0) / 2.2, 0, 1);
  return { idle, walk, jog, sprint, jockey: jockey ? 1 : 0 };
}

/**
 * Sample every bound locomotion cycle at the same phase and blend by speed.
 * Returns null when nothing is bound (the procedural blend space is untouched).
 */
function boundLocomotionPose(p: LocoParams): Pose | null {
  const bound = LOCOMOTION_SLOTS.map((slot) => ({ slot, clip: getBoundFieldMotionClip(slot) }))
    .filter((entry): entry is { slot: LocomotionSlot; clip: FieldMotionClip } => !!entry.clip);
  if (!bound.length) return null;
  const weights = locomotionWeights(p.speed, p.jockey);
  const cycle = ((p.phase / (Math.PI * 2)) % 1 + 1) % 1;
  const entries = bound.map((entry) => ({ ...entry, weight: weights[entry.slot] }));
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  const selected = total > 0.02 ? entries : [(() => {
    // Between bands (or stopped with only a cycle bound): use the nearest cycle.
    const nearest = [...entries].sort((a, b) => Math.abs(weights[a.slot] - 1) - Math.abs(weights[b.slot] - 1))[0];
    return { ...nearest, weight: 1 };
  })()];
  const normaliser = selected.reduce((sum, e) => sum + e.weight, 0) || 1;
  const out = emptyPose();
  for (const entry of selected) {
    const time = cycle * entry.clip.duration;
    const sampled = sampleFieldMotion(entry.clip, time).pose;
    const w = entry.weight / normaliser;
    for (const [bone, euler] of sampled) {
      const acc = out.get(bone) ?? new THREE.Euler();
      acc.set(acc.x + euler.x * w, acc.y + euler.y * w, acc.z + euler.z * w);
      out.set(bone, acc);
    }
  }
  return out;
}

export function registerMotionAnimation(clip: FieldMotionClip): void {
  const motion = getFieldMotionClip(clip.id);
  if (motion) throw new Error(`Animation '${clip.id}' is already registered`);
  registerFieldMotionClip(clip);
}

const D2R = Math.PI / 180;
function E(x = 0, y = 0, z = 0) { return new THREE.Euler(x * D2R, y * D2R, z * D2R); }

// ---- locomotion blend space (speed x direction) ----
export interface LocoParams { speed: number; dirAngle: number; phase: number; fatigue: number; jockey: boolean; }

export function locomotionPose(p: LocoParams): Pose {
  // Imported cycles (generated or tracked) take precedence band by band.
  const imported = boundLocomotionPose(p);
  if (imported) return imported;
  const pose = emptyPose();
  const s = p.speed;
  // select band blend
  const walkW = THREE.MathUtils.clamp(1 - Math.abs(s - 1.4) / 1.6, 0, 1);
  const jogW = THREE.MathUtils.clamp(1 - Math.abs(s - 4.0) / 1.6, 0, 1);
  const sprintW = THREE.MathUtils.clamp((s - 5.0) / 2.2, 0, 1);
  const amp = 8 + walkW * 22 + jogW * 32 + sprintW * 42; // leg swing deg
  const armAmp = 6 + walkW * 14 + jogW * 26 + sprintW * 38;
  const ph = p.phase;
  const lat = Math.sin(p.dirAngle) * Math.min(1, s / 3); // strafe blend
  const lean = THREE.MathUtils.clamp(s * 2.2, 0, 16) + sprintW * 8;

  if (s < 0.15) {
    // idle: breath + weight shift
    const b = Math.sin(ph * 0.7) * 1.5;
    pose.set("spine", E(b * 0.4, 0, Math.sin(ph * 0.35) * 1.2));
    pose.set("chest", E(-1 + b * 0.3, 0, 0));
    pose.set("upperArm.L", E(2, 0, 7 + b * 0.4));
    pose.set("upperArm.R", E(-2, 0, -7 - b * 0.4));
    pose.set("lowerArm.L", E(-8, 0, 0));
    pose.set("lowerArm.R", E(-8, 0, 0));
    pose.set("upperLeg.L", E(0, 0, 2));
    pose.set("upperLeg.R", E(0, 0, -2));
    return pose;
  }
  if (p.jockey) {
    const sh = Math.sin(ph * 2.2) * 10;
    pose.set("hips", E(0, 0, 0));
    pose.set("spine", E(8, 0, 0));
    pose.set("upperLeg.L", E(-12 + sh, 0, 8));
    pose.set("upperLeg.R", E(-12 - sh, 0, -8));
    pose.set("lowerLeg.L", E(22, 0, 0));
    pose.set("lowerLeg.R", E(22, 0, 0));
    pose.set("upperArm.L", E(-20, 0, 30));
    pose.set("upperArm.R", E(-20, 0, -30));
    return pose;
  }
  const swingL = Math.sin(ph) * amp;
  const swingR = Math.sin(ph + Math.PI) * amp;
  pose.set("upperLeg.L", E(swingL + lat * 6, 0, 2 + lat * 4));
  pose.set("upperLeg.R", E(swingR - lat * 6, 0, -2 + lat * 4));
  pose.set("lowerLeg.L", E(Math.max(0, -Math.sin(ph - 0.6) * (18 + sprintW * 40)), 0, 0));
  pose.set("lowerLeg.R", E(Math.max(0, -Math.sin(ph + Math.PI - 0.6) * (18 + sprintW * 40)), 0, 0));
  pose.set("foot.L", E(-swingL * 0.45 + 4, 0, 0));
  pose.set("foot.R", E(-swingR * 0.45 + 4, 0, 0));
  pose.set("upperArm.L", E(Math.sin(ph + Math.PI) * armAmp, 0, 6 + sprintW * 6));
  pose.set("upperArm.R", E(Math.sin(ph) * armAmp, 0, -6 - sprintW * 6));
  pose.set("lowerArm.L", E(-12 - sprintW * 50, 0, 0));
  pose.set("lowerArm.R", E(-12 - sprintW * 50, 0, 0));
  pose.set("spine", E(lean * 0.4, lat * 6, lat * 3));
  pose.set("chest", E(lean * 0.5, -lat * 4, 0));
  pose.set("head", E(-lean * 0.35, -p.dirAngle * 10, 0));
  // fatigue additive droop
  if (p.fatigue > 0.01) {
    const f = p.fatigue;
    const cur = pose.get("spine")!;
    pose.set("spine", E(cur.x / D2R + f * 9, cur.y / D2R, cur.z / D2R));
    pose.set("head", E(-4 - f * 8, 0, 0));
  }
  return pose;
}

// ---- one-shot action poses (windup -> contact -> recover) ----
function phase01(t: number, d: number) { return THREE.MathUtils.clamp(t / d, 0, 1); }

export function actionPose(id: string, t: number, dur: number): Pose {
  // A produced clip bound to this slot replaces the procedural action entirely.
  const bound = getBoundFieldMotionClip(id);
  if (bound) return sampleFieldMotion(bound, t).pose;
  const motion = getFieldMotionClip(id);
  if (motion) return sampleFieldMotion(motion, t).pose;
  const k = phase01(t, dur);
  const pose = emptyPose();
  const wind = (a: number, b: number) => THREE.MathUtils.smoothstep(k, a, b);
  const rec = (a: number, b: number) => 1 - THREE.MathUtils.smoothstep(k, a, b);
  switch (id) {
    case "pass_short": {
      const back = wind(0, 0.5) * rec(0.55, 1);
      pose.set("upperLeg.R", E(-28 * wind(0, 0.5) + 46 * wind(0.5, 0.62) * rec(0.62, 1), 0, -3));
      pose.set("lowerLeg.R", E(30 * wind(0, 0.5) - 24 * wind(0.5, 0.6), 0, 0));
      pose.set("spine", E(6 + back * 2, -8 * back, 0));
      pose.set("upperArm.L", E(-18 * back, 0, 18));
      pose.set("upperLeg.L", E(4, 0, 2));
      break;
    }
    case "pass_long": case "pass_through": case "corner_kick": {
      const b = wind(0, 0.5) * rec(0.6, 1);
      pose.set("upperLeg.R", E(-52 * wind(0, 0.5) + 70 * wind(0.5, 0.62) * rec(0.62, 1), 0, -4));
      pose.set("lowerLeg.R", E(55 * wind(0, 0.5) - 30 * wind(0.5, 0.6), 0, 0));
      pose.set("spine", E(10 * b, -14 * b, 6 * b));
      pose.set("chest", E(6 * b, 0, 0));
      pose.set("upperArm.L", E(-30 * b, 0, 26));
      pose.set("upperArm.R", E(20 * b, 0, -20));
      break;
    }
    case "shoot_normal": {
      const b = wind(0, 0.52) * rec(0.62, 1);
      pose.set("upperLeg.R", E(-68 * wind(0, 0.5) + 88 * wind(0.5, 0.6) * rec(0.6, 1), 0, -2));
      pose.set("lowerLeg.R", E(80 * wind(0, 0.5) - 20 * wind(0.5, 0.6), 0, 0));
      pose.set("spine", E(12 * b, -18 * b, 8 * b));
      pose.set("upperArm.L", E(-40 * b, 0, 34));
      pose.set("upperLeg.L", E(8, 0, 3));
      pose.set("foot.R", E(-14 * wind(0.5, 0.6), 0, 0));
      break;
    }
    case "shoot_finesse": {
      const b = wind(0, 0.55) * rec(0.65, 1);
      pose.set("upperLeg.R", E(-40 * wind(0, 0.5) + 60 * wind(0.5, 0.62) * rec(0.62, 1), 0, -14 * b));
      pose.set("lowerLeg.R", E(50 * wind(0, 0.5) - 18 * wind(0.5, 0.6), 0, 0));
      pose.set("spine", E(8 * b, -22 * b, 10 * b));
      pose.set("foot.R", E(0, 18 * b, 0));
      break;
    }
    case "shoot_volley": {
      const b = wind(0, 0.45) * rec(0.6, 1);
      pose.set("upperLeg.R", E(-70 * wind(0, 0.45) + 60 * wind(0.45, 0.58) * rec(0.58, 1), 0, 0));
      pose.set("spine", E(-10 * b, 0, 0));
      pose.set("chest", E(-8 * b, 0, 0));
      pose.set("upperArm.L", E(-50 * b, 0, 30));
      pose.set("upperArm.R", E(-50 * b, 0, -30));
      break;
    }
    case "header": {
      const b = wind(0, 0.45) * rec(0.6, 1);
      pose.set("spine", E(-16 * wind(0, 0.45) + 26 * wind(0.45, 0.6) * rec(0.6, 1), 0, 0));
      pose.set("neck", E(-10 * b, 0, 0));
      pose.set("upperArm.L", E(-60 * b, 0, 20));
      pose.set("upperArm.R", E(-60 * b, 0, -20));
      pose.set("upperLeg.L", E(-20 * b, 0, 3));
      pose.set("upperLeg.R", E(-20 * b, 0, -3));
      pose.set("lowerLeg.L", E(30 * b, 0, 0));
      pose.set("lowerLeg.R", E(30 * b, 0, 0));
      break;
    }
    case "tackle_stand": {
      const b = wind(0, 0.42) * rec(0.6, 1);
      pose.set("upperLeg.R", E(-55 * b, 0, -4));
      pose.set("lowerLeg.R", E(8 * b, 0, 0));
      pose.set("spine", E(16 * b, 10 * b, 0));
      pose.set("upperArm.L", E(-30 * b, 0, 24));
      pose.set("upperLeg.L", E(12 * b, 0, 2));
      break;
    }
    case "tackle_slide": {
      const b = wind(0, 0.45) * rec(0.7, 1);
      pose.set("upperLeg.R", E(-78 * b, 0, -6));
      pose.set("upperLeg.L", E(-30 * b, 0, 10 * b));
      pose.set("lowerLeg.R", E(6 * b, 0, 0));
      pose.set("lowerLeg.L", E(66 * b, 0, 0));
      pose.set("spine", E(-14 * b, 12 * b, -14 * b));
      pose.set("upperArm.L", E(-40 * b, 0, 40 * b));
      pose.set("upperArm.R", E(-20 * b, 0, -50 * b));
      break;
    }
    case "intercept": {
      const b = wind(0, 0.45) * rec(0.6, 1);
      pose.set("upperLeg.R", E(-44 * b, 0, -10 * b));
      pose.set("spine", E(10 * b, -10 * b, 0));
      pose.set("upperArm.L", E(-24 * b, 0, 20));
      break;
    }
    case "shield": {
      pose.set("upperArm.L", E(-30, 0, 52));
      pose.set("upperArm.R", E(-10, 0, -12));
      pose.set("spine", E(10, 18, 0));
      pose.set("upperLeg.L", E(-8, 0, 6));
      pose.set("upperLeg.R", E(6, 0, -6));
      break;
    }
    case "first_touch": {
      const b = wind(0, 0.4) * rec(0.6, 1);
      pose.set("upperLeg.R", E(-30 * b, 0, 4));
      pose.set("lowerLeg.R", E(34 * b, 0, 0));
      pose.set("foot.R", E(18 * b, 0, 0));
      pose.set("spine", E(8 * b, 0, 0));
      break;
    }
    case "dribble_touch": {
      const b = wind(0, 0.45) * rec(0.6, 1);
      pose.set("upperLeg.R", E(-24 * b, 0, 0));
      pose.set("lowerLeg.R", E(14 * b, 0, 0));
      break;
    }
    case "gk_dive_L": {
      const b = wind(0, 0.5) * rec(0.75, 1);
      pose.set("spine", E(0, 0, 62 * b));
      pose.set("upperArm.L", E(-120 * b, 0, 40 * b));
      pose.set("upperArm.R", E(-110 * b, 0, 20 * b));
      pose.set("upperLeg.L", E(-10 * b, 0, 24 * b));
      pose.set("upperLeg.R", E(6 * b, 0, 18 * b));
      break;
    }
    case "gk_dive_R": {
      const b = wind(0, 0.5) * rec(0.75, 1);
      pose.set("spine", E(0, 0, -62 * b));
      pose.set("upperArm.L", E(-110 * b, 0, -20 * b));
      pose.set("upperArm.R", E(-120 * b, 0, -40 * b));
      pose.set("upperLeg.L", E(6 * b, 0, -18 * b));
      pose.set("upperLeg.R", E(-10 * b, 0, -24 * b));
      break;
    }
    case "gk_catch": {
      const b = wind(0, 0.45) * rec(0.7, 1);
      pose.set("upperArm.L", E(-140 * b, 0, 12));
      pose.set("upperArm.R", E(-140 * b, 0, -12));
      pose.set("lowerArm.L", E(-18 * b, 0, 0));
      pose.set("lowerArm.R", E(-18 * b, 0, 0));
      pose.set("spine", E(-6 * b, 0, 0));
      break;
    }
    case "gk_parry": {
      const b = wind(0, 0.45) * rec(0.7, 1);
      pose.set("upperArm.R", E(-150 * b, 0, -34 * b));
      pose.set("spine", E(0, 0, -18 * b));
      break;
    }
    case "gk_punt": {
      const b = wind(0, 0.5) * rec(0.65, 1);
      pose.set("upperLeg.R", E(-60 * wind(0, 0.5) + 70 * wind(0.5, 0.6) * rec(0.6, 1), 0, 0));
      pose.set("upperArm.L", E(-30 * b, 0, 24));
      pose.set("spine", E(10 * b, -12 * b, 0));
      break;
    }
    case "gk_roll": {
      const b = wind(0, 0.52) * rec(0.65, 1);
      pose.set("spine", E(18 * b, -8 * b, 0));
      pose.set("upperArm.R", E(-72 * wind(0, 0.52) + 95 * wind(0.52, 0.64) * rec(0.64, 1), 0, -10));
      pose.set("lowerArm.R", E(-20 * b, 0, 0));
      pose.set("upperLeg.R", E(-24 * b, 0, -4));
      break;
    }
    case "throw_in": {
      const b = wind(0, 0.5) * rec(0.7, 1);
      pose.set("upperArm.L", E(-160 * b + 60 * wind(0.5, 0.62) * rec(0.62, 1), 0, 10));
      pose.set("upperArm.R", E(-160 * b + 60 * wind(0.5, 0.62) * rec(0.62, 1), 0, -10));
      pose.set("spine", E(-14 * wind(0, 0.5) + 18 * wind(0.5, 0.65) * rec(0.65, 1), 0, 0));
      break;
    }
    case "celebrate": {
      const j = Math.sin(k * Math.PI * 2) * 10;
      pose.set("upperArm.L", E(-150, 0, 24));
      pose.set("upperArm.R", E(-150, 0, -24));
      pose.set("spine", E(-8 + j * 0.3, 0, 0));
      pose.set("upperLeg.L", E(-14, 0, 4));
      pose.set("upperLeg.R", E(-14, 0, -4));
      break;
    }
    case "stumble": {
      const b = Math.sin(k * Math.PI) ;
      pose.set("spine", E(10 * b, 20 * b, 14 * b));
      pose.set("upperArm.L", E(-30 * b, 0, 50 * b));
      pose.set("upperArm.R", E(20 * b, 0, -30 * b));
      pose.set("upperLeg.L", E(-18 * b, 0, 6));
      break;
    }
    case "get_up": {
      const b = wind(0.1, 0.9);
      pose.set("spine", E(40 * (1 - b), 0, 0));
      pose.set("upperLeg.L", E(-70 * (1 - b), 0, 0));
      pose.set("upperLeg.R", E(-70 * (1 - b), 0, 0));
      pose.set("upperArm.L", E(-60 * (1 - b), 0, 20));
      pose.set("upperArm.R", E(-60 * (1 - b), 0, -20));
      break;
    }
    case "turn_left": case "turn_right": case "turn_180": {
      const b = Math.sin(k * Math.PI);
      pose.set("upperLeg.L", E(-16 * b, 0, 5));
      pose.set("upperLeg.R", E(-16 * (1 - b), 0, -5));
      pose.set("spine", E(6 * b, id === "turn_left" ? -20 * b : id === "turn_right" ? 20 * b : 30 * b, 0));
      break;
    }
    default: break;
  }
  return pose;
}

// Root-motion deltas (metres for this frame, in facing space)
export function rootMotionDelta(id: string, t01: number, dt: number, _facing = 0): { dx: number; dz: number; dYaw: number } {
  const curve = Math.sin(THREE.MathUtils.clamp(t01, 0, 1) * Math.PI);
  switch (id) {
    case "tackle_slide": return { dx: 4.0 * curve * dt, dz: 0, dYaw: 0 };
    case "tackle_stand": return { dx: 3.2 * curve * dt, dz: 0, dYaw: 0 };
    case "gk_dive_L": return { dx: 0.4 * curve * dt, dz: -3.0 * curve * dt, dYaw: 0 };
    case "gk_dive_R": return { dx: 0.4 * curve * dt, dz: 3.0 * curve * dt, dYaw: 0 };
    case "stumble": return { dx: -1.6 * curve * dt, dz: 0, dYaw: 0 };
    case "turn_left": return { dx: 0, dz: 0, dYaw: 2.0 * dt };
    case "turn_right": return { dx: 0, dz: 0, dYaw: -2.0 * dt };
    case "turn_180": return { dx: 0, dz: 0, dYaw: 3.8 * dt };
    default: return { dx: 0, dz: 0, dYaw: 0 };
  }
}

// ================= AnimationController =================
export interface AnimDebug { state: string; clip: string; nt: number; blend: number; speed: number; contactFired: boolean; weights: string; cooldowns: string; }

export class AnimationController {
  /** Clip most recently sampled by `update` (action id, or the locomotion band name). */
  lastClip = "idle";
  actionId: string | null = null;
  actionT = 0;
  actionDur = 0;
  contactFired = false;
  prevPose: Pose | null = null;
  blend = 1;
  locoPhase = 0;
  locoSpeed = 0;
  dirAngle = 0;
  fatigue = 0;
  shieldW = 0;
  jockey = false;
  headYaw = 0; headPitch = 0;
  leanAdd = 0;
  proceduralOffset = new THREE.Vector3(); // IK fix offset, decays
  proceduralT = 1;
  cooldowns = new Map<string, number>();
  state = "locomotion";
  lastContactEvent: string | null = null;

  requestAction(id: string): boolean {
    const meta = getClip(id);
    if ((this.cooldowns.get(id) ?? 0) > 0) return false;
    if (this.actionId) {
      const cur = getClip(this.actionId);
      const nt = this.actionT / this.actionDur;
      const inWindow = nt >= cur.interruptible[0] && nt <= cur.interruptible[1];
      if (!inWindow && meta.priority <= cur.priority) return false;
      // snapshot crossfade
      this.prevPose = this.currentPoseSnapshot();
    }
    this.actionId = id;
    this.actionT = 0;
    this.actionDur = meta.duration;
    this.contactFired = false;
    this.blend = 0;
    this.state = meta.category;
    return true;
  }

  currentPoseSnapshot(): Pose {
    if (this.actionId) return actionPose(this.actionId, this.actionT, this.actionDur);
    return locomotionPose({ speed: this.locoSpeed, dirAngle: this.dirAngle, phase: this.locoPhase, fatigue: this.fatigue, jockey: this.jockey });
  }

  // call at ball_contact frame: snap striking foot toward ball, return offset applied
  ballContactSnap(ballPos: THREE.Vector3, footPos: THREE.Vector3): THREE.Vector3 {
    const to = ballPos.clone().sub(footPos);
    to.y *= 0.4;
    to.clampLength(0, 0.35);
    this.proceduralOffset.copy(to);
    this.proceduralT = 0;
    return to;
  }

  update(dt: number, speed: number, dirAngle: number, opts: { sprinting?: boolean; shielding?: boolean; ballDirLocal?: number } = {}): { pose: Pose; rootDelta: { dx: number; dz: number; dYaw: number }; contact: string | null; nt: number; clip: string } {
    // cooldowns
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, Math.max(0, v - dt));
    // speed-matched playback: stride length grows with speed
    const stride = 0.7 + Math.min(1.4, speed * 0.16);
    const freq = speed < 0.15 ? 1.2 : (speed / Math.max(0.4, stride)) * 1.9;
    this.locoPhase += dt * freq * Math.PI;
    this.locoSpeed += (speed - this.locoSpeed) * Math.min(1, dt * 10);
    this.dirAngle += (dirAngle - this.dirAngle) * Math.min(1, dt * 8);
    this.fatigue = THREE.MathUtils.clamp(this.fatigue + dt * (speed > 6 ? 0.03 : -0.05), 0, 1);
    this.shieldW += (((opts.shielding) ? 1 : 0) - this.shieldW) * Math.min(1, dt * 6);
    if (opts.ballDirLocal !== undefined) {
      this.headYaw += (THREE.MathUtils.clamp(opts.ballDirLocal, -1.2, 1.2) - this.headYaw) * Math.min(1, dt * 5);
    }
    this.proceduralT = Math.min(1, this.proceduralT + dt * 6);
    this.proceduralOffset.multiplyScalar(Math.max(0, 1 - dt * 6));

    this.blend = Math.min(1, this.blend + dt / (this.actionId ? CONFIG.anim.actionCrossfade : CONFIG.anim.crossfade));

    let pose: Pose;
    let clip = "locomotion";
    let nt = (this.locoPhase % (Math.PI * 2)) / (Math.PI * 2);
    let contact: string | null = null;
    let rootDelta = { dx: 0, dz: 0, dYaw: 0 };

    if (this.actionId) {
      const meta = getClip(this.actionId);
      this.actionT += dt;
      nt = meta.loop ? (this.actionT % this.actionDur) / this.actionDur : THREE.MathUtils.clamp(this.actionT / this.actionDur, 0, 1);
      clip = this.actionId;
      pose = actionPose(this.actionId, this.actionT, this.actionDur);
      // root motion
      if (meta.rootMotion) {
        const motion = getBoundFieldMotionClip(this.actionId) ?? getFieldMotionClip(this.actionId);
        if (motion) {
          const current = sampleFieldMotion(motion, this.actionT).root;
          const previous = sampleFieldMotion(motion, Math.max(0, this.actionT - dt)).root;
          // FieldMotion is authored Y-up with +Z forward and +X to the subject's
          // right; the engine integrates root motion as forward/lateral in facing
          // space. Previously +X was fed in as "forward", so a generated or tracked
          // clip's travel went sideways and every root-motion clip looked static.
          rootDelta = { dx: current.z - previous.z, dz: -(current.x - previous.x), dYaw: 0 };
        } else rootDelta = rootMotionDelta(this.actionId, nt, dt, 0);
      }
      // contact event
      if (meta.contactFrame !== undefined && !this.contactFired && nt >= meta.contactFrame) {
        this.contactFired = true;
        contact = this.actionId;
        this.lastContactEvent = this.actionId;
        this.cooldowns.set(this.actionId, meta.category === "tackle" ? 1.4 : meta.category === "shoot" ? 0.8 : 0.5);
      }
      if (!meta.loop && this.actionT >= this.actionDur) {
        this.actionId = null;
        this.state = "locomotion";
        this.blend = 0;
        this.prevPose = pose;
        pose = locomotionPose({ speed: this.locoSpeed, dirAngle: this.dirAngle, phase: this.locoPhase, fatigue: this.fatigue, jockey: this.jockey });
      }
    } else {
      const spd = this.locoSpeed;
      let band = "idle";
      if (spd > 5.0) band = "sprint"; else if (spd > 2.6) band = "jog"; else if (spd > 0.25) band = "walk";
      clip = this.jockey ? "jockey" : band;
      pose = locomotionPose({ speed: spd, dirAngle: this.dirAngle, phase: this.locoPhase, fatigue: this.fatigue, jockey: this.jockey });
      this.state = "locomotion";
    }

    this.lastClip = clip;
    // crossfade from previous
    if (this.prevPose && this.blend < 1) pose = blendPoses(this.prevPose, pose, THREE.MathUtils.smoothstep(this.blend, 0, 1));
    else if (this.blend >= 1) this.prevPose = null;

    // ---- layering: additive lean + ball-watch head + shield upper body ----
    const add = emptyPose();
    const leanX = THREE.MathUtils.clamp(this.locoSpeed * 1.1, 0, 10) * 0.4;
    add.set("spine", E(leanX * 0.3, 0, 0));
    add.set("head", E(this.headPitch * 30, this.headYaw * 40, 0));
    // shield layer blends left arm out
    if (this.shieldW > 0.01) {
      const cur = pose.get("upperArm.L")!;
      pose.set("upperArm.L", E(cur.x / D2R + (-30) * this.shieldW * 0.4, cur.y / D2R, cur.z / D2R + 40 * this.shieldW));
    }
    // apply additive lean/head
    for (const bn of ["spine", "head"]) {
      const b = pose.get(bn)!; const a = add.get(bn)!;
      pose.set(bn, new THREE.Euler(b.x + a.x * 0.6, b.y + a.y * 0.8, b.z + a.z * 0.6));
    }

    return { pose, rootDelta, contact, nt, clip };
  }

  get busy(): boolean { return this.actionId !== null; }
  get uninterruptible(): boolean {
    if (!this.actionId) return false;
    const cur = getClip(this.actionId);
    const nt = this.actionT / this.actionDur;
    return !(nt >= cur.interruptible[0] && nt <= cur.interruptible[1]);
  }

  debug(speed: number): AnimDebug {
    const clip = this.actionId ?? (this.jockey ? "jockey" : this.locoSpeed > 5 ? "sprint" : this.locoSpeed > 2.6 ? "jog" : this.locoSpeed > 0.25 ? "walk" : "idle");
    const nt = this.actionId ? this.actionT / this.actionDur : (this.locoPhase % (Math.PI * 2)) / (Math.PI * 2);
    return {
      state: this.state, clip, nt, blend: this.blend, speed,
      contactFired: this.contactFired,
      weights: `loco:${this.actionId ? (1 - this.blend).toFixed(2) : "1.00"} act:${this.actionId ? this.blend.toFixed(2) : "0.00"} shield:${this.shieldW.toFixed(2)}`,
      cooldowns: [...this.cooldowns.entries()].filter(([, v]) => v > 0.02).map(([k, v]) => `${k}:${v.toFixed(1)}`).join(" ") || "—",
    };
  }
}
