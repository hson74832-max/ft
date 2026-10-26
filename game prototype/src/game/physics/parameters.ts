// ============================================================
// Football physics parameter dataset
// ============================================================
//
// Every quantity the ball model reads lives here, in SI units, with the
// `[mean, min, max]` declaration, the sampling mode and its provenance taken from
// the football-physics specification. `Source` distinguishes official laws
// (OFFICIAL / LAW) from calculated values (CALCULATED / LAW_DERIVED) and from
// gameplay estimates (MODEL / ESTIMATE) — the engine treats a law differently from
// an estimate: a law is clamped, an estimate may be sampled.
//
// Modes
//   CLAMP           the mean is used; the range is a sanity bound, never a randomiser
//                   (gravity, ball mass, the dead-ball threshold, …)
//   UNIFORM         sampled uniformly inside [min, max] with the seeded stream
//   TRUNCATED_NORMAL sampled from a normal around `mean` (σ = (max-min)/6), truncated
//                   to [min, max]
//   NONE            no randomisation, no clamp — a plain model constant
//
// `sampleParam()` is the only randomiser: it takes the caller's SeededRandom, so the
// same match seed always produces the same physics.
import { SeededRandom } from "../random";

export type ParamMode = "CLAMP" | "UNIFORM" | "TRUNCATED_NORMAL" | "NONE";
export type ParamSource =
  | "OFFICIAL" | "LAW" | "LAW_DERIVED" | "RESEARCH" | "OBS"
  | "CALCULATED" | "MODEL" | "MODEL_DERIVED" | "ESTIMATE";

export interface ParamSpec {
  /** Unit (SI) and, where useful, the human-readable equivalent. */
  unit: string;
  mean: number;
  min: number;
  max: number;
  mode: ParamMode;
  source: ParamSource;
  note: string;
}

const spec = (
  unit: string, mean: number, min: number, max: number,
  mode: ParamMode, source: ParamSource, note: string,
): ParamSpec => ({ unit, mean, min, max, mode, source, note });

