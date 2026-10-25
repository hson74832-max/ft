// Per-player control: the human pad (move, charge pass/shot, tackle) and the
// AI branch that applies a decision from `ai.think()` to the player.
import * as THREE from "three";
import { CONFIG } from "../config";
import { tieBreakHash } from "../random";
import { WorldPlayer, WorldSnap } from "../ai";
import { onsideLimit } from "../tactics";
import { _v1, _v2 } from "./scratch";
import { yawDelta, yawOf } from "../angles";
import { isKickAction, kickFacingError, powerForAction, startAction } from "./actions";
import { carrierIsProtected } from "./tackles";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/** Human pad: stick movement, hold-to-charge pass/shot, tackle and shield. */
export function humanControl(e: MatchHost, p: EnginePlayer, dt: number, snap: WorldSnap) {
  const k = e.keys;
  let ix = 0, iz = 0;
  if (k.has("a") || k.has("arrowleft")) ix -= 1;
  if (k.has("d") || k.has("arrowright")) ix += 1;
  if (k.has("w") || k.has("arrowup")) iz -= 1;
  if (k.has("s") || k.has("arrowdown")) iz += 1;
  // Analog gamepad left stick (world X / Z axes, matching the WASD convention:
  // stick right = +X, stick up = -Z). Reads the live pads each frame; headless
  // runs have no navigator so this is a no-op there. An active stick overrides
  // the digital WASD input.
  let gamepadActive = false;
  if (typeof navigator !== "undefined" && navigator.getGamepads) {
    const pads = navigator.getGamepads();
    for (let g = 0; g < pads.length; g++) {
      const pad = pads[g];
      if (!pad) continue;
      const dead = 0.15;
      const gx = Math.abs(pad.axes[0] ?? 0) > dead ? (pad.axes[0] ?? 0) : 0;
      const gy = Math.abs(pad.axes[1] ?? 0) > dead ? (pad.axes[1] ?? 0) : 0;
      if (gx !== 0 || gy !== 0) { ix = gx; iz = gy; gamepadActive = true; break; }
    }
  }
  const has = ix !== 0 || iz !== 0;
  // Analog magnitude: a light stick tilt walks, a full push runs. Keyboard is
  // digital (magnitude 1). Shift or a near-full stick sprints.
  const speedScale = has ? Math.min(1, Math.hypot(ix, iz)) : 0;
  const sprint = k.has("shift") || (gamepadActive && speedScale > 0.8);
  const spd = sprint ? CONFIG.player.sprintSpeed : has ? CONFIG.player.runSpeed * speedScale : 0;
  if (has) {
    _v1.set(ix, 0, iz).normalize();
    p.moveTarget.copy(p.pos).addScaledVector(_v1, 3);
    p.desiredSpeed = spd;
    p.decisionReason = `Human move ${sprint ? "SPRINT" : "jog"}`;
  } else { p.moveTarget.copy(p.pos); p.desiredSpeed = 0; p.decisionReason = "Human hold"; }
  p.utilities = {};
  const hasBall = e.ball.possessedBy === p.idx;

  // ---- Contextual body orientation ---------------------------------------
  // The shoulders are no longer welded to the stride. Holding [F] with the ball
  // shields it (body between ball and the nearest opponent) and the player can
  // still side-step or drop off; without a shield the carrier keeps his chest open
  // to the goal while his feet work sideways or backwards. Both cost speed in
  // ./frame, so a square stance is a real choice rather than a free one.
  p.shielding = hasBall && k.has("f");
  p.strideFacing = null;
  if (p.shielding) {
    const opponent = e.players.reduce<EnginePlayer | null>(
      (acc, q) => (q.team === p.team || q.role === "GK" ? acc
        : acc === null || q.pos.distanceToSquared(p.pos) < acc.pos.distanceToSquared(p.pos) ? q : acc), null);
    _v1.copy(p.pos).sub(opponent ? opponent.pos : p.pos);
    _v1.y = 0;
    if (_v1.lengthSq() < 0.04) {
      const goal = e.ai.goalPos(p.team, e.rules.half);
      _v1.copy(goal).sub(p.pos);
    }
    p.shieldPoint.copy(p.pos).addScaledVector(_v1.normalize(), 2.5);
    p.decisionReason = "Human shield";
  } else if (hasBall && has) {
    const goal = e.ai.goalPos(p.team, e.rules.half);
    const openFacing = yawOf(goal.x - p.pos.x, goal.z - p.pos.z);
    const moveFacing = yawOf(ix, iz);
    // Facing the goal while travelling across the pitch is the side-step; only a
    // genuine run away from goal hands the body back to the stride.
    if (Math.abs(yawDelta(openFacing, moveFacing)) < 2.6) p.strideFacing = openFacing;
  }

  // charge pass/shoot
  if (k.has(" ") && !e.chargingPass) { e.chargingPass = true; e.passCharge = 0; }
  if (!k.has(" ") && e.chargingPass) {
    e.chargingPass = false;
    humanPass(e, p, snap, e.passCharge, k.has("q"));
    e.passCharge = 0;
  }
  if (e.chargingPass) e.passCharge = Math.min(1, e.passCharge + dt * 1.4);
  if (k.has("e") && !e.chargingShoot) { e.chargingShoot = true; e.shootCharge = 0; }
  if (!k.has("e") && e.chargingShoot) {
    e.chargingShoot = false;
    humanShoot(e, p, snap, e.shootCharge, k.has("q"));
    e.shootCharge = 0;
  }
  if (e.chargingShoot) e.shootCharge = Math.min(1, e.shootCharge + dt * 1.2);
  if (k.has("f")) {
    if (!hasBall) k.delete("f"); // off the ball it is a one-shot challenge
    if (!hasBall && !p.anim.busy) {
      if (p.tackleRecoveryT > 0) p.decisionReason = `Tackle recovery ${p.tackleRecoveryT.toFixed(2)}s`;
      else if (carrierIsProtected(e)) p.decisionReason = "Carrier is protected after a tackle";
      else {
        // Pick stand vs slide by challenge geometry (distance to the carrier), not by
        // distance to the ball — the ball is glued 0.48 m in front of the carrier, so
        // measuring to the ball shifts every human engage range by ~0.5 m and made the
        // human's effective stand/slide split inconsistent with the AI's (which uses
        // carrier.pos with 1.5 m / 2.55 m thresholds).
        const carrier = e.ball.possessedBy !== null ? e.players[e.ball.possessedBy] : null;
        const carrierDist = carrier ? p.pos.distanceTo(carrier.pos) : p.pos.distanceTo(e.ball.pos);
        const id = carrierDist < 1.5 ? "tackle_stand" : "tackle_slide";
        if (startAction(e, p, id, e.ball.pos.clone())) p.decisionReason = `Human ${id}`;
      }
    } else if (hasBall && p.anim.actionId !== "shield" && !p.anim.busy) {
      // The shield clip is a held loop; it is released by `p.shielding` in ./anims.
      if (startAction(e, p, "shield")) p.decisionReason = "Human shield";
    }
  }
}

