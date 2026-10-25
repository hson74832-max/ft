import { useCallback, useEffect, useRef, useState } from "react";
import { MatchEngine, type Snapshot } from "./game/engine";
import { MenuScreen, type MenuPanel } from "./ui/MenuScreen";
import { MatchScreen } from "./ui/MatchScreen";
import { PanelModal } from "./ui/Modals";

type FamilyMode = "mixed" | "blocky" | "roundy";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<MatchEngine | null>(null);
  const pausedRef = useRef(false);
  const [screen, setScreen] = useState<"menu" | "match">("menu");
  const [mode, setMode] = useState<"play" | "spectate">("play");
  const [session, setSession] = useState(0);
  const [family, setFamily] = useState<FamilyMode>("mixed");
  const [panel, setPanel] = useState<MenuPanel | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);

  // Mirror into a ref for the rAF loop. Done in an effect, not during render:
  // writing a ref while rendering is unsafe under concurrent rendering (the
  // render may be discarded, leaving the loop reading a pause state that was
  // never committed to the screen).
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const startMatch = useCallback((spectate: boolean) => {
    setPanel(null);
    setMode(spectate ? "spectate" : "play");
    setSnap(null);
    setPaused(false);
    setDebugOpen(false);
    setSession((s) => s + 1);
    setScreen("match");
  }, []);

  const restartMatch = useCallback(() => {
    setSnap(null);
    setPaused(false);
    setDebugOpen(false);
    setSession((s) => s + 1);
  }, []);

  const toMenu = useCallback(() => {
    setScreen("menu");
    setSnap(null);
    setPaused(false);
    engineRef.current = null;
  }, []);

  useEffect(() => {
    if (screen !== "match" || !canvasRef.current) return;
    const eng = new MatchEngine(canvasRef.current, { family, spectator: mode === "spectate" });
    engineRef.current = eng;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!pausedRef.current) eng.step(dt);
      else eng.renderer.render(eng.scene, eng.camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const interval = setInterval(() => {
      if (engineRef.current) setSnap(engineRef.current.snapshot());
    }, 140);
    const onResize = () => eng.resize();
    window.addEventListener("resize", onResize);
    const kick = setTimeout(() => { eng.resize(); setSnap(eng.snapshot()); }, 80);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
      clearTimeout(kick);
      window.removeEventListener("resize", onResize);
      eng.dispose();
      engineRef.current = null;
    };
  }, [screen, session, family, mode]);

  useEffect(() => {
    if (screen !== "menu") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPanel(null); return; }
      if (event.key !== "Enter" || panel) return;
      // Enter on a focused control must activate that control, not also kick
      // off a match behind it.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "BUTTON" || target.tagName === "INPUT" || target.tagName === "A" || target.isContentEditable)) return;
      startMatch(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, startMatch, panel]);

  useEffect(() => {
    if (screen !== "match") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPaused((p) => !p);
      if (event.key === "Tab") { event.preventDefault(); setDebugOpen((d) => !d); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen]);

  if (screen === "menu") {
    return (
      <>
        <MenuScreen onPlay={() => startMatch(false)} onSpectate={() => startMatch(true)} onOpen={setPanel} />
        {panel && (
          <PanelModal
            panel={panel}
            onClose={() => setPanel(null)}
            family={family}
            onFamily={(next) => { setFamily(next); }}
            engine={() => engineRef.current}
          />
        )}
      </>
    );
  }

  return (
    <>
      <MatchScreen
        canvasRef={canvasRef}
        snap={snap}
        paused={paused}
        debugOpen={debugOpen}
        onDebug={() => setDebugOpen((d) => !d)}
        onPause={setPaused}
        onRestart={restartMatch}
        onMenu={toMenu}
        onSwitch={() => engineRef.current?.switchToNearest(true)}
        engine={() => engineRef.current}
      />
    </>
  );
}
