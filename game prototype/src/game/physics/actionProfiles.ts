// Named action profiles: the footballing vocabulary the engine is allowed to strike
// the ball with. There is no generic "kick" in gameplay — every pass, cross, set
// piece, shot, header and goalkeeper distribution is one of the profiles below, with
// its own distance / speed / launch-angle / spin ranges.
//
// Two halves:
//   1. the data table (MODEL / ESTIMATE, not laws)
//   2. the resolution layer — sample inside the ranges with a seeded stream, solve
//      the strike against the *real* drag / Magnus / bounce model so it reaches the
//      intended target, predict it with that same model, and pick the profile that
//      beats the obstacle in front of the player.
import * as THREE from "three";
import { CONFIG } from "../config";
import { tieBreakHash, type SeededRandom } from "../random";
import {
  kickPowerForRange, stepBallPhysics, strikeBall,
  type BallState, type KnuckleJitter, type StrikeCommand,
} from "../ball";
import { BALL_GEOMETRY, CORE_PHYSICS, PHYSICS_TICK, truncatedNormal, type SurfaceKind } from "./parameters";

export type SpinType = "none" | "top" | "back" | "side" | "mixed" | "knuckle";
export type ProfileFamily =
  | "pass" | "cross" | "corner" | "free_kick" | "shot" | "keeper"
  | "header" | "restart" | "clearance" | "touch";

export interface ActionProfile {
  id: string;
  name: string;
  family: ProfileFamily;
  /** Intended carry distance band, m. */
  distance: [number, number];
  /** Ball speed at the strike, m/s. */
  speed: [number, number];
  /** Launch angle above the horizontal, degrees. */
  launchDeg: [number, number];
  /** Spin rate band, rpm. */
  spinRpm: [number, number];
  spinType: SpinType;
  /** Where the strike is struck from (height, m) — documentary, the live ball height wins. */
  height: string;
  note: string;
}

const P = (
  id: string, name: string, family: ProfileFamily,
  distance: [number, number], speed: [number, number],
  launchDeg: [number, number], spinRpm: [number, number],
  spinType: SpinType, height: string, note: string,
): ActionProfile => ({ id, name, family, distance, speed, launchDeg, spinRpm, spinType, height, note });

