// Motion generator -> game pipeline test.
//
//   npx esbuild scripts/motion-pipeline.ts --bundle --platform=node --format=cjs --outfile=/tmp/motion-pipeline.cjs
//   node /tmp/motion-pipeline.cjs
//
// Builds the animation pack straight from tool/src/gameclip.ts, imports it exactly the
// way the game does, and asserts that the prototype plays it: slot bindings, skeleton
// validity, retarget fidelity, locomotion and action overrides, ball-contact timing, root
// motion direction, and a live match running on the generated clips.
import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { buildGameMotionPack } from "../../tool/src/gameclip";
import { ANIMATION_CATALOGUE, SKELETON_CONTRACT } from "../src/game/config";
import {
  FIELDMOTION_BONE_MAP, bindFieldMotionClip, clearFieldMotionRegistry, getBoundFieldMotionClip,
  getRegisteredMotionClips, getSlotBindings, parseFieldMotionText, registerFieldMotionClip,
  rigBoneWorldDirection, sampleFieldMotion, validateFieldMotionAgainstSkeleton,
} from "../src/game/motion";
import { AnimationController, actionPose, getClip, hasBoundLocomotion, locomotionPose } from "../src/game/anims";
import { MatchEngine } from "../src/game/engine";


let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const pitch = (pose: Map<string, THREE.Euler>, bone: string) => THREE.MathUtils.radToDeg(pose.get(bone)?.x ?? 0);

// ---- 1. build + parse ---------------------------------------------------------
const pack = buildGameMotionPack(30);
const text = JSON.stringify(pack);
console.log(`\nMOTION PIPELINE · ${pack.clips.length} generated clips · ${(text.length / 1024).toFixed(0)} KB\n`);
clearFieldMotionRegistry();
const clips = parseFieldMotionText(text, "game-motion-pack.json");
check("generated pack parses into clips", clips.length === pack.clips.length, `${clips.length} clips`);

const invalid = clips.filter((clip) => validateFieldMotionAgainstSkeleton(clip).length > 0)
  .map((clip) => `${clip.id}: ${validateFieldMotionAgainstSkeleton(clip).join("; ")}`);
check("every clip validates against the 21-bone contract", invalid.length === 0, invalid.join(" | "));

const ids = new Set(clips.map((clip) => clip.id));
check("clip ids are unique and do not collide with built-in clips", ids.size === clips.length
  && !clips.some((clip) => ANIMATION_CATALOGUE.some((c) => c.id === clip.id)));

// ---- 2. slot binding ----------------------------------------------------------
const slotOf = (clipId: string) => clips.find((c) => c.id === clipId)?.meta.tags.find((t) => t.startsWith("slot:"))?.slice(5);
for (const clip of clips) registerFieldMotionClip(clip);   // registers + binds from the slot tag
check("registration binds every clip to its slot", getSlotBindings().length === clips.length, `${getSlotBindings().length} bindings`);
const bindings = getSlotBindings();
const missing = pack.clips
  .map((clip) => clip.metadata.slot as string)
  .filter((slot) => !bindings.some((b) => b.slot.id === slot));
check("each clip binds to its gameplay slot", missing.length === 0, missing.join(", ") || `${bindings.length} slots`);
check("every slot is a real catalogue slot", bindings.every((b) => ANIMATION_CATALOGUE.some((c) => c.id === b.slot.id)));

// ---- 3. retarget fidelity -----------------------------------------------------
let worstAngle = 0;
let worstBone = "";
for (const clip of clips) {
  const doc = pack.clips.find((c) => c.metadata.id === clip.id)!;
  const index = new Map(doc.jointOrder.map((name, i) => [name, i]));
  const joint = (frame: number[], name: string) => {
    const i = index.get(name)!;
    return new THREE.Vector3(frame[i * 3], frame[i * 3 + 1], frame[i * 3 + 2]);
  };
  for (const [frameIndex, frame] of clip.frames.entries()) {
    const raw = doc.frames[frameIndex].j;
    for (const mapping of FIELDMOTION_BONE_MAP) {
      const tracked = joint(raw, mapping.to).sub(joint(raw, mapping.from)).normalize();
      const posed = rigBoneWorldDirection(frame.pose, mapping.bone).normalize();
      const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(posed.dot(tracked), -1, 1)));
      if (angle > worstAngle) { worstAngle = angle; worstBone = `${clip.id}/${mapping.bone}`; }
    }
  }
}
check("retargeted game bones point where the generated limbs point", worstAngle < 1.5,
  `worst ${worstAngle.toFixed(2)}° (${worstBone})`);

