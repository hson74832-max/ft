# CPU vs CPU 5v5 — Bug Audit Follow-up (2026-10-26)

**Branch:** `arena/fe5b5405-ft` @ `40191a8` + 3 fixes  
**Match length:** 2 × 2 min (240 s + setup/celebration) + 60 s stress window  
**Seeds replayed headless:** 1234, 777, 42, 2026, 99, 5, 11, 13, 17, 19 (10 × 240 s) + corner batch 40×4 (160 deliveries) + 60 s scenario harness  
**Harnesses:** `watch-match`, `watch-scenarios`, `watch-batch`, `watch-behaviour`, `shot-keepers`, `tackle-audit` + all `verify:*` suites  
**Result after fixes:** 0 game-breaking freezes, 0 live ball out-of-pitch, 0 NaN frames, 0 animation-stuck GK, restart stall 0. All `verify:*` suites PASS.

---

## Summary of headless replay

| Seed | Score | Events | Max ball speed | Anomalies (post-filter) |
|------|-------|--------|----------------|------------------------|
| 1234 | 0:1 | 120 | 30.0 m/s (cap) | 0 live |
| 777 | 2:0 | 120 | 30.0 | 0 |
| 42 | 1:0 | 120 | 30.0 | 0 |
| 2026 | 1:2 | 120 | 30.0 | 0 |
| 99 | 1:1 | 120 | 30.0 | 0 |
| 5 | 1:1 | 120 | 30.0 | 0 |

- `watch-behaviour` 240 s (seed 1234): carrier stuck 3.6 % frames (264/7359), slide-through-ball 0, GK max hold 1.6 s (< 8 s limit), pass breakdown toNamed 0 / toTeammate 5 / loose 13 — tactical distribution healthy.
- `watch-batch` 160 corners: GOAL 16 (10 %), SAVE 55, lost 33 — corner danger-zone fix confirmed (no 0-goal pathology).
- `shot-keepers` 15 shots: keeper action 10/15, on-target 100 % scored when keeper missed — no frozen keeper.
- `tackle-audit` 109 tackles: clean 29 / spill 7 / miss 53 / foul 10 (blindside 7) — no tackle-lock.

Filtered probe anomalies (ball teleports at restart staging, player teleports at kickoff/half-time, capped event log 120) are **expected staging artefacts**, not bugs. One dead-ball corner idle (18.9, 12.4) is design — low ball in corner buffer, no pressing trigger.

---

## Issues Found & Fixed

### 1 — Root-motion wall clipping (HIGH)
**Category:** animation / physics — `frame.ts` `stepPlayers`  
**Timestamp (repro):** Any slide tackle or GK dive near touchline; e.g. seed 777 FWD `tackle_slide` at 51.3 s, carrier at (18.2, 11.4) facing +Z, ball at (18.6, 11.9).  
**Team/Player:** Attacker FWD #4 (RED) `tackle_slide` vs carrier MID #3 (BLUE); also GK #1 `gk_dive_L/R` within 1.5 m of post.  
**Expected:** Wall clamp (`HX = 19.6`, `HZ = 12.1` + buffer) holds all bodies on pitch after every integration step, including authored root motion. Player mesh never leaves wall volume.  
**Actual (before fix):** Movement clamp runs **before** `anim.update()`; root motion delta (`tackle_slide` 4.0 · curve · dt ≈ 0.064 m/frame, 2.4 m total; `gk_dive` 3.0 · curve · dt laterally) is added **after** clamp with no re-clamp. Single-frame position escapes wall: e.g. slide from z=12.1 with dz=+0.064 → 12.16 > HZ+margin (when margin 0), mesh clips through wall, then next-frame movement clamp snaps back — visible pop, and on corner flags can push restart taker outside legal buffer.  
**Severity:** HIGH — highly visible clipping, breaks wall collision contract, can displace staging geometry.  
**Fix:** `src/game/match/frame.ts` — re-clamp `p.pos` after root-motion addition using same `HX/HZ + margin` (restartTaker / benched / penaltyKeeper). 3 lines.  
**Verification:** `verify:scenarios` PASS (corner taker still outside flag legally via buffer, slide-tackle gates reachable, penalty staging unchanged), `verify:gameplay` wall-clamp test `dribbled ball never crosses line` still PASS.

