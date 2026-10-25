// ============================================================
// Config — SINGLE SOURCE OF TRUTH for all tuning values
// Pitch dims, ball, locomotion, AI knobs, match length, skeleton
// ============================================================

export const CONFIG = {
  pitch: { length: 40, width: 25, wallHeight: 1.1, buffer: 2, goalWidth: 3, goalHeight: 2, goalDepth: 1.2 },
  ball: {
    // === REAL DATA: BALL (size-5, natural grass, 20 °C) ===
    // Circumference 68–70 cm → Ø 0.219 m → r 0.109 m; mass 410–450 g.
    radius: 0.109,          // m   (CALCULATED from 69 cm circumference)
    mass: 0.43,             // kg  (OFFICIAL 0.41–0.45)
    gravity: 9.81,          // m/s² Earth
    airDensity: 1.2,        // kg/m³ at 20 °C
    // Drag MUST be speed-dependent (drag crisis at Re ≈ 2–3×10⁵). Below ~10 m/s the ball
    // is subcritical (Cd≈0.50); above ~14 m/s it is supercritical (Cd≈0.25). A constant
    // Cd gives wrong trajectories, so the engine interpolates between these.
    dragCoefficientLow: 0.50,   // ratio, < ~10 m/s   (subcritical)
    dragCoefficientHigh: 0.25,  // ratio, > ~14 m/s   (post drag-crisis)
    dragCrisisLow: 10,          // m/s  start of transition
    dragCrisisHigh: 14,         // m/s  end of transition
    dragCoefficient: 0.30,      // ratio default (kept for the AI's analytic predictor)
    magnusLiftMax: 0.29,    // ratio peak Magnus lift coefficient  (0.23–0.29)
    magnusLiftMean: 0.25,   // ratio experimental mean
    restitution: 0.65,          // vertical COR on grass   (0.55–0.75)
    restitutionHorizontal: 0.65,// horizontal COR on grass (0.55–0.75)
    rollingResistance: 0.10,    // ratio μ on grass        (0.06–0.15)
    rollingDecel: 0.10 * 9.81,  // m/s² = μ·g ≈ 0.98       (CALCULATED)
    spinDecayAir: 0.20,     // 1/s exponential spin decay in flight
    spinDecayGround: 1.2,   // 1/s spin decay on ground contact
    groundStopEps: 0.20,    // m/s — below this the ball is at rest
    contactTimeMs: 12,      // ms  foot–ball impact duration (10–15)
    // Spin generation by action, radians/s (converted from rpm: rad/s = rpm·2π/60).
    spinShot: 350 * Math.PI / 30,      // 350 rpm ≈ 36.7 rad/s  (150–600)
    spinFreeKick: 450 * Math.PI / 30,  // 450 rpm ≈ 47.1 rad/s  (300–600)
    spinPass: 200 * Math.PI / 30,      // 200 rpm ≈ 20.9 rad/s  (50–400)
    maxSpeed: 35,           // m/s — fastest verified shots ≈ 130 km/h (≈ 36 m/s)
  },
  player: {
    // === REAL DATA: PLAYER KINEMATICS (elite male outfield) ===
    // Velocity zone cut-offs (football research standard), stored in m/s:
    walkSpeed: 2.0,         // walking  < 2.0 m/s  (< 7.2 km/h)
    jogSpeed: 3.5,          // jogging  2.0–4.0 m/s
    runSpeed: 5.0,          // running  4.0–5.5 m/s
    hsrSpeed: 5.5,          // high-speed running threshold (19.8 km/h)
    sprintThreshold: 7.0,   // sprint threshold (25.2 km/h)
    sprintSpeed: 8.75,      // max match velocity (31.5 km/h)  (7.8–10.5)
    gkSprintSpeed: 7.8,     // goalkeeper top speed
    meanMatchSpeed: 1.75,   // mean match velocity (95–110 m/min)
    accel: 5.0,             // m/s² peak acceleration  (4.0–6.5)
    decel: 6.0,             // m/s² peak deceleration  (4.5–7.0)
    hsrAccelThreshold: 3.0, // m/s² high-intensity accel/decel threshold
    turnRate: 9.5,          // rad/s body reorientation
    jumpHeight: 0.42,       // m countermovement jump (0.33–0.50)
    controlRadius: 0.75, tackleRadius: 1.35, interceptRadius: 1.0,
    maxTrapSpeed: 14,       // m/s — fastest ground ball a player can cushion dead
    // === REAL DATA: BALL SPEED BY ACTION (m/s) ===
    kickPower: {
      pass: 11,         // short ground pass  8–14 m/s (mean 11)
      longPass: 24,     // long ball/clearance 20–28 m/s (mean 24)
      through: 16,      // medium pass 14–20 m/s
      shoot: 24,        // in-match shot 14–32 m/s (mean 24 ≈ 86 km/h)
      finesse: 20,      // placed curler
      volley: 22,       // volley 55–100 km/h
      clear: 24,        // clearance
      punt: 23,         // GK punt/drop kick 18–28 m/s
      header: 15,       // header shot ≈ 55 km/h (35–75)
      corner: 21,       // corner 18–24 m/s
      throwIn: 10,      // GK/throw-in 15–25 m distance
      gkRoll: 8.5,      // GK underarm roll
    },
    staminaDrain: 0.05, staminaRegen: 0.08,
    secondHalfDecline: 0.08, // −8 % distance/HSR/sprint volume in the second half
  },
  match: { totalSeconds: 240, halves: 2, setupFreeze: 2.0, goalCelebrate: 2.2, halftimePause: 3 },
  ai: {
    // === REAL DATA: REACTION & DECISION ===
    reactionDelay: 0.28,    // s  AI decision delay, outfield (0.20–0.40)
    gkDecisionDelay: 0.35,  // s  AI decision delay, goalkeeper (0.25–0.50)
    decisionNoise: 0.12,
    maxSprint: 8.75, passError: 0.06,
    pressRadius: 9, supportOffset: 3.2,
    gkRushLine: 5.5, diveReach: 2.6, catchRadius: 1.1,
    offside: true,
    interceptHorizon: 1.25,
    teamSpacing: 2.7,
    markDistance: 9,
    defensiveStepDistance: 11,
    noveltyPenalty: 0.12,
    offsideBuffer: 0.38,
    outPlaySafetyMargin: 1.4,
    // Goalkeeper save model (seconds / metres).
    // Physical save reaction = simple RT ≈ 0.20 s (0.18–0.22). The slower 0.35 s GK
    // *decision* delay is the think gate (ai.gkDecisionDelay), a separate quantity.
    gkReactionTime: 0.2,
    gkDiveContactTime: 0.44,   // gk_dive clip: 0.8 s × contactFrame 0.55
    gkStandingReach: 0.95,     // arm reach without diving
    gkDiveExtension: 1.4,      // additional lateral reach from a full dive (≈2.35 m total)
    gkShuffleFactor: 0.3,      // fraction of sprint speed usable as set-feet lateral shuffle
    gkShuffleMax: 0.9,         // m — keepers set their feet rather than chase across goal
    gkReadError: 0.32,         // m — 1σ-ish lateral misread of a 20 m/s shot (scales with pace)
    gkTimingError: 0.16,       // s — dive mistiming scale for a 20 m/s shot (scales with pace/screen)
    gkCatchSpeed: 16,          // m/s — above this a clean contact becomes a parry
    gkSetShuffleSpeed: 2.0,    // m/s — lateral side-step while set for a shot
    gkOffBalancePenalty: 0.3,  // m of dive reach lost per m/s of lateral speed at contact
    passAimConeDegrees: 8,
  },
  tactics: {
    planInterval: 0.4,
    assignmentHysteresis: 2.0,
    targetHysteresis: 0.12,
    pivotDepth: 5.5,
    pivotHalfWidth: 3.0,
    pivotMaxAdvance: 5.0,
    outletMaxDistance: 17.5,
    runnerMaxDistance: 20,
    nearSideWidth: 8.2,
    halfSpaceWidth: 4.8,
    farSideMaxWidth: 6.0,
    runnerLead: 6.0,
    runBeyondLine: 3.2,
    keeperBuildDepth: 7,
    keeperRunnerLead: 23,
    keeperRunnerMaxDistance: 30,
    minSupportGap: 3.2,
    minSafeLane: 0.62,
    minSafeReceiverSpace: 2.0,
    pressureDistance: 3.2,
    edgeShotDistance: 15.0,
    clearShotDistance: 9.0,
    shotLaneThreshold: 0.72,
    shotMinOpening: 0.16,
    returnPassWindow: 4.0,
    returnPassPenalty: 0.24,
    // ---- Attacking intent -------------------------------------------------
    // Possession won from the opponent opens a transition window in which passes
    // and carries are scored for progression first (see CONFIG.tactics.phaseWeights).
    transitionSeconds: 5.0,
    // Off-ball run recognition. A run is only "triggered" when the carrier has the
    // ball, is facing forward and is not under immediate pressure — otherwise the
    // support players offer a short check instead of sprinting away.
    runTriggerFacingDot: 0.25,
    runTriggerTimeOnBall: 0.35,
    runTriggerForwardLane: 0.45,
    runCommitSeconds: 1.25,     // a started run is held this long before re-planning
    runMinTravel: 3.2,          // m — a run target must be ahead of the player
    spaceScanDepth: 7.0,        // m — how far ahead a player scans for vacant space
    spaceScanHalfWidth: 4.0,    // m
    spinLead: 7.5,              // m — depth of the run into the space behind the line
    driveLead: 8.0,             // m — depth of a driving run into midfield space
    checkDepth: 4.5,            // m — how short a player drops to offer an outlet
    shotPartialLane: 0.28,      // a partially blocked lane is still a shot
    phaseWeights: {
      build: { gain: 0.26, safety: 0.34, hazard: 0.20 },
      progress: { gain: 0.34, safety: 0.28, hazard: 0.20 },
      finish: { gain: 0.26, safety: 0.22, hazard: 0.18 },
      transition: { gain: 0.52, safety: 0.16, hazard: 0.26 },
      recycle: { gain: 0.18, safety: 0.40, hazard: 0.22 },
    } as Record<string, { gain: number; safety: number; hazard: number }>,
    runnerRolePreference: { FWD: 0, MID: 1.5, DEF: 4, GK: 50 } as Record<string, number>,
    pivotRolePreference: { DEF: 0, MID: 0.8, FWD: 4, GK: 50 } as Record<string, number>,
  },
  anim: {
    crossfade: 0.12, actionCrossfade: 0.07,
    footSlideThreshold: 0.09, // m per step tolerance
    timeScaleMin: 0.1, timeScaleMax: 2.0,
  },
  net: { possessionsToWin: 1 },
} as const;

