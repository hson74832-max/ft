# Code review — structure, duplication, coupling

Scope: `game prototype/` (5v5 match prototype) and `tool/` (motion capture studio +
animation generator), ~13.2k lines of TS/TSX across 44 source files. Review only — no
feature was removed. Three low-risk cleanups were applied during the review (§7); every
suite still passes with identical numbers.

Measurement basis: `wc -l`, per-function brace matching, call-site greps and a numeric-literal
count over comment-stripped sources. LOC counts are physical lines including blanks and
comments.

> **Update — engine decomposition done.** §1.1 has been carried out: `engine.ts` is now
> 290 lines of state + public API, and its concerns live in `src/game/match/`
> (`world`, `roster`, `input`, `camera`, `frame`, `control`, `actions`, `passPlanning`,
> `offside`, `restarts`, `contacts`, `possession`, `collisions`, `snapshot`, `debug`).
> The move was mechanical — no logic was rewritten — and every suite still produces
> byte-identical output. The duplication items in §3.1 and §3.2 are now single
> implementations inside those modules. Sections below keep the pre-split line numbers
> as the record of what was found.

---

## 0. Scorecard

| Area | Verdict | Worst offender |
| --- | --- | --- |
| Monolith files | ~~**Red**~~ **Green** | `game prototype/src/game/engine.ts` was 2 091 lines / 41 methods / 6 responsibilities → now 290 lines (25 of which are the module map) with 11 public methods and `step` as the frame orchestration, split into `src/game/match/` |
| Huge methods | **Red** | `onContact` 282 lines (10-case switch), `tactics.plan` 278, `step` 256, `actionPose` 210 (31 cases), `ai.think` 200 |
| Duplication | **Amber** | offside test ×4, lane openness ×2, "nearest opponent within cap" ×5, quaternion from-to ×2 |
| Magic values | **Amber** | engine 1 120 numeric literals (140 distinct), anims 810 (89), ai 577 (132) |
| Singletons / global state | **Amber** | module-level clip registry + cache in `motion.ts`/`ball.ts`, engine singleton in `processor.ts` |
| Separation of concerns | **Amber** | simulation + rendering + DOM + input + UI DTO all inside `MatchEngine` |
| Coupling | **Amber** | `config.ts` grab-bag imported by everything; UI mutates engine fields directly |
| Dead / obsolete code | **Green** | procedural fallbacks are still reachable — do not delete (§8) |

---

## 1. Monolith files and classes

### 1.1 `game prototype/src/game/engine.ts` — 2 091 lines, one class doing six jobs  ✅ **resolved**

`MatchEngine` currently owns:

| Responsibility | Evidence (file:line) |
| --- | --- |
| WebGL renderer, scene, fog, camera | ctor @135–191, `buildWorld` @233 (58), `pitchTex` @193 (40), `updateCamera` @2009 (33), `resize` @357 |
| DOM/global input | `attachInput` @344 (`window.addEventListener`), `devicePixelRatio` @149 |
| Player/ball physics and collisions | `step` @462 (256), `resolvePlayerCollisions` @750, `resolveBallPlayerCollisions` @783 |
| Match orchestration (rules, restarts, offside) | `placeForRestart` @825 (149), `restartAuto` @1064 (140), `onContact` @1544 (282) |
| Decision plumbing | `aiControl` @1466, `humanControl` @1346, `humanPass` @1423, `humanShoot` @1452 |
| Presentation DTO for the UI | `snapshot` @2054 (45), `buildAIDebug` @319, `flushAITrace` @733 |
| Motion-pack import / registry | `importMotionPack` @364, `importMotionJSON` @380 |

Roughly **250–300 lines are presentation or DOM code sitting inside the simulation**, which
is why every headless script must shim `document`, `window` and `devicePixelRatio` before
importing the module (§7.1 fixed the duplication, not the cause).

**Proposed split (behaviour-preserving, no signature changes for callers):**

```
src/game/engine.ts          MatchEngine: constructor + step() only  (~450 lines)
src/game/sim/playerMotion.ts    per-player integrate-move / facing / stamina / anim update
src/game/sim/contacts.ts        onContact switch split by category (pass, shot, tackle,
                                keeper, restart, control) behind one dispatch table
src/game/render/world.ts        buildWorld + pitchTex + crowd stub + camera rig
src/game/render/aimDebug.ts     buildAIDebug / updateAIDebug / flushAITrace
src/game/restartPlacement.ts    placeForRestart + restartAuto + restartBlockReason
src/game/snapshot.ts            snapshot() DTO builder (+ move the Snapshot type here)
```