/** Assisted pass target: best onside teammate in the aim cone. */
export function bestPassTarget(e: MatchHost, p: EnginePlayer, dir: THREE.Vector3 | null, snap: WorldSnap): EnginePlayer | null {
  const mates = e.players.filter((q) => q.team === p.team && q.idx !== p.idx
    && !e.ai.isOffsidePosition(q.pos, e.ball.pos, p.team, snap));
  if (!mates.length) return null;
  if (e.aimRaw || !dir || dir.lengthSq() < 0.01) {
    // aide: best within cone of facing
    const fx = Math.cos(p.facing), fz = -Math.sin(p.facing);
    let best: EnginePlayer | null = null; let bs = -1;
    for (const m of mates) {
      _v1.copy(m.pos).sub(p.pos); const d = _v1.length(); _v1.normalize();
      const align = _v1.x * fx + _v1.z * fz;
      const nearestOpp = Math.min(...e.players.filter((q) => q.team !== p.team && q.role !== "GK").map((q) => q.pos.distanceTo(m.pos)), 10);
      const s = align * 0.4 + (1 - d / 30) * 0.25 + Math.min(1, nearestOpp / 6) * 0.25
        + tieBreakHash(e.matchSeed, p.idx, p.runSerial, `human-pass:${m.idx}`) * 0.1;
      if (s > bs) { bs = s; best = m; }
    }
    return best;
  }
  let best: EnginePlayer | null = null; let bs = -2;
  for (const m of mates) {
    _v1.copy(m.pos).sub(p.pos).normalize();
    const nearestOpp = Math.min(...e.players.filter((q) => q.team !== p.team && q.role !== "GK").map((q) => q.pos.distanceTo(m.pos)), 10);
    const s = _v1.dot(dir) * 0.72 + Math.min(1, nearestOpp / 7) * 0.18
      + tieBreakHash(e.matchSeed, p.idx, p.runSerial, `human-pass:${m.idx}`) * 0.1;
    if (s > bs) { bs = s; best = m; }
  }
  return bs > 0.3 ? best : null;
}

