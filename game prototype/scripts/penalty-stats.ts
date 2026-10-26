/**
 * Penalty statistics over many forced spot kicks: logs the ball's goal-line
 * crossing z, the keeper's guessed z and the outcome to validate the guess model.
 *
 *   node .test-artifacts/penalty-stats.cjs [count]
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const count = Number(process.argv[2] ?? 40);
const L = CONFIG.pitch.length / 2;
const R = CONFIG.ball.radius;
const tally = { goal: 0, save: 0 };
const rows: string[] = [];

const dirArg = process.argv[3] ?? "red"; // red = attack +x, blue = attack -x
const spot = (team: number): [number, number] => team === 0
  ? [L - CONFIG.pitch.penaltySpotDist, 0]
  : [-L + CONFIG.pitch.penaltySpotDist, 0];
const team = dirArg === "blue" ? 1 : 0;
for (let i = 0; i < count; i++) {
  const seed = 1234 + i * 17; // same family as watch-batch
  const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
  e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.rules.time = 30;
  const [sx, sz] = spot(team);
  e.ball.release(); e.ball.pos.set(sx, R, sz); e.ball.vel.set(0, 0, 0);
  e.restartAutoT = 0;
  e.rules.startSetup("penalty", [sx, sz], team);
  let outcome = "?", crossZ: number | null = null, guessZ: number | null = null, gkAction = "-";
  let lastEvent = 0;
  let struck = false;
  for (let frame = 0; frame < 60 * 8; frame++) {
    e.step(1 / 60);
    const gk = e.players.find((p) => p.role === "GK" && p.team === 1 - team)!;
    const g = e.ai.penaltyGuessFor(gk.idx, e.clock);
    if (g !== null) guessZ = g;
    if (gk.anim.actionId?.startsWith("gk_")) gkAction = gk.anim.actionId;
    // Intended crossing: extrapolate the untouched strike velocity at the first free-ball frame.
    if (!struck && e.ball.possessedBy === null && e.ball.speed > 15) {
      struck = true;
      const b = e.ball;
      const lineX = team === 0 ? L + R : -(L + R);
      const tLine = (lineX - b.pos.x) / Math.max(1e-3, Math.abs(b.vel.x)) * Math.sign(b.vel.x || 1);
      crossZ = b.pos.z + b.vel.z * Math.abs(tLine);
    }
    for (; lastEvent < e.rules.events.length; lastEvent++) {
      const ev = e.rules.events[lastEvent];
      if (ev.type === "GOAL") outcome = "GOAL";
      if (ev.type === "SAVE" && outcome === "?") outcome = "SAVE";
    }
    if (outcome !== "?" && frame > 60) break;
    if (!e.rules.pendingRestart && e.clock > 9) break;
  }
  if (outcome === "GOAL") tally.goal++; else tally.save++;
  rows.push(`seed ${seed} crossZ=${(crossZ ?? 0).toFixed(2)} guess=${(guessZ ?? 0).toFixed(2)} (${Math.abs(guessZ ?? 0) < 0.5 ? "central" : "side"}) ${gkAction} -> ${outcome}`);
  e.dispose();
}
for (const r of rows.slice(0, 24)) console.log(r);
console.log(`\n${count} penalties: GOAL ${tally.goal} (${(100 * tally.goal / count).toFixed(0)}%), SAVE ${tally.save} (${(100 * tally.save / count).toFixed(0)}%)`);
// band breakdown
for (const r of rows) {
  const m = r.match(/crossZ=(-?[\d.]+) guess=(-?[\d.]+).*-> (\w+)/);
  if (!m) continue;
  const cz = Math.abs(Number(m[1])), gz = Math.abs(Number(m[2]));
  const band = cz < 0.5 ? "central" : cz < 0.9 ? "half   " : "corner ";
  const rightGuess = gz < 0.5 ? cz < 0.55 : (Math.sign(Number(m[1])) === Math.sign(Number(m[2])) && Math.abs(Number(m[1]) - Number(m[2])) <= CONFIG.ai.gkPenaltySaveReach);
  console.log(`${band} crossZ=${m[1].padStart(6)} guess=${m[2].padStart(6)} ${rightGuess ? "covered" : "open   "} -> ${m[3]}`);
}
