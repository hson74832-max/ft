import fs from "node:fs";
import * as THREE from "three";
import { RulesEngine } from "../src/game/rules";
import { SeededRandom, tieBreakHash } from "../src/game/random";
import { AIController, type PlayerStyle, type WorldPlayer, type WorldSnap } from "../src/game/ai";
import { parseFieldMotionJSON, validateFieldMotionAgainstSkeleton, sampleFieldMotion } from "../src/game/motion";
import { CONFIG } from "../src/game/config";
import { stepBallPhysics, kickBall, kickPowerForRange, kickRangeForPower, dragCoefficientAt, type BallState } from "../src/game/ball";
import { CORE_PHYSICS } from "../src/game/physics/parameters";
import { REAL_DATA } from "../src/game/config";
import { passAimDot, passAimIsValid, predictReceiverPosition, resolveNamedReceiver } from "../src/game/passing";
import { passProfile } from "../src/game/match/passPlanning";

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!condition) failures++;
}

// ---------- Rule lifecycle: kickoff -> half-time swap -> full time ----------
const rules = new RulesEngine(1);
const initial = rules.initialKickoffTeam;
const tick = (seconds: number, step = 0.1) => { for (let t = 0; t < seconds; t += step) rules.update(step); };
tick(0.2, 0.1);
check("opening setup created", rules.phase === "SETUP" && rules.pendingRestart?.kind === "kickoff");
check("opening kickoff team honours coin toss", rules.pendingRestart?.team === initial, `team ${rules.pendingRestart?.team}`);
tick(CONFIG.match.setupFreeze + 0.2);
check("kickoff goes live", rules.phase === "INPLAY");
rules.goal(0);
check("goal phase after score", rules.phase === "GOAL" && rules.score[0] === 1);
tick(CONFIG.match.goalCelebrate + 0.2);
check("conceding team restarts after goal", rules.pendingRestart?.kind === "kickoff" && rules.pendingRestart?.team === 1);
tick(CONFIG.match.setupFreeze + 0.2);
tick(rules.halfLength, 0.25);
check("half time reached", rules.phase === "HALFTIME", rules.phase);
check("score preserved at half time", rules.score[0] === 1 && rules.score[1] === 0);
tick(CONFIG.match.halftimePause + 0.2);
check("second half restart set", rules.pendingRestart?.kind === "kickoff");
check("other team kicks off second half", rules.pendingRestart?.team === 1 - initial, `team ${rules.pendingRestart?.team}`);
tick(CONFIG.match.setupFreeze + 0.2);
check("second half live", rules.phase === "INPLAY" && rules.half === 2);
tick(rules.halfLength + 1, 0.25);
check("full time reached", rules.phase === "FULLTIME");
check("clock stops at full time", rules.elapsedClock === "04:00", rules.elapsedClock);
check("half label full time", rules.halfLabel === "FULL TIME");

// ---------- Seed determinism ----------
const a1 = new SeededRandom(1234), a2 = new SeededRandom(1234), b = new SeededRandom(1235);
const seq1 = Array.from({ length: 12 }, () => a1.next());
const seq2 = Array.from({ length: 12 }, () => a2.next());
const seq3 = Array.from({ length: 12 }, () => b.next());
check("same seed reproduces AI stream", seq1.every((v, i) => v === seq2[i]));
check("different seed changes AI stream", seq1.some((v, i) => v !== seq3[i]));
check("tie-break is stable within a seed", tieBreakHash(9, 3, 1, "pass:7") === tieBreakHash(9, 3, 1, "pass:7"));
check("tie-break changes across seeds", tieBreakHash(9, 3, 1, "pass:7") !== tieBreakHash(10, 3, 1, "pass:7"));

// ---------- FieldMotion v2 parser ----------
const sampleText = fs.readFileSync("public/motions/sample_fieldmotion.json", "utf8");
const clip = parseFieldMotionJSON(sampleText, "sample_fieldmotion.json");
const motionErrors = validateFieldMotionAgainstSkeleton(clip);
check("FieldMotion parses", clip.frames.length === 16, `${clip.frames.length} frames`);
check("FieldMotion contact metadata", clip.meta.contactFrame === undefined);
check("FieldMotion validates skeleton coverage", motionErrors.length === 0);
check("FieldMotion samples every canonical bone", sampleFieldMotion(clip, 0.6).pose.size === 21);
check("FieldMotion interpolation is finite", [...sampleFieldMotion(clip, 0.6).pose.values()].every((e) => Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z)));
check("FieldMotion id normalised", clip.id === "motion_sample_celebration", clip.id);

