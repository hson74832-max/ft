# Reported gameplay defects — causes, fixes, verification

Branch `arena/e9857b43-ft` (game code under `game prototype/`). Date: 2026-10-25.
Every fix below is backed by a regression check that fails when the fix is reverted
(negative controls were run by mutating the source and restoring it).

## 1. Reported defects

| Reported problem | Cause found | Change |
| --- | --- | --- |
| Goalkeepers can be tackled while holding the ball; the opponent then scores | Nothing in the duel path knew that a keeper holding the ball is not a tackleable carrier. Three entry points accepted the challenge: `startAction` (wind-up), `canTackle` (AI keeps selecting it) and `evaluateTackle` (contact frame, e.g. a challenge that started before the catch) | `keeperHasBallInHands()` in `match/tackles.ts` (keeper in possession **and** `handsRestrictedTeam` not his team). `startAction` refuses the wind-up, `canTackle` refuses the selection, `evaluateTackle` marks the carrier `protectedCarrier` so the challenge can neither win the ball nor become a foul against the keeper. A keeper playing a deliberate back-pass (`handsRestrictedTeam === his team`) stays challengeable |
| Keeper faces the goal line instead of play / side-on inside the goal area | `stepPlayers` turned **every** player to face his velocity; a keeper shuffling backwards or side-stepping along his line therefore turned his back to the pitch | A keeper who is not the carrier now faces the ball (feet can travel sideways under him); the velocity rule is kept when he has the ball at his feet |
| Defenders surrounded in their own box are dispossessed instead of clearing | The decision layer only scored *named* passes (`planNamedPass` rejects a pass with no reachable receiver), so a swarmed defender's only options were short passes, a dribble or a hold. A bail-out to the keeper (perfect lane, 17 m backwards) counted as "safe", so the clearance branch never saw "no safe outlet" | `possessionDecision` has an own-box/own-third safety valve: swarmed + no outlet whose lane and space are genuinely safe ⇒ `pass_long` with no named receiver to an upfield escape point. `onContact` resolves that intent (identified by `passTo === undefined`, which a real pass never is) as a lofted clearance. A back-pass to the keeper from inside the box under the press no longer counts as safe |
| Players rarely cross or use long balls — they only play short passes infield | (a) No cross or switch intent existed in the pass scorer, so a ball into an occupied box was scored like a ground pass to a marked man and lost to a safe square ball. (b) A defender standing on the passer zeroed the lane score of *every* option. (c) The long ball itself was the shortest kick in the game: `passProfile("pass_long")` used loft 0.06, the worst point of the loft sweep — the ball left the ground just enough to bounce and each bounce costs 35% of the horizontal speed, so a 24 m/s long pass carried **22.2 m**, less than an 11 m/s short pass (**27.8 m**) and short of the 27 m the pass scanner will aim at | (a) `crossBall`/`longSwitch` detection in the option loop: a cross is scored on its delivery lane and is exempt from the receiver-crowding penalty, a diagonal long ball is scored as a switch; `tactics.ts` gives a wide carrier a runner attacking the **middle of the box** (previously only the half-space outside it). (b) documented, not changed — see §3. (c) loft 0.20: carries 31.3 m and is power-calibrated over 14–26 m |
| Defenders get baited wide / end up goal-side of the attacker | The press target was the carrier's **current** position, so a defender chasing a winger ran to the touchline and arrived behind him; the marker target was the attacker's current position, so a defender marking a moving attacker trailed the ball | The presser leads the carrier's velocity and, when he has been played past, offsets to the goal side; the marker targets the attacker's *predicted* position and sprints to the goal side of him when beaten |
| "It seems like there are no fouls" | `MatchEngine.foulsOn` defaulted to **false**, so every foul was recorded and then thrown away ("play on"), **and** the box test for a penalty compared the foul spot with the *fouled* team's own goal, so no penalty could ever be awarded | `foulsOn = true` by default (the Settings toggle still exists); the box test uses the goal the carrier is attacking |
| Add tackle timing: bad timing ⇒ foul if the defender hits the attacker | The duel only had `lateRatio` (a delayed contact frame) and `staleTarget` (the carrier changed during the wind-up). The ordinary mistimed challenge — body on the man, ball out of reach at the contact frame — was scored as a clean miss | `mistimed = heavyContact && ballDist > reach * 1.6` in `evaluateTackle`; it forces `outcome = "foul"` (never against a protected keeper). `TackleQuality` reports it and the reason string says `mistimed contact` |

## 2. Measured before / after

8 seeds (1234, 777, 42, 9, 55, 31337, 4, 88), 4-minute matches, identical code paths
except the changes above:

| Metric | Before (main) | After |
| --- | --- | --- |
| Goals (8 matches) | 62 | 53 |
| Shots | 196 | 163 |
| Passes | 555 | 453 |
| `pass_long` passes | 38 (6.8%) | 73 (16.1%) |
| Foul events | 99 (all discarded) | 32 (all whistled) |
| Free-kick restarts | 2 | 35 |
| Penalties | 0 | 1 |
| Tackle win rate | 74 / 329 attempted (22.5%) | 73 / 202 (36.1%) |
| Keeper facing · mean dot with the ball | 0.545 | 0.999 |
| Frames with the keeper's back to the ball (dot < −0.2) | 18.6% | 0% |

Per-match fouls are ~4 with ~4.4 free kicks; the tightest observed run is 1 foul in a
match and the highest 7. Box deliveries are ~4 per match (17 of 231 passes in 4 seeds,
all of them from a wide carrier), i.e. the cross is now a real option without becoming
the default.

## 3. Findings from the bug / loop / dead-code pass

