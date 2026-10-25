// AI decision layer. Spatial targets, marking, offside discipline, and seeded utility choices.
import * as THREE from "three";
import { CONFIG, FORMATIONS } from "./config";
import { clipExists } from "./anims";
import { SeededRandom, streamSeed, tieBreakHash } from "./random";
import { TeamTactics, groundDistance, laneSafety, nearestSpace, onsideLimit, spaceAhead, type RunType, type SupportJob } from "./tactics";

export interface PlayerStyle {
  directness: number;
  width: number;
  risk: number;
  carry: number;
  shooting: number;
  pressing: number;
  support: number;
  creativity: number;
  finesseSide: -1 | 1;
}

export interface WorldPlayer {
  idx: number; team: number; role: string; roleIdx: number;
  pos: THREE.Vector3; vel: THREE.Vector3; facing: number; speed: number;
  busy: boolean; uninterruptible: boolean;
  cooldowns: Map<string, number>;
  stamina: number; hasBall: boolean;
  callForBall: boolean; isHuman: boolean;
  runSerial: number;
  style: PlayerStyle;
  moveTarget?: THREE.Vector3;
  desiredSpeed?: number;
  pendingPassTo?: number;
  /** Duel state from the engine player (optional for standalone AI fixtures). */
  tackleRecoveryT?: number;
  tackleProtectionT?: number;
}

export interface PassFlight {
  team: number; passer: number; receiver: number; launchedAt: number;
  arrivesAt: number; expiresAt: number; target: THREE.Vector3;
}

export interface WorldSnap {
  ballPos: THREE.Vector3; ballVel: THREE.Vector3;
  ballOwner: number | null; ballOwnerTeam: number | null;
  players: WorldPlayer[];
  time: number; half: 1 | 2; matchSeed: number;
  /** Seconds since the last strike (keeper reaction timing). */
  ballKickAge?: number;
  passFlight?: PassFlight;
  lastPass?: { passer: number; receiver: number; team: number; t: number };
  /** Clock time the current owner gained the ball (carrier "time on the ball"). */
  ownerSince?: number;
  /** Clock time until which the team in possession is in its attacking transition window. */
  transitionUntil?: number;
}

export interface AIDecision {
  moveTarget: THREE.Vector3;
  desiredSpeed: number;
  action: string | null;
  actionTarget?: THREE.Vector3;
  passTo?: number;
  noveltyKey?: string;
  reason: string;
  utilities: Record<string, number>;
  urgent: boolean;
  supportJob?: SupportJob;
  supportMode?: string;
  runType?: RunType;
  runTriggered?: boolean;
  passPurpose?: "progress" | "recycle" | "switch" | "penetrate";
  passOptions?: { receiver: number; lane: number; space: number; gain: number; score: number; purpose: string }[];
}

export interface BallSample { t: number; pos: THREE.Vector3; }

export interface KeeperPosition {
  target: THREE.Vector3;
  advance: number;  // metres in front of the goal line
  lateral: number;  // goal-centred z
  angle: number;    // radians between the goal-line normal and the ball
}

/**
 * Realistic angle positioning: the keeper stands on the line between the ball
 * and the middle of the goal, on a shallow arc whose radius grows with range,
 * biased toward the near post. The old `clamp(x, -19.4, 19.4)` accidentally
 * limited BOTH keepers to 0.6 m off the goal line, leaving the whole shooting
 * angle open. This helper is pure so it can be regression-tested without a GPU.
 */
export function keeperPositionTarget(ball: THREE.Vector3, ownGoal: THREE.Vector3, fieldSign: number): KeeperPosition {
  const A = CONFIG.ai;
  const halfL = CONFIG.pitch.length / 2;
  const goalHalf = CONFIG.pitch.goalWidth / 2;
  const depth = Math.max(0.25, (ball.x - ownGoal.x) * fieldSign);
  const lateral = ball.z;
  const range = Math.max(0.25, Math.hypot(depth, lateral));
  const dirX = depth / range, dirZ = lateral / range;
  const angle = Math.atan2(Math.abs(lateral), depth);
  const maxAdvance = Math.min(A.gkRushLine, A.gkPositionMaxAdvance);
  const base = THREE.MathUtils.clamp(A.gkPositionBase + range * A.gkPositionDepthFactor, A.gkPositionBase, maxAdvance);
  // Come further off the line against a close central threat to narrow the angle.
  const rush = THREE.MathUtils.clamp((12 - depth) / 10, 0, 1) * A.gkRushBonus;
  const radius = THREE.MathUtils.clamp(base + rush, A.gkPositionBase, maxAdvance);
  const advance = THREE.MathUtils.clamp(dirX * radius, A.gkPositionBase, maxAdvance);
  const nearBias = Math.sign(lateral) * A.gkNearPostBias
    * THREE.MathUtils.clamp(Math.abs(lateral) / 8, 0, 1);
  const keeperZ = THREE.MathUtils.clamp(dirZ * radius + nearBias,
    -goalHalf + A.gkNearPostInset, goalHalf - A.gkNearPostInset);
  // Clamp in world coordinates, not to one side of the pitch: the sign above
  // already keeps the keeper in front of the correct goal in either half.
  const keeperX = THREE.MathUtils.clamp(ownGoal.x + fieldSign * advance, -halfL + 0.3, halfL - 0.3);
  return { target: new THREE.Vector3(keeperX, 0, keeperZ), advance, lateral: keeperZ, angle };
}

export class AIController {
  nextThink = new Map<number, number>();
  lastDecision = new Map<number, AIDecision>();
  private recentChoices = new Map<number, string[]>();
  private decisionContext = new Map<number, string>();
  readonly tactics = new TeamTactics();
  /** Engine-provided: true when the physics pass planner can actually deliver this pass. */
  passValidator: ((passerIdx: number, receiverIdx: number, action: string) => boolean) | null = null;
  passPreview: ((passerIdx: number, receiverIdx: number, action: string) => { target: THREE.Vector3; arrivalTime: number; power: number } | null) | null = null;
  /** Engine-provided distribution evaluator (space + lane + pressure), not a distance rule. */
  gkDistribution: ((gkIdx: number) => { action: string; receiverIdx: number; target: THREE.Vector3; reason: string } | null) | null = null;
  private gkRead = new Map<number, { age: number; err: number; timing: number }>();
  /** Last kick cancelled at its contact frame, per player, with its failure streak. */
  private failedKicks = new Map<number, { key: string; count: number }>();
  /** One decision stream per player: a human/spectator branch cannot shift teammates' noise. */
  private playerStreams = new Map<number, SeededRandom>();

  private streamFor(idx: number): SeededRandom {
    let stream = this.playerStreams.get(idx);
    if (!stream) {
      stream = new SeededRandom(streamSeed(this.matchSeed, `ai-player:${idx}`));
      this.playerStreams.set(idx, stream);
    }
    return stream;
  }

  /** Clear per-match decision memory and restore derived streams for a re-stage. */
  resetDecisions(): void {
    this.nextThink.clear();
    this.lastDecision.clear();
    this.recentChoices.clear();
    this.decisionContext.clear();
    this.playerStreams.clear();
    this.gkRead.clear();
    this.failedKicks.clear();
  }

  /** A kick cancelled at its contact frame (no valid receiver by then). Re-deciding
   * into the identical kick would restart the same wind-up forever, so the failed
   * option is penalised, then excluded — see possessionDecision. */
  noteKickFailed(idx: number, action: string, passTo?: number) {
    const key = `${action}:${passTo ?? -1}`;
    const prev = this.failedKicks.get(idx);
    this.failedKicks.set(idx, { key, count: prev && prev.key === key ? prev.count + 1 : 1 });
  }

  /** The player got a kick away: the failure streak no longer applies. */
  noteKickReleased(idx: number) { this.failedKicks.delete(idx); }

  /** How many of the player's most recent committed choices are this exact key. */
  private repeatStreak(idx: number, key: string): number {
    const entries = this.recentChoices.get(idx) ?? [];
    let streak = 0;
    for (let i = entries.length - 1; i >= 0 && entries[i] === key; i--) streak++;
    return streak;
  }

  private pointNearSegment(pt: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, radius: number): boolean {
    const ab = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    const len2 = ab.lengthSq();
    if (len2 < 1e-6) return false;
    const t = THREE.MathUtils.clamp(((pt.x - a.x) * ab.x + (pt.z - a.z) * ab.z) / len2, 0, 1);
    return Math.hypot(a.x + ab.x * t - pt.x, a.z + ab.z * t - pt.z) < radius;
  }

  constructor(private rng: SeededRandom, private matchSeed: number) {}

  sampleStyle(role: string, idx?: number): PlayerStyle {
    // With an index the style comes from that player's own stream: building
    // (or removing) one player cannot re-roll every teammate's attributes.
    const rng = idx === undefined ? this.rng : new SeededRandom(streamSeed(this.matchSeed, `ai-style:${idx}`));
    const fieldBias = role === "FWD" ? 0.08 : role === "DEF" ? -0.02 : 0;
    return {
      directness: rng.range(0.72, 1.34) + fieldBias,
      width: rng.range(0.78, 1.34),
      risk: rng.range(0.72, 1.35),
      carry: rng.range(0.7, 1.38),
      shooting: rng.range(0.72, 1.38) + (role === "FWD" ? 0.12 : 0),
      pressing: rng.range(0.78, 1.32) + (role === "DEF" || role === "MID" ? 0.06 : 0),
      support: rng.range(0.8, 1.3),
      creativity: rng.range(0.7, 1.4),
      finesseSide: rng.next() < 0.5 ? -1 : 1,
    };
  }

  attackSign(team: number, half: 1 | 2): number {
    const firstHalf = team === 0 ? 1 : -1;
    return half === 1 ? firstHalf : -firstHalf;
  }

