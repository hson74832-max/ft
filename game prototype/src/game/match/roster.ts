// Squad creation and the human-controlled player slot.
import * as THREE from "three";
import { FORMATIONS } from "../config";
import { AnimationController } from "../anims";
import { MeshFamily, createPlayerMesh, generateVariant } from "../playerMesh";
import type { MatchHost } from "./host";

/** Create both squads: rig, animation controller and per-player state. */
export function buildPlayers(e: MatchHost) {
  const mkTeam = (team: number, startIdx: number) => {
    const key = team === 0 ? "RED" : "BLUE";
    FORMATIONS[key].forEach((f, i) => {
      const idx = startIdx + i;
      const fam: MeshFamily = e.familyMode === "mixed" ? (idx % 2 === 0 ? "Blocky" : "Roundy") : e.familyMode === "blocky" ? "Blocky" : "Roundy";
      const variant = generateVariant(e.matchSeed + team * 77, team, f.role, fam, i);
      const rig = createPlayerMesh(variant);
      const anim = new AnimationController();
      anim.locoPhase = e.rng.range(0, Math.PI * 2);
      e.scene.add(rig.group);
      e.players.push({
        idx, team, role: f.role, roleIdx: i,
        pos: new THREE.Vector3(f.home[0], 0, f.home[1]), vel: new THREE.Vector3(),
        facing: team === 0 ? 0 : Math.PI, speed: 0, rig, anim,
        moveTarget: new THREE.Vector3(f.home[0], 0, f.home[1]), desiredSpeed: 0,
        pendingKick: null, holdT: 0, stumbleT: 0, celebrateT: 0,
        callForBall: false, isHuman: idx === e.humanIdx, stamina: 1,
        decisionReason: "init", utilities: {}, restartTaker: false,
        runSerial: 0, style: e.ai.sampleStyle(f.role), lastActionSeed: null,
      });
    });
  };
  mkTeam(0, 0); mkTeam(1, 5);
  e.players.forEach((p) => { p.isHuman = p.idx === e.humanIdx; });
  e.selectedIdx = e.humanIdx;
}
/**
 * Move the human-controlled slot to `p` (no-op for keepers and for the
 * opponent's outfielders).
 */
export function setHumanPlayer(e: MatchHost, p: import("./types").EnginePlayer) {
  // Spectator mode has no human player: possession changes must not move the
  // human slot around (humanControl is already gated on !spectator).
  if (e.spectator) return;
  if (p.team !== e.humanTeam || p.role === "GK") return;
  const current = e.players[e.humanIdx];
  if (current && current.idx !== p.idx) current.isHuman = false;
  e.humanIdx = p.idx;
  p.isHuman = true;
  e.selectedIdx = p.idx;
}

/** Pass the human slot to the nearest outfielder to the ball. */
export function switchToNearest(e: MatchHost, manual = false) {
  if (e.spectator) return;
  const mates = e.players.filter((p) => p.team === e.humanTeam && p.role !== "GK");
  const best = [...mates].sort((a, b) => a.pos.distanceTo(e.ball.pos) - b.pos.distanceTo(e.ball.pos))[0];
  if (best && best.idx !== e.humanIdx) {
    e.players[e.humanIdx].isHuman = false;
    e.humanIdx = best.idx; best.isHuman = true;
    e.selectedIdx = best.idx;
    if (manual) e.rules.emit("POSSESSION", `Manual switch → ${best.role} #${best.idx}`);
  }
}