/** Release a human pass (tap = short, hold = driven long, Q = through ball). */
export function humanPass(e: MatchHost, p: EnginePlayer, snap: WorldSnap, charge: number, through: boolean) {
  // A lower-priority clip must never swallow the input: the animation controller's
  // own priority/interrupt window decides whether the kick can start. The old
  // blanket `p.anim.busy` returned here made a pass silently do nothing.
  if (e.ball.possessedBy !== p.idx) return;
  let ix = 0, iz = 0;
  const k = e.keys;
  if (k.has("a") || k.has("arrowleft")) ix -= 1;
  if (k.has("d") || k.has("arrowright")) ix += 1;
  if (k.has("w") || k.has("arrowup")) iz -= 1;
  if (k.has("s") || k.has("arrowdown")) iz += 1;
  const dir = ix || iz ? new THREE.Vector3(ix, 0, iz).normalize() : null;
  const tgt = bestPassTarget(e, p, dir, snap);
  if (!tgt) {
    p.decisionReason = "PASS CANCELLED · no onside teammate in aim cone";
    return;
  }
  const id = through ? "pass_through" : charge > 0.55 ? "pass_long" : "pass_short";
  let target: THREE.Vector3;
  target = tgt.pos.clone();
  if (!through) target.addScaledVector(tgt.vel, 0.35);
  // Hold-to-charge: tap = short pass, held = driven long ball.
  const kp = CONFIG.player.kickPower;
  const power = through
    ? kp.through * (0.85 + 0.3 * charge)
    : THREE.MathUtils.lerp(kp.pass, kp.longPass, charge);
  const passingRating = id === "pass_long" ? p.attributes.passing.longGroundPassing : p.attributes.passing.shortGroundPassing;
  if (startAction(e, p, id, target, tgt?.idx, undefined, power * (0.5 + passingRating / 150))) {
    p.decisionReason = `Human ${id} → ${tgt ? tgt.role : "space"} (power ${(charge * 100) | 0}%)`;
  }
  void snap;
}

