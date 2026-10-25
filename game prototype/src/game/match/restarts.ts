// Restart setup and execution: kickoff staging, corner/goal-kick/throw-in shape,
// the taker's sampled delivery, and the watchdog that keeps a restart from stalling.
import * as THREE from "three";
import { CONFIG, FORMATIONS } from "../config";
import { AnimationController } from "../anims";
import { RulesEngine } from "../rules";
import { SeededRandom, streamSeed, tieBreakHash } from "../random";
import { kickoffRestartViolation } from "../restartRules";
import { _v1 } from "./scratch";
import { startAction } from "./actions";
import { aiEvent } from "./debug";
import { evaluateGkDistribution } from "./passPlanning";
import { resetTackleState } from "./tackles";
import type { EnginePlayer, GkDistribution, RestartTarget } from "./types";
import type { MatchHost } from "./host";

/** Re-stage every player for a kickoff or for the pending restart. */
export function resetPositions(e: MatchHost, kind: string) {
  e.ai.tactics.reset();
  e.passFlight = undefined; e.lastPass = undefined; e.frameWorld = null;
  e.ball.handsRestrictedTeam = null;
  e.offsideCandidates.clear(); e.offsideTeam = null;
  const halfFlip = e.rules.half === 2 ? -1 : 1;
  const stagingKey = `kickoff:${e.rules.half}:${e.rules.pendingRestart?.id ?? 0}:${Math.round(e.clock * 100)}`;
  // A local stream keeps a manual reset from shifting the live match RNG. It is
  // derived from match state, so replaying the same inputs still reproduces it.
  const stagingRng = new SeededRandom(streamSeed(e.matchSeed, stagingKey));
  for (const p of e.players) {
    const [hx, hz] = FORMATIONS[p.team === 0 ? "RED" : "BLUE"][p.roleIdx].home;
    p.pos.set(hx * halfFlip, 0, hz); p.vel.set(0, 0, 0);
    p.moveTarget.copy(p.pos);
    p.facing = e.ai.attackSign(p.team, e.rules.half) > 0 ? 0 : Math.PI;
    p.pendingKick = null; p.restartTaker = false; p.callForBall = false;
    p.holdT = 0; p.stumbleT = 0;
    resetTackleState(p);
    p.decisionReason = "reset"; p.utilities = {};
    p.supportJob = undefined; p.supportRun = undefined; p.supportMode = undefined;
    p.passOptions = undefined;
    p.runSerial = 0; p.desiredSpeed = 0;
    p.anim = new AnimationController();
    p.anim.locoPhase = tieBreakHash(e.matchSeed, p.idx, 0, stagingKey) * Math.PI * 2;
  }
  const ctr = kind === "kickoff" ? 0 : e.rules.pendingRestart?.pos[0] ?? 0;
  const ctz = kind === "kickoff" ? 0 : e.rules.pendingRestart?.pos[1] ?? 0;
  e.ball.pos.set(ctr, CONFIG.ball.radius, ctz);
  e.ball.vel.set(0, 0, 0); e.ball.release();
  if (kind === "kickoff") {
    const kickTeam = e.rules.pendingRestart?.team ?? e.rules.initialKickoffTeam;
    const sign = e.ai.attackSign(kickTeam, e.rules.half);
    // Derive the two kickoff candidates from the roster instead of assuming
    // exactly five players per team and fixed indices 3 and 4.
    const attackers = e.players.filter((p) => p.team === kickTeam && (p.role === "MID" || p.role === "FWD"));
    const outfield = e.players.filter((p) => p.team === kickTeam && p.role !== "GK");
    const candidates = (attackers.length >= 2 ? attackers : outfield).slice(0, 2);
    const kicker = candidates.length
      ? stagingRng.weighted(candidates.map((p) => ({ value: p, weight: p.style.directness + p.style.creativity * 0.45 })))
      : null;
    if (kicker) {
      // Kickoff staging uses separated lanes; avoid clamping every player onto one x-coordinate.
      for (const p of e.players) {
        const attack = e.ai.attackSign(p.team, e.rules.half);
        if (p.team === kickTeam) {
          if (p.role === "GK") p.pos.set(-attack * 17.8, 0, 0);
          else if (p.role === "DEF") p.pos.set(-attack * 9, 0, p.roleIdx === 1 ? -5.4 : 5.4);
          else if (p.idx !== kicker.idx && !candidates.some((q) => q.idx === p.idx)) {
            p.pos.set(-attack * 6.4, 0, p.roleIdx % 2 ? -4.4 : 4.4);
          }
        } else {
          // Opponents begin beyond the centre circle in their own half.
          if (p.role === "GK") p.pos.set(-attack * 17.8, 0, 0);
          else if (p.role === "DEF") p.pos.set(-attack * 8.8, 0, p.roleIdx === 1 ? -5.4 : 5.4);
          else if (p.role === "MID") p.pos.set(-attack * 6.4, 0, -3.1);
          else p.pos.set(-attack * 4.9, 0, 2.2);
        }
        p.moveTarget.copy(p.pos);
        p.vel.set(0, 0, 0);
      }
      const support = candidates.find((p) => p.idx !== kicker.idx)
        ?? outfield.find((p) => p.idx !== kicker.idx);
      kicker.pos.set(-sign * 0.52, 0, 0);
      if (support) {
        support.pos.set(-sign * 3.35, 0, kicker.idx % 2 ? 1.55 : -1.55);
        support.moveTarget.copy(support.pos);
      }
      kicker.moveTarget.copy(kicker.pos);
      kicker.facing = sign > 0 ? 0 : Math.PI;
      kicker.restartTaker = true;
      e.ball.possess(kicker.idx, kickTeam);
    }
  }
  // A manual mid-match reset (or a kickoff re-stage) must not leave restart
  // bookkeeping dangling behind a setup that no longer exists.
  e.restartStartedId = -1; e.restartLaunchedId = -1; e.restartRetries = 0; e.restartContactT = 0;
  if (e.rules.pendingRestart && e.rules.pendingRestart.kind !== "kickoff") e.rules.pendingRestart = null;
  e.restartAutoT = 0.6;
  e.ai.resetDecisions();
  e.lastAppliedDecision.clear();
}

