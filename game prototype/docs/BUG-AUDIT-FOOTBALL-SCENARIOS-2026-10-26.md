# Bug Audit — CPU vs CPU Football Scenarios (2026-10-26)

Deep code-level analysis of corners, free kicks, penalties, throw-ins, tackles,
slide tackles, passing, dribbling, and goalkeeper behaviour in the 5v5 simulation.

---

## A. Corners

### A-1 ✅ Ball placement at the corner arc — CORRECT
The corner spot is computed correctly in `possession.ts → outGoalCheck`:
```ts
const cx = side * (L - 0.25);
const cz = (goalLineCrossZ >= 0 ? 1 : -1) * (Wd - 0.25);
```
Ball is placed at the corner flag with a 0.25 m inset, matching the expected
corner-arc radius on the scaled 40×25 pitch.

### A-2 ✅ Corner taker approach and kick — CORRECT (with caveat)
Taker is placed outside the touchline behind the ball:
```ts
taker.pos.set(goalX - sign * 0.75, 0, cornerSide * (CONFIG.pitch.width / 2 + 0.55));
```
Ball is pinned at the restart position during setup and animation (see
`stepBall → heldRestart`), so it stays at the corner spot until the contact
frame fires. The `corner_kick` action correctly targets runners.

### A-3 ✅ Attackers move into the box — CORRECT
Runners are staged at near post, penalty spot, far post and edge of box:
```ts
const runnerSpots: [number, number][] = [
  [goalX - sign * 2.6, cornerSide * 1.4],    // near post
  [goalX - sign * 4.2, 0],                    // penalty spot
  [goalX - sign * 2.2, -cornerSide * 2.8],   // far post
  [goalX - sign * 6.4, -cornerSide * 1.6],   // edge of box
];
```

### A-4 ⚠️ Defenders mark the same spots as attackers — MINOR ISSUE
```ts
defenders.forEach((p, i) => {
  const spot = runnerSpots[i % runnerSpots.length];
  const goalSide = new THREE.Vector3(spot[0], 0, spot[1])
    .lerp(new THREE.Vector3(goalX, 0, spot[1]), 0.35);
  p.pos.set(goalSide.x, 0, goalSide.z);
});
```
Defenders are placed at 35% of the way between attacker spots and the goal line.
This creates **man-to-man overlap** — defenders stand ~1–2 m behind attackers at
identical lateral positions. While functional, the 35% lerp means defenders are
very close to attackers and player-vs-player collision resolution will constantly
push them apart, creating jitter in the crowded box before the ball arrives.

**Severity: Low** — works but creates visual jitter.

### A-5 ✅ Goalkeeper positioning for corners — CORRECT
Defending GK is positioned on its angle arc via `keeperPositionTarget`,
appropriate for a cross delivery.

### A-6 ✅ Headers / second balls handled — CORRECT
The `possessionCheck` aerial trigger and the `header` action handle both
first-contact headers and loose balls in the box.

### A-7 ✅ Ball leaves corner area correctly — CORRECT
Ball is pinned at restart position during animation, then struck from the
corner spot.

### A-8 ⚠️ Player collisions in the penalty box — MINOR ISSUE
With 8 outfield players crammed into ~6 m × 6 m and `bodyRadius` summing to
0.8 m per pair, the collision resolver pushes them apart every frame. The
separation force in `stepPlayers` (1.25 m threshold, 3.2× teammate / 1.1×
opponent multiplier) keeps them separated but creates visible jostling.

**Severity: Low** — no stuck states, just visual jitter.

### A-9 ✅ Game returns to normal play after corner — CORRECT
`restartLaunchedId` is set and `pendingRestart` is cleared on ball release.

---

## B. Free Kicks

### B-1 ✅ Foul detection — CORRECT
`evaluateTackle` classifies outcomes as `clean`, `spill`, `miss`, or `foul`
based on deterministic quality scoring.

### B-2 ✅ Ball placement at foul position — CORRECT
```ts
e.ball.pos.set(carrier.pos.x, CONFIG.ball.radius, carrier.pos.z);
```

