# Engine audit and gameplay hardening — 2026-10-25

Scope: `game prototype/src/game/**`, `game prototype/src/ui/**`, headless scripts.
This pass combined a call-site audit with gameplay fixes and targeted regressions.
Verification commands are at the end.

## Confirmed defects fixed

| Area | Defect | Fix |
| --- | --- | --- |
| Tackles | Contact resolved as `ballDist < reach && facingDot >= -0.3` and immediately called `ball.possess()`. Success was binary and the facing vector used `(sin(facing), cos(facing))`, i.e. the player's right vector, not forward. | New `match/tackles.ts` computes a bounded quality score from forward angle, carrier front/blind side, ball/body reach, wind-up timing, stale target, protection, approach gain, speed, stamina and pressing. Outcomes are `clean`, `spill`, `miss`, `foul`. Correct forward is `(cos(facing), -sin(facing))`. |
| Tackle ping-pong | Per-clip cooldown was set at the contact frame; a missed/cancelled attempt paid nothing, and a newly won ball could be challenged immediately. | Recovery starts at action start, is refreshed at contact, and blocks another tackle even after the clip ends. A clean winner gets `possessionProtection` seconds; `startAction` rejects challenges against a protected carrier before the wind-up. |
| Standing vs sliding | Both used the same success test with only different reach. | Separate reach/body reach, recovery, cooldown and control penalty. A slide has more reach but a narrower clean window, a longer `get_up` recovery and stronger late-contact foul risk. |
| Bad challenges | Blind-side/late/heavy contact either won the ball or emitted “play on” while leaving the carrier with the ball; no attempt-level punishment. | Bad challenges become misses/fouls, never free possession. They add stumble/recovery and `FOUL`/`TACKLE` events. Enabling `foulsOn` converts severe contact to free kicks/penalties. |
| Goalkeeper positioning | `line.x = clamp(line.x, -19.4, 19.4)` after adding `xStep` meant BOTH keepers were clamped to only 0.6 m off their goal line, despite `gkRushLine = 5.5`. | Pure `keeperPositionTarget()` places the keeper on the ball→goal-centre angle arc, with range-dependent advance, close-threat rush and near-post bias. Correct field sign works in both halves. |
| Goalkeeper shot setup | `keeperTarget` could shuffle to z = ±1.6, outside the posts. | Clamped to `goalWidth/2 - gkNearPostInset`. |
| Offside helper | `AIController.isOffsidePosition` used `-L/2` as the missing second-last defender, making everyone offside with <2 defenders; `match/offside.ts` used `+L/2`. | Both now use `+L/2`. |
| Contact fallback | `footWorld()` returned `(0,0,0)` if a bone was missing, faking contact alignment at the world origin. | Falls back to a foot/head/hand point relative to the player's position and facing. |
| Out-of-play | `ball.lastTouchTeam ?? 0` silently awarded an unknown last touch to RED. | Falls back through `lastTouch` player's team, `lastKnownOwnerTeam`, and only then a safe default. |
| Empty spreads | `evaluateGkDistribution` called `Math.min(...[])` for pressure with no opponents, producing `Infinity`; `bestShort!` assertions hid empty-roster cases. | Guarded `pressure`, capped `space`, and removed non-null assertions with an explicit `if (!chosen) return null`. |
| Fixed roster assumptions | `humanIdx = 4`, kickoff candidates `team*5+3/4`, and AI debug `Float32Array(10*2*3)`. | Human index derives from the formation; kickoff candidates derive from team/role filters; AI line buffer sizes from `players.length` and resizes on demand. |
| Unsafe indexing | Follow camera dereferenced `players[humanIdx]`; snapshot dereferenced `sel.anim` even with an invalid/empty roster. | Camera falls back through selected/first player; snapshot has a neutral `AnimDebug` and `-1/—` fields. |
| Goal celebration | A short imported `celebrate` clip could finish during GOAL phase and start again, drawing extra action seeds; an empty event array had no explicit guard. | Latch the latest `GOAL` event id and celebrate once per goal. |
| Motion imports | Global clip registry could retime an action already in flight if Motion Lab imported a pack mid-match. | `AnimationController` freezes `ClipMeta` and the sampled clip at request time. `snapshot()` reports kickoff/current registry revisions and `motionChanged`. |
| Renderer typing | Headless stub was cast to full `THREE.WebGLRenderer` while providing only five methods. | Explicit `MatchRenderer` interface lists only methods actually used; headless stub implements it honestly. |
| Resize | `0 × 0` canvas could produce a zero/NaN camera aspect. | Uses backing size/safe defaults and `Math.max(1, …)`. |
| Restart retries | `sampleRestartTarget` and restart action seeds drew from the shared PRNG; retries shifted every later AI draw. | Each `(restart id, retry, taker)` gets a local deterministic stream. |
| Action seeds | `startAction` drew `rng.nextUint()`; AI `store()` drew another seed for every decision with an action, including decisions later rejected/cancelled. | Deterministic hash of match seed, player, frame, action and prior seed; AI no longer draws action seeds. |
| PRNG coupling | One PRNG was shared by Rules, AI, restarts, possession and animation cosmetics. | Independent streams for match, coin toss, AI styles, per-player AI decisions, restart attempts, and frame-derived animation/dribble rolls. |
| AI debug | Fixed 10-player buffer and no resize. | Dynamic buffer and `setDrawRange`. |
| HUD toggle | `showAnimOverlay` was toggled by `H` but never consumed. | Exposed in snapshot and wired to the Data drawer and Settings panel. |

