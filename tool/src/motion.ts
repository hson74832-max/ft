import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export type Vec3 = { x: number; y: number; z: number };
export type JointName =
  | 'pelvis'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'leftElbow'
  | 'leftWrist'
  | 'rightShoulder'
  | 'rightElbow'
  | 'rightWrist'
  | 'leftHip'
  | 'leftKnee'
  | 'leftAnkle'
  | 'leftHeel'
  | 'leftToe'
  | 'rightHip'
  | 'rightKnee'
  | 'rightAnkle'
  | 'rightHeel'
  | 'rightToe';

export type Joints = Record<JointName, Vec3>;
export type Normalized2D = { x: number; y: number; visibility?: number };
/** Low-res person-probability mask. `rect` is the normalized full-frame region it covers. */
export type MaskData = { data: Uint8ClampedArray; width: number; height: number; rect: [number, number, number, number] };
/** Per-frame measurements used by finalizeClip to place the root consistently across a clip. */
export type FrameMeta = { hipX: number; hipY: number; mpu: number; aspect: number };
export type PoseFrame = {
  time: number;
  joints: Joints;
  confidence: number;
  /** 33 landmarks in normalized FULL-frame coordinates (already un-cropped from any ROI). */
  landmarks2D?: Normalized2D[];
  /** Bounding box in normalized [0,1] image coordinates: [minX, minY, maxX, maxY] */
  bbox?: [number, number, number, number];
  /** Segmentation mask for this frame, when segmentation was enabled. */
  mask?: MaskData;
  /** Decoded source frame (GIFs only) so the preview stays frame-synced with the pose. */
  image?: ImageBitmap;
  meta?: FrameMeta;
  /** True when the tracked player was not found on this frame (pose held or interpolated). */
  held?: boolean;
  /** Multi-player: the player is not in the clip at this time (before he appears / after he leaves). Renderers hide him. */
  absent?: boolean;
};
export type Movement = 'kick' | 'sprint' | 'header' | 'tackle' | 'save';

/**
 * Anatomical 21-joint humanoid skeleton topology matching the user reference
 * (color-coded limbs: left = coral, right = cyan/blue, center = white, head = yellow).
 */
export const BONES: Array<[JointName, JointName, 'left' | 'right' | 'center' | 'head']> = [
  // Central column
  ['pelvis', 'spine', 'center'],
  ['spine', 'chest', 'center'],
  ['chest', 'neck', 'center'],
  ['neck', 'head', 'head'],
  // Left arm (subject's anatomical left)
  ['chest', 'leftShoulder', 'left'],
  ['leftShoulder', 'leftElbow', 'left'],
  ['leftElbow', 'leftWrist', 'left'],
  // Right arm (subject's anatomical right)
  ['chest', 'rightShoulder', 'right'],
  ['rightShoulder', 'rightElbow', 'right'],
  ['rightElbow', 'rightWrist', 'right'],
  // Left leg
  ['pelvis', 'leftHip', 'left'],
  ['leftHip', 'leftKnee', 'left'],
  ['leftKnee', 'leftAnkle', 'left'],
  ['leftAnkle', 'leftHeel', 'left'],
  ['leftHeel', 'leftToe', 'left'],
  // Right leg
  ['pelvis', 'rightHip', 'right'],
  ['rightHip', 'rightKnee', 'right'],
  ['rightKnee', 'rightAnkle', 'right'],
  ['rightAnkle', 'rightHeel', 'right'],
  ['rightHeel', 'rightToe', 'right'],
];

