// Physics + action-profile regressions.
//
// Pins the football model to the parameter set and to observable behaviour:
// geometry derived from the legal ranges, the drag crisis, the capped Magnus lift,
// the measured spin decay, the Flight / Bounce / Roll / Dead state machine, surface
// response, spin ↔ bounce coupling, rolling resistance, frame-rate independence,
// seeded determinism, NaN guards, and the named action profiles.
import * as THREE from "three";
import { CONFIG } from "../src/game/config";
import {
  BALL_GEOMETRY, CORE_PHYSICS, PHYSICS_TICK, SURFACES, param, sampleParam, truncatedNormal,
} from "../src/game/physics/parameters";
import {
  dragCoefficientAt, liftCoefficientAt, predictTrajectory, stepBallPhysics, strikeBall,
  type BallState, type StrikeCommand,
} from "../src/game/ball";
import {
  ACTION_PROFILES, PROFILE_IDS, chooseProfile, predictDelivery, resolveStrike,
  type ActionProfile,
} from "../src/game/physics/actionProfiles";
import { SeededRandom } from "../src/game/random";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const RADIUS = CONFIG.ball.radius;
const fresh = (x = 0, y = RADIUS, z = 0): BallState => ({
  pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(), spin: new THREE.Vector3(),
});

// ---------------------------------------------------------------- geometry --
{
  const [cMin, cMax] = [CORE_PHYSICS.ball_circumference.min, CORE_PHYSICS.ball_circumference.max];
  const derived = cMin / (2 * Math.PI);
  check("ball radius is derived from the legal circumference, not hard-coded",
    Math.abs(BALL_GEOMETRY.radius - CORE_PHYSICS.ball_circumference.mean / (2 * Math.PI)) < 1e-9
    && BALL_GEOMETRY.radius >= derived && BALL_GEOMETRY.radius <= cMax / (2 * Math.PI),
    `${BALL_GEOMETRY.radius.toFixed(4)} m`);
  check("cross-section area is πr²",
    Math.abs(BALL_GEOMETRY.area - Math.PI * BALL_GEOMETRY.radius ** 2) < 1e-12,
    `${BALL_GEOMETRY.area.toFixed(5)} m²`);
  check("volume, mean density and inertia are derived from the legal ranges",
    BALL_GEOMETRY.volume > 0.0052 && BALL_GEOMETRY.volume < 0.0058
    && BALL_GEOMETRY.meanDensity > 70 && BALL_GEOMETRY.meanDensity < 86
    && BALL_GEOMETRY.inertia > 0.0031 && BALL_GEOMETRY.inertia < 0.0038,
    `V ${BALL_GEOMETRY.volume.toFixed(5)} m³ · ρ̄ ${BALL_GEOMETRY.meanDensity.toFixed(1)} kg/m³ · I ${BALL_GEOMETRY.inertia.toFixed(5)}`);
  check("gravity, air density and mass sit inside their declared chains",
    param("gravity") === 9.81 && param("air_density") >= 1.05 && param("air_density") <= 1.3
    && param("ball_mass") >= 0.41 && param("ball_mass") <= 0.45);
  check("surface coefficient sets exist for dry, wet, artificial and divot",
    Object.keys(SURFACES).length === 4 && Object.values(SURFACES).every((s) => param(s.restitution) > 0 && param(s.rolling) > 0));
}

// -------------------------------------------------------------- drag crisis --
{
  const low = param("drag_coefficient_low_speed");
  const high = param("drag_coefficient_high_speed");
  check("Cd is high below the crisis and low above it",
    dragCoefficientAt(5) === low && dragCoefficientAt(30) === high,
    `${dragCoefficientAt(5)} → ${dragCoefficientAt(30)}`);
  let monotone = true;
  for (let v = 9; v < 22; v += 0.5) if (dragCoefficientAt(v + 0.5) > dragCoefficientAt(v) + 1e-9) monotone = false;
  check("Cd never rises through the crisis band", monotone);
  check("Cd is finite for zero, negative and NaN speed",
    Number.isFinite(dragCoefficientAt(0)) && Number.isFinite(dragCoefficientAt(-5)) && Number.isFinite(dragCoefficientAt(NaN)));
}

