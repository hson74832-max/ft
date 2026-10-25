// Regression harness for the 2026-10-25 gameplay reports:
//  1. an on-target shot awarded as a corner/goal kick instead of a goal,
//  2. keepers passive in 1v1s (never close the angle / use hands on a carrier),
//  3. defenders panic-clearing with no immediate danger,
//  4. AI repeating the same pass in a stable loop,
//  5. corner taker not the player actually nearest the flag when the ball went out,
//  6. locomotion that only knew walk-or-sprint, with no burst off the mark and no
//     planted turn,
//  7. body orientation welded to the stride: no shield, no side-step, every kick
//     struck with the right foot,
//  8. keepers who did not use their hands on a grounded ball at a dribbler's feet,
//  9. intelligence and mentality attributes that changed no decision, position or
//     effort.
// Runs the REAL engine headless plus direct AI decisions, like tactics-test.
import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import * as THREE from "three";
import { yawDelta, yawOf } from "../src/game/angles";

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
  const { startAction } = await import("../src/game/match/actions");
  const { onContact } = await import("../src/game/match/contacts");
  const quiet = console.log;
  const mute = () => { console.log = () => {}; console.groupCollapsed = () => {}; console.table = () => {}; console.info = () => {}; console.warn = () => {}; console.groupEnd = () => {}; };
  const unmute = () => { console.log = quiet; };
  const makeEngine = (seed: number) => new MatchEngine(headlessEngineCanvas(), { seed, headless: true, spectator: true, debugAI: true });

  const L = CONFIG.pitch.length / 2, R = CONFIG.ball.radius;

  // ================= 1a. Fast shot must not tunnel past the net window =================
  // At timeScale 2 a frame is 0.1 s of sim: a 32 m/s shot travels ~3 m per frame,
  // clean over the old "inside the net volume" window (goalDepth + 0.4 = 1.6 m).
  {
    mute();
    const engine = makeEngine(101);
    engine.timeScale = 2;
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    for (const p of engine.players) { p.pos.set(-10, 0, p.idx % 2 ? 11 : -11); p.vel.set(0, 0, 0); }
    engine.ball.release();
    engine.ball.pos.set(L - 0.3, R, 0);           // 0.3 m in front of the +X goal line
    engine.ball.lastTouch = 4; engine.ball.lastTouchTeam = 0; // RED shot
    engine.ball.kick(new THREE.Vector3(1, 0, 0), 32, 0.02);
    engine.step(0.05);
    unmute();
    check("32 m/s shot at timeScale 2 is a GOAL, not a goal kick/corner",
      engine.rules.phase === "GOAL" && engine.rules.score[0] === 1,
      `phase=${engine.rules.phase} score=${engine.rules.score.join(":")} ballX=${engine.ball.pos.x.toFixed(2)}`);
    engine.dispose();
  }

  // ================= 1b. Diagonal shot judged at the crossing point =================
  // Crosses the line inside the post (z ≈ 1.33) but by the detection frame its
  // lateral travel has carried it beyond the post line (z ≈ 1.6): still a goal.
  {
    mute();
    const engine = makeEngine(102);
    engine.timeScale = 2;
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    for (const p of engine.players) { p.pos.set(-10, 0, p.idx % 2 ? 11 : -11); p.vel.set(0, 0, 0); }
    engine.ball.release();
    engine.ball.pos.set(L - 1.0, R, 1.0);
    engine.ball.lastTouch = 4; engine.ball.lastTouchTeam = 0;
    engine.ball.vel.set(20, 0, 6); engine.ball.spin.set(0, 0, 0);
    engine.ball.kickedBy = 4; engine.ball.kickAge = 0;
    engine.step(0.05);
    unmute();
    check("diagonal shot crossing inside the post is a GOAL even if it exits the post line behind goal",
      engine.rules.phase === "GOAL",
      `phase=${engine.rules.phase} ball=(${engine.ball.pos.x.toFixed(2)}, ${engine.ball.pos.z.toFixed(2)}) restart=${engine.rules.pendingRestart?.kind ?? "-"}`);
    engine.dispose();
  }

  // ================= 1c. Shot heading wide of the post is NOT a goal =================
  {
    mute();
    const engine = makeEngine(103);
    engine.timeScale = 2;
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    for (const p of engine.players) { p.pos.set(-10, 0, p.idx % 2 ? 11 : -11); p.vel.set(0, 0, 0); }
    engine.ball.release();
    engine.ball.pos.set(L - 1.0, R, 2.2);         // already wide of the post, crossing outside
    engine.ball.lastTouch = 4; engine.ball.lastTouchTeam = 0;
    engine.ball.vel.set(20, 0, 1); engine.ball.spin.set(0, 0, 0);
    engine.ball.kickedBy = 4; engine.ball.kickAge = 0;
    engine.step(0.05);
    unmute();
    check("shot crossing wide of the post is a goal kick, not a goal",
      engine.rules.phase !== "GOAL" && engine.rules.pendingRestart?.kind === "goal_kick",
      `phase=${engine.rules.phase} restart=${engine.rules.pendingRestart?.kind ?? "-"}`);
    engine.dispose();
  }

  // Shared AI fixture builder (mirrors tactics-test's WorldPlayer shape).
  const style = { directness: 1, width: 1, risk: 1, carry: 1, shooting: 1, pressing: 1, support: 1, creativity: 1, finesseSide: 1 as const };
  const wp = (idx: number, team: number, role: string, roleIdx: number, x: number, z: number, vx = 0, vz = 0, hasBall = false) => ({
    idx, team, role, roleIdx, pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(vx, 0, vz),
    facing: team === 0 ? 0 : Math.PI, speed: Math.hypot(vx, vz), busy: false, uninterruptible: false,
    cooldowns: new Map<string, number>(), stamina: 1, hasBall, callForBall: false, isHuman: false,
    runSerial: 0, style: { ...style },
  });

  // ================= 2a. Keeper closes the angle in a 1v1 =================
  // BLUE forward through on RED's goal (-X), 7 m out, no RED defender goal-side.
  {
    const players = [
      wp(0, 0, "GK", 0, -18.4, 0),
      wp(1, 0, "DEF", 1, -6, -8), wp(2, 0, "DEF", 2, -6, 8), wp(3, 0, "MID", 3, 0, 0), wp(4, 0, "FWD", 4, 10, 0),
      wp(5, 1, "GK", 0, 18.4, 0), wp(6, 1, "DEF", 1, 6, -8), wp(7, 1, "DEF", 2, 6, 8), wp(8, 1, "MID", 3, 0, 5),
      wp(9, 1, "FWD", 4, -13, 0.3, -5, 0, true),
    ];
    const ai = new AIController(new SeededRandom(7), 7);
    const ballPos = new THREE.Vector3(-13.5, R, 0.3);
    const dec = ai.think(players[0], 0, {
      ballPos, ballVel: new THREE.Vector3(-5, 0, 0), ballOwner: 9, ballOwnerTeam: 1,
      players, time: 10, half: 1, matchSeed: 7, ballKickAge: 1,
    }, 10);
    const advance = dec.moveTarget.x + L;   // metres in front of RED's goal line (-20)
    check("1v1: keeper rushes off his line toward the carrier instead of holding the arc",
      advance > 3.4 && dec.desiredSpeed >= 5,
      `target=(${dec.moveTarget.x.toFixed(1)}, ${dec.moveTarget.z.toFixed(1)}) advance=${advance.toFixed(1)} speed=${dec.desiredSpeed.toFixed(1)} · ${dec.reason}`);
  }

  // ================= 2b. Keeper smothers with hands at the carrier's feet =================
  // Engine-level: carrier through, keeper at his feet plays gk_catch; the contact
  // frame must actually take the ball (previously: possessed ball = instant break).
  {
    mute();
    const engine = makeEngine(104);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    const gk = engine.players[0];               // RED GK, own goal -X in half 1
    const carrier = engine.players[9];          // BLUE FWD
    for (const p of engine.players) if (p !== gk && p !== carrier) { p.pos.set(10, 0, p.idx % 2 ? 11 : -11); p.vel.set(0, 0, 0); }
    carrier.pos.set(-15.4, 0, 0); carrier.facing = Math.PI; carrier.vel.set(-4, 0, 0);
    carrier.tackleProtectionT = 0;
    gk.pos.set(-16.6, 0, 0); gk.facing = 0; gk.vel.set(0, 0, 0);
    engine.ball.possess(carrier.idx, carrier.team);
    engine.ball.pos.set(-15.9, R, 0);           // glued ball, exposed toward the keeper
    const started = startAction(engine, gk, "gk_catch", engine.ball.pos.clone());
    let contacted = false;
    for (let i = 0; i < 90 && !contacted; i++) {
      const dt = 1 / 60; engine.clock += dt;
      const frame = gk.anim.update(dt, 0, 0);
      if (frame.contact) { onContact(engine, gk, frame.contact); contacted = true; }
    }
    unmute();
    check("1v1: gk_catch contact smothers an exposed possessed ball",
      started && contacted && engine.ball.possessedBy === gk.idx,
      `started=${started} contacted=${contacted} owner=${engine.ball.possessedBy}`);
    engine.dispose();
  }

  // ================= 3. No panic clearance with a single static attacker =================
  // RED defender 10 m from his own goal, ONE opponent 3 m away standing still,
  // teammates marked (no "safe" outlet) but the lane ahead is wide open.
  {
    const players = [
      wp(0, 0, "GK", 0, -18.4, 0),
      wp(1, 0, "DEF", 1, -10, 0, 0, 0, true),          // carrier
      wp(2, 0, "DEF", 2, -12, -7), wp(3, 0, "MID", 3, -4, 6), wp(4, 0, "FWD", 4, 6, -3),
      wp(5, 1, "GK", 0, 18.4, 0),
      wp(6, 1, "DEF", 1, -11.4, -7),                    // marker on #2 (0.6 m)
      wp(7, 1, "DEF", 2, -3.4, 6),                      // marker on #3 (0.6 m)
      wp(8, 1, "MID", 3, -14, 0.2),                     // stands in the back-pass lane to the GK
      wp(9, 1, "FWD", 4, -7, 0.8),                      // single presser, 3.1 m away, static
    ];
    let clearances = 0, runs = 0;
    const samples: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const ai = new AIController(new SeededRandom(seed), seed);
      const dec = ai.think(players[1], 1, {
        ballPos: new THREE.Vector3(-9.5, R, 0), ballVel: new THREE.Vector3(),
        ballOwner: 1, ballOwnerTeam: 0, players, time: 10, half: 1, matchSeed: seed, ballKickAge: 1,
      }, 10);
      runs++;
      if (/CLEARANCE/.test(dec.reason)) { clearances++; samples.push(`seed${seed}: ${dec.reason}`); }
    }
    check("defender with one static attacker 3 m away and space ahead does NOT panic-clear",
      clearances === 0, `${clearances}/${runs}${samples.length ? " · " + samples[0] : ""}`);
  }

  // ================= 3b. A real emergency still clears =================
  // Same carrier, now inside his own box, two opponents closing fast, lane ahead shut.
  {
    const players = [
      wp(0, 0, "GK", 0, -18.4, 0),
      wp(1, 0, "DEF", 1, -16, 0, 0, 0, true),
      wp(2, 0, "DEF", 2, -12, -7), wp(3, 0, "MID", 3, -4, 6), wp(4, 0, "FWD", 4, 6, -3),
      wp(5, 1, "GK", 0, 18.4, 0),
      wp(6, 1, "DEF", 1, -11.4, -7),
      wp(7, 1, "DEF", 2, -3.4, 6),
      wp(8, 1, "MID", 3, -13.8, -1.2, -5, 1),           // second presser closing, blocks the lane ahead
      wp(9, 1, "FWD", 4, -14.2, 1.0, -5, -0.8),         // nearest presser closing
    ];
    let clearances = 0, runs = 0;
    const samples: string[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const ai = new AIController(new SeededRandom(seed), seed);
      const dec = ai.think(players[1], 1, {
        ballPos: new THREE.Vector3(-15.5, R, 0), ballVel: new THREE.Vector3(),
        ballOwner: 1, ballOwnerTeam: 0, players, time: 10, half: 1, matchSeed: seed, ballKickAge: 1,
      }, 10);
      runs++;
      if (/CLEARANCE/.test(dec.reason)) clearances++; else samples.push(`seed${seed}: ${dec.action ?? "carry"} ${dec.reason}`);
    }
    check("defender swarmed in his own box with no outlet and no escape lane still clears",
      clearances >= runs * 0.8, `${clearances}/${runs}${samples.length ? " · " + samples[0] : ""}`);
  }

  // ================= 4. Repeated identical pass cannot stay the argmax forever =================
  // Carrier with two open teammates. Commit "pass to #3" over and over (as a
  // completed A->B->A->B cycle would): the repeat penalty must eventually move
  // the choice off #3, and across seeds near-equal options must both be picked.
  {
    // Ring in the dribble lanes ahead + a presser behind: carrying is shut,
    // both wide teammates are open. `marked` shades #4 so #3 wins by a clear
    // margin (more than the capped novelty penalty can ever repay).
    const makePlayers = (marked: boolean) => [
      wp(0, 0, "GK", 0, -18.4, 0),
      wp(1, 0, "DEF", 1, -12, -6), wp(2, 0, "DEF", 2, -2, 0, 0, 0, true),
      wp(3, 0, "MID", 3, 3, -7), wp(4, 0, "FWD", 4, 3, 7),
      wp(5, 1, "GK", 0, 18.4, 0),
      wp(6, 1, "DEF", 1, 3, 0), wp(7, 1, "DEF", 2, 2.5, marked ? 4.5 : 2), wp(8, 1, "MID", 3, 2.5, -2), wp(9, 1, "FWD", 4, -4.5, 0),
    ];
    const players = makePlayers(false);
    const snapFor = (seed: number, ps = players) => ({
      ballPos: new THREE.Vector3(-1.5, R, 0), ballVel: new THREE.Vector3(),
      ballOwner: 2, ballOwnerTeam: 0, players: ps, time: 10, half: 1 as const, matchSeed: seed, ballKickAge: 1,
    });
    // (a) streak: with #3 the clear best option, after straight committed
    // passes to the same man the choice must still eventually move off him.
    const streakPlayers = makePlayers(true);
    const ai = new AIController(new SeededRandom(42), 42);
    const first = ai.think(streakPlayers[2], 2, snapFor(42, streakPlayers), 10);
    const firstTarget = first.passTo;
    let broke = false;
    if (firstTarget !== undefined) {
      for (let i = 0; i < 6 && !broke; i++) {
        ai.commitDecision(2, { ...first });
        ai.nextThink.set(2, 0);
        const next = ai.think(streakPlayers[2], 2, snapFor(42, streakPlayers), 10);
        if (next.passTo !== firstTarget) broke = true;
      }
    }
    check("passing to the same teammate repeatedly eventually stops being chosen",
      firstTarget !== undefined && broke, `first passTo=${firstTarget} broke=${broke} (${first.reason})`);
    // (b) probability: near-equal options are not a deterministic argmax across seeds.
    const picks = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const a = new AIController(new SeededRandom(seed), seed);
      const d = a.think(players[2], 2, snapFor(seed), 10);
      if (d.passTo !== undefined) picks.add(d.passTo);
    }
    check("near-equal pass options are sampled probabilistically across seeds",
      picks.size >= 2, `receivers picked: ${[...picks].join(", ")}`);
  }

  // ================= 5. Corner taker = nearest to the flag when the ball went out =================
  {
    mute();
    const engine = makeEngine(105);
    // MID #3 is right at the corner flag; the FWD (formation-home nearest) is far away.
    engine.players[3].pos.set(18.5, 0, 11.5);
    engine.players[4].pos.set(-5, 0, 0);
    engine.players[1].pos.set(-8, 0, -6);
    engine.players[2].pos.set(-8, 0, 6);
    engine.rules.startSetup("corner", [19.75, 12.25], 0);
    engine.step(1 / 60);
    unmute();
    const taker = engine.players.find((p) => p.restartTaker);
    check("corner taker is the outfielder nearest the flag at ball-out, not nearest formation home",
      taker?.idx === 3, `taker=#${taker?.idx} ${taker?.role}`);
    engine.dispose();
  }

  // ================= 6. Structured, role-based attributes =================
  {
    const ai = new AIController(new SeededRandom(106), 106);
    const def = ai.sampleAttributes("DEF", 1);
    const fwd = ai.sampleAttributes("FWD", 4);
    const gk = ai.sampleAttributes("GK", 0);
    const ratings = [def, fwd, gk].flatMap((a) => Object.values(a).flatMap((group) => Object.values(group)));
    // 43 technical/physical/keeper ratings + 8 intelligence + 10 mentality.
    check("player attributes cover every group with valid 1–99 ratings",
      ratings.length === 3 * 61 && ratings.every((rating) => Number.isFinite(rating) && rating >= 1 && rating <= 99),
      `${ratings.length} ratings`);
    check("role profiles make defenders, forwards and keepers fundamentally different",
      def.defending.standingTackle > fwd.defending.standingTackle + 25
      && def.defending.interceptions > fwd.defending.interceptions + 20
      && fwd.shooting.finishing > def.shooting.finishing + 25
      && gk.goalkeeping.catching > fwd.goalkeeping.catching + 45,
      `DEF tackle ${def.defending.standingTackle}, FWD finish ${fwd.shooting.finishing}, GK catch ${gk.goalkeeping.catching}`);
    check("attribute generation is deterministic and isolated from the style stream",
      JSON.stringify(ai.sampleAttributes("MID", 3)) === JSON.stringify(ai.sampleAttributes("MID", 3))
      && (() => {
        const withAttributes = new AIController(new SeededRandom(107), 107);
        const withoutAttributes = new AIController(new SeededRandom(107), 107);
        const expected = withoutAttributes.sampleStyle("MID");
        withAttributes.sampleAttributes("MID", 3);
        return JSON.stringify(withAttributes.sampleStyle("MID")) === JSON.stringify(expected);
      })());
  }

  // ================= 7. Long back-pass to the keeper remains on the grass =================
  {
    mute();
    const engine = makeEngine(108);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    const keeper = engine.players[0], passer = engine.players[3];
    keeper.pos.set(-17, 0, 0); keeper.moveTarget.copy(keeper.pos);
    passer.pos.set(-2, 0, 0); passer.moveTarget.copy(passer.pos); passer.facing = Math.PI;
    engine.ball.possess(passer.idx, passer.team);
    engine.ball.glueTo(passer.pos, passer.facing, passer.vel);
    const started = startAction(engine, passer, "pass_long", keeper.pos.clone(), keeper.idx);
    for (let i = 0; i < 90 && engine.ball.possessedBy !== null; i++) {
      const dt = 1 / 60; engine.clock += dt;
      const frame = passer.anim.update(dt, 0, 0);
      if (frame.contact) onContact(engine, passer, frame.contact);
    }
    let maxHeight = engine.ball.pos.y;
    for (let i = 0; i < 20; i++) { engine.ball.step(1 / 60); maxHeight = Math.max(maxHeight, engine.ball.pos.y); }
    unmute();
    check("a long named return to the goalkeeper is a ground pass, never a lofted chip",
      started && engine.passLog[0]?.receiver === keeper.idx && Math.abs(engine.ball.vel.y) < 1e-9 && maxHeight <= R + 0.001,
      `started=${started} receiver=${engine.passLog[0]?.receiver} vertical=${engine.ball.vel.y.toFixed(3)} maxY=${maxHeight.toFixed(3)}`);
    engine.dispose();
  }

  // ================= 8. A rushing opponent bypasses the keeper's hold time =================
  const pressuredKeeper = (firstTouch: boolean, rushing: boolean, settle = false) => {
    const engine = makeEngine(109);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    for (const p of engine.players) { p.pos.set(8, 0, p.idx % 2 ? 10 : -10); p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0); }
    const keeper = engine.players[0], striker = engine.players[9];
    keeper.pos.set(-17, 0, 0); keeper.moveTarget.copy(keeper.pos);
    engine.players[4].pos.set(10, 0, 0); engine.players[4].moveTarget.copy(engine.players[4].pos);
    striker.pos.set(rushing ? -14 : 0, 0, rushing ? 0 : 8);
    striker.vel.set(rushing ? -7 : 0, 0, 0); striker.speed = rushing ? 7 : 0;
    engine.ball.possess(keeper.idx, keeper.team); engine.ball.handsRestrictedTeam = keeper.team;
    engine.ball.glueTo(keeper.pos, 0, keeper.vel);
    if (firstTouch) startAction(engine, keeper, "first_touch");
    engine.step(1 / 60);
    const firstAction = keeper.anim.actionId, firstReason = keeper.decisionReason;
    let restarts = 0, previousAction = firstAction, previousT = keeper.anim.actionT;
    if (settle) for (let i = 0; i < 12; i++) {
      engine.step(1 / 60);
      if (previousAction === "pass_long" && keeper.anim.actionId === "pass_long" && keeper.anim.actionT + 1e-6 < previousT) restarts++;
      previousAction = keeper.anim.actionId; previousT = keeper.anim.actionT;
    }
    const result = { action: firstAction, reason: firstReason, hold: keeper.holdT, restarts };
    engine.dispose();
    return result;
  };
  {
    mute();
    const rushed = pressuredKeeper(false, true, true);
    const rushedAfterTouch = pressuredKeeper(true, true, true);
    const unpressured = pressuredKeeper(false, false);
    unmute();
    check("keeper immediately chooses a long outlet when an opponent is sprinting at him",
      rushed.action === "pass_long" && rushedAfterTouch.action === "pass_long" && rushed.reason.startsWith("GK PRESS"),
      `normal=${rushed.action}, after first touch=${rushedAfterTouch.action}; ${rushed.reason}`);
    check("pressured distribution advances continuously instead of restarting its wind-up",
      rushed.restarts === 0 && rushedAfterTouch.restarts === 0,
      `restarts=${rushed.restarts}/${rushedAfterTouch.restarts}`);
    check("keeper keeps the normal hold time when no opponent is closing",
      unpressured.action === null && unpressured.hold > 0 && unpressured.reason.startsWith("GK hold"),
      `action=${unpressured.action} hold=${unpressured.hold.toFixed(3)} ${unpressured.reason}`);
  }

  // ================= 9. Keeper smothers a moving grounded 1v1 ball =================
  {
    const players = [
      wp(0, 0, "GK", 0, -17, 0),
      wp(1, 0, "DEF", 1, -6, -8), wp(2, 0, "DEF", 2, -6, 8), wp(3, 0, "MID", 3, 0, 0), wp(4, 0, "FWD", 4, 10, 0),
      wp(5, 1, "GK", 0, 18.4, 0), wp(6, 1, "DEF", 1, 6, -8), wp(7, 1, "DEF", 2, 6, 8), wp(8, 1, "MID", 3, 0, 5),
      wp(9, 1, "FWD", 4, -14.4, 0, -5, 0, true),
    ];
    const ai = new AIController(new SeededRandom(110), 110);
    const decision = ai.think(players[0], 0, {
      ballPos: new THREE.Vector3(-14.9, R, 0), ballVel: new THREE.Vector3(-5, 0, 0), ballOwner: 9, ballOwnerTeam: 1,
      players, time: 10, half: 1, matchSeed: 110, ballKickAge: 1,
    }, 10);
    check("keeper starts the hands smother before the striker reaches point-blank range",
      decision.action === "gk_catch", `${decision.action} · ${decision.reason}`);

    mute();
    const engine = makeEngine(111);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    for (const p of engine.players) { p.pos.set(10, 0, p.idx % 2 ? 11 : -11); p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0); }
    const keeper = engine.players[0], striker = engine.players[9];
    keeper.pos.set(-16.8, 0, 0); keeper.moveTarget.copy(keeper.pos); keeper.facing = 0;
    striker.pos.set(-14.5, 0, 0); striker.moveTarget.copy(striker.pos); striker.facing = Math.PI;
    striker.vel.set(-3, 0, 0); striker.speed = 3;
    engine.ball.possess(striker.idx, striker.team); engine.ball.handsRestrictedTeam = null;
    engine.ball.glueTo(striker.pos, striker.facing, striker.vel);
    let sawCatch = false;
    for (let i = 0; i < 60 && engine.ball.possessedBy !== keeper.idx; i++) {
      engine.step(1 / 60);
      if (keeper.anim.actionId === "gk_catch") sawCatch = true;
    }
    unmute();
    check("grounded moving ball stays eligible for the contact-frame hands smother",
      sawCatch && engine.ball.possessedBy === keeper.idx,
      `sawCatch=${sawCatch} owner=${engine.ball.possessedBy}`);
    engine.dispose();
  }

  // ================= 5b. A dribbler inside the box is smothered by the keeper ========
  {
    for (const seed of [131, 132]) {
      mute();
      const engine = makeEngine(seed);
      engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
      for (const p of engine.players) { p.pos.set(10, 0, 20 - p.idx); p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0); }
      const striker = engine.players.find((p) => p.team === 1 && p.role === "FWD")!;
      const keeper = engine.players.find((p) => p.team === 0 && p.role === "GK")!;
      keeper.pos.set(-19.2, 0, 0); keeper.moveTarget.copy(keeper.pos); keeper.facing = 0;
      striker.pos.set(-12, 0, 1.5); striker.moveTarget.copy(striker.pos); striker.facing = Math.PI;
      engine.ball.possess(striker.idx, 1);
      engine.ball.glueTo(striker.pos, striker.facing, striker.vel);
      engine.humanIdx = striker.idx; engine.humanTeam = 1; engine.spectator = false;
      engine.keys.add("a");                       // the striker dribbles straight at goal
      let claimedAt = -1;
      for (let f = 0; f < 60 * 3; f++) {
        engine.step(1 / 60);
        if (engine.ball.possessedBy === keeper.idx) { claimedAt = f; break; }
        if (engine.rules.phase === "GOAL") break;
      }
      unmute();
      check("a keeper rushes out and takes the ball off a dribbler inside his own box",
        claimedAt >= 0 && engine.rules.phase !== "GOAL" && keeper.anim.actionId === "gk_catch",
        `claimed at ${claimedAt >= 0 ? (claimedAt / 60).toFixed(2) + "s" : "never"}, phase ${engine.rules.phase}, action ${keeper.anim.actionId}`);
      engine.dispose();
    }
  }

  // ================= 6. Movement feel: explosive first step, planted turns =================
  // The harness fixture parks everyone 18 m away and gives the ball to the human, so
  // only his own locomotion is measured.
  const movementFixture = (seed: number) => {
    const engine = makeEngine(seed);
    engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
    for (const p of engine.players) { p.pos.set(-18, 0, (p.idx - 6) * 0.5); p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0); }
    const human = engine.players[4];
    human.pos.set(0, 0, 0); human.moveTarget.copy(human.pos); human.vel.set(0, 0, 0); human.facing = 0;
    engine.humanIdx = human.idx; engine.humanTeam = 0; engine.spectator = false;
    engine.ball.possess(human.idx, 0);
    return { engine, human };
  };
  {
    mute();
    const { engine, human } = movementFixture(120);
    engine.keys.add("d");
    const speeds: number[] = [];
    for (let f = 0; f < 120; f++) { engine.step(1 / 60); speeds.push(human.speed); }
    const runTop = human.speed;
    unmute();
    check("a run starts from a standstill instead of snapping to top speed",
      speeds[0] < 0.4 && speeds[8] > 0.9 && speeds[8] < CONFIG.player.runSpeed,
      `first frame ${speeds[0].toFixed(2)} m/s, 0.15 s ${speeds[8].toFixed(2)} m/s`);
    check("acceleration is explosive off the mark: half of jog speed inside 0.25 s",
      speeds[14] > CONFIG.player.runSpeed * 0.35 && runTop > CONFIG.player.runSpeed * 0.92,
      `0.25 s ${speeds[14].toFixed(2)} m/s, top ${runTop.toFixed(2)} m/s`);
    engine.dispose();
  }
  {
    mute();
    const { engine, human } = movementFixture(121);
    engine.keys.add("d"); engine.keys.add("shift");
    for (let f = 0; f < 120; f++) engine.step(1 / 60);
    const sprintTop = human.speed;
    unmute();
    check("sprint reaches a genuinely higher top speed than a jog", sprintTop > CONFIG.player.runSpeed * 1.2,
      `sprint ${sprintTop.toFixed(2)} m/s vs jog ${CONFIG.player.runSpeed} m/s`);
    engine.dispose();
  }
  {
    mute();
    const { engine, human } = movementFixture(122);
    engine.keys.add("d");
    for (let f = 0; f < 90; f++) engine.step(1 / 60);
    const before = human.speed;
    engine.keys.delete("d"); engine.keys.add("a");
    const after: number[] = [];
    for (let f = 0; f < 110; f++) { engine.step(1 / 60); after.push(human.speed); }
    const planted = Math.min(...after);
    unmute();
    check("a full reversal plants the foot instead of flipping the velocity in one frame",
      before > 3.5 && after[0] > before * 0.85 && planted < 1 && human.vel.x < -3,
      `before ${before.toFixed(2)} m/s, first frame ${after[0].toFixed(2)} m/s, planted at ${planted.toFixed(2)} m/s, ended vx ${human.vel.x.toFixed(2)}`);
    engine.dispose();
  }
  {
    mute();
    const { engine, human } = movementFixture(123);
    engine.keys.add("d");
    for (let f = 0; f < 90; f++) engine.step(1 / 60);
    const before = human.speed;
    engine.keys.delete("d"); engine.keys.add("s");
    for (let f = 0; f < 40; f++) engine.step(1 / 60);
    const cutSpeed = human.speed;
    unmute();
    check("a 90° cut costs speed before the new direction is taken up",
      cutSpeed < before * 0.85 && Math.abs(human.vel.z) > 1.5 && Math.abs(human.vel.x) > 1,
      `before ${before.toFixed(2)} m/s, after the cut ${cutSpeed.toFixed(2)} m/s, vel (${human.vel.x.toFixed(2)}, ${human.vel.z.toFixed(2)})`);
    engine.dispose();
  }

  // ================= 7. Body orientation: shield, side-step, correct foot =================
  {
    mute();
    const { engine, human } = movementFixture(124);
    const opp = engine.players[9];
    opp.pos.set(0, 0, -2); opp.moveTarget.copy(opp.pos); opp.vel.set(0, 0, 0); opp.facing = Math.PI;
    engine.keys.add("d");
    for (let f = 0; f < 90; f++) engine.step(1 / 60);
    const openSpeed = human.speed;
    const { engine: shieldEngine, human: shieldHuman } = movementFixture(124);
    const marker = shieldEngine.players[9];
    marker.pos.set(0, 0, -2); marker.moveTarget.copy(marker.pos); marker.vel.set(0, 0, 0); marker.facing = Math.PI;
    shieldEngine.keys.add("f"); shieldEngine.keys.add("d");
    for (let f = 0; f < 18; f++) shieldEngine.step(1 / 60);
    const shielded = shieldHuman.shielding;
    const facingAway = yawOf(0, 1);
    const shieldTurn = Math.abs(yawDelta(shieldHuman.facing, facingAway));
    unmute();
    check("holding shield puts the body between the ball and the nearest opponent",
      shielded && shieldTurn < 0.45 && shieldHuman.vel.x > 1.5,
      `shielding=${shielded} facing error ${(shieldTurn * 180 / Math.PI).toFixed(0)}° while moving x ${shieldHuman.vel.x.toFixed(2)}`);
    check("shielding costs speed, so side-stepping is a choice and not free",
      shieldHuman.speed < openSpeed * 0.8,
      `shielded ${shieldHuman.speed.toFixed(2)} m/s vs open ${openSpeed.toFixed(2)} m/s`);
    engine.dispose();
    shieldEngine.dispose();
  }
  {
    mute();
    const { engine, human } = movementFixture(125);
    engine.keys.add("s");   // straight back down the pitch, ball at his feet
    for (let f = 0; f < 60; f++) engine.step(1 / 60);
    const goalYaw = Math.atan2(-(0 - human.pos.z), (CONFIG.pitch.length / 2 + 4) - human.pos.x);
    const openTurn = Math.abs(yawDelta(human.facing, goalYaw));
    const moving = human.vel.z;
    unmute();
    check("running across the pitch the hips stay open to goal instead of following the stride",
      openTurn < 0.4 && moving > 1.5,
      `facing error ${(openTurn * 180 / Math.PI).toFixed(0)}°, lateral speed ${moving.toFixed(2)} m/s`);
    engine.dispose();
  }
  {
    mute();
    const kickFixture = (targetZ: number) => {
      const engine = makeEngine(126);
      engine.rules.phase = "INPLAY"; engine.rules.pendingRestart = null;
      // Everyone else is parked upfield of the passer, so the receiver is onside and a
      // 45° target is a legal delivery instead of an offside or behind-the-back kick.
      for (const p of engine.players) { p.pos.set(9, 0, (p.idx - 6) * 0.5); p.moveTarget.copy(p.pos); p.vel.set(0, 0, 0); p.facing = 0; }
      const passer = engine.players[4];
      passer.pos.set(0, 0, 0); passer.moveTarget.copy(passer.pos); passer.facing = 0;
      const mate = engine.players[3];
      mate.pos.set(6, 0, targetZ * 1); mate.moveTarget.copy(mate.pos);
      engine.ball.possess(passer.idx, 0);
      engine.ball.glueTo(passer.pos, passer.facing, passer.vel);
      const started = startAction(engine, passer, "pass_short", mate.pos.clone());
      const strike = passer.strikeFoot;
      engine.dispose();
      return { strike, started };
    };
    const toLeft = kickFixture(-6);
    const toRight = kickFixture(6);
    unmute();
    check("a kick is struck with the foot on the target's side of the body",
      toLeft.strike === "L" && toRight.strike === "R" && toLeft.started && toRight.started,
      `target left → ${toLeft.strike}, target right → ${toRight.strike}`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