`step()` already contains five clear phases (`rules.update` → snapshot → per-player control
→ per-player integrate → collisions/ball). Extracting the per-player block (lines ~530–665)
into `sim/playerMotion.ts` and the contact dispatch into `sim/contacts.ts` removes ~500 lines
without touching any public method.

### 1.2 `game prototype/src/game/tactics.ts` — `plan()` is 278 lines

`TeamTactics.plan` (@159) does candidate generation **and** scoring **and** assignment
**and** run commitment **and** offside clamping **and** caching, with 14 inline comments
marking sub-decisions. Proposed extraction, in the current order:

- `buildCandidates(carrier, anchor, sign, role, phase)` — the `push(...)` lists (@320–375)
- `scoreCandidate(candidate, context)` — the 40-term score expression (@219–250)
- `shouldKeepCommittedRun(memory, player, anchor)` (@255–270)
- `assignJobs(...)` — the `pick`/`choose` helpers (@190–198)
- `plan` then reads as: resolve carrier → read trigger → phase → cache check → assign.

### 1.3 `game prototype/src/game/anims.ts` — `actionPose()` is 210 lines, 31 cases

One `switch` with 31 clip ids, each 5–8 lines of Euler writes, plus `rootMotionDelta`
(8 cases) with another block of per-clip magic numbers. These are **data**, not logic:

```
src/game/poses/index.ts        map: clipId -> (p: pose writer, phase) => void
src/game/poses/kicks.ts        pass_* / shoot_* / corner_kick
src/game/poses/duels.ts        tackle_* / intercept / header
src/game/poses/keeper.ts       gk_*
src/game/poses/restarts.ts     throw_in / celebrate / stumble / get_up / shield
src/game/poses/rootMotion.ts   rootMotionDelta table
```

This also lets each pose live next to the generated clip spec it mirrors
(`tool/src/gameclip.ts`), so the procedural fallback and the authored clip are edited
together instead of drifting (§3.5).

### 1.4 `game prototype/src/game/ai.ts` — `think()` is 200 lines

`AIController.think` (@126) mixes branch selection (restart hold / human / frozen / keeper /
carrier / off-ball), support assignment, shot selection and reason strings. The carrier path
is already extracted (`possessionDecision`); the off-ball path (@345–430) and the keeper path
(@505–594) can follow it. Note `segmentOpenness` (@792) is a one-line wrapper around
`laneSafety` — dead indirection, see §3.2.

### 1.5 `tool/src/App.tsx` — 1 383 lines, 53 `useState`, 10 refs

The studio component owns: file decoding dispatch, tracking run lifecycle, playback clock,
clip trimming, isolation/ROI editing, colour-pick mode, tracking quality settings, skeleton
style, export options, two export handlers, and the whole page layout. Proposed split:

```
src/state/useTracking.ts      tracked frames, status, progress, runTracking, cancel
src/state/usePlayback.ts      playing, time, speed, in/out points, the rAF tick
src/state/useSubject.ts       roi, editingRoi, candidates, followSubject, isolation
src/state/useExport.ts        layout/precision/rotations/gzip/download + game pack
src/App.tsx                   composition + layout only
```

53 `useState` calls in one component means every playhead tick re-renders the whole tree;
hooks scoped to the playback loop (or a reducer per concern) fix both size and perf.

### 1.6 `tool/src/motion.ts` — 711 lines, five unrelated concerns

types/models (`PoseFrame`, `Movement`, `MOVEMENTS`) · demo pose generator (`demoFrame` 71
lines) · landmark → skeleton mapping (`landmarksToFrame` 55) · temporal filtering
(`OneEuro` class, `denoise`, `rollingMedian`, `resampleFrames`, `smoothFrames` 51,
`bridgeHeld`, `finalizeClip` 60, `groundLockFrames`, `jitterScore`) · export serialization
(`exportAnimation` 60, `quaternionFromTo`) · gzip. Suggested: `pose/types.ts`,
`pose/demos.ts`, `pose/landmarks.ts`, `pose/filters.ts`, `pose/align.ts` (finalize/bridge),
`export/fieldmotion.ts`. `gameclip.ts` (676) is large but cohesive — leave it, only move the
quaternion math out (§3.3).

