import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
const seed = Number(process.argv[2] ?? 31337);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
let heldIdx = -1, holdStart = 0, holds = 0;
let lastEv = 0;
for (let f = 0; f < 60 * 240; f++) {
  e.step(1 / 60);
  const before = heldIdx;
  let gkHolding = -1;
  for (const p of e.players) {
    if (p.role === "GK" && e.ball.possessedBy === p.idx && e.ball.handsRestrictedTeam !== p.team) gkHolding = p.idx;
  }
  if (gkHolding >= 0 && heldIdx < 0) { heldIdx = gkHolding; holdStart = e.clock; holds++; }
  if (gkHolding < 0 && heldIdx >= 0) {
    const dur = e.clock - holdStart;
    const reason = e.ball.possessedBy === null ? "loose" : `#${e.ball.possessedBy} t${e.players[e.ball.possessedBy].team} ${e.players[e.ball.possessedBy].role}`;
    console.log(`[${e.clock.toFixed(2)}] hold #${holds} by GK#${heldIdx} dur=${dur.toFixed(2)} ended -> ${reason} phase=${e.rules.phase}`);
    heldIdx = -1;
  }
  for (; lastEv < e.rules.events.length; lastEv++) {
    const ev = e.rules.events[lastEv];
    if (["GOAL", "FOUL", "PENALTY"].includes(ev.type)) console.log(`  EVENT ${ev.type} ${ev.detail}`);
  }
}
if (heldIdx >= 0) console.log(`STILL HOLDING at fulltime: GK#${heldIdx} dur=${(e.clock-holdStart).toFixed(2)}`);
console.log(`total holds=${holds}`);
e.dispose();
