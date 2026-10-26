import { kickoffRestartViolation } from "../src/game/restartRules";
// Installs the headless DOM shim on import; the engine builds scene resources.
import { headlessEngineCanvas } from "./harness";
import { MatchEngine } from "../src/game/engine";
import { isOffPitch } from "../src/game/match/referee";
import { restartStallCheck } from "../src/game/match/restarts";
import { CONFIG } from "../src/game/config";

function assert(name: string, actual: string | null, expected: string | null) {
  if (actual !== expected) {
    console.error(`FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${name}`);
  }
}

// First half: RED attacks +X, BLUE must be outside the circle in the +X half.
assert(
  "first-half opponents in own half allow kickoff",
  kickoffRestartViolation([{ x: 5, z: 0 }, { x: 8, z: -3 }], 1),
  null,
);
assert(
  "first-half opponent inside circle delays kickoff",
  kickoffRestartViolation([{ x: 1, z: 1 }], 1),
  "Waiting: opponents must be outside the centre circle",
);
assert(
  "first-half opponent in wrong half delays kickoff",
  kickoffRestartViolation([{ x: -6, z: 0 }], 1),
  "Waiting: opponents must be in their own half",
);

// Second half: BLUE attacks +X after ends swap, RED is in its own (-X) half.
assert(
  "second-half opponents in own half allow kickoff",
  kickoffRestartViolation([{ x: -5, z: 0 }, { x: -8, z: 3 }], -1),
  null,
);
assert(
  "second-half opponent in wrong half delays kickoff",
  kickoffRestartViolation([{ x: 6, z: 0 }], -1),
  "Waiting: opponents must be in their own half",
);

// Mirrors MatchEngine.resetPositions() staging for both sides/halves.
for (const attackSign of [1, -1]) {
  const opponents = [
    { x: attackSign * 17.8, z: 0 },
    { x: attackSign * 8.8, z: -5.4 },
    { x: attackSign * 8.8, z: 5.4 },
    { x: attackSign * 6.4, z: -3.1 },
    { x: attackSign * 4.9, z: 2.2 },
  ];
  assert(`kickoff staging allows legal opponents (attack sign ${attackSign})`, kickoffRestartViolation(opponents, attackSign), null);
}
// ---------------------------------------------------------------------------
// Spectator kickoff after a negative first frame
// ---------------------------------------------------------------------------
// The browser arms its requestAnimationFrame loop with `performance.now()`, then
// receives a frame timestamp that can be a few milliseconds *earlier* (frame-start
// time). `now - last` is negative, and the old engine stepped the match clock
// backwards: `clock = -0.004`. The blue-card sentinel is `blueCardUntil = 0`, so
// `p.blueCardUntil > e.clock` was true for every player — the whole squad was
// treated as sin-binned, benched off the pitch, and the kickoff found no eligible
// taker. The ball was released with no owner and no restart taker, and the
// auto-restart recovery only handles a ball that *has* an owner: a dead ball at the
// centre spot until the user pressed Reset.
{
  const engine = new MatchEngine(headlessEngineCanvas(), { seed: 1234, headless: true, spectator: true, debugAI: false });
  engine.step(-0.004);
  const clockAfter = engine.clock;
  const offPitch = engine.players.filter((p) => isOffPitch(engine, p)).length;
  assert("a negative first frame cannot move the match clock backwards", String(clockAfter >= 0), "true");
  assert("a negative first frame does not bench the whole squad", String(offPitch), "0");

  let launched = false;
  for (let i = 0; i < 60 * 12 && !launched; i++) {
    engine.step(1 / 60);
    const moved = Math.hypot(engine.ball.pos.x, engine.ball.pos.z);
    launched = engine.passLog.length > 0 || moved > 2;
  }
  assert("the kickoff still launches after a negative first frame", String(launched), "true");
  engine.dispose();
}

// A pending restart that can never be staged must not hold the match hostage: every
// player is frozen in the restart pose while it is pending, so the watchdog has to put
// the ball back in play by itself.
{
  const engine = new MatchEngine(headlessEngineCanvas(), { seed: 77, headless: true, spectator: true, debugAI: false });
  for (let i = 0; i < 60 * 4; i++) engine.step(1 / 60);          // let the opening kickoff play
  engine.rules.startSetup("throw_in", [0, 0], 0);
  engine.players.forEach((p) => { p.restartTaker = false; });     // staging found nobody
  const limit = CONFIG.match.restartStallLimit;
  let releasedAt = Infinity;
  for (let i = 0; i < Math.ceil((limit + 1) * 60); i++) {
    restartStallCheck(engine, 1 / 60);                            // no restartAuto: nothing can stage it
    if (!engine.rules.pendingRestart) { releasedAt = i / 60; break; }
  }
  const holder = engine.ball.possessedBy;
  const inPlay = holder !== null && engine.players[holder]?.team === 0;
  assert("a restart that cannot be staged is released by the stall watchdog", String(releasedAt <= limit + 0.05), "true");
  assert("the stall release hands the ball to the restarting side", String(inPlay), "true");
  engine.dispose();
}
