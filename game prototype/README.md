# Rush Arena — 5v5 Football Prototype

A playable, animation-driven 5v5 football prototype (4 outfield + goalkeeper per side, Harbor City vs Redwood Rangers) built with React, Vite, Tailwind and Three.js.

## Real measurements

Every tuning value lives in `src/game/config.ts` in real-world units (m, m/s, m/s², kg).
`CONFIG` is what the simulation runs on; `REAL_DATA` in the same file is the full reference
dataset `[mean, min, max]` with provenance (OFFICIAL / CALCULATED / ESTIMATE), including
figures the sim does not yet consume (match densities, anthropometry, test batteries).

| Quantity | Value in engine | Dataset [mean · min–max] |
| --- | --- | --- |
| Ball radius / mass | 0.109 m / 0.43 kg | 0.109 · 0.108–0.111 / 0.43 · 0.41–0.45 |
| Gravity / air density | 9.81 m/s² / 1.2 kg/m³ | 9.81 / 1.2 |
| **Drag (speed-dependent)** | Cd 0.50 below 10 m/s → 0.25 above 14 m/s | required: "must be speed-dependent" |
| Magnus lift coefficient | up to 0.29 | 0.25 · 0.23–0.29 |
| Restitution (grass) | 0.65 vertical, 0.65 horizontal | 0.65 · 0.55–0.75 |
| Rolling resistance | μ=0.10 → 0.98 m/s² (μ·g) | 0.10 · 0.06–0.15 |
| Spin: shot / free kick / pass | 350 / 450 / 200 rpm | same (converted to rad/s) |
| Walk / jog / run / HSR / sprint | 2.0 / 3.5 / 5.0 / 5.5 / 7.0 m/s | velocity-zone cut-offs |
| Max match velocity | 8.75 m/s (31.5 km/h) | 8.75 · 7.8–10.5 |
| Peak accel / decel | 5.0 / 6.0 m/s² | 5.0 · 4.0–6.5 / 6.0 · 4.5–7.0 |
| Mean match velocity / jump | 1.75 m/s / 0.42 m | 1.75 / 0.42 |
| Short / medium / long ball | 11 / 16 / 24 m/s | 11 · 8–14 / 16 / 24 · 20–28 |
| Shot / header / punt | 24 / 15 / 23 m/s | 24 · 14–32 / 15 / 23 |
| AI delay outfield / GK | 0.28 / 0.35 s | 0.28 · 0.20–0.40 / 0.35 · 0.25–0.50 |
| GK save reaction | 0.20 s | simple RT 0.20 · 0.18–0.22 |

Ball physics (`stepBallPhysics` / `kickBall` / `dragCoefficientAt` in `src/game/ball.ts`,
pure and unit-tested): **speed-dependent** quadratic aero drag across the drag crisis,
Magnus lift from real rpm spin, grass bounce with separate vertical/horizontal restitution,
and rolling resistance as μ·g. Players integrate real acceleration (5 m/s²) and braking
(6 m/s²) with plant-and-cut momentum bleed and a stamina-scaled top speed, so direction
changes and sprints cost time as in the data.

The playable pitch is a small-sided 5-a-side arena by design; the OFFICIAL full-size
geometry (105 × 68 m, 7.32 × 2.44 m goal) is recorded in `REAL_DATA.fullPitch`.

## Run

```bash
npm install
npm run dev
npm run build      # emits dist/index.html (single file) + public assets
```

Open the menu, then:
- **Play Match** — control the HBC (red) forward; AI controls the other nine.
- **Watch CPU vs CPU** — spectator build for tuning.
- **Motion Lab** — import FieldMotion `.json` clips.
- **Settings** — AI difficulty knobs, offside, fouls, time scale.

## Controls

| Input | Action |
| --- | --- |
| WASD / arrows | Move (5 m/s) |
| Shift | Sprint (8.5 m/s, drains stamina) |
| Space (hold) | Pass — hold to charge from short (12 m/s) to long (20 m/s) |
| E (hold) | Shoot — hold to charge power; tap/Q for finesse |
| Q | Through-ball modifier |
| F | Tackle (off ball) / shield (on ball) |
| X | Switch player |
| V | Toggle spectator |
| C | Broadcast → follow → free camera |
| T / G / H | Raw aim / AI target lines / animation debug |
| Esc | Pause · Tab opens the data drawer in-match |

