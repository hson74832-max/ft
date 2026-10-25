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

/** Real kick speed (m/s) for an AI-chosen action, scaled by the player's attributes. */
export function powerForAction(p: EnginePlayer, action: string): number | undefined {
  const kp = CONFIG.player.kickPower;
  const gkKicking = 0.5 + p.attributes.goalkeeping.kicking / 150;
  switch (action) {
    case "shoot_normal": case "shoot_finesse": return (action === "shoot_normal" ? kp.shoot : kp.finesse) * (0.5 + p.attributes.shooting.shotPower / 150);
    case "shoot_volley": return kp.volley * (0.5 + p.attributes.shooting.volleys / 150);
    case "pass_long": return kp.longPass * (p.role === "GK" ? gkKicking : 0.5 + p.attributes.passing.longGroundPassing / 150);
    case "pass_through": case "pass_short": return (action === "pass_through" ? kp.through : kp.pass)
      * (p.role === "GK" ? gkKicking : 0.5 + p.attributes.passing.shortGroundPassing / 150);
    case "gk_punt": return kp.punt * gkKicking;
    case "gk_roll": return kp.gkRoll * gkKicking;
    default: return undefined;
  }
}
