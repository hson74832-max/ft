/**
 * Deep shot / keeper audit v2: for every shot records whether the ball was
 * struck behind the keeper's x-line (the readShot bail-out), keeper offsets,
 * keeper action response, and outcome. Batches many seeds.
 *
 *   node .test-artifacts/shot-audit-v2.cjs [seed ...]
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const seeds = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
if (!seeds.length) for (let i = 100; i < 130; i++) seeds.push(i);

interface Row {
  seed: number; t: number; dist: number; speed: number;
  gkLineOff: number; gkLat: number; behindKeeper: boolean; gkActed: boolean;
  outcome: string; readBail: boolean;
}
const rows: Row[] = [];

for (const seed of seeds) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
  let lastEvent = 0;
  let active: { row: Row; gkIdx: number; expired: number; rafGoal: boolean } | null = null;

  for (let frame = 0; frame < 60 * 900; frame++) {
    engine.step(1 / 60);
    if (engine.rules.phase === "FULLTIME") break;
    const t = engine.clock, ball = engine.ball;

    for (; lastEvent < engine.rules.events.length; lastEvent++) {
      const ev = engine.rules.events[lastEvent];
      if (ev.type === "POSSESSION" && ev.detail.includes("SHOOT") && !active) {
        const rec = [...engine.actionLog].reverse().find((r) => r.action.startsWith("shoot_"));
        const p = rec ? engine.players[rec.player] : null;
        if (!p) continue;
        const goal = engine.ai.goalPos(p.team, engine.rules.half);
        const sign = engine.ai.attackSign(p.team, engine.rules.half);
        const dist = Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z);
        const gk = engine.players.find((q) => q.role === "GK" && q.team !== p.team);
        if (!gk) continue;
        const gkLineOff = Math.abs(gk.pos.x - goal.x);
        const ballDepth = (ball.pos.x - goal.x) * sign; // >0 in front of goal
        const gkDepth = (gk.pos.x - goal.x) * sign;
        const behindKeeper = ballDepth < gkDepth - 0.15;
        const row: Row = {
          seed, t, dist, speed: ball.speed,
          gkLineOff, gkLat: Math.abs(gk.pos.z), behindKeeper,
          gkActed: false, outcome: "?", readBail: behindKeeper,
        };
        rows.push(row);
        active = { row, gkIdx: gk.idx, expired: 0, rafGoal: false };
      }
      if (active && ev.type === "GOAL") { active.row.outcome = "GOAL"; active.rafGoal = true; }
      if (active && ev.type === "SAVE" && active.row.outcome === "?") active.row.outcome = "SAVE";
    }

    if (active) {
      const gk = engine.players[active.gkIdx];
      if (gk?.anim.actionId?.startsWith("gk_")) active.row.gkActed = true;
      active.expired += 1 / 60;
      if (active.expired > 2 || ball.possessedBy !== null || engine.rules.pendingRestart !== null || active.rafGoal) {
        if (active.row.outcome === "?") {
          if (ball.possessedBy !== null) {
            const o = engine.players[ball.possessedBy];
            active.row.outcome = o.team === engine.players[active.gkIdx].team ? "claimed" : "reclaimed";
          } else if (Math.abs(ball.pos.x) > CONFIG.pitch.length / 2 || Math.abs(ball.pos.z) > CONFIG.pitch.width / 2) active.row.outcome = "out";
          else active.row.outcome = "loose";
        }
        active = null;
      }
    }
  }
  engine.dispose();
}

const n = rows.length;
const goals = rows.filter((r) => r.outcome === "GOAL");
const behind = rows.filter((r) => r.behindKeeper);
const behindGoals = behind.filter((r) => r.outcome === "GOAL");
const noAct = rows.filter((r) => !r.gkActed);
const noActGoals = noAct.filter((r) => r.outcome === "GOAL");
console.log(`=== ${n} shots across ${seeds.length} matches ===`);
console.log(`goals: ${goals.length} (${(100 * goals.length / n).toFixed(1)}%)`);
console.log(`shots struck BEHIND keeper's x-line: ${behind.length} (${(100 * behind.length / n).toFixed(1)}%) → goals ${behindGoals.length}, gk acted ${behind.filter((r) => r.gkActed).length}`);
console.log(`shots with NO gk action at all: ${noAct.length} → goals ${noActGoals.length}`);
const bands = (pred: (r: Row) => boolean) => {
  const m = rows.filter(pred);
  return `n=${m.length} goals=${m.filter((r) => r.outcome === "GOAL").length} saves=${m.filter((r) => r.outcome === "SAVE").length}`;
};
console.log(`keeper lineOff <1m:   ${bands((r) => r.gkLineOff < 1)}`);
console.log(`keeper lineOff 1-2.5m: ${bands((r) => r.gkLineOff >= 1 && r.gkLineOff < 2.5)}`);
console.log(`keeper lineOff 2.5-4m: ${bands((r) => r.gkLineOff >= 2.5 && r.gkLineOff < 4)}`);
console.log(`keeper lineOff >4m:   ${bands((r) => r.gkLineOff >= 4)}`);
console.log(`shot speed: avg ${(rows.reduce((a, r) => a + r.speed, 0) / n).toFixed(1)} max ${Math.max(...rows.map((r) => r.speed)).toFixed(1)}`);
const dband = (lo: number, hi: number) => {
  const m = rows.filter((r) => r.dist >= lo && r.dist < hi);
  if (!m.length) return `${lo}-${hi}m: n=0`;
  return `${lo}-${hi}m: n=${m.length} goals=${m.filter((r) => r.outcome === "GOAL").length} gkNoAct=${m.filter((r) => !r.gkActed).length} behind=${m.filter((r) => r.behindKeeper).length}`;
};
console.log(dband(0, 6)); console.log(dband(6, 9)); console.log(dband(9, 12)); console.log(dband(12, 15)); console.log(dband(15, 99));
console.log(`\nall GOAL rows:`);
for (const r of goals) console.log(`  seed ${r.seed} t=${r.t.toFixed(1)} d=${r.dist.toFixed(1)}m v=${r.speed.toFixed(0)} gkLine=${r.gkLineOff.toFixed(2)} gkLat=${r.gkLat.toFixed(2)} behind=${r.behindKeeper} acted=${r.gkActed}`);