/** Shape the pitch for the pending restart: taker, runners, defenders. */
export function placeForRestart(e: MatchHost) {
  const pr = e.rules.pendingRestart;
  if (!pr) return;
  e.ai.tactics.reset(); e.ai.resetDecisions();
  e.passFlight = undefined; e.frameWorld = null;
  e.ball.handsRestrictedTeam = null;
  // A stale offside snapshot from the move that led to the restart must not
  // survive into the restart setup (captureOffsideAtKick re-snaps at the kick).
  e.offsideCandidates.clear(); e.offsideTeam = null;
  if (pr.kind === "kickoff") resetPositions(e, "kickoff");
  else {
    e.ball.pos.set(pr.pos[0], CONFIG.ball.radius, pr.pos[1]);
    e.ball.vel.set(0, 0, 0); e.ball.release();
    for (const p of e.players) {
      const [hx, hz] = FORMATIONS[p.team === 0 ? "RED" : "BLUE"][p.roleIdx].home;
      p.pos.set(hx * (e.rules.half === 2 ? -1 : 1), 0, hz);
      p.vel.set(0, 0, 0);
      p.pendingKick = null; p.restartTaker = false; p.callForBall = false;
      p.holdT = 0; p.stumbleT = 0;
      resetTackleState(p);
      p.decisionReason = "restart setup"; p.utilities = {};
      p.supportJob = undefined; p.supportRun = undefined; p.supportMode = undefined;
      p.passOptions = undefined;
      p.runSerial = 0;
      p.desiredSpeed = 0; p.moveTarget.copy(p.pos);
      p.anim = new AnimationController();
      p.anim.locoPhase = tieBreakHash(e.matchSeed, p.idx, pr.id, "restart-loco") * Math.PI * 2;
    }
    const sign = e.ai.attackSign(pr.team, e.rules.half);
    const takers = e.players.filter((p) => p.team === pr.team && (pr.kind === "goal_kick" ? p.role === "GK" : p.role !== "GK"));
    // Kickoffs never reach this branch — resetPositions stages their taker.
    const selectTaker = () => {
      if (pr.kind === "goal_kick") return takers[0] ?? null;
      // Throw-ins and corners are taken by the closest eligible outfielder to the exit point / flag.
      const ranked = [...takers].sort((a, b) => {
        const da = Math.hypot(a.pos.x - pr.pos[0], a.pos.z - pr.pos[1]);
        const db = Math.hypot(b.pos.x - pr.pos[0], b.pos.z - pr.pos[1]);
        if (Math.abs(da - db) > 1.4) return da - db;
        return tieBreakHash(e.matchSeed, a.idx, a.runSerial, `restart:${pr.id}`) - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `restart:${pr.id}`);
      });
      if (pr.kind === "free_kick" || pr.kind === "penalty") {
        return [...ranked].sort((a, b) => b.style.creativity - a.style.creativity || b.style.shooting - a.style.shooting)[0];
      }
      return ranked[0] ?? null;
    };
    const taker = selectTaker();
    if (taker) {
      if (pr.kind === "throw_in") {
        taker.pos.set(pr.pos[0], 0, Math.sign(pr.pos[1]) * (CONFIG.pitch.width / 2 - 0.18));
      } else if (pr.kind === "goal_kick") {
        const side = Math.sign(pr.pos[0]);
        taker.pos.set(side * (CONFIG.pitch.length / 2 - 2.0), 0, pr.pos[1]);
      } else taker.pos.set(pr.pos[0], 0, pr.pos[1]);
      taker.moveTarget.copy(taker.pos); taker.desiredSpeed = 0;
      taker.restartTaker = true;
      const targetGuess = e.ai.goalPos(pr.team, e.rules.half);
      if (pr.kind === "throw_in") targetGuess.set(pr.pos[0] + sign * 5, 0, -Math.sign(pr.pos[1]) * 7);
      taker.facing = Math.atan2(-(targetGuess.z - taker.pos.z), targetGuess.x - taker.pos.x);
      if (pr.kind !== "throw_in") e.ball.possess(taker.idx, taker.team);
      if (pr.kind === "corner") {
        const goalX = e.ai.goalPos(pr.team, e.rules.half).x;
        const cornerSide = Math.sign(pr.pos[1]) || 1;
        // The taker stands OUTSIDE the field, behind the ball relative to the box, with
        // the flag between him and the goal line — never on the pitch side of the ball.
        // Behind the ball, outside the touchline: the flag sits between him and the goal line.
        taker.pos.set(goalX - sign * 0.75, 0, cornerSide * (CONFIG.pitch.width / 2 + 0.55));
        taker.moveTarget.copy(taker.pos);
        // Facing into the box: shoulders square to the penalty spot.
        taker.facing = Math.atan2(-(0 - taker.pos.z), (goalX - sign * 4.2) - taker.pos.x);
        // Lofted long delivery into the danger area: near post, penalty spot, far post, edge.
        const runnerSpots: [number, number][] = [
          [goalX - sign * 2.6, cornerSide * 1.4],    // near post
          [goalX - sign * 4.2, 0],                    // penalty spot
          [goalX - sign * 2.2, -cornerSide * 2.8],   // far post
          [goalX - sign * 6.4, -cornerSide * 1.6],   // edge of box
        ];
        const runners = e.players.filter((p) => p.team === pr.team && p.idx !== taker.idx && p.role !== "GK")
          .sort((a, b) => (b.role === "FWD" ? 1 : 0) - (a.role === "FWD" ? 1 : 0));
        runners.forEach((p, i) => {
          const spot = runnerSpots[i % runnerSpots.length];
          p.pos.set(spot[0], 0, spot[1]);
          p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0);
        });
        const defenders = e.players.filter((p) => p.team !== pr.team && p.role !== "GK");
        defenders.forEach((p, i) => {
          const spot = runnerSpots[i % runnerSpots.length];
          const goalSide = new THREE.Vector3(spot[0], 0, spot[1]).lerp(new THREE.Vector3(goalX, 0, spot[1]), 0.35);
          p.pos.set(goalSide.x, 0, goalSide.z);
          p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0);
        });
      }
      if (pr.kind === "goal_kick") {
        // Create genuine short and long options rather than one central punt:
        // defenders wide and short, midfield high between the lines, forward long.
        const ownGoalX = -sign * (CONFIG.pitch.length / 2);
        const teammates = e.players.filter((p) => p.team === pr.team && p.idx !== taker.idx);
        const order = ["DEF", "MID", "FWD"];
        teammates.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
        let defSlot = 0; let midSlot = 0;
        for (const p of teammates) {
          if (p.role === "DEF") {
            const z = (defSlot++ % 2 === 0 ? -1 : 1) * (7.8 + (defSlot % 2) * 1.2);
            p.pos.set(ownGoalX + sign * 10.5, 0, z);
          } else if (p.role === "MID") {
            const z = (midSlot++ % 2 === 0 ? -1 : 1) * 5.2;
            p.pos.set(ownGoalX + sign * 18.5, 0, z);
          } else {
            p.pos.set(sign * 10.5, 0, p.idx % 2 === 0 ? 3.4 : -3.4);
          }
          p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0);
        }
      }
      if (pr.kind === "throw_in") {
        const touchSide = Math.sign(pr.pos[1]) || 1;
        const receivers = e.players.filter((p) => p.team === pr.team && p.idx !== taker.idx && p.role !== "GK")
          .sort((a, b) => {
            const da = Math.hypot(a.pos.x - pr.pos[0], a.pos.z - touchSide * (CONFIG.pitch.width / 2 - 4.0));
            const db = Math.hypot(b.pos.x - pr.pos[0], b.pos.z - touchSide * (CONFIG.pitch.width / 2 - 4.0));
            return da - db || tieBreakHash(e.matchSeed, a.idx, a.runSerial, `throw-receiver:${pr.id}`)
              - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `throw-receiver:${pr.id}`);
          });
        const nearReceiver = receivers[0];
        receivers.forEach((p, i) => {
          const depth = nearReceiver?.idx === p.idx ? 4.0 : 6.0 + (i % 2) * 1.2;
          const lane = nearReceiver?.idx === p.idx ? 0 : (i % 2 === 0 ? -1 : 1) * (2.2 + Math.floor(i / 2) * 1.2);
          p.pos.set(
            THREE.MathUtils.clamp(pr.pos[0] + sign * (nearReceiver?.idx === p.idx ? 2.0 : 1.0 + i * 0.4), -18.8, 18.8),
            0,
            touchSide * (CONFIG.pitch.width / 2 - depth) + lane,
          );
          p.moveTarget.copy(p.pos);
          p.vel.set(0, 0, 0);
        });
      }
    }
    // Opponents respect the restart distance without collapsing into the taker's lane.
    for (const p of e.players) {
      if (p.team !== pr.team && p.pos.distanceTo(e.ball.pos) < 2.4) {
        _v1.copy(p.pos).sub(e.ball.pos).setY(0);
        if (_v1.lengthSq() < 0.01) _v1.set(-sign, 0, p.idx % 2 ? 1 : -1);
        _v1.normalize().multiplyScalar(2.5);
        p.pos.copy(e.ball.pos).add(_v1);
      }
    }
    if (pr.kind === "goal_kick") {
      const ownGoalX = -sign * (CONFIG.pitch.length / 2);
      for (const p of e.players) {
        if (p.team === pr.team) continue;
        if (Math.abs(p.pos.x - ownGoalX) < 5.9 && Math.abs(p.pos.z) < 6.3) {
          p.pos.x = ownGoalX + sign * 6.2;
          p.pos.z = THREE.MathUtils.clamp(p.pos.z, -8, 8);
        }
      }
    }
  }
  e.restartAutoT = 0.55;
}

