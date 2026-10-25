# Match engine audit — restarts, offside, possession

Branch: `arena/716a759d-ft` (repo `/home/user/ft`, game code under `game prototype/`).
Audit date: 2026-10-25. Every finding below was verified against call sites; confirmed bugs were fixed and all headless suites pass (tactics-test, kickoff-regression 7/7, support-regression 28/28, attacking-runs 8/8, support-match 3 seeds with deterministic replay, ai-repro; `tsc --noEmit` clean).

## 1. Restart flow (restarts.ts, contacts.ts, passPlanning.ts, collisions.ts, engine.ts, roster.ts)

### Fixed — restart can stay pending because the watchdog is armed too late
**Symptom:** `restartAuto` retries every 0.15 s, but the contact-frame watchdog (2.4 s release) only runs while `restartStartedId === pr.id`, and `restartStartedId` is only set when `startAction` succeeds. A taker whose `startAction` fails for a non-transient reason retries forever and never reaches the watchdog.
**Root cause:** no backstop between "startAction fails" and "restart pending forever".
**Fix:** in `restartAuto`, if `startAction` fails and the taker is not on cooldown (cooldowns decay every frame, so a cooldown failure is transient), release the restart to the taker instead of looping: sets `restartLaunchedId = pr.id`, clears `pendingRestart`, and calls the new `releaseRestartToTaker` helper.
**Files:** `src/game/match/restarts.ts` (`restartAuto` + new exported `releaseRestartToTaker`).

### Fixed — 3-failure fallback teleported throw-in/corner takers onto the pitch
**Symptom:** after 3 failed restart deliveries, the ball and taker were clamped to `[-L/2+1, L/2-1] × [-W/2+1, W/2-1]` — i.e. forced inside the field of play. A throw-in taker lawfully stands on the touchline (`z = ±(W/2 − 0.18)`), a corner taker behind the flag (`z = ±(W/2 + 0.55)`); the fallback moved them 0.2–1.55 m onto the pitch and dropped the ball at their feet — an illegal throw-in/corner position.
**Fix:** shared helper `releaseRestartToTaker(e, p)` clamps only to the buffer margin (`halfX ± (0.4 + buffer)`, same margin `stepPlayers` already grants restart takers), keeps the taker's staged position, copies `moveTarget`, zeros `desiredSpeed`, places the ball at the taker and possesses it. Used by both the `onContact` 3-retry fallback and `restartAuto`'s new backstop.
**Files:** `src/game/match/restarts.ts` (`releaseRestartToTaker`), `src/game/match/contacts.ts` (fallback now calls it).

### Fixed — restart takers clamped back inside the pitch by collision resolution
**Symptom:** `resolvePlayerCollisions` clamped every player to `[-L/2−0.4, W/2−0.4]` with no exception, running after `stepPlayers` had lawfully placed corner/throw-in takers in the buffer zone — shoving them back onto the pitch.
**Fix:** per-player clamp margin: `restartTaker ? CONFIG.pitch.buffer + 0.4 : 0`.
**File:** `src/game/match/collisions.ts`.

### Fixed — `planNamedPass` ignored the sampled restart target
**Symptom:** for restart kinds the pass planner used `destination = receiver.pos.clone()` — the receiver's *current* position — discarding the target sampled by `sampleRestartTarget` (throw-in downfield into the field, corner zone, goal-kick/ free-kick offset into space). A throw-in was lofted at a receiver standing on the touchline instead of into play.
**Fix:** `destination = restartKind ? passer.pendingKick?.target?.clone() ?? receiver.pos.clone() : …` — the sampled kick target (stamped on `pendingKick` by `restartAuto` → `startAction`) is used for restarts; non-restart paths are untouched.
**File:** `src/game/match/passPlanning.ts`.

### Fixed — `sampleRestartTarget` burned RNG when the GK distributor overrode it
**Symptom:** on goal kicks, `sampleRestartTarget` was always called first (consuming `e.rng` via per-candidate `range()` + `weighted()`), then `evaluateGkDistribution` threw the sample away and overwrote target/action/receiver. Every later AI draw shifted → match outcomes changed by an unused planner.
**Fix:** `restartAuto` asks `evaluateGkDistribution` first for goal kicks and only samples a restart target when the distributor returned nothing.
**File:** `src/game/match/restarts.ts` (`restartAuto`). Determinism note: the RNG stream for goal kicks now draws fewer values; there is no preserved golden master for goal-kick sequences in this repo state, so outcomes may shift versus earlier builds — that is the point of the fix.

### Fixed — stale restart IDs / dangling restart state on manual resets and repeated SETUP phases
**Symptom:** `resetPositions("kickoff")` (bound to the `r` key, also used by `placeForRestart` for kickoffs) never cleared `restartStartedId`/`restartLaunchedId`/`restartRetries`/`restartContactT`, and left a non-kickoff `pendingRestart` dangling — e.g. resetting mid-throw-in left a throw-in setup alive while players were kickoff-staged.
**Fix:** `resetPositions` now clears all restart bookkeeping, clears `pendingRestart` when it is not a kickoff, and clears the offside snapshot. `placeForRestart` also clears `offsideCandidates`/`offsideTeam` at placement start (re-snapped by `captureOffsideAtKick` at the kick). `engine.step` now clears `restartWaitReason` when no restart is pending.
**Files:** `src/game/match/restarts.ts`, `src/game/engine.ts`.

