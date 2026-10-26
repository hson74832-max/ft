/**
 * Referee + ball-boundary regressions.
 *
 * Covers the fixes and laws in this pass:
 *   1. every kickoff is announced exactly once (opening, post-goal, second half)
 *   2. the match clock is zero-padded
 *   3. the AI debug trace keeps the specific reason an action did not start
 *   4. a goalkeeper must release the ball within the hold limit
 *   5. the keeper's pressure read prefers the nearest body, not a distant sprinter
 *   6. foul grading: yellow for a reckless challenge, blue on the second yellow,
 *      a 60 s exclusion off the pitch, and the return when it expires
 *   7. advantage: the whistle stays down while the fouled side keeps a usable ball
 *   8. a dribbled ball never leaves the field (glue + clamp + ball radius margin)
 *   9. AI aim points — including restart deliveries — are clamped inside the pitch
 *
 * Run: npm run verify:referee
 */
import { headlessEngineCanvas } from "./harness"; // installs the headless DOM shim on import
import assert from "node:assert/strict";
import * as THREE from "three";
import { MatchEngine } from "../src/game/engine";
import { RulesEngine } from "../src/game/rules";
import { CONFIG } from "../src/game/config";
import { AnimationController } from "../src/game/anims";
import { startAction } from "../src/game/match/actions";
import { onContact } from "../src/game/match/contacts";
import { aiControl } from "../src/game/match/control";
import { buildWorldSnap } from "../src/game/match/frame";
import { isOffPitch, blueCardRemaining } from "../src/game/match/referee";
import { releaseRestartToTaker, sampleRestartTarget } from "../src/game/match/restarts";
import { SeededRandom } from "../src/game/random";
import { decayTackleTimers } from "../src/game/match/tackles";
import { predictReceiverRun } from "../src/game/passing";
import { evaluateGkDistribution } from "../src/game/match/passPlanning";
import { outGoalCheck } from "../src/game/match/possession";
import type { EnginePlayer } from "../src/game/match/types";

let count = 0;
function test(name: string, check: () => void) {
  check();
  console.log(`PASS ${name}`);
  count++;
}

function fresh(seed = 700): MatchEngine {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
  engine.rules.phase = "INPLAY";
  engine.rules.pendingRestart = null;
  engine.rules.time = 0;
  engine.clock = 10;
  for (const p of engine.players) {
    // Park everyone inside the pitch but out of each other's way.
    p.pos.set(-18 + (p.idx % 5) * 1.2, 0, p.idx < 5 ? -10.5 : 10.5);
    p.vel.set(0, 0, 0);
    p.moveTarget.copy(p.pos);
    p.facing = 0; p.speed = 0; p.stamina = 1;
    p.holdT = 0; p.stumbleT = 0;
    p.tackleRecoveryT = 0; p.tackleProtectionT = 0; p.tackleChallenge = null;
    p.pendingKick = null; p.restartTaker = false; p.callForBall = false;
    p.yellowCards = 0; p.blueCardUntil = 0; p.foulsConceded = 0;
    p.anim = new AnimationController();
  }
  engine.ball.release();
  engine.ball.handsRestrictedTeam = null;
  engine.ball.lastTouch = null;
  engine.ball.lastTouchTeam = null;
  engine.ball.kickedBy = null;
  engine.ball.kickAge = 99;
  return engine;
}

// ---------------------------------------------------------------- kickoffs ---
test("the opening kickoff is announced exactly once (no duplicate)", () => {
  const rules = new RulesEngine(0);
  // Nothing is announced by the constructor: the staging announces the opening kickoff.
  assert.equal(rules.events.filter((ev) => ev.type === "KICKOFF").length, 0);
  rules.update(0.1);
  const kickoffs = rules.events.filter((ev) => ev.type === "KICKOFF");
  assert.equal(kickoffs.length, 1, `one opening KICKOFF event, got ${kickoffs.length}`);
  assert.match(kickoffs[0].detail, /Match initialised/);
  assert.equal(rules.kickoffs, 1);
  // Re-staging the same phase must not announce again (the phase moved to SETUP).
  rules.update(0.1);
  assert.equal(rules.events.filter((ev) => ev.type === "KICKOFF").length, 1);
});

