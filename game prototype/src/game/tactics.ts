import * as THREE from "three";
import { CONFIG } from "./config";
import { tieBreakHash } from "./random";
import type { WorldPlayer, WorldSnap } from "./ai";

export type SupportJob = "pivot" | "outlet" | "runner" | "keeper-outlet";
/**
 * Dynamic off-ball behaviour. A job says *who covers what*; a run type says *what
 * the player is doing right now*:
 *  - hold  keep the support shape (pivot / keeper cover)
 *  - check drop short into the vacant space in front of the carrier for an outlet
 *  - spin  attack the space behind the defensive line (respecting offside)
 *  - drive carry the run forward through open midfield space
 */
export type RunType = "hold" | "check" | "spin" | "drive";
export type AttackPhase = "build" | "transition" | "progress" | "finish" | "recycle";

export interface RunTrigger {
  active: boolean;
  reason: string;
  facingDot: number;   // carrier facing vs attacking direction, -1..1
  timeOnBall: number;  // seconds the carrier has held the ball
  pressure: number;    // m to the nearest opponent
  forwardLane: number; // lane safety 8 m ahead of the carrier
  transition: boolean;
}

export interface SupportAssignment {
  player: number;
  job: SupportJob;
  target: THREE.Vector3;
  runTarget?: THREE.Vector3;
  mode: string;
  lane: number;
  space: number;
  /** Vacant space beyond the target, 0..1 (see `spaceAhead`). */
  vacancy: number;
  score: number;
  desiredSpeed: number;
  callForBall: boolean;
  runType: RunType;
  /** Metres the target gains on the player's current position along the attack axis. */
  advance: number;
  /** True when the target is in the space beyond the defensive line. */
  beyondLine: boolean;
}

export interface AttackPlan {
  team: number;
  carrier: number;
  half: 1 | 2;
  phase: AttackPhase;
  at: number;
  anchor: THREE.Vector3;
  offsideLine: number;
  trigger: RunTrigger;
  assignments: Map<number, SupportAssignment>;
}

const T = CONFIG.tactics;
const clamp = THREE.MathUtils.clamp;
export const groundDistance = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
export const attackDirection = (team: number, half: 1 | 2) => (team === 0 ? 1 : -1) * (half === 1 ? 1 : -1);
export const nearestSpace = (point: THREE.Vector3, players: readonly WorldPlayer[]) =>
  players.reduce((best, p) => Math.min(best, groundDistance(point, p.pos)), 30);

/**
 * How much vacant space lies ahead of a point, in the attacking direction.
 * Probes a small fan (near / middle / far, left / centre / right) and returns the
 * mean distance to the nearest opponent, normalised to 0..1. This is the "scan
 * for space" primitive: players use it to tell "I am open where I am" apart from
 * "there is space to move into".
 */
export function spaceAhead(
  point: THREE.Vector3, opponents: readonly WorldPlayer[], sign: number,
  depth = T.spaceScanDepth, halfWidth = T.spaceScanHalfWidth,
): number {
  if (!opponents.length) return 1;
  const probe = new THREE.Vector3();
  let total = 0, samples = 0;
  for (const d of [depth * 0.35, depth * 0.7, depth]) {
    for (const w of [-halfWidth, 0, halfWidth]) {
      probe.set(point.x + sign * d, 0, point.z + w);
      total += nearestSpace(probe, opponents);
      samples++;
    }
  }
  return clamp(total / samples / 6, 0, 1);
}

// Ignore players beyond the segment. A defender actually standing in the lane must
// be a blocker, not the old minimum 0.64 "open" score for one direct obstruction.
export function laneSafety(a: THREE.Vector3, b: THREE.Vector3, opponents: readonly WorldPlayer[], pace = 11): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const length2 = dx * dx + dz * dz;
  if (length2 < 0.01) return 0;
  const length = Math.sqrt(length2);
  let safety = 1;
  for (const o of opponents) {
    const t = ((o.pos.x - a.x) * dx + (o.pos.z - a.z) * dz) / length2;
    if (t < 0.06 || t > 0.96) continue;
    const time = Math.min(0.4, t * length / pace);
    const gapNow = Math.hypot(a.x + dx * t - o.pos.x, a.z + dz * t - o.pos.z);
    const gapNext = Math.hypot(a.x + dx * t - o.pos.x - o.vel.x * time, a.z + dz * t - o.pos.z - o.vel.z * time);
    safety = Math.min(safety, clamp((Math.min(gapNow, gapNext) - 0.4) / 1.6, 0, 1));
  }
  return safety;
}

