/**
 * Scenario watcher v2: force a restart, follow the delivery for 6 s, log state.
 *
 *   node .test-artifacts/watch-scenarios.cjs <kind> [seed] [--verbose]
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const kind = process.argv[2] ?? "corner";
const seed = Number(process.argv[3] ?? 1234);
const verbose = process.argv.includes("--verbose");
const L = CONFIG.pitch.length / 2, W = CONFIG.pitch.width / 2;

const engine = new MatchEngine(headlessEngineCanvas(), {
  seed, headless: true, spectator: true, debugAI: false,
});

// team 0 attacks +X in half 1; team 1 attacks -X in half 1.
const spots: Record<string, { pos: [number, number]; team: number }> = {
  corner: { pos: [L - 0.25, W - 0.25], team: 0 },
  corner_near: { pos: [L - 0.25, -(W - 0.25)], team: 0 },
  corner_blue: { pos: [-L + 0.25, W - 0.25], team: 1 },
  throw_in: { pos: [6, W - 0.25], team: 0 },
  throw_in_deep: { pos: [18.6, W - 0.25], team: 1 },
  throw_in_own: { pos: [-17, W - 0.25], team: 0 },
  free_kick: { pos: [12, 6], team: 0 },
  free_kick_blue: { pos: [-12, 6], team: 1 },
  free_kick_far: { pos: [-5, 15], team: 0 },
  penalty: { pos: [L - CONFIG.pitch.penaltySpotDist, 0], team: 0 },
  penalty_blue: { pos: [-L + CONFIG.pitch.penaltySpotDist, 0], team: 1 },
  goal_kick: { pos: [-L + 2, 0], team: 0 },
};

const cfg = spots[kind];
if (!cfg) { console.error(`unknown kind ${kind}; one of ${Object.keys(spots).join(", ")}`); process.exit(1); }

engine.rules.phase = "INPLAY";
engine.rules.pendingRestart = null;
engine.rules.time = 20;
engine.ball.release();
engine.ball.pos.set(cfg.pos[0], CONFIG.ball.radius, cfg.pos[1]);
engine.ball.vel.set(0, 0, 0);
engine.ball.lastTouch = null; engine.ball.lastTouchTeam = null;
engine.restartAutoT = 0;
engine.rules.startSetup(kind.startsWith("corner") ? "corner" : kind.replace(/_(blue|near|deep|own|far)$/, ""), cfg.pos, cfg.team);

const gd = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const f = (v: number) => v.toFixed(2);

let liveFrame = -1, closedFrame = -1, traced = 0;
let maxOutside = 0, maxSpeed = 0, minSpeedAfterKick = 999;
const trail: string[] = [];
let taker = -1;
let prevRestartId = -1;
let lastStartedKey = "";
const restartLog: string[] = [];
let firstTouch: string | null = null;
let touches: string[] = [];

console.log(`=== ${kind} · seed ${seed} · team ${cfg.team} @ (${f(cfg.pos[0])}, ${f(cfg.pos[1])}) ===`);

for (let frame = 0; frame < 60 * 26; frame++) {
  engine.step(1 / 60);
  const pr = engine.rules.pendingRestart;
  const b = engine.ball;
  const t = engine.players.find((p) => p.restartTaker);

  if (pr && pr.id !== prevRestartId) {
    prevRestartId = pr.id;
    restartLog.push(`${f(engine.clock)}s restart#${pr.id} ${pr.kind} team=${pr.team} pos=(${f(pr.pos[0])},${f(pr.pos[1])}) phase=${engine.rules.phase} taker=${t ? "#" + t.idx : "NONE"} placedId=${engine.placedRestartId} startedId=${engine.restartStartedId}`);
  }
  if (pr && engine.rules.live) {
    if (engine.restartWaitReason) restartLog.push(`${f(engine.clock)}s wait: ${engine.restartWaitReason}`);
    const startedKey = `${pr.id}:${engine.restartStartedId}:${t?.pendingKick?.action}`;
    if (pr.id === engine.restartStartedId && startedKey !== lastStartedKey) {
      lastStartedKey = startedKey;
      restartLog.push(`${f(engine.clock)}s started #${pr.id} by #${t?.idx} action=${t?.pendingKick?.action}`);
    }
  }
  if (!pr && liveFrame < 0 && restartLog.length) {
    // nothing: restart was closed before going live
  }
  if (liveFrame < 0 && restartLog.length) liveFrame = frame;

  if (liveFrame >= 0) {
    if (!pr && closedFrame < 0) {
      closedFrame = frame;
      console.log(`\n[closed] ${f((frame - liveFrame) / 60)}s live; ball=(${f(b.pos.x)},${f(b.pos.y)},${f(b.pos.z)}) v=${f(b.speed)} owner=${b.possessedBy}`);
    }
    if (pr && pr.id === prevRestartId) taker = t?.idx ?? taker;
    if (frame % 6 === 0 && trail.length < 120) {
      trail.push(`${f(engine.clock)}s (${f(b.pos.x)},${f(b.pos.y)},${f(b.pos.z)}) v=${f(b.speed)} ${b.possessedBy !== null ? "own#" + b.possessedBy : ""} ${pr ? "R" + pr.id + pr.kind.slice(0, 3) : "PLAY"} ${engine.rules.phase}`);
    }
    maxSpeed = Math.max(maxSpeed, b.speed);
    maxOutside = Math.max(maxOutside, Math.abs(b.pos.x) - L, Math.abs(b.pos.z) - W);
    // track touches: owner changes
    const tag = b.possessedBy !== null ? `#${b.possessedBy}` : null;
    if (tag && touches[touches.length - 1] !== tag) { touches.push(tag); if (!firstTouch) firstTouch = tag; }
  }
  if (closedFrame >= 0 && frame > closedFrame + 60 * 6) break;
}

const atLive = restartLog.find((l) => l.includes("placedId")) ? null : null;
console.log(`\nrestart log:`);
for (const l of restartLog.slice(0, 40)) console.log("  " + l);
console.log(`\nlive frame ${liveFrame}, closed frame ${closedFrame}, ball max speed ${f(maxSpeed)}, max outside pitch ${f(maxOutside)}`);
console.log(`touches after: ${touches.slice(0, 12).join(" → ")}`);
console.log(`trail:`);
for (const l of trail.slice(0, 60)) console.log("  " + l);
const outEvents = engine.rules.events.filter((e) => ["THROW_IN", "CORNER", "GOAL_KICK", "FREE_KICK", "PENALTY", "GOAL", "SAVE"].includes(e.type));
console.log(`\nevents: ${outEvents.map((e) => `${e.t.toFixed(1)}:${e.type}`).join(" | ")}`);
if (verbose) {
  console.log("final positions:");
  for (const p of engine.players) console.log(`  #${p.idx} t${p.team} ${p.role} (${f(p.pos.x)}, ${f(p.pos.z)}) v=${f(p.speed)} anim=${p.anim.actionId ?? "-"}`);
}
engine.dispose();