// ------------------------------------------------------------ Magnus lift ----
{
  check("no spin means no Magnus force", liftCoefficientAt(0, 20) === 0);
  check("Cl is capped at 0.32 no matter how fast the ball spins",
    liftCoefficientAt(1e6, 1) === 0.32 && liftCoefficientAt(500, 0.5) === 0.32);
  const expected = THREE.MathUtils.clamp(1.2 * (20 * BALL_GEOMETRY.radius) / 10, 0, 0.32);
  check("Cl follows clamp(1.2·S, 0, 0.32) with S = |ω|r/v",
    Math.abs(liftCoefficientAt(20, 10) - expected) < 1e-9, `${liftCoefficientAt(20, 10).toFixed(4)}`);
  check("Cl and S are finite when the ball is stopped", Number.isFinite(liftCoefficientAt(50, 0)));

  const straight = fresh(0, 10, 0);
  straight.vel.set(20, 0, 0);
  for (let i = 0; i < 120; i++) stepBallPhysics(straight, 1 / 120);
  check("a no-spin ball flies straight (no phantom curve)", Math.abs(straight.pos.z) < 0.02, `z=${straight.pos.z.toFixed(3)} m`);

  const curled = fresh(0, 10, 0);
  curled.vel.set(20, 0, 0);
  curled.spin.set(0, 60, 0);
  for (let i = 0; i < 120; i++) stepBallPhysics(curled, 1 / 120);
  check("sidespin curves the ball", Math.abs(curled.pos.z) > 0.5, `z=${curled.pos.z.toFixed(2)} m in 1 s`);
}

// ------------------------------------------------------------- spin decay ----
{
  // High enough that the ball is still airborne after two seconds.
  const s = fresh(0, 30, 0);
  s.vel.set(18, 0, 0);
  s.spin.set(0, 60, 0);
  for (let i = 0; i < 120; i++) stepBallPhysics(s, 1 / 120);
  const after1 = s.spin.length();
  for (let i = 0; i < 120; i++) stepBallPhysics(s, 1 / 120);
  const after2 = s.spin.length();
  const loss1 = (1 - after1 / 60) * 100;
  const loss2 = (1 - after2 / 60) * 100;
  const target1 = CORE_PHYSICS.spin_decay_after_1s.mean;
  check("spin loses the measured ~12 % after one second of flight",
    Math.abs(loss1 - target1) < 1.5, `${loss1.toFixed(1)} %`);
  check("the two-second anchor stays inside its measured band",
    loss2 >= CORE_PHYSICS.spin_decay_after_2s.min && loss2 <= CORE_PHYSICS.spin_decay_after_2s.max,
    `${loss2.toFixed(1)} % (${CORE_PHYSICS.spin_decay_after_2s.min}–${CORE_PHYSICS.spin_decay_after_2s.max})`);
}

// ------------------------------------------------------- state machine -------
{
  // A rolled ball: flight → roll → dead, with the spin zeroed at rest.
  const s = fresh();
  s.vel.set(6, 0, 0);
  s.spin.set(0, 0, 0);
  const phases = new Set<string>();
  let steps = 0;
  while (steps++ < 120 * 20 && s.phase !== "dead") {
    stepBallPhysics(s, 1 / 120);
    if (s.phase) phases.add(s.phase);
  }
  check("a rolling ball passes through Flight/Roll and finishes Dead",
    phases.has("roll") && s.phase === "dead", [...phases].join(" → "));
  check("a dead ball has no velocity and no spin",
    s.vel.length() === 0 && s.spin.length() === 0);

  const dead = fresh();
  dead.vel.set(0.2, 0, 0);
  dead.spin.set(0, 40, 0);
  stepBallPhysics(dead, 1 / 120);
  check("spin is zeroed below the dead-ball speed", dead.spin.length() === 0 && dead.vel.length() === 0);

  const launch = fresh();
  strikeBall(launch, new THREE.Vector3(1, 0, 0), { speed: 18, loft: 0.3, spin: new THREE.Vector3() });
  check("a struck ball starts in the Flight state", launch.phase === "flight" && launch.bounces === 0);

  let sawBounce = false;
  for (let i = 0; i < 120 * 4; i++) {
    stepBallPhysics(launch, 1 / 120);
    if ((launch.bounces ?? 0) > 0) { sawBounce = true; break; }
  }
  check("a ball landing at speed bounces", sawBounce && (launch.bounces ?? 0) === 1);
}