/** Release a human shot (charge sets power, Q = finesse). */
export function humanShoot(e: MatchHost, p: EnginePlayer, snap: WorldSnap, charge: number, finesse: boolean) {
  if (e.ball.possessedBy !== p.idx) return;
  const airborne = e.ball.pos.y > 0.35;
  const id = airborne ? "shoot_volley" : finesse ? "shoot_finesse" : "shoot_normal";
  const gx = e.ai.goalPos(p.team, e.rules.half).x;
  const aimOffset = e.keys.has("a") || e.keys.has("arrowleft") ? -0.65 : e.keys.has("d") || e.keys.has("arrowright") ? 0.65 : 0;
  const aimZ = THREE.MathUtils.clamp(aimOffset * (e.aimRaw ? 1.8 : 1), -1.2, 1.2);
  // Hold-to-charge: tap = placed strike, held = full-power laces.
  const kp = CONFIG.player.kickPower;
  const power = id === "shoot_volley"
    ? kp.volley * (0.8 + 0.35 * charge)
    : id === "shoot_finesse"
      ? kp.finesse * (0.9 + 0.2 * charge)
      : THREE.MathUtils.lerp(18, kp.shoot, charge);
  const shootingRating = id === "shoot_volley" ? p.attributes.shooting.volleys : p.attributes.shooting.shotPower;
  if (startAction(e, p, id, new THREE.Vector3(gx, 0, aimZ), undefined, undefined, power * (0.5 + shootingRating / 150))) {
    p.decisionReason = `Human ${id} power ${(charge * 100) | 0}%`;
  }
  void snap;
}

