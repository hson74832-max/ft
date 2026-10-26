# Physics model, action profiles, and the spectator-kickoff freeze

Date: 2026-10-26 · game code under `game prototype/` · branch `arena/7f6b0b06-ft`

Two changes ship together:

1. the **"Watch CPU vs CPU" kickoff freeze** — players never entered the pitch and the
   ball sat on the centre spot until Reset was pressed;
2. the **football physics + action-profile upgrade** — the parameter tables replace the
   generic kick, and the ball is simulated by a state machine driven by the same numbers.

Everything below is backed by a regression that fails when the change is reverted:
`scripts/kickoff-regression.ts` (negative first frame, stall watchdog) and
`scripts/physics-regression.ts` (the whole model). All suites are green — see §5.

---

## 1. The kickoff freeze

### Symptom
Menu → **Watch CPU vs CPU**. The match never starts: all ten players stand in their
staging spots, the ball rests on the centre spot, and only the in-match **Reset** button
(next to Switch / Data) makes play begin. Headless full-match sweeps (seeds 1–80 and 120
random seeds) never reproduced it, which made it look like a rendering bug.

### Root cause — a negative first frame
`App.tsx` armed its animation loop with a `performance.now()` sample and then used the
`requestAnimationFrame` timestamp as "now":

```ts
const last = performance.now();
const loop = (now: number) => { const dt = Math.min(0.1, (now - last) / 1000); eng.step(dt); … };
requestAnimationFrame(loop);
```

A rAF callback receives the **frame start time**, which can be a few milliseconds
*earlier* than the `performance.now()` sampled while arming the loop. The first delta was
therefore negative (about −4 ms, browser- and load-dependent — the same build could
start normally on another run).

```text
step(-0.004)
  → this.clock += dt                       clock = -0.004
  → isOffPitch(e, p): p.blueCardUntil > e.clock
  → blueCardUntil = 0 is the "no card" sentinel, and 0 > -0.004
  → every player counts as blue-carded                  (10 / 10)
  → buildWorldSnap drops them all; they are parked off the pitch
  → resetPositions("kickoff") finds no eligible taker   kicker = null
  → ball released with possessedBy = null and no restartTaker
  → restartAuto's recovery path requires an owner, so nothing retries
  → dead ball at the centre spot, idle bodies, forever
```

A manual Reset re-stages from a now-positive clock, which is why it "fixed" the match.

Reproduced deterministically with a single negative step followed by normal frames
(`offPitch=10`, `taker=-1`, `owner=null`, phase stuck in `SETUP`).

### Fixes (defence in depth)
| Layer | Change | File |
| --- | --- | --- |
| Input | `dt` clamped to `[0, 0.1]`; non-finite → 0. `timeScale` clamped ≥ 0. FPS counters use the clamped delta | `src/App.tsx`, `src/game/engine.ts` |
| Model | Blue-card sentinel tested explicitly: `blueCardUntil > 0 && blueCardUntil > clock` | `src/game/match/referee.ts` (`isOffPitch`, `blueCardRemaining`) |
| Snapshot | `decisions[]` / `cards[]` use `blueCardRemaining()` instead of an inline comparison | `src/game/match/snapshot.ts` |
| Staging | kickoff taker falls back `eligible → same-team squad → whole roster`, and the staging list has outfield/usable fallbacks, so a taker always exists | `src/game/match/restarts.ts` (`resetPositions`) |
| Recovery | if a pending restart has no taker at all, the nearest eligible player of the restarting side is promoted (deterministic tie-break), given the ball, and the restart launches | `src/game/match/restarts.ts` (`restartAuto`) |
| Watchdog | a pending restart that still cannot be staged for `CONFIG.match.restartStallLimit` (5 s) is released at the restart spot instead of freezing every player in the restart hold | `src/game/match/restarts.ts` |

The last three also cover any future staging failure (custom roster, a taker stuck in an
unliftable clip, a restart id that never resolves) — the failure mode was "one missing
taker freezes the whole match", which is a design fault as much as an arithmetic one.

**Regression:** `verify:kickoff` now steps a spectator engine with `step(-0.004)` and
asserts the clock never goes backwards, that no player is off the pitch, and that the
kickoff still launches. Reverting the clock clamp makes the first check fail.

---

## 2. Parameter dataset

`src/game/physics/parameters.ts` holds every physical quantity in SI units with
`[mean, min, max]`, a sampling mode and a provenance tag:

