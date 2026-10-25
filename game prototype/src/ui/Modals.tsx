import { useRef, useState } from "react";
import { Download, Upload, X } from "lucide-react";
import { CONFIG, SKELETON_CONTRACT } from "../game/config";
import { getAnimationCatalogue } from "../game/anims";
import { getRegisteredMotionClips, getSlotBindings, loadGeneratedMotionPack } from "../game/motion";
import { poseStressTest } from "../game/playerMesh";
import type { MatchEngine } from "../game/engine";
import { TeamBadge } from "./Badges";

export type Panel = "design" | "contact" | "teams" | "controls" | "settings" | "motion" | "readme";
type FamilyMode = "mixed" | "blocky" | "roundy";

interface Props {
  panel: Panel;
  onClose: () => void;
  family: FamilyMode;
  onFamily: (family: FamilyMode) => void;
  engine: () => MatchEngine | null;
}

export function PanelModal({ panel, onClose, family, onFamily, engine }: Props) {
  const titles: Record<Panel, string> = {
    design: "Design / Architecture", contact: "Pose Contact Sheet", teams: "Team Selection", controls: "Controls",
    settings: "Settings & AI Tuning", motion: "Motion Lab", readme: "Rulebook & README",
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0b1014] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div>
            <div className="text-[9px] font-black uppercase tracking-[0.3em] text-[#c8f31d]">Rush Arena</div>
            <h2 className="font-display text-xl font-extrabold uppercase tracking-wide text-white">{titles[panel]}</h2>
          </div>
          <button onClick={onClose} className="rounded-md border border-white/10 bg-white/5 p-2 text-zinc-400 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 text-[12px] leading-relaxed text-zinc-300">
          {panel === "teams" && <Teams family={family} onFamily={onFamily} />}
          {panel === "controls" && <Controls />}
          {panel === "settings" && <Settings engine={engine} />}
          {panel === "motion" && <MotionLab engine={engine} />}
          {panel === "design" && <Design />}
          {panel === "contact" && <ContactSheet />}
          {panel === "readme" && <Readme />}
        </div>
      </div>
    </div>
  );
}

