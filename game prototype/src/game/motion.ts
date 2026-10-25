// FieldMotion v2 importer, hierarchy-aware retargeter, sampler and slot registry.
//
// The generator (the `tool` project) exports tracked/synthesised poses as joint
// positions plus per-bone "bind direction -> tracked direction" quaternions in
// WORLD space. The game rig is a parent-child chain of Groups whose rest
// rotations are all identity, so a world quaternion cannot be copied straight
// into a local bone. This module converts the tracked skeleton into LOCAL bone
// rotations by walking the shared 21-bone contract top-down:
//
//   world(bone) = shortestArc(restDirection(bone) -> trackedDirection(bone))
//   local(bone) = inverse(world(parent)) * world(bone)
//
// `restDirection` is each rig's own rest direction, so a generator clip authored
// from an A-pose and a rig whose arms hang straight down still resolve to the
// same world limb directions. Clips can also be bound to a game slot ("sprint",
// "pass_short", ...) so produced animation drives the prototype directly.
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
  metadata?: Partial<ClipMeta> & { frameEvents?: { t: number; type: string }[]; slot?: string; link?: string };
}

/** A whole tracked session / generated animation set in one file. */
export interface FieldMotionPackDocument {
  format: "fieldmotion.pack.v1";
  source?: string;
  generator?: string;
  note?: string;
  clips: FieldMotionDocument[];
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
/** game slot id (built-in catalogue id) -> imported clip id */
const slotBindings = new Map<string, string>();

/**
 * Which tracked joint pair drives which game bone. The source has no hand or toe
 * direction (leaf joints), so those stay at their bind rotation.
 */
export interface BoneMapping { bone: string; from: string; to: string }
export const FIELDMOTION_BONE_MAP: BoneMapping[] = [
  { bone: "spine", from: "pelvis", to: "spine" },
  { bone: "chest", from: "spine", to: "chest" },
  { bone: "neck", from: "chest", to: "neck" },
  { bone: "head", from: "neck", to: "head" },
  { bone: "shoulder.L", from: "chest", to: "leftShoulder" },
  { bone: "upperArm.L", from: "leftShoulder", to: "leftElbow" },
  { bone: "lowerArm.L", from: "leftElbow", to: "leftWrist" },
  { bone: "shoulder.R", from: "chest", to: "rightShoulder" },
  { bone: "upperArm.R", from: "rightShoulder", to: "rightElbow" },
  { bone: "lowerArm.R", from: "rightElbow", to: "rightWrist" },
  { bone: "upperLeg.L", from: "leftHip", to: "leftKnee" },
  { bone: "lowerLeg.L", from: "leftKnee", to: "leftAnkle" },
  { bone: "foot.L", from: "leftAnkle", to: "leftToe" },
  { bone: "upperLeg.R", from: "rightHip", to: "rightKnee" },
  { bone: "lowerLeg.R", from: "rightKnee", to: "rightAnkle" },
  { bone: "foot.R", from: "rightAnkle", to: "rightToe" },
];
const BONE_MAP = new Map(FIELDMOTION_BONE_MAP.map((m) => [m.bone, m]));

/**
 * Rest direction of a game bone: the direction of its first child offset. Bones
 * whose parent chain ends there (head, toe, hand) fall back to +Y, which is only
 * used when a clip actually drives them.
 */
const REST_DIRECTIONS = new Map<string, THREE.Vector3>();
for (const bone of SKELETON_CONTRACT.bones) {
  const child = SKELETON_CONTRACT.bones.find((b) => b.parent === bone.name);
  REST_DIRECTIONS.set(bone.name, child
    ? new THREE.Vector3(child.offset[0], child.offset[1], child.offset[2]).normalize()
    : new THREE.Vector3(0, 1, 0));
}
const HIERARCHY = [...SKELETON_CONTRACT.bones];

/**
 * Retarget world-space joints onto the game rig. Walks the contract in order
 * (parents before children) and writes one LOCAL Euler per driven bone.
 */
export function retargetPoseFromJoints(joint: (name: string) => THREE.Vector3 | undefined): Pose {
  const pose = emptyPose();
  const worldRotation = new Map<string, THREE.Quaternion>();
  const identity = new THREE.Quaternion();
  for (const bone of HIERARCHY) {
    const parentRotation = bone.parent ? worldRotation.get(bone.parent) ?? identity : identity;
    const mapping = BONE_MAP.get(bone.name);
    const from = mapping ? joint(mapping.from) : undefined;
    const to = mapping ? joint(mapping.to) : undefined;
    const tracked = from && to ? to.clone().sub(from) : undefined;
    if (!tracked || tracked.lengthSq() < 1e-8) {
      // Not driven (or a degenerate pair): identity local rotation.
      worldRotation.set(bone.name, parentRotation);
      continue;
    }
    const world = new THREE.Quaternion().setFromUnitVectors(REST_DIRECTIONS.get(bone.name)!, tracked.normalize());
    const local = parentRotation.clone().invert().multiply(world);
    worldRotation.set(bone.name, world);
    pose.set(bone.name, new THREE.Euler().setFromQuaternion(local, "XYZ"));
  }
  return pose;
}

const ALLOWED_CATEGORIES = new Set<ClipCategory>([
  "locomotion", "turn", "pass", "shoot", "header", "tackle", "gk", "restart", "celebrate", "recover", "control", "idle",
]);

export function parseFieldMotionJSON(sourceText: string, filename = "motion.json", overrideId?: string): FieldMotionClip {
  let doc: FieldMotionDocument;
  try { doc = JSON.parse(sourceText) as FieldMotionDocument; }
  catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`); }
  return parseFieldMotionDocument(doc, filename, overrideId);
}

/** Accepts a single `fieldmotion.pose.v2` document or a `fieldmotion.pack.v1` bundle. */
export function parseFieldMotionText(sourceText: string, filename = "motion.json"): FieldMotionClip[] {
  let doc: unknown;
  try { doc = JSON.parse(sourceText); }
  catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`); }
  const format = (doc as { format?: string })?.format;
  if (format === "fieldmotion.pack.v1") {
    const pack = doc as FieldMotionPackDocument;
    if (!Array.isArray(pack.clips) || pack.clips.length === 0) throw new Error("Pack has no clips");
    return pack.clips.map((clip, i) => parseFieldMotionDocument(clip, `${filename}#${i}`));
  }
  return [parseFieldMotionDocument(doc as FieldMotionDocument, filename)];
}

