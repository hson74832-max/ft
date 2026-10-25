// FieldMotion v2 JSON importer and sampler for the shared player rig.
import * as THREE from "three";
import { ANIMATION_CATALOGUE, ClipCategory, ClipMeta, SKELETON_CONTRACT } from "./config";
import { Pose, emptyPose } from "./skeleton";

export interface FieldMotionDocument {
  format: "fieldmotion.pose.v2";
  source?: string;
  coordinateSystem?: string;
  precision?: number;
  note?: string;
  jointOrder: string[];
  boneOrder: [string, string][];
  bindPose: number[];
  frames: { t: number; c?: number; h?: number; j: number[]; q?: number[] }[];
  metadata?: Partial<ClipMeta> & { frameEvents?: { t: number; type: string }[] };
}

export interface MotionFrame {
  t: number;
  confidence: number;
  held: boolean;
  pose: Pose;
  root: THREE.Vector3;
}

export interface FieldMotionClip {
  id: string;
  source: string;
  meta: ClipMeta;
  duration: number;
  frames: MotionFrame[];
  events: { t: number; type: string }[];
}

const clips = new Map<string, FieldMotionClip>();

const JOINT_TO_CANONICAL: Record<string, string> = {
  "pelvis->spine": "spine",
  "spine->chest": "chest",
  "chest->neck": "neck",
  "neck->head": "head",
  "chest->leftShoulder": "shoulder.L",
  "leftShoulder->leftElbow": "upperArm.L",
  "leftElbow->leftWrist": "lowerArm.L",
  "chest->rightShoulder": "shoulder.R",
  "rightShoulder->rightElbow": "upperArm.R",
  "rightElbow->rightWrist": "lowerArm.R",
  "leftHip->leftKnee": "upperLeg.L",
  "leftKnee->leftAnkle": "lowerLeg.L",
  "leftAnkle->leftHeel": "foot.L",
  "leftHeel->leftToe": "toe.L",
  "rightHip->rightKnee": "upperLeg.R",
  "rightKnee->rightAnkle": "lowerLeg.R",
  "rightAnkle->rightHeel": "foot.R",
  "rightHeel->rightToe": "toe.R",
};

const ALLOWED_CATEGORIES = new Set<ClipCategory>([
  "locomotion", "turn", "pass", "shoot", "header", "tackle", "gk", "restart", "celebrate", "recover", "control", "idle",
]);