export const ACTION_PROFILES: Record<string, ActionProfile> = {
  // ---- passes -------------------------------------------------------------
  pass_short: P("pass_short", "Short pass", "pass", [5, 20], [8, 14], [1, 5], [80, 200], "back", "ground", "Firm, controlled, easy to receive."),
  pass_medium: P("pass_medium", "Medium pass", "pass", [15, 30], [12, 18], [2, 10], [150, 350], "back", "ground", "Firmer medium-range pass."),
  pass_driven: P("pass_driven", "Driven pass", "pass", [20, 40], [18, 25], [1, 5], [200, 400], "back", "ground", "Driven through the ball, low and hard."),
  pass_lofted_switch: P("pass_lofted_switch", "Lofted switch", "pass", [30, 50], [15, 22], [20, 35], [250, 500], "mixed", "ground", "High, slower, long switch of play."),
  pass_weighted_forward: P("pass_weighted_forward", "Weighted forward pass", "pass", [10, 25], [10, 16], [3, 10], [120, 300], "back", "ground", "Pass into space for a runner to collect."),
  pass_through: P("pass_through", "Through ball", "pass", [8, 25], [12, 18], [2, 8], [120, 280], "back", "ground", "Slipped between defenders into the run."),

  // ---- crosses ------------------------------------------------------------
  cross_whipped: P("cross_whipped", "Whipped cross", "cross", [15, 30], [18, 24], [12, 20], [400, 700], "side", "ground / flank", "Fast, in-swinging, bends around the first defender."),
  cross_floated: P("cross_floated", "Floated cross", "cross", [20, 35], [12, 18], [25, 35], [150, 300], "back", "ground / flank", "Hangs in the air for an attacker to attack."),

  // ---- set pieces ---------------------------------------------------------
  corner_inswing: P("corner_inswing", "In-swinging corner", "corner", [20, 35], [16, 22], [22, 32], [450, 700], "side", "corner flag", "Curves towards the goal."),
  corner_outswing: P("corner_outswing", "Out-swinging corner", "corner", [20, 35], [16, 22], [22, 32], [450, 700], "side", "corner flag", "Curves away from the goal."),
  freekick_curled: P("freekick_curled", "Curled free kick", "free_kick", [18, 30], [18, 26], [18, 28], [500, 800], "side", "ground", "Bends over / around the wall."),
  freekick_knuckle: P("freekick_knuckle", "Knuckleball free kick", "free_kick", [20, 35], [20, 28], [8, 15], [0, 60], "knuckle", "ground", "Almost no spin: unstable, unpredictable flight."),

  // ---- shots --------------------------------------------------------------
  // Small-sided pace bands. The old [22,32] bands × the shooter's power scale
  // produced 30–35 m/s strikes (measured match average 32 m/s, cap 34.7): on a
  // 40 m pitch a 10 m shot then arrived in ~0.30 s, inside the 0.35 s keeper
  // decision delay, so long shots were physically unsaveable. The in-match shot
  // reference is 14–32 m/s with a 24 m/s mean; these bands centre on that mean.
  shot_low_driven: P("shot_low_driven", "Low driven shot", "shot", [10, 30], [17, 27], [2, 8], [100, 250], "back", "ground", "Hard and low into a corner."),
  shot_dipping_topspin: P("shot_dipping_topspin", "Dipping topspin shot", "shot", [18, 35], [17, 26], [8, 15], [500, 800], "top", "ground", "Rises then dips under the bar."),
  shot_chip: P("shot_chip", "Chip", "shot", [8, 25], [11, 17], [25, 40], [400, 700], "back", "ground", "Backspin lob over the goalkeeper."),
  shot_volley: P("shot_volley", "Volley", "shot", [10, 25], [16, 25], [8, 20], [200, 400], "mixed", "air", "Struck out of the air."),
  shot_half_volley: P("shot_half_volley", "Half volley", "shot", [10, 25], [15, 24], [3, 10], [200, 400], "mixed", "just off the ground", "Struck as the ball rises off the grass."),
  header_attacking: P("header_attacking", "Attacking header", "header", [5, 15], [10, 18], [-5, 15], [0, 150], "none", "head height", "Directed header, often downwards."),

  // ---- goalkeeper distributions ------------------------------------------
  gk_punt: P("gk_punt", "Goalkeeper punt", "keeper", [30, 55], [18, 25], [25, 40], [100, 250], "back", "hand drop", "High, long, hanging punt."),
  gk_drop_kick: P("gk_drop_kick", "Drop kick", "keeper", [35, 60], [20, 28], [15, 30], [150, 300], "back", "ground", "Dropped and struck on the bounce: flat and long."),
  gk_throw: P("gk_throw", "Goalkeeper throw", "keeper", [10, 30], [12, 20], [5, 15], [100, 250], "none", "chest height", "Accurate, quick distribution by hand."),
  gk_roll: P("gk_roll", "Goalkeeper roll", "keeper", [5, 25], [6, 10], [0, 2], [0, 50], "none", "ground", "Bowled along the grass to a defender."),
  gk_parry: P("gk_parry", "Parry", "keeper", [1, 12], [5, 12], [5, 20], [0, 80], "none", "hand height", "Deflection wide of goal, keeping some pace."),

  // ---- restarts and loose-ball touches ------------------------------------
  throw_in: P("throw_in", "Throw-in", "restart", [8, 25], [12, 18], [10, 20], [50, 150], "back", "over the head", "Two-handed throw, flat trajectory."),
  clearance: P("clearance", "Clearance", "clearance", [25, 50], [20, 28], [10, 20], [100, 250], "back", "ground", "Hoofed away under pressure."),
  touch_spill: P("touch_spill", "Spill touch", "touch", [1, 8], [2, 4], [0, 3], [0, 60], "none", "ground", "Loose touch from a challenge, not a pass."),
};

