// Shared vocabulary for the match engine and the modules in `src/game/match/`.
// These types are the contract between the engine (state + public API) and the
// per-concern modules that act on it, so they live outside both.
import * as THREE from "three";
import type { AnimationController } from "../anims";
import type { PlayerRig } from "../playerMesh";
import type { AIDecision, PlayerStyle } from "../ai";
import type { RunType, SupportJob } from "../tactics";

/** A tackle wind-up, frozen at action start so contact timing cannot be gamed. */
export interface TackleChallenge {
  action: "tackle_stand" | "tackle_slide";
  startedAt: number;
  targetIdx: number | null;
  targetTeam: number | null;
  idealContact: number;
  startBallDist: number;
  startCarrierDist: number;
}

/** A match participant: simulation state, animation controller and mesh rig. */
export interface EnginePlayer {
  idx: number; team: number; role: string; roleIdx: number;
  pos: THREE.Vector3; vel: THREE.Vector3; facing: number;
  speed: number; rig: PlayerRig; anim: AnimationController;
  moveTarget: THREE.Vector3; desiredSpeed: number;
  pendingKick: { action: string; target: THREE.Vector3; passTo?: number; power?: number } | null;
  holdT: number; stumbleT: number;
  /** Recovery after attempting a challenge; blocks another tackle even if the clip ends early. */
  tackleRecoveryT: number;
  /** Brief protection after winning a challenge; breaks immediate possession ping-pong. */
  tackleProtectionT: number;
  tackleChallenge: TackleChallenge | null;
  callForBall: boolean; isHuman: boolean; stamina: number;
  decisionReason: string; utilities: Record<string, number>;
  restartTaker: boolean;
  runSerial: number; style: PlayerStyle;
  supportJob?: SupportJob;
  supportRun?: RunType;
  supportMode?: string;
  passOptions?: AIDecision["passOptions"];
}

export interface ActionSeedRecord { seed: number; t: number; player: number; action: string; target?: [number, number, number]; }

/** Per-player, per-frame AI pipeline trace (populated only with ?debug=ai). */
export interface AITraceRow {
  idx: number; team: number; role: string; hasBall: boolean;
  branch: string;              // restartHold | human | frozen | gkHold | ai
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
export interface RestartTarget { target: THREE.Vector3; player?: EnginePlayer; }