## What is enforced

- **Kickoff** at the centre spot with a chosen taker; all opponents are outside the centre circle in their own half; the first ball is played forward. Restarts wait if the exclusion zone is not clear.
- **Goals** only register when the whole ball has crossed the goal line inside the posts, below the bar and inside the net volume. Goals cannot register while the match is out of play or in a foul/restart state.
- **Restarts**: goal kicks are taken by the defending keeper from the goal area; corners by the closest eligible outfielder at the correct flag; throw-ins by the closest eligible outfielder at the exit point on the correct touchline. The ball is frozen at the restart spot until the animation contact event releases it. A contact-window watchdog releases the ball rather than looping a restart.
- **Half time**: clock stops, ends swap, score is preserved, and the side that did not kick off first restarts the second half.
- **Offside** is judged at the pass from open play and enforced on involvement (no offside from throw-ins, corners or goal kicks). AI support targets are clamped onside and offside runners are excluded from pass candidate scoring.
- **Possession** changes only through an animation / ball event: loose-ball control, interception, tackle contact with the ball, or a keeper catch. The animated carrier is the credited owner.
- **Collision**: player cylinders and the loose ball are resolved every frame; players cannot stack into the same position.

## Behaviour variety

A single match seed (recorded in match state) drives one PRNG for AI decisions and sampled restart targets. Contact resolution never reads it. Each player gets style weights sampled once per match. Utility choices carry a novelty penalty and stable per-player/per-run tie-break hashes, so equal states don't always resolve by iteration order. Action seeds are recorded in the debug drawer.

## FieldMotion v2 import

Motion Lab accepts `.json` files shaped like:

```json
{
  "format": "fieldmotion.pose.v2",
  "jointOrder": ["pelvis", "...21 joints"],
  "boneOrder": [["pelvis", "spine"], "..."],
  "bindPose": [0, 1.04, 0, "..."],
  "frames": [{ "t": 0, "c": 0.97, "h": 0, "j": [0, 1.04, 0, "..."], "q": [0, 0, 0, 1, "..."] }],
  "metadata": {
    "id": "my_clip", "category": "pass", "loop": false, "rootMotion": false,
    "duration": 0.8, "contactFrame": 0.5, "interruptible": [0, 0.35], "priority": 6,
    "frameEvents": [{ "t": 0.4, "type": "ball_contact" }]
  }
}
```

`frames[].j` (joint positions in `jointOrder`) is authoritative: the importer retargets world limb directions onto the game rig's bones, which keeps limb lengths exact and makes an A-pose source (arms angled out) and this rig (arms hanging) resolve to the same pose. `frames[].q` is accepted and validated for tooling compatibility. Every clip is validated against the shared 21-bone contract and becomes available to the animation controller and Motion Lab preview. The sample at `public/motions/sample_fieldmotion.json` is loadable from Motion Lab.

### Generated game pack

`public/motions/game-motion-pack.json` is produced by the animation generator in `tool/`
and holds 32 clips authored on the same skeleton — locomotion cycles, passes, shots,
header, tackles, keeper actions, restarts, turns and recoveries. Each clip carries
`metadata.slot`, so the game loads the pack on startup (`loadGeneratedMotionPack()` in
`src/main.tsx`) and every clip is bound to the gameplay action it drives; the match plays
generated animation with contact at the authored contact frames. Motion Lab's **Load
generated game pack** button reports the bindings, and any pack can be dragged in by hand. Regenerating, the clip ↔ slot table, the root-motion
axis convention and the automated checks are documented in
[`docs/MOTION-PIPELINE.md`](docs/MOTION-PIPELINE.md).

## Architecture

