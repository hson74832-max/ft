// Regression suite for the reported defending / kicking / vision defects.
//
//   * a throw-in for the opponent does not leave the defending side in its
//     attacking shape,
//   * a defender chases a running carrier on a straight intercept line instead of
//     a wide pursuit curve,
//   * free kicks outside shooting range are played as short / medium passes at a
//     pace the receiver can control, not as 24 m/s drives,
//   * players only act on what they have seen (field of view + decaying memory,
//     scanning, and no kicks behind the back).
import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import assert from "node:assert/strict";
import * as THREE from "three";
import { AIController, type WorldPlayer, type WorldSnap } from "../src/game/ai";
import { CONFIG } from "../src/game/config";
import { SeededRandom } from "../src/game/random";
import { MatchEngine } from "../src/game/engine";
import { yawDelta, yawOfVector } from "../src/game/angles";
import {
  believedPos, createPerception, halfAngleAt, inSight, remembered, scanHeadYaw, seesNow,
} from "../src/game/match/perception";

let count = 0;
function test(name: string, check: () => void) { check(); console.log(`PASS ${name}`); count++; }
function close(a: number, b: number, eps = 1e-6) { assert(Math.abs(a - b) <= eps, `${a} !== ${b}`); }

// ---------------------------------------------------------------- vision model

test("the field of view is a body-relative cone", () => {
  const from = new THREE.Vector3(0, 0, 0);
  const half = CONFIG.ai.visionHalfAngle;
  const range = CONFIG.ai.visionRange;
  assert(inSight(from, 0, new THREE.Vector3(6, 0, 0), half, range), "straight ahead must be visible");
  assert(inSight(from, 0, new THREE.Vector3(6, 0, 2), half, range), "inside the cone must be visible");
  assert(!inSight(from, 0, new THREE.Vector3(0, 0, 6), half, range), "90° to the side is outside the cone");
  assert(!inSight(from, 0, new THREE.Vector3(-6, 0, 0), half, range), "directly behind is outside the cone");
  assert(inSight(from, 0, new THREE.Vector3(-1.2, 0, 0), half, range), "a body at arm's length is felt, not seen");
  assert(!inSight(from, 0, new THREE.Vector3(CONFIG.ai.visionRange + 6, 0, 0), half, range), "range is limited");
  // Facing the other way flips which side of the pitch is visible.
  assert(inSight(from, Math.PI, new THREE.Vector3(-6, 0, 0), half, range), "turning the body reveals what was behind");
});

test("a sighting is remembered, then decays", () => {
  const per = createPerception(11, 7);
  const perceiver = { pos: new THREE.Vector3(0, 0, 0), facing: 0, perception: per };
  const target = new THREE.Vector3(-8, 0, 0);
  per.entities.set(4, { pos: target.clone(), vel: new THREE.Vector3(2, 0, 0), t: 10 });
  const now = 10.5;
  assert(remembered(perceiver, 4, now), "a fresh sighting is remembered");
  const believed = believedPos(perceiver, 4, target, new THREE.Vector3(), now)!;
  assert(believed, "the remembered position is usable while it lasts");
  assert(believed.x > target.x, "a remembered runner is led by the velocity last seen");
  assert.equal(remembered(perceiver, 4, 10 + CONFIG.ai.memorySeconds + 0.1), null, "the memory must decay");
  assert.equal(believedPos(perceiver, 4, target, new THREE.Vector3(), 10 + CONFIG.ai.memorySeconds + 0.1), null,
    "a forgotten opponent is no longer in the picture");
});

test("scanning widens the view and turns the head", () => {
  const per = createPerception(5, 2);
  const perceiver = { pos: new THREE.Vector3(0, 0, 0), facing: 0, perception: per };
  const side = new THREE.Vector3(0, 0, 7); // 90° off the body
  close(halfAngleAt(per, 3), CONFIG.ai.visionHalfAngle);
  assert(!seesNow(perceiver, side, 3), "not visible with the head straight");
  per.scanUntil = 3 + CONFIG.ai.scanDuration;
  close(halfAngleAt(per, 3.1), CONFIG.ai.scanHalfAngle);
  assert(seesNow(perceiver, side, 3.1), "the sweep picks up what is off to the side");
  assert(Math.abs(scanHeadYaw(per, 3 + CONFIG.ai.scanDuration / 2)) > 1,
    "the sweep is animated as a head turn");
  close(scanHeadYaw(per, 4), 0);
});

// ------------------------------------------------------- AI uses that picture

