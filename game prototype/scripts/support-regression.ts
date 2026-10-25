import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import assert from "node:assert/strict";
import * as THREE from "three";
import { AIController, type WorldPlayer, type WorldSnap } from "../src/game/ai";
import { CONFIG } from "../src/game/config";
import { SeededRandom } from "../src/game/random";
import { TeamTactics, attackDirection, groundDistance, laneSafety, onsideLimit } from "../src/game/tactics";
import { MatchEngine } from "../src/game/engine";
import { resolveNamedReceiver } from "../src/game/passing";


let count = 0;
function test(name: string, check: () => void) { check(); console.log(`PASS ${name}`); count++; }
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
    ballOwner: carrier.idx, ballOwnerTeam: team, players, time: 10, half, matchSeed: seed, ballKickAge: 1 };
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

test("keeper is a legal named receiver, opponents/self still rejected", () => {
  const f = state();
  assert.equal(resolveNamedReceiver(f.snap.players, f.carrier, f.own[0].idx, true), f.own[0]);
  assert.equal(resolveNamedReceiver(f.snap.players, f.carrier, f.opp[0].idx, true), null);
  assert.equal(resolveNamedReceiver(f.snap.players, f.carrier, f.carrier.idx, true), null);
});

test("AI and engine launch a safe keeper recycle when field options are marked", () => {
  const f = state(22);
  place(f.carrier, -7, 2); f.snap.ballPos.copy(f.carrier.pos).setY(CONFIG.ball.radius);
  place(f.own[0], -14, -2); place(f.own[1], -3, 5); place(f.own[2], -6, 8); place(f.own[4], 1, -2);
  place(f.opp[1], -5.5, 2); place(f.opp[2], -2.5, 5); place(f.opp[3], -5.4, 8); place(f.opp[4], 1.5, -2);
  const engine = attachEngine(f);
  engine.step(1 / 60);
  const decision = engine.ai.lastDecision.get(f.carrier.idx)!;
  assert.equal(decision.passTo, f.own[0].idx, decision.reason);
  assert.equal(engine.players[f.carrier.idx].pendingKick?.passTo, f.own[0].idx);
  for (let i = 0; i < 45 && !engine.passLog.length; i++) engine.step(1 / 60);
  assert(engine.passLog.length && engine.passLog[0].receiver === f.own[0].idx, "keeper pass never released");
  assert(engine.passLog[0].aimDot > Math.cos(CONFIG.ai.passAimConeDegrees * Math.PI / 180));
  assert.equal(engine.ball.handsRestrictedTeam, f.carrier.team);
  engine.dispose();
});

test("keeper controls a deliberate backpass with feet, not hands", () => {
  const engine = attachEngine(state(31));
  for (const p of engine.players) { p.pos.set(12, 0, p.idx % 2 ? 9 : -9); p.vel.set(0, 0, 0); }
  const keeper = engine.players[0]; keeper.pos.set(-17, 0, 0); keeper.moveTarget.copy(keeper.pos);
  engine.ball.release(); engine.ball.pos.set(-16.55, CONFIG.ball.radius, 0); engine.ball.vel.set(-5, 0, 0);
  engine.ball.lastTouch = 1; engine.ball.lastTouchTeam = 0; engine.ball.handsRestrictedTeam = 0;
  engine.passFlight = { team: 0, passer: 1, receiver: 0, target: keeper.pos.clone(), launchedAt: 9.8, arrivesAt: 10.1, expiresAt: 11 };
  engine.step(1 / 60);
  assert.equal(engine.ball.possessedBy, keeper.idx);
  assert.equal(keeper.anim.actionId, "first_touch");
  assert.equal(engine.tacticalStats.keeperFootControls, 1);
  assert(!engine.rules.events.some((e) => e.type === "SAVE"));
  engine.dispose();
});

test("marked touchline loses to a half-space or deeper outlet", () => {
  const f = state(18);
  place(f.carrier, 1, 5); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[1], -4, 0); place(f.own[2], 1, 9); place(f.own[4], 6, -4);
  place(f.opp[1], 3.5, 8.2); place(f.opp[2], -1, 8.2); place(f.opp[3], 10, -3); place(f.opp[4], 13, 6);
  const planner = new TeamTactics();
  const plan = planner.plan(f.snap, 0)!;
  const outlet = [...plan.assignments.values()].find((a) => a.job === "outlet")!;
  assert(outlet.mode.includes("half-space") || outlet.target.x < f.carrier.pos.x - 2, JSON.stringify(outlet));
  assert(outlet.target.distanceTo(f.carrier.pos) >= 3);
});