### B-3 ✅ Defenders forced back — PARTIALLY CORRECT
The wall is placed at `CONFIG.tactics.fkWallDistance` (3.2 m) from the ball.
The restart block reason checks `near(e.ball.pos, 2.0)` for opponents.
Non-wall defenders are placed on a line `fkBlockDrop` deep.

### B-4 ⚠️ Wall distance too short — MINOR
3.2 m maps to ~8.4 m on a real 105 m pitch (real law = 9.15 m / 10 yards).
Slightly short but acceptable for the scaled pitch.

### B-5 ✅ Wall formation — CORRECT
Wall is formed on the ball→near-post line using `wallLine` and `wallSide`
vectors, with 0.85 m lateral spacing between wall members.

### B-6 ✅ Kicker can strike the ball — CORRECT
Free kicks use `shoot_normal` (< 13 m) or `pass_long` / `pass_short` /
`pass_through` for longer distances.

### B-7 ✅ Ball curves — CORRECT
Corner and free-kick deliveries use `corner_inswing` profile with `curveSide`
for spin. Free kicks within 13 m use `shoot_normal` which doesn't curve, but
that's correct for a direct free-kick blast.

### B-8 ⚠️ No short free-kick option — DESIGN LIMITATION
The code always selects `pass_short`, `pass_through`, or `pass_long` based on
distance to the nearest teammate. There is no explicit "roll to a nearby
player" option for very close free kicks. However, `pass_short` is selected
when `chosen.dist <= 14`, which effectively covers short free kicks.

**Severity: Informational**

---

## C. Penalties

### C-1 🔴 **MAJOR BUG: Ball not placed on the penalty spot**
When a penalty is awarded, the ball position is set to the **foul location**:
```ts
// contacts.ts line 343
e.rules.startSetup(inBox ? "penalty" : "free_kick",
  [carrier.pos.x, carrier.pos.z], carrier.team);
```
The penalty is always taken from wherever the foul occurred, NOT from the
penalty spot. On a real pitch, the penalty spot is 11 m from the goal line.
On this 40 m pitch it should be approximately ±(20 − 4.2) = ±15.8.

**Impact:** Penalties are taken from unpredictable positions inside the box.
A foul near the corner of the box produces a much easier "penalty" from 15 m
out, while a foul right in front of goal produces a near-certain goal from 2 m.

**Fix:** When `inBox` is true and the restart is `"penalty"`, compute the
penalty spot position:
```ts
const penaltyX = attackGoal.x - sign * (CONFIG.pitch.length / 2 - 15.8);
// Or define CONFIG.pitch.penaltySpotDistance = 4.2 (scaled 11 m)
const spotX = attackGoal.x - sign * penaltySpotDist;
e.rules.startSetup("penalty", [spotX, 0], carrier.team);
```

### C-2 🔴 **MAJOR BUG: Goalkeeper not constrained to the goal line**
During penalty setup, the defending goalkeeper is positioned using
`keeperPositionTarget`:
```ts
// restarts.ts line 453-455
if (defendingGk) {
  const gkSpot = keeperPositionTarget(ball, ownGoal,
    e.ai.attackSign(defendingGk.team, e.rules.half));
  stage(defendingGk, gkSpot.target, ball);
}
```
`keeperPositionTarget` places the GK 0.72–4.2 m OFF the goal line (controlled
by `gkPositionBase` and `gkPositionMaxAdvance`). In real football, the GK must
remain ON the goal line until the ball is kicked.

**Impact:** The GK starts 1–4 m off its line, narrowing the shooting angle
unfairly and making penalties significantly harder to score.

**Fix:** For penalties, force the GK onto the goal line:
```ts
if (isPenalty && defendingGk) {
  const gkZ = THREE.MathUtils.clamp(ball.z, -goalHalf, goalHalf);
  stage(defendingGk, new THREE.Vector3(ownGoal.x, 0, gkZ), ball);
}
```