export const PROFILE_IDS = Object.keys(ACTION_PROFILES);

/** Which profile a legacy action name maps to when no context overrides it. */
export function legacyProfileFor(action: string): ActionProfile | null {
  switch (action) {
    case "pass_short": return ACTION_PROFILES.pass_short;
    case "pass_long": return ACTION_PROFILES.pass_lofted_switch;
    case "pass_through": return ACTION_PROFILES.pass_through;
    case "header": return ACTION_PROFILES.header_attacking;
    case "corner_kick": return ACTION_PROFILES.corner_inswing;
    case "throw_in": return ACTION_PROFILES.throw_in;
    case "gk_punt": return ACTION_PROFILES.gk_punt;
    case "gk_roll": return ACTION_PROFILES.gk_roll;
    case "shoot_normal": return ACTION_PROFILES.shot_low_driven;
    case "shoot_finesse": return ACTION_PROFILES.shot_chip;
    case "shoot_volley": return ACTION_PROFILES.shot_volley;
    case "tackle_slide": case "tackle_stand": return ACTION_PROFILES.touch_spill;
    default: return null;
  }
}

export function profileById(id: string): ActionProfile {
  return ACTION_PROFILES[id] ?? ACTION_PROFILES.pass_short;
}

/** Physics tick the model integrates at (documented in the parameter set). */
export const MODEL_TICK = PHYSICS_TICK;

const DEG = Math.PI / 180;
const FORWARD = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

/** Unit spin axis for a profile, in canonical +x flight, with the curl sign applied. */
function spinAxis(type: SpinType, side: number): THREE.Vector3 {
  const s = side < 0 ? -1 : 1;
  switch (type) {
    case "top": return new THREE.Vector3().crossVectors(UP, FORWARD);              // +x flight → −z
    case "back": return new THREE.Vector3().crossVectors(FORWARD, UP);             // +x flight → +z
    case "side": return UP.clone().multiplyScalar(s);                              // vertical axis: curves sideways
    case "mixed": return new THREE.Vector3().crossVectors(FORWARD, UP).multiplyScalar(0.8)
      .addScaledVector(UP, 0.35 * s).normalize();
    case "knuckle": return new THREE.Vector3(
      tieBreakHash(7, 1, 0, `knuckle-axis:${side.toFixed(2)}`) - 0.5,
      tieBreakHash(7, 2, 0, `knuckle-axis:${side.toFixed(2)}`) - 0.5,
      tieBreakHash(7, 3, 0, `knuckle-axis:${side.toFixed(2)}`) - 0.5,
    ).normalize();
    default: return new THREE.Vector3();
  }
}

export interface StrikeContext {
  /** Distance to the intended target, m. */
  distance: number;
  /** Live ball height at the strike, m. */
  startHeight?: number;
  /** Seeded stream. Same seed + same context ⇒ identical strike. */
  rng: SeededRandom;
  /** −1..1 curl bias (which way the player bends it). */
  curveSide?: number;
  /** Technique rating 0–100; less accurate players scatter the strike speed. */
  accuracy?: number;
  /** Player power multiplier, e.g. shooting / kicking attributes. */
  speedScale?: number;
  surface?: SurfaceKind;
  /** Fixed launch angle override (used when the geometry demands it). */
  angleDeg?: number;
  /**
   * Strike from the profile's speed band instead of solving the speed to land on the
   * target. Shots, clearances and parries are hit hard at a direction; passes, crosses
   * and set pieces are weighted to arrive.
   */
  directSpeed?: boolean;
  /** Where in the sampled band the direct strike sits (0 = min, 1 = max). */
  intensity?: number;
  /**
   * Run the full delivery simulation and report its shape. Decision code that only
   * needs an executable strike can turn this off: a match plans dozens of candidate
   * passes per second, and each prediction costs a full 8 s trajectory.
   */
  predict?: boolean;
}