/** Standard MediaPipe 33-landmark 2D connections for drawing on video overlay */
export const MEDIAPIPE_CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
  [15, 17], [15, 19], [15, 21], [16, 18], [16, 20], [16, 22],
];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
const mid = (a: Vec3, b: Vec3): Vec3 => v((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
const mix = (a: Vec3, b: Vec3, t: number): Vec3 => v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/**
 * Anatomically proportioned humanoid rest pose (Y-up, in meters, right-handed).
 * Pelvis at ~1.04m, top of head at ~1.88m, feet grounded at ~0.04m.
 */
const BASE: Joints = {
  pelvis: v(0, 1.04, 0),
  spine: v(0, 1.26, 0),
  chest: v(0, 1.48, 0),
  neck: v(0, 1.67, 0),
  head: v(0, 1.88, 0),
  // Anatomical left (subject's left = viewer's right when facing camera)
  leftShoulder: v(-0.24, 1.52, 0),
  leftElbow: v(-0.42, 1.22, 0),
  leftWrist: v(-0.48, 0.96, 0),
  // Anatomical right
  rightShoulder: v(0.24, 1.52, 0),
  rightElbow: v(0.42, 1.22, 0),
  rightWrist: v(0.48, 0.96, 0),
  leftHip: v(-0.16, 1.02, 0),
  leftKnee: v(-0.17, 0.58, 0),
  leftAnkle: v(-0.17, 0.12, 0),
  leftHeel: v(-0.19, 0.06, -0.05),
  leftToe: v(-0.17, 0.045, 0.14),
  rightHip: v(0.16, 1.02, 0),
  rightKnee: v(0.17, 0.58, 0),
  rightAnkle: v(0.17, 0.12, 0),
  rightHeel: v(0.19, 0.06, -0.05),
  rightToe: v(0.17, 0.045, 0.14),
};

export const MOVEMENTS: Record<Movement, { label: string; subtitle: string; focus: string; detail: string; metric: string; metricLabel: string }> = {
  kick: { label: 'Instep kick', subtitle: 'Plant, rotate, strike, follow through', focus: 'Explosive hip rotation', detail: 'Preserve the pelvis-to-shoulder twist through ball contact. Use an adaptive smoothing cutoff on the striking leg and pin the support foot to avoid sliding.', metric: '42 deg', metricLabel: 'PEAK HIP ROTATION' },
  sprint: { label: 'Sprint cycle', subtitle: 'Stride and counter-rotation', focus: 'Opposing arm swing', detail: 'Keep arm drive out of phase with the legs. Detect stance transitions at the ankles, then stabilize the planted foot while the torso remains forward.', metric: '3.8 Hz', metricLabel: 'STRIDE CADENCE' },
  header: { label: 'Header', subtitle: 'Load, jump, make contact', focus: 'Vertical impulse', detail: 'Track the takeoff and landing from both feet. Preserve the quick neck extension at impact while smoothing slower torso motion.', metric: '0.43 m', metricLabel: 'VERTICAL LIFT' },
  tackle: { label: 'Slide tackle', subtitle: 'Lower center of mass', focus: 'Center-of-mass shift', detail: 'Carry the root downward and laterally before leg extension. Keep the bracing hand and sliding heel close to the ground plane.', metric: '0.61 m', metricLabel: 'COM DROP' },
  save: { label: 'Goalkeeper dive', subtitle: 'Push off and reach', focus: 'Lateral displacement', detail: 'Anchor the push-off foot until launch, then allow fast root translation. Retain shoulder and wrist reach without averaging away the dive.', metric: '1.24 m', metricLabel: 'LATERAL REACH' },
};

export function demoFrame(movement: Movement, time: number): PoseFrame {
  const j = Object.fromEntries(Object.entries(BASE).map(([key, value]) => [key, { ...value }])) as Joints;
  const p = (time % 4) / 4;
  const wave = Math.sin(p * Math.PI * 2);
  const shift = (names: JointName[], dx: number, dy: number, dz = 0) => names.forEach((name) => { j[name].x += dx; j[name].y += dy; j[name].z += dz; });
  const upper: JointName[] = ['pelvis', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftElbow', 'leftWrist', 'rightShoulder', 'rightElbow', 'rightWrist', 'leftHip', 'rightHip'];

  if (movement === 'kick') {
    const strike = Math.sin((p - 0.19) * Math.PI * 2);
    const lift = Math.max(0, 1 - Math.abs(p - 0.48) / 0.36);
    j.rightHip.z += 0.17 * strike;
    j.leftHip.z -= 0.09 * strike;
    j.rightKnee.x += 0.32 * strike; j.rightKnee.y += 0.12 * lift; j.rightKnee.z += 0.19 * strike;
    shift(['rightAnkle', 'rightHeel', 'rightToe'], 0.68 * strike, 0.39 * lift, 0.27 * strike);
    shift(['chest', 'neck', 'head', 'leftShoulder', 'leftElbow', 'leftWrist', 'rightShoulder', 'rightElbow', 'rightWrist'], -0.08 * strike, -0.025 * lift, -0.14 * strike);
    shift(['leftElbow', 'leftWrist'], -0.12 * strike, 0.06 * lift);
    shift(['rightElbow', 'rightWrist'], 0.09 * strike, -0.05 * lift);
  } else if (movement === 'sprint') {
    const stride = Math.sin(p * Math.PI * 4);
    const bounce = 0.045 + 0.045 * Math.cos(p * Math.PI * 8);
    shift(Object.keys(j) as JointName[], 0, bounce);
    j.leftKnee.x += 0.24 * stride; j.rightKnee.x -= 0.24 * stride;
    shift(['leftAnkle', 'leftHeel', 'leftToe'], 0.48 * stride, 0.19 * Math.max(0, stride));
    shift(['rightAnkle', 'rightHeel', 'rightToe'], -0.48 * stride, 0.19 * Math.max(0, -stride));
    j.leftElbow.x -= 0.21 * stride; j.leftWrist.x -= 0.32 * stride;
    j.rightElbow.x += 0.21 * stride; j.rightWrist.x += 0.32 * stride;
    j.leftWrist.y += 0.11 * stride; j.rightWrist.y -= 0.11 * stride;
    shift(['chest', 'neck', 'head'], 0.08, -0.04);
  } else if (movement === 'header') {
    const jump = 0.43 * Math.max(0, Math.sin(p * Math.PI * 2 - 0.55));
    shift(Object.keys(j) as JointName[], 0, jump);
    const anticipation = Math.max(0, Math.sin(p * Math.PI * 2 + 0.8));
    j.leftKnee.y -= 0.12 * anticipation; j.rightKnee.y -= 0.12 * anticipation;
    shift(['leftElbow', 'leftWrist'], -0.1, 0.27 + 0.1 * jump);
    shift(['rightElbow', 'rightWrist'], 0.1, 0.27 + 0.1 * jump);
    j.head.x += 0.14 * wave; j.neck.x += 0.06 * wave;
  } else if (movement === 'tackle') {
    const slide = Math.max(0, Math.sin(p * Math.PI));
    shift(upper, 0.36 * slide, -0.43 * slide);
    shift(['chest', 'neck', 'head', 'leftShoulder', 'leftElbow', 'leftWrist', 'rightShoulder', 'rightElbow', 'rightWrist'], 0.23 * slide, -0.08 * slide);
    shift(['rightKnee', 'rightAnkle', 'rightHeel', 'rightToe'], 0.75 * slide, -0.27 * slide);
    shift(['leftKnee', 'leftAnkle', 'leftHeel', 'leftToe'], -0.3 * slide, -0.13 * slide);
    shift(['leftElbow', 'leftWrist'], -0.23 * slide, -0.2 * slide);
  } else {
    const dive = Math.max(0, Math.sin(p * Math.PI));
    shift(Object.keys(j) as JointName[], 0.6 * dive, 0.1 * dive);
    shift(['chest', 'neck', 'head', 'leftShoulder', 'leftElbow', 'leftWrist', 'rightShoulder', 'rightElbow', 'rightWrist'], 0.23 * dive, -0.26 * dive);
    shift(['rightElbow', 'rightWrist'], 0.3 * dive, 0.24 * dive);
    shift(['leftElbow', 'leftWrist'], 0.44 * dive, 0.14 * dive);
    shift(['leftKnee', 'leftAnkle', 'leftHeel', 'leftToe'], -0.18 * dive, 0.22 * dive);
  }

  // Synthesize matching 2D normalized points so isolation view also works for demo motions
  // Unset landmarks MUST be invisible; previously they sat at (0.5, 0.5) with
  // visibility 1 and were drawn as stray dots and lines to the frame centre.
  const demo2D: Normalized2D[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  const proj2D = (pt: Vec3) => ({ x: 0.5 + pt.x * 0.28, y: 0.9 - pt.y * 0.38, visibility: 1 });
  demo2D[0] = proj2D(j.head);
  demo2D[11] = proj2D(j.leftShoulder); demo2D[12] = proj2D(j.rightShoulder);
  demo2D[13] = proj2D(j.leftElbow); demo2D[14] = proj2D(j.rightElbow);
  demo2D[15] = proj2D(j.leftWrist); demo2D[16] = proj2D(j.rightWrist);
  demo2D[23] = proj2D(j.leftHip); demo2D[24] = proj2D(j.rightHip);
  demo2D[25] = proj2D(j.leftKnee); demo2D[26] = proj2D(j.rightKnee);
  demo2D[27] = proj2D(j.leftAnkle); demo2D[28] = proj2D(j.rightAnkle);
  demo2D[29] = proj2D(j.leftHeel); demo2D[30] = proj2D(j.rightHeel);
  demo2D[31] = proj2D(j.leftToe); demo2D[32] = proj2D(j.rightToe);

  const bbox = bboxOf(demo2D);

  return { time, joints: j, confidence: 1, landmarks2D: demo2D, bbox };
}

const sub = (a: Vec3, b: Vec3): Vec3 => v(a.x - b.x, a.y - b.y, a.z - b.z);
const add = (a: Vec3, b: Vec3): Vec3 => v(a.x + b.x, a.y + b.y, a.z + b.z);
const scaleV = (a: Vec3, s: number): Vec3 => v(a.x * s, a.y * s, a.z * s);
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => { const l = len(a); return l > 1e-6 ? scaleV(a, 1 / l) : v(0, 1, 0); };

function bboxOf(points: Normalized2D[]): [number, number, number, number] | undefined {
  const visible = points.filter((p) => (p.visibility ?? 1) > 0.3);
  const pool = visible.length >= 4 ? visible : points;
  if (!pool.length) return undefined;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of pool) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return [Math.max(0, minX - 0.03), Math.max(0, minY - 0.05), Math.min(1, maxX + 0.03), Math.min(1, maxY + 0.03)];
}

/**
 * Maps MediaPipe's 33 landmarks to the 21-joint rig, HIP-CENTRED (pelvis at the
 * origin). Root placement is deferred to finalizeClip, which uses clip-wide
 * statistics instead of noisy per-frame heuristics.
 *
 * MediaPipe world space: metres, origin at hip midpoint, +Y down, -Z toward camera.
 * Output: metres, +Y up, +Z toward camera. Negating Y and Z is a 180° rotation
 * about X, so handedness is preserved (no accidental mirroring).
 * Indices: odd = subject's LEFT (11,13,15,23,25,27,29,31), even = RIGHT.
 *
 * @param image landmarks in normalized FULL-frame coordinates
 * @param aspect full-frame width / height (needed because normalized x and y
 *               are scaled by different pixel dimensions)
 */
export function landmarksToFrame(worldIn: NormalizedLandmark[], imageIn: NormalizedLandmark[], time: number, aspect = 16 / 9): PoseFrame {
  // MediaPipe guarantees 33 points, but a partial/ROI result must never crash the run.
  const blank = (): NormalizedLandmark => ({ x: 0, y: 0, z: 0, visibility: 0 });
  const world = Array.from({ length: 33 }, (_, i) => worldIn[i] ?? blank());
  const image = Array.from({ length: 33 }, (_, i) => imageIn[i] ?? { x: 0.5, y: 0.5, visibility: 0 });
  const raw = (i: number): Vec3 => v(world[i].x, -world[i].y, -world[i].z);
  const vis = (i: number) => world[i].visibility ?? 0;
  const hipMid = mid(raw(23), raw(24));
  const P = (i: number) => sub(raw(i), hipMid);

  const pelvis = v(0, 0, 0);
  const chest = mid(P(11), P(12));
  // Head from the ear midpoint (skull centre) - the nose sits forward and low,
  // which previously made the head node short and tipped toward the camera.
  const earMid = vis(7) > 0.3 && vis(8) > 0.3 ? mid(P(7), P(8)) : vis(7) > 0.3 ? P(7) : vis(8) > 0.3 ? P(8) : P(0);
  const up = unit(sub(earMid, chest));
  const neck = mix(chest, earMid, 0.5);
  const head = add(earMid, scaleV(up, 0.08));

  const ankleL = P(27), ankleR = P(28);
  const kneeL = P(25), kneeR = P(26);
  // Occluded heel/toe (grass, ball contact) fall back to offsets along the shin
  // so the foot never folds back through the ankle.
  const foot = (ankle: Vec3, knee: Vec3, heelIdx: number, toeIdx: number) => {
    const shin = unit(sub(ankle, knee));
    const heel = vis(heelIdx) > 0.3 ? P(heelIdx) : add(ankle, scaleV(shin, 0.06));
    const toe = vis(toeIdx) > 0.3 ? P(toeIdx) : add(add(ankle, scaleV(shin, 0.07)), v(0, 0, 0.13));
    return { heel, toe };
  };
  const fl = foot(ankleL, kneeL, 29, 31);
  const fr = foot(ankleR, kneeR, 30, 32);

  const joints: Joints = {
    pelvis, spine: mix(pelvis, chest, 0.5), chest, neck, head,
    leftShoulder: P(11), leftElbow: P(13), leftWrist: P(15),
    rightShoulder: P(12), rightElbow: P(14), rightWrist: P(16),
    leftHip: P(23), leftKnee: kneeL, leftAnkle: ankleL, leftHeel: fl.heel, leftToe: fl.toe,
    rightHip: P(24), rightKnee: kneeR, rightAnkle: ankleR, rightHeel: fr.heel, rightToe: fr.toe,
  };

  const important = [11, 12, 23, 24, 25, 26, 27, 28];
  const confidence = important.reduce((s, i) => s + vis(i), 0) / important.length;

  const landmarks2D: Normalized2D[] = image.map((lm) => ({ x: lm.x, y: lm.y, visibility: lm.visibility }));

  // Metres-per-normalized-image-unit (vertical), from shoulder-to-ankle span
  // measured in both spaces. Used to convert image hip motion into metres.
  const hipX = (image[23].x + image[24].x) / 2;
  const hipY = (image[23].y + image[24].y) / 2;
  const imgSpan = Math.max(image[27].y, image[28].y) - (image[11].y + image[12].y) / 2;
  const worldSpan = chest.y - Math.min(ankleL.y, ankleR.y);
  const mpu = imgSpan > 0.05 && worldSpan > 0.3 ? worldSpan / imgSpan : NaN;

  return { time, joints, confidence, landmarks2D, bbox: bboxOf(landmarks2D), meta: { hipX, hipY, mpu, aspect } };
}

const median = (values: number[]) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const percentile = (values: number[], p: number) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
};

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Fill short "player not found" gaps by interpolating between the last and next
 * good frames, instead of freezing the skeleton. Gaps longer than `maxGap`
 * seconds, or touching the clip start/end, stay held (honestly frozen).
 * Bridged frames get confidence 0.4 so the smoother treats them as real data.
 */
export function bridgeHeld(frames: PoseFrame[], maxGap = 0.8): PoseFrame[] {
  const out = frames.slice();
  let i = 0;
  while (i < out.length) {
    if (!out[i].held) { i++; continue; }
    let j = i;
    while (j < out.length && out[j].held) j++;
    const a = out[i - 1], b = out[j];
    if (a && b && !a.held && !b.held && b.time > a.time && b.time - a.time <= maxGap) {
      for (let k = i; k < j; k++) {
        const t = (out[k].time - a.time) / (b.time - a.time);
        const joints = {} as Joints;
        for (const n of Object.keys(a.joints) as JointName[]) {
          joints[n] = { x: lerpN(a.joints[n].x, b.joints[n].x, t), y: lerpN(a.joints[n].y, b.joints[n].y, t), z: lerpN(a.joints[n].z, b.joints[n].z, t) };
        }
        const A = a.landmarks2D, B = b.landmarks2D;
        const landmarks2D = A && B && A.length === B.length
          ? A.map((p, idx) => ({ x: lerpN(p.x, B[idx].x, t), y: lerpN(p.y, B[idx].y, t), visibility: Math.min(p.visibility ?? 1, B[idx].visibility ?? 1) }))
          : out[k].landmarks2D;
        const bbox = a.bbox && b.bbox ? (a.bbox.map((v, idx) => lerpN(v, b.bbox![idx], t)) as [number, number, number, number]) : out[k].bbox;
        const meta = a.meta && b.meta
          ? { ...a.meta, hipX: lerpN(a.meta.hipX, b.meta.hipX, t), hipY: lerpN(a.meta.hipY, b.meta.hipY, t), mpu: Number.isFinite(a.meta.mpu) && Number.isFinite(b.meta.mpu) ? lerpN(a.meta.mpu, b.meta.mpu, t) : a.meta.mpu }
          : out[k].meta;
        // No mask: a neighbour's mask would sit at the wrong place; the hull cutout follows the interpolated pose.
        out[k] = { ...out[k], joints, landmarks2D, bbox, meta, confidence: 0.4, mask: undefined };
      }
    }
    i = j;
  }
  return out;
}

/**
 * Clip-level accuracy pass, run once after tracking:
 *  1. Bone-length stabilisation - monocular depth makes limb lengths "breathe"
 *     frame to frame. Each bone is reset to its clip median length while keeping
 *     its tracked direction (walked parent-first so children follow).
 *  2. Root placement - image hip motion converted to metres with the clip-median
 *     scale (per-frame scale is noisy), centred on the clip's median position.
 *  3. Grounding - the floor is the 10th percentile of each frame's lowest foot
 *     point, so standing frames touch y=0 while jumps (headers) stay airborne.
 */
/**
 * Shared reference for placing several players in ONE scene. Without it every
 * clip is centred on its own median position, so all players stack at the origin.
 *  x0    normalized image x mapped to scene x = 0 (median of everyone)
 *  mpu0  metres-per-normalized-height of the reference (median) player
 *  fovK  2*tan(vfov/2). Metres-per-unit grows linearly with distance
 *        (mpu = D * fovK), so depth offset = -(mpu - mpu0) / fovK.
 */
export type ScenePlacement = { x0: number; mpu0: number; fovK: number };

/** Median of the finite values within +/- `half` samples of each index (NaN when none). */
export function rollingMedian(values: number[], half: number): number[] {
  return values.map((_, i) => {
    const w: number[] = [];
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) if (Number.isFinite(values[k])) w.push(values[k]);
    if (!w.length) return NaN;
    w.sort((a, b) => a - b);
    return w[w.length >> 1];
  });
}

export function finalizeClip(frames: PoseFrame[], scene?: ScenePlacement): PoseFrame[] {
  if (!frames.length) return frames;
  // Held frames are verbatim copies of the pose before a gap, and bridged ones
  // are interpolations. Including them stacks the statistics toward the moment
  // tracking was lost, which skews both the bone-length medians and the floor.
  const trusted = frames.filter((f) => f.confidence >= 0.5 && !f.held);
  const pool = trusted.length >= 3 ? trusted : frames;
  const boneLen = new Map<string, number>();
  for (const [a, b] of BONES) boneLen.set(`${a}>${b}`, median(pool.map((f) => len(sub(f.joints[b], f.joints[a])))));

  const mpu = median(pool.map((f) => f.meta?.mpu ?? NaN));
  const scale = Number.isFinite(mpu) ? mpu : 1.9;
  const aspect = frames.find((f) => f.meta)?.meta?.aspect ?? 16 / 9;
  const hipX0 = median(pool.map((f) => f.meta?.hipX ?? NaN));
  const hipY0 = median(pool.map((f) => f.meta?.hipY ?? NaN));

  // Scene mode: per-frame scale from a rolling median (a player running toward
  // the camera gets bigger, i.e. closer), and vertical motion HIGH-PASSED so
  // slow image-y drift from depth change doesn't read as sinking, while a jump
  // (shorter than the window) is kept.
  const isTrusted = (f: PoseFrame) => !f.held && f.confidence >= 0.5;
  const dt = frames.length > 1 ? Math.max(1e-3, (frames[frames.length - 1].time - frames[0].time) / (frames.length - 1)) : 1 / 30;
  const mpuSeries = scene ? rollingMedian(frames.map((f) => (isTrusted(f) ? f.meta?.mpu ?? NaN : NaN)), Math.round(0.5 / dt)) : [];
  const hipYSeries = scene ? rollingMedian(frames.map((f) => (isTrusted(f) ? f.meta?.hipY ?? NaN : NaN)), Math.round(0.75 / dt)) : [];

  const placed = frames.map((f, idx) => {
    const out = { ...f.joints } as Joints;
    for (const [a, b] of BONES) {
      const L = boneLen.get(`${a}>${b}`)!;
      const dir = sub(f.joints[b], f.joints[a]);
      out[b] = Number.isFinite(L) && len(dir) > 1e-6 ? add(out[a], scaleV(unit(dir), L)) : add(out[a], dir);
    }
    let rx = 0, ry = 0, rz = 0;
    if (scene) {
      const m = Number.isFinite(mpuSeries[idx]) ? mpuSeries[idx] : scale;
      if (f.meta) {
        rx = (f.meta.hipX - scene.x0) * aspect * m;
        const base = Number.isFinite(hipYSeries[idx]) ? hipYSeries[idx] : f.meta.hipY;
        ry = (base - f.meta.hipY) * m;
      }
      rz = -(m - scene.mpu0) / scene.fovK;
    } else {
      rx = f.meta && Number.isFinite(hipX0) ? (f.meta.hipX - hipX0) * aspect * scale : 0;
      ry = f.meta && Number.isFinite(hipY0) ? (hipY0 - f.meta.hipY) * scale : 0;
    }
    for (const k of Object.keys(out) as JointName[]) out[k] = v(out[k].x + rx, out[k].y + ry, out[k].z + rz);
    return out;
  });

  const feet: JointName[] = ['leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel', 'leftToe', 'rightToe'];
  // Ground the clip on frames where the player was genuinely tracked.
  const grounded = placed.map((j, i) => ({ j, ok: !frames[i].held && frames[i].confidence >= 0.5 }))
    .filter((x) => x.ok).map((x) => Math.min(...feet.map((k) => x.j[k].y)));
  const floor = percentile(grounded.length >= 3 ? grounded : placed.map((j) => Math.min(...feet.map((k) => j[k].y))), 0.1);
  return frames.map((f, i) => {
    const j = placed[i];
    for (const k of Object.keys(j) as JointName[]) j[k] = v(j[k].x, j[k].y - floor, j[k].z);
    return { ...f, joints: j };
  });
}

class LowPass {
  value?: number;
  filter(value: number, alpha: number) {
    this.value = this.value === undefined ? value : alpha * value + (1 - alpha) * this.value;
    return this.value;
  }
}

/**
 * One-Euro filter with two anti-vibration changes over the textbook form:
 *  - speed is measured across THREE samples, not one. Differencing adjacent
 *    samples makes per-frame detection noise look like enormous velocity,
 *    which opens the cutoff and lets the noise through (the vibration loop).
 *  - the speed term itself is low-passed, so a single spike cannot widen the
 *    cutoff for one frame.
 */
class OneEuro {
  private x = new LowPass();
  private speedLp = new LowPass();
  private prevTime?: number;
  private hx: number[] = [];
  private ht: number[] = [];
  constructor(private minCutoff: number, private beta: number) {}
  filter(value: number, time: number) {
    const dt = this.prevTime === undefined ? 1 / 30 : Math.max(1 / 240, time - this.prevTime);
    this.prevTime = time;
    const alpha = (cutoff: number) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };

    this.hx.push(value); if (this.hx.length > 3) this.hx.shift();
    this.ht.push(time); if (this.ht.length > 3) this.ht.shift();
    let rawSpeed = 0;
    if (this.hx.length === 3) {
      const span = this.ht[2] - this.ht[0];
      if (span > 1e-5) rawSpeed = Math.abs(this.hx[2] - this.hx[0]) / span;
    }
    const speed = this.speedLp.filter(rawSpeed, alpha(0.8));
    return this.x.filter(value, alpha(this.minCutoff + this.beta * speed));
  }
}

