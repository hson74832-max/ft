// Game-ready clip generator.
//
// Turns the shared field skeleton (src/rig.ts) into FieldMotion v2 documents for every
// animation slot the 5v5 prototype plays: locomotion cycles, kicks, headers, tackles,
// keeper actions, restarts and recoveries. Clips are authored as joint-angle curves and
// expanded with forward kinematics, so limb lengths can never drift and the result is
// directly importable by the game (`parseFieldMotionText` → slot binding → controller).
//
// Pure module: no React, no MediaPipe, no DOM. The studio downloads the pack and
// scripts/build-game-clips.ts writes the same bytes to the game's public folder.
import { BASE, BONE_TREE, JOINT_ORDER, ROOT_JOINT, type JointName, type Joints, type Vec3 } from './rig';

export type Angle = [number, number, number]; // degrees; extrinsic X, then Y, then Z
export type PoseAngles = Partial<Record<JointName, Angle>>;
type Quat = [number, number, number, number]; // x, y, z, w

const D2R = Math.PI / 180;

const qMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

function qFromEuler([x, y, z]: Angle): Quat {
  const [sx, cx] = [Math.sin(x * D2R / 2), Math.cos(x * D2R / 2)];
  const [sy, cy] = [Math.sin(y * D2R / 2), Math.cos(y * D2R / 2)];
  const [sz, cz] = [Math.sin(z * D2R / 2), Math.cos(z * D2R / 2)];
  const qx: Quat = [sx, 0, 0, cx];
  const qy: Quat = [0, sy, 0, cy];
  const qz: Quat = [0, 0, sz, cz];
  return qMul(qz, qMul(qy, qx));
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const ix = qw * v.x + qy * v.z - qz * v.y;
  const iy = qw * v.y + qz * v.x - qx * v.z;
  const iz = qw * v.z + qx * v.y - qy * v.x;
  const iw = -qx * v.x - qy * v.y - qz * v.z;
  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
  };
}

/**
 * Forward kinematics: joint angles → world joint positions (metres).
 * Every bone offset is rotated by its parent joint, exactly like the game rig, so the
 * distance between two joints is the bind-pose bone length for every frame.
 */
export function poseFromAngles(angles: PoseAngles, offset: Vec3 = { x: 0, y: 0, z: 0 }): Joints {
  const joints = {} as Joints;
  const world = new Map<JointName, Quat>();
  const visit = (joint: JointName, parent: JointName | null) => {
    const parentRotation: Quat = parent ? world.get(parent)! : [0, 0, 0, 1];
    const rotation = qMul(parentRotation, qFromEuler(angles[joint] ?? [0, 0, 0]));
    world.set(joint, rotation);
    const base = BASE[joint];
    const origin = parent ? joints[parent] : { x: base.x + offset.x, y: base.y + offset.y, z: base.z + offset.z };
    if (parent) {
      const translated = rotate(parentRotation, {
        x: base.x - BASE[parent].x,
        y: base.y - BASE[parent].y,
        z: base.z - BASE[parent].z,
      });
      joints[joint] = { x: origin.x + translated.x, y: origin.y + translated.y, z: origin.z + translated.z };
    } else joints[joint] = { ...origin };
    for (const child of BONE_TREE[joint]) visit(child, joint);
  };
  visit(ROOT_JOINT, null);
  return joints;
}

// ---------------------------------------------------------------- helpers
const D = Math.PI * 2;
/** Sine of a normalized clip time (0..1) with a phase offset in cycles. */
const sinCycle = (p: number, phase = 0) => Math.sin((p + phase) * D);
/** 0 → 1 → 0 across a normalized phase window, peaked at `at`. */
function bell(p: number, at: number, width: number): number {
  const d = Math.abs(p - at) / Math.max(1e-4, width);
  return d >= 1 ? 0 : Math.cos((d * Math.PI) / 2) ** 2;
}
const ease = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

function leg(angles: PoseAngles, side: 'L' | 'R', hip: number, knee: number, ankle: number, spread = 2) {
  const s = side === 'L' ? -1 : 1;
  angles[side === 'L' ? 'leftHip' : 'rightHip'] = [hip, 0, spread * s];
  angles[side === 'L' ? 'leftKnee' : 'rightKnee'] = [knee, 0, 0];
  angles[side === 'L' ? 'leftAnkle' : 'rightAnkle'] = [ankle, 0, 0];
}
function arm(angles: PoseAngles, side: 'L' | 'R', shoulderX: number, elbow: number, shoulderZ = 6) {
  const s = side === 'L' ? -1 : 1;
  angles[side === 'L' ? 'leftShoulder' : 'rightShoulder'] = [shoulderX, 0, shoulderZ * s];
  angles[side === 'L' ? 'leftElbow' : 'rightElbow'] = [elbow, 0, 0];
}

