// Shared vocabulary for the match engine and the modules in `src/game/match/`.
// These types are the contract between the engine (state + public API) and the
// per-concern modules that act on it, so they live outside both.
import * as THREE from "three";
import type { StrikeCommand } from "../ball";
import type { AnimationController } from "../anims";
import type { PlayerRig } from "../playerMesh";
import type { AIDecision, PlayerAttributes, PlayerStyle } from "../ai";
import type { RunType, SupportJob } from "../tactics";
import type { Perception } from "./perception";

/** A tackle wind-up, frozen at action start so contact timing cannot be gamed. */
export interface TackleChallenge {
  action: "tackle_stand" | "tackle_slide";
  startedAt: number;
  targetIdx: number | null;
  targetTeam: number | null;
  idealContact: number;
  startBallDist: number;
  startCarrierDist: number;
  /** `frontDot` at the wind-up — the angle the challenger actually committed from. */
  startFrontDot: number;
}

/** A match participant: simulation state, animation controller and mesh rig. */
export interface EnginePlayer {
  idx: number; team: number; role: string; roleIdx: number;
  pos: THREE.Vector3; vel: THREE.Vector3; facing: number;
  speed: number; rig: PlayerRig; anim: AnimationController;
  moveTarget: THREE.Vector3; desiredSpeed: number;
  /** Queued kick resolved at the clip's contact frame. `forced` marks a clearance
   * the referee's hold limit demands: it is struck at its target and can never be
   * cancelled by a receiver plan. */
  pendingKick: { action: string; target: THREE.Vector3; passTo?: number; power?: number; forced?: boolean } | null;
  holdT: number; stumbleT: number;
  /** Recovery after attempting a challenge; blocks another tackle even if the clip ends early. */
  tackleRecoveryT: number;
  /** Brief protection after winning a challenge; breaks immediate possession ping-pong. */
  tackleProtectionT: number;
  tackleChallenge: TackleChallenge | null;
  /** Yellow cards shown to this player (two yellows ⇒ blue card, see ./referee). */
  yellowCards: number;
  /** Match-clock time at which a blue card expires; `> clock` means off the pitch. */
  blueCardUntil: number;
  /** Total fouls this player has conceded — the referee's patience, and the AI's. */
  foulsConceded: number;
  callForBall: boolean; isHuman: boolean; stamina: number;
  decisionReason: string; utilities: Record<string, number>;
  restartTaker: boolean;
  runSerial: number; style: PlayerStyle; attributes: PlayerAttributes;
  /** Private field of view and short-term memory (see ./perception). */
  perception: Perception;
  /** Body orientation the player must reach before the queued kick can be struck. */
  faceTarget: THREE.Vector3 | null;
  faceTargetT: number;
  /**
   * Seconds spent trying to pivot onto a kick target. A carrier pinned against a
   * touchline can never satisfy the facing test (his velocity, not his shoulders,
   * owns the body angle), which used to stall the whole match: the turn was
   * re-requested every 0.06 s and the kick never left. Past the cap the kick is
   * struck anyway rather than looping.
   */
  kickTurnT: number;
  /** Holding the ball up with the body between it and the nearest opponent. */
  shielding: boolean;
  /** Boot the current kick is struck with, chosen from the body angle at the wind-up. */
  strikeFoot: "L" | "R";
  /** Point the shoulders are turned onto while shielding (away from the pressure). */
  shieldPoint: THREE.Vector3;
  /** Body angle held while side-stepping / backpedalling with the ball, or null. */
  strideFacing: number | null;
  supportJob?: SupportJob;
  supportRun?: RunType;
  supportMode?: string;
  passOptions?: AIDecision["passOptions"];
  /** Deferred get_up after a failed slide tackle: fired when the slide clip ends. */
  pendingGetUp?: boolean;
}

export interface ActionSeedRecord { seed: number; t: number; player: number; action: string; target?: [number, number, number]; }

/** Per-player, per-frame AI pipeline trace (populated only with ?debug=ai). */
export interface AITraceRow {
  idx: number; team: number; role: string; hasBall: boolean;
  branch: string;              // restartHold | human | frozen | gkHold | gkForceRelease | benched | ai
  thinkCalled: boolean; thinkFresh: boolean;
  decisionReason: string; actionReturned: string | null;
  startActionResult: string;   // n/a | ok | rejected:<why> | skipped:<why>
  animBusy: boolean; animUninterruptible: boolean; animActionId: string | null;
  moveTarget: string; desiredSpeed: number; speed: number;
  overwrittenBy: string;       // which later branch replaced the AI move target
}

export interface PassTrace {
  t: number; passer: number; receiver: number; action: string; speed: number;
  aimDot: number; distance: number; predicted: [number, number, number];
  purpose?: string; arrivalTime?: number;
}

/** A resolved pass: receiver, aim point and the physics that carries the ball there. */
export interface PassPlan {
  receiver: EnginePlayer;
  target: THREE.Vector3;
  power: number;
  loft: number;
  aimDot: number;
  distance: number;
  arrivalTime: number;
  /** Named action profile that strikes this delivery (see physics/actionProfiles). */
  profile?: string;
  /** Fully resolved strike: sampled speed / angle / spin, plus jitter. */
  strike?: StrikeCommand & {
    profile?: { id: string; name: string };
    spinRpm?: number;
    angleDeg?: number;
  };
}

export type CameraMode = "broadcast" | "follow" | "free";

/** Keeper distribution choice (short/long option scoring). */
export interface GkDistribution {
  action: string;
  receiver: EnginePlayer;
  target: THREE.Vector3;
  reason: string;
  short: boolean;
}

/** Sampled aim point for a restart delivery. */
export interface RestartTarget { target: THREE.Vector3; player?: EnginePlayer; action?: string; }