/** Core model / ball constants (the first table of the specification). */
export const CORE_PHYSICS: Record<string, ParamSpec> = {
  physics_tick: spec("s", 0.0167, 0.0083, 0.0333, "CLAMP", "CALCULATED", "60 Hz recommended; 120 Hz more accurate; 30 Hz the slowest acceptable. The engine integrates at 120 Hz."),
  gravity: spec("m/s²", 9.81, 9.70, 9.90, "CLAMP", "CALCULATED", "Earth surface gravity, environmental variation only — not a gameplay randomiser."),
  air_density: spec("kg/m³", 1.20, 1.05, 1.30, "CLAMP", "RESEARCH", "Sea level, normal temperature. Adjust for altitude, heat, cold, humidity."),
  ball_mass: spec("kg", 0.430, 0.410, 0.450, "CLAMP", "OFFICIAL", "FIFA/IFAB size 5 match ball mass at the start of the match."),
  ball_circumference: spec("m", 0.690, 0.680, 0.700, "CLAMP", "OFFICIAL", "Legal circumference range."),
  ball_radius: spec("m", 0.109, 0.108, 0.111, "CLAMP", "CALCULATED", "r = circumference / (2π)."),
  ball_diameter: spec("m", 0.219, 0.216, 0.223, "CLAMP", "CALCULATED", "Diameter derived from circumference."),
  ball_cross_section_area: spec("m²", 0.0373, 0.0366, 0.0390, "CLAMP", "CALCULATED", "A = πr²."),
  ball_volume: spec("m³", 0.00543, 0.00529, 0.00575, "CLAMP", "CALCULATED", "V = 4/3 πr³."),
  ball_mean_density: spec("kg/m³", 79.2, 71.3, 85.1, "CLAMP", "CALCULATED", "Mass ÷ volume over the legal mass and circumference ranges."),
  ball_pressure: spec("atm", 0.85, 0.60, 1.10, "CLAMP", "OFFICIAL", "Internal pressure at sea level; typical match value ≈ 0.85 atm."),
  ball_moment_of_inertia: spec("kg·m²", 0.00341, 0.00319, 0.00370, "CLAMP", "CALCULATED", "Thin-shell sphere: I = 2/3 m r²."),
  ball_rebound_height_steel: spec("m", 1.45, 1.35, 1.55, "CLAMP", "OFFICIAL", "First rebound from a 2.00 m drop onto steel (FIFA test)."),
  ball_rebound_height_grass: spec("m", 0.95, 0.70, 1.20, "CLAMP", "ESTIMATE", "Rebound on natural grass; lower than steel because grass absorbs energy."),

  drag_coefficient_low_speed: spec("ratio", 0.45, 0.40, 0.55, "TRUNCATED_NORMAL", "RESEARCH", "Cd below ≈10 m/s: high-drag regime."),
  drag_coefficient_transition: spec("ratio", 0.35, 0.30, 0.42, "TRUNCATED_NORMAL", "RESEARCH", "Cd around the drag-crisis transition."),
  drag_coefficient_high_speed: spec("ratio", 0.25, 0.20, 0.30, "TRUNCATED_NORMAL", "RESEARCH", "Cd above ≈15–20 m/s: low-drag regime."),
  drag_transition_speed: spec("m/s", 12.0, 10.0, 15.0, "CLAMP", "RESEARCH", "Speed region where Cd drops sharply."),
  drag_coefficient_knuckle: spec("ratio", 0.40, 0.30, 0.55, "UNIFORM", "ESTIMATE", "Effective Cd for unstable no-spin / tumbling flight."),

  spin_parameter_S: spec("ratio", 0.20, 0.00, 0.80, "CLAMP", "CALCULATED", "S = |ω| r / v (magnitude). Clamped before the lift calculation."),
  lift_coefficient_cl: spec("ratio", 0.0, 0.0, 0.32, "CLAMP", "ESTIMATE", "Cl = clamp(1.2·S, 0, 0.32) — practical Magnus approximation for football."),
  lift_coefficient_negligible: spec("ratio", 0.02, 0.00, 0.05, "CLAMP", "ESTIMATE", "Near-zero spin: Magnus effect weak."),
  lift_coefficient_low: spec("ratio", 0.10, 0.05, 0.15, "CLAMP", "ESTIMATE", "Low spin."),
  lift_coefficient_medium: spec("ratio", 0.20, 0.15, 0.25, "CLAMP", "ESTIMATE", "Medium spin."),
  lift_coefficient_high: spec("ratio", 0.30, 0.25, 0.35, "CLAMP", "ESTIMATE", "High spin."),

  magnus_acceleration_weak: spec("m/s²", 0.8, 0.2, 1.5, "UNIFORM", "ESTIMATE", "Weak Magnus effect."),
  magnus_acceleration_moderate: spec("m/s²", 2.5, 1.5, 4.0, "UNIFORM", "ESTIMATE", "Normal crosses, driven passes, controlled shots."),
  magnus_acceleration_strong: spec("m/s²", 5.0, 4.0, 7.0, "UNIFORM", "ESTIMATE", "Curled free kicks, chips, heavy-topspin shots."),
  magnus_acceleration_extreme: spec("m/s²", 7.5, 6.5, 10.0, "UNIFORM", "ESTIMATE", "Rare high-spin balls."),

  spin_decay_time_constant: spec("s", 3.0, 1.5, 5.0, "TRUNCATED_NORMAL", "RESEARCH", "Exponential spin-decay time constant. The engine uses the 1 s / 2 s anchors below (they are the measured pair; a 3 s constant implies 28% after 1 s and contradicts them)."),
  spin_decay_after_1s: spec("percent", 12, 5, 25, "TRUNCATED_NORMAL", "RESEARCH", "Spin lost in the first second of flight."),
  spin_decay_after_2s: spec("percent", 25, 10, 45, "TRUNCATED_NORMAL", "RESEARCH", "Spin lost in the first two seconds of flight (cross-check of the 1 s anchor)."),

  gyroscopic_stability_threshold: spec("rpm", 250, 150, 350, "CLAMP", "ESTIMATE", "Above this the spin axis is treated as stable."),
  wobble_threshold: spec("rpm", 100, 50, 180, "CLAMP", "ESTIMATE", "Below this the spin axis may wobble."),
  knuckle_instability_threshold: spec("rpm", 60, 0, 100, "CLAMP", "ESTIMATE", "Below this, enable knuckle / turbulent-wake behaviour."),
  knuckle_random_acceleration: spec("m/s²", 1.5, 0.3, 4.0, "UNIFORM", "ESTIMATE", "Random acceleration used to simulate unstable knuckle flight."),
  knuckle_lateral_jitter_20m: spec("m", 0.7, 0.2, 1.8, "UNIFORM", "ESTIMATE", "Sideways deviation over 20 m for knuckle balls."),
  knuckle_vertical_jitter_20m: spec("m", 0.6, 0.1, 1.5, "UNIFORM", "ESTIMATE", "Vertical deviation over 20 m for knuckle balls."),
  knuckle_late_drop_5m: spec("m", 0.8, 0.2, 2.0, "UNIFORM", "ESTIMATE", "Sudden vertical movement in the final 5 m."),

  backspin_range_extension: spec("percent", 8, 3, 15, "UNIFORM", "ESTIMATE", "Extra range compared with a similar no-spin ball."),
  topspin_range_reduction: spec("percent", 7, 2, 15, "UNIFORM", "ESTIMATE", "Reduced range compared with a similar no-spin ball."),
  sidespin_lateral_drift_20m: spec("m", 1.2, 0.3, 3.0, "UNIFORM", "ESTIMATE", "Lateral movement from sidespin over 20 m."),
  backspin_vertical_drift_20m: spec("m", 0.9, 0.2, 2.0, "UNIFORM", "ESTIMATE", "Extra height / float from backspin over 20 m."),
  topspin_vertical_drop_20m: spec("m", 1.0, 0.3, 2.5, "UNIFORM", "ESTIMATE", "Extra dip from topspin over 20 m."),

  terminal_velocity_falling: spec("m/s", 24.0, 19.0, 28.0, "CLAMP", "CALCULATED", "Maximum steady falling speed (≈68–101 km/h)."),
  maximum_useful_flight_speed: spec("m/s", 32.0, 28.0, 36.0, "CLAMP", "RESEARCH", "Upper realistic speed for hard shots and long kicks."),
  minimum_meaningful_flight_speed: spec("m/s", 3.0, 1.5, 5.0, "CLAMP", "ESTIMATE", "Below this the ball is rolling, loose or dead rather than flying."),

  spin_band_none: spec("rpm", 20, 0, 80, "UNIFORM", "ESTIMATE", "No-spin / knuckle band."),
  spin_band_low: spec("rpm", 130, 80, 250, "UNIFORM", "ESTIMATE", "Low-spin band."),
  spin_band_medium: spec("rpm", 300, 250, 450, "UNIFORM", "ESTIMATE", "Medium-spin band."),
  spin_band_high: spec("rpm", 550, 450, 750, "UNIFORM", "ESTIMATE", "High-spin band."),
  spin_band_extreme: spec("rpm", 800, 750, 1000, "UNIFORM", "ESTIMATE", "Extreme-spin band; use sparingly."),

  ball_compression_strike: spec("cm", 2.0, 1.0, 4.0, "UNIFORM", "ESTIMATE", "Temporary deformation during a foot, head or ground strike."),
  pressure_spike_strike: spec("atm", 1.8, 1.2, 2.5, "UNIFORM", "ESTIMATE", "Short-lived internal pressure rise during deformation."),
  strike_energy_loss: spec("percent", 25, 15, 40, "UNIFORM", "ESTIMATE", "Energy lost to deformation, sound, heat and imperfect contact."),
  foot_ball_contact_time: spec("ms", 12, 8, 18, "TRUNCATED_NORMAL", "RESEARCH", "Contact duration for a kicked ball."),
  head_ball_contact_time: spec("ms", 8, 5, 15, "UNIFORM", "ESTIMATE", "Contact duration for a headed ball."),
  ground_ball_contact_time: spec("ms", 8, 5, 15, "TRUNCATED_NORMAL", "RESEARCH", "Contact duration for a ball–ground impact."),

  bounce_restitution_dry_grass: spec("ratio", 0.65, 0.55, 0.75, "TRUNCATED_NORMAL", "RESEARCH", "Vertical rebound coefficient, dry firm natural grass."),
  bounce_restitution_wet_grass: spec("ratio", 0.50, 0.40, 0.60, "TRUNCATED_NORMAL", "RESEARCH", "Vertical rebound coefficient, wet soft grass."),
  bounce_restitution_artificial_turf: spec("ratio", 0.72, 0.62, 0.85, "TRUNCATED_NORMAL", "RESEARCH", "Vertical rebound coefficient, artificial turf."),
  bounce_restitution_divot: spec("ratio", 0.55, 0.35, 0.75, "UNIFORM", "ESTIMATE", "Irregular bounce on broken or uneven ground."),
  tangential_friction_dry_grass: spec("ratio", 0.35, 0.25, 0.50, "TRUNCATED_NORMAL", "RESEARCH", "Surface grip during a bounce, dry grass."),
  tangential_friction_wet_grass: spec("ratio", 0.20, 0.10, 0.35, "TRUNCATED_NORMAL", "RESEARCH", "Reduced grip on wet grass."),
  tangential_friction_artificial_turf: spec("ratio", 0.45, 0.30, 0.60, "TRUNCATED_NORMAL", "RESEARCH", "Higher grip on artificial turf."),
  spin_loss_during_bounce: spec("percent", 35, 20, 60, "UNIFORM", "ESTIMATE", "Rotational energy lost during ground impact."),
  topspin_bounce_forward_gain: spec("percent", 8, 0, 15, "UNIFORM", "ESTIMATE", "Topspin increases forward speed after the bounce."),
  topspin_bounce_angle_change: spec("degrees", -4, -8, -1, "UNIFORM", "ESTIMATE", "Topspin lowers the rebound angle."),
  topspin_bounce_spin_change: spec("percent", -30, -50, -15, "UNIFORM", "ESTIMATE", "Topspin decreases but stays forward-rotating."),
  backspin_bounce_forward_loss: spec("percent", -20, -40, -5, "UNIFORM", "ESTIMATE", "Backspin checks forward speed after the bounce."),
  backspin_bounce_angle_change: spec("degrees", 5, 2, 10, "UNIFORM", "ESTIMATE", "Backspin raises the rebound angle slightly."),
  backspin_bounce_spin_change: spec("percent", -45, -70, -25, "UNIFORM", "ESTIMATE", "Backspin decreases and may reverse."),
  backspin_reversal_threshold: spec("rpm", 450, 300, 700, "CLAMP", "ESTIMATE", "Strong enough backspin can stop or roll the ball backwards after a bounce."),
  sidespin_bounce_lateral_kick: spec("m/s", 0.6, 0.2, 1.5, "UNIFORM", "ESTIMATE", "Sideways velocity added or removed by friction during the bounce."),
  sidespin_bounce_direction_error: spec("degrees", 4, 0, 12, "UNIFORM", "ESTIMATE", "Extra lateral deviation from grass irregularity."),
  knuckle_bounce_lateral_error: spec("m/s", 0.5, 0.1, 1.2, "UNIFORM", "ESTIMATE", "Random sideways bounce error for low-spin balls."),
  knuckle_bounce_vertical_error: spec("m/s", 0.4, 0.0, 1.0, "UNIFORM", "ESTIMATE", "Random vertical bounce error for low-spin balls."),
  bounce_flight_continuation_threshold: spec("m/s", 1.0, 0.5, 2.0, "CLAMP", "ESTIMATE", "If the rebound speed is above this, continue in the flight state."),
  bounce_slope_sensitivity: spec("deg/deg slope", 0.8, 0.5, 1.2, "UNIFORM", "ESTIMATE", "Rebound angle change per degree of ground slope."),
  bounce_grain_sensitivity: spec("degrees", 3, 0, 10, "UNIFORM", "ESTIMATE", "Direction error from grass grain or mowing direction."),
  bounce_wet_patch_speed_loss: spec("percent", 15, 5, 30, "UNIFORM", "RESEARCH", "Extra energy loss on wet patches."),
  bounce_divot_direction_error: spec("percent", 20, 5, 50, "UNIFORM", "ESTIMATE", "Direction uncertainty on broken ground."),
  bounce_high_speed_deformation: spec("cm", 3.0, 1.5, 5.0, "UNIFORM", "ESTIMATE", "Ball deformation during a hard ground impact."),
  bounce_high_speed_variance: spec("percent", 25, 10, 45, "UNIFORM", "ESTIMATE", "Extra randomness for fast, heavy bounces."),

  rolling_resistance_dry_grass: spec("ratio", 0.10, 0.06, 0.15, "TRUNCATED_NORMAL", "RESEARCH", "Rolling resistance coefficient, dry natural grass."),
  rolling_resistance_wet_grass: spec("ratio", 0.14, 0.10, 0.22, "TRUNCATED_NORMAL", "RESEARCH", "Rolling resistance coefficient, wet grass."),
  rolling_resistance_artificial_turf: spec("ratio", 0.07, 0.04, 0.11, "TRUNCATED_NORMAL", "RESEARCH", "Rolling resistance coefficient, artificial turf."),
  rolling_deceleration_dry_grass: spec("m/s²", 1.0, 0.6, 1.5, "CLAMP", "CALCULATED", "μ_roll · g."),
  rolling_deceleration_wet_grass: spec("m/s²", 1.4, 1.0, 2.2, "CLAMP", "CALCULATED", "μ_roll · g."),
  rolling_spin_decay_time: spec("s", 2.0, 1.0, 4.0, "UNIFORM", "ESTIMATE", "Time scale for the spin to approach the pure rolling condition."),
  topspin_roll_forward_gain: spec("percent", 10, 0, 20, "UNIFORM", "ESTIMATE", "Topspin can convert rotation into forward speed while rolling."),
  backspin_roll_forward_loss: spec("percent", -25, -45, -10, "UNIFORM", "ESTIMATE", "Backspin slows a rolling ball."),
  backspin_stop_distance: spec("m", 3.0, 1.0, 8.0, "UNIFORM", "ESTIMATE", "Distance before a strongly backspun ball stops or reverses."),
  neutral_roll_distance_from_5_m_s: spec("m", 12.0, 7.0, 20.0, "UNIFORM", "CALCULATED", "v² / (2a) with the dry-grass rolling deceleration."),
  neutral_roll_distance_from_8_m_s: spec("m", 32.0, 18.0, 55.0, "UNIFORM", "CALCULATED", "v² / (2a)."),
  neutral_roll_distance_from_12_m_s: spec("m", 72.0, 40.0, 120.0, "UNIFORM", "CALCULATED", "v² / (2a)."),
  side_roll_curvature_10m: spec("m", 0.35, 0.05, 1.0, "UNIFORM", "ESTIMATE", "Sideways steering while rolling; weaker than aerial sidespin drift."),
  roll_grain_sensitivity: spec("degrees", 2, 0, 8, "UNIFORM", "ESTIMATE", "Roll direction error from grass grain."),
  roll_slope_acceleration: spec("m/s²", 1.7, 0.5, 3.0, "UNIFORM", "ESTIMATE", "Gravity component along the slope."),
  roll_wet_patch_distance_loss: spec("percent", 20, 10, 40, "UNIFORM", "ESTIMATE", "Reduced roll distance on wet patches."),
  roll_divot_direction_error: spec("percent", 25, 5, 60, "UNIFORM", "ESTIMATE", "Roll direction uncertainty on uneven ground."),

  dead_ball_threshold: spec("m/s", 0.3, 0.1, 0.6, "CLAMP", "ESTIMATE", "Below this speed the ball is stopped or dead."),
  player_control_window_after_bounce: spec("s", 0.4, 0.15, 0.9, "UNIFORM", "ESTIMATE", "Realistic time before the next controlled touch."),
  flight_activation_threshold: spec("m/s", 1.5, 1.0, 2.5, "CLAMP", "ESTIMATE", "Ball leaves the surface faster than this → flight state."),
  bounce_activation_threshold: spec("m/s", 0.8, 0.3, 1.5, "CLAMP", "ESTIMATE", "Vertical speed toward the ground above which a bounce is processed."),
  roll_activation_threshold: spec("m/s", 1.0, 0.5, 2.0, "CLAMP", "ESTIMATE", "After a bounce, low speed with ground contact → roll state."),
  knuckle_mode_trigger: spec("rpm", 60, 0, 100, "CLAMP", "ESTIMATE", "Enable knuckle / random-wake mode below this spin."),
  stable_spin_mode_trigger: spec("rpm", 250, 150, 350, "CLAMP", "ESTIMATE", "Use a stable Magnus axis above this spin."),
  wobble_mode_trigger: spec("rpm", 120, 50, 200, "CLAMP", "ESTIMATE", "Allow spin-axis drift in this band."),
  magnus_ignore_threshold: spec("ratio", 0.03, 0.00, 0.05, "CLAMP", "ESTIMATE", "Below this S the Magnus force may be ignored."),
  magnus_weak_threshold: spec("ratio", 0.10, 0.05, 0.15, "CLAMP", "ESTIMATE", "Use a weak lateral/vertical Magnus force."),
  magnus_strong_threshold: spec("ratio", 0.25, 0.15, 0.35, "CLAMP", "ESTIMATE", "Use the full curve/lift/dip Magnus force."),
  drag_regime_low_speed: spec("m/s", 10.0, 8.0, 12.0, "CLAMP", "ESTIMATE", "Use the high drag coefficient below this."),
  drag_regime_high_speed: spec("m/s", 20.0, 15.0, 25.0, "CLAMP", "ESTIMATE", "Use the low drag coefficient above this."),
};

