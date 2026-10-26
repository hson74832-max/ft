/**
 * Goalkeeper regression: shot stopping, penalties, save geometry.
 *
 *   node .test-artifacts/keeper-regression.cjs
 *
 * Guards the save model against the two failure modes found in the audit:
 *  - a shot that arrives before the save clip's contact frame was never saved (the
 *    keeper's hands were tied to an animation event that fires 0.44 s after the dive,
 *    while a full-power shot from 12–15 m arrives in 0.30–0.42 s);
 *  - a penalty could never be saved at all, because the whole flight is shorter than
 *    the keeper's reaction time and the reaction gate froze him.
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";
import * as THREE from "three";
import { keeperReachNow } from "../src/game/match/keeper";
import { buildWorldSnap } from "../src/game/match/frame";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const L = CONFIG.pitch.length / 2;

/** Force a penalty and report what happened. */
function penalty(seed: number): { outcome: string; gkAction: string | null } {
  const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.rules.time = 20;
  e.ball.release();
  const spot: [number, number] = [L - CONFIG.pitch.penaltySpotDist, 0];
  e.ball.pos.set(spot[0], CONFIG.ball.radius, spot[1]);
  e.ball.vel.set(0, 0, 0);
  e.restartAutoT = 0;
  e.rules.startSetup("penalty", spot, 0);
  const gk = e.players.find((p) => p.team === 1 && p.role === "GK")!;
  let outcome = "none";
  let gkAction: string | null = null;
  for (let frame = 0; frame < 60 * 8; frame++) {
    const before = e.rules.events.length;
    e.step(1 / 60);
    for (let i = before; i < e.rules.events.length; i++) {
      const ev = e.rules.events[i];
      if (ev.type === "GOAL") outcome = "goal";
      else if (ev.type === "SAVE" && outcome !== "goal") outcome = "save";
    }
    if (gk.anim.actionId?.startsWith("gk_")) gkAction = gk.anim.actionId;
    if (outcome !== "none" && frame > 60 * 4) break;
  }
  e.dispose();
  return { outcome, gkAction };
}

/** Strike a clean shot from `distance` straight at the far corner and report. */
function shot(seed: number, distance: number, aimZ: number): { outcome: string; reach: number; gap: number } {
  const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.rules.time = 20;
  const shooter = e.players.find((p) => p.team === 0 && p.role === "FWD")!;
  const gk = e.players.find((p) => p.team === 1 && p.role === "GK")!;
  // Park everyone else out of the way.
  for (const p of e.players) {
    if (p.idx === shooter.idx || p.idx === gk.idx) continue;
    p.pos.set(-10, 0, p.idx % 2 === 0 ? 9 : -9);
    p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
  }
  shooter.pos.set(L - distance, 0, -3.5);
  shooter.vel.set(0, 0, 0);
  gk.pos.set(L - 2.4, 0, -1.1);
  gk.vel.set(0, 0, 0);
  gk.moveTarget.copy(gk.pos);
  e.ball.release();
  e.ball.pos.set(shooter.pos.x + 0.4, CONFIG.ball.radius, -3.0);
  const dir = new THREE.Vector3(L - e.ball.pos.x, 0, aimZ - e.ball.pos.z).normalize();
  e.ball.strike(dir, { speed: 32, loft: (5 * Math.PI) / 180, spin: new THREE.Vector3() });
  e.ball.lastTouch = shooter.idx; e.ball.lastTouchTeam = 0;
  e.ball.kickedBy = shooter.idx; e.ball.kickAge = 0;
  let outcome = "none";
  let bestReach = 0, bestGap = Infinity;
  for (let frame = 0; frame < 60 * 3; frame++) {
    const before = e.rules.events.length;
    e.step(1 / 60);
    for (let i = before; i < e.rules.events.length; i++) {
      const ev = e.rules.events[i];
      if (ev.type === "GOAL") outcome = "goal";
      else if (ev.type === "SAVE" && outcome !== "goal") outcome = "save";
    }
    const gap = Math.hypot(gk.pos.x - e.ball.pos.x, gk.pos.z - e.ball.pos.z);
    if (gap < bestGap) { bestGap = gap; bestReach = keeperReachNow(gk, e.ball.pos.z); }
    if (outcome !== "none") break;
  }
  e.dispose();
  return { outcome, reach: bestReach, gap: bestGap };
}