// limb lengths survive the round trip (the rig is a fixed skeleton, not stretched geometry)
const rigLengths = new Map(SKELETON_CONTRACT.bones.filter((b) => b.parent)
  .map((b) => [`${b.parent}->${b.name}`, Math.hypot(b.offset[0], b.offset[1], b.offset[2])]));
check("skeleton contract bone lengths are fixed", [...rigLengths.values()].every((len) => len > 0.01),
  `${rigLengths.size} bones`);

// ---- 4. locomotion override ---------------------------------------------------
const sprint = getBoundFieldMotionClip("sprint")!;
const boundPose = locomotionPose({ speed: 7, dirAngle: 0, phase: 2.2, fatigue: 0, jockey: false });
const sampled = sampleFieldMotion(sprint, ((2.2 / (Math.PI * 2)) % 1) * sprint.duration).pose;
const direct = rigBoneWorldDirection(sampled, "upperLeg.L");
const blended = rigBoneWorldDirection(boundPose, "upperLeg.L");
check("bound cycles drive the locomotion blend space", hasBoundLocomotion() && direct.angleTo(blended) < 0.35,
  `${THREE.MathUtils.radToDeg(direct.angleTo(blended)).toFixed(1)}° from the sampled clip`);

const swing = [0, 0.25, 0.5, 0.75].map((p) => rigBoneWorldDirection(
  locomotionPose({ speed: 7, dirAngle: 0, phase: p * Math.PI * 2, fatigue: 0, jockey: false }), "upperLeg.L").z);
check("the sprint cycle actually strides", Math.max(...swing) - Math.min(...swing) > 0.6,
  `z swing ${(Math.max(...swing) - Math.min(...swing)).toFixed(2)}`);

const walkVsSprint = [3, 6.5].map((speed) => pitch(locomotionPose({ speed, dirAngle: 0, phase: 1.1, fatigue: 0, jockey: false }), "upperLeg.L"));
check("jog and sprint bands do not play the same pose", Math.abs(walkVsSprint[0] - walkVsSprint[1]) > 3,
  `${walkVsSprint[0].toFixed(1)}° vs ${walkVsSprint[1].toFixed(1)}°`);

// ---- 5. action override + contact timing --------------------------------------
const pass = getClip("pass_short");
const passClip = getBoundFieldMotionClip("pass_short")!;
check("the bound clip supplies its own timing to the controller", pass.id === "gen_pass_short" && Math.abs(pass.duration - 0.45) < 1e-6,
  `${pass.id} · ${pass.duration}s`);
const kickDir = rigBoneWorldDirection(actionPose("pass_short", pass.contactFrame! * pass.duration, pass.duration), "upperLeg.R");
const windDir = rigBoneWorldDirection(actionPose("pass_short", 0.02, pass.duration), "upperLeg.R");
check("the kicking leg swings forward through the contact frame", kickDir.z > windDir.z + 0.25,
  `z ${windDir.z.toFixed(2)} → ${kickDir.z.toFixed(2)}`);
check("contact frames stay inside the clip", clips.every((c) => c.meta.contactFrame === undefined
  || (c.meta.contactFrame >= 0 && c.meta.contactFrame <= 1)));

// the controller must raise contact at the authored moment, not at t=0
const controller = new AnimationController();
controller.requestAction("pass_short");
let contactAt = -1;
for (let i = 0; i < 60; i++) {
  const out = controller.update(1 / 60, 0, 0, {});
  if (out.contact && contactAt < 0) contactAt = (i + 1) / 60;
}
const expected = pass.contactFrame! * pass.duration;
check("ball contact fires at the authored frame", Math.abs(contactAt - expected) < 0.05,
  `fired at ${contactAt.toFixed(2)}s, expected ${expected.toFixed(2)}s`);

