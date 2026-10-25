// Ball — single source of truth for possession.
// Real-measurement physics: FIFA ball Ø 22 cm / 0.43 kg, g = 9.81 m/s²,
// quadratic aerodynamic drag (F = ½ρCdA v²), Magnus lift from spin,
// rolling resistance on grass. Physics lives in pure functions so it can be
// unit-tested without a DOM.
import * as THREE from "three";
import { CONFIG } from "./config";

export interface BallState {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  spin: THREE.Vector3; // rad/s angular velocity vector
}

const B = CONFIG.ball;
// Cross-sectional area (m²). Drag is speed-dependent (drag crisis), so the drag
// constant is computed per step from the live Cd rather than cached.
const CROSS_SECTION = Math.PI * B.radius * B.radius;

/**
 * Speed-dependent drag coefficient. Below the drag crisis (subcritical, < ~10 m/s) the
 * ball drags hard (Cd≈0.50); above it (supercritical, > ~14 m/s) Cd drops to ≈0.25.
 * Linear transition between. Required: a constant Cd gives wrong trajectories.
 */
export function dragCoefficientAt(speed: number): number {
  if (speed <= B.dragCrisisLow) return B.dragCoefficientLow;
  if (speed >= B.dragCrisisHigh) return B.dragCoefficientHigh;
  const t = (speed - B.dragCrisisLow) / (B.dragCrisisHigh - B.dragCrisisLow);
  return B.dragCoefficientLow + (B.dragCoefficientHigh - B.dragCoefficientLow) * t;
}
function dragK(speed: number): number {
  return 0.5 * B.airDensity * dragCoefficientAt(speed) * CROSS_SECTION / B.mass;
}

/** Advance free-ball physics by dt. Pure — no DOM, no scene. */
export function stepBallPhysics(s: BallState, dt: number): void {
  const v = s.vel;
  // gravity (real 9.81 m/s²)
  v.y -= B.gravity * dt;

  const speed = v.length();
  if (speed > 0.01) {
    // Quadratic aerodynamic drag: F = ½ρ·Cd(v)·A·v² opposing velocity, Cd speed-dependent.
    const k = dragK(speed);
    v.x -= k * speed * v.x * dt;
    v.y -= k * speed * v.y * dt;
    v.z -= k * speed * v.z * dt;

    // Magnus lift: F = ½ρA·Cl·v² along (ω × v); Cl grows with spin ratio S = ωr/v.
    const spinMag = s.spin.length();
    if (spinMag > 0.05) {
      const cx = s.spin.y * v.z - s.spin.z * v.y;
      const cy = s.spin.z * v.x - s.spin.x * v.z;
      const cz = s.spin.x * v.y - s.spin.y * v.x;
      const cMag = Math.hypot(cx, cy, cz);
      if (cMag > 1e-6) {
        const spinRatio = (spinMag * B.radius) / Math.max(speed, 0.1);
        const Cl = B.magnusLiftMax * Math.min(1, spinRatio * 3.5);
        const aLift = 0.5 * B.airDensity * CROSS_SECTION * Cl * speed * speed / B.mass;
        const f = (aLift / cMag) * dt;
        v.x += cx * f; v.y += cy * f; v.z += cz * f;
      }
      // spin decays in flight
      s.spin.multiplyScalar(Math.max(0, 1 - B.spinDecayAir * dt));
    }
  }

  // integrate
  s.pos.x += v.x * dt;
  s.pos.y += v.y * dt;
  s.pos.z += v.z * dt;

  // ground contact
  if (s.pos.y <= B.radius) {
    s.pos.y = B.radius;
    if (v.y < -0.5) {
      v.y *= -B.restitution;               // vertical COR on grass
      v.x *= B.restitutionHorizontal;      // horizontal COR: a bounce bleeds pace
      v.z *= B.restitutionHorizontal;
      s.spin.multiplyScalar(Math.max(0, 1 - B.spinDecayGround * dt));
    } else {
      v.y = 0;
    }
    // rolling resistance: constant decel opposing horizontal motion
    const hv = Math.hypot(v.x, v.z);
    if (hv > 1e-4) {
      const drop = Math.min(hv, B.rollingDecel * dt);
      v.x -= (v.x / hv) * drop;
      v.z -= (v.z / hv) * drop;
    }
    if (Math.hypot(v.x, v.z) < B.groundStopEps) { v.x = 0; v.z = 0; }
  }

  // hard speed cap (record shots ≈ 35 m/s)
  const total = v.length();
  if (total > B.maxSpeed) v.multiplyScalar(B.maxSpeed / total);
}

/**
 * Apply a kick: velocity from direction + power (m/s), with loft and sidespin.
 * `spinSide` is a signed strength (−1..+1) scaled to real sidespin for curve; a little
 * backspin is always imparted for lift. Spin magnitudes come from REAL rpm figures.
 */
