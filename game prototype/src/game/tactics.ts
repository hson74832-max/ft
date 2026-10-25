import * as THREE from "three";
import { CONFIG } from "./config";
import { tieBreakHash } from "./random";
import type { WorldPlayer, WorldSnap } from "./ai";

export type SupportJob = "pivot" | "outlet" | "runner" | "keeper-outlet";
export type AttackPhase = "build" | "progress" | "finish" | "recycle";
export interface SupportAssignment {
  player: number;
  job: SupportJob;
  target: THREE.Vector3;
  runTarget?: THREE.Vector3;
  mode: string;
  lane: number;
  space: number;
  score: number;
  desiredSpeed: number;
  callForBall: boolean;
}
export interface AttackPlan {
  team: number;
  carrier: number;
  half: 1 | 2;
  phase: AttackPhase;
  at: number;
  anchor: THREE.Vector3;
  offsideLine: number;
  assignments: Map<number, SupportAssignment>;
}

const T = CONFIG.tactics;
const clamp = THREE.MathUtils.clamp;
export const groundDistance = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
export const attackDirection = (team: number, half: 1 | 2) => (team === 0 ? 1 : -1) * (half === 1 ? 1 : -1);
export const nearestSpace = (point: THREE.Vector3, players: readonly WorldPlayer[]) =>
  players.reduce((best, p) => Math.min(best, groundDistance(point, p.pos)), 30);

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

interface Candidate { target: THREE.Vector3; mode: string; preference: number; }

/** One shared plan allocates the three off-ball jobs; players do not all choose width. */
export class TeamTactics {
  private plans = new Map<number, AttackPlan>();

  reset() { this.plans.clear(); }
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
    const ahead = anchor.clone().add(new THREE.Vector3(sign * 5, 0, 0));
    const phase: AttackPhase = pressure < T.pressureDistance && laneSafety(anchor, ahead, fieldOpponents) < 0.6
      ? "recycle" : u > CONFIG.pitch.length / 2 - 13 ? "finish" : u < -5 ? "build" : "progress";
    const previous = this.plans.get(team);
    if (previous && previous.carrier === carrier.idx && previous.half === snap.half && previous.phase === phase
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
      const scored = candidates.map((c) => {
        const point = c.target.clone();
        if (job !== "keeper-outlet") point.x = Math.min(point.x * sign, line - CONFIG.ai.offsideBuffer - 0.3) * sign;
        if (point.x * sign < -halfL + 1.5) point.x = (-halfL + 1.5) * sign;
        const dist = groundDistance(point, anchor);
        const maxDist = job === "runner" ? keeperBuilding ? T.keeperRunnerMaxDistance : T.runnerMaxDistance : T.outletMaxDistance;
        const lane = laneSafety(anchor, point, fieldOpponents);
        const space = nearestSpace(point, fieldOpponents);
        const peers = offBall.filter((m) => m.idx !== p.idx);
        let crowd = 0;
        for (const m of peers) {
          const reserved = assignments.get(m.idx)?.target ?? m.pos;
          crowd += Math.max(0, T.minSupportGap - groundDistance(point, reserved)) * 0.24;
        }
        const stability = prev?.mode === c.mode ? T.targetHysteresis : 0;
        const score = lane * 0.42 + clamp(space / 5, 0, 1) * 0.28 + c.preference + stability
          - Math.max(0, dist - maxDist) * 0.16 - Math.max(0, T.minSupportGap - dist) * 0.32
          - crowd - groundDistance(p.pos, point) * 0.008;
        return { player: p.idx, job, target: point, mode: c.mode, lane, space, score,
          desiredSpeed: job === "runner" ? CONFIG.player.hsrSpeed : CONFIG.player.runSpeed,
          callForBall: lane > T.minSafeLane && space > T.minSafeReceiverSpace && dist > 3 };
      }).sort((a, b) => b.score - a.score || tieBreakHash(snap.matchSeed, p.idx, 0, a.mode) - tieBreakHash(snap.matchSeed, p.idx, 0, b.mode));
      return scored[0];
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
      const assignment = pick(pivot, "pivot", candidates);
      const hasCentralCover = offBall.some((p) => p.pos.x * sign < u - 2 && Math.abs(p.pos.z) <= T.pivotHalfWidth);
      assignment.desiredSpeed = hasCentralCover ? CONFIG.player.runSpeed : CONFIG.ai.maxSprint * 0.88;
      assignments.set(pivot.idx, assignment);
    }