## Dead / dormant state audit

Removed as genuinely dead:

- `onEvent`, `crowdStub`, `gkHoldT`, `RulesEngine.log`, `RulesEngine.foulsEnabled`.
- Per-player `celebrateT`, `lastActionSeed`, `pendingKick.actionSeed`.
- `AIDecision.actionSeed`, `SnapshotDTO`, and the unused `addCrowdStub()` function.

Verified live, retained:

- `RulesEngine.celebrateT` — drives the GOAL → SETUP transition.
- `selectedIdx` — HUD selection and Motion Lab's `playClipOnSelected`.
- `lastPass` — AI return-pass utility.
- `frameWorld` — named-pass assignment lookup; cleared on restart.
- `actionLog`, `passLog`, `contactTotal`, `contactAligned` — Data drawer/HUD telemetry.
- `importMotionPack`, `importMotionJSON`, `playClipOnSelected` — Motion Lab and `motion-pipeline`.
- `possessionTicks` — already removed on this branch; no live references remain.
- `showAnimOverlay` — was a no-op toggle; now wired rather than deleted.
- `foulsOn` — intentional gameplay toggle. Default remains OFF so a four-minute
  match is not dominated by setup freezes; bad challenges are still punished and
  severe contact is recorded as a foul. Enabling the toggle produces restarts.

New snapshot-only fields `motionRevision`, `motionChanged`, `showAnimOverlay` and
duel counters are consumed by the HUD/Data drawer, not stored without readers.

## Determinism model

A replay is defined by `(matchSeed, motion pack content + import order, fixed dt,
the same inputs)`. The following are now pure/no-PRNG: debug traces, camera mode,
HUD snapshots, `showAIDebug`, `showAnimOverlay`, animation locomotion phases,
action-id generation, `footWorld`, tackle resolution, `evaluateGkDistribution`,
and cancelled passes. Per-player AI decision streams mean skipping one player's
`think()` in human/spectator mode cannot shift another player's noise.

Human/spectator mode still changes which body controls a player, and therefore
changes the match itself; that is a gameplay input, not a presentation flag.
A mid-match motion import changes gameplay clip duration/contact frames for
future actions and is flagged by `snapshot().motionChanged`. In-flight actions
are frozen. Variable browser frame timing remains outside fixed-seed replay.

## Intentional / remaining risks

- `foulsOn = true` can add many setup freezes to a short prototype match; OFF is
  deliberate. Severe challenges still produce `FOUL`, recovery and stumble.
- Full arbitrary roster sizes are not a product requirement: formations,
  tactics and some scripts still assume two five-player sides. The crash-prone
  fixed indices in kickoff staging, human selection and AI debug are fixed.
- Three.js disposal walks scene geometries/materials/textures/shadow maps. There
  are no custom `ShaderMaterial` uniform textures to dispose in this prototype.
- The `tool/` project has its own committed `node_modules` from Windows; not
  touched by this pass.
- AI decision order still matters within each per-player stream. Changing which
  decisions a player evaluates changes that player's later noise; other players'
  streams are unaffected.
- `window.close()` in the menu and `document`/`window` use in render/input code
  are browser-only by design; headless scripts use `scripts/harness.ts`.

## Verification

From `game prototype/`:

```bash
npm ci
npx tsc --noEmit
npm run build
npm run verify:duels
npm run verify:motion
# existing headless suites: selftest, kickoff-regression, tactics-test,
# support-regression, attacking-runs, support-match, ai-repro
```

Final checks on this branch:

- `tsc --noEmit`, `vite build`, motion pipeline and all 12 duel/determinism
  regressions pass.
- Existing suites pass: selftest, kickoff-regression, tactics-test,
  support-regression (28/28), attacking-runs (8/8), support-match (3 seeds,
  exact replay), ai-repro.
- Controlled keeper grid with live angle positioning: **37/75 saves (49%)**
  vs **29/75 (39%)** on the original 0.6 m placement; goals **15 → 11**.
- Seed 1234 full-match repro: possession changes **106 → 80**, tackles won
  **31 → 13**, with 29 non-winning challenges (miss/spill/foul) and no
  immediate counter-tackle protection bypass in the targeted regression.
