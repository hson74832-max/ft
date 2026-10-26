/**
 * Recovery probe: strands a keeper 4 m off his line with an attacker behind his
 * x-position, then strikes an on-target shot. The keeper must RECOGNISE the shot
 * (readShot no longer bails) and produce a save/recovery action instead of
 * standing idle while the ball rolls into the empty net.
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";
import * as THREE from "three";

const e = new MatchEngine(headlessEngineCanvas(), { seed: 1234, headless: true, spectator: true, debugAI: false });
const L = CONFIG.pitch.length / 2;
const R = CONFIG.ball.radius;
e.rules.phase = "INPLAY"; e.rules.pendingRestart = null; e.rules.time = 30;

// RED attacks the right goal (+x). Put the RED striker at x=16 (behind the
// keeper's body line) and strand the BLUE keeper at x=16, z=+2.5 — he has
// rushed out and been beaten to the near side.
const striker = e.players.find((p) => p.team === 0 && p.role === "FWD")!;
const gk = e.players.find((p) => p.team === 1 && p.role === "GK")!;
striker.pos.set(16, 0, -1.5); striker.vel.set(0, 0, 0); striker.speed = 0; striker.moveTarget.copy(striker.pos);
gk.pos.set(16, 0, 2.5); gk.vel.set(0, 0, 0); gk.speed = 0; gk.moveTarget.copy(gk.pos);
for (const p of e.players) {
  if (p === striker || p === gk) continue;
  // park everyone else far away
  p.pos.set(p.team === 0 ? -8 : 8, 0, p.idx % 2 ? 9 : -9);
  p.vel.set(0, 0, 0); p.moveTarget.copy(p.pos);
}
e.ball.release();
e.ball.pos.set(16, R, -1.5);
e.ball.vel.set(0, 0, 0);
e.ball.possess(striker.idx, striker.team);
// Strike straight at the open goal, low and hard (from behind the keeper line).
e.ball.strike(new THREE.Vector3(1, 0, 0.12).normalize(), { speed: 26, loft: 0.05, spin: new THREE.Vector3(), profileId: "shot_low_driven" });
e.ball.lastTouch = striker.idx; e.ball.lastTouchTeam = striker.team;

let acted = false; let recoveryReason = false; let outcome = "?";
let lastEvent = 0;
for (let f = 0; f < 60 * 4; f++) {
  e.step(1 / 60);
  if (gk.anim.actionId?.startsWith("gk_")) acted = true;
  if (gk.decisionReason.includes("RECOVERY")) recoveryReason = true;
  for (; lastEvent < e.rules.events.length; lastEvent++) {
    const ev = e.rules.events[lastEvent];
    if (ev.type === "GOAL") outcome = "GOAL";
    if (ev.type === "SAVE") outcome = "SAVE";
  }
  if (f < 26) console.log(`[${e.clock.toFixed(2)}] ball=(${e.ball.pos.x.toFixed(2)},${e.ball.pos.z.toFixed(2)}) gk=(${gk.pos.x.toFixed(2)},${gk.pos.z.toFixed(2)}) act=${gk.anim.actionId ?? "-"} reason="${gk.decisionReason}"`);
  if (outcome !== "?") break;
}
console.log(`\nkeeper produced a gk_ action: ${acted}`);
console.log(`recovery decision reason seen: ${recoveryReason}`);
console.log(`outcome: ${outcome}`);
e.dispose();