/** A resolved, physics-validated strike. */
export interface ResolvedStrike extends StrikeCommand {
  profile: ActionProfile;
  angleDeg: number;
  spinRpm: number;
  spinSide: number;
  distance: number;
  predicted: DeliveryPrediction;
}

export interface DeliveryPrediction {
  flightTime: number;
  peakHeight: number;
  lateralDrift: number;
  arrivalSpeed: number;
  bounces: number;
  reachesTarget: boolean;
}

const LOFT_STEP = 0.02;
const quantizeLoft = (loft: number) => Math.max(0, Math.round(loft / LOFT_STEP) * LOFT_STEP);
const clampNum = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Simulate a strike with the real model and report the delivery's shape. */
export function predictDelivery(strike: StrikeCommand, distance: number, surface?: SurfaceKind): DeliveryPrediction {
  const state: BallState = {
    pos: new THREE.Vector3(0, Math.max(BALL_GEOMETRY.radius, CONFIG.ball.radius), 0),
    vel: new THREE.Vector3(), spin: new THREE.Vector3(), surface, phase: "flight",
  };
  strikeBall(state, new THREE.Vector3(1, 0, 0), strike);
  let peak = state.pos.y;
  let elapsed = 0;
  let arrivalSpeed = strike.speed;
  let lateral = 0;
  let bounces = 0;
  let prevBounces = 0;
  let reached = false;
  for (let i = 1; i <= 120 * 8; i++) {
    stepBallPhysics(state, PHYSICS_TICK);
    elapsed = i * PHYSICS_TICK;
    peak = Math.max(peak, state.pos.y);
    bounces = state.bounces ?? 0;
    if (bounces > prevBounces) prevBounces = bounces;
    if (state.pos.x >= distance) {
      reached = true;
      arrivalSpeed = state.vel.length();
      lateral = state.pos.z;
      break;
    }
    if (state.vel.length() < CORE_PHYSICS.dead_ball_threshold.mean) break;
    if (elapsed > 8) break;
  }
  return {
    flightTime: reached ? elapsed : 8,
    peakHeight: peak,
    lateralDrift: Math.abs(lateral),
    arrivalSpeed,
    bounces: prevBounces,
    reachesTarget: reached,
  };
}

function makeJitter(rng: SeededRandom): KnuckleJitter {
  const band = CORE_PHYSICS.knuckle_random_acceleration;
  const lateralA = band.min + (band.max - band.min) * rng.next();
  const verticalA = band.min + (band.max - band.min) * rng.next();
  return {
    lateralA, lateralF: 0.8 + rng.next() * 2.2, lateralP: rng.next() * Math.PI * 2,
    verticalA, verticalF: 1.1 + rng.next() * 2.6, verticalP: rng.next() * Math.PI * 2,
  };
}

/**
 * Resolve a profile into an executable strike:
 *   • launch angle sampled inside the profile band (truncated normal, quantised so
 *     the physics range tables stay bounded)
 *   • spin magnitude sampled inside the profile band (uniform) with the profile's
 *     spin axis, and capped by Cl = clamp(1.2 S, 0, 0.32) inside the stepper
 *   • speed solved against the real drag / Magnus / bounce model so the ball
 *     arrives at the intended distance, then scattered by technique
 */
