# Motion generator → game pipeline

The generator in `tool/` produces a **game-ready animation pack**: one
`fieldmotion.pack.v1` file whose clips are authored on the same 21-joint skeleton the
prototype animates, each tagged with the gameplay slot it drives. The game loads the pack
at startup; registering a clip binds it to its slot, so the animation controller plays
generated motion for passes, shots, tackles, keeper actions, restarts and all locomotion
bands without a code change.

## What ships

| Piece | Path |
| --- | --- |
| Shared skeleton (single source of truth) | `tool/src/rig.ts` |
| Clip authoring + FK + pack writer | `tool/src/gameclip.ts` |
| Headless build script | `tool/scripts/build-game-clips.ts` |
| Generated pack | `game prototype/public/motions/game-motion-pack.json` (32 clips, ~730 KB at 30 fps) |
| Importer / retargeter / registry | `game prototype/src/game/motion.ts` |
| Controller playback | `game prototype/src/game/anims.ts` |
| Pipeline test (generator → live match) | `game prototype/scripts/motion-pipeline.ts` |
| Pose contact sheet (side view of 12 clips) | `game prototype/docs/motion-contact-sheet.svg` |

```text
tool/src/rig.ts        joint names, bone topology, bind pose (no DOM, no MediaPipe)
        │
tool/src/gameclip.ts   per-slot joint-angle curves  ──►  forward kinematics  ──►  frames[].j
        │
tool/scripts/build-game-clips.ts  ──►  public/motions/game-motion-pack.json
        │                                    (or the "Game pack" button in the studio)
game startup / Motion Lab  ──►  parseFieldMotionText  ──►  registerFieldMotionClip(clip) → slot binding
        │
src/game/motion.ts     hierarchy-aware retarget (world limb directions → local bone Eulers)
        │
src/game/anims.ts      locomotion blend space (idle/walk/jog/sprint/jockey) + actionPose
        │
src/game/engine.ts     ball_contact at the authored contact frame, root motion into the player
```

## Playing the pack

The pack is loaded on startup (`src/main.tsx` → `loadGeneratedMotionPack()`), so the
prototype animates from the generated clips by default: locomotion blends by speed band,
actions (pass, shot, header, tackle, keeper, restarts) replace the procedural poses, and
ball contact fires at each clip's authored contact frame. If the fetch fails the game keeps
using the procedural animation and logs one line to the console.

**Motion Lab** repeats the load on demand and reports the bindings: the panel shows how
many clips are linked and every `slot ← clip` pair. Import also works from disk — drag
`game-motion-pack.json` onto Motion Lab, or import a single clip. Binding comes from
`metadata.slot` (or a `slot:<id>` tag), and the slot must be an id from
`ANIMATION_CATALOGUE` in `src/game/config.ts`.

## Clip ↔ slot table