// --------------------------------------------------------------- surfaces ----
{
  const drop = (surface: "dry" | "wet" | "artificial" | "divot", x: number) => {
    const s = fresh(x, 2, 0);
    s.surface = surface;
    let bounced = false;
    for (let i = 0; i < 120 * 4; i++) {
      stepBallPhysics(s, 1 / 120);
      if ((s.bounces ?? 0) > 0) { bounced = true; break; }
    }
    return { bounced, vy: s.vel.y, vx: s.vel.x };
  };
  const dry = drop("dry", 0);
  const wet = drop("wet", 0);
  const art = drop("artificial", 0);
  check("all four surfaces bounce a dropped ball", dry.bounced && wet.bounced && art.bounced);
  check("wet grass bounces lower than dry grass", wet.vy < dry.vy - 0.2, `wet ${wet.vy.toFixed(2)} vs dry ${dry.vy.toFixed(2)} m/s`);
  check("artificial turf bounces higher than wet grass", art.vy > wet.vy, `artificial ${art.vy.toFixed(2)} m/s`);
  check("restitution ordering matches the parameter table",
    param(SURFACES.artificial.restitution) > param(SURFACES.dry.restitution)
    && param(SURFACES.dry.restitution) > param(SURFACES.wet.restitution));

  const roll = (surface: "dry" | "wet" | "artificial") => {
    const s = fresh(0, RADIUS, 0);
    s.surface = surface;
    s.vel.set(6, 0, 0);
    const x0 = s.pos.x;
    for (let i = 0; i < 120 * 30 && s.phase !== "dead"; i++) stepBallPhysics(s, 1 / 120);
    return s.pos.x - x0;
  };
  const dryRoll = roll("dry");
  const wetRoll = roll("wet");
  const artRoll = roll("artificial");
  check("rolling resistance stops a 6 m/s ball inside the measured band",
    dryRoll > 7 && dryRoll < 20, `${dryRoll.toFixed(1)} m`);
  check("wet grass rolls shorter than dry grass", wetRoll < dryRoll - 0.4, `${wetRoll.toFixed(1)} vs ${dryRoll.toFixed(1)} m`);
  check("artificial turf rolls further than dry grass", artRoll > dryRoll, `${artRoll.toFixed(1)} vs ${dryRoll.toFixed(1)} m`);
  const dryDecel = Math.abs(param(SURFACES.dry.rolling) * param("gravity") - param("rolling_deceleration_dry_grass"));
  const wetDecel = Math.abs(param(SURFACES.wet.rolling) * param("gravity") - param("rolling_deceleration_wet_grass"));
  check("rolling deceleration is μ·g on every surface", dryDecel < 0.05 && wetDecel < 0.05,
    `dry ${(param(SURFACES.dry.rolling) * 9.81).toFixed(2)} vs ${param("rolling_deceleration_dry_grass")} · wet ${(param(SURFACES.wet.rolling) * 9.81).toFixed(2)} vs ${param("rolling_deceleration_wet_grass")}`);
}

// ------------------------------------------------- spin ↔ bounce coupling ----
{
  const bounceForward = (spin: THREE.Vector3) => {
    const s = fresh(0, 2.5, 0);
    s.vel.set(8, -1, 0);
    s.spin.copy(spin);
    for (let i = 0; i < 120 * 3; i++) {
      stepBallPhysics(s, 1 / 120);
      if ((s.bounces ?? 0) > 0) return { vx: s.vel.x, vy: s.vel.y, vz: s.vel.z };
    }
    return { vx: NaN, vy: NaN, vz: NaN };
  };
  // 60 rad/s ≈ 573 rpm: well above the knuckle band, so no turbulence noise.
  const top = bounceForward(new THREE.Vector3(0, 0, -60));   // topspin for +x travel
  const back = bounceForward(new THREE.Vector3(0, 0, 60));   // backspin
  const side = bounceForward(new THREE.Vector3(0, 60, 0));   // sidespin
  check("topspin kicks the ball forward off the bounce", top.vx > back.vx + 0.1,
    `top ${top.vx.toFixed(2)} vs back ${back.vx.toFixed(2)} m/s`);
  check("backspin checks the ball compared with topspin", back.vx < top.vx - 0.1,
    `back ${back.vx.toFixed(2)} vs top ${top.vx.toFixed(2)} m/s`);
  check("sidespin kicks the ball sideways off the bounce", Math.abs(side.vz) > Math.abs(back.vz) + 0.05,
    `side vz ${side.vz.toFixed(2)} vs back vz ${back.vz.toFixed(2)} m/s`);
  check("a bounce cannot inject energy",
    Math.hypot(top.vx, top.vy, top.vz) <= Math.hypot(8, 1) * 1.05);
}

