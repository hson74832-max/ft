// Ball — single source of truth for possession, and the football flight model.
//
// The model is the parameter-set model, not a generic projectile:
//
//   • gravity, air density, ball mass / radius / area / inertia come from the
//     legal ranges (see ./physics/parameters)
//   • quadratic drag with the drag crisis — Cd is high at low speed and low above
//     ~18 m/s, interpolated across the crisis band
//   • Magnus lift from the spin vector, with the spin parameter S = |ω| r / v
//     clamped, and Cl = clamp(1.2 S, 0, 0.32)
//   • exponential spin decay anchored on the measured 12 % loss after one second
//   • a Flight → Bounce → Roll → Dead state machine with per-surface restitution,
//     tangential friction and the spin ↔ bounce coupling (topspin kicks forward,
//     backspin checks or reverses, sidespin kicks sideways)
//   • rolling resistance per surface, with the spin steering the roll
//   • integration at a 120 Hz physics tick, substepped from whatever frame delta
//     the renderer delivers, so the trajectory does not depend on frame rate
//
// Every division is guarded, every sampled random draw is seeded, and no path can
// produce a NaN (a non-finite ball state is parked dead instead of propagating).
import * as THREE from "three";
import { CONFIG } from "./config";
import { tieBreakHash } from "./random";
import {
  BALL_GEOMETRY, CORE_PHYSICS, PHYSICS_TICK, MAX_PHYSICS_SUBSTEPS,
  SURFACES, param, type SurfaceKind,
} from "./physics/parameters";

export type BallPhase = "flight" | "bounce" | "roll" | "dead";

/**
 * Deterministic turbulence for a knuckle ball: two sinusoids applied along the
 * lateral and vertical axes. Baked at strike time from the seeded stream, so the
 * wobble is identical for the same match seed and independent of frame rate.
 */
export interface KnuckleJitter {
  lateralA: number; lateralF: number; lateralP: number;
  verticalA: number; verticalF: number; verticalP: number;
}

export interface BallState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3; // rad/s angular velocity vector
  /** Live motion state (defaults to `flight` until the ball touches grass). */
  phase?: BallPhase;
  /** Surface the ball is playing on. */
  surface?: SurfaceKind;
  /** Seconds since the ball was last struck (drives knuckle turbulence). */
  age?: number;
  /** Ground contacts since the last strike. */
  bounces?: number;
  /** Knuckle / turbulent-wake model; null for a normal strike. */
  jitter?: KnuckleJitter | null;
}

const AIR_DENSITY = param("air_density");
const GRAVITY = param("gravity");
const MASS = BALL_GEOMETRY.mass;
/** Physical radius derived from the legal circumference (C/2π); used by the aerodynamics. */
const PHYS_RADIUS = BALL_GEOMETRY.radius;
/** Contact / resting radius: the rendered ball's radius, within the same legal range. */
const RADIUS = CONFIG.ball.radius;
const AREA = BALL_GEOMETRY.area;
const CL_MAX = CORE_PHYSICS.lift_coefficient_cl.max; // 0.32
const CL_FACTOR = 1.2;
const DEAD_BALL = param("dead_ball_threshold");
const FLIGHT_ACTIVATION = param("flight_activation_threshold");
const BOUNCE_ACTIVATION = param("bounce_activation_threshold");
const ROLL_ACTIVATION = param("roll_activation_threshold");
const KNUCKLE_RPM = param("knuckle_mode_trigger");
const STABLE_SPIN_RPM = param("stable_spin_mode_trigger");
const DRAG_LOW_SPEED = param("drag_regime_low_speed");
const DRAG_HIGH_SPEED = param("drag_regime_high_speed");
const CD_LOW = param("drag_coefficient_low_speed");
const CD_MID = param("drag_coefficient_transition");
const CD_HIGH = param("drag_coefficient_high_speed");
/** Measured 12 % spin loss in the first second: λ = −ln(0.88) ≈ 0.128 /s. */
const SPIN_DECAY_RATE = -Math.log(1 - CORE_PHYSICS.spin_decay_after_1s.mean / 100);

/** rpm → rad/s. */
const RPM = Math.PI / 30;
/** rad/s → rpm. */
export const RPM_FROM_RAD = 30 / Math.PI;

/** Horizontal unit vector of the velocity, or +x for a stationary ball. */
function horizontalDir(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const len = Math.hypot(v.x, v.z);
  if (!(len > 1e-6)) return out.set(1, 0, 0);
  return out.set(v.x / len, 0, v.z / len);
}

