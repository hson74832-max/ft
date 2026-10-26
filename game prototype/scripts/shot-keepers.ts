/**
 * Shot / keeper audit, driven by the engine's own contact-frame events.
 *
 *   node .test-artifacts/shot-keepers.cjs [seed ...] [--verbose]
 *
 * For every shot the ball is followed until it is dead, and the outcome is
 * attributed: goal, save (catch/parry/body block), blocked by an outfielder,
 * off target, or reclaimed. Also records the keeper's lateral gap at the strike
 * and where the shot crossed the goal plane, which is what tells us whether the
 * keeper was even in with a chance.
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";
import { keeperReachNow } from "../src/game/match/keeper";
import * as THREE from "three";

const seeds = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const verbose = process.argv.includes("--verbose");
if (!seeds.length) seeds.push(1234, 777, 42, 2026, 99);

const L = CONFIG.pitch.length / 2;
const HALFW = CONFIG.pitch.width / 2;

interface Shot {
  seed: number; t: number; idx: number; team: number; role: string; action: string;
  x: number; z: number; dist: number; facingErrDeg: number; speed: number; loftDeg: number;
  gkIdx: number; gkX: number; gkZ: number; gkAction: string | null;
  bodyErrAtWindupDeg: number; windupSpeed: number;
  gkLat: number; crossZ: number | null; crossH: number | null;
  outcome: string; gkActions: string[]; saveDetail: string;
  minGkBall: number; minGkBallT: number; gkAtMin: [number, number]; ballAtMin: [number, number, number];
  minMargin: number; minMarginT: number; gkTravel: number; gkSaveClipAt: string;
  aimZ: number; aimH: number; aimOnTarget: boolean; gkDiveDir: string;
}

const shots: Shot[] = [];

const bandOf = (d: number) => d < 6 ? "0-6m" : d < 9 ? "6-9m" : d < 12 ? "9-12m" : d < 15 ? "12-15m" : "15m+";

for (const seed of seeds) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
  let lastEvent = 0;
  let active: { shot: Shot; expired: number } | null = null;
  let rafGoal = false;
  let lastLog = 0;
  const windupErr = new Map<number, number>();
  const windupSpeed = new Map<number, number>();

  for (let frame = 0; frame < 60 * 900; frame++) {
    engine.step(1 / 60);
    if (engine.rules.phase === "FULLTIME") break;
    const t = engine.clock, ball = engine.ball;

    // Wind-up body angle for every new shot request (before the torso turns).
    for (; lastLog < engine.actionLog.length; lastLog++) {
      const rec = engine.actionLog[lastLog];
      if (!rec.action.startsWith("shoot_")) continue;
      const q = engine.players[rec.player];
      if (!q) continue;
      const g = engine.ai.goalPos(q.team, engine.rules.half);
      const want = Math.atan2(-(g.z - q.pos.z), g.x - q.pos.x);
      let dd = want - q.facing;
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      windupErr.set(q.idx, (dd * 180) / Math.PI);
      windupSpeed.set(q.idx, q.speed);
    }

    // --- engine events ------------------------------------------------------
    for (; lastEvent < engine.rules.events.length; lastEvent++) {
      const ev = engine.rules.events[lastEvent];
      if (ev.type === "POSSESSION" && ev.detail.includes("SHOOT") && !active) {
        // The shooter is the last shoot_* action recorded (contact frame just fired).
        const rec = [...engine.actionLog].reverse().find((r) => r.action.startsWith("shoot_"));
        const p = rec ? engine.players[rec.player] : null;
        if (!p) continue;
        const goal = engine.ai.goalPos(p.team, engine.rules.half);
        const dist = Math.hypot(goal.x - p.pos.x, goal.z - p.pos.z);
        const want = Math.atan2(-(goal.z - p.pos.z), goal.x - p.pos.x);
        let d = want - p.facing;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const gk = engine.players.find((q) => q.role === "GK" && q.team !== p.team);
        const shot: Shot = {
          seed, t, idx: p.idx, team: p.team, role: p.role, action: rec!.action,
          x: p.pos.x, z: p.pos.z, dist, facingErrDeg: (d * 180) / Math.PI,
          speed: ball.speed, loftDeg: (Math.atan2(ball.vel.y, Math.hypot(ball.vel.x, ball.vel.z)) * 180) / Math.PI,
          gkIdx: gk?.idx ?? -1, gkX: gk?.pos.x ?? 0, gkZ: gk?.pos.z ?? 0, gkAction: gk?.anim.actionId ?? null,
          bodyErrAtWindupDeg: NaN, windupSpeed: 0,
          gkLat: gk ? Math.abs(gk.pos.z) : 99,
          crossZ: null, crossH: null, outcome: "?", gkActions: [], saveDetail: "",
          minGkBall: Infinity, minGkBallT: -1, gkAtMin: [0, 0], ballAtMin: [0, 0, 0],
          minMargin: Infinity, minMarginT: -1, gkTravel: 0, gkSaveClipAt: "",
          aimZ: 0, aimH: 0, aimOnTarget: false, gkDiveDir: "-",
        };
        // Where the shot was aimed: extrapolate the strike velocity to the goal
        // plane, including gravity. Deflections by the keeper or a defender must
        // not decide whether the shot was on target.
        {
          const plane = engine.ai.attackSign(p.team, engine.rules.half) * L;
          const vxz = Math.hypot(ball.vel.x, ball.vel.z);
          const toPlane = Math.abs(plane - ball.pos.x);
          const tArrive = toPlane / Math.max(1e-3, vxz);
          shot.aimZ = ball.pos.z + ball.vel.z * tArrive;
          shot.aimH = ball.pos.y + ball.vel.y * tArrive - 0.5 * 9.81 * tArrive * tArrive;
          shot.aimOnTarget = Math.abs(shot.aimZ) < CONFIG.pitch.goalWidth / 2 && shot.aimH > 0 && shot.aimH < CONFIG.pitch.goalHeight;
          shot.gkDiveDir = shot.gkZ * shot.aimZ > 0 ? "same-side" : "far-side";
        }
        shot.bodyErrAtWindupDeg = windupErr.get(p.idx) ?? NaN;
        shot.windupSpeed = windupSpeed.get(p.idx) ?? 0;
        shots.push(shot);
        rafGoal = false;
        active = { shot, expired: 0 };
        if (verbose) console.log(`[${seed}] ${t.toFixed(2)}s shot by #${p.idx} ${p.role} d=${dist.toFixed(1)}m bodyErr=${shot.facingErrDeg.toFixed(0)}° v=${shot.speed.toFixed(1)} loft=${shot.loftDeg.toFixed(1)}° gkZ=${shot.gkZ.toFixed(2)}`);
      }
      if (ev.type === "GOAL" && active) { active.shot.outcome = "GOAL"; rafGoal = true; }
      if (ev.type === "SAVE" && active && active.shot.outcome === "?") {
        active.shot.outcome = "SAVE";
        active.shot.saveDetail = ev.detail;
      }
    }

    if (active) {
      const s = active.shot;
      const gk = engine.players[s.gkIdx];
      if (gk?.anim.actionId?.startsWith("gk_") && !s.gkActions.includes(gk.anim.actionId)) s.gkActions.push(gk.anim.actionId);
      // Goal-plane crossing (swept).
      const prev = ball.prevPos;
      for (const side of [1, -1]) {
        const plane = side * L;
        const wasIn = side > 0 ? prev.x <= plane : prev.x >= plane;
        const nowOut = side > 0 ? ball.pos.x > plane : ball.pos.x < plane;
        if (wasIn && nowOut && s.crossZ === null) {
          const f = (plane - prev.x) / (ball.pos.x - prev.x || 1e-6);
          s.crossZ = prev.z + (ball.pos.z - prev.z) * f;
          s.crossH = prev.y + (ball.pos.y - prev.y) * f;
        }
      }
      if (gk) {
        s.gkTravel = Math.max(s.gkTravel, Math.hypot(gk.pos.x - s.gkX, gk.pos.z - s.gkZ));
        const margin = Math.hypot(gk.pos.x - ball.pos.x, gk.pos.z - ball.pos.z) - keeperReachNow(gk, ball.pos.z);
        if (margin < s.minMargin) { s.minMargin = margin; s.minMarginT = t - s.t; s.gkSaveClipAt = `${gk.anim.actionId ?? "-"}@${gk.anim.actionT.toFixed(2)}`; }
        const dgb = Math.hypot(gk.pos.x - ball.pos.x, gk.pos.z - ball.pos.z);
        if (dgb < s.minGkBall) {
          s.minGkBall = dgb; s.minGkBallT = t - s.t;
          s.gkAtMin = [gk.pos.x, gk.pos.z]; s.ballAtMin = [ball.pos.x, ball.pos.y, ball.pos.z];
        }
      }
      active.expired += 1 / 60;
      const done = active.expired > 2.0 || ball.possessedBy !== null || engine.rules.pendingRestart !== null || rafGoal;
      if (done) {
        if (s.outcome === "?") {
          if (ball.possessedBy !== null) {
            const o = engine.players[ball.possessedBy];
            s.outcome = o.team === s.team ? "reclaimed" : "claimed";
          } else if (Math.abs(ball.pos.x) > L || Math.abs(ball.pos.z) > HALFW) s.outcome = "out";
          else s.outcome = "loose";
        }
        if (verbose) console.log(`     → ${s.outcome}${s.crossZ !== null ? ` crossZ=${s.crossZ.toFixed(2)} h=${s.crossH!.toFixed(2)}` : ""} gk=${s.gkActions.join("/") || "-"} ${s.saveDetail}`);
        active = null;
      }
    }
  }
  engine.dispose();
}

const pct = (a: number, b: number) => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;
console.log(`\n=== ${shots.length} shots over ${seeds.length} matches ===`);
const bands = new Map<string, Shot[]>();
for (const s of shots) { const k = bandOf(s.dist); (bands.get(k) ?? bands.set(k, []).get(k)!).push(s); }
for (const [k, list] of [...bands].sort()) {
  const c = (pred: (s: Shot) => boolean) => list.filter(pred).length;
  console.log(`  ${k.padEnd(7)} n=${String(list.length).padStart(3)} goals=${String(c((s) => s.outcome === "GOAL")).padStart(2)} saves=${String(c((s) => s.outcome === "SAVE")).padStart(2)} claimed=${c((s) => s.outcome === "claimed" || s.outcome === "reclaimed")} out=${c((s) => s.outcome === "out")} loose=${c((s) => s.outcome === "loose")}`);
}
const onTarget = shots.filter((s) => s.crossZ !== null && Math.abs(s.crossZ) < CONFIG.pitch.goalWidth / 2 && s.crossH! < CONFIG.pitch.goalHeight).length;
console.log(`on-target (crossed goal plane inside frame): ${onTarget}/${shots.length} → ${pct(shots.filter((s) => s.outcome === "GOAL").length, onTarget)} of on-target shots scored`);
const aimed = shots.filter((s) => s.aimOnTarget);
console.log(`aimed on target at strike: ${aimed.length}/${shots.length} → goals ${aimed.filter((s) => s.outcome === "GOAL").length}, saves ${aimed.filter((s) => s.outcome === "SAVE").length}, loose ${aimed.filter((s) => s.outcome === "loose" || s.outcome === "claimed" || s.outcome === "reclaimed").length} · keeper action ${aimed.filter((s) => s.gkActions.length).length}`);
for (const [k, list] of [...bands].sort()) {
  const a = list.filter((s) => s.aimOnTarget);
  if (a.length) console.log(`   aim-on-target ${k.padEnd(7)} n=${a.length} goals=${a.filter((s) => s.outcome === "GOAL").length} saves=${a.filter((s) => s.outcome === "SAVE").length}`);
}
for (const s of aimed) console.log(`   AIM ${String(s.seed).padStart(4)} ${s.t.toFixed(1)}s d=${s.dist.toFixed(1)}m aimZ=${s.aimZ.toFixed(2)} h=${s.aimH.toFixed(2)} ${s.outcome.padEnd(8)} gkZ0=${s.gkZ.toFixed(2)} ${s.gkDiveDir} gk=${s.gkActions.join("/") || "-"} minGap=${s.minGkBall.toFixed(2)} margin=${s.minMargin.toFixed(2)}`);
const details = new Map<string, number>();
for (const s of shots) if (s.outcome === "SAVE") {
  const key = s.saveDetail.replace(/#\d+/g, "#").replace(/[\d.]+ m\/s at [\d.]+m/, "…").replace(/gk_(dive_[LR]|parry|catch)/g, "gk_$1");
  details.set(key, (details.get(key) ?? 0) + 1);
}
console.log("save details:", Object.fromEntries(details));
console.log(`keeper action fired on ${shots.filter((s) => s.gkActions.length).length}/${shots.length} shots`);
const gkActions = new Map<string, number>();
for (const s of shots) for (const a of s.gkActions) gkActions.set(a, (gkActions.get(a) ?? 0) + 1);
console.log(`keeper actions during shots:`, Object.fromEntries(gkActions));
console.log(`keeper lateral gap at strike: avg ${(shots.reduce((a, s) => a + s.gkLat, 0) / Math.max(1, shots.length)).toFixed(2)}m`);
console.log(`shot speed avg ${(shots.reduce((a, s) => a + s.speed, 0) / Math.max(1, shots.length)).toFixed(1)} m/s · loft avg ${(shots.reduce((a, s) => a + s.loftDeg, 0) / Math.max(1, shots.length)).toFixed(1)}°`);
console.log(`body-error at contact >60°: ${shots.filter((s) => Math.abs(s.facingErrDeg) > 60).length}, >90°: ${shots.filter((s) => Math.abs(s.facingErrDeg) > 90).length}`);
const we = shots.filter((s) => Number.isFinite(s.bodyErrAtWindupDeg));
console.log(`body-error at wind-up: avg ${(we.reduce((a, s) => a + Math.abs(s.bodyErrAtWindupDeg), 0) / Math.max(1, we.length)).toFixed(0)}°, >60°: ${we.filter((s) => Math.abs(s.bodyErrAtWindupDeg) > 60).length}, >90°: ${we.filter((s) => Math.abs(s.bodyErrAtWindupDeg) > 90).length}, >120°: ${we.filter((s) => Math.abs(s.bodyErrAtWindupDeg) > 120).length} (of ${we.length})`);
console.log(`wind-up speed: stationary(<0.45 m/s) ${we.filter((s) => s.windupSpeed < 0.45).length}/${we.length}`);
console.log(`\nper-shot keeper geometry (min |gk-ball| during flight):`);
for (const s of shots) {
  console.log(`  ${String(s.seed).padStart(4)} ${s.t.toFixed(1).padStart(6)}s d=${s.dist.toFixed(1).padStart(5)}m ${s.outcome.padEnd(8)} minGkBall=${s.minGkBall.toFixed(2)}m @${s.minGkBallT.toFixed(2)}s gk=(${s.gkAtMin[0].toFixed(1)},${s.gkAtMin[1].toFixed(1)}) ball=(${s.ballAtMin[0].toFixed(1)},${s.ballAtMin[1].toFixed(1)},${s.ballAtMin[2].toFixed(1)}) gkZ0=${s.gkZ.toFixed(2)} crossZ=${s.crossZ?.toFixed(2) ?? "-"}`);
}
const saved = shots.filter((s) => s.outcome === "SAVE"), missed = shots.filter((s) => s.outcome === "GOAL");
const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2);
console.log(`min-gk-ball avg: saves ${avg(saved.map((s) => s.minGkBall))}m goals ${avg(missed.map((s) => s.minGkBall))}m`);
const tight = shots.filter((s) => s.minMargin < 0);
console.log(`shots that came within reach: ${tight.length}/${shots.length} · avg min margin ${avg(shots.map((s) => s.minMargin))}m · avg keeper travel ${avg(shots.map((s) => s.gkTravel))}m`);
for (const s of shots.filter((x) => x.dist > 11).slice(0, 14)) {
  console.log(`  d=${s.dist.toFixed(1)} ${s.outcome.padEnd(8)} margin=${s.minMargin.toFixed(2)}m @${s.minMarginT.toFixed(2)}s travel=${s.gkTravel.toFixed(2)}m clip=${s.gkSaveClipAt} gkZ0=${s.gkZ.toFixed(2)} cross=${s.crossZ?.toFixed(2) ?? "-"}`);
}