test("a kickoff after a goal is announced (the silent-kickoff bug)", () => {
  const rules = new RulesEngine(1);
  rules.update(0.1);
  rules.setupT = 0; rules.update(0.05);          // opening kickoff goes live
  assert.equal(rules.phase, "INPLAY");
  // Run a little playing time so the clock is far from zero, then score.
  for (let i = 0; i < 120; i++) rules.update(1 / 60);
  assert(rules.time > 1.5, "play should have advanced the match clock");
  rules.goal(0);
  rules.update(CONFIG.match.goalCelebrate + 0.1);
  assert.equal(rules.pendingRestart?.kind, "kickoff");
  const kickoffs = rules.events.filter((ev) => ev.type === "KICKOFF");
  assert.equal(kickoffs.length, 2, "opening + post-goal kickoff must both announce");
  assert.equal(rules.pendingRestart?.team, 1, "the conceding team restarts");
  assert.match(kickoffs[1].detail, /kickoff → team BLUE/);
});

test("the second-half kickoff is announced with a frozen clock", () => {
  const rules = new RulesEngine(0);
  rules.update(0.1);
  rules.setupT = 0; rules.update(0.05);
  // Play the whole first half; the clock freezes during every restart staging.
  for (let i = 0; i < 60 * 200 && rules.half === 1; i++) rules.update(0.05);
  assert.equal(rules.half, 2, "half time reached");
  rules.setupT = 0; rules.update(0.05);
  assert.equal(rules.pendingRestart?.kind, "kickoff");
  const kickoffs = rules.events.filter((ev) => ev.type === "KICKOFF");
  assert.equal(kickoffs.length, 2, "opening + second-half kickoff must both announce");
  assert.equal(rules.pendingRestart?.team, 1, "sides swap: the other team restarts");
});

test("the match clock is zero-padded", () => {
  const rules = new RulesEngine(0);
  assert.equal(rules.clock, "04:00");
  rules.time = CONFIG.match.totalSeconds - 45;
  assert.equal(rules.clock, "00:45", `got ${rules.clock}`);
  rules.time = CONFIG.match.totalSeconds - 5;
  assert.equal(rules.clock, "00:05", `got ${rules.clock}`);
  assert.equal(rules.elapsedClock, "03:55");
});

// ------------------------------------------------------------ debug trace ---
test("the AI trace keeps the specific reason an action did not start", () => {
  const e = fresh(701);
  e.debugAI = true; // the trace table is only populated with ?debug=ai
  const p = e.players[4]; // RED forward
  assert.equal(p.role, "FWD");
  e.foulsOn = false;
  e.ball.possess(p.idx, p.team);
  p.pos.set(0, 0, 0);
  p.vel.set(4, 0, 0); p.speed = 4; p.facing = 0; // running away from the target
  e.ball.pos.set(0.48, CONFIG.ball.radius, 0);
  e.ai.resetDecisions();
  const snap = buildWorldSnap(e);
  e.ball.release(); // free ball, so startAction cannot be blocked by ownership rules
  // Force a decision that needs the body to turn first: a long pass behind him.
  const decision = {
    moveTarget: p.pos.clone(), desiredSpeed: 0, action: "pass_long",
    actionTarget: new THREE.Vector3(-15, 0, 0), passTo: undefined,
    reason: "test decision", utilities: {}, urgent: false,
  };
  e.ai.think = () => decision as never;
  e.aiTrace.clear();
  e.aiTrace.set(p.idx, {
    idx: p.idx, team: p.team, role: p.role, hasBall: true, branch: "ai",
    thinkCalled: false, thinkFresh: false, decisionReason: "", actionReturned: null,
    startActionResult: "n/a", animBusy: false, animUninterruptible: false, animActionId: null,
    moveTarget: "", desiredSpeed: 0, speed: p.speed, overwrittenBy: "",
  });
  aiControl(e, p, 1 / 60, snap, true, false);
  const tr = e.aiTrace.get(p.idx)!;
  assert.equal(tr.startActionResult, "skipped:turning-to-face",
    `the generic label must not overwrite the real cause, got "${tr.startActionResult}"`);
  e.dispose();
});

