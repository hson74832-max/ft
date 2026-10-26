import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { yawOfVector, yawDelta } from "../src/game/angles";
const seed = Number(process.argv[2] ?? 42);
const engine = new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true });
const dt = 1 / 60;
let previousAge = 99;
for (let f = 0; f < 240 / dt; f++) {
  engine.step(dt);
  const ball = engine.ball;
  if (ball.kickedBy !== null && ball.kickAge < previousAge && ball.possessedBy === null) {
    const entry = engine.actionLog[engine.actionLog.length - 1];
    const strike = entry && entry.player === ball.kickedBy
      && (entry.action.startsWith("pass_") || entry.action.startsWith("shoot_")
        || entry.action === "gk_punt" || entry.action === "gk_roll"
        || entry.action === "corner_kick" || entry.action === "throw_in");
    if (strike) {
      const kicker = engine.players[ball.kickedBy];
      const departure = yawOfVector({ x: ball.vel.x, z: ball.vel.z });
      const err = Math.abs(yawDelta(kicker.facing, departure)) * 180 / Math.PI;
      if (err > 70) console.log(`[${engine.clock.toFixed(2)}] #${kicker.idx} ${kicker.role} t${kicker.team} ${entry.action} err=${err.toFixed(0)}° facing=${(kicker.facing*180/Math.PI).toFixed(0)} dep=${(departure*180/Math.PI).toFixed(0)} busy=${kicker.anim.actionId} pending=${kicker.pendingKick?.action ?? "-"}`);
    }
  }
  previousAge = ball.kickAge;
  if (engine.rules.phase === "FULLTIME") break;
}
engine.dispose();