const AXES = ['x', 'y', 'z'] as const;
const median3 = (a: number, b: number, c: number) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/**
 * Temporal de-jitter. Pipeline per joint axis:
 *   1. Dropouts (confidence < 0.35) feed the LAST TRUSTED pose back into the
 *      filter instead of returning early. Returning early used to leave filter
 *      state and timestamps stale, so recovery produced a visible snap.
 *   2. A 3-tap median removes single-frame spikes (the dominant visual jitter)
 *      while preserving real extrema of a strike/reach, since a monotonic ramp
 *      passes through a median unchanged.
 *   3. One-Euro smoothing with per-group beta keeps explosive distal motion
 *      crisp but no longer chases its own noise.
 */
export function smoothFrames(frames: PoseFrame[], amount: number): PoseFrame[] {
  if (amount <= 0 || frames.length < 2) return frames;
  const strength = Math.min(1, Math.max(0, amount / 100));
  const minCutoff = 7.5 - strength * 6.25; // 7.5 Hz (crisp) -> 1.25 Hz (very still)
  const useMedian = amount >= 20;
  const names = Object.keys(frames[0].joints) as JointName[];
  const betaFor = (name: JointName) =>
    /Toe|Heel/.test(name) ? 0.10
      : /Ankle|Wrist/.test(name) ? 0.14
      : /Knee|Elbow/.test(name) ? 0.12
      : /Hip|Shoulder/.test(name) ? 0.08
      : 0.05;

  // Build per-axis input series, substituting held poses across dropouts.
  // Series are indexed by (joint, axis) position rather than string keys: the
  // previous `${name}.${axis}` Map lookups ran 63 x frames x 2 times per call.
  const J = names.length;
  const series: number[][] = Array.from({ length: J * 3 }, () => new Array<number>(frames.length));
  let lastGood: Joints | null = null;
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const low = f.confidence < 0.35 && lastGood !== null;
    const src = low ? lastGood! : f.joints;
    for (let ji = 0; ji < J; ji++) {
      const p = src[names[ji]];
      series[ji * 3][fi] = p.x; series[ji * 3 + 1][fi] = p.y; series[ji * 3 + 2][fi] = p.z;
    }
    if (!low) lastGood = f.joints;
  }

  if (useMedian) {
    for (const arr of series) {
      if (arr.length < 3) continue;
      const src = arr.slice();
      for (let i = 1; i < src.length - 1; i++) arr[i] = median3(src[i - 1], src[i], src[i + 1]);
    }
  }

  const filters = series.map((_, si) => new OneEuro(minCutoff, betaFor(names[(si / 3) | 0])));
  return frames.map((frame, index) => {
    const joints = {} as Joints;
    for (let ji = 0; ji < J; ji++) {
      joints[names[ji]] = {
        x: filters[ji * 3].filter(series[ji * 3][index], frame.time),
        y: filters[ji * 3 + 1].filter(series[ji * 3 + 1][index], frame.time),
        z: filters[ji * 3 + 2].filter(series[ji * 3 + 2][index], frame.time),
      };
    }
    return { ...frame, joints };
  });
}