/**
 * Deterministic [0,1) draw from the ball's own state — no shared RNG consumed, so a
 * random-looking bounce cannot shift the match's AI stream or depend on frame rate.
 * Position is quantised to the centimetre and the bounce count is folded in, so the
 * same strike on the same seed always bounces the same way.
 */
function surfaceDraw(s: BallState, salt: number): number {
  const b = s.bounces ?? 0;
  return tieBreakHash(
    Math.round((s.pos.x + 100) * 100), Math.round((s.pos.z + 100) * 100),
    b * 977 + salt, "ball-surface",
  );
}

function surfaceKind(s: BallState): SurfaceKind {
  return s.surface ?? CONFIG.ball.surface ?? "dry";
}

/**
 * Speed-dependent drag coefficient (drag crisis). High drag below ~10 m/s, a lower
 * plateau above ~20 m/s, and a smooth transition across the crisis band.
 */
export function dragCoefficientAt(speed: number): number {
  const s = Number.isFinite(speed) ? Math.abs(speed) : 0;
  if (s <= DRAG_LOW_SPEED) return CD_LOW;
  if (s >= DRAG_HIGH_SPEED) return CD_HIGH;
  const t = (s - DRAG_LOW_SPEED) / Math.max(1e-6, DRAG_HIGH_SPEED - DRAG_LOW_SPEED);
  const smooth = t * t * (3 - 2 * t);
  // The transition value is a measured point on the curve; hold it at mid-band.
  if (Math.abs(t - 0.5) < 0.02) return CD_MID;
  return t < 0.5
    ? CD_LOW + (CD_MID - CD_LOW) * (smooth / 0.5)
    : CD_MID + (CD_HIGH - CD_MID) * ((smooth - 0.5) / 0.5);
}

function dragK(speed: number): number {
  return 0.5 * AIR_DENSITY * dragCoefficientAt(speed) * AREA / MASS;
}

/** Cl = clamp(1.2·S, 0, 0.32) with S = |ω|·r/v, S clamped and v guarded. */
export function liftCoefficientAt(spinMag: number, speed: number): number {
  const v = Math.max(speed, DEAD_BALL);
  const raw = (Math.max(0, spinMag) * PHYS_RADIUS) / v;
  const S = Math.min(CORE_PHYSICS.spin_parameter_S.max, Math.max(0, raw));
  return THREE.MathUtils.clamp(CL_FACTOR * S, 0, CL_MAX);
}

/** Applies the aerodynamic forces for one physics substep. */
function integrateForces(s: BallState, h: number) {
  const v = s.vel;
  const speed = v.length();
  v.y -= GRAVITY * h;

  if (!Number.isFinite(speed) || speed <= 1e-6) {
    s.spin.set(0, 0, 0);
    return;
  }

  // Quadratic drag: a = −½ρ·Cd(v)·A·|v|·v / m.
  const k = dragK(speed);
  const dragScale = Math.max(0, 1 - k * speed * h);
  v.multiplyScalar(dragScale);

  // Spin: exponential decay, then the Magnus force. Zero the rotation below the
  // dead-ball speed — a stopped ball cannot be spinning meaningfully.
  const spinMag = s.spin.length();
  if (spinMag > 0) {
    if (speed < DEAD_BALL) {
      s.spin.set(0, 0, 0);
    } else {
      s.spin.multiplyScalar(Math.exp(-SPIN_DECAY_RATE * h));
      const cl = liftCoefficientAt(spinMag, speed);
      if (cl > 1e-4) {
        const cross = new THREE.Vector3().crossVectors(s.spin, v);
        const crossMag = cross.length();
        if (crossMag > 1e-6) {
          const aLift = 0.5 * AIR_DENSITY * AREA * cl * speed * speed / MASS;
          v.addScaledVector(cross, (aLift / crossMag) * h);
        }
      }
      // Knuckle: turbulent wake, not a stable spin axis.
      const rpm = spinMag * RPM_FROM_RAD;
      const jitter = s.jitter;
      if (jitter && rpm < KNUCKLE_RPM) {
        const t = s.age ?? 0;
        const lateral = jitter.lateralA * Math.sin(2 * Math.PI * jitter.lateralF * t + jitter.lateralP);
        const vertical = jitter.verticalA * Math.sin(2 * Math.PI * jitter.verticalF * t + jitter.verticalP);
        const fwd = horizontalDir(v);
        const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
        v.addScaledVector(side, lateral * h);
        v.y += vertical * h;
      }
      // Spin-axis wobble: low-spin balls are not gyroscopically stable.
      if (rpm < STABLE_SPIN_RPM && rpm > 1e-3) {
        const wobble = 1 - Math.min(1, rpm / Math.max(1, STABLE_SPIN_RPM));
        const drift = 0.6 * wobble * h;
        s.spin.x += drift * (surfaceDraw(s, 11) * 2 - 1) * 0.4;
        s.spin.z += drift * (surfaceDraw(s, 12) * 2 - 1) * 0.4;
      }
    }
  }
}

