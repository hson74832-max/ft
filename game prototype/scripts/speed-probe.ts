import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
const seed = Number(process.argv[2] ?? 1234);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
let maxP = 0, maxB = 0, spike = 0;
let prevV = new Map<number, number>();
for (let f = 0; f < 60 * 240; f++) {
  e.step(1 / 60);
  for (const p of e.players) {
    const s = Math.hypot(p.vel.x, p.vel.z);
    if (s > maxP) maxP = s;
    const pv = prevV.get(p.idx) ?? 0;
    if (s - pv > 4.5) spike++;
    prevV.set(p.idx, s);
  }
  if (e.ball.speed > maxB) maxB = e.ball.speed;
}
console.log(`seed ${seed}: maxPlayerSpeed=${maxP.toFixed(2)} maxBallSpeed=${maxB.toFixed(1)} frameVelocitySpikes(>4.5)=${spike}`);
e.dispose();
