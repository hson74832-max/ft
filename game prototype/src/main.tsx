import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { loadGeneratedMotionPack } from "./game/motion";

// Generated animation set: the motion generator's clips (locomotion cycles, kicks,
// shots, tackles, keeper actions, restarts) bind themselves to their gameplay slots, so
// the prototype plays them without further wiring. Failure is non-fatal — the procedural
// animation stays in place.
//
// The load is AWAITED before the app mounts. Firing it and forgetting meant a match
// started in the first moments could bind procedural clips while a later one bound the
// generated set — different durations and contact frames, chosen by fetch timing. The
// pack is a local static file, so the wait is a few milliseconds on any real connection.
async function boot() {
  try {
    const clips = await loadGeneratedMotionPack();
    if (clips.length) console.info(`[motion] ${clips.length} generated clips linked to gameplay slots`);
  } catch {
    console.info("[motion] generated pack unavailable — procedural animation in use");
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void boot();
