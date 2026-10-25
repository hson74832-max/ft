// Regression harness for the two reported attacking problems:
//   1. off-ball players holding position instead of making runs into space
//   2. possession turning into recycling instead of progression
//
// Runs the real MatchEngine headless (no GPU) and the real tactical planner, with
// numeric assertions on the decisions and on where players physically end up.
import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import assert from "node:assert/strict";
import * as THREE from "three";
import { AIController, type WorldPlayer, type WorldSnap } from "../src/game/ai";
import { CONFIG } from "../src/game/config";
import { SeededRandom } from "../src/game/random";
import { attackDirection, groundDistance, laneSafety, onsideLimit, spaceAhead } from "../src/game/tactics";
import { MatchEngine } from "../src/game/engine";

let passed = 0;
function test(name: string, check: () => void) {
  check();
  console.log(`PASS ${name}`);
  passed++;
}

/** Same synthetic 5v5 world used by support-regression, with optional possession timing. */
function state(seed = 42, team = 0, half: 1 | 2 = 1, carrierRole = 3) {
  const ai = new AIController(new SeededRandom(seed), seed);
  const sign = attackDirection(team, half);
  const positions = [[-17, 0], [0, -1.8], [3, 8], [6, 0], [11, -4.8], [18, 0], [10, -3], [11, 4], [8, 0.5], [4, 8.7]];
  const roles = ["GK", "DEF", "DEF", "MID", "FWD"];
  const players: WorldPlayer[] = [];
  for (let local = 0; local < 10; local++) {
    const roleIdx = local % 5, playerTeam = local < 5 ? team : 1 - team;
    const idx = playerTeam * 5 + roleIdx;
    const [x, z] = positions[local];
    players.push({ idx, team: playerTeam, role: roles[roleIdx], roleIdx,
      pos: new THREE.Vector3(x * sign, 0, z), vel: new THREE.Vector3(),
      facing: 0,
      speed: 0, busy: false, uninterruptible: false, cooldowns: new Map(), stamina: 1,
      hasBall: local === carrierRole, callForBall: false, isHuman: false, runSerial: 0, style: ai.sampleStyle(roles[roleIdx]) });
  }
  players.sort((a, b) => a.idx - b.idx);
  const carrier = players[team * 5 + carrierRole];
  // The carrier keeps his attacking body angle (the run trigger reads it); every
  // other player faces the man on the ball, as the live engine orients idle players.
  carrier.facing = sign > 0 ? 0 : Math.PI;
  for (const p of players) {
    if (p === carrier) continue;
    const dx = carrier.pos.x - p.pos.x, dz = carrier.pos.z - p.pos.z;
    if (Math.hypot(dx, dz) > 0.01) p.facing = Math.atan2(-dz, dx);
  }
  const snap: WorldSnap = { ballPos: carrier.pos.clone().setY(CONFIG.ball.radius), ballVel: new THREE.Vector3(),
    ballOwner: carrier.idx, ballOwnerTeam: team, players, time: 10, half, matchSeed: seed, ballKickAge: 1, ownerSince: 9.6 };
  return { ai, snap, carrier, sign, own: players.filter((p) => p.team === team), opp: players.filter((p) => p.team !== team) };
}
function place(p: WorldPlayer, x: number, z: number, sign = 1) { p.pos.set(x * sign, 0, z); p.vel.set(0, 0, 0); }

function attachEngine(f: ReturnType<typeof state>) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed: f.snap.matchSeed, headless: true, spectator: true });
  engine.rules.phase = "INPLAY"; engine.rules.half = f.snap.half; engine.rules.pendingRestart = null; engine.clock = f.snap.time;
  for (const p of engine.players) {
    const source = f.snap.players[p.idx];
    p.pos.copy(source.pos); p.vel.copy(source.vel); p.moveTarget.copy(source.pos); p.facing = source.facing;
    p.style = { ...source.style }; p.restartTaker = false; p.pendingKick = null;
  }
  engine.ball.pos.copy(f.snap.ballPos); engine.ball.possess(f.carrier.idx, f.carrier.team);
  // The constructor ran a kickoff and seeded possession bookkeeping for its own
  // kickoff player; this fixture overrides possession to the carrier, so reset it to
  // match. Without this the first trackPossession() sees a team change that never
  // happened and opens a spurious transition window (which re-triggers runs).
  engine.seenOwner = f.carrier.idx;
  engine.seenOwnerTeam = f.carrier.team;
  engine.possessionStartedAt = f.snap.ownerSince ?? engine.clock - 0.6;
  engine.transitionUntil = 0;
  return engine;
}

