/**
 * Headless regressions for deterministic duels, keeper positioning, HUD/debug
 * robustness and RNG isolation. Run with esbuild + node (see package.json).
 */
import { headlessEngineCanvas } from "./harness"; // installs the headless DOM shim on import
import assert from "node:assert/strict";
import * as THREE from "three";
import { MatchEngine } from "../src/game/engine";
import { AnimationController } from "../src/game/anims";
import { CONFIG } from "../src/game/config";
import { AIController, keeperPositionTarget } from "../src/game/ai";
import { SeededRandom } from "../src/game/random";
import { startAction } from "../src/game/match/actions";
import { footWorld, onContact } from "../src/game/match/contacts";
import { updateAIDebug } from "../src/game/match/debug";
import { resetPositions } from "../src/game/match/restarts";
import { yawDelta } from "../src/game/angles";
import { decayTackleTimers, tackleRecovery } from "../src/game/match/tackles";
import type { EnginePlayer } from "../src/game/match/types";

let count = 0;
function test(name: string, check: () => void) { check(); console.log(`PASS ${name}`); count++; }

function fresh(seed = 900, debugAI = false): MatchEngine {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI });
  engine.rules.phase = "INPLAY";
  engine.rules.pendingRestart = null;
  engine.clock = 10;
  for (const p of engine.players) {
    p.pos.set(30, 0, p.idx % 2 ? 10 : -10);
    p.vel.set(0, 0, 0);
    p.moveTarget.copy(p.pos);
    p.facing = 0; p.speed = 0; p.stamina = 1;
    p.holdT = 0; p.stumbleT = 0;
    p.tackleRecoveryT = 0; p.tackleProtectionT = 0; p.tackleChallenge = null;
    p.pendingKick = null;
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

function setupDuel(
  e: MatchEngine,
  opts: { tacklerX?: number; tacklerZ?: number; tacklerFacing?: number; carrierFacing?: number } = {},
) {
  const carrier = e.players[4];
  const tackler = e.players[6];
  assert.equal(carrier.team, 0);
  assert.equal(tackler.team, 1);
  carrier.pos.set(0, 0, 0);
  carrier.facing = opts.carrierFacing ?? 0;
  carrier.vel.set(0, 0, 0); carrier.speed = 0; carrier.stumbleT = 0;
  tackler.pos.set(opts.tacklerX ?? 1.2, 0, opts.tacklerZ ?? 0);
  tackler.facing = opts.tacklerFacing ?? Math.PI;
  tackler.vel.set(0, 0, 0); tackler.speed = 0; tackler.stumbleT = 0;
  e.ball.possess(carrier.idx, carrier.team);
  e.ball.pos.set(0.48, CONFIG.ball.radius, 0);
  e.ball.vel.set(0, 0, 0);
  e.offsideCandidates.clear(); e.offsideTeam = null;
  return { carrier, tackler };
}

/** Advance only the challenger's animation clock, then resolve its contact frame. */
function resolveTackle(e: MatchEngine, tackler: EnginePlayer, action: "tackle_stand" | "tackle_slide") {
  assert.equal(startAction(e, tackler, action, e.ball.pos.clone()), true, "tackle wind-up should start");
  for (let i = 0; i < 120; i++) {
    const dt = 1 / 60;
    e.clock += dt;
    for (const p of e.players) decayTackleTimers(p, dt);
    const frame = tackler.anim.update(dt, 0, 0);
    if (frame.contact) {
      onContact(e, tackler, frame.contact);
      return;
    }
  }
  throw new Error(`${action} never produced a contact frame`);
}

test("a front-on, on-time standing challenge wins the ball and starts recovery/protection", () => {
  const e = fresh(901);
  const { carrier, tackler } = setupDuel(e);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.ball.possessedBy, tackler.idx, "clean challenge should win the ball");
  assert(tackler.tackleRecoveryT > 0, "challenger must recover after the attempt");
  assert(tackler.tackleProtectionT > 0, "new carrier must be protected from an instant counter-tackle");
  assert(carrier.stumbleT > 0, "dispossessed carrier should stumble");
  assert.equal(e.tacticalStats.tacklesAttempted, 1);
  assert.equal(e.tacticalStats.tacklesWon, 1);

  // The dispossessed player's immediate counter-challenge is rejected before
  // the animation wind-up, even if we pretend its stumble clip has ended.
  carrier.anim.actionId = null;
  carrier.anim.actionMeta = null;
  assert.equal(startAction(e, carrier, "tackle_slide", e.ball.pos.clone()), false);
  assert.equal(e.tacticalStats.tacklesAttempted, 1, "rejected challenge must not count as an attempt");
  e.dispose();
});