### 1.7 `tool/src/processor.ts` — 742 lines, module-level engine singleton

Also mixes MediaPipe engine lifecycle (queue, `openEngine`, `closeEngine`, `guarded`),
video frame extraction, GIF compositing + cache, ROI/mask preparation, candidate building,
`TrackSession`, `MultiSession`, and three entry points. Suggested: `processor/engine.ts`
(lifecycle), `processor/video.ts`, `processor/gif.ts`, `processor/frames.ts` (prepare/mask/
candidates), `processor/sessions.ts`.

### 1.8 `game prototype/src/game/config.ts` — a grab-bag with five concerns

348 lines exporting `CONFIG`, `REAL_DATA`, `SKELETON_CONTRACT` (+`BoneName`), `ClipCategory`/
`ClipMeta`/`ANIMATION_CATALOGUE` (32 entries), `FORMATIONS`, and `RuleEventType`/`RuleEvent`.
Six modules import it, each for a different reason (`skeleton.ts` and `motion.ts` only want
the skeleton; `anims.ts` only wants the catalogue). Split into `config/tuning.ts`,
`config/skeleton.ts`, `config/clips.ts`, `config/formations.ts`, `rules/events.ts`, with a
`config/index.ts` barrel so existing imports keep working. Also note `ANIMATION_CATALOGUE`
duplicates facts that now live in the generated pack (duration/contact frame/interruptible
window per slot) — the catalogue is the contract, the pack supplies the motion, so keep it,
but state that in one comment instead of two.

---

## 2. Repeated magic values

| Count | File | Notes |
| --- | --- | --- |
| 1 120 literals / 140 distinct | `engine.ts` | 34 of them are `THREE.MathUtils.clamp(...)` bounds |
| 810 / 89 | `anims.ts` | pose amplitudes; acceptable **if** a pose becomes data (§1.3) |
| 577 / 132 | `ai.ts` | utility weights, mixed with `CONFIG.tactics` values |
| 235 / 61 | `tactics.ts` | mostly already overridden by `CONFIG.tactics` |

Concrete offenders worth naming:

- **Player separation** (`engine.ts@562–568`): radius `1.25`, teammate weight `3.2`, opponent
  weight `1.1`, plus `dt * 12` damping for root-motion actions. None are in `CONFIG`.
- **Turn-in-place gate** (`engine.ts@624`): `1.9` rad, `1.2` m/s, `1.6` m/s. This exact
  triple caused the "everyone holds position" bug; it deserves `CONFIG.anim.turnInPlace{Rad,MaxSpeed,MaxDesired}`.
- **Per-clip visual offsets** (`engine.ts@657–658`): `-0.42` for `tackle_slide`, `-0.25` for
  `gk_dive_*` — copied from the old procedural clip definitions and now out of sync with the
  generated clips (`-0.44` / `-0.10`). This is animation data living in the engine; move it to
  clip metadata (`meta.groundOffset`) so one source of truth remains.
- **Contact tolerance** (`engine.ts@1551`): `0.42` / `0.55` / `0.8` m per limb.
- **Restart exclusion radii** (`engine.ts@966`, `1054`, `1173`): `5.9`/`6.3`/`6.2`, `2.2`, `14`.
- **Keeper distribution clamps** (`engine.ts@1001–1002`): `±18.8` / `±11.2` — these are
  `pitch.length/2 − 1.2` and `pitch.width/2 − 1.3` written out.
- **"nearest opponent, capped"** — four different caps for the same concept: `10`
  (`engine.ts@1399,1409`), `14` (`@1191`), `20` (`ai.ts@795`), `30` (`tactics.ts@64`).
  Not necessarily the same intent each time, but the reader cannot tell which cap is which
  decision; name them (`receiverSpaceCap`, `restartGuardCap`, …).
- **Stamina curve** (`engine.ts@600`): `0.72 + 0.28 * stamina`, clamp `0.2..1`.

---

## 3. Duplication and reimplemented logic

### 3.1 Offside test implemented four times

