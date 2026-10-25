/**
 * Deterministic tackle duels.
 *
 * A challenge is not a coin flip and does not draw from the match RNG. The same
 * world state, wind-up time, approach angle, balance and player attributes
 * always produce the same quality and outcome. The quality is a bounded 0..1
 * score used as a threshold, not a probability.
 *
 * The state machine also separates *attempt recovery* from *possession
 * protection*: the challenger cannot immediately tackle again, and the player
 * who wins the ball has a short shield before an opponent can challenge him.
 * That is what breaks the A-wins/B-wins/A-wins ping-pong at the ball.
 */
import { CONFIG } from "../config";
import { getClip } from "../anims";
import type { MatchHost } from "./host";
import type { EnginePlayer, TackleChallenge } from "./types";

export type TackleAction = "tackle_stand" | "tackle_slide";
export type TackleOutcome = "clean" | "spill" | "miss" | "foul";

export interface TackleQuality {
  score: number;
  outcome: TackleOutcome;
  ballFirst: boolean;
  heavyContact: boolean;
  facingDot: number;
  frontDot: number;
  lateRatio: number;
  staleTarget: boolean;
  protectedCarrier: boolean;
  mistimed: boolean;
  ballDist: number;
  carrierDist: number;
  elapsed: number;
  idealContact: number;
  reason: string;
}

export function isTackleAction(action: string): action is TackleAction {
  return action === "tackle_stand" || action === "tackle_slide";
}

export function tackleReach(action: TackleAction): number {
  return action === "tackle_slide" ? CONFIG.tackle.slideReach : CONFIG.tackle.standReach;
}

export function tackleBodyReach(action: TackleAction): number {
  return action === "tackle_slide" ? CONFIG.tackle.slideBodyReach : CONFIG.tackle.standBodyReach;
}

export function tackleRecovery(action: TackleAction): number {
  return action === "tackle_slide" ? CONFIG.tackle.slideRecovery : CONFIG.tackle.standRecovery;
}

export function tackleCooldown(action: TackleAction): number {
  return action === "tackle_slide" ? CONFIG.tackle.slideCooldown : CONFIG.tackle.standCooldown;
}

/** +X at yaw 0, +Z is right — the same convention as `yawOfVector`. */
export function forwardOf(facing: number): { x: number; z: number } {
  return { x: Math.cos(facing), z: -Math.sin(facing) };
}

function groundDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function normalTo(from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number } {
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz);
  return len > 1e-5 ? { x: dx / len, z: dz / len } : { x: 0, z: 0 };
}

/** Decay timers on every player, including the human and frozen/restart branches. */
export function decayTackleTimers(p: EnginePlayer, dt: number): void {
  p.tackleRecoveryT = Math.max(0, p.tackleRecoveryT - dt);
  p.tackleProtectionT = Math.max(0, p.tackleProtectionT - dt);
}

export function resetTackleState(p: EnginePlayer): void {
  p.tackleRecoveryT = 0;
  p.tackleProtectionT = 0;
  p.tackleChallenge = null;
}

export function carrierIsProtected(e: MatchHost): boolean {
  const idx = e.ball.possessedBy;
  return idx !== null && (e.players[idx]?.tackleProtectionT ?? 0) > 0;
}

/**
 * A keeper holding the ball is not a tackleable carrier: the ball is in his hands,
 * not at his feet. The only exception is a keeper playing a deliberate back-pass
 * with his feet (`handsRestrictedTeam`), which is an ordinary challenge.
 */
export function keeperHasBallInHands(e: MatchHost): boolean {
  const idx = e.ball.possessedBy;
  const carrier = idx !== null ? e.players[idx] : null;
  return !!carrier && carrier.role === "GK" && e.ball.handsRestrictedTeam !== carrier.team;
}

/** Freeze the challenge at action start; a delayed or altered contact frame is judged late. */
export function beginTackle(e: MatchHost, p: EnginePlayer, action: TackleAction): void {
  const meta = getClip(action);
  const targetIdx = e.ball.possessedBy;
  const carrier = targetIdx !== null ? e.players[targetIdx] : null;
  const challenge: TackleChallenge = {
    action,
    startedAt: e.clock,
    targetIdx,
    targetTeam: carrier?.team ?? e.ball.ownerTeam,
    idealContact: meta.duration * (meta.contactFrame ?? 0.5),
    startBallDist: groundDistance(p.pos, e.ball.pos),
    startCarrierDist: carrier ? groundDistance(p.pos, carrier.pos) : Infinity,
  };
  p.tackleChallenge = challenge;
  // Recovery starts with the ATTEMPT, not at the contact frame. A whiff cannot
  // be animation-cancelled into an immediate second challenge.
  p.tackleRecoveryT = Math.max(p.tackleRecoveryT, tackleRecovery(action));
}

/**
 * Resolve the contact frame from geometry and timing. No `rng`, no `Math.random`,
 * no frame-rate-dependent random draws; `e.clock` is the fixed simulation clock.
 */