export function parseFieldMotionDocument(doc: FieldMotionDocument, filename = "motion.json", overrideId?: string): FieldMotionClip {
  if (doc.format !== "fieldmotion.pose.v2") throw new Error("Expected format fieldmotion.pose.v2");
  if (!Array.isArray(doc.jointOrder) || !Array.isArray(doc.boneOrder) || !Array.isArray(doc.bindPose) || !Array.isArray(doc.frames) || doc.frames.length < 1) {
    throw new Error("Missing jointOrder, boneOrder, bindPose, or frames");
  }
  if (doc.bindPose.length !== doc.jointOrder.length * 3) throw new Error("bindPose must contain x/y/z for every joint");
  if (!doc.bindPose.every(Number.isFinite)) throw new Error("bindPose contains non-finite coordinates");
  const jointMap = new Map(doc.jointOrder.map((name, i) => [name, i]));
  // Every joint the retargeter reads must exist, otherwise limbs would silently freeze.
  for (const mapping of FIELDMOTION_BONE_MAP) {
    for (const name of [mapping.from, mapping.to]) {
      if (!jointMap.has(name)) throw new Error(`jointOrder is missing required joint '${name}'`);
    }
  }

  const source = doc.source || filename;
  const stem = source.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "motion";
  const id = (overrideId || doc.metadata?.id || `motion_${stem}`).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!id) throw new Error("Clip ID is empty after normalization");

  const metadata = doc.metadata ?? {};
  const category = ALLOWED_CATEGORIES.has(metadata.category as ClipCategory) ? metadata.category as ClipCategory : "locomotion";
  // The document is untrusted JSON wearing a TypeScript costume: every metadata
  // number is re-checked for finiteness here. `typeof x === "number"` is not
  // enough (NaN passes it, and JSON `1e999` parses to Infinity), and a NaN
  // duration/contactFrame would silently wedge the animation controller —
  // normalized time becomes NaN and the ball-contact event never fires.
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const lastT = doc.frames[doc.frames.length - 1]?.t;
  const duration = Math.max(0.01, finite(lastT) ? lastT : 0.01);
  const events = (Array.isArray(metadata.frameEvents) ? metadata.frameEvents : [])
    .filter((e) => !!e && Number.isFinite(e.t) && typeof e.type === "string")
    .map((e) => ({ t: Math.max(0, e.t), type: e.type }));
  const contact = events.find((e) => e.type.toLowerCase() === "ball_contact");
  const contactFrame = finite(metadata.contactFrame) ? metadata.contactFrame : contact ? contact.t / duration : undefined;
  const rawSlot = metadata.slot ?? metadata.link;
  const slot = typeof rawSlot === "string" ? rawSlot : undefined;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const rawWindow = metadata.interruptible;
  const interruptible: [number, number] = Array.isArray(rawWindow) && finite(rawWindow[0]) && finite(rawWindow[1])
    ? [Math.min(clamp01(rawWindow[0]), clamp01(rawWindow[1])), Math.max(clamp01(rawWindow[0]), clamp01(rawWindow[1]))]
    : [0.72, 1];
  const rawBand = metadata.speedBand;
  const speedBand: [number, number] | undefined = Array.isArray(rawBand) && finite(rawBand[0]) && finite(rawBand[1])
    ? [Math.min(rawBand[0], rawBand[1]), Math.max(rawBand[0], rawBand[1])]
    : undefined;
  const meta: ClipMeta = {
    id,
    category,
    loop: metadata.loop === true,
    rootMotion: metadata.rootMotion === true,
    duration: finite(metadata.duration) && metadata.duration > 0 ? metadata.duration : duration,
    speedBand,
    contactFrame,
    interruptible,
    priority: finite(metadata.priority) ? metadata.priority : 5,
    tags: Array.isArray(metadata.tags)
      ? metadata.tags.filter((t): t is string => typeof t === "string")
      : ["fieldmotion-json", ...(contactFrame !== undefined ? ["ball_contact"] : []), ...(slot ? [`slot:${slot}`] : [])],
    description: typeof metadata.description === "string" ? metadata.description : `FieldMotion pose clip: ${source}`,
  };
  if (meta.contactFrame !== undefined && (meta.contactFrame < 0 || meta.contactFrame > 1)) throw new Error("contactFrame must be normalized to 0..1");

  const jointAt = (values: number[], name: string): THREE.Vector3 => {
    const index = jointMap.get(name);
    if (index === undefined) throw new Error(`Missing joint '${name}'`);
    return new THREE.Vector3(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);
  };
  const bindPelvis = jointAt(doc.bindPose, "pelvis");

  const frames: MotionFrame[] = [];
  let previousT = -Infinity;
  for (const [frameIndex, frame] of doc.frames.entries()) {
    if (!Number.isFinite(frame.t) || frame.t < previousT) throw new Error(`frames[${frameIndex}].t must be finite and sorted`);
    previousT = frame.t;
    if (!Array.isArray(frame.j) || frame.j.length !== doc.jointOrder.length * 3) throw new Error(`frames[${frameIndex}].j has the wrong number of coordinates`);
    if (!frame.j.every(Number.isFinite)) throw new Error(`frames[${frameIndex}].j contains non-finite coordinates`);
    if (frame.q && frame.q.length !== doc.boneOrder.length * 4) throw new Error(`frames[${frameIndex}].q needs one x/y/z/w quaternion per boneOrder item`);
    if (frame.q && !frame.q.every(Number.isFinite)) throw new Error(`frames[${frameIndex}].q contains non-finite values`);
    // Joint positions are the authority: they preserve limb lengths and resolve to
    // the rig through the hierarchy, independent of the generator's bind pose.
    const get = (name: string) => jointAt(frame.j, name);
    const pose = retargetPoseFromJoints(get);
    const root = get("pelvis").sub(bindPelvis);
    frames.push({ t: frame.t, confidence: frame.c ?? 1, held: frame.h === 1, pose, root });
  }
  if (frames.length < 1) throw new Error("No usable pose frames");
  return { id, source, meta, duration, frames, events };
}