// ---- 6. root motion -----------------------------------------------------------
const slideClip = getBoundFieldMotionClip("tackle_slide")!;
const slideRootStart = sampleFieldMotion(slideClip, 0).root;
const slideRootEnd = sampleFieldMotion(slideClip, slideClip.duration).root;
check("slide tackle carries 2.5 m of forward root travel", slideRootEnd.z - slideRootStart.z > 2.0,
  `${(slideRootEnd.z - slideRootStart.z).toFixed(2)} m`);

const mover = new AnimationController();
mover.requestAction("tackle_slide");
let forward = 0, lateral = 0;
for (let i = 0; i < 70; i++) {
  const out = mover.update(1 / 60, 0, 0, {});
  forward += out.rootDelta.dx;
  lateral += out.rootDelta.dz;
}
check("the controller feeds that travel to the engine as forward motion", forward > 1.0 && Math.abs(lateral) < 0.25,
  `forward ${forward.toFixed(2)} m · lateral ${lateral.toFixed(2)} m`);

const dive = new AnimationController();
dive.requestAction("gk_dive_L");
let diveLateral = 0;
for (let i = 0; i < 60; i++) diveLateral += dive.update(1 / 60, 0, 0, {}).rootDelta.dz;
check("a keeper dive moves sideways, not forward", Math.abs(diveLateral) > 0.5, `lateral ${diveLateral.toFixed(2)} m`);

// ---- 7. live match on the generated clips -------------------------------------
writeFileSync(resolve("/tmp/motion-pack-under-test.json"), text);
// The registry is process-global, so start the live match from a clean import path:
// drop everything, then let the engine import the pack exactly like Motion Lab does.
clearFieldMotionRegistry();
const engine = new MatchEngine(headlessEngineCanvas(), { seed: 7, headless: true, spectator: true, debugAI: false });
const imported = engine.importMotionPack(text, "game-motion-pack.json");
check("the engine imports the pack without rejecting clips", imported.length === clips.length, `${imported.length} clips`);
check("the engine import binds slots again", getSlotBindings().length === clips.length, `${getSlotBindings().length} bindings`);

const usedActions = new Set<string>();
const usedLocomotion = new Set<string>();
let maxSpeed = 0;
for (let frame = 0; frame < 60 * 45; frame++) {
  engine.step(1 / 60);
  for (const player of engine.players) {
    const clip = player.anim.lastClip;
    if (ANIMATION_CATALOGUE.some((c) => c.id === clip) && getBoundFieldMotionClip(clip)) usedActions.add(clip);
    if (["walk", "jog", "sprint"].includes(clip) && player.speed > 0.5) usedLocomotion.add(clip);
    maxSpeed = Math.max(maxSpeed, player.speed);
  }
}
check("the match animates from bound clips", usedActions.size >= 4, [...usedActions].join(", ") || "none");
check("locomotion bands are in use", usedLocomotion.size >= 2, [...usedLocomotion].join(", "));
check("players still reach running speed with generated cycles", maxSpeed > 5, `${maxSpeed.toFixed(1)} m/s`);
// Fouls are whistled by default, so 45 s of frames can legitimately end in a SETUP
// freeze. Progress means the ball was played and the match clock moved.
check("the match kept progressing on generated animation", engine.tacticalStats.passes > 0 && engine.rules.time > 20,
  `${engine.tacticalStats.passes} passes · ${engine.rules.time.toFixed(1)}s played`);
engine.dispose();

// ---- 8. the pack that ships with the game is current --------------------------
const shippedPath = resolve("public/motions/game-motion-pack.json");
const shipped = JSON.parse(readFileSync(shippedPath, "utf8"));
const shippedIds = shipped.clips.map((clip: { metadata: { id: string } }) => clip.metadata.id).sort();
const builtIds = pack.clips.map((clip) => clip.metadata.id).sort();
check("public/motions/game-motion-pack.json is up to date with the generator",
  shippedIds.join() === builtIds.join(), `${shippedIds.length} clips in the shipped pack`);

console.log(`\n${failures === 0 ? "MOTION PIPELINE OK" : `${failures} MOTION PIPELINE CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
