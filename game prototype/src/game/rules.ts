// Rules engine — classic simplified, no offside. Typed events for AI/UI/replay.
import { CONFIG, RuleEvent, RuleEventType } from "./config";

export type MatchPhase = "KICKOFF" | "INPLAY" | "SETUP" | "GOAL" | "HALFTIME" | "FULLTIME";

export class RulesEngine {
  phase: MatchPhase = "KICKOFF";
  score = [0, 0];
  time = 0; // elapsed match seconds (playing time only)
  half: 1 | 2 = 1;
  setupT = 0;
  celebrateT = 0;
  pendingRestart: { id: number; kind: string; pos: [number, number]; team: number } | null = null;
  events: RuleEvent[] = [];
  private eid = 1;
  private rid = 1;
  private halfNotified = false;
  readonly initialKickoffTeam: number;

  constructor(initialKickoffTeam = 0) {
    this.initialKickoffTeam = initialKickoffTeam;
    this.emit("KICKOFF", `Match initialised — kickoff ${initialKickoffTeam === 0 ? "RED" : "BLUE"}`, initialKickoffTeam);
  }

  get halfLength() { return CONFIG.match.totalSeconds / 2; }
  get remaining() { return Math.max(0, CONFIG.match.totalSeconds - this.time); }
  get clock(): string {
    const r = this.remaining;
    const m = Math.floor(r / 60), s = Math.floor(r % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  get elapsedClock(): string {
    const t = Math.max(0, Math.floor(this.time));
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }
  get halfLabel(): string {
    if (this.phase === "FULLTIME") return "FULL TIME";
    if (this.phase === "HALFTIME") return "HALF TIME";
    return this.half === 1 ? "1ST HALF" : "2ND HALF";
  }

  emit(type: RuleEventType, detail: string, team?: number) {
    this.events.push({ id: this.eid++, t: this.time, type, detail, team });
    if (this.events.length > 120) this.events.shift();
  }

  startSetup(kind: string, pos: [number, number], team: number) {
    this.phase = "SETUP";
    this.setupT = CONFIG.match.setupFreeze;
    this.pendingRestart = { id: this.rid++, kind, pos, team };
    const map: Record<string, RuleEventType> = {
      throw_in: "THROW_IN", corner: "CORNER", goal_kick: "GOAL_KICK",
      free_kick: "FREE_KICK", penalty: "PENALTY", kickoff: "KICKOFF",
    };
    this.emit(map[kind] ?? "KICKOFF", `${kind.replace("_", " ")} → team ${team === 0 ? "RED" : "BLUE"} @ (${pos[0].toFixed(1)}, ${pos[1].toFixed(1)})`, team);
  }

  lastScorer: number = 0;
  goal(team: number) {
    this.score[team]++;
    this.lastScorer = team;
    this.phase = "GOAL";
    this.celebrateT = CONFIG.match.goalCelebrate;
    this.emit("GOAL", `GOAL! ${team === 0 ? "RED" : "BLUE"} scores — ${this.score[0]} : ${this.score[1]}`, team);
  }

  whistle(detail: string) { this.emit("WHISTLE", detail); }

  update(dt: number): { justWentLive: boolean; justScoredDone: boolean } {
    let live = false, done = false;
    if (this.phase === "SETUP") {
      this.setupT -= dt;
      if (this.setupT <= 0) { this.phase = "INPLAY"; live = true; this.whistle("Whistle — play resumes"); this.emit("RESTART_READY", "Restart live"); }
    } else if (this.phase === "GOAL") {
      this.celebrateT -= dt;
      if (this.celebrateT <= 0) {
        done = true;
        this.emit("CELEBRATION_END", "Celebration over — kickoff");
        this.startSetup("kickoff", [0, 0], 1 - this.lastScorer); // conceding team restarts
      }
    } else if (this.phase === "KICKOFF") {
        this.startSetup("kickoff", [0, 0], this.initialKickoffTeam);
    } else if (this.phase === "INPLAY") {
      this.time += dt;
      const hl = this.halfLength;
      if (this.half === 1 && this.time >= hl && !this.halfNotified) {
        this.halfNotified = true;
        this.half = 2; this.phase = "HALFTIME"; this.setupT = CONFIG.match.halftimePause;
        this.emit("HALF_TIME", `Half time — ${this.score[0]} : ${this.score[1]}. Sides switch.`);
      }
      if (this.time >= CONFIG.match.totalSeconds) {
        this.phase = "FULLTIME";
        this.emit("FULL_TIME", `Full time — RED ${this.score[0]} : ${this.score[1]} BLUE`);
      }
    } else if (this.phase === "HALFTIME") {
      this.setupT -= dt;
      if (this.setupT <= 0) {
        // Ends swap at half-time: the side that did not start the match restarts.
        this.startSetup("kickoff", [0, 0], 1 - this.initialKickoffTeam);
      }
    }
    return { justWentLive: live, justScoredDone: done };
  }

  get live() { return this.phase === "INPLAY"; }
  get frozen() { return !this.live; }
}