export function onsideLimit(snap: WorldSnap, team: number): number {
  if (!CONFIG.ai.offside) return CONFIG.pitch.length / 2;
  const sign = attackDirection(team, snap.half);
  const defenders = snap.players.filter((p) => p.team !== team).map((p) => p.pos.x * sign).sort((a, b) => b - a);
  return Math.max(0, snap.ballPos.x * sign, defenders[1] ?? 0);
}

/**
 * The run trigger: the carrier is facing forward, has had time on the ball and is
 * not smothered. Only then do nearby attackers commit to runs in behind; when the
 * trigger is off they shorten up and check instead of standing still.
 */
export function readRunTrigger(
  carrier: WorldPlayer, anchor: THREE.Vector3, sign: number,
  fieldOpponents: readonly WorldPlayer[], snap: WorldSnap,
): RunTrigger {
  const facing = new THREE.Vector3(Math.cos(carrier.facing), 0, -Math.sin(carrier.facing));
  const facingDot = facing.x * sign;
  const timeOnBall = Math.max(0, snap.time - (snap.ownerSince ?? snap.time - 0.6));
  const pressure = nearestSpace(anchor, fieldOpponents);
  const ahead = anchor.clone().add(new THREE.Vector3(sign * 8, 0, 0));
  const forwardLane = laneSafety(anchor, ahead, fieldOpponents);
  const transition = (snap.transitionUntil ?? 0) > snap.time;
  const facingThreshold = transition ? T.runTriggerFacingDot * 0.4 : T.runTriggerFacingDot;
  const active = facingDot > facingThreshold
    && timeOnBall > T.runTriggerTimeOnBall
    && (pressure > T.pressureDistance * 0.85 || forwardLane > T.runTriggerForwardLane);
  const reason = active
    ? `trigger ON · carrier faces goal (${facingDot.toFixed(2)}) · ${timeOnBall.toFixed(1)}s on ball · lane ${forwardLane.toFixed(2)}${transition ? " · transition" : ""}`
    : facingDot <= facingThreshold
      ? `trigger off · carrier not facing forward (${facingDot.toFixed(2)})`
      : timeOnBall <= T.runTriggerTimeOnBall
        ? `trigger off · carrier just received (${timeOnBall.toFixed(2)}s)`
        : `trigger off · carrier under pressure (${pressure.toFixed(1)}m)`;
  return { active, reason, facingDot, timeOnBall, pressure, forwardLane, transition };
}

interface Candidate { target: THREE.Vector3; mode: string; preference: number; runType?: RunType; }
interface RunMemory { target: THREE.Vector3; expiresAt: number; runType: RunType; mode: string; }

/** One shared plan allocates the off-ball jobs; players do not all choose width. */
export class TeamTactics {
  private plans = new Map<number, AttackPlan>();
  /** Committed runs, so a started run is carried through instead of oscillating per plan tick. */
  private runs = new Map<string, RunMemory>();

  reset() { this.plans.clear(); this.runs.clear(); }
  current(team: number) { return this.plans.get(team); }