// ------------------------------------------------------- goalkeeper limits ---
test("a goalkeeper cannot hold the ball past the hold limit", () => {
  const e = fresh(702);
  const gk = e.players[0];
  assert.equal(gk.role, "GK");
  // A teammate exists so the forced clearance has a legal target; everyone else
  // is parked at the far end so nothing else can take the ball off the keeper.
  const mate = e.players[4];
  mate.pos.set(-8, 0, 0);
  for (const p of e.players) {
    if (p.idx === gk.idx || p.idx === mate.idx) continue;
    p.pos.set(17, 0, p.team === 0 ? -10.5 : 10.5);
    p.moveTarget.copy(p.pos);
  }
  gk.pos.set(-18, 0, 0);
  gk.moveTarget.copy(gk.pos);
  // The AI "chooses" to keep holding: the law, not the AI, has to release it.
  e.ai.think = () => ({ moveTarget: gk.pos.clone(), desiredSpeed: 0, action: null, reason: "test hold", utilities: {}, urgent: false }) as never;
  e.ball.possess(gk.idx, gk.team);
  e.ball.pos.set(gk.pos.x, CONFIG.ball.radius, gk.pos.z);
  const dt = 1 / 60;
  const limit = CONFIG.ai.gkHoldLimit;
  assert.equal(limit, 8, "the keeper is given 8 seconds");
  let releasedAt = -1, speedAtRelease = 0;
  for (let i = 0; i < 60 * 12; i++) {
    e.step(dt);
    if (releasedAt < 0 && e.ball.possessedBy !== gk.idx) { releasedAt = i * dt; speedAtRelease = e.ball.speed; break; }
  }
  assert(releasedAt > 0, "the keeper must release the ball");
  assert(releasedAt <= limit + 0.6, `released at ${releasedAt.toFixed(2)}s, limit ${limit}s`);
  assert(speedAtRelease > 5, `the release is a long ball, speed ${speedAtRelease.toFixed(1)} m/s`);
  e.dispose();
});

test("keeper pressure prefers the nearest body over a distant sprinter", () => {
  const e = fresh(703);
  const gk = e.players[0];
  gk.pos.set(-18, 0, 0);
  const near = e.players[6];   // BLUE, slower, closer
  const far = e.players[8];    // BLUE, sprinting, further away
  for (const p of e.players) {
    if (p.idx !== gk.idx && p.idx !== near.idx && p.idx !== far.idx) p.pos.set(40, 0, 20);
  }
  near.pos.set(-16, 0, 0); near.vel.set(-1.2, 0, 0);   // 2 m away, jogging in
  far.pos.set(-14, 0, 0); far.vel.set(-7, 0, 0);       // 4 m away, sprinting in
  const snap = buildWorldSnap(e);
  const wp = snap.players.find((q) => q.idx === gk.idx)!;
  const pressure = e.ai.goalkeeperPressure(wp, snap);
  assert.equal(pressure.opponent?.idx, near.idx,
    `the nearer body must win, got #${pressure.opponent?.idx}`);
  assert(Math.abs(pressure.distance - 2) < 0.2, `distance ${pressure.distance.toFixed(2)}`);
  assert.equal(pressure.urgent, true, "a sprinting body 4 m away still makes the keeper hurry");

  // But a body that will arrive inside the reaction window outranks "nearest".
  near.pos.set(-16.2, 0, 0); near.vel.set(0, 0, 0);
  far.pos.set(-17.0, 0, 0); far.vel.set(-9, 0, 0);      // 1 m away, closing at 9 m/s
  const snap2 = buildWorldSnap(e);
  const wp2 = snap2.players.find((q) => q.idx === gk.idx)!;
  const imminent = e.ai.goalkeeperPressure(wp2, snap2);
  assert.equal(imminent.opponent?.idx, far.idx, "an imminent challenge owns the read");
  e.dispose();
});

// ------------------------------------------------------------- cards/fouls ---
/**
 * Blind-side contact: the challenger arrives from behind the carrier, so the
 * ball (glued 0.48 m in front of the carrier) is still inside a competitive
 * distance. That is the reckless band — late/blind side, but the ball was there
 * to be played. It is a foul, never a clean win.
 */
