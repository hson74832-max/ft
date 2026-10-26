# Referee, restarts and ball boundaries — 2026-10-26

Scope: `game prototype/src/game/**`, headless scripts. This pass checked a list of
reported defects against the shipping code, fixed the ones that were real, and added
the rules that were missing (cards, advantage, the goalkeeper distribution clock).
Every suite passes; `tsc --noEmit` is clean.

Verification:

```bash
cd "game prototype"
npx tsc --noEmit
npm run verify:referee        # 18 checks (new)
npm run verify:duels          # 17
npm run verify:gameplay
npm run verify:perception     # 19
# plus selftest, kickoff-regression, support-regression, attacking-runs,
# receiver-awareness, tactics-test, ai-repro, support-match
```

## Reported defects — what was actually there

### 1. Silent kickoff after goals and at half time — **not reproducible; the real defect was the opposite**

There is no `clock < 0.1` guard in the tree (`git grep kickoff HEAD` finds no clock
test on the announcement path). `startSetup("kickoff")` mapped `kickoff → KICKOFF`
and emitted, so the second half and post-goal kickoffs were *already* announced.
What the tree did have was a **duplicate** and a fragile announcement path:

* `RulesEngine`'s constructor emitted `KICKOFF` ("Match initialised — …") **and**
  the first `startSetup("kickoff")` emitted `KICKOFF` again, so the opening kickoff
  was announced twice.
* Every kickoff announcement was a side effect of `startSetup`, with no latch at all,
  so any future "don't announce the opening one twice" guard had to check *something*
  about the match state. A clock test is the trap described in the report: the match
  clock is frozen while players are staged for a restart (`RulesEngine.update` only
  advances `time` in `INPLAY`), so `time < 0.1` can only ever be true for the opening
  kickoff and the second-half / post-goal kickoffs would silently never announce.

**Fix:** the constructor no longer emits. `RulesEngine` keeps a one-shot latch
(`openingKickoffAnnounced`) purely to distinguish the opening kickoff's wording, and
`announceKickoff()` emits exactly one `KICKOFF` event per kickoff, however long the
clock has been running. `rules.kickoffs` exposes the count.

**Regression:** opening kickoff announced once, no duplicate on a re-stage, post-goal
kickoff announced after the clock has advanced, second-half kickoff announced. The
hash of the old behaviour is preserved in the tests: the opening kickoff's *wording*
is chosen by the latch (the clock is frozen during setup, so a clock test could only
ever be true for the opening kickoff — which is exactly the trap that would have made
the later kickoffs silent, had anyone added it).

### 2. Clock formatting — **confirmed**

`RulesEngine.clock` returned `4:00` / `0:45` (minutes unpadded) while
`elapsedClock` was already padded. It now returns `04:00` / `00:45`.

### 3. Debug trace overwriting the specific cause — **confirmed**

In `match/control.ts` the AI trace row was written twice: the specific label first
(`skipped:turning-to-face`, `skipped:recovery(…)`, `skipped:clip-rejected`) and then
unconditionally replaced by `ok:<clip>` / `rejected:<clip>(cooldown …)`. The second
write is gone; success now writes `ok:<clip>` and failure keeps the specific reason.

**Regression:** a forced decision that needs a body turn reports
`skipped:turning-to-face`, not `rejected:pass_long(…)`.

### 4. Goalkeeper pressure heuristic — **confirmed (marginal), fixed by construction**

`goalkeeperPressure` conflated two questions in one pass and filed any candidate that
was not "urgent" as unusable (`if (!urgent && bestUrgent) continue`). A distant
sprinter could therefore outrank a nearer, slower opponent simply by being classified
urgent first.

It now answers them separately:

* **urgency** = *anybody* can be on the keeper soon (`d < 1.55 || arrival < horizon`);
  this is what the distribution clock and the hold gate read;
* **which body** = the nearest opponent, unless a further one is arriving inside the
  keeper's reaction window (`CONFIG.ai.gkPressureImminent`, 0.2 s), which is the only
  case where a distant challenger legitimately owns the read.

## New rules

### Goalkeeper distribution clock (`match/keeper.ts`, `match/control.ts`)

`CONFIG.ai.gkHoldLimit = 8` s from gathering the ball to releasing it. The check runs
in `aiControl` *before* any AI decision, so it cannot be out-voted:

1. `startAction` a long ball (`gk_punt`, or `pass_long` for a back-pass) at the most
   advanced teammate the punt can actually reach, clamped inside the pitch;
2. the pending kick is stamped `forced`, and the contact-frame branch for `gk_punt`
   (and for `pass_long` when the keeper is playing a back-pass with his feet) strikes
   it directly at its target — a receiver plan (offside, lane, range) can no longer
   cancel the clearance;
3. if the clip cannot start at all, one second after the limit the ball is struck
   directly. The limit is a law, not an intention.

`holdT` is only cleared when the ball has actually left the keeper, so a cancelled
delivery retries rather than restarting the eight seconds.

### Foul grading and cards (`match/referee.ts`, `match/tackles.ts`, `match/contacts.ts`)

`evaluateTackle` now exposes `late`, `blindside` and `competitive` (the ball was still
inside `CONFIG.referee.recklessReachFactor × reach`).

* **Yellow card** — a foul whose challenge was late *or* from the blind side while the
  ball was still a competitive distance away. (A challenge that never got near the
  ball is careless, not reckless: no card.)
  "Blind side" is measured at the **wind-up** (`TackleChallenge.startFrontDot`), not at
  the contact frame. This is the one place where the letter of the specification had
  to be made playable: carriers in this engine turn constantly (their body angle
  follows their movement), so at the contact frame the challenger is behind the
  carrier's facing in ~46 of 59 fouls — grading on that geometry booked essentially
  every foul (3.3 yellows and 1.7 blue cards per four-minute match, i.e. a side
  playing 4v5 for a third of the match). Judged at the commitment angle with
  `CONFIG.referee.recklessBlindsideDot = -0.2` (beyond ~78° off the carrier's front —
  from behind the shoulder), and with the competitive-ball test, the measured rate is
  **~0.5 yellows and ≲0.1 blue cards per match** over ten seeds, which is still
  several times a real 90-minute match's card rate per minute.
* **Blue card** — the second yellow. The player leaves the pitch (walking to a bench
  spot outside the touchline), is idle for `CONFIG.referee.blueCardSeconds = 60`, is
  removed from the AI's world picture, cannot receive, tackle, be collided with, hold
  an offside line or be a restart taker, and re-enters from the bench when the
  exclusion expires. The exclusion is a match-clock timestamp, so a restart freeze
  cannot shorten it.
* **Awareness** — a booked player's `tackleRisk` is scaled by
  `CONFIG.referee.bookedCaution` (0.7) and `canTackle` refuses blind-side angles for
  him (`bookedMinFrontDot`), so he stops diving in and risking the second yellow.
* Cards are visible in the HUD (above the scorebug, with the remaining exclusion for a
  blue card), in the rule feed (`YELLOW_CARD`, `BLUE_CARD`) and in the snapshot
  (`cards`, per-player `yellowCards` / `blueCardRemaining`).

### Advantage (`referee.advantageAvailable`)

A foul does not stop play when the fouled side keeps a *usable* ball:

* the fouled player is still on it with `advantageClearance` (2 m) of space, or
* he is running (`advantageMinSpeed`, 2 m/s) into a corridor that is clear at the
  forward aim point (`advantageCorridor` / `advantageCorridorLength`), or
* the ball broke loose and a teammate is arriving on it with space.

Then: no restart, an `ADVANTAGE` event, the carrier rides the challenge (a much
shorter stumble), and the card is still issued. Otherwise the free kick / penalty is
awarded exactly as before.

## Two bugs found while verifying this work

### A carrier could stall the match for over a minute

`control.ts` pivots a running carrier onto his kick target before striking
(`faceTarget`) because the ball leaves along the body. That branch asked for
`desiredSpeed <= 1.2` instead of stopping, and the facing pass in `frame.ts` gives
the velocity priority over `faceTarget` while `speed > 0.4`. A carrier pinned against
the touchline clamp (velocity into the wall, position clamped, `speed` stuck at ~1.9)
therefore never satisfied the facing test: the turn was re-requested every 0.06 s,
`faceTargetT` never expired, and the kick never left. Seed 777 held the ball for
**109 s** in one half.