test("blindside/late contact never grants free possession and costs recovery", () => {
  const e = fresh(902);
  // Fouls off: this case is about the possession outcome, not the whistle.
  e.foulsOn = false;
  const { carrier, tackler } = setupDuel(e, { tacklerX: -0.9, tacklerFacing: 0 });
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.ball.possessedBy, carrier.idx, "bad challenge must not steal possession");
  assert(tackler.tackleRecoveryT > 0, "failed challenge still has recovery");
  assert(e.tacticalStats.fouls + e.tacticalStats.tacklesMissed + e.tacticalStats.tacklesSpilled === 1);
  assert.equal(e.tacticalStats.tacklesWon, 0);

  // Force the clip to look finished; the recovery timer alone must still block
  // another tackle (this is the part the per-clip cooldown did not cover).
  tackler.anim.actionId = null;
  tackler.anim.actionMeta = null;
  assert.equal(startAction(e, tackler, "tackle_stand", e.ball.pos.clone()), false);
  e.dispose();
});

test("sliding tackles have a longer recovery than standing tackles", () => {
  assert(tackleRecovery("tackle_slide") > tackleRecovery("tackle_stand"));
  assert(CONFIG.tackle.slideReach > CONFIG.tackle.standReach);
});

test("keeper occupies a real angle arc, not 0.6 m from the goal line", () => {
  const leftGoal = new THREE.Vector3(-CONFIG.pitch.length / 2, 0, 0);
  const central = keeperPositionTarget(new THREE.Vector3(-8, 0.11, 0), leftGoal, 1);
  assert(central.advance > 1.0 && central.advance <= CONFIG.ai.gkPositionMaxAdvance + 1e-6,
    `expected a real narrowing angle, got ${central.advance}`);
  assert(central.target.x > -19.0 && central.target.x < -15.8);
  assert(Math.abs(central.target.z) < 0.2);

  const wide = keeperPositionTarget(new THREE.Vector3(-8, 0.11, 8), leftGoal, 1);
  assert(wide.target.z > 0.5, "keeper must shift toward the near post");
  assert(wide.target.x > leftGoal.x && wide.target.x < -8, "keeper stays between ball and goal");

  // Right-hand goal in the second half: the old world-space clamp pinned both
  // keepers at |x|=19.4. Ensure the field sign is respected.
  const rightGoal = new THREE.Vector3(CONFIG.pitch.length / 2, 0, 0);
  const switched = keeperPositionTarget(new THREE.Vector3(8, 0.11, -8), rightGoal, -1);
  assert(switched.advance > 1.0 && switched.target.x < 19.0 && switched.target.x > 15.8);
  assert(switched.target.z < -0.5, "near post flips with the ball");
});

test("keeper positioning improves the real-engine shot grid", () => {
  // The full grid is exercised by `ai-repro --gk`; here we assert the pure
  // target used by that grid is physically on the angle and finite.
  const goal = new THREE.Vector3(-20, 0, 0);
  for (const dist of [8, 12, 16, 20, 24]) {
    for (const z of [-1.3, 0, 1.3]) {
      const p = keeperPositionTarget(new THREE.Vector3(-20 + dist, 0.11, z), goal, 1);
      assert(Number.isFinite(p.target.x) && Number.isFinite(p.target.z));
      assert(p.advance >= CONFIG.ai.gkPositionBase - 1e-6);
      assert(Math.abs(p.target.z) <= CONFIG.pitch.goalWidth / 2);
    }
  }
});

