// The contact frame: what the ball does when an action's strike/reach lands.
// One dispatch entry per action family (passes, shots, duels, keeper play,
// set-piece deliveries) plus the restart bookkeeping that follows it.
import * as THREE from "three";
import { CONFIG } from "../config";
import { passAimDot, passAimIsValid } from "../passing";
import { SeededRandom, tieBreakHash } from "../random";
import {
  ACTION_PROFILES, chooseProfile, profileStream, resolveStrike,
  type ActionProfile, type ResolvedStrike,
} from "../physics/actionProfiles";
import { startAction } from "./actions";
import { aiEvent } from "./debug";
import { captureOffsideAtKick, flagOffside } from "./offside";
import { laneOpenness, planNamedPass, recordPass } from "./passPlanning";
import { advantageAvailable, isOffPitch, issueCards } from "./referee";
import { setHumanPlayer } from "./roster";
import { releaseRestartToTaker } from "./restarts";
import {
  evaluateTackle, isTackleAction, spillDirection, tackleReach,
  type TackleOutcome,
} from "./tackles";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/** The striker's touch: the ball leaves their feet and they own the last touch. */
function releaseToKick(e: MatchHost, p: EnginePlayer) {
  e.ball.release();
  e.ball.lastTouch = p.idx;
  e.ball.lastTouchTeam = p.team;
}

/**
 * Pull a release point inside the field of play.
 *
 * A throw-in taker stands lawfully *outside* the touchline (z = ±(W/2 + 0.3)), so
 * releasing the ball at his own position handed `outGoalCheck` a ball 0.3 m beyond
 * the line on the very frame the throw was taken: `|z| > W/2 + r` is already true at
 * rest. Every throw-in was therefore awarded straight back to the opponent from the
 * same spot, and the two sides ping-ponged throw-ins until the final whistle without
 * the ball ever entering the pitch. The ball leaves the hands above the line, but its
 * flight starts inside it.
 */
export function clampReleaseInsidePitch(pos: THREE.Vector3, margin = 0.03): THREE.Vector3 {
  const hx = Math.max(0.2, CONFIG.pitch.length / 2 - CONFIG.ball.radius - margin);
  const hz = Math.max(0.2, CONFIG.pitch.width / 2 - CONFIG.ball.radius - margin);
  return pos.set(
    THREE.MathUtils.clamp(pos.x, -hx, hx),
    pos.y,
    THREE.MathUtils.clamp(pos.z, -hz, hz),
  );
}

/**
 * Resolve the named profile that strikes this ball, using a per-kick deterministic
 * stream so sampling physics never shifts the AI's random draws.
 */
function strikeProfile(
  e: MatchHost, p: EnginePlayer, profile: ActionProfile, key: string,
  opts: { distance: number; accuracy?: number; curveSide?: number; speedScale?: number; directSpeed?: boolean; intensity?: number; angleDeg?: number },
): ResolvedStrike {
  const rng = new SeededRandom(profileStream(e.matchSeed, p.idx, p.runSerial, key));
  return resolveStrike(profile, {
    rng,
    distance: opts.distance,
    startHeight: e.ball.pos.y,
    accuracy: opts.accuracy,
    curveSide: opts.curveSide,
    speedScale: opts.speedScale,
    directSpeed: opts.directSpeed,
    intensity: opts.intensity,
    angleDeg: opts.angleDeg,
    surface: e.ball.surface,
  });
}

/** World position of the limb the action strikes with (foot / head / hand). */
export function footWorld(p: EnginePlayer, which = "R"): THREE.Vector3 {
  const b = p.rig.skeleton.bones.get(which === "head" ? "head" : which === "hands" ? "hand.R" : `foot.${which}`);
  if (b) {
    const v = new THREE.Vector3();
    b.getWorldPosition(v);
    return v;
  }
  // A missing bone must not turn every contact into a false alignment at (0,0,0).
  // Fall back to the player's own striking point in world space.
  const fx = Math.cos(p.facing), fz = -Math.sin(p.facing);
  return new THREE.Vector3(
    p.pos.x + fx * 0.45,
    which === "head" ? 1.65 : which === "hands" ? 1.15 : 0.12,
    p.pos.z + fz * 0.45,
  );
}