  goalPos(team: number, half: 1 | 2): THREE.Vector3 {
    return new THREE.Vector3(this.attackSign(team, half) * (CONFIG.pitch.length / 2), 0, 0);
  }

  ownGoal(team: number, half: 1 | 2): THREE.Vector3 {
    return new THREE.Vector3(-this.attackSign(team, half) * (CONFIG.pitch.length / 2), 0, 0);
  }

  think(p: WorldPlayer, roleIdx: number, snap: WorldSnap, now: number): AIDecision {
    const gate = this.nextThink.get(p.idx) ?? 0;
    // Keepers facing an inbound shot re-evaluate every frame: a 25 m/s shot crosses the
    // box in ~0.5 s, so a 0.28 s decision gate made them physically unable to respond.
    const shotInbound = p.role === "GK" && !!this.readShot(p, snap, this.ownGoal(p.team, snap.half));
    // A 1v1 carrier moves the keeper's target metres per think gate, like a shot.
    const oneOnOne = p.role === "GK" && !!this.oneOnOneCarrier(p, snap, this.ownGoal(p.team, snap.half));
    const context = `${snap.half}:${snap.ballOwner}:${snap.passFlight?.launchedAt ?? -1}`;
    if (!shotInbound && !oneOnOne && now < gate && this.decisionContext.get(p.idx) === context && this.lastDecision.has(p.idx)) return this.lastDecision.get(p.idx)!;
    this.decisionContext.set(p.idx, context);
    // Real AI decision delay: outfield 0.28 s, goalkeeper 0.35 s. Use a
    // per-player stream so skipping one player's think (human/spectator mode)
    // cannot shift the random sequence of every other player.
    const rng = this.streamFor(p.idx);
    const baseDelay = p.role === "GK" ? CONFIG.ai.gkDecisionDelay : CONFIG.ai.reactionDelay;
    this.nextThink.set(p.idx, now + baseDelay * rng.range(0.72, 1.3));

    const noise = (scale = 1) => rng.range(-1, 1) * CONFIG.ai.decisionNoise * scale;
    const d = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b);
    const mates = snap.players.filter((q) => q.team === p.team && q.idx !== p.idx);
    const atkSign = this.attackSign(p.team, snap.half);
    const atkGoal = this.goalPos(p.team, snap.half);
    const ownGoal = this.ownGoal(p.team, snap.half);
    const ownU = (v: THREE.Vector3) => v.x * atkSign;
    const novelty = (key: string) => {
      const entries = this.recentChoices.get(p.idx) ?? [];
      const repeated = entries.filter((k) => k === key).length;
      return Math.min(0.38, repeated * CONFIG.ai.noveltyPenalty);
    };
    const jitter = (key: string) => tieBreakHash(this.matchSeed, p.idx, p.runSerial, key) * 0.018;

    if (p.role === "GK") {
      const gk = this.goalkeeperDecision(p, mates, snap, now, ownGoal, atkGoal, noise, rng);
      return this.store(p.idx, gk);
    }

    if (p.hasBall) return this.store(p.idx, this.possessionDecision(p, snap, noise, novelty, jitter, rng));

    if (snap.ballOwner === null && snap.passFlight?.receiver === p.idx) {
      const target = snap.passFlight.target.clone();
      return this.store(p.idx, {
        moveTarget: target, desiredSpeed: CONFIG.ai.maxSprint, action: null,
        reason: `RECEIVE #${p.idx}: attack the named delivery`,
        utilities: { receive: 1, arrival: Math.max(0, snap.passFlight.arrivesAt - now) }, urgent: true,
        supportJob: "runner", supportMode: "receive after release",
      });
    }

    if (snap.ballOwnerTeam === p.team || (snap.ballOwner === null && snap.passFlight?.team === p.team)) {
      const plan = this.tactics.plan(snap, p.team);
      const job = plan?.assignments.get(p.idx);
      if (job) {
        const target = job.target.clone();
        p.callForBall = job.callForBall;
        const running = job.runType === "spin" || job.runType === "drive";
        return this.store(p.idx, {
          moveTarget: target, desiredSpeed: job.desiredSpeed, action: null,
          reason: `${job.job.toUpperCase()}/${job.runType.toUpperCase()}: ${job.mode} | ${plan?.phase} | width ${Math.abs(target.z).toFixed(1)}m | depth ${(target.x * atkSign).toFixed(1)}m | advance ${job.advance.toFixed(1)}m | space ahead ${job.vacancy.toFixed(2)}${job.callForBall ? " | CALL" : ""}${plan?.trigger.active ? " | TRIGGERED" : ""}`,
          supportJob: job.job, supportMode: job.mode, runType: job.runType, runTriggered: plan?.trigger.active,
          utilities: { support: job.score, lane: job.lane, space: job.space, vacancy: job.vacancy,
            advance: job.advance, cover: job.job === "pivot" ? 1 : 0, triggered: plan?.trigger.active ? 1 : 0 },
          urgent: job.job === "pivot" || (running && !!plan?.trigger.active),
        });
      }
    }

    if (snap.ballOwner === null) {
      const intercept = this.bestInterceptor(snap, p.team);
      if (intercept && intercept.idx === p.idx) {
        const predicted = this.projectBall(snap, intercept.time).pos;
        const dist = d(p.pos, predicted);
        const action = dist < 1.7 && snap.ballVel.length() > 1.6 && this.can(p, "intercept") ? "intercept" : null;
        return this.store(p.idx, {
          moveTarget: predicted, desiredSpeed: CONFIG.ai.maxSprint * (0.9 + p.style.pressing * 0.04),
          action, actionTarget: predicted.clone(), noveltyKey: `intercept:${Math.round(predicted.x / 3)}:${Math.round(predicted.z / 3)}`,
          reason: `Intercept trajectory · t=${intercept.time.toFixed(2)}s · ${dist.toFixed(1)}m`,
          utilities: { intercept: 1, arrivalSlack: intercept.slack }, urgent: true,
        });
      }
      const predicted = this.projectBall(snap, 0.7).pos;
      const anchor = this.supportTarget(p, roleIdx, snap, predicted, atkSign);
      const spaced = this.applySpacing(anchor, p, mates, -1, atkSign);
      if (CONFIG.ai.offside && p.role !== "DEF") this.clampOnside(spaced, snap.ballPos, p.team, snap);
      return this.store(p.idx, {
        moveTarget: spaced, desiredSpeed: p.role === "DEF" ? 3.6 : 4.2,
        action: null, noveltyKey: "loose-shape", reason: `Recover shape toward projected ball · ${this.channelName(anchor.z)}`,
        utilities: { shape: 0.72, trajectory: 0.8 }, urgent: false,
      });
    }

    const carrier = snap.players.find((q) => q.idx === snap.ballOwner);
    if (!carrier) return this.store(p.idx, {
      moveTarget: this.supportTarget(p, roleIdx, snap, snap.ballPos, atkSign), desiredSpeed: 3.5,
      action: null, reason: "Recover shape", utilities: { shape: 0.6 }, urgent: false,
    });

    const fieldMates = snap.players.filter((q) => q.team === p.team && q.role !== "GK");
    const presser = [...fieldMates].sort((a, b) => {
      const sa = d(a.pos, carrier.pos) - (a.role === "MID" ? 0.25 : 0);
      const sb = d(b.pos, carrier.pos) - (b.role === "MID" ? 0.25 : 0);
      return sa - sb || tieBreakHash(this.matchSeed, a.idx, a.runSerial, "press") - tieBreakHash(this.matchSeed, b.idx, b.runSerial, "press");
    })[0];
    const def = fieldMates.filter((q) => q.role === "DEF");
    const closestDef = [...def].sort((a, b) => d(a.pos, carrier.pos) - d(b.pos, carrier.pos)
      || tieBreakHash(this.matchSeed, a.idx, a.runSerial, "defend") - tieBreakHash(this.matchSeed, b.idx, b.runSerial, "defend"))[0];
    const carrierLocal = ownU(carrier.pos);
    const centerThreat = carrierLocal < CONFIG.ai.defensiveStepDistance && carrierLocal > -18.5 && Math.abs(carrier.pos.z) < 7.2;
    const shotThreat = centerThreat && d(carrier.pos, ownGoal) < 23.5;
    const assignments = this.markerAssignments(snap, p.team);
    const markedOpponent = assignments.get(p.idx);
    // Team AI: the side's pressing mentality scales how hard the whole unit
    // steps out and hunts the carrier, on top of each player's own style.
    const teamPressing = this.tactics.teamStyle(p.team, snap.matchSeed).pressing;

    // Back line steps out to close the central carrier AND the partner covers the shooting lane.
    if (p.role === "DEF" && centerThreat) {
      const isClosest = closestDef?.idx === p.idx;
      const toOwn = ownGoal.clone().sub(carrier.pos).setY(0).normalize();
      const block = carrier.pos.clone().addScaledVector(toOwn, isClosest ? (shotThreat ? 2.2 : 2.8) : 3.9);
      // Both centre-backs pinch the centre; the covering one balances the far post.
      block.z = THREE.MathUtils.clamp(block.z, -5.4, 5.4) * (isClosest ? 0.35 : 0.16);
      block.z += isClosest ? 0 : (p.roleIdx === 1 ? -1.5 : 1.5);
      block.x = THREE.MathUtils.clamp(block.x, -18.6, 18.6);
      const distance = d(p.pos, carrier.pos);
      const action = isClosest && distance < 1.55 && this.canTackle(p, snap, "tackle_stand") ? "tackle_stand"
        : isClosest && distance < 2.5 && p.style.risk > 1.12 && this.canTackle(p, snap, "tackle_slide") ? "tackle_slide" : null;
      return this.store(p.idx, {
        moveTarget: block, desiredSpeed: CONFIG.ai.maxSprint * p.style.pressing * teamPressing,
        action, actionTarget: carrier.pos.clone(), noveltyKey: `step:${Math.round(carrierLocal / 4)}:${isClosest ? 1 : 0}`,
        reason: isClosest
          ? `DEF STEP · close ${shotThreat ? "central shot lane" : "carrier"} · ${distance.toFixed(1)}m`
          : `DEF COVER · pinch centre, protect far post · ${distance.toFixed(1)}m`,
        utilities: { step: 1, shotThreat: shotThreat ? 1 : 0.55, lane: isClosest ? 0.9 : 0.7 }, urgent: true,
      });
    }