/** Median-of-5 then 5-tap average: removes per-frame noise from a series without lagging slow drift. */
function denoise(series: number[]): number[] {
  const n = series.length;
  const med = series.map((_, i) => {
    const w: number[] = [];
    for (let k = -2; k <= 2; k++) w.push(series[Math.min(n - 1, Math.max(0, i + k))]);
    return w.sort((a, b) => a - b)[2];
  });
  return med.map((_, i) => {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += med[Math.min(n - 1, Math.max(0, i + k))];
    return sum / 5;
  });
}

/**
 * Anti-levitation ground lock. From the clip start until `until` seconds the
 * whole pose is moved vertically so the lowest foot point rests on the floor
 * (y = 0), then the correction fades out over `fade` seconds so a later jump,
 * header or dive isn't glued down and nothing pops at the boundary.
 *
 * The offset series is DENOISED first. Pinning the raw per-frame lowest point
 * copies foot-detection noise onto the whole body as vertical vibration. A
 * second rule limits any sinking to 3 cm, and a 0.5 m cap stops one bad frame
 * from yanking the skeleton through the ground.
 */
export function groundLockFrames(frames: PoseFrame[], until: number, fade = 0.5): PoseFrame[] {
  if (until <= 0 || !frames.length) return frames;
  const feet: JointName[] = ['leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel', 'leftToe', 'rightToe'];
  const lowest = frames.map((f) => Math.min(...feet.map((k) => f.joints[k].y)));
  const target = denoise(lowest.map((y) => -y));
  return frames.map((f, i) => {
    const w = f.time <= until ? 1 : Math.max(0, 1 - (f.time - until) / Math.max(0.05, fade));
    if (w <= 0) return f;
    // Follow the denoised floor. Feet may dip at most 3 cm (below the noise floor, invisible);
    // a strict per-frame "never below 0" rule copied foot noise onto the whole body as vibration.
    const dy = clamp(Math.max(target[i], -lowest[i] - 0.03), -0.5, 0.5) * w;
    if (Math.abs(dy) < 1e-5) return f;
    const joints = {} as Joints;
    for (const k of Object.keys(f.joints) as JointName[]) joints[k] = { x: f.joints[k].x, y: f.joints[k].y + dy, z: f.joints[k].z };
    return { ...f, joints };
  });
}