/** Resolve an action's contact frame against the ball, then close the restart out. */
export function onContact(e: MatchHost, p: EnginePlayer, action: string) {
  // A player serving a blue card is off the pitch: his clip may still be playing
  // out, but its contact frame may not touch the ball, the restart or the duel state.
  if (isOffPitch(e, p)) { p.pendingKick = null; p.tackleChallenge = null; return; }
  const pk = p.pendingKick;
  const activeRestart = e.rules.pendingRestart;
  let ballReleasedByAction = false;
  let tackleOutcome: TackleOutcome | null = null;
  let tackleDetail = "";
  e.contactTotal++;
  // Which boot strikes it: the one the body angle chose when the kick was wound up
  // (see startAction). The old hard-coded right foot made every contact of a
  // left-angled strike land on the wrong side of the body.
  const foot = footWorld(p, action === "header" ? "head" : action === "throw_in" || action.startsWith("gk_") ? "hands" : p.strikeFoot);
  const dist = foot.distanceTo(e.ball.pos);
  const tol = action === "header" ? 0.55 : action.startsWith("gk_") ? 0.8 : 0.42;
  if (dist < tol) e.contactAligned++;
  // IK snap pass: nudge foot toward ball predicted pos
  p.anim.ballContactSnap(e.ball.pos, foot);

  const ownerIsMe = e.ball.possessedBy === p.idx;
  const dirTo = (t: THREE.Vector3) => t.clone().sub(p.pos).setY(0).normalize();

  if (e.offsideTeam === p.team && e.offsideCandidates.has(p.idx)
    && ["first_touch", "intercept", "header", "shoot_volley"].includes(action) && flagOffside(e, p)) {
    p.pendingKick = null;
    return;
  }

  const kp = CONFIG.player.kickPower;
  switch (action) {
    case "pass_short": case "pass_long": case "pass_through": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      if (pk.forced) {
        // Forced clearance from a keeper playing a back-pass: the hold limit applies
        // to his feet too, so this one is struck even if no receiver plan exists.
        const aim = pk.target.clone().sub(e.ball.pos).setY(0);
        if (aim.lengthSq() < 1e-4) aim.set(e.ai.attackSign(p.team, e.rules.half), 0, 0);
        releaseToKick(e, p);
        captureOffsideAtKick(e, p, activeRestart?.kind);
        const boot = strikeProfile(e, p, ACTION_PROFILES.gk_punt, `forced-punt:${activeRestart?.id ?? 0}`, {
          distance: Math.max(20, aim.length()),
          accuracy: p.attributes.goalkeeping.kicking,
          directSpeed: true,
          intensity: 0.85,
        });
        e.ball.strike(aim.normalize(), boot);
        aiEvent(e, `STRIKE ${ACTION_PROFILES.gk_punt.name} (forced) · ${boot.speed.toFixed(1)} m/s`);
        ballReleasedByAction = true;
        if (!activeRestart) e.openPlayKickCount++;
        break;
      }
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) {
        // A clearance needs no receiver: a defender under pressure in his own third
        // hoists the ball away instead of being dispossessed trying to thread a short
        // ball out of the swarm. `passTo === undefined` is what marks the decision as a
        // clearance — every real pass names a receiver — so a cancelled named pass keeps
        // its old behaviour.
        const clearanceGoal = e.ai.ownGoal(p.team, e.rules.half);
        const clearanceDeep = (p.pos.x - clearanceGoal.x) * e.ai.attackSign(p.team, e.rules.half)
          < CONFIG.pitch.length * 0.35;
        if (action === "pass_long" && clearanceDeep && pk?.target && pk.passTo === undefined) {
          releaseToKick(e, p);
          // Hoofed away: a lofted clearance that clears the bodies in front of him
          // rather than rolling into them.
          const clear = strikeProfile(e, p, ACTION_PROFILES.clearance, `clearance:${activeRestart?.id ?? 0}`, {
            distance: Math.max(10, p.pos.distanceTo(pk.target)), accuracy: 45, directSpeed: true, intensity: 0.85,
          });
          e.ball.strike(dirTo(pk.target), clear);
          aiEvent(e, `STRIKE ${ACTION_PROFILES.clearance.name} · ${clear.speed.toFixed(1)} m/s · ${clear.angleDeg.toFixed(1)}°`);
          ballReleasedByAction = true;
          if (!activeRestart) e.openPlayKickCount++;
          e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} clearance by #${p.idx} ${p.role}`, p.team);
          break;
        }
        p.decisionReason = "PASS CANCELLED · no valid same-team onside receiver in range";
        e.rules.emit("POSSESSION", `${action} cancelled: no valid named receiver`, p.team);
        break;
      }
      captureOffsideAtKick(e, p, activeRestart?.kind);
      releaseToKick(e, p);
      const passRating = p.role === "GK" ? p.attributes.goalkeeping.kicking
        : activeRestart?.kind === "free_kick" ? p.attributes.passing.freeKick
          : action === "pass_long" ? p.attributes.passing.longGroundPassing : p.attributes.passing.shortGroundPassing;
      const passError = CONFIG.ai.passError * (75 - passRating) / 75
        * (tieBreakHash(e.matchSeed, p.idx, p.runSerial, `pass-accuracy:${action}:${pk?.passTo ?? -1}`) * 2 - 1);
      const passDirection = plan.target.clone().sub(e.ball.pos).setY(0).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), passError);
      const passStrike = plan.strike ?? strikeProfile(e, p, ACTION_PROFILES[plan.profile ?? "pass_short"], `pass:${action}`, {
        distance: plan.distance, accuracy: passRating, curveSide: p.style.finesseSide,
      });
      e.ball.strike(passDirection, { ...passStrike, speed: plan.power, loft: plan.loft });
      aiEvent(e, `STRIKE ${passStrike.profile?.name ?? action} · ${plan.power.toFixed(1)} m/s · ${(plan.loft * 57.2958).toFixed(1)}° · ${(passStrike.spinRpm ?? 0).toFixed(0)} rpm`);
      const launchDot = passAimDot(e.ball.pos, e.ball.vel, plan.target);
      if (!passAimIsValid(launchDot, CONFIG.ai.passAimConeDegrees)) {
        e.ball.vel.set(0, 0, 0); e.ball.possess(p.idx, p.team);
        p.decisionReason = "PASS CANCELLED · launch outside receiver cone";
        break;
      }
      ballReleasedByAction = true;
      recordPass(e, p, action, { ...plan, aimDot: launchDot });
      if (!activeRestart) e.openPlayKickCount++;
      e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${action} → #${plan.receiver.idx} ${plan.receiver.role}`, p.team);
      if (p.isHuman && !e.spectator) setHumanPlayer(e, plan.receiver);
      break;
    }
    case "shoot_normal": case "shoot_finesse": case "shoot_volley": {
      if (!ownerIsMe && !(action === "shoot_volley" && e.ball.possessedBy === null && p.pos.distanceTo(e.ball.pos) < 1.4)) break;
      const tgt = pk?.target ?? e.ai.goalPos(p.team, e.rules.half);
      const power = pk?.power ?? (action === "shoot_normal" ? kp.shoot * (0.5 + p.attributes.shooting.shotPower / 150)
        : action === "shoot_finesse" ? kp.finesse * (0.5 + p.attributes.shooting.shotPower / 150)
          : kp.volley * (0.5 + p.attributes.shooting.volleys / 150));
      captureOffsideAtKick(e, p, activeRestart?.kind);
      releaseToKick(e, p);
      const shotRating = activeRestart?.kind === "penalty" ? p.attributes.shooting.penalties
        : activeRestart?.kind === "free_kick" ? p.attributes.passing.freeKick
          : action === "shoot_volley" ? p.attributes.shooting.volleys
            : p.pos.distanceTo(tgt) > CONFIG.tactics.clearShotDistance ? p.attributes.shooting.longShots : p.attributes.shooting.finishing;
      // Aiming error grows with the range it has to cover. The old term was
      // `passError * (75 - rating) / 75`, which is range-independent and *shrinks* for
      // a good finisher: an 80-rated forward put a 13–15 m drive inside half a degree,
      // so every long shot was on target and the far corner was a free goal. Distance
      // is now part of the error, and the finisher's rating scales it down rather than
      // inverting it.
      const shotSpread = (CONFIG.tactics.shotSpreadBase + p.pos.distanceTo(tgt) * CONFIG.tactics.shotSpreadPerMetre)
        * THREE.MathUtils.clamp(1.45 - shotRating / 100, 0.55, 1.6);
      const shotError = shotSpread
        * (tieBreakHash(e.matchSeed, p.idx, p.runSerial, `shot-accuracy:${action}:${activeRestart?.kind ?? "open"}`) * 2 - 1);
      const shotDirection = dirTo(tgt).applyAxisAngle(new THREE.Vector3(0, 1, 0), shotError);
      // Profile by situation, not by action name: a blocked lane gets the dipping
      // topspin ball, a clean one the low driven strike, a 1v1 the chip.
      const lane = laneOpenness(e.ball.pos, tgt, e.players.filter((o) => o.team !== p.team));
      const shotDistance = p.pos.distanceTo(tgt);
      const choiceRng = new SeededRandom(profileStream(e.matchSeed, p.idx, p.runSerial, `shot-choice:${action}`));
      // A free kick is struck as a free kick: curled around the wall when the lane is
      // blocked, a knuckleball when the range is long and the wall is set.
      const isFreeKick = activeRestart?.kind === "free_kick";
      // A penalty is a driven strike at a corner of the goal, never a placed/chipped
      // ball: the generic shot chooser picked `shot_chip` on ~35 % of penalties
      // (distance < 11 m), and a chip launched at 25–40° from 4.2 m clears the 2 m
      // crossbar — so a third of all penalties were skied from the spot.
      const isPenalty = activeRestart?.kind === "penalty";
      const shotChoice = isPenalty
        ? ACTION_PROFILES.shot_low_driven
        : chooseProfile(
        isFreeKick
          ? { family: "free_kick" }
          : { family: "shot", action: action === "shoot_volley" ? "shoot_volley" : action === "shoot_finesse" ? "shoot_finesse" : "shoot_normal" },
        {
          rng: choiceRng,
          distance: shotDistance,
          lane,
          side: (Math.sign(tgt.z) || 0) as -1 | 0 | 1,
          inBox: Math.abs(p.pos.x - e.ai.goalPos(p.team, e.rules.half).x) < 5.5 && Math.abs(p.pos.z) < 6.2,
          airborne: action === "shoot_volley",
        },
      );
      const shotStrike = strikeProfile(e, p, shotChoice, `shot:${action}:${activeRestart?.id ?? 0}`, {
        distance: shotDistance,
        accuracy: shotRating,
        curveSide: p.style.finesseSide,
        speedScale: 0.55 + (action === "shoot_volley" ? p.attributes.shooting.volleys : p.attributes.shooting.shotPower) / 150,
        directSpeed: true,
        intensity: THREE.MathUtils.clamp(power / Math.max(1, CONFIG.player.kickPower.shoot), 0.35, 1),
      });
      e.ball.strike(shotDirection, shotStrike);
      aiEvent(e, `STRIKE ${shotChoice.name} · ${shotStrike.speed.toFixed(1)} m/s · ${shotStrike.angleDeg.toFixed(1)}° · ${shotStrike.spinRpm.toFixed(0)} rpm`);
      e.tacticalStats.shots++;
      ballReleasedByAction = true;
      if (!activeRestart) e.openPlayKickCount++;
      e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} SHOOT (${action})`, p.team);
      break;
    }
    case "header": {
      if (p.pos.distanceTo(e.ball.pos) > 1.6) break;
      const tgt = pk?.target ?? e.ai.goalPos(p.team, e.rules.half);
      captureOffsideAtKick(e, p, activeRestart?.kind);
      releaseToKick(e, p);
      const head = strikeProfile(e, p, ACTION_PROFILES.header_attacking, `header:${activeRestart?.id ?? 0}`, {
        distance: p.pos.distanceTo(tgt),
        accuracy: p.attributes.shooting.heading,
        speedScale: 0.6 + p.attributes.shooting.heading / 150,
        directSpeed: true,
        intensity: 0.7,
      });
      e.ball.strike(dirTo(tgt), head);
      aiEvent(e, `STRIKE ${head.profile.name} · ${head.speed.toFixed(1)} m/s · ${head.angleDeg.toFixed(1)}°`);
      ballReleasedByAction = true;
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "tackle_stand": case "tackle_slide": {
      if (!isTackleAction(action)) break;
      const carrierIdx = e.ball.possessedBy;
      const carrier = carrierIdx !== null ? e.players[carrierIdx] : null;
      const quality = evaluateTackle(e, p, action);
      const stats = e.tacticalStats;
      stats.tacklesAttempted++;
      tackleDetail = quality.reason;
      // Recovery was armed when the challenge started (`beginTackle`); a foul costs
      // extra on top. Re-arming the full duration here would double the window the
      // duel state machine documents as starting with the attempt.
      if (quality.outcome === "foul") p.tackleRecoveryT = Math.max(p.tackleRecoveryT, 0.45);

      if (carrierIdx === null && quality.ballDist < tackleReach(action)
        && quality.score >= CONFIG.tackle.spillScore
        // Re-trap guard: the striker cannot instantly collect his own fresh kick —
        // the ball is still glued at his feet, so a loose-ball claim right after a
        // strike must not grant possession. A poor challenge falls through to a miss.
        && !(p.idx === e.ball.kickedBy && e.ball.kickAge < 0.45)) {
        // Loose-ball challenge: a high-quality poke may still claim it, but a
        // poor challenge never turns into free possession.
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        p.tackleProtectionT = CONFIG.tackle.possessionProtection;
        e.offsideCandidates.clear(); e.offsideTeam = null;
        tackleOutcome = "clean";
        stats.tacklesWon++;
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} claims loose ball (${action})`, p.team);
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} claims loose ball (${action})`, p.team);
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      } else if (quality.outcome === "clean" && carrier) {
        // Ball-first, front/side-on and on time: take possession, then protect
        // it briefly so the dispossessed player cannot instantly win it back.
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        p.tackleProtectionT = CONFIG.tackle.possessionProtection;
        e.offsideCandidates.clear(); e.offsideTeam = null;
        tackleOutcome = "clean";
        stats.tacklesWon++;
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} wins tackle (${action}) · q ${quality.score.toFixed(2)}`, p.team);
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} wins tackle (${action})`, p.team);
        // Resilience: the mental recovery after losing the ball — the body follows.
        carrier.stumbleT = 0.75 * THREE.MathUtils.clamp(
          1.35 - carrier.attributes.mentality.resilience / 150, 0.6, 1.2);
        startAction(e, carrier, "stumble");
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      } else if (quality.outcome === "spill" && carrier) {
        // A half-won challenge knocks the ball into neutral space. Neither
        // duellist gets it glued to their feet; the re-trap guard prevents the
        // challenger from collecting his own touch on the very next frame.
        const dir = spillDirection(e, p, carrier);
        releaseToKick(e, p);
        e.ball.pos.add(new THREE.Vector3(dir.x * CONFIG.tackle.spillDistance, 0, dir.z * CONFIG.tackle.spillDistance));
        e.ball.pos.y = Math.max(CONFIG.ball.radius, e.ball.pos.y);
        const spill = strikeProfile(e, p, ACTION_PROFILES.touch_spill, `spill:${p.runSerial}`, {
          distance: CONFIG.tackle.spillDistance, accuracy: 30, directSpeed: true, intensity: 0.8,
        });
        e.ball.strike(new THREE.Vector3(dir.x, 0, dir.z), spill);
        e.ball.kickedBy = p.idx;
        e.ball.kickAge = 0;
        e.offsideCandidates.clear(); e.offsideTeam = null;
        tackleOutcome = "spill";
        stats.tacklesSpilled++;
        carrier.stumbleT = Math.max(carrier.stumbleT, 0.35);
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} spills tackle (${action}) · q ${quality.score.toFixed(2)}`, p.team);
      } else if (quality.outcome === "foul" && carrier) {
        tackleOutcome = "foul";
        stats.fouls++;
        e.rules.emit("FOUL", `Foul by ${p.team === 0 ? "RED" : "BLUE"} ${action} · ${quality.reason}`, p.team);
        // The referee's sanctions are booked on the foul itself, whether or not
        // the whistle stops play (advantage, or a no-whistle prototype build).
        const card = issueCards(e, p, quality);
        const advantage = advantageAvailable(e, carrier);
        if (advantage.playOn) {
          // Play on: the fouled side keeps a usable ball, so the whistle stays
          // down. The challenge is still paid for and still on the record.
          carrier.stumbleT = Math.max(carrier.stumbleT, CONFIG.tackle.foulStumble * 0.35);
          e.rules.emit("ADVANTAGE", `Advantage played — ${carrier.team === 0 ? "RED" : "BLUE"} keep the ball · ${advantage.reason}`, carrier.team);
          aiEvent(e, `ADVANTAGE played · ${advantage.reason}${card ? ` · card ${card}` : ""}`);
        } else if (e.foulsOn) {
          carrier.stumbleT = CONFIG.tackle.foulStumble;
          startAction(e, carrier, "stumble");
          // A foul on the carrier inside the box he is ATTACKING is a penalty; the
          // old test used the carrier's own goal, so every foul in the attacking box
          // became a free kick and no penalty could ever be awarded.
          const attackGoal = e.ai.goalPos(carrier.team, e.rules.half);
          const inBox = Math.abs(carrier.pos.x - attackGoal.x) < 5.5 && Math.abs(carrier.pos.z) < 6.2;
          // Penalty kicks are taken from the penalty spot, not the foul position.
          // The penalty spot is 4.2 m from the goal line on the scaled 40 m pitch
          // (real law: 11 m on a 105 m pitch → 11/105 × 40 ≈ 4.2).
          const penaltySpotDist = CONFIG.pitch.penaltySpotDist;
          const atkSign = e.ai.attackSign(carrier.team, e.rules.half);
          const restartPos: [number, number] = inBox
            ? [attackGoal.x - atkSign * penaltySpotDist, 0]
            : [carrier.pos.x, carrier.pos.z];
          e.ball.pos.set(restartPos[0], CONFIG.ball.radius, restartPos[1]);
          e.ball.vel.set(0, 0, 0);
          e.ball.release();
          e.offsideCandidates.clear(); e.offsideTeam = null;
          e.rules.startSetup(inBox ? "penalty" : "free_kick", restartPos, carrier.team);
        } else {
          // Fouls may be disabled for a no-whistle prototype, but the bad
          // challenge is still punished: no possession, recovery and a stumble.
          carrier.stumbleT = CONFIG.tackle.foulStumble;
          startAction(e, carrier, "stumble");
          e.rules.emit("TACKLE", "Bad challenge · fouls disabled, play on", p.team);
        }
      } else {
        tackleOutcome = "miss";
        stats.tacklesMissed++;
        p.stumbleT = Math.max(p.stumbleT, CONFIG.tackle.missStumble);
        if (quality.heavyContact && carrier) carrier.stumbleT = Math.max(carrier.stumbleT, 0.2);
        e.rules.emit("TACKLE", `${p.team === 0 ? "RED" : "BLUE"} missed tackle (${action}) · q ${quality.score.toFixed(2)}`, p.team);
      }
      // A failed slide tackle queues a get_up only after the slide clip completes.
      // Requesting get_up at the contact frame (0.475 s into the 0.95 s clip) forced
      // the slide animation to cut short, snapping the player upright mid-slide.
      // Instead, stamp a deferred flag that the frame loop triggers when the clip ends.
      if (action === "tackle_slide" && tackleOutcome !== "clean") p.pendingGetUp = true;
      p.decisionReason = `TACKLE ${tackleOutcome?.toUpperCase()} · ${quality.reason}`;
      break;
    }
    case "intercept": case "first_touch": case "dribble_touch": {
      const controlRating = action === "intercept" ? p.attributes.defending.interceptions : p.attributes.ballControl.groundReceiving;
      if (e.ball.possessedBy === null && p.pos.distanceTo(e.ball.pos) < (CONFIG.player.interceptRadius + 0.5) * (0.5 + controlRating / 150)) {
        e.ball.possess(p.idx, p.team);
        e.offsideCandidates.clear(); e.offsideTeam = null;
        e.rules.emit("POSSESSION", `${p.team === 0 ? "RED" : "BLUE"} ${action} takes ball`, p.team);
        if (p.team === e.humanTeam && !e.spectator) setHumanPlayer(e, p);
      }
      break;
    }
    case "gk_catch": case "gk_parry": case "gk_dive_L": case "gk_dive_R": {
      // Hands on a possessed ball are only the 1v1 smother: keeper in his own
      // box, opponent carrier, ball not protected by a just-won tackle. Every
      // other possessed ball stays untouchable, as before.
      const smotherCarrier = e.ball.possessedBy !== null ? e.players[e.ball.possessedBy] : null;
      if (smotherCarrier) {
        const ownGoalPos = e.ai.ownGoal(p.team, e.rules.half);
        const inOwnBox = Math.abs(p.pos.x - ownGoalPos.x) < 5.8 && Math.abs(p.pos.z) < 6.2;
        if (action !== "gk_catch" || smotherCarrier.team === p.team || !inOwnBox
          || smotherCarrier.tackleProtectionT > 0) break;
      }
      if (e.ball.handsRestrictedTeam === p.team) break;
      // The sweep save model in ./keeper has already resolved this shot; the clip's
      // contact frame must not touch the same ball a second time (double parry).
      if (e.ball.kickedBy === p.idx) break;
      const diving = action === "gk_dive_L" || action === "gk_dive_R";
      // Hand reach at the contact frame. A dive's root motion has already displaced the
      // body, so its residual reach is the outstretched arm plus fingertips.
      // A keeper still moving across goal when the save fires is off-balance and loses reach
      // — unless the clip is a dive in that same direction (momentum then helps, not hurts).
      const lateralSpeed = Math.abs(p.vel.z);
      const movingWithDive = diving && Math.sign(p.vel.z) === Math.sign(e.ball.pos.z - p.pos.z);
      const offBalance = movingWithDive ? 0 : lateralSpeed * CONFIG.ai.gkOffBalancePenalty;
      const reachRating = p.attributes.goalkeeping.reach;
      const divingRating = p.attributes.goalkeeping.diving;
      const reachScale = 0.5 + reachRating / 150;
      const baseReach = diving
        ? CONFIG.ai.gkStandingReach * reachScale + 0.8 * (0.5 + divingRating / 150)
        : (CONFIG.ai.gkStandingReach + 0.3 + (smotherCarrier ? 0.25 : 0)) * reachScale;
      const reach = Math.max(0.5, baseReach - offBalance);
      // Closest approach of the ball path over the contact window (it may still be arriving).
      let best = Infinity, bestH = e.ball.pos.y;
      for (let s = 0; s <= 6; s++) {
        const t = s * 0.025;
        const bx = e.ball.pos.x + e.ball.vel.x * t, bz = e.ball.pos.z + e.ball.vel.z * t;
        const by = Math.max(CONFIG.ball.radius, e.ball.pos.y + e.ball.vel.y * t - 0.5 * CONFIG.ball.gravity * t * t);
        const dist = Math.hypot(bx - p.pos.x, bz - p.pos.z);
        if (dist < best) { best = dist; bestH = by; }
      }
      const inHeight = bestH < 2.35 && bestH > 0;
      if (best > reach || !inHeight) {
        aiEvent(e, `GK ${action} MISSED · ${best.toFixed(2)}m vs reach ${reach.toFixed(2)}m, h ${bestH.toFixed(2)}`);
        break;
      }
      const speed = e.ball.speed;
      // A smother only gathers a ball the carrier has left exposed on the
      // keeper's side of his body; a shielded ball can at best be blocked loose.
      const exposed = !smotherCarrier || e.ball.pos.distanceTo(p.pos) < smotherCarrier.pos.distanceTo(p.pos);
      // Catch only clean, central, not-too-hot balls; otherwise the save is a parry.
      const catchSpeed = CONFIG.ai.gkCatchSpeed * (0.5 + (p.attributes.goalkeeping.handling + p.attributes.goalkeeping.catching) / 300);
      const catchReach = (CONFIG.ai.gkStandingReach + 0.15 + (smotherCarrier ? 0.25 : 0)) * reachScale;
      if (action === "gk_catch" && exposed && speed < catchSpeed && best < catchReach) {
        e.ball.possess(p.idx, p.team);
        e.ball.vel.set(0, 0, 0);
        e.offsideCandidates.clear(); e.offsideTeam = null;
        p.holdT = 0;
        aiEvent(e, `GK ${smotherCarrier ? "SMOTHER" : "CATCH"} #${p.idx} · ${speed.toFixed(1)} m/s at ${best.toFixed(2)}m`);
        e.rules.emit("SAVE", `GK ${smotherCarrier ? "SMOTHER" : "CATCH"} by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
        break;
      }
      // Parry: deflect wide of goal, keeping some of the shot's energy.
      const ownGoal = e.ai.ownGoal(p.team, e.rules.half);
      const away = e.ball.pos.clone().sub(ownGoal).setY(0).normalize();
      const parrying = p.attributes.goalkeeping.parrying;
      away.z += (e.ball.pos.z >= p.pos.z ? 1 : -1) * 0.7 * (0.5 + parrying / 150);
      releaseToKick(e, p);
      const parry = strikeProfile(e, p, ACTION_PROFILES.gk_parry, `parry:${e.clock.toFixed(2)}`, {
        distance: 6,
        accuracy: p.attributes.goalkeeping.parrying,
        directSpeed: true,
        intensity: THREE.MathUtils.clamp(speed / 34, 0.2, 1),
      });
      e.ball.strike(away.normalize(), { ...parry, speed: THREE.MathUtils.clamp(speed * (0.55 - parrying / 500), 5, 12) });
      e.offsideCandidates.clear(); e.offsideTeam = null;
      aiEvent(e, `GK PARRY #${p.idx} (${action}) · ${speed.toFixed(1)} m/s at ${best.toFixed(2)}m`);
      e.rules.emit("SAVE", `GK ${action} — parried!`, p.team);
      break;
    }
    case "gk_punt": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      if (pk.forced) {
        // Forced clearance (keeper hold limit): struck straight down the target
        // line. No receiver plan, no offside target, nothing that can cancel it.
        const aim = pk.target.clone().sub(e.ball.pos).setY(0);
        if (aim.lengthSq() < 1e-4) aim.set(e.ai.attackSign(p.team, e.rules.half), 0, 0);
        releaseToKick(e, p);
        captureOffsideAtKick(e, p, activeRestart?.kind);
        const boot = strikeProfile(e, p, ACTION_PROFILES.gk_punt, `forced-punt:${activeRestart?.id ?? 0}`, {
          distance: Math.max(20, aim.length()),
          accuracy: p.attributes.goalkeeping.kicking,
          directSpeed: true,
          intensity: 0.85,
        });
        e.ball.strike(aim.normalize(), boot);
        aiEvent(e, `STRIKE ${ACTION_PROFILES.gk_punt.name} (forced) · ${boot.speed.toFixed(1)} m/s`);
        ballReleasedByAction = true;
        if (!activeRestart) e.openPlayKickCount++;
        break;
      }
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) {
        p.decisionReason = "GK PUNT CANCELLED · no valid named teammate";
        break;
      }
      releaseToKick(e, p);
      const punt = plan.strike ?? strikeProfile(e, p, ACTION_PROFILES.gk_punt, `punt:${action}`, {
        distance: plan.distance, accuracy: p.attributes.goalkeeping.kicking,
      });
      e.ball.strike(plan.target.clone().sub(e.ball.pos).setY(0).normalize(), { ...punt, speed: plan.power, loft: plan.loft });
      aiEvent(e, `STRIKE ${(punt.profile ?? ACTION_PROFILES.gk_punt).name} · ${plan.power.toFixed(1)} m/s`);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "gk_roll": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) { p.decisionReason = "GK ROLL CANCELLED · no valid named teammate"; break; }
      releaseToKick(e, p);
      const roll = plan.strike ?? strikeProfile(e, p, ACTION_PROFILES.gk_roll, `roll:${action}`, {
        distance: plan.distance, accuracy: p.attributes.goalkeeping.kicking,
      });
      e.ball.strike(plan.target.clone().sub(e.ball.pos).setY(0).normalize(), { ...roll, speed: plan.power, loft: plan.loft });
      aiEvent(e, `STRIKE ${(roll.profile ?? ACTION_PROFILES.gk_roll).name} · ${plan.power.toFixed(1)} m/s`);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "corner_kick": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      if (!ownerIsMe) break;
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) { p.decisionReason = "CORNER CANCELLED · no valid named runner"; break; }
      releaseToKick(e, p);
      const cornerError = CONFIG.ai.passError * (75 - p.attributes.passing.corner) / 75
        * (tieBreakHash(e.matchSeed, p.idx, p.runSerial, `corner-accuracy:${activeRestart?.id ?? 0}`) * 2 - 1);
      const cornerDirection = plan.target.clone().sub(e.ball.pos).setY(0).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), cornerError);
      const cornerStrike = plan.strike ?? strikeProfile(e, p, ACTION_PROFILES.corner_inswing, `corner:${activeRestart?.id ?? 0}`, {
        distance: plan.distance,
        accuracy: p.attributes.passing.corner,
        curveSide: -Math.sign(e.ball.pos.z) || 1,
      });
      e.ball.strike(cornerDirection, { ...cornerStrike, speed: plan.power, loft: plan.loft });
      aiEvent(e, `STRIKE ${cornerStrike.profile?.name ?? action} · ${plan.power.toFixed(1)} m/s · ${(cornerStrike.spinRpm ?? 0).toFixed(0)} rpm`);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
    case "throw_in": {
      if (pk?.action !== action) { p.pendingKick = null; break; }
      // Only the restart taker may release the ball — prevents a stray
      // throw_in animation from ejecting a ball another player owns.
      if (!ownerIsMe && !p.restartTaker) break;
      // The ball leaves the hands from just inside the touchline: the taker stands
      // outside it, and releasing there put the ball out of play on the throw frame
      // (see `clampReleaseInsidePitch`). Plan from that release point — a cancelled
      // throw must leave the ball untouched in the taker's hands for the retry.
      const releasePos = clampReleaseInsidePitch(new THREE.Vector3(p.pos.x, 1.65, p.pos.z));
      const heldPos = e.ball.pos.clone();
      e.ball.pos.copy(releasePos);
      const plan = planNamedPass(e, p, action, pk?.passTo, pk?.power, activeRestart?.kind);
      if (!plan) {
        e.ball.pos.copy(heldPos);
        p.decisionReason = "THROW CANCELLED · no valid named teammate";
        break;
      }
      const throwAim = plan.target.clone().sub(releasePos).setY(0).normalize();
      const throwDot = passAimDot(releasePos, throwAim.clone().multiplyScalar(plan.power), plan.target);
      if (!passAimIsValid(throwDot, CONFIG.ai.passAimConeDegrees)) {
        e.ball.pos.copy(heldPos);
        p.decisionReason = "THROW CANCELLED · aim outside receiver cone";
        break;
      }
      e.ball.release();
      e.ball.pos.copy(releasePos);
      e.ball.lastTouch = p.idx; e.ball.lastTouchTeam = p.team;
      const throwStrike = plan.strike ?? strikeProfile(e, p, ACTION_PROFILES.throw_in, `throw:${activeRestart?.id ?? 0}`, {
        distance: plan.distance, accuracy: p.attributes.passing.shortGroundPassing,
      });
      e.ball.strike(throwAim, { ...throwStrike, speed: plan.power, loft: plan.loft });
      aiEvent(e, `STRIKE ${throwStrike.profile?.name ?? action} · ${plan.power.toFixed(1)} m/s`);
      ballReleasedByAction = true;
      recordPass(e, p, action, plan);
      if (!activeRestart) e.openPlayKickCount++;
      break;
    }
  }
  if (ballReleasedByAction) {
    aiEvent(e, `KICK released by #${p.idx} ${p.role} · ${action} · ${e.ball.speed.toFixed(1)} m/s${pk?.passTo !== undefined ? ` → #${pk.passTo}` : ""}`);
    e.ai.noteKickReleased(p.idx);
  } else if (tackleOutcome) {
    aiEvent(e, `TACKLE ${tackleOutcome === "clean" ? "WON" : "MISSED"} #${p.idx} · ${action} · ${tackleOutcome} · ${tackleDetail}`);
  } else if (pk && pk.action === action && (action === "intercept" || action === "first_touch" || action === "header" || action.startsWith("gk_"))) {
    const won = e.ball.possessedBy === p.idx;
    aiEvent(e, `${action.toUpperCase()} ${won ? "WON" : "MISSED"} #${p.idx}`);
  } else if (pk && pk.action === action) {
    aiEvent(e, `KICK CANCELLED #${p.idx} · ${action} · ${p.decisionReason}`);
    // Remember the failed kick: re-deciding into the identical pass would
    // restart the same wind-up/cancel cycle indefinitely.
    if (action.startsWith("pass_")) e.ai.noteKickFailed(p.idx, action, pk.passTo);
    e.ai.nextThink.set(p.idx, 0); // carrier re-decides immediately instead of stalling
  }
  if (p.restartTaker && activeRestart && e.restartStartedId === activeRestart.id) {
    if (ballReleasedByAction) {
      e.restartLaunchedId = activeRestart.id;
      e.rules.pendingRestart = null;
      p.restartTaker = false;
    } else if (++e.restartRetries >= 3) {
      // No valid receiver after 3 samples: give the taker the ball in play.
      // Never clamp a throw-in / corner taker back onto the pitch: they stand
      // outside the touchline by law, so use the buffer margin instead.
      e.restartLaunchedId = activeRestart.id;
      e.rules.pendingRestart = null;
      releaseRestartToTaker(e, p);
    } else {
      // Restart delivery cancelled: retake promptly with a newly sampled target.
      e.restartStartedId = -1;
      e.restartAutoT = 0.2;
    }
  }
  p.pendingKick = null;
  if (isTackleAction(action)) p.tackleChallenge = null;
}