function setupBlindside(e: MatchEngine) {
  const carrier = e.players[4];
  const tackler = e.players[6];
  carrier.pos.set(0, 0, 0); carrier.facing = 0;
  carrier.vel.set(0, 0, 0); carrier.speed = 0;
  carrier.stumbleT = 0;
  tackler.pos.set(-0.9, 0, 0);
  tackler.facing = 0; // facing +X: through the carrier at the ball
  tackler.vel.set(0, 0, 0); tackler.speed = 0;
  tackler.stumbleT = 0;
  e.ball.possess(carrier.idx, carrier.team);
  e.ball.pos.set(0.48, CONFIG.ball.radius, 0);
  e.ball.vel.set(0, 0, 0);
  e.offsideCandidates.clear(); e.offsideTeam = null;
  return { carrier, tackler };
}

/** Body contact with the ball out of reach, on time: a foul with no card. */
function setupMistimed(e: MatchEngine) {
  const carrier = e.players[4];
  const tackler = e.players[6];
  carrier.pos.set(0, 0, 0); carrier.facing = 0;
  carrier.vel.set(0, 0, 0); carrier.speed = 0;
  carrier.stumbleT = 0;
  tackler.pos.set(0, 0, 1.85);
  tackler.facing = Math.atan2(1.85, 0.48); // face the ball, not the carrier
  tackler.vel.set(0, 0, 0); tackler.speed = 0;
  tackler.stumbleT = 0;
  e.ball.possess(carrier.idx, carrier.team);
  e.ball.pos.set(0.48, CONFIG.ball.radius, 0);
  e.ball.vel.set(0, 0, 0);
  e.offsideCandidates.clear(); e.offsideTeam = null;
  return { carrier, tackler };
}

/** Resolve the challenge's own contact frame. */
function resolveTackle(e: MatchEngine, tackler: EnginePlayer, action: "tackle_stand" | "tackle_slide") {
  assert.equal(startAction(e, tackler, action, e.ball.pos.clone()), true, "wind-up should start");
  for (let i = 0; i < 120; i++) {
    const dt = 1 / 60;
    e.clock += dt;
    for (const p of e.players) decayTackleTimers(p, dt);
    const frame = tackler.anim.update(dt, 0, 0);
    if (frame.contact) { onContact(e, tackler, frame.contact); return; }
  }
  throw new Error(`${action} never produced a contact frame`);
}

test("a blind-side challenge that could still play the ball is a yellow card", () => {
  const e = fresh(704);
  const { carrier, tackler } = setupBlindside(e);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.tacticalStats.fouls, 1, "a foul was given");
  assert.equal(tackler.yellowCards, 1, "a reckless (blind-side) foul is booked");
  assert.equal(tackler.foulsConceded, 1, "the foul is on his record");
  assert.equal(isOffPitch(e, tackler), false, "one yellow does not leave the pitch");
  assert(e.rules.events.some((ev) => ev.type === "YELLOW_CARD"), "the HUD feed shows the yellow");
  assert.equal(e.rules.pendingRestart?.team, carrier.team, "the restart goes to the fouled side");
  e.dispose();
});

test("a foul with no competitive chance of playing the ball is not booked", () => {
  const e = fresh(705);
  const { tackler } = setupMistimed(e);
  resolveTackle(e, tackler, "tackle_stand"); // ball out of reach, on time
  assert.equal(e.tacticalStats.fouls, 1, "still a foul");
  assert.equal(tackler.yellowCards, 0, "no competitive ball access ⇒ careless, not reckless");
  assert.equal(tackler.foulsConceded, 1, "but the foul is still on his record");
  assert.equal(e.rules.events.some((ev) => ev.type === "YELLOW_CARD"), false);
  e.dispose();
});

