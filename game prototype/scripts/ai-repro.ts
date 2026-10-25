// Deterministic headless reproduction of AI failures using the REAL MatchEngine.
// Usage:  node /tmp/ai-repro.cjs [seed] [seconds] [--trace]
// Same seed ⇒ same match. Measures the reported symptoms instead of guessing.

import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import

const args = process.argv.slice(2);
const seed = Number(args.find((a) => /^\d+$/.test(a)) ?? 1234);
const seconds = Number(args.filter((a) => /^\d+$/.test(a))[1] ?? 60);
const trace = args.includes("--trace");

async function gkTest() {
  const { MatchEngine } = await import("../src/game/engine");
  const { keeperPositionTarget } = await import("../src/game/ai");
  const THREE = await import("three");
  const quiet = console.log;
  console.log = () => {}; console.groupCollapsed = () => {}; console.table = () => {}; console.info = () => {}; console.warn = () => {}; console.groupEnd = () => {};
  const results: { dist: number; z: number; speed: number; outcome: string }[] = [];
  for (const dist of [8, 12, 16, 20, 24]) {
    for (const z of [-1.3, -0.7, 0, 0.7, 1.3]) {
      for (const [speed, loft] of [[18, 0.12], [25, 0.1], [25, 0.2]] as const) {
        const engine = new MatchEngine(headlessEngineCanvas(), { seed: 1000 + dist * 97 + Math.round(z * 10) * 13 + speed * 7 + Math.round(loft * 100), headless: true, spectator: true, debugAI: true });
        engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
        const keeper = engine.players.find((p) => p.team === 0 && p.role === "GK")!;
        const goal = engine.ai.ownGoal(0, engine.rules.half);
        const origin = new THREE.Vector3(goal.x - Math.sign(goal.x) * dist, 0.11, z * 0.3);
        const target = new THREE.Vector3(goal.x, 0, z);
        // Start the keeper at the live angle/near-post position rather than the
        // old hard-coded 0.6 m off the line. This measures the positioning model
        // the match actually uses before a shot is struck.
        const position = keeperPositionTarget(origin, goal, engine.ai.attackSign(0, engine.rules.half));
        keeper.pos.copy(position.target);
        keeper.moveTarget.copy(position.target);
        keeper.vel.set(0, 0, 0);
        keeper.facing = goal.x < 0 ? 0 : Math.PI;
        // Clear everyone else away from the shot.
        for (const p of engine.players) if (p !== keeper) { p.pos.set(-goal.x * 0.9, 0, p.idx % 2 ? 11 : -11); p.vel.set(0, 0, 0); }
        engine.ball.release();
        engine.ball.pos.copy(origin);
        engine.ball.lastTouch = 9; engine.ball.lastTouchTeam = 1;
        engine.ball.kick(target.clone().sub(origin).setY(0).normalize(), speed, loft);
        let outcome = "wide/stopped";
        for (let f = 0; f < 180; f++) {
          engine.step(1 / 60);
          if (engine.rules.phase === "GOAL") { outcome = "GOAL"; break; }
          if (engine.aiEventLog.some((e) => e.includes("GK CATCH"))) { outcome = "CATCH"; break; }
          if (engine.aiEventLog.some((e) => e.includes("GK PARRY"))) { outcome = "PARRY"; break; }
          if (engine.rules.pendingRestart) { outcome = "out"; break; }
        }
        results.push({ dist, z, speed: loft > 0.1 ? speed + 0.5 : speed, outcome });
        if (process.env.GKCASE === `${dist},${z},${speed},${loft}`) {
          quiet(`\n--- case ${process.env.GKCASE} → ${outcome} ---\n` + engine.aiEventLog.slice().reverse().join("\n"));
          quiet(`keeper at z=${keeper.pos.z.toFixed(2)} x=${keeper.pos.x.toFixed(2)} reason="${keeper.decisionReason}"`);
        }
      }
    }
  }
  console.log = quiet;
  console.log("\n=== GK SHOT GRID (real engine + keeper AI) ===");
  for (const dist of [8, 12, 16, 20, 24]) {
    const row = results.filter((r) => r.dist === dist);
    const saves = row.filter((r) => r.outcome === "CATCH" || r.outcome === "PARRY").length;
    const goals = row.filter((r) => r.outcome === "GOAL").length;
    console.log(`${String(dist).padStart(2)}m: saves ${saves}/${row.length} goals ${goals}  ` + row.map((r) => `${r.z >= 0 ? "+" : ""}${r.z}@${r.speed > 25 ? "25hi" : r.speed}:${r.outcome[0]}`).join(" "));
  }
  const all = results.length, sv = results.filter((r) => r.outcome === "CATCH" || r.outcome === "PARRY").length;
  console.log(`overall save rate: ${(100 * sv / all).toFixed(0)}% (${sv}/${all})`);
}

