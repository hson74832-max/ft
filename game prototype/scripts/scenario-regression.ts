/**
 * Scenario regressions for the restart / challenge audit (2026-10-26).
 *
 * Every check pins a bug that was found by replaying a CPU-vs-CPU match and
 * watching the scenario in isolation:
 *   1. a throw-in is released INSIDE the pitch (releasing at the taker's spot,
 *      which is outside the touchline, re-awarded a throw-in every ~1 s forever)
 *   2. a penalty stages the defending keeper on his line, every other player
 *      outside the area and behind the ball, with the taker behind the ball
 *   3. a penalty is struck at the goal mouth (the out-of-play aim clamp pulled
 *      the aim 1.4 m short, so the ball was struck along the goal line) and low
 *      (no 25–40° chip from 4.2 m)
 *   4. slide tackles are reachable for a real roster (the risk product sat below
 *      both challenge gates, so no player ever slid) and actually happen in a match
 *   5. a free kick stages the taker behind the ball and a wall across the near
 *      post, but no wall for a kick almost level with the byline (the documented
 *      `fkWallMinHeight` rule was never wired up)
 *   6. a corner is delivered into the danger area (4 m+ off the goal line), not
 *      to a stationary runner standing on the keeper's near post
 *
 * Run: npm run verify:scenarios
 */
import { headlessEngineCanvas } from "./harness"; // installs the headless DOM shim on import
import assert from "node:assert/strict";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";
import { kickFacingError } from "../src/game/match/actions";
import { evaluateGkDistribution } from "../src/game/match/passPlanning";

const L = CONFIG.pitch.length / 2, W = CONFIG.pitch.width / 2, R = CONFIG.ball.radius;
const GOAL_HALF = CONFIG.pitch.goalWidth / 2;

let count = 0;
function test(name: string, check: () => void) {
  check();
  console.log(`PASS ${name}`);
  count++;
}

/** Engine with the match live, no pending restart, nothing on the clock. */
function fresh(seed = 1234): MatchEngine {
  const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
  e.rules.phase = "INPLAY";
  e.rules.pendingRestart = null;
  e.rules.time = 0;
  e.clock = 10;
  e.ball.release();
  e.ball.vel.set(0, 0, 0);
  e.ball.lastTouch = null;
  e.ball.lastTouchTeam = null;
  e.ball.kickedBy = null;
  e.ball.kickAge = 99;
  e.restartAutoT = 0;
  return e;
}

type Spot = [number, number];
const SPOTS = {
  throwIn: [6, W - 0.25] as Spot,
  throwInDeep: [18.6, W - 0.25] as Spot,
  penalty: [L - CONFIG.pitch.penaltySpotDist, 0] as Spot,
  corner: [L - 0.25, W - 0.25] as Spot,
  freeKickCentral: [12, 0] as Spot,
  freeKickWide: [17.5, 8] as Spot,
  freeKickNearLine: [18.5, 9] as Spot,
};

function forceRestart(e: MatchEngine, kind: string, pos: Spot, team = 0, seed = 1234) {
  e.rules.phase = "INPLAY";
  e.rules.pendingRestart = null;
  e.rules.time = 20;
  e.ball.release();
  e.ball.pos.set(pos[0], R, pos[1]);
  e.ball.vel.set(0, 0, 0);
  e.ball.lastTouch = null;
  e.ball.lastTouchTeam = null;
  e.ball.kickedBy = null;
  e.ball.kickAge = 99;
  e.restartAutoT = 0;
  e.rules.startSetup(kind as never, [pos[0], pos[1]], team);
  void seed;
}