/** Bounce response: restitution, tangential friction and spin coupling. */
function resolveBounce(s: BallState, h: number) {
  const surface = surfaceKind(s);
  const table = SURFACES[surface];
  const eBase = param(table.restitution);
  const friction = param(table.friction);
  const bounces = s.bounces ?? 0;

  // Grass is not uniform: a deterministic per-contact draw on the surface bands.
  const e = THREE.MathUtils.clamp(
    eBase + (surfaceDraw(s, 1) * 2 - 1) * ((CORE_PHYSICS[table.restitution].max - CORE_PHYSICS[table.restitution].min) * 0.25),
    CORE_PHYSICS[table.restitution].min, CORE_PHYSICS[table.restitution].max,
  );

  const vImpact = Math.max(0, -s.vel.y);
  s.vel.y = vImpact * e;

  // Tangential slip at the contact point: u = v_h + ω × (−r ŷ).
  const contact = new THREE.Vector3(0, -PHYS_RADIUS, 0);
  const surfaceVel = new THREE.Vector3().crossVectors(s.spin, contact);
  const slip = new THREE.Vector3(s.vel.x + surfaceVel.x, 0, s.vel.z + surfaceVel.z);
  const slipMag = slip.length();
  const horizSpeed = Math.hypot(s.vel.x, s.vel.z);

  if (slipMag > 1e-5) {
    // Coulomb friction: impulse limited by μ·(1+e)·v_impact, applied against slip.
    const maxDv = friction * (1 + e) * vImpact;
    const grip = BALL_GEOMETRY.slipFactor;
    const dv = Math.min(maxDv, slipMag * grip);
    const nx = slip.x / slipMag, nz = slip.z / slipMag;
    s.vel.x -= nx * dv;
    s.vel.z -= nz * dv;
    // Reaction on the spin: the surface torque spins the ball towards rolling.
    const spinDelta = (dv / Math.max(1e-6, PHYS_RADIUS));
    s.spin.x += -nz * spinDelta * 0.55;
    s.spin.z += nx * spinDelta * 0.55;
  }

  // Bounce-specific spin loss, then the per-spin-type corrections from the model.
  const lossBand = CORE_PHYSICS.spin_loss_during_bounce;
  const spinLoss = (lossBand.min + (lossBand.max - lossBand.min) * surfaceDraw(s, 2)) / 100;
  s.spin.multiplyScalar(THREE.MathUtils.clamp(1 - spinLoss, 0.25, 1));

  // Directional terms the pure friction impulse understates, clamped to the bands.
  const fwd = horizontalDir(s.vel);
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const topSpin = s.spin.dot(new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd)) * PHYS_RADIUS;
  const sideSpin = s.spin.dot(new THREE.Vector3(0, 1, 0));

  if (topSpin > 0) {
    // Topspin: kicks forward and low.
    const gain = THREE.MathUtils.clamp(
      (surfaceDraw(s, 3) * 2 - 1) * 0.5 + CORE_PHYSICS.topspin_bounce_forward_gain.mean / 100, 0,
      CORE_PHYSICS.topspin_bounce_forward_gain.max / 100,
    );
    s.vel.addScaledVector(fwd, horizSpeed * gain * Math.min(1, topSpin / 2));
    s.vel.y *= 0.97;
  } else if (topSpin < 0) {
    // Backspin: checks the ball; heavy backspin can stop or reverse it.
    const backRpm = Math.abs(topSpin) * RPM_FROM_RAD;
    const loss = Math.abs(CORE_PHYSICS.backspin_bounce_forward_loss.mean) / 100;
    const strength = THREE.MathUtils.clamp(backRpm / Math.max(1, param("backspin_reversal_threshold")), 0, 1.6);
    s.vel.addScaledVector(fwd, -Math.min(horizSpeed, horizSpeed * loss * strength));
    s.vel.y *= 1 + THREE.MathUtils.clamp(strength * 0.06, 0, 0.12);
    if (strength > 1 && horizSpeed < 3) {
      // The ball reverses off a heavy backspin contact.
      s.vel.addScaledVector(fwd, -Math.min(horizSpeed, backRpm * 0.0015));
    }
  }

  if (Math.abs(sideSpin) > 1e-3) {
    const kick = THREE.MathUtils.clamp(sideSpin * PHYS_RADIUS * 0.35,
      -CORE_PHYSICS.sidespin_bounce_lateral_kick.max, CORE_PHYSICS.sidespin_bounce_lateral_kick.max);
    s.vel.addScaledVector(side, kick * (surface === "wet" ? 0.7 : 1));
  }

  // Low-spin (knuckle) balls bounce unpredictably; wet patches and divots more so.
  const rpm = s.spin.length() * RPM_FROM_RAD;
  if (rpm < KNUCKLE_RPM) {
    const lateralError = THREE.MathUtils.clamp(
      CORE_PHYSICS.knuckle_bounce_lateral_error.min
      + (surfaceDraw(s, 4)) * (CORE_PHYSICS.knuckle_bounce_lateral_error.max - CORE_PHYSICS.knuckle_bounce_lateral_error.min),
      0, CORE_PHYSICS.knuckle_bounce_lateral_error.max);
    const verticalError = THREE.MathUtils.clamp(
      surfaceDraw(s, 5) * CORE_PHYSICS.knuckle_bounce_vertical_error.max, 0,
      CORE_PHYSICS.knuckle_bounce_vertical_error.max);
    s.vel.addScaledVector(side, (surfaceDraw(s, 6) * 2 - 1) * lateralError);
    s.vel.y += (surfaceDraw(s, 7) * 2 - 1) * verticalError;
  }
  if (surface === "wet" || surface === "divot") {
    const slipLoss = (surface === "wet" ? CORE_PHYSICS.bounce_wet_patch_speed_loss : CORE_PHYSICS.bounce_divot_direction_error).mean / 100;
    const delta = (surfaceDraw(s, 8) * 2 - 1) * slipLoss * 0.25;
    s.vel.x *= 1 - slipLoss * 0.5;
    s.vel.z *= 1 - slipLoss * 0.5;
    s.vel.addScaledVector(side, delta * Math.max(1, horizSpeed));
  }

  s.bounces = bounces + 1;
  s.pos.y = RADIUS;

  const speed = s.vel.length();
  if (speed > param("bounce_flight_continuation_threshold") && s.vel.y > BOUNCE_ACTIVATION) {
    s.phase = "bounce";
  } else if (speed > ROLL_ACTIVATION) {
    s.phase = "roll";
    s.vel.y = 0;
  } else {
    s.phase = "dead";
    s.vel.set(0, 0, 0);
    s.spin.set(0, 0, 0);
  }
  // Frame-rate independent guard: a bounce cannot inject energy.
  if (s.vel.length() > CONFIG.ball.maxSpeed) s.vel.setLength(CONFIG.ball.maxSpeed);
  void h;
}