/**
 * Sample where the taker should deliver, weighted by space and creativity.
 * `rng` is an attempt-local stream by default: a cancelled delivery or watchdog
 * retry must not shift the shared match RNG for every later AI decision.
 */
export function sampleRestartTarget(
  e: MatchHost,
  pr: NonNullable<RulesEngine["pendingRestart"]>,
  taker: EnginePlayer,
  rng: SeededRandom = e.rng,
): RestartTarget {
  const mates = e.players.filter((p) => p.team === taker.team && p.idx !== taker.idx && p.role !== "GK");
  const sign = e.ai.attackSign(taker.team, e.rules.half);
  const goal = e.ai.goalPos(taker.team, e.rules.half);
  if (pr.kind === "penalty" || (pr.kind === "free_kick" && taker.pos.distanceTo(goal) < 13)) {
    const keeper = e.players.find((p) => p.team !== taker.team && p.role === "GK");
    const lanes = [-1.05, -0.5, 0, 0.5, 1.05].map((z) => ({
      value: new THREE.Vector3(goal.x, 0, z),
      weight: 0.25 + Math.abs((keeper?.pos.z ?? 0) - z) * 0.55 + rng.range(0, 0.24),
    }));
    return { target: rng.weighted(lanes) };
  }
  if (pr.kind === "kickoff") {
    // At kickoff, passer cleanly finds the supporting teammate on the kickoff circle
    const support = mates.find((m) => m.pos.distanceTo(taker.pos) < 5.8 && m.role !== "GK") ?? mates[0];
    if (support) return { target: support.pos.clone(), player: support };
  }
  if (pr.kind === "corner") {
    // Lofted long delivery. The aim zone is the danger area (penalty spot / far post /
    // near post), and the named receiver is the runner closest to it — never the short
    // taker-side option.
    const goalX = goal.x;
    const cornerSide = Math.sign(pr.pos[1]) || 1;
    const zones = [
      { value: new THREE.Vector3(goalX - sign * 4.2, 0, 0), weight: 0.44 },              // penalty spot
      { value: new THREE.Vector3(goalX - sign * 2.6, 0, -cornerSide * 2.6), weight: 0.3 }, // far post
      { value: new THREE.Vector3(goalX - sign * 2.6, 0, cornerSide * 1.4), weight: 0.18 }, // near post
      { value: new THREE.Vector3(goalX - sign * 6.4, 0, -cornerSide * 1.6), weight: 0.08 },// edge
    ];
    const zoneTarget = rng.weighted(zones);
    const runner = [...mates].filter((p) => p.role !== "GK").sort((a, b) => {
      const da = Math.hypot(a.pos.x - zoneTarget.x, a.pos.z - zoneTarget.z);
      const db = Math.hypot(b.pos.x - zoneTarget.x, b.pos.z - zoneTarget.z);
      return da - db || tieBreakHash(e.matchSeed, a.idx, a.runSerial, `corner:${pr.id}`)
        - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `corner:${pr.id}`);
    })[0];
    return runner ? { target: runner.pos.clone(), player: runner } : { target: zoneTarget };
  }
  const candidates = mates.map((p) => {
    const target = p.pos.clone().addScaledVector(p.vel, 0.35);
    if (pr.kind === "throw_in") {
      target.x += sign * rng.range(1.8, 4.0);
      target.z += -Math.sign(pr.pos[1]) * rng.range(1.5, 4.5);
    } else if (pr.kind === "goal_kick") {
      target.x += sign * rng.range(3, 8);
      target.z += rng.range(-2.4, 2.4);
    } else {
      target.x += sign * rng.range(2.0, 4.4);
    }
    const nearest = Math.min(...e.players.filter((q) => q.team !== taker.team && q.role !== "GK").map((q) => q.pos.distanceTo(target)), 14);
    const score = THREE.MathUtils.clamp(nearest / 7, 0, 1) * 0.45
      + THREE.MathUtils.clamp((target.x - taker.pos.x) * sign / 18, 0, 0.35)
      + (1 - Math.min(1, target.distanceTo(taker.pos) / 24)) * 0.16
      + rng.range(0, 0.1) + p.style.creativity * 0.04;
    return { player: p, target, score };
  }).sort((a, b) => b.score - a.score);
  const pool = candidates.slice(0, Math.min(3, candidates.length));
  if (!pool.length) return { target: e.ai.goalPos(taker.team, e.rules.half) };
  const chosen = rng.weighted(pool.map((item, i) => ({ value: item, weight: Math.max(0.08, item.score) * (i === 0 ? 1.1 : 0.75) })));
  return { target: chosen.target, player: chosen.player };
}