Fix: the pivot is a stop (`desiredSpeed = 0`), and `kickTurnT` caps the pivot at
`CONFIG.ai.kickTurnLimit = 0.9 s`, after which the kick is struck with whatever angle
the body has. Regression: a full match per seed must never see a possession longer
than 12 s and must produce more than 40 actions.

### Restart deliveries could aim behind a byline

`sampleRestartTarget` builds aim points as *teammate position + sampled offset*
(throw-in "up the line", goal-kick punt, corner zone). Near a byline those offsets put
the aim point behind the goal line: throw-ins struck the ball at x = ±22 m. All
restart aim points now pass through `clampAimToPitch` (pitch minus
`CONFIG.ai.outPlaySafetyMargin`). Regression: 48 sampled throw-ins from both bylines,
every aim point inside the safety margin.

## Boundary invariants — checked, not changed (except one)

These were described accurately in the report; they are now regression-tested:

* **Dribbled ball** — `Ball.glueTo` puts the ball 0.48 m ahead of the carrier, while
  `stepPlayers` clamps players to `±(half − 0.4)`. The 0.08 m difference is smaller
  than the ball radius (0.109 m), so the carried ball stays inside
  `half + radius` even with the carrier pinned to a line. Tested at both touchlines,
  both goal lines and the corner, with `outGoalCheck` running every frame.
* **Free ball** — the swept `prevPos → pos` segment catches shallow crossings and
  awards the restart with the ball's velocity zeroed. One thing *was* missing: the
  ball kept the frame-end position until the next frame's restart staging. It is now
  put back at the restart spot on the same frame it crossed.
* **Restart staging** — a throw-in/corner taker may stand outside the pitch; the ball
  released from there is clamped inside (`releaseRestartToTaker`). Tested.
* **AI targeting** — `predictReceiverRun` clamps to the pitch minus
  `CONFIG.ai.outPlaySafetyMargin` (1.4 m), `evaluateGkDistribution` clamps its targets,
  restart deliveries are clamped (`clampAimToPitch`), and the forced keeper clearance
  clamps its aim point the same way. Tested, plus a ten-match soak that samples every
  `pendingKick.target` in flight: **0** outside the pitch.

## Model notes / remaining risks

* Cards are booked whenever a foul is registered, including with **Settings → Fouls**
  off (no whistle, but the referee still records the sanction). A four-minute match
  with ~9 fouls therefore books a handful of players and occasionally sends one off
  for a minute — deliberately, as specified.
* Advantage only fires when there is genuine space; with the challenger still on top
  of the ball (the common case for a body-contact foul in this engine) the whistle
  stops play. That is the conservative reading of the law and keeps the free kick the
  normal outcome of a bad challenge.
* A blue-carded player is excluded from `WorldSnap.players`, so the AI's pass and
  marking logic simply does not see him. The keeper slot is not back-filled: if a
  keeper is carded off, his side defends with no keeper for the exclusion.

## Measured behaviour (ten seeds, 300 s matches, headless soak)

| check | result |
| --- | --- |
| dribbled ball outside touchline/goal line + radius | 0 frames |
| restart ball placed outside the pitch | 0 |
| `pendingKick.target` outside the pitch | 0 (was 90 before `clampAimToPitch`) |
| keeper holding past `gkHoldLimit + 1.2 s` | 0 |
| blue-card exclusions that did not last exactly 60 s | 0 |
| possession longer than 12 s (stall) | 0 (was 109 s on seed 777) |
| fouls | 103 |
| yellow cards | 5 |
| blue cards | 0 |
| advantages played | 15 |
| goals | 57 |

The referee is deliberately quiet for a four-minute arcade match: a challenge is only
booked when it was committed from behind the shoulder (or was late) *and* the ball was
still within reach. Every blue card in the sample came from the test fixtures rather
than from play, which is the intended shape — a second yellow is a serious event.

All suites: `selftest`, `kickoff-regression`, `duel-regression` (17),
`support-regression` (28), `attacking-runs` (8), `gameplay-regression`,
`perception-regression` (19), `referee-regression` (18), `receiver-awareness` (8),
`tactics-test`, `ai-repro`, `support-match` (named passes, recycling, runs, shots,
central cover, deterministic replay). `npx tsc --noEmit` and `npx vite build` are clean.