export function registerFieldMotionClip(clip: FieldMotionClip, opts: { slot?: string } = {}): void {
  if (ANIMATION_CATALOGUE.some((item) => item.id === clip.id)) throw new Error(`Clip ID '${clip.id}' already exists in the built-in catalogue`);
  clips.set(clip.id, clip);
  const slot = opts.slot ?? (clip.meta.tags.find((t) => t.startsWith("slot:"))?.slice(5));
  if (slot) bindFieldMotionClip(slot, clip.id);
}

export function getFieldMotionClip(id: string): FieldMotionClip | undefined { return clips.get(id); }
export function getRegisteredMotionClips(): FieldMotionClip[] { return [...clips.values()]; }
export function getFieldMotionCatalogue(): ClipMeta[] { return [...clips.values()].map((clip) => clip.meta); }

/** Slot ids a produced clip can drive: every built-in clip id. */
export function getMotionSlots(): ClipMeta[] { return ANIMATION_CATALOGUE; }

/**
 * Bind an imported clip to a built-in game slot. Locomotion slots feed the blend
 * space, every other slot replaces that action's procedural pose — so a clip
 * produced by the generator plays in the prototype without code changes.
 */
export function bindFieldMotionClip(slot: string, clipId: string): void {
  const target = ANIMATION_CATALOGUE.find((c) => c.id === slot);
  if (!target) throw new Error(`Unknown game slot '${slot}'`);
  if (!clips.has(clipId)) throw new Error(`Clip '${clipId}' is not registered`);
  slotBindings.set(slot, clipId);
}
export function unbindFieldMotionClip(slot: string): void { slotBindings.delete(slot); }
export function getBoundFieldMotionClip(slot: string): FieldMotionClip | undefined {
  const id = slotBindings.get(slot);
  return id ? clips.get(id) : undefined;
}
export function getSlotBindings(): { slot: ClipMeta; clip: FieldMotionClip }[] {
  const out: { slot: ClipMeta; clip: FieldMotionClip }[] = [];
  for (const [slot, clipId] of slotBindings) {
    const meta = ANIMATION_CATALOGUE.find((c) => c.id === slot);
    const clip = clips.get(clipId);
    if (meta && clip) out.push({ slot: meta, clip });
  }
  return out;
}
export function clearFieldMotionRegistry(): void { clips.clear(); slotBindings.clear(); }

