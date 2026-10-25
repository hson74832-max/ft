/**
 * Receiver-awareness regressions: the two reported player-intelligence defects.
 *
 *  1. Passing to unreceptive / blind teammates — a passer must not play the ball
 *     into a teammate's back, and a pressed carrier must get a check-to-the-ball
 *     movement from his support.
 *  2. Failing to read and lead a run — the ball must be aimed ahead of a runner,
 *     and a dynamic run into dangerous space must be valued over a safe stop.
 *
 * Run: npx esbuild scripts/receiver-awareness.ts --bundle --platform=node --format=cjs
 *      --outfile=.test-artifacts/receiver-awareness.cjs && node .test-artifacts/receiver-awareness.cjs
 */
import { headlessEngineCanvas } from "./harness";   // installs the headless DOM shim on import
import assert from "node:assert/strict";
import * as THREE from "three";
import { AIController, type WorldPlayer, type WorldSnap } from "../src/game/ai";
import { CONFIG } from "../src/game/config";
import { SeededRandom } from "../src/game/random";
import { yawOf } from "../src/game/angles";
import { MatchEngine } from "../src/game/engine";

const roles = ["GK", "DEF", "DEF", "MID", "FWD"];
type Spec = { idx: number; team: number; pos: [number, number]; facing?: number; vel?: [number, number] };

function build(seed: number, specs: Spec[], carrierIdx: number) {
  const ai = new AIController(new SeededRandom(seed), seed);
  const players: WorldPlayer[] = specs.map((s) => {
    const role = roles[s.idx % 5];
    const vel = s.vel ? new THREE.Vector3(s.vel[0], 0, s.vel[1]) : new THREE.Vector3();
    return {
      idx: s.idx, team: s.team, role, roleIdx: s.idx % 5,
      pos: new THREE.Vector3(s.pos[0], 0, s.pos[1]), vel,
      facing: s.facing ?? 0, speed: vel.length(),
      busy: false, uninterruptible: false, cooldowns: new Map(), stamina: 1,
      hasBall: s.idx === carrierIdx, callForBall: false, isHuman: false, runSerial: 0,
      style: ai.sampleStyle(role),
    } as WorldPlayer;
  });
  const carrier = players.find((p) => p.idx === carrierIdx)!;
  // The live engine orients an idle player toward the ball; the carrier keeps his
  // attacking body angle for the run trigger. An explicit `facing` in the spec wins.
  for (const p of players) {
    if (p === carrier) continue;
    const spec = specs.find((s) => s.idx === p.idx);
    if (spec?.facing === undefined) p.facing = yawOf(carrier.pos.x - p.pos.x, carrier.pos.z - p.pos.z);
  }
  carrier.facing = 0;
  const snap: WorldSnap = {
    ballPos: carrier.pos.clone().setY(CONFIG.ball.radius), ballVel: new THREE.Vector3(),
    ballOwner: carrier.idx, ballOwnerTeam: carrier.team, players, time: 10, half: 1, matchSeed: seed,
    ballKickAge: 1, ownerSince: 9.6,
  };
  return { ai, snap, carrier, players };
}

/** The outfield block used by the passing scenarios: two receptive wide men, opponents deep. */
function passingWorld(extra: Spec[]) {
  return [
    { idx: 0, team: 0, pos: [-17, 0] },
    { idx: 1, team: 0, pos: [3, -4] },
    { idx: 2, team: 0, pos: [3, 4] },
    { idx: 3, team: 0, pos: [0, 0] },
    ...extra,
    { idx: 5, team: 1, pos: [18, 0] },
    { idx: 6, team: 1, pos: [11, 6] },
    { idx: 7, team: 1, pos: [12, -6] },
    { idx: 8, team: 1, pos: [14, 0] },
    { idx: 9, team: 1, pos: [13, 3] },
  ];
}

let count = 0;
function test(name: string, fn: () => void) { fn(); console.log(`PASS ${name}`); count++; }

