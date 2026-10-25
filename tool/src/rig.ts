// Shared field skeleton: joint names, bone topology and the bind pose.
// Kept free of browser and MediaPipe imports so the same module can drive the
// browser studio and the headless clip generator.

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

const v = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

/**
 * Bind pose in metres, right-handed Y-up, +Z forward. The generator's forward
 * kinematics rotate these bone offsets, so a clip is defined by joint angles rather
 * than by absolute positions and limb lengths stay constant by construction.
 */
export const BASE: Joints = {
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

export const JOINT_ORDER = Object.keys(BASE) as JointName[];

/** Parent -> children for forward kinematics. */
export const BONE_TREE: Record<JointName, JointName[]> = (() => {
  const tree = Object.fromEntries(JOINT_ORDER.map((name) => [name, [] as JointName[]])) as Record<JointName, JointName[]>;
  for (const [from, to] of BONES) if (!tree[from].includes(to)) tree[from].push(to);
  return tree;
})();

/** Root of the skeleton (the only joint without a parent bone). */
export const ROOT_JOINT: JointName = 'pelvis';
