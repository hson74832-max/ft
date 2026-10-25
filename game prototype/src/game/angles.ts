/**
 * Angle helpers for the pitch coordinate convention.
 *
 * The sim uses a right-handed, Y-up world where **+X is forward at yaw 0** and a yaw of
 * `Math.PI / 2` points along **-Z**. That mapping (`atan2(-dz, dx)`) was repeated inline in
 * the engine, AI and animation code, together with hand-written ±π wrap loops, which is
 * exactly the kind of thing that drifts when one call site is edited and the others are
 * not. Everything angular funnels through here.
 */

const TAU = Math.PI * 2;

/**
 * Wraps an angle into (-π, π].
 *
 * Modulo, not a subtraction loop: the loop form never terminates for ±Infinity
 * (subtracting 2π from Infinity leaves Infinity) and crawls for huge finite
 * inputs. NaN in → NaN out, exactly as the loop behaved.
 */
export function wrapAngle(angle: number): number {
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

/** Yaw that points along the given world-space delta (`+X` at yaw 0, `+Z` is right). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dz, dx);
}

/** Yaw of a direction described by a vector-like object. */
export function yawOfVector(v: { x: number; z: number }): number {
  return Math.atan2(-v.z, v.x);
}

/** Shortest signed rotation that takes `from` to `to`, in (-π, π]. */
export function yawDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Moves `from` toward `to` by at most `maxStep` radians, taking the short way round. */
export function turnTowards(from: number, to: number, maxStep: number): number {
  return from + Math.max(-maxStep, Math.min(maxStep, yawDelta(from, to)));
}
