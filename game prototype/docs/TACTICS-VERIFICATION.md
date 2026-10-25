# Possession support verification

## Causes addressed

The previous attack code assigned both defenders wide and did not allocate a pivot. It excluded keeper passes near the opposing goal, while `planNamedPass` rejected every keeper receiver. A direct defender in a lane still scored at least 0.64 as "open"; the receiving teammate also counted as its own congestion. Far-side targets were fixed near the touchline. Only velocity extrapolation led passes, so no receiver committed to the delivery. Repeated AI evaluations, rather than actions taken, filled the novelty penalty history.

`src/game/tactics.ts` now owns shared support jobs and candidate scoring. `src/game/ai.ts` compares advancement, safe resets and actual shot geometry. `src/game/engine.ts` validates named keeper passes, commits reception runs at release, retains central cover during flight, and distinguishes keeper foot control from catching.

## Reproduction

Run the commands for `support-regression.ts` and `support-match.ts` in README.md. Full matches use the real MatchEngine at 1/60 s, with only rendering/DOM texture calls stubbed. Match completion is an assertion; the harness does not stop at 240 wall-clock seconds during a restart.

## Observed results

Results for the implementation accompanying this document:

| Seed | Final score | Passes | Reset deliveries | To keeper | Penetrating deliveries | Shots | Actual central cover | Planned cover | Central square passes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1234 | 4:0 | 91 | 50 | 13 | 19 | 8 | 74% | 96% | 2 |
| 777 | 2:2 | 98 | 61 | 16 | 17 | 11 | 73% | 97% | 4 |
| 42 | 3:1 | 86 | 49 | 14 | 16 | 13 | 70% | 95% | 0 |

Every recorded pass named a different, same-team receiver and met the configured launch-cone constraint. The replay of seed 1234 matched all recorded targets, release ticks, counters and final state. Different seeds produced different pass trajectories.

Actual cover means at least one non-carrier outfielder is centrally located (within 3.7 m of the centre axis) at least 1.5 m behind the carrier during open play. Planned cover uses the stricter configured 3 m band and a target at least 2 m behind the carrier. These figures include movement/ownership transitions; a planned role is not counted as actual coverage until a player reaches it.

Central square passes have less than 2 m longitudinal displacement and a destination within 4 m of the centre axis. Penetrating deliveries are passes chosen for a runner/channel, not a claim that every such delivery beats a defender or is completed. Reset deliveries include backward passes to the keeper or pivot. No success/goal coin tosses or artificial outcome rates were added.

## Scope

The scenario suite asserts the requested decisions in mirrored setups, including physical arrival into cover and an executed keeper backpass. Existing physics/rules and set-piece suites are rebuilt and run, not reused from older bundles. A Chromium smoke test also passed spectator/player startup, the tactical drawer, and pause/resume without JavaScript exceptions. These checks do not establish visual animation quality or 60 FPS on target hardware; goalkeeper save tuning, mocap retargeting and unrelated rule limitations were not redesigned in this change.