/** Apply one AI decision to the player: branch gates, move target, action start. */
export function aiControl(e: MatchHost, p: EnginePlayer, dt: number, snap: WorldSnap, live: boolean, frozen: boolean) {
  const tr = e.debugAI ? e.aiTrace.get(p.idx) : undefined;
  // Contextual body state belongs to the human pad; a player who just left human
  // control must not keep shielding or side-stepping.
  p.shielding = false;
  p.strideFacing = null;
  // Stumble decays for everyone (it previously only decayed on the AI path).
  if (p.stumbleT > 0) p.stumbleT = Math.max(0, p.stumbleT - dt);
  if (frozen) {
    p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
    if (tr) { tr.branch = "frozen"; tr.overwrittenBy = `phase:${e.rules.phase}`; }
    return;
  }
  if (!live) { if (tr) tr.branch = "notLive"; return; }
  const wp: WorldPlayer = {
    idx: p.idx, team: p.team, role: p.role, roleIdx: p.roleIdx, pos: p.pos, vel: p.vel, facing: p.facing,
    speed: p.speed, busy: p.anim.busy, uninterruptible: p.anim.uninterruptible, actionId: p.anim.actionId,
    cooldowns: p.anim.cooldowns, stamina: p.stamina,
    hasBall: e.ball.possessedBy === p.idx, callForBall: p.callForBall, isHuman: p.isHuman,
    runSerial: p.runSerial, style: p.style, attributes: p.attributes,
    moveTarget: p.moveTarget, desiredSpeed: p.desiredSpeed, pendingPassTo: p.pendingKick?.passTo,
    tackleRecoveryT: p.tackleRecoveryT, tackleProtectionT: p.tackleProtectionT,
    perception: p.perception,
  };
  if (p.role === "GK" && e.ball.possessedBy === p.idx) {
    p.holdT += dt;
    p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
    const pressure = e.ai.goalkeeperPressure(wp, snap);
    if (!pressure.urgent && p.holdT < (e.ball.handsRestrictedTeam === p.team ? 0.35 : 1.25)) {
      p.decisionReason = "GK hold · choosing distribution";
      if (tr) tr.branch = "gkHold";
      return;
    }
  } else p.holdT = 0;
  if (tr) tr.branch = "ai";
  const dec = e.ai.think(wp, p.roleIdx, snap, e.clock);
  // think() returns its cached object between re-evaluations; identity tells fresh from cached.
  const fresh = e.lastAppliedDecision.get(p.idx) !== dec;
  if (tr) { tr.thinkCalled = true; tr.thinkFresh = fresh; tr.actionReturned = dec.action; }
  p.callForBall = wp.callForBall;
  if (p.moveTarget.distanceTo(dec.moveTarget) > 2.4) p.runSerial++;
  p.moveTarget.copy(dec.moveTarget);
  p.desiredSpeed = Math.min(dec.desiredSpeed, p.role === "GK" ? CONFIG.player.gkSprintSpeed : CONFIG.ai.maxSprint);
  p.decisionReason = dec.reason; p.utilities = dec.utilities;
  p.supportJob = dec.supportJob; p.supportRun = dec.runType; p.supportMode = dec.supportMode; p.passOptions = dec.passOptions;
  if (dec.supportJob === "runner" && e.ball.possessedBy !== null && e.ball.ownerTeam === p.team) {
    const sign = e.ai.attackSign(p.team, e.rules.half);
    const room = onsideLimit(snap, p.team) - CONFIG.ai.offsideBuffer - p.pos.x * sign;
    if (p.moveTarget.x * sign > p.pos.x * sign && room < 2) {
      p.desiredSpeed = Math.min(p.desiredSpeed, Math.sqrt(Math.max(0, 2 * CONFIG.player.decel * room)));
    }
  }

  if (dec.action) {
    // Actions fire once per fresh decision. Re-firing a cached decision replayed stale
    // passes/shots at stale targets every frame after the previous clip finished.
    if (!fresh) {
      if (tr) tr.startActionResult = "skipped:cached-decision";
    } else if (p.anim.busy && p.anim.uninterruptible && !(p.role === "GK" && dec.urgent && e.ball.possessedBy === p.idx && p.anim.actionId === "first_touch")) {
      if (tr) tr.startActionResult = `skipped:locked(${p.anim.actionId})`;
      e.ai.nextThink.set(p.idx, e.clock + 0.1); // re-decide shortly; avoids RNG thrash every frame
    } else {
      const actionTarget = dec.action === "dribble_touch" ? undefined : (dec.actionTarget ?? dec.moveTarget).clone();
      // The kick leaves in the direction the body faces. A player who is running
      // has his torso locked to his stride, so a target outside the body's arc is
      // struck only after he stops and pivots onto it (faceTarget is read by the
      // facing pass in ./frame). A player who is already standing still turns into
      // the wind-up itself — that is the visible turn before the ball leaves.
      if (dec.action && isKickAction(dec.action) && actionTarget && !p.restartTaker
        && p.speed > 0.45
        && kickFacingError(p, actionTarget) > CONFIG.ai.kickFacingAngle) {
        p.faceTarget = actionTarget.clone();
        p.faceTargetT = 1.0;
        p.moveTarget.copy(p.pos);
        p.desiredSpeed = Math.min(p.desiredSpeed, 1.2);
        p.decisionReason = "Turn to face the kick target";
        e.ai.nextThink.set(p.idx, e.clock + 0.06);
        if (tr) tr.startActionResult = "skipped:turning-to-face";
      } else {
        const ok = startAction(e, p, dec.action, actionTarget, dec.passTo, undefined, powerForAction(p, dec.action));
        if (ok) { p.holdT = 0; e.lastAppliedDecision.set(p.idx, dec); e.ai.commitDecision(p.idx, dec); }
        else {
          const cooldownRemaining = Math.max(
            p.anim.cooldowns.get(dec.action) ?? 0,
            dec.action.startsWith("tackle_") ? p.tackleRecoveryT : 0,
          );
          e.ai.nextThink.set(p.idx, e.clock + Math.max(0.05, cooldownRemaining)); // retry after cooldown decays
          if (tr) tr.startActionResult = cooldownRemaining > 0
            ? `skipped:recovery(${cooldownRemaining.toFixed(2)}s)`
            : "skipped:clip-rejected";
        }
        if (tr) tr.startActionResult = ok ? `ok:${dec.action}` : `rejected:${dec.action}(cooldown ${(p.anim.cooldowns.get(dec.action) ?? 0).toFixed(2)}s)`;
      }
    }
  } else {
    e.lastAppliedDecision.set(p.idx, dec);
  }
  if (p.stumbleT > 0) {
    p.desiredSpeed *= 0.3;
    if (tr) tr.overwrittenBy = `stumble(${p.stumbleT.toFixed(2)}s)`;
  }
}