/** A 5-a-side picture where the only attractive option is the man behind the carrier. */
function visionFixture(seed: number, facing: number, memoryT: number | null) {
  const ai = new AIController(new SeededRandom(seed), seed);
  const roles = ["GK", "DEF", "DEF", "MID", "MID"];
  // #3 carries; #4 is 8 m behind him with nobody near; #1/#2 are forward but boxed
  // in by three opponents, so the forward lanes are genuinely shut.
  const spots: [number, number][] = [[-16, 0], [10, 0], [8, 3], [0, 0], [-8, 0], [4, -0.5], [5, 1.5], [3, -2], [-12, 6], [-9, -7]];
  const players: WorldPlayer[] = [];
  for (let local = 0; local < 10; local++) {
    const roleIdx = local % 5, team = local < 5 ? 0 : 1, idx = team * 5 + roleIdx, role = roles[roleIdx];
    players.push({
      idx, team, role, roleIdx,
      pos: new THREE.Vector3(spots[local][0], 0, spots[local][1]), vel: new THREE.Vector3(),
      facing, speed: 0, busy: false, uninterruptible: false, cooldowns: new Map(), stamina: 1,
      hasBall: idx === 3, callForBall: false, isHuman: false, runSerial: 0,
      style: ai.sampleStyle(role, idx), attributes: ai.sampleAttributes(role, idx),
      perception: createPerception(seed, idx),
    });
  }
  const carrier = players[3];
  if (memoryT !== null) carrier.perception!.entities.set(4, { pos: players[4].pos.clone(), vel: new THREE.Vector3(), t: memoryT });
  const snap: WorldSnap = {
    ballPos: carrier.pos.clone().setY(CONFIG.ball.radius), ballVel: new THREE.Vector3(),
    ballOwner: 3, ballOwnerTeam: 0, players, time: 10, half: 1, matchSeed: seed, ballKickAge: 1,
  };
  return { ai, snap, carrier, behind: players[4], keeper: players[0] };
}

test("a pass option has to be seen (or still remembered)", () => {
  for (const seed of [7, 11, 21]) {
    // Looking upfield: the man behind the carrier has never been seen, so he is not
    // an option — even though he is wide open and the forward lanes are shut.
    const blind = visionFixture(seed, 0, null);
    const blindOptions = blind.ai.think(blind.carrier, 3, blind.snap, 10).passOptions ?? [];
    assert(!blindOptions.some((o) => o.receiver === blind.behind.idx),
      `seed ${seed}: the teammate behind the carrier was never seen and must not be offered`);

    // The same picture, but he was seen a moment ago: now he is a legal option.
    const sighted = visionFixture(seed, 0, 9.6);
    const sightedOptions = sighted.ai.think(sighted.carrier, 3, sighted.snap, 10).passOptions ?? [];
    assert(sightedOptions.some((o) => o.receiver === sighted.behind.idx),
      `seed ${seed}: a remembered teammate must be a legal option (got ${JSON.stringify(sightedOptions.map((o) => o.receiver))})`);

    // Turning the body onto that side of the pitch is the other way to know he is there.
    const turned = visionFixture(seed, Math.PI, null);
    const turnedOptions = turned.ai.think(turned.carrier, 3, turned.snap, 10).passOptions ?? [];
    assert(turnedOptions.some((o) => o.receiver === turned.behind.idx),
      `seed ${seed}: turning onto that side reveals him`);
  }
});

test("a loose ball out of sight is not chased from ground truth", () => {
  const { ai, snap, carrier } = visionFixture(7, 0, null);
  snap.ballOwner = null; snap.ballOwnerTeam = null;
  snap.ballPos.set(-3, CONFIG.ball.radius, 0);      // behind the carrier's back
  carrier.hasBall = false;
  for (const p of snap.players) p.perception!.ball = null;
  const blind = ai.think(carrier, 3, snap, 10);
  assert(/out of sight/i.test(blind.reason), `expected a shape decision while blind, got: ${blind.reason}`);
  carrier.perception!.ball = { pos: new THREE.Vector3(2, CONFIG.ball.radius, 0), vel: new THREE.Vector3(), t: 10 };
  ai.resetDecisions();
  const chasing = ai.think(carrier, 3, snap, 10.4);
  assert(!/out of sight/i.test(chasing.reason), `a remembered ball must still be chased, got: ${chasing.reason}`);
});

// ---------------------------------------------- throw-in defending team shape

function stageThrowIn(seed: number, at: [number, number], team: number) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
  engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
  engine.rules.startSetup("throw_in", at, team);
  for (let i = 0; i < 100; i++) engine.step(1 / 60);
  const ownGoal = engine.ai.ownGoal(1 - team, engine.rules.half);
  const toOwn = ownGoal.clone().sub(engine.ball.pos).setY(0).normalize();
  const defenders = engine.players.filter((p) => p.team !== team && p.role !== "GK");
  const attackers = engine.players.filter((p) => p.team === team && p.role !== "GK" && !p.restartTaker);
  return { engine, ownGoal, toOwn, defenders, attackers };
}