### Fixed — incomplete player-state reset on non-kickoff restarts
**Symptom:** `placeForRestart`'s non-kickoff branch only cleared `pendingKick`, `restartTaker`, `callForBall` and the animation controller; `holdT`, `stumbleT`, `celebrateT`, `decisionReason`, `utilities`, `supportJob/supportRun/supportMode`, `passOptions`, `lastActionSeed`, `runSerial`, `desiredSpeed` and `moveTarget` carried stale intent/timers into the restart setup (e.g. a GK's hold timer surviving into a goal kick).
**Fix:** the non-kickoff player loop now resets all of those (animation state already reset via `new AnimationController()`); `moveTarget.copy(p.pos)` and `desiredSpeed = 0` added. `resetPositions` (kickoff path) got the same intent/timer cleanup. Stamina is intentionally preserved (match-long resource).
**Files:** `src/game/match/restarts.ts`.

### Fixed — pending-forever exposure if the taker never appears
Not currently reachable (every restart kind stages an eligible taker), but `restartAuto` previously had no bound at all on "no taker / taker busy" retries. Covered by the same `releaseRestartToTaker` backstop path for non-transient `startAction` failure; transient cooldown failures still retry with `restartAutoT = 0.15` and self-heal.

### Investigated — not a bug
- "Restart repeatedly retries but never enters the contact watchdog because restartStartedId is never set": in the shipping code this cannot wedge the match — `startAction` can only fail on cooldown (≤1.4 s, decays every frame) or a missing clip (all restart clips exist in `ANIMATION_CATALOGUE`). The watchdog *is* armed after any successful wind-up and releases after 2.4 s if the contact frame never fires. The backstop above closes the theoretical gap.
- `placedRestartId`/`restartStartedId`/`restartLaunchedId` after `SETUP→INPLAY` expiry: `placeForRestart` runs at restart *creation* (the frame `startSetup` runs, before `rules.update` expires the freeze), so the expiry frame never skips placement; when `pendingRestart` becomes null, `step` wipes `started`/`launched`/`waitReason` next frame. IDs are monotonic (`rid++`), so no stale-id collision.
- `restartBlockReason` kickoff half-switch logic is consistent with `resetPositions` staging (both use `attackSign(pass/team, half)`); the `kickoff-regression` suite covers both halves.

## 2. Offside holes (offside.ts, contacts.ts, possession.ts)

### Fixed — offside player could gain possession without `flagOffside` (intercept / first_touch / dribble_touch)
**Symptom:** the `intercept`/`first_touch`/`dribble_touch` contact branch took possession of a free ball with no offside check — an offside attacker pouncing on a parry/deflection/loose ball was never flagged, while the ground-trap and header paths in `possessionCheck` *did* call `flagOffside`.
**Fix:** `if (flagOffside(e, p)) break;` before `e.ball.possess(...)` in that branch; `flagOffside` releases the ball, awards a free kick to the defending side at the ball spot and clears the snapshot.
**File:** `src/game/match/contacts.ts`.

### Fixed — second-last-defender calculation was wrong with fewer than two defenders
**Symptom:** `defenders[1] ?? -pitch.length/2` placed the offside line at the *own* goal line when 0–1 defenders existed, so virtually every attacker ahead of the ball was offside — the opposite of the law (no second-last defender ⇒ no offside position).
**Fix:** default is now `+CONFIG.pitch.length/2` (beyond the pitch ⇒ `u > secondLast + buffer` can never hold ⇒ no offside), in both `receiverOffsideAtKick` and `captureOffsideAtKick`.
**File:** `src/game/match/offside.ts`.

### Investigated — not a bug / by design
- **Restart exemptions:** `restartExemptFromOffside` covers exactly throw-in, corner, goal kick, kickoff — matching Law 11 ("no offside directly from a goal kick, throw-in or corner kick"). Free kicks and penalties are *not* exempt per the Laws, so creating offside candidates from them (`captureOffsideAtKick`/`receiverOffsideAtKick` called with `restartKind`) is correct; in practice a penalty can't trigger it (all attackers are behind the ball), and a free kick re-snapshots from restaged positions where attackers are rarely beyond the second-last defender.
- **`flagOffside` spot:** uses `e.ball.pos` at the involvement moment; the Laws restart from where the offside player was when the ball was played — at the instant of involvement these coincide; treated as an acceptable approximation, not a bug.
- **Header consistency:** header involvement is checked in both `possessionCheck` (aerial cushion, `flagOffside` before `startAction("header")`) and `onContact` (the `"header"` case is in the pre-contact `flagOffside` list, and `captureOffsideAtKick` ran at the kick). Consistent.
- **Candidates cleared "too aggressively":** clearing on tackle win, loose-ball claim, GK catch/parry, out-of-play and goals is correct — the ball was last played by the defending side, so the old attacking snapshot is stale. The real hole was the missing *flag* check (fixed above), not the clearing.
- **Offside tracking across half switches / goals / manual resets:** goals clear via `onGoalReset`; kickoffs (half-time and after goals) clear via the exempt `captureOffsideAtKick` entry; restarts clear at `placeForRestart`; manual resets now clear via `resetPositions`.
- `receiverOffsideAtKick` vs the engine's `captureOffsideAtKick` vs `ai.isOffsidePosition` duplicate the same test (noted duplication; the CODE-REVIEW structural backlog already tracks consolidating them into `offside.ts`). Functionally consistent.

