import { Bug, Camera, Eye, RotateCcw, Users, X } from "lucide-react";
import type { Snapshot } from "../game/engine";
import type { MatchEngine } from "../game/engine";
import { Scoreboard } from "./Scoreboard";

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  snap: Snapshot | null;
  paused: boolean;
  debugOpen: boolean;
  showFps: boolean;
  onDebug: () => void;
  onPause: (paused: boolean) => void;
  onRestart: () => void;
  onMenu: () => void;
  onSwitch: () => void;
  onShowFps: (show: boolean) => void;
  /** Null until the App effect has constructed the engine (first paint). */
  engine: () => MatchEngine | null;
}

export function MatchScreen({ canvasRef, snap, paused, debugOpen, showFps, onDebug, onPause, onRestart, onMenu, onSwitch, onShowFps, engine }: Props) {
  const spectator = !!snap?.spectator;
  return (
    <div className="relative h-screen w-full overflow-hidden bg-[#05090c] text-white">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* FPS — optional, top left, never part of the play area */}
      {showFps && (
        <div className="pointer-events-none absolute left-4 top-3 z-20 rounded border border-white/10 bg-black/55 px-2 py-1 font-mono text-[10px] font-bold text-[#c8f31d] backdrop-blur">
          {snap?.fps ?? 60} FPS
        </div>
      )}

      <div className="absolute left-1/2 top-3 z-20 origin-top -translate-x-1/2 scale-[0.78] sm:scale-100">
        {snap ? <Scoreboard snap={snap} /> : <div className="h-[54px] w-[454px] animate-pulse rounded-[10px] bg-white/10" />}
      </div>

      {/* Shot / pass power. Lives under the scoreboard so the play area stays clear. */}
      {snap && (snap.passCharge > 0 || snap.shootCharge > 0) && (
        <div className="pointer-events-none absolute left-1/2 top-[86px] z-20 flex -translate-x-1/2 gap-2 rounded-md border border-white/10 bg-black/70 p-2 backdrop-blur">
          {snap.passCharge > 0 && <Meter label="PASS" value={snap.passCharge} color="bg-sky-400" />}
          {snap.shootCharge > 0 && <Meter label="SHOOT" value={snap.shootCharge} color="bg-[#c8f31d]" />}
        </div>
      )}

      <div className="absolute right-4 top-3 z-20 flex items-center gap-1.5">
        <QuickBtn icon={<Camera className="h-3.5 w-3.5" />} label={snap?.cameraMode ?? "broadcast"} onClick={() => { const e = engine(); if (e) e.cameraMode = e.cameraMode === "broadcast" ? "follow" : e.cameraMode === "follow" ? "free" : "broadcast"; }} />
        <QuickBtn icon={<Eye className="h-3.5 w-3.5" />} label={spectator ? "spectating" : "playing"} active={spectator} onClick={() => { const e = engine(); if (e) e.spectator = !e.spectator; }} />
        <QuickBtn icon={<Users className="h-3.5 w-3.5" />} label="switch" onClick={onSwitch} />
        <QuickBtn icon={<RotateCcw className="h-3.5 w-3.5" />} label="reset" onClick={() => engine()?.resetPositions("kickoff")} />
        <QuickBtn icon={<Bug className="h-3.5 w-3.5" />} label="data" active={debugOpen} onClick={onDebug} />
      </div>

      {/* centre banners */}
      {snap?.phase === "GOAL" && (
        <div className="pointer-events-none absolute inset-x-0 top-[118px] z-20 flex justify-center">
          <div className="animate-[banner_.35s_ease-out] -skew-x-6 rounded-sm bg-[#c8f31d] px-8 py-2 shadow-[0_16px_50px_rgba(200,243,29,.25)]">
            <div className="skew-x-6 font-display text-[30px] font-extrabold uppercase italic leading-none text-black">Goal · HBC {snap.score[0]} – {snap.score[1]} RWR</div>
          </div>
        </div>
      )}
      {snap?.phase === "SETUP" && (
        <div className="pointer-events-none absolute inset-x-0 top-[118px] z-20 flex justify-center">
          <div className="rounded-md border border-[#c8f31d]/35 bg-black/80 px-4 py-2 text-center backdrop-blur">
            <div className="text-[10px] font-black uppercase tracking-[0.2em] text-[#c8f31d]">Restart · {(snap.restartKind ?? "kickoff").replace("_", " ")}</div>
            <div className="text-[11px] text-zinc-300">{snap.restartKind === "goal_kick" ? "Keeper to take from the goal area" : snap.restartKind === "throw_in" ? "Throw-in at the exit point" : snap.restartKind === "corner" ? "Corner flag delivery" : snap.restartKind === "free_kick" ? "Wall set — free kick" : snap.restartKind === "penalty" ? "Penalty" : "Players setting up"}</div>
          </div>
        </div>
      )}
      {snap?.phase === "INPLAY" && snap.restartKind && (
        <div className="pointer-events-none absolute inset-x-0 top-[118px] z-20 flex justify-center">
          <div className="rounded-md border border-yellow-400/25 bg-black/75 px-3 py-1.5 text-[10px] font-bold text-yellow-200">
            {snap.restartWait || `Restart ready · ${(snap.restartKind as string).replace("_", " ")}`}
          </div>
        </div>
      )}
      {/* Disciplinary state: who is booked and who is serving a blue card. */}
      {snap && snap.cards.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 gap-1.5">
          {snap.cards.map((c) => (
            <div key={c.idx} className="flex items-center gap-1 rounded border border-white/10 bg-black/70 px-1.5 py-0.5 font-mono text-[9px] font-bold backdrop-blur">
              <span className="h-3 w-2 rounded-[1px] bg-[#f2d21a]" title={`${c.yellow} yellow`} />
              {c.blueRemaining > 0 && <span className="h-3 w-2 rounded-[1px] bg-[#2ea8ff]" />}
              <span className={c.team === 0 ? "text-[#ff8b6b]" : "text-[#9fd4ff]"}>{c.team === 0 ? "HBC" : "RWR"}</span>
              <span className="text-zinc-300">#{c.idx} {c.role}</span>
              {c.blueRemaining > 0 && <span className="text-[#2ea8ff]">{Math.ceil(c.blueRemaining)}s</span>}
            </div>
          ))}
        </div>
      )}
      {snap?.phase === "HALFTIME" && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/55">
          <div className="text-center">
            <div className="font-display text-[13px] font-bold uppercase tracking-[0.32em] text-[#c8f31d]">Half time</div>
            <div className="font-display text-6xl font-extrabold">HBC {snap.score[0]} <span className="text-zinc-600">–</span> {snap.score[1]} RWR</div>
            <div className="mt-1 text-xs text-zinc-400">Ends swap · {snap.initialKickoffTeam === 0 ? "RWR" : "HBC"} to restart</div>
          </div>
        </div>
      )}

      {debugOpen && snap && <DebugDrawer snap={snap} engine={engine} onClose={onDebug} />}

      {/* Start / Esc pauses the match and opens the menu. */}
      {paused && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[380px] rounded-xl border border-white/10 bg-[#0c1216] p-5 shadow-2xl">
            <div className="font-display text-[13px] font-bold uppercase tracking-[0.3em] text-[#c8f31d]">Paused</div>
            <div className="mt-1 font-display text-3xl font-extrabold">HBC {snap?.score[0] ?? 0} – {snap?.score[1] ?? 0} RWR</div>
            <div className="text-[11px] text-zinc-400">{pausedHint(snap)}</div>
            <div className="mt-4 space-y-2">
              <button onClick={() => onPause(false)} className="w-full rounded bg-[#c8f31d] py-2 font-display text-sm font-extrabold uppercase tracking-wide text-black">Resume match</button>
              <button onClick={onRestart} className="w-full rounded border border-white/10 bg-white/5 py-2 font-display text-sm font-bold uppercase tracking-wide text-white hover:bg-white/10">Restart match</button>
              <button onClick={onMenu} className="w-full rounded border border-white/10 bg-white/5 py-2 font-display text-sm font-bold uppercase tracking-wide text-zinc-300 hover:bg-white/10">Return to menu</button>
              <button onClick={() => onShowFps(!showFps)} className="flex w-full items-center justify-between rounded border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-zinc-300 hover:bg-white/10">
                <span>FPS counter</span>
                <span className={`flex h-4 w-8 items-center rounded-full p-0.5 ${showFps ? "bg-[#c8f31d]" : "bg-zinc-600"}`}><span className={`h-3 w-3 rounded-full bg-white transition-all ${showFps ? "ml-auto" : ""}`} /></span>
              </button>
            </div>
          </div>
        </div>
      )}

      {snap?.phase === "FULLTIME" && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/80 backdrop-blur">
          <div className="w-[440px] rounded-xl border border-white/10 bg-[#0c1216] p-6 text-center shadow-2xl">
            <div className="font-display text-[12px] font-bold uppercase tracking-[0.34em] text-[#c8f31d]">Full time</div>
            <div className="my-2 flex items-center justify-center gap-4 font-display text-5xl font-extrabold">
              <span>HBC</span><span className="rounded bg-white px-3 py-1 text-4xl text-black">{snap.score[0]} – {snap.score[1]}</span><span>RWR</span>
            </div>
            <div className="text-[11px] text-zinc-400">{snap.halfLabel} · 10 players · no soft-locks</div>
            <div className="mt-5 flex gap-2">
              <button onClick={onRestart} className="flex-1 rounded bg-[#c8f31d] py-2.5 font-display text-sm font-extrabold uppercase tracking-wide text-black">Rematch</button>
              <button onClick={onMenu} className="flex-1 rounded border border-white/15 bg-white/5 py-2.5 font-display text-sm font-bold uppercase tracking-wide">Menu</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pausedHint(snap: Snapshot | null) {
  if (!snap) return "Escape or Start resumes";
  return `${snap.elapsedClock} · ${snap.halfLabel} · Esc / Start resumes`;
}

function QuickBtn({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} title={label} className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide backdrop-blur ${active ? "border-[#c8f31d] bg-[#c8f31d] text-black" : "border-white/10 bg-black/55 text-zinc-300 hover:border-white/25 hover:text-white"}`}>
      {icon}<span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="w-32">
      <div className="mb-0.5 text-[9px] font-black tracking-wider text-zinc-300">{label}</div>
      <div className="h-1.5 overflow-hidden rounded bg-white/10"><div className={`h-full ${color}`} style={{ width: `${value * 100}%` }} /></div>
    </div>
  );
}

function DebugDrawer({ snap, engine, onClose }: { snap: Snapshot; engine: () => MatchEngine | null; onClose: () => void }) {
  return (
    <div className="absolute bottom-0 right-0 top-0 z-30 flex w-[330px] flex-col border-l border-white/10 bg-[#0a0f12]/95 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-display text-[13px] font-bold uppercase tracking-[0.2em] text-[#c8f31d]">Match Data</span>
        <button onClick={onClose} className="rounded border border-white/10 p-1 text-zinc-400 hover:text-white"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[11px]">
        {snap.showAnimOverlay && <section className="rounded-md border border-white/10 bg-white/[0.03] p-2 font-mono">
          <Label>Animation · player #{snap.selIdx} {snap.selRole}</Label>
          <Row k="state" v={snap.anim.state} /><Row k="clip" v={snap.anim.clip} />
          <div className="my-1 h-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-[#c8f31d]" style={{ width: `${snap.anim.nt * 100}%` }} /></div>
          <Row k="nt" v={snap.anim.nt.toFixed(2)} /><Row k="blend" v={snap.anim.blend.toFixed(2)} />
          <Row k="speed" v={`${snap.anim.speed.toFixed(2)} m/s`} /><Row k="weights" v={snap.anim.weights} />
          <Row k="contact" v={snap.anim.contactFired ? "ball_contact ✓" : "—"} />
          <Row k="match seed" v={String(snap.matchSeed)} />
          <Row k="action seed" v={snap.lastActionSeed === null ? "—" : `0x${snap.lastActionSeed.toString(16)}`} />
          <Row k="motion" v={snap.motionChanged ? `changed since kickoff (rev ${snap.motionRevision})` : `rev ${snap.motionRevision}`} />
          <Row k="restart" v={snap.restartKind ? `${snap.restartKind} · T${snap.restartTeam}` : "open play"} />
        </section>}
        <section>
          <Label>Action seed log</Label>
          <div className="max-h-24 overflow-y-auto rounded border border-white/10 bg-black/40 p-1 font-mono text-[9px] text-zinc-400">
            {snap.actionLog.length === 0 && <div className="p-1 text-zinc-600">No action sampled yet.</div>}
            {snap.actionLog.map((a) => (
              <div key={`${a.seed}-${a.t}`} className="flex justify-between gap-2"><span className="text-[#c8f31d]">#{a.player}</span><span className="truncate">{a.action}</span><span className="text-zinc-600">{a.seed.toString(16)}</span></div>
            ))}
          </div>
        </section>
        <section>
          <Label>Named pass verification</Label>
          <div className="mb-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-[9px] text-zinc-500">
            Out restarts / open-play deliveries: <b className="text-zinc-200">{snap.outRestartCount} / {snap.openPlayKickCount}</b>
            <span className="ml-1">({(snap.outRestartRate * 100).toFixed(1)}% of counted exits)</span>
          </div>
          <div className="space-y-1">
            {snap.passLog.length === 0 && <div className="rounded border border-white/10 bg-black/40 p-2 text-[9px] text-zinc-600">No passes recorded yet.</div>}
            {snap.passLog.slice(0, 6).map((pass, index) => (
              <div key={`${pass.t}-${pass.passer}-${index}`} className="flex items-center justify-between gap-1 rounded border border-white/10 bg-white/[0.03] px-2 py-1 font-mono text-[9px]">
                <span>#{pass.passer} → #{pass.receiver}</span>
                <span className="text-[#c8f31d]">{pass.speed.toFixed(1)}m/s</span>
                <span className={pass.aimDot >= 0.99 ? "text-emerald-300" : "text-red-300"}>dot {pass.aimDot.toFixed(3)}</span>
              </div>
            ))}
          </div>
        </section>
        <section>
          <Label>AI decisions</Label>
          <div className="mb-2 border-b border-white/10 pb-2 text-[10px] text-zinc-400">
            Delivered: {snap.tacticalStats.recycles} resets / {snap.tacticalStats.keeperRecycles} to GK / {snap.tacticalStats.penetratingPasses} penetrating
            <div className="text-zinc-500">Shots {snap.tacticalStats.shots} · GK foot controls {snap.tacticalStats.keeperFootControls}</div>
            <div className="text-zinc-500">Tackles {snap.tacticalStats.tacklesAttempted} · won {snap.tacticalStats.tacklesWon} · spilled {snap.tacticalStats.tacklesSpilled} · missed {snap.tacticalStats.tacklesMissed} · fouls {snap.tacticalStats.fouls}</div>
          </div>
          {snap.decisions.map((d) => (
            <div key={d.idx} className="mb-1 rounded border border-white/10 bg-white/[0.03] px-2 py-1">
              <div className="flex items-center gap-1 font-bold"><span className={`h-1.5 w-1.5 rounded-full ${d.team === 0 ? "bg-red-500" : "bg-sky-500"}`} /> #{d.idx} {d.role}{d.human ? " · YOU" : ""}</div>
              <div className="text-[10px] leading-snug text-zinc-400">{d.reason}</div>
              {d.job && <div className="font-mono text-[9px] text-[#c8f31d]">{d.job} ({d.target[0].toFixed(1)}, {d.target[1].toFixed(1)})</div>}
              {!!d.passOptions?.length && <details className="mt-1 text-[9px] text-zinc-500">
                <summary className="cursor-pointer">Receiver options</summary>
                {d.passOptions.map((option) => <div key={option.receiver} className="font-mono">
                  #{option.receiver} {option.purpose}: {option.score.toFixed(2)} / lane {option.lane.toFixed(2)} / space {option.space.toFixed(1)}m
                </div>)}
              </details>}
            </div>
          ))}
        </section>
        <section>
          <Label>Rule events</Label>
          {snap.events.map((e) => (
            <div key={e.id} className="mb-1 rounded border border-white/10 bg-white/[0.03] px-2 py-1">
              <span className="font-mono text-[9px] text-zinc-500">[{e.t.toFixed(1)}s]</span> <b className="text-[#e5ff7a]">{e.type}</b>
              <div className="text-[10px] text-zinc-400">{e.detail}</div>
            </div>
          ))}
        </section>
        <section className="space-y-1.5">
          <Label>Tuning</Label>
          <label className="block text-[10px] font-bold">Time scale {(snap.timeScale).toFixed(2)}×
            <input type="range" min={0.1} max={2} step={0.05} value={snap.timeScale} onChange={(ev) => { const e = engine(); if (e) e.timeScale = +ev.target.value; }} className="w-full accent-[#c8f31d]" />
          </label>
          <button onClick={() => { const e = engine(); if (e) e.aimRaw = !e.aimRaw; }} className="w-full rounded bg-white/5 px-2 py-1 text-left text-[10px] font-bold">Raw aim: {snap.aimRaw ? "ON" : "OFF"}</button>
          <button onClick={() => { const e = engine(); if (e) e.foulsOn = !e.foulsOn; }} className="w-full rounded bg-white/5 px-2 py-1 text-left text-[10px] font-bold">Fouls: {snap.foulsOn ? "ON" : "OFF"}</button>
          <button onClick={() => { const e = engine(); if (e) e.showAIDebug = !e.showAIDebug; }} className="w-full rounded bg-white/5 px-2 py-1 text-left text-[10px] font-bold">AI target lines: {snap.showAIDebug ? "ON" : "OFF"}</button>
        </section>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">{children}</div>;
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-2"><span className="text-zinc-500">{k}</span><span className="break-all text-right text-zinc-300">{v}</span></div>;
}
