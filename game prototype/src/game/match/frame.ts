// One simulation frame: the AI's world view, per-player integration (control,
// motion, animation, contact, rig transform) and goal-celebration staging.
import * as THREE from "three";
import { CONFIG } from "../config";
import { applyPose } from "../skeleton";
import { WorldSnap } from "../ai";
import { turnTowards, yawDelta, yawOfVector } from "../angles";
import { _v1, _v2 } from "./scratch";
import { startAction } from "./actions";
import { aiControl, humanControl } from "./control";
import { onContact } from "./contacts";
import { resolveBallPlayerCollisions } from "./collisions";
import { outGoalCheck, possessionCheck, trackPossession } from "./possession";
import { restartAuto } from "./restarts";
import { decayTackleTimers } from "./tackles";
import type { MatchHost } from "./host";

/** The AI-facing view of the world, rebuilt once per frame. */
export function buildWorldSnap(e: MatchHost): WorldSnap {
  const ownerIdx = e.ball.possessedBy;
  const snap: WorldSnap = {
    ballPos: e.ball.pos.clone(), ballVel: e.ball.vel.clone(),
    ballOwner: ownerIdx, ballOwnerTeam: e.ball.ownerTeam,
    players: e.players.map((p) => ({
      idx: p.idx, team: p.team, role: p.role, roleIdx: p.roleIdx, pos: p.pos.clone(), vel: p.vel.clone(),
      facing: p.facing, speed: p.speed, busy: p.anim.busy,
      uninterruptible: p.anim.uninterruptible, cooldowns: p.anim.cooldowns,
      stamina: p.stamina, hasBall: e.ball.possessedBy === p.idx,
      callForBall: p.callForBall, isHuman: p.isHuman, runSerial: p.runSerial, style: p.style,
      moveTarget: p.moveTarget.clone(), desiredSpeed: p.desiredSpeed, pendingPassTo: p.pendingKick?.passTo,
      tackleRecoveryT: p.tackleRecoveryT, tackleProtectionT: p.tackleProtectionT,
    })),
    time: e.clock, half: e.rules.half, matchSeed: e.matchSeed,
    ballKickAge: e.ball.kickAge,
    ownerSince: e.possessionStartedAt,
    transitionUntil: e.transitionTeam === e.ball.ownerTeam ? e.transitionUntil : 0,
    passFlight: e.passFlight, lastPass: e.lastPass,
  };

  return snap;
}

/** Scorer's team celebrates once per GOAL event while the goal is replayed. */
export function celebrateGoal(e: MatchHost) {
  // The rules engine records who scored; inferring it from "the last event"
  // breaks the moment any other event (whistle, possession, …) lands after
  // the goal during the celebration phase. Find the actual GOAL event and
  // latch its id so a short imported celebration clip cannot consume extra
  // action seeds by restarting before the GOAL phase ends.
  let goalId = -1;
  for (let i = e.rules.events.length - 1; i >= 0; i--) {
    if (e.rules.events[i].type === "GOAL") { goalId = e.rules.events[i].id; break; }
  }
  if (goalId < 0 || e.celebratedGoalEventId === goalId) return;
  e.celebratedGoalEventId = goalId;
  for (const p of e.players) {
    if (p.team === e.rules.lastScorer && p.role !== "GK" && !p.anim.actionId) {
      startAction(e, p, "celebrate");
    }
  }
}

/** Fresh trace row per player per frame, before any control branch runs. */
export function beginAITrace(e: MatchHost) {
  for (const p of e.players) {
    e.aiTrace.set(p.idx, {
      idx: p.idx, team: p.team, role: p.role, hasBall: e.ball.possessedBy === p.idx,
      branch: "?", thinkCalled: false, thinkFresh: false,
      decisionReason: "", actionReturned: null, startActionResult: "n/a",
      animBusy: p.anim.busy, animUninterruptible: p.anim.uninterruptible, animActionId: p.anim.actionId,
      moveTarget: "", desiredSpeed: 0, speed: p.speed, overwrittenBy: "",
    });
  }
}