test("support jobs persist under small ball and marker movements", () => {
  const f = state();
  const initial = f.ai.tactics.plan(f.snap, 0)!;
  const assignments = [...initial.assignments.values()].map((a) => [a.player, a.job]);
  for (let frame = 1; frame <= 90; frame++) {
    f.snap.time += 1 / 60;
    f.snap.ballPos.z += Math.sin(frame) * 0.002; f.carrier.pos.z = f.snap.ballPos.z;
    assert.deepEqual([...f.ai.tactics.plan(f.snap, 0)!.assignments.values()].map((a) => [a.player, a.job]), assignments);
  }
});

test("keeper possession keeps short outlets and a high target instead of everyone dropping", () => {
  const f = state(51, 0, 1, 0);
  const jobs = [...f.ai.tactics.plan(f.snap, 0)!.assignments.values()];
  assert.equal(jobs.filter((a) => a.job === "outlet").length, 2);
  const runner = jobs.find((a) => a.job === "runner")!;
  const pivot = jobs.find((a) => a.job === "pivot")!;
  assert(groundDistance(runner.target, f.carrier.pos) > 19);
  assert(groundDistance(pivot.target, f.carrier.pos) < 13);
  assert(pivot.target.x > f.carrier.pos.x && Math.abs(pivot.target.z) <= CONFIG.tactics.pivotHalfWidth);
});

test("runner times onside staging then attacks space after release", () => {
  const f = state(8);
  place(f.carrier, 1, 0); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[4], 7.5, -4.8); place(f.opp[1], 9, -1.5); place(f.opp[2], 9, 3);
  const before = f.ai.think(f.own[4], 4, f.snap, 10);
  assert(before.moveTarget.x <= 9 - CONFIG.ai.offsideBuffer);
  assert.equal(before.supportJob, "runner");
  const target = new THREE.Vector3(12, 0, -4.8);
  f.snap.ballOwner = null; f.snap.ballOwnerTeam = null; f.snap.time += 0.1;
  f.snap.passFlight = { team: 0, passer: f.carrier.idx, receiver: f.own[4].idx, target, launchedAt: 10, arrivesAt: 11, expiresAt: 12 };
  f.own[4].hasBall = false;
  const after = f.ai.think(f.own[4], 4, f.snap, 10.1);
  assert(after.moveTarget.equals(target));
  assert(after.moveTarget.x > onsideLimit(f.snap, 0));
  const pivot = [...f.ai.tactics.plan(f.snap, 0)!.assignments.values()].find((a) => a.job === "pivot")!;
  assert(Math.abs(pivot.target.z) <= CONFIG.tactics.pivotHalfWidth && pivot.target.x < 9);
});

test("progressive run is preferred to a congested central exchange", () => {
  const f = state(91);
  place(f.carrier, 1, 0); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[4], 6, -4.8); place(f.own[2], 3, 0); place(f.own[1], -5, 0);
  place(f.opp[1], 3, 0.8); place(f.opp[2], 7, 3); place(f.opp[3], 4, 1.5); place(f.opp[4], 10, 7);
  const d = f.ai.think(f.carrier, 3, f.snap, 10);
  assert.equal(d.passTo, f.own[4].idx, `${d.reason} ${JSON.stringify(d.passOptions)}`);
  assert.equal(d.passPurpose, "penetrate");
});

test("direct blocker closes a lane, a player beyond the target does not", () => {
  const f = state();
  const a = new THREE.Vector3(0, 0, 0), b = new THREE.Vector3(10, 0, 0);
  place(f.opp[1], 5, 0); assert.equal(laneSafety(a, b, [f.opp[1]]), 0);
  place(f.opp[1], 12, 0); assert.equal(laneSafety(a, b, [f.opp[1]]), 1);
});

test("central cover is reached physically, not just assigned a label", () => {
  const f = state(17);
  place(f.carrier, 6, 7); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[1], -1, -9); place(f.own[2], 0, 9); place(f.own[4], 9, -9);
  f.opp.forEach((p, i) => place(p, -17 + i * 0.2, i % 2 ? 10 : -10));
  const engine = attachEngine(f);
  engine.spectator = false; engine.humanIdx = f.carrier.idx;
  for (let frame = 0; frame < 180; frame++) engine.step(1 / 60);
  assert(engine.players.some((p) => p.team === 0 && p.role !== "GK" && p.idx !== f.carrier.idx
    && Math.abs(p.pos.z) <= 3.7 && p.pos.x < engine.players[f.carrier.idx].pos.x - 1.5),
  JSON.stringify(engine.players.filter((p) => p.team === 0).map((p) => [p.idx, p.pos.x, p.pos.z, p.supportJob])));
  engine.dispose();
});

test("an available finesse shot is not blocked by the normal-shot cooldown", () => {
  const f = state(14);
  place(f.carrier, 13, 0); f.snap.ballPos.copy(f.carrier.pos);
  f.opp.filter((p) => p.role !== "GK").forEach((p, i) => place(p, -6, i % 2 ? 9 : -9));
  f.carrier.cooldowns.set("shoot_normal", 1);
  assert.equal(f.ai.think(f.carrier, 3, f.snap, 10).action, "shoot_finesse");
  f.carrier.busy = true; f.carrier.uninterruptible = true; f.snap.time = 11;
  assert.equal(f.ai.think(f.carrier, 3, f.snap, 11).action, null);
});