| Mode | Meaning |
| --- | --- |
| `CLAMP` | use the mean inside the declared bounds; the range is a sanity bound, **not** a randomiser (gravity, mass, dead-ball speed, thresholds) |
| `UNIFORM` | sample uniformly in `[min, max]` |
| `TRUNCATED_NORMAL` | normal around the mean (σ = (max−min)/6), truncated to the band |
| `NONE` | plain model constant |

Provenance separates **OFFICIAL / LAW** (ball mass, circumference, pressure, rebound
test — the only rules data) from **CALCULATED / RESEARCH** (area, density, inertia,
terminal velocity, drag crisis, restitution) and **MODEL / ESTIMATE** (spin bands, Magnus
acceleration, knuckle jitter, roll distances). The action profiles in §3 are all
MODEL/ESTIMATE gameplay templates, as specified.

Derived geometry is computed, never hard-coded:

```text
r = C / 2π            = 0.690 / 6.2832 = 0.10982 m
A = πr²               = 0.03790 m²
V = 4/3 πr³           = 0.005548 m³
ρ̄ = m / V             = 0.430 / 0.005548 = 77.5 kg/m³
I = 2/3 m r²          = 0.003466 kg·m²   (thin shell)
```

`CONFIG.ball.radius` (0.109 m) stays the contact/render radius — it is the same legal
ball within 1 mm — while the aerodynamics use the derived radius.

## 3. Ball model (`src/game/ball.ts`)

### Forces, per physics substep
```text
v ← v − g·h                                   g = 9.81 (CLAMP)
F_drag = ½ ρ Cd(|v|) A |v| v / m              Cd from the drag-crisis curve
v ← v + (ω × v)/|ω × v| · ½ρA·Cl·|v|²/m · h    Magnus
ω ← ω · e^(−λh),  λ = −ln(0.88) = 0.1278 /s    measured 12 % loss after 1 s
S   = clamp(|ω|·r / max(|v|, dead), 0, 0.8)
Cl  = clamp(1.2·S, 0, 0.32)                    hard cap
```

`dragCoefficientAt()` is the drag crisis: `Cd = 0.45` below 10 m/s, `0.35` at the
crisis midpoint, `0.25` above 20 m/s, smooth-stepped in between (values and band edges
live in the parameter table). `Cl` is recomputed every substep from the live spin and
speed, so a ball that slows down gains lift, and a ball that has spun down loses it.

The spin decay constant is anchored on the measured pair (12 % after 1 s, which puts
22.6 % after 2 s — inside the 10–45 % band of the second anchor). A pure 3 s time
constant would give 28 % after 1 s and contradicts the measured value, so the measured
anchor wins; the table documents this.

### State machine
`Flight → Bounce → Roll → Dead`, with the documented activation thresholds:

| Transition | Trigger |
| --- | --- |
| anything → Dead | speed < 0.3 m/s while grounded; velocity **and** spin zeroed |
| Bounce | ground contact with `v_y < −0.8 m/s` |
| Bounce → Flight | rebound speed > 1.0 m/s **and** `v_y > 0.8` |
| Bounce → Roll | rebound below that, speed > 1.0 m/s |
| Roll → Flight | ball leaves the surface above 1.5 m/s |
| Roll → Dead | speed < 0.3 m/s |

Every division is guarded (`|v| ≥ dead`, `|ω × v| > 1e−6`), and a non-finite state is
parked dead instead of propagating NaN. A ball below the dead-ball speed loses its spin.

### Surfaces
`SURFACES` maps `dry | wet | artificial | divot` onto a restitution / tangential
friction / rolling-resistance triple. The surface is `CONFIG.ball.surface`, changeable
live in **Settings → Pitch surface**, and carried on the ball so saves/predictions use
the same coefficient set.

* restitution: artificial 0.72 > dry 0.65 > divot 0.55 > wet 0.50
* friction: artificial 0.45 > dry 0.35 > wet 0.20
* rolling resistance: wet 0.14 > dry 0.10 > artificial 0.07

The pitch is not treated as uniform: each bounce draws a small deterministic variation
(hash of position and bounce count — **not** from the match RNG), and low-spin balls get
the knuckle bounce error.

### Spin ↔ bounce coupling
The bounce resolves the contact-point slip `u = v_h + ω × (−r ŷ)` and applies a
Coulomb-limited friction impulse against it, then the per-spin-type corrections:

* **topspin** — forward gain after the bounce (clamped to the measured 0–15 %), flatter
  rebound;
* **backspin** — checks the ball; above the reversal threshold a slow ball stops or rolls
  backwards; slightly higher rebound;
* **sidespin** — lateral kick (≤ 1.5 m/s), reduced on wet grass;
* **knuckle** (spin below 60 rpm) — deterministic lateral/vertical bounce error.