### C-3 ✅ Penalty awarded correctly for box fouls — CORRECT
The `inBox` check uses the attacking goal position:
```ts
const attackGoal = e.ai.goalPos(carrier.team, e.rules.half);
const inBox = Math.abs(carrier.pos.x - attackGoal.x) < 5.5
  && Math.abs(carrier.pos.z) < 6.2;
```

### C-4 ✅ Penalty kicker selection — CORRECT
Taker is selected by penalty attribute, then finishing:
```ts
return [...ranked].sort((a, b) =>
  b.attributes.shooting.penalties - a.attributes.shooting.penalties
  || b.attributes.shooting.finishing - a.attributes.shooting.finishing)[0];
```

### C-5 ✅ Only allowed players inside the box — CORRECT
Attackers wait outside the box at `ball.x - sign * 5.2`.
Defenders wait at the box edge at `ownGoal.x + sign * 6.3`.

### C-6 ✅ Shot aim selection — CORRECT
Penalty aim uses weighted lanes across the goal:
```ts
const lanes = [-1.05, -0.5, 0, 0.5, 1.05].map((z) => ({
  value: new THREE.Vector3(goal.x, 0, z),
  weight: 0.25 + Math.abs((keeper?.pos.z ?? 0) - z) * 0.55 + rng.range(0, 0.24),
}));
```

### C-7 ✅ Rebounds handled — CORRECT
After a penalty save (parry or miss), the ball enters normal physics and
`possessionCheck` handles trapping.

---

## D. Throw-ins

### D-1 ⚠️ Throw-in taker placed inside the pitch — MINOR BUG
The taker is positioned at:
```ts
taker.pos.set(pr.pos[0], 0, Math.sign(pr.pos[1]) * (CONFIG.pitch.width / 2 - 0.18));
```
This places the taker at z = ±12.32, which is **0.18 m inside** the touchline
(Wd = 12.5). In real football, the thrower stands at or outside the touchline.

**Impact:** Minimal visual issue; the taker appears slightly on the pitch.
Functionally the throw works correctly.

### D-2 ✅ Throw-in awarded at correct sideline position — CORRECT
Interpolated crossing point:
```ts
const crossX = crossedThisFrame
  ? prev.x + (b.x - prev.x) * clamp((touchPlane - prev.z) / dz, 0, 1)
  : prev.x;
```

### D-3 ✅ Throw animation — CORRECT
`throw_in` clip has `contactFrame: 0.55` and `duration: 0.9`. Ball is pinned
above the thrower's head during the held restart:
```ts
e.ball.pos.set(taker.pos.x + forwardX * 0.12, 1.65, taker.pos.z + forwardZ * 0.12);
```

### D-4 ✅ Ball release — CORRECT
At the contact frame, the ball is released from the thrower's hands:
```ts
e.ball.pos.set(p.pos.x, 1.65, p.pos.z);
e.ball.strike(throwAim, { ...throwStrike, speed: plan.power, loft: plan.loft });
```

### D-5 ✅ Teammates can receive — CORRECT
Throw-in targets are sampled from teammate positions with lateral/depth offsets.

### D-6 ✅ AI recognises throw-in state — CORRECT
Restart hold freezes all players until the throw is launched.

---

## E. Tackling (Standing)

### E-1 ✅ Tackle attempts at reasonable times — CORRECT
AI selects `tackle_stand` at < 1.55 m and `tackle_slide` at < 2.5 m from the
carrier, with risk-gating and blindside checks via `canTackle`.

### E-2 ⚠️ Foul threshold too low — MINOR
`foulScore: 0.18` means heavy-contact challenges with quality between 0.18 and
0.42 (spillScore) result in a "miss" rather than a foul. Many reckless lunges
that clearly hit the player but not the ball will be classified as missed
tackles instead of fouls.

**Impact:** Some reckless challenges go unpunished.

### E-3 ✅ Clean tackles win the ball — CORRECT
`cleanScore: 0.62` with proper protection window (0.8 s).

### E-4 ✅ Players fall and recover — CORRECT
Carrier stumbles on clean tackles: `carrier.stumbleT = 0.75 * resilience_factor`.
Stumble decays in `aiControl`.