test("a second yellow is a blue card: off the pitch for 60 seconds, then back", () => {
  const e = fresh(706);
  const { tackler } = setupBlindside(e);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(tackler.yellowCards, 1);
  // Retake the same reckless challenge once the recovery has expired.
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null;
  tackler.tackleRecoveryT = 0; tackler.anim = new AnimationController();
  tackler.stumbleT = 0;
  const { carrier } = setupBlindside(e);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(tackler.yellowCards, 2, "two yellows");
  assert.equal(e.ball.possessedBy, carrier.idx, "the victim keeps the ball");
  assert.equal(isOffPitch(e, tackler), true, "the blue card takes him off the pitch");
  assert(Math.abs(blueCardRemaining(e, tackler) - CONFIG.referee.blueCardSeconds) < 0.5,
    `60 s exclusion, got ${blueCardRemaining(e, tackler).toFixed(1)}s`);
  assert(e.rules.events.some((ev) => ev.type === "BLUE_CARD"), "the HUD feed shows the blue card");

  // He is idle off the pitch: a stepped frame walks him to the bench, not into play.
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null;
  for (let i = 0; i < 60 * 7; i++) e.step(1 / 60);
  assert.match(tackler.decisionReason, /Blue card/);
  assert(Math.abs(tackler.pos.z) > CONFIG.pitch.width / 2,
    `he must be outside the touchline, z ${tackler.pos.z.toFixed(2)}`);
  const snap = buildWorldSnap(e);
  assert.equal(snap.players.some((q) => q.idx === tackler.idx), false,
    "an off-pitch player is not part of the AI picture");

  // After the exclusion he re-enters, inside the field of play.
  e.clock += CONFIG.referee.blueCardSeconds + 0.2;
  e.step(1 / 60);
  assert.equal(tackler.blueCardUntil, 0, "the blue card has expired");
  assert.equal(isOffPitch(e, tackler), false);
  assert(Math.abs(tackler.pos.z) <= CONFIG.pitch.width / 2, "he is back on the pitch");
  e.dispose();
});

test("a booked player's challenge is refused from an angle a clean player may use", () => {
  const e = fresh(707);
  const tackler = e.players[6];
  const carrier = e.players[4];
  const gk = e.players[0];
  gk.pos.set(17, 0, 10);
  carrier.pos.set(0, 0, 0); carrier.facing = 0;
  // Just inside the blind-side limit: frontDot ≈ -0.2 (legal when clean, not when
  // booked). The challenger is behind the carrier's shoulder but still facing the ball.
  tackler.pos.set(-0.3, 0, 1.47);
  tackler.facing = Math.atan2(1.47, 0.78);
  e.ball.possess(carrier.idx, carrier.team);
  e.ball.pos.set(0.48, CONFIG.ball.radius, 0);
  const snap = buildWorldSnap(e);
  const wp = snap.players.find((q) => q.idx === tackler.idx)!;
  const canTackle = (e.ai as unknown as { canTackle: (p: unknown, s: unknown, a: string) => boolean }).canTackle;
  const clean = canTackle.call(e.ai, { ...wp, yellowCards: 0 }, snap, "tackle_stand");
  const booked = canTackle.call(e.ai, { ...wp, yellowCards: 1 }, snap, "tackle_stand");
  assert.equal(clean, true, "test setup: the angle is legal for a clean player");
  assert.equal(booked, false, "a booked player does not dive in from there");
  e.dispose();
});

// ---------------------------------------------------------------- advantage ---
test("advantage: the whistle stays down while the fouled side keeps a usable ball", () => {
  const e = fresh(708);
  const { carrier, tackler } = setupBlindside(e);
  // The carrier is running forward with room ahead of him: play on.
  carrier.pos.set(-5, 0, 0);
  carrier.vel.set(3.5, 0, 0); carrier.speed = 3.5;
  e.ball.pos.set(-4.52, CONFIG.ball.radius, 0);
  tackler.pos.set(-5.9, 0, 0);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.tacticalStats.fouls, 1, "the foul is recorded");
  assert.equal(e.rules.phase, "INPLAY", "play is not stopped");
  assert.equal(e.rules.pendingRestart, null, "no free kick is awarded");
  assert.equal(e.ball.possessedBy, carrier.idx, "the fouled player keeps the ball");
  assert(e.rules.events.some((ev) => ev.type === "ADVANTAGE"), "the HUD feed shows the advantage");
  assert.equal(tackler.yellowCards, 1, "the card is still issued");
  e.dispose();
});

test("no advantage: a static carrier gets the free kick", () => {
  const e = fresh(709);
  const { carrier, tackler } = setupBlindside(e);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.rules.phase, "SETUP", "play stops");
  assert.equal(e.rules.pendingRestart?.kind, "free_kick");
  assert.equal(e.rules.pendingRestart?.team, carrier.team);
  assert.equal(e.rules.events.some((ev) => ev.type === "ADVANTAGE"), false);
  e.dispose();
});