export function resolveStrike(profile: ActionProfile, ctx: StrikeContext): ResolvedStrike {
  const rng = ctx.rng;
  const surface = ctx.surface ?? CONFIG.ball.surface ?? "dry";
  const startHeight = Math.max(BALL_GEOMETRY.radius, ctx.startHeight ?? CONFIG.ball.radius);
  const distance = clampNum(ctx.distance, 0.5, 90);
  const scale = clampNum(ctx.speedScale ?? 1, 0.5, 1.25);
  const speedMax = clampNum(profile.speed[1] * scale, 1, CONFIG.ball.maxSpeed);
  const speedMin = Math.min(speedMax, clampNum(profile.speed[0] * scale, 0.5, speedMax));

  // --- launch angle ---------------------------------------------------------
  // The sampled angle is quantised onto the loft grid, but the *band* is a hard
  // constraint: the grid is nudged inwards so a 25° profile can never resolve at 23.7°.
  const [degLo, degHi] = profile.launchDeg;
  const loftFloor = Math.max(0, Math.ceil(Math.tan(Math.max(0, degLo) * DEG) / LOFT_STEP - 1e-9) * LOFT_STEP);
  const loftCeil = Math.max(loftFloor, Math.floor(Math.tan(Math.max(0, degHi) * DEG) / LOFT_STEP + 1e-9) * LOFT_STEP);
  const sampledDeg = ctx.angleDeg ?? truncatedNormal(rng, (degLo + degHi) / 2, degLo, degHi);
  let loft = Math.min(loftCeil, Math.max(loftFloor, quantizeLoft(Math.tan(clampNum(sampledDeg, degLo, degHi) * DEG))));

  // Reachability: a high angle at a capped speed may not carry the target; step the
  // angle down inside the band until it does. At the floor it may still fall short —
  // the planner then decides whether the delivery is worth taking.
  if (distance > 1) {
    const mid = spinVector(profile, ctx);
    for (let guard = 0; guard < 6 && loft > loftFloor; guard++) {
      if (rangeAt(speedMax, loft, startHeight, mid) >= distance) break;
      loft = Math.max(loftFloor, quantizeLoft(loft * 0.75));
    }
  }
  const angleDeg = Math.atan(loft) / DEG;

  // --- spin ------------------------------------------------------------------
  const [rpmLo, rpmHi] = profile.spinRpm;
  const spinRpm = clampNum(rpmLo + (rpmHi - rpmLo) * rng.next(), rpmLo, rpmHi);
  const side = clampNum(ctx.curveSide ?? (rng.next() * 2 - 1), -1, 1);
  const axis = spinAxis(profile.spinType, side);
  const spin = axis.clone().multiplyScalar(spinRpm * Math.PI / 30);
  if (!Number.isFinite(spin.length())) spin.set(0, 0, 0);

  // --- speed -----------------------------------------------------------------
  // Two modes, both seeded:
  //   • weighted delivery — the strike is solved against the real drag / Magnus /
  //     bounce model so the ball lands on the target, with a sampled "intent" that
  //     can overhit but never underhit the receiver
  //   • direct strike — shots, clearances and parries sample straight from the
  //     profile's speed band, because they are hit at a direction, not at a target
  let speed: number;
  const accuracy = clampNum(ctx.accuracy ?? 75, 0, 100);
  if (ctx.directSpeed) {
    const intensity = clampNum(ctx.intensity ?? truncatedNormal(rng, 0.65, 0.25, 1), 0, 1);
    speed = speedMin + (speedMax - speedMin) * intensity;
  } else {
    const solved = kickPowerForRange(distance, loft, speedMax, Math.min(speedMin, 2), startHeight, spin);
    const intent = speedMin + (speedMax - speedMin) * rng.next();
    // Overhit a little when the sampled intent is above the solved pace; never fall
    // short of the solved pace by more than the technique scatter allows.
    speed = solved + Math.max(0, intent - solved) * 0.35;
    speed = clampNum(speed, Math.max(0.5, solved * 0.97), speedMax);
  }
  const scatter = (1 - accuracy / 100) * (ctx.directSpeed ? 0.06 : 0.10);
  speed *= 1 + (rng.next() * 2 - 1) * scatter;
  speed = clampNum(speed, Math.min(speedMin, speedMax) * 0.6, speedMax);

  const jitter = profile.spinType === "knuckle" ? makeJitter(rng) : null;
  const strike: StrikeCommand = {
    speed, loft, spin, jitter, profileId: profile.id,
  };
  return {
    ...strike,
    profile,
    angleDeg,
    spinRpm,
    spinSide: side,
    distance,
    predicted: ctx.predict === false
      ? { flightTime: 0, peakHeight: 0, lateralDrift: 0, arrivalSpeed: speed, bounces: 0, reachesTarget: true }
      : predictDelivery(strike, distance, surface),
  };
}

