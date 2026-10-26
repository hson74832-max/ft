// Pass planning: lane clearance, the named action profile for the delivery, the
// power that lands the ball on the target, the named-receiver plan and its
// bookkeeping, plus keeper distribution.
import * as THREE from "three";
import { CONFIG } from "../config";
import { estimateKickTravelTime, kickMaxRangeFor, kickPowerForRange } from "../ball";
import {
  chooseProfile, legacyProfileFor, profileStream, resolveStrike,
  type ActionProfile, type ResolvedStrike,
} from "../physics/actionProfiles";
import { passAimDot, passAimIsValid, predictReceiverRun, resolveNamedReceiver } from "../passing";
import { SeededRandom, tieBreakHash } from "../random";
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

/** Distance along the lane to the first opponent standing in it (Infinity = clear). */
export function laneBlockerDistance(a: THREE.Vector3, b: THREE.Vector3, opponents: EnginePlayer[], width = 2.4): number {
  const seg = b.clone().sub(a).setY(0);
  const len = Math.max(0.001, seg.length());
  const dir = seg.clone().divideScalar(len);
  let best = Infinity;
  for (const o of opponents) {
    const rel = o.pos.clone().sub(a).setY(0);
    const along = rel.dot(dir);
    if (along <= 0.15 || along >= len) continue;
    const lateral = Math.abs(rel.x * dir.z - rel.z * dir.x);
    if (lateral <= width) best = Math.min(best, along);
  }
  return best;
}

export interface ProfileEnvelope {
  loft: number;
  maxPower: number;
  minPower: number;
  arrival: number;
  profile: ActionProfile;
}

/** CONFIG kick-power envelope that belongs to a profile's family. */
function powerKeyFor(profile: ActionProfile): keyof typeof CONFIG.player.kickPower {
  switch (profile.family) {
    case "corner": return "corner";
    case "restart": return "throwIn";
    case "keeper": return profile.id === "gk_roll" ? "gkRoll" : "punt";
    case "shot": return "shoot";
    case "cross": return "longPass";
    case "header": return "header";
    case "clearance": return "clear";
    case "pass":
      if (profile.id === "pass_short" || profile.id === "pass_medium") return "pass";
      if (profile.id === "pass_through") return "through";
      return "longPass";
    default: return "pass";
  }
}

/**
 * The CONFIG power envelope is chosen by the *action the AI decided on*, not by the
 * profile that happens to carry it: a 15 m back-pass stays a long ball even when its
 * lane is open enough to pick the medium-pass profile. Choosing by profile alone
 * capped that return at the short-pass power (11 m/s), which cannot reach the keeper —
 * the plan was rejected and the pass silently cancelled.
 */
function powerKeyForAction(action: string, profile: ActionProfile): keyof typeof CONFIG.player.kickPower {
  switch (action) {
    case "pass_short": return "pass";
    case "pass_long": return "longPass";
    case "pass_through": return "through";
    case "throw_in": return "throwIn";
    case "corner_kick": return "corner";
    case "gk_roll": return "gkRoll";
    case "gk_punt": return "punt";
    case "header": return "header";
    default: return powerKeyFor(profile);
  }
}

/** A delivery envelope for one named profile: plan-time loft, power band, arrival pace. */
export function envelopeFor(profile: ActionProfile, action: string): ProfileEnvelope {
  const kp = CONFIG.player.kickPower;
  // Aim at the middle of the launch band: the sampled angle of a particular strike
  // may be higher or lower, but the plan's prediction must not swing with the dice.
  const midDeg = (profile.launchDeg[0] + profile.launchDeg[1]) / 2;
  const loft = Math.tan(midDeg * Math.PI / 180);
  const maxPower = Math.min(kp[powerKeyForAction(action, profile)], profile.speed[1], CONFIG.ball.maxSpeed);
  const minPower = Math.max(0.6, Math.min(profile.speed[0], maxPower) * 0.55);
  const arrival = action === "throw_in" || action === "corner_kick" || action === "gk_punt" ? 0 : 4.5;
  return { loft, maxPower, minPower, arrival, profile };
}

/**
 * How a delivery is struck: loft, power envelope and the pace it should still carry
 * on arrival. The numbers come from the named action profile (launch-angle and speed
 * bands), so the planner, the power solver and the actual strike share one model.
 */
export function passProfile(action: string): ProfileEnvelope | null {
  const legacy = legacyProfileFor(action);
  return legacy ? envelopeFor(legacy, action) : null;
}

