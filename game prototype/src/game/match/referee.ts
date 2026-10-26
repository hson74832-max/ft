// Referee: card grading and issuance, the blue-card exclusion, and the advantage
// law. All of it is deterministic — no RNG, no wall clock; the match clock is the
// only time source, so a fixed-seed replay books the same cards at the same frames.
import * as THREE from "three";
import { CONFIG } from "../config";
import { aiEvent } from "./debug";
import type { EnginePlayer } from "./types";
import type { TackleQuality } from "./tackles";
import type { MatchHost } from "./host";

/**
 * A player serving a blue card is off the pitch: idle, unable to enter play.
 * It is a timestamp, not a timer, so it survives restarts, substitutions of
 * state and the frozen clock of a restart setup.
 */
export function isOffPitch(e: MatchHost, p: EnginePlayer): boolean {
  return p.blueCardUntil > e.clock;
}

/** Seconds a blue-carded player still has to serve (0 when he may play). */
export function blueCardRemaining(e: MatchHost, p: EnginePlayer): number {
  return Math.max(0, p.blueCardUntil - e.clock);
}

/** Where a sent-off player waits: outside the touchline on his own goal side. */
export function benchSpot(e: MatchHost, p: EnginePlayer, out = new THREE.Vector3()): THREE.Vector3 {
  const ownGoal = e.ai.ownGoal(p.team, e.rules.half);
  const side = Math.sign(p.pos.z) || (p.team === 0 ? 1 : -1);
  return out.set(
    THREE.MathUtils.clamp(ownGoal.x + 1.2, -CONFIG.pitch.length / 2 + 1, CONFIG.pitch.length / 2 - 1),
    0,
    side * (CONFIG.pitch.width / 2 + 1.0),
  );
}

/** Park every blue-carded player on the bench (after a restart re-stage teleport). */
export function sendOffPitchPlayersToBench(e: MatchHost) {
  const spot = new THREE.Vector3();
  for (const p of e.players) {
    if (!isOffPitch(e, p)) continue;
    benchSpot(e, p, spot);
    p.pos.copy(spot);
    p.moveTarget.copy(spot);
    p.vel.set(0, 0, 0);
    p.desiredSpeed = 0;
    p.restartTaker = false;
    p.pendingKick = null;
  }
}

/**
 * Foul grading.
 *
 * `reckless` is the yellow-card band: the challenge was late or from the blind
 * side — so it was never a fair attempt — but the challenger was still inside a
 * competitive distance of the ball (he could have played it and chose not to).
 * A challenge that never got near the ball at all is simply a foul, and one that
 * came from a normal angle and on time is play on.
 */
export function classifyFoul(quality: TackleQuality): "reckless" | "careless" {
  // `blindsideCommitted`, not `blindside`: the card is for the challenge the player
  // chose to make. A fair challenge that a turning carrier spins into is careless
  // contact, and the game's carriers turn constantly, so grading on the contact
  // geometry alone booked almost every foul in the match.
  const reckless = (quality.late || quality.blindsideCommitted) && quality.competitive;
  return reckless ? "reckless" : "careless";
}

/** Book the challenger. Two yellows become a blue card and a 60 s exclusion. */
export function issueCards(e: MatchHost, offender: EnginePlayer, quality: TackleQuality): "yellow" | "blue" | null {
  offender.foulsConceded = (offender.foulsConceded ?? 0) + 1;
  const grade = classifyFoul(quality);
  if (grade !== "reckless") return null;
  offender.yellowCards = (offender.yellowCards ?? 0) + 1;
  const team = offender.team === 0 ? "RED" : "BLUE";
  e.rules.emit("YELLOW_CARD", `Yellow card — ${team} #${offender.idx} ${offender.role} · reckless (${quality.late ? "late" : "blind side"})`, offender.team);
  aiEvent(e, `CARD yellow #${offender.idx} · ${grade} · ${quality.reason}`);
  if (offender.yellowCards % CONFIG.referee.yellowCardsPerBlue !== 0) return "yellow";
  // Second yellow: blue card, off the pitch and idle for the exclusion period.
  offender.blueCardUntil = e.clock + CONFIG.referee.blueCardSeconds;
  // He cannot take the ball with him: a carded carrier leaves it where it was.
  if (e.ball.possessedBy === offender.idx) e.ball.release();
  offender.pendingKick = null;
  offender.restartTaker = false;
  offender.moveTarget.copy(offender.pos);
  offender.desiredSpeed = 0;
  e.rules.emit("BLUE_CARD", `Blue card — ${team} #${offender.idx} ${offender.role} off for ${CONFIG.referee.blueCardSeconds}s (2 yellows)`, offender.team);
  aiEvent(e, `CARD blue #${offender.idx} · ${CONFIG.referee.blueCardSeconds}s exclusion`);
  if (offender.idx === e.humanIdx) e.switchToNearest(false);
  return "blue";
}

/** Bring expired blue cards back into play, just inside the touchline. */
export function updateBlueCards(e: MatchHost) {
  for (const p of e.players) {
    if (p.blueCardUntil <= 0 || p.blueCardUntil > e.clock) continue;
    p.blueCardUntil = 0;
    // Re-enter from the bench, on the pitch and on his own side of it.
    p.pos.x = THREE.MathUtils.clamp(p.pos.x, -CONFIG.pitch.length / 2 + 0.8, CONFIG.pitch.length / 2 - 0.8);
    p.pos.z = THREE.MathUtils.clamp(p.pos.z, -CONFIG.pitch.width / 2 + 0.8, CONFIG.pitch.width / 2 - 0.8);
    p.moveTarget.copy(p.pos);
    p.vel.set(0, 0, 0);
    p.decisionReason = "Blue card served · back on the pitch";
    e.rules.emit("WHISTLE", `${p.team === 0 ? "RED" : "BLUE"} #${p.idx} ${p.role} returns from the blue card`, p.team);
    aiEvent(e, `CARD served #${p.idx} · back on the pitch`);
  }
}

/** Nearest player of the opposing side to `pos`, ignoring blue-carded bodies. */
function nearestOpponentDistance(e: MatchHost, team: number, pos: THREE.Vector3): number {
  let best = Infinity;
  for (const q of e.players) {
    if (q.team === team || isOffPitch(e, q)) continue;
    best = Math.min(best, q.pos.distanceTo(pos));
  }
  return best;
}

/**
 * Advantage: the fouled side keeps the ball and can use it, so the whistle stays
 * down. Two cases, exactly as the law reads:
 *
 *  - the fouled player is still on the ball and either has real space around him
 *    or is running forward into a clear corridor, or
 *  - the ball broke loose and a teammate of the fouled player is on it.
 *
 * Anything else — the challenger still on top of the ball, no forward room — is
 * a normal foul: play stops and the free kick is awarded.
 */
export function advantageAvailable(e: MatchHost, victim: EnginePlayer): { playOn: boolean; reason: string } {
  const R = CONFIG.referee;
  const owner = e.ball.possessedBy !== null ? e.players[e.ball.possessedBy] : null;
  const side = owner && owner.team === victim.team ? owner : null;
  if (side && !isOffPitch(e, side)) {
    const clear = nearestOpponentDistance(e, side.team, side.pos);
    const attack = e.ai.attackSign(side.team, e.rules.half);
    const ahead = side.pos.clone();
    ahead.x += attack * R.advantageCorridorLength;
    ahead.x = THREE.MathUtils.clamp(ahead.x, -CONFIG.pitch.length / 2 + 0.8, CONFIG.pitch.length / 2 - 0.8);
    ahead.z = THREE.MathUtils.clamp(ahead.z, -CONFIG.pitch.width / 2 + 0.8, CONFIG.pitch.width / 2 - 0.8);
    const corridor = nearestOpponentDistance(e, side.team, ahead);
    if (clear >= R.advantageClearance) {
      return { playOn: true, reason: `${clear.toFixed(1)}m of space around the carrier` };
    }
    if (side.speed >= R.advantageMinSpeed && corridor >= R.advantageCorridor) {
      return { playOn: true, reason: `running forward into ${corridor.toFixed(1)}m of space` };
    }
    return { playOn: false, reason: side.idx === victim.idx ? "challenger still on the ball" : "no forward room" };
  }
  if (!owner) {
    // The ball broke loose: a teammate arriving on it keeps the move alive.
    for (const mate of e.players) {
      if (mate.team !== victim.team || mate.idx === victim.idx || isOffPitch(e, mate)) continue;
      if (mate.pos.distanceTo(e.ball.pos) > CONFIG.player.controlRadius + 0.6) continue;
      const clear = nearestOpponentDistance(e, mate.team, mate.pos);
      if (clear >= R.advantageClearance) return { playOn: true, reason: `teammate #${mate.idx} on the loose ball` };
      break;
    }
  }
  return { playOn: false, reason: "possession not retained" };
}