  plan(snap: WorldSnap, team: number): AttackPlan | null {
    const flight = snap.passFlight;
    const carrierIdx = snap.ballOwnerTeam === team ? snap.ballOwner : flight?.team === team ? flight.receiver : null;
    const carrier = snap.players.find((p) => p.idx === carrierIdx);
    if (!carrier) return null;
    const anchor = snap.ballOwner === null && flight ? flight.target.clone().setY(0) : carrier.pos.clone().setY(0);
    const sign = attackDirection(team, snap.half);
    const keeperBuilding = carrier.role === "GK";
    const opponents = snap.players.filter((p) => p.team !== team);
    const fieldOpponents = opponents.filter((p) => p.role !== "GK");
    const u = anchor.x * sign;
    const pressure = nearestSpace(anchor, fieldOpponents);
    const trigger = readRunTrigger(carrier, anchor, sign, fieldOpponents, snap);
    const ahead = anchor.clone().add(new THREE.Vector3(sign * 5, 0, 0));
    const phase: AttackPhase = trigger.transition
      ? "transition"
      : pressure < T.pressureDistance && laneSafety(anchor, ahead, fieldOpponents) < 0.6
        ? "recycle" : u > CONFIG.pitch.length / 2 - 13 ? "finish" : u < -5 ? "build" : "progress";
    const previous = this.plans.get(team);
    if (previous && previous.carrier === carrier.idx && previous.half === snap.half && previous.phase === phase
      && previous.trigger.active === trigger.active
      && snap.time >= previous.at && snap.time - previous.at < T.planInterval
      && groundDistance(previous.anchor, anchor) < 2) return previous;

    const offBall = snap.players.filter((p) => p.team === team && p.idx !== carrier.idx && p.role !== "GK");
    const assignments = new Map<number, SupportAssignment>();
    const halfL = CONFIG.pitch.length / 2, halfW = CONFIG.pitch.width / 2;
    const line = onsideLimit(snap, team);
    const ballSide = Math.abs(anchor.z) > 1 ? Math.sign(anchor.z) : (tieBreakHash(snap.matchSeed, team, 0, "attack-side") < 0.5 ? -1 : 1);
    const pos = (x: number, z: number) => new THREE.Vector3(clamp(x, -halfL + 1.5, halfL - 1.5) * sign, 0, clamp(z, -halfW + 1.6, halfW - 1.6));
    const wasJob = (p: WorldPlayer, job: SupportJob) => previous?.half === snap.half && previous.assignments.get(p.idx)?.job === job;
    const choose = (players: WorldPlayer[], job: SupportJob, ideal: THREE.Vector3, preferences: Record<string, number>) =>
      [...players].sort((a, b) => {
        const cost = (p: WorldPlayer) => groundDistance(p.pos, ideal) * 0.22 + (preferences[p.role] ?? 3)
          - (wasJob(p, job) ? T.assignmentHysteresis : 0)
          + tieBreakHash(snap.matchSeed, p.idx, 0, job) * 0.01;
        return cost(a) - cost(b);
      })[0];

    const pick = (p: WorldPlayer, job: SupportJob, candidates: Candidate[]): SupportAssignment => {
      const prev = previous?.assignments.get(p.idx);
      const memoryKey = `${team}:${p.idx}:${job}`;
      const memory = this.runs.get(memoryKey);
      // A committed run stops being a commitment once the player has arrived: from
      // then on the target must be re-led, or he would stand on it while the plan
      // still believes he is running.
      const memoryReached = !!memory && (groundDistance(p.pos, memory.target) < 2.2
        || (memory.runType !== "check" && (memory.target.x - p.pos.x) * sign < 1.0));
      const memoryLive = !!memory && memory.expiresAt > snap.time && !memoryReached;
      const scored = candidates.map((c) => {
        const point = c.target.clone();
        // The onside limit is the second-last defender OR the ball, whichever is more
        // advanced. Clamping only to the defensive line collapsed every support target
        // behind the ball once the carrier broke the line — the carrier then had no
        // forward option at all.
        const attackLimit = Math.max(line, anchor.x * sign) - CONFIG.ai.offsideBuffer - 0.3;
        if (job !== "keeper-outlet") point.x = Math.min(point.x * sign, attackLimit) * sign;
        if (point.x * sign < -halfL + 1.5) point.x = (-halfL + 1.5) * sign;
        const dist = groundDistance(point, anchor);
        const maxDist = job === "runner" ? keeperBuilding ? T.keeperRunnerMaxDistance : T.runnerMaxDistance : T.outletMaxDistance;
        const lane = laneSafety(anchor, point, fieldOpponents);
        const space = nearestSpace(point, fieldOpponents);
        const vacancy = spaceAhead(point, fieldOpponents, sign);
        const advance = (point.x - p.pos.x) * sign;
        const peers = offBall.filter((m) => m.idx !== p.idx);
        let crowd = 0;
        for (const m of peers) {
          const reserved = assignments.get(m.idx)?.target ?? m.pos;
          crowd += Math.max(0, T.minSupportGap - groundDistance(point, reserved)) * 0.24;
        }
        const stability = prev?.mode === c.mode ? T.targetHysteresis : 0;
        // Committed runs keep their heading: the live memory target is strongly
        // preferred so a player drives into the space instead of re-picking every tick.
        const commitment = memoryLive ? clamp(1 - groundDistance(memory!.target, point) / 5, 0, 1) * 0.32 : 0;
        // Space recognition: a target with vacant ground ahead is worth more than a
        // nominally "open" spot that leads nowhere.
        const runType = c.runType ?? (job === "runner" ? "spin" : "hold");
        const reward = c.preference + vacancy * (runType === "spin" ? 0.30 : runType === "drive" ? 0.34 : 0.12);
        // Lateral continuity: do not flip a run from one channel to the other every
        // plan tick just because the two score within noise of each other.
        const continuity = -Math.min(6, Math.abs(point.z - p.pos.z)) * 0.04;
        const score = lane * 0.38 + clamp(space / 5, 0, 1) * 0.22 + reward + stability + commitment + continuity
          - Math.max(0, dist - maxDist) * 0.16 - Math.max(0, T.minSupportGap - dist) * 0.32
          - crowd - groundDistance(p.pos, point) * 0.008
          + (runType !== "hold" && trigger.active && advance > 2 ? 0.12 : 0)
          // Runs in behind are only triggered when the carrier can actually see and
          // use them; otherwise the short check is the correct movement.
          - (runType === "spin" && !trigger.active ? 0.26 : 0)
          - (runType === "drive" && !trigger.active ? 0.16 : 0)
          + (runType === "check" && (pressure < T.pressureDistance || trigger.facingDot < 0.1) ? 0.18 : 0);
        return { player: p.idx, job, target: point, mode: c.mode, lane, space, vacancy, score,
          desiredSpeed: job === "runner" ? CONFIG.player.hsrSpeed : CONFIG.player.runSpeed,
          callForBall: lane > T.minSafeLane && space > T.minSafeReceiverSpace && dist > 3,
          runType, advance, beyondLine: point.x * sign > line - 1.2 };
      }).sort((a, b) => b.score - a.score || tieBreakHash(snap.matchSeed, p.idx, 0, a.mode) - tieBreakHash(snap.matchSeed, p.idx, 0, b.mode));
      const best = scored[0];
      // A committed run is sticky: while the space it attacks is still open the player
      // keeps going. Without this, spin/check/hold flip every plan tick and the run is
      // aborted before it produces separation — the static web again.
      if (memoryLive && memory!.runType !== "hold" && (job === "runner" || job === "outlet")) {
        const laneNow = laneSafety(anchor, memory!.target, fieldOpponents);
        const stillUseful = laneNow > 0.3 && (memory!.target.x - p.pos.x) * sign > 0.5;
        if (stillUseful) {
          const base = scored.find((entry) => groundDistance(entry.target, memory!.target) < 1.5) ?? best;
          return { ...base, target: memory!.target.clone(), mode: memory!.mode, runType: memory!.runType,
            advance: (memory!.target.x - p.pos.x) * sign, beyondLine: memory!.target.x * sign > line - 1.2 };
        }
      }
      return best;
    };

    /**
     * A run must actually travel. Support targets are absolute spots around the
     * ball, so a player who has reached one stops — which is exactly the "static
     * web" the report describes. A committed run is therefore led: the target is
     * pushed far enough ahead of the player that he keeps accelerating into the
     * space, while staying onside and within the carrier's range.
     *
     * Checking runs are different: they travel *toward* the ball, so the target is
     * only pulled out far enough to require a real movement.
     */
    const leadRun = (assignment: SupportAssignment, player: WorldPlayer, wanted: number): SupportAssignment => {
      if (assignment.runType === "hold") return assignment;
      const target = assignment.target.clone();
      if (assignment.runType === "check") {
        const away = target.clone().sub(player.pos).setY(0);
        if (away.length() < 2.6 && away.lengthSq() > 1e-4) {
          target.copy(player.pos).addScaledVector(away.normalize(), 2.6);
          target.x = Math.min(target.x * sign, line - CONFIG.ai.offsideBuffer - 0.3) * sign;
          target.z = clamp(target.z, -halfW + 1.6, halfW - 1.6);
        }
        return { ...assignment, target, advance: (target.x - player.pos.x) * sign };
      }
      const leadGap = Math.max(T.runMinTravel, wanted);
      const gap = (target.x - player.pos.x) * sign;
      if (gap >= leadGap - 0.25) return assignment;
      const pushed = target.clone();
      pushed.x = (player.pos.x * sign + leadGap) * sign;
      pushed.x = Math.min(pushed.x * sign, Math.max(line, anchor.x * sign) - CONFIG.ai.offsideBuffer - 0.3) * sign;
      pushed.z = clamp(pushed.z, -halfW + 1.6, halfW - 1.6);
      // Never lead a run out of the carrier's passing range.
      const maxReach = assignment.job === "runner" ? (keeperBuilding ? T.keeperRunnerMaxDistance : T.runnerMaxDistance) : T.outletMaxDistance;
      const fromAnchor = groundDistance(pushed, anchor);
      if (fromAnchor > maxReach) pushed.lerpVectors(anchor, pushed, maxReach / fromAnchor);
      return { ...assignment, target: pushed, advance: (pushed.x - player.pos.x) * sign };
    };

    const commit = (assignment: SupportAssignment, player: WorldPlayer) => {
      const key = `${team}:${player.idx}:${assignment.job}`;
      const seconds = assignment.runType === "hold" ? T.planInterval * 2 : T.runCommitSeconds;
      this.runs.set(key, { target: assignment.target.clone(), expiresAt: snap.time + seconds, runType: assignment.runType, mode: assignment.mode });
      return assignment;
    };

    const pivotBase = keeperBuilding ? u + T.keeperBuildDepth : Math.min(u - T.pivotDepth, T.pivotMaxAdvance);
    const pivot = choose(offBall, "pivot", pos(pivotBase, 0), T.pivotRolePreference);
    if (pivot) {
      const candidates: Candidate[] = [];
      for (const depth of [T.pivotDepth, T.pivotDepth + 2, T.pivotDepth + 3.5]) {
        for (const z of [clamp(anchor.z * 0.2, -2, 2), -T.pivotHalfWidth, 0, T.pivotHalfWidth]) {
          candidates.push({ target: pos(keeperBuilding ? pivotBase + depth - T.pivotDepth : Math.min(u - depth, T.pivotMaxAdvance), z),
            mode: `${keeperBuilding ? "build-up pivot" : "central cover"} ${depth}:${z.toFixed(1)}`, preference: depth === T.pivotDepth ? 0.16 : 0.08 });
        }
      }
      // In transition the pivot is allowed to drive forward behind the ball instead of
      // sitting in the rest-defence slot, which is what turns a turnover into an attack.
      if (trigger.transition && !keeperBuilding) {
        for (const depth of [3.5, 6]) {
          candidates.push({ target: pos(u + depth, clamp(anchor.z * 0.3, -T.pivotHalfWidth, T.pivotHalfWidth)),
            mode: `transition drive ${depth}`, preference: 0.22, runType: "drive" });
        }
      }
      const assignment = pick(pivot, "pivot", candidates);
      const hasCentralCover = offBall.some((p) => p.pos.x * sign < u - 2 && Math.abs(p.pos.z) <= T.pivotHalfWidth);
      assignment.desiredSpeed = assignment.runType === "drive" ? CONFIG.player.hsrSpeed
        : hasCentralCover ? CONFIG.player.runSpeed : CONFIG.ai.maxSprint * 0.88;
      assignments.set(pivot.idx, assignment.runType === "drive" ? commit(leadRun(assignment, pivot, wantedTravel(assignment.runType)), pivot) : assignment);
    }

    const remaining = offBall.filter((p) => p.idx !== pivot?.idx);
    const runner = choose(remaining, "runner", pos(Math.min(u + T.runnerLead, line - 0.8), -ballSide * T.halfSpaceWidth), T.runnerRolePreference);
    if (runner) {
      const candidates: Candidate[] = [];
      const goalDistance = halfL - u;
      const lineRoom = Math.max(0, line - u); // legal room to attack before the offside line
      for (const side of [-1, 1]) {
        const channelWidth = phase === "finish" ? 3.8 : T.halfSpaceWidth;
        const stage = Math.min(u + (keeperBuilding ? T.keeperRunnerLead : T.runnerLead), line - 0.8);
        const far = side !== ballSide;
        candidates.push({ target: pos(stage, side * channelWidth), mode: far ? "far half-space run" : "near channel run", preference: 0.25 + (far && Math.abs(anchor.z) > 4 ? 0.08 : 0), runType: "spin" });
        candidates.push({ target: pos(Math.min(u + (keeperBuilding ? T.keeperRunnerLead - 3 : 3.5), line - 0.8), side * T.farSideMaxWidth), mode: side < 0 ? "left diagonal support" : "right diagonal support", preference: 0.04, runType: "drive" });
        if (goalDistance < 9) candidates.push({ target: pos(Math.min(halfL - 2.8, line - 0.7), side * 2.2), mode: side < 0 ? "left box arrival" : "right box arrival", preference: 0.24, runType: "spin" });
        // Cross target: with the ball wide in the final third the runner attacks the
        // middle of the box (still onside) instead of holding the half-space outside
        // it, so the wide carrier has someone to cross to and not only a square ball.
        if (Math.abs(anchor.z) > T.halfSpaceWidth && u > halfL - 18) {
          candidates.push({ target: pos(Math.min(halfL - 3.0, line - 0.8), side * 2.4),
            mode: `${side < 0 ? "near" : "far"} post cross target`, preference: 0.34, runType: "spin" });
        }
        // Spin in behind: attack the space just inside the offside line, where the
        // through-ball is available. Only worth it when there is legal room.
        if (lineRoom > 2.5) {
          candidates.push({ target: pos(Math.min(u + T.spinLead, line - CONFIG.ai.offsideBuffer - 0.4), side * channelWidth),
            mode: `spin in behind ${side < 0 ? "left" : "right"}`, preference: 0.30, runType: "spin" });
        }
        // Drive: carry the ball forward through open midfield space rather than wait.
        candidates.push({ target: pos(u + T.driveLead, side * T.halfSpaceWidth),
          mode: `driving run ${side < 0 ? "left" : "right"}`, preference: 0.12, runType: "drive" });
      }
      // Check to the ball: drop short into the space in front of the carrier when he is
      // pressed or facing away — the safe outlet the report asks for.
      for (const side of [-1, 1]) {
        candidates.push({ target: pos(u - T.checkDepth, side * 3.4),
          mode: `check to ball ${side < 0 ? "left" : "right"}`, preference: pressure < T.pressureDistance ? 0.34 : 0.05, runType: "check" });
      }
      const candidate = pick(runner, "runner", candidates);
      const assignment = leadRun(candidate, runner, wantedTravel(candidate.runType));
      if (assignment.runType === "spin") assignment.desiredSpeed = Math.min(CONFIG.ai.maxSprint, CONFIG.player.hsrSpeed * 1.25);
      else if (assignment.runType === "drive") assignment.desiredSpeed = CONFIG.player.hsrSpeed * 1.1;
      else if (assignment.runType === "check") assignment.desiredSpeed = CONFIG.player.runSpeed * 1.2;
      if (assignment.runType !== "hold" && assignment.lane > 0.5) assignment.callForBall = true;
      assignment.runTarget = pos(Math.max(assignment.target.x * sign + T.runBeyondLine, u + T.runnerLead), assignment.target.z);
      assignments.set(runner.idx, commit(assignment, runner));
    }

    // Does anyone already offer a genuine forward option? If the runner is checking
    // back, the outlet must stay ahead of the ball — otherwise the carrier has nothing
    // but square and backward passes (the "passing for the sake of passing" symptom).
    const runnerTarget = assignments.get(runner?.idx ?? -1)?.target;
    const someoneAhead = !!runnerTarget && runnerTarget.x * sign > u + 2.5;
    remaining.filter((p) => p.idx !== runner?.idx).forEach((p, i) => {
      const side = Math.abs(anchor.z) > 4 ? ballSide : -(Math.sign(assignments.get(runner?.idx ?? -1)?.target.z ?? -ballSide));
      const outletSide = i === 0 ? side : -side;
      const candidates: Candidate[] = [];
      for (const depth of keeperBuilding ? [10, 14, 6] : [6, 2.5, -2, -4]) {
        for (const width of [T.nearSideWidth, T.halfSpaceWidth, T.farSideMaxWidth]) {
          const isNear = outletSide === ballSide && Math.abs(anchor.z) > 4;
          const keepsAhead = !someoneAhead && depth >= 6;
          candidates.push({ target: pos(u + depth, outletSide * width), mode: `${depth < 0 ? "drop" : "advance"} ${width === T.nearSideWidth ? "wide" : "half-space"} ${outletSide}`,
            preference: (isNear && width === T.nearSideWidth ? 0.17 : width === T.halfSpaceWidth ? 0.08 : 0.05)
              + (phase === "recycle" && depth < 0 ? 0.12 : 0) + (keepsAhead ? 0.30 : 0),
            runType: depth < 0 ? "check" : "hold" });
        }
      }
      // Checking to the ball is a real run type, not just a backwards variant of the
      // outlet: offer a short, safe option in the space the carrier can reach.
      if (!keeperBuilding) {
        for (const width of [T.halfSpaceWidth, T.nearSideWidth]) {
          candidates.push({ target: pos(u - T.checkDepth * 0.7, outletSide * width),
            mode: `check outlet ${outletSide}`, preference: pressure < T.pressureDistance ? 0.30 : 0.06, runType: "check" });
        }
        // Driving run: when the carrier has time, an outlet should advance into the
        // space ahead instead of holding a static web around him.
        if (trigger.active && phase !== "recycle") {
          candidates.push({ target: pos(u + T.driveLead * 0.75, outletSide * T.halfSpaceWidth),
            mode: `driving run half-space ${outletSide}`, preference: 0.24, runType: "drive" });
        }
      }
      const outletPick = pick(p, "outlet", candidates);
      const picked = leadRun(outletPick, p, wantedTravel(outletPick.runType));
      if (picked.runType === "drive") picked.desiredSpeed = CONFIG.player.hsrSpeed;
      else if (picked.runType === "check") picked.desiredSpeed = CONFIG.player.runSpeed * 1.15;
      assignments.set(p.idx, commit(picked, p));
    });

    const keeper = snap.players.find((p) => p.team === team && p.role === "GK" && p.idx !== carrier.idx);
    if (keeper) {
      // Step out enough to form a passing triangle, without abandoning goal protection.
      const keeperU = clamp(u - 11, -halfL + 1.3, -halfL + 5.0);
      assignments.set(keeper.idx, pick(keeper, "keeper-outlet", [-2, 0, 2].map((z) => ({
        target: pos(keeperU, z), mode: `keeper reset ${z}`, preference: z === 0 ? 0.1 : 0,
      }))));
    }
    if (!assignments.size) return null;
    const plan: AttackPlan = { team, carrier: carrier.idx, half: snap.half, phase, at: snap.time, anchor, offsideLine: line, trigger, assignments };
    this.plans.set(team, plan);
    // Forget runs that have expired or are no longer assigned.
    for (const key of [...this.runs.keys()]) {
      if (!key.startsWith(`${team}:`)) continue;
      const memory = this.runs.get(key)!;
      const player = Number(key.split(":")[1]);
      if (memory.expiresAt <= snap.time || !assignments.has(player)) this.runs.delete(key);
    }
    return plan;
  }
}

/** How far ahead of the player a run of each type should be led, in metres. */
function wantedTravel(runType: RunType): number {
  if (runType === "spin") return CONFIG.tactics.spinLead;
  if (runType === "drive") return CONFIG.tactics.driveLead;
  if (runType === "check") return CONFIG.tactics.checkDepth * 0.7;
  return 0;
}