test("an open advance is not replaced by a needless short central return pass", () => {
  const f = state(77);
  place(f.carrier, -5, 0); f.snap.ballPos.copy(f.carrier.pos);
  place(f.own[1], -8, 0); place(f.own[2], -10, 6); place(f.own[4], -9, -6);
  f.opp.forEach((p, i) => place(p, 15 + i * 0.4, i % 2 ? 10 : -10));
  f.snap.lastPass = { passer: f.own[1].idx, receiver: f.carrier.idx, team: 0, t: 9.8 };
  const d = f.ai.think(f.carrier, 3, f.snap, 10);
  assert.equal(d.action, null, d.reason);
  assert(d.moveTarget.x > f.carrier.pos.x + 2 && d.reason.startsWith("ADVANCE"));
});

for (const team of [0, 1]) for (const half of [1, 2] as const) {
  test(`central cover for every carrier role (${team}/${half})`, () => {
    for (const role of [1, 2, 3, 4]) {
      const f = state(42, team, half, role);
      place(f.carrier, 6, 7, f.sign); f.snap.ballPos.copy(f.carrier.pos);
      const jobs = [...f.ai.tactics.plan(f.snap, team)!.assignments.values()];
      const pivot = jobs.find((j) => j.job === "pivot")!;
      assert(pivot && pivot.player !== f.carrier.idx);
      assert(Math.abs(pivot.target.z) <= CONFIG.tactics.pivotHalfWidth);
      assert(pivot.target.x * f.sign < f.carrier.pos.x * f.sign - 3);
      assert.equal(jobs.filter((j) => j.job === "runner").length, 1);
      assert.equal(jobs.filter((j) => j.job === "outlet").length, 1);
      assert.equal(new Set(jobs.map((j) => j.player)).size, jobs.length);
      assert(jobs.find((j) => j.job === "keeper-outlet"));
    }
  });
  test(`blocked forward lanes recycle to pivot (${team}/${half})`, () => {
    for (let seed = 1; seed <= 16; seed++) {
      const f = state(seed, team, half);
      place(f.own[1], 0, -1.5, f.sign); place(f.own[2], 8, 8, f.sign); place(f.own[4], 11, -4.8, f.sign);
      place(f.opp[1], 7.3, 0, f.sign); place(f.opp[2], 11, -4.2, f.sign);
      place(f.opp[3], 8, 7.4, f.sign); place(f.opp[4], 9, 1.7, f.sign);
      const d = f.ai.think(f.carrier, 3, f.snap, 10);
      assert.equal(d.passTo, f.own[1].idx, `${d.reason} ${JSON.stringify(d.passOptions)}`);
      assert.equal(d.passPurpose, "recycle");
      assert(d.action?.startsWith("pass_"));
    }
  });
  test(`far side comes inside and near side stays available (${team}/${half})`, () => {
    const f = state(18, team, half);
    place(f.carrier, 0, 10, f.sign); f.snap.ballPos.copy(f.carrier.pos);
    place(f.own[1], -4, -1, f.sign); place(f.own[2], 0, 8, f.sign); place(f.own[4], 5, -10.8, f.sign);
    const plan = f.ai.tactics.plan(f.snap, team)!;
    const runner = plan.assignments.get(f.own[4].idx)!;
    assert.equal(runner.job, "runner");
    assert(Math.abs(runner.target.z) <= CONFIG.tactics.farSideMaxWidth + 0.1);
    assert(groundDistance(runner.target, f.carrier.pos) <= CONFIG.tactics.runnerMaxDistance);
    assert(runner.target.x * f.sign > 2);
    assert(runner.target.x * f.sign <= onsideLimit(f.snap, team));
    const outlet = [...plan.assignments.values()].find((a) => a.job === "outlet")!;
    assert(outlet.target.z > 4, `near-side outlet lost width: ${outlet.target.z}`);
    assert(outlet.target.distanceTo(runner.target) > CONFIG.tactics.minSupportGap);
  });
  test(`clear edge-of-area shot beats square/back pass (${team}/${half})`, () => {
    for (const dist of [6, 10, 14]) {
      const f = state(13, team, half);
      place(f.carrier, CONFIG.pitch.length / 2 - dist, 0, f.sign); f.snap.ballPos.copy(f.carrier.pos);
      f.opp.filter((p) => p.role !== "GK").forEach((p, i) => place(p, -10 + i, i % 2 ? 9 : -9, f.sign));
      const d = f.ai.think(f.carrier, 3, f.snap, 10);
      assert(d.action?.startsWith("shoot_"), d.reason);
    }
  });
}

console.log(`\n${count} SUPPORT REGRESSIONS PASSED`);