// ------------------------------------------------------- ball / aim bounds ---
test("a dribbled ball never crosses the touchline or the goal line", () => {
  const e = fresh(710);
  const p = e.players[4];
  const R = CONFIG.ball.radius;
  const HX = CONFIG.pitch.length / 2 - 0.4, HZ = CONFIG.pitch.width / 2 - 0.4; // the engine's wall clamp
  e.ball.possess(p.idx, p.team);
  // The carrier is pinned on the wall clamp and faces straight at each line in turn:
  // the ball is glued 0.48 m in front of him, and it still never crosses.
  const cases = [
    { pos: new THREE.Vector3(0, 0, HZ), facing: -Math.PI / 2 },   // facing +Z, at the touchline
    { pos: new THREE.Vector3(0, 0, -HZ), facing: Math.PI / 2 },   // facing -Z
    { pos: new THREE.Vector3(HX, 0, 0), facing: 0 },              // facing +X, at the goal line
    { pos: new THREE.Vector3(-HX, 0, 0), facing: Math.PI },       // facing -X
    { pos: new THREE.Vector3(HX, 0, HZ), facing: -Math.PI / 4 },  // the corner, diagonally out
  ];
  for (const c of cases) {
    p.pos.copy(c.pos);
    p.facing = c.facing;
    p.vel.set(0, 0, 0);
    for (let i = 0; i < 90; i++) {
      e.ball.step(1 / 60, p.pos, p.facing, p.vel);
      assert(e.ball.pos.x <= CONFIG.pitch.length / 2 + R,
        `ball x ${e.ball.pos.x.toFixed(3)} inside the goal line + radius`);
      assert(Math.abs(e.ball.pos.z) <= CONFIG.pitch.width / 2 + R,
        `ball z ${e.ball.pos.z.toFixed(3)} inside the touchline + radius`);
      outGoalCheck(e);
      assert.equal(e.rules.pendingRestart, null, "a dribbled ball never goes out of play");
    }
  }
  e.dispose();
});

test("a free ball crossing the line is caught by the sweep test and stopped", () => {
  const e = fresh(713);
  const p = e.players[4];
  e.ball.release();
  e.ball.lastTouch = p.idx;
  e.ball.lastTouchTeam = p.team;
  // Aimed at the touchline from 1 m inside it, at shot pace (1.2 m in one 1/60 frame
  // at 20 m/s is a shallow crossing: only the swept segment catches the exit).
  e.ball.pos.set(-3, CONFIG.ball.radius, CONFIG.pitch.width / 2 - 1.0);
  e.ball.prevPos.copy(e.ball.pos);
  e.ball.vel.set(18, 0, 6);
  for (let i = 0; i < 30; i++) {
    e.ball.step(1 / 60);
    outGoalCheck(e);
    if (e.rules.pendingRestart) break;
  }
  assert.equal(e.rules.pendingRestart?.kind, "throw_in", "the touchline exit is a throw-in");
  assert.equal(e.rules.pendingRestart?.team, 1 - p.team, "awarded to the side that did not touch it last");
  assert.equal(e.ball.speed, 0, "the ball's velocity is zeroed at the restart");
  assert(Math.abs(e.ball.pos.z) <= CONFIG.pitch.width / 2 + CONFIG.ball.radius,
    "the ball is never left outside the pitch");
  // The throw-in spot is where the ball actually crossed, not where the frame ended.
  assert(Math.abs(e.rules.pendingRestart!.pos[0] + 3) < 3.5,
    `throw-in x ${e.rules.pendingRestart!.pos[0].toFixed(2)} near the exit point`);
  e.dispose();
});

test("a carrier pinned on a line never stalls the match on a queued kick", () => {
  // The pivot onto a kick target has to end. A carrier whose velocity owns his body
  // angle (pinned against the clamp, running into it) could never satisfy the facing
  // test, so the turn was re-requested every 0.06 s and the kick never left: seed 777
  // held the ball for 109 s. Every possession must now resolve.
  for (const seed of [777, 1234]) {
    const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
    let owner = -1, held = 0, worst = 0;
    for (let f = 0; f < 260 * 60; f++) {
      e.step(1 / 60);
      if (e.ball.possessedBy !== owner) { worst = Math.max(worst, held); held = 0; owner = e.ball.possessedBy; }
      else held += 1 / 60;
      if (e.rules.phase === "FULLTIME") break;
    }
    assert(worst < 12, `seed ${seed}: the ball was held for ${worst.toFixed(1)}s without a kick`);
    assert(e.actionLog.length > 40, `seed ${seed}: only ${e.actionLog.length} actions — play stalled`);
    e.dispose();
  }
});