test("the defending team drops into a compact block at a throw-in", () => {
  const spots: [number, number][] = [[5, -12.4], [-6, 12.4], [10, -12.4], [-12, 12.4]];
  for (const seed of [1234, 42]) {
    for (const at of spots) {
      const { engine, toOwn, defenders, attackers } = stageThrowIn(seed, at, 0);
      const ball = engine.ball.pos;
      for (const d of defenders) {
        const distance = d.pos.distanceTo(ball);
        assert(distance < 12, `defender #${d.idx} stands ${distance.toFixed(1)}m from the throw-in (seed ${seed}, ${at})`);
        const goalSide = (d.pos.x - ball.x) * toOwn.x + (d.pos.z - ball.z) * toOwn.z;
        assert(goalSide > -1.5, `defender #${d.idx} is ${goalSide.toFixed(1)}m upfield of the throw-in (attacking shape)`);
      }
      const goalSideCount = defenders.filter((d) => (d.pos.x - ball.x) * toOwn.x + (d.pos.z - ball.z) * toOwn.z > 0).length;
      assert(goalSideCount >= 3, `only ${goalSideCount}/${defenders.length} defenders are goal-side of the ball`);
      // The receivers nearest the throw must be picked up by a defender.
      const receivers = [...attackers].sort((a, b) => a.pos.distanceTo(ball) - b.pos.distanceTo(ball)).slice(0, 2);
      for (const r of receivers) {
        const nearest = Math.min(...defenders.map((d) => d.pos.distanceTo(r.pos)));
        assert(nearest < 2.6, `receiver #${r.idx} is unmarked (${nearest.toFixed(1)}m to the nearest defender)`);
      }
      engine.dispose();
    }
  }
});

// ------------------------------------------------- defender closes down the run

function chaseRun(carrierPos: [number, number], defenderPos: [number, number], seconds = 2.2) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed: 77, headless: true, spectator: false });
  engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
  for (const p of engine.players) { p.pos.set(0, 0, 20); p.vel.set(0, 0, 0); p.moveTarget.copy(p.pos); }
  const carrier = engine.players.find((p) => p.team === 0 && p.role === "FWD")!;
  const defender = engine.players.find((p) => p.team === 1 && p.role === "DEF")!;
  const keeper = engine.players.find((p) => p.team === 1 && p.role === "GK")!;
  carrier.pos.set(carrierPos[0], 0, carrierPos[1]); carrier.moveTarget.copy(carrier.pos); carrier.vel.set(0, 0, 0);
  carrier.facing = 0;
  defender.pos.set(defenderPos[0], 0, defenderPos[1]); defender.moveTarget.copy(defender.pos);
  defender.vel.set(0, 0, 0); defender.facing = Math.PI;
  keeper.pos.set(18.2, 0, 0); keeper.moveTarget.copy(keeper.pos);
  engine.ball.possess(carrier.idx, 0);
  engine.humanIdx = carrier.idx; engine.humanTeam = 0; engine.spectator = false;
  const path: THREE.Vector3[] = [defender.pos.clone()];
  let minDistance = Infinity;
  for (let f = 0; f < seconds * 60; f++) {
    engine.keys.add("d"); engine.keys.add("shift");   // the human carrier runs straight at goal
    engine.step(1 / 60);
    path.push(defender.pos.clone());
    minDistance = Math.min(minDistance, defender.pos.distanceTo(carrier.pos));
  }
  let length = 0;
  for (let i = 1; i < path.length; i++) length += path[i].distanceTo(path[i - 1]);
  const start = path[0], end = path[path.length - 1];
  const straight = start.distanceTo(end);
  let lateral = 0;
  const dir = end.clone().sub(start).setY(0);
  const len = dir.length() || 1;
  for (const q of path) {
    const rel = q.clone().sub(start);
    lateral = Math.max(lateral, Math.abs(rel.x * -dir.z / len + rel.z * dir.x / len));
  }
  engine.dispose();
  return { minDistance, length, straight, lateral };
}

test("a defender meets the run on a straight line instead of a wide curve", () => {
  const cases: { carrier: [number, number]; defender: [number, number] }[] = [
    { carrier: [0, 0], defender: [6, 8] },
    { carrier: [-2, -3], defender: [4, 5] },
    { carrier: [0, 0], defender: [8, -6] },
  ];
  for (const c of cases) {
    const run = chaseRun(c.carrier, c.defender);
    const ratio = run.length / Math.max(0.1, run.straight);
    assert(run.minDistance < 2.4,
      `defender never closed the carrier (${run.minDistance.toFixed(2)}m) from ${JSON.stringify(c)}`);
    assert(ratio < 1.45,
      `approach was a curve: ${run.length.toFixed(1)}m travelled for ${run.straight.toFixed(1)}m of ground (${JSON.stringify(c)})`);
    assert(run.lateral < 2.2,
      `defender ran ${run.lateral.toFixed(1)}m wide of a straight line (${JSON.stringify(c)})`);
  }
});