/** Control branch, motion integration, animation and rig transform for every player. */
export function stepPlayers(e: MatchHost, dt: number, snap: WorldSnap, live: boolean, frozen: boolean) {
  for (const p of e.players) {
    // Timers decay on every branch (human, AI, frozen and restart hold).
    decayTackleTimers(p, dt);
    // Clear stale kick intents once the animation that owned them has finished.
    if (p.pendingKick && !p.anim.busy) p.pendingKick = null;
    if (p.tackleChallenge && p.anim.actionId !== p.tackleChallenge.action) p.tackleChallenge = null;
    const restartHold = live && e.rules.pendingRestart !== null
      && e.restartLaunchedId !== e.rules.pendingRestart.id;
    const isHumanControlled = !e.spectator && p.idx === e.humanIdx && live && !restartHold;
    const tr = e.debugAI ? e.aiTrace.get(p.idx) : undefined;
    if (restartHold) {
      p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
      p.decisionReason = "Restart setup · waiting for ball contact";
      if (tr) { tr.branch = "restartHold"; tr.overwrittenBy = `restartHold(${e.rules.pendingRestart?.kind})`; }
    } else if (isHumanControlled) {
      humanControl(e, p, dt, snap);
      if (tr) tr.branch = "human";
    } else aiControl(e, p, dt, snap, live, frozen);
    if (tr) {
      tr.decisionReason = p.decisionReason;
      tr.moveTarget = `${p.moveTarget.x.toFixed(1)},${p.moveTarget.z.toFixed(1)}`;
      tr.desiredSpeed = +p.desiredSpeed.toFixed(2);
    }

    // integrate movement — real acceleration model (m/s²), no instant reversals
    const toTarget = _v1.copy(p.moveTarget).sub(p.pos); toTarget.y = 0;
    const distT = toTarget.length();
    let desired = _v2.set(0, 0, 0);
    if (distT > 0.05) desired.copy(toTarget.normalize().multiplyScalar(Math.min(p.desiredSpeed, distT * 2.2 + 0.3)));
    // Soft separation prevents teammate collisions while preserving carrier/tackle access.
    const separation = new THREE.Vector3();
    for (const other of e.players) {
      if (other.idx === p.idx) continue;
      const away = p.pos.clone().sub(other.pos).setY(0);
      const distance = away.length();
      if (distance <= 0.01 || distance >= 1.25) continue;
      away.multiplyScalar((1.25 - distance) * (p.team === other.team ? 3.2 : 1.1) / distance);
      separation.add(away);
    }
    desired.add(separation);
    const rootAction = p.anim.actionRootMotion;
    if (rootAction) p.vel.multiplyScalar(Math.max(0, 1 - dt * 12));
    else {
      const sp = Math.hypot(p.vel.x, p.vel.z);
      const dLen = desired.length();
      const dot = sp > 0.05 && dLen > 0.05 ? (p.vel.x * desired.x + p.vel.z * desired.z) / (sp * dLen) : 1;
      if (dot < -0.2 && sp > 0.4) {
        // plant-and-cut: bleeding current momentum before committing to the new direction
        const bleed = Math.min(sp, CONFIG.player.decel * dt);
        p.vel.x -= (p.vel.x / sp) * bleed;
        p.vel.z -= (p.vel.z / sp) * bleed;
      } else if (dLen > 1e-4) {
        const rate = dLen > sp ? CONFIG.player.accel : CONFIG.player.decel;
        const stepN = Math.min(dLen, rate * dt);
        p.vel.x += (desired.x - p.vel.x) / dLen * stepN;
        p.vel.z += (desired.z - p.vel.z) / dLen * stepN;
      } else if (sp > 0.05) {
        // no input: brake to a stop at the measured decel rate
        const bleed = Math.min(sp, CONFIG.player.decel * dt);
        p.vel.x -= (p.vel.x / sp) * bleed;
        p.vel.z -= (p.vel.z / sp) * bleed;
      }
    }
    // speed cap: real top speed per role, scaled down as stamina drains
    const baseCap = p.role === "GK"
      ? CONFIG.player.gkSprintSpeed
      : (isHumanControlled && e.keys.has("shift") ? CONFIG.player.sprintSpeed : CONFIG.ai.maxSprint);
    const maxSp = baseCap * (0.72 + 0.28 * p.stamina);
    if (p.vel.length() > maxSp) p.vel.setLength(maxSp);
    p.pos.addScaledVector(p.vel, dt);
    // walls clamp — restart takers may legally stand outside the field of play
    // (corner taker behind the flag), so give them the buffer area.
    const HX = CONFIG.pitch.length / 2 - 0.4, HZ = CONFIG.pitch.width / 2 - 0.4;
    const margin = p.restartTaker ? CONFIG.pitch.buffer + 0.4 : 0;
    p.pos.x = THREE.MathUtils.clamp(p.pos.x, -HX - margin, HX + margin);
    p.pos.z = THREE.MathUtils.clamp(p.pos.z, -HZ - margin, HZ + margin);
    p.speed = p.vel.length();

    // facing: toward velocity, or toward ball when idle/defending, or toward moveTarget when shielding
    let wantFacing = p.facing;
    if (p.speed > 0.4) wantFacing = yawOfVector(p.vel);
    else if (e.ball.possessedBy !== p.idx) {
      _v1.copy(e.ball.pos).sub(p.pos);
      if (_v1.length() > 0.3) wantFacing = yawOfVector(_v1);
    } else if (p.pendingKick) {
      _v1.copy(p.pendingKick.target).sub(p.pos);
      wantFacing = yawOfVector(_v1);
    }
    const dYaw = yawDelta(p.facing, wantFacing);
    // Turn-in-place: never for the carrier or keeper (its root yaw fought the facing
    // steering and produced the side-to-side spin), and never over a pending kick.
    const carrying = e.ball.possessedBy === p.idx;
    // Turn-in-place is a stationary animation. A player who is trying to run must
    // turn while accelerating instead, or a mid-run change of direction freezes him
    // for the length of the clip (the "everyone holds position" symptom).
    if (Math.abs(dYaw) > 1.9 && p.speed < 1.2 && p.desiredSpeed < 1.6 && !p.anim.busy && live && !carrying && p.role !== "GK" && !p.pendingKick) {
      startAction(e, p, dYaw > 0 ? "turn_left" : "turn_right");
    }
    const rootTurning = p.anim.actionId === "turn_left" || p.anim.actionId === "turn_right" || p.anim.actionId === "turn_180";
    if (!rootTurning) p.facing = turnTowards(p.facing, wantFacing, CONFIG.player.turnRate * dt);

    // stamina
    p.stamina = THREE.MathUtils.clamp(p.stamina + dt * (p.speed > 6 ? -CONFIG.player.staminaDrain : CONFIG.player.staminaRegen), 0.2, 1);

    // anim update
    const velAng = p.speed > 0.3 ? yawOfVector(p.vel) : p.facing;
    const dAng = yawDelta(p.facing, velAng);
    p.anim.jockey = !isHumanControlled && e.ball.ownerTeam !== p.team && e.ball.ownerTeam !== null && p.speed < 2.2;
    // Ball direction relative to the player's facing: drives the head-watch layer.
    const ballLocal = yawDelta(p.facing, yawOfVector(_v1.copy(e.ball.pos).sub(p.pos)));
    const au = p.anim.update(dt, p.speed, dAng, { shielding: p.pendingKick !== null, ballDirLocal: ballLocal });
    // root motion add
    if (au.rootDelta.dx || au.rootDelta.dz || au.rootDelta.dYaw) {
      const fw = p.facing;
      p.pos.x += Math.cos(fw) * au.rootDelta.dx + Math.sin(fw) * au.rootDelta.dz;
      p.pos.z += -Math.sin(fw) * au.rootDelta.dx + Math.cos(fw) * au.rootDelta.dz;
      p.facing += au.rootDelta.dYaw;
    }
    // contact event → ball truth
    if (au.contact) onContact(e, p, au.contact);

    applyPose(p.rig.skeleton, au.pose);
    // root transform: facing 0 = +X, skeleton fwd +Z → yaw = facing + 90°
    p.rig.group.position.copy(p.pos);
    p.rig.group.rotation.y = p.facing + Math.PI / 2;
    // bob + IK ground offset
    const bob = Math.sin(p.anim.locoPhase * 2) * 0.02 * Math.min(1, p.speed / 5);
    p.rig.group.position.y = bob + (au.clip === "tackle_slide" ? -0.42 * Math.sin(Math.min(1, au.nt) * Math.PI) : 0)
      + ((au.clip === "gk_dive_L" || au.clip === "gk_dive_R") ? -0.25 * Math.sin(Math.min(1, au.nt) * Math.PI) : 0)
      + p.anim.proceduralOffset.y * 0.4;
    p.rig.group.position.x += p.anim.proceduralOffset.x * (1 - p.anim.proceduralT);
    p.rig.group.position.z += p.anim.proceduralOffset.z * (1 - p.anim.proceduralT);
  }
}