// ============================================================
// 1. Space recognition: vacant space ahead produces a run
// ============================================================
test("space ahead of an unmarked runner is recognised and run into", () => {
  const f = state(7);
  place(f.carrier, 0, 0); f.snap.ballPos.copy(f.carrier.pos);
  // Both defenders are deep and wide: the channel in front is empty.
  place(f.own[1], -4, 0); place(f.own[2], 0, 8); place(f.own[4], 3, -4.8);
  place(f.opp[1], 17, -9); place(f.opp[2], 17, 9); place(f.opp[3], 18, -5); place(f.opp[4], 18, 5);
  const plan = f.ai.tactics.plan(f.snap, 0)!;
  assert(plan.trigger.active, plan.trigger.reason);
  const runs = [...plan.assignments.values()].filter((a) => a.runType === "spin" || a.runType === "drive");
  assert(runs.length > 0, JSON.stringify([...plan.assignments.values()]));
  assert(runs.some((a) => a.advance > 3), `no run travels forward: ${runs.map((a) => a.advance.toFixed(1))}`);
  assert(runs.some((a) => a.vacancy > 0.45), `run does not target vacant space: ${runs.map((a) => a.vacancy.toFixed(2))}`);
  // The run must be onside at the moment it is planned.
  for (const run of runs) assert(run.target.x <= onsideLimit(f.snap, 0) + 1e-6, `run ignores offside: ${run.target.x}`);
});

test("the run is physical: the runner travels into the space", () => {
  const f = state(7);
  place(f.carrier, 0, 0); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[1], -4, 0); place(f.own[2], 0, 8); place(f.own[4], 3, -4.8);
  place(f.opp[1], 17, -9); place(f.opp[2], 17, 9); place(f.opp[3], 18, -5); place(f.opp[4], 18, 5);
  const engine = attachEngine(f);
  // The carrier is the human player, so he holds the ball while the AI off-ball
  // players are free to make their runs.
  engine.spectator = false; engine.humanIdx = f.carrier.idx;
  const runner = engine.players[f.own[4].idx];
  const start = runner.pos.clone();
  const startGap = groundDistance(runner.pos, engine.players[f.carrier.idx].pos);
  let sawRun = false, peak = 0;
  for (let frame = 0; frame < 110; frame++) {
    engine.step(1 / 60);
    const decision = engine.ai.lastDecision.get(runner.idx);
    if (decision?.runType === "spin" || decision?.runType === "drive") sawRun = true;
    peak = Math.max(peak, runner.speed);
  }
  const travelled = (runner.pos.x - start.x) * f.sign;
  const gapGrowth = groundDistance(runner.pos, engine.players[f.carrier.idx].pos) - startGap;
  assert(sawRun, "the runner never made a run");
  assert(travelled > 4, `runner only advanced ${travelled.toFixed(1)}m`);
  assert(gapGrowth > 2, `runner did not separate from the carrier (${gapGrowth.toFixed(1)}m)`);
  assert(peak > 4, `run never reached running pace (peak ${peak.toFixed(2)} m/s)`);
  engine.dispose();
});