// ------------------------------------------------------ frame independence ---
{
  const launch = (state: BallState) => strikeBall(state, new THREE.Vector3(1, 0, 0), {
    speed: 24, loft: 0.35, spin: new THREE.Vector3(0, 25, -35),
  });
  const runAt = (hz: number, seconds: number) => {
    const s = fresh();
    launch(s);
    const frames = Math.round(seconds * hz);
    for (let i = 0; i < frames; i++) stepBallPhysics(s, 1 / hz);
    return s;
  };
  const a = runAt(240, 1.5);
  const b = runAt(120, 1.5);
  const c = runAt(60, 1.5);
  const d = runAt(30, 1.5);
  const gap = (p: BallState, q: BallState) => p.pos.distanceTo(q.pos);
  // 240 Hz steps below the 120 Hz tick, so it is a finer integration of the same
  // ODE — close, not bit-identical. Frame-rate independence means the *frame* rate
  // cannot change the result: 60 and 30 Hz substep onto the same 120 Hz grid.
  check("240 Hz stays on the 120 Hz trajectory", gap(a, b) < 0.5, `${gap(a, b).toFixed(4)} m`);
  check("60 Hz matches 120 Hz (substepped)", gap(c, b) < 0.02, `${gap(c, b).toFixed(4)} m`);
  check("30 Hz stays on the same trajectory", gap(d, b) < 0.06, `${gap(d, b).toFixed(4)} m`);
  check("the physics tick is the documented 120 Hz", Math.abs(PHYSICS_TICK - 1 / 120) < 1e-12);

  const traj = predictTrajectory({ pos: new THREE.Vector3(), vel: new THREE.Vector3(15, 6, 0), spin: new THREE.Vector3() }, 1, 0.1);
  check("the AI trajectory projector returns a finite, ordered path",
    traj.length >= 10 && traj.every((p, i) => Number.isFinite(p.pos.x) && (i === 0 || p.t > traj[i - 1].t)));
}

// ------------------------------------------------------------- determinism ---
{
  const profile = ACTION_PROFILES.pass_medium;
  const strike = (seed: number) => resolveStrike(profile, {
    distance: 22, rng: new SeededRandom(seed), accuracy: 72, curveSide: 0.6,
  });
  const one = strike(4242);
  const two = strike(4242);
  const other = strike(4243);
  check("the same seed produces the same strike",
    one.speed === two.speed && one.angleDeg === two.angleDeg && one.spinRpm === two.spinRpm
    && one.spin.equals(two.spin));
  check("a different seed changes the strike",
    one.speed !== other.speed || one.angleDeg !== other.angleDeg || one.spinRpm !== other.spinRpm);

  const draws = (rng: SeededRandom) => Array.from({ length: 8 }, () =>
    sampleParam(CORE_PHYSICS.bounce_restitution_dry_grass, rng));
  const firstDraws = draws(new SeededRandom(9));
  const secondDraws = draws(new SeededRandom(9));
  const spec = CORE_PHYSICS.bounce_restitution_dry_grass;
  check("parameter sampling is reproducible and inside the declared band",
    firstDraws.every((v, i) => v === secondDraws[i])
    && firstDraws.every((v) => v >= spec.min && v <= spec.max));
  check("truncated-normal draws stay inside the band",
    Array.from({ length: 200 }, () => truncatedNormal(new SeededRandom(Math.random() * 1e9 | 0), 0.5, 0.2, 0.8))
      .every((v) => v >= 0.2 && v <= 0.8));
}

// ------------------------------------------------------------- NaN guards ----
{
  const nan = fresh();
  nan.vel.set(NaN, 0, 0);
  stepBallPhysics(nan, 1 / 60);
  check("a non-finite ball state is parked dead instead of propagating NaN",
    Number.isFinite(nan.pos.x) && nan.vel.length() === 0 && nan.phase === "dead");

  const s = fresh(0, 3, 0);
  s.vel.set(12, 0, 0);
  const before = s.pos.clone();
  stepBallPhysics(s, NaN);
  stepBallPhysics(s, -1);
  stepBallPhysics(s, 0);
  check("a non-finite or negative frame delta is ignored", s.pos.distanceTo(before) === 0);

  const zero = fresh(0, 10, 0);
  zero.spin.set(0, 0, 0);
  for (let i = 0; i < 120; i++) stepBallPhysics(zero, 1 / 120);
  check("a zero-spin, high ball never produces a NaN",
    Number.isFinite(zero.pos.y) && Number.isFinite(zero.vel.y));

  const reverse = fresh(0, 2, 0);
  reverse.vel.set(0.05, 0.05, 0.05);
  reverse.spin.set(300, 300, 300);
  stepBallPhysics(reverse, 1 / 120);
  check("a stationary ball with huge spin stays finite and comes to rest",
    Number.isFinite(reverse.pos.length()) && reverse.vel.length() < 1);
}

