import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";
const L = CONFIG.pitch.length / 2, R = CONFIG.ball.radius;
const seed = Number(process.argv[2] ?? 539);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.rules.time = 30;
e.ball.release(); e.ball.pos.set(L - CONFIG.pitch.penaltySpotDist, R, 0); e.ball.vel.set(0, 0, 0);
e.restartAutoT = 0;
e.rules.startSetup("penalty", [L - CONFIG.pitch.penaltySpotDist, 0], 0);
let last = 0;
for (let f = 0; f < 60 * 8; f++) {
  e.step(1 / 60);
  const gk = e.players.find((p) => p.role === "GK" && p.team === 1)!;
  for (; last < e.rules.events.length; last++) {
    const ev = e.rules.events[last];
    if (ev.type === "SAVE" || ev.type === "GOAL") {
      const guess = e.ai.penaltyGuessFor(gk.idx, e.clock);
      console.log(`[${e.clock.toFixed(2)}] ${ev.type} ${ev.detail} | guess=${guess?.toFixed(2)} ball=(${e.ball.pos.x.toFixed(2)},${e.ball.pos.z.toFixed(2)}) gk=(${gk.pos.x.toFixed(2)},${gk.pos.z.toFixed(2)}) act=${gk.anim.actionId}`);
    }
  }
  if (!e.rules.pendingRestart && e.clock > 9) break;
}
e.dispose();