// ============================================================
// 2. The trigger: forward-facing carrier with time -> runs;
//    otherwise the short check is the correct movement.
// ============================================================
test("run trigger gates the runs in behind", () => {
  const f = state(11);
  place(f.carrier, 0, 0); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[1], -4, 0); place(f.own[2], 0, 8); place(f.own[4], 3, -4.8);
  place(f.opp[1], 11, -6); place(f.opp[2], 11, 6); place(f.opp[3], 14, -8); place(f.opp[4], 14, 8);
  const forward = f.ai.tactics.plan(f.snap, 0)!;
  assert(forward.trigger.active, forward.trigger.reason);
  assert([...forward.assignments.values()].some((a) => a.runType === "spin" || a.runType === "drive"), "no run with the trigger on");

  // Feed the carrier the ball again, but now he is facing his own goal and pressed.
  const g = state(11);
  place(g.carrier, 0, 0); g.snap.ballPos.copy(g.carrier.pos);
  g.carrier.facing = Math.PI;                    // looking away from goal (sign = +1)
  g.snap.ownerSince = 9.95;                      // just received: no time yet
  place(g.own[1], -4, 0); place(g.own[2], 0, 8); place(g.own[4], 3, -4.8);
  place(g.opp[1], 2.2, 1.4); place(g.opp[2], 9, 6); place(g.opp[3], 14, -8); place(g.opp[4], 14, 8);
  const backward = g.ai.tactics.plan(g.snap, 0)!;
  assert(!backward.trigger.active, backward.trigger.reason);
  assert(![...backward.assignments.values()].some((a) => a.runType === "spin"), "spun in behind without a trigger");
  const check = [...backward.assignments.values()].find((a) => a.runType === "check");
  assert(check, `no checking movement under pressure: ${JSON.stringify([...backward.assignments.values()].map((a) => [a.job, a.runType]))}`);
  const player = g.snap.players[check.player];
  assert(groundDistance(check.target, g.carrier.pos) < groundDistance(player.pos, g.carrier.pos) + 0.5,
    "the check did not shorten toward the ball");
});

test("checking to the ball offers a safe short outlet when pressed", () => {
  const f = state(23);
  place(f.carrier, -2, 0); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[1], -5, 0); place(f.own[2], -1, 5); place(f.own[4], 4, -5);
  place(f.opp[1], -1.1, 0.9);   // right on top of the carrier
  place(f.opp[2], 4, 5); place(f.opp[3], 6, -5); place(f.opp[4], 9, 0);
  const plan = f.ai.tactics.plan(f.snap, 0)!;
  assert(!plan.trigger.active, plan.trigger.reason);
  const candidates = [...plan.assignments.values()].filter((a) => a.job === "runner" || a.job === "outlet");
  const nearest = Math.min(...candidates.map((a) => groundDistance(a.target, f.carrier.pos)));
  assert(nearest <= CONFIG.tactics.runnerLead + 4, `no short outlet: ${nearest.toFixed(1)}m`);
  assert(candidates.some((a) => a.runType === "check" && a.lane > 0.4), JSON.stringify(candidates.map((a) => [a.runType, a.lane.toFixed(2)])));
});

// ============================================================
// 3. Progression: transition state, partial-lane shots, forward passes
// ============================================================
test("winning the ball opens an attacking transition state", () => {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed: 5, headless: true, spectator: true });
  engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
  engine.clock = 12;
  const set = (idx: number, x: number, z: number) => { engine.players[idx].pos.set(x, 0, z); engine.players[idx].vel.set(0, 0, 0); };
  // RED (team 0) shape in its own half; BLUE pressing.
  set(0, -18, 0); set(1, -8, 0); set(2, -6, 7); set(3, -4, 0); set(4, -2, -6);
  set(5, 18, 0); set(6, 2, 2); set(7, 4, -4); set(8, 9, 0); set(9, 12, 6);
  for (const p of engine.players) { p.facing = p.team === 0 ? 0 : Math.PI; p.moveTarget.copy(p.pos); }
  engine.ball.possess(7, 1);                       // BLUE has it
  for (let i = 0; i < 3; i++) engine.step(1 / 60);
  engine.ball.possess(3, 0);                       // RED wins it back
  for (let i = 0; i < 4; i++) engine.step(1 / 60);
  const plan = engine.ai.tactics.current(0);
  assert(plan, "no attacking plan after the turnover");
  assert(plan.phase === "transition" || plan.trigger.transition, `phase was ${plan.phase}`);
  // The first thought is forward: a pass into a forward option, or a carry forward.
  const startX = engine.players[3].pos.x;
  let forwardAction = false;
  for (let i = 0; i < 120 && !forwardAction; i++) {
    engine.step(1 / 60);
    const decision = engine.ai.lastDecision.get(3);
    const chosen = (decision?.passOptions ?? []).find((o) => o.receiver === decision?.passTo);
    if (decision?.action?.startsWith("pass_") && chosen && chosen.gain > 2) forwardAction = true;
    if (engine.players[3].pos.x - startX > 2) forwardAction = true;
  }
  assert(forwardAction, "the transition produced no forward action within 2 s");
  engine.dispose();
});

