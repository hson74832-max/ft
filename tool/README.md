# FieldMotion: 2D-to-3D football motion generator

FieldMotion is a browser-based reference implementation and technical blueprint for turning RGB football video or animated GIF footage into a color-coded 3D skeleton and a rig-handoff JSON animation. The app includes five **procedural demos** so the studio can be explored without uploading media. Demos are illustrative, not pose estimates from the reference photograph.

## Quick start

```bash
npm install
npm run dev
```

Open the local Vite URL, upload a video or GIF, wait for tracking, scrub or rotate the skeleton, adjust smoothing, and select **Export motion JSON**. `npm run build` builds the deployable client. Inference runs locally in the browser, but first use requires network access for the MediaPipe WASM runtime and lite model; the demo photograph and web fonts also load externally.

## Studio controls

- **Human isolation (automatic + manual).**
  - **Isolate human** cuts the player out with MediaPipe's per-pixel segmentation mask (CPU delegate, read inside the `detectForVideo` callback, stored at ≤192 px ≈ 20 KB/frame). Threshold, edge feather and background (dark pitch, black, chroma green, dimmed footage) are adjustable live without re-tracking. With segmentation off, an approximate **pose-hull** cutout is used and labelled as such.
  - **Manual subject selection:** *Detect people on this frame* runs a 6-person IMAGE-mode pass and draws clickable boxes; or *Draw subject box* to drag a region by hand. Tracking then runs only inside that region (cropped and upscaled for distant players), landmarks are un-cropped back to full-frame coordinates, and *Follow moving player* re-centres the region each frame with smoothing and widens it when the player is lost.
  - **Skeleton overlay** and **Pure video** remain available.
- **Configurable 15, 30, and 60 FPS capture.** Selectable directly in the header and trim bar. At 30 or 60 FPS, high-velocity football movements (instep kick strike, sprint turn, dive extension) are sampled at double or quadruple frequency, drastically improving One-Euro filter velocity derivation and ankle precision.
- **Input range (start / end).** After a clip loads, its duration is probed and you can set the start and end seconds, then press **Re-track @ [FPS]** to run pose estimation only on that window.
- **Output window (in / out).** Two trim handles on the timeline set the play/export window. Playback loops inside it, and the exported JSON is sliced to that window and re-based to start at `00:00.0`.
- **Playback speed.** A `0.1x`–`3x` slider plus quick presets controls preview speed without changing the exported timestamps.
- **Skeleton variety.** Overall size, stature (height), build (width), joint size, bone thickness, perspective, four color themes, ground-shadow and neon-glow toggles, plus a randomize button to generate skeleton variants.

## Skeleton Accuracy & Anatomical Fidelity

The 3D skeletal graph strictly matches the user specification and reference imagery:
1. **Color-Coded Limbs & Joints:**
   - **Left Limbs (Anatomical Left):** Coral (`#f17a70`) for shoulder, elbow, wrist, hip, knee, ankle, heel, toe.
   - **Right Limbs (Anatomical Right):** Azure / Sky Blue (`#5ca7ff`) for shoulder, elbow, wrist, hip, knee, ankle, heel, toe.
   - **Center Spine Column:** Clean White (`#e5eaf1`) through pelvis, spine, and chest.
   - **Head & Neck Nodes:** Amber Gold (`#f7cb62`) matching the yellow head cluster in the reference.
   - **Ground Anchors & Contact Shadows:** Soft jade rings (`rgba(135,220,167,0.29)`) at feet contact points plus a dotted vertical center-of-mass plumb line to a ground contact disk.
2. **Coordinate & Anatomical Alignment:**
   - MediaPipe's raw world landmarks (Y-down, hip origin in meters) are inverted to standard right-handed graphics conventions ($Y$-up, $Z$-depth, $+X$ right).
   - In image-to-world normalization, estimated player height in normalized image space stabilizes vertical grounding so player pelvis sits at $\approx 1.04\,\text{m}$ rather than floating or jittering with camera distance.
   - Foot heels (indices 29, 30) and foot toes (indices 31, 32) include visibility validation with fallback alignment to avoid inverted ankle poles when foot tips are occluded by turf or ball contact.
   - Orthogonal axis singularity protection was added to `quaternionFromTo` to prevent `NaN` rotations during extreme $180^\circ$ limb flips.

