// Body collisions: player-vs-player separation and ball-vs-player deflection.
import * as THREE from "three";
import { CONFIG } from "../config";
import { aiEvent } from "./debug";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/** Keep players out of each other's body cylinder (position + closing velocity). */
export function resolvePlayerCollisions(e: MatchHost) {
  const bodyRadius = (p: EnginePlayer) => p.role === "GK" ? 0.46 : 0.4;
  for (let i = 0; i < e.players.length; i++) {
    for (let j = i + 1; j < e.players.length; j++) {
      const a = e.players[i], b = e.players[j];
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const distance = Math.hypot(dx, dz);
      const minimum = bodyRadius(a) + bodyRadius(b);
      if (distance >= minimum) continue;
      const nx = distance > 1e-4 ? dx / distance : (a.idx < b.idx ? 1 : -1);
      const nz = distance > 1e-4 ? dz / distance : 0.0001;
      const overlap = minimum - distance;
      // Grounded positional resolution: neither player may occupy the other's cylinder.
      const aPinned = a.anim.actionRootMotion;
      const bPinned = b.anim.actionRootMotion;
      const aShare = aPinned && !bPinned ? 0 : bPinned && !aPinned ? 1 : aPinned && bPinned ? 0.5 : a.speed >= b.speed ? 0.42 : 0.58;
      a.pos.x -= nx * overlap * aShare; a.pos.z -= nz * overlap * aShare;
      b.pos.x += nx * overlap * (1 - aShare); b.pos.z += nz * overlap * (1 - aShare);
      // Cancel closing velocity along the contact normal so they cannot fuse next frame.
      const closing = (a.vel.x - b.vel.x) * nx + (a.vel.z - b.vel.z) * nz;
      if (closing > 0) {
        a.vel.x -= nx * closing * 0.6; a.vel.z -= nz * closing * 0.6;
        b.vel.x += nx * closing * 0.6; b.vel.z += nz * closing * 0.6;
      }
      const halfX = CONFIG.pitch.length / 2 - 0.4, halfZ = CONFIG.pitch.width / 2 - 0.4;
      // A restart taker may lawfully stand in the buffer outside the touchline
      // (throw-in) or behind the corner flag (corner): never clamp them back
      // onto the pitch here — stepPlayers already gave them the buffer margin.
      const margin = (p: EnginePlayer) => (p.restartTaker ? CONFIG.pitch.buffer + 0.4 : 0);
      a.pos.x = THREE.MathUtils.clamp(a.pos.x, -halfX - margin(a), halfX + margin(a));
      a.pos.z = THREE.MathUtils.clamp(a.pos.z, -halfZ - margin(a), halfZ + margin(a));
      b.pos.x = THREE.MathUtils.clamp(b.pos.x, -halfX - margin(b), halfX + margin(b));
      b.pos.z = THREE.MathUtils.clamp(b.pos.z, -halfZ - margin(b), halfZ + margin(b));
      a.rig.group.position.x = a.pos.x; a.rig.group.position.z = a.pos.z;
      b.rig.group.position.x = b.pos.x; b.rig.group.position.z = b.pos.z;
    }
  }
}

/** Ball against bodies: deflections, keeper catches and parries. */
export function resolveBallPlayerCollisions(e: MatchHost) {
  if (e.ball.possessedBy !== null || e.ball.pos.y > 1.35) return;
  const R = CONFIG.ball.radius;
  // Find the closest overlapping player rather than the first in array order.
  let hit: EnginePlayer | null = null, hitDist = Infinity, hitNx = 0, hitNz = 0;
  for (const p of e.players) {
    const dx = e.ball.pos.x - p.pos.x, dz = e.ball.pos.z - p.pos.z;
    const distance = Math.hypot(dx, dz);
    // The striker's own fresh kick starts inside their body radius — never deflect it.
    if (p.idx === e.ball.kickedBy && e.ball.kickAge < 0.3) continue;
    // A controllable ball reaching a ready player is received (possessionCheck), not
    // bounced. Balls faster than the trap limit still hit the body and deflect.
    if (p.stumbleT <= 0 && distance < CONFIG.player.controlRadius + 0.35 && e.ball.pos.y < 0.85
      && e.ball.speed <= CONFIG.player.maxTrapSpeed && (p.role !== "GK" || e.ball.handsRestrictedTeam === p.team)) {
      continue;
    }
    const minimum = (p.role === "GK" ? 0.46 : 0.4) + R;
    if (distance >= minimum || distance >= hitDist) continue;
    hit = p; hitDist = distance;
    hitNx = distance > 1e-4 ? dx / distance : 1;
    hitNz = distance > 1e-4 ? dz / distance : 0;
  }
  if (!hit) return;
  const p = hit;
  e.ball.pos.x = p.pos.x + hitNx * ((p.role === "GK" ? 0.46 : 0.4) + R);
  e.ball.pos.z = p.pos.z + hitNz * ((p.role === "GK" ? 0.46 : 0.4) + R);
  const toward = e.ball.vel.x * hitNx + e.ball.vel.z * hitNz;
  if (toward < 0 && p.role === "GK" && e.ball.handsRestrictedTeam !== p.team && e.ball.speed < CONFIG.ai.gkCatchSpeed && e.ball.pos.y < 2.0 && p.stumbleT <= 0) {
    // Keeper got the body behind a catchable ball: gathered, not spilled.
    e.ball.possess(p.idx, p.team);
    e.ball.vel.set(0, 0, 0);
    p.holdT = 0;
    e.offsideCandidates.clear(); e.offsideTeam = null;
    aiEvent(e, `GK CATCH #${p.idx} (body behind ball) · ${(-toward).toFixed(1)} m/s`);
    e.rules.emit("SAVE", `GK CATCH by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
    return;
  }
  if (toward < 0) {
    // Body deflection: restitution ~0.25 off a torso/legs (energy absorbed).
    e.ball.vel.x -= 1.25 * toward * hitNx;
    e.ball.vel.z -= 1.25 * toward * hitNz;
    if (p.role === "GK" && -toward > 8) {
      aiEvent(e, `GK PARRY #${p.idx} (body block) · ${(-toward).toFixed(1)} m/s`);
      e.rules.emit("SAVE", `GK body block by ${p.team === 0 ? "RED" : "BLUE"}`, p.team);
    }
  }
  e.ball.lastTouch = p.idx; e.ball.lastTouchTeam = p.team;
}
