// Pure restart legality checks so match flow can be regression-tested without WebGL.
export interface RestartPlayerPoint { x: number; z: number; }

export function kickoffRestartViolation(
  opponentPositions: RestartPlayerPoint[],
  kickoffAttackSign: number,
  centreCircleRadius = 4.15,
): string | null {
  if (opponentPositions.some((p) => Math.hypot(p.x, p.z) < centreCircleRadius)) {
    return "Waiting: opponents must be outside the centre circle";
  }
  // In kickoff-team coordinates, opponents' own half is the side they attack toward.
  if (opponentPositions.some((p) => p.x * kickoffAttackSign <= 0)) {
    return "Waiting: opponents must be in their own half";
  }
  return null;
}