// ---------------------------------------------------------------- clip specs
export interface GameClipSpec {
  /** Built-in animation slot in game/config.ts ANIMATION_CATALOGUE. */
  slot: string;
  category: 'locomotion' | 'turn' | 'pass' | 'shoot' | 'header' | 'tackle' | 'gk' | 'restart' | 'celebrate' | 'recover' | 'control' | 'idle';
  loop: boolean;
  rootMotion: boolean;
  duration: number;
  /** Seconds at which the foot/head/hand reaches the ball. */
  contactFrame?: number;
  /** Normalized window in which a new action may replace this one. */
  interruptible: [number, number];
  priority: number;
  speedBand?: [number, number];
  description: string;
  /** t = seconds, p = normalized time (0..1). */
  pose: (p: number, t: number) => { angles: PoseAngles; offset?: Vec3 };
}

const IDLE: GameClipSpec = {
  slot: 'idle', category: 'idle', loop: true, rootMotion: false, duration: 2.4,
  interruptible: [0, 1], priority: 0, speedBand: [0, 0.3],
  description: 'Relaxed idle with breathing and a slow weight shift',
  pose: (p) => {
    const breathe = sinCycle(p) * 1.5;
    const sway = sinCycle(p, 0.25);
    return {
      angles: {
        pelvis: [1 + breathe * 0.2, sway * 1.5, 0],
        spine: [1.5 + breathe * 0.6, -sway * 1.2, sway * 0.8],
        chest: [-1 + breathe * 0.5, sway * 0.8, 0],
        head: [-2 + sway * 1, sway * 3, 0],
        leftShoulder: [4 + breathe, 0, -8], rightShoulder: [4 + breathe, 0, 8],
        leftElbow: [-12, 0, 0], rightElbow: [-12, 0, 0],
        leftHip: [0, 0, -3], rightHip: [0, 0, 3],
        leftKnee: [3, 0, 0], rightKnee: [3, 0, 0],
      },
      offset: { x: 0, y: 0.006 * breathe, z: sway * 0.01 },
    };
  },
};

/** Walk / jog / sprint share one cycle shape with different amplitudes. */
function cycle(slot: string, duration: number, band: [number, number], amp: {
  hip: number; knee: number; arm: number; lean: number; bob: number; spread: number; elbow: number;
}): GameClipSpec {
  return {
    slot, category: 'locomotion', loop: true, rootMotion: false, duration,
    interruptible: [0, 1], priority: 1, speedBand: band,
    description: `${slot} cycle matched to the ${band[0]}–${band[1]} m/s speed band`,
    pose: (p) => {
      const angles: PoseAngles = {};
      const swing = sinCycle(p);
      const lift = (phase: number) => Math.max(0, sinCycle(p, phase));
      angles.pelvis = [0, swing * 4, 0];
      angles.spine = [amp.lean, -swing * 3, 0];
      angles.chest = [amp.lean * 0.4, -swing * 2, 0];
      angles.head = [-amp.lean * 0.8, swing * 2, 0];
      leg(angles, 'L', -swing * amp.hip, lift(0.25) * amp.knee + 4, lift(0.25) * 8 - 4, amp.spread);
      leg(angles, 'R', swing * amp.hip, lift(0.75) * amp.knee + 4, lift(0.75) * 8 - 4, amp.spread);
      arm(angles, 'L', swing * amp.arm, -amp.elbow - lift(0.75) * 18, 7);
      arm(angles, 'R', -swing * amp.arm, -amp.elbow - lift(0.25) * 18, 7);
      const bob = Math.abs(Math.cos(p * D)) * amp.bob;
      return { angles, offset: { x: 0, y: bob, z: 0 } };
    },
  };
}

/** Turn in place: yaw sweeps the whole skeleton, legs step around. */
function turn(slot: string, duration: number, yaw: number): GameClipSpec {
  return {
    slot, category: 'turn', loop: false, rootMotion: true, duration,
    interruptible: [0, 1], priority: 4,
    description: `Turn ${yaw}° in place`,
    pose: (p) => {
      const angles: PoseAngles = {};
      const step = bell(p, 0.5, 0.5);
      const direction = Math.sign(yaw);
      angles.pelvis = [0, yaw * ease(p * 1.15), 0];
      angles.spine = [4 * step, -yaw * 0.12 * step, 0];
      angles.chest = [2 * step, -yaw * 0.08 * step, 0];
      angles.head = [-2, yaw * 0.2 * step, 0];
      leg(angles, direction > 0 ? 'L' : 'R', -26 * step, 34 * step, 6 * step, 5);
      leg(angles, direction > 0 ? 'R' : 'L', 14 * step, 18 * step, -4 * step, 5);
      arm(angles, 'L', 16 * step, -24 - 10 * step, 12);
      arm(angles, 'R', -16 * step, -24 - 10 * step, 12);
      return { angles, offset: { x: 0, y: -0.02 * step, z: 0 } };
    },
  };
}