/** Step until the restart is live and the ball has left the taker. */
function stepToStrike(e: MatchEngine, maxSeconds = 6, minSpeed = 3) {
  const start = e.clock;
  while (e.clock - start < maxSeconds) {
    e.step(1 / 60);
    if (e.ball.speed > minSpeed) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. Throw-ins
// ---------------------------------------------------------------------------
test("a throw-in leaves the hands inside the pitch and is not re-awarded", () => {
  for (const spot of [SPOTS.throwIn, SPOTS.throwInDeep]) {
    const e = fresh();
    forceRestart(e, "throw_in", spot, spot === SPOTS.throwInDeep ? 1 : 0);
    const eventsBefore = e.rules.events.filter((ev) => ev.type === "THROW_IN").length;
    assert.ok(stepToStrike(e), "the throw must be released");
    const b = e.ball;
    assert.ok(Math.abs(b.pos.z) <= W + 0.02, `released inside the touchline, got z=${b.pos.z.toFixed(2)}`);
    assert.ok(Math.abs(b.pos.x) <= L + 0.02, `released inside the goal line, got x=${b.pos.x.toFixed(2)}`);
    // Follow the throw: a release from outside the line used to be caught by the
    // sweep test on the very next frame and re-awarded to the other side.
    for (let i = 0; i < 60 * 2; i++) e.step(1 / 60);
    const eventsAfter = e.rules.events.filter((ev) => ev.type === "THROW_IN").length;
    assert.equal(eventsAfter, eventsBefore, "no throw-in was awarded again within 2 s of the release");
    e.dispose();
  }
});

// ---------------------------------------------------------------------------
// 2 + 3. Penalties
// ---------------------------------------------------------------------------
test("a penalty stages the keeper on his line, everyone else outside the area", () => {
  const e = fresh();
  forceRestart(e, "penalty", SPOTS.penalty);
  let checked = false;
  while (e.clock < 30 && !checked) {
    e.step(1 / 60);
    if (e.rules.phase !== "INPLAY" || !e.rules.pendingRestart) continue;
    checked = true;
    const goal = e.ai.ownGoal(1, e.rules.half);
    const gk = e.players.find((p) => p.team === 1 && p.role === "GK")!;
    assert.ok(Math.abs(gk.pos.x - goal.x) < 0.05, `keeper on the line, got ${Math.abs(gk.pos.x - goal.x).toFixed(2)} m off`);
    assert.ok(Math.abs(gk.pos.z) < GOAL_HALF, `keeper between the posts, got z=${gk.pos.z.toFixed(2)}`);
    const taker = e.players.find((p) => p.restartTaker)!;
    const ball = e.ball.pos;
    const takerDist = Math.hypot(taker.pos.x - ball.x, taker.pos.z - ball.z);
    assert.ok(takerDist > 0.7, `the taker stands behind the ball, got ${takerDist.toFixed(2)} m`);
    assert.ok(takerDist < 1.2, `the taker is still beside the ball, got ${takerDist.toFixed(2)} m`);
    for (const p of e.players) {
      if (p.team !== 1 || p.idx === gk.idx) continue;
      const inArea = Math.abs(goal.x - p.pos.x) < CONFIG.pitch.penaltyAreaDepth && Math.abs(p.pos.z) < 6.2;
      assert.ok(!inArea, `defender #${p.idx} must be outside the penalty area, at (${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)})`);
      const aheadOfBall = (p.pos.x - ball.x) * Math.sign(goal.x) > 0;
      assert.ok(!aheadOfBall, `defender #${p.idx} must be behind the ball`);
    }
  }
  assert.ok(checked, "the penalty must go live");
  e.dispose();
});

test("a penalty is struck low and at the goal mouth", () => {
  const e = fresh();
  forceRestart(e, "penalty", SPOTS.penalty);
  assert.ok(stepToStrike(e, 6, 10), "the penalty must be struck");
  const b = e.ball;
  const launchDeg = Math.atan2(b.vel.y, Math.hypot(b.vel.x, b.vel.z)) * 180 / Math.PI;
  assert.ok(launchDeg < 12, `a penalty is a low drive, not a chip (launch ${launchDeg.toFixed(1)}°)`);
  // Where does the ray cross the goal line? It must be inside the mouth.
  const goalX = L;
  const crossZ = b.pos.z + (goalX - b.pos.x) * (b.vel.z / b.vel.x);
  const crossY = b.pos.y + (goalX - b.pos.x) * (b.vel.y / b.vel.x);
  assert.ok(Math.abs(crossZ) < GOAL_HALF, `the strike is aimed inside the posts, crossing at z=${crossZ.toFixed(2)}`);
  assert.ok(crossY < CONFIG.pitch.goalHeight, `under the bar, crossing at y=${crossY.toFixed(2)}`);
  e.dispose();
});

// ---------------------------------------------------------------------------
// 4. Slide tackles
// ---------------------------------------------------------------------------
test("the roster can reach the slide-tackle gates", () => {
  const e = fresh();
  const risks = e.players.filter((p) => p.role !== "GK").map((p) => {
    // The same product the AI uses (ai.ts, `tackleRisk`).
    const style = (p as unknown as { style: { risk: number } }).style;
    const a = p.attributes;
    return style.risk * (0.5 + a.physical.aggression / 150)
      * (1.25 - a.mentality.discipline / 150) * CONFIG.tackle.riskScale;
  });
  const max = Math.max(...risks);
  assert.ok(max > 1.12, `at least one player must clear the closest-defender slide gate (max ${max.toFixed(2)})`);
  assert.ok(risks.some((r) => r < 1.02), "and the distribution still reaches both sides of the presser gate");
  e.dispose();
});

test("slide tackles happen in a live match", () => {
  const e = fresh(1234);
  let slideFrames = 0;
  for (let i = 0; i < 60 * 150; i++) {
    e.step(1 / 60);
    for (const p of e.players) if (p.anim.actionId === "tackle_slide") slideFrames++;
  }
  assert.ok(slideFrames > 0, "a slide tackle animation must run at least once in 150 s");
  e.dispose();
});

// ---------------------------------------------------------------------------
// 5. Free kicks
// ---------------------------------------------------------------------------
test("a free kick stages the taker behind the ball and a wall by the near post", () => {
  const e = fresh();
  forceRestart(e, "free_kick", SPOTS.freeKickCentral);
  let live = false;
  while (e.clock < 30 && !live) {
    e.step(1 / 60);
    if (e.rules.phase !== "INPLAY" || !e.rules.pendingRestart) continue;
    live = true;
    const taker = e.players.find((p) => p.restartTaker)!;
    const dist = Math.hypot(taker.pos.x - e.ball.pos.x, taker.pos.z - e.ball.pos.z);
    assert.ok(dist > 0.7, `the taker stands behind the ball, got ${dist.toFixed(2)} m`);
    const defenders = e.players.filter((p) => p.team === 1 && p.role !== "GK")
      .map((p) => Math.hypot(p.pos.x - e.ball.pos.x, p.pos.z - e.ball.pos.z))
      .filter((d) => d > 2.5 && d < 4.2);
    assert.ok(defenders.length >= 2, `a wall is posted 3.2 m away, got ${defenders.length} men: ${defenders.map((d) => d.toFixed(1)).join("/")}`);
    assert.ok(Math.max(...defenders) - Math.min(...defenders) < 1.2, "the wall stands on one line");
  }
  assert.ok(live, "the free kick must go live");
  e.dispose();
});

test("no wall is posted for a free kick almost level with the byline", () => {
  const e = fresh();
  forceRestart(e, "free_kick", SPOTS.freeKickNearLine);
  let live = false;
  while (e.clock < 30 && !live) {
    e.step(1 / 60);
    if (e.rules.phase !== "INPLAY" || !e.rules.pendingRestart) continue;
    live = true;
    const wall = e.players.filter((p) => p.team === 1 && p.role !== "GK")
      .map((p) => Math.hypot(p.pos.x - e.ball.pos.x, p.pos.z - e.ball.pos.z))
      .filter((d) => d > 2.5 && d < 4.2);
    // One incidental defender at marking distance is not a wall; two would be.
    assert.ok(wall.length <= 1, `no wall from a corner-flag angle, got ${wall.length} men at ${wall.map((d) => d.toFixed(1)).join("/")}`);
  }
  assert.ok(live, "the free kick must go live");
  e.dispose();
});

// ---------------------------------------------------------------------------
// 6. Corners
// ---------------------------------------------------------------------------
test("a corner is delivered into the danger area, not onto the keeper's near post", () => {
  const e = fresh();
  forceRestart(e, "corner", SPOTS.corner);
  let checked = false;
  for (let i = 0; i < 60 * 8 && !checked; i++) {
    e.step(1 / 60);
    const taker = e.players.find((p) => p.restartTaker);
    const target = taker?.pendingKick?.target;
    if (!target) continue;
    checked = true;
    const goal = e.ai.goalPos(0, e.rules.half);
    const depth = Math.abs(goal.x - target.x);
    assert.ok(depth >= 3.5, `the delivery lands at least 3.5 m off the goal line, got ${depth.toFixed(2)} m`);
    assert.ok(depth <= 10, `but still inside the box, got ${depth.toFixed(2)} m`);
    assert.ok(Math.abs(target.z) < 6.2, `inside the box width, got z=${target.z.toFixed(2)}`);
    const runner = e.players[taker!.pendingKick!.passTo ?? -1];
    assert.ok(runner && runner.team === 0 && runner.role !== "GK", "the named receiver is an outfield teammate");
    assert.ok(!runner!.restartTaker, "the taker does not name himself");
  }
  assert.ok(checked, "the corner must be planned");
  e.dispose();
});

// ---------------------------------------------------------------------------
// 7. Strike orientation
// ---------------------------------------------------------------------------
test("a stationary striker turns his body before striking a ball behind him", () => {
  const e = fresh();
  // Ten metres out, dead central, shoulders square to the goal he is attacking, and
  // standing still — exactly the situation the old facing gate skipped. It only ran
  // for a player already moving (`p.speed > 0.45`), and the AI's shot decision leaves
  // the striker stationary, so he could strike a ball that was behind his body.
  for (const p of e.players) {
    p.pos.set(-10, 0, p.idx % 2 ? 9 : -9);
    p.moveTarget.copy(p.pos);
    p.desiredSpeed = 0;
    p.vel.set(0, 0, 0);
    p.speed = 0;
  }
  const attacker = e.players.find((q) => q.team === 0 && q.role === "FWD")!;
  const goal = e.ai.goalPos(0, e.rules.half);
  attacker.pos.set(goal.x - 10, 0, 0);
  attacker.moveTarget.copy(attacker.pos);
  attacker.facing = Math.PI; // back to goal
  attacker.vel.set(0, 0, 0);
  attacker.speed = 0;
  e.ball.possess(attacker.idx, 0);
  e.ball.pos.copy(attacker.pos);
  let turned = false;
  let struck = false;
  let facingErrorAtStrike = Infinity;
  for (let i = 0; i < 60 * 5 && !struck; i++) {
    const before = e.actionLog.length;
    e.step(1 / 60);
    if (attacker.decisionReason.startsWith("Turn to face")) turned = true;
    const rec = e.actionLog.slice(Math.max(0, before > 0 ? before - 2 : 0)).find((r) => r.action.startsWith("shoot_"));
    if (rec) {
      struck = true;
      facingErrorAtStrike = kickFacingError(attacker, goal);
    }
  }
  assert.ok(struck, "the clear central striker does shoot");
  assert.ok(turned, "he pivots on the spot first instead of striking backwards");
  assert.ok(facingErrorAtStrike < CONFIG.ai.kickFacingAngle + 0.25,
    `body within the facing cone at the strike, got ${(facingErrorAtStrike * 180 / Math.PI).toFixed(0)}°`);
  e.dispose();
});

// ---------------------------------------------------------------------------
// 8. Goalkeeper distribution lead
// ---------------------------------------------------------------------------
test("a goal kick is played to where the receiver will be, not where he is now", () => {
  const e = fresh();
  const gk = e.players.find((p) => p.team === 0 && p.role === "GK")!;
  const receiver = e.players.find((p) => p.idx !== gk.idx && p.team === 0 && p.role !== "GK")!;
  for (const p of e.players) {
    if (p.idx === gk.idx || p.idx === receiver.idx) continue;
    p.pos.set(-14, 0, p.idx % 2 ? 10 : -10);
    p.vel.set(0, 0, 0);
    p.moveTarget.copy(p.pos);
    p.desiredSpeed = 0;
  }
  gk.pos.set(-18, 0, 0);
  e.ball.pos.set(-18, CONFIG.ball.radius, 0);
  e.ball.vel.set(0, 0, 0);
  // A receiver running away from goal at 4.5 m/s: a 30 m punt hangs for ~2 s, so the
  // aim point has to be ~9 m ahead of him. The old flat 0.4 s lead aimed 1.8 m ahead —
  // at a spot the ball would sail past.
  receiver.pos.set(6, 0, 3);
  receiver.vel.set(4.5, 0, 0);
  receiver.moveTarget.set(18, 0, 3);
  receiver.desiredSpeed = 4.5;
  receiver.speed = 4.5;
  const dist = evaluateGkDistribution(e, gk);
  assert.ok(dist, "the keeper finds a distribution option");
  const lead = (dist!.target.x - receiver.pos.x) * Math.sign(receiver.vel.x || 1);
  assert.ok(lead >= 2.5, `the aim point leads a running receiver, got ${lead.toFixed(2)} m ahead`);
  e.dispose();
});

console.log(`\n${count} SCENARIO REGRESSIONS PASSED`);