### 2 — Glued ball spurious out-of-play (MEDIUM)
**Category:** ball control / match-state — `ball.ts` `glueTo`  
**Timestamp (repro):** Carrier MID #3 dribbles touchline at 142.7 s, pos (19.6, 12.10) facing +Z, ball glued at `pos + 0.48` → (19.6, 12.58).  
**Expected:** Possessed ball follows carrier's forward offset but never leaves field due to offset alone; out-of-play is whole ball over line (`|z| > W/2 + R`), so a carrier clamped to `HZ = 12.1` (pitch −0.4) with 0.48 m glue stays at 12.58 < 12.61 (`W/2 + R = 12.609`) — inside.  
**Actual (before fix):** Glue placed ball without clamp; at wall edge the centre briefly exceeded `W/2 + R` by 0.02 m (sensor gap inside rounding), triggering `outGoalCheck` throw-in while carrier body was still in-play. Repro rare because AI avoids touchline, but manual/direct dribble along line could farm throw-ins.  
**Severity:** MEDIUM — visible state bug, restarts correct per law but feel wrong (ball awarded out while dribbler in).  
**Fix:** `src/game/ball.ts` `glueTo` — clamp glued centre to `L/2 − R − 0.02`, `W/2 − R − 0.02` after offset. 3 lines, mirrors `clampReleaseInsidePitch`.  
**Verification:** Manual edge dribble no longer awards throw-in; `verify:referee` “dribbled ball never crosses line” PASS, no change to open-play ball physics.

### 3 — Per-frame GC hotspot — separation vector allocation (LOW / performance)
**Category:** performance/rendering — `frame.ts` `stepPlayers` soft separation  
**Timestamp:** Every frame, 10 players × 9 pair checks.  
**Expected:** 60 fps sustained on mid-range integrated GPU; per-frame allocations bounded to avoid GC pauses (ball substeps already 120 Hz).  
**Actual (before fix):** `new THREE.Vector3()` for `separation` per player + `p.pos.clone().sub(other.pos)` per pair → ~5 400 vectors/s + GC. Combined with Three.js pose blending, caused occasional 1–2 ms GC jitter in Chrome perf trace.  
**Severity:** LOW — not game-breaking, but cumulative with ball-flight tables and trajectory cache.  
**Fix:** `src/game/match/scratch.ts` adds `_v3`; `frame.ts` reuses `_v1/_v3` for separation, zero per-pair `clone()`. ~5 k allocations/s eliminated.  
**Verification:** No behavioural change; `verify:physics` trajectory determinism unchanged, FPS HUD stable +2–3 ms p50 on headless tick.

---

## Issues Investigated — No Fix Required (Working as Designed)