// ---------- Real-measurement physics ----------
const kp = CONFIG.player.kickPower;
check("shot power is a real in-match shot (14–32 m/s)", kp.shoot >= 14 && kp.shoot <= 32, `${kp.shoot} m/s`);
check("short pass speed is real (8–14 m/s)", kp.pass >= 8 && kp.pass <= 14, `${kp.pass} m/s`);
check("long ball speed is real (20–28 m/s)", kp.longPass >= 20 && kp.longPass <= 28, `${kp.longPass} m/s`);
check("sprint speed is pro-real (7.8–10.5 m/s)", CONFIG.player.sprintSpeed >= 7.8 && CONFIG.player.sprintSpeed <= 10.5, `${CONFIG.player.sprintSpeed} m/s`);
check("peak accel is real (4–6.5 m/s²)", CONFIG.player.accel >= 4 && CONFIG.player.accel <= 6.5, `${CONFIG.player.accel}`);
check("peak decel is real (4.5–7 m/s²)", CONFIG.player.decel >= 4.5 && CONFIG.player.decel <= 7, `${CONFIG.player.decel}`);
check("gravity is real 9.81", Math.abs(CONFIG.ball.gravity - 9.81) < 0.01, `${CONFIG.ball.gravity}`);
check("ball is FIFA size/mass", CONFIG.ball.radius >= 0.108 && CONFIG.ball.radius <= 0.111 && CONFIG.ball.mass >= 0.41 && CONFIG.ball.mass <= 0.45);
check("rolling resistance = μ·g", Math.abs(CONFIG.ball.rollingDecel - CONFIG.ball.rollingResistance * CONFIG.ball.gravity) < 1e-6, `${CONFIG.ball.rollingDecel.toFixed(2)} m/s²`);
check("GK decision delay > outfield delay", CONFIG.ai.gkDecisionDelay > CONFIG.ai.reactionDelay);

function freshBall(y = 0.11): BallState {
  return { pos: new THREE.Vector3(0, y, 0), vel: new THREE.Vector3(), spin: new THREE.Vector3() };
}

// Speed-dependent drag (the dataset requires Cd to vary, not be constant).
const cdLow = CORE_PHYSICS.drag_coefficient_low_speed.mean;
const cdHigh = CORE_PHYSICS.drag_coefficient_high_speed.mean;
check("drag is subcritical below 10 m/s (Cd high)", Math.abs(dragCoefficientAt(8) - cdLow) < 1e-6, `${dragCoefficientAt(8)}`);
check("drag is supercritical above 20 m/s (Cd low)", Math.abs(dragCoefficientAt(25) - cdHigh) < 1e-6, `${dragCoefficientAt(25)}`);
check("drag transitions across the crisis", dragCoefficientAt(12) < cdLow && dragCoefficientAt(12) > cdHigh, `${dragCoefficientAt(12).toFixed(3)} at 12 m/s`);

// Sidespin uses real shot-level spin (≈350 rpm → ≈36.7 rad/s).
{
  const s = freshBall();
  kickBall(s, new THREE.Vector3(1, 0, 0), 24, 0.1, 1);
  const rpm = s.spin.length() * 30 / Math.PI;
  check("kick imparts real-order spin (150–650 rpm)", rpm >= 150 && rpm <= 650, `${rpm.toFixed(0)} rpm`);
}

// REAL_DATA reference table is present and self-consistent.
check("REAL_DATA documents full-size goal (OFFICIAL)", REAL_DATA.fullPitch.goalWidthM === 7.32 && REAL_DATA.fullPitch.goalHeightM === 2.44);
check("REAL_DATA sprint threshold 25.2 km/h", REAL_DATA.player.sprintThresholdKmh[0] === 25.2);

// Free-fall time from 2 m must match t = sqrt(2h/g)
{
  const s = freshBall(2.0);
  let t = 0;
  while (s.pos.y > CONFIG.ball.radius && t < 5) { stepBallPhysics(s, 1 / 240); t += 1 / 240; }
  const expected = Math.sqrt(2 * (2.0 - CONFIG.ball.radius) / CONFIG.ball.gravity);
  check("ball drop time matches free-fall", Math.abs(t - expected) < 0.05, `t=${t.toFixed(3)}s expected=${expected.toFixed(3)}s`);
}

