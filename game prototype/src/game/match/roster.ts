// Squad creation and the human-controlled player slot.
import * as THREE from "three";
import { FORMATIONS } from "../config";
import { AnimationController } from "../anims";
import { createPlayerMesh, generateVariant } from "../playerMesh";
import { tieBreakHash } from "../random";
import { createPerception } from "./perception";
import { isOffPitch } from "./referee";
import type { MatchHost } from "./host";
import type { EnginePlayer } from "./types";

/** Pick the most advanced outfielder in the human team's formation, not a magic index. */
export function defaultHumanIndex(team = 0): number {
  const formation = FORMATIONS[team === 0 ? "RED" : "BLUE"];
  let best = -1, bestX = -Infinity;
  for (let i = 0; i < formation.length; i++) {
    if (formation[i].role === "GK") continue;
    if (formation[i].home[0] > bestX) { bestX = formation[i].home[0]; best = i; }
  }
  return best < 0 ? 0 : best + team * formation.length;
}

/** Create both squads: rig, animation controller and per-player state. */
export function buildPlayers(e: MatchHost) {
  let startIdx = 0;
  for (const team of [0, 1]) {
    const key = team === 0 ? "RED" : "BLUE";
    FORMATIONS[key].forEach((f, i) => {
      const idx = startIdx + i;
      const variant = generateVariant(e.matchSeed + team * 77, team, f.role, i);
      const rig = createPlayerMesh(variant);
      const anim = new AnimationController();
      // Visual phase is derived, not drawn from the match PRNG: animation
      // cosmetics must never shift gameplay random streams.
      anim.locoPhase = tieBreakHash(e.matchSeed, idx, 0, "loco-phase") * Math.PI * 2;
      e.scene.add(rig.group);
      e.players.push({
        idx, team, role: f.role, roleIdx: i,
        pos: new THREE.Vector3(f.home[0], 0, f.home[1]), vel: new THREE.Vector3(),
        facing: team === 0 ? 0 : Math.PI, speed: 0, rig, anim,
        moveTarget: new THREE.Vector3(f.home[0], 0, f.home[1]), desiredSpeed: 0,
        pendingKick: null, holdT: 0, stumbleT: 0,
        tackleRecoveryT: 0, tackleProtectionT: 0, tackleChallenge: null,
        yellowCards: 0, blueCardUntil: 0, foulsConceded: 0,
        callForBall: false, isHuman: false, stamina: 1,
        decisionReason: "init", utilities: {}, restartTaker: false,
        runSerial: 0, style: e.ai.sampleStyle(f.role, idx), attributes: e.ai.sampleAttributes(f.role, idx),
        perception: createPerception(e.matchSeed, idx), faceTarget: null, faceTargetT: 0, kickTurnT: 0,
        shielding: false, strikeFoot: "R", shieldPoint: new THREE.Vector3(f.home[0], 0, f.home[1]), strideFacing: null,
      });
    });
    startIdx += FORMATIONS[key].length;
  }
  const human = e.players[e.humanIdx] ?? e.players.find((p) => p.team === e.humanTeam && p.role !== "GK");
  if (human) {
    e.humanIdx = human.idx;
    human.isHuman = true;
    e.selectedIdx = human.idx;
  }
}
/**
 * Move the human-controlled slot to `p` (no-op for keepers and for the
 * opponent's outfielders).
 */
export function setHumanPlayer(e: MatchHost, p: EnginePlayer) {
  // Spectator mode has no human player: possession changes must not move the
  // human slot around (humanControl is already gated on !spectator).
  if (e.spectator) return;
  if (p.team !== e.humanTeam || p.role === "GK") return;
  if (isOffPitch(e, p)) return;
  const current = e.players[e.humanIdx];
  if (current && current.idx !== p.idx) current.isHuman = false;
  e.humanIdx = p.idx;
  p.isHuman = true;
  e.selectedIdx = p.idx;
}

/** Pass the human slot to the nearest outfielder to the ball. */
export function switchToNearest(e: MatchHost, manual = false) {
  if (e.spectator) return;
  // A blue-carded player is off the pitch and cannot be controlled.
  const mates = e.players.filter((p) => p.team === e.humanTeam && p.role !== "GK" && !isOffPitch(e, p));
  const ranked = [...mates].sort((a, b) => a.pos.distanceTo(e.ball.pos) - b.pos.distanceTo(e.ball.pos));
  // A manual switch must always do something: when the nearest man is already
  // selected, [X] cycles to the next one out instead of silently no-opping.
  const best = manual ? ranked.find((p) => p.idx !== e.humanIdx) ?? ranked[0] : ranked[0];
  if (best && best.idx !== e.humanIdx) {
    const current = e.players[e.humanIdx];
    if (current) current.isHuman = false;
    e.humanIdx = best.idx; best.isHuman = true;
    e.selectedIdx = best.idx;
    if (manual) e.rules.emit("POSSESSION", `Manual switch → ${best.role} #${best.idx}`);
  }
}
