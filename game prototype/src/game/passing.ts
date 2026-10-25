import * as THREE from "three";
import { CONFIG } from "./config";
import { estimateKickTravelTime, kickPowerForRange, kickRangeForPower } from "./ball";

export interface PassActor {
  idx: number;
  team: number;
  role: string;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

export interface PassPhysicsProfile { loft: number; maxPower: number; minPower: number; }
export interface NamedPassPlan {
  receiver: PassActor;
  target: THREE.Vector3;
  power: number;
  loft: number;
  aimDot: number;
  distance: number;
}

export function resolveNamedReceiver<T extends PassActor>(
  players: readonly T[],
  passer: PassActor,
  receiverIdx: number | undefined,
  allowGoalkeeper = false,
): T | null {
  if (receiverIdx === undefined || receiverIdx === passer.idx) return null;
  const receiver = players.find((p) => p.idx === receiverIdx);
  if (!receiver || receiver.team !== passer.team) return null;
  if (!allowGoalkeeper && receiver.role === "GK") return null;
  return receiver;
}

export function predictReceiverPosition(
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  travelTime: number,
  maxSpeed: number,
  bounds: { halfLength: number; halfWidth: number; buffer?: number },
): THREE.Vector3 {
  const v = velocity.clone().setY(0);
  const speed = v.length();
  if (speed > maxSpeed) v.multiplyScalar(maxSpeed / speed);
  const buffer = bounds.buffer ?? 0.7;
  return new THREE.Vector3(
    THREE.MathUtils.clamp(position.x + v.x * travelTime, -bounds.halfLength + buffer, bounds.halfLength - buffer),
    0,
    THREE.MathUtils.clamp(position.z + v.z * travelTime, -bounds.halfWidth + buffer, bounds.halfWidth - buffer),
  );
}

/** Predict a named runner following the same bounded acceleration/braking as the player. */
export function predictReceiverRun(
  position: THREE.Vector3, velocity: THREE.Vector3, destination: THREE.Vector3,
  travelTime: number, maxSpeed: number,
): THREE.Vector3 {
  const point = position.clone().setY(0);
  const v = velocity.clone().setY(0).clampLength(0, maxSpeed);
  for (let elapsed = 0; elapsed < travelTime; elapsed += 1 / 60) {
    const dt = Math.min(1 / 60, travelTime - elapsed);
    const to = destination.clone().sub(point).setY(0);
    const distance = to.length();
    const desiredSpeed = Math.min(maxSpeed, Math.sqrt(Math.max(0, 2 * CONFIG.player.decel * distance)), distance * 2.2);
    const desired = to.normalize().multiplyScalar(desiredSpeed);
    const delta = desired.sub(v);
    const rate = delta.dot(v) < 0 ? CONFIG.player.decel : CONFIG.player.accel;
    delta.clampLength(0, rate * dt);
    v.add(delta);
    point.addScaledVector(v, dt);
  }
  point.x = THREE.MathUtils.clamp(point.x, -CONFIG.pitch.length / 2 + CONFIG.ai.outPlaySafetyMargin, CONFIG.pitch.length / 2 - CONFIG.ai.outPlaySafetyMargin);
  point.z = THREE.MathUtils.clamp(point.z, -CONFIG.pitch.width / 2 + CONFIG.ai.outPlaySafetyMargin, CONFIG.pitch.width / 2 - CONFIG.ai.outPlaySafetyMargin);
  return point;
}

export function passAimDot(
  ballPosition: THREE.Vector3,
  initialVelocity: THREE.Vector3,
  predictedReceiverPosition: THREE.Vector3,
): number {
  const receiverDirection = predictedReceiverPosition.clone().sub(ballPosition).setY(0);
  const kickDirection = initialVelocity.clone().setY(0);
  if (receiverDirection.lengthSq() < 1e-6 || kickDirection.lengthSq() < 1e-6) return -1;
  return receiverDirection.normalize().dot(kickDirection.normalize());
}

export function passAimIsValid(dot: number, maxAngleDegrees = 8): boolean {
  return dot >= Math.cos(maxAngleDegrees * Math.PI / 180);
}

/** A single same-team receiver is the authority for every pass aim point. */
export function planNamedReceiverPass(
  origin: THREE.Vector3,
  receiver: PassActor,
  profile: PassPhysicsProfile,
  receiverMaxSpeed: number,
  requestedPower?: number,
  startHeight: number = CONFIG.ball.radius,
): NamedPassPlan | null {
  startHeight = Math.max(CONFIG.ball.radius, startHeight);
  let target = receiver.pos.clone();
  let distance = Math.hypot(target.x - origin.x, target.z - origin.z);
  if (distance < 1.15) return null;

  const maximumReach = kickRangeForPower(profile.maxPower, profile.loft, startHeight);
  if (distance > maximumReach - 0.35) return null;
  let power = kickPowerForRange(distance, profile.loft, profile.maxPower, profile.minPower, startHeight);

  for (let i = 0; i < 3; i++) {
    const travelTime = estimateKickTravelTime(distance, power, profile.loft, startHeight);
    target = predictReceiverPosition(receiver.pos, receiver.vel, travelTime, receiverMaxSpeed, {
      halfLength: CONFIG.pitch.length / 2,
      halfWidth: CONFIG.pitch.width / 2,
      buffer: CONFIG.ai.outPlaySafetyMargin,
    });
    distance = Math.hypot(target.x - origin.x, target.z - origin.z);
    if (distance > maximumReach - 0.35) return null;
    const calibrated = kickPowerForRange(distance, profile.loft, profile.maxPower, profile.minPower, startHeight);
    // Charge changes pace a little but never overpowers the receiver's measured range.
    power = requestedPower === undefined
      ? calibrated
      : THREE.MathUtils.clamp(requestedPower, calibrated * 0.82, Math.min(profile.maxPower, calibrated * 1.08));
  }

  const direction = target.clone().sub(origin).setY(0).normalize();
  const velocity = new THREE.Vector3(direction.x * power, power * profile.loft, direction.z * power);
  const aimDot = passAimDot(origin, velocity, target);
  if (!passAimIsValid(aimDot, CONFIG.ai.passAimConeDegrees)) return null;
  return { receiver, target, power, loft: profile.loft, aimDot, distance };
}