/** Rolling: resistance per surface plus spin → roll coupling. */
function resolveRoll(s: BallState, h: number) {
  const surface = surfaceKind(s);
  const table = SURFACES[surface];
  const mu = param(table.rolling);
  let decel = mu * GRAVITY;

  const v = s.vel;
  const speed = Math.hypot(v.x, v.z);
  if (speed <= 1e-5) {
    v.set(0, 0, 0);
    s.spin.set(0, 0, 0);
    s.phase = "dead";
    return;
  }
  const fwd = horizontalDir(v);
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const topAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd);
  const topSpin = s.spin.dot(topAxis);          // >0 topspin, <0 backspin
  const backRpm = Math.max(0, -topSpin) * RPM_FROM_RAD;

  if (topSpin < 0) {
    // Backspin slows the roll and can stop it dead; never reverses a slow roll.
    decel += Math.min(2.4, backRpm / 260) * Math.abs(CORE_PHYSICS.backspin_roll_forward_loss.mean) * 0.1;
  } else if (topSpin > 0) {
    decel *= 1 - Math.min(0.2, (topSpin * RPM_FROM_RAD) / 2500);
  }

  // Sidespin steers a rolling ball, weaker than in the air.
  const sideSpin = s.spin.y;
  if (Math.abs(sideSpin) > 0.05) {
    const steer = Math.min(0.9, Math.abs(sideSpin) * PHYS_RADIUS * 0.09);
    v.addScaledVector(side, Math.sign(sideSpin) * steer * h);
  }

  const drop = Math.min(speed, decel * h);
  v.x -= (v.x / Math.max(speed, 1e-6)) * drop;
  v.z -= (v.z / Math.max(speed, 1e-6)) * drop;

  // Spin relaxes towards the no-slip rolling condition, and decays on grass.
  // For v = +x the rolling condition is ω = −ẑ·(v/r): exactly topAxis·(v/r).
  const rollOmega = (Math.hypot(v.x, v.z) / PHYS_RADIUS);
  const target = topAxis.clone().multiplyScalar(rollOmega);
  const blend = Math.min(1, h / Math.max(0.05, param("rolling_spin_decay_time")));
  s.spin.lerp(target, blend);

  const remaining = Math.hypot(v.x, v.z);
  if (!Number.isFinite(remaining)) {
    v.set(0, 0, 0);
    s.spin.set(0, 0, 0);
    s.phase = "dead";
    return;
  }
  if (remaining < DEAD_BALL) {
    v.set(0, 0, 0);
    s.spin.set(0, 0, 0);
    s.phase = "dead";
  } else {
    s.phase = "roll";
  }
}

