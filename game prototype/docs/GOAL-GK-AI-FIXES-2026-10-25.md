# Goal detection, keeper 1v1s, panic clearances, AI loops, Blocky-only — 2026-10-25

Scope: `game prototype/src/game/**`, `src/App.tsx`, `src/ui/Modals.tsx`, one new
regression script. Every defect below was reproduced first against the real
headless engine (`scripts/gameplay-regression.ts`, `npm run verify:gameplay`:
7 of 10 checks failed before the fix, 10/10 after). No tuning constants, clip
names, rule-event names, snapshot fields, frame order or class structure were
changed; new code reuses existing constants (`gkRushLine`, `catchRadius`,
`decisionNoise`, `noveltyPenalty`, box dimensions already in use) and the
existing per-player PRNG streams.

## 1. On-target shot awarded as corner/goal kick

**Root cause (two, same test):** `outGoalCheck` judged the ball at its
end-of-frame position and required it to still be inside a net window of
`goalDepth + 0.4 = 1.6 m` behind the line. A 24–35 m/s shot travels 1.2–3.5 m
per frame (dt up to 0.05 s, doubled at timeScale 2), so it tunneled over the
window and fell into the goal-line-out branch. A diagonal shot that crossed
inside the post was wide of the post again by the detection frame and failed
the `|z| + R < goalWidth/2` test. Reproduced: 32 m/s at timeScale 2 →
goal kick; diagonal crossing at z≈1.33, detected at z≈1.58 → goal kick.

**Fix:** `Ball.prevPos` (recorded at the start of `Ball.step`) and a swept
segment test: where the segment prevPos→pos crosses the goal-line plane
(`±(L + R)`, whole ball over), interpolate z/y and judge posts/bar there.
The stationary net-volume test remains as a fallback when no crossing was
swept this frame (teleports/resume). The corner flag and the throw-in spot
are likewise taken from the crossing point instead of the sample position.

**Corner transition:** the taker is now chosen from live positions when the
ball goes out. `placeForRestart` ranked "closest to the flag" *after*
teleporting everyone to formation homes, so the home-nearest forward always
took it (reproduced: MID standing at the flag, FWD picked). Selection now
runs before the formation reset — the same live-position rule throw-ins were
documented to use. The defending keeper is also staged on his angle arc
(`keeperPositionTarget`, near-post side for the flag) instead of the
formation home in the centre of goal.

## 2. Keepers passive in 1v1s, never use hands

**Root causes:** (a) with an opponent carrying the ball, the keeper branch
fell through to the angle arc (~2.1 m out at 7 m range in the repro) — the
only "claim" path required the ball within 5 m of the goal centre;
(b) hands were physically incapable of winning a possessed ball: the
`gk_catch` contact case began `if (e.ball.possessedBy !== null) break;`, and
both other keeper-catch paths only see free balls.

**Fix:** `oneOnOneCarrier` detects a carrier through the line (≤ 2×
`gkRushLine` from goal, inside the box width, no outfield teammate
goal-side). The keeper then re-evaluates every frame (like the shot branch),
sprints to a stance `catchRadius` goal-side of the ball to close the angle,
smothers with `gk_catch` at the carrier's feet inside his box, and slides
with his feet outside it (hands illegal there). At contact, a smother is the
one legal hands-on-possessed-ball case: `gk_catch` only, opponent carrier,
keeper in his own box, carrier not tackle-protected, and only gathering a
ball exposed on the keeper's side of the carrier's body — a shielded ball
can at best be parried loose. With a defender goal-side the keeper keeps
holding the arc, so the goal is not vacated for the square ball.

## 3. Panic clearances

**Root cause:** clearance was a hard override before all scoring:
`pressure < 3.2 m` (nearest single opponent, any speed/direction) counted as
"swarmed", and the computed dribble escape lane was ignored. Reproduced:
one static attacker 3.1 m away, space ahead → clearance 20/20 seeds.

