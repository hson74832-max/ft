import { TeamBadge } from "./Badges";
import type { Snapshot } from "../game/engine";


export function Scoreboard({ snap }: { snap: Snapshot }) {
  return (
    <div className="relative select-none">
      <div className="flex h-[54px] items-stretch overflow-hidden rounded-[10px] border border-white/10 bg-[#0b1116]/95 shadow-[0_14px_40px_rgba(0,0,0,.55)] backdrop-blur">
        <div className="flex w-[128px] items-center gap-2 bg-[#0b1116] pl-3 pr-3">
          <TeamBadge team="home" size={30} />
          <span className="font-display text-[20px] font-extrabold tracking-wide text-white">HBC</span>
          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#c8f31d] shadow-[0_0_8px_#c8f31d]" />
        </div>
        <div className="relative grid w-[142px] grid-cols-[6px_1fr_18px_1fr_6px] items-stretch bg-white">
          <div className="bg-[#1c4f9c]" />
          <div className="flex items-center justify-center font-display text-[30px] font-extrabold leading-none text-[#0b1116]">{snap.score[0]}</div>
          <div className="flex items-center justify-center font-display text-[21px] font-extrabold leading-none text-[#68707a]">–</div>
          <div className="flex items-center justify-center font-display text-[30px] font-extrabold leading-none text-[#0b1116]">{snap.score[1]}</div>
          <div className="bg-[#c81e2b]" />
        </div>
        <div className="flex w-[128px] items-center gap-2 bg-[#0b1116] px-3">
          <span className="font-display text-[20px] font-extrabold tracking-wide text-white">RWR</span>
          <TeamBadge team="away" size={30} />
        </div>
        <div className="flex w-[104px] flex-col items-center justify-center bg-gradient-to-b from-[#d6ff38] to-[#b0e00f] px-2 text-black">
          <span className="font-display text-[23px] font-extrabold leading-none tracking-wide tabular-nums">{snap.elapsedClock}</span>
          <span className="mt-0.5 text-[8px] font-black uppercase tracking-[0.14em]">{snap.halfLabel}</span>
        </div>
      </div>
      <div className="absolute -bottom-[9px] left-1/2 h-[3px] w-[62%] -translate-x-1/2 rounded-full bg-gradient-to-r from-transparent via-white/20 to-transparent" />
    </div>
  );
}
