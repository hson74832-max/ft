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
import { releaseRestartToTaker } from "./restarts";
import {
  evaluateTackle, isTackleAction, spillDirection, tackleReach, tackleRecovery,
  type TackleOutcome,
} from "./tackles";
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
  if (b) {
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return v;
  }
  // A missing bone must not turn every contact into a false alignment at (0,0,0).
  // Fall back to the player's own striking point in world space.
  const fx = Math.cos(p.facing), fz = -Math.sin(p.facing);
  return new THREE.Vector3(
    p.pos.x + fx * 0.45,
    which === "head" ? 1.65 : which === "hands" ? 1.15 : 0.12,
    p.pos.z + fz * 0.45,
  );
}

/** Resolve an action's contact frame against the ball, then close the restart out. */
export function onContact(e: MatchHost, p: EnginePlayer, action: string) {
  const pk = p.pendingKick;
  const activeRestart = e.rules.pendingRestart;
  let ballReleasedByAction = false;
  let tackleOutcome: TackleOutcome | null = null;
  let tackleDetail = "";
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
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "tackle_stand": case "tackle_slide": {
      if (!isTackleAction(action)) break;
      const carrierIdx = e.ball.possessedBy;
      const carrier = carrierIdx !== null ? e.players[carrierIdx] : null;
      const quality = evaluateTackle(e, p, action);
      const stats = e.tacticalStats;
      stats.tacklesAttempted++;
      tackleDetail = quality.reason;
      // Recovery is paid for the attempt. A foul costs extra, and a slide that
      // misses still has to get up before it can challenge again.
      p.tackleRecoveryT = Math.max(p.tackleRecoveryT,
        tackleRecovery(action) + (quality.outcome === "foul" ? 0.45 : 0));

      if (carrierIdx === null && quality.ballDist < tackleReach(action)
        && quality.score >= CONFIG.tackle.spillScore) {
        // Loose-ball challenge: a high-quality poke may still claim it, but a
        // poor challenge never turns into free possession.
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        p.tackleProtectionT = CONFIG.tackle.possessionProtection;
        e.offsideCandidates.clear(); e.offsideTeam = null;
        tackleOutcome = "clean";
        stats.tacklesWon++;
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} claims loose ball (${action})`, p.team);
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} claims loose ball (${action})`, p.team);
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      } else if (quality.outcome === "clean" && carrier) {
        // Ball-first, front/side-on and on time: take possession, then protect
        // it briefly so the dispossessed player cannot instantly win it back.
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        p.tackleProtectionT = CONFIG.tackle.possessionProtection;
        e.offsideCandidates.clear(); e.offsideTeam = null;
        tackleOutcome = "clean";
        stats.tacklesWon++;
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} wins tackle (${action}) · q ${quality.score.toFixed(2)}`, p.team);
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} wins tackle (${action})`, p.team);
        carrier.stumbleT = 0.75;
        startAction(e, carrier, "stumble");
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      } else if (quality.outcome === "spill" && carrier) {
        // A half-won challenge knocks the ball into neutral space. Neither
        // duellist gets it glued to their feet; the re-trap guard prevents the
        // challenger from collecting his own touch on the very next frame.
        const dir = spillDirection(e, p, carrier);
        releaseToKick(e, p);
        e.ball.pos.add(new THREE.Vector3(dir.x * CONFIG.tackle.spillDistance, 0, dir.z * CONFIG.tackle.spillDistance));
        e.ball.pos.y = Math.max(CONFIG.ball.radius, e.ball.pos.y);
        e.ball.kick(new THREE.Vector3(dir.x, 0, dir.z), CONFIG.tackle.spillSpeed, 0.06);
        e.ball.kickedBy = p.idx;
        e.ball.kickAge = 0;
        e.offsideCandidates.clear(); e.offsideTeam = null;
        tackleOutcome = "spill";
        stats.tacklesSpilled++;
        carrier.stumbleT = Math.max(carrier.stumbleT, 0.35);
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} spills tackle (${action}) · q ${quality.score.toFixed(2)}`, p.team);
      } else if (quality.outcome === "foul" && carrier) {
        tackleOutcome = "foul";
        stats.fouls++;
        carrier.stumbleT = CONFIG.tackle.foulStumble;
        startAction(e, carrier, "stumble");
        e.rules.emit("FOUL", `Foul by ${p.team === 0 ? "RED" : "BLUE"} ${action} · ${quality.reason}`, p.team);
        if (e.foulsOn) {
          const ownGoal = e.ai.ownGoal(carrier.team, e.rules.half);
          const inBox = Math.abs(carrier.pos.x - ownGoal.x) < 5.5 && Math.abs(carrier.pos.z) < 6.2;
          e.ball.pos.set(carrier.pos.x, CONFIG.ball.radius, carrier.pos.z);
          e.ball.vel.set(0, 0, 0);
          e.ball.release();
          e.offsideCandidates.clear(); e.offsideTeam = null;
          e.rules.startSetup(inBox ? "penalty" : "free_kick", [carrier.pos.x, carrier.pos.z], carrier.team);
        } else {
          // Fouls may be disabled for a no-whistle prototype, but the bad
          // challenge is still punished: no possession, recovery and a stumble.
          e.rules.emit("TACKLE", "Bad challenge · fouls disabled, play on", p.team);
        }
      } else {
        tackleOutcome = "miss";
        stats.tacklesMissed++;
        p.stumbleT = Math.max(p.stumbleT, CONFIG.tackle.missStumble);
        if (quality.heavyContact && carrier) carrier.stumbleT = Math.max(carrier.stumbleT, 0.2);
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} missed tackle (${action}) · q ${quality.score.toFixed(2)}`, p.team);
      }
      if (action === "tackle_slide" && tackleOutcome !== "clean") p.anim.requestAction("get_up", true);
      p.decisionReason = `TACKLE ${tackleOutcome?.toUpperCase()} · ${quality.reason}`;
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
  } else if (tackleOutcome) {
    aiEvent(e, `TACKLE ${tackleOutcome === "clean" ? "WON" : "MISSED"} #${p.idx} · ${action} · ${tackleOutcome} · ${tackleDetail}`);
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
      // Never clamp a throw-in / corner taker back onto the pitch: they stand
      // outside the touchline by law, so use the buffer margin instead.
      e.restartLaunchedId = activeRestart.id;
      e.rules.pendingRestart = null;
      releaseRestartToTaker(e, p);
    } else {
      // Restart delivery cancelled: retake promptly with a newly sampled target.
      e.restartStartedId = -1;
      e.restartAutoT = 0.2;
    }
  }
  p.pendingKick = null;
  if (isTackleAction(action)) p.tackleChallenge = null;
}