export function evaluateTackle(e: MatchHost, p: EnginePlayer, action: TackleAction): TackleQuality {
  const challenge = p.tackleChallenge?.action === action ? p.tackleChallenge : null;
  const carrierIdx = e.ball.possessedBy;
  const carrier = carrierIdx !== null ? e.players[carrierIdx] : null;
  const hostile = !!carrier && carrier.team !== p.team;
  const reach = tackleReach(action);
  const bodyReach = tackleBodyReach(action);
  const ballDist = groundDistance(p.pos, e.ball.pos);
  const carrierDist = carrier ? groundDistance(p.pos, carrier.pos) : Infinity;

  const toBall = normalTo(p.pos, e.ball.pos);
  const forward = forwardOf(p.facing);
  const facingDot = forward.x * toBall.x + forward.z * toBall.z;
  const fromCarrier = carrier ? normalTo(carrier.pos, p.pos) : { x: 0, z: 0 };
  const carrierForward = carrier ? forwardOf(carrier.facing) : { x: 0, z: 0 };
  // >0: challenger is in front of the carrier and can see the ball.
  // <0: challenger arrived from the blind side / behind the shielding body.
  const frontDot = carrier ? carrierForward.x * fromCarrier.x + carrierForward.z * fromCarrier.z : 0;

  const meta = getClip(action);
  const idealContact = challenge?.idealContact ?? meta.duration * (meta.contactFrame ?? 0.5);
  const elapsed = challenge ? Math.max(0, e.clock - challenge.startedAt) : idealContact + 1;
  const lateRatio = THREEClamp((elapsed - idealContact) / Math.max(0.12, idealContact), 0, 1.5);
  const staleTarget = !!challenge && challenge.targetIdx !== null && challenge.targetIdx !== carrierIdx;
  // The keeper gathering the ball mid-challenge makes the target untouchable, exactly
  // like a carrier inside the post-tackle protection window.
  const keeperCarrier = !!carrier && carrier.role === "GK" && e.ball.handsRestrictedTeam !== carrier.team;
  const protectedCarrier = keeperCarrier || (!!carrier && (carrier.tackleProtectionT ?? 0) > 0);
  const approachGain = challenge ? challenge.startBallDist - ballDist : 0;
  const speedDenom = Math.max(1, CONFIG.player.sprintSpeed);

  let score = action === "tackle_slide" ? 0.5 - CONFIG.tackle.slideControlPenalty : 0.55;
  score += 0.18 * THREEClamp(facingDot, 0, 1);
  score += 0.08 * THREEClamp(frontDot, 0, 1);
  score += 0.07 * THREEClamp(1 - ballDist / reach, 0, 1);
  score += 0.04 * THREEClamp(approachGain, 0, 1);
  score += 0.03 * (THREEClamp(p.stamina, 0, 1) - 0.7);
  score += 0.03 * THREEClamp(p.style.pressing - 0.8, -0.3, 0.5);
  score -= 0.05 * THREEClamp((carrier?.speed ?? 0) / speedDenom, 0, 1);
  score -= 0.04 * THREEClamp(p.speed / speedDenom, 0, 1);
  score -= 0.25 * THREEClamp(-frontDot - 0.3, 0, 1);      // blind-side / from behind
  score -= 0.3 * THREEClamp(0.1 - facingDot, 0, 1);       // not facing the ball
  score -= CONFIG.tackle.lateContactPenalty * lateRatio;
  if (staleTarget) score -= CONFIG.tackle.staleTargetPenalty;
  if (protectedCarrier) score -= 0.5;
  if (approachGain < -0.3) score -= 0.12;                  // overran the ball
  score = THREEClamp(score, 0, 1);

  const ballFirst = hostile && ballDist <= reach && facingDot >= 0.1
    && !staleTarget && !protectedCarrier && carrier !== null;
  const heavyContact = hostile && carrierDist <= bodyReach;
  const blindside = frontDot < -0.35;
  const late = staleTarget || lateRatio > 0.45;
  // Contact timing. The contact frame always fires at the clip's own contact frame, so
  // a challenge is mistimed when that frame lands with the body on the carrier but the
  // ball outside reach — the defender hit the man, not the ball. A small tolerance over
  // the reach keeps a legitimate toe-poke that simply stops short from being a foul.
  const mistimed = heavyContact && ballDist > reach * 1.6;

  let outcome: TackleOutcome = "miss";
  if (ballFirst && score >= CONFIG.tackle.cleanScore) outcome = "clean";
  else if (ballFirst && score >= CONFIG.tackle.spillScore) outcome = "spill";
  else if (heavyContact && !keeperCarrier && (mistimed || score < CONFIG.tackle.foulScore || blindside || late)) outcome = "foul";

  const reason = `q=${score.toFixed(2)} ${action} · ball ${ballDist.toFixed(2)}m/${reach.toFixed(2)}m`
    + ` · face ${facingDot.toFixed(2)} · front ${frontDot.toFixed(2)}`
    + ` · t ${elapsed.toFixed(2)}/${idealContact.toFixed(2)}${staleTarget ? " · stale" : ""}`
    + `${protectedCarrier ? " · protected" : ""}${mistimed ? " · mistimed contact" : ""}`;

  return {
    score, outcome, ballFirst, heavyContact, facingDot, frontDot, lateRatio,
    staleTarget, protectedCarrier, mistimed, ballDist, carrierDist, elapsed, idealContact, reason,
  };
}

/** Tiny local clamp avoids importing three.js into this pure rules module. */
function THREEClamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Knock the ball into neutral space: a spill is not a hidden pass to the challenger. */
export function spillDirection(e: MatchHost, p: EnginePlayer, carrier: EnginePlayer | null): { x: number; z: number } {
  const from = carrier?.pos ?? p.pos;
  const away = normalTo(from, e.ball.pos);
  const sideX = -away.z, sideZ = away.x;
  const side = (p.idx + (carrier?.idx ?? 0)) % 2 === 0 ? 1 : -1;
  const dx = away.x * 0.45 + sideX * side * 0.9;
  const dz = away.z * 0.45 + sideZ * side * 0.9;
  const len = Math.hypot(dx, dz);
  return len > 1e-5 ? { x: dx / len, z: dz / len } : forwardOf(p.facing);
}