// ---------------------------------------------------------------- 1. receptive stance
test("a stationary teammate turned away from the pass is heavily penalised", () => {
  // Same picture twice: the forward (idx 4) either faces the carrier or has his back to him.
  const turned = build(11, passingWorld([{ idx: 4, team: 0, pos: [7, 0], facing: 0 }]), 3);
  const receptive = build(11, passingWorld([{ idx: 4, team: 0, pos: [7, 0], facing: Math.PI }]), 3);
  const score = (f: ReturnType<typeof build>) => {
    const opt = (f.ai.think(f.carrier, f.carrier.idx, f.snap, 10).passOptions ?? [])
      .find((o) => o.receiver === 4);
    return opt?.score ?? -99;
  };
  const away = score(turned), toward = score(receptive);
  assert(away <= toward - CONFIG.tactics.blindPassPenalty, `blind pass scored ${away.toFixed(3)} vs receptive ${toward.toFixed(3)}`);
});

test("a back-turned teammate is not chosen when a receptive option exists", () => {
  const f = build(11, passingWorld([{ idx: 4, team: 0, pos: [7, 0], facing: 0 }]), 3);
  const opts = f.ai.think(f.carrier, f.carrier.idx, f.snap, 10).passOptions ?? [];
  const best = opts.reduce((a, b) => (b.score > a.score ? b : a), opts[0]!);
  assert(best && best.receiver !== 4, `back-turned teammate won with ${JSON.stringify(opts)}`);
});

test("a teammate sprinting away from the ball is heavily penalised", () => {
  // idx 4 sprints 60° off the forward line (away from the ball's path) into a tight
  // channel, so he is not a committed forward run.
  const running = build(12, passingWorld([
    { idx: 4, team: 0, pos: [6, 0], vel: [3.25, 5.63], facing: yawOf(3.25, 5.63) },
    { idx: 6, team: 1, pos: [8, 4] },
    { idx: 9, team: 1, pos: [13, 3] },
  ]), 3);
  const receptive = build(12, passingWorld([{ idx: 4, team: 0, pos: [6, 0] }]), 3);
  const score = (f: ReturnType<typeof build>) => {
    const opt = (f.ai.think(f.carrier, f.carrier.idx, f.snap, 10).passOptions ?? [])
      .find((o) => o.receiver === 4);
    return opt?.score ?? -99;
  };
  const away = score(running), toward = score(receptive);
  assert(away <= toward - 0.3, `sprinting-away pass scored ${away.toFixed(3)} vs receptive ${toward.toFixed(3)}`);
});

test("a teammate sprinting into space ahead is not treated as blind", () => {
  // A clean forward run: high velocity, forward attack vector, open space ahead.
  const f = build(13, passingWorld([{ idx: 4, team: 0, pos: [6, 0], vel: [6.5, 0], facing: 0 }]), 3);
  const opt = (f.ai.think(f.carrier, f.carrier.idx, f.snap, 10).passOptions ?? [])
    .find((o) => o.receiver === 4)!;
  assert(opt.score > 0.8, `a led forward run should score well, got ${opt.score.toFixed(3)}`);
});

// ---------------------------------------------------------------- 2. check to the ball
test("a pressed carrier triggers a check-to-the-ball movement", () => {
  const f = build(5, [
    { idx: 0, team: 0, pos: [-17, 0] },
    { idx: 1, team: 0, pos: [4, 0] },
    { idx: 2, team: 0, pos: [3, 6] },
    { idx: 3, team: 0, pos: [0, 0] },
    { idx: 4, team: 0, pos: [8, 0] },
    { idx: 5, team: 1, pos: [18, 0] },
    { idx: 6, team: 1, pos: [2.2, 1.2] },
    { idx: 7, team: 1, pos: [12, -6] },
    { idx: 8, team: 1, pos: [14, 0] },
    { idx: 9, team: 1, pos: [13, 3] },
  ], 3);
  const plan = f.ai.tactics.plan(f.snap, 0)!;
  const runner = [...plan.assignments.values()].find((a) => a.job === "runner")!;
  assert(runner.runType === "check", `pressed carrier should check to the ball, got run=${runner.runType}`);
  const p = f.players.find((q) => q.idx === 4)!;
  const dec = f.ai.think(p, p.idx, f.snap, 10);
  assert(dec.runType === "check", `runner decision should be a check, got ${dec.runType} ${dec.reason}`);
  // He drops toward the ball, not away from it.
  assert(dec.moveTarget.x < p.pos.x - 1, `runner did not drop toward the ball: ${dec.moveTarget.x.toFixed(1)} vs ${p.pos.x.toFixed(1)}`);
});

