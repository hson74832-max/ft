/**
 * Batch scenario statistics: force one restart kind many times and aggregate
 * physical outcomes (goal / save / loose / out / stuck), plus per-kind geometry.
 *
 *   node .test-artifacts/watch-batch.cjs <kind> <count> [seed]
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const kindArg = process.argv[2] ?? "corner";
const count = Number(process.argv[3] ?? 40);
const baseSeed = Number(process.argv[4] ?? 1234);
const L = CONFIG.pitch.length / 2, W = CONFIG.pitch.width / 2;
const R = CONFIG.ball.radius;

type Case = { pos: [number, number]; team: number; label: string };
const casesFor = (k: string): Case[] => {
  switch (k) {
    case "corner": return [
      { pos: [L - 0.25, W - 0.25], team: 0, label: "red-top" },
      { pos: [L - 0.25, -(W - 0.25)], team: 0, label: "red-bottom" },
      { pos: [-L + 0.25, W - 0.25], team: 1, label: "blue-top" },
      { pos: [-L + 0.25, -(W - 0.25)], team: 1, label: "blue-bottom" },
    ];
    case "penalty": return [
      { pos: [L - CONFIG.pitch.penaltySpotDist, 0], team: 0, label: "red" },
      { pos: [-L + CONFIG.pitch.penaltySpotDist, 0], team: 1, label: "blue" },
    ];
    case "throw_in": return [
      { pos: [6, W - 0.25], team: 0, label: "mid-top" },
      { pos: [-6, -(W - 0.25)], team: 0, label: "mid-bottom" },
      { pos: [18.4, W - 0.25], team: 1, label: "deep-top-attacking" },
      { pos: [-18.4, -(W - 0.25)], team: 1, label: "deep-bottom-attacking" },
    ];
    case "free_kick": return [
      { pos: [12, 6], team: 0, label: "red-r20" },
      { pos: [-12, -6], team: 1, label: "blue-r20" },
      { pos: [4, 0], team: 0, label: "red-r16" },
      { pos: [-4, 0], team: 1, label: "blue-r16" },
    ];
    default: return [{ pos: [0, 0], team: 0, label: "default" }];
  }
};

const rows: string[] = [];
let totals: Record<string, number> = {};
const bump = (k: string) => { totals[k] = (totals[k] ?? 0) + 1; };

function run(kind: string, c: Case, i: number): string {
  const seed = baseSeed + i * 17;
  const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.rules.time = 30;
  e.ball.release(); e.ball.pos.set(c.pos[0], R, c.pos[1]); e.ball.vel.set(0, 0, 0);
  e.restartAutoT = 0;
  e.rules.startSetup(kind, c.pos, c.team);

  const diag: string[] = [];
  let placed = false, closedAt = -1, maxSpeed = 0, nan = 0, takerDist = -1;
  let ownersAfter: number[] = [];
  let outCount = 0, lastOut = "";
  let startBall = { x: 0, z: 0 };
  let gkStart = { x: 0, z: 0, dist: 0 };
  let defendersInBox = 0, wallDists: number[] = [];
  let keeperOnLine = -1;
  let shotFromRestart = false;
  let ballOutsideAtRelease = 0;

  for (let frame = 0; frame < 60 * 12; frame++) {
    e.step(1 / 60);
    const b = e.ball;
    const pr = e.rules.pendingRestart;
    if (!Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.y) || !Number.isFinite(b.pos.z)) nan++;
    maxSpeed = Math.max(maxSpeed, b.speed);
    if (!placed && pr && e.placedRestartId === pr.id) {
      placed = true;
      startBall = { x: b.pos.x, z: b.pos.z };
      const defTeam = 1 - c.team;
      const gk = e.players.find((p) => p.team === defTeam && p.role === "GK")!;
      const goal = e.ai.ownGoal(defTeam, e.rules.half);
      gkStart = { x: gk.pos.x, z: gk.pos.z, dist: Math.abs(gk.pos.x - goal.x) };
      keeperOnLine = Math.abs(gk.pos.x - goal.x);
      const atkGoal = e.ai.goalPos(c.team, e.rules.half);
      defendersInBox = e.players.filter((p) => p.team === defTeam && p.role !== "GK"
        && Math.abs(p.pos.x - atkGoal.x) < CONFIG.pitch.penaltyAreaDepth && Math.abs(p.pos.z) < 6.2).length;
      const taker = e.players.find((p) => p.restartTaker);
      takerDist = taker ? Math.hypot(taker.pos.x - b.pos.x, taker.pos.z - b.pos.z) : -1;
      if (kind === "free_kick") {
        const opp = e.players.filter((p) => p.team !== c.team && p.role !== "GK")
          .map((p) => Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z)).sort((a, b) => a - b);
        wallDists = opp.slice(0, 4);
      }
    }
    if (pr && e.rules.live && e.restartStartedId === pr.id && b.speed > 0.5) ballOutsideAtRelease = Math.max(ballOutsideAtRelease, Math.abs(b.pos.z) - W);
    if (pr && e.rules.live && e.restartStartedId === pr.id) {
      const last = e.actionLog[e.actionLog.length - 1];
      if (last && (last.action.startsWith("shoot") || last.action === "corner_kick") && last.t >= e.clock - 0.1) shotFromRestart = true;
    }
    if (!pr && closedAt < 0 && placed) closedAt = frame;
    if (ownersAfter.length === 0 && b.possessedBy !== null && placed && !pr) ownersAfter.push(b.possessedBy);
    if (b.possessedBy !== null && ownersAfter[ownersAfter.length - 1] !== b.possessedBy) ownersAfter.push(b.possessedBy);
    const evs = e.rules.events;
    const lastEv = evs[evs.length - 1];
    if (lastEv && lastEv.t >= e.clock - 0.02) {
      if (["THROW_IN", "CORNER", "GOAL_KICK", "FREE_KICK", "PENALTY"].includes(lastEv.type)) {
        if (closedAt >= 0) { outCount++; lastOut = lastEv.type + "@" + lastEv.detail.split("@")[1]?.trim(); }
      }
    }
    if (!pr && closedAt >= 0 && frame > closedAt + 240) break;
  }

  const phase = e.rules.phase;
  const score = e.rules.score.join(":");
  const goals = e.rules.events.filter((x) => x.type === "GOAL").length;
  const saves = e.rules.events.filter((x) => x.type === "SAVE").length;
  const fouls = e.rules.events.filter((x) => x.type === "FOUL").length;
  const restartAfter = e.rules.pendingRestart?.kind ?? "none";
  const owner = e.ball.possessedBy;
  const ownerTeam = owner !== null ? e.players[owner].team : null;
  const attackSign = Math.sign(e.ai.goalPos(c.team, e.rules.half).x - c.pos[0]) || 1;
  const progressed = (e.ball.pos.x - c.pos[0]) * attackSign;

  const outcome = goals > 0 ? "GOAL" : saves > 0 ? "SAVE" : restartAfter !== "none" ? `OUT->${restartAfter}` : ownerTeam === c.team ? "kept" : ownerTeam !== null ? "lost" : "loose";
  bump(outcome);
  bump(`${kind}:${outcome}`);
  if (kind === "throw_in" && outcome.startsWith("OUT->THROW_IN")) bump("throwin_rethrow_opponent");

  const row = `${c.label.padEnd(20)} goal=${goals} saves=${saves} owner=${owner !== null ? "#" + owner + "t" + ownerTeam : "-"} next=${restartAfter} progressed=${progressed.toFixed(1)}m maxV=${maxSpeed.toFixed(1)} takerDist=${takerDist.toFixed(2)} gkOffLine=${keeperOnLine.toFixed(2)} defInBox=${defendersInBox} wall=${wallDists.map((d) => d.toFixed(1)).join("/")} releaseOutside=${ballOutsideAtRelease.toFixed(2)} phase=${phase}`;
  e.dispose();
  return row;
}

for (const c of casesFor(kindArg)) {
  for (let i = 0; i < count; i++) {
    const row = run(kindArg, c, i);
    rows.push(row);
    if (i < 6) console.log(row);
  }
}
console.log(`\n=== ${kindArg} totals over ${count} × ${casesFor(kindArg).length} ===`);
console.log(totals);
