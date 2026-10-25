// Possession and ball-state bookkeeping: who owns the ball and for how long, the
// attacking-transition window, reception/header triggers, and out-of-play / goal
// detection at the pitch boundary.
import * as THREE from "three";
import { CONFIG } from "../config";
import { aiEvent } from "./debug";
import { flagOffside } from "./offside";
import { setHumanPlayer, switchToNearest } from "./roster";
import { startAction } from "./actions";
import type { MatchHost } from "./host";

/** Possession clock: carrier time on the ball, attacking-transition window. */
export function trackPossession(e: MatchHost) {
  const idx = e.ball.possessedBy;
  const team = e.ball.ownerTeam;
  if (idx !== e.seenOwner) {
    e.possessionStartedAt = e.clock;
    if (team !== null && e.seenOwnerTeam !== null && team !== e.seenOwnerTeam) {
      e.transitionTeam = team;
      e.transitionUntil = e.clock + CONFIG.tactics.transitionSeconds;
    }
    e.seenOwner = idx;
    e.seenOwnerTeam = team;
    if (e.possessionTicks.length > 400) e.possessionTicks.shift();
    if (idx !== null && team !== null) e.possessionTicks.push({ idx, team });
  }
}

/** Reception: traps, keeper claims, headers and the human auto-switch. */
export function possessionCheck(e: MatchHost) {
  if (e.ball.possessedBy !== null) {
    const o = e.players[e.ball.possessedBy];
    // Auto-switch only on a possession change; a manual [X] switch stays under the user's control.
    if (o.idx !== e.lastKnownOwnerIdx) {
      if (!e.spectator && o.team === e.humanTeam) setHumanPlayer(e, o);
      else if (!e.spectator && e.lastKnownOwnerTeam === e.humanTeam) switchToNearest(e, false);
    }
    e.lastKnownOwnerTeam = o.team;
    e.lastKnownOwnerIdx = o.idx;
    if (o.speed > 5.5 && !o.anim.busy && e.rng.next() < 0.025 * o.style.carry) startAction(e, o, "dribble_touch");
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
    if (isGK && inPenaltyBox && e.ball.handsRestrictedTeam !== p.team && d < CONFIG.ai.catchRadius + 0.6 && e.ball.pos.y < 1.95 && e.ball.speed < 9) {
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
    const trapRadius = CONFIG.player.controlRadius + 0.3; // ~1.05m
    const controllable = e.ball.speed <= CONFIG.player.maxTrapSpeed;
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
    if (d < 1.35 && e.ball.pos.y >= 0.75 && e.ball.pos.y < 2.3 && !p.anim.busy && !isGK && e.ball.speed < 22) {
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
  // The whole ball must cross the line, stay inside the net volume, fit between posts and under the bar.
  if (Math.abs(b.z) + R < GW && b.y + R < GH) {
    if (b.x > L + R && b.x < L + CONFIG.pitch.goalDepth + 0.4) {
      e.rules.goal(e.ai.attackSign(0, e.rules.half) > 0 ? 0 : 1); onGoalReset(e, ); return;
    }
    if (b.x < -L - R && b.x > -L - CONFIG.pitch.goalDepth - 0.4) {
      e.rules.goal(e.ai.attackSign(0, e.rules.half) < 0 ? 0 : 1); onGoalReset(e, ); return;
    }
  }
  if (b.x > L + R || b.x < -L - R) {
    const side = b.x > 0 ? 1 : -1;
    const lastT = e.ball.lastTouchTeam ?? 0;
    const attacker = e.ai.attackSign(0, e.rules.half) === side ? 0 : 1;
    const defender = 1 - attacker;
    if (lastT === attacker) {
      const gx = side * (L - 2.0);
      e.outRestartCount++;
      e.rules.startSetup("goal_kick", [gx, 0], defender);
    } else {
      const cx = side * (L - 0.25);
      const cz = (b.z >= 0 ? 1 : -1) * (Wd - 0.25);
      e.outRestartCount++;
      e.rules.startSetup("corner", [cx, cz], attacker);
    }
    e.ball.release(); e.ball.vel.set(0, 0, 0);
    e.offsideCandidates.clear(); e.offsideTeam = null;
    return;
  }
  if (Math.abs(b.z) > Wd + R) {
    const lastT = e.ball.lastTouchTeam ?? 0;
    const team = 1 - lastT;
    const cx = THREE.MathUtils.clamp(b.x, -L + 0.25, L - 0.25);
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
  for (const p of e.players) p.pendingKick = null;
  e.offsideCandidates.clear(); e.offsideTeam = null;
}
