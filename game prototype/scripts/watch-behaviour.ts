/**
 * Behaviour watcher: runs a match and measures dribbling, passing, tackling,
 * sliding and goalkeeper behaviour directly from engine state.
 *
 *   node .test-artifacts/watch-behaviour.cjs [seed] [seconds]
 */
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";

const seed = Number(process.argv[2] ?? 1234);
const seconds = Number(process.argv[3] ?? 240);
const e = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });

// ---- tackle tracking -------------------------------------------------------
let tackles = 0, slideTackles = 0, standTackles = 0;
const outcomes = new Map<string, number>();
const slideDurations: number[] = [];
const slideStart = new Map<number, number>();
let slideThroughBall = 0;
let slideBallSpeedMax = 0;

// ---- pass tracking ---------------------------------------------------------
let passesSeen = 0;
const passOutcome = { toNamed: 0, toTeammate: 0, toOpponent: 0, loose: 0, outOfPlay: 0, unresolved: 0 };
let pending: { team: number; to: number; t: number; from: number; action: string } | null = null;

// ---- dribble tracking ------------------------------------------------------
let carrierFrames = 0, carrierStuck = 0, carrierFast = 0, maxCarrierSpeed = 0;
let dribbleTouchCount = 0;

// ---- keeper tracking -------------------------------------------------------
const gkHold = new Map<number, number>();
let gkHoldMax = 0, gkLongHolds = 0, gkFrames = 0;
const gkActionCounts = new Map<string, number>();
let gkOwnGoalIncidents = 0;

// ---- general ---------------------------------------------------------------
const animCounts = new Map<string, number>();
let selfPassCount = 0;

for (let frame = 0; frame < 60 * seconds; frame++) {
  const beforeEvents = e.rules.events.length;
  const beforePassLog = e.passLog.length;
  e.step(1 / 60);
  const b = e.ball;
  const pr = e.rules.pendingRestart;
  const live = e.rules.live && !pr;

  for (const ev of e.rules.events.slice(beforeEvents)) {
    if (ev.type === "TACKLE") {
      const m = ev.detail.match(/tackle_(stand|slide)/);
      if (m && ev.detail.includes("missed") || m && ev.detail.includes("wins")) {
        // counted below from actions, keep event tally separately
      }
      const kind = ev.detail.includes("wins tackle") ? "won"
        : ev.detail.includes("missed") ? "missed"
          : ev.detail.includes("spills") ? "spilled"
            : ev.detail.includes("Bad challenge") ? "bad" : "other";
      outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
    }
  }

  // ---- pass resolution: the previous pass's outcome at the moment a new pass starts
  if (e.passLog.length > beforePassLog) {
    const last = e.passLog[e.passLog.length - 1];
    if (pending) {
      if (e.ball.possessedBy !== null) {
        const p = e.players[e.ball.possessedBy];
        if (p.idx === pending.to) passOutcome.toNamed++;
        else if (p.team === pending.team) passOutcome.toTeammate++;
        else passOutcome.toOpponent++;
      } else passOutcome.loose++;
    }
    if (last.passer === last.receiver) selfPassCount++;
    passesSeen++;
    pending = { team: e.players[last.passer].team, to: last.receiver, t: last.t, from: last.passer, action: last.action };
  }
  // A pass that ends in a restart / dead ball is unresolved; count when the ball goes out.
  if (pending && (pr || !live)) {
    if (pr) passOutcome.outOfPlay++;
    else passOutcome.unresolved++;
    pending = null;
  }

  if (!live) {
    for (const p of e.players) if (p.anim.actionId) animCounts.set(p.anim.actionId, (animCounts.get(p.anim.actionId) ?? 0) + 1);
    continue;
  }

  // ---- dribbling -----------------------------------------------------------
  const owner = b.possessedBy;
  if (owner !== null) {
    const o = e.players[owner];
    if (o.role !== "GK") {
      carrierFrames++;
      maxCarrierSpeed = Math.max(maxCarrierSpeed, o.speed);
      if (o.desiredSpeed > 2 && o.speed < 0.2) carrierStuck++;
      if (o.speed > 5.5) carrierFast++;
    } else {
      gkFrames++;
      const h = (gkHold.get(o.idx) ?? 0) + 1 / 60;
      gkHold.set(o.idx, h);
      gkHoldMax = Math.max(gkHoldMax, h);
      if (h > CONFIG.ai.gkHoldLimit + 0.6) { gkLongHolds++; gkHold.set(o.idx, 0); }
      const own = e.ai.ownGoal(o.team, e.rules.half);
      if (Math.abs(b.pos.x - own.x) < 1.5 && Math.abs(b.pos.z) < 2) gkOwnGoalIncidents++;
      if (o.anim.actionId) gkActionCounts.set(o.anim.actionId, (gkActionCounts.get(o.anim.actionId) ?? 0) + 1);
    }
  } else {
    gkHold.clear();
  }

  // ---- slides --------------------------------------------------------------
  for (const p of e.players) {
    if (p.anim.actionId) animCounts.set(p.anim.actionId, (animCounts.get(p.anim.actionId) ?? 0) + 1);
    if (p.anim.actionId === "dribble_touch") dribbleTouchCount++;
    const inSlide = p.anim.actionId === "tackle_slide";
    if (inSlide && !slideStart.has(p.idx)) slideStart.set(p.idx, e.clock);
    if (!inSlide && slideStart.has(p.idx)) {
      slideDurations.push(e.clock - slideStart.get(p.idx)!);
      slideStart.delete(p.idx);
    }
    if (p.anim.actionId === "tackle_slide") {
      if (b.possessedBy === null && Math.hypot(p.pos.x - b.pos.x, p.pos.z - b.pos.z) < 0.5 && b.speed > 8) slideThroughBall++;
      slideBallSpeedMax = Math.max(slideBallSpeedMax, b.speed);
    }
  }
}

