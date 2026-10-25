// ?debug=ai instrumentation: event log and the per-frame decision trace table.
import * as THREE from "three";
import type { MatchHost } from "./host";

/** ?debug=ai event (possession grant, kick release, cancellations). */
export function aiEvent(e: MatchHost, message: string) {
  if (!e.debugAI) return;
  const line = `[${e.clock.toFixed(2)}s] ${message}`;
  e.aiEventTotal++;
  e.aiEventLog.unshift(line);
  if (e.aiEventLog.length > 60) e.aiEventLog.pop();
  console.log("%c[ai]", "color:#c8f31d", line);
}

/** Dump the per-player decision table once a second of wall time. */
export function flushAITrace(e: MatchHost, realDt: number) {
  e.aiTraceLogT += realDt;
  if (e.aiTraceLogT < 1) return; // one table per second of wall time
  e.aiTraceLogT = 0;
  const rows = [...e.aiTrace.values()];
  console.groupCollapsed(`[ai] t=${e.clock.toFixed(1)}s phase=${e.rules.phase} owner=${e.ball.possessedBy ?? "free"} restart=${e.rules.pendingRestart?.kind ?? "-"}`);
  console.table(rows);
  // Explicit stall diagnosis so the failing link is named rather than guessed.
  for (const r of rows) {
    if (r.branch === "ai" && !r.thinkCalled) console.warn(`[ai] #${r.idx} AI branch but think() not called`);
    if (r.hasBall && r.branch === "ai" && r.desiredSpeed < 0.5 && !r.animActionId) console.warn(`[ai] #${r.idx} CARRIER STALL: ${r.decisionReason} · start=${r.startActionResult}`);
    if (r.animBusy && r.animActionId && r.animUninterruptible) console.info(`[ai] #${r.idx} locked in ${r.animActionId}`);
    if (r.overwrittenBy) console.info(`[ai] #${r.idx} move target overwritten by ${r.overwrittenBy}`);
  }
  console.groupEnd();
}

/** Draw the AI move-target overlay (one line per player). */
export function updateAIDebug(e: MatchHost) {
  e.aiLines.visible = e.showAIDebug;
  if (!e.showAIDebug) return;
  const needed = e.players.length * 6;
  let attr = e.aiLinePos;
  if (attr.array.length !== needed) {
    // Rosters can change in tests/custom matches; resize rather than writing
    // past a fixed-size typed array or leaving old segments visible.
    attr = new THREE.Float32BufferAttribute(new Float32Array(needed), 3);
    e.aiLinePos = attr;
    e.aiLines.geometry.setAttribute("position", attr);
    e.aiLines.geometry.setDrawRange(0, e.players.length * 2);
  }
  const arr = attr.array as Float32Array;
  e.players.forEach((p, i) => {
    arr[i * 6] = p.pos.x; arr[i * 6 + 1] = 0.3; arr[i * 6 + 2] = p.pos.z;
    arr[i * 6 + 3] = p.moveTarget.x; arr[i * 6 + 4] = 0.3; arr[i * 6 + 5] = p.moveTarget.z;
  });
  attr.needsUpdate = true;
}