export function parseFieldMotionJSON(sourceText: string, filename = "motion.json", overrideId?: string): FieldMotionClip {
  let doc: FieldMotionDocument;
  try { doc = JSON.parse(sourceText) as FieldMotionDocument; }
  catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`); }

  if (doc.format !== "fieldmotion.pose.v2") throw new Error("Expected format fieldmotion.pose.v2");
  if (!Array.isArray(doc.jointOrder) || !Array.isArray(doc.boneOrder) || !Array.isArray(doc.bindPose) || !Array.isArray(doc.frames) || doc.frames.length < 1) {
    throw new Error("Missing jointOrder, boneOrder, bindPose, or frames");
  }
  if (doc.bindPose.length !== doc.jointOrder.length * 3) throw new Error("bindPose must contain x/y/z for every joint");
  const jointMap = new Map(doc.jointOrder.map((name, i) => [name, i]));
  for (const key of ["pelvis", "leftWrist", "rightWrist", "leftAnkle", "rightAnkle", "leftToe", "rightToe"]) {
    if (!jointMap.has(key)) throw new Error(`jointOrder is missing required joint '${key}'`);
  }

  const source = doc.source || filename;
  const stem = source.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "motion";
  const id = (overrideId || doc.metadata?.id || `motion_${stem}`).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!id) throw new Error("Clip ID is empty after normalization");

  const metadata = doc.metadata ?? {};
  const category = ALLOWED_CATEGORIES.has(metadata.category as ClipCategory) ? metadata.category as ClipCategory : "locomotion";
  const duration = Math.max(0.01, doc.frames[doc.frames.length - 1]?.t ?? 0.01);
  const events = (metadata.frameEvents ?? []).filter((e) => Number.isFinite(e.t) && typeof e.type === "string").map((e) => ({ t: Math.max(0, e.t), type: e.type }));
  const contact = events.find((e) => e.type.toLowerCase() === "ball_contact");
  const contactFrame = typeof metadata.contactFrame === "number" ? metadata.contactFrame : contact ? contact.t / duration : undefined;
  const meta: ClipMeta = {
    id,
    category,
    loop: metadata.loop ?? false,
    rootMotion: metadata.rootMotion ?? false,
    duration: metadata.duration ?? duration,
    speedBand: metadata.speedBand,
    contactFrame,
    interruptible: metadata.interruptible ?? [0.72, 1],
    priority: metadata.priority ?? 5,
    tags: metadata.tags ?? ["fieldmotion-json", ...(contactFrame !== undefined ? ["ball_contact"] : [])],
    description: metadata.description ?? `FieldMotion pose clip: ${source}`,
  };
  if (meta.contactFrame !== undefined && (meta.contactFrame < 0 || meta.contactFrame > 1)) throw new Error("contactFrame must be normalized to 0..1");

  const bindIndex = (name: string) => {
    const i = jointMap.get(name);
    if (i === undefined) throw new Error(`Bone mapping needs joint '${name}'`);
    return i;
  };
  const bindJoint = (name: string) => new THREE.Vector3(
    doc.bindPose[bindIndex(name) * 3], doc.bindPose[bindIndex(name) * 3 + 1], doc.bindPose[bindIndex(name) * 3 + 2],
  );
  const bindPelvis = bindJoint("pelvis");
  const frames: MotionFrame[] = [];
  let previousT = -Infinity;
  for (const [frameIndex, frame] of doc.frames.entries()) {
    if (!Number.isFinite(frame.t) || frame.t < previousT) throw new Error(`frames[${frameIndex}].t must be finite and sorted`);
    previousT = frame.t;
    if (!Array.isArray(frame.j) || frame.j.length !== doc.jointOrder.length * 3) throw new Error(`frames[${frameIndex}].j has the wrong number of coordinates`);
    if (frame.q && frame.q.length !== doc.boneOrder.length * 4) throw new Error(`frames[${frameIndex}].q needs one x/y/z/w quaternion per boneOrder item`);
    const pose = emptyPose();
    for (let boneIndex = 0; boneIndex < doc.boneOrder.length; boneIndex++) {
      const edge = doc.boneOrder[boneIndex];
      const canonical = JOINT_TO_CANONICAL[`${edge[0]}->${edge[1]}`];
      if (!canonical) continue;
      let q: THREE.Quaternion;
      if (frame.q) {
        const i = boneIndex * 4;
        q = new THREE.Quaternion(frame.q[i], frame.q[i + 1], frame.q[i + 2], frame.q[i + 3]).normalize();
      } else {
        const start = frameJoint(frame.j, doc.jointOrder, edge[0]);
        const end = frameJoint(frame.j, doc.jointOrder, edge[1]);
        const bind = bindJoint(edge[1]).sub(bindJoint(edge[0])).normalize();
        const tracked = end.sub(start).normalize();
        q = new THREE.Quaternion().setFromUnitVectors(bind, tracked);
      }
      pose.set(canonical, new THREE.Euler().setFromQuaternion(q, "XYZ"));
    }
    const pelvis = frameJoint(frame.j, doc.jointOrder, "pelvis");
    const root = pelvis.sub(bindPelvis);
    frames.push({ t: frame.t, confidence: frame.c ?? 1, held: frame.h === 1, pose, root });
  }
  if (frames.length < 1) throw new Error("No usable pose frames");
  return { id, source, meta, duration, frames, events };
}

export function registerFieldMotionClip(clip: FieldMotionClip): void {
  if (ANIMATION_CATALOGUE.some((item) => item.id === clip.id)) throw new Error(`Clip ID '${clip.id}' already exists in the built-in catalogue`);
  clips.set(clip.id, clip);
}

export function getFieldMotionClip(id: string): FieldMotionClip | undefined { return clips.get(id); }
export function getRegisteredMotionClips(): FieldMotionClip[] { return [...clips.values()]; }
export function getFieldMotionCatalogue(): ClipMeta[] { return [...clips.values()].map((clip) => clip.meta); }

export function sampleFieldMotion(clip: FieldMotionClip, time: number): { pose: Pose; root: THREE.Vector3; confidence: number; held: boolean } {
  const localTime = clip.meta.loop ? ((time % clip.duration) + clip.duration) % clip.duration : THREE.MathUtils.clamp(time, 0, clip.duration);
  let hi = clip.frames.findIndex((frame) => frame.t >= localTime);
  if (hi < 0) hi = clip.frames.length - 1;
  const lo = Math.max(0, hi - 1);
  const a = clip.frames[lo], b = clip.frames[hi];
  const span = Math.max(0.0001, b.t - a.t);
  const alpha = THREE.MathUtils.clamp((localTime - a.t) / span, 0, 1);
  const pose = emptyPose();
  for (const [name, pa] of a.pose) {
    const pb = b.pose.get(name) ?? pa;
    pose.set(name, new THREE.Euler(
      THREE.MathUtils.lerp(pa.x, pb.x, alpha),
      THREE.MathUtils.lerp(pa.y, pb.y, alpha),
      THREE.MathUtils.lerp(pa.z, pb.z, alpha),
      "XYZ",
    ));
  }
  return {
    pose,
    root: a.root.clone().lerp(b.root, alpha),
    confidence: THREE.MathUtils.lerp(a.confidence, b.confidence, alpha),
    held: alpha < 0.5 ? a.held : b.held,
  };
}

export function validateFieldMotionAgainstSkeleton(clip: FieldMotionClip): string[] {
  const errors: string[] = [];
  const required = SKELETON_CONTRACT.bones.map((bone) => bone.name);
  for (const [index, frame] of clip.frames.entries()) {
    const missing = required.filter((name) => !frame.pose.has(name));
    // A valid source need not author every canonical helper joint, but the sampler always fills the full contract.
    if (missing.length > 0 && frame.pose.size < required.length) {
      for (const name of missing) if (!frame.pose.has(name)) frame.pose.set(name, new THREE.Euler());
    }
    if (frame.t < 0) errors.push(`frame ${index} has negative time`);
  }
  return errors;
}

function frameJoint(values: number[], order: string[], name: string): THREE.Vector3 {
  const index = order.indexOf(name);
  if (index < 0) throw new Error(`Missing joint '${name}'`);
  return new THREE.Vector3(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);
}