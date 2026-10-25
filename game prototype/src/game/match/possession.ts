// Possession and ball-state bookkeeping: who owns the ball and for how long, the
// attacking-transition window, reception/header triggers, and out-of-play / goal
// detection at the pitch boundary.
import * as THREE from "three";
import { CONFIG } from "../config";
import { aiEvent } from "./debug";
import { flagOffside } from "./offside";
import { setHumanPlayer, switchToNearest } from "./roster";
import { startAction } from "./actions";
import { resetTackleState } from "./tackles";
import { tieBreakHash } from "../random";
import type { MatchHost } from "./host";

/** Possession clock: carrier time on the ball, attacking-transition window. */
export function trackPossession(e: MatchHost) {
  const idx = e.ball.possessedBy;
  const team = e.ball.ownerTeam;
  if (idx !== e.seenOwner) {
    e.possessionStartedAt = e.clock;
    // A loose ball does not erase which team last had it. If seenOwnerTeam is
    // nulled while the ball is free, the side that recovers a parry, deflection
    // or tackle spill never starts an attacking transition even though
    // possession changed hands. Only the owner index is cleared while free;
    // the last-owning team survives until a new owner is established.
    if (idx === null) {
      e.seenOwner = null;
    } else {
      if (team !== null && e.seenOwnerTeam !== null && team !== e.seenOwnerTeam) {
        e.transitionTeam = team;
        e.transitionUntil = e.clock + CONFIG.tactics.transitionSeconds;
      }
      e.seenOwner = idx;
      e.seenOwnerTeam = team;
    }
  }
}