test("an unpressed carrier does not trigger a check", () => {
  const f = build(5, [
    { idx: 0, team: 0, pos: [-17, 0] },
    { idx: 1, team: 0, pos: [4, 0] },
    { idx: 2, team: 0, pos: [3, 6] },
    { idx: 3, team: 0, pos: [0, 0] },
    { idx: 4, team: 0, pos: [8, 0] },
    { idx: 5, team: 1, pos: [18, 0] },
    { idx: 6, team: 1, pos: [13, 6] },
    { idx: 7, team: 1, pos: [13, -6] },
    { idx: 8, team: 1, pos: [16, 0] },
    { idx: 9, team: 1, pos: [15, 3] },
  ], 3);
  const plan = f.ai.tactics.plan(f.snap, 0)!;
  assert([...plan.assignments.values()].every((a) => a.runType !== "check"), "no check expected without pressure");
});

// ---------------------------------------------------------------- 3. lead the run
test("a named pass is aimed ahead of a running teammate", () => {
  const engine = new MatchEngine(headlessEngineCanvas(), { seed: 21, headless: true, spectator: true });
  engine.rules.phase = "INPLAY"; engine.rules.half = 1; engine.rules.pendingRestart = null;
  const carrier = engine.players[3];
  const runner = engine.players[4];
  carrier.pos.set(0, 0, 0); carrier.vel.set(0, 0, 0); carrier.facing = 0;
  runner.pos.set(6, 0, 0); runner.vel.set(6.5, 0, 0); runner.facing = 0;
  engine.players[1].pos.set(-2, 0, -5); engine.players[2].pos.set(-2, 0, 5);
  engine.players[5].pos.set(18, 0, 0);
  // Two blockers shut the central lane, so the run trigger is off and the runner is
  // on a "hold" assignment — his real sprint speed must still lead the pass.
  engine.players[6].pos.set(4, 0, 1); engine.players[7].pos.set(4, 0, -1);
  engine.players[8].pos.set(14, 0, 6); engine.players[9].pos.set(14, 0, -6);
  engine.ball.pos.copy(carrier.pos).setY(CONFIG.ball.radius);
  engine.ball.possess(carrier.idx, carrier.team);
  const preview = engine.ai.passPreview(carrier.idx, runner.idx, "pass_short");
  engine.dispose();
  assert(preview, "pass preview missing");
  const ahead = preview!.target.x - runner.pos.x;
  assert(ahead >= runner.vel.length() * 0.3,
    `pass was not led ahead of the runner: ${ahead.toFixed(2)}m ahead for a ${runner.vel.length().toFixed(1)} m/s run`);
});

// ---------------------------------------------------------------- 4. intention reward
test("a dynamic run into dangerous space beats a safe stationary pass", () => {
  const f = build(4, [
    { idx: 0, team: 0, pos: [-17, 0] },
    { idx: 1, team: 0, pos: [2, -5] },
    { idx: 2, team: 0, pos: [-2, 4] },
    { idx: 3, team: 0, pos: [0, 0] },
    { idx: 4, team: 0, pos: [8, 0], vel: [6.5, 0], facing: 0 },
    { idx: 5, team: 1, pos: [18, 0] },
    { idx: 6, team: 1, pos: [13, 6] },
    { idx: 7, team: 1, pos: [13, -6] },
    { idx: 8, team: 1, pos: [16, 0] },
    { idx: 9, team: 1, pos: [15, 3] },
  ], 3);
  const opts = f.ai.think(f.carrier, f.carrier.idx, f.snap, 10).passOptions ?? [];
  const runner = opts.find((o) => o.receiver === 4)!;
  const safe = opts.find((o) => o.receiver === 1)!;
  assert(runner.score > safe.score + CONFIG.tactics.runIntentReward - 0.01,
    `dynamic run (${runner.score.toFixed(3)}) did not clearly beat the safe pass (${safe.score.toFixed(3)})`);
});

console.log(`\n${count} RECEIVER-AWARENESS REGRESSIONS PASSED`);