test("action ids are deterministic and do not consume the shared match PRNG", () => {
  const a = fresh(903), b = fresh(903);
  const beforeA = a.rng.nextUint(), beforeB = b.rng.nextUint();
  assert.equal(beforeA, beforeB);
  const da = setupDuel(a), db = setupDuel(b);
  assert.equal(startAction(a, da.tackler, "tackle_stand", a.ball.pos.clone()), true);
  assert.equal(startAction(b, db.tackler, "tackle_stand", b.ball.pos.clone()), true);
  assert.equal(a.lastActionSeed, b.lastActionSeed);
  assert.equal(a.rng.nextUint(), b.rng.nextUint(), "startAction must not advance the shared stream");
  a.dispose(); b.dispose();
});

test("debug, camera and snapshot paths do not change a fixed-seed replay", () => {
  const a = fresh(904, false);
  const b = fresh(904, true);
  b.cameraMode = "follow"; b.showAIDebug = false; b.showAnimOverlay = false;

  const signature = (e: MatchEngine) => JSON.stringify({
    clock: e.clock, phase: e.rules.phase, score: e.rules.score,
    ball: [e.ball.pos.toArray(), e.ball.vel.toArray(), e.ball.possessedBy, e.ball.ownerTeam, e.ball.lastTouchTeam],
    players: e.players.map((p) => [p.idx, p.pos.toArray(), p.vel.toArray(), p.facing, p.anim.actionId, Number(p.anim.actionT.toFixed(4)), p.decisionReason]),
    actionLog: e.actionLog, passLog: e.passLog, stats: e.tacticalStats,
    lastActionSeed: e.lastActionSeed,
  });

  const real = { ...console };
  console.log = () => {}; console.info = () => {}; console.warn = () => {};
  console.table = () => {}; console.groupCollapsed = () => {}; console.groupEnd = () => {};
  try {
    for (let f = 0; f < 600; f++) {
      a.step(1 / 60);
      b.step(1 / 60);
      if (f % 7 === 0) { a.snapshot(); b.snapshot(); }
      if (f % 97 === 0) { b.showAIDebug = !b.showAIDebug; b.cameraMode = b.cameraMode === "follow" ? "broadcast" : "follow"; }
    }
  } finally {
    Object.assign(console, real);
  }
  assert.equal(signature(b), signature(a));
  a.dispose(); b.dispose();
});

test("footWorld falls back to the player, not the world origin", () => {
  const e = fresh(905);
  const p = e.players[0];
  p.pos.set(5, 0, 2); p.facing = 0;
  p.rig.skeleton.bones.delete("foot.R");
  const v = footWorld(p, "R");
  assert(v.distanceTo(new THREE.Vector3(0, 0, 0)) > 1, "zero vector would fake contact alignment");
  assert(Math.hypot(v.x - p.pos.x, v.z - p.pos.z) < 1, "fallback must stay near the player");
  e.dispose();
});

test("snapshot tolerates invalid and empty rosters", () => {
  const e = fresh(906);
  e.selectedIdx = 999; e.humanIdx = 999;
  const fallback = e.snapshot();
  assert.equal(fallback.selIdx, 0);
  assert.equal(typeof fallback.anim.state, "string");
  e.players.length = 0;
  const empty = e.snapshot();
  assert.equal(empty.selIdx, -1);
  assert.equal(empty.anim.clip, "none");
  e.dispose();
});

test("keeper distribution and AI debug lines handle non-standard rosters", () => {
  const e = fresh(907);
  for (const p of e.players) p.team = 0; // no opponents: Math.min(...[]) would be Infinity
  const gk = e.players[0];
  const choice = e.evaluateGkDistribution(gk);
  assert(choice, "distribution should still return an option");
  assert(!choice.reason.includes("Infinity"), choice.reason);

  e.showAIDebug = true;
  const extra = { ...e.players[1], idx: 99, pos: e.players[1].pos.clone(), moveTarget: e.players[1].moveTarget.clone() } as EnginePlayer;
  e.players.push(extra);
  updateAIDebug(e);
  assert(e.aiLinePos.array.length >= e.players.length * 6, "AI line buffer must resize to the roster");
  e.dispose();
});

test("kickoff staging no longer assumes five fixed indices per team", () => {
  const e = fresh(908);
  e.players.splice(4, 1); // remove RED's fixed-index forward
  e.rules.pendingRestart = { id: 1, kind: "kickoff", pos: [0, 0], team: 0 };
  resetPositions(e, "kickoff");
  assert(e.players.some((p) => p.restartTaker), "a legal taker must still be selected");
  assert.equal(e.ball.possessedBy !== null, true);
  e.dispose();
});

