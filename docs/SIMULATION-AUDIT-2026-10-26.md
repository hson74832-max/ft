# CPU vs CPU replay audit — 2026-10-26

Replaying full CPU-vs-CPU matches headless (`scripts/watch-match.ts`, `scripts/shot-keepers.ts`,
`scripts/tackle-audit.ts`, `scripts/keeper-regression.ts`) and inspecting each set piece in
isolation (`scripts/scenario-regression.ts`, `scripts/scenario-audit.ts`).

Headline defect from the report — **"players can shoot from distance and from behind, and the
goalkeeper cannot save it"** — is real, and it was not a tuning problem: the save could not
physically happen. That is fixed. Four further bugs turned up on the way (see §2).

All suites green after the work:

```
verify:motion  MOTION PIPELINE OK          verify:scenarios  10 SCENARIO REGRESSIONS PASSED
verify:duels   17 PASSED                  verify:physics    26 PROFILES · ALL CHECKS PASSED
verify:gameplay ALL PASS                  verify:tactics    ALL TACTICS CHECKS PASSED
verify:perception 19 PASSED               verify:keeper     KEEPER REGRESSIONS PASSED
verify:referee 18 PASSED                  npx tsc --noEmit  clean
```

---

## 1. The reported defect: long shots were unsaveable

### What the replay showed (before)

* 26 shots over five matches → **13 goals, 6 "saves"**, and **100 % of on-target shots scored**.
* Every one of those six saves was the ball hitting the keeper's **body cylinder** (`SAVE … body
  block`); not one was a dive, parry or catch. The keeper's dive animation fired, but the save was
  resolved on the clip's contact frame — 0.44 s after the commit — while a 32 m/s shot from 12–15 m
  arrives in 0.30–0.40 s. The ball had already crossed the line before the hands got there.
* On the goals the keeper's closest approach to the ball was **0.57–0.88 m**, i.e. well inside his
  physical reach: he was in the right place, at the wrong time.

### Root causes

1. **Saves were timed by the animation, not by the ball.** `gk_dive_*` resolves at
   `gkDiveContactTime = 0.44 s`; nothing checked the ball's actual crossing. Fix: a new
   `keeperSaveCheck` (`src/game/match/keeper.ts`) runs every frame *before* goal detection and
   tests the ball's **swept segment** against the keeper's reach volume, which grows with the dive
   clip's progress (`keeperReachNow`: standing arm span + `gkHandExtension` × dive progress −
   off-balance). A save now depends on the time the keeper actually had, which is the point of a
   save model.
2. **The striker counted as his own screen.** `screened` tested any non-GK body near the ball, and
   the shooter stands at the ball: *every* shot in the game was "screened", inflating read error and
   dive-timing error by 1.7×. Fixed to ignore bodies within 1.2 m of the strike.
3. **The timing error corrupted the flight time.** `shot.timeLeft += timing` made the keeper believe
   a 0.36 s shot had 0.7 s left (measured: `readT 0.366 s` for a true 0.14 s remaining), so he kept
   shuffling and committed ~0.15 s before arrival. The timing error now moves the *commit threshold*
   (`gkCommitAnticipation`), which is the same mistake expressed in the right units.
4. **A shot arriving inside the reaction window froze the keeper.** `ballKickAge < reactionTime`
   returned "reacting" for the whole flight of a penalty, so he never moved. He now makes an
   instinctive attempt when the flight is shorter than his reaction time.
5. **Range-independent shot accuracy.** Aiming error was `passError × (75 − rating)/75`: the same
   angular error at 4 m and at 15 m, and *smaller* for a good finisher. Every long shot was a
   pinpoint far-corner drive. Spread is now `(shotSpreadBase + distance × shotSpreadPerMetre) ×
   rating factor`, and the AI pays a range cost for shooting from outside 9 m.

### What the replay shows now (10 seeds, 85 shots)

| distance | shots | goals | saves |
|---|---|---|---|
| 0–6 m | 8 | 5 | 3 |
| 6–9 m | 12 | 2 | 7 |
| 9–12 m | 20 | 1 | 16 |
| 12–15 m | 44 | **0** | **35** |

* **75 % of shots aimed on target are now saved** (41 saves vs 8 goals out of 55 on-target shots).
* 72 of 85 shots draw a keeper action (`gk_parry` 33, `gk_dive_L` 21, `gk_dive_R` 13, `gk_catch` 5)
  — before, the dive never saved anything.
* Distance from the keeper to the ball: **0.74 m on saves vs 1.66 m on goals** (was 0.57 vs 0.76,
  i.e. saves and goals were indistinguishable).
* Body orientation at the strike: **0 shots struck with the body >60° off the ball's departure
  line** (was 3 of 58 beyond 120° — the literal "shot from behind"). Wind-up error is now 34° on
  average and only 11 of 76 above 60°.

Penalties: 16/16 produced a save attempt, 5 goals / 11 saves, and the taker now aims 0.2 m inside
the post instead of 0.45 m from the centre of a 3 m goal.

---

## 2. Other bugs found and fixed

### 2.1 A goalkeeper parried his own parry (double touch)
The clip-contact save path and the new sweep both fired on the same shot: `SAVE … gk_parry` twice,
0.1 s apart, on a ball the keeper had already deflected (12–13 saves per match counted for 7 shots).
The keeper can no longer play the ball twice without another player touching it
(`ball.kickedBy === gk.idx`), and the clip's contact frame bails out when the sweep already resolved
the shot. Regression: *"one shot produces one save"*.

### 2.2 The keeper's read of the flight time
Regression: *"the keeper's read of the flight time is the flight time, not double it"* — read 0.375 s
vs a straight-line 0.337 s (it was 3× the truth).

### 2.3 Goal kicks were aimed at where the receiver had been
`evaluateGkDistribution` led the receiver by a flat **0.4 s** — a 4 m pass — while a goal kick travels
15–22 m and hangs for 1.5–2.5 s. Both the receiver's spot and the *space* around it were evaluated
where nobody would be. In the 1234 replay this produced four identical cycles of
`goal kick → #2 controls → tackled instantly → shot` in a row. The lead is now derived from
`estimateKickTravelTime` and the opponents are projected to the same arrival instant.
Regression: *"a goal kick is played to where the receiver will be, not where he is now"*.