```
src/game/
  config.ts      real-measurement tuning, skeleton contract, animation catalogue, formations
  skeleton.ts    bone construction + contract validation
  anims.ts       2D locomotion blend space, actions, crossfade, IK snap, root motion
  motion.ts      FieldMotion v2 parser/sampler + registry
  playerMesh.ts  procedural Blocky / Roundy rigs, seeded variants, stress test
  ball.ts        pure real-physics step/kick functions + Ball wrapper (single source of truth)
  rules.ts       match phases, halves, score, typed rule events
  ai.ts          spatial utilities, marking, offside, keeper AI, seeded style
  tactics.ts     shared pivot/outlet/runner assignments, candidate positions, lane safety
  passing.ts     same-team receiver checks and acceleration-aware reception prediction
  random.ts      match PRNG + stable tie-break hashes
  restartRules.ts pure kickoff legality checks (regression-tested)
  engine.ts      world, input, collisions, restarts, cameras, snapshot
src/ui/          Rush Arena menu, scorebug, HUD, data drawer, panels
  gameclip.ts (in tool/)       generated clip specs: FK from joint angles + slot metadata
scripts/selftest.ts            headless checks: rules, RNG, FieldMotion, physics, AI awareness
scripts/kickoff-regression.ts  headless kickoff legality checks
scripts/support-regression.ts mirrored reset/width/run/shooting and keeper-foot scenarios
scripts/support-match.ts      complete seeded matches and exact trajectory replay checks
scripts/attacking-runs.ts     regression suite for off-ball runs, progressive intent, transition
scripts/motion-pipeline.ts    generator → pack → slot bindings → controller → live match checks
```

## AI instrumentation & deterministic reproduction

**In the browser:** append `?debug=ai` to the URL. Each frame, before the player loop, every player gets a trace row. Once per second the console prints a table with `idx, team, role, hasBall, branch, thinkCalled, thinkFresh, decisionReason, actionReturned, startActionResult, animBusy, animUninterruptible, animActionId, moveTarget, desiredSpeed, speed, overwrittenBy`, plus explicit warnings such as `CARRIER STALL` or `move target overwritten by restartHold`. Discrete events (possession granted, kick released or cancelled, tackle/intercept won or missed, keeper catch/parry/miss with distances) are logged as they happen.

`branch` names who controlled the player that frame: `ai`, `human`, `restartHold`, `frozen`, `gkHold`. `startActionResult` is `ok:<clip>`, `rejected:<clip>(cooldown…)`, `skipped:locked(<clip>)` or `skipped:cached-decision`.

**Headless (Node), same engine, fixed seed:**

```bash
npx esbuild scripts/ai-repro.ts --bundle --platform=node --format=cjs --outfile=/tmp/ai-repro.cjs
node /tmp/ai-repro.cjs 1234 240           # seed, seconds → aggregate metrics
node /tmp/ai-repro.cjs 1234 240 --trace   # + full per-second tables and event log
SHOTLOG=1 node /tmp/ai-repro.cjs 42 240   # keeper state at every shot
node /tmp/ai-repro.cjs --gk               # controlled keeper grid: distance × placement × pace
GKCASE="20,1.3,25,0.06" node /tmp/ai-repro.cjs --gk   # trace one grid case
```

With the same seed, inputs and fixed 1/60 s steps, the headless runs reproduce the same output. `new MatchEngine(canvas, { seed, headless: true })` runs the real simulation without a GPU. A seed alone does not fix variable browser frame timing or human input timing.

## Self-test

```bash
npx esbuild scripts/selftest.ts --bundle --platform=node --format=cjs --outfile=/tmp/selftest.cjs
node /tmp/selftest.cjs
npx esbuild scripts/kickoff-regression.ts --bundle --platform=node --format=cjs --outfile=/tmp/kickoff.cjs
node /tmp/kickoff.cjs
npx esbuild scripts/tactics-test.ts --bundle --platform=node --format=cjs --outfile=/tmp/tactics.cjs
node /tmp/tactics.cjs
npx esbuild scripts/support-regression.ts --bundle --platform=node --format=cjs --outfile=/tmp/support.cjs
node /tmp/support.cjs
npx esbuild scripts/support-match.ts --bundle --platform=node --format=cjs --outfile=/tmp/support-match.cjs
node /tmp/support-match.cjs
```

Covers kickoff/half-time/full-time flow, cross-seed determinism, FieldMotion parsing/sampling, real-measurement physics (free-fall drop time, speed-dependent aero drag, Magnus curve, rolling stop, shot height, speed cap), centre-back lane closure, offside detection and support spacing.

**Tactics regression (`scripts/tactics-test.ts`, real engine headless):** clear close-range shooting, reachable channels, central cover plus width, defensive compaction, lofted corners, and short/long keeper options. The old assertion forcing the forward to the opposite touchline was replaced: that behavior caused the isolation regression.

## Coordinated possession