    const remaining = offBall.filter((p) => p.idx !== pivot?.idx);
    const runner = choose(remaining, "runner", pos(Math.min(u + T.runnerLead, line - 0.8), -ballSide * T.halfSpaceWidth), T.runnerRolePreference);
    if (runner) {
      const candidates: Candidate[] = [];
      const goalDistance = halfL - u;
      for (const side of [-1, 1]) {
        const channelWidth = phase === "finish" ? 3.8 : T.halfSpaceWidth;
        const stage = Math.min(u + (keeperBuilding ? T.keeperRunnerLead : T.runnerLead), line - 0.8);
        const far = side !== ballSide;
        candidates.push({ target: pos(stage, side * channelWidth), mode: far ? "far half-space run" : "near channel run", preference: 0.25 + (far && Math.abs(anchor.z) > 4 ? 0.08 : 0) });
        candidates.push({ target: pos(Math.min(u + (keeperBuilding ? T.keeperRunnerLead - 3 : 3.5), line - 0.8), side * T.farSideMaxWidth), mode: side < 0 ? "left diagonal support" : "right diagonal support", preference: 0.04 });
        if (goalDistance < 9) candidates.push({ target: pos(Math.min(halfL - 2.8, line - 0.7), side * 2.2), mode: side < 0 ? "left box arrival" : "right box arrival", preference: 0.24 });
      }
      const assignment = pick(runner, "runner", candidates);
      assignment.runTarget = pos(Math.max(assignment.target.x * sign + T.runBeyondLine, u + T.runnerLead), assignment.target.z);
      if (assignment.lane > 0.55 && pressure > 2) assignment.desiredSpeed = Math.min(CONFIG.ai.maxSprint, CONFIG.player.hsrSpeed * 1.25);
      assignments.set(runner.idx, assignment);
    }

    remaining.filter((p) => p.idx !== runner?.idx).forEach((p, i) => {
      const side = Math.abs(anchor.z) > 4 ? ballSide : -(Math.sign(assignments.get(runner?.idx ?? -1)?.target.z ?? -ballSide));
      const outletSide = i === 0 ? side : -side;
      const candidates: Candidate[] = [];
      for (const depth of keeperBuilding ? [10, 14, 6] : [2.5, -2, -4]) {
        for (const width of [T.nearSideWidth, T.halfSpaceWidth, T.farSideMaxWidth]) {
          const isNear = outletSide === ballSide && Math.abs(anchor.z) > 4;
          candidates.push({ target: pos(u + depth, outletSide * width), mode: `${depth < 0 ? "drop" : "advance"} ${width === T.nearSideWidth ? "wide" : "half-space"} ${outletSide}`,
            preference: (isNear && width === T.nearSideWidth ? 0.17 : width === T.halfSpaceWidth ? 0.08 : 0.05) + (phase === "recycle" && depth < 0 ? 0.12 : 0) });
        }
      }
      assignments.set(p.idx, pick(p, "outlet", candidates));
    });

    const keeper = snap.players.find((p) => p.team === team && p.role === "GK" && p.idx !== carrier.idx);
    if (keeper) {
      // Step out enough to form a passing triangle, without abandoning goal protection.
      const keeperU = clamp(u - 11, -halfL + 1.3, -halfL + 5.0);
      assignments.set(keeper.idx, pick(keeper, "keeper-outlet", [-2, 0, 2].map((z) => ({
        target: pos(keeperU, z), mode: `keeper reset ${z}`, preference: z === 0 ? 0.1 : 0,
      }))));
    }
    const plan: AttackPlan = { team, carrier: carrier.idx, half: snap.half, phase, at: snap.time, anchor, offsideLine: line, assignments };
    this.plans.set(team, plan);
    return plan;
  }
}