test("one player's human/spectator think skip cannot shift another player's AI stream", () => {
  const seed = 909;
  const players = Array.from({ length: 10 }, (_, i) => ({
    idx: i, team: i < 5 ? 0 : 1, role: i % 5 === 0 ? "GK" : i % 5 < 3 ? "DEF" : i % 5 === 3 ? "MID" : "FWD",
    roleIdx: i % 5, pos: new THREE.Vector3(-10 + i * 2, 0, i % 2 ? 2 : -2), vel: new THREE.Vector3(),
    facing: 0, speed: 0, busy: false, uninterruptible: false, cooldowns: new Map(),
    stamina: 1, hasBall: false, callForBall: false, isHuman: false, runSerial: 0,
    style: { directness: 1, width: 1, risk: 1, carry: 1, shooting: 1, pressing: 1, support: 1, creativity: 1, finesseSide: 1 as const },
    moveTarget: new THREE.Vector3(), desiredSpeed: 0,
  }));
  const snap = {
    ballPos: new THREE.Vector3(0, 0.11, 0), ballVel: new THREE.Vector3(),
    ballOwner: null, ballOwnerTeam: null, players, time: 10, half: 1 as const,
    matchSeed: seed, ballKickAge: 1,
  };
  const a = new AIController(new SeededRandom(seed), seed);
  const b = new AIController(new SeededRandom(seed), seed);
  a.think(players[0], 0, snap, 10); // extra think on controller A only
  const da = a.think(players[1], 1, snap, 10);
  const db = b.think(players[1], 1, snap, 10);
  assert.equal(da.reason, db.reason);
  assert.deepEqual(da.utilities, db.utilities);
  assert.equal(da.action, db.action);
});

test("a goalkeeper holding the ball cannot be tackled", () => {
  const e = fresh(910);
  const gk = e.players[0];
  const outfield = e.players[4];
  const tackler = e.players[6];
  assert.equal(gk.role, "GK");
  assert.equal(tackler.team, 1);

  // 1. The wind-up is refused before it starts: the ball is in the keeper's hands.
  gk.pos.set(-18, 0, 0); gk.facing = 0;
  e.ball.possess(gk.idx, gk.team);
  e.ball.handsRestrictedTeam = null;
  e.ball.pos.set(-18, CONFIG.ball.radius, 0.48);
  tackler.pos.set(-17, 0, 0); tackler.facing = Math.PI;
  assert.equal(startAction(e, tackler, "tackle_stand", e.ball.pos.clone()), false,
    "a keeper in possession must not be challengeable");
  assert.equal(e.tacticalStats.tacklesAttempted, 0, "a refused challenge is not an attempt");

  // 2. A challenge already in flight when the keeper gathers the ball wins nothing and
  //    is not a foul against the keeper either.
  outfield.pos.set(-16, 0, 0); outfield.facing = 0;
  tackler.pos.set(-16.5, 0, 0); tackler.facing = Math.PI;
  gk.pos.set(-18, 0, 0);
  e.ball.possess(outfield.idx, outfield.team);
  e.ball.pos.set(-16.48, CONFIG.ball.radius, 0);
  assert.equal(startAction(e, tackler, "tackle_stand", e.ball.pos.clone()), true);
  // The keeper collects it mid-wind-up.
  e.ball.possess(gk.idx, gk.team);
  e.ball.pos.set(-18, 0.9, 0);
  for (let i = 0; i < 120; i++) {
    const dt = 1 / 60;
    e.clock += dt;
    for (const p of e.players) decayTackleTimers(p, dt);
    const frame = tackler.anim.update(dt, 0, 0);
    if (frame.contact) { onContact(e, tackler, frame.contact); break; }
  }
  assert.equal(e.ball.possessedBy, gk.idx, "the keeper keeps the ball");
  assert.equal(e.tacticalStats.fouls, 0, "no foul may be given against the keeper");
  assert.equal(e.tacticalStats.tacklesWon, 0);
  e.dispose();
});

