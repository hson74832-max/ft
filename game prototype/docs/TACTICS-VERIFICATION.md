# Attacking behaviour verification

## Reported behaviour and what changed

| Reported problem | Cause found | Change |
| --- | --- | --- |
| Off-ball players hold their positions instead of attacking space | Support targets were scored only on being "open", fixed to a channel and clamped to the defensive line, so every target sat behind the ball; the trigger to run did not exist | Active space scanning (`spaceAhead` probes a fan of points ahead of each candidate), three run types (`check`, `spin`, `drive`) plus `hold`, lead-the-run targets and a committed run memory |
| The carrier looks forward with time on the ball and nobody runs | No signal from carrier to runners | `readRunTrigger` (facing dot, time on ball, pressure, forward lane) gates spin/drive and is exposed on the plan and in the UI |
| Passing for passing's sake: endless recycling, few shots and through balls | Pass utility weighted safety over gain, shot lanes were binary, and a partially blocked lane was discarded | Phase-weighted utility (`CONFIG.tactics.phaseWeights`), forward gain and line-break bonuses, partial-lane shots, scoring blocked lanes instead of dropping them, carry utility from forward space |
| No attacking transition state after winning the ball | Possession in your own half was treated exactly like possession in theirs | `transitionUntil` window on the match snapshot, `AttackPhase` including `transition`, transition-specific support jobs, weights and pivot behaviour |

`src/game/tactics.ts` owns the plan: jobs, run types, the trigger, candidate scoring and run
commitment. `src/game/ai.ts` compares progression, safety, shooting geometry and carries on
one utility scale. `src/game/engine.ts` tracks possession changes (opening the transition
window) and applies the run/offside speed limits.

## Reproduction

```bash
cd "game prototype"
npx esbuild scripts/support-match.ts   --bundle --platform=node --format=cjs --outfile=/tmp/support-match.cjs   && node /tmp/support-match.cjs
npx esbuild scripts/support-regression.ts --bundle --platform=node --format=cjs --outfile=/tmp/support.cjs     && node /tmp/support.cjs
npx esbuild scripts/attacking-runs.ts --bundle --platform=node --format=cjs --outfile=/tmp/attacking-runs.cjs   && node /tmp/attacking-runs.cjs
```

Full matches use the real `MatchEngine` at 1/60 s with only rendering/DOM texture calls
stubbed. Match completion is an assertion; the harness does not stop at wall-clock time
during a restart.

## Observed results (full matches, 420 s ceiling)

| Seed | Score | Passes | Recycles (to keeper) | Penetrating | Shots | Moving off-ball | Runs / min | Actual central cover | Planned cover | Central square passes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1234 | 1:5 | 69 | 33 (6) | 15 | 21 | 87% | 4.8 | 77% | 83% | 4 |
| 777 | 3:4 | 76 | 53 (7) | 9 | 17 | 86% | 6.3 | 78% | 79% | 5 |
| 42 | 3:6 | 69 | 40 (5) | 13 | 24 | 86% | 8.1 | 83% | 86% | 4 |

For comparison, the same harness before the changes produced 86–98 passes, 49–61 recycles,
16–19 penetrating deliveries and **8–13 shots** per match, with no run metric to report
(players held their support positions, so almost all movement was repositioning).

"Moving off-ball" is the share of frames in which a non-carrier outfielder of the
possessing team is travelling faster than 1 m/s. "Runs / min" counts committed spin/drive
runs that last at least 0.25 s at more than 3.5 m/s.

## Scenario checks (`attacking-runs.ts`, 8/8 passing)

1. **Space ahead of an unmarked runner is recognised and run into.** With the carrier
   facing forward and time on the ball, the trigger is on, at least one support player is
   assigned a run, a run travels more than 3 m beyond the player's current position, it
   targets vacant ground (`vacancy > 0.45`), and every run target respects the offside
   line.
2. **The run is physical.** Over 110 simulated frames the runner advances more than 4 m,
   separates from the carrier by more than 2 m and peaks above 4 m/s — the assignment is
   not just a number in the plan.
3. **The run trigger gates the runs in behind.** Same shape, carrier facing his own goal
   and pressed: the trigger is off, no `spin` run is assigned, and the outlet picks a
   checking (`check`) movement that brings him closer to the ball.
4. **Checking to the ball offers a safe short outlet when pressed.** A pressed carrier
   without a forward trigger still has a short option within `runnerLead + 4` m, and a
   `check` candidate with an open lane exists.
5. **Winning the ball opens an attacking transition state.** After a real turnover in the
   engine, the plan reports phase `transition` (or a transition trigger), and the carrier
   produces a forward action within 2 s — a pass with more than 2 m gain or a carry of at
   least 2 m.
6. **A partially blocked lane is still a shot.** A lane between 0.05 and 0.75 (below the
   old "safe" threshold, above `shotPartialLane`) in shooting range produces a shot clip
   instead of a recycle.
7. **A progressive forward pass beats a safe square ball.** With both on offer, the
   chosen pass has a gain above 3 m and is logged as `penetrate` or `progress`.
8. **Full match: runs, run variety and progressive intent.** A seeded 5-minute match must
   pass, penetrate, shoot, move off the ball, and record sustained runs with a mix of
   `spin`, `drive` and `check`, so the fixes are not only visible in isolated fixtures.

`support-regression.ts` still passes all 28 scenarios (both teams and halves, every
outfield carrier role, pressured pivot resets, keeper-pass release/control, marked-wide
alternatives, onside staging and post-release runs, open-edge shots, actual movement into
central cover), and `support-match.ts` still replays seed 1234 pass-for-pass.

## Scope and limits

- Recovery runs, xG-style shot quality and set-piece routines were not redesigned.
- `activeRunPct` (frames with a runner moving fast and ahead of the ball) stays around
  11–20% because runs are bursts and much of possession is spent with the ball in front of
  the last line, where the offside clamp correctly stops the runner at the line.
- The utility weights are prototype tuning values in `CONFIG.tactics`, not measurements.
  They are chosen so that the scenario suite above holds across seeds; they are not claimed
  to be optimal football.
- These checks do not establish visual animation quality or 60 FPS on target hardware.