function stepBallSubstep(s: BallState, h: number) {
  if (!Number.isFinite(s.pos.x) || !Number.isFinite(s.pos.y) || !Number.isFinite(s.pos.z)
    || !Number.isFinite(s.vel.x) || !Number.isFinite(s.vel.y) || !Number.isFinite(s.vel.z)
    || !Number.isFinite(s.spin.x) || !Number.isFinite(s.spin.y) || !Number.isFinite(s.spin.z)) {
    // A non-finite state would poison every downstream prediction: park it dead.
    s.pos.set(0, RADIUS, 0);
    s.vel.set(0, 0, 0);
    s.spin.set(0, 0, 0);
    s.phase = "dead";
    return;
  }
  s.age = (s.age ?? 0) + h;

  const grounded = s.pos.y <= RADIUS + 0.005;
  integrateForces(s, h);

  s.pos.x += s.vel.x * h;
  s.pos.y += s.vel.y * h;
  s.pos.z += s.vel.z * h;

  if (s.pos.y <= RADIUS) {
    s.pos.y = RADIUS;
    if (s.vel.y < -BOUNCE_ACTIVATION) {
      resolveBounce(s, h);
    } else if (grounded || s.vel.y <= 0) {
      s.vel.y = 0;
      resolveRoll(s, h);
    }
  } else {
    const speed = s.vel.length();
    if (s.phase !== "flight" && (speed > FLIGHT_ACTIVATION || s.pos.y > RADIUS + 0.05)) {
      s.phase = "flight";
    }
    if (speed < DEAD_BALL && s.pos.y <= RADIUS + 0.01) {
      s.vel.set(0, 0, 0);
      s.spin.set(0, 0, 0);
      s.phase = "dead";
    }
  }

  if (s.phase === undefined) s.phase = "flight";

  const total = s.vel.length();
  if (total > CONFIG.ball.maxSpeed) s.vel.multiplyScalar(CONFIG.ball.maxSpeed / total);
}

/**
 * Advance free-ball physics by `dt`, substepped at the 120 Hz physics tick.
 * Pure — no DOM, no scene, no shared random stream.
 */
export function stepBallPhysics(s: BallState, dt: number, surface?: SurfaceKind): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  if (surface) s.surface = surface;
  const total = Math.min(0.1, dt);
  const substeps = Math.max(1, Math.min(MAX_PHYSICS_SUBSTEPS, Math.ceil(total / PHYSICS_TICK - 1e-9)));
  const h = total / substeps;
  for (let i = 0; i < substeps; i++) stepBallSubstep(s, h);
}

/** A fully resolved strike: the action profile's sampled output. */
export interface StrikeCommand {
  /** Ball speed at the boot, m/s (already inside the profile's band). */
  speed: number;
  /** Launch slope: vy = speed · loft. */
  loft: number;
  /** Angular velocity vector, rad/s. */
  spin: THREE.Vector3;
  jitter?: KnuckleJitter | null;
  /** Diagnostic only — the profile that produced this strike. */
  profileId?: string;
}

