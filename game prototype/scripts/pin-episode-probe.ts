/**
 * Pin-episode probe: measures contiguous spells where the carrier desires
 * speed > 2 but moves < 0.2. Reports episode lengths and the state at the
 * longest episodes to distinguish a natural tackle recovery (one clip ~0.6s)
 * from a multi-second body fusion.
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";

const seed = Number(process.argv[2] ?? 1234);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });

type Ep = { idx: number; start: number; len: number; root: number; protect: number; recovery: number; nearest: string };
const episodes: Ep[] = [];
let cur: Ep | null = null;
let lastIdx = -1;

for (let frame = 0; frame < 60 * 240; frame++) {
  e.step(1 / 60);
  const b = e.ball;
  const stuckNow = b.possessedBy !== null
    && e.players[b.possessedBy].role !== "GK"
    && e.players[b.possessedBy].desiredSpeed > 2
    && e.players[b.possessedBy].speed < 0.2;
  const o = b.possessedBy !== null ? e.players[b.possessedBy] : null;
  if (stuckNow && o) {
    if (!cur || lastIdx !== o.idx) {
      if (cur) episodes.push(cur);
      const near = e.players.filter((q) => q.idx !== o.idx).map((q) => ({ q, d: q.pos.distanceTo(o.pos) })).sort((a, b) => a.d - b.d)[0];
      cur = { idx: o.idx, start: e.clock, len: 1, root: 0, protect: 0, recovery: 0,
        nearest: near ? `${near.q.role}${near.q.team === o.team ? "(mate)" : "(opp)"}@${near.d.toFixed(2)}` : "-" };
    } else cur.len++;
    if (o.anim.actionRootMotion) cur.root++;
    if (o.tackleProtectionT > 0) cur.protect++;
    if (o.tackleRecoveryT > 0) cur.recovery++;
    lastIdx = o.idx;
  } else if (cur) {
    episodes.push(cur); cur = null; lastIdx = -1;
  }
}
if (cur) episodes.push(cur);

const lens = episodes.map((x) => x.len / 60);
console.log(`seed ${seed}: ${episodes.length} pin episodes`);
if (lens.length) {
  console.log(`duration s: min=${Math.min(...lens).toFixed(2)} median=${(lens.sort((a, b) => a - b)[lens.length >> 1]).toFixed(2)} max=${Math.max(...lens).toFixed(2)} total=${lens.reduce((a, b) => a + b, 0).toFixed(1)}s`);
}
for (const ep of [...episodes].sort((a, b) => b.len - a.len).slice(0, 6)) {
  console.log(`  #${ep.idx} t=${ep.start.toFixed(1)} dur=${(ep.len / 60).toFixed(2)}s root=${ep.root}f protect=${ep.protect}f recovery=${ep.recovery}f near=${ep.nearest}`);
}
e.dispose();
