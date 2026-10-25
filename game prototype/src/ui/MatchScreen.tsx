import { Bug, Camera, Eye, Flag, Gauge, Menu as MenuIcon, Pause, Play, RotateCcw, Users, X } from "lucide-react";
import type { Snapshot } from "../game/engine";
import type { MatchEngine } from "../game/engine";
import { Scoreboard } from "./Scoreboard";
import { RushMark } from "./Badges";

interface Props {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  snap: Snapshot | null;
  paused: boolean;
  debugOpen: boolean;
  onDebug: () => void;
  onPause: (paused: boolean) => void;
  onRestart: () => void;
  onMenu: () => void;
  onSwitch: () => void;
  engine: () => MatchEngine;
}

export function MatchScreen({ canvasRef, snap, paused, debugOpen, onDebug, onPause, onRestart, onMenu, onSwitch, engine }: Props) {
  const spectator = !!snap?.spectator;
  return (
    <div className="relative h-screen w-full overflow-hidden bg-[#05090c] text-white">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* top scrim */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[110px] bg-gradient-to-b from-black/75 to-transparent" />

      <div className="absolute left-4 top-3 z-20 flex items-center gap-2">
        <RushMark size={20} />
        <button onClick={onMenu} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/55 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-300 backdrop-blur hover:border-white/25 hover:text-white">
          <MenuIcon className="h-3 w-3" /> Menu
        </button>
        <button onClick={() => onPause(!paused)} className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/55 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-300 backdrop-blur hover:border-white/25 hover:text-white">
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />} {paused ? "Resume" : "Pause"}
        </button>
      </div>

      <div className="absolute left-1/2 top-3 z-20 origin-top -translate-x-1/2 scale-[0.78] sm:scale-100">
        {snap ? <Scoreboard snap={snap} /> : <div className="h-[54px] w-[454px] animate-pulse rounded-[10px] bg-white/10" />}
      </div>

      <div className="absolute right-4 top-3 z-20 flex items-center gap-1.5">
        <QuickBtn icon={<Camera className="h-3.5 w-3.5" />} label={snap?.cameraMode ?? "broadcast"} onClick={() => { const e = engine(); e.cameraMode = e.cameraMode === "broadcast" ? "follow" : e.cameraMode === "follow" ? "free" : "broadcast"; }} />
        <QuickBtn icon={<Eye className="h-3.5 w-3.5" />} label={spectator ? "spectating" : "playing"} active={spectator} onClick={() => { engine().spectator = !engine().spectator; }} />
        <QuickBtn icon={<Users className="h-3.5 w-3.5" />} label="switch" onClick={onSwitch} />
        <QuickBtn icon={<RotateCcw className="h-3.5 w-3.5" />} label="reset" onClick={() => engine().resetPositions("kickoff")} />
        <QuickBtn icon={<Bug className="h-3.5 w-3.5" />} label="data" active={debugOpen} onClick={onDebug} />
      </div>

      {/* possession / phase strip */}
      <div className="absolute left-4 top-[58px] z-10 flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider">
        <span className="rounded border border-white/10 bg-black/55 px-2 py-1 text-zinc-300">Ball <b className={snap?.possession === "RED" ? "text-red-400" : snap?.possession === "BLUE" ? "text-sky-400" : "text-zinc-400"}>{snap?.possession ?? "—"}</b></span>
        <span className="rounded border border-white/10 bg-black/55 px-2 py-1 text-zinc-300">{snap?.phase ?? "KICKOFF"}</span>
        <span className="rounded border border-white/10 bg-black/55 px-2 py-1 text-zinc-500">SEED {snap?.matchSeed ?? "—"}</span>
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
            <div className="text-[11px] text-zinc-300">{snap.restartKind === "goal_kick" ? "Keeper to take from the goal area" : snap.restartKind === "throw_in" ? "Throw-in at the exit point" : snap.restartKind === "corner" ? "Corner flag delivery" : "Players setting up"}</div>
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
      {snap?.phase === "HALFTIME" && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/55">
          <div className="text-center">
            <div className="font-display text-[13px] font-bold uppercase tracking-[0.32em] text-[#c8f31d]">Half time</div>
            <div className="font-display text-6xl font-extrabold">HBC {snap.score[0]} <span className="text-zinc-600">–</span> {snap.score[1]} RWR</div>
            <div className="mt-1 text-xs text-zinc-400">Ends swap · {snap.initialKickoffTeam === 0 ? "RWR" : "HBC"} to restart</div>
          </div>
        </div>
      )}

      {/* control hints */}
      <div className="absolute bottom-3 left-4 z-10 hidden max-w-[430px] items-center gap-3 rounded-md border border-white/10 bg-black/55 px-3 py-2 text-[10px] text-zinc-300 backdrop-blur md:flex">
        <span className="font-bold text-white">#{snap?.humanIdx ?? 4} RED {snap?.humanRole ?? "FWD"}</span>
        <Key k="WASD" d="move" /><Key k="SHIFT" d="sprint" /><Key k="SPACE" d="pass" /><Key k="E" d="shoot" /><Key k="Q" d="through" /><Key k="F" d="tackle" /><Key k="X" d="switch" />
      </div>

      {/* charge + player chip */}
      <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
        {snap && (snap.passCharge > 0 || snap.shootCharge > 0) ? (
          <div className="flex gap-2 rounded-md border border-white/10 bg-black/70 p-2 backdrop-blur">
            {snap.passCharge > 0 && <Meter label="PASS" value={snap.passCharge} color="bg-sky-400" />}
            {snap.shootCharge > 0 && <Meter label="SHOOT" value={snap.shootCharge} color="bg-[#c8f31d]" />}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/55 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400 backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-[#c8f31d]" /> {snap?.spectator ? "Spectating" : "You control"} · HBC {snap?.humanRole ?? "FWD"}
            <span className="text-zinc-600">FPS {snap?.fps ?? 60}</span>
          </div>
        )}
      </div>

      {/* FPS / telemetry bottom right */}
      <div className="absolute bottom-3 right-4 z-10 flex items-center gap-2 text-[9px] font-bold uppercase tracking-wider text-zinc-500">
        <span className="rounded border border-white/10 bg-black/55 px-2 py-1"><Gauge className="mr-1 inline h-3 w-3" />{snap?.fps ?? 60} FPS</span>
        <span className="rounded border border-white/10 bg-black/55 px-2 py-1">{snap?.contactPct ?? 100}% contact · {snap?.contactTotal ?? 0}</span>
        <span className="rounded border border-white/10 bg-black/55 px-2 py-1"><Flag className="mr-1 inline h-3 w-3" />offside {snap?.offsideOn ? "on" : "off"}</span>
      </div>

      {debugOpen && snap && <DebugDrawer snap={snap} engine={engine} onClose={onDebug} />}

      {paused && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[380px] rounded-xl border border-white/10 bg-[#0c1216] p-5 shadow-2xl">
            <div className="font-display text-[13px] font-bold uppercase tracking-[0.3em] text-[#c8f31d]">Paused</div>
            <div className="mt-1 font-display text-3xl font-extrabold">HBC {snap?.score[0] ?? 0} – {snap?.score[1] ?? 0} RWR</div>
            <div className="text-[11px] text-zinc-400">{snap?.elapsedClock} · {snap?.halfLabel} · seed {snap?.matchSeed}</div>
            <div className="mt-4 space-y-2">
              <button onClick={() => onPause(false)} className="w-full rounded bg-[#c8f31d] py-2 font-display text-sm font-extrabold uppercase tracking-wide text-black">Resume match</button>
              <button onClick={onRestart} className="w-full rounded border border-white/10 bg-white/5 py-2 font-display text-sm font-bold uppercase tracking-wide text-white hover:bg-white/10">Restart match</button>
              <button onClick={onMenu} className="w-full rounded border border-white/10 bg-white/5 py-2 font-display text-sm font-bold uppercase tracking-wide text-zinc-300 hover:bg-white/10">Return to menu</button>
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
            <div className="text-[11px] text-zinc-400">Seed {snap.matchSeed} · 10 players · no soft-locks</div>
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

function QuickBtn({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} title={label} className={`flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide backdrop-blur ${active ? "border-[#c8f31d] bg-[#c8f31d] text-black" : "border-white/10 bg-black/55 text-zinc-300 hover:border-white/25 hover:text-white"}`}>
      {icon}<span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function Key({ k, d }: { k: string; d: string }) {
  return <span className="whitespace-nowrap"><b className="rounded bg-white/10 px-1 py-0.5 font-mono text-[9px] text-white">{k}</b> <span className="text-zinc-400">{d}</span></span>;
}

function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="w-32">
      <div className="mb-0.5 text-[9px] font-black tracking-wider text-zinc-300">{label}</div>
      <div className="h-1.5 overflow-hidden rounded bg-white/10"><div className={`h-full ${color}`} style={{ width: `${value * 100}%` }} /></div>
    </div>
  );
}

function DebugDrawer({ snap, engine, onClose }: { snap: Snapshot; engine: () => MatchEngine; onClose: () => void }) {
  return (
    <div className="absolute bottom-0 right-0 top-0 z-30 flex w-[330px] flex-col border-l border-white/10 bg-[#0a0f12]/95 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-display text-[13px] font-bold uppercase tracking-[0.2em] text-[#c8f31d]">Match Data</span>
        <button onClick={onClose} className="rounded border border-white/10 p-1 text-zinc-400 hover:text-white"><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-[11px]">
        <section className="rounded-md border border-white/10 bg-white/[0.03] p-2 font-mono">
          <Label>Animation · player #{snap.selIdx} {snap.selRole}</Label>
          <Row k="state" v={snap.anim.state} /><Row k="clip" v={snap.anim.clip} />
          <div className="my-1 h-1 overflow-hidden rounded bg-white/10"><div className="h-full bg-[#c8f31d]" style={{ width: `${snap.anim.nt * 100}%` }} /></div>
          <Row k="nt" v={snap.anim.nt.toFixed(2)} /><Row k="blend" v={snap.anim.blend.toFixed(2)} />
          <Row k="speed" v={`${snap.anim.speed.toFixed(2)} m/s`} /><Row k="weights" v={snap.anim.weights} />
          <Row k="contact" v={snap.anim.contactFired ? "ball_contact ✓" : "—"} />
          <Row k="match seed" v={String(snap.matchSeed)} />
          <Row k="action seed" v={String(snap.lastActionSeed ?? "—")} />
          <Row k="restart" v={snap.restartKind ? `${snap.restartKind} · T${snap.restartTeam}` : "open play"} />
        </section>
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
            <input type="range" min={0.1} max={2} step={0.05} value={snap.timeScale} onChange={(e) => { engine().timeScale = +e.target.value; }} className="w-full accent-[#c8f31d]" />
          </label>
          <button onClick={() => { engine().aimRaw = !engine().aimRaw; }} className="w-full rounded bg-white/5 px-2 py-1 text-left text-[10px] font-bold">Raw aim: {snap.aimRaw ? "ON" : "OFF"}</button>
          <button onClick={() => { engine().foulsOn = !engine().foulsOn; }} className="w-full rounded bg-white/5 px-2 py-1 text-left text-[10px] font-bold">Fouls: {snap.foulsOn ? "ON" : "OFF"}</button>
          <button onClick={() => { engine().showAIDebug = !engine().showAIDebug; }} className="w-full rounded bg-white/5 px-2 py-1 text-left text-[10px] font-bold">AI target lines: {engine().showAIDebug ? "ON" : "OFF"}</button>
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