/** Apply a fully resolved strike (used by every named action profile). */
export function strikeBall(s: BallState, dir: THREE.Vector3, strike: StrikeCommand): void {
  const d = horizontalDir(dir, new THREE.Vector3());
  const speed = THREE.MathUtils.clamp(
    Number.isFinite(strike.speed) ? strike.speed : 0, 0, CONFIG.ball.maxSpeed,
  );
  const loft = THREE.MathUtils.clamp(Number.isFinite(strike.loft) ? strike.loft : 0, 0, 3);
  s.vel.set(d.x * speed, speed * loft, d.z * speed);
  // The launch vector is `speed` long horizontally and `speed·loft` tall; scale so
  // `speed` is the true ball speed and the launch angle stays atan(loft).
  const norm = Math.hypot(1, loft);
  if (norm > 1e-6) s.vel.multiplyScalar(1 / norm);
  s.spin.copy(strike.spin);
  if (!Number.isFinite(s.spin.x) || !Number.isFinite(s.spin.y) || !Number.isFinite(s.spin.z)) s.spin.set(0, 0, 0);
  s.jitter = strike.jitter ?? null;
  s.age = 0;
  s.bounces = 0;
  s.phase = "flight";
  const sp = s.vel.length();
  if (sp > CONFIG.ball.maxSpeed) s.vel.multiplyScalar(CONFIG.ball.maxSpeed / sp);
}

/**
 * Generic kick — kept for the legacy call sites and the physics self-tests.
 * `spinSide` is a signed curl strength; a trace of backspin always accompanies it.
 * New code should go through an action profile (`strikeBall`).
 */
export function kickBall(s: BallState, dir: THREE.Vector3, power: number, loft = 0.15, spinSide = 0): void {
  const d = horizontalDir(dir, new THREE.Vector3());
  const back = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
  const spin = back.multiplyScalar(spinSide !== 0 ? CONFIG.ball.spinPass * 0.3 * RPM : 2);
  spin.y += spinSide * CONFIG.ball.spinShot;
  strikeBall(s, d, { speed: power, loft, spin, profileId: "legacy_kick" });
}

/** Range of a strike under the live physics, with spin, from `startHeight`. */
function simulateRange(speed: number, loft: number, startHeight: number, spin: THREE.Vector3, surface: SurfaceKind): number {
  const state: BallState = {
    pos: new THREE.Vector3(0, Math.max(RADIUS, startHeight), 0),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    surface,
    phase: "flight",
  };
  strikeBall(state, new THREE.Vector3(1, 0, 0), { speed, loft, spin });
  for (let i = 0; i < 120 * 8; i++) {
    stepBallPhysics(state, PHYSICS_TICK);
    if (state.pos.x > 90 || state.vel.length() < DEAD_BALL) break;
  }
  return Number.isFinite(state.pos.x) ? state.pos.x : 0;
}

interface KickRangeSample { power: number; range: number; }
const kickRangeTables = new Map<string, KickRangeSample[]>();
/** Hard cap so the module-level cache can never grow without bound. */
const KICK_TABLE_LIMIT = 192;

function buildKickRangeTable(rawMaxPower: number, loft: number, startHeight: number = RADIUS, spin?: THREE.Vector3): KickRangeSample[] {
  // Quantise the power ceiling to 0.5 m/s: the ceiling arrives from a per-player
  // attribute multiplier, and without quantisation every player built (and cached)
  // his own 100-sample table.
  const maxPower = Math.ceil(Math.max(0.5, rawMaxPower) * 2) / 2;
  // `startHeight` arrives as the live ball height — a continuous value. Keying
  // the cache on the exact height would build (and keep forever) a fresh table
  // for every distinct airborne height an AI think happens to sample, each one
  // costing ~100 simulated kicks. Bucket heights to 5 cm instead; the table is
  // simulated at the first height seen in its bucket. A possessed ball sits
  // exactly at radius height, so ground passes keep their exact tables.
  const spinRpm = spin ? Math.round((spin.length() * RPM_FROM_RAD) / 25) * 25 : 0;
  const spinAxis = spin && spin.length() > 1e-3
    ? `${Math.round(spin.x / spin.length() * 4)}:${Math.round(spin.y / spin.length() * 4)}:${Math.round(spin.z / spin.length() * 4)}`
    : "none";
  const surface = CONFIG.ball.surface ?? "dry";
  const key = `${loft.toFixed(4)}:${maxPower.toFixed(1)}:${Math.round(startHeight / 0.05)}:${spinRpm}:${spinAxis}:${surface}`;
  const existing = kickRangeTables.get(key);
  if (existing) return existing;
  const table: KickRangeSample[] = [];
  const spinVec = spin && spin.length() > 1e-3 ? spin.clone().normalize().multiplyScalar(spinRpm * RPM) : new THREE.Vector3();
  for (let power = 0.5; power <= maxPower + 0.001; power += 0.25) {
    table.push({ power, range: simulateRange(power, loft, startHeight, spinVec, surface) });
  }
  kickRangeTables.set(key, table);
  if (kickRangeTables.size > KICK_TABLE_LIMIT) {
    // Maps iterate in insertion order: drop the oldest table. It is rebuilt
    // identically if ever needed again, so eviction cannot change behaviour.
    const oldest = kickRangeTables.keys().next().value;
    if (oldest !== undefined) kickRangeTables.delete(oldest);
  }
  return table;
}

