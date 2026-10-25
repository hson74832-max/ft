// Pass planning: lane clearance, kick profile, power for a target arrival time,
// the named-receiver plan and its bookkeeping, plus keeper distribution.
import * as THREE from "three";
import { CONFIG } from "../config";
import { estimateKickTravelTime, kickRangeForPower, kickPowerForRange } from "../ball";
import { passAimDot, passAimIsValid, predictReceiverRun, resolveNamedReceiver } from "../passing";
import { tieBreakHash } from "../random";
import { receiverOffsideAtKick } from "./offside";
import type { EnginePlayer, GkDistribution, PassPlan } from "./types";
import type { MatchHost } from "./host";

/** Clearance of the straight lane from a to b: 1 = totally open, 0 = blocked. */
export function laneOpenness(a: THREE.Vector3, b: THREE.Vector3, opponents: EnginePlayer[]): number {
  const seg = b.clone().sub(a).setY(0);
  const len2 = Math.max(0.001, seg.lengthSq());
  let blocked = 0;
  for (const o of opponents) {
    const rel = o.pos.clone().sub(a).setY(0);
    const t = THREE.MathUtils.clamp(rel.dot(seg) / len2, 0.05, 0.95);
    const closest = a.clone().addScaledVector(seg, t);
    const gap = closest.distanceTo(o.pos);
    if (gap < 1.9) blocked += (1.9 - gap) / 1.9;
  }
  return THREE.MathUtils.clamp(1 - blocked * 0.4, 0, 1);
}

/** How a delivery is struck: loft, power envelope and the pace it should still carry on arrival. */
export function passProfile(action: string): { loft: number; maxPower: number; minPower: number; arrival: number } | null {
  const kp = CONFIG.player.kickPower;
  switch (action) {
    case "pass_short": return { loft: 0.025, maxPower: kp.pass, minPower: 0.6, arrival: 5.0 };
    // A driven long ball has to stay low: at loft 0.06 the ball leaves the ground just
    // enough to bounce, and each bounce takes 35% of the horizontal speed (restitution),
    // so a 24 m/s long pass carried 22.2 m — less than an 11 m/s short pass (27.8 m) and
    // short of the 27 m the AI is willing to aim at. Loft 0.20 calibrates 4–28 m and
    // carries 31 m flat out, so long balls and crosses actually reach their target.
    case "pass_long": return { loft: 0.20, maxPower: kp.longPass, minPower: 1.5, arrival: 6.5 };
    case "pass_through": return { loft: 0.035, maxPower: kp.through, minPower: 1.0, arrival: 4.0 };
    // Throw-ins and corners are lofted deliveries, not driven balls: high loft gives a
    // real arc into the danger area (a flat loft made corners look short/driven).
    case "throw_in": return { loft: 0.45, maxPower: kp.throwIn, minPower: 4, arrival: 0 };
    case "corner_kick": return { loft: 0.85, maxPower: kp.corner, minPower: 5, arrival: 0 };
    case "gk_roll": return { loft: 0.01, maxPower: kp.gkRoll, minPower: 1.5, arrival: 3.5 };
    case "gk_punt": return { loft: 0.42, maxPower: kp.punt, minPower: 8, arrival: 0 };
    default: return null;
  }

}

/** Physics-calibrated power so the ball still carries `arrival` m/s at `distance`. */
export function powerForArrival(distance: number, profile: { loft: number; maxPower: number; minPower: number; arrival: number }, startHeight: number): number {
  // Extra free-roll distance needed to shed `arrival` m/s under rolling resistance.
  const extraRoll = profile.arrival > 0 ? (profile.arrival * profile.arrival) / (2 * CONFIG.ball.rollingDecel) : 0;
  return kickPowerForRange(distance + extraRoll, profile.loft, profile.maxPower, profile.minPower, startHeight);

}