### 2.4 A stationary striker could strike a ball behind his body
The pivot gate for kicks only ran when `p.speed > 0.45`; the AI's shot decision sets
`desiredSpeed = 0`, so a standing player's facing was never checked. He now turns on the spot first
(`kickTurnT` still backstops a pinned body). Regression: *"a stationary striker turns his body before
striking a ball behind him"*.

### 2.5 Tackles: fouls and whiffs
Replay of five matches before: **213 challenges, 22 % fouls** (46), 31 % whiffs (67). 43 of the 46
fouls were "blindside" at the contact frame, but the challenger had committed from the front
(commit dot +0.36…+0.66): the carrier had turned his back into a challenge and won a free kick for
it. Two changes:

* the foul rule now needs the challenge to have been blind-side **when it was committed**
  (`blindside && blindsideCommitted`, the same flag the referee already grades cards on);
* the AI no longer lunges at a ball that is out of reach now or will be by the contact frame
  (`canTackle`: current ball distance and the projected distance, using the clip's own contact time
  and the carrier's velocity). Callers had gated on distance to the *carrier* (1.5 m) while the ball
  sits 0.5 m ahead of him.

After (five matches): **183 challenges, 5.5 % fouls (10), 32 % clean, 6 % spill, 43 % whiff**.
Fouls per match fell from ~9 to ~2.

### 2.6 Shot selection
Long shots were still over-selected once the spread widened (one four-minute replay produced 37
shots and 23 goal kicks). The shoot utility now pays `0.30 × (distance − 9) / 6`, so the AI prefers a
pass unless the shot is genuinely on.

---

## 3. Per-scenario findings

**A. Corners** — trigger, staging, delivery and return to play all check out
(`scenario-regression`: corner taker 0.94 m from the ball outside the touchline, delivery lands 4–10 m
off the goal line with a named receiver, `corner_kick` clip contact at 0.55 s). No NaN, no
out-of-pitch frames, no stuck states, no restart loops. Attackers/defenders are staged in the box and
the keeper is 0.72 m off his line. Corners are now rarer in match play (0–1 per four-minute match)
because more shots are being saved or parried rather than deflected behind.

**B. Free kicks** — foul detection, ball spot, retreat, wall formation and delivery are intact; the
wall is posted `fkWallDistance` from the ball across the near post and no wall is posted for a kick
level with the byline (`fkWallMinHeight` regression). The taker strikes with the body already lined
up (`yawOfVector` of the delivery) and the contact watchdog releases any wind-up that never lands
(2.4 s). No clipping through the wall was observed; no NaN velocity.

**C. Penalties** — keeper staged on the line (line offset 0.00 m), nobody else in the area, taker
0.9 m behind the ball, driven low at a corner (never a chip). The keeper used to be frozen for the
whole flight; he now always attempts a save (16/16 vs 12/16 attempts previously, all from a freeze),
and a penalty is neither an automatic goal nor an automatic save. Remaining: the save rate is still
high (~60 %), and the run-up is short — the taker starts 0.9 m behind the ball.

**D. Throw-ins** — the ball is released *inside* the touchline (the taker stands 0.3 m outside), so
the throw is not re-awarded to the opponent every second; the taker faces the target, the ball leaves
the hands with real velocity and the receiver collects it. No stuck-ball or zero-velocity cases.

**E. Standing tackles** — see §2.5. Timing is validated at the clip's contact frame, clean wins take
possession with a protection window, failures stumble the challenger, no permanent control loss, no
double state change. Fouls are now rare (5.5 % of challenges) and the "spam" rate is down.

**F. Slide tackles** — slides still occur in live play (regression), recovery is longer than standing
(1.55 s vs 0.85 s), `pendingGetUp` defers the get-up until the clip ends (no mid-slide snap), and the
slide's contact frame is the only place possession changes. Slides are now less frequent (21 in five
matches vs 50) because the AI no longer commits to slides it cannot reach — worth watching for
"never slides" in a larger sample.