// ---------------------------------------------------------------- penalties
const pen = Array.from({ length: 16 }, (_, i) => penalty(1000 + i * 7));
const goals = pen.filter((p) => p.outcome === "goal").length;
const saves = pen.filter((p) => p.outcome === "save").length;
const withDive = pen.filter((p) => p.gkAction?.startsWith("gk_")).length;
check("a penalty keeper makes a save attempt (dive/parry) instead of freezing",
  withDive >= 12, `${withDive}/16 penalties had a keeper save clip (${pen.map((p) => p.gkAction ?? "-").join(",")})`);
check("penalties are not automatic goals", goals < 16, `${goals} goals / ${saves} saves / ${16 - goals - saves} off target`);
check("penalties are not automatic saves", saves < 16, `${saves}/16 saved`);

// ---------------------------------------------------------------- long shots
const long = Array.from({ length: 20 }, (_, i) => shot(2000 + i * 11, 13, 1.1));
const longGoals = long.filter((s) => s.outcome === "goal").length;
const longSaves = long.filter((s) => s.outcome === "save").length;
// A 32 m/s drive into the far corner from 13 m is a genuinely good chance: the keeper
// has 0.36 s to travel 2 m, so it is mostly a goal — but not ALWAYS one. The bug the
// audit found was that a save was physically impossible (the save used to fire on the
// dive clip's contact frame, 0.44 s after the commit, by which time the ball was in the
// net), so 0/20 was saved. A realistic band keeps both failure modes out.
check("a 13 m drive at the far corner is sometimes saved — a save is physically possible",
  longSaves >= 2, `${longSaves}/20 saved, ${longGoals} goals`);
check("a 13 m drive at the far corner is not an automatic save",
  longSaves <= 14, `${longSaves}/20 saved (a keeper must not cover a 3 m goal on his own)`);
check("a 13 m drive is still usually a goal", longGoals >= 3, `${longGoals}/20 goals`);
check("the keeper's hands are inside his physical reach when he saves",
  long.filter((s) => s.outcome === "save").every((s) => s.gap <= s.reach + 0.35),
  `worst margin ${Math.min(...long.filter((s) => s.outcome === "save").map((s) => (s.reach + 0.35 - s.gap))).toFixed(2)} m`);

// ---------------------------------------------------------------- close range
const close = Array.from({ length: 12 }, (_, i) => shot(3000 + i * 13, 3.5, 0.9));
const closeSaves = close.filter((s) => s.outcome === "save").length;
check("a point-blank shot is at least sometimes stopped (instinct, not a frozen keeper)",
  closeSaves > 0, `${closeSaves}/12 point-blank shots saved`);

// ---------------------------------------------------------------- wide shots
const wide = Array.from({ length: 8 }, (_, i) => shot(4000 + i * 17, 8, 4.0));
const wideSaves = wide.filter((s) => s.outcome === "save").length;
check("a shot going well wide is not recorded as a save", wideSaves === 0, `${wideSaves}/8 phantom saves`);