### E-5 ⚠️ Excessive collisions possible — MINOR
The `standBodyReach: 1.9` m is large. Combined with `standReach: 1.15` m,
tackles can win the ball from up to 1.15 m away while body contact registers
at 1.9 m. This means a standing tackle can make heavy contact (body collision)
without winning the ball, resulting in a miss with stumble — no foul, no ball
won, both players stumbling.

**Severity: Low** — the recovery timers prevent spam.

### E-6 ✅ No stuck states — CORRECT
`tackleRecoveryT` and `tackleCooldown` prevent re-tackling.

---

## F. Slide Tackles

### F-1 ✅ Slide animation — CORRECT
`tackle_slide` has `duration: 0.95`, `contactFrame: 0.5`, root motion enabled.
Frame.ts applies a vertical offset: `-0.42 * sin(nt * PI)` for the slide.

### F-2 ✅ Slide distance — CORRECT
Root motion drives the slide; 2.5 m of travel is configured in the clip
metadata.

### F-3 ⚠️ `get_up` requested immediately after slide — POTENTIAL TIMING ISSUE
```ts
// contacts.ts line 358
if (action === "tackle_slide" && tackleOutcome !== "clean")
  p.anim.requestAction("get_up", true);
```
This fires at the contact frame (0.5 of the 0.95 s clip = 0.475 s in). The
slide animation still has ~0.475 s left to play. If `requestAction` with
`force=true` overrides the current clip, the slide animation is cut short. If
it queues it, the `get_up` starts immediately after the slide ends.

The `get_up` clip has `duration: 1.0`, combined with `slideRecovery: 1.55`,
the player is effectively grounded for ~2.5 s total. This is a long time for a
missed slide tackle, potentially leaving the team a player short.

**Severity: Medium** — missed slides are very punishing.

### F-4 ✅ Dangerous tackles penalised — CORRECT
`lateContactPenalty: 0.35` and `blindsideCommitted` flag for cards.

### F-5 ✅ Ball physics stable after slide — CORRECT
Spill uses `ACTION_PROFILES.touch_spill` with controlled speed.

### F-6 ✅ Slide recovery — CORRECT
`slideRecovery: 1.55` and `slideCooldown: 1.85` prevent instant re-tackling.

---

## G. Passing

### G-1 ✅ Short passes reach teammates — CORRECT
`pass_short` uses `ACTION_PROFILES.pass_short` with accuracy scaling.

### G-2 ✅ Pass power and direction — CORRECT
`powerForAction` scales by attributes; direction is computed from the
receiver's predicted position with a velocity lead.

### G-3 ✅ Receiver moves to meet the ball — CORRECT
AI decision logic includes interception and first-touch actions based on
predicted ball trajectory.

### G-4 ⚠️ Pass cancellation after strike — MINOR BUG
After `releaseToKick` and `e.ball.strike(...)`, there is a validity check:
```ts
if (!passAimIsValid(launchDot, CONFIG.ai.passAimConeDegrees)) {
  e.ball.vel.set(0, 0, 0); e.ball.possess(p.idx, p.team);
}
```
The ball has already been struck (velocity set) and then is instantly re-grabbed
with zeroed velocity. This can look like the ball "teleports" back to the
passer.

**Impact:** Visual glitch — ball barely moves then snaps back.

**Severity: Low** — rare because aim cone is checked before the strike.

### G-5 ✅ Through balls, lofted passes, driven passes — ALL SUPPORTED
`pass_through`, `pass_long`, `pass_short` are all separate action profiles.

### G-6 ⚠️ Pass through defender collider — DESIGN LIMITATION
The ball physics model doesn't include player-body collision for the ball in
flight. `resolveBallPlayerCollisions` only fires when `ball.pos.y < 1.35`. A
driven pass at ground level can pass through a defender's body without
deflection if it doesn't overlap with the defender's cylinder.

**Impact:** Ground passes occasionally pass through defenders.

**Severity: Low** — the control radius check in `possessionCheck` often catches
the ball before it reaches a defender.

