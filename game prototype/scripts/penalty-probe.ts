/**
 * Penalty trace: forces a penalty and logs the kick, keeper behavior and outcome.
 *   node .test-artifacts/penalty-probe.cjs [seed]
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const seed = Number(process.argv[2] ?? 1234);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
const L = CONFIG.pitch.length / 2;
const R = CONFIG.ball.radius;
e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.rules.time = 30;
e.ball.release(); e.ball.pos.set(L - CONFIG.pitch.penaltySpotDist, R, 0); e.ball.vel.set(0, 0, 0);
e.restartAutoT = 0;
e.rules.startSetup("penalty", [L - CONFIG.pitch.penaltySpotDist, 0], 0);

let lastEvent = 0;
for (let frame = 0; frame < 60 * 10; frame++) {
  e.step(1 / 60);
  const t = e.clock;
  for (; lastEvent < e.rules.events.length; lastEvent++) {
    const ev = e.rules.events[lastEvent];
    console.log(`[${t.toFixed(2)}] EVENT ${ev.type} ${ev.detail}`);
  }
  const gk = e.players.find((p) => p.role === "GK" && p.team === 1)!;
  if (e.ball.speed > 1 || gk.anim.actionId?.startsWith("gk_")) {
    console.log(`[${t.toFixed(2)}] ball=(${e.ball.pos.x.toFixed(2)},${e.ball.pos.y.toFixed(2)},${e.ball.pos.z.toFixed(2)}) sp=${e.ball.speed.toFixed(1)} gk=(${gk.pos.x.toFixed(2)},${gk.pos.z.toFixed(2)}) act=${gk.anim.actionId ?? "-"}@${gk.anim.actionT.toFixed(2)}`);
  }
  if (e.rules.phase === "FULLTIME" || (!e.rules.pendingRestart && frame > 60 * 5)) break;
}
e.dispose();