const live = e.rules.live;
console.log(`=== seed ${seed} · ${e.rules.phase} ${e.rules.score.join(":")} · ${e.clock.toFixed(0)}s ===`);
console.log(`tackle events: ${JSON.stringify(Object.fromEntries(outcomes))}`);
console.log(`slide animations finished: ${slideDurations.length}, max duration ${Math.max(0, ...slideDurations).toFixed(2)}s, avg ${(slideDurations.reduce((a, c) => a + c, 0) / Math.max(1, slideDurations.length)).toFixed(2)}s`);
console.log(`slide-through-ball frames ${slideThroughBall}, max ball speed near slide ${slideBallSpeedMax.toFixed(1)}`);
console.log(`passes: ${passesSeen} ${JSON.stringify(passOutcome)} selfPass=${selfPassCount}`);
console.log(`carrier frames ${carrierFrames}, stuck(desired>2, speed<0.2) ${carrierStuck} (${(carrierStuck / Math.max(1, carrierFrames) * 100).toFixed(1)}%), fast>5.5 ${carrierFast}, maxSpeed ${maxCarrierSpeed.toFixed(2)}`);
console.log(`dribble_touch frames ${dribbleTouchCount}`);
console.log(`gk frames ${gkFrames}, max hold ${gkHoldMax.toFixed(1)}s, holds>limit+0.6 ${gkLongHolds}, ownGoalMouthFrames ${gkOwnGoalIncidents}`);
console.log(`gk clips: ${JSON.stringify(Object.fromEntries(gkActionCounts))}`);
console.log(`actions used: ${JSON.stringify(Object.fromEntries([...animCounts].sort((a, b) => b[1] - a[1]).slice(0, 16)))}`);
console.log(`tacticalStats: ${JSON.stringify(e.tacticalStats)}`);
console.log(`events: fouls ${e.rules.events.filter((x) => x.type === "FOUL").length}, saves ${e.rules.events.filter((x) => x.type === "SAVE").length}, goals ${e.rules.events.filter((x) => x.type === "GOAL").length}, cards ${e.rules.events.filter((x) => x.type === "YELLOW_CARD" || x.type === "BLUE_CARD").length}`);
e.dispose();
