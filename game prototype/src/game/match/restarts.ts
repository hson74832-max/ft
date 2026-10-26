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
import { keeperPositionTarget } from "../ai";
import { yawOfVector } from "../angles";
import { clearPerception, seedPerception } from "./perception";
import { laneOpenness } from "./passPlanning";
import { evaluateGkDistribution } from "./passPlanning";
import { resetTackleState } from "./tackles";
import { isOffPitch, sendOffPitchPlayersToBench } from "./referee";
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
    p.faceTarget = null; p.faceTargetT = 0;
    p.shielding = false; p.strideFacing = null;
    clearPerception(p);
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
    const squad = e.players.filter((p) => p.team === kickTeam);
    const eligible = squad.filter((p) => !isOffPitch(e, p));
    // A staging pass with no eligible body cannot be left without a taker: that is
    // what turns a kickoff into a dead ball nobody may touch (the ball is released
    // here and no restart can ever be launched). Fall back through the squad and
    // then the whole roster, so staging always produces a taker for the ball.
    const usable = eligible.length ? eligible : squad.length ? squad : e.players;
    const attackers = usable.filter((p) => p.role === "MID" || p.role === "FWD");
    const outfield = usable.filter((p) => p.role !== "GK");
    const candidates = (attackers.length >= 2 ? attackers : outfield.length ? outfield : usable).slice(0, 2);
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
  // bookkeeping dangling behind a setup that no longer exists. The warning latch
  // belongs to the restart id: re-stamping the kickoff with a fresh id while the
  // old warning is still held silently swallows the next "restart delayed" notice
  // and leaves the AI waiting on a trigger it has already been told about.
  // The kickoff staging above places every player from his formation home. A
  // blue-carded player may not take part, so put him back on his bench spot.
  sendOffPitchPlayersToBench(e);
  e.restartStartedId = -1; e.restartLaunchedId = -1; e.restartRetries = 0; e.restartContactT = 0;
  e.restartStallId = -1; e.restartStallT = 0;
  e.warnedRestartId = -1;
  if (e.rules.pendingRestart && e.rules.pendingRestart.kind !== "kickoff") e.rules.pendingRestart = null;
  e.restartAutoT = 0.6;
  // Possession bookkeeping belongs to the old phase. A kickoff or goal re-stage that
  // keeps the pre-goal owner (and the team that had it) makes the next tackle spill
  // compare against a stale team, so a routine spill opens a phantom transition
  // window and the AI reacts as if a turnover had just happened. The staged kickoff
  // keeps the ball with its taker, so seed the records from the ball itself.
  e.lastKnownOwnerIdx = e.ball.possessedBy;
  e.lastKnownOwnerTeam = e.ball.ownerTeam;
  e.seenOwner = e.ball.possessedBy;
  e.seenOwnerTeam = e.ball.ownerTeam;
  e.possessionStartedAt = e.clock;
  e.transitionTeam = null;
  e.transitionUntil = 0;
  e.ai.resetDecisions();
  e.lastAppliedDecision.clear();
  seedPerception(e);
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
    // Choose the taker from where players actually are when the ball goes
    // out — the man who chased it to the flag takes the corner, like the
    // nearest man takes a throw-in. Ranking after the formation reset below
    // measured distance from *home* positions, so the same forward was
    // teleported in as taker no matter who was at the flag.
    const sign = e.ai.attackSign(pr.team, e.rules.half);
    const takers = e.players.filter((p) => p.team === pr.team && !isOffPitch(e, p)
      && (pr.kind === "goal_kick" ? p.role === "GK" : p.role !== "GK"));
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
      if (pr.kind === "penalty") {
        return [...ranked].sort((a, b) => b.attributes.shooting.penalties - a.attributes.shooting.penalties
          || b.attributes.shooting.finishing - a.attributes.shooting.finishing)[0];
      }
      if (pr.kind === "free_kick") {
        return [...ranked].sort((a, b) => b.attributes.passing.freeKick - a.attributes.passing.freeKick
          || b.attributes.shooting.longShots - a.attributes.shooting.longShots)[0];
      }
      return ranked[0] ?? null;
    };
    const taker = selectTaker();
    for (const p of e.players) {
      const [hx, hz] = FORMATIONS[p.team === 0 ? "RED" : "BLUE"][p.roleIdx].home;
      p.pos.set(hx * (e.rules.half === 2 ? -1 : 1), 0, hz);
      p.vel.set(0, 0, 0);
      p.pendingKick = null; p.restartTaker = false; p.callForBall = false;
      p.holdT = 0; p.stumbleT = 0;
      p.faceTarget = null; p.faceTargetT = 0;
      p.shielding = false; p.strideFacing = null;
      clearPerception(p);
      resetTackleState(p);
      p.decisionReason = "restart setup"; p.utilities = {};
      p.supportJob = undefined; p.supportRun = undefined; p.supportMode = undefined;
      p.passOptions = undefined;
      p.runSerial = 0;
      p.desiredSpeed = 0; p.moveTarget.copy(p.pos);
      p.anim = new AnimationController();
      p.anim.locoPhase = tieBreakHash(e.matchSeed, p.idx, pr.id, "restart-loco") * Math.PI * 2;
    }
    if (taker) {
      if (pr.kind === "throw_in") {
        // Throw-in taker stands at the touchline (or just outside it) so the ball
        // is released legally from the sideline, not from 0.18 m inside the pitch.
        taker.pos.set(pr.pos[0], 0, Math.sign(pr.pos[1]) * (CONFIG.pitch.width / 2 + 0.3));
      } else if (pr.kind === "goal_kick") {
        const side = Math.sign(pr.pos[0]);
        taker.pos.set(side * (CONFIG.pitch.length / 2 - 2.0), 0, pr.pos[1]);
      } else if (pr.kind === "free_kick" || pr.kind === "penalty") {
        // The taker stands BEHIND the ball. He used to be staged exactly on the
        // restart spot: his boots were inside the ball for the whole setup, and on
        // the first live frame the possessed ball is glued the control offset
        // (0.48 m) in front of him, so it popped forward off the spot. A real
        // approach step also makes the wind-up read as a run-up.
        const spot = new THREE.Vector3(pr.pos[0], 0, pr.pos[1]);
        const toGoal = e.ai.goalPos(pr.team, e.rules.half).clone().sub(spot).setY(0);
        if (toGoal.lengthSq() < 1e-4) toGoal.set(sign, 0, 0);
        toGoal.normalize();
        taker.pos.set(spot.x - toGoal.x * 0.9, 0, spot.z - toGoal.z * 0.9);
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
        // Every spot is 4 m or more off the goal line on purpose. The two shallow
        // spots (2.2 m / 2.6 m) sat exactly where the defending keeper stands on his
        // near post, so the delivery dropped on the keeper's toes: 7 of 12 sampled
        // corners were claimed by the keeper without him moving. On this 40 m pitch
        // the six-yard area is only ~2 m deep, so the realistic attack zone starts
        // around the penalty spot and runs back to the edge of the box.
        const runnerSpots: [number, number][] = [
          [goalX - sign * 4.4, 0],                   // penalty spot / near post area
          [goalX - sign * 4.4, cornerSide * 2.4],    // front post, a step off the line
          [goalX - sign * 5.8, -cornerSide * 3.4],   // back post
          [goalX - sign * 7.6, cornerSide * 2.0],    // edge of box
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
        // The defending keeper sets on his angle arc for the delivery (near-post
        // side for the flag), not on the formation home in the centre of goal.
        const defendingGk = e.players.find((p) => p.team !== pr.team && p.role === "GK");
        if (defendingGk) {
          const gkSpot = keeperPositionTarget(e.ball.pos,
            e.ai.ownGoal(defendingGk.team, e.rules.half),
            e.ai.attackSign(defendingGk.team, e.rules.half));
          defendingGk.pos.copy(gkSpot.target);
          defendingGk.moveTarget.copy(defendingGk.pos); defendingGk.vel.set(0, 0, 0);
        }
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
      // The defending team drops into a block around the throw-in: the two nearest
      // receivers are marked on the goal side, the rest screen the space between the
      // ball and their own goal. Without this the side kept its attacking shape —
      // forwards high and wide, nobody in the throw-in zone.
      if (pr.kind === "throw_in") {
        const defendTeam = 1 - pr.team;
        const ownGoal = e.ai.ownGoal(defendTeam, e.rules.half);
        const toOwn = ownGoal.clone().sub(e.ball.pos).setY(0);
        if (toOwn.lengthSq() < 0.01) toOwn.set(-sign, 0, 0);
        toOwn.normalize();
        const across = new THREE.Vector3(-toOwn.z, 0, toOwn.x);
        const clampToPitch = (v: THREE.Vector3) => {
          v.x = THREE.MathUtils.clamp(v.x, -CONFIG.pitch.length / 2 + 0.8, CONFIG.pitch.length / 2 - 0.8);
          v.z = THREE.MathUtils.clamp(v.z, -CONFIG.pitch.width / 2 + 0.6, CONFIG.pitch.width / 2 - 0.6);
          return v;
        };
        const receiversInPlay = e.players
          .filter((p) => p.team === pr.team && p.idx !== taker.idx && p.role !== "GK")
          .sort((a, b) => a.pos.distanceTo(e.ball.pos) - b.pos.distanceTo(e.ball.pos));
        const blockers = e.players.filter((p) => p.team === defendTeam && p.role !== "GK")
          .sort((a, b) => {
            const roleRank = (p: EnginePlayer) => (p.role === "DEF" ? 0 : p.role === "MID" ? 1 : 2);
            return roleRank(a) - roleRank(b)
              || a.pos.distanceTo(e.ball.pos) - b.pos.distanceTo(e.ball.pos)
              || tieBreakHash(e.matchSeed, a.idx, a.runSerial, `throw-block:${pr.id}`)
                - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `throw-block:${pr.id}`);
          });
        blockers.forEach((p, i) => {
          const spot = i < 2 && receiversInPlay[i]
            // Man-mark the two receivers from the goal side of them.
            ? receiversInPlay[i].pos.clone().addScaledVector(toOwn, 1.4)
            // Screen the corridor from the ball to goal, 4 m and 6 m deep.
            : e.ball.pos.clone().addScaledVector(toOwn, 4.0 + (i >= 3 ? 2.0 : 0))
              .addScaledVector(across, i % 2 === 0 ? -3.2 : 3.2);
          p.pos.copy(clampToPitch(spot));
          p.moveTarget.copy(p.pos);
          p.vel.set(0, 0, 0);
          _v1.copy(e.ball.pos).sub(p.pos);
          if (_v1.length() > 0.3) p.facing = yawOfVector(_v1);
        });
      }
      // ---- Free kicks and penalties ---------------------------------------
      // A foul stops play with the attacking side already advanced. Without its own
      // staging the defending team kept the shape it was attacking in when the foul
      // was committed: forwards high and wide, nobody between the ball and goal, and
      // an open path for the taker. Both sides are laid out here instead — wall on
      // the ball→near-post line, the rest of the block goal-side of the ball.
      if (pr.kind === "free_kick" || pr.kind === "penalty") {
        const isPenalty = pr.kind === "penalty";
        const defendTeam = 1 - pr.team;
        const ownGoal = e.ai.ownGoal(defendTeam, e.rules.half);
        const atkOwnGoal = e.ai.ownGoal(pr.team, e.rules.half);
        const ball = e.ball.pos;
        const toOwn = ownGoal.clone().sub(ball).setY(0);
        if (toOwn.lengthSq() < 0.01) toOwn.set(-sign, 0, 0);
        toOwn.normalize();
        const across = new THREE.Vector3(-toOwn.z, 0, toOwn.x);
        const goalHalf = CONFIG.pitch.goalWidth / 2;
        const rangeToGoal = ball.distanceTo(ownGoal);
        const halfL = CONFIG.pitch.length / 2, halfW = CONFIG.pitch.width / 2;
        const face = (p: EnginePlayer, at: THREE.Vector3) => {
          _v1.copy(at).sub(p.pos);
          if (_v1.length() > 0.3) p.facing = yawOfVector(_v1);
        };
        const stage = (p: EnginePlayer, spot: THREE.Vector3, lookAt?: THREE.Vector3) => {
          p.pos.set(
            THREE.MathUtils.clamp(spot.x, -halfL + 0.8, halfL - 0.8), 0,
            THREE.MathUtils.clamp(spot.z, -halfW + 0.6, halfW - 0.6),
          );
          p.vel.set(0, 0, 0); p.moveTarget.copy(p.pos);
          if (lookAt) face(p, lookAt);
        };
        const roleRank = (p: EnginePlayer) => (p.role === "DEF" ? 0 : p.role === "MID" ? 1 : 2);
        const attackers = e.players.filter((p) => p.team === pr.team && p.idx !== taker.idx && p.role !== "GK")
          .sort((a, b) => (a.role === "FWD" ? 0 : a.role === "MID" ? 1 : 2) - (b.role === "FWD" ? 0 : b.role === "MID" ? 1 : 2));
        const defenders = e.players.filter((p) => p.team === defendTeam && p.role !== "GK")
          .sort((a, b) => roleRank(a) - roleRank(b)
            || a.pos.distanceTo(ball) - b.pos.distanceTo(ball)
            || tieBreakHash(e.matchSeed, a.idx, a.runSerial, `fk-block:${pr.id}`)
              - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `fk-block:${pr.id}`));
        const attackingGk = e.players.find((p) => p.team === pr.team && p.role === "GK");
        const defendingGk = e.players.find((p) => p.team === defendTeam && p.role === "GK");
        if (isPenalty) {
          // Everyone but the taker waits outside the box and behind the ball.
          attackers.forEach((p, i) => {
            const lateral = ((i % 3) - 1) * 4.2;
            stage(p, new THREE.Vector3(ball.x - sign * (5.2 + Math.floor(i / 3) * 1.6), 0, lateral), ball);
          });
          // Law 14: every player other than the taker and the keeper must be outside
          // the penalty area, at least 9.15 m from the ball (≈3.5 m at this scale) and
          // behind the ball. `ownGoal.x + sign * 6.3` was the *goal line* plus the box
          // depth in the WRONG direction — i.e. on the goal line, inside the six-yard
          // box — and `stage()` then clamped it to 19.2: four defenders stood across
          // the goal mouth, 0.8 m from the line, and physically blocked penalties.
          // `penaltyEdgeDrop` (documented, never read) is the block's distance beyond
          // the area edge.
          const blockX = ownGoal.x - sign * (CONFIG.pitch.penaltyAreaDepth + CONFIG.tactics.penaltyEdgeDrop);
          const behindBall = (blockX - ball.x) * sign < -0.5 ? blockX : ball.x - sign * 2.6;
          defenders.forEach((p, i) => {
            const lateral = ((i % 4) - 1.5) * 3.4;
            stage(p, new THREE.Vector3(behindBall, 0, lateral), ball);
          });
        } else {
          // Attacking shape. Runners only attack the box when the ball can actually
          // be delivered there; otherwise the side keeps a compact shape around the
          // ball — everyone stays ball-side of the defensive line, so nobody is in
          // an offside position when the kick is taken.
          const boxSpot = new THREE.Vector3(ownGoal.x - sign * 4.0, 0, 0);
          const nearSide = Math.sign(ball.z) || 1;
          const deliveryRange = rangeToGoal <= 24;
          const runners: EnginePlayer[] = [];
          let supportDepth = 0;
          attackers.forEach((p, i) => {
            if (i === 0) {
              stage(p, ball.clone().addScaledVector(across, 4.2).addScaledVector(toOwn, -1.2), ownGoal);
              return;
            }
            if (deliveryRange && i <= 2) {
              const lateral = i === 1 ? nearSide * 1.8 : -nearSide * 2.6;
              stage(p, new THREE.Vector3(boxSpot.x, 0, lateral), ownGoal);
              runners.push(p);
              return;
            }
            const depth = 0.8 + 1.2 * (i - 1);
            supportDepth = Math.max(supportDepth, depth);
            stage(p, ball.clone().addScaledVector(toOwn, depth)
              .addScaledVector(across, (i % 2 === 0 ? 1 : -1) * 5.2), ownGoal);
          });
          // "No wall when the kick is too wide": `fkWallMinHeight` documented this
          // rule but was never read, so a free kick out by the corner flag — almost
          // level with the goal line — still got a three-man wall posted across the
          // goal mouth. The angle is measured above the goal line (0 = level with
          // it, π/2 = straight in front of goal), and a wall is only posted when
          // the kick has a real shooting angle.
          const goalLineAngle = Math.atan2(Math.max(0.1, (ownGoal.x - ball.x) * sign), Math.abs(ball.z) + 0.1);
          const inWallRange = rangeToGoal <= CONFIG.tactics.fkWallCloseRange
            && goalLineAngle >= CONFIG.tactics.fkWallMinHeight;
          // The wall takes only the men who are not needed to pick up a runner: an
          // unmarked runner is a receiver the taker could not legally use.
          const wallSize = inWallRange
            ? Math.max(0, Math.min(rangeToGoal < 12 ? 3 : 2, defenders.length - runners.length)) : 0;
          const nearPost = new THREE.Vector3(ownGoal.x, 0, nearSide * goalHalf);
          const wallLine = nearPost.clone().sub(ball).setY(0);
          if (wallLine.lengthSq() < 0.01) wallLine.copy(toOwn);
          wallLine.normalize();
          const wallSide = new THREE.Vector3(-wallLine.z, 0, wallLine.x);
          for (let i = 0; i < wallSize; i++) {
            stage(defenders[i], ball.clone()
              .addScaledVector(wallLine, CONFIG.tactics.fkWallDistance)
              .addScaledVector(wallSide, (i - (wallSize - 1) / 2) * 0.85), ball);
          }
          // Pick up the deep runners first, then the options beside the ball: every
          // one of them needs a defender between him and the goal, otherwise the kick
          // is just rolled into an unmarked receiver.
          const options = [...attackers].sort((a, b) => a.pos.distanceTo(ball) - b.pos.distanceTo(ball));
          const marked = [...runners];
          for (const option of options) {
            if (marked.length >= defenders.length - wallSize - 1) break;
            if (!marked.includes(option)) marked.push(option);
          }
          const markerPool = defenders.slice(wallSize);
          const lineDefenders = markerPool.slice(marked.length);
          marked.forEach((target, i) => {
            const marker = markerPool[i];
            if (marker) stage(marker, target.pos.clone().addScaledVector(toOwn, CONFIG.tactics.fkBoxGuard * 0.65), ball);
          });
          // Everyone left holds a compact line goal-side of the ball, screened across
          // the route to goal, level with the deepest supporting attacker.
          const lineDepth = Math.max(CONFIG.tactics.fkBlockDrop, supportDepth + 1.8);
          lineDefenders.forEach((p, i) => {
            const lateral = (i % 2 === 0 ? 1 : -1) * (2.0 + Math.floor(i / 2) * 2.6);
            stage(p, ball.clone().addScaledVector(toOwn, lineDepth).addScaledVector(across, lateral), ball);
          });
        }
        if (attackingGk) stage(attackingGk, new THREE.Vector3(atkOwnGoal.x + sign * 2.5, 0, 0), ball);
        if (defendingGk) {
          if (isPenalty) {
            // Law 14: the defending goalkeeper must remain on the goal line, between
            // the posts. `stage()` clamps every body to ±(halfL − 0.8) so field
            // players stay in play — that pulled the keeper 0.8 m off his line. The
            // keeper is placed directly, and `stepPlayers` grants him the buffer
            // margin while the penalty is pending so the clamp cannot undo it.
            const gkZ = THREE.MathUtils.clamp(ball.z, -goalHalf + 0.1, goalHalf - 0.1);
            defendingGk.pos.set(ownGoal.x, 0, gkZ);
            defendingGk.vel.set(0, 0, 0);
            defendingGk.moveTarget.copy(defendingGk.pos);
            face(defendingGk, ball);
          } else {
            const gkSpot = keeperPositionTarget(ball, ownGoal, e.ai.attackSign(defendingGk.team, e.rules.half));
            stage(defendingGk, gkSpot.target, ball);
          }
        }
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
  e.restartStallId = -1; e.restartStallT = 0;
  // Every branch above places players from a formation/shape template. A
  // blue-carded player may not stand in that shape — put him back on his bench.
  sendOffPitchPlayersToBench(e);
  // The dead-ball layout is visible to everyone: hand each player the picture he
  // starts the restart with instead of an empty memory.
  seedPerception(e);
}

/**
 * Sample where the taker should deliver, weighted by space and creativity.
 * `rng` is an attempt-local stream by default: a cancelled delivery or watchdog
 * retry must not shift the shared match RNG for every later AI decision.
 */
/**
 * Keep a delivery inside the field of play. Every restart aim point comes from a
 * teammate's position plus a sampled offset (a throw-in "up the line", a corner
 * zone, a goal-kick punt), and near a byline those offsets push the aim point past
 * the goal line: the taker then strikes the ball at a spot behind the goal. The
 * taker may stand outside the pitch, the ball he aims at may not.
 */
export function clampAimToPitch(target: THREE.Vector3, margin = CONFIG.ai.outPlaySafetyMargin): THREE.Vector3 {
  const hx = Math.max(0.5, CONFIG.pitch.length / 2 - margin);
  const hz = Math.max(0.5, CONFIG.pitch.width / 2 - margin);
  return target.set(THREE.MathUtils.clamp(target.x, -hx, hx), 0, THREE.MathUtils.clamp(target.z, -hz, hz));
}

export function sampleRestartTarget(
  e: MatchHost,
  pr: NonNullable<RulesEngine["pendingRestart"]>,
  taker: EnginePlayer,
  rng: SeededRandom = e.rng,
): RestartTarget {
  const picked = sampleRestartTargetRaw(e, pr, taker, rng);
  // A penalty — and a direct free kick inside shooting range — aims at the GOAL
  // MOUTH, not at a spot of grass where a delivery should land. Clamping that point
  // 1.4 m inside the pitch (`outPlaySafetyMargin`) put the aim short of the line: a
  // penalty at the lane z = ±1.05 was struck along the line to (18.6, ±1.05) and
  // crossed the goal line at z = ±1.58, i.e. outside the post. Only deliveries are
  // clamped to the pitch.
  const onGoal = pr.kind === "penalty"
    || (pr.kind === "free_kick" && taker.pos.distanceTo(e.ai.goalPos(taker.team, e.rules.half)) < 13);
  if (onGoal) return picked;
  clampAimToPitch(picked.target);
  return picked;
}

function sampleRestartTargetRaw(
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
  if (pr.kind === "free_kick") {
    // A free kick is a pass first and a long ball second. Options are scored on
    // keeping the ball (an open lane and a receiver with room) with a bonus for a
    // short ball; territory only decides it when the short options are marked. The
    // action follows the chosen distance, so a 6 m option is struck as a short pass
    // instead of a 24 m/s drive that bounces off the receiver's shins.
    const opponents = e.players.filter((q) => q.team !== taker.team);
    const field = opponents.filter((q) => q.role !== "GK");
    const options = mates.map((m) => {
      const target = m.pos.clone().addScaledVector(m.vel, 0.35);
      const dist = target.distanceTo(taker.pos);
      const lane = laneOpenness(e.ball.pos, target, opponents);
      const space = field.length ? Math.min(...field.map((q) => q.pos.distanceTo(target)), 20) : 20;
      const forward = (target.x - taker.pos.x) * sign;
      const keepBall = THREE.MathUtils.clamp((18 - dist) / 14, 0, 1);
      const score = lane * 0.5 + THREE.MathUtils.clamp(space / 6, 0, 1) * 0.24
        + THREE.MathUtils.clamp(forward / 20, 0, 1) * 0.22
        + keepBall * 0.28
        - (dist > 26 ? 0.3 : 0)
        + rng.range(0, 0.08) + m.style.creativity * 0.03;
      return { player: m, target, dist, score };
    }).filter((o) => o.dist > 3.5).sort((a, b) => b.score - a.score
      || tieBreakHash(e.matchSeed, a.player.idx, a.player.runSerial, `fk:${pr.id}`)
        - tieBreakHash(e.matchSeed, b.player.idx, b.player.runSerial, `fk:${pr.id}`));
    if (options.length) {
      const pool = options.slice(0, Math.min(3, options.length));
      const chosen = rng.weighted(pool.map((item, i) => ({ value: item, weight: Math.max(0.08, item.score) * (i === 0 ? 1.1 : 0.8) })));
      const target = chosen.target.clone();
      if (chosen.dist > 22) target.x += sign * rng.range(1.5, 3.0);
      // Short and medium deliveries stay on the ground and arrive at a pace a
      // receiver can cushion (pass_short / pass_through); only a genuine long ball
      // uses the driven pass_long profile.
      const action = chosen.dist <= 14 ? "pass_short" : chosen.dist <= 22 ? "pass_through" : "pass_long";
      return { target, player: chosen.player, action };
    }
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
      { value: new THREE.Vector3(goalX - sign * 4.4, 0, 0), weight: 0.44 },               // penalty spot
      { value: new THREE.Vector3(goalX - sign * 4.4, 0, cornerSide * 2.4), weight: 0.18 }, // front post area
      { value: new THREE.Vector3(goalX - sign * 5.8, 0, -cornerSide * 3.4), weight: 0.3 }, // back post
      { value: new THREE.Vector3(goalX - sign * 7.6, 0, cornerSide * 2.0), weight: 0.08 }, // edge
    ];
    const zoneTarget = rng.weighted(zones);
    // Drop the delivery on the ATTACKER'S side of the zone. Defenders mark a step
    // goal-side of the runner, and a delivery that lands even half a metre short of
    // an attacker's feet is a defender's ball; aiming marginally behind the spot
    // (away from goal) is the ball the runner can attack in front of his marker.
    zoneTarget.x -= sign * 0.8;
    const runner = [...mates].filter((p) => p.role !== "GK").sort((a, b) => {
      const da = Math.hypot(a.pos.x - zoneTarget.x, a.pos.z - zoneTarget.z);
      const db = Math.hypot(b.pos.x - zoneTarget.x, b.pos.z - zoneTarget.z);
      return da - db || tieBreakHash(e.matchSeed, a.idx, a.runSerial, `corner:${pr.id}`)
        - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `corner:${pr.id}`);
    })[0];
    // Aim at the ZONE, not at the runner's feet. The runner is staged on his spot
    // and stands there during the setup, so aiming at him turned every corner into
    // a flat ball to a stationary man — and the near-post spot is where the keeper
    // already is, so most corners were simply passed to the goalkeeper. The named
    // receiver is still the runner closest to the zone; `planNamedPass` predicts
    // where he can meet a ball played into that zone.
    return runner ? { target: zoneTarget, player: runner } : { target: zoneTarget };
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

/**
 * Pending-restart stall watchdog.
 *
 * Every player is held in the restart pose while a restart is pending, so a restart
 * that cannot be staged — no taker, a taker stuck in a clip that never resolves, a
 * staging pass that found nobody eligible — freezes the match at the ball with nothing
 * on screen but idle bodies. That is exactly the "Watch CPU vs CPU" symptom: the kickoff
 * had no taker and the ball sat on the centre spot until the user pressed Reset.
 *
 * After `CONFIG.match.restartStallLimit` seconds the game gets the ball back: the
 * nearest eligible player of the restarting side is moved to the restart spot, given
 * possession and the restart is closed. Called every frame while a restart is pending,
 * including during SETUP, so a hung setup cannot outlive the limit either.
 */
export function restartStallCheck(e: MatchHost, dt: number): void {
  const pr = e.rules.pendingRestart;
  if (!pr || e.restartLaunchedId === pr.id) return;
  if (e.restartStallId !== pr.id) { e.restartStallId = pr.id; e.restartStallT = 0; }
  e.restartStallT += dt;
  if (e.restartStallT < CONFIG.match.restartStallLimit) return;
  const eligible = e.players.filter((p) => p.team === pr.team && !isOffPitch(e, p));
  const pool = eligible.length ? eligible : e.players;
  const nearest = [...pool].sort((a, b) => a.pos.distanceTo(e.ball.pos) - b.pos.distanceTo(e.ball.pos)
    || tieBreakHash(e.matchSeed, a.idx, a.runSerial, `restart-stall:${pr.id}`)
      - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `restart-stall:${pr.id}`))[0];
  if (!nearest) return;
  const margin = CONFIG.pitch.buffer;
  nearest.pos.set(
    THREE.MathUtils.clamp(pr.pos[0], -CONFIG.pitch.length / 2 + margin, CONFIG.pitch.length / 2 - margin),
    0,
    THREE.MathUtils.clamp(pr.pos[1], -CONFIG.pitch.width / 2 + margin, CONFIG.pitch.width / 2 - margin),
  );
  nearest.moveTarget.copy(nearest.pos);
  nearest.vel.set(0, 0, 0);
  nearest.desiredSpeed = 0;
  e.restartLaunchedId = pr.id;
  e.restartStallId = -1;
  e.restartStallT = 0;
  e.rules.pendingRestart = null;
  releaseRestartToTaker(e, nearest);
  e.rules.whistle(`Restart released — ${pr.kind.replace("_", " ")} could not be staged`);
  aiEvent(e, `RESTART STALL RELEASED #${nearest.idx} · ${pr.kind} pending ${CONFIG.match.restartStallLimit}s`);
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
        // A throw-in or corner taker stands legally outside the touchline. Releasing
        // the ball at his feet put it out of play, so the very next frame awarded a
        // throw-in to the opponent: the clamp keeps the released ball on the pitch.
        e.ball.pos.set(
          THREE.MathUtils.clamp(stuck.pos.x, -CONFIG.pitch.length / 2 + 0.4, CONFIG.pitch.length / 2 - 0.4),
          CONFIG.ball.radius,
          THREE.MathUtils.clamp(stuck.pos.z, -CONFIG.pitch.width / 2 + 0.4, CONFIG.pitch.width / 2 - 0.4),
        );
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
  // Nobody owns the ball and nobody is flagged: the staging lost its taker (a
  // re-stage while the squad was momentarily unavailable, a card, a hand-edited
  // roster). Give the ball to the nearest eligible player of the restarting side
  // rather than retrying forever — a restart must never be a dead ball.
  if (!taker) {
    const eligible = e.players.filter((p) => p.team === pr.team && !isOffPitch(e, p));
    const pool = eligible.length ? eligible : e.players;
    const nearest = [...pool].sort((a, b) => a.pos.distanceTo(e.ball.pos) - b.pos.distanceTo(e.ball.pos)
      || tieBreakHash(e.matchSeed, a.idx, a.runSerial, `restart-taker:${pr.id}`)
        - tieBreakHash(e.matchSeed, b.idx, b.runSerial, `restart-taker:${pr.id}`))[0];
    if (nearest) {
      nearest.restartTaker = true;
      nearest.pendingKick = null;
      nearest.moveTarget.copy(nearest.pos);
      nearest.desiredSpeed = 0;
      e.ball.possess(nearest.idx, nearest.team);
      e.ball.pos.set(pr.pos[0], CONFIG.ball.radius, pr.pos[1]);
      taker = nearest;
      aiEvent(e, `RESTART taker restored → #${nearest.idx} ${nearest.role} for ${pr.kind}`);
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
  // The sampled free-kick delivery decides short / medium / long; anything else
  // keeps the kind's default action.
  if (pr.kind === "free_kick" && selection.action) action = selection.action;
  // The taker is standing over the ball: line the body up with the delivery before
  // it is struck (set-piece takers are exempt from the open-play facing gate).
  _v1.copy(selection.target).sub(taker.pos);
  if (_v1.length() > 0.3) taker.facing = yawOfVector(_v1);
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
  // The taker may legally stand outside the touchline (a throw-in), but the ball
  // being released into play may not: put it at the nearest point on the pitch, or
  // the out-of-bounds check hands the restart straight to the opponent.
  e.ball.pos.set(
    THREE.MathUtils.clamp(inX, -halfX, halfX),
    CONFIG.ball.radius,
    THREE.MathUtils.clamp(inZ, -halfZ, halfZ),
  );
  e.ball.vel.set(0, 0, 0);
  e.ball.possess(p.idx, p.team);
  aiEvent(e, `RESTART released to taker #${p.idx} after failed deliveries`);
}