// ============================================================
// REAL_DATA — recommended engine defaults with provenance.
// Scale: 1 unit = 1 m, 1 tick = 1/60 s, g = 9.81 m/s², ρ = 1.2 kg/m³, grass.
// The engine (CONFIG above) is driven from these. Values the simulation does not
// yet consume are retained here as the normative reference and for analytics/UI.
// [mean, min, max] with the source tag used in the dataset.
// ============================================================
export const REAL_DATA = {
  ball: {
    massKg: [0.43, 0.41, 0.45], radiusM: [0.109, 0.108, 0.111],
    circumferenceCm: [69, 68, 70], diameterM: [0.219, 0.216, 0.223],
    pressureAtm: [0.85, 0.6, 1.1], reboundDropCm: [145, 135, 155],
    dragLow: [0.50, 0.40, 0.55], dragHigh: [0.25, 0.20, 0.30], dragDefault: [0.30, 0.20, 0.50],
    liftCoefficient: [0.25, 0.23, 0.29],
    restitutionGrassV: [0.65, 0.55, 0.75], restitutionGrassH: [0.65, 0.55, 0.75],
    rollingResistance: [0.10, 0.06, 0.15], rollingDecelMs2: [1.0, 0.6, 1.5],
    reynoldsRange: [300000, 70000, 490000], ballisticNumberM: [47, 39, 58],
    terminalVelocityMs: [24, 19, 28], contactTimeMs: [12, 10, 15],
    spinShotRpm: [350, 150, 600], spinFreeKickRpm: [450, 300, 600], spinPassRpm: [200, 50, 400],
    footBallVelocityRatio: [1.4, 1.06, 1.65], footVelocityMs: [22, 18, 25],
  },
  ballSpeedKmh: {
    inMatchShot: [86, 50, 115], tapIn: [45, 25, 65], volley: [80, 55, 100], header: [55, 35, 75],
    shortPass: [40, 29, 50], mediumPass: [61, 50, 72], longBall: [86, 72, 101],
    cross: [79, 54, 79], corner: [79, 65, 86], freeKick: [90, 70, 110],
    penalty: [83, 60, 105], gkPunt: [83, 65, 101], gkThrow: [40, 25, 55],
  },
  player: {
    heightM: [1.82, 1.72, 1.92], massKg: [74, 65, 88], bodyFatPct: [10.5, 8, 13],
    gkHeightM: [1.90, 1.85, 1.98], cbHeightM: [1.87, 1.82, 1.94], wingerHeightM: [1.76, 1.70, 1.82],
    maxVelocityMs: [8.75, 7.8, 10.5], peakAccelMs2: [5.0, 4.0, 6.5], peakDecelMs2: [6.0, 4.5, 7.0],
    hsrThresholdKmh: [19.8, 19.8, 19.8], sprintThresholdKmh: [25.2, 25.2, 25.2],
    meanMatchVelocityMs: [1.75, 1.6, 1.9], jumpHeightM: [0.42, 0.33, 0.50],
    sprint20mS: [2.90, 2.75, 3.05], timeToMaxVelS: [5.0, 4.0, 6.0], distToMaxVelM: [30, 20, 40],
  },
  zonesKmh: { walk: [0, 7.2], jog: [7.2, 14.4], run: [14.4, 19.8], hsr: [19.8, 25.2], sprint: [25.2, 38] },
  reaction: {
    simpleRtMs: [200, 180, 220], choiceRtMs: [255, 250, 260],
    gkDecisionMs: [350, 250, 450], gkTotalResponseMs: [450, 300, 600],
    aiDelayOutfieldS: [0.28, 0.20, 0.40], aiDelayGkS: [0.35, 0.25, 0.50],
    timeBeforePressureS: [1.8, 0.8, 3.0], scanIntervalS: [3.0, 2.0, 4.0],
    ballContactsPerMatch: [60, 30, 95], touchesPerPossession: [2.3, 1, 4],
  },
  match: {
    sprintsPerPlayer: [25, 10, 45], accelEvents: [110, 60, 160], decelEvents: [110, 60, 160],
    changesOfDirection: [480, 412, 556], activityChangesPerMatch: [1400, 1200, 1600],
    actionDensityS: [4, 3, 6], totalDistanceM: [11000, 9000, 14000], secondHalfDeclinePct: [-8, -15, 0],
    teamShotsPerMatch: [12.5, 6, 22], shotToGoalPct: [11, 4, 25], penaltyConversionPct: [78, 70, 85],
    cornerConversionPct: [2.8, 1.3, 4], possessionMeanPct: [50, 30, 70], passSuccessPct: [82, 70, 90],
    dribbleSuccessPct: [55, 40, 70], aerialDuelSuccessPct: [50, 40, 60], gkSaveRatePct: [72, 60, 80],
    foulsPerTeam: [11, 6, 18], yellowCardsPerMatch: [3.8, 2, 6],
  },
  // Full-size reference (OFFICIAL). The playable arena (CONFIG.pitch) is small-sided
  // 5-a-side by design; these are documented so the real geometry is on record.
  fullPitch: { lengthM: [105, 100, 110], widthM: [68, 64, 75], goalWidthM: 7.32, goalHeightM: 2.44 },
} as const;

