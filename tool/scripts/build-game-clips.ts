// Writes the generated game animation pack.
//
//   cd tool
//   ../"game prototype"/node_modules/.bin/esbuild scripts/build-game-clips.ts \
//     --bundle --platform=node --format=cjs --outfile=/tmp/build-game-clips.cjs
//   node /tmp/build-game-clips.cjs ../"game prototype"/public/motions/game-motion-pack.json 30
//
// The studio's "Game pack" button produces the same document in the browser; this script
// is the reproducible/CI path so the game's bundled animations can be regenerated without
// a browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GAME_CLIP_SPECS, buildGameMotionPack } from "../src/gameclip";

const out = resolve(process.argv[2] ?? "../game prototype/public/motions/game-motion-pack.json");
const fps = Number(process.argv[3] ?? 30);
const pack = buildGameMotionPack(fps);
mkdirSync(dirname(out), { recursive: true });
const text = JSON.stringify(pack);
writeFileSync(out, text);

const slots = new Set(GAME_CLIP_SPECS.map((spec) => spec.slot));
const frames = pack.clips.reduce((sum, clip) => sum + clip.frames.length, 0);
const contact = pack.clips.filter((clip) => typeof clip.metadata.contactFrame === "number").length;
console.log(`wrote ${pack.clips.length} clips → ${out}`);
console.log(`  ${slots.size} game slots · ${frames} frames · ${contact} with a ball-contact frame · ${(text.length / 1024).toFixed(0)} KB at ${fps} fps`);
for (const clip of pack.clips) {
  const meta = clip.metadata as { slot: string; duration: number; contactFrame?: number; loop: boolean };
  console.log(`  ${clip.metadata.id as string}\t${meta.slot}\t${meta.duration}s\t${clip.frames.length} frames${meta.contactFrame === undefined ? "" : `\tcontact ${(meta.contactFrame * 100).toFixed(0)}%`}`);
}