const num = (name: string) => CORE_PHYSICS[name]?.mean;

/**
 * Ball geometry derived strictly from the legal ranges, not hard-coded.
 * r = C / 2π, A = πr², V = 4/3πr³, ρ̄ = m/V, I = 2/3 m r².
 */
export const BALL_GEOMETRY = (() => {
  const circumference = num("ball_circumference");
  const radius = circumference / (2 * Math.PI);
  const mass = num("ball_mass");
  const area = Math.PI * radius * radius;
  const volume = (4 / 3) * Math.PI * Math.pow(radius, 3);
  return {
    circumference,
    radius,
    diameter: radius * 2,
    mass,
    area,
    volume,
    meanDensity: mass / volume,
    inertia: (2 / 3) * mass * radius * radius,
    /** Contact-point slip inertia factor for a thin shell: 1 / (1 + m r² / I). */
    slipFactor: 1 / (1 + (mass * radius * radius) / ((2 / 3) * mass * radius * radius)),
  };
})();

export type SurfaceKind = "dry" | "wet" | "artificial" | "divot";

/** Surface-selected coefficients: the pitch is not one rigid material. */
export const SURFACES: Record<SurfaceKind, {
  restitution: string; friction: string; rolling: string; note: string;
}> = {
  dry: { restitution: "bounce_restitution_dry_grass", friction: "tangential_friction_dry_grass", rolling: "rolling_resistance_dry_grass", note: "Dry firm natural grass (default)." },
  wet: { restitution: "bounce_restitution_wet_grass", friction: "tangential_friction_wet_grass", rolling: "rolling_resistance_wet_grass", note: "Wet, soft grass: lower bounce, higher rolling resistance." },
  artificial: { restitution: "bounce_restitution_artificial_turf", friction: "tangential_friction_artificial_turf", rolling: "rolling_resistance_artificial_turf", note: "Artificial turf: livelier bounce, more grip." },
  divot: { restitution: "bounce_restitution_divot", friction: "tangential_friction_dry_grass", rolling: "rolling_resistance_dry_grass", note: "Broken or uneven ground: irregular bounce." },
};