async function main() {
  if (process.argv.includes("--gk")) return gkTest();
  const { MatchEngine } = await import("../src/game/engine");
  const engine = new MatchEngine(headlessEngineCanvas(), {
    seed, headless: true, spectator: true, debugAI: true,
  });
  // Silence per-second console tables; we aggregate instead.
  const realLog = console.log, realGroup = console.groupCollapsed, realTable = console.table;
  if (!trace) { console.log = () => {}; console.groupCollapsed = () => {}; console.table = () => {}; console.info = () => {}; console.warn = () => {}; console.groupEnd = () => {}; }

  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  const m = {
    liveFrames: 0, aiRowsLive: 0, aiThinkCalled: 0,
    carrierFrames: 0, carrierStallFrames: 0, longestCarrierStall: 0, curStall: 0,
    offBallLive: 0, offBallIdle: 0,
    possessionChanges: 0, kicksReleased: 0, kicksCancelled: 0,
    shots: 0, saves: 0, goals: 0, longShots: 0, longShotGoals: 0,
    tacklesWon: 0, tacklesMissed: 0, carrierInRangeFrames: 0, passSpeeds: [] as number[],
    restartHoldFrames: 0, branchCounts: {} as Record<string, number>,
    startResults: {} as Record<string, number>,
  };
  let lastOwner: number | null = engine.ball.possessedBy;
  let lastEventCount = 0;
  let lastScore = [0, 0];
  let pendingShot: { fromDist: number; t: number } | null = null;

  for (let f = 0; f < frames; f++) {
    engine.step(dt);
    const live = engine.rules.live;
    if (!live) continue;
    m.liveFrames++;
    for (const row of engine.aiTrace.values()) {
      m.branchCounts[row.branch] = (m.branchCounts[row.branch] ?? 0) + 1;
      if (row.branch === "restartHold") m.restartHoldFrames++;
      if (row.branch === "ai") {
        m.aiRowsLive++;
        if (row.thinkCalled) m.aiThinkCalled++;
        const key = row.startActionResult.split(":")[0] + (row.startActionResult.includes(":") ? ":" + row.startActionResult.split(":")[1].split("(")[0] : "");
        m.startResults[key] = (m.startResults[key] ?? 0) + 1;
      }
      const player = engine.players[row.idx];
      // Keeper hold (1.25 s distribution decision) is deliberate, not a carrier stall.
      if (row.hasBall && player.role !== "GK") {
        m.carrierFrames++;
        const g = engine.ai.goalPos(player.team, engine.rules.half);
        if (Math.hypot(g.x - player.pos.x, g.z - player.pos.z) < 14) m.carrierInRangeFrames++;
        // Stall = carrier not moving, no action clip playing.
        if (player.speed < 0.4 && !player.anim.busy) { m.carrierStallFrames++; m.curStall++; }
        else m.curStall = 0;
        m.longestCarrierStall = Math.max(m.longestCarrierStall, m.curStall);
      } else if (player.role !== "GK" && engine.ball.possessedBy !== null && row.branch === "ai") {
        m.offBallLive++;
        if (player.speed < 0.3 && row.desiredSpeed < 0.3) m.offBallIdle++;
      }
    }
    if (engine.ball.possessedBy !== null && engine.ball.possessedBy !== lastOwner) m.possessionChanges++;
    if (engine.ball.possessedBy !== null) lastOwner = engine.ball.possessedBy;

    // Event stream from the engine's ?debug=ai log (newest first).
    const fresh = engine.aiEventTotal - lastEventCount;
    const newEvents = engine.aiEventLog.slice(0, Math.max(0, Math.min(fresh, engine.aiEventLog.length)));
    lastEventCount = engine.aiEventTotal;
    for (const e of newEvents) {
      if (e.includes("KICK released")) {
        m.kicksReleased++;
        const sp = /· ([\d.]+) m\/s/.exec(e);
        if (sp && /pass_/.test(e)) m.passSpeeds.push(Number(sp[1]));
        if (/shoot_/.test(e)) {
          m.shots++;
          const kickerIdx = Number(/#(\d+)/.exec(e)?.[1] ?? -1);
          const kicker = engine.players[kickerIdx];
          if (kicker) {
            const goal = engine.ai.goalPos(kicker.team, engine.rules.half);
            const dist = Math.hypot(goal.x - kicker.pos.x, goal.z - kicker.pos.z);
            pendingShot = { fromDist: dist, t: engine.clock };
            const k = engine.players.find((q) => q.team !== kicker.team && q.role === "GK")!;
            if (trace || process.env.SHOTLOG) realLog(`SHOT #${kickerIdx} from ${dist.toFixed(1)}m z=${kicker.pos.z.toFixed(1)} · keeper at x=${k.pos.x.toFixed(1)} z=${k.pos.z.toFixed(1)} (${Math.abs(k.pos.x - goal.x).toFixed(1)}m off line) busy=${k.anim.actionId ?? "-"} reason="${k.decisionReason}"`);
            if (dist > 14) m.longShots++;
          }
        }
      }
      if (e.includes("KICK CANCELLED")) m.kicksCancelled++;
      if (e.includes("TACKLE WON")) m.tacklesWon++;
      if (e.includes("TACKLE MISSED")) m.tacklesMissed++;
      if (e.includes("GK CATCH") || e.includes("GK PARRY")) m.saves++;
    }
    const score = engine.rules.score;
    if (score[0] + score[1] > lastScore[0] + lastScore[1]) {
      m.goals++;
      if (pendingShot && pendingShot.fromDist > 14 && engine.clock - pendingShot.t < 3) m.longShotGoals++;
      pendingShot = null;
    }
    lastScore = [...score];
    if (engine.rules.phase === "FULLTIME") break;
  }
  console.log = realLog; console.groupCollapsed = realGroup; console.table = realTable;

  const pct = (a: number, b: number) => (b ? (100 * a / b).toFixed(1) + "%" : "n/a");
  console.log(`\n=== AI REPRO seed=${seed} sim=${seconds}s live=${(m.liveFrames * dt).toFixed(1)}s ===`);
  console.log(`think() called on AI branch:      ${pct(m.aiThinkCalled, m.aiRowsLive)} of ${m.aiRowsLive} rows`);
  console.log(`branch distribution (live):       ${JSON.stringify(m.branchCounts)}`);
  console.log(`startAction results (AI branch):  ${JSON.stringify(m.startResults)}`);
  console.log(`carrier stall (no move, no clip): ${pct(m.carrierStallFrames, m.carrierFrames)} · longest ${(m.longestCarrierStall * dt).toFixed(2)}s`);
  console.log(`off-ball idle while ball owned:   ${pct(m.offBallIdle, m.offBallLive)}`);
  console.log(`possession changes:               ${m.possessionChanges}`);
  console.log(`kicks released / cancelled:       ${m.kicksReleased} / ${m.kicksCancelled}`);
  const ps = m.passSpeeds;
  console.log(`pass launch speed (avg/min/max):  ${ps.length ? (ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(1) : "-"} / ${ps.length ? Math.min(...ps).toFixed(1) : "-"} / ${ps.length ? Math.max(...ps).toFixed(1) : "-"} m/s`);
  console.log(`tackles won / missed:             ${m.tacklesWon} / ${m.tacklesMissed}`);
  console.log(`carrier frames within 14m of goal:${pct(m.carrierInRangeFrames, m.carrierFrames)}`);
  console.log(`shots / saves / goals:            ${m.shots} / ${m.saves} / ${m.goals}`);
  console.log(`long shots (>14m) / their goals:  ${m.longShots} / ${m.longShotGoals}`);
  console.log(`restartHold rows:                 ${m.restartHoldFrames}`);
  console.log(`out-of-play restarts / open kicks:${engine.outRestartCount} / ${engine.openPlayKickCount}`);
  console.log(`final score:                      ${engine.rules.score.join(" - ")} · phase ${engine.rules.phase}`);
  if (trace) console.log("\nRecent AI events:\n" + engine.aiEventLog.slice(0, 25).join("\n"));
}
main().catch((e) => { console.error(e); process.exit(1); });
