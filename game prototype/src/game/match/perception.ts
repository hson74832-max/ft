// Vision, memory and scanning.
//
// A player is not a camera on a crane: he sees a cone in front of his body, he
// turns his head to scan the rest of the pitch, and what he saw is remembered for
// a few seconds only. Everything the AI decides (which teammate it can play in,
// which opponent it can challenge, where the ball is) is validated against this
// perceived world instead of the engine's ground truth.
import * as THREE from "three";
import { CONFIG } from "../config";
import { tieBreakHash } from "../random";
import { yawDelta, yawOf } from "../angles";
import type { MatchHost } from "./host";

/** One remembered entity: the state it was last seen in, and when. */
export interface MemoryEntity {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  t: number;
}

/** A player's private picture of the world. */
export interface Perception {
  /** idx → last seen state of that player (teammates and opponents alike). */
  entities: Map<number, MemoryEntity>;
  /** Last seen ball state, or null once it has been forgotten. */
  ball: MemoryEntity | null;
  /** Seconds until the next scan is due. */
  scanT: number;
  /** Clock time the current scan sweep ends (0 = not scanning). */
  scanUntil: number;
  /** -1 / +1: which shoulder the current sweep starts over. */
  scanSide: number;
}

/** Anything that has a body orientation and a memory bank (engine or AI view). */
export interface Perceiver {
  pos: THREE.Vector3;
  facing: number;
  perception?: Perception;
}

/** A fresh, empty memory bank with a staggered scan schedule for this player. */
export function createPerception(matchSeed: number, idx: number): Perception {
  return {
    entities: new Map(),
    ball: null,
    scanT: CONFIG.ai.scanInterval * (0.2 + tieBreakHash(matchSeed, idx, 0, "scan-phase") * 0.8),
    scanUntil: 0,
    scanSide: tieBreakHash(matchSeed, idx, 0, "scan-side") < 0.5 ? -1 : 1,
  };
}

/**
 * A dead ball: nobody is running, everybody is looking at the ball, so the whole
 * layout is in view for once. Every player's memory starts the restart holding the
 * current positions instead of being blind until his first scan.
 */
export function seedPerception(e: MatchHost) {
  for (const p of e.players) {
    const per = p.perception;
    per.entities.clear();
    per.ball = { pos: e.ball.pos.clone(), vel: e.ball.vel.clone(), t: e.clock };
    for (const q of e.players) {
      if (q.idx === p.idx) continue;
      per.entities.set(q.idx, { pos: q.pos.clone(), vel: q.vel.clone(), t: e.clock });
    }
  }
}

/** Forget everything a manual reset or a restart re-stage invalidated. */
export function clearPerception(p: { perception: Perception }) {
  p.perception.entities.clear();
  p.perception.ball = null;
}

/** Half-angle of the field of view: wider while the head is turning. */
export function halfAngleAt(per: Perception, now: number): number {
  return now < per.scanUntil ? CONFIG.ai.scanHalfAngle : CONFIG.ai.visionHalfAngle;
}

/** Is `target` inside the cone (or close enough to be felt without looking)? */
export function inSight(
  from: THREE.Vector3, facing: number, target: THREE.Vector3, halfAngle: number, range: number,
): boolean {
  const dx = target.x - from.x, dz = target.z - from.z;
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq <= CONFIG.ai.awareRadius * CONFIG.ai.awareRadius) return true;
  if (distanceSq > range * range) return false;
  return Math.abs(yawDelta(facing, yawOf(dx, dz))) <= halfAngle;
}

/** Does this player see the point right now? (Always true without a memory bank.) */
export function seesNow(p: Perceiver, target: THREE.Vector3, now: number): boolean {
  const per = p.perception;
  if (!per) return true;
  return inSight(p.pos, p.facing, target, halfAngleAt(per, now), CONFIG.ai.visionRange);
}