/** Truncated normal draw inside [min, max] (σ = (max-min)/6). */
export function truncatedNormal(rng: SeededRandom, mean: number, min: number, max: number): number {
  const sd = Math.max(1e-6, (max - min) / 6);
  for (let i = 0; i < 8; i++) {
    const u = Math.max(1e-9, Math.min(1 - 1e-9, rng.next()));
    const v = Math.max(1e-9, Math.min(1 - 1e-9, rng.next()));
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const value = mean + z * sd;
    if (value >= min && value <= max) return value;
  }
  return Math.max(min, Math.min(max, mean));
}

/** One deterministic draw from a parameter declaration, using the caller's stream. */
export function sampleParam(s: ParamSpec, rng: SeededRandom, scale = 1): number {
  switch (s.mode) {
    case "UNIFORM": return (s.min + (s.max - s.min) * rng.next()) * scale;
    case "TRUNCATED_NORMAL": return truncatedNormal(rng, s.mean, s.min, s.max) * scale;
    case "CLAMP": return Math.max(s.min, Math.min(s.max, s.mean)) * scale;
    default: return s.mean * scale;
  }
}

/** Clamp-only read (mean inside the declared bounds) — no randomisation. */
export function param(name: string): number {
  const s = CORE_PHYSICS[name];
  if (!s) throw new Error(`Unknown physics parameter '${name}'`);
  return Math.max(s.min, Math.min(s.max, s.mean));
}

/** The physics tick the ball integrates on (120 Hz — see `physics_tick`). */
export const PHYSICS_TICK = 1 / 120;
export const MAX_PHYSICS_SUBSTEPS = 8;