// A 25 m/s shot must lose real aero drag: ~18–20 m/s after 1 s of flight
{
  const s = freshBall(10); // high enough to stay airborne for 1 s
  s.vel.set(25, 0, 0);
  for (let i = 0; i < 240; i++) stepBallPhysics(s, 1 / 240);
  check("aero drag slows a 25 m/s shot to ~19 m/s in 1 s", s.vel.x > 15 && s.vel.x < 21, `${s.vel.x.toFixed(1)} m/s`);
}

// Magnus: a sidespun shot must visibly curve sideways
{
  const s = freshBall(10);
  kickBall(s, new THREE.Vector3(1, 0, 0), 25, 0, 1);
  const z0 = s.pos.z;
  for (let i = 0; i < 144; i++) stepBallPhysics(s, 1 / 240); // 0.6 s
  const curve = Math.abs(s.pos.z - z0);
  check("spin produces visible Magnus curve", curve > 0.3, `${curve.toFixed(2)} m in 0.6 s`);
}

// Rolling ball must stop on grass (rolling resistance)
{
  const s = freshBall();
  s.vel.set(6, 0, 0);
  let dist = 0; let stopped = false;
  for (let i = 0; i < 240 * 20; i++) {
    const before = s.pos.x;
    stepBallPhysics(s, 1 / 240);
    dist += Math.abs(s.pos.x - before);
    if (Math.hypot(s.vel.x, s.vel.z) === 0) { stopped = true; break; }
  }
  check("rolling ball stops on grass", stopped && dist < 40, `${dist.toFixed(1)} m`);
}

// Kick speed cap (record shots ≈ 35 m/s)
{
  const s = freshBall();
  kickBall(s, new THREE.Vector3(1, 0, 0), 60, 0);
  check("kick speed is capped at maxSpeed", s.vel.length() <= CONFIG.ball.maxSpeed + 1e-6, `${s.vel.length().toFixed(1)} m/s`);
}

// Ground-pass range calibration must use the same physics as live ball flight.
{
  for (const distance of [4, 8, 14, 22]) {
    const loft = 0.035;
    const power = kickPowerForRange(distance, loft, CONFIG.player.kickPower.longPass, 0.6);
    const range = kickRangeForPower(power, loft);
    check(`pass power is distance-calibrated (${distance} m)`, power <= CONFIG.player.kickPower.longPass && range + 0.5 >= distance && range < distance + 4,
      `power=${power.toFixed(1)} m/s range=${range.toFixed(1)} m`);
  }
}

// Delivery profiles: a long ball has to out-range a short pass. At loft 0.06 the driven
// 24 m/s pass left the ground just enough to bounce (each bounce costs 35% of the
// horizontal speed) and carried 22.2 m — less than an 11 m/s short pass (27.8 m) and
// short of the 27 m the pass scanner is willing to aim at, so every mid-range pass was
// unreachable. Loft is the only free parameter; speed comes from REAL_DATA.
{
  const long = passProfile("pass_long")!;
  const short = passProfile("pass_short")!;
  const longRange = kickRangeForPower(CONFIG.player.kickPower.longPass, long.loft);
  const shortRange = kickRangeForPower(CONFIG.player.kickPower.pass, short.loft);
  check("a long pass out-ranges a short pass", longRange > shortRange + 2,
    `long ${longRange.toFixed(1)} m vs short ${shortRange.toFixed(1)} m`);
  check("a long pass reaches the whole pass-scan window (27 m)", longRange >= 27,
    `max range ${longRange.toFixed(1)} m`);
  // The AI only reaches for the long ball beyond 13 m; that is the band that must be exact.
  for (const distance of [14, 18, 22, 26]) {
    const power = kickPowerForRange(distance, long.loft, CONFIG.player.kickPower.longPass, long.minPower);
    const range = kickRangeForPower(power, long.loft);
    check(`long pass is power-calibrated to ${distance} m`, range + 0.5 >= distance && range < distance + 4,
      `power=${power.toFixed(1)} m/s range=${range.toFixed(1)} m`);
  }
}

