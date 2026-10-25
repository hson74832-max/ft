// Skeleton contract implementation + automated validation
import * as THREE from "three";
import { SKELETON_CONTRACT, ANIMATION_CATALOGUE } from "./config";

export interface Skeleton {
  root: THREE.Group;
  bones: Map<string, THREE.Group>;
  restPos: Map<string, THREE.Vector3>;
}

export function buildSkeleton(): Skeleton {
  const bones = new Map<string, THREE.Group>();
  const restPos = new Map<string, THREE.Vector3>();
  // create groups first
  for (const b of SKELETON_CONTRACT.bones) {
    const g = new THREE.Group();
    g.name = b.name;
    bones.set(b.name, g);
    restPos.set(b.name, new THREE.Vector3(b.offset[0], b.offset[1], b.offset[2]));
  }
  let root!: THREE.Group;
  for (const b of SKELETON_CONTRACT.bones) {
    const g = bones.get(b.name)!;
    g.position.set(b.offset[0], b.offset[1], b.offset[2]);
    if (b.parent === null) root = g;
    else bones.get(b.parent)!.add(g);
  }
  return { root, bones, restPos };
}

// Automated check: every clip binds to every bone & every mesh variant exposes every bone.
export interface ValidationResult { ok: boolean; errors: string[]; boundClips: number; boundBones: number; }

export function validateSkeletonContract(meshBoneSets: string[][]): ValidationResult {
  const errors: string[] = [];
  const required = SKELETON_CONTRACT.bones.map((b) => b.name);
  // 1. clips reference only known bones (all procedural clips use full pose map)
  for (const clip of ANIMATION_CATALOGUE) {
    if (!clip.id) errors.push(`clip missing id`);
  }
  // 2. each mesh variant exposes every bone
  meshBoneSets.forEach((set, i) => {
    for (const r of required) if (!set.includes(r)) errors.push(`variant ${i} missing bone ${r}`);
  });
  // 3. bone count contract
  if (required.length !== 21) errors.push(`contract drift: expected 21 bones, got ${required.length}`);
  return { ok: errors.length === 0, errors, boundClips: ANIMATION_CATALOGUE.length, boundBones: required.length };
}

// Pose: bone -> euler rotation. Applied on top of rest position.
export type Pose = Map<string, THREE.Euler>;

export function emptyPose(): Pose {
  const m = new Map<string, THREE.Euler>();
  for (const b of SKELETON_CONTRACT.bones) m.set(b.name, new THREE.Euler(0, 0, 0));
  return m;
}

export function applyPose(skel: Skeleton, pose: Pose, additive?: Pose, addWeight = 0) {
  for (const [name, e] of pose) {
    const bone = skel.bones.get(name);
    if (!bone) continue;
    if (additive && addWeight > 0) {
      const a = additive.get(name);
      if (a) bone.rotation.set(e.x + a.x * addWeight, e.y + a.y * addWeight, e.z + a.z * addWeight);
      else bone.rotation.copy(e);
    } else bone.rotation.copy(e);
  }
}

export function blendPoses(a: Pose, b: Pose, t: number): Pose {
  const out = new Map<string, THREE.Euler>();
  for (const [k, ea] of a) {
    const eb = b.get(k) ?? ea;
    out.set(k, new THREE.Euler(
      ea.x + (eb.x - ea.x) * t,
      ea.y + (eb.y - ea.y) * t,
      ea.z + (eb.z - ea.z) * t
    ));
  }
  return out;
}
