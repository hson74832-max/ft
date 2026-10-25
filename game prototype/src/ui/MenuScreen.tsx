import { useState } from "react";
import { Eye, Play, Shield, Keyboard, Settings, Diamond, Power, ChevronRight } from "lucide-react";
import { ClubCard } from "./Badges";

export type MenuPanel = "design" | "contact" | "teams" | "controls" | "settings" | "motion" | "readme";

interface Props {
  onPlay: () => void;
  onSpectate: () => void;
  onOpen: (panel: MenuPanel) => void;
}

export function MenuScreen({ onPlay, onSpectate, onOpen }: Props) {
  const [showQuit, setShowQuit] = useState(false);
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#05090c] text-white">
      <img src="/images/menu-pitch.jpg" alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" />
      <div className="absolute inset-0 bg-[radial-gradient(120%_100%_at_15%_45%,rgba(4,8,11,.97)_0%,rgba(4,8,11,.84)_34%,rgba(4,8,11,.24)_66%,rgba(4,8,11,.48)_100%)]" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#05090c] via-transparent to-[#05090c]/70" />
      <div className="absolute inset-0 opacity-[0.05] mix-blend-overlay [background-image:repeating-linear-gradient(0deg,#fff_0,#fff_1px,transparent_1px,transparent_3px)]" />

      <div className="relative z-10 flex min-h-screen items-start px-7 pb-16 pt-[13vh] sm:px-8 sm:pt-[15vh]">
        <div className="w-full max-w-[370px]">
          <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.34em] text-[#c8f31d]">Arcade football · 5 v 5</div>
          <h1 className="font-display text-[82px] font-extrabold uppercase leading-[0.8] tracking-[-0.02em] sm:text-[104px]">
            <span className="block text-white drop-shadow-[0_6px_30px_rgba(0,0,0,.65)]">Rush</span>
            <span className="block bg-gradient-to-r from-[#d9ffc7] via-[#a9f4e0] to-[#69d6f4] bg-clip-text text-transparent">Arena</span>
          </h1>
          <p className="mt-4 max-w-[335px] text-[13px] leading-relaxed text-zinc-300/85">
            Fast small-sided football. Four outfielders, one keeper, zero mercy.
          </p>

          <nav className="mt-7 space-y-2">
            <button onClick={onPlay} className="group relative flex min-h-[76px] w-full items-center gap-3 overflow-hidden rounded-[3px] bg-[#c8f31d] px-5 py-3 text-left text-[#0a0f0d] shadow-[0_10px_40px_rgba(200,243,29,.18)] transition hover:brightness-105">
              <Play className="h-[18px] w-[18px] fill-current" />
              <span className="min-w-0 flex-1">
                <span className="block font-display text-[20px] font-extrabold uppercase leading-none tracking-wide">Play Match</span>
                <span className="mt-1 block truncate text-[11px] font-semibold text-[#22300a]/75">Harbor City vs Redwood Rangers</span>
              </span>
              <ChevronRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </button>
            <MenuButton icon={<Eye className="h-[18px] w-[18px]" />} title="Watch CPU vs CPU" subtitle="Spectate an AI match" onClick={onSpectate} />
            <MenuButton icon={<Shield className="h-[18px] w-[18px]" />} title="Team Selection" onClick={() => onOpen("teams")} />
            <MenuButton icon={<Keyboard className="h-[18px] w-[18px]" />} title="Controls" onClick={() => onOpen("controls")} />
            <MenuButton icon={<Settings className="h-[18px] w-[18px]" />} title="Settings" onClick={() => onOpen("settings")} />
            <MenuButton icon={<Diamond className="h-[18px] w-[18px]" />} title="Motion Lab" subtitle="Import & preview .json motion clips" onClick={() => onOpen("motion")} />
            <MenuButton icon={<Power className="h-[18px] w-[18px]" />} title="Quit" onClick={() => { window.close(); setShowQuit(true); }} />
          </nav>

          <div className="mt-4 flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-bold uppercase tracking-[0.12em] text-zinc-500">
            <button onClick={() => onOpen("design")} className="hover:text-[#c8f31d]">Design doc</button>
            <button onClick={() => onOpen("readme")} className="hover:text-[#c8f31d]">Rulebook</button>
            <button onClick={() => onOpen("contact")} className="hover:text-[#c8f31d]">Pose tests</button>
          </div>
          <p className="mt-4 max-w-[335px] text-[9px] leading-relaxed text-zinc-600">Keyboard & gamepad supported · Original game — no licensed teams or players</p>
        </div>

        <div className="absolute bottom-4 right-5 hidden lg:block xl:right-8">
          <ClubCard spectator={false} className="w-[300px]" />
        </div>
      </div>

      <div className="absolute bottom-5 left-8 hidden text-[9px] uppercase tracking-[0.18em] text-white/25 lg:block">Press Enter · Play · Build 0.9</div>
      {showQuit && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-w-sm rounded-lg border border-white/10 bg-[#0b1014] p-5 text-center shadow-2xl">
            <h2 className="font-display text-xl font-extrabold uppercase text-white">Exit Rush Arena?</h2>
            <p className="mt-2 text-xs leading-relaxed text-zinc-400">Browsers only allow a game to close a tab it opened. Close this tab to quit, or return to the menu.</p>
            <button onClick={() => setShowQuit(false)} className="mt-4 w-full rounded bg-[#c8f31d] py-2 font-display text-sm font-extrabold uppercase text-black">Back to menu</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuButton({ icon, title, subtitle, onClick }: { icon: React.ReactNode; title: string; subtitle?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex min-h-[56px] w-full items-center gap-3 rounded-[3px] border-l-2 border-transparent bg-[#0c1114]/85 px-4 py-2.5 text-left transition hover:border-[#c8f31d] hover:bg-[#111a1d]/95">
      <span className="text-zinc-300 group-hover:text-[#c8f31d]">{icon}</span>
      <span className="min-w-0">
        <span className="block font-display text-[16px] font-bold uppercase tracking-[0.08em] text-white">{title}</span>
        {subtitle && <span className="block truncate text-[10px] text-zinc-500">{subtitle}</span>}
      </span>
      <ChevronRight className="ml-auto h-4 w-4 text-zinc-600 transition group-hover:translate-x-0.5 group-hover:text-[#c8f31d]" />
    </button>
  );
}
