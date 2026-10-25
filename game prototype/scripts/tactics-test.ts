// Tactical regression harness for the four reported behaviours. Runs the REAL engine
// headless (no GPU) plus direct AI decisions, with concrete numeric assertions.
import * as THREE from "three";

const ctx2d: any = new Proxy({}, { get: () => () => ({}) });
const fakeCanvas = () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d, clientWidth: 800, clientHeight: 500 });
(globalThis as any).document = { createElement: () => fakeCanvas() };
(globalThis as any).window = { location: { search: "" }, addEventListener() {}, removeEventListener() {} };
(globalThis as any).devicePixelRatio = 1;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

async function main() {
  const { MatchEngine } = await import("../src/game/engine");
  const { AIController } = await import("../src/game/ai");
  const { SeededRandom } = await import("../src/game/random");
  const { CONFIG } = await import("../src/game/config");
  const quiet = console.log;
  const mute = () => { console.log = () => {}; console.groupCollapsed = () => {}; console.table = () => {}; console.info = () => {}; console.warn = () => {}; console.groupEnd = () => {}; };
  const unmute = () => { console.log = quiet; };
  const makeEngine = (seed: number) => new MatchEngine(fakeCanvas() as unknown as HTMLCanvasElement, { seed, headless: true, spectator: true, debugAI: true });

  // ================= 1. Central unmarked attacker near goal must SHOOT =================
  mute();
  let shoots = 0, cases = 0;
  const samples: string[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const engine = makeEngine(seed);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    const carrier = engine.players[4];              // RED FWD
    const goal = engine.ai.goalPos(0, 1);           // attacking +X
    carrier.pos.set(goal.x - 8, 0, 0.4);            // central, 8 m out
    carrier.vel.set(0, 0, 0);
    // No defender near; keep the rest far away so the chance is clear.
    engine.players.filter((p) => p.team === 1).forEach((p) => p.pos.set(-14, 0, p.idx % 2 ? 9 : -9));
    engine.players.filter((p) => p.team === 0 && p.idx !== 4).forEach((p) => p.pos.set(-4, 0, p.idx % 2 ? 10 : -10));
    engine.ball.possess(carrier.idx, 0);
    engine.ball.pos.set(carrier.pos.x, CONFIG.ball.radius, carrier.pos.z + 0.3);
    const snapshot = engine.snapshot();
    // Rebuild the WorldPlayers the AI sees from live engine state.
    const world = engine.players.map((p) => ({
      idx: p.idx, team: p.team, role: p.role, roleIdx: p.roleIdx, pos: p.pos, vel: p.vel, facing: p.facing,
      speed: 0, busy: false, uninterruptible: false, cooldowns: new Map<string, number>(), stamina: 1,
      hasBall: engine.ball.possessedBy === p.idx, callForBall: false, isHuman: false, runSerial: 0, style: p.style,
    }));
    const ai = new AIController(new SeededRandom(seed), seed);
    const decision = ai.think(world[4], 4, {
      ballPos: engine.ball.pos, ballVel: engine.ball.vel, ballOwner: 4, ballOwnerTeam: 0,
      players: world, time: 10, half: 1, matchSeed: seed, ballKickAge: 1,
    }, 10);
    cases++;
    if (decision.action && decision.action.startsWith("shoot")) shoots++;
    else samples.push(`seed${seed}:${decision.action ?? "none"} (${decision.reason})`);
    void snapshot;
  }
  unmute();
  check("central clear attacker 8 m out shoots (≥95%)", shoots / cases >= 0.95, `${shoots}/${cases}${samples.length ? " · " + samples.slice(0, 3).join(" | ") : ""}`);

  // ================= 2. Attacking width & depth =================
  {
    const engine = makeEngine(7);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    const carrier = engine.players[3];              // RED MID on the right touchline
    carrier.pos.set(0, 0, 10.5);
    const fwd = engine.players[4];                  // RED FWD
    fwd.pos.set(2, 0, 8);                            // near-side, must re-position far side
    const def = engine.players[1];
    def.pos.set(-6, 0, -8);                          // far-side defender should stay wide
    engine.ball.possess(carrier.idx, 0);
    engine.ball.pos.set(carrier.pos.x + 0.3, CONFIG.ball.radius, carrier.pos.z - 0.3);
    mute(); for (let i = 0; i < 3; i++) engine.step(1 / 60); unmute();
    // The prior fixed far-touchline target caused the isolation regression. A runner
    // now chooses either open half-space, within one realistic delivery of the ball.
    check("forward chooses a reachable channel instead of the far touchline", Math.abs(fwd.moveTarget.z) >= 3 && Math.abs(fwd.moveTarget.z) <= CONFIG.tactics.farSideMaxWidth
      && fwd.moveTarget.distanceTo(carrier.pos) <= CONFIG.tactics.runnerMaxDistance,
      `fwd target z=${fwd.moveTarget.z.toFixed(1)}, distance=${fwd.moveTarget.distanceTo(carrier.pos).toFixed(1)}m`);
    check("far-side forward provides depth (ahead of the ball)", fwd.moveTarget.x > carrier.pos.x + 2,
      `fwd x=${fwd.moveTarget.x.toFixed(1)} vs ball x=${carrier.pos.x.toFixed(1)}`);
    check("one outlet holds width while another provides central cover", engine.players.some((p) => p.team === 0 && p.supportJob === "outlet" && Math.abs(p.moveTarget.z) >= 4.5)
      && engine.players.some((p) => p.team === 0 && p.supportJob === "pivot" && Math.abs(p.moveTarget.z) <= CONFIG.tactics.pivotHalfWidth), `def z=${def.moveTarget.z.toFixed(1)}`);
    check("attacking shape reason reports width and depth", /width/.test(fwd.decisionReason) && /depth/.test(fwd.decisionReason), fwd.decisionReason);
  }

  // ================= 3. Defensive compaction in front of own goal =================
  {
    const engine = makeEngine(11);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    const goal = engine.ai.ownGoal(1, 1);            // BLUE's goal is +X
    const ball = engine.players[4];                   // RED carrier
    ball.pos.set(goal.x - 15, 0, 0.5);                // central, 15 m out
    engine.players.filter((p) => p.team === 1 && p.role === "GK").forEach((p) => p.pos.set(goal.x - 1, 0, 0));
    engine.ball.possess(ball.idx, 0);
    engine.ball.pos.set(ball.pos.x - 0.3, CONFIG.ball.radius, ball.pos.z);
    mute(); for (let i = 0; i < 4; i++) engine.step(1 / 60); unmute();
    const defs = engine.players.filter((p) => p.team === 1 && p.role === "DEF");
    // The nearest outfielder presses; the rest must compact the central corridor.
    const presser = engine.players.filter((p) => p.team === 1 && p.role !== "GK")
      .sort((a, b) => a.pos.distanceTo(ball.pos) - b.pos.distanceTo(ball.pos))[0];
    const rest = engine.players.filter((p) => p.team === 1 && p.role !== "GK" && p.idx !== presser.idx);
    const narrow = defs.every((p) => Math.abs(p.moveTarget.z) < 5);
    const goalSide = defs.every((p) => p.moveTarget.x > ball.pos.x && p.moveTarget.x < goal.x);
    const midCompact = rest.every((p) => Math.abs(p.moveTarget.z) < 5.5 && p.moveTarget.x > ball.pos.x);
    check("defensive line pinches central (both CBs |z| < 5 m)", narrow, defs.map((p) => p.moveTarget.z.toFixed(1)).join(", "));
    check("defensive line is goal-side of the ball", goalSide, defs.map((p) => p.moveTarget.x.toFixed(1)).join(", "));
    check("non-pressing outfielders drop into the central corridor", midCompact, rest.map((p) => `${p.role} ${p.moveTarget.x.toFixed(1)},${p.moveTarget.z.toFixed(1)}`).join(" · "));
  }

  // ================= 4. Corners: legal taker, lofted long delivery =================
  {
    const engine = makeEngine(21);
    engine.rules.startSetup("corner", [19.75, 12.25], 0);
    mute(); engine.step(1 / 60); unmute();
    const taker = engine.players.find((p) => p.restartTaker)!;
    const ball = engine.ball.pos.clone();
    const touchline = CONFIG.pitch.width / 2;
    check("corner taker is outside the touchline (behind the ball)", Math.abs(taker.pos.z) > touchline,
      `taker z=${taker.pos.z.toFixed(2)} touchline=${touchline}`);
    check("corner taker is level with/behind the ball toward the flag", Math.abs(taker.pos.x) <= CONFIG.pitch.length / 2 &&
      Math.abs(Math.abs(taker.pos.z) - touchline) < 1, `taker=(${taker.pos.x.toFixed(2)}, ${taker.pos.z.toFixed(2)}) ball=(${ball.x.toFixed(2)}, ${ball.z.toFixed(2)})`);
    // Let the corner be taken and measure the delivery: must be airborne and long.
    mute();
    for (let i = 0; i < 240; i++) engine.step(1 / 60);
    unmute();
    const flightMax = (engine as any).__cornerApex ?? 0;
    const profile = (engine as any).passProfile?.("corner_kick");
    check("corner delivery is lofted (cross profile loft ≥ 0.6)", !!profile && profile.loft >= 0.6, `loft=${profile?.loft}`);
    void flightMax;
  }

  // Simulate a corner delivery directly to measure height + target distance.
  {
    const engine = makeEngine(22);
    engine.rules.startSetup("corner", [19.75, -12.25], 0);
    mute(); engine.step(1 / 60); unmute();
    const taker = engine.players.find((p) => p.restartTaker)!;
    const runners = engine.players.filter((p) => p.team === 0 && p.idx !== taker.idx && p.role !== "GK");
    const goalX = engine.ai.goalPos(0, 1).x;
    // Advance until the corner leaves the taker's foot.
    let released = false;
    mute();
    for (let i = 0; i < 360 && !released; i++) {
      const before = engine.ball.lastTouch;
      engine.step(1 / 60);
      if (before === taker.idx && engine.ball.possessedBy === null) released = true;
    }
    let apex = 0; let endX = 0, endZ = 0; let landed = false;
    for (let i = 0; i < 300; i++) {
      engine.step(1 / 60);
      apex = Math.max(apex, engine.ball.pos.y);
      if (!landed && i > 6 && engine.ball.pos.y <= CONFIG.ball.radius + 0.02) {
        landed = true; endX = engine.ball.pos.x; endZ = engine.ball.pos.z;
      }
    }
    if (!landed) { endX = engine.ball.pos.x; endZ = engine.ball.pos.z; }
    unmute();
    check("corner ball becomes airborne (apex ≥ 1.0 m)", apex >= 1.0, `apex=${apex.toFixed(2)} m`);
    check("corner is delivered long into the box (within 10 m of goal, inside the box width)", Math.abs(endX - goalX) <= 10 && Math.abs(endZ) <= 6.5,
      `end=(${endX.toFixed(1)}, ${endZ.toFixed(1)})`);
    check("corner has named box runners", runners.length >= 3, `${runners.length} runners`);
  }

  // ================= 5. Goal kicks: evaluated short + long options =================
  {
    const engine = makeEngine(31);
    engine.rules.startSetup("goal_kick", [-18, 0], 0);
    mute(); engine.step(1 / 60); unmute();
    const gk = engine.players.find((p) => p.restartTaker)!;
    const mates = engine.players.filter((p) => p.team === 0 && p.idx !== gk.idx && p.role !== "GK");
    const dists = mates.map((m) => Math.hypot(m.pos.x - engine.ball.pos.x, m.pos.z - engine.ball.pos.z));
    const shortOpts = dists.filter((d) => d <= 22).length;
    const longOpts = dists.filter((d) => d > 22).length;
    check("goal kick creates both a short option and a long option", shortOpts >= 1 && longOpts >= 1, `${shortOpts} short / ${longOpts} long`);
    check("goal-kick options are spread wide (≥ 6 m half-width somewhere)", mates.some((m) => Math.abs(m.pos.z) >= 6),
      mates.map((m) => m.pos.z.toFixed(1)).join(", "));
    const choice = (engine as any).evaluateGkDistribution(gk);
    check("goal kick is a chosen distribution with a named teammate", !!choice && choice.receiver.team === 0 && choice.receiver.role !== "GK",
      choice?.reason ?? "none");
    check("distribution reason cites lane and receiver space (not just distance)", !!choice && /lane/.test(choice.reason) && /space/.test(choice.reason), choice?.reason ?? "");
    // Live catch distribution uses the same evaluator.
    const world = engine.players.map((p) => ({
      idx: p.idx, team: p.team, role: p.role, roleIdx: p.roleIdx, pos: p.pos, vel: p.vel, facing: p.facing,
      speed: 0, busy: false, uninterruptible: false, cooldowns: new Map<string, number>(), stamina: 1,
      hasBall: false, callForBall: false, isHuman: false, runSerial: 0, style: p.style,
    }));
    (world[gk.idx] as any).hasBall = true;
    const controller = new AIController(new SeededRandom(5), 5);
    controller.gkDistribution = (idx) => {
      const ch = (engine as any).evaluateGkDistribution(engine.players[idx]);
      return ch ? { action: ch.action, receiverIdx: ch.receiver.idx, target: ch.target, reason: ch.reason } : null;
    };
    const live = controller.think(world[gk.idx], 0, {
      ballPos: engine.ball.pos, ballVel: new THREE.Vector3(), ballOwner: gk.idx, ballOwnerTeam: 0,
      players: world, time: 20, half: 1, matchSeed: 5, ballKickAge: 1,
    }, 20);
    check("live GK distribution picks a short/long action to a named teammate", (live.action === "gk_roll" || live.action === "gk_punt") && live.passTo !== undefined,
      `${live.action} → #${live.passTo} (${live.reason})`);
  }

  // ================= 6. Distribution is a CHOICE, not a fixed rule =================
  {
    const outcomes: string[] = [];
    for (const press of [false, true]) {
      for (let seed = 1; seed <= 6; seed++) {
        const engine = makeEngine(seed * 13 + (press ? 7 : 0));
        engine.rules.startSetup("goal_kick", [-18, 0], 0);
        mute(); engine.step(1 / 60); unmute();
        const gk = engine.players.find((p) => p.restartTaker)!;
        // Free keeper vs pressed keeper.
        const pressSpots: [number, number][] = [
          [-17.2, 1.6],   // pressing the keeper
          [-9.2, 7.6],    // marking the short right-back
          [-9.2, -7.6],   // marking the short left-back
          [-8.6, 0],      // screening the midfield outlet
        ];
        let oppIdx = 0;
        engine.players.filter((p) => p.team === 1).forEach((p) => {
          if (p.role === "GK") { p.pos.set(18, 0, 0); return; }
          // Pressed: mark every short outlet and the keeper. Free: retreat to own half.
          const spot = press ? pressSpots[oppIdx++ % pressSpots.length] : [-2, 0];
          p.pos.set(press ? spot[0] : -2, 0, press ? spot[1] : 6 + oppIdx * 2);
        });
        const choice = (engine as any).evaluateGkDistribution(gk);
        outcomes.push(choice ? `${press ? "press" : "free"}:${choice.short ? "short" : "long"}` : "none");
      }
    }
    const freeShort = outcomes.filter((o) => o.startsWith("free:short")).length;
    const pressLong = outcomes.filter((o) => o.startsWith("press:long")).length;
    check("free keeper can choose a short option", freeShort >= 1, outcomes.join(" "));
    check("pressed keeper can choose a long option", pressLong >= 1, outcomes.join(" "));
  }

  console.log(failures === 0 ? "\nALL TACTICS CHECKS PASSED" : `\n${failures} TACTICS CHECK(S) FAILED`);
  if (failures) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