**Fix:** immediate danger is now arrival time — opponent inside tackling
range (1.55 m) or closing to arrive within ~1 s — and clearance additionally
requires no safe outlet *and* no forward escape lane. A defender who can
carry out, or who is merely being stood off, keeps the ball; the boxed-in
emergency (two opponents arriving, lanes shut) still clears 20/20.

## 4. AI action loops

**Root causes:** (a) deterministic argmax with a *saturating* novelty
penalty (0.38 cap ≈ 0.13 of pass score): a pass better than the runner-up by
more than that stayed best forever (A→B→A→B). (b) A kick cancelled at its
contact frame re-decided immediately into the identical kick — nothing
recorded the failure. (c) Tie-break jitter is a constant hash per player/key
while the carrier stands still, so equal states resolved identically.

**Fixes:** pass selection samples probabilistically from the near-best pool
(exponential falloff at the existing `decisionNoise` temperature, via the
player's own PRNG stream); the pool is like-for-like — it never crosses the
keeper/outfield boundary or trades a safe ball for an unsafe one, so the
existing "recycle to the pivot, not the keeper" preference stays
deterministic. A consecutive-repeat streak penalty (uncapped, on top of
novelty) guarantees repetition eventually costs more than the lane is worth.
Cancelled kicks are remembered (`noteKickFailed`): penalised once, excluded
after two straight failures, cleared on the next released kick.

## 5. Seed, individual AI, team AI, action scores

Already present from the earlier hardening pass and kept: independent PRNG
streams (match / coin toss / per-player decisions / restart attempts),
per-player styles, `TeamTactics` plans/phases, deterministic contact
resolution. Gaps closed here:

- Player styles in real matches now come from each player's own stream
  (`ai-style:<idx>`); building or removing one player no longer re-rolls
  every teammate's attributes. The seed only sets attributes and noise.
- Team AI: each side has a match mentality (`TeamTactics.teamStyle`:
  directness 0.85–1.15, pressing 0.85–1.15), hashed from the seed — not
  drawn — stamped on every `AttackPlan`. Directness tilts the carriers'
  collective gain-vs-safety weights; pressing scales how hard the unit steps
  out. Formations remain data-defined in `FORMATIONS`.
- Action scores now follow the requested structure with existing inputs:
  pass = completion (lane, receiver space) × progression (gain, line break)
  − turnover (crowd, shut lane) − repetition; shot = quality (distance,
  lane, window) × finishing style − block risk − fatigue; dribble = space
  ahead × lane − pressure/tackle risk − stamina cost. The hold/recycle role
  is the existing reset valuation (`needsReset` + recycle purposes), not a
  new action. Outcome resolution (tackles, saves, traps) stays deterministic
  geometry as before — probability enters at *choice*, not as coin flips in
  physics, which keeps replays exact.

## 6. Blocky only

`Roundy` geometry, `MeshFamily`/`FamilyMode` types, the engine `family`
option, App state and the Team Selection mesh selector are removed;
`createPlayerMesh` builds the Blocky/cuboid flat-shaded rig only, and
`poseStressTest` reports Blocky variants. Team Selection keeps the two
clubs and the formation panel.

## Verification

From `game prototype/`:

```bash
npx tsc --noEmit          # clean
npm run build             # ok
npm run verify:gameplay   # 10/10 (was 3/10 before the fix)
npm run verify:duels      # 17 passed
npm run verify:motion     # ok
# headless suites, all exit 0:
# selftest, kickoff-regression, support-regression (28/28), tactics-test,
# attacking-runs (8/8), support-match (3 seeds to FULLTIME + deterministic replay)
```

Same-seed replay is still exact (`support-match` compares pass trajectories
across two runs); outcomes versus earlier builds legitimately shift where
the fixes bite (goals now counted, keeper rushes, sampled pass choices,
per-player style streams in real rosters).