| Site | Shape |
| --- | --- |
| `ai.ts@846` `isOffsidePosition` | `u > ballU + buffer && u > secondLast + buffer` |
| `engine.ts@1231` `receiverOffsideAtKick` | same test, plus its own `secondLast` computation and its own exempt-restart list |
| `engine.ts@1826` `captureOffsideAtKick` | same test again, inlined in a loop; duplicates the exempt list verbatim |
| `ai.ts@857` `clampOnside` + `tactics.ts@110` `onsideLimit` | two different ways to compute the same limit |

The exempt list `throw_in | corner | goal_kick | kickoff` appears **twice** as a literal
chain. Proposed: one `offside.ts` exporting `secondLastDefender(players, sign)`,
`isOffsideAt(u, ballU, secondLast)`, `isRestartExempt(kind)`; `engine.ts` and `ai.ts` call it.

### 3.2 Lane openness implemented twice

`engine.ts@974` `laneOpenness` (accumulates `(1.9 - gap)/1.9` per blocker, `1 - blocked*0.4`)
vs `tactics.ts@93` `laneSafety` (min over blockers of a paced gap normalisation). Two formulas,
two thresholds, both named "lane". `ai.ts@792` `segmentOpenness` exists only to forward to
`laneSafety`. Either keep one implementation or name them by intent
(`laneClearanceInstant` for the keeper's option scoring vs `laneSafetyPredicted`).

### 3.3 Quaternion construction duplicated across projects

`tool/src/motion.ts@581 quaternionFromTo`, `tool/src/gameclip.ts@598 quatFromTo` — same
shortest-arc math, two copies, in the same project. The game uses
`THREE.Quaternion.setFromUnitVectors`. Move one copy into `tool/src/quat.ts` (no three.js
dependency needed for the generator) and have both callers import it.

### 3.4 "Nearest opponent" and distance helpers

`groundDistance` (`tactics.ts@62`) exists, yet `engine.ts` uses `Math.hypot(dx, dz)` at 8
sites and `pos.distanceTo()` (3-D, so it includes the Y difference the 2-D helpers
deliberately drop) at 4 more. Same for `nearestSpace`: `ai.ts@795 nearestOppAt` reimplements
it with a different cap. Consolidate on `groundDistance`/`nearestSpace` in one module
(`spatial.ts`) and let callers pass the cap.

### 3.5 Generated clips vs procedural poses vs engine offsets

Three places now describe "how a slide tackle looks": `tool/src/gameclip.ts` (authored clip),
`anims.ts actionPose` (procedural fallback), `engine.ts@657` (hard-coded crouch offset), and
`tool/src/App.tsx` docs. They already disagree numerically. Minimum fix: derive the engine
offsets from clip metadata (§2) and add the generated clip's ground offset to
`metadata` in `gameclip.ts` so the pack carries it.

### 3.6 Small duplicated utilities

- `const v = (x, y, z)` defined in `tool/src/motion.ts@48` **and** `tool/src/rig.ts@59`.
- `clamp` defined three times in `tool/` (`identity.ts@44`, `motion.ts@47`,
  `processor.ts@152`).
- Median helpers four different ways: `motion.ts median@222`, `percentile@226`,
  `median3@404`, `processor.ts medianOf@453`, plus `rollingMedian@292`.
- `isGifFile` in `tool/src/App.tsx@28` duplicates `isGif` from `processor.ts@153`.
- `D2R = Math.PI / 180` in `anims.ts@77` and `gameclip.ts@17`.
- `game prototype/src/utils/cn.ts` and `tool/src/utils/cn.ts` are identical 6-line files (fine —
  the two apps do not share a package).

---

## 4. Structure, coupling, separation

### 4.1 Module-level singletons and global mutable state

| State | Where | Risk |
| --- | --- | --- |
| `clips`, `slotBindings` | `game/motion.ts@60,62` | global to the process; `MatchEngine.dispose()` does **not** reset them, so a second engine inherits the first engine's bindings; tests must call `clearFieldMotionRegistry()` (all of them now do) |
| `kickRangeTables` | `game/ball.ts@115` | unbounded cache keyed by `toFixed(4)` strings built from floats — a long session accumulates entries; a short-lived engine leaks them |
| `engine`, `queue`, `clock`, `stage`, `modelBytes`, `gifCache` | `tool/src/processor.ts@67–90` | deliberate (one MediaPipe instance at a time) but `clock` never resets, so timestamps depend on how much was tracked earlier in the session |
| `engineRef` | `game prototype/src/App.tsx@11` | the React root is the only singleton holder — acceptable |

Registry-as-singleton is a reasonable choice for a clip registry; the missing piece is
ownership: bind it to the engine (instance field) or give `dispose()` a `clearFieldMotionRegistry()`
hook so "restart match" cannot inherit stale bindings.

### 4.2 Bidirectional engine ↔ AI wiring through closures

`engine.ts@176–190` injects three closures into the AI at construction
(`ai.passValidator`, `ai.passPreview`, `ai.gkDistribution`). The AI module is otherwise pure
over `WorldSnap`, so this is the one thing that makes it untestable without an engine. Proposed:
declare a `MatchServices` interface (`canPass`, `previewPass`, `chooseKeeperDistribution`) in
`ai.ts` and have the engine implement it — same behaviour, one direction of dependency, and
`support-regression.ts` can pass a stub.

### 4.3 `config.ts` as the universal import

14 game modules, of which 11 import `config` and 4 import it only for the skeleton or the
clip catalogue (§1.8). Nothing imports `engine` except the UI and scripts, which is good.

### 4.4 UI reaches into engine internals

`MatchScreen.tsx@44–47,253–257` mutates `engine().cameraMode`, `.spectator`, `.timeScale`,
`.aimRaw`, `.foulsOn`, `.showAIDebug` directly and calls `resetPositions("kickoff")`, while
the same screen already consumes the `snapshot()` DTO. Two channels for one state means the
drawer can disagree with the snapshot for a frame. Proposed: put the few setters on the
engine (`setCameraMode`, `toggleSpectator`, `setTimeScale`, `toggleAimRaw`, …) and read all
display state from `Snapshot`. `Snapshot` is also `ReturnType<MatchEngine["snapshot"]>`
(`engine.ts@2096`), which couples UI types to the class — declare it as a standalone
interface in `snapshot.ts`.

### 4.5 The `WorldSnap` / `WorldPlayer` contract has no home

`tactics.ts@4` imports `WorldPlayer`/`WorldSnap` from `ai.ts`, while `ai.ts@6` imports
functions from `tactics.ts`. It is type-only in one direction, so there is no runtime cycle,
but the shared vocabulary of the sim lives in the AI module. Move `WorldPlayer`, `WorldSnap`,
`PassFlight`, `AIDecision` into `world.ts` (types only); both modules then depend on the contract
instead of each other.

### 4.6 DOM/global access inside the simulation

`engine.ts@102` reads `window.location.search`, `@149` reads `devicePixelRatio`, `@346`
attaches `window` listeners, `@193` does `document.createElement("canvas")`, `@1399`
`new URLSearchParams`. This is why six scripts needed a DOM shim. The clean version: a
`Platform` parameter (`{ createCanvas, devicePixelRatio, isDebugAI }`) defaulting to the browser
globals; headless tests then pass a fake and the shims disappear entirely.

### 4.7 Scripts

`game prototype/scripts/*` are single-purpose and readable (86–284 lines). They now share one
harness (§7.1). `support-match.ts` and `attacking-runs.ts` each re-implement the per-frame
match loop with different instrumentation — worth one `simulate(seed, onFrame)` helper, but low
priority because their metric sets differ.

---

## 5. Suggested phasing

| Phase | Work | Risk | Gate |
| --- | --- | --- | --- |
| 0 | Done this pass: shared script harness, `angles.ts`, merged duplicate import (§7) | None | all suites byte-identical |
| 1 | `offside.ts`, `spatial.ts`, one `lane*` implementation, `tool/src/quat.ts`, small utility dedupe | Low — pure functions | all suites, seed 1234 must stay `1:5 / 69 passes / 21 shots` |
| 2 | `config/` split with barrel re-exports; `world.ts` for the AI vocabulary; `MatchServices` instead of closures | Low — no call-site churn | `tsc` + all suites |
| 3 | `snapshot.ts` + engine setters; UI reads only the DTO | Low | `vite build`, manual match check |
| 4 | Pose tables out of `anims.ts`; engine ground offsets from clip metadata | Medium — visual | `npm run verify:motion` + contact sheet |
| 5 | `sim/` split of `step`/`onContact`, `render/` split of world/pitch/debug, `restartPlacement.ts` | Medium — needs careful moves | all suites + a headless live match (`motion-pipeline.ts`) |
| 6 | `tactics.plan` deconstruction, `ai.think` off-ball/keeper paths | Medium-high — behaviour | `support-regression` 28/28, `attacking-runs` 8/8, per-seed match table must not regress |
| 7 | `tool` side: `App.tsx` hooks, `motion.ts`/`processor.ts` splits | Low-medium — no tests exist for the studio | manual studio run + `node scripts/contact-sheet.mjs` |

Phase 1 alone removes the most duplicated logic per unit of risk. Phase 5 is what actually
makes `engine.ts` reviewable again.

---

## 6. What is not a problem (do not "fix" these)

- **Procedural pose fallbacks in `anims.ts` and `rootMotionDelta`** are reachable whenever the
  generated pack is not bound (fetch failure, offline, `?motion=off`). They are not dead code.
- **Module-level clip registry** in `motion.ts` is a deliberate cross-component service; it only
  needs an owner (§4.1).
- **One engine instance at a time** in `processor.ts` is a documented memory-safety decision.
- **`ai.passValidator`/`passPreview` closures** exist because the pass planner depends on ball
  physics and the pending restart; the direction of the dependency is the issue, not the hooks.
- **`CONFIG` values being "prototype tuning, not measurements"** is already documented at the
  top of the tactics block — keep that caveat.
- **`gameclip.ts` at 676 lines** is data-heavy but single-purpose; splitting it by clip family
  is optional, not urgent.

---

## 7. Cleanups applied during this review

All three are behaviour-preserving; every suite was re-run and the per-seed numbers are
unchanged (`support-match` seed 1234: `1:5`, 69 passes, 33 recycles, 15 penetrating, 21 shots,
77 % actual central cover).

1. **Headless DOM shim de-duplicated.** Six scripts carried their own `Proxy`-canvas +
   `globalThis` stub with three slightly different shapes (two were missing `window`, one used
   `(globalThis as any)`). Now one module: `game prototype/scripts/harness.ts` exporting
   `headlessCanvas`, `headlessEngineCanvas`, `installHeadlessDom` (installed on import).
   `support-match`, `support-regression`, `attacking-runs`, `tactics-test`, `ai-repro` and
   `motion-pipeline` import it. Net −30 lines and one definition instead of six.
2. **Angle convention centralised.** `game prototype/src/game/angles.ts` adds `wrapAngle`,
   `yawOf`, `yawOfVector`, `yawDelta`, `turnTowards`. The engine's three hand-written
   ±π wrap loops and four inline `Math.atan2(-dz, dx)` calls (facing, animation direction,
   ball-relative head yaw) now go through it, as does the clamped turn. No numeric change.
3. **Duplicate `./motion` import merged** in `engine.ts` (two import statements from the same
   module, lines 5 and 12).

---

## 8. Numbers behind this review

```
game prototype/src/game/engine.ts   2091   onContact 282 · step 256 · placeForRestart 149
game prototype/src/game/ai.ts        908   think 200 · readShot 38 · towardGoal 32
game prototype/src/game/anims.ts     549   actionPose 210 (31 cases) · locomotionPose 65
game prototype/src/game/tactics.ts   445   plan 278
game prototype/src/game/motion.ts    360   parser + retarget + registry + sampler
game prototype/src/game/config.ts    348   CONFIG · REAL_DATA · skeleton · clips · formations
tool/src/App.tsx                    1383   53 useState
tool/src/processor.ts                742   6 module-level singletons
tool/src/motion.ts                   711   5 concerns
tool/src/gameclip.ts                 676   cohesive clip specs + FK
```

Numeric literals (comments stripped): `engine 1120 (140 distinct)`, `anims 810 (89)`,
`ai 577 (132)`, `tactics 235 (61)`.
Duplication counts: offside test 4, lane formula 2, nearest-opponent 5, quaternion from-to 2,
`clamp` 3 (tool), median helpers 4, `v()` 2, `isGif` 2, headless shim 6 (now 1).
