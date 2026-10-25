/**
 * Headless DOM stub for the scenario scripts.
 *
 * `MatchEngine` builds its three.js scene and its pitch canvas textures in the
 * constructor, even when `headless: true` skips the WebGL renderer. The suites therefore
 * need a tiny canvas/document/window shim before the engine module runs. This used to be
 * copy-pasted into every script with slightly different shapes (some omitted `window`,
 * some used a different proxy), so keep the one definition here.
 *
 * Import for its side effect, before anything that imports the engine:
 *
 *   import "./harness";              // or: import { installHeadlessDom } from "./harness";
 *   import { MatchEngine } from "../src/game/engine";
 */
const context2d = new Proxy({}, { get: () => () => ({}), set: () => true });

export const headlessCanvas = (width = 800, height = 500) => ({
  width, height,
  clientWidth: width, clientHeight: height,
  style: {},
  getContext: () => context2d,
});

/** Installs `document`, `window` and `devicePixelRatio` shims on `globalThis`. */
export function installHeadlessDom(): void {
  const g = globalThis as Record<string, unknown>;
  g.document = { createElement: () => headlessCanvas() };
  g.window = {
    location: { search: "" },
    addEventListener() {},
    removeEventListener() {},
  };
  g.devicePixelRatio = 1;
}

installHeadlessDom();

/** A canvas object that satisfies the type the engine expects. */
export const headlessEngineCanvas = () => headlessCanvas() as unknown as HTMLCanvasElement;
