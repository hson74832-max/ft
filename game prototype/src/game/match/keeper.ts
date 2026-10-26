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
 * Hands the keeper can put on a ball at this instant, measured from his body centre.
 *
 * The save clip is not a hitbox bolted to its contact frame. A dive adds reach
 * progressively — a keeper who committed 0.15 s ago has barely left the ground, one
 * 0.44 s in is at full extension — and a standing keeper keeps his arm span. That is
 * what makes the save depend on the time he had, which is the whole point of a save
 * model: a reaction delay and a dive that take longer than the flight cannot stop the
 * ball, however close it passes.
 */
export function keeperReachNow(gk: EnginePlayer, ballZ = gk.pos.z): number {
  const reachScale = 0.5 + gk.attributes.goalkeeping.reach / 150;
  const action = gk.anim.actionId;
  let extension = 0;
  if (action === "gk_dive_L" || action === "gk_dive_R") {
    const progress = THREE.MathUtils.clamp(gk.anim.actionT / Math.max(0.08, CONFIG.ai.gkDiveContactTime), 0, 1);
    // Hands only: the clip's root motion is what carries the body across goal.
    extension = CONFIG.ai.gkHandExtension * (0.5 + gk.attributes.goalkeeping.diving / 150) * progress;
  } else if (action === "gk_parry" || action === "gk_catch") {
    const contact = Math.max(0.08, (gk.anim.actionDur || 0.5) * 0.5);
    const progress = THREE.MathUtils.clamp(gk.anim.actionT / contact, 0, 1);
    extension = CONFIG.ai.gkReflexExtension * (0.5 + gk.attributes.goalkeeping.handling / 150) * progress;
  }
  // A keeper still travelling sideways is off balance and loses reach — unless the
  // save clip is a dive in that same direction, where momentum helps.
  const lateral = Math.abs(gk.vel.z);
  const diving = action === "gk_dive_L" || action === "gk_dive_R";
  const withDive = diving && Math.sign(gk.vel.z) === Math.sign(ballZ - gk.pos.z);
  const offBalance = withDive ? 0 : lateral * CONFIG.ai.gkOffBalancePenalty;
  return Math.max(0.4, CONFIG.ai.gkSetReach * reachScale + extension - offBalance);
}

/**
 * Resolve a shot against the keeper's reach volume, where the ball actually crosses it.
 *
 * Runs every frame before goal detection. The ball's swept segment is the truth: if it
 * comes within the reach the keeper has right now, at a catchable height and on a line
 * that would cross the goal mouth, the keeper gets a hand (or his body) to it. This is
 * the save the previous clip-contact model could never make: `gk_dive_*` reaches its
 * contact frame 0.44 s after the decision, while a full-power shot from 12–15 m takes
 * 0.30–0.40 s to arrive, so the ball had already crossed the line before the contact
 * frame ran. Every "save" in a five-match sample was really the ball hitting the
 * keeper's body cylinder.
 */