/** Kick family: plant, backswing, strike at `contactFrame`, follow through. */
function kick(spec: {
  slot: string; category: GameClipSpec['category']; duration: number; contactFrame: number;
  priority: number; description: string; swing: number; knee: number; lean: number;
  yaw: number; follow: number; plantBend: number; supporting: 'L' | 'R';
}): GameClipSpec {
  return {
    slot: spec.slot, category: spec.category, loop: false, rootMotion: false,
    duration: spec.duration, contactFrame: spec.contactFrame,
    interruptible: [0, Math.min(0.4, spec.contactFrame - 0.08)], priority: spec.priority,
    description: spec.description,
    pose: (p) => {
      const c = spec.contactFrame;
      const wind = ease(p / Math.max(0.01, c));                       // 0 → 1 at contact
      const after = ease((p - c) / Math.max(0.01, 1 - c));            // follow through
      const strike = bell(p, c, 0.22);
      const angles: PoseAngles = {};
      const plant = spec.supporting;
      const hit = plant === 'L' ? 'R' : 'L';
      const swingHip = -spec.swing * wind + spec.swing * 0.35 * after;
      angles.pelvis = [0, -spec.yaw * wind * 0.5, 0];
      angles.spine = [spec.lean * wind, spec.yaw * 0.5 * wind, 0];
      angles.chest = [spec.lean * 0.4 * wind, spec.yaw * 0.8 * wind, 0];
      angles.head = [-spec.lean * 0.5, -spec.yaw * 0.4 * wind, 0];
      leg(angles, hit, swingHip - 22 * after, 18 + spec.knee * (1 - wind) + spec.follow * 0.4 * after, -8 * wind + 14 * strike, 4);
      leg(angles, plant, -4 + 6 * wind, 6 + spec.plantBend, 2, 5);
      arm(angles, hit, 22 * wind, -30 - 12 * strike, 14);
      arm(angles, plant, -26 * wind, -30 - 12 * strike, 16);
      return { angles, offset: { x: 0, y: -0.01 * strike, z: 0 } };
    },
  };
}