// Shot from the edge of the box arrives under the bar (y < goalHeight)
{
  const s = freshBall();
  kickBall(s, new THREE.Vector3(1, 0, 0), kp.shoot, 0.14);
  let maxY = 0; let t = 0;
  while (t < 3) {
    stepBallPhysics(s, 1 / 240);
    t += 1 / 240;
    if (s.pos.x > 16 && s.pos.x < 20.2) maxY = Math.max(maxY, s.pos.y);
  }
  check("shot from 16 m stays under the bar", maxY > 0 && maxY < CONFIG.pitch.goalHeight, `maxY at goal=${maxY.toFixed(2)} m`);
}

// ---------- Named receiver pass invariant ----------
{
  const passer = { idx: 0, team: 0, role: "MID", pos: new THREE.Vector3(0, 0, 0), vel: new THREE.Vector3() };
  const receiver = { idx: 1, team: 0, role: "FWD", pos: new THREE.Vector3(12, 0, 2), vel: new THREE.Vector3(4, 0, 0) };
  const opponent = { idx: 2, team: 1, role: "DEF", pos: new THREE.Vector3(8, 0, 1), vel: new THREE.Vector3() };
  const actors = [passer, receiver, opponent];
  check("named pass resolves same-team receiver", resolveNamedReceiver(actors, passer, receiver.idx) === receiver);
  check("named pass rejects opponent receiver", resolveNamedReceiver(actors, passer, opponent.idx) === null);
  check("named pass rejects missing receiver", resolveNamedReceiver(actors, passer, undefined) === null);
  const predicted = predictReceiverPosition(receiver.pos, receiver.vel, 1.2, CONFIG.player.sprintSpeed, {
    halfLength: CONFIG.pitch.length / 2, halfWidth: CONFIG.pitch.width / 2, buffer: CONFIG.ai.outPlaySafetyMargin,
  });
  const origin = new THREE.Vector3(0, CONFIG.ball.radius, 0);
  const dir = predicted.clone().sub(origin).setY(0).normalize();
  const launchVelocity = new THREE.Vector3(dir.x * 10, 0.25, dir.z * 10);
  const alignedDot = passAimDot(origin, launchVelocity, predicted);
  check("planned pass points at the named predicted receiver", passAimIsValid(alignedDot, CONFIG.ai.passAimConeDegrees), `dot=${alignedDot.toFixed(4)}`);
  const badVelocity = new THREE.Vector3(0, 0, 10);
  check("pass aim rejects a vector pointed away from receiver", !passAimIsValid(passAimDot(origin, badVelocity, predicted), CONFIG.ai.passAimConeDegrees));
}

// ---------- AI awareness ----------
const style: PlayerStyle = { directness: 1, width: 1, risk: 1, carry: 1, shooting: 1, pressing: 1, support: 1, creativity: 1, finesseSide: 1 };
function player(idx: number, team: number, role: string, roleIdx: number, x: number, z: number): WorldPlayer {
  return {
    idx, team, role, roleIdx, pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(), facing: team === 0 ? 0 : Math.PI,
    speed: 3, busy: false, uninterruptible: false, cooldowns: new Map(), stamina: 1, hasBall: false,
    callForBall: false, isHuman: false, runSerial: 0, style: { ...style },
  };
}
function snapWithCarrier(): WorldSnap {
  const players = [
    player(0, 0, "GK", 0, -18, 0), player(1, 0, "DEF", 1, -8, -5), player(2, 0, "DEF", 2, -8, 5),
    player(3, 0, "MID", 3, -1, 0), player(4, 0, "FWD", 4, 8, 0),
    player(5, 1, "GK", 0, 18, 0), player(6, 1, "DEF", 1, 7, -4), player(7, 1, "DEF", 2, 7, 4),
    player(8, 1, "MID", 3, 2, 0), player(9, 1, "FWD", 4, -3, 2),
  ];
  players[4].hasBall = true;
  return { ballPos: new THREE.Vector3(8, 0.11, 0), ballVel: new THREE.Vector3(0, 0, 0), ballOwner: 4, ballOwnerTeam: 0, players, time: 30, half: 1, matchSeed: 42 };
}
const ai = new AIController(new SeededRandom(42), 42);
const snap = snapWithCarrier();
const def6 = snap.players[6];
const decision = ai.think(def6, 1, snap, 30);
const partner = ai.think(snap.players[7], 2, snap, 30);
check("nearest centre-back steps out", /STEP/.test(decision.reason) && decision.utilities.step === 1, decision.reason);
check("partner centre-back pinches the shooting lane", /COVER/.test(partner.reason) && Math.abs(partner.moveTarget.z) < 4, partner.reason);
check("offside identifies run beyond second-last defender", (() => {
  const off = snap.players[4].pos.clone().setX(16);
  snap.players[6].pos.setX(11); snap.players[7].pos.setX(9);
  return ai.isOffsidePosition(off, new THREE.Vector3(8, 0, 0), 0, snap);
})());
check("onside run behind ball is accepted", !ai.isOffsidePosition(new THREE.Vector3(4, 0, 2), new THREE.Vector3(8, 0, 0), 0, snap));
const support = ai.think(snap.players[3], 3, snap, 31);
check("supporters avoid the carrier's channel", support.moveTarget.distanceTo(snap.ballPos) > 0.5, support.reason);

