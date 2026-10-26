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
  /**
   * One-shot latch for the *opening* kickoff announcement.
   *
   * The opening kickoff is announced once, by the first `startSetup("kickoff")`;
   * the latch records that it has been announced so a re-stage can never repeat
   * it, and every later kickoff (second half, after a goal) announces normally.
   *
   * This deliberately does NOT test the match clock. An earlier `time < 0.1`
   * guard could only ever be true for the opening kickoff: the match clock is
   * frozen while players are staged for a restart, so by the time the second
   * half or a post-goal kickoff is set up the clock is minutes past that
   * window. The condition was impossible to satisfy, so those kickoffs never
   * emitted a KICKOFF event and the HUD feed reported no kickoff at all.
   */
  private openingKickoffAnnounced = false;
  private kickoffCount = 0;
  readonly initialKickoffTeam: number;

  constructor(initialKickoffTeam = 0) {
    this.initialKickoffTeam = initialKickoffTeam;
  }

  get halfLength() { return CONFIG.match.totalSeconds / 2; }
  get remaining() { return Math.max(0, CONFIG.match.totalSeconds - this.time); }
  /** Remaining match clock, zero-padded (00:45, not 0:45). */
  get clock(): string {
    const r = this.remaining;
    const m = Math.floor(r / 60), s = Math.floor(r % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  get elapsedClock(): string {
    const t = Math.max(0, Math.floor(this.time));
    return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  }
  /** How many kickoffs have been announced this match (the opening one included). */
  get kickoffs() { return this.kickoffCount; }
  get halfLabel(): string {
    if (this.phase === "FULLTIME") return "FULL TIME";
    if (this.phase === "HALFTIME") return "HALF TIME";
    return this.half === 1 ? "1ST HALF" : "2ND HALF";
  }

  emit(type: RuleEventType, detail: string, team?: number) {
    this.events.push({ id: this.eid++, t: this.time, type, detail, team });
    if (this.events.length > 120) this.events.shift();
  }

  /** Announce a kickoff exactly once, whoever stages it and whenever it happens. */
  private announceKickoff(team: number, pos: [number, number]) {
    const name = team === 0 ? "RED" : "BLUE";
    const detail = this.openingKickoffAnnounced
      ? `kickoff → team ${name} @ (${pos[0].toFixed(1)}, ${pos[1].toFixed(1)})`
      : `Match initialised — kickoff ${name}`;
    this.openingKickoffAnnounced = true;
    this.kickoffCount++;
    this.emit("KICKOFF", detail, team);
  }

  startSetup(kind: string, pos: [number, number], team: number) {
    this.phase = "SETUP";
    this.setupT = CONFIG.match.setupFreeze;
    this.pendingRestart = { id: this.rid++, kind, pos, team };
    if (kind === "kickoff") {
      this.announceKickoff(team, pos);
      return;
    }
    const map: Record<string, RuleEventType> = {
      throw_in: "THROW_IN", corner: "CORNER", goal_kick: "GOAL_KICK",
      free_kick: "FREE_KICK", penalty: "PENALTY",
    };
    this.emit(map[kind] ?? "WHISTLE", `${kind.replace("_", " ")} → team ${team === 0 ? "RED" : "BLUE"} @ (${pos[0].toFixed(1)}, ${pos[1].toFixed(1)})`, team);
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
