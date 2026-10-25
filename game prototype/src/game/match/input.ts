// Keyboard input: held-key set for movement, one-shot bindings for modes.
import type { MatchHost } from "./host";

/** One keyboard event: track held keys, then act on the one-shot bindings. */
export function handleKey(e: MatchHost, ev: KeyboardEvent, down: boolean) {
  // The pass charge reads the space key. `KeyboardEvent.key` is " " for a space
  // bar on most layouts but "Spacebar" on some older ones, so the physical
  // `code` is used when it is available: a missed space release also left
  // `chargingPass` stuck on and the charge meter pinned.
  const k = ev.code === "Space" ? " " : ev.key.toLowerCase();
  if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "tab"].includes(k === " " ? " " : k) || k === "tab") ev.preventDefault();
  if (down) e.keys.add(k); else e.keys.delete(k);
  if (!down) return;
  if (k === "c") e.cameraMode = e.cameraMode === "broadcast" ? "follow" : e.cameraMode === "follow" ? "free" : "broadcast";
  if (k === "x") e.switchToNearest(true);
  if (k === "v") e.spectator = !e.spectator;
  if (k === "t") e.aimRaw = !e.aimRaw;
  if (k === "g") e.showAIDebug = !e.showAIDebug;
  if (k === "h") e.showAnimOverlay = !e.showAnimOverlay;
  if (k === "r") e.resetPositions("kickoff");
}

/** Bind the window listeners (browser only; headless runs have no DOM). */
export function attachInput(e: MatchHost) {
  if (e.headless || typeof window === "undefined") return;
  window.addEventListener("keydown", e.kd);
  window.addEventListener("keyup", e.ku);
}

export function detachInput(e: MatchHost) {
  if (e.headless || typeof window === "undefined") return;
  window.removeEventListener("keydown", e.kd);
  window.removeEventListener("keyup", e.ku);
}