// -------------------------------------------------------------- free-kick play

function freeKick(at: [number, number], seed = 4242) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
  engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
  engine.rules.startSetup("free_kick", at, 0);
  let release = -1, receiver = -1, arrivalSpeed = -1, trapped = false;
  for (let i = 0; i < 60 * 6; i++) {
    engine.step(1 / 60);
    if (release < 0 && engine.passLog.length) {
      release = engine.clock;
      receiver = engine.passLog[0].receiver;
    }
    if (release > 0 && engine.ball.possessedBy === null) {
      const r = engine.players[receiver];
      if (arrivalSpeed < 0 && engine.ball.pos.distanceTo(r.pos) < 1.8) {
        arrivalSpeed = Math.hypot(engine.ball.vel.x, engine.ball.vel.z);
      }
      if (engine.ball.pos.distanceTo(r.pos) < 1.4 && engine.ball.pos.y < 0.9
        && Math.hypot(engine.ball.vel.x, engine.ball.vel.z) < CONFIG.player.maxTrapSpeed) trapped = true;
    }
    if (release > 0 && engine.ball.possessedBy === receiver) { trapped = true; break; }
    if (engine.tacticalStats.shots > 0) break;
  }
  const log = engine.passLog[0];
  const result = {
    action: log?.action ?? null, speed: log?.speed ?? 0, distance: log?.distance ?? 0,
    receiver, arrivalSpeed, trapped, shots: engine.tacticalStats.shots,
  };
  engine.dispose();
  return result;
}

test("free kicks outside shooting range are played short, at a controllable pace", () => {
  for (const at of [[-5, 0], [2, 6], [-8, 4], [-12, 8]] as [number, number][]) {
    const fk = freeKick(at);
    assert(fk.action && fk.action !== "pass_long",
      `FK at ${JSON.stringify(at)} was launched long (${fk.action}) even though short options exist`);
    assert(fk.speed <= CONFIG.player.maxTrapSpeed,
      `FK at ${JSON.stringify(at)} was driven at ${fk.speed.toFixed(1)} m/s (trap limit ${CONFIG.player.maxTrapSpeed})`);
    if (fk.distance <= 12) {
      assert(fk.trapped, `FK at ${JSON.stringify(at)} was not controlled by the named receiver`);
      assert(fk.arrivalSpeed < 0 || fk.arrivalSpeed <= CONFIG.player.maxTrapSpeed + 0.5,
        `ball still travelling at ${fk.arrivalSpeed.toFixed(1)} m/s when it reached the receiver`);
    }
  }
});

test("a free kick inside shooting range is still a shot", () => {
  const fk = freeKick([14, 0]);
  assert.equal(fk.shots, 1, "the taker should shoot from inside shooting range");
});

// ------------------------------------------------- no kick behind the back

test("the ball never leaves in a direction the body is not facing", () => {
  for (const seed of [1234, 777, 42]) {
    const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
    const dt = 1 / 60;
    let previousAge = 99;
    const errors: number[] = [];
    for (let f = 0; f < 240 / dt; f++) {
      engine.step(dt);
      const ball = engine.ball;
      if (ball.kickedBy !== null && ball.kickAge < previousAge && ball.possessedBy === null) {
        const entry = engine.actionLog[engine.actionLog.length - 1];
        const strike = entry && entry.player === ball.kickedBy
          && (entry.action.startsWith("pass_") || entry.action.startsWith("shoot_")
            || entry.action === "gk_punt" || entry.action === "gk_roll"
            || entry.action === "corner_kick" || entry.action === "throw_in");
        if (strike) {
          const kicker = engine.players[ball.kickedBy];
          const departure = yawOfVector({ x: ball.vel.x, z: ball.vel.z });
          errors.push(Math.abs(yawDelta(kicker.facing, departure)) * 180 / Math.PI);
        }
      }
      previousAge = ball.kickAge;
      if (engine.rules.phase === "FULLTIME") break;
    }
    engine.dispose();
    const worst = Math.max(...errors);
    const behindTheBack = errors.filter((e) => e > 80).length;
    assert(errors.length > 20, `seed ${seed}: too few kicks to judge (${errors.length})`);
    assert(behindTheBack === 0,
      `seed ${seed}: ${behindTheBack}/${errors.length} kicks left more than 80° away from the body (worst ${worst.toFixed(0)}°)`);
  }
});

console.log(`\n${count} PERCEPTION / RESTART REGRESSIONS PASSED`);