export const GAME_CLIP_SPECS: GameClipSpec[] = [
  // ---- locomotion -------------------------------------------------------------
  IDLE,
  cycle('walk', 1.1, [0.3, 2.8], { hip: 24, knee: 30, arm: 16, lean: 3, bob: 0.02, spread: 2, elbow: 14 }),
  cycle('jog', 0.82, [2.8, 5.2], { hip: 34, knee: 52, arm: 30, lean: 6, bob: 0.035, spread: 2, elbow: 32 }),
  cycle('sprint', 0.62, [5.2, 8.0], { hip: 46, knee: 82, arm: 46, lean: 14, bob: 0.05, spread: 1.5, elbow: 62 }),
  {
    slot: 'jockey', category: 'locomotion', loop: true, rootMotion: false, duration: 0.9,
    interruptible: [0, 1], priority: 2, speedBand: [0, 2.2],
    description: 'Side-on defensive shuffle, knees bent and arms out',
    pose: (p) => {
      const sway = sinCycle(p);
      const angles: PoseAngles = {
        pelvis: [0, 22, 0], spine: [10, -8, 0], chest: [4, 0, 0], head: [-4, 16, 0],
        leftHip: [-14, 0, -9], rightHip: [-14, 0, 9],
        leftKnee: [26 + sway * 6, 0, 0], rightKnee: [26 - sway * 6, 0, 0],
        leftAnkle: [4, 0, 0], rightAnkle: [4, 0, 0],
        leftShoulder: [-18, 0, -30], rightShoulder: [-14, 0, 28],
        leftElbow: [-38, 0, 0], rightElbow: [-34, 0, 0],
      };
      return { angles, offset: { x: 0, y: -0.05 + 0.01 * Math.abs(sway), z: 0 } };
    },
  },
  {
    slot: 'shield', category: 'control', loop: true, rootMotion: false, duration: 1.2,
    interruptible: [0, 1], priority: 3,
    description: 'Hold the ball up with an arm across the defender',
    pose: (p) => {
      const breathe = sinCycle(p) * 2;
      return {
        angles: {
          pelvis: [0, -18, 0], spine: [8, 12, 0], chest: [2, 8, 0], head: [-4, -22, 0],
          leftShoulder: [-64 + breathe, 0, -26], leftElbow: [-46, 0, 0],
          rightShoulder: [-8, 0, 16], rightElbow: [-24, 0, 0],
          leftHip: [-10, 0, -6], rightHip: [6, 0, 6], leftKnee: [16, 0, 0], rightKnee: [10, 0, 0],
        },
        offset: { x: 0, y: 0.004 * breathe, z: 0 },
      };
    },
  },
  // ---- turns ------------------------------------------------------------------
  turn('turn_left', 0.42, 90),
  turn('turn_right', 0.42, -90),
  turn('turn_180', 0.55, 180),
  // ---- passing ----------------------------------------------------------------
  kick({ slot: 'pass_short', category: 'pass', duration: 0.45, contactFrame: 0.52, priority: 6,
    description: 'Inside-foot pass: plant, backswing, strike at contact', swing: 28, knee: 34, lean: 6, yaw: 10, follow: 26, plantBend: 12, supporting: 'L' }),
  kick({ slot: 'pass_long', category: 'pass', duration: 0.62, contactFrame: 0.55, priority: 6,
    description: 'Driven long pass with a full backswing and follow through', swing: 38, knee: 40, lean: 12, yaw: 16, follow: 34, plantBend: 16, supporting: 'L' }),
  kick({ slot: 'pass_through', category: 'pass', duration: 0.58, contactFrame: 0.5, priority: 6,
    description: 'Low driven pass into the channel behind the line', swing: 32, knee: 36, lean: 10, yaw: 12, follow: 28, plantBend: 14, supporting: 'L' }),
  // ---- shooting ---------------------------------------------------------------
  kick({ slot: 'shoot_normal', category: 'shoot', duration: 0.7, contactFrame: 0.55, priority: 7,
    description: 'Laces drive: long backswing, hips open at contact', swing: 42, knee: 44, lean: 14, yaw: 20, follow: 38, plantBend: 18, supporting: 'L' }),
  kick({ slot: 'shoot_finesse', category: 'shoot', duration: 0.74, contactFrame: 0.58, priority: 7,
    description: 'Side-foot curled finish, slower swing, more hip rotation', swing: 28, knee: 30, lean: 8, yaw: 26, follow: 26, plantBend: 12, supporting: 'L' }),
  kick({ slot: 'shoot_volley', category: 'shoot', duration: 0.66, contactFrame: 0.5, priority: 7,
    description: 'Side-on volley: leg swings through a raised ball', swing: 62, knee: 22, lean: -6, yaw: 22, follow: 40, plantBend: 10, supporting: 'L' }),
  // ---- header -----------------------------------------------------------------
  {
    slot: 'header', category: 'header', loop: false, rootMotion: false, duration: 0.52, contactFrame: 0.48,
    interruptible: [0, 0.3], priority: 6,
    description: 'Jump and head: crouch, extend, snap through the ball',
    pose: (p) => {
      const crouch = bell(p, 0.2, 0.35);
      const air = bell(p, 0.5, 0.55);
      const snap = bell(p, 0.6, 0.28);
      const angles: PoseAngles = {
        pelvis: [0, 0, 0],
        spine: [-6 + 16 * snap - 10 * crouch, 0, 0],
        chest: [-4 + 10 * snap, 0, 0],
        neck: [-8 - 10 * snap, 0, 0],
        head: [-6 - 14 * snap, 0, 0],
      };
      leg(angles, 'L', -24 * crouch - 10 * air, 44 * crouch + 22 * air, 10 * crouch, 5);
      leg(angles, 'R', -24 * crouch - 14 * air, 44 * crouch + 30 * air, 10 * crouch, 5);
      arm(angles, 'L', -70 * crouch - 40 * air, -30 - 20 * air, 26);
      arm(angles, 'R', -70 * crouch - 40 * air, -30 - 20 * air, 26);
      return { angles, offset: { x: 0, y: 0.32 * air - 0.12 * crouch, z: 0 } };
    },
  },
  // ---- duels ------------------------------------------------------------------
  {
    slot: 'tackle_stand', category: 'tackle', loop: false, rootMotion: true, duration: 0.6, contactFrame: 0.45,
    interruptible: [0, 0.25], priority: 8,
    description: 'Standing lunge with a 1.8 m root drive',
    pose: (p) => {
      const lunge = ease(p / 0.55);
      const reach = bell(p, 0.55, 0.4);
      const angles: PoseAngles = {
        pelvis: [0, 16 * lunge, 0], spine: [16 * lunge, -10 * lunge, 0], chest: [6 * lunge, 0, 0], head: [-10 * lunge, 0, 0],
      };
      leg(angles, 'R', -14 * lunge - 26 * reach, 40 * lunge + 14 * reach, 6, 6);
      leg(angles, 'L', 26 * lunge, 30 * lunge, -6, 4);
      arm(angles, 'L', -34 * lunge, -30, 26);
      arm(angles, 'R', -20 * lunge, -26, 18);
      return { angles, offset: { x: 0, y: -0.07 * lunge, z: 1.8 * lunge } };
    },
  },
  {
    slot: 'tackle_slide', category: 'tackle', loop: false, rootMotion: true, duration: 0.95, contactFrame: 0.5,
    interruptible: [0, 0.2], priority: 8,
    description: 'Slide tackle: drops low, 2.5 m root travel',
    pose: (p) => {
      const drop = ease(p / 0.25);
      const slide = ease(p / 0.8);
      const angles: PoseAngles = {
        pelvis: [0, -26 * drop, -10 * drop],
        spine: [12 * drop, 18 * drop, 6 * drop],
        chest: [6 * drop, 0, 0],
        head: [-14 * drop, -18 * drop, 0],
      };
      leg(angles, 'R', -64 * drop, 42 * drop, -8, 8);
      leg(angles, 'L', -74 * drop, 38 * drop, 0, 6);
      arm(angles, 'L', -50 * drop, -40, 30);
      arm(angles, 'R', 24 * drop, -30, 22);
      return { angles, offset: { x: 0, y: -0.44 * drop, z: 2.5 * slide } };
    },
  },
  {
    slot: 'intercept', category: 'control', loop: false, rootMotion: false, duration: 0.4, contactFrame: 0.5,
    interruptible: [0, 0.4], priority: 5,
    description: 'Step across to block or intercept a pass',
    pose: (p) => {
      const reach = bell(p, 0.5, 0.5);
      const angles: PoseAngles = { pelvis: [0, 12 * reach, 0], spine: [8 * reach, -6 * reach, 0], head: [-4, 8 * reach, 0] };
      leg(angles, 'R', -18 * reach, 20 * reach, 0, 16);
      leg(angles, 'L', 8 * reach, 14 * reach, 0, 4);
      arm(angles, 'L', -26 * reach, -30, 20);
      arm(angles, 'R', -14 * reach, -24, 26);
      return { angles, offset: { x: 0, y: -0.06 * reach, z: 0 } };
    },
  },
  {
    slot: 'first_touch', category: 'control', loop: false, rootMotion: false, duration: 0.5, contactFrame: 0.45,
    interruptible: [0, 0.5], priority: 5,
    description: 'Cushioned first touch into space',
    pose: (p) => {
      const cushion = bell(p, 0.5, 0.55);
      const angles: PoseAngles = { pelvis: [0, -10 * cushion, 0], spine: [6 * cushion, 8 * cushion, 0], head: [-6, -6 * cushion, 0] };
      leg(angles, 'R', -22 * cushion, 26 * cushion, 8 * cushion, 10);
      leg(angles, 'L', -4, 8, 0, 5);
      arm(angles, 'L', 10 * cushion, -26, 18);
      arm(angles, 'R', -10 * cushion, -22, 14);
      return { angles, offset: { x: 0, y: -0.03 * cushion, z: 0 } };
    },
  },
  {
    slot: 'dribble_touch', category: 'control', loop: false, rootMotion: false, duration: 0.32, contactFrame: 0.5,
    interruptible: [0, 0.6], priority: 4,
    description: 'Short push touch while running with the ball',
    pose: (p) => {
      const poke = bell(p, 0.5, 0.5);
      const angles: PoseAngles = { pelvis: [0, 4 * poke, 0], spine: [8, -4 * poke, 0], head: [-6, 0, 0] };
      leg(angles, 'R', -26 * poke, 30 * poke, 6, 4);
      leg(angles, 'L', 12 * poke, 16 * poke, 0, 4);
      arm(angles, 'L', -12, -30, 14);
      arm(angles, 'R', -8, -26, 12);
      return { angles };
    },
  },
  // ---- goalkeeper -------------------------------------------------------------
  {
    slot: 'gk_dive_L', category: 'gk', loop: false, rootMotion: true, duration: 0.8, contactFrame: 0.55,
    interruptible: [0, 0.15], priority: 9,
    description: 'Dive to the keeper’s left, 1.15 m lateral root travel',
    pose: (p) => {
      const dive = ease(p / 0.55);
      const angles: PoseAngles = {
        pelvis: [0, 0, -34 * dive],
        spine: [10 * dive, 0, 22 * dive],
        chest: [0, 0, 14 * dive],
        head: [-8 * dive, 0, 8 * dive],
      };
      leg(angles, 'L', -18 * dive, 30 * dive, 0, 12);
      leg(angles, 'R', 26 * dive, 54 * dive, 0, 8);
      arm(angles, 'L', -96 * dive, -8, 62);
      arm(angles, 'R', -78 * dive, -16, 34);
      return { angles, offset: { x: -1.15 * dive, y: 0.05 * dive, z: 0 } };
    },
  },
  {
    slot: 'gk_dive_R', category: 'gk', loop: false, rootMotion: true, duration: 0.8, contactFrame: 0.55,
    interruptible: [0, 0.15], priority: 9,
    description: 'Dive to the keeper’s right, 1.15 m lateral root travel',
    pose: (p) => {
      const dive = ease(p / 0.55);
      const angles: PoseAngles = {
        pelvis: [0, 0, 34 * dive],
        spine: [10 * dive, 0, -22 * dive],
        chest: [0, 0, -14 * dive],
        head: [-8 * dive, 0, -8 * dive],
      };
      leg(angles, 'R', -18 * dive, 30 * dive, 0, 12);
      leg(angles, 'L', 26 * dive, 54 * dive, 0, 8);
      arm(angles, 'R', -96 * dive, -8, 62);
      arm(angles, 'L', -78 * dive, -16, 34);
      return { angles, offset: { x: 1.15 * dive, y: 0.05 * dive, z: 0 } };
    },
  },
  {
    slot: 'gk_catch', category: 'gk', loop: false, rootMotion: false, duration: 0.5, contactFrame: 0.5,
    interruptible: [0, 0.3], priority: 9,
    description: 'Two-handed catch at chest height',
    pose: (p) => {
      const reach = bell(p, 0.5, 0.55);
      const angles: PoseAngles = { pelvis: [0, 0, 0], spine: [-6 * reach, 0, 0], chest: [-4 * reach, 0, 0], head: [-8 * reach, 0, 0] };
      leg(angles, 'L', -10 * reach, 24 * reach, 0, 8);
      leg(angles, 'R', -10 * reach, 24 * reach, 0, 8);
      arm(angles, 'L', -96 * reach, -46 * reach, 18);
      arm(angles, 'R', -96 * reach, -46 * reach, 18);
      return { angles, offset: { x: 0, y: 0.04 * reach, z: 0 } };
    },
  },
  {
    slot: 'gk_parry', category: 'gk', loop: false, rootMotion: false, duration: 0.48, contactFrame: 0.5,
    interruptible: [0, 0.3], priority: 9,
    description: 'One-handed parry across the body',
    pose: (p) => {
      const reach = bell(p, 0.5, 0.5);
      const angles: PoseAngles = { pelvis: [0, 0, -8 * reach], spine: [4 * reach, 0, 14 * reach], chest: [0, 0, 10 * reach], head: [-6 * reach, 0, 6 * reach] };
      leg(angles, 'L', -14 * reach, 32 * reach, 0, 10);
      leg(angles, 'R', -6 * reach, 20 * reach, 0, 6);
      arm(angles, 'R', -104 * reach, -24, 44);
      arm(angles, 'L', -30 * reach, -34, 22);
      return { angles, offset: { x: 0.06 * reach, y: 0.03 * reach, z: 0 } };
    },
  },
  {
    slot: 'gk_punt', category: 'gk', loop: false, rootMotion: false, duration: 0.85, contactFrame: 0.55,
    interruptible: [0, 0.25], priority: 7,
    description: 'Drop and punt from the hands',
    pose: (p) => {
      const c = 0.55;
      const drop = ease(p / c);
      const strike = bell(p, c, 0.25);
      const angles: PoseAngles = { pelvis: [0, 12 * drop, 0], spine: [4 + 10 * drop, -8 * drop, 0], chest: [4 * drop, 0, 0], head: [-4, -6 * drop, 0] };
      leg(angles, 'R', -18 - 26 * strike, 24 + 20 * drop, 6, 4);
      leg(angles, 'L', -6, 12, 0, 5);
      arm(angles, 'L', -70 * (1 - drop) - 10, -34, 22);
      arm(angles, 'R', -64 * (1 - drop) - 8, -32, 20);
      return { angles, offset: { x: 0, y: -0.04 * strike, z: 0 } };
    },
  },
  {
    slot: 'gk_roll', category: 'gk', loop: false, rootMotion: false, duration: 0.62, contactFrame: 0.56,
    interruptible: [0, 0.32], priority: 7,
    description: 'Underarm roll to a full-back',
    pose: (p) => {
      const roll = bell(p, 0.6, 0.6);
      const angles: PoseAngles = { pelvis: [0, -14 * roll, 0], spine: [14 * roll, 10 * roll, 0], chest: [6 * roll, 0, 0], head: [-8, -8 * roll, 0] };
      leg(angles, 'R', 16 * roll, 24 * roll, 0, 6);
      leg(angles, 'L', -8 * roll, 18 * roll, 0, 6);
      arm(angles, 'R', -30 - 50 * roll, -20 + 40 * roll, 16);
      arm(angles, 'L', -18 * roll, -30, 14);
      return { angles, offset: { x: 0, y: -0.05 * roll, z: 0 } };
    },
  },
  // ---- restarts ---------------------------------------------------------------
  {
    slot: 'throw_in', category: 'restart', loop: false, rootMotion: false, duration: 0.9, contactFrame: 0.55,
    interruptible: [0, 0.3], priority: 6,
    description: 'Overhead throw-in with a two-handed release',
    pose: (p) => {
      const wind = ease(p / 0.55);
      const release = ease((p - 0.55) / 0.45);
      const angles: PoseAngles = { pelvis: [0, 0, 0], spine: [-14 * wind + 22 * release, 0, 0], chest: [-8 * wind + 10 * release, 0, 0], head: [4 * wind - 8 * release, 0, 0] };
      leg(angles, 'L', -10 * wind + 12 * release, 20, 4, 6);
      leg(angles, 'R', 14 * wind - 8 * release, 14, 0, 6);
      arm(angles, 'L', -150 * wind + 120 * release, -20 + 30 * release, 12);
      arm(angles, 'R', -150 * wind + 120 * release, -20 + 30 * release, 12);
      return { angles, offset: { x: 0, y: -0.04 * wind, z: 0 } };
    },
  },
  {
    slot: 'corner_kick', category: 'restart', loop: false, rootMotion: false, duration: 0.78, contactFrame: 0.56,
    interruptible: [0, 0.3], priority: 7,
    description: 'Inswinging corner with the inside of the foot',
    pose: (p) => {
      const wind = ease(p / 0.56);
      const after = ease((p - 0.56) / 0.44);
      const angles: PoseAngles = { pelvis: [0, -12 * wind, 0], spine: [8 * wind, 14 * wind, 0], chest: [4 * wind, 8 * wind, 0], head: [-6, -16 * wind, 0] };
      leg(angles, 'R', -12 - 30 * wind + 30 * after, 26 + 27 * wind, -4, 5);
      leg(angles, 'L', 8 * wind, 18, 0, 6);
      arm(angles, 'L', -30 * wind, -40, 24);
      arm(angles, 'R', -18 * wind, -40, 22);
      return { angles, offset: { x: 0, y: -0.02 * wind, z: 0 } };
    },
  },
  // ---- reactions --------------------------------------------------------------
  {
    slot: 'celebrate', category: 'celebrate', loop: false, rootMotion: false, duration: 2.2,
    // Normalized window must satisfy 0 <= from <= to <= 1; [1, 1] = "only at the
    // very end" (any real action outranks priority 1 and interrupts anyway).
    interruptible: [1, 1], priority: 1,
    description: 'Two-arm celebration with a small hop',
    pose: (p) => {
      const up = ease(p / 0.25);
      const hop = Math.abs(Math.sin(p * Math.PI * 3)) * 0.12 * (1 - p * 0.5);
      const angles: PoseAngles = { pelvis: [0, 0, 0], spine: [-8 * up, 0, 0], chest: [-6 * up, 0, 0], head: [-12 * up, 0, 0] };
      leg(angles, 'L', -8 * up, 20 * up, 4, 6);
      leg(angles, 'R', -8 * up, 20 * up, 4, 6);
      arm(angles, 'L', -166 * up, -20, 24);
      arm(angles, 'R', -166 * up, -20, 24);
      return { angles, offset: { x: 0, y: hop, z: 0 } };
    },
  },
  {
    slot: 'stumble', category: 'recover', loop: false, rootMotion: true, duration: 0.55,
    interruptible: [0.35, 1], priority: 6,
    description: 'Knocked off balance backwards (1 m root travel)',
    pose: (p) => {
      const hit = bell(p, 0.35, 0.6);
      const angles: PoseAngles = { pelvis: [0, -10 * hit, 0], spine: [-16 * hit, 8 * hit, 0], chest: [-8 * hit, 0, 0], head: [10 * hit, 0, 0] };
      leg(angles, 'L', 20 * hit, 26 * hit, -6, 6);
      leg(angles, 'R', -16 * hit, 30 * hit, 6, 6);
      arm(angles, 'L', -46 * hit, -30, 40);
      arm(angles, 'R', -40 * hit, -34, 36);
      return { angles, offset: { x: 0, y: -0.05 * hit, z: -1.0 * hit } };
    },
  },
  {
    slot: 'get_up', category: 'recover', loop: false, rootMotion: false, duration: 1.0,
    interruptible: [0.6, 1], priority: 5,
    description: 'Push up from the ground and stand',
    pose: (p) => {
      const up = ease(p / 0.8);
      const angles: PoseAngles = {
        pelvis: [0, 0, 0],
        spine: [34 * (1 - up), 0, 0], chest: [18 * (1 - up), 0, 0], head: [-20 * (1 - up), 0, 0],
      };
      leg(angles, 'L', -64 * (1 - up), 76 * (1 - up), 0, 8);
      leg(angles, 'R', -50 * (1 - up), 70 * (1 - up), 0, 6);
      arm(angles, 'L', -40 * (1 - up), -60 * (1 - up), 24);
      arm(angles, 'R', -40 * (1 - up), -60 * (1 - up), 24);
      return { angles, offset: { x: 0, y: -0.24 * (1 - up), z: 0 } };
    },
  },
];

