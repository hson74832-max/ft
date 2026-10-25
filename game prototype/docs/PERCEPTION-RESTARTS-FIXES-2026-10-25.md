# Defending shape, closing down, free kicks and the vision/memory system

Branch `arena/aab7139c-ft` (game code under `game prototype/`). Date: 2026-10-25.
Every claim below is measured from a headless engine run (no renderer, seeded, 60 Hz)
and every fix is covered by `scripts/perception-regression.ts`, which fails when the
fix is reverted.

## 1. Reported defects → cause → change

| Reported problem | Cause found | Change |
| --- | --- | --- |
| Defending team stays high and wide at an opponent's throw-in; nobody marks the receivers or protects the zone | `placeForRestart` staged the **attacking** side (taker, receivers, runners) and then let the defending side keep its open-play formation homes. The AI's own shape logic never ran during the restart hold, so the block was wherever the formation put it — up to 27 m from the ball, with the FWD still high, and the two nearest receivers 3.6–10 m away unmarked | New defending block in the `throw_in` branch of `placeForRestart` (`match/restarts.ts`): the two nearest receivers are man-marked 1.4 m on their **goal side**; the remaining defenders screen the ball→own-goal corridor 4 m and 6 m deep, 3.2 m either side of the line to goal, facing the ball. Hard-clamped inside the pitch |
| Defenders take curved, wide paths instead of closing the runner down | The press target was the carrier's *current* position (with only a 0.2 s velocity lead), so a defender starting beside or in front of the run had to chase the point the carrier had already left: the path bent wide and the defender arrived behind the ball | `interceptPoint()` in `ai.ts`: the earliest time `t` at which a defender can reach the carrier's constant-velocity position (0.15 s steps to a 1.2 s horizon, reachable speed `maxSprint` × pressing style × 0.9 for the acceleration phase). The presser runs at that point (then the existing goal-side offset applies if he is beaten) |
| Free kicks outside shooting range are always launched long; the long ball is driven flat and fast at a teammate who cannot trap it | `sampleRestartTarget` returned a target and the restart then used the kind's default action (`pass_long`, 24 m/s). A `pass_long` arrives at 19–21 m/s over 5–16 m — above the 14 m/s trap limit — so it bounced off the receiver or ran through to an opponent (measured: a 10 m free kick lost the ball in 2.7 s) | Free-kick option scoring in `sampleRestartTarget`: every outfield mate is scored on lane openness, space, forward gain and a short-ball bonus; the action follows the *chosen distance* (`pass_short` ≤ 14 m, `pass_through` 14–22 m — a 4.5 m/s roller — `pass_long` only beyond 22 m, where it lands at ≤ 12 m/s). The taker also faces the delivery before striking |
| Players act on the whole pitch at once (omniscient AI) | There was no perception at all: every branch of `think()` read `snap.players` / `snap.ballPos` directly, so a player knew the exact position of a man behind him and of a ball he had never looked at | New `match/perception.ts`: a body-relative field-of-view cone (`visionRange` 30 m, `visionHalfAngle` 1.30 rad ≈ 75°), a short-term memory bank per player that decays after `memorySeconds` (4 s), periodic scans that widen the half-angle to 2.35 rad and are animated as a head turn, and `believedPos`/`remembered`/`seesNow` accessors. `think()` builds its opponent list, its ball belief and its pass options from that picture (`ai.perceived`, `ai.believedBall`); a man he has never seen and does not remember is simply not an option. Restarts seed every player's memory with the dead-ball layout |
| Kicks leave the body in a direction the player is not facing (shooting/passing behind the back) | The facing branch in `stepPlayers` solved "torso follows the play" after the kick had been decided; it had no notion of a pending kick, so at the contact frame the torso could still be pointing anywhere | (a) `stepPlayers` gains a highest-priority branch: while `p.pendingKick` is a kick, the torso turns onto `pendingKick.target`; (b) the open-play turn-to-face gate in `control.ts` only stops a **running** player (`speed > 0.45`) — a standing player turns *during* the wind-up; (c) restart takers face the delivery in `restartAuto`. The old hard rejection of an off-axis kick in `startAction` was removed: it made keepers and carriers stand still for ~9 frames and lose the ball |

## 2. Measured before / after

### 2.1 Throw-in defending shape (`_probe` style measurement: 100 frames after staging)

Four throw-in spots (both touchlines, both halves) × seeds 1234 and 42; distances in
metres, `goal-side` is the projection onto the ball→own-goal axis (negative = upfield,
i.e. still in an attacking position), `marks` is the gap from the two nearest receivers
to their nearest defender.