/** Find the weakest kick (m/s) whose measured physics range reaches the target. */
export function kickPowerForRange(
  distance: number, loft: number, maxPower: number, minPower = 2.5,
  startHeight: number = RADIUS, spin?: THREE.Vector3,
): number {
  if (!Number.isFinite(distance) || !Number.isFinite(loft) || !Number.isFinite(maxPower)) return minPower;
  const table = buildKickRangeTable(maxPower, loft, startHeight, spin);
  if (!table.length) return minPower;
  const desired = Math.max(0.5, distance);
  if (desired <= table[0].range) return Math.max(minPower, table[0].power);
  for (let i = 1; i < table.length; i++) {
    if (table[i].range < desired) continue;
    const a = table[i - 1], b = table[i];
    const f = (desired - a.range) / Math.max(0.001, b.range - a.range);
    return THREE.MathUtils.clamp(THREE.MathUtils.lerp(a.power, b.power, f), minPower, maxPower);
  }
  return maxPower;
}

/** Full-power range from the cached range table (no fresh 8 s simulation). */
export function kickMaxRangeFor(maxPower: number, loft: number, startHeight: number = RADIUS, spin?: THREE.Vector3): number {
  const table = buildKickRangeTable(maxPower, loft, startHeight, spin);
  return table.length ? table[table.length - 1].range : 0;
}

export function kickRangeForPower(power: number, loft: number, startHeight: number = RADIUS, spin?: THREE.Vector3): number {
  const surface = CONFIG.ball.surface ?? "dry";
  return simulateRange(Math.max(0, power), loft, startHeight,
    spin ?? new THREE.Vector3(), surface);
}

/**
 * Numerically estimate arrival time with the same ball-stepper used in play.
 *
 * When the ball stalls short of the target it cannot reach it at all. The old
 * fallback was a straight line `distance / power` that ignored drag, so every slow
 * lofted delivery — the ones where drag matters most — was reported as arriving
 * early and the AI aimed behind the runner. Report the 8 s horizon instead: a pass
 * that will not get there must not look like a quick one.
 */
export function estimateKickTravelTime(
  distance: number, power: number, loft: number, startHeight: number = RADIUS,
  spin?: THREE.Vector3,
): number {
  // Nothing usable to measure: report the horizon rather than an instant arrival.
  if (!Number.isFinite(distance) || !Number.isFinite(power)) return 8;
  const state: BallState = {
    pos: new THREE.Vector3(0, Math.max(RADIUS, startHeight), 0),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    surface: CONFIG.ball.surface ?? "dry",
    phase: "flight",
  };
  strikeBall(state, new THREE.Vector3(1, 0, 0), { speed: power, loft, spin: spin ?? new THREE.Vector3() });
  for (let i = 1; i <= 120 * 8; i++) {
    stepBallPhysics(state, PHYSICS_TICK);
    if (state.pos.x >= distance && state.pos.y <= RADIUS + 0.06) return i * PHYSICS_TICK;
    if (state.pos.x >= distance && state.vel.y > 0) return i * PHYSICS_TICK;
    if (state.vel.length() < DEAD_BALL) break;
  }
  // The same 8 s window the simulation searched: unreachable, not "soon".
  return 8;
}

export interface TrajectorySample { t: number; pos: THREE.Vector3; }

/**
 * Project the live ball forward with the real physics (drag, Magnus, bounces,
 * roll). Used by the AI so its interception and shot-reading match what the ball
 * will actually do. Pure: works on a copy.
 */
export function predictTrajectory(
  start: BallState, horizon: number, sampleEvery = 0.1, surface?: SurfaceKind,
): TrajectorySample[] {
  const state: BallState = {
    pos: start.pos.clone(), vel: start.vel.clone(), spin: start.spin.clone(),
    surface: surface ?? start.surface, phase: start.phase, age: start.age,
    bounces: start.bounces, jitter: start.jitter ?? null,
  };
  const h = 1 / 60;
  const out: TrajectorySample[] = [{ t: 0, pos: state.pos.clone() }];
  let nextSample = sampleEvery;
  const limit = Math.max(0, Math.min(6, Number.isFinite(horizon) ? horizon : 0));
  for (let t = h; t <= limit + 1e-9; t += h) {
    stepBallPhysics(state, h);
    if (t + 1e-9 >= nextSample) {
      out.push({ t, pos: state.pos.clone() });
      nextSample += sampleEvery;
    }
  }
  return out;
}