test("AI aim points are pre-clamped inside the pitch", () => {
  // A runner predicted beyond the goal line is pulled back by the safety margin.
  const ahead = predictReceiverRun(
    new THREE.Vector3(19, 0, 0), new THREE.Vector3(9, 0, 0),
    new THREE.Vector3(60, 0, 40), 2.0, CONFIG.ai.maxSprint,
  );
  const margin = CONFIG.ai.outPlaySafetyMargin;
  assert(ahead.x <= CONFIG.pitch.length / 2 - margin + 1e-6, `x ${ahead.x.toFixed(2)}`);
  assert(ahead.z <= CONFIG.pitch.width / 2 - margin + 1e-6, `z ${ahead.z.toFixed(2)}`);

  // Keeper distribution never names a target outside the field of play either.
  const e = fresh(711);
  const gk = e.players[0];
  gk.pos.set(-18, 0, 0);
  e.ball.possess(gk.idx, gk.team);
  e.ball.pos.set(gk.pos.x, CONFIG.ball.radius, gk.pos.z);
  for (const p of e.players) {
    if (p.team === gk.team && p.idx !== gk.idx) p.pos.set(CONFIG.pitch.length / 2 - 0.5, 0, CONFIG.pitch.width / 2 - 0.5);
  }
  const choice = evaluateGkDistribution(e, gk, true);
  assert(choice, "a distribution option exists");
  assert(Math.abs(choice!.target.x) < CONFIG.pitch.length / 2 && Math.abs(choice!.target.z) < CONFIG.pitch.width / 2,
    `target (${choice!.target.x.toFixed(2)}, ${choice!.target.z.toFixed(2)}) is inside the pitch`);

  // A throw-in near a byline samples "up the line" from a teammate already close to
  // it, which used to aim behind the goal line. Every restart delivery is clamped.
  for (let k = 0; k < 24; k++) {
    for (const side of [1, -1]) {
      const thrower = e.players[3 + (k % 4)];
      thrower.pos.set(side * (CONFIG.pitch.length / 2 - 1.2), 0, CONFIG.pitch.width / 2 - 0.18);
      const rng = new SeededRandom(920 + k);
      const aim = sampleRestartTarget(e, { id: 900 + k, kind: "throw_in", pos: [thrower.pos.x, CONFIG.pitch.width / 2 - 0.25], team: thrower.team }, thrower, rng);
      assert(Math.abs(aim.target.x) <= CONFIG.pitch.length / 2 - CONFIG.ai.outPlaySafetyMargin + 1e-6,
        `throw-in aim x ${aim.target.x.toFixed(2)} is inside the goal line`);
      assert(Math.abs(aim.target.z) <= CONFIG.pitch.width / 2 - CONFIG.ai.outPlaySafetyMargin + 1e-6,
        `throw-in aim z ${aim.target.z.toFixed(2)} is inside the touchline`);
    }
  }
  e.dispose();
});

test("a restart released from outside the touchline puts the ball back in play", () => {
  const e = fresh(712);
  const thrower = e.players[6];
  thrower.pos.set(0, 0, CONFIG.pitch.width / 2 - 0.18); // legal throw-in stance
  e.rules.pendingRestart = { id: 900, kind: "throw_in", pos: [0, CONFIG.pitch.width / 2 - 0.25], team: thrower.team };
  e.rules.phase = "INPLAY";
  thrower.restartTaker = true;
  e.ball.possess(thrower.idx, thrower.team);
  e.ball.pos.set(thrower.pos.x, CONFIG.ball.radius, thrower.pos.z);
  releaseRestartToTaker(e, thrower);
  // The taker may stand on the touchline; the ball he releases may not.
  assert(Math.abs(thrower.pos.z) > CONFIG.pitch.width / 2 - 0.4,
    "test setup: the taker stands outside the field of play");
  assert(Math.abs(e.ball.pos.z) <= CONFIG.pitch.width / 2 - 0.4 + 1e-6,
    `released ball z ${e.ball.pos.z.toFixed(2)} is inside the touchline`);
  assert.equal(e.ball.possessedBy, thrower.idx, "the taker keeps the ball in play");
  e.dispose();
});

console.log(`\n${count} REFEREE / BOUNDARY REGRESSIONS PASSED`);
