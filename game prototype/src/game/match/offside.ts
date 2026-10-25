// Offside: who was beyond the second-last defender when the ball was played,
// and the flag that turns an offside involvement into a free kick.
import { CONFIG } from "../config";
import type { EnginePlayer } from "./types";
import type { MatchHost } from "./host";

/** Throw-ins, corners, goal kicks and kickoffs can never be offside. */
export function restartExemptFromOffside(kind?: string): boolean {
  return kind === "throw_in" || kind === "corner" || kind === "goal_kick" || kind === "kickoff";
}

/** Was `receiver` beyond the second-last defender when the ball was played? */
export function receiverOffsideAtKick(e: MatchHost, passer: EnginePlayer, receiver: EnginePlayer, restartKind?: string): boolean {
  if (restartExemptFromOffside(restartKind)) return false;
  if (!CONFIG.ai.offside || receiver.team !== passer.team || receiver.role === "GK") return false;
  const attack = e.ai.attackSign(passer.team, e.rules.half);
  const u = receiver.pos.x * attack;
  if (u <= 0) return false;
  const defenders = e.players.filter((p) => p.team !== passer.team)
    .map((p) => p.pos.x * attack).sort((a, b) => b - a);
  // With fewer than two opponents there is no second-last defender to judge
  // against, so no offside position can exist (default beyond the pitch).
  const secondLast = defenders[1] ?? CONFIG.pitch.length / 2;
  return u > e.ball.pos.x * attack + CONFIG.ai.offsideBuffer
    && u > secondLast + CONFIG.ai.offsideBuffer;
}

/** Snapshot who was in an offside position when the ball was played. */
export function captureOffsideAtKick(e: MatchHost, passer: EnginePlayer, restartKind?: string) {
  const exempt = restartExemptFromOffside(restartKind);
  e.offsideCandidates.clear();
  e.offsideTeam = null;
  if (!CONFIG.ai.offside || exempt) return;
  const attack = e.ai.attackSign(passer.team, e.rules.half);
  // With fewer than two opponents there is no second-last defender, so no
  // offside position can exist (default beyond the pitch).
  const secondLast = e.players.filter((p) => p.team !== passer.team)
    .map((p) => p.pos.x * attack).sort((a, b) => b - a)[1] ?? CONFIG.pitch.length / 2;
  const ballU = e.ball.pos.x * attack;
  for (const player of e.players) {
    if (player.team !== passer.team || player.idx === passer.idx || player.role === "GK") continue;
    const u = player.pos.x * attack;
    if (u > 0 && u > ballU + CONFIG.ai.offsideBuffer && u > secondLast + CONFIG.ai.offsideBuffer) {
      e.offsideCandidates.add(player.idx);
    }
  }
  if (e.offsideCandidates.size > 0) e.offsideTeam = passer.team;
}

/** Flag an offside involvement: free kick to the defending side, play stops. */
export function flagOffside(e: MatchHost, receiver: EnginePlayer): boolean {
  if (!CONFIG.ai.offside || e.offsideTeam !== receiver.team || !e.offsideCandidates.has(receiver.idx)) return false;
  const spot: [number, number] = [e.ball.pos.x, e.ball.pos.z];
  e.rules.emit("OFFSIDE", `${receiver.team === 0 ? "RED" : "BLUE"} ${receiver.role} #${receiver.idx} involved from offside position`, receiver.team);
  e.offsideCandidates.clear(); e.offsideTeam = null;
  e.ball.release();
  e.ball.vel.set(0, 0, 0);
  e.rules.startSetup("free_kick", spot, 1 - receiver.team);
  return true;
}