/** Why the restart cannot be taken yet (`` when it can). */
export function restartBlockReason(e: MatchHost, pr: NonNullable<RulesEngine["pendingRestart"]>, taker: EnginePlayer): string {
  const opponents = e.players.filter((p) => p.team !== pr.team);
  const near = (pos: THREE.Vector3, radius: number) => opponents.filter((p) => p.pos.distanceTo(pos) < radius);
  if (pr.kind === "goal_kick") {
    if (taker.role !== "GK") return "Waiting: goalkeeper must take the goal kick";
    const ownGoal = e.ai.ownGoal(taker.team, e.rules.half);
    const inside = opponents.filter((p) => Math.abs(p.pos.x - ownGoal.x) < 5.9 && Math.abs(p.pos.z) < 6.3);
    if (inside.length) return `Waiting: ${inside.length} opponent(s) inside the penalty area`;
    if (near(e.ball.pos, 2.2).length) return "Waiting: opponent inside the exclusion zone";
  }
  if (pr.kind === "kickoff") {
    const violation = kickoffRestartViolation(
      opponents.map((p) => ({ x: p.pos.x, z: p.pos.z })),
      e.ai.attackSign(taker.team, e.rules.half),
    );
    if (violation) return violation;
  }
  if (pr.kind === "corner" || pr.kind === "throw_in" || pr.kind === "free_kick" || pr.kind === "penalty") {
    if (near(e.ball.pos, 2.0).length) return "Waiting: opponent too close to the restart";
  }
  return "";
}