| | Before | After |
| --- | --- | --- |
| Defender distance from the ball | 8.0–27.6 | 4.5–6.8 |
| Defender goal-side of the ball | 0.5–26.0 (0.5 = level with the throw, FWD still upfield) | 3.9–6.5 (all four) |
| Nearest-receiver marking gap | 3.6–10.1 | 1.2–1.5 |

### 2.2 Closing down a runner (carrier driven straight at goal, 2.2 s)

| Defender start | Before: min dist / path÷straight / lateral deviation | After |
| --- | --- | --- |
| (6, 8) | 2.87 m · 1.02 · 0.70 m | 2.14 m · 1.05 · 0.78 m |
| (4, 5) | 3.41 m · 1.05 · 0.92 m | 1.99 m · 1.08 · 1.13 m |
| (8, −6) | 2.04 m · **1.19** · **3.44 m** | 1.02 m · 1.10 · 0.91 m |

The third case is the reported bug: 13.7 m run for 11.5 m of ground, swinging 3.4 m
wide of the straight line and arriving behind the ball. It now covers 6.1 m, closes to
1.0 m and stays inside a metre of the line.

### 2.3 Free kicks (seed 4242, 6 s window, first restart delivery)

| Spot | Before | After |
| --- | --- | --- |
| (−5, 0) | `pass_long` 24 m/s | `pass_short` 8.1 m/s → #2, trapped |
| (2, 6) | `pass_long` 24 m/s | `pass_short` 9.6 m/s, trapped |
| (8, −8) | `pass_long` 24 m/s, 19.9 m | `pass_through` 10.1 m/s, 17.2 m |
| (−8, 4) | `pass_long` 24 m/s | `pass_short` 9.1 m/s, trapped |
| (6, 10) | `pass_long` 24 m/s, 10.0 m, **lost the ball** | `pass_through` 9.6 m/s, 15.7 m |
| (14, 0) | `shoot_normal` | `shoot_normal` (unchanged, still shoots) |

Pass-profile reference (measured with a trap limit of 14 m/s): `pass_short` saturates at
power 11 → 5.7–6.0 m/s arrival between 5 and 16 m; `pass_through` is a constant 4.5 m/s
roller out to 30 m; `pass_long` arrives at 20–24 m/s up to 16 m, 12.0 m/s at 20 m.

### 2.4 Body mechanics at the kick (`_probe8`: angle between `p.facing` and the ball
velocity on release, pass/shoot/corner/throw-ins only, 240 s matches)

| Seed | Before (kicks · max · p90 · mean · >80°) | After |
| --- | --- | --- |
| 1234 | 62 · 153° · 117° · 43° · 14 | 60 · 52° · 13° · 4° · 0 |
| 777 | 61 · 174° · 131° · 44° · 12 | 71 · 52° · 4° · 4° · 0 |
| 42 | 77 · 176° · 145° · 50° · 24 | 55 · 41° · 14° · 4° · 0 |
| 9 | 68 · 165° · 95° · 36° · 10 | 65 · 44° · 18° · 5° · 0 |

The remaining large angles on the old filter were `gk_parry`/`gk_roll` — reflex and
throw kicks that legitimately leave off-axis (a parry is struck with whatever part of
the body is between the ball and the goal).

### 2.5 Match-level effect (`ai-repro`, 240 s matches, same seeds, baseline vs. now)

| Seed | Pass launch speed avg (min) | Kicks released / cancelled | Carrier stall (longest) | Shots / saves / goals | Score |
| --- | --- | --- | --- | --- | --- |
| 1234 | 12.4 (6.4) → 10.8 (5.6) | 69/2 → 80/2 | 7.4% (0.75 s) → 6.8% (0.55 s) | 18/16/3 → 18/21/3 | 1-2 → 2-1 |
| 777 | 11.4 (6.3) → 10.4 (6.0) | 68/2 → 82/1 | 8.4% (0.55 s) → 9.2% (0.55 s) | 16/14/6 → 16/9/6 | 4-2 → 4-2 |
| 42 | 10.7 (5.7) → 10.8 (5.8) | 87/5 → 68/2 | 5.5% (0.55 s) → 7.2% (0.55 s) | 17/17/3 → 14/12/2 | 0-3 → 1-1 |

Passes are struck a little softer and there are fewer wasted launch attempts: with a
field of view, a carrier takes the safe option more often instead of firing the perfect
ball to a man he could not actually see. Goals are unchanged on two seeds and moved by
one on the third; no seed loses the ball to a stall longer than 0.55 s, and every seed
still reaches `FULLTIME` with replay-identical results.

### 2.6 Attacking runs (`attacking-runs`, 3 matches)