## Round 9 — performance, export size, bugs

**Where the time went (measured / traced):**

| Cause | Cost | Fix |
|---|---|---|
| *Isolate human* applied `ctx.filter = blur()` to the full-resolution cutout layer — up to 5.7 MP at 2× DPR — **once per player, every frame** | Dominant; the view fell to a few fps in all-players mode | All keep-alpha (pixel mask + every pose hull) is accumulated on one ≤256 px canvas, blurred once, applied in a single `destination-in`. The layer itself is capped at ~1 MP (the mask it's composited with is ≤192 px, so more resolution was invisible) |
| Playback `setTime` at the display rate (60–144 Hz) → full React re-render per tick | 2–5× more renders than the clip has frames | Ticks at the clip's own FPS; identical visible motion |
| Every slider drag re-filtered **all** other players (up to 11 × 900 frames × 63 series), even in *Active only* mode where none were drawn | Slider stutter in all-players mode | Others are processed only when shown; export processes them on demand |
| Video frames extracted by **seeking** (keyframe + forward decode per sample) | Slowest decode path | Sequential decode via playback + `requestVideoFrameCallback`, with seek fallback; recorded times are the real presented `mediaTime` |
| `smoothFrames` inner loop used string-keyed `Map` lookups (`${joint}.${axis}`) | 28.8 ms/call | Index-based series: 17.6 ms, bit-identical output (17.62 → 3.09 mm) |

**Export size.** The 2 MB you saw was pretty-printing (`JSON.stringify(…, null, 2)` — indentation alone was ~40 %), full double precision, and a verbose per-joint object layout. Measured for a 900-frame / 30 s clip:

| Layout | Size |
|---|---|
| old verbose + pretty-print | 3.7 MB |
| verbose, minified, 3 dp | 1.46 MB |
| **compact, 3 dp (new default)** | **555 KB** (6.6× smaller) |
| compact, no rotations | 330 KB |
| compact, gzipped (`.json.gz`) | **105 KB** (35× smaller) |
| compact, no rotations, gzipped | 65 KB |

Compact format `fieldmotion.pose.v2`: per frame `t` (s), `c` (confidence), `j` = flat `[x,y,z,…]` in `jointOrder`, optional `q` = flat `[x,y,z,w,…]` in `boneOrder`, `h:1` when held. Round-trip error at 3 dp is ≤0.5 mm; tracking itself is accurate to ~1 cm, so nothing is lost. The *Export file* panel exposes layout, precision (2/3/4 dp), rotations on/off and gzip, and shows the size of the last export.

**Bugs fixed on the way:** a stalled video seek could hang a run forever (now a 4 s timeout with a re-encode hint); the playback path never fakes frames when the source is slower than the sample rate; the 2-dp precision button was labelled "1 cm" correctly but the hint called 3 dp lossless without saying why.

## Round 8 — track all players

**One / All players** switch in the source pane (and *Tracking mode* in Isolation & capture). In *All players* mode the detector returns up to 2–6 people per frame and `MultiTracker` (`src/identity.ts`, DOM-free) gives each a stable ID:

- **Global assignment.** Every (track, detection) pair is scored by colour (jersey/shorts/hair/legs), predicted position and size; pairs are assigned cheapest-first so two tracks can never claim the same detection — the failure mode of running a single-player tracker per person.
- **Least-squares velocity** over ~0.3 s. Frame-to-frame differencing turned ±0.4 % detection jitter into ~0.24 units/s of velocity noise — more than a sprinting player's screen speed — which made same-kit crossings swap IDs in testing. While two tracks are ambiguous, velocity and colour memory are frozen.
- **Re-identification.** A player lost for up to 3 s gets his *old* ID back when a detection matches his colours (stricter threshold), instead of a new ID.
- **Ghost filtering.** Tracks shorter than 0.4 s, or detected on fewer than 25 % of frames across their lifespan (recurring false detections), are dropped. Up to 12 players are kept, labelled P1… by screen time.

**Shared scene.** `finalizeClip(frames, scene)` places every player in one coordinate system: x from image position at the player's own metric scale, depth from apparent size (`mpu = distance × 2·tan(vfov/2)`, assumed ~35° lens), and vertical motion high-passed (1.5 s rolling median) so slow image drift from depth change doesn't read as sinking while jumps survive. The 3D view auto-fits the whole group with a static, clip-wide camera.

**UI.** Every player is drawn in both views in his own colour with an ID label; the active one is marked ★. Click a player on the video or in the player strip to make him active — smoothing, ground lock, the jitter readout and 3D focus follow him, and switching no longer resets the playhead. *Showing all / Active only* toggles the others. In *Isolate human*, all present players are cut out. **Export** writes `fieldmotion.multi.v1` with every player on the shared timeline; `present:false` marks frames where a player isn't in the clip. A drawn subject box limits the analysed area (e.g. excluding the bench).

**Verified (tracker simulation, 30 fps, noisy detections, random detector order):**

| Scenario | ID swaps |
|---|---|
| same-kit teammates crossing, 2-frame occlusion | 0 |
| same-kit teammates crossing, 6-frame occlusion, 2× noise | 0 (was 2 before LS velocity) |
| opponents crossing, rear player hidden | 0 |
| player leaves for 1.5 s, returns elsewhere | 0 (old ID restored) |
| six players + periodic false detections | 0 |

Scene placement: a smaller player to the right of centre lands at x = +1.07 m, z = −1.59 m (right and further away); without the shared scene both would stack at x = 0.

**Limits.** Monocular depth from apparent size is approximate (assumed lens, players crouching look "further"). The model sees the frame at 512 px, so very small, distant players in wide broadcast shots may not be detected at all; draw a subject box around the area of play to zoom the analysis in. Same-kit players who cross *and* change direction while hidden can still swap. All-players mode uses the pose-hull cutout (no pixel masks) and is slower per frame than one-player mode.

## Round 7 — bug sweep

| Bug | Severity | Fix |
|---|---|---|
| **The colour lock was completely disabled by a buffer-size mismatch.** Colour sampling moved to a 128 px buffer, but `samplePatches` was still told the buffer was 512 px, so it indexed past the end. `Uint8ClampedArray` returns `undefined` out of range → every sampled colour became `NaN` → the colour term was silently dropped and only position matching remained. | **Critical** | Pass the real size, and export a single `SAMPLE_SIZE` constant so the two can no longer disagree |
| **UI froze after "Detect people".** It cancelled in-flight tracking, but the superseded run returns early *without* touching `status`, leaving `processing` set forever: the overlay never cleared and the clickable person boxes could not render (they need `status !== 'processing'`). | **High** | Restore a visible status before scanning |
| **Hair colour sampled the background.** The patch was pushed 0.55 ear-distances above the ears with a 5×5 radius — above a short hairline — so it returned mostly pitch. This made the signature change when the camera panned. | High | Sample at ear level with a radius derived from ear width; same player now reads identically on two different backgrounds |
| **Wrong player's cutout.** When the detector returned fewer masks than poses, the code fell back to `masks[0]`, compositing a *different* player onto the isolated layer. | High | Only use the mask belonging to the picked person |
| **`memo` on the static sections never engaged.** The callbacks passed to it were new identities each render, so ~130 elements were re-diffed every animation frame despite the `memo`. | Medium | `useCallback` on all three handlers |
| **Clip statistics polluted by lost-tracking frames.** Held frames are verbatim copies of the pre-gap pose; including them stacked the bone-length medians, the metric scale and the ground line toward the moment tracking was lost. | Medium | Exclude held/unconfident frames from the statistics and from the floor |
| **1 MB `getImageData` per frame.** Reading the full 512 px canvas is ~900 MB of transient allocation over a long clip, for a handful of 5×5 patches. | Medium | Sample from a 128 px copy (1/16 the cost) |
| **"Preview movement" no longer returned to the demo clip** (a regression from the previous round). | Low | Call `chooseMovement` again |
| **Leaving colour-pick mode left playback paused and the crosshair armed** when switching to a demo motion. | Low | Reset picking state; resume playback after a pick |
| **`copyFlow` had an unhandled rejection** on non-secure contexts where the async clipboard API is absent. | Low | `execCommand` fallback |
| GIF preview budget could reach ~155 MB of decoded bitmaps. | Low | Reduced to ~92 MB |

**Verification.** The colour lock now reads `205,35,40` for a red shirt at 128 px; the same player on two different backgrounds scores **0.000** against himself and **4.30** against a blue-kit opponent (accept threshold 1.05). Crossing simulation with a panning background: **0 wrong picks**, 6 bridged frames. Held frames no longer shift the clip statistics at all (0.00 mm vs a clean clip).

## Round 6 — identity lock rebuilt, engine crash hardened, anti-levitation redone

**Why it kept switching players (round 5 was not enough).** `numPoses: 1` only ever returns "a person", so a colour gate could reject but never *choose*; the gate also re-locked onto whoever was on screen after ~1.5 s (that is literally "switch players" — removed); chroma-only colour could not separate white from black kits; the follow-box moved every frame under MediaPipe's internal tracker; and one landmarker was reused across runs, carrying stale tracker state.

**New design (`src/identity.ts`, DOM-free and unit-tested).**
- The detector now returns up to **3 candidates per frame** and a tracker picks ours by colour match, position (with velocity prediction), and size. If nobody matches it reports "not found" instead of guessing; short gaps are then **interpolated** (`bridgeHeld`, 187 mm → 42 mm error in the test) rather than frozen; gaps over 0.8 s stay honestly held.
- Colours are sampled per body part (jersey, shorts, hair, legs) at a scale that follows the player's size, and compared with an illumination-tolerant distance (half-shadowed red shirt 10.7, red vs blue 156, white vs black 63).
- **Pick colour from video:** choose Jersey / Hair / Shorts / Anything, click the player, and that colour outweighs anything learned automatically. With a colour picked and no box, the right player is chosen on the first frame even when another is bigger. Auto-learned colours are shown as dashed chips so you can see what it locked onto.
- **Strictness** slider (default 65%) and a status strip after tracking: `N/M frames locked · K look-alike detections rejected · J bridged`, with a warning when more than 20% of frames were lost.
- Follow-window moves only with hysteresis (near the edge or on a large size change), never every frame.

Simulation (target + opponent crossing, opponent the only one visible while overlapped): identity lock **0 wrong picks**, naive "take what the detector returns" **6 wrong**. Same-kit teams, well separated: 0 swaps (position holds the lock). Same-kit players *crossing closely* remains genuinely ambiguous — see limits.

**`Aborted()` hardening.** I cannot reproduce a WASM abort without your browser, so this removes every plausible cause and makes the rest recoverable, with a diagnostic:
- one global queue; one engine alive at a time (was up to three WASM instances); fresh VIDEO engine per run, closed afterwards;
- **every frame is fed at a fixed 512x512** (the follow-crop changed size per frame, which can crash segmentation buffers); degenerate / NaN crops are sanitised (a 0x0 canvas aborts the engine);
- model bytes are fetched once and passed as a buffer;
- on a crash the engine is rebuilt and the run **retries automatically**: attempt 2 without the pixel mask, attempt 3 on the lite model. The strip then says what happened, and a failure message names the stage (`detecting poses on frame 37`), so a repeat is diagnosable. A **Retry tracking** button was added.

**Anti-levitation.** Now a dedicated bar above the 3D view: toggle, "keep on ground until `[x]` s", **Whole clip** and **At playhead**, plus a blue band on the timeline showing the grounded span. The lock follows a *denoised* floor: pinning the raw lowest foot each frame copied foot noise onto the body (+8.6 mm pelvis jitter in test); now 8.33 → 8.01 mm, mean foot height 0.1 mm, feet never more than 3 cm under the floor, 0.5 m cap per frame, fades out over 0.5 s after the timer.

**Edge feather** softens the cut-out border: it blurs the mask edge by N px so the player blends into the new background instead of keeping a hard, jagged outline (0 = razor sharp, 1–2 natural, 4+ glowing halo). Explained in the UI under the slider.

## Round 5 — identity lock, engine crash fix, anti-levitation

**1. Player swapping → jersey/hair colour lock.** MediaPipe with `numPoses: 1` returns "a person", so when players cross, tracking could silently continue on an opponent. Each analysed frame now samples a 4-patch colour signature (shirt, shorts, torso centre, hair) from the exact pixels the pose was detected in. Chroma is illumination-normalised, so a shadow does not read as a new shirt (measured: same red kit shadowed = 0.070 distance → accepted; red vs. blue kit = 0.448, red vs. white = 0.358 → rejected at the 0.12 threshold). Mismatching frames are rejected, the pose holds, and the follow-ROI widens to re-find *your* player; (round 5 re-locked after ~1.5 s; that caused the switching and was removed in round 6). Toggle: **Keep the same player** in Isolation & capture (on by default; applies on re-track).

**2. "Aborted(). Build with -sASSERTIONS…" when changing player.** Root cause: a new tracking run started while the previous one was mid-`await`; the superseded loop fired one more `detectForVideo` into the same WASM graph. Fixes: (a) **one global queue** serialises every MediaPipe call — overlap is now impossible; (b) a `cancelled()` check **after** each `await seek` so a superseded run exits before touching the graph; (c) people-detection cancels in-flight tracking first and uses its own canvas; (d) **abort recovery** — if the WASM runtime ever dies, all cached landmarkers are discarded and the next attempt rebuilds a fresh engine with a human-readable message instead of the raw Emscripten abort.

**3. Anti-levitation (ground lock).** New **Ground** button on the timeline plus a timer in *Speed & smoothing*. From clip start until the timer, every frame is shifted vertically so the lowest foot point sits exactly on the floor — removing residual monocular floating *and* sinking — then the correction fades out over 0.5 s so a jump, header or dive after the timer is untouched. Measured: locked frames foot-y = 0.0000 exactly, no boundary pop (max fade step 19 mm), source frames not mutated. Set the timer to the clip end to ground the entire clip.

## Vibration fix (round 4) — measured

The visible vibration had one root cause: the One-Euro filter estimated speed by **differencing adjacent frames**. Detection noise of ~1.5 cm/frame at 30 FPS reads as 0.45 m/s, so `cutoff = minCutoff + beta * speed` opened to ~4.4 Hz and passed the noise it was supposed to reject — a self-defeating feedback loop. Distal beta was also a very high 0.32, and there was no spike rejection.

Changes in `smoothFrames`:
1. **Three-sample velocity** with its own low-pass, so a single bad frame cannot widen the cutoff.
2. **3-tap median pre-filter** (at ≥20% strength) removes single-frame spikes; a monotonic ramp is unchanged, so a real strike's peak is preserved.
3. **Lower per-group beta**: torso 0.05, hips/shoulders 0.08, knees/elbows 0.12, ankles/wrists 0.14, heels/toes 0.10.
4. **Dropout handling rebuilt**: held poses are fed back INTO the filter instead of returning early, which previously left filter state and timestamps stale so recovery snapped.
5. **`jitterScore()`** measures residual pose curvature and is displayed live as a `JITTER x.x mm` badge; an **Anti-vibration** preset sets 82%.

Verified with a synthetic 60 FPS instep kick plus ±1.5 cm deterministic per-frame joint noise:

| Smoothing | Jitter | Error vs. ground truth | Kick peak ankle height |
|---|---|---|---|
| raw / off | 17.62 mm | 8.7 mm | 0.510 m |
| 20% | 3.73 mm | 8.0 mm | 0.503 m |
| **48% (default)** | **3.09 mm** | **9.5 mm** | **0.502 m** |
| 82% | 1.98 mm | 15.6 mm | 0.497 m |
| 100% | 1.18 mm | 27.2 mm | 0.487 m |

Clean reference jitter is 0.18 mm, so the default setting removes ~82% of injected noise for ~5 mm of peak-loss on a strike. A 3-frame confidence dropout no longer changes the largest single-frame head jump (15.5 mm, which is genuine motion).

Other round-4 fixes: mask storage type is respected (a Uint8 mask read as Float32 became a solid-white mask with no cutout); segmentation masks are closed after each frame; separate landmarker instances per segmentation mode instead of `setOptions()` mid-life (the graph rebuild was the earlier timestamp-mismatch risk); `detectForVideo` uses the documented copy-on-return overload rather than the live-stream callback; landmark arrays are length-guarded; canvases compare the fields that affect drawing, so a playhead tick alone no longer forces a repaint; and the page title/meta were finally set.

## Accuracy audit (round 3) — verified numerically

| Defect | Fix | Verified |
|---|---|---|
| 2D overlay drawn at `x*canvasWidth` while video used aspect-*cover* → skeleton offset from player | One shared CONTAIN fit transform for media, landmarks, masks and ROI | — |
| Limb lengths fluctuated per frame (monocular depth) | `finalizeClip` resets each bone to its clip-median length along the tracked direction | thigh spread 5.2 cm → 0 |
| Floating/sinking skeleton from per-frame height heuristics | Clip-median metres-per-pixel scale; floor = 10th percentile of lowest foot | standing feet y = 0.000; jump kept (0.23 m) |
| Root X ignored aspect ratio | Uses full-frame aspect × metric scale | — |
| Head placed below the nose | Head from ear midpoint + up offset | head > neck > chest |
| Retiming overwrote tracked frames (60→15→60 lost data) | Original kept; retimed views derived | source unmodified |
| Demo: 16 unset landmarks visible at frame centre | Unset landmarks have visibility 0 | — |
| GIF preview free-running, unsynced with pose | Analysed frame stored as downscaled `ImageBitmap` (≤360 px, ≤450 frames) | — |
| Video at 1x while timeline at 0.5x → re-seek stutter | `playbackRate` follows speed | — |
| `SourceCanvas` loop rebuilt every pose frame (regression) | Mount-once loop, all inputs via refs | — |
| `SkeletonCanvas` ignored rotation/style changes while paused (regression) | Redraw on any prop change | — |

## Performance audit results

| Issue | Impact | Fix |
|---|---|---|
| `SourceCanvas` render effect was keyed on `time` | New `ResizeObserver` created and destroyed **60×/second** during playback | Single mount-scoped render loop reading live values through a ref |
| Video was seeked on every playhead change | Each `currentTime` assignment aborted the previous decode; footage stuttered and CPU spiked | Native `play()`/`pause()`, with re-seek only when drift exceeds `0.35s` |
| `SkeletonCanvas` same effect-keying bug | `ResizeObserver` churn per pose frame | Same mount-scoped loop + dirty flag |
| Canvases drew even when idle | Wasted GPU/CPU while paused | Dirty-flag: redraw only on pose change, resize, or video frame advance |
| Skeleton drawn with one `stroke()` per bone | ~30 stroke calls per frame per canvas | Batched into 3 paths by colour group |
| Every endpoint projected twice (bone + joint pass) | Double trig work | Projected once into a map, reused |
| `ctx.filter = 'brightness(...)'` per frame | Forces a slow software compositing path in some browsers | Removed |
| `activeFrame` fallback called `demoFrame()` inline | New object identity every render, forcing child effect re-runs | Module-level `FALLBACK_FRAME` constant |
| Smoothing slider recomputed the whole filter bank per input event | Up to 900 frames × 21 joints × 3 axes synchronously while dragging | `useDeferredValue(smoothing)` |
| ~130 static documentational elements re-diffed every frame | needless React work at 60fps | Extracted into `memo`-ized `Sections` |
| 30s range at 60 FPS silently sampled ~20 FPS | UI claimed 60 while the sample count was clamped | Window is now clamped instead, so requested FPS is always honoured |
| GIF parsed twice (probe + process) | Double decode and a retained `ArrayBuffer` | Single-parse cache, released before processing |
| Low-confidence frames carried the previous `bbox` forward | Isolation reticle froze during occlusion | Preserves the current frame's own 2D points and box |
| `onLoadedData` ran `ctx.fillRect(0, 0, 0, 0)` | Dead code | Removed |

Switching FPS now **re-times** an already-tracked clip via `resampleFrames` interpolation instead of forcing another inference pass; an explicit **Re-track from source** button is available when fresh landmark samples are wanted.

## Remaining known limits

- Pose estimation and video seeking still run on the main thread. Moving them into a Web Worker is the next meaningful win for long clips.
- `demoFrame` allocates a 33-element array per generated frame. This happens once per clip build, not per rendered frame, so it is not hot.
- `MOVEMENTS[].subtitle` is documentational and currently unused by the UI.

## Fixed: MediaPipe timestamp mismatch across files

`detectForVideo` requires **strictly increasing timestamps for the entire lifetime of a reused `PoseLandmarker`**. Restarting at `0` for a second file throws:

```text
INVALID_ARGUMENT: CalculatorGraph::Run() failed: Packet timestamp mismatch on a
calculator receiving from stream "norm_rect". Current minimum expected timestamp
is 17420001 but received 0.
```

`src/processor.ts` fixes this with a module-level monotonic `clock` and a `stamp()` helper. Every detection (video or GIF, first file or tenth) advances the shared clock, so timestamps never go backwards even though each clip's own frame times restart at zero. Recreating the landmarker per file would also work, but reuse is faster and avoids reloading the model.

## Game-ready animation pack

The studio also ships a **generator** that writes animation the 5v5 prototype plays
directly. `src/rig.ts` is the shared 21-joint field skeleton (joint names, bone topology,
bind pose) with no browser or MediaPipe imports, so the same numbers drive the studio and
the game. `src/gameclip.ts` authors one clip per gameplay slot from joint-angle curves and
expands them with forward kinematics:

- **Locomotion:** idle, walk, jog, sprint, jockey (loops whose first and last frame match).
- **Ball actions:** short/long/through pass, laces/finesse/volley shot, header, first touch,
  dribble touch, intercept — each with a contact frame where the foot reaches the ball.
- **Duels and keeper:** standing and sliding tackle (root motion), dive left/right (root
  motion), catch, parry, punt, roll.
- **Restarts, turns, recoveries:** throw-in, corner, 90°/180° turns, celebrate, stumble,
  get up, shield.

Every clip carries `metadata.slot` (the game animation slot it drives), `duration`,
`contactFrame`, `interruptible`, `priority` and a `ball_contact` frame event, and every
bone keeps its bind length because positions come from FK rather than from noise.

**Game pack** in the export strip downloads `game-motion-pack-<fps>fps.json` — a
`fieldmotion.pack.v1` bundle. Drop it on the prototype's Motion Lab (or use *Load generated
game pack*) and the match animates from it. The headless build writes the same file to
`game prototype/public/motions/`:

```bash
cd "game prototype"
node_modules/.bin/esbuild ../tool/scripts/build-game-clips.ts \
  --bundle --platform=node --format=cjs --outfile=/tmp/build-game-clips.cjs
node /tmp/build-game-clips.cjs public/motions 30
```

The pipeline, clip ↔ slot table, root-motion axis convention (`+Z` forward, `+X` to the
subject's right) and the automated integration checks are documented in
`game prototype/docs/MOTION-PIPELINE.md`.

## Architecture

```text
RGB video / animated GIF
    |
    v
Frame decoder (browser video seeking / gifuct-js compositing)
    | timestamped frames, up to 15 FPS and 450 samples
    v
Pose estimation (MediaPipe Pose Landmarker, VIDEO mode)
    | 33 normalized image landmarks + 33 metric-ish world landmarks
    v
Coordinate extraction (src/motion.ts)
    | 21 named joints, right-handed Y-up, estimated root translation
    v
Motion smoothing (per-coordinate One-Euro filters + confidence hold)
    | temporally filtered poses
    v
Rig retargeting (bind-direction -> tracked-direction quaternions)
    | root translation + local bone direction targets
    v
3D animation output (interactive projected skeleton + JSON export)
```

The UI and playback are in `src/App.tsx`, file decoding and pose inference in `src/processor.ts`, coordinate mapping, demos, filtering and export in `src/motion.ts`, the rotatable 3D-to-canvas skeleton projection in `src/SkeletonCanvas.tsx`, the shared field skeleton in `src/rig.ts`, and the game-ready clip generator in `src/gameclip.ts` (`scripts/build-game-clips.ts` writes the pack headlessly).

## Step-by-step implementation

1. **Acquire footage.** Use a single, mostly visible player, with stable camera motion, enough lighting, and minimal occlusion. The browser accepts formats its video decoder supports (`MP4`, `MOV`, `WEBM`, etc.) or animated GIFs. Unsupported video codecs fail gracefully. The reference processes the first 30 seconds of video at 15 FPS, maximum 450 frames. GIFs are composited frame by frame with disposal handling and sampled at approximately 15 FPS.
2. **Estimate pose.** Initialize the MediaPipe Pose Landmarker lite model in `VIDEO` mode with `numPoses: 1`. `detectForVideo(frame, increasingTimestampMs)` returns normalized image-space and 3D world landmarks. The inference API is synchronous; this reference yields to the UI between short batches. For larger-scale deployment move decode/inference into a worker or server pipeline.
3. **Extract a humanoid skeleton.** MediaPipe landmark IDs 11-16 map arms, 23-32 map hips, knees and feet, and ID 0 approximates the head. Midpoints interpolate pelvis and chest; spine and neck are generated along that center line. Invert the world Y and Z signs to make a right-handed, Y-up view. MediaPipe world landmarks are hip-centered; approximate global XY root movement from normalized image hips. The 21 output joint names and connectivity are defined by `Joints` and `BONES`.
4. **Reduce temporal jitter.** `smoothFrames` applies a One-Euro low-pass filter independently to each joint axis. At the default slider setting the minimum cutoff is `7 - 0.058 * strength`; the velocity-sensitive beta is 0.32 for distal limbs, 0.2 for hips/shoulders/elbows, and 0.1 for the torso. This stabilizes the slow stance phase while preserving rapid foot and hip changes at a strike. If average visibility on eight key torso/leg landmarks drops below 0.35, hold the last smoothed pose rather than snapping to unreliable coordinates. Reset filters when switching clips; process frames in timestamp order.
5. **Preserve football kinetics.** For a kick, track pelvis yaw from the left/right hip axis, do not over-smooth the striking ankle, and pin the support foot during contact. For a sprint, validate opposing arm/leg phase, detect alternating foot contacts from ankle velocity and ground distance, and use root trajectory rather than in-place looping for travel. For a header, preserve takeoff impulse and neck extension. For a tackle, allow the center of mass to drop and shift laterally; impose ground constraints on the bracing hand/heel. For a goalkeeper dive, lock the push-off foot only until launch and retain fast lateral root acceleration. The demo sequences visually illustrate these movement profiles; the uploaded-file pipeline uses one general filter, not a trained action classifier or automatic contact solver.
6. **Retarget to a rig.** The export compares each tracked parent-to-child bone vector against the demo reference bind direction and writes a shortest-arc quaternion `[x, y, z, w]`. For a real rig, map each named bone to its humanoid counterpart, calibrate the character's rest-bone axes and lengths, then apply the rotation in the correct parent-local space. Drive the root from `rootTranslation`, interpolate between timestamps, and solve hands/feet with IK. These exported quaternions are **direction targets in the reference bind space**, not guaranteed plug-and-play local joint rotations for arbitrary Blender/Unity rigs.
7. **Export and validate.** The `.json` file includes `format`, `coordinateSystem`, `joints`, `bones`, and timed `frames` with `confidence`, `rootTranslation`, `joints`, and `boneRotations`. Check bone lengths, ground penetration, temporal continuity, and support-foot sliding before baking to an animation clip or exporting as GLB/FBX from a DCC tool.

## Export shape

```json
{
  "format": "fieldmotion.pose.v1",
  "coordinateSystem": "right-handed, Y-up, meters",
  "frames": [
    {
      "time": 0,
      "confidence": 0.95,
      "rootTranslation": { "x": 0, "y": 1.02, "z": 0 },
      "joints": { "pelvis": { "x": 0, "y": 1.02, "z": 0 } },
      "boneRotations": { "pelvis_spine": [0, 0, 0, 1] }
    }
  ]
}
```

The example is abbreviated; actual exports include all 21 joints and all connected bones per frame.

## Production upgrades and limits

- **Monocular depth ambiguity:** World landmarks are model-inferred, not measured 3D. The XY root estimate from image coordinates is affected by camera tracking and zoom; Z global translation is not reconstructed. Use multi-view capture or camera calibration for accurate global paths.
- **Contact-aware filtering:** Add a contact state machine for plant/strike/follow-through and a ground-plane estimate. During contact, pin the support foot in world space with IK and reconcile pelvis motion; release at toe-off. This is intentionally not claimed as implemented in the reference.
- **Rotation semantics:** Compute robust pelvis/torso orientation from 3D hip and shoulder frames, handle twist explicitly, and transform world bone targets into the target rig's parent-local space. The current shortest-arc direction rotation does not encode twist around a bone.
- **Occlusion and cuts:** Interpolate short missing spans using joint velocity and constrain bone lengths. Reset tracks on scene cuts or player identity changes. For multi-player footage, track identity instead of relying on `numPoses: 1`.
- **Performance:** Inference and seeking run in the main thread for portability. For long footage, move to a worker or Python/OpenCV batch pipeline, chunk results, and store model assets locally rather than relying on a CDN.

MediaPipe API reference: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js