test("a partially blocked lane is still a shot", () => {
  const f = state(19);
  // 12 m out, central. One defender stands just inside the shooting cone: the lane
  // is imperfect (about 0.4), not closed.
  place(f.carrier, CONFIG.pitch.length / 2 - 12, 0); f.snap.ballPos.copy(f.carrier.pos);
  f.opp.filter((p) => p.role !== "GK").forEach((p, i) => place(p, -12 + i, i % 2 ? 10 : -10));
  place(f.opp[1], CONFIG.pitch.length / 2 - 6, 0.9);
  const lane = laneSafety(f.carrier.pos, f.ai.goalPos(0, 1), f.opp.filter((p) => p.role !== "GK"));
  assert(lane < 0.75 && lane > 0.05, `scenario is not partially blocked (lane ${lane.toFixed(2)})`);
  const decision = f.ai.think(f.carrier, 3, f.snap, 10);
  assert(decision.action?.startsWith("shoot_"), `${decision.action ?? "no action"} · ${decision.reason}`);
});

test("a progressive forward pass beats a safe square ball", () => {
  const f = state(31);
  place(f.carrier, 2, 0); f.snap.ballPos.copy(f.carrier.pos);
  // Square option: completely open but no gain. Forward option: a teammate in space.
  // A defender is on the carrier (the isolated-carrier case), not in the forward lane.
  place(f.own[1], -3, -1); place(f.own[2], 2, 8); place(f.own[4], 9, -5);
  place(f.opp[1], 2.2, 1.3); place(f.opp[2], 12, 6); place(f.opp[3], 13, -6); place(f.opp[4], 16, 0);
  const decision = f.ai.think(f.carrier, 3, f.snap, 10);
  assert(decision.action?.startsWith("pass_"), `${decision.action ?? "carry"} · ${decision.reason}`);
  const chosen = (decision.passOptions ?? []).find((o) => o.receiver === decision.passTo)!;
  assert(chosen.gain > 3, `chose a pass with gain ${chosen.gain.toFixed(1)}m`);
  assert(decision.passPurpose === "penetrate" || decision.passPurpose === "progress", String(decision.passPurpose));
});