// ------------------------------------------------------------
// SKELETON CONTRACT (canonical humanoid, metres, Y-up, +Z fwd)
// Bone names are normative. Both mesh families bind losslessly.
// Rest pose: T-pose-ish relaxed (arms ~12° down), feet flat.
// ------------------------------------------------------------
export const SKELETON_CONTRACT = {
  version: "1.0.0",
  units: "meters",
  up: "+Y",
  forward: "+Z",
  bones: [
    { name: "hips", parent: null, offset: [0, 0.96, 0], length: 0 },
    { name: "spine", parent: "hips", offset: [0, 0.12, 0], length: 0.16 },
    { name: "chest", parent: "spine", offset: [0, 0.16, 0], length: 0.22 },
    { name: "neck", parent: "chest", offset: [0, 0.24, 0], length: 0.09 },
    { name: "head", parent: "neck", offset: [0, 0.1, 0], length: 0.22 },
    { name: "shoulder.L", parent: "chest", offset: [-0.2, 0.18, 0], length: 0.08 },
    { name: "upperArm.L", parent: "shoulder.L", offset: [-0.07, -0.02, 0], length: 0.28 },
    { name: "lowerArm.L", parent: "upperArm.L", offset: [0, -0.28, 0], length: 0.26 },
    { name: "hand.L", parent: "lowerArm.L", offset: [0, -0.26, 0], length: 0.16 },
    { name: "shoulder.R", parent: "chest", offset: [0.2, 0.18, 0], length: 0.08 },
    { name: "upperArm.R", parent: "shoulder.R", offset: [0.07, -0.02, 0], length: 0.28 },
    { name: "lowerArm.R", parent: "upperArm.R", offset: [0, -0.28, 0], length: 0.26 },
    { name: "hand.R", parent: "lowerArm.R", offset: [0, -0.26, 0], length: 0.16 },
    { name: "upperLeg.L", parent: "hips", offset: [-0.1, -0.04, 0], length: 0.42 },
    { name: "lowerLeg.L", parent: "upperLeg.L", offset: [0, -0.42, 0], length: 0.43 },
    { name: "foot.L", parent: "lowerLeg.L", offset: [0, -0.43, 0.02], length: 0.22 },
    { name: "toe.L", parent: "foot.L", offset: [0, -0.03, 0.14], length: 0.08 },
    { name: "upperLeg.R", parent: "hips", offset: [0.1, -0.04, 0], length: 0.42 },
    { name: "lowerLeg.R", parent: "upperLeg.R", offset: [0, -0.42, 0], length: 0.43 },
    { name: "foot.R", parent: "lowerLeg.R", offset: [0, -0.43, 0.02], length: 0.22 },
    { name: "toe.R", parent: "foot.R", offset: [0, -0.03, 0.14], length: 0.08 },
  ],
  validation: {
    rule: "every clip must bind every bone; every mesh variant must expose every bone; automated check fails build otherwise",
  },
} as const;

