/**
 * Match watcher: runs a full CPU-vs-CPU match headless, logs every restart
 * lifecycle transition and reports physical / state anomalies. This is a
 * diagnostic harness, not a pass/fail regression (see ./watch-scenarios.ts).
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const seed = Number(process.argv[2] ?? 1234);
const verbose = process.argv.includes("--verbose");

const engine = new MatchEngine(headlessEngineCanvas(), {
  seed, headless: true, spectator: true, debugAI: false,
});

const L = CONFIG.pitch.length / 2, W = CONFIG.pitch.width / 2;

type Stage = {
  id: number; kind: string; team: number; pos: [number, number];
  setupFrame: number; liveFrame: number; launchFrame: number; endFrame: number;
  placements: { idx: number; team: number; role: string; x: number; z: number }[];
  ballAtLive: [number, number];
  launchedBy: number | null; launchedAction: string | null; releaseSpeed: number;
  takerDistAtLive: number;
  note: string;
};

const stages: Stage[] = [];
let cur: Stage | null = null;
const anomalies: string[] = [];
let lastPhase = engine.rules.phase;
let lastPendingId = -1;
let possessionRun = 0, lastOwner: number | null = null;
let maxPossession = 0, maxPossessionOwner = -1;
let nanFrames = 0;
let outOfPitchFrames = 0;
let insideBoxList: string[] = [];
let restartFrame = -1;

const stat = { goals: 0, corners: 0, throwIns: 0, freeKicks: 0, penalties: 0, goalKicks: 0, fouls: 0, saves: 0, offside: 0, cards: 0 };

for (let frame = 0; frame < 60 * 900; frame++) {
  engine.step(1 / 60);
  const pr = engine.rules.pendingRestart;
  const phase = engine.rules.phase;

  // --- ball / player sanity -------------------------------------------------
  const b = engine.ball.pos;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z)
    || !Number.isFinite(engine.ball.vel.x) || !Number.isFinite(engine.ball.vel.z)) {
    nanFrames++;
    if (nanFrames < 4) anomalies.push(`frame ${frame}: non-finite ball state ${JSON.stringify([b.x, b.y, b.z, engine.ball.vel.x])}`);
  }
  if (phase === "INPLAY" && !pr && (Math.abs(b.x) > L + 1 || Math.abs(b.z) > W + 1)) {
    outOfPitchFrames++;
    if (outOfPitchFrames < 4) anomalies.push(`frame ${frame}: live ball out of pitch at (${b.x.toFixed(2)}, ${b.z.toFixed(2)})`);
  }

  // --- restart lifecycle ----------------------------------------------------
  if (pr && pr.id !== lastPendingId) {
    // A restart that is chained straight into another (a throw-in re-awarded, a
    // corner after a blocked cross) never sees `!pendingRestart`, so close the
    // previous stage here or its duration is reported as negative / unfinished.
    if (cur && cur.endFrame < 0) {
      cur.endFrame = frame;
      cur.releaseSpeed = engine.ball.speed;
      cur.note = "chained";
    }
    lastPendingId = pr.id;
    const kind = pr.kind;
    if (kind === "corner") stat.corners++;
    else if (kind === "throw_in") stat.throwIns++;
    else if (kind === "free_kick") stat.freeKicks++;
    else if (kind === "goal_kick") stat.goalKicks++;
    else if (kind === "penalty") stat.penalties++;
    cur = {
      id: pr.id, kind, team: pr.team, pos: [pr.pos[0], pr.pos[1]],
      setupFrame: frame, liveFrame: -1, launchFrame: -1, endFrame: -1,
      placements: [], ballAtLive: [0, 0], launchedBy: null, launchedAction: null,
      releaseSpeed: 0, takerDistAtLive: -1, note: "",
    };
    stages.push(cur);
    if (verbose) console.log(`[${engine.clock.toFixed(1)}] SETUP #${pr.id} ${kind} team=${pr.team} @ (${pr.pos[0].toFixed(2)}, ${pr.pos[1].toFixed(2)})`);
    if (kind === "penalty") {
      const gk = engine.players.find((p) => p.team !== pr.team && p.role === "GK");
      const taker = engine.players.find((p) => p.restartTaker);
      insideBoxList.push(`penalty #${pr.id} taker=#${taker?.idx ?? "-"} gk=#${gk?.idx ?? "-"} gkPos=${gk ? `(${gk.pos.x.toFixed(2)},${gk.pos.z.toFixed(2)})` : "-"}`);
    }
  }
  if (cur && pr && pr.id === cur.id) {
    if (cur.liveFrame < 0 && phase === "INPLAY") {
      cur.liveFrame = frame;
      cur.ballAtLive = [b.x, b.z];
      const taker = engine.players.find((p) => p.restartTaker);
      cur.takerDistAtLive = taker ? Math.hypot(taker.pos.x - b.x, taker.pos.z - b.z) : -1;
      const gk = engine.players.find((p) => p.role === "GK" && p.team !== pr.team);
      if (cur.kind === "penalty") {
        const goal = engine.ai.ownGoal(1 - pr.team, engine.rules.half);
        const gkLineDist = gk ? Math.abs(Math.abs(gk.pos.x) - Math.abs(goal.x)) : -1;
        insideBoxList.push(`  live: ball=(${b.x.toFixed(2)},${b.z.toFixed(2)}) gk=#${gk?.idx} at (${gk?.pos.x.toFixed(2)},${gk?.pos.z.toFixed(2)}) lineOffset=${gkLineDist.toFixed(2)}`);
        // everybody inside the box at the kick?
        const box = engine.players.filter((p) => p.idx !== (taker?.idx ?? -1) && p.role !== "GK"
          && Math.abs(p.pos.x - goal.x) < CONFIG.pitch.penaltyAreaDepth && Math.abs(p.pos.z) < 6.2);
        insideBoxList.push(`  encroachment: ${box.map((p) => `#${p.idx}/${p.role}(${p.pos.x.toFixed(2)},${p.pos.z.toFixed(2)})`).join(" ") || "none"}`);
      }
      if (verbose) console.log(`  live ${cur.kind} ball=(${b.x.toFixed(2)},${b.z.toFixed(2)}) takerDist=${cur.takerDistAtLive.toFixed(2)}`);
    }
    if (cur.launchFrame < 0 && pr.id === engine.restartStartedId) {
      cur.launchFrame = frame;
    }
    if (cur.launchFrame >= 0 && cur.launchedAction === null) {
      const last = [...engine.actionLog].reverse().find((a) => a.t >= engine.clock - 0.6 && a.action !== "tackle_stand" && a.action !== "tackle_slide");
      if (last) { cur.launchedAction = last.action; cur.launchedBy = last.player; }
    }
  }
  if (!pr && cur && cur.endFrame < 0) {
    cur.endFrame = frame;
    cur.releaseSpeed = engine.ball.speed;
    if (verbose) console.log(`  end #${cur.id} ${cur.kind} after ${((frame - cur.setupFrame) / 60).toFixed(2)}s ballSpeed=${engine.ball.speed.toFixed(1)}`);
    if (frame - cur.setupFrame > 8 * 60) anomalies.push(`restart #${cur.id} ${cur.kind} took ${((frame - cur.setupFrame) / 60).toFixed(1)}s`);
    const prev = stages[stages.length - 2];
    if (prev && prev.kind === cur.kind && cur.endFrame >= 0
      && Math.hypot(prev.pos[0] - cur.pos[0], prev.pos[1] - cur.pos[1]) < 1.5
      && (cur.endFrame - prev.setupFrame) / 60 < 3) {
      anomalies.push(`restart loop: ${cur.kind} #${prev.id}→#${cur.id} at (${cur.pos[0].toFixed(1)}, ${cur.pos[1].toFixed(1)}) within ${((cur.endFrame - prev.setupFrame) / 60).toFixed(2)}s`);
    }
    cur = null;
  }

  // --- possession length ----------------------------------------------------
  const owner = engine.ball.possessedBy;
  if (engine.rules.phase === "INPLAY" && !pr) {
    if (owner !== null && owner === lastOwner) possessionRun++;
    else {
      if (possessionRun > maxPossession) { maxPossession = possessionRun; maxPossessionOwner = lastOwner ?? -1; }
      possessionRun = 1; lastOwner = owner;
    }
  } else {
    if (possessionRun > maxPossession) { maxPossession = possessionRun; maxPossessionOwner = lastOwner ?? -1; }
    possessionRun = 0; lastOwner = null;
  }

  if (phase !== lastPhase) {
    if (verbose) console.log(`[${engine.clock.toFixed(1)}] phase ${lastPhase} -> ${phase}`);
    lastPhase = phase;
  }
  if (engine.rules.phase === "FULLTIME") break;
}

// ---- collect restart stats -------------------------------------------------
const byKind = new Map<string, Stage[]>();
for (const s of stages) {
  if (!byKind.has(s.kind)) byKind.set(s.kind, []);
  byKind.get(s.kind)!.push(s);
}
console.log(`\n=== seed ${seed} · score ${engine.rules.score.join(":")} · events ${engine.rules.events.length} ===`);
console.log(`restart counts:`, Object.fromEntries([...byKind].map(([k, v]) => [k, v.length])));
for (const [kind, list] of byKind) {
  const durations = list.map((s) => (s.endFrame - s.setupFrame) / 60);
  const takerDists = list.map((s) => s.takerDistAtLive).filter((d) => d >= 0);
  const actions = new Map<string, number>();
  for (const s of list) if (s.launchedAction) actions.set(s.launchedAction, (actions.get(s.launchedAction) ?? 0) + 1);
  console.log(`\n${kind}: n=${list.length}`);
  console.log(`  duration avg=${(durations.reduce((a, c) => a + c, 0) / Math.max(1, durations.length)).toFixed(2)}s max=${Math.max(0, ...durations).toFixed(2)}s`);
  if (takerDists.length) console.log(`  takerDistAtLive avg=${(takerDists.reduce((a, c) => a + c, 0) / takerDists.length).toFixed(2)}m max=${Math.max(...takerDists).toFixed(2)}m`);
  console.log(`  actions:`, Object.fromEntries(actions));
  const unfinished = list.filter((s) => s.endFrame < 0).length;
  if (unfinished) console.log(`  UNFINISHED: ${unfinished}`);
  const neverStarted = list.filter((s) => s.launchFrame < 0).length;
  if (neverStarted) console.log(`  never started: ${neverStarted}`);
  const chained = list.filter((s) => s.note === "chained").length;
  if (chained) console.log(`  chained into another restart: ${chained}`);
}
const ev = engine.rules.events;
for (const e of ev) {
  if (e.type === "GOAL") stat.goals++;
  else if (e.type === "FOUL") stat.fouls++;
  else if (e.type === "SAVE") stat.saves++;
  else if (e.type === "OFFSIDE") stat.offside++;
  else if (e.type === "YELLOW_CARD") stat.cards++;
}
console.log(`\nevents:`, stat);
console.log(`max possession ${((maxPossession / 60)).toFixed(1)}s by #${maxPossessionOwner}`);
console.log(`nan frames ${nanFrames}, live ball out-of-pitch frames ${outOfPitchFrames}`);
console.log(`\nAnomalies (${anomalies.length}):`);
for (const a of anomalies.slice(0, 30)) console.log("  " + a);
console.log(`\nPenalty diagnostics (${insideBoxList.length}):`);
for (const line of insideBoxList.slice(0, 40)) console.log("  " + line);
console.log(`\nlast 40 events:`);
for (const e of ev.slice(-40)) console.log(`  ${e.t.toFixed(1)} ${e.type} ${e.detail}`);
engine.dispose();
