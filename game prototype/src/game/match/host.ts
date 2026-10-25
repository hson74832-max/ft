/**
 * The internal surface that the per-concern modules in `src/game/match/` act on.
 *
 * `MatchEngine` is the single owner of match state; the modules are stateless
 * functions (or small state holders) that take the engine and do one job. This
 * interface is the seam between the two: it lists exactly the state those
 * modules read or write. It is *not* a public API for the UI or scripts — those
 * use the documented members of `MatchEngine` / `Snapshot`.
 */
import * as THREE from "three";
import type { Ball } from "../ball";
import type { RulesEngine } from "../rules";
import type { AIController, PassFlight, WorldSnap } from "../ai";
import type { SeededRandom } from "../random";
import type { MatchRenderer } from "./world";
import type {
  ActionSeedRecord, AITraceRow, CameraMode, EnginePlayer, FamilyMode, PassTrace,
} from "./types";

export interface TacticalStats {
  passes: number; recycles: number; keeperRecycles: number;
  penetratingPasses: number; shots: number; keeperFootControls: number;
  tacklesAttempted: number; tacklesWon: number; tacklesSpilled: number;
  tacklesMissed: number; fouls: number;
}

export interface MatchHost {
  // --- render / world -------------------------------------------------------
  canvas: HTMLCanvasElement;
  renderer: MatchRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  headless: boolean;
  aiLines: THREE.LineSegments;
  aiLinePos: THREE.Float32BufferAttribute;

  // --- simulation -----------------------------------------------------------
  ball: Ball;
  players: EnginePlayer[];
  rules: RulesEngine;
  ai: AIController;
  rng: SeededRandom;
  matchSeed: number;
  clock: number;
  fps: number;

  // --- control / presentation flags ----------------------------------------
  keys: Set<string>;
  humanIdx: number;
  humanTeam: number;
  selectedIdx: number;
  spectator: boolean;
  cameraMode: CameraMode;
  familyMode: FamilyMode;
  timeScale: number;
  aimRaw: boolean;
  showAIDebug: boolean;
  showAnimOverlay: boolean;
  foulsOn: boolean;
  camPos: THREE.Vector3;
  camLook: THREE.Vector3;
  freeYaw: number;
  freePitch: number;
  freeDist: number;
  passCharge: number;
  shootCharge: number;
  chargingPass: boolean;
  chargingShoot: boolean;
  /** Analog touch virtual joystick (set by the UI, read by humanControl each frame). */
  touchStick: { ix: number; iz: number; active: boolean };

  // --- telemetry / logs -----------------------------------------------------
  contactTotal: number;
  contactAligned: number;
  actionLog: ActionSeedRecord[];
  lastActionSeed: number | null;
  celebratedGoalEventId: number;
  motionRevision: number;
  passLog: PassTrace[];
  tacticalStats: TacticalStats;
  outRestartCount: number;
  openPlayKickCount: number;

  // --- debug (?debug=ai) ----------------------------------------------------
  debugAI: boolean;
  aiTrace: Map<number, AITraceRow>;
  aiEventLog: string[];
  aiEventTotal: number;
  aiTraceLogT: number;
  lastAppliedDecision: Map<number, unknown>;

  // --- passing / world snapshot --------------------------------------------
  passFlight?: PassFlight;
  lastPass?: WorldSnap["lastPass"];
  frameWorld: WorldSnap | null;

  // --- offside --------------------------------------------------------------
  offsideCandidates: Set<number>;
  offsideTeam: number | null;

  // --- possession -----------------------------------------------------------
  lastKnownOwnerIdx: number | null;
  lastKnownOwnerTeam: number | null;
  seenOwner: number | null;
  seenOwnerTeam: number | null;
  possessionStartedAt: number;
  transitionTeam: number | null;
  transitionUntil: number;

  // --- restarts -------------------------------------------------------------
  restartAutoT: number;
  restartRetries: number;
  restartStartedId: number;
  restartLaunchedId: number;
  restartWaitReason: string;
  warnedRestartId: number;
  restartContactT: number;

  // --- public commands the modules invoke -----------------------------------
  switchToNearest(manual?: boolean): void;
  resetPositions(kind: string): void;

  // --- DOM listeners (identity matters for removeEventListener) -------------
  kd: (ev: KeyboardEvent) => void;
  ku: (ev: KeyboardEvent) => void;
}