/**
 * Residual-vibration metric: mean absolute second difference (pose "curvature")
 * across distal and torso joints, in millimetres per frame step. Detection noise
 * dominates this number; clean articulated motion is close to zero. Used in the
 * UI so smoothing can be verified instead of guessed.
 */
export function jitterScore(frames: PoseFrame[]): number {
  if (frames.length < 3) return 0;
  const keys: JointName[] = ['pelvis', 'head', 'leftWrist', 'rightWrist', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle'];
  let sum = 0, count = 0;
  for (let i = 1; i < frames.length - 1; i++) {
    const a = frames[i - 1], b = frames[i], c = frames[i + 1];
    // Ignore held frames: their zero curvature would flatter the score.
    if (b.confidence < 0.35 || a.held || b.held || c.held) continue;
    if (b.time - a.time <= 0 || c.time - b.time <= 0) continue;
    for (const k of keys) for (const ax of AXES) {
      sum += Math.abs(c.joints[k][ax] - 2 * b.joints[k][ax] + a.joints[k][ax]);
      count++;
    }
  }
  return count ? (sum / count) * 1000 : 0;
}

/**
 * Change the effective frame rate of an already-tracked clip by linearly
 * interpolating joint positions. Lets switching 15 -> 30 -> 60 FPS retime a
 * clip instantly instead of forcing a full re-run of pose estimation.
 */
export function resampleFrames(frames: PoseFrame[], targetFps: number): PoseFrame[] {
  if (frames.length < 2) return frames;
  const source = frames[frames.length - 1].time - frames[0].time;
  if (source <= 0) return frames;
  const count = Math.max(2, Math.round(source * targetFps) + 1);
  const names = Object.keys(frames[0].joints) as JointName[];
  const out: PoseFrame[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const t = frames[0].time + (i / (count - 1)) * source;
    while (cursor < frames.length - 2 && frames[cursor + 1].time < t) cursor++;
    const a = frames[cursor];
    const b = frames[Math.min(cursor + 1, frames.length - 1)];
    const span = b.time - a.time;
    const k = span > 0 ? Math.min(1, Math.max(0, (t - a.time) / span)) : 0;
    const joints = {} as Joints;
    for (const name of names) {
      joints[name] = {
        x: a.joints[name].x + (b.joints[name].x - a.joints[name].x) * k,
        y: a.joints[name].y + (b.joints[name].y - a.joints[name].y) * k,
        z: a.joints[name].z + (b.joints[name].z - a.joints[name].z) * k,
      };
    }
    out.push({
      time: t,
      joints,
      confidence: a.confidence + (b.confidence - a.confidence) * k,
      landmarks2D: k < 0.5 ? a.landmarks2D : b.landmarks2D,
      bbox: k < 0.5 ? a.bbox : b.bbox,
      mask: k < 0.5 ? a.mask : b.mask,
      image: k < 0.5 ? a.image : b.image,
    });
  }
  return out;
}

/**
 * Calculates a unit quaternion [x, y, z, w] rotating vector `from` to vector `to`.
 * Handles anti-parallel vectors safely without NaN artifacts.
 */
function quaternionFromTo(from: Vec3, to: Vec3): [number, number, number, number] {
  const lenFrom = Math.hypot(from.x, from.y, from.z) || 1;
  const lenTo = Math.hypot(to.x, to.y, to.z) || 1;
  const ax = from.x / lenFrom;
  const ay = from.y / lenFrom;
  const az = from.z / lenFrom;
  const bx = to.x / lenTo;
  const by = to.y / lenTo;
  const bz = to.z / lenTo;

  const dot = ax * bx + ay * by + az * bz;
  if (dot >= 0.999999) return [0, 0, 0, 1];
  if (dot <= -0.999999) {
    // Find orthogonal axis
    let orthoX = 0;
    let orthoY = -az;
    let orthoZ = ay;
    if (Math.abs(ax) < 0.9) {
      orthoX = 0;
      orthoY = az;
      orthoZ = -ay;
    } else {
      orthoX = -ay;
      orthoY = ax;
      orthoZ = 0;
    }
    const oLen = Math.hypot(orthoX, orthoY, orthoZ) || 1;
    return [orthoX / oLen, orthoY / oLen, orthoZ / oLen, 0];
  }

  // Cross product
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const qw = 1 + dot;
  const qLen = Math.hypot(cx, cy, cz, qw) || 1;
  return [cx / qLen, cy / qLen, cz / qLen, qw / qLen];
}

const JOINT_ORDER = Object.keys(BASE) as JointName[];

export type ExportOptions = {
  /** 'compact' writes flat typed arrays (default). 'verbose' is the old per-joint object layout. */
  layout?: 'compact' | 'verbose';
  /** Decimal places kept (default 3 = millimetre). */
  precision?: number;
  /** Include per-bone quaternions (default true). Omit for position-only pipelines to halve the size. */
  rotations?: boolean;
  /** Include the 33-point 2D image landmarks (default false). */
  landmarks2D?: boolean;
};

const roundTo = (value: number, places: number) => {
  const m = 10 ** places;
  return Math.round(value * m) / m;
};

/**
 * Export in a compact layout. For a 900-frame clip this is roughly
 *   verbose + pretty-print:  ~2.0 MB
 *   compact, 3 dp:          ~260 KB   (8x smaller)
 *   compact, no rotations:  ~130 KB   (15x smaller)
 * Joints are emitted as one flat [x,y,z, x,y,z, ...] array per frame in
 * `jointOrder`, and rotations as one flat [x,y,z,w, ...] array in `boneOrder`.
 */
export function exportAnimation(frames: PoseFrame[], source: string, opts: ExportOptions = {}) {
  const layout = opts.layout ?? 'compact';
  const precision = opts.precision ?? 3;
  const withRot = opts.rotations ?? true;
  const r = (x: number) => roundTo(x, precision);
  const bind = BASE;
  const restDirs = BONES.map(([from, to]) => v(bind[to].x - bind[from].x, bind[to].y - bind[from].y, bind[to].z - bind[from].z));

  if (layout === 'verbose') {
    return {
      format: 'fieldmotion.pose.v1',
      source,
      coordinateSystem: 'right-handed, Y-up, meters',
      note: 'Bone quaternions rotate each bind-pose bone direction to the tracked direction. Apply to matching humanoid bones; calibrate rig rest axes before use.',
      joints: JOINT_ORDER,
      bones: BONES.map(([from, to]) => ({ from, to })),
      frames: frames.map((frame) => ({
        time: r(frame.time),
        confidence: r(frame.confidence),
        rootTranslation: { x: r(frame.joints.pelvis.x), y: r(frame.joints.pelvis.y), z: r(frame.joints.pelvis.z) },
        joints: Object.fromEntries(JOINT_ORDER.map((n) => [n, { x: r(frame.joints[n].x), y: r(frame.joints[n].y), z: r(frame.joints[n].z) }])),
        ...(withRot ? {
          boneRotations: Object.fromEntries(BONES.map(([from, to], bi) => {
            const pose = v(frame.joints[to].x - frame.joints[from].x, frame.joints[to].y - frame.joints[from].y, frame.joints[to].z - frame.joints[from].z);
            return [`${from}_${to}`, quaternionFromTo(restDirs[bi], pose).map(r)];
          })),
        } : {}),
      })),
    };
  }

  return {
    format: 'fieldmotion.pose.v2',
    source,
    coordinateSystem: 'right-handed, Y-up, meters',
    precision,
    note: 'Compact layout. frames[i].j is a flat [x,y,z,...] array in jointOrder; frames[i].q (if present) is a flat [x,y,z,w,...] quaternion array in boneOrder, rotating each bind bone direction to the tracked direction. t = seconds, c = confidence 0..1, h = 1 when the pose was held/interpolated.',
    jointOrder: JOINT_ORDER,
    boneOrder: BONES.map(([from, to]) => [from, to]),
    bindPose: JOINT_ORDER.flatMap((n) => [r(bind[n].x), r(bind[n].y), r(bind[n].z)]),
    frames: frames.map((frame) => {
      const out: Record<string, unknown> = {
        t: r(frame.time),
        c: r(frame.confidence),
        j: JOINT_ORDER.flatMap((n) => [r(frame.joints[n].x), r(frame.joints[n].y), r(frame.joints[n].z)]),
      };
      if (frame.held) out.h = 1;
      if (withRot) {
        out.q = BONES.flatMap(([from, to], bi) => {
          const pose = v(frame.joints[to].x - frame.joints[from].x, frame.joints[to].y - frame.joints[from].y, frame.joints[to].z - frame.joints[from].z);
          return quaternionFromTo(restDirs[bi], pose).map(r);
        });
      }
      if (opts.landmarks2D && frame.landmarks2D) {
        out.l = frame.landmarks2D.flatMap((p) => [roundTo(p.x, 4), roundTo(p.y, 4), roundTo(p.visibility ?? 1, 2)]);
      }
      return out;
    }),
  };
}

/** gzip via the browser's CompressionStream; returns null when unsupported. */
export async function gzipJson(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