/**
 * Loads the animation pack produced by the motion generator (`tool/src/gameclip.ts`).
 * Every clip carries `metadata.slot`, so registering it binds it to the gameplay action
 * it drives. Already-loaded clips are skipped, which makes this safe to call on startup
 * and again from Motion Lab.
 */
export async function loadGeneratedMotionPack(url = "/motions/game-motion-pack.json"): Promise<FieldMotionClip[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`motion pack HTTP ${response.status}`);
  const parsed = parseFieldMotionText(await response.text(), url.split("/").pop() || "game-motion-pack.json");
  const added: FieldMotionClip[] = [];
  for (const clip of parsed) {
    if (clips.has(clip.id)) continue;
    if (validateFieldMotionAgainstSkeleton(clip).length) continue;
    registerFieldMotionClip(clip);
    added.push(clip);
  }
  return added;
}

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

/**
 * Structural checks before a clip reaches the animation controller: the pose must
 * cover every contract bone (the sampler fills any gap), times must be ordered,
 * and a retargeted pose must stay finite and physically plausible.
 */
export function validateFieldMotionAgainstSkeleton(clip: FieldMotionClip): string[] {
  const errors: string[] = [];
  const required = SKELETON_CONTRACT.bones.map((bone) => bone.name);
  for (const [index, frame] of clip.frames.entries()) {
    for (const name of required) if (!frame.pose.has(name)) frame.pose.set(name, new THREE.Euler());
    if (frame.t < 0) errors.push(`frame ${index} has negative time`);
    if (!Number.isFinite(frame.root.x) || !Number.isFinite(frame.root.y) || !Number.isFinite(frame.root.z)) {
      errors.push(`frame ${index} has a non-finite root translation`);
      break;
    }
    if (Math.abs(frame.root.y) > 1.2 || Math.abs(frame.root.x) > 6 || Math.abs(frame.root.z) > 6) {
      errors.push(`frame ${index} root translation is outside a playable range (${frame.root.x.toFixed(2)}, ${frame.root.y.toFixed(2)}, ${frame.root.z.toFixed(2)})`);
      break;
    }
    for (const [name, euler] of frame.pose) {
      if (!Number.isFinite(euler.x) || !Number.isFinite(euler.y) || !Number.isFinite(euler.z)) {
        errors.push(`frame ${index} bone '${name}' has a non-finite rotation`);
        break;
      }
    }
    if (errors.length) break;
  }
  if (clip.frames.length > 1) {
    const first = clip.frames[0].t, last = clip.frames[clip.frames.length - 1].t;
    if (!(last > first)) errors.push("clip duration must be positive");
  }
  if (!ANIMATION_CATALOGUE.some((c) => c.id === clip.id)) {
    // Imported ids are fine; only built-in ids would collide.
  } else errors.push(`clip id '${clip.id}' collides with a built-in clip`);
  return errors;
}

/**
 * World-space direction of a rig bone after applying a pose. Used by tests and the
 * Motion Lab preview to prove that an imported clip really moves the shared rig
 * (rather than merely being accepted by the parser).
 */
export function rigBoneWorldDirection(pose: Pose, bone: string): THREE.Vector3 {
  const rest = REST_DIRECTIONS.get(bone);
  if (!rest) throw new Error(`unknown bone '${bone}'`);
  const chain: string[] = [];
  let cursor: string | null = bone;
  while (cursor) {
    chain.unshift(cursor);
    // Bound the parent walk: a cyclic skeleton contract must not spin forever.
    if (chain.length > SKELETON_CONTRACT.bones.length) throw new Error(`skeleton parent cycle at '${bone}'`);
    cursor = (SKELETON_CONTRACT.bones.find((b) => b.name === cursor)?.parent ?? null) as string | null;
  }
  const rotation = new THREE.Quaternion();
  for (const name of chain) {
    const e = pose.get(name);
    if (e) rotation.multiply(new THREE.Quaternion().setFromEuler(e));
  }
  return rest.clone().applyQuaternion(rotation).normalize();
}