### G-7 ✅ AI passing options — CORRECT
AI uses lane safety, space scoring and creativity-weighted selection.

---

## H. Dribbling

### H-1 ✅ Ball stays near dribbler — CORRECT
`glueTo` places ball at `ownerPos + facing * 0.48`, keeping it in front.

### H-2 ⚠️ Direction changes are instant — MINOR
The ball is glued to the player's facing direction with no interpolation. When
the player turns, the ball teleports to the new foot position. No lag or drag
is applied.

**Impact:** Ball visually snaps to new position during cuts.

**Severity: Low** — common in arcade-style football games.

### H-3 ⚠️ Ball vibration around feet — POTENTIAL
`dribble_touch` fires probabilistically during high-speed runs:
```ts
if (o.speed > 5.5 && !o.anim.busy && dribbleRoll < 0.025 * o.style.carry * ...)
  startAction(e, o, "dribble_touch");
```
The `dribble_touch` clip has `contactFrame: 0.5` and `duration: 0.32`. If the
touch moves the ball slightly via root motion, and the glue immediately
re-positions it, there can be a visible "fight" between the touch animation and
the glue.

**Severity: Low**

### H-4 ✅ Defender pressure — CORRECT
AI pressing logic engages when carrier is within `pressRadius` (9 m).

### H-5 ✅ No boundary sticking — CORRECT
Players are clamped to pitch bounds plus buffer for restart takers.

---

## I. Goalkeeper Behaviour

### I-1 ✅ GK catches normal shots — CORRECT
Two catch paths: (1) `gk_catch` action at contact frame, (2) body collision
auto-catch in `resolveBallPlayerCollisions`.

### I-2 ✅ GK parries when catching unsafe — CORRECT
```ts
const catchSpeed = CONFIG.ai.gkCatchSpeed * (0.5 + (handling + catching) / 300);
// In contacts.ts:
if (speed < catchSpeed && best < catchReach) {
  // catch
} else {
  // parry
}
```

### I-3 ⚠️ Inconsistent catch speed thresholds — MINOR
`possession.ts` uses `gkCatchSpeed = 9 * scale` for the auto-catch in the
penalty box. `contacts.ts` uses `CONFIG.ai.gkCatchSpeed * scale = 16 * scale`
for the `gk_catch` action. This means:
- Body collision catches fire for balls < ~9.5 m/s
- Action catches fire for balls < ~16.9 m/s

Balls between 9.5–16.9 m/s are only caught by the action, not the body.
This is intentional design but worth documenting.

### I-4 ✅ Crosses handled — CORRECT
GK claims crosses with predicted landing within reach.

### I-5 ✅ GK dive direction — CORRECT
```ts
const needDz = Math.sign(shot.z - p.pos.z) || 1;
const leftDz = -Math.cos(p.facing);
action = Math.sign(leftDz) === needDz ? "gk_dive_L" : "gk_dive_R";
```

### I-6 ⚠️ GK hold time before distribution — MINOR
`gkHoldLimit: 8` seconds is generous. The keeper can hold the ball for 8 s
before forced release. In real football, the GK has ~6 s to release.

### I-7 ⚠️ GK can punt into own goal — THEORETICAL RISK
The `forceKeeperRelease` targets the most advanced teammate:
```ts
const target = mates.length
  ? mates[0].player.pos.clone()
  : new THREE.Vector3(gk.pos.x + sign * Math.min(25, ...), 0, 0);
```
The target is clamped inside the pitch but not checked against the own-goal
direction. If the keeper is under extreme pressure and all teammates are behind
him, the clearance could theoretically go backward toward his own goal.

**Impact:** Very unlikely due to sign-based targeting, but not guarded.

**Severity: Very Low**

### I-8 ⚠️ GK leaves line too early — NOT CHECKED FOR PENALTIES
As documented in C-2, the GK is positioned 0.72–4.2 m off the line during
penalties, which is equivalent to "coming off the line early" but is the
default positioning.