/** Mid-band spin vector used for the reachability check. */
function spinVector(profile: ActionProfile, ctx: StrikeContext): THREE.Vector3 {
  const [rpmLo, rpmHi] = profile.spinRpm;
  const rpm = (rpmLo + rpmHi) / 2;
  const side = clampNum(ctx.curveSide ?? 0, -1, 1);
  return spinAxis(profile.spinType, side).multiplyScalar(rpm * Math.PI / 30);
}

function rangeAt(speed: number, loft: number, startHeight: number, spin: THREE.Vector3): number {
  const state: BallState = {
    pos: new THREE.Vector3(0, Math.max(BALL_GEOMETRY.radius, startHeight), 0),
    vel: new THREE.Vector3(), spin: new THREE.Vector3(), phase: "flight",
  };
  strikeBall(state, FORWARD, { speed, loft, spin });
  for (let i = 0; i < 120 * 8; i++) {
    stepBallPhysics(state, PHYSICS_TICK);
    if (state.vel.length() < CORE_PHYSICS.dead_ball_threshold.mean) break;
    if (state.pos.x > 95) break;
  }
  return Number.isFinite(state.pos.x) ? state.pos.x : 0;
}

// ---------------------------------------------------------------------------
// Decision layer
// ---------------------------------------------------------------------------
export type ProfileRequest =
  | { family: "pass"; action: "pass_short" | "pass_long" | "pass_through" }
  | { family: "cross" }
  | { family: "corner" }
  | { family: "free_kick" }
  | { family: "shot"; action: "shoot_normal" | "shoot_finesse" | "shoot_volley" | "shoot_half_volley" }
  | { family: "keeper"; urgent?: boolean }
  | { family: "clearance" };

export interface ProfileChoiceContext {
  rng: SeededRandom;
  distance: number;
  /** 0 = lane blocked, 1 = totally open (from `laneOpenness`). */
  lane?: number;
  /** Distance from the striker to the nearest blocker in the lane, m (Infinity = none). */
  blockerAlong?: number;
  /** Height of the intended receiver / target (m) — crossed balls target tall players. */
  targetHeight?: number;
  /** Which side of the pitch the striker is on (−1, 0, +1). */
  side?: -1 | 0 | 1;
  /** True when the striker is under pressure. */
  pressed?: boolean;
  /** True when the keeper is being closed down. */
  keeperPressed?: boolean;
  /** True for a volley / half-volley strike. */
  airborne?: boolean;
  /** True when the shot is being taken from inside the box. */
  inBox?: boolean;
}

/**
 * Choose the action profile by what is in the way — not by a fixed table lookup.
 * A blocked lane gets the whipped/curled variant that bends around the defender; an
 * open lane gets the simpler driven/floated ball.
 */