/** Physics-calibrated power so the ball still carries `arrival` m/s at `distance`. */
export function powerForArrival(
  distance: number, profile: { loft: number; maxPower: number; minPower: number; arrival: number },
  startHeight: number, spin?: THREE.Vector3,
): number {
  // Extra free-roll distance needed to shed `arrival` m/s under rolling resistance.
  const extraRoll = profile.arrival > 0 ? (profile.arrival * profile.arrival) / (2 * CONFIG.ball.rollingDecel) : 0;
  return kickPowerForRange(distance + extraRoll, profile.loft, profile.maxPower, profile.minPower, startHeight, spin);
}

/** Mid-band spin vector: used to make planning see the same curve the strike will. */
function planningSpin(profile: ActionProfile, side: number): THREE.Vector3 {
  const rpm = (profile.spinRpm[0] + profile.spinRpm[1]) / 2;
  const f = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);
  switch (profile.spinType) {
    case "top": return new THREE.Vector3().crossVectors(up, f).multiplyScalar(rpm * Math.PI / 30);
    case "side": return up.clone().multiplyScalar((side < 0 ? -1 : 1) * rpm * Math.PI / 30);
    case "mixed": return new THREE.Vector3().crossVectors(f, up).multiplyScalar(0.8 * rpm * Math.PI / 30)
      .addScaledVector(up, 0.35 * side * rpm * Math.PI / 30);
    case "knuckle": return new THREE.Vector3();
    default: return new THREE.Vector3().crossVectors(f, up).multiplyScalar(rpm * Math.PI / 30);
  }
}