export function kickBall(s: BallState, dir: THREE.Vector3, power: number, loft = 0.15, spinSide = 0): void {
  const d = dir.clone().normalize();
  s.vel.set(d.x * power, power * loft, d.z * power);
  // Sidespin (curl) scales to real shot spin; only a trace of backspin so a flat strike
  // stays flat (lofted delivery comes from `loft`, not from spin lifting the ball wide).
  s.spin.set(0, spinSide * B.spinShot, spinSide !== 0 ? B.spinPass * 0.3 : 2);
  const sp = s.vel.length();
  if (sp > B.maxSpeed) s.vel.multiplyScalar(B.maxSpeed / sp);
}

interface KickRangeSample { power: number; range: number; }
const kickRangeTables = new Map<string, KickRangeSample[]>();
/** Hard cap so the module-level cache can never grow without bound. */
const KICK_TABLE_LIMIT = 48;

function buildKickRangeTable(loft: number, maxPower: number, startHeight: number = B.radius): KickRangeSample[] {
  // `startHeight` arrives as the live ball height — a continuous value. Keying
  // the cache on the exact height would build (and keep forever) a fresh table
  // for every distinct airborne height an AI think happens to sample, each one
  // costing ~100 simulated kicks. Bucket heights to 5 cm instead; the table is
  // simulated at the first height seen in its bucket. A possessed ball sits
  // exactly at radius height, so ground passes keep their exact tables.
  const key = `${loft.toFixed(4)}:${maxPower.toFixed(2)}:${Math.round(startHeight / 0.05)}`;
  const existing = kickRangeTables.get(key);
  if (existing) return existing;
  const table: KickRangeSample[] = [];
  const dt = 1 / 120;
  const maxSteps = 120 * 8;
  for (let power = 0.5; power <= maxPower + 0.001; power += 0.25) {
    const state: BallState = {
      pos: new THREE.Vector3(0, Math.max(B.radius, startHeight), 0),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(),
    };
    kickBall(state, new THREE.Vector3(1, 0, 0), power, loft);
    let steps = 0;
    while (steps++ < maxSteps) {
      stepBallPhysics(state, dt);
      if (state.pos.x > 75 || state.vel.length() < 0.15) break;
    }
    table.push({ power, range: state.pos.x });
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
export function kickPowerForRange(distance: number, loft: number, maxPower: number, minPower = 2.5, startHeight: number = B.radius): number {
  const table = buildKickRangeTable(loft, maxPower, startHeight);
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

export function kickRangeForPower(power: number, loft: number, startHeight: number = B.radius): number {
  const state: BallState = {
    pos: new THREE.Vector3(0, Math.max(B.radius, startHeight), 0),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
  };
  kickBall(state, new THREE.Vector3(1, 0, 0), power, loft);
  const dt = 1 / 120;
  for (let i = 0; i < 120 * 8; i++) {
    stepBallPhysics(state, dt);
    if (state.pos.x > 75 || state.vel.length() < 0.15) break;
  }
  return state.pos.x;
}

/** Numerically estimate arrival time with the same ball-stepper used in play. */
export function estimateKickTravelTime(distance: number, power: number, loft: number, startHeight: number = B.radius): number {
  const state: BallState = {
    pos: new THREE.Vector3(0, Math.max(B.radius, startHeight), 0),
    vel: new THREE.Vector3(),
    spin: new THREE.Vector3(),
  };
  kickBall(state, new THREE.Vector3(1, 0, 0), power, loft);
  const dt = 1 / 120;
  for (let i = 1; i <= 120 * 8; i++) {
    stepBallPhysics(state, dt);
    if (state.pos.x >= distance) return i * dt;
    if (state.vel.length() < 0.15) break;
  }
  return Math.min(8, distance / Math.max(0.5, power * 0.55));
}

export class Ball {
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  pos = new THREE.Vector3(0, CONFIG.ball.radius, 0);
  vel = new THREE.Vector3();
  spin = new THREE.Vector3(); // rad/s angular velocity vector
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

  possess(idx: number, team: number) {
    this.possessedBy = idx; this.ownerTeam = team;
    this.lastTouch = idx; this.lastTouchTeam = team;
    if (this.handsRestrictedTeam !== team) this.handsRestrictedTeam = null;
    this.vel.set(0, 0, 0);
  }
  release() { this.possessedBy = null; this.ownerTeam = null; }

  // dribble glue
  glueTo(ownerPos: THREE.Vector3, facing: number, ownerVel: THREE.Vector3) {
    const fx = Math.cos(facing), fz = -Math.sin(facing);
    this.pos.set(ownerPos.x + fx * 0.48, CONFIG.ball.radius, ownerPos.z + fz * 0.48);
    this.vel.copy(ownerVel);
  }

  step(dt: number, ownerPos?: THREE.Vector3, ownerFacing?: number, ownerVel?: THREE.Vector3) {
    this.kickAge += dt;
    if (this.possessedBy !== null && ownerPos !== undefined && ownerFacing !== undefined && ownerVel !== undefined) {
      this.glueTo(ownerPos, ownerFacing, ownerVel);
    } else {
      stepBallPhysics(this, dt);
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