/** Side-on body contact that arrives with the ball out of reach: mistimed, not won. */
function setupMistimed(e: MatchEngine) {
  const carrier = e.players[4];
  const tackler = e.players[6];
  carrier.pos.set(0, 0, 0); carrier.facing = 0;
  carrier.vel.set(0, 0, 0); carrier.speed = 0;
  tackler.pos.set(0, 0, 1.85);
  tackler.facing = Math.atan2(1.85, 0.48); // face the ball, not the carrier
  tackler.vel.set(0, 0, 0); tackler.speed = 0;
  e.ball.possess(carrier.idx, carrier.team);
  e.ball.pos.set(0.48, CONFIG.ball.radius, 0);
  e.ball.vel.set(0, 0, 0);
  e.offsideCandidates.clear(); e.offsideTeam = null;
  return { carrier, tackler };
}

test("a challenge that hits the man but not the ball is a foul", () => {
  const e = fresh(911);
  e.foulsOn = false;
  const { carrier, tackler } = setupMistimed(e);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.tacticalStats.fouls, 1, "body contact with the ball out of reach is a foul");
  assert.equal(e.tacticalStats.tacklesWon, 0, "and it never wins the ball");
  assert.equal(e.ball.possessedBy, carrier.idx, "the fouled carrier keeps the ball with fouls off");
  assert(tackler.tackleRecoveryT >= 0.45, "a foul costs extra recovery");
  e.dispose();
});

test("a foul stops play and gives the free kick to the fouled side", () => {
  const e = fresh(912);
  const { carrier, tackler } = setupMistimed(e);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.rules.phase, "SETUP", "the whistle stops play");
  assert.equal(e.rules.pendingRestart?.kind, "free_kick");
  assert.equal(e.rules.pendingRestart?.team, carrier.team, "the fouled team restarts");
  assert.equal(e.ball.possessedBy, null);
  e.dispose();
});

test("a foul inside the box being attacked is a penalty, not a free kick", () => {
  const e = fresh(913);
  const { carrier, tackler } = setupMistimed(e);
  const goal = e.ai.goalPos(carrier.team, e.rules.half);
  carrier.pos.set(goal.x - 3, 0, 0);
  e.ball.pos.set(goal.x - 2.52, CONFIG.ball.radius, 0);
  tackler.pos.set(goal.x - 3, 0, 1.85);
  resolveTackle(e, tackler, "tackle_stand");
  assert.equal(e.tacticalStats.fouls, 1);
  assert.equal(e.rules.pendingRestart?.kind, "penalty",
    "an attacking-box foul is a penalty; ownGoal-relative box logic gave a free kick");
  assert.equal(e.rules.pendingRestart?.team, carrier.team);
  e.dispose();
});

test("keeper faces the play while shuffling, not the goal line", () => {
  const e = fresh(914);
  const gk = e.players[0];
  // Ball in front of the keeper's goal, wide; keeper displaced to the far post.
  e.ball.release();
  e.ball.pos.set(-8, CONFIG.ball.radius, 7);
  e.ball.vel.set(0, 0, 0);
  gk.pos.set(-18, 0, -1.5); gk.facing = 0; gk.vel.set(0, 0, 0); gk.speed = 0;
  const quiet = console.log; console.log = () => {};
  try { for (let i = 0; i < 30; i++) e.step(1 / 60); } finally { console.log = quiet; }
  const toBall = new THREE.Vector3(e.ball.pos.x - gk.pos.x, 0, e.ball.pos.z - gk.pos.z);
  const ballYaw = Math.atan2(-toBall.z, toBall.x);
  const velYaw = Math.atan2(-gk.vel.z, gk.vel.x);
  assert(gk.speed > 0.5, `keeper should be shuffling, speed ${gk.speed.toFixed(2)}`);
  assert(Math.abs(yawDelta(gk.facing, velYaw)) > 0.35, "test setup: travel is not toward the ball");
  assert(Math.abs(yawDelta(gk.facing, ballYaw)) < 0.35,
    `keeper must watch the ball: facing ${gk.facing.toFixed(2)} ball ${ballYaw.toFixed(2)} vel ${velYaw.toFixed(2)}`);
  e.dispose();
});

console.log(`\n${count} DUEL / DETERMINISM REGRESSIONS PASSED`);
