// Main match engine — pitch, players, ball, rules, AI, input, cameras.
import * as THREE from "three";
import { CONFIG, FORMATIONS, RuleEvent } from "./config";
import { AnimationController, clipExists, getClip } from "./anims";
import { createPlayerMesh, generateVariant, MeshFamily, PlayerRig } from "./playerMesh";
import { Ball, estimateKickTravelTime, kickPowerForRange, kickRangeForPower } from "./ball";
import { RulesEngine } from "./rules";
import { AIController, PlayerStyle, WorldPlayer, WorldSnap, type PassFlight, type AIDecision } from "./ai";
import { applyPose } from "./skeleton";
import { createMatchSeed, SeededRandom, tieBreakHash } from "./random";
import {
  FieldMotionClip, getRegisteredMotionClips, parseFieldMotionText, registerFieldMotionClip,
  validateFieldMotionAgainstSkeleton,
} from "./motion";
import { kickoffRestartViolation } from "./restartRules";
import { passAimDot, passAimIsValid, predictReceiverRun, resolveNamedReceiver } from "./passing";
import { onsideLimit, type RunType, type SupportJob } from "./tactics";
import { turnTowards, yawDelta, yawOfVector } from "./angles";

export interface EnginePlayer {
  idx: number; team: number; role: string; roleIdx: number;
  pos: THREE.Vector3; vel: THREE.Vector3; facing: number;
  speed: number; rig: PlayerRig; anim: AnimationController;
  moveTarget: THREE.Vector3; desiredSpeed: number;
  pendingKick: { action: string; target: THREE.Vector3; passTo?: number; actionSeed?: number; power?: number } | null;
  holdT: number; stumbleT: number; celebrateT: number;
  callForBall: boolean; isHuman: boolean; stamina: number;
  decisionReason: string; utilities: Record<string, number>;
  restartTaker: boolean;
  runSerial: number; style: PlayerStyle; lastActionSeed: number | null;
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
interface PassPlan {
  receiver: EnginePlayer;
  target: THREE.Vector3;
  power: number;
  loft: number;
  aimDot: number;
  distance: number;
  arrivalTime: number;
}

export type CameraMode = "broadcast" | "follow" | "free";
export type FamilyMode = "mixed" | "blocky" | "roundy";

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class MatchEngine {
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
  private chargingPass = false; private chargingShoot = false;
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
  private aiTraceLogT = 0;
  private lastAppliedDecision = new Map<number, unknown>();
  private frameWorld: WorldSnap | null = null;
  passFlight?: PassFlight;
  private lastPass?: WorldSnap["lastPass"];
  readonly tacticalStats = { passes: 0, recycles: 0, keeperRecycles: 0, penetratingPasses: 0, shots: 0, keeperFootControls: 0 };
  passLog: PassTrace[] = [];
  outRestartCount = 0;
  openPlayKickCount = 0;
  lastActionSeed: number | null = null;
  private offsideCandidates = new Set<number>();
  private offsideTeam: number | null = null;
  private lastKnownOwnerTeam: number | null = null;
  private lastKnownOwnerIdx: number | null = null;
  // Possession timing: how long the carrier has had the ball, and the window in
  // which the team that just won it is in attacking transition.
  private seenOwner: number | null = null;
  private seenOwnerTeam: number | null = null;
  possessionStartedAt = 0;
  transitionTeam: number | null = null;
  transitionUntil = 0;
  possessionTicks: { idx: number; team: number | null }[] = [];
  selectedIdx = 4;
  gkHoldT = 0;
  restartAutoT = 0;
  crowdStub: THREE.Group;
  disposed = false;
  onEvent: ((e: RuleEvent[]) => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, opts?: { family?: FamilyMode; spectator?: boolean; seed?: number; headless?: boolean; debugAI?: boolean }) {
    // A fixed seed reproduces a match exactly (AI decisions + restart sampling).
    this.matchSeed = opts?.seed ?? createMatchSeed();
    this.rng = new SeededRandom(this.matchSeed);
    this.rules = new RulesEngine(this.rng.int(0, 1));
    this.ai = new AIController(this.rng, this.matchSeed);
    this.headless = opts?.headless ?? false;
    if (opts?.debugAI !== undefined) this.debugAI = opts.debugAI;
    this.familyMode = opts?.family ?? "mixed";
    this.spectator = opts?.spectator ?? false;
    this.renderer = this.headless
      // Headless reproduction harness: identical simulation, no GPU.
      ? ({ render() {}, setSize() {}, setPixelRatio() {}, dispose() {}, shadowMap: { enabled: false, type: 0 } } as unknown as THREE.WebGLRenderer)
      : new THREE.WebGLRenderer({ canvas, antialias: true });
    if (!this.headless) this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color("#0b1f14");
    this.scene.fog = new THREE.Fog("#0b1f14", 55, 110);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
    this.camera.position.copy(this.camPos);
    this.buildWorld();
    this.ball = new Ball(this.scene);
    this.buildPlayers();
    this.buildAIDebug();
    // crowd stub — disabled, fans hook here later
    this.crowdStub = new THREE.Group();
    this.crowdStub.name = "CrowdSystem (disabled stub — add fans here later)";
    this.crowdStub.visible = false;
    this.scene.add(this.crowdStub);
    this.ai.passValidator = (passerIdx, receiverIdx, action) => {
      const passer = this.players[passerIdx];
      return !!passer && this.planNamedPass(passer, action, receiverIdx, undefined, this.rules.pendingRestart?.kind) !== null;
    };
    this.ai.passPreview = (passerIdx, receiverIdx, action) => {
      const passer = this.players.find((p) => p.idx === passerIdx);
      const plan = passer && this.planNamedPass(passer, action, receiverIdx, undefined, this.rules.pendingRestart?.kind);
      return plan ? { target: plan.target, arrivalTime: plan.arrivalTime, power: plan.power } : null;
    };
    this.ai.gkDistribution = (gkIdx) => {
      const gk = this.players[gkIdx];
      if (!gk) return null;
      const choice = this.evaluateGkDistribution(gk);
      return choice ? { action: choice.action, receiverIdx: choice.receiver.idx, target: choice.target, reason: choice.reason } : null;
    };
    this.attachInput();
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

  // ---------------- world ----------------
  private pitchTex(): THREE.CanvasTexture {
    const W = 1024, H = 640;
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const g = cv.getContext("2d")!;
    // mow stripes
    for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? "#2f9e4f" : "#2a9048"; g.fillRect((W / 10) * i, 0, W / 10, H); }
    const sx = (x: number) => ((x + 20) / 40) * W;
    const sz = (z: number) => ((z + 12.5) / 25) * H;
    g.strokeStyle = "rgba(255,255,255,0.92)"; g.lineWidth = 4;
    // touchlines
    g.strokeRect(sx(-20), sz(-12.5), sx(20) - sx(-20), sz(12.5) - sz(-12.5));
    // halfway
    g.beginPath(); g.moveTo(sx(0), sz(-12.5)); g.lineTo(sx(0), sz(12.5)); g.stroke();
    // centre circle + spot
    g.beginPath(); g.arc(sx(0), sz(0), (4 / 40) * W, 0, 7); g.stroke();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(sx(0), sz(0), 5, 0, 7); g.fill();
    // penalty areas (5.5m deep, 12m wide) + arcs + spots
    for (const s of [-1, 1]) {
      const gx = s < 0 ? -20 : 20;
      const x0 = s < 0 ? sx(gx) : sx(gx - 5.5), x1 = s < 0 ? sx(gx + 5.5) : sx(gx);
      g.strokeRect(Math.min(x0, x1), sz(-6), Math.abs(x1 - x0), sz(6) - sz(-6));
      // six-yard (2m deep, 6m wide)
      const y0 = s < 0 ? sx(gx) : sx(gx - 2), y1 = s < 0 ? sx(gx + 2) : sx(gx);
      g.strokeRect(Math.min(y0, y1), sz(-3), Math.abs(y1 - y0), sz(3) - sz(-3));
      // spot
      const px = s < 0 ? sx(-16.5) : sx(16.5);
      g.beginPath(); g.arc(px, sz(0), 4, 0, 7); g.fill();
      // arc
      g.beginPath(); g.arc(px, sz(0), (3 / 40) * W, s < 0 ? -0.9 : Math.PI - 0.9, s < 0 ? 0.9 : Math.PI + 0.9); g.stroke();
      // corner arcs
      for (const cz of [-12.5, 12.5]) {
        g.beginPath(); g.arc(sx(gx), sz(cz), 22, 0, 7); g.stroke();
      }
    }
    const tx = new THREE.CanvasTexture(cv);
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = 4;
    return tx;
  }

  private buildWorld() {
    const P = CONFIG.pitch;
    // ground: pitch + buffer apron
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(P.length + P.buffer * 2 + 6, P.width + P.buffer * 2 + 6),
      new THREE.MeshLambertMaterial({ color: "#1d5c33" })
    );
    apron.rotation.x = -Math.PI / 2; apron.position.y = -0.02; apron.receiveShadow = true;
    this.scene.add(apron);
    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(P.length, P.width),
      new THREE.MeshLambertMaterial({ map: this.pitchTex() })
    );
    pitch.rotation.x = -Math.PI / 2; pitch.receiveShadow = true;
    this.scene.add(pitch);
    // perimeter wall
    const wallMat = new THREE.MeshLambertMaterial({ color: "#e2e8f0" });
    const adMat = new THREE.MeshLambertMaterial({ color: "#0ea5e9" });
    const mkWall = (w: number, d: number, x: number, z: number, c?: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, P.wallHeight, d), c ?? wallMat);
      m.position.set(x, P.wallHeight / 2, z); m.castShadow = true;
      this.scene.add(m);
    };
    const bx = P.length / 2 + P.buffer, bz = P.width / 2 + P.buffer;
    mkWall((bx + 0.3) * 2, 0.3, 0, -bz, adMat); mkWall((bx + 0.3) * 2, 0.3, 0, bz);
    mkWall(0.3, (bz + 0.3) * 2, -bx, 0); mkWall(0.3, (bz + 0.3) * 2, bx, 0);
    // goals
    for (const s of [-1, 1]) {
      const gx = s * (P.length / 2);
      const grp = new THREE.Group();
      const postMat = new THREE.MeshLambertMaterial({ color: "#f8fafc" });
      const pg = new THREE.CylinderGeometry(0.06, 0.06, P.goalHeight, 10);
      for (const z of [-P.goalWidth / 2, P.goalWidth / 2]) {
        const post = new THREE.Mesh(pg, postMat);
        post.position.set(0, P.goalHeight / 2, z); post.castShadow = true; grp.add(post);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, P.goalWidth + 0.12, 10), postMat);
      bar.rotation.x = Math.PI / 2; bar.position.set(0, P.goalHeight, 0); grp.add(bar);
      // net volume (cheap, non-simulated trigger)
      const net = new THREE.Mesh(
        new THREE.BoxGeometry(P.goalDepth, P.goalHeight, P.goalWidth),
        new THREE.MeshBasicMaterial({ color: "#ffffff", wireframe: true, transparent: true, opacity: 0.25 })
      );
      net.position.set(s * P.goalDepth / 2, P.goalHeight / 2, 0);
      grp.add(net);
      grp.position.set(gx, 0, 0);
      this.scene.add(grp);
    }
    // lights: 1 directional + soft ambient, subtle contact shadows
    const sun = new THREE.DirectionalLight("#ffffff", 1.35);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -28; sun.shadow.camera.right = 28;
    sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
    this.scene.add(sun, new THREE.HemisphereLight("#dff3ff", "#12351f", 0.75));
  }

  private buildPlayers() {
    const mkTeam = (team: number, startIdx: number) => {
      const key = team === 0 ? "RED" : "BLUE";
      FORMATIONS[key].forEach((f, i) => {
        const idx = startIdx + i;
        const fam: MeshFamily = this.familyMode === "mixed" ? (idx % 2 === 0 ? "Blocky" : "Roundy") : this.familyMode === "blocky" ? "Blocky" : "Roundy";
        const variant = generateVariant(this.matchSeed + team * 77, team, f.role, fam, i);
        const rig = createPlayerMesh(variant);
        const anim = new AnimationController();
        anim.locoPhase = this.rng.range(0, Math.PI * 2);
        this.scene.add(rig.group);
        this.players.push({
          idx, team, role: f.role, roleIdx: i,
          pos: new THREE.Vector3(f.home[0], 0, f.home[1]), vel: new THREE.Vector3(),
          facing: team === 0 ? 0 : Math.PI, speed: 0, rig, anim,
          moveTarget: new THREE.Vector3(f.home[0], 0, f.home[1]), desiredSpeed: 0,
          pendingKick: null, holdT: 0, stumbleT: 0, celebrateT: 0,
          callForBall: false, isHuman: idx === this.humanIdx, stamina: 1,
          decisionReason: "init", utilities: {}, restartTaker: false,
          runSerial: 0, style: this.ai.sampleStyle(f.role), lastActionSeed: null,
        });
      });
    };
    mkTeam(0, 0); mkTeam(1, 5);
    this.players.forEach((p) => { p.isHuman = p.idx === this.humanIdx; });
    this.selectedIdx = this.humanIdx;
  }

  private buildAIDebug() {
    const geo = new THREE.BufferGeometry();
    this.aiLinePos = new THREE.Float32BufferAttribute(new Float32Array(10 * 2 * 3), 3);
    geo.setAttribute("position", this.aiLinePos);
    this.aiLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.7 }));
    this.aiLines.frustumCulled = false;
    this.scene.add(this.aiLines);
  }

  // ---------------- input ----------------
  private onKey = (e: KeyboardEvent, down: boolean) => {
    const k = e.key.toLowerCase();
    if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "tab"].includes(k === " " ? " " : k) || k === "tab") e.preventDefault();
    if (down) this.keys.add(k); else this.keys.delete(k);
    if (!down) return;
    if (k === "c") this.cameraMode = this.cameraMode === "broadcast" ? "follow" : this.cameraMode === "follow" ? "free" : "broadcast";
    if (k === "x") this.switchToNearest(true);
    if (k === "v") this.spectator = !this.spectator;
    if (k === "t") this.aimRaw = !this.aimRaw;
    if (k === "g") this.showAIDebug = !this.showAIDebug;
    if (k === "h") this.showAnimOverlay = !this.showAnimOverlay;
    if (k === "r") this.resetPositions("kickoff");
  };
  private kd = (e: KeyboardEvent) => this.onKey(e, true);
  private ku = (e: KeyboardEvent) => this.onKey(e, false);
  private attachInput() {
    if (this.headless || typeof window === "undefined") return;
    window.addEventListener("keydown", this.kd);
    window.addEventListener("keyup", this.ku);
  }
  dispose() {
    this.disposed = true;
    if (!this.headless && typeof window !== "undefined") {
      window.removeEventListener("keydown", this.kd);
      window.removeEventListener("keyup", this.ku);
    }
    this.renderer.dispose();
  }
  resize() {
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 500;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  /** Imports one clip, or every clip in a `fieldmotion.pack.v1` bundle. */
  importMotionPack(text: string, filename = "motion.json"): FieldMotionClip[] {
    const parsed = parseFieldMotionText(text, filename);
    const accepted: FieldMotionClip[] = [];
    const problems: string[] = [];
    for (const clip of parsed) {
      const errors = validateFieldMotionAgainstSkeleton(clip);
      if (errors.length) { problems.push(`${clip.id}: ${errors.join("; ")}`); continue; }
      if (getRegisteredMotionClips().some((c) => c.id === clip.id)) { problems.push(`${clip.id}: already imported`); continue; }
      registerFieldMotionClip(clip, { slot: clip.meta.tags.find((t) => t.startsWith("slot:"))?.slice(5) });
      accepted.push(clip);
    }
    if (!accepted.length) throw new Error(problems.join(" | ") || "No usable clips in file");
    if (problems.length) console.warn(`[motion] skipped ${problems.length} clip(s): ${problems.join(" | ")}`);
    return accepted;
  }

  importMotionJSON(text: string, filename = "motion.json", clipId?: string): FieldMotionClip {
    const clips = this.importMotionPack(text, filename);
    return clips.find((c) => c.id === clipId) ?? clips[0];
  }

  playClipOnSelected(id: string): boolean {
    if (!this.players[this.selectedIdx] || !clipExists(id)) return false;
    return this.startAction(this.players[this.selectedIdx], id);
  }

  switchToNearest(manual = false) {
    const mates = this.players.filter((p) => p.team === this.humanTeam && p.role !== "GK");
    const best = [...mates].sort((a, b) => a.pos.distanceTo(this.ball.pos) - b.pos.distanceTo(this.ball.pos))[0];
    if (best && best.idx !== this.humanIdx) {
      this.players[this.humanIdx].isHuman = false;
      this.humanIdx = best.idx; best.isHuman = true;
      this.selectedIdx = best.idx;
      if (manual) this.rules.emit("POSSESSION", `Manual switch → ${best.role} #${best.idx}`);
    }
  }

  resetPositions(kind: string) {
    this.ai.tactics.reset();
    this.passFlight = undefined; this.lastPass = undefined; this.frameWorld = null;
    this.ball.handsRestrictedTeam = null;
    const halfFlip = this.rules.half === 2 ? -1 : 1;
    for (const p of this.players) {
      const [hx, hz] = FORMATIONS[p.team === 0 ? "RED" : "BLUE"][p.roleIdx].home;
      p.pos.set(hx * halfFlip, 0, hz); p.vel.set(0, 0, 0);
      p.moveTarget.copy(p.pos);
      p.facing = this.ai.attackSign(p.team, this.rules.half) > 0 ? 0 : Math.PI;
      p.pendingKick = null; p.restartTaker = false; p.holdT = 0; p.stumbleT = 0;
      p.runSerial = 0; p.lastActionSeed = null;
      p.anim = new AnimationController();
      p.anim.locoPhase = this.rng.range(0, Math.PI * 2);
    }
    const ctr = kind === "kickoff" ? 0 : this.rules.pendingRestart?.pos[0] ?? 0;
    const ctz = kind === "kickoff" ? 0 : this.rules.pendingRestart?.pos[1] ?? 0;
    this.ball.pos.set(ctr, CONFIG.ball.radius, ctz);
    this.ball.vel.set(0, 0, 0); this.ball.release();
    if (kind === "kickoff") {
      const kickTeam = this.rules.pendingRestart?.team ?? this.rules.initialKickoffTeam;
      const sign = this.ai.attackSign(kickTeam, this.rules.half);
      const candidates = [this.players[kickTeam * 5 + 3], this.players[kickTeam * 5 + 4]];
      const kicker = this.rng.weighted(candidates.map((p) => ({ value: p, weight: p.style.directness + p.style.creativity * 0.45 })));
      // Kickoff staging uses separated lanes; avoid clamping every player onto one x-coordinate.
      for (const p of this.players) {
        const attack = this.ai.attackSign(p.team, this.rules.half);
        if (p.team === kickTeam) {
          if (p.role === "GK") p.pos.set(-attack * 17.8, 0, 0);
          else if (p.role === "DEF") p.pos.set(-attack * 9, 0, p.roleIdx === 1 ? -5.4 : 5.4);
          else if (p.idx !== kicker.idx && !candidates.some((q) => q.idx === p.idx)) {
            p.pos.set(-attack * 6.4, 0, p.roleIdx % 2 ? -4.4 : 4.4);
          }
        } else {
          // Opponents begin beyond the centre circle in their own half.
          if (p.role === "GK") p.pos.set(-attack * 17.8, 0, 0);
          else if (p.role === "DEF") p.pos.set(-attack * 8.8, 0, p.roleIdx === 1 ? -5.4 : 5.4);
          else if (p.role === "MID") p.pos.set(-attack * 6.4, 0, -3.1);
          else p.pos.set(-attack * 4.9, 0, 2.2);
        }
        p.moveTarget.copy(p.pos);
        p.vel.set(0, 0, 0);
      }
      const support = candidates.find((p) => p.idx !== kicker.idx)!;
      kicker.pos.set(-sign * 0.52, 0, 0);
      support.pos.set(-sign * 3.35, 0, kicker.idx % 2 ? 1.55 : -1.55);
      kicker.moveTarget.copy(kicker.pos);
      support.moveTarget.copy(support.pos);
      kicker.facing = sign > 0 ? 0 : Math.PI;
      kicker.restartTaker = true;
      this.ball.possess(kicker.idx, kickTeam);
    }
    this.restartAutoT = 0.6;
    this.ai.nextThink.clear();
    this.ai.lastDecision.clear();
  }

  // ---------------- per-frame ----------------
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
      this.placeForRestart();
      this.placedRestartId = restart.id;
      this.restartRetries = 0;
      this.restartStartedId = -1;
      this.restartLaunchedId = -1;
    }
    if (!restart) { this.restartStartedId = -1; this.restartLaunchedId = -1; }

    const live = this.rules.live;
    const frozen = this.rules.frozen;
    if (this.passFlight && (this.ball.possessedBy !== null || this.clock > this.passFlight.expiresAt
      || !live || this.rules.pendingRestart || this.ball.lastTouchTeam !== this.passFlight.team)) this.passFlight = undefined;

    // world snapshot for AI
    const ownerIdx = this.ball.possessedBy;
    const snap: WorldSnap = {
      ballPos: this.ball.pos.clone(), ballVel: this.ball.vel.clone(),
      ballOwner: ownerIdx, ballOwnerTeam: this.ball.ownerTeam,
      players: this.players.map((p) => ({
        idx: p.idx, team: p.team, role: p.role, roleIdx: p.roleIdx, pos: p.pos.clone(), vel: p.vel.clone(),
        facing: p.facing, speed: p.speed, busy: p.anim.busy,
        uninterruptible: p.anim.uninterruptible, cooldowns: p.anim.cooldowns,
        stamina: p.stamina, hasBall: this.ball.possessedBy === p.idx,
        callForBall: p.callForBall, isHuman: p.isHuman, runSerial: p.runSerial, style: p.style,
        moveTarget: p.moveTarget.clone(), desiredSpeed: p.desiredSpeed, pendingPassTo: p.pendingKick?.passTo,
      })),
      time: this.clock, half: this.rules.half, matchSeed: this.matchSeed,
      ballKickAge: this.ball.kickAge,
      ownerSince: this.possessionStartedAt,
      transitionUntil: this.transitionTeam === this.ball.ownerTeam ? this.transitionUntil : 0,
      passFlight: this.passFlight, lastPass: this.lastPass,
    };
    this.frameWorld = snap;
    if (live && !this.rules.pendingRestart) {
      this.ai.tactics.plan(snap, 0);
      this.ai.tactics.plan(snap, 1);
    }

    // celebrations
    if (this.rules.phase === "GOAL") {
      for (const p of this.players) {
        if (p.team === (this.rules.events[this.rules.events.length - 1]?.team ?? 0) && p.role !== "GK") {
          if (!p.anim.actionId) this.startAction(p, "celebrate");
        }
      }
    }

    if (this.debugAI) {
      // Fresh trace row per player per frame, before any control branch runs.
      for (const p of this.players) {
        this.aiTrace.set(p.idx, {
          idx: p.idx, team: p.team, role: p.role, hasBall: this.ball.possessedBy === p.idx,
          branch: "?", thinkCalled: false, thinkFresh: false,
          decisionReason: "", actionReturned: null, startActionResult: "n/a",
          animBusy: p.anim.busy, animUninterruptible: p.anim.uninterruptible, animActionId: p.anim.actionId,
          moveTarget: "", desiredSpeed: 0, speed: p.speed, overwrittenBy: "",
        });
      }
    }

    for (const p of this.players) {
      // Clear stale kick intents once the animation that owned them has finished.
      if (p.pendingKick && !p.anim.busy) p.pendingKick = null;
      const restartHold = live && this.rules.pendingRestart !== null
        && this.restartLaunchedId !== this.rules.pendingRestart.id;
      const isHumanControlled = !this.spectator && p.idx === this.humanIdx && live && !restartHold;
      const tr = this.debugAI ? this.aiTrace.get(p.idx) : undefined;
      if (restartHold) {
        p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
        p.decisionReason = "Restart setup · waiting for ball contact";
        if (tr) { tr.branch = "restartHold"; tr.overwrittenBy = `restartHold(${this.rules.pendingRestart?.kind})`; }
      } else if (isHumanControlled) {
        this.humanControl(p, dt, snap);
        if (tr) tr.branch = "human";
      } else this.aiControl(p, dt, snap, live, frozen);
      if (tr) {
        tr.decisionReason = p.decisionReason;
        tr.moveTarget = `${p.moveTarget.x.toFixed(1)},${p.moveTarget.z.toFixed(1)}`;
        tr.desiredSpeed = +p.desiredSpeed.toFixed(2);
      }

      // integrate movement — real acceleration model (m/s²), no instant reversals
      const toTarget = _v1.copy(p.moveTarget).sub(p.pos); toTarget.y = 0;
      const distT = toTarget.length();
      let desired = _v2.set(0, 0, 0);
      if (distT > 0.05) desired.copy(toTarget.normalize().multiplyScalar(Math.min(p.desiredSpeed, distT * 2.2 + 0.3)));
      // Soft separation prevents teammate collisions while preserving carrier/tackle access.
      const separation = new THREE.Vector3();
      for (const other of this.players) {
        if (other.idx === p.idx) continue;
        const away = p.pos.clone().sub(other.pos).setY(0);
        const distance = away.length();
        if (distance <= 0.01 || distance >= 1.25) continue;
        away.multiplyScalar((1.25 - distance) * (p.team === other.team ? 3.2 : 1.1) / distance);
        separation.add(away);
      }
      desired.add(separation);
      const rootAction = p.anim.actionId ? getClip(p.anim.actionId).rootMotion : false;
      if (rootAction) p.vel.multiplyScalar(Math.max(0, 1 - dt * 12));
      else {
        const sp = Math.hypot(p.vel.x, p.vel.z);
        const dLen = desired.length();
        const dot = sp > 0.05 && dLen > 0.05 ? (p.vel.x * desired.x + p.vel.z * desired.z) / (sp * dLen) : 1;
        if (dot < -0.2 && sp > 0.4) {
          // plant-and-cut: bleeding current momentum before committing to the new direction
          const bleed = Math.min(sp, CONFIG.player.decel * dt);
          p.vel.x -= (p.vel.x / sp) * bleed;
          p.vel.z -= (p.vel.z / sp) * bleed;
        } else if (dLen > 1e-4) {
          const rate = dLen > sp ? CONFIG.player.accel : CONFIG.player.decel;
          const stepN = Math.min(dLen, rate * dt);
          p.vel.x += (desired.x - p.vel.x) / dLen * stepN;
          p.vel.z += (desired.z - p.vel.z) / dLen * stepN;
        } else if (sp > 0.05) {
          // no input: brake to a stop at the measured decel rate
          const bleed = Math.min(sp, CONFIG.player.decel * dt);
          p.vel.x -= (p.vel.x / sp) * bleed;
          p.vel.z -= (p.vel.z / sp) * bleed;
        }
      }
      // speed cap: real top speed per role, scaled down as stamina drains
      const baseCap = p.role === "GK"
        ? CONFIG.player.gkSprintSpeed
        : (isHumanControlled && this.keys.has("shift") ? CONFIG.player.sprintSpeed : CONFIG.ai.maxSprint);
      const maxSp = baseCap * (0.72 + 0.28 * p.stamina);
      if (p.vel.length() > maxSp) p.vel.setLength(maxSp);
      p.pos.addScaledVector(p.vel, dt);
      // walls clamp — restart takers may legally stand outside the field of play
      // (corner taker behind the flag), so give them the buffer area.
      const HX = CONFIG.pitch.length / 2 - 0.4, HZ = CONFIG.pitch.width / 2 - 0.4;
      const margin = p.restartTaker ? CONFIG.pitch.buffer + 0.4 : 0;
      p.pos.x = THREE.MathUtils.clamp(p.pos.x, -HX - margin, HX + margin);
      p.pos.z = THREE.MathUtils.clamp(p.pos.z, -HZ - margin, HZ + margin);
      p.speed = p.vel.length();

      // facing: toward velocity, or toward ball when idle/defending, or toward moveTarget when shielding
      let wantFacing = p.facing;
      if (p.speed > 0.4) wantFacing = yawOfVector(p.vel);
      else if (this.ball.possessedBy !== p.idx) {
        _v1.copy(this.ball.pos).sub(p.pos);
        if (_v1.length() > 0.3) wantFacing = yawOfVector(_v1);
      } else if (p.pendingKick) {
        _v1.copy(p.pendingKick.target).sub(p.pos);
        wantFacing = yawOfVector(_v1);
      }
      const dYaw = yawDelta(p.facing, wantFacing);
      // Turn-in-place: never for the carrier or keeper (its root yaw fought the facing
      // steering and produced the side-to-side spin), and never over a pending kick.
      const carrying = this.ball.possessedBy === p.idx;
      // Turn-in-place is a stationary animation. A player who is trying to run must
      // turn while accelerating instead, or a mid-run change of direction freezes him
      // for the length of the clip (the "everyone holds position" symptom).
      if (Math.abs(dYaw) > 1.9 && p.speed < 1.2 && p.desiredSpeed < 1.6 && !p.anim.busy && live && !carrying && p.role !== "GK" && !p.pendingKick) {
        this.startAction(p, dYaw > 0 ? "turn_left" : "turn_right");
      }
      const rootTurning = p.anim.actionId === "turn_left" || p.anim.actionId === "turn_right" || p.anim.actionId === "turn_180";
      if (!rootTurning) p.facing = turnTowards(p.facing, wantFacing, CONFIG.player.turnRate * dt);

      // stamina
      p.stamina = THREE.MathUtils.clamp(p.stamina + dt * (p.speed > 6 ? -CONFIG.player.staminaDrain : CONFIG.player.staminaRegen), 0.2, 1);

      // anim update
      const velAng = p.speed > 0.3 ? yawOfVector(p.vel) : p.facing;
      const dAng = yawDelta(p.facing, velAng);
      p.anim.jockey = !isHumanControlled && this.ball.ownerTeam !== p.team && this.ball.ownerTeam !== null && p.speed < 2.2;
      // Ball direction relative to the player's facing: drives the head-watch layer.
      const ballLocal = yawDelta(p.facing, yawOfVector(_v1.copy(this.ball.pos).sub(p.pos)));
      const au = p.anim.update(dt, p.speed, dAng, { shielding: p.pendingKick !== null, ballDirLocal: ballLocal });
      // root motion add
      if (au.rootDelta.dx || au.rootDelta.dz || au.rootDelta.dYaw) {
        const fw = p.facing;
        p.pos.x += Math.cos(fw) * au.rootDelta.dx + Math.sin(fw) * au.rootDelta.dz;
        p.pos.z += -Math.sin(fw) * au.rootDelta.dx + Math.cos(fw) * au.rootDelta.dz;
        p.facing += au.rootDelta.dYaw;
      }
      // contact event → ball truth
      if (au.contact) this.onContact(p, au.contact);

      applyPose(p.rig.skeleton, au.pose);
      // root transform: facing 0 = +X, skeleton fwd +Z → yaw = facing + 90°
      p.rig.group.position.copy(p.pos);
      p.rig.group.rotation.y = p.facing + Math.PI / 2;
      // bob + IK ground offset
      const bob = Math.sin(p.anim.locoPhase * 2) * 0.02 * Math.min(1, p.speed / 5);
      p.rig.group.position.y = bob + (au.clip === "tackle_slide" ? -0.42 * Math.sin(Math.min(1, au.nt) * Math.PI) : 0)
        + ((au.clip === "gk_dive_L" || au.clip === "gk_dive_R") ? -0.25 * Math.sin(Math.min(1, au.nt) * Math.PI) : 0)
        + p.anim.proceduralOffset.y * 0.4;
      p.rig.group.position.x += p.anim.proceduralOffset.x * (1 - p.anim.proceduralT);
      p.rig.group.position.z += p.anim.proceduralOffset.z * (1 - p.anim.proceduralT);
    }

    this.resolvePlayerCollisions();
    // The live ball owner can change during a contact event in this frame.
    const currentOwner = this.ball.possessedBy !== null ? this.players[this.ball.possessedBy] : null;
    const heldRestart = this.rules.pendingRestart && this.restartLaunchedId !== this.rules.pendingRestart.id
      ? this.rules.pendingRestart : null;
    if (heldRestart) {
      const taker = this.players.find((p) => p.restartTaker);
      if (heldRestart.kind === "throw_in" && taker) {
        const forwardX = Math.cos(taker.facing), forwardZ = -Math.sin(taker.facing);
        this.ball.pos.set(taker.pos.x + forwardX * 0.12, 1.65, taker.pos.z + forwardZ * 0.12);
      } else {
        this.ball.pos.set(heldRestart.pos[0], CONFIG.ball.radius, heldRestart.pos[1]);
      }
      this.ball.vel.set(0, 0, 0);
      this.ball.mesh.position.copy(this.ball.pos);
      this.ball.shadow.position.set(this.ball.pos.x, 0.021, this.ball.pos.z);
    } else if (currentOwner) this.ball.step(dt, currentOwner.pos, currentOwner.facing, currentOwner.vel);
    else this.ball.step(dt);
    this.resolveBallPlayerCollisions();

    if (live) {
      if (!this.rules.pendingRestart) {
        this.possessionCheck();
        this.outGoalCheck();
      }
      this.trackPossession();
      this.restartAuto(dt);
    } else {
      // freeze ball at restart spot during setup
      if (this.rules.pendingRestart) {
        const [rx, rz] = this.rules.pendingRestart.pos;
        if (this.ball.possessedBy === null && this.ball.speed < 0.5) {
          this.ball.pos.set(rx, CONFIG.ball.radius, rz);
          this.ball.vel.set(0, 0, 0);
        }
      }
      // goal celebrate: keep ball inside net volume
      if (this.rules.phase === "GOAL") {
        this.ball.vel.multiplyScalar(Math.max(0, 1 - dt * 4));
        const L = CONFIG.pitch.length / 2;
        this.ball.pos.x = THREE.MathUtils.clamp(this.ball.pos.x, -L - 1.0, L + 1.0);
        this.ball.pos.z = THREE.MathUtils.clamp(this.ball.pos.z, -1.4, 1.4);
        if (this.ball.pos.y > 1.8) this.ball.pos.y = 1.8;
      }
    }

    if (this.debugAI) this.flushAITrace(realDt);

    this.updateCamera(dt);
    this.updateAIDebug();
    this.renderer.render(this.scene, this.camera);
  }

  /** ?debug=ai event (possession grant, kick release, cancellations). */
  private aiEvent(message: string) {
    if (!this.debugAI) return;
    const line = `[${this.clock.toFixed(2)}s] ${message}`;
    this.aiEventTotal++;
    this.aiEventLog.unshift(line);
    if (this.aiEventLog.length > 60) this.aiEventLog.pop();
    console.log("%c[ai]", "color:#c8f31d", line);
  }

  private flushAITrace(realDt: number) {
    this.aiTraceLogT += realDt;
    if (this.aiTraceLogT < 1) return; // one table per second of wall time
    this.aiTraceLogT = 0;
    const rows = [...this.aiTrace.values()];
    console.groupCollapsed(`[ai] t=${this.clock.toFixed(1)}s phase=${this.rules.phase} owner=${this.ball.possessedBy ?? "free"} restart=${this.rules.pendingRestart?.kind ?? "-"}`);
    console.table(rows);
    // Explicit stall diagnosis so the failing link is named rather than guessed.
    for (const r of rows) {
      if (r.branch === "ai" && !r.thinkCalled) console.warn(`[ai] #${r.idx} AI branch but think() not called`);
      if (r.hasBall && r.branch === "ai" && r.desiredSpeed < 0.5 && !r.animActionId) console.warn(`[ai] #${r.idx} CARRIER STALL: ${r.decisionReason} · start=${r.startActionResult}`);
      if (r.animBusy && r.animActionId && r.animUninterruptible) console.info(`[ai] #${r.idx} locked in ${r.animActionId}`);
      if (r.overwrittenBy) console.info(`[ai] #${r.idx} move target overwritten by ${r.overwrittenBy}`);
    }
    console.groupEnd();
  }

  private resolvePlayerCollisions() {
    const bodyRadius = (p: EnginePlayer) => p.role === "GK" ? 0.46 : 0.4;
    for (let i = 0; i < this.players.length; i++) {
      for (let j = i + 1; j < this.players.length; j++) {
        const a = this.players[i], b = this.players[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const distance = Math.hypot(dx, dz);
        const minimum = bodyRadius(a) + bodyRadius(b);
        if (distance >= minimum) continue;
        const nx = distance > 1e-4 ? dx / distance : (a.idx < b.idx ? 1 : -1);
        const nz = distance > 1e-4 ? dz / distance : 0.0001;
        const overlap = minimum - distance;
        // Grounded positional resolution: neither player may occupy the other's cylinder.
        const aPinned = a.anim.actionId !== null && getClip(a.anim.actionId).rootMotion;
        const bPinned = b.anim.actionId !== null && getClip(b.anim.actionId).rootMotion;
        const aShare = aPinned && !bPinned ? 0 : bPinned && !aPinned ? 1 : aPinned && bPinned ? 0.5 : a.speed >= b.speed ? 0.42 : 0.58;
        a.pos.x -= nx * overlap * aShare; a.pos.z -= nz * overlap * aShare;
        b.pos.x += nx * overlap * (1 - aShare); b.pos.z += nz * overlap * (1 - aShare);
        // Cancel closing velocity along the contact normal so they cannot fuse next frame.
        const closing = (a.vel.x - b.vel.x) * nx + (a.vel.z - b.vel.z) * nz;
        if (closing > 0) {
          a.vel.x -= nx * closing * 0.6; a.vel.z -= nz * closing * 0.6;
          b.vel.x += nx * closing * 0.6; b.vel.z += nz * closing * 0.6;
        }
        const halfX = CONFIG.pitch.length / 2 - 0.4, halfZ = CONFIG.pitch.width / 2 - 0.4;
        a.pos.x = THREE.MathUtils.clamp(a.pos.x, -halfX, halfX); a.pos.z = THREE.MathUtils.clamp(a.pos.z, -halfZ, halfZ);
        b.pos.x = THREE.MathUtils.clamp(b.pos.x, -halfX, halfX); b.pos.z = THREE.MathUtils.clamp(b.pos.z, -halfZ, halfZ);
        a.rig.group.position.x = a.pos.x; a.rig.group.position.z = a.pos.z;
        b.rig.group.position.x = b.pos.x; b.rig.group.position.z = b.pos.z;
      }
    }
  }

  private resolveBallPlayerCollisions() {
    if (this.ball.possessedBy !== null || this.ball.pos.y > 1.35) return;
    const R = CONFIG.ball.radius;
    for (const p of this.players) {
      const dx = this.ball.pos.x - p.pos.x, dz = this.ball.pos.z - p.pos.z;
      const distance = Math.hypot(dx, dz);
      // The striker's own fresh kick starts inside their body radius — never deflect it.
      if (p.idx === this.ball.kickedBy && this.ball.kickAge < 0.3) continue;
      // A controllable ball reaching a ready player is received (possessionCheck), not
      // bounced. Balls faster than the trap limit still hit the body and deflect.
      if (p.stumbleT <= 0 && distance < CONFIG.player.controlRadius + 0.35 && this.ball.pos.y < 0.85
        && this.ball.speed <= CONFIG.player.maxTrapSpeed && (p.role !== "GK" || this.ball.handsRestrictedTeam === p.team)) {
        continue;
      }
      const minimum = (p.role === "GK" ? 0.46 : 0.4) + R;
      if (distance >= minimum) continue;
      const nx = distance > 1e-4 ? dx / distance : 1, nz = distance > 1e-4 ? dz / distance : 0;
      this.ball.pos.x = p.pos.x + nx * minimum;
      this.ball.pos.z = p.pos.z + nz * minimum;
      const toward = this.ball.vel.x * nx + this.ball.vel.z * nz;
      if (toward < 0 && p.role === "GK" && this.ball.handsRestrictedTeam !== p.team && this.ball.speed < CONFIG.ai.gkCatchSpeed && this.ball.pos.y < 2.0 && p.stumbleT <= 0) {
        // Keeper got the body behind a catchable ball: gathered, not spilled.
        this.ball.possess(p.idx, p.team);
        this.ball.vel.set(0, 0, 0);
        p.holdT = 0;
        this.offsideCandidates.clear(); this.offsideTeam = null;
        this.aiEvent(`GK CATCH #${p.idx} (body behind ball) · ${(-toward).toFixed(1)} m/s`);
        this.rules.emit("SAVE", `GK CATCH by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
        return;
      }
      if (toward < 0) {
        // Body deflection: restitution ~0.25 off a torso/legs (energy absorbed).
        this.ball.vel.x -= 1.25 * toward * nx;
        this.ball.vel.z -= 1.25 * toward * nz;
        if (p.role === "GK" && -toward > 8) {
          this.aiEvent(`GK PARRY #${p.idx} (body block) · ${(-toward).toFixed(1)} m/s`);
          this.rules.emit("SAVE", `GK body block by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
        }
      }
      this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
      break;
    }
  }

  private placedRestartId = -1;
  private restartRetries = 0;
  private restartStartedId = -1;
  private restartLaunchedId = -1;
  private placeForRestart() {
    const pr = this.rules.pendingRestart;
    if (!pr) return;
    this.ai.tactics.reset(); this.passFlight = undefined; this.frameWorld = null;
    this.ball.handsRestrictedTeam = null;
    if (pr.kind === "kickoff") this.resetPositions("kickoff");
    else {
      this.ball.pos.set(pr.pos[0], CONFIG.ball.radius, pr.pos[1]);
      this.ball.vel.set(0, 0, 0); this.ball.release();
      for (const p of this.players) {
        const [hx, hz] = FORMATIONS[p.team === 0 ? "RED" : "BLUE"][p.roleIdx].home;
        p.pos.set(hx * (this.rules.half === 2 ? -1 : 1), 0, hz);
        p.vel.set(0, 0, 0); p.pendingKick = null; p.restartTaker = false; p.callForBall = false;
        p.anim = new AnimationController();
      }
      const sign = this.ai.attackSign(pr.team, this.rules.half);
      const takers = this.players.filter((p) => p.team === pr.team && (pr.kind === "goal_kick" ? p.role === "GK" : p.role !== "GK"));
      const selectTaker = () => {
        if (pr.kind === "goal_kick") return takers[0] ?? null;
        if (pr.kind === "kickoff") {
          const candidates = takers.filter((p) => p.role === "MID" || p.role === "FWD");
          return this.rng.weighted(candidates.map((p) => ({ value: p, weight: 0.6 + p.style.directness * 0.4 })));
        }
        // Throw-ins and corners are taken by the closest eligible outfielder to the exit point / flag.
        const ranked = [...takers].sort((a, b) => {
          const da = Math.hypot(a.pos.x - pr.pos[0], a.pos.z - pr.pos[1]);
          const db = Math.hypot(b.pos.x - pr.pos[0], b.pos.z - pr.pos[1]);
          if (Math.abs(da - db) > 1.4) return da - db;
          return tieBreakHash(this.matchSeed, a.idx, a.runSerial, `restart:${pr.id}`) - tieBreakHash(this.matchSeed, b.idx, b.runSerial, `restart:${pr.id}`);
        });
        if (pr.kind === "free_kick" || pr.kind === "penalty") {
          return [...ranked].sort((a, b) => b.style.creativity - a.style.creativity || b.style.shooting - a.style.shooting)[0];
        }
        return ranked[0] ?? null;
      };
      const taker = selectTaker();
      if (taker) {
        if (pr.kind === "throw_in") {
          taker.pos.set(pr.pos[0], 0, Math.sign(pr.pos[1]) * (CONFIG.pitch.width / 2 - 0.18));
        } else if (pr.kind === "goal_kick") {
          const side = Math.sign(pr.pos[0]);
          taker.pos.set(side * (CONFIG.pitch.length / 2 - 2.0), 0, pr.pos[1]);
        } else taker.pos.set(pr.pos[0], 0, pr.pos[1]);
        taker.moveTarget.copy(taker.pos); taker.desiredSpeed = 0;
        taker.restartTaker = true;
        const targetGuess = this.ai.goalPos(pr.team, this.rules.half);
        if (pr.kind === "throw_in") targetGuess.set(pr.pos[0] + sign * 5, 0, -Math.sign(pr.pos[1]) * 7);
        taker.facing = Math.atan2(-(targetGuess.z - taker.pos.z), targetGuess.x - taker.pos.x);
        if (pr.kind !== "throw_in") this.ball.possess(taker.idx, taker.team);
        if (pr.kind === "corner") {
          const goalX = this.ai.goalPos(pr.team, this.rules.half).x;
          const cornerSide = Math.sign(pr.pos[1]) || 1;
          // The taker stands OUTSIDE the field, behind the ball relative to the box, with
          // the flag between him and the goal line — never on the pitch side of the ball.
          // Behind the ball, outside the touchline: the flag sits between him and the goal line.
          taker.pos.set(goalX - sign * 0.75, 0, cornerSide * (CONFIG.pitch.width / 2 + 0.55));
          taker.moveTarget.copy(taker.pos);
          // Facing into the box: shoulders square to the penalty spot.
          taker.facing = Math.atan2(-(0 - taker.pos.z), (goalX - sign * 4.2) - taker.pos.x);
          // Lofted long delivery into the danger area: near post, penalty spot, far post, edge.
          const runnerSpots: [number, number][] = [
            [goalX - sign * 2.6, cornerSide * 1.4],    // near post
            [goalX - sign * 4.2, 0],                    // penalty spot
            [goalX - sign * 2.2, -cornerSide * 2.8],   // far post
            [goalX - sign * 6.4, -cornerSide * 1.6],   // edge of box
          ];
          const runners = this.players.filter((p) => p.team === pr.team && p.idx !== taker.idx && p.role !== "GK")
            .sort((a, b) => (b.role === "FWD" ? 1 : 0) - (a.role === "FWD" ? 1 : 0));
          runners.forEach((p, i) => {
            const spot = runnerSpots[i % runnerSpots.length];
            p.pos.set(spot[0], 0, spot[1]);
            p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0);
          });
          const defenders = this.players.filter((p) => p.team !== pr.team && p.role !== "GK");
          defenders.forEach((p, i) => {
            const spot = runnerSpots[i % runnerSpots.length];
            const goalSide = new THREE.Vector3(spot[0], 0, spot[1]).lerp(new THREE.Vector3(goalX, 0, spot[1]), 0.35);
            p.pos.set(goalSide.x, 0, goalSide.z);
            p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0);
          });
        }
        if (pr.kind === "goal_kick") {
          // Create genuine short and long options rather than one central punt:
          // defenders wide and short, midfield high between the lines, forward long.
          const ownGoalX = -sign * (CONFIG.pitch.length / 2);
          const teammates = this.players.filter((p) => p.team === pr.team && p.idx !== taker.idx);
          const order = ["DEF", "MID", "FWD"];
          teammates.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
          let defSlot = 0; let midSlot = 0;
          for (const p of teammates) {
            if (p.role === "DEF") {
              const z = (defSlot++ % 2 === 0 ? -1 : 1) * (7.8 + (defSlot % 2) * 1.2);
              p.pos.set(ownGoalX + sign * 10.5, 0, z);
            } else if (p.role === "MID") {
              const z = (midSlot++ % 2 === 0 ? -1 : 1) * 5.2;
              p.pos.set(ownGoalX + sign * 18.5, 0, z);
            } else {
              p.pos.set(sign * 10.5, 0, p.idx % 2 === 0 ? 3.4 : -3.4);
            }
            p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0);
          }
        }
        if (pr.kind === "throw_in") {
          const touchSide = Math.sign(pr.pos[1]) || 1;
          const receivers = this.players.filter((p) => p.team === pr.team && p.idx !== taker.idx && p.role !== "GK")
            .sort((a, b) => {
              const da = Math.hypot(a.pos.x - pr.pos[0], a.pos.z - touchSide * (CONFIG.pitch.width / 2 - 4.0));
              const db = Math.hypot(b.pos.x - pr.pos[0], b.pos.z - touchSide * (CONFIG.pitch.width / 2 - 4.0));
              return da - db || tieBreakHash(this.matchSeed, a.idx, a.runSerial, `throw-receiver:${pr.id}`)
                - tieBreakHash(this.matchSeed, b.idx, b.runSerial, `throw-receiver:${pr.id}`);
            });
          const nearReceiver = receivers[0];
          receivers.forEach((p, i) => {
            const depth = nearReceiver?.idx === p.idx ? 4.0 : 6.0 + (i % 2) * 1.2;
            const lane = nearReceiver?.idx === p.idx ? 0 : (i % 2 === 0 ? -1 : 1) * (2.2 + Math.floor(i / 2) * 1.2);
            p.pos.set(
              THREE.MathUtils.clamp(pr.pos[0] + sign * (nearReceiver?.idx === p.idx ? 2.0 : 1.0 + i * 0.4), -18.8, 18.8),
              0,
              touchSide * (CONFIG.pitch.width / 2 - depth) + lane,
            );
            p.moveTarget.copy(p.pos);
            p.vel.set(0, 0, 0);
          });
        }
      }
      // Opponents respect the restart distance without collapsing into the taker's lane.
      for (const p of this.players) {
        if (p.team !== pr.team && p.pos.distanceTo(this.ball.pos) < 2.4) {
          _v1.copy(p.pos).sub(this.ball.pos).setY(0);
          if (_v1.lengthSq() < 0.01) _v1.set(-sign, 0, p.idx % 2 ? 1 : -1);
          _v1.normalize().multiplyScalar(2.5);
          p.pos.copy(this.ball.pos).add(_v1);
        }
      }
      if (pr.kind === "goal_kick") {
        const ownGoalX = -sign * (CONFIG.pitch.length / 2);
        for (const p of this.players) {
          if (p.team === pr.team) continue;
          if (Math.abs(p.pos.x - ownGoalX) < 5.9 && Math.abs(p.pos.z) < 6.3) {
            p.pos.x = ownGoalX + sign * 6.2;
            p.pos.z = THREE.MathUtils.clamp(p.pos.z, -8, 8);
          }
        }
      }
    }
    this.restartAutoT = 0.55;
  }

  /** Clearance of the straight lane from a to b: 1 = totally open, 0 = blocked. */
  private laneOpenness(a: THREE.Vector3, b: THREE.Vector3, opponents: EnginePlayer[]): number {
    const seg = b.clone().sub(a).setY(0);
    const len2 = Math.max(0.001, seg.lengthSq());
    let blocked = 0;
    for (const o of opponents) {
      const rel = o.pos.clone().sub(a).setY(0);
      const t = THREE.MathUtils.clamp(rel.dot(seg) / len2, 0.05, 0.95);
      const closest = a.clone().addScaledVector(seg, t);
      const gap = closest.distanceTo(o.pos);
      if (gap < 1.9) blocked += (1.9 - gap) / 1.9;
    }
    return THREE.MathUtils.clamp(1 - blocked * 0.4, 0, 1);
  }

  /**
   * Goalkeeper distribution: evaluate every outfield teammate as a short or long option
   * using receiver space, lane clearance and pressure on the keeper — not a distance
   * threshold. Returns the chosen action, named receiver, predicted aim point and reason.
   */
  private evaluateGkDistribution(gk: EnginePlayer): { action: string; receiver: EnginePlayer; target: THREE.Vector3; reason: string; short: boolean } | null {
    const mates = this.players.filter((p) => p.team === gk.team && p.idx !== gk.idx && p.role !== "GK");
    if (!mates.length) return null;
    const opponents = this.players.filter((p) => p.team !== gk.team);
    const pressure = Math.min(...opponents.map((o) => o.pos.distanceTo(gk.pos)));
    const origin = this.ball.pos.clone();
    const sign = this.ai.attackSign(gk.team, this.rules.half);
    const options = mates.map((m) => {
      const target = m.pos.clone().addScaledVector(m.vel, 0.4);
      target.x = THREE.MathUtils.clamp(target.x, -18.8, 18.8);
      target.z = THREE.MathUtils.clamp(target.z, -11.2, 11.2);
      const dist = Math.hypot(target.x - origin.x, target.z - origin.z);
      const space = Math.min(...opponents.map((o) => o.pos.distanceTo(target)), 20);
      const lane = this.laneOpenness(origin, target, opponents);
      const forward = (target.x - gk.pos.x) * sign;
      const short = dist <= 22;
      // Short options value safety and a clean lane; long options value the receiver's
      // isolation from defenders and territory.
      let score = short
        ? lane * 0.42 + THREE.MathUtils.clamp(space / 7, 0, 1) * 0.34 + 0.1
        : THREE.MathUtils.clamp(space / 9, 0, 1) * 0.42 + lane * 0.2 + THREE.MathUtils.clamp(forward / 30, 0, 1) * 0.2;
      if (pressure < 3.2) score += short ? -0.22 : 0.18;
      if (short && lane < 0.4) score -= 0.35;
      score += tieBreakHash(this.matchSeed, gk.idx, gk.runSerial, `gkdist:${m.idx}:${short}`) * 0.04;
      return { m, target, dist, space, lane, short, score };
    }).sort((a, b) => b.score - a.score);
    const shortOpts = options.filter((o) => o.short);
    const longOpts = options.filter((o) => !o.short);
    const bestShort = shortOpts[0];
    // If the clear short option is genuinely better than the best long option, play out;
    // otherwise go long to the free receiver. Pressured keepers still look long first.
    const useShort = !!bestShort && (pressure < 4.2 || (bestShort.lane > 0.5 && bestShort.space > 3.2))
      && bestShort.score >= (longOpts[0]?.score ?? -1) - 0.05;
    const chosen = useShort ? bestShort! : (longOpts[0] ?? bestShort!);
    return {
      action: this.ball.handsRestrictedTeam === gk.team
        ? chosen.short ? "pass_short" : "pass_long"
        : chosen.short ? "gk_roll" : "gk_punt",
      receiver: chosen.m,
      target: chosen.target,
      short: chosen.short,
      reason: `GK ${this.ball.handsRestrictedTeam === gk.team ? "FEET " : ""}${chosen.short ? "SHORT" : "LONG"} → #${chosen.m.idx} ${chosen.m.role} · ${chosen.dist.toFixed(0)}m · lane ${chosen.lane.toFixed(2)} · space ${chosen.space.toFixed(1)}m · press ${pressure.toFixed(1)}m`,
    };
  }

  private restartWaitReason = "";
  private warnedRestartId = -1;
  private restartBlockReason(pr: NonNullable<RulesEngine["pendingRestart"]>, taker: EnginePlayer): string {
    const opponents = this.players.filter((p) => p.team !== pr.team);
    const near = (pos: THREE.Vector3, radius: number) => opponents.filter((p) => p.pos.distanceTo(pos) < radius);
    if (pr.kind === "goal_kick") {
      if (taker.role !== "GK") return "Waiting: goalkeeper must take the goal kick";
      const ownGoal = this.ai.ownGoal(taker.team, this.rules.half);
      const inside = opponents.filter((p) => Math.abs(p.pos.x - ownGoal.x) < 5.9 && Math.abs(p.pos.z) < 6.3);
      if (inside.length) return `Waiting: ${inside.length} opponent(s) inside the penalty area`;
      if (near(this.ball.pos, 2.2).length) return "Waiting: opponent inside the exclusion zone";
    }
    if (pr.kind === "kickoff") {
      const violation = kickoffRestartViolation(
        opponents.map((p) => ({ x: p.pos.x, z: p.pos.z })),
        this.ai.attackSign(taker.team, this.rules.half),
      );
      if (violation) return violation;
    }
    if (pr.kind === "corner" || pr.kind === "throw_in" || pr.kind === "free_kick" || pr.kind === "penalty") {
      if (near(this.ball.pos, 2.0).length) return "Waiting: opponent too close to the restart";
    }
    return "";
  }

  private restartContactT = 0;
  private restartAuto(dt: number) {
    const pr = this.rules.pendingRestart;
    if (this.rules.phase !== "INPLAY" || !pr) return;
    if (this.restartStartedId === pr.id && this.restartLaunchedId !== pr.id) {
      // Contact-frame watchdog: a cancelled wind-up must never soft-lock the match
      // or loop the same restart. Release the ball at the taker and resume play.
      this.restartContactT += dt;
      if (this.restartContactT > 2.4) {
        const stuck = this.players.find((p) => p.restartTaker);
        if (stuck) {
          stuck.pendingKick = null;
          stuck.restartTaker = false;
          this.ball.release();
          this.ball.pos.set(stuck.pos.x, CONFIG.ball.radius, stuck.pos.z);
          this.ball.vel.set(0, 0, 0);
        }
        this.restartStartedId = -1;
        this.restartContactT = 0;
        this.rules.pendingRestart = null;
        this.rules.emit("RESTART_READY", "Restart released — contact window expired");
      }
      return;
    }
    if (this.restartLaunchedId === pr.id) return;
    this.restartContactT = 0;
    this.restartAutoT -= dt;
    if (this.restartAutoT > 0) return;
    let taker = this.players.find((p) => p.restartTaker);
    // Kickoff recovery: possession is authoritative; repair a missing taker flag
    // instead of leaving the whole match frozen at the centre spot.
    if (!taker && pr.kind === "kickoff" && this.ball.possessedBy !== null) {
      const owner = this.players[this.ball.possessedBy];
      if (owner?.team === pr.team) {
        owner.restartTaker = true;
        taker = owner;
      }
    }
    if (!taker || taker.anim.busy) { this.restartAutoT = 0.15; return; }
    const block = this.restartBlockReason(pr, taker);
    this.restartWaitReason = block;
    if (block) {
      this.restartAutoT = 0.25;
      if (this.warnedRestartId !== pr.id) {
        this.warnedRestartId = pr.id;
        this.rules.whistle(block.replace("Waiting: ", "Restart delayed — "));
      }
      return;
    }
    const selection = this.sampleRestartTarget(pr, taker);
    let action = "pass_short";
    if (pr.kind === "throw_in") action = "throw_in";
    else if (pr.kind === "corner") action = "corner_kick";
    else if (pr.kind === "penalty") action = "shoot_normal";
    else if (pr.kind === "free_kick") action = taker.pos.distanceTo(this.ai.goalPos(taker.team, this.rules.half)) < 13 ? "shoot_normal" : "pass_long";
    else if (pr.kind === "kickoff") action = "pass_short";
    // Goal kick: choose short/long from measured space and lane clearance, never distance alone.
    let goalKickChoice: ReturnType<MatchEngine["evaluateGkDistribution"]> = null;
    if (pr.kind === "goal_kick") {
      goalKickChoice = this.evaluateGkDistribution(taker);
      if (goalKickChoice) {
        action = goalKickChoice.action;
        selection.target.copy(goalKickChoice.target);
        selection.player = goalKickChoice.receiver;
        this.aiEvent(goalKickChoice.reason);
      }
    }
    const seed = this.rng.nextUint();
    if (this.startAction(taker, action, selection.target, selection.player?.idx, seed)) {
      this.restartStartedId = pr.id;
      this.restartWaitReason = "";
      if (pr.kind === "kickoff") {
        this.rules.whistle("Kickoff taken — play is underway");
      } else {
        this.rules.whistle(`${pr.kind.replace("_", " ")} taken`);
      }
    } else this.restartAutoT = 0.15;
  }

  private sampleRestartTarget(pr: NonNullable<RulesEngine["pendingRestart"]>, taker: EnginePlayer): { target: THREE.Vector3; player?: EnginePlayer } {
    const mates = this.players.filter((p) => p.team === taker.team && p.idx !== taker.idx && p.role !== "GK");
    const sign = this.ai.attackSign(taker.team, this.rules.half);
    const goal = this.ai.goalPos(taker.team, this.rules.half);
    if (pr.kind === "penalty" || (pr.kind === "free_kick" && taker.pos.distanceTo(goal) < 13)) {
      const keeper = this.players.find((p) => p.team !== taker.team && p.role === "GK");
      const lanes = [-1.05, -0.5, 0, 0.5, 1.05].map((z) => ({
        value: new THREE.Vector3(goal.x, 0, z),
        weight: 0.25 + Math.abs((keeper?.pos.z ?? 0) - z) * 0.55 + this.rng.range(0, 0.24),
      }));
      return { target: this.rng.weighted(lanes) };
    }
    if (pr.kind === "kickoff") {
      // At kickoff, passer cleanly finds the supporting teammate on the kickoff circle
      const support = mates.find((m) => m.pos.distanceTo(taker.pos) < 5.8 && m.role !== "GK") ?? mates[0];
      if (support) return { target: support.pos.clone(), player: support };
    }
    if (pr.kind === "corner") {
      // Lofted long delivery. The aim zone is the danger area (penalty spot / far post /
      // near post), and the named receiver is the runner closest to it — never the short
      // taker-side option.
      const goalX = goal.x;
      const cornerSide = Math.sign(pr.pos[1]) || 1;
      const zones = [
        { value: new THREE.Vector3(goalX - sign * 4.2, 0, 0), weight: 0.44 },              // penalty spot
        { value: new THREE.Vector3(goalX - sign * 2.6, 0, -cornerSide * 2.6), weight: 0.3 }, // far post
        { value: new THREE.Vector3(goalX - sign * 2.6, 0, cornerSide * 1.4), weight: 0.18 }, // near post
        { value: new THREE.Vector3(goalX - sign * 6.4, 0, -cornerSide * 1.6), weight: 0.08 },// edge
      ];
      const zoneTarget = this.rng.weighted(zones);
      const runner = [...mates].filter((p) => p.role !== "GK").sort((a, b) => {
        const da = Math.hypot(a.pos.x - zoneTarget.x, a.pos.z - zoneTarget.z);
        const db = Math.hypot(b.pos.x - zoneTarget.x, b.pos.z - zoneTarget.z);
        return da - db || tieBreakHash(this.matchSeed, a.idx, a.runSerial, `corner:${pr.id}`)
          - tieBreakHash(this.matchSeed, b.idx, b.runSerial, `corner:${pr.id}`);
      })[0];
      return runner ? { target: runner.pos.clone(), player: runner } : { target: zoneTarget };
    }
    const candidates = mates.map((p) => {
      const target = p.pos.clone().addScaledVector(p.vel, 0.35);
      if (pr.kind === "throw_in") {
        target.x += sign * this.rng.range(1.8, 4.0);
        target.z += -Math.sign(pr.pos[1]) * this.rng.range(1.5, 4.5);
      } else if (pr.kind === "goal_kick") {
        target.x += sign * this.rng.range(3, 8);
        target.z += this.rng.range(-2.4, 2.4);
      } else {
        target.x += sign * this.rng.range(2.0, 4.4);
      }
      const nearest = Math.min(...this.players.filter((q) => q.team !== taker.team && q.role !== "GK").map((q) => q.pos.distanceTo(target)), 14);
      const score = THREE.MathUtils.clamp(nearest / 7, 0, 1) * 0.45
        + THREE.MathUtils.clamp((target.x - taker.pos.x) * sign / 18, 0, 0.35)
        + (1 - Math.min(1, target.distanceTo(taker.pos) / 24)) * 0.16
        + this.rng.range(0, 0.1) + p.style.creativity * 0.04;
      return { player: p, target, score };
    }).sort((a, b) => b.score - a.score);
    const pool = candidates.slice(0, Math.min(3, candidates.length));
    if (!pool.length) return { target: this.ai.goalPos(taker.team, this.rules.half) };
    const chosen = this.rng.weighted(pool.map((item, i) => ({ value: item, weight: Math.max(0.08, item.score) * (i === 0 ? 1.1 : 0.75) })));
    return { target: chosen.target, player: chosen.player };
  }

  private startAction(p: EnginePlayer, action: string, target?: THREE.Vector3, passTo?: number, actionSeed?: number, power?: number): boolean {
    if (!p.anim.requestAction(action)) return false;
    const seed = actionSeed ?? this.rng.nextUint();
    p.lastActionSeed = seed;
    p.pendingKick = target ? { action, target: target.clone(), passTo, actionSeed: seed, power } : null;
    this.lastActionSeed = seed;
    this.actionLog.push({ seed, t: this.clock, player: p.idx, action, target: target ? [target.x, target.y, target.z] : undefined });
    if (this.actionLog.length > 80) this.actionLog.shift();
    return true;
  }

  /** Real kick speed (m/s) for an action, scaled by the player's style. */
  private powerForAction(p: EnginePlayer, action: string): number | undefined {
    const kp = CONFIG.player.kickPower;
    switch (action) {
      // Style shifts power by at most ±~8%: a 25 m/s base stays within real 22–27 m/s shots
      // (style.shooting spans ~0.72–1.5; the old 0.85+0.3·s multiplier reached ~30 m/s).
      case "shoot_normal": return kp.shoot * (0.94 + 0.1 * THREE.MathUtils.clamp(p.style.shooting - 1, -0.4, 0.5));
      case "shoot_finesse": return kp.finesse * (0.95 + 0.08 * THREE.MathUtils.clamp(p.style.shooting - 1, -0.4, 0.5));
      case "shoot_volley": return kp.volley * (0.94 + 0.1 * THREE.MathUtils.clamp(p.style.shooting - 1, -0.4, 0.5));
      case "pass_long": return kp.longPass * (0.9 + 0.2 * p.style.directness);
      case "pass_through": return kp.through * (0.85 + 0.3 * p.style.directness);
      case "pass_short": return kp.pass * (0.9 + 0.25 * p.style.directness);
      default: return undefined;
    }
  }

  private receiverOffsideAtKick(passer: EnginePlayer, receiver: EnginePlayer, restartKind?: string): boolean {
    if (restartKind === "throw_in" || restartKind === "corner" || restartKind === "goal_kick" || restartKind === "kickoff") return false;
    if (!CONFIG.ai.offside || receiver.team !== passer.team || receiver.role === "GK") return false;
    const attack = this.ai.attackSign(passer.team, this.rules.half);
    const u = receiver.pos.x * attack;
    if (u <= 0) return false;
    const defenders = this.players.filter((p) => p.team !== passer.team)
      .map((p) => p.pos.x * attack).sort((a, b) => b - a);
    const secondLast = defenders[1] ?? -CONFIG.pitch.length / 2;
    return u > this.ball.pos.x * attack + CONFIG.ai.offsideBuffer
      && u > secondLast + CONFIG.ai.offsideBuffer;
  }

  /**
   * arrival = target ball speed (m/s) when it reaches the receiver. Real ground passes
   * arrive with pace; a pass planned to just reach the receiver dies at walking speed
   * and is trivially intercepted. Aerial deliveries (throw/corner/punt) use 0.
   */
  private passProfile(action: string): { loft: number; maxPower: number; minPower: number; arrival: number } | null {
    const kp = CONFIG.player.kickPower;
    switch (action) {
      case "pass_short": return { loft: 0.025, maxPower: kp.pass, minPower: 0.6, arrival: 5.0 };
      case "pass_long": return { loft: 0.06, maxPower: kp.longPass, minPower: 1.5, arrival: 6.5 };
      case "pass_through": return { loft: 0.035, maxPower: kp.through, minPower: 1.0, arrival: 4.0 };
      // Throw-ins and corners are lofted deliveries, not driven balls: high loft gives a
      // real arc into the danger area (a flat loft made corners look short/driven).
      case "throw_in": return { loft: 0.45, maxPower: kp.throwIn, minPower: 4, arrival: 0 };
      case "corner_kick": return { loft: 0.85, maxPower: kp.corner, minPower: 5, arrival: 0 };
      case "gk_roll": return { loft: 0.01, maxPower: kp.gkRoll, minPower: 1.5, arrival: 3.5 };
      case "gk_punt": return { loft: 0.42, maxPower: kp.punt, minPower: 8, arrival: 0 };
      default: return null;
    }
  }

  /** Physics-calibrated power so the ball still carries `arrival` m/s at `distance`. */
  private powerForArrival(distance: number, profile: { loft: number; maxPower: number; minPower: number; arrival: number }, startHeight: number): number {
    // Extra free-roll distance needed to shed `arrival` m/s under rolling resistance.
    const extraRoll = profile.arrival > 0 ? (profile.arrival * profile.arrival) / (2 * CONFIG.ball.rollingDecel) : 0;
    return kickPowerForRange(distance + extraRoll, profile.loft, profile.maxPower, profile.minPower, startHeight);
  }

  private planNamedPass(passer: EnginePlayer, action: string, passTo: number | undefined, requestedPower?: number, restartKind?: string): PassPlan | null {
    const receiver = resolveNamedReceiver(this.players, passer, passTo, action.startsWith("pass_"));
    const profile = this.passProfile(action);
    if (!receiver || !profile || this.receiverOffsideAtKick(passer, receiver, restartKind)) return null;

    const origin = this.ball.pos.clone();
    const assignment = !restartKind && this.frameWorld
      ? this.ai.tactics.plan(this.frameWorld, passer.team)?.assignments.get(receiver.idx) : undefined;
    const destination = restartKind ? receiver.pos.clone()
      : action === "pass_through" && assignment?.job === "runner" && assignment.runTarget ? assignment.runTarget.clone()
        : assignment?.target.clone() ?? receiver.moveTarget.clone();
    const startHeight = Math.max(CONFIG.ball.radius, origin.y);
    let receiverTarget = receiver.pos.clone();
    let distance = Math.hypot(receiverTarget.x - origin.x, receiverTarget.z - origin.z);
    if (distance < 1.15) return null;

    const maximumReach = kickRangeForPower(profile.maxPower, profile.loft, startHeight);
    if (distance > maximumReach - 0.35) return null;
    let power = this.powerForArrival(distance, profile, startHeight);
    if (requestedPower !== undefined) {
      // Charge changes pace a little but never overpowers the receiver's measured range.
      power = THREE.MathUtils.clamp(requestedPower, power * 0.82, Math.min(profile.maxPower, power * 1.08));
    }

    let arrivalTime = 0;
    for (let i = 0; i < 5; i++) {
      const travelTime = estimateKickTravelTime(distance, power, profile.loft, startHeight);
      arrivalTime = travelTime;
      const receiverCap = receiver.role === "GK" ? CONFIG.player.runSpeed
        : action === "pass_through" ? CONFIG.ai.maxSprint : assignment?.desiredSpeed ?? CONFIG.player.runSpeed;
      receiverTarget = predictReceiverRun(receiver.pos, receiver.vel, destination, travelTime, receiverCap);
      distance = Math.hypot(receiverTarget.x - origin.x, receiverTarget.z - origin.z);
      if (distance > maximumReach - 0.35) return null;
      const rangePower = this.powerForArrival(distance, profile, startHeight);
      power = requestedPower === undefined
        ? rangePower
        : THREE.MathUtils.clamp(requestedPower, rangePower * 0.82, Math.min(profile.maxPower, rangePower * 1.08));
    }

    const aim = receiverTarget.clone().sub(origin).setY(0).normalize();
    const plannedVelocity = new THREE.Vector3(aim.x * power, power * profile.loft, aim.z * power);
    const aimDot = passAimDot(origin, plannedVelocity, receiverTarget);
    if (!passAimIsValid(aimDot, CONFIG.ai.passAimConeDegrees)) return null;
    return { receiver, target: receiverTarget, power, loft: profile.loft, aimDot, distance, arrivalTime };
  }

  private recordPass(passer: EnginePlayer, action: string, plan: PassPlan) {
    const gain = (plan.target.x - passer.pos.x) * this.ai.attackSign(passer.team, this.rules.half);
    const purpose = this.ai.lastDecision.get(passer.idx)?.passPurpose
      ?? (gain < -1.5 ? "recycle" : action === "pass_through" ? "penetrate" : "progress");
    this.passFlight = { team: passer.team, passer: passer.idx, receiver: plan.receiver.idx, target: plan.target.clone(),
      launchedAt: this.clock, arrivesAt: this.clock + plan.arrivalTime, expiresAt: this.clock + plan.arrivalTime + 1.2 };
    this.lastPass = { passer: passer.idx, receiver: plan.receiver.idx, team: passer.team, t: this.clock };
    this.tacticalStats.passes++;
    if (purpose === "recycle") this.tacticalStats.recycles++;
    if (plan.receiver.role === "GK") this.tacticalStats.keeperRecycles++;
    if (purpose === "penetrate") this.tacticalStats.penetratingPasses++;
    this.ball.handsRestrictedTeam = action.startsWith("pass_") || action === "corner_kick" ? passer.team : null;
    this.passLog.unshift({
      t: this.clock, passer: passer.idx, receiver: plan.receiver.idx, action,
      speed: plan.power, aimDot: plan.aimDot, distance: plan.distance,
      predicted: [plan.target.x, plan.target.y, plan.target.z],
      purpose, arrivalTime: plan.arrivalTime,
    });
    if (this.passLog.length > 24) this.passLog.pop();
  }

  // ---------------- control ----------------
  private humanControl(p: EnginePlayer, dt: number, snap: WorldSnap) {
    const k = this.keys;
    let ix = 0, iz = 0;
    if (k.has("a") || k.has("arrowleft")) ix -= 1;
    if (k.has("d") || k.has("arrowright")) ix += 1;
    if (k.has("w") || k.has("arrowup")) iz -= 1;
    if (k.has("s") || k.has("arrowdown")) iz += 1;
    const has = ix !== 0 || iz !== 0;
    const sprint = k.has("shift");
    const spd = sprint ? CONFIG.player.sprintSpeed : has ? CONFIG.player.runSpeed : 0;
    if (has) {
      _v1.set(ix, 0, iz).normalize();
      p.moveTarget.copy(p.pos).addScaledVector(_v1, 3);
      p.desiredSpeed = spd;
      p.decisionReason = `Human move ${sprint ? "SPRINT" : "jog"}`;
    } else { p.moveTarget.copy(p.pos); p.desiredSpeed = 0; p.decisionReason = "Human hold"; }
    p.utilities = {};
    const hasBall = this.ball.possessedBy === p.idx;

    // charge pass/shoot
    if (k.has(" ") && !this.chargingPass) { this.chargingPass = true; this.passCharge = 0; }
    if (!k.has(" ") && this.chargingPass) {
      this.chargingPass = false;
      this.humanPass(p, snap, this.passCharge, k.has("q"));
      this.passCharge = 0;
    }
    if (this.chargingPass) this.passCharge = Math.min(1, this.passCharge + dt * 1.4);
    if (k.has("e") && !this.chargingShoot) { this.chargingShoot = true; this.shootCharge = 0; }
    if (!k.has("e") && this.chargingShoot) {
      this.chargingShoot = false;
      this.humanShoot(p, snap, this.shootCharge, k.has("q"));
      this.shootCharge = 0;
    }
    if (this.chargingShoot) this.shootCharge = Math.min(1, this.shootCharge + dt * 1.2);
    if (k.has("f")) {
      k.delete("f");
      if (!hasBall && !p.anim.busy) {
        const id = p.pos.distanceTo(this.ball.pos) > 1.6 ? "tackle_slide" : "tackle_stand";
        if (this.startAction(p, id, this.ball.pos.clone())) {
          p.decisionReason = `Human ${id}`;
        }
      } else if (hasBall && !p.anim.busy) {
        if (this.startAction(p, "shield")) p.decisionReason = "Human shield";
      }
    }
    void dt;
  }

  private bestPassTarget(p: EnginePlayer, dir: THREE.Vector3 | null, snap: WorldSnap): EnginePlayer | null {
    const mates = this.players.filter((q) => q.team === p.team && q.idx !== p.idx
      && !this.ai.isOffsidePosition(q.pos, this.ball.pos, p.team, snap));
    if (!mates.length) return null;
    if (this.aimRaw || !dir || dir.lengthSq() < 0.01) {
      // aide: best within cone of facing
      const fx = Math.cos(p.facing), fz = -Math.sin(p.facing);
      let best: EnginePlayer | null = null; let bs = -1;
      for (const m of mates) {
        _v1.copy(m.pos).sub(p.pos); const d = _v1.length(); _v1.normalize();
        const align = _v1.x * fx + _v1.z * fz;
        const nearestOpp = Math.min(...this.players.filter((q) => q.team !== p.team && q.role !== "GK").map((q) => q.pos.distanceTo(m.pos)), 10);
        const s = align * 0.4 + (1 - d / 30) * 0.25 + Math.min(1, nearestOpp / 6) * 0.25
          + tieBreakHash(this.matchSeed, p.idx, p.runSerial, `human-pass:${m.idx}`) * 0.1;
        if (s > bs) { bs = s; best = m; }
      }
      return best;
    }
    let best: EnginePlayer | null = null; let bs = -2;
    for (const m of mates) {
      _v1.copy(m.pos).sub(p.pos).normalize();
      const nearestOpp = Math.min(...this.players.filter((q) => q.team !== p.team && q.role !== "GK").map((q) => q.pos.distanceTo(m.pos)), 10);
      const s = _v1.dot(dir) * 0.72 + Math.min(1, nearestOpp / 7) * 0.18
        + tieBreakHash(this.matchSeed, p.idx, p.runSerial, `human-pass:${m.idx}`) * 0.1;
      if (s > bs) { bs = s; best = m; }
    }
    return bs > 0.3 ? best : null;
  }

  private humanPass(p: EnginePlayer, snap: WorldSnap, charge: number, through: boolean) {
    if (this.ball.possessedBy !== p.idx || p.anim.busy) return;
    let ix = 0, iz = 0;
    const k = this.keys;
    if (k.has("a") || k.has("arrowleft")) ix -= 1;
    if (k.has("d") || k.has("arrowright")) ix += 1;
    if (k.has("w") || k.has("arrowup")) iz -= 1;
    if (k.has("s") || k.has("arrowdown")) iz += 1;
    const dir = ix || iz ? new THREE.Vector3(ix, 0, iz).normalize() : null;
    const tgt = this.bestPassTarget(p, dir, snap);
    if (!tgt) {
      p.decisionReason = "PASS CANCELLED · no onside teammate in aim cone";
      return;
    }
    const id = through ? "pass_through" : charge > 0.55 ? "pass_long" : "pass_short";
    let target: THREE.Vector3;
    target = tgt.pos.clone();
    if (!through) target.addScaledVector(tgt.vel, 0.35);
    // Hold-to-charge: tap = short pass, held = driven long ball.
    const kp = CONFIG.player.kickPower;
    const power = through
      ? kp.through * (0.85 + 0.3 * charge)
      : THREE.MathUtils.lerp(kp.pass, kp.longPass, charge);
    if (this.startAction(p, id, target, tgt?.idx, undefined, power)) {
      p.decisionReason = `Human ${id} → ${tgt ? tgt.role : "space"} (power ${(charge * 100) | 0}%)`;
    }
    void snap;
  }

  private humanShoot(p: EnginePlayer, snap: WorldSnap, charge: number, finesse: boolean) {
    if (this.ball.possessedBy !== p.idx || p.anim.busy) return;
    const airborne = this.ball.pos.y > 0.35;
    const id = airborne ? "shoot_volley" : finesse ? "shoot_finesse" : "shoot_normal";
    const gx = this.ai.goalPos(p.team, this.rules.half).x;
    const aimOffset = this.keys.has("a") || this.keys.has("arrowleft") ? -0.65 : this.keys.has("d") || this.keys.has("arrowright") ? 0.65 : 0;
    const aimZ = THREE.MathUtils.clamp(aimOffset * (this.aimRaw ? 1.8 : 1), -1.2, 1.2);
    // Hold-to-charge: tap = placed strike, held = full-power laces.
    const kp = CONFIG.player.kickPower;
    const power = id === "shoot_volley"
      ? kp.volley * (0.8 + 0.35 * charge)
      : id === "shoot_finesse"
        ? kp.finesse * (0.9 + 0.2 * charge)
        : THREE.MathUtils.lerp(18, kp.shoot, charge);
    if (this.startAction(p, id, new THREE.Vector3(gx, 0, aimZ), undefined, undefined, power)) {
      p.decisionReason = `Human ${id} power ${(charge * 100) | 0}%`;
    }
    void snap;
  }

  private aiControl(p: EnginePlayer, dt: number, snap: WorldSnap, live: boolean, frozen: boolean) {
    const tr = this.debugAI ? this.aiTrace.get(p.idx) : undefined;
    // Stumble decays for everyone (it previously only decayed on the AI path).
    if (p.stumbleT > 0) p.stumbleT = Math.max(0, p.stumbleT - dt);
    if (frozen) {
      p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
      if (tr) { tr.branch = "frozen"; tr.overwrittenBy = `phase:${this.rules.phase}`; }
      return;
    }
    if (!live) { if (tr) tr.branch = "notLive"; return; }
    if (p.role === "GK" && this.ball.possessedBy === p.idx) {
      p.holdT += dt;
      p.moveTarget.copy(p.pos); p.desiredSpeed = 0;
      if (p.holdT < (this.ball.handsRestrictedTeam === p.team ? 0.35 : 1.25)) {
        p.decisionReason = "GK hold · choosing distribution";
        if (tr) tr.branch = "gkHold";
        return;
      }
    } else p.holdT = 0;
    if (tr) tr.branch = "ai";
    const wp: WorldPlayer = {
      idx: p.idx, team: p.team, role: p.role, roleIdx: p.roleIdx, pos: p.pos, vel: p.vel, facing: p.facing,
      speed: p.speed, busy: p.anim.busy, uninterruptible: p.anim.uninterruptible,
      cooldowns: p.anim.cooldowns, stamina: p.stamina,
      hasBall: this.ball.possessedBy === p.idx, callForBall: p.callForBall, isHuman: p.isHuman,
      runSerial: p.runSerial, style: p.style,
      moveTarget: p.moveTarget, desiredSpeed: p.desiredSpeed, pendingPassTo: p.pendingKick?.passTo,
    };
    const dec = this.ai.think(wp, p.roleIdx, snap, this.clock);
    // think() returns its cached object between re-evaluations; identity tells fresh from cached.
    const fresh = this.lastAppliedDecision.get(p.idx) !== dec;
    if (tr) { tr.thinkCalled = true; tr.thinkFresh = fresh; tr.actionReturned = dec.action; }
    p.callForBall = wp.callForBall;
    if (p.moveTarget.distanceTo(dec.moveTarget) > 2.4) p.runSerial++;
    p.moveTarget.copy(dec.moveTarget);
    p.desiredSpeed = Math.min(dec.desiredSpeed, p.role === "GK" ? CONFIG.player.gkSprintSpeed : CONFIG.ai.maxSprint);
    p.decisionReason = dec.reason; p.utilities = dec.utilities;
    p.supportJob = dec.supportJob; p.supportRun = dec.runType; p.supportMode = dec.supportMode; p.passOptions = dec.passOptions;
    if (dec.supportJob === "runner" && this.ball.possessedBy !== null && this.ball.ownerTeam === p.team) {
      const sign = this.ai.attackSign(p.team, this.rules.half);
      const room = onsideLimit(snap, p.team) - CONFIG.ai.offsideBuffer - p.pos.x * sign;
      if (p.moveTarget.x * sign > p.pos.x * sign && room < 2) {
        p.desiredSpeed = Math.min(p.desiredSpeed, Math.sqrt(Math.max(0, 2 * CONFIG.player.decel * room)));
      }
    }

    if (dec.action) {
      // Actions fire once per fresh decision. Re-firing a cached decision replayed stale
      // passes/shots at stale targets every frame after the previous clip finished.
      if (!fresh) {
        if (tr) tr.startActionResult = "skipped:cached-decision";
      } else if (p.anim.busy && p.anim.uninterruptible) {
        if (tr) tr.startActionResult = `skipped:locked(${p.anim.actionId})`;
        this.ai.nextThink.set(p.idx, 0); // re-decide as soon as the lock clears
      } else {
        const actionTarget = dec.action === "dribble_touch" ? undefined : (dec.actionTarget ?? dec.moveTarget).clone();
        const ok = this.startAction(p, dec.action, actionTarget, dec.passTo, dec.actionSeed, this.powerForAction(p, dec.action));
        if (ok) { p.holdT = 0; this.lastAppliedDecision.set(p.idx, dec); this.ai.commitDecision(p.idx, dec); }
        else this.ai.nextThink.set(p.idx, 0); // rejected (cooldown/priority): re-decide next frame
        if (tr) tr.startActionResult = ok ? `ok:${dec.action}` : `rejected:${dec.action}(cooldown ${(p.anim.cooldowns.get(dec.action) ?? 0).toFixed(2)}s)`;
      }
    } else {
      this.lastAppliedDecision.set(p.idx, dec);
    }
    if (p.stumbleT > 0) {
      p.desiredSpeed *= 0.3;
      if (tr) tr.overwrittenBy = `stumble(${p.stumbleT.toFixed(2)}s)`;
    }
  }

  // ---------------- ball truth ----------------
  private footWorld(p: EnginePlayer, which = "R"): THREE.Vector3 {
    const b = p.rig.skeleton.bones.get(which === "head" ? "head" : which === "hands" ? "hand.R" : `foot.${which}`);
    const v = new THREE.Vector3();
    if (b) b.getWorldPosition(v);
    return v;
  }

  private onContact(p: EnginePlayer, action: string) {
    const pk = p.pendingKick;
    const activeRestart = this.rules.pendingRestart;
    let ballReleasedByAction = false;
    this.contactTotal++;
    const foot = this.footWorld(p, action === "header" ? "head" : action === "throw_in" || action.startsWith("gk_") ? "hands" : "R");
    const dist = foot.distanceTo(this.ball.pos);
    const tol = action === "header" ? 0.55 : action.startsWith("gk_") ? 0.8 : 0.42;
    if (dist < tol) this.contactAligned++;
    // IK snap pass: nudge foot toward ball predicted pos
    p.anim.ballContactSnap(this.ball.pos, foot);

    const ownerIsMe = this.ball.possessedBy === p.idx;
    const dirTo = (t: THREE.Vector3) => t.clone().sub(p.pos).setY(0).normalize();

    if (this.offsideTeam === p.team && this.offsideCandidates.has(p.idx)
      && ["first_touch", "intercept", "header", "shoot_volley"].includes(action) && this.flagOffside(p)) {
      p.pendingKick = null;
      return;
    }

    const kp = CONFIG.player.kickPower;
    switch (action) {
      case "pass_short": case "pass_long": case "pass_through": {
        if (pk?.action !== action) { p.pendingKick = null; break; }
        if (!ownerIsMe) break;
        const plan = this.planNamedPass(p, action, pk?.passTo, pk?.power, activeRestart?.kind);
        if (!plan) {
          p.decisionReason = "PASS CANCELLED · no valid same-team onside receiver in range";
          this.rules.emit("POSSESSION", `${action} cancelled: no valid named receiver`, p.team);
          break;
        }
        this.captureOffsideAtKick(p, activeRestart?.kind);
        this.ball.release();
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        this.ball.kick(plan.target.clone().sub(this.ball.pos).setY(0).normalize(), plan.power, plan.loft);
        const launchDot = passAimDot(this.ball.pos, this.ball.vel, plan.target);
        if (!passAimIsValid(launchDot, CONFIG.ai.passAimConeDegrees)) {
          this.ball.vel.set(0, 0, 0); this.ball.possess(p.idx, p.team);
          p.decisionReason = "PASS CANCELLED · launch outside receiver cone";
          break;
        }
        ballReleasedByAction = true;
        this.recordPass(p, action, { ...plan, aimDot: launchDot });
        if (!activeRestart) this.openPlayKickCount++;
        this.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${action} → #${plan.receiver.idx} ${plan.receiver.role}`, p.team);
        if (p.isHuman && !this.spectator) this.setHumanPlayer(plan.receiver);
        break;
      }
      case "shoot_normal": case "shoot_finesse": case "shoot_volley": {
        if (!ownerIsMe && !(action === "shoot_volley" && this.ball.possessedBy === null && p.pos.distanceTo(this.ball.pos) < 1.4)) break;
        const tgt = pk?.target ?? this.ai.goalPos(p.team, this.rules.half);
        const power = pk?.power ?? (action === "shoot_normal" ? kp.shoot : action === "shoot_finesse" ? kp.finesse : kp.volley);
        this.captureOffsideAtKick(p, activeRestart?.kind);
        this.ball.release();
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        const spin = action === "shoot_finesse" ? p.style.finesseSide : 0;
        this.ball.kick(dirTo(tgt), power, action === "shoot_volley" ? 0.25 : 0.14, spin);
        this.tacticalStats.shots++;
        ballReleasedByAction = true;
        if (!activeRestart) this.openPlayKickCount++;
        this.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} SHOOT (${action})`, p.team);
        break;
      }
      case "header": {
        if (p.pos.distanceTo(this.ball.pos) > 1.6) break;
        const tgt = pk?.target ?? this.ai.goalPos(p.team, this.rules.half);
        this.captureOffsideAtKick(p, activeRestart?.kind);
        this.ball.release();
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        this.ball.kick(dirTo(tgt), kp.header, 0.2);
        ballReleasedByAction = true;
        break;
      }
      case "tackle_stand": case "tackle_slide": {
        const carrierIdx = this.ball.possessedBy;
        const carrier = carrierIdx !== null ? this.players[carrierIdx] : null;
        // A tackle wins the BALL, not the man: success requires the ball (glued ~0.48 m in
        // front of the carrier) inside the tackler's foot reach at the contact frame.
        // Lunge root motion has already closed ~1 m by contact. Tackling from behind or the
        // blind side reaches the carrier's body but not the ball → contact, no win.
        const footReach = action === "tackle_slide" ? 1.55 : 1.15;
        const maxReach = CONFIG.player.tackleRadius + (action === "tackle_slide" ? 0.9 : 0.75);
        const ballDist = Math.hypot(this.ball.pos.x - p.pos.x, this.ball.pos.z - p.pos.z);
        const villainClose = !!carrier && carrier.team !== p.team && ballDist < footReach;
        const ballClose = ballDist < footReach + 0.2;
        if (carrier && villainClose) {
          // Clean tackle win: tackler claims the ball and stumbles the carrier
          this.ball.possess(p.idx, p.team);
          this.ball.vel.set(0, 0, 0);
          this.offsideCandidates.clear(); this.offsideTeam = null;
          this.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} wins tackle (${action})`, p.team);
          carrier.stumbleT = 0.75;
          this.startAction(carrier, "stumble");
          if (p.team === this.humanTeam && !this.spectator) this.setHumanPlayer(p);
        } else if (carrier && carrier.team !== p.team && carrier.pos.distanceTo(p.pos) < maxReach + 0.45) {
          // Heavy contact with no ball access
          carrier.stumbleT = 0.8;
          this.startAction(carrier, "stumble");
          if (this.foulsOn) {
            const ownGoal = this.ai.ownGoal(carrier.team, this.rules.half);
            const inBox = Math.abs(carrier.pos.x - ownGoal.x) < 5.5 && Math.abs(carrier.pos.z) < 6.2;
            this.rules.emit("FOUL", `Foul by ${p.team === 0 ? "RED" : "BLUE"} ${action} @ (${carrier.pos.x.toFixed(1)},${carrier.pos.z.toFixed(1)})`, p.team);
            this.ball.pos.set(carrier.pos.x, CONFIG.ball.radius, carrier.pos.z);
            this.ball.vel.set(0, 0, 0); this.ball.release();
            this.rules.startSetup(inBox ? "penalty" : "free_kick", [carrier.pos.x, carrier.pos.z], carrier.team);
          } else {
            this.rules.emit("FOUL", `Heavy contact (hook off) — play on`, p.team);
          }
          if (action === "tackle_slide") this.startAction(p, "get_up");
        } else if (this.ball.possessedBy === null && ballClose) {
          // Poke/claim loose ball
          this.ball.possess(p.idx, p.team);
          this.ball.vel.set(0, 0, 0);
          this.offsideCandidates.clear(); this.offsideTeam = null;
          this.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} claims loose ball (${action})`, p.team);
          if (p.team === this.humanTeam && !this.spectator) this.setHumanPlayer(p);
        }
        break;
      }
      case "intercept": case "first_touch": case "dribble_touch": {
        if (this.ball.possessedBy === null && p.pos.distanceTo(this.ball.pos) < CONFIG.player.interceptRadius + 0.5) {
          this.ball.possess(p.idx, p.team);
          this.offsideCandidates.clear(); this.offsideTeam = null;
          this.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${action} takes ball`, p.team);
          if (p.team === this.humanTeam && !this.spectator) this.setHumanPlayer(p);
        }
        break;
      }
      case "gk_catch": case "gk_parry": case "gk_dive_L": case "gk_dive_R": {
        if (this.ball.possessedBy !== null) break;
        if (this.ball.handsRestrictedTeam === p.team) break;
        const diving = action === "gk_dive_L" || action === "gk_dive_R";
        // Hand reach at the contact frame. A dive's root motion has already displaced the
        // body, so its residual reach is the outstretched arm plus fingertips.
        // A keeper still moving across goal when the save fires is off-balance and loses reach
        // — unless the clip is a dive in that same direction (momentum then helps, not hurts).
        const lateralSpeed = Math.abs(p.vel.z);
        const movingWithDive = diving && Math.sign(p.vel.z) === Math.sign(this.ball.pos.z - p.pos.z);
        const offBalance = movingWithDive ? 0 : lateralSpeed * CONFIG.ai.gkOffBalancePenalty;
        const reach = Math.max(0.5, (diving ? CONFIG.ai.gkStandingReach + 0.8 : CONFIG.ai.gkStandingReach + 0.3) - offBalance);
        // Closest approach of the ball path over the contact window (it may still be arriving).
        let best = Infinity, bestH = this.ball.pos.y;
        for (let s = 0; s <= 6; s++) {
          const t = s * 0.025;
          const bx = this.ball.pos.x + this.ball.vel.x * t, bz = this.ball.pos.z + this.ball.vel.z * t;
          const by = this.ball.pos.y + this.ball.vel.y * t - 0.5 * CONFIG.ball.gravity * t * t;
          const dist = Math.hypot(bx - p.pos.x, bz - p.pos.z);
          if (dist < best) { best = dist; bestH = by; }
        }
        const inHeight = bestH < 2.35 && bestH > 0;
        if (best > reach || !inHeight) {
          this.aiEvent(`GK ${action} MISSED · ${best.toFixed(2)}m vs reach ${reach.toFixed(2)}m, h ${bestH.toFixed(2)}`);
          break;
        }
        const speed = this.ball.speed;
        // Catch only clean, central, not-too-hot balls; otherwise the save is a parry.
        if (action === "gk_catch" && speed < CONFIG.ai.gkCatchSpeed && best < CONFIG.ai.gkStandingReach + 0.15) {
          this.ball.possess(p.idx, p.team);
          this.ball.vel.set(0, 0, 0);
          this.offsideCandidates.clear(); this.offsideTeam = null;
          p.holdT = 0;
          this.aiEvent(`GK CATCH #${p.idx} · ${speed.toFixed(1)} m/s at ${best.toFixed(2)}m`);
          this.rules.emit("SAVE", `GK CATCH by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
          break;
        }
        // Parry: deflect wide of goal, keeping some of the shot's energy.
        const ownGoal = this.ai.ownGoal(p.team, this.rules.half);
        const away = this.ball.pos.clone().sub(ownGoal).setY(0).normalize();
        away.z += (this.ball.pos.z >= p.pos.z ? 1 : -1) * 0.7;
        this.ball.release();
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        this.ball.kick(away.normalize(), THREE.MathUtils.clamp(speed * 0.4, 5, 12), 0.3);
        this.offsideCandidates.clear(); this.offsideTeam = null;
        this.aiEvent(`GK PARRY #${p.idx} (${action}) · ${speed.toFixed(1)} m/s at ${best.toFixed(2)}m`);
        this.rules.emit("SAVE", `GK ${action} — parried!`, p.team);
        break;
      }
      case "gk_punt": {
        if (pk?.action !== action) { p.pendingKick = null; break; }
        if (!ownerIsMe) break;
        const plan = this.planNamedPass(p, action, pk?.passTo, pk?.power, activeRestart?.kind);
        if (!plan) {
          p.decisionReason = "GK PUNT CANCELLED · no valid named teammate";
          break;
        }
        this.ball.release();
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        this.ball.kick(plan.target.clone().sub(this.ball.pos).setY(0).normalize(), plan.power, plan.loft);
        ballReleasedByAction = true;
        this.recordPass(p, action, plan);
        if (!activeRestart) this.openPlayKickCount++;
        break;
      }
      case "gk_roll": {
        if (pk?.action !== action) { p.pendingKick = null; break; }
        if (!ownerIsMe) break;
        const plan = this.planNamedPass(p, action, pk?.passTo, pk?.power, activeRestart?.kind);
        if (!plan) { p.decisionReason = "GK ROLL CANCELLED · no valid named teammate"; break; }
        this.ball.release();
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        this.ball.kick(plan.target.clone().sub(this.ball.pos).setY(0).normalize(), plan.power, plan.loft);
        ballReleasedByAction = true;
        this.recordPass(p, action, plan);
        if (!activeRestart) this.openPlayKickCount++;
        break;
      }
      case "corner_kick": {
        if (pk?.action !== action) { p.pendingKick = null; break; }
        if (!ownerIsMe) break;
        const plan = this.planNamedPass(p, action, pk?.passTo, pk?.power, activeRestart?.kind);
        if (!plan) { p.decisionReason = "CORNER CANCELLED · no valid named runner"; break; }
        this.ball.release();
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        this.ball.kick(plan.target.clone().sub(this.ball.pos).setY(0).normalize(), plan.power, plan.loft, p.style.finesseSide);
        ballReleasedByAction = true;
        this.recordPass(p, action, plan);
        if (!activeRestart) this.openPlayKickCount++;
        break;
      }
      case "throw_in": {
        if (pk?.action !== action) { p.pendingKick = null; break; }
        // Only the restart taker may release the ball — prevents a stray
        // throw_in animation from ejecting a ball another player owns.
        if (!ownerIsMe && !p.restartTaker) break;
        const plan = this.planNamedPass(p, action, pk?.passTo, pk?.power, activeRestart?.kind);
        if (!plan) { p.decisionReason = "THROW CANCELLED · no valid named teammate"; break; }
        this.ball.release();
        this.ball.pos.set(p.pos.x, 1.65, p.pos.z);
        this.ball.lastTouch = p.idx; this.ball.lastTouchTeam = p.team;
        const throwAim = plan.target.clone().sub(this.ball.pos).setY(0).normalize();
        const throwDot = passAimDot(this.ball.pos, throwAim.clone().multiplyScalar(plan.power), plan.target);
        if (!passAimIsValid(throwDot, CONFIG.ai.passAimConeDegrees)) {
          this.ball.pos.set(p.pos.x, CONFIG.ball.radius, p.pos.z);
          this.ball.vel.set(0, 0, 0);
          p.decisionReason = "THROW CANCELLED · aim outside receiver cone";
          break;
        }
        this.ball.kick(throwAim, plan.power, plan.loft);
        ballReleasedByAction = true;
        this.recordPass(p, action, plan);
        if (!activeRestart) this.openPlayKickCount++;
        break;
      }
    }
    if (ballReleasedByAction) {
      this.aiEvent(`KICK released by #${p.idx} ${p.role} · ${action} · ${this.ball.speed.toFixed(1)} m/s${pk?.passTo !== undefined ? ` → #${pk.passTo}` : ""}`);
    } else if (pk && pk.action === action && (action === "tackle_stand" || action === "tackle_slide")) {
      const won = this.ball.possessedBy === p.idx;
      this.aiEvent(`TACKLE ${won ? "WON" : "MISSED"} #${p.idx} · ${action}`);
    } else if (pk && pk.action === action && (action === "intercept" || action === "first_touch" || action === "header" || action.startsWith("gk_"))) {
      const won = this.ball.possessedBy === p.idx;
      this.aiEvent(`${action.toUpperCase()} ${won ? "WON" : "MISSED"} #${p.idx}`);
    } else if (pk && pk.action === action) {
      this.aiEvent(`KICK CANCELLED #${p.idx} · ${action} · ${p.decisionReason}`);
      this.ai.nextThink.set(p.idx, 0); // carrier re-decides immediately instead of stalling
    }
    if (p.restartTaker && activeRestart && this.restartStartedId === activeRestart.id) {
      if (ballReleasedByAction) {
        this.restartLaunchedId = activeRestart.id;
        this.rules.pendingRestart = null;
        p.restartTaker = false;
      } else if (++this.restartRetries >= 3) {
        // No valid receiver after 3 samples: give the taker the ball in play.
        this.restartLaunchedId = activeRestart.id;
        this.rules.pendingRestart = null;
        p.restartTaker = false;
        const inX = THREE.MathUtils.clamp(p.pos.x, -CONFIG.pitch.length / 2 + 1, CONFIG.pitch.length / 2 - 1);
        const inZ = THREE.MathUtils.clamp(p.pos.z, -CONFIG.pitch.width / 2 + 1, CONFIG.pitch.width / 2 - 1);
        p.pos.set(inX, 0, inZ);
        this.ball.pos.set(inX, CONFIG.ball.radius, inZ);
        this.ball.possess(p.idx, p.team);
        this.aiEvent(`RESTART released to taker #${p.idx} after ${this.restartRetries} failed deliveries`);
      } else {
        // Restart delivery cancelled: retake promptly with a newly sampled target.
        this.restartStartedId = -1;
        this.restartAutoT = 0.2;
      }
    }
    p.pendingKick = null;
  }

  private captureOffsideAtKick(passer: EnginePlayer, restartKind?: string) {
    const exempt = restartKind === "throw_in" || restartKind === "corner"
      || restartKind === "goal_kick" || restartKind === "kickoff";
    this.offsideCandidates.clear();
    this.offsideTeam = null;
    if (!CONFIG.ai.offside || exempt) return;
    const attack = this.ai.attackSign(passer.team, this.rules.half);
    const secondLast = this.players.filter((p) => p.team !== passer.team)
      .map((p) => p.pos.x * attack).sort((a, b) => b - a)[1] ?? -CONFIG.pitch.length / 2;
    const ballU = this.ball.pos.x * attack;
    for (const player of this.players) {
      if (player.team !== passer.team || player.idx === passer.idx || player.role === "GK") continue;
      const u = player.pos.x * attack;
      if (u > 0 && u > ballU + CONFIG.ai.offsideBuffer && u > secondLast + CONFIG.ai.offsideBuffer) {
        this.offsideCandidates.add(player.idx);
      }
    }
    if (this.offsideCandidates.size > 0) this.offsideTeam = passer.team;
  }

  private flagOffside(receiver: EnginePlayer): boolean {
    if (!CONFIG.ai.offside || this.offsideTeam !== receiver.team || !this.offsideCandidates.has(receiver.idx)) return false;
    const spot: [number, number] = [this.ball.pos.x, this.ball.pos.z];
    this.rules.emit("OFFSIDE", `${receiver.team === 0 ? "RED" : "BLUE"} ${receiver.role} #${receiver.idx} involved from offside position`, receiver.team);
    this.offsideCandidates.clear(); this.offsideTeam = null;
    this.ball.release();
    this.ball.vel.set(0, 0, 0);
    this.rules.startSetup("free_kick", spot, 1 - receiver.team);
    return true;
  }

  private setHumanPlayer(p: EnginePlayer) {
    if (p.team !== this.humanTeam || p.role === "GK") return;
    const current = this.players[this.humanIdx];
    if (current && current.idx !== p.idx) current.isHuman = false;
    this.humanIdx = p.idx;
    p.isHuman = true;
    this.selectedIdx = p.idx;
  }

  /**
   * Central possession clock. A change of owner starts the carrier's "time on the
   * ball" timer; a change of *team* opens an attacking-transition window, which the
   * tactics layer reads to allow riskier, forward-first decisions.
   */
  private trackPossession() {
    const idx = this.ball.possessedBy;
    const team = this.ball.ownerTeam;
    if (idx !== this.seenOwner) {
      this.possessionStartedAt = this.clock;
      if (team !== null && this.seenOwnerTeam !== null && team !== this.seenOwnerTeam) {
        this.transitionTeam = team;
        this.transitionUntil = this.clock + CONFIG.tactics.transitionSeconds;
      }
      this.seenOwner = idx;
      this.seenOwnerTeam = team;
      if (this.possessionTicks.length > 400) this.possessionTicks.shift();
      if (idx !== null && team !== null) this.possessionTicks.push({ idx, team });
    }
  }

  private possessionCheck() {
    if (this.ball.possessedBy !== null) {
      const o = this.players[this.ball.possessedBy];
      // Auto-switch only on a possession change; a manual [X] switch stays under the user's control.
      if (o.idx !== this.lastKnownOwnerIdx) {
        if (!this.spectator && o.team === this.humanTeam) this.setHumanPlayer(o);
        else if (!this.spectator && this.lastKnownOwnerTeam === this.humanTeam) this.switchToNearest(false);
      }
      this.lastKnownOwnerTeam = o.team;
      this.lastKnownOwnerIdx = o.idx;
      if (o.speed > 5.5 && !o.anim.busy && this.rng.next() < 0.025 * o.style.carry) this.startAction(o, "dribble_touch");
      return;
    }

    // Free ball reception / trapping: check all active players
    for (const p of this.players) {
      if (p.stumbleT > 0) continue; // recovering from tackle, cannot trap
      // The striker cannot instantly re-trap their own kick: at release the ball is still
      // inside their control radius, which previously turned every pass into a self-retrap.
      if (p.idx === this.ball.kickedBy && this.ball.kickAge < 0.45) continue;
      const d = p.pos.distanceTo(this.ball.pos);
      const isGK = p.role === "GK";
      const ownGoal = this.ai.ownGoal(p.team, this.rules.half);
      const inPenaltyBox = Math.abs(p.pos.x - ownGoal.x) < 5.8 && Math.abs(p.pos.z) < 6.2;

      // GK catch in penalty box:
      // Automatic claim is for soft/loose balls only; shots go through the save model.
      if (isGK && inPenaltyBox && this.ball.handsRestrictedTeam !== p.team && d < CONFIG.ai.catchRadius + 0.6 && this.ball.pos.y < 1.95 && this.ball.speed < 9) {
        this.ball.possess(p.idx, p.team);
        this.ball.vel.set(0, 0, 0);
        this.startAction(p, "gk_catch");
        this.rules.emit("SAVE", `GK CATCH by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
        return;
      }

      // Ground / low ball reception (< 0.75 m height): cushion and take possession — but
      // only at a controllable pace. A footballer can kill a firm pass (~14 m/s); a 25 m/s
      // drive cannot be "trapped" (it deflects off the body instead). Keepers in their own
      // box never use this path: shots must go through the save model.
      const trapRadius = CONFIG.player.controlRadius + 0.3; // ~1.05m
      const controllable = this.ball.speed <= CONFIG.player.maxTrapSpeed;
      if (d < trapRadius && this.ball.pos.y < 0.75 && controllable && (!(isGK && inPenaltyBox) || this.ball.handsRestrictedTeam === p.team)) {
        if (this.flagOffside(p)) return;
        this.ball.possess(p.idx, p.team);
        this.ball.vel.set(0, 0, 0);
        this.startAction(p, "first_touch");
        if (isGK) this.tacticalStats.keeperFootControls++;
        this.aiEvent(`POSSESSION granted → #${p.idx} ${p.role} (trap at ${d.toFixed(2)}m)`);
        this.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${p.role} #${p.idx} controls ball`, p.team);
        if (p.team === this.humanTeam && !this.spectator) this.setHumanPlayer(p);
        return;
      }

      // Aerial ball cushion / header:
      if (d < 1.35 && this.ball.pos.y >= 0.75 && this.ball.pos.y < 2.3 && !p.anim.busy && !isGK && this.ball.speed < 22) {
        if (this.flagOffside(p)) return;
        const target = this.ai.goalPos(p.team, this.rules.half);
        target.z = THREE.MathUtils.clamp(this.ball.pos.z * 0.5, -1.1, 1.1);
        this.startAction(p, "header", target);
        return;
      }
    }
  }

  private outGoalCheck() {
    const L = CONFIG.pitch.length / 2, Wd = CONFIG.pitch.width / 2;
    const GW = CONFIG.pitch.goalWidth / 2, GH = CONFIG.pitch.goalHeight;
    const R = CONFIG.ball.radius;
    const b = this.ball.pos;
    // The whole ball must cross the line, stay inside the net volume, fit between posts and under the bar.
    if (Math.abs(b.z) + R < GW && b.y + R < GH) {
      if (b.x > L + R && b.x < L + CONFIG.pitch.goalDepth + 0.4) {
        this.rules.goal(this.ai.attackSign(0, this.rules.half) > 0 ? 0 : 1); this.onGoalReset(); return;
      }
      if (b.x < -L - R && b.x > -L - CONFIG.pitch.goalDepth - 0.4) {
        this.rules.goal(this.ai.attackSign(0, this.rules.half) < 0 ? 0 : 1); this.onGoalReset(); return;
      }
    }
    if (b.x > L + R || b.x < -L - R) {
      const side = b.x > 0 ? 1 : -1;
      const lastT = this.ball.lastTouchTeam ?? 0;
      const attacker = this.ai.attackSign(0, this.rules.half) === side ? 0 : 1;
      const defender = 1 - attacker;
      if (lastT === attacker) {
        const gx = side * (L - 2.0);
        this.outRestartCount++;
        this.rules.startSetup("goal_kick", [gx, 0], defender);
      } else {
        const cx = side * (L - 0.25);
        const cz = (b.z >= 0 ? 1 : -1) * (Wd - 0.25);
        this.outRestartCount++;
        this.rules.startSetup("corner", [cx, cz], attacker);
      }
      this.ball.release(); this.ball.vel.set(0, 0, 0);
      this.offsideCandidates.clear(); this.offsideTeam = null;
      return;
    }
    if (Math.abs(b.z) > Wd + R) {
      const lastT = this.ball.lastTouchTeam ?? 0;
      const team = 1 - lastT;
      const cx = THREE.MathUtils.clamp(b.x, -L + 0.25, L - 0.25);
      const cz = (b.z > 0 ? 1 : -1) * (Wd - 0.25);
      this.outRestartCount++;
      this.rules.startSetup("throw_in", [cx, cz], team);
      this.ball.release(); this.ball.vel.set(0, 0, 0);
      this.offsideCandidates.clear(); this.offsideTeam = null;
    }
  }

  private onGoalReset() {
    // ball stays in net during celebration; reset at kickoff setup (handled by rules GOAL→SETUP)
    for (const p of this.players) p.pendingKick = null;
    this.offsideCandidates.clear(); this.offsideTeam = null;
  }

  // ---------------- cameras ----------------
  private updateCamera(dt: number) {
    const b = this.ball.pos;
    if (this.cameraMode === "broadcast") {
      _v1.set(b.x * 0.72, 17.5, 22.5);
      _v1.x = THREE.MathUtils.clamp(_v1.x, -14, 14);
      this.camPos.lerp(_v1, Math.min(1, dt * 2.2));
      this.camLook.lerp(_v2.set(b.x * 0.85, 0, b.z * 0.6), Math.min(1, dt * 3));
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camLook);
    } else if (this.cameraMode === "follow") {
      const h = this.players[this.humanIdx];
      const bx = h.pos.x - Math.cos(h.facing) * 7, bz = h.pos.z + Math.sin(h.facing) * 7;
      _v1.set(bx, 5.2, bz);
      this.camPos.lerp(_v1, Math.min(1, dt * 3.5));
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(b.x, 0.8, b.z);
      this.camLook.set(b.x, 0.8, b.z);
    } else {
      // free debug cam: orbit ball with keys I/J/K/L + U/O zoom, drag via arrows fallback
      if (this.keys.has("j")) this.freeYaw += dt * 1.4;
      if (this.keys.has("l")) this.freeYaw -= dt * 1.4;
      if (this.keys.has("i")) this.freePitch = THREE.MathUtils.clamp(this.freePitch + dt, 0.15, 1.4);
      if (this.keys.has("k")) this.freePitch = THREE.MathUtils.clamp(this.freePitch - dt, 0.15, 1.4);
      if (this.keys.has("u")) this.freeDist = THREE.MathUtils.clamp(this.freeDist - dt * 12, 8, 60);
      if (this.keys.has("o")) this.freeDist = THREE.MathUtils.clamp(this.freeDist + dt * 12, 8, 60);
      const cx = b.x + Math.cos(this.freeYaw) * Math.cos(this.freePitch) * this.freeDist;
      const cz = b.z + Math.sin(this.freeYaw) * Math.cos(this.freePitch) * this.freeDist;
      const cy = Math.sin(this.freePitch) * this.freeDist;
      this.camera.position.set(cx, cy, cz);
      this.camera.lookAt(b.x, 0.5, b.z);
    }
  }

  private updateAIDebug() {
    this.aiLines.visible = this.showAIDebug;
    if (!this.showAIDebug) return;
    const arr = this.aiLinePos.array as Float32Array;
    this.players.forEach((p, i) => {
      arr[i * 6] = p.pos.x; arr[i * 6 + 1] = 0.3; arr[i * 6 + 2] = p.pos.z;
      arr[i * 6 + 3] = p.moveTarget.x; arr[i * 6 + 4] = 0.3; arr[i * 6 + 5] = p.moveTarget.z;
    });
    this.aiLinePos.needsUpdate = true;
  }

  // ---------------- snapshots for React HUD ----------------
  snapshot() {
    const sel = this.players[this.selectedIdx] ?? this.players[this.humanIdx];
    return {
      score: [...this.rules.score], clock: this.rules.clock, elapsedClock: this.rules.elapsedClock,
      half: this.rules.half, halfLabel: this.rules.halfLabel,
      phase: this.rules.phase, setupT: this.rules.setupT,
      restartKind: this.rules.pendingRestart?.kind ?? null,
      restartTeam: this.rules.pendingRestart?.team ?? null,
      restartWait: this.restartWaitReason,
      initialKickoffTeam: this.rules.initialKickoffTeam,
      homeTeam: "Harbor City", awayTeam: "Redwood Rangers",
      possession: this.ball.ownerTeam === 0 ? "RED" : this.ball.ownerTeam === 1 ? "BLUE" : "—",
      ballSpeed: this.ball.speed,
      fps: this.fps, cameraMode: this.cameraMode, spectator: this.spectator,
      humanIdx: this.humanIdx, humanRole: this.players[this.humanIdx]?.role,
      anim: sel.anim.debug(sel.speed),
      selIdx: sel.idx, selTeam: sel.team, selRole: sel.role,
      decisions: this.players.map((p) => ({ idx: p.idx, team: p.team, role: p.role, reason: p.decisionReason, utils: p.utilities, x: p.pos.x, z: p.pos.z,
        human: !this.spectator && p.idx === this.humanIdx, job: p.supportJob, mode: p.supportMode,
        target: [p.moveTarget.x, p.moveTarget.z], passOptions: p.passOptions })),
      tacticalStats: { ...this.tacticalStats },
      attackPlans: [0, 1].map((team) => {
        const plan = this.ai.tactics.current(team);
        return plan ? { team, carrier: plan.carrier, phase: plan.phase, offsideLine: plan.offsideLine,
          jobs: [...plan.assignments.values()].map((a) => ({ player: a.player, job: a.job, mode: a.mode,
            x: a.target.x, z: a.target.z, lane: a.lane, space: a.space })) } : null;
      }),
      events: this.rules.events.slice(-8).reverse(),
      matchSeed: this.matchSeed, lastActionSeed: this.lastActionSeed,
      actionLog: this.actionLog.slice(-8).reverse(),
      passLog: this.passLog.slice(0, 8),
      openPlayKickCount: this.openPlayKickCount,
      outRestartCount: this.outRestartCount,
      outRestartRate: this.outRestartCount / Math.max(1, this.openPlayKickCount + this.outRestartCount),
      contactPct: this.contactTotal ? Math.round((this.contactAligned / this.contactTotal) * 100) : 100,
      contactTotal: this.contactTotal,
      passCharge: this.passCharge, shootCharge: this.shootCharge,
      timeScale: this.timeScale, aimRaw: this.aimRaw, foulsOn: this.foulsOn,
      offsideOn: CONFIG.ai.offside,
    };
  }
}

export type Snapshot = ReturnType<MatchEngine["snapshot"]>;