| Clip id | Game slot | Category | Duration (s) | Contact frame | Playback | Root motion |
| --- | --- | --- | --- | --- | --- | --- |
| `gen_idle` | `idle` | idle | 2.40 | — | loop | — |
| `gen_walk` | `walk` | locomotion | 1.10 | — | loop | — |
| `gen_jog` | `jog` | locomotion | 0.82 | — | loop | — |
| `gen_sprint` | `sprint` | locomotion | 0.62 | — | loop | — |
| `gen_jockey` | `jockey` | locomotion | 0.90 | — | loop | — |
| `gen_shield` | `shield` | control | 1.20 | — | loop | — |
| `gen_turn_left` | `turn_left` | turn | 0.42 | — | one-shot | yes |
| `gen_turn_right` | `turn_right` | turn | 0.42 | — | one-shot | yes |
| `gen_turn_180` | `turn_180` | turn | 0.55 | — | one-shot | yes |
| `gen_pass_short` | `pass_short` | pass | 0.45 | 0.52 | one-shot | — |
| `gen_pass_long` | `pass_long` | pass | 0.62 | 0.55 | one-shot | — |
| `gen_pass_through` | `pass_through` | pass | 0.58 | 0.50 | one-shot | — |
| `gen_shoot_normal` | `shoot_normal` | shoot | 0.70 | 0.55 | one-shot | — |
| `gen_shoot_finesse` | `shoot_finesse` | shoot | 0.74 | 0.58 | one-shot | — |
| `gen_shoot_volley` | `shoot_volley` | shoot | 0.66 | 0.50 | one-shot | — |
| `gen_header` | `header` | header | 0.52 | 0.48 | one-shot | — |
| `gen_tackle_stand` | `tackle_stand` | tackle | 0.60 | 0.45 | one-shot | yes |
| `gen_tackle_slide` | `tackle_slide` | tackle | 0.95 | 0.50 | one-shot | yes |
| `gen_intercept` | `intercept` | control | 0.40 | 0.50 | one-shot | — |
| `gen_first_touch` | `first_touch` | control | 0.50 | 0.45 | one-shot | — |
| `gen_dribble_touch` | `dribble_touch` | control | 0.32 | 0.50 | one-shot | — |
| `gen_gk_dive_l` | `gk_dive_L` | gk | 0.80 | 0.55 | one-shot | yes |
| `gen_gk_dive_r` | `gk_dive_R` | gk | 0.80 | 0.55 | one-shot | yes |
| `gen_gk_catch` | `gk_catch` | gk | 0.50 | 0.50 | one-shot | — |
| `gen_gk_parry` | `gk_parry` | gk | 0.48 | 0.50 | one-shot | — |
| `gen_gk_punt` | `gk_punt` | gk | 0.85 | 0.55 | one-shot | — |
| `gen_gk_roll` | `gk_roll` | gk | 0.62 | 0.56 | one-shot | — |
| `gen_throw_in` | `throw_in` | restart | 0.90 | 0.55 | one-shot | — |
| `gen_corner_kick` | `corner_kick` | restart | 0.78 | 0.56 | one-shot | — |
| `gen_celebrate` | `celebrate` | celebrate | 2.20 | — | one-shot | — |
| `gen_stumble` | `stumble` | recover | 0.55 | — | one-shot | yes |
| `gen_get_up` | `get_up` | recover | 1.00 | — | one-shot | — |

## Contact frames

`metadata.contactFrame` is normalised time (0–1) and is what the controller reads:

- `ActionAnimator.update` raises `contact` when `actionT / actionDur` first passes the
  frame, so the ball is struck when the foot/head/hands of the clip actually reach the
  ball, not on the first frame of the action.
- The clip duration comes from the bound clip (`getClip` prefers the bound metadata), so
  a 0.62 s generated pass plays for 0.62 s.
- Contact clips also carry a `metadata.frameEvents` entry `{ t, type: "ball_contact" }` at
  the same time, so external consumers see the event without knowing the slot table.
- The generator keys the striking limb so that at the contact frame the foot is low
  (0.11–0.24 m for ground passes and shots; the volley is deliberately higher) and ahead of
  the plant foot — 0.45–0.67 m in front of the pelvis, where a ball of radius 0.11 m sits.

## Coordinate convention and root motion

The generator authors every clip right-handed, Y-up, metres, **+Z forward, +X to the
subject's right**. That matches the game rig's bind pose, so the retarget only has to
convert world limb directions into local bone rotations:

```text
world(bone)  = shortestArc(restDirection(bone) → trackedDirection(bone))
local(bone)  = inverse(world(parent)) · world(bone)
```

`restDirection` is the rig's own rest direction for that bone, so an A-pose source (arms
angled out) and the game rig (arms hanging) resolve to the same world limb directions.

Root motion is `pelvis − bindPelvis` in the clip's own frame. The controller integrates it
in facing space as:

```ts
rootDelta = { dx: current.z − previous.z, dz: −(current.x − previous.x) }
```

i.e. clip **+Z is forward**, clip **+X is the subject's right** (engine lateral +Z is left).
Before this mapping, a clip travelling forward along +Z was fed in as lateral travel, so
tackles and dives looked like they slid sideways on the spot. `motion-integration.ts`
asserts both the clip travel and the engine mapping.