export class Ball {
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  pos = new THREE.Vector3(0, CONFIG.ball.radius, 0);
  /** Position at the start of the last step: the swept segment goal/out checks need. */
  prevPos = new THREE.Vector3(0, CONFIG.ball.radius, 0);
  vel = new THREE.Vector3();
  spin = new THREE.Vector3(); // rad/s angular velocity vector
  phase: BallPhase = "dead";
  surface: SurfaceKind = "dry";
  age = 0;
  bounces = 0;
  jitter: KnuckleJitter | null = null;
  possessedBy: number | null = null; // player index
  lastTouch: number | null = null;
  lastTouchTeam: number | null = null;
  ownerTeam: number | null = null;
  spinVisual = 0;
  /** Player who last struck the ball and seconds since the strike (re-trap guard). */
  kickedBy: number | null = null;
  kickAge = 99;
  // A deliberate teammate foot pass must be controlled with the keeper's feet.
  handsRestrictedTeam: number | null = null;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(CONFIG.ball.radius, 20, 16);
    // pentagon-ish pattern via canvas
    const cv = document.createElement("canvas"); cv.width = cv.height = 128;
    const c = cv.getContext("2d")!;
    c.fillStyle = "#f8fafc"; c.fillRect(0, 0, 128, 128);
    c.fillStyle = "#0f172a";
    for (let i = 0; i < 6; i++) {
      const x = 16 + (i * 53) % 112, y = 16 + (i * 37) % 112;
      c.beginPath(); c.arc(x, y, 9, 0, 7); c.fill();
    }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    this.mesh.castShadow = true;
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.14, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    scene.add(this.mesh, this.shadow);
  }

  get speed() { return this.vel.length(); }
  get grounded() { return this.pos.y <= CONFIG.ball.radius + 0.015; }

  kick(dir: THREE.Vector3, power: number, loft = 0.15, spinSide = 0) {
    kickBall(this, dir, power, loft, spinSide);
    this.kickedBy = this.lastTouch;
    this.kickAge = 0;
    this.possessedBy = null;
    this.ownerTeam = null;
  }

  /** Strike the ball with a resolved action-profile command. */
  strike(dir: THREE.Vector3, strike: StrikeCommand) {
    strikeBall(this, dir, strike);
    this.kickedBy = this.lastTouch;
    this.kickAge = 0;
    this.possessedBy = null;
    this.ownerTeam = null;
  }

  possess(idx: number, team: number) {
    this.possessedBy = idx; this.ownerTeam = team;
    this.lastTouch = idx; this.lastTouchTeam = team;
    if (this.handsRestrictedTeam !== team) this.handsRestrictedTeam = null;
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.jitter = null;
    this.phase = "dead";
    this.age = 0;
    this.bounces = 0;
  }
  release() { this.possessedBy = null; this.ownerTeam = null; }

  // dribble glue
  glueTo(ownerPos: THREE.Vector3, facing: number, ownerVel: THREE.Vector3) {
    const fx = Math.cos(facing), fz = -Math.sin(facing);
    this.pos.set(ownerPos.x + fx * 0.48, CONFIG.ball.radius, ownerPos.z + fz * 0.48);
    this.vel.copy(ownerVel);
  }

  step(dt: number, ownerPos?: THREE.Vector3, ownerFacing?: number, ownerVel?: THREE.Vector3) {
    this.prevPos.copy(this.pos);
    this.kickAge += dt;
    if (this.possessedBy !== null && ownerPos !== undefined && ownerFacing !== undefined && ownerVel !== undefined) {
      this.glueTo(ownerPos, ownerFacing, ownerVel);
    } else {
      stepBallPhysics(this, dt, this.surface);
    }
    this.mesh.position.copy(this.pos);
    this.spinVisual += this.vel.length() * dt * 6;
    this.mesh.rotation.set(this.spinVisual * 0.4, 0, -this.spinVisual * 0.3);
    this.shadow.position.set(this.pos.x, 0.021, this.pos.z);
    const h = THREE.MathUtils.clamp(this.pos.y / 3, 0, 1);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.28 * (1 - h * 0.7);
    this.shadow.scale.setScalar(1 + h * 0.8);
  }
}