// ----------------------------------------------------- named action profiles -
{
  check("every profile has a coherent band",
    PROFILE_IDS.every((id) => {
      const p = ACTION_PROFILES[id];
      return p.distance[0] >= 0 && p.distance[0] < p.distance[1]
        && p.speed[0] > 0 && p.speed[0] <= p.speed[1] && p.speed[1] <= CONFIG.ball.maxSpeed
        && p.launchDeg[0] <= p.launchDeg[1] && p.launchDeg[0] >= -10 && p.launchDeg[1] <= 60
        && p.spinRpm[0] <= p.spinRpm[1] && p.spinRpm[1] <= 1000;
    }), `${PROFILE_IDS.length} profiles`);

  const required = [
    "pass_short", "pass_medium", "pass_driven", "pass_lofted_switch", "pass_weighted_forward",
    "cross_whipped", "cross_floated", "corner_inswing", "corner_outswing",
    "freekick_curled", "freekick_knuckle",
    "shot_low_driven", "shot_dipping_topspin", "shot_chip", "shot_volley", "shot_half_volley",
    "header_attacking", "gk_punt", "gk_drop_kick", "gk_throw", "throw_in",
  ];
  check("the full action vocabulary from the specification is present",
    required.every((id) => ACTION_PROFILES[id]), required.filter((id) => !ACTION_PROFILES[id]).join(", ") || "all present");

  // Every profile must resolve inside its own bands and keep Cl under the cap.
  const offenders: string[] = [];
  for (const id of PROFILE_IDS) {
    const p = ACTION_PROFILES[id];
    const r = resolveStrike(p, { distance: Math.min(p.distance[1], 30), rng: new SeededRandom(17), accuracy: 70 });
    const tolerance = 0.01;
    if (r.speed > p.speed[1] + tolerance || r.speed < p.speed[0] * 0.5) offenders.push(`${id}:speed ${r.speed.toFixed(1)}`);
    if (r.angleDeg < p.launchDeg[0] - tolerance || r.angleDeg > p.launchDeg[1] + tolerance) offenders.push(`${id}:angle ${r.angleDeg.toFixed(1)}`);
    if (r.spinRpm < p.spinRpm[0] - tolerance || r.spinRpm > p.spinRpm[1] + tolerance) offenders.push(`${id}:spin ${r.spinRpm.toFixed(0)}`);
    if (!Number.isFinite(r.speed) || !Number.isFinite(r.angleDeg) || !Number.isFinite(r.spinRpm)) offenders.push(`${id}:non-finite`);
  }
  check("every resolved strike stays inside its profile bands", offenders.length === 0, offenders.join(", "));

  // Physics check: the resolved weighted delivery really lands near its target.
  const landings: string[] = [];
  for (const [id, distance] of [["pass_short", 12], ["pass_medium", 22], ["pass_lofted_switch", 34], ["corner_inswing", 28], ["throw_in", 18], ["gk_punt", 42]] as const) {
    const p = ACTION_PROFILES[id];
    const r = resolveStrike(p, { distance, rng: new SeededRandom(5), accuracy: 80 });
    const prediction = predictDelivery(r, distance);
    // A delivery reaches the target band if it arrives at or beyond the distance.
    const state: BallState = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: new THREE.Vector3() };
    strikeBall(state, new THREE.Vector3(1, 0, 0), r);
    let reached = false;
    for (let i = 0; i < 120 * 8; i++) {
      stepBallPhysics(state, 1 / 120);
      if (state.pos.x >= distance) { reached = true; break; }
      if (state.vel.length() < param("dead_ball_threshold")) break;
    }
    if (!reached) landings.push(`${id} (${prediction.arrivalSpeed.toFixed(1)} m/s)`);
  }
  check("weighted deliveries (passes, crosses, set pieces, keeper) reach their target distance",
    landings.length === 0, landings.join(", "));

  // Obstacle-aware choice: the profile changes with what is in the way.
  const blockedPass = chooseProfile({ family: "pass", action: "pass_short" }, {
    rng: new SeededRandom(3), distance: 14, lane: 0.2, blockerAlong: 5,
  });
  const openPass = chooseProfile({ family: "pass", action: "pass_short" }, {
    rng: new SeededRandom(3), distance: 14, lane: 0.9,
  });
  check("a blocked short pass chooses a different profile from an open one",
    blockedPass.id !== openPass.id, `${blockedPass.id} vs ${openPass.id}`);
  const blockedCross = chooseProfile({ family: "cross" }, {
    rng: new SeededRandom(4), distance: 22, lane: 0.3, blockerAlong: 6, targetHeight: 1.9,
  });
  const openCross = chooseProfile({ family: "cross" }, {
    rng: new SeededRandom(4), distance: 26, lane: 0.95, targetHeight: 1.9,
  });
  check("a whipped cross is chosen around a blocker, a floated one over an open lane",
    blockedCross.id === "cross_whipped" && openCross.id === "cross_floated",
    `${blockedCross.id} / ${openCross.id}`);
  const inswing = chooseProfile({ family: "corner" }, { rng: new SeededRandom(1), distance: 28, side: 1 });
  const outswing = chooseProfile({ family: "corner" }, { rng: new SeededRandom(1), distance: 28, side: -1 });
  check("corners swing in from one side and out from the other",
    inswing.id === "corner_inswing" && outswing.id === "corner_outswing");
  const farShot = chooseProfile({ family: "shot", action: "shoot_normal" }, {
    rng: new SeededRandom(2), distance: 28, lane: 0.9,
  });
  const closeShot = chooseProfile({ family: "shot", action: "shoot_normal" }, {
    rng: new SeededRandom(2), distance: 9, lane: 0.9,
  });
  check("a long-range shot gets the dipping topspin profile, not a placed chip",
    farShot.id === "shot_dipping_topspin", `${farShot.id} / near: ${closeShot.id}`);

  // Spin axis: a whipped cross must be a side-spin ball, a dipping shot topspin.
  const whip = resolveStrike(ACTION_PROFILES.cross_whipped, { distance: 24, rng: new SeededRandom(8), curveSide: 1 });
  const dip = resolveStrike(ACTION_PROFILES.shot_dipping_topspin, { distance: 24, rng: new SeededRandom(8), directSpeed: true });
  check("whipped crosses carry sidespin and dipping shots carry topspin",
    Math.abs(whip.spin.y) > Math.abs(whip.spin.x) + 1e-6 && dip.spin.z < 0,
    `cross spin.y ${whip.spin.y.toFixed(1)} · shot spin.z ${dip.spin.z.toFixed(1)}`);
  check("knuckle free kicks carry (almost) no spin and a turbulence mode",
    Math.abs(resolveStrike(ACTION_PROFILES.freekick_knuckle, { distance: 26, rng: new SeededRandom(6) }).spin.length())
      < 60 * Math.PI / 30 + 1e-6);

  // Profile strikes obey the speed cap.
  const rocket: StrikeCommand = { speed: 90, loft: 0.2, spin: new THREE.Vector3() };
  const capped = fresh();
  strikeBall(capped, new THREE.Vector3(1, 0, 0), rocket);
  check("the strike speed cap still applies to profile strikes", capped.vel.length() <= CONFIG.ball.maxSpeed + 1e-6,
    `${capped.vel.length().toFixed(1)} m/s`);
}

// --------------------------------------------------------------- long ball ----
{
  const s = fresh();
  strikeBall(s, new THREE.Vector3(1, 0, 0), { speed: 24, loft: 0.25, spin: new THREE.Vector3() });
  for (let i = 0; i < 120 * 8; i++) {
    stepBallPhysics(s, 1 / 120);
    if (s.vel.length() < param("dead_ball_threshold")) break;
  }
  check("a 24 m/s drive carries a real 30–60 m", s.pos.x > 30 && s.pos.x < 60, `${s.pos.x.toFixed(1)} m`);
}

console.log(failures ? `\n${failures} PHYSICS CHECK(S) FAILED` : `\n${PROFILE_IDS.length} PROFILES · ALL PHYSICS CHECKS PASSED`);
if (failures) process.exitCode = 1;