### I-9 ✅ Rebound logic — CORRECT
Parries deflect the ball using `gk_parry` profile with controlled speed. No
infinite save loop because the parried ball moves away from goal.

### I-10 ✅ Smother logic — CORRECT
GK smothers dribblers in the box when within `gkSmotherRange` and ball is low.

---

## Summary of Bugs by Severity

### 🔴 Major (Game-Breaking / Rule-Violating)
| ID | Scenario | Description |
|----|----------|-------------|
| C-1 | Penalties | Ball placed at foul position, NOT the penalty spot |
| C-2 | Penalties | Goalkeeper not constrained to the goal line |

### ⚠️ Medium (Gameplay-Affecting)
| ID | Scenario | Description |
|----|----------|-------------|
| F-3 | Slide tackles | `get_up` may cut slide animation short; 2.5 s grounded time |

### 🟡 Minor (Visual / Edge Cases)
| ID | Scenario | Description |
|----|----------|-------------|
| A-4 | Corners | Defender/attacker spot overlap creates jitter |
| A-8 | Corners | Player collisions in crowded box |
| D-1 | Throw-ins | Taker placed 0.18 m inside the touchline |
| E-2 | Tackling | `foulScore: 0.18` too low — some reckless challenges go unpunished |
| E-5 | Tackling | `standBodyReach: 1.9` large — body contact without ball = wasted miss |
| G-4 | Passing | Pass cancelled after strike causes ball "teleport" |
| G-6 | Passing | Ground passes can pass through defender colliders |
| H-2 | Dribbling | Ball direction changes are instant (no interpolation) |
| I-6 | Goalkeeper | 8 s hold limit generous (real = 6 s) |
| I-7 | Goalkeeper | Theoretical own-goal punt not guarded |

### ✅ Working Correctly
- Corner trigger, ball placement, taker approach, attacker runs, GK positioning
- Free kick foul detection, ball placement, wall formation, kicker selection
- Penalty awarding, taker selection, shot aim, rebound handling
- Throw-in awarding, animation, ball release, reception
- Standing tackle outcomes, recovery, card system
- Slide tackle ball winning, dangerous tackle penalties, recovery timers
- Short/long/through passes, receiver prediction, AI pass selection
- Ball dribbling glue, defender pressure, boundary handling
- GK catching, parrying, cross claiming, diving, smothering, distribution

---

## Recommended Fixes

### Fix C-1: Penalty spot placement
In `contacts.ts`, when awarding a penalty, compute the penalty spot:
```ts
if (inBox) {
  const goalX = attackGoal.x;
  const penaltyDist = 4.2; // scaled 11 m on 40 m pitch
  const penX = goalX - e.ai.attackSign(carrier.team, e.rules.half) * penaltyDist;
  e.rules.startSetup("penalty", [penX, 0], carrier.team);
} else {
  e.rules.startSetup("free_kick", [carrier.pos.x, carrier.pos.z], carrier.team);
}
```

### Fix C-2: Goalkeeper on goal line during penalties
In `restarts.ts`, add penalty-specific GK placement:
```ts
if (isPenalty && defendingGk) {
  const gkZ = THREE.MathUtils.clamp(ball.z, -goalHalf, goalHalf);
  stage(defendingGk, new THREE.Vector3(ownGoal.x, 0, gkZ), ball);
} else if (defendingGk) {
  const gkSpot = keeperPositionTarget(ball, ownGoal, ...);
  stage(defendingGk, gkSpot.target, ball);
}
```

### Fix F-3: Delay `get_up` until slide animation completes
In `contacts.ts`, defer the `get_up` request:
```ts
if (action === "tackle_slide" && tackleOutcome !== "clean") {
  // Don't request get_up immediately; let the slide animation finish first.
  // The recovery timer already prevents re-tackling.
  // get_up will be triggered by the animation system when the slide clip ends.
}
```

### Fix D-1: Throw-in taker outside touchline
```ts
taker.pos.set(pr.pos[0], 0, Math.sign(pr.pos[1]) * (CONFIG.pitch.width / 2 + 0.3));
```