    if (p.idx === presser?.idx) {
      const dist = d(p.pos, carrier.pos);
      let action: string | null = null;
      if (dist < 1.5 && this.canTackle(p, snap, "tackle_stand")) action = "tackle_stand";
      else if (dist < 2.55 && dist > 1.4 && p.style.risk > 1.02 && this.canTackle(p, snap, "tackle_slide")) action = "tackle_slide";
      // Press the carrier's NEXT position, and when the defender has been played past
      // (he is ball-side of the carrier) cut back to the goal side instead of trailing
      // him — that is the run that ended up behind a winger at the touchline with the
      // centre open. A defender who is already goal-side presses straight at the ball.
      const pressPoint = carrier.pos.clone().addScaledVector(carrier.vel, 0.2);
      if ((p.pos.x - carrier.pos.x) * atkSign > 0.2) {
        const toOwn = ownGoal.clone().sub(carrier.pos).setY(0).normalize();
        pressPoint.addScaledVector(toOwn, p.role === "DEF" ? 1.2 : 0.5);
      }
      return this.store(p.idx, {
        moveTarget: pressPoint, desiredSpeed: (dist < CONFIG.ai.pressRadius ? CONFIG.ai.maxSprint : CONFIG.ai.maxSprint * 0.82) * p.style.pressing * teamPressing,
        action, actionTarget: carrier.pos.clone(), noveltyKey: "press-carrier",
        reason: action ? `${action} · press trigger` : `Press carrier · goal-side · ${dist.toFixed(1)}m`,
        utilities: { press: 1, distance: dist }, urgent: true,
      });
    }

    if (p.role === "DEF") {
      const line = this.defensiveLineTarget(p, carrier, ownGoal, atkSign);
      if (centerThreat && markedOpponent && markedOpponent.role !== "GK" && ownU(markedOpponent.pos) < 1 && d(markedOpponent.pos, p.pos) < CONFIG.ai.markDistance) {
        const goalSide = markedOpponent.pos.clone().lerp(ownGoal, 0.22);
        const blend = shotThreat ? 0.36 : 0.2;
        line.lerp(goalSide, blend);
      }
      return this.store(p.idx, {
        moveTarget: this.applySpacing(line, p, mates, carrier.idx, atkSign), desiredSpeed: shotThreat ? 4.8 : 3.8,
        action: null, noveltyKey: `line:${Math.round(line.z / 2)}`,
        reason: `Back line · ${shotThreat ? "step to close centre" : "hold & track"}`, utilities: { line: 0.86, mark: markedOpponent ? 0.68 : 0.3 }, urgent: false,
      });
    }

    // Team defensive compaction in front of our own goal: when the ball is in the
    // defensive third, non-pressing outfielders drop into the central corridor
    // between ball and goal instead of worrying about a wide marker first.
    const ballOwnU = ownU(carrier.pos);
    // Threat zone: anywhere within ~22 m of our goal (own local x < -2). The old -10
    // check only triggered 10 m out, leaving the space in front of the box open.
    if (p.role !== "DEF" && ballOwnU < -2 && ballOwnU > -20) {
      // Drop between ball and goal, in a tight central band: the primary job when the
      // ball reaches the defensive third is closing the corridor in front of goal.
      // Goal-side of the ball by ~2 m, never deeper than the six-yard line.
      const dropU = THREE.MathUtils.clamp(ballOwnU - 2.0, -17.5, ownU(p.pos));
      const z = THREE.MathUtils.clamp(carrier.pos.z * 0.22 + (p.idx % 2 === 0 ? -1.7 : 1.7), -3.6, 3.6);
      const compact = new THREE.Vector3(dropU * atkSign, 0, z);
      return this.store(p.idx, {
        moveTarget: this.applySpacing(compact, p, mates, carrier.idx, atkSign), desiredSpeed: 5.2,
        action: null, noveltyKey: "central-compact",
        reason: `Compact centre · goal-side of ball · ${(ballOwnU + 20).toFixed(0)}m from line`,
        utilities: { compact: 1, goalSide: 0.9 }, urgent: true,
      });
    }