// ============================================================
// 4. Match level: runs happen, and possession progresses
// ============================================================
test("full match: runs, run variety and progressive intent", () => {
  // Three seeds, aggregated: one match's penetrating-pass share swings between 5% and
  // 18% with identical code, so a single seed was measuring luck, not behaviour.
  const seeds = [1234, 777, 42];
  const runTypes: Record<string, number> = {};
  const episodes: { peak: number; gain: number; sign: number; startX: number }[] = [];
  const active = new Map<number, { peak: number; sign: number; startX: number }>();
  let finished = 0, offBallFrames = 0, movingFrames = 0, triggeredFrames = 0, planFrames = 0;
  let passesTotal = 0, penetratingTotal = 0, recyclesTotal = 0, shotsTotal = 0;
  for (const seed of seeds) {
    const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
    // Budget in wall time, not match time: set pieces and foul restarts freeze play, so a
    // 240 s match needs ~300 s of frames.
    for (let frame = 0; frame < 60 * 420; frame++) {
      engine.step(1 / 60);
      if (engine.rules.phase === "FULLTIME") break;
      if (!engine.rules.live || engine.rules.pendingRestart || engine.ball.possessedBy === null) { active.clear(); continue; }
      const carrier = engine.players[engine.ball.possessedBy];
      const plan = engine.ai.tactics.current(carrier.team);
      if (!plan) continue;
      planFrames++; if (plan.trigger.active) triggeredFrames++;
      const sign = attackDirection(carrier.team, engine.rules.half);
      for (const p of engine.players.filter((q) => q.team === carrier.team && q.idx !== carrier.idx && q.role !== "GK")) {
        offBallFrames++;
        const decision = engine.ai.lastDecision.get(p.idx);
        const runType = decision?.runType ?? "none";
        runTypes[runType] = (runTypes[runType] ?? 0) + 1;
        if (p.moveTarget.distanceTo(p.pos) > 2.5) movingFrames++;
        const running = runType === "spin" || runType === "drive";
        const current = active.get(p.idx);
        if (running) {
          if (!current) active.set(p.idx, { peak: p.speed, sign, startX: p.pos.x * sign });
          else current.peak = Math.max(current.peak, p.speed);
        } else if (current) {
          episodes.push({ peak: current.peak, gain: (p.pos.x - current.startX) * sign, sign, startX: current.startX });
          active.delete(p.idx);
        }
      }
    }
    for (const current of active.values()) episodes.push({ peak: current.peak, gain: 0, sign: current.sign, startX: current.startX });
    active.clear();
    if (engine.rules.phase === "FULLTIME") finished++;
    passesTotal += engine.tacticalStats.passes;
    penetratingTotal += engine.tacticalStats.penetratingPasses;
    recyclesTotal += engine.tacticalStats.recycles;
    shotsTotal += engine.tacticalStats.shots;
    const seedShare = engine.tacticalStats.penetratingPasses / Math.max(1, engine.tacticalStats.passes) * 100;
    console.log(`  seed ${seed}: ${engine.rules.score.join(":")} · passes ${engine.tacticalStats.passes} (${seedShare.toFixed(0)}% penetrating) · shots ${engine.tacticalStats.shots}`);
    engine.dispose();
  }
  const sustained = episodes.filter((run) => run.gain > 1.5 || run.peak > 4);
  const share = (k: string) => (runTypes[k] ?? 0) / Math.max(1, offBallFrames) * 100;
  const penetrateShare = penetratingTotal / Math.max(1, passesTotal) * 100;
  console.log(`  aggregate ${seeds.length} matches · passes ${passesTotal} (${penetrateShare.toFixed(0)}% penetrating, ${(recyclesTotal / Math.max(1, passesTotal) * 100).toFixed(0)}% recycled) · shots ${shotsTotal}`);
  console.log(`  off-ball runs ${sustained.length} · run share spin ${share("spin").toFixed(0)}% drive ${share("drive").toFixed(0)}% check ${share("check").toFixed(0)}% · moving ${(movingFrames / offBallFrames * 100).toFixed(0)}% · trigger ${(triggeredFrames / planFrames * 100).toFixed(0)}%`);
  assert.equal(finished, seeds.length, "a match did not finish");
  assert(share("spin") > 5, "no runs in behind during the match");
  assert(share("drive") > 1, "no driving runs during the match");
  assert(share("check") > 5, "no checking runs during the match");
  assert(sustained.length >= 12 * seeds.length, `too few committed runs: ${sustained.length}`);
  assert(movingFrames / offBallFrames > 0.4, "off-ball players are still mostly static");
  assert(penetrateShare >= 10, `only ${penetrateShare.toFixed(1)}% of passes were penetrative`);
  assert(shotsTotal > 0 && passesTotal > 0, `${shotsTotal} shots / ${passesTotal} passes`);
});

console.log(`\n${passed} ATTACKING-RUN REGRESSIONS PASSED`);