// ---------- Variety across seeds, determinism within a seed ----------
function decisionSignature(seed: number): string {
  const controller = new AIController(new SeededRandom(seed), seed);
  const world = snapWithCarrier();
  world.matchSeed = seed;
  world.players.forEach((p) => { p.style = controller.sampleStyle(p.role); });
  // A balanced midfield situation should vary; an obvious open shot should NOT be
  // turned into a bad pass just to make a different seed produce a different label.
  world.players[4].pos.set(-4, 0, 0); world.ballPos.copy(world.players[4].pos);
  world.players[3].pos.set(3, 0, -6); world.players[2].pos.set(3, 0, 6);
  return JSON.stringify(world.players.filter((p) => p.team === 0 && p.role !== "GK").map((p) => {
    const d = controller.think(p, p.roleIdx, world, 40);
    return { action: d.action, receiver: d.passTo, target: d.moveTarget.toArray(), aim: d.actionTarget?.toArray() };
  }));
}
check("same seed yields identical decisions", decisionSignature(77) === decisionSignature(77));
const sampledStyles = (seed: number) => {
  const controller = new AIController(new SeededRandom(seed), seed);
  return JSON.stringify(["DEF", "MID", "FWD"].map((role) => controller.sampleStyle(role)));
};
check("match seed changes the player style cohort", sampledStyles(77) !== sampledStyles(78));
// Actual trajectory divergence/replay is asserted by support-match.ts, not by
// requiring two seeds to disagree about one obvious tactical situation.
let namedAIPassSeen = false;
for (let seed = 10; seed < 35; seed++) {
  const controller = new AIController(new SeededRandom(seed), seed);
  const match = snapWithCarrier();
  match.ballPos.set(0, CONFIG.ball.radius, 0);
  match.players[4].pos.set(0, 0, 0);
  match.players[3].pos.set(4, 0, -7); match.players[3].vel.set(1, 0, 0);
  match.players[1].pos.set(-7, 0, -8); match.players[2].pos.set(-7, 0, 8);
  match.players[6].pos.set(5, 0, -3); match.players[7].pos.set(7, 0, 4); match.players[8].pos.set(2, 0, 1); match.players[9].pos.set(-4, 0, 2);
  match.players[4].style.carry = 0.1; match.players[4].style.shooting = 0.7;
  const decision = controller.think(match.players[4], 4, match, seed);
  if (seed === 10) console.log("pass fixture decision:", decision.reason, decision.utilities);
  if (decision.action && ["pass_short", "pass_long", "pass_through"].includes(decision.action)) {
    namedAIPassSeen = true;
    const target = decision.passTo === undefined ? null : match.players[decision.passTo];
    check(`AI pass has named teammate (seed ${seed})`, !!target && target.team === match.players[4].team && target.idx !== match.players[4].idx);
  }
}
check("AI can choose a same-team pass decision in seeded situations", namedAIPassSeen);

// ---------- Ball reception & standing tackle resolution ----------
{
  const testTaker = player(1, 0, "MID", 1, 0, 0);
  const testCarrier = player(6, 1, "MID", 1, 1.2, 0);
  const tackleReach = CONFIG.player.tackleRadius + 0.75;
  const inReach = testCarrier.pos.distanceTo(testTaker.pos) < tackleReach;
  check("standing tackle reach extends to lunging foot distance", inReach && tackleReach >= 2.0);
}

console.log("seed 77:", decisionSignature(77));
console.log("seed 78:", decisionSignature(78));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
if (failures > 0) process.exit(1);