function Teams({ family, onFamily }: { family: FamilyMode; onFamily: (f: FamilyMode) => void }) {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <TeamPanel team="home" name="Harbor City" code="HBC" role="Home · Red kit" desc="4-1 shape built around a creative midfielder and a pressing forward." />
        <TeamPanel team="away" name="Redwood Rangers" code="RWR" role="Away · Blue kit" desc="Compact block, quick transitions, keeper plays direct under pressure." />
      </div>
      <div>
        <SectionLabel>Mesh family</SectionLabel>
        <div className="grid grid-cols-3 gap-2">
          {(["mixed", "blocky", "roundy"] as FamilyMode[]).map((f) => (
            <button key={f} onClick={() => onFamily(f)} className={`rounded-md border px-3 py-3 text-left ${family === f ? "border-[#c8f31d] bg-[#c8f31d]/10" : "border-white/10 bg-white/[0.03] hover:border-white/25"}`}>
              <div className="font-display text-sm font-bold uppercase text-white">{f}</div>
              <div className="text-[10px] text-zinc-500">{f === "mixed" ? "Alternating skins" : f === "blocky" ? "Cuboid limbs, flat shading" : "Capsule limbs, smooth normals"}</div>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-zinc-500">Both families bind the same 21-bone skeleton; switching rebuilds the match with the same animation set.</p>
      </div>
      <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
        <SectionLabel>Formation · data-defined roles</SectionLabel>
        <div className="grid grid-cols-5 gap-1 text-center text-[10px]">
          {["GK", "DEF", "DEF", "MID", "FWD"].map((r, i) => <div key={i} className="rounded bg-white/5 px-1 py-2 font-bold text-white">{r}</div>)}
        </div>
        <p className="mt-2 text-[10px] text-zinc-500">Roles slide and compress around the ball; back line steps out to close the shooting lane.</p>
      </div>
    </div>
  );
}

function TeamPanel({ team, name, code, role, desc }: { team: "home" | "away"; name: string; code: string; role: string; desc: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center gap-3">
        <TeamBadge team={team} size={46} />
        <div>
          <div className="font-display text-lg font-extrabold leading-none text-white">{name}</div>
          <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">{code} · {role}</div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">{desc}</p>
    </div>
  );
}

function Controls() {
  const rows: [string, string][] = [
    ["WASD / Arrows", "Move controlled player"],
    ["Shift", "Sprint"], ["Space (hold)", "Pass — power builds on hold; tap for short pass"],
    ["E (hold)", "Shoot — medium hold for laces, tap for finesse with Q"],
    ["Q", "Through-ball / finesse modifier"], ["F", "Tackle when off the ball; shield when on it"],
    ["X", "Manual switch to nearest teammate"], ["V", "Toggle CPU vs CPU spectator"],
    ["C", "Camera broadcast → follow → free"], ["T", "Raw aim mode"], ["G", "AI target line visualiser"],
    ["H", "Animation debug overlay"], ["IJKL / UO", "Free camera orbit / zoom"], ["R", "Reset to kickoff"],
  ];
  return (
    <div className="space-y-3">
      <div className="grid gap-1.5 sm:grid-cols-2">
        {rows.map(([k, d]) => (
          <div key={k} className="flex items-center justify-between gap-3 rounded border border-white/10 bg-white/[0.03] px-3 py-2">
            <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">{k}</span>
            <span className="text-right text-[11px] text-zinc-400">{d}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-zinc-500">Aim assist selects the best onside candidate in a 60° cone; raw aim [T] removes the candidate weighting. Offside players are excluded from pass candidates.</p>
    </div>
  );
}

function Settings({ engine }: { engine: () => MatchEngine | null }) {
  const [, tick] = useState(0);
  const ai = CONFIG.ai as unknown as Record<string, number>;
  const e = engine();
  return (
    <div className="space-y-4">
      <div>
        <SectionLabel>AI difficulty</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          {([["reactionDelay", 0.05, 0.7, 0.01], ["decisionNoise", 0, 0.4, 0.01], ["maxSprint", 4, 8, 0.1], ["passError", 0, 0.2, 0.005]] as const).map(([k, min, max, step]) => (
            <label key={k} className="rounded border border-white/10 bg-white/[0.03] p-2 text-[10px] font-bold">
              <span className="flex justify-between text-zinc-400"><span>{k}</span><span className="text-[#c8f31d]">{ai[k]}</span></span>
              <input type="range" min={min} max={max} step={step} value={ai[k]} onChange={(ev) => { ai[k] = +ev.target.value; tick((x) => x + 1); }} className="w-full accent-[#c8f31d]" />
            </label>
          ))}
        </div>
      </div>
      <div>
        <SectionLabel>Rules</SectionLabel>
        <ToggleRow label="Offside enforcement" value={!!ai.offside} onChange={() => { ai.offside = ai.offside ? 0 : 1; tick((x) => x + 1); }} />
        <ToggleRow label="Fouls → free kick / penalty" value={!!e?.foulsOn} disabled={!e} onChange={() => { if (e) { e.foulsOn = !e.foulsOn; tick((x) => x + 1); } }} />
        <ToggleRow label="Raw aim (no pass assist)" value={!!e?.aimRaw} disabled={!e} onChange={() => { if (e) { e.aimRaw = !e.aimRaw; tick((x) => x + 1); } }} />
        <ToggleRow label="AI target-line overlay" value={!!e?.showAIDebug} disabled={!e} onChange={() => { if (e) { e.showAIDebug = !e.showAIDebug; tick((x) => x + 1); } }} />
        <ToggleRow label="Camera: broadcast" value={(e?.cameraMode ?? "broadcast") === "broadcast"} disabled={!e} onChange={() => { if (e) { e.cameraMode = e.cameraMode === "broadcast" ? "follow" : "broadcast"; tick((x) => x + 1); } }} />
      </div>
      <div>
        <SectionLabel>Match</SectionLabel>
        <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-zinc-400">
          <div className="rounded border border-white/10 bg-white/[0.03] p-2">Length <b className="text-white">4:00</b> · 2 halves</div>
          <div className="rounded border border-white/10 bg-white/[0.03] p-2">Pitch <b className="text-white">40 × 25 m</b></div>
          <div className="rounded border border-white/10 bg-white/[0.03] p-2">Goal <b className="text-white">3 × 2 m</b></div>
          <div className="rounded border border-white/10 bg-white/[0.03] p-2">Ball <b className="text-white">0.43 kg · r .11</b></div>
        </div>
        <label className="mt-2 block rounded border border-white/10 bg-white/[0.03] p-2 text-[10px] font-bold">
          <span className="flex justify-between text-zinc-400"><span>Time scale</span><span className="text-[#c8f31d]">{(e?.timeScale ?? 1).toFixed(2)}×</span></span>
          <input type="range" min={0.1} max={2} step={0.05} value={e?.timeScale ?? 1} disabled={!e} onChange={(ev) => { if (e) { e.timeScale = +ev.target.value; tick((x) => x + 1); } }} className="w-full accent-[#c8f31d]" />
        </label>
        {!e && <p className="mt-1 text-[10px] text-zinc-500">In-match toggles apply once a match is running.</p>}
      </div>
    </div>
  );
}

function MotionLab({ engine }: { engine: () => MatchEngine | null }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [drag, setDrag] = useState(false);
  const clips = getRegisteredMotionClips();
  const catalogue = getAnimationCatalogue();

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const text = await file.text();
      let clip;
      if (engine()) clip = engine()!.importMotionJSON(text, file.name);
      else {
        const { parseFieldMotionJSON, registerFieldMotionClip, validateFieldMotionAgainstSkeleton } = await import("../game/motion");
        clip = parseFieldMotionJSON(text, file.name);
        const errors = validateFieldMotionAgainstSkeleton(clip);
        if (errors.length) throw new Error(errors.join("; "));
        registerFieldMotionClip(clip);
      }
      setMessage(`Imported ${clip.id} · ${clip.frames.length} frames · ${clip.duration.toFixed(2)}s${!engine() ? " (registered — start a match to preview)" : ""}`);
      setError(""); setTick((x) => x + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  };

  // The animation pack produced by the motion generator (tool/src/gameclip.ts). It is
  // already loaded on startup; this re-checks and reports the slot bindings.
  const loadGamePack = async () => {
    try {
      const added = await loadGeneratedMotionPack();
      setMessage(added.length
        ? `Linked ${added.length} generated clips · ${getSlotBindings().length} gameplay slots bound`
        : `Generated pack already linked · ${getSlotBindings().length} gameplay slots bound`);
      setError(""); setTick((x) => x + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Game pack unavailable");
    }
  };

  const loadSample = async () => {
    try {
      const response = await fetch("/motions/sample_fieldmotion.json");
      const text = await response.text();
      await importFile(new File([text], "sample_fieldmotion.json", { type: "application/json" }));
    } catch { setError("Sample clip unavailable"); }
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(ev) => { ev.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(ev) => { ev.preventDefault(); setDrag(false); void importFile(ev.dataTransfer.files?.[0]); }}
        className={`rounded-lg border-2 border-dashed p-5 text-center ${drag ? "border-[#c8f31d] bg-[#c8f31d]/10" : "border-white/15 bg-white/[0.02]"}`}
      >
        <Upload className="mx-auto mb-2 h-6 w-6 text-[#c8f31d]" />
        <div className="font-display text-base font-bold uppercase tracking-wide text-white">Import FieldMotion v2 JSON</div>
        <p className="mt-1 text-[11px] text-zinc-400">Drop a <span className="font-mono">fieldmotion.pose.v2</span> file. Supports <span className="font-mono">frames[].j</span> tracking positions or <span className="font-mono">frames[].q</span> quaternions, bind pose and bone order.</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <button onClick={() => inputRef.current?.click()} className="rounded bg-[#c8f31d] px-3 py-1.5 text-[11px] font-black uppercase text-black">Choose file</button>
          <button onClick={() => void loadGamePack()} className="rounded border border-[#c8f31d]/40 bg-[#c8f31d]/10 px-3 py-1.5 text-[11px] font-bold text-[#c8f31d]">Load generated game pack</button>
          <button onClick={() => void loadSample()} className="rounded border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] font-bold">Try sample clip</button>
        </div>
        <input ref={inputRef} type="file" accept=".json,application/json" className="hidden" onChange={(ev) => void importFile(ev.target.files?.[0])} />
      </div>
      {message && <div className="rounded border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[11px] text-emerald-200">{message}</div>}
      {error && <div className="rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-[11px] text-red-200">{error}</div>}
      <div>
        <SectionLabel>Loaded clips · {catalogue.length} total ({clips.length} imported)</SectionLabel>
        <div className="max-h-56 space-y-1 overflow-y-auto">
          {clips.length === 0 && <div className="rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-zinc-500">No imported clips yet. Load the sample to verify the pipeline.</div>}
          {clips.map((clip) => (
            <div key={clip.id} className="flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1.5" data-tick={tick}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] font-bold text-[#c8f31d]">{clip.id}</div>
                <div className="text-[10px] text-zinc-500">{clip.meta.category} · {clip.meta.loop ? "loop" : `${clip.duration.toFixed(2)}s`} · {clip.meta.contactFrame !== undefined ? `contact@${clip.meta.contactFrame.toFixed(2)}` : "no contact"} · {clip.source}</div>
              </div>
              <button disabled={!engine()} onClick={() => { if (engine()) engine()!.playClipOnSelected(clip.id); }} className="rounded border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold disabled:opacity-40">Preview</button>
            </div>
          ))}
        </div>
      </div>
      {getSlotBindings().length > 0 && (
        <div>
          <SectionLabel>Slot bindings · {getSlotBindings().length}</SectionLabel>
          <div className="max-h-40 grid grid-cols-2 gap-1 overflow-y-auto text-[10px] font-mono" data-tick={tick}>
            {getSlotBindings().map(({ slot, clip }) => (
              <div key={slot.id} className="truncate rounded border border-white/10 bg-white/[0.03] px-2 py-1">
                <span className="text-white">{slot.id}</span> <span className="text-zinc-500">←</span> <span className="text-[#c8f31d]">{clip.id}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="rounded-md border border-white/10 bg-white/[0.03] p-3 text-[11px]">
        <SectionLabel>Clip metadata contract</SectionLabel>
        <pre className="overflow-x-auto font-mono text-[10px] leading-relaxed text-zinc-400">{`{ format: "fieldmotion.pose.v2", jointOrder: [...21 joints],
  boneOrder: [[parent, child], ...], bindPose: [x,y,z,...],
  frames: [{ t, c, h, j: [...], q?: [...] }],
  metadata: { id, category, loop, rootMotion, duration,
    contactFrame, interruptible: [from,to], priority, tags,
    frameEvents: [{ t, type: "ball_contact" }] } }`}</pre>
        <p className="mt-1 text-zinc-500">Every imported clip must resolve every skeleton bone. Ball contact events are read at the authored <span className="font-mono">contactFrame</span>; AI can only select the clip after it is registered.</p>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-zinc-500"><Download className="h-3.5 w-3.5" /> Motion is sampled on the shared 21-bone rig — both Blocky and Roundy skins play the same clip.</div>
    </div>
  );
}

function Design() {
  return (
    <div className="space-y-4">
      <Block t="Skeleton contract · 21 bones">
        <p>Metres, Y-up, +Z forward. Both mesh families bind identical bone offsets, so retargeting is lossless by construction. Automated validation checks all clips × all variants.</p>
        <div className="mt-1 rounded bg-black/50 p-2 font-mono text-[10px] text-[#c8f31d]">{SKELETON_CONTRACT.bones.map((b) => b.name).join(" · ")}</div>
      </Block>
      <Block t="State machines">
        <p className="font-mono text-[11px]">Match: KICKOFF → SETUP → INPLAY ⇄ GOAL → HALFTIME → INPLAY → FULLTIME</p>
        <p className="font-mono text-[11px]">Restarts: goal_kick, throw_in, corner, free_kick, penalty, kickoff. Ball is locked at the restart spot until the animation contact event releases it.</p>
        <p className="font-mono text-[11px]">Player: locomotion ⇄ action(windup → contact → recover) with interrupt windows + cooldowns. Root motion only for tackles, dives, turns.</p>
      </Block>
      <Block t="Determinism & variety">
        <p>One match seed drives one PRNG for AI decisions and sampled restart targets. Contact resolution never reads that stream. Per-player style weights are sampled once at match start. A novelty term penalises repeating the same choice; stable tie-break hashes prevent iteration-order bias.</p>
      </Block>
      <Block t="Spatial awareness">
        <p>Predicted ball trajectory (drag + gravity) drives loose-ball interceptions. Marker assignments are costed per defender-attacker pair. Support shape applies team spacing, avoids the carrier's channel, respects offside, and clamps to the field. The closest centre-back steps out to block the central shooting lane when threat is detected.</p>
      </Block>
      <Block t="Rules">
        <p>Kickoff: centre spot, chosen taker, opponents outside the centre circle and in their own half, first ball played forward. Whole ball over line / under bar / inside posts for a goal. Goal kicks by the keeper, corners by an outfielder at the flag, throw-ins at the exit point. Restarts wait for exclusion zones to clear. Half-time stops the clock, swaps ends and the other team kicks off. Offside judged at the pass and enforced on involvement. No goal can register while the match is out of play.</p>
      </Block>
      <Block t="Collision">
        <p>Player cylinders (0.40 m outfield, 0.46 m keeper) are resolved positionally each frame with velocity cancellation, then the loose ball is resolved against the same cylinders. No ghosting through bodies or through the ball.</p>
      </Block>
    </div>
  );
}

function ContactSheet() {
  const rows = poseStressTest();
  return (
    <div>
      <p className="mb-2 text-[11px] text-zinc-400">Analytic limb clearance at extreme poses (pass &gt; 0.030 m). Guards shoulder/hip pinch and self-intersection on both mesh families.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {rows.map((r, i) => (
          <div key={i} className="rounded border border-white/10 bg-white/[0.03] p-2">
            <div className="flex items-center justify-between font-bold"><span>{r.variant}</span><span className={`rounded px-1 text-[9px] ${r.pass ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>{r.pass ? "PASS" : "FAIL"}</span></div>
            <div className="font-mono text-[10px] text-zinc-500">{r.pose}</div>
            <div className="mt-1 h-1 overflow-hidden rounded bg-white/10"><div className={`h-full ${r.pass ? "bg-emerald-400" : "bg-red-500"}`} style={{ width: `${Math.min(100, r.clearance * 1200)}%` }} /></div>
            <div className="font-mono text-[10px] text-zinc-500">{r.clearance.toFixed(3)} m</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Readme() {
  return (
    <div className="space-y-4">
      <Block t="Run">
        <p className="font-mono text-[11px] rounded bg-black/50 p-2">npm install · npm run dev · npm run build</p>
        <p>Play Match takes control of HBC (red). Watch CPU vs CPU runs the same build headless of human input. Press <b>V</b> to toggle spectator during a match.</p>
      </Block>
      <Block t="Adding a mocap clip in under 5 minutes">
        <ol className="ml-4 list-decimal space-y-1">
          <li>Open Motion Lab and import a <span className="font-mono">fieldmotion.pose.v2</span> JSON. It is validated against the shared skeleton.</li>
          <li>Add metadata (category, loop, rootMotion, contactFrame, interruptible, priority) inside the file or in the catalogue.</li>
          <li>Use Preview on the selected rig. Confirm the contact event in the animation overlay.</li>
          <li>Gate AI selection on clip existence + cooldown — never branch to a clip that is not registered.</li>
          <li>Check the pose contact sheet, foot-slide threshold and the rule-event log before shipping.</li>
        </ol>
      </Block>
      <Block t="Known fixes in this build">
        <p>Kickoff/restart legality, goal-line test, taker selection, goal-kick penalties clear-out, possession attribution, throw-in repetition guard, half-time end swap, offside involvement, goalkeeper distribution, collision resolution, seeded decision variety and spatial marking/space awareness.</p>
      </Block>
      <Block t="Constraint">
        <p>No offside exemptions for throw-ins, corners or goal kicks — those restarts are exempt by law. A player can be in an offside position at a restart but only penalised if involved after a teammate's pass from open play.</p>
      </Block>
    </div>
  );
}

function Block({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 font-display text-sm font-extrabold uppercase tracking-[0.12em] text-[#c8f31d]">{t}</h3>
      <div className="space-y-1 text-[12px] text-zinc-300">{children}</div>
    </section>
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[9px] font-black uppercase tracking-[0.24em] text-zinc-500">{children}</div>;
}
function ToggleRow({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onChange} className="mb-1 flex w-full items-center justify-between rounded border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] font-bold disabled:opacity-40">
      <span>{label}</span>
      <span className={`flex h-4 w-8 items-center rounded-full p-0.5 ${value ? "bg-[#c8f31d]" : "bg-zinc-600"}`}><span className={`h-3 w-3 rounded-full bg-white transition-all ${value ? "ml-auto" : ""}`} /></span>
    </button>
  );
}