| | Baseline | Now |
| --- | --- | --- |
| Passes | 202 (15% penetrating, 48% recycled) | 211 (21% penetrating, 50% recycled) |
| Shots | 64 | 54 |
| Off-ball runs | 50 | 60 (spin 15%, drive 10%, check 38%, moving 75%, trigger 46%) |

## 3. Design notes on the perception system

- **Cone, not radius.** `inSight()` treats everything within `awareRadius` (2.6 m) as
  felt rather than seen (a body at arm's length is obvious), everything beyond
  `visionRange` (30 m) as invisible, and the rest by the angle to the body heading
  against the current half-angle. A scan widens the half-angle to 2.35 rad for
  `scanDuration` (0.55 s) and is drawn as a ±1.2 rad head turn; scans are scheduled per
  player every `scanInterval` (2.4 s) with a staggered, seeded phase.
- **Memory, not ground truth.** `remembered()` returns the last seen state while it is
  younger than `memorySeconds` (4 s), extrapolated by the velocity last observed for at
  most 0.45 s (a runner keeps running, but a remembered position cannot be trusted
  further than half a second). `believedPos()` returns the live position while the
  player can see the entity, the memory while it is fresh, and `null` once forgotten —
  `null` is what removes a teammate from the option list and an opponent from the lane
  and space scores.
- **Determinism.** Scan phase and side come from `tieBreakHash(matchSeed, idx, ...)`, and
  the free-kick/throw-in choices use the restart's attempt-local `SeededRandom` and the
  existing `tieBreakHash` tie-breaks, so no new global RNG draws were introduced.
- **Snapshots.** `WorldSnap` and the UI `Snapshot` shape are unchanged; perception lives
  on `EnginePlayer`/`WorldPlayer` as an optional field, so hand-built AI fixtures (and
  `selftest`) run without a memory bank exactly as before.

## 4. Deliberately not changed

1. **Open-play `pass_long` for > 13 m passes** in `possessionDecision` has the same
   profile mismatch as the free kicks had (a 14 m `pass_long` arrives at ~19 m/s). It was
   not reported, and changing the open-play band changes every pass power in every
   match, so it keeps its own verification pass.
2. **Free-kick and corner defending shape** is still the formation block (corners have
   their own box block). Only throw-ins were reported and only throw-ins were staged.
3. **Turn rate** (`turnRate` 7.25 rad/s) and the turn-to-face gate threshold (0.45 m/s)
   are unchanged; a standing player now simply rotates during the wind-up instead of
   being refused the kick.
4. **`gk_parry` / `gk_roll`** can still leave the body at a large angle, by design.
5. **Memory is not shared between teammates** (no collective "team knows"). The report
   asked for a per-player picture; a shared picture would need a separate rule for how
   sightings propagate.

## 5. Verification

```bash
cd "game prototype"
npx tsc --noEmit
npm run verify:perception    # new: 10 checks (vision, memory, shape, press, FK, body)
npm run verify:motion && npm run verify:duels && npm run verify:gameplay
for s in selftest tactics-test support-regression attacking-runs kickoff-regression support-match; do
  npx esbuild scripts/$s.ts --bundle --platform=node --format=cjs --outfile=.test-artifacts/$s.cjs \
    && node .test-artifacts/$s.cjs
done
npx esbuild scripts/ai-repro.ts --bundle --platform=node --format=cjs --outfile=.test-artifacts/ai-repro.cjs
node .test-artifacts/ai-repro.cjs && node .test-artifacts/ai-repro.cjs --gk
```

Current results: `tsc` clean; `perception-regression` 10/10; `selftest` all checks;
`tactics-test` all checks; `support-regression` 28/28; `attacking-runs` 8/8;
`kickoff-regression` 7/7; `duel-regression` 17/17; `gameplay-regression` all
pass; `motion-pipeline` OK.

`scripts/perception-regression.ts` is the negative control for all five reported items:

1. field of view is a body-relative cone (behind the back is invisible, arm's length is felt);
2. a sighting is remembered and decays after `memorySeconds`;
3. scanning widens the cone and turns the head;
4. a teammate behind the carrier is not a pass option until he has been seen or is still
   remembered, and turning the body reveals him;
5. a loose ball out of sight is not chased from ground truth;
6. the defending team drops into a compact, goal-side, man-marking block at throw-ins
   (4 spots × 2 seeds);
7. a defender meets a runner on a straight line (path ÷ straight < 1.45, lateral < 2.2 m,
   closes inside 2.4 m);
8. free kicks outside shooting range are struck short and below the trap limit;
9. a free kick inside shooting range is still a shot;
10. over three 4-minute matches no pass, shot, corner or throw-in leaves more than 80°
    away from the body.
