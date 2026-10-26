/**
 * Frame-level trace around a time window in a headless match.
 *
 *   node .test-artifacts/trace-probe.cjs <seed> <tStart> <tEnd>
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const seed = Number(process.argv[2] ?? 26);
const tStart = Number(process.argv[3] ?? 64);
const tEnd = Number(process.argv[4] ?? 70);

const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
const L = CONFIG.pitch.length / 2;
let lastEvent = 0;

for (let frame = 0; frame < 60 * 900; frame++) {
  const before = e.rules.events.length;
  e.step(1 / 60);
  const t = e.clock;
  const b = e.ball;
  const gks = e.players.filter((p) => p.role === "GK");

  if (t >= tStart && t <= tEnd) {
    const evs = e.rules.events.slice(lastEvent);
    for (const ev of evs) console.log(`  [${t.toFixed(2)}] EVENT ${ev.type} ${ev.detail}`);
    const gkLine = gks.map((g) => {
      const own = e.ai.ownGoal(g.team, e.rules.half);
      return `GK#${g.idx}(${g.team === 0 ? "R" : "B"}) pos=(${g.pos.x.toFixed(2)},${g.pos.z.toFixed(2)}) lineOff=${Math.abs(g.pos.x - own.x).toFixed(2)} act=${g.anim.actionId ?? "-"}@${g.anim.actionT.toFixed(2)}`;
    }).join(" | ");
    const owner = b.possessedBy !== null ? `owner=#${b.possessedBy}` : "free";
    console.log(`[${t.toFixed(2)}] ball=(${b.pos.x.toFixed(2)},${b.pos.y.toFixed(2)},${b.pos.z.toFixed(2)}) v=(${b.vel.x.toFixed(1)},${b.vel.y.toFixed(1)},${b.vel.z.toFixed(1)}) sp=${b.speed.toFixed(1)} ${owner} | ${gkLine}`);
  }
  lastEvent = e.rules.events.length;
  if (e.rules.phase === "FULLTIME" || t > tEnd + 2) break;
}
void L;
e.dispose();