// ---------------------------------------------------------------- export
const round = (value: number, places = 3) => { const m = 10 ** places; return Math.round(value * m) / m; };

export interface GameClipDocument {
  format: 'fieldmotion.pose.v2';
  source: string;
  coordinateSystem: string;
  precision: number;
  note: string;
  jointOrder: JointName[];
  boneOrder: [JointName, JointName][];
  bindPose: number[];
  metadata: Record<string, unknown>;
  frames: { t: number; c: number; j: number[]; q: number[] }[];
}

export interface GameMotionPack {
  format: 'fieldmotion.pack.v1';
  source: string;
  generator: string;
  note: string;
  clips: GameClipDocument[];
}

/** Every bone of the bind pose, in a stable order, with its rest direction. */
const BIND_DIRECTIONS = JOINT_ORDER.flatMap((joint) => BONE_TREE[joint].map((child) => ({
  from: joint,
  to: child,
  dir: {
    x: BASE[child].x - BASE[joint].x,
    y: BASE[child].y - BASE[joint].y,
    z: BASE[child].z - BASE[joint].z,
  } satisfies Vec3,
})));

/** Shortest-arc rotation taking `from` to `to` (bind direction → tracked direction). */
function quatFromTo(from: Vec3, to: Vec3): Quat {
  const la = Math.hypot(from.x, from.y, from.z) || 1;
  const lb = Math.hypot(to.x, to.y, to.z) || 1;
  const ax = from.x / la, ay = from.y / la, az = from.z / la;
  const bx = to.x / lb, by = to.y / lb, bz = to.z / lb;
  const dot = ax * bx + ay * by + az * bz;
  if (dot >= 0.999999) return [0, 0, 0, 1];
  if (dot <= -0.999999) {
    const axis = Math.abs(ax) < 0.9 ? [0, -az, ay] : [az, 0, -ax];
    const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    return [axis[0] / len, axis[1] / len, axis[2] / len, 0];
  }
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  const w = 1 + dot;
  const len = Math.hypot(cx, cy, cz, w) || 1;
  return [cx / len, cy / len, cz / len, w / len];
}

