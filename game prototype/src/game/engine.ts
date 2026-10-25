/**
 * MatchEngine — the match: its state and its public API.
 *
 * The engine owns the state; the work is done by the cohesive modules in
 * `./match`, each of which receives the engine as a `MatchHost`:
 *
 *   world        renderer, stadium, player meshes, debug overlay
 *   roster       squad creation, human-controlled slot
 *   input        keyboard bindings
 *   camera       broadcast / follow / free-debug rigs
 *   frame        per-frame orchestration: AI world view, player integration,
 *                ball truth, celebrations
 *   control      human pad + applying AI decisions
 *   actions      action dispatch (clip request, kick intent, action seeds)
 *   passing      lane clearance, kick profiles, named-receiver plans,
 *                keeper distribution
 *   offside      offside capture, flagging and the at-kick check
 *   restarts     restart staging, taker selection, delivery sampling, watchdog
 *   contacts     the contact frame: what the ball does when an action lands
 *   possession   possession clock, reception triggers, out-of-play detection
 *   collisions   player/ball body collisions
 *   snapshot     HUD DTO (`Snapshot`)
 *   debug        ?debug=ai event log and per-frame decision table
 */
import * as THREE from "three";
import { RuleEvent } from "./config";
import { clipExists } from "./anims";
import { Ball } from "./ball";
import { RulesEngine } from "./rules";
import { AIController, WorldSnap, type PassFlight } from "./ai";
import {
  addCrowdStub, buildAIDebug, buildWorld, configureScene,
  createMatchCamera, createRenderer, resizeRenderer,
} from "./match/world";
import { buildPlayers, switchToNearest } from "./match/roster";
import { createMatchSeed, SeededRandom } from "./random";
import type { FieldMotionClip } from "./motion";
import { startAction } from "./match/actions";
import {
  evaluateGkDistribution as computeGkDistribution,
  passProfile as computePassProfile,
  planNamedPass,
} from "./match/passPlanning";
import { beginAITrace, buildWorldSnap, celebrateGoal, stepBall, stepPlayers } from "./match/frame";
import { updateCamera } from "./match/camera";
import { resolvePlayerCollisions } from "./match/collisions";
import { flushAITrace, updateAIDebug } from "./match/debug";
import { importMotionJSON as importMotionClip, importMotionPack as importMotionPackFile } from "./match/motionPack";
import { attachInput, detachInput, handleKey } from "./match/input";
import { placeForRestart, resetPositions } from "./match/restarts";
import { buildSnapshot } from "./match/snapshot";
import type {
  ActionSeedRecord, AITraceRow, CameraMode, EnginePlayer, FamilyMode, PassTrace,
} from "./match/types";

// Re-exported so existing imports of the engine module keep working.
export type { ActionSeedRecord, AITraceRow, CameraMode, EnginePlayer, FamilyMode, PassTrace } from "./match/types";

/**
 * Owns all match state. Members below the public API are the surface the
 * `./match` modules read and write; treat them as internal to the simulation.
 */