**G. Passing** — the goal-kick distribution lead bug (§2.3) was the one systematic "terrible option
repeatedly" pattern found. Short passes, through balls, lofted and driven passes all resolve through
`resolveStrike` with power/direction from the plan; no pass-through-collider cases were reproduced
and no frozen receivers.

**H. Dribbling** — the ball stays glued 0.48 m ahead of the carrier (median gap 0.48 m, no vibration
at the feet), turns are natural, and no leg clipping or touchline sticking was reproduced. The ball
detaches only on a strike, a tackle spill or the dribble-touch contact.

**I. Goalkeeper** — catching/parrying/diving/distribution all exercised: 72 of 85 shots draw an
action, one save per shot (double-touch fixed), the hold limit forces a release, and no
ball-through-keeper cases were found. `GK SMOTHER` also counts as a `SAVE` event, which inflates the
match save count (17–31 per four-minute match); that is a stats-labelling issue, not gameplay.

---

## 4. Integrity after the changes

Six four-minute CPU-vs-CPU replays (`1234 777 42 2026 99 5`): **0 NaN frames, 0 out-of-pitch live
ball frames, 0 anomalies**, max possession 4.9–6.3 s, restart counts balanced (kickoffs 3–7,
free kicks 1–3, throw-ins 0–2, goal kicks 2–23, corners 0–1).

Scores: 1:1, 0:2, 0:1, 5:0, 0:5, 0:3. The two 5-goal blowouts are a warning sign — see below.

## 5. Open items

1. **Blowouts and lopsided results.** Two of six replays ended 5:0 / 0:5, and BLUE won four of six.
   A keeper read error that goes one way early compounds over a short match; worth a larger seed
   sample before tuning.
2. **Seed 1234 shoots a lot.** 37 shots and 23 goal kicks in four minutes (other seeds: 21–23 shots).
   The range cost helped other seeds but not this one.
3. **Penalty save rate still ~60 %** and the run-up is 0.9 m; real penalties are converted ~78 % of
   the time.
4. **`SAVE` events include smothers/claims**, so match "saves" overstate shot-stopping.
5. **Slide-tackle frequency** dropped with the reachable-challenge gate (21 in five matches). Still
   present in live play, but the long-run rate should be watched.

## 6. How to re-run

```bash
cd "game prototype"

# full regression suites (all green)
npm run verify:motion && npm run verify:duels && npm run verify:gameplay \
  && npm run verify:perception && npm run verify:referee && npm run verify:scenarios \
  && npm run verify:physics && npm run verify:tactics && npm run verify:keeper

# replay a match
npx esbuild scripts/watch-match.ts --bundle --platform=node --format=cjs \
  --outfile=.test-artifacts/watch-match.cjs && node .test-artifacts/watch-match.cjs 1234

# shot / keeper measurement
npx esbuild scripts/shot-keepers.ts --bundle --platform=node --format=cjs \
  --outfile=.test-artifacts/shot-keepers.cjs && node .test-artifacts/shot-keepers.cjs 1234 777 42

# tackle outcomes
npx esbuild scripts/tackle-audit.ts --bundle --platform=node --format=cjs \
  --outfile=.test-artifacts/tackle-audit.cjs && node .test-artifacts/tackle-audit.cjs 1234 777 42

# start the game
npm run dev
```
