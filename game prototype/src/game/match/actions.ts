// Action dispatch: request the clip, stamp a deterministic action seed, record
// the pending kick intent that the contact frame later resolves.
import * as THREE from "three";
import { CONFIG } from "../config";
import { tieBreakHash } from "../random";
import { beginTackle, carrierIsProtected, isTackleAction, keeperHasBallInHands } from "./tackles";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/**
 * A stable, collision-resistant-enough action id for replay logs.
 *
 * It is derived from immutable match/player/action/time facts. Drawing it from
 * the shared match PRNG made human actions, cancelled passes, retries and AI
 * decisions shift every later random draw. An explicitly supplied seed (used by
 * restart attempts) is still honoured.
 */
export function deterministicActionSeed(e: MatchHost, p: EnginePlayer, action: string): number {
  const frame = Math.round(e.clock * 10000);
  const key = `${action}:${frame}:${p.runSerial}:${e.lastActionSeed ?? 0}:${e.ball.possessedBy ?? -1}`;
  return Math.floor(tieBreakHash(e.matchSeed, p.idx, frame, key) * 0x100000000) >>> 0;
}

/** Request an action clip and record the kick intent its contact frame will resolve. */
export function startAction(
  e: MatchHost,
  p: EnginePlayer,
  action: string,
  target?: THREE.Vector3,
  passTo?: number,
  actionSeed?: number,
  power?: number,
): boolean {
  // A challenge against a recently-won ball is rejected before the wind-up:
  // otherwise B can start a tackle during A's protection and simply wait for
  // the shield to expire before the contact frame.
  // A challenge is refused before the wind-up when the ball is not there to be won:
  // a protected carrier, and a keeper holding the ball in his hands (a keeper may not
  // be charged while he has the ball, and the ball is at 1.2 m, not at his feet).
  if (isTackleAction(action) && (p.tackleRecoveryT > 0 || carrierIsProtected(e) || keeperHasBallInHands(e))) return false;
  if (!p.anim.requestAction(action)) return false;

  if (isTackleAction(action)) beginTackle(e, p, action);
  const seed = actionSeed ?? deterministicActionSeed(e, p, action);
  p.pendingKick = target ? { action, target: target.clone(), passTo, power } : null;
  e.lastActionSeed = seed;
  e.actionLog.push({ seed, t: e.clock, player: p.idx, action, target: target ? [target.x, target.y, target.z] : undefined });
  if (e.actionLog.length > 80) e.actionLog.shift();
  return true;
}

/** Real kick speed (m/s) for an AI-chosen action, scaled by the player's style. */
export function powerForAction(p: EnginePlayer, action: string): number | undefined {
  const kp = CONFIG.player.kickPower;
  switch (action) {
    // Style shifts power by at most ±~8%: a 25 m/s base stays within real 22–27 m/s shots
    // (style.shooting spans ~0.72–1.5; the old 0.85+0.3·s multiplier reached ~30 m/s).
    case "shoot_normal": return kp.shoot * (0.94 + 0.1 * THREE.MathUtils.clamp(p.style.shooting - 1, -0.4, 0.5));
    case "shoot_finesse": return kp.finesse * (0.95 + 0.08 * THREE.MathUtils.clamp(p.style.shooting - 1, -0.4, 0.5));
    case "shoot_volley": return kp.volley * (0.94 + 0.1 * THREE.MathUtils.clamp(p.style.shooting - 1, -0.4, 0.5));
    case "pass_long": return kp.longPass * (0.9 + 0.2 * p.style.directness);
    case "pass_through": return kp.through * (0.85 + 0.3 * p.style.directness);
    case "pass_short": return kp.pass * (0.9 + 0.25 * p.style.directness);
    default: return undefined;
  }
}