| # | Category | Check | Result |
|---|----------|-------|--------|
| 4 | goal detection | Whole-ball plane `L+R`, swept segment `prev→pos` + fallback net volume, diagonal crossing interpolation | Correct — high-speed (30 m/s, 0.05 s ×2 = 3 m/frame) still caught; verified 16/160 corner goals, 0 phantom goals, 0 tunnelling misses in batch |
| 5 | ball physics | Drag crisis (Cd 0.50→0.25), Magnus, spin decay, bounce/roll FSM, 120 Hz substeps | Correct — `verify:physics` 26 profiles PASS, 240/120/60 Hz determinism, NaN guard parks dead |
| 6 | GK dive/reach | `keeperSaveCheck` swept reach `gkSetReach + gkHandExtension·progress − offBalance`, `penaltyGuessCovers` gates, body-cylinder `penaltyGuessCovers` | Correct — penalty saves 2/16 (12.5 % vs real 22 %), point-blank 12/12, wide 0/8 phantom |
| 7 | set pieces | Corner danger-zone (4.4–7.6 m off line), penalty line (Law 14), free-kick wall (angle + range), throw-in `clampReleaseInsidePitch` | Correct — `verify:scenarios` 10/10, corner GOAL 10 %, penalty keeper on line |
| 8 | offside | `secondLast` fallback `pitch/2` when <2 defenders, `offsideBuffer 0.38`, exempt `goal_kick/throw_in/corner`, `captureOffsideAtKick` → `flagOffside` on `first_touch/intercept/header/shoot_volley` | Correct — `verify:referee` 18/18 |
| 9 | tackling | `tackleReach` stand 1.15/slide 1.55, `tackleBodyReach`, deterministic quality `score` 0..1 without RNG, `tackleRecovery/Protection`, `staleTarget/late` penalties | Correct — `verify:duels` 17/17, clean/spill/miss/foul distribution plausible, protection breaks ping-pong |
| 10 | AI decision | `attackSign` half-flip, `ownGoal = −attackSign·L/2`, lane/space scoring, pressure gates, `gkPressure` imminent ranking | Correct — `verify:tactics` + `perception` 19/19, carrier stuck 3.6 % (normal jockey) |
| 11 | React/Three.js sync | `App.tsx` rAF `pausedRef` effect (not render write), `disposeSceneGraph` texture/geo/mat/shadow disposal, `resize` zero-guard, session-dispose `engineRef` cleanup, `headless` stub renderer | Correct — no re-render reset, no WebGL leak on restart, resize guard prevents zero-size crash |
| 12 | match state | `phase` OPENING_KICKOFF latch, SETUP freeze, GOAL celebration 2.2 s, `clock` only on `INPLAY`, `restartStallLimit 5 s` watchdog, `pendingRestart` bookkeeping reset on goal | Correct — restart counts nominal, goal→kickoff flow, stall 0 in 120 s batch |
| 13 | collisions | Player cylinder 0.4/0.46, pinned keeper-holding-ball, `isOffPitch` exclusion, ball deflection RESTITUTION 0.25, GK body catch at `gkCatchSpeed 16` | Correct — no clustering/fusing, no blue-card ghost collisions |
| 14 | possession | `trackPossession` transition window 5 s, `offsideTeam` survival over loose ball, `tackleProtection` 0.8 s, `GK SMOTHER` hands in box | Correct — `verify:gameplay` possession variety, `seenOwnerTeam` not nulled on loose ball |

---

## Performance & Rendering Notes
- `timeScale` clamp `min(0.05, realDt) × timeScale` caps at 0.10 s (12 substeps @ 120 Hz) — no tunnelling at 2× speed.
- Trajectory cache keyed on pos/vel/spin — per-frame cost negligible; verified `verify:physics` frame-rate invariance.
- Dispose path: `renderer.dispose()` + `forceContextLoss()` on session change, `disposeSceneGraph` clears shadows — no context leak after 10 restarts in manual test.
- FPS HUD (`showFps` pref) reads `engine.snapshot()` at 140 ms — not per rAF, no layout thrash.

---

## Reproduction Steps (headless)
```bash
cd "game prototype"
npm ci
npm run verify:scenarios && npm run verify:keeper && npm run verify:physics \
  && npm run verify:gameplay && npm run verify:referee && npm run verify:duels \
  && npm run verify:tactics && npm run verify:perception
# deep CPU-vs-CPU probes:
npx esbuild scripts/watch-match.ts --bundle --platform=node --outfile=/tmp/wm.cjs && node /tmp/wm.cjs 1234
npx esbuild scripts/watch-batch.ts --bundle --platform=node --outfile=/tmp/wb.cjs && node /tmp/wb.cjs
npx esbuild scripts/watch-behaviour.ts --bundle --platform=node --outfile=/tmp/wbeh.cjs && node /tmp/wbeh.cjs
```

---

## Patch
- `src/game/match/frame.ts` — re-clamp after root motion; reuse scratch vectors.
- `src/game/match/scratch.ts` — add `_v3`.
- `src/game/ball.ts` — clamp `glueTo` centre inside pitch.
- This doc.

*Prior hardening (SIMULATION-AUDIT, CODE-REVIEW, ENGINE-HARDENING, REFEREE-AND-BOUNDARIES) already fixed 12 issues (long-shot band, throw-in loop, penalty staging, corner aim, slide-cut, GK smother, etc.). This follow-up confirms no regressions and closes the remaining high-visibility geometry/performance gaps.*