- `CONFIG.tactics` contains all new spacing, decision and run-timing thresholds. These are prototype tuning values, not claimed physiological measurements.
- The three off-ball outfielders get distinct jobs: a central **pivot** behind the carrier, an **outlet** choosing between width/half-space/drop, and a **runner** looking for a channel or box arrival. Jobs are reassigned when possession changes, with hysteresis to avoid frame-to-frame swaps. The keeper offers a fourth, deeper reset angle.
- Pivot targets stay in a +/-3 m central band, generally 5.5-9 m behind the ball. Width is not an instruction to hug a line: candidate points are scored for passing distance, lane safety, opponent space, peer spacing and continuity.
- A safe forward opening is preferred to recycling. When forward routes are blocked or the carrier is pressed, a safe pivot/keeper pass can win. Marked receivers and obstructed lanes are penalized. Short central returns without progress are penalized when there is time and space to advance.
- Named keeper receivers are accepted by both the AI and contact-frame pass planner. A deliberate foot backpass sets the ball's hands restriction, is received with `first_touch`, and is distributed with the feet. It is not logged as a save or caught with the hands.
- Runs stage onside before a pass; `PassFlight` commits the named receiver to its predicted reception point after release. Other teammates maintain support rather than all chasing the free ball. Prediction uses bounded acceleration toward the selected run, not an arbitrary through-ball offset.
- Open shots at the edge of the area and clear close chances take priority over safe square passes. Blocked lanes or tight angles still permit recycling; there is no forced shot/goal probability. Cooldowns are checked per available shot clip.
- Novelty history records accepted actions, not every repeated evaluation of the same action. Thus a good chance is not penalized just because the AI has been watching it.
- **Space scanning and run types.** Every support candidate is scored on vacant ground ahead, not only on being unmarked. Runs are classified as `check` (drop short into space to offer a safe outlet under pressure), `spin` (attack the space behind the defensive line, clamped onside) or `drive` (carry the run into midfield space), plus `hold` for a support position. A committed run is held for `CONFIG.tactics.runCommitSeconds` and re-led when the player reaches the target instead of being re-picked every tick.
- **Run trigger.** `readRunTrigger` fires when the carrier is facing forward (dot with the attack direction), has more than `runTriggerTimeOnBall` seconds on the ball and either has room or an open forward lane. While the trigger is off, spin/drive runs are penalised and the short `check` is preferred — runs happen when the carrier can actually use them.
- **Attacking transition.** A change of possession team opens a `transitionUntil` window (`transitionSeconds`). During it the plan reports phase `transition`: support runners push forward, the pivot may drive instead of holding central cover, and the carrier's phase weights make progression the dominant term, with the through ball and forward carry scored first.
- **Progression is a first-class utility.** The carrier scores shots, passes and carries on the same scale: shot utility from range, lane and goal opening; pass utility from lane safety, receiver space, forward gain, line breaks, penetration and switch bonuses minus crowding and hazard; carry utility from forward space. A partially blocked shooting lane (`shotPartialLane`) is still a shot, and a blocked forward lane is scored low rather than discarded.

Open **Data** in a match to inspect each player's job, position target, receiver-option lane/space/utility scores, and actual recycle, penetration, shot and keeper-foot-control counters. `?debug=ai` retains the per-frame control-path trace.

`support-regression.ts` covers both teams and halves, every outfield carrier role, pressured pivot resets, keeper-pass release/control, marked-wide alternatives, onside staging/post-release runs, open-edge shots and actual player movement into central cover. `support-match.ts` runs seeds 1234, 777 and 42 to FULLTIME, replays 1234, and compares actual pass trajectories and final state, not just debug text. It also reports **actual** central-cover occupancy separately from planned cover; neither is assumed to be 100% during transitions.

`npm run verify:motion` builds the animation pack from `tool/src/gameclip.ts` and checks the whole pipeline: parse, slot binding, retarget fidelity, locomotion/action override, contact timing, root motion and a live match on the generated clips (see `docs/MOTION-PIPELINE.md`).

Optional browser smoke test (Playwright is a test-only tool, not a game dependency): install with `npm install --no-save --package-lock=false playwright`, then `npx playwright install --with-deps chromium`. Start Vite on port 5178 and run `node scripts/browser-smoke.mjs`. Set `TEST_URL` to use another server. It checks spectator and player startup, the tactics drawer, and pause/resume; screenshots go to `.test-artifacts/`.
