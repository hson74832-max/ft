// Action dispatch: request the clip, stamp the seeded action seed, record the
// pending kick intent that the contact frame later resolves.
import * as THREE from "three";
import { CONFIG } from "../config";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/** Request an action clip and record the kick intent its contact frame will resolve. */
export function startAction(e: MatchHost, p: EnginePlayer, action: string, target?: THREE.Vector3, passTo?: number, actionSeed?: number, power?: number): boolean {
  if (!p.anim.requestAction(action)) return false;
  const seed = actionSeed ?? e.rng.nextUint();
  p.lastActionSeed = seed;
  p.pendingKick = target ? { action, target: target.clone(), passTo, actionSeed: seed, power } : null;
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
