import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";
const seed = Number(process.argv[2] ?? 1234);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
let maxHold = 0, holds = 0, distributes = 0;
let heldIdx = -1, holdStart = 0;
const bursts: string[] = [];
let lastEv = 0, lastSaveT = -10, streak = 0;
for (let f = 0; f < 60 * 240; f++) {
  e.step(1 / 60);
  for (const p of e.players) {
    if (p.role !== "GK") continue;
    const inHands = e.ball.possessedBy === p.idx && e.ball.handsRestrictedTeam !== p.team;
    if (inHands && heldIdx !== p.idx) { heldIdx = p.idx; holdStart = e.clock; holds++; }
    if (inHands) maxHold = Math.max(maxHold, e.clock - holdStart);
    if (!inHands && heldIdx === p.idx) { heldIdx = -1; distributes++; }
  }
  for (; lastEv < e.rules.events.length; lastEv++) {
    const ev = e.rules.events[lastEv];
    if (ev.type === "SAVE") {
      streak = e.clock - lastSaveT < 2 ? streak + 1 : 1;
      if (streak >= 2) bursts.push(`t=${e.clock.toFixed(2)} streak=${streak} "${ev.detail}"`);
      lastSaveT = e.clock;
    }
  }
}
console.log(`seed ${seed}: holds=${holds} releases=${distributes} maxHold=${maxHold.toFixed(2)}s (limit ${CONFIG.ai.gkHoldLimit}s)`);
console.log(`  SAVE bursts (>=2 within 2s): ${bursts.length}`);
for (const b of bursts.slice(0, 8)) console.log("  " + b);
e.dispose();