export function chooseProfile(request: ProfileRequest, ctx: ProfileChoiceContext): ActionProfile {
  const lane = clampNum(ctx.lane ?? 1, 0, 1);
  const blockerAlong = Number.isFinite(ctx.blockerAlong ?? Infinity) ? (ctx.blockerAlong as number) : Infinity;
  const side: -1 | 0 | 1 = ctx.side ?? 0;
  const roll = ctx.rng.next();

  switch (request.family) {
    case "pass": {
      if (request.action === "pass_through") {
        // Through balls are threaded on the ground when the gap is real, lofted over
        // the line when it is not.
        return lane > 0.5 && ctx.distance < 22 ? ACTION_PROFILES.pass_through : ACTION_PROFILES.pass_lofted_switch;
      }
      if (request.action === "pass_long") {
        if (lane < 0.55 || ctx.distance > 33) return ACTION_PROFILES.pass_lofted_switch;
        return ctx.distance > 26 ? ACTION_PROFILES.pass_driven : ACTION_PROFILES.pass_medium;
      }
      // Short pass: a blocked lane is not played short at all — square it firmly.
      if (lane < 0.45) return ACTION_PROFILES.pass_weighted_forward;
      return ctx.distance < 14 ? ACTION_PROFILES.pass_short : ACTION_PROFILES.pass_medium;
    }
    case "cross": {
      // A defender inside the first 8 m blocks the flat ball: whip it around him.
      const blockedEarly = lane < 0.5 || blockerAlong < 8;
      if (blockedEarly) return ACTION_PROFILES.cross_whipped;
      return ctx.targetHeight !== undefined && ctx.targetHeight > 1.85 && ctx.distance > 24
        ? ACTION_PROFILES.cross_floated : ACTION_PROFILES.cross_whipped;
    }
    case "corner": {
      // In-swinging from the taker's natural side; out-swinging when the box is
      // packed with attackers facing their own goal (the keeper cannot come and claim).
      if (side === 0) return roll < 0.5 ? ACTION_PROFILES.corner_inswing : ACTION_PROFILES.corner_outswing;
      return side > 0 ? ACTION_PROFILES.corner_inswing : ACTION_PROFILES.corner_outswing;
    }
    case "free_kick": {
      if (ctx.distance > 26 && lane < 0.45 && roll < 0.4) return ACTION_PROFILES.freekick_knuckle;
      return ACTION_PROFILES.freekick_curled;
    }
    case "shot": {
      if (request.action === "shoot_volley") return ACTION_PROFILES.shot_volley;
      if (request.action === "shoot_half_volley" || ctx.airborne) return ACTION_PROFILES.shot_half_volley;
      if (request.action === "shoot_finesse") {
        // Placed, not bludgeoned: a chip from range, or a dipping ball into a corner
        // when the lane to goal is open.
        if (ctx.distance < 22) return ACTION_PROFILES.shot_chip;
        return lane > 0.5 ? ACTION_PROFILES.shot_dipping_topspin : ACTION_PROFILES.shot_low_driven;
      }
      if (ctx.distance > 24 && lane > 0.5) return ACTION_PROFILES.shot_dipping_topspin;
      if (ctx.distance < 11 && roll < 0.35) return ACTION_PROFILES.shot_chip;
      return ACTION_PROFILES.shot_low_driven;
    }
    case "keeper": {
      if (ctx.keeperPressed && ctx.distance < 26) return ACTION_PROFILES.gk_throw;
      if (ctx.distance > 42) return ACTION_PROFILES.gk_drop_kick;
      return ACTION_PROFILES.gk_punt;
    }
    case "clearance":
      return ACTION_PROFILES.clearance;
  }
}

/**
 * Deterministic per-action stream. Sampling a profile must never consume from the
 * AI's stream — otherwise adding a physics sample would change every later decision.
 */
export function profileStream(seed: number, playerIdx: number, runSerial: number, key: string): number {
  return Math.floor(tieBreakHash(seed, playerIdx, runSerial, `profile:${key}`) * 0x100000000) >>> 0;
}

/** Human-readable summary for the debug panel / AI event log. */
export function describeStrike(strike: ResolvedStrike): string {
  return `${strike.profile.name} · ${strike.speed.toFixed(1)} m/s · ${strike.angleDeg.toFixed(1)}° · ${strike.spinRpm.toFixed(0)} rpm · ${strike.predicted.flightTime.toFixed(2)} s`;
}