/** Take the pending restart once the taker and the law allow it. */
export function restartAuto(e: MatchHost, dt: number) {
  const pr = e.rules.pendingRestart;
  if (e.rules.phase !== "INPLAY" || !pr) return;
  if (e.restartStartedId === pr.id && e.restartLaunchedId !== pr.id) {
    // Contact-frame watchdog: a cancelled wind-up must never soft-lock the match
    // or loop the same restart. Release the ball at the taker and resume play.
    e.restartContactT += dt;
    if (e.restartContactT > 2.4) {
      const stuck = e.players.find((p) => p.restartTaker);
      if (stuck) {
        stuck.pendingKick = null;
        stuck.restartTaker = false;
        e.ball.release();
        e.ball.pos.set(stuck.pos.x, CONFIG.ball.radius, stuck.pos.z);
        e.ball.vel.set(0, 0, 0);
      }
      e.restartStartedId = -1;
      e.restartContactT = 0;
      e.rules.pendingRestart = null;
      e.rules.emit("RESTART_READY", "Restart released — contact window expired");
    }
    return;
  }
  if (e.restartLaunchedId === pr.id) return;
  e.restartContactT = 0;
  e.restartAutoT -= dt;
  if (e.restartAutoT > 0) return;
  let taker = e.players.find((p) => p.restartTaker);
  // Kickoff recovery: possession is authoritative; repair a missing taker flag
  // instead of leaving the whole match frozen at the centre spot.
  if (!taker && pr.kind === "kickoff" && e.ball.possessedBy !== null) {
    const owner = e.players[e.ball.possessedBy];
    if (owner?.team === pr.team) {
      owner.restartTaker = true;
      taker = owner;
    }
  }
  if (!taker || taker.anim.busy) { e.restartAutoT = 0.15; return; }
  const block = restartBlockReason(e, pr, taker);
  e.restartWaitReason = block;
  if (block) {
    e.restartAutoT = 0.25;
    if (e.warnedRestartId !== pr.id) {
      e.warnedRestartId = pr.id;
      e.rules.whistle(block.replace("Waiting: ", "Restart delayed — "));
    }
    return;
  }
  let action = "pass_short";
  if (pr.kind === "throw_in") action = "throw_in";
  else if (pr.kind === "corner") action = "corner_kick";
  else if (pr.kind === "penalty") action = "shoot_normal";
  else if (pr.kind === "free_kick") action = taker.pos.distanceTo(e.ai.goalPos(taker.team, e.rules.half)) < 13 ? "shoot_normal" : "pass_long";
  else if (pr.kind === "kickoff") action = "pass_short";
  let selection: RestartTarget | null = null;
  let goalKickChoice: GkDistribution | null = null;
  // Goal-kick distribution overrides the sampled target: only sample a restart
  // target when it will actually be used, otherwise the RNG stream is burned
  // for a choice that is thrown away (and every later AI draw shifts).
  if (pr.kind === "goal_kick") {
    goalKickChoice = evaluateGkDistribution(e, taker);
    if (goalKickChoice) {
      action = goalKickChoice.action;
      selection = { target: goalKickChoice.target.clone(), player: goalKickChoice.receiver };
      aiEvent(e, goalKickChoice.reason);
    }
  }
  // Every retry gets its own deterministic stream. Retrying because a wind-up
  // was cancelled no longer consumes a different number of shared RNG values
  // than a first-time success.
  const attemptKey = `restart:${pr.id}:${e.restartRetries}:${taker.idx}`;
  const attemptRng = new SeededRandom(streamSeed(e.matchSeed, attemptKey));
  if (!selection) selection = sampleRestartTarget(e, pr, taker, attemptRng);
  const seed = streamSeed(e.matchSeed, `${attemptKey}:action`);
  if (startAction(e, taker, action, selection.target, selection.player?.idx, seed)) {
    e.restartStartedId = pr.id;
    e.restartWaitReason = "";
    if (pr.kind === "kickoff") {
      e.rules.whistle("Kickoff taken — play is underway");
    } else {
      e.rules.whistle(`${pr.kind.replace("_", " ")} taken`);
    }
  } else if ((taker.anim.cooldowns.get(action) ?? 0) > 0) {
    // On cooldown: retries will self-heal as the cooldown decays.
    e.restartAutoT = 0.15;
  } else {
    // startAction failed for no transient reason (all restart clips exist and the
    // taker is not busy). Without startAction succeeding, restartStartedId is
    // never set, the contact watchdog can never arm, and the restart would stay
    // pending forever — release it to the taker instead.
    e.restartLaunchedId = pr.id;
    e.rules.pendingRestart = null;
    releaseRestartToTaker(e, taker);
  }
}

/** Release a stalled restart to its taker in play, after failed deliveries or a
 * permanent startAction failure. The taker keeps its legally staged position:
 * throw-in and corner takers stand outside the touchline, so they are bounded
 * only by the buffer margin, never clamped back onto the pitch. */
export function releaseRestartToTaker(e: MatchHost, p: EnginePlayer) {
  p.pendingKick = null;
  resetTackleState(p);
  p.restartTaker = false;
  p.moveTarget.copy(p.pos);
  p.desiredSpeed = 0;
  const halfX = CONFIG.pitch.length / 2 - 0.4, halfZ = CONFIG.pitch.width / 2 - 0.4;
  const margin = CONFIG.pitch.buffer + 0.4;
  const inX = THREE.MathUtils.clamp(p.pos.x, -halfX - margin, halfX + margin);
  const inZ = THREE.MathUtils.clamp(p.pos.z, -halfZ - margin, halfZ + margin);
  p.pos.set(inX, 0, inZ);
  e.ball.pos.set(inX, CONFIG.ball.radius, inZ);
  e.ball.vel.set(0, 0, 0);
  e.ball.possess(p.idx, p.team);
  aiEvent(e, `RESTART released to taker #${p.idx} after failed deliveries`);
}