## 3. Possession, transition, auto-switching (possession.ts, roster.ts, control.ts)

### Fixed — no attacking transition after loose-ball recoveries
**Symptom:** `trackPossession` nulled `seenOwnerTeam` whenever the ball became free. The team recovering a parry, deflection or tackle spill never got the 5 s attacking-transition window (`transitionTeam`/`transitionUntil`), because `team !== seenOwnerTeam` compared against `null`. Same-team re-possession after a pass only avoided a spurious transition by luck (both sides null).
**Fix:** while the ball is free, only clear `seenOwner`; keep the last-owning team until a new owner is established. Recovery by the opponent now starts `transitionUntil = clock + CONFIG.tactics.transitionSeconds`; same-team recovery does not.
**File:** `src/game/match/possession.ts`.

### Fixed — dead code: `possessionTicks` written, never read
**Symptom:** `possessionTicks` (capped ring buffer of `{idx, team}`) was pushed to in `trackPossession` and declared on `MatchEngine`/`MatchHost`, but nothing in `src` or `scripts` ever reads it.
**Fix:** removed the writes and the field declarations.
**Files:** `src/game/match/possession.ts`, `src/game/match/host.ts`, `src/game/engine.ts`.

### Fixed — human-player state changed in spectator mode
**Symptom:** `setHumanPlayer` and `switchToNearest` (the `[X]` manual switch) moved `humanIdx`/`isHuman`/`selectedIdx` even when `spectator === true`, while `humanControl` is correctly gated off — spectator mode claimed no human control but kept mutating the human slot on every possession change.
**Fix:** both functions now return early when `e.spectator`.
**File:** `src/game/match/roster.ts`.

### Investigated — not a bug / by design
- **Auto-switching away from the human at the wrong time:** `possessionSwitch` logic only runs on possession change (`o.idx !== lastKnownOwnerIdx`); gaining the ball switches to the receiver if they're a human teammate, losing it switches to the nearest human teammate; the previous `lastKnownOwnerTeam` is used (updated after the switch decision) so the direction is correct. Manual `[X]` switch is now spectator-guarded.
- **`possessionTicks` written never read:** see above — removed.
- **RNG in `possessionCheck` for `dribble_touch`:** `e.rng.next() < 0.025 * style.carrier` is drawn every carrier frame — engine logic and AI logic share the single `e.rng` stream (the engine passes its `rng` to `AIController`), so any unrelated engine draw shifts all subsequent AI draws and changes match outcomes. This is inherent to the shared-seeded-stream design (deterministic replays require one stream); isolating engine randomness (e.g. a dedicated engine-local RNG for the touch roll) would change replay semantics and is out of scope. Documented as a determinism hazard.
- **`startAction` rejected forever (cooldowns/missing clips/invalid names):** all restart/action names used by `restartAuto` exist in `ANIMATION_CATALOGUE`; `requestAction` refuses unknown clips gracefully (returns false, no throw); cooldowns (max 1.4 s) decay every frame and retries happen every 0.15 s, so rejections self-heal. The non-cooldown failure path is now covered by the restart backstop (above).
- **`transitionUntil` / `possessionStartedAt` after goals/restarts:** `onGoalReset` clears pending kicks and the offside snapshot; the next kickoff establishes a fresh owner and a legitimate transition for the conceding team. `seenOwnerTeam` now survives the free ball, so kickoff transitions are computed against the pre-goal team — desirable.

## Verification
- `tsc --noEmit` clean (9 files changed).
- `support-match` seeds 1234/777/42: all matches reach `FULLTIME` (no restart can hang the match), same-seed replay is `deepEqual` (deterministic), every pass targets a same-team receiver inside the aim cone.
- `tactics-test` (incl. corner loft/length/taker-outside-touchline and goal-kick distribution checks): all pass.
- `kickoff-regression` 7/7, `support-regression` 28/28, `attacking-runs` 8/8, `ai-repro`: all pass.

## Files changed
`engine.ts`, `match/host.ts`, `match/restarts.ts`, `match/contacts.ts`, `match/collisions.ts`, `match/passPlanning.ts`, `match/possession.ts`, `match/offside.ts`, `match/roster.ts` (+102 −29 lines).