A bounce can never add energy (velocity magnitude is capped at the pre-impact speed and
the ball is clamped to `CONFIG.ball.maxSpeed`).

### Rolling
Rolling resistance `μ_roll·g` per surface, plus spin → roll coupling: backspin adds
deceleration (up to the measured 45 % loss), topspin reduces it, sidespin steers, and
the spin relaxes towards the no-slip rolling condition `ω = (ŷ × v)/r` with the
documented 2 s time constant.

### Frame-rate independence
`stepBallPhysics(s, dt)` substeps onto the 120 Hz physics tick: `ceil(dt / (1/120))`
chunks, each `≤ 8.33 ms`. 120 Hz, 60 Hz and 30 Hz frame deltas produce **identical**
positions (they land on the same substep grid); a 240 Hz caller integrates the same ODE
more finely and stays within 0.3 m over a 1.5 s flight. `dt ≤ 0`, `NaN` and `+∞` are
ignored. A ball state of `{pos, vel, spin}` — everything the existing tests and tools
construct — is still valid: the new fields are optional and default to Flight/dry.

## 4. Action profiles (`src/game/physics/actionProfiles.ts`)

26 named profiles, grouped exactly as specified:

| Family | Profiles (distance m · speed m/s · angle ° · spin rpm) |
| --- | --- |
| Passes | `pass_short` 5–20 · 8–14 · 1–5 · 80–200 (back) · `pass_medium` 15–30 · 12–18 · 2–10 · 150–350 · `pass_driven` 20–40 · 18–25 · 1–5 · 200–400 · `pass_lofted_switch` 30–50 · 15–22 · 20–35 · 250–500 · `pass_weighted_forward` 10–25 · 10–16 · 3–10 · 120–300 · `pass_through` 8–25 · 12–18 · 2–8 · 120–280 |
| Crosses | `cross_whipped` 15–30 · 18–24 · 12–20 · 400–700 (side) · `cross_floated` 20–35 · 12–18 · 25–35 · 150–300 |
| Set pieces | `corner_inswing` / `corner_outswing` 20–35 · 16–22 · 22–32 · 450–700 · `freekick_curled` 18–30 · 18–26 · 18–28 · 500–800 · `freekick_knuckle` 20–35 · 20–28 · 8–15 · 0–60 |
| Shots | `shot_low_driven` 10–30 · 22–32 · 2–8 · 100–250 · `shot_dipping_topspin` 18–35 · 22–30 · 8–15 · 500–800 · `shot_chip` 8–25 · 12–18 · 25–40 · 400–700 · `shot_volley` 10–25 · 20–30 · 8–20 · 200–400 · `shot_half_volley` 10–25 · 18–28 · 3–10 · 200–400 · `header_attacking` 5–15 · 10–18 · −5–15 · 0–150 |
| Goalkeeper | `gk_punt` 30–55 · 18–25 · 25–40 · 100–250 · `gk_drop_kick` 35–60 · 20–28 · 15–30 · 150–300 · `gk_throw` 10–30 · 12–20 · 5–15 · 100–250 · `gk_roll` 5–25 · 6–10 · 0–2 · 0–50 · `gk_parry` 1–12 · 5–12 · 5–20 · 0–80 |
| Restarts / loose | `throw_in` 8–25 · 12–18 · 10–20 · 50–150 · `clearance` 25–50 · 20–28 · 10–20 · 100–250 · `touch_spill` 1–8 · 2–4 · 0–3 · 0–60 |

### Resolving a strike
`resolveStrike(profile, ctx)` samples the launch angle (truncated normal inside the
band, snapped to a 0.02 loft grid so the range tables stay bounded and never leave the
band), samples the spin magnitude uniformly inside the band and picks the axis from the
spin type (`top = ŷ × f`, `back = f × ŷ`, `side = ±ŷ`, `mixed`, `knuckle`), then:

* **weighted deliveries** (passes, crosses, set pieces, keeper distributions) solve the
  speed against the real drag/Magnus/bounce model so the ball lands on the target, with
  a sampled intent that may overhit but never underhit it;
* **direct strikes** (shots, clearances, parries) sample straight from the profile's
  speed band, because they are hit at a direction, not at a target.

A technique rating (passing / shooting / heading / kicking attribute) scatters the speed,
never the aim. The whole strike — including knuckle turbulence frequencies, sampled from
the seeded stream — is baked into the `StrikeCommand`, so the ball's later motion is
identical no matter how the frame budget slices it.

### Decision layer
`chooseProfile(request, ctx)` picks by **what is in the way**, not by action name:

