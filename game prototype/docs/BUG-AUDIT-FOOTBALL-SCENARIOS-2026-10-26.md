# Bug Audit — CPU vs CPU Football Scenarios (2026-10-26)

Verified replay audit of corners, free kicks, penalties, throw-ins, standing and
slide tackles, passing, dribbling and goalkeeper behaviour in the 5v5 engine.

This revision **supersedes the first draft of this document**. That draft was a
code-reading pass; several of its conclusions did not survive being replayed
(see [Corrections](#corrections-to-the-first-draft)). Everything below is backed
by a headless trace, a scenario replay or a seed batch, and every fix has a
regression test.

## How this was verified

| Harness | What it does |
|---|---|
| `npm run verify:scenarios` | 8 new regressions — one per fixed defect (restart geometry, aim, risk gates) |
| `npm run verify:referee` / `duel` / `gameplay` / `perception` / `physics` | existing suites (18 / 17 / all / 19 / 26 checks) |
| `npm run verify:tactics` (tactics-test) | corner/goal-kick/free-kick staging shape |
| `scripts/watch-match.ts` | a full 240 s match headless: restart lifecycle, NaN, out-of-pitch, loop detector |
| `scripts/watch-scenarios.ts` | forces one restart of a given kind and follows the delivery |
| `scripts/watch-batch.ts` | kind × seed tally (goal/save/kept/lost, taker distance, keeper line offset) |
| `scripts/watch-behaviour.ts` | match-wide tackle / slide / pass / dribble / keeper meters |

Three full matches (seeds 1234, 777, 42) plus 6–40 seed batches per restart kind.
All suites pass; `npx tsc --noEmit` is clean.

**Full-match result:** 0 non-finite frames, 0 live frames with the ball outside
the pitch, 0 restart stalls, 0 restart loops, and every restart kind completes
(kickoff 2.82 s, free kick 2.83–2.97 s, throw-in 3.07–5.02 s, goal kick 2.92 s,
corner 3.02 s from setup to release).

---

## Defects found and fixed

### D-1 🔴 Throw-ins never entered the pitch (infinite re-award loop)

**Symptom.** Throw-ins in a full match repeated at the same spot ~once a second,
alternating teams (`THROW_IN @ (18.8, 12.3)`, `(18.7, 12.3)`, `(18.6, 12.3)` … for
five minutes). The per-kind duration table showed `avg=-213.91 s` because the
next throw-in was awarded before the previous one could ever "close".

**Root cause.** The taker is placed *outside* the touchline
(`z = ±(W/2 + 0.3)`, correct), and the contact frame released the ball **at the
taker's own position**. `outGoalCheck` sweeps the ball against the line with the
ball radius; a ball resting 0.3 m beyond the line is already out, so the throw
was re-awarded to the opponent on the very frame it was taken. Note this was
introduced by the earlier "taker must stand outside the touchline" fix: the
placement was fixed without moving the release point.

**Fix.** `clampReleaseInsidePitch()` (`match/contacts.ts`) pulls the release
point 0.03 m inside the line; the throw is planned, aimed and struck from that
point, and a cancelled throw restores the held position so a retry cannot see a
displaced ball. The held ball is pinned at the same inside point
(`match/frame.ts`).

**Evidence.** All throws now release inside the pitch and no throw-in is awarded
again within 2 s. Regression: *"a throw-in leaves the hands inside the pitch and
is not re-awarded"*.

### C-1 🔴 Penalty defenders stood across the goal mouth

**Root cause.** The block was staged at `ownGoal.x + sign * 6.3` — the goal line
plus the box depth in the **wrong direction** — so four defenders were placed at
x = ±19.2, i.e. 0.8 m from the line, between the posts. `penaltyEdgeDrop`
(4.2 m, documented) was never read.

**Fix.** The block now sits at
`ownGoal.x − sign * (penaltyAreaDepth + penaltyEdgeDrop)` = 10.5 m from the goal
line and behind the ball; `penaltyEdgeDrop` is live.

**Evidence.** Defenders now stand at x = 9.5 (10.5 m out, outside the area and
behind the spot) instead of inside the six-yard box.

### C-2 🔴 The penalty keeper was 0.8 m off his line

**Root cause.** `stage()` clamps every body to ±(L/2 − 0.8) so outfielders stay
in play. The keeper was staged "on the line" and then clamped off it. A second
clamp in `resolvePlayerCollisions` did the same thing.

**Fix.** The penalty keeper is placed directly (position, facing, zero velocity)
and both clamps grant him the buffer margin while a penalty is pending.

**Evidence.** `gkOffLine = 0.00 m` on every sampled penalty (was 0.80).

### C-3 🟠 The penalty aim point was clamped 1.4 m short of the goal

**Root cause.** `sampleRestartTarget` clamps every aim point inside the pitch
(`outPlaySafetyMargin`). A penalty lane target of `(20.0, ±1.05)` became
`(18.6, ±1.05)`, so the ball was struck *along* the line between the spot and
the goal: at the goal line the same straight ray is 1.58 m off centre — outside
the post. Penalties were missing the goal from the spot.

**Fix.** The clamp now applies to **deliveries only**; penalties and direct free
kicks inside 13 m keep their goal-mouth aim point.

**Evidence.** 40 sampled penalties (20 seeds × both sides): 26 goals, 14 saves,
0 misses wide. Each strike crosses the goal line inside the posts and under the
bar (asserted geometrically in the regression).

### C-4 🟠 A third of penalties were chipped over the bar

**Root cause.** The generic shot chooser applies the "close range → chip" rule
(`< 11 m`, 35 %), and a chip is launched at 25–40°. From a 4.2 m spot that
clears the 2 m bar.

**Fix.** A penalty is always struck with `shot_low_driven`.

**Evidence.** Launch angle ≤ 12° on every sampled penalty (was 25–40° on roughly
a third of them).

### F-1 🔴 Slide tackles could never start (dead tackle type)

**Root cause.** `tackleRisk = style.risk × (0.5 + aggression/150) ×
(1.25 − discipline/150)`. Across the generated roster that product is
**0.65–0.91**, while the challenge gates are absolute: `> 1.02` for the presser
and `> 1.12` for the closest defender. Measured over 1266 frames in the 1.4–2.55 m
challenge band: **zero** frames above either gate. An entire tackle type, its
reach, its recovery and its foul path were unreachable code — three full matches
produced 0 slide animations.

**Fix.** `CONFIG.tackle.riskScale = 1.35` moves the roster to ≈0.88–1.23 across
the gates, preserving the ordering and the booked-player multiplier.

**Evidence.** 12 / 4 / 2 slide animations per 240 s match, 0.87–0.93 s each
(the clip is 0.95 s), and the tackle outcome mix now includes slides'
spill/recovery path.

### B-1 🟠 Free-kick and penalty takers stood on the ball

**Root cause.** Non-corner restarts staged the taker at the restart spot itself,
so his boots were inside the ball during the whole setup, and the possessed ball
was glued 0.48 m in front of him on the first live frame — it popped forward off
the spot.

**Fix.** The taker is staged 0.90 m behind the ball on the goal line through the
spot (a real approach step).

**Evidence.** Taker distance at the live frame is 0.90 m (was 0.00 m).

### B-2 🟡 `fkWallMinHeight` was dead config — a wall was posted from the byline

**Root cause.** The "no wall when the kick is too wide" rule documented on
`fkWallMinHeight` (0.6 rad) was never read; a wall was posted for any free kick
inside 17 m of goal, including kicks almost level with the goal line, where a
wall across the goal mouth is meaningless.

**Fix.** The angle above the goal line is computed and the wall is only posted
when it clears the threshold.

**Evidence.** Central 8 m free kick: 2 men at 3.2 m, on one line. Corner-flag
angle: no wall (one incidental marker at most).

### A-1 🟠 Every corner was aimed at the keeper's near post

**Root cause (two layers).** (a) The delivery was aimed at the *runner's current
position*, and the shallow runner spots (2.2–2.6 m from the goal line) are
exactly where the defending keeper stands; (b) the named receiver ran to the
*planned* point, not to the ball, so even a metre of delivery error left him
watching the ball drop beside him. Measured on 12 sampled corners: the keeper
claimed **7** without moving, defenders 4, attackers **1**.

**Fix.**
1. Corner zones and runner spots moved to 4.4 / 5.8 / 7.6 m off the goal line —
   the realistic attack zone on this 40 m pitch.
2. The delivery targets the **zone** (the runner nearest it is still the named
   receiver), nudged 0.8 m to the attacker's side of the marker.
3. A named receiver now chases the **projected ball** when it differs from the
   plan by more than 0.8 m ("the plan is a prediction; the ball is the truth").

**Evidence.** On the same 12 seeds: keeper 1, defenders 4, **attackers 7**.
Regression: *"a corner is delivered into the danger area, not onto the keeper's
near post"*.

### G-1 🟡 Ground passes were played straight through defenders

**Root cause.** `laneSafety` only *discounts* a blocked lane; the forward-progress
bonus routinely outweighed it. Measured across three matches: passes whose lane
passed within 1 m of an opponent were intercepted **29 of 39 times (74 %)**;
lanes over 1.5 m completed 65–75 %.

**Fix.** A hard gate: a ground pass (`pass_short`/`pass_through`, not a cross or
a lofted `pass_long`) is not considered when the lane clearance is under
`CONFIG.ai.minGroundPassClearance` (1.15 m).

**Evidence.** The gate removes the most hopeless balls; overall retention stayed
~65 % (see [Remaining issues](#remaining-issues-not-fixed)).

---

## Scenario walkthrough

Status: ✅ correct, 🟠 fixed in this pass, ⚠️ known limitation (documented below).

### A. Corners
- ✅ Ball placed on the corner arc (0.25 m inset), pinned there through the setup.
- ✅ Taker outside the touchline, behind the ball, shoulders square to the box.
- ✅ Three named box runners plus a short option; defenders mark a step goal-side.
- 🟠 Delivery zone and receiver tracking — see A-1.
- ✅ Delivery is lofted (apex ~2.4–2.9 m) and in-swinging; a corner now produces
  a contested ball in the box, not a pass to the keeper.

### B. Free kicks
- ✅ Foul detection, spot placement at the foul, 2.0 m opponent clearance.
- ✅ Wall on the ball→near-post line at 3.2 m, 3 men inside 12 m, 2 beyond.
- 🟠 Taker approach (B-1) and the too-wide guard (B-2).
- ✅ `fkBoxGuard` / `fkBlockDrop` / `fkWallCloseRange` are live.

### C. Penalties
- ✅ Ball on the spot (4.2 m), taker chosen by penalty rating.
- ✅ Attacking players outside the box and behind the ball; defenders 10.5 m out.
- 🟠 Keeper on the line (C-2), block placement (C-1), aim (C-3), shot profile (C-4).
- ✅ Rebounds are ordinary loose balls; no loop.

### D. Throw-ins
- ✅ Award point is the interpolated touchline crossing.
- ✅ Taker outside the line, ball held at 1.65 m.
- 🟠 Release point (D-1) — throws now start inside the pitch and enter play.

### E. Standing tackles
- ✅ Fires at < 1.55 m (presser < 1.5 m) with a facing/front-dot gate.
- ✅ Quality score → clean / spill / miss / foul; recovery + protection timers.
- ✅ 3–5 fouls and 0–1 cards per match; no re-tackle ping-pong.

### F. Slide tackles
- 🟠 Reachability (F-1).
- ✅ 0.95 s clip, 1.55 m ball reach / 2.45 m body reach, 1.55 s recovery,
  1.85 s cooldown; the slide wins the ball on the same deterministic quality model.

### G. Passing
- ✅ Pass power is solved against the real drag/spin model; arrival estimates
  match measured arrival to ~10 ms on short passes.
- 🟠 Ground lanes blocked by a defender (G-1).
- 🟠 Named receivers track the ball, not the plan (part of A-1).
- ⚠️ Completion is ~54–62 % to the named receiver + 9–13 % to another teammate
  (≈65 % retention) against a config target of 82 %.

### H. Dribbling
- ✅ Ball glued 0.48 m ahead of the carrier; carrier speed capped by role/stamina.
- ✅ No stuck carriers: 7 episodes ≥ 0.33 s in 240 s, every one immediately
  after winning a tackle (recovery/plant), max 0.38 s.
- ⚠️ `dribble_touch` is rare (0–40 frames per match) because it needs > 5.5 m/s
  and a low roll; cosmetic.

### I. Goalkeeper
- ✅ Gathers are legitimate: 67 possession gains over 5 matches, median 0.85 m,
  p99 1.94 m, **none** over 2 m.
- ✅ Shot reads: reaction time, dive direction, standing reach, off-balance
  penalty; parries deflect away (no save loop).
- ✅ Smother and 1v1 logic inside the box; angle-arc positioning in open play.
- ✅ Hold limit 8 s is by design (asserted by the referee suite; the Laws' 6 s
  would need a deliberate tuning change).
- ✅ Penalty keeper placement (C-2).

---

## Corrections to the first draft

| Draft claim | What the replay showed |
|---|---|
| D-1 "throw-in taker placed 0.18 m **inside** the pitch" | The taker is at `W/2 + 0.3` — 0.3 m **outside**. The draft's "fix" (move him outside) is what the code already did; the real defect was the *release* point, which made every throw out of play on the throw frame. |
| C-1 "penalties are taken from the foul location" | Already fixed before this pass: `contacts.ts` calls `startSetup("penalty", [spotX, 0])`. |
| C-5 "only allowed players inside the box — correct" | The defenders were on the **goal line**, inside the six-yard area (see C-1). |
| G-6 "the ball model has no player-body collision" | It has one (`resolveBallPlayerCollisions`); the paragraph then describes it. |
| I-3 "body catch < 9.5 m/s vs action catch < 16.9 m/s" | Both paths use `CONFIG.ai.gkCatchSpeed` with the same handling factor; the difference is the smother radius, not the speed. |
| A-2/A-7 "ball pinned at the corner through the animation — correct" | Correct, and still true. |

---

## Remaining issues (not fixed)

1. **Pass completion ~65 %** against an 82 % config target. Two structural
   causes remain: the trap radius is `(controlRadius + 0.3) × receivingScale`
   ≈ 1.05 m from the body centre (so a defender can trap a ball he barely
   reaches), and defenders' interception runs use a perfect trajectory
   prediction with no reaction delay. Fixing either changes the feel of every
   duel; it needs a dedicated balance pass with the realism targets.
2. **Corner goals are rare** (0 in 32 sampled corners, 13 saves). The deliveries
   now reach the box and are contested — the next step is attacking runs onto
   the ball rather than static runners.
3. **`dribble_touch`** is almost never sampled (needs > 5.5 m/s and a low roll).
4. **GK hold limit 8 s** is longer than the Laws' 6 s; it is a deliberate,
   test-asserted setting, so it was left alone.
5. **Restart cadence** — a restart takes 2.8–3.0 s from setup to release; the
   animation contact frames dominate this and it is by design.