/** Plan a pass to a named receiver: profile, aim point, strike and arrival time. */
export function planNamedPass(
  e: MatchHost, passer: EnginePlayer, action: string, passTo: number | undefined,
  requestedPower?: number, restartKind?: string,
): PassPlan | null {
  const receiver = resolveNamedReceiver(e.players, passer, passTo, action.startsWith("pass_"));
  const baseProfile = passProfile(action);
  if (!receiver || !baseProfile || receiverOffsideAtKick(e, passer, receiver, restartKind)) return null;

  const origin = e.ball.pos.clone();
  const opponents = e.players.filter((p) => p.team !== passer.team && p.idx !== passer.idx);
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

  // --- pick the profile by what is in the way -------------------------------
  const lane = laneOpenness(origin, receiver.pos, opponents);
  const blockerAlong = laneBlockerDistance(origin, receiver.pos, opponents);
  // A dedicated per-kick stream: sampling a profile must never move the AI stream.
  const rng = new SeededRandom(profileStream(e.matchSeed, passer.idx, passer.runSerial, `${action}:${passTo ?? -1}`));
  // A wide carrier delivering into the box is a cross, not a long pass: the cross
  // profiles are the ones with the whipped/floated launch and spin bands.
  const attackGoal = e.ai.goalPos(passer.team, e.rules.half);
  const wide = Math.abs(origin.z) > CONFIG.pitch.width * 0.26;
  const intoBox = Math.abs(receiver.pos.x - attackGoal.x) < 13 && Math.abs(receiver.pos.z) < 8.5;
  // A cross the AI actually decided on is authoritative; the geometry is the fallback
  // for deliveries the scorer described as a normal pass into a crowded box.
  const crossIntent = !restartKind && e.ai.lastDecision.get(passer.idx)?.passCross === true;
  const isCross = (crossIntent || (wide && intoBox)) && distance > 12
    && (action === "pass_long" || action === "pass_short" || action === "pass_through");
  const family = action === "corner_kick" ? "corner" as const : isCross ? "cross" as const : "pass" as const;
  const chosen = chooseProfile(
    family === "corner" ? { family }
      : family === "cross" ? { family }
        : { family, action: action === "pass_long" ? "pass_long" : action === "pass_through" ? "pass_through" : "pass_short" },
    {
      rng, distance, lane, blockerAlong,
      side: (Math.sign(origin.z) || 1) as -1 | 1,
      // Attacking runners are the tall/heading targets a cross is aimed at.
      targetHeight: receiver.role === "FWD" ? 1.92 : 1.82,
      pressed: opponents.some((o) => o.pos.distanceTo(passer.pos) < 2.2),
    },
  );
  // A deliberate foot return to the keeper stays on the grass even when distance made
  // the AI choose a long ball: the launch angle is forced to zero so the back-pass
  // rolls to him, exactly as it did before the profile layer existed. A keeper should
  // never volley a back-pass at his own face.
  const flatToKeeper = receiver.role === "GK" && action.startsWith("pass_");
  const profile = flatToKeeper
    ? { ...chosen, launchDeg: [0, 0] as [number, number], spinType: "back" as const }
    : chosen;
  const envelope = envelopeFor(profile, action);
  const curveSide = action === "corner_kick"
    ? (profile.id === "corner_inswing" ? -Math.sign(origin.z) || 1 : Math.sign(origin.z) || 1)
    : (passer.style.finesseSide || 1);

  const maximumReach = kickMaxRangeFor(envelope.maxPower, envelope.loft, startHeight);
  if (distance > maximumReach - 0.35) return null;
  const spin = planningSpin(profile, curveSide);
  let power = powerForArrival(distance, envelope, startHeight, spin);
  if (requestedPower !== undefined) {
    // Charge changes pace a little but never overpowers the receiver's measured range.
    power = THREE.MathUtils.clamp(requestedPower, power * 0.82, Math.min(envelope.maxPower, power * 1.08));
  }

  let arrivalTime = 0;
  for (let i = 0; i < 5; i++) {
    const travelTime = estimateKickTravelTime(distance, power, envelope.loft, startHeight, spin);
    arrivalTime = travelTime;
    // The prediction — and therefore the strike — must use the speed the receiver can
    // actually reach. A runner sprinting into space covers more ground than the plan's
    // nominal jog, so a pass aimed at his feet would arrive behind him.
    const runningNow = receiver.vel.length() > CONFIG.player.runSpeed;
    const receiverCap = receiver.role === "GK" ? CONFIG.player.runSpeed
      : (action === "pass_through" || runningNow) ? CONFIG.ai.maxSprint
        : assignment?.desiredSpeed ?? CONFIG.player.runSpeed;
    receiverTarget = predictReceiverRun(receiver.pos, receiver.vel, destination, travelTime, receiverCap);
    distance = Math.hypot(receiverTarget.x - origin.x, receiverTarget.z - origin.z);
    if (distance > maximumReach - 0.35) return null;
    const rangePower = powerForArrival(distance, envelope, startHeight, spin);
    power = requestedPower === undefined
      ? rangePower
      : THREE.MathUtils.clamp(requestedPower, rangePower * 0.82, Math.min(envelope.maxPower, rangePower * 1.08));
  }

  const aim = receiverTarget.clone().sub(origin).setY(0).normalize();
  // --- resolve the actual strike against the live physics --------------------
  const accuracy = receiver.role === "GK" ? passer.attributes.goalkeeping.kicking
    : restartKind === "free_kick" ? passer.attributes.passing.freeKick
      : action === "pass_long" ? passer.attributes.passing.longGroundPassing
        : action === "corner_kick" ? passer.attributes.passing.corner
          : passer.attributes.passing.shortGroundPassing;
  const strike: ResolvedStrike = resolveStrike(profile, {
    distance,
    startHeight,
    rng,
    curveSide,
    accuracy,
    speedScale: 0.85 + (passer.attributes.passing.shortGroundPassing + passer.attributes.passing.longGroundPassing) / 400,
    surface: e.ball.surface,
    // The plan computes its own arrival from the strike below; a full trajectory
    // prediction here would run for every candidate pass the AI considers.
    predict: false,
  });
  const kickSpeed = Math.min(strike.speed, envelope.maxPower);
  const loft = strike.loft;
  const plannedVelocity = new THREE.Vector3(aim.x * kickSpeed, kickSpeed * loft, aim.z * kickSpeed);
  const aimDot = passAimDot(origin, plannedVelocity, receiverTarget);
  if (!passAimIsValid(aimDot, CONFIG.ai.passAimConeDegrees)) return null;
  arrivalTime = estimateKickTravelTime(distance, kickSpeed, loft, startHeight, strike.spin);
  return {
    receiver, target: receiverTarget, power: kickSpeed, loft, aimDot, distance, arrivalTime,
    profile: profile.id, strike: { ...strike, speed: kickSpeed },
  };
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
export function evaluateGkDistribution(e: MatchHost, gk: EnginePlayer, urgent = false): GkDistribution | null {
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
  const useShort = !urgent && !!bestShort && (pressure < 4.2 || (bestShort.lane > 0.5 && bestShort.space > 3.2))
    && bestShort.score >= (longOpts[0]?.score ?? -1) - 0.05;
  const chosen = (useShort ? bestShort : undefined) ?? longOpts[0] ?? bestShort;
  if (!chosen) return null;
  // The named delivery profile is chosen at the contact frame, where the keeper's
  // actual pressure, distance and foot are known (see ./contacts, "gk_punt").
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