export class MatchEngine {
  canvas: HTMLCanvasElement;
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  ball: Ball;
  matchSeed: number;
  rng: SeededRandom;
  rules: RulesEngine;
  ai: AIController;
  headless: boolean;
  players: EnginePlayer[] = [];
  humanIdx = 4; // RED FWD
  humanTeam = 0;
  spectator = false;
  cameraMode: CameraMode = "broadcast";
  familyMode: FamilyMode = "mixed";
  timeScale = 1;
  aimRaw = false;
  showAIDebug = true;
  showAnimOverlay = true;
  foulsOn = false;
  keys = new Set<string>();
  passCharge = 0; shootCharge = 0;
  chargingPass = false; chargingShoot = false;
  camPos = new THREE.Vector3(0, 17, 23);
  camLook = new THREE.Vector3();
  freeYaw = 0.6; freePitch = 0.7; freeDist = 30;
  aiLines!: THREE.LineSegments;
  aiLinePos!: THREE.Float32BufferAttribute;
  clock = 0;
  fps = 60; private fpsAcc = 0; private fpsN = 0; private fpsT = 0;
  contactTotal = 0; contactAligned = 0;
  actionLog: ActionSeedRecord[] = [];
  /** ?debug=ai instrumentation — cheap, removable. */
  debugAI = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "ai";
  aiTrace = new Map<number, AITraceRow>();
  aiEventLog: string[] = [];
  aiEventTotal = 0;
  aiTraceLogT = 0;
  lastAppliedDecision = new Map<number, unknown>();
  frameWorld: WorldSnap | null = null;
  passFlight?: PassFlight;
  lastPass?: WorldSnap["lastPass"];
  readonly tacticalStats = { passes: 0, recycles: 0, keeperRecycles: 0, penetratingPasses: 0, shots: 0, keeperFootControls: 0 };
  passLog: PassTrace[] = [];
  outRestartCount = 0;
  openPlayKickCount = 0;
  lastActionSeed: number | null = null;
  offsideCandidates = new Set<number>();
  offsideTeam: number | null = null;
  lastKnownOwnerTeam: number | null = null;
  lastKnownOwnerIdx: number | null = null;
  // Possession timing: how long the carrier has had the ball, and the window in
  // which the team that just won it is in attacking transition.
  seenOwner: number | null = null;
  seenOwnerTeam: number | null = null;
  possessionStartedAt = 0;
  transitionTeam: number | null = null;
  transitionUntil = 0;
  possessionTicks: { idx: number; team: number | null }[] = [];
  selectedIdx = 4;
  gkHoldT = 0;
  // Restart bookkeeping (owned by ./match/restarts).
  restartAutoT = 0;
  placedRestartId = -1;
  restartRetries = 0;
  restartStartedId = -1;
  restartLaunchedId = -1;
  restartWaitReason = "";
  warnedRestartId = -1;
  restartContactT = 0;
  crowdStub: THREE.Group;
  disposed = false;
  onEvent: ((e: RuleEvent[]) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, opts?: { family?: FamilyMode; spectator?: boolean; seed?: number; headless?: boolean; debugAI?: boolean }) {
    this.canvas = canvas;
    // A fixed seed reproduces a match exactly (AI decisions + restart sampling).
    this.matchSeed = opts?.seed ?? createMatchSeed();
    this.rng = new SeededRandom(this.matchSeed);
    this.rules = new RulesEngine(this.rng.int(0, 1));
    this.ai = new AIController(this.rng, this.matchSeed);
    this.headless = opts?.headless ?? false;
    if (opts?.debugAI !== undefined) this.debugAI = opts.debugAI;
    this.familyMode = opts?.family ?? "mixed";
    this.spectator = opts?.spectator ?? false;
    this.renderer = createRenderer(canvas, this.headless);
    configureScene(this.scene);
    this.camera = createMatchCamera(this.camPos);
    buildWorld(this);
    this.ball = new Ball(this.scene);
    buildPlayers(this);
    buildAIDebug(this);
    this.crowdStub = addCrowdStub(this.scene);
    this.ai.passValidator = (passerIdx, receiverIdx, action) => {
      const passer = this.players[passerIdx];
      return !!passer && planNamedPass(this, passer, action, receiverIdx, undefined, this.rules.pendingRestart?.kind) !== null;
    };
    this.ai.passPreview = (passerIdx, receiverIdx, action) => {
      const passer = this.players.find((p) => p.idx === passerIdx);
      const plan = passer && planNamedPass(this, passer, action, receiverIdx, undefined, this.rules.pendingRestart?.kind);
      return plan ? { target: plan.target, arrivalTime: plan.arrivalTime, power: plan.power } : null;
    };
    this.ai.gkDistribution = (gkIdx) => {
      const gk = this.players[gkIdx];
      if (!gk) return null;
      const choice = computeGkDistribution(this, gk);
      return choice ? { action: choice.action, receiverIdx: choice.receiver.idx, target: choice.target, reason: choice.reason } : null;
    };
    attachInput(this);
    this.resize();
    this.resetPositions("kickoff");
    this.lastKnownOwnerTeam = this.ball.ownerTeam;
    this.lastKnownOwnerIdx = this.ball.possessedBy;
    this.seenOwner = this.ball.possessedBy;
    this.seenOwnerTeam = this.ball.ownerTeam;
    this.possessionStartedAt = 0;
    this.transitionUntil = 0;
    this.transitionTeam = null;
  }