## Verification

```bash
cd "game prototype"
npm run verify:motion
```

`scripts/motion-pipeline.ts` builds the pack straight from `tool/src/gameclip.ts`, imports
it the way the game does, and asserts:

1. the generated pack parses into clips and every clip validates against the 21-bone contract;
2. clip ids are unique and never collide with a built-in clip id;
3. registration binds each clip to a real `ANIMATION_CATALOGUE` slot;
4. the retargeted game bones point where the generated limbs point (worst deviation here:
   0.00°) — this is the check that would fail if a bone map or the FK were wrong;
5. the bound cycles drive the locomotion blend space, the sprint cycle actually strides,
   and jog and sprint do not play the same pose;
6. the bound clip supplies its own duration to the controller, the kicking leg swings
   forward through the contact frame, and ball contact fires at the authored time
   (0.25 s for a 0.45 s pass at contact frame 0.52);
7. root motion is carried into the engine as forward travel for the slide tackle (2.5 m)
   and as lateral travel for a keeper dive (1.15 m);
8. a live 45 s match runs on the imported pack: at least four distinct action clips and two
   locomotion bands are played, players still reach running speed, and the match keeps
   passing;
9. `public/motions/game-motion-pack.json` is up to date with the generator.

Run `npx tsc --noEmit -p .` for the type check and the behavioural suites (`selftest`,
`kickoff-regression`, `tactics-test`, `support-regression`, `attacking-runs`) to confirm the
generated animation did not disturb gameplay. In `tool`, `node
node_modules/typescript/bin/tsc --noEmit -p .` type-checks the generator itself.

## Contact sheet

`docs/motion-contact-sheet.svg` draws 12 clips (locomotion, kicks, slide tackle, dive,
catch, throw-in, corner) as four side-view stick figures each, with the contact frame
highlighted. Regenerate it after changing the clips:

```bash
cd tool
node scripts/contact-sheet.mjs "../game prototype/public/motions/game-motion-pack.json" "../game prototype/docs/motion-contact-sheet.svg"
```

## Regenerating the pack

Inside the studio (browser): **Game pack** button in the export strip downloads
`game-motion-pack-<fps>fps.json` straight from `tool/src/gameclip.ts`.

Headless (what this repository ships). The tool install's `esbuild` is a Windows binary,
so run the bundler that ships with the game prototype:

```bash
cd tool
../"game prototype"/node_modules/.bin/esbuild scripts/build-game-clips.ts \
  --bundle --platform=node --format=cjs --outfile=/tmp/build-game-clips.cjs
node /tmp/build-game-clips.cjs ../"game prototype"/public/motions/game-motion-pack.json 30
```

The script prints one line per clip (id, slot, duration, frame count, loop) and writes
`public/motions/game-motion-pack.json`.

## Adding or changing a clip

1. Add a `GameClipSpec` to `GAME_CLIP_SPECS` in `tool/src/gameclip.ts`:
   `slot` (a catalogue id), `category`, `loop`, `rootMotion`, `duration`, `contactFrame`,
   `interruptible`, `priority`, and a `pose(p, t)` returning joint angles in degrees.
2. Use `curve(p, ...)` / `strikeCurve(contact, back, hit, follow)` so the strike peak sits
   on the contact frame; `leg()`/`arm()` take anatomical angles, not bone names.
3. Rebuild the pack, then run `npm run verify:motion` — it fails if a clip stops binding,
   if the limbs no longer point where the skeleton points them, if contact timing drifts,
   or if the shipped pack no longer matches what the generator produces.

## Known limits

- Clips are authored from joint-angle curves and expanded by FK; there is no IK pass, so a
  foot can dip a few centimetres below y=0 in the lowest poses (worst case 6 cm in the slide
  tackle and get-up clips).
- The stance is not speed-locked: locomotion cycles are sampled at the engine's stride
  phase, which keeps the feet roughly in sync but does not solve foot sliding.
- `frames[].q` is written for tooling compatibility; the importer treats `frames[].j` as
  authoritative because joint positions preserve limb lengths exactly.