/** Reception: traps, keeper claims, headers and the human auto-switch. */
export function possessionCheck(e: MatchHost) {
  if (e.ball.possessedBy !== null) {
    const o = e.players[e.ball.possessedBy];
    // ---- Goalkeeper hands at a dribbler's feet ------------------------------
    // A keeper does not challenge a carrier in his own box with a foot: he
    // smothers the ball with his gloves. Without this the carrier's body simply
    // owned the ball inside the six-yard area and the keeper could never take it.
    if (o.role !== "GK") {
      const gk = e.players.find((q) => q.role === "GK" && q.team !== o.team);
      if (gk) {
        const ownGoal = e.ai.ownGoal(gk.team, e.rules.half);
        const inOwnBox = Math.abs(gk.pos.x - ownGoal.x) < 5.8 && Math.abs(gk.pos.z) < 6.2;
        const ballToGk = gk.pos.distanceTo(e.ball.pos);
        const handsRange = CONFIG.ai.gkSmotherRange * (0.85 + gk.attributes.goalkeeping.reach / 500);
        // Give the keeper a beat to react to the first touch, and never steal a
        // ball that was just won in a tackle (that carrier is protected).
        const reacted = e.clock - e.possessionStartedAt > 0.25;
        if (reacted && inOwnBox && e.ball.pos.y < CONFIG.ai.gkSmotherHeight
          && ballToGk < handsRange && ballToGk < gk.pos.distanceTo(o.pos)
          && o.tackleProtectionT <= 0 && gk.stumbleT <= 0
          && e.ball.handsRestrictedTeam !== gk.team) {
          e.ball.possess(gk.idx, gk.team);
          e.ball.vel.set(0, 0, 0);
          gk.holdT = 0;
          startAction(e, gk, "gk_catch");
          e.offsideCandidates.clear(); e.offsideTeam = null;
          aiEvent(e, `GK SMOTHER #${gk.idx} · hands on #${o.idx}'s feet at ${ballToGk.toFixed(2)}m`);
          e.rules.emit("SAVE", `GK SMOTHER by ${gk.team === 0 ? "RED" : "BLUE"} — hands on the ball`, gk.team);
          return;
        }
      }
    }
    // Auto-switch only on a possession change; a manual [X] switch stays under the user's control.
    if (o.idx !== e.lastKnownOwnerIdx) {
      if (!e.spectator && o.team === e.humanTeam) setHumanPlayer(e, o);
      else if (!e.spectator && e.lastKnownOwnerTeam === e.humanTeam) switchToNearest(e, false);
    }
    e.lastKnownOwnerTeam = o.team;
    e.lastKnownOwnerIdx = o.idx;
    // Frame-derived, not a shared PRNG draw: an extra dribble touch must not
    // shift AI decision noise or restart sampling later in the match.
    const frame = Math.round(e.clock * 60);
    const dribbleRoll = tieBreakHash(e.matchSeed, o.idx, frame, `dribble:${frame}`);
    if (o.speed > 5.5 && !o.anim.busy && dribbleRoll < 0.025 * o.style.carry * (0.5 + o.attributes.ballControl.runningPossession / 150)) startAction(e, o, "dribble_touch");
    return;
  }

  // Free ball reception / trapping: check all active players
  for (const p of e.players) {
    if (p.stumbleT > 0) continue; // recovering from tackle, cannot trap
    // The striker cannot instantly re-trap their own kick: at release the ball is still
    // inside their control radius, which previously turned every pass into a self-retrap.
    if (p.idx === e.ball.kickedBy && e.ball.kickAge < 0.45) continue;
    const d = p.pos.distanceTo(e.ball.pos);
    const isGK = p.role === "GK";
    const ownGoal = e.ai.ownGoal(p.team, e.rules.half);
    const inPenaltyBox = Math.abs(p.pos.x - ownGoal.x) < 5.8 && Math.abs(p.pos.z) < 6.2;

    // GK catch in penalty box:
    // Automatic claim is for soft/loose balls only; shots go through the save model.
    const gkControlScale = isGK ? 0.5 + p.attributes.goalkeeping.reach / 150 : 1;
    const gkCatchSpeed = isGK ? 9 * (0.5 + (p.attributes.goalkeeping.handling + p.attributes.goalkeeping.catching) / 300) : 9;
    if (isGK && inPenaltyBox && e.ball.handsRestrictedTeam !== p.team && d < (CONFIG.ai.catchRadius + 0.6) * gkControlScale && e.ball.pos.y < 1.95 && e.ball.speed < gkCatchSpeed) {
      e.ball.possess(p.idx, p.team);
      e.ball.vel.set(0, 0, 0);
      startAction(e, p, "gk_catch");
      e.rules.emit("SAVE", `GK CATCH by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
      return;
    }

    // Ground / low ball reception (< 0.75 m height): cushion and take possession — but
    // only at a controllable pace. A footballer can kill a firm pass (~14 m/s); a 25 m/s
    // drive cannot be "trapped" (it deflects off the body instead). Keepers in their own
    // box never use this path: shots must go through the save model.
    const receivingScale = 0.5 + p.attributes.ballControl.groundReceiving / 150;
    const trapRadius = (CONFIG.player.controlRadius + 0.3) * receivingScale;
    const controllable = e.ball.speed <= CONFIG.player.maxTrapSpeed * receivingScale;
    if (d < trapRadius && e.ball.pos.y < 0.75 && controllable && (!(isGK && inPenaltyBox) || e.ball.handsRestrictedTeam === p.team)) {
      if (flagOffside(e, p)) return;
      e.ball.possess(p.idx, p.team);
      e.ball.vel.set(0, 0, 0);
      startAction(e, p, "first_touch");
      if (isGK) e.tacticalStats.keeperFootControls++;
      aiEvent(e, `POSSESSION granted → #${p.idx} ${p.role} (trap at ${d.toFixed(2)}m)`);
      e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${p.role} #${p.idx} controls ball`, p.team);
      if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      return;
    }

    // Aerial ball cushion / header:
    const highBallScale = 0.5 + p.attributes.ballControl.highBallReceiving / 150;
    const headerHeight = 2.3 + (p.attributes.physical.jumping - 75) * 0.005;
    if (d < 1.35 * highBallScale && e.ball.pos.y >= 0.75 && e.ball.pos.y < headerHeight && !p.anim.busy && !isGK && e.ball.speed < 22 * highBallScale) {
      if (flagOffside(e, p)) return;
      const target = e.ai.goalPos(p.team, e.rules.half);
      target.z = THREE.MathUtils.clamp(e.ball.pos.z * 0.5, -1.1, 1.1);
      startAction(e, p, "header", target);
      return;
    }
  }
}

/** Goals, goal kicks, corners and throw-ins at the pitch boundary. */
export function outGoalCheck(e: MatchHost) {
  const L = CONFIG.pitch.length / 2, Wd = CONFIG.pitch.width / 2;
  const GW = CONFIG.pitch.goalWidth / 2, GH = CONFIG.pitch.goalHeight;
  const R = CONFIG.ball.radius;
  const b = e.ball.pos;
  // Prefer the actual last touch, then the player's team, then the last known
  // owner. Only an entirely untouched ball falls back to team 0 instead of
  // silently awarding possession on an unknown touch.
  const touchTeam = e.ball.lastTouchTeam
    ?? (e.ball.lastTouch !== null ? e.players[e.ball.lastTouch]?.team : undefined)
    ?? e.lastKnownOwnerTeam;
  // The whole ball must cross the line between the posts and under the bar —
  // judged where the swept segment prevPos→pos crosses the line plane, not by
  // where the ball happens to be when the frame ends. A 24–35 m/s shot moves
  // 1.2–3.5 m per frame (dt up to 0.05 s, doubled at timeScale 2), so the old
  // end-of-frame test tunnelled clean over the 1.6 m net window, and a
  // diagonal shot that crossed inside the post was wide of it again by the
  // detection frame: valid goals came back as goal kicks / corners.
  const prev = e.ball.prevPos;
  let crossedGoalLine = false;
  let goalLineCrossZ = b.z;
  for (const side of [1, -1]) {
    const plane = side * (L + R);
    const wasIn = side > 0 ? prev.x <= plane : prev.x >= plane;
    const nowOut = side > 0 ? b.x > plane : b.x < plane;
    if (!wasIn || !nowOut) continue;
    crossedGoalLine = true;
    const t = (plane - prev.x) / (b.x - prev.x);
    goalLineCrossZ = prev.z + (b.z - prev.z) * t;
    const crossY = prev.y + (b.y - prev.y) * t;
    if (Math.abs(goalLineCrossZ) + R < GW && crossY + R < GH) {
      e.rules.goal(e.ai.attackSign(0, e.rules.half) === side ? 0 : 1); onGoalReset(e); return;
    }
  }
  // No swept crossing this frame (ball teleported or already behind the line
  // when play resumed): fall back to the stationary net-volume test.
  if (!crossedGoalLine && Math.abs(b.z) + R < GW && b.y + R < GH) {
    if (b.x > L + R && b.x < L + CONFIG.pitch.goalDepth + 0.4) {
      e.rules.goal(e.ai.attackSign(0, e.rules.half) > 0 ? 0 : 1); onGoalReset(e); return;
    }
    if (b.x < -L - R && b.x > -L - CONFIG.pitch.goalDepth - 0.4) {
      e.rules.goal(e.ai.attackSign(0, e.rules.half) < 0 ? 0 : 1); onGoalReset(e); return;
    }
  }
  if (b.x > L + R || b.x < -L - R) {
    const side = b.x > 0 ? 1 : -1;
    const attacker = e.ai.attackSign(0, e.rules.half) === side ? 0 : 1;
    const defender = 1 - attacker;
    const lastT = touchTeam ?? attacker; // unknown goal-line touch: safest is a goal kick
    if (lastT === attacker) {
      const gx = side * (L - 2.0);
      e.outRestartCount++;
      e.rules.startSetup("goal_kick", [gx, 0], defender);
    } else {
      const cx = side * (L - 0.25);
      // Corner flag on the side where the ball actually crossed the line,
      // which at shot pace can differ from where it ends the frame.
      const cz = (goalLineCrossZ >= 0 ? 1 : -1) * (Wd - 0.25);
      e.outRestartCount++;
      e.rules.startSetup("corner", [cx, cz], attacker);
    }
    e.ball.release(); e.ball.vel.set(0, 0, 0);
    e.offsideCandidates.clear(); e.offsideTeam = null;
    return;
  }
  if (Math.abs(b.z) > Wd + R) {
    const lastT = touchTeam ?? 0;
    const team = 1 - lastT;
    // Throw from where the ball crossed the touchline, not from wherever it
    // was first sampled outside (metres further along at pass pace).
    const touchPlane = Math.sign(b.z) * (Wd + R);
    const crossX = Math.sign(prev.z) === Math.sign(b.z) && b.z !== prev.z
      ? prev.x + (b.x - prev.x) * THREE.MathUtils.clamp((touchPlane - prev.z) / (b.z - prev.z), 0, 1) : b.x;
    const cx = THREE.MathUtils.clamp(crossX, -L + 0.25, L - 0.25);
    const cz = (b.z > 0 ? 1 : -1) * (Wd - 0.25);
    e.outRestartCount++;
    e.rules.startSetup("throw_in", [cx, cz], team);
    e.ball.release(); e.ball.vel.set(0, 0, 0);
    e.offsideCandidates.clear(); e.offsideTeam = null;
  }
}

/** Clear pending intents and the offside snapshot when a goal goes in. */
export function onGoalReset(e: MatchHost) {
  // ball stays in net during celebration; reset at kickoff setup (handled by rules GOAL→SETUP)
  for (const p of e.players) {
    p.pendingKick = null;
    resetTackleState(p);
  }
  e.offsideCandidates.clear(); e.offsideTeam = null;
}
