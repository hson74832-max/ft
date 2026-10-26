// Tactical regression harness for the four reported behaviours. Runs the REAL engine
// headless (no GPU) plus direct AI decisions, with concrete numeric assertions.
import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import * as THREE from "three";

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
  const makeEngine = (seed: number) => new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: true });

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

  // ================= 3b. Defenders: never baited wide, always goal-side =================
  {
    const engine = makeEngine(12);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    const carrier = engine.players[4];                 // RED winger on the touchline
    carrier.pos.set(8, 0, 10.5);
    carrier.vel.set(2, 0, 1.5);
    engine.ball.possess(carrier.idx, 0);
    engine.ball.pos.set(8.4, CONFIG.ball.radius, 10.7);
    // BLUE's nearest outfielder starts just behind him; the rest hold the middle.
    engine.players[6].pos.set(7.2, 0, 10.2);
    engine.players[7].pos.set(6, 0, 2);
    engine.players[8].pos.set(4, 0, -3);
    engine.players[9].pos.set(2, 0, 0);
    engine.players[5].pos.set(18.5, 0, 0);
    const goal = engine.ai.ownGoal(1, 1);              // BLUE's own goal is +X
    const sign = engine.ai.attackSign(1, 1);
    const ownU = (v: THREE.Vector3) => v.x * sign;     // smaller = closer to own goal
    mute(); for (let i = 0; i < 3; i++) engine.step(1 / 60); unmute();
    const presser = engine.players.filter((p) => p.team === 1 && p.role !== "GK")
      .sort((a, b) => a.pos.distanceTo(carrier.pos) - b.pos.distanceTo(carrier.pos))[0];
    check("pressing defender closes from the goal side (never ball-side of the carrier)",
      ownU(engine.ball.pos) - ownU(presser.moveTarget) > 0.5,
      `${presser.role} target x=${presser.moveTarget.x.toFixed(1)} ball x=${engine.ball.pos.x.toFixed(1)} goal x=${goal.x.toFixed(1)}`);
    check("pressing defender is not dragged outside the touchline",
      Math.abs(presser.moveTarget.z) <= CONFIG.pitch.width / 2,
      `target z=${presser.moveTarget.z.toFixed(1)}`);
    const others = engine.players.filter((p) => p.team === 1 && p.role !== "GK" && p.idx !== presser.idx);
    check("the centre is still covered while the ball is wide",
      others.some((p) => Math.abs(p.moveTarget.z) < 5),
      others.map((p) => `${p.role} z=${p.moveTarget.z.toFixed(1)}`).join(" · "));
    void goal;
  }

  // ================= 3c. Swarmed defender in his own box clears it =================
  {
    let clearances = 0;
    const boxTargets: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const engine = makeEngine(seed);
      engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
      const carrier = engine.players[1];                // RED DEF in his own box
      carrier.pos.set(-17, 0, 2);
      engine.players[2].pos.set(-6, 0, -1);
      engine.players[3].pos.set(0, 0, 5);
      engine.players[4].pos.set(4, 0, -3);
      // BLUE swarm around him AND in every short exit lane.
      const spots: [number, number][] = [[-16.4, 1.2], [-16.0, 3.0], [-11.4, 0.75], [-12.4, 2.75], [-13.9, 1.25]];
      engine.players.filter((p) => p.team === 1 && p.role !== "GK")
        .forEach((p, i) => p.pos.set(spots[i % spots.length][0], 0, spots[i % spots.length][1]));
      engine.players[5].pos.set(18, 0, 0);
      engine.ball.possess(carrier.idx, 0);
      engine.ball.pos.set(-16.5, CONFIG.ball.radius, 2);
      mute(); engine.step(1 / 60); unmute();
      if (/CLEARANCE/.test(carrier.decisionReason) && carrier.moveTarget.distanceTo(carrier.pos) < 0.2) clearances++;
      boxTargets.push(carrier.decisionReason.slice(0, 22));
    }
    check("a defender surrounded in his own box chooses a clearance (not a short pass/dribble)",
      clearances >= 15, `${clearances}/20 · ${boxTargets[0]}`);

    // The clearance kick itself: no valid receiver planning, ball leaves long and upfield.
    const engine = makeEngine(1);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    const def = engine.players[1];
    def.pos.set(-17, 0, 2);
    engine.players.filter((p) => p.team === 1 && p.role !== "GK").forEach((p, i) => p.pos.set(-14 + i, 0, i));
    engine.ball.possess(def.idx, 0);
    engine.ball.pos.set(-16.6, CONFIG.ball.radius, 2);
    const { startAction } = await import("../src/game/match/actions");
    const { onContact } = await import("../src/game/match/contacts");
    const target = new THREE.Vector3(18, 0, -2);
    const started = startAction(engine, def, "pass_long", target);
    let kicked = false;
    mute();
    for (let i = 0; i < 120 && started; i++) {
      engine.clock += 1 / 60;
      const frame = def.anim.update(1 / 60, 0, 0);
      if (frame.contact) { onContact(engine, def, frame.contact); kicked = true; break; }
    }
    unmute();
    check("the clearance leaves the boot long (contact releases the ball away from own goal)",
      kicked && engine.ball.possessedBy === null && engine.ball.speed > 15 && engine.ball.vel.x > 5,
      `speed ${engine.ball.speed.toFixed(1)} vel.x ${engine.ball.vel.x.toFixed(1)}`);
    engine.dispose();
  }

  // ================= 3d. Wide carrier has a box target to cross to =================
  // The plan layer is exercised directly (no engine stepping): possession must not be
  // lost to a pass before the runner assignment is read.
  {
    const { TeamTactics } = await import("../src/game/tactics");
    const style = { directness: 1, width: 1, risk: 1, carry: 1, shooting: 1, pressing: 1, support: 1, creativity: 1, finesseSide: 1 as const };
    const at = (idx: number, team: number, role: string, roleIdx: number, x: number, z: number) => ({
      idx, team, role, roleIdx, pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(),
      facing: 0, speed: 0, busy: false, uninterruptible: false, cooldowns: new Map<string, number>(),
      stamina: 1, hasBall: idx === 3, callForBall: false, isHuman: false, runSerial: 0, style,
    });
    const players = [
      at(0, 0, "GK", 0, -18, 0), at(1, 0, "DEF", 1, -4, -6), at(2, 0, "DEF", 2, -4, 6),
      at(3, 0, "MID", 3, 11, 9), at(4, 0, "FWD", 4, 4, 0),
      at(5, 1, "GK", 0, 19.5, 0), at(6, 1, "DEF", 1, 19.5, 3), at(7, 1, "DEF", 2, 19.5, -3),
      at(8, 1, "MID", 3, 14, 0), at(9, 1, "FWD", 4, 6, 2),
    ];
    const plan = new TeamTactics().plan({
      ballPos: new THREE.Vector3(11.4, CONFIG.ball.radius, 8.8), ballVel: new THREE.Vector3(),
      ballOwner: 3, ballOwnerTeam: 0, players, time: 12, half: 1, matchSeed: 77,
      ballKickAge: 3, ownerSince: 9,
    }, 0);
    // The cross target is the middle of the box (|z| small), not the half-space outside
    // it: without it the runner only ever offered a wide channel ball, never a cross.
    const boxMiddle = plan ? [...plan.assignments.values()].filter((a) =>
      a.target.x > CONFIG.pitch.length / 2 - 5 && Math.abs(a.target.z) < 3.2) : [];
    check("with the ball wide in the final third a runner attacks the middle of the box", boxMiddle.length >= 1,
      plan ? [...plan.assignments.values()].map((a) => `${a.job}/${a.runType} ${a.target.x.toFixed(1)},${a.target.z.toFixed(1)}`).join(" · ") : "no plan");
  }

  // ================= 3e. Wide carrier delivers into an occupied box =================
  // The reported defect: with the box occupied the carrier still played the square
  // ball infield. The choice is read from the decision layer (no engine stepping, so a
  // pass cannot be lost to play before the decision is inspected).
  // Two cases: an open delivery lane, and a partially blocked one with the target man
  // marked — the "even with the box occupied" half of the report. The second case only
  // works because a cross is scored on its delivery, not on the receiver being free.
  const crossCases: { label: string; spots: [number, number][] }[] = [
    { label: "open delivery lane", spots: [[8.1, 8.2], [6, 4], [11.5, 11.2], [17.4, 3.6]] },
    { label: "part-blocked delivery lane", spots: [[8.1, 8.2], [6, 4], [11.5, 5.5], [17.4, 3.6]] },
  ];
  for (const crossCase of crossCases) {
    let deliveries = 0, cases = 0;
    const samples: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const engine = makeEngine(seed);
      engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
      const carrier = engine.players[4];              // RED winger, wide right, final third
      carrier.pos.set(9, 0, 9.5); carrier.vel.set(0, 0, 0); carrier.facing = -0.7;
      const forward = engine.players[3];              // target man in the box
      forward.pos.set(16.5, 0, 2.5); forward.vel.set(0, 0, 0);
      engine.players[1].pos.set(-8, 0, 0);
      engine.players[2].pos.set(2, 0, -3);
      engine.players[0].pos.set(-18, 0, 0);
      // BLUE: the infield lanes are shut, the box is occupied by a marker on the forward.
      // A defender on the carrier's back (pressing, but not in the delivery lane), the
      // infield lanes shut, and a marker on the forward in an occupied box.
      const spots = crossCase.spots;
      engine.players.filter((p) => p.team === 1 && p.role !== "GK")
        .forEach((p, i) => p.pos.set(spots[i % spots.length][0], 0, spots[i % spots.length][1]));
      engine.players[5].pos.set(19.5, 0, 0.4);
      engine.ball.possess(carrier.idx, 0);
      engine.ball.pos.set(9.3, CONFIG.ball.radius, 9.6);
      engine.ball.vel.set(0, 0, 0);
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
      const target = decision.actionTarget;
      const intoBox = !!target && target.x > CONFIG.pitch.length / 2 - 5.5 && Math.abs(target.z) < 6.2;
      if ((decision.action === "pass_long" || decision.action === "pass_short" || decision.action === "pass_through") && intoBox) deliveries++;
      else samples.push(`${decision.action ?? "carry"}→${target ? `${target.x.toFixed(1)},${target.z.toFixed(1)}` : "-"} (${decision.reason.slice(0, 36)}) [${(decision.passOptions ?? []).map((o) => `#${o.receiver} ${o.purpose} lane${o.lane.toFixed(2)} sp${o.space.toFixed(1)} g${o.gain.toFixed(1)} s${o.score.toFixed(2)}`).join(" | ")}]`);
      engine.dispose();
    }
    check(`a wide carrier with the box occupied delivers the ball into the box (${crossCase.label})`,
      deliveries >= 12, `${deliveries}/${cases}${samples.length ? " · misses: " + samples.slice(0, 2).join(" | ") : ""}`);
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
    // The corner profile launches at 22–32° (tan → 0.40–0.62 loft); the plan uses the
    // middle of that band, so "lofted" means well above the ground-pass band.
    check("corner delivery is lofted (corner profile loft ≥ 0.40)", !!profile && profile.loft >= 0.40, `loft=${profile?.loft}`);
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