/**
 * Ball truth for this frame: pin it to a held restart or let it roll, resolve
 * body deflections, then run the possession / out-of-play / restart logic.
 */
export function stepBall(e: MatchHost, dt: number, live: boolean) {
  // The live ball owner can change during a contact event in this frame.
  const currentOwner = e.ball.possessedBy !== null ? e.players[e.ball.possessedBy] : null;
  const heldRestart = e.rules.pendingRestart && e.restartLaunchedId !== e.rules.pendingRestart.id
    ? e.rules.pendingRestart : null;
  if (heldRestart) {
    const taker = e.players.find((p) => p.restartTaker);
    if (heldRestart.kind === "throw_in" && taker) {
      const forwardX = Math.cos(taker.facing), forwardZ = -Math.sin(taker.facing);
      e.ball.pos.set(taker.pos.x + forwardX * 0.12, 1.65, taker.pos.z + forwardZ * 0.12);
    } else {
      e.ball.pos.set(heldRestart.pos[0], CONFIG.ball.radius, heldRestart.pos[1]);
    }
    e.ball.vel.set(0, 0, 0);
    e.ball.mesh.position.copy(e.ball.pos);
    e.ball.shadow.position.set(e.ball.pos.x, 0.021, e.ball.pos.z);
  } else if (currentOwner) e.ball.step(dt, currentOwner.pos, currentOwner.facing, currentOwner.vel);
  else e.ball.step(dt);
  resolveBallPlayerCollisions(e);

  if (live) {
    if (!e.rules.pendingRestart) {
      possessionCheck(e);
      outGoalCheck(e);
    }
    trackPossession(e);
    restartAuto(e, dt);
  } else {
    // freeze ball at restart spot during setup
    if (e.rules.pendingRestart) {
      const [rx, rz] = e.rules.pendingRestart.pos;
      if (e.ball.possessedBy === null && e.ball.speed < 0.5) {
        e.ball.pos.set(rx, CONFIG.ball.radius, rz);
        e.ball.vel.set(0, 0, 0);
      }
    }
    // goal celebrate: keep ball inside net volume
    if (e.rules.phase === "GOAL") {
      e.ball.vel.multiplyScalar(Math.max(0, 1 - dt * 4));
      const L = CONFIG.pitch.length / 2;
      e.ball.pos.x = THREE.MathUtils.clamp(e.ball.pos.x, -L - 1.0, L + 1.0);
      e.ball.pos.z = THREE.MathUtils.clamp(e.ball.pos.z, -1.4, 1.4);
      if (e.ball.pos.y > 1.8) e.ball.pos.y = 1.8;
    }
  }
}