Fixed (see §1): fouls were dead code in practice (`foulsOn = false` plus the wrong goal
for the penalty test); the keeper was tackleable; keeper facing; clearance; cross and
switch scoring; long-ball range; press/mark targets; `canTackle` allowed standing
challenges from the blind side (`frontDot` was only checked for slides, so the AI kept
committing challenges that could only ever be fouls); a foul's extra recovery was
re-armed **at the contact frame** (`Math.max(p.tackleRecoveryT, tackleRecovery(action)
+ 0.45)`), doubling the window the module documents as "recovery starts with the
attempt" — now only the +0.45 foul penalty is applied there.

Documented, deliberately not changed:

1. **A defender standing on the passer zeroes every lane score.** `laneSafety` clamps
   the projection to `t >= 0.06`, so an opponent 0.9 m away sits at the very start of
   every segment with a gap of ~0.2 m and drives `safety` to 0 for all options. A
   pressed carrier therefore sees no lane at all. Fixing it (ignore opponents within a
   metre of the passer, or measure the lane from a shifted origin) changes every pass
   score in the game; it also *is* how the clearance valve detects a swarm
   (`options.every(...)` never finds a safe outlet). Left as-is and worked around where
   the reported behaviour needed it (crosses are scored on their delivery lane).
2. **`kickPowerForRange` assumes power→range is monotone.** It is not: past the loft
   where the ball starts bouncing, range jumps up and down (at 24 m/s: 22.2 m at loft
   0.06, 24.7 at 0.08, 31.3 at 0.20) and a slow rolling kick out-ranges a driven one.
   The search returns the first table entry that reaches, so a request can be answered
   with a power that lands short — e.g. a 6 m long pass at loft 0.20 gets 7.4 m/s,
   which carries 5.0 m. The AI's long-ball band (14–26 m) was verified exact and is
   asserted in `selftest`; the general fix (scan the table from the far end so every
   faster power also reaches) would change every pass power in every match and needs
   its own verification pass, so it is not bundled here.
3. **`defensiveLineU` (ai.ts) returns 0 when a team has fewer than two players**, and
   `onsideLimit` (tactics.ts) falls back to the ball line — the AI-side twins of the
   offside bug fixed in `offside.ts` earlier. Unreachable in a 5v5 match (every team
   fields a keeper plus four), so left alone.
4. **`snap.players[best.idx]` in `bestInterceptor`** uses the player index as an array
   index. True for every engine-built roster (`idx === array position`), fragile for
   hand-built snapshots.
5. **Dead code, not removed** (per the "do not delete unused code" constraint):
   `yawOf` (`angles.ts`), `tackleCooldown` (`config.ts` consumer side),
   `validateSkeletonContract`, `registerMotionAnimation`, `unbindFieldMotionClip` and
   `getMotionSlots` (`motion.ts`) are exported and never referenced by `src/` or
   `scripts/`.
6. **Per-frame allocations in `stepPlayers`**: `new THREE.Vector3()` once per player per
   frame for body separation (10 per frame at 60 fps) plus the same in
   `resolvePlayerCollisions`. GC churn rather than a correctness bug; `match/scratch.ts`
   already exists for the vectors that were hot enough to matter.

No infinite loops: the only `while` loops are bounded (`buildKickRangeTable` by
`steps++ < maxSteps`, `rigBoneWorldDirection` by the skeleton length), match phases are
timer-driven, and every one of the 8 seeds plus the three `support-match` seeds reaches
`FULLTIME` (replay-identical for the same seed).

## 4. Verification

```bash
cd "game prototype"
npx tsc --noEmit
for s in selftest duel-regression tactics-test support-regression kickoff-regression attacking-runs support-match motion-pipeline; do
  npx esbuild scripts/$s.ts --bundle --platform=node --format=cjs --outfile=.test-artifacts/$s.cjs && node .test-artifacts/$s.cjs
done
npx esbuild scripts/ai-repro.ts --bundle --platform=node --format=cjs --outfile=.test-artifacts/ai-repro.cjs
node .test-artifacts/ai-repro.cjs && node .test-artifacts/ai-repro.cjs --gk
```

Results: `tsc` clean; `selftest` all checks; `duel-regression` 17/17;
`tactics-test` all checks; `support-regression` 28/28; `kickoff-regression` 7/7;
`attacking-runs` 8/8; `support-match` 3 seeds to `FULLTIME` with deterministic replay;
`motion-pipeline` OK; `ai-repro --gk` 49% save rate (37/75).

New regression checks added with these fixes:

- `tactics-test` §3b: the pressing defender closes from the goal side of the ball and is
  never dragged outside the touchline; the centre stays covered while the ball is wide.
- `tactics-test` §3c: 20 seeds of a swarmed defender in his own box — the decision is a
  clearance, and the contact frame really releases the ball long and away from goal
  (25.2 m/s, `vel.x` +23.8).
- `tactics-test` §3d/§3e: a wide carrier's plan includes a runner attacking the middle
  of the box, and the AI delivers into an occupied box with an open **and** a
  part-blocked delivery lane (20/20 seeds each).
- `selftest`: a long pass out-ranges a short pass, reaches the whole 27 m scan window,
  and is power-calibrated at 14/18/22/26 m.
- `duel-regression`: a challenge that hits the man but not the ball is a foul, stops
  play, gives the free kick to the fouled side, and is a penalty inside the box being
  attacked; a goalkeeper holding the ball cannot be tackled (wind-up refused, and a
  challenge already in flight wins nothing and is not a foul either).
- `attacking-runs`: the match-level assertions now aggregate three seeds instead of
  reading one — a single seed's penetrating-pass share swings between 5% and 18% with
  identical code, which is seed luck, not behaviour.
- `motion-pipeline`: "the match kept progressing" asserted `rules.live` after 45 s of
  frames, which is now legitimately false while a foul restart freezes play; it asserts
  the match clock advanced instead.
