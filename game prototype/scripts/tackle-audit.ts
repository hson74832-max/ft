/**
 * Tackle audit: every committed challenge, its geometry at the wind-up and at the
 * contact frame, and what came of it. Run over several matches.
 *
 *   node .test-artifacts/tackle-audit.cjs [seed ...]
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const seeds = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
if (!seeds.length) seeds.push(1234, 777, 42, 2026, 99);

interface Attempt {
  seed: number; t: number; idx: number; team: number; action: string; role: string;
  startBallDist: number; startCarrierDist: number; carrierSpeed: number; ownSpeed: number;
  contactBallDist?: number; contactCarrierDist?: number; contactCarrierSpeed?: number;
  outcome?: string; score?: number; carrierMoved?: number; inBox?: boolean;
}

const attempts: Attempt[] = [];
const foulReasons: string[] = [];
let stalled = 0;

for (const seed of seeds) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
  const seen = new Set<object>();
  const seenEv = new Set<object>();
  const live = new Map<number, Attempt>();
  for (let frame = 0; frame < 60 * 900; frame++) {
    engine.step(1 / 60);
    if (engine.rules.phase === "FULLTIME") break;
    for (const ev of engine.rules.events) {
      if (seenEv.has(ev)) continue;
      seenEv.add(ev);
      if (ev.type === "FOUL") foulReasons.push(ev.detail);
    }
    for (const rec of engine.actionLog) {
      if (seen.has(rec)) continue;
      seen.add(rec);
      if (!rec.action.startsWith("tackle_")) continue;
      const p = engine.players[rec.player];
      const carrier = engine.ball.possessedBy !== null ? engine.players[engine.ball.possessedBy] : null;
      const a: Attempt = {
        seed, t: engine.clock, idx: p.idx, team: p.team, action: rec.action, role: p.role,
        startBallDist: Math.hypot(p.pos.x - engine.ball.pos.x, p.pos.z - engine.ball.pos.z),
        startCarrierDist: carrier ? Math.hypot(p.pos.x - carrier.pos.x, p.pos.z - carrier.pos.z) : Infinity,
        carrierSpeed: carrier?.speed ?? 0, ownSpeed: p.speed,
        inBox: Math.abs(p.pos.z) < 6.2 && Math.abs(p.pos.x) > 18 - 5.5,
      };
      live.set(p.idx, a);
      attempts.push(a);
    }
    for (const [idx, a] of live) {
      const p = engine.players[idx];
      if (!p.anim.contactFired) continue;
      const carrier = engine.ball.possessedBy !== null ? engine.players[engine.ball.possessedBy] : null;
      a.contactBallDist = Math.hypot(p.pos.x - engine.ball.pos.x, p.pos.z - engine.ball.pos.z);
      a.contactCarrierDist = carrier ? Math.hypot(p.pos.x - carrier.pos.x, p.pos.z - carrier.pos.z) : Infinity;
      a.contactCarrierSpeed = carrier?.speed ?? 0;
      const m = /TACKLE (\w+) · q=([\d.]+)/.exec(p.decisionReason ?? "");
      a.outcome = m ? m[1].toLowerCase() : "?";
      a.score = m ? Number(m[2]) : undefined;
      a.carrierMoved = a.startBallDist - (a.contactBallDist ?? a.startBallDist);
      live.delete(idx);
    }
  }
  stalled += 0;
  console.log(`seed ${seed}: tackles ${attempts.filter((a) => a.seed === seed).length} · stats ${JSON.stringify(engine.tacticalStats)}`);
  engine.dispose();
}

const done = attempts.filter((a) => a.outcome);
const by = (k: string) => done.filter((a) => a.outcome === k).length;
console.log(`\n=== ${done.length} resolved tackles over ${seeds.length} matches ===`);
console.log(`outcomes:`, { clean: by("clean"), spill: by("spill"), miss: by("miss"), foul: by("foul"), unknown: by("?") });
const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2);
for (const k of ["clean", "spill", "miss", "foul"]) {
  const list = done.filter((a) => a.outcome === k);
  if (!list.length) continue;
  console.log(`  ${k.padEnd(5)} n=${String(list.length).padStart(2)} startBall ${avg(list.map((a) => a.startBallDist))}m → contactBall ${avg(list.map((a) => a.contactBallDist!))}m · reach ${CONFIG.tackle.standReach}/${CONFIG.tackle.slideReach} · startCarrier ${avg(list.map((a) => a.startCarrierDist))}m · carrier moved ${avg(list.map((a) => a.carrierMoved!))}m · carrierSpeed ${avg(list.map((a) => a.contactCarrierSpeed!))} m/s · ownSpeed ${avg(list.map((a) => a.ownSpeed))}`);
}
const slides = done.filter((a) => a.action === "tackle_slide");
console.log(`slides ${slides.length}: ${["clean", "spill", "miss", "foul"].map((k) => `${k} ${slides.filter((a) => a.outcome === k).length}`).join(", ")}`);
const stands = done.filter((a) => a.action === "tackle_stand");
console.log(`standing ${stands.length}: ${["clean", "spill", "miss", "foul"].map((k) => `${k} ${stands.filter((a) => a.outcome === k).length}`).join(", ")}`);
console.log(`far (start ball dist > reach): ${done.filter((a) => a.startBallDist > CONFIG.tackle.slideReach).length}/${done.length}`);
console.log(`stalled open-play frames: ${stalled}`);
console.log(`\nfoul reasons (${foulReasons.length}):`);
const buckets = new Map<string, number>();
for (const r of foulReasons) {
  const why = /· (protected|mistimed contact)/.exec(r)?.[1]
    ?? (Number(/-?[\d.]+ · front (-?[\d.]+)/.exec(r)?.[1] ?? 0) < -0.35 ? "blindside" : "")
    ?? "";
  const lateR = Number(/lateR ([\d.]+)/.exec(r)?.[1] ?? 0);
  const q = Number(/q=([\d.]+)/.exec(r)?.[1] ?? 1);
  const key = why || (lateR > 0.45 ? "late" : q < 0.18 ? "low quality" : "ball out of reach/heavy");
  buckets.set(key, (buckets.get(key) ?? 0) + 1);
}
console.log(Object.fromEntries(buckets));
for (const r of foulReasons.slice(0, 8)) console.log("  " + r);