/** Expand one spec into a FieldMotion v2 document at `fps`. */
export function buildGameClipDocument(spec: GameClipSpec, fps = 30): GameClipDocument {
  const fpsSafe = Math.max(8, Math.min(120, Math.round(fps)));
  const count = Math.max(2, Math.round(spec.duration * fpsSafe) + 1);
  const frames: GameClipDocument['frames'] = [];
  for (let i = 0; i < count; i++) {
    const p = i / (count - 1);
    // Loop clips must close: the last frame repeats the first pose, so the cycle has no pop.
    const sampleP = spec.loop && i === count - 1 ? 0 : p;
    const t = round(p * spec.duration);
    const { angles, offset } = spec.pose(sampleP, t);
    const joints = poseFromAngles(angles, offset ?? { x: 0, y: 0, z: 0 });
    const j = JOINT_ORDER.flatMap((name) => [round(joints[name].x), round(joints[name].y), round(joints[name].z)]);
    const q = BIND_DIRECTIONS.flatMap(({ from, to, dir }) => quatFromTo(dir, {
      x: joints[to].x - joints[from].x,
      y: joints[to].y - joints[from].y,
      z: joints[to].z - joints[from].z,
    }).map((v) => round(v, 4)));
    frames.push({ t, c: 1, j, q });
  }
  const id = `gen_${spec.slot}`.toLowerCase();
  const contactTime = spec.contactFrame === undefined ? undefined : round(spec.contactFrame * spec.duration);
  return {
    format: 'fieldmotion.pose.v2',
    source: `generated:${spec.slot}`,
    coordinateSystem: 'right-handed, Y-up, meters, +Z forward, +X to the subject right',
    precision: 3,
    note: 'Generated on the shared 21-joint field skeleton. frames[].j is the authority (flat x,y,z per jointOrder); frames[].q rotates each bind direction to the tracked direction. metadata.slot names the game animation slot this clip drives.',
    jointOrder: JOINT_ORDER,
    boneOrder: BIND_DIRECTIONS.map(({ from, to }) => [from, to] as [JointName, JointName]),
    bindPose: JOINT_ORDER.flatMap((name) => [round(BASE[name].x), round(BASE[name].y), round(BASE[name].z)]),
    metadata: {
      id,
      slot: spec.slot,
      category: spec.category,
      loop: spec.loop,
      rootMotion: spec.rootMotion,
      duration: spec.duration,
      ...(spec.contactFrame === undefined ? {} : { contactFrame: spec.contactFrame }),
      ...(spec.speedBand === undefined ? {} : { speedBand: spec.speedBand }),
      interruptible: spec.interruptible,
      priority: spec.priority,
      tags: ['generated', `slot:${spec.slot}`],
      description: spec.description,
      ...(contactTime === undefined ? {} : { frameEvents: [{ t: contactTime, type: 'ball_contact' }] }),
    },
    frames,
  };
}

/** Every clip, packaged for Motion Lab / the game's `importMotionPack`. */
export function buildGameMotionPack(fps = 30): GameMotionPack {
  return {
    format: 'fieldmotion.pack.v1',
    source: 'football-motion-generator',
    generator: 'tool/src/gameclip.ts',
    note: 'Game-ready animation set. Import in the prototype Motion Lab (or engine.importMotionPack) and every clip binds to its animation slot from metadata.slot.',
    clips: GAME_CLIP_SPECS.map((spec) => buildGameClipDocument(spec, fps)),
  };
}
