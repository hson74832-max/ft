import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import assert from "node:assert/strict";
import { MatchEngine } from "../src/game/engine";
import { CONFIG } from "../src/game/config";
import { attackDirection, groundDistance } from "../src/game/tactics";

function simulate(seed: number) {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: false });
  let samples = 0, covered = 0, plansWithCover = 0, runFrames = 0, planSamples = 0, inRange = 0;
  // Off-ball involvement: are players actually moving, and how many separate runs do
  // they commit to? A static web keeps both numbers near zero.
  let offBallFrames = 0, movingFrames = 0, runEpisodes = 0, matchSeconds = 0;
  const runStreak = new Map<number, number>();
  let lastPassTime = -1, releaseCount = 0, sameTeamPasses = 0, alignedPasses = 0, centralSquare = 0;
  const trace: (number | string)[][] = [];
  for (let frame = 0; frame < 60 * 420; frame++) {
    engine.step(1 / 60);
    const pass = engine.passLog[0];
    if (pass && pass.t !== lastPassTime) {
      lastPassTime = pass.t; releaseCount++;
      const p = engine.players[pass.passer], r = engine.players[pass.receiver];
      if (p.team === r.team && p.idx !== r.idx) sameTeamPasses++;
      if (pass.aimDot >= Math.cos(CONFIG.ai.passAimConeDegrees * Math.PI / 180)) alignedPasses++;
      if (Math.abs(pass.predicted[0] - p.pos.x) < 2 && Math.abs(pass.predicted[2]) < 4) centralSquare++;
      trace.push([Math.round(pass.t * 60), p.idx, r.idx, pass.action, ...pass.predicted.map((v) => +v.toFixed(4))]);
    }
    if (engine.rules.live && !engine.rules.pendingRestart && engine.ball.possessedBy !== null) {
      const carrier = engine.players[engine.ball.possessedBy];
      if (carrier.role !== "GK") {
        const sign = attackDirection(carrier.team, engine.rules.half);
        samples++;
        if (groundDistance(carrier.pos, engine.ai.goalPos(carrier.team, engine.rules.half)) <= CONFIG.tactics.edgeShotDistance) inRange++;
        if (engine.players.some((p) => p.team === carrier.team && p.role !== "GK" && p.idx !== carrier.idx
          && p.pos.x * sign < carrier.pos.x * sign - 1.5 && Math.abs(p.pos.z) <= 3.7)) covered++;
        const plan = engine.ai.tactics.current(carrier.team);
        if (plan && plan.carrier === carrier.idx && plan.half === engine.rules.half) {
          planSamples++;
          if ([...plan.assignments.values()].some((a) => a.job === "pivot" && Math.abs(a.target.z) <= CONFIG.tactics.pivotHalfWidth
            && a.target.x * sign < carrier.pos.x * sign - 2)) plansWithCover++;
        }
        if (engine.players.some((p) => p.team === carrier.team && p.supportJob === "runner"
          && p.moveTarget.x * sign > p.pos.x * sign + 1 && p.speed > 4)) runFrames++;
        for (const mate of engine.players) {
          if (mate.team !== carrier.team || mate.idx === carrier.idx || mate.role === "GK") continue;
          offBallFrames++;
          if (mate.speed > 1) movingFrames++;
          const running = mate.supportJob === "runner" && (mate.supportRun === "spin" || mate.supportRun === "drive") && mate.speed > 3.5;
          const streak = running ? (runStreak.get(mate.idx) ?? 0) + 1 : 0;
          if (streak === 15) runEpisodes++;   // a run must last 0.25 s to count
          runStreak.set(mate.idx, streak);
        }
      }
    }
    matchSeconds = engine.clock;
    if (engine.rules.phase === "FULLTIME") break;
  }
  const result = { seed, phase: engine.rules.phase, score: engine.rules.score.join(":"),
    ...engine.tacticalStats, outRestarts: engine.outRestartCount,
    actualCentralCoverPct: Math.round(covered / Math.max(1, samples) * 100),
    centralCoverPlanPct: Math.round(plansWithCover / Math.max(1, planSamples) * 100),
    activeRunPct: Math.round(runFrames / Math.max(1, samples) * 100),
    movingPct: Math.round(movingFrames / Math.max(1, offBallFrames) * 100),
    runsPerMinute: +(runEpisodes / Math.max(0.5, matchSeconds / 60)).toFixed(1),
    inShootingRangePct: Math.round(inRange / Math.max(1, samples) * 100),
    centralSquare, sameTeamPasses, alignedPasses, releaseCount };
  assert.equal(engine.rules.phase, "FULLTIME", `match ${seed} did not finish`);
  assert.equal(sameTeamPasses, releaseCount, "a pass targeted the wrong team");
  assert.equal(alignedPasses, releaseCount, "pass direction missed named receiver cone");
  assert(result.recycles > 0 && result.penetratingPasses > 0 && result.shots > 0, JSON.stringify(result));
  assert(result.actualCentralCoverPct > 45, `rest defense never established: ${JSON.stringify(result)}`);
  engine.dispose();
  return { result, trace };
}

const first = simulate(1234);
const replay = simulate(1234);
assert.deepEqual(first, replay, "same seed changed actual match outcomes or pass trajectories");
console.log(JSON.stringify(first.result));
const second = simulate(777);
console.log(JSON.stringify(second.result));
const third = simulate(42);
console.log(JSON.stringify(third.result));
assert.notDeepEqual(first.trace, second.trace, "different match seeds repeated the same attack states");
console.log("PASS full matches: named passes, recycling, runs, shots, central cover and deterministic replay");