    // Every off-ball opponent gets a unique mark assignment where practical.
    if (markedOpponent && d(p.pos, markedOpponent.pos) < CONFIG.ai.markDistance + 3) {
      // Mark where the attacker is going, and always on the goal side of him: a
      // defender who runs at the attacker's current position trails the ball and ends
      // up between the attacker and the halfway line instead of between him and goal.
      const goalSide = markedOpponent.pos.clone().addScaledVector(markedOpponent.vel, 0.35)
        .lerp(ownGoal, 0.24);
      const beaten = ownU(p.pos) > ownU(markedOpponent.pos) + 0.2;
      if (beaten) goalSide.lerp(ownGoal, 0.14);
      return this.store(p.idx, {
        moveTarget: goalSide, desiredSpeed: beaten ? CONFIG.ai.maxSprint : 4.1 * p.style.pressing, action: null,
        noveltyKey: `mark:${markedOpponent.idx}`,
        reason: `Track ${markedOpponent.role} #${markedOpponent.idx} · goal-side${beaten ? " · recovering" : ""} · ${d(p.pos, markedOpponent.pos).toFixed(1)}m`,
        utilities: { mark: 0.85, press: 0.25 }, urgent: beaten,
      });
    }
    if (fieldMates.length > 1) {
      const cover = carrier.pos.clone().lerp(ownGoal, 0.32);
      cover.z += p.idx % 2 === 0 ? -2.1 : 2.1;
      cover.z = THREE.MathUtils.clamp(cover.z, -9.5, 9.5);
      return this.store(p.idx, {
        moveTarget: this.applySpacing(cover, p, mates, carrier.idx, atkSign), desiredSpeed: 4,
        action: null, noveltyKey: "cover-lane", reason: "Cover passing lane · goal-side", utilities: { cover: 0.78 }, urgent: false,
      });
    }
    return this.store(p.idx, {
      moveTarget: this.supportTarget(p, roleIdx, snap, snap.ballPos, atkSign), desiredSpeed: 3.5,
      action: null, reason: "Defensive shape", utilities: { shape: 0.6 }, urgent: false,
    });
  }

  private possessionDecision(
    p: WorldPlayer, snap: WorldSnap, noise: (scale?: number) => number,
    novelty: (key: string) => number, jitter: (key: string) => number,
    rng: SeededRandom,
  ): AIDecision {
    const T = CONFIG.tactics;
    const sign = this.attackSign(p.team, snap.half);
    const goal = this.goalPos(p.team, snap.half);
    const opponents = snap.players.filter((q) => q.team !== p.team);
    const field = opponents.filter((q) => q.role !== "GK");
    const mates = snap.players.filter((q) => q.team === p.team && q.idx !== p.idx);
    const plan = this.tactics.plan(snap, p.team);
    // Attacking phase governs how much the carrier values progression over safety.
    // `transition` is the explicit state the old AI lacked: possession just won from
    // the opponent — pass/carry forward first, recycle only if nothing is on.
    const phase = plan?.phase ?? "progress";
    const baseWeights = T.phaseWeights[phase] ?? T.phaseWeights.progress;
    // Team AI: the side's mentality tilts the collective gain-vs-safety
    // tradeoff for every carrier; the individual scores below are unchanged.
    const teamDirectness = plan?.teamStyle.directness ?? 1;
    const weights = {
      gain: baseWeights.gain * teamDirectness,
      safety: baseWeights.safety * (2 - teamDirectness),
      hazard: baseWeights.hazard,
    };
    const trigger = plan?.trigger;
    const distance = groundDistance(p.pos, goal);
    const pressure = nearestSpace(p.pos, field);
    const pressed = pressure < T.pressureDistance;
    const goalDir = goal.clone().sub(p.pos).setY(0).normalize();
    const aim = this.chooseShotAim(p, snap, opponents, [-1.05, -0.55, 0, 0.55, 1.05], goal, jitter);
    const shotLane = laneSafety(p.pos, aim, field, CONFIG.player.kickPower.shoot);
    const goalDepth = Math.max(0.01, (goal.x - p.pos.x) * sign);
    const opening = Math.abs(Math.atan2(CONFIG.pitch.goalWidth / 2 - p.pos.z, goalDepth)
      - Math.atan2(-CONFIG.pitch.goalWidth / 2 - p.pos.z, goalDepth));
    // A 0.25 rad (~14°) window is a full-size target; a partially blocked lane is a
    // worse shot, not a disqualified one.
    const windowRatio = THREE.MathUtils.clamp(opening / 0.25, 0.12, 1);
    const inRange = distance <= T.edgeShotDistance && opening >= T.shotMinOpening;
    const clearChance = distance < T.clearShotDistance && shotLane >= T.shotLaneThreshold && pressure > 1.7 && opening > 0.24;
    const edgeChance = inRange && shotLane > 0.62;
    const quality = inRange
      ? THREE.MathUtils.clamp(1 - distance / (T.edgeShotDistance + 4), 0, 1) * (0.30 + 0.70 * shotLane) * windowRatio
      : 0;
    const shotKey = `shoot:${Math.floor(distance / 4)}`;
    // Shot score: expected-goal quality (distance, lane, window) scaled by the
    // shooter's finishing style, minus block risk under pressure and fatigue.
    const shoot = inRange
      ? 0.26 + quality * 1.5 + (clearChance ? 0.45 : 0) + (edgeChance ? 0.18 : 0) + p.style.shooting * 0.07
        - (pressed && shotLane < 0.4 ? 0.18 : 0) - novelty(shotKey) * 0.2 - (1 - p.stamina) * 0.18
      : -1;
    const shotId = ["shoot_normal", "shoot_finesse"].find((id) => this.can(p, id));
    const lineU = this.defensiveLineU(snap, p.team);

    type Option = { mate: WorldPlayer; target: THREE.Vector3; id: string; key: string; lane: number; space: number;
      gain: number; score: number; purpose: NonNullable<AIDecision["passPurpose"]>; safe: boolean; crossesLine: boolean;
      crossBall: boolean };
    const options: Option[] = [];
    for (const mate of mates) {
      if (this.isOffsidePosition(mate.pos, snap.ballPos, p.team, snap)) continue;
      const currentDistance = groundDistance(snap.ballPos, mate.pos);
      if (currentDistance < 2 || currentDistance > 27) continue;
      const job = plan?.assignments.get(mate.idx);
      const gainNow = (mate.pos.x - p.pos.x) * sign;
      // A player making a run gets the through ball; a static option does not.
      const runnable = (job?.runType === "spin" || job?.runType === "drive") && !!trigger?.active;
      const tryThrough = (job?.job === "runner" && gainNow > 1.5 && this.can(p, "pass_through"))
        || (runnable && gainNow > 3 && this.can(p, "pass_through"));
      const actions = tryThrough ? ["pass_through", currentDistance > 13 ? "pass_long" : "pass_short"]
        : [currentDistance > 13 ? "pass_long" : "pass_short"];
      let id: string | undefined;
      let target = mate.pos.clone().addScaledVector(mate.vel, 0.35);
      for (const action of actions) {
        if (!this.can(p, action)) continue;
        if (this.passPreview) {
          const preview = this.passPreview(p.idx, mate.idx, action);
          if (!preview) continue;
          target = preview.target.clone();
        } else if (this.passValidator && !this.passValidator(p.idx, mate.idx, action)) continue;
        id = action; break;
      }
      if (!id) continue;
      // This exact kick already failed at its contact frame twice in a row:
      // excluded once, so the re-decision must find another way out.
      const failed = this.failedKicks.get(p.idx);
      if (failed && failed.key === `${id}:${mate.idx}` && failed.count >= 2) continue;
      const gain = (target.x - p.pos.x) * sign;
      const lane = laneSafety(snap.ballPos, target, field, id === "pass_long" ? 17 : 11);
      // Use both the current marker and predicted position: a marked player is not
      // "open" merely because constant-velocity extrapolation puts them in empty space.
      const space = Math.min(nearestSpace(target, field), nearestSpace(mate.pos, field) + 0.8);
      const crowd = mates.filter((q) => q.idx !== mate.idx)
        .reduce((n, q) => n + Math.max(0, 3 - groundDistance(target, q.pos)) / 3, 0);
      const backward = gain < -1.5;
      // Beating the last line is progression even if the pass itself is short.
      const crossesLine = target.x * sign > lineU + 0.5 && gain > 1.5;
      // Delivery intent. A wide carrier in the attacking third has a cross on when a
      // teammate attacks the box; a long ball across the pitch is a switch of play.
      // Neither was ever scored, so the AI only ever played the square ball infield.
      const wideCarrier = Math.abs(p.pos.z) > T.halfSpaceWidth
        && p.pos.x * sign > CONFIG.pitch.length / 2 - 16;
      const boxTarget = target.x * sign > CONFIG.pitch.length / 2 - 10 && Math.abs(target.z) < 8;
      const crossBall = wideCarrier && boxTarget && currentDistance > 8;
      const longSwitch = Math.abs(target.z - p.pos.z) > 12 && id === "pass_long" && gain > -2;
      const purpose: Option["purpose"] = backward && (mate.role === "GK" || job?.job === "pivot" || Math.abs(target.z) < T.pivotHalfWidth + 0.5)
        ? "recycle"
        : id === "pass_through" || crossesLine || crossBall ? "penetrate"
          : Math.abs(target.z - p.pos.z) > 6 && gain > -2 ? "switch" : "progress";
      const safe = lane >= T.minSafeLane && space >= T.minSafeReceiverSpace;
      const key = `pass:${mate.idx}`;
      const returnPass = snap.lastPass?.receiver === p.idx && snap.lastPass.passer === mate.idx
        && snap.time - snap.lastPass.t < T.returnPassWindow;
      // Pass score: completion probability (lane + receiver space) times
      // forward progress (gain, line-breaking), minus turnover risk (crowded
      // or marked receiver, shut lane) and repetition.
      let score = lane * weights.safety + THREE.MathUtils.clamp(space / 5, 0, 1) * 0.20
        + THREE.MathUtils.clamp(gain / 12, -0.6, 1) * weights.gain
        + (crossesLine && safe ? 0.16 : 0)
        + (purpose === "penetrate" && safe ? 0.18 : 0)
        + (purpose === "switch" && safe ? 0.10 : 0)
        // A cross is aimed at a marked man by design: the box being occupied is the
        // point of the ball, so a cross is scored on its delivery lane and not on the
        // receiver's crowding. Ground passes keep the old penalties.
        - crowd * 0.17 - (crossBall ? 0 : (space < 1.5 ? 0.35 : 0)) - (lane < 0.35 ? 0.4 : 0)
        - novelty(key) * 0.35
        // Novelty saturates (0.38 cap ≈ 0.13 of score): a clearly-best pass
        // stayed best forever and A→B→A→B cycled deterministically. The
        // consecutive-repeat streak is uncapped, so repetition always
        // eventually costs more than the lane is worth.
        - this.repeatStreak(p.idx, key) * CONFIG.ai.noveltyPenalty
        - (failed && failed.key === `${id}:${mate.idx}` ? failed.count * CONFIG.ai.noveltyPenalty : 0)
        + noise(0.16) + jitter(key)
        + (crossBall ? 0.16 + (lane > 0.4 ? 0.2 : 0) : 0)
        + (longSwitch && lane > T.minSafeLane ? 0.12 : 0);
      // Circulation with no threat: a square ball to a congested area costs more in
      // transition, when we are meant to be attacking the other way.
      if (Math.abs(gain) < 2 && Math.abs(target.z - p.pos.z) < 4 && !pressed) score -= weights.hazard * 0.9;
      if (returnPass && !pressed) score -= T.returnPassPenalty;
      if (clearChance) score -= 0.35;
      options.push({ mate, target, id, key, lane, space, gain, score, purpose, safe, crossesLine, crossBall });
    }

    const dribble = this.chooseDribbleLane(p, goalDir, field, mates,
      (v) => THREE.MathUtils.clamp(nearestSpace(v, field) / 5, 0, 1), noise, jitter, novelty);
    const carryLane = laneSafety(p.pos, dribble.target, field, CONFIG.player.runSpeed);
    const forwardSpace = spaceAhead(p.pos, field, sign);
    const safeProgress = options.some((o) => o.gain > 2 && o.safe);
    // A reset is the emergency valve, not the default. Being merely "under pressure"
    // (3.2 m) is not enough: turn back only when the carrier is actually smothered or
    // the carry lane is shut.
    const underRealPressure = pressure < T.pressureDistance * 0.7;
    const needsReset = !safeProgress && (underRealPressure || carryLane < 0.4) && !clearChance && !edgeChance;
    for (const o of options) {
      if (o.purpose === "recycle" && o.safe && needsReset) o.score += 0.5;
      else if (o.safe && pressed) o.score += 0.12;
      // In transition, a forward option that is merely imperfect beats a safe square ball.
      if (phase === "transition" && o.gain > 3 && o.lane > 0.3) o.score += 0.12;
      if (o.purpose === "recycle" && !needsReset) o.score -= (phase === "build" ? 0.22 : 0.34);
      if (o.mate.role === "GK") o.score -= 0.05; // prefer a safe nearby pivot if both are available
    }
    options.sort((a, b) => b.score - a.score || jitter(a.key) - jitter(b.key));
    // Sample the pass probabilistically from the near-best pool instead of a
    // hard argmax: with scores this close the "best" pass is a coin the
    // deterministic code kept landing on the same side, which is what made
    // passing patterns repeat verbatim. Weight falls off exponentially with
    // the score gap (temperature = the existing decision-noise scale), so a
    // clearly superior pass is still picked almost always.
    let best = options[0];
    if (best && options.length > 1) {
      const topScore = best.score;
      // Like-for-like only: sampling must not turn the preferred pivot recycle
      // into a 23 m back-pass to the keeper (or vice versa) because the keeper
      // always has acres of space, and must not trade a safe ball for an
      // unsafe one. The keeper boundary and the safety class stay deterministic.
      const pool = options.filter((o) => o.score >= topScore - CONFIG.ai.decisionNoise * 3
        && (o.mate.role === "GK") === (best.mate.role === "GK")
        && (!best.safe || o.safe));
      if (pool.length > 1) {
        best = rng.weighted(pool.map((o) => ({
          value: o, weight: Math.exp((o.score - topScore) / CONFIG.ai.decisionNoise),
        })));
      }
    }
    // Carrying into vacant space is progression too: value the ground ahead, not
    // only the lane the ball is on right now.
    // Carrying past a defender who is already on top of you is not "progression": it
    // is the turnover the report describes. Value the space ahead only while there is
    // room to actually use it.
    // Dribble score: space ahead and the chosen lane, minus pressure /
    // tackle risk and the stamina cost of carrying at pace.
    const carry = dribble.score + forwardSpace * 0.14 + (trigger?.active ? 0.06 : 0)
      - (pressed ? 0.25 : 0) - (needsReset ? 0.12 : 0) - (1 - p.stamina) * 0.22
      - THREE.MathUtils.clamp((2.5 - pressure) / 2.5, 0, 1) * 0.45;
    const utilities = { shoot, pass: best?.score ?? -1, dribble: carry, shotLane, opening, shotQuality: quality,
      pressure, carryLane, forwardSpace, reset: needsReset ? 1 : 0, passLane: best?.lane ?? 0,
      runTrigger: trigger?.active ? 1 : 0 };
    const passOptions = options.map((o) => ({ receiver: o.mate.idx, lane: o.lane, space: o.space, gain: o.gain, score: o.score, purpose: o.purpose }));
    const runsOn = plan ? `${trigger?.active ? "RUNS ON" : "runs off"}${plan.assignments.size ? ` · ${[...plan.assignments.values()].filter((a) => a.runType === "spin" || a.runType === "drive").length} running` : ""}` : "no plan";

    // Own-box safety valve. A defender who wins the ball deep and is surrounded must
    // not dribble or thread a square ball into the swarm: with no outlet that is
    // genuinely safe he clears it long and out of danger. `pass_long` with no named
    // receiver is resolved at the contact frame as a clearance kick. A back-pass to the
    // keeper from inside your own box under the press is not a safe outlet — it is the
    // ball the swarm wants — so the lane/space tests decide, not the pass purpose.
    const ownGoalPos = this.ownGoal(p.team, snap.half);
    const depthFromOwnGoal = (p.pos.x - ownGoalPos.x) * sign;
    const inOwnBox = Math.abs(p.pos.x - ownGoalPos.x) < 5.8 && Math.abs(p.pos.z) < 6.2;
    const safeOutlet = options.some((o) => o.lane >= T.minSafeLane && o.space >= T.minSafeReceiverSpace
      && !(o.mate.role === "GK" && inOwnBox));
    // Immediate danger is arrival time, not mere proximity. The old test —
    // nearest opponent inside 3.2 m — counted one static attacker marking
    // space as "swarmed" and booted the ball away with time to play. Clear
    // only when the nearest opponent can actually reach the carrier within
    // ~1 s (or is already inside tackling range), there is no safe outlet,
    // and no forward lane to carry out of trouble.
    const nearestOpp = field.reduce<WorldPlayer | null>(
      (acc, q) => (acc === null || groundDistance(q.pos, p.pos) < groundDistance(acc.pos, p.pos) ? q : acc), null);
    let closing = 0;
    if (nearestOpp && pressure > 0.01) {
      const ux = (p.pos.x - nearestOpp.pos.x) / pressure, uz = (p.pos.z - nearestOpp.pos.z) / pressure;
      closing = (nearestOpp.vel.x - p.vel.x) * ux + (nearestOpp.vel.z - p.vel.z) * uz;
    }
    const imminent = pressure < 1.55 || (closing > 0.5 && pressure / closing < 1);
    const forwardEscape = (dribble.target.x - p.pos.x) * sign > 0.5 && carryLane >= 0.4;
    if ((inOwnBox || depthFromOwnGoal < CONFIG.pitch.length * 0.35) && imminent && !safeOutlet && !forwardEscape) {
      const escape = new THREE.Vector3(goal.x, 0,
        THREE.MathUtils.clamp(p.pos.z * 0.2 + (p.pos.z >= 0 ? -2.5 : 2.5), -6.5, 6.5));
      return { moveTarget: p.pos.clone(), desiredSpeed: 0, action: "pass_long", actionTarget: escape,
        noveltyKey: "clearance",
        reason: `CLEARANCE · ${inOwnBox ? "own box" : "deep"} · attacker arriving ${pressure.toFixed(1)}m @ ${closing.toFixed(1)}m/s · no safe outlet · no escape lane · ${depthFromOwnGoal.toFixed(1)}m from own goal`,
        utilities, urgent: true };
    }

    if (shotId && inRange && shotLane > T.shotPartialLane
      && (clearChance || (edgeChance && quality > 0.14) || shoot > Math.max(best?.score ?? -1, carry) + 0.04)) {
      return { moveTarget: p.pos.clone(), desiredSpeed: 0, action: shotId, actionTarget: aim, noveltyKey: shotKey,
        reason: `SHOOT ${clearChance ? "clear chance" : edgeChance ? "edge of area" : "partial lane"}: ${distance.toFixed(1)}m, lane ${shotLane.toFixed(2)}, window ${(opening * 180 / Math.PI).toFixed(0)}deg, quality ${quality.toFixed(2)} · ${runsOn}`,
        utilities, passOptions, urgent: true };
    }
    if (best && best.score > Math.max(0.4, carry) && best.lane > 0.35) {
      return { moveTarget: p.pos.clone(), desiredSpeed: 0, action: best.id, actionTarget: best.target,
        passTo: best.mate.idx, passPurpose: best.purpose, noveltyKey: best.key,
        reason: `${best.purpose.toUpperCase()} -> #${best.mate.idx} ${best.mate.role}: lane ${best.lane.toFixed(2)}, space ${best.space.toFixed(1)}m, gain ${best.gain.toFixed(1)}m${best.crossesLine ? ", line broken" : ""} · ${phase} · ${runsOn}`,
        utilities, passOptions, urgent: needsReset || best.purpose === "penetrate" || phase === "transition" };
    }
    // When there is room, carrying into it has value. Do not manufacture square passes
    // to a congested centre just because a pass clip happens to be available.
    return { moveTarget: dribble.target, desiredSpeed: pressed ? CONFIG.player.runSpeed : CONFIG.player.hsrSpeed,
      action: null, noveltyKey: dribble.key,
      reason: `${needsReset ? "ESCAPE" : "ADVANCE"} ${dribble.lane}: path ${carryLane.toFixed(2)}, space ${dribble.space.toFixed(2)}, ahead ${forwardSpace.toFixed(2)} · ${phase} · ${runsOn}`,
      utilities, passOptions, urgent: false };
  }

  /** Attacking-coordinate x of the opponents' second-last defender (the offside line). */
  private defensiveLineU(snap: WorldSnap, team: number): number {
    const sign = this.attackSign(team, snap.half);
    const defenders = snap.players.filter((q) => q.team !== team).map((q) => q.pos.x * sign).sort((a, b) => b - a);
    return defenders.length >= 2 ? defenders[1] : 0;
  }

  private goalkeeperDecision(
    p: WorldPlayer, mates: WorldPlayer[], snap: WorldSnap, _now: number,
    ownGoal: THREE.Vector3, atkGoal: THREE.Vector3, noise: (scale?: number) => number,
    rng: SeededRandom,
  ): AIDecision {
    if (!p.hasBall && snap.passFlight?.receiver === p.idx && snap.ballOwner === null) {
      return { moveTarget: snap.passFlight.target.clone(), desiredSpeed: CONFIG.player.runSpeed, action: null,
        reason: "GK RECEIVE: prepare feet for the recycling pass", utilities: { receive: 1 }, urgent: true };
    }
    if (!p.hasBall && snap.ballOwnerTeam === p.team) {
      const job = this.tactics.plan(snap, p.team)?.assignments.get(p.idx);
      if (job) return { moveTarget: job.target.clone(), desiredSpeed: CONFIG.player.jogSpeed, action: null,
        reason: `KEEPER OUTLET: offer reset angle | lane ${job.lane.toFixed(2)}`, supportJob: job.job, supportMode: job.mode,
        utilities: { recycleSupport: 1, lane: job.lane }, urgent: false };
    }
    if (p.hasBall) {
      if (this.gkDistribution) {
        const chosen = this.gkDistribution(p.idx);
        if (chosen) {
          return {
            moveTarget: p.pos.clone(), desiredSpeed: 0,
            action: this.can(p, chosen.action) ? chosen.action : null,
            actionTarget: chosen.target.clone(), passTo: chosen.receiverIdx,
            noveltyKey: `gk-dist:` + chosen.receiverIdx,
            reason: chosen.reason, utilities: { distribution: 1 }, urgent: false,
          };
        }
      }
      const candidates = mates.filter((m) => m.role !== "GK").map((m) => {
        const dist = p.pos.distanceTo(m.pos);
        const gap = this.nearestOppAt(m.pos, snap.players.filter((q) => q.team !== p.team));
        const forward = (m.pos.x - p.pos.x) * this.attackSign(p.team, snap.half);
        const score = THREE.MathUtils.clamp(gap / 7, 0, 1) * 0.4
          + THREE.MathUtils.clamp(forward / 18, -0.2, 0.55)
          + THREE.MathUtils.clamp(1 - Math.abs(dist - 11) / 22, 0, 1) * 0.16
          + noise(0.25) + tieBreakHash(snap.matchSeed, p.idx, p.runSerial, `gk:${m.idx}`) * 0.025;
        return { m, score, dist };
      }).sort((a, b) => b.score - a.score);
      const target = candidates[0]?.m.pos.clone() ?? atkGoal.clone();
      const style = p.style.directness + p.style.risk * 0.3;
      const action = candidates[0]?.dist > 11 || style > 1.45 ? "gk_punt" : "gk_roll";
      return {
        moveTarget: p.pos.clone(), desiredSpeed: 0, action: this.can(p, action) ? action : null,
        actionTarget: target, passTo: candidates[0]?.m.idx, noveltyKey: `gk-distribution:${candidates[0]?.m.idx ?? -1}`,
        reason: `GK distribute · ${action} → ${candidates[0]?.m.role ?? "space"}`,
        utilities: { distribution: candidates[0]?.score ?? 0.5 }, urgent: false,
      };
    }

    const ball = snap.ballPos;
    const ballSpeed = snap.ballVel.length();
    const shot = this.readShot(p, snap, ownGoal);
    if (shot) {
      // Per-shot read error, sampled ONCE per strike from the match PRNG (decision-time
      // variety; contact resolution stays deterministic). Faster and screened shots are
      // harder to read, so some reachable shots are still beaten.
      const age = snap.ballKickAge ?? 9;
      const prev = this.gkRead.get(p.idx);
      if (!prev || age < prev.age) {
        const screened = snap.players.some((q) => q.idx !== p.idx && q.role !== "GK"
          && this.pointNearSegment(q.pos, snap.ballPos, new THREE.Vector3(p.pos.x, 0, shot.z), 0.7));
        const difficulty = (ballSpeed / 20) * (screened ? 1.7 : 1);
        const err = rng.range(-1, 1) * CONFIG.ai.gkReadError * difficulty;
        // Dive timing error: negative = early, positive = late. Skewed late against pace.
        const timing = rng.range(-0.5, 1) * CONFIG.ai.gkTimingError * difficulty;
        this.gkRead.set(p.idx, { age, err, timing });
      } else prev.age = age;
      shot.z += this.gkRead.get(p.idx)!.err;
      shot.timeLeft += this.gkRead.get(p.idx)!.timing; // late reader perceives more time → commits late
      shot.lateral = Math.abs(shot.z - p.pos.z);
      shot.reachable = shot.lateral <= shot.reach;
      const goalHalf = CONFIG.pitch.goalWidth / 2 - CONFIG.ai.gkNearPostInset;
      const keeperTarget = new THREE.Vector3(p.pos.x, 0, THREE.MathUtils.clamp(shot.z, -goalHalf, goalHalf));
      const util = { save: shot.reachable ? 1 : 0, lateral: shot.lateral, timeLeft: shot.timeLeft, reach: shot.reach };
      if (snap.ballKickAge !== undefined && snap.ballKickAge < CONFIG.ai.gkReactionTime) {
        // Human reaction time: the keeper has not processed the strike yet.
        return { moveTarget: p.pos.clone(), desiredSpeed: 0, action: null, reason: `GK reacting · ${(snap.ballKickAge * 1000) | 0}ms`, utilities: util, urgent: true };
      }
      // Commit once; while the save clip plays the keeper must not restart it.
      const commit = shot.timeLeft <= CONFIG.ai.gkDiveContactTime + 0.06 && !p.busy;
      if (commit) {
        let action: string;
        if (shot.lateral < 0.75 && shot.height < 1.75) action = ballSpeed < CONFIG.ai.gkCatchSpeed ? "gk_catch" : "gk_parry";
        else if (shot.lateral < 0.75) action = "gk_parry";
        else {
          // Dive clip root motion is in facing space; pick the clip that moves toward the ball.
          const needDz = Math.sign(shot.z - p.pos.z) || 1;
          const leftDz = -Math.cos(p.facing); // gk_dive_L moves dz=-3 in facing space
          action = Math.sign(leftDz) === needDz ? "gk_dive_L" : "gk_dive_R";
        }
        return {
          moveTarget: keeperTarget, desiredSpeed: CONFIG.player.gkSprintSpeed,
          action: this.can(p, action) ? action : this.can(p, "gk_parry") ? "gk_parry" : null,
          actionTarget: new THREE.Vector3(p.pos.x, shot.height, shot.z), noveltyKey: `save:${Math.round(shot.z)}`,
          reason: `GK ${shot.reachable ? "SAVE" : "desperate"} ${action} · lat ${shot.lateral.toFixed(2)}m reach ${shot.reach.toFixed(2)}m t ${shot.timeLeft.toFixed(2)}s`,
          utilities: util, urgent: true,
        };
      }
      // Before committing: set-feet shuffle toward the predicted crossing point. Keepers
      // do not sprint across goal during a shot (they would be off-balance to dive).
      return {
        moveTarget: keeperTarget, desiredSpeed: CONFIG.ai.gkSetShuffleSpeed, action: null,
        reason: `GK set · shuffle to ${shot.z.toFixed(2)} · t ${shot.timeLeft.toFixed(2)}s ${shot.reachable ? "reachable" : "OUT OF REACH"}`,
        utilities: util, urgent: true,
      };
    }

    // Claim crosses arriving in the box: predicted landing within reach, catch or parry.
    const atkSign = this.attackSign(p.team, snap.half);
    const ballU = (ball.x - ownGoal.x) * atkSign; // >0 = in front of the keeper's goal
    if (ball.y > 0.9 && ball.y < 2.6 && ballSpeed < 15 && ballU > -1.5 && ballU < 6.5) {
      const predicted = this.projectBall(snap, 0.45).pos;
      predicted.y = THREE.MathUtils.clamp(predicted.y, 0.2, 2.0);
      const reach = d2(p.pos, predicted);
      if (reach < 2.1 && Math.abs(predicted.z) < CONFIG.pitch.goalWidth / 2 + 1.0) {
        return {
          moveTarget: predicted, desiredSpeed: Math.min(CONFIG.ai.maxSprint, 5.6),
          action: this.can(p, "gk_catch") ? "gk_catch" : this.can(p, "gk_parry") ? "gk_parry" : null,
          actionTarget: predicted.clone(), noveltyKey: `cross:${Math.round(predicted.z)}`,
          reason: `GK claim cross · reach ${reach.toFixed(1)}m`, utilities: { cross: 1 }, urgent: true,
        };
      }
    }

    // 1v1: the carrier is through the line with nobody goal-side but the
    // keeper. Holding the angle arc leaves him ~2 m out and the carrier walks
    // to point-blank range; instead sprint to a big stance just goal-side of
    // the ball to shut the angle, then use the hands at his feet inside the
    // box (smother) or slide with the feet outside it, where hands are illegal.
    const oneOnOne = this.oneOnOneCarrier(p, snap, ownGoal);
    if (oneOnOne) {
      const ballDist = d2(p.pos, ball);
      const keeperDepth = (p.pos.x - ownGoal.x) * atkSign;
      const inBox = keeperDepth < 5.8 && Math.abs(p.pos.z) < 6.2;
      const toGoal = ownGoal.clone().sub(ball).setY(0).normalize();
      const stance = ball.clone().setY(0).addScaledVector(toGoal, CONFIG.ai.catchRadius);
      stance.x = THREE.MathUtils.clamp(stance.x, -CONFIG.pitch.length / 2 + 0.3, CONFIG.pitch.length / 2 - 0.3);
      let action: string | null = null;
      if (inBox && ballDist < CONFIG.ai.catchRadius + 0.5 && (oneOnOne.tackleProtectionT ?? 0) <= 0 && this.can(p, "gk_catch")) action = "gk_catch";
      else if (!inBox && ballDist < 2.5 && this.canTackle(p, snap, "tackle_slide")) action = "tackle_slide";
      return {
        moveTarget: stance, desiredSpeed: CONFIG.player.gkSprintSpeed,
        action, actionTarget: ball.clone(), noveltyKey: "gk-1v1",
        reason: action === "gk_catch" ? `GK 1v1 SMOTHER · hands at carrier's feet · ${ballDist.toFixed(1)}m`
          : action === "tackle_slide" ? `GK 1v1 SLIDE · feet outside the box · ${ballDist.toFixed(1)}m`
            : `GK 1v1 · close the angle · ${ballDist.toFixed(1)}m`,
        utilities: { oneOnOne: 1, ballDist }, urgent: true,
      };
    }

    // Track the ball on a real angle arc: off the line, on the ball→goal-centre
    // ray and biased to the near post. A world-space clamp previously pinned the
    // keeper 0.6 m from the line, which made close-range scoring trivial.
    const dist = Math.hypot(ball.x - ownGoal.x, ball.z - ownGoal.z);
    const position = keeperPositionTarget(ball, ownGoal, atkSign);
    if (ballSpeed < 8.5 && dist < 5.0 && ball.y < 1.35 && snap.ballOwnerTeam !== p.team) {
      return {
        moveTarget: ball.clone().setY(0), desiredSpeed: Math.min(CONFIG.ai.maxSprint, 5.2),
        action: d2(p.pos, ball) < CONFIG.ai.catchRadius + 0.5 && this.can(p, "gk_catch") ? "gk_catch" : null,
        actionTarget: ball.clone(), reason: "GK claim loose ball", utilities: { claim: 0.9 }, urgent: true,
      };
    }
    const recoverSpeed = THREE.MathUtils.clamp(
      d2(p.pos, position.target) * 2.2 + (ballSpeed > 12 ? 1.2 : 0),
      2.2, Math.min(CONFIG.player.gkSprintSpeed, 5.8),
    );
    return {
      moveTarget: position.target, desiredSpeed: recoverSpeed, action: null,
      reason: `GK angle · ${position.advance.toFixed(1)}m out · z ${position.lateral.toFixed(2)} · ${(position.angle * 180 / Math.PI).toFixed(0)}deg`,
      utilities: { angle: 1, advance: position.advance, nearPost: Math.abs(position.lateral) },
      urgent: dist < 14,
    };
  }

  private chooseShotAim(
    p: WorldPlayer, snap: WorldSnap, opponents: WorldPlayer[], lanes: number[], goal: THREE.Vector3,
    jitter: (key: string) => number,
  ): THREE.Vector3 {
    const keeper = opponents.find((q) => q.role === "GK");
    const choices = lanes.map((z) => {
      const target = new THREE.Vector3(goal.x, 0, z);
      const lane = this.segmentOpenness(p.pos, target, opponents.filter((q) => q.role !== "GK"));
      const keeperGap = keeper ? Math.abs(keeper.pos.z - z) : 1.5;
      const postMargin = Math.min(1.45 - Math.abs(z), 1);
      const score = lane * 0.55 + THREE.MathUtils.clamp(keeperGap / 1.8, 0, 1) * 0.36 + postMargin * 0.08
        + jitter(`shot-lane:${z}`);
      return { target, score };
    }).sort((a, b) => b.score - a.score);
    return choices[0]?.target ?? new THREE.Vector3(goal.x, 0, snap.ballPos.z * 0.2);
  }

  private chooseDribbleLane(
    p: WorldPlayer, goalDir: THREE.Vector3,
    opponents: WorldPlayer[], mates: WorldPlayer[], openness: (pos: THREE.Vector3) => number,
    noise: (scale?: number) => number, jitter: (key: string) => number, novelty: (key: string) => number,
  ): { target: THREE.Vector3; score: number; key: string; lane: string; space: number } {
    const dirs = [
      { z: -0.95, f: 3.3, label: "left half-space" }, { z: -0.45, f: 3.8, label: "left channel" },
      { z: 0, f: 4.3, label: "centre" }, { z: 0.45, f: 3.8, label: "right channel" }, { z: 0.95, f: 3.3, label: "right half-space" },
      { z: -1.1, f: -1.6, label: "left retreat" }, { z: 1.1, f: -1.6, label: "right retreat" },
    ];
    const choices = dirs.map((dir) => {
      const forward = goalDir.clone().multiplyScalar(dir.f);
      forward.z += dir.z * 3.1 * p.style.width;
      const target = p.pos.clone().add(forward);
      target.x = THREE.MathUtils.clamp(target.x, -18.8, 18.8);
      target.z = THREE.MathUtils.clamp(target.z, -11.2, 11.2);
      const space = openness(target);
      const nearby = Math.max(0, ...opponents.map((o) => 2.1 - target.distanceTo(o.pos)));
      const crowd = Math.max(0, ...mates.map((m) => 2.8 - target.distanceTo(m.pos)));
      const key = `dribble:${dir.label}`;
      const path = laneSafety(p.pos, target, opponents, CONFIG.player.runSpeed);
      const score = 0.18 + space * 0.16 + path * 0.25
        + THREE.MathUtils.clamp(1 - nearby / 2.1, 0, 1) * 0.08
        + THREE.MathUtils.clamp(1 - crowd / 2.8, 0, 1) * 0.08
        + p.style.carry * 0.06 + (dir.f > 0 ? 0.1 : -0.12)
        - (path < 0.35 ? 0.25 : 0) - novelty(key) * 0.2 + noise(0.16) + jitter(key);
      return { target, score, key, lane: dir.label, space };
    }).sort((a, b) => b.score - a.score);
    return choices[0];
  }

  private supportTarget(p: WorldPlayer, roleIdx: number, snap: WorldSnap, anchor: THREE.Vector3, attack: number): THREE.Vector3 {
    const assigned = this.tactics.plan(snap, p.team)?.assignments.get(p.idx);
    if (assigned) return assigned.target.clone();
    const home = FORMATIONS[p.team === 0 ? "RED" : "BLUE"][roleIdx].home;
    // Convert the formation to attacking coordinates independently of the current half.
    const homeU = home[0] * (p.team === 0 ? 1 : -1);
    const target = new THREE.Vector3((homeU * 0.65 + anchor.x * attack * 0.35) * attack, 0, home[1] * 0.6 + anchor.z * 0.2);
    this.clampOnside(target, snap.ballPos, p.team, snap);
    return target;
  }

  /**
   * Defensive line. As the ball approaches our goal the line drops toward the six-yard
   * box and pinches central (the corridor in front of goal is the most dangerous space).
   * When the ball is wide, the block slides across rather than leaving the centre open.
   */
  private defensiveLineTarget(p: WorldPlayer, carrier: WorldPlayer, ownGoal: THREE.Vector3, attack: number): THREE.Vector3 {
    const ballU = carrier.pos.x * attack;          // own-goal-relative: -20 is our goal
    const ownLocal = ownGoal.x * attack;
    const inDefensiveThird = ballU < ownLocal + 15;
    const dangerous = ballU < ownLocal + 22;
    // Depth: drop between ball and goal, never further than 9 m off our line when threatened.
    let lineU = THREE.MathUtils.clamp(ballU - (inDefensiveThird ? 3.0 : 4.4), ownLocal + 7, 12.2);
    if (!inDefensiveThird) lineU = THREE.MathUtils.clamp(ballU - 4.4, -16.3, 12.2);
    if (dangerous) lineU = Math.min(lineU, ownLocal + (inDefensiveThird ? 8.5 : 11.5));
    // Central compaction: each centre-back takes a tight lane either side of the keeper.
    const lane = p.roleIdx === 1 ? -1 : 1;
    const central = Math.abs(carrier.pos.z) < 7.5;
    const halfGap = central ? (dangerous ? 2.5 : 3.1) : 4.0;
    // Slide the whole block toward the ball's side, keeping the far post covered.
    const z = lane * halfGap + carrier.pos.z * (central ? 0.12 : 0.4);
    const target = new THREE.Vector3(lineU * attack, 0, THREE.MathUtils.clamp(z, -8.6, 8.6));
    if (target.x * attack < ownLocal + 2) target.x = (ownLocal + 2) * attack;
    return target;
  }

  private markerAssignments(snap: WorldSnap, defendingTeam: number): Map<number, WorldPlayer> {
    const defenders = snap.players.filter((p) => p.team === defendingTeam && p.role !== "GK");
    const attackers = snap.players.filter((p) => p.team !== defendingTeam && p.role !== "GK");
    const pairs = defenders.flatMap((def) => attackers.map((att) => ({
      def, att,
      cost: def.pos.distanceTo(att.pos) + (att.hasBall ? -2.5 : 0)
        + (att.role === "FWD" ? -0.3 : 0)
        + tieBreakHash(this.matchSeed, def.idx, def.runSerial, `mark:${att.idx}`) * 0.03,
    }))).sort((a, b) => a.cost - b.cost);
    const result = new Map<number, WorldPlayer>();
    const usedD = new Set<number>(); const usedA = new Set<number>();
    for (const pair of pairs) {
      if (usedD.has(pair.def.idx) || usedA.has(pair.att.idx)) continue;
      result.set(pair.def.idx, pair.att); usedD.add(pair.def.idx); usedA.add(pair.att.idx);
    }
    return result;
  }

  private bestInterceptor(snap: WorldSnap, team: number): { idx: number; time: number; slack: number } | null {
    const players = snap.players.filter((p) => p.team === team && p.role !== "GK");
    if (!players.length) return null;
    let best: { idx: number; time: number; slack: number } | null = null;
    const step = 0.12;
    for (let t = 0.08; t <= CONFIG.ai.interceptHorizon + 0.001; t += step) {
      const point = this.projectBall(snap, t).pos;
      for (const player of players) {
        const speed = CONFIG.ai.maxSprint * (0.78 + player.stamina * 0.22);
        const arrival = player.pos.distanceTo(point) / Math.max(1, speed);
        const slack = arrival - t;
        if (!best || slack < best.slack - 0.001 || (Math.abs(slack - best.slack) < 0.001
          && tieBreakHash(this.matchSeed, player.idx, player.runSerial, "intercept") < tieBreakHash(this.matchSeed, best.idx, snap.players[best.idx]?.runSerial ?? 0, "intercept"))) {
          best = { idx: player.idx, time: t, slack };
        }
      }
    }
    return best;
  }

  private projectBall(snap: WorldSnap, t: number): BallSample {
    // Matches stepBallPhysics: quadratic aero drag a = DRAG_K·v² while airborne,
    // then constant rolling resistance once the ball is on the grass.
    const B = CONFIG.ball;
    const area = Math.PI * B.radius * B.radius;
    const kDrag = 0.5 * B.airDensity * B.dragCoefficient * area / B.mass;
    const pos = snap.ballPos.clone();
    const v0 = snap.ballVel;
    const speed0 = Math.max(v0.length(), 0.01);

    // Airborne time until first ground contact (solve y(t) = radius).
    let tGround = t;
    const disc = v0.y * v0.y + 2 * B.gravity * (pos.y - B.radius);
    if (disc >= 0) {
      const tHit = (-v0.y + Math.sqrt(disc)) / B.gravity;
      if (tHit > 0 && tHit < t) tGround = tHit;
    }
    // Quadratic drag: v(t) = v0 / (1 + k·v0·t), distance = ln(1 + k·v0·t) / k
    const airTravel = (1 / kDrag) * Math.log(1 + kDrag * speed0 * tGround);
    if (speed0 > 0.01) {
      pos.x = snap.ballPos.x + (v0.x / speed0) * airTravel;
      pos.z = snap.ballPos.z + (v0.z / speed0) * airTravel;
    }
    pos.y = snap.ballPos.y + v0.y * tGround - 0.5 * B.gravity * tGround * tGround;
    if (tGround < t) {
      // rolling phase: v(t) = v_ground − rollingDecel·(t − tGround), distance = v·Δt − ½·a·Δt²
      pos.y = B.radius;
      const vGround = speed0 / (1 + kDrag * speed0 * tGround); // air-drag-reduced speed at landing
      const dtRoll = t - tGround;
      const rollDist = vGround * dtRoll - 0.5 * B.rollingDecel * dtRoll * dtRoll;
      if (speed0 > 0.01) {
        pos.x += (v0.x / speed0) * Math.max(0, rollDist);
        pos.z += (v0.z / speed0) * Math.max(0, rollDist);
      }
    }
    pos.x = THREE.MathUtils.clamp(pos.x, -CONFIG.pitch.length / 2 + 0.2, CONFIG.pitch.length / 2 - 0.2);
    pos.z = THREE.MathUtils.clamp(pos.z, -CONFIG.pitch.width / 2 + 0.2, CONFIG.pitch.width / 2 - 0.2);
    return { t, pos };
  }

  private segmentOpenness(a: THREE.Vector3, b: THREE.Vector3, opponents: WorldPlayer[]): number {
    return laneSafety(a, b, opponents);
  }

  private nearestOppAt(pos: THREE.Vector3, opponents: WorldPlayer[]): number {
    return opponents.length ? Math.min(...opponents.map((p) => p.pos.distanceTo(pos))) : 20;
  }

  /**
   * Read an inbound shot: where and when it crosses the keeper's line (quadratic air
   * drag, matching stepBallPhysics), whether it is on target, and whether the keeper
   * can physically reach it in the time left (shuffle + dive reach). Unreachable shots
   * — far corner, too fast, too close — become goals; reachable ones can be saved.
   */
  readShot(p: WorldPlayer, snap: WorldSnap, ownGoal: THREE.Vector3): {
    z: number; height: number; timeLeft: number; lateral: number; reach: number; reachable: boolean;
  } | null {
    if (snap.ballOwner !== null) return null;
    const v = snap.ballVel, b = snap.ballPos;
    const towardGoal = (ownGoal.x - b.x) * v.x > 0;
    const horizontal = Math.hypot(v.x, v.z);
    if (!towardGoal || horizontal < 6) return null;
    // Distance to the keeper's line along the direction of travel, then drag-aware time.
    const lineX = p.pos.x;
    const dxLine = lineX - b.x;
    if (dxLine * v.x <= 0) return null; // ball already behind keeper's line
    const along = Math.abs(dxLine) * (horizontal / Math.abs(v.x));
    const B = CONFIG.ball;
    const kDrag = 0.5 * B.airDensity * B.dragCoefficient * Math.PI * B.radius * B.radius / B.mass;
    const t = (Math.exp(kDrag * along) - 1) / (kDrag * horizontal); // invert ln(1+k v t)/k = along
    if (!Number.isFinite(t) || t > 2.5) return null;
    const z = b.z + (v.z / horizontal) * along;
    const height = Math.max(B.radius, b.y + v.y * t - 0.5 * B.gravity * t * t);
    // Must be heading on target (with a small margin for late curl). Both tests
    // are made where the ball crosses the GOAL line: height was previously read
    // at the keeper's line, so a dipping lob that clears the keeper but drops
    // under the bar was judged "over" and never attacked.
    const alongGoal = Math.abs(ownGoal.x - b.x) * (horizontal / Math.abs(v.x));
    const goalZ = b.z + (v.z / horizontal) * alongGoal;
    const tGoal = (Math.exp(kDrag * alongGoal) - 1) / (kDrag * horizontal);
    const goalLineHeight = b.y + v.y * tGoal - 0.5 * B.gravity * tGoal * tGoal;
    if (Math.abs(goalZ) > CONFIG.pitch.goalWidth / 2 + 0.45 || goalLineHeight > CONFIG.pitch.goalHeight + 0.4) return null;

    const lateral = Math.abs(z - p.pos.z);
    // Time the keeper can actually use: arrival time minus the unexpired reaction delay.
    const reactionLeft = Math.max(0, CONFIG.ai.gkReactionTime - (snap.ballKickAge ?? 1));
    const usable = Math.max(0, t - reactionLeft);
    const dive = CONFIG.ai.gkDiveContactTime;
    // Standing arm reach + dive extension (only fully available if there is time for the
    // dive clip to reach its contact frame) + lateral shuffle before committing.
    const diveExt = usable >= dive ? CONFIG.ai.gkDiveExtension : CONFIG.ai.gkDiveExtension * (usable / dive);
    const shuffle = Math.min(CONFIG.ai.gkShuffleMax, Math.max(0, usable - dive) * CONFIG.player.gkSprintSpeed * CONFIG.ai.gkShuffleFactor);
    // High corners require a rising dive and low corners a collapsing one; both cost reach.
    const heightPenalty = height > 1.85 ? 0.6 : height > 1.5 ? 0.35 : height < 0.25 ? 0.25 : 0;
    const reach = CONFIG.ai.gkStandingReach + diveExt + shuffle - heightPenalty;
    return { z, height, timeLeft: t, lateral, reach, reachable: lateral <= reach };
  }

  isOffsidePosition(position: THREE.Vector3, ball: THREE.Vector3, team: number, snap: WorldSnap): boolean {
    if (!CONFIG.ai.offside) return false;
    const sign = this.attackSign(team, snap.half);
    const u = position.x * sign;
    if (u <= 0) return false; // own half is onside
    const defenders = snap.players.filter((p) => p.team !== team).map((p) => p.pos.x * sign).sort((a, b) => b - a);
    // Fewer than two defenders means there is no second-last defender; put the
    // line beyond the pitch so no attacker can be offside (matches offside.ts).
    const secondLast = defenders.length >= 2 ? defenders[1] : CONFIG.pitch.length / 2;
    return u > ball.x * sign + CONFIG.ai.offsideBuffer && u > secondLast + CONFIG.ai.offsideBuffer;
  }

  private clampOnside(target: THREE.Vector3, ball: THREE.Vector3, team: number, snap: WorldSnap): void {
    const sign = this.attackSign(team, snap.half);
    const maxU = Math.max(0, ball.x * sign, onsideLimit(snap, team)) - CONFIG.ai.offsideBuffer;
    const u = target.x * sign;
    if (u > 0 && u > maxU) target.x = maxU * sign;
  }

  private applySpacing(target: THREE.Vector3, p: WorldPlayer, mates: WorldPlayer[], ownerIdx: number, attack: number): THREE.Vector3 {
    const result = target.clone();
    for (const mate of mates) {
      if (mate.idx === ownerIdx && p.idx !== ownerIdx) continue;
      const away = result.clone().sub(mate.pos).setY(0);
      const distance = away.length();
      if (distance >= CONFIG.ai.teamSpacing) continue;
      if (distance < 0.01) {
        const sign = (p.idx + mate.idx) % 2 === 0 ? 1 : -1;
        away.set(attack * 0.2, 0, sign).normalize();
      } else away.normalize();
      result.addScaledVector(away, (CONFIG.ai.teamSpacing - distance) * 0.75);
    }
    result.x = THREE.MathUtils.clamp(result.x, -18.9, 18.9);
    result.z = THREE.MathUtils.clamp(result.z, -11.3, 11.3);
    return result;
  }

  private channelName(z: number): string {
    return z < -4 ? "left" : z > 4 ? "right" : "centre";
  }

  private can(p: WorldPlayer, clip: string): boolean {
    if (!clipExists(clip)) return false;
    if ((p.cooldowns.get(clip) ?? 0) > 0) return false;
    if ((clip === "tackle_stand" || clip === "tackle_slide") && (p.tackleRecoveryT ?? 0) > 0) return false;
    return !p.busy && !p.uninterruptible;
  }

  /**
   * The 1v1 carrier, if there is one: an opponent through the defensive line
   * in front of the keeper's goal with no outfield teammate goal-side of him.
   * With a defender goal-side the keeper holds his angle instead of vacating
   * the goal for the square ball.
   */
  private oneOnOneCarrier(p: WorldPlayer, snap: WorldSnap, ownGoal: THREE.Vector3): WorldPlayer | null {
    const carrier = snap.players.find((q) => q.idx === snap.ballOwner);
    if (!carrier || carrier.team === p.team) return null;
    const sign = this.attackSign(p.team, snap.half);
    const depth = (snap.ballPos.x - ownGoal.x) * sign;
    if (depth <= 0 || depth > CONFIG.ai.gkRushLine * 2 || Math.abs(snap.ballPos.z) >= 6.2) return null;
    const covered = snap.players.some((q) => q.team === p.team && q.idx !== p.idx && q.role !== "GK"
      && (q.pos.x - ownGoal.x) * sign < depth - 0.5 && Math.abs(q.pos.z - snap.ballPos.z) < 4);
    return covered ? null : carrier;
  }

  /**
   * A defender only commits to a challenge when the ball can actually be won:
   * no protected carrier, a forward-facing approach and not from the blind side.
   * Contact still re-evaluates quality; this avoids AI spamming doomed slides.
   */
  private canTackle(p: WorldPlayer, snap: WorldSnap, clip: "tackle_stand" | "tackle_slide"): boolean {
    if (!this.can(p, clip)) return false;
    const carrier = snap.players.find((q) => q.idx === snap.ballOwner);
    if (!carrier || carrier.team === p.team || (carrier.tackleProtectionT ?? 0) > 0) return false;
    // A keeper with the ball in his hands cannot be challenged; `startAction` refuses
    // it too, so the AI must not keep selecting a challenge that can never start.
    if (carrier.role === "GK") return false;
    const dx = snap.ballPos.x - p.pos.x, dz = snap.ballPos.z - p.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return false;
    const facingDot = (Math.cos(p.facing) * dx - Math.sin(p.facing) * dz) / len;
    if (facingDot < 0.12) return false;
    const cdx = p.pos.x - carrier.pos.x, cdz = p.pos.z - carrier.pos.z;
    const clen = Math.hypot(cdx, cdz);
    const frontDot = clen > 0.01
      ? (Math.cos(carrier.facing) * cdx - Math.sin(carrier.facing) * cdz) / clen
      : 0;
    // A challenge from behind is unrealistic and is a foul at contact. Only the slide
    // was gated here, so defenders kept committing standing challenges from the blind
    // side that could never be won cleanly and only ever gave away fouls.
    return frontDot >= -0.35;
  }

  commitDecision(idx: number, decision: AIDecision) {
    const key = decision.noveltyKey ?? decision.action;
    if (!key) return;
    const recent = this.recentChoices.get(idx) ?? [];
    recent.push(key);
    if (recent.length > 8) recent.shift();
    this.recentChoices.set(idx, recent);
  }

  private store(idx: number, decision: AIDecision): AIDecision {
    // Action ids are derived from match state, not drawn here. A decision that
    // is cached, rejected on cooldown or cancelled at its contact frame must
    // consume exactly zero PRNG values.
    this.lastDecision.set(idx, decision);
    return decision;
  }
}

function d2(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}