/** Plan a pass to a named receiver: aim point, power and arrival time. */
export function planNamedPass(e: MatchHost, passer: EnginePlayer, action: string, passTo: number | undefined, requestedPower?: number, restartKind?: string): PassPlan | null {
  const receiver = resolveNamedReceiver(e.players, passer, passTo, action.startsWith("pass_"));
  const profile = passProfile(action);
  if (!receiver || !profile || receiverOffsideAtKick(e, passer, receiver, restartKind)) return null;

  const origin = e.ball.pos.clone();
  const assignment = !restartKind && e.frameWorld
    ? e.ai.tactics.plan(e.frameWorld, passer.team)?.assignments.get(receiver.idx) : undefined;
  // For a restart the delivery was already aimed at a sampled target (throw-in
  // downfield, corner zone, …). Aim at that sampled point rather than only at
  // the receiver's current position — otherwise a throw-in is lofted at a
  // receiver standing on the touchline instead of into the field of play.
  const sampledTarget = restartKind ? passer.pendingKick?.target : undefined;
  const destination = restartKind ? (sampledTarget?.clone() ?? receiver.pos.clone())
    : action === "pass_through" && assignment?.job === "runner" && assignment.runTarget ? assignment.runTarget.clone()
      : assignment?.target.clone() ?? receiver.moveTarget.clone();
  const startHeight = Math.max(CONFIG.ball.radius, origin.y);
  let receiverTarget = receiver.pos.clone();
  let distance = Math.hypot(receiverTarget.x - origin.x, receiverTarget.z - origin.z);
  if (distance < 1.15) return null;

  const maximumReach = kickRangeForPower(profile.maxPower, profile.loft, startHeight);
  if (distance > maximumReach - 0.35) return null;
  let power = powerForArrival(distance, profile, startHeight);
  if (requestedPower !== undefined) {
    // Charge changes pace a little but never overpowers the receiver's measured range.
    power = THREE.MathUtils.clamp(requestedPower, power * 0.82, Math.min(profile.maxPower, power * 1.08));
  }

  let arrivalTime = 0;
  for (let i = 0; i < 5; i++) {
    const travelTime = estimateKickTravelTime(distance, power, profile.loft, startHeight);
    arrivalTime = travelTime;
    const receiverCap = receiver.role === "GK" ? CONFIG.player.runSpeed
      : action === "pass_through" ? CONFIG.ai.maxSprint : assignment?.desiredSpeed ?? CONFIG.player.runSpeed;
    receiverTarget = predictReceiverRun(receiver.pos, receiver.vel, destination, travelTime, receiverCap);
    distance = Math.hypot(receiverTarget.x - origin.x, receiverTarget.z - origin.z);
    if (distance > maximumReach - 0.35) return null;
    const rangePower = powerForArrival(distance, profile, startHeight);
    power = requestedPower === undefined
      ? rangePower
      : THREE.MathUtils.clamp(requestedPower, rangePower * 0.82, Math.min(profile.maxPower, rangePower * 1.08));
  }

  const aim = receiverTarget.clone().sub(origin).setY(0).normalize();
  const plannedVelocity = new THREE.Vector3(aim.x * power, power * profile.loft, aim.z * power);
  const aimDot = passAimDot(origin, plannedVelocity, receiverTarget);
  if (!passAimIsValid(aimDot, CONFIG.ai.passAimConeDegrees)) return null;
  return { receiver, target: receiverTarget, power, loft: profile.loft, aimDot, distance, arrivalTime };
}

/** Book-keeping for a released pass: flight, stats and the pass log. */
export function recordPass(e: MatchHost, passer: EnginePlayer, action: string, plan: PassPlan) {
  const gain = (plan.target.x - passer.pos.x) * e.ai.attackSign(passer.team, e.rules.half);
  const purpose = e.ai.lastDecision.get(passer.idx)?.passPurpose
    ?? (gain < -1.5 ? "recycle" : action === "pass_through" ? "penetrate" : "progress");
  e.passFlight = { team: passer.team, passer: passer.idx, receiver: plan.receiver.idx, target: plan.target.clone(),
    launchedAt: e.clock, arrivesAt: e.clock + plan.arrivalTime, expiresAt: e.clock + plan.arrivalTime + 1.2 };
  e.lastPass = { passer: passer.idx, receiver: plan.receiver.idx, team: passer.team, t: e.clock };
  e.tacticalStats.passes++;
  if (purpose === "recycle") e.tacticalStats.recycles++;
  if (plan.receiver.role === "GK") e.tacticalStats.keeperRecycles++;
  if (purpose === "penetrate") e.tacticalStats.penetratingPasses++;
  e.ball.handsRestrictedTeam = action.startsWith("pass_") || action === "corner_kick" ? passer.team : null;
  e.passLog.unshift({
    t: e.clock, passer: passer.idx, receiver: plan.receiver.idx, action,
    speed: plan.power, aimDot: plan.aimDot, distance: plan.distance,
    predicted: [plan.target.x, plan.target.y, plan.target.z],
    purpose, arrivalTime: plan.arrivalTime,
  });
  if (e.passLog.length > 24) e.passLog.pop();
}

/**
 * Goalkeeper distribution: evaluate every outfield teammate as a short or long option
 * using receiver space, lane clearance and pressure on the keeper — not a distance
 * threshold. Returns the chosen action, named receiver, predicted aim point and reason.
 */
export function evaluateGkDistribution(e: MatchHost, gk: EnginePlayer): GkDistribution | null {
  const mates = e.players.filter((p) => p.team === gk.team && p.idx !== gk.idx && p.role !== "GK");
  if (!mates.length) return null;
  const opponents = e.players.filter((p) => p.team !== gk.team);
  // `Math.min(...[])` is Infinity; treat a one-team/custom roster as unpressured.
  const pressure = opponents.length
    ? Math.min(...opponents.map((o) => o.pos.distanceTo(gk.pos)))
    : 20;
  const origin = e.ball.pos.clone();
  const sign = e.ai.attackSign(gk.team, e.rules.half);
  const options = mates.map((m) => {
    const target = m.pos.clone().addScaledVector(m.vel, 0.4);
    target.x = THREE.MathUtils.clamp(target.x, -18.8, 18.8);
    target.z = THREE.MathUtils.clamp(target.z, -11.2, 11.2);
    const dist = Math.hypot(target.x - origin.x, target.z - origin.z);
    const space = Math.min(...opponents.map((o) => o.pos.distanceTo(target)), 20);
    const lane = laneOpenness(origin, target, opponents);
    const forward = (target.x - gk.pos.x) * sign;
    const short = dist <= 22;
    // Short options value safety and a clean lane; long options value the receiver's
    // isolation from defenders and territory.
    let score = short
      ? lane * 0.42 + THREE.MathUtils.clamp(space / 7, 0, 1) * 0.34 + 0.1
      : THREE.MathUtils.clamp(space / 9, 0, 1) * 0.42 + lane * 0.2 + THREE.MathUtils.clamp(forward / 30, 0, 1) * 0.2;
    if (pressure < 3.2) score += short ? -0.22 : 0.18;
    if (short && lane < 0.4) score -= 0.35;
    score += tieBreakHash(e.matchSeed, gk.idx, gk.runSerial, `gkdist:${m.idx}:${short}`) * 0.04;
    return { m, target, dist, space, lane, short, score };
  }).sort((a, b) => b.score - a.score);
  const shortOpts = options.filter((o) => o.short);
  const longOpts = options.filter((o) => !o.short);
  const bestShort = shortOpts[0];
  // If the clear short option is genuinely better than the best long option, play out;
  // otherwise go long to the free receiver. Pressured keepers still look long first.
  const useShort = !!bestShort && (pressure < 4.2 || (bestShort.lane > 0.5 && bestShort.space > 3.2))
    && bestShort.score >= (longOpts[0]?.score ?? -1) - 0.05;
  const chosen = (useShort ? bestShort : undefined) ?? longOpts[0] ?? bestShort;
  if (!chosen) return null;
  return {
    action: e.ball.handsRestrictedTeam === gk.team
      ? chosen.short ? "pass_short" : "pass_long"
      : chosen.short ? "gk_roll" : "gk_punt",
    receiver: chosen.m,
    target: chosen.target,
    short: chosen.short,
    reason: `GK ${e.ball.handsRestrictedTeam === gk.team ? "FEET " : ""}${chosen.short ? "SHORT" : "LONG"} → #${chosen.m.idx} ${chosen.m.role} · ${chosen.dist.toFixed(0)}m · lane ${chosen.lane.toFixed(2)} · space ${chosen.space.toFixed(1)}m · press ${pressure.toFixed(1)}m`,
  };

}