* a blocked short pass becomes a weighted forward ball; an open one stays short/medium;
* a through ball is threaded on the ground if the gap is real, lofted over the line if it
  is not;
* a cross with a defender inside the first 8 m or a blocked lane is **whipped** around
  him; an open lane to a tall target is **floated**;
* corners swing in from the taker's side and out from the other;
* a long, blocked free kick can become a **knuckleball**;
* a shot from range with a clean lane is the **dipping topspin** ball, a 1v1 can be a
  **chip**, a volley/half-volley keeps its own profile;
* a pressed keeper **throws**, a free one **punts** or **drop-kicks**.

`planNamedPass` carries the chosen profile and the resolved strike in the `PassPlan`;
`onContact` executes exactly that strike. Every gameplay kick in `src/game/` goes through
a profile — `grep "\.kick(" src/` returns nothing — including the keeper's forced
clearance under the hold limit, the tackle spill and the parry.

## 5. Prediction (AI reads the same physics)

The AI no longer projects the ball with a constant-Cd parabola. `projectBall` steps a
copy of the live ball with `predictTrajectory()` (120 Hz, drag crisis, Magnus, spin
decay, bounces, surface) and interpolates the sample, so interception points, “where will
the ball be” and pass planning all agree with what the ball actually does. The projection
is cached per ball state, so the per-frame cost is one short simulation.

## 6. Verification

| Suite | Result |
| --- | --- |
| `npm run verify:physics` (new) | 26 profiles · all physics checks passed |
| `npm run verify:motion` | MOTION PIPELINE OK |
| `npm run verify:gameplay` | ALL PASS (includes the keeper back-pass stays on the grass, the arrival-time match and the bounded predictor) |
| `npm run verify:perception` | 19 / 19 |
| `npm run verify:referee` | 18 / 18 |
| `npm run verify:duels` | 17 / 17 |
| `tsc --noEmit` | clean |
| `npm run build` | 1 994 modules, single-file bundle |
| `selftest.ts` | ALL CHECKS PASSED |
| `kickoff-regression.ts` | 12 / 12 (3 spectator-kickoff checks + 2 stall-watchdog checks) |
| `support-regression.ts` | 28 / 28 |
| `tactics-test.ts` | ALL TACTICS CHECKS PASSED |
| `attacking-runs.ts` | 8 / 8 |
| `receiver-awareness.ts` | 8 / 8 |
| `support-match.ts` | 3 full matches, deterministic replay |

`scripts/physics-regression.ts` pins: derived geometry, the drag crisis, the capped
Magnus lift (`Cl = 0.32` at any spin), the 12 %/1 s spin decay, the state machine, the
dead-ball rule, surface bounce and roll ordering, topspin/backspin/sidespin bounce
coupling, rolling deceleration = μ·g, 60/30 Hz vs 120 Hz equivalence, seeded strike
determinism, NaN guards, every profile band, weighted deliveries reaching their target,
and the obstacle-aware profile choices.

## 7. Performance

A simulated match second costs ≈ 28 ms of CPU headless (≈ 16 ms before the profile
layer); a 60 fps frame simulates 16.7 ms of match, i.e. ≈ 0.5 ms per frame — well inside
the frame budget. The expensive parts are cached or bounded:

* range tables are cached per `(loft, power ceiling, height bucket, spin, surface)`, with
  the player-specific power ceiling quantised to 0.5 m/s;
* candidate pass plans resolve the strike with `predict: false` (no full trajectory);
* the AI projection is cached per ball state;
* the physics tick is capped at 8 substeps.

## 8. Files

| Area | File |
| --- | --- |
| Parameter dataset | `src/game/physics/parameters.ts` (new) |
| Action profiles | `src/game/physics/actionProfiles.ts` (new) |
| Ball model | `src/game/ball.ts` (rewritten) |
| Pass planning | `src/game/match/passPlanning.ts` |
| Contacts / all strikes | `src/game/match/contacts.ts` |
| Keeper distribution | `src/game/match/keeper.ts` |
| AI prediction | `src/game/ai.ts`, `src/game/match/frame.ts` |
| Kickoff freeze | `src/App.tsx`, `src/game/engine.ts`, `src/game/match/referee.ts`, `src/game/match/snapshot.ts`, `src/game/match/restarts.ts`, `src/game/match/host.ts`, `src/game/config.ts` |
| Settings UI | `src/ui/Modals.tsx` (pitch surface) |
| Tests | `scripts/physics-regression.ts` (new), `scripts/kickoff-regression.ts`, `scripts/selftest.ts`, `scripts/tactics-test.ts`, `package.json` (`verify:physics`) |
