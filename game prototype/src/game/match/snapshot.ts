// HUD snapshot: the single read-only view the React layer renders from.
import { CONFIG } from "../config";
import { getMotionRegistryVersion } from "../motion";
import type { AnimDebug } from "../anims";
import type { MatchHost } from "./host";

/** Neutral animation DTO for a host with an empty/invalid roster. */
const EMPTY_ANIM: AnimDebug = {
  state: "none", clip: "none", nt: 0, blend: 1, speed: 0,
  contactFired: false, weights: "—", cooldowns: "—",
};

/** Read-only HUD view of the match for the React layer. */
export function buildSnapshot(e: MatchHost) {
  const sel = e.players[e.selectedIdx] ?? e.players[e.humanIdx] ?? e.players[0];
  const currentMotionRevision = getMotionRegistryVersion();
  return {
    score: [...e.rules.score], clock: e.rules.clock, elapsedClock: e.rules.elapsedClock,
    half: e.rules.half, halfLabel: e.rules.halfLabel,
    phase: e.rules.phase, setupT: e.rules.setupT,
    restartKind: e.rules.pendingRestart?.kind ?? null,
    restartTeam: e.rules.pendingRestart?.team ?? null,
    restartWait: e.restartWaitReason,
    initialKickoffTeam: e.rules.initialKickoffTeam,
    homeTeam: "Harbor City", awayTeam: "Redwood Rangers",
    possession: e.ball.ownerTeam === 0 ? "RED" : e.ball.ownerTeam === 1 ? "BLUE" : "—",
    ballSpeed: e.ball.speed,
    fps: e.fps, cameraMode: e.cameraMode, spectator: e.spectator,
    humanIdx: e.humanIdx, humanRole: e.players[e.humanIdx]?.role ?? "—",
    anim: sel ? sel.anim.debug(sel.speed) : EMPTY_ANIM,
    selIdx: sel?.idx ?? -1, selTeam: sel?.team ?? -1, selRole: sel?.role ?? "—",
    decisions: e.players.map((p) => ({ idx: p.idx, team: p.team, role: p.role, reason: p.decisionReason, utils: p.utilities, x: p.pos.x, z: p.pos.z,
      human: !e.spectator && p.idx === e.humanIdx, job: p.supportJob, mode: p.supportMode,
      target: [p.moveTarget.x, p.moveTarget.z], passOptions: p.passOptions })),
    tacticalStats: { ...e.tacticalStats },
    attackPlans: [0, 1].map((team) => {
      const plan = e.ai.tactics.current(team);
      return plan ? { team, carrier: plan.carrier, phase: plan.phase, offsideLine: plan.offsideLine,
        jobs: [...plan.assignments.values()].map((a) => ({ player: a.player, job: a.job, mode: a.mode,
          x: a.target.x, z: a.target.z, lane: a.lane, space: a.space })) } : null;
    }),
    events: e.rules.events.slice(-8).reverse(),
    matchSeed: e.matchSeed, lastActionSeed: e.lastActionSeed,
    motionRevision: e.motionRevision,
    motionChanged: currentMotionRevision !== e.motionRevision,
    actionLog: e.actionLog.slice(-8).reverse(),
    passLog: e.passLog.slice(0, 8),
    openPlayKickCount: e.openPlayKickCount,
    outRestartCount: e.outRestartCount,
    outRestartRate: e.outRestartCount / Math.max(1, e.openPlayKickCount + e.outRestartCount),
    contactPct: e.contactTotal ? Math.round((e.contactAligned / e.contactTotal) * 100) : 100,
    contactTotal: e.contactTotal,
    passCharge: e.passCharge, shootCharge: e.shootCharge,
    timeScale: e.timeScale, aimRaw: e.aimRaw, foulsOn: e.foulsOn,
    showAIDebug: e.showAIDebug, showAnimOverlay: e.showAnimOverlay,
    // Coerced: the Settings panel flips this flag through a mutable view of
    // the (type-level readonly) CONFIG, so don't trust the literal type.
    offsideOn: !!CONFIG.ai.offside,
  };
}
