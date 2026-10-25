// The contact frame: what the ball does when an action's strike/reach lands.
// One dispatch entry per action family (passes, shots, duels, keeper play,
// set-piece deliveries) plus the restart bookkeeping that follows it.
import * as THREE from "three";
import { CONFIG } from "../config";
import { passAimDot, passAimIsValid } from "../passing";
import { startAction } from "./actions";
import { aiEvent } from "./debug";
import { captureOffsideAtKick, flagOffside } from "./offside";
import { planNamedPass, recordPass } from "./passPlanning";
import { setHumanPlayer } from "./roster";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/** The striker's touch: the ball leaves their feet and they own the last touch. */
function releaseToKick(e: MatchHost, p: EnginePlayer) {
  e.ball.release();
  e.ball.lastTouch = p.idx;
  e.ball.lastTouchTeam = p.team;
}

/** World position of the limb the action strikes with (foot / head / hand). */
export function footWorld(p: EnginePlayer, which = "R"): THREE.Vector3 {
  const b = p.rig.skeleton.bones.get(which === "head" ? "head" : which === "hands" ? "hand.R" : `foot.${which}`);
  const v = new THREE.Vector3();
  if (b) b.getWorldPosition(v);
  return v;
}

/** Resolve an action's contact frame against the ball, then close the restart out. */
export function onContact(e: MatchHost, p: EnginePlayer, action: string) {
  const pk = p.pendingKick;
  const activeRestart = e.rules.pendingRestart;
  let ballReleasedByAction = false;
  e.contactTotal++;
  const foot = footWorld(p, action === "header" ? "head" : action === "throw_in" || action.startsWith("gk_") ? "hands" : "R");
  const dist = foot.distanceTo(e.ball.pos);
  const tol = action === "header" ? 0.55 : action.startsWith("gk_") ? 0.8 : 0.42;
  if (dist < tol) e.contactAligned++;
  // IK snap pass: nudge foot toward ball predicted pos
  p.anim.ballContactSnap(e.ball.pos, foot);

  const ownerIsMe = e.ball.possessedBy === p.idx;
  const dirTo = (t: THREE.Vector3) => t.clone().sub(p.pos).setY(0).normalize();

  if (e.offsideTeam === p.team && e.offsideCandidates.has(p.idx)
    && ["first_touch", "intercept", "header", "shoot_volley"].includes(action) && flagOffside(e, p)) {
    p.pendingKick = null;
    return;
  }

  const kp = CONFIG.player.kickPower;
  switch (action) {
    case "pass_short": case "pass_long": case "pass_through": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) {
        p.decisionReason = "PASS CANCELLED · no valid same-team onside receiver in range";
        e.rules.emit("POSSESSION", `${action} cancelled: no valid named receiver`, p.team);
        break;
      }
      captureOffsideAtKick(e, p, activeRestart?.kind);
      releaseToKick(e, p);
      e.ball.kick(plan.target.clone().sub(e.ball.pos).setY(0).normalize(), plan.power, plan.loft);
      const launchDot = passAimDot(e.ball.pos, e.ball.vel, plan.target);
      if (!passAimIsValid(launchDot, CONFIG.ai.passAimConeDegrees)) {
        e.ball.vel.set(0, 0, 0); e.ball.possess(p.idx, p.team);
        p.decisionReason = "PASS CANCELLED · launch outside receiver cone";
        break;
      }
      ballReleasedByAction = true;
      recordPass(e, p, action, { ...plan, aimDot: launchDot });
      if (!activeRestart) e.openPlayKickCount++;
      e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${action} → #${plan.receiver.idx} ${plan.receiver.role}`, p.team);
      if (p.isHuman && !e.spectator) setHumanPlayer(e, plan.receiver);
      break;
    }
    case "shoot_normal": case "shoot_finesse": case "shoot_volley": {
      if (!ownerIsMe && !(action === "shoot_volley" && e.ball.possessedBy === null && p.pos.distanceTo(e.ball.pos) < 1.4)) break;
      const tgt = pk?.target ?? e.ai.goalPos(p.team, e.rules.half);
      const power = pk?.power ?? (action === "shoot_normal" ? kp.shoot : action === "shoot_finesse" ? kp.finesse : kp.volley);
      captureOffsideAtKick(e, p, activeRestart?.kind);
      releaseToKick(e, p);
      const spin = action === "shoot_finesse" ? p.style.finesseSide : 0;
      e.ball.kick(dirTo(tgt), power, action === "shoot_volley" ? 0.25 : 0.14, spin);
      e.tacticalStats.shots++;
      ballReleasedByAction = true;
      if (!activeRestart) e.openPlayKickCount++;
      e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} SHOOT (${action})`, p.team);
      break;
    }
    case "header": {
      if (p.pos.distanceTo(e.ball.pos) > 1.6) break;
      const tgt = pk?.target ?? e.ai.goalPos(p.team, e.rules.half);
      captureOffsideAtKick(e, p, activeRestart?.kind);
      releaseToKick(e, p);
      e.ball.kick(dirTo(tgt), kp.header, 0.2);
      ballReleasedByAction = true;
      break;
    }
    case "tackle_stand": case "tackle_slide": {
      const carrierIdx = e.ball.possessedBy;
      const carrier = carrierIdx !== null ? e.players[carrierIdx] : null;
      // A tackle wins the BALL, not the man: success requires the ball (glued ~0.48 m in
      // front of the carrier) inside the tackler's foot reach at the contact frame.
      // Lunge root motion has already closed ~1 m by contact. Tackling from behind or the
      // blind side reaches the carrier's body but not the ball → contact, no win.
      const footReach = action === "tackle_slide" ? 1.55 : 1.15;
      const maxReach = CONFIG.player.tackleRadius + (action === "tackle_slide" ? 0.9 : 0.75);
      const ballDist = Math.hypot(e.ball.pos.x - p.pos.x, e.ball.pos.z - p.pos.z);
      const villainClose = !!carrier && carrier.team !== p.team && ballDist < footReach;
      const ballClose = ballDist < footReach + 0.2;
      if (carrier && villainClose) {
        // Clean tackle win: tackler claims the ball and stumbles the carrier
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        e.offsideCandidates.clear(); e.offsideTeam = null;
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} wins tackle (${action})`, p.team);
        carrier.stumbleT = 0.75;
        startAction(e, carrier, "stumble");
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      } else if (carrier && carrier.team !== p.team && carrier.pos.distanceTo(p.pos) < maxReach + 0.45) {
        // Heavy contact with no ball access
        carrier.stumbleT = 0.8;
        startAction(e, carrier, "stumble");
        if (e.foulsOn) {
          const ownGoal = e.ai.ownGoal(carrier.team, e.rules.half);
          const inBox = Math.abs(carrier.pos.x - ownGoal.x) < 5.5 && Math.abs(carrier.pos.z) < 6.2;
          e.rules.emit("FOUL", `Foul by ${p.team === 0 ? "RED" : "BLUE"} ${action} @ (${carrier.pos.x.toFixed(1)},${carrier.pos.z.toFixed(1)})`, p.team);
          e.ball.pos.set(carrier.pos.x, CONFIG.ball.radius, carrier.pos.z);
          e.ball.vel.set(0, 0, 0); e.ball.release();
          e.rules.startSetup(inBox ? "penalty" : "free_kick", [carrier.pos.x, carrier.pos.z], carrier.team);
        } else {
          e.rules.emit("FOUL", `Heavy contact (hook off) — play on`, p.team);
        }
        if (action === "tackle_slide") startAction(e, p, "get_up");
      } else if (e.ball.possessedBy === null && ballClose) {
        // Poke/claim loose ball
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        e.offsideCandidates.clear(); e.offsideTeam = null;
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} claims loose ball (${action})`, p.team);
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      }
      break;
    }
    case "intercept": case "first_touch": case "dribble_touch": {
      if (e.ball.possessedBy === null && p.pos.distanceTo(e.ball.pos) < CONFIG.player.interceptRadius + 0.5) {
        e.ball.possess(p.idx, p.team);
        e.offsideCandidates.clear(); e.offsideTeam = null;
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${action} takes ball`, p.team);
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      }
      break;
    }
    case "gk_catch": case "gk_parry": case "gk_dive_L": case "gk_dive_R": {
      if (e.ball.possessedBy !== null) break;
      if (e.ball.handsRestrictedTeam === p.team) break;
      const diving = action === "gk_dive_L" || action === "gk_dive_R";
      // Hand reach at the contact frame. A dive's root motion has already displaced the
      // body, so its residual reach is the outstretched arm plus fingertips.
      // A keeper still moving across goal when the save fires is off-balance and loses reach
      // — unless the clip is a dive in that same direction (momentum then helps, not hurts).
      const lateralSpeed = Math.abs(p.vel.z);
      const movingWithDive = diving && Math.sign(p.vel.z) === Math.sign(e.ball.pos.z - p.pos.z);
      const offBalance = movingWithDive ? 0 : lateralSpeed * CONFIG.ai.gkOffBalancePenalty;
      const reach = Math.max(0.5, (diving ? CONFIG.ai.gkStandingReach + 0.8 : CONFIG.ai.gkStandingReach + 0.3) - offBalance);
      // Closest approach of the ball path over the contact window (it may still be arriving).
      let best = Infinity, bestH = e.ball.pos.y;
      for (let s = 0; s <= 6; s++) {
        const t = s * 0.025;
        const bx = e.ball.pos.x + e.ball.vel.x * t, bz = e.ball.pos.z + e.ball.vel.z * t;
        const by = e.ball.pos.y + e.ball.vel.y * t - 0.5 * CONFIG.ball.gravity * t * t;
        const dist = Math.hypot(bx - p.pos.x, bz - p.pos.z);
        if (dist < best) { best = dist; bestH = by; }
      }
      const inHeight = bestH < 2.35 && bestH > 0;
      if (best > reach || !inHeight) {
        aiEvent(e, `GK ${action} MISSED · ${best.toFixed(2)}m vs reach ${reach.toFixed(2)}m, h ${bestH.toFixed(2)}`);
        break;
      }
      const speed = e.ball.speed;
      // Catch only clean, central, not-too-hot balls; otherwise the save is a parry.
      if (action === "gk_catch" && speed < CONFIG.ai.gkCatchSpeed && best < CONFIG.ai.gkStandingReach + 0.15) {
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        e.offsideCandidates.clear(); e.offsideTeam = null;
        p.holdT = 0;
        aiEvent(e, `GK CATCH #${p.idx} · ${speed.toFixed(1)} m/s at ${best.toFixed(2)}m`);
        e.rules.emit("SAVE", `GK CATCH by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
        break;
      }
      // Parry: deflect wide of goal, keeping some of the shot's energy.
      const ownGoal = e.ai.ownGoal(p.team, e.rules.half);
      const away = e.ball.pos.clone().sub(ownGoal).setY(0).normalize();
      away.z += (e.ball.pos.z >= p.pos.z ? 1 : -1) * 0.7;
      releaseToKick(e, p);
      e.ball.kick(away.normalize(), THREE.MathUtils.clamp(speed * 0.4, 5, 12), 0.3);
      e.offsideCandidates.clear(); e.offsideTeam = null;
      aiEvent(e, `GK PARRY #${p.idx} (${action}) · ${speed.toFixed(1)} m/s at ${best.toFixed(2)}m`);
      e.rules.emit("SAVE", `GK ${action} — parried!`, p.team);
      break;
    }
    case "gk_punt": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) {
        p.decisionReason = "GK PUNT CANCELLED · no valid named teammate";
        break;
      }
      releaseToKick(e, p);
      e.ball.kick(plan.target.clone().sub(e.ball.pos).setY(0).normalize(), plan.power, plan.loft);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "gk_roll": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) { p.decisionReason = "GK ROLL CANCELLED · no valid named teammate"; break; }
      releaseToKick(e, p);
      e.ball.kick(plan.target.clone().sub(e.ball.pos).setY(0).normalize(), plan.power, plan.loft);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "corner_kick": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) { p.decisionReason = "CORNER CANCELLED · no valid named runner"; break; }
      releaseToKick(e, p);
      e.ball.kick(plan.target.clone().sub(e.ball.pos).setY(0).normalize(), plan.power, plan.loft, p.style.finesseSide);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "throw_in": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      // Only the restart taker may release the ball — prevents a stray
      // throw_in animation from ejecting a ball another player owns.
      if (!ownerIsMe && !p.restartTaker) break;
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) { p.decisionReason = "THROW CANCELLED · no valid named teammate"; break; }
      e.ball.release();
      e.ball.pos.set(p.pos.x, 1.65, p.pos.z);
      e.ball.lastTouch = p.idx; e.ball.lastTouchTeam = p.team;
      const throwAim = plan.target.clone().sub(e.ball.pos).setY(0).normalize();
      const throwDot = passAimDot(e.ball.pos, throwAim.clone().multiplyScalar(plan.power), plan.target);
      if (!passAimIsValid(throwDot, CONFIG.ai.passAimConeDegrees)) {
        e.ball.pos.set(p.pos.x, CONFIG.ball.radius, p.pos.z);
        e.ball.vel.set(0, 0, 0);
        p.decisionReason = "THROW CANCELLED · aim outside receiver cone";
        break;
      }
      e.ball.kick(throwAim, plan.power, plan.loft);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
  }
  if (ballReleasedByAction) {
    aiEvent(e, `KICK released by #${p.idx} ${p.role} · ${action} · ${e.ball.speed.toFixed(1)} m/s${pk?.passTo !== undefined ? ` → #${pk.passTo}` : ""}`);
  } else if (pk && pk.action === action && (action === "tackle_stand" || action === "tackle_slide")) {
    const won = e.ball.possessedBy === p.idx;
    aiEvent(e, `TACKLE ${won ? "WON" : "MISSED"} #${p.idx} · ${action}`);
  } else if (pk && pk.action === action && (action === "intercept" || action === "first_touch" || action === "header" || action.startsWith("gk_"))) {
    const won = e.ball.possessedBy === p.idx;
    aiEvent(e, `${action.toUpperCase()} ${won ? "WON" : "MISSED"} #${p.idx}`);
  } else if (pk && pk.action === action) {
    aiEvent(e, `KICK CANCELLED #${p.idx} · ${action} · ${p.decisionReason}`);
    e.ai.nextThink.set(p.idx, 0); // carrier re-decides immediately instead of stalling
  }
  if (p.restartTaker && activeRestart && e.restartStartedId === activeRestart.id) {
    if (ballReleasedByAction) {
      e.restartLaunchedId = activeRestart.id;
      e.rules.pendingRestart = null;
      p.restartTaker = false;
    } else if (++e.restartRetries >= 3) {
      // No valid receiver after 3 samples: give the taker the ball in play.
      e.restartLaunchedId = activeRestart.id;
      e.rules.pendingRestart = null;
      p.restartTaker = false;
      const inX = THREE.MathUtils.clamp(p.pos.x, -CONFIG.pitch.length / 2 + 1, CONFIG.pitch.length / 2 - 1);
      const inZ = THREE.MathUtils.clamp(p.pos.z, -CONFIG.pitch.width / 2 + 1, CONFIG.pitch.width / 2 - 1);
      p.pos.set(inX, 0, inZ);
      e.ball.pos.set(inX, CONFIG.ball.radius, inZ);
      e.ball.possess(p.idx, p.team);
      aiEvent(e, `RESTART released to taker #${p.idx} after ${e.restartRetries} failed deliveries`);
    } else {
      // Restart delivery cancelled: retake promptly with a newly sampled target.
      e.restartStartedId = -1;
      e.restartAutoT = 0.2;
    }
  }
  p.pendingKick = null;
}