/** Last seen state of an entity, or null if it was never seen or has decayed. */
export function remembered(p: Perceiver, idx: number, now: number): MemoryEntity | null {
  const per = p.perception;
  if (!per) return null;
  const memory = per.entities.get(idx);
  if (!memory || now - memory.t > CONFIG.ai.memorySeconds) return null;
  return memory;
}

/**
 * Where the player believes an entity is: the live position if he can see it,
 * otherwise the remembered one led by the velocity he last observed. Null when he
 * has no idea — the AI must then act as if the entity is not there.
 */
export function believedPos(
  p: Perceiver, idx: number, livePos: THREE.Vector3, liveVel: THREE.Vector3 | undefined, now: number,
): THREE.Vector3 | null {
  if (!p.perception) return livePos.clone();
  if (seesNow(p, livePos, now)) return livePos.clone();
  const memory = remembered(p, idx, now);
  if (!memory) return null;
  const age = Math.min(now - memory.t, 0.45);
  const point = memory.pos.clone();
  if (liveVel) point.addScaledVector(memory.vel, age * 0.5);
  return point;
}

/**
 * Refresh every player's memory bank and advance the scan schedule.
 *
 * Runs after movement, so it records the body orientations the frame ended with —
 * what a player could see with the head he has just turned.
 */
export function updatePerception(e: MatchHost, dt: number) {
  const now = e.clock;
  for (const p of e.players) {
    const per = p.perception;
    // Scan schedule. A player sweeps the pitch when the current sweep is over;
    // the interval is jittered per player so the side does not blink in unison.
    if (now >= per.scanUntil) {
      per.scanT -= dt;
      if (per.scanT <= 0) {
        per.scanUntil = now + CONFIG.ai.scanDuration;
        per.scanSide = -per.scanSide;
        // Scanning: a player who checks his surroundings often has a shorter gap
        // between sweeps (and a fresher picture of where everyone is).
        const scanning = p.attributes?.intelligence.scanning ?? 75;
        per.scanT = CONFIG.ai.scanInterval * (1.35 - scanning / 150)
          * (0.75 + tieBreakHash(e.matchSeed, p.idx, p.runSerial, "scan") * 0.5);
      }
    }
    // Decay first: anything not seen for `memorySeconds` is forgotten.
    for (const [idx, memory] of per.entities) {
      if (now - memory.t > CONFIG.ai.memorySeconds) per.entities.delete(idx);
    }
    if (per.ball && now - per.ball.t > CONFIG.ai.memorySeconds) per.ball = null;
    // A player with no information at all (start of a phase, or a memory that has
    // completely decayed) has nothing to protect: he looks around and takes the
    // whole layout in rather than standing blind until the cone crosses someone.
    const blind = per.entities.size === 0 && per.ball === null;
    const halfAngle = halfAngleAt(per, now);
    const sees = (target: THREE.Vector3) => blind
      || inSight(p.pos, p.facing, target, halfAngle, CONFIG.ai.visionRange);
    // A player always knows where the ball is while it is in front of him or at
    // his feet; otherwise he is relying on the last sighting.
    if (sees(e.ball.pos)) {
      per.ball = { pos: e.ball.pos.clone(), vel: e.ball.vel.clone(), t: now };
    }
    for (const q of e.players) {
      if (q.idx === p.idx) continue;
      if (sees(q.pos)) {
        per.entities.set(q.idx, { pos: q.pos.clone(), vel: q.vel.clone(), t: now });
      }
    }
  }
}

/** Head-turn (radians) the scan sweep is asking for right now, 0 when idle. */
export function scanHeadYaw(per: Perception, now: number): number {
  const left = per.scanUntil - now;
  if (left <= 0) return 0;
  const progress = THREE.MathUtils.clamp(1 - left / CONFIG.ai.scanDuration, 0, 1);
  return per.scanSide * CONFIG.ai.scanHeadYaw * Math.sin(Math.PI * progress);
}