// ---------------------------------------------------------------- shot reading
// The keeper's estimate of the flight time must be the flight time. A body in the
// corridor legitimately degrades his read, but the striker is not a screen: the ball
// leaves from his feet, and counting him inflated every shot's read/timing error by
// 1.7× (the keeper then believed a 0.36 s shot had 0.7 s left and never committed).
{
  const e = new MatchEngine(headlessEngineCanvas(), { seed: 4242, headless: true, spectator: true });
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.clock = 20;
  const shooter = e.players.find((p) => p.team === 0 && p.role === "FWD")!;
  const gk = e.players.find((p) => p.team === 1 && p.role === "GK")!;
  for (const p of e.players) {
    if (p.idx === shooter.idx || p.idx === gk.idx) continue;
    p.pos.set(-12, 0, p.idx % 2 ? 9 : -9);
    p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
  }
  shooter.pos.set(L - 13.4, 0, -3.5);
  gk.pos.set(L - 2.4, 0, -1.1);
  gk.moveTarget.copy(gk.pos);
  e.ball.release();
  e.ball.pos.set(L - 13, CONFIG.ball.radius, -3.0);
  // A cleared set-piece target: the snap is rebuilt each frame from live state.
  e.step(1 / 60);
  const dir = new THREE.Vector3(L - e.ball.pos.x, 0, 0.4 - e.ball.pos.z).normalize();
  e.ball.strike(dir, { speed: 32, loft: 0.09, spin: new THREE.Vector3() });
  e.ball.kickedBy = shooter.idx; e.ball.kickAge = 0;
  const snap = buildWorldSnap(e);
  const worldGk = snap.players.find((p) => p.idx === gk.idx)!;
  const read = e.ai.readShot(worldGk, snap, e.ai.ownGoal(1, e.rules.half));
  const straight = Math.hypot(gk.pos.x - e.ball.pos.x, gk.pos.z - e.ball.pos.z);
  const truth = Math.hypot(dir.x, dir.z) > 0 ? straight / (32 * Math.hypot(dir.x, dir.z)) : 0;
  check("the keeper's read of the flight time is the flight time, not double it",
    !!read && Math.abs(read.timeLeft - truth) < Math.max(0.08, truth * 0.35),
    read ? `read ${read.timeLeft.toFixed(3)} s vs straight-line ${truth.toFixed(3)} s` : "no read");
  e.dispose();
}

// ---------------------------------------------------------------- double touch
{
  const e = new MatchEngine(headlessEngineCanvas(), { seed: 5050, headless: true, spectator: true });
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.clock = 20;
  const shooter = e.players.find((p) => p.team === 0 && p.role === "FWD")!;
  const gk = e.players.find((p) => p.team === 1 && p.role === "GK")!;
  for (const p of e.players) {
    if (p.idx === shooter.idx || p.idx === gk.idx) continue;
    p.pos.set(-12, 0, p.idx % 2 ? 9 : -9);
    p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
  }
  shooter.pos.set(L - 9, 0, -2.2);
  gk.pos.set(L - 1.2, 0, 0);
  gk.moveTarget.copy(gk.pos);
  e.ball.release();
  e.ball.pos.set(L - 8.6, CONFIG.ball.radius, -2.0);
  const dir = new THREE.Vector3(L - e.ball.pos.x, 0, 0 - e.ball.pos.z).normalize();
  e.ball.strike(dir, { speed: 28, loft: 0.05, spin: new THREE.Vector3() });
  e.ball.kickedBy = shooter.idx; e.ball.kickAge = 0;
  let saves = 0;
  for (let f = 0; f < 60 * 3; f++) {
    const before = e.rules.events.length;
    e.step(1 / 60);
    for (let i = before; i < e.rules.events.length; i++) if (e.rules.events[i].type === "SAVE") saves++;
  }
  // One shot, one save: the clip's contact frame used to fire a second, phantom parry
  // on the keeper's own rebound (a double touch on his own parry).
  check("one shot produces one save, not a second parry on the keeper's own rebound",
    saves <= 1, `${saves} SAVE events`);
  e.dispose();
}

if (failures) { console.error(`\n${failures} KEEPER REGRESSION(S) FAILED`); process.exit(1); }
console.log(`\nKEEPER REGRESSIONS PASSED`);