export function keeperSaveCheck(e: MatchHost): void {
  const b = e.ball;
  if (b.possessedBy !== null) return;
  if (!(b.speed > 3)) return;
  if (b.pos.y > CONFIG.ai.gkSaveHeight) return;
  // A ball that has just left this keeper's own hands must not be re-claimed: a
  // keeper cannot play the ball twice before another player has touched it (a
  // parried shot that bounces back into his gloves is a double touch, and the
  // clip-contact save path used to fire a second, phantom parry on the rebound).
  const ownTouch = b.kickedBy !== null && b.kickAge < 0.8 ? b.kickedBy : -1;
  const prev = b.prevPos, cur = b.pos;
  const segX = cur.x - prev.x, segZ = cur.z - prev.z;
  const segLenSq = segX * segX + segZ * segZ;
  for (const gk of e.players) {
    if (gk.role !== "GK" || isOffPitch(e, gk)) continue;
    // A deliberate back-pass is played with the feet (no hands); every other ball
    // — including a deflection off his own defender — can be saved.
    if (b.handsRestrictedTeam === gk.team) continue;
    if (gk.idx === ownTouch) continue;
    const own = e.ai.ownGoal(gk.team, e.rules.half);
    const depth = Math.abs(own.x - cur.x);
    if (depth > CONFIG.ai.gkSaveZoneDepth) continue;
    // The ball has to be travelling toward this goal.
    if ((own.x - cur.x) * b.vel.x <= 0) continue;
    // Closest approach of the frame's flight segment to the keeper (horizontal).
    let t = 0;
    if (segLenSq > 1e-6) {
      t = THREE.MathUtils.clamp(((gk.pos.x - prev.x) * segX + (gk.pos.z - prev.z) * segZ) / segLenSq, 0, 1);
    }
    const bx = prev.x + segX * t, bz = prev.z + segZ * t;
    const by = Math.max(CONFIG.ball.radius, prev.y + (cur.y - prev.y) * t);
    if (by > CONFIG.ai.gkSaveHeight) continue;
    const gap = Math.hypot(bx - gk.pos.x, bz - gk.pos.z);
    const reach = keeperReachNow(gk, b.pos.z) + CONFIG.ball.radius;
    if (gap > reach) continue;
    // Only an on-target (or near-post) ball is a save; a keeper does not get a hand to
    // a shot that is going wide unless it is within his frame.
    const timeToLine = (own.x - cur.x) / b.vel.x;
    if (timeToLine > 0 && timeToLine < 1.2) {
      const zAtLine = cur.z + b.vel.z * timeToLine;
      if (Math.abs(zAtLine) > CONFIG.pitch.goalWidth / 2 + CONFIG.ai.gkSaveWideMargin) continue;
    }
    const speed = b.speed;
    const handling = gk.attributes.goalkeeping.handling;
    const catching = gk.attributes.goalkeeping.catching;
    const catchSpeed = CONFIG.ai.gkCatchSpeed * (0.5 + (handling + catching) / 300);
    const reachScale = 0.5 + gk.attributes.goalkeeping.reach / 150;
    const catchReach = (CONFIG.ai.gkStandingReach + 0.15) * reachScale;
    // A diving keeper whose hands reach the ball but whose body is still travelling
    // parries rather than catches; only a slow ball into the body sticks.
    const central = gap < catchReach && speed < catchSpeed && b.pos.y < 1.9;
    if (central) {
      b.possess(gk.idx, gk.team);
      b.vel.set(0, 0, 0);
      e.offsideCandidates.clear(); e.offsideTeam = null;
      gk.holdT = 0;
      gk.stumbleT = 0;
      aiEvent(e, `GK CATCH #${gk.idx} · ${speed.toFixed(1)} m/s at ${gap.toFixed(2)}m`);
      e.rules.emit("SAVE", `GK CATCH by ${gk.team === 0 ? "RED" : "BLUE"}`, gk.team);
      return;
    }
    // Parry: push the ball away from goal, conserving some of the shot's pace.
    const away = cur.clone().sub(own).setY(0);
    if (away.lengthSq() < 1e-4) away.set(-(own.x - cur.x) || 1, 0, 0);
    away.normalize();
    const parrying = gk.attributes.goalkeeping.parrying;
    away.z += (cur.z >= gk.pos.z ? 1 : -1) * 0.7 * (0.5 + parrying / 150);
    b.release();
    b.lastTouch = gk.idx; b.lastTouchTeam = gk.team;
    const parry = new THREE.Vector3(away.x, 0, away.z).normalize();
    // The deflection keeps a share of the shot but is slowed and lifted: this is a
    // blocked shot, not a fresh pass across the face of goal.
    const outSpeed = THREE.MathUtils.clamp(speed * (0.42 - parrying / 600), 4, 12);
    b.vel.set(parry.x * outSpeed, 1.6, parry.z * outSpeed);
    b.spin.set(0, 0, 0);
    b.jitter = null;
    b.phase = "flight";
    b.bounces = 0;
    b.kickedBy = gk.idx;
    b.kickAge = 0;
    e.offsideCandidates.clear(); e.offsideTeam = null;
    aiEvent(e, `GK PARRY #${gk.idx} (${gk.anim.actionId ?? "set"}) · ${speed.toFixed(1)} m/s at ${gap.toFixed(2)}m`);
    e.rules.emit("SAVE", `GK ${gk.anim.actionId ?? "body"} — parried!`, gk.team);
    return;
  }
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