  // ---------------- public API ----------------

  /** Match the render target and camera to the canvas' CSS size. */
  resize() { resizeRenderer(this); }

  /** Detach listeners and release the GPU resources. */
  dispose() {
    this.disposed = true;
    detachInput(this);
    this.renderer.dispose();
  }

  /** Re-stage every player for a kickoff or for the pending restart. */
  resetPositions(kind: string) { resetPositions(this, kind); }

  /** Give the human control of the outfielder closest to the ball. */
  switchToNearest(manual = false) { switchToNearest(this, manual); }

  /** Play a registered clip on the currently selected player (motion lab helper). */
  playClipOnSelected(id: string): boolean {
    if (!this.players[this.selectedIdx] || !clipExists(id)) return false;
    return startAction(this, this.players[this.selectedIdx], id);
  }

  /** Imports one clip, or every clip in a `fieldmotion.pack.v1` bundle. */
  importMotionPack(text: string, filename = "motion.json"): FieldMotionClip[] {
    return importMotionPackFile(text, filename);
  }

  importMotionJSON(text: string, filename = "motion.json", clipId?: string): FieldMotionClip {
    return importMotionClip(text, filename, clipId);
  }

  /**
   * Advance the match by `realDt` seconds of wall time.
   *
   * The frame is orchestrated here; the work is delegated to the cohesive
   * modules in `./match` (see the file header for the map).
   */
  step(realDt: number) {
    if (this.disposed) return;
    const dt = Math.min(0.05, realDt) * this.timeScale;
    this.clock += dt;
    // fps
    this.fpsAcc += realDt; this.fpsN++; this.fpsT += realDt;
    if (this.fpsT > 0.5) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; this.fpsT = 0; }

    this.rules.update(dt);
    const restart = this.rules.pendingRestart;
    if (this.rules.phase === "SETUP" && restart && restart.id !== this.placedRestartId) {
      placeForRestart(this);
      this.placedRestartId = restart.id;
      this.restartRetries = 0;
      this.restartStartedId = -1;
      this.restartLaunchedId = -1;
    }
    if (!restart) { this.restartStartedId = -1; this.restartLaunchedId = -1; }

    const live = this.rules.live;
    const frozen = this.rules.frozen;
    // A pass stops being "the current pass" once it is received, dies or play stops.
    if (this.passFlight && (this.ball.possessedBy !== null || this.clock > this.passFlight.expiresAt
      || !live || this.rules.pendingRestart || this.ball.lastTouchTeam !== this.passFlight.team)) this.passFlight = undefined;

    const snap = buildWorldSnap(this);
    this.frameWorld = snap;
    if (live && !this.rules.pendingRestart) {
      this.ai.tactics.plan(snap, 0);
      this.ai.tactics.plan(snap, 1);
    }

    if (this.rules.phase === "GOAL") celebrateGoal(this);
    if (this.debugAI) beginAITrace(this);

    stepPlayers(this, dt, snap, live, frozen);

    resolvePlayerCollisions(this);
    stepBall(this, dt, live);

    if (this.debugAI) flushAITrace(this, realDt);

    updateCamera(this, dt);
    updateAIDebug(this);
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------- snapshots for React HUD ----------------

  /** Read-only view of the match for the React layer (see `Snapshot`). */
  snapshot() { return buildSnapshot(this); }

  // ---------------- verification hooks ----------------
  // The tactics harness (scripts/tactics-test.ts) reads these two pure helpers
  // straight off the engine; they are the same functions the pass planner uses.
  passProfile(action: string) { return computePassProfile(action); }
  evaluateGkDistribution(gk: EnginePlayer) { return computeGkDistribution(this, gk); }

  // ---------------- input bindings ----------------
  // These stay on the instance: `addEventListener`/`removeEventListener` rely on
  // the identity of `kd`/`ku` across attach and detach.
  onKey = (ev: KeyboardEvent, down: boolean) => handleKey(this, ev, down);
  kd = (ev: KeyboardEvent) => handleKey(this, ev, true);
  ku = (ev: KeyboardEvent) => handleKey(this, ev, false);
}

export type Snapshot = ReturnType<MatchEngine["snapshot"]>;
