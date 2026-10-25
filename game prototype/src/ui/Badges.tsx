import { cn } from "../utils/cn";

export function TeamBadge({ team, size = 44, className }: { team: "home" | "away"; size?: number; className?: string }) {
  if (team === "home") {
    return (
      <svg width={size} height={size} viewBox="0 0 64 68" className={cn("drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]", className)}>
        <defs>
          <linearGradient id="hbcBody" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#173a63" />
            <stop offset="1" stopColor="#0a1c33" />
          </linearGradient>
        </defs>
        <path d="M4 6h56v34c0 11-13 19-28 23C17 59 4 51 4 40V6Z" fill="url(#hbcBody)" stroke="#2b4f7a" strokeWidth="2" />
        <rect x="20" y="7" width="8" height="49" fill="#f08a22" opacity="0.95" />
        <rect x="36" y="7" width="8" height="49" fill="#f08a22" opacity="0.95" />
        <path d="M4 6h56v6H4z" fill="#0b1626" opacity=".55" />
        <text x="32" y="40" textAnchor="middle" fontFamily="Barlow Condensed, sans-serif" fontWeight="800" fontSize="22" fill="#f8fafc" letterSpacing="1">HBC</text>
        <path d="M4 6h56v34c0 11-13 19-28 23C17 59 4 51 4 40V6Z" fill="none" stroke="#f8b464" strokeOpacity=".25" strokeWidth="1" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 64 68" className={cn("drop-shadow-[0_2px_6px_rgba(0,0,0,0.55)]", className)}>
      <defs>
        <linearGradient id="rwrBody" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e8eef4" />
          <stop offset="1" stopColor="#b9c6d4" />
        </linearGradient>
        <linearGradient id="rwrSash" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#c81e2b" />
          <stop offset="1" stopColor="#8f0f19" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="34" r="28" fill="url(#rwrBody)" stroke="#eef4fa" strokeWidth="2" />
      <path d="M12 48c8-6 30-18 40-32l7 8c-10 15-31 27-40 31l-7-7Z" fill="url(#rwrSash)" />
      <circle cx="32" cy="34" r="22" fill="none" stroke="#0b1626" strokeOpacity=".18" strokeWidth="1.5" />
      <text x="32" y="40" textAnchor="middle" fontFamily="Barlow Condensed, sans-serif" fontWeight="800" fontSize="20" fill="#1c2733" letterSpacing="1">RWR</text>
    </svg>
  );
}

export function ClubCard({ className, spectator }: { className?: string; spectator?: boolean }) {
  return (
    <div className={cn("rounded-2xl border border-white/10 bg-[#0b0f13]/90 px-5 py-4 backdrop-blur-md shadow-[0_20px_60px_rgba(0,0,0,.6)]", className)}>
      <div className="flex items-center gap-5">
        <div className="flex flex-col items-center gap-1 w-[104px]">
          <TeamBadge team="home" size={52} />
          <div className="font-display text-[17px] leading-none font-bold text-white">Harbor City</div>
          <div className="flex items-center gap-1">
            <span className="rounded bg-[#c8f31d] px-1.5 py-[1px] text-[9px] font-black text-black">HOME</span>
            <span className="text-[9px] font-semibold text-zinc-500">OVR 72</span>
          </div>
        </div>
        <div className="font-display text-2xl font-bold text-zinc-600">VS</div>
        <div className="flex flex-col items-center gap-1 w-[104px]">
          <TeamBadge team="away" size={52} />
          <div className="font-display text-[17px] leading-none font-bold text-white">Redwood Rangers</div>
          <div className="flex items-center gap-1">
            <span className="rounded bg-white/15 px-1.5 py-[1px] text-[9px] font-black text-white">AWAY</span>
            <span className="text-[9px] font-semibold text-zinc-500">OVR 72</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2 border-t border-white/5 pt-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        <span className={spectator ? "text-emerald-300" : ""}>{spectator ? "Spectator build" : "Coach build"}</span>
        <span className="text-zinc-700">/</span>
        <span>4 outfield + 1 GK</span>
      </div>
    </div>
  );
}

export function RushMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <path d="M16 2 30 16 16 30 2 16 16 2Z" fill="#c8f31d" />
      <path d="M16 9 23 16 16 23 9 16 16 9Z" fill="#0a0f0d" />
      <circle cx="16" cy="16" r="3" fill="#c8f31d" />
    </svg>
  );
}