export type BoneName = (typeof SKELETON_CONTRACT.bones)[number]["name"];

// ------------------------------------------------------------
// ANIMATION CATALOGUE SCHEMA (data-driven)
// Maps clipId -> metadata. Procedural clips below act as the
// mocap-library proxy: same IDs/events/blend contracts.
// ------------------------------------------------------------
export type ClipCategory =
  | "locomotion" | "turn" | "pass" | "shoot" | "header" | "tackle"
  | "gk" | "restart" | "celebrate" | "recover" | "control" | "idle";

export interface ClipMeta {
  id: string;
  category: ClipCategory;
  loop: boolean;
  rootMotion: boolean;         // ON for tackles/dives/turns, OFF for locomotion
  duration: number;            // seconds @1x
  speedBand?: [number, number];// m/s for locomotion
  contactFrame?: number;       // normalized 0..1 where ball_contact fires
  interruptible: [number, number]; // normalized window where cancel allowed
  priority: number;            // higher wins crossfade
  tags: string[];
  description: string;
}

export const ANIMATION_CATALOGUE: ClipMeta[] = [
  { id: "idle", category: "idle", loop: true, rootMotion: false, duration: 2.4, interruptible: [0, 1], priority: 0, tags: ["in-place", "breath"], description: "Relaxed idle, weight shift + breath" },
  { id: "walk", category: "locomotion", loop: true, rootMotion: false, duration: 1.1, speedBand: [0.1, 2.8], interruptible: [0, 1], priority: 1, tags: ["in-place", "blend2D"], description: "Walk cycle" },
  { id: "jog", category: "locomotion", loop: true, rootMotion: false, duration: 0.82, speedBand: [2.8, 5.2], interruptible: [0, 1], priority: 1, tags: ["in-place", "blend2D"], description: "Jog cycle" },
  { id: "sprint", category: "locomotion", loop: true, rootMotion: false, duration: 0.62, speedBand: [5.2, 8.0], interruptible: [0, 1], priority: 1, tags: ["in-place", "blend2D", "lean"], description: "Sprint, aggressive lean" },
  { id: "turn_left", category: "turn", loop: false, rootMotion: true, duration: 0.42, interruptible: [0.6, 1], priority: 3, tags: ["root-motion", "plant"], description: "Plant & turn left 90°" },
  { id: "turn_right", category: "turn", loop: false, rootMotion: true, duration: 0.42, interruptible: [0.6, 1], priority: 3, tags: ["root-motion", "plant"], description: "Plant & turn right 90°" },
  { id: "turn_180", category: "turn", loop: false, rootMotion: true, duration: 0.55, interruptible: [0.65, 1], priority: 3, tags: ["root-motion", "plant"], description: "180 pivot" },
  { id: "pass_short", category: "pass", loop: false, rootMotion: false, duration: 0.45, contactFrame: 0.52, interruptible: [0, 0.35], priority: 6, tags: ["ball_contact", "right-foot"], description: "Inside-foot pass" },
  { id: "pass_long", category: "pass", loop: false, rootMotion: false, duration: 0.62, contactFrame: 0.55, interruptible: [0, 0.3], priority: 6, tags: ["ball_contact", "right-foot"], description: "Driven long pass" },
  { id: "pass_through", category: "pass", loop: false, rootMotion: false, duration: 0.58, contactFrame: 0.5, interruptible: [0, 0.32], priority: 6, tags: ["ball_contact", "through"], description: "Through ball" },
  { id: "shoot_normal", category: "shoot", loop: false, rootMotion: false, duration: 0.7, contactFrame: 0.55, interruptible: [0, 0.28], priority: 7, tags: ["ball_contact", "laces"], description: "Laces shot" },
  { id: "shoot_finesse", category: "shoot", loop: false, rootMotion: false, duration: 0.74, contactFrame: 0.58, interruptible: [0, 0.28], priority: 7, tags: ["ball_contact", "curl"], description: "Placed curler" },
  { id: "shoot_volley", category: "shoot", loop: false, rootMotion: false, duration: 0.66, contactFrame: 0.5, interruptible: [0, 0.25], priority: 7, tags: ["ball_contact", "volley"], description: "Volley" },
  { id: "header", category: "header", loop: false, rootMotion: false, duration: 0.52, contactFrame: 0.48, interruptible: [0, 0.3], priority: 6, tags: ["ball_contact", "head"], description: "Jumping header" },
  { id: "tackle_stand", category: "tackle", loop: false, rootMotion: true, duration: 0.6, contactFrame: 0.45, interruptible: [0, 0.25], priority: 8, tags: ["ball_contact", "root-motion"], description: "Standing lunge" },
  { id: "tackle_slide", category: "tackle", loop: false, rootMotion: true, duration: 0.95, contactFrame: 0.5, interruptible: [0, 0.2], priority: 8, tags: ["ball_contact", "root-motion", "ground"], description: "Slide tackle, 2.5m root" },
  { id: "intercept", category: "control", loop: false, rootMotion: false, duration: 0.4, contactFrame: 0.5, interruptible: [0, 0.4], priority: 5, tags: ["ball_contact"], description: "Reach interception" },
  { id: "shield", category: "control", loop: true, rootMotion: false, duration: 1.2, interruptible: [0, 1], priority: 2, tags: ["upper-body", "hold"], description: "Arm-out shield loop" },
  { id: "first_touch", category: "control", loop: false, rootMotion: false, duration: 0.5, contactFrame: 0.45, interruptible: [0, 0.5], priority: 5, tags: ["ball_contact", "cushion"], description: "Cushioned trap" },
  { id: "dribble_touch", category: "control", loop: false, rootMotion: false, duration: 0.32, contactFrame: 0.5, interruptible: [0, 0.6], priority: 4, tags: ["ball_contact", "touch"], description: "Push touch while running" },
  { id: "gk_dive_L", category: "gk", loop: false, rootMotion: true, duration: 0.8, contactFrame: 0.55, interruptible: [0, 0.15], priority: 9, tags: ["root-motion", "dive"], description: "GK dive left" },
  { id: "gk_dive_R", category: "gk", loop: false, rootMotion: true, duration: 0.8, contactFrame: 0.55, interruptible: [0, 0.15], priority: 9, tags: ["root-motion", "dive"], description: "GK dive right" },
  { id: "gk_catch", category: "gk", loop: false, rootMotion: false, duration: 0.5, contactFrame: 0.5, interruptible: [0, 0.3], priority: 9, tags: ["ball_contact", "hands"], description: "Two-hand catch" },
  { id: "gk_parry", category: "gk", loop: false, rootMotion: false, duration: 0.48, contactFrame: 0.5, interruptible: [0, 0.3], priority: 9, tags: ["ball_contact", "hands"], description: "One-hand parry" },
  { id: "gk_punt", category: "gk", loop: false, rootMotion: false, duration: 0.85, contactFrame: 0.55, interruptible: [0, 0.25], priority: 7, tags: ["ball_contact", "punt"], description: "GK long punt" },
  { id: "gk_roll", category: "gk", loop: false, rootMotion: false, duration: 0.62, contactFrame: 0.56, interruptible: [0, 0.32], priority: 7, tags: ["ball_contact", "roll", "distribution"], description: "GK underarm roll" },
  { id: "throw_in", category: "restart", loop: false, rootMotion: false, duration: 0.9, contactFrame: 0.55, interruptible: [0, 0.3], priority: 6, tags: ["ball_contact", "hands", "restart"], description: "Overhead throw" },
  { id: "corner_kick", category: "restart", loop: false, rootMotion: false, duration: 0.78, contactFrame: 0.56, interruptible: [0, 0.3], priority: 7, tags: ["ball_contact", "cross", "restart"], description: "Inswinging corner cross" },
  { id: "celebrate", category: "celebrate", loop: false, rootMotion: false, duration: 2.2, interruptible: [0.8, 1], priority: 10, tags: ["one-shot"], description: "Knee-slide arms-up celebration" },
  { id: "stumble", category: "recover", loop: false, rootMotion: true, duration: 0.55, interruptible: [0.7, 1], priority: 8, tags: ["root-motion", "hit"], description: "Shoulder-charge stumble" },
  { id: "get_up", category: "recover", loop: false, rootMotion: false, duration: 1.0, interruptible: [0.8, 1], priority: 8, tags: ["ground"], description: "Prone to stand" },
  { id: "jockey", category: "locomotion", loop: true, rootMotion: false, duration: 0.9, speedBand: [0, 2.0], interruptible: [0, 1], priority: 2, tags: ["in-place", "defensive"], description: "Side-shuffle jockey" },
];

export const FORMATIONS: Record<string, { role: string; home: [number, number] }[]> = {
  RED: [
    { role: "GK", home: [-18.2, 0] },
    { role: "DEF", home: [-9, -5.5] },
    { role: "DEF", home: [-9, 5.5] },
    { role: "MID", home: [-2.5, 0] },
    { role: "FWD", home: [4.5, 0] },
  ],
  BLUE: [
    { role: "GK", home: [18.2, 0] },
    { role: "DEF", home: [9, 5.5] },
    { role: "DEF", home: [9, -5.5] },
    { role: "MID", home: [2.5, 0] },
    { role: "FWD", home: [-4.5, 0] },
  ],
};

export type RuleEventType =
  | "KICKOFF" | "WHISTLE" | "GOAL" | "THROW_IN" | "CORNER" | "GOAL_KICK"
  | "FREE_KICK" | "PENALTY" | "FOUL" | "POSSESSION" | "SAVE" | "HALF_TIME"
  | "FULL_TIME" | "CELEBRATION_END" | "RESTART_READY" | "OFFSIDE";

export interface RuleEvent { id: number; t: number; type: RuleEventType; detail: string; team?: number; }
