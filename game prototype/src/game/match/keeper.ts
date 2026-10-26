// Goalkeeper distribution clock: a keeper may not sit on the ball. When the
// hold limit runs out the engine releases it for him — a long ball away — with no
// reference to the AI's distribution preference and no RNG draw.
import * as THREE from "three";
import { CONFIG } from "../config";
import { kickRangeForPower } from "../ball";
import { ACTION_PROFILES, resolveStrike } from "../physics/actionProfiles";
import { SeededRandom, streamSeed } from "../random";
import { startAction } from "./actions";
import { aiEvent } from "./debug";
import { isOffPitch } from "./referee";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/** How long after the limit the engine stops waiting for a delivery plan. */
const FORCED_RELEASE_GRACE = 1.0;

/** Long clearance the keeper strikes himself, bypassing the pass planner. */
function directClearance(e: MatchHost, gk: EnginePlayer, target: THREE.Vector3, loft: number, power: number) {
  const dir = target.clone().sub(e.ball.pos).setY(0);
  if (dir.lengthSq() < 1e-4) dir.set(e.ai.attackSign(gk.team, e.rules.half), 0, 0);
  dir.normalize();
  // The keeper visibly strikes it: the clip plays, but its contact frame finds no
  // pending kick and therefore cannot touch the ball a second time.
  gk.anim.requestAction("gk_punt");
  e.ball.release();
  e.ball.lastTouch = gk.idx;
  e.ball.lastTouchTeam = gk.team;
  // The forced clearance is still a named action profile — the keeper's punt —
  // resolved with a deterministic stream so the hold-limit release is repeatable.
  const strike = resolveStrike(ACTION_PROFILES.gk_punt, {
    distance: Math.max(20, target.distanceTo(e.ball.pos)),
    startHeight: e.ball.pos.y,
    rng: new SeededRandom(streamSeed(e.matchSeed, `gk-forced:${gk.idx}:${e.clock.toFixed(2)}`)),
    accuracy: gk.attributes.goalkeeping.kicking,
    directSpeed: true,
    intensity: 0.85,
    surface: e.ball.surface,
  });
  e.ball.strike(dir, { ...strike, speed: power, loft });
  e.openPlayKickCount++;
}

/**
 * Force a long clearance from a keeper who has held the ball for
 * `CONFIG.ai.gkHoldLimit` seconds.
 *
 * Returns true when the ball was released. The delivery targets the most
 * advanced teammate that the keeper can actually reach, and the aim point is
 * clamped inside the field of play — the AI never aims a ball out of bounds.
 * If the delivery cannot be planned (nobody in range, custom roster, everyone
 * off the pitch) the keeper still kicks it away, so the time limit is a hard
 * rule rather than an intention.
 */
export function forceKeeperRelease(e: MatchHost, gk: EnginePlayer): boolean {
  if (e.ball.possessedBy !== gk.idx) return false;
  const limit = CONFIG.ai.gkHoldLimit;
  const sign = e.ai.attackSign(gk.team, e.rules.half);
  const halfL = CONFIG.pitch.length / 2 - CONFIG.ai.outPlaySafetyMargin;
  const halfW = CONFIG.pitch.width / 2 - CONFIG.ai.outPlaySafetyMargin;
  const onTheGround = e.ball.handsRestrictedTeam === gk.team;
  const action = onTheGround ? "pass_long" : "gk_punt";
  const puntPower = CONFIG.player.kickPower.punt * (0.5 + gk.attributes.goalkeeping.kicking / 150);
  const puntLoft = 0.42;
  const puntReach = kickRangeForPower(CONFIG.player.kickPower.punt, puntLoft);
  const mates = e.players
    .filter((p) => p.team === gk.team && p.idx !== gk.idx && p.role !== "GK" && !isOffPitch(e, p))
    .map((p) => ({ player: p, forward: (p.pos.x - gk.pos.x) * sign, dist: p.pos.distanceTo(e.ball.pos) }))
    // Reachable options only: a target further than the punt can carry would be
    // cancelled at the contact frame and the keeper would keep the ball.
    .filter((o) => o.dist < puntReach * 0.8)
    .sort((a, b) => b.forward - a.forward || a.player.idx - b.player.idx);
  const target = mates.length
    ? mates[0].player.pos.clone()
    : new THREE.Vector3(gk.pos.x + sign * Math.min(25, puntReach * 0.7), 0, 0);
  // Pre-clamp the aim point: a clearance is never aimed out of the field of play.
  target.x = THREE.MathUtils.clamp(target.x, -halfL, halfL);
  target.z = THREE.MathUtils.clamp(target.z, -halfW, halfW);
  target.y = 0;

  // The law has no patience: once the limit is a full second overdue the ball is
  // struck directly, plan or no plan.
  const overdue = gk.holdT >= limit + FORCED_RELEASE_GRACE;
  if (!overdue) {
    // A wind-up already running is allowed to finish; a cancelled one retries.
    if (gk.anim.busy) return false;
    if (!startAction(e, gk, action, target, mates[0]?.player.idx, undefined, puntPower)) return false;
    // Struck at its own target at the contact frame: a receiver plan (offside,
    // lane, range) must never be able to cancel a clearance the law requires.
    if (gk.pendingKick) gk.pendingKick.forced = true;
    // `holdT` is deliberately NOT reset here. It is cleared when the ball has
    // actually left (the keeper is no longer the owner), so a delivery that is
    // cancelled at its contact frame retries and then falls through to the kick.
    gk.decisionReason = `GK ${limit}s limit · long ball away`;
    e.rules.emit("POSSESSION", `${gk.team === 0 ? "RED" : "BLUE"} GK forced clear (${limit}s limit)`, gk.team);
    aiEvent(e, `GK HOLD LIMIT ${limit}s · ${action} → ${mates[0] ? `#${mates[0].player.idx}` : "space"}`);
    return true;
  }
  directClearance(e, gk, target, puntLoft, puntPower);
  gk.decisionReason = `GK ${limit}s limit · ball kicked away`;
  e.rules.emit("POSSESSION", `${gk.team === 0 ? "RED" : "BLUE"} GK forced clear (${limit}s limit)`, gk.team);
  aiEvent(e, `GK HOLD LIMIT ${limit}s · direct release`);
  return true;
}
