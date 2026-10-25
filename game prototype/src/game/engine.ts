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
import { clipExists } from "./anims";
import { Ball } from "./ball";
import { RulesEngine } from "./rules";
import { AIController, WorldSnap, type PassFlight } from "./ai";
import {
  buildAIDebug, buildWorld, configureScene,
  createMatchCamera, createRenderer, resizeRenderer, disposeSceneGraph,
  type MatchRenderer,
} from "./match/world";
import { buildPlayers, defaultHumanIndex, switchToNearest } from "./match/roster";
import { createMatchSeed, SeededRandom, streamSeed } from "./random";
import { getMotionRegistryVersion, type FieldMotionClip } from "./motion";
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
  ActionSeedRecord, AITraceRow, CameraMode, EnginePlayer, PassTrace,
} from "./match/types";

// Re-exported so existing imports of the engine module keep working.
export type { ActionSeedRecord, AITraceRow, CameraMode, EnginePlayer, PassTrace } from "./match/types";

/**
 * Owns all match state. Members below the public API are the surface the
 * `./match` modules read and write; treat them as internal to the simulation.
 */
export class MatchEngine {
  canvas: HTMLCanvasElement;
  renderer: MatchRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  ball: Ball;
  matchSeed: number;
  rng: SeededRandom;
  rules: RulesEngine;
  ai: AIController;
  headless: boolean;
  players: EnginePlayer[] = [];
  humanIdx = defaultHumanIndex(0);
  humanTeam = 0;
  spectator = false;
  cameraMode: CameraMode = "broadcast";
  timeScale = 1;
  aimRaw = false;
  showAIDebug = true;
  showAnimOverlay = true;
  // Bad challenges are always punished by recovery/miss/foul events. This turns a
  // foul into a real free kick / penalty and stops play for the restart; it can still
  // be switched off from the settings panel.
  foulsOn = true;
  keys = new Set<string>();
  passCharge = 0; shootCharge = 0;
  chargingPass = false; chargingShoot = false;
  touchStick = { ix: 0, iz: 0, active: false };
  camPos = new THREE.Vector3(0, 17, 23);
  camLook = new THREE.Vector3();
  freeYaw = 0.6; freePitch = 0.7; freeDist = 30;
  /** FIFA-style indicator floating above the human-controlled player's head. */
  selectionMarker: THREE.Mesh | null = null;
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
  readonly tacticalStats = {
    passes: 0, recycles: 0, keeperRecycles: 0, penetratingPasses: 0, shots: 0, keeperFootControls: 0,
    tacklesAttempted: 0, tacklesWon: 0, tacklesSpilled: 0, tacklesMissed: 0, fouls: 0,
  };
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
  selectedIdx = defaultHumanIndex(0);
  /** Latch for the GOAL event already celebrated; no duplicate action seeds. */
  celebratedGoalEventId = -1;
  /** Global clip/binding version at kickoff; a mid-match import changes replay content. */
  readonly motionRevision = getMotionRegistryVersion();
  // Restart bookkeeping (owned by ./match/restarts).
  restartAutoT = 0;
  placedRestartId = -1;
  restartRetries = 0;
  restartStartedId = -1;
  restartLaunchedId = -1;
  restartWaitReason = "";
  warnedRestartId = -1;
  restartContactT = 0;
  disposed = false;

  constructor(canvas: HTMLCanvasElement, opts?: { spectator?: boolean; seed?: number; headless?: boolean; debugAI?: boolean }) {
    this.canvas = canvas;
    // A fixed seed reproduces a match exactly (AI decisions + restart sampling).
    this.matchSeed = opts?.seed ?? createMatchSeed();
    // Independent streams: engine/restart sampling and AI decisions can no
    // longer perturb each other's draw order.
    this.rng = new SeededRandom(streamSeed(this.matchSeed, "match"));
    this.rules = new RulesEngine(new SeededRandom(streamSeed(this.matchSeed, "coin-toss")).int(0, 1));
    this.ai = new AIController(new SeededRandom(streamSeed(this.matchSeed, "ai")), this.matchSeed);
    this.headless = opts?.headless ?? false;
    if (opts?.debugAI !== undefined) this.debugAI = opts.debugAI;
    this.spectator = opts?.spectator ?? false;
    this.renderer = createRenderer(canvas, this.headless);
    configureScene(this.scene);
    this.camera = createMatchCamera(this.camPos);
    buildWorld(this);
    this.ball = new Ball(this.scene);
    buildPlayers(this);
    // FIFA-style selection marker above the human-controlled player's head.
    const markerGeo = new THREE.ConeGeometry(0.45, 0.9, 3);
    const markerMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9 });
    this.selectionMarker = new THREE.Mesh(markerGeo, markerMat);
    this.selectionMarker.visible = false;
    this.scene.add(this.selectionMarker);
    buildAIDebug(this);
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
    disposeSceneGraph(this.scene);
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
    if (!restart) { this.restartStartedId = -1; this.restartLaunchedId = -1; this.restartWaitReason = ""; }

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
    // FIFA-style indicator above the human-controlled player's head.
    if (this.selectionMarker) {
      const human = this.players[this.humanIdx];
      if (!this.spectator && human) {
        this.selectionMarker.position.set(human.pos.x, human.pos.y + 1.7, human.pos.z);
        this.selectionMarker.visible = true;
      } else {
        this.selectionMarker.visible = false;